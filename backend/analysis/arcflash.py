"""Arc flash analysis per IEEE 1584-2002.

Implements the IEEE 1584-2002 empirical model for calculating:
- Arcing current (kA) — Eq. 1 & 2
- Incident energy (cal/cm²) — Eq. 3-6
- Arc flash boundary (mm)
- PPE category per NFPA 70E Table 130.7(C)(15)(a)

References:
- IEEE 1584-2002 "Guide for Performing Arc-Flash Hazard Calculations"
- NFPA 70E "Standard for Electrical Safety in the Workplace"

Note: this engine implements the 2002 edition, NOT IEEE 1584-2018.
The 2018 electrode-configuration machinery (VCBB/HCB-specific
coefficients, intermediate arcing currents at 600 V / 2700 V / 14.3 kV
with interpolation, enclosure-size correction) is not implemented.
Electrode configuration is used only to distinguish open-air (VOA/HOA)
from enclosed (VCB/VCBB/HCB) equipment, which is the granularity the
2002 model supports (its K1 "open air" vs "box" factor).

Valid ranges (IEEE 1584-2002 §1.2):
  - Voltage: 208V to 15,000V (3-phase)
  - Frequency: 50/60 Hz
  - Bolted fault current: 700A to 106,000A
  - Gap between conductors: 13mm to 152mm (empirical model derivation;
    incident-energy normalisation per Eq. 3 is bounded 6.35-76.2mm)
  - Working distance: ≥ 305mm
  - Fault clearing time: up to 2 seconds
"""

import math
from collections import deque
from dataclasses import dataclass, field


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
# Note: "Category 0" was removed from NFPA 70E in the 2015 edition;
# below 1.2 cal/cm² no arc-rated PPE is required. The numeric category
# value 0 is retained for API compatibility.
PPE_CATEGORIES = [
    (0, 1.2, 0, "No arc-rated PPE required", "Below 1.2 cal/cm² — no arc-rated PPE required (NFPA 70E)"),
    (1.2, 4.0, 1, "Category 1", "Arc-rated shirt, pants, safety glasses"),
    (4.0, 8.0, 2, "Category 2", "Arc-rated shirt, pants, flash suit hood, hard hat"),
    (8.0, 25.0, 3, "Category 3", "Arc flash suit, hard hat, balaclava"),
    (25.0, 40.0, 4, "Category 4", "Multi-layer arc flash suit"),
    (40.0, 1e6, -1, "DANGER", "Exceeds 40 cal/cm² — Do not work energized"),
]


# Typical conductor gap (mm) by equipment class, IEEE 1584-2002 Table 4.
# The gap encodes the equipment class the incident-energy x-factor keys off
# (25 mm LV MCC/panel x=1.641; 32 mm LV switchgear x=1.473; 102/153 mm MV
# switchgear x=0.973; open-air uses the VOA/HOA config factors).
_GAP_BY_CLASS = {
    "lv_switchgear": 32,
    "lv_mcc_panel": 25,
    "lv_cable": 13,
    "mv_switchgear_5kv": 104,
    "mv_switchgear_15kv": 153,
    "open_air": 40,
}


def _get_gap(voltage_kv, equipment_class=None):
    """Get the conductor gap (mm) for a bus.

    An explicit equipment_class selects the IEEE 1584-2002 Table 4 gap
    (letting LV switchgear be distinguished from MCC/panel); otherwise the
    gap is inferred from the voltage level as before.
    """
    if equipment_class and equipment_class in _GAP_BY_CLASS:
        return _GAP_BY_CLASS[equipment_class]
    # Find closest match by voltage
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
    method: str = "IEEE 1584-2002"
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

    if voc_kv <= 1.0:
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
    if voc_kv <= 1.0:
        # LV: the standard's 85% second calculation (§5.5 applies < 1 kV)
        iarc_reduced = iarc * 0.85
    else:
        # MV: INTENTIONAL conservative extension beyond the standard — the
        # 2002 §5.5 85% second calculation is defined only below 1 kV, so
        # no reduced-current check is required here at all. A milder 0.90
        # variation is evaluated anyway to catch protection that slows down
        # near its pickup at MV. Deliberate; do NOT "fix" this to 0.85.
        iarc_reduced = iarc * 0.90

    return iarc, iarc_reduced


