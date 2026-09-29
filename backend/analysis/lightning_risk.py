"""Lightning Risk Assessment — IEC 62305-2:2010 (Protection against lightning
— Part 2: Risk management).

Evaluates risk R1 (loss of human life) for a rectangular structure with
connected service lines, and recommends the minimum protection measures
(LPS class + coordinated SPDs) that bring R1 within the tolerable limit
RT = 1e-5 per year (IEC 62305-2:2010 Table 4; an input, default 1e-5).

This module is the 2010 (Ed. 2) method, kept for assessments made with it and
for jurisdictions that still adopt it (SANS 62305-2). The current edition is
IEC 62305-2:2024 (Ed. 3), a different method: see lightning_risk_2024.py.
`run_lightning_risk` dispatches on the request's `edition` (absent ⇒ 2010,
so saved assessments reproduce).

Key equations (Ed. 2.0, Annex A/B/C):
  Collection areas:
    A_D  = L·W + 2·(3H)·(L+W) + π·(3H)²          (flashes to structure, eq. A.2)
    A_M  = 2·500·(L+W) + π·500²                   (flashes near structure, eq. A.7)
    A_L  = 40·L_L                                 (flashes to a line, eq. A.9)
    A_I  = 4000·L_L                               (flashes near a line, eq. A.11)
  Dangerous events:
    N_D  = N_G · A_D · C_D · 1e-6                 (eq. A.4)
    N_M  = N_G · A_M · 1e-6                       (eq. A.6)
    N_L  = N_G · A_L · C_I · C_E · C_T · 1e-6     (eq. A.8)
    N_I  = N_G · A_I · C_I · C_E · C_T · 1e-6     (eq. A.10)
  Risk components (§6.8, Table 6):
    R_A = N_D·P_A·L_A       R_B = N_D·P_B·L_B     R_C = N_D·P_C·L_C
    R_M = N_M·P_M·L_M
    R_U = N_L·P_U·L_U       R_V = N_L·P_V·L_V
    R_W = N_L·P_W·L_W       R_Z = N_I·P_Z·L_Z     (per connected line)
    R1  = R_A + R_B + R_C* + R_M* + R_U + R_V + R_W* + R_Z*
          (* only where failure of internal systems endangers life —
           hospitals / structures with risk of explosion, §6.2 note)
  Losses (Annex C, Table C.2 typical mean values):
    L_A = r_t·L_T·(n_z/n_t)·(t_z/8760)
    L_B = r_p·r_f·h_z·L_F·(n_z/n_t)·(t_z/8760)
    L_C = L_O·(n_z/n_t)·(t_z/8760)

SIMPLIFICATIONS (documented, conservative where they matter):
  - Single zone Z1 covering the whole structure (n_z = n_t unless overridden).
  - No adjacent-structure flashes (N_DJ = 0).
  - K_S1 = K_S2 = 1 (no spatial shielding credit), so P_MS = (K_S3·K_S4)².
  - Loss of cultural heritage (R3) and service to the public (R2) not
    evaluated; R4 (economic) is out of scope for this pass.
"""

import math
from typing import Optional

from ..models.schemas import (
    LightningRiskRequest,
    LightningRiskResult,
    LightningLine,
    LightningRiskComponentRow,
    LightningProtectionOption,
)

TOLERABLE_R1 = 1e-5  # IEC 62305-2:2010 Table 4 (default; the request may set another)

# ── Table A.1: location factor C_D ──
LOCATION_FACTOR = {
    "surrounded_by_taller": 0.25,   # object surrounded by higher objects
    "surrounded_same_height": 0.5,  # surrounded by objects of same/lower height
    "isolated": 1.0,                # no other objects in the vicinity
    "isolated_hilltop": 2.0,        # isolated on a hilltop or knoll
}

# ── Table A.2/A.5: line installation factor C_I ──
LINE_INSTALLATION_FACTOR = {"aerial": 1.0, "buried": 0.5}

# ── Table A.4: line environment factor C_E ──
LINE_ENVIRONMENT_FACTOR = {
    "rural": 1.0,
    "suburban": 0.5,
    "urban": 0.1,
    "urban_tall_buildings": 0.01,  # urban with buildings taller than 20 m
}

# ── Table A.3: line type factor C_T (HV line with HV/LV transformer: 0.2) ──
def _line_type_factor(has_transformer: bool) -> float:
    return 0.2 if has_transformer else 1.0

