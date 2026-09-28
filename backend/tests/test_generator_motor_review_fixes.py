"""Generator & motor engine review — regression tests for findings MG1–MG10.

Each test reproduces the ORIGINAL defect against an independent reference (a
physical invariant, a closed form or a hand calculation), not the engine's own
earlier output. Finding IDs match the ``[MGn]`` markers in the code.
"""

import math

import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis import fault
from backend.analysis.loadflow import run_load_flow
from backend.analysis.motor_starting import run_motor_starting
from backend.analysis.dynamic_motor_starting import (
    run_dynamic_motor_starting, _winding_current_xflc, AUTO_TX_TAP,
)
from backend.analysis.transient_stability import run_transient_stability


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _motor_props(**kw):
    p = {"name": "M1", "rated_kw": 200.0, "voltage_kv": 0.4, "efficiency": 0.93,
         "power_factor": 0.85, "locked_rotor_current": 6.0,
         "locked_rotor_torque_pct": 150.0, "rated_speed_rpm": 1480.0,
         "starting_method": "dol", "motor_j_kgm2": 2.5, "load_j_kgm2": 2.5,
         "load_torque_model": "quadratic", "load_torque_pct": 90.0,
         "load_breakaway_pct": 10.0}
    p.update(kw)
    return p


def _mv_lv(motor_props=None, fault_mva=500.0, tx_mva=10.0):
    """Utility → 11 kV bus → transformer (10 %) → 0.4 kV bus → motor."""
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50, components=[
        _c("u", "utility", {"name": "Grid", "voltage_kv": 11.0, "fault_mva": fault_mva,
                            "x_r_ratio": 15.0}),
        _c("b1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
        _c("t1", "transformer", {"name": "TX1", "rated_mva": tx_mva, "z_percent": 10.0,
                                 "x_r_ratio": 10.0, "voltage_hv_kv": 11.0,
                                 "voltage_lv_kv": 0.4, "vector_group": "Dyn11"}),
        _c("b2", "bus", {"name": "LV Bus", "voltage_kv": 0.4}),
        _c("m1", "motor_induction", motor_props or _motor_props()),
    ], wires=[_w("w1", "u", "b1"), _w("w2", "b1", "t1"), _w("w3", "t1", "b2"),
              _w("w4", "b2", "m1")])


def _one(project):
    res = run_dynamic_motor_starting(project)
    assert res["motors"], res["warnings"]
    return res["motors"][0]


# ── MG1 ────────────────────────────────────────────────────────────────

class TestMG1TransientMotorEquilibrium:
    """A zero-size disturbance must leave every state flat (null-disturbance
    invariant). The dynamic induction motor started off the load-flow point —
    wrong P/Q and demand_factor ignored — so a genset island with the governor
    off ran away (+3.4 Hz, or −9.5 Hz at df 0.5) and was declared unstable."""

    def _island(self, df, motor_kv=0.4, ts_dyn="on"):
        return ProjectData(projectName="n", baseMVA=100.0, frequency=50, components=[
            _c("busg", "bus", {"name": "G", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "L", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.1,
                                "x_per_km": 0.07, "length_km": 0.05}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 1.0, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 2.0,
                                   "dispatch_mode": "must_run", "gov_mode": "none",
                                   "avr_mode": "off"}),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 0.4, "rated_kva": 200,
                                     "power_factor": 0.9}),
            _c("m1", "motor_induction", {"name": "M1", "rated_kw": 400,
                                         "voltage_kv": motor_kv, "efficiency": 0.93,
                                         "power_factor": 0.85, "demand_factor": df,
                                         "rated_speed_rpm": 1480, "ts_dynamic": ts_dyn,
                                         "motor_j_kgm2": 10, "load_j_kgm2": 10}),
        ], wires=[_w("a", "busg", "fdr"), _w("b", "fdr", "busl"), _w("c", "g1", "busg"),
                  _w("d", "busl", "ld"), _w("e", "busl", "m1")])

    def _drift(self, project):
        r = run_transient_stability(project, {"type": "load_step", "element": "ld",
                                              "delta_pct": 0, "time_s": 1, "t_end_s": 5})
        f = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"][0]
        return max(abs(v) for v in f[gi]), r["stable"]

    @pytest.mark.parametrize("df", [1.0, 0.5])
    def test_null_disturbance_is_flat(self, df):
        drift, stable = self._drift(self._island(df))
        assert stable is True
        assert drift < 2e-3          # was 3.4 Hz (df 1) / 9.5 Hz (df 0.5)

    def test_null_disturbance_flat_off_nominal_motor_voltage(self):
        # [MG9] composition: a 415 V motor on the 400 V bus must also start
        # in equilibrium once its model is re-referred to the bus base.
        drift, _ = self._drift(self._island(1.0, motor_kv=0.415))
        assert drift < 2e-3

    def test_switched_off_motor_is_not_modelled(self):
        # df = 0 read as 1.0 through ``x or 1.0``; the motor is off in the LF.
        drift, _ = self._drift(self._island(0.0))
        assert drift < 2e-3


