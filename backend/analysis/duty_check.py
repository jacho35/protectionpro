"""Equipment Duty Check — fault current vs. device ratings.

Compares calculated fault currents (IEC 60909) against the rated
interrupt/withstand capacity of every protective device (CBs, fuses).
Flags any device whose rating is exceeded.
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


def _find_upstream_bus(device_id, adj, comp_map):
    """Find the bus on the source side (upstream) of a protective device.

    Walks through transparent devices to find connected buses, returns
    the first bus found (source side).
    """
    visited = {device_id}
    buses = []
    for neighbor_id, _ in adj.get(device_id, []):
        stack = [neighbor_id]
        v = set(visited)
        while stack:
            nid = stack.pop()
            if nid in v:
                continue
            v.add(nid)
            comp = comp_map.get(nid)
            if not comp:
                continue
            if comp.type == "bus":
                buses.append(nid)
                break
            if comp.type in TRANSPARENT_TYPES:
                for next_id, _ in adj.get(nid, []):
                    if next_id not in v:
                        stack.append(next_id)
    return buses


def run_duty_check(project: ProjectData):
    """Run equipment duty check for all CBs and fuses.

    Returns dict with 'devices' list and 'warnings' list.
    """
    from .fault import run_fault_analysis
    from .loadflow import run_load_flow

    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    # Run fault analysis (3-phase) to get prospective fault currents
    fault_results = None
    try:
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type="3phase")
    except Exception:
        return {"devices": [], "warnings": ["Fault analysis failed — cannot perform duty check."]}

    # Run load flow for continuous current check
    lf_results = None
    try:
        lf_results = run_load_flow(project, "newton_raphson")
    except Exception:
        pass

    # Build branch current lookup from load flow
    branch_currents = {}
    if lf_results and lf_results.branches:
        for br in lf_results.branches:
            branch_currents[br.elementId] = br.i_amps

    # Find all CBs and fuses
    devices = [c for c in project.components if c.type in ("cb", "fuse")]
    if not devices:
        return {"devices": [], "warnings": ["No circuit breakers or fuses found."]}

    # Build transformer loading lookup from load flow branch results
    transformer_loading = {}
    if lf_results and lf_results.branches:
        for br in lf_results.branches:
            elem = comp_map.get(br.elementId)
            if elem and elem.type == "transformer":
                transformer_loading[br.elementId] = br.loading_pct

    results = []
    transformer_results = []
    analysis_warnings = []

    for device in devices:
        dp = device.props
        device_name = dp.get("name", device.id)
        device_type = device.type

        # Get device ratings
        breaking_capacity_ka = float(dp.get("breaking_capacity_ka", 0))
        rated_current_a = float(dp.get("rated_current_a", 0))
        rated_voltage_kv = float(dp.get("rated_voltage_kv", 0))

        # Find upstream bus(es)
        bus_ids = _find_upstream_bus(device.id, adj, comp_map)
        if not bus_ids:
            analysis_warnings.append(f"Device '{device_name}' has no connected bus, skipped.")
            continue

        # Get worst-case fault current from connected buses
        prospective_fault_ka = 0
        location_bus = ""
        kappa = 1.8  # Default peak factor
        for bid in bus_ids:
            if bid in fault_results.buses:
                bus_fault = fault_results.buses[bid]
                ik3 = bus_fault.ik3 or 0
                if ik3 > prospective_fault_ka:
                    prospective_fault_ka = ik3
                    location_bus = comp_map[bid].props.get("name", bid) if bid in comp_map else bid
                    # Use kappa from fault results if available
                    if bus_fault.kappa:
                        kappa = bus_fault.kappa

        # Calculate peak fault current: ip = κ × √2 × Ik"
        peak_fault_ka = kappa * math.sqrt(2) * prospective_fault_ka

        # Get system voltage at location bus
        system_voltage_kv = 0
        for bid in bus_ids:
            if bid in comp_map:
                v = float(comp_map[bid].props.get("voltage_kv", 0))
                if v > system_voltage_kv:
                    system_voltage_kv = v

        # Get load current through device
        load_current_a = branch_currents.get(device.id, 0)

        # ── Interrupt / breaking check ──
        interrupt_ok = True
        if breaking_capacity_ka > 0:
            interrupt_ok = prospective_fault_ka <= breaking_capacity_ka
        elif prospective_fault_ka > 0:
            analysis_warnings.append(f"Device '{device_name}' has no breaking capacity rating.")
            interrupt_ok = False

        # ── Making capacity check (all CBs) ──
        # Peak fault current ip is compared against the making capacity Icm.
        making_ok = None
        making_capacity_ka = 0.0
        making_margin_pct = None
        if device_type == "cb" and breaking_capacity_ka > 0:
            # Explicit making rating prop takes precedence if provided
            making_capacity_ka = float(dp.get("making_capacity_ka", 0))
            if making_capacity_ka <= 0:
                is_mv = (system_voltage_kv or rated_voltage_kv) > 1.0
                if is_mv:
                    # IEC 62271-100: rated making capacity = 2.5 × rated
                    # breaking capacity (50 Hz systems)
                    making_capacity_ka = 2.5 * breaking_capacity_ka
                else:
                    # IEC 60947-2 Table 2: minimum ratio n = Icm/Icu
                    # varies with the ultimate breaking capacity Icu
                    icu = breaking_capacity_ka
                    if icu <= 6:
                        n = 1.5
                    elif icu <= 10:
                        n = 1.7
                    elif icu <= 20:
                        n = 2.0
                    elif icu <= 50:
                        n = 2.1
                    else:
                        n = 2.2
                    making_capacity_ka = n * breaking_capacity_ka
            making_ok = peak_fault_ka <= making_capacity_ka
            if making_capacity_ka > 0:
                making_margin_pct = (1 - peak_fault_ka / making_capacity_ka) * 100

        # ── Continuous current check ──
        continuous_ok = True
        if rated_current_a > 0 and load_current_a > 0:
            continuous_ok = load_current_a <= rated_current_a

        # ── Voltage rating check ──
        voltage_ok = True
        if rated_voltage_kv > 0 and system_voltage_kv > 0:
            voltage_ok = system_voltage_kv <= rated_voltage_kv

        # ── Utilisation ──
        utilisation_pct = 0
        if breaking_capacity_ka > 0:
            utilisation_pct = (prospective_fault_ka / breaking_capacity_ka) * 100

        # ── Status ──
        issues = []
        if not interrupt_ok:
            issues.append(f"Prospective fault {prospective_fault_ka:.2f}kA exceeds breaking capacity {breaking_capacity_ka:.2f}kA")
        if making_ok is False:
            issues.append(f"Peak fault {peak_fault_ka:.2f}kA exceeds making capacity {making_capacity_ka:.2f}kA")
        if making_ok and making_margin_pct is not None and making_margin_pct < 10:
            issues.append(
                f"Making capacity margin only {making_margin_pct:.0f}% "
                f"(peak {peak_fault_ka:.2f}kA vs making capacity {making_capacity_ka:.2f}kA)"
            )
        if not voltage_ok:
            issues.append(f"System voltage {system_voltage_kv}kV exceeds device rated voltage {rated_voltage_kv}kV")
        if not continuous_ok:
            issues.append(f"Load current {load_current_a:.1f}A exceeds rated current {rated_current_a:.0f}A")
        if utilisation_pct > 80 and interrupt_ok:
            issues.append(f"High utilisation {utilisation_pct:.0f}% — close to breaking capacity")

        making_marginal = (making_ok is True and making_margin_pct is not None
                           and making_margin_pct < 10)
        if not interrupt_ok or making_ok is False or not voltage_ok:
            status = "fail"
        elif utilisation_pct > 80 or not continuous_ok or making_marginal:
            status = "warning"
        else:
            status = "pass"

        results.append({
            "device_id": device.id,
            "device_name": device_name,
            "device_type": device_type,
            "location_bus": location_bus,
            "prospective_fault_ka": round(prospective_fault_ka, 2),
            "peak_fault_ka": round(peak_fault_ka, 2),
            "breaking_capacity_ka": round(breaking_capacity_ka, 2),
            "interrupt_ok": interrupt_ok,
            "making_ok": making_ok,
            "making_capacity_ka": round(making_capacity_ka, 2),
            "making_margin_pct": round(making_margin_pct, 1) if making_margin_pct is not None else None,
            "continuous_ok": continuous_ok,
            "voltage_ok": voltage_ok,
            "utilisation_pct": round(utilisation_pct, 1),
            "status": status,
            "issues": issues,
        })

    # ── Transformer overload check ──
    transformers = [c for c in project.components if c.type == "transformer"]
    for xfmr in transformers:
        xp = xfmr.props
        xfmr_name = xp.get("name", xfmr.id)
        rated_mva = float(xp.get("rated_mva", 0))

        # Find connected bus name for location
        bus_ids = _find_upstream_bus(xfmr.id, adj, comp_map)
        location_bus = ""
        if bus_ids:
            location_bus = comp_map[bus_ids[0]].props.get("name", bus_ids[0]) if bus_ids[0] in comp_map else bus_ids[0]

        loading_pct = transformer_loading.get(xfmr.id, None)

        if loading_pct is None:
            # Load flow didn't run or transformer not in a branch — skip silently
            continue

        load_mva = (loading_pct / 100.0) * rated_mva if rated_mva > 0 else 0

        issues = []
        if loading_pct > 100:
            issues.append(
                f"Transformer loading {loading_pct:.1f}% exceeds rated capacity "
                f"({load_mva:.3f} MVA on {rated_mva:.3f} MVA transformer)"
            )
            status = "fail"
        elif loading_pct > 80:
            issues.append(
                f"Transformer loading {loading_pct:.1f}% exceeds 80% of rated capacity "
                f"({load_mva:.3f} MVA on {rated_mva:.3f} MVA transformer)"
            )
            status = "warning"
        else:
            status = "pass"

        transformer_results.append({
            "device_id": xfmr.id,
            "device_name": xfmr_name,
            "device_type": "transformer",
            "location_bus": location_bus,
            "rated_mva": round(rated_mva, 3),
            "load_mva": round(load_mva, 3),
            "loading_pct": round(loading_pct, 1),
            "status": status,
            "issues": issues,
        })

    return {"devices": results, "transformers": transformer_results, "warnings": analysis_warnings}
