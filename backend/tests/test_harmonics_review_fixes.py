"""Regression tests for the harmonics.py review (HARMONICS_REVIEW.md, H1–H6,
L1–L3). Each test reproduces the original defect; the expected numbers come
from IEEE 519-2014 Tables 2–4 or from a hand nodal solve, never from the
engine.
"""

import math

import numpy as np

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.harmonics import (
    _SPECTRA_6P_3PCT, _current_limit, _iec_ihd_limit, _iec_thd_limit,
    _tdd_limit, run_harmonics,
)
from backend.analysis.frequency_scan import run_frequency_scan


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="bottom", toComponent=b, toPort="top")


BASE = 10.0


def _project(pulse=6, kvar=250.0, load_kva=1000.0, vfd_kw=800.0, extra=(), extra_w=()):
    """Utility 250 MVA X/R 15 → 11 kV bus → 2 MVA 6 % X/R 10 → 0.4 kV bus
    with a VFD, a 0.85 pf static load and a PFC capacitor."""
    comps = [
        _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
        _c("bhv", "bus", {"name": "HV", "voltage_kv": 11}),
        _c("tx", "transformer", {"rated_mva": 2, "z_percent": 6, "x_r_ratio": 10,
                                 "voltage_hv_kv": 11, "voltage_lv_kv": 0.4}),
        _c("blv", "bus", {"name": "LV", "voltage_kv": 0.4}),
        _c("vfd", "vfd", {"name": "Drive", "rated_kw": vfd_kw, "voltage_kv": 0.4,
                          "efficiency": 0.96, "load_pct": 100, "displacement_pf": 0.98,
                          "pulse_number": pulse, "front_end": "diode",
                          "input_reactor_pct": 3}),
    ]
    wires = [_w("w1", "util", "bhv"), _w("w2", "bhv", "tx"), _w("w3", "tx", "blv"),
             _w("w4", "blv", "vfd")]
    if load_kva:
        comps.append(_c("ld", "static_load", {"name": "Load", "rated_kva": load_kva,
                                              "power_factor": 0.85, "voltage_kv": 0.4}))
        wires.append(_w("w5", "blv", "ld"))
    if kvar:
        comps.append(_c("cap", "capacitor_bank", {"rated_kvar": kvar, "voltage_kv": 0.4}))
        wires.append(_w("w6", "blv", "cap"))
    return ProjectData(projectName="h", baseMVA=BASE, frequency=50,
                       components=comps + list(extra), wires=wires + list(extra_w))


def _bus(res, name):
    return next(b for b in res["buses"] if b["name"] == name)


def _hand(res, extra_hv=lambda h: 0, lv_load=None):
    """Independent 2-bus nodal solve of _project(): LV IHD %, HV IHD % and
    the harmonic current into the utility, per order."""
    zs = BASE / 250
    xs = zs * 15 / math.sqrt(226)
    zt = 0.06 * BASE / 2
    xt = zt * 10 / math.sqrt(101)
    p, q = 0.085, 0.1 * math.sqrt(1 - 0.85 ** 2)
    if lv_load is None:
        lv_load = lambda h: p + 1 / complex(0, h / q)
    v_lv, v_hv = _bus(res, "LV")["v1_pu"], _bus(res, "HV")["v1_pu"]
    i1 = (800 / (0.96 * 1000)) / 0.98 / BASE / v_lv
    out = {}
    for h, ratio in _SPECTRA_6P_3PCT.items():
        ysrc = 1 / complex(xs / 15, h * xs)
        ytx = 1 / complex(xt / 10, h * xt)
        y = np.array([[ysrc + ytx + extra_hv(h), -ytx],
                      [-ytx, ytx + lv_load(h) + 1j * h * 0.25 / BASE]])
        v = np.linalg.solve(y, np.array([0, i1 * ratio]))
        out[h] = (100 * abs(v[1]) / v_lv, 100 * abs(v[0]) / v_hv, abs(v[0] * ysrc))
    return out


def _thd(vals):
    return math.sqrt(sum(v * v for v in vals))


