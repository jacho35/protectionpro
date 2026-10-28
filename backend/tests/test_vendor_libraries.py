"""Manufacturer breaker libraries (testing/vendor-libraries) and the settings model they need.

* the Schneider import file (ComPacT NSX / NSXm, Acti9 iC60 / C120, Masterpact MTZ) is
  self-consistent with its trip-unit profiles and reproduces the published numbers
  (catalogue LVPED221001EN, DOCA0187EN-04, DOCA0188EN-03, Acti9 catalogue 2017, DOCA0102EN-12);
* a pickup can be a multiple of In instead of Ir (``pickup_base``): Schneider fixes Ii against
  the trip-unit rating, so turning the Ir dial must not move it — in the arc-flash clearing
  time, the duty check and every other consumer;
* a published long-time curve (``thermal_curve``) is evaluated by the clearing-time model.

The JS side (cbTripTime, TripUnit) is covered by frontend/tests/test_pickup_base.mjs, which pins
the same numbers.
"""
import json
import math
import os

import pytest

from backend.analysis.arcflash import _cb_self_clearing_time
from backend.analysis.cb_settings import pickup_amps, pickup_base, pickup_ref_a, thermal_curve_time
from backend.analysis.duty_check import run_duty_check
from backend.models.schemas import ProjectData
from backend.tests.test_duty_check_review_fixes import C, W, _genset

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LIB = os.path.join(ROOT, "testing", "vendor-libraries", "schneider_breakers.json")
PROFILES_JS = os.path.join(ROOT, "frontend", "js", "vendor-trip-units.js")


def _profiles():
    src = open(PROFILES_JS).read()
    head = "Object.assign(TRIP_UNITS, "
    return json.loads(src[src.index(head) + len(head):src.rindex(");")])


def _entries():
    return {e["data"]["id"]: e["data"] for e in json.load(open(LIB))["entries"]}


# ── the reference current of a pickup ────────────────────────────────────

class TestPickupBase:
    def test_absent_is_ir(self):
        assert pickup_base({}, "instantaneous") == "Ir"
        assert pickup_base({"pickup_base": None}, "magnetic") == "Ir"
        assert pickup_base({"pickup_base": {"instantaneous": "Ir"}}, "instantaneous") == "Ir"

    def test_in_only_where_named(self):
        pb = {"pickup_base": {"instantaneous": "In"}}
        assert pickup_base(pb, "instantaneous") == "In"
        assert pickup_base(pb, "short_time") == "Ir"
        assert pickup_base(pb, "magnetic") == "Ir"

    def test_amps(self):
        # In 100 A, Ir dial 0.5 -> Ir 50 A
        assert pickup_ref_a({}, "instantaneous", 100, 50) == 50
        assert pickup_ref_a({"pickup_base": {"instantaneous": "In"}}, "instantaneous", 100, 50) == 100
        assert pickup_amps({"pickup_base": {"instantaneous": "In"}}, "instantaneous", 15, 100, 50) == 1500
        assert pickup_amps({}, "instantaneous", 15, 100, 50) == 750


# ── arc-flash clearing time ──────────────────────────────────────────────

# 100 A electronic MCCB, Ir dial 0.5 (50 A), Ii = 15 x In
_ETU = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 0.5, "magnetic_pickup": 15,
        "long_time_delay": 16, "short_time_pickup": 0, "short_time_delay": 0,
        "instantaneous_pickup": 15, "trip_unit": "x", "trip_unit_kind": "electronic"}


class TestArcFlashClearing:
    def test_legacy_ii_is_a_multiple_of_ir(self):
        # no pickup_base: 15 x Ir = 750 A (the behaviour of every saved project)
        assert _cb_self_clearing_time(_ETU, 800.0) == pytest.approx(0.025)
        assert _cb_self_clearing_time(_ETU, 700.0) > 0.025

    def test_ii_against_in_does_not_move_with_the_ir_dial(self):
        p = {**_ETU, "pickup_base": {"instantaneous": "In", "magnetic": "In"}}
        assert _cb_self_clearing_time(p, 1499.0) > 0.025            # 15 x In = 1500 A
        assert _cb_self_clearing_time(p, 1500.0) == pytest.approx(0.025)
        for th in (0.4, 0.7, 1.0):                                  # every Ir position, same Ii
            q = {**p, "thermal_pickup": th}
            assert _cb_self_clearing_time(q, 1499.0) > 0.025
            assert _cb_self_clearing_time(q, 1500.0) == pytest.approx(0.025)

    def test_thermal_magnetic_ii_fixed_in_amps(self):
        # TM-D 100 A: Ir 0.7 x In = 70 A, Ii fixed 800 A (8 x In)
        tmd = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 0.7, "magnetic_pickup": 8,
               "long_time_delay": 15, "trip_unit": "x", "trip_unit_kind": "tm",
               "pickup_base": {"magnetic": "In"}}
        assert _cb_self_clearing_time(tmd, 799.0) > 0.025
        assert _cb_self_clearing_time(tmd, 800.0) == pytest.approx(0.025)
        legacy = {k: v for k, v in tmd.items() if k != "pickup_base"}   # 8 x Ir = 560 A
        assert _cb_self_clearing_time(legacy, 600.0) == pytest.approx(0.025)

    def test_short_time_stays_against_ir(self):
        # Isd is a multiple of Ir on Schneider units: 2 x Ir = 100 A at Ir 50 A
        p = {**_ETU, "short_time_pickup": 2, "short_time_delay": 0.1, "instantaneous_pickup": 0,
             "pickup_base": {"instantaneous": "In", "magnetic": "In"}}
        assert _cb_self_clearing_time(p, 120.0) == pytest.approx(0.1 + 0.08)
        q = {**p, "thermal_pickup": 1.0}                            # Ir 100 A -> Isd 200 A
        assert _cb_self_clearing_time(q, 120.0) > 0.18


# ── duty check: Icw is only judged when the instantaneous element does not clear first ──

class TestDutyCheckPickupBase:
    def _acb(self, **extra):
        p = _genset(100)
        for c in p.components:
            if c.id == "d":
                c.props.update(short_time_pickup=4, short_time_delay=0.4, instantaneous_pickup=10,
                               trip_rating_a=1600, thermal_pickup=0.5, icw_ka=30, icw_time_s=1.0,
                               **extra)
        return p

    def _dev(self, project):
        return next(d for d in run_duty_check(project)["devices"] if d["device_id"] == "d")

    def test_ii_against_ir_clears_first(self):
        # 10 x Ir = 10 x 800 A = 8 kA: the ~12 kA fault is cleared instantaneously, no Icw question
        assert self._dev(self._acb())["icw_ok"] is None

    def test_ii_against_in_leaves_the_short_time_window(self):
        # 10 x In = 16 kA: the fault is above Isd but below Ii, so Icw is judged
        d = self._dev(self._acb(pickup_base={"instantaneous": "In"}))
        assert d["icw_ok"] is not None


# ── a published long-time curve ──────────────────────────────────────────

class TestThermalCurve:
    def test_published_points_reproduced(self):
        tc = {"param": "long_time_delay", "tables": _profiles()["se_nsx_ml567_100"]["curve"]["thermal"]["tables"]}
        props = {"long_time_delay": 16}
        assert thermal_curve_time(tc, 1.5, props) == pytest.approx(400)
        assert thermal_curve_time(tc, 6, props) == pytest.approx(16)
        assert thermal_curve_time(tc, 7.2, props) == pytest.approx(11)
        props = {"long_time_delay": 2}
        assert thermal_curve_time(tc, 6, props) == pytest.approx(2)
        assert thermal_curve_time(tc, 1.5, props) == pytest.approx(50)
        assert thermal_curve_time(tc, 1.0, props) == 10000.0          # at/below 1.05 Ir: never
        assert thermal_curve_time(tc, 12, {"long_time_delay": 16}) == pytest.approx(11 * 7.2 ** 2 / 144)
        assert thermal_curve_time(None, 6) is None
        assert thermal_curve_time({"points": [[1.5, 400]]}, 6) is None

    def test_clearing_time_uses_the_curve(self):
        props = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 1.0, "magnetic_pickup": 100,
                 "long_time_delay": 16,
                 "thermal_curve": {"points": [[1.5, 400], [6, 16], [7.2, 11]]}}
        assert _cb_self_clearing_time(props, 150.0) == pytest.approx(400)
        assert _cb_self_clearing_time(props, 600.0) == pytest.approx(16)
        # between the published points: the smooth monotone curve (value pinned with the JS test)
        assert _cb_self_clearing_time(props, 400.0) == pytest.approx(39.588037174953485, rel=1e-9)

    def test_curve_is_smooth_monotone_and_exact(self):
        tc = {"points": [[1.5, 400], [6, 16], [7.2, 11]]}
        ts = [thermal_curve_time(tc, 1.5 + i * 0.01) for i in range(700)]
        assert all(a > b for a, b in zip(ts, ts[1:]))                 # strictly falling, no overshoot

        def slope(m):                                                  # d ln t / d ln M
            h = 1e-5
            return (math.log(thermal_curve_time(tc, m * (1 + h))) - math.log(thermal_curve_time(tc, m * (1 - h)))) / (2 * h)

        for m in (6.0, 7.2):                                           # no kink where published points meet
            assert slope(m * (1 - 1e-4)) == pytest.approx(slope(m * (1 + 1e-4)), abs=1e-3)
        assert slope(7.2 * 1.0001) == pytest.approx(-2.0, abs=1e-3)    # and I²t takes over smoothly
        assert slope(30.0) == pytest.approx(-2.0, abs=1e-6)
        # a single-segment curve (TM-D, two points) stays between its points
        tmd = {"points": [[1.5, 400], [6, 15]]}
        assert 15 < thermal_curve_time(tmd, 3.0) < 400
        assert thermal_curve_time(tmd, 3.0) == pytest.approx(72.66822153293934, rel=1e-9)


