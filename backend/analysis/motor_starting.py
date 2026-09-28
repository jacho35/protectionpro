"""Motor Starting Voltage Dip Analysis.

For each induction motor, simulates the voltage at all buses immediately
after the motor is switched on (locked-rotor condition). Checks whether
voltage dips are within acceptable limits.

Method: Static analysis — model motor as locked-rotor impedance,
re-run load flow, compare bus voltages to pre-start baseline.
"""

import math
from ..models.schemas import ProjectData

# Transparent types that do not form a bus boundary
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}

# Starting-method current-reduction factors applied to the DOL locked-rotor
# current. Reduced-voltage starters draw I_start ∝ (V_applied)², so an 80%
# autotransformer tap gives 0.8² ≈ 0.64. VFDs are handled specially — the
# drive limits supply current to ≈ full-load current during the ramp, so the
# locked-rotor multiple does not apply.
_STARTING_METHODS = {
    "dol":             (1.0,  "Direct-on-Line"),
    "star_delta":      (1.0 / 3.0, "Star-Delta"),
    "autotransformer": (0.64, "Autotransformer (80% tap)"),
    "soft_starter":    (None, "Soft Starter"),   # [MG8] its own current limit
    "vfd":             (None, "VFD"),
}


def starting_current_xflc(props, lrc):
    """Starting line current as a multiple of FLC, and the starter's label —
    shared by motor starting and flicker so the two can never drift.

    [MG8] A soft starter holds line current at its set limit, so the starting
    current IS that limit (never more than the DOL locked-rotor current). It
    was a fixed 0.5 × LRC (3.0 × FLC at LRC 6) whatever ss_current_limit_xflc
    said — and the dynamic study, which honours the setting (default 3.5),
    disagreed out of the box. VFD: the drive holds supply current ≈ FLC."""
    method_key = str(props.get("starting_method", "dol")).lower()
    factor, label = _STARTING_METHODS.get(method_key, _STARTING_METHODS["dol"])
    if method_key == "soft_starter":
        i_lim = float(props.get("ss_current_limit_xflc", 3.5) or 3.5)
        return min(max(i_lim, 0.0), lrc), label
    if factor is None:
        return 1.0, label
    return lrc * factor, label


def bus_voltage_ratio(bus_id, comp_map, motor_kv):
    """[MG9] Bus nominal kV ÷ motor rated kV. A locked rotor is an impedance,
    so at 1.0 p.u. on the BUS a motor rated for a different voltage draws its
    nameplate current × ratio and kVA × ratio² (a 415 V motor on a 400 V bus
    sees 0.964 p.u.). 1.0 when either voltage is unknown."""
    bus = comp_map.get(bus_id) if bus_id else None
    try:
        bus_kv = float(bus.props.get("voltage_kv", 0) or 0) if bus else 0.0
    except (TypeError, ValueError):
        bus_kv = 0.0
    return bus_kv / motor_kv if (bus_kv > 0 and motor_kv > 0) else 1.0


def _build_adjacency(project):
    """Build adjacency map: component_id -> [(neighbor_id, wire)]."""
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append((w.toComponent, w))
        adj.setdefault(w.toComponent, []).append((w.fromComponent, w))
    return adj


def _find_motor_bus(motor_id, adj, comp_map):
    """Walk through transparent devices from motor to find the connected bus.

    [EE-12] Distribution boards count as bus-like terminals — the load flow
    models a board as a busbar node, so a motor wired to one must read its
    terminal voltage there (previously terminal_bus came back None and the
    terminal voltage silently defaulted to 1.0 → false "will start")."""
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
        if comp.type in ("bus", "distribution_board"):
            return nid
        if comp.type in TRANSPARENT_TYPES:
            for next_id, _ in adj.get(nid, []):
                if next_id not in visited:
                    stack.append(next_id)
    return None


# Series elements a disturbance propagates through (besides closed switchgear).
_SERIES_TYPES = {"cable", "transformer", "autotransformer"}


