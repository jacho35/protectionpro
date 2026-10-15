"""Load Flow Study Manager review (reviews/LOADFLOW_CASES_REVIEW.md): each
case equals a standalone run_load_flow; the input project is not mutated."""
import json
import pytest

from backend.analysis.loadflow import run_load_flow
from backend.analysis.loadflow_cases import run_loadflow_cases
from backend.models.schemas import ProjectData, LoadFlowCaseInput
from backend.tests.test_regression import _comp, _wire


def _net(load_kva, tap_mode="regulating"):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
                                       "fault_mva": 150.0}),
        _comp("bus-1", "bus", {"name": "HV", "voltage_kv": 11.0}),
        _comp("transformer-1", "transformer", {
            "name": "T", "rated_mva": 2.0, "voltage_hv_kv": 11.0,
            "voltage_lv_kv": 0.4, "z_percent": 6.0, "x_r_ratio": 8.0,
            "tap_mode": tap_mode, "tap_percent": 0.0, "tap_step_pct": 1.25,
            "tap_min_pct": -10, "tap_max_pct": 10,
            "regulated_bus_id": "bus-2", "v_target_pu": 1.0}),
        _comp("bus-2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
                                        "power_factor": 0.85,
                                        "demand_factor": 1.0, "voltage_kv": 0.4}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "transformer-1"),
             _wire("w3", "transformer-1", "bus-2"), _wire("w4", "bus-2", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _case(cid, p):
    return LoadFlowCaseInput(id=cid, name=cid, components=p.components,
                             wires=p.wires, baseMVA=100.0)


def _standalone(p):
    r = run_load_flow(ProjectData(**json.loads(p.model_dump_json())),
                      "newton_raphson")
    return (min(b.voltage_pu for b in r.buses.values() if b.energized),
            sum(b.losses_mw for b in r.branches))


def test_each_case_equals_standalone_and_input_is_untouched():
    live, a, b = _net(500.0), _net(1500.0), _net(200.0)
    before = json.dumps([c.props for c in live.components], sort_keys=True,
                        default=str)
    out = run_loadflow_cases(live, [_case("A", a), _case("B", b)])
    assert json.dumps([c.props for c in live.components], sort_keys=True,
                      default=str) == before
    for res, p in zip(out, [live, a, b]):
        vmin, loss = _standalone(p)
        assert res.summary.min_v_pu == pytest.approx(vmin, abs=1e-4)
        assert res.summary.total_losses_mw == pytest.approx(loss, abs=1e-4)


def test_snapshot_without_wires_is_not_mixed_with_live_wires():
    """[LC1] A case with components and an empty wire list used the LIVE
    network's wires, so an unconnected snapshot read as a healthy network."""
    live, b = _net(500.0), _net(200.0)
    out = run_loadflow_cases(
        live, [LoadFlowCaseInput(id="NW", name="no wires",
                                 components=b.components, wires=[])],
        include_current=False)[0]
    assert out.summary.deenergized_bus_count >= 1
