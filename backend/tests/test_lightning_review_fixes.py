"""Lightning risk review (reviews/LIGHTNING_RISK_REVIEW.md) — regression tests.

Two groups:
  * the 2010 (Ed. 2) engine fixes LR1–LR7, each reproducing the original
    defect;
  * the IEC 62305-2:2024 (Ed. 3) engine [E1], pinned to the standard's own
    worked examples in Annex F — the house (F.2), the office building (F.3)
    and the hospital (F.4), unprotected and protected, zone by zone and
    component by component, risk R and frequency of damage F. The expected
    numbers are the published Tables F.8/F.9, F.21–F.24 and F.35–F.38, not
    values produced by the engine.
"""

import math

import pytest

from backend.analysis.lightning_risk import run_lightning_risk
from backend.models.schemas import LightningRiskRequest


# ─────────────────────────────── 2010 fixes ────────────────────────────────

def _req2010(**over):
    base = dict(length_m=20, width_m=15, height_m=8, location="surrounded_same_height",
                ground_flash_density=4, structure_use="other", persons_in_zone=10, persons_total=10,
                hours_per_year=8760, hazard_level="none", floor_type="agricultural_concrete",
                fire_risk="ordinary", fire_protection="none", explosion_risk=False,
                equipment_withstand_kv=2.5, lps_class="none", spd_level="none",
                lines=[dict(name="P", type="power", length_m=1000, installation="buried",
                            environment="suburban", has_transformer=True)])
    base.update(over)
    return LightningRiskRequest(**base)


def _comp(res, code):
    return next(c.value for c in res.components if c.code == code)