class TestH1IndividualCurrentLimits:
    def test_12_pulse_eleventh_fails_though_tdd_passes(self):
        """[H1] IEEE 519 Table 2 limits each order. A 12-pulse drive that
        dominates the site puts the 11th at ~7.5 % of I_L against 5.5 %
        (Isc/IL 100–1000) while TDD (~9.6 %) is inside 15 %. The engine
        checked TDD only and reported compliant."""
        res = run_harmonics(_project(pulse=12, kvar=0, load_kva=100))
        pcc = res["pcc"]
        assert 100 <= pcc["isc_il"] < 1000
        assert pcc["i_tdd_pct"] < pcc["tdd_limit_pct"] == 15.0
        assert pcc["harmonics"]["11"] > 5.5
        assert pcc["harmonic_limits"]["11"] == 5.5
        assert 11 in pcc["exceeding_orders"]
        assert pcc["compliant"] is False and res["compliant"] is False

    def test_table_values_and_even_orders(self):
        """[H1] Table 2 bands, Table 3 = Table 2 halved, even orders 25 %."""
        assert _current_limit(5, 150, 11) == 12.0
        assert _current_limit(13, 150, 11) == 5.5
        assert _current_limit(19, 10, 11) == 1.5
        assert _current_limit(25, 2000, 11) == 2.5
        assert _current_limit(49, 30, 11) == 0.5
        assert _current_limit(5, 150, 132) == 6.0
        assert _current_limit(4, 150, 11) == 12.0 * 0.25
        assert _current_limit(51, 150, 11) is None


class TestH5Table4:
    def test_above_161kv_uses_table_4(self):
        """[H5] > 161 kV is IEEE 519 Table 4 (rows at 25 / 50, TDD 1.5 /
        2.5 / 3.75), not Table 2 × 0.25 — which gave 5.0 % above Isc/IL
        1000 (lenient) and 2.0 % at 20–25 (lenient)."""
        assert _tdd_limit(22, 220) == 1.5
        assert _tdd_limit(30, 220) == 2.5
        assert _tdd_limit(60, 220) == 3.75
        assert _tdd_limit(2000, 220) == 3.75
        assert _current_limit(5, 60, 220) == 3.0
        assert _current_limit(41, 10, 220) == 0.1
        assert _current_limit(40, 10, 220) == 0.1 * 0.25


class TestH2DistributionBoardLoad:
    def test_board_load_equals_static_load(self):
        """[H2] A distribution board's lumped load damps harmonics and counts
        in I_L exactly like the same static load. It was ignored: LV THD
        98 % instead of 11.3 %, TDD 306 % instead of 24.7 %."""
        ref = run_harmonics(_project())
        db = _c("db", "distribution_board", {"name": "DB", "voltage_kv": 0.4,
                                             "rated_kva": 1000, "power_factor": 0.85,
                                             "demand_factor": 1.0})
        cb = _c("cb", "cb", {"state": "closed"})
        res = run_harmonics(_project(load_kva=0, extra=[cb, db],
                                     extra_w=[_w("d1", "blv", "cb"), _w("d2", "cb", "db")]))
        assert math.isclose(_bus(res, "LV")["thd_v_pct"], _bus(ref, "LV")["thd_v_pct"], abs_tol=0.02)
        assert math.isclose(res["pcc"]["i_tdd_pct"], ref["pcc"]["i_tdd_pct"], abs_tol=0.02)
        assert math.isclose(res["pcc"]["isc_il"], ref["pcc"]["isc_il"], abs_tol=0.2)

    def test_frequency_scan_sees_board_load(self):
        """[H2] The frequency scan shares the shunt model: the board's load
        damps the parallel-resonance peak."""
        db = _c("db", "distribution_board", {"name": "DB", "voltage_kv": 0.4,
                                             "rated_kva": 1000, "power_factor": 0.85})
        with_db = _project(load_kva=0, extra=[db], extra_w=[_w("d1", "blv", "db")])
        without = _project(load_kva=0)
        a = run_frequency_scan(with_db)
        b = run_frequency_scan(without)
        pk = lambda r: max(x["z_ohm"] for x in r["resonances"]
                           if x["bus_name"] == "LV" and x["kind"] == "parallel")
        assert pk(a) < 0.5 * pk(b)


