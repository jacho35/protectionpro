"""Hosting capacity review (reviews/HOSTING_CAPACITY_REVIEW.md). Hand
reference: a feeder impedance Z = R + jX from an ideal V_s = 1 source; the DER
at the end exports P (unity pf) and V_r = V_s + Z conj(P / V_r); capacity is
the P with |V_r| = v_max. Thermal: S = sqrt(3) V I_rated."""
import math
import pytest

from backend.analysis.hosting_capacity import run_hosting_capacity
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire

KV = 11.0


def _net(rated=9999.0, r=1.2, x=0.6, load_kva=0.0):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": KV,
                                       "fault_mva": 1e6, "x_r_ratio": 1e4}),
        _comp("bus-0", "bus", {"name": "SRC", "voltage_kv": KV}),
        _comp("cable-1", "cable", {"name": "C", "voltage_kv": KV,
                                   "r_per_km": r, "x_per_km": x,
                                   "length_km": 1.0, "rated_amps": rated}),
        _comp("bus-1", "bus", {"name": "END", "voltage_kv": KV}),
    ]
    wires = [_wire("w0", "utility-1", "bus-0"), _wire("w1", "bus-0", "cable-1"),
             _wire("w2", "cable-1", "bus-1")]
    if load_kva:
        comps += [
            _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kva,
                                            "power_factor": 0.9,
                                            "demand_factor": 1.0,
                                            "voltage_kv": KV}),
            _comp("bus-2", "bus", {"name": "OTHER", "voltage_kv": KV}),
        ]
        wires += [_wire("w3", "bus-1", "load-1"), _wire("w4", "bus-0", "bus-2")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _hand_pmax(r, x, vmax=1.05):
    z = complex(r, x) / (KV * KV / 100.0)

    def v_of(p):
        v = complex(1, 0)
        for _ in range(200):
            v = 1 + z * (p / v).conjugate()
        return abs(v)
    lo, hi = 0.0, 5.0
    for _ in range(80):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if v_of(mid) <= vmax else (lo, mid)
    return lo * 100.0


@pytest.mark.parametrize("r,x", [(1.2, 0.6), (2.0, 0.5)])
def test_voltage_rise_limit_matches_hand(r, x):
    row = run_hosting_capacity(_net(r=r, x=x), bus_ids=["bus-1"],
                               fault_screen=False,
                               max_mw_per_bus=50.0)["buses"][0]
    assert row["limiting_factor"] == "overvoltage"
    assert row["hosting_capacity_mw"] == pytest.approx(_hand_pmax(r, x), rel=2e-3)


def test_thermal_limit_matches_hand():
    row = run_hosting_capacity(_net(rated=100.0, r=0.1, x=0.05),
                               bus_ids=["bus-1"], fault_screen=False,
                               max_mw_per_bus=50.0)["buses"][0]
    assert row["limiting_factor"] == "overload"
    assert row["hosting_capacity_mw"] == pytest.approx(
        math.sqrt(3) * KV * 0.1, rel=0.01)


def test_preexisting_violation_elsewhere_is_not_charged_to_the_der():
    """[HC1] A 9 MVA load drags END below 0.95 pu in the base case. Every
    candidate bus used to report 0 MW 'baseline violation'; the unaffected
    buses now get their own capacity and END gets what the DER adds."""
    res = run_hosting_capacity(_net(load_kva=9000.0), fault_screen=False,
                               max_mw_per_bus=20.0)
    by = {b["bus_id"]: b for b in res["buses"]}
    assert all(b["limiting_factor"] != "baseline_violation" for b in by.values())
    assert by["bus-2"]["hosting_capacity_mw"] == pytest.approx(20.0)
    assert by["bus-1"]["hosting_capacity_mw"] > 5.0
    assert any("already has" in w for w in res["warnings"])
