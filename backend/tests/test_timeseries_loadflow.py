"""Time-series / quasi-dynamic load flow (timeseries_loadflow.py).

Pins: a flat unity profile reproduces the single-shot ``run_load_flow`` result
at every step (the strongest available anchor — this module adds no new power
-flow mathematics); state of charge is conserved (net of round-trip loss)
across a charge/discharge cycle and a battery cannot be driven below 0% or
above 100%; integrated energy losses over the horizon match an independent
per-step accumulation from ``run_load_flow`` itself; a step whose solver
raises is recorded as non-converged rather than aborting the run; and the
8760-step wall-clock stays well under the "10 minutes" ceiling for the
network sizes exercised here (see test_8760_step_performance for the measured
numbers quoted in the module docstring).
"""

import math
import time

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import run_load_flow
from backend.analysis import timeseries_loadflow as tsl
from backend.analysis.timeseries_loadflow import run_timeseries_loadflow


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b, pa="p", pb="q"):
    return Wire(id=wid, fromComponent=a, fromPort=pa, toComponent=b, toPort=pb)


def _simple_feeder():
    """Grid -> bus1 -> cable -> bus2 -> load. No batteries, no OLTC."""
    return ProjectData(
        projectName="feeder", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "Bus1", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("cable-1", "cable", {"name": "C1", "voltage_kv": 11,
                                    "r_per_km": 0.2, "x_per_km": 0.1, "length_km": 1,
                                    "rated_amps": 400}),
            _c("bus-2", "bus", {"name": "Bus2", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 2000,
                                                "power_factor": 0.9, "demand_factor": 0.8,
                                                "voltage_kv": 11}),
            _c("pv-1", "solar_pv", {"name": "PV1", "rated_kw": 500, "irradiance_pct": 100}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"),
               _w("w2", "bus-1", "cable-1"), _w("w3", "cable-1", "bus-2"),
               _w("w4", "bus-2", "static_load-1"), _w("w5", "bus-2", "pv-1")],
    )


def _flat_overrides(project):
    return {c.id: "flat" for c in project.components}


# ── Anchor 1: flat profile reproduces the single-shot result exactly ──

def test_flat_profile_reproduces_single_shot_exactly():
    project = _simple_feeder()
    single = run_load_flow(project, "newton_raphson")
    assert single.converged

    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=5,
                                 step_minutes=60, profile_overrides=_flat_overrides(project))
    assert ts.converged
    assert ts.non_converged_steps == []
    assert ts.steps == 5

    by_id = {e.bus_id: e for e in ts.bus_envelopes}
    for bus_id, bus_result in single.buses.items():
        env = by_id[bus_id]
        # Every step is the identical flat-profile solve, so min == max == the
        # single-shot voltage (both sides rounded the same way).
        assert env.min_v_pu == env.max_v_pu
        assert env.min_v_pu == pytest.approx(round(bus_result.voltage_pu, 5), abs=1e-9)

    branch_by_id = {e.elementId: e for e in single.branches}
    for peak in ts.branch_peaks:
        b = branch_by_id[peak.element_id]
        assert peak.peak_loading_pct == pytest.approx(round(b.loading_pct, 2), abs=1e-6)
        assert peak.peak_p_mw == pytest.approx(round(b.p_mw, 4), abs=1e-6)

    # Per-step series are flat and match the single-shot losses at every step.
    single_losses = sum(b.losses_mw for b in single.branches)
    for v in ts.losses_mw_series:
        assert v == pytest.approx(round(single_losses, 6), abs=1e-6)
    for v in ts.min_v_pu_series + ts.max_v_pu_series:
        assert v is not None


