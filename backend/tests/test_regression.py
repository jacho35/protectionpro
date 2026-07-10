"""Standards-anchored regression tests for the analysis engines.

Each test pins an engine result to a hand calculation from the governing
standard (IEC 60909, IEEE 1584-2002, IEEE 80) so that calculation
regressions are caught mechanically. These were introduced after the
2026-06 audit (see AUDIT_REPORT.md) — every Critical finding there was
detectable by one of these tests.

Run with:  python -m pytest backend/tests/ -v
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.analysis.motor_starting import run_motor_starting
from backend.analysis.grounding_system import _compute_conductor_size
from backend.analysis.arcflash import calc_incident_energy
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow


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
