"""Standards-anchored regression tests for the analysis engines.

Each test pins an engine result to a hand calculation from the governing
standard (IEC 60909, IEEE 1584-2002, IEEE 80) so that calculation
regressions are caught mechanically. These were introduced after the
2026-06 audit (see AUDIT_REPORT.md) — every Critical finding there was
detectable by one of these tests.

Run with:  python -m pytest backend/tests/ -v
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire, LoadFlowBus
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import (
    run_load_flow, connected_bus_loads_mw, _assess_solution,
    _newton_raphson, _gauss_seidel, solve_with_islands,
)
from backend.analysis.voltage_stability import run_voltage_stability
from backend.analysis.contingency import run_contingency
from backend.analysis.motor_starting import run_motor_starting
from backend.analysis.dynamic_motor_starting import run_dynamic_motor_starting
from backend.analysis.transient_stability import run_transient_stability
from backend.analysis.grounding_system import (
    _compute_conductor_size, _compute_n, _compute_K_ii, _compute_L_M,
)
from backend.analysis.arcflash import calc_incident_energy
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow
from backend.analysis.harmonics import (
    run_harmonics, vfd_current_spectrum, _voltage_limits, _tdd_limit,
)
from backend.analysis.frequency_scan import run_frequency_scan
from backend.analysis.battery_sizing import run_battery_sizing
from backend.analysis.optimal_powerflow import run_opf


# ── Helpers ──────────────────────────────────────────────────────────────


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _utility_bus_project(fault_mva=500.0, xr=15.0, kv=11.0, z0_z1=1.0,
                         extra_components=(), extra_wires=()):
    """Utility source wired straight onto one bus."""
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": kv, "fault_mva": fault_mva,
            "x_r_ratio": xr, "z0_z1_ratio": z0_z1,
        }),
        _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": kv}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1")]
    comps.extend(extra_components)
    wires.extend(extra_wires)
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


# ── IEC 60909 fault analysis ─────────────────────────────────────────────


class TestFaultAnalysis:
    def test_ik3_infinite_bus(self):
        """Ik3 at the connection point reproduces the declared fault level.

        [EE-4] IEC 60909-0 §6.2 Eq. 15: Z_Q = c·U_nQ²/S″_kQ, so that
        I″k = c·U_n/(√3·Z_Q) = S″_kQ/(√3·U_n) — the utility's declared level.
        500 MVA at 11 kV → Ik3 = 500/(√3·11) = 26.24 kA.
        (The pre-fix code omitted c from Z_Q and returned 1.1× the declared
        level, 28.87 kA.)
        """
        res = run_fault_analysis(_utility_bus_project())
        bus = res.buses["bus-1"]
        expected = 500.0 / (math.sqrt(3) * 11.0)
        assert bus.ik3 == pytest.approx(expected, rel=0.02)

    def test_slg_equals_3ph_when_z0_equals_z1(self):
        """AUDIT C2: with Z0 = Z1 = Z2 (solidly grounded source),
        Ik1 = 3c/(Z1+Z2+Z0) = c/Z1 = Ik3 exactly.

        The pre-fix code multiplied source Z0 by 3 and reported Ik1 = 0.6·Ik3.
        """
        res = run_fault_analysis(_utility_bus_project(z0_z1=1.0))
        bus = res.buses["bus-1"]
        assert bus.ik1 == pytest.approx(bus.ik3, rel=0.05)

    def test_peak_factor_kappa(self):
        """ip = κ·√2·Ik3 with κ = 1.02 + 0.98·e^(−3R/X), IEC 60909 Eq. 55.

        X/R = 15 → κ = 1.02 + 0.98·e^(−0.2) = 1.8224 → ip/Ik3 = 2.5773.
        """
        res = run_fault_analysis(_utility_bus_project(xr=15.0))
        bus = res.buses["bus-1"]
        kappa = 1.02 + 0.98 * math.exp(-3.0 / 15.0)
        assert bus.ip / bus.ik3 == pytest.approx(kappa * math.sqrt(2), rel=0.02)

    def test_ll_fault_is_root3_over_2_of_3ph(self):
        """[F25] Line-to-line fault, IEC 60909-0 §7.4: with Z1 = Z2,
        IkLL = c·√3/|Z1+Z2| = (√3/2)·(c/|Z1|) = (√3/2)·Ik3 ≈ 0.866·Ik3.

        No LL test existed before — the F1 angle error went undetected for
        want of one. This pins the magnitude.
        """
        res = run_fault_analysis(_utility_bus_project())
        bus = res.buses["bus-1"]
        assert bus.ikLL == pytest.approx(bus.ik3 * math.sqrt(3) / 2, rel=0.02)

    def test_slg_with_z0_double_z1(self):
        """[F25] SLG with Z0 = 2·Z1 (Z2 = Z1): Ik1 = 3c/|Z1+Z2+Z0|
        = 3c/(4|Z1|) = 0.75·(c/|Z1|) = 0.75·Ik3. Non-degenerate check that
        complements the Z0=Z1 case."""
        res = run_fault_analysis(_utility_bus_project(z0_z1=2.0))
        bus = res.buses["bus-1"]
        assert bus.ik1 == pytest.approx(0.75 * bus.ik3, rel=0.03)

    def test_llg_earth_current_with_z0_double_z1(self):
        """[F25] Double line-to-ground earth current, IEC 60909-0 §9:
        I"kE2E = |3·Ia0| = 3c·Z2/(Z1·Z2 + Z1·Z0 + Z2·Z0). With Z2 = Z1 and
        Z0 = 2·Z1 → 3c·Z/(Z²+2Z²+2Z²) = 0.6·(c/|Z1|) = 0.6·Ik3."""
        res = run_fault_analysis(_utility_bus_project(z0_z1=2.0))
        bus = res.buses["bus-1"]
        assert bus.ikLLG == pytest.approx(0.6 * bus.ik3, rel=0.03)

    def test_ungrounded_utility_has_no_earth_fault(self):
        """[F12] An ungrounded utility neutral has Z0 → ∞: no zero-sequence
        source, so SLG current ≈ 0 and the LLG earth current degenerates to
        the line-to-line value. Guards against the non-conservative pre-fix
        behaviour that reported SLG ≈ Ik3 regardless of grounding."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
                "x_r_ratio": 15.0, "z0_z1_ratio": 1.0, "grounding": "ungrounded",
            }),
            _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": 11.0}),
        ]
        proj = ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=[_wire("w1", "utility-1", "bus-1")])
        bus = run_fault_analysis(proj).buses["bus-1"]
        assert bus.ik3 > 0  # three-phase fault is unaffected by grounding
        assert bus.ik1 == pytest.approx(0.0, abs=1e-6)  # no earth-fault path
        # [PS-12] The LLG fault degenerates to line-to-line, but ikLLG is the
        # EARTH-RETURN current I″kE2E = |3·Ia0| — with Z0 → ∞ that is exactly
        # 0 (the phase current is reported separately as ikLL). Previously
        # the LL phase current appeared in this earth-current field.
        assert bus.ikLLG == 0.0
        assert bus.ikLL and bus.ikLL > 0

    def test_motor_terminal_behind_cable_gets_fault_level(self):
        """A motor wired to a bus through a cable, with no busbar at its own
        terminal, must get a fault level reported at that terminal — the
        auto-inserted node makes it identical to the same network with a bus
        drawn there — WITHOUT changing the fault level at the real buses (the
        DFS walker already reached the motor as an infeed through the cable)."""
        def _project(with_bus):
            xfmr = _comp("transformer-1", "transformer", {
                "name": "TX1", "rated_mva": 2.0, "z_percent": 6.0,
                "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                "vector_group": "Dyn11",
            })
            lv_bus = _comp("bus-2", "bus", {"name": "Remote LV", "voltage_kv": 0.4})
            cable = _comp("cable-1", "cable", {
                "name": "Motor Cable", "r_per_km": 0.5, "x_per_km": 0.08,
                "length_km": 0.15, "rated_amps": 400.0, "voltage_kv": 0.4,
            })
            motor = _comp("motor_induction-1", "motor_induction", {
                "name": "M1", "rated_kw": 90.0, "voltage_kv": 0.4,
                "efficiency": 0.93, "power_factor": 0.85,
                "locked_rotor_current": 6.0,
            })
            extra = [xfmr, lv_bus, cable, motor]
            wires = [
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "cable-1"),
            ]
            if with_bus:
                extra.append(_comp("bus-3", "bus",
                                   {"name": "Motor Bus", "voltage_kv": 0.4}))
                wires += [_wire("w5", "cable-1", "bus-3"),
                          _wire("w6", "bus-3", "motor_induction-1")]
            else:
                wires.append(_wire("w5", "cable-1", "motor_induction-1"))
            return _utility_bus_project(fault_mva=500.0, extra_components=extra,
                                        extra_wires=wires)

        no_bus = run_fault_analysis(_project(False)).buses
        with_bus = run_fault_analysis(_project(True)).buses

        # Real buses are unchanged by inserting the terminal node
        assert no_bus["bus-2"].ik3 == pytest.approx(with_bus["bus-2"].ik3, rel=1e-6)
        # A terminal fault level now exists, matching the manual-bus reference
        term = [b for bid, b in no_bus.items() if bid.startswith("__term__")]
        assert len(term) == 1, "no terminal-node fault result was reported"
        assert term[0].ik3 == pytest.approx(with_bus["bus-3"].ik3, rel=1e-6)
        assert term[0].bus_name == "M1 terminal"  # friendly name for reports


# ── IEEE 1584-2002 arc flash ─────────────────────────────────────────────


class TestArcFlash:
    def test_cf_voltage_factor(self):
        """AUDIT C1: Cf = 1.5 below 1 kV, 1.0 above (IEEE 1584-2002 Eq. 6).

        At the 610 mm normalisation distance the distance exponent cancels,
        so with identical Iarc/gap/time/config the LV:MV energy ratio is
        exactly Cf_LV/Cf_MV = 1.5. The pre-fix code had the factor reversed
        (ratio 1/1.5).
        """
        kwargs = dict(iarc_ka=10.0, t_arc_s=0.2, gap_mm=32.0,
                      dist_mm=610.0, config="VCB")
        e_lv = calc_incident_energy(voc_kv=0.48, **kwargs)
        e_mv = calc_incident_energy(voc_kv=11.0, **kwargs)
        assert e_lv / e_mv == pytest.approx(1.5, rel=0.01)

    def test_normalized_energy_hand_calc(self):
        """E at 610 mm/0.2 s must equal Cf·10^(K1 + 1.081·log Ia + 0.0011·G).

        VCB box, Ia = 10 kA, G = 32 mm, LV:
        log En = −0.555 + 1.081·1 + 0.0011·32 = 0.5612 → En = 3.642 J/cm²
        E = 1.5 × 3.642 / 4.184 × 4.184 = 5.46 cal/cm².
        """
        e = calc_incident_energy(iarc_ka=10.0, voc_kv=0.48, t_arc_s=0.2,
                                 gap_mm=32.0, dist_mm=610.0, config="VCB")
        en = 10 ** (-0.555 + 1.081 * math.log10(10.0) + 0.0011 * 32.0)
        assert e == pytest.approx(1.5 * en, rel=0.01)


# ── IEEE 80 grounding ────────────────────────────────────────────────────


class TestGrounding:
    def test_conductor_size_hand_calc(self):
        """AUDIT C3: IEEE 80 Eq. 37, 10 kA / 0.5 s, hard-drawn copper ≈ 25 mm².

        The pre-fix code produced ≈ 12,800 mm² (×506 error: amperes fed
        into the kA-form equation plus a spurious kcmil→mm² factor).
        """
        a_mm2 = _compute_conductor_size(10_000.0, 0.5, "copper_hard")
        assert 18.0 < a_mm2 < 32.0

    def test_effective_n_square_equals_nx(self):
        """IEEE 80 Eq. 84–87: for a square 70×70 m grid with 11×11 conductors
        (L_c = 1540 m) the full n = n_a·n_b·n_c·n_d reduces to n_x = 11 — the
        value the old ``max(n_x, n_y)`` shortcut gave, so the square-grid
        verification stays exact."""
        assert _compute_n(1540.0, 70.0, 70.0, 4900.0) == pytest.approx(11.0, abs=1e-6)

    def test_effective_n_rectangular_differs(self):
        """For a rectangular grid the full n = n_a·n_b (n_c = n_d = 1) departs
        from the naive max(n_x, n_y), which is the correction over the old
        shortcut. 70 m × 35 m, 11×6 conductors: L_c = 11·35 + 6·70 = 805 m,
        L_p = 210 → n_a = 2·805/210 = 7.667, n_b = √(210/(4·√2450)) = 1.030,
        n ≈ 7.90 (vs the shortcut's max(11, 6) = 11)."""
        n = _compute_n(805.0, 70.0, 35.0, 2450.0)
        assert n == pytest.approx(7.90, abs=0.1)
        assert abs(n - 11.0) > 1.0  # differs materially from the naive shortcut

    def test_K_ii_rods_vs_no_rods(self):
        """K_ii = 1.0 with rods; 1/(2n)^(2/n) without (IEEE 80 Eq. 90/91)."""
        assert _compute_K_ii(11.0, True) == 1.0
        assert _compute_K_ii(11.0, False) == pytest.approx(1.0 / (22.0) ** (2.0 / 11.0), rel=1e-9)

    def test_L_M_rod_weighting_eq88(self):
        """IEEE 80 Eq. 88 rod-weighted effective length for the square grid:
        L_M = 1540 + [1.55 + 1.22·(7.5/√(70²+70²))]·150 = 1786.4 m
        (vs the old 1540 + 150 = 1690 m, which over-stated mesh voltage +5.7%)."""
        L_M = _compute_L_M(1540.0, 150.0, 7.5, 70.0, 70.0, True)
        assert L_M == pytest.approx(1786.4, abs=0.5)
        # Corrected mesh voltage is 1690/1786.4 = 0.946× the old value
        assert (1690.0 / L_M) == pytest.approx(0.946, abs=0.002)

    def test_L_M_no_rods_is_lc_plus_lrod(self):
        """Without rods Eq. 87 keeps L_M = L_c + L_rod."""
        assert _compute_L_M(1540.0, 0.0, 0.0, 70.0, 70.0, False) == 1540.0


# ── Motor starting ───────────────────────────────────────────────────────


class TestMotorStarting:
    def test_voltage_dip_magnitude(self):
        """AUDIT C4: the starting load must equal the full locked-rotor MVA.

        1000 kW motor (η=0.95, pf=0.85, LRC=6×) on a 0.4 kV bus behind a
        10 MVA, 10% transformer (X_T = 1.0 pu on the 100 MVA base).
        S_start ≈ 6 × 1000/(0.95·0.85·1000) ≈ 7.4 MVA at pf 0.3, so the
        first-order dip at the motor bus is ≈ Q·X ≈ 0.071 × 1.0 ≈ 7 %.
        The pre-fix code injected 0.3×S_start and would report ≈ 2 %.

        Note: the source-side bus is the swing (V pinned), so the dip is
        produced entirely by the transformer impedance — which is the point.
        """
        xfmr = _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": 10.0, "z_percent": 10.0,
            "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
            "vector_group": "Dyn11",
        })
        lv_bus = _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4})
        motor = _comp("motor_induction-1", "motor_induction", {
            "name": "M1", "rated_kw": 1000.0, "voltage_kv": 0.4,
            "efficiency": 0.95, "power_factor": 0.85,
            "locked_rotor_current": 6.0,
        })
        proj = _utility_bus_project(
            fault_mva=500.0,
            extra_components=[xfmr, lv_bus, motor],
            extra_wires=[
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "motor_induction-1"),
            ])
        res = run_motor_starting(proj)
        motors = res["motors"]
        assert motors, f"no motor results; warnings: {res['warnings']}"
        dip = motors[0]["max_system_dip_pct"]
        assert 4.0 < dip < 13.0, (
            f"voltage dip {dip:.2f}% outside the hand-calculated 4-13% band "
            f"(≈7% expected; ≈2.5% indicates the 0.3× starting-load bug)"
        )

    def _motor_dip(self, starting_method):
        xfmr = _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": 10.0, "z_percent": 10.0,
            "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
            "vector_group": "Dyn11",
        })
        lv_bus = _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4})
        motor = _comp("motor_induction-1", "motor_induction", {
            "name": "M1", "rated_kw": 1000.0, "voltage_kv": 0.4,
            "efficiency": 0.95, "power_factor": 0.85,
            "locked_rotor_current": 6.0, "starting_method": starting_method,
        })
        proj = _utility_bus_project(
            fault_mva=500.0,
            extra_components=[xfmr, lv_bus, motor],
            extra_wires=[
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "motor_induction-1"),
            ])
        return run_motor_starting(proj)["motors"][0]["max_system_dip_pct"]

    def test_reduced_voltage_starting_reduces_dip(self):
        """Reduced-voltage starters draw less starting current than DOL, so the
        voltage dip must shrink monotonically with the current reduction
        (star-delta < soft-starter/auto < DOL; VFD smallest of all). The
        dip is sub-linear in current — constant-PQ amplification deepens the
        larger DOL dip — so star-delta lands below the 1/3 current ratio."""
        dol = self._motor_dip("dol")
        star_delta = self._motor_dip("star_delta")
        vfd = self._motor_dip("vfd")
        assert 0 < vfd < star_delta < dol
        assert star_delta < dol / 3.0  # at least the 1/3 current reduction

    def test_synchronous_motor_is_analysed(self):
        """AUDIT low item: synchronous motors must be included in motor
        starting (they start asynchronously and draw locked-rotor current)."""
        bus = _comp("bus-2", "bus", {"name": "MV Bus", "voltage_kv": 3.3})
        sm = _comp("motor_synchronous-1", "motor_synchronous", {
            "name": "SM1", "rated_kva": 2000.0, "voltage_kv": 3.3,
            "power_factor": 0.9, "locked_rotor_current": 5.5,
        })
        xfmr = _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": 10.0, "z_percent": 10.0,
            "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 3.3,
            "vector_group": "Dyn11",
        })
        proj = _utility_bus_project(
            fault_mva=500.0,
            extra_components=[xfmr, bus, sm],
            extra_wires=[
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "motor_synchronous-1"),
            ])
        res = run_motor_starting(proj)
        motors = res["motors"]
        assert motors, f"synchronous motor not analysed; warnings: {res['warnings']}"
        assert motors[0]["motor_type"] == "synchronous"
        assert motors[0]["max_system_dip_pct"] > 0

    def test_motor_behind_cable_without_terminal_bus(self):
        """A motor wired to a bus through a cable, with no busbar at its own
        terminal, must still be analysed — the auto-inserted terminal node
        makes it numerically identical to the same network with a bus drawn at
        the motor terminal. Regression for the 'zero volt drop on starting'
        bug, where the motor was silently dropped from the load flow because
        loads are gathered by walking transparent devices only (a cable is
        not one), so the dip reported the 1.0 pu default (0%)."""
        def _project(with_bus):
            xfmr = _comp("transformer-1", "transformer", {
                "name": "TX1", "rated_mva": 2.0, "z_percent": 6.0,
                "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                "vector_group": "Dyn11",
            })
            lv_bus = _comp("bus-2", "bus", {"name": "Remote LV", "voltage_kv": 0.4})
            cable = _comp("cable-1", "cable", {
                "name": "Motor Cable", "r_per_km": 0.5, "x_per_km": 0.08,
                "length_km": 0.15, "rated_amps": 400.0, "voltage_kv": 0.4,
            })
            motor = _comp("motor_induction-1", "motor_induction", {
                "name": "M1", "rated_kw": 90.0, "voltage_kv": 0.4,
                "efficiency": 0.93, "power_factor": 0.85,
                "locked_rotor_current": 6.0,
            })
            extra = [xfmr, lv_bus, cable, motor]
            wires = [
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "cable-1"),
            ]
            if with_bus:
                extra.append(_comp("bus-3", "bus",
                                   {"name": "Motor Bus", "voltage_kv": 0.4}))
                wires += [_wire("w5", "cable-1", "bus-3"),
                          _wire("w6", "bus-3", "motor_induction-1")]
            else:
                wires.append(_wire("w5", "cable-1", "motor_induction-1"))
            return _utility_bus_project(fault_mva=500.0, extra_components=extra,
                                        extra_wires=wires)

        no_bus = run_motor_starting(_project(False))["motors"][0]
        with_bus = run_motor_starting(_project(True))["motors"][0]

        # The motor is modelled — a real dip, not the 0% of the dropped-load bug
        assert no_bus["motor_terminal_voltage_pu"] < 0.95
        assert no_bus["max_system_dip_pct"] > 1.0
        # …and the auto-inserted node reproduces the manual-bus reference
        assert no_bus["motor_terminal_voltage_pu"] == pytest.approx(
            with_bus["motor_terminal_voltage_pu"], rel=0.02)


# ── Load flow sanity ─────────────────────────────────────────────────────