# ── MG2 ────────────────────────────────────────────────────────────────

class TestMG2WindingCurrentHeating:
    """Rotor I²t must use the WINDING current. In star the windings see V/√3:
    winding current = I_DOL/√3 while line current = I_DOL/3, so winding =
    √3·line. At autotransformer tap a: motor a·I, line a²·I ⇒ winding =
    line/a."""

    def test_star_winding_current(self):
        u = {"method": "star_delta", "in_reduced": True}
        assert _winding_current_xflc(u, 2.0) == pytest.approx(2.0 * math.sqrt(3))

    def test_autotransformer_winding_current(self):
        u = {"method": "autotransformer", "in_reduced": True}
        assert _winding_current_xflc(u, 2.0) == pytest.approx(2.0 / AUTO_TX_TAP)

    def test_after_changeover_and_soft_start_unchanged(self):
        for m in ("star_delta", "autotransformer"):
            assert _winding_current_xflc({"method": m, "in_reduced": False}, 3.0) == 3.0
        assert _winding_current_xflc({"method": "soft_starter", "in_reduced": False}, 3.0) == 3.0

    def test_star_delta_thermal_matches_winding_basis(self):
        r = _one(_mv_lv(_motor_props(starting_method="star_delta", load_torque_pct=30)))
        c, tr = r["curves"], r["transition"]["t_s"]
        heat = sum((3.0 if c["t"][k - 1] < tr else 1.0) * c["current_xflc"][k - 1] ** 2
                   * (c["t"][k] - c["t"][k - 1]) for k in range(1, len(c["t"])))
        expected = heat / (6.0 ** 2 * r["stall_time_hot_s"]) * 100.0
        # was 0.7 % against 2.0 % on the winding basis (3× optimistic)
        assert r["thermal_used_pct"] == pytest.approx(expected, rel=0.1)


# ── MG3 ────────────────────────────────────────────────────────────────

class TestMG3CrawlIsNotAStart:
    """A motor that settles where load torque meets motor torque on the RISING
    part of the curve (below breakdown speed) cannot run up. It was reported
    'started' at 52.8 % speed with a 14 s acceleration time."""

    def test_crawl_reported_as_stall(self):
        r = _one(_mv_lv(_motor_props(load_torque_pct=120, load_torque_model="linear"),
                        tx_mva=0.2))
        assert r["final_speed_pct"] < 90
        assert r["sim_status"] == "stalled"
        assert r["status"] == "fail"
        assert r["accel_time_s"] is None
        assert "breakdown" in r["issues"][0]

    def test_normal_start_still_starts(self):
        r = _one(_mv_lv())
        assert r["sim_status"] == "started" and r["final_speed_pct"] > 95


