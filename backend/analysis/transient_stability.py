"""Classical multi-machine transient stability (time-domain rotor angle).

First-pass "classical" model per Stevenson / Kundur ch. 13:

* Every synchronous machine is a voltage E′ behind its transient reactance X′d
  (utility sources are infinite buses — very large inertia, a fixed angle
  reference). E′ is constant (classical) unless an AVR regulates it, or — with
  the two-axis model — the d/q transient EMFs E′q/E′d flow-decay via T′do/T′qo
  while the AVR drives the field voltage E_fd (equal transient reactances
  X′q = X′d keep the machine a single voltage behind X′d). Rotor motion is the
  swing equation

      dδ/dt = Δω,     dΔω/dt = (ω_s / 2H)·(P_m − P_e − D·Δω/ω_s)

  integrated with RK4. P_m starts at the pre-fault electrical output and is then
  driven by a turbine-governor (below) so the frequency responds to and recovers
  from load changes; utility sources are infinite buses (no governor).
* Turbine-governor (per generator, mode ∈ {isochronous, droop, none}):

      dP_m/dt   = (P_m0 + P_sec − Δω/(ω_s·R) − P_m) / T_g      (droop + lag)
      dP_sec/dt = −Δω/(ω_s·R·T_r)   (isochronous reset; 0 for droop/none)

  The droop term is negative speed feedback — primary response that shares load
  between paralleled sets and damps the swing; the reset integrator removes the
  steady speed error so isochronous machines return to nominal frequency (droop
  settles at a small offset). P_m is capped at the machine rating (anti-windup).
  'none' freezes P_m at P_m0 (the historical constant-mechanical-power model).
* AVR/exciter (per generator, on/off): a first-order voltage regulator varies
  the field EMF E to hold the terminal voltage at its pre-fault value —

      dE/dt = (K_a·(V_ref − V_t) − (E − E_0)) / T_a,   E ∈ [E_min, E_max]

  V_t is the machine terminal-bus voltage recovered from the reduction; E is
  capped at the field ceiling with anti-windup. With the AVR off (or an infinite
  bus) E stays at E_0 — the classical constant-EMF model.
* Non-machine bus injections are frozen as constant shunt admittances at their
  pre-fault operating point, unless made dynamic: static loads take a voltage-
  dependent model (constant power / current / impedance / ZIP) and induction
  motors take a single-cage slip model (they slow and can stall on a voltage
  dip). When any dynamic device is present the network is re-reduced each step.
* The network is reduced (Kron) to the machine internal nodes, so

      P_ei = Σ_j |E_i||E_j| (G_ij cos δ_ij + B_ij sin δ_ij),   δ_ij = δ_i − δ_j

  with Y_red = G + jB the reduced admittance between internal nodes. The
  reduction is rebuilt for each network state (pre-fault, fault-on with the
  faulted bus grounded, and post-fault with a tripped branch / generator /
  stepped load).

* Inverter-based resources (solar PV / BESS / full-converter wind) are frozen
  as constant admittances unless made dynamic per source via ``ibr_ctrl``:
    - **grid_forming (GFM)** — a virtual synchronous machine: a voltage E behind
      the converter coupling reactance whose internal angle obeys the SAME swing
      equation, driven by a synthetic inertia H_v and a P-f droop that maps onto
      the swing damping (so a GFM shares load and provides fast frequency
      response, and can hold an island with no rotating machine). Voltage is
      regulated like an AVR. Converter current is bounded by a VIRTUAL IMPEDANCE
      that grows once the terminal current exceeds the limit — the defining
      difference from a synchronous machine, which has no such limit. The GFM
      node is added to the machine list and reuses the reduction / RK4 / island
      machinery unchanged.
    - **grid_following (GFL)** — a current source synchronised to the grid: a
      voltage-dependent bus injection folded into the dynamic-shunt path. It
      holds its dispatched P (with a fast-frequency-response P-f droop on the
      island frequency) and Q (with reactive-current voltage support during a
      dip), the total current hard-limited at I_max with REACTIVE PRIORITY (grid
      codes require dynamic voltage support first, active current fills the
      remaining headroom). Rides through / trips on sustained under-voltage or
      off-nominal frequency.
  ``ibr_ctrl = frozen`` (the default) keeps the constant-admittance model, so
  results are byte-identical to a network with no IBR dynamics.

Disturbances: a bolted three-phase bus fault cleared after a set time (optional
branch trip on clearing, and a binary-search critical clearing time); a
generator or branch trip; and a load step. Initial conditions come from the
positive-sequence load flow.

Stability verdict: two independent failure modes. (1) Rotor-angle loss of
synchronism — a machine's angle exceeds 180° from its island's centre of
inertia. (2) Frequency collapse / run-away — an island's COI frequency ends
well off nominal and is not recovering (overload with the governors saturated,
or a governor-less imbalance); the machines can stay in step with each other
while drifting off nominal frequency together, so this is checked separately.
The reported ``instability`` names whichever occurred; the CCT search uses the
rotor-angle test alone (a first-swing metric).

Sub-transient (d/q″) machine dynamics are a documented follow-up — this engine
is the framework they extend.
"""

import math
import numpy as np

from .network_reduction import build_branch_ybus, _source_stub, _source_internal_z
from .loadflow import run_load_flow, _source_output_mva

INFINITE_H = 1.0e6          # utility infinite-bus inertia (angle ~frozen)
BUS_REG = 1.0e-8            # tiny shunt to keep the elimination matrix regular
UNSTABLE_ANGLE = math.pi    # |δ − δ_COI| beyond 180° ⇒ loss of synchronism
CCT_SEARCH_MAX = 1.0        # s — upper bound for the critical-clearing search
MAX_RECORD_POINTS = 400
GFM_CLIM_ITERS = 8          # in-step iterations to converge the GFM current limit
# Frequency-stability verdict: an island whose centre-of-inertia frequency ends
# more than FREQ_UNSTABLE_BAND (Hz) off nominal AND is not recovering (its end
# deviation is no smaller than its late-window deviation, within FREQ_RECOVER_TOL)
# has collapsed / run away — a real instability the rotor-angle synchronism test
# does not catch (the machines can fall out of step with the grid together while
# staying in step with each other).
FREQ_UNSTABLE_BAND = 2.5
FREQ_RECOVER_TOL = 0.1

MACHINE_SOURCE_TYPES = ("generator", "utility")
IBR_SOURCE_TYPES = ("solar_pv", "battery", "wind_turbine")


def _ibr_ctrl(comp):
    """Converter control mode for an inverter-based source, or None if the
    component is not an IBR / left frozen.

    ``ibr_ctrl`` ∈ {frozen, grid_following, grid_forming}. Only a full-converter
    (type-4) wind turbine is treated as a converter; type 1/2/3 machines keep
    their (partial-)rotating-machine behaviour and stay frozen here. Default is
    frozen so a project with no IBR dynamics is byte-identical to before.
    """
    if comp.type not in IBR_SOURCE_TYPES:
        return None
    if comp.type == "wind_turbine" and \
            str(comp.props.get("turbine_type", "type3_dfig")) != "type4_frc":
        return None
    mode = str(comp.props.get("ibr_ctrl", "frozen") or "frozen").lower()
    if mode in ("gfm", "grid_forming"):
        return "gfm"
    if mode in ("gfl", "grid_following"):
        return "gfl"
    return None


def _ibr_rated_mva(comp):
    """Converter apparent-power rating (MVA, whole plant) — the current-limit and
    droop base. Reuses the load-flow source sizing (num inverters / turbines)."""
    return max(float(_source_output_mva(comp)[3]), 1e-9)


def _bus_islands(Y):
    """Connected-component id per bus index from the branch Ybus sparsity.
    Two buses share an island iff a branch/solid-link couples them (Y[i,j] ≠ 0);
    an open breaker leaves no edge, so it separates islands. Returns {bus_idx:
    island_id}."""
    n = Y.shape[0]
    comp, seen, cid = {}, set(), 0
    for s in range(n):
        if s in seen:
            continue
        stack = [s]
        seen.add(s)
        while stack:
            u = stack.pop()
            comp[u] = cid
            for v in range(n):
                if v != u and v not in seen and abs(Y[u, v]) > 0:
                    seen.add(v)
                    stack.append(v)
        cid += 1
    return comp


def _machine_island_of(Y, machines):
    """Island id for each machine (by its terminal bus). Machines in different
    islands are not synchronously coupled and must be judged against separate
    centres of inertia."""
    comp = _bus_islands(Y)
    return [comp.get(m["bus_idx"], -1) for m in machines]


# ── Initial conditions from the load flow ───────────────────────────────

def _bus_complex_voltages(lf, bus_ids):
    """{bus_id: complex V p.u.} from a load-flow result (magnitude ∠ angle)."""
    out = {}
    for bid in bus_ids:
        b = lf.buses.get(bid)
        if b is None:
            continue
        out[bid] = b.voltage_pu * complex(math.cos(math.radians(b.angle_deg)),
                                          math.sin(math.radians(b.angle_deg)))
    return out


def _machine_reactance(comp, base_mva, z_stub):
    """Internal-node → bus impedance (p.u. system base): X′d (or the utility
    Thevenin impedance) plus any step-up transformer/cable stub, and the inertia
    constant H (s, system base) with the infinite-bus flag."""
    if comp.type == "utility":
        z = _source_internal_z(comp, base_mva, 1.0) + z_stub
        return z, INFINITE_H, True
    if _ibr_ctrl(comp) == "gfm":
        # Grid-forming converter: a voltage behind the PHYSICAL coupling
        # (filter + step-up) reactance — not the large fault-current-limit
        # impedance used for short circuit. Fault current is bounded instead by
        # the virtual-impedance current limiter (see _simulate). Inertia is the
        # synthetic/virtual inertia the control emulates.
        rated = _ibr_rated_mva(comp)
        xf = max(float(comp.props.get("ibr_xf_pu", 0.15) or 0.15), 1e-3)
        z = complex(0.0, xf * base_mva / rated) + z_stub
        h_v = max(float(comp.props.get("ibr_inertia_h_s", 3.0) or 3.0), 0.1)
        return z, h_v * rated / base_mva, False
    rated = float(comp.props.get("rated_mva", 10) or 10)
    xdp = float(comp.props.get("xd_p", 0.25) or 0.25)
    z = complex(0.0, xdp * base_mva / rated) + z_stub
    h_machine = float(comp.props.get("inertia_h_s", 4) or 4)
    h_sys = h_machine * rated / base_mva      # H scales with the machine rating
    return z, h_sys, False