def calc_incident_energy(iarc_ka, voc_kv, t_arc_s, gap_mm, dist_mm,
                         config="VCB", enclosure_mm=508, grounded=False):
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
        config: Electrode configuration (open air vs enclosed only)
        enclosure_mm: Enclosure width/depth (mm) — accepted for API
            compatibility but UNUSED: the 2002 model has no
            enclosure-size correction (that is a 1584-2018 feature)

    Returns:
        Incident energy in cal/cm²
    """
    if iarc_ka <= 0 or t_arc_s <= 0:
        return 0.0

    # K1: configuration factor
    K1 = -0.792 if config in ("VOA", "HOA") else -0.555
    # K2: grounding factor (IEEE 1584-2002 Eq. 3): −0.113 for grounded
    # systems, 0 for ungrounded/high-resistance-grounded. Defaulting to 0
    # when the system grounding is unknown is conservative (overstates energy
    # by ~30% for grounded systems).
    K2 = -0.113 if grounded else 0

    # Normalized incident energy at 610mm, 0.2s (IEEE 1584-2002 Eq. 3)
    log_en = K1 + K2 + 1.081 * math.log10(iarc_ka) + 0.0011 * gap_mm
    en = 10 ** log_en  # J/cm²

    # Cf: calculation factor for voltage (IEEE 1584-2002 Eq. 6: 1.5 for ≤1kV, 1.0 above)
    cf = 1.5 if voc_kv <= 1.0 else 1.0

    # Distance exponent x (IEEE 1584-2002 Table 4)
    # The 2002 table is keyed by equipment class; the conductor gap
    # already encodes that class (25mm LV MCC/panel, 32mm LV switchgear,
    # 102/153mm MV switchgear) so it is reused as the signal here.
    if config in ("VOA", "HOA"):
        x_factor = 2.0  # Open air (all voltages)
    elif voc_kv <= 1.0:
        # LV enclosed: switchgear (gap ≥ 32mm) x=1.473; MCC/panel x=1.641
        x_factor = 1.473 if gap_mm >= 32 else 1.641
    else:
        x_factor = 0.973  # MV enclosed (5/15 kV switchgear)

    # Scale to actual time and distance (IEEE 1584-2002 Eq. 5)
    # E = 4.184 × Cf × En × (t/0.2) × (610/D)^x  → in J/cm²
    e_joules = 4.184 * cf * en * (t_arc_s / 0.2) * (610.0 / dist_mm) ** x_factor

    # Convert J/cm² to cal/cm²
    e_cal = e_joules / 4.184

    return max(0, e_cal)


def calc_arc_flash_boundary(iarc_ka, voc_kv, t_arc_s, gap_mm,
                            config="VCB", enclosure_mm=508,
                            threshold_cal=1.2, grounded=False):
    """Calculate arc flash boundary distance per IEEE 1584-2002.

    The arc flash boundary is the distance where incident energy
    equals the threshold (default 1.2 cal/cm² per NFPA 70E).

    Args:
        iarc_ka: Arcing current (kA)
        voc_kv: Open-circuit voltage (kV)
        t_arc_s: Arc duration (seconds)
        gap_mm: Conductor gap (mm)
        config: Electrode configuration
        enclosure_mm: Enclosure width (mm) — unused in the 2002 model
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
                                 config, enclosure_mm, grounded)
        if e > threshold_cal:
            low = mid
        else:
            high = mid
    return round((low + high) / 2, 0)