# ── MG4 ────────────────────────────────────────────────────────────────

class TestMG4GeneratorZeroSequenceDefault:
    """With no x0 the generator used Z0 = Z1, so Ik1 = Ik3 exactly at a solidly
    earthed genset. Sequence interconnection: Ik1/Ik3 = 3·Z1/(Z1+Z2+Z0) =
    3/(2 + k) with Z2 = Z1 and Z0 = k·Z1 (same angle) → 1.2 at k = 0.5."""

    def _gen(self, x0=None):
        g = {"name": "G", "rated_mva": 0.5, "voltage_kv": 0.4, "xd_pp": 0.15,
             "x_r_ratio": 40, "power_factor": 0.8}
        if x0:
            g["x0"] = x0
        return ProjectData(projectName="g", baseMVA=100.0, frequency=50,
                           components=[_c("g", "generator", g),
                                       _c("b", "bus", {"name": "B", "voltage_kv": 0.4})],
                           wires=[_w("w", "g", "b")])

    def test_default_ratio(self):
        r = fault.run_fault_analysis(self._gen())
        b = r.buses["b"]
        k = fault.GEN_Z0_Z1_DEFAULT
        assert b.ik1 / b.ik3 == pytest.approx(3.0 / (2.0 + k), rel=1e-3)   # kA reported rounded
        assert b.ik1 > b.ik3 * 1.15      # was exactly equal

    def test_default_is_disclosed(self):
        r = fault.run_fault_analysis(self._gen())
        assert any("zero-sequence reactance X0" in a for a in r.study_assumptions)

    def test_explicit_x0_unchanged_and_not_disclosed(self):
        r = fault.run_fault_analysis(self._gen(x0=0.05))
        assert not any("zero-sequence reactance X0" in a for a in r.study_assumptions)


# ── MG5 ────────────────────────────────────────────────────────────────

class TestMG5SynchronousMotorLeadingPf:
    """A leading (over-excited) synchronous motor SUPPLIES vars: 500 kVA at
    0.9 → Q = 0.5·√(1−0.81) = 0.2179 MVAr exported, so the swing source on the
    same bus must absorb it. The engine always treated it as lagging."""

    def _proj(self, mode):
        props = {"name": "SM", "rated_kva": 500, "voltage_kv": 3.3, "power_factor": 0.9}
        if mode:
            props["pf_mode"] = mode
        return ProjectData(projectName="s", baseMVA=100.0, frequency=50, components=[
            _c("u", "utility", {"name": "Grid", "voltage_kv": 3.3, "fault_mva": 100}),
            _c("b", "bus", {"name": "B", "voltage_kv": 3.3}),
            _c("sm", "motor_synchronous", props),
        ], wires=[_w("w1", "u", "b"), _w("w2", "b", "sm")])

    def _swing_q(self, mode):
        lf = run_load_flow(self._proj(mode), "newton_raphson")
        q_grid = next(d.dispatched_mvar for d in lf.dispatch if d.source_id == "u")
        return q_grid, lf

    def test_leading_exports_vars(self):
        q, _ = self._swing_q("leading")
        assert q == pytest.approx(-0.5 * math.sqrt(1 - 0.81), rel=1e-3)

    def test_lagging_absorbs_vars(self):
        q, _ = self._swing_q("lagging")
        assert q == pytest.approx(0.5 * math.sqrt(1 - 0.81), rel=1e-3)

    def test_legacy_without_mode_stays_lagging_and_warns(self):
        q, lf = self._swing_q(None)
        assert q == pytest.approx(0.5 * math.sqrt(1 - 0.81), rel=1e-3)
        assert any("leading/lagging" in w.message for w in lf.warnings)


# ── MG6 ────────────────────────────────────────────────────────────────

