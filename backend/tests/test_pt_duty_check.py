"""[PS-16 residual] "PT parameters are used in no calculation" — tests for
the PT burden/accuracy-class adequacy check added to
backend/analysis/duty_check.py.

For every PT with an associated relay (relay.associated_pt), flags whether
the actual connected secondary burden (relays + meters) sits within the
IEC 61869-3 25-100%-of-rated-burden band that guarantees the declared
accuracy class. A PT with no connected_burden_va specified is not checked
at all (legacy behaviour — absent prop, no output, byte-identical to the
pre-fix fully-decorative PT).

Run with:  python -m pytest backend/tests/test_pt_duty_check.py -v
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.duty_check import run_duty_check


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires):
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=components, wires=wires)


def _utility(fault_mva=77.3, kv=11.0, xr=15.0):
    return _comp("utility-1", "utility", {
        "name": "Grid", "voltage_kv": kv, "fault_mva": fault_mva,
        "x_r_ratio": xr, "z0_z1_ratio": 1.0,
    })


def _proj_with_pt(pt_props, relay_type="21", include_relay=True):
    components = [
        _utility(),
        _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
        _comp("pt-1", "pt", {"name": "PT1", **pt_props}),
    ]
    wires = [
        _wire("w1", "utility-1", "bus-1"),
        _wire("w2", "bus-1", "pt-1"),
    ]
    if include_relay:
        components.append(_comp("relay-1", "relay", {
            "name": "R1", "relay_type": relay_type, "associated_pt": "pt-1",
        }))
        wires.append(_wire("w3", "pt-1", "relay-1"))
    return _project(components, wires)


class TestPTAdequacyCheck:
    def test_absent_connected_burden_not_checked(self):
        """Legacy behaviour: a PT with no connected_burden_va specified
        produces no check output at all — identical to the fully-
        decorative pre-fix PT."""
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30})
        res = run_duty_check(proj)
        assert res["pt_checks"] == []

    def test_well_burdened_pt_passes(self):
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30, "connected_burden_va": 15})
        res = run_duty_check(proj)
        row = next(r for r in res["pt_checks"] if r["device_id"] == "pt-1")
        assert row["status"] == "pass"
        assert row["loading_pct"] == pytest.approx(50.0)
        assert row["rated_burden_va"] == pytest.approx(30.0)
        assert row["connected_burden_va"] == pytest.approx(15.0)
        assert row["accuracy_class"] == "0.5"
        assert row["ratio_error_pct"] == pytest.approx(0.5)
        assert row["phase_error_min"] == pytest.approx(20.0)
        assert row["issues"] == []

    def test_overburdened_pt_flagged_fail(self):
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30, "connected_burden_va": 45})
        res = run_duty_check(proj)
        row = next(r for r in res["pt_checks"] if r["device_id"] == "pt-1")
        assert row["status"] == "fail"
        assert row["loading_pct"] == pytest.approx(150.0)
        assert any("exceeds" in i for i in row["issues"])

    def test_underburdened_pt_flagged_warning(self):
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30, "connected_burden_va": 3})
        res = run_duty_check(proj)
        row = next(r for r in res["pt_checks"] if r["device_id"] == "pt-1")
        assert row["status"] == "warning"
        assert row["loading_pct"] == pytest.approx(10.0)
        assert any("lightly burdened" in i for i in row["issues"])

    def test_pt_without_relay_not_checked(self):
        """A metering-only PT (no relay's associated_pt names it) is out
        of scope, mirroring the CT check's metering-CT exclusion — even
        with connected_burden_va specified."""
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30, "connected_burden_va": 45},
                              include_relay=False)
        res = run_duty_check(proj)
        assert res["pt_checks"] == []

    def test_pt_check_runs_even_with_no_cb_or_fuse(self):
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "0.5",
                               "burden_va": 30, "connected_burden_va": 45})
        res = run_duty_check(proj)
        assert res["devices"] == []
        assert len(res["pt_checks"]) == 1
        assert "No circuit breakers or fuses found." in res["warnings"]

    def test_protective_class_3p_limits_reported(self):
        proj = _proj_with_pt({"ratio": "11000/110", "accuracy_class": "3P",
                               "burden_va": 50, "connected_burden_va": 60})
        res = run_duty_check(proj)
        row = next(r for r in res["pt_checks"] if r["device_id"] == "pt-1")
        assert row["accuracy_class"] == "3P"
        assert row["ratio_error_pct"] == pytest.approx(3.0)
        assert row["phase_error_min"] == pytest.approx(120.0)
        assert row["status"] == "fail"  # 120% loaded