class TestLoadFlow:
    def test_two_bus_converges_near_nominal(self):
        """Lightly loaded 2-bus system converges with V ≈ 1.0 pu."""
        load = _comp("static_load-1", "static_load", {
            "name": "L1", "rated_kw": 500.0, "power_factor": 0.9,
            "voltage_kv": 11.0,
        })
        wire = _wire("w2", "bus-1", "static_load-1")
        proj = _utility_bus_project(extra_components=[load],
                                    extra_wires=[wire])
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        for bus in res.buses.values():
            assert 0.9 < bus.voltage_pu < 1.1

    def test_load_behind_cable_without_terminal_bus_is_modelled(self):
        """A load wired to a bus through a cable with no busbar at its terminal
        must still load the network: the cable becomes a branch carrying the
        load current. Previously such a load was silently dropped (loads are
        gathered by walking transparent devices only, and a cable is not one),
        so the cable never became a branch and the demand vanished. The
        auto-inserted terminal node must not leak into the public result."""
        cable = _comp("cable-1", "cable", {
            "name": "Feeder", "r_per_km": 0.5, "x_per_km": 0.1,
            "length_km": 0.5, "rated_amps": 200.0, "voltage_kv": 11.0,
        })
        load = _comp("static_load-1", "static_load", {
            "name": "L1", "rated_kw": 2000.0, "power_factor": 0.9,
            "voltage_kv": 11.0,
        })
        proj = _utility_bus_project(
            extra_components=[cable, load],
            extra_wires=[_wire("w2", "bus-1", "cable-1"),
                         _wire("w3", "cable-1", "static_load-1")])
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        cable_branch = [b for b in res.branches if b.elementId == "cable-1"]
        assert cable_branch and cable_branch[0].i_amps > 0, \
            "cable feeding the load was not modelled as a current-carrying branch"
        assert not any(bid.startswith("__term__") for bid in res.buses), \
            "synthetic terminal bus leaked into the public load-flow result"

    def test_leaf_capacitor_bus_reports_its_reactive_output(self):
        """A capacitor bank alone on a leaf bus must report its reactive output
        in the bus through-power, not zero.

        Regression: through-power was `s_through + bus_load`. A capacitor is a
        local injector (negative `bus_load`), and on a leaf bus its output flows
        OUT through the single branch — so it was ALSO counted in `s_through`.
        The two terms cancelled and the badge showed 0 kVAr. The bus must now
        report ≈ −(rated kVAr) (leading/supplying sign)."""
        cable = _comp("cable-1", "cable", {
            "name": "Feeder", "r_per_km": 0.5, "x_per_km": 0.1,
            "length_km": 0.05, "rated_amps": 200.0, "voltage_kv": 11.0,
        })
        cap_bus = _comp("bus-2", "bus", {"name": "CAP_Bus", "voltage_kv": 11.0})
        cap = _comp("capacitor_bank-1", "capacitor_bank", {
            "name": "Cap", "rated_kvar": 100.0, "voltage_kv": 11.0, "steps": 1,
        })
        proj = _utility_bus_project(
            extra_components=[cable, cap_bus, cap],
            extra_wires=[_wire("w2", "bus-1", "cable-1"),
                         _wire("w3", "cable-1", "bus-2"),
                         _wire("w4", "bus-2", "capacitor_bank-1")])
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        cap_bus_res = res.buses["bus-2"]
        # 100 kVAr = 0.1 MVAr, supplied (leading) → negative through-Q.
        assert cap_bus_res.q_through_mvar == pytest.approx(-0.1, abs=5e-3), \
            f"leaf capacitor bus reported {cap_bus_res.q_through_mvar} MVAr, expected ≈ -0.1"

    def test_capacitor_reduces_but_does_not_cancel_load_bus_through_q(self):
        """A capacitor sharing a bus with a larger inductive load (power-factor
        correction) still leaves the bus net-inductive: through-Q stays positive
        and is reduced by the cap's rating. Guards that the injector fix only
        changes net-injecting buses and leaves the common net-consuming case
        behaving as before."""
        load = _comp("static_load-1", "static_load", {
            # 400 kVA @ 0.8 pf → P = 320 kW, Q = 240 kVAr inductive
            "name": "L1", "rated_kva": 400.0, "power_factor": 0.8,
            "voltage_kv": 11.0,
        })
        cap = _comp("capacitor_bank-1", "capacitor_bank", {
            "name": "Cap", "rated_kvar": 100.0, "voltage_kv": 11.0, "steps": 1,
        })
        proj = _utility_bus_project(
            extra_components=[load, cap],
            extra_wires=[_wire("w2", "bus-1", "static_load-1"),
                         _wire("w3", "bus-1", "capacitor_bank-1")])
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        main = res.buses["bus-1"]
        # Q_load = 0.24 MVAr, less 0.1 MVAr from the cap → 0.14 MVAr, still
        # inductive (positive); the cap reduces but does not cancel it.
        assert main.q_through_mvar == pytest.approx(0.14, abs=1e-2), \
            f"PF-corrected bus reported {main.q_through_mvar} MVAr, expected ≈ 0.14"


class TestOptimalPowerFlow:
    """OPF: economic dispatch by marginal cost + Volt/VAR hill climb.

    With linear marginal costs, cost-optimal dispatch is merit order by
    $/MWh — the cheap unit serves the load and the expensive unit is the
    marginal balancer. Volt/VAR anchors: switching a far-end capacitor into
    a lagging feeder reduces I²R losses; a transformer tap step clears an
    undervoltage violation.
    """

    def test_economic_dispatch_prefers_cheap_generator(self):
        """5 MW load, gen at 50/MWh vs utility at 200/MWh. Baseline (gen on
        standby behind the grid) buys everything from the utility at
        ~1000/h; OPF dispatches the generator and cuts the bill to ~250/h."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
                "x_r_ratio": 15.0, "cost_per_mwh": 200.0}),
            _comp("generator-1", "generator", {
                "name": "G1", "rated_mva": 10.0, "power_factor": 0.85,
                "voltage_kv": 11.0, "cost_per_mwh": 50.0}),
            _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 11.0}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 5882.35, "power_factor": 0.85,
                "demand_factor": 1.0, "voltage_kv": 11.0}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"),
                 _wire("w2", "generator-1", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        r = run_opf(proj, use_capacitors=False, use_taps=False,
                    use_setpoints=False)
        assert r["converged"]
        assert r["baseline"]["cost_per_h"] == pytest.approx(1000.0, rel=0.02)
        assert r["optimized"]["cost_per_h"] == pytest.approx(250.0, rel=0.05)
        assert r["savings_per_h"] == pytest.approx(750.0, rel=0.05)
        gen = next(d for d in r["dispatch"] if d["source_id"] == "generator-1")
        assert gen["dispatched_mw"] == pytest.approx(5.0, rel=0.02)

    def _feeder_project(self, cap_kvar=2000.0, steps=2, sis=0,
                        load_kva=5000.0, pf=0.8):
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
                "x_r_ratio": 15.0}),
            _comp("bus-1", "bus", {"name": "Send", "voltage_kv": 11.0}),
            _comp("cable-1", "cable", {
                "name": "Feeder", "voltage_kv": 11.0, "r_per_km": 0.5,
                "x_per_km": 0.35, "length_km": 5.0, "rated_amps": 400.0}),
            _comp("bus-2", "bus", {"name": "Recv", "voltage_kv": 11.0}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": load_kva, "power_factor": pf,
                "demand_factor": 1.0, "voltage_kv": 11.0}),
            _comp("capacitor_bank-1", "capacitor_bank", {
                "name": "PFC", "rated_kvar": cap_kvar, "steps": steps,
                "steps_in_service": sis, "voltage_kv": 11.0}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"),
                 _wire("w2", "bus-1", "cable-1"),
                 _wire("w3", "cable-1", "bus-2"),
                 _wire("w4", "bus-2", "static_load-1"),
                 _wire("w5", "bus-2", "capacitor_bank-1")]
        return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_voltvar_switches_capacitor_in_for_losses(self):
        """An all-off 2-step bank at the lagging far end: minimising losses
        must switch step(s) in (less reactive current through the feeder R)."""
        r = run_opf(self._feeder_project(), objective="loss",
                    use_dispatch=False, use_taps=False, use_setpoints=False)
        assert r["converged"]
        cap = next(s for s in r["settings"]
                   if s["element_id"] == "capacitor_bank-1")
        assert cap["value"] >= 1, "OPF left the capacitor switched out"
        assert r["loss_reduction_kw"] > 0
        assert any(m["element_id"] == "capacitor_bank-1" for m in r["moves"])

    def test_steps_in_service_scales_capacitor_output(self):
        """Load flow honours the switched-bank prop: 1 of 2 steps in service
        halves the injected reactive; absent prop = full bank (legacy)."""
        half = run_load_flow(self._feeder_project(cap_kvar=1000.0, sis=1),
                             "newton_raphson")
        proj_full = self._feeder_project(cap_kvar=1000.0, sis=None)
        for c in proj_full.components:
            c.props.pop("steps_in_service", None)
        full = run_load_flow(proj_full, "newton_raphson")
        q_half = half.buses["bus-2"].q_through_mvar
        q_full = full.buses["bus-2"].q_through_mvar
        # Load Q = 3 MVAr inductive; the bank is a constant susceptance so it
        # nets Q_rated·V² at the (sagged) bus voltage — full 1.0·V², half 0.5·V².
        v_full = full.buses["bus-2"].voltage_pu
        v_half = half.buses["bus-2"].voltage_pu
        assert q_full == pytest.approx(3.0 - 1.0 * v_full ** 2, abs=0.05)
        assert q_half == pytest.approx(3.0 - 0.5 * v_half ** 2, abs=0.05)

    def test_tap_move_clears_undervoltage(self):
        """A 33/11 kV transformer feeding a heavy load below 0.95 pu: the
        tap control must reduce the violation count."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 33.0, "fault_mva": 500.0,
                "x_r_ratio": 15.0}),
            _comp("bus-1", "bus", {"name": "HV", "voltage_kv": 33.0}),
            _comp("transformer-1", "transformer", {
                "name": "TX", "rated_mva": 5.0, "z_percent": 10.0,
                "x_r_ratio": 10.0, "voltage_hv_kv": 33.0,
                "voltage_lv_kv": 11.0, "tap_percent": 0.0}),
            _comp("bus-2", "bus", {"name": "LV", "voltage_kv": 11.0}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 4800.0, "power_factor": 0.8,
                "demand_factor": 1.0, "voltage_kv": 11.0}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"),
                 _wire("w2", "bus-1", "transformer-1"),
                 _wire("w3", "transformer-1", "bus-2"),
                 _wire("w4", "bus-2", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        r = run_opf(proj, objective="loss", use_dispatch=False,
                    use_capacitors=False, use_setpoints=False)
        assert r["converged"]
        assert len(r["baseline"]["violations"]) >= 1, \
            "test setup expected an undervoltage baseline"
        assert (len(r["optimized"]["violations"])
                < len(r["baseline"]["violations"]))
        assert any(m["prop"] == "tap_percent" for m in r["moves"])


class TestBatterySizing:
    """Battery sizing & discharge against hand calculations.

    Sizing: E_req = ΣP·t / η_inv / DoD · K_age · K_design · K_temp
    (IEEE 485-style factors). Discharge: Peukert's law on lead-acid —
    t = H / r^k for a discharge at r× the hour-rated current (k = 1.25) —
    and exact energy bookkeeping for Li-ion (k = 1).
    """

    def _project(self, kwh=200.0, chemistry="lfp", rt_eff=0.9025, dod=80.0,
                 max_dis_kw=100.0, hour_rating=None, load_kva=0.0):
        props = {"name": "BESS", "rated_kva": 200.0, "voltage_kv": 0.4,
                 "battery_kwh": kwh, "battery_dod_pct": dod,
                 "battery_max_discharge_kw": max_dis_kw,
                 "battery_max_charge_kw": 50.0,
                 "battery_rt_eff": rt_eff, "battery_soc_pct": 100.0,
                 "battery_chemistry": chemistry, "battery_nominal_v": 48.0}
        if hour_rating is not None:
            props["battery_hour_rating_h"] = hour_rating
        comps = [_comp("battery-1", "battery", props),
                 _comp("bus-1", "bus", {"name": "LV Bus", "voltage_kv": 0.4})]
        wires = [_wire("w1", "battery-1", "bus-1")]
        if load_kva > 0:
            comps.append(_comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": load_kva, "power_factor": 1.0,
                "demand_factor": 1.0, "voltage_kv": 0.4}))
            wires.append(_wire("w2", "bus-1", "static_load-1"))
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_required_kwh_hand_calc(self):
        """10 kW × 2 h duty, η_rt = 0.9025 → η_1way = 0.95, DoD 80 %,
        aging 1.25, margin 1.10, 25 °C (K_temp = 1):
        E_req = 20/0.95/0.8 × 1.25 × 1.10 = 36.184 kWh."""
        r = run_battery_sizing(self._project(),
                               duty_cycle=[{"duration_min": 120, "load_kw": 10}])
        assert r["converged"]
        e_req = 20.0 / 0.95 / 0.8 * 1.25 * 1.10
        assert r["required_kwh"] == pytest.approx(e_req, rel=1e-3)
        assert r["required_ah"] == pytest.approx(e_req * 1000 / 48.0, rel=1e-3)
        assert r["sized_ok"]  # 200 kWh installed > 36.2 required

    def test_liion_runtime_to_dod_floor(self):
        """Li-ion (k = 1): 100 kWh at 19 kW AC (20 kW DC at η = 0.95) reaches
        the 20 % SoC floor after 0.8·100/20 h = 240 min."""
        proj = self._project(kwh=100.0)
        r = run_battery_sizing(
            proj, duty_cycle=[{"duration_min": 400, "load_kw": 19.0}])
        assert r["runtime_to_floor_min"] == pytest.approx(240.0, abs=2.0)
        assert any(v["kind"] == "capacity" for v in r["violations"])

    def test_lead_acid_peukert_halving(self):
        """Peukert: doubling the discharge rate empties a lead-acid bank in
        H/2^k, not H/2. A C10 bank driven at 2× its hour-rated power reaches
        0 % SoC (DoD 100 %) at 10/2^1.25 h = 252.3 min instead of 300."""
        proj = self._project(kwh=100.0, chemistry="lead_acid", rt_eff=1.0,
                             dod=100.0, hour_rating=10.0, max_dis_kw=100.0)
        r = run_battery_sizing(
            proj, duty_cycle=[{"duration_min": 400, "load_kw": 20.0}])
        t_exp = 10.0 / (2.0 ** 1.25) * 60.0
        assert r["runtime_to_floor_min"] == pytest.approx(t_exp, abs=3.0)
        # sanity: the same discharge at exactly the hour rating lasts H
        r10 = run_battery_sizing(
            proj, duty_cycle=[{"duration_min": 700, "load_kw": 10.0}])
        assert r10["runtime_to_floor_min"] == pytest.approx(600.0, abs=3.0)

    def test_voltage_declines_and_limit_violation_flagged(self):
        """Terminal voltage falls monotonically-ish across the discharge, and
        a duty peak above the discharge limit is flagged."""
        r = run_battery_sizing(
            self._project(max_dis_kw=50.0),
            duty_cycle=[{"duration_min": 30, "load_kw": 80.0}])
        assert any(v["kind"] == "discharge_limit" for v in r["violations"])
        vs = r["trajectory"]["v_pu"]
        assert vs[0] > vs[-2]  # last point is the unloaded OCV rebound

    def test_default_duty_from_island_load(self):
        """No duty cycle given → derived from the island's essential load
        (10 kVA at pf 1.0 = 10 kW) over the autonomy target."""
        r = run_battery_sizing(self._project(load_kva=10.0),
                               autonomy_target_min=60.0)
        assert r["duty_derived"]
        assert r["duty"] == [{"duration_min": 60.0, "load_kw": 10.0}]
        assert r["duty_kwh"] == pytest.approx(10.0, rel=1e-6)

    def test_no_battery_note(self):
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=[_comp("bus-1", "bus", {"voltage_kv": 0.4})],
                           wires=[])
        r = run_battery_sizing(proj)
        assert not r["converged"] and "No battery" in r["note"]


class TestFrequencyScan:
    """Impedance-vs-frequency sweep against the classical parallel-resonance
    screening formula.

    A capacitor bank Q_c on a bus fed from a source of short-circuit level
    S_sc resonates (source L against shunt C) at harmonic order

        h_r = √(S_sc / Q_c)

    (e.g. IEEE 519-2014 Annex / any harmonics text). At the fundamental the
    driving-point impedance is the source X in parallel with the capacitor:
    Y(1) = 1/(jX_s) + jB_c → |Z(1)| = 1/(1/X_s − B_c) for a lossless source.
    """

    KV = 11.0
    FAULT_MVA = 100.0
    CAP_KVAR = 4000.0     # 4 Mvar → h_r = √(100/4) = 5 (250 Hz at 50 Hz)

    def _project(self, with_cap=True):
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": self.KV,
                "fault_mva": self.FAULT_MVA, "x_r_ratio": 1000.0}),
            _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": self.KV}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1")]
        if with_cap:
            comps.append(_comp("capacitor_bank-1", "capacitor_bank", {
                "name": "PFC", "rated_kvar": self.CAP_KVAR,
                "voltage_kv": self.KV}))
            wires.append(_wire("w2", "bus-1", "capacitor_bank-1"))
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_parallel_resonance_at_sqrt_ssc_over_qc(self):
        r = run_frequency_scan(self._project(), h_step=0.05)
        assert r["converged"]
        peaks = [x for x in r["resonances"]
                 if x["kind"] == "parallel" and x["bus_id"] == "bus-1"]
        assert peaks, "no parallel resonance detected on the capacitor bus"
        h_r = math.sqrt(self.FAULT_MVA / (self.CAP_KVAR / 1000.0))
        assert peaks[0]["h"] == pytest.approx(h_r, abs=0.1), \
            f"resonance at h={peaks[0]['h']}, hand-calc {h_r}"
        assert peaks[0]["f_hz"] == pytest.approx(h_r * 50.0, abs=5.0)
        assert r["worst_h"] == pytest.approx(h_r, abs=0.1)

    def test_fundamental_driving_point_impedance(self):
        """|Z(1)| = 1/(1/X_s − B_c): X_s = 1.0 pu, B_c = 0.04 pu →
        1.0417 pu = 1.2604 Ω at 11 kV / 100 MVA."""
        r = run_frequency_scan(self._project(), h_max=5.0)
        bus = next(b for b in r["buses"] if b["id"] == "bus-1")
        z_base = self.KV ** 2 / 100.0
        z1_exp = 1.0 / (1.0 / 1.0 - 0.04) * z_base
        assert bus["z1_ohm"] == pytest.approx(z1_exp, rel=1e-2)

    def test_no_capacitor_means_no_parallel_resonance(self):
        """A purely inductive network rises monotonically — no peak, and the
        engine says so."""
        r = run_frequency_scan(self._project(with_cap=False))
        assert r["converged"]
        assert not [x for x in r["resonances"] if x["kind"] == "parallel"]
        bus = next(b for b in r["buses"] if b["id"] == "bus-1")
        assert bus["z_ohm"][-1] > bus["z_ohm"][0]
        assert any("parallel resonance is not expected" in w
                   for w in r["warnings"])

    def test_scan_bus_filter_and_unknown_bus(self):
        r = run_frequency_scan(self._project(), bus_ids=["bus-1"])
        assert [b["id"] for b in r["buses"]] == ["bus-1"]
        r2 = run_frequency_scan(self._project(), bus_ids=["nope"])
        assert not r2["converged"]


class TestWeakGridSourceImpedance:
    """Utility Thevenin source-impedance option (lf_grid_model='thevenin').

    A constant-power load S = P + jQ fed from an EMF E behind Z = R + jX has
    the closed-form terminal voltage (positive root of the standard two-bus
    quadratic, e.g. Kundur "Power System Stability and Control" §2.3):

        V⁴ + V²·(2(PR + QX) − E²) + (P² + Q²)·|Z|² = 0     (per-unit)

    With the option ON the solver must reproduce this sag at the point of
    supply; with it OFF (or absent — every legacy project) the utility stays
    an ideal swing and the bus reads exactly the setpoint voltage.
    """

    KV = 11.0
    FAULT_MVA = 100.0   # Z_Q = baseMVA/S″k = 1.0 pu — a very weak grid

    def _project(self, grid_model="thevenin", xr=10.0, load_kva=10_000.0,
                 pf=1.0, vset=None):
        props = {"name": "Grid", "voltage_kv": self.KV,
                 "fault_mva": self.FAULT_MVA, "x_r_ratio": xr,
                 "lf_grid_model": grid_model}
        if vset is not None:
            props["v_setpoint_pu"] = vset
        comps = [
            _comp("utility-1", "utility", props),
            _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": self.KV}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": load_kva, "power_factor": pf,
                "demand_factor": 1.0, "voltage_kv": self.KV}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"),
                 _wire("w2", "bus-1", "static_load-1")]
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _rx_pu(self, xr):
        z_pu = 100.0 / self.FAULT_MVA          # on the 100 MVA base
        x_pu = z_pu * xr / math.sqrt(1.0 + xr * xr)
        return x_pu / xr, x_pu

    @staticmethod
    def _analytic_v(p_pu, q_pu, r_pu, x_pu, e=1.0):
        b = 2.0 * (p_pu * r_pu + q_pu * x_pu) - e * e
        c = (p_pu ** 2 + q_pu ** 2) * (r_pu ** 2 + x_pu ** 2)
        return math.sqrt((-b + math.sqrt(b * b - 4.0 * c)) / 2.0)

    @pytest.mark.parametrize("pf", [1.0, 0.9])
    def test_point_of_supply_sag_matches_closed_form(self, pf):
        """10 MVA load on a 100 MVA grid (Z = 1.0 pu, X/R 10): the supply bus
        must sag to the two-bus closed-form voltage (≈0.9848 pu at unity pf,
        ≈0.9402 pu at 0.9 lagging) instead of being pinned at 1.0."""
        proj = self._project(pf=pf)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        r_pu, x_pu = self._rx_pu(xr=10.0)
        p_pu = 10.0 * pf / 100.0
        q_pu = 10.0 * math.sqrt(1.0 - pf ** 2) / 100.0
        v_exp = self._analytic_v(p_pu, q_pu, r_pu, x_pu)
        assert res.buses["bus-1"].voltage_pu == pytest.approx(v_exp, abs=5e-4), \
            f"expected closed-form {v_exp:.5f} pu, got {res.buses['bus-1'].voltage_pu}"
        assert any("Thevenin source" in w.message for w in res.warnings)

    def test_synthetic_pieces_collapsed_from_public_result(self):
        """The internal EMF bus never leaks; the Z_s element row reads
        utility → point of supply with import-positive P; the utility source
        row and dispatch entry re-anchor to the real bus."""
        res = run_load_flow(self._project(), "newton_raphson")
        assert res.converged
        assert not any(bid.startswith("__grid") for bid in res.buses), \
            "synthetic EMF bus leaked into the public load-flow result"
        zs = [b for b in res.branches if b.elementId.startswith("__gridz__")]
        assert zs, "Thevenin impedance element emitted no branch row"
        assert zs[0].from_bus == "utility-1" and zs[0].to_bus == "bus-1"
        assert zs[0].p_mw > 9.9   # ≈ load + grid-internal loss
        util_rows = [b for b in res.branches if b.elementId == "utility-1"]
        assert util_rows and util_rows[0].to_bus == "bus-1"
        util_entries = [d for d in res.dispatch if d.source_id == "utility-1"]
        assert util_entries and util_entries[0].bus_id == "bus-1"

    def test_default_remains_ideal_infinite_bus(self):
        """Without the opt-in (every legacy project) the utility bus stays the
        swing at exactly 1.0 pu and no synthetic pieces exist."""
        res = run_load_flow(self._project(grid_model="infinite"),
                            "newton_raphson")
        assert res.converged
        assert res.buses["bus-1"].voltage_pu == pytest.approx(1.0, abs=1e-9)
        assert not any(b.elementId.startswith("__gridz__") for b in res.branches)

    def test_utility_voltage_setpoint(self):
        """v_setpoint_pu moves the swing reference: an ideal utility holds its
        bus at exactly the setpoint (1.05 pu here)."""
        res = run_load_flow(self._project(grid_model="infinite", vset=1.05),
                            "newton_raphson")
        assert res.converged
        assert res.buses["bus-1"].voltage_pu == pytest.approx(1.05, abs=1e-9)

    def test_voltage_stability_inherits_weak_grid(self):
        """With the Thevenin model the P-V nose is set by the SOURCE strength:
        an (almost) X-only 100 MVA grid feeding its bus directly collapses at
        P_max = E²/(2X) ≈ 50 MW — the documented ideal-swing limitation
        (loadability independent of fault level) is removed."""
        proj = self._project(pf=1.0, load_kva=20_000.0, xr=1_000.0)
        r = run_voltage_stability(proj, lambda_max=8.0, step=0.05)
        assert r.collapsed, r.note
        _r_pu, x_pu = self._rx_pu(xr=1_000.0)
        p_max = 100.0 / (2.0 * x_pu)           # E²/(2X) on the 100 MVA base
        assert r.lambda_critical == pytest.approx(p_max / 20.0, rel=0.03)