# Source component types — used to identify the upstream (source) side of a bus
_SOURCE_TYPES = {"utility", "generator", "solar_pv", "wind_turbine"}

# Circuit-breaker mechanical opening time (s) added on top of a relay operate
# time — a typical 3-5 cycle breaker opens in 60-100 ms.
_BREAKER_OPENING_TIME_S = 0.08

# Maximum clearing time per IEEE 1584 (2 s arc-sustainability assumption)
_MAX_CLEARING_TIME_S = 2.0

# ── gG fuse pre-arcing curves (IEC 60269) ────────────────────────────────
# Pre-arcing (minimum melting) time-current points: [current_A, time_s].
# Ported VERBATIM from frontend/js/constants.js FUSE_CURVES_GG so the arc
# flash engine and the frontend TCC display evaluate the same characteristic.
# One generic gG shape scaled per rating; the fast end is anchored so the
# pre-arcing time reaches 0.1 s at 8x In, satisfying the IEC 60269-1 0.1 s
# pre-arcing gate (previously ~0.17 s at the gate). Not the per-rating min/max
# corridor of IEC 60269-1 Table 4 — use manufacturer data for precise grading.
_FUSE_CURVES_GG = {
    16:  [[25, 600], [32, 100], [40, 30], [50, 8], [80, 1.5], [100, 0.5], [125, 0.1], [160, 0.04], [250, 0.01], [400, 0.004]],
    20:  [[32, 600], [40, 100], [50, 30], [63, 8], [100, 1.5], [125, 0.5], [160, 0.1], [200, 0.04], [315, 0.01], [500, 0.004]],
    25:  [[40, 600], [50, 100], [63, 30], [80, 8], [125, 1.5], [160, 0.5], [200, 0.1], [250, 0.04], [400, 0.01], [630, 0.004]],
    32:  [[50, 600], [63, 100], [80, 30], [100, 8], [160, 1.5], [200, 0.5], [250, 0.1], [315, 0.04], [500, 0.01], [800, 0.004]],
    40:  [[63, 600], [80, 100], [100, 30], [125, 8], [200, 1.5], [250, 0.5], [315, 0.1], [400, 0.04], [630, 0.01], [1000, 0.004]],
    50:  [[80, 600], [100, 100], [125, 30], [160, 8], [250, 1.5], [315, 0.5], [400, 0.1], [500, 0.04], [800, 0.01], [1250, 0.004]],
    63:  [[100, 600], [125, 100], [160, 30], [200, 8], [315, 1.5], [400, 0.5], [500, 0.1], [630, 0.04], [1000, 0.01], [1600, 0.004]],
    80:  [[125, 600], [160, 100], [200, 30], [250, 8], [400, 1.5], [500, 0.5], [630, 0.1], [800, 0.04], [1250, 0.01], [2000, 0.004]],
    100: [[160, 600], [200, 100], [250, 30], [315, 8], [500, 1.5], [630, 0.5], [800, 0.1], [1000, 0.04], [1600, 0.01], [2500, 0.004]],
    125: [[200, 600], [250, 100], [315, 30], [400, 8], [630, 1.5], [800, 0.5], [1000, 0.1], [1250, 0.04], [2000, 0.01], [3150, 0.004]],
    160: [[250, 600], [315, 100], [400, 30], [500, 8], [800, 1.5], [1000, 0.5], [1250, 0.1], [1600, 0.04], [2500, 0.01], [4000, 0.004]],
    200: [[315, 600], [400, 100], [500, 30], [630, 8], [1000, 1.5], [1250, 0.5], [1600, 0.1], [2000, 0.04], [3150, 0.01], [5000, 0.004]],
    250: [[400, 600], [500, 100], [630, 30], [800, 8], [1250, 1.5], [1600, 0.5], [2000, 0.1], [2500, 0.04], [4000, 0.01], [6300, 0.004]],
    315: [[500, 600], [630, 100], [800, 30], [1000, 8], [1600, 1.5], [2000, 0.5], [2500, 0.1], [3150, 0.04], [5000, 0.01], [8000, 0.004]],
    400: [[630, 600], [800, 100], [1000, 30], [1250, 8], [2000, 1.5], [2500, 0.5], [3150, 0.1], [4000, 0.04], [6300, 0.01], [10000, 0.004]],
    500: [[800, 600], [1000, 100], [1250, 30], [1600, 8], [2500, 1.5], [3150, 0.5], [4000, 0.1], [5000, 0.04], [8000, 0.01], [12500, 0.004]],
    630: [[1000, 600], [1250, 100], [1600, 30], [2000, 8], [3150, 1.5], [4000, 0.5], [5000, 0.1], [6300, 0.04], [10000, 0.01], [16000, 0.004]],
}