class TestH3Statcom:
    def test_statcom_is_its_coupling_reactance(self):
        """[H3] A STATCOM at harmonic orders is its coupling reactance
        X_c·h (0.15 pu on 50 Mvar here) — an inductive shunt. The palette
        default was modelled as a 50 Mvar capacitor."""
        svc = _c("svc", "svc", {"device_mode": "statcom", "control_mode": "voltage_regulating",
                                "q_max_mvar": 50, "q_min_mvar": -50, "coupling_x_pu": 0.15,
                                "rated_mvar": 50, "q_output_mvar": 0})
        res = run_harmonics(_project(extra=[svc], extra_w=[_w("ws", "bhv", "svc")]))
        hand = _hand(res, extra_hv=lambda h: 1 / complex(0, h * 0.15 * BASE / 50))
        assert math.isclose(_bus(res, "LV")["thd_v_pct"], _thd(v[0] for v in hand.values()), abs_tol=0.01)
        assert math.isclose(_bus(res, "HV")["thd_v_pct"], _thd(v[1] for v in hand.values()), abs_tol=0.01)

    def test_regulating_svc_uses_solved_q_not_rating(self):
        """[H3] A voltage-regulating SVC is its solved fundamental output as
        a susceptance (here ~0.66 Mvar holding the LV bus at 1.0 pu), not
        its 50 Mvar rating as capacitance."""
        from backend.analysis.loadflow import run_load_flow
        svc = _c("svc", "svc", {"device_mode": "svc", "control_mode": "voltage_regulating",
                                "v_setpoint_pu": 1.0, "rated_mvar": 50,
                                "q_max_mvar": 50, "q_min_mvar": -50})
        p = _project(extra=[svc], extra_w=[_w("ws", "blv", "svc")])
        q = run_load_flow(p, "newton_raphson").svc[0]["q_mvar"]
        assert 0.1 < q < 5
        res = run_harmonics(p)
        pp, qq = 0.085, 0.1 * math.sqrt(1 - 0.85 ** 2)
        hand = _hand(res, lv_load=lambda h: pp + 1 / complex(0, h / qq) + 1j * h * q / BASE)
        assert math.isclose(_bus(res, "LV")["thd_v_pct"], _thd(v[0] for v in hand.values()), abs_tol=0.01)


class TestH4DeadIsland:
    def test_drive_on_dead_island_is_not_a_source(self):
        """[H4] A drive behind an open breaker drew no fundamental current
        yet injected its spectrum; the dead bus reported V1 = 1.0 and a
        THD of 3e9 % with nothing else on it."""
        p = _project(kvar=0, load_kva=0)
        p.components.append(_c("cbo", "cb", {"state": "open"}))
        p.wires = [w for w in p.wires if w.id != "w3"] + [_w("a", "tx", "cbo"), _w("b", "cbo", "blv")]
        res = run_harmonics(p)
        assert res["buses"] == [] and res["compliant"] is True
        assert "Drive" in " ".join(res["warnings"])

    def test_live_study_unaffected_by_a_dead_drive(self):
        ref = run_harmonics(_project())
        p = _project(extra=[_c("cbo", "cb", {"state": "open"}),
                            _c("bd", "bus", {"name": "DEAD", "voltage_kv": 0.4}),
                            _c("vd", "vfd", {"name": "DeadDrive", "rated_kw": 500})],
                     extra_w=[_w("x1", "blv", "cbo"), _w("x2", "cbo", "bd"), _w("x3", "bd", "vd")])
        res = run_harmonics(p)
        assert [b["name"] for b in res["buses"]] == [b["name"] for b in ref["buses"]]
        assert _bus(res, "LV")["thd_v_pct"] == _bus(ref, "LV")["thd_v_pct"]


class TestH6DemandFactorZero:
    def test_zero_demand_factor_injects_nothing(self):
        """[H6] demand_factor 0 read as 1 (`or 1.0`) while the load flow
        read 0: the drive the load flow says draws nothing still injected."""
        p = _project()
        next(c for c in p.components if c.id == "vfd").props["demand_factor"] = 0
        res = run_harmonics(p)
        assert _bus(res, "LV")["thd_v_pct"] == 0.0