class TestPlanSubBoardFeeder:
    """EE-1: a distribution board is a bus-like node that carries its own
    lumped load AND passes current through to a sub-board it feeds. Regression
    for the plan-sync 'Feeder to Sub-board' topology, where a board previously
    blocked every network walk so the sub-board's demand vanished from the
    solution and its feeder cable never became a branch."""

    @staticmethod
    def _feeder_project():
        # utility → incomer bus → MDB(50 kVA) → outgoing bus → cable → SDB(30 kVA)
        # Exactly what PlanSync.syncBuildingToSLD builds for DB→DB feeding.
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 0.4, "fault_mva": 500.0,
            }),
            _comp("bus-1", "bus", {"name": "Incomer", "voltage_kv": 0.4}),
            _comp("mdb", "distribution_board", {
                "name": "MDB", "rated_kva": 50.0, "power_factor": 0.85,
                "demand_factor": 1.0, "voltage_kv": 0.4,
            }),
            _comp("obus", "bus", {"name": "MDB Outgoing", "voltage_kv": 0.4}),
            _comp("cable-1", "cable", {
                "name": "Feeder", "r_per_km": 0.524, "x_per_km": 0.08,
                "length_km": 0.03, "rated_amps": 100.0, "voltage_kv": 0.4,
            }),
            _comp("sdb", "distribution_board", {
                "name": "SDB", "rated_kva": 30.0, "power_factor": 0.85,
                "demand_factor": 1.0, "voltage_kv": 0.4,
            }),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "mdb"),
            _wire("w3", "mdb", "obus"),
            _wire("w4", "obus", "cable-1"),
            _wire("w5", "cable-1", "sdb"),
        ]
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_sub_board_is_energized_and_supplied(self):
        res = run_load_flow(self._feeder_project(), "newton_raphson")
        assert res.converged
        # Both boards now appear as nodes and are energized (pre-fix: SDB and
        # the outgoing bus were a sourceless island reported de-energized).
        assert res.buses["mdb"].energized
        assert res.buses["sdb"].energized
        assert 0.9 < res.buses["sdb"].voltage_pu < 1.02
        # The utility supplies BOTH boards: 50 kVA·0.85 + 30 kVA·0.85 ≈ 68 kW
        # (pre-fix it supplied only the MDB's 42.5 kW).
        util = next(d for d in res.dispatch if d.source_id == "utility-1")
        assert util.dispatched_mw > 0.05          # clearly more than MDB alone
        assert util.dispatched_mw == pytest.approx(0.068, abs=0.004)
        # The feeder cable is now a real branch carrying the sub-board current
        # (30 kVA at 0.4 kV ≈ 43 A); pre-fix it carried nothing.
        feeder = next(b for b in res.branches if b.elementId == "cable-1")
        assert 35.0 < feeder.i_amps < 50.0

    def test_sub_board_unbalanced_converges_and_supplied(self):
        res = run_unbalanced_load_flow(self._feeder_project())
        assert res.converged
        # A de-energized/islanded sub-board would sit at 0 V; it now solves live.
        assert res.buses["sdb"].v1_pu > 0.9

    def test_fault_level_computed_at_sub_board(self):
        # Pre-fix the walk terminated at MDB, so SDB had no source path and a
        # zero fault level. It must now see the utility through the board.
        res = run_fault_analysis(self._feeder_project())
        assert "sdb" in res.buses
        assert res.buses["sdb"].ik3 > 0


class TestIslandingAndDispatch:
    """Island-aware load flow and merit-order generation dispatch."""

    @staticmethod
    def _gen_island_project(cb_state="open"):
        """Utility behind a CB (open by default) + generator island with load."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
            }),
            _comp("cb-1", "cb", {"name": "Incomer", "state": cb_state}),
            _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": 11.0}),
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 2.0, "voltage_kv": 11.0,
                "power_factor": 0.9,
            }),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 500.0, "power_factor": 0.9,
                "voltage_kv": 11.0,
            }),
        ]
        wires = [
            _wire("w1", "utility-1", "cb-1"),
            _wire("w2", "cb-1", "bus-1"),
            _wire("w3", "gen-1", "bus-1"),
            _wire("w4", "bus-1", "static_load-1"),
        ]
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_generator_island_converges_with_open_utility_cb(self):
        """Opening the utility CB must NOT break load flow: the generator
        becomes the island's slack and the solve converges near nominal."""
        res = run_load_flow(self._gen_island_project("open"), "newton_raphson")
        assert res.converged
        bus = res.buses["bus-1"]
        assert bus.energized
        assert 0.95 < bus.voltage_pu < 1.05
        roles = {d.source_id: d.role for d in res.dispatch}
        assert roles["gen-1"] == "balancer"
        assert roles["utility-1"] == "offline"
        assert any("reference" in w.message for w in res.warnings)

    def test_generator_island_unbalanced_converges(self):
        """Same island through the unbalanced solver."""
        res = run_unbalanced_load_flow(self._gen_island_project("open"))
        assert res.converged

    def test_closed_cb_restores_utility_as_balancer(self):
        """With the CB closed the utility is the slack again; the generator
        (standby by default) stays idle while the utility has capacity."""
        res = run_load_flow(self._gen_island_project("closed"), "newton_raphson")
        assert res.converged
        entries = {d.source_id: d for d in res.dispatch}
        assert entries["utility-1"].role == "balancer"
        assert entries["gen-1"].role == "standby"
        assert entries["gen-1"].dispatched_mw == 0
        # The idle generator's branch annotation must also read zero — the
        # pre-fix badge fell back to rated output (S = rating → exactly
        # 100% loading on an idle machine)
        gen_badge = next(b for b in res.branches if b.elementId == "gen-1")
        assert gen_badge.s_mva == 0
        assert gen_badge.loading_pct == 0
        assert gen_badge.i_amps == 0

    def test_must_run_generator_injects_full_output(self):
        """dispatch_mode=must_run keeps the historical always-on behaviour."""
        proj = self._gen_island_project("closed")
        gen = next(c for c in proj.components if c.id == "gen-1")
        gen.props["dispatch_mode"] = "must_run"
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        entries = {d.source_id: d for d in res.dispatch}
        assert entries["gen-1"].role == "dispatched"
        assert entries["gen-1"].dispatched_mw == pytest.approx(1.8, abs=0.01)  # 2 MVA × 0.9 pf

    def test_standby_activates_on_utility_capacity_shortfall(self):
        """A standby generator runs only for the demand the utility cannot
        cover (supply_capacity_mva); idle when capacity is sufficient."""
        proj = self._gen_island_project("closed")
        util = next(c for c in proj.components if c.id == "utility-1")
        load = next(c for c in proj.components if c.id == "static_load-1")
        load.props["rated_kva"] = 1000.0     # 0.9 MW demand
        util.props["supply_capacity_mva"] = 0.3
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        gen = next(d for d in res.dispatch if d.source_id == "gen-1")
        # Shortfall = 0.9 MW demand − 0.3 MVA capacity = 0.6 MW
        assert gen.role == "dispatched"
        assert gen.dispatched_mw == pytest.approx(0.6, abs=0.01)
        assert any("Standby source" in w.message for w in res.warnings)

    def test_sourceless_island_reported_de_energized(self):
        """A bus behind an open CB with no source of its own must be
        reported de-energized instead of making the whole solve singular."""
        extra = [
            _comp("cb-2", "cb", {"name": "Tie", "state": "open"}),
            _comp("bus-2", "bus", {"name": "Dead Bus", "voltage_kv": 11.0}),
            _comp("static_load-2", "static_load", {
                "name": "L2", "rated_kva": 200.0, "voltage_kv": 11.0,
            }),
        ]
        wires = [
            _wire("w2", "bus-1", "cb-2"),
            _wire("w3", "cb-2", "bus-2"),
            _wire("w4", "bus-2", "static_load-2"),
        ]
        proj = _utility_bus_project(extra_components=extra, extra_wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged                      # live island still solves
        assert res.buses["bus-1"].energized
        assert not res.buses["bus-2"].energized
        assert res.buses["bus-2"].voltage_pu == 0
        assert any("de-energized" in w.message for w in res.warnings)

    @staticmethod
    def _solar_utility_project(allow_export):
        """Utility + 2 MW solar (must_run) + 0.5 MW load on one bus."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 0.4, "fault_mva": 500.0,
                "allow_export": allow_export,
            }),
            _comp("bus-1", "bus", {"name": "Main Bus", "voltage_kv": 0.4}),
            _comp("solar-1", "solar_pv", {
                "name": "PV1", "rated_kw": 1940.0, "voltage_kv": 0.4,
                "inverter_eff": 0.97, "power_factor": 1.0,
            }),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 555.6, "power_factor": 0.9,
                "voltage_kv": 0.4,
            }),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "solar-1", "bus-1"),
            _wire("w3", "bus-1", "static_load-1"),
        ]
        return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_solar_exports_when_allowed(self):
        """allow_export=yes (default): solar runs at full available output
        and the utility swing absorbs the excess (export)."""
        res = run_load_flow(self._solar_utility_project("yes"), "newton_raphson")
        assert res.converged
        pv = next(d for d in res.dispatch if d.source_id == "solar-1")
        assert pv.dispatched_mw == pytest.approx(2.0, abs=0.01)  # 1940/0.97/1000
        assert pv.curtailed_mw == 0

    def test_solar_curtailed_when_export_disallowed(self):
        """allow_export=no: solar output is capped at the island demand
        (0.5 MW) and the curtailment is reported."""
        res = run_load_flow(self._solar_utility_project("no"), "newton_raphson")
        assert res.converged
        pv = next(d for d in res.dispatch if d.source_id == "solar-1")
        assert pv.dispatched_mw == pytest.approx(0.5, abs=0.01)   # 555.6 kVA × 0.9 pf
        assert pv.curtailed_mw == pytest.approx(1.5, abs=0.01)
        assert any("curtailed" in w.message for w in res.warnings)

    def test_pv_covering_load_leaves_utility_at_zero_real_power(self):
        """When curtailed PV exactly covers the load, the utility branch
        annotation must show ~0 kW real power, not a phantom import/export.

        Loads and PV injections at the swing bus are invisible to NR's slack
        accounting (S_bus), so the utility badge must add the local load and
        subtract local generation — in every layout.
        """
        # Layout A: utility + PV + load all on one bus
        res = run_load_flow(self._solar_utility_project("no"), "newton_raphson")
        util = next(b for b in res.branches if b.elementId == "utility-1")
        assert abs(util.p_mw) < 0.005          # ≈ 0 (losses only)
        pv = next(b for b in res.branches if b.elementId == "solar-1")
        assert pv.p_mw == pytest.approx(0.5, abs=0.01)

        # Layout B: PV on a remote bus via cable, load at the utility bus
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 0.4, "fault_mva": 500.0,
                "allow_export": "no",
            }),
            _comp("bus-1", "bus", {"name": "BA", "voltage_kv": 0.4}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 555.6, "power_factor": 0.9,
                "voltage_kv": 0.4,
            }),
            _comp("bus-2", "bus", {"name": "BB", "voltage_kv": 0.4}),
            _comp("solar-1", "solar_pv", {
                "name": "PV1", "rated_kw": 1940.0, "voltage_kv": 0.4,
                "inverter_eff": 0.97, "power_factor": 1.0,
            }),
            _comp("cable-1", "cable", {
                "name": "c1", "length_km": 0.05, "r_per_km": 0.1,
                "x_per_km": 0.08, "voltage_kv": 0.4, "rated_amps": 400,
            }),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "static_load-1"),
            _wire("w3", "bus-1", "cable-1"),
            _wire("w4", "cable-1", "bus-2"),
            _wire("w5", "solar-1", "bus-2"),
        ]
        proj = ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        util = next(b for b in res.branches if b.elementId == "utility-1")
        # Utility carries only the cable losses (~8 kW at 0.4 kV), not the
        # 0.5 MW load — the pre-fix badge showed a phantom −0.5 MW export.
        assert abs(util.p_mw) < 0.02

    def test_every_bus_reports_through_power(self):
        """Radial utility → busA → cable → busB (pass-through) → cable →
        busC (load): every energized bus must report the power its busbar
        carries (p_through_mw), including the pass-through and swing buses
        whose NET injection is ~0."""
        cable = {"length_km": 0.05, "r_per_km": 0.1, "x_per_km": 0.08,
                 "voltage_kv": 11.0, "rated_amps": 400}
        comps = [
            _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
                                           "fault_mva": 500.0}),
            _comp("bus-a", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("cable-1", "cable", dict(cable, name="c1")),
            _comp("bus-b", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("cable-2", "cable", dict(cable, name="c2")),
            _comp("bus-c", "bus", {"name": "C", "voltage_kv": 11.0}),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 555.6, "power_factor": 0.9,
                "voltage_kv": 11.0}),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-a"),
            _wire("w2", "bus-a", "cable-1"), _wire("w3", "cable-1", "bus-b"),
            _wire("w4", "bus-b", "cable-2"), _wire("w5", "cable-2", "bus-c"),
            _wire("w6", "bus-c", "static_load-1"),
        ]
        proj = ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        # All three buses carry ≈ the 0.5 MW load (plus small losses)
        for bid in ("bus-a", "bus-b", "bus-c"):
            assert res.buses[bid].p_through_mw == pytest.approx(0.5, abs=0.02), bid
        # Net injection at the pass-through bus stays ~0 (the old display input)
        assert abs(res.buses["bus-b"].p_mw) < 0.001

    def test_generator_min_load_curtails_solar(self):
        """Islanded generator balancing a PV-heavy island: solar is curtailed
        so the running generator carries at least min_load_pct of its rating
        (wet-stacking floor, default 30%)."""
        comps = [
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 0.2, "voltage_kv": 0.4,
                "power_factor": 0.85,   # min load = 0.2×0.85×30% = 51 kW
            }),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            _comp("solar-1", "solar_pv", {
                "name": "PV", "rated_kw": 97, "voltage_kv": 0.4,
                "inverter_eff": 0.97, "power_factor": 1.0,  # 100 kW avail
            }),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 141.2, "power_factor": 0.85,
                "voltage_kv": 0.4,      # 120 kW demand
            }),
        ]
        wires = [_wire("w1", "gen-1", "bus-1"), _wire("w2", "solar-1", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        pv = next(d for d in res.dispatch if d.source_id == "solar-1")
        # PV cut from 100 kW to 69 kW so the gen carries its 51 kW floor
        assert pv.dispatched_mw == pytest.approx(0.069, abs=0.002)
        assert pv.curtailed_mw == pytest.approx(0.031, abs=0.002)
        assert any("minimum load" in w.message for w in res.warnings)

    def test_generator_min_load_pct_settable_and_zeroable(self):
        """min_load_pct=0 disables the floor — PV runs at full output."""
        comps = [
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 0.2, "voltage_kv": 0.4,
                "power_factor": 0.85, "min_load_pct": 0,
            }),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            _comp("solar-1", "solar_pv", {
                "name": "PV", "rated_kw": 97, "voltage_kv": 0.4,
                "inverter_eff": 0.97, "power_factor": 1.0,
            }),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 141.2, "power_factor": 0.85,
                "voltage_kv": 0.4,
            }),
        ]
        wires = [_wire("w1", "gen-1", "bus-1"), _wire("w2", "solar-1", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        pv = next(d for d in res.dispatch if d.source_id == "solar-1")
        assert pv.dispatched_mw == pytest.approx(0.1, abs=0.002)
        assert pv.curtailed_mw == 0

    def test_generator_max_load_pct_caps_dispatch(self):
        """max_load_pct caps a merit generator's output; the utility slack
        carries the rest. 1 MVA / 0.85 PF gen at 50% cap = 0.425 MW ceiling,
        so a 1.2 MW demand leaves the gen at its cap (not full 0.85 MW)."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
            }),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11.0}),
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 1.0, "voltage_kv": 11.0,
                "power_factor": 0.85, "dispatch_mode": "merit_order",
                "min_load_pct": 0, "max_load_pct": 50,   # cap = 0.425 MW
            }),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 1411.8, "power_factor": 0.85,
                "voltage_kv": 11.0,     # 1.2 MW demand
            }),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "gen-1", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        gen = next(d for d in res.dispatch if d.source_id == "gen-1")
        assert gen.dispatched_mw == pytest.approx(0.425, abs=0.002)

    def test_generator_max_load_pct_default_no_cap(self):
        """max_load_pct=100 (default) leaves dispatch unbounded — the merit
        gen serves the full demand up to its available output."""
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0,
            }),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11.0}),
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 1.0, "voltage_kv": 11.0,
                "power_factor": 0.85, "dispatch_mode": "merit_order",
                "min_load_pct": 0,      # no max_load_pct => default 100%
            }),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 1411.8, "power_factor": 0.85,
                "voltage_kv": 11.0,     # 1.2 MW demand
            }),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "gen-1", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        gen = next(d for d in res.dispatch if d.source_id == "gen-1")
        assert gen.dispatched_mw == pytest.approx(0.85, abs=0.002)

    @staticmethod
    def _two_set_island(load_kva, g1_extra=None, g2_extra=None):
        """Two sequential 100 kVA sets (seq 1 and 2) + a load, islanded."""
        g = {"voltage_kv": 0.4, "power_factor": 0.85, "rated_mva": 0.1,
             "gen_control": "sequential", "min_load_pct": 30}
        comps = [
            _comp("g1", "generator", {**g, "name": "G1", "dispatch_priority": 1,
                                      **(g1_extra or {})}),
            _comp("g2", "generator", {**g, "name": "G2", "dispatch_priority": 2,
                                      **(g2_extra or {})}),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": load_kva, "power_factor": 0.85,
                "voltage_kv": 0.4}),
        ]
        wires = [_wire("w1", "g1", "bus-1"), _wire("w2", "g2", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_sequential_low_load_second_set_off(self):
        """60 kW load on two 100 kVA sequential sets: the lead set balances,
        set 2 stays OFF (85 kW capacity × 90% covers 60 kW)."""
        res = run_load_flow(self._two_set_island(70.6), "newton_raphson")  # 60 kW
        assert res.converged
        e = {d.source_id: d for d in res.dispatch}
        assert e["g1"].role == "balancer"
        assert e["g2"].role == "off"
        assert e["g2"].dispatched_mw == 0
        g2_badge = next(b for b in res.branches if b.elementId == "g2")
        assert g2_badge.s_mva == 0 and g2_badge.loading_pct == 0
        assert any("held off" in w.message for w in res.warnings)

    def test_sequential_high_load_lead_set_full(self):
        """150 kW load: lead set fixed at full 85 kW, set 2 balances ~65 kW."""
        res = run_load_flow(self._two_set_island(176.5), "newton_raphson")  # 150 kW
        assert res.converged
        e = {d.source_id: d for d in res.dispatch}
        assert e["g1"].role == "dispatched"
        assert e["g1"].dispatched_mw == pytest.approx(0.085, abs=0.002)  # full
        assert e["g2"].role == "balancer"
        assert e["g2"].dispatched_mw == pytest.approx(0.065, abs=0.004)  # remainder
        assert any("start threshold" in w.message for w in res.warnings)

    def test_sequential_threshold_respected(self):
        """80 kW load: at 90% threshold (76.5 kW trigger) both sets commit;
        at 100% threshold only the lead set runs."""
        res = run_load_flow(self._two_set_island(94.1), "newton_raphson")  # 80 kW
        e = {d.source_id: d for d in res.dispatch}
        assert e["g2"].role != "off"          # 80 > 85×0.9 → set 2 online
        # Fill-first with balancer floor: G2 sits at its 25.5 kW minimum,
        # G1 backs off to ~54.5 kW instead of G2 backfeeding
        assert e["g1"].dispatched_mw == pytest.approx(0.0545, abs=0.002)
        res2 = run_load_flow(self._two_set_island(
            94.1, g1_extra={"start_threshold_pct": 100}), "newton_raphson")
        e2 = {d.source_id: d for d in res2.dispatch}
        assert e2["g2"].role == "off"         # 80 < 85×1.0 → set 2 held off

    @staticmethod
    def _droop_two_set_island(load_kva):
        """A 200 kVA + 100 kVA droop genset pair on one bus, islanded (no
        utility). Mirrors the Bouchard Findlayson topology that exposed the
        false-overload bug: the larger set has the higher dispatch priority so
        it is the island reference."""
        g = {"voltage_kv": 0.4, "power_factor": 0.85, "min_load_pct": 30}
        comps = [
            _comp("g200", "generator", {**g, "name": "G200", "rated_mva": 0.2,
                                        "dispatch_priority": 3, "dispatch_mode": "standby"}),
            _comp("g100", "generator", {**g, "name": "G100", "rated_mva": 0.1,
                                        "dispatch_priority": 2, "dispatch_mode": "standby"}),
            _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": load_kva, "power_factor": 0.85,
                "voltage_kv": 0.4}),
        ]
        wires = [_wire("w1", "g200", "bus-1"), _wire("w2", "g100", "bus-1"),
                 _wire("w3", "bus-1", "static_load-1")]
        return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_droop_parallel_shares_load_proportionally(self):
        """Two paralleled droop gensets (170 kW + 85 kW) on a 221 kW island
        share the load in proportion to rating — neither overloads. Before the
        droop fix the 200 kVA reference set carried the residual alone and hit
        ~106 % while the 100 kVA set sat lightly loaded."""
        res = run_load_flow(self._droop_two_set_island(260.0), "newton_raphson")  # 221 kW
        assert res.converged
        e = {d.source_id: d for d in res.dispatch}
        assert e["g200"].role == "balancer"   # larger + higher priority = reference
        assert e["g100"].role != "off"        # runs in parallel, not held off
        # Proportional split: 221 kW × 170/255 ≈ 147 kW ; × 85/255 ≈ 74 kW
        assert e["g200"].dispatched_mw == pytest.approx(0.1473, abs=0.004)
        assert e["g100"].dispatched_mw == pytest.approx(0.0737, abs=0.004)
        # Equal per-unit loading is the signature of proportional sharing, and
        # crucially neither set exceeds 100 %.
        load = {b.elementId: b.loading_pct for b in res.branches
                if b.elementId in ("g200", "g100")}
        assert load["g200"] < 100 and load["g100"] < 100
        assert abs(load["g200"] - load["g100"]) < 3.0   # within 3 pp → proportional
        assert any("Droop parallel operation" in w.message for w in res.warnings)

    def test_droop_low_load_runs_single_set(self):
        """At 85 kW — well within the 170 kW reference set alone — only the
        reference set runs; the second set is not paralleled needlessly (no
        proportional-sharing split, no droop warning)."""
        res = run_load_flow(self._droop_two_set_island(100.0), "newton_raphson")  # 85 kW
        assert res.converged
        e = {d.source_id: d for d in res.dispatch}
        assert e["g200"].role == "balancer"
        assert e["g100"].dispatched_mw == pytest.approx(0.0, abs=0.001)
        assert e["g200"].dispatched_mw == pytest.approx(0.085, abs=0.004)
        assert not any("Droop parallel operation" in w.message for w in res.warnings)

    def test_droop_parallel_shares_network_losses(self):
        """Droop-paralleled sets must share the NETWORK LOSSES in rating
        proportion too, not only the load demand. The load sits behind a lossy
        LV cable so the island has real I²R losses; before the distributed-
        slack fix those landed entirely on the reference set, which then read
        several points above its paralleled partner despite equal-percentage
        droop sharing being the whole promise of the scheme."""
        g = {"voltage_kv": 0.4, "power_factor": 0.85, "min_load_pct": 30}
        comps = [
            _comp("g200", "generator", {**g, "name": "G200", "rated_mva": 0.2,
                                        "dispatch_priority": 3, "dispatch_mode": "standby"}),
            _comp("g100", "generator", {**g, "name": "G100", "rated_mva": 0.1,
                                        "dispatch_priority": 2, "dispatch_mode": "standby"}),
            _comp("bus-1", "bus", {"name": "GEN", "voltage_kv": 0.4}),
            _comp("cable-1", "cable", {
                "name": "Feeder", "r_per_km": 0.08, "x_per_km": 0.08,
                "length_km": 0.15, "rated_amps": 400.0, "voltage_kv": 0.4}),
            _comp("bus-2", "bus", {"name": "LOAD", "voltage_kv": 0.4}),
            _comp("static_load-1", "static_load", {
                "name": "L", "rated_kva": 260.0, "power_factor": 0.85,
                "voltage_kv": 0.4}),
        ]
        wires = [_wire("w1", "g200", "bus-1"), _wire("w2", "g100", "bus-1"),
                 _wire("w3", "bus-1", "cable-1"), _wire("w4", "cable-1", "bus-2"),
                 _wire("w5", "bus-2", "static_load-1")]
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        e = {d.source_id: d for d in res.dispatch}
        p200, p100 = e["g200"].dispatched_mw, e["g100"].dispatched_mw
        # Losses are real (load 221 kW, total generation must exceed it) and
        # the 2:1 rating ratio holds on the loss-inclusive totals.
        assert p200 + p100 > 0.221 + 0.002
        assert p200 == pytest.approx(2 * p100, abs=0.0008)
        # Equal per-unit loading — the loss share no longer skews the reference
        load = {b.elementId: b.loading_pct for b in res.branches
                if b.elementId in ("g200", "g100")}
        assert abs(load["g200"] - load["g100"]) < 1.0
        assert any("network losses shared" in w.message for w in res.warnings)

    def test_distribution_board_loads_like_static_load(self):
        """A distribution_board's lumped equivalents (rated_kva, demand_factor,
        phase pcts — derived from its circuit schedule by the frontend) must
        flow through load flow exactly like a static load."""
        db = _comp("db-1", "distribution_board", {
            "name": "DB1", "voltage_kv": 11.0, "power_factor": 0.85,
            "rated_kva": 50.0, "demand_factor": 0.7,
            "phase_connection": "3P",
            "phase_a_pct": 50.0, "phase_b_pct": 30.0, "phase_c_pct": 20.0,
            "circuits": [
                {"way": "1", "description": "Lights", "poles": "1P", "phase": "R",
                 "breaker_a": 20, "curve": "C", "load_va": 25000, "demand_factor": 0.7},
                {"way": "2", "description": "Plugs", "poles": "1P", "phase": "W",
                 "breaker_a": 20, "curve": "C", "load_va": 25000, "demand_factor": 0.7},
            ],
        })
        wire = _wire("w2", "bus-1", "db-1")
        proj = _utility_bus_project(extra_components=[db], extra_wires=[wire])
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        # Utility supplies the diversified demand: 50 kVA × 0.7 × 0.85 pf ≈ 29.75 kW
        util = next(b for b in res.branches if b.elementId == "utility-1")
        assert util.p_mw == pytest.approx(0.02975, abs=0.001)
        # Unbalanced solver accepts the board's phase split
        unbal = run_unbalanced_load_flow(proj)
        assert unbal.converged

    def test_merit_order_generator_follows_demand(self):
        """A merit_order generator is dispatched only up to the remaining
        demand instead of injecting its full rating."""
        proj = self._gen_island_project("closed")
        gen = next(c for c in proj.components if c.id == "gen-1")
        gen.props["dispatch_mode"] = "merit_order"
        gen.props["min_load_pct"] = 0  # isolate merit-order from the wet-stacking floor
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        entry = next(d for d in res.dispatch if d.source_id == "gen-1")
        assert entry.dispatched_mw == pytest.approx(0.45, abs=0.01)  # 500 kVA × 0.9 pf load
        assert entry.available_mw == pytest.approx(1.8, abs=0.01)

    def test_merit_order_generator_raised_to_min_load(self):
        """With the default 30% floor, a running merit-order generator is
        raised from the demand-following 0.45 MW to 0.54 MW (2 MVA × 0.9 × 30%)."""
        proj = self._gen_island_project("closed")
        gen = next(c for c in proj.components if c.id == "gen-1")
        gen.props["dispatch_mode"] = "merit_order"
        res = run_load_flow(proj, "newton_raphson")
        assert res.converged
        entry = next(d for d in res.dispatch if d.source_id == "gen-1")
        assert entry.dispatched_mw == pytest.approx(0.54, abs=0.01)
        assert any("minimum load" in w.message for w in res.warnings)