class TestMG6RunningMotorCountedOnce:
    """With only an already-running motor and nothing starting, the network is
    undisturbed: the bus must show no dip. The running motor sat in the
    baseline load flow AND on the Thevenin network — a 1.48 % phantom dip."""

    def test_no_dip_with_nothing_starting(self):
        r = _one(_mv_lv(_motor_props(dyn_role="running"), fault_mva=50.0, tx_mva=1.0))
        assert abs(r["max_bus_dip_pct"]) < 0.05
        assert r["min_v_bus_pu"] == pytest.approx(r["v_prestart_pu"], abs=5e-4)

    def test_running_motor_still_loads_the_bus(self):
        # …and its current is still counted once: the pre-start voltage with it
        # running sits below the all-off baseline (≈ the LF with it running).
        p = _mv_lv(_motor_props(dyn_role="running"), fault_mva=50.0, tx_mva=1.0)
        lf = run_load_flow(p, "newton_raphson")
        r = _one(p)
        assert r["v_prestart_pu"] == pytest.approx(lf.buses["b2"].voltage_pu, abs=3e-3)


# ── MG7 ────────────────────────────────────────────────────────────────

class TestMG7DipOnlyWhereConnected:
    """A plant on a separate grid cannot see the start. The source-side dip was
    subtracted from every bus (3.13 % on the unconnected plant)."""

    def test_separate_island_has_no_dip(self):
        p = _mv_lv(_motor_props(rated_kw=150), fault_mva=50.0, tx_mva=1.0)
        p.components += [
            _c("u2", "utility", {"name": "Grid2", "voltage_kv": 11.0, "fault_mva": 500}),
            _c("b9", "bus", {"name": "Other plant", "voltage_kv": 11.0}),
            _c("l9", "static_load", {"name": "L9", "rated_kva": 500, "power_factor": 0.9})]
        p.wires += [_w("x1", "u2", "b9"), _w("x2", "b9", "l9")]
        r = run_motor_starting(p)["motors"][0]
        assert r["bus_dips"]["Other plant"] == pytest.approx(0.0, abs=0.01)
        assert r["bus_dips"]["MV Bus"] > 1.0     # connected buses keep it


# ── MG8 ────────────────────────────────────────────────────────────────

class TestMG8SoftStarterCurrentLimit:
    """A soft starter holds its set current limit; the static study used a
    fixed 0.5 × LRC whatever the setting."""

    @pytest.mark.parametrize("lim", [2.0, 3.5, 5.0])
    def test_start_current_is_the_limit(self, lim):
        mp = _motor_props(starting_method="soft_starter", ss_current_limit_xflc=lim)
        r = run_motor_starting(_mv_lv(mp))["motors"][0]
        flc = 200 / (math.sqrt(3) * 0.4 * 0.93 * 0.85)
        assert r["start_current_a"] == pytest.approx(lim * flc, abs=0.06)

    def test_limit_capped_at_lrc(self):
        mp = _motor_props(starting_method="soft_starter", ss_current_limit_xflc=9.0)
        r = run_motor_starting(_mv_lv(mp))["motors"][0]
        flc = 200 / (math.sqrt(3) * 0.4 * 0.93 * 0.85)
        assert r["start_current_a"] == pytest.approx(6.0 * flc, abs=0.06)


# ── MG9 ────────────────────────────────────────────────────────────────

