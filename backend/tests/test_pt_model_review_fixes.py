"""PT model review (2026-09-29) — regression tests for PT1-PT4 and L1.

Each test reproduces the original defect against a reference derived from
IEC 61869-3:2011 / IEC 61869-1 or a closed form, never from the module's
own output. Write-up: reviews/PT_MODEL_REVIEW.md; evidence script:
testing/pt-model-review/v1_core.py.
"""

import math

import pytest

from backend.analysis.duty_check import run_duty_check
from backend.analysis.pt_model import (
    earth_fault_factor, parse_pt_accuracy_limits, parse_pt_ratio,
    parse_pt_voltage_factor, pt_burden_adequacy,
)
from backend.models.schemas import Component, ProjectData, Wire


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b, fp="bottom", tp="top"):
    return Wire(id=wid, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


def _net(pt_props, grounding_lv="solidly_grounded", r_ohm=0.0, vector_group="Dyn11"):
    """33 kV grid -> 10 MVA 33/11 kV transformer -> 11 kV bus -> VT -> relay.
    The 11 kV neutral earthing is set on the transformer LV winding."""
    comps = [
        _c("u", "utility", {"name": "Grid", "voltage_kv": 33, "fault_mva": 500,
                            "x_r_ratio": 10, "z0_z1_ratio": 1.0}),
        _c("b33", "bus", {"name": "33kV", "voltage_kv": 33}),
        _c("t", "transformer", {"name": "T1", "rated_mva": 10, "voltage_hv_kv": 33,
                                "voltage_lv_kv": 11, "z_percent": 8, "x_r_ratio": 10,
                                "vector_group": vector_group, "grounding_hv": "ungrounded",
                                "grounding_lv": grounding_lv,
                                "grounding_lv_resistance": r_ohm,
                                "grounding_lv_reactance": 0}),
        _c("b11", "bus", {"name": "11kV", "voltage_kv": 11}),
        _c("pt", "pt", {"name": "VT", **pt_props}),
        _c("r", "relay", {"name": "R", "relay_type": "67", "associated_pt": "pt"}),
    ]
    wires = [_w("1", "u", "b33"), _w("2", "b33", "t", tp="primary"),
             _w("3", "t", "b11", fp="secondary"), _w("4", "b11", "pt"),
             _w("5", "pt", "r")]
    return ProjectData(projectName="pt-review", baseMVA=100, frequency=50,
                       components=comps, wires=wires)


def _row(project):
    return next(r for r in run_duty_check(project)["pt_checks"] if r["device_id"] == "pt")


_PE_VT = {"ratio": "11000/√3/110/√3", "accuracy_class": "0.5/3P",
          "burden_va": 50, "connection": "phase_earth"}


class TestPT1VoltageFactor:
    """[PT1] The rated voltage factor was never compared with the system
    earthing. A phase-to-earth VT sees the earth fault factor k on its
    healthy phases (sqrt3 unearthed); a 1.2-rated unit passed."""

    @pytest.mark.parametrize("m", [1.0, 3.0, 10.0])
    def test_earth_fault_factor_closed_form(self, m):
        # Purely reactive Z1 = Z2 = jX, Z0 = j m X:
        # k = sqrt3 * sqrt(1 + m + m^2) / (2 + m)
        pred = math.sqrt(3) * math.sqrt(1 + m + m * m) / (2 + m)
        assert earth_fault_factor(0.1j, 0.1j * m) == pytest.approx(pred, rel=1e-12)

    def test_unearthed_is_sqrt3(self):
        assert earth_fault_factor(0.1j, None) == pytest.approx(math.sqrt(3))

    def test_unearthed_bus_fails_a_1p2_vt(self):
        row = _row(_net({**_PE_VT, "voltage_factor": "1.2"},
                        grounding_lv="ungrounded", vector_group="Dd0"))
        assert row["earth_fault_factor"] == pytest.approx(math.sqrt(3), abs=0.01)
        assert row["status"] == "fail"
        assert any("voltage factor 1.2" in i for i in row["issues"])

    def test_resistance_earthed_bus_needs_1p9(self):
        # 6.35 ohm NER (~1 kA): R0 >> X1 pushes k just above sqrt3
        for vf, status in (("1.5/30s", "fail"), ("1.9/30s", "warning"), ("1.9/8h", "pass")):
            row = _row(_net({**_PE_VT, "voltage_factor": vf},
                            grounding_lv="low_resistance", r_ohm=6.35))
            assert row["earth_fault_factor"] > 1.4
            assert row["status"] == status, vf

    def test_solidly_earthed_bus_passes_1p2(self):
        row = _row(_net({**_PE_VT, "voltage_factor": "1.2"}))
        assert row["earth_fault_factor"] <= 1.4
        assert row["status"] == "pass"

    def test_phase_phase_vt_sees_no_rise(self):
        row = _row(_net({"ratio": "11000/110", "accuracy_class": "3P",
                         "connection": "phase_phase", "voltage_factor": "1.2"},
                        grounding_lv="ungrounded", vector_group="Dd0"))
        assert row["required_voltage_factor"] == pytest.approx(1.0)
        assert row["status"] == "pass"

    def test_undeclared_factor_warns_only_when_not_effectively_earthed(self):
        unearthed = _row(_net(_PE_VT, grounding_lv="ungrounded", vector_group="Dd0"))
        assert unearthed["status"] == "warning"
        assert any("Voltage factor not declared" in i for i in unearthed["issues"])
        solid = _row(_net(_PE_VT))
        assert solid["status"] == "pass"

    def test_voltage_factor_parser(self):
        assert parse_pt_voltage_factor("1.2") == (1.2, None)
        assert parse_pt_voltage_factor("1.5/30s") == (1.5, 30.0)
        assert parse_pt_voltage_factor("1.9/8h") == (1.9, 8 * 3600.0)
        assert parse_pt_voltage_factor(1.2) == (1.2, None)  # coerced on save
        assert parse_pt_voltage_factor("") is None


class TestPT2RatedPrimaryVsBus:
    """[PT2] The rated primary was never compared with the bus voltage, and
    '11kV/110V' or a '√3' ratio silently fell back to 11000/110."""

    def test_ratio_forms(self):
        assert parse_pt_ratio("11kV/110V")["primary"] == pytest.approx(11000)
        r = parse_pt_ratio("33000/√3/110/√3")
        assert r["primary"] == pytest.approx(33000 / math.sqrt(3))
        assert r["ratio"] == pytest.approx(300)
        assert parse_pt_ratio("11000/√3/110/3")["secondary"] == pytest.approx(110 / 3)
        assert parse_pt_ratio("11000:110")["parsed"] is True

    def test_33kv_vt_on_11kv_bus_warns(self):
        row = _row(_net({"ratio": "33000/110", "accuracy_class": "3P",
                         "voltage_factor": "1.5/30s"}))
        assert row["service_voltage_pct"] == pytest.approx(100 / 3, abs=0.1)
        assert row["status"] == "warning"

    def test_6p35kv_unit_declared_phase_phase_on_11kv_fails(self):
        row = _row(_net({"ratio": "6350/63.5", "accuracy_class": "3P",
                         "connection": "phase_phase", "voltage_factor": "1.2"}))
        assert row["service_voltage_pct"] == pytest.approx(11000 / 6350 * 100, abs=0.1)
        assert row["status"] == "fail"

    def test_line_marked_three_phase_vt_is_100pct(self):
        # a three-phase earthed-star VT nameplated by the line voltage
        row = _row(_net({"ratio": "11000/110", "accuracy_class": "3P",
                         "connection": "phase_earth", "voltage_factor": "1.2"}))
        assert row["service_voltage_pct"] == pytest.approx(100.0)
        assert row["status"] == "pass"


class TestPT3AccuracyClassParsing:
    """[PT3] '1' and '3' read as class 0.5; a dual '0.5/3P' read as 0.5
    though a relay-fed winding is judged on its protective class."""

    def test_bare_integers(self):
        assert parse_pt_accuracy_limits("1")["ratio_error_pct"] == 1.0
        assert parse_pt_accuracy_limits("1")["phase_error_min"] == 40.0
        assert parse_pt_accuracy_limits("3")["ratio_error_pct"] == 3.0

    def test_dual_class_governed_by_protective(self):
        lim = parse_pt_accuracy_limits("0.5/3P")
        assert lim["class"] == "0.5/3P"
        assert (lim["ratio_error_pct"], lim["phase_error_min"]) == (3.0, 120.0)
        meas = parse_pt_accuracy_limits("0.2 3P", protection=False)
        assert (meas["ratio_error_pct"], meas["phase_error_min"]) == (0.2, 10.0)

    def test_unrecognised_class_warns(self):
        row = _row(_net({"ratio": "11000/110", "accuracy_class": "XYZ",
                         "voltage_factor": "1.2"}))
        assert row["status"] == "warning"
        assert any("not recognised" in i for i in row["issues"])


class TestPT4BurdenRangeI:
    """[PT4] IEC 61869-3 burden range I (rated < 10 VA, unity pf) holds the
    class from 0 VA; a 5 VA VT driving a 0.5 VA digital relay warned."""

    def test_range_i_has_no_floor(self):
        a = pt_burden_adequacy({"burden_va": 5, "connected_burden_va": 0.5})
        assert a["within_qualified_band"] and a["burden_range"] == "I"

    def test_range_ii_keeps_25pct_floor(self):
        a = pt_burden_adequacy({"burden_va": 50, "connected_burden_va": 5})
        assert not a["within_qualified_band"] and a["burden_range"] == "II"
