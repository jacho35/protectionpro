"""Overhead-line conductor-temperature correction — backend/analysis/conductor_temp.py.

The two conductor libraries are quoted at different temperatures: `STANDARD_CABLES`
stores **hot** values (90 °C XLPE / 70 °C PVC, as cable datasheets publish them)
while `STANDARD_OVERHEAD_LINES` stores **20 °C** codeword values (BS 215 /
IEC 61089). The engines used both as-is, so in one study cables ran hot and
overhead ran cold and overhead losses / voltage drop came out ~15-25 % optimistic.
`R(T) = R20·[1 + α(T − 20)]` is now applied once, centrally, in a `ProjectData`
model validator.

Four properties have to hold for that to be safe, and each has its own class here:

1. The arithmetic is right, per material (TestResistanceArithmetic).
2. It is idempotent and re-targetable — re-validating or dump-and-rebuilding a
   project must recompute from the stored 20 °C base, never compound
   (TestIdempotence).
3. Saved projects stay byte-stable: `model_dump()` restores the library's 20 °C
   value and drops the bookkeeping keys, so the properties panel still matches
   the conductor library and a save/load round-trip does not drift
   (TestSerializerRoundTrip).
4. The two places that already scaled resistance do not now compound on top of
   it — the PS-3 minimum-fault study, and the conductor AREA that
   `cable_sizing` derives from a 20 °C resistivity and feeds to the adiabatic
   fault-withstand check (TestNoCompounding).

Run with:  python -m pytest backend/tests/test_conductor_temp.py -v
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import conductor_temp as CT
from backend.analysis.cable_sizing import RESISTIVITY, _get_cable_props
from backend.analysis.fault import run_fault_analysis


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _overhead_props(**over):
    p = {"name": "OHL", "construction": "overhead", "r_per_km": 0.1,
         "x_per_km": 0.4, "length_km": 5, "voltage_kv": 11, "rated_amps": 400}
    p.update(over)
    return p


def _radial(cable_props=None):
    """utility -> bus-1 -> overhead line -> bus-2 -> load."""
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                       "fault_mva": 200, "x_r_ratio": 10,
                                       "z0_z1_ratio": 1.0}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
        _comp("cable-1", "cable", _overhead_props(**(cable_props or {}))),
        _comp("bus-2", "bus", {"name": "B2", "voltage_kv": 11}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": 500,
                                        "power_factor": 0.9}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2"), _wire("w4", "bus-2", "load-1")]
    return ProjectData(projectName="ct", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestResistanceArithmetic:
    """R(T) = R20·[1 + α(T − 20)], hand-computed per material."""

    def test_acsr_at_default_75c(self):
        # 0.1 · [1 + 0.00403·(75 − 20)] = 0.1 · 1.22165
        assert CT.resistance_at(0.1, 75, "ACSR") == pytest.approx(0.122165, abs=1e-9)

    def test_material_coefficients_differ(self):
        """AAAC alloy has a lower tempco than pure/steel-reinforced aluminium,
        and copper lower still than ACSR — so the same R20 at the same
        temperature must NOT produce the same answer for all three."""
        r_acsr = CT.resistance_at(0.1, 75, "ACSR")     # α = 0.00403
        r_aaac = CT.resistance_at(0.1, 75, "AAAC")     # α = 0.00360
        r_cu = CT.resistance_at(0.1, 75, "COPPER")     # α = 0.00393
        assert r_aaac == pytest.approx(0.1 * (1 + 0.00360 * 55), abs=1e-9)
        assert r_cu == pytest.approx(0.1 * (1 + 0.00393 * 55), abs=1e-9)
        assert r_aaac < r_cu < r_acsr

    def test_unknown_material_falls_back_to_aluminium(self):
        assert CT.alpha_for("UNOBTAINIUM") == CT.DEFAULT_ALPHA
        assert CT.alpha_for(None) == CT.DEFAULT_ALPHA
        assert CT.alpha_for("  acsr  ") == 0.00403     # case/space insensitive

    def test_20c_is_the_identity(self):
        """`temperature_c = 20` must reproduce the old numbers EXACTLY — this
        is the escape hatch for anyone reproducing a pre-correction study."""
        assert CT.resistance_at(0.1234, 20, "ACSR") == pytest.approx(0.1234, abs=1e-12)

    def test_below_20c_reduces_resistance(self):
        """A cold line really does have lower resistance; the correction is not
        one-directional."""
        assert CT.resistance_at(0.1, -5, "ACSR") < 0.1

    def test_never_negative(self):
        """An absurd temperature must floor at zero, not go negative and invert
        the sign of every downstream impedance."""
        assert CT.resistance_at(0.1, -100000, "ACSR") == 0.0


class TestAppliesOnlyToOverhead:
    def test_underground_cable_untouched(self):
        """Cable library values are ALREADY at operating temperature —
        correcting them would double-count."""
        p = {"construction": "cable", "r_per_km": 0.1}
        assert CT.apply_to_props(p) is False
        assert p == {"construction": "cable", "r_per_km": 0.1}

    def test_missing_construction_treated_as_underground(self):
        """Legacy projects predate the `construction` prop; they must be left
        exactly as they were."""
        p = {"r_per_km": 0.1}
        assert CT.apply_to_props(p) is False
        assert p["r_per_km"] == 0.1

    def test_overhead_corrected(self):
        p = {"construction": "overhead", "r_per_km": 0.1, "material": "ACSR"}
        assert CT.apply_to_props(p) is True
        assert p["r_per_km"] == pytest.approx(0.122165, abs=1e-6)

    def test_zero_sequence_resistance_corrected_too(self):
        """R0 is a conductor resistance like any other — leaving it at 20 °C
        while R1 goes hot would make the sequence networks inconsistent."""
        p = {"construction": "overhead", "r_per_km": 0.1, "r0_per_km": 0.35,
             "material": "ACSR"}
        CT.apply_to_props(p)
        assert p["r0_per_km"] == pytest.approx(0.35 * 1.22165, abs=1e-6)

    def test_only_cable_components_walked(self):
        """apply_to_components keys off type == 'cable'; a transformer with a
        stray `construction` prop must not be touched."""
        comps = [{"type": "transformer", "props": {"construction": "overhead",
                                                   "r_per_km": 0.1}}]
        assert CT.apply_to_components(comps) == 0
        assert comps[0]["props"]["r_per_km"] == 0.1


class TestIdempotence:
    """The correction must recompute from the stored 20 °C base, never compound."""

    def test_second_apply_is_a_noop(self):
        p = {"construction": "overhead", "r_per_km": 0.1, "material": "ACSR"}
        assert CT.apply_to_props(p) is True
        first = p["r_per_km"]
        assert CT.apply_to_props(p) is False       # already at this temperature
        assert p["r_per_km"] == first

    def test_base_is_stashed_on_first_use(self):
        p = {"construction": "overhead", "r_per_km": 0.1, "r0_per_km": 0.35}
        CT.apply_to_props(p)
        assert p["_r20_per_km"] == 0.1
        assert p["_r0_20_per_km"] == 0.35
        assert p["_r_temp_applied_c"] == CT.DEFAULT_OVERHEAD_TEMP_C

    def test_retarget_recomputes_from_base_not_from_corrected(self):
        """Change `temperature_c` after a correction has been applied: the new
        value must come off R20, NOT off the already-corrected value. Compounding
        would give 0.1·1.22165·1.1209 = 0.13694 instead of 0.11209."""
        p = {"construction": "overhead", "r_per_km": 0.1, "material": "ACSR"}
        CT.apply_to_props(p)                        # -> 75 °C
        p["temperature_c"] = 50
        assert CT.apply_to_props(p) is True
        assert p["r_per_km"] == pytest.approx(0.1 * (1 + 0.00403 * 30), abs=1e-6)
        assert p["_r20_per_km"] == 0.1              # base never moved

    def test_revalidating_a_project_does_not_compound(self):
        """The validator runs on every ProjectData construction. Rebuilding from
        an already-corrected project must land on the same number."""
        p1 = _radial()
        r1 = p1.components[2].props["r_per_km"]
        p2 = ProjectData(**p1.model_dump())
        assert p2.components[2].props["r_per_km"] == pytest.approx(r1, abs=1e-12)
        p3 = ProjectData(**p2.model_dump())
        assert p3.components[2].props["r_per_km"] == pytest.approx(r1, abs=1e-12)

    def test_base_resistance_returns_the_20c_figure(self):
        p = {"construction": "overhead", "r_per_km": 0.1, "r0_per_km": 0.35}
        CT.apply_to_props(p)
        assert CT.base_resistance(p, "r_per_km") == 0.1
        assert CT.base_resistance(p, "r0_per_km") == 0.35

    def test_base_resistance_falls_back_when_uncorrected(self):
        """An underground cable has no stashed base — the live value IS the base."""
        assert CT.base_resistance({"r_per_km": 0.07}, "r_per_km") == 0.07


class TestValidatorWiring:
    def test_project_construction_applies_the_correction(self):
        p = _radial()
        assert p.components[2].props["r_per_km"] == pytest.approx(0.122165, abs=1e-6)

    def test_explicit_temperature_prop_wins(self):
        p = _radial({"temperature_c": 40})
        assert p.components[2].props["r_per_km"] == pytest.approx(
            0.1 * (1 + 0.00403 * 20), abs=1e-6)

    def test_temperature_20_reproduces_legacy(self):
        p = _radial({"temperature_c": 20})
        assert p.components[2].props["r_per_km"] == pytest.approx(0.1, abs=1e-9)


class TestSerializerRoundTrip:
    """Saved projects must stay byte-stable — the correction is an in-process
    modelling step, not user data."""

    def test_dump_restores_the_library_value(self):
        p = _radial()
        assert p.components[2].props["r_per_km"] != 0.1     # corrected in-process
        dumped = p.model_dump()["components"][2]["props"]
        assert dumped["r_per_km"] == 0.1                    # 20 °C library value

    def test_dump_restores_zero_sequence_too(self):
        p = _radial({"r0_per_km": 0.35})
        dumped = p.model_dump()["components"][2]["props"]
        assert dumped["r0_per_km"] == 0.35

    def test_bookkeeping_keys_never_persisted(self):
        """`_r20_per_km` & co. must not leak into the saved project — they would
        show up in the properties panel and in exported JSON."""
        dumped = _radial().model_dump()["components"][2]["props"]
        for k in ("_r20_per_km", "_r0_20_per_km", "_r_temp_applied_c"):
            assert k not in dumped

    def test_round_trip_is_stable(self):
        """dump -> rebuild -> dump must be identical, or every save would drift
        the stored resistance one correction further."""
        d1 = _radial().model_dump()["components"][2]["props"]
        d2 = ProjectData(**_radial().model_dump()).model_dump()["components"][2]["props"]
        assert d1 == d2


class TestNoCompounding:
    """The two pre-existing consumers that also scale resistance."""

    def test_minimum_fault_study_retargets_instead_of_multiplying(self):
        """[PS-3] A minimum-current study scales cable resistance from 20 °C to
        the assumed fault-time conductor temperature. For an overhead line that
        must RE-TARGET the central correction, not multiply on top of it.

        The anchor: asking for a 70 °C minimum-current study must give exactly
        the same fault currents as a line whose own `temperature_c` prop is 70 —
        because both describe the same conductor at the same temperature. A
        compounding implementation would apply 75 °C and then a further ×1.20
        flat factor, and the two would disagree.
        """
        via_arg = run_fault_analysis(_radial(), fault_bus_id="bus-2",
                                     fault_type="slg",
                                     conductor_temperature_c=70)
        via_prop = run_fault_analysis(_radial({"temperature_c": 70}),
                                      fault_bus_id="bus-2", fault_type="slg")
        assert via_arg.buses["bus-2"].ik1 == pytest.approx(
            via_prop.buses["bus-2"].ik1, rel=1e-9)

        a3 = run_fault_analysis(_radial(), fault_bus_id="bus-2",
                                fault_type="3phase", conductor_temperature_c=70)
        b3 = run_fault_analysis(_radial({"temperature_c": 70}),
                                fault_bus_id="bus-2", fault_type="3phase")
        assert a3.buses["bus-2"].ik3 == pytest.approx(
            b3.buses["bus-2"].ik3, rel=1e-9)

    def test_minimum_fault_study_is_disclosed(self):
        r = run_fault_analysis(_radial(), fault_bus_id="bus-2",
                               conductor_temperature_c=70)
        assert any("Minimum-current study" in a and "70" in a
                   for a in (r.study_assumptions or []))

    def test_cable_sizing_area_comes_from_the_20c_base(self):
        """`RESISTIVITY["Al"]` is a 20 °C resistivity, so S = ρ20·1000/R only
        gives the true area when R is the 20 °C value. Feeding it the corrected
        (hot) resistance would under-report the conductor by ~18 % — and that
        area feeds the adiabatic fault-withstand check, where under-reporting is
        the NON-CONSERVATIVE direction.

        0.1 Ω/km at 20 °C -> 282 mm²; the same line read hot would come out at
        231 mm², a 51 mm² phantom shortfall.
        """
        oh = _radial().components[2]
        props = _get_cable_props(oh)
        assert props["size_mm2"] == pytest.approx(
            RESISTIVITY["Al"] * 1000 / 0.1, rel=1e-9)
        assert props["size_mm2"] == pytest.approx(282.0, abs=0.5)

    def test_cable_sizing_volt_drop_uses_the_hot_resistance(self):
        """The AREA comes from the 20 °C base, but the resistance used for volt
        drop must be the operating-temperature one — that is the whole point of
        the correction. The two must not be confused for each other."""
        oh = _radial().components[2]
        props = _get_cable_props(oh)
        assert props["r_per_km"] == pytest.approx(0.122165, abs=1e-6)
