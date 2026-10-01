"""Line coupling review — regression tests for LC1 (and the Carson anchors).

References are taken from outside the module: IEC 60909-3:2009 eq. (34)–(36)
and Table 2 (earth-return depth δ), and an independent 6-conductor
phase-domain Carson model of a double-circuit line, never the engine's own
output. IDs match the ``[LC1]`` markers in ``backend/analysis/line_coupling.py``,
``fault.py`` and ``unbalanced_loadflow.py``. Write-up: reviews/LINE_COUPLING_REVIEW.md.
"""

import math
import types

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import line_coupling as LC
from backend.analysis.fault import run_fault_analysis
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


DOG = {"construction": "overhead", "overhead_type": "acsr_dog", "r_per_km": 0.2733,
       "x_per_km": 0.35, "r0_per_km": 0.424, "x0_per_km": 1.225, "length_km": 10,
       "voltage_kv": 11, "rated_amps": 305}


def _net(lines, cbs=False, load=None):
    """Grid → bus A → feeder(s) → bus B. With ``cbs`` each feeder has a CB at
    both ends; ``cbs`` may be a set of CB ids to leave open."""
    comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10,
                                 "z0_z1_ratio": 1.0}),
             _c("A", "bus", {"voltage_kv": 11}), _c("B", "bus", {"voltage_kv": 11})]
    wires = [_w("0", "u", "A")]
    for k, p in enumerate(lines):
        lid = f"L{k}"
        comps.append(_c(lid, "cable", dict(p, name=lid)))
        if cbs:
            open_ids = cbs if isinstance(cbs, set) else set()
            for end, bus in (("a", "A"), ("b", "B")):
                cid = f"cb{k}{end}"
                comps.append(_c(cid, "cb", {"state": "open" if cid in open_ids else "closed"}))
                wires += [_w(f"{cid}1", bus, cid), _w(f"{cid}2", cid, lid)]
        else:
            wires += [_w(f"a{k}", "A", lid), _w(f"b{k}", lid, "B")]
    if load:
        comps.append(_c("ld", "static_load", load))
        wires.append(_w("ld", "B", "ld"))
    return ProjectData(projectName="t", baseMVA=100, frequency=50, components=comps, wires=wires)


def _ik1(p):
    return run_fault_analysis(p, fault_bus_id="B", fault_type="slg").buses["B"].ik1


class TestCarsonAnchors:
    """IEC 60909-3:2009 Table 2 (δ at 50 Hz) and eq. (36) δ = 1.851/√(ωμ0/ρ)."""

    @pytest.mark.parametrize("rho,delta", [(10000, 9300), (1000, 2950), (100, 931), (20, 420)])
    def test_table_2(self, rho, delta):
        # Table 2 is rounded to 2–3 figures (eq. 36 gives 416.5 m for 420 m);
        # the exact check is test_equation_36.
        assert LC.earth_return_depth_m(rho, 50) == pytest.approx(delta, rel=1e-2)

    def test_equation_36(self):
        rho = 250.0
        eq36 = 1.851 / math.sqrt(2 * math.pi * 50 * 4e-7 * math.pi / rho)
        assert LC.earth_return_depth_m(rho, 50) == pytest.approx(eq36, rel=1e-3)

    def test_earth_return_resistance(self):
        # μ0ω/8 = 0.0493 Ω/km at 50 Hz (IEC 60909-3 eq. 34/35); Z0m carries 3×.
        assert LC.mutual_z0_per_km(8, 100, 50).real == pytest.approx(3 * 0.04935, rel=1e-3)


def _carson(pos, gmr_rc, rho, f=50.0):
    """Phase-domain Carson matrix (Ω/km), no earth wire."""
    de = 658.87 * math.sqrt(rho / f)
    re, k = math.pi ** 2 * f * 1e-4, 4 * math.pi * f * 1e-4
    n = len(pos)
    Z = np.zeros((n, n), complex)
    for i in range(n):
        for j in range(n):
            if i == j:
                gmr, rc = gmr_rc[i]
                Z[i, j] = rc + re + 1j * k * math.log(de / gmr)
            else:
                Z[i, j] = re + 1j * k * math.log(de / math.dist(pos[i], pos[j]))
    return Z


