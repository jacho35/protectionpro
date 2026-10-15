"""Contingency review fixes (reviews/CONTINGENCY_REVIEW.md)."""
import pytest

from backend.analysis.contingency import run_contingency
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _net(runs=2, load_kva=2000.0, x_per_km=0.05, rated=400.0, second_cable=False):
    """11 kV utility -> cable (num_parallel = runs) -> bus with a unity-pf
    load. Optional second independent cable in parallel."""
    kv = 11.0
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": kv,
                                       "fault_mva": 1000.0}),
        _comp("bus-0", "bus", {"name": "SRC", "voltage_kv": kv}),
        _comp("cable-1", "cable", {"name": "C1", "voltage_kv": kv,
                                   "r_per_km": 0.1, "x_per_km": x_per_km,
                                   "length_km": 1.0, "rated_amps": rated,
                                   "num_parallel": runs}),
        _comp("bus-1", "bus", {"name": "LP", "voltage_kv": kv}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
                                        "power_factor": 1.0,
                                        "demand_factor": 1.0,
                                        "voltage_kv": kv}),
    ]
    wires = [_wire("w0", "utility-1", "bus-0"), _wire("w1", "bus-0", "cable-1"),
             _wire("w2", "cable-1", "bus-1"), _wire("w3", "bus-1", "load-1")]
    if second_cable:
        comps.append(_comp("cable-2", "cable", {
            "name": "C2", "voltage_kv": kv, "r_per_km": 0.1, "x_per_km": x_per_km,
            "length_km": 1.0, "rated_amps": rated}))
        wires += [_wire("w4", "bus-0", "cable-2"), _wire("w5", "cable-2", "bus-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _case(res, cid):
    return next(c for c in res.contingencies if c.id == cid)


def test_parallel_runs_lose_one_run_not_the_bundle():
    """[CT2] Two runs: losing 'the cable' used to island the load. One run
    is lost: the load stays up, the survivor carries it all."""
    res = run_contingency(_net(runs=2))
    c = _case(res, "cable-1")
    assert c.status != "islanded" and c.lost_load_mw == 0.0
    assert "1 of 2 runs" in c.outaged_names
    # a single run IS the whole circuit: losing it islands the load
    res1 = run_contingency(_net(runs=1))
    assert _case(res1, "cable-1").status == "islanded"


def test_survivor_run_loading():
    """Hand: I = 2 MVA / (sqrt3 x 11 kV) = 105 A, all on the surviving 400 A
    run -> ~26 %."""
    c = _case(run_contingency(_net(runs=2, load_kva=2000.0)), "cable-1")
    assert c.max_loading_pct == pytest.approx(100 * 104.97 / 400.0, rel=0.03)


def test_base_violation_not_repeated_in_every_contingency():
    """[CT1] A base-case overload on cable-1 (210 A on a 150 A rating) used
    to be copied into every contingency, so losing one of two redundant
    cables elsewhere read 'violations'. It is now judged on what it adds."""
    kv = 11.0
    net = _net(runs=1, load_kva=4000.0, rated=150.0)
    net.components += [
        _comp("cable-3", "cable", {"name": "C3", "voltage_kv": kv, "r_per_km": 0.1,
                                   "x_per_km": 0.05, "length_km": 1.0,
                                   "rated_amps": 400.0}),
        _comp("cable-4", "cable", {"name": "C4", "voltage_kv": kv, "r_per_km": 0.1,
                                   "x_per_km": 0.05, "length_km": 1.0,
                                   "rated_amps": 400.0}),
        _comp("bus-3", "bus", {"name": "B3", "voltage_kv": kv}),
        _comp("load-3", "static_load", {"name": "L3", "rated_kva": 200.0,
                                        "power_factor": 1.0, "demand_factor": 1.0,
                                        "voltage_kv": kv}),
    ]
    net.wires += [_wire("w6", "bus-0", "cable-3"), _wire("w7", "cable-3", "bus-3"),
                  _wire("w8", "bus-0", "cable-4"), _wire("w9", "cable-4", "bus-3"),
                  _wire("w10", "bus-3", "load-3")]
    res = run_contingency(net)
    assert res.base_violation_count > 0
    c3 = _case(res, "cable-3")
    assert c3.status == "secure"
    assert c3.inherited_violation_count >= 1
    # the element that IS overloaded still reports its own outage correctly
    assert _case(res, "cable-1").status == "islanded"
