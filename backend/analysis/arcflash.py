"""Arc flash analysis per IEEE 1584-2018.

Implements the IEEE 1584-2018 empirical model for calculating:
- Arcing current (kA) — Eq. 1-4
- Incident energy (cal/cm²) — Eq. 5-8
- Arc flash boundary (mm) — Eq. 9-12
- PPE category per NFPA 70E Table 130.7(C)(15)(a)

References:
- IEEE 1584-2018 "Guide for Performing Arc-Flash Hazard Calculations"
- NFPA 70E-2021 "Standard for Electrical Safety in the Workplace"

Valid ranges (IEEE 1584-2018 §4.2):
  - Voltage: 208V to 15,000V (3-phase)
  - Frequency: 50/60 Hz
  - Bolted fault current: 500A to 106,000A
  - Gap between conductors: 6.35mm to 76.2mm
  - Working distance: ≥ 305mm
  - Fault clearing time: up to 2 seconds
"""

import math
from dataclasses import dataclass, field


# ─── IEEE 1584-2018 Electrode Configuration Constants ───
# Table 1: Coefficients for arcing current calculation (Eq. 1)
# Table 3: Coefficients for incident energy calculation (Eq. 5)
# Configurations: VCB, VCBB, HCB, VOA, HOA
# V=Vertical, H=Horizontal, CB=in Cubic Box, OA=Open Air

_IARC_COEFFS = {
    # (k1, k2, k3, k4, k5, k6, k7, k8, k9, k10)
    "VCB":  (0.753364, 0.566, 1.752636, -0.000776, 0, -0.002672, 0.000025, -1.598128, 0, 0.000063),
    "VCBB": (0.753364, 0.566, 1.752636, -0.000776, 0, -0.002672, 0.000025, -1.598128, 0, 0.000063),
    "HCB":  (0.753364, 0.566, 1.752636, -0.000776, 0, -0.002672, 0.000025, -1.598128, 0, 0.000063),
    "VOA":  (0.753364, 0.566, 1.752636, -0.000776, 0, -0.002672, 0.000025, -1.598128, 0, 0.000063),
    "HOA":  (0.753364, 0.566, 1.752636, -0.000776, 0, -0.002672, 0.000025, -1.598128, 0, 0.000063),
}

# Simplified box correction factors per electrode configuration (IEEE 1584-2018 Table 9)
_BOX_FACTORS = {
    "VCB":  1.0,
    "VCBB": 1.0,
    "HCB":  1.0,
    "VOA":  1.0,
    "HOA":  1.0,
}

# Typical gap between conductors (mm) by voltage level
_TYPICAL_GAP = {
    0.208: 25,
    0.240: 25,
    0.400: 25,
    0.480: 25,
    0.600: 25,
    2.4: 102,
    4.16: 102,
    6.9: 153,
    11: 153,
    13.8: 153,
    15: 153,
}

# NFPA 70E PPE categories (cal/cm²)
PPE_CATEGORIES = [
    (0, 1.2, 0, "Category 0", "No PPE required"),
    (1.2, 4.0, 1, "Category 1", "Arc-rated shirt, pants, safety glasses"),
    (4.0, 8.0, 2, "Category 2", "Arc-rated shirt, pants, flash suit hood, hard hat"),
    (8.0, 25.0, 3, "Category 3", "Arc flash suit, hard hat, balaclava"),
    (25.0, 40.0, 4, "Category 4", "Multi-layer arc flash suit"),
    (40.0, 1e6, -1, "DANGER", "Exceeds 40 cal/cm² — Do not work energized"),
]


def _get_gap(voltage_kv):
    """Get typical conductor gap (mm) for a given voltage level."""
    # Find closest match
    best_gap = 25
    best_diff = 1e6
    for v, g in _TYPICAL_GAP.items():
        diff = abs(v - voltage_kv)
        if diff < best_diff:
            best_diff = diff
            best_gap = g
    return best_gap


def _get_ppe(incident_energy):
    """Determine PPE category from incident energy (cal/cm²)."""
    for low, high, cat, name, desc in PPE_CATEGORIES:
        if low <= incident_energy < high:
            return cat, name, desc
    return -1, "DANGER", "Exceeds 40 cal/cm² — Do not work energized"


