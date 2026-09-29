"""Lightning Risk Assessment — IEC 62305-2:2024 (Ed. 3, Protection against
lightning — Part 2: Risk management).

The 2024 edition replaces the 2010 method (lightning_risk.py) with:
  - a single risk R = R_L1 + R_L2 (eq. 6–8): loss of human life (L1) and
    physical damage to the structure and its content (L2) summed together;
  - a separate frequency of damage F = F_C + F_M + F_W + F_Z (eq. 12) for the
    internal systems, against a tolerable F_T (clause 9);
  - the lightning ground strike-point density N_SG = k·N_G (A.1) in place of
    N_G, with N_M and N_I divided by k (A.7, A.11);
  - collection areas near the structure and the line set by the equipment
    withstand: r_M = 350/U_W (A.8), r_I = 2000/U_W^1.8 (A.12) — which is why
    K_S4 is gone from P_MS (B.6 Note 3);
  - explicit presence factors P_P = t_z/8760 (B.14) and P_e = t_e/8760 (B.15);
  - loss classes (Table C.2) instead of per-use loss values.

Risk components (Table 3), per risk zone:
  R_AT = N_D·P_AT·P_P·L_T                     P_AT = P_LPS·P_am·r_t·P_TWS (B.2)
  R_AD = N_D·P_AD·P_P·L_D                     P_AD = P_TWS·P_am·P_O·P_LPS (B.3)
  R_B  = N_D·P_B·(P_P·L_F1 + L_F2)            P_B  = P_S·P_LPS·r_f·r_p (B.4)
  R_C  = N_D·P_C·P_e·(P_P·L_O1ᵃ + L_O2ᵇ)       P_C  = 1 − Π(1 − P_SPD,i·C_LD,i) (B.5, eq. 10)
  R_M  = N_M·P_M·P_e·(P_P·L_O1ᵃ + L_O2ᵇ)       P_M  = 1 − Π(1 − P_SPD,i·P_MS,i) (B.6, eq. 11)
  R_U  = N_L·P_U·P_P·L_T                      P_U  = P_am·P_EB·P_LD·P_TWS·C_LD·r_t (B.10)
  R_V  = N_L·P_V·(P_P·L_F1 + L_F2)            P_V  = P_EB·P_LD·P_TWS·C_LD·r_f·r_p (B.11)
  R_W  = N_L·P_W·P_e·(P_P·L_O1ᵃ + L_O2ᵇ)       P_W  = P_SPD·P_TWS·P_LD·C_LD (B.12)
  R_Z  = N_I·P_Z·P_e·(P_P·L_O1ᵃ + L_O2ᵇ)       P_Z  = P_SPD·P_TWS·C_LI (B.13)
  ᵃ where failure of internal systems endangers life (hospitals, explosion);
  ᵇ with a risk of explosion (Table 3 notes a, b).
Frequency of damage (Table 4): F_C = N_D·P_C·P_e, F_M = N_M·P_M·P_e,
F_W = N_L·P_W·P_e, F_Z = N_I·P_Z·P_e.

Rules applied from the notes:
  - P_S = 1 once an LPS is installed; the LPS acts through P_LPS (Table B.4 Note 1).
  - For flashes to the structure (S1), protection measures — P_am, fire
    provisions on R_B, coordinated SPDs on P_C — count only in a structure
    with an LPS or a continuous metal / reinforced-concrete frame acting as a
    natural LPS (Table 2 note h, B.2 Note 2, B.5 Note 1).
  - r_p = 1 in zones with a risk of explosion or lithium-ion batteries (B.4).
  - A_M uses the lowest U_W of the internal systems (Annex F examples).
  - An internal system with no metallic external line: C_LD = 0 if its
    wiring is shielded, else 1 (Table B.9 Note 7).

SIMPLIFICATIONS: no thunderstorm warning system (P_TWS = 1); no adjacent
structures (N_DJ = 0); every line has its own routing (8.2 — the conservative
reading, summing all lines); no environmental loss L_E (Annex E); P_e is not
reduced by r_f in explosive zones (B.12 Note 2 permits it; omitting is
conservative).

Verified end-to-end against the standard's worked examples, Annex F.2
(house), F.3 (office, five zones) and F.4 (hospital, five zones), unprotected
and protected, risk and frequency: test_lightning_review_fixes.py.
"""