# ── the Schneider import file ────────────────────────────────────────────

class TestSchneiderLibrary:
    def test_entries_reference_known_profiles(self):
        prof, ents = _profiles(), _entries()
        assert len(ents) > 400
        for d in ents.values():
            assert d["manufacturer"] == "Schneider Electric" and d["cb_type"] in ("mccb", "mcb", "acb")
            assert d["default_trip_unit"] in d["trip_units"]
            assert d["trip_rating_a"] <= d["frame_a"] and d["breaking_ka"] > 0
            for u in d["trip_units"]:
                assert u in prof
                # NSX / NSXm: the unit is the one for this rating — its Ir dial positions are whole amps
                if d["series"].startswith("ComPacT"):
                    for s in prof[u]["dials"]["thermal_pickup"].get("steps", []):
                        assert abs(s * d["trip_rating_a"] - round(s * d["trip_rating_a"])) < 0.01, (d["id"], u, s)

    def test_ids_unique_and_breaking_capacity(self):
        ents = _entries()
        assert len(ents) == len(json.load(open(LIB))["entries"])
        # catalogue A-7: NSX100N 50 kA, NSX250S 100 kA; NSX630L 150 kA; no NSX400B
        assert ents["se_nsx100n_100"]["breaking_ka"] == 50
        assert ents["se_nsx250s_250"]["breaking_ka"] == 100
        assert ents["se_nsx630l_630"]["breaking_ka"] == 150
        assert not any(i.startswith("se_nsx400b_") for i in ents)

    def test_ii_dials_are_held_against_in(self):
        for pid, p in _profiles().items():
            ii = p["dials"].get("instantaneous_pickup") or p["dials"].get("magnetic_pickup")
            assert ii["base"] == "In", pid               # Schneider Ii (and an MCB's magnetic) is a multiple of In
            isd = p["dials"].get("short_time_pickup")
            assert not isd or "base" not in isd, pid     # Isd is a multiple of Ir

    def test_tmd_published_values(self):
        prof = _profiles()
        d = prof["se_nsx_tmd_100"]["dials"]
        assert [round(s * 100) for s in d["thermal_pickup"]["steps"]] == [70, 80, 90, 100]
        assert d["magnetic_pickup"]["fixed"] and round(d["magnetic_pickup"]["def"] * 100) == 800
        d = prof["se_nsx_tmd_63"]["dials"]
        assert [round(s * 63) for s in d["thermal_pickup"]["steps"]] == [44, 50, 57, 63]
        assert round(d["magnetic_pickup"]["def"] * 63) == 500
        d = prof["se_nsx_tmd_250"]["dials"]
        assert [round(s * 250) for s in d["magnetic_pickup"]["steps"]] == [1250, 1500, 1750, 2000, 2250, 2500]
        assert prof["se_nsx_tmd_250"]["curve"]["thermal"]["points"] == [[1.5, 400], [6, 15]]

    def test_micrologic_published_values(self):
        prof = _profiles()
        # MicroLogic 2: Ii fixed 600 / 1500 / 2400 / 3000 / 4800 / 6930 A
        for inn, a in ((40, 600), (100, 1500), (160, 2400), (250, 3000), (400, 4800), (630, 6930)):
            ii = prof[f"se_nsx_ml2_{inn}"]["dials"]["instantaneous_pickup"]
            assert ii["fixed"] and ii["base"] == "In" and round(ii["def"] * inn) == a
        # MicroLogic 5/6/7: Ii 1.5-15 x In (<= 160 A), 12 (250-400), 11 (630)
        for inn, mx in ((40, 15), (100, 15), (160, 15), (250, 12), (400, 12), (630, 11)):
            st = prof[f"se_nsx_ml567_{inn}"]["dials"]["instantaneous_pickup"]["steps"]
            assert st[0] == 1.5 and st[-1] == mx and all(abs(b - a - 0.5) < 1e-9 for a, b in zip(st, st[1:]))
        io = prof["se_nsx_ml567_630"]["dials"]["thermal_pickup"]["steps"]
        assert [round(s * 630) for s in io] == [250, 280, 320, 350, 400, 450, 500, 570, 630]
        # Isd 1.5-10 x Ir; tr table at 1.5 / 6 / 7.2 x Ir
        d = prof["se_nsx_ml567_100"]["dials"]
        assert d["short_time_pickup"]["steps"][0] == 1.5 and d["short_time_pickup"]["steps"][-1] == 10
        assert prof["se_nsx_ml567_100"]["curve"]["thermal"]["tables"]["8"] == [[1.5, 200], [6, 8], [7.2, 5.5]]

    def test_frame_availability(self):
        ents = _entries()
        # TM-D: NSX100 16-100 A, NSX160 32-160 A, NSX250 63-250 A; no TM-D on NSX400/630
        assert "se_nsx100n_16" in ents and "se_nsx100n_125" not in ents
        assert "se_nsx160n_32" in ents and "se_nsx160n_16" not in ents
        assert "se_nsx250n_63" in ents and "se_nsx250n_40" in ents          # 40 A is MicroLogic only
        assert all(not u.startswith("se_nsx_tmd") for u in ents["se_nsx400n_400"]["trip_units"])
        # MicroLogic 5/6/7: NSX400 400 A only; NSX630 400 and 630 A
        assert ents["se_nsx400n_400"]["trip_units"][-1] == "se_nsx_ml567_400"
        assert "se_nsx400n_250" in ents
        assert not any(u.startswith("se_nsx_ml567") for u in ents["se_nsx400n_250"]["trip_units"])
        assert "se_nsx630n_400" in ents and "se_nsx630n_250" in ents


# ── a breaker of a breaker-pair changeover carries the same facts ────────

class TestChangeoverLegs:
    def test_leg_props_carry_pickup_base_and_curve(self):
        from backend.analysis.changeover import expand_changeovers
        from backend.models.schemas import Component, ProjectData, Wire
        curve = {"points": [[1.5, 400], [6, 16]]}
        co = Component(id="co", type="changeover", x=0, y=0, props={
            "name": "CO", "co_type": "breaker_pair", "state": "in_1", "rated_current_a": 630,
            "cb1_cb_type": "mccb", "cb1_trip_rating_a": 100, "cb1_thermal_pickup": 0.5,
            "cb1_instantaneous_pickup": 15, "cb1_magnetic_pickup": 15,   # mirrored, as TripUnit writes it
            "cb1_trip_unit_kind": "electronic", "cb1_thermal_curve": curve,
            "cb1_pickup_base": {"instantaneous": "In", "magnetic": "In"}})
        b = Component(id="b", type="bus", x=0, y=0, props={"voltage_kv": 0.4})
        pd = ProjectData(projectName="x", baseMVA=100, frequency=50, components=[co, b],
                         wires=[Wire(id="w", fromComponent="co", fromPort="out", toComponent="b", toPort="at_0")])
        out = expand_changeovers(pd)
        leg = next(c for c in out.components if c.id == "co")
        assert leg.type == "cb"
        assert leg.props["pickup_base"] == {"instantaneous": "In", "magnetic": "In"}
        assert leg.props["thermal_curve"] == curve
        # and the engine reads them: Ii = 15 x In = 1500 A at Ir 50 A
        assert _cb_self_clearing_time(leg.props, 1499.0) > 0.025
        assert _cb_self_clearing_time(leg.props, 1500.0) == pytest.approx(0.025)


# ── published tolerances: the engines clear on the datasheet MAXIMUM ─────

def _ml_props(**kw):
    """NSX100 MicroLogic 5, Ir 100 A, Isd 10 x Ir (1000 A), tsd 0.2 s, Ii 15 x In (1500 A), tr 16."""
    c = _profiles()["se_nsx_ml567_100"]["curve"]
    p = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 1.0, "magnetic_pickup": 15,
         "long_time_delay": 16, "short_time_pickup": 10, "short_time_delay": 0.2,
         "instantaneous_pickup": 15, "trip_unit_kind": "electronic",
         "pickup_base": {"instantaneous": "In", "magnetic": "In"},
         "thermal_curve": c["thermal"], "trip_tol": c["tol"]}
    p.update(kw)
    return p