class TestLightning2010Fixes:
    def test_lr1_hotel_school_has_no_internal_system_loss(self):
        """[LR1] Table C.2 gives L_O only for explosion and hospitals: a hotel
        or school carries L_F = 1e-1 but no R_C/R_M/R_W/R_Z. The old combined
        card overstated a 200-person hotel 47× and recommended LPS class I +
        SPDs LPL I; SPDs LPL III-IV alone meet R_T."""
        res = run_lightning_risk(_req2010(structure_use="hotel_school_civic",
                                          persons_in_zone=200, persons_total=200))
        assert not res.systems_life_risk
        for code in ("RC", "RM", "RW", "RZ"):
            assert _comp(res, code) == 0.0
        assert res.r1 == pytest.approx(1.714e-5, rel=2e-3)
        assert "coordinated SPDs (LPL III-IV)" in res.recommendation
        assert "LPS" not in res.recommendation

    def test_lr1_legacy_key_reads_as_hospital(self):
        """Saved assessments carry 'hospital_hotel_school': it must reproduce
        the old number exactly (read as a hospital, L_O = 1e-3)."""
        old = run_lightning_risk(_req2010(structure_use="hospital_hotel_school"))
        new = run_lightning_risk(_req2010(structure_use="hospital"))
        assert old.systems_life_risk and old.r1 == pytest.approx(new.r1, rel=1e-12)

    def test_lr2_explosion_uses_lf_1e_1_and_no_fire_credit(self):
        """[LR2] With a risk of explosion L_F = 1e-1 (Table C.2) and r_p = 1
        (Table C.4 note). An industrial plant with automatic extinguishing:
        R_B = N_D·P_B·r_p·r_f·h_z·L_F·occ = N_D·1·1·1·1·1e-1·occ."""
        res = run_lightning_risk(_req2010(explosion_risk=True, structure_use="industrial_commercial",
                                          fire_protection="automatic"))
        nd = res.flashes_to_structure_per_year
        assert _comp(res, "RB") == pytest.approx(nd * 1e-1, rel=1e-9)

    def test_lr3_telecom_pli_at_2_5kv(self):
        """[LR3] Table B.9 (2010): TLC P_LI at U_W = 2.5 kV is 0.2.
        R_Z = N_I·P_SPD·P_LI·C_LI·L_Z for a hospital's aerial telecom line."""
        tel = dict(name="T", type="telecom", length_m=1000, installation="aerial",
                   environment="rural", has_transformer=False)
        res = run_lightning_risk(_req2010(structure_use="hospital", lines=[tel]))
        ni = 4 * 4000 * 1000 * 1 * 1 * 1 * 1e-6
        assert _comp(res, "RZ") == pytest.approx(ni * 1 * 0.2 * 1 * 1e-3, rel=1e-9)

    def test_lr4_hospital_icu_lo_1e_2(self):
        """[LR4] Intensive care / operating block: L_O = 1e-2 (Table C.2),
        ten times the rest of a hospital."""
        ward = run_lightning_risk(_req2010(structure_use="hospital"))
        icu = run_lightning_risk(_req2010(structure_use="hospital_icu"))
        assert _comp(icu, "RC") == pytest.approx(10 * _comp(ward, "RC"), rel=1e-9)

    def test_lr5_shield_pld_from_rs_and_uw(self):
        """[LR5] Table B.8: a screen bonded at the entrance with
        5 < R_S <= 20 ohm/km gives P_LD = 1 at U_W = 1.5 kV (the old flat 0.2
        made R_U/R_V 5× low); R_S <= 1 ohm/km gives 0.4. The legacy
        `shielded: true` keeps its old reading (bonded, R_S <= 1, 2.5 kV = 0.2)."""
        def rv(**line):
            base = dict(name="T", type="telecom", length_m=2000, installation="aerial",
                        environment="rural", has_transformer=False)
            base.update(line)
            return _comp(run_lightning_risk(_req2010(equipment_withstand_kv=1.5, lines=[base])), "RV")
        unsh = rv(screen="unshielded")
        assert rv(screen="bonded_rs_5_20") == pytest.approx(unsh, rel=1e-9)
        assert rv(screen="bonded_rs_le1") == pytest.approx(0.4 * unsh, rel=1e-9)
        legacy = run_lightning_risk(_req2010(lines=[dict(name="T", type="telecom", length_m=2000,
                                    installation="aerial", environment="rural",
                                    has_transformer=False, shielded=True)]))
        plain = run_lightning_risk(_req2010(lines=[dict(name="T", type="telecom", length_m=2000,
                                   installation="aerial", environment="rural",
                                   has_transformer=False)]))
        assert _comp(legacy, "RV") == pytest.approx(0.2 * _comp(plain, "RV"), rel=1e-9)

    def test_lr6_pc_combines_over_lines_and_zero_without_lines(self):
        """[LR6] P_C = 1 − Π(1 − P_SPD·C_LD) over the internal systems (one per
        line): two lines with SPDs LPL III-IV give 1 − 0.95² = 0.0975, not
        0.05. No external line: C_LD = 0 ⇒ R_C = 0."""
        tel = dict(name="T", type="telecom", length_m=1000, installation="buried",
                   environment="suburban", has_transformer=False)
        two = _req2010(structure_use="hospital", spd_level="III-IV", lps_class="II")
        two.lines.append(LightningRiskRequest(**dict(_req2010().model_dump(), lines=[tel])).lines[0])
        res = run_lightning_risk(two)
        nd = res.flashes_to_structure_per_year
        assert _comp(res, "RC") == pytest.approx(nd * (1 - 0.95 ** 2) * 1e-3, rel=1e-9)
        none = run_lightning_risk(_req2010(structure_use="hospital", lines=[]))
        assert _comp(none, "RC") == 0.0

    def test_lr7_recommends_spd_without_lps_when_enough(self):
        """[LR7] A small hospital at N_G = 2 needs only SPDs LPL I; the old
        six-step ladder skipped 'SPDs II/I, no LPS' and recommended LPS II."""
        res = run_lightning_risk(_req2010(structure_use="hospital", ground_flash_density=2,
                                          persons_in_zone=10, persons_total=10))
        rec = next(o for o in res.options if o.compliant)
        assert rec.lps_class == "none"
        assert rec.spd_level in ("II", "I")

    def test_tolerable_risk_is_an_input(self):
        """R_T is set by the authority having jurisdiction (62305-1:2024 §6.2);
        the default stays 1e-5."""
        res = run_lightning_risk(_req2010(tolerable_risk=1e-7))
        assert res.tolerable_r1 == 1e-7 and not res.compliant
        assert run_lightning_risk(_req2010()).tolerable_r1 == 1e-5