# ── Unbalanced load flow ─────────────────────────────────────────────────


class TestUnbalancedLoadFlow:
    def test_balanced_load_gives_zero_vuf(self):
        """AUDIT H5/H6 guard: a balanced 3-phase load through the unbalanced
        solver must reproduce the balanced solver's voltage with VUF ≈ 0.

        The pre-fix code understated all sequence injections 3× and, with a
        Dyn transformer present, silently zeroed the zero-sequence solve.
        """
        load = _comp("static_load-1", "static_load", {
            "name": "L1", "rated_kw": 2000.0, "power_factor": 0.9,
            "voltage_kv": 11.0, "phase_connection": "3P",
        })
        wire = _wire("w2", "bus-1", "static_load-1")
        proj = _utility_bus_project(extra_components=[load],
                                    extra_wires=[wire])
        bal = run_load_flow(proj, "newton_raphson")
        unbal = run_unbalanced_load_flow(proj)
        assert bal.converged
        bus_b = bal.buses["bus-1"]
        bus_u = unbal.buses["bus-1"]
        assert bus_u.vuf_pct < 0.1
        assert bus_u.va_pu == pytest.approx(bus_b.voltage_pu, abs=0.02)


# ── ADMD / NRS 034-1 load estimation ─────────────────────────────────────────


from backend.analysis.admd import (
    LOAD_CLASSES,
    beta_params,
    herman_beta_demand,
    empirical_demand,
    kiosk_demand,
    feeder_demand,
    feeder_tree_rollup,
    run_admd,
)


def _urban1():
    return next(c for c in LOAD_CLASSES if c["id"] == "urban1")


def _settings(**kw):
    base = {"estimationMethod": "Empirical", "correctionMethod": "AMEU",
            "loadClass": "urban1", "admd": 4.04}
    base.update(kw)
    return base


class TestADMD:
    """Pin the NRS 034-1 / CTEF100 demand engine ported from Retic Builder Pro.

    Values are the source app's own formulae (Herman-Beta Beta→Normal with
    Cornish-Fisher correction; Empirical N×ADMD×DCF). See admd.py / admd_data.py.
    """

    def test_beta_params_urban1(self):
        """Beta(1.22, 2.96)·60 → µ, σ, skewness for Urban Residential I."""
        bp = beta_params(_urban1())
        assert bp["mean"] == pytest.approx(17.512, abs=0.01)
        assert bp["sigma"] == pytest.approx(11.985, abs=0.01)
        assert bp["skewness"] == pytest.approx(0.6744, abs=0.001)
        # ADMD derives from the computed mean (matches source calcBetaParams).
        assert bp["admdKVA"] == pytest.approx(4.03, abs=0.01)

    def test_herman_beta_single_consumer(self):
        """N=1 design current = µ + z_cf·σ, z=1.28 with Cornish-Fisher."""
        r = herman_beta_demand(1, _urban1())
        assert r["totalKVA"] == pytest.approx(7.75, abs=0.01)
        assert r["currentA"] == pytest.approx(33.71, abs=0.01)

    def test_herman_beta_diversity_reduces_per_consumer(self):
        """Per-consumer demand falls as N grows (√N diversity term)."""
        one = herman_beta_demand(1, _urban1())["totalKVA"]
        hundred = herman_beta_demand(100, _urban1())
        assert hundred["totalKVA"] == pytest.approx(438.26, abs=0.1)
        assert hundred["totalKVA"] / 100 < one          # diversity benefit

    def test_empirical_single_consumer_ameu(self):
        """N=1: DCF=1+2/1=3, UCF=1+2.8=3.8, kVA=1×4.04×3."""
        r = empirical_demand(1, 4.04, "AMEU")
        assert r["dcf"] == pytest.approx(3.0, abs=0.01)
        assert r["ucf"] == pytest.approx(3.8, abs=0.01)
        assert r["totalKVA"] == pytest.approx(12.12, abs=0.01)
        assert r["currentA"] == pytest.approx(52.7, abs=0.05)
        # UCF is excluded from the demand total but exposed for feeder VD.
        assert r["feederCurrentA"] == pytest.approx(200.24, abs=0.1)

    def test_empirical_dcf_approaches_one_at_scale(self):
        """DCF → 1 for large N (ADMD defined at the 1000-consumer asymptote)."""
        r = empirical_demand(100, 4.04, "AMEU")
        assert r["dcf"] == pytest.approx(1.02, abs=0.01)

    def test_correction_methods_differ(self):
        """AMEU and British DCF give different diversity for the same N."""
        ameu = empirical_demand(10, 4.04, "AMEU")["dcf"]
        british = empirical_demand(10, 4.04, "British")["dcf"]
        none = empirical_demand(10, 4.04, "None")["dcf"]
        assert none == 1.0
        assert ameu == pytest.approx(1.2, abs=0.01)         # 1+2/10
        assert british == pytest.approx(1.2, abs=0.01)      # 1+8/(4.04·10)
        assert ameu != pytest.approx(0)                     # sanity

    def test_three_phase_class_multiplies_kva(self):
        """A 3-phase class applies a ×3 phase multiplier on per-phase params."""
        cls3 = next(c for c in LOAD_CLASSES if c["id"] == "upmarket1_3ph")
        r = empirical_demand(1, cls3, "AMEU")
        assert r["totalKVA"] == pytest.approx(5.97, abs=0.02)

    def test_kiosk_three_phase_erf_counts_as_three(self):
        """One 3-phase erf = 3 single-phase connections (one per R/W/B)."""
        k = {"id": "K1", "erfs": [{"length": 10, "phase": "3 Phase"}]}
        r = kiosk_demand(k, _settings())
        assert r["conns"] == 1
        # 3 buckets each with N=1 → 3 × single-consumer empirical demand.
        assert r["totalKVA"] == pytest.approx(36.36, abs=0.02)

    def test_kiosk_override_is_fixed_undiversified(self):
        """An amps-override erf is excluded from diversified N and added fixed."""
        k = {"id": "K2", "erfs": [
            {"length": 5, "phase": "Red"},
            {"length": 5, "phase": "Red"},
            {"length": 5, "phase": "Red", "ampsOverride": 60},
        ]}
        r = kiosk_demand(k, _settings())
        assert r["overrideKVA"] == pytest.approx(13.8, abs=0.01)   # 60×230/1000
        # diversified part = empirical(N=2 on Red); override added on top.
        assert r["totalKVA"] == pytest.approx(29.96, abs=0.02)

    def test_feeder_diversity_beats_sum_of_kiosks(self):
        """Combined-N feeder demand is below the sum of per-kiosk demands."""
        ka = {"id": "A", "erfs": [{"length": 1, "phase": "Red"}] * 5}
        kb = {"id": "B", "erfs": [{"length": 1, "phase": "Red"}] * 5}
        per_kiosk = kiosk_demand(ka, _settings())["totalKVA"]
        feeder = feeder_demand([ka, kb], _settings())
        assert feeder["conns"] == 10
        assert feeder["totalKVA"] < 2 * per_kiosk               # diversity benefit
        assert feeder["totalKVA"] == pytest.approx(48.48, abs=0.1)

    def test_single_kiosk_feeder_equals_kiosk_demand(self):
        """A one-kiosk feeder total must equal that kiosk's own demand.

        Guards the per-phase superposition fix: the feeder rollup must not
        combine consumers across phases in a way that undercuts a single kiosk.
        """
        k = {"id": "K1", "erfs": [
            {"length": 30, "phase": "Red"}, {"length": 30, "phase": "White"}]}
        for est in ("Empirical", "Herman Beta"):
            s = _settings(estimationMethod=est)
            assert feeder_demand([k], s)["totalKVA"] == pytest.approx(
                kiosk_demand(k, s)["totalKVA"], abs=0.01), f"mismatch for {est}"

    def test_feeder_herman_beta_diversity(self):
        """Herman-Beta feeder rollup also shows the diversity benefit."""
        ka = {"id": "A", "erfs": [{"length": 1, "phase": "Red"}] * 5}
        kb = {"id": "B", "erfs": [{"length": 1, "phase": "Red"}] * 5}
        s = _settings(estimationMethod="Herman Beta")
        per_kiosk = kiosk_demand(ka, s)["totalKVA"]
        feeder = feeder_demand([ka, kb], s)
        assert feeder["totalKVA"] < 2 * per_kiosk
        assert feeder["totalKVA"] == pytest.approx(51.63, abs=0.1)

    def test_street_lighting_adds_undiversified(self):
        """Street lighting is a fixed load added on top of diversified demand."""
        base = {"id": "K", "erfs": [{"length": 5, "phase": "Red"}] * 3}
        lit = {"id": "K", "streetLightKVA": 10,
               "erfs": [{"length": 5, "phase": "Red"}] * 3}
        s = _settings()
        d0 = kiosk_demand(base, s)["totalKVA"]
        d1 = kiosk_demand(lit, s)
        assert d1["streetLightKVA"] == pytest.approx(10.0, abs=0.01)
        assert d1["totalKVA"] == pytest.approx(d0 + 10.0, abs=0.02)
        # And it propagates to the feeder total.
        assert feeder_demand([lit], s)["totalKVA"] == pytest.approx(d1["totalKVA"], abs=0.02)

    def test_feeder_tree_rollup_carries_subtree(self):
        """A feeder segment carries its kiosk plus every kiosk fed from it.

        B is fed from A, so A's feeder = demand(A+B) while B's feeder = B only.
        """
        ka = {"id": "A", "fedFrom": "source",
              "erfs": [{"length": 1, "phase": "Red"}] * 4}
        kb = {"id": "B", "fedFrom": "A",
              "erfs": [{"length": 1, "phase": "Red"}] * 6}
        s = _settings()
        roll = feeder_tree_rollup([ka, kb], s)
        assert roll["A"]["feederKVA"] == pytest.approx(feeder_demand([ka, kb], s)["totalKVA"], abs=0.01)
        assert roll["B"]["feederKVA"] == pytest.approx(feeder_demand([kb], s)["totalKVA"], abs=0.01)
        assert roll["A"]["subtreeConns"] == 10
        assert roll["B"]["subtreeConns"] == 6
        # Parent feeder must carry at least as much as the child's.
        assert roll["A"]["feederKVA"] > roll["B"]["feederKVA"]

    def test_risk_z_setting_reaches_herman_beta(self):
        """settings.riskZ must drive the Herman-Beta risk factor.

        z=2.33 (1% risk) must give a higher design demand than the default
        z=1.28 (10% risk), for both the kiosk calc and the feeder rollup.
        """
        k = {"id": "K", "erfs": [{"length": 30, "phase": "Red"}] * 4}
        lo = _settings(estimationMethod="Herman Beta", riskZ=1.28)
        hi = _settings(estimationMethod="Herman Beta", riskZ=2.33)
        k_lo = kiosk_demand(k, lo)["totalKVA"]
        k_hi = kiosk_demand(k, hi)["totalKVA"]
        assert k_hi > k_lo
        # Pin: N=4 urban1, z_cf = 2.33+(2.33²−1)/6·(0.6744/√4) = 2.579,
        # I = 4·17.512 + 2.579·√4·11.985 = 131.87 A → 30.33 kVA.
        assert k_hi == pytest.approx(30.33, abs=0.05)
        assert feeder_demand([k], hi)["totalKVA"] == pytest.approx(k_hi, abs=0.01)

    def test_short_custom_class_lib_does_not_crash(self):
        """A user-edited library with <3 classes and no urban1 must not 500.

        resolve_demand_param's source-app fallback was LOAD_CLASSES[2]; with a
        short project loadClassLib it must fall back to the first class.
        """
        lib = [{"id": "onlyone", "label": "Only One", "a": 1.0, "b": 3.0,
                "c": 60, "admd": 4.0, "phase": 1}]
        k = {"id": "K", "loadClass": "missing_id",
             "erfs": [{"length": 30, "phase": "Red"}]}
        s = _settings(estimationMethod="Herman Beta", loadClassLib=lib)
        r = kiosk_demand(k, s)   # must not raise
        assert r["totalKVA"] > 0
        assert r["cls"] == "Only One"

    def test_minisub_grouping_and_network_total(self):
        """ADMD diversity applies per minisub across its downstream kiosks;
        the network total is the SUM of the per-minisub diversified demands
        (× the network diversity factor) — NOT one lump diversified across
        all minisubs, which would understate each transformer's load.
        """
        def kiosk(i, fed):
            return {"id": f"K{i}", "fedFrom": fed,
                    "erfs": [{"length": 60, "phase": p}
                             for p in ("Red", "White", "Blue")] * 2}
        ms = [{"id": "msA", "name": "A"}, {"id": "msB", "name": "B"}]
        kiosks = [kiosk(1, "msA"), kiosk(2, "msA"),
                  kiosk(3, "msB"), kiosk(4, "K3")]   # K4 chained under msB
        s = _settings()
        res = run_admd({"settings": s, "kiosks": kiosks, "minisubs": ms})

        group_a = feeder_demand(kiosks[:2], s)["totalKVA"]
        group_b = feeder_demand(kiosks[2:], s)["totalKVA"]
        by_id = {m["minisubId"]: m for m in res["minisubs"]}
        assert by_id["msA"]["totalKVA"] == pytest.approx(group_a, abs=0.01)
        assert by_id["msB"]["totalKVA"] == pytest.approx(group_b, abs=0.01)
        assert by_id["msB"]["numKiosks"] == 2          # chain resolved to msB
        assert res["total"]["sumKVA"] == pytest.approx(group_a + group_b, abs=0.01)
        assert res["total"]["totalKVA"] == pytest.approx(group_a + group_b, abs=0.01)
        # The sum of per-group demands exceeds one lump over everything.
        lump = feeder_demand(kiosks, s)["totalKVA"]
        assert res["total"]["totalKVA"] > lump

        # Network diversity factor scales the total, not the minisub demands.
        res2 = run_admd({"settings": _settings(networkDiversity=0.9),
                         "kiosks": kiosks, "minisubs": ms})
        assert res2["total"]["totalKVA"] == pytest.approx(
            (group_a + group_b) * 0.9, abs=0.02)
        by_id2 = {m["minisubId"]: m for m in res2["minisubs"]}
        assert by_id2["msA"]["totalKVA"] == pytest.approx(group_a, abs=0.01)

    def test_legacy_single_source_total_unchanged(self):
        """A request without minisubs gets one implicit source; the total
        equals the plain all-kiosk diversified demand (backward compatible).
        """
        kiosks = [{"id": "K1", "fedFrom": "source",
                   "erfs": [{"length": 30, "phase": "Red"}] * 4}]
        s = _settings()
        res = run_admd({"settings": s, "kiosks": kiosks})
        assert len(res["minisubs"]) == 1
        assert res["total"]["totalKVA"] == pytest.approx(
            feeder_demand(kiosks, s)["totalKVA"], abs=0.01)


# ── IEC 62305-2 lightning risk ───────────────────────────────────────────

from backend.models.schemas import LightningRiskRequest, LightningLine
from backend.analysis.lightning_risk import (
    run_lightning_risk, collection_area_structure, TOLERABLE_R1)


def _lr_request(**overrides):
    """Baseline structure: 20×15×8 m office, Ng=4, suburban surroundings,
    concrete floors, ordinary fire risk, fully occupied, no protection."""
    base = dict(
        length_m=20.0, width_m=15.0, height_m=8.0,
        location="surrounded_same_height", ground_flash_density=4.0,
        structure_use="other", persons_in_zone=10, persons_total=10,
        hours_per_year=8760.0, hazard_level="none",
        floor_type="agricultural_concrete", fire_risk="ordinary",
        fire_protection="none", explosion_risk=False,
        equipment_withstand_kv=2.5, lps_class="none", spd_level="none",
        lines=[],
    )
    base.update(overrides)
    return LightningRiskRequest(**base)


class TestLightningRisk:
    def test_collection_area_eq_a2(self):
        """IEC 62305-2 eq. A.2: A_D = L·W + 2·3H·(L+W) + π·(3H)².
        20×15×8 m: 300 + 2·24·35 + π·576 = 3789.56 m²."""
        ad = collection_area_structure(20.0, 15.0, 8.0)
        assert ad == pytest.approx(300 + 1680 + math.pi * 576, rel=1e-9)

    def test_nd_dangerous_events(self):
        """N_D = N_G·A_D·C_D·1e-6 (eq. A.4). Ng=4, C_D=0.5 (same height):
        4 × 3789.56 × 0.5 × 1e-6 = 7.579e-3 events/yr."""
        res = run_lightning_risk(_lr_request())
        assert res.flashes_to_structure_per_year == pytest.approx(
            4 * 3789.5575 * 0.5 * 1e-6, rel=1e-3)

    def test_r1_hand_calc_no_lines_no_protection(self):
        """Full-occupancy single zone, no lines, no protection:
        L_A = r_t·L_T = 1e-2·1e-2 = 1e-4;  R_A = N_D·P_A·L_A = N_D·1e-4
        L_B = r_p·r_f·h_z·L_F = 1·1e-2·1·1e-2 = 1e-4;  R_B = N_D·1e-4
        R1 = 2e-4·N_D = 2e-4 × 7.579e-3 = 1.516e-6 → compliant."""
        res = run_lightning_risk(_lr_request())
        nd = res.flashes_to_structure_per_year
        assert res.r1 == pytest.approx(2e-4 * nd, rel=1e-6)
        assert res.compliant  # 1.5e-6 < 1e-5
        assert "No protection required" in res.recommendation

    def test_lps_class_iii_scales_ra_rb_by_pb(self):
        """P_B(III) = 0.1 scales both R_A (P_A = P_TA·P_B) and R_B."""
        none = run_lightning_risk(_lr_request())
        lps3 = run_lightning_risk(_lr_request(lps_class="III"))
        assert lps3.r1 == pytest.approx(0.1 * none.r1, rel=1e-6)

    def test_line_events_and_rv(self):
        """Buried suburban power line with HV/LV transformer, L_L=1000 m:
        N_L = N_G·40·L_L·C_I·C_E·C_T·1e-6 = 4·40000·0.5·0.5·0.2·1e-6 = 8e-3.
        R_U = R_V = N_L·1e-4 each (P_U=P_V=1, L_U=L_V=1e-4), so adding the
        line raises R1 by 2e-4·N_L = 1.6e-6."""
        line = LightningLine(name="Incomer", type="power", length_m=1000.0,
                             installation="buried", environment="suburban",
                             has_transformer=True, shielded=False)
        without = run_lightning_risk(_lr_request())
        with_line = run_lightning_risk(_lr_request(lines=[line]))
        assert with_line.r1 - without.r1 == pytest.approx(2e-4 * 8e-3, rel=1e-3)

    def test_explosion_risk_enables_system_components(self):
        """Explosion risk ⇒ internal-system failure endangers life:
        R_C = N_D·P_SPD·L_O with L_O = 1e-1 dominates R1 and forces a
        non-compliant verdict for an unprotected structure."""
        res = run_lightning_risk(_lr_request(explosion_risk=True))
        assert res.systems_life_risk
        rc = next(c for c in res.components if c.code == "RC")
        nd = res.flashes_to_structure_per_year
        assert rc.value == pytest.approx(nd * 1.0 * 1e-1, rel=1e-6)
        assert not res.compliant

    def test_recommendation_ladder_monotonic(self):
        """Each step up the protection ladder must not increase R1, and a
        high-exposure case (isolated entertainment venue, Ng=6, rural aerial
        supply, average panic) must recommend real protection. Hand calc:
        unprotected R_V = N_L·L_V = 0.24 × 2.5e-3 = 6e-4 ≫ RT, while
        LPS I + LPL I SPDs give R1 ≈ 7.4e-6 < RT."""
        line = LightningLine(name="Incomer", type="power", length_m=1000.0,
                             installation="aerial", environment="rural",
                             has_transformer=False)
        res = run_lightning_risk(_lr_request(
            ground_flash_density=6.0, location="isolated",
            structure_use="entertainment_church_museum",
            hazard_level="average_panic", lines=[line]))
        r1s = [o.r1 for o in res.options]
        assert all(a >= b - 1e-15 for a, b in zip(r1s, r1s[1:]))
        assert not res.compliant
        assert "Install" in res.recommendation
        assert res.options[-1].compliant  # LPS I + SPD I suffices here

    def test_beyond_ladder_case_warns(self):
        """Hospital on an isolated hilltop with high fire risk and Ng=12:
        even LPS I + LPL I SPDs cannot reach RT (induced-surge and fire
        losses dominate) — the engine must say so rather than recommend an
        insufficient measure."""
        line = LightningLine(name="Incomer", type="power", length_m=1000.0,
                             installation="aerial", environment="rural",
                             has_transformer=False)
        res = run_lightning_risk(_lr_request(
            ground_flash_density=12.0, location="isolated_hilltop",
            structure_use="hospital_hotel_school",
            hazard_level="difficult_evacuation", fire_risk="high",
            lines=[line]))
        assert not res.compliant
        assert not res.options[-1].compliant
        assert "cannot be reduced" in res.recommendation
        assert any("additional measures" in w for w in res.warnings)

    def test_tolerable_level(self):
        assert TOLERABLE_R1 == 1e-5