class TestTolerances:
    def test_long_time_is_the_published_maximum_and_pickup_is_a_zone(self):
        p = _ml_props()
        assert _cb_self_clearing_time(p, 104.0) == 10000.0           # below 1.05 x Ir: never
        assert _cb_self_clearing_time(p, 119.0) == 10000.0           # inside 1.05-1.20: not guaranteed
        assert _cb_self_clearing_time(p, 150.0) == pytest.approx(400)    # published, 1.5 x Ir
        assert _cb_self_clearing_time(p, 600.0) == pytest.approx(16)     # 6 x Ir

    def test_short_time_uses_the_published_break_time_and_the_tolerance(self):
        p = _ml_props()
        assert _cb_self_clearing_time(p, 1099.0) > 1.0               # Isd + 10 % = 1100 A not yet certain
        assert _cb_self_clearing_time(p, 1100.0) == pytest.approx(0.20)  # tsd 0.2: break 200 ms, no 0.08 added
        for tsd, brk in ((0, 0.08), (0.1, 0.14), (0.2, 0.20), (0.3, 0.32), (0.4, 0.50)):
            assert _cb_self_clearing_time(_ml_props(short_time_delay=tsd), 1200.0) == pytest.approx(brk)

    def test_instantaneous_is_certain_above_ii_plus_15_percent(self):
        p = _ml_props()
        assert _cb_self_clearing_time(p, 1724.0) == pytest.approx(0.20)      # still short-time
        assert _cb_self_clearing_time(p, 1725.0) == pytest.approx(0.05)      # published 50 ms, not 25 ms
        assert _cb_self_clearing_time(_ml_props(thermal_pickup=0.4), 1725.0) == pytest.approx(0.05)

    def test_above_isd_the_published_curve_is_the_break_time(self):
        # the long-time curve is not carried on beyond Isd (as on the datasheet): tr 0.5 s would
        # give 0.35 s at 7.2 x Ir, but with Isd = 1.5 x Ir the curve there is the tsd 0.4 break time
        p = _ml_props(long_time_delay=0.5, short_time_pickup=1.5, short_time_delay=0.4)
        assert _cb_self_clearing_time(p, 720.0) == pytest.approx(0.5)
        assert _cb_self_clearing_time(_ml_props(), 20000.0) == pytest.approx(0.05)   # flat above Ii, no I²t tail

    def test_tmd_magnetic_tolerance(self):
        c = _profiles()["se_nsx_tmd_100"]["curve"]
        p = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 1.0, "magnetic_pickup": 8,
             "long_time_delay": 15, "trip_unit_kind": "tm", "pickup_base": {"magnetic": "In"},
             "thermal_curve": c["thermal"], "trip_tol": c["tol"]}
        t = _cb_self_clearing_time(p, 959.0)             # Ii 800 A + 20 % = 960 A
        assert t == pytest.approx(15 * (6 / 9.59) ** 2, rel=1e-6)    # still on the long-time curve
        assert _cb_self_clearing_time(p, 960.0) == pytest.approx(0.025)

    def test_no_tolerances_is_the_old_single_curve(self):
        legacy = {k: v for k, v in _ml_props().items() if k != "trip_tol"}
        assert _cb_self_clearing_time(legacy, 1100.0) == pytest.approx(0.2 + 0.08)   # delay + opening time
        assert _cb_self_clearing_time(legacy, 1500.0) == pytest.approx(0.025)

    def test_profiles_carry_published_tolerances(self):
        prof = _profiles()
        ml = prof["se_nsx_ml567_250"]["curve"]["tol"]
        assert ml["pickup"] == [1.05, 1.20] and ml["long_time"]["min_factor"] == 0.8
        assert ml["short_time"]["pickup_tol"] == 0.10
        assert ml["short_time"]["break_s"] == {"0": 0.08, "0.1": 0.14, "0.2": 0.20, "0.3": 0.32, "0.4": 0.50}
        assert ml["short_time"]["hold_s"] == {"0": 0.02, "0.1": 0.08, "0.2": 0.14, "0.3": 0.23, "0.4": 0.35}
        assert ml["instantaneous"] == {"pickup_tol": 0.15, "hold_s": 0.010, "break_s": 0.050}
        assert prof["se_nsx_ml2_100"]["dials"]["short_time_delay"] == {"fixed": True, "def": 0}
        assert prof["se_nsx_tmd_100"]["curve"]["tol"]["instantaneous"]["pickup_tol"] == 0.20


# ── ComPacT NSXm ─────────────────────────────────────────────────────────

class TestNsxm:
    def test_published_values(self):
        prof, ents = _profiles(), _entries()
        # catalogue A-3: Icu 380/415 V E 16, B 25, F 36, N 50, H 70 kA
        assert [ents[f"se_nsxm_{c}_100"]["breaking_ka"] for c in "ebfnh"] == [16, 25, 36, 50, 70]
        # B-5: TM-D Ii fixed 500 600 600 600 600 800 1000 1250 1250 1250 A for 16 ... 160 A
        for inn, a in ((16, 500), (25, 600), (50, 600), (63, 800), (80, 1000), (100, 1250), (160, 1250)):
            d = prof[f"se_nsxm_tmd_{inn}"]["dials"]["magnetic_pickup"]
            assert d["fixed"] and d["base"] == "In" and round(d["def"] * inn) == a
        # B-15: Vigi 4.1 Ii 375 / 750 / 1500 / 2000 A, Ir presets, tr 200 s @1.5 / 8 s @6 / 5 s @7.2 x Ir
        for inn, a in ((25, 375), (50, 750), (100, 1500), (160, 2000)):
            d = prof[f"se_nsxm_vigi41_{inn}"]
            assert round(d["dials"]["instantaneous_pickup"]["def"] * inn) == a
            assert d["curve"]["thermal"]["points"] == [[1.5, 200], [6, 8], [7.2, 5]]
        io = prof["se_nsxm_vigi41_160"]["dials"]["thermal_pickup"]["steps"]
        assert [round(s * 160) for s in io] == [63, 70, 80, 90, 100, 115, 130, 145, 160]
        assert prof["se_nsxm_vigi41_160"]["curve"]["tol"]["instantaneous"]["hold_s"] == 0.005

    def test_vigi_clearing(self):
        c = _profiles()["se_nsxm_vigi41_100"]
        p = {"cb_type": "mccb", "trip_rating_a": 100, "thermal_pickup": 1.0, "magnetic_pickup": 15,
             "long_time_delay": 8, "short_time_pickup": 1.5, "short_time_delay": 0, "instantaneous_pickup": 15,
             "trip_unit_kind": "electronic", "pickup_base": {"instantaneous": "In", "magnetic": "In"},
             "thermal_curve": c["curve"]["thermal"], "trip_tol": c["curve"]["tol"]}
        assert _cb_self_clearing_time(p, 150.0 * 1.0) == pytest.approx(200)        # 1.5 x Ir, Isd + 15 % not reached
        assert _cb_self_clearing_time(p, 180.0) == pytest.approx(0.08)             # S0: 80 ms
        assert _cb_self_clearing_time(p, 1725.0) == pytest.approx(0.05)            # Ii + 15 %: 50 ms


# ── Acti9 MCBs ───────────────────────────────────────────────────────────

def _mcb(model="iC60N", curve="C", inn=16):
    e = _entries()[f"se_{model.lower()}_{curve.lower()}_{inn}"]
    c = _profiles()[e["trip_units"][0]]["curve"]
    return e, {"cb_type": "mcb", "mcb_curve": curve, "trip_rating_a": inn, "thermal_pickup": 1.0,
               "magnetic_pickup": e["magnetic_pickup"], "long_time_delay": 10, "trip_unit_kind": "tm",
               "pickup_base": {"magnetic": "In"}, "thermal_curve": c["thermal"], "trip_tol": c["tol"]}


class TestActi9:
    def test_published_ratings(self):
        ents = _entries()
        # iC60N Icn 6 kA (Icu 50 kA to 4 A, 10 kA 6-63 A), iC60H 10 kA (70 / 15), iC60L 15 kA (100 / 25 / 20 / 15)
        assert ents["se_ic60n_c_16"]["breaking_ka"] == 6 and ents["se_ic60n_c_16"]["icu_ka"] == 10
        assert ents["se_ic60n_c_2"]["icu_ka"] == 50 and ents["se_ic60n_c_2"]["ics_pct"] == 100
        assert ents["se_ic60h_d_32"]["breaking_ka"] == 10 and ents["se_ic60h_d_32"]["icu_ka"] == 15
        assert ents["se_ic60l_c_25"]["breaking_ka"] == 15 and ents["se_ic60l_c_25"]["icu_ka"] == 25
        assert ents["se_ic60l_c_32"]["icu_ka"] == 20 and ents["se_ic60l_c_63"]["breaking_ka"] == 15
        assert "se_ic60l_c_13" not in ents and "se_ic60n_c_13" in ents
        assert ents["se_c120n_d_125"]["breaking_ka"] == 10 and ents["se_c120h_b_80"]["breaking_ka"] == 15
        assert ents["se_c120h_b_80"]["frame_a"] == 125 and ents["se_ic60n_b_0_5"]["trip_rating_a"] == 0.5

    def test_magnetic_bands(self):
        # drawn on the IEC 60898-1 chart: B 3.2-4.8, C 6.4-9.6, D 10-14 x In
        for curve, (lo, hi) in {"B": (3.2, 4.8), "C": (6.4, 9.6), "D": (10.0, 14.0)}.items():
            _, p = _mcb("iC60N", curve, 16)
            assert _cb_self_clearing_time(p, hi * 16 * 0.999) > 0.1            # not yet certain: thermal
            assert _cb_self_clearing_time(p, hi * 16) == pytest.approx(0.01)   # "less than 10 ms"

    def test_iec_60898_gates(self):
        # IEC 60898-1 Table 7: no trip within 1 h at 1.13 In, trip within 1 h at 1.45 In, 1-60 s at 2.55 In
        for model, curve, inn, gate in (("iC60N", "C", 16, 60), ("iC60N", "C", 2, 60),
                                        ("iC60H", "B", 63, 60), ("C120N", "C", 100, 120)):
            _, p = _mcb(model, curve, inn)
            assert _cb_self_clearing_time(p, 1.13 * inn) == 10000.0
            assert _cb_self_clearing_time(p, 1.46 * inn) <= 3600
            assert 1.0 <= _cb_self_clearing_time(p, 2.55 * inn) <= gate

    def test_published_example(self):
        # catalogue p.205: a C 20 A breaker interrupts 100 A (5 x In) in at least 0.45 s and at most 6 s
        # (the band's own magnetic zone for C starts at 6.4 x In, so at 5 x In it is still thermal)
        _, p = _mcb("iC60N", "C", 20)
        t = _cb_self_clearing_time(p, 100.0)
        assert 3.0 < t < 8.0                                 # maximum ~6 s on the published chart

    def test_thermal_curve_data_present(self):
        data = json.load(open(os.path.join(ROOT, "testing", "vendor-libraries", "data", "acti9_iec60898_curves.json")))
        for k, c in data["charts"].items():
            assert c["max"][0][1] == 3600 and c["min"][0][1] == 3600
            assert all(a[1] > b[1] and a[0] < b[0] for a, b in zip(c["max"], c["max"][1:])), k
            assert all(a[1] > b[1] and a[0] < b[0] for a, b in zip(c["min"], c["min"][1:])), k


