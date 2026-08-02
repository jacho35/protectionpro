"""IEC 60364-5-52 installed-ampacity tables — backend twin of the frontend copy.

These tables previously existed ONLY in ``frontend/js/constants.js`` (lines
221-305), where they drive the per-cable ampacity calculator in
``properties.js`` (``_recalcAmpacity`` / ``_applyAmpacity``). The backend never
needed them because ``cable_sizing.py`` consumes the already-derated
``props.ampacity.derated_a`` that the frontend calculator writes onto a cable
component.

The distribution-board circuit check cannot work that way: a board has tens of
ways and no user is going to run a modal calculator for each one, so the engine
has to derate for itself. Hence this port.

KEEP IN SYNC with ``frontend/js/constants.js`` — the tables are transcribed
verbatim, same values, same units, same reference conditions (30 °C ambient
air, 20 °C ground, 2.5 K·m/W soil, 0.7 m laying depth). This mirrors the
existing arrangement for ``cable_sizing.STANDARD_OVERHEAD_LINES``, which
carries the same "keep in sync with the frontend table" note.

Note this is a DIFFERENT table family to ``cable_sizing.STANDARD_CABLES``:
that one is a conductor R/X library on a 20 °C DC basis, this one is installed
current-carrying capacity. They are not interchangeable and values must never
be copied between them.
"""

from __future__ import annotations

# ─── Reference installation methods, IEC 60364-5-52 Table B.52.1 ───────────
# ``environment`` selects which ambient-correction column applies.
IEC_INSTALLATION_METHODS = {
    "A1": {"description": "Insulated conductors in conduit in thermally insulating wall", "environment": "air"},
    "A2": {"description": "Multi-core cable in conduit in thermally insulating wall", "environment": "air"},
    "B1": {"description": "Insulated conductors in conduit on wall or in trunking", "environment": "air"},
    "B2": {"description": "Multi-core cable in conduit on wall or in trunking", "environment": "air"},
    "C": {"description": "Single-core or multi-core cable direct on wall (clipped)", "environment": "air"},
    "D1": {"description": "Multi-core cable in underground ducts", "environment": "ground"},
    "D2": {"description": "Multi-core cable direct buried", "environment": "ground"},
    "E": {"description": "Single-core cables in free air on perforated tray (touching)", "environment": "air"},
    "F": {"description": "Single-core cables in free air on tray (spaced)", "environment": "air"},
    "G": {"description": "Single-core cables in free air spaced from wall (cleats)", "environment": "air"},
}

