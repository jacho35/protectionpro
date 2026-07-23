"""[EE-10] Exact series two-port reduction for a chain containing ONE tapped
transformer sharing its branch with one or more cables (no bus between
them) — backend/analysis/loadflow.py::_reduce_chain_two_port.

Two layers of verification:

1. TestReduceChainTwoPortMath — the Kron-elimination algorithm itself,
   checked against an independently hand-derived closed form (elimination
   of the single internal chain node by Gaussian elimination, worked out
   from scratch in each test's docstring/comments — not a re-run of the
   function under test).

2. TestExactVsExplicitBus — end-to-end run_load_flow cross-validation: a
   network with the cable+transformer sharing one lumped chain (the case
   this fix targets) must reproduce, to high numerical precision, the SAME
   network with an explicit intermediate bus drawn between the cable and
   the transformer — which is already exact under the pre-existing code
   (each becomes its own simple, unshared 2-terminal branch). This is
   literally the "draw a bus at the transformer terminal" workaround the
   old warning told users to apply — the fix must make that workaround
   unnecessary, not just silence the warning.

Run with:  python -m pytest backend/tests/test_ee10_two_port.py -v
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import run_load_flow, _reduce_chain_two_port


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires, base_mva=100.0):
    return ProjectData(projectName="ee10", baseMVA=base_mva, frequency=50,
                       components=components, wires=wires)


class TestReduceChainTwoPortMath:
    """Hand-derived Kron-elimination anchors. All three sub-cases use the
    same cable (r=0.01, x=0.02 pu directly, via v_kv=1/base_mva=1 so
    z_base=1) and the same transformer (rated_mva=1, z_percent=10,
    x_r_ratio=10 -> z_T from the SAME formula _get_impedance itself uses,
    reproduced here independently) and t=1.075, differing only in cable
    position and hv_bus_id — exercising both node orderings and both
    canonical-form branches.
    """

    def _z_t(self):
        z_pu = (10.0 / 100) * 1.0 / 1.0
        x_pu = z_pu * 10.0 / math.sqrt(1 + 10.0 ** 2)
        r_pu = x_pu / 10.0
        return complex(r_pu, x_pu)

    def _elems(self):
        cable = _comp("c1", "cable", {"r_per_km": 0.01, "x_per_km": 0.02,
                                      "length_km": 1.0})
        xfmr = _comp("tx", "transformer", {"rated_mva": 1.0, "z_percent": 10.0,
                                           "x_r_ratio": 10.0})
        return cable, xfmr

    def test_cable_before_transformer_hv_bus_a(self):
        """bus_a --[z_c]-- P --[ideal 1:t, z_T at secondary]-- bus_b, HV
        faces bus_a (P is the transformer's own HV terminal).

        Eliminating P from the 3-node system:
          Y[a,a]=y_c, Y[a,P]=Y[P,a]=-y_c
          Y[P,P]=y_c+y_T/t^2, Y[P,b]=Y[b,P]=-y_T/t, Y[b,b]=y_T
          a' = y_c - y_c^2/(y_c+y_T/t^2)
          c' = y_c*y_T/t / (y_c+y_T/t^2)     (= -Y'[a,b])
          b' = y_T - (y_T/t)^2/(y_c+y_T/t^2)
        hv_bus_id=bus_a -> y_eff=b', t_eff=b'/c'.
        """
        cable, xfmr = self._elems()
        chain = [cable, xfmr]  # cable at index 0, xfmr at index 1
        t = 1.075
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            chain, 1, t, "bus_a", "bus_a", "bus_b", 1.0, 1.0, 1.0)

        z_c = complex(0.01, 0.02)
        z_t = self._z_t()
        y_c, y_t = 1 / z_c, 1 / z_t
        denom = y_c + y_t / (t * t)
        a_ = y_c - y_c * y_c / denom
        b_ = y_t - (y_t * y_t) / (t * t) / denom
        c_ = y_c * y_t / t / denom

        assert a_ * b_ == pytest.approx(c_ * c_, rel=1e-9)  # reciprocity sanity
        assert hv_eff == "bus_a"
        assert y_eff == pytest.approx(b_, rel=1e-9)
        assert t_eff == pytest.approx((b_ / c_).real, rel=1e-9)

    def test_cable_after_transformer_hv_bus_a(self):
        """bus_a --[ideal 1:t, z_T at secondary]-- Q --[z_c]-- bus_b, HV
        still faces bus_a (the cable now sits on the LV/bus_b side).

          Y[a,a]=y_T/t^2, Y[a,Q]=Y[Q,a]=-y_T/t
          Y[Q,Q]=y_T+y_c, Y[Q,b]=Y[b,Q]=-y_c, Y[b,b]=y_c
          a' = y_T/t^2 - (y_T/t)^2/(y_T+y_c)
          c' = y_T*y_c/t / (y_T+y_c)
          b' = y_c - y_c^2/(y_T+y_c)
        hv_bus_id=bus_a -> y_eff=b', t_eff=b'/c'.
        """
        cable, xfmr = self._elems()
        chain = [xfmr, cable]  # xfmr at index 0, cable at index 1
        t = 1.075
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            chain, 0, t, "bus_a", "bus_a", "bus_b", 1.0, 1.0, 1.0)

        z_c = complex(0.01, 0.02)
        z_t = self._z_t()
        y_c, y_t = 1 / z_c, 1 / z_t
        denom = y_t + y_c
        a_ = y_t / (t * t) - (y_t / t) ** 2 / denom
        b_ = y_c - y_c * y_c / denom
        c_ = y_t * y_c / t / denom

        assert a_ * b_ == pytest.approx(c_ * c_, rel=1e-9)
        assert hv_eff == "bus_a"
        assert y_eff == pytest.approx(b_, rel=1e-9)
        assert t_eff == pytest.approx((b_ / c_).real, rel=1e-9)

    def test_cable_before_transformer_hv_bus_b(self):
        """bus_a --[z_c]-- P --[LV of xfmr; ideal 1:t, HV faces bus_b]-- bus_b.

          Y[a,a]=y_c, Y[a,P]=Y[P,a]=-y_c
          Y[P,P]=y_c+y_T, Y[P,b]=Y[b,P]=-y_T/t, Y[b,b]=y_T/t^2
          a' = y_c - y_c^2/(y_c+y_T)
          c' = y_c*y_T/t / (y_c+y_T)
          b' = y_T/t^2 - (y_T/t)^2/(y_c+y_T)
        hv_bus_id=bus_b -> y_eff=a', t_eff=a'/c'.
        """
        cable, xfmr = self._elems()
        chain = [cable, xfmr]
        t = 1.075
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            chain, 1, t, "bus_b", "bus_a", "bus_b", 1.0, 1.0, 1.0)

        z_c = complex(0.01, 0.02)
        z_t = self._z_t()
        y_c, y_t = 1 / z_c, 1 / z_t
        denom = y_c + y_t
        a_ = y_c - y_c * y_c / denom
        c_ = y_c * y_t / t / denom
        b_ = y_t / (t * t) - (y_t / t) ** 2 / denom

        assert a_ * b_ == pytest.approx(c_ * c_, rel=1e-9)
        assert hv_eff == "bus_b"
        assert y_eff == pytest.approx(a_, rel=1e-9)
        assert t_eff == pytest.approx((a_ / c_).real, rel=1e-9)

    def test_no_cable_reduces_to_identity(self):
        """A chain with only the transformer (no cable) must reproduce the
        transformer's own (y, t) unchanged — no internal node to eliminate."""
        _, xfmr = self._elems()
        t = 1.075
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            [xfmr], 0, t, "bus_a", "bus_a", "bus_b", 1.0, 1.0, 1.0)
        z_t = self._z_t()
        assert y_eff == pytest.approx(1 / z_t, rel=1e-9)
        assert t_eff == pytest.approx(t, rel=1e-9)
        assert hv_eff == "bus_a"


