"""DC arc flash analysis per Stokes & Oppenlander method and DGUV-I 203-077.

Implements the Stokes & Oppenlander (1985) empirical model for DC arc flash:
- DC arcing current estimation
- Arc voltage as a function of gap distance
- Incident energy via point-source spherical radiation model
- Arc flash boundary calculation
- PPE category per NFPA 70E Table 130.7(C)(15)(a)

References:
- Stokes, A.D. & Oppenlander, W.T. (1985), "Electric Arcs in Open Air",
  Journal of Physics D: Applied Physics, Vol. 18, pp. 53-60
- DGUV Information 203-077, "Thermal Hazards from Electric Fault Arcs"
- NFPA 70E-2021 "Standard for Electrical Safety in the Workplace"
- IEEE 1584-2018 Annex D (DC arc flash guidance)

Valid ranges:
  - DC system voltage: 48V to 1500V (typical battery/PV/DC distribution)
  - Bolted fault current: practical range for DC systems
  - Gap between conductors: 13mm to 152mm
  - Working distance: >= 305mm
  - Fault clearing time: up to 2 seconds
"""

import math
from dataclasses import dataclass, field

from .arcflash import get_clearing_time, _get_ppe, PPE_CATEGORIES


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
    warning: str = ""
    label_html: str = ""         # Pre-formatted NFPA 70E label HTML
    recommendations: list = field(default_factory=list)


@dataclass
class DCArcFlashResults:
    """Complete DC arc flash analysis results."""
    buses: dict                  # bus_id -> DCArcFlashBusResult
    method: str = "Stokes & Oppenlander (DC)"
    warnings: list = field(default_factory=list)


def calc_dc_arcing_current(ibf_a, v_dc, gap_mm):
    """Calculate DC arcing current per Stokes & Oppenlander model.

    The DC arc is modelled as a voltage source (arc voltage) in series with
    the system. The arc voltage is a function of the electrode gap:

        V_arc = 20 + 0.534 * gap_mm

    The arcing current is then derived from the available fault current
    and the ratio of system voltage to total circuit voltage. As a
    conservative industry simplification:

        I_arc = I_bf * V_system / (V_system + V_arc)

    This is clamped to a minimum of 0.5 * I_bf (conservative lower bound)
    to account for arc resistance uncertainty.

    Args:
        ibf_a: Bolted fault current in amperes (DC).
        v_dc: DC system voltage in volts.
        gap_mm: Gap between conductors in mm.

    Returns:
        DC arcing current in amperes.
    """
    if ibf_a <= 0 or v_dc <= 0:
        return 0.0

    v_arc = 20.0 + 0.534 * gap_mm

    # If system voltage is less than arc voltage, arc cannot sustain
    if v_dc <= v_arc:
        return 0.0

    # Resistance-based model: arc reduces available current
    iarc = ibf_a * v_dc / (v_dc + v_arc)

    # Conservative lower bound: never less than 50% of bolted fault
    iarc = max(iarc, 0.5 * ibf_a)

    # Cannot exceed bolted fault current
    iarc = min(iarc, ibf_a)

    return iarc


def calc_dc_incident_energy(iarc_a, gap_mm, t_clear_s, working_dist_mm):
    """Calculate DC incident energy per Stokes & Oppenlander spherical model.

    Uses point-source radiation in a sphere:

        V_arc = 20 + 0.534 * G          (arc voltage, volts)
        P_arc = V_arc * I_arc            (arc power, watts)
        E_arc = P_arc * t                (arc energy, joules)
        E_incident = E_arc / (4 * pi * D^2)   (J/m², D in metres)
        E_cal = E_incident / 41868       (convert J/m² to cal/cm²)

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

    v_arc = 20.0 + 0.534 * gap_mm
    p_arc = v_arc * iarc_a                     # watts
    e_arc = p_arc * t_clear_s                  # joules

    d_m = working_dist_mm / 1000.0             # convert mm to metres
    e_incident_jm2 = e_arc / (4.0 * math.pi * d_m ** 2)  # J/m²
    e_cal = e_incident_jm2 / 41868.0           # cal/cm²

    return max(0.0, e_cal)


def calc_dc_arc_flash_boundary(iarc_a, gap_mm, t_clear_s, threshold_cal=1.2):
    """Calculate DC arc flash boundary distance.

    The arc flash boundary is the distance at which incident energy equals
    the threshold (default 1.2 cal/cm² per NFPA 70E). Solved analytically
    from the spherical radiation model:

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

    v_arc = 20.0 + 0.534 * gap_mm
    e_arc = v_arc * iarc_a * t_clear_s  # joules

    # D in metres: E_threshold = E_arc / (4*pi*D^2 * 41868)
    # D^2 = E_arc / (4*pi*41868*threshold)
    d_sq = e_arc / (4.0 * math.pi * 41868.0 * threshold_cal)

    if d_sq <= 0:
        return 0.0

    d_m = math.sqrt(d_sq)
    d_mm = d_m * 1000.0

    return round(d_mm, 0)