# ── Table B.2: P_B by LPS class ──
PB_BY_LPS = {
    "none": 1.0,
    "IV": 0.2,
    "III": 0.1,
    "II": 0.05,
    "I": 0.02,
}

# ── Table B.3: P_SPD by coordinated SPD protection level ──
PSPD_BY_LEVEL = {
    "none": 1.0,
    "III-IV": 0.05,
    "II": 0.02,
    "I": 0.01,
}

# ── Table B.7 (entrance SPD / equipotential bonding): P_EB by LPL ──
PEB_BY_LEVEL = {
    "none": 1.0,
    "III-IV": 0.05,
    "II": 0.02,
    "I": 0.01,
}

# ── Table C.3: floor-surface reduction factor r_t ──
FLOOR_FACTOR = {
    "agricultural_concrete": 1e-2,
    "marble_ceramic": 1e-3,
    "gravel_carpet": 1e-4,
    "asphalt_wood_linoleum": 1e-5,
}

# ── Table C.4: fire-provision reduction factor r_p ──
FIRE_PROTECTION_FACTOR = {
    "none": 1.0,
    "manual": 0.5,       # extinguishers, hydrants, manual alarms
    "automatic": 0.2,    # fixed automatic extinguishing / alarm installations
}

# ── Table C.5: fire-risk factor r_f ──
FIRE_RISK_FACTOR = {
    "explosion": 1.0,
    "high": 1e-1,
    "ordinary": 1e-2,
    "low": 1e-3,
    "none": 0.0,
}

# ── Table C.6: special-hazard factor h_z ──
HAZARD_FACTOR = {
    "none": 1.0,
    "low_panic": 2.0,        # ≤ 2 floors, < 100 people
    "average_panic": 5.0,    # 100–1000 people
    "difficult_evacuation": 5.0,  # hospitals, immobilised occupants
    "high_panic": 10.0,      # > 1000 people
}

# ── Table C.2: typical mean loss values for R1 ──
LT = 1e-2  # injuries by touch/step voltage (all structure types)

LF_BY_USE = {
    "hospital": 1e-1,
    "hospital_icu": 1e-1,
    "hotel_school_civic": 1e-1,
    "entertainment_church_museum": 5e-2,
    "industrial_commercial": 2e-2,
    "other": 1e-2,
}
LF_EXPLOSION = 1e-1   # [LR2] Table C.2: risk of explosion, whatever the use

# [LR1] "hospital_hotel_school" was one card that counted a hotel or school as
# a structure where failure of internal systems endangers life. Saved
# assessments carry the old key: read it as a hospital (the only reading under
# which its L_O = 1e-3 was right) so their numbers reproduce.
_LEGACY_USE = {"hospital_hotel_school": "hospital"}

# L_O (failure of internal systems) — Table C.2 gives it only for a risk of
# explosion and for hospitals: 1e-2 intensive care / operating block [LR4],
# 1e-3 other parts. Hotels, schools and civic buildings have none [LR1].
LO_BY_USE = {"hospital": 1e-3, "hospital_icu": 1e-2}


def _structure_use(req) -> str:
    return _LEGACY_USE.get(req.structure_use, req.structure_use)


def _lo_value(explosion_risk: bool, structure_use: str) -> float:
    if explosion_risk:
        return 1e-1
    return LO_BY_USE.get(structure_use, 0.0)

# ── Table B.9: P_LI by line type and equipment impulse withstand U_W (kV) ──
PLI_TABLE = {
    "power":   {1.0: 1.0, 1.5: 0.6, 2.5: 0.3, 4.0: 0.16, 6.0: 0.1},
    # [LR3] TLC at 2.5 kV is 0.2 (the engine had 0.15). Table B.9 of the 2010
    # edition; its 2024 successor dropped P_LI, so confirm against a 2010 copy.
    "telecom": {1.0: 1.0, 1.5: 0.5, 2.5: 0.2, 4.0: 0.08, 6.0: 0.04},
}

# [LR5] Table B.8: P_LD by the screen of the line and U_W. A screen that is not
# bonded at the entrance (or no screen) gives 1; a bonded screen depends on its
# resistance R_S. Columns are U_W = 1 / 1.5 / 2.5 / 4 / 6 kV.
PLD_TABLE = {
    "unshielded":     [1.0, 1.0, 1.0, 1.0, 1.0],
    "not_bonded":     [1.0, 1.0, 1.0, 1.0, 1.0],
    "bonded_rs_5_20": [1.0, 1.0, 0.95, 0.9, 0.8],
    "bonded_rs_1_5":  [0.9, 0.8, 0.6, 0.3, 0.1],
    "bonded_rs_le1":  [0.6, 0.4, 0.2, 0.04, 0.02],
}
_UW_COLS = [1.0, 1.5, 2.5, 4.0, 6.0]