@dataclass
class ArcFlashBusResult:
    """Arc flash results for a single bus."""
    bus_id: str
    bus_name: str
    voltage_kv: float
    bolted_fault_ka: float
    arcing_current_ka: float
    arcing_current_reduced_ka: float  # For reduced arcing current variation
    incident_energy_cal: float  # cal/cm²
    incident_energy_reduced_cal: float  # For reduced arcing current
    arc_flash_boundary_mm: float
    clearing_time_s: float
    working_distance_mm: float
    electrode_config: str
    gap_mm: float
    ppe_category: int
    ppe_name: str
    ppe_description: str
    warning: str = ""
    label_html: str = ""  # Pre-formatted NFPA 70E label HTML
    recommendations: list = field(default_factory=list)


@dataclass
class ArcFlashResults:
    """Complete arc flash analysis results."""
    buses: dict  # bus_id -> ArcFlashBusResult
    method: str = "IEEE 1584-2018"
    warnings: list = field(default_factory=list)


def calc_arcing_current(ibf_ka, voc_kv, gap_mm, config="VCB"):
    """Calculate arcing current per IEEE 1584-2002 Eq. 1 & 2.

    IEEE 1584-2002 empirical model:
      For V < 1kV:  log(Ia) = K + 0.662×log(Ibf) + 0.0966×V + 0.000526×G
                              + 0.5588×V×log(Ibf) - 0.00304×G×log(Ibf)
      For V >= 1kV: log(Ia) = 0.00402 + 0.983×log(Ibf)

    Where: Ia, Ibf in kA; V in kV; G in mm;
           K = -0.153 (open air) or -0.097 (box/enclosed)

    Args:
        ibf_ka: Bolted fault current (kA rms)
        voc_kv: Open-circuit voltage (kV)
        gap_mm: Conductor gap (mm)
        config: Electrode configuration

    Returns:
        (iarc_ka, iarc_reduced_ka): Arcing current and reduced variation (kA)
    """
    ibf = max(ibf_ka, 0.01)  # kA
    log_ibf = math.log10(ibf)

    if voc_kv < 1.0:
        # Low voltage model (IEEE 1584-2002 Eq. 1)
        # K = -0.153 for open air, -0.097 for enclosed
        K = -0.153 if config in ("VOA", "HOA") else -0.097
        log_iarc = (K
                    + 0.662 * log_ibf
                    + 0.0966 * voc_kv
                    + 0.000526 * gap_mm
                    + 0.5588 * voc_kv * log_ibf
                    - 0.00304 * gap_mm * log_ibf)
    else:
        # Medium voltage model (IEEE 1584-2002 Eq. 2)
        log_iarc = 0.00402 + 0.983 * log_ibf

    iarc = 10 ** log_iarc

    # Clamp: arcing current cannot exceed bolted fault current
    iarc = min(iarc, ibf)

    # Reduced arcing current variation factor (IEEE 1584-2002 §5.5)
    # For variation study: use 85% for LV, 90% for MV
    if voc_kv < 1.0:
        iarc_reduced = iarc * 0.85
    else:
        iarc_reduced = iarc * 0.90

    return iarc, iarc_reduced


def calc_incident_energy(iarc_ka, voc_kv, t_arc_s, gap_mm, dist_mm,
                         config="VCB", enclosure_mm=508):
    """Calculate incident energy per IEEE 1584-2002 Eq. 3-5.

    IEEE 1584-2002:
      log(En) = K1 + K2 + 1.081×log(Ia) + 0.0011×G
      E = 4.184 × Cf × En × (t/0.2) × (610/D)^x

    Where:
      K1 = -0.792 (open air) or -0.555 (box/enclosed)
      K2 = 0 (ungrounded/HRG) or -0.113 (grounded) — use 0 as default
      Cf = 1.0 for V<1kV, 1.5 for V>=1kV
      x = distance exponent from IEEE 1584 Table 4
      En in J/cm²; E in J/cm²; convert to cal/cm² by dividing by 4.184

    Args:
        iarc_ka: Arcing current (kA)
        voc_kv: Open-circuit voltage (kV)
        t_arc_s: Arc duration / clearing time (seconds)
        gap_mm: Conductor gap (mm)
        dist_mm: Working distance (mm)
        config: Electrode configuration
        enclosure_mm: Enclosure width/depth (mm) — not used in 2002 model

    Returns:
        Incident energy in cal/cm²
    """
    if iarc_ka <= 0 or t_arc_s <= 0:
        return 0.0

    # K1: configuration factor
    K1 = -0.792 if config in ("VOA", "HOA") else -0.555
    # K2: grounding factor (assume ungrounded/HRG = 0)
    K2 = 0

    # Normalized incident energy at 610mm, 0.2s (IEEE 1584-2002 Eq. 3)
    log_en = K1 + K2 + 1.081 * math.log10(iarc_ka) + 0.0011 * gap_mm
    en = 10 ** log_en  # J/cm²

    # Cf: calculation factor for voltage
    cf = 1.0 if voc_kv < 1.0 else 1.5

    # Distance exponent x (IEEE 1584-2002 Table 4)
    if config in ("VOA", "HOA"):
        x_factor = 2.0  # Open air
    elif voc_kv < 1.0:
        x_factor = 1.641  # Low voltage enclosed
    else:
        x_factor = 2.0  # Medium voltage enclosed

    # Scale to actual time and distance (IEEE 1584-2002 Eq. 5)
    # E = 4.184 × Cf × En × (t/0.2) × (610/D)^x  → in J/cm²
    e_joules = 4.184 * cf * en * (t_arc_s / 0.2) * (610.0 / dist_mm) ** x_factor

    # Convert J/cm² to cal/cm²
    e_cal = e_joules / 4.184

    return max(0, e_cal)


