"""Tests for distribution-board cable sizing (size_db_cables).

Sizing is judged by the circuit check's own per-way check, so the tests are
consistency checks against it: the proposed size passes run_db_circuit_check,
one preferred size smaller fails the check named in ``governed_by``, and a
way no size up to the cap passes says what it would need.
"""

import pytest

from backend.analysis.db_circuit_check import (
    ecc_required_mm2,
    run_db_circuit_check,
    size_db_cables,
)
from backend.analysis.iec_60364_tables import IEC_STANDARD_SIZES
from backend.tests.test_db_circuit_check import _board_project, _rows, _way

STATUS = {"iz": "coordination_status", "vd": "vd_status", "zs": "zs_status"}


def _sized(ways, **kw):
    return {w["way_id"]: w for w in size_db_cables(_board_project(ways), "db-1", **kw)["ways"]}


def _check_with(ways, way_id, mm2, ecc=None):
    ways = [dict(w) for w in ways]
    for w in ways:
        if w["id"] == way_id:
            w["cable_mm2"] = mm2
            w["ecc_mm2"] = ecc if ecc is not None else ecc_required_mm2(mm2)
    return _rows(run_db_circuit_check(_board_project(ways)))[way_id]


def _smaller(mm2):
    return max(s for s in IEC_STANDARD_SIZES if s < mm2)


class TestSizing:
    def test_light_load_gets_the_minimum_power_size(self):
        ways = [_way(breaker_a=20, load_va=1000, cable_m=10)]
        s = _sized(ways)["w1"]
        assert s["proposed_mm2"] == 2.5
        assert s["governed_by"] == "min"
        assert s["ecc_mm2"] == ecc_required_mm2(2.5)

    def test_lighting_minimum_is_1_5(self):
        ways = [_way(description="Lights — offices", breaker_a=10, load_va=500, cable_m=10)]
        assert _sized(ways)["w1"]["proposed_mm2"] == 1.5

    def test_breaker_rating_sets_the_size(self):
        # 32 A on B1 PVC Cu: 2.5 mm² (Iz 24 A) is too small, 4 mm² (32 A) holds it.
        ways = [_way(breaker_a=32, load_va=3000, cable_m=10)]
        s = _sized(ways)["w1"]
        assert s["proposed_mm2"] == 4
        assert s["governed_by"] == "iz"
        assert _check_with(ways, "w1", 4)["coordination_status"] != "fail"
        assert _check_with(ways, "w1", 2.5)["coordination_status"] == "fail"

    def test_long_run_is_sized_on_volt_drop(self):
        ways = [_way(description="Lights — car park", breaker_a=10, load_va=1800, cable_m=120)]
        s = _sized(ways)["w1"]
        mm2 = s["proposed_mm2"]
        assert mm2 and mm2 > 1.5
        assert s["governed_by"] == "vd"
        assert _check_with(ways, "w1", mm2)["vd_status"] != "fail"
        assert _check_with(ways, "w1", _smaller(mm2))["vd_status"] == "fail"

    @pytest.mark.parametrize("load_va,length", [(2000, 15), (3600, 45), (1200, 90), (4500, 60)])
    def test_proposal_is_the_smallest_that_passes(self, load_va, length):
        ways = [_way(breaker_a=20, load_va=load_va, cable_m=length)]
        s = _sized(ways)["w1"]
        mm2 = s["proposed_mm2"]
        row = _check_with(ways, "w1", mm2)
        for k in ("iz", "vd", "zs"):
            assert row[STATUS[k]] != "fail"
        if s["governed_by"] != "min":
            assert _check_with(ways, "w1", _smaller(mm2))[STATUS[s["governed_by"]]] == "fail"

    def test_no_size_up_to_the_cap_reports_what_it_needs(self):
        ways = [_way(description="Gate motor", breaker_a=16, load_va=3000, cable_m=400)]
        s = _sized(ways, max_mm2=16)["w1"]
        assert s["proposed_mm2"] is None
        assert "vd" in s["failing"]
        assert s["needs_mm2"] and s["needs_mm2"] > 16
        assert _check_with(ways, "w1", s["needs_mm2"])["vd_status"] != "fail"
        assert "16 mm²" in s["message"]

    def test_unchecked_criteria_are_ignored(self):
        ways = [_way(description="Gate motor", breaker_a=16, load_va=3000, cable_m=400)]
        s = _sized(ways, max_mm2=16, checks=["iz"])["w1"]
        assert s["proposed_mm2"] == 2.5

    def test_only_the_asked_ways(self):
        ways = [_way(id="a"), _way(id="b", way="2"), _way(id="c", way="3")]
        assert set(_sized(ways, way_ids=["a", "c"])) == {"a", "c"}

    def test_keeps_the_ways_own_ecc_when_asked(self):
        ways = [_way(breaker_a=32, load_va=3000, cable_m=10, ecc_mm2=2.5)]
        s = _sized(ways, set_ecc=False)["w1"]
        assert s["ecc_mm2"] is None
        assert s["proposed_mm2"] == 4

    def test_empty_way_is_not_sized(self):
        s = _sized([_way(breaker_a=0, load_va=0)])["w1"]
        assert s["proposed_mm2"] is None and "nothing to size" in s["message"]

    def test_unknown_board(self):
        out = size_db_cables(_board_project([_way()]), "nope")
        assert out["ways"] == [] and out["warnings"]

    def test_route_encodes(self):
        from fastapi.encoders import jsonable_encoder
        from backend.routes.analysis import DbCableSizeRequest, db_cable_size

        p = _board_project([_way(breaker_a=32, load_va=3000, cable_m=10)])
        out = db_cable_size(DbCableSizeRequest(**p.model_dump(), board_id="db-1", max_mm2=10))
        enc = jsonable_encoder(out)
        assert enc["ways"][0]["proposed_mm2"] == 4
        assert enc["checks"] == ["iz", "vd", "zs"]