class TestExactVsExplicitBus:
    """run_load_flow cross-validation: lumped chain (no bus between cable
    and transformer) vs. the same network with an explicit intermediate
    bus — the "draw a bus" workaround the old warning recommended. Cable
    voltage_kv is pinned explicitly on the component so both networks use
    an identical z_base regardless of which code path infers it."""

    XFMR_PROPS = {"rated_mva": 10.0, "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0,
                  "z_percent": 8.0, "x_r_ratio": 10.0, "tap_percent": 7.5}
    CABLE_PROPS = {"r_per_km": 0.2, "x_per_km": 0.15, "length_km": 2.0,
                   "voltage_kv": 33.0}

    def _lumped_cable_before(self):
        """busA(33kV) --cable-- tx --busB(11kV) -- no bus between cable+tx."""
        comps = [
            _comp("u1", "utility", {"voltage_kv": 33, "fault_mva": 500, "x_r_ratio": 15}),
            _comp("busA", "bus", {"voltage_kv": 33, "name": "A"}),
            _comp("c1", "cable", dict(self.CABLE_PROPS)),
            _comp("tx", "transformer", dict(self.XFMR_PROPS)),
            _comp("busB", "bus", {"voltage_kv": 11, "name": "B"}),
            _comp("ld", "static_load", {"rated_kva": 6000, "power_factor": 0.9, "voltage_kv": 11}),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "c1", "at_1", "from"),
            _wire("w3", "c1", "tx", "to", "primary"),
            _wire("w4", "tx", "busB", "secondary", "at_0"),
            _wire("w5", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def _explicit_bus_cable_before(self):
        """Same network, but busM(33kV) drawn between the cable and the
        transformer — the cable and the transformer each become their own
        unshared, already-exact simple branch."""
        comps = [
            _comp("u1", "utility", {"voltage_kv": 33, "fault_mva": 500, "x_r_ratio": 15}),
            _comp("busA", "bus", {"voltage_kv": 33, "name": "A"}),
            _comp("c1", "cable", dict(self.CABLE_PROPS)),
            _comp("busM", "bus", {"voltage_kv": 33, "name": "M"}),
            _comp("tx", "transformer", dict(self.XFMR_PROPS)),
            _comp("busB", "bus", {"voltage_kv": 11, "name": "B"}),
            _comp("ld", "static_load", {"rated_kva": 6000, "power_factor": 0.9, "voltage_kv": 11}),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "c1", "at_1", "from"),
            _wire("w3", "c1", "busM", "to", "at_0"),
            _wire("w4", "busM", "tx", "at_1", "primary"),
            _wire("w5", "tx", "busB", "secondary", "at_0"),
            _wire("w6", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def _lumped_cable_after(self):
        """busA(33kV) -- tx -- cable -- busB(11kV) -- cable now on the LV side."""
        comps = [
            _comp("u1", "utility", {"voltage_kv": 33, "fault_mva": 500, "x_r_ratio": 15}),
            _comp("busA", "bus", {"voltage_kv": 33, "name": "A"}),
            _comp("tx", "transformer", dict(self.XFMR_PROPS)),
            _comp("c1", "cable", {**self.CABLE_PROPS, "voltage_kv": 11.0,
                                  "r_per_km": 0.5, "x_per_km": 0.4, "length_km": 0.3}),
            _comp("busB", "bus", {"voltage_kv": 11, "name": "B"}),
            _comp("ld", "static_load", {"rated_kva": 6000, "power_factor": 0.9, "voltage_kv": 11}),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "tx", "at_1", "primary"),
            _wire("w3", "tx", "c1", "secondary", "from"),
            _wire("w4", "c1", "busB", "to", "at_0"),
            _wire("w5", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def _explicit_bus_cable_after(self):
        comps = [
            _comp("u1", "utility", {"voltage_kv": 33, "fault_mva": 500, "x_r_ratio": 15}),
            _comp("busA", "bus", {"voltage_kv": 33, "name": "A"}),
            _comp("tx", "transformer", dict(self.XFMR_PROPS)),
            _comp("busM", "bus", {"voltage_kv": 11, "name": "M"}),
            _comp("c1", "cable", {**self.CABLE_PROPS, "voltage_kv": 11.0,
                                  "r_per_km": 0.5, "x_per_km": 0.4, "length_km": 0.3}),
            _comp("busB", "bus", {"voltage_kv": 11, "name": "B"}),
            _comp("ld", "static_load", {"rated_kva": 6000, "power_factor": 0.9, "voltage_kv": 11}),
        ]
        wires = [
            _wire("w1", "u1", "busA", "out", "at_0"),
            _wire("w2", "busA", "tx", "at_1", "primary"),
            _wire("w3", "tx", "busM", "secondary", "at_0"),
            _wire("w4", "busM", "c1", "at_1", "from"),
            _wire("w5", "c1", "busB", "to", "at_0"),
            _wire("w6", "busB", "ld", "at_1", "in"),
        ]
        return _project(comps, wires)

    def test_cable_before_transformer_matches_explicit_bus(self):
        lumped = run_load_flow(self._lumped_cable_before())
        ref = run_load_flow(self._explicit_bus_cable_before())
        assert lumped.converged and ref.converged
        v_lumped = lumped.buses["busB"].voltage_pu
        v_ref = ref.buses["busB"].voltage_pu
        assert abs(v_lumped - v_ref) < 1e-5

    def test_cable_after_transformer_matches_explicit_bus(self):
        lumped = run_load_flow(self._lumped_cable_after())
        ref = run_load_flow(self._explicit_bus_cable_after())
        assert lumped.converged and ref.converged
        v_lumped = lumped.buses["busB"].voltage_pu
        v_ref = ref.buses["busB"].voltage_pu
        assert abs(v_lumped - v_ref) < 1e-5

    def test_fix_actually_changes_the_answer_vs_naive_lumped_sum(self):
        """Confirms the fix isn't a no-op: the OLD "sum every element's
        impedance, apply ONE tap stamp" result differs materially from the
        exact reduction for this network (tap 7.5% away from nominal)."""
        base_mva = 100.0
        v_a = 33.0
        z_base_a = (v_a ** 2) / base_mva
        r = self.CABLE_PROPS["r_per_km"] * self.CABLE_PROPS["length_km"]
        x = self.CABLE_PROPS["x_per_km"] * self.CABLE_PROPS["length_km"]
        z_c_naive = complex(r / z_base_a, x / z_base_a)

        rated_mva = self.XFMR_PROPS["rated_mva"]
        z_pct = self.XFMR_PROPS["z_percent"]
        xr = self.XFMR_PROPS["x_r_ratio"]
        z_pu = (z_pct / 100) * base_mva / rated_mva
        x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
        r_pu = x_pu / xr
        z_t = complex(r_pu, x_pu)

        y_naive = 1 / (z_c_naive + z_t)  # the OLD lumped-sum admittance

        cable = _comp("c1", "cable", dict(self.CABLE_PROPS))
        xfmr = _comp("tx", "transformer", dict(self.XFMR_PROPS))
        t = 1.075  # matches +7.5% tap at these voltage ratios (nominal ratio 3)
        y_eff, t_eff, hv_eff = _reduce_chain_two_port(
            [cable, xfmr], 1, t, "bus_a", "bus_a", "bus_b", v_a, 11.0, base_mva)

        assert abs(y_eff - y_naive) / abs(y_naive) > 0.005  # >0.5% — a real, not rounding-noise, difference