# ── Masterpact MTZ ───────────────────────────────────────────────────────

def _mtz(**kw):
    c = _profiles()["se_mtz_ml5x"]["curve"]
    p = {"cb_type": "acb", "trip_rating_a": 1600, "thermal_pickup": 1.0, "magnetic_pickup": 2,
         "long_time_delay": 0.5, "short_time_pickup": 1.5, "short_time_delay": 0, "instantaneous_pickup": 2,
         "trip_unit_kind": "electronic", "pickup_base": {"instantaneous": "In", "magnetic": "In"},
         "thermal_curve": c["thermal"], "trip_tol": c["tol"]}
    p.update(kw)
    return p


class TestMtz:
    def test_published_values(self):
        prof, ents = _profiles(), _entries()
        # DOCA0100EN / DOCA0101EN performance levels at 415 V
        assert [ents[f"se_mtz1_{l}_1250"]["breaking_ka"] for l in ("h1", "h2", "h3", "l1")] == [42, 50, 66, 150]
        assert [ents[f"se_mtz2_{l}_2000"]["breaking_ka"] for l in ("n1", "h1", "h2", "h2v", "h3", "l1")] == [42, 66, 100, 100, 150, 150]
        assert ents["se_mtz3_h1_5000"]["breaking_ka"] == 66 and "se_mtz3_n1_5000" not in ents
        d = prof["se_mtz_ml5x"]["dials"]
        assert d["thermal_pickup"]["steps"][0] == 0.4 and d["thermal_pickup"]["steps"][-1] == 1.0
        assert d["long_time_delay"]["steps"] == [0.5, 1, 2, 4, 8, 12, 16, 20, 24] and d["long_time_delay"]["def"] == 0.5
        assert d["short_time_pickup"]["steps"][0] == 1.5 and d["short_time_pickup"]["steps"][-1] == 10
        assert d["instantaneous_pickup"]["steps"][:3] == [0, 2, 2.5] and d["instantaneous_pickup"]["steps"][-1] == 15
        assert d["instantaneous_pickup"]["def"] == 2 and d["instantaneous_pickup"]["base"] == "In"
        t = prof["se_mtz_ml5x"]["curve"]["thermal"]["tables"]
        assert t["24"] == [[1.5, 600], [6, 24], [7.2, 16.6]] and t["0.5"] == [[1.5, 12.5], [6, 0.5], [7.2, 0.34]]
        mf = prof["se_mtz_ml5x"]["curve"]["tol"]["long_time"]["min_factor"]
        assert mf["0.5"] == 0.7 and mf["2"] == 0.75 and mf["4"] == 0.8 and mf["24"] == 0.8

    def test_clearing_times(self):
        # Isd 10 x Ir (16 kA), tsd 0.2 s, Ii 15 x In (24 kA) — tr 8 s
        p = _mtz(long_time_delay=8, short_time_pickup=10, short_time_delay=0.2, instantaneous_pickup=15)
        assert _cb_self_clearing_time(p, 1.5 * 1600) == pytest.approx(200)           # 1.5 x Ir, tr 8 s
        assert _cb_self_clearing_time(p, 6 * 1600) == pytest.approx(8)
        assert _cb_self_clearing_time(p, 7.2 * 1600) == pytest.approx(5.5)
        assert _cb_self_clearing_time(p, 10.99 * 1600) > 1.0                         # Isd + 10 % = 11 x Ir not yet certain
        assert _cb_self_clearing_time(p, 11 * 1600) == pytest.approx(0.20)           # tsd 0.2 s: 200 ms maximum break
        assert _cb_self_clearing_time(p, 16.6 * 1600) == pytest.approx(0.05)         # Ii + 10 % (16.5 x In) -> 50 ms
        assert _cb_self_clearing_time(_mtz(long_time_delay=24), 1.5 * 1600) == pytest.approx(600)

    def test_ii_off_leaves_no_instantaneous(self):
        p = _mtz(short_time_pickup=1.5, short_time_delay=0.1, instantaneous_pickup=0, magnetic_pickup=1000)
        assert _cb_self_clearing_time(p, 60000.0) == pytest.approx(0.14)             # short-time plateau, no 10 x Ir fallback


# ── ABB SACE Emax 2 ──────────────────────────────────────────────────────

ABB_LIB = os.path.join(ROOT, "testing", "vendor-libraries", "abb_breakers.json")
ABB_JS = os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb.js")


def _abb():
    src = open(ABB_JS).read()
    head = "Object.assign(TRIP_UNITS, "
    prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])
    ents = {e["data"]["id"]: e["data"] for e in json.load(open(ABB_LIB))["entries"]}
    return prof, ents


def _ekip(unit="abb_emax2_dip_lsi", **kw):
    prof, _ = _abb()
    c = prof[unit]["curve"]
    p = {"cb_type": "acb", "trip_rating_a": 1600, "thermal_pickup": 1.0, "magnetic_pickup": 10,
         "long_time_delay": 24, "short_time_pickup": 6, "short_time_delay": 0.3, "instantaneous_pickup": 10,
         "trip_unit_kind": "electronic",
         "pickup_base": {"short_time": "In", "instantaneous": "In", "magnetic": "In"},
         "thermal_curve": c["thermal"], "trip_tol": c["tol"]}
    p.update(kw)
    return p


class TestAbbEmax2:
    def test_published_values(self):
        prof, ents = _abb()
        assert len(ents) == 60
        # catalogue 2/4: Icu 400-415 V
        assert [ents[f"abb_e1_2_{l}_1250"]["breaking_ka"] for l in "bcnl"] == [42, 50, 66, 150]
        assert [ents[f"abb_e2_2_{l}_2000"]["breaking_ka"] for l in "bnsh"] == [42, 66, 85, 100]
        assert [ents[f"abb_e4_2_{l}_4000"]["breaking_ka"] for l in "nshv"] == [66, 85, 100, 150]
        assert [ents[f"abb_e6_2_{l}_5000"]["breaking_ka"] for l in "hvx"] == [100, 150, 150]
        assert "abb_e2_2_b_800" not in ents and "abb_e4_2_v_2000" in ents
        d = prof["abb_emax2_dip_lsi"]["dials"]
        assert d["thermal_pickup"]["steps"][0] == 0.4 and len(d["thermal_pickup"]["steps"]) == 25
        assert d["long_time_delay"]["steps"] == [3, 12, 24, 36, 48, 72, 108, 144]
        assert d["short_time_pickup"]["steps"][1:4] == [0.6, 0.8, 1] and d["short_time_pickup"]["base"] == "In"
        assert d["short_time_delay"]["steps"] == [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        assert d["instantaneous_pickup"]["steps"][1] == 1.5 and d["instantaneous_pickup"]["steps"][-1] == 15
        assert d["instantaneous_pickup"]["def"] == 4 and d["long_time_delay"]["def"] == 144   # factory defaults
        assert "short_time_pickup" not in prof["abb_emax2_dip_li"]["dials"]

    def test_long_time_is_the_published_formula(self):
        p = _ekip(long_time_delay=24, short_time_pickup=0, instantaneous_pickup=0, magnetic_pickup=1000)
        # t1 = 24 s at 3 x I1; +/-10 % up to 6 x In: the maximum is 1.1 x nominal
        assert _cb_self_clearing_time(p, 3 * 1600) == pytest.approx(24 * 1.1)
        assert _cb_self_clearing_time(p, 1.5 * 1600) == pytest.approx(24 * 4 * 1.1)
        assert _cb_self_clearing_time(p, 4 * 1600) == pytest.approx(24 * (3 / 4) ** 2 * 1.1)
        assert _cb_self_clearing_time(p, 10 * 1600) == pytest.approx(24 * 0.09 * 1.2)   # +/-20 % above 6 x In
        assert _cb_self_clearing_time(_ekip(long_time_delay=3, short_time_pickup=0, instantaneous_pickup=0,
                                            magnetic_pickup=1000), 10 * 1600) == pytest.approx(1.0 * 1.2)  # 1 s floor
        assert _cb_self_clearing_time(p, 1.19 * 1600) == 10000.0                        # pickup 1.05-1.2 x I1

    def test_short_time_and_instantaneous(self):
        p = _ekip()                                    # I2 6 x In, t2 0.3 s, I3 10 x In
        assert _cb_self_clearing_time(p, 6 * 1600 * 1.069) > 1.0                       # I2 + 7 % not yet certain
        assert _cb_self_clearing_time(p, 6 * 1600 * 1.071) == pytest.approx(0.3 + 0.03)  # t2 + min(10 %, 40 ms)
        assert _cb_self_clearing_time(_ekip(short_time_delay=0.8), 7 * 1600) == pytest.approx(0.8 + 0.04)
        assert _cb_self_clearing_time(p, 10 * 1600 * 1.099) == pytest.approx(0.33)
        assert _cb_self_clearing_time(p, 10 * 1600 * 1.101) == pytest.approx(0.03)       # I3 + 10 %: 30 ms
        # S above 6 x In: +/-10 %
        q = _ekip(short_time_pickup=8)
        assert _cb_self_clearing_time(q, 8 * 1600 * 1.099) > 1.0
        assert _cb_self_clearing_time(q, 8 * 1600 * 1.101) == pytest.approx(0.33)

    def test_instantaneous_off_leaves_no_instantaneous(self):
        p = _ekip(instantaneous_pickup=0, magnetic_pickup=1000)
        assert _cb_self_clearing_time(p, 80000.0) == pytest.approx(0.33)


# ── ABB SACE Tmax XT ─────────────────────────────────────────────────────

XT_LIB = os.path.join(ROOT, "testing", "vendor-libraries", "abb_xt_breakers.json")
XT_JS = os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb-xt.js")


def _xt():
    src = open(XT_JS).read()
    head = "Object.assign(TRIP_UNITS, "
    prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])
    ents = {e["data"]["id"]: e["data"] for e in json.load(open(XT_LIB))["entries"]}
    return prof, ents


