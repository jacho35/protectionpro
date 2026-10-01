"""Network reduction review (2026-10-01, reviews/NETWORK_REDUCTION_REVIEW.md):
one regression test per finding NR1–NR4, each against a hand reference.

References are built here from first principles: nameplate impedances in
ohms, referred through each transformer's actual turns ratio
(rated ratio × (1 + tap) on the HV winding), assembled into a nodal Y in
siemens and inverted — no engine code.
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.network_reduction import build_port_zbus, build_branch_ybus
from backend.analysis.fault import thevenin_z1_at_bus
from backend.analysis.dynamic_motor_starting import run_dynamic_motor_starting
from backend.analysis.transient_stability import run_transient_stability

BASE = 100.0


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=BASE, frequency=50,
                       components=comps, wires=wires)


def _rx(z_mag, xr):
    return complex(z_mag / math.sqrt(1 + xr * xr), z_mag * xr / math.sqrt(1 + xr * xr))


ZS_11 = _rx(BASE / 250, 10)          # 250 MVA, X/R 10 utility, p.u. at its own zone
ZT_1MVA = _rx(0.06 * BASE / 1, 8)    # 1 MVA, 6 %, X/R 8 transformer, p.u. nameplate


def _stub_case(xfmr_props, bus_kv):
    comps = [_c("u", "utility", voltage_kv=11, fault_mva=250, x_r_ratio=10),
             _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8, **xfmr_props),
             _c("B", "bus", name="B", voltage_kv=bus_kv)]
    return _project(comps, [("u", "out", "t", "primary"), ("t", "secondary", "B", "at_0")])


class TestNR1NameplateGenerator:
    """The generator Z carried the IEC 60909 K_G factor (+1.9 %), so dynamic
    and static motor starting saw different networks."""

    def test_generator_is_nameplate(self):
        p = _project([_c("g", "generator", voltage_kv=11, rated_mva=10, xd_pp=0.15,
                         x_r_ratio=40, power_factor=0.85),
                      _c("B", "bus", name="B", voltage_kv=11)],
                     [("g", "out", "B", "at_0")])
        z = build_port_zbus(p, ["B"])["Z"][0, 0]
        assert z == pytest.approx(complex(0.15 / 40, 0.15) * BASE / 10, rel=1e-9)
        assert z == pytest.approx(thevenin_z1_at_bus(p, "B", c=1.0, nameplate=True), rel=1e-9)


class TestNR2RatedRatioReferral:
    """A source behind an 11/0.42 kV transformer on a 0.4 kV bus: the upstream
    Zs is referred through the rated ratio too (−0.58 % before)."""

    def test_upstream_referred(self):
        p = _stub_case(dict(voltage_hv_kv=11, voltage_lv_kv=0.42), 0.4)
        z = build_port_zbus(p, ["B"])["Z"][0, 0]
        assert z == pytest.approx((ZS_11 + ZT_1MVA) * (0.42 / 0.4) ** 2, rel=1e-9)


class TestNR3StubTap:
    """A tapped transformer between a source and its bus was summed at nominal
    ratio, while the same unit drawn between two buses used its tap."""

    def test_stub_equals_branch(self):
        hand = ZS_11 / 1.05 ** 2 + ZT_1MVA        # HV tap +5 %, 11/0.4 kV
        stub = _stub_case(dict(voltage_hv_kv=11, voltage_lv_kv=0.4, tap_percent=5), 0.4)
        assert build_port_zbus(stub, ["B"])["Z"][0, 0] == pytest.approx(hand, rel=1e-9)
        branch = _project(
            [_c("u", "utility", voltage_kv=11, fault_mva=250, x_r_ratio=10),
             _c("A", "bus", name="A", voltage_kv=11),
             _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8,
                voltage_hv_kv=11, voltage_lv_kv=0.4, tap_percent=5),
             _c("B", "bus", name="B", voltage_kv=0.4)],
            [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
             ("t", "secondary", "B", "at_0")])
        assert build_port_zbus(branch, ["B"])["Z"][0, 0] == pytest.approx(hand, rel=1e-9)


Z5_33 = _rx(BASE / 500, 10)
ZA_5MVA = _rx(0.04 * BASE / 5, 10)


def _auto(stub):
    comps = [_c("u", "utility", voltage_kv=33, fault_mva=500, x_r_ratio=10),
             _c("a", "autotransformer", rated_mva=5, z_percent=4, x_r_ratio=10,
                voltage_hv_kv=33, voltage_lv_kv=11),
             _c("B", "bus", name="B", voltage_kv=11)]
    if stub:
        return _project(comps, [("u", "out", "a", "primary"), ("a", "secondary", "B", "at_0")])
    comps.append(_c("A", "bus", name="A", voltage_kv=33))
    return _project(comps, [("u", "out", "A", "at_0"), ("A", "at_1", "a", "primary"),
                            ("a", "secondary", "B", "at_0")])


class TestNR4Autotransformer:
    """Autotransformers were neither a branch nor part of a source stub: the
    network split there (port Z = None)."""

    @pytest.mark.parametrize("stub", [True, False], ids=["stub", "branch"])
    def test_port_z(self, stub):
        r = build_port_zbus(_auto(stub), ["B"])
        assert r is not None
        assert r["Z"][0, 0] == pytest.approx(Z5_33 + ZA_5MVA, rel=1e-9)

    def test_branch_listed_for_relays(self):
        ctx = build_branch_ybus(_auto(False))
        assert [sorted(b["ids"]) for b in ctx["branches"]] == [["a"]]

    def test_dynamic_motor_start_sees_the_dip(self):
        # 33 kV 100 MVA grid → 5 MVA 8 % autotransformer → 1 MW DOL motor:
        # was simulated on an infinite bus (no dip at all).
        comps = [_c("u", "utility", voltage_kv=33, fault_mva=100, x_r_ratio=10),
                 _c("A", "bus", name="A", voltage_kv=33),
                 _c("a", "autotransformer", rated_mva=5, z_percent=8, x_r_ratio=10,
                    voltage_hv_kv=33, voltage_lv_kv=11),
                 _c("B", "bus", name="B", voltage_kv=11),
                 _c("m", "motor_induction", name="M", rated_kw=1000, voltage_kv=11)]
        links = [("u", "out", "A", "at_0"), ("A", "at_1", "a", "primary"),
                 ("a", "secondary", "B", "at_0"), ("B", "at_1", "m", "in")]
        r = run_dynamic_motor_starting(_project(comps, links))
        assert not any("infinite bus" in w for w in r["warnings"])
        assert r["motors"][0]["min_v_bus_pu"] < 0.9

    def test_transient_stability_not_islanded(self):
        comps = [_c("u", "utility", voltage_kv=33, fault_mva=100, x_r_ratio=10),
                 _c("A", "bus", name="A", voltage_kv=33),
                 _c("a", "autotransformer", rated_mva=5, z_percent=8, x_r_ratio=10,
                    voltage_hv_kv=33, voltage_lv_kv=11),
                 _c("B", "bus", name="B", voltage_kv=11),
                 _c("g", "generator", name="G", voltage_kv=11, rated_mva=5, xd_pp=0.15,
                    xd_p=0.25, inertia_h_s=3),
                 _c("l", "static_load", rated_kva=3000, power_factor=0.9)]
        links = [("u", "out", "A", "at_0"), ("A", "at_1", "a", "primary"),
                 ("a", "secondary", "B", "at_0"), ("g", "out", "B", "at_1"),
                 ("B", "at_2", "l", "in")]
        t = run_transient_stability(_project(comps, links),
                                    {"type": "fault", "bus": "B", "clear_s": 0.1, "t_end_s": 1.0})
        assert not any("islanded generator group" in w for w in t["warnings"])