# ─── Base current-carrying capacity (A), Tables B.52.2–B.52.5 ──────────────
# {size_mm2: {method: {conductor_key: amps}}}, conductor_key = "<ins>_<cond>".
# Reference conditions: 30 °C ambient air, 20 °C ground, 2.5 K·m/W soil.
IEC_AMPACITY_TABLE = {
    1.5: {
        "A1": {"pvc_cu": 14.5, "xlpe_cu": 19.5, "pvc_al": None, "xlpe_al": None},
        "B1": {"pvc_cu": 17.5, "xlpe_cu": 23, "pvc_al": None, "xlpe_al": None},
        "C": {"pvc_cu": 22, "xlpe_cu": 26, "pvc_al": None, "xlpe_al": None},
    },
    2.5: {
        "A1": {"pvc_cu": 19.5, "xlpe_cu": 27, "pvc_al": None, "xlpe_al": None},
        "B1": {"pvc_cu": 24, "xlpe_cu": 31, "pvc_al": None, "xlpe_al": None},
        "C": {"pvc_cu": 30, "xlpe_cu": 36, "pvc_al": None, "xlpe_al": None},
    },
    4: {
        "A1": {"pvc_cu": 26, "xlpe_cu": 36, "pvc_al": None, "xlpe_al": None},
        "B1": {"pvc_cu": 32, "xlpe_cu": 42, "pvc_al": None, "xlpe_al": None},
        "C": {"pvc_cu": 40, "xlpe_cu": 49, "pvc_al": None, "xlpe_al": None},
    },
    6: {
        "A1": {"pvc_cu": 34, "xlpe_cu": 46, "pvc_al": None, "xlpe_al": None},
        "B1": {"pvc_cu": 41, "xlpe_cu": 54, "pvc_al": None, "xlpe_al": None},
        "C": {"pvc_cu": 51, "xlpe_cu": 63, "pvc_al": None, "xlpe_al": None},
    },
    10: {
        "A1": {"pvc_cu": 46, "xlpe_cu": 63, "pvc_al": None, "xlpe_al": None},
        "B1": {"pvc_cu": 57, "xlpe_cu": 75, "pvc_al": None, "xlpe_al": None},
        "C": {"pvc_cu": 70, "xlpe_cu": 86, "pvc_al": None, "xlpe_al": None},
    },
    16: {
        "A1": {"pvc_cu": 61, "xlpe_cu": 85, "pvc_al": 47, "xlpe_al": 65},
        "B1": {"pvc_cu": 76, "xlpe_cu": 100, "pvc_al": 57, "xlpe_al": 76},
        "C": {"pvc_cu": 94, "xlpe_cu": 115, "pvc_al": 71, "xlpe_al": 88},
        "D1": {"pvc_cu": 80, "xlpe_cu": 95, "pvc_al": 62, "xlpe_al": 73},
        "D2": {"pvc_cu": 87, "xlpe_cu": 102, "pvc_al": 67, "xlpe_al": 78},
    },
    25: {
        "A1": {"pvc_cu": 80, "xlpe_cu": 112, "pvc_al": 62, "xlpe_al": 86},
        "B1": {"pvc_cu": 101, "xlpe_cu": 133, "pvc_al": 78, "xlpe_al": 101},
        "C": {"pvc_cu": 124, "xlpe_cu": 150, "pvc_al": 95, "xlpe_al": 116},
        "D1": {"pvc_cu": 106, "xlpe_cu": 121, "pvc_al": 81, "xlpe_al": 93},
        "D2": {"pvc_cu": 114, "xlpe_cu": 131, "pvc_al": 87, "xlpe_al": 100},
        "E": {"pvc_cu": 131, "xlpe_cu": 161, "pvc_al": 100, "xlpe_al": 123},
        "F": {"pvc_cu": 146, "xlpe_cu": 182, "pvc_al": 112, "xlpe_al": 140},
    },
    35: {
        "A1": {"pvc_cu": 99, "xlpe_cu": 138, "pvc_al": 77, "xlpe_al": 107},
        "B1": {"pvc_cu": 125, "xlpe_cu": 164, "pvc_al": 96, "xlpe_al": 125},
        "C": {"pvc_cu": 154, "xlpe_cu": 185, "pvc_al": 118, "xlpe_al": 142},
        "D1": {"pvc_cu": 131, "xlpe_cu": 146, "pvc_al": 100, "xlpe_al": 113},
        "D2": {"pvc_cu": 138, "xlpe_cu": 157, "pvc_al": 107, "xlpe_al": 121},
        "E": {"pvc_cu": 162, "xlpe_cu": 200, "pvc_al": 124, "xlpe_al": 153},
        "F": {"pvc_cu": 181, "xlpe_cu": 226, "pvc_al": 139, "xlpe_al": 174},
    },
    50: {
        "A1": {"pvc_cu": 119, "xlpe_cu": 168, "pvc_al": 93, "xlpe_al": 130},
        "B1": {"pvc_cu": 151, "xlpe_cu": 198, "pvc_al": 117, "xlpe_al": 151},
        "C": {"pvc_cu": 188, "xlpe_cu": 225, "pvc_al": 144, "xlpe_al": 173},
        "D1": {"pvc_cu": 153, "xlpe_cu": 173, "pvc_al": 118, "xlpe_al": 133},
        "D2": {"pvc_cu": 161, "xlpe_cu": 185, "pvc_al": 124, "xlpe_al": 142},
        "E": {"pvc_cu": 196, "xlpe_cu": 242, "pvc_al": 150, "xlpe_al": 186},
        "F": {"pvc_cu": 219, "xlpe_cu": 275, "pvc_al": 168, "xlpe_al": 212},
    },
    70: {
        "A1": {"pvc_cu": 151, "xlpe_cu": 213, "pvc_al": 118, "xlpe_al": 165},
        "B1": {"pvc_cu": 192, "xlpe_cu": 253, "pvc_al": 149, "xlpe_al": 192},
        "C": {"pvc_cu": 238, "xlpe_cu": 283, "pvc_al": 183, "xlpe_al": 218},
        "D1": {"pvc_cu": 188, "xlpe_cu": 210, "pvc_al": 144, "xlpe_al": 162},
        "D2": {"pvc_cu": 197, "xlpe_cu": 225, "pvc_al": 152, "xlpe_al": 173},
        "E": {"pvc_cu": 251, "xlpe_cu": 310, "pvc_al": 192, "xlpe_al": 237},
        "F": {"pvc_cu": 281, "xlpe_cu": 353, "pvc_al": 216, "xlpe_al": 272},
    },
    95: {
        "A1": {"pvc_cu": 182, "xlpe_cu": 258, "pvc_al": 142, "xlpe_al": 200},
        "B1": {"pvc_cu": 232, "xlpe_cu": 306, "pvc_al": 179, "xlpe_al": 233},
        "C": {"pvc_cu": 289, "xlpe_cu": 344, "pvc_al": 222, "xlpe_al": 265},
        "D1": {"pvc_cu": 222, "xlpe_cu": 249, "pvc_al": 171, "xlpe_al": 191},
        "D2": {"pvc_cu": 236, "xlpe_cu": 268, "pvc_al": 182, "xlpe_al": 207},
        "E": {"pvc_cu": 304, "xlpe_cu": 377, "pvc_al": 233, "xlpe_al": 289},
        "F": {"pvc_cu": 341, "xlpe_cu": 430, "pvc_al": 261, "xlpe_al": 331},
    },
    120: {
        "A1": {"pvc_cu": 210, "xlpe_cu": 299, "pvc_al": 164, "xlpe_al": 232},
        "B1": {"pvc_cu": 269, "xlpe_cu": 354, "pvc_al": 206, "xlpe_al": 270},
        "C": {"pvc_cu": 337, "xlpe_cu": 400, "pvc_al": 259, "xlpe_al": 308},
        "D1": {"pvc_cu": 251, "xlpe_cu": 283, "pvc_al": 194, "xlpe_al": 218},
        "D2": {"pvc_cu": 270, "xlpe_cu": 306, "pvc_al": 208, "xlpe_al": 236},
        "E": {"pvc_cu": 352, "xlpe_cu": 437, "pvc_al": 269, "xlpe_al": 335},
        "F": {"pvc_cu": 396, "xlpe_cu": 500, "pvc_al": 304, "xlpe_al": 385},
    },
    150: {
        "A1": {"pvc_cu": 240, "xlpe_cu": 344, "pvc_al": 189, "xlpe_al": 265},
        "B1": {"pvc_cu": 309, "xlpe_cu": 407, "pvc_al": 236, "xlpe_al": 310},
        "C": {"pvc_cu": 388, "xlpe_cu": 459, "pvc_al": 299, "xlpe_al": 354},
        "D1": {"pvc_cu": 278, "xlpe_cu": 316, "pvc_al": 215, "xlpe_al": 244},
        "D2": {"pvc_cu": 300, "xlpe_cu": 343, "pvc_al": 232, "xlpe_al": 265},
        "E": {"pvc_cu": 406, "xlpe_cu": 504, "pvc_al": 311, "xlpe_al": 386},
        "F": {"pvc_cu": 456, "xlpe_cu": 577, "pvc_al": 351, "xlpe_al": 444},
    },
    185: {
        "A1": {"pvc_cu": 274, "xlpe_cu": 392, "pvc_al": 215, "xlpe_al": 304},
        "B1": {"pvc_cu": 353, "xlpe_cu": 464, "pvc_al": 271, "xlpe_al": 354},
        "C": {"pvc_cu": 447, "xlpe_cu": 527, "pvc_al": 344, "xlpe_al": 407},
        "D1": {"pvc_cu": 310, "xlpe_cu": 352, "pvc_al": 239, "xlpe_al": 272},
        "D2": {"pvc_cu": 337, "xlpe_cu": 384, "pvc_al": 260, "xlpe_al": 296},
        "E": {"pvc_cu": 467, "xlpe_cu": 581, "pvc_al": 358, "xlpe_al": 446},
        "F": {"pvc_cu": 526, "xlpe_cu": 668, "pvc_al": 404, "xlpe_al": 515},
    },
    240: {
        "A1": {"pvc_cu": 321, "xlpe_cu": 461, "pvc_al": 252, "xlpe_al": 358},
        "B1": {"pvc_cu": 415, "xlpe_cu": 546, "pvc_al": 319, "xlpe_al": 418},
        "C": {"pvc_cu": 530, "xlpe_cu": 621, "pvc_al": 408, "xlpe_al": 480},
        "D1": {"pvc_cu": 355, "xlpe_cu": 406, "pvc_al": 274, "xlpe_al": 314},
        "D2": {"pvc_cu": 388, "xlpe_cu": 442, "pvc_al": 300, "xlpe_al": 342},
        "E": {"pvc_cu": 553, "xlpe_cu": 689, "pvc_al": 424, "xlpe_al": 529},
        "F": {"pvc_cu": 625, "xlpe_cu": 795, "pvc_al": 481, "xlpe_al": 613},
    },
    300: {
        "A1": {"pvc_cu": 367, "xlpe_cu": 530, "pvc_al": 287, "xlpe_al": 411},
        "B1": {"pvc_cu": 475, "xlpe_cu": 629, "pvc_al": 365, "xlpe_al": 481},
        "C": {"pvc_cu": 610, "xlpe_cu": 715, "pvc_al": 470, "xlpe_al": 553},
        "D1": {"pvc_cu": 397, "xlpe_cu": 456, "pvc_al": 307, "xlpe_al": 353},
        "D2": {"pvc_cu": 435, "xlpe_cu": 498, "pvc_al": 336, "xlpe_al": 385},
        "E": {"pvc_cu": 637, "xlpe_cu": 795, "pvc_al": 488, "xlpe_al": 611},
        "F": {"pvc_cu": 720, "xlpe_cu": 920, "pvc_al": 554, "xlpe_al": 710},
    },
    400: {
        "A1": {"pvc_cu": 438, "xlpe_cu": 634, "pvc_al": 344, "xlpe_al": 492},
        "B1": {"pvc_cu": 571, "xlpe_cu": 754, "pvc_al": 438, "xlpe_al": 578},
        "C": {"pvc_cu": 739, "xlpe_cu": 860, "pvc_al": 570, "xlpe_al": 665},
        "E": {"pvc_cu": 772, "xlpe_cu": 964, "pvc_al": 591, "xlpe_al": 741},
        "F": {"pvc_cu": 878, "xlpe_cu": 1122, "pvc_al": 676, "xlpe_al": 866},
    },
}