import math
from typing import Optional

from ..models.schemas import (
    LightningRiskRequest, LightningRiskResult, LightningRiskComponentRow,
    LightningProtectionOption, LightningZoneResult, LightningZoneComponent,
    Lightning2024Input, Lightning2024Line, Lightning2024Zone,
)

TOLERABLE_R = 1e-5          # 7.3 Note 1: representative value

# ── Annex A ──
LOCATION_FACTOR = {"surrounded_by_taller": 0.25, "surrounded_same_height": 0.5,
                   "isolated": 1.0, "isolated_hilltop": 2.0}              # Table A.1
INSTALLATION_FACTOR = {"aerial": 1.0, "buried": 0.3, "buried_meshed": 0.01}  # Table A.2
LINE_TYPE_FACTOR = {"lv": 1.0, "hv": 0.2}                                 # Table A.3
ENVIRONMENT_FACTOR = {"rural": 1.0, "suburban": 0.5, "urban": 0.1,
                      "urban_tall_buildings": 0.01}                       # Table A.4

# ── Annex B ──
P_AM = {"none": 1.0, "warning": 1e-1, "insulation": 1e-2, "soil_equipotential": 1e-2,
        "natural_lps": 1e-3, "access_restricted": 0.0}                    # Table B.1
FLOOR_FACTOR = {"agricultural_concrete": 1e-2, "marble_ceramic": 1e-3,
                "gravel_carpet": 1e-4, "asphalt_wood_linoleum": 1e-5}     # Table B.2
P_LPS = {"none": 1.0, "IV": 0.2, "III": 0.1, "II": 0.05, "I": 0.02,
         "I_natural": 0.01, "I_metal_roof": 0.001}                        # Table B.3
P_S = {"masonry": 1.0, "rc_frame": 0.5}                                   # Table B.4
FIRE_PROTECTION = {"none": 1.0, "manual": 0.5, "automatic": 0.2}          # Table B.5
FIRE_RISK = {"explosion_z0": 1.0, "explosion_z1": 1e-1, "explosion_z2": 1e-3,
             "high": 1e-1, "ordinary": 1e-2, "low": 1e-3, "none": 0.0}    # Table B.6
# Coordinated SPD system (Tables B.7/B.8). "better": better than LPL I at the
# P_SPD = 0.002 used in the Annex F.4 hospital.
P_SPD = {"none": 1.0, "III-IV": 0.05, "II": 0.02, "I": 0.01, "better": 0.002}
P_EB = {"none": 1.0, "III-IV": 0.05, "II": 0.02, "I": 0.01}               # Table B.13
KS3 = {"different_routing": 1.0, "same_conduit_wide": 0.5, "same_conduit": 0.2,
       "same_cable": 0.01, "shielded": 1e-4}                              # Table B.10
# Table B.11: P_LD by screen and U_W (kV).
_PLD_UW = [0.35, 0.5, 1.0, 1.5, 2.5, 4.0, 6.0, 12.0]
_PLD = {
    "bonded_rs_5_20": [1, 1, 1, 1, 0.95, 0.9, 0.8, 0.4],
    "bonded_rs_1_5":  [1, 1, 0.9, 0.8, 0.6, 0.3, 0.1, 0.02],
    "bonded_rs_le1":  [1, 0.85, 0.6, 0.4, 0.2, 0.04, 0.02, 0.005],
}
DEFAULT_UW = {"power": 2.5, "telecom": 1.5}