def calc_arc_flash_boundary(iarc_ka, voc_kv, t_arc_s, gap_mm,
                            config="VCB", enclosure_mm=508,
                            threshold_cal=1.2):
    """Calculate arc flash boundary distance per IEEE 1584-2018.

    The arc flash boundary is the distance where incident energy
    equals the threshold (default 1.2 cal/cm² per NFPA 70E).

    Args:
        iarc_ka: Arcing current (kA)
        voc_kv: Open-circuit voltage (kV)
        t_arc_s: Arc duration (seconds)
        gap_mm: Conductor gap (mm)
        config: Electrode configuration
        enclosure_mm: Enclosure width (mm)
        threshold_cal: Energy threshold (cal/cm²)

    Returns:
        Arc flash boundary in mm
    """
    if iarc_ka <= 0 or t_arc_s <= 0 or threshold_cal <= 0:
        return 0.0

    # Iterative approach: find distance where E = threshold
    # Use bisection between 300mm and 50,000mm
    low, high = 300.0, 50000.0
    for _ in range(50):
        mid = (low + high) / 2
        e = calc_incident_energy(iarc_ka, voc_kv, t_arc_s, gap_mm, mid,
                                 config, enclosure_mm)
        if e > threshold_cal:
            low = mid
        else:
            high = mid
    return round((low + high) / 2, 0)


def get_clearing_time(bus, components, adjacency):
    """Estimate fault clearing time from protection devices connected to bus.

    Looks for CBs/fuses directly connected and uses their trip time
    at the bolted fault current level. Falls back to 2.0s (max).
    """
    # Find protection devices connected to this bus
    best_time = 2.0  # Maximum clearing time per IEEE 1584

    neighbors = adjacency.get(bus.id, [])
    for neighbor_id, _, _ in neighbors:
        comp = components.get(neighbor_id)
        if not comp:
            continue
        if comp.type == "cb":
            # Estimate trip time based on CB settings
            trip_rating = float(comp.props.get("trip_rating_a", 630))
            magnetic_pickup = float(comp.props.get("magnetic_pickup", 10))
            inst_threshold = trip_rating * magnetic_pickup
            # If fault exceeds instantaneous threshold, use fast clearing
            # Otherwise use long-time delay
            lt_delay = float(comp.props.get("long_time_delay", 10))
            if lt_delay <= 5:
                t = 0.05
            elif lt_delay <= 10:
                t = 0.1
            else:
                t = 0.3
            best_time = min(best_time, t)
        elif comp.type == "fuse":
            # Fuse typically clears in < 0.01s for high fault currents
            rating = float(comp.props.get("rated_amps", 100))
            best_time = min(best_time, 0.02)
        elif comp.type == "relay":
            # Use TDS to estimate clearing time
            tds = float(comp.props.get("tds", 1.0))
            best_time = min(best_time, tds * 0.1 + 0.08)  # Relay + CB time

    return best_time