# ─── Ambient temperature correction, Tables B.52.14/15 ─────────────────────
# Reference ambient: 30 °C air, 20 °C ground.
IEC_TEMP_CORRECTION = {
    "air": {
        "pvc": {10: 1.22, 15: 1.17, 20: 1.12, 25: 1.06, 30: 1.00, 35: 0.94,
                40: 0.87, 45: 0.79, 50: 0.71, 55: 0.61, 60: 0.50},
        "xlpe": {10: 1.15, 15: 1.12, 20: 1.08, 25: 1.04, 30: 1.00, 35: 0.96,
                 40: 0.91, 45: 0.87, 50: 0.82, 55: 0.76, 60: 0.71, 65: 0.65,
                 70: 0.58, 75: 0.50, 80: 0.41},
    },
    "ground": {
        "pvc": {10: 1.10, 15: 1.05, 20: 1.00, 25: 0.95, 30: 0.89, 35: 0.84,
                40: 0.77, 45: 0.71, 50: 0.63, 55: 0.55, 60: 0.45},
        "xlpe": {10: 1.07, 15: 1.04, 20: 1.00, 25: 0.96, 30: 0.93, 35: 0.89,
                 40: 0.85, 45: 0.80, 50: 0.76, 55: 0.71, 60: 0.65, 65: 0.60,
                 70: 0.53, 75: 0.46, 80: 0.38},
    },
}