# ── Raceway / conduit fill ───────────────────────────────────────────────

from backend.models.schemas import RacewayRequest, RacewayDef, RacewayCable
from backend.analysis.raceway import (
    run_raceway_analysis, grouping_factor, estimate_od_mm)


def _raceway(nominal_mm, cables, name="RW-1", conduit_id_mm=0.0):
    return RacewayRequest(raceways=[RacewayDef(
        name=name, conduit_nominal_mm=nominal_mm,
        conduit_id_mm=conduit_id_mm, cables=cables)])


def _cbl(cid, size=70.0, od=0.0, rated=245.0, load=0.0):
    return RacewayCable(cable_id=cid, name=cid, size_mm2=size, od_mm=od,
                        rated_amps=rated, load_amps=load)


class TestRaceway:
    def test_fill_three_cables_within_40pct(self):
        """110 mm conduit (ID 102.7 → 8283 mm²) with 3 × 70 mm² SWA
        (OD 36 → 1017.9 mm² each): fill = 3053.6/8283 = 36.9 % ≤ 40 %.
        Jam ratio = 1.05·102.7/36 = 3.00 → inside the 2.8–3.2 danger band,
        so the raceway passes fill but carries a jam warning."""
        res = run_raceway_analysis(_raceway(110, [_cbl("c1"), _cbl("c2"), _cbl("c3")]))
        rw = res.raceways[0]
        assert rw.conduit_area_mm2 == pytest.approx(math.pi * 51.35**2, rel=1e-3)
        assert rw.fill_pct == pytest.approx(36.9, abs=0.15)
        assert rw.fill_ok and rw.fill_limit_pct == 40.0
        assert rw.jam_ratio == pytest.approx(1.05 * 102.7 / 36.0, abs=0.01)
        assert rw.jam_warning and rw.status == "warning"

    def test_fill_two_cables_31pct_limit_fails(self):
        """2 cables use the 31 % NEC limit: 2 × 70 mm² in a 50 mm conduit
        (ID 45.1 → 1597 mm²) is 127 % fill — hard fail."""
        res = run_raceway_analysis(_raceway(50, [_cbl("c1"), _cbl("c2")]))
        rw = res.raceways[0]
        assert rw.fill_limit_pct == 31.0
        assert rw.fill_pct > 100 and not rw.fill_ok and rw.status == "fail"

    def test_single_cable_53pct_limit(self):
        """1 cable uses the 53 % limit: 95 mm² (OD 41 → 1320 mm²) in a
        63 mm conduit (ID 57 → 2552 mm²) is 51.7 % — passes only at the
        single-cable limit."""
        res = run_raceway_analysis(_raceway(63, [_cbl("c1", size=95, rated=310)]))
        rw = res.raceways[0]
        assert rw.fill_limit_pct == 53.0
        assert rw.fill_pct == pytest.approx(51.7, abs=0.3)
        assert rw.fill_ok and rw.grouping_factor == 1.0

    def test_grouping_factors_iec_b52_17(self):
        """IEC 60364-5-52 Table B.52.17 item 1 spot values; counts between
        tabulated entries take the next-higher entry (conservative)."""
        assert grouping_factor(1) == 1.0
        assert grouping_factor(3) == 0.70
        assert grouping_factor(9) == 0.50
        assert grouping_factor(10) == 0.45   # between 9 and 12 → 12's factor
        assert grouping_factor(25) == 0.38   # beyond table end
    def test_derated_ampacity_flags_overload(self):
        """3 × 70 mm² (245 A) grouped → 0.7 × 245 = 171.5 A each. A cable
        carrying 200 A fails even though fill and jam are fine in a
        160 mm conduit."""
        res = run_raceway_analysis(_raceway(160, [
            _cbl("c1", load=200), _cbl("c2"), _cbl("c3")]))
        rw = res.raceways[0]
        assert rw.fill_ok and not rw.jam_warning
        assert rw.grouping_factor == 0.70
        c1 = next(c for c in rw.cables if c.cable_id == "c1")
        assert c1.derated_amps == pytest.approx(171.5, abs=0.1)
        assert not c1.adequate and rw.status == "fail"

    def test_od_estimation_log_interpolation(self):
        """60 mm² sits between the 50 mm² (32 mm) and 70 mm² (36 mm)
        catalogue points: log-interp gives ≈ 34.2 mm."""
        assert estimate_od_mm(60) == pytest.approx(34.17, abs=0.05)

    def test_explicit_od_override_and_empty(self):
        """An explicit od_mm bypasses estimation; an empty raceway reports
        status 'empty' with a warning."""
        res = run_raceway_analysis(RacewayRequest(raceways=[
            RacewayDef(name="A", conduit_nominal_mm=110,
                       cables=[_cbl("c1", od=30.0)]),
            RacewayDef(name="B", conduit_nominal_mm=50, cables=[]),
        ]))
        a, b = res.raceways
        assert a.cables[0].od_mm == 30.0 and not a.cables[0].od_estimated
        assert b.status == "empty" and b.warnings
        assert res.summary["total"] == 2


# ─────────────────────────────────────────────────────────────────────
# Battery storage (BESS + hybrid PV) — load flow, fault, backup study
# ─────────────────────────────────────────────────────────────────────

from backend.analysis.backup_autonomy import run_backup_autonomy


_BATT_PROPS = {
    "name": "BESS", "rated_kva": 100, "voltage_kv": 0.4, "battery_kwh": 200,
    "battery_dod_pct": 90, "battery_max_charge_kw": 80,
    "battery_max_discharge_kw": 80, "battery_rt_eff": 0.95,
    "battery_soc_pct": 100, "fault_contribution_pu": 1.1,
}


def _battery_net(mode, load_kva=120, soc=100, pv_kw=None, with_utility=True):
    comps = [
        _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 0.4}),
        _comp("load-1", "static_load", {
            "rated_kva": load_kva, "power_factor": 1.0,
            "demand_factor": 1.0, "voltage_kv": 0.4}),
        _comp("batt-1", "battery", dict(_BATT_PROPS, battery_mode=mode,
                                        battery_soc_pct=soc)),
    ]
    wires = [_wire("w2", "load-1", "bus-1"), _wire("w3", "batt-1", "bus-1")]
    if with_utility:
        comps.append(_comp("util-1", "utility", {
            "voltage_kv": 0.4, "fault_mva": 100, "x_r_ratio": 10}))
        wires.append(_wire("w1", "util-1", "bus-1"))
    if pv_kw is not None:
        comps.append(_comp("pv-1", "solar_pv", {
            "rated_kw": pv_kw, "num_inverters": 1, "inverter_eff": 1.0,
            "power_factor": 1.0, "irradiance_pct": 100, "voltage_kv": 0.4,
            "dispatch_mode": "must_run"}))
        wires.append(_wire("w4", "pv-1", "bus-1"))
    return ProjectData(name="t", components=comps, wires=wires,
                       baseMVA=100, frequency=50)


def _batt_entry(res):
    return next((e for e in res.dispatch if e.source_type == "battery"), None)


class TestBatteryLoadFlow:
    def test_explicit_discharging_injects_at_limit(self):
        """'discharging' mode injects the 80 kW discharge limit."""
        r = run_load_flow(_battery_net("discharging"))
        e = _batt_entry(r)
        assert r.converged and e.role == "discharging"
        assert e.dispatched_mw == pytest.approx(0.08, abs=1e-6)

    def test_charging_draws_and_gates_at_full_soc(self):
        """'charging' draws 80 kW below 100% SoC and is inert when full."""
        e = _batt_entry(run_load_flow(_battery_net("charging", soc=60)))
        assert e.role == "charging"
        assert e.dispatched_mw == pytest.approx(-0.08, abs=1e-6)
        assert _batt_entry(run_load_flow(_battery_net("charging", soc=100))) is None

    def test_auto_discharge_matches_deficit(self):
        """auto: 50 kW load with no renewables → discharge exactly 50 kW."""
        e = _batt_entry(run_load_flow(_battery_net("auto", load_kva=50)))
        assert e.role == "discharging"
        assert e.dispatched_mw == pytest.approx(0.05, abs=1e-6)

    def test_auto_charges_from_pv_surplus(self):
        """auto: 200 kW PV vs 120 kW load → charges at the 80 kW limit."""
        e = _batt_entry(run_load_flow(_battery_net("auto", soc=60, pv_kw=200)))
        assert e.role == "charging"
        assert e.dispatched_mw == pytest.approx(-0.08, abs=1e-6)

    def test_discharge_gated_at_dod_floor(self):
        """SoC at the 10% DoD reserve floor (DoD 90%) → no discharge."""
        assert _batt_entry(run_load_flow(_battery_net("auto", soc=10))) is None

    def test_islanded_discharging_bess_is_slack(self):
        """Grid outage: an explicitly discharging BESS anchors the island."""
        r = run_load_flow(_battery_net("discharging", load_kva=50,
                                       with_utility=False))
        assert r.converged
        bal = next(e for e in r.dispatch if e.role == "balancer")
        assert bal.source_type == "battery"

    def test_islanded_auto_battery_does_not_anchor(self):
        """A grid-following (auto) battery never forms an island."""
        r = run_load_flow(_battery_net("auto", load_kva=50, with_utility=False))
        assert not any(e.role == "balancer" for e in r.dispatch)

    def test_hybrid_discharge_capped_by_inverter_headroom(self):
        """DC-coupled hybrid at 40% sun: 100 kVA inverter − 40 kW PV leaves
        60 kW headroom, so the 60 kW discharge fits; at full sun it is 0."""
        def hybrid(irr):
            return ProjectData(name="t", baseMVA=100, frequency=50, components=[
                _comp("util-1", "utility", {"voltage_kv": 0.4, "fault_mva": 100,
                                            "x_r_ratio": 10}),
                _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 0.4}),
                _comp("load-1", "static_load", {"rated_kva": 200, "power_factor": 1.0,
                                                "demand_factor": 1.0, "voltage_kv": 0.4}),
                _comp("pv-1", "solar_pv", {
                    "rated_kw": 100, "num_inverters": 1, "inverter_eff": 1.0,
                    "power_factor": 1.0, "irradiance_pct": irr, "voltage_kv": 0.4,
                    "inverter_type": "hybrid", "battery_kwh": 100,
                    "battery_dod_pct": 90, "battery_soc_pct": 100,
                    "battery_max_charge_kw": 60, "battery_max_discharge_kw": 60,
                    "battery_mode": "discharging"}),
            ], wires=[_wire("w1", "util-1", "bus-1"), _wire("w2", "load-1", "bus-1"),
                      _wire("w3", "pv-1", "bus-1")])
        e = _batt_entry(run_load_flow(hybrid(40)))
        assert e.dispatched_mw == pytest.approx(0.06, abs=1e-6)
        e_full = _batt_entry(run_load_flow(hybrid(100)))
        assert e_full is None or abs(e_full.dispatched_mw) < 1e-9


class TestBatteryFault:
    def test_bess_inverter_limited_contribution(self):
        """400 kVA BESS at 0.4 kV, k=1.2: Ik'' = c × 1.2 × Irated
        = 1.1 × 1.2 × 577.4 A ≈ 0.762 kA (X/R=10 detail shifts it slightly)."""
        p = ProjectData(name="t", baseMVA=100, frequency=50, components=[
            _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 0.4}),
            _comp("batt-1", "battery", {
                "rated_kva": 400, "voltage_kv": 0.4, "battery_kwh": 200,
                "fault_contribution_pu": 1.2, "battery_mode": "idle"}),
        ], wires=[_wire("w1", "batt-1", "bus-1")])
        r = run_fault_analysis(p)
        i_rated_ka = 400 / (math.sqrt(3) * 400)
        assert r.buses["bus-1"].ik3 == pytest.approx(1.1 * 1.2 * i_rated_ka, rel=0.01)


class TestBackupAutonomy:
    def _project(self, load_kva=8):
        return ProjectData(name="t", baseMVA=100, frequency=50, components=[
            _comp("util-1", "utility", {"voltage_kv": 0.4, "fault_mva": 100}),
            _comp("bus-1", "bus", {"name": "Essential", "voltage_kv": 0.4}),
            _comp("load-1", "static_load", {"rated_kva": load_kva, "power_factor": 1.0,
                                            "demand_factor": 1.0, "voltage_kv": 0.4}),
            _comp("pv-1", "solar_pv", {
                "name": "Hybrid-1", "rated_kw": 10, "num_inverters": 1,
                "inverter_eff": 1.0, "power_factor": 1.0, "irradiance_pct": 20,
                "voltage_kv": 0.4, "inverter_type": "hybrid", "battery_kwh": 10,
                "battery_dod_pct": 90, "battery_soc_pct": 100,
                "battery_max_charge_kw": 5, "battery_max_discharge_kw": 8,
                "battery_rt_eff": 0.9025, "battery_mode": "auto"}),
            _comp("cb-1", "cb", {"state": "open", "rated_voltage_kv": 0.4}),
            _comp("bus-2", "bus", {"name": "NonEssential", "voltage_kv": 0.4}),
            _comp("load-2", "static_load", {"rated_kva": 5, "power_factor": 1.0,
                                            "demand_factor": 1.0, "voltage_kv": 0.4}),
        ], wires=[
            _wire("w1", "util-1", "bus-1"), _wire("w2", "load-1", "bus-1"),
            _wire("w3", "pv-1", "bus-1"), _wire("w4", "bus-1", "cb-1"),
            _wire("w5", "cb-1", "bus-2"), _wire("w6", "load-2", "bus-2"),
        ])

    def test_autonomy_hand_calc(self):
        """8 kW load; usable = 10 kWh × 90% DoD × √0.9025 = 8.55 kWh →
        night 8.55/8 = 1.07 h; with 2 kW PV: 8.55/6 = 1.425 h."""
        r = run_backup_autonomy(self._project())
        backed = next(i for i in r["islands"] if i["backed_up"])
        assert backed["usable_kwh"] == pytest.approx(8.55, abs=0.01)
        assert backed["autonomy_night_h"] == pytest.approx(1.07, abs=0.01)
        assert backed["autonomy_pv_h"] == pytest.approx(1.425, abs=0.011)
        assert backed["inverter_ok"] and backed["power_ok_night"]

    def test_open_cb_island_reported_dark(self):
        """The island behind the open CB has load but no backup source."""
        r = run_backup_autonomy(self._project())
        dark = next(i for i in r["islands"] if not i["backed_up"])
        assert dark["bus_names"] == ["NonEssential"]
        assert dark["load_kw"] == pytest.approx(5.0)

    def test_inverter_overload_flagged(self):
        """15 kVA island load against a 10 kVA hybrid inverter fails both
        the capacity and the night power checks."""
        r = run_backup_autonomy(self._project(load_kva=15))
        b = next(i for i in r["islands"] if i["backed_up"])
        assert not b["inverter_ok"] and not b["power_ok_night"]

    def test_pv_covering_load_unbounded_autonomy(self):
        """1.5 kW load under 2 kW of PV → with-PV autonomy unbounded (null)."""
        r = run_backup_autonomy(self._project(load_kva=1.5))
        b = next(i for i in r["islands"] if i["backed_up"])
        assert b["autonomy_pv_h"] is None and b["power_ok_pv"]

    def test_non_essential_load_shed(self):
        """A 4 kW load flagged essential='no' is excluded from every check:
        autonomy stays 8.55/8 = 1.07 h and shed_kw reports 4 kW."""
        p = self._project()
        p.components.append(_comp("load-3", "static_load", {
            "rated_kva": 4, "power_factor": 1.0, "demand_factor": 1.0,
            "voltage_kv": 0.4, "essential": "no"}))
        p.wires.append(_wire("w7", "load-3", "bus-1"))
        r = run_backup_autonomy(p)
        b = next(i for i in r["islands"] if i["backed_up"])
        assert b["load_kw"] == pytest.approx(8.0)
        assert b["shed_kw"] == pytest.approx(4.0)
        assert b["autonomy_night_h"] == pytest.approx(1.07, abs=0.01)
        assert any("non-essential load excluded" in n for n in b["notes"])


class TestPVArrayMode:
    """Array-mode solar: output = min(DC array × irradiance, inverter kW)."""

    def _pv_net(self, irr, dc_ac=1.32):
        # 10 kW inverter; 2 strings × 12 panels × 550 W = 13.2 kWp DC
        return ProjectData(name="t", baseMVA=100, frequency=50, components=[
            _comp("util-1", "utility", {"voltage_kv": 0.4, "fault_mva": 100,
                                        "x_r_ratio": 10}),
            _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 0.4}),
            _comp("load-1", "static_load", {"rated_kva": 20, "power_factor": 1.0,
                                            "demand_factor": 1.0, "voltage_kv": 0.4}),
            _comp("pv-1", "solar_pv", {
                "rated_kw": 10, "num_inverters": 1, "inverter_eff": 1.0,
                "power_factor": 1.0, "irradiance_pct": irr, "voltage_kv": 0.4,
                "pv_array_mode": "array", "pv_panel_w": 550,
                "pv_panels_per_string": 12, "pv_strings": 2,
                "dispatch_mode": "must_run"}),
        ], wires=[_wire("w1", "util-1", "bus-1"), _wire("w2", "load-1", "bus-1"),
                  _wire("w3", "pv-1", "bus-1")])

    def _pv_entry(self, res):
        return next(e for e in res.dispatch if e.source_type == "solar_pv")

    def test_clipped_at_full_sun(self):
        """13.2 kWp DC at 100% clips to the 10 kW inverter nameplate."""
        e = self._pv_entry(run_load_flow(self._pv_net(100)))
        assert e.available_mw == pytest.approx(0.010, abs=1e-6)

    def test_follows_dc_below_clip(self):
        """At 50% irradiance the DC array gives 6.6 kW — below the clip."""
        e = self._pv_entry(run_load_flow(self._pv_net(50)))
        assert e.available_mw == pytest.approx(0.0066, abs=1e-6)

    def test_rated_mode_unchanged(self):
        """Legacy rated mode ignores the array fields entirely."""
        p = self._pv_net(100)
        p.components[3].props["pv_array_mode"] = "rated"
        e = self._pv_entry(run_load_flow(p))
        assert e.available_mw == pytest.approx(0.010, abs=1e-6)
        p.components[3].props["irradiance_pct"] = 50
        e = self._pv_entry(run_load_flow(p))
        assert e.available_mw == pytest.approx(0.005, abs=1e-6)


# ── DC Load Flow & DC Short Circuit (IEC 61660-1) ────────────────────────

from backend.analysis.dc_loadflow import run_dc_load_flow
from backend.analysis.dc_shortcircuit import run_dc_short_circuit


def _dc_bus(cid, name, vdc=120.0):
    return _comp(cid, "bus", {"name": name, "system": "dc", "voltage_dc_v": vdc})


class TestDCLoadFlow:
    """Resistive DC nodal solve. Hand calc for a battery-fed radial feeder:
    E = 120 V behind Rs = 0.1 Ω on bus A; cable A→B loop R = 2·0.5·0.1 = 0.1 Ω;
    a 10 A constant-current load on bus B. Nodal solution: V_A = 119 V,
    V_B = 118 V, battery current = 10 A."""

    def _net(self, load_model="constant_current"):
        comps = [
            _comp("bat-1", "dc_battery",
                  {"name": "Bank", "nominal_v": 120, "internal_r_mohm": 100,
                   "ah_capacity": 200}),
            _dc_bus("bus-a", "DC A"),
            _comp("cbl-1", "cable",
                  {"name": "Feeder", "r_per_km": 0.5, "x_per_km": 0.08,
                   "length_km": 0.1, "num_parallel": 1, "rated_amps": 100}),
            _dc_bus("bus-b", "DC B"),
            _comp("ld-1", "dc_load",
                  {"name": "Load", "load_model": load_model, "load_a": 10,
                   "load_kw": 1.18}),
        ]
        wires = [
            _wire("w1", "bat-1", "bus-a"),
            _wire("w2", "bus-a", "cbl-1"),
            _wire("w3", "cbl-1", "bus-b"),
            _wire("w4", "bus-b", "ld-1"),
        ]
        return ProjectData(projectName="dc", components=comps, wires=wires)

    def test_bus_voltages(self):
        res = run_dc_load_flow(self._net())
        assert res.converged
        assert res.buses["bus-a"].voltage_v == pytest.approx(119.0, abs=0.2)
        assert res.buses["bus-b"].voltage_v == pytest.approx(118.0, abs=0.3)

    def test_source_current_equals_load(self):
        res = run_dc_load_flow(self._net())
        src = next(s for s in res.sources if s.source_id == "bat-1")
        assert src.current_a == pytest.approx(10.0, abs=0.1)

    def test_branch_loop_resistance_two_wire(self):
        """DC cable uses go-and-return loop resistance 2·r·ℓ = 0.1 Ω."""
        res = run_dc_load_flow(self._net())
        br = next(b for b in res.branches if b.elementId == "cbl-1")
        assert br.resistance_ohm == pytest.approx(0.1, abs=1e-4)
        assert br.current_a == pytest.approx(10.0, abs=0.1)

    def test_constant_power_load_draws_rated_power(self):
        """A 1.18 kW constant-power load at ~118 V draws ~10 A."""
        res = run_dc_load_flow(self._net("constant_power"))
        assert res.buses["bus-b"].load_kw == pytest.approx(1.18, abs=0.02)

    def test_island_without_source_deenergized(self):
        comps = [_dc_bus("bus-x", "Orphan")]
        res = run_dc_load_flow(ProjectData(projectName="dc", components=comps, wires=[]))
        assert res.buses["bus-x"].energized is False

    def test_no_dc_bus_returns_warning(self):
        comps = [_comp("bus-1", "bus", {"name": "AC", "voltage_kv": 11})]
        res = run_dc_load_flow(ProjectData(projectName="ac", components=comps, wires=[]))
        assert res.converged is False
        assert res.buses == {}


