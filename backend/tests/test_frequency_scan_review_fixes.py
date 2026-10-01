"""Regression tests for the frequency_scan.py review (reviews/FREQUENCY_SCAN_REVIEW.md,
FS1–FS5, L1–L5). Each test reproduces the original defect; the expected
numbers come from closed-form RLC impedances or a hand nodal solve in ohms
with an ideal transformer, never from the engine.
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.frequency_scan import (
    _detect_resonances, run_frequency_scan,
)
from backend.analysis.harmonics import run_harmonics


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="bottom", toComponent=b, toPort="top")


def _p(comps, wires, base=100.0, f=50):
    return ProjectData(projectName="fs", baseMVA=base, frequency=f,
                       components=comps, wires=wires)


def _grid_cap(ssc=100.0, xr=15.0, kvar=1000.0, kv=11.0, extra=(), extra_w=()):
    comps = [_c("u", "utility", {"voltage_kv": kv, "fault_mva": ssc, "x_r_ratio": xr}),
             _c("b", "bus", {"name": "B", "voltage_kv": kv}),
             _c("c", "capacitor_bank", {"rated_kvar": kvar, "voltage_kv": kv})]
    wires = [_w("w1", "u", "b"), _w("w2", "b", "c")]
    return _p(comps + list(extra), wires + list(extra_w))


def _z_grid_cap(h, ssc=100.0, xr=15.0, kvar=1000.0, kv=11.0):
    """|Z(h)| (Ω) of (R + jhX) ∥ 1/(jhB) — source from S_sc and X/R."""
    zs = kv ** 2 / ssc
    x = zs * xr / math.sqrt(1 + xr * xr)
    b = (kvar / 1000.0) / kv ** 2
    return abs(1 / (1 / complex(x / xr, h * x) + 1j * h * b))


def _dense_max(f, lo, hi, n=200001):
    hs = np.linspace(lo, hi, n)
    z = np.array([f(h) for h in hs])
    i = int(np.argmax(z))
    return hs[i], z[i]


class TestFS1RankingInPerUnit:
    """[FS1] V_h = Z_pu·I_h, so a resonance's severity compares across voltage
    levels in per unit. Ranked in ohms, every MV peak beat every LV peak."""

    def test_lv_resonance_near_7th_heads_the_ranking(self):
        comps = [
            _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
            _c("hv", "bus", {"name": "HV", "voltage_kv": 11}),
            _c("chv", "capacitor_bank", {"rated_kvar": 1500, "voltage_kv": 11}),
            _c("lhv", "static_load", {"rated_kva": 6000, "power_factor": 0.9, "voltage_kv": 11}),
            _c("t", "transformer", {"rated_mva": 1.0, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                                    "z_percent": 5, "x_r_ratio": 6}),
            _c("lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _c("clv", "capacitor_bank", {"rated_kvar": 400, "voltage_kv": 0.4}),
            _c("llv", "static_load", {"rated_kva": 150, "power_factor": 0.9, "voltage_kv": 0.4}),
        ]
        wires = [_w("a", "u", "hv"), _w("b", "hv", "chv"), _w("c", "hv", "lhv"),
                 _w("d", "hv", "t"), _w("e", "t", "lv"), _w("f", "lv", "clv"),
                 _w("g", "lv", "llv")]
        r = run_frequency_scan(_p(comps, wires))
        par = [x for x in r["resonances"] if x["kind"] == "parallel"]
        lv = next(x for x in par if x["bus_id"] == "lv")
        hv_top = max((x for x in par if x["bus_id"] == "hv"), key=lambda x: x["z_ohm"])
        # The HV peak is larger in ohms, the LV one ~20× larger in per unit.
        assert hv_top["z_ohm"] > lv["z_ohm"]
        assert lv["z_pu"] > 10 * hv_top["z_pu"]
        assert r["worst_bus_id"] == "lv"
        assert r["worst_h"] == pytest.approx(6.78, abs=0.05)
        assert r["worst_z_pu"] == pytest.approx(lv["z_pu"])
        assert par[0]["bus_id"] == "lv"
        # z_pu is on the study base: Z_ohm / (U² / S_base).
        assert lv["z_pu"] == pytest.approx(lv["z_ohm"] / (0.4 ** 2 / 100.0), rel=1e-4)


class TestFS2PeakRefinement:
    """[FS2] The reported peak was the largest SAMPLE; a resonance narrower
    than the step was under-reported. Refined to the true extremum."""

    def test_peak_magnitude_matches_the_closed_form(self):
        # S_sc 100 MVA X/R 15 with 1 Mvar → h_r ≈ 10; at the default step the
        # sampled peak was 1722.1 Ω, the true peak 1815.0 Ω (−5.1 %).
        r = run_frequency_scan(_grid_cap(kvar=1000.0))
        pk = next(x for x in r["resonances"] if x["kind"] == "parallel")
        h_ref, z_ref = _dense_max(_z_grid_cap, 9.9, 10.1)
        assert pk["z_ohm"] == pytest.approx(z_ref, rel=1e-5)
        assert pk["h"] == pytest.approx(h_ref, abs=2e-3)
        assert pk["f_hz"] == pytest.approx(h_ref * 50, abs=0.1)

    def test_series_dip_of_a_tuned_filter(self):
        # 2 Mvar filter tuned to 4.7, Q 30, on a 100 MVA X/R 15 source.
        comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 100, "x_r_ratio": 15}),
                 _c("b", "bus", {"voltage_kv": 11}),
                 _c("f", "capacitor_bank", {"rated_kvar": 2000, "voltage_kv": 11,
                                            "tuned_order": 4.7, "quality_factor": 30})]
        r = run_frequency_scan(_p(comps, [_w("1", "u", "b"), _w("2", "b", "f")]))
        zs = 121 / 100.0
        x = zs * 15 / math.sqrt(226)
        xeff = 121 / 2.0
        xc = xeff * 4.7 ** 2 / (4.7 ** 2 - 1)
        xl, rf = xc / 4.7 ** 2, (xc / 4.7) / 30

        def z(h):
            return abs(1 / (1 / complex(x / 15, h * x) + 1 / complex(rf, h * xl - xc / h)))
        hs = np.linspace(4.5, 4.9, 200001)
        zz = np.array([z(h) for h in hs])
        dip = next(x for x in r["resonances"] if x["kind"] == "series")
        assert dip["z_ohm"] == pytest.approx(zz.min(), rel=1e-5)
        assert dip["h"] == pytest.approx(hs[int(np.argmin(zz))], abs=2e-3)


def _ratio_net(v_lv_rated, tap=0.0):
    comps = [
        _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
        _c("hv", "bus", {"name": "HV", "voltage_kv": 11}),
        _c("t", "transformer", {"rated_mva": 2.0, "voltage_hv_kv": 11,
                                "voltage_lv_kv": v_lv_rated, "z_percent": 6,
                                "x_r_ratio": 8, "tap_percent": tap}),
        _c("lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
        _c("k", "cable", {"length_km": 0.15, "r_per_km": 0.0754, "x_per_km": 0.075,
                          "voltage_kv": 0.4}),
        _c("lv2", "bus", {"name": "LV2", "voltage_kv": 0.4}),
        _c("cap", "capacitor_bank", {"rated_kvar": 300, "voltage_kv": 0.4}),
        _c("ld", "static_load", {"rated_kva": 800, "power_factor": 0.9, "voltage_kv": 0.4}),
    ]
    wires = [_w("1", "u", "hv"), _w("2", "hv", "t"), _w("3", "t", "lv"),
             _w("4", "lv", "k"), _w("5", "k", "lv2"), _w("6", "lv", "cap"),
             _w("7", "lv2", "ld")]
    return _p(comps, wires)


def _ratio_ref(h, v_lv_rated, tap=0.0):
    """Hand solve in ohms on the LV side: the source referred through the
    TURNS ratio (11·(1+tap)/U_rLV), the transformer's own z% on U_rLV."""
    a = 11.0 * (1 + tap / 100) / v_lv_rated
    zs = 121 / 250.0
    xs = zs * 10 / math.sqrt(101)
    zsrc = complex(xs / 10, h * xs) / a ** 2
    zt = 0.06 * v_lv_rated ** 2 / 2.0
    xt = zt * 8 / math.sqrt(65)
    ztx = complex(xt / 8, h * xt)
    zk = complex(0.0754 * 0.15, h * 0.075 * 0.15)
    yload = 0.72 / 0.16 + 1 / (1j * h * 0.16 / (0.8 * math.sqrt(0.19)))
    ycap = 1j * h * 0.3 / 0.16
    Y = np.array([[1 / (zsrc + ztx) + ycap + 1 / zk, -1 / zk],
                  [-1 / zk, 1 / zk + yload]])
    return abs(np.linalg.inv(Y)[0, 0])