def _collect_machines(project, ctx, lf):
    """Build the machine list with pre-fault internal EMFs.

    Returns (machines, warnings). Each machine dict carries: comp_id, name,
    bus_id, bus_idx, z (internal→bus), E (|E′| const), delta0, Pm, H, D,
    infinite.
    """
    base_mva = ctx["base_mva"]
    bus_idx = ctx["bus_idx"]
    components, adjacency, bus_of = ctx["components"], ctx["adjacency"], ctx["bus_of"]
    Vc = _bus_complex_voltages(lf, list(bus_idx.keys()))

    # Synchronous machines (generator / utility) plus any grid-forming IBR,
    # which is modelled as a virtual synchronous machine on the same footing.
    sources = [c for c in project.components
               if c.type in MACHINE_SOURCE_TYPES or _ibr_ctrl(c) == "gfm"]
    # Which machines land on each bus (to split a shared bus injection).
    on_bus = {}
    staged = []
    for comp in sources:
        stub = _source_stub(comp.id, adjacency, components, bus_of, base_mva)
        if stub is None:
            continue
        bus_id, z_stub = stub
        if bus_id not in bus_idx or bus_id not in Vc:
            continue
        z, h_sys, infinite = _machine_reactance(comp, base_mva, z_stub)
        staged.append((comp, bus_id, z, h_sys, infinite))
        on_bus[bus_id] = on_bus.get(bus_id, 0) + 1

    machines, warnings = [], []
    for comp, bus_id, z, h_sys, infinite in staged:
        V = Vc[bus_id]
        b = lf.buses.get(bus_id)
        # Gross machine output at the bus (net injection, split if the bus
        # carries more than one machine). Classical lossless-reactance model:
        # P_m = pre-fault electrical output.
        s_net = complex(b.p_mw, b.q_mvar) / base_mva / on_bus[bus_id]
        if abs(V) < 1e-6:
            continue
        I = np.conj(s_net) / np.conj(V)
        E_internal = V + z * I
        is_gfm = _ibr_ctrl(comp) == "gfm"
        # Turbine-governor: mechanical power is a dynamic state driven by speed
        # so frequency recovers after a load change (see _simulate). Infinite
        # buses have no governor (angle frozen). Mode ∈ {isochronous, droop,
        # none}; default isochronous so a genset island returns to nominal. A
        # grid-forming converter has no turbine — its P-f droop is folded into
        # the swing damping (below) — and always regulates its terminal voltage.
        if infinite:
            gmode, rated, avr_on = "none", 1e9, False
        elif is_gfm:
            gmode, rated, avr_on = "none", _ibr_rated_mva(comp), True
        else:
            gmode = str(comp.props.get("gov_mode", "isochronous") or "isochronous").lower()
            if gmode not in ("isochronous", "droop", "none"):
                gmode = "isochronous"
            rated = float(comp.props.get("rated_mva", 10) or 10)
            avr_on = str(comp.props.get("avr_mode", "on") or "on").lower() != "off"
        E0 = abs(E_internal)
        # Two-axis (flux-decay) model, opt-in per generator. Equal transient
        # reactances X'q = X'd keep the machine a single voltage behind X'd (so
        # the network reduction is unchanged), while E'q/E'd decay via T'do/T'qo
        # and the AVR drives the field voltage E_fd. δ0 uses the SYNCHRONOUS
        # q-axis reactance (the classical rotor-angle construction).
        mm = "classical"
        two = {"two_axis": False, "epq0": 0.0, "epd0": 0.0, "efd_ref": E0,
               "dXd": 0.0, "dXq": 0.0, "tdop": 6.0, "tqop": 1.0}
        delta0_val = math.atan2(E_internal.imag, E_internal.real)
        E_disp = E0
        if not infinite and not is_gfm:
            mm = str(comp.props.get("machine_model", "classical") or "classical").lower()
            if mm not in ("classical", "two_axis"):
                mm = "classical"
        if mm == "two_axis" and abs(V) > 1e-9:
            xdp = float(comp.props.get("xd_p", 0.25) or 0.25)
            xd_s = float(comp.props.get("xd", 2.0) or 2.0)
            xq_s = float(comp.props.get("xq", 1.8) or 1.8)
            tdop = max(float(comp.props.get("tdo_p", 6.0) or 6.0), 0.05)
            tqop = max(float(comp.props.get("tqo_p", 1.0) or 1.0), 0.05)
            Xp = z.imag                              # transient reactance (+ stub)
            dXd = (xd_s - xdp) * base_mva / rated     # Xd − X'd (stub cancels)
            dXq = (xq_s - xdp) * base_mva / rated     # Xq − X'd  (X'q = X'd)
            Eq = V + complex(0.0, Xp + dXq) * I       # rotor-angle by q-axis
            d0 = math.atan2(Eq.imag, Eq.real)
            rot = complex(math.cos(math.pi / 2 - d0), math.sin(math.pi / 2 - d0))
            Vdq = V * rot
            Idq = I * rot
            epq0 = Vdq.imag + Xp * Idq.real          # E'q = Vq + X'd·Id
            epd0 = Vdq.real - Xp * Idq.imag          # E'd = Vd − X'q·Iq
            efd0 = epq0 + dXd * Idq.real             # steady field voltage
            two = {"two_axis": True, "epq0": epq0, "epd0": epd0, "efd_ref": efd0,
                   "dXd": dXd, "dXq": dXq, "tdop": tdop, "tqop": tqop}
            delta0_val = d0
            E_disp = abs(complex(epd0, epq0))
        pmax_pu = 1e9 if infinite else rated / base_mva
        # Damping D: the swing damping coefficient. For a grid-forming converter
        # the P-f droop IS the damping — at steady state Δf_pu = (Pm−Pe)/D, and
        # a droop m_p (p.u. freq per p.u. power on the converter rating) gives
        # Δf_pu = −m_p·(Pe−Pm)_machine, so D = rating/base ÷ m_p = pmax_pu/m_p.
        # This is what makes a GFM share load and give fast frequency response.
        d_coef = float(comp.props.get("damping_pu", 0) or 0)
        if is_gfm:
            mp = max(float(comp.props.get("ibr_pf_droop_pct", 5) or 5) / 100.0, 1e-3)
            d_coef += pmax_pu / mp
        machines.append({
            "comp_id": comp.id, "name": comp.props.get("name", comp.id),
            "bus_id": bus_id, "bus_idx": bus_idx[bus_id], "z": z,
            "E": E_disp, "delta0": delta0_val,
            "Pm": s_net.real, "H": h_sys, "D": d_coef,
            "infinite": infinite,
            # Grid-forming-converter markers: the control mode, the current limit
            # (system p.u.) enforced via a virtual impedance, the coupling
            # reactance the virtual impedance adds to, and its gain. ``ibr`` is
            # None for a real synchronous machine. ``freq_response`` marks a
            # machine that regulates island frequency (governed set or GFM droop)
            # so an islanded group is not warned as drifting.
            "ibr": ("gfm" if is_gfm else None),
            "imax": (max(float(comp.props.get("ibr_imax_pu", 1.2) or 1.2), 0.1) * pmax_pu
                     if is_gfm else 0.0),
            "xbase": (z.imag if is_gfm else 0.0),
            "clim_gain": max(float(comp.props.get("ibr_clim_gain", 3.0) or 3.0), 0.1),
            "freq_response": (gmode != "none") or is_gfm,
            "gov_mode": gmode,
            "gov_R": max(float(comp.props.get("gov_droop_pct", 4) or 4) / 100.0, 1e-3),
            "gov_Tg": max(float(comp.props.get("gov_time_const_s", 0.5) or 0.5), 1e-3),
            "gov_Tr": max(float(comp.props.get("gov_reset_time_s", 5.0) or 5.0), 1e-3),
            "pmax": pmax_pu,
            "pmin": 0.0,
            # AVR/exciter: regulate terminal voltage back to its pre-fault value
            # by varying the field EMF. Vref is the pre-fault terminal voltage.
            "avr_on": avr_on,
            "avr_Ka": max(float(comp.props.get("avr_gain", 25) or 25), 0.0),
            "avr_Ta": max(float(comp.props.get("avr_time_const_s", 0.2) or 0.2), 1e-3),
            "vref": abs(V),
            # Field state reference (|E'| for classical, E_fd for two-axis) and
            # its ceiling — the AVR drives the field toward this and is capped.
            "efd_ref": two["efd_ref"],
            "emax": 2.5 * two["efd_ref"],
            "emin": 0.0,
            # Two-axis flux-decay parameters (unused when classical).
            "two_axis": two["two_axis"], "epq0": two["epq0"], "epd0": two["epd0"],
            "dXd": two["dXd"], "dXq": two["dXq"],
            "tdop": two["tdop"], "tqop": two["tqop"],
            # Protection (0 / disabled by default): over- and under-frequency and
            # under-voltage trips, each after a common delay. A GFM converter
            # rides through / trips on its own ibr_* ride-through settings.
            "trip_of_hz": float(comp.props.get("ibr_of_hz" if is_gfm else "trip_of_hz", 0) or 0),
            "trip_uf_hz": float(comp.props.get("ibr_uf_hz" if is_gfm else "trip_uf_hz", 0) or 0),
            "trip_uv_pu": float(comp.props.get("ibr_uv_pu" if is_gfm else "trip_uv_pu", 0) or 0),
            "trip_delay_s": max(float(comp.props.get(
                "ibr_trip_delay_s" if is_gfm else "trip_delay_s", 0.2) or 0.2), 0.0),
        })
    return machines, warnings


def _load_shunts(lf, ctx, machine_bus_idxs):
    """Constant-admittance vector (system p.u.) for every non-machine bus, from
    its pre-fault net injection: y = conj(S_load)/|V|², S_load = −S_net."""
    bus_idx = ctx["bus_idx"]
    base = ctx["base_mva"]
    n = len(bus_idx)
    y = np.zeros(n, dtype=complex)
    for bid, i in bus_idx.items():
        if i in machine_bus_idxs:
            continue  # machine buses inject through their internal node
        b = lf.buses.get(bid)
        if b is None or not b.energized:
            continue
        V = b.voltage_pu
        if V < 1e-6:
            continue
        s_net = complex(b.p_mw, b.q_mvar) / base   # net injection (load ⇒ neg)
        y[i] = np.conj(-s_net) / (V * V)
    return y


# ── Dynamic load & motor models ─────────────────────────────────────────
# Static loads default to constant impedance (the classical model). A voltage-
# dependent model (constant current / constant power / ZIP mix) keeps the same
# pre-fault draw but changes how the current tracks voltage during the transient
# — constant-power loads in particular resist voltage recovery and are the more
# onerous, realistic assumption. Induction motors, frozen as constant shunts in
# the classical model, are given a single-cage slip model (reusing the motor-
# starting engine) so they slow, draw more current and can stall on a voltage
# dip. Both are folded back into the network reduction each step.

