"""Regression tests for the ANSI/IEEE C37.010 fault-duty review (2026-10-02,
AN1-AN7 + lesser notes).

Each expected value is a hand reduction built here, independently of the
engine: reactance-only and resistance-only networks reduced by series /
parallel rules (C37.010's separate-network prescription), E/X with E = 1 pu,
and the closed-form dc-decrement and peak factors.

Run with:  python -m pytest backend/tests/test_fault_ansi_review_fixes.py -q
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import induction_motor_x_pp
from backend.analysis.fault_ansi import run_ansi_fault_analysis

BASE = 100.0


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _p(comps, links, f=60):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=BASE, frequency=f, components=comps, wires=wires)


def _par(*z):
    return 1.0 / sum(1.0 / v for v in z)


def _utility_xr(s_mva, xr):
    """Hand: |Z| = base/S split by X/R."""
    z = BASE / s_mva
    x = z * xr / math.sqrt(1 + xr * xr)
    return x, x / xr


def _xfmr_xr(s_mva, z_pct, xr):
    z = z_pct / 100 * BASE / s_mva
    x = z * xr / math.sqrt(1 + xr * xr)
    return x, x / xr


def _ibase(kv):
    return BASE / (math.sqrt(3) * kv)


class TestAN1SharedImpedance:
    """[AN1] A motor on the HV bus shares the transformer with the grid."""

    def _net(self):
        comps = [
            _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
            _c("A", "bus", {"voltage_kv": 11}),
            _c("m", "motor_synchronous", {"rated_kva": 10000, "voltage_kv": 11,
                                          "xd_pp": 0.15, "x_r_ratio": 40}),
            _c("t", "transformer", {"rated_mva": 10, "z_percent": 8, "x_r_ratio": 12,
                                    "voltage_hv_kv": 11, "voltage_lv_kv": 3.3,
                                    "vector_group": "Dyn11"}),
            _c("B", "bus", {"voltage_kv": 3.3}),
        ]
        links = [("u", "out", "A", "at_0"), ("m", "out", "A", "at_1"),
                 ("A", "at_2", "t", "primary"), ("t", "secondary", "B", "at_0")]
        return _p(comps, links)

    @pytest.mark.parametrize("duty,mult", [("momentary", 1.0), ("interrupting", 1.5)])
    def test_transformer_counted_once(self, duty, mult):
        xu, _ = _utility_xr(250, 15)
        xt, _ = _xfmr_xr(10, 8, 12)
        xm = mult * 0.15 * BASE / 10
        expected = _ibase(3.3) / (xt + _par(xu, xm))
        r = run_ansi_fault_analysis(self._net())["buses"]["B"]
        # Pre-fix: (Xt+Xu) ∥ (Xt+Xm) → 22.2 / 20.3 kA instead of 15.7 / 15.4
        assert r[f"i_sym_{duty}_ka"] == pytest.approx(expected, rel=1e-3)
        assert "Meshed" not in r["warning"]


class TestAN2SeparateRXNetworks:
    """[AN2] X/R from separate R and X networks, not a complex reduction."""

    def _net(self, rating_ka=40):
        comps = [
            _c("u", "utility", {"voltage_kv": 13.8, "fault_mva": 500, "x_r_ratio": 10}),
            _c("g", "generator", {"rated_mva": 40, "voltage_kv": 13.8, "xd_pp": 0.12,
                                  "x_r_ratio": 60}),
            _c("b", "bus", {"voltage_kv": 13.8}),
            _c("cb", "cb", {"rated_voltage_kv": 15, "breaking_capacity_ka": rating_ka,
                            "k_factor": 1.0, "state": "closed"}),
            _c("f", "bus", {"voltage_kv": 13.8}),
        ]
        links = [("u", "out", "b", "at_0"), ("g", "out", "b", "at_1"),
                 ("b", "at_2", "cb", "top"), ("cb", "bottom", "f", "at_0")]
        return _p(comps, links)

    def test_xr_from_separate_networks(self):
        xu, ru = _utility_xr(500, 10)
        xg = 0.12 * BASE / 40
        rg = xg / 60
        expected = _par(xu, xg) / _par(ru, rg)       # 29.9
        res = run_ansi_fault_analysis(self._net())
        # Pre-fix: complex reduction → 15.04, just above the 15 threshold
        assert res["buses"]["b"]["x_r_interrupting"] == pytest.approx(expected, rel=1e-3)

    def test_breaker_fails_after_multiplying_factor(self):
        """[AN5] E/X is above 80 % of 40 kA and X/R 29.9 > 15: E/X × the
        remote factor at 3 cycles exceeds 40 kA. Pre-fix: REVIEW (no answer)."""
        xu, ru = _utility_xr(500, 10)
        xg = 0.12 * BASE / 40
        e_x = _ibase(13.8) / _par(xu, xg)
        xr = _par(xu, xg) / _par(ru, xg / 60)

        def asym(x_r, c):
            return math.sqrt(1 + 2 * math.exp(-4 * math.pi * c / x_r))
        mf = asym(xr, 3) / asym(15, 3)
        d = run_ansi_fault_analysis(self._net())["devices"][0]
        assert d["multiplying_factor"] == pytest.approx(mf, rel=1e-3)
        assert d["duty_interrupting_ka"] == pytest.approx(e_x * mf, rel=1e-3)
        assert d["status_interrupting"] == "FAIL"
        assert d["requires_detailed_method"] is False

    def test_below_80_percent_no_factor(self):
        d = run_ansi_fault_analysis(self._net(rating_ka=63))["devices"][0]
        assert d["multiplying_factor"] == 1.0
        assert d["status_interrupting"] == "PASS"


class TestAN3LowVoltageBreaker:
    """[AN3] LV breakers: first-cycle duty with small motors, X/R factor."""

    def _net(self):
        comps = [
            _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
            _c("A", "bus", {"voltage_kv": 11}),
            _c("t", "transformer", {"rated_mva": 1.6, "z_percent": 6, "x_r_ratio": 8,
                                    "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                                    "vector_group": "Dyn11"}),
            _c("L", "bus", {"voltage_kv": 0.4}),
            _c("cb", "cb", {"cb_type": "mccb", "breaking_capacity_ka": 50,
                            "rated_voltage_kv": 0.69, "state": "closed"}),
            _c("F", "bus", {"voltage_kv": 0.4}),
        ]
        links = [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
                 ("t", "secondary", "L", "at_0"), ("L", "at_1", "cb", "top"),
                 ("cb", "bottom", "F", "at_0")]
        for k in range(12):   # 30 kW = 40 hp each, below the 50 hp line
            comps.append(_c(f"m{k}", "motor_induction", {
                "rated_kw": 30, "efficiency": 0.92, "power_factor": 0.86, "lrc": 6,
                "x_r_ratio": 6}))
            links.append(("L", f"at_{k + 2}", f"m{k}", "in"))
        return _p(comps, links), comps

    def test_first_cycle_duty_and_factor(self):
        p, comps = self._net()
        xu, ru = _utility_xr(250, 10)
        xt, rt = _xfmr_xr(1.6, 6, 8)
        m = next(c for c in comps if c.id == "m0")
        motor_mva = 30 / (0.92 * 0.86 * 1000)
        xm = 1.67 * induction_motor_x_pp(m.props, 6) * BASE / motor_mva / 12
        x = _par(xu + xt, xm)
        r = _par(ru + rt, xm / 6)
        i_fc = _ibase(0.4) / x
        xr = x / r
        # MCCB > 20 kA: test X/R 4.9 (UL 489, PF 20 %); larger of rms / peak ratio
        rms = (math.sqrt(1 + 2 * math.exp(-2 * math.pi / xr))
               / math.sqrt(1 + 2 * math.exp(-2 * math.pi / 4.9)))
        peak = (1 + math.exp(-math.pi / xr)) / (1 + math.exp(-math.pi / 4.9))
        mf = max(rms, peak)

        res = run_ansi_fault_analysis(p)
        bus = res["buses"]["L"]
        assert bus["i_sym_lv_first_cycle_ka"] == pytest.approx(i_fc, rel=1e-3)
        d = res["devices"][0]
        # Pre-fix: judged on the C37.010 interrupting network (motors < 50 hp
        # neglected) — 35.0 kA, no X/R factor
        assert d["duty_interrupting_ka"] == pytest.approx(i_fc * mf, rel=1e-3)
        assert d["duty_interrupting_ka"] > bus["i_sym_interrupting_ka"] * 1.15
        assert d["status_closing_latching"] == "N/A"


class TestAN4Converters:
    """[AN4] A diode-front-end VFD blocks its motor's contribution."""

    def test_vfd_motor_does_not_feed(self):
        comps = [
            _c("u", "utility", {"voltage_kv": 4.16, "fault_mva": 150, "x_r_ratio": 12}),
            _c("b", "bus", {"voltage_kv": 4.16}),
            _c("v", "vfd", {"rated_kw": 400, "front_end": "diode"}),
            _c("m", "motor_induction", {"rated_kw": 400, "voltage_kv": 4.16}),
        ]
        links = [("u", "out", "b", "at_0"), ("b", "at_1", "v", "in"), ("v", "out", "m", "in")]
        xu, _ = _utility_xr(150, 12)
        r = run_ansi_fault_analysis(_p(comps, links))["buses"]["b"]
        # Pre-fix: the drive was a closed link, the motor added 1.3 %
        assert r["i_sym_momentary_ka"] == pytest.approx(_ibase(4.16) / xu, rel=1e-4)