def run_dc_arc_flash(project_data, fault_results):
    """Run DC arc flash analysis using fault analysis results.

    Iterates over all buses in the project, calculates DC arcing current,
    incident energy, arc flash boundary, and PPE category per the
    Stokes & Oppenlander method.

    Args:
        project_data: ProjectData with all components and wires.
        fault_results: FaultResults from prior fault analysis.

    Returns:
        DCArcFlashResults with per-bus DC arc flash calculations.
    """
    components = {c.id: c for c in project_data.components}
    buses = {c.id: c for c in project_data.components if c.type == "bus"}

    # Build adjacency from wires
    adjacency = {}
    for w in project_data.wires:
        fc, tc = w.fromComponent, w.toComponent
        if fc not in adjacency:
            adjacency[fc] = []
        if tc not in adjacency:
            adjacency[tc] = []
        adjacency[fc].append((tc, w.fromPort, w.toPort))
        adjacency[tc].append((fc, w.toPort, w.fromPort))

    results = {}
    warnings = []

    for bus_id, bus in buses.items():
        voltage_kv = float(bus.props.get("voltage_kv", 0.6))
        voltage_v = voltage_kv * 1000.0
        bus_name = bus.props.get("name", bus_id)
        working_dist = float(bus.props.get("working_distance_mm", 455))
        gap_mm = float(bus.props.get("gap_mm", 0)) or _get_dc_gap(voltage_kv)

        # Get bolted fault current from fault results
        fault_bus = fault_results.buses.get(bus_id)
        if not fault_bus or not fault_bus.ik3:
            warnings.append(
                f"No fault data for bus '{bus_name}' — run fault analysis first"
            )
            continue

        ibf_ka = fault_bus.ik3  # 3-phase / DC bolted fault current in kA
        ibf_a = ibf_ka * 1000.0

        # Validate DC applicability
        warn = ""
        if voltage_v > 1500:
            warn = (
                f"DC voltage {voltage_v:.0f}V exceeds typical DC range (> 1500V). "
                "Results may be unreliable — consult a specialist."
            )
        if voltage_v < 48:
            warn = (
                f"DC voltage {voltage_v:.0f}V is very low. "
                "Arc flash hazard is unlikely at this voltage level."
            )

        # DC arcing current
        iarc_a = calc_dc_arcing_current(ibf_a, voltage_v, gap_mm)

        if iarc_a <= 0:
            warnings.append(
                f"Bus '{bus_name}': DC voltage ({voltage_v:.0f}V) too low to "
                f"sustain an arc across {gap_mm:.0f} mm gap."
            )
            continue

        # Arc voltage
        v_arc = 20.0 + 0.534 * gap_mm

        # Clearing time from protection devices
        t_clear = get_clearing_time(bus, components, adjacency)

        # Incident energy at working distance
        e_cal = calc_dc_incident_energy(iarc_a, gap_mm, t_clear, working_dist)

        # Arc flash boundary
        afb = calc_dc_arc_flash_boundary(iarc_a, gap_mm, t_clear)

        # PPE category
        ppe_cat, ppe_name, ppe_desc = _get_ppe(e_cal)

        # Generate label
        label = _generate_dc_label(
            bus_name, voltage_v, e_cal, afb, ppe_cat,
            ppe_name, ppe_desc, ibf_ka, iarc_a, t_clear
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
            warning=warn,
            label_html=label,
        )

    # Generate recommendations for each bus
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
                        ppe_name, ppe_desc, ibf_ka, iarc_a, t_clear):
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

    label = f"""{header}
Equipment: {bus_name}
DC Voltage: {voltage_v:.0f} V
Incident Energy: {energy:.1f} cal/cm²
Arc Flash Boundary: {boundary_ft} ft ({boundary_mm:.0f} mm)
PPE: {ppe_name}
{ppe_desc}
Bolted Fault: {ibf_ka:.1f} kA
Arcing Current: {iarc_a:.0f} A (DC)
Clearing Time: {t_clear:.3f} s
Method: Stokes & Oppenlander (DC)"""

    return label