# ─── Grouping correction, Table B.52.17 ────────────────────────────────────
# Key = number of circuits / multi-core cables, value = correction factor.
IEC_GROUPING_FACTORS = {
    "bunched": {1: 1.00, 2: 0.80, 3: 0.70, 4: 0.65, 5: 0.60, 6: 0.57, 7: 0.54,
                8: 0.52, 9: 0.50, 10: 0.48, 12: 0.45, 14: 0.43, 16: 0.41,
                18: 0.39, 20: 0.38},
    "single_layer_wall": {1: 1.00, 2: 0.85, 3: 0.79, 4: 0.75, 5: 0.73, 6: 0.72,
                          7: 0.72, 8: 0.71, 9: 0.70},
    "single_layer_floor": {1: 1.00, 2: 0.88, 3: 0.82, 4: 0.77, 5: 0.75, 6: 0.73,
                           7: 0.73, 8: 0.72, 9: 0.72},
    "single_layer_tray_touching": {1: 1.00, 2: 0.87, 3: 0.82, 4: 0.80, 5: 0.80,
                                   6: 0.79, 7: 0.79, 8: 0.78, 9: 0.78},
    "single_layer_tray_spaced": {1: 1.00, 2: 0.89, 3: 0.81, 4: 0.76, 5: 0.73,
                                 6: 0.72, 7: 0.72, 8: 0.71, 9: 0.70},
    "trefoil_tray_touching": {1: 1.00, 2: 0.81, 3: 0.72, 4: 0.68, 5: 0.66,
                              6: 0.64, 7: 0.63, 8: 0.62, 9: 0.61},
}

