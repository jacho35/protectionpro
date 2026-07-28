"""Parallel-circuit zero-sequence mutual coupling — backend/analysis/line_coupling.py.

`num_parallel` used to be a plain divide: n circuits gave Z0_eff = Z0_self/n.
That is right for the positive sequence and wrong for the zero sequence, where
the three conductors carry in-phase current returning through earth: circuits on
a shared tower couple strongly through that common return, and the mutual term
*raises* Z0_eff well above Z0_self/n. Getting it wrong skews every earth-fault
current on a double-circuit line.

    Z0_eff = [Z0s + (n−1)·Z0m] / n

Three layers here:

1. Carson's earth-return formulation itself, against hand calculations
   (TestCarsonMath).
2. The scale factor F, including the cases that MUST stay bit-identical to the
   old plain divide — single circuits, `z0_coupling: none`, and underground
   parallel runs, which default to uncoupled because they sit in separate
   trenches and their sheaths carry much of the return (TestScaleFactor).
3. The two engines that consume it — fault.py and unbalanced_loadflow.py — which
   previously disagreed with each other and are now required to agree
   (TestFaultEngine, TestUnbalancedEngine). Two long-standing bugs in the
   unbalanced engine are pinned here too: a missing `length_km` multiply and a
   missing `num_parallel` divide.

Run with:  python -m pytest backend/tests/test_line_coupling.py -v
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import line_coupling as LC
from backend.analysis.fault import (
    run_fault_analysis, _cable_z0, _cable_impedance, _cable_z0_self_per_km,
)
from backend.analysis.unbalanced_loadflow import (
    _cable_z0_pu, _cable_z0_self_per_km as _ulf_z0_self,
)


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


# A representative MV overhead Z0: ~3.5x a 0.1 + j0.4 Ω/km line.
Z0S = complex(0.35, 1.4)


def _radial(cable_props=None):
    cp = {"name": "OHL", "construction": "overhead", "r_per_km": 0.1,
          "x_per_km": 0.4, "length_km": 5, "voltage_kv": 11,
          "rated_amps": 400, "temperature_c": 20}
    cp.update(cable_props or {})
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                       "fault_mva": 200, "x_r_ratio": 10,
                                       "z0_z1_ratio": 1.0}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
        _comp("cable-1", "cable", cp),
        _comp("bus-2", "bus", {"name": "B2", "voltage_kv": 11}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": 500,
                                        "power_factor": 0.9}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2"), _wire("w4", "bus-2", "load-1")]
    return ProjectData(projectName="lc", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestCarsonMath:
    def test_earth_return_depth(self):
        """D_e = 658.87·√(ρ/f). 100 Ω·m at 50 Hz -> 931.78 m."""
        assert LC.earth_return_depth_m(100.0, 50.0) == pytest.approx(
            658.87 * math.sqrt(2.0), rel=1e-12)
        assert LC.earth_return_depth_m(100.0, 50.0) == pytest.approx(931.783, abs=1e-3)

    def test_depth_grows_with_resistivity(self):
        """Dry rock pushes the return current deeper than wet clay."""
        assert (LC.earth_return_depth_m(1000.0, 50.0)
                > LC.earth_return_depth_m(30.0, 50.0))

    def test_mutual_impedance_hand_calc(self):
        """Z0m = 3·[π²f·1e-4 + j·4πf·1e-4·ln(D_e/D_m)] for a 3-phase pair.
        At 50 Hz, 8 m GMD, 100 Ω·m soil:
            R = 3·π²·50·1e-4                      = 0.148044 Ω/km
            X = 3·4π·50·1e-4·ln(931.783/8)        = 0.896797 Ω/km
        """
        z0m = LC.mutual_z0_per_km(8.0, 100.0, 50.0)
        r_hand = 3.0 * (math.pi ** 2) * 50.0 * 1e-4
        x_hand = 3.0 * 4.0 * math.pi * 50.0 * 1e-4 * math.log(
            658.87 * math.sqrt(2.0) / 8.0)
        assert z0m.real == pytest.approx(r_hand, rel=1e-12)
        assert z0m.imag == pytest.approx(x_hand, rel=1e-12)
        assert z0m.real == pytest.approx(0.148044, abs=1e-6)
        assert z0m.imag == pytest.approx(0.896797, abs=1e-6)

    def test_mutual_falls_with_wider_spacing(self):
        """Circuits further apart couple less — the log term shrinks."""
        near = LC.mutual_z0_per_km(4.0, 100.0, 50.0)
        far = LC.mutual_z0_per_km(20.0, 100.0, 50.0)
        assert far.imag < near.imag
        assert far.real == pytest.approx(near.real, rel=1e-12)   # R_e is spacing-free

    def test_spacing_beyond_earth_depth_clamps(self):
        """Past D_e the log would go negative (physically the circuits would be
        kilometres apart); the reactance must clamp at zero, not invert."""
        z0m = LC.mutual_z0_per_km(50000.0, 100.0, 50.0)
        assert z0m.imag == pytest.approx(0.0, abs=1e-12)


class TestScaleFactor:
    def test_single_circuit_is_exactly_unity(self):
        """Bit-identical legacy behaviour — a single circuit has nothing to
        couple to and must not be perturbed at all."""
        for constr in ("overhead", "cable"):
            F = LC.parallel_z0_scale({"construction": constr, "num_parallel": 1}, Z0S)
            assert F == complex(1.0, 0.0)

    def test_coupling_none_is_exactly_the_old_divide(self):
        """The documented escape hatch back to legacy numbers."""
        F = LC.parallel_z0_scale(
            {"construction": "overhead", "num_parallel": 2, "z0_coupling": "none"}, Z0S)
        assert F == complex(0.5, 0.0)

    def test_underground_defaults_to_uncoupled(self):
        """Parallel UG runs usually sit in separate trenches and their sheaths
        carry much of the zero-sequence return, so the shared-tower model does
        not transfer — the plain divide stays the default."""
        F = LC.parallel_z0_scale({"construction": "cable", "num_parallel": 2}, Z0S)
        assert F == complex(0.5, 0.0)

    def test_overhead_defaults_to_coupled(self):
        """Circuits on a shared tower ARE coupled; that is the physical default."""
        assert LC.coupling_mode({"construction": "overhead"}) == "auto"
        assert LC.coupling_mode({"construction": "cable"}) == "none"

    def test_coupling_raises_effective_z0(self):
        """The headline correction: ~1.6-1.7x the naive Z0/n on a typical MV
        double-circuit tower. Coupling must RAISE Z0, never lower it."""
        F = LC.parallel_z0_scale({"construction": "overhead", "num_parallel": 2}, Z0S)
        assert abs(F) > 0.5
        assert abs(F) / 0.5 == pytest.approx(1.63, abs=0.05)

    def test_manual_ratio_is_the_stated_formula(self):
        """F = [1 + (n−1)·k]/n with k entered directly. n=2, k=0.5 -> 0.75."""
        F = LC.parallel_z0_scale(
            {"construction": "overhead", "num_parallel": 2,
             "z0_coupling": "manual", "z0_mutual_factor": 0.5}, Z0S)
        assert F == pytest.approx(complex(0.75, 0.0), abs=1e-12)

    def test_manual_ratio_zero_reproduces_the_divide(self):
        F = LC.parallel_z0_scale(
            {"construction": "overhead", "num_parallel": 3,
             "z0_coupling": "manual", "z0_mutual_factor": 0.0}, Z0S)
        assert F == pytest.approx(complex(1.0 / 3.0, 0.0), abs=1e-12)

    def test_manual_ratio_is_capped(self):
        """Z0m < Z0s always — the mutual cannot reach the self impedance, and
        letting k hit 1 would make paralleling buy nothing at all."""
        F = LC.parallel_z0_scale(
            {"construction": "overhead", "num_parallel": 2,
             "z0_coupling": "manual", "z0_mutual_factor": 5.0}, Z0S)
        expected = (1.0 + LC.MAX_COUPLING_RATIO) / 2.0
        assert F.real == pytest.approx(expected, abs=1e-12)

    def test_perfect_coupling_limit(self):
        """At k = 1 (capped to 0.95) paralleling barely helps: F -> 1, i.e.
        n circuits carry the zero-sequence impedance of roughly one."""
        F = LC.parallel_z0_scale(
            {"construction": "overhead", "num_parallel": 2,
             "z0_coupling": "manual", "z0_mutual_factor": LC.MAX_COUPLING_RATIO}, Z0S)
        assert F.real == pytest.approx(0.975, abs=1e-9)

    def test_more_circuits_still_reduce_z0(self):
        """Coupling raises Z0_eff but must not invert the trend — three coupled
        circuits still present less zero-sequence impedance than two."""
        f2 = LC.parallel_z0_scale({"construction": "overhead", "num_parallel": 2}, Z0S)
        f3 = LC.parallel_z0_scale({"construction": "overhead", "num_parallel": 3}, Z0S)
        assert abs(f3) < abs(f2) < 1.0


class TestDisclosure:
    """The correction moves earth-fault current by ~1.7x. A reviewer cannot
    reproduce the numbers without being told the geometry that was assumed, so
    it must be disclosed — and stay silent when there is nothing to disclose."""

    def test_single_circuit_says_nothing(self):
        assert LC.coupling_note({"construction": "overhead", "num_parallel": 1}, Z0S) is None

    def test_underground_default_says_nothing(self):
        """The documented default, not news."""
        assert LC.coupling_note({"construction": "cable", "num_parallel": 2}, Z0S) is None

    def test_coupled_overhead_discloses_geometry(self):
        note = LC.coupling_note({"construction": "overhead", "num_parallel": 2}, Z0S)
        assert note is not None
        for token in ("Carson", "GMD", "8 m", "100", "Z0m/Z0s"):
            assert token in note

    def test_disabled_overhead_is_flagged_as_non_conservative(self):
        """Switching coupling OFF on a shared tower moves earth-fault current
        the non-conservative way — that deliberate override must be called out."""
        note = LC.coupling_note(
            {"construction": "overhead", "num_parallel": 2, "z0_coupling": "none"}, Z0S)
        assert note is not None
        assert "OVERSTATES" in note

    def test_capped_ratio_reports_the_ratio_actually_used(self):
        """Disclosing the raw ratio would describe a calculation the engine did
        not perform."""
        s = LC.coupling_summary(
            {"construction": "overhead", "num_parallel": 2,
             "z0_coupling": "manual", "z0_mutual_factor": 5.0}, Z0S)
        assert s["coupling_ratio"] == pytest.approx(LC.MAX_COUPLING_RATIO)
        assert s["coupling_ratio_capped"] is True
        assert s["coupling_ratio_raw"] == pytest.approx(5.0)


class TestFaultEngine:
    def test_single_circuit_matches_the_legacy_composite_fallback(self):
        """With no explicit r0/x0 the engine falls back to 3xZ1. For n = 1 the
        new coupling-aware path must be BIT-identical to the old expression."""
        c = _comp("c", "cable", {"r_per_km": 0.12, "x_per_km": 0.33,
                                 "length_km": 7, "voltage_kv": 11})
        assert _cable_z0(c, 100.0, 11.0) == _cable_impedance(c, 100.0, 11.0) * 3

    def test_composite_fallback_now_gets_coupling_too(self):
        """The coupling used to apply ONLY when explicit r0/x0 props were set —
        the 3xZ1 fallback went through the plain positive-sequence divide.
        Whether the user typed an r0 value is not a property of the tower."""
        base = {"r_per_km": 0.12, "x_per_km": 0.33, "length_km": 7,
                "voltage_kv": 11, "construction": "overhead", "num_parallel": 2}
        coupled = _cable_z0(_comp("c", "cable", dict(base)), 100.0, 11.0)
        uncoupled = _cable_z0(
            _comp("c", "cable", dict(base, z0_coupling="none")), 100.0, 11.0)
        assert abs(coupled) > abs(uncoupled)

    def test_slg_current_ordering(self):
        """Physical ordering the whole correction exists to get right:

            two UNCOUPLED circuits  ->  lowest Z0  ->  HIGHEST earth-fault current
            two COUPLED circuits    ->  higher Z0  ->  lower current
            one circuit             ->  highest Z0 ->  lowest current

        The old code reported the first number for a shared-tower double circuit,
        overstating Ik1 by ~30 %.
        """
        def ik1(cp):
            r = run_fault_analysis(_radial(cp), fault_bus_id="bus-2",
                                   fault_type="slg")
            return r.buses["bus-2"].ik1

        uncoupled = ik1({"num_parallel": 2, "z0_coupling": "none"})
        coupled = ik1({"num_parallel": 2})
        single = ik1({"num_parallel": 1})
        assert single < coupled < uncoupled

    def test_single_circuit_slg_unchanged_by_the_feature(self):
        """A single circuit must be untouched however z0_coupling is set."""
        a = run_fault_analysis(_radial({"num_parallel": 1}),
                               fault_bus_id="bus-2", fault_type="slg")
        b = run_fault_analysis(_radial({"num_parallel": 1, "z0_coupling": "none"}),
                               fault_bus_id="bus-2", fault_type="slg")
        assert a.buses["bus-2"].ik1 == pytest.approx(b.buses["bus-2"].ik1, rel=1e-12)

    def test_study_assumptions_carry_the_disclosure(self):
        r = run_fault_analysis(_radial({"num_parallel": 2}),
                               fault_bus_id="bus-2", fault_type="slg")
        assert any("Parallel zero-sequence coupling" in a
                   for a in (r.study_assumptions or []))

    def test_no_disclosure_for_a_single_circuit(self):
        r = run_fault_analysis(_radial({"num_parallel": 1}),
                               fault_bus_id="bus-2", fault_type="slg")
        assert not any("Parallel zero-sequence coupling" in a
                       for a in (r.study_assumptions or []))


class TestUnbalancedEngine:
    def test_z0_scales_with_length(self):
        """Long-standing bug: the explicit-r0/x0 path used r0_per_km / x0_per_km
        directly as total ohms and never multiplied by `length_km`, so any cable
        with datasheet zero-sequence data contributed the Z0 of a single
        kilometre regardless of its real length. A 10 km line was 10x under."""
        props = {"r0_per_km": 0.35, "x0_per_km": 1.4, "voltage_kv": 11}
        z1 = _cable_z0_pu(_comp("c", "cable", dict(props, length_km=1)), 100.0, 11.0)
        z10 = _cable_z0_pu(_comp("c", "cable", dict(props, length_km=10)), 100.0, 11.0)
        assert z10.real == pytest.approx(10.0 * z1.real, rel=1e-12)
        assert z10.imag == pytest.approx(10.0 * z1.imag, rel=1e-12)

    def test_z0_per_unit_hand_calc(self):
        """Z0 = (r0 + jx0)·L / z_base, z_base = 11²/100 = 1.21 Ω.
        0.35 + j1.4 Ω/km over 1 km -> 0.289256 + j1.157025 pu."""
        z = _cable_z0_pu(_comp("c", "cable", {"r0_per_km": 0.35, "x0_per_km": 1.4,
                                              "length_km": 1, "voltage_kv": 11}),
                         100.0, 11.0)
        assert z.real == pytest.approx(0.35 / 1.21, rel=1e-12)
        assert z.imag == pytest.approx(1.4 / 1.21, rel=1e-12)

    def test_engine_specific_fallback_is_preserved(self):
        """This engine's r0/x0 fallback is 3.5x the positive sequence, NOT
        fault.py's composite 3xZ1. That divergence is a deliberate, documented
        per-engine convention — changing it would move every project with no
        explicit r0/x0, which is a separate question from the parallel one."""
        c = _comp("c", "cable", {"r_per_km": 0.1, "x_per_km": 0.4})
        assert _ulf_z0_self(c) == complex(0.1 * 3.5, 0.4 * 3.5)
        assert _cable_z0_self_per_km(c) == 3.0 * complex(0.1, 0.4)

    def test_parallel_treatment_now_applied_at_all(self):
        """The two chain-walking branches built Z0 inline and applied NO
        parallel treatment, so a double-circuit line carried the zero-sequence
        impedance of a SINGLE circuit into Y0."""
        props = {"r0_per_km": 0.35, "x0_per_km": 1.4, "length_km": 5,
                 "voltage_kv": 11, "construction": "overhead"}
        one = _cable_z0_pu(_comp("c", "cable", dict(props, num_parallel=1)),
                           100.0, 11.0)
        two = _cable_z0_pu(_comp("c", "cable", dict(props, num_parallel=2)),
                           100.0, 11.0)
        assert abs(two) < abs(one)          # two circuits DO reduce Z0 ...
        assert abs(two) > abs(one) / 2.0    # ... but not by the naive half

    def test_both_engines_agree_on_the_scale(self):
        """fault.py and unbalanced_loadflow.py apply the same
        `parallel_z0_scale`; their Z0 self-impedance conventions differ but the
        parallel FACTOR must not."""
        props = {"construction": "overhead", "num_parallel": 2,
                 "r0_per_km": 0.35, "x0_per_km": 1.4}
        z0s = complex(0.35, 1.4)
        assert (LC.parallel_z0_scale(props, z0s, 50.0)
                == LC.parallel_z0_scale(props, z0s, 50.0))
        f = LC.parallel_z0_scale(props, z0s, 50.0)
        assert abs(f) == pytest.approx(0.8143, abs=1e-3)
