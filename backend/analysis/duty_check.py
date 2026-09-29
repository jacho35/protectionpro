"""Equipment Duty Check — fault current vs. device ratings.

Compares calculated fault currents (IEC 60909) against the rated
interrupt/withstand capacity of every protective device (CBs, fuses).
Flags any device whose rating is exceeded.
"""

import math
from ..models.schemas import ProjectData
from .ct_model import ct_saturation_params, ct_time_to_saturation, x_r_from_kappa
from .pt_model import pt_burden_adequacy, pt_voltage_adequacy, parse_pt_accuracy_limits

# Transparent types that do not form a bus boundary
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}


# [PT2] IEC 61869-3: measuring accuracy 80-120 % of rated voltage; 1.2 x
# continuous is the voltage factor every VT carries.
_PT_V_MEAS_MIN_PCT = 80.0
_PT_V_CONT_MAX_PCT = 120.0


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
            # [DU3] A distribution board is a bus-like node with its own fault
            # level; devices wired to one were skipped as "no connected bus".
            if comp.type in ("bus", "distribution_board"):
                buses.append(nid)
                break
            if comp.type in TRANSPARENT_TYPES:
                for next_id, _ in adj.get(nid, []):
                    if next_id not in v:
                        stack.append(next_id)
    return buses


# [L1] IEC 62271-1 / IEC 60038: the rated voltage of MV equipment must be at
# least the HIGHEST voltage for equipment Um of the system, not its nominal.
IEC_UM_KV = [3.6, 7.2, 12, 17.5, 24, 36, 40.5, 52, 72.5, 100, 123, 145, 170,
             245, 300, 362, 420, 550, 800]


def highest_system_voltage_kv(un_kv):
    """IEC 60038 Um for a nominal system voltage above 1 kV (the smallest
    standard Um ≥ 1.05·Un: 11 → 12, 22 → 24, 33 → 36, 132 → 145 kV)."""
    if un_kv <= 1.0:
        return un_kv
    for um in IEC_UM_KV:
        if um >= 1.05 * un_kv - 1e-9:
            return um
    return un_kv * 1.1


