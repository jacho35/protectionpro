"""Dynamic motor starting — standards-anchored regression tests.

The nameplate IS the anchor: the fitted equivalent circuit must reproduce
the locked-rotor current, locked-rotor torque and rated-point torque the
user entered (IEEE 3002.7 nameplate-based modelling). The swing-equation
integrator is cross-checked against an independent quadrature of
t = ∫ 2H·dω / (T_e − T_L) over the same torque curve.
"""

import math
import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.dynamic_motor_starting import (
    run_dynamic_motor_starting, _fit_motor_model, _rated_slip,
    _load_torque_fn,
)


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _motor_props(**overrides):
    props = {
        "name": "M1", "rated_kw": 200.0, "voltage_kv": 0.4,
        "efficiency": 0.93, "power_factor": 0.85,
        "locked_rotor_current": 6.0, "locked_rotor_torque_pct": 150.0,
        "rated_speed_rpm": 1480.0, "starting_method": "dol",
        "motor_j_kgm2": 2.5, "load_j_kgm2": 2.5,
        "load_torque_model": "quadratic", "load_torque_pct": 90.0,
        "load_breakaway_pct": 10.0,
    }
    props.update(overrides)
    return props


def _project(motor_props=None, fault_mva=500.0, tx_mva=10.0):
    """Utility → 11 kV bus → 10 MVA 10% transformer → 0.4 kV bus → motor."""
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 11.0, "fault_mva": fault_mva,
            "x_r_ratio": 15.0,
        }),
        _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
        _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": tx_mva, "z_percent": 10.0,
            "x_r_ratio": 10.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
            "vector_group": "Dyn11",
        }),
        _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4}),
        _comp("motor_induction-1", "motor_induction",
              motor_props or _motor_props()),
    ]
    wires = [
        _wire("w1", "utility-1", "bus-1"),
        _wire("w2", "bus-1", "transformer-1"),
        _wire("w3", "transformer-1", "bus-2"),
        _wire("w4", "bus-2", "motor_induction-1"),
    ]
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _run_one(motor_props=None, **kw):
    res = run_dynamic_motor_starting(_project(motor_props, **kw))
    assert res["motors"], f"no motor results; warnings: {res['warnings']}"
    return res["motors"][0]


# ── Equivalent-circuit fit reproduces the nameplate ─────────────────────

class TestModelFit:
    """200 kW, 0.4 kV, η=0.93, pf=0.85, LRC 6×, LRT 150%, 1480 rpm, 50 Hz:
    s_r = 1 − 1480/1500 = 0.01333,
    T_FL = η·pf/(1−s_r) = 0.7905/0.98667 = 0.8012 pu,
    T_LR = 1.5 × 0.8012 = 1.2018 pu."""

    def _fit(self):
        s_r = _rated_slip(1480.0, 50.0)
        t_fl = 0.93 * 0.85 / (1.0 - s_r)
        return _fit_motor_model(6.0, 1.5 * t_fl, t_fl, s_r, 1.0, [], "M"), s_r, t_fl

    def test_rated_slip(self):
        assert _rated_slip(1480.0, 50.0) == pytest.approx(1.0 - 1480.0 / 1500.0, rel=1e-9)

    def test_locked_rotor_current_reproduced(self):
        model, _, _ = self._fit()
        assert abs(model.y_in(1.0)) == pytest.approx(6.0, rel=0.01)

    def test_locked_rotor_torque_reproduced(self):
        model, _, t_fl = self._fit()
        assert model.torque(1.0, 1.0) == pytest.approx(1.5 * t_fl, rel=0.01)

    def test_rated_point_torque_reproduced(self):
        model, s_r, t_fl = self._fit()
        assert model.torque(1.0, s_r) == pytest.approx(t_fl, rel=0.01)

    def test_deep_bar_resistance_ordering(self):
        """Deep-bar fit: running rotor resistance below the locked value,
        and R2_start ≈ T_LR/LRC² (magnetizing branch shifts it only a few
        per cent from the no-Xm hand value 1.2018/36 = 0.0334)."""
        model, _, t_fl = self._fit()
        assert model.r2_run < model.r2_start
        assert model.r2_start == pytest.approx(1.5 * t_fl / 36.0, rel=0.15)

    def test_breakdown_predicted_above_both_anchors(self):
        """The fitted curve's breakdown torque must exceed both nameplate
        anchors (LRT and FLT) — a monotonic curve cannot start a loaded
        machine and the fit would be unusable."""
        model, s_r, t_fl = self._fit()
        t_max = max(model.torque(1.0, s / 200.0) for s in range(1, 201))
        assert t_max > 1.5 * t_fl
        assert t_max > t_fl