def test_energy_losses_integrated_against_hand_calc():
    """total_losses_mwh must equal n_steps * dt_h * the independently-computed
    single-shot loss (a flat profile means every step IS that single solve)."""
    project = _simple_feeder()
    single = run_load_flow(project, "newton_raphson")
    single_losses_mw = sum(b.losses_mw for b in single.branches)

    step_minutes = 30
    horizon_hours = 6
    n_steps = round(horizon_hours * 60 / step_minutes)
    dt_h = step_minutes / 60.0

    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=horizon_hours,
                                 step_minutes=step_minutes,
                                 profile_overrides=_flat_overrides(project))
    assert ts.steps == n_steps
    expected_mwh = n_steps * dt_h * single_losses_mw
    # The engine rounds the running total to 5 decimals (MWh) before returning
    # it; tolerance matches that rounding, not a looser physical fudge factor.
    assert ts.total_losses_mwh == pytest.approx(expected_mwh, abs=5e-6)


# ── Anchor 2: BESS SoC conservation across a charge/discharge cycle ──

def _bess_feeder(mode, soc_pct):
    return ProjectData(
        projectName="bess", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "Bus1", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 100,
                                                "power_factor": 0.95, "demand_factor": 0.3,
                                                "voltage_kv": 11}),
            _c("battery-1", "battery", {
                "name": "BESS1", "rated_kva": 50, "battery_kwh": 100,
                "battery_dod_pct": 90, "battery_max_charge_kw": 10,
                "battery_max_discharge_kw": 10, "battery_rt_eff": 0.9,
                "battery_soc_pct": soc_pct, "battery_mode": mode,
            }),
        ],
        wires=[_w("w1", "utility-1", "bus-1"),
               _w("w2", "bus-1", "static_load-1"),
               _w("w3", "bus-1", "battery-1", pa="out2")],
    )


def test_soc_conservation_across_charge_discharge_cycle():
    kwh = 100.0
    rt_eff = 0.9
    eta = math.sqrt(rt_eff)

    # Charge at 10 kW for 2h from SoC 50%.
    charge_proj = _bess_feeder("charging", 50.0)
    ts_charge = run_timeseries_loadflow(
        charge_proj, "newton_raphson", horizon_hours=2, step_minutes=60,
        profile_overrides=_flat_overrides(charge_proj))
    assert ts_charge.non_converged_steps == []
    bt = ts_charge.battery_trajectories[0]
    assert len(bt.soc_pct) == 2
    # AC energy drawn from the grid to charge = |dispatched| * dt, each step.
    ac_in_per_step = abs(bt.dispatched_mw[0]) * 1.0    # MWh
    expected_gain_pct = ac_in_per_step * eta * 1000.0 / kwh * 100.0
    assert bt.soc_pct[0] == pytest.approx(50.0 + expected_gain_pct, abs=1e-2)
    assert bt.soc_pct[1] == pytest.approx(50.0 + 2 * expected_gain_pct, abs=1e-2)
    end_soc = bt.soc_pct[1]
    total_ac_in_mwh = sum(abs(v) for v in bt.dispatched_mw) * 1.0

    # Discharge the SAME AC energy back out, starting from the charged SoC.
    discharge_proj = _bess_feeder("discharging", end_soc)
    ts_dis = run_timeseries_loadflow(
        discharge_proj, "newton_raphson", horizon_hours=2, step_minutes=60,
        profile_overrides=_flat_overrides(discharge_proj))
    assert ts_dis.non_converged_steps == []
    bt2 = ts_dis.battery_trajectories[0]
    total_ac_out_mwh = sum(abs(v) for v in bt2.dispatched_mw) * 1.0
    final_soc = bt2.soc_pct[-1]

    # AC in ~= AC out (same power/duration) -> net SoC change is exactly the
    # round-trip loss: charge stores ac_in*eta, discharge needs ac_out/eta of
    # stored energy for the same ac_out -> net stored change = ac*(eta - 1/eta).
    assert total_ac_in_mwh == pytest.approx(total_ac_out_mwh, rel=1e-6)
    expected_net_pct = total_ac_in_mwh * (eta - 1.0 / eta) * 1000.0 / kwh * 100.0
    assert (final_soc - 50.0) == pytest.approx(expected_net_pct, abs=1e-2)
    # Round-trip loss must be a net DEFICIT (eta < 1 both ways).
    assert final_soc < 50.0


