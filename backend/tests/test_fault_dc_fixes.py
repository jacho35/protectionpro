"""Regression tests for the 2026-07-09 audit fixes EE-1 and EE-2.

EE-1: the zero-sequence path walker dropped the transformer entry port when
traversing a cable, so a Dyn transformer reached through a cable fell into
the "port unknown" fallback and became a phantom Z0 source as seen from its
delta side — overstating Ik1 at the delta-side bus (IEC 60909-0 §6.3: Z(0)
into a delta winding is infinite).

EE-2: the DC arc flash engine used the gap-only arc voltage
V_arc = 20 + 0.534·G, dropping the Stokes & Oppenlander current exponent.
The correct model is R_arc = (20 + 0.534·G)/I^0.88 with the arcing current
solved iteratively from I = V_sys/(R_sys + R_arc(I)); hand solution for
600 V / 20 kA bolted / 32 mm gap: I_arc ≈ 16.0 kA, V_arc ≈ 119 V,
E ≈ 1.75 cal/cm² at 455 mm / 0.1 s (the old code gave 0.64 cal/cm²).

Run with:  python -m pytest backend/tests/ -v
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.dc_arcflash import (
    solve_dc_arc,
    calc_dc_arcing_current,
    calc_dc_incident_energy,
)


# ── Helpers ──────────────────────────────────────────────────────────────


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires):
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=components, wires=wires)


_UTILITY = dict(name="Grid", voltage_kv=33.0, fault_mva=500.0,
                x_r_ratio=15.0, z0_z1_ratio=1.0)

_DYN11_XFMR = dict(name="TX1", rated_mva=10.0, z_percent=10.0,
                   x_r_ratio=10.0, voltage_hv_kv=33.0, voltage_lv_kv=11.0,
                   vector_group="Dyn11", grounding_hv="ungrounded",
                   grounding_lv="solidly_grounded")

_CABLE = dict(name="C1", length_km=1.0, r_per_km=0.2, x_per_km=0.1,
              voltage_kv=33.0, rated_amps=400)


class TestZeroSequencePortThroughCable:
    """EE-1: Dyn transformer behind a cable must not become a Z0 source
    as seen from its delta (HV) side."""

    @staticmethod
    def _base_ik1():
        """33 kV bus fed by the utility alone (Z0 = Z1 → Ik1 = Ik3)."""
        comps = [
            _comp("utility-1", "utility", dict(_UTILITY)),
            _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 33.0}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1")]
        res = run_fault_analysis(_project(comps, wires))
        return res.buses["bus-1"].ik1

    def test_dyn_transformer_behind_cable_contributes_no_z0(self):
        """Ik1 at the 33 kV bus with a Dyn11 33/11 kV transformer connected
        THROUGH a cable must equal (within 0.5%) the Ik1 of the identical
        network with the transformer + cable removed entirely.

        Pre-fix, the transformer was reached with entry_port=None, hit the
        "port unknown" fallback, and its solidly grounded LV winding was
        offered as a phantom parallel Z0 path (~5-6% Ik1 overstatement in
        this configuration)."""
        base_ik1 = self._base_ik1()

        comps = [
            _comp("utility-1", "utility", dict(_UTILITY)),
            _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 33.0}),
            _comp("cable-1", "cable", dict(_CABLE)),
            _comp("transformer-1", "transformer", dict(_DYN11_XFMR)),
            _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 11.0}),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "cable-1"),
            _wire("w3", "cable-1", "transformer-1", to_port="primary"),
            _wire("w4", "transformer-1", "bus-2", from_port="secondary"),
        ]
        res = run_fault_analysis(_project(comps, wires))
        ik1 = res.buses["bus-1"].ik1
        assert ik1 == pytest.approx(base_ik1, rel=0.005), (
            f"Ik1 with Dyn11 behind cable = {ik1:.3f} kA vs {base_ik1:.3f} kA "
            "without it — the delta HV winding must block all zero-sequence "
            "current from the 33 kV bus (phantom Z0 source regression)"
        )

    def test_directly_wired_dyn_transformer_still_blocks(self):
        """No regression: a Dyn11 transformer wired straight onto the bus
        (entry port known) must also contribute no Z0 path."""
        base_ik1 = self._base_ik1()

        comps = [
            _comp("utility-1", "utility", dict(_UTILITY)),
            _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 33.0}),
            _comp("transformer-1", "transformer", dict(_DYN11_XFMR)),
            _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 11.0}),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "transformer-1", to_port="primary"),
            _wire("w3", "transformer-1", "bus-2", from_port="secondary"),
        ]
        res = run_fault_analysis(_project(comps, wires))
        ik1 = res.buses["bus-1"].ik1
        assert ik1 == pytest.approx(base_ik1, rel=0.005)


class TestDCArcStokesOppenlander:
    """EE-2: DC arc operating point must be solved iteratively with the
    current-dependent arc resistance R_arc = (20 + 0.534·G)/I^0.88."""

    # Audit hand-calc case: 600 V DC, 20 kA bolted (R_sys = 0.03 Ω),
    # 32 mm gap, t = 0.1 s, working distance 455 mm.
    V_SYS = 600.0
    R_SYS = 0.03
    GAP = 32.0

    def test_arcing_current_and_voltage_hand_calc(self):
        """Iterative S&O solve → I_arc ≈ 16.0 kA, V_arc ≈ 119 V.

        The pre-fix code gave I_arc = 18.8 kA with V_arc = 37.1 V
        (arc voltage evaluated at I = 1 A)."""
        i_arc, v_arc, r_arc = solve_dc_arc(self.V_SYS, self.R_SYS, self.GAP)
        assert i_arc == pytest.approx(16000.0, rel=0.05)
        assert v_arc == pytest.approx(119.0, rel=0.05)
        # Operating point must satisfy the circuit equation and Ohm's law
        assert i_arc == pytest.approx(self.V_SYS / (self.R_SYS + r_arc),
                                      rel=1e-4)
        assert v_arc == pytest.approx(i_arc * r_arc, rel=1e-9)
        # Arc current cannot exceed the bolted fault current
        assert i_arc < self.V_SYS / self.R_SYS

    def test_calc_dc_arcing_current_wrapper_consistent(self):
        """The legacy-signature wrapper must reproduce the solver result."""
        i_arc_solver, _, _ = solve_dc_arc(self.V_SYS, self.R_SYS, self.GAP)
        i_arc_wrapper = calc_dc_arcing_current(20000.0, self.V_SYS, self.GAP)
        assert i_arc_wrapper == pytest.approx(i_arc_solver, rel=1e-6)

    def test_incident_energy_hand_calc_band(self):
        """E at 455 mm / 0.1 s ≈ 1.75 cal/cm² (audit iterative solution);
        must land in 1.5-2.1 and be at least 2× the old 0.64 figure."""
        i_arc, _, _ = solve_dc_arc(self.V_SYS, self.R_SYS, self.GAP)
        e_cal = calc_dc_incident_energy(i_arc, self.GAP, 0.1, 455.0)
        assert 1.5 <= e_cal <= 2.1, (
            f"E = {e_cal:.3f} cal/cm² outside the hand-calculated band; "
            "0.6-0.7 indicates the dropped I^0.88 exponent bug"
        )
        assert e_cal >= 2.0 * 0.64

    def test_arc_cannot_sustain_below_minimum_arc_voltage(self):
        """System voltage below the minimum arc voltage across the gap
        (20 + 0.534·32 ≈ 37 V) cannot sustain an arc."""
        i_arc, v_arc, r_arc = solve_dc_arc(30.0, 0.001, self.GAP)
        assert i_arc == 0.0
        assert v_arc == 0.0