from .dynamic_motor_starting import (  # noqa: E402  (kept local to this feature)
    _fit_motor_model, _estimate_motor_h, _load_torque_fn, _rated_slip)

_LOAD_ZIP = {
    "constant_impedance": (1.0, 0.0, 0.0),
    "constant_current":   (0.0, 1.0, 0.0),
    "constant_power":     (0.0, 0.0, 1.0),
}


def _zip_of(props):
    """(z, i, p) fractions for a static load. Reads the existing ``load_type``
    field (constant_power / constant_current / constant_impedance / zip); an
    explicit ZIP percentage set overrides. Defaults to constant impedance (the
    classical behaviour) when unset."""
    model = str(props.get("load_type", props.get("load_model", "constant_impedance")) or "").lower()
    if model == "zip":
        z = float(props.get("zip_z_pct", 100) or 0) / 100.0
        i = float(props.get("zip_i_pct", 0) or 0) / 100.0
        p = float(props.get("zip_p_pct", 0) or 0) / 100.0
        tot = z + i + p
        return (z / tot, i / tot, p / tot) if tot > 1e-9 else (1.0, 0.0, 0.0)
    return _LOAD_ZIP.get(model, (1.0, 0.0, 0.0))


def _solve_motor_slip(model, load_fn, v):
    """Equilibrium slip where air-gap torque meets load torque at voltage v, on
    the stable (below-breakdown) branch."""
    sbd, tbd = 0.05, -1.0
    for k in range(1, 201):
        s = k / 200.0
        t = model.torque(v, s)
        if t > tbd:
            tbd, sbd = t, s
    a, b = 1e-4, sbd
    f = lambda s: model.torque(v, s) - load_fn(1.0 - s)
    if f(a) > 0:
        return a
    for _ in range(60):
        mid = 0.5 * (a + b)
        if f(a) * f(mid) <= 0:
            b = mid
        else:
            a = mid
    return 0.5 * (a + b)


def _build_ts_motor(comp, project, ctx, lf, freq, base, warnings):
    """Single-cage dynamic model for one induction motor, or None to leave it as
    a constant-admittance load (missing ratings, or an unfittable nameplate)."""
    mp = comp.props
    name = mp.get("name", comp.id)
    voltage_kv = float(mp.get("voltage_kv", 0) or 0)
    rated_kw = float(mp.get("rated_kw", 0) or 0)
    eff = float(mp.get("efficiency", 0.93) or 0.93)
    pf = float(mp.get("power_factor", 0.85) or 0.85)
    if rated_kw <= 0 or voltage_kv <= 0 or eff <= 0 or pf <= 0:
        return None
    bi = _component_bus_idx(project, ctx, comp.id)
    if bi is None:
        return None
    idx_to_bus = {i: b for b, i in ctx["bus_idx"].items()}
    b = lf.buses.get(idx_to_bus[bi])
    if b is None or not b.energized or b.voltage_pu < 1e-6:
        return None
    V0 = b.voltage_pu
    s_base_mva = rated_kw / (eff * pf) / 1000.0
    m_i = float(mp.get("locked_rotor_current", 6.0) or 6.0)
    rpm = float(mp.get("rated_speed_rpm", 0) or 0)
    if rpm <= 0:
        rpm = round(60.0 * freq / 2.0 * 0.9867)
    s_rated = _rated_slip(rpm, freq)
    pole_pairs = max(1, round(60.0 * freq / rpm))
    ns = 60.0 * freq / pole_pairs
    omega_sync = 2.0 * math.pi * ns / 60.0
    t_fl_pu = (eff * pf) / (1.0 - s_rated)
    lrt_pct = float(mp.get("locked_rotor_torque_pct", 150) or 150)
    t_lr_pu = lrt_pct / 100.0 * t_fl_pu
    j_motor = float(mp.get("motor_j_kgm2", 0) or 0)
    j_load = float(mp.get("load_j_kgm2", 0) or 0)
    if j_motor <= 0:
        j_motor = 2.0 * _estimate_motor_h(rated_kw) * s_base_mva * 1e6 / (omega_sync ** 2)
    h_s = 0.5 * (j_motor + j_load) * omega_sync ** 2 / (s_base_mva * 1e6)
    try:
        model = _fit_motor_model(m_i, t_lr_pu, t_fl_pu, s_rated, h_s, warnings, name)
    except ValueError as e:
        warnings.append(f"Motor '{name}': {e} — modelled as a constant impedance.")
        return None
    load_pct = float(mp.get("load_torque_pct", 90) or 90)
    breakaway = float(mp.get("load_breakaway_pct", 10) or 10) / 100.0
    load_fn = _load_torque_fn(str(mp.get("load_torque_model", "quadratic")),
                              load_pct / 100.0 * t_fl_pu, breakaway, 1.0 - s_rated)
    # Constant-Z admittance the load flow used for this motor, to remove from the
    # base shunt before adding the dynamic one (no double counting).
    df = float(mp.get("demand_factor", 1.0) or 1.0)
    rated_mva = rated_kw / (eff * pf * 1000.0)
    q = math.sqrt(max(0.0, 1.0 - pf * pf))
    slf = complex(rated_mva * pf * df, rated_mva * q * df) / base
    return {
        "bus": bi, "model": model, "load_fn": load_fn, "h_s": h_s,
        "ratio": s_base_mva / base, "yrem": np.conj(slf) / (V0 * V0),
        "s0": _solve_motor_slip(model, load_fn, V0), "name": name,
    }


def _build_gfl(comp, project, ctx, lf, disp_map, base, bus_island, warnings):
    """Grid-following-converter model for one IBR, or None to leave it frozen.

    A GFL holds its dispatched real power (with an optional fast-frequency-
    response droop) and reactive power (with grid-code voltage support), the
    total current hard-limited at I_max with reactive priority. It is a bus
    injection, NOT a swing node — folded into the dynamic-shunt path.
    """
    bi = _component_bus_idx(project, ctx, comp.id)
    if bi is None:
        return None
    idx_to_bus = {i: b for b, i in ctx["bus_idx"].items()}
    b = lf.buses.get(idx_to_bus[bi])
    if b is None or not b.energized or b.voltage_pu < 1e-6:
        return None
    V0 = b.voltage_pu
    rating = _ibr_rated_mva(comp)                    # MVA
    p_av, q_av, _s, _r = _source_output_mva(comp)    # nameplate/available MVA
    # Pre-fault injection: the real power the load flow actually dispatched (so a
    # curtailed source is pulled out at its curtailed value), holding the source
    # power factor for the reactive part. Removing exactly this from the frozen
    # base shunt and re-injecting it at t=0 keeps the pre-fault equilibrium.
    p0 = disp_map.get(comp.id, p_av)                 # MW (signed; −ve = charging)
    q0 = p0 * (q_av / p_av) if p_av > 1e-9 else 0.0  # Mvar (hold pf)
    s0_sys = complex(p0, q0) / base                  # system p.u.
    ratio = rating / base
    bidir = comp.type == "battery"                   # a BESS can absorb (charge)
    headroom = max(float(comp.props.get("ibr_p_headroom_pct", 0) or 0) / 100.0, 0.0)
    p_ref_m = (s0_sys.real / ratio) if ratio > 1e-12 else 0.0
    return {
        "bus": bi, "name": comp.props.get("name", comp.id),
        "island": bus_island.get(bi, -1), "V0": V0, "v_ref": V0,
        "ratio": ratio, "s0_sys": s0_sys,
        "ybase": np.conj(-s0_sys) / (V0 * V0),       # frozen const-Z to remove
        "p_ref_m": p_ref_m, "q_ref_m": (s0_sys.imag / ratio) if ratio > 1e-12 else 0.0,
        "p_min_m": (-1.0 if bidir else 0.0),
        "p_max_m": (1.0 if bidir else max(p_ref_m * (1.0 + headroom), 0.0)),
        "imax_m": max(float(comp.props.get("ibr_imax_pu", 1.2) or 1.2), 0.1),
        "ffr_R": max(float(comp.props.get("ibr_ffr_droop_pct", 0) or 0) / 100.0, 0.0),
        "qv_gain": max(float(comp.props.get("ibr_qv_gain", 2.0) or 0), 0.0),
        # ride-through / trip
        "uv_pu": float(comp.props.get("ibr_uv_pu", 0) or 0),
        "of_hz": float(comp.props.get("ibr_of_hz", 0) or 0),
        "uf_hz": float(comp.props.get("ibr_uf_hz", 0) or 0),
        "trip_delay": max(float(comp.props.get("ibr_trip_delay_s", 0.2) or 0.2), 0.0),
    }


def _gfl_injection(g, v, f, freq):
    """Complex power a grid-following converter injects this step (system p.u.),
    given its lagged terminal-voltage magnitude v (p.u.) and its island's
    frequency f (Hz, or None). Worked in converter-base p.u., then scaled to the
    system base by ``ratio``.

    Fast frequency response trims active power on an island-frequency droop;
    reactive current supports voltage during a dip past a 0.1 p.u. deadband
    (grid-code dynamic voltage support). The current is hard-limited at I_max
    with REACTIVE PRIORITY — reactive current is served first and active current
    fills the remaining headroom, so P is curtailed on a deep dip."""
    v = max(v, 1e-3)
    p_cmd = g["p_ref_m"]
    if g["ffr_R"] > 0 and f is not None:
        p_cmd -= ((f - freq) / freq) / g["ffr_R"]      # f below nominal ⇒ raise P
    p_cmd = min(max(p_cmd, g["p_min_m"]), g["p_max_m"])
    iq = g["q_ref_m"] / v                              # reactive current for q_ref
    dv = g["v_ref"] - v
    if g["qv_gain"] > 0 and abs(dv) > 0.1:
        iq += g["qv_gain"] * (dv - math.copysign(0.1, dv))
    imax = g["imax_m"]
    iq = min(max(iq, -imax), imax)                     # reactive priority
    ip_avail = math.sqrt(max(0.0, imax * imax - iq * iq))
    ip = min(max(p_cmd / v, -ip_avail), ip_avail)
    return complex(v * ip, v * iq) * g["ratio"]        # → system p.u.


