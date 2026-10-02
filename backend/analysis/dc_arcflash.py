"""DC arc flash analysis per Stokes & Oppenlander method and DGUV-I 203-077.

Implements the Stokes & Oppenlander (1985) empirical model for DC arc flash:
- DC arcing current solved iteratively from the circuit equation with the
  current-dependent arc resistance R_arc = (20 + 0.534·G) / I_arc^0.88
- Arc voltage V_arc = I_arc · R_arc(I_arc)
- Incident energy via point-source spherical radiation model (open air),
  × 3 for an arc in an enclosure (NFPA 70E Annex D.5 arc-in-a-box factor)
- Arc flash boundary calculation
- PPE category per NFPA 70E Table 130.7(C)(15)(a)

Runs on DC buses (bus `system` = 'dc'), with the DC bolted fault current from
the IEC 61660-1 short-circuit engine (dc_shortcircuit.py). See
reviews/DC_ARCFLASH_REVIEW.md (DA1-DA6).

References:
- Stokes, A.D. & Oppenlander, W.T. (1985), "Electric Arcs in Open Air",
  Journal of Physics D: Applied Physics, Vol. 18, pp. 53-60
- Ammerman, R.F. et al. (2010), "DC-Arc Models and Incident-Energy
  Calculations", IEEE Transactions on Industry Applications, Vol. 46, No. 5
- DGUV Information 203-077, "Thermal Hazards from Electric Fault Arcs"
- NFPA 70E-2021 "Standard for Electrical Safety in the Workplace"

Valid ranges:
  - DC system voltage: 48V to 1500V (typical battery/PV/DC distribution)
  - Bolted fault current: practical range for DC systems
  - Gap between conductors: 13mm to 152mm
  - Working distance: >= 305mm
  - Fault clearing time: up to 2 seconds
"""

import math
from dataclasses import dataclass, field

from .arcflash import get_clearing_time, _get_ppe, PPE_CATEGORIES, min_arc_rating_text

# [DA3] DC fault sources for the clearing-time walk (plus the AC ones — a
# rectifier's AC side is reached through the rectifier, which is itself a
# source here, so the walk stops there).
_DC_SOURCE_TYPES = {"dc_battery", "rectifier", "charger",
                    "utility", "generator", "solar_pv", "wind_turbine", "battery"}

# [DA2] NFPA 70E Annex D.5: an arc in an enclosure focuses the energy toward
# the opening — the open-air (spherical) incident energy is multiplied by 3.
_ARC_IN_BOX_FACTOR = 3.0

# J/cm² per cal/cm² — the thermochemical calorie (4.184 J), as IEEE 1584,
# NFPA 70E and the Ammerman/CED method (0.239 cal/J). [DA-L1] Was 4.1868.
_J_PER_CAL = 4.184


# ─── Typical DC conductor gaps (mm) by system voltage ───
_DC_TYPICAL_GAP = {
    0.048: 13,    # 48V DC
    0.125: 13,    # 125V DC
    0.250: 25,    # 250V DC
    0.600: 32,    # 600V DC
    1.000: 50,    # 1000V DC
    1.500: 50,    # 1500V DC
}


def _get_dc_gap(voltage_kv):
    """Get typical DC conductor gap (mm) for a given voltage level.

    Matches the closest known DC voltage level and returns the
    standard gap spacing used in industry practice.

    Args:
        voltage_kv: DC system voltage in kV.

    Returns:
        Conductor gap in mm.
    """
    best_gap = 25
    best_diff = 1e6
    for v, g in _DC_TYPICAL_GAP.items():
        diff = abs(v - voltage_kv)
        if diff < best_diff:
            best_diff = diff
            best_gap = g
    return best_gap