class TestMG9MotorVoltageBase:
    """A 415 V motor on a 400 V bus sees 0.964 p.u. of ITS rating: torque ∝ V²
    falls by (400/415)² and current by 400/415. The bus p.u. was used as the
    motor's own, so both were unchanged."""

    @pytest.mark.parametrize("kv", [0.415, 0.38])
    def test_torque_and_current_scale(self, kv):
        ref = _one(_mv_lv(_motor_props()))
        r = _one(_mv_lv(_motor_props(voltage_kv=kv)))
        ratio = 0.4 / kv
        assert r["curves"]["te_pu"][0] == pytest.approx(
            ref["curves"]["te_pu"][0] * ratio ** 2, rel=0.01)
        assert r["peak_current_xflc"] == pytest.approx(
            ref["peak_current_xflc"] * ratio, rel=0.01)

    def test_static_start_kva_at_bus_voltage(self):
        ref = run_motor_starting(_mv_lv(_motor_props()))["motors"][0]
        r = run_motor_starting(_mv_lv(_motor_props(voltage_kv=0.415)))["motors"][0]
        flc_ref = 200 / (math.sqrt(3) * 0.4 * 0.93 * 0.85)
        flc = 200 / (math.sqrt(3) * 0.415 * 0.93 * 0.85)
        # locked-rotor current at 1.0 p.u. on the bus = 6·FLC·(400/415)
        assert r["start_current_a"] == pytest.approx(6 * flc * 0.4 / 0.415, abs=0.06)
        assert ref["start_current_a"] == pytest.approx(6 * flc_ref, abs=0.06)


# ── MG10 ───────────────────────────────────────────────────────────────

class TestMG10SupplyVoltageCriterion:
    """The < 0.80 p.u. check is on the supply at the motor terminals. It used
    the winding voltage, which reduced-voltage starters lower on purpose, so
    every star-delta / autotransformer start was flagged."""

    @pytest.mark.parametrize("method", ["star_delta", "autotransformer"])
    def test_healthy_reduced_voltage_start_passes(self, method):
        r = _one(_mv_lv(_motor_props(starting_method=method, load_torque_pct=30)))
        assert r["min_v_motor_pu"] < 0.8          # windings reduced on purpose
        assert r["min_v_supply_pu"] > 0.95
        assert r["status"] == "pass" and not r["issues"]

    def test_weak_supply_still_flagged(self):
        r = _one(_mv_lv(_motor_props(), fault_mva=20.0, tx_mva=0.4))
        assert r["min_v_supply_pu"] < 0.8
        assert any("Supply voltage" in i for i in r["issues"])


# ══ Lesser notes N1–N8 ═══════════════════════════════════════════════════


def _hand_divider(z_th, s_mva, pf, v_pre=1.0, base=100.0):
    """Textbook constant-impedance locked rotor: V = V_pre / (1 + Z·Y),
    Y = conj(S_start) at 1.0 p.u."""
    y = (s_mva / base * complex(pf, math.sqrt(1 - pf * pf))).conjugate()
    return abs(v_pre / (1 + z_th * y))


def _zth_mv_lv(fault_mva, tx_mva):
    import cmath
    return (cmath.rect(100.0 / fault_mva, math.atan(15.0))
            + cmath.rect(0.10 * 100.0 / tx_mva, math.atan(10.0)))


class TestN1ConstantImpedanceLockedRotor:
    """A locked rotor is an impedance. The constant-PQ model found no
    solution for 400 kW on a 1 MVA transformer and called it "voltage
    collapse"; the impedance divider gives 0.736 p.u."""

    def test_matches_divider_where_pq_collapsed(self):
        mp = _motor_props(rated_kw=400.0, locked_rotor_pf=0.3)
        r = run_motor_starting(_mv_lv(mp, fault_mva=50.0, tx_mva=1.0))["motors"][0]
        s_mva = 6 * 400 / (0.93 * 0.85) / 1000
        assert r["collapse"] is False
        assert r["model"] == "constant-impedance locked rotor"
        assert r["motor_terminal_voltage_pu"] == pytest.approx(
            _hand_divider(_zth_mv_lv(50.0, 1.0), s_mva, 0.3), abs=5e-4)

    def test_soft_starter_is_constant_current(self):
        mp = _motor_props(starting_method="soft_starter", ss_current_limit_xflc=3.0,
                          locked_rotor_pf=0.3)
        r = run_motor_starting(_mv_lv(mp, fault_mva=50.0, tx_mva=1.0))["motors"][0]
        assert r["model"].startswith("constant-current")
        # constant current: |V| ≈ |V_pre − Z·I| (angles aligned to V_pre)
        import cmath
        i = 3.0 * 200 / (0.93 * 0.85) / 1000 / 100 * cmath.rect(1, -math.acos(0.3))
        v = 1.0 - _zth_mv_lv(50.0, 1.0) * i
        assert r["motor_terminal_voltage_pu"] == pytest.approx(abs(v), abs=5e-3)