def _dynamic_setup(project, ctx, lf, freq, warnings):
    """Collect voltage-dependent loads, dynamic induction motors and grid-
    following IBR injections. Returns None when everything is constant impedance,
    no motor is dynamic and no IBR is grid-following (⇒ the fast constant-shunt
    path is used and results are unchanged)."""
    base = ctx["base_mva"]
    bus_idx = ctx["bus_idx"]
    idx_to_bus = {i: b for b, i in bus_idx.items()}
    bus_island = _bus_islands(ctx["Y"])   # bus_idx -> electrical-island id
    disp_map = {e.source_id: e.dispatched_mw for e in getattr(lf, "dispatch", [])}
    loads, motors, ibrs = [], [], []
    n_gen_prot = 0
    for comp in project.components:
        if comp.type == "static_load":
            z, i, p = _zip_of(comp.props)
            shed_hz = float(comp.props.get("uf_shed_hz", 0) or 0)     # UFLS threshold
            uv_pu = float(comp.props.get("uv_trip_pu", 0) or 0)       # under-voltage
            trippable = shed_hz > 0 or uv_pu > 0
            if abs(i) + abs(p) < 1e-9 and not trippable:
                continue  # firm constant impedance — leave in the fast base shunt
            bi = _component_bus_idx(project, ctx, comp.id)
            if bi is None:
                continue
            b = lf.buses.get(idx_to_bus[bi])
            if b is None or not b.energized or b.voltage_pu < 1e-6:
                continue
            V0 = b.voltage_pu
            rated = float(comp.props.get("rated_kva", 100) or 0) / 1000.0
            pf = float(comp.props.get("power_factor", 0.85) or 0.85)
            df = float(comp.props.get("demand_factor", 1.0) or 1.0)
            q = math.sqrt(max(0.0, 1.0 - pf * pf))
            s = complex(rated * pf * df, rated * q * df) / base
            loads.append({
                "bus": bi, "ybase": np.conj(s) / (V0 * V0), "z": z, "i": i, "p": p,
                "V0": V0, "island": bus_island.get(bi, -1),
                "name": comp.props.get("name", comp.id),
                "shed_hz": shed_hz,
                "shed_delay": max(float(comp.props.get("uf_shed_delay_s", 0.2) or 0.2), 0.0),
                "uv_pu": uv_pu,
                "uv_delay": max(float(comp.props.get("uv_trip_delay_s", 0.2) or 0.2), 0.0),
            })
        elif comp.type == "motor_induction":
            if str(comp.props.get("ts_dynamic", "on") or "on").lower() == "off":
                continue
            mo = _build_ts_motor(comp, project, ctx, lf, freq, base, warnings)
            if mo:
                mo["uv_pu"] = float(comp.props.get("uv_trip_pu", 0) or 0)
                mo["uv_delay"] = max(float(comp.props.get("uv_trip_delay_s", 0.2) or 0.2), 0.0)
                motors.append(mo)
        elif _ibr_ctrl(comp) == "gfl":
            g = _build_gfl(comp, project, ctx, lf, disp_map, base, bus_island, warnings)
            if g:
                ibrs.append(g)
    # A grid-forming converter is a machine, but its current limiter lives in the
    # per-step re-reduction — so its presence must switch the network off the fast
    # constant-reduction path (dyn non-None) even with no other dynamic device.
    gfm_comps = [c for c in project.components if _ibr_ctrl(c) == "gfm"]
    has_gfm = bool(gfm_comps)
    gfm_prot = any(any(float(c.props.get(k, 0) or 0) > 0
                       for k in ("ibr_of_hz", "ibr_uf_hz", "ibr_uv_pu")) for c in gfm_comps)
    for comp in project.components:
        if comp.type == "generator" and any(float(comp.props.get(k, 0) or 0) > 0
                                            for k in ("trip_of_hz", "trip_uf_hz", "trip_uv_pu")):
            n_gen_prot += 1
    has_protection = (n_gen_prot > 0 or gfm_prot
                      or any(d["shed_hz"] > 0 or d["uv_pu"] > 0 for d in loads)
                      or any(mo.get("uv_pu", 0) > 0 for mo in motors)
                      or any(g["uv_pu"] > 0 or g["of_hz"] > 0 or g["uf_hz"] > 0 for g in ibrs))
    if not loads and not motors and not ibrs and not has_protection and not has_gfm:
        return None
    if motors:
        warnings.append(
            f"{len(motors)} induction motor(s) modelled dynamically (single-cage "
            "slip) — a deep voltage dip can slow or stall them; set a motor's "
            "Transient-stability model to 'static' to freeze it as a constant load.")
    if ibrs:
        warnings.append(
            f"{len(ibrs)} grid-following inverter(s) modelled as current-limited "
            "converters — they hold dispatched power, support voltage on a dip and "
            "clip at their current limit (fundamentally unlike a synchronous "
            "machine's fault contribution).")
    return {"loads": loads, "motors": motors, "ibrs": ibrs, "base": base,
            "has_protection": has_protection}


def _dyn_shunt(dyn, y0, vbus_mag, slips, load_scale=None,
               tripped_loads=None, tripped_motors=None,
               ibr_inj=None, tripped_ibr=None):
    """Bus shunt vector for the current step: the base constant-Z shunt with the
    voltage-dependent loads, motor-slip and grid-following-converter injections
    swapped in. Tripped loads, motors and converters are removed entirely.

    ibr_inj: {gfl_index: S_sys} the converter injection for this step, precomputed
    from the lagged voltage and island frequency (falls back to the pre-fault
    injection). Each GFL's frozen const-Z is always removed from ``y0``."""
    tripped_loads = tripped_loads or set()
    tripped_motors = tripped_motors or set()
    tripped_ibr = tripped_ibr or set()
    ibr_inj = ibr_inj or {}
    y = y0.copy()
    for j, d in enumerate(dyn["loads"]):
        bi = d["bus"]
        if j in tripped_loads:
            y[bi] -= d["ybase"]           # shed: remove its const-Z (in y0)
            continue
        V = max(vbus_mag.get(bi, d["V0"]), 1e-3)
        r = d["V0"] / V
        scale = d["z"] + d["i"] * r + d["p"] * r * r
        y[bi] += d["ybase"] * (scale - 1.0)   # remove const-Z (in y0), add ZIP form
    for k, mo in enumerate(dyn["motors"]):
        bi = mo["bus"]
        if k in tripped_motors:
            y[bi] -= mo["yrem"]           # tripped: remove its const-Z (in y0)
            continue
        s = min(max(slips[k], 1e-4), 1.0)
        y[bi] += mo["model"].y_in(s) * mo["ratio"] - mo["yrem"]
    for j, g in enumerate(dyn.get("ibrs", [])):
        bi = g["bus"]
        y[bi] -= g["ybase"]               # remove the frozen const-Z (in y0)
        if j in tripped_ibr:
            continue                      # tripped: inject nothing
        S = ibr_inj.get(j, g["s0_sys"])
        V = max(vbus_mag.get(bi, g["V0"]), 1e-3)
        y[bi] += np.conj(-S) / (V * V)    # generation ⇒ negative conductance
    if load_scale is not None:
        lbus, frac = load_scale
        y[lbus] = y[lbus] * frac
    return y


# ── Network reduction to the machine internal nodes ─────────────────────

def _reduce(Ybus, load_shunt, machines, active, grounded, z_override=None):
    """Kron-reduce to the internal nodes of the ``active`` machines.

    grounded: set of bus indices held at zero volts (a bolted 3-φ fault).
    z_override: optional {machine_idx: z} replacing a machine's internal→bus
    impedance for this step (the grid-forming current limiter raises a
    converter's coupling reactance when its terminal current exceeds the limit).
    Returns (Y_red [k×k over active], R [n_keptbus×k voltage-recovery],
    kept_bus_indices).
    """
    z_override = z_override or {}
    n = Ybus.shape[0]
    keep_bus = [i for i in range(n) if i not in grounded]
    nb = len(keep_bus)
    pos = {bi: k for k, bi in enumerate(keep_bus)}
    m = len(active)
    A = np.zeros((nb + m, nb + m), dtype=complex)

    for a, bi in enumerate(keep_bus):
        A[a, a] += load_shunt[bi] + BUS_REG
        for c, bj in enumerate(keep_bus):
            A[a, c] += Ybus[bi, bj]

    for k, mi in enumerate(active):
        mac = machines[mi]
        yk = 1.0 / z_override.get(mi, mac["z"])
        bi = mac["bus_idx"]
        A[nb + k, nb + k] += yk
        if bi in grounded:
            continue  # terminal shorted to ground; internal node sees yk to gnd
        a = pos[bi]
        A[a, a] += yk
        A[a, nb + k] -= yk
        A[nb + k, a] -= yk

    Yee = A[:nb, :nb]
    Yek = A[:nb, nb:]
    Yke = A[nb:, :nb]
    Ykk = A[nb:, nb:]
    Yee_inv = np.linalg.inv(Yee)
    Yred = Ykk - Yke @ Yee_inv @ Yek
    R = -Yee_inv @ Yek
    return Yred, R, keep_bus


def _p_electrical(Yred, active, machines, delta, emag=None):
    """Electrical power (system p.u.) for each active machine given rotor
    angles; returned indexed by the active-machine position. ``emag`` (a full
    per-machine EMF vector) overrides the constant machine EMFs when the AVR is
    varying the field."""
    m = len(active)
    P = np.zeros(m)
    if emag is None:
        E = np.array([machines[mi]["E"] for mi in active])
    else:
        E = np.array([emag[mi] for mi in active])
    d = np.array([delta[mi] for mi in active])
    for i in range(m):
        acc = 0.0
        for j in range(m):
            dij = d[i] - d[j]
            acc += E[i] * E[j] * (Yred[i, j].real * math.cos(dij)
                                  + Yred[i, j].imag * math.sin(dij))
        P[i] = acc
    return P


# ── Time-domain integration ─────────────────────────────────────────────