def _xt_cb(unit, inn, **kw):
    prof, _ = _xt()
    pr = prof[unit]
    p = {"cb_type": "mccb", "trip_rating_a": inn, "trip_unit_kind": pr["kind"],
         "thermal_curve": pr["curve"]["thermal"], "trip_tol": pr["curve"]["tol"]}
    for k, d in pr["dials"].items():
        p[k] = d["def"]
    p["pickup_base"] = {w: "In" for k, w in (("magnetic_pickup", "magnetic"), ("short_time_pickup", "short_time"),
                                            ("instantaneous_pickup", "instantaneous")) if pr["dials"].get(k, {}).get("base") == "In"}
    if pr["kind"] == "electronic":
        p["pickup_base"]["magnetic"] = "In"
        p["magnetic_pickup"] = p.get("instantaneous_pickup") or 1000
    p.update(kw)
    return p


class TestAbbTmaxXt:
    def test_entries(self):
        prof, ents = _xt()
        assert len(ents) == 309
        for e in ents.values():
            assert e["manufacturer"] == "ABB" and e["series"] == "SACE Tmax XT"
            assert all(u in prof for u in e["trip_units"]) and e["default_trip_unit"] == e["trip_units"][0]
        # catalogue 2/2-2/7: Icu at 415 V, Ics
        assert [ents[f"abb_xt1{l}_100"]["breaking_ka"] for l in "bcnsh"] == [18, 25, 36, 50, 70]
        assert ents["abb_xt1h_100"]["ics_pct"] == 50 and ents["abb_xt3s_250"]["ics_pct"] == 50
        assert [ents[f"abb_xt4{l}_250"]["breaking_ka"] for l in "nshlvx"] == [36, 50, 70, 120, 150, 200]
        assert [ents[f"abb_xt7{l}_1600"]["breaking_ka"] for l in "shl"] == [50, 70, 120]
        # ordering codes: no TMD 16-25 A on XT4 X, no Ekip Dip LSI on XT2 V
        assert "abb_xt4x_16" not in ents and ents["abb_xt4x_32"]["trip_units"] == ["abb_xt_tm_xt4_32"]
        assert "abb_xt_dip_lsi_xt24" not in ents["abb_xt2v_100"]["trip_units"]
        assert ents["abb_xt5n_630"]["trip_units"] == ["abb_xt_tm_xt5_630", "abb_xt_dip_lsi_xt5", "abb_xt_dip_ls_xt5",
                                                    "abb_xt_dip_li_xt5", "abb_xt_touch_xt5"]
        assert ents["abb_xt5n_400"]["frame_a"] == 400 and ents["abb_xt5n_500"]["frame_a"] == 630

    def test_thermal_magnetic_settings(self):
        prof, _ = _xt()
        # catalogue 3/20: I3 in amps on the device, held against In
        d = prof["abb_xt_tm_xt1_50"]["dials"]["magnetic_pickup"]
        assert d["fixed"] and d["base"] == "In" and d["def"] * 50 == pytest.approx(500)
        d = prof["abb_xt_tm_xt4_63"]["dials"]["magnetic_pickup"]          # TMA 315 / 473 / 630 A
        assert round(d["steps"][0] * 63) == 315 and round(d["steps"][-1] * 63) == 630 == round(d["def"] * 63)
        assert any(abs(s * 63 - 473) < 0.01 for s in d["steps"])
        assert prof["abb_xt_tm_xt1_16"]["dials"]["thermal_pickup"]["fixed"]
        assert prof["abb_xt_tm_xt3_250"]["dials"]["thermal_pickup"]["steps"][0] == 0.7
        assert prof["abb_xt_tm_xt5_400"]["dials"]["thermal_pickup"]["steps"] == [0.7, 0.775, 0.85, 0.925, 1.0]

    def test_thermal_magnetic_curve(self):
        # XT4 TMA 250 A: the digitised band (1SDC210033D0704 p.4/5); I1 moves the curve, I3 (amps) does not
        p = _xt_cb("abb_xt_tm_xt4_250", 250)
        t3 = _cb_self_clearing_time(p, 3 * 250)
        assert 150 < t3 < 300
        assert _cb_self_clearing_time(p, 1.29 * 250) == 10000.0                        # certain trip only above 1.3 x I1
        q = _xt_cb("abb_xt_tm_xt4_250", 250, thermal_pickup=0.7)
        assert _cb_self_clearing_time(q, 3 * 0.7 * 250) == pytest.approx(t3)
        assert _cb_self_clearing_time(p, 10 * 250 * 1.21) == pytest.approx(0.0157)      # I3 2500 A + 20 %
        assert _cb_self_clearing_time(q, 10 * 250 * 1.21) == pytest.approx(0.0157)
        assert _cb_self_clearing_time(p, 10 * 250 * 1.19) > 1.0
        # XT5 TMA (ABB US sheet): maximum clearing just above the I3 band
        assert _cb_self_clearing_time(_xt_cb("abb_xt_tm_xt5_630", 630), 13 * 630) == pytest.approx(0.079, rel=0.01)

    def test_ekip_dip(self):
        p = _xt_cb("abb_xt_dip_lsi_xt24", 250, short_time_pickup=5.5, short_time_delay=0.2, instantaneous_pickup=0,
                   magnetic_pickup=1000)
        # t1 = 12 s at 3 x I1, +/-10 % up to 4 x In, +/-20 % above
        assert _cb_self_clearing_time(p, 3 * 250) == pytest.approx(12 * 1.1)
        assert _cb_self_clearing_time(p, 5 * 250) == pytest.approx(12 * 0.36 * 1.2)
        assert _cb_self_clearing_time(p, 1.29 * 250) == 10000.0                        # trips between 1.05 and 1.3 x I1
        assert _cb_self_clearing_time(p, 5.5 * 250 * 1.11) == pytest.approx(0.2 * 1.2)  # I2 +10 %, t2 +20 %
        q = _xt_cb("abb_xt_dip_lsi_xt24", 250)                                         # I3 10 x In, <= 40 ms
        assert _cb_self_clearing_time(q, 10 * 250 * 1.11) == pytest.approx(0.040)
        r = _xt_cb("abb_xt_dip_li_xt24", 250)                                          # LS/I as L-I: <= 20 ms
        assert _cb_self_clearing_time(r, 10 * 250 * 1.11) == pytest.approx(0.020)
        s = _xt_cb("abb_xt_dip_ls_xt24", 250)                                          # as L-S: no I, t2 +/-15 %
        assert s["instantaneous_pickup"] == 0
        assert _cb_self_clearing_time(s, 50 * 250) == pytest.approx(0.1 * 1.15)
        prof, _ = _xt()
        assert prof["abb_xt_dip_lsi_xt6_800"]["dials"]["long_time_delay"]["steps"][-1] == 72
        assert prof["abb_xt_dip_lsi_xt6_1000"]["dials"]["long_time_delay"]["steps"][-1] == 42
        assert prof["abb_xt_dip_lsi_xt7"]["dials"]["instantaneous_pickup"]["steps"][-1] == 15

    def test_ekip_touch(self):
        p = _xt_cb("abb_xt_touch_xt7", 1600, short_time_pickup=4, short_time_delay=0.2)
        assert _cb_self_clearing_time(p, 3 * 1600) == pytest.approx(12 * 1.1)
        assert _cb_self_clearing_time(p, 4 * 1600 * 1.071) == pytest.approx(0.2 + 0.02)  # I2 +7 %, t2 + 10 %
        assert _cb_self_clearing_time(p, 10 * 1600 * 1.101) == pytest.approx(0.030)
        prof, _ = _xt()
        assert "off" not in prof["abb_xt_touch_xt24"]["dials"]["instantaneous_pickup"]   # I cannot be excluded


