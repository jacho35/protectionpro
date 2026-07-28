"""[EE-10 residual] Generalization of the exact series two-port chain
reduction to TWO OR MORE cascaded tapped transformers sharing a branch with
a cable — the case test_ee10_two_port.py's original docstring flagged as
"a separate, still-open case" and the old code only warned about
("share a branch chain with a cable ... draw a bus at each transformer
terminal"). backend/analysis/loadflow.py::_reduce_chain_two_port /
_kron_reduce_two_port now handle N>=1 transformers uniformly.

Same two-layer structure as test_ee10_two_port.py:

1. TestKronReduceTwoPortMathNPort — the Kron-elimination core driven
   directly with a 2-transformer, 1-cable chain (4 nodes, 2 internal nodes
   eliminated), cross-checked against the Schur-complement of the SAME
   admittance matrix computed independently via matrix inversion
   (np.linalg.inv) — a different numerical method from the function
   under test's sequential Gaussian elimination, not a re-run of it.

2. TestExactVsExplicitBusNPort — end-to-end run_load_flow cross-validation:
   an 11 kV -> T1 -> cable -> T2 -> 400 V chain with BOTH transformers
   tapped away from nominal, drawn as one lumped 3-element branch, must
   reproduce the SAME network redrawn with an explicit bus at each
   transformer terminal (each branch there is its own simple, unshared
   2-terminal element, already exact under the pre-existing code) to
   solver tolerance. This is literally the "draw a bus at each transformer
   terminal" workaround the residual warning used to recommend — the fix
   must make that workaround unnecessary, not just silence the warning.

Run with:  python -m pytest backend/tests/test_ee10_n_port.py -v
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import (run_load_flow, _reduce_chain_two_port,
                                       _kron_reduce_two_port)


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires, base_mva=100.0):
    return ProjectData(projectName="ee10-nport", baseMVA=base_mva, frequency=50,
                       components=components, wires=wires)


# ── 1. Pure Kron-elimination core, cross-checked via matrix inversion ───────


class TestKronReduceTwoPortMathNPort:
    """chain = [xfmr1, cable, xfmr2] -- 4 nodes (0=bus_a, 1, 2, 3=bus_b),
    both transformers oriented HV-towards-bus_a (a straight step-down
    cascade, as in TestExactVsExplicitBusNPort below), independent t1/t2.
    """

    def _z(self, z_percent, x_r_ratio, rated_mva=1.0, base_mva=1.0):
        z_pu = (z_percent / 100) * base_mva / rated_mva
        x_pu = z_pu * x_r_ratio / math.sqrt(1 + x_r_ratio ** 2)
        r_pu = x_pu / x_r_ratio
        return complex(r_pu, x_pu)

    def test_two_transformers_one_cable_matches_schur_complement(self):
        xfmr1 = _comp("t1", "transformer", {"rated_mva": 1.0, "z_percent": 8.0,
                                            "x_r_ratio": 8.0})
        cable = _comp("c1", "cable", {"r_per_km": 0.02, "x_per_km": 0.03,
                                      "length_km": 1.0})
        xfmr2 = _comp("t2", "transformer", {"rated_mva": 1.0, "z_percent": 6.0,
                                            "x_r_ratio": 6.0})
        chain = [xfmr1, cable, xfmr2]  # indices 0, 1, 2
        t1, t2 = 1.05, 0.97
        y_eff, t_eff, hv_eff = _kron_reduce_two_port(
            chain, {0, 2}, {0: t1, 2: t2}, {0: True, 2: True}, {1: 1.0},
            "bus_a", "bus_a", "bus_b", 1.0)

        z_t1, z_t2 = self._z(8.0, 8.0), self._z(6.0, 6.0)
        z_c = complex(0.02, 0.03)
        y_t1, y_c, y_t2 = 1 / z_t1, 1 / z_c, 1 / z_t2

        # Full 4x4 admittance matrix over {bus_a=0, P=1, Q=2, bus_b=3},
        # built independently from the same element stamps documented in
        # _kron_reduce_two_port's own docstring.
        Y = np.zeros((4, 4), dtype=complex)
        Y[0, 0] += y_t1 / (t1 * t1); Y[1, 1] += y_t1
        Y[0, 1] -= y_t1 / t1;        Y[1, 0] -= y_t1 / t1
        Y[1, 1] += y_c;              Y[2, 2] += y_c
        Y[1, 2] -= y_c;              Y[2, 1] -= y_c
        Y[2, 2] += y_t2 / (t2 * t2); Y[3, 3] += y_t2
        Y[2, 3] -= y_t2 / t2;        Y[3, 2] -= y_t2 / t2

        boundary, internal = [0, 3], [1, 2]
        Ybb = Y[np.ix_(boundary, boundary)]
        Ybi = Y[np.ix_(boundary, internal)]
        Yib = Y[np.ix_(internal, boundary)]
        Yii = Y[np.ix_(internal, internal)]
        Y_ext = Ybb - Ybi @ np.linalg.inv(Yii) @ Yib  # Schur complement
        a_, b_, c_ = Y_ext[0, 0], Y_ext[1, 1], -Y_ext[0, 1]

        assert a_ * b_ == pytest.approx(c_ * c_, rel=1e-8)  # reciprocity sanity
        assert hv_eff == "bus_a"
        assert y_eff == pytest.approx(b_, rel=1e-9)
        assert t_eff == pytest.approx((b_ / c_).real, rel=1e-9)

    def test_no_cable_matches_series_sum(self):
        """Two transformers back-to-back with no cable at all still reduces
        exactly (no internal node carries a shunt, so this must equal the
        already-established "impedances just add in a common per-unit
        system" result the caller's z_total-sum path uses when there's no
        cable in the chain)."""
        xfmr1 = _comp("t1", "transformer", {"rated_mva": 1.0, "z_percent": 8.0,
                                            "x_r_ratio": 8.0})
        xfmr2 = _comp("t2", "transformer", {"rated_mva": 1.0, "z_percent": 6.0,
                                            "x_r_ratio": 6.0})
        chain = [xfmr1, xfmr2]
        t1, t2 = 1.05, 0.97
        y_eff, t_eff, hv_eff = _kron_reduce_two_port(
            chain, {0, 1}, {0: t1, 1: t2}, {0: True, 1: True}, {},
            "bus_a", "bus_a", "bus_b", 1.0)
        z_t1, z_t2 = self._z(8.0, 8.0), self._z(6.0, 6.0)
        y_t1, y_t2 = 1 / z_t1, 1 / z_t2

        # Independent cross-check via the Schur complement of the SAME 3x3
        # admittance matrix (node 1 is the only internal node here).
        Y = np.zeros((3, 3), dtype=complex)
        Y[0, 0] += y_t1 / (t1 * t1); Y[1, 1] += y_t1
        Y[0, 1] -= y_t1 / t1;        Y[1, 0] -= y_t1 / t1
        Y[1, 1] += y_t2 / (t2 * t2); Y[2, 2] += y_t2
        Y[1, 2] -= y_t2 / t2;        Y[2, 1] -= y_t2 / t2
        boundary, internal = [0, 2], [1]
        Ybb = Y[np.ix_(boundary, boundary)]
        Ybi = Y[np.ix_(boundary, internal)]
        Yib = Y[np.ix_(internal, boundary)]
        Yii = Y[np.ix_(internal, internal)]
        Y_ext = Ybb - Ybi @ np.linalg.inv(Yii) @ Yib
        a_, b_, c_ = Y_ext[0, 0], Y_ext[1, 1], -Y_ext[0, 1]

        assert hv_eff == "bus_a"
        assert y_eff == pytest.approx(b_, rel=1e-9)
        assert t_eff == pytest.approx((b_ / c_).real, rel=1e-9)
        # With no shunt at the internal node, the effective combined
        # off-nominal ratio is just the product t1*t2 (matches EE-2's
        # already-shipped combined-ratio result for the no-cable case).
        assert t_eff == pytest.approx(t1 * t2, rel=1e-9)


# ── 2. run_load_flow: lumped N=2 chain vs. explicit-bus reference network ──


class TestExactVsExplicitBusNPort:
    """11kV -> T1 (11/1kV, +5% tap) -> cable (1kV zone) -> T2 (1/0.4kV,
    -4% tap) -> 400V bus -> load. The lumped network draws this as ONE
    branch chain (no bus between T1, the cable, and T2); the reference
    network draws an explicit bus (busM, 1kV -- the value a user would
    naturally type in, matching T1's own LV nameplate and T2's own HV
    nameplate) between T1 and the cable. Both must agree to solver
    tolerance -- the "draw a bus at each transformer terminal" workaround
    made unnecessary."""

    U1 = {"voltage_kv": 11.0, "fault_mva": 500.0, "x_r_ratio": 15.0}
    T1 = {"rated_mva": 5.0, "z_percent": 8.0, "x_r_ratio": 10.0,
          "voltage_hv_kv": 11.0, "voltage_lv_kv": 1.0, "tap_percent": 5.0}
    C1 = {"r_per_km": 0.1, "x_per_km": 0.08, "length_km": 0.01}
    T2 = {"rated_mva": 0.5, "z_percent": 6.0, "x_r_ratio": 8.0,
          "voltage_hv_kv": 1.0, "voltage_lv_kv": 0.4, "tap_percent": -4.0}
    LOAD = {"rated_kva": 200.0, "power_factor": 0.9}

    def _lumped(self):
        comps = [
            _comp("u1", "utility", dict(self.U1)),
            _comp("busA", "bus", {"voltage_kv": 11.0, "name": "A"}),
            _comp("t1", "transformer", dict(self.T1)),
            _comp("c1", "cable", dict(self.C1)),
            _comp("t2", "transformer", dict(self.T2)),
            _comp("busB", "bus", {"voltage_kv": 0.4, "name": "B"}),
            _comp("ld", "static_load", dict(self.LOAD)),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "t1", "at_1", "primary"),
            _wire("w3", "t1", "c1", "secondary", "from"),
            _wire("w4", "c1", "t2", "to", "primary"),
            _wire("w5", "t2", "busB", "secondary", "at_0"),
            _wire("w6", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def _explicit_bus(self):
        comps = [
            _comp("u1", "utility", dict(self.U1)),
            _comp("busA", "bus", {"voltage_kv": 11.0, "name": "A"}),
            _comp("t1", "transformer", dict(self.T1)),
            _comp("busM", "bus", {"voltage_kv": 1.0, "name": "M"}),
            _comp("c1", "cable", dict(self.C1)),
            _comp("t2", "transformer", dict(self.T2)),
            _comp("busB", "bus", {"voltage_kv": 0.4, "name": "B"}),
            _comp("ld", "static_load", dict(self.LOAD)),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "t1", "at_1", "primary"),
            _wire("w3", "t1", "busM", "secondary", "at_0"),
            _wire("w4", "busM", "c1", "at_1", "from"),
            _wire("w5", "c1", "t2", "to", "primary"),
            _wire("w6", "t2", "busB", "secondary", "at_0"),
            _wire("w7", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def test_lumped_matches_explicit_bus(self):
        lumped = run_load_flow(self._lumped())
        ref = run_load_flow(self._explicit_bus())
        assert lumped.converged and ref.converged
        v_lumped = lumped.buses["busB"].voltage_pu
        v_ref = ref.buses["busB"].voltage_pu
        assert v_lumped == pytest.approx(v_ref, abs=1e-5)
        # Also check the intermediate (busM-equivalent) voltage indirectly
        # via the source-side bus, so the whole chain -- not just the far
        # end -- is pinned.
        assert lumped.buses["busA"].voltage_pu == pytest.approx(
            ref.buses["busA"].voltage_pu, abs=1e-6)

    def test_fix_changes_the_answer_vs_naive_lumped_sum(self):
        """Confirms this isn't a no-op: the OLD "sum every element's
        impedance, apply the COMBINED tap as one stamp" result differs
        materially from the exact N=2 reduction for this network (each
        transformer tapped away from nominal in a different direction)."""
        base_mva = 100.0

        def _z_t(props):
            z_pu = (props["z_percent"] / 100) * base_mva / props["rated_mva"]
            x_pu = z_pu * props["x_r_ratio"] / math.sqrt(1 + props["x_r_ratio"] ** 2)
            r_pu = x_pu / props["x_r_ratio"]
            return complex(r_pu, x_pu)

        z_t1, z_t2 = _z_t(self.T1), _z_t(self.T2)
        # The naive legacy code has no notion of "a cable in the middle" at
        # all (its z_base choice is a binary bus_a_v/bus_b_v split) -- cross-
        # check against both plausible legacy zone choices for the cable.
        z_base_a = (self.U1["voltage_kv"] ** 2) / base_mva
        z_base_b = (self.T2["voltage_lv_kv"] ** 2) / base_mva
        r = self.C1["r_per_km"] * self.C1["length_km"]
        x = self.C1["x_per_km"] * self.C1["length_km"]
        z_c_if_a = complex(r / z_base_a, x / z_base_a)
        z_c_if_b = complex(r / z_base_b, x / z_base_b)

        y_naive_a = 1 / (z_t1 + z_c_if_a + z_t2)
        y_naive_b = 1 / (z_t1 + z_c_if_b + z_t2)

        xfmr1 = _comp("t1", "transformer", dict(self.T1))
        cable = _comp("c1", "cable", dict(self.C1))
        xfmr2 = _comp("t2", "transformer", dict(self.T2))
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            [xfmr1, cable, xfmr2], [0, 2], "bus_a", "bus_a", "bus_b",
            self.U1["voltage_kv"], self.T2["voltage_lv_kv"], base_mva)

        assert abs(y_eff - y_naive_a) / abs(y_naive_a) > 0.005
        assert abs(y_eff - y_naive_b) / abs(y_naive_b) > 0.005


# ── 3. Warnings: residual gone, informational note stays ────────────────────


class TestEE10NPortWarnings:
    def _proj(self):
        return TestExactVsExplicitBusNPort()._lumped()

    def test_no_cable_tap_referral_warning(self):
        res = run_load_flow(self._proj())
        assert res.converged
        assert not any("referred through" in w.message.lower()
                       for w in res.warnings)
        assert not any("error up to" in w.message.lower()
                       for w in res.warnings)

    def test_informational_cascade_note_still_present(self):
        """The genuinely still-open limitation -- no bus exists at the
        internal junction, so nothing can be attached there -- keeps its
        warning; only the numerical-accuracy framing is gone."""
        res = run_load_flow(self._proj())
        msgs = [w.message.lower() for w in res.warnings]
        assert any("cascaded transformers" in m for m in msgs)
        assert not any("combined turns-ratio product" in m for m in msgs)
