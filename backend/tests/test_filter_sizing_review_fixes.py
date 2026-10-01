"""Passive filter sizing review (2026-10-01, reviews/FILTER_SIZING_REVIEW.md):
regression tests for FS1–FS2.

References: a hand single-tuned branch (X_eff = U²/Q, X_C = X_eff·h²/(h²−1),
X_L = X_C/h², R = X_C/h/Q) driven by a given bus spectrum — I_h = V_h/|Z(h)|,
U_Ch = I_h·X_C/h — and drive harmonic currents I_h = ratio·I_1.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.filter_sizing import (run_filter_sizing, _branch_elements,
                                            _capacitor_duty)


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestFS1DominantOrderByCurrent:
    """Orders were ranked by the SUM of per-unit spectrum ratios: a 20 kW
    6-pulse drive (5th = 0.35) outranked a 2 MW 12-pulse drive's 11th."""

    def test_large_drive_sets_the_first_branch(self):
        comps = [_c("u", "utility", voltage_kv=11, fault_mva=60, x_r_ratio=10),
                 _c("B", "bus", name="B", voltage_kv=11),
                 _c("d1", "vfd", rated_kw=2000, pulse_number=12, voltage_kv=11),
                 _c("d2", "vfd", rated_kw=20, pulse_number=6, input_reactor_pct=3, voltage_kv=11),
                 _c("L", "static_load", rated_kva=2000, power_factor=0.85)]
        links = [("u", "out", "B", "at_0"), ("B", "at_1", "d1", "in"),
                 ("B", "at_2", "d2", "in"), ("B", "at_3", "L", "in")]
        r = run_filter_sizing(_project(comps, links), max_branches=1)
        assert [d["harmonic_order"] for d in r["design"]] == [11]   # was [5]
        assert r["meets_ieee519"]


class TestFS2CapacitorDuty:
    """Nothing checked the capacitor of a tuned branch against IEC 60871-1 /
    60831-1 (1.10·U_N, 1.30·I_N, 1.35·Q_N)."""

    def test_duty_matches_hand_branch(self):
        el = _branch_elements(1000, 11.0, 4.7, 30, 50)
        x_c = 121.0 * 4.7 ** 2 / (4.7 ** 2 - 1)
        x_l, r = x_c / 4.7 ** 2, x_c / 4.7 / 30
        v_ph = 11 / math.sqrt(3)
        spec = {1: v_ph, 5: 0.02 * v_ph, 7: 0.01 * v_ph}
        i = {h: v / abs(complex(r, h * x_l - x_c / h)) for h, v in spec.items()}
        u = {h: i[h] * x_c / h * math.sqrt(3) for h in i}
        d = _capacitor_duty(11.0, 1.0, {"5": 2.0, "7": 1.0}, el)
        assert d["cap_u1_kv"] == pytest.approx(11 * 4.7 ** 2 / (4.7 ** 2 - 1), rel=1e-4)
        assert d["cap_u_rms_kv"] == pytest.approx(math.sqrt(sum(x * x for x in u.values())), rel=1e-4)
        assert d["cap_i_rms_a"] == pytest.approx(1000 * math.sqrt(sum(x * x for x in i.values())), rel=1e-4)
        assert d["cap_q_kvar"] == pytest.approx(
            math.sqrt(3) * sum(u[h] * i[h] for h in i) * 1000, rel=1e-4)
        u_n = d["cap_rated_kv"]
        assert u_n >= d["cap_u1_kv"] and d["cap_u_rms_kv"] <= 1.10 * u_n
        assert d["cap_rated_kvar"] == pytest.approx(u_n ** 2 / el["x_c_ohm"] * 1000, rel=1e-3)

    def test_overloaded_branch_is_flagged(self):
        # 3 MW 6-pulse drive, deliberately small 300 kvar 5th branch: the
        # capacitor current is 1.63 × rated (limit 1.30). Reported with no
        # warning before.
        comps = [_c("u", "utility", voltage_kv=11, fault_mva=100, x_r_ratio=10),
                 _c("B", "bus", name="B", voltage_kv=11),
                 _c("d", "vfd", rated_kw=3000, pulse_number=6, input_reactor_pct=3,
                    voltage_kv=11)]
        r = run_filter_sizing(_project(comps, [("u", "out", "B", "at_0"),
                                               ("B", "at_1", "d", "in")]),
                              total_kvar=300, max_branches=1)
        d = r["design"][0]
        assert d["cap_i_ratio"] > 1.30 and not d["cap_compliant"]
        assert any("capacitor duty" in w for w in r["warnings"])