def _galvanic_buses(start_bus, adj, comp_map):
    """[MG7] Every bus/board galvanically connected to ``start_bus``: walk the
    wiring through closed switching devices and series cables/transformers.
    Open CBs/switches bound the walk, as does anything else (sources, loads,
    converters), so a separate island — or a bus behind an open breaker —
    is excluded."""
    from .loadflow import _is_transparent_and_closed
    seen, out = {start_bus}, {start_bus}
    stack = [start_bus]
    while stack:
        nid = stack.pop()
        for nxt, _ in adj.get(nid, []):
            if nxt in seen:
                continue
            comp = comp_map.get(nxt)
            if comp is None:
                continue
            if comp.type in ("bus", "distribution_board"):
                seen.add(nxt); out.add(nxt); stack.append(nxt)
            elif comp.type in _SERIES_TYPES or _is_transparent_and_closed(comp):
                seen.add(nxt); stack.append(nxt)
    return out


def _deep_copy_project(project):
    """Create a deep copy of project data for modification."""
    import json
    data = json.loads(project.model_dump_json())
    return ProjectData(**data)


def _thevenin_z1(project, bus_id, starting_motor_id):
    """[EE-1] Positive-sequence Thevenin impedance at the motor terminal bus,
    INCLUDING the source internal impedance (utility fault level, generator
    X″d) — from the shared fault-path machinery at c = 1.0, motor infeeds
    excluded, meshed topologies solved nodally ([PS-1]). Nameplate
    impedances: the IEC 60909 K_T / K_G short-circuit corrections do not
    apply to a voltage-dip study."""
    from .fault import thevenin_z1_at_bus
    try:
        return thevenin_z1_at_bus(project, bus_id, c=1.0,
                                  exclude_motor_paths=True,
                                  exclude_source_ids={starting_motor_id},
                                  nameplate=True)
    except Exception:
        return None


def _prestart_voltage(project, motor_id, bus_id, fallback):
    """Terminal-bus voltage just before ``motor_id`` starts, i.e. with that
    motor OFF (demand_factor = 0) and everything else as drawn.

    The Thevenin superposition V = V_pre − Z_th·I_start subtracts the full
    starting current, so V_pre must not already carry the same motor's
    running load — that counts the motor twice (the running baseline is
    still the right reference for reporting the dip). Same basis as the
    dynamic engine's _baseline_voltages. Returns ``fallback`` if the flow
    fails."""
    from .loadflow import run_load_flow
    pre_off = _deep_copy_project(project)
    for c in pre_off.components:
        if c.id == motor_id:
            c.props["demand_factor"] = 0.0
    try:
        lf = run_load_flow(pre_off, "newton_raphson", include_synthetic=True)
        if lf.converged and bus_id in lf.buses:
            return lf.buses[bus_id].voltage_pu
    except Exception:
        pass
    return fallback


def _unsolved_start_row(motor, motor_name, terminal_bus, terminal_bus_name,
                        rated_kw, is_sync, method_label, start_current_a, s_start_mva,
                        baseline_voltages, lf_failed, v_est, collapse, kind, start_pf):
    """Result row for a motor whose starting load flow failed or did not run.

    * ``collapse`` → the Thevenin solve found no operating point. Only a
      constant-current (soft starter) or constant-power (VFD) start can do
      that — a locked rotor is an impedance and always has one ([N1]).
      Reported as a stall (terminal V 0.0 p.u.) with ``collapse: True``.
    * ``v_est`` given → the network solve failed for another reason; the
      terminal voltage is the Thevenin estimate (``estimate: True``) and dips
      at other buses are not available.
    """
    what = "failed" if lf_failed else "did not converge"
    s_txt = (f"{s_start_mva * 1000:.0f} kVA" if s_start_mva < 1
             else f"{s_start_mva:.2f} MVA")
    bus_label = terminal_bus_name or terminal_bus or ""
    v_base = baseline_voltages.get(terminal_bus, 1.0) if terminal_bus else 1.0

    if collapse:
        v_term = 0.0
        issues = [
            f"No starting operating point: the {s_txt} starting demand ({method_label}, "
            f"held constant by the starter) is more than the network can supply — "
            f"voltage collapse. The motor will not start {method_label} on this network.",
            "Consider a stronger supply or a lower starter current limit — Dynamic "
            "Motor Starting gives the time-domain check.",
        ]
    elif v_est is not None:
        v_term = v_est
        issues = [f"The network load flow {what} with the motor starting, so dips at "
                  f"other buses were not computed; terminal voltage is the Thevenin "
                  f"estimate only."]
        if v_term < 0.8:
            issues.insert(0, f"Terminal voltage {v_term:.3f} p.u. < 0.80 p.u. — motor "
                             f"may not accelerate")
    else:
        v_term = 0.0
        issues = [f"The network load flow {what} with the motor starting and no "
                  f"source path was found for a Thevenin estimate — no result for "
                  f"this motor. Check the network solves in Load Flow first."]

    has_v = collapse or v_est is not None
    will_start = v_est is not None and v_term >= 0.8
    dip = (v_base - v_term) / v_base * 100 if (has_v and v_base > 0) else 0.0
    if v_est is not None and dip > 15:
        issues.append(f"Max system voltage dip {dip:.1f}% > 15% at {bus_label}")
    status = "fail" if not will_start else "warning"

    return {
        "motor_id": motor.id,
        "motor_name": motor_name,
        "terminal_bus": bus_label,
        "rated_kw": round(rated_kw, 1),
        "motor_type": "synchronous" if is_sync else "induction",
        "starting_method": method_label,
        "start_current_a": round(start_current_a, 1),
        "motor_terminal_voltage_pu": round(v_term, 4),
        "motor_will_start": will_start,
        "max_system_dip_pct": round(dip, 2),
        "max_dip_bus": bus_label if has_v else "",
        "bus_dips": {bus_label: round(dip, 2)} if (bus_label and has_v) else {},
        "status": status,
        "issues": issues,
        "collapse": collapse,
        "estimate": v_est is not None,
        "start_pf": round(start_pf, 3),
        "torque_ok": None,
        "model": _MODEL_LABEL[kind],
    }