class TestN2VfdSupplyPf:
    def test_vfd_start_at_drive_pf(self):
        r = run_motor_starting(_mv_lv(_motor_props(starting_method="vfd")))["motors"][0]
        assert r["start_pf"] == pytest.approx(0.95)
        assert r["model"].startswith("constant-power")


class TestN3LockedRotorPfAndTorque:
    def test_pf_from_nameplate_fit(self):
        """No locked_rotor_pf → the fitted model's Re Y/|Y| at s = 1 (the same
        machine the dynamic study simulates), not a fixed 0.3."""
        from backend.analysis.dynamic_motor_starting import _fit_motor_model, _rated_slip
        r = run_motor_starting(_mv_lv(_motor_props()))["motors"][0]
        s_r = _rated_slip(1480.0, 50.0)
        t_fl = 0.93 * 0.85 / (1 - s_r)
        y = _fit_motor_model(6.0, 1.5 * t_fl, t_fl, s_r, 1.0, [], "M").y_in(1.0)
        assert r["start_pf"] == pytest.approx(y.real / abs(y), abs=1e-3)

    def test_star_delta_torque_shortfall_fails(self):
        """Star gives a third of the torque: 150 % LRT → 50 % < a constant
        90 % load, so the motor cannot break away even though the voltage
        hardly dips. DOL on the same load clears."""
        heavy = dict(load_torque_model="constant", load_torque_pct=90.0)
        sd = run_motor_starting(_mv_lv(_motor_props(starting_method="star_delta", **heavy)))["motors"][0]
        dol = run_motor_starting(_mv_lv(_motor_props(**heavy)))["motors"][0]
        assert sd["motor_terminal_voltage_pu"] > 0.95
        assert sd["torque_ok"] is False and sd["motor_will_start"] is False
        assert sd["status"] == "fail" and "torque" in sd["issues"][0]
        assert dol["torque_ok"] is True and dol["motor_will_start"] is True


class TestN4BusDuctTerminal:
    def test_motor_behind_bus_duct_is_simulated(self):
        p = _mv_lv()
        p.components.append(_c("bd", "bus_duct", {"name": "BD", "rated_current_a": 1000}))
        p.wires = [w for w in p.wires if w.id != "w4"] + [
            _w("w4a", "b2", "bd"), _w("w4b", "bd", "m1")]
        res = run_dynamic_motor_starting(p)
        assert res["motors"] and res["motors"][0]["terminal_bus"] == "LV Bus", res["warnings"]


class TestN5RunningMotorsAndDeadBus:
    def test_running_motor_slows_during_a_start_and_recovers(self):
        p = _mv_lv(_motor_props(dyn_role="running", name="RUN"), fault_mva=50.0, tx_mva=1.0)
        p.components.append(_c("m2", "motor_induction", _motor_props(name="BIG", rated_kw=250.0)))
        p.wires.append(_w("w5", "b2", "m2"))
        res = {m["motor_name"]: m for m in run_dynamic_motor_starting(p)["motors"]}
        spd = res["RUN"]["curves"]["speed_pct"]
        assert min(spd) < spd[0] - 0.3          # pulled down by BIG's inrush
        assert spd[-1] == pytest.approx(spd[0], abs=0.05)
        assert res["RUN"]["status"] == "pass"
        assert res["BIG"]["sim_status"] == "started"

    def test_running_only_is_stationary(self):
        r = _one(_mv_lv(_motor_props(dyn_role="running"), fault_mva=50.0, tx_mva=1.0))
        spd = r["curves"]["speed_pct"]
        assert max(spd) - min(spd) < 0.02

    def test_dead_bus_motor_not_simulated(self):
        p = _mv_lv()
        p.components.append(_c("cb", "cb", {"name": "CB", "state": "open"}))
        p.wires = [w for w in p.wires if w.id != "w2"] + [_w("w2a", "b1", "cb"),
                                                          _w("w2b", "cb", "t1")]
        res = run_dynamic_motor_starting(p)
        assert res["motors"] == []
        assert any("de-energised" in w for w in res["warnings"])