def _largest_fault_ka(bus_fault):
    """[DU2] Largest initial symmetrical PHASE current of any fault type at a
    bus. IEC 60947-2 Icu, IEC 60269 fuse breaking capacity and IEC 62271-100
    Isc must cover it — an earth fault near a Dyn transformer or an LV genset
    can exceed the three-phase current (Ik1 15.3 vs Ik3 12.75 kA at a 1 MVA
    set). ``ikLLG`` is deliberately excluded: the fault engine reports the
    EARTH-return current I″kE2E = |3·I0| there, not a current any breaker
    pole interrupts; per IEC 60909-0 §1 the largest phase current is the
    three-phase or the line-to-earth one."""
    vals = [getattr(bus_fault, k, None) for k in ("ik3", "ik1", "ikLL")]
    return max([float(v) for v in vals if v], default=0.0)


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
        # [DU2] every fault type — the duty is the largest of them
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type=None)
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

        system_kv_guess = 0.0
        for bid in bus_ids:
            if bid in comp_map:
                system_kv_guess = max(system_kv_guess, float(comp_map[bid].props.get("voltage_kv", 0) or 0))
        is_mv_device = (system_kv_guess or rated_voltage_kv) > 1.0
        # [L3] Contact-parting time of an MV breaker: Ib and the DC component
        # are evaluated at 0.1 s by the fault engine; a faster breaker parts
        # earlier, when less has decayed.
        t_cp = float(dp.get("contact_parting_s", 0) or 0)

        # Get worst-case fault current from connected buses
        prospective_fault_ka = 0
        largest_fault_ka = 0.0
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
                    # [DU1] Only an MV breaker (IEC 62271-100) is rated against
                    # the decayed breaking current Ib. An LV breaker (IEC
                    # 60947-2 Icu) and a fuse (IEC 60269) interrupt within the
                    # first cycles and are rated against the PROSPECTIVE I″k —
                    # crediting decay understated their duty 20 % at a motor
                    # bus. [DU2] Unbalanced faults: IEC 60909-0 §9 takes
                    # Ib = I″k (no decay), so they enter at their I″k.
                    largest_fault_ka = _largest_fault_ka(bus_fault)
                    others = max([float(v) for v in (bus_fault.ik1, bus_fault.ikLL) if v],
                                 default=0.0)
                    use_ib = (device_type == "cb" and is_mv_device
                              and bus_fault.ib and bus_fault.ib > 0
                              and not (0 < t_cp < 0.1))
                    if use_ib:
                        breaking_duty_ka = max(bus_fault.ib, others)
                        duty_basis = "ib" if bus_fault.ib >= others else "ik_unbalanced"
                    else:
                        breaking_duty_ka = largest_fault_ka
                        duty_basis = "ik_max"
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
                    # [L3] asymmetry at the breaker's own contact parting
                    if 0 < t_cp < 0.1 and asym_duty_ka > 0 and bus_fault.ib:
                        i_dc01 = math.sqrt(max(asym_duty_ka ** 2 - bus_fault.ib ** 2, 0.0))
                        ratio = i_dc01 / (math.sqrt(2) * ik3) if ik3 > 0 else 0.0
                        if 0 < ratio < 1:
                            tau = -0.1 / math.log(ratio)
                            i_dc = math.sqrt(2) * ik3 * math.exp(-t_cp / tau)
                            asym_duty_ka = math.sqrt(ik3 ** 2 + i_dc ** 2)

        # [PS-R2-4] Apply the through-current basis to every duty quantity
        # (breaking, asymmetrical, peak) via the ik3 ratio; the bus figures
        # remain reported as prospective values.
        if through_scale < 0.999:
            breaking_duty_ka *= through_scale
            asym_duty_ka *= through_scale
            duty_basis += "+through"

        # Calculate peak fault current: ip = κ × √2 × Ik" — [DU2] of the
        # largest fault type, since the making duty covers every closing fault
        peak_fault_ka = kappa * math.sqrt(2) * max(prospective_fault_ka, largest_fault_ka) * through_scale

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
        # [L4] MV only: an IEC 60947-2 LV breaker's rating covers asymmetry
        # through its Table 2 test power factor and making ratio instead.
        if device_type == "cb" and is_mv_device and breaking_capacity_ka > 0 and asym_duty_ka > 0:
            beta_rated = float(dp.get("dc_component_pct", 0) or 0) / 100.0
            if beta_rated <= 0:
                t_eval = t_cp if 0 < t_cp < 0.1 else 0.1
                beta_rated = math.exp(-t_eval / 0.045)  # ≈ 0.108 at 100 ms
            asym_capability_ka = breaking_capacity_ka * math.sqrt(
                1.0 + 2.0 * beta_rated ** 2)
            asym_ok = asym_duty_ka <= asym_capability_ka

        # ── Continuous current check ──
        continuous_ok = True
        if rated_current_a > 0 and load_current_a > 0:
            continuous_ok = load_current_a <= rated_current_a

        # ── Voltage rating check ──
        # [L1] MV: IEC 62271-1 requires Ur ≥ Um (IEC 60038 highest voltage
        # for equipment — 12 kV on an 11 kV system); below the nominal is a
        # fail, between nominal and Um a warning (a nominal typed as the
        # rating is common). LV: Ue ≥ Un.
        voltage_ok = True
        voltage_marginal = False
        um_kv = highest_system_voltage_kv(system_voltage_kv) if system_voltage_kv > 0 else 0.0
        if rated_voltage_kv > 0 and system_voltage_kv > 0:
            voltage_ok = system_voltage_kv <= rated_voltage_kv + 1e-9
            voltage_marginal = voltage_ok and system_voltage_kv > 1.0 and rated_voltage_kv < um_kv - 1e-9

        # ── [L2] Short-time withstand (IEC 60947-2 Icw, category B) ──
        # A breaker with a short-time delay carries the fault for that delay;
        # its Icw (for t_cw, default 1 s) must cover it: I²·t_sd ≤ Icw²·t_cw.
        icw_ok = None
        icw_ka = float(dp.get("icw_ka", 0) or 0)
        st_delay = float(dp.get("short_time_delay", 0) or 0)
        st_pickup = float(dp.get("short_time_pickup", 0) or 0)
        i_st_ka = max(prospective_fault_ka, largest_fault_ka) * through_scale
        if device_type == "cb" and st_delay > 0 and st_pickup > 0 and i_st_ka > 0:
            ir = float(dp.get("trip_rating_a", rated_current_a) or rated_current_a or 0) * \
                float(dp.get("thermal_pickup", 1.0) or 1.0)
            inst = float(dp.get("instantaneous_pickup", 0) or 0) * ir
            if not (inst > 0 and i_st_ka * 1000 >= inst):
                if icw_ka > 0:
                    t_cw = float(dp.get("icw_time_s", 1.0) or 1.0)
                    icw_ok = i_st_ka ** 2 * st_delay <= icw_ka ** 2 * t_cw + 1e-9
                else:
                    analysis_warnings.append(
                        f"Device '{device_name}' has a short-time delay but no Icw rating — "
                        "short-time withstand (IEC 60947-2) not checked.")

        # ── Utilisation ──
        utilisation_pct = 0
        if breaking_capacity_ka > 0:
            utilisation_pct = (breaking_duty_ka / breaking_capacity_ka) * 100

        # ── Status ──
        issues = []
        if not interrupt_ok:
            duty_label = {"ib": "Breaking duty Ib", "ik_unbalanced": "Unbalanced fault I\"k",
                          }.get(duty_basis.split("+")[0], "Largest prospective fault I\"k")
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
        elif voltage_marginal:
            issues.append(f"Rated voltage {rated_voltage_kv}kV is below Um {um_kv:g}kV, the highest "
                          f"voltage of a {system_voltage_kv}kV system (IEC 60038) — IEC 62271-1 "
                          f"requires Ur ≥ Um; enter the device's IEC rated voltage")
        if icw_ok is False:
            issues.append(f"Short-time withstand: {i_st_ka:.2f}kA for the {st_delay:g}s delay exceeds "
                          f"Icw {icw_ka:g}kA for {float(dp.get('icw_time_s', 1.0) or 1.0):g}s (IEC 60947-2)")
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
        if (not interrupt_ok or making_ok is False or asym_ok is False or not voltage_ok
                or icw_ok is False):
            status = "fail"
        elif (utilisation_pct > 80 or not continuous_ok or making_marginal
              or fallback_basis or voltage_marginal):
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
            "um_kv": round(um_kv, 1) if um_kv else None,
            "icw_ok": icw_ok,
            "largest_fault_ka": round(largest_fault_ka, 2),
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
    #
    # [C3] The verdict is the symmetrical criterion — the IEC 61869-2 class
    # definition (effective ALF' >= I_f / I_pn) and what overcurrent-relay
    # manufacturers require. The dc offset is reported as the time to
    # saturation (IEC 61869-2 Ktf / IEEE C37.110), not folded into the
    # threshold: a kappa derating (the previous "dc_offset_factor") is not
    # the flux demand of an offset current, which reaches 1 + X/R.
    ct_checks = []
    relay_types_by_ct = {}
    for c in project.components:
        if c.type == "relay" and c.props.get("associated_ct"):
            relay_types_by_ct.setdefault(c.props["associated_ct"], set()).add(
                str(c.props.get("relay_type", "50/51")))
    freq_hz = float(getattr(project, "frequency", 50) or 50)
    for ct in project.components:
        if ct.type != "ct" or ct.id not in relay_types_by_ct:
            continue
        ct_name = ct.props.get("name", ct.id)
        bus_ids = _find_upstream_bus(ct.id, adj, comp_map)
        if not bus_ids:
            continue

        # [L3] A core-balance CT measures the residual (earth-fault)
        # current, so its duty is the single-line-to-ground fault, not Ik3.
        residual = str(ct.props.get("ct_type", "phase")) == "core_balance"
        ibf_ka = 0.0
        kappa = None
        location_bus = ""
        for bid in bus_ids:
            bus_fault = fault_results.buses.get(bid)
            if not bus_fault:
                continue
            ik = (getattr(bus_fault, "ik1", None) if residual else bus_fault.ik3) or 0
            if ik > ibf_ka:
                ibf_ka = ik
                kappa = bus_fault.kappa
                location_bus = comp_map[bid].props.get("name", bid) if bid in comp_map else bid
        if ibf_ka <= 0:
            continue

        sat = ct_saturation_params(ct.props)
        ibf_a = ibf_ka * 1000
        i_sat = sat["i_sat_primary"]
        x_r = x_r_from_kappa(kappa)
        t_sat = ct_time_to_saturation(ibf_a, sat, x_r, freq_hz)

        issues = list(sat["warnings"])
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
        # [C4] a guessed accuracy class (PX without knee, metering core,
        # unrecognised string) cannot pass silently.
        if status == "pass" and sat["warnings"]:
            status = "warning"
        # [L3] Differential and distance protection need the CT dimensioned
        # for the transient (Ktd), which this symmetrical check does not do.
        needs_ktd = sorted(t for t in relay_types_by_ct[ct.id]
                           if t.startswith("87") or t.startswith("21"))
        if needs_ktd:
            issues.append(
                f"{'/'.join(needs_ktd)} protection needs transient dimensioning "
                "(IEC 61869-2 Ktd, relay manufacturer's requirement) — not "
                "checked here")
            if status == "pass":
                status = "warning"

        ct_checks.append({
            "device_id": ct.id,
            "device_name": ct_name,
            "location_bus": location_bus,
            "ratio": ct.props.get("ratio", ""),
            "prospective_fault_ka": round(ibf_ka, 2),
            "fault_basis": "Ik1" if residual else "Ik3",
            "i_sat_primary_a": round(i_sat, 0) if math.isfinite(i_sat) else None,
            "alf_effective": (round(sat["alf_effective"], 1)
                              if math.isfinite(sat["alf_effective"]) else None),
            "headroom_pct": round(headroom_pct, 1) if headroom_pct is not None else None,
            "x_r": round(x_r, 1),
            # IEC 61869-2 / IEEE C37.110 time for a fully offset fault to
            # saturate the core (0 = saturates symmetrically, None = never).
            "time_to_saturation_ms": (round(t_sat * 1000, 1)
                                      if math.isfinite(t_sat) else None),
            "dc_offset_factor": 1.0,  # legacy field; kappa no longer derates
            "status": status,
            "issues": issues,
        })

    # ── PT burden / voltage / voltage-factor adequacy check ──
    # [PS-16 residual] "PT parameters are used in no calculation" — the
    # voltage-side analogue of the CT check above (pt_model.py). Only PTs
    # feeding a relay (associated_pt) are checked — a metering-only PT is
    # not a protection duty concern.
    # Burden: IEC 61869-3 guarantees the class within the burden range of
    # the rated output (25-100 % for range II; 0-100 % for range I [PT4]);
    # skipped when connected_burden_va is not given (legacy).
    # [PT2] Rated primary vs the bus voltage (80-120 %) and [PT1] the rated
    # voltage factor vs the bus earth fault factor — checked for every
    # relay-fed PT on a bus with a known voltage.
    pt_checks = []
    relay_pt_ids = {
        c.props.get("associated_pt")
        for c in project.components
        if c.type == "relay" and c.props.get("associated_pt")
    }
    for pt in project.components:
        if pt.type != "pt" or pt.id not in relay_pt_ids:
            continue
        adequacy = pt_burden_adequacy(pt.props)

        pt_name = pt.props.get("name", pt.id)
        bus_ids = _find_upstream_bus(pt.id, adj, comp_map)
        location_bus, bus_id = "", None
        for bid in bus_ids:
            if bid in comp_map:
                location_bus = comp_map[bid].props.get("name", bid)
                bus_id = bid
                break

        volt = None
        if bus_id is not None:
            bus_kv = comp_map[bus_id].props.get("voltage_kv")
            bf = fault_results.buses.get(bus_id) if fault_results else None
            z1 = z0 = None
            z0_known = False
            if bf is not None and bf.z_eq_real is not None and bf.z_eq_imag is not None:
                z1 = complex(bf.z_eq_real, bf.z_eq_imag)
                z0_known = True
                if bf.z0_real is not None and bf.z0_imag is not None:
                    z0 = complex(bf.z0_real, bf.z0_imag)
                # z0 None with a z1: fault.py found no zero-sequence path
            volt = pt_voltage_adequacy(pt.props, bus_kv, z1, z0, z0_known)

        if adequacy is None and volt is None:
            continue  # nothing checkable (legacy: no connected burden, no bus)

        limits = parse_pt_accuracy_limits(pt.props.get("accuracy_class"))
        fails, warns = [], []
        loading_pct = adequacy["loading_pct"] if adequacy else None
        if adequacy is not None:
            if loading_pct is not None and loading_pct > 100:
                fails.append(
                    f"PT connected burden {adequacy['connected_burden_va']:.1f} VA "
                    f"exceeds its {adequacy['rated_burden_va']:.1f} VA rated burden "
                    f"({loading_pct:.0f}% loaded) — ratio/phase error may exceed "
                    f"the class {adequacy['accuracy_class']} limits "
                    f"(±{adequacy['ratio_error_pct']}%"
                    + (f", ±{adequacy['phase_error_min']:.0f}'" if adequacy['phase_error_min'] else "")
                    + ") [IEC 61869-3]")
            elif not adequacy["within_qualified_band"]:
                warns.append(
                    f"PT lightly burdened ({loading_pct:.0f}% of "
                    f"{adequacy['rated_burden_va']:.1f} VA rated) — IEC 61869-3 "
                    "guarantees the declared accuracy class only between 25% and "
                    "100% of rated burden (burden range II); verify accuracy at "
                    "this loading")
        if not limits["recognised"] and pt.props.get("accuracy_class"):
            # [PT3] an unrecognised class used to be read silently as 0.5
            warns.append(
                f"Accuracy class '{pt.props.get('accuracy_class')}' not recognised "
                "— limits shown are class 0.5 (IEC 61869-3: 0.1/0.2/0.5/1.0/3.0, "
                "3P/6P, or a dual class such as 0.5/3P)")

        if volt is not None:
            vpct = volt["service_voltage_pct"]
            upr_kv = volt["rated_primary_v"] / 1000.0
            conn_txt = ("applied across the line voltage" if volt["marking"] == "line"
                        else "applied phase-to-earth")
            if not volt["ratio_parsed"]:
                warns.append(
                    f"Ratio '{pt.props.get('ratio', '')}' not recognised — rated "
                    "primary taken as 11 kV; enter e.g. 11000/110 or 11000/√3/110/√3")
            if vpct > _PT_V_CONT_MAX_PCT + 1e-6:
                fails.append(
                    f"Service voltage is {vpct:.0f}% of the {upr_kv:g} kV rated "
                    f"primary ({conn_txt}) — above the 1.2 continuous voltage factor "
                    "every VT carries; the core is overfluxed [IEC 61869-3 Table 303]")
            elif vpct < _PT_V_MEAS_MIN_PCT - 1e-6:
                warns.append(
                    f"Service voltage is only {vpct:.0f}% of the {upr_kv:g} kV rated "
                    f"primary ({conn_txt}) — outside the 80-120% range in which the "
                    "measuring class holds [IEC 61869-3 5.6.201]; check the ratio")

            k = volt["earth_fault_factor"]
            req = volt["required_voltage_factor"]
            vf = volt["voltage_factor"]
            if k is not None and volt["earthed_star"]:
                earthing = ("effectively earthed" if volt["effectively_earthed"]
                            else "not effectively earthed")
                if vf is not None:
                    if vf + 1e-6 < req:
                        fails.append(
                            f"Rated voltage factor {vf:g} is below the {req:.2f} this "
                            f"bus imposes (earth fault factor {k:.2f}, {earthing}) — "
                            "the healthy-phase windings are overvoltaged during an "
                            "earth fault [IEC 61869-3 Table 303]")
                    elif (not volt["effectively_earthed"]
                          and volt["voltage_factor_duration_s"] is not None
                          and volt["voltage_factor_duration_s"] < 8 * 3600):
                        warns.append(
                            f"Voltage factor {vf:g} for "
                            f"{volt['voltage_factor_duration_s']:g} s is adequate only "
                            "if earth faults are tripped automatically; an isolated or "
                            "resonant-earthed system that runs on with an earth fault "
                            "needs 1.9 for 8 h [IEC 61869-3 Table 303]")
                elif req > 1.2 + 1e-6:
                    if not volt["effectively_earthed"]:
                        warns.append(
                            f"Voltage factor not declared — this bus is {earthing} "
                            f"(earth fault factor {k:.2f}); a phase-to-earth VT needs "
                            f"at least {req:.2f} (1.9/30 s with earth-fault tripping, "
                            "1.9/8 h without) [IEC 61869-3 Table 303]")

        status = "fail" if fails else ("warning" if warns else "pass")
        pt_checks.append({
            "device_id": pt.id,
            "device_name": pt_name,
            "location_bus": location_bus,
            "ratio": pt.props.get("ratio", ""),
            "accuracy_class": limits["class"],
            "rated_burden_va": round(adequacy["rated_burden_va"], 1) if adequacy else None,
            "connected_burden_va": round(adequacy["connected_burden_va"], 1) if adequacy else None,
            "loading_pct": round(loading_pct, 1) if loading_pct is not None else None,
            "ratio_error_pct": limits["ratio_error_pct"],
            "phase_error_min": limits["phase_error_min"],
            "service_voltage_pct": (round(volt["service_voltage_pct"], 1)
                                    if volt else None),
            "earth_fault_factor": (round(volt["earth_fault_factor"], 2)
                                   if volt and volt["earth_fault_factor"] is not None else None),
            "required_voltage_factor": (round(volt["required_voltage_factor"], 2)
                                        if volt else None),
            "voltage_factor": pt.props.get("voltage_factor") or None,
            "status": status,
            "issues": fails + warns,
        })

    return {"devices": results, "transformers": transformer_results,
            "ct_checks": ct_checks, "pt_checks": pt_checks,
            "warnings": analysis_warnings}