_FUSE_RATINGS_GG = sorted(_FUSE_CURVES_GG)


def _fuse_curve_points(rating_a):
    """gG pre-arcing curve points for an arbitrary rating.

    Mirrors frontend fuseCurvePoints(): tabulated ratings are returned
    directly; other ratings are ratio-scaled from the geometrically nearest
    standard curve (the table is one characteristic shape scaled per rating,
    so scaling is consistent with its construction). Returns None if the
    rating is invalid.
    """
    if not (rating_a > 0):
        return None
    key = int(rating_a)
    if key == rating_a and key in _FUSE_CURVES_GG:
        return _FUSE_CURVES_GG[key]
    best = min(_FUSE_RATINGS_GG, key=lambda r: abs(math.log(r / rating_a)))
    scale = rating_a / best
    return [[i * scale, t] for i, t in _FUSE_CURVES_GG[best]]


def _fuse_prearc_time(rating_a, current_a):
    """Fuse pre-arcing (melting) time by log-log interpolation of the
    characteristic points — same convention as frontend fuseTripTime().

    Returns math.inf below the minimum operating current, None if the
    rating is invalid.
    """
    points = _fuse_curve_points(rating_a)
    if not points:
        return None
    if current_a <= points[0][0]:
        return math.inf  # Below minimum operating current — fuse never melts
    if current_a >= points[-1][0]:
        return points[-1][1]
    for (i1, t1), (i2, t2) in zip(points, points[1:]):
        if i1 <= current_a <= i2:
            frac = (math.log10(current_a) - math.log10(i1)) / (math.log10(i2) - math.log10(i1))
            return 10 ** (math.log10(t1) + frac * (math.log10(t2) - math.log10(t1)))
    return points[-1][1]


# ── IDMT relay curves ────────────────────────────────────────────────────
# IEC 60255-151 / IEEE C37.112 constants, matching frontend/js/constants.js
# IDMT_CURVES:  t = TDS × (k / (M^a − 1) + c)   where M = I/Ipickup.
# 'Definite Time' is handled separately (t = time_dial seconds).
_IDMT_CURVES = {
    "IEC Standard Inverse": (0.14, 0.02, 0.0),
    "IEC Very Inverse": (13.5, 1.0, 0.0),
    "IEC Extremely Inverse": (80.0, 2.0, 0.0),
    "IEC Long Time Inverse": (120.0, 1.0, 0.0),
    "IEEE Moderately Inverse": (0.0515, 0.02, 0.114),
    "IEEE Very Inverse": (19.61, 2.0, 0.491),
    "IEEE Extremely Inverse": (28.2, 2.0, 0.1217),
}


