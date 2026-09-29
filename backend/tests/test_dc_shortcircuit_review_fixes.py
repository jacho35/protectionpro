"""Regression tests for the DC short-circuit review (DC_SHORTCIRCUIT_REVIEW.md).

Every expected value is derived from IEC 61660-1 (Annex A eq. 54–56 and the
battery clauses, as reproduced in CED Engineering E03-035 Examples 1 and 3) or
from circuit first principles — never from the engine's own output.

Cable fixtures store resistance the way the app's cable library does: at
operating temperature (20 °C value × 1.275, Cu XLPE 90 °C). IEC 61660-1 works
at 20 °C, so HOT(r20) is what a library cable of 20 °C resistance r20 carries.
"""

import math

import pytest

from backend.models.schemas import ProjectData
from backend.analysis.dc_shortcircuit import run_dc_short_circuit, _rectifier_partial


def HOT(r20_per_km):
    return r20_per_km * 1.275


def _c(cid, ctype, props):
    return {"id": cid, "type": ctype, "x": 0, "y": 0, "rotation": 0,
            "props": {"name": cid, **props}}


def _w(wid, a, b):
    return {"id": wid, "fromComponent": a, "fromPort": "p",
            "toComponent": b, "toPort": "p"}


def _bus(cid, v=120.0):
    return _c(cid, "bus", {"system": "dc", "voltage_dc_v": v})


def _bat(cid, r_mohm=20.0, l_uh=0.0, unb=120.0):
    return _c(cid, "dc_battery", {"nominal_v": unb, "internal_r_mohm": r_mohm,
                                  "internal_l_uh": l_uh})


def _cable(cid, loop_r20_ohm, loop_l_uh=0.0, npar=1):
    """A 1 km cable whose go-and-return loop is loop_r20_ohm at 20 °C."""
    x = loop_l_uh * 1e-6 / 2 * 2 * math.pi * 50
    return _c(cid, "cable", {"r_per_km": HOT(loop_r20_ohm / 2), "x_per_km": x,
                             "length_km": 1.0, "num_parallel": npar})


def _run(comps, wires, fault=None):
    return run_dc_short_circuit(
        ProjectData(projectName="t", components=comps, wires=wires, frequency=50),
        fault_bus_id=fault)


E = 1.05 * 120.0          # E_B = 1.05·U_nB


class TestDC1RectifierProcedure:
    """[DC1] A diode / thyristor bridge follows the IEC 61660-1 rectifier
    procedure from its AC supply; it was capped at 3× its rating (−86 %)."""

    def test_annex_a_reproduces_published_example_3(self):
        """CED E03-035 Example 3 at its published (rounded) ratios: R_N/X_N =
        0.24, R_DBr/R_N = 2, L_DBr/L_N = 0.392 → λ_D = 0.897, κ_D = 1.204,
        t_pD = 9.62 ms, τ_1D = 3.83 ms."""
        r_n, x_n = 0.0011, 0.0011 / 0.24
        l_n = x_n / (2 * math.pi * 50)
        ik, ip, tp, tau1 = _rectifier_partial(r_n, x_n, 120.0, 1.05, 2 * r_n,
                                              0.392 * l_n, 50)
        lam = ik / ((3 * math.sqrt(2) / math.pi) * 1.05 * 120
                    / (math.sqrt(3) * math.hypot(r_n, x_n)))
        assert lam == pytest.approx(0.897, abs=0.001)
        assert ip / ik == pytest.approx(1.204, abs=0.002)
        assert tp == pytest.approx(9.62, abs=0.01)
        assert tau1 == pytest.approx(3.83, abs=0.01)

    def _drawn(self, rtype="thyristor"):
        comps = [
            _c("u", "utility", {"voltage_kv": 0.48, "fault_mva": 30, "x_r_ratio": 6}),
            _c("acb", "bus", {"voltage_kv": 0.48}),
            _c("r", "rectifier", {"rated_kw": 100, "voltage_ac_kv": 0.48,
                                  "voltage_dc_v": 125, "rectifier_type": rtype,
                                  "tx_kva": 100, "tx_uk_pct": 3, "tx_xr": 4,
                                  "tx_secondary_v": 120, "l_dc_uh": 5}),
            _bus("D", 125), _cable("k", 0.002), _bus("F", 125),
        ]
        wires = [_w("1", "u", "acb"), _w("2", "acb", "r"), _w("3", "r", "D"),
                 _w("4", "D", "k"), _w("5", "k", "F")]
        return _run(comps, wires)

    def test_drawn_rectifier_uses_ac_supply_impedance(self):
        """Example 3 drawn: Z_Q = c·U²/S″k (c = 1.10, X/R 6) and Z_T = 3 %
        on 100 kVA (X/R 4), both at 120 V; R_DBr = 2 mΩ. Eq. 54 by hand."""
        c = 1.10
        zq = c * 480 ** 2 / 30e6
        rq = zq / math.sqrt(37)
        zt = 0.03 * 120 ** 2 / 100e3
        rt = zt / math.sqrt(17)
        k = (120 / 480) ** 2
        rn, xn = rq * k + rt, 6 * rq * k + 4 * rt
        rx, rd = rn / xn, 0.002 / rn
        lam = math.sqrt((1 + rx ** 2) / (1 + rx ** 2 * (1 + 2 / 3 * rd) ** 2))
        ik = lam * 3 * math.sqrt(2) / math.pi * c * 120 / (math.sqrt(3) * math.hypot(rn, xn))
        f = self._drawn().buses["F"]
        assert f.ik_ka == pytest.approx(ik / 1000, rel=1e-3)
        # ~22× the 833 A DC rating — never the old 3× cap.
        assert f.ik_ka > 15.0

    def test_igbt_converter_stays_current_limited(self):
        f = self._drawn("igbt").buses["F"]
        i_r = 100e3 / 125
        # Thevenin E = 125 V, R = 125/(3·I_r) plus the 2 mΩ loop.
        assert f.ik_ka == pytest.approx(125 / (125 / (3 * i_r) + 0.002) / 1000, rel=1e-3)