def _simulate(machines, segments, freq, t_end, dt, record=False, island_of=None,
              dyn=None, y0=None):
    """Integrate the swing equations across the network ``segments``.

    segments: ordered list of ``(t_switch, variant)`` where variant is
    ``{"Yred", "active", "Pm", "R", "keep_bus"}``; the variant in force is the
    last whose t_switch ≤ t. Returns a dict with the stability verdict and, when
    ``record`` is set, decimated trajectories.

    dyn/y0: when dynamic devices are present (voltage-dependent loads or dynamic
    induction motors), the load shunt is rebuilt and the network re-reduced each
    step from the base admittance ``y0`` plus the device models in ``dyn`` (motor
    slip is an integrated state). When ``dyn`` is None the network is constant and
    the precomputed per-segment reductions are used (the classical fast path).
    """
    ws = 2.0 * math.pi * freq
    m = len(machines)
    delta = np.array([mac["delta0"] for mac in machines], dtype=float)
    omega = np.zeros(m)   # Δω (rad/s)
    Hs = np.array([mac["H"] for mac in machines])
    Ds = np.array([mac["D"] for mac in machines])

    # Turbine-governor state. Mechanical power Pm is no longer a fixed constant:
    # each governed machine's Pm follows its speed so the island recovers after
    # a load change (a genset with a real governor opens the fuel valve as the
    # speed sags). Model per machine (system p.u.):
    #     dPm/dt   = (Pm0 + Psec − Δω/(ω_s·R) − Pm) / Tg     (droop + turbine lag)
    #     dPsec/dt = −Δω/(ω_s·R·Tr)   for the isochronous mode, else 0
    # The droop term −Δω/(ω_s·R) is negative speed feedback (primary response) —
    # it both shares load between paralleled sets and damps the swing; the reset
    # integrator Psec drives the steady speed error to zero (frequency returns
    # to nominal). 'droop' leaves a small steady offset; 'none' freezes Pm at
    # Pm0 (the historical constant-Pm classical model). Pm is capped at the
    # machine rating with anti-windup so an oversized step can't wind it up.
    Pm0 = np.array([mac["Pm"] for mac in machines])
    gov_R = np.array([mac.get("gov_R", 0.04) for mac in machines])
    gov_Tg = np.array([mac.get("gov_Tg", 0.5) for mac in machines])
    gov_Tr = np.array([mac.get("gov_Tr", 5.0) for mac in machines])
    gov_on = np.array([0.0 if mac.get("gov_mode", "none") == "none" else 1.0
                       for mac in machines])
    gov_iso = np.array([1.0 if mac.get("gov_mode", "none") == "isochronous" else 0.0
                        for mac in machines])
    pmax = np.array([mac.get("pmax", 1e9) for mac in machines])
    pmin = np.array([mac.get("pmin", -1e9) for mac in machines])

    # AVR/exciter state. The field regulator drives the field toward its error:
    #     dEf/dt = (Ka·(Vref − Vt) − (Ef − Ef0)) / Ta,   Ef ∈ [Emin, Emax]
    # For a CLASSICAL machine the field state Ef IS the internal-EMF magnitude
    # |E'| (the reduction's source). For a TWO-AXIS machine Ef is the field
    # voltage E_fd that drives the flux-decay equations below. With the AVR off
    # (or an infinite bus) Ef stays at Ef0 (constant EMF / manual excitation).
    efd_ref = np.array([mac.get("efd_ref", mac["E"]) for mac in machines])
    avr_on = np.array([1.0 if mac.get("avr_on") else 0.0 for mac in machines])
    avr_Ka = np.array([mac.get("avr_Ka", 25.0) for mac in machines])
    avr_Ta = np.array([mac.get("avr_Ta", 0.2) for mac in machines])
    vref = np.array([mac.get("vref", 1.0) for mac in machines])
    emax = np.array([mac.get("emax", 1e9) for mac in machines])
    emin = np.array([mac.get("emin", 0.0) for mac in machines])
    any_avr = bool(avr_on.any())

    # Two-axis (flux-decay) machine parameters. E'q/E'd are integrated states;
    # classical machines keep them at 0 and use Ef directly as |E'|.
    two_ax = [bool(mac.get("two_axis")) for mac in machines]
    any_two = any(two_ax)
    dXd = np.array([mac.get("dXd", 0.0) for mac in machines])
    dXq = np.array([mac.get("dXq", 0.0) for mac in machines])
    Tdop = np.array([mac.get("tdop", 6.0) for mac in machines])
    Tqop = np.array([mac.get("tqop", 1.0) for mac in machines])
    epq0 = np.array([mac.get("epq0", 0.0) for mac in machines])
    epd0 = np.array([mac.get("epd0", 0.0) for mac in machines])
    HALF_PI = math.pi / 2.0

    def _eint(active, delta, efield, epq, epd):
        """Complex internal EMF per active machine (network frame). Classical:
        Ef∠δ. Two-axis: (E'd + jE'q)·e^{j(δ−π/2)}."""
        out = np.empty(len(active), dtype=complex)
        for pos, mi in enumerate(active):
            if two_ax[mi]:
                out[pos] = complex(epd[mi], epq[mi]) * complex(
                    math.cos(delta[mi] - HALF_PI), math.sin(delta[mi] - HALF_PI))
            else:
                out[pos] = efield[mi] * complex(math.cos(delta[mi]), math.sin(delta[mi]))
        return out

    # Dynamic induction-motor slip state (empty unless dynamic devices exist).
    # Each motor's terminal voltage sets its air-gap torque; the slip integrates
    # 2H·dω_r/dt = T_e − T_L, i.e. ds/dt = (T_L − T_e)/(2H), so a voltage dip
    # slows the motor (more current, possibly stall) exactly as a real machine.
    dyn_motors = dyn["motors"] if dyn else []
    dyn_loads = dyn["loads"] if dyn else []
    dyn_ibrs = dyn["ibrs"] if dyn else []
    n_mot = len(dyn_motors)
    n_gfl = len(dyn_ibrs)
    slips0 = np.array([mo["s0"] for mo in dyn_motors]) if n_mot else np.zeros(0)

    # Grid-forming converters: a virtual impedance bounds the terminal current at
    # I_max. Each step (dynamic path) the lagged machine current sets how much
    # coupling reactance to add so the fault current is limited — a synchronous
    # machine has no such limit, which is the point of modelling an IBR.
    gfm_idx = [i for i, mac in enumerate(machines) if mac.get("ibr") == "gfm"]
    any_gfm = bool(gfm_idx)
    imach_peak = {i: 0.0 for i in gfm_idx}   # peak converter current for reporting

    # ── Protection: under-frequency load shedding (UFLS), generator over/under-
    # frequency and under-voltage trips, motor under-voltage (contactor) trips,
    # and inverter voltage/frequency ride-through trips. Relays accumulate time-
    # in-violation and trip after their delay; the tripped element is then removed
    # from the network (re-reduced next step).
    has_prot = bool(dyn and dyn.get("has_protection"))
    tripped_loads, tripped_motors, tripped_mach, tripped_ibr = set(), set(), set(), set()
    trip_events = []
    load_shed_t = [0.0] * len(dyn_loads)
    load_uv_t = [0.0] * len(dyn_loads)
    mot_uv_t = [0.0] * n_mot
    ibr_trip_t = [0.0] * n_gfl
    gen_trip_t = [0.0] * m
    need_bus_v = any_avr or n_mot > 0 or has_prot or n_gfl > 0
    vbus_prev = {}   # last-step bus-voltage magnitudes (voltage-dependent loads)

    # Per-island centre of inertia. Machines in a grid-connected island are
    # anchored by the infinite bus; a governor-less genset island drifts as a
    # block after any power imbalance, so synchronism is judged against each
    # island's OWN COI — never a global one that would include a disconnected
    # grid and mistake a normal island frequency excursion for instability.
    if island_of is None:
        island_of = [0] * m
    island_members = {}
    for i, isl in enumerate(island_of):
        island_members.setdefault(isl, []).append(i)
    island_H = {isl: max(sum(Hs[j] for j in mem), 1e-12)
                for isl, mem in island_members.items()}

    def refs(dv):
        # Per-island COI over the LIVE (non-tripped) machines, so a tripped
        # generator's coasting rotor neither shifts the reference nor is judged.
        r = np.zeros(m)
        for isl, mem in island_members.items():
            live = [j for j in mem if j not in tripped_mach]
            if not live:
                continue
            hsum = max(sum(Hs[j] for j in live), 1e-12)
            c = sum(Hs[j] * dv[j] for j in live) / hsum
            for j in live:
                r[j] = c
        return r

    def variant_at(t):
        v = segments[0][1]
        for ts, seg in segments:
            if t + 1e-12 >= ts:
                v = seg
            else:
                break
        return v

    def _bus_voltages(v, eint_active):
        """{bus_idx: |V|} for the kept buses, from the active machine EMFs."""
        if not v["active"]:
            return {}
        Vbus = v["R"] @ eint_active
        return {bi: abs(Vbus[k]) for k, bi in enumerate(v["keep_bus"])}

    def deriv(t, delta, omega, pm, psec, efield, epq, epd, slips, veff):
        v = veff if veff is not None else variant_at(t)
        active = v["active"]
        active_set = set(active)
        # Complex internal EMFs, machine currents (I = Yred·E) and electrical
        # power P = Re(E·conj(I)) — unified across classical and two-axis.
        eint_a = _eint(active, delta, efield, epq, epd)
        Ia = v["Yred"] @ eint_a if len(active) else np.zeros(0, dtype=complex)
        Pe = np.zeros(m)
        for pos, mi in enumerate(active):
            Pe[mi] = (eint_a[pos] * np.conj(Ia[pos])).real
        vmag = _bus_voltages(v, eint_a) if need_bus_v else {}
        ddelta = omega.copy()
        domega = np.zeros(m)
        dpm = np.zeros(m)
        dpsec = np.zeros(m)
        defield = np.zeros(m)
        depq = np.zeros(m)
        depd = np.zeros(m)
        cur = {mi: Ia[pos] for pos, mi in enumerate(active)}
        for i in range(m):
            is_active = i in active_set
            if gov_on[i] and is_active:
                dfpu = omega[i] / ws
                # Droop is defined on the MACHINE base (R = p.u. speed per p.u.
                # machine power), so scale the response by the machine rating
                # (system p.u.) before comparing with Pm, which is system p.u.
                sr = pmax[i]
                cmd = Pm0[i] + psec[i] - (dfpu / gov_R[i]) * sr
                d = (cmd - pm[i]) / gov_Tg[i]
                # anti-windup: don't drive Pm past the machine's capacity limits
                if (pm[i] >= pmax[i] and d > 0) or (pm[i] <= pmin[i] and d < 0):
                    d = 0.0
                dpm[i] = d
                dpsec[i] = -gov_iso[i] * (dfpu / (gov_R[i] * gov_Tr[i])) * sr
            if avr_on[i] and is_active:
                vt = vmag.get(machines[i]["bus_idx"], 0.0)  # grounded ⇒ 0
                de = (avr_Ka[i] * (vref[i] - vt) - (efield[i] - efd_ref[i])) / avr_Ta[i]
                # anti-windup at the field ceiling / floor
                if (efield[i] >= emax[i] and de > 0) or (efield[i] <= emin[i] and de < 0):
                    de = 0.0
                defield[i] = de
            if two_ax[i] and is_active:
                # Flux decay: resolve the machine current into rotor d-q and
                # relax E'q/E'd toward the field / open-circuit values.
                idq = cur[i] * complex(math.cos(HALF_PI - delta[i]),
                                       math.sin(HALF_PI - delta[i]))
                Id, Iq = idq.real, idq.imag
                depq[i] = (efield[i] - epq[i] - dXd[i] * Id) / Tdop[i]
                depd[i] = (-epd[i] + dXq[i] * Iq) / Tqop[i]
            # Mechanical power seen by the rotor: the governed state Pm while the
            # machine is on line, zero once it has been tripped (removed from the
            # active set) so it neither drives nor drags the surviving machines.
            pm_eff = pm[i] if is_active else 0.0
            domega[i] = ws / (2.0 * Hs[i]) * (pm_eff - Pe[i] - Ds[i] * omega[i] / ws)
        # Induction-motor slip dynamics: ds/dt = (T_L − T_e)/(2H).
        dslips = np.zeros(n_mot)
        for k in range(n_mot):
            mo = dyn_motors[k]
            s = min(max(slips[k], 1e-4), 1.0)
            vm = vmag.get(mo["bus"], 0.0)
            te = mo["model"].torque(vm, s)
            tl = mo["load_fn"](1.0 - s)
            dslips[k] = (tl - te) / (2.0 * mo["h_s"])
        return ddelta, domega, dpm, dpsec, defield, depq, depd, dslips

    pm = Pm0.copy()          # governed mechanical power (starts at equilibrium)
    psec = np.zeros(m)       # isochronous reset (secondary) state
    efield = efd_ref.copy()  # field state (|E'| classical, E_fd two-axis)
    epq = epq0.copy()        # two-axis q-axis transient EMF
    epd = epd0.copy()        # two-axis d-axis transient EMF
    slips = slips0.copy()    # induction-motor slips (empty when no dynamic motor)

    def _effective_variant(t, omega):
        """The reduction in force this step: the precomputed per-segment one, or
        (dynamic devices / protection present) a fresh reduction of the base
        admittance with the voltage-dependent load, motor-slip and grid-following-
        converter injections, tripped devices removed, tripped generators dropped
        from the active set, and the grid-forming current-limit virtual impedance
        converged.

        The grid-forming current limiter is solved WITHIN the step (an integral
        law on the current error, iterated over the reduction) rather than lagged
        a step, so a converter's terminal current is held at I_max from the first
        cycle of a fault — a lagged limiter would let one full unlimited cycle
        through, which is exactly the synchronous-machine behaviour a converter
        does not have."""
        if not dyn:
            return None
        vd = variant_at(t)
        active = [i for i in vd["active"] if i not in tripped_mach]
        ibr_inj = None
        if n_gfl:
            isl_freq = _island_freq(omega)
            ibr_inj = {}
            for j, g in enumerate(dyn_ibrs):
                if j in tripped_ibr:
                    continue
                v = vbus_prev.get(g["bus"], g["V0"])
                ibr_inj[j] = _gfl_injection(g, v, isl_freq.get(g["island"]), freq)
        shunt = _dyn_shunt(dyn, y0, vbus_prev, slips, vd.get("load_scale"),
                           tripped_loads, tripped_motors, ibr_inj, tripped_ibr)
        gfm_active = [i for i in active if machines[i].get("ibr") == "gfm"]
        zov = {}
        Yred, R, keep = _reduce(vd["ybus"], shunt, machines, active, vd["grounded"], zov)
        if gfm_active:
            eint_a = _eint(active, delta, efield, epq, epd)   # EMFs fixed this step
            pos_of = {mi: p for p, mi in enumerate(active)}
            for _ in range(GFM_CLIM_ITERS):
                Ia = Yred @ eint_a if active else np.zeros(0, dtype=complex)
                over = False
                for mi in gfm_active:
                    imax = machines[mi]["imax"]
                    if imax <= 0:
                        continue
                    imag = abs(Ia[pos_of[mi]])
                    if imag > imax * 1.01:
                        # Current ≈ E / X_total, so scale the total coupling
                        # reactance by the current-overshoot ratio to drive it to
                        # I_max (a few iterations; monotone, bounded at 50·X_f).
                        z0 = machines[mi]["z"]
                        xtot = zov.get(mi, z0).imag
                        xv = min(xtot * (imag / imax) - z0.imag, 50.0 * machines[mi]["xbase"])
                        zov[mi] = complex(z0.real, z0.imag + xv)
                        over = True
                if not over:
                    break
                Yred, R, keep = _reduce(vd["ybus"], shunt, machines, active, vd["grounded"], zov)
            Ia = Yred @ eint_a if active else np.zeros(0, dtype=complex)
            for mi in gfm_active:                         # record the bounded peak
                imach_peak[mi] = max(imach_peak.get(mi, 0.0), abs(Ia[pos_of[mi]]))
        return {"Yred": Yred, "R": R, "keep_bus": keep, "active": active,
                "Pm": vd["Pm"]}

    def _island_freq(omega):
        """Island COI frequency (Hz) over live machines, keyed by island id."""
        out = {}
        for isl, mem in island_members.items():
            live = [j for j in mem if j not in tripped_mach]
            if not live:
                continue
            hsum = max(sum(Hs[j] for j in live), 1e-12)
            coi = sum(Hs[j] * omega[j] for j in live) / hsum
            out[isl] = freq + coi / (2.0 * math.pi)
        return out

    def _check_protection(t, omega):
        """Advance relay timers and trip elements whose violation has persisted
        past its delay. Uses the lagged bus voltages (vbus_prev) and the current
        speeds; a trip changes tripped_* so the next reduction reflects it."""
        if not has_prot:
            return
        isl_freq = _island_freq(omega)
        for j, d in enumerate(dyn_loads):
            if j in tripped_loads:
                continue
            f = isl_freq.get(d["island"])
            if d["shed_hz"] > 0 and f is not None and f < d["shed_hz"]:
                load_shed_t[j] += dt
                if load_shed_t[j] >= d["shed_delay"]:
                    tripped_loads.add(j)
                    trip_events.append({"t": round(t, 3), "element": d["name"],
                                        "reason": f"UFLS shed at {f:.2f} Hz"})
                    continue
            else:
                load_shed_t[j] = 0.0
            v = vbus_prev.get(d["bus"], d["V0"])
            if d["uv_pu"] > 0 and v < d["uv_pu"]:
                load_uv_t[j] += dt
                if load_uv_t[j] >= d["uv_delay"]:
                    tripped_loads.add(j)
                    trip_events.append({"t": round(t, 3), "element": d["name"],
                                        "reason": f"under-voltage trip at {v:.2f} p.u."})
            else:
                load_uv_t[j] = 0.0
        for k, mo in enumerate(dyn_motors):
            if k in tripped_motors or mo.get("uv_pu", 0) <= 0:
                continue
            v = vbus_prev.get(mo["bus"], 1.0)
            if v < mo["uv_pu"]:
                mot_uv_t[k] += dt
                if mot_uv_t[k] >= mo["uv_delay"]:
                    tripped_motors.add(k)
                    trip_events.append({"t": round(t, 3), "element": mo["name"],
                                        "reason": f"motor contactor drop-out at {v:.2f} p.u."})
            else:
                mot_uv_t[k] = 0.0
        for j, g in enumerate(dyn_ibrs):
            if j in tripped_ibr:
                continue
            v = vbus_prev.get(g["bus"], g["V0"])
            fr = isl_freq.get(g["island"])
            hit = ((g["uv_pu"] > 0 and v < g["uv_pu"])
                   or (fr is not None and g["of_hz"] > 0 and fr > g["of_hz"])
                   or (fr is not None and g["uf_hz"] > 0 and fr < g["uf_hz"]))
            if hit:
                ibr_trip_t[j] += dt
                if ibr_trip_t[j] >= g["trip_delay"]:
                    tripped_ibr.add(j)
                    why = (f"under-voltage {v:.2f} p.u." if g["uv_pu"] > 0 and v < g["uv_pu"]
                           else f"over-freq {fr:.2f} Hz" if fr is not None and g["of_hz"] > 0 and fr > g["of_hz"]
                           else f"under-freq {fr:.2f} Hz")
                    trip_events.append({"t": round(t, 3), "element": g["name"],
                                        "reason": f"inverter ride-through trip ({why})"})
            else:
                ibr_trip_t[j] = 0.0
        for i, mac in enumerate(machines):
            if i in tripped_mach or mac["infinite"]:
                continue
            f = freq + omega[i] / (2.0 * math.pi)
            v = vbus_prev.get(mac["bus_idx"], mac.get("vref", 1.0))
            hit = ((mac["trip_of_hz"] > 0 and f > mac["trip_of_hz"])
                   or (mac["trip_uf_hz"] > 0 and f < mac["trip_uf_hz"])
                   or (mac["trip_uv_pu"] > 0 and v < mac["trip_uv_pu"]))
            if hit:
                gen_trip_t[i] += dt
                if gen_trip_t[i] >= mac["trip_delay_s"]:
                    tripped_mach.add(i)
                    why = (f"over-freq {f:.2f} Hz" if mac["trip_of_hz"] > 0 and f > mac["trip_of_hz"]
                           else f"under-freq {f:.2f} Hz" if mac["trip_uf_hz"] > 0 and f < mac["trip_uf_hz"]
                           else f"under-voltage {v:.2f} p.u.")
                    trip_events.append({"t": round(t, 3), "element": mac["name"],
                                        "reason": f"generator trip ({why})"})
            else:
                gen_trip_t[i] = 0.0

    rec_t, rec_delta, rec_omega, rec_pe, rec_vbus = [], [], [], [], []
    bus_ids_all = None
    unstable = False
    freq_end, freq_late = {}, {}   # island COI frequency: latest, and at ~80% window
    t = 0.0
    steps = int(math.ceil(t_end / dt))

    for step in range(steps + 1):
        if has_prot:
            _check_protection(t, omega)
        veff = _effective_variant(t, omega)
        if record:
            v = veff if veff is not None else variant_at(t)
            rec_t.append(round(t, 4))
            ref = refs(delta)
            rec_delta.append([round(math.degrees(delta[i] - ref[i]), 2) for i in range(m)])
            rec_omega.append([round(omega[i] / (2.0 * math.pi), 4) for i in range(m)])
            eint_a = _eint(v["active"], delta, efield, epq, epd)
            Ia = v["Yred"] @ eint_a if len(v["active"]) else np.zeros(0, dtype=complex)
            pe = [0.0] * m
            for pos, mi in enumerate(v["active"]):
                pe[mi] = round(float((eint_a[pos] * np.conj(Ia[pos])).real), 4)
            rec_pe.append(pe)
            # bus voltages V_keptbus = R · E_int (E_int carries the live field /
            # flux-decay state, so the trace shows the voltage recovery)
            vmap = {bi: abs((v["R"] @ eint_a)[k])
                    for k, bi in enumerate(v["keep_bus"])} if len(v["active"]) else {}
            rec_vbus.append(vmap)

        # instability check (relative to each machine's island COI); a tripped
        # generator is off-line and coasting, so it is not judged.
        ref = refs(delta)
        live_idx = [i for i in range(m) if i not in tripped_mach]
        if live_idx and max(abs(delta[i] - ref[i]) for i in live_idx) > UNSTABLE_ANGLE:
            unstable = True
            if not record:
                break

        # Track each island's COI frequency (latest value, and the value ~80% of
        # the way through the window) for the separate frequency-stability check.
        for isl, fv in _island_freq(omega).items():
            freq_end[isl] = fv
            if t >= 0.8 * t_end and isl not in freq_late:
                freq_late[isl] = fv

        if step == steps:
            break
        # RK4 over (delta, omega, Pm, Psec, E_field, E'q, E'd, motor slips). The
        # reduction veff is held constant across the four stages (redone next step).
        def _f(td, dd, oo, pp, ss, ee, qq, dd2, mm2):
            return deriv(td, dd, oo, pp, ss, ee, qq, dd2, mm2, veff)
        k1 = _f(t, delta, omega, pm, psec, efield, epq, epd, slips)
        k2 = _f(t + dt / 2, delta + dt / 2 * k1[0], omega + dt / 2 * k1[1],
                pm + dt / 2 * k1[2], psec + dt / 2 * k1[3], efield + dt / 2 * k1[4],
                epq + dt / 2 * k1[5], epd + dt / 2 * k1[6], slips + dt / 2 * k1[7])
        k3 = _f(t + dt / 2, delta + dt / 2 * k2[0], omega + dt / 2 * k2[1],
                pm + dt / 2 * k2[2], psec + dt / 2 * k2[3], efield + dt / 2 * k2[4],
                epq + dt / 2 * k2[5], epd + dt / 2 * k2[6], slips + dt / 2 * k2[7])
        k4 = _f(t + dt, delta + dt * k3[0], omega + dt * k3[1],
                pm + dt * k3[2], psec + dt * k3[3], efield + dt * k3[4],
                epq + dt * k3[5], epd + dt * k3[6], slips + dt * k3[7])
        comb = lambda a, b, c, d: dt / 6 * (a + 2 * b + 2 * c + d)
        delta = delta + comb(k1[0], k2[0], k3[0], k4[0])
        omega = omega + comb(k1[1], k2[1], k3[1], k4[1])
        pm = np.clip(pm + comb(k1[2], k2[2], k3[2], k4[2]), pmin, pmax)
        psec = psec + comb(k1[3], k2[3], k3[3], k4[3])
        efield = np.clip(efield + comb(k1[4], k2[4], k3[4], k4[4]), emin, emax)
        if any_two:
            epq = epq + comb(k1[5], k2[5], k3[5], k4[5])
            epd = epd + comb(k1[6], k2[6], k3[6], k4[6])
        if n_mot:
            slips = np.clip(slips + comb(k1[7], k2[7], k3[7], k4[7]), 1e-4, 1.0)
        # Lag the bus voltages one step for the next voltage-dependent load / GFL
        # shunt (the GFM current limiter converges in-step, so no current lag).
        if dyn and veff is not None:
            vbus_prev = _bus_voltages(veff, _eint(veff["active"], delta, efield, epq, epd))
        t += dt

    # Frequency-stability verdict, per island, over the live machines. Flag an
    # island whose COI frequency ended beyond FREQ_UNSTABLE_BAND of nominal and
    # is NOT recovering (its end deviation is no smaller than its late-window
    # deviation) — a collapse or run-away, distinct from a transient that is
    # settling back. Kept separate from the rotor-angle ``unstable`` flag so the
    # CCT search (which reads ``stable``) stays a pure first-swing angle test.
    freq_unstable = False
    freq_reason = None
    freq_msgs = []
    worst = 0.0
    for isl, fe in freq_end.items():
        fl = freq_late.get(isl, fe)
        dev_e, dev_l = fe - freq, fl - freq
        if abs(dev_e) > FREQ_UNSTABLE_BAND and abs(dev_e) >= abs(dev_l) - FREQ_RECOVER_TOL:
            freq_unstable = True
            kind = "collapse" if dev_e < 0 else "run-up"
            freq_msgs.append(
                f"Island frequency ended at {fe:.1f} Hz and was not recovering — a "
                f"frequency {kind}: generation cannot follow the load (overload, or "
                f"a governor-less / capacity-limited imbalance). Rotor angles stayed "
                f"in synchronism, but the island frequency is unstable.")
            if abs(dev_e) > worst:
                worst, freq_reason = abs(dev_e), f"frequency {kind}"

    result = {"stable": not unstable, "trips": trip_events, "ibr_current": imach_peak,
              "freq_unstable": freq_unstable, "freq_reason": freq_reason,
              "freq_msgs": freq_msgs}
    if record:
        result["curves"] = _decimate_traj(rec_t, rec_delta, rec_omega, rec_pe,
                                           rec_vbus, machines, segments)
    return result


