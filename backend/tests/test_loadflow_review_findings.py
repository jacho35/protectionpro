"""Load-flow review findings (H1-H5, M1-M5, L1-L6) — one regression per fix.

Each test builds the smallest network that exposed the defect and asserts the
physically-correct answer (an explicit-bus redraw, a hand calculation, or the
Newton-Raphson reference), so the old behaviour fails it.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import (
    run_load_flow, _battery_params, _run_oltc, _source_output_mva,
    insert_junction_buses,
)
from backend.analysis.timeseries_loadflow import run_timeseries_loadflow


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    """links: (from_id, from_port, to_id, to_port) tuples."""
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _util(kv, **extra):
    return _c("u", "utility", {"name": "Grid", "voltage_kv": kv, "fault_mva": 500,
                               "x_r_ratio": 15, **extra})


def _bus(bid, kv, **extra):
    return _c(bid, "bus", {"name": bid, "voltage_kv": kv, **extra})


def _cable(cid, kv, r, x, km, amps=400):
    return _c(cid, "cable", {"name": cid, "voltage_kv": kv, "r_per_km": r,
                             "x_per_km": x, "length_km": km, "rated_amps": amps})


def _load(lid, kva, pf):
    return _c(lid, "static_load", {"name": lid, "rated_kva": kva, "power_factor": pf})


def _xfmr(tid="t", lv=0.4, **extra):
    return _c(tid, "transformer", {"name": tid, "rated_mva": 1, "z_percent": 6,
                                   "x_r_ratio": 8, "voltage_hv_kv": 11,
                                   "voltage_lv_kv": lv, **extra})


def _branch(res, eid):
    return next(b for b in res.branches if b.elementId == eid)


# ── H1: cable voltage zone must not depend on component list order ──────────

def _tx_three_cable_chain(order, explicit_bus=False):
    parts = {
        "t": _xfmr(),
        "c1": _cable("c1", 0.4, 0.1, 0.08, 0.2, 2000),
        "c2": _cable("c2", 0.4, 0.1, 0.08, 0.01, 2000),
        "c3": _cable("c3", 0.4, 0.1, 0.08, 0.01, 2000),
    }
    comps = [parts[k] for k in order] + [
        _util(11), _bus("A", 11), _bus("B", 0.4), _load("L", 800, 0.9)]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary")]
    if explicit_bus:
        comps.append(_bus("X", 0.4))
        links += [("t", "secondary", "X", "at_0"), ("X", "at_1", "c1", "from")]
    else:
        links.append(("t", "secondary", "c1", "from"))
    links += [("c1", "to", "c2", "from"), ("c2", "to", "c3", "from"),
              ("c3", "to", "B", "at_0"), ("B", "at_1", "L", "in")]
    return _project(comps, links)


@pytest.mark.parametrize("order", [["t", "c1", "c2", "c3"], ["c1", "t", "c2", "c3"],
                                   ["c3", "t", "c1", "c2"], ["c2", "c1", "t", "c3"]])
def test_h1_chain_zone_independent_of_component_order(order):
    ref = run_load_flow(_tx_three_cable_chain(["t", "c1", "c2", "c3"], explicit_bus=True))
    res = run_load_flow(_tx_three_cable_chain(order))
    # Was 0.9585 / 0.9654 (a 0.4 kV cable referred to the 11 kV base) vs 0.7886.
    assert res.buses["B"].voltage_pu == pytest.approx(ref.buses["B"].voltage_pu, abs=1e-5)


# ── H2: 0 % state of charge is empty, not full ─────────────────────────────

def test_h2_battery_zero_soc_cannot_discharge():
    b = _c("b", "battery", {"battery_kwh": 200, "rated_kva": 100,
                            "battery_mode": "discharging", "battery_soc_pct": 0,
                            "battery_dod_pct": 90, "battery_max_discharge_kw": 100,
                            "battery_max_charge_kw": 100})
    bp = _battery_params(b)
    assert bp["available_kwh"] == 0
    assert bp["can_discharge"] is False
    assert bp["can_charge"] is True


def test_h2_timeseries_depleted_battery_stays_depleted():
    comps = [_c("u", "utility", {"voltage_kv": 0.4, "fault_mva": 50}), _bus("A", 0.4),
             _c("bt", "battery", {"battery_kwh": 100, "rated_kva": 100,
                                  "battery_mode": "discharging", "battery_soc_pct": 100,
                                  "battery_dod_pct": 100, "battery_max_discharge_kw": 50,
                                  "battery_max_charge_kw": 50, "battery_rt_eff": 1.0,
                                  "var_mode": "unity"}),
             _load("L", 300, 1.0)]
    proj = _project(comps, [("u", "out", "A", "at_0"), ("bt", "out", "A", "at_1"),
                            ("A", "at_2", "L", "in")])
    res = run_timeseries_loadflow(proj, horizon_hours=6, step_minutes=60,
                                  default_profile="flat")
    traj = res.battery_trajectories[0]
    assert traj.soc_pct[1] == pytest.approx(0.0)
    # 100 kWh delivers 2 h at 50 kW and then nothing — it used to keep
    # discharging at 0 % (300 kWh out of a 100 kWh battery).
    assert all(p == pytest.approx(0.0) for p in traj.dispatched_mw[2:])
    assert sum(traj.dispatched_mw) * 1000 == pytest.approx(100.0)


# ── H3: a PV label with no regulating unit is not a reactive source ───────

def test_h3_pv_label_without_regulator_solves_as_pq():
    comps = [_util(11), _bus("A", 11), _cable("c", 11, 0.3, 0.1, 5, 300),
             _bus("B", 11, bus_type="PV"), _load("L", 2000, 0.8)]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c", "from"),
             ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]
    res = run_load_flow(_project(comps, links))
    comps[3].props["bus_type"] = "PQ"
    ref = run_load_flow(_project(comps, links))
    assert res.buses["B"].voltage_pu == pytest.approx(ref.buses["B"].voltage_pu, abs=1e-9)
    assert res.buses["B"].voltage_pu < 0.99       # was pinned at 1.000 with 5.5 MVAr
    assert any("labelled PV" in w.message for w in res.warnings)


def test_h3_pv_label_with_generator_still_regulates():
    comps = [_util(11), _bus("A", 11), _cable("c", 11, 0.3, 0.1, 5, 300),
             _bus("B", 11, bus_type="PV"), _load("L", 2000, 0.8),
             _c("g", "generator", {"rated_mva": 3, "power_factor": 0.8, "voltage_kv": 11,
                                   "dispatch_mode": "must_run", "voltage_setpoint_pu": 1.0})]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c", "from"),
             ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in"), ("g", "out", "B", "at_2")]
    res = run_load_flow(_project(comps, links))
    assert res.buses["B"].voltage_pu == pytest.approx(1.0, abs=1e-6)
    assert not any("labelled PV" in w.message for w in res.warnings)


# ── H4: slack generator badge keeps its solved reactive output ────────────

def test_h4_island_generator_badge_uses_solved_q():
    comps = [_c("g", "generator", {"rated_mva": 1.0, "power_factor": 0.85, "voltage_kv": 0.4}),
             _bus("A", 0.4), _load("L", 600, 0.6)]
    res = run_load_flow(_project(comps, [("g", "out", "A", "at_0"), ("A", "at_1", "L", "in")]))
    d = next(x for x in res.dispatch if x.source_id == "g")
    b = _branch(res, "g")
    assert b.q_mvar == pytest.approx(d.dispatched_mvar, abs=1e-4)
    assert b.q_mvar == pytest.approx(0.48, abs=1e-3)          # 600 kVA × sin(acos 0.6)
    assert b.loading_pct == pytest.approx(60.0, abs=0.1)      # was 42.35 %


# ── H5: cable tee without a bus ────────────────────────────────────────────

def _tee():
    comps = [_util(11), _bus("A", 11), _bus("B", 11), _bus("C", 11),
             _cable("c1", 11, 0.2, 0.1, 2, 300), _cable("c2", 11, 0.2, 0.1, 2, 300),
             _cable("c3", 11, 0.2, 0.1, 2, 300), _load("LB", 1000, 0.9), _load("LC", 1000, 0.9)]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c1", "from"),
             ("c1", "to", "c2", "from"), ("c1", "to", "c3", "from"),
             ("c2", "to", "B", "at_0"), ("c3", "to", "C", "at_0"),
             ("B", "at_1", "LB", "in"), ("C", "at_1", "LC", "in")]
    return comps, links


def test_h5_tee_matches_explicit_junction_bus():
    comps, links = _tee()
    res = run_load_flow(_project(comps, links))
    comps.append(_bus("J", 11))
    ref_links = [l for l in links if l[:2] != ("c1", "to")] + [
        ("c1", "to", "J", "at_0"), ("J", "at_1", "c2", "from"), ("J", "at_2", "c3", "from")]
    ref = run_load_flow(_project(comps, ref_links))
    for bid in ("B", "C"):
        assert res.buses[bid].voltage_pu == pytest.approx(ref.buses[bid].voltage_pu, abs=1e-6)
    rows = [b for b in res.branches if b.elementId == "c1"]
    assert len(rows) == 1                                     # was two half-flow rows
    assert rows[0].s_mva == pytest.approx(_branch(ref, "c1").s_mva, abs=1e-4)


def test_h5_junction_pass_leaves_breaker_nodes_alone():
    comps = [_bus("A", 11), _c("cb", "cb", {"state": "open"}),
             _cable("c1", 11, 0.2, 0.1, 1), _cable("c2", 11, 0.2, 0.1, 1)]
    proj = _project(comps, [("c1", "to", "cb", "in"), ("c2", "from", "cb", "in"),
                            ("A", "at_0", "c1", "from")])
    assert insert_junction_buses(proj) is proj


# ── M1: branch current at the solved voltage ──────────────────────────────

def test_m1_cable_current_uses_actual_voltage():
    comps = [_util(0.4), _bus("A", 0.4), _cable("c0", 0.4, 0.32, 0.08, 0.2),
             _bus("M", 0.4), _cable("c", 0.4, 0.32, 0.08, 0.05, 300), _bus("B", 0.4),
             _load("L", 180, 0.9)]
    res = run_load_flow(_project(comps, [
        ("u", "out", "A", "at_0"), ("A", "at_1", "c0", "from"), ("c0", "to", "M", "at_0"),
        ("M", "at_1", "c", "from"), ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]))
    b = _branch(res, "c")
    v_m = res.buses["M"].voltage_pu
    true_i = b.s_mva * 1000 / (math.sqrt(3) * 0.4 * v_m)
    assert v_m < 0.95
    assert b.i_amps == pytest.approx(true_i, rel=1e-3)        # was ~8 % low
    assert b.loading_pct == pytest.approx(true_i / 300 * 100, rel=1e-3)


# ── M2: PV output never exceeds its AC nameplate ──────────────────────────

def test_m2_pv_rated_mode_is_ac_nameplate():
    pv = _c("pv", "solar_pv", {"rated_kw": 100, "num_inverters": 2, "inverter_eff": 0.97,
                               "power_factor": 1.0, "irradiance_pct": 100})
    p, _q, s, rated = _source_output_mva(pv)
    assert p == pytest.approx(0.2) and rated == pytest.approx(0.2)   # was 0.2062


def test_m2_pv_array_mode_applies_efficiency_then_clips():
    props = {"rated_kw": 100, "num_inverters": 1, "inverter_eff": 0.97, "power_factor": 1.0,
             "irradiance_pct": 100, "pv_array_mode": "array", "pv_panel_w": 500,
             "pv_panels_per_string": 10, "pv_strings": 10}          # 50 kW DC
    p, *_ = _source_output_mva(_c("pv", "solar_pv", props))
    assert p * 1000 == pytest.approx(50 * 0.97)                     # DC × η, not ÷ η
    props["pv_strings"] = 30                                         # 150 kW DC → clips
    p, *_ = _source_output_mva(_c("pv", "solar_pv", props))
    assert p * 1000 == pytest.approx(100.0)


# ── M3: transformer impedance re-based when nameplate ≠ bus voltage ───────

def _xfmr_net(bus_lv_kv):
    comps = [_util(11), _bus("A", 11), _xfmr(lv=0.42), _bus("B", bus_lv_kv),
             _load("L", 1000, 0.85)]
    return run_load_flow(_project(comps, [
        ("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
        ("t", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")]))


def test_m3_nameplate_mismatch_gives_same_physical_voltage():
    # The same 11/0.42 kV unit feeding the same load: the LV bus kV must not
    # depend on whether the bus is drawn at 0.42 or 0.40 kV (it was 0.4030 vs
    # 0.4047 kV — the 0.40 drawing carried ~10 % too little impedance).
    assert _xfmr_net(0.40).buses["B"].voltage_kv == pytest.approx(
        _xfmr_net(0.42).buses["B"].voltage_kv, abs=2e-4)


# ── M4 / L4: tap changer limits ──────────────────────────────────────────

def _oltc_net(**tap):
    comps = [_util(11), _bus("b1", 11),
             _xfmr(tap_mode="regulating", v_target_pu=1.0, tap_step_pct=1.25, **tap),
             _bus("b2", 0.4), _load("L", 800, 0.85)]
    return _project(comps, [("u", "out", "b1", "at_0"), ("b1", "at_1", "t", "primary"),
                            ("t", "secondary", "b2", "at_0"), ("b2", "at_1", "L", "in")])


def test_m4_zero_tap_limit_is_honoured():
    proj = _oltc_net(tap_percent=0, tap_min_pct=0, tap_max_pct=10)
    warnings = []
    work = _run_oltc(proj, "newton_raphson",
                     [c for c in proj.components if c.id == "t"], warnings=warnings)
    assert next(c for c in work.components if c.id == "t").props["tap_percent"] >= 0
    assert any("tap limit" in w.message for w in warnings)      # can't reach target


def test_l4_oltc_traverses_full_range():
    # From +10 % the changer needs 16 steps of 1.25 % to reach −10 %; the old
    # fixed 12-pass budget stopped part-way with no warning.
    # A 1.08 p.u. target needs roughly −8.75 % or lower (15+ steps from +10 %).
    proj = _oltc_net(tap_percent=10, tap_min_pct=-10, tap_max_pct=10)
    t = next(c for c in proj.components if c.id == "t")
    t.props["v_target_pu"] = 1.08
    work = _run_oltc(proj, "newton_raphson", [t])
    assert next(c for c in work.components if c.id == "t").props["tap_percent"] <= -8.75


# ── M5: Gauss-Seidel with a bus coupler ──────────────────────────────────

def test_m5_gauss_seidel_converges_through_bus_link_and_matches_nr():
    comps = [_util(11), _bus("b0", 11)]
    links = [("u", "out", "b0", "at_0")]
    for k in range(1, 6):
        comps += [_cable(f"c{k}", 11, 0.2, 0.1, 1), _bus(f"b{k}", 11), _load(f"L{k}", 800, 0.9)]
        links += [(f"b{k-1}", "at_1", f"c{k}", "from"), (f"c{k}", "to", f"b{k}", "at_0"),
                  (f"b{k}", "at_2", f"L{k}", "in")]
    comps += [_c("cb", "cb", {"state": "closed"}), _bus("bx", 11), _load("Lx", 500, 0.9)]
    links += [("b5", "at_3", "cb", "in"), ("cb", "out", "bx", "at_0"), ("bx", "at_1", "Lx", "in")]
    proj = _project(comps, links)
    gs = run_load_flow(proj, method="gauss_seidel")
    nr = run_load_flow(proj, method="newton_raphson")
    assert gs.converged                                         # stalled at 100 before
    assert gs.buses["bx"].voltage_pu == pytest.approx(nr.buses["bx"].voltage_pu, abs=1e-4)
    link_gs = next(b for b in gs.branches if b.element_name == "Bus Link")
    link_nr = next(b for b in nr.branches if b.element_name == "Bus Link")
    assert link_gs.p_mw == pytest.approx(link_nr.p_mw, abs=1e-3)   # 0.45 MW, not 0
    assert link_gs.p_mw == pytest.approx(0.45, abs=1e-3)


# ── L1: standby set not started for a shortfall a battery already covers ──

def test_l1_standby_accounts_for_discharging_battery():
    comps = [_c("u", "utility", {"voltage_kv": 0.4, "fault_mva": 50, "supply_capacity_mva": 1.0}),
             _bus("A", 0.4),
             _c("g", "generator", {"rated_mva": 1.0, "power_factor": 0.8, "voltage_kv": 0.4,
                                   "dispatch_mode": "standby"}),
             _c("bt", "battery", {"battery_kwh": 1000, "rated_kva": 300,
                                  "battery_mode": "discharging", "battery_soc_pct": 100,
                                  "battery_max_discharge_kw": 300, "battery_max_charge_kw": 300,
                                  "var_mode": "unity"}),
             _load("L", 1200, 1.0)]
    res = run_load_flow(_project(comps, [("u", "out", "A", "at_0"), ("g", "out", "A", "at_1"),
                                         ("bt", "out", "A", "at_2"), ("A", "at_3", "L", "in")]))
    g = next(d for d in res.dispatch if d.source_id == "g")
    assert g.role == "standby" and g.dispatched_mw == 0.0      # was started at 240 kW


# ── L2: islanded reference generator holds its own setpoint ───────────────

def test_l2_island_generator_setpoint_on_pq_bus():
    comps = [_c("g", "generator", {"rated_mva": 1.0, "power_factor": 0.85, "voltage_kv": 0.4,
                                   "voltage_setpoint_pu": 1.05}),
             _bus("A", 0.4), _load("L", 300, 0.9)]
    res = run_load_flow(_project(comps, [("g", "out", "A", "at_0"), ("A", "at_1", "L", "in")]))
    assert res.buses["A"].voltage_pu == pytest.approx(1.05, abs=1e-6)


def test_l2_utility_setpoint_still_wins_on_its_bus():
    comps = [_util(0.4, v_setpoint_pu=1.02), _bus("A", 0.4),
             _c("g", "generator", {"rated_mva": 1.0, "power_factor": 0.85, "voltage_kv": 0.4,
                                   "voltage_setpoint_pu": 1.05, "dispatch_mode": "must_run"}),
             _load("L", 300, 0.9)]
    res = run_load_flow(_project(comps, [("u", "out", "A", "at_0"), ("g", "out", "A", "at_1"),
                                         ("A", "at_2", "L", "in")]))
    assert res.buses["A"].voltage_pu == pytest.approx(1.02, abs=1e-6)


# ── L5: bus duct on a bus-section link gets a loading row ─────────────────

def test_l5_bus_duct_loading_reported():
    comps = [_util(0.4), _bus("S1", 0.4), _bus("S2", 0.4),
             _c("bd", "bus_duct", {"name": "BD", "rated_current_a": 800, "length_m": 2}),
             _load("L", 500, 0.9)]
    res = run_load_flow(_project(comps, [("u", "out", "S1", "at_0"), ("S1", "at_1", "bd", "from"),
                                         ("bd", "to", "S2", "at_0"), ("S2", "at_1", "L", "in")]))
    b = _branch(res, "bd")
    expected_i = 500 / (math.sqrt(3) * 0.4 * res.buses["S1"].voltage_pu)
    assert b.i_amps == pytest.approx(expected_i, rel=1e-3)
    assert b.loading_pct == pytest.approx(expected_i / 800 * 100, rel=1e-3)