class TestL1L3:
    def test_pcc_current_is_the_utility_current(self):
        """[L1] A generator on the PCC bus is on the customer side: only the
        current into the utility is the PCC current."""
        g = _c("gen", "generator", {"rated_mva": 5, "xd_pp": 0.15, "x_r_ratio": 20, "voltage_kv": 11})
        res = run_harmonics(_project(extra=[g], extra_w=[_w("wg", "bhv", "gen")]))
        xg = 0.15 * BASE / 5
        hand = _hand(res, extra_hv=lambda h: 1 / complex(xg / 20, h * xg))
        il = ((800 / 0.96 / 1000) / 0.98 + 1.0) / BASE
        tdd = 100 * _thd(v[2] for v in hand.values()) / il
        assert math.isclose(res["pcc"]["i_tdd_pct"], tdd, abs_tol=0.01)

    def test_motor_fraction_is_an_x_pp_sink(self):
        """[L3] The rotating share of a lumped load is an induction-motor
        X″ = 1/LRC shunt; the rest stays parallel R-L."""
        p = _project()
        next(c for c in p.components if c.id == "ld").props.update(motor_fraction=0.5, motor_lrc_ratio=6)
        res = run_harmonics(p)
        pp, qq = 0.085, 0.1 * math.sqrt(1 - 0.85 ** 2)
        xm = (1 / 6) / (0.1 * 0.5)
        hand = _hand(res, lv_load=lambda h: 1 / complex(xm / 10, h * xm) + 0.5 * pp
                     + 1 / complex(0, h / (0.5 * qq)))
        assert math.isclose(_bus(res, "LV")["thd_v_pct"], _thd(v[0] for v in hand.values()), abs_tol=0.01)


class TestIecLimits:
    def test_curves_at_published_points(self):
        """IEC 61000-2-4 Class 2 (LV) and IEC 61000-3-6 planning levels
        (MV, HV-EHV) at their tabulated orders and formula ranges."""
        assert [_iec_ihd_limit(h, 0.4) for h in (5, 7, 11, 13, 3, 9)] == [6.0, 5.0, 3.5, 3.0, 5.0, 1.5]
        assert math.isclose(_iec_ihd_limit(17, 0.4), 2.0)
        assert [_iec_ihd_limit(h, 11) for h in (5, 7, 11, 13, 2)] == [5.0, 4.0, 3.0, 2.5, 1.8]
        assert math.isclose(_iec_ihd_limit(19, 11), 1.9 * 17 / 19 - 0.2)
        assert [_iec_ihd_limit(h, 132) for h in (5, 7, 11, 13)] == [2.0, 2.0, 1.5, 1.5]
        assert (_iec_thd_limit(0.4), _iec_thd_limit(11), _iec_thd_limit(132)) == (8.0, 6.5, 3.0)

    def test_iec_mode_grades_each_order_and_leaves_current_ungraded(self):
        """IEC mode: the LV bus fails at the 11th (7.6 % vs 3.5 %); the PCC
        current is reported but not graded; the method names IEC."""
        p = _project()
        p.harmonicsLimits = "iec"
        res = run_harmonics(p)
        lv = _bus(res, "LV")
        assert res["limits_standard"] == "iec" and "IEC 61000-3-6" in res["method"]
        assert lv["critical_order"] == 11 and lv["ihd_limit_pct"] == 3.5
        assert lv["thd_limit_pct"] == 8.0 and lv["compliant"] is False
        assert _bus(res, "HV")["limit_basis"].startswith("IEC 61000-3-6 MV")
        assert res["pcc"]["compliant"] is None and res["pcc"]["i_tdd_pct"] > 0

    def test_filter_sizing_stays_on_ieee519(self):
        """Filter sizing is labelled and designed to IEEE 519; the project's
        harmonics basis must not change its verdict."""
        from backend.analysis.filter_sizing import run_filter_sizing
        a = _project()
        b = _project()
        b.harmonicsLimits = "iec"
        ra, rb = run_filter_sizing(a), run_filter_sizing(b)
        assert ra["meets_ieee519"] == rb["meets_ieee519"]
        assert ra["with_filter"]["worst_thd_pct"] == rb["with_filter"]["worst_thd_pct"]