# [N2] A VFD's supply current is set by its front end (diode bridge + DC
# link), not by the rotor: displacement pf ≈ 0.95, not a locked rotor's 0.3.
VFD_SUPPLY_PF = 0.95

_MODEL_LABEL = {
    "z": "constant-impedance locked rotor",
    "i": "constant-current starter (current limit)",
    "pq": "constant-power drive (VFD)",
}


def _nameplate_unit(motor, comp_map, adj, project):
    """[N3] The dynamic study's nameplate model for ``motor`` (fitted from
    LRC, LRT, speed; load-torque curve), or None for a VFD / unfittable
    nameplate. Reused so both studies describe the same machine."""
    from .dynamic_motor_starting import _prepare_unit
    if str(motor.props.get("starting_method", "dol")).lower() == "vfd":
        return None
    try:
        u = _prepare_unit(motor, comp_map, adj, float(project.frequency or 50),
                          project, [], None)
    except Exception:
        return None
    if not u or "passthrough" in u:
        return None
    return u


def _locked_rotor_pf(props, unit):
    """[N3] Locked-rotor power factor: the ``locked_rotor_pf`` prop when given
    (datasheet), else from the fitted nameplate model at s = 1
    (P/|S| = Re Y/|Y|), else the old typical 0.3. A fixed 0.3 over-stated the
    reactive draw of small LV motors (typically 0.4–0.5) and under-stated
    large MV ones (0.15–0.2)."""
    try:
        lp = float(props.get("locked_rotor_pf", 0) or 0)
    except (TypeError, ValueError):
        lp = 0.0
    if 0.0 < lp <= 1.0:
        return lp
    if unit is not None:
        y = unit["model"].y_in(1.0)
        if abs(y) > 1e-12:
            return max(0.05, min(1.0, y.real / abs(y)))
    return 0.3


def _solve_start_v(kind, v_pre_pu, z_th, s0):
    """[N1] Terminal |V| of the starting load behind Z_th from V_pre.

    ``s0`` is the starting demand at 1.0 p.u. (system base). Returns None when
    no operating point exists (possible only for 'i' / 'pq').
      z  — constant impedance Y = conj(s0):  V = V_pre / (1 + Z_th·Y)
      i  — constant current |I| = |s0| at the demand's pf, tracking V's angle
      pq — constant power (see _solve_pq_dip)
    """
    if v_pre_pu <= 0 or abs(z_th) < 1e-12:
        return v_pre_pu
    if kind == "z":
        return abs(v_pre_pu / (1.0 + z_th * s0.conjugate()))
    if kind == "i":
        v = complex(v_pre_pu, 0.0)
        for _ in range(200):
            if abs(v) < 0.05:
                return None
            i = s0.conjugate() * (v / abs(v))
            v_new = complex(v_pre_pu, 0.0) - z_th * i
            if abs(v_new - v) < 1e-10:
                return abs(v_new) if abs(v_new) >= 0.05 else None
            v = 0.7 * v_new + 0.3 * v
        return None
    return _solve_pq_dip(v_pre_pu, z_th, s0)