# ─── Soil thermal resistivity correction, Table B.52.16 (ref 2.5 K·m/W) ────
IEC_SOIL_RESISTIVITY_FACTORS = {0.5: 1.28, 0.7: 1.20, 1.0: 1.18, 1.5: 1.10,
                                2.0: 1.05, 2.5: 1.00, 3.0: 0.96}

# ─── Depth of laying correction, Table B.52.18 (ref 0.7 m) ─────────────────
IEC_DEPTH_FACTORS = {0.5: 1.02, 0.6: 1.01, 0.7: 1.00, 0.8: 0.99, 1.0: 0.97,
                     1.2: 0.95, 1.5: 0.93}

# Preferred conductor cross-sectional areas (IEC 60228). Same list as the
# frontend's IEC_STANDARD_SIZES, so an ECC rounded up here and one rounded up
# in dbschedule.js can never disagree.
IEC_STANDARD_SIZES = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120,
                      150, 185, 240, 300, 400]


def interpolate_factor(table: dict, value: float) -> float:
    """Linearly interpolate a correction factor, clamping outside the table.

    Port of ``StandardData._interpolateFactor``
    (``frontend/js/standard-data.js:786``) — same clamp-then-interpolate
    behaviour, so the two implementations agree for every input.
    """
    if not table:
        return 1.0
    keys = sorted(float(k) for k in table.keys())
    lookup = {float(k): float(v) for k, v in table.items()}
    if value in lookup:
        return lookup[value]
    if value <= keys[0]:
        return lookup[keys[0]]
    if value >= keys[-1]:
        return lookup[keys[-1]]
    lo, hi = keys[0], keys[-1]
    for i in range(len(keys) - 1):
        if keys[i] <= value <= keys[i + 1]:
            lo, hi = keys[i], keys[i + 1]
            break
    if hi == lo:
        return lookup[lo]
    frac = (value - lo) / (hi - lo)
    return lookup[lo] + frac * (lookup[hi] - lookup[lo])


def _conductor_key(conductor: str, insulation: str) -> str:
    cond = "al" if str(conductor or "Cu").strip().lower().startswith("al") else "cu"
    ins = "xlpe" if str(insulation or "PVC").strip().lower() == "xlpe" else "pvc"
    return f"{ins}_{cond}"