# ───────────────────── IEC 62305-2:2024 — Annex F examples ─────────────────

def _req2024(L, W, H, v2024, rt=1e-5):
    return LightningRiskRequest(edition="2024", length_m=L, width_m=W, height_m=H,
                                location="isolated", tolerable_risk=rt, v2024=v2024)


def _zone(res, name):
    return next(z for z in res.zones if z.name == name)


def _v(zone, code, freq=False):
    rows = zone.frequency_components if freq else zone.components
    return next((c.value for c in rows if c.code == code), 0.0)


def _check_risk(res, table):
    """table: {zone: {code: value ×1e-5}} as printed (3 decimals, so half a
    last digit = 5e-4; 0 = '≈0', i.e. below that)."""
    for zname, row in table.items():
        z = _zone(res, zname)
        for code, want in row.items():
            got = (z.risk if code == "R" else _v(z, code)) * 1e5
            if want == 0:
                assert got < 5e-4 + 1e-9, (zname, code, got)
            else:
                assert got == pytest.approx(want, rel=3e-3, abs=5e-4 + 1e-9), (zname, code, got, want)


def _check_freq(res, table, decimals=3):
    """Printed to `decimals` places (F.22/F.24/F.36: 3, F.38: 4), so the
    tolerance is half the last printed digit (plus float slack)."""
    half = 0.5 * 10 ** -decimals + 1e-9
    for zname, row in table.items():
        z = _zone(res, zname)
        for code, want in row.items():
            got = z.frequency if code == "F" else _v(z, code, freq=True)
            if want == 0:
                assert got < half, (zname, code, got)
            else:
                assert got == pytest.approx(want, rel=3e-3, abs=half), (zname, code, got, want)


def _house(eb="none"):
    return dict(
        strike_density=8.0, k=2.0, construction="masonry", lps_class="none", eb_level=eb,
        lines=[dict(name="Power", type="power", shield="unshielded",
                    sections=[dict(length_m=1000, installation="aerial", line_type="lv", environment="rural")]),
               dict(name="Telecom", type="telecom", shield="unshielded",
                    sections=[dict(length_m=800, installation="aerial", line_type="lv", environment="rural")])],
        zones=[dict(name="Z2", kind="inside", hours_present=4380, equipment_hours=8760,
                    floor="asphalt_wood_linoleum", fire_risk="low", fire_protection="none",
                    loss_class="low", tolerable_frequency=0.1,
                    systems=[dict(type="power", line="Power", uw_kv=2.5, wiring="same_conduit"),
                             dict(type="telecom", line="Telecom", uw_kv=1.5, wiring="different_routing")])])


class TestAnnexF2House:
    def test_events(self):
        """Table F.5: N_D 2.06e-2, N_M 0.75, N_LP 0.32, N_IP 3.07, N_LT 0.256, N_IT 6.17."""
        res = run_lightning_risk(_req2024(15, 20, 6, _house()))
        assert res.flashes_to_structure_per_year == pytest.approx(2.06e-2, rel=3e-3)
        assert res.flashes_near_structure_per_year == pytest.approx(0.75, rel=3e-3)
        ev = {row["name"]: row for row in res.lines_events}
        assert ev["Power"]["nl"] == pytest.approx(0.32, rel=1e-6)
        assert ev["Power"]["ni"] == pytest.approx(3.07, rel=3e-3)
        assert ev["Telecom"]["nl"] == pytest.approx(0.256, rel=1e-6)
        assert ev["Telecom"]["ni"] == pytest.approx(6.17, rel=3e-3)

    def test_unprotected_table_f8(self):
        res = run_lightning_risk(_req2024(15, 20, 6, _house()))
        _check_risk(res, {"Z2": {"RAT": 0, "RB": 0.062, "RU": 0.003, "RV": 1.728, "R": 1.793}})
        assert not res.compliant

    def test_protected_table_f9(self):
        """SPDs LPL IV at the entrance of both lines (P_EB = 0.05)."""
        res = run_lightning_risk(_req2024(15, 20, 6, _house(eb="III-IV")))
        _check_risk(res, {"Z2": {"RAT": 0, "RB": 0.062, "RU": 0, "RV": 0.086, "R": 0.149}})
        assert res.compliant

    def test_recommendation_is_entrance_spds(self):
        """F.2.7: the minimum measure is entrance SPDs of LPL IV, no LPS."""
        res = run_lightning_risk(_req2024(15, 20, 6, _house()))
        rec = next(o for o in res.options if o.compliant)
        assert (rec.lps_class, rec.eb_level) == ("none", "III-IV")