class TestAN6MomentaryAsymmetry:
    """[AN6] Above X/R ≈ 25 the half-cycle rms exceeds 1.6 × E/X."""

    def test_high_xr_uses_half_cycle_rms(self):
        comps = [_c("u", "utility", {"voltage_kv": 13.8, "fault_mva": 1000, "x_r_ratio": 50}),
                 _c("b", "bus", {"voltage_kv": 13.8})]
        r = run_ansi_fault_analysis(_p(comps, [("u", "out", "b", "at_0")]))["buses"]["b"]
        f = math.sqrt(1 + 2 * math.exp(-2 * math.pi / 50))
        assert f > 1.6
        assert r["i_asym_momentary_ka"] == pytest.approx(f * r["i_sym_momentary_ka"], rel=1e-3)

    def test_low_xr_keeps_1_6(self):
        comps = [_c("u", "utility", {"voltage_kv": 13.8, "fault_mva": 1000, "x_r_ratio": 10}),
                 _c("b", "bus", {"voltage_kv": 13.8})]
        r = run_ansi_fault_analysis(_p(comps, [("u", "out", "b", "at_0")]))["buses"]["b"]
        assert r["i_asym_momentary_ka"] == pytest.approx(1.6 * r["i_sym_momentary_ka"], rel=1e-3)