# ── Time-domain simulation ──────────────────────────────────────────────

class TestSimulation:
    def test_dol_start_succeeds_with_trajectories(self):
        m = _run_one()
        assert m["status"] in ("pass", "warning")
        assert m["sim_status"] == "started"
        assert m["accel_time_s"] and 0.1 < m["accel_time_s"] < 30.0
        c = m["curves"]
        assert len(c["t"]) == len(c["speed_pct"]) == len(c["current_xflc"])
        assert c["speed_pct"][0] < 1.0 and c["speed_pct"][-1] > 95.0
        # speed is monotonically non-decreasing for a successful start
        assert all(b >= a - 1e-6 for a, b in zip(c["speed_pct"], c["speed_pct"][1:]))

    def test_initial_current_is_lrc_times_terminal_voltage(self):
        """At t = 0 the drawn current must be LRC × the (depressed) motor
        terminal voltage — the defining locked-rotor point."""
        m = _run_one()
        c = m["curves"]
        assert c["current_xflc"][0] == pytest.approx(6.0 * c["v_motor_pu"][0], rel=0.02)

    def test_initial_dip_matches_impedance_divider(self):
        """1000 kW (η=0.95, pf=0.85, LRC 6×) behind the 10 MVA/10% tx on a
        500 MVA grid: Z_th ≈ j1.2 pu (system base) → on the 1.238 MVA motor
        base 0.01486 pu; Z_LR = 1/6 pu, so V_start ≈ 0.1667/0.1816 ≈ 0.92 of
        the pre-start voltage (constant-impedance divider hand calc)."""
        props = _motor_props(rated_kw=1000.0, efficiency=0.95,
                             motor_j_kgm2=10.0, load_j_kgm2=10.0)
        m = _run_one(props)
        ratio = m["curves"]["v_bus_pu"][0] / m["v_prestart_pu"]
        assert ratio == pytest.approx(0.92, abs=0.02)
        assert 5.0 < m["max_bus_dip_pct"] < 12.0

    def test_accel_time_matches_independent_quadrature(self):
        """Cross-check the RK2 swing integration against an independent
        trapezoidal quadrature of t = ∫ 2H·dω/(T_e − T_L) on a stiff bus
        (fault level 100 GVA ⇒ V ≈ 1 throughout)."""
        props = _motor_props(load_torque_pct=50.0)
        m = _run_one(props, fault_mva=100000.0, tx_mva=1000.0)
        assert m["sim_status"] == "started"

        s_r = _rated_slip(1480.0, 50.0)
        t_fl = 0.93 * 0.85 / (1.0 - s_r)
        model = _fit_motor_model(6.0, 1.5 * t_fl, t_fl, s_r, 1.0, [], "M")
        h = m["model"]["h_total_s"]
        v = m["curves"]["v_motor_pu"][0]  # ≈ constant on the stiff bus
        load = _load_torque_fn("quadratic", 0.5 * t_fl, 0.10, 1.0 - s_r)

        omega_end = m["final_speed_pct"] / 100.0
        n = 20000
        t_quad, prev = 0.0, None
        for i in range(n + 1):
            w = omega_end * i / n
            net = model.torque(v, max(1.0 - w, 1e-6)) - load(w)
            inv = 2.0 * h / max(net, 1e-9)
            if prev is not None:
                t_quad += 0.5 * (inv + prev) * (omega_end / n)
            prev = inv
        assert m["accel_time_s"] == pytest.approx(t_quad, rel=0.05)

    def test_overloaded_motor_stalls(self):
        props = _motor_props(load_torque_pct=200.0, load_torque_model="constant")
        m = _run_one(props)
        assert m["sim_status"] == "stalled"
        assert m["status"] == "fail"
        assert m["final_speed_pct"] < 90.0
        assert any("stall" in i.lower() for i in m["issues"])

    def test_star_delta_third_current_and_slower(self):
        dol = _run_one(_motor_props())
        sd = _run_one(_motor_props(starting_method="star_delta"))
        # initial line current: one third of DOL (slightly above via the
        # smaller voltage dip at the reduced current)
        ratio = sd["curves"]["current_xflc"][0] / dol["curves"]["current_xflc"][0]
        assert ratio == pytest.approx(1.0 / 3.0, rel=0.10)
        # one-third torque ⇒ slower acceleration
        assert sd["accel_time_s"] > dol["accel_time_s"]
        assert sd["transition"] is not None
        assert sd["transition"]["speed_pct"] >= 79.0

    def test_soft_starter_respects_current_limit(self):
        props = _motor_props(starting_method="soft_starter",
                             ss_current_limit_xflc=3.0, ss_ramp_s=5.0,
                             load_torque_pct=40.0)
        m = _run_one(props)
        assert m["peak_current_xflc"] <= 3.0 + 0.05
        assert m["sim_status"] == "started"

    def test_vfd_not_simulated(self):
        m = _run_one(_motor_props(starting_method="vfd"))
        assert m["status"] == "not_simulated"
        assert "note" in m

    def test_synchronous_motor_reaches_pullin(self):
        comps_props = {
            "name": "SM1", "rated_kva": 250.0, "voltage_kv": 0.4,
            "power_factor": 0.9, "locked_rotor_current": 5.5,
            "locked_rotor_torque_pct": 120.0, "rated_speed_rpm": 1500.0,
            "motor_j_kgm2": 3.0, "load_torque_pct": 60.0,
        }
        proj = _project()
        proj.components[-1] = _comp("motor_synchronous-1",
                                    "motor_synchronous", comps_props)
        proj.wires[-1] = _wire("w4", "bus-2", "motor_synchronous-1")
        res = run_dynamic_motor_starting(proj)
        m = res["motors"][0]
        assert m["motor_type"] == "synchronous"
        assert m["sim_status"] == "started"
        assert m["final_speed_pct"] >= 94.0

    def test_thermal_i2t_consistent_with_current_curve(self):
        """thermal_used_pct must agree with a trapezoidal ∫I²dt over the
        returned (decimated) current trajectory."""
        m = _run_one()
        c = m["curves"]
        end = m["accel_time_s"]
        i2t = 0.0
        for i in range(1, len(c["t"])):
            if c["t"][i - 1] > end:
                break
            dt = min(c["t"][i], end) - c["t"][i - 1]
            i2t += 0.5 * (c["current_xflc"][i - 1] ** 2 + c["current_xflc"][i] ** 2) * max(dt, 0.0)
        expected_pct = i2t / (36.0 * m["stall_time_hot_s"]) * 100.0
        assert m["thermal_used_pct"] == pytest.approx(expected_pct, rel=0.10)

    def test_weaker_source_deeper_dip_longer_start(self):
        stiff = _run_one(_motor_props(rated_kw=1000.0, efficiency=0.95,
                                      motor_j_kgm2=10.0, load_j_kgm2=10.0),
                         tx_mva=20.0)
        weak = _run_one(_motor_props(rated_kw=1000.0, efficiency=0.95,
                                     motor_j_kgm2=10.0, load_j_kgm2=10.0),
                        tx_mva=2.5)
        assert weak["min_v_bus_pu"] < stiff["min_v_bus_pu"]
        assert weak["accel_time_s"] > stiff["accel_time_s"]