# ── ABB S200 / S200M / S300P / S800 MCBs ─────────────────────────────────

MCB_LIB = os.path.join(ROOT, "testing", "vendor-libraries", "abb_mcb_breakers.json")
MCB_JS = os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb-mcb.js")
VL_DIR_ABB = os.path.join(ROOT, "testing", "vendor-libraries")


def _abb_mcb(eid=None):
    src = open(MCB_JS).read()
    head = "Object.assign(TRIP_UNITS, "
    prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])
    ents = {e["data"]["id"]: e["data"] for e in json.load(open(MCB_LIB))["entries"]}
    if eid is None:
        return prof, ents
    e = ents[eid]
    c = prof[e["trip_units"][0]]["curve"]
    return e, {"cb_type": "mcb", "mcb_curve": e["mcb_curve"], "trip_rating_a": e["trip_rating_a"],
               "thermal_pickup": 1.0, "magnetic_pickup": e["magnetic_pickup"], "long_time_delay": 10,
               "trip_unit_kind": "tm", "pickup_base": {"magnetic": "In"},
               "thermal_curve": c["thermal"], "trip_tol": c["tol"]}


class TestAbbMcb:
    def test_entries(self):
        prof, ents = _abb_mcb()
        assert len(ents) == 261
        for e in ents.values():
            assert e["manufacturer"] == "ABB" and e["cb_type"] == "mcb" and e["mcb_curve"] in "BCD"
            assert e["trip_units"] == [e["default_trip_unit"]] and e["default_trip_unit"] in prof
        # A01 ordering tables: S200 B from 6 A and to 100 A, C 80 / 100 A not carried (no chart), no S200 D 80 A
        assert "abb_s200_b_4" not in ents and ents["abb_s200_b_100"]["frame_a"] == 100
        assert "abb_s200_c_80" not in ents and "abb_s200_d_80" not in ents
        assert ents["abb_s200_c_0_5"]["trip_rating_a"] == 0.5 and "abb_s200m_b_8" not in ents
        assert "abb_s800c_c_8" not in ents and ents["abb_s800s_d_2_5"]["trip_rating_a"] == 2.5
        assert ents["abb_s800p_c_125"]["frame_a"] == 125

    def test_published_breaking_capacities(self):
        _, ents = _abb_mcb()
        # (id, Icn = breaking_ka, Icu, Ics kA) — A01 pp. 28-31, 108, 142-150
        for eid, icn, icu, ics in (("abb_s200_c_16", 6, 10, 7.5), ("abb_s200_c_2", 6, 50, 7.5),
                                   ("abb_s200_b_80", 6, 6, 6),
                                   ("abb_s200m_c_40", 10, 15, 11.2), ("abb_s200m_c_63", 10, 10, 7.5),
                                   ("abb_s300p_c_4", 25, 100, 100), ("abb_s300p_c_25", 25, 25, 12.5),
                                   ("abb_s300p_c_40", 20, 25, 10), ("abb_s300p_d_63", 15, 25, 7.5),
                                   ("abb_s800c_c_32", 15, 25, 25), ("abb_s800n_c_32", 20, 36, 30),
                                   ("abb_s800n_c_8", 36, 36, 30), ("abb_s800s_c_63", 25, 50, 40),
                                   ("abb_s800s_b_5", 50, 50, 40), ("abb_s800p_d_80", 25, 50, 40),
                                   ("abb_s800p_d_125", 15, 50, 40)):
            e = ents[eid]
            assert (e["breaking_ka"], e["icu_ka"]) == (icn, icu), eid
            assert e["ics_pct"] * icu / 100 == pytest.approx(ics, abs=0.06), eid
        assert all(("check" in e) == (e["series"] == "S800") for e in ents.values())

    def test_magnetic_bands(self):
        # drawn on the IEC 60898-1 charts: S200 / S200M / S300P B 3-5, C 5-8, D 10-15; S800 B 3-5, C 5-10, D 10-20 x In
        for eid, lo, hi in (("abb_s200_b_16", 3, 5), ("abb_s200_c_16", 5, 8), ("abb_s200_d_16", 10, 15),
                            ("abb_s200m_c_2", 5, 8), ("abb_s300p_d_32", 10, 15), ("abb_s200_b_100", 3, 5),
                            ("abb_s800s_c_32", 5, 10), ("abb_s800n_d_16", 10, 20)):
            e, p = _abb_mcb(eid)
            inn = e["trip_rating_a"]
            assert e["magnetic_pickup"] == pytest.approx((lo + hi) / 2)
            assert _cb_self_clearing_time(p, hi * inn * 0.995) > 0.1, eid            # still on the thermal curve
            assert _cb_self_clearing_time(p, hi * inn) == pytest.approx(0.01), eid   # chart floor, < 0.1 s
            assert pickup_ref_a(p, "magnetic", inn, inn) == inn

    def test_iec_60898_gates(self):
        # IEC 60898-1: no trip at 1.13 In within 1 h, trip at 1.45 In within 1 h, 2.55 In: 1-60 s (In <= 32 A),
        # 1-120 s (In > 32 A); the S200 charts pass through the 60 s gate (read off within 1 %); ABB's S300P chart
        # allows ~130 s at 2.55 In for 6-63 A (the chart is used)
        for eid, gate in (("abb_s200_c_16", 60), ("abb_s200_d_2", 60), ("abb_s200m_b_63", 120),
                          ("abb_s300p_c_16", 131), ("abb_s200_b_80", 120), ("abb_s800s_c_16", 60)):
            e, p = _abb_mcb(eid)
            inn = e["trip_rating_a"]
            assert _cb_self_clearing_time(p, 1.13 * inn) == 10000.0, eid
            assert _cb_self_clearing_time(p, 1.46 * inn) <= 3600, eid
            assert 1.0 <= _cb_self_clearing_time(p, 2.55 * inn) <= gate * 1.01, eid

    def test_curves_read_off_the_charts(self):
        # B01 p.11 (S200 C 6-63 A): the maximum curve meets the 8 x In edge at ~3.6 s, the minimum the 5 x In
        # edge at ~0.7 s; p.13 (S200 B 80-100 A): 8.5 s / 2 s at the 5 / 3 x In corners
        data = json.load(open(os.path.join(VL_DIR_ABB, "data", "abb_mcb_curves.json")))["charts"]
        c = data["s200_c_6_63"]
        assert c["max"][-1] == [pytest.approx(8, rel=0.002), pytest.approx(3.6, rel=0.02)]
        assert c["min"][-1] == [pytest.approx(5, rel=0.002), pytest.approx(0.70, rel=0.02)]
        b = data["s200_b_80_100"]
        assert b["max"][-1][1] == pytest.approx(8.5, rel=0.02) and b["min"][-1][1] == pytest.approx(2.0, rel=0.02)
        for k, ch in data.items():
            for pts in (ch["max"], ch["min"]):
                assert pts[0][1] == 10000.0, k
                assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(pts, pts[1:])), k
        # the engine reads the maximum curve exactly
        e, p = _abb_mcb("abb_s200_c_16")
        for m, t in c["max"][1:-1]:
            assert _cb_self_clearing_time(p, m * 16) == pytest.approx(t, rel=1e-6)


# ── CBI L Frame (L20B / L40B) ────────────────────────────────────────────

CBI_LIB = os.path.join(ROOT, "testing", "vendor-libraries", "cbi_breakers.json")
CBI_JS = os.path.join(ROOT, "frontend", "js", "vendor-trip-units-cbi.js")


class TestCbiLFrame:
    def _load(self):
        src = open(CBI_JS).read()
        head = "Object.assign(TRIP_UNITS, "
        prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])["cbi_l_tm"]
        ents = {e["data"]["id"]: e["data"] for e in json.load(open(CBI_LIB))["entries"]}
        return prof, ents

    def test_entries(self):
        _, ents = self._load()
        assert len(ents) == 26
        assert sorted({e["trip_rating_a"] for e in ents.values()}) == [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 600]
        assert ents["cbi_l20b_250"]["breaking_ka"] == 20 and ents["cbi_l40b_600"]["breaking_ka"] == 40   # Icu @ 415 V
        assert all(e["manufacturer"] == "CBI" and e["trip_units"] == ["cbi_l_tm"] for e in ents.values())

    def test_curves_match_the_published_table(self):
        # data sheet "Time Delay Data" (% rated current -> s); the chart is digitised from the vector PDF
        prof, _ = self._load()
        mx = prof["curve"]["thermal"]["points"]
        mn = prof["curve"]["tol"]["long_time"]["min_points"]
        table_max = {2: 345, 3: 110, 4: 50, 6: 5}
        table_min = {2: 75, 3: 14, 4: 0.2, 6: 0.005}
        for tbl, pts in ((table_max, mx), (table_min, mn)):
            for m, t in tbl.items():
                assert thermal_curve_time({"points": pts}, m) == pytest.approx(t, rel=0.12)
        # the sheet prints 0.24 s at 1000 % for the maximum; the chart (and curve corner) say 0.024 s
        assert thermal_curve_time({"points": mx}, 10) == pytest.approx(0.024, rel=0.05)
        assert mx[-1][1] == pytest.approx(0.0175, rel=0.01) and mn[-1][1] == pytest.approx(0.004, rel=0.01)
        assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(mx[:-1], mx[1:-1]))

    def test_profile(self):
        prof, _ = self._load()
        d = prof["dials"]["magnetic_pickup"]
        assert d["fixed"] and d["base"] == "In" and d["def"] == pytest.approx(10.88, abs=0.01)
        tol = prof["curve"]["tol"]
        assert tol["pickup"] == [pytest.approx(1.065, abs=0.001), pytest.approx(1.319, abs=0.001)]
        assert d["def"] * (1 + tol["instantaneous"]["pickup_tol"]) <= 13.61            # never past the max curve's flat start