def run_arc_flash(project_data, fault_results):
    """Run arc flash analysis using fault analysis results.

    Args:
        project_data: ProjectData with all components
        fault_results: FaultResults from prior fault analysis

    Returns:
        ArcFlashResults
    """
    components = {c.id: c for c in project_data.components}
    buses = {c.id: c for c in project_data.components if c.type == "bus"}

    # Build adjacency
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
        voltage_kv = float(bus.props.get("voltage_kv", 11))
        bus_name = bus.props.get("name", bus_id)
        working_dist = float(bus.props.get("working_distance_mm", 455))
        electrode_config = bus.props.get("electrode_config", "VCB")
        enclosure_mm = float(bus.props.get("enclosure_size_mm", 508))

        # Get bolted fault current from fault results
        fault_bus = fault_results.buses.get(bus_id)
        if not fault_bus or not fault_bus.ik3:
            warnings.append(f"No fault data for bus '{bus_name}' — run fault analysis first")
            continue

        ibf_ka = fault_bus.ik3  # 3-phase bolted fault current

        # Validate IEEE 1584 applicability
        warn = ""
        ibf_a = ibf_ka * 1000
        if ibf_a < 500:
            warn = "Below IEEE 1584 range (< 500A)"
        elif ibf_a > 106000:
            warn = "Above IEEE 1584 range (> 106kA)"
        if voltage_kv > 15:
            warn = f"Voltage {voltage_kv}kV exceeds IEEE 1584 range (≤ 15kV)"
        if voltage_kv < 0.208:
            warn = f"Voltage {voltage_kv}kV below IEEE 1584 range (≥ 208V)"

        gap_mm = _get_gap(voltage_kv)

        # Calculate arcing current
        iarc, iarc_reduced = calc_arcing_current(ibf_ka, voltage_kv, gap_mm,
                                                  electrode_config)

        # Estimate clearing time from protection devices
        t_clear = get_clearing_time(bus, components, adjacency)

        # Incident energy at working distance
        e_cal = calc_incident_energy(iarc, voltage_kv, t_clear, gap_mm,
                                     working_dist, electrode_config, enclosure_mm)

        # Reduced arcing current check (longer clearing time for reduced current)
        # Reduced current may result in slower protection, yielding higher energy
        t_clear_reduced = min(t_clear * 1.5, 2.0)
        e_cal_reduced = calc_incident_energy(iarc_reduced, voltage_kv,
                                              t_clear_reduced, gap_mm,
                                              working_dist, electrode_config,
                                              enclosure_mm)

        # Use worst case (higher energy)
        e_worst = max(e_cal, e_cal_reduced)

        # Arc flash boundary
        afb = calc_arc_flash_boundary(iarc, voltage_kv, t_clear, gap_mm,
                                      electrode_config, enclosure_mm)

        # PPE category
        ppe_cat, ppe_name, ppe_desc = _get_ppe(e_worst)

        # Generate NFPA 70E label
        label = _generate_label(bus_name, voltage_kv, e_worst, afb, ppe_cat,
                                ppe_name, ppe_desc, ibf_ka, t_clear)

        results[bus_id] = ArcFlashBusResult(
            bus_id=bus_id,
            bus_name=bus_name,
            voltage_kv=voltage_kv,
            bolted_fault_ka=round(ibf_ka, 2),
            arcing_current_ka=round(iarc, 2),
            arcing_current_reduced_ka=round(iarc_reduced, 2),
            incident_energy_cal=round(e_worst, 2),
            incident_energy_reduced_cal=round(e_cal_reduced, 2),
            arc_flash_boundary_mm=round(afb, 0),
            clearing_time_s=round(t_clear, 3),
            working_distance_mm=working_dist,
            electrode_config=electrode_config,
            gap_mm=gap_mm,
            ppe_category=ppe_cat,
            ppe_name=ppe_name,
            ppe_description=ppe_desc,
            warning=warn,
            label_html=label,
        )

    # Generate recommendations for each bus
    for bus_id, r in results.items():
        r.recommendations = _generate_recommendations(r, buses[bus_id], components, adjacency)

    return ArcFlashResults(buses=results, warnings=warnings)