def _office(protected=False):
    lps, eb, spd = ("II", "II", "II") if protected else ("none", "none", "none")
    inside = lambda name, t, rf, rp, loss: dict(
        name=name, kind="inside", hours_present=t, equipment_hours=8760, floor="asphalt_wood_linoleum",
        fire_risk=rf, fire_protection=rp, loss_class=loss, tolerable_frequency=0.05,
        systems=[dict(type="power", line="Power", uw_kv=2.5, wiring="same_conduit", spd_level=spd),
                 dict(type="telecom", line=None, uw_kv=1.5, wiring="different_routing", spd_level=spd)])
    return dict(
        strike_density=4.0, k=2.0, construction="rc_frame", lps_class=lps, eb_level=eb,
        lines=[dict(name="Power", type="power", shield="unshielded", sections=[
            dict(length_m=1000, installation="buried", line_type="hv", environment="suburban"),
            dict(length_m=100, installation="buried", line_type="lv", environment="suburban")])],
        zones=[dict(name="Z1", kind="exposed", hours_present=175, floor="marble_ceramic",
                    fire_risk="none", loss_class="low"),
               dict(name="Z2", kind="exposed", hours_present=18, floor="asphalt_wood_linoleum",
                    persons_exposed=True, fire_risk="none", loss_class="low"),
               inside("Z3", 440, "high", "automatic", "normal"),
               inside("Z4", 2630, "low", "manual", "normal"),
               inside("Z5", 2200, "low", "automatic", "high")])


class TestAnnexF3Office:
    def test_events_table_f14(self):
        res = run_lightning_risk(_req2024(20, 40, 25, _office()))
        assert res.flashes_to_structure_per_year == pytest.approx(0.11, rel=3e-3)
        assert res.flashes_near_structure_per_year == pytest.approx(0.398, rel=3e-3)
        ev = res.lines_events[0]
        assert ev["nl"] == pytest.approx(4.8e-3 + 2.4e-3, rel=1e-6)
        assert ev["ni"] == pytest.approx(4.61e-2 + 2.31e-2, rel=3e-3)

    def test_unprotected_table_f21(self):
        res = run_lightning_risk(_req2024(20, 40, 25, _office()))
        _check_risk(res, {
            "Z1": {"RAT": 0.002, "R": 0.002},
            "Z2": {"RAT": 0, "RAD": 2.259, "R": 2.259},
            "Z3": {"RAT": 0, "RB": 5.770, "RU": 0, "RV": 0.756, "R": 6.526},
            "Z4": {"RAT": 0, "RB": 0.179, "RU": 0, "RV": 0.023, "R": 0.202},
            "Z5": {"RAT": 0, "RB": 0.137, "RU": 0, "RV": 0.018, "R": 0.156},
        })
        assert not res.compliant and res.governing_zone == "Z3"

    def test_unprotected_frequency_table_f22(self):
        res = run_lightning_risk(_req2024(20, 40, 25, _office()))
        row = {"FC": 0.11, "FM": 0.398, "FW": 0.007, "FZ": 0.0692, "F": 0.584}
        _check_freq(res, {"Z3": row, "Z4": row, "Z5": row})
        assert not res.frequency_compliant

    def test_protected_tables_f23_f24(self):
        """LPS class II with LPL II bonding SPDs, coordinated SPDs LPL II on
        the power and telecom systems."""
        res = run_lightning_risk(_req2024(20, 40, 25, _office(protected=True)))
        _check_risk(res, {
            "Z1": {"RAT": 0, "R": 0},
            "Z2": {"RAD": 0.113, "R": 0.113},
            "Z3": {"RB": 0.577, "RV": 0.015, "R": 0.592},
            "Z4": {"RB": 0.018, "RV": 0, "R": 0.018},
            "Z5": {"RB": 0.014, "RV": 0, "R": 0.014},
        })
        row = {"FC": 0.004, "FM": 0.008, "FW": 0, "FZ": 0.001, "F": 0.014}
        _check_freq(res, {"Z3": row, "Z4": row, "Z5": row})
        assert res.compliant and res.frequency_compliant


