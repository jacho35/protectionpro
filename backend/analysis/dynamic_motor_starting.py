"""Dynamic Motor Starting (time-domain acceleration) analysis.

For each motor, simulates the acceleration transient by integrating the
mechanical swing equation

    2H · dω/dt = T_e(V, s) − T_L(ω)          (per-unit on the motor base)

against a Thevenin equivalent of the supply network at the motor's bus.
This extends the static locked-rotor voltage-dip study (motor_starting.py)
with speed / current / torque / voltage trajectories, acceleration time,
stall detection and a rotor-thermal (I²t) check per IEEE 3002.7 methodology.

Motor electrical model
----------------------
Single-cage induction machine reduced to a series equivalent with a shunt
magnetizing branch, fitted from nameplate data:

    Y_in(s) = 1/(jX_m) + 1/(R1 + R2(s)/s + jX)

    R2(s) = R2_run + (R2_start − R2_run)·s     (linear deep-bar variation)

The fit anchors the curve at the two points the nameplate actually
specifies: locked rotor (I = LRC·FLC and T = LRT·FLT at s = 1) and the
rated operating point (T = FLT at s = s_rated). R2_start comes from the
locked-rotor torque, X from the locked-rotor current (with the magnetizing
branch included in the fit), and R2_run from the rated-point torque
quadratic. Torque between the anchor points (e.g. breakdown) is a model
prediction and is reported so the user can compare it with the datasheet.

Air-gap torque (per-unit on T_base = S_base/ω_sync):

    T_e = |I2|² · R2(s)/s        with  I2 = V_m / (R1 + R2(s)/s + jX)

Synchronous motors are simulated through their amortisseur (damper) cage
like an induction machine, with the damper curve fitted at an assumed
rated-point slip of 5 %; the start is declared successful at 95 % speed
(pull-in by excitation is assumed from there).

Network model
-------------
V_bus(t) = V_pre − Z_th·I_line(t): the classic superposition hand method.
V_pre is the pre-start bus voltage from a baseline load flow with the
starting motor switched off; Z_th is the parallel combination of all
non-motor source paths from the IEC 60909 fault-path walker evaluated at
c = 1.0 (operating voltage, not the worst-case fault factor).

Starting methods
----------------
DOL, star-delta (Y_in/3, T/3, changeover at a speed threshold),
autotransformer (80 % tap, changeover at the same threshold), soft starter
(voltage ramp + current limit via firing-angle reduction). VFD starts are
not simulated dynamically — the drive controls the trajectory and holds
line current near FLC.
"""

import math
import numpy as np
from ..models.schemas import ProjectData
from .network_reduction import build_port_zbus

# ── Simulation constants ────────────────────────────────────────────────
MAX_RECORD_POINTS = 400      # decimated output arrays
STALL_HOLD_S = 0.5           # dω/dt ≤ 0 sustained this long ⇒ stalled
SYNC_PULLIN_SPEED = 0.95     # sync motors: damper start succeeds at 95 %
MAGNETIZING_I_PU = 0.30      # assumed no-load magnetizing current (×FLC)
R1_TO_R2S = 0.5              # assumed stator/locked-rotor resistance ratio
AUTO_TX_TAP = 0.8            # autotransformer starter tap (matches static)

_STARTER_LABELS = {
    "dol": "Direct-on-Line",
    "star_delta": "Star-Delta",
    "autotransformer": "Autotransformer (80% tap)",
    "soft_starter": "Soft Starter",
    "vfd": "VFD",
}


# ── Nameplate → equivalent circuit fit ──────────────────────────────────

class MotorModel:
    """Per-unit single-cage model on the motor's own MVA/voltage base."""

    def __init__(self, r1, r2_start, r2_run, x, xm, s_rated, t_fl_pu, h_s):
        self.r1 = r1
        self.r2_start = r2_start
        self.r2_run = r2_run
        self.x = x
        self.xm = xm
        self.s_rated = s_rated
        self.t_fl_pu = t_fl_pu   # full-load torque, pu of S_base/ω_sync
        self.h_s = h_s           # inertia constant (s) on S_base

    def r2(self, s):
        return self.r2_run + (self.r2_start - self.r2_run) * s

    def rotor_z(self, s):
        s = max(s, 1e-6)
        return complex(self.r1 + self.r2(s) / s, self.x)

    def y_in(self, s):
        """Total input admittance (magnetizing + rotor branch)."""
        return 1.0 / complex(0.0, self.xm) + 1.0 / self.rotor_z(s)

    def torque(self, v_pu, s):
        """Air-gap torque (pu of T_base) at winding voltage v_pu, slip s."""
        s = max(s, 1e-6)
        i2 = v_pu / abs(self.rotor_z(s))
        return i2 * i2 * self.r2(s) / s

    def current(self, v_pu, s):
        """Total input current magnitude (pu of rated current base)."""
        return abs(v_pu * self.y_in(s))