def _line_screen(line: LightningLine) -> str:
    """[LR5] The line's screen. Saved lines carry only `shielded`; the flat
    P_LD = 0.2 it used is Table B.8's bonded R_S <= 1 ohm/km at 2.5 kV."""
    if line.screen:
        return line.screen
    return "bonded_rs_le1" if line.shielded else "unshielded"


def _line_cld_cli(line: LightningLine, screen: str):
    """C_LD, C_LI (Table B.4). C_LD = 1 for every external line type the
    dialog offers; C_LI = 0 for a screen bonded at the equipment's bar, 0.3
    buried / 0.1 aerial for a screen that is not, 1 unshielded."""
    if screen.startswith("bonded"):
        return 1.0, 0.0
    if screen == "not_bonded":
        return 1.0, (0.1 if line.installation == "aerial" else 0.3)
    return 1.0, 1.0


def _nearest_withstand(uw_kv: float) -> float:
    """Snap a withstand voltage to the nearest tabulated U_W column."""
    return min(_UW_COLS, key=lambda c: abs(c - uw_kv))


def collection_area_structure(length_m, width_m, height_m):
    """A_D per IEC 62305-2 eq. A.2 (isolated rectangular structure)."""
    return (length_m * width_m
            + 2 * (3 * height_m) * (length_m + width_m)
            + math.pi * (3 * height_m) ** 2)


def collection_area_near(length_m, width_m):
    """A_M per IEC 62305-2 eq. A.7 (500 m band around the structure)."""
    return 2 * 500.0 * (length_m + width_m) + math.pi * 500.0 ** 2


def _line_events(req: LightningRiskRequest, line: LightningLine):
    """N_L and N_I (dangerous events on / near one service line)."""
    ci = LINE_INSTALLATION_FACTOR.get(line.installation, 1.0)
    ce = LINE_ENVIRONMENT_FACTOR.get(line.environment, 1.0)
    ct = _line_type_factor(line.has_transformer)
    al = 40.0 * line.length_m
    ai = 4000.0 * line.length_m
    nl = req.ground_flash_density * al * ci * ce * ct * 1e-6
    ni = req.ground_flash_density * ai * ci * ce * ct * 1e-6
    return nl, ni