def _decimate_traj(rec_t, rec_delta, rec_omega, rec_pe, rec_vbus, machines, segments):
    n = len(rec_t)
    keep = range(n)
    if n > MAX_RECORD_POINTS:
        stride = -(-n // MAX_RECORD_POINTS)
        keep = list(range(0, n - 1, stride)) + [n - 1]
    idx = list(keep)
    m = len(machines)
    # all bus ids seen across variants
    bus_ids = []
    for _, seg in segments:
        for bi in seg["keep_bus"]:
            if bi not in bus_ids:
                bus_ids.append(bi)
    bus_ids = sorted(set(bi for _, seg in segments for bi in seg["keep_bus"]))
    return {
        "t": [rec_t[i] for i in idx],
        "delta_deg": [[rec_delta[i][j] for i in idx] for j in range(m)],
        "speed_hz": [[rec_omega[i][j] for i in idx] for j in range(m)],
        "pe_pu": [[rec_pe[i][j] for i in idx] for j in range(m)],
        "bus_v": {bi: [round(rec_vbus[i].get(bi, 0.0), 4) for i in idx] for bi in bus_ids},
    }


# ── Public entry point ──────────────────────────────────────────────────

def _build_segments(project, ctx, lf, machines, disturbance, warnings):
    """Return (segments, event_desc). Each segment is (t_switch, variant)."""
    base_ybus = ctx["Y"]
    bus_idx = ctx["bus_idx"]
    machine_bus_idxs = {mac["bus_idx"] for mac in machines}
    load_shunt = _load_shunts(lf, ctx, machine_bus_idxs)
    all_active = list(range(len(machines)))

    def variant(ybus, active, grounded, shunt=None, pm_over=None, load_scale=None):
        Yred, R, keep = _reduce(ybus, load_shunt if shunt is None else shunt,
                                machines, active, grounded)
        Pm = np.array([machines[i]["Pm"] if (pm_over is None or i not in pm_over)
                       else pm_over[i] for i in range(len(machines))])
        # ybus/grounded/load_scale let the dynamic path re-reduce each step.
        return {"Yred": Yred, "active": active, "R": R, "keep_bus": keep, "Pm": Pm,
                "ybus": ybus, "grounded": grounded, "load_scale": load_scale}

    dtype = disturbance.get("type", "fault")

    if dtype == "fault":
        fbus = disturbance.get("bus")
        if fbus not in bus_idx:
            raise ValueError("Fault bus not found in the network.")
        t_clear = float(disturbance.get("clear_time_s", 0.1))
        grounded = {bus_idx[fbus]}
        # optional branch trip on clearing
        post_ctx = ctx
        trip = disturbance.get("trip_element")
        if trip:
            post_ctx = build_branch_ybus(_project_without(project, trip))
        fault_v = variant(base_ybus, all_active, grounded)
        post_v = variant(post_ctx["Y"], all_active, set())
        return ([(0.0, fault_v), (t_clear, post_v)],
                f"3-φ fault at {_bus_name(project, fbus)} cleared at {t_clear*1000:.0f} ms"
                + (f", tripping {_comp_name(project, trip)}" if trip else ""))

    if dtype == "trip":
        t_ev = float(disturbance.get("time_s", 0.1))
        elem = disturbance.get("element")
        pre_v = variant(base_ybus, all_active, set())
        comp = next((c for c in project.components if c.id == elem), None)
        if comp is not None and comp.type in MACHINE_SOURCE_TYPES:
            active = [i for i in all_active if machines[i]["comp_id"] != elem]
            pm_over = {i: 0.0 for i in all_active if machines[i]["comp_id"] == elem}
            post_v = variant(base_ybus, active, set(), pm_over=pm_over)
            desc = f"Trip generator {_comp_name(project, elem)} at {t_ev*1000:.0f} ms"
        else:
            post_ctx = build_branch_ybus(_project_without(project, elem))
            post_v = variant(post_ctx["Y"], all_active, set())
            desc = f"Trip {_comp_name(project, elem)} at {t_ev*1000:.0f} ms"
        return ([(0.0, pre_v), (t_ev, post_v)], desc)

    if dtype == "load_step":
        t_ev = float(disturbance.get("time_s", 0.1))
        elem = disturbance.get("element")
        frac = 1.0 + float(disturbance.get("delta_pct", 50)) / 100.0
        comp = next((c for c in project.components if c.id == elem), None)
        lbus = _component_bus_idx(project, ctx, elem) if elem else None
        shunt2 = load_shunt.copy()
        if lbus is not None:
            shunt2[lbus] = shunt2[lbus] * frac
        pre_v = variant(base_ybus, all_active, set())
        # load_scale mirrors the shunt scaling for the dynamic re-reduction path.
        post_v = variant(base_ybus, all_active, set(), shunt=shunt2,
                         load_scale=(lbus, frac) if lbus is not None else None)
        nm = _comp_name(project, elem) if elem else "load"
        return ([(0.0, pre_v), (t_ev, post_v)],
                f"Step {nm} by {disturbance.get('delta_pct', 50):+.0f}% at {t_ev*1000:.0f} ms")

    raise ValueError(f"Unknown disturbance type '{dtype}'.")


def _project_without(project, comp_id):
    """A shallow project copy with a component (and its wires) removed."""
    keep = [c for c in project.components if c.id != comp_id]
    wires = [w for w in project.wires
             if w.fromComponent != comp_id and w.toComponent != comp_id]
    clone = project.model_copy(update={"components": keep, "wires": wires})
    return clone


def _bus_name(project, bus_id):
    for c in project.components:
        if c.id == bus_id:
            return c.props.get("name", bus_id)
    return bus_id


def _comp_name(project, comp_id):
    for c in project.components:
        if c.id == comp_id:
            return c.props.get("name", comp_id)
    return comp_id


def _component_bus_idx(project, ctx, comp_id):
    """Bus index a (load) component attaches to, via the transparent/branch walk."""
    adjacency, components, bus_of = ctx["adjacency"], ctx["components"], ctx["bus_idx"]
    bus_of_map = ctx["bus_of"]
    from collections import deque
    seen = {comp_id}
    q = deque(ctx["adjacency"].get(comp_id, []))
    while q:
        nid = q.popleft()
        if nid in seen:
            continue
        seen.add(nid)
        if nid in bus_of_map:
            return ctx["bus_idx"][bus_of_map[nid]]
        c = ctx["components"].get(nid)
        if c and c.type in ("cb", "switch", "fuse", "ct", "pt", "surge_arrester"):
            q.extend(ctx["adjacency"].get(nid, []))
    return None


def run_transient_stability(project, disturbance=None):
    """Run a classical transient-stability study.

    disturbance (dict): ``type`` ∈ {fault, trip, load_step} plus per-type keys
    (see module docstring). ``t_end_s``, ``dt_s`` and ``find_cct`` are optional
    globals. Returns ``{machines, curves, stable, event, cct_s, warnings}``.
    """
    disturbance = dict(disturbance or {"type": "fault"})
    freq = float(project.frequency or 50)
    warnings = []

    ctx = build_branch_ybus(project)
    if ctx is None:
        return {"machines": [], "stable": None,
                "warnings": ["Network has no AC buses."], "curves": None}

    lf = None
    for method in ("newton_raphson", "gauss_seidel"):
        try:
            r = run_load_flow(project, method, include_synthetic=True)
        except Exception:
            continue
        if r.converged:
            lf = r
            break
    if lf is None:
        return {"machines": [], "stable": None,
                "warnings": ["Pre-fault load flow did not converge — cannot "
                             "initialise the stability study."], "curves": None}

    machines, mw = _collect_machines(project, ctx, lf)
    warnings += mw
    if len(machines) < 1:
        return {"machines": [], "stable": None,
                "warnings": ["No synchronous machines (generator / utility) found."],
                "curves": None}
    if all(m["infinite"] for m in machines):
        warnings.append("Only infinite-bus sources present — no finite-inertia "
                        "machine to swing; result is trivially stable.")

    # Enforce a consistent pre-fault equilibrium: set each machine's mechanical
    # power to its electrical output computed from the PRE-FAULT reduced network
    # at the initial angles. Taking P_m straight from the load-flow injection
    # leaves a residual P_m − P_e mismatch whenever the reduction isn't a perfect
    # inverse of the flow (e.g. several machines sharing a bus, inverter sources
    # folded in as admittances) — that mismatch makes the rotors drift or, for
    # light high-reactance machines, run away on the slightest disturbance.
    machine_bus_idxs = {m["bus_idx"] for m in machines}
    load_shunt0 = _load_shunts(lf, ctx, machine_bus_idxs)
    all_idx = list(range(len(machines)))
    try:
        Yred0, _, _ = _reduce(ctx["Y"], load_shunt0, machines, all_idx, set())
        # Internal EMF (complex) at the initial state — classical Ef∠δ, two-axis
        # (E'd + jE'q)·e^{j(δ−π/2)}; both equal V + jX'd·I at the operating point.
        eint0 = np.empty(len(machines), dtype=complex)
        for i, mac in enumerate(machines):
            d0 = mac["delta0"]
            if mac.get("two_axis"):
                eint0[i] = complex(mac["epd0"], mac["epq0"]) * complex(
                    math.cos(d0 - math.pi / 2), math.sin(d0 - math.pi / 2))
            else:
                eint0[i] = mac["E"] * complex(math.cos(d0), math.sin(d0))
        I0 = Yred0 @ eint0
        Pe0 = (eint0 * np.conj(I0)).real
        for i, m in enumerate(machines):
            if not m["infinite"]:
                m["Pm"] = float(Pe0[i])
    except np.linalg.LinAlgError:
        pass  # keep the load-flow P_m if the pre-fault reduction is singular

    # Group machines into electrical islands so synchronism is judged per island
    # (a genset island separated from the grid by an open breaker drifts as a
    # block — that is a frequency excursion, not loss of synchronism).
    island_of = _machine_island_of(ctx["Y"], machines)
    by_isl = {}
    for i, isl in enumerate(island_of):
        by_isl.setdefault(isl, []).append(i)
    islanded_genset = [mem for mem in by_isl.values()
                       if all(not machines[j]["infinite"] for j in mem)]
    if islanded_genset:
        # Frequency in a grid-less island is held by the turbine-governors or a
        # grid-forming converter's P-f droop, both modelled (see _simulate). Warn
        # only when NO machine in such an island regulates frequency (every set's
        # governor is disabled and there is no grid-forming converter) — then Pm
        # is fixed and the island frequency drifts (the historical constant-Pm
        # behaviour).
        if any(all(not machines[j].get("freq_response") for j in mem)
               for mem in islanded_genset):
            warnings.append(
                "An islanded generator group has its governor(s) disabled "
                "(Governor = none) and no grid-forming source — with no grid "
                "reference and fixed mechanical power the island frequency drifts "
                "after a load change and does not recover. Set the governor to "
                "isochronous / droop, or make an inverter grid-forming, to model "
                "the frequency response.")
        else:
            warnings.append(
                "An islanded generator group with no grid / infinite-bus "
                "reference was found — its frequency is governed by the modelled "
                "turbine-governors / grid-forming converters (isochronous aims to "
                "return to nominal, droop settles at an offset), but only within "
                "their capacity: an overloaded island's frequency can still "
                "collapse (see the verdict and the frequency trace). Synchronism "
                "is judged against the island's own centre of inertia.")

    t_end = float(disturbance.get("t_end_s", 5.0))
    # Step from the stiffest finite machine, bounded for accuracy/speed.
    hmin = min((m["H"] for m in machines if not m["infinite"]), default=4.0)
    dt = float(disturbance.get("dt_s", 0)) or max(min(0.005, hmin / 400.0), 0.0005)

    # Dynamic loads / motors (None ⇒ classical constant-shunt fast path). y0 is
    # the base constant-Z shunt the dynamic path perturbs each step.
    dyn = _dynamic_setup(project, ctx, lf, freq, warnings)
    y0 = _load_shunts(lf, ctx, machine_bus_idxs) if dyn else None

    segments, event = _build_segments(project, ctx, lf, machines, disturbance, warnings)
    sim = _simulate(machines, segments, freq, t_end, dt, record=True,
                    island_of=island_of, dyn=dyn, y0=y0)

    # Public stability verdict combines rotor-angle synchronism (sim["stable"])
    # with the frequency-stability check: an island frequency that collapses /
    # runs away is unstable even though the machines stay in step with each other.
    angle_stable = sim["stable"]
    freq_unstable = sim.get("freq_unstable", False)
    stable = angle_stable and not freq_unstable
    instability = (None if stable
                   else "loss of synchronism" if not angle_stable
                   else sim.get("freq_reason") or "frequency instability")
    warnings += sim.get("freq_msgs", [])

    # Critical clearing time (binary search) for a fault, when requested. The
    # CCT is a first-swing rotor-angle metric evaluated with the classical
    # constant-impedance network (the equal-area convention), which also keeps
    # the ~20-iteration search fast when dynamic devices are present.
    cct = None
    if disturbance.get("type") == "fault" and disturbance.get("find_cct", True):
        cct = _find_cct(project, ctx, lf, machines, disturbance, freq, t_end, dt,
                        warnings, island_of, dyn=dyn, y0=y0)

    ibr_cur = sim.get("ibr_current", {})
    mach_out = []
    for j, mac in enumerate(machines):
        traj_delta = sim["curves"]["delta_deg"][j] if sim.get("curves") else []
        peak = max((abs(v) for v in traj_delta), default=0.0)
        entry = {
            "name": mac["name"], "bus": _bus_name(project, mac["bus_id"]),
            "type": ("infinite_bus" if mac["infinite"]
                     else "gfm_inverter" if mac.get("ibr") == "gfm" else "generator"),
            "h_s": round(mac["H"], 3), "pm_pu": round(mac["Pm"], 4),
            "e_pu": round(mac["E"], 4), "delta0_deg": round(math.degrees(mac["delta0"]), 2),
            "peak_angle_deg": round(peak, 1),
        }
        if mac.get("ibr") == "gfm":
            # Peak converter current as a multiple of rated (rated current in
            # system p.u. is the power rating pmax_pu at nominal voltage), and the
            # limit it is held to — the number that distinguishes a converter from
            # a synchronous machine's much larger fault contribution.
            pmax_pu = mac["pmax"] or 1e-9
            entry["peak_current_pu"] = round(ibr_cur.get(j, 0.0) / pmax_pu, 3)
            entry["imax_pu"] = round(mac["imax"] / pmax_pu, 3)
        mach_out.append(entry)

    return {
        "machines": mach_out,
        "curves": _curves_with_names(sim["curves"], project, machines, ctx),
        "stable": stable,
        "instability": instability,   # None | "loss of synchronism" | "frequency collapse/run-up"
        "event": event,
        "cct_s": round(cct, 4) if cct is not None else None,
        "dt_s": dt, "t_end_s": t_end,
        "trips": sim.get("trips", []),
        "warnings": warnings,
    }


def _curves_with_names(curves, project, machines, ctx):
    if not curves:
        return None
    idx_to_bus = {i: bid for bid, i in ctx["bus_idx"].items()}
    return {
        "t": curves["t"],
        "machines": [m["name"] for m in machines],
        "delta_deg": curves["delta_deg"],
        "speed_hz": curves["speed_hz"],
        "pe_pu": curves["pe_pu"],
        "buses": [{"bus": _bus_name(project, idx_to_bus[bi]),
                   "v_pu": curves["bus_v"][bi]}
                  for bi in curves["bus_v"]],
    }


def _find_cct(project, ctx, lf, machines, disturbance, freq, t_end, dt, warnings,
              island_of=None, dyn=None, y0=None):
    """Binary-search the critical clearing time for a bolted fault."""
    lo, hi = 0.0, CCT_SEARCH_MAX

    def stable_for(tc):
        d = dict(disturbance)
        d["clear_time_s"] = tc
        try:
            segs, _ = _build_segments(project, ctx, lf, machines, d, warnings)
        except ValueError:
            return None
        return _simulate(machines, segs, freq, t_end, dt, record=False,
                         island_of=island_of, dyn=dyn, y0=y0)["stable"]

    if stable_for(hi):
        return None  # stable even at the search ceiling — no finite CCT found
    if not stable_for(lo):
        return 0.0
    for _ in range(18):
        mid = 0.5 * (lo + hi)
        if stable_for(mid):
            lo = mid
        else:
            hi = mid
    return lo
