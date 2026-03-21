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
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester"}


def _build_adjacency(project):
    """Build adjacency map: component_id -> [(neighbor_id, wire)]."""
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append((w.toComponent, w))
        adj.setdefault(w.toComponent, []).append((w.fromComponent, w))
    return adj


def _find_motor_bus(motor_id, adj, comp_map):
    """Walk through transparent devices from motor to find the connected bus."""
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


def _deep_copy_project(project):
    """Create a deep copy of project data for modification."""
    import json
    data = json.loads(project.model_dump_json())
    return ProjectData(**data)


def run_motor_starting(project: ProjectData):
    """Run motor starting voltage dip analysis.

    Returns dict with 'motors' list and 'warnings' list.
    """
    from .loadflow import run_load_flow

    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    # Find all induction motors
    motors = [c for c in project.components if c.type == "motor_induction"]
    if not motors:
        return {"motors": [], "warnings": ["No induction motors found in the project."]}

    # Run baseline load flow (normal operation)
    baseline = None
    try:
        baseline = run_load_flow(project, "newton_raphson")
    except Exception:
        try:
            baseline = run_load_flow(project, "gauss_seidel")
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
        motor_name = mp.get("name", motor.id)
        rated_kw = float(mp.get("rated_kw", 0))
        voltage_kv = float(mp.get("voltage_kv", 0))
        efficiency = float(mp.get("efficiency", 0.93))
        power_factor = float(mp.get("power_factor", 0.85))
        lrc = float(mp.get("locked_rotor_current", 6.0))

        if rated_kw <= 0 or voltage_kv <= 0:
            analysis_warnings.append(f"Motor '{motor_name}' has invalid ratings, skipped.")
            continue

        # Calculate full load current
        flc_a = rated_kw / (math.sqrt(3) * voltage_kv * efficiency * power_factor)
        start_current_a = flc_a * lrc

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
            # Replace motor with locked-rotor impedance model
            # Store original props and modify for starting condition
            # The load flow treats motor_induction as a load — we increase its
            # apparent power to the starting MVA at very low power factor
            # to simulate locked-rotor condition
            mod_motor.props["rated_kw"] = s_start_mva * 1000 * 0.3  # ~0.3 pf during start
            mod_motor.props["power_factor"] = 0.3  # Typical starting pf
            mod_motor.props["efficiency"] = 1.0  # Direct impedance model

        # Run load flow with motor in starting condition
        start_lf = None
        try:
            start_lf = run_load_flow(modified, "newton_raphson")
        except Exception:
            try:
                start_lf = run_load_flow(modified, "gauss_seidel")
            except Exception:
                analysis_warnings.append(f"Load flow failed for motor '{motor_name}' starting.")
                continue

        if not start_lf.converged:
            analysis_warnings.append(f"Load flow did not converge for motor '{motor_name}' starting.")
            continue

        # Calculate voltage dips at all buses
        bus_dips = {}
        max_dip_pct = 0
        max_dip_bus = ""
        motor_terminal_v_pu = 1.0

        for bus_id, bus_result in start_lf.buses.items():
            v_pre = baseline_voltages.get(bus_id, 1.0)
            v_start = bus_result.voltage_pu
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
                v_start = bus_result.voltage_pu
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
            "start_current_a": round(start_current_a, 1),
            "motor_terminal_voltage_pu": round(motor_terminal_v_pu, 4),
            "motor_will_start": motor_will_start,
            "max_system_dip_pct": round(max_dip_pct, 2),
            "max_dip_bus": max_dip_bus,
            "bus_dips": bus_dips,
            "status": status,
            "issues": issues,
        })

    return {"motors": results, "warnings": analysis_warnings}
