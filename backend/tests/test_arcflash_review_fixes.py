"""Regression tests for the arc flash review (2026-10-02, AF1-AF7 + lesser notes).

Each test reproduces the original defect against an independent reference:
the IEEE 1584-2018 official validation spreadsheet (144,000 rows, of which a
spread of typical-enclosure rows is pinned here — the older fixtures in
test_regression.py are all small shallow boxes), IEEE 1584-2002 Eq. 7 in
closed form, and hand timing of each infeed device at its own share of the
arcing current.

Run with:  python -m pytest backend/tests/test_arcflash_review_fixes.py -q
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.arcflash import (
    _BREAKER_OPENING_TIME_S,
    _device_clearing_time,
    _enclosure_correction_factor_2018,
    _get_ppe,
    _relay_operate_time,
    _reduced_current_ratio_2018,
    calc_arc_flash_boundary,
    calc_arc_flash_boundary_2018,
    calc_arcing_current,
    calc_arcing_current_2018,
    calc_incident_energy,
    calc_incident_energy_2018,
    run_arc_flash,
)


def _comp(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _wire(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="bottom", toComponent=b, toPort="top")


def _project(components, wires):
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=components, wires=wires)


def _two_infeed_board(second_source):
    """11 kV board fed by the grid (CB-U) and a second source (CB-2).

    CB-U's relay has an instantaneous element at 14 kA: above the grid's own
    share of the arcing current (~11.9 kA) but below the total (~15.4 kA).
    """
    cs = [
        _comp("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250,
                               "x_r_ratio": 15, "z0_z1_ratio": 1}),
        _comp("cb1", "cb", {"name": "CB-U", "cb_type": "vcb", "state": "closed"}),
        second_source,
        _comp("cb2", "cb", {"name": "CB-2", "cb_type": "vcb", "state": "closed"}),
        _comp("b", "bus", {"name": "SWBD", "voltage_kv": 11,
                           "arc_flash_method": "IEEE 1584-2018", "electrode_config": "VCB",
                           "working_distance_mm": 914.4,
                           "equipment_class": "mv_switchgear_15kv"}),
        _comp("r1", "relay", {"relay_type": "50/51", "trip_cb": "cb1",
                              "curve": "IEC Standard Inverse", "pickup_a": 600,
                              "time_dial": 0.3, "inst_pickup_a": 14000, "inst_delay_s": 0.0}),
        _comp("r2", "relay", {"relay_type": "50/51", "trip_cb": "cb2",
                              "curve": "IEC Standard Inverse", "pickup_a": 600,
                              "time_dial": 0.1, "inst_pickup_a": 0}),
    ]
    ws = [_wire("w1", "u", "cb1"), _wire("w2", "cb1", "b"),
          _wire("w3", second_source.id, "cb2"), _wire("w4", "cb2", "b")]
    return _project(cs, ws), {c.id: c for c in cs}


class TestAF1DeviceShare:
    """[AF1] Each infeed device is timed at its own share of Iarc."""

    def test_two_infeed_board_matches_hand_timing(self):
        gen = _comp("g", "generator", {"name": "G1", "rated_mva": 10, "voltage_kv": 11,
                                       "xd_pp": 0.15, "x_r_ratio": 30})
        p, cmap = _two_infeed_board(gen)
        fr = run_fault_analysis(p)
        fb = fr.buses["b"]
        share = {br.element_id: br.ik_ka / fb.ik3 for br in fb.branches}
        # The grid share is the utility's own I″k: S″k/(√3·U) = 250/(√3·11)
        assert fb.ik3 * share["cb1"] == pytest.approx(250 / (math.sqrt(3) * 11), rel=1e-3)

        ia, iar, ratio = calc_arcing_current_2018(fb.ik3, 11, 153, "VCB")

        def t_bus(i_ka):
            t1 = _relay_operate_time(cmap["r1"].props, i_ka * share["cb1"] * 1000)
            t2 = _relay_operate_time(cmap["r2"].props, i_ka * share["cb2"] * 1000)
            return min(max(t1, t2) + _BREAKER_OPENING_TIME_S, 2.0)

        cf = _enclosure_correction_factor_2018("VCB", 11, 1143, 762, 762)
        e_ref = max(
            calc_incident_energy_2018(ia, 1.0, fb.ik3, 11, t_bus(ia), 153, 914.4, "VCB", cf),
            calc_incident_energy_2018(iar, ratio, fb.ik3, 11, t_bus(iar), 153, 914.4, "VCB", cf))

        r = run_arc_flash(p, fr).buses["b"]
        # Pre-fix: both breakers timed at the total Iarc → grid relay on its
        # instantaneous (0.08 s), generator relay 0.31 s, E = 5.78 cal/cm²
        # (PPE category 2). Each at its own share: grid IDMT 0.76 s,
        # E = 14.39 cal/cm² (category 3).
        assert r.incident_energy_cal == pytest.approx(e_ref, rel=1e-3)
        assert r.clearing_time_s > 0.7
        assert r.ppe_category == 3

    def test_single_infeed_unchanged(self):
        """One infeed carrying the whole bus current: share = 1, the device
        sees the full arcing current exactly as before. [AF-L2] The time
        reported is the governing one — here the reduced-current pass, which
        clears slower (pre-fix the full-current time was always reported)."""
        cs = [
            _comp("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250,
                                   "x_r_ratio": 15}),
            _comp("cb1", "cb", {"cb_type": "vcb", "state": "closed"}),
            _comp("b", "bus", {"voltage_kv": 11, "arc_flash_method": "IEEE 1584-2018"}),
            _comp("r1", "relay", {"trip_cb": "cb1", "curve": "IEC Standard Inverse",
                                  "pickup_a": 600, "time_dial": 0.3}),
        ]
        p = _project(cs, [_wire("w1", "u", "cb1"), _wire("w2", "cb1", "b")])
        fr = run_fault_analysis(p)
        r = run_arc_flash(p, fr).buses["b"]
        ia, iar, _ = calc_arcing_current_2018(fr.buses["b"].ik3, 11, 153, "VCB")
        t_full = _relay_operate_time(cs[3].props, ia * 1000) + _BREAKER_OPENING_TIME_S
        t_red = _relay_operate_time(cs[3].props, iar * 1000) + _BREAKER_OPENING_TIME_S
        assert r.clearing_time_s == pytest.approx(max(t_full, t_red), abs=1e-3)


class TestAF2Boundary2002:
    """[AF2] IEEE 1584-2002 Eq. 7 in closed form — no 50 m ceiling, no 300 mm floor."""

    @staticmethod
    def _eq7(ia, v, t, g, x, eb_cal=1.2):
        cf = 1.5 if v <= 1 else 1.0
        en = 10 ** (-0.555 + 1.081 * math.log10(ia) + 0.0011 * g)
        return 610 * (cf * en * (t / 0.2) / eb_cal) ** (1 / x)

    def test_slow_mv_boundary_beyond_50_m(self):
        ia, _ = calc_arcing_current(25, 13.8, 153, "VCB")
        afb = calc_arc_flash_boundary(ia, 13.8, 2.0, 153, "VCB",
                                      equipment_class="mv_switchgear_15kv")
        # Pre-fix: bisection capped at 50,000 mm (32 % short)
        assert afb == pytest.approx(self._eq7(ia, 13.8, 2.0, 153, 0.973), abs=1)
        assert afb > 70000

    def test_small_lv_boundary_below_300_mm(self):
        ia, _ = calc_arcing_current(5, 0.4, 25, "VCB")
        afb = calc_arc_flash_boundary(ia, 0.4, 0.02, 25, "VCB",
                                      equipment_class="lv_mcc_panel")
        # Pre-fix: reported at the 300 mm floor
        assert afb == pytest.approx(self._eq7(ia, 0.4, 0.02, 25, 1.641), abs=1)
        assert afb < 200

    def test_boundary_is_where_energy_equals_threshold(self):
        ia, _ = calc_arcing_current(40, 0.4, 32, "VCB")
        afb = calc_arc_flash_boundary(ia, 0.4, 0.5, 32, "VCB",
                                      equipment_class="lv_switchgear")
        e = calc_incident_energy(ia, 0.4, 0.5, 32, afb, "VCB",
                                 equipment_class="lv_switchgear")
        assert e == pytest.approx(1.2, rel=1e-3)


class TestAF3FuseFloor:
    """[AF3] A fuse beyond the bottom of its curve is credited with 0.01 s."""

    def test_current_limiting_fuse_floored_at_10_ms(self):
        fuse = _comp("f", "fuse", {"rated_current_a": 100})
        # 14 kA through a 100 A gG fuse: pre-arc 4 ms, ×1.2 = 4.8 ms pre-fix
        assert _device_clearing_time(fuse, 14000, {}, {}) == pytest.approx(0.01)

    def test_slow_region_unchanged(self):
        fuse = _comp("f", "fuse", {"rated_current_a": 100})
        # 410 A sits on the 7.07 s point → capped at 2 s, as before
        assert _device_clearing_time(fuse, 410, {}, {}) == pytest.approx(2.0)
        # 1090 A sits on the 0.1 s point → 0.12 s total clearing
        assert _device_clearing_time(fuse, 1090, {}, {}) == pytest.approx(0.12, rel=1e-3)


class TestAF4BatteryInfeed:
    """[AF4] A battery infeed's breaker is an infeed device, not a feeder."""

    def test_battery_breaker_governs_when_slowest(self):
        bess = _comp("bess", "battery", {"name": "BESS", "rated_kva": 5000, "voltage_kv": 11,
                                         "fault_contribution_pu": 1.5})
        p, cmap = _two_infeed_board(bess)
        # Slow the BESS relay right down: if its breaker is seen, it governs
        cmap["r2"].props.update({"pickup_a": 100, "time_dial": 1.0})
        fr = run_fault_analysis(p)
        fb = fr.buses["b"]
        share = {br.element_id: br.ik_ka / fb.ik3 for br in fb.branches}
        assert share.get("cb2", 0) > 0  # the fault study sees the BESS infeed
        r = run_arc_flash(p, fr).buses["b"]
        ia, iar, _ = calc_arcing_current_2018(fb.ik3, 11, 153, "VCB")
        t_bess = min(_relay_operate_time(cmap["r2"].props, iar * share["cb2"] * 1000)
                     + _BREAKER_OPENING_TIME_S, 2.0)
        # Pre-fix: CB-2 skipped (battery not a source) → only CB-U timed
        assert r.clearing_time_s == pytest.approx(t_bess, abs=2e-3)