class TestDCShortCircuit:
    """IEC 61660-1 battery source with the full standard factors:
    E_B = 1.05·U_nB, peak i_pB = E_B/(0.9·R_B + R_net),
    quasi-steady I_kB = 0.95·E_B/(R_B + R_net)."""

    def _net(self, add_charger=False):
        comps = [
            _comp("bat-1", "dc_battery",
                  {"name": "Bank", "nominal_v": 120, "internal_r_mohm": 100}),
            _dc_bus("bus-a", "DC A"),
            _comp("cbl-1", "cable",
                  {"name": "Feeder", "r_per_km": 0.5, "x_per_km": 0.08,
                   "length_km": 0.1, "num_parallel": 1, "rated_amps": 100}),
            _dc_bus("bus-b", "DC B"),
        ]
        wires = [
            _wire("w1", "bat-1", "bus-a"),
            _wire("w2", "bus-a", "cbl-1"),
            _wire("w3", "cbl-1", "bus-b"),
        ]
        if add_charger:
            comps.append(_comp("chg-1", "charger",
                               {"name": "Chg", "rated_a": 200, "float_voltage_v": 130}))
            wires.append(_wire("w4", "chg-1", "bus-a"))
        return ProjectData(projectName="dc", components=comps, wires=wires)

    def test_battery_bolted_fault_at_terminals(self):
        """Fault at the battery bus (R_net = 0, R_B = 0.1 Ω, E_B = 1.05·120 = 126 V):
        i_p = 126/(0.9·0.1) = 1.40 kA, I_k = 0.95·126/0.1 = 1.197 kA."""
        res = run_dc_short_circuit(self._net(), fault_bus_id="bus-a")
        b = res.buses["bus-a"]
        assert b.ip_ka == pytest.approx(1.40, abs=0.02)
        assert b.ik_ka == pytest.approx(1.197, abs=0.02)

    def test_battery_fault_through_cable(self):
        """Fault at bus B (R_B = 0.1, loop R = 0.1 Ω, E_B = 126 V):
        i_p = 126/(0.09 + 0.1) = 0.663 kA, I_k = 0.95·126/0.2 = 0.599 kA."""
        res = run_dc_short_circuit(self._net(), fault_bus_id="bus-b")
        b = res.buses["bus-b"]
        assert b.ip_ka == pytest.approx(0.663, abs=0.02)
        assert b.ik_ka == pytest.approx(0.599, abs=0.02)

    def test_converter_current_limited_superposition(self):
        """Charger adds a current-limited partial current 1.5·200 A = 0.30 kA,
        superposed on the battery's 1.197 kA I_k at the common bus."""
        res = run_dc_short_circuit(self._net(add_charger=True), fault_bus_id="bus-a")
        b = res.buses["bus-a"]
        types = {c.source_type for c in b.contributions}
        assert types == {"dc_battery", "charger"}
        chg = next(c for c in b.contributions if c.source_type == "charger")
        assert chg.ik_ka == pytest.approx(0.30, abs=0.01)
        assert b.ik_ka == pytest.approx(1.197 + 0.30, abs=0.03)

    def test_published_iec61660_peak_from_nameplate(self):
        """CED E03-035 Example 1: 60-cell 120 V, 200 Ah battery, R_B = 18.6 mΩ,
        connectors + cable = 6.498 mΩ → published peak i_pB = 5422 A. The full
        IEC 61660-1 factors (E_B = 1.05·120 = 126 V, 0.9·R_B) must reproduce it
        from raw nameplate inputs: i_p = 126/(0.9·0.0186 + 0.006498) = 5422 A."""
        comps = [
            _comp("bat-1", "dc_battery",
                  {"name": "Bank", "nominal_v": 120, "internal_r_mohm": 18.6}),
            _dc_bus("bus-a", "DC A"),
            # loop R = 2·r·ℓ = 2·0.06498·0.05 = 0.006498 Ω (connectors + cable)
            _comp("cbl-1", "cable",
                  {"name": "Feeder", "r_per_km": 0.06498, "x_per_km": 0.0,
                   "length_km": 0.05, "num_parallel": 1, "rated_amps": 6000}),
            _dc_bus("bus-b", "DC B"),
        ]
        wires = [_wire("w1", "bat-1", "bus-a"),
                 _wire("w2", "bus-a", "cbl-1"),
                 _wire("w3", "cbl-1", "bus-b")]
        proj = ProjectData(projectName="dc", components=comps, wires=wires)
        res = run_dc_short_circuit(proj, fault_bus_id="bus-b")
        b = res.buses["bus-b"]
        assert b.ip_ka == pytest.approx(5.422, abs=0.01)   # exact, from nameplate

    def test_no_dc_bus_returns_warning(self):
        comps = [_comp("bus-1", "bus", {"name": "AC", "voltage_kv": 11})]
        res = run_dc_short_circuit(ProjectData(projectName="ac", components=comps, wires=[]))
        assert res.converged is False


# ── LV earthing system (TN / TT / IT) — IEC 60364-1 / SANS 10142-1 ─────────


class TestLvEarthingSystem:
    """The declared LV earthing system reshapes the zero-sequence earth-fault
    loop for LV (≤1 kV) sources. TN-* keeps the metallic (low-impedance)
    return; TT adds the soil-electrode resistance R_A+R_B (as 3·(R_A+R_B) in
    the Z0 network) so the earth-fault current collapses; IT breaks the
    first-fault path entirely (Ik1 ≈ 0). MV/HV faults are untouched."""

    @staticmethod
    def _lv_project(earthing_system=None, r_a=20.0, r_b=1.0):
        xf_props = {
            "name": "TX1", "rated_mva": 1.0, "z_percent": 5.0,
            "x_r_ratio": 8.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
            "vector_group": "Dyn11", "grounding_lv": "solidly_grounded",
        }
        if earthing_system is not None:
            xf_props["earthing_system"] = earthing_system
            xf_props["earth_electrode_r_installation"] = r_a
            xf_props["earth_electrode_r_source"] = r_b
        xfmr = _comp("transformer-1", "transformer", xf_props)
        lv_bus = _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4})
        return _utility_bus_project(
            fault_mva=500.0,
            extra_components=[xfmr, lv_bus],
            extra_wires=[_wire("w2", "bus-1", "transformer-1"),
                         _wire("w3", "transformer-1", "bus-2")])

    def test_default_field_absent_matches_tn(self):
        """A legacy project (no earthing_system field) must give exactly the
        same LV earth-fault current as an explicit TN-S declaration — the
        feature is inert until opted into."""
        legacy = run_fault_analysis(self._lv_project(None)).buses["bus-2"]
        tns = run_fault_analysis(self._lv_project("TN-S")).buses["bus-2"]
        assert legacy.ik1 > 0
        assert tns.ik1 == pytest.approx(legacy.ik1, rel=1e-9)

    def test_tn_variants_are_identical(self):
        """TN-S, TN-C and TN-C-S all use the metallic return — the fault
        current is the same for all three (they differ only in wiring rules,
        checked in compliance, not in the earth-fault loop)."""
        tns = run_fault_analysis(self._lv_project("TN-S")).buses["bus-2"].ik1
        tnc = run_fault_analysis(self._lv_project("TN-C")).buses["bus-2"].ik1
        tncs = run_fault_analysis(self._lv_project("TN-C-S")).buses["bus-2"].ik1
        assert tnc == pytest.approx(tns, rel=1e-9)
        assert tncs == pytest.approx(tns, rel=1e-9)

    def test_tt_collapses_earth_fault_current(self):
        """TT adds 3·(R_A+R_B) to the zero-sequence loop. With R_A=20 Ω and
        R_B=1 Ω on a 0.4 kV base, that soil resistance dwarfs the transformer
        impedance, so Ik1 must fall far below the TN value while the 3-phase
        fault (which never uses Z0) is unchanged."""
        tn = run_fault_analysis(self._lv_project("TN-S")).buses["bus-2"]
        tt = run_fault_analysis(self._lv_project("TT", r_a=20.0, r_b=1.0)).buses["bus-2"]
        assert tt.ik3 == pytest.approx(tn.ik3, rel=1e-9)   # 3φ unaffected
        assert tt.ik1 < 0.05 * tn.ik1                      # earth fault collapses

    def test_tt_larger_electrode_gives_less_current(self):
        """Monotonicity: a higher installation electrode resistance R_A means
        a higher loop impedance and therefore a smaller earth-fault current."""
        low = run_fault_analysis(self._lv_project("TT", r_a=10.0)).buses["bus-2"].ik1
        high = run_fault_analysis(self._lv_project("TT", r_a=100.0)).buses["bus-2"].ik1
        assert 0 < high < low

    def test_it_has_no_first_fault_current(self):
        """IT declares an unearthed / high-impedance source: the first earth
        fault has no zero-sequence return, so Ik1 ≈ 0 (Ik3 unaffected)."""
        it = run_fault_analysis(self._lv_project("IT")).buses["bus-2"]
        assert it.ik3 > 0
        assert it.ik1 == pytest.approx(0.0, abs=1e-6)

    def test_mv_transformer_ignores_earthing_system(self):
        """The field only applies to LV (≤1 kV) windings. A TT declaration on
        an 11 kV secondary must not touch the MV earth-fault current."""
        def _mv(es):
            props = {
                "name": "TX", "rated_mva": 10.0, "z_percent": 8.0,
                "x_r_ratio": 10.0, "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0,
                "vector_group": "YNyn0", "grounding_hv": "solidly_grounded",
                "grounding_lv": "solidly_grounded",
            }
            if es:
                props["earthing_system"] = es
                props["earth_electrode_r_installation"] = 50.0
                props["earth_electrode_r_source"] = 5.0
            xfmr = _comp("transformer-1", "transformer", props)
            lv_bus = _comp("bus-2", "bus", {"name": "MV Bus", "voltage_kv": 11.0})
            return _utility_bus_project(
                fault_mva=500.0, kv=33.0,
                extra_components=[xfmr, lv_bus],
                extra_wires=[_wire("w2", "bus-1", "transformer-1"),
                             _wire("w3", "transformer-1", "bus-2")])
        base = run_fault_analysis(_mv(None)).buses["bus-2"].ik1
        tt = run_fault_analysis(_mv("TT")).buses["bus-2"].ik1
        assert tt == pytest.approx(base, rel=1e-9)


class TestSingleEarthedStarStar:
    """Zero-sequence behaviour of a single-earthed star-star (YNyn0)
    transformer — one neutral solidly earthed, the other left floating, with
    no delta tertiary. Physically this cannot pass I0 through the floating
    winding, so it is NOT a zero-sequence through-element; the earthed neutral
    sources earth-fault current only through the core zero-sequence magnetising
    reactance Z0m (finite on a three-limb core, ≈ open on five-limb/shell/bank).

    Two rules are pinned: (1) the grounding_* prop — not the vector-group
    letters — decides the path; (2) core construction sets whether a
    single-earthed unit is a weak local source (three-limb) or effectively
    open (five-limb/bank).
    """

    @staticmethod
    def _project(grounding_hv="ungrounded", grounding_lv="solidly_grounded",
                 core=None, z0m=None, set_grounding=True):
        props = {
            "name": "TX", "rated_mva": 10.0, "z_percent": 8.0, "x_r_ratio": 10.0,
            "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0, "vector_group": "YNyn0",
        }
        if set_grounding:
            props["grounding_hv"] = grounding_hv
            props["grounding_lv"] = grounding_lv
        if core is not None:
            props["core_construction"] = core
        if z0m is not None:
            props["z0m_pu"] = z0m
        xfmr = _comp("transformer-1", "transformer", props)
        mv_bus = _comp("bus-2", "bus", {"name": "MV Bus", "voltage_kv": 11.0})
        return _utility_bus_project(
            fault_mva=500.0, kv=33.0,
            extra_components=[xfmr, mv_bus],
            extra_wires=[_wire("w2", "bus-1", "transformer-1", to_port="primary"),
                         _wire("w3", "transformer-1", "bus-2", from_port="secondary")])

    def test_three_limb_single_earthed_is_finite_but_weak(self):
        """Single-earthed (LV earthed, HV floating) three-limb core: the earthed
        LV neutral sources a finite earth-fault current via Z0m, but well below
        both the three-phase level and the both-earthed through-element level."""
        r = run_fault_analysis(self._project(core="three_limb")).buses["bus-2"]
        assert r.ik1 > 0                    # not blocked — a real earth-fault source
        assert r.ik1 < 0.5 * r.ik3          # but weak (Z0m ≫ Z1)

    def test_five_limb_single_earthed_blocks(self):
        """Five-limb / shell / bank core: Z0m ≈ open, so the single-earthed
        neutral sources negligible earth-fault current (Ik1 ≈ 0); Ik3 intact."""
        r = run_fault_analysis(self._project(core="five_limb")).buses["bus-2"]
        assert r.ik3 > 0
        assert r.ik1 == pytest.approx(0.0, abs=1e-6)

    def test_z0m_override_monotonic(self):
        """A smaller Z0m (stiffer core earth path) yields more earth-fault
        current; the override drives it regardless of the core dropdown."""
        low = run_fault_analysis(self._project(z0m=0.3)).buses["bus-2"].ik1
        high = run_fault_analysis(self._project(z0m=1.0)).buses["bus-2"].ik1
        assert low > high > 0

    def test_grounding_prop_is_authoritative_not_vector_group(self):
        """Same YNyn0 vector group: earthing the far (HV) neutral turns the unit
        into a through-element (utility Z0 reaches the fault → much higher Ik1)
        than leaving it floating (Z0m-limited)."""
        single = run_fault_analysis(
            self._project(grounding_hv="ungrounded", core="three_limb")).buses["bus-2"].ik1
        both = run_fault_analysis(
            self._project(grounding_hv="solidly_grounded")).buses["bus-2"].ik1
        assert both > 2 * single

    def test_legacy_no_grounding_props_falls_back_to_vector_group(self):
        """Backward compatibility: a YNyn0 with NO grounding_* props set must
        keep the legacy vector-group interpretation (both windings earthed →
        through-element), identical to explicitly earthing both neutrals."""
        legacy = run_fault_analysis(self._project(set_grounding=False)).buses["bus-2"].ik1
        both = run_fault_analysis(
            self._project(grounding_hv="solidly_grounded")).buses["bus-2"].ik1
        assert legacy == pytest.approx(both, rel=1e-9)


# ── Dynamic motor starting (time-domain acceleration) ────────────────────


class TestDynamicMotorStarting:
    """Time-domain motor-acceleration engine (run_dynamic_motor_starting),
    anchored to the Chapman starting-current methodology and IEEE 3002.7
    reduced-voltage starting. The static locked-rotor voltage dip is pinned by
    TestMotorStarting; these pin the dynamic engine's headline outputs.

    Reference: S. J. Chapman, "Electric Machinery Fundamentals," 4th ed.,
    Problems 7-19/7-20 (starting current from nameplate/equivalent circuit and
    the resulting bus voltage drop). Chapman gives steady-state locked-rotor
    snapshots, so these check the t=0 point of the trajectory (current
    magnitude and dip), not the acceleration curve itself.
    """

    @staticmethod
    def _motor_project(starting_method="dol", rated_kw=200.0, eff=0.93, pf=0.87,
                       lrc=6.5, xf_mva=10.0, xf_z_pct=10.0):
        xfmr = _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": xf_mva, "z_percent": xf_z_pct,
            "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
            "vector_group": "Dyn11",
        })
        lv_bus = _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4})
        motor = _comp("motor_induction-1", "motor_induction", {
            "name": "M1", "rated_kw": rated_kw, "voltage_kv": 0.4,
            "efficiency": eff, "power_factor": pf, "locked_rotor_current": lrc,
            "locked_rotor_torque_pct": 150, "rated_speed_rpm": 1480,
            "motor_j_kgm2": 5.0, "load_j_kgm2": 10.0, "load_torque_pct": 90,
            "load_torque_model": "quadratic", "starting_method": starting_method,
        })
        return _utility_bus_project(
            fault_mva=500.0,
            extra_components=[xfmr, lv_bus, motor],
            extra_wires=[
                _wire("w2", "bus-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-2"),
                _wire("w4", "bus-2", "motor_induction-1"),
            ])

    def test_flc_and_locked_rotor_inrush(self):
        """Full-load current follows the nameplate S = P/(η·pf),
        FLC = S/(√3·V); the DOL inrush is the nameplate locked-rotor multiple
        LRC depressed by the terminal-voltage sag it causes —
        I_start(×FLC) = LRC · V_term(pu), the locked-rotor operating point.

        200 kW, 0.4 kV, η=0.93, pf=0.87 → S = 0.247 MVA, FLC = 356.8 A. With
        LRC = 6.5 the peak line current at V_term ≈ 0.98 pu is ≈ 6.38×FLC
        (≈ 2276 A) — not a flat 6.5× — because the sag scales the inrush.
        """
        res = run_dynamic_motor_starting(self._motor_project("dol"))
        assert res["motors"], f"no motor result; warnings: {res['warnings']}"
        m = res["motors"][0]
        flc = 200.0 / (0.93 * 0.87) / 1000.0 * 1e6 / (math.sqrt(3) * 400.0)
        assert m["flc_a"] == pytest.approx(flc, rel=0.01)          # 356.8 A
        # Inrush is the nameplate LRC multiple scaled by the depressed terminal
        # voltage — both are read at the same locked-rotor instant.
        assert m["peak_current_xflc"] == pytest.approx(
            6.5 * m["min_v_motor_pu"], rel=0.03)
        assert m["peak_current_a"] == pytest.approx(
            m["peak_current_xflc"] * m["flc_a"], rel=0.01)
        assert m["sim_status"] == "started"

    def test_dol_starting_voltage_dip_hand_calc(self):
        """A 1000 kW DOL motor behind a 10 MVA, 10 % transformer sags its bus by
        a first-order Q·X ≈ 7 %, agreeing with the static locked-rotor result in
        TestMotorStarting.test_voltage_dip_magnitude (the dynamic engine's t=0
        point must match). S_start ≈ 6·1000/(0.95·0.85·1000) ≈ 7.4 MVA through
        X_T = 0.10·100/10 = 1.0 pu → dip ≈ 7–8 %."""
        res = run_dynamic_motor_starting(self._motor_project(
            "dol", rated_kw=1000.0, eff=0.95, pf=0.85, lrc=6.0))
        m = res["motors"][0]
        assert 5.0 < m["max_bus_dip_pct"] < 12.0, m["max_bus_dip_pct"]
        assert m["min_v_bus_pu"] < 0.95

    def test_starter_type_reduces_inrush(self):
        """IEEE 3002.7 reduced-voltage starters draw less than DOL. A soft
        starter holds line current at its configured limit (default 3.5×FLC),
        so its peak is that limit; the star-delta and autotransformer peaks
        (their changeover surges) sit below the DOL locked-rotor inrush."""
        def peak(method):
            return run_dynamic_motor_starting(
                self._motor_project(method))["motors"][0]["peak_current_xflc"]
        dol = peak("dol")
        star_delta = peak("star_delta")
        auto = peak("autotransformer")
        soft = peak("soft_starter")
        assert star_delta < dol
        assert auto < dol
        assert soft < star_delta
        assert soft == pytest.approx(3.5, abs=0.15)   # soft-starter current limit


# ── Transient stability (classical single-machine-infinite-bus) ──────────