@dataclass
class DCArcFlashBusResult:
    """DC arc flash results for a single bus."""
    bus_id: str
    bus_name: str
    voltage_kv: float
    system_voltage_v: float      # DC voltage in volts
    bolted_fault_ka: float
    dc_arcing_current_a: float
    arc_voltage_v: float
    incident_energy_cal: float   # cal/cm²
    arc_flash_boundary_mm: float
    clearing_time_s: float
    working_distance_mm: float
    gap_mm: float
    ppe_category: int
    ppe_name: str
    ppe_description: str
    enclosure: str = "open air"  # [DA2] incident-energy geometry used
    warning: str = ""
    label_html: str = ""         # Pre-formatted NFPA 70E label HTML
    recommendations: list = field(default_factory=list)


@dataclass
class DCArcFlashResults:
    """Complete DC arc flash analysis results."""
    buses: dict                  # bus_id -> DCArcFlashBusResult
    method: str = "Stokes & Oppenlander (DC)"
    warnings: list = field(default_factory=list)


def _dc_arc_resistance(iarc_a, gap_mm):
    """Stokes & Oppenlander arc resistance (ohms) at a given current.

        R_arc = (20 + 0.534·G) / I_arc^0.88     (G = gap in mm)
    """
    return (20.0 + 0.534 * gap_mm) / max(iarc_a, 1e-6) ** 0.88


def solve_dc_arc(v_sys, r_sys_ohm, gap_mm, max_iter=30, tol=1e-6):
    """Solve the DC arc operating point per Stokes & Oppenlander.

    The arc is a non-linear resistance in series with the system:

        R_arc(I) = (20 + 0.534·G) / I^0.88
        I_arc    = V_sys / (R_sys + R_arc(I_arc))

    Solved by fixed-point iteration starting at I_bolted/2 (converges in a
    handful of iterations for realistic DC systems). The arc voltage is then

        V_arc = I_arc · R_arc(I_arc) = (20 + 0.534·G) · I_arc^0.12

    Args:
        v_sys: DC system voltage in volts.
        r_sys_ohm: System (source) resistance in ohms (= V_sys / I_bolted).
        gap_mm: Gap between conductors in mm.
        max_iter: Maximum fixed-point iterations.
        tol: Relative convergence tolerance.

    Returns:
        (i_arc_a, v_arc_v, r_arc_ohm) tuple; (0, 0, 0) if no arc can sustain.
    """
    if v_sys <= 0 or r_sys_ohm <= 0 or gap_mm <= 0:
        return 0.0, 0.0, 0.0

    # Minimum arc voltage across the gap (S&O at I = 1 A) — if the system
    # voltage cannot support it, the arc cannot sustain.
    if v_sys <= 20.0 + 0.534 * gap_mm:
        return 0.0, 0.0, 0.0

    i_bolted = v_sys / r_sys_ohm
    # [DA-L2] The operating point is the root of
    #   f(I) = I·R_sys + (20 + 0.534·G)·I^0.12 − V_sys,
    # strictly increasing in I, so bisection on (0, I_bf] is exact. A fixed
    # 30-step iteration was used; its contraction factor 0.88·V_arc/V_sys
    # approaches 0.88 near arc extinction, where 30 steps leave ~2 % error.
    a_arc = 20.0 + 0.534 * gap_mm
    lo, hi = 0.0, i_bolted
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if mid * r_sys_ohm + a_arc * mid ** 0.12 > v_sys:
            hi = mid
        else:
            lo = mid
        if hi - lo <= tol * max(hi, 1e-9) * 1e-3:
            break
    i_arc = 0.5 * (lo + hi)

    i_arc = min(i_arc, i_bolted)  # cannot exceed bolted fault current
    r_arc = _dc_arc_resistance(i_arc, gap_mm)
    v_arc = i_arc * r_arc

    return i_arc, v_arc, r_arc