class TestAF6Label:
    """[AF6] NFPA 70E §130.5(H): energy with its working distance, no category."""

    def test_label_states_working_distance_and_no_category(self):
        cs = [
            _comp("u", "utility", {"voltage_kv": 0.4, "fault_mva": 20, "x_r_ratio": 5}),
            _comp("cb1", "cb", {"cb_type": "acb", "trip_rating_a": 1600,
                                "instantaneous_pickup": 0, "short_time_pickup": 0,
                                "magnetic_pickup": 50, "state": "closed"}),
            _comp("b", "bus", {"voltage_kv": 0.4, "arc_flash_method": "IEEE 1584-2018",
                               "working_distance_mm": 455}),
        ]
        p = _project(cs, [_wire("w1", "u", "cb1"), _wire("w2", "cb1", "b")])
        r = run_arc_flash(p, run_fault_analysis(p)).buses["b"]
        assert "at 455 mm" in r.label_html
        assert "Minimum Arc Rating" in r.label_html
        assert "Category" not in r.label_html
        assert "Nominal Voltage" in r.label_html


class TestAF7Validity:
    """[AF7] Gap and working-distance ranges per edition."""

    def _bus_warning(self, kv, method, **props):
        cs = [
            _comp("u", "utility", {"voltage_kv": kv, "fault_mva": 250 if kv > 1 else 20,
                                   "x_r_ratio": 10}),
            _comp("cb1", "cb", {"cb_type": "vcb" if kv > 1 else "acb", "state": "closed"}),
            _comp("b", "bus", dict({"voltage_kv": kv, "arc_flash_method": method}, **props)),
        ]
        p = _project(cs, [_wire("w1", "u", "cb1"), _wire("w2", "cb1", "b")])
        return run_arc_flash(p, run_fault_analysis(p)).buses["b"].warning

    def test_2002_mv_switchgear_gap_not_flagged(self):
        # Pre-fix: 153 mm checked against 6.35-76.2 mm → "extrapolated" on
        # every 2002 MV switchgear bus
        assert "Gap" not in self._bus_warning(11, "IEEE 1584-2002")

    def test_2018_lv_gap_out_of_range_flagged(self):
        # Pre-fix: no gap check on 2018 buses at all
        assert "Gap 100 mm outside" in self._bus_warning(
            0.4, "IEEE 1584-2018", conductor_gap_mm=100)

    def test_working_distance_below_305_flagged(self):
        assert "Working distance 300 mm" in self._bus_warning(
            0.4, "IEEE 1584-2018", working_distance_mm=300)


