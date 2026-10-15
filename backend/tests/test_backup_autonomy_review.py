"""Backup autonomy review (reviews/BACKUP_AUTONOMY_REVIEW.md). Reference: an
energy balance over the autonomy period."""
import pytest

from backend.analysis.backup_autonomy import run_backup_autonomy
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire

KV = 0.4


def _net(load_kw=20.0, vfd_kw=0.0, gen_kva=0.0, batt=True):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": KV,
                                       "fault_mva": 50.0}),
        _comp("bus-1", "bus", {"name": "B", "voltage_kv": KV}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": load_kw,
              "power_factor": 1.0, "demand_factor": 1.0, "voltage_kv": KV}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "load-1")]
    if batt:
        comps.append(_comp("battery-1", "battery", {
            "name": "BESS", "voltage_kv": KV, "rated_kva": 50.0,
            "battery_kwh": 100.0, "battery_soc_pct": 100.0,
            "battery_dod_pct": 80.0, "battery_rt_eff": 0.9025,
            "battery_max_discharge_kw": 50.0, "battery_max_charge_kw": 50.0}))
        wires.append(_wire("w3", "battery-1", "bus-1"))
    if vfd_kw:
        comps.append(_comp("vfd-1", "vfd", {
            "name": "D", "rated_kw": vfd_kw, "efficiency": 0.96,
            "load_pct": 100, "displacement_pf": 0.98, "demand_factor": 1.0,
            "voltage_kv": KV}))
        wires.append(_wire("w4", "bus-1", "vfd-1"))
    if gen_kva:
        comps.append(_comp("generator-1", "generator", {
            "name": "Genset", "voltage_kv": KV, "rated_mva": gen_kva / 1000.0,
            "power_factor": 0.8}))
        wires.append(_wire("w5", "generator-1", "bus-1"))
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _island(res):
    return next(r for r in res["islands"] if r.get("backed_up"))


def test_autonomy_energy_balance():
    """100 kWh, DoD 80 %, eta_1way = 0.95: 76 kWh usable / 20 kW = 3.8 h."""
    r = _island(run_backup_autonomy(_net()))
    assert r["usable_kwh"] == pytest.approx(76.0, abs=0.01)
    assert r["autonomy_night_h"] == pytest.approx(3.8, abs=0.01)


def test_vfd_load_counts_in_the_island():
    """[BA1] 50 kW shaft at 0.96 eff, dpf 0.98 draws 52.08 kW: the island
    load rises to 72.08 kW and the autonomy falls to 76/72.08 = 1.054 h."""
    r = _island(run_backup_autonomy(_net(vfd_kw=50.0)))
    assert r["load_kw"] == pytest.approx(20.0 + 50.0 / 0.96, abs=0.05)
    assert r["autonomy_night_h"] == pytest.approx(76.0 / (20.0 + 50.0 / 0.96),
                                                  abs=0.01)


def test_generator_backs_up_an_island():
    """[BA2] A genset-only island used to read 'dark' (battery-backed only)."""
    res = run_backup_autonomy(_net(gen_kva=100.0, batt=False))
    r = _island(res)
    assert r["backed_up"] and r["inverter_ok"] and r["power_ok_night"]
    assert r["generator_kw"] == pytest.approx(80.0, abs=0.01)     # 100 kVA x 0.8
    assert r["autonomy_night_h"] is None                           # fuel-set


def test_battery_carries_what_the_generator_cannot():
    """Genset 10 kVA x 0.8 = 8 kW of a 20 kW load: the battery covers 12 kW,
    76 kWh / 12 kW = 6.33 h."""
    r = _island(run_backup_autonomy(_net(gen_kva=10.0)))
    assert r["autonomy_night_h"] == pytest.approx(76.0 / 12.0, abs=0.01)
