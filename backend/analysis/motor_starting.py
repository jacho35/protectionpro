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
    "soft_starter":    (0.5,  "Soft Starter"),
    "vfd":             (None, "VFD"),
}


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


def _deep_copy_project(project):
    """Create a deep copy of project data for modification."""
    import json
    data = json.loads(project.model_dump_json())
    return ProjectData(**data)


def _thevenin_z1(project, bus_id, starting_motor_id):
    """[EE-1] Positive-sequence Thevenin impedance at the motor terminal bus,
    INCLUDING the source internal impedance (utility fault level, generator
    X″d) — from the shared fault-path machinery at c = 1.0, motor infeeds
    excluded, meshed topologies solved nodally ([PS-1])."""
    from .fault import thevenin_z1_at_bus
    try:
        return thevenin_z1_at_bus(project, bus_id, c=1.0,
                                  exclude_motor_paths=True,
                                  exclude_source_ids={starting_motor_id})
    except Exception:
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
        method_key = str(mp.get("starting_method", "dol")).lower()
        factor, method_label = _STARTING_METHODS.get(method_key, _STARTING_METHODS["dol"])
        if factor is None:  # VFD — drive limits supply current to ≈ full-load
            start_current_a = flc_a
        else:
            start_current_a = flc_a * lrc * factor

        # Calculate starting MVA
        s_start_mva = voltage_kv * start_current_a * math.sqrt(3) / 1000

        # Find terminal bus
        terminal_bus = _find_motor_bus(motor.id, adj, comp_map)
        terminal_bus_name = ""
        if terminal_bus and terminal_bus in comp_map:
            terminal_bus_name = comp_map[terminal_bus].props.get("name", terminal_bus)

        # Create modified project: replace motor with constant impedance load
        modified = _deep_copy_project(project)
        mod_comp_map = {c.id: c for c in modified.components}

        if motor.id in mod_comp_map:
            mod_motor = mod_comp_map[motor.id]
            # Replace the motor with a starting load drawing the full starting
            # MVA at a low (locked-rotor) power factor.
            #
            # NOTE: this models the locked rotor as a constant-PQ load, which is
            # an approximation. A locked rotor is physically a constant impedance
            # (S ∝ V²), so the constant-PQ model draws somewhat more current at
            # the depressed voltage than the true locked-rotor impedance would —
            # a conservative (slightly pessimistic) bias for voltage-dip results.
            # If the load-flow motor convention changes, the reconstruction
            # below must change with it (see
            # backend/tests/test_regression.py::TestMotorStarting).
            mod_motor.props["power_factor"] = 0.3  # Typical starting pf
            # [EE-5] Locked-rotor current is a machine property — it does NOT
            # scale with the running demand factor. The load model multiplies
            # by demand_factor, so force it to 1.0 for the starting condition
            # (a df=0.5 motor previously had its dip silently halved).
            mod_motor.props["demand_factor"] = 1.0
            if is_sync:
                # load flow models synchronous motors as S = rated_kva/1000 at
                # the rated pf, so feeding S_start (in kVA) reproduces it.
                mod_motor.props["rated_kva"] = s_start_mva * 1000
            else:
                # load flow computes S = rated_kw/(eff·pf)/1000, so with
                # eff = 1.0 and pf = 0.3 the active-power prop must be S_start·pf
                # for the drawn apparent power to equal the full starting MVA.
                mod_motor.props["rated_kw"] = s_start_mva * 1000 * 0.3  # = S_start × pf
                mod_motor.props["efficiency"] = 1.0  # Direct impedance model

        # Run load flow with motor in starting condition
        start_lf = None
        try:
            start_lf = run_load_flow(modified, "newton_raphson", include_synthetic=True)
        except Exception:
            try:
                start_lf = run_load_flow(modified, "gauss_seidel", include_synthetic=True)
            except Exception:
                analysis_warnings.append(f"Load flow failed for motor '{motor_name}' starting.")
                continue

        if not start_lf.converged:
            analysis_warnings.append(f"Load flow did not converge for motor '{motor_name}' starting.")
            continue

        # [EE-1] The load flow holds the swing source at 1.0 p.u. with zero
        # internal impedance, so its dips capture only the network (cable/
        # transformer) drops — the SOURCE contribution (utility fault level,
        # generator reactance), usually the dominant term, is missing and
        # "will start" verdicts were optimistic. Recompute the terminal
        # voltage by Thevenin superposition (same machinery as the dynamic
        # engine): V = V_pre − Z_th·I(S_start), where Z_th includes the source
        # internal impedance from the IEC 60909 fault-path walker at c = 1.0.
        lf_terminal_v_pu = None
        for bus_id, bus_result in start_lf.buses.items():
            if bus_id == terminal_bus:
                lf_terminal_v_pu = bus_result.voltage_pu
        v_pre_term = baseline_voltages.get(terminal_bus, 1.0) if terminal_bus else 1.0

        superposed_v_pu = None
        if terminal_bus:
            z_th = _thevenin_z1(project, terminal_bus, motor.id)
            if z_th is not None:
                s_pu = s_start_mva / project.baseMVA
                start_pf = 0.3
                s_cplx = s_pu * complex(start_pf, math.sqrt(1 - start_pf ** 2))
                superposed_v_pu = _solve_pq_dip(v_pre_term, z_th, s_cplx)
                if superposed_v_pu is None:
                    # No converged operating point — the starting load exceeds
                    # the network's transfer capability (voltage collapse).
                    superposed_v_pu = 0.0
                    analysis_warnings.append(
                        f"Motor '{motor_name}': no converged starting operating "
                        f"point behind the source Thevenin impedance — network "
                        f"cannot supply the starting load (treated as stall "
                        f"under the conservative constant-PQ starting-load "
                        f"model; a constant-impedance locked rotor may still "
                        f"accelerate at reduced voltage).")
            else:
                analysis_warnings.append(
                    f"Motor '{motor_name}': no non-motor source path found for "
                    f"the Thevenin dip check — dips reflect network drops only.")

        # The source-internal contribution missed by the ideal-swing load flow
        # is the gap between the superposed terminal voltage and the load-flow
        # terminal voltage. Apply it to every energized bus (exact for
        # single-source radial supply, conservative otherwise).
        src_dip_pu = 0.0
        if superposed_v_pu is not None and lf_terminal_v_pu is not None:
            src_dip_pu = max(0.0, lf_terminal_v_pu - superposed_v_pu)

        # Calculate voltage dips at all buses
        bus_dips = {}
        max_dip_pct = 0
        max_dip_bus = ""
        motor_terminal_v_pu = 1.0

        for bus_id, bus_result in start_lf.buses.items():
            v_pre = baseline_voltages.get(bus_id, 1.0)
            v_start = max(0.0, bus_result.voltage_pu - src_dip_pu)
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
        motor_will_start = motor_terminal_v_pu >= 0.8
        system_dip_ok = max_dip_pct <= 15

        # Check sensitive buses (PQ buses with loads)
        sensitive_dip_ok = True
        for bus_id, bus_result in start_lf.buses.items():
            if bus_id == terminal_bus:
                continue
            bus_comp = comp_map.get(bus_id)
            if bus_comp and bus_comp.props.get("bus_type") == "PQ":
                v_pre = baseline_voltages.get(bus_id, 1.0)
                v_start = max(0.0, bus_result.voltage_pu - src_dip_pu)  # [EE-1]
                dip = (v_pre - v_start) / v_pre * 100 if v_pre > 0 else 0
                if dip > 10:
                    sensitive_dip_ok = False

        # Determine status and issues
        issues = []
        if not motor_will_start:
            issues.append(f"Terminal voltage {motor_terminal_v_pu:.3f} p.u. < 0.80 p.u. — motor may not accelerate")
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
            # [EE-R2-3] Model disclosure: the starting load is held at
            # constant PQ (locked-rotor S at fixed pf), which draws MORE
            # current as the voltage falls than a true constant-impedance
            # locked rotor — dips and stall verdicts err on the pessimistic
            # (safe) side, especially near voltage collapse.
            "model": "constant-PQ starting load (pessimistic near collapse)",
        })

    return {"motors": results, "warnings": analysis_warnings}
