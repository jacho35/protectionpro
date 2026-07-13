"""Classical multi-machine transient stability (time-domain rotor angle).

First-pass "classical" model per Stevenson / Kundur ch. 13:

* Every synchronous machine is a constant voltage E′ behind its transient
  reactance X′d (utility sources are infinite buses — very large inertia, a
  fixed angle reference). Rotor motion is the swing equation

      dδ/dt = Δω,     dΔω/dt = (ω_s / 2H)·(P_m − P_e − D·Δω/ω_s)

  integrated with RK4. P_m is fixed at its pre-fault electrical output.
* All non-machine bus injections (loads, motors, inverter sources) are frozen
  as constant shunt admittances at their pre-fault operating point.
* The network is reduced (Kron) to the machine internal nodes, so

      P_ei = Σ_j |E_i||E_j| (G_ij cos δ_ij + B_ij sin δ_ij),   δ_ij = δ_i − δ_j

  with Y_red = G + jB the reduced admittance between internal nodes. The
  reduction is rebuilt for each network state (pre-fault, fault-on with the
  faulted bus grounded, and post-fault with a tripped branch / generator /
  stepped load).

Disturbances: a bolted three-phase bus fault cleared after a set time (optional
branch trip on clearing, and a binary-search critical clearing time); a
generator or branch trip; and a load step. Initial conditions come from the
positive-sequence load flow.

Two-axis machine dynamics, AVR/exciter and turbine-governor models are a
documented follow-up — this engine is the classical framework they extend.
"""

import math
import numpy as np

from .network_reduction import build_branch_ybus, _source_stub, _source_internal_z
from .loadflow import run_load_flow

INFINITE_H = 1.0e6          # utility infinite-bus inertia (angle ~frozen)
BUS_REG = 1.0e-8            # tiny shunt to keep the elimination matrix regular
UNSTABLE_ANGLE = math.pi    # |δ − δ_COI| beyond 180° ⇒ loss of synchronism
CCT_SEARCH_MAX = 1.0        # s — upper bound for the critical-clearing search
MAX_RECORD_POINTS = 400