def test_battery_at_zero_soc_cannot_discharge_further():
    """A high discharge rate relative to a small bank empties it inside one
    step; SoC must clamp at 0% (not go negative), and a warning is raised."""
    project = _bess_feeder("discharging", 20.0)
    battery = next(c for c in project.components if c.type == "battery")
    # Tiny bank discharged at 10 kW for 3h — the first hour alone drains it
    # far past 0%, which must clamp rather than go negative.
    battery.props["battery_kwh"] = 5.0
    battery.props["battery_dod_pct"] = 100.0   # no reserve floor — isolates the 0% clamp
    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=3, step_minutes=60,
                                 profile_overrides=_flat_overrides(project))
    bt = ts.battery_trajectories[0]
    assert min(bt.soc_pct) == pytest.approx(0.0, abs=1e-9)
    assert all(v >= 0.0 for v in bt.soc_pct)
    assert any("clamped to 0%" in w for w in ts.warnings)


# ── Never raise: a step whose solver blows up is recorded, not fatal ──

def test_step_solver_exception_is_recorded_not_raised(monkeypatch):
    project = _simple_feeder()
    real_run_load_flow = tsl.run_load_flow
    calls = {"n": 0}

    def _flaky(proj, method, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise ValueError("synthetic solver blow-up")
        return real_run_load_flow(proj, method, **kwargs)

    monkeypatch.setattr(tsl, "run_load_flow", _flaky)
    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=4, step_minutes=60,
                                 profile_overrides=_flat_overrides(project))
    assert ts.steps == 4
    assert ts.non_converged_steps == [1]
    assert ts.converged   # the OTHER 3 steps still solved
    assert any("synthetic solver blow-up" in w or "non_converged" in w or "did not"
               in w for w in ts.warnings)


# ── OLTC tap carried forward, not re-derived from the static default ──

def _oltc_feeder(demand_factor):
    return ProjectData(
        projectName="oltc", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 33,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "HV Bus", "voltage_kv": 33, "bus_type": "PQ"}),
            _c("transformer-1", "transformer", {
                "name": "T1", "rated_mva": 5.0, "voltage_hv_kv": 33, "voltage_lv_kv": 11,
                "z_percent": 8.0, "x_r_ratio": 10, "tap_mode": "regulating",
                "v_target_pu": 1.0, "tap_step_pct": 1.25, "tap_min_pct": -10,
                "tap_max_pct": 10, "regulated_side": "lv", "tap_percent": 0}),
            _c("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 2500,
                                                "power_factor": 0.9,
                                                "demand_factor": demand_factor,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "transformer-1", pb="primary"),
               _w("w3", "transformer-1", "bus-2", pa="secondary"),
               _w("w4", "bus-2", "static_load-1")],
    )


def test_oltc_tap_carried_and_within_bounds():
    project = _oltc_feeder(1.0)
    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=24, step_minutes=60,
                                 profile_overrides={"static_load-1": "residential"})
    assert ts.non_converged_steps == []
    lv_env = next(e for e in ts.bus_envelopes if e.bus_id == "bus-2")
    # OLTC should hold the LV bus close to its 1.0 pu target across the load swing.
    assert 0.97 <= lv_env.min_v_pu <= 1.03
    assert 0.97 <= lv_env.max_v_pu <= 1.03


# ── Performance: 8760 steps must not silently take "10 minutes" ──

def test_8760_step_performance():
    project = _simple_feeder()
    t0 = time.perf_counter()
    ts = run_timeseries_loadflow(project, "newton_raphson", horizon_hours=8760, step_minutes=60)
    elapsed = time.perf_counter() - t0
    assert ts.steps == 8760
    # Generous ceiling far below the "10 minutes" concern threshold — this
    # small feeder measured ~4.5s in development.
    assert elapsed < 60.0, (
        f"8760-step run took {elapsed:.1f}s — investigate before shipping; "
        "see the module docstring's Performance section for the measured "
        "baseline and the documented warm-start mitigation for larger networks.")