def _hospital(protected=False):
    lps, eb = ("II", "II") if protected else ("none", "none")
    spd3, spd45 = ("I", "better") if protected else ("none", "none")
    inside = lambda name, t, rf, loss, wiring, spd, ft: dict(
        name=name, kind="inside", hours_present=t, equipment_hours=8760, floor="asphalt_wood_linoleum",
        fire_risk=rf, fire_protection="automatic", loss_class=loss, life_critical=True,
        tolerable_frequency=ft,
        systems=[dict(type="power", line="Power", uw_kv=2.5, wiring=wiring, spd_level=spd)])
    return dict(
        strike_density=8.0, k=2.0, construction="rc_frame", lps_class=lps, eb_level=eb,
        lines=[dict(name="Power", type="power", shield="unshielded", sections=[
            dict(length_m=1000, installation="buried", line_type="hv", environment="suburban"),
            dict(length_m=50, installation="buried", line_type="lv", environment="suburban")])],
        zones=[dict(name="Z1", kind="exposed", hours_present=175, floor="agricultural_concrete",
                    fire_risk="none", loss_class="low"),
               dict(name="Z2", kind="exposed", hours_present=90, floor="asphalt_wood_linoleum",
                    persons_exposed=True, fire_risk="none", loss_class="low",
                    touch_measure="warning" if protected else "none"),
               inside("Z3", 8760, "ordinary", "high", "same_conduit", spd3, 0.05),
               inside("Z4", 3100, "low", "very_high", "same_cable", spd45, 0.01),
               inside("Z5", 8760, "low", "very_high", "same_cable", spd45, 0.01)])


