"""Tests for proposed fixes and Fix all.

Cable fixes are judged by the circuit check itself: the proposal must clear the
issue when re-run on a copy, and the project handed in is never modified.
Hand-typed values are never in the automatic set.
"""

import pytest

from backend.analysis.db_circuit_check import run_db_circuit_check
from backend.analysis.fixes import fix_all, propose_fixes
from backend.tests.test_db_circuit_check import _board_project, _way


def _project():
    ways = [
        _way(id="w1", way="1", breaker_a=32, load_va=3000, cable_m=10, cable_mm2=2.5),
        _way(id="w2", way="2", breaker_a=32, load_va=3000, cable_m=10, cable_mm2=2.5, cable_locked=True),
        _way(id="w3", way="3", breaker_a=10, load_va=1000, cable_m=10, cable_mm2=2.5),
    ]
    return _board_project(ways)


def _issue(way):
    return {"key": f"db-1:{way}", "kind": "db_way", "board_id": "db-1", "way_id": way}


def _cable(project, way):
    for c in project.components:
        if c.id == "db-1":
            return next(w for w in c.props["circuits"] if w["id"] == way)["cable_mm2"]


class TestPropose:
    def test_undersized_cable_gets_the_next_passing_size(self):
        f = propose_fixes(_project(), [_issue("w1")])[0]
        assert f["fix"] and f["manual"] is False
        ch = f["changes"][0]
        assert (ch["field"], ch["from"], ch["to"]) == ("cable_mm2", 2.5, 10)  # three bunched circuits derate 2.5 mm² to 16.8 A
        assert f["before"]["failing"] == ["coordination_status"]
        assert f["after"]["failing"] == [] and f["clears"] is True

    def test_the_project_is_not_changed(self):
        p = _project()
        propose_fixes(p, [_issue("w1")])
        assert _cable(p, "w1") == 2.5

    def test_hand_typed_cable_is_flagged_manual(self):
        assert propose_fixes(_project(), [_issue("w2")])[0]["manual"] is True

    def test_a_way_that_is_not_failing_on_its_cable_has_no_fix(self):
        f = propose_fixes(_project(), [_issue("w3")])[0]
        assert f["fix"] is None and "cable" in f["reason"].lower()

    def test_unknown_way(self):
        f = propose_fixes(_project(), [{"key": "k", "kind": "db_way", "board_id": "db-1", "way_id": "nope"}])[0]
        assert f["fix"] is None

    def test_unknown_kind(self):
        f = propose_fixes(_project(), [{"key": "k", "kind": "mystery"}])[0]
        assert f["fix"] is None


class TestLadder:
    def _tx(self, **kw):
        i = {"key": "t1", "kind": "ladder", "label": "Transformer T1", "unit": " kVA",
             "target": {"id": "tx-1"}, "field": "rated_kva", "current": 800, "required": 900,
             "ladder": [{"value": v} for v in (500, 630, 800, 1000, 1250)]}
        i.update(kw)
        return i

    def test_next_standard_size_that_reaches_the_requirement(self):
        f = propose_fixes(_project(), [self._tx()])[0]
        assert f["changes"][0]["to"] == 1000 and f["after"]["ok"] is True
        assert f["before"]["ok"] is False

    def test_skips_a_size_that_is_not_enough(self):
        f = propose_fixes(_project(), [self._tx(required=1100)])[0]
        assert f["changes"][0]["to"] == 1250

    def test_end_of_the_list(self):
        f = propose_fixes(_project(), [self._tx(required=5000)])[0]
        assert f["fix"] is None

    def test_manual_flag_carries_over(self):
        assert propose_fixes(_project(), [self._tx(manual=True)])[0]["manual"] is True

    def test_breaker_id_is_returned_for_a_library_swap(self):
        f = propose_fixes(_project(), [self._tx(ladder=[{"value": 36, "id": "cb:36"}], current=25, required=30)])[0]
        assert f["changes"][0]["to_id"] == "cb:36"


class TestFixAll:
    def test_automatic_values_are_ticked_and_hand_typed_ones_wait(self):
        r = fix_all(_project(), [_issue("w1"), _issue("w2")])
        assert [f["issue_key"] for f in r["automatic"]] == ["db-1:w1"]
        assert [f["issue_key"] for f in r["needs_approval"]] == ["db-1:w2"]
        assert r["summary"]["automatic"] >= 1 and r["summary"]["needs_approval"] >= 1
        assert r["summary"]["new_failures"] == 0

    def test_approving_a_hand_typed_value_moves_it_to_the_automatic_set(self):
        r = fix_all(_project(), [_issue("w1"), _issue("w2")], approved_keys=["db-1:w2"])
        assert {f["issue_key"] for f in r["automatic"]} == {"db-1:w1", "db-1:w2"}
        assert r["needs_approval"] == []

    def test_unfixable_issues_are_listed_with_a_reason(self):
        r = fix_all(_project(), [_issue("w1"), _issue("w3")])
        assert [n["issue_key"] for n in r["not_fixed"]] == ["db-1:w3"]
        assert r["not_fixed"][0]["reason"]

    def test_two_fixes_on_one_value_keep_the_larger(self):
        a = {"key": "a", "kind": "ladder", "target": {"id": "tx-1"}, "field": "rated_kva",
             "current": 800, "required": 900, "ladder": [{"value": v} for v in (1000, 1250)]}
        b = {**a, "key": "b", "required": 1100}
        r = fix_all(_project(), [a, b])
        assert [f["issue_key"] for f in r["automatic"]] == ["b"]
        assert r["not_fixed"][0]["issue_key"] == "a"

    def test_applying_the_automatic_set_leaves_no_new_failure(self):
        p = _project()
        r = fix_all(p, [_issue("w1")])
        trial = p.model_copy(deep=True)
        for f in r["automatic"]:
            for ch in f["changes"]:
                for c in trial.components:
                    if c.id == ch["target"]["board_id"]:
                        for w in c.props["circuits"]:
                            if w["id"] == ch["target"]["way_id"]:
                                w[ch["field"]] = ch["to"]
        rows = {x["way_id"]: x for x in run_db_circuit_check(trial)["ways"]}
        assert rows["w1"]["coordination_status"] != "fail"