class TestIntegrations:
    def test_study_manager_runs_dynamic_study(self):
        """Batch runner includes the dynamic study and summarizes statuses."""
        from backend.analysis.study_manager import run_study_manager
        res = run_study_manager(_project(), ["dynamic_motor_starting"])
        study = res["studies"]["dynamic_motor_starting"]
        assert study["name"] == "Dynamic Motor Starting"
        assert study["status"] in ("pass", "warning")
        assert study["counts"]["total"] == 1
        assert study["result"]["motors"][0]["sim_status"] == "started"

    def test_study_manager_vfd_counts_not_simulated(self):
        from backend.analysis.study_manager import run_study_manager
        res = run_study_manager(_project(_motor_props(starting_method="vfd")),
                                ["dynamic_motor_starting"])
        counts = res["studies"]["dynamic_motor_starting"]["counts"]
        assert counts["not_simulated"] == 1

    def test_calculations_pdf_includes_dynamic_section(self):
        """The calculations report renders the dynamic-motor section from a
        real result payload without raising, and grows the document."""
        from backend.analysis.pdf_reports import generate_calculations_report
        # J unset -> engine emits the "estimated J ≈ ..." warning, which
        # exercises the cp1252 sanitizer (core PDF fonts reject "≈")
        dyn = run_dynamic_motor_starting(
            _project(_motor_props(motor_j_kgm2=0, load_j_kgm2=0)))
        assert any("≈" in w for w in dyn["motors"][0]["warnings"])
        without = generate_calculations_report(
            "t", 100.0, 50, components=[]).getvalue()
        with_dyn = generate_calculations_report(
            "t", 100.0, 50, components=[],
            dynamic_motor_results=dyn).getvalue()
        assert with_dyn.startswith(b"%PDF")
        assert len(with_dyn) > len(without)