# ── CBI QF series (QF13 / QF18 / QF26LR / QF26HR) ────────────────────────

VL_DIR = os.path.join(ROOT, "testing", "vendor-libraries")
QF = {  # type -> (entries, curves, ratings, frame, Icu kA)
    "qf26lr": (24, {"1", "2"}, [5, 6, 10, 15, 20, 25, 30, 32, 40, 50, 60, 63], 63, 5),
    "qf26hr": (12, {"1", "2"}, [60, 70, 80, 90, 100, 125], 125, 5),
    "qf13": (16, {"1", "2"}, [1, 2, 5, 6, 10, 15, 20, 25], 25, 5),
    "qf18": (48, {"1", "2", "9"}, [1, 2, 5, 10, 15, 16, 20, 25, 30, 32, 35, 40, 45, 50, 60, 63], 63, 5),
}


def _qf(typ):
    src = open(os.path.join(ROOT, "frontend", "js", f"vendor-trip-units-cbi-{typ}.js")).read()
    head = "Object.assign(TRIP_UNITS, "
    prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])
    ents = {e["data"]["id"]: e["data"] for e in json.load(open(os.path.join(VL_DIR, f"cbi_{typ}_breakers.json")))["entries"]}
    return prof, ents


@pytest.mark.parametrize("typ", sorted(QF))
class TestCbiQf:
    def test_entries(self, typ):
        n, curves, ratings, frame, icu = QF[typ]
        prof, ents = _qf(typ)
        assert len(ents) == n and set(prof) == {f"cbi_{typ}_c{c}" for c in curves}
        assert sorted({e["trip_rating_a"] for e in ents.values()}) == ratings
        for e in ents.values():
            assert (e["cb_type"], e["manufacturer"], e["frame_a"], e["breaking_ka"]) == ("mcb", "CBI", frame, icu)
            assert e["trip_units"] == [e["default_trip_unit"]] and e["default_trip_unit"] in prof
        assert ents[f"cbi_{typ}_c1_{ratings[0]}"]["mcb_curve"] == "D" and ents[f"cbi_{typ}_c2_{ratings[0]}"]["mcb_curve"] == "C"

    def test_curves_match_the_printed_tables(self, typ):
        # the trip-time table under each chart (% of rated current -> minimum s, maximum s): the chart's curve passes
        # through each table point to within 6 % in current (the steep parts make a time comparison meaningless)
        import sys
        sys.path.insert(0, VL_DIR)
        from digitize_cbi_qf import TABLES
        prof, _ = _qf(typ)
        for pid, p in prof.items():
            c = pid.rsplit("_c", 1)[1]
            mx = {"points": p["curve"]["thermal"]["points"]}
            mn = {"points": p["curve"]["tol"]["long_time"]["min_points"]}
            inst = p["curve"]["tol"]["instantaneous"]
            for pct, (tmin, tmax) in TABLES[c].items():
                for pts, t, flat in ((mn, tmin, inst["hold_s"]), (mx, tmax, inst["break_s"])):
                    if t is None or (pts is mx and pct == 130):
                        continue
                    m = pct / 100
                    if m * 1.06 > pts["points"][-1][0]:            # past the curve's last point: the instantaneous time
                        assert t == pytest.approx(flat, rel=0.25), (pid, pct, t, flat)
                        continue
                    lo, hi = thermal_curve_time(pts, m * 0.94), thermal_curve_time(pts, m * 1.06)
                    assert hi * 0.97 <= t <= lo * 1.03, (pid, pct, t, hi, lo)

    def test_profile(self, typ):
        prof, _ = _qf(typ)
        for pid, p in prof.items():
            t = p["curve"]["tol"]
            assert t["pickup"] == [1.05, 1.3] and p["kind"] == "tm"
            d = p["dials"]["magnetic_pickup"]
            assert d["fixed"] and d["base"] == "In"
            assert t["instantaneous"]["hold_s"] < t["instantaneous"]["break_s"] < 0.03
            mn = p["curve"]["tol"]["long_time"]["min_points"]
            mx = p["curve"]["thermal"]["points"]
            assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(mx[:-1], mx[1:-1]))
            assert all(thermal_curve_time({"points": mn}, m) < thermal_curve_time({"points": mx}, m) for m in (1.5, 3, 6))

    def test_curve_2_is_faster_than_curve_1(self, typ):
        prof, _ = _qf(typ)
        c1 = {"points": prof[f"cbi_{typ}_c1"]["curve"]["thermal"]["points"]}
        c2 = {"points": prof[f"cbi_{typ}_c2"]["curve"]["thermal"]["points"]}
        assert all(thermal_curve_time(c2, m) < thermal_curve_time(c1, m) for m in (2, 5, 8))


# ── CBI thermal-magnetic MCCBs (G15D / G25D / F15D / F25D / G35D / F35D / K25D / K35D / K50D) ─────────

MCCB_TM = {  # type -> ({rating: (Icu, Ics) kA}, fixed-amps ratings)
    "g15d": ({16: (15, 15), 20: (15, 15), 32: (15, 15), 40: (15, 15), 50: (15, 15), 63: (15, 15), 80: (15, 15), 100: (15, 15), 125: (15, 15)}, [16, 20, 32]),
    "g25d": ({16: (25, 25), 20: (25, 25), 32: (25, 25), 40: (25, 25), 50: (25, 25), 63: (25, 25), 80: (25, 25), 100: (25, 25), 125: (25, 25)}, [16, 20, 32]),
    "f15d": ({r: (15, 15) for r in (125, 150, 160, 175, 200, 225, 250)}, []),
    "f25d": ({r: (25, 25) for r in (125, 150, 160, 175, 200, 225, 250)}, []),
    "g35d": ({r: (35, 35) for r in (16, 20, 32, 40, 50, 63, 80, 100)}, [16, 20, 32]),
    "f35d": ({r: (35, 35) for r in (125, 150, 160, 175, 200, 225, 250)}, []),
    "k25d": ({r: (25, 13) for r in (250, 300, 350, 400)}, []),
    "k35d": ({**{r: (35, 35) for r in (250, 300, 350, 400)}, 500: (36, 18), 630: (36, 18)}, []),
    "k50d": ({500: (50, 50), 630: (50, 50)}, []),
}


@pytest.mark.parametrize("typ", sorted(MCCB_TM))
class TestCbiMccbThermalMagnetic:
    def test_entries(self, typ):
        prof, ents = _qf(typ)
        ratings, _ = MCCB_TM[typ]
        assert {e["trip_rating_a"]: (e["breaking_ka"], round(e["breaking_ka"] * e["ics_pct"] / 100)) for e in ents.values()} == ratings
        for e in ents.values():
            assert (e["cb_type"], e["manufacturer"]) == ("mccb", "CBI")
            assert e["trip_units"] == [e["default_trip_unit"]] and e["default_trip_unit"] in prof

    def test_profiles(self, typ):
        prof, _ = _qf(typ)
        for pid, p in prof.items():
            t = p["curve"]["tol"]
            mx = p["curve"]["thermal"]["points"]
            mn = t["long_time"]["min_points"]
            assert p["kind"] == "tm" and 1.03 <= t["pickup"][0] <= 1.07 and 1.18 <= t["pickup"][1] <= 1.26     # IEC 60947-2 no-trip / trip
            d = p["dials"]["magnetic_pickup"]
            assert d["fixed"] and d["base"] == "In" and 7 < d["def"] < 40
            assert t["instantaneous"]["hold_s"] == pytest.approx(0.01, rel=0.05) and t["instantaneous"]["break_s"] == pytest.approx(0.02, rel=0.05)
            for pts in (mx, mn):
                assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(pts, pts[1:])), pid
            assert all(thermal_curve_time({"points": mn}, m) < thermal_curve_time({"points": mx}, m) for m in (1.5, 2, 3, 5))
            # the band: the instantaneous pickup range sits where the two curves reach their flat times
            lo, hi = d["def"] * (1 - t["instantaneous"]["pickup_tol"]), d["def"] * (1 + t["instantaneous"]["pickup_tol"])
            assert mn[-1][0] == pytest.approx(lo, rel=0.02) and mx[-1][0] >= hi * 0.9

    def test_fixed_amps_band(self, typ):
        # "AC 600 +/- 120 A": 480-720 A of instantaneous trip, whatever the 15-32 A rating
        prof, ents = _qf(typ)
        for inn in MCCB_TM[typ][1]:
            p = prof[ents[f"cbi_{typ}_{inn}"]["default_trip_unit"]]
            d, t = p["dials"]["magnetic_pickup"]["def"], p["curve"]["tol"]["instantaneous"]["pickup_tol"]
            assert d * (1 - t) * inn == pytest.approx(480, rel=0.03) and d * (1 + t) * inn == pytest.approx(720, rel=0.03)


