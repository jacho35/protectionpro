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

The capacity and grouping tables live in the GENERATED ``iec_60364_data.py``
(twin: ``frontend/js/iec-60364-data.js``), both written from one reference
file by ``testing/iec-60364-tables-review/build_iec_tables.py``. The ambient
and soil tables below are mirrored in ``frontend/js/constants.js``. This mirrors the
existing arrangement for ``cable_sizing.STANDARD_OVERHEAD_LINES``, which
carries the same "keep in sync with the frontend table" note.

Note this is a DIFFERENT table family to ``cable_sizing.STANDARD_CABLES``:
that one is a conductor R/X library on a 20 °C DC basis, this one is installed
current-carrying capacity. They are not interchangeable and values must never
be copied between them.
"""

from __future__ import annotations

from .iec_60364_data import IEC_METHODS, IEC_AMPACITY, IEC_GROUPING, IEC_GROUPING_LABELS

# ─── Reference installation methods, IEC 60364-5-52 Table B.52.1 ───────────
# [T3] Codes A1–G with the standard's own descriptions (the old E/F labels
# were shifted by one — "E" described single-core touching, which is F — and
# A2, B2 and G were missing). ``environment`` selects the ambient-correction
# table and the grouping family.
IEC_INSTALLATION_METHODS = {
    code: {"description": desc, "environment": env, "tables": tables}
    for code, (desc, env, tables) in IEC_METHODS.items()
}

# ─── Base current-carrying capacity (A) ─────────────────────────────────────
# [T1][T2] Generated from the IEC 60364-5-52 reference by
# testing/iec-60364-tables-review/build_iec_tables.py (see iec_60364_data.py).
# The previous table matched the standard only for PVC-Cu A1/B1, sat above
# even the single-phase values elsewhere (method C +11 % median) and had no
# notion of loaded conductors, so three-phase circuits were rated 12–36 %
# high. Values now come per number of loaded conductors: 2 = single-phase
# (Tables B.52.2/B.52.3, B.52.10–13 two-loaded columns), 3 = three-phase
# (B.52.4/B.52.5, three-loaded columns). Reference conditions: 30 °C air,
# 20 °C ground, 2.5 K·m/W soil.
LOADED_THREE_PHASE = 3
LOADED_SINGLE_PHASE = 2

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

# ─── Grouping correction ───────────────────────────────────────────────────
# [T4] Rows as IEC 60364-5-52 prints them: Table B.52.17 in air (five
# arrangements), B.52.18 direct in the ground, B.52.19 in ducts. The old
# table put the perforated-tray row under "floor", the ladder row under "tray
# touching", the wooden-ceiling row (with 1.00 for one circuit, not 0.95)
# under "trefoil", had an unsourced "tray spaced" row — and applied these
# unburied factors to buried cables. Legacy names map onto the IEC row they
# describe (spaced/trefoil tray → the touching perforated-tray row,
# conservative).
IEC_GROUPING_FACTORS = {name: row["factors"] for name, row in IEC_GROUPING.items()}
LEGACY_GROUPING = {
    "single_layer_wall": "single_layer_wall_floor",
    "single_layer_floor": "single_layer_wall_floor",
    "single_layer_tray_touching": "single_layer_perforated_tray",
    "single_layer_tray_spaced": "single_layer_perforated_tray",
    "trefoil_tray_touching": "single_layer_perforated_tray",
}

# ─── Soil thermal resistivity correction, Table B.52.16 (ref 2.5 K·m/W) ────
# [L2] The published factors are for cables in buried ducts; for cables laid
# direct in the ground IEC notes they are higher below 2.5 K·m/W, so applying
# them to method D2 is conservative (and disclosed in the detail string).
IEC_SOIL_RESISTIVITY_FACTORS = {0.5: 1.28, 0.7: 1.20, 1.0: 1.18, 1.5: 1.10,
                                2.0: 1.05, 2.5: 1.00, 3.0: 0.96}

# [T5] IEC 60364-5-52 has NO depth-of-laying correction (its reference depth
# is 0.7 m). The old table was labelled "B.52.18" — which is the grouping
# table for direct burial — had no source, and rated shallow runs above 1.0.
# Depth is no longer a factor; the argument is accepted and ignored.
IEC_DEPTH_FACTORS = {}

# Preferred conductor cross-sectional areas (IEC 60228). Same list as the
# frontend's IEC_STANDARD_SIZES, so an ECC rounded up here and one rounded up
# in dbschedule.js can never disagree.
IEC_STANDARD_SIZES = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120,
                      150, 185, 240, 300, 400, 500, 630]


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


def _loaded(loaded) -> int:
    try:
        return LOADED_SINGLE_PHASE if int(loaded) == 2 else LOADED_THREE_PHASE
    except (TypeError, ValueError):
        return LOADED_THREE_PHASE


def base_ampacity_a(size_mm2: float, method: str = "B1", conductor: str = "Cu",
                    insulation: str = "PVC", loaded: int = LOADED_THREE_PHASE):
    """Base (underated) current-carrying capacity in A, or None.

    ``loaded``: number of loaded conductors — 2 for a single-phase circuit,
    3 for three-phase (default, the conservative choice when unknown).
    None means the standard tabulates no value for the combination (e.g.
    methods A–D above 300 mm², E below 1.5 mm², F/G below 25 mm², method G
    with two loaded conductors). Callers must surface that as an *info*
    verdict, never as a silent pass.
    """
    try:
        size = float(size_mm2)
    except (TypeError, ValueError):
        return None
    if size <= 0:
        return None
    cells = (IEC_AMPACITY.get(_conductor_key(conductor, insulation), {})
             .get(_loaded(loaded), {}).get(str(method or "B1")))
    if not cells:
        return None
    for k, v in cells.items():
        if abs(float(k) - size) < 1e-9:
            return float(v)
    return None


def round_up_to_standard(size_mm2: float):
    """Smallest preferred size >= ``size_mm2`` (None if beyond the table)."""
    for s in IEC_STANDARD_SIZES:
        if s >= size_mm2 - 1e-9:
            return float(s)
    return None


def resolve_grouping(grouping: str, method: str):
    """(IEC grouping row name, note) for ``grouping`` under ``method``.

    Legacy names map onto their IEC row. [T4] A buried method (D1/D2) must use
    the burial tables: an air arrangement is replaced by the touching row of
    B.52.19 (D1, ducts) or B.52.18 (D2, direct) — and vice versa, a burial
    arrangement on an air method falls back to "bunched"."""
    name = LEGACY_GROUPING.get(str(grouping or "bunched"), str(grouping or "bunched"))
    if name not in IEC_GROUPING:
        name = "bunched"
    env = IEC_METHODS.get(str(method or "B1"), ("", "air", ""))[1]
    fam = IEC_GROUPING[name]["env"]
    note = ""
    if env == "ground" and fam == "air":
        name = "ducts_mc_touching" if str(method) == "D1" else "buried_touching"
        note = (f"buried method {method}: grouping taken from "
                f"{'B.52.19' if method == 'D1' else 'B.52.18'} (touching)")
    elif env == "air" and fam != "air":
        name = "bunched"
        note = f"air method {method}: burial grouping replaced by B.52.17 bunched"
    return name, note


def grouping_factor(name: str, circuits: int):
    """[L1] Grouping factor for ``circuits`` from an IEC row, stepping UP to
    the next tabulated count (IEC lists 9, 12, 16, 20 — 10 circuits take the
    12-circuit factor; interpolating between them is not in the standard and
    was slightly optimistic). Beyond the last count the last factor applies
    (IEC: "no further reduction" for the single-layer rows); the second value
    says whether that happened for a row that does not state it."""
    factors = IEC_GROUPING_FACTORS[name]
    n = max(1, int(circuits or 1))
    counts = sorted(factors)
    for c in counts:
        if c >= n:
            return float(factors[c]), False
    beyond = name == "bunched" or IEC_GROUPING[name]["env"] != "air"
    return float(factors[counts[-1]]), beyond


def derating_factors(method: str = "B1", ambient_c: float = 30.0,
                     insulation: str = "PVC", grouping: str = "bunched",
                     circuits: int = 1, soil_kmw=None, depth_m=None) -> dict:
    """Combined IEC 60364-5-52 derating for one installation condition.

    Returns the individual factors plus their product and a human-readable
    ``detail`` string, so a result row can always explain where its Iz came
    from rather than presenting a bare number. ``depth_m`` is accepted for
    compatibility and ignored ([T5]: IEC 60364-5-52 has no depth factor).
    """
    meth = str(method or "B1")
    env = IEC_INSTALLATION_METHODS.get(meth, {}).get("environment", "air")
    ins = "xlpe" if str(insulation or "PVC").strip().lower() == "xlpe" else "pvc"
    buried = env == "ground"

    temp_table = IEC_TEMP_CORRECTION[env][ins]
    temp_f = interpolate_factor(temp_table, float(ambient_c))

    group_name, group_note = resolve_grouping(grouping, meth)
    n_circuits = max(1, int(circuits or 1))
    group_f, beyond = grouping_factor(group_name, n_circuits)

    soil_f = interpolate_factor(IEC_SOIL_RESISTIVITY_FACTORS, float(soil_kmw)) \
        if buried and soil_kmw is not None else 1.0

    combined = temp_f * group_f * soil_f

    bits = [f"{meth} · {ins.upper()}",
            f"{ambient_c:g} °C {env} x{temp_f:.2f}",
            f"{n_circuits} circuit(s) {IEC_GROUPING_LABELS[group_name]} x{group_f:.2f}"]
    if group_note:
        bits.append(group_note)
    if beyond:
        bits.append(f"beyond the table's {max(IEC_GROUPING_FACTORS[group_name])} circuits — last factor used")
    if buried and soil_kmw is not None:
        bits.append(f"soil {soil_kmw:g} K·m/W x{soil_f:.2f} (B.52.16, duct values)")
    bits.append(f"combined x{combined:.3f}")

    return {
        "temp": float(temp_f), "grouping": float(group_f),
        "soil": float(soil_f), "depth": 1.0,
        "combined": float(combined), "environment": env,
        "grouping_row": group_name,
        "detail": " · ".join(bits),
    }


def installed_ampacity(size_mm2: float, method: str = "B1", conductor: str = "Cu",
                       insulation: str = "PVC", ambient_c: float = 30.0,
                       grouping: str = "bunched", circuits: int = 1,
                       soil_kmw=None, depth_m=None,
                       loaded: int = LOADED_THREE_PHASE) -> dict:
    """Base and derated Iz for one cable, with the factor breakdown."""
    base = base_ampacity_a(size_mm2, method, conductor, insulation, loaded)
    f = derating_factors(method, ambient_c, insulation, grouping, circuits,
                         soil_kmw, depth_m)
    derated = None if base is None else float(base) * f["combined"]
    return {
        "base_a": base,
        "derating": f["combined"],
        "derated_a": derated,
        "loaded": _loaded(loaded),
        "factors": f,
        "detail": f"{_loaded(loaded)} loaded conductors · " + f["detail"],
    }
