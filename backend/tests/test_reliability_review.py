"""Reliability review fixes (reviews/RELIABILITY_REVIEW.md). Hand FMEA
references: IEEE 1366 definitions, Billinton & Allan radial method."""
import pytest

from backend.analysis.reliability import run_reliability
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _project(extra=(), extra_wires=(), load_kva=1000.0):
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
            "failure_rate_per_yr": 1.0, "repair_time_h": 2.0}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11.0,
                               "failure_rate_per_yr": 0.0}),
        _comp("static_load-1", "static_load", {
            "name": "L1", "rated_kva": load_kva, "power_factor": 1.0,
            "demand_factor": 1.0, "voltage_kv": 11.0, "customers": 100}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"),
             _wire("w2", "bus-1", "static_load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps + list(extra),
                       wires=wires + list(extra_wires))


def _saifi(proj):
    return run_reliability(proj)["indices"]["saifi"]


def test_utility_only_baseline():
    r = run_reliability(_project())["indices"]
    assert r["saifi"] == pytest.approx(1.0)       # λ = 1/yr over all customers
    assert r["saidi_h"] == pytest.approx(2.0)     # r = 2 h
    assert r["eens_mwh_yr"] == pytest.approx(1.0 * 2.0 * 1.0)


def test_small_pv_does_not_hold_up_the_network():
    """[RL1] 5 kW PV on a 1 MW bus used to cancel every utility outage."""
    pv = [_comp("solar_pv-1", "solar_pv", {
        "name": "PV", "voltage_kv": 11.0, "rated_kw": 5.0,
        "failure_rate_per_yr": 0.0})]
    assert _saifi(_project(pv, [_wire("w3", "solar_pv-1", "bus-1")])) \
        == pytest.approx(1.0)


def test_generator_covers_load_only_if_large_enough():
    def gen(mva):
        return [_comp("generator-1", "generator", {
            "name": "G", "voltage_kv": 11.0, "rated_mva": mva,
            "power_factor": 0.9, "failure_rate_per_yr": 0.0})]
    w = [_wire("w3", "generator-1", "bus-1")]
    assert _saifi(_project(gen(2.0), w)) == pytest.approx(0.0)   # 1.8 MW ≥ 1 MW
    assert _saifi(_project(gen(1.0), w)) == pytest.approx(1.0)   # 0.9 MW < 1 MW


def test_pv_without_battery_is_not_firm_but_hybrid_with_battery_is():
    hybrid = [_comp("solar_pv-1", "solar_pv", {
        "name": "PV", "voltage_kv": 11.0, "rated_kw": 2000.0,
        "inverter_type": "hybrid", "battery_kwh": 4000.0,
        "battery_max_discharge_kw": 1500.0, "failure_rate_per_yr": 0.0})]
    w = [_wire("w3", "solar_pv-1", "bus-1")]
    assert _saifi(_project(hybrid, w)) == pytest.approx(0.0)
    hybrid[0].props["battery_kwh"] = 0.0
    assert _saifi(_project(hybrid, w)) == pytest.approx(1.0)