def _relay_operate_time(props, current_a):
    """Operate time (s) of an overcurrent relay at current_a (primary amps).

    Evaluates the relay's IDMT curve (curve/pickup_a/time_dial) and its
    instantaneous (50) element (inst_pickup_a/inst_delay_s, 0 = disabled),
    matching the frontend idmtTripTime() convention. Returns None when the
    relay never trips at this current (I ≤ pickup and no instantaneous).
    """
    try:
        pickup = float(props.get("pickup_a", 100) or 0)
        tds = float(props.get("time_dial", 1.0) or 0)
        inst_pickup = float(props.get("inst_pickup_a", 0) or 0)
    except (TypeError, ValueError):
        return None
    inst_delay = props.get("inst_delay_s")
    inst_delay = 0.05 if inst_delay is None else float(inst_delay)
    curve = props.get("curve", "IEC Standard Inverse")

    t = None
    if pickup > 0 and current_a > pickup:
        if curve == "Definite Time":
            t = tds  # time_dial is the fixed operate delay in seconds
        elif curve in _IDMT_CURVES:
            k, a, c = _IDMT_CURVES[curve]
            m = current_a / pickup
            t = tds * (k / (m ** a - 1) + c)
    # Instantaneous (50) element overrides when picked up
    if inst_pickup > 0 and current_a >= inst_pickup:
        t = inst_delay if t is None else min(t, inst_delay)
    return t


def _build_relay_maps(components):
    """Map CT ids and CB ids to the overcurrent relay associated with them.

    Relays have no ports (they never appear in the wire graph) — they are
    resolved via their association props: associated_ct (measuring CT on the
    wire path) and trip_cb (CB the relay trips). Only phase-overcurrent
    relays (50/51, 67 — the default relay_type is 50/51) are considered:
    earth-fault (50N/51N), differential (87) and distance (21) elements do
    not carry the IDMT phase-curve semantics evaluated here.
    """
    relay_by_ct = {}
    relay_by_cb = {}
    for comp in components.values():
        if comp.type != "relay":
            continue
        if comp.props.get("relay_type", "50/51") not in ("50/51", "67"):
            continue
        ct_id = comp.props.get("associated_ct")
        cb_id = comp.props.get("trip_cb")
        if ct_id:
            relay_by_ct[ct_id] = comp
        if cb_id:
            relay_by_cb[cb_id] = comp
    return relay_by_ct, relay_by_cb


def _leads_to_source(start_id, bus_id, components, adjacency):
    """Return True if a source is reachable from start_id without passing
    back through bus_id (i.e. the component sits on the source side of the bus)."""
    visited = {bus_id, start_id}
    stack = [start_id]
    while stack:
        nid = stack.pop()
        comp = components.get(nid)
        if not comp:
            continue
        if comp.type in _SOURCE_TYPES:
            return True
        # An open CB/switch carries no fault current — it cannot connect the
        # bus to a source, so do not traverse through it (mirrors fault.py).
        if comp.type in ("cb", "switch") and comp.props.get("state") == "open":
            continue
        for neighbor_id, _, _ in adjacency.get(nid, []):
            if neighbor_id not in visited:
                visited.add(neighbor_id)
                stack.append(neighbor_id)
    return False