class TestN6SyncMotorFaultImpedance:
    """IEC 60909-0 §3.8.1: synchronous motors are treated as generators —
    K_G = c_max/(1 + x″d·sin φ) and the §6.6.1 fictitious R (0.07·X″d above
    1 kV, < 100 MVA) when no X/R is given; the old code used neither (X/R 40)."""

    def _sm(self, **kw):
        props = {"name": "SM", "rated_kva": 500, "voltage_kv": 3.3,
                 "power_factor": 0.9, "xd_pp": 0.15}
        props.update(kw)
        return _c("sm", "motor_synchronous", props)

    def test_kg_and_fictitious_r(self):
        z = fault._motor_synchronous_impedance(self._sm(), 100.0)
        x = 0.15 * 100 / 0.5
        k = 1.1 / (1 + 0.15 * math.sqrt(1 - 0.81))
        assert z == pytest.approx(complex(0.07 * x, x) * k, rel=1e-9)

    def test_explicit_xr_and_nameplate_context(self):
        tok = fault._NAMEPLATE_IMPEDANCE.set(True)
        try:
            z = fault._motor_synchronous_impedance(self._sm(x_r_ratio=20), 100.0)
        finally:
            fault._NAMEPLATE_IMPEDANCE.reset(tok)
        assert z == pytest.approx(complex(30.0 / 20, 30.0), rel=1e-9)


class TestN7GeneratorFictitiousResistance:
    def test_palette_generator_has_no_fixed_xr(self):
        """With no x_r_ratio the fault engine applies R_G = 0.07·X″d
        (11 kV, 10 MVA). The palette default of 40 made that unreachable."""
        import pathlib, re
        js = pathlib.Path(__file__).resolve().parents[2] / "frontend/js/constants.js"
        src = js.read_text()
        gen = src[src.index("  generator: {"):]
        defaults = gen[:gen.index("    fields:")]
        assert not re.search(r"\bx_r_ratio\s*:", defaults)
        z = fault._generator_impedance(_c("g", "generator", {
            "rated_mva": 10, "voltage_kv": 11, "xd_pp": 0.15, "power_factor": 0.85}), 100.0)
        assert z.real / z.imag == pytest.approx(0.07, rel=1e-9)


class TestN8InductionMotorXppFromLrc:
    """IEC 60909-0 §3.8.2: |Z_M| = 1/(I_LR/I_rM), X = |Z|/√(1 + (R/X)²)."""

    def test_derived_from_lrc(self):
        x = fault.induction_motor_x_pp({"locked_rotor_current": 7.0}, 2.4)
        assert x == pytest.approx((1 / 7.0) / math.sqrt(1 + (1 / 2.4) ** 2), rel=1e-12)

    def test_explicit_x_pp_wins(self):
        assert fault.induction_motor_x_pp({"x_pp": 0.2, "locked_rotor_current": 7.0}, 2.4) == 0.2

    def test_lrc_moves_fault_contribution(self):
        def ik(lrc):
            mp = _motor_props(locked_rotor_current=lrc)
            mp.pop("x_pp", None)
            return fault.run_fault_analysis(_mv_lv(mp)).buses["b2"].ik3
        assert ik(8.0) > ik(5.0)
