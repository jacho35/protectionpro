"""Capacitor placement review (reviews/CAPACITOR_PLACEMENT_REVIEW.md):
the greedy result against exhaustive enumeration on a 3-bus radial feeder."""
import itertools
import pytest

from backend.analysis.capacitor_placement import (
    run_capacitor_placement, _with_banks)
from backend.analysis.loadflow import run_load_flow
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _feeder(loads_kva=(300, 600, 900), pf=0.8, kv=11.0, r=0.8, x=0.4):
    comps = [_comp("utility-1", "utility", {"name": "Grid", "voltage_kv": kv,
                                            "fault_mva": 300.0}),
             _comp("bus-0", "bus", {"name": "B0", "voltage_kv": kv})]
    wires = [_wire("w0", "utility-1", "bus-0")]
    prev = "bus-0"
    for i, l in enumerate(loads_kva, 1):
        comps += [
            _comp(f"cable-{i}", "cable", {"name": f"C{i}", "voltage_kv": kv,
                                          "r_per_km": r, "x_per_km": x,
                                          "length_km": 1.0, "rated_amps": 400}),
            _comp(f"bus-{i}", "bus", {"name": f"B{i}", "voltage_kv": kv}),
            _comp(f"load-{i}", "static_load", {
                "name": f"L{i}", "rated_kva": float(l), "power_factor": pf,
                "demand_factor": 1.0, "voltage_kv": kv})]
        wires += [_wire(f"wa{i}", prev, f"cable-{i}"),
                  _wire(f"wb{i}", f"cable-{i}", f"bus-{i}"),
                  _wire(f"wc{i}", f"bus-{i}", f"load-{i}")]
        prev = f"bus-{i}"
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _loss(p, placed):
    lf = run_load_flow(_with_banks(p, placed) if placed else p, "newton_raphson")
    return sum(max(0.0, b.losses_mw) for b in lf.branches)


@pytest.mark.parametrize("units", [3, 6, 8])
def test_greedy_matches_exhaustive_on_small_feeder(units):
    p, u, buses = _feeder(), 100.0, ["bus-1", "bus-2", "bus-3"]
    best = min(_loss(p, {b: c * u for b, c in zip(buses, combo) if c})
               for combo in itertools.product(range(units + 1), repeat=3)
               if sum(combo) == units)
    r = run_capacitor_placement(p, bus_ids=buses, unit_kvar=u,
                                max_total_kvar=units * u,
                                max_kvar_per_bus=units * u,
                                min_loss_reduction_kw=0.0)
    assert r["optimized"]["losses_mw"] == pytest.approx(best, abs=2e-5)
    assert r["optimized"]["losses_mw"] < r["baseline"]["losses_mw"]
    assert "upper bound" in r["energy_basis"]


def test_annual_saving_is_delta_loss_times_8760():
    r = run_capacitor_placement(_feeder(), unit_kvar=100.0)
    d = r["baseline"]["losses_mw"] - r["optimized"]["losses_mw"]
    assert r["energy_savings_mwh_yr"] == pytest.approx(d * 8760.0, abs=0.2)  # losses reported to 1e-5 MW