def _cb_self_clearing_time(props, current_a):
    """Clearing time of a CB from its own trip-unit model.

    [PROT-11] Mirrors the frontend cbTripTime() priority (constants.js):

      ACB (electronic trip unit), referenced to Ir = trip_rating × thermal_pickup:
        1. instantaneous:  instantaneous_pickup > 0 and I ≥ Ii×Ir → ~0.05 s
        2. short-time:     short_time_pickup > 0 and I ≥ Isd×Ir
                           → short_time_delay + breaker opening time
                           (an ST-only ZSI/selectivity setup clears at the
                           intentional ST delay, NOT instantaneously)
      All types (MCCB magnetic / ACB fallback):
        3. magnetic:       I ≥ magnetic_pickup×Ir → 0.05 s
        4. thermal region: long-time delay bucket heuristic (a proper
           evaluation of the full device TCC is not implemented)
    """
    trip_rating = float(props.get("trip_rating_a", 630))
    thermal_pickup = float(props.get("thermal_pickup", 1.0) or 1.0)
    ir = trip_rating * thermal_pickup  # primary amps at pickup
    magnetic_pickup = float(props.get("magnetic_pickup", 10))

    # ACB electronic-trip short-time / instantaneous settings (×Ir)
    if props.get("cb_type", "mccb") == "acb":
        inst_pickup = float(props.get("instantaneous_pickup", 0) or 0) * ir
        st_pickup = float(props.get("short_time_pickup", 0) or 0) * ir
        st_delay = float(props.get("short_time_delay", 0.1) or 0.1)
        if inst_pickup > 0 and current_a >= inst_pickup:
            return 0.05  # instantaneous incl. breaker operating time
        if st_pickup > 0 and current_a >= st_pickup:
            # Intentional short-time delay + breaker opening time
            return st_delay + _BREAKER_OPENING_TIME_S

    inst_threshold = ir * magnetic_pickup  # primary amps
    if current_a > 0 and current_a >= inst_threshold:
        # Instantaneous trip incl. breaker operating time
        return 0.05
    # Below instantaneous pickup: time-delayed trip estimated
    # from the long-time delay setting (crude bucket heuristic)
    lt_delay = float(props.get("long_time_delay", 10))
    if lt_delay <= 5:
        return 0.5
    elif lt_delay <= 10:
        return 1.0
    return 2.0


def _device_clearing_time(comp, current_a, relay_by_ct, relay_by_cb):
    """Clearing time (s) of a single protective element at current_a
    (primary amps at the device's voltage level), capped at 2.0 s.

    - CT with an associated relay: the relay's curve governs
      (relay operate time + breaker opening time).
    - CB tripped by a relay (trip_cb): the relay's curve governs INSTEAD
      of the CB's own thermal-magnetic model.
    - CB without a relay: thermal-magnetic model.
    - Fuse: gG pre-arcing curve evaluated at the arcing current, × 1.2
      for total clearing time (IEC 60269 practice, matching the frontend
      TCC convention); 2.0 s when the current is below the curve's
      minimum operating point.
    A relay that never picks up (I ≤ pickup, no instantaneous) leaves the
    path unprotected → 2.0 s.
    """
    if comp.type == "ct":
        relay = relay_by_ct.get(comp.id)
        t = _relay_operate_time(relay.props, current_a) if relay else None
        if t is None:
            return _MAX_CLEARING_TIME_S
        return min(t + _BREAKER_OPENING_TIME_S, _MAX_CLEARING_TIME_S)

    if comp.type == "cb":
        relay = relay_by_cb.get(comp.id)
        if relay is not None:
            t = _relay_operate_time(relay.props, current_a)
            if t is None:
                return _MAX_CLEARING_TIME_S
            return min(t + _BREAKER_OPENING_TIME_S, _MAX_CLEARING_TIME_S)
        return min(_cb_self_clearing_time(comp.props, current_a),
                   _MAX_CLEARING_TIME_S)

    if comp.type == "fuse":
        rating = float(comp.props.get("rated_current_a", 100) or 0)
        t_pre = _fuse_prearc_time(rating, current_a)
        if t_pre is None or math.isinf(t_pre):
            return _MAX_CLEARING_TIME_S
        # Pre-arc → total clearing: × 1.2 (project convention, tcc.js).
        # No lower floor: fuses genuinely clear in < 10 ms deep in the
        # current-limiting region.
        return min(t_pre * 1.2, _MAX_CLEARING_TIME_S)

    return _MAX_CLEARING_TIME_S