class TestTransientStabilitySMIB:
    """Classical SMIB critical-clearing-time against the equal-area closed form.

    A generator (E′ behind X′d, no AVR, no governor, no damping — the classical
    model) feeds an infinite bus through a reactance. A bolted 3-φ fault at the
    generator's own bus drives the electrical power to zero during the fault
    (the machine is shorted to the grounded bus and isolated from the infinite
    bus), and clearing without a branch trip restores the pre-fault network.
    For that case the equal-area criterion gives, from the machine's own
    equilibrium alone (H, P_m, δ0):

        cos δ_c = −cos δ0 + sin δ0·(π − 2·δ0)      (P_e = 0 during fault)
        t_c     = √(4·H·(δ_c − δ0) / (ω0·P_m))     (ω0 = 2π·f0)

    which the engine's binary-search CCT must reproduce. Reference: equal-area
    criterion in Grainger & Stevenson "Power System Analysis" ch. 16 and Kundur
    "Power System Stability and Control" ch. 13; the closed form is the standard
    textbook result (e.g. Saadat §11.6).
    """

    @staticmethod
    def _smib_project():
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11.0, "fault_mva": 5000.0,
                "x_r_ratio": 20.0}),
            _comp("bus-inf", "bus", {"name": "Infinite Bus", "voltage_kv": 11.0}),
            _comp("cable-1", "cable", {
                "name": "Tie", "r_per_km": 0.0, "x_per_km": 0.4,
                "length_km": 1.0, "rated_amps": 2000.0, "voltage_kv": 11.0}),
            _comp("bus-gen", "bus", {"name": "Gen Bus", "voltage_kv": 11.0}),
            _comp("gen-1", "generator", {
                "name": "G1", "rated_mva": 60.0, "voltage_kv": 11.0,
                "power_factor": 0.85, "xd_p": 0.30, "inertia_h_s": 4.0,
                "dispatch_mode": "must_run", "gov_mode": "none",
                "avr_mode": "off", "damping_pu": 0.0}),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-inf"),
            _wire("w2", "bus-inf", "cable-1"),
            _wire("w3", "cable-1", "bus-gen"),
            _wire("w4", "gen-1", "bus-gen"),
        ]
        return ProjectData(projectName="smib", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    @staticmethod
    def _equal_area_cct(H, Pm, delta0_deg, f0=50.0):
        d0 = math.radians(delta0_deg)
        cos_dc = -math.cos(d0) + math.sin(d0) * (math.pi - 2.0 * d0)
        dc = math.acos(cos_dc)
        return math.sqrt(4.0 * H * (dc - d0) / (2.0 * math.pi * f0 * Pm))

    def test_smib_cct_matches_equal_area(self):
        """The engine's CCT reproduces the equal-area closed form computed from
        its own reported equilibrium (H, P_m, δ0) — ≈ 0.28 s vs ≈ 0.283 s (~1 %).
        The residual is the RK4/step discretisation, not the 18-step bisection
        (resolution ≈ 4 µs)."""
        res = run_transient_stability(
            self._smib_project(),
            {"type": "fault", "bus": "bus-gen", "find_cct": True})
        assert res["cct_s"] is not None, res["warnings"]
        gen = next(m for m in res["machines"] if m["type"] == "generator")
        # Non-degenerate operating point (equal-area needs 0 < δ0 < 90°)
        assert 5.0 < gen["delta0_deg"] < 85.0
        tc = self._equal_area_cct(gen["h_s"], gen["pm_pu"], gen["delta0_deg"])
        assert res["cct_s"] == pytest.approx(tc, rel=0.06)

    def test_smib_verdict_flips_around_cct(self):
        """Clearing 30 % faster than the CCT is stable; 30 % slower loses
        synchronism — the stable/unstable verdict is sharp about the CCT."""
        cct = run_transient_stability(
            self._smib_project(),
            {"type": "fault", "bus": "bus-gen", "find_cct": True})["cct_s"]
        assert cct is not None
        stable = run_transient_stability(
            self._smib_project(),
            {"type": "fault", "bus": "bus-gen", "clear_time_s": cct * 0.7,
             "find_cct": False})["stable"]
        unstable = run_transient_stability(
            self._smib_project(),
            {"type": "fault", "bus": "bus-gen", "clear_time_s": cct * 1.3,
             "find_cct": False})["stable"]
        assert stable is True
        assert unstable is False


# ── Voltage stability: P-V nose vs. maximum-power-transfer closed form ────


class TestVoltageStabilityNose:
    """The P-V loadability nose against the classical maximum-power-transfer
    result for a load fed through a series reactance from a stiff source.

    For a constant-power, constant-power-factor load supplied through a lossless
    line of reactance X from a source held at E, the power-flow solution ceases
    to exist (the nose / point of voltage collapse) at

        P_max  = E²/(2X) · cosφ/(1 + sinφ)
        V_crit = E/√(2·(1 + sinφ))

    where φ is the load power-factor angle (Q = P·tanφ). Reference: the maximum-
    power-transfer / voltage-collapse derivation in Kundur "Power System
    Stability and Control" §2.3 and Taylor "Power System Voltage Stability"
    §2.2; the φ = 0 case reduces to the familiar P_max = E²/(2X) at V = E/√2,
    δ = 45°.

    ProtectionPro models the utility as an ideal swing bus (E = 1.0 p.u.), scales
    the load at constant power factor via λ, and locates the nose by bisection —
    so λ_critical·P_base must reproduce P_max, and the nose voltage must be
    V_crit. A lossless (r = 0) feeder isolates the reactance so the closed form
    applies exactly.
    """

    KV = 11.0
    BASE_MVA = 100.0
    X_PER_KM = 0.4
    LENGTH_KM = 5.0

    def _network(self, rated_kva, pf):
        cable = _comp("cable-1", "cable", {
            "name": "Feeder", "voltage_kv": self.KV, "r_per_km": 0.0,
            "x_per_km": self.X_PER_KM, "length_km": self.LENGTH_KM,
            "rated_amps": 600.0,
        })
        load_bus = _comp("bus-2", "bus", {"name": "Load Bus", "voltage_kv": self.KV})
        load = _comp("static_load-1", "static_load", {
            "name": "L1", "rated_kva": rated_kva, "power_factor": pf,
            "demand_factor": 1.0, "voltage_kv": self.KV,
        })
        # Utility → bus-1 (swing) → cable → bus-2 → load. A huge fault level keeps
        # bus-1 a stiff 1.0-p.u. source so the nose is set purely by the feeder X.
        return _utility_bus_project(
            fault_mva=100_000.0, kv=self.KV,
            extra_components=[cable, load_bus, load],
            extra_wires=[_wire("w2", "bus-1", "cable-1"),
                         _wire("w3", "cable-1", "bus-2"),
                         _wire("w4", "bus-2", "static_load-1")])

    def _x_pu(self):
        return self.X_PER_KM * self.LENGTH_KM * self.BASE_MVA / self.KV ** 2

    def test_unity_pf_nose_is_e2_over_2x(self):
        """Unity-PF load (φ = 0): P_max = E²/(2X) at V = E/√2 (δ = 45°).
        With X = 1.653 p.u. → P_max = 30.25 MW, and a 12 MW base load gives
        λ_critical = 2.521; the bisected nose reproduces both to <0.1 %."""
        proj = self._network(rated_kva=12_000.0, pf=1.0)
        r = run_voltage_stability(proj, lambda_max=8.0, step=0.05)
        assert r.collapsed, r.note
        p_max = self.BASE_MVA / (2.0 * self._x_pu())        # E²/(2X), E = 1 p.u.
        base_load = sum(connected_bus_loads_mw(proj).values())
        assert base_load == pytest.approx(12.0, rel=1e-6)   # 12 MVA × pf 1.0
        assert r.critical_load_mw == pytest.approx(p_max, rel=0.02)
        assert r.lambda_critical == pytest.approx(p_max / base_load, rel=0.02)
        assert r.nose_v_pu == pytest.approx(1.0 / math.sqrt(2.0), abs=0.02)
        assert r.critical_bus_name == "Load Bus"

    def test_lagging_pf_nose_matches_closed_form(self):
        """Lagging-PF load (pf = 0.9, φ = 25.84°): the nose tightens to
        P_max = E²/(2X)·cosφ/(1+sinφ) at V_crit = E/√(2(1+sinφ)) = 0.590 p.u.
        A non-degenerate power factor exercises the full closed form, not just
        the φ = 0 special case."""
        pf = 0.9
        phi = math.acos(pf)
        proj = self._network(rated_kva=12_000.0, pf=pf)
        r = run_voltage_stability(proj, lambda_max=8.0, step=0.05)
        assert r.collapsed, r.note
        p_max = self.BASE_MVA / (2.0 * self._x_pu()) * pf / (1.0 + math.sin(phi))
        v_crit = 1.0 / math.sqrt(2.0 * (1.0 + math.sin(phi)))
        base_load = sum(connected_bus_loads_mw(proj).values())
        assert r.critical_load_mw == pytest.approx(p_max, rel=0.02)
        assert r.lambda_critical == pytest.approx(p_max / base_load, rel=0.02)
        assert r.nose_v_pu == pytest.approx(v_crit, abs=0.02)


# ── Contingency: loss-of-supply MW and post-outage branch loading ─────────


class TestContingencyWorkedExample:
    """Worked examples pinning the contingency engine's headline numbers.

    Contingency re-solves the (already standards-anchored) load flow with an
    element removed; the engine-specific outputs are the lost-load accounting
    and the surviving-branch loading. Both are pinned here from first principles.
    """

    def test_loss_of_sole_source_loses_full_connected_demand(self):
        """Radial utility → bus → load (800 kVA at pf 0.9 = 0.72 MW). Removing
        the only source de-energizes the bus, so the reported lost load must
        equal the connected real demand exactly (P = S·pf = 0.8·0.9 MW)."""
        comps = [
            _comp("bus-1", "bus", {"name": "Bus", "voltage_kv": 11.0}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 800.0, "power_factor": 0.9,
                "demand_factor": 1.0, "voltage_kv": 11.0}),
        ]
        proj = _utility_bus_project(
            fault_mva=500.0, kv=11.0, extra_components=comps,
            extra_wires=[_wire("w2", "bus-1", "static_load-1")])
        res = run_contingency(proj)
        assert not res.n_minus_1_secure
        grid = {r.id: r for r in res.contingencies}["utility-1"]
        assert grid.status == "islanded"
        assert grid.lost_load_mw == pytest.approx(0.72, rel=1e-3)

    def test_surviving_feeder_loading_matches_2bus_solve(self):
        """Two identical lossless feeders (X = 0.0826 p.u. each) between a stiff
        1.0-p.u. bus and a 3 MW unity-PF load. With one feeder out the survivor
        carries the whole load; the lossless 2-bus flow (E = 1∠0 → jX → load)
        gives, on the upper branch,

            sin 2δ = 2·P·X,  V = E·cos δ,  I = P/V  (p.u.),

        i.e. I = 157.5 A at 11 kV → 157.5 % of the 100 A rating. The engine's
        max_loading_pct must reproduce this independent hand solve."""
        kv, x_per_km, length_km, rated_a, base_mva = 11.0, 0.1, 1.0, 100.0, 100.0
        cab = lambda cid, name: _comp(cid, "cable", {
            "name": name, "voltage_kv": kv, "r_per_km": 0.0, "x_per_km": x_per_km,
            "length_km": length_km, "rated_amps": rated_a})
        comps = [
            cab("cable-1", "A"), cab("cable-2", "B"),
            _comp("bus-2", "bus", {"name": "B2", "voltage_kv": kv}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 3000.0, "power_factor": 1.0,
                "demand_factor": 1.0, "voltage_kv": kv}),
        ]
        wires = [
            _wire("w2", "bus-1", "cable-1"), _wire("w3", "cable-1", "bus-2"),
            _wire("w4", "bus-1", "cable-2"), _wire("w5", "cable-2", "bus-2"),
            _wire("w6", "bus-2", "static_load-1"),
        ]
        proj = _utility_bus_project(fault_mva=1e5, kv=kv,
                                    extra_components=comps, extra_wires=wires)
        res = run_contingency(proj)
        c1 = {r.id: r for r in res.contingencies}["cable-1"]
        assert c1.status == "violations"
        assert any(v.kind == "overload" for v in c1.violations)

        # Independent lossless 2-bus solve for the surviving feeder.
        x_pu = x_per_km * length_km * base_mva / kv ** 2
        p_pu = 3000.0 * 1.0 / 1000.0 / base_mva
        delta = 0.5 * math.asin(2.0 * p_pu * x_pu)     # upper (stable) branch
        v_pu = math.cos(delta)
        i_pu = p_pu / v_pu
        i_base_a = base_mva * 1e6 / (math.sqrt(3) * kv * 1e3)
        expected_loading = i_pu * i_base_a / rated_a * 100.0   # ≈ 157.5 %
        assert c1.max_loading_pct == pytest.approx(expected_loading, rel=0.02)


# ── Harmonic analysis (IEEE 519-2014) ────────────────────────────────────


class TestHarmonics:
    """Pin the VFD harmonic current-source penetration engine."""

    def _vfd_project(self, pulse=6, front_end="diode", reactor=0.0,
                     kvar=0.0, load_kva=1000.0, vfd_kw=800.0, fault_mva=250.0):
        comps = [
            _comp("util-1", "utility",
                  {"name": "Grid", "voltage_kv": 11, "fault_mva": fault_mva, "x_r_ratio": 15}),
            _comp("bus-hv", "bus", {"name": "HV", "voltage_kv": 11}),
            _comp("tx-1", "transformer",
                  {"name": "TX", "rated_mva": 2, "z_percent": 6, "x_r_ratio": 10,
                   "voltage_hv_kv": 11, "voltage_lv_kv": 0.4}),
            _comp("bus-lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _comp("vfd-1", "vfd",
                  {"name": "Drive", "rated_kw": vfd_kw, "voltage_kv": 0.4,
                   "efficiency": 0.96, "load_pct": 100, "displacement_pf": 0.98,
                   "pulse_number": pulse, "front_end": front_end,
                   "input_reactor_pct": reactor}),
        ]
        wires = [
            _wire("w1", "util-1", "bus-hv"),
            _wire("w2", "bus-hv", "tx-1"), _wire("w3", "tx-1", "bus-lv"),
            _wire("w4", "bus-lv", "vfd-1"),
        ]
        if load_kva > 0:
            comps.append(_comp("load-1", "static_load",
                               {"name": "Load", "rated_kva": load_kva,
                                "power_factor": 0.85, "voltage_kv": 0.4}))
            wires.append(_wire("w5", "bus-lv", "load-1"))
        if kvar > 0:
            comps.append(_comp("cap-1", "capacitor_bank",
                               {"name": "PFC", "rated_kvar": kvar, "voltage_kv": 0.4}))
            wires.append(_wire("w6", "bus-lv", "cap-1"))
        return ProjectData(projectName="harm", baseMVA=10.0, frequency=50,
                           components=comps, wires=wires)

    def test_6pulse_ideal_spectrum_is_one_over_h(self):
        """A 6-pulse diode front end injects the characteristic orders
        h = 6k±1 (5,7,11,13,…). No reactor → 5th is the dominant harmonic."""
        proj = self._vfd_project(pulse=6, reactor=0.0)
        vfd = next(c for c in proj.components if c.type == "vfd")
        spec = vfd_current_spectrum(vfd)
        assert set(spec) >= {5, 7, 11, 13}
        assert 3 not in spec and 9 not in spec       # no triplen / even
        assert spec[5] == max(spec.values())          # 5th dominates

    def test_pulse_number_cancels_low_order(self):
        """12-pulse cancels the 5th/7th (dominant pair becomes 11/13); an
        active front end has far lower current THD than a 6-pulse diode."""
        p6 = self._vfd_project(pulse=6, reactor=3.0).components
        s6 = vfd_current_spectrum(next(c for c in p6 if c.type == "vfd"))
        s12 = vfd_current_spectrum(next(c for c in self._vfd_project(pulse=12).components if c.type == "vfd"))
        safe = self._vfd_project(front_end="afe").components
        s_afe = vfd_current_spectrum(next(c for c in safe if c.type == "vfd"))
        thd = lambda s: math.sqrt(sum(v * v for v in s.values()))
        assert s12.get(5, 0) < s6[5]                  # 5th suppressed
        assert thd(s12) < thd(s6)                     # 12-pulse cleaner
        assert thd(s_afe) < thd(s12)                  # AFE cleanest

    def test_reactor_reduces_distortion(self):
        """Adding an input reactor lowers the injected 5th harmonic and the
        resulting bus voltage THD (a diode drive is line-commutated)."""
        no_r = run_harmonics(self._vfd_project(pulse=6, reactor=0.0))
        with_r = run_harmonics(self._vfd_project(pulse=6, reactor=5.0))
        lv_no = next(b for b in no_r["buses"] if b["name"] == "LV")
        lv_r = next(b for b in with_r["buses"] if b["name"] == "LV")
        assert lv_r["thd_v_pct"] < lv_no["thd_v_pct"]

    def test_capacitor_resonance_amplifies_thd(self):
        """A shunt PFC capacitor forms a parallel resonance with the source
        inductance near h ≈ √(Ssc/Qcap); it raises voltage THD versus the same
        network with no capacitor."""
        no_cap = run_harmonics(self._vfd_project(pulse=6, reactor=3.0, kvar=0))
        with_cap = run_harmonics(self._vfd_project(pulse=6, reactor=3.0, kvar=250))
        lv_no = next(b for b in no_cap["buses"] if b["name"] == "LV")
        lv_cap = next(b for b in with_cap["buses"] if b["name"] == "LV")
        assert lv_cap["thd_v_pct"] > lv_no["thd_v_pct"]

    def test_clean_drive_is_ieee519_compliant(self):
        """An 18-pulse drive with a reactor, small relative to the site load,
        stays within IEEE 519 voltage limits."""
        res = run_harmonics(self._vfd_project(pulse=18, reactor=5.0,
                                              vfd_kw=250, load_kva=2000))
        assert res["converged"] and res["compliant"]
        lv = next(b for b in res["buses"] if b["name"] == "LV")
        assert lv["thd_v_pct"] <= lv["thd_limit_pct"]

    def test_ieee519_limit_tables(self):
        """Voltage + current limit selectors match IEEE 519-2014 tables."""
        assert _voltage_limits(0.4) == (5.0, 8.0)     # ≤1 kV
        assert _voltage_limits(11) == (3.0, 5.0)      # 1–69 kV
        assert _tdd_limit(10, 11) == 5.0              # Isc/IL < 20
        assert _tdd_limit(150, 11) == 15.0            # 100 ≤ Isc/IL < 1000

    def test_no_vfd_returns_note(self):
        """With no harmonic source the study returns a benign note, not error."""
        proj = self._vfd_project(pulse=6)
        proj.components = [c for c in proj.components if c.type != "vfd"]
        res = run_harmonics(proj)
        assert res["note"] and res["vfd_sources"] == []


# ── Autotransformer (2W & 3W, OLTC regulation) ───────────────────────────