class TestAnnexF4Hospital:
    def test_events_table_f28(self):
        res = run_lightning_risk(_req2024(50, 150, 10, _hospital()))
        assert res.collection_area_m2 == pytest.approx(2.23e4, rel=3e-3)
        assert res.collection_area_near_m2 == pytest.approx(1.18e5, rel=5e-3)   # 3 s.f.
        assert res.flashes_to_structure_per_year == pytest.approx(0.179, rel=3e-3)
        assert res.flashes_near_structure_per_year == pytest.approx(0.470, rel=3e-3)
        ev = res.lines_events[0]
        assert ev["nl"] == pytest.approx(1.2e-2, rel=1e-6)
        assert ev["ni"] == pytest.approx(1.15e-1, rel=3e-3)

    def test_unprotected_table_f35(self):
        res = run_lightning_risk(_req2024(50, 150, 10, _hospital()))
        _check_risk(res, {
            "Z1": {"RAT": 0.036, "R": 0.036},
            "Z2": {"RAT": 0, "RAD": 18.357, "R": 18.357},
            "Z3": {"RAT": 0.002, "RB": 3.572, "RC": 17.862, "RM": 1.881, "RU": 0, "RV": 0.480,
                   "RW": 1.200, "RZ": 11.531, "R": 36.528},
            "Z4": {"RAT": 0.001, "RB": 0.484, "RC": 63.213, "RM": 0.017, "RU": 0, "RV": 0.065,
                   "RW": 4.247, "RZ": 40.807, "R": 108.834},
            "Z5": {"RAT": 0.002, "RB": 0.714, "RC": 178.619, "RM": 0.047, "RU": 0, "RV": 0.096,
                   "RW": 12.000, "RZ": 115.308, "R": 306.787},
        })
        assert res.governing_zone == "Z5"

    def test_unprotected_frequency_table_f36(self):
        res = run_lightning_risk(_req2024(50, 150, 10, _hospital()))
        _check_freq(res, {
            "Z3": {"FC": 0.179, "FM": 0.019, "FW": 0.012, "FZ": 0.115, "F": 0.325},
            "Z4": {"FC": 0.179, "FM": 0, "FW": 0.012, "FZ": 0.115, "F": 0.306},
            "Z5": {"FC": 0.179, "FM": 0, "FW": 0.012, "FZ": 0.115, "F": 0.306},
        })

    def test_protected_tables_f37_f38(self):
        """Warning notice on the roof, LPS class II with LPL II bonding, SPDs
        LPL I (Z3) and better than LPL I (Z4, Z5)."""
        res = run_lightning_risk(_req2024(50, 150, 10, _hospital(protected=True)))
        _check_risk(res, {
            "Z1": {"RAT": 0.002, "R": 0.002},
            "Z2": {"RAT": 0, "RAD": 0.092, "R": 0.092},
            "Z3": {"RB": 0.357, "RC": 0.179, "RM": 0.019, "RU": 0, "RV": 0.010, "RW": 0.012,
                   "RZ": 0.115, "R": 0.692},
            "Z4": {"RB": 0.048, "RC": 0.126, "RM": 0, "RV": 0.001, "RW": 0.008, "RZ": 0.082, "R": 0.266},
            "Z5": {"RB": 0.071, "RC": 0.357, "RM": 0, "RV": 0.002, "RW": 0.024, "RZ": 0.231, "R": 0.685},
        })
        _check_freq(res, {
            # F.38 prints F_Z = 0.0011: N_I·P_SPD = 0.1153 × 0.01 = 0.00115, rounded down.
            "Z3": {"FC": 0.0018, "FM": 0.0002, "FW": 0.0001, "FZ": 0.00115, "F": 0.0032},
            "Z4": {"FC": 0.0004, "FZ": 0.0002, "F": 0.0006},
            "Z5": {"FC": 0.0004, "FZ": 0.0002, "F": 0.0006},
        }, decimals=4)
        assert res.compliant and res.frequency_compliant


class TestEdition2024Rules:
    def test_edition_absent_is_2010(self):
        """A saved assessment has no `edition`: it must run the 2010 method."""
        assert run_lightning_risk(_req2010()).edition == "2010"

    def test_spd_not_credited_on_pc_without_lps(self):
        """B.5 Note 1: coordinated SPDs reduce P_C only with an LPS or a
        natural LPS. A masonry house without an LPS keeps P_C = 1."""
        h = _house()
        h["zones"][0]["life_critical"] = True
        for s in h["zones"][0]["systems"]:
            s["spd_level"] = "I"
        res = run_lightning_risk(_req2024(15, 20, 6, h))
        assert _v(res.zones[0], "FC", freq=True) == pytest.approx(res.flashes_to_structure_per_year, rel=1e-9)
        h["lps_class"], h["eb_level"] = "III", "III-IV"
        res = run_lightning_risk(_req2024(15, 20, 6, h))
        assert _v(res.zones[0], "FC", freq=True) == pytest.approx(
            res.flashes_to_structure_per_year * (1 - 0.99 ** 2), rel=1e-9)

    def test_explosion_forces_rp_1(self):
        """B.4: in zones with a risk of explosion r_p = 1 for all cases."""
        h = _house()
        h["zones"][0].update(fire_risk="explosion_z1", fire_protection="automatic")
        h["construction"] = "rc_frame"
        res = run_lightning_risk(_req2024(15, 20, 6, h))
        nd = res.flashes_to_structure_per_year
        pp = 4380 / 8760
        # very-high loss (Table C.2 note a): L_F1 = L_F2 = 0.2; P_S 0.5, r_f 0.1, r_p 1
        assert _v(res.zones[0], "RB") == pytest.approx(nd * 0.5 * 0.1 * (pp * 0.2 + 0.2), rel=1e-9)