def get_clearing_time(bus, components, adjacency, iarc_ka=None):
    """Estimate fault clearing time from upstream protection devices.

    BFS from the faulted bus toward the source(s): the walk passes through
    non-device components (cables, buses, closed switches, CTs without
    relays, PTs, transformers, ...) and stops each branch at the NEAREST
    protective element found on it — a CB, a fuse, or a CT whose associated
    relay measures that path. Transformers are traversable (an upstream
    primary-side CB legitimately clears a secondary-side bus fault through
    the transformer), with the arcing current referred across the winding
    ratio (I_device = Iarc × V_bus / V_device, as the frontend TCC does).

    Only devices on the source side of the bus are considered — a
    downstream feeder breaker carries no bus-fault current and cannot
    clear a bus fault. A device is treated as upstream when a source
    (utility/generator/PV/wind) is reachable from it without passing
    back through the faulted bus. Open CBs/switches block the walk.

    Relays are resolved via their association props (associated_ct /
    trip_cb) since they have no ports and never appear in the wire graph;
    when a relay governs a device its IDMT curve is evaluated at the
    arcing current plus breaker opening time.

    Conservative assumption: with multiple upstream infeeds the arc is
    fed until the SLOWEST infeed path clears, so the maximum clearing
    time across infeed paths is used. An infeed path that reaches a
    source with no protective element on it — or whose relay never picks
    up at Iarc — counts as unprotected (2.0 s, the IEEE 1584 maximum).
    Falls back to 2.0 s when no upstream device is found.
    """
    iarc_a = (iarc_ka or 0) * 1000
    v_bus = float(bus.props.get("voltage_kv", 11) or 11)
    relay_by_ct, relay_by_cb = _build_relay_maps(components)

    path_times = []
    visited = {bus.id}
    queue = deque()
    for neighbor_id, _, _ in adjacency.get(bus.id, []):
        if neighbor_id not in visited:
            visited.add(neighbor_id)
            queue.append((neighbor_id, v_bus))

    while queue:
        nid, v_here = queue.popleft()
        comp = components.get(nid)
        if not comp:
            continue
        # An open device carries no fault current — it cannot connect the
        # bus to a source or clear the fault, so it blocks the walk.
        if comp.type in ("cb", "switch") and comp.props.get("state") == "open":
            continue
        if comp.type in _SOURCE_TYPES:
            # Source reached with no protective element on this infeed
            # path — the arc is fed for the full IEEE 1584 maximum.
            path_times.append(_MAX_CLEARING_TIME_S)
            continue

        is_device = comp.type in ("cb", "fuse") or (
            comp.type == "ct" and nid in relay_by_ct)
        if is_device:
            # Skip downstream feeder devices — they do not clear a bus fault
            if not _leads_to_source(nid, bus.id, components, adjacency):
                continue
            # Refer the arcing current to the device's voltage level
            i_dev = iarc_a * v_bus / v_here if v_here > 0 else iarc_a
            path_times.append(
                _device_clearing_time(comp, i_dev, relay_by_ct, relay_by_cb))
            continue  # nearest device found — stop this branch

        # Transparent element — keep walking; track the voltage level
        # across transformers for current referral.
        v_next = v_here
        if comp.type == "transformer":
            hv = float(comp.props.get("voltage_hv_kv", 11) or 0)
            lv = float(comp.props.get("voltage_lv_kv", 0.4) or 0)
            if hv > 0 and lv > 0:
                v_next = hv if abs(v_here - lv) < abs(v_here - hv) else lv
        for neighbor_id, _, _ in adjacency.get(nid, []):
            if neighbor_id not in visited:
                visited.add(neighbor_id)
                queue.append((neighbor_id, v_next))

    if not path_times:
        return _MAX_CLEARING_TIME_S  # Maximum clearing time per IEEE 1584

    # Slowest infeed path governs (conservative for multi-infeed buses)
    return min(max(path_times), _MAX_CLEARING_TIME_S)


