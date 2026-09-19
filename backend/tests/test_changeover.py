"""Changeover switch (3-terminal: in_1 / in_2 / out) — analysis/changeover.py.

The analysis routes rewrite each changeover into two-terminal devices before
any engine runs. These tests pin that the load side follows the selected
input in load flow and fault analysis, that "off" isolates it, that the
breaker-pair variant behaves the same, and that the rewrite reaches the
engines through the routes and inside Load Flow Study Manager cases.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire, LoadFlowCasesRequest
from backend.analysis.changeover import expand_changeovers
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.analysis.loadflow_cases import run_loadflow_cases
from backend.analysis.study_manager import run_study_manager


def _comp(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _wire(wid, fc, fp, tc, tp):
    return Wire(id=wid, fromComponent=fc, fromPort=fp, toComponent=tc, toPort=tp)


MAINS_MVA, ALT_MVA, KV = 500.0, 50.0, 11.0


def _network(state="in_1", co_type="ats"):
    """Two independent 11 kV supplies (500 / 50 MVA) on their own buses, a
    changeover selecting between them, and a 1 MW load on the essential bus."""
    return ProjectData(
        projectName="co", baseMVA=100.0, frequency=50,
        components=[
            _comp("utility-1", "utility", {"name": "Mains", "voltage_kv": KV,
                  "fault_mva": MAINS_MVA, "x_r_ratio": 10, "z0_z1_ratio": 1.0}),
            _comp("utility-2", "utility", {"name": "Alt", "voltage_kv": KV,
                  "fault_mva": ALT_MVA, "x_r_ratio": 10, "z0_z1_ratio": 1.0}),
            _comp("bus-m", "bus", {"name": "Mains Bus", "voltage_kv": KV}),
            _comp("bus-a", "bus", {"name": "Alt Bus", "voltage_kv": KV}),
            _comp("bus-e", "bus", {"name": "Essential Bus", "voltage_kv": KV}),
            _comp("co-1", "changeover", {"name": "CO-1", "co_type": co_type,
                  "state": state, "rated_voltage_kv": KV, "rated_current_a": 630}),
            _comp("load-1", "static_load", {"name": "L1", "rated_kva": 1000,
                  "power_factor": 1.0, "voltage_kv": KV}),
        ],
        wires=[
            _wire("w1", "utility-1", "out", "bus-m", "at_0"),
            _wire("w2", "utility-2", "out", "bus-a", "at_0"),
            _wire("w3", "bus-m", "at_0", "co-1", "in_1"),
            _wire("w4", "bus-a", "at_0", "co-1", "in_2"),
            _wire("w5", "co-1", "out", "bus-e", "at_0"),
            _wire("w6", "bus-e", "at_0", "load-1", "in"),
        ],
    )


def _ik3(mva):
    return mva / (math.sqrt(3) * KV)


class TestRewrite:
    def test_selected_input_wired_through_other_on_open_stub(self):
        p = expand_changeovers(_network("in_2"))
        comps = {c.id: c for c in p.components}
        assert comps["co-1"].type == "switch" and comps["co-1"].props["state"] == "closed"
        assert comps["co-1__in_1"].props["state"] == "open"
        wires = {w.id: w for w in p.wires}
        assert (wires["w4"].toComponent, wires["w4"].toPort) == ("co-1", "top")
        assert (wires["w3"].toComponent, wires["w3"].toPort) == ("co-1__in_1", "top")
        assert (wires["w5"].fromComponent, wires["w5"].fromPort) == ("co-1", "bottom")
        assert not any(c.type == "changeover" for c in p.components)

    def test_off_opens_both(self):
        p = expand_changeovers(_network("off"))
        states = {c.id: c.props["state"] for c in p.components if c.id.startswith("co-1")}
        assert states == {"co-1": "open", "co-1__in_2": "open"}

    def test_breaker_pair_rewrites_to_cbs(self):
        p = expand_changeovers(_network("in_1", co_type="breaker_pair"))
        comps = {c.id: c for c in p.components}
        assert comps["co-1"].type == "cb" and comps["co-1__in_2"].type == "cb"
        assert comps["co-1"].props["trip_rating_a"] == 630

    def test_no_changeover_is_identity(self):
        p = _network()
        p = p.model_copy(update={
            "components": [c for c in p.components if c.id != "co-1"],
            "wires": [w for w in p.wires if w.id not in ("w3", "w4", "w5")]})
        assert expand_changeovers(p) is p


class TestLoadFlow:
    @pytest.mark.parametrize("co_type", ["ats", "manual_i_0_ii", "breaker_pair"])
    @pytest.mark.parametrize("state,feeder", [("in_1", "utility-1"), ("in_2", "utility-2")])
    def test_load_fed_from_selected_supply(self, co_type, state, feeder):
        res = run_load_flow(expand_changeovers(_network(state, co_type)))
        assert res.converged
        assert res.buses["bus-e"].energized
        assert res.buses["bus-e"].voltage_pu == pytest.approx(1.0, abs=0.01)
        by_src = {d.source_id: d.dispatched_mw for d in res.dispatch}
        other = "utility-2" if feeder == "utility-1" else "utility-1"
        assert by_src[feeder] == pytest.approx(1.0, rel=0.02)
        assert abs(by_src.get(other, 0.0)) < 1e-3

    def test_off_deenergises_load_side(self):
        res = run_load_flow(expand_changeovers(_network("off")))
        bus = res.buses.get("bus-e")
        assert bus is None or not bus.energized


class TestFault:
    @pytest.mark.parametrize("state,mva", [("in_1", MAINS_MVA), ("in_2", ALT_MVA)])
    def test_essential_bus_fault_level_follows_position(self, state, mva):
        res = run_fault_analysis(expand_changeovers(_network(state)))
        assert res.buses["bus-e"].ik3 == pytest.approx(_ik3(mva), rel=0.02)

    def test_off_no_fault_infeed(self):
        res = run_fault_analysis(expand_changeovers(_network("off")))
        bus = res.buses.get("bus-e")
        assert bus is None or bus.ik3 == pytest.approx(0.0, abs=1e-6)


class TestRoutesAndCases:
    def _route(self, path):
        from backend.routes.analysis import router
        return next(r for r in router.routes if r.path == path)

    def test_route_expands_before_engine(self):
        """The registered handler (route_class wrapper) rewrites the body."""
        res = self._route("/analysis/fault").dependant.call(data=_network("in_2"))
        assert res.buses["bus-e"].ik3 == pytest.approx(_ik3(ALT_MVA), rel=0.02)

    def test_every_analysis_route_is_wrapped(self):
        from backend.routes.analysis import router
        for r in router.routes:
            assert getattr(r.endpoint, "__wrapped__", None) is not None, r.path

    def test_loadflow_cases_expand_each_snapshot(self):
        base = _network("in_1")
        alt = _network("in_2")
        req = LoadFlowCasesRequest(**base.model_dump(), cases=[
            {"id": "c2", "name": "On alternate",
             "components": [c.model_dump() for c in alt.components],
             "wires": [w.model_dump() for w in alt.wires]}])
        expanded = expand_changeovers(req)
        res = run_loadflow_cases(expanded, expanded.cases)
        by_case = {c.id: c for c in res}
        disp = {d.source_id: d.dispatched_mw for d in by_case["c2"].result.dispatch}
        assert disp["utility-2"] == pytest.approx(1.0, rel=0.02)

    def test_study_manager_runs_every_study(self):
        """No engine trips over the rewritten devices or their synthetic ids."""
        out = run_study_manager(expand_changeovers(_network("in_1")))
        failed = {k: v.get("error") for k, v in out["studies"].items()
                  if isinstance(v, dict) and v.get("status") == "error"}
        assert not failed, failed
        assert "bus-e" in out["studies"]["arcflash"]["result"]["buses"]
