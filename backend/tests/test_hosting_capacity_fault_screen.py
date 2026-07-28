"""Hosting-capacity fault-level / protection screen —
backend/analysis/hosting_capacity.py.

Voltage rise and thermal overload are not the only things that bind a DER
interconnection, and often not the first: a DER-heavy bus can push the
prospective fault current past switchgear breaking capacity, or contribute
enough infeed to desensitize an overcurrent relay, well before either of the
load-flow screens trips. That used to be left to the user as a manual follow-up
named only in the docstring; Fault Analysis + Duty Check are now re-run at each
bus's discovered capacity.

What has to hold:

* Turning the screen off reproduces the pre-screen behaviour exactly, and says
  so in its own output (TestScreenDisabled).
* When nothing binds, the screen is transparent (TestScreenPasses).
* When it binds, the reported capacity is CUT by bisection and the limiting
  factor changes — the number a planner acts on is the screened one
  (TestScreenBinds).
* A device already failing in the base case is a pre-existing problem, not
  something this DER caused; blaming the interconnection for it would be wrong
  (TestDegradationOnly).

Run with:  python -m pytest backend/tests/test_hosting_capacity_fault_screen.py -v
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.hosting_capacity import (
    run_hosting_capacity, DEFAULT_FAULT_RISE_LIMIT_PCT,
    DEFAULT_DER_SHARE_LIMIT_PCT,
)


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _feeder(load_kva=2000, cb_ka=25.0, with_cb=False):
    """utility -> bus-1 -> [CB] -> line -> bus-2 -> load."""
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                       "fault_mva": 200, "x_r_ratio": 10,
                                       "z0_z1_ratio": 1.0}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
        _comp("cable-1", "cable", {"name": "OHL", "construction": "overhead",
                                   "r_per_km": 0.1, "x_per_km": 0.4,
                                   "length_km": 5, "voltage_kv": 11,
                                   "rated_amps": 400, "temperature_c": 20}),
        _comp("bus-2", "bus", {"name": "B2", "voltage_kv": 11}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
                                        "power_factor": 0.9}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1")]
    if with_cb:
        comps.insert(2, _comp("cb-1", "circuit_breaker", {
            "name": "CB1", "rated_current_a": 630,
            "breaking_capacity_ka": cb_ka, "making_capacity_ka": cb_ka * 2.5}))
        wires += [_wire("w2", "bus-1", "cb-1"), _wire("w3", "cb-1", "cable-1")]
    else:
        wires += [_wire("w2", "bus-1", "cable-1")]
    wires += [_wire("w4", "cable-1", "bus-2"), _wire("w5", "bus-2", "load-1")]
    return ProjectData(projectName="hc", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _run(**kw):
    kw.setdefault("step_mw", 1.0)
    kw.setdefault("max_mw_per_bus", 3.0)
    project = kw.pop("project", None) or _feeder()
    return run_hosting_capacity(project, **kw)


class TestScreenDisabled:
    def test_opt_out_reports_not_run(self):
        r = _run(fault_screen=False)
        assert r["fault_screen"] is False
        for b in r["buses"]:
            assert b["fault_screen"] == "not_run"
            assert b["fault_level_ok"] is None

    def test_opt_out_does_not_touch_the_capacity(self):
        """The screen can only ever CUT a capacity; disabling it must leave the
        load-flow answer exactly as it was."""
        r = _run(fault_screen=False)
        for b in r["buses"]:
            assert b["screened_capacity_mw"] == b["hosting_capacity_mw"]

    def test_method_note_says_the_screen_was_skipped(self):
        """A result that silently omitted the screen would be read as a result
        that passed it."""
        r = _run(fault_screen=False)
        assert "disabled" in r["method"]
        assert "Fault Analysis / Duty Check" in r["method"]

    def test_enabled_run_describes_the_screen(self):
        r = _run(fault_screen=True)
        assert "Fault Analysis + Duty Check" in r["method"]


class TestScreenPasses:
    def test_defaults_echoed_back(self):
        r = _run(fault_screen=True)
        assert r["fault_screen"] is True
        assert r["fault_rise_limit_pct"] == DEFAULT_FAULT_RISE_LIMIT_PCT
        assert r["der_share_limit_pct"] == DEFAULT_DER_SHARE_LIMIT_PCT

    def test_screen_is_transparent_when_nothing_binds(self):
        """A small DER on a stiff 200 MVA grid raises the fault level by a few
        percent — well inside the 10 % default — so the screened capacity must
        equal the load-flow capacity."""
        r = _run(fault_screen=True)
        assert r["buses"]
        for b in r["buses"]:
            assert b["fault_screen"] == "ok"
            assert b["fault_level_ok"] is True
            assert b["screened_capacity_mw"] == b["hosting_capacity_mw"]
            assert b["limiting_factor"] != "fault_level"

    def test_evidence_is_reported_even_on_a_pass(self):
        """The planner needs the margin, not just the verdict."""
        for b in _run(fault_screen=True)["buses"]:
            assert 0.0 <= b["fault_level_rise_pct"] < DEFAULT_FAULT_RISE_LIMIT_PCT
            assert b["der_fault_share_pct"] >= 0.0
            assert b["fault_new_failures"] == []

    def test_fault_rise_is_larger_at_the_weaker_bus(self):
        """Physical sanity: the same injection moves the fault level more at the
        remote end of a feeder than at the strong source bus."""
        by_id = {b["bus_id"]: b for b in _run(fault_screen=True)["buses"]}
        if "bus-1" in by_id and "bus-2" in by_id:
            assert by_id["bus-2"]["fault_level_rise_pct"] > by_id["bus-1"]["fault_level_rise_pct"]


class TestScreenBinds:
    def test_tight_limit_cuts_the_capacity(self):
        """Force the screen to bind by dropping the fault-rise limit below what
        the DER actually causes. The reported capacity must fall, the limiting
        factor must switch to `fault_level`, and `fault_limited_mw` must record
        where the bisection landed."""
        r = _run(fault_screen=True, fault_rise_limit_pct=0.5,
                 der_share_limit_pct=1.0)
        binding = [b for b in r["buses"] if b["fault_screen"] == "fail"]
        assert binding, "expected the tight limit to bind at some bus"
        for b in binding:
            assert b["fault_level_ok"] is False
            assert b["limiting_factor"] == "fault_level"
            assert b["fault_limited_mw"] is not None
            assert b["screened_capacity_mw"] < b["hosting_capacity_mw"]
            assert b["screened_capacity_mw"] == pytest.approx(b["fault_limited_mw"])

    def test_bisected_capacity_is_bracketed(self):
        """Zero is known to pass (it is the base case) and the discovered
        capacity is known to fail, so the answer must lie strictly between."""
        r = _run(fault_screen=True, fault_rise_limit_pct=0.5,
                 der_share_limit_pct=1.0)
        for b in r["buses"]:
            if b["fault_screen"] != "fail":
                continue
            assert 0.0 <= b["fault_limited_mw"] < b["hosting_capacity_mw"]

    def test_failure_reason_is_stated(self):
        r = _run(fault_screen=True, fault_rise_limit_pct=0.5,
                 der_share_limit_pct=1.0)
        for b in r["buses"]:
            if b["fault_screen"] == "fail":
                assert "fault level rises" in b["note"]
                assert "limit 0.5%" in b["note"]

    def test_coordination_review_advisory(self):
        """A DER supplying more than the share limit of the fault current at its
        own bus is the usual trigger for re-grading feeder overcurrent
        protection — an advisory, not a failure."""
        r = _run(fault_screen=True, der_share_limit_pct=0.5)
        flagged = [b for b in r["buses"] if b["coordination_review"]]
        assert flagged, "expected a coordination-review advisory at this share limit"
        for b in flagged:
            assert b["der_fault_share_pct"] > 0.5

    def test_ranking_uses_the_screened_capacity(self):
        """A bus with lots of voltage/thermal headroom whose fault screen cuts it
        down must not still look like the best candidate."""
        r = _run(fault_screen=True, fault_rise_limit_pct=0.5,
                 der_share_limit_pct=1.0)
        screened = [b["screened_capacity_mw"] for b in r["buses"]]
        assert screened == sorted(screened)


class TestDegradationOnly:
    def test_pre_existing_duty_failure_not_blamed_on_the_der(self):
        """A hopelessly undersized breaker fails in the base case too. Counting
        it against the interconnection would report a 0 MW hosting capacity for
        a defect that has nothing to do with the DER."""
        r = _run(project=_feeder(with_cb=True, cb_ka=1.0), fault_screen=True,
                 max_mw_per_bus=2.0)
        for b in r["buses"]:
            assert b["fault_new_failures"] == []
            assert b["fault_level_ok"] is not False

    def test_baseline_violation_bus_is_not_reported_as_passing(self):
        """A bus that already violates with zero DER has no capacity to screen.
        The flag must read "not applicable", never "passed", or a broken base
        case would look like a clean bus."""
        # 5 MVA down a 5 km 11 kV line still SOLVES, but sits below the 0.95 pu
        # floor — a converged base case with a pre-existing violation, which is
        # exactly the state this branch exists for.
        proj = _feeder(load_kva=5000)
        r = run_hosting_capacity(proj, fault_screen=True, step_mw=1.0,
                                 max_mw_per_bus=2.0)
        assert r["converged"] is True
        offenders = [b for b in r["buses"]
                     if b["limiting_factor"] == "baseline_violation"]
        assert offenders, "expected a pre-existing violation at this loading"
        for b in offenders:
            assert b["fault_level_ok"] is None
            assert b["fault_screen"] == "no_capacity"
            assert b["screened_capacity_mw"] == 0.0
            assert b["hosting_capacity_mw"] == 0.0


class TestNeverRaises:
    def test_screen_survives_a_network_with_no_fault_sources(self):
        """A network the fault engine cannot solve must degrade the study to
        "screen not run", not fail the whole hosting-capacity run."""
        comps = [
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
            _comp("gen-1", "generator", {"name": "G", "rated_mva": 5,
                                         "voltage_kv": 11, "x_pp": 0.2,
                                         "is_swing": True}),
            _comp("load-1", "static_load", {"name": "L", "rated_kva": 500,
                                            "power_factor": 0.9}),
        ]
        wires = [_wire("w1", "gen-1", "bus-1"), _wire("w2", "bus-1", "load-1")]
        proj = ProjectData(projectName="hc", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        r = run_hosting_capacity(proj, fault_screen=True, step_mw=1.0,
                                 max_mw_per_bus=2.0)
        assert isinstance(r, dict)
        for b in r.get("buses", []):
            assert b["fault_screen"] in ("ok", "fail", "not_run", "no_capacity")