def _torque_shortfall(unit, v_start_bus, v_dol_bus):
    """[N3] First speed (% of synchronous) where the motor's air-gap torque,
    at the starting voltage held constant, fails to exceed the load torque on
    the way to breakdown speed; None if it clears everywhere.

    Starters as in the dynamic study: star-delta T/3 and autotransformer at
    a·V up to the changeover speed, then the DOL voltage; soft starter scaled
    to its current limit. Holding the locked-rotor voltage is conservative —
    it recovers as the current falls."""
    from .dynamic_motor_starting import SYNC_PULLIN_SPEED, AUTO_TX_TAP
    m, tl = unit["model"], unit["load_fn"]
    vr = unit.get("v_ratio", 1.0)
    vm, vd = v_start_bus * vr, v_dol_bus * vr
    method = unit["method"]
    trans = unit["opts"]["transition_speed_pct"] / 100.0
    w_end = SYNC_PULLIN_SPEED if unit["is_sync"] else max(0.0, 1.0 - unit["s_bd"])
    for k in range(0, 101):
        w = w_end * k / 100.0
        s = max(1.0 - w, 1e-6)
        if method == "star_delta":
            te = m.torque(vm, s) / 3.0 if w < trans else m.torque(vd, s)
        elif method == "autotransformer":
            te = m.torque(AUTO_TX_TAP * vm, s) if w < trans else m.torque(vd, s)
        elif method == "soft_starter":
            i_lim = unit["opts"]["ss_current_limit_xflc"]
            den = abs(vm * m.y_in(s))
            alpha = min(1.0, i_lim / den) if den > 1e-9 else 1.0
            te = m.torque(alpha * vm, s)
        else:
            te = m.torque(vm, s)
        if te <= tl(w):
            return w * 100.0
    return None


def _solve_pq_dip(v_pre_pu, z_th, s_start_pu):
    """[EE-1] Terminal voltage of a constant-PQ starting load S behind the
    Thevenin impedance: V = V_pre − Z_th·(S/V)*  (fixed-point iteration).
    Returns |V| p.u., or None when no operating point exists (starting load
    beyond the network's transfer capability — a genuine stall)."""
    if v_pre_pu <= 0 or abs(z_th) < 1e-12:
        return v_pre_pu
    v = complex(v_pre_pu, 0)
    for _ in range(100):
        if abs(v) < 0.05:
            return None  # collapsed — no physical operating point
        i = (s_start_pu / v).conjugate()
        v_new = complex(v_pre_pu, 0) - z_th * i
        if abs(v_new - v) < 1e-9:
            return abs(v_new)
        # Mild damping keeps the fixed point stable near the nose
        v = 0.7 * v_new + 0.3 * v
    return None