# ── CBI J-Series (JS25 / J25S) ───────────────────────────────────────────

class TestCbiJFrame:
    def test_entries(self):
        prof, ents = _qf("jframe")
        assert set(prof) == {"cbi_jframe_a", "cbi_jframe_b"} and len(ents) == 17
        js, j3 = [e for e in ents.values() if e["model"] == "JS25"], [e for e in ents.values() if e["model"] == "J25S"]
        assert sorted(e["trip_rating_a"] for e in js) == [80, 100, 125, 150, 200, 250]
        assert sorted(e["trip_rating_a"] for e in j3) == [50, 60, 80, 100, 125, 150, 160, 175, 200, 225, 250]
        assert all(e["breaking_ka"] == 25 and e["frame_a"] == 250 and e["cb_type"] == "mccb" for e in ents.values())
        assert {e["rated_voltage_kv"] for e in js} == {0.24} and {e["rated_voltage_kv"] for e in j3} == {0.4}
        # 225 and 250 A use the 225-250 A chart, everything below the 12-200 A one
        assert all(e["default_trip_unit"] == ("cbi_jframe_a" if e["trip_rating_a"] >= 225 else "cbi_jframe_b") for e in ents.values())

    def test_curves_match_the_printed_tables(self):
        import sys
        sys.path.insert(0, VL_DIR)
        from digitize_cbi_qf import TABLES
        prof, _ = _qf("jframe")
        for pid, p in prof.items():
            c = pid.rsplit("_", 1)[1]
            mx = {"points": p["curve"]["thermal"]["points"]}
            mn = {"points": p["curve"]["tol"]["long_time"]["min_points"]}
            inst = p["curve"]["tol"]["instantaneous"]
            for pct, (tmin, tmax) in TABLES[c].items():
                for pts, t, flat in ((mn, tmin, inst["hold_s"]), (mx, tmax, inst["break_s"])):
                    if t is None or (pts is mx and pct == 130):
                        continue
                    m = pct / 100
                    if m * 1.06 > pts["points"][-1][0]:                # past the curve's last point: the flat time
                        assert t == pytest.approx(flat, rel=0.3), (pid, pct, t, flat)
                        continue
                    lo, hi = thermal_curve_time(pts, m * 0.94), thermal_curve_time(pts, m * 1.06)
                    assert hi * 0.97 <= t <= lo * 1.03, (pid, pct, t, hi, lo)

    def test_profiles(self):
        prof, _ = _qf("jframe")
        a, b = prof["cbi_jframe_a"], prof["cbi_jframe_b"]
        for p in (a, b):
            assert p["curve"]["tol"]["pickup"] == [1.05, 1.3] and p["dials"]["magnetic_pickup"]["base"] == "In"
            assert p["curve"]["tol"]["instantaneous"]["pickup_tol"] >= 0
        # the 225-250 A curve never clears faster than 1 s (its maximum floor); the other floors at 0.02 s
        assert a["curve"]["tol"]["instantaneous"]["break_s"] == pytest.approx(1.0, rel=0.02)
        assert b["curve"]["tol"]["instantaneous"]["break_s"] == pytest.approx(0.02, rel=0.03)


# ── CBI F65DV (thermal-adjustable) ───────────────────────────────────────

class TestCbiF65dv:
    def test_entries_and_dial(self):
        prof, ents = _qf("f65dv")
        assert sorted(e["trip_rating_a"] for e in ents.values()) == [25, 32, 40, 50, 63, 100, 125, 160, 250]
        assert all(e["breaking_ka"] == 65 and e["ics_pct"] == 100 and e["cb_type"] == "mccb" for e in ents.values())
        # Ir range from the sheet: e.g. 100 A: 70-100 A -> 0.70 ... 1.00 x In in 1 % steps
        d = prof["cbi_f65dv_100"]["dials"]["thermal_pickup"]
        assert d["steps"][0] == 0.7 and d["steps"][-1] == 1.0 and d["def"] == 1.0 and len(d["steps"]) == 31
        assert prof["cbi_f65dv_25"]["dials"]["thermal_pickup"]["steps"][0] == 0.8

    def test_instantaneous_is_against_in(self):
        prof, ents = _qf("f65dv")
        for inn, e in ((e["trip_rating_a"], e) for e in ents.values()):
            p = prof[e["default_trip_unit"]]
            d, t = p["dials"]["magnetic_pickup"], p["curve"]["tol"]["instantaneous"]["pickup_tol"]
            assert d["base"] == "In"
            lo, hi = d["def"] * (1 - t), d["def"] * (1 + t)
            if inn <= 50:                  # "AC 600 +/- 120 A" fixed
                assert lo * inn == pytest.approx(480, rel=0.02) and hi * inn == pytest.approx(720, rel=0.02)
            else:                          # "AC 1000 +/- 200 %" x In
                assert lo == pytest.approx(8, rel=0.02) and hi == pytest.approx(12, rel=0.02)

    def test_thermal_curve_only(self):
        # an adjustable Ir: the points are the thermal part (x Ir), they must not contain the instantaneous drop
        prof, _ = _qf("f65dv")
        for p in prof.values():
            mx = p["curve"]["thermal"]["points"]
            mn = p["curve"]["tol"]["long_time"]["min_points"]
            assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(mx, mx[1:])) and mx[-1][1] > 0.05 and mn[-1][1] > 0.05
            assert p["curve"]["tol"]["instantaneous"]["hold_s"] == pytest.approx(0.01, rel=0.05)
            assert p["curve"]["tol"]["instantaneous"]["break_s"] == pytest.approx(0.02, rel=0.05)


# ── CBI electronic (DE) MCCBs ────────────────────────────────────────────

DE = {  # type -> (In, Ir low, Ii max x In, STD pickup base, Icu, Ics)
    "k35de": (400, 200, 16, None, 35, 35), "k50de": (630, 300, 15, None, 50, 50), "k70de": (630, 300, 15, None, 70, 70),
    "l35de800": (800, 400, 12, None, 36, 18), "l70de800": (800, 400, 12, None, 65, 65),
    "n85de1000": (1000, 500, 12, "In", 85, 43), "n85de1250": (1250, 600, 12, "In", 85, 43), "n85de1600": (1600, 800, 12, "In", 85, 43),
}


def _de(typ):
    src = open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units-cbi-de.js")).read()
    head = "Object.assign(TRIP_UNITS, "
    prof = json.loads(src[src.index(head) + len(head):src.rindex(");")])
    ent = json.load(open(os.path.join(VL_DIR, f"cbi_{typ}_breakers.json")))["entries"]
    assert len(ent) == 1
    return prof[f"cbi_{typ}"], ent[0]["data"]


@pytest.mark.parametrize("typ", sorted(DE))
class TestCbiDe:
    def test_entry_and_dials(self, typ):
        inn, ir_lo, ii_max, st_base, icu, ics = DE[typ]
        p, e = _de(typ)
        assert (e["trip_rating_a"], e["breaking_ka"], round(e["breaking_ka"] * e["ics_pct"] / 100), e["cb_type"]) == (inn, icu, ics, "mccb")
        d = p["dials"]
        assert p["kind"] == "electronic" and e["trip_unit_kind"] == "electronic" and e["default_trip_unit"] == f"cbi_{typ}"
        assert d["thermal_pickup"]["steps"][0] == pytest.approx(ir_lo / inn, abs=0.01) and d["thermal_pickup"]["steps"][-1] == 1.0
        assert d["long_time_delay"]["steps"] == [12, 60, 100, 150]
        assert d["short_time_pickup"]["steps"] == [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10] and d["short_time_pickup"].get("base") == st_base
        assert d["short_time_delay"]["steps"] == [0.06, 0.1, 0.2, 0.3]
        assert d["instantaneous_pickup"]["steps"] == list(range(4, ii_max + 1)) and d["instantaneous_pickup"]["base"] == "In"

    def test_long_time_curve_matches_the_published_times(self, typ):
        p, _ = _de(typ)
        tc = p["curve"]["thermal"]
        for tl, t125 in ((12, 80), (60, 400), (100, 670), (150, 1000)):       # sheet: operating time at 125 % Ir
            assert thermal_curve_time(tc, 2.0, {"long_time_delay": tl}) == pytest.approx(tl, rel=0.01)
            assert thermal_curve_time(tc, 1.25, {"long_time_delay": tl}) == pytest.approx(t125, rel=0.06)
        tol = p["curve"]["tol"]
        assert tol["long_time"]["time_tol"] == 0.2 and tol["short_time"]["pickup_tol"] == 0.15 and tol["instantaneous"]["pickup_tol"] == 0.15
        assert tol["instantaneous"]["break_s"] == 0.03 and tol["pickup"][0] < 1.1 < 1.25 < tol["pickup"][1] + 0.01
        # short-time delay: published 0.06 +/- 0.02, 0.1 +/- 0.03, 0.2 +/- 0.04, 0.3 +/- 0.06 s
        assert tol["short_time"]["hold_s"] == {"0.06": 0.04, "0.1": 0.07, "0.2": 0.16, "0.3": 0.24}
        assert tol["short_time"]["break_s"] == {"0.06": 0.08, "0.1": 0.13, "0.2": 0.24, "0.3": 0.36}

