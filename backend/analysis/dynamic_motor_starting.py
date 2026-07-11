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
from ..models.schemas import ProjectData

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


def _prestart_voltage(project, motor_id, bus_id, warnings, name):
    """Pre-start bus voltage: baseline load flow with the motor off."""
    from .loadflow import run_load_flow
    import json

    data = json.loads(project.model_dump_json())
    baseline = ProjectData(**data)
    for c in baseline.components:
        if c.id == motor_id:
            c.props["demand_factor"] = 0.0
    for method in ("newton_raphson", "gauss_seidel"):
        try:
            lf = run_load_flow(baseline, method)
        except Exception:
            continue
        if lf.converged and bus_id in lf.buses:
            return lf.buses[bus_id].voltage_pu
    warnings.append(
        f"Motor '{name}': baseline load flow failed — assuming a 1.00 p.u. "
        f"pre-start bus voltage.")
    return 1.0


# ── The time-domain simulation ──────────────────────────────────────────

def _simulate_start(model, method, v_pre, z_th_m, load_fn, opts):
    """Integrate the swing equation. All electrical quantities pu on the
    motor base; z_th_m is the supply Thevenin impedance on the motor base.

    Returns a dict with trajectories and event/termination data.
    """
    h = model.h_s
    omega_rated = 1.0 - model.s_rated
    t_max = opts["t_max_s"]
    transition_speed = opts["transition_speed_pct"] / 100.0
    dt = max(min(0.005, h / 20.0), 0.0005)

    # Starter state
    in_reduced = method in ("star_delta", "autotransformer")
    transition = None

    def electrical(s, omega, t):
        """Solve the starter/network interaction at slip s, time t.

        Returns (torque_pu, i_line_pu, v_bus_pu, v_motor_pu)."""
        y_m = model.y_in(s)

        if method == "star_delta" and in_reduced:
            # Supply sees one third of the delta admittance; each winding
            # sees V_bus/√3 of its rated voltage → one third of the torque.
            y_eff = y_m / 3.0
            v_bus = abs(v_pre / (1.0 + z_th_m * y_eff))
            t_e = model.torque(v_bus, s) / 3.0
            i_line = abs(v_bus * y_eff)
            return t_e, i_line, v_bus, v_bus / math.sqrt(3.0)

        if method == "autotransformer" and in_reduced:
            a = AUTO_TX_TAP
            y_eff = y_m * a * a
            v_bus = abs(v_pre / (1.0 + z_th_m * y_eff))
            v_m = a * v_bus
            return model.torque(v_m, s), abs(v_bus * y_eff), v_bus, v_m

        if method == "soft_starter":
            ramp = opts["ss_ramp_s"]
            v0 = opts["ss_initial_v_pct"] / 100.0
            alpha_ramp = min(1.0, v0 + (1.0 - v0) * (t / ramp if ramp > 0 else 1.0))
            i_lim = opts["ss_current_limit_xflc"]

            def line_current(alpha):
                return abs(alpha * y_m * v_pre / (1.0 + alpha * z_th_m * y_m))

            alpha = alpha_ramp
            if line_current(alpha) > i_lim:
                lo_a, hi_a = 0.0, alpha_ramp
                for _ in range(40):
                    mid = 0.5 * (lo_a + hi_a)
                    if line_current(mid) > i_lim:
                        hi_a = mid
                    else:
                        lo_a = mid
                alpha = lo_a
            v_bus = abs(v_pre / (1.0 + alpha * z_th_m * y_m))
            v_m = alpha * v_bus
            return model.torque(v_m, s), abs(v_m * y_m), v_bus, v_m

        # DOL (and star-delta / auto-tx after changeover)
        v_bus = abs(v_pre / (1.0 + z_th_m * y_m))
        return model.torque(v_bus, s), abs(v_bus * y_m), v_bus, v_bus

    # Integration loop (RK2 midpoint on ω)
    t, omega = 0.0, 0.0
    times, speeds, currents = [], [], []
    v_buses, v_motors, te_arr, tl_arr = [], [], [], []
    i2t = 0.0                 # ∫ I² dt (pu²·s) up to full speed
    stall_timer = 0.0
    status = "not_started"

    while t <= t_max:
        s = max(1.0 - omega, 1e-6)
        t_e, i_line, v_bus, v_m = electrical(s, omega, t)
        t_l = load_fn(omega)

        # Record every step; decimated to MAX_RECORD_POINTS after the loop
        # (the simulated duration isn't known up front)
        times.append(round(t, 4))
        speeds.append(round(omega * 100.0, 2))
        currents.append(round(i_line, 3))
        v_buses.append(round(v_bus, 4))
        v_motors.append(round(v_m, 4))
        te_arr.append(round(t_e, 4))
        tl_arr.append(round(t_l, 4))

        accel = (t_e - t_l) / (2.0 * h)

        # Starter changeover (star→delta, auto-tx→full voltage)
        if in_reduced and omega >= transition_speed:
            in_reduced = False
            transition = {"t_s": round(t, 3),
                          "speed_pct": round(omega * 100.0, 1)}

        # Termination checks
        target = SYNC_PULLIN_SPEED if opts["is_sync"] else omega_rated
        if opts["is_sync"] and omega >= SYNC_PULLIN_SPEED:
            status = "started"
            break
        if not opts["is_sync"] and omega >= 0.999 * omega_rated:
            status = "started"
            break
        if not opts["is_sync"] and omega > 0.5 * omega_rated and abs(accel) < 1e-4 and t_e >= t_l:
            # Settled at a sub-rated-slip operating point (light load)
            status = "started"
            break
        if accel <= 0.0 and omega < 0.9 * target:
            stall_timer += dt
            if stall_timer >= STALL_HOLD_S:
                status = "stalled"
                break
        else:
            stall_timer = 0.0

        # RK2 midpoint step
        omega_mid = min(max(omega + 0.5 * dt * accel, 0.0), 1.0)
        s_mid = max(1.0 - omega_mid, 1e-6)
        t_e2, i2_line, _, _ = electrical(s_mid, omega_mid, t + 0.5 * dt)
        accel2 = (t_e2 - load_fn(omega_mid)) / (2.0 * h)
        omega = min(max(omega + dt * accel2, 0.0), 1.0)

        i2t += i_line * i_line * dt
        t += dt

    # Final recorded point
    s = max(1.0 - omega, 1e-6)
    t_e, i_line, v_bus, v_m = electrical(s, omega, t)
    times.append(round(t, 4))
    speeds.append(round(omega * 100.0, 2))
    currents.append(round(i_line, 3))
    v_buses.append(round(v_bus, 4))
    v_motors.append(round(v_m, 4))
    te_arr.append(round(t_e, 4))
    tl_arr.append(round(load_fn(omega), 4))

    # Decimate to a bounded payload, always keeping the final point
    n_pts = len(times)
    if n_pts > MAX_RECORD_POINTS:
        stride = -(-n_pts // MAX_RECORD_POINTS)  # ceil division
        keep = list(range(0, n_pts - 1, stride)) + [n_pts - 1]

        def dec(arr):
            return [arr[i] for i in keep]
        times, speeds, currents = dec(times), dec(speeds), dec(currents)
        v_buses, v_motors = dec(v_buses), dec(v_motors)
        te_arr, tl_arr = dec(te_arr), dec(tl_arr)

    return {
        "status": status,
        "accel_time_s": t if status == "started" else None,
        "final_speed_pct": omega * 100.0,
        "transition": transition,
        "i2t_pu2s": i2t,
        "curves": {
            "t": times, "speed_pct": speeds, "current_xflc": currents,
            "v_bus_pu": v_buses, "v_motor_pu": v_motors,
            "te_pu": te_arr, "tl_pu": tl_arr,
        },
    }


# ── Public entry point ──────────────────────────────────────────────────

def run_dynamic_motor_starting(project: ProjectData):
    """Run the dynamic motor starting study for every motor in the project.

    Returns dict with 'motors' list and 'warnings' list.
    """
    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)
    freq = float(project.frequency or 50)

    motors = [c for c in project.components
              if c.type in ("motor_induction", "motor_synchronous")]
    if not motors:
        return {"motors": [], "warnings": ["No motors found in the project."]}

    results = []
    analysis_warnings = []

    for motor in motors:
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

        # Ratings and base quantities
        if is_sync:
            rated_kva = float(mp.get("rated_kva", 0))
            if rated_kva <= 0 or voltage_kv <= 0:
                analysis_warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
                continue
            s_base_mva = rated_kva / 1000.0
            p_shaft_kw = rated_kva * pf
        else:
            rated_kw = float(mp.get("rated_kw", 0))
            eff = float(mp.get("efficiency", 0.93))
            if rated_kw <= 0 or voltage_kv <= 0 or eff <= 0 or pf <= 0:
                analysis_warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
                continue
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
            continue

        if method == "vfd":
            results.append({
                "motor_id": motor.id, "motor_name": name,
                "terminal_bus": terminal_bus_name,
                "motor_type": "synchronous" if is_sync else "induction",
                "starting_method": method_label,
                "status": "not_simulated",
                "issues": [],
                "note": ("VFD start — the drive controls the acceleration "
                         "ramp and holds line current near full-load "
                         f"current (≈ {flc_a:.0f} A); no network transient "
                         "to simulate."),
            })
            continue

        # Nameplate speed / slip and torque base
        default_rpm = (60.0 * freq / 2.0) if is_sync else (60.0 * freq / 2.0 * 0.9867)
        rpm = float(mp.get("rated_speed_rpm", 0) or 0)
        if rpm <= 0:
            rpm = round(default_rpm)
            warnings.append(f"Rated speed not set — assuming {rpm:.0f} rpm.")
        if is_sync:
            # Damper-cage fit uses an assumed 5 % rated-point slip; the
            # machine itself runs synchronously.
            s_rated = 0.05
            pole_pairs = max(1, round(60.0 * freq / rpm))
            ns_rpm = 60.0 * freq / pole_pairs
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

        # Fit the equivalent circuit
        try:
            model = _fit_motor_model(m_i, t_lr_pu, t_fl_pu, s_rated, h_s,
                                     warnings, name)
        except ValueError as e:
            analysis_warnings.append(f"Motor '{name}': {e} — skipped.")
            continue

        # Derived torque curve check (breakdown prediction at V = 1)
        bdt_pu, bdt_slip = 0.0, 1.0
        n_scan = 200
        for i in range(1, n_scan + 1):
            s_i = i / n_scan
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

        # Network Thevenin (system base → motor base)
        v_pre = _prestart_voltage(project, motor.id, terminal_bus, warnings, name)
        z_th_sys = _thevenin_at_bus(project, terminal_bus, {motor.id})
        if z_th_sys is None:
            warnings.append("No network source found — simulating on an "
                            "infinite bus.")
            z_th_m = complex(0.0, 0.0)
        else:
            # Change of base: system base MVA at the bus voltage zone →
            # motor base MVA at the motor rated voltage.
            z_th_m = (z_th_sys * (s_base_mva / project.baseMVA)
                      * (bus_kv / voltage_kv) ** 2)
        sc_mva = (project.baseMVA / abs(z_th_sys)) if z_th_sys and abs(z_th_sys) > 1e-9 else None

        opts = {
            "is_sync": is_sync,
            "t_max_s": float(mp.get("sim_t_max_s", 30)),
            "transition_speed_pct": float(mp.get("transition_speed_pct", 80)),
            "ss_current_limit_xflc": float(mp.get("ss_current_limit_xflc", 3.5)),
            "ss_ramp_s": float(mp.get("ss_ramp_s", 10)),
            "ss_initial_v_pct": float(mp.get("ss_initial_v_pct", 30)),
        }

        sim = _simulate_start(model, method, v_pre, z_th_m, load_fn, opts)

        # Post-processing
        curves = sim["curves"]
        curves["current_a"] = [round(i * flc_a, 1) for i in curves["current_xflc"]]
        peak_i_pu = max(curves["current_xflc"]) if curves["current_xflc"] else 0
        min_v_bus = min(curves["v_bus_pu"]) if curves["v_bus_pu"] else 1.0
        min_v_motor = min(curves["v_motor_pu"]) if curves["v_motor_pu"] else 1.0
        max_dip_pct = (v_pre - min_v_bus) / v_pre * 100.0 if v_pre > 0 else 0.0

        # Rotor thermal check: ∫I²dt against the hot locked-rotor withstand
        stall_time_hot = float(mp.get("stall_time_hot_s", 15))
        thermal_capacity = m_i * m_i * stall_time_hot  # allowed pu²·s
        thermal_used_pct = (sim["i2t_pu2s"] / thermal_capacity * 100.0
                            if thermal_capacity > 0 else 0.0)

        issues = []
        if sim["status"] == "stalled":
            issues.append(
                f"Motor stalls at {sim['final_speed_pct']:.0f}% speed — "
                f"accelerating torque falls below load torque.")
        elif sim["status"] == "not_started":
            issues.append(
                f"Motor did not reach full speed within the "
                f"{opts['t_max_s']:.0f} s simulation window.")
        if min_v_motor < 0.8:
            issues.append(
                f"Motor terminal voltage drops to {min_v_motor:.3f} p.u. "
                f"(< 0.80 p.u.) during start.")
        if thermal_used_pct > 100.0:
            issues.append(
                f"Start consumes {thermal_used_pct:.0f}% of the rotor "
                f"thermal withstand (I²t vs {stall_time_hot:.0f} s hot "
                f"stall time) — risk of rotor overheating.")
        elif thermal_used_pct > 80.0:
            issues.append(
                f"Start consumes {thermal_used_pct:.0f}% of the rotor "
                f"thermal withstand — marginal for repeated starts.")

        if sim["status"] in ("stalled", "not_started") or thermal_used_pct > 100.0:
            status = "fail"
        elif issues:
            status = "warning"
        else:
            status = "pass"

        results.append({
            "motor_id": motor.id,
            "motor_name": name,
            "terminal_bus": terminal_bus_name,
            "motor_type": "synchronous" if is_sync else "induction",
            "starting_method": method_label,
            "status": status,
            "sim_status": sim["status"],
            "accel_time_s": round(sim["accel_time_s"], 3) if sim["accel_time_s"] is not None else None,
            "final_speed_pct": round(sim["final_speed_pct"], 1),
            "flc_a": round(flc_a, 1),
            "peak_current_a": round(peak_i_pu * flc_a, 1),
            "peak_current_xflc": round(peak_i_pu, 2),
            "v_prestart_pu": round(v_pre, 4),
            "min_v_bus_pu": round(min_v_bus, 4),
            "min_v_motor_pu": round(min_v_motor, 4),
            "max_bus_dip_pct": round(max_dip_pct, 2),
            "thermal_used_pct": round(thermal_used_pct, 1),
            "stall_time_hot_s": stall_time_hot,
            "transition": sim["transition"],
            "issues": issues,
            "warnings": warnings,
            "model": {
                "r1_pu": round(model.r1, 5),
                "r2_start_pu": round(model.r2_start, 5),
                "r2_run_pu": round(model.r2_run, 5),
                "x_pu": round(model.x, 5),
                "xm_pu": round(model.xm, 4),
                "s_rated": round(s_rated, 4),
                "sync_speed_rpm": round(ns_rpm, 1),
                "t_fl_nm": round(t_fl_nm, 1),
                "t_fl_pu": round(t_fl_pu, 4),
                "lrt_x_flt": round(lrt_pct / 100.0, 2),
                "bdt_derived_x_flt": round(bdt_pu / t_fl_pu, 2),
                "bdt_slip": round(bdt_slip, 3),
                "j_total_kgm2": round(j_total, 2),
                "h_total_s": round(h_s, 3),
                "thevenin_r_pu": round(z_th_m.real, 5),
                "thevenin_x_pu": round(z_th_m.imag, 5),
                "sc_mva_at_bus": round(sc_mva, 1) if sc_mva else None,
            },
            "curves": curves,
        })

    return {"motors": results, "warnings": analysis_warnings}