def run_motor_starting(project: ProjectData):
    """Run motor starting voltage dip analysis.

    Returns dict with 'motors' list and 'warnings' list.
    """
    from .loadflow import run_load_flow, insert_implicit_load_buses

    # Give every motor wired behind a cable/transformer a terminal bus, so its
    # load is modelled and its terminal voltage has a node to be read from
    # (otherwise the motor is invisible to load flow and the dip reads 0%).
    project = insert_implicit_load_buses(project)

    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    # Find all motors (induction and synchronous — synchronous machines start
    # asynchronously through their amortisseur winding and draw locked-rotor
    # current just like an induction motor)
    motors = [c for c in project.components
              if c.type in ("motor_induction", "motor_synchronous")]
    if not motors:
        return {"motors": [], "warnings": ["No motors found in the project."]}

    # Run baseline load flow (normal operation)
    baseline = None
    try:
        baseline = run_load_flow(project, "newton_raphson", include_synthetic=True)
    except Exception:
        try:
            baseline = run_load_flow(project, "gauss_seidel", include_synthetic=True)
        except Exception:
            return {"motors": [], "warnings": ["Load flow failed — cannot compute motor starting analysis."]}

    if not baseline.converged:
        return {"motors": [], "warnings": ["Baseline load flow did not converge."]}

    baseline_voltages = {}
    for bus_id, bus_result in baseline.buses.items():
        baseline_voltages[bus_id] = bus_result.voltage_pu

    results = []
    analysis_warnings = []

    for motor in motors:
        mp = motor.props
        is_sync = motor.type == "motor_synchronous"
        motor_name = mp.get("name", motor.id)
        voltage_kv = float(mp.get("voltage_kv", 0))
        power_factor = float(mp.get("power_factor", 0.9 if is_sync else 0.85))
        lrc = float(mp.get("locked_rotor_current", 5.5 if is_sync else 6.0))

        # Full-load current depends on the machine's rating convention:
        # induction motors are rated in shaft kW (S = kW/(η·pf)), synchronous
        # motors in kVA.
        if is_sync:
            rated_kva = float(mp.get("rated_kva", 0))
            if rated_kva <= 0 or voltage_kv <= 0:
                analysis_warnings.append(f"Motor '{motor_name}' has invalid ratings, skipped.")
                continue
            flc_a = rated_kva / (math.sqrt(3) * voltage_kv)
            rated_kw = rated_kva * power_factor  # shaft-power equivalent for display
        else:
            rated_kw = float(mp.get("rated_kw", 0))
            efficiency = float(mp.get("efficiency", 0.93))
            if rated_kw <= 0 or voltage_kv <= 0:
                analysis_warnings.append(f"Motor '{motor_name}' has invalid ratings, skipped.")
                continue
            flc_a = rated_kw / (math.sqrt(3) * voltage_kv * efficiency * power_factor)

        # Apply the starting-method current reduction
        mult, method_label = starting_current_xflc(mp, lrc)
        start_current_a = flc_a * mult
        method_key = str(mp.get("starting_method", "dol")).lower()
        if method_key not in _STARTING_METHODS:
            method_key = "dol"

        # Find terminal bus
        terminal_bus = _find_motor_bus(motor.id, adj, comp_map)
        terminal_bus_name = ""
        if terminal_bus and terminal_bus in comp_map:
            terminal_bus_name = comp_map[terminal_bus].props.get("name", terminal_bus)

        # Calculate starting MVA at the bus's nominal voltage ([MG9], see
        # bus_voltage_ratio)
        vr = bus_voltage_ratio(terminal_bus, comp_map, voltage_kv)
        start_current_a *= vr
        s_start_mva = voltage_kv * vr * start_current_a * math.sqrt(3) / 1000
        s_dol_mva = voltage_kv * vr * (flc_a * lrc * vr) * math.sqrt(3) / 1000

        # [N3] The nameplate model the dynamic study fits (LRC, LRT, speed):
        # it gives the locked-rotor power factor and the torque curve for the
        # run-up check. None for a VFD or an unfittable nameplate.
        unit = _nameplate_unit(motor, comp_map, adj, project)
        start_pf = _locked_rotor_pf(mp, unit)
        if method_key == "vfd":
            start_pf = VFD_SUPPLY_PF        # [N2] drive front end, not a rotor
        sin_pf = math.sqrt(max(0.0, 1.0 - start_pf ** 2))
        base = project.baseMVA

        # [N1] Starting load model per starter, solved behind Z_th:
        #   DOL / star-delta / autotransformer — the locked rotor is a constant
        #     IMPEDANCE (S ∝ V²), closed form V = V_pre / (1 + Z_th·Y);
        #   soft starter — constant CURRENT at its limit;
        #   VFD — constant POWER (the drive regulates it).
        # The old constant-PQ rotor had no solution past the nose and reported
        # "voltage collapse" for starts a real rotor survives (400 kW on 1 MVA:
        # collapse vs 0.74 p.u.).
        kind = {"soft_starter": "i", "vfd": "pq"}.get(method_key, "z")
        s0 = s_start_mva / base * complex(start_pf, sin_pf)   # at 1.0 p.u. bus
        superposed_v_pu = None
        thevenin_collapse = False
        z_th = None
        v_pre_term = baseline_voltages.get(terminal_bus, 1.0) if terminal_bus else 1.0
        if terminal_bus:
            v_pre_term = _prestart_voltage(project, motor.id, terminal_bus, v_pre_term)
            z_th = _thevenin_z1(project, terminal_bus, motor.id)
            if z_th is not None:
                superposed_v_pu = _solve_start_v(kind, v_pre_term, z_th, s0)
                if superposed_v_pu is None:
                    superposed_v_pu = 0.0
                    thevenin_collapse = True
            else:
                analysis_warnings.append(
                    f"Motor '{motor_name}': no non-motor source path found for "
                    f"the Thevenin dip check — dips reflect network drops only.")
        v_draw = superposed_v_pu if (superposed_v_pu or 0) > 0 else v_pre_term
        s_eff = {"z": s0 * v_draw ** 2, "i": s0 * v_draw}.get(kind, s0)

        # Create modified project: the motor becomes the starting load it
        # draws at its solved terminal voltage (so every bus sees it).
        modified = _deep_copy_project(project)
        mod_comp_map = {c.id: c for c in modified.components}
        if motor.id in mod_comp_map and not thevenin_collapse:
            mod_motor = mod_comp_map[motor.id]
            s_eff_mva = abs(s_eff) * base
            pf_eff = s_eff.real / abs(s_eff) if abs(s_eff) > 0 else start_pf
            mod_motor.props["power_factor"] = pf_eff
            # [EE-5] Locked-rotor current is a machine property — it does NOT
            # scale with the running demand factor.
            mod_motor.props["demand_factor"] = 1.0
            if is_sync:
                # load flow: S = rated_kva/1000 at the rated pf. A starting
                # synchronous motor runs up on its cage — absorbing vars — so
                # its [MG5] leading setting must not apply here.
                mod_motor.props["rated_kva"] = s_eff_mva * 1000
                mod_motor.props["pf_mode"] = "lagging"
            else:
                # load flow: S = rated_kw/(eff·pf)/1000 → with eff = 1 the
                # active-power prop is S·pf.
                mod_motor.props["rated_kw"] = s_eff_mva * 1000 * pf_eff
                mod_motor.props["efficiency"] = 1.0

        # Run load flow with motor in starting condition
        start_lf = None
        if not thevenin_collapse:
            try:
                start_lf = run_load_flow(modified, "newton_raphson", include_synthetic=True)
            except Exception:
                try:
                    start_lf = run_load_flow(modified, "gauss_seidel", include_synthetic=True)
                except Exception:
                    start_lf = None

        if start_lf is None or not start_lf.converged:
            # No starting solution is itself a result. Report the motor (never
            # drop it with only a warning, which read as "no problem").
            results.append(_unsolved_start_row(
                motor, motor_name, terminal_bus, terminal_bus_name, rated_kw,
                is_sync, method_label, start_current_a, s_start_mva,
                baseline_voltages, lf_failed=start_lf is None,
                v_est=None if thevenin_collapse else superposed_v_pu,
                collapse=thevenin_collapse, kind=kind, start_pf=start_pf))
            continue

        # [EE-1] The load flow holds the swing source at 1.0 p.u. with zero
        # internal impedance, so its dips capture only the network (cable/
        # transformer) drops — the SOURCE contribution (utility fault level,
        # generator reactance), usually the dominant term, is missing. The
        # Thevenin solve above includes it (Z_th from the IEC 60909 fault-path
        # walker at c = 1.0, nameplate impedances).
        lf_terminal_v_pu = None
        for bus_id, bus_result in start_lf.buses.items():
            if bus_id == terminal_bus:
                lf_terminal_v_pu = bus_result.voltage_pu

        # The source-internal contribution missed by the ideal-swing load flow
        # is the gap between the superposed terminal voltage and the load-flow
        # terminal voltage. Apply it to every bus galvanically connected to the
        # motor (exact for single-source radial supply, conservative
        # otherwise). [MG7] Only those: it was subtracted from EVERY bus, so a
        # plant on a separate grid showed a 3.1 % dip from a start it cannot see.
        src_dip_pu = 0.0
        if superposed_v_pu is not None and lf_terminal_v_pu is not None:
            src_dip_pu = max(0.0, lf_terminal_v_pu - superposed_v_pu)
        linked = (_galvanic_buses(terminal_bus, adj, comp_map)
                  if terminal_bus else set())

        # Calculate voltage dips at all buses
        bus_dips = {}
        max_dip_pct = 0
        max_dip_bus = ""
        motor_terminal_v_pu = 1.0

        for bus_id, bus_result in start_lf.buses.items():
            v_pre = baseline_voltages.get(bus_id, 1.0)
            v_start = max(0.0, bus_result.voltage_pu
                          - (src_dip_pu if bus_id in linked else 0.0))
            if v_pre > 0:
                dip_pct = (v_pre - v_start) / v_pre * 100
            else:
                dip_pct = 0

            bus_name = bus_id
            if bus_id in comp_map:
                bus_name = comp_map[bus_id].props.get("name", bus_id)
            bus_dips[bus_name] = round(dip_pct, 2)

            if dip_pct > max_dip_pct:
                max_dip_pct = dip_pct
                max_dip_bus = bus_name

            if bus_id == terminal_bus:
                motor_terminal_v_pu = v_start

        # Acceptance criteria
        voltage_ok = motor_terminal_v_pu >= 0.8
        # [N3] Torque: at the starting voltage the motor's torque must exceed
        # the load's all the way to breakdown speed (a star-delta start has a
        # third of the torque and can pass on voltage alone yet never run up).
        torque_fail = None
        if unit is not None and z_th is not None:
            v_dol = _solve_start_v("z", v_pre_term, z_th,
                                   s_dol_mva / base * complex(start_pf, sin_pf))
            torque_fail = _torque_shortfall(unit, motor_terminal_v_pu, v_dol or 0.0)
        motor_will_start = voltage_ok and torque_fail is None
        system_dip_ok = max_dip_pct <= 15

        # Check sensitive buses (PQ buses with loads)
        sensitive_dip_ok = True
        for bus_id, bus_result in start_lf.buses.items():
            if bus_id == terminal_bus:
                continue
            bus_comp = comp_map.get(bus_id)
            if bus_comp and bus_comp.props.get("bus_type") == "PQ":
                v_pre = baseline_voltages.get(bus_id, 1.0)
                v_start = max(0.0, bus_result.voltage_pu
                              - (src_dip_pu if bus_id in linked else 0.0))  # [EE-1] [MG7]
                dip = (v_pre - v_start) / v_pre * 100 if v_pre > 0 else 0
                if dip > 10:
                    sensitive_dip_ok = False

        # Determine status and issues
        issues = []
        if not voltage_ok:
            issues.append(f"Terminal voltage {motor_terminal_v_pu:.3f} p.u. < 0.80 p.u. — motor may not accelerate")
        if torque_fail is not None:
            issues.append(
                f"Motor torque at the starting voltage falls below the load torque "
                f"at {torque_fail:.0f}% speed — it may not run up ({method_label}; "
                f"voltage held at its locked-rotor value, conservative). Check "
                f"with Dynamic Motor Starting.")
        if not system_dip_ok:
            issues.append(f"Max system voltage dip {max_dip_pct:.1f}% > 15% at {max_dip_bus}")
        if not sensitive_dip_ok:
            issues.append("Voltage dip > 10% at one or more sensitive (PQ) buses")

        if not motor_will_start:
            status = "fail"
        elif not system_dip_ok or not sensitive_dip_ok:
            status = "warning"
        else:
            status = "pass"

        results.append({
            "motor_id": motor.id,
            "motor_name": motor_name,
            "terminal_bus": terminal_bus_name or terminal_bus or "",
            "rated_kw": round(rated_kw, 1),
            "motor_type": "synchronous" if is_sync else "induction",
            "starting_method": method_label,
            "start_current_a": round(start_current_a, 1),
            "motor_terminal_voltage_pu": round(motor_terminal_v_pu, 4),
            "motor_will_start": motor_will_start,
            "max_system_dip_pct": round(max_dip_pct, 2),
            "max_dip_bus": max_dip_bus,
            "bus_dips": bus_dips,
            "status": status,
            "issues": issues,
            "collapse": thevenin_collapse,
            "estimate": False,
            "start_pf": round(start_pf, 3),
            "torque_ok": torque_fail is None if unit is not None else None,
            "model": _MODEL_LABEL[kind],   # [N1]
        })

    return {"motors": results, "warnings": analysis_warnings}