class TestLC1DrawnParallelFeeders:
    """Two overhead feeders drawn between the same buses got no zero-sequence
    coupling — the plain Z0/2 divide — so one double-circuit line gave a 36 %
    higher earth-fault current drawn as two feeders than as num_parallel = 2."""

    def test_drawn_pair_equals_num_parallel(self):
        coupled = _ik1(_net([dict(DOG, num_parallel=2)]))
        drawn = _ik1(_net([dict(DOG), dict(DOG)]))
        uncoupled = _ik1(_net([dict(DOG, num_parallel=2, z0_coupling="none")]))
        assert drawn == pytest.approx(coupled, rel=1e-3)
        assert uncoupled > 1.3 * coupled        # pre-fix drawn value (1.706 vs 1.254 kA)

    def test_through_closed_breakers(self):
        assert _ik1(_net([dict(DOG), dict(DOG)], cbs=True)) == pytest.approx(
            _ik1(_net([dict(DOG, num_parallel=2)])), rel=1e-3)

    def test_open_breaker_leaves_the_other_circuit_alone(self):
        # One circuit switched out at one end: the other is a single circuit.
        assert _ik1(_net([dict(DOG), dict(DOG)], cbs={"cb1b"})) == pytest.approx(
            _ik1(_net([dict(DOG)])), rel=1e-3)

    def test_none_opts_out(self):
        assert _ik1(_net([dict(DOG), dict(DOG, z0_coupling="none")])) == pytest.approx(
            _ik1(_net([dict(DOG, num_parallel=2, z0_coupling="none")])), rel=1e-3)

    def test_underground_not_coupled(self):
        cab = {k: v for k, v in DOG.items() if k not in ("construction", "overhead_type")}
        assert _ik1(_net([dict(cab), dict(cab)])) == pytest.approx(
            _ik1(_net([dict(cab, num_parallel=2)])), rel=1e-3)

    def test_non_identical_pair_vs_phase_domain(self):
        """Dog + Wolf on one 22 kV pole: group Z0 and each circuit's current
        share against the 6-conductor phase-domain solution."""
        a = [(-0.9, 11), (-0.9, 12.2), (-0.9, 13.4)]
        b = [(0.9, 11), (0.9, 12.2), (0.9, 13.4)]
        Z = _carson(a + b, [(0.0054, 0.2733)] * 3 + [(0.0078, 0.1871)] * 3, 100)
        Y = np.linalg.inv(Z)
        exact, share_exact = 3 / Y.sum(), Y[:3].sum() / Y.sum()
        za = 3 / np.linalg.inv(Z[:3, :3]).sum()
        zb = 3 / np.linalg.inv(Z[3:, 3:]).sum()
        gmd = math.prod(math.dist(p, q) for p in a for q in b) ** (1 / 9)

        def feeder(cid, z):
            return types.SimpleNamespace(id=cid, type="cable", props={
                "construction": "overhead", "length_km": 1.0, "circuit_spacing_m": gmd,
                "soil_resistivity_ohm_m": 100, "_z": z})
        comps = {"a": feeder("a", za), "b": feeder("b", zb),
                 "b1": types.SimpleNamespace(id="b1", type="bus", props={}),
                 "b2": types.SimpleNamespace(id="b2", type="bus", props={})}
        adj = {"a": ["b1", "b2"], "b": ["b1", "b2"], "b1": ["a", "b"], "b2": ["a", "b"]}

        @LC.drawn_coupling_scope
        def run():
            LC.set_drawn_coupling(comps, adj, lambda c: c.props["_z"])
            return LC.equivalent_z0_ohm("a"), LC.equivalent_z0_ohm("b")
        ea, eb = run()
        group = 1 / (1 / ea + 1 / eb)
        assert abs(group) == pytest.approx(abs(exact), rel=1e-3)
        assert abs((1 / ea) / (1 / ea + 1 / eb)) == pytest.approx(abs(share_exact), rel=1e-3)

    def test_disclosed(self):
        r = run_fault_analysis(_net([dict(DOG), dict(DOG)]), fault_bus_id="B", fault_type="slg")
        assert any("share a tower" in a for a in r.study_assumptions)

    def test_scope_does_not_leak(self):
        run_fault_analysis(_net([dict(DOG), dict(DOG)]))
        assert LC.equivalent_z0_ohm("L0") is None

    def test_unbalanced_load_flow_agrees(self):
        load = {"rated_kva": 800, "power_factor": 0.9, "phase_connection": "1P-A"}
        v0 = lambda p: run_unbalanced_load_flow(p).buses["B"].v0_pu
        drawn = v0(_net([dict(DOG), dict(DOG)], load=load))
        coupled = v0(_net([dict(DOG, num_parallel=2)], load=load))
        uncoupled = v0(_net([dict(DOG), dict(DOG, z0_coupling="none")], load=load))
        assert drawn == pytest.approx(coupled, rel=1e-3)
        assert abs(uncoupled - coupled) > 1e-4