def _compute_r1(req: LightningRiskRequest, lps_class: str, spd_level: str):
    """R1 and its components for a given (LPS class, coordinated-SPD level).

    spd_level drives both P_SPD (coordinated SPDs, Table B.3) and P_EB
    (entrance bonding SPDs, Table B.7) — in practice a coordinated SPD
    system includes the service-entrance devices.
    """
    ng = req.ground_flash_density
    cd = LOCATION_FACTOR.get(req.location, 1.0)

    ad = collection_area_structure(req.length_m, req.width_m, req.height_m)
    am = collection_area_near(req.length_m, req.width_m)
    nd = ng * ad * cd * 1e-6
    nm = ng * am * 1e-6

    # Occupancy weighting (single zone)
    occ = (req.persons_in_zone / max(req.persons_total, 1)) * (req.hours_per_year / 8760.0)

    use = _structure_use(req)
    rt_floor = FLOOR_FACTOR.get(req.floor_type, 1e-2)
    # [LR2] Table C.4 note: with a risk of explosion r_p = 1 for all cases —
    # fire provisions earn no credit where the fire is an explosion.
    rp = 1.0 if req.explosion_risk else FIRE_PROTECTION_FACTOR.get(req.fire_protection, 1.0)
    rf = 1.0 if req.explosion_risk else FIRE_RISK_FACTOR.get(req.fire_risk, 1e-2)
    hz = HAZARD_FACTOR.get(req.hazard_level, 1.0)
    # [LR2] Table C.2: L_F = 1e-1 with a risk of explosion, whatever the use.
    lf = LF_EXPLOSION if req.explosion_risk else LF_BY_USE.get(use, 1e-2)
    lo = _lo_value(req.explosion_risk, use)

    la = rt_floor * LT * occ
    lb = rp * rf * hz * lf * occ
    lc = lo * occ

    # Internal-system failure endangers life only for a risk of explosion and
    # for hospitals (§4.3 eq. 1 footnote; Table C.2) — not hotels/schools [LR1].
    systems_life_risk = req.explosion_risk or use in LO_BY_USE

    pb = PB_BY_LPS.get(lps_class, 1.0)
    pta = 1.0  # no touch-protection measures assumed at the structure
    pa = pta * pb
    pspd = PSPD_BY_LEVEL.get(spd_level, 1.0)
    peb = PEB_BY_LEVEL.get(spd_level, 1.0)

    # P_M = P_SPD · P_MS, P_MS = (K_S1·K_S2·K_S3·K_S4)²  (eq. B.4/B.5).
    # K_S1 = K_S2 = 1 (no spatial shields), K_S3 = 1 (unshielded internal
    # wiring, no routing precaution), K_S4 = 1/U_W capped at 1 (eq. B.6).
    ks4 = min(1.0, 1.0 / max(req.equipment_withstand_kv, 1e-6))
    pms = (1.0 * 1.0 * 1.0 * ks4) ** 2
    pm = pspd * pms if spd_level != "none" else pms

    # [LR6] P_C = P_SPD·C_LD per internal system, combined over the systems
    # (one per connected line) as 1 − Π(1 − P_C,i). A structure with no
    # external line has C_LD = 0 (Table B.4: stand-alone systems) ⇒ P_C = 0.
    pc = 1.0
    for _ in req.lines:
        pc *= (1.0 - pspd * 1.0)
    pc = 1.0 - pc

    ra = nd * pa * la
    rb = nd * pb * lb
    rc = nd * pc * lc if systems_life_risk else 0.0
    rm = nm * pm * lc if systems_life_risk else 0.0

    ru = rv = rw = rz = 0.0
    per_line = []
    for line in req.lines:
        nl, ni = _line_events(req, line)
        # [LR5] P_LD from Table B.8 (screen, R_S, U_W); C_LD, C_LI Table B.4
        screen = _line_screen(line)
        uw_col = _UW_COLS.index(_nearest_withstand(req.equipment_withstand_kv))
        pld = PLD_TABLE.get(screen, PLD_TABLE["unshielded"])[uw_col]
        cld, cli = _line_cld_cli(line, screen)
        pu = 1.0 * peb * pld * cld          # P_TU=1: no touch protection
        pv = peb * pld * cld
        pli = PLI_TABLE.get(line.type, PLI_TABLE["power"])[
            _nearest_withstand(req.equipment_withstand_kv)]
        pw = pspd * pld * cld
        pz = pspd * pli * cli

        # L_U uses touch-voltage loss L_T; L_V uses physical-damage loss L_B
        lu = rt_floor * LT * occ
        lv = rp * rf * hz * lf * occ
        ru_l = nl * pu * lu
        rv_l = nl * pv * lv
        rw_l = nl * pw * lc if systems_life_risk else 0.0
        rz_l = ni * pz * lc if systems_life_risk else 0.0
        ru += ru_l
        rv += rv_l
        rw += rw_l
        rz += rz_l
        per_line.append({"name": line.name, "nl": nl, "ni": ni})

    r1 = ra + rb + rc + rm + ru + rv + rw + rz
    return {
        "ad": ad, "am": am, "nd": nd, "nm": nm,
        "ra": ra, "rb": rb, "rc": rc, "rm": rm,
        "ru": ru, "rv": rv, "rw": rw, "rz": rz,
        "r1": r1, "per_line": per_line,
        "systems_life_risk": systems_life_risk,
    }


# [LR7] Every (LPS class, coordinated-SPD level) pair, lightest first: LPS
# class, then SPD level. The old six-step ladder never offered "SPDs at LPL II
# or I, no LPS" and could recommend a higher LPS class than needed.
_LPS_ORDER = ["none", "IV", "III", "II", "I"]
_SPD_ORDER = ["none", "III-IV", "II", "I"]
_PROTECTION_PAIRS = [(l, s_) for l in _LPS_ORDER for s_ in _SPD_ORDER]