class TestEdgeCases:
    def test_no_motors(self):
        proj = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                           components=[_comp("bus-1", "bus",
                                             {"name": "B", "voltage_kv": 11.0})],
                           wires=[])
        res = run_dynamic_motor_starting(proj)
        assert res["motors"] == []
        assert res["warnings"]

    def test_unconnected_motor_skipped(self):
        proj = _project()
        proj.wires = proj.wires[:-1]  # drop the motor connection
        res = run_dynamic_motor_starting(proj)
        assert res["motors"] == []
        assert any("not connected" in w for w in res["warnings"])

    def test_motor_fed_through_cable_gets_terminal_bus(self):
        """A motor wired to its bus only through a feeder cable (+ CB) has no
        busbar at its own terminal. The transparent-only bus walk can't reach
        it, so it used to be skipped as 'not connected to a bus'. A synthetic
        terminal bus must be inserted (as in load flow) so the study runs and
        the feeder impedance is part of the motor's Thevenin."""
        proj = _project()
        # Replace the direct bus-2 → motor wire with bus-2 → CB → cable → motor,
        # leaving the motor with no busbar of its own.
        proj.wires = proj.wires[:-1]
        proj.components.append(_comp("cb-m", "cb", {"name": "CB", "state": "closed"}))
        proj.components.append(_comp("cable-m", "cable", {
            "name": "Feeder", "voltage_kv": 0.4, "length_km": 0.05,
            "r_per_km": 0.1, "x_per_km": 0.08, "rated_amps": 400,
        }))
        proj.wires.append(_wire("wm1", "bus-2", "cb-m"))
        proj.wires.append(_wire("wm2", "cb-m", "cable-m"))
        proj.wires.append(_wire("wm3", "cable-m", "motor_induction-1"))
        res = run_dynamic_motor_starting(proj)
        assert not any("not connected" in w for w in res["warnings"])
        assert len(res["motors"]) == 1
        m = res["motors"][0]
        assert m["terminal_bus"]                 # a (synthetic) terminal bus was found
        assert m["flc_a"] > 0 and m["curves"]    # a real trajectory was produced

    def test_inertia_estimated_when_unset(self):
        m = _run_one(_motor_props(motor_j_kgm2=0, load_j_kgm2=0))
        assert any("estimated" in w.lower() for w in m["warnings"])
        assert m["model"]["j_total_kgm2"] > 0


# ── Sequenced / coupled multi-motor starting ────────────────────────────