class TestAN7DeadBoard:
    """[AN7] Motors on a board isolated by an open breaker are not running."""

    def test_isolated_board_has_no_fault_current(self):
        comps = [
            _c("u", "utility", {"voltage_kv": 4.16, "fault_mva": 150, "x_r_ratio": 12}),
            _c("b", "bus", {"voltage_kv": 4.16}),
            _c("cbo", "cb", {"state": "open"}),
            _c("d", "bus", {"voltage_kv": 4.16}),
            _c("m2", "motor_induction", {"rated_kw": 800, "voltage_kv": 4.16}),
        ]
        links = [("u", "out", "b", "at_0"), ("b", "at_1", "cbo", "top"),
                 ("cbo", "bottom", "d", "at_0"), ("d", "at_1", "m2", "in")]
        r = run_ansi_fault_analysis(_p(comps, links))["buses"]["d"]
        # Pre-fix: 0.85 kA from the stopped motor
        assert r["i_sym_momentary_ka"] == 0.0
        assert "De-energized" in r["warning"]


class TestLesserNotes:
    def test_utility_reactance_split_by_xr(self):
        """[AN-L1] X/R 3 source: X = |Z|·3/√10, E/X 5.4 % above the old X = |Z|."""
        comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 200, "x_r_ratio": 3}),
                 _c("b", "bus", {"voltage_kv": 11})]
        r = run_ansi_fault_analysis(_p(comps, [("u", "out", "b", "at_0")]))["buses"]["b"]
        xu, _ = _utility_xr(200, 3)
        assert r["i_sym_interrupting_ka"] == pytest.approx(_ibase(11) / xu, rel=1e-4)

    def test_cable_resistance_at_20c(self):
        """[AN-L2] X/R uses the 20 °C cable resistance (the IEC maximum-study
        basis), not the 90 °C library value. Cu XLPE: R90/R20 = 1 + 0.00393·70."""
        comps = [
            _c("u", "utility", {"voltage_kv": 11, "fault_mva": 1e6, "x_r_ratio": 1e4}),
            _c("a", "bus", {"voltage_kv": 11}),
            _c("k", "cable", {"standard_type": "cu_xlpe_240_mv", "r_per_km": 0.0982,
                              "x_per_km": 0.1, "length_km": 2.0, "voltage_kv": 11}),
            _c("b", "bus", {"voltage_kv": 11}),
        ]
        links = [("u", "out", "a", "at_0"), ("a", "at_1", "k", "from"), ("k", "to", "b", "at_0")]
        r = run_ansi_fault_analysis(_p(comps, links))["buses"]["b"]
        r20 = 0.0982 / (1 + 0.00393 * 70)
        assert r["x_r_interrupting"] == pytest.approx(0.1 / r20, rel=5e-3)