def _rated_slip(rpm, freq_hz):
    """Rated slip from nameplate speed and the nearest synchronous speed."""
    if rpm <= 0 or freq_hz <= 0:
        return 0.02
    pole_pairs = max(1, round(60.0 * freq_hz / rpm))
    ns = 60.0 * freq_hz / pole_pairs
    s = 1.0 - rpm / ns
    return min(max(s, 0.002), 0.25)


def _fit_motor_model(m_i, t_lr_pu, t_fl_pu, s_rated, h_s, warnings, name):
    """Fit R1, R2(s), X, Xm from nameplate points. All pu on motor base.

    m_i:     locked-rotor current multiple (×FLC)
    t_lr_pu: locked-rotor torque, pu of T_base
    t_fl_pu: full-load torque, pu of T_base
    """
    xm = 1.0 / MAGNETIZING_I_PU

    # Solve for the rotor-branch impedance magnitude at s=1 such that the
    # TOTAL current (rotor + magnetizing) equals the nameplate LRC. The
    # torque anchor fixes R2_start = T_LR·|Zr(1)|². Bisection on |Zr(1)|.
    def eval_zr1(zr1_mag):
        r2s = t_lr_pu * zr1_mag * zr1_mag
        r1 = R1_TO_R2S * r2s
        x2 = zr1_mag * zr1_mag - (r1 + r2s) ** 2
        if x2 <= 0:
            return None
        x = math.sqrt(x2)
        y_tot = 1.0 / complex(0.0, xm) + 1.0 / complex(r1 + r2s, x)
        return (r1, r2s, x, abs(y_tot))

    lo, hi = 0.5 / m_i, 2.0 / m_i
    fit = None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        res = eval_zr1(mid)
        if res is None:
            # X² went negative — R2_start = T_LR·|Zr|² has outgrown |Zr|
            # (high-LRT machine); shrink the impedance
            hi = mid
            continue
        fit = res
        # |Y| decreases as |Zr| grows: too much current ⇒ larger impedance
        if res[3] > m_i:
            lo = mid
        else:
            hi = mid
    if fit is None:
        raise ValueError("locked-rotor torque/current combination is not "
                         "physically realizable")
    r1, r2_start, x, i_model = fit
    if abs(i_model - m_i) / m_i > 0.02:
        warnings.append(
            f"Motor '{name}': locked-rotor fit converged to "
            f"{i_model:.2f}×FLC vs nameplate {m_i:.2f}×FLC.")

    # Rated-point fit: T_e(s_rated) = T_FL at V = 1 with R2 = R2_run.
    # Let a = R2_run/s_rated:  T_fl·((R1+a)² + X²) = a
    A = t_fl_pu
    B = 2.0 * t_fl_pu * r1 - 1.0
    C = t_fl_pu * (r1 * r1 + x * x)
    disc = B * B - 4.0 * A * C
    if disc <= 0:
        warnings.append(
            f"Motor '{name}': rated point unreachable with the fitted "
            f"leakage reactance — using a constant rotor resistance "
            f"(no deep-bar variation).")
        r2_run = r2_start
    else:
        a = (-B + math.sqrt(disc)) / (2.0 * A)  # stable (high R2/s) branch
        # The interpolation R2(s) = R2_run + (R2_start − R2_run)·s must hit
        # the required a·s_rated AT s_rated, so solve for the intercept
        # rather than assigning it directly.
        r2_req = a * s_rated
        r2_run = (r2_req - r2_start * s_rated) / (1.0 - s_rated)
        if r2_run <= 0:
            r2_run = r2_req  # extreme LRT/slip combination — accept a
            # slight rated-point offset instead of a negative resistance
        if r2_run > r2_start:
            warnings.append(
                f"Motor '{name}': fitted running rotor resistance exceeds "
                f"the locked-rotor value (unusual nameplate combination); "
                f"clamping to a constant rotor resistance.")
            r2_run = r2_start

    return MotorModel(r1, r2_start, r2_run, x, xm, s_rated, t_fl_pu, h_s)


def _estimate_motor_h(p_kw):
    """Inertia constant estimate when no J is supplied.

    Empirical H ≈ 0.12·P_kW^0.15 s — ~0.17 s at 10 kW, ~0.27 s at 200 kW,
    ~0.37 s at 2 MW; typical of standard squirrel-cage machines (motor
    alone, no driven-load inertia).
    """
    return 0.12 * max(p_kw, 1.0) ** 0.15


# ── Load torque models ──────────────────────────────────────────────────

def _load_torque_fn(model, t_load_rated, breakaway_frac, omega_rated):
    """Return T_L(ω) in pu of T_base."""
    model = (model or "quadratic").lower()
    b = min(max(breakaway_frac, 0.0), 1.0)

    def quadratic(w):
        r = min(w / omega_rated, 1.5)
        return t_load_rated * (b + (1.0 - b) * r * r)

    def linear(w):
        r = min(w / omega_rated, 1.5)
        return t_load_rated * (b + (1.0 - b) * r)

    def constant(w):
        return t_load_rated

    return {"quadratic": quadratic, "linear": linear,
            "constant": constant}.get(model, quadratic)


# ── Network helpers (shared conventions with motor_starting.py) ─────────

TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester"}