def _two_motor_project(a_over=None, b_over=None, tx_mva=2.0):
    """Utility → 11 kV → 2 MVA/6% tx → 0.4 kV bus → two 200 kW motors.
    Deliberately weak transformer so the shared-bus voltage dip is visible."""
    def motor(cid, name, over):
        p = {
            "name": name, "rated_kw": 200.0, "voltage_kv": 0.4,
            "efficiency": 0.93, "power_factor": 0.85,
            "locked_rotor_current": 6.0, "locked_rotor_torque_pct": 150.0,
            "rated_speed_rpm": 1480.0, "starting_method": "dol",
            "motor_j_kgm2": 3.0, "load_j_kgm2": 3.0, "load_torque_pct": 80.0,
        }
        p.update(over or {})
        return _comp(cid, "motor_induction", p)

    comps = [
        _comp("utility-1", "utility",
              {"name": "Grid", "voltage_kv": 11.0, "fault_mva": 500.0, "x_r_ratio": 15.0}),
        _comp("bus-1", "bus", {"name": "MV", "voltage_kv": 11.0}),
        _comp("transformer-1", "transformer",
              {"name": "TX1", "rated_mva": tx_mva, "z_percent": 6.0, "x_r_ratio": 8.0,
               "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4}),
        _comp("bus-2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        motor("motor_induction-1", "MotorA", a_over),
        motor("motor_induction-2", "motor_induction-2".upper(), b_over),
    ]
    comps[-1].props["name"] = "MotorB"
    wires = [
        _wire("w1", "utility-1", "bus-1"),
        _wire("w2", "bus-1", "transformer-1"),
        _wire("w3", "transformer-1", "bus-2"),
        _wire("w4", "bus-2", "motor_induction-1"),
        _wire("w5", "bus-2", "motor_induction-2"),
    ]
    return ProjectData(projectName="seq", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _by_name(res):
    return {m["motor_name"]: m for m in res["motors"]}


class TestSequencedStarting:
    def test_two_motors_sag_more_than_one(self):
        """Two motors starting together on one bus draw combined inrush and so
        sag the shared bus deeper than a single motor's start."""
        two = _by_name(run_dynamic_motor_starting(_two_motor_project()))
        # single-motor reference on the identical network
        one_proj = _two_motor_project()
        one_proj.components = [c for c in one_proj.components if c.id != "motor_induction-2"]
        one_proj.wires = [w for w in one_proj.wires if w.toComponent != "motor_induction-2"]
        one = _by_name(run_dynamic_motor_starting(one_proj))
        assert two["MotorA"]["min_v_bus_pu"] < one["MotorA"]["min_v_bus_pu"] - 1e-3
        assert two["MotorA"]["sim_status"] == "started"

    def test_staggered_start_energizes_at_start_time(self):
        """A motor staged to start later shows a flat pre-start segment then its
        inrush; the shared bus dips at exactly its start_time, and its
        acceleration time is measured from energisation (not global t)."""
        res = run_dynamic_motor_starting(
            _two_motor_project(b_over={"start_time_s": 3.0}))
        b = _by_name(res)["MotorB"]
        assert b["start_time_s"] == 3.0
        assert b["sim_status"] == "started"
        assert b["accel_time_s"] < 2.0  # relative to energisation, not 3+
        c = b["curves"]
        # speed stays zero until ~3 s, then rises
        pre = [s for t, s in zip(c["t"], c["speed_pct"]) if t < 2.9]
        post = [s for t, s in zip(c["t"], c["speed_pct"]) if t > 3.2]
        assert max(pre, default=0.0) < 1.0
        assert max(post, default=0.0) > 90.0
        # sequence overview: bus voltage drops when B energises
        seq = res["sequence"]
        assert seq is not None and seq["staggered"] is True
        tvals = seq["t"]; vvals = seq["buses"][0]["v_pu"]
        v_before = max(v for t, v in zip(tvals, vvals) if 2.5 <= t < 3.0)
        v_after = min(v for t, v in zip(tvals, vvals) if 3.0 <= t <= 3.3)
        assert v_after < v_before - 0.02

    def test_running_role_loads_but_not_simulated(self):
        """A motor marked already-running is a steady background load (deepening
        the start dip the staged motor sees) and is not simulated as a start."""
        res = run_dynamic_motor_starting(
            _two_motor_project(b_over={"dyn_role": "running"}))
        b = _by_name(res)["MotorB"]
        assert b["role"] == "running"
        assert b["sim_status"] == "running"
        assert b["accel_time_s"] is None
        # starting A against a running B sags more than A entirely alone
        a_running = _by_name(res)["MotorA"]["min_v_bus_pu"]
        solo = _two_motor_project()
        solo.components = [c for c in solo.components if c.id != "motor_induction-2"]
        solo.wires = [w for w in solo.wires if w.toComponent != "motor_induction-2"]
        a_solo = _by_name(run_dynamic_motor_starting(solo))["MotorA"]["min_v_bus_pu"]
        assert a_running < a_solo - 1e-3

    def test_schedule_override_supersedes_props(self):
        """The start-timeline modal sends a dynamicMotorSchedule that overrides
        the motors' own dyn_role / start_time_s props: MotorB's props say start
        at 0, but the schedule stages it at 3 s and MotorA as already-running."""
        proj = _two_motor_project(b_over={"start_time_s": 0.0})
        proj.dynamicMotorSchedule = {"motors": [
            {"id": "motor_induction-1", "role": "running", "start_time_s": 0.0},
            {"id": "motor_induction-2", "role": "starts", "start_time_s": 3.0},
        ]}
        res = _by_name(run_dynamic_motor_starting(proj))
        assert res["MotorA"]["role"] == "running"
        assert res["MotorA"]["sim_status"] == "running"
        assert res["MotorB"]["role"] == "starts"
        assert res["MotorB"]["start_time_s"] == 3.0

    def test_no_schedule_falls_back_to_props(self):
        """With no dynamicMotorSchedule, per-motor props still drive staging."""
        res = _by_name(run_dynamic_motor_starting(
            _two_motor_project(b_over={"start_time_s": 2.0})))
        assert res["MotorB"]["start_time_s"] == 2.0
        assert res["MotorA"]["start_time_s"] == 0.0

    def test_cross_bus_coupling(self):
        """Motors on two different LV buses fed from a common transformer still
        interact: starting both together sags each bus more than one alone."""
        def build(second_motor):
            comps = [
                _comp("utility-1", "utility",
                      {"name": "G", "voltage_kv": 11.0, "fault_mva": 500.0, "x_r_ratio": 15.0}),
                _comp("bus-mv", "bus", {"name": "MV", "voltage_kv": 11.0}),
                _comp("tx", "transformer",
                      {"name": "TX", "rated_mva": 2.0, "z_percent": 6.0, "x_r_ratio": 8.0,
                       "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4}),
                _comp("bus-lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
                _comp("c-a", "cable", {"name": "Ca", "voltage_kv": 0.4,
                                       "r_per_km": 0.1, "x_per_km": 0.07, "length_km": 0.05}),
                _comp("bus-a", "bus", {"name": "BusA", "voltage_kv": 0.4}),
                _comp("motor_induction-1", "motor_induction",
                      {"name": "MotorA", "rated_kw": 150.0, "voltage_kv": 0.4,
                       "efficiency": 0.93, "power_factor": 0.85, "locked_rotor_current": 6.0,
                       "locked_rotor_torque_pct": 150.0, "rated_speed_rpm": 1480.0,
                       "motor_j_kgm2": 2.0, "load_j_kgm2": 2.0, "load_torque_pct": 80.0}),
            ]
            wires = [
                _wire("w1", "utility-1", "bus-mv"), _wire("w2", "bus-mv", "tx"),
                _wire("w3", "tx", "bus-lv"), _wire("w4", "bus-lv", "c-a"),
                _wire("w5", "c-a", "bus-a"), _wire("w6", "bus-a", "motor_induction-1"),
            ]
            if second_motor:
                comps += [
                    _comp("c-b", "cable", {"name": "Cb", "voltage_kv": 0.4,
                                           "r_per_km": 0.1, "x_per_km": 0.07, "length_km": 0.05}),
                    _comp("bus-b", "bus", {"name": "BusB", "voltage_kv": 0.4}),
                    _comp("motor_induction-2", "motor_induction",
                          {"name": "MotorB", "rated_kw": 150.0, "voltage_kv": 0.4,
                           "efficiency": 0.93, "power_factor": 0.85, "locked_rotor_current": 6.0,
                           "locked_rotor_torque_pct": 150.0, "rated_speed_rpm": 1480.0,
                           "motor_j_kgm2": 2.0, "load_j_kgm2": 2.0, "load_torque_pct": 80.0}),
                ]
                wires += [_wire("w7", "bus-lv", "c-b"), _wire("w8", "c-b", "bus-b"),
                          _wire("w9", "bus-b", "motor_induction-2")]
            return ProjectData(projectName="xbus", baseMVA=100.0, frequency=50,
                               components=comps, wires=wires)

        solo = _by_name(run_dynamic_motor_starting(build(False)))["MotorA"]["min_v_bus_pu"]
        both = _by_name(run_dynamic_motor_starting(build(True)))["MotorA"]["min_v_bus_pu"]
        assert both < solo - 1e-3  # MotorB's inrush reaches MotorA's bus