# ── Annex C, Table C.2: the highest value of each range (the recommended default)
LOSS_CLASS = {
    "low":       dict(lt=1e-2, ld=1e-1, lf1=2e-2, lf2=2e-2, lo1=1e-4, lo2=1e-4),
    "normal":    dict(lt=1e-2, ld=1e-1, lf1=5e-2, lf2=5e-2, lo1=5e-4, lo2=5e-4),
    "high":      dict(lt=1e-2, ld=1e-1, lf1=1e-1, lf2=1e-1, lo1=1e-3, lo2=1e-3),
    "very_high": dict(lt=1e-2, ld=1e-1, lf1=2e-1, lf2=2e-1, lo1=1e-2, lo2=1e-2),
}

_LPS_ORDER = ["none", "IV", "III", "II", "I"]
_SPD_ORDER = ["none", "III-IV", "II", "I", "better"]
_EB_ORDER = ["none", "III-IV", "II", "I"]
# Lightning equipotential bonding an LPS of each class needs (IEC 62305-3):
_EB_FOR_LPS = {"none": "none", "IV": "III-IV", "III": "III-IV", "II": "II", "I": "I",
               "I_natural": "I", "I_metal_roof": "I"}

DESCRIPTIONS = {
    "RAT": "Injury by touch/step voltage (flash to structure)",
    "RAD": "Direct strike to people on the structure",
    "RB": "Physical damage / fire (flash to structure)",
    "RC": "Internal system failure (flash to structure)",
    "RM": "Internal system failure (flash near structure)",
    "RU": "Injury by touch voltage (flash to line)",
    "RV": "Physical damage / fire (flash to line)",
    "RW": "Internal system failure (flash to line)",
    "RZ": "Internal system failure (flash near line)",
    "FC": "Damage to internal systems, flash to structure",
    "FM": "Damage to internal systems, flash near structure",
    "FW": "Damage to internal systems, flash to line",
    "FZ": "Damage to internal systems, flash near line",
}


def _is_explosion(zone: Lightning2024Zone) -> bool:
    return zone.fire_risk.startswith("explosion")


def _pld(shield: str, uw_kv: float) -> float:
    """Table B.11. Snaps DOWN to the tabulated U_W at or below the value
    (the conservative column)."""
    row = _PLD.get(shield)
    if row is None:
        return 1.0
    i = max((j for j, u in enumerate(_PLD_UW) if u <= uw_kv + 1e-9), default=0)
    return float(row[i])


def _cld_cli(line: Lightning2024Line):
    """Table B.9. A screen that is not bonded to the equipment's bar: C_LI 0.3
    buried / 0.1 aerial — the value leading to the higher risk (0.3) when the
    line has any buried section (8.4)."""
    sh = line.shield
    if sh in ("protective_conduit", "isolating_interface"):
        return 0.0, 0.0
    if sh.startswith("bonded"):
        return 1.0, 0.0
    if sh == "not_bonded":
        buried = any(s.installation != "aerial" for s in line.sections)
        return 1.0, (0.3 if buried or not line.sections else 0.1)
    if sh == "multi_grounded_neutral":
        return 1.0, 0.2
    return 1.0, 1.0


def _line_events(inp: Lightning2024Input, line: Lightning2024Line, uw_kv: float):
    """N_L (A.9) and N_I at the given U_W (A.11/A.12), summed over sections."""
    nsg, k = inp.strike_density, (inp.k if inp.k > 0 else 2.0)
    r_i = 2000.0 / (uw_kv ** 1.8)
    nl = ni = 0.0
    for s in line.sections:
        f = (INSTALLATION_FACTOR.get(s.installation, 1.0) * ENVIRONMENT_FACTOR.get(s.environment, 1.0)
             * LINE_TYPE_FACTOR.get(s.line_type, 1.0) * 1e-6)
        nl += nsg * 40.0 * s.length_m * f
        ni += (1.0 / k) * nsg * 2.0 * r_i * s.length_m * f
    return nl, ni


def _loss(zone: Lightning2024Zone, explosion: bool):
    cls = zone.loss_class if zone.loss_class in LOSS_CLASS else "normal"
    if explosion:
        cls = "very_high"            # Table C.2 note a
    L = dict(LOSS_CLASS[cls])
    for key, v in (zone.loss_overrides or {}).items():
        if key in L and v is not None and v >= 0:
            L[key] = float(v)
    return L


