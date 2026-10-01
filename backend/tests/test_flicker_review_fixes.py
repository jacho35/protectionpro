"""Voltage flicker review (2026-10-01, reviews/FLICKER_REVIEW.md): one
regression test per finding FL1–FL5.

References are closed forms of the IEC 61000-3-3 analytical method:
t_f = 2.3·(F·d)^3.2 s per voltage change, Pst = (Σt_f / 600 s)^(1/3.2) in the
worst 10-minute window, Plt = (Σ Pst_i³ / 12)^(1/3) over two hours; and a hand
constant-impedance divider for d (Z_th = Zs + Zt at nameplate, c = 1).
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.flicker import run_flicker_analysis, _pst_plt
from backend.analysis.loadflow import run_load_flow

BASE = 100.0


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _lv_motor_project(starts_per_hour=12.0, motor=True, bus_kv=0.4, lv_kv=0.4, motor_kw=75):
    comps = [_c("u", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15),
             _c("M", "bus", name="M", voltage_kv=11),
             _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8,
                voltage_hv_kv=11, voltage_lv_kv=lv_kv, vector_group="Dyn11"),
             _c("B", "bus", name="B", voltage_kv=bus_kv),
             _c("L", "static_load", rated_kva=500, power_factor=0.9)]
    links = [("u", "out", "M", "at_0"), ("M", "at_1", "t", "primary"),
             ("t", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")]
    if motor:
        comps.append(_c("m", "motor_induction", name="M1", rated_kw=motor_kw, voltage_kv=bus_kv,
                        efficiency=0.93, power_factor=0.85, locked_rotor_current=6.0,
                        locked_rotor_pf=0.35, flicker_starts_per_hour=starts_per_hour,
                        starting_method="dol"))
        links.append(("B", "at_2", "m", "in"))
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=BASE, frequency=50,
                       components=comps, wires=wires)


def _tf(d):
    return 2.3 * d ** 3.2


class TestFL1WorstWindow:
    """Pst was a rate average: at 1 start/hour a 3 % step read 0.281, but the
    window holding that start has Pst = (t_f/600)^(1/3.2) = 0.527 (−47 %)."""

    @pytest.mark.parametrize("sph", [0.5, 1.0, 2.0, 4.0])
    def test_one_start_in_the_worst_window(self, sph):
        pst, _ = _pst_plt(3.0, sph)
        assert pst == pytest.approx((_tf(3.0) / 600) ** (1 / 3.2), rel=1e-12)

    def test_plt_from_twelve_windows(self):
        # 2 starts/h → 4 starts in 2 h, one in each of 4 windows.
        p1 = (_tf(3.0) / 600) ** (1 / 3.2)
        assert _pst_plt(3.0, 2.0)[1] == pytest.approx((4 * p1 ** 3 / 12) ** (1 / 3), rel=1e-12)


class TestFL2Anchor:
    """The curve fit put Pst = 1 at 3 % for one change a minute; the method
    puts it at 2.771 %, so a 3 % step at 60 starts/h is Pst 1.083 — a fail
    the old fit reported as exactly 1.000 (pass)."""

    def test_pst_one_point(self):
        d1 = (600 / (10 * 2.3)) ** (1 / 3.2)
        assert _pst_plt(d1, 60.0)[0] == pytest.approx(1.0, rel=1e-12)
        assert _pst_plt(3.0, 60.0)[0] == pytest.approx(1.0827, abs=1e-4)


class TestFL3VoltageChangeLimits:
    """d_max and d_c (IEC 61000-3-3 §5: 4 % and 3.3 % at LV) were not checked."""

    def test_d_c_is_the_running_step(self):
        p = _lv_motor_project()
        s = run_flicker_analysis(p)["sources"][0]
        v_off = run_load_flow(_lv_motor_project(motor=False)).buses["B"].voltage_pu
        v_on = run_load_flow(p).buses["B"].voltage_pu
        assert s["steady_voltage_change_pct"] == pytest.approx((v_off - v_on) * 100, abs=2e-3)
        assert s["d_max_limit_pct"] == 4.0 and s["d_c_limit_pct"] == 3.3

    def test_d_max_breach_fails_even_with_low_pst(self):
        # One start every 10 h: Pst/Plt small, but a > 4 % step still fails.
        p = _lv_motor_project(starts_per_hour=0.1, motor_kw=110)
        s = run_flicker_analysis(p)["sources"][0]
        assert s["relative_voltage_change_pct"] > 4.0
        assert s["pst_compliant"] and s["plt_compliant"]
        assert not s["d_max_compliant"] and not s["compliant"]


class TestFL4LimitsByVoltage:
    """LV limits were applied at every voltage."""

    def test_mv_planning_levels(self):
        p = _lv_motor_project(bus_kv=3.3, lv_kv=3.3)
        s = run_flicker_analysis(p)["sources"][0]
        assert (s["pst_limit"], s["plt_limit"]) == (0.9, 0.7)
        assert s["d_max_limit_pct"] is None

    def test_override_applies(self):
        s = run_flicker_analysis(_lv_motor_project(), pst_limit=2.0, plt_limit=2.0)["sources"][0]
        assert (s["pst_limit"], s["plt_limit"], s["limit_basis"]) == (2.0, 2.0, "user limit")


class TestFL5RelativeToNominal:
    """d was ΔV/V_pre; IEC 61000-3-3 §3 defines it on the nominal voltage."""

    def test_hand_divider(self):
        p = _lv_motor_project()
        s = run_flicker_analysis(p)["sources"][0]
        zs = BASE / 500
        zs = complex(zs / math.sqrt(226), zs * 15 / math.sqrt(226))
        zt = 0.06 * BASE
        zt = complex(zt / math.sqrt(65), zt * 8 / math.sqrt(65))
        v_pre = run_load_flow(_lv_motor_project(motor=False)).buses["B"].voltage_pu
        flc = 75 / (math.sqrt(3) * 0.4 * 0.93 * 0.85)
        s_start = math.sqrt(3) * 0.4 * 6 * flc / 1000 / BASE
        y = (s_start * complex(0.35, math.sqrt(1 - 0.35 ** 2))).conjugate()
        v_start = abs(v_pre / (1 + (zs + zt) * y))
        assert s["relative_voltage_change_pct"] == pytest.approx((v_pre - v_start) * 100, abs=2e-3)