def _build_adjacency(project):
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append((w.toComponent, w))
        adj.setdefault(w.toComponent, []).append((w.fromComponent, w))
    return adj


def _find_motor_bus(motor_id, adj, comp_map):
    visited = {motor_id}
    stack = [nid for nid, _ in adj.get(motor_id, [])]
    while stack:
        nid = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type == "bus":
            return nid
        if comp.type in TRANSPARENT_TYPES:
            for next_id, _ in adj.get(nid, []):
                if next_id not in visited:
                    stack.append(next_id)
    return None


def _thevenin_at_bus(project, bus_id, exclude_motor_ids):
    """Thevenin impedance (complex, pu on system base at the bus voltage
    zone) from all non-motor source paths, evaluated at c = 1.0."""
    from .fault import _collect_source_paths, _parallel_impedances

    components = {c.id: c for c in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(
            (w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append(
            (w.fromComponent, w.toPort, w.fromPort))

    paths = _collect_source_paths(bus_id, components, adjacency,
                                  project.baseMVA, c=1.0)
    keep = [p for p in paths
            if not p.get("is_motor")
            and p.get("source_type") not in ("motor_induction",
                                             "motor_synchronous")
            and p.get("source_id") not in exclude_motor_ids]
    if not keep:
        return None
    return _parallel_impedances([p["z_total"] for p in keep])


def _baseline_voltages(project, motor_ids_off, warnings):
    """Pre-start bus voltages from ONE baseline load flow.

    Every staged ('starts') motor is switched off (demand_factor = 0) so the
    network is at its cold, pre-sequence operating point; any 'running' motor
    keeps its demand. Returns {bus_id: |V| p.u.} (synthetic load buses included
    so a motor's own terminal bus is present). Empty dict if the flow fails —
    callers then assume 1.0 p.u.
    """
    from .loadflow import run_load_flow
    import json

    data = json.loads(project.model_dump_json())
    baseline = ProjectData(**data)
    off = set(motor_ids_off)
    for c in baseline.components:
        if c.id in off:
            c.props["demand_factor"] = 0.0
    for method in ("newton_raphson", "gauss_seidel"):
        try:
            lf = run_load_flow(baseline, method, include_synthetic=True)
        except Exception:
            continue
        if lf.converged:
            return {bid: b.voltage_pu for bid, b in lf.buses.items()}
    warnings.append("Baseline load flow did not converge — assuming 1.00 p.u. "
                    "pre-start bus voltages.")
    return {}




# ── Per-motor preparation (nameplate → model, base quantities, options) ──

def _prepare_unit(motor, comp_map, adj, freq, project, analysis_warnings,
                  schedule_override=None):
    """Fit the machine model and gather everything the coupled simulation
    needs for one motor. Returns a "unit" dict, ``{"passthrough": result}`` for
    a motor that is reported without simulating (VFD), or ``None`` to skip.

    ``schedule_override`` (when given) is a ``{motor_id: {"role","start_time_s"}}``
    map from the start-timeline editor; it supersedes the motor's own props."""
    mp = motor.props
    is_sync = motor.type == "motor_synchronous"
    name = mp.get("name", motor.id)
    warnings = []

    voltage_kv = float(mp.get("voltage_kv", 0))
    pf = float(mp.get("power_factor", 0.9 if is_sync else 0.85))
    m_i = float(mp.get("locked_rotor_current", 5.5 if is_sync else 6.0))
    method = str(mp.get("starting_method", "dol")).lower()
    method_label = _STARTER_LABELS.get(method, _STARTER_LABELS["dol"])
    if method not in _STARTER_LABELS:
        method = "dol"

    # Staging: when this motor energises on the shared timeline, and whether it
    # is a staged start or an already-running background load. The start-timeline
    # editor (if used) overrides the motor's own dyn_role / start_time_s props.
    sched = (schedule_override or {}).get(motor.id) or {}
    role = str(sched.get("role", mp.get("dyn_role", "starts"))).lower()
    if role not in ("starts", "running"):
        role = "starts"
    start_time = max(0.0, float(sched.get("start_time_s",
                                          mp.get("start_time_s", 0)) or 0))
    if role == "running":
        start_time = 0.0

    # Ratings and base quantities
    if is_sync:
        rated_kva = float(mp.get("rated_kva", 0))
        if rated_kva <= 0 or voltage_kv <= 0:
            analysis_warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
            return None
        s_base_mva = rated_kva / 1000.0
        p_shaft_kw = rated_kva * pf
    else:
        rated_kw = float(mp.get("rated_kw", 0))
        eff = float(mp.get("efficiency", 0.93))
        if rated_kw <= 0 or voltage_kv <= 0 or eff <= 0 or pf <= 0:
            analysis_warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
            return None
        s_base_mva = rated_kw / (eff * pf) / 1000.0
        p_shaft_kw = rated_kw
    flc_a = s_base_mva * 1000.0 / (math.sqrt(3) * voltage_kv)

    terminal_bus = _find_motor_bus(motor.id, adj, comp_map)
    terminal_bus_name = ""
    bus_kv = voltage_kv
    if terminal_bus and terminal_bus in comp_map:
        terminal_bus_name = comp_map[terminal_bus].props.get("name", terminal_bus)
        bus_kv = float(comp_map[terminal_bus].props.get("voltage_kv", voltage_kv))
    if not terminal_bus:
        analysis_warnings.append(f"Motor '{name}' is not connected to a bus, skipped.")
        return None

    if method == "vfd":
        return {"passthrough": {
            "motor_id": motor.id, "motor_name": name,
            "terminal_bus": terminal_bus_name,
            "motor_type": "synchronous" if is_sync else "induction",
            "starting_method": method_label,
            "start_time_s": round(start_time, 2), "role": role,
            "status": "not_simulated", "issues": [],
            "note": ("VFD start — the drive controls the acceleration ramp and "
                     "holds line current near full-load current "
                     f"(≈ {flc_a:.0f} A); no network transient to simulate."),
        }}

    # Nameplate speed / slip and torque base
    default_rpm = (60.0 * freq / 2.0) if is_sync else (60.0 * freq / 2.0 * 0.9867)
    rpm = float(mp.get("rated_speed_rpm", 0) or 0)
    if rpm <= 0:
        rpm = round(default_rpm)
        warnings.append(f"Rated speed not set — assuming {rpm:.0f} rpm.")
    if is_sync:
        s_rated = 0.05  # damper-cage fit; the machine itself runs synchronously
    else:
        s_rated = _rated_slip(rpm, freq)
    pole_pairs = max(1, round(60.0 * freq / rpm))
    ns_rpm = 60.0 * freq / pole_pairs
    omega_sync = 2.0 * math.pi * ns_rpm / 60.0  # mechanical rad/s

    # Full-load torque, pu of T_base = S_base/ω_sync
    if is_sync:
        t_fl_pu = pf  # shaft P = S·pf at ω = ω_sync
    else:
        eff = float(mp.get("efficiency", 0.93))
        t_fl_pu = (eff * pf) / (1.0 - s_rated)
    t_fl_nm = t_fl_pu * s_base_mva * 1e6 / omega_sync

    lrt_pct = float(mp.get("locked_rotor_torque_pct", 120 if is_sync else 150))
    t_lr_pu = lrt_pct / 100.0 * t_fl_pu

    # Inertia
    j_motor = float(mp.get("motor_j_kgm2", 0) or 0)
    j_load = float(mp.get("load_j_kgm2", 0) or 0)
    if j_motor <= 0:
        h_motor = _estimate_motor_h(p_shaft_kw)
        j_motor = 2.0 * h_motor * s_base_mva * 1e6 / (omega_sync ** 2)
        warnings.append(
            f"Motor inertia not set — estimated J ≈ {j_motor:.2f} kg·m² "
            f"(H ≈ {h_motor:.2f} s).")
    j_total = j_motor + j_load
    h_s = 0.5 * j_total * omega_sync ** 2 / (s_base_mva * 1e6)

    try:
        model = _fit_motor_model(m_i, t_lr_pu, t_fl_pu, s_rated, h_s, warnings, name)
    except ValueError as e:
        analysis_warnings.append(f"Motor '{name}': {e} — skipped.")
        return None

    # Derived torque-curve check (breakdown prediction at V = 1)
    bdt_pu, bdt_slip = 0.0, 1.0
    for i in range(1, 201):
        s_i = i / 200.0
        t_i = model.torque(1.0, s_i)
        if t_i > bdt_pu:
            bdt_pu, bdt_slip = t_i, s_i

    # Load torque
    load_pct = float(mp.get("load_torque_pct", 90))
    breakaway = float(mp.get("load_breakaway_pct", 10)) / 100.0
    load_model = str(mp.get("load_torque_model", "quadratic"))
    omega_rated = 1.0 - s_rated
    load_fn = _load_torque_fn(load_model, load_pct / 100.0 * t_fl_pu,
                              breakaway, omega_rated)

    return {
        "motor_id": motor.id, "motor_name": name, "is_sync": is_sync,
        "terminal_bus": terminal_bus, "terminal_bus_name": terminal_bus_name,
        "method": method, "method_label": method_label,
        "model": model, "load_fn": load_fn,
        "s_rated": s_rated, "omega_rated": omega_rated,
        "flc_a": flc_a, "s_base_mva": s_base_mva,
        "voltage_kv": voltage_kv, "bus_kv": bus_kv, "m_i": m_i,
        "stall_time_hot": float(mp.get("stall_time_hot_s", 15)),
        "start_time": start_time, "role": role,
        # System→motor admittance base factor: Y_sys = Y_motor · y_base_factor
        # (so Z_sys·Y_sys = z_motor·y_motor, the base-invariant divider product).
        "y_base_factor": (s_base_mva / project.baseMVA) * (bus_kv / voltage_kv) ** 2,
        "warnings": warnings,
        "opts": {
            "t_max_s": float(mp.get("sim_t_max_s", 30)),
            "transition_speed_pct": float(mp.get("transition_speed_pct", 80)),
            "ss_current_limit_xflc": float(mp.get("ss_current_limit_xflc", 3.5)),
            "ss_ramp_s": float(mp.get("ss_ramp_s", 10)),
            "ss_initial_v_pct": float(mp.get("ss_initial_v_pct", 30)),
        },
        "model_dict": {
            "r1_pu": round(model.r1, 5), "r2_start_pu": round(model.r2_start, 5),
            "r2_run_pu": round(model.r2_run, 5), "x_pu": round(model.x, 5),
            "xm_pu": round(model.xm, 4), "s_rated": round(s_rated, 4),
            "sync_speed_rpm": round(ns_rpm, 1), "t_fl_nm": round(t_fl_nm, 1),
            "t_fl_pu": round(t_fl_pu, 4), "lrt_x_flt": round(lrt_pct / 100.0, 2),
            "bdt_derived_x_flt": round(bdt_pu / t_fl_pu, 2),
            "bdt_slip": round(bdt_slip, 3),
            "j_total_kgm2": round(j_total, 2), "h_total_s": round(h_s, 3),
        },
    }


# ── Starter electrical model (bus-referred, on the motor base) ──────────

def _soft_alpha(unit, s, v_bus, t):
    """Soft-starter voltage fraction α: the smaller of the time ramp and the
    fraction that holds line current at the current limit for the given bus
    voltage (line current in ×FLC = α·|V_bus·Y_m|)."""
    o = unit["opts"]
    ramp = o["ss_ramp_s"]
    v0 = o["ss_initial_v_pct"] / 100.0
    i_lim = o["ss_current_limit_xflc"]
    t_local = max(0.0, t - unit["start_time"])
    alpha_ramp = min(1.0, v0 + (1.0 - v0) * (t_local / ramp if ramp > 0 else 1.0))
    denom = abs(v_bus * unit["model"].y_in(s))
    alpha_lim = (i_lim / denom) if denom > 1e-9 else 1.0
    return max(0.0, min(alpha_ramp, alpha_lim))


def _unit_y_eff_motorbase(unit, s, v_bus, t):
    """Effective admittance the terminal BUS sees (motor base, complex)."""
    y_m = unit["model"].y_in(s)
    method = unit["method"]
    if method == "star_delta" and unit["in_reduced"]:
        return y_m / 3.0
    if method == "autotransformer" and unit["in_reduced"]:
        return y_m * AUTO_TX_TAP * AUTO_TX_TAP
    if method == "soft_starter":
        alpha = _soft_alpha(unit, s, v_bus, t)
        unit["_alpha"] = alpha
        return alpha * y_m
    return y_m  # DOL, or star-delta/auto-tx after changeover


def _unit_electrical(unit, s, v_bus, t):
    """(air-gap torque pu, line current ×FLC, motor winding voltage pu) at the
    given terminal-bus voltage magnitude. Line current = |V_bus·Y_eff|."""
    m = unit["model"]
    y_m = m.y_in(s)
    method = unit["method"]
    if method == "star_delta" and unit["in_reduced"]:
        return m.torque(v_bus, s) / 3.0, abs(v_bus * y_m / 3.0), v_bus / math.sqrt(3.0)
    if method == "autotransformer" and unit["in_reduced"]:
        a = AUTO_TX_TAP
        v_m = a * v_bus
        return m.torque(v_m, s), abs(v_bus * y_m * a * a), v_m
    if method == "soft_starter":
        alpha = unit.get("_alpha", 1.0)
        v_m = alpha * v_bus
        return m.torque(v_m, s), abs(v_m * y_m), v_m
    return m.torque(v_bus, s), abs(v_bus * y_m), v_bus


# ── Coupled shared-timeline simulation ──────────────────────────────────

def _decimate(arrays, n_pts):
    """Decimate each list in ``arrays`` to ≤ MAX_RECORD_POINTS, always keeping
    the final sample. All arrays share the same stride."""
    if n_pts <= MAX_RECORD_POINTS:
        return arrays
    stride = -(-n_pts // MAX_RECORD_POINTS)  # ceil
    keep = list(range(0, n_pts - 1, stride)) + [n_pts - 1]
    return [[a[i] for i in keep] for a in arrays]


def _simulate_sequence(units, zres, v_pre_by_bus, base_mva, bus_name_of, warnings):
    """Integrate every motor on ONE shared timeline against the multi-port
    Thevenin network so staged / overlapping starts sag each other's voltage.

    The coupled network is a linear complex solve each step — motor admittance
    Y(s) is independent of voltage, so with the diagonal load-admittance matrix
    D (motors, base-converted) the port voltages satisfy (I + Z·D)·V = V_pre.
    """
    if zres is not None:
        ports = zres["ports"]
        Z = zres["Z"]
        Imat = np.eye(len(ports), dtype=complex)
    else:
        ports = list(dict.fromkeys(u["terminal_bus"] for u in units))
        Z = None
        Imat = None
    port_of = {b: i for i, b in enumerate(ports)}
    npv = len(ports)
    Vpre = np.array([complex(v_pre_by_bus.get(b, 1.0) or 1.0, 0.0) for b in ports],
                    dtype=complex)

    any_soft = any(u["method"] == "soft_starter" for u in units)

    # Time step: the stiffest (smallest-H) machine sets it, bounded as before.
    dt = min(u["model"].h_s / 20.0 for u in units)
    dt = max(min(dt, 0.005), 0.0005)

    for u in units:
        u["omega"] = u["omega_rated"] if u["role"] == "running" else 0.0
        u["in_reduced"] = u["method"] in ("star_delta", "autotransformer") \
            and u["role"] != "running"
        u["transition"] = None
        u["finished"] = (u["role"] == "running")
        u["sim_status"] = "running" if u["role"] == "running" else "not_started"
        u["i2t"] = 0.0
        u["stall_timer"] = 0.0
        u["accel_time"] = None
        u["port"] = port_of.get(u["terminal_bus"], -1)
        u["_alpha"] = 1.0
        u["rt"], u["rspd"], u["ri"] = [], [], []
        u["rvb"], u["rvm"], u["rte"], u["rtl"] = [], [], [], []

    t_start_max = max(u["start_time"] for u in units)
    t_end = min(300.0, max(u["start_time"] + u["opts"]["t_max_s"] for u in units))

    def energized(u, t):
        return t >= u["start_time"] - 1e-9

    def connected(u, t):
        # Loads the network while energised, unless it has tripped on stall.
        return energized(u, t) and u["sim_status"] != "stalled"

    def solve_V(t, slip_of):
        if Z is None:
            return np.abs(Vpre)
        Vabs = np.abs(Vpre)
        for _ in range(3 if any_soft else 1):
            D = np.zeros(npv, dtype=complex)
            for u in units:
                if u["port"] < 0 or not connected(u, t):
                    continue
                D[u["port"]] += (_unit_y_eff_motorbase(u, slip_of[id(u)],
                                                       float(Vabs[u["port"]]), t)
                                 * u["y_base_factor"])
            try:
                V = np.linalg.solve(Imat + Z * D, Vpre)  # Z*D ≡ Z @ diag(D)
            except np.linalg.LinAlgError:
                V = Vpre
            Vabs = np.abs(V)
        return Vabs

    seq_t = []
    seq_vbus = [[] for _ in range(npv)]
    t = 0.0
    steps = 0

    while t <= t_end + 1e-9:
        slip_now = {id(u): max(1.0 - u["omega"], 1e-6) for u in units}
        Vabs = solve_V(t, slip_now)
        accel = {}
        for u in units:
            vb = float(Vabs[u["port"]]) if (u["port"] >= 0 and npv) else 1.0
            if not energized(u, t):
                u["rt"].append(round(t, 4)); u["rspd"].append(0.0)
                u["ri"].append(0.0); u["rvb"].append(round(vb, 4))
                u["rvm"].append(round(vb, 4)); u["rte"].append(0.0); u["rtl"].append(0.0)
                continue
            s = slip_now[id(u)]
            if connected(u, t):
                t_e, i_line, v_m = _unit_electrical(u, s, vb, t)
            else:
                t_e, i_line, v_m = 0.0, 0.0, vb  # tripped on stall
            t_l = u["load_fn"](u["omega"])
            u["rt"].append(round(t, 4)); u["rspd"].append(round(u["omega"] * 100.0, 2))
            u["ri"].append(round(i_line, 3)); u["rvb"].append(round(vb, 4))
            u["rvm"].append(round(v_m, 4)); u["rte"].append(round(t_e, 4))
            u["rtl"].append(round(t_l, 4))
            if u["finished"]:
                continue
            accel[id(u)] = (t_e - t_l) / (2.0 * u["model"].h_s)
            u["i2t"] += i_line * i_line * dt
            if u["in_reduced"] and u["omega"] >= u["opts"]["transition_speed_pct"] / 100.0:
                u["in_reduced"] = False
                u["transition"] = {"t_s": round(t - u["start_time"], 3),
                                   "speed_pct": round(u["omega"] * 100.0, 1)}

        seq_t.append(round(t, 4))
        for p in range(npv):
            seq_vbus[p].append(round(float(Vabs[p]), 4))

        # Termination per still-accelerating unit
        for u in units:
            if u["finished"] or not energized(u, t):
                continue
            omega = u["omega"]; a = accel.get(id(u), 0.0)
            omega_rated = u["omega_rated"]
            target = SYNC_PULLIN_SPEED if u["is_sync"] else omega_rated
            done = False
            if u["is_sync"] and omega >= SYNC_PULLIN_SPEED:
                done = True
            elif (not u["is_sync"]) and omega >= 0.999 * omega_rated:
                done = True
            elif (not u["is_sync"]) and omega > 0.5 * omega_rated and abs(a) < 1e-4 \
                    and u["rte"][-1] >= u["rtl"][-1]:
                done = True
            if done:
                u["sim_status"] = "started"; u["finished"] = True
                u["accel_time"] = t - u["start_time"]
                continue
            if a <= 0.0 and omega < 0.9 * target:
                u["stall_timer"] += dt
                if u["stall_timer"] >= STALL_HOLD_S:
                    u["sim_status"] = "stalled"; u["finished"] = True
            else:
                u["stall_timer"] = 0.0
            if not u["finished"] and (t - u["start_time"]) >= u["opts"]["t_max_s"]:
                u["sim_status"] = "not_started"; u["finished"] = True

        if all(u["finished"] for u in units) and t >= t_start_max - 1e-9:
            break

        # RK2 midpoint: advance the accelerating units together
        integ = [u for u in units
                 if energized(u, t) and not u["finished"] and u["role"] != "running"]
        if integ:
            omega_mid, slip_mid = {}, {}
            for u in units:
                om = u["omega"]
                if u in integ:
                    om = min(max(u["omega"] + 0.5 * dt * accel.get(id(u), 0.0), 0.0), 1.0)
                omega_mid[id(u)] = om
                slip_mid[id(u)] = max(1.0 - om, 1e-6)
            Vmabs = solve_V(t + 0.5 * dt, slip_mid)
            for u in integ:
                vb = float(Vmabs[u["port"]]) if (u["port"] >= 0 and npv) else 1.0
                t_e2, _, _ = _unit_electrical(u, slip_mid[id(u)], vb, t + 0.5 * dt)
                a2 = (t_e2 - u["load_fn"](omega_mid[id(u)])) / (2.0 * u["model"].h_s)
                u["omega"] = min(max(u["omega"] + dt * a2, 0.0), 1.0)

        t += dt
        steps += 1
        if steps > 200000:
            warnings.append("Dynamic sequence hit the step cap — window truncated.")
            break

    # ── Post-processing: per-motor results ──
    results = []
    for u in units:
        n_pts = len(u["rt"])
        rt, rspd, ri, rvb, rvm, rte, rtl = _decimate(
            [u["rt"], u["rspd"], u["ri"], u["rvb"], u["rvm"], u["rte"], u["rtl"]], n_pts)
        curves = {
            "t": rt, "speed_pct": rspd, "current_xflc": ri,
            "v_bus_pu": rvb, "v_motor_pu": rvm, "te_pu": rte, "tl_pu": rtl,
            "current_a": [round(i * u["flc_a"], 1) for i in ri],
        }

        v_pre = v_pre_by_bus.get(u["terminal_bus"], 1.0) or 1.0
        # Metrics over the motor's own energised window (ignore the pre-start
        # flat segment so peak current / dip reflect the actual start).
        act = [k for k, tv in enumerate(u["rt"]) if tv >= u["start_time"] - 1e-9]
        peak_i = max((u["ri"][k] for k in act), default=0.0)
        min_v_bus = min((u["rvb"][k] for k in act), default=1.0)
        min_v_motor = min((u["rvm"][k] for k in act), default=1.0)
        max_dip_pct = (v_pre - min_v_bus) / v_pre * 100.0 if v_pre > 0 else 0.0

        thermal_capacity = u["m_i"] * u["m_i"] * u["stall_time_hot"]
        thermal_used_pct = (u["i2t"] / thermal_capacity * 100.0
                            if thermal_capacity > 0 else 0.0)
        final_speed_pct = u["omega"] * 100.0

        issues = []
        if u["sim_status"] == "stalled":
            issues.append(f"Motor stalls at {final_speed_pct:.0f}% speed — "
                          f"accelerating torque falls below load torque.")
        elif u["sim_status"] == "not_started":
            issues.append(f"Motor did not reach full speed within the "
                          f"{u['opts']['t_max_s']:.0f} s simulation window.")
        if min_v_motor < 0.8:
            issues.append(f"Motor terminal voltage drops to {min_v_motor:.3f} p.u. "
                          f"(< 0.80 p.u.) during start.")
        if thermal_used_pct > 100.0:
            issues.append(f"Start consumes {thermal_used_pct:.0f}% of the rotor "
                          f"thermal withstand (I²t vs {u['stall_time_hot']:.0f} s "
                          f"hot stall time) — risk of rotor overheating.")
        elif thermal_used_pct > 80.0:
            issues.append(f"Start consumes {thermal_used_pct:.0f}% of the rotor "
                          f"thermal withstand — marginal for repeated starts.")

        if u["sim_status"] in ("stalled", "not_started") or thermal_used_pct > 100.0:
            status = "fail"
        elif u["role"] == "running":
            status = "pass"
        elif issues:
            status = "warning"
        else:
            status = "pass"

        # Self-impedance (motor base) and short-circuit level for the disclosure
        if Z is not None and u["port"] >= 0:
            z_ii_sys = Z[u["port"], u["port"]]
            z_th_m = z_ii_sys * u["y_base_factor"]
            sc_mva = (base_mva / abs(z_ii_sys)) if abs(z_ii_sys) > 1e-9 else None
        else:
            z_th_m = complex(0.0, 0.0)
            sc_mva = None

        model_dict = dict(u["model_dict"])
        model_dict["thevenin_r_pu"] = round(z_th_m.real, 5)
        model_dict["thevenin_x_pu"] = round(z_th_m.imag, 5)
        model_dict["sc_mva_at_bus"] = round(sc_mva, 1) if sc_mva else None

        results.append({
            "motor_id": u["motor_id"], "motor_name": u["motor_name"],
            "terminal_bus": u["terminal_bus_name"],
            "motor_type": "synchronous" if u["is_sync"] else "induction",
            "starting_method": u["method_label"],
            "start_time_s": round(u["start_time"], 2), "role": u["role"],
            "status": status, "sim_status": u["sim_status"],
            "accel_time_s": round(u["accel_time"], 3) if u["accel_time"] is not None else None,
            "final_speed_pct": round(final_speed_pct, 1),
            "flc_a": round(u["flc_a"], 1),
            "peak_current_a": round(peak_i * u["flc_a"], 1),
            "peak_current_xflc": round(peak_i, 2),
            "v_prestart_pu": round(v_pre, 4),
            "min_v_bus_pu": round(min_v_bus, 4),
            "min_v_motor_pu": round(min_v_motor, 4),
            "max_bus_dip_pct": round(max_dip_pct, 2),
            "thermal_used_pct": round(thermal_used_pct, 1),
            "stall_time_hot_s": u["stall_time_hot"],
            "transition": u["transition"],
            "issues": issues, "warnings": u["warnings"],
            "model": model_dict, "curves": curves,
        })

    # ── Sequence overview (shared timeline) ──
    seq_dec = _decimate([seq_t] + seq_vbus, len(seq_t))
    st, sv = seq_dec[0], seq_dec[1:]
    sequence = {
        "t": st,
        "buses": [{"bus": bus_name_of.get(ports[p], ports[p]), "v_pu": sv[p]}
                  for p in range(npv)],
        "schedule": [{"motor": u["motor_name"], "terminal_bus": u["terminal_bus_name"],
                      "start_time_s": round(u["start_time"], 2), "role": u["role"]}
                     for u in units],
        "staggered": len({round(u["start_time"], 3) for u in units
                          if u["role"] == "starts"}) > 1
                     or any(u["role"] == "running" for u in units),
    }
    return results, sequence


# ── Public entry point ──────────────────────────────────────────────────

def run_dynamic_motor_starting(project: ProjectData):
    """Run the dynamic motor starting study for every motor in the project.

    All motors are simulated on ONE shared timeline: each staged motor energises
    at its ``start_time_s`` and the motors interact through a multi-port Thevenin
    equivalent of the network (a motor's inrush sags the bus voltage every other
    energised motor sees). Returns ``{'motors': [...], 'warnings': [...],
    'sequence': {...}}``.
    """
    # A motor wired to its bus through a series feeder cable (or transformer)
    # has no busbar at its own terminal, so the transparent-only bus walk in
    # _find_motor_bus can't reach it and the motor was skipped as "not connected
    # to a bus". Insert a synthetic terminal bus at every such dangling load —
    # exactly as the load-flow / fault engines do — so the feeder becomes a
    # branch and the motor's terminal is a real node (its Thevenin then correctly
    # includes the feeder impedance). Idempotent: motors that already reach a bus
    # (directly or through a CB/switch) and truly isolated motors are untouched.
    from .loadflow import insert_implicit_load_buses
    project = insert_implicit_load_buses(project)

    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)
    freq = float(project.frequency or 50)

    motors = [c for c in project.components
              if c.type in ("motor_induction", "motor_synchronous")]
    if not motors:
        return {"motors": [], "warnings": ["No motors found in the project."]}

    # Optional start-timeline override from the config modal, keyed by motor id.
    schedule_override = {}
    sched = getattr(project, "dynamicMotorSchedule", None)
    if isinstance(sched, dict):
        for row in (sched.get("motors") or []):
            if isinstance(row, dict) and row.get("id"):
                schedule_override[row["id"]] = row

    analysis_warnings = []
    units, passthrough = [], []
    for motor in motors:
        prep = _prepare_unit(motor, comp_map, adj, freq, project,
                             analysis_warnings, schedule_override)
        if prep is None:
            continue
        if "passthrough" in prep:
            passthrough.append(prep["passthrough"])
        else:
            units.append(prep)

    if not units:
        return {"motors": passthrough, "warnings": analysis_warnings, "sequence": None}

    motor_ids_off = [u["motor_id"] for u in units if u["role"] != "running"]
    v_pre_by_bus = _baseline_voltages(project, motor_ids_off, analysis_warnings)

    port_buses = list(dict.fromkeys(u["terminal_bus"] for u in units))
    zres = build_port_zbus(project, port_buses, c=1.0)
    if zres is None:
        analysis_warnings.append(
            "No grounded network source found — motors simulated on an infinite "
            "bus (no voltage dip or inter-motor interaction).")
    bus_name_of = {b: (comp_map[b].props.get("name", b) if b in comp_map else b)
                   for b in port_buses}

    results, sequence = _simulate_sequence(
        units, zres, v_pre_by_bus, project.baseMVA, bus_name_of, analysis_warnings)
    results = results + passthrough

    order = {m.id: i for i, m in enumerate(motors)}
    results.sort(key=lambda r: order.get(r["motor_id"], 1_000_000))
    return {"motors": results, "warnings": analysis_warnings, "sequence": sequence}