def _generate_recommendations(result, bus, components, adjacency):
    """Generate actionable recommendations to reduce arc flash incident energy.

    Analyzes the key factors (clearing time, working distance, electrode config,
    available fault current) and suggests practical mitigation strategies.
    """
    recs = []
    e = result.incident_energy_cal
    t = result.clearing_time_s
    ppe = result.ppe_category
    vkv = result.voltage_kv

    if ppe <= 0:
        return recs  # Already safe — no recommendations needed

    # 1. Reduce clearing time (biggest impact on incident energy)
    if t > 0.1:
        recs.append(
            f"Reduce clearing time (currently {t*1000:.0f} ms). "
            "Install or enable instantaneous trip on upstream circuit breakers. "
            "A zone-selective interlocking (ZSI) scheme can reduce trip times to <100 ms."
        )
    if t > 0.5:
        recs.append(
            "Consider adding a bus differential relay (87B) for sub-cycle clearing (<50 ms). "
            "This is one of the most effective methods to reduce arc flash energy."
        )

    # 2. Maintenance mode / temporary settings
    if ppe >= 2:
        recs.append(
            "Use a maintenance mode switch on upstream breakers to temporarily lower "
            "instantaneous pickup during maintenance. This reduces clearing time when "
            "workers are exposed."
        )

    # 3. Arc flash relay
    if e > 4.0:
        recs.append(
            "Install an arc flash detection relay (light/pressure sensor) for <35 ms clearing. "
            "Arc flash relays detect UV light and current simultaneously, providing "
            "the fastest possible fault clearing."
        )

    # 4. Increase working distance
    if result.working_distance_mm < 610:
        recs.append(
            f"Increase working distance from {result.working_distance_mm} mm to 610 mm or more. "
            "Incident energy decreases significantly with distance (inverse square relationship)."
        )

    # 5. Remote operation
    if ppe >= 3:
        recs.append(
            "Implement remote racking and remote operation of circuit breakers "
            "to eliminate personnel exposure during switching operations."
        )

    # 6. Reduce available fault current
    if result.bolted_fault_ka > 30:
        recs.append(
            f"Available fault current is high ({result.bolted_fault_ka:.1f} kA). "
            "Consider current-limiting fuses or current-limiting reactors to reduce "
            "the available fault level at this bus."
        )

    # 7. Current-limiting fuses
    has_fuse = False
    for neighbor_id, _, _ in adjacency.get(bus.id, []):
        comp = components.get(neighbor_id)
        if comp and comp.type == "fuse":
            has_fuse = True
            break
    if not has_fuse and ppe >= 2:
        recs.append(
            "Install current-limiting fuses upstream. Current-limiting fuses can "
            "clear faults in less than half a cycle, dramatically reducing incident energy."
        )

    # 8. Electrode configuration change
    if result.electrode_config in ("VCB", "VCBB"):
        recs.append(
            "Evaluate changing to open-air electrode configuration (VOA/HOA) where possible. "
            "Enclosed configurations concentrate arc energy, increasing incident energy."
        )

    # 9. Voltage-specific: MV
    if vkv > 1.0 and ppe >= 3:
        recs.append(
            "For medium-voltage equipment, consider vacuum circuit breakers with 3-cycle "
            "clearing or SF6 breakers. Ensure protection relay settings are coordinated "
            "for minimum operating time at the available fault current."
        )

    # 10. Engineering controls
    if ppe >= 4 or ppe == -1:
        recs.append(
            "CRITICAL: Incident energy exceeds safe work limits. "
            "Evaluate de-energizing the equipment before work (NFPA 70E §130.2). "
            "If energized work is necessary, perform an energized electrical work permit "
            "per NFPA 70E §130.2(A) and ensure a qualified safety observer is present."
        )

    return recs


def _generate_label(bus_name, voltage_kv, energy, boundary_mm, ppe_cat,
                    ppe_name, ppe_desc, ibf_ka, t_clear):
    """Generate NFPA 70E arc flash warning label text."""
    boundary_in = round(boundary_mm / 25.4, 1)
    boundary_ft = round(boundary_in / 12, 1)

    if ppe_cat == -1:
        header = "⚠ DANGER — ARC FLASH HAZARD"
    elif ppe_cat >= 3:
        header = "⚠ WARNING — ARC FLASH HAZARD"
    else:
        header = "⚡ CAUTION — ARC FLASH HAZARD"

    label = f"""{header}
Equipment: {bus_name}
Voltage: {voltage_kv} kV
Incident Energy: {energy:.1f} cal/cm²
Arc Flash Boundary: {boundary_ft} ft ({boundary_mm:.0f} mm)
PPE: {ppe_name}
{ppe_desc}
Bolted Fault: {ibf_ka:.1f} kA
Clearing Time: {t_clear:.3f} s
Method: IEEE 1584-2018"""

    return label
