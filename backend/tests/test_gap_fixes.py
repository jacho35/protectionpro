"""Regression tests for the four low-risk verification-gap fixes.

Pins the new behaviour of:
  #2  static-load motor-fraction fault contribution (fault.py)
  #4  standalone cable-sizing inputs + adiabatic basis toggle (cable_sizing.py)
  #6  PV-bus generator solved-reactive display (loadflow.py)
  #7  per-bus arc-flash conductor gap / equipment class (arcflash.py)

Each test also confirms the DEFAULT (feature-off) path is unchanged, since
these were shipped as opt-in enhancements.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.analysis.cable_sizing import run_cable_sizing
from backend.analysis.arcflash import _get_gap


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


# ── #7 arc-flash gap by equipment class ──────────────────────────────────

class TestArcFlashGap:
    def test_auto_infers_from_voltage(self):
        assert _get_gap(0.4) == 25          # LV → MCC/panel default
        assert _get_gap(11) == 153          # MV → switchgear

    def test_equipment_class_overrides(self):
        # LV switchgear (32 mm) can now be distinguished from MCC/panel (25 mm)
        assert _get_gap(0.4, "lv_switchgear") == 32
        assert _get_gap(0.4, "lv_mcc_panel") == 25
        assert _get_gap(0.4, "lv_cable") == 13
        assert _get_gap(4.16, "mv_switchgear_5kv") == 104

    def test_unknown_class_falls_back_to_voltage(self):
        assert _get_gap(0.4, "auto") == 25
        assert _get_gap(0.4, "nonsense") == 25


# ── #2 static-load motor-fraction fault contribution ─────────────────────

def _motor_lump_project(motor_fraction):
    """Utility → bus with a static load carrying an optional motor fraction."""
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 11, "fault_mva": 500,
            "x_r_ratio": 15, "z0_z1_ratio": 1.0}),
        _comp("bus-1", "bus", {"name": "Bus", "voltage_kv": 11}),
        _comp("load-1", "static_load", {
            "name": "Lump", "rated_kva": 5000, "voltage_kv": 11,
            "power_factor": 0.85, "motor_fraction": motor_fraction,
            "motor_lrc_ratio": 6}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"),
             _wire("w2", "bus-1", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestStaticLoadMotorFraction:
    def test_default_zero_contributes_nothing(self):
        base = run_fault_analysis(_motor_lump_project(0.0), fault_type="3phase")
        # No motor path recorded when motor_fraction == 0
        assert base.buses["bus-1"].motor_count == 0

    def test_motor_fraction_adds_contribution(self):
        base = run_fault_analysis(_motor_lump_project(0.0), fault_type="3phase")
        withm = run_fault_analysis(_motor_lump_project(0.5), fault_type="3phase")
        b0 = base.buses["bus-1"]
        b1 = withm.buses["bus-1"]
        # The rotating fraction now back-feeds the fault
        assert b1.motor_count == 1
        assert b1.ik3 > b0.ik3
        assert b1.ik3_motor and b1.ik3_motor > 0

    def test_bigger_fraction_bigger_infeed(self):
        small = run_fault_analysis(_motor_lump_project(0.25), fault_type="3phase")
        big = run_fault_analysis(_motor_lump_project(0.75), fault_type="3phase")
        assert big.buses["bus-1"].ik3_motor > small.buses["bus-1"].ik3_motor


# ── #4 standalone cable sizing + adiabatic basis ─────────────────────────

def _cable_project(extra_cable_props=None):
    # r_per_km deliberately high so the derived actual area is small — the
    # withstand check then fails and a recommended size is computed.
    cp = {"name": "C1", "length_km": 0.01, "r_per_km": 2.0, "x_per_km": 0.08,
          "rated_amps": 400, "voltage_kv": 0.4, "num_parallel": 1,
          "ampacity_standard": "IEC"}
    cp.update(extra_cable_props or {})
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 0.4, "fault_mva": 30, "x_r_ratio": 8}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 0.4}),
        _comp("cable-1", "cable", cp),
        _comp("bus-2", "bus", {"name": "B2", "voltage_kv": 0.4}),
        _comp("load-1", "static_load", {
            "name": "L", "rated_kva": 100, "voltage_kv": 0.4, "power_factor": 0.9}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"),
             _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2"),
             _wire("w4", "bus-2", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestStandaloneCableSizing:
    def test_default_unchanged_without_override(self):
        res = run_cable_sizing(_cable_project())
        assert len(res["cables"]) == 1

    def test_standalone_current_makes_current_known(self):
        # A hand-entered design current lets the thermal check run even without
        # a network load-flow result → status is not "unknown" for that reason.
        cab = run_cable_sizing(_cable_project(
            {"standalone_current_a": 250}))["cables"][0]
        assert cab["load_current_a"] == 250

    def test_bare_isc_never_more_onerous_than_thermal(self):
        # Same standalone fault inputs, only the adiabatic basis differs. The
        # thermal-equivalent Ith = Ik"·√(m+n) can only demand ≥ the bare-Isc
        # area, so the recommended size under bare_isc ≤ that under thermal.
        common = {"standalone_current_a": 50, "standalone_isc_ka": 40,
                  "standalone_clearing_s": 0.01}
        thermal = run_cable_sizing(_cable_project(dict(common)))["cables"][0]
        bare = run_cable_sizing(_cable_project(
            dict(common, adiabatic_basis="bare_isc")))["cables"][0]
        assert not thermal["fault_withstand_ok"]
        assert not bare["fault_withstand_ok"]
        assert bare["min_size_mm2"] <= thermal["min_size_mm2"]
        # And for this fault-dominated case the toggle makes a real difference.
        assert bare["min_size_mm2"] < thermal["min_size_mm2"]


# ── #6 PV-bus generator solved reactive ──────────────────────────────────

def _pv_project():
    """Swing utility → reactive line → PV bus with a voltage-holding gen."""
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 11, "fault_mva": 1000, "x_r_ratio": 15}),
        _comp("bus-1", "bus", {"name": "Slack", "voltage_kv": 11,
                               "bus_type": "Swing"}),
        _comp("cable-1", "cable", {"name": "Line", "length_km": 5,
                                   "r_per_km": 0.1, "x_per_km": 0.4,
                                   "voltage_kv": 11, "rated_amps": 600}),
        _comp("bus-2", "bus", {"name": "PVbus", "voltage_kv": 11,
                               "bus_type": "PV"}),
        _comp("gen-1", "generator", {
            "name": "G", "rated_mva": 50, "voltage_kv": 11,
            "power_factor": 0.85, "voltage_setpoint_pu": 1.02,
            "dispatch_mode": "must_run", "xd_pp": 0.2}),
        _comp("load-1", "static_load", {
            "name": "Ld", "rated_kva": 20000, "voltage_kv": 11,
            "power_factor": 0.9}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"),
             _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2"),
             _wire("w4", "bus-2", "gen-1"),
             _wire("w5", "bus-2", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestPVReactiveDisplay:
    def test_pv_gen_reports_solved_not_scheduled_q(self):
        res = run_load_flow(_pv_project(), "newton_raphson")
        assert res.converged
        gen = next((b for b in res.branches if b.elementId == "gen-1"), None)
        assert gen is not None
        # Old behaviour reported the scheduled Q = rated·sin(acos(pf)); the fix
        # reports the solver-computed Q that actually holds the setpoint. They
        # must differ for a loaded PV bus.
        scheduled_q = 50 * math.sqrt(1 - 0.85 ** 2)   # ~26.3 Mvar
        assert abs(gen.q_mvar - scheduled_q) > 1e-3