MACHINE_SOURCE_TYPES = ("generator", "utility")


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

    sources = [c for c in project.components if c.type in MACHINE_SOURCE_TYPES]
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
        machines.append({
            "comp_id": comp.id, "name": comp.props.get("name", comp.id),
            "bus_id": bus_id, "bus_idx": bus_idx[bus_id], "z": z,
            "E": abs(E_internal), "delta0": math.atan2(E_internal.imag, E_internal.real),
            "Pm": s_net.real, "H": h_sys, "D": float(comp.props.get("damping_pu", 0) or 0),
            "infinite": infinite,
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


# ── Network reduction to the machine internal nodes ─────────────────────

def _reduce(Ybus, load_shunt, machines, active, grounded):
    """Kron-reduce to the internal nodes of the ``active`` machines.

    grounded: set of bus indices held at zero volts (a bolted 3-φ fault).
    Returns (Y_red [k×k over active], R [n_keptbus×k voltage-recovery],
    kept_bus_indices).
    """
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
        yk = 1.0 / mac["z"]
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


def _p_electrical(Yred, active, machines, delta):
    """Electrical power (system p.u.) for each active machine given rotor
    angles; returned indexed by the active-machine position."""
    m = len(active)
    P = np.zeros(m)
    E = np.array([machines[mi]["E"] for mi in active])
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

def _simulate(machines, segments, freq, t_end, dt, record=False):
    """Integrate the swing equations across the network ``segments``.

    segments: ordered list of ``(t_switch, variant)`` where variant is
    ``{"Yred", "active", "Pm", "R", "keep_bus"}``; the variant in force is the
    last whose t_switch ≤ t. Returns a dict with the stability verdict and, when
    ``record`` is set, decimated trajectories.
    """
    ws = 2.0 * math.pi * freq
    m = len(machines)
    delta = np.array([mac["delta0"] for mac in machines], dtype=float)
    omega = np.zeros(m)   # Δω (rad/s)
    Hs = np.array([mac["H"] for mac in machines])
    Ds = np.array([mac["D"] for mac in machines])
    Htot = Hs.sum()

    def variant_at(t):
        v = segments[0][1]
        for ts, seg in segments:
            if t + 1e-12 >= ts:
                v = seg
            else:
                break
        return v

    def deriv(t, delta, omega):
        v = variant_at(t)
        Pe_active = _p_electrical(v["Yred"], v["active"], machines, delta)
        Pe = np.zeros(m)
        for pos, mi in enumerate(v["active"]):
            Pe[mi] = Pe_active[pos]
        Pm = v["Pm"]
        ddelta = omega.copy()
        domega = np.zeros(m)
        for i in range(m):
            domega[i] = ws / (2.0 * Hs[i]) * (Pm[i] - Pe[i] - Ds[i] * omega[i] / ws)
        return ddelta, domega

    rec_t, rec_delta, rec_omega, rec_pe, rec_vbus = [], [], [], [], []
    bus_ids_all = None
    unstable = False
    t = 0.0
    steps = int(math.ceil(t_end / dt))

    def coi(dv):
        return float((Hs * dv).sum() / Htot)

    for step in range(steps + 1):
        if record:
            v = variant_at(t)
            rec_t.append(round(t, 4))
            dref = coi(delta)
            rec_delta.append([round(math.degrees(delta[i] - dref), 2) for i in range(m)])
            rec_omega.append([round(omega[i] / (2.0 * math.pi), 4) for i in range(m)])
            Pe_active = _p_electrical(v["Yred"], v["active"], machines, delta)
            pe = [0.0] * m
            for pos, mi in enumerate(v["active"]):
                pe[mi] = round(float(Pe_active[pos]), 4)
            rec_pe.append(pe)
            # bus voltages: V_keptbus = R · (E∠δ) for active machines
            Evec = np.array([machines[mi]["E"]
                             * complex(math.cos(delta[mi]), math.sin(delta[mi]))
                             for mi in v["active"]])
            Vbus = v["R"] @ Evec
            vmap = {}
            for k, bi in enumerate(v["keep_bus"]):
                vmap[bi] = abs(Vbus[k])
            rec_vbus.append(vmap)

        # instability check (relative to the centre of inertia)
        dref = coi(delta)
        if max(abs(delta[i] - dref) for i in range(m)) > UNSTABLE_ANGLE:
            unstable = True
            if not record:
                break

        if step == steps:
            break
        # RK4
        k1d, k1o = deriv(t, delta, omega)
        k2d, k2o = deriv(t + dt / 2, delta + dt / 2 * k1d, omega + dt / 2 * k1o)
        k3d, k3o = deriv(t + dt / 2, delta + dt / 2 * k2d, omega + dt / 2 * k2o)
        k4d, k4o = deriv(t + dt, delta + dt * k3d, omega + dt * k3o)
        delta = delta + dt / 6 * (k1d + 2 * k2d + 2 * k3d + k4d)
        omega = omega + dt / 6 * (k1o + 2 * k2o + 2 * k3o + k4o)
        t += dt

    result = {"stable": not unstable}
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

    def variant(ybus, active, grounded, shunt=None, pm_over=None):
        Yred, R, keep = _reduce(ybus, load_shunt if shunt is None else shunt,
                                machines, active, grounded)
        Pm = np.array([machines[i]["Pm"] if (pm_over is None or i not in pm_over)
                       else pm_over[i] for i in range(len(machines))])
        return {"Yred": Yred, "active": active, "R": R, "keep_bus": keep, "Pm": Pm}

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
        post_v = variant(base_ybus, all_active, set(), shunt=shunt2)
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

    t_end = float(disturbance.get("t_end_s", 5.0))
    # Step from the stiffest finite machine, bounded for accuracy/speed.
    hmin = min((m["H"] for m in machines if not m["infinite"]), default=4.0)
    dt = float(disturbance.get("dt_s", 0)) or max(min(0.005, hmin / 400.0), 0.0005)

    segments, event = _build_segments(project, ctx, lf, machines, disturbance, warnings)
    sim = _simulate(machines, segments, freq, t_end, dt, record=True)

    # Critical clearing time (binary search) for a fault, when requested.
    cct = None
    if disturbance.get("type") == "fault" and disturbance.get("find_cct", True):
        cct = _find_cct(project, ctx, lf, machines, disturbance, freq, t_end, dt, warnings)

    mach_out = []
    for j, mac in enumerate(machines):
        traj_delta = sim["curves"]["delta_deg"][j] if sim.get("curves") else []
        peak = max((abs(v) for v in traj_delta), default=0.0)
        mach_out.append({
            "name": mac["name"], "bus": _bus_name(project, mac["bus_id"]),
            "type": "infinite_bus" if mac["infinite"] else "generator",
            "h_s": round(mac["H"], 3), "pm_pu": round(mac["Pm"], 4),
            "e_pu": round(mac["E"], 4), "delta0_deg": round(math.degrees(mac["delta0"]), 2),
            "peak_angle_deg": round(peak, 1),
        })

    return {
        "machines": mach_out,
        "curves": _curves_with_names(sim["curves"], project, machines, ctx),
        "stable": sim["stable"],
        "event": event,
        "cct_s": round(cct, 4) if cct is not None else None,
        "dt_s": dt, "t_end_s": t_end,
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


def _find_cct(project, ctx, lf, machines, disturbance, freq, t_end, dt, warnings):
    """Binary-search the critical clearing time for a bolted fault."""
    lo, hi = 0.0, CCT_SEARCH_MAX

    def stable_for(tc):
        d = dict(disturbance)
        d["clear_time_s"] = tc
        try:
            segs, _ = _build_segments(project, ctx, lf, machines, d, warnings)
        except ValueError:
            return None
        return _simulate(machines, segs, freq, t_end, dt, record=False)["stable"]

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