def _evaluate(req: LightningRiskRequest, inp: Lightning2024Input,
              lps: str, eb: str, spd: Optional[str], notes: Optional[list] = None):
    """Risk and frequency per zone for one set of structure-level measures.
    `spd` overrides every internal system's coordinated SPD level (the
    recommendation ladder); None keeps each system's own."""
    say = notes.append if notes is not None else (lambda _m: None)
    L, W, H = req.length_m, req.width_m, req.height_m
    nsg, k = inp.strike_density, (inp.k if inp.k > 0 else 2.0)
    cd = LOCATION_FACTOR.get(req.location, 1.0)
    ad = L * W + 2 * (3 * H) * (L + W) + math.pi * (3 * H) ** 2         # A.3
    nd = nsg * ad * cd * 1e-6                                           # A.5

    all_systems = [s for z in inp.zones for s in z.systems]
    uw_min = min((s.uw_kv for s in all_systems), default=None)
    if uw_min:
        r_m = 350.0 / uw_min                                            # A.8
        am = 2 * r_m * (L + W) + math.pi * r_m ** 2
        nm = (1.0 / k) * nsg * am * 1e-6                                # A.7
    else:
        am = nm = 0.0

    has_lps = lps != "none"
    natural_lps = inp.construction == "rc_frame"
    s1_measures = has_lps or natural_lps          # Table 2 note h
    p_lps = P_LPS.get(lps, 1.0)
    p_s = 1.0 if has_lps else P_S.get(inp.construction, 1.0)            # Table B.4 Note 1
    p_eb = P_EB.get(eb, 1.0)
    ks1 = min(1.0, 0.12 * inp.ks1_mesh_m) if inp.ks1_mesh_m > 0 else 1.0

    lines = {ln.name: ln for ln in inp.lines}
    line_uw = {}                                   # U_W for a line's own P_LD in R_U/R_V
    for s in all_systems:
        if s.line in lines:
            line_uw[s.line] = min(line_uw.get(s.line, 1e9), s.uw_kv)
    line_rows = []
    line_nl = {}
    for ln in inp.lines:
        uw = line_uw.get(ln.name, DEFAULT_UW.get(ln.type, 2.5))
        nl, ni = _line_events(inp, ln, uw)
        line_nl[ln.name] = nl
        line_rows.append({"name": ln.name, "nl": nl, "ni": ni})

    zones_out = []
    for z in inp.zones:
        expl = _is_explosion(z)
        Lz = _loss(z, expl)
        pp = max(0.0, min(z.hours_present, 8760.0)) / 8760.0            # B.14
        pe = max(0.0, min(z.equipment_hours, 8760.0)) / 8760.0          # B.15
        rt = FLOOR_FACTOR.get(z.floor, 1e-2)
        p_am = P_AM.get(z.touch_measure, 1.0)
        if z.touch_measure == "natural_lps" and not natural_lps:
            p_am = 1.0
            say(f"{z.name}: 'natural LPS' touch protection needs a continuous metal or reinforced-concrete frame — not credited.")
        p_am_s1 = p_am if s1_measures else 1.0
        if p_am < 1.0 and not s1_measures:
            say(f"{z.name}: touch/step measures are credited for flashes to the structure only with an LPS or a natural LPS (Table 2 note h) — P_am = 1 used for R_AT/R_AD.")
        rf = FIRE_RISK.get(z.fire_risk, 1e-2)
        rp = FIRE_PROTECTION.get(z.fire_protection, 1.0)
        if expl or z.lithium_ion:
            rp = 1.0                                                     # B.4
        rp_s1 = rp if s1_measures else 1.0
        life = z.life_critical or expl
        # loss multipliers for internal-system components
        lo_mult = (pp * Lz["lo1"] if life else 0.0) + (Lz["lo2"] if expl else 0.0)
        comps = {}      # code -> (value, life part)

        def add(code, total, life_part):
            v, lpart = comps.get(code, (0.0, 0.0))
            comps[code] = (v + total, lpart + life_part)

        # S1 touch/step + direct strike (every zone)
        p_at = p_lps * p_am_s1 * rt
        add("RAT", nd * p_at * pp * Lz["lt"], nd * p_at * pp * Lz["lt"])
        if z.kind == "exposed":
            p_o = 1.0 if z.persons_exposed else 0.0
            p_ad = p_am_s1 * p_o * p_lps
            add("RAD", nd * p_ad * pp * Lz["ld"], nd * p_ad * pp * Lz["ld"])
        fc = fm = fw = fz = 0.0
        if z.kind != "exposed":
            # R_B
            p_b = p_s * p_lps * rf * rp_s1
            add("RB", nd * p_b * (pp * Lz["lf1"] + Lz["lf2"]), nd * p_b * pp * Lz["lf1"])
            # internal systems: P_C, P_M
            ks2 = min(1.0, 0.12 * z.ks2_mesh_m) if z.ks2_mesh_m > 0 else 1.0
            q_c = q_m = 1.0
            for s in z.systems:
                ps_ = P_SPD.get(spd if spd is not None else s.spd_level, 1.0)
                line = lines.get(s.line)
                if line is not None:
                    cld = _cld_cli(line)[0]
                else:
                    cld = 0.0 if s.wiring == "shielded" else 1.0         # Table B.9 Note 7
                q_c *= 1.0 - (ps_ if s1_measures else 1.0) * cld
                pms = min(1.0, (ks1 * ks2 * KS3.get(s.wiring, 1.0)) ** 2)  # B.7
                q_m *= 1.0 - ps_ * pms
            p_c = 1.0 - q_c if z.systems else 0.0
            p_m = 1.0 - q_m if z.systems else 0.0
            add("RC", nd * p_c * pe * lo_mult, nd * p_c * pe * (pp * Lz["lo1"] if life else 0.0))
            add("RM", nm * p_m * pe * lo_mult, nm * p_m * pe * (pp * Lz["lo1"] if life else 0.0))
            fc, fm = nd * p_c * pe, nm * p_m * pe
            # lines: R_U, R_V to the zone; R_W, R_Z through its systems
            for ln in inp.lines:
                nl = line_nl[ln.name]
                cld, cli = _cld_cli(ln)
                pld_line = _pld(ln.shield, line_uw.get(ln.name, DEFAULT_UW.get(ln.type, 2.5)))
                p_u = p_am * p_eb * pld_line * cld * rt
                p_v = p_eb * pld_line * cld * rf * rp
                add("RU", nl * p_u * pp * Lz["lt"], nl * p_u * pp * Lz["lt"])
                add("RV", nl * p_v * (pp * Lz["lf1"] + Lz["lf2"]), nl * p_v * pp * Lz["lf1"])
                on_line = [s for s in z.systems if s.line == ln.name]
                if on_line:
                    w_best = z_best = 0.0
                    for s in on_line:
                        ps_ = P_SPD.get(spd if spd is not None else s.spd_level, 1.0)
                        p_w = ps_ * _pld(ln.shield, s.uw_kv) * cld
                        _nl, ni = _line_events(inp, ln, s.uw_kv)
                        w_best = max(w_best, nl * p_w)
                        z_best = max(z_best, ni * ps_ * cli)
                    add("RW", w_best * pe * lo_mult, w_best * pe * (pp * Lz["lo1"] if life else 0.0))
                    add("RZ", z_best * pe * lo_mult, z_best * pe * (pp * Lz["lo1"] if life else 0.0))
                    fw += w_best * pe
                    fz += z_best * pe
        risk = sum(v for v, _ in comps.values())
        risk_life = sum(lp for _, lp in comps.values())
        zones_out.append(dict(
            zone=z, risk=risk, risk_life=risk_life, risk_damage=risk - risk_life, comps=comps,
            has_systems=bool(z.systems) and z.kind != "exposed",
            f=dict(FC=fc, FM=fm, FW=fw, FZ=fz), frequency=fc + fm + fw + fz,
            rp_credit=rp < 1.0 and (z.kind != "exposed"), life=life,
        ))
    return dict(ad=ad, am=am, nd=nd, nm=nm, zones=zones_out, lines=line_rows)