class TestAutotransformer:
    """Autotransformer load-flow branch, OLTC tap regulation, 3-winding star
    expansion, and fault-path participation."""

    def _2w(self, tap_mode="fixed", tap=0.0, vtarget=1.0, load_kva=60000.0):
        comps = [
            _comp("util", "utility", {"voltage_kv": 132, "fault_mva": 5000, "x_r_ratio": 15}),
            _comp("bhv", "bus", {"voltage_kv": 132, "name": "HV"}),
            _comp("at", "autotransformer",
                  {"windings": 2, "rated_mva": 100, "voltage_hv_kv": 132, "voltage_lv_kv": 66,
                   "z_percent": 8, "x_r_ratio": 30, "tap_mode": tap_mode, "tap_percent": tap,
                   "v_target_pu": vtarget, "regulated_side": "lv",
                   "tap_min_pct": -15, "tap_max_pct": 15, "tap_step_pct": 1.25}),
            _comp("blv", "bus", {"voltage_kv": 66, "name": "LV"}),
            _comp("load", "static_load", {"rated_kva": load_kva, "power_factor": 0.9, "voltage_kv": 66}),
        ]
        wires = [
            _wire("w1", "util", "bhv", "out", "at_0"),
            _wire("w2", "bhv", "at", "at_1", "primary"),
            _wire("w3", "at", "blv", "secondary", "at_0"),
            _wire("w4", "blv", "load", "at_1", "in"),
        ]
        return ProjectData(projectName="at2w", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_2w_behaves_as_tapped_branch(self):
        """A 2-winding autotransformer carries load-flow current with a voltage
        drop set by its impedance (like a two-winding transformer branch)."""
        res = run_load_flow(self._2w(tap=0.0))
        assert res.converged
        v_lv = abs(res.buses["blv"].voltage_pu)
        assert 0.90 < v_lv < 0.99          # loaded LV sags below 1.0

    def test_oltc_regulates_to_target(self):
        """An OLTC autotransformer raises the tap changer to hold its LV bus at
        the target voltage, versus the same unit with a fixed nominal tap."""
        fixed = run_load_flow(self._2w("fixed", 0.0))
        reg = run_load_flow(self._2w("regulating", 0.0, vtarget=1.0))
        v_fixed = abs(fixed.buses["blv"].voltage_pu)
        v_reg = abs(reg.buses["blv"].voltage_pu)
        assert v_reg > v_fixed                       # OLTC boosted the voltage
        assert abs(v_reg - 1.0) <= 0.01              # within ~half a tap step

    def test_2w_fault_propagates(self):
        """Fault current propagates through a 2-winding autotransformer, with
        the HV bus reproducing the utility level and the LV reduced by the
        through-impedance."""
        proj = self._2w()
        proj.components = [c for c in proj.components if c.type != "static_load"]
        proj.wires = [w for w in proj.wires if w.toComponent != "load"]
        res = run_fault_analysis(proj)
        ik_hv = res.buses["bhv"].ik3
        ik_lv = res.buses["blv"].ik3
        assert ik_hv == pytest.approx(5000.0 / (math.sqrt(3) * 132), rel=0.02)
        assert 0 < ik_lv < ik_hv                     # AT impedance limits LV

    def test_3w_star_expansion_energises_all_windings(self):
        """A 3-winding autotransformer is expanded into a star node + three
        legs; all three real buses (HV/LV/TV) solve and are energised, with the
        tertiary sitting deeper in the impedance than the LV."""
        comps = [
            _comp("util", "utility", {"voltage_kv": 132, "fault_mva": 5000, "x_r_ratio": 15}),
            _comp("bhv", "bus", {"voltage_kv": 132, "name": "HV"}),
            _comp("at", "autotransformer",
                  {"windings": 3, "rated_mva": 100, "voltage_hv_kv": 132, "voltage_lv_kv": 66,
                   "voltage_tv_kv": 11, "z_percent": 10, "z_ht_percent": 26, "z_lt_percent": 16,
                   "x_r_ratio": 30, "tap_percent": 0}),
            _comp("blv", "bus", {"voltage_kv": 66, "name": "LV"}),
            _comp("btv", "bus", {"voltage_kv": 11, "name": "TV"}),
            _comp("llv", "static_load", {"rated_kva": 40000, "power_factor": 0.9, "voltage_kv": 66}),
            _comp("ltv", "static_load", {"rated_kva": 10000, "power_factor": 0.9, "voltage_kv": 11}),
        ]
        wires = [
            _wire("w1", "util", "bhv", "out", "at_0"),
            _wire("w2", "bhv", "at", "at_1", "primary"),
            _wire("w3", "at", "blv", "secondary", "at_0"),
            _wire("w4", "at", "btv", "tertiary", "at_0"),
            _wire("w5", "blv", "llv", "at_1", "in"),
            _wire("w6", "btv", "ltv", "at_1", "in"),
        ]
        proj = ProjectData(projectName="at3w", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj)
        assert res.converged
        for bid in ("bhv", "blv", "btv"):
            assert res.buses[bid].energized
        assert abs(res.buses["bhv"].voltage_pu) == pytest.approx(1.0, abs=0.02)
        assert abs(res.buses["btv"].voltage_pu) < abs(res.buses["blv"].voltage_pu) + 1e-6

    def test_star_impedance_decomposition(self):
        """Star-equivalent legs satisfy Z_H+Z_L = Z_HL etc. (the defining
        pair-sum identity of the three-winding T model)."""
        from backend.analysis.loadflow import _star_impedances_pct
        z_h, z_l, z_t = _star_impedances_pct(10.0, 26.0, 16.0)
        assert z_h + z_l == pytest.approx(10.0)      # Z_HL
        assert z_h + z_t == pytest.approx(26.0)      # Z_HT
        assert z_l + z_t == pytest.approx(16.0)      # Z_LT


# ── SVC / STATCOM (FACTS reactive compensation) ──────────────────────────


class TestSVC:
    """Voltage-regulating shunt compensation with reactive limits."""

    def _svc_project(self, with_svc=True, device="statcom", q_max=100.0,
                     load_kva=35000.0, line_km=15.0, control="voltage_regulating",
                     q_fixed=0.0, vset=1.0):
        comps = [
            _comp("util", "utility", {"voltage_kv": 33, "fault_mva": 800, "x_r_ratio": 10}),
            _comp("bs", "bus", {"voltage_kv": 33, "name": "Src"}),
            _comp("ln", "cable", {"voltage_kv": 33, "r_per_km": 0.12, "x_per_km": 0.35,
                                  "length_km": line_km, "rated_amps": 600}),
            _comp("bl", "bus", {"voltage_kv": 33, "name": "Load"}),
            _comp("ld", "static_load", {"rated_kva": load_kva, "power_factor": 0.9, "voltage_kv": 33}),
        ]
        wires = [
            _wire("w1", "util", "bs", "out", "at_0"),
            _wire("w2", "bs", "ln", "at_1", "from"),
            _wire("w3", "ln", "bl", "to", "at_0"),
            _wire("w4", "bl", "ld", "at_1", "in"),
        ]
        if with_svc:
            comps.append(_comp("svc", "svc",
                               {"device_mode": device, "control_mode": control,
                                "v_setpoint_pu": vset, "rated_mvar": q_max,
                                "q_max_mvar": q_max, "q_min_mvar": -q_max,
                                "q_output_mvar": q_fixed, "voltage_kv": 33}))
            wires.append(_wire("w5", "bl", "svc", "at_2", "in"))
        return ProjectData(projectName="svc", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_statcom_holds_setpoint(self):
        """A STATCOM with ample reactive headroom holds its bus at the setpoint,
        well above the un-compensated sag."""
        base = run_load_flow(self._svc_project(with_svc=False))
        comp = run_load_flow(self._svc_project(with_svc=True, q_max=100))
        v_base = abs(base.buses["bl"].voltage_pu)
        v_comp = abs(comp.buses["bl"].voltage_pu)
        assert v_comp > v_base
        assert abs(v_comp - 1.0) <= 0.005
        assert comp.svc and comp.svc[0]["q_mvar"] > 0 and not comp.svc[0]["at_limit"]

    def test_reactive_limit_clamps(self):
        """When the required Q exceeds the limit the unit pins at Q_max, reports
        at_limit, and the bus stays below the setpoint."""
        res = run_load_flow(self._svc_project(with_svc=True, q_max=20))
        s = res.svc[0]
        assert res.converged
        assert s["at_limit"] and s["q_mvar"] == pytest.approx(20.0, abs=0.01)
        assert abs(res.buses["bl"].voltage_pu) < 1.0

    def test_svc_v2_limited_below_statcom(self):
        """An SVC's reactive output is susceptance-limited (Q∝V²), so at a
        depressed voltage it delivers less than a constant-Q STATCOM of the same
        rating — and holds a lower voltage when both are limit-constrained."""
        statcom = run_load_flow(self._svc_project(device="statcom", q_max=20))
        svc = run_load_flow(self._svc_project(device="svc", q_max=20))
        assert statcom.svc[0]["at_limit"] and svc.svc[0]["at_limit"]
        # SVC output is scaled by V² (< 1), so it delivers strictly less Q
        assert svc.svc[0]["q_mvar"] < statcom.svc[0]["q_mvar"]

    def test_fixed_q_injects_setpoint(self):
        """In fixed-Q mode the device injects a set reactive power (like a
        controllable capacitor), raising the bus voltage."""
        base = run_load_flow(self._svc_project(with_svc=False))
        fixed = run_load_flow(self._svc_project(with_svc=True, control="fixed_q", q_fixed=15))
        assert abs(fixed.buses["bl"].voltage_pu) > abs(base.buses["bl"].voltage_pu)


class TestGeneratorReactiveLimits:
    """PV-generator reactive-limit (over-/under-excitation) enforcement —
    the PV↔PQ clamp modelled on the SVC/STATCOM reactive-limit loop."""

    def _pv_gen_project(self, rated_mva, pf, load_kva, load_pf, vset=1.05,
                        q_max=None, q_min=None):
        """Utility slack + feeder + a PV-regulating generator bus carrying a
        local reactive load. A small machine cannot supply the load's Q and
        must clamp; a large one holds the setpoint."""
        gen_props = {"name": "G1", "rated_mva": rated_mva, "power_factor": pf,
                     "voltage_setpoint_pu": vset, "dispatch_mode": "must_run",
                     "voltage_kv": 11.0}
        if q_max is not None:
            gen_props["q_max_mvar"] = q_max
        if q_min is not None:
            gen_props["q_min_mvar"] = q_min
        comps = [
            _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
                                           "fault_mva": 500.0, "x_r_ratio": 15.0}),
            _comp("bus-1", "bus", {"name": "Slack", "voltage_kv": 11.0}),
            _comp("cab-1", "cable", {"name": "Feeder", "voltage_kv": 11.0,
                                     "r_per_km": 0.2, "x_per_km": 0.3,
                                     "length_km": 5.0, "rated_amps": 400}),
            _comp("bus-2", "bus", {"name": "Gen Bus", "voltage_kv": 11.0,
                                   "bus_type": "PV"}),
            _comp("gen-1", "generator", gen_props),
            _comp("load-1", "static_load", {"name": "L1", "rated_kva": load_kva,
                                            "power_factor": load_pf,
                                            "voltage_kv": 11.0}),
        ]
        wires = [
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "cab-1"),
            _wire("w3", "cab-1", "bus-2"),
            _wire("w4", "bus-2", "gen-1"),
            _wire("w5", "bus-2", "load-1"),
        ]
        return ProjectData(projectName="pvgen", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def test_pv_generator_holds_setpoint_within_capability(self):
        """A large machine with ample reactive headroom holds its PV setpoint
        and raises no reactive-limit warning."""
        res = run_load_flow(self._pv_gen_project(rated_mva=50.0, pf=0.9,
                                                 load_kva=200, load_pf=0.95))
        assert res.converged
        assert abs(res.buses["bus-2"].voltage_pu - 1.05) <= 0.005
        assert not any("reactive limit" in w.message for w in res.warnings)

    def test_pv_generator_clamps_at_q_max(self):
        """A small machine cannot supply the local inductive load's Q: it pins
        at its over-excitation limit (Q_max ≈ rated·sinφ), the bus falls below
        the setpoint, and a reactive-limit warning is raised."""
        proj = self._pv_gen_project(rated_mva=1.0, pf=0.9,
                                    load_kva=5000, load_pf=0.5)
        res = run_load_flow(proj)
        assert res.converged
        # Q_max = 1 MVA × sin(acos(0.9)) ≈ 0.436 MVAr
        q_cap = 1.0 * math.sqrt(1 - 0.9 ** 2)
        # Clamped ⇒ the generator can no longer hold its 1.05 setpoint.
        assert abs(res.buses["bus-2"].voltage_pu) < 1.0
        warn = [w for w in res.warnings if "reactive limit" in w.message
                and w.elementId == "gen-1"]
        assert warn, "expected a reactive-limit warning for the clamped generator"
        assert "over-excitation" in warn[0].message
        assert f"{round(q_cap, 2)}" in warn[0].message

    def test_clamped_generator_delivers_exactly_q_max(self):
        """The solved network must carry the clamped machine at its limit — not
        the limit PLUS its scheduled pf-split dispatch Q (the double-count that
        delivered exactly 2×Q_max and optimistic post-clamp voltages). The
        warning's pinned value and the delivered badge Q must agree."""
        res = run_load_flow(self._pv_gen_project(rated_mva=1.0, pf=0.9,
                                                 load_kva=5000, load_pf=0.5))
        assert res.converged
        q_cap = 1.0 * math.sqrt(1 - 0.9 ** 2)   # ≈ 0.436 MVAr
        badge = next(b for b in res.branches if b.elementId == "gen-1")
        assert badge.q_mvar == pytest.approx(q_cap, abs=0.02), \
            "clamped generator must deliver Q_max, not Q_max + scheduled Q"

    def test_explicit_zero_q_limit_is_respected(self):
        """q_max_mvar = q_min_mvar = 0 is a valid 'no vars' (unity-pf) box, not
        a missing prop: the machine must clamp at 0 MVAr and deliver none."""
        res = run_load_flow(self._pv_gen_project(rated_mva=50.0, pf=0.9,
                                                 load_kva=3000, load_pf=0.7,
                                                 q_max=0.0, q_min=0.0))
        assert res.converged
        assert any("reactive limit" in w.message for w in res.warnings), \
            "a zero-Q box must clamp, not silently widen to the rated-pf default"
        badge = next(b for b in res.branches if b.elementId == "gen-1")
        assert badge.q_mvar == pytest.approx(0.0, abs=0.02)

    def test_explicit_q_limits_override_capability_default(self):
        """Explicit q_min_mvar tightens the box below the rated-pf default, so a
        machine that would otherwise hold voltage now clamps. Here the generator
        exports real power and must ABSORB reactive to hold the setpoint, so it
        hits the under-excitation (Q_min) limit and the bus drifts off setpoint
        (upward — the clamp can no longer pull the voltage down)."""
        loose = run_load_flow(self._pv_gen_project(rated_mva=50.0, pf=0.9,
                                                   load_kva=3000, load_pf=0.7))
        tight = run_load_flow(self._pv_gen_project(rated_mva=50.0, pf=0.9,
                                                   load_kva=3000, load_pf=0.7,
                                                   q_max=0.5, q_min=-0.5))
        assert not any("reactive limit" in w.message for w in loose.warnings)
        tight_warn = [w for w in tight.warnings if "reactive limit" in w.message]
        assert tight_warn and "under-excitation" in tight_warn[0].message
        # Loose case holds the setpoint; the clamped case drifts off it.
        assert abs(loose.buses["bus-2"].voltage_pu - 1.05) < 1e-2
        assert abs(tight.buses["bus-2"].voltage_pu - 1.05) > 1e-2

    def test_swing_generator_is_not_clamped(self):
        """A generator acting as its island's swing has no Q constraint: even a
        tiny machine islanded with a reactive load must not raise a PV-generator
        reactive-limit warning (the slack absorbs the residual)."""
        comps = [
            _comp("gen-1", "generator", {"name": "G1", "rated_mva": 0.5,
                                         "power_factor": 0.9, "voltage_kv": 11.0,
                                         "bus_type": "Swing"}),
            _comp("bus-1", "bus", {"name": "Island", "voltage_kv": 11.0,
                                   "bus_type": "Swing"}),
            _comp("load-1", "static_load", {"name": "L1", "rated_kva": 400,
                                            "power_factor": 0.6, "voltage_kv": 11.0}),
        ]
        wires = [_wire("w1", "gen-1", "bus-1"), _wire("w2", "bus-1", "load-1")]
        proj = ProjectData(projectName="isl", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)
        res = run_load_flow(proj)
        assert res.converged
        assert not any("reactive limit" in w.message for w in res.warnings)


class TestSolutionQuality:
    """Load-flow solution classification beyond raw convergence — the
    non-convergence / low-voltage-collapse-root gate (`_assess_solution`)."""

    @staticmethod
    def _bus(bid, vpu, energized=True):
        return LoadFlowBus(bus_id=bid, bus_name=bid, voltage_pu=vpu,
                           voltage_kv=vpu * 11, angle_deg=0.0, energized=energized)

    def test_healthy_solution_is_ok(self):
        """A normal converged network reports quality 'ok' and raises no
        collapse/divergence warning."""
        proj = _utility_bus_project(extra_components=[
            _comp("static_load-1", "static_load",
                  {"name": "L", "rated_kva": 500, "power_factor": 0.9, "voltage_kv": 11})],
            extra_wires=[_wire("wl", "bus-1", "static_load-1")])
        res = run_load_flow(proj)
        assert res.converged and res.solution_quality == "ok"
        assert not any("implausibly low" in w.message or "did not converge" in w.message
                       for w in res.warnings)

    def test_assess_flags_low_voltage_root(self):
        """A converged solution with an energized bus below the plausibility
        floor is classified 'low_voltage_root' and names the worst bus."""
        q, warns = _assess_solution(
            {"b1": self._bus("b1", 1.0), "b2": self._bus("b2", 0.42)}, True, 5)
        assert q == "low_voltage_root"
        assert warns and warns[0].elementId == "b2" and "0.420" in warns[0].message

    def test_assess_does_not_flag_weak_but_operable(self):
        """A legitimately weak-but-operable bus (above the floor) is NOT flagged
        — the gate must not false-positive on a valid low-voltage operating point."""
        q, warns = _assess_solution({"b1": self._bus("b1", 0.72)}, True, 6)
        assert q == "ok" and warns == []

    def test_assess_ignores_deenergized_bus(self):
        """A de-energized (0 V, sourceless-island) bus is expected and must not
        be mistaken for a collapse root."""
        q, _ = _assess_solution(
            {"b1": self._bus("b1", 1.0), "b2": self._bus("b2", 0.0, energized=False)}, True, 4)
        assert q == "ok"

    def test_assess_nonconvergence_message(self):
        """Non-convergence is classified 'non_converged' with an actionable
        infeasibility message, regardless of the returned voltages."""
        q, warns = _assess_solution({"b1": self._bus("b1", 0.3)}, False, 100)
        assert q == "non_converged"
        assert warns and "did not converge" in warns[0].message and "infeasible" in warns[0].message

    def test_overloaded_network_flagged_not_ok(self):
        """A network loaded past its loadability limit does not silently return
        a clean result: it is either non-converged or a flagged low-voltage root,
        with a solution-level warning at the top of the list."""
        comps = [
            _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
                                           "fault_mva": 200.0, "x_r_ratio": 10}),
            _comp("bus-1", "bus", {"name": "Src", "voltage_kv": 11.0}),
            _comp("cab-1", "cable", {"name": "Ln", "voltage_kv": 11.0, "r_per_km": 0.3,
                                     "x_per_km": 0.4, "length_km": 30.0, "rated_amps": 300}),
            _comp("bus-2", "bus", {"name": "End", "voltage_kv": 11.0}),
            _comp("load-1", "static_load", {"name": "L", "rated_kva": 10000,
                                            "power_factor": 0.85, "voltage_kv": 11}),
        ]
        wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "cab-1"),
                 _wire("w3", "cab-1", "bus-2"), _wire("w4", "bus-2", "load-1")]
        res = run_load_flow(ProjectData(projectName="ov", baseMVA=100.0, frequency=50,
                                        components=comps, wires=wires))
        assert res.solution_quality in ("non_converged", "low_voltage_root")
        assert res.solution_quality != "ok"
        # The solution-level warning is prepended (first in the list).
        assert res.warnings and (
            "did not converge" in res.warnings[0].message or
            "implausibly low" in res.warnings[0].message)

    # ── Singular / near-singular Jacobian trapping (original review item 3) ──

    def test_singular_jacobian_caught_and_reported(self):
        """A (near-)singular Jacobian — here a PQ bus with no admittance path but
        a nonzero power demand — is trapped by the condition-number guard and
        reported as reason 'singular_jacobian', never raised as an unhandled
        LinAlgError."""
        Y = np.array([[complex(1, -10), 0], [0, 0]], dtype=complex)
        V, conv, iters, reason = _newton_raphson(
            Y, np.array([0.0, 0.1]), np.array([0.0, 0.05]),
            np.array([1.0, 1.0]), [2, 0])  # swing, PQ
        assert conv is False and reason == "singular_jacobian"
        # The break iteration is reported, not a misleading MAX_ITERATIONS.
        assert iters <= 2

    def test_healthy_solve_reports_no_failure_reason(self):
        """A well-posed solve converges with an empty reason — the singular guard
        must not false-positive on a well-conditioned Jacobian."""
        Y = np.array([[complex(2, -20), complex(-2, 20)],
                      [complex(-2, 20), complex(2, -20)]], dtype=complex)
        V, conv, iters, reason = _newton_raphson(
            Y, np.array([0.0, -0.2]), np.array([0.0, -0.1]),
            np.array([1.0, 1.0]), [2, 0])
        assert conv is True and reason == ""

    def test_solvers_return_reason_tuple(self):
        """Both solvers and the island wrapper return the 4-tuple contract
        (V, converged, iterations, reason)."""
        Y = np.array([[complex(2, -20), complex(-2, 20)],
                      [complex(-2, 20), complex(2, -20)]], dtype=complex)
        args = (Y, np.array([0.0, -0.1]), np.array([0.0, -0.05]),
                np.array([1.0, 1.0]), [2, 0])
        assert len(_newton_raphson(*args)) == 4
        assert len(_gauss_seidel(*args)) == 4
        gs = _gauss_seidel(*args)
        assert gs[3] in ("", "max_iterations")
        # Island wrapper (no dead buses) propagates the same 4-tuple.
        assert len(solve_with_islands(*args, set(), "newton_raphson")) == 4

    def test_assess_singular_message_distinct(self):
        """The singular-Jacobian message is distinct from a plain iteration-limit
        divergence, so the two failure modes are distinguishable to the user."""
        b = {"b": self._bus("b", 0.0)}
        q_sing, w_sing = _assess_solution(b, False, 1, "singular_jacobian")
        q_iter, w_iter = _assess_solution(b, False, 100, "max_iterations")
        assert q_sing == "non_converged" and q_iter == "non_converged"
        assert "Jacobian is singular" in w_sing[0].message
        assert "Jacobian is singular" not in w_iter[0].message
        assert "did not converge" in w_iter[0].message


class TestInverterReactive:
    """Storage-inverter (battery / hybrid PV) reactive power: power-factor and
    voltage-regulating modes, bounded by the kVA capability circle."""

    def _hybrid(self, irr, pf, var_mode, discharge_kw=30, rated_kw=50,
                vset=1.0, eff=1.0):
        return ProjectData(projectName="t", baseMVA=100.0, frequency=50, components=[
            _comp("util-1", "utility", {"voltage_kv": 0.4, "fault_mva": 100, "x_r_ratio": 10}),
            _comp("bus-1", "bus", {"name": "Main", "voltage_kv": 0.4}),
            _comp("load-1", "static_load", {"rated_kva": 40, "power_factor": 0.85, "voltage_kv": 0.4}),
            _comp("pv-1", "solar_pv", {
                "name": "PV", "rated_kw": rated_kw, "num_inverters": 1, "inverter_eff": eff,
                "power_factor": pf, "irradiance_pct": irr, "voltage_kv": 0.4,
                "inverter_type": "hybrid", "battery_kwh": 100, "battery_dod_pct": 90,
                "battery_soc_pct": 95, "battery_max_charge_kw": 50,
                "battery_max_discharge_kw": discharge_kw, "battery_mode": "discharging",
                "var_mode": var_mode, "v_setpoint_pu": vset}),
        ], wires=[_wire("w1", "util-1", "bus-1"), _wire("w2", "load-1", "bus-1"),
                  _wire("w3", "pv-1", "bus-1")])

    def _pv_badge(self, res):
        return next((b for b in res.branches if b.elementId == "pv-1"), None)

    def test_unity_mode_no_vars_legacy(self):
        """Unity mode (legacy behaviour): the battery discharge injects zero
        reactive even with a non-unity power factor set."""
        res = run_load_flow(self._hybrid(0, 0.9, "unity"))
        b = self._pv_badge(res)
        assert res.converged and abs(b.q_mvar) < 1e-6

    def test_power_factor_mode_battery_supplies_vars(self):
        """Zero irradiance, battery-only: in power-factor mode the inverter now
        supplies reactive at its set pf (30 kW @ 0.9 → 30·tan(acos 0.9) ≈ 14.5
        kvar), bounded by the kVA circle — the fix for the reported issue."""
        res = run_load_flow(self._hybrid(0, 0.9, "power_factor", discharge_kw=30))
        b = self._pv_badge(res)
        assert res.converged
        expect = 0.030 * math.sqrt(1 - 0.9 ** 2) / 0.9   # ≈ 0.01453 MVAr
        assert b.q_mvar == pytest.approx(expect, abs=5e-4)
        assert b.pf == pytest.approx(0.9, abs=0.02)

    def test_power_factor_capped_by_kva_circle(self):
        """At full inverter loading (P = S_rated) there is no headroom for
        reactive — the circle √(S²−P²) is zero, so Q is 0 despite pf < 1."""
        # 50 kW discharge, 50 kW inverter @ eff 1.0 → S_rated = P = 0.05 MVA.
        res = run_load_flow(self._hybrid(0, 0.9, "power_factor",
                                         discharge_kw=50, rated_kw=50, eff=1.0))
        b = self._pv_badge(res)
        assert res.converged and abs(b.q_mvar) < 1e-6

    def _hybrid_behind_cable(self, var_mode, vset=1.05, discharge_kw=20,
                             irr=0, pf=0.98, load_kva=60, load_pf=0.85):
        """Inverter on a PCC bus behind a feeder (so the utility, not the
        inverter, is the swing) — the setup where voltage regulation is meaningful."""
        return ProjectData(projectName="t", baseMVA=100.0, frequency=50, components=[
            _comp("util-1", "utility", {"voltage_kv": 0.4, "fault_mva": 20, "x_r_ratio": 5}),
            _comp("bus-1", "bus", {"name": "Src", "voltage_kv": 0.4}),
            _comp("cab-1", "cable", {"voltage_kv": 0.4, "r_per_km": 0.5, "x_per_km": 0.3,
                                     "length_km": 0.5, "rated_amps": 200}),
            _comp("bus-2", "bus", {"name": "PCC", "voltage_kv": 0.4}),
            _comp("load-1", "static_load", {"rated_kva": load_kva, "power_factor": load_pf,
                                            "voltage_kv": 0.4}),
            _comp("pv-1", "solar_pv", {
                "name": "PV", "rated_kw": 50, "num_inverters": 1, "inverter_eff": 1.0,
                "power_factor": pf, "irradiance_pct": irr, "voltage_kv": 0.4,
                "inverter_type": "hybrid", "battery_kwh": 100, "battery_dod_pct": 90,
                "battery_soc_pct": 95, "battery_max_charge_kw": 50,
                "battery_max_discharge_kw": discharge_kw, "battery_mode": "discharging",
                "var_mode": var_mode, "v_setpoint_pu": vset}),
        ], wires=[_wire("w1", "util-1", "bus-1"), _wire("w2", "bus-1", "cab-1"),
                  _wire("w3", "cab-1", "bus-2"), _wire("w4", "load-1", "bus-2"),
                  _wire("w5", "pv-1", "bus-2")])

    def test_voltage_mode_regulates_and_reports_solved_q(self):
        """Voltage mode raises the bus toward its setpoint by injecting reactive,
        and the source badge reports the solver-computed Q (not the scheduled 0),
        bounded by the capability circle."""
        base = run_load_flow(self._hybrid_behind_cable("unity"))
        volt = run_load_flow(self._hybrid_behind_cable("voltage", vset=1.05))
        assert volt.converged
        # Voltage regulation lifts the PCC bus above the no-var case.
        assert volt.buses["bus-2"].voltage_pu > base.buses["bus-2"].voltage_pu + 1e-3
        b = self._pv_badge(volt)
        assert b.q_mvar > 0.001   # solved reactive is reported, not the scheduled 0
        s_rated = 0.05
        assert b.q_mvar <= math.sqrt(s_rated ** 2 - 0.02 ** 2) + 1e-3  # within the circle

    def test_clamped_voltage_mode_hybrid_stays_within_circle_and_warns(self):
        """Voltage-mode hybrid PV WITH sun (irradiance > 0, pf < 1) — the path
        where the PV part carries a scheduled pf-split Q. When the inverter hits
        its kVA circle the delivered Q must be the circle limit, not the limit
        PLUS the schedule (the double-count delivered exactly 2× capability with
        no warning). A reactive-capability warning must name the inverter."""
        proj = self._hybrid_behind_cable("voltage", vset=1.08, discharge_kw=0,
                                         irr=100, pf=0.9, load_kva=100, load_pf=0.7)
        res = run_load_flow(proj)
        assert res.converged
        # P = 50 kW × 0.9 = 45 kW; circle headroom √(50² − 45²) ≈ 21.8 kvar.
        p_disp = 0.05 * 0.9
        q_circle = math.sqrt(0.05 ** 2 - p_disp ** 2)
        b = self._pv_badge(res)
        assert b.q_mvar == pytest.approx(q_circle, abs=1.5e-3), \
            "clamped inverter must deliver the circle limit, not limit + scheduled Q"
        warn = [w for w in res.warnings if "reactive capability" in w.message
                and w.elementId == "pv-1"]
        assert warn, "expected a reactive-capability warning for the clamped inverter"
        # Pinned below the setpoint: the phantom voltage lift is gone.
        assert res.buses["bus-2"].voltage_pu < 1.08

    def test_pf_field_populated_on_source_badge(self):
        """The branch/source badge carries a calculated power factor (|P|/S)."""
        res = run_load_flow(self._hybrid(0, 0.9, "power_factor", discharge_kw=30))
        b = self._pv_badge(res)
        assert b.pf == pytest.approx(abs(b.p_mw) / b.s_mva, abs=1e-3)
        assert 0 < b.pf <= 1
