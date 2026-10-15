"""Voltage stability review (reviews/VOLTAGE_STABILITY_REVIEW.md). Hand
reference: a lossless line of reactance X from an ideal V_s = 1 source to a
constant-PQ load. Nose: P_max = (1 - sin phi) / (2 X cos phi) (lagging pf).
Q-V (net injection at the load bus): Q(V) = (V^2 - sqrt(V^2 - (P X)^2)) / X,
bottom at V*^2 = 1/4 + (P X)^2."""
import math
import pytest

from backend.analysis.voltage_stability import run_voltage_stability
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _net(load="static_load", pf=1.0, p_mw=10.0, x_pu=0.5, kv=11.0):
    zb = kv * kv / 100.0                      # ohm on 100 MVA
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": kv,
                                       "fault_mva": 100000.0, "x_r_ratio": 1e4}),
        _comp("cable-1", "cable", {"name": "C", "voltage_kv": kv,
                                   "r_per_km": 0.0, "x_per_km": x_pu * zb,
                                   "length_km": 1.0, "rated_amps": 99999}),
        _comp("bus-1", "bus", {"name": "LP", "voltage_kv": kv}),
    ]
    if load == "static_load":
        comps.append(_comp("load-1", "static_load", {
            "name": "L", "rated_kva": p_mw * 1000 / pf, "power_factor": pf,
            "demand_factor": 1.0, "voltage_kv": kv}))
    else:
        comps.append(_comp("load-1", "vfd", {
            "name": "D", "rated_kw": p_mw * 1000 * 0.96, "efficiency": 0.96,
            "load_pct": 100, "displacement_pf": pf, "demand_factor": 1.0,
            "voltage_kv": kv}))
    wires = [_wire("w1", "utility-1", "cable-1"),
             _wire("w2", "cable-1", "bus-1"), _wire("w3", "bus-1", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _pmax_mw(x, pf):
    return (1 - math.sqrt(1 - pf * pf)) / (2 * x * pf) * 100.0


@pytest.mark.parametrize("pf", [1.0, 0.95, 0.9, 0.8])
def test_nose_matches_closed_form(pf):
    r = run_voltage_stability(_net(pf=pf), step=0.5, lambda_max=20.0)
    assert r.collapsed
    assert r.lambda_critical == pytest.approx(_pmax_mw(0.5, pf) / 10.0, rel=2e-3)


def test_vfd_load_is_scaled_and_counted():
    """[VS1] A VFD-only network reported base load 0 MW and 'no collapse'."""
    r = run_voltage_stability(_net(load="vfd", pf=0.98), step=0.5, lambda_max=20.0)
    assert r.base_load_mw == pytest.approx(10.0, rel=1e-3)
    assert r.collapsed
    assert r.lambda_critical == pytest.approx(_pmax_mw(0.5, 0.98) / 10.0, rel=2e-3)


def test_qv_curve_and_margin():
    """[VS2] Curve matches the hand formula; the margin is measured from the
    zero-injection operating point to the bottom (~49.5 MVAr), not from the
    first swept setpoint under it."""
    p, x = 0.1, 0.5
    r = run_voltage_stability(_net(p_mw=10.0, x_pu=x), step=0.5, lambda_max=20.0)
    for pt in r.qv_curve:
        if pt.v_pu > p * x:
            ref = (pt.v_pu ** 2 - math.sqrt(pt.v_pu ** 2 - (p * x) ** 2)) / x * 100
            assert pt.q_mvar == pytest.approx(ref, abs=0.01)
    v_star = math.sqrt(0.25 + (p * x) ** 2)
    q_star = (v_star ** 2 - 0.5) / x * 100          # about -49.5 MVAr
    assert r.qv_min_mvar == pytest.approx(q_star, abs=0.1)
    assert r.qv_operating_mvar == pytest.approx(0.0, abs=0.05)
    assert r.qv_margin_mvar == pytest.approx(-q_star, abs=0.1)