def _rows(comps: dict, total: float):
    return [LightningZoneComponent(
        code=code, description=DESCRIPTIONS[code], value=v,
        share_pct=(100.0 * v / total) if total > 0 else 0.0, loss_of_life=lp)
        for code, (v, lp) in comps.items()]


def _option_label(lps: str, eb: str, spd: str) -> str:
    parts = []
    if lps != "none":
        parts.append(f"LPS class {lps.replace('_natural', ' (natural down-conductors)').replace('_metal_roof', ' (metal roof)')}")
    if eb != "none" and not (lps != "none" and eb == _EB_FOR_LPS[lps]):
        parts.append(f"entrance SPDs (LPL {eb})")
    elif eb != "none":
        parts.append(f"bonding SPDs at the entrance (LPL {eb})")
    if spd not in (None, "none"):
        parts.append("coordinated SPDs (" + ("better than LPL I" if spd == "better" else f"LPL {spd}") + ")")
    return " + ".join(parts) if parts else "No protection"


def run_lightning_risk_2024(req: LightningRiskRequest) -> LightningRiskResult:
    inp = req.v2024 or Lightning2024Input()
    warnings = []
    if inp.strike_density <= 0:
        warnings.append("Strike-point density N_SG must be > 0 — using 2.0 (N_G = 1 × k = 2).")
        inp.strike_density = 2.0
    if not inp.zones:
        inp.zones = [Lightning2024Zone()]
    if not inp.lines:
        warnings.append("No metallic service lines modelled — R_U, R_V, R_W and R_Z are zero. "
                        "Most structures have at least a power supply.")
    rt = req.tolerable_risk if req.tolerable_risk and req.tolerable_risk > 0 else TOLERABLE_R
    lps, eb = inp.lps_class, inp.eb_level
    if lps != "none" and _EB_ORDER.index(eb) < _EB_ORDER.index(_EB_FOR_LPS[lps]):
        warnings.append(f"IEC 62305-3 requires lightning equipotential bonding of the incoming lines with an LPS "
                        f"(SPDs at LPL {_EB_FOR_LPS[lps]} for class {lps}). Assessed as entered (P_EB for LPL {eb}).")
    notes: list = []
    base = _evaluate(req, inp, lps, eb, None, notes)
    for n in dict.fromkeys(notes):
        warnings.append(n)
    for z in base["zones"]:
        if _is_explosion(z["zone"]) and z["zone"].loss_class != "very_high":
            warnings.append(f"{z['zone'].name}: a risk of explosion is a very-high-loss zone (Table C.2 note a) — "
                            "its loss values are used.")
        if z["rp_credit"]:
            warnings.append(f"{z['zone'].name}: fire provisions are credited (r_p < 1). IEC 62305-2 B.4: only if "
                            "they are operational at the time of a lightning event — the owner should be told.")

    zone_results = []
    for z in base["zones"]:
        zobj = z["zone"]
        ft = zobj.tolerable_frequency if zobj.tolerable_frequency > 0 else 0.1
        fcomps = {code: (v, 0.0) for code, v in z["f"].items()}
        zone_results.append(LightningZoneResult(
            name=zobj.name, kind=zobj.kind, risk=z["risk"], compliant=z["risk"] <= rt,
            components=_rows(z["comps"], z["risk"]),
            risk_life=z["risk_life"], risk_damage=z["risk_damage"],
            has_systems=z["has_systems"], frequency=z["frequency"] if z["has_systems"] else 0.0,
            tolerable_frequency=ft,
            frequency_compliant=(z["frequency"] <= ft) if z["has_systems"] else True,
            frequency_components=_rows(fcomps, z["frequency"]) if z["has_systems"] else [],
        ))
    gov = max(zone_results, key=lambda zr: zr.risk)
    compliant = all(zr.compliant for zr in zone_results)
    f_ok = all(zr.frequency_compliant for zr in zone_results)

    # ── Recommendation: every (LPS, entrance SPD, coordinated SPD) combination
    # the ladder allows, lightest first — LPS class, then coordinated SPDs,
    # then entrance SPDs. An LPS always brings its equipotential bonding.
    def score(ev):
        r = max(zz["risk"] for zz in ev["zones"])
        ok_r = all(zz["risk"] <= rt for zz in ev["zones"])
        fmax = max((zz["frequency"] for zz in ev["zones"] if zz["has_systems"]), default=0.0)
        ok_f = all(zz["frequency"] <= (zz["zone"].tolerable_frequency or 0.1)
                   for zz in ev["zones"] if zz["has_systems"])
        return r, ok_r, fmax, ok_f

    combos = []
    for l in _LPS_ORDER:
        for sp in _SPD_ORDER:
            for e in _EB_ORDER:
                if _EB_ORDER.index(e) < _EB_ORDER.index(_EB_FOR_LPS[l]):
                    continue
                r, ok_r, fmax, ok_f = score(_evaluate(req, inp, l, e, sp))
                combos.append((l, e, sp, r, ok_r, fmax, ok_f))
    rec = next((c for c in combos if c[4]), None)
    rec_f = next((c for c in combos if c[4] and c[6]), None)
    rows = []
    for l in _LPS_ORDER:
        mine = [c for c in combos if c[0] == l]
        rows.append(next((c for c in mine if c[4]), mine[-1]))
    for extra in (rec, rec_f):
        if extra and extra not in rows:
            rows.append(extra)
    rows.sort(key=lambda c: (_LPS_ORDER.index(c[0]), _SPD_ORDER.index(c[2]), _EB_ORDER.index(c[1])))
    options = [LightningProtectionOption(
        lps_class=l, spd_level=sp, eb_level=e, label=_option_label(l, e, sp), r1=r,
        compliant=ok_r, frequency=fmax, frequency_compliant=ok_f)
        for l, e, sp, r, ok_r, fmax, ok_f in rows]

    if rec is None:
        warnings.append("R exceeds the tolerable level even with LPS class I and coordinated SPDs better than "
                        "LPL I — further measures are needed (spatial shielding, fire suppression, restricted "
                        "occupancy, a thunderstorm warning system, or a zone-by-zone assessment).")
    entered_none = lps == "none" and eb == "none" and all(
        s.spd_level == "none" for zz in inp.zones for s in zz.systems)
    recommendation = (
        "No protection required — R is within the tolerable level in every zone."
        if compliant and entered_none
        else "Existing/entered measures are sufficient for R." if compliant
        else f"Install {_option_label(rec[0], rec[1], rec[2])}." if rec
        else "Risk cannot be reduced below R_T with LPS and SPDs alone.")
    freq_rec = (
        "The frequency of damage is within the tolerable value in every zone." if f_ok
        else f"To also meet the tolerable frequency: {_option_label(rec_f[0], rec_f[1], rec_f[2])}." if rec_f
        else "The tolerable frequency cannot be met with the listed measures — consider spatial shields, "
             "isolating interfaces or equipment with a higher withstand.")

    return LightningRiskResult(
        edition="2024",
        collection_area_m2=round(base["ad"], 1),
        collection_area_near_m2=round(base["am"], 1),
        flashes_to_structure_per_year=base["nd"],
        flashes_near_structure_per_year=base["nm"],
        r1=gov.risk,
        tolerable_r1=rt,
        compliant=compliant,
        components=[LightningRiskComponentRow(code=c.code, description=c.description, value=c.value,
                                              share_pct=c.share_pct) for c in gov.components],
        options=options,
        recommendation=recommendation,
        systems_life_risk=any(z["life"] for z in base["zones"]),
        warnings=warnings,
        zones=zone_results,
        governing_zone=gov.name,
        frequency_compliant=f_ok,
        frequency_recommendation=freq_rec,
        lines_events=base["lines"],
    )
