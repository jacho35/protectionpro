"""Regression tests for the CT saturation model review (CT_MODEL_REVIEW.md,
findings C1–C4, lesser notes L1–L3).

References are independent of the engine: Fourier coefficients of the
square-loop clipped sine, the IEC 61869-2 accuracy-limit EMF and effective
ALF, the IEC 61869-2 transient factor Ktf (IEEE C37.110 time to
saturation), and a 400-sample/cycle square-loop simulation
(testing/ct-model-review/ctsim.py) for the dc-offset delay.

Run with:  python -m pytest backend/tests/test_ct_model_review_fixes.py -v
"""

import math

import pytest

from backend.analysis.arcflash import _relay_operate_time
from backend.analysis.ct_model import (
    ct_effective_current, ct_saturation_params, ct_time_to_saturation,
    parse_ct_accuracy_class, x_r_from_kappa,
)
from backend.analysis.duty_check import run_duty_check
from backend.models.schemas import Component, ProjectData, Wire

CT = {"ratio": "400/5", "accuracy_class": "5P20", "burden_va": 15, "rct_ohm": 0.3}


class TestC1Fundamental:
    """[C1] The relay measures the fundamental of the clipped secondary, not
    its true RMS (which is up to 1.8x higher and understated the delay)."""

    @pytest.mark.parametrize("ks", [0.8, 0.5, 0.3])
    def test_effective_current_is_fourier_fundamental(self, ks):
        sat = ct_saturation_params(CT)
        i_sec = sat["knee_point_v"] / (ks * sat["total_z"])
        i_prim = i_sec * sat["ratio"]
        # Half-wave sin wt on (0, theta), 0 on (theta, pi), 1 - cos theta = 2 ks
        theta = math.acos(1 - 2 * ks)
        n = 20000
        b1 = a1 = 0.0
        for k in range(n):
            wt = (k + 0.5) * theta / n
            b1 += math.sin(wt) * math.sin(wt)
            a1 += math.sin(wt) * math.cos(wt)
        b1 *= 2 / math.pi * theta / n
        a1 *= 2 / math.pi * theta / n
        fund = math.hypot(a1, b1)
        rms = math.sqrt((theta - math.sin(2 * theta) / 2) / math.pi)
        assert ct_effective_current(i_prim, sat) == pytest.approx(i_prim * fund, rel=1e-6)
        assert fund < rms  # the old (RMS) value was optimistic


class TestC2ConnectedBurden:
    """[C2] ALF' = ALF (Rct + R_rated)/(Rct + R_connected)."""

    def test_rated_burden_no_longer_cancels_when_connected_given(self):
        base = ct_saturation_params(CT)
        assert base["i_sat_primary"] == pytest.approx(20 * 400)  # ALF x I_pn
        heavy = ct_saturation_params({**CT, "connected_burden_va": 30})
        # 15 VA core driving 30 VA: ALF' = 20 (0.3 + 0.6)/(0.3 + 1.2) = 12
        assert heavy["alf_effective"] == pytest.approx(12.0)
        assert heavy["i_sat_primary"] == pytest.approx(12 * 400)

    def test_light_connected_burden_raises_limit(self):
        light = ct_saturation_params({**CT, "connected_burden_va": 2.5})
        # 0.1 ohm: ALF' = 20 x 0.9 / 0.4 = 45
        assert light["alf_effective"] == pytest.approx(45.0)

    def test_absent_connected_burden_is_rated(self):
        assert ct_saturation_params({**CT, "connected_burden_va": 0})["alf_effective"] \
            == pytest.approx(20.0)


