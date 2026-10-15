"""Time-series load flow review (reviews/TIMESERIES_REVIEW.md). References:
a flat profile equals the single-shot load flow at every step; a profiled
load equals the single-shot at demand_factor = multiplier; BESS state of
charge by hand from the dispatched AC power and the one-way efficiency."""
import math
import pytest

from backend.analysis.loadflow import run_load_flow
from backend.analysis.timeseries_loadflow import (
    run_timeseries_loadflow, BUILTIN_PROFILES)
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _proj(vfd_kw=0.0, batt=False, kv=0.4):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": kv,
                                       "fault_mva": 50.0}),
        _comp("cable-1", "cable", {"name": "C", "voltage_kv": kv,
                                   "r_per_km": 0.2, "x_per_km": 0.08,
                                   "length_km": 0.5, "rated_amps": 600}),
        _comp("bus-1", "bus", {"name": "B", "voltage_kv": kv}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": 100.0,
                                        "power_factor": 0.9, "demand_factor": 1.0,
                                        "voltage_kv": kv}),
    ]
    wires = [_wire("w1", "utility-1", "cable-1"), _wire("w2", "cable-1", "bus-1"),
             _wire("w3", "bus-1", "load-1")]
    if vfd_kw:
        comps.append(_comp("vfd-1", "vfd", {
            "name": "D", "rated_kw": vfd_kw, "efficiency": 0.96, "load_pct": 100,
            "displacement_pf": 0.98, "demand_factor": 1.0, "voltage_kv": kv}))
        wires.append(_wire("w5", "bus-1", "vfd-1"))
    if batt:
        comps.append(_comp("battery-1", "battery", {
            "name": "BESS", "voltage_kv": kv, "rated_kva": 100.0,
            "battery_kwh": 100.0, "battery_soc_pct": 100.0,
            "battery_mode": "discharging", "battery_max_discharge_kw": 50.0,
            "battery_max_charge_kw": 50.0, "battery_rt_eff": 0.9025,
            "battery_dod_pct": 100.0}))
        wires.append(_wire("w4", "battery-1", "bus-1"))
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _loss(proj):
    return sum(b.losses_mw for b in run_load_flow(proj, "newton_raphson").branches)


def test_flat_profile_reproduces_single_shot():
    p = _proj()
    ts = run_timeseries_loadflow(p, horizon_hours=4, step_minutes=60,
                                 default_profile="flat")
    single = _loss(p)
    assert ts.losses_mw_series == pytest.approx([single] * 4, abs=1e-5)
    assert ts.total_losses_mwh == pytest.approx(4 * single, abs=1e-4)


def test_profiled_load_equals_single_shot_at_multiplier():
    p = _proj()
    ts = run_timeseries_loadflow(p, horizon_hours=24, step_minutes=60,
                                 default_profile="residential")
    for hr in (3, 18):
        q = _proj()
        q.components[3].props["demand_factor"] = BUILTIN_PROFILES["residential"][hr]
        assert ts.losses_mw_series[hr] == pytest.approx(_loss(q), abs=1e-5)


def test_vfd_follows_its_profile():
    """[TS1] A drive used to run flat at nameplate whatever the profile."""
    p = _proj(vfd_kw=50.0)
    ts = run_timeseries_loadflow(p, horizon_hours=24, step_minutes=60,
                                 default_profile="flat",
                                 profile_overrides={"vfd-1": "commercial"})
    assert ts.profiles_used.get("vfd-1") == "commercial"
    for hr in (3, 12):
        q = _proj(vfd_kw=50.0)
        for c in q.components:
            if c.id == "vfd-1":
                c.props["demand_factor"] = BUILTIN_PROFILES["commercial"][hr]
        assert ts.losses_mw_series[hr] == pytest.approx(_loss(q), abs=1e-5)


def test_battery_soc_by_hand():
    """50 kW AC for one hour at one-way eta = sqrt(0.9025) = 0.95: the DC
    energy drawn is 52.63 kWh of 100 kWh, so SoC falls 100 -> 47.37 %."""
    ts = run_timeseries_loadflow(_proj(batt=True), horizon_hours=2,
                                 step_minutes=60, default_profile="flat")
    bt = ts.battery_trajectories[0]
    assert bt.dispatched_mw[0] == pytest.approx(0.05, abs=1e-4)
    assert bt.soc_pct[0] == pytest.approx(100 - 50 / 0.95, abs=0.01)