def calc_dc_arcing_current(ibf_a, v_dc, gap_mm):
    """Calculate DC arcing current per Stokes & Oppenlander model.

    The system resistance is derived from the bolted fault current
    (R_sys = V_dc / I_bf) and the arc operating point is solved
    iteratively via :func:`solve_dc_arc`.

    Args:
        ibf_a: Bolted fault current in amperes (DC).
        v_dc: DC system voltage in volts.
        gap_mm: Gap between conductors in mm.

    Returns:
        DC arcing current in amperes.
    """
    if ibf_a <= 0 or v_dc <= 0:
        return 0.0

    r_sys = v_dc / ibf_a
    iarc, _, _ = solve_dc_arc(v_dc, r_sys, gap_mm)
    return iarc


def calc_dc_incident_energy(iarc_a, gap_mm, t_clear_s, working_dist_mm,
                            box_factor=1.0):
    """Calculate DC incident energy per Stokes & Oppenlander spherical model.

    Uses point-source radiation in a sphere:

        V_arc = I_arc * R_arc(I_arc)     (S&O arc voltage at the operating
                                          point = (20 + 0.534·G)·I_arc^0.12)
        P_arc = V_arc * I_arc            (arc power, watts)
        E_arc = P_arc * t                (arc energy, joules)
        E_incident = E_arc / (4 * pi * D^2)   (J/m², D in metres)
        E_cal = E_incident / 41840       (convert J/m² to cal/cm²)
        × box_factor                     (3 for an arc in an enclosure,
                                          NFPA 70E Annex D.5)

    Args:
        iarc_a: DC arcing current in amperes.
        gap_mm: Gap between conductors in mm.
        t_clear_s: Fault clearing time in seconds.
        working_dist_mm: Working distance in mm.

    Returns:
        Incident energy in cal/cm².
    """
    if iarc_a <= 0 or t_clear_s <= 0 or working_dist_mm <= 0:
        return 0.0

    v_arc = iarc_a * _dc_arc_resistance(iarc_a, gap_mm)
    p_arc = v_arc * iarc_a                     # watts
    e_arc = p_arc * t_clear_s                  # joules

    d_m = working_dist_mm / 1000.0             # convert mm to metres
    e_incident_jm2 = e_arc / (4.0 * math.pi * d_m ** 2)  # J/m²
    e_cal = e_incident_jm2 / (_J_PER_CAL * 1e4) * box_factor   # cal/cm²

    return max(0.0, e_cal)


def calc_dc_arc_flash_boundary(iarc_a, gap_mm, t_clear_s, threshold_cal=1.2,
                               box_factor=1.0):
    """Calculate DC arc flash boundary distance.

    The arc flash boundary is the distance at which incident energy equals
    the threshold (default 1.2 cal/cm² per NFPA 70E). Solved analytically
    from the spherical radiation model, with the arc voltage taken at the
    Stokes & Oppenlander operating point, V_arc = I_arc·R_arc(I_arc):

        threshold = (V_arc * I_arc * t) / (4 * pi * D^2 * 41868)

    Rearranging:

        D = sqrt( (V_arc * I_arc * t) / (4 * pi * 41868 * threshold) )

    Args:
        iarc_a: DC arcing current in amperes.
        gap_mm: Gap between conductors in mm.
        t_clear_s: Fault clearing time in seconds.
        threshold_cal: Energy threshold in cal/cm² (default 1.2).

    Returns:
        Arc flash boundary in mm.
    """
    if iarc_a <= 0 or t_clear_s <= 0 or threshold_cal <= 0:
        return 0.0

    v_arc = iarc_a * _dc_arc_resistance(iarc_a, gap_mm)
    e_arc = v_arc * iarc_a * t_clear_s  # joules

    # D in metres: E_threshold = E_arc / (4*pi*D^2 * 41868)
    # D^2 = E_arc / (4*pi*41868*threshold)
    d_sq = e_arc * box_factor / (4.0 * math.pi * _J_PER_CAL * 1e4 * threshold_cal)

    if d_sq <= 0:
        return 0.0

    d_m = math.sqrt(d_sq)
    d_mm = d_m * 1000.0

    return round(d_mm, 0)


