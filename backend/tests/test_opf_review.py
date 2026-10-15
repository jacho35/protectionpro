"""OPF review (reviews/OPF_REVIEW.md): merit order by hand, and the Volt/VAR
hill climb against exhaustive enumeration of a tap x bank feeder."""
import itertools
import json
import pytest

from backend.analysis.loadflow import run_load_flow
from backend.analysis.optimal_powerflow import run_opf, _metrics, _score
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _dispatch_net(load_kva=12000.0, pri=(1, 2, 3)):
    kv = 11.0
    comps = [
        _comp("bus-1", "bus", {"name": "B", "voltage_kv": kv}),
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": kv,
              "fault_mva": 500.0, "cost_per_mwh": 100.0, "dispatch_priority": pri[0]}),
        _comp("generator-1", "generator", {"name": "GenA", "voltage_kv": kv,
              "rated_mva": 6.0, "power_factor": 1.0, "cost_per_mwh": 60.0,
              "dispatch_priority": pri[1], "dispatch_mode": "merit_order"}),
        _comp("generator-2", "generator", {"name": "GenB", "voltage_kv": kv,
              "rated_mva": 4.0, "power_factor": 1.0, "cost_per_mwh": 80.0,
              "dispatch_priority": pri[2], "dispatch_mode": "merit_order"}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
              "power_factor": 1.0, "demand_factor": 1.0, "voltage_kv": kv}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "generator-1", "bus-1"),
             _wire("w3", "generator-2", "bus-1"), _wire("w4", "load-1", "bus-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def test_merit_order_dispatch_by_hand():
    """12 MW: A (60) 6, B (80) 4, grid (100) 2 -> 6*60 + 4*80 + 2*100 = 880 /h,
    from a baseline that ranked the units in the wrong order."""
    r = run_opf(_dispatch_net(pri=(1, 3, 2)), use_capacitors=False,
                use_taps=False, use_setpoints=False)
    assert r["optimized"]["cost_per_h"] == pytest.approx(880.0, abs=0.5)
    assert r["optimized"]["cost_per_h"] <= r["baseline"]["cost_per_h"]


def _vvar_net(load_kva):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
              "fault_mva": 200.0, "v_setpoint_pu": 1.0}),
        _comp("bus-1", "bus", {"name": "HV", "voltage_kv": 11.0}),
        _comp("transformer-1", "transformer", {"name": "T", "rated_mva": 2.0,
              "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4, "z_percent": 6.0,
              "x_r_ratio": 8.0, "tap_percent": 0.0}),
        _comp("bus-2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        _comp("cable-1", "cable", {"name": "C", "voltage_kv": 0.4,
              "r_per_km": 0.1, "x_per_km": 0.05, "length_km": 0.3,
              "rated_amps": 2000}),
        _comp("bus-3", "bus", {"name": "END", "voltage_kv": 0.4}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
              "power_factor": 0.8, "demand_factor": 1.0, "voltage_kv": 0.4}),
        _comp("cap-1", "capacitor_bank", {"name": "CAP", "voltage_kv": 0.4,
              "rated_kvar": 600.0, "steps": 3, "steps_in_service": 3}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "transformer-1"),
             _wire("w3", "transformer-1", "bus-2"), _wire("w4", "bus-2", "cable-1"),
             _wire("w5", "cable-1", "bus-3"), _wire("w6", "bus-3", "load-1"),
             _wire("w7", "bus-3", "cap-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


@pytest.mark.parametrize("load_kva", [400.0, 800.0])
def test_volt_var_matches_exhaustive(load_kva):
    """[OPF-2] At 400 kVA the single-step climb stopped at the start point
    (42.5 kW): every neighbour either creates a violation or costs losses.
    The optimum (tap -5 %, one bank step) is 20.6 kW — two coordinated moves."""
    p = _vvar_net(load_kva)
    best = None
    for tap, steps in itertools.product(
            [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10], range(4)):
        q = ProjectData(**json.loads(p.model_dump_json()))
        for c in q.components:
            if c.id == "transformer-1":
                c.props["tap_percent"] = tap
            if c.id == "cap-1":
                c.props["steps_in_service"] = steps
        lf = run_load_flow(q, "newton_raphson")
        if not lf.converged:
            continue
        cost, loss, viol = _metrics(lf, {c.id: c for c in q.components},
                                    0.95, 1.05, 100.0)
        sc = _score(cost, loss, viol, "loss")
        if best is None or sc < best:
            best = sc
    r = run_opf(p, objective="loss", use_dispatch=False, use_setpoints=False)
    assert len(r["optimized"]["violations"]) == best[0]
    assert r["optimized"]["losses_mw"] == pytest.approx(best[2], abs=2e-4)
    assert r["optimized"]["losses_mw"] <= r["baseline"]["losses_mw"] + 1e-9
