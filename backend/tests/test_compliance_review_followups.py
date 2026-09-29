"""Compliance review follow-ups (COMPLIANCE_REVIEW.md §4).

1. A breaker's instantaneous total clearing time follows IEEE 1584 Table 1 —
   moulded-case integral trip (MCB, MCCB) 1.5 cycles = 0.025 s, LV power /
   insulated-case breaker (ACB) 3 cycles = 0.050 s — identically in the
   backend (arc flash, Cable Sizing) and the frontend (TCC, compliance). The
   backend used 50 ms and the frontend 20 ms for every type, so Cable Sizing
   failed a 4 mm² final circuit that the Compliance Report passed.
2. Cable Sizing's far-end minimum fault uses hot conductors (70 °C, IEC
   60909-0 §5.3.1), the same basis as the compliance minimum study. At 20 °C
   the far end of a 200 m 35 mm² Cu sub-main read 1222 A instead of 1026 A.
"""
import math
import re
from pathlib import Path

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.arcflash import _cb_self_clearing_time, _CB_INSTANTANEOUS_CLEAR_S
from backend.analysis.cable_sizing import run_cable_sizing
from backend.analysis.fault import run_fault_analysis

ROOT = Path(__file__).resolve().parents[2]


def _c(i, t, p):
    return Component(id=i, type=t, x=0, y=0, props=p)


def _w(i, a, b, fp="bottom", tp="top"):
    return Wire(id=i, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


class TestInstantaneousClearingTime:
    @pytest.mark.parametrize("cb_type,t", [("mcb", 0.025), ("mccb", 0.025), ("acb", 0.05)])
    def test_ieee1584_table1(self, cb_type, t):
        props = {"cb_type": cb_type, "trip_rating_a": 100, "thermal_pickup": 1.0,
                 "magnetic_pickup": 10, "long_time_delay": 10}
        assert _cb_self_clearing_time(props, 5000.0) == pytest.approx(t)

    def test_acb_instantaneous_element(self):
        props = {"cb_type": "acb", "trip_rating_a": 1000, "instantaneous_pickup": 8,
                 "magnetic_pickup": 10}
        assert _cb_self_clearing_time(props, 9000.0) == pytest.approx(0.05)

    def test_frontend_parity(self):
        js = (ROOT / "frontend" / "js" / "constants.js").read_text(encoding="utf-8")
        m = re.search(r"const CB_INSTANTANEOUS_CLEAR_S = \{([^}]*)\}", js)
        assert m, "CB_INSTANTANEOUS_CLEAR_S missing from constants.js"
        fe = {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", m.group(1))}
        assert fe == _CB_INSTANTANEOUS_CLEAR_S


def _sub_main():
    cable = {"name": "C-SubMain", "conductor": "Cu", "insulation": "PVC", "size_mm2": 35,
             "r_per_km": 0.524, "x_per_km": 0.08, "length_km": 0.2, "voltage_kv": 0.4,
             "rated_amps": 140, "num_parallel": 1}
    return ProjectData(projectName="x", baseMVA=100, frequency=50, components=[
        _c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
        _c("b11", "bus", {"name": "MV", "voltage_kv": 11}),
        _c("t", "transformer", {"name": "T1", "rated_mva": 1.0, "voltage_hv_kv": 11, "voltage_lv_kv": 0.42,
                                "z_percent": 5, "x_r_ratio": 8, "vector_group": "Dyn11",
                                "grounding_hv": "ungrounded", "grounding_lv": "solidly_grounded"}),
        _c("bA", "bus", {"name": "MSB", "voltage_kv": 0.4}),
        _c("cb", "cb", {"name": "CB", "cb_type": "mccb", "rated_current_a": 160, "trip_rating_a": 160,
                        "magnetic_pickup": 10, "thermal_pickup": 1, "long_time_delay": 10}),
        _c("k", "cable", cable),
        _c("bB", "bus", {"name": "DB-1", "voltage_kv": 0.4}),
    ], wires=[_w("1", "u", "b11"), _w("2", "b11", "t", tp="primary"), _w("3", "t", "bA", fp="secondary"),
              _w("4", "bA", "cb"), _w("5", "cb", "k"), _w("6", "k", "bB")])


class TestCableSizingMinimumStudyHot:
    def test_far_end_minimum_at_70c(self):
        p = _sub_main()
        hot = run_fault_analysis(p, voltage_factor=0.95, conductor_temperature_c=70).buses["bB"]
        cold = run_fault_analysis(p, voltage_factor=0.95).buses["bB"]
        i_hot = min(v for v in (hot.ik3, hot.ikLL, hot.ik1) if v and v > 0) * 1000
        i_cold = min(v for v in (cold.ik3, cold.ikLL, cold.ik1) if v and v > 0) * 1000
        assert i_hot < i_cold * 0.9            # hot conductors: materially lower
        row = run_cable_sizing(p)["cables"][0]
        msg = " ".join(row["issues"])
        assert f"({i_hot:.0f} A, c_min, 70 °C)" in msg, msg
        assert f"({i_cold:.0f} A" not in msg