class TestC3DcOffset:
    """[C3] dc offset: Ktf = 1 + wTp(1 - e^-t/Tp), simulated in the time
    domain — not a kappa derating of the knee."""

    def test_x_r_from_kappa_inverts_iec60909(self):
        for xr in (5.0, 10.0, 15.0, 40.0):
            kappa = 1.02 + 0.98 * math.exp(-3 / xr)
            assert x_r_from_kappa(kappa) == pytest.approx(xr, rel=1e-9)
        assert x_r_from_kappa(None) == 0.0
        assert x_r_from_kappa(1.02) == 0.0

    def test_time_to_saturation_ieee_c37110(self):
        sat = ct_saturation_params(CT)  # V_sat 90 V, Z 0.9 -> symmetric limit 8000 A
        i = 4000.0                      # Ks = 2
        xr = 10.0
        w = 2 * math.pi * 50
        tp = xr / w
        expected = -tp * math.log(1 - (2 - 1) / xr)
        assert ct_time_to_saturation(i, sat, xr, 50) == pytest.approx(expected, rel=1e-9)
        assert ct_time_to_saturation(9000.0, sat, xr, 50) == 0.0     # symmetric saturation
        assert ct_time_to_saturation(500.0, sat, xr, 50) == math.inf  # Ks - 1 > X/R

    def test_offset_delay_below_symmetric_threshold(self):
        """The defect case: 1200/1 5P20 10 VA, Rct 5, EI, X/R 40, 10 kA —
        below the symmetrical threshold, so the kappa model reported no
        delay. The 400-sample square-loop reference (v4_engine_vs_ref.py)
        gives 1.191 s; the ideal-CT time is 0.978 s."""
        ct = {"ratio": "1200/1", "accuracy_class": "5P20", "burden_va": 10, "rct_ohm": 5}
        relay = {"pickup_a": 2400, "time_dial": 0.2, "curve": "IEC Extremely Inverse"}
        kappa = 1.02 + 0.98 * math.exp(-3 / 40)
        t_ideal = 0.2 * 80 / ((10000 / 2400) ** 2 - 1)
        t = _relay_operate_time(relay, 10000, ct, kappa, 50.0)
        assert t_ideal == pytest.approx(0.978, abs=0.001)
        assert t == pytest.approx(1.191, abs=0.015)

    def test_no_offset_no_delay(self):
        relay = {"pickup_a": 400, "time_dial": 0.1, "curve": "IEC Standard Inverse"}
        sat = ct_saturation_params(CT)
        t_static = 0.1 * 0.14 / ((ct_effective_current(16000, sat) / 400) ** 0.02 - 1)
        assert _relay_operate_time(relay, 16000, CT, None, 50.0) == pytest.approx(t_static)

    def test_kappa_no_longer_derates_threshold(self):
        assert ct_saturation_params(CT, kappa=1.9)["i_sat_primary"] == pytest.approx(8000)


class TestC4AccuracyClass:
    """[C4] Class strings parsed, not silently read as ALF 20."""

    @pytest.mark.parametrize("cls,kind,alf", [
        ("5PR10", "P", 10.0), ("5P 10", "P", 10.0), ("10p15", "P", 15.0),
        ("C200", "C", 20.0), ("PX", "PX", 20.0), ("TPY", "PX", 20.0),
        ("0.5FS10", "metering", 10.0), ("0.5", "metering", 5.0),
        ("xyz", "unknown", 20.0),
    ])
    def test_parse(self, cls, kind, alf):
        p = parse_ct_accuracy_class(cls)
        assert (p["kind"], p["alf"]) == (kind, alf)
        assert (p["warning"] is None) == (kind in ("P", "C"))

    def test_c_class_emf(self):
        # C200 on a 5 A core, Rct 0.3: EMF = 200 + 20 x 5 x 0.3 = 230 V
        sat = ct_saturation_params({"ratio": "400/5", "accuracy_class": "C200", "rct_ohm": 0.3})
        assert sat["knee_point_v"] == pytest.approx(230.0)

    def test_px_with_knee_has_no_warning(self):
        sat = ct_saturation_params({"ratio": "400/1", "accuracy_class": "PX", "knee_point_v": 400})
        assert sat["warnings"] == [] and sat["knee_point_v"] == 400


class TestL1ClassConsistentOnset:
    """[L1] At ALF x I_n on rated burden a 5P core guarantees <= 5 %
    composite error; the model must not clip there."""

    def test_no_clip_at_alf(self):
        sat = ct_saturation_params(CT)
        assert ct_effective_current(20 * 400, sat) == pytest.approx(20 * 400)


class TestL2RctDefault:
    def test_zero_rct_is_typical_for_secondary(self):
        assert ct_saturation_params({"ratio": "400/1", "rct_ohm": 0})["rct_ohm"] == 3.0
        assert ct_saturation_params({"ratio": "400/5", "rct_ohm": 0})["rct_ohm"] == 0.3


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="bottom", toComponent=b, toPort="top")


def _duty(ct_props, relay_type="50/51"):
    proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50, components=[
        _c("u", "utility", {"voltage_kv": 11.0, "fault_mva": 50.0, "x_r_ratio": 15.0,
                            "z0_z1_ratio": 1.0}),
        _c("ct", "ct", {"name": "CT", **ct_props}),
        _c("b", "bus", {"name": "B", "voltage_kv": 11.0}),
        _c("r", "relay", {"relay_type": relay_type, "associated_ct": "ct",
                          "pickup_a": 400, "time_dial": 0.1}),
    ], wires=[_w("w1", "u", "ct"), _w("w2", "ct", "b")])
    return next(r for r in run_duty_check(proj)["ct_checks"] if r["device_id"] == "ct")


class TestL3DutyCheck:
    def test_core_balance_uses_ik1(self):
        row = _duty({"ratio": "100/1", "ct_type": "core_balance"})
        assert row["fault_basis"] == "Ik1"

    def test_differential_flags_transient_dimensioning(self):
        row = _duty({"ratio": "2000/1", "accuracy_class": "5P20"}, relay_type="87T")
        assert row["status"] == "warning"
        assert any("Ktd" in i for i in row["issues"])

    def test_guessed_class_cannot_pass_silently(self):
        row = _duty({"ratio": "2000/1", "accuracy_class": "PX"})
        assert row["status"] == "warning"