class TestFS3TransformerRatio:
    """[FS3] The harmonic network summed chain impedances with no ideal
    transformer, so a turns ratio off the drawn bus ratio (an 11/0.42 kV
    library unit on a 0.4 kV bus, or a tap) mis-referred everything beyond it."""

    @pytest.mark.parametrize("v_lv, tap", [(0.4, 0.0), (0.42, 0.0), (0.42, -5.0)])
    def test_lv_driving_point_matches_ideal_transformer_solve(self, v_lv, tap):
        r = run_frequency_scan(_ratio_net(v_lv, tap))
        lv = next(b for b in r["buses"] if b["id"] == "lv")
        for i in (0, r["h"].index(5.0), r["h"].index(11.0)):
            assert lv["z_ohm"][i] == pytest.approx(_ratio_ref(r["h"][i], v_lv, tap), rel=1e-4)

    def test_harmonics_hv_thd_follows_the_ratio(self):
        """The harmonics study shares the network: with a −5 % tap the HV
        THD_V was 1.11 % (ratio ignored); physically it is higher."""
        def thd(v_lv, tap):
            comps = [
                _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
                _c("hv", "bus", {"name": "HV", "voltage_kv": 11}),
                _c("t", "transformer", {"rated_mva": 2, "voltage_hv_kv": 11,
                                        "voltage_lv_kv": v_lv, "z_percent": 6,
                                        "x_r_ratio": 8, "tap_percent": tap}),
                _c("lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
                _c("d", "vfd", {"rated_kw": 800, "pulse_number": 6, "voltage_kv": 0.4}),
                _c("l", "static_load", {"rated_kva": 1000, "power_factor": 0.85,
                                        "voltage_kv": 0.4}),
                _c("c", "capacitor_bank", {"rated_kvar": 250, "voltage_kv": 0.4}),
            ]
            wires = [_w("1", "u", "hv"), _w("2", "hv", "t"), _w("3", "t", "lv"),
                     _w("4", "lv", "d"), _w("5", "lv", "l"), _w("6", "lv", "c")]
            res = run_harmonics(_p(comps, wires))
            return next(b for b in res["buses"] if b["id"] == "hv")["thd_v_pct"]
        assert thd(0.42, -5.0) == pytest.approx(1.21, abs=0.02)
        assert thd(0.4, 0.0) == pytest.approx(1.30, abs=0.02)   # unchanged


class TestFS4DeadIslands:
    """[FS4] A capacitor bank behind an open breaker resonated with a motor
    on its dead bus and was reported (and could head the results)."""

    def test_dead_bus_not_scanned(self):
        extra = [_c("cb", "cb", {"state": "open"}),
                 _c("b2", "bus", {"name": "Spare", "voltage_kv": 11}),
                 _c("c2", "capacitor_bank", {"rated_kvar": 2000, "voltage_kv": 11}),
                 _c("m", "motor_induction", {"rated_kw": 2000, "voltage_kv": 11,
                                             "locked_rotor_current": 6})]
        wires = [_w("3", "b", "cb"), _w("4", "cb", "b2"), _w("5", "b2", "c2"),
                 _w("6", "b2", "m")]
        r = run_frequency_scan(_grid_cap(kvar=0, extra=extra, extra_w=wires))
        assert all(x["bus_id"] != "b2" for x in r["resonances"])
        assert all(b["id"] != "b2" for b in r["buses"])
        assert any("de-energised" in w and "Spare" in w for w in r["warnings"])
        # Only live capacitance counts for the no-capacitor warning (L2).
        assert any("No capacitor banks" in w for w in r["warnings"])
        only = run_frequency_scan(_grid_cap(kvar=0, extra=extra, extra_w=wires),
                                  bus_ids=["b2"])
        assert not only["converged"]


class TestFS5RegulatingSvc:
    """[FS5] A voltage-regulating SVC has no fixed Q; without the load flow
    the scan modelled it as nothing. It now takes the solved output."""

    def test_svc_resonates_at_its_solved_output(self):
        extra = [_c("s", "svc", {"device_mode": "svc", "control_mode": "voltage_regulating",
                                 "v_setpoint_pu": 1.02, "q_max_mvar": 4, "q_min_mvar": -4,
                                 "rated_mvar": 4, "voltage_kv": 11}),
                 _c("l", "static_load", {"rated_kva": 8000, "power_factor": 0.8,
                                         "voltage_kv": 11})]
        wires = [_w("3", "b", "s"), _w("4", "b", "l")]
        r = run_frequency_scan(_grid_cap(kvar=0.1, extra=extra, extra_w=wires))
        pk = [x for x in r["resonances"] if x["kind"] == "parallel"]
        assert pk, "a capacitive SVC must resonate with the source"
        # At full output (4 Mvar at V≈1.02 → B ≈ 3.85 Mvar at 1 pu) the
        # lossless screening estimate is √(100/3.85) ≈ 5.1.
        assert pk[0]["h"] == pytest.approx(math.sqrt(100 / 3.85), abs=0.15)
        assert not any("No capacitor banks" in w for w in r["warnings"])


class TestLesser:
    def test_l1_shoulder_ripple_is_not_a_resonance(self):
        """[L1] Prominence is measured to the col before a higher peak; the
        whole-side minimum reached the low Z(1) and passed a ripple."""
        hs = np.linspace(1, 25, 481)
        z = hs / np.abs(1 - (hs / 5) ** 2 + 0.03j * hs) + 3 * np.exp(-((hs - 12) / 0.4) ** 2)
        found = _detect_resonances(hs, z, 50)
        assert [round(float(hs[x["i"]]), 2) for x in found] == [5.0]

    def test_l2_switched_out_bank_is_not_capacitance(self):
        comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 100, "x_r_ratio": 15}),
                 _c("b", "bus", {"voltage_kv": 11}),
                 _c("c", "capacitor_bank", {"rated_kvar": 4000, "steps": 4,
                                            "steps_in_service": 0, "voltage_kv": 11})]
        r = run_frequency_scan(_p(comps, [_w("1", "u", "b"), _w("2", "b", "c")]))
        assert any("No capacitor banks" in w for w in r["warnings"])

    def test_l3_resonance_above_h_max_is_flagged(self):
        r = run_frequency_scan(_grid_cap(kvar=4000.0), h_max=4.9)   # h_r = 5
        assert not r["resonances"]
        assert any("above the scanned range" in w for w in r["warnings"])

    def test_l4_lv_impedances_keep_significant_figures(self):
        r = run_frequency_scan(_ratio_net(0.42))
        lv = next(b for b in r["buses"] if b["id"] == "lv")
        assert lv["z1_ohm"] == pytest.approx(_ratio_ref(1.0, 0.42), rel=1e-5)

    def test_l5_empty_result_reports_the_project_frequency(self):
        r = run_frequency_scan(_grid_cap().model_copy(update={"frequency": 60}),
                               bus_ids=["nope"])
        assert r["f0_hz"] == 60.0

    def test_l6_idle_generator_is_named(self):
        extra = [_c("g", "generator", {"name": "Standby", "voltage_kv": 11,
                                       "rated_mva": 10, "dispatch_mode": "standby"}),
                 _c("l", "static_load", {"rated_kva": 3000, "voltage_kv": 11})]
        r = run_frequency_scan(_grid_cap(kvar=4000.0, extra=extra,
                                         extra_w=[_w("3", "g", "b"), _w("4", "b", "l")]))
        assert any("'Standby'" in w and "idle" in w for w in r["warnings"])
