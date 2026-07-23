"""Equipment Duty Check — fault current vs. device ratings.

Compares calculated fault currents (IEC 60909) against the rated
interrupt/withstand capacity of every protective device (CBs, fuses).
Flags any device whose rating is exceeded.
"""

import math
from ..models.schemas import ProjectData
from .ct_model import ct_saturation_params

# Transparent types that do not form a bus boundary
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}


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
    if not devices:
        # No early return — a network with only CT/relay protection (no
        # CB/fuse) still needs the transformer + CT adequacy checks below.
        analysis_warnings.append("No circuit breakers or fuses found.")

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
        breaking_duty_ka = 0.0
        asym_duty_ka = 0.0
        through_fault_ka = 0.0
        through_scale = 1.0
        duty_basis = "ik3"
        location_bus = ""
        fallback_basis = False  # [R3/PS-1] per-path fallback on a meshed net
        kappa = 1.8  # Default peak factor
        for bid in bus_ids:
            if bid in fault_results.buses:
                bus_fault = fault_results.buses[bid]
                ik3 = bus_fault.ik3 or 0
                if ik3 > prospective_fault_ka:
                    prospective_fault_ka = ik3
                    # [PROT-15] Breaking duty uses the symmetrical breaking
                    # current Ib (IEC 60909 §9 — decayed at contact parting)
                    # when the engine provides it, falling back to I"k3
                    # (conservative) — matching frontend compliance.js.
                    if bus_fault.ib and bus_fault.ib > 0:
                        breaking_duty_ka = bus_fault.ib
                        duty_basis = "ib"
                    else:
                        breaking_duty_ka = ik3
                        duty_basis = "ik3"
                    # [PS-14a] Asymmetrical breaking current at contact
                    # parting (fault engine: Ib_asym = √(Ib² + I_dc²) at
                    # 100 ms with τ from the reduced Z_eq).
                    asym_duty_ka = bus_fault.ib_asymmetric or 0.0
                    location_bus = comp_map[bid].props.get("name", bid) if bid in comp_map else bid
                    # Use kappa from fault results if available
                    if bus_fault.kappa:
                        kappa = bus_fault.kappa
                    # [R3/PS-1 fallback] this bus's currents come from the
                    # OVERSTATING per-path combination — flag the verdict.
                    fallback_basis = (getattr(bus_fault, "thevenin_basis", None)
                                      == "per-path-fallback")
                    # [PS-R2-4] Through-current refinement: the device
                    # interrupts its THROUGH-fault, not the whole-bus figure.
                    # The bus's branch row for this device carries the infeed
                    # arriving through it (from sources on its far side):
                    #   incomer  → row ≈ upstream infeed = its true duty;
                    #   feeder   → duty for a fault just below the device is
                    #              the bus total minus the downstream infeed
                    #              the row measures.
                    # max(row, total − row) selects the correct case for both
                    # orientations and never exceeds the bus total. Devices
                    # with no row (no source beyond them) keep the bus figure
                    # (row = 0 → duty = total, the legacy conservative basis).
                    row_ka = 0.0
                    for br in (bus_fault.branches or []):
                        if br.element_id == device.id:
                            row_ka = br.ik_ka or 0.0
                            break
                    if 0 < row_ka < ik3:
                        through_fault_ka = max(row_ka, ik3 - row_ka)
                    else:
                        through_fault_ka = ik3
                    through_scale = through_fault_ka / ik3 if ik3 > 0 else 1.0

        # [PS-R2-4] Apply the through-current basis to every duty quantity
        # (breaking, asymmetrical, peak) via the ik3 ratio; the bus figures
        # remain reported as prospective values.
        if through_scale < 0.999:
            breaking_duty_ka *= through_scale
            asym_duty_ka *= through_scale
            duty_basis += "+through"

        # Calculate peak fault current: ip = κ × √2 × Ik"
        peak_fault_ka = kappa * math.sqrt(2) * prospective_fault_ka * through_scale

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
            interrupt_ok = breaking_duty_ka <= breaking_capacity_ka
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
                    # breaking capacity at 50 Hz, 2.6 × at 60 Hz [PROT-16]
                    freq = float(getattr(project, "frequency", 50) or 50)
                    making_factor = 2.6 if freq == 60 else 2.5
                    making_capacity_ka = making_factor * breaking_capacity_ka
                else:
                    # IEC 60947-2 Table 2: minimum ratio n = Icm/Icu
                    # varies with the ultimate breaking capacity Icu
                    icu = breaking_capacity_ka
                    if icu <= 4.5:
                        # [PS-14b] IEC 60947-2 Table 2 bottom rung: n = 1.41
                        # for Icu ≤ 4.5 kA — the previous ladder lumped these
                        # into 1.5 (~6% optimistic on assumed making capacity
                        # for miniature breakers).
                        n = 1.41
                    elif icu <= 6:
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

        # ── [PS-14a] Asymmetrical breaking duty (IEC 62271-100 §4.101) ──
        # A breaker's rated breaking capacity is defined WITH the standard
        # DC component (τ = 45 ms evaluated at the same 100 ms contact-
        # parting time the fault engine uses for Ib_asym); a network with a
        # slower-decaying DC component (high X/R) presents a larger
        # asymmetrical duty than the rating covers. Device capability:
        # I_asym = Icu·√(1 + 2·β²) with β the rated DC fraction — from the
        # `dc_component_pct` prop when given, else the standard τ = 45 ms
        # value. Previously ib_asymmetric was computed but never checked.
        asym_ok = None
        asym_capability_ka = 0.0
        if device_type == "cb" and breaking_capacity_ka > 0 and asym_duty_ka > 0:
            beta_rated = float(dp.get("dc_component_pct", 0) or 0) / 100.0
            if beta_rated <= 0:
                beta_rated = math.exp(-0.1 / 0.045)  # ≈ 0.108 at 100 ms
            asym_capability_ka = breaking_capacity_ka * math.sqrt(
                1.0 + 2.0 * beta_rated ** 2)
            asym_ok = asym_duty_ka <= asym_capability_ka

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
            utilisation_pct = (breaking_duty_ka / breaking_capacity_ka) * 100

        # ── Status ──
        issues = []
        if not interrupt_ok:
            duty_label = "Breaking duty Ib" if duty_basis == "ib" else "Prospective fault I\"k3"
            issues.append(f"{duty_label} {breaking_duty_ka:.2f}kA exceeds breaking capacity {breaking_capacity_ka:.2f}kA")
        if making_ok is False:
            issues.append(f"Peak fault {peak_fault_ka:.2f}kA exceeds making capacity {making_capacity_ka:.2f}kA")
        if asym_ok is False:
            issues.append(
                f"Asymmetrical breaking duty {asym_duty_ka:.2f}kA exceeds the "
                f"rated asymmetrical capability {asym_capability_ka:.2f}kA "
                "(IEC 62271-100 §4.101 — DC component above the standard "
                "rated value; check the breaker's DC-component rating)")
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
        if fallback_basis:
            issues.append(
                "Fault current basis is a per-path fallback on a meshed "
                "topology (nodal solve failed) — duty figures may be "
                "overstated; verdict unreliable")

        making_marginal = (making_ok is True and making_margin_pct is not None
                           and making_margin_pct < 10)
        if not interrupt_ok or making_ok is False or asym_ok is False or not voltage_ok:
            status = "fail"
        elif (utilisation_pct > 80 or not continuous_ok or making_marginal
              or fallback_basis):
            status = "warning"
        else:
            status = "pass"

        results.append({
            "device_id": device.id,
            "device_name": device_name,
            "device_type": device_type,
            "location_bus": location_bus,
            "prospective_fault_ka": round(prospective_fault_ka, 2),
            "breaking_duty_ka": round(breaking_duty_ka, 2),
            "through_fault_ka": round(through_fault_ka, 2),
            "thevenin_fallback": fallback_basis,
            "duty_basis": duty_basis,
            "peak_fault_ka": round(peak_fault_ka, 2),
            "breaking_capacity_ka": round(breaking_capacity_ka, 2),
            "interrupt_ok": interrupt_ok,
            "making_ok": making_ok,
            "making_capacity_ka": round(making_capacity_ka, 2),
            "making_margin_pct": round(making_margin_pct, 1) if making_margin_pct is not None else None,
            "asym_ok": asym_ok,
            "asym_duty_ka": round(asym_duty_ka, 2),
            "asym_capability_ka": round(asym_capability_ka, 2),
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

    # ── CT saturation / accuracy-limit adequacy check ──
    # [PS-16 residual] "no CT burden/ratio adequacy check": for every CT
    # feeding an overcurrent relay, flag whether the CT's own saturation
    # threshold (ct_model.py — ratio, accuracy-class ALF, burden, knee
    # voltage) covers the prospective fault current at its bus. An
    # undersized CT saturates before the relay sees the full fault
    # magnitude, understating the current the arc-flash/relay clearing-time
    # evaluation (and the physical relay) actually measures. Only CTs with
    # an associated protection relay are checked — a metering CT is
    # expected to saturate/protect its meter and is not a duty concern.
    ct_checks = []
    relay_ct_ids = {
        c.props.get("associated_ct")
        for c in project.components
        if c.type == "relay" and c.props.get("associated_ct")
    }
    for ct in project.components:
        if ct.type != "ct" or ct.id not in relay_ct_ids:
            continue
        ct_name = ct.props.get("name", ct.id)
        bus_ids = _find_upstream_bus(ct.id, adj, comp_map)
        if not bus_ids:
            continue

        ibf_ka = 0.0
        kappa = None
        location_bus = ""
        for bid in bus_ids:
            bus_fault = fault_results.buses.get(bid)
            if bus_fault and (bus_fault.ik3 or 0) > ibf_ka:
                ibf_ka = bus_fault.ik3 or 0
                kappa = bus_fault.kappa
                location_bus = comp_map[bid].props.get("name", bid) if bid in comp_map else bid
        if ibf_ka <= 0:
            continue

        sat = ct_saturation_params(ct.props, kappa=kappa)
        ibf_a = ibf_ka * 1000
        i_sat = sat["i_sat_primary"]

        issues = []
        if not math.isfinite(i_sat):
            status = "pass"
            headroom_pct = None
        elif ibf_a > i_sat:
            status = "fail"
            headroom_pct = (i_sat - ibf_a) / i_sat * 100
            issues.append(
                f"CT saturates at {i_sat:.0f}A primary, below the "
                f"{ibf_a:.0f}A prospective fault current at {location_bus} "
                "— its relay(s) may see a reduced/clipped current and "
                "operate slower than the fault duty requires")
        else:
            headroom_pct = (i_sat - ibf_a) / i_sat * 100
            if headroom_pct < 20:
                status = "warning"
                issues.append(
                    f"CT saturation headroom only {headroom_pct:.0f}% "
                    f"(saturates at {i_sat:.0f}A vs {ibf_a:.0f}A "
                    f"prospective fault at {location_bus})")
            else:
                status = "pass"

        ct_checks.append({
            "device_id": ct.id,
            "device_name": ct_name,
            "location_bus": location_bus,
            "ratio": ct.props.get("ratio", ""),
            "prospective_fault_ka": round(ibf_ka, 2),
            "i_sat_primary_a": round(i_sat, 0) if math.isfinite(i_sat) else None,
            "headroom_pct": round(headroom_pct, 1) if headroom_pct is not None else None,
            "dc_offset_factor": round(sat["dc_offset_factor"], 2),
            "status": status,
            "issues": issues,
        })

    return {"devices": results, "transformers": transformer_results,
            "ct_checks": ct_checks, "warnings": analysis_warnings}