class TestDC2SourceBehindLeadCable:
    """[DC2] A battery wired to its bus through its own cable (no bus at the
    battery) was dropped: 0 A and a 'no source' warning."""

    def test_lead_cable_folded_into_the_source_branch(self):
        comps = [_bat("b", 20), _cable("lead", 0.010), _bus("A")]
        res = _run(comps, [_w("1", "b", "lead"), _w("2", "lead", "A")])
        assert res.buses["A"].ip_ka == pytest.approx(E / (0.018 + 0.010) / 1000, rel=1e-3)
        assert not res.warnings


class TestDC3ParallelCables:
    """[DC3] Two cables between the same buses kept only the lower-resistance
    one, and the answer depended on drawing direction (−26 %)."""

    @pytest.mark.parametrize("reverse", [False, True])
    def test_parallel_cables_add_conductance(self, reverse):
        comps = [_bat("b", 20), _bus("A"), _cable("k1", 0.020), _cable("k2", 0.020), _bus("B")]
        second = [_w("4", "B", "k2"), _w("5", "k2", "A")] if reverse else \
                 [_w("4", "A", "k2"), _w("5", "k2", "B")]
        res = _run(comps, [_w("1", "b", "A"), _w("2", "A", "k1"), _w("3", "k1", "B")] + second)
        assert res.buses["B"].ip_ka == pytest.approx(E / (0.018 + 0.010) / 1000, rel=1e-3)


class TestDC4TwentyDegreeResistance:
    """[DC4] IEC 61660-1 takes conductor resistance at 20 °C for the maximum;
    the library's 90 °C value read −12.5 % on a 50 m 95 mm² run."""

    def test_library_cable_referred_to_20C(self):
        L = 0.05
        comps = [_bat("b", 20, unb=125), _bus("A", 125),
                 _c("k", "cable", {"r_per_km": 0.2461, "x_per_km": 0.08,
                                   "length_km": L, "conductor": "Cu", "insulation": "XLPE"}),
                 _bus("F", 125)]
        res = _run(comps, [_w("1", "b", "A"), _w("2", "A", "k"), _w("3", "k", "F")])
        r20 = 2 * 0.2461 * L / 1.275
        assert res.buses["F"].ip_ka == pytest.approx(1.05 * 125 / (0.018 + r20) / 1000, rel=1e-3)

    def test_pvc_and_aluminium_factors(self):
        for props, factor in (({"insulation": "PVC"}, 1.20),
                              ({"conductor": "Al", "insulation": "XLPE"}, 1.282)):
            comps = [_bat("b", 20), _bus("A"),
                     _c("k", "cable", {"r_per_km": 0.1, "x_per_km": 0.0,
                                       "length_km": 0.1, **props}), _bus("F")]
            res = _run(comps, [_w("1", "b", "A"), _w("2", "A", "k"), _w("3", "k", "F")])
            r20 = 2 * 0.1 * 0.1 / factor
            assert res.buses["F"].ip_ka == pytest.approx(E / (0.018 + r20) / 1000, rel=1e-3)