def run_arc_flash(project_data, fault_results):
    """Run arc flash analysis using fault analysis results.

    Args:
        project_data: ProjectData with all components
        fault_results: FaultResults from prior fault analysis

    Returns:
        ArcFlashResults
    """
    components = {c.id: c for c in project_data.components}
    buses = {c.id: c for c in project_data.components if c.type == "bus" and str(c.props.get("system", "ac")).lower() != "dc"}

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

        # [gap #7] Conductor gap: an explicit per-bus override wins, then the
        # equipment class (so LV switchgear 32 mm vs MCC/panel 25 mm can be
        # modelled), else inferred from voltage.
        equipment_class = bus.props.get("equipment_class") or None
        gap_override = float(bus.props.get("conductor_gap_mm", 0) or 0)
        gap_mm = gap_override if gap_override > 0 else _get_gap(voltage_kv, equipment_class)

        # Validate IEEE 1584 applicability — collect all warnings (not just the last)
        validity_warnings = []
        ibf_a = ibf_ka * 1000
        # [EE-10] 700 A model floor per IEEE 1584-2002 §1.2 (and the module
        # header) — the previous 500 A check under-warned
        if ibf_a < 700:
            validity_warnings.append("Below IEEE 1584 range (< 700A)")
        elif ibf_a > 106000:
            validity_warnings.append("Above IEEE 1584 range (> 106kA)")
        if voltage_kv > 15:
            validity_warnings.append(f"Voltage {voltage_kv}kV exceeds IEEE 1584 range (≤ 15kV)")
        if voltage_kv < 0.208:
            validity_warnings.append(f"Voltage {voltage_kv}kV below IEEE 1584 range (≥ 208V)")
        if gap_mm < 6.35 or gap_mm > 76.2:
            validity_warnings.append(
                f"Gap {gap_mm}mm outside IEEE 1584-2002 incident-energy model "
                "range (6.35-76.2mm) — results extrapolated"
            )
        warn = "; ".join(validity_warnings)

        # System grounding for the K2 factor (IEEE 1584-2002 Eq. 3). Unknown
        # → treated as ungrounded (K2=0), which is conservative.
        grounded = str(bus.props.get("system_grounded", "unknown")).lower() in (
            "grounded", "solidly", "effectively", "yes", "true")

        # Calculate arcing current
        iarc, iarc_reduced = calc_arcing_current(ibf_ka, voltage_kv, gap_mm,
                                                  electrode_config)

        # Estimate clearing time from upstream protection devices,
        # using the arcing current to resolve instantaneous vs delayed trips
        t_clear = get_clearing_time(bus, components, adjacency, iarc)

        # Incident energy at working distance
        e_cal = calc_incident_energy(iarc, voltage_kv, t_clear, gap_mm,
                                     working_dist, electrode_config,
                                     enclosure_mm, grounded)

        # Reduced arcing current check (IEEE 1584-2002 §5.5): the lower current
        # may sit below instantaneous pickups, slowing protection. Re-evaluate
        # the actual protective-device TCC at the reduced current rather than
        # scaling t_clear by a fixed heuristic — the true ratio for an IDMT
        # relay near pickup can be several×, not 1.5×.
        t_clear_reduced = get_clearing_time(bus, components, adjacency,
                                            iarc_reduced)
        e_cal_reduced = calc_incident_energy(iarc_reduced, voltage_kv,
                                              t_clear_reduced, gap_mm,
                                              working_dist, electrode_config,
                                              enclosure_mm, grounded)

        # Use worst case (higher energy)
        e_worst = max(e_cal, e_cal_reduced)

        # Arc flash boundary — evaluate for both the full and reduced arcing
        # current (the reduced current clears more slowly, so it can push the
        # boundary further out) and report the worst (largest) distance.
        afb_full = calc_arc_flash_boundary(iarc, voltage_kv, t_clear, gap_mm,
                                           electrode_config, enclosure_mm,
                                           grounded=grounded)
        afb_reduced = calc_arc_flash_boundary(iarc_reduced, voltage_kv,
                                              t_clear_reduced, gap_mm,
                                              electrode_config, enclosure_mm,
                                              grounded=grounded)
        afb = max(afb_full, afb_reduced)

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
Method: IEEE 1584-2002"""

    return label