def base_ampacity_a(size_mm2: float, method: str = "B1", conductor: str = "Cu",
                    insulation: str = "PVC"):
    """Base (undegraded) current-carrying capacity in A, or None.

    None means "the standard has no tabulated value for this combination" —
    e.g. aluminium below 16 mm², or method E/F below 25 mm². Callers must
    surface that as an *info* verdict, never as a silent pass.
    """
    try:
        size = float(size_mm2)
    except (TypeError, ValueError):
        return None
    if size <= 0:
        return None
    # Tolerate 4.0-vs-4 key styles: match on value, not on dict identity.
    row = None
    for k, v in IEC_AMPACITY_TABLE.items():
        if abs(float(k) - size) < 1e-9:
            row = v
            break
    if not row:
        return None
    cell = row.get(str(method or "B1"))
    if not cell:
        return None
    val = cell.get(_conductor_key(conductor, insulation))
    return float(val) if val is not None else None


def round_up_to_standard(size_mm2: float):
    """Smallest preferred size >= ``size_mm2`` (None if beyond the table)."""
    for s in IEC_STANDARD_SIZES:
        if s >= size_mm2 - 1e-9:
            return float(s)
    return None


def derating_factors(method: str = "B1", ambient_c: float = 30.0,
                     insulation: str = "PVC", grouping: str = "bunched",
                     circuits: int = 1, soil_kmw=None, depth_m=None) -> dict:
    """Combined IEC 60364-5-52 derating for one installation condition.

    Returns the individual factors plus their product and a human-readable
    ``detail`` string, so a result row can always explain where its Iz came
    from rather than presenting a bare number.
    """
    meth = str(method or "B1")
    env = IEC_INSTALLATION_METHODS.get(meth, {}).get("environment", "air")
    ins = "xlpe" if str(insulation or "PVC").strip().lower() == "xlpe" else "pvc"
    buried = env == "ground"

    temp_table = IEC_TEMP_CORRECTION[env][ins]
    temp_f = interpolate_factor(temp_table, float(ambient_c))

    group_table = IEC_GROUPING_FACTORS.get(str(grouping or "bunched"),
                                           IEC_GROUPING_FACTORS["bunched"])
    n_circuits = max(1, int(circuits or 1))
    group_f = interpolate_factor(group_table, n_circuits)

    soil_f = interpolate_factor(IEC_SOIL_RESISTIVITY_FACTORS, float(soil_kmw)) \
        if buried and soil_kmw is not None else 1.0
    depth_f = interpolate_factor(IEC_DEPTH_FACTORS, float(depth_m)) \
        if buried and depth_m is not None else 1.0

    combined = temp_f * group_f * soil_f * depth_f

    bits = [f"{meth} · {ins.upper()}",
            f"{ambient_c:g} °C {env} x{temp_f:.2f}",
            f"{n_circuits} circuit(s) {str(grouping).replace('_', ' ')} x{group_f:.2f}"]
    if buried and soil_kmw is not None:
        bits.append(f"soil {soil_kmw:g} K·m/W x{soil_f:.2f}")
    if buried and depth_m is not None:
        bits.append(f"depth {depth_m:g} m x{depth_f:.2f}")
    bits.append(f"combined x{combined:.3f}")

    return {
        "temp": float(temp_f), "grouping": float(group_f),
        "soil": float(soil_f), "depth": float(depth_f),
        "combined": float(combined), "environment": env,
        "detail": " · ".join(bits),
    }


def installed_ampacity(size_mm2: float, method: str = "B1", conductor: str = "Cu",
                       insulation: str = "PVC", ambient_c: float = 30.0,
                       grouping: str = "bunched", circuits: int = 1,
                       soil_kmw=None, depth_m=None) -> dict:
    """Base and derated Iz for one way's cable, with the factor breakdown."""
    base = base_ampacity_a(size_mm2, method, conductor, insulation)
    f = derating_factors(method, ambient_c, insulation, grouping, circuits,
                         soil_kmw, depth_m)
    derated = None if base is None else float(base) * f["combined"]
    return {
        "base_a": base,
        "derating": f["combined"],
        "derated_a": derated,
        "factors": f,
        "detail": f["detail"],
    }
