"""Regression pins for the 2026-07 calculation-verification P3 fixes.

Each test anchors a P3 finding from CALC_VERIFICATION_2026-07-19.md (tracked
in BACKLOG.md, "Calculation-verification P3 follow-ups") to a hand
calculation or a directly observable behaviour change. Finding IDs (PS-*
protection specialist, EE-* senior electrical engineer) refer to that
document. P1/P2 pins live in test_verification_fixes.py.
"""

import math

import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.fault import run_fault_analysis, _q_factor
from backend.analysis.arcflash import (_cb_self_clearing_time,
                                       _lv_small_transformer_exemption)
from backend.analysis.cable_sizing import _estimate_clearing_time
from backend.analysis.duty_check import run_duty_check
from backend.analysis.load_diversity import run_load_diversity
from backend.analysis.loadflow import run_load_flow
from backend.analysis.voltage_stability import run_voltage_stability


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires, base_mva=100.0):
    return ProjectData(projectName="p3-fix", baseMVA=base_mva, frequency=50,
                       components=components, wires=wires)


# ── PS-12: LLG earth current is 0 when no Z0 path exists ─────────────────────


class TestPS12LLGDegenerateEarthCurrent:
    def test_no_z0_path_reports_zero_earth_current(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0,
                                    "grounding": "ungrounded"}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "busA")])
        b = run_fault_analysis(proj).buses["busA"]
        assert b.ik1 == 0.0            # SLG blocked (pre-existing behaviour)
        assert b.ikLLG == 0.0          # earth-return current field: exactly 0
        assert b.ikLLG_angle is None
        assert b.ikLL and b.ikLL > 0   # the phase current is still reported


# ── PS-8(a): YNyn far-side neutral impedance in the Z0 through path ──────────


class TestPS8aFarSideNeutral:
    def _proj(self, hv_grounding, hv_r=0.0):
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 33.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 33.0}),
            _comp("tx", "transformer", {
                "name": "T1", "rated_mva": 20.0, "z_percent": 10.0,
                "x_r_ratio": 10.0, "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0,
                "vector_group": "YNyn0",
                "grounding_hv": hv_grounding, "grounding_hv_resistance": hv_r,
                "grounding_lv": "solidly_grounded"}),
            _comp("busL", "bus", {"name": "L", "voltage_kv": 11.0}),
        ], [
            _wire("w1", "u1", "busH"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busL", "secondary", "top"),
        ])

    def test_far_side_3zn_enters_through_path(self):
        """An LV fault through a YNyn with a resistance-earthed HV neutral
        must see 3·R_n(HV) in Z0 — previously only the bus-side (LV, solid)
        neutral was added and the far-side resistance vanished."""
        r_ohm = 5.0
        solid = run_fault_analysis(self._proj("solidly_grounded")).buses["busL"]
        resist = run_fault_analysis(
            self._proj("low_resistance", r_ohm)).buses["busL"]
        # 3·Zn(HV) in pu on the 33 kV / 100 MVA base, purely resistive
        dz = 3.0 * r_ohm / (33.0 ** 2 / 100.0)
        assert resist.z0_real - solid.z0_real == pytest.approx(dz, rel=1e-3)
        assert resist.z0_imag == pytest.approx(solid.z0_imag, abs=1e-6)
        assert resist.ik1 < solid.ik1  # the resistance limits the earth fault


# ── PS-8(b): pass-through forwards the entry port ────────────────────────────