class TestDC5CommonBranch:
    """[DC5] Sources sharing a common branch were each computed alone
    (+36 %). Millman: I_F = Σ(E/R_j) / (1 + R_Y·Σ1/R_j)."""

    def test_two_batteries_through_common_cable(self):
        comps = [_bat("b1", 20), _bat("b2", 20), _bus("A"), _cable("y", 0.010), _bus("F")]
        res = _run(comps, [_w("1", "b1", "A"), _w("2", "b2", "A"),
                           _w("3", "A", "y"), _w("4", "y", "F")])
        f = res.buses["F"]
        assert f.ip_ka == pytest.approx(E / (0.009 + 0.010) / 1000, rel=1e-3)
        assert f.ik_ka == pytest.approx(0.95 * E / (0.010 + 0.010) / 1000, rel=1e-3)
        # Contributions are the superposition shares and sum to the total.
        assert sum(c.ip_ka for c in f.contributions) == pytest.approx(f.ip_ka, abs=0.002)

    def test_no_common_branch_is_plain_sum(self):
        comps = [_bat("b1", 20), _bus("A"), _cable("y", 0.010), _bus("F"), _bat("b2", 20)]
        res = _run(comps, [_w("1", "b1", "A"), _w("2", "A", "y"),
                           _w("3", "y", "F"), _w("4", "b2", "F")])
        assert res.buses["F"].ip_ka == pytest.approx(
            (E / 0.028 + E / 0.018) / 1000, rel=1e-3)


class TestDC6BatteryRise:
    """[DC6] t_pB, τ_1B from 1/δ = 2/(R_BBr/L_BBr + 1/T_B) and IEC 61660-1
    Figure 10 (straight lines on log-log axes). Read off the figure's grid:
    t_pB ≈ 3 ms and τ_1B ≈ 0.5 ms at 1/δ = 1 ms; t_pB ≈ 50 ms at 1/δ = 20 ms."""

    def test_published_example_1_terminals(self):
        # R_BBr = 0.9·18.6 + 1.498 = 18.238 mΩ, L_BBr = 14.61 µH → 1/δ = 1.56 ms
        # (published). CED reads "around 4.3 ms" and 0.75 ms off the figure;
        # the figure's lines give ≈ 4.6 ms and ≈ 0.78 ms.
        comps = [_bat("b", 18.6, 14.61), _bus("A"), _cable("conn", 1.498e-3), _bus("T")]
        res = _run(comps, [_w("1", "b", "A"), _w("2", "A", "conn"), _w("3", "conn", "T")])
        t = res.buses["T"]
        assert t.ip_ka == pytest.approx(6.9086, abs=0.001)
        assert t.tp_ms == pytest.approx(4.6, rel=0.05)
        assert t.time_constant_ms == pytest.approx(0.78, rel=0.05)

    @pytest.mark.parametrize("inv_delta_ms,tp,tau1", [(1.0, 3.0, 0.5), (20.0, 50.0, 10.5)])
    def test_figure_10_grid_points(self, inv_delta_ms, tp, tau1):
        from backend.analysis.dc_shortcircuit import _battery_fig_tp_tau1
        got_tp, got_tau1 = _battery_fig_tp_tau1(inv_delta_ms)
        assert got_tp == pytest.approx(tp, rel=0.05)
        assert got_tau1 == pytest.approx(tau1, rel=0.05)

    def test_zero_inductance_is_not_a_30ms_rise(self):
        """With no inductance 1/δ = 0: T_B is a term of 1/δ, not a fallback
        rise time (the engine reported t_p = 50 ms, τ = 30 ms)."""
        res = _run([_bat("b", 20), _bus("A")], [_w("1", "b", "A")])
        assert res.buses["A"].tp_ms < 1.0


class TestL1ConverterVoltageBound:
    """[L1] A current-limited converter cannot drive more than U/R."""

    def test_charger_through_large_resistance(self):
        comps = [_c("ch", "charger", {"rated_a": 200, "voltage_dc_v": 125,
                                      "bridge_type": "switch_mode"}),
                 _bus("A", 125), _cable("k", 2.0), _bus("F", 125)]
        res = _run(comps, [_w("1", "ch", "A"), _w("2", "A", "k"), _w("3", "k", "F")])
        assert res.buses["F"].ik_ka == pytest.approx(125 / (125 / 300 + 2.0) / 1000, abs=5e-4)
        assert res.buses["F"].ik_ka * 1000 < 125 / 2.0