class TestTypicalEnclosureSpreadsheetRows:
    """Rows of the IEEE 1584-2018 validation spreadsheet with typical (not
    shallow) enclosures: widths/heights 600-1500 mm, so the 508-660.4,
    660.4-1244.6 and > 1244.6 mm branches of Table 6 (Eq. 11/12, VCB's
    height exception) and the Table 7 'typical' CF are all exercised."""

    # (config, voc_kv, ibf_ka, gap_mm, dist_mm, t_ms, width, height, depth,
    #  iarc_max, e_joules_max, afb_max, iarc_min, e_joules_min, afb_min)
    CASES = [
        ("VCB", 0.4, 20.0, 25.0, 609.6, 100, 600.0, 1000.0, 500, 14.098174244547922, 7.217565316567828, 765.0316046504087, 12.299693919378543, 6.333892694107021, 704.9933097039833),
        ("VCB", 1.0, 20.0, 104.0, 609.6, 100, 1000.0, 1500.0, 500, 15.473002118736458, 12.26712057192492, 1068.9909447593318, 13.954176020873158, 9.092880849399515, 883.4884652593364),
        ("VCB", 10.0, 20.0, 104.0, 609.6, 100, 1500.0, 600.0, 500, 18.11458363747344, 16.811244831312923, 1316.902601492317, 17.88960050869602, 16.86978839306487, 1319.504482872721),
        ("VCBB", 10.0, 20.0, 104.0, 609.6, 100, 600.0, 1000.0, 500, 18.6302855242494, 29.074125487937124, 1713.997703984528, 18.261033265158794, 29.282045936380737, 1721.2290444622179),
        ("VCBB", 1.0, 20.0, 104.0, 609.6, 100, 1000.0, 1500.0, 500, 16.699589899053052, 17.38801878855202, 1217.9445202268637, 15.344955479700104, 16.905300742221385, 1195.2054233722818),
        ("VCBB", 0.4, 20.0, 25.0, 609.6, 100, 1500.0, 600.0, 500, 15.336635711487244, 9.624434588689992, 873.5044806800737, 13.412187179647104, 8.205044386065971, 799.7602880670179),
        ("HCB", 0.4, 20.0, 25.0, 609.6, 100, 600.0, 1000.0, 500, 13.489297351703076, 14.230901786113014, 1018.430533238052, 11.55587399918304, 12.123476527905693, 941.1159048265205),
        ("HCB", 1.0, 20.0, 104.0, 609.6, 100, 1000.0, 1500.0, 500, 15.046003720479405, 28.789988501378847, 1537.142927227536, 13.431883088630997, 27.064980357249276, 1487.6051197466559),
        ("HCB", 10.0, 20.0, 104.0, 609.6, 100, 1500.0, 600.0, 500, 17.981227258473886, 40.250302377757784, 2108.2644505668854, 17.72256730436074, 39.508232157791504, 2084.8944595660028),
    ]

    @pytest.mark.parametrize("case", CASES)
    def test_row(self, case):
        (ec, v, ibf, g, d, t_ms, w, h, dp, ia_x, ej_x, afb_x, ia_n, ej_n, afb_n) = case
        t = t_ms / 1000
        cf = _enclosure_correction_factor_2018(ec, v, w, h, dp)
        ia, iar, ratio = calc_arcing_current_2018(ibf, v, g, ec)
        assert ia == pytest.approx(ia_x, rel=1e-6)
        assert iar == pytest.approx(ia_n, rel=1e-6)
        J = 1 / 4.184
        assert calc_incident_energy_2018(ia, 1.0, ibf, v, t, g, d, ec, cf) == pytest.approx(ej_x * J, rel=1e-5)
        assert calc_incident_energy_2018(iar, ratio, ibf, v, t, g, d, ec, cf) == pytest.approx(ej_n * J, rel=1e-5)
        assert calc_arc_flash_boundary_2018(ia, 1.0, ibf, v, t, g, ec, cf) == pytest.approx(afb_x, abs=0.6)
        assert calc_arc_flash_boundary_2018(iar, ratio, ibf, v, t, g, ec, cf) == pytest.approx(afb_n, abs=0.6)


class TestLesserNotes:
    def test_varcf_is_table_2(self):
        """[AF-L1] Iarc_min/Iarc = 1 − 0.5·VarCf with the Table 2 polynomial.
        VCB at 0.48 kV, by hand from Table 2."""
        v = 0.48
        k = (0.0, -0.0000014269, 0.000083137, -0.0019382, 0.022366, -0.12645, 0.30226)
        var_cf = sum(c * v ** (6 - i) for i, c in enumerate(k))
        assert _reduced_current_ratio_2018(v, "VCB") == pytest.approx(1 - 0.5 * var_cf, rel=1e-12)

    def test_danger_text_not_a_prohibition(self):
        cat, name, desc = _get_ppe(55.0)
        assert cat == -1 and name == "DANGER"
        assert "no PPE category" in desc