def _ladder(req, rt):
    """Evaluate every pair; return (options, recommended). `options` holds,
    for each LPS class, the lightest SPD level that meets R_T (or LPL I when
    none does), so the table stays one row per LPS class."""
    evaluated = [(l, s_, _compute_r1(req, l, s_)["r1"]) for l, s_ in _PROTECTION_PAIRS]
    recommended = next(((l, s_, r) for l, s_, r in evaluated if r <= rt), None)
    options = []
    for l in _LPS_ORDER:
        rows = [(l2, s2, r) for l2, s2, r in evaluated if l2 == l]
        ok = next((row for row in rows if row[2] <= rt), None)
        options.append(ok or rows[-1])
    if recommended and recommended not in options:
        options.append(recommended)
    options.sort(key=lambda o: (_LPS_ORDER.index(o[0]), _SPD_ORDER.index(o[1])))
    return options, recommended


def run_lightning_risk(req: LightningRiskRequest) -> LightningRiskResult:
    """Assess the risk for the as-entered protection and recommend the minimum
    measures meeting R_T. Dispatches on `edition`: "2024" runs IEC
    62305-2:2024 (lightning_risk_2024.py); anything else, including an absent
    field on a saved assessment, runs the 2010 method below."""
    if req.edition == "2024":
        from .lightning_risk_2024 import run_lightning_risk_2024
        return run_lightning_risk_2024(req)
    return _run_2010(req)


def _run_2010(req: LightningRiskRequest) -> LightningRiskResult:
    warnings = []
    rt = req.tolerable_risk if req.tolerable_risk and req.tolerable_risk > 0 else TOLERABLE_R1
    if req.ground_flash_density <= 0:
        warnings.append(
            "Ground flash density Ng must be > 0 — using 1.0 flashes/km²/yr. "
            "(South African highveld is typically 6–12; coastal 1–4.)")
        req.ground_flash_density = 1.0
    if not req.lines:
        warnings.append(
            "No service lines modelled — R_U/R_V (flashes to incoming lines) "
            "are zero. Most structures have at least a power service.")

    base = _compute_r1(req, req.lps_class, req.spd_level)

    components = [
        LightningRiskComponentRow(
            code=code, description=desc, value=base[key],
            share_pct=(100.0 * base[key] / base["r1"]) if base["r1"] > 0 else 0.0)
        for code, key, desc in [
            ("RA", "ra", "Injury by touch/step voltage (flash to structure)"),
            ("RB", "rb", "Physical damage / fire (flash to structure)"),
            ("RC", "rc", "Internal system failure (flash to structure)"),
            ("RM", "rm", "Internal system failure (flash near structure)"),
            ("RU", "ru", "Injury by touch voltage (flash to line)"),
            ("RV", "rv", "Physical damage / fire (flash to line)"),
            ("RW", "rw", "Internal system failure (flash to line)"),
            ("RZ", "rz", "Internal system failure (flash near line)"),
        ]
    ]

    # Recommendation: the lightest pair meeting R_T [LR7]
    rows, rec = _ladder(req, rt)
    options = [LightningProtectionOption(
        lps_class=l, spd_level=s_, label=_option_label(l, s_),
        r1=r, compliant=r <= rt) for l, s_, r in rows]
    recommended: Optional[str] = _option_label(rec[0], rec[1]) if rec else None

    if recommended is None:
        warnings.append(
            "R1 exceeds the tolerable level even with LPS class I and LPL I "
            "coordinated SPDs — additional measures required (spatial "
            "shielding, fire suppression, restricted occupancy, or routing "
            "changes). Review zone assumptions.")

    compliant = base["r1"] <= rt
    return LightningRiskResult(
        collection_area_m2=round(base["ad"], 1),
        collection_area_near_m2=round(base["am"], 1),
        flashes_to_structure_per_year=base["nd"],
        flashes_near_structure_per_year=base["nm"],
        r1=base["r1"],
        tolerable_r1=rt,
        edition="2010",
        compliant=compliant,
        components=components,
        options=options,
        recommendation=(
            "No protection required — R1 is within the tolerable level."
            if compliant and req.lps_class == "none" and req.spd_level == "none"
            else "Existing/entered measures are sufficient." if compliant
            else f"Install {recommended}." if recommended
            else "Risk cannot be reduced below RT with LPS+SPD alone."),
        systems_life_risk=base["systems_life_risk"],
        warnings=warnings,
    )


def _option_label(lps: str, spd: str) -> str:
    if lps == "none" and spd == "none":
        return "No protection"
    parts = []
    if lps != "none":
        parts.append(f"LPS class {lps}")
    if spd != "none":
        parts.append(f"coordinated SPDs (LPL {spd})")
    return " + ".join(parts)