class TestPS8bPassThroughPort:
    def test_dyn_met_on_delta_side_is_not_a_z0_source(self):
        """YNyn pass-through directly into a Dyn's DELTA winding: the delta
        blocks Z0, so with the (ungrounded) utility beyond it there is NO
        earth-fault source. Pre-fix the Dyn fell into the port-unknown
        fallback and was fabricated as a Z0 source from its delta side."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 33.0,
                                    "grounding": "ungrounded"}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 33.0}),
            _comp("txb", "transformer", {
                "name": "TB", "rated_mva": 20.0, "z_percent": 10.0,
                "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0,
                "vector_group": "YNyn0",
                "grounding_hv": "solidly_grounded",
                "grounding_lv": "solidly_grounded"}),
            _comp("txa", "transformer", {
                "name": "TA", "rated_mva": 1.0, "z_percent": 6.0,
                "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                "vector_group": "Dyn11",
                "grounding_lv": "solidly_grounded"}),
            _comp("busC", "bus", {"name": "C", "voltage_kv": 0.4}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "txb", "bottom", "primary"),
            _wire("w3", "txb", "txa", "secondary", "primary"),
            _wire("w4", "txa", "busC", "secondary", "top"),
        ])
        b = run_fault_analysis(proj).buses["busA"]
        assert b.ik3 and b.ik3 > 0      # positive-sequence path is intact
        assert b.ik1 == 0.0             # no phantom Z0 source via the delta


# ── PS-8(c): transformer Z0T/Z1T ratio prop ──────────────────────────────────


class TestPS8cTransformerZ0Ratio:
    def _proj(self, ratio=None):
        props = {"name": "T1", "rated_mva": 1.0, "z_percent": 6.0,
                 "x_r_ratio": 5.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                 "vector_group": "Dyn11", "grounding_lv": "solidly_grounded"}
        if ratio is not None:
            props["z0_z1_ratio"] = ratio
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 11.0}),
            _comp("tx", "transformer", props),
            _comp("busL", "bus", {"name": "L", "voltage_kv": 0.4}),
        ], [
            _wire("w1", "u1", "busH"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busL", "secondary", "top"),
        ])

    def test_z0_scales_by_ratio(self):
        """Dyn LV fault: Z0 = Z0T alone (delta blocks upstream), so the
        reported |Z0| must scale by exactly the z0_z1_ratio prop."""
        legacy = run_fault_analysis(self._proj()).buses["busL"]
        scaled = run_fault_analysis(self._proj(0.85)).buses["busL"]
        assert scaled.z0_mag == pytest.approx(0.85 * legacy.z0_mag, rel=1e-6)
        assert scaled.ik1 > legacy.ik1  # lower Z0 → more earth-fault current

    def test_absent_prop_is_legacy_identical(self):
        a = run_fault_analysis(self._proj()).buses["busL"]
        b = run_fault_analysis(self._proj(0)).buses["busL"]
        assert a.ik1 == b.ik1 and a.z0_mag == b.z0_mag


# ── PS-7: motor q-factor argument (MW per pole pair) ─────────────────────────


class TestPS7MotorQFactor:
    def test_q_factor_true_m(self):
        # IEC 60909-0 Eq. (71), t_min = 0.10 s: q = 0.57 + 0.12·ln(m)
        assert _q_factor(1.0, 0.10, proxy=False) == pytest.approx(0.57)
        m = 0.1
        assert _q_factor(m, 0.10, proxy=False) == pytest.approx(
            max(0.0, 0.57 + 0.12 * math.log(m)))

    def test_q_factor_proxy_keeps_legacy_guard(self):
        assert _q_factor(0.5, 0.10) == 1.0          # proxy < 1 → no decay
        assert _q_factor(6.0, 0.10) == pytest.approx(0.57 + 0.12 * math.log(6.0))

    def _proj(self, extra_motor_props):
        props = {"name": "M1", "rated_kw": 2000.0, "efficiency": 0.95,
                 "power_factor": 0.88, "voltage_kv": 11.0, "x_pp": 0.167,
                 "x_r_ratio": 10.0}
        props.update(extra_motor_props)
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("m1", "motor_induction", props),
        ], [_wire("w1", "u1", "busA"), _wire("w2", "busA", "m1")])

    def test_pole_data_reduces_motor_ib(self):
        """A 2 MW 4-pole motor: m = 1.0 MW/pole-pair → q = 0.57 at 0.1 s,
        well below the current-ratio proxy's q — Ib must drop while Ik″
        stays identical (the sub-transient contribution is unchanged)."""
        proxy = run_fault_analysis(self._proj({})).buses["busA"]
        poled = run_fault_analysis(self._proj({"poles": 4})).buses["busA"]
        assert poled.ik3 == proxy.ik3
        assert poled.ib < proxy.ib


# ── PS-10 / PS-11: study conventions disclosed on the result ─────────────────


class TestPS1011StudyAssumptions:
    def test_assumptions_present(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "busA")])
        res = run_fault_analysis(proj)
        assert res.study_assumptions
        joined = " ".join(res.study_assumptions)
        assert "c = 1.10" in joined
        assert "t_min = 0.1" in joined
        assert "n = 1" in joined
        assert "arithmetically" in joined

    def test_min_current_mode_noted(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "busA")])
        res = run_fault_analysis(proj, voltage_factor=0.95,
                                 conductor_temperature_c=70.0)
        joined = " ".join(res.study_assumptions)
        assert "c = 0.95" in joined
        assert "70" in joined


# ── PS-9: backend CB thermal region mirrors the frontend TCC model ───────────


class TestPS9CBThermalRegion:
    PROPS = {"trip_rating_a": 100.0, "thermal_pickup": 1.0,
             "magnetic_pickup": 10.0, "long_time_delay": 10, "cb_type": "mccb"}

    def test_thermal_region_is_inverse_time(self):
        # M = 3 → t = k/(M²−1) = 350/8 = 43.75 s (frontend CB_TRIP_CLASSES)
        assert _cb_self_clearing_time(self.PROPS, 300.0) == pytest.approx(350.0 / 8.0)

    def test_below_pickup_never_trips_thermally(self):
        assert _cb_self_clearing_time(self.PROPS, 50.0) == 10000.0

    def test_magnetic_region_unchanged(self):
        assert _cb_self_clearing_time(self.PROPS, 1500.0) == 0.05

    def test_class_5_band(self):
        props = dict(self.PROPS, long_time_delay=5)
        # k = 5 × 35 = 175 → t(6×Ir) = 5 s, the class definition
        assert _cb_self_clearing_time(props, 600.0) == pytest.approx(5.0)


# ── PS-13(b): IEEE 1584-2002 §9.3.2 small-transformer exemption note ─────────


class TestPS13bExemptionNote:
    def _parts(self, tx_mva, v_kv=0.23):
        comps = [
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 11.0}),
            _comp("tx", "transformer", {"name": "T1", "rated_mva": tx_mva,
                                        "z_percent": 4.0,
                                        "voltage_hv_kv": 11.0,
                                        "voltage_lv_kv": v_kv}),
            _comp("busL", "bus", {"name": "L", "voltage_kv": v_kv}),
        ]
        wires = [
            _wire("w1", "u1", "busH"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busL", "secondary", "top"),
        ]
        proj = _project(comps, wires)
        components = {c.id: c for c in proj.components}
        adjacency = {}
        for w in proj.wires:
            adjacency.setdefault(w.fromComponent, []).append(
                (w.toComponent, w.fromPort, w.toPort))
            adjacency.setdefault(w.toComponent, []).append(
                (w.fromComponent, w.toPort, w.fromPort))
        return components["busL"], components, adjacency

    def test_small_transformer_below_240v_exempt(self):
        bus, comps, adj = self._parts(tx_mva=0.1)  # 100 kVA < 125 kVA
        assert _lv_small_transformer_exemption(bus, comps, adj, 0.23) is True

    def test_large_transformer_not_exempt(self):
        bus, comps, adj = self._parts(tx_mva=0.2)
        assert _lv_small_transformer_exemption(bus, comps, adj, 0.23) is False

    def test_240v_and_above_not_exempt(self):
        bus, comps, adj = self._parts(tx_mva=0.1, v_kv=0.4)
        assert _lv_small_transformer_exemption(bus, comps, adj, 0.4) is False


# ── PS-14: duty-check asymmetrical breaking + 1.41 making rung ───────────────


class TestPS14DutyCheck:
    def _proj(self, icu_ka, x_r=40.0):
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 20.0,
                                    "x_r_ratio": x_r, "voltage_kv": 0.4}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 0.4}),
            _comp("cb1", "cb", {"name": "CB1", "breaking_capacity_ka": icu_ka,
                                "rated_current_a": 630.0,
                                "rated_voltage_kv": 0.69}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 100.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "cb1"),
            _wire("w3", "cb1", "ld"),
        ])

    def test_ps14a_asym_duty_checked(self):
        """High-X/R network (τ ≈ 127 ms): Ib_asym ≈ 1.19·Ib exceeds the
        standard-DC-component capability 1.012·Icu even though the
        symmetrical breaking duty passes — previously never checked."""
        proj = self._proj(icu_ka=30.0, x_r=40.0)
        fr = run_fault_analysis(proj).buses["busA"]
        # Ik = c·S_f/(c·base)·I_base = 20/(√3·0.4) = 28.87 kA = Ib (μ = 1);
        # τ = 40/ω ≈ 127 ms → Ib_asym ≈ 34.3 kA > 30·1.012 = 30.35 kA.
        assert fr.ib_asymmetric > 30.4
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        assert row["interrupt_ok"] is True          # Ib = 28.9 ≤ 30 kA
        assert row["asym_duty_ka"] == pytest.approx(fr.ib_asymmetric, abs=0.01)
        beta = math.exp(-0.1 / 0.045)
        assert row["asym_capability_ka"] == pytest.approx(
            30.0 * math.sqrt(1 + 2 * beta * beta), abs=0.01)
        assert row["asym_ok"] is False
        assert row["status"] == "fail"
        assert any("62271-100" in i for i in row["issues"])

    def test_ps14a_low_xr_passes(self):
        proj = self._proj(icu_ka=30.0, x_r=5.0)  # τ ≈ 16 ms — DC long gone
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        assert row["asym_ok"] is True

    def test_ps14b_making_ratio_141(self):
        proj = self._proj(icu_ka=4.0)
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        assert row["making_capacity_ka"] == pytest.approx(1.41 * 4.0, abs=0.01)


# ── EE-8: power factor > 1 is clamped, not a crash ───────────────────────────


class TestEE8PowerFactorClamp:
    def test_pf_above_one_warns_instead_of_500(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "Bad", "rated_kva": 1000.0,
                                        "power_factor": 1.2}),
        ], [_wire("w1", "u1", "busA"), _wire("w2", "busA", "ld")])
        res = run_load_flow(proj)  # previously: ValueError → HTTP 500
        assert res.converged
        assert any("power factor" in w.message.lower() for w in res.warnings)


# ── EE-9: capacitor banks are constant susceptance (Q ∝ V²) ──────────────────


class TestEE9CapacitorSusceptance:
    def test_delivered_q_tracks_v_squared(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.3,
                                  "x_per_km": 1.0, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 8000.0,
                                        "power_factor": 0.85}),
            _comp("cap", "capacitor_bank", {"name": "CAP",
                                            "rated_kvar": 4000.0}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busB", "ld"), _wire("w5", "busB", "cap"),
        ])
        res = run_load_flow(proj)
        assert res.converged
        b = res.buses["busB"]
        v = b.voltage_pu
        assert v < 0.995  # the case genuinely depresses the bus
        q_load = 8.0 * math.sqrt(1 - 0.85 ** 2)
        # Net injection at busB = Q_cap·V² − Q_load (P analogous). The old
        # constant-Q model would report 4.0 − Q_load here.
        assert b.q_mvar == pytest.approx(4.0 * v * v - q_load, abs=0.05)
        assert 4.0 * v * v < 3.99  # V²-scaling engaged


# ── EE-10: tapped transformer sharing a chain with a cable warns ─────────────


class TestEE10TappedChainWarning:
    def _proj(self, tap):
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 33.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 33.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2,
                                  "x_per_km": 0.1, "length_km": 1.0,
                                  "voltage_kv": 33.0}),
            _comp("tx", "transformer", {"name": "T1", "rated_mva": 20.0,
                                        "z_percent": 10.0,
                                        "voltage_hv_kv": 33.0,
                                        "voltage_lv_kv": 11.0,
                                        "tap_percent": tap}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 5000.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"),
            _wire("w3", "c1", "tx", "bottom", "primary"),
            _wire("w4", "tx", "busB", "secondary", "top"),
            _wire("w5", "busB", "ld"),
        ])

    def test_tapped_chain_with_cable_warns(self):
        res = run_load_flow(self._proj(tap=5.0))
        assert any("tap" in w.message.lower() and "cable" in w.message.lower()
                   for w in res.warnings)

    def test_nominal_tap_stays_silent(self):
        res = run_load_flow(self._proj(tap=0.0))
        assert not any("referred through the tap" in w.message
                       for w in res.warnings)


# ── EE-11: Gauss-Seidel converged verdict includes a power-mismatch check ────


class TestEE11GaussSeidelMismatch:
    def test_gs_matches_nr_and_still_converges(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.5,
                                  "x_per_km": 0.4, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 5000.0,
                                        "power_factor": 0.8}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busB", "ld"),
        ])
        nr = run_load_flow(proj, "newton_raphson")
        gs = run_load_flow(proj, "gauss_seidel")
        assert gs.converged
        assert gs.buses["busB"].voltage_pu == pytest.approx(
            nr.buses["busB"].voltage_pu, abs=1e-4)


# ── EE-7: Q-V reactive margin is offset-free ─────────────────────────────────


class TestEE7QVMargin:
    def test_margin_is_oppoint_to_bottom(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.1,
                                  "x_per_km": 1.2, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 10000.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busB", "ld"),
        ])
        res = run_voltage_stability(proj, qv_bus_id="busB")
        assert res.qv_min_mvar is not None
        assert res.qv_operating_mvar is not None
        assert res.qv_margin_mvar == pytest.approx(
            res.qv_operating_mvar - res.qv_min_mvar, abs=1e-3)
        assert res.qv_margin_mvar > 0  # stable operating point


# ── EE-13: load-diversity transformer walk crosses feeder cables ─────────────


class TestEE13TransformerDownstreamTree:
    def test_sub_bus_behind_cable_counts(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 11.0}),
            _comp("tx", "transformer", {"name": "T1", "rated_mva": 0.5,
                                        "z_percent": 5.0,
                                        "voltage_hv_kv": 11.0,
                                        "voltage_lv_kv": 0.4}),
            _comp("busM", "bus", {"name": "Main", "voltage_kv": 0.4}),
            _comp("c1", "cable", {"name": "F1", "r_per_km": 0.2,
                                  "x_per_km": 0.08, "length_km": 0.05,
                                  "voltage_kv": 0.4}),
            _comp("busS", "bus", {"name": "Sub", "voltage_kv": 0.4}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 300.0,
                                        "power_factor": 0.9,
                                        "demand_factor": 1.0}),
        ], [
            _wire("w1", "u1", "busH"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busM", "secondary", "top"),
            _wire("w4", "busM", "c1"), _wire("w5", "c1", "busS"),
            _wire("w6", "busS", "ld"),
        ])
        res = run_load_diversity(proj)
        row = next(t for t in res["transformers"]
                   if t["transformer_id"] == "tx")
        # Previously 0 — the sub bus behind the feeder cable was invisible.
        assert row["demand_kva"] == pytest.approx(300.0, rel=1e-6)
        assert row["demand_loading_pct"] == pytest.approx(60.0, rel=1e-6)

    def test_hv_side_loads_not_counted(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 11.0}),
            _comp("hvld", "static_load", {"name": "HVL", "rated_kva": 900.0,
                                          "power_factor": 0.9}),
            _comp("tx", "transformer", {"name": "T1", "rated_mva": 0.5,
                                        "z_percent": 5.0,
                                        "voltage_hv_kv": 11.0,
                                        "voltage_lv_kv": 0.4}),
            _comp("busM", "bus", {"name": "Main", "voltage_kv": 0.4}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 100.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busH"),
            _wire("w1b", "busH", "hvld"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busM", "secondary", "top"),
            _wire("w4", "busM", "ld"),
        ])
        res = run_load_diversity(proj)
        row = next(t for t in res["transformers"]
                   if t["transformer_id"] == "tx")
        assert row["demand_kva"] == pytest.approx(100.0, rel=1e-6)


# ── EE-14: fuse clearing time from the gG curve in cable sizing ──────────────


class TestEE14FuseClearing:
    def _fuse(self, rating):
        return _comp("f1", "fuse", {"name": "F1", "rated_current_a": rating})

    def test_near_threshold_is_slow(self):
        # 400 A gG at 1000 A (2.5×In): pre-arc 30 s → capped at the 5 s
        # adiabatic-validity limit. The old model said 10 ms here.
        assert _estimate_clearing_time(self._fuse(400.0), 1000.0) == 5.0

    def test_bolted_fault_is_fast(self):
        # 400 A gG at 10 kA: pre-arc 4 ms × 1.2 = 4.8 ms
        t = _estimate_clearing_time(self._fuse(400.0), 10000.0)
        assert t == pytest.approx(0.0048, rel=1e-6)

    def test_below_minimum_melting_uses_cap(self):
        assert _estimate_clearing_time(self._fuse(400.0), 500.0) == 5.0

    def test_no_current_keeps_legacy_convention(self):
        assert _estimate_clearing_time(self._fuse(400.0), None) == 0.01