def _bus_gap_mm(bus, v_dc):
    """[DA4] The properties panel writes ``conductor_gap_mm``; the engine read
    ``gap_mm`` (never written by the UI), so a user's gap was ignored."""
    for key in ("conductor_gap_mm", "gap_mm"):
        try:
            g = float(bus.props.get(key, 0) or 0)
        except (TypeError, ValueError):
            g = 0.0
        if g > 0:
            return g
    return _get_dc_gap(v_dc / 1000.0)


def run_dc_arc_flash(project_data, dc_sc_results=None):
    """Run DC arc flash on every DC bus.

    [DA1] Buses are the DC buses (``system`` = 'dc') and the bolted fault
    current is the IEC 61660-1 quasi-steady short-circuit current from
    dc_shortcircuit.py (an explicit ``dc_bolted_fault_ka`` on the bus wins).
    This used to select the AC buses — ``system != 'dc'`` — and treat each as
    a DC system at its AC voltage with the AC three-phase fault current: every
    AC bus got a meaningless "DC" label and no DC bus was ever studied.

    ``dc_sc_results``: a DCShortCircuitResults; computed here when omitted
    (any other object, e.g. an AC FaultResults from an older caller, is
    ignored).
    """
    from .dc_shortcircuit import run_dc_short_circuit
    from .dc_loadflow import _is_dc_bus, _bus_nominal_v

    components = {c.id: c for c in project_data.components}
    buses = {c.id: c for c in project_data.components if _is_dc_bus(c)}
    warnings = []
    if not buses:
        return DCArcFlashResults(buses={}, warnings=[
            "No DC buses in the network. Set a bus's System property to 'DC' "
            "to study DC arc flash."])

    if dc_sc_results is None or not hasattr(dc_sc_results, "converged"):
        dc_sc_results = run_dc_short_circuit(project_data)
    sc_buses = getattr(dc_sc_results, "buses", {}) or {}

    adjacency = {}
    for w in project_data.wires:
        adjacency.setdefault(w.fromComponent, []).append((w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append((w.fromComponent, w.toPort, w.fromPort))

    results = {}

    for bus_id, bus in buses.items():
        voltage_v = _bus_nominal_v(bus)
        voltage_kv = voltage_v / 1000.0
        bus_name = bus.props.get("name", bus_id)
        working_dist = float(bus.props.get("working_distance_mm", 455) or 455)
        gap_mm = _bus_gap_mm(bus, voltage_v)
        # [DA2] Open air only for an open-air electrode configuration
        open_air = str(bus.props.get("electrode_config", "VCB")) in ("VOA", "HOA")
        box = 1.0 if open_air else _ARC_IN_BOX_FACTOR

        dc_bolted_ka = float(bus.props.get("dc_bolted_fault_ka", 0) or 0)
        sc = sc_buses.get(bus_id)
        if dc_bolted_ka > 0:
            ibf_ka = dc_bolted_ka
        elif sc is not None and sc.ik_ka > 0:
            ibf_ka = sc.ik_ka
        else:
            warnings.append(
                f"Bus '{bus_name}': no DC fault current (no DC source reaches it) "
                "— no DC arc flash label produced")
            continue
        ibf_a = ibf_ka * 1000.0

        notes = []
        if voltage_v > 1500:
            notes.append(f"DC voltage {voltage_v:.0f} V exceeds the typical DC range (> 1500 V)")
        if voltage_v < 48:
            notes.append(f"DC voltage {voltage_v:.0f} V is very low — a sustained arc is unlikely")
        if working_dist < 305:
            notes.append(f"Working distance {working_dist:g} mm below 305 mm — extrapolated")
        if gap_mm < 5 or gap_mm > 500:
            notes.append(f"Gap {gap_mm:g} mm outside the Stokes & Oppenländer data (5-500 mm)")

        r_sys = voltage_v / ibf_a
        iarc_a, v_arc, _r_arc = solve_dc_arc(voltage_v, r_sys, gap_mm)

        if iarc_a <= 0:
            warnings.append(
                f"Bus '{bus_name}': DC voltage ({voltage_v:.0f}V) too low to "
                f"sustain an arc across {gap_mm:.0f} mm gap."
            )
            continue
        if iarc_a < 100 or iarc_a > 100000:
            notes.append(f"Arcing current {iarc_a:.0f} A outside the Stokes & "
                         "Oppenländer data (100 A-100 kA)")

        # [DA3] DC sources for the device walk
        t_clear = get_clearing_time(bus, components, adjacency, iarc_ka=iarc_a / 1000.0,
                                    source_types=_DC_SOURCE_TYPES)

        e_cal = calc_dc_incident_energy(iarc_a, gap_mm, t_clear, working_dist, box)
        afb = calc_dc_arc_flash_boundary(iarc_a, gap_mm, t_clear, box_factor=box)

        ppe_cat, ppe_name, ppe_desc = _get_ppe(e_cal)

        label = _generate_dc_label(
            bus_name, voltage_v, e_cal, afb, ppe_cat,
            ppe_name, ppe_desc, ibf_ka, iarc_a, t_clear, working_dist
        )

        results[bus_id] = DCArcFlashBusResult(
            bus_id=bus_id,
            bus_name=bus_name,
            voltage_kv=voltage_kv,
            system_voltage_v=voltage_v,
            bolted_fault_ka=round(ibf_ka, 2),
            dc_arcing_current_a=round(iarc_a, 1),
            arc_voltage_v=round(v_arc, 1),
            incident_energy_cal=round(e_cal, 2),
            arc_flash_boundary_mm=round(afb, 0),
            clearing_time_s=round(t_clear, 3),
            working_distance_mm=working_dist,
            gap_mm=gap_mm,
            ppe_category=ppe_cat,
            ppe_name=ppe_name,
            ppe_description=ppe_desc,
            enclosure="open air" if open_air else "enclosed (×3, NFPA 70E Annex D.5)",
            warning="; ".join(notes),
            label_html=label,
        )

    for bus_id, r in results.items():
        r.recommendations = _generate_dc_recommendations(
            r, buses[bus_id], components, adjacency
        )

    return DCArcFlashResults(buses=results, warnings=warnings)


def _generate_dc_recommendations(result, bus, components, adjacency):
    """Generate actionable recommendations to reduce DC arc flash incident energy.

    Analyzes the key factors (clearing time, working distance, available fault
    current) and suggests practical DC-specific mitigation strategies.

    Args:
        result: DCArcFlashBusResult for this bus.
        bus: The bus component object.
        components: Dict of all components by ID.
        adjacency: Adjacency dict from wire connections.

    Returns:
        List of recommendation strings.
    """
    recs = []
    e = result.incident_energy_cal
    t = result.clearing_time_s
    ppe = result.ppe_category

    if ppe <= 0:
        return recs  # Already safe — no recommendations needed

    # 1. Reduce clearing time (biggest impact on incident energy)
    if t > 0.1:
        recs.append(
            f"Reduce clearing time (currently {t * 1000:.0f} ms). "
            "Install fast-acting DC-rated fuses or circuit breakers with "
            "instantaneous trip. DC clearing times directly scale incident energy."
        )

    # 2. Current-limiting fuses
    has_fuse = False
    for neighbor_id, _, _ in adjacency.get(bus.id, []):
        comp = components.get(neighbor_id)
        if comp and comp.type == "fuse":
            has_fuse = True
            break
    if not has_fuse and ppe >= 1:
        recs.append(
            "Install DC-rated current-limiting fuses upstream. "
            "Current-limiting fuses can clear DC faults in under half a cycle "
            "equivalent, dramatically reducing arc flash energy."
        )

    # 3. Increase working distance
    if result.working_distance_mm < 610:
        recs.append(
            f"Increase working distance from {result.working_distance_mm:.0f} mm "
            "to 610 mm or more. DC incident energy follows an inverse-square "
            "relationship with distance."
        )

    # 4. Battery disconnect switches
    if result.system_voltage_v <= 600:
        recs.append(
            "Install battery disconnect switches or shunt-trip breakers that "
            "can be remotely operated to isolate the DC source before work. "
            "Battery systems can sustain arcs for extended durations."
        )

    # 5. Reduce available fault current
    if result.bolted_fault_ka > 10:
        recs.append(
            f"Available DC fault current is high ({result.bolted_fault_ka:.1f} kA). "
            "Consider adding current-limiting reactors or resistance grounding "
            "to reduce the available fault level at this bus."
        )

    # 6. Remote operation for high-energy buses
    if ppe >= 3:
        recs.append(
            "Implement remote switching and racking of DC switchgear "
            "to eliminate personnel exposure during operations."
        )

    # 7. De-energize before work for extreme hazard
    if ppe >= 4 or ppe == -1:
        recs.append(
            "CRITICAL: Incident energy exceeds safe work limits. "
            "De-energize the DC system before performing any work "
            "(NFPA 70E §130.2). If energized work is absolutely necessary, "
            "perform an energized electrical work permit per NFPA 70E §130.2(A) "
            "and ensure a qualified safety observer is present."
        )

    # 8. DC-specific: series fuse coordination
    if t > 0.5:
        recs.append(
            "Review DC protection coordination. Ensure upstream fuses or "
            "breakers are properly rated for DC fault interruption and that "
            "time-current curves provide selective coordination with "
            "minimum clearing time at the available fault level."
        )

    return recs


def _generate_dc_label(bus_name, voltage_v, energy, boundary_mm, ppe_cat,
                        ppe_name, ppe_desc, ibf_ka, iarc_a, t_clear,
                        working_dist_mm=None):
    """Generate NFPA 70E DC arc flash warning label text.

    Args:
        bus_name: Name of the bus.
        voltage_v: DC system voltage in volts.
        energy: Incident energy in cal/cm².
        boundary_mm: Arc flash boundary in mm.
        ppe_cat: PPE category number.
        ppe_name: PPE category name string.
        ppe_desc: PPE description string.
        ibf_ka: Bolted fault current in kA.
        iarc_a: DC arcing current in amperes.
        t_clear: Clearing time in seconds.

    Returns:
        Formatted label string.
    """
    boundary_in = round(boundary_mm / 25.4, 1)
    boundary_ft = round(boundary_in / 12, 1)

    if ppe_cat == -1:
        header = "⚠ DANGER — DC ARC FLASH HAZARD"
    elif ppe_cat >= 3:
        header = "⚠ WARNING — DC ARC FLASH HAZARD"
    else:
        header = "⚡ CAUTION — DC ARC FLASH HAZARD"

    # [DA5] NFPA 70E §130.5(H), as the AC label (review AF6): incident energy
    # at its working distance plus the minimum arc rating, no PPE category.
    at_wd = f" at {working_dist_mm:.0f} mm" if working_dist_mm else ""
    label = f"""{header}
Equipment: {bus_name}
Nominal Voltage: {voltage_v:.0f} V DC
Arc Flash Boundary: {boundary_ft} ft ({boundary_mm:.0f} mm)
Incident Energy: {energy:.1f} cal/cm²{at_wd}
Minimum Arc Rating: {min_arc_rating_text(energy)}
Bolted Fault: {ibf_ka:.1f} kA
Arcing Current: {iarc_a:.0f} A (DC)
Clearing Time: {t_clear:.3f} s
Method: Stokes & Oppenlander (DC)"""

    return label
