"""End-to-end smoke test: every analysis engine runs without crashing on a
representative radial network (utility → CB → transformer → cable → motor/load).

Catches runtime regressions (wrong prop keys, broken imports, shape changes)
that the hand-calculation tests in test_regression.py don't exercise.
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire


def _comp(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _wire(wid, from_c, to_c):
    return Wire(id=wid, fromComponent=from_c, fromPort="bottom",
                toComponent=to_c, toPort="top")


@pytest.fixture()
def project():
    return ProjectData(
        projectName="smoke", baseMVA=100.0, frequency=50,
        components=[
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11, "fault_mva": 500,
                "x_r_ratio": 15, "z0_z1_ratio": 1.0,
            }),
            _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11}),
            _comp("cb-1", "cb", {
                "name": "CB1", "breaking_capacity_ka": 31.5,
                "rated_current_a": 1250, "state": "closed",
            }),
            _comp("transformer-1", "transformer", {
                "name": "TX1", "rated_mva": 2.0, "z_percent": 6.0,
                "x_r_ratio": 10, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                "vector_group": "Dyn11", "grounding_lv": "solid",
            }),
            _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4}),
            _comp("cable-1", "cable", {
                "name": "C1", "length_km": 0.05, "r_per_km": 0.32,
                "x_per_km": 0.08, "rated_amps": 200, "voltage_kv": 0.4,
                "size_mm2": 95, "material": "copper", "insulation": "XLPE",
            }),
            _comp("bus-3", "bus", {"name": "MCC Bus", "voltage_kv": 0.4}),
            _comp("motor_induction-1", "motor_induction", {
                "name": "M1", "rated_kw": 110, "voltage_kv": 0.4,
                "efficiency": 0.94, "power_factor": 0.86,
                "locked_rotor_current": 6.5, "x_r_ratio": 2.4,
            }),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kw": 150, "power_factor": 0.9,
                "voltage_kv": 0.4,
            }),
        ],
        wires=[
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "cb-1"),
            _wire("w3", "cb-1", "transformer-1"),
            _wire("w4", "transformer-1", "bus-2"),
            _wire("w5", "bus-2", "cable-1"),
            _wire("w6", "cable-1", "bus-3"),
            _wire("w7", "bus-3", "motor_induction-1"),
            _wire("w8", "bus-3", "static_load-1"),
        ],
    )


def test_fault_analysis(project):
    from backend.analysis.fault import run_fault_analysis
    res = run_fault_analysis(project)
    assert set(res.buses) == {"bus-1", "bus-2", "bus-3"}
    for bus in res.buses.values():
        assert bus.ik3 > 0
        assert bus.ik1 is not None


def test_load_flow_both_methods(project):
    from backend.analysis.loadflow import run_load_flow
    for method in ("newton_raphson", "gauss_seidel"):
        res = run_load_flow(project, method)
        assert res.converged, f"{method} did not converge"


def test_unbalanced_load_flow(project):
    from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow
    res = run_unbalanced_load_flow(project)
    for bus in res.buses.values():
        assert bus.va_pu > 0.8


def test_arc_flash(project):
    from backend.analysis.fault import run_fault_analysis
    from backend.analysis.arcflash import run_arc_flash
    res = run_arc_flash(project, run_fault_analysis(project))
    assert res.method == "IEEE 1584-2002"
    for bus in res.buses.values():
        assert bus.incident_energy_cal > 0


def test_cable_sizing(project):
    from backend.analysis.cable_sizing import run_cable_sizing
    res = run_cable_sizing(project)
    assert res["cables"], "no cable results"
    assert res["cables"][0]["status"] in ("pass", "warning", "fail", "unknown")


def test_motor_starting(project):
    from backend.analysis.motor_starting import run_motor_starting
    res = run_motor_starting(project)
    assert res["motors"], f"no motor results: {res['warnings']}"
    assert res["motors"][0]["max_system_dip_pct"] > 0


def test_duty_check(project):
    from backend.analysis.duty_check import run_duty_check
    run_duty_check(project)


def test_load_diversity(project):
    from backend.analysis.load_diversity import run_load_diversity
    run_load_diversity(project)


def test_grounding(project):
    from backend.analysis.grounding_system import run_grounding_analysis
    run_grounding_analysis(project)


def test_ring_network_terminates(project):
    """F1 guard: a meshed/ring network must not hang the fault DFS.

    Builds a 6-bus ring of cables with the utility on one bus; the per-path
    DFS must finish quickly (node-expansion budget) and still find paths.
    """
    comps = [
        _comp("utility-1", "utility", {
            "name": "Grid", "voltage_kv": 11, "fault_mva": 500,
            "x_r_ratio": 15, "z0_z1_ratio": 1.0,
        }),
    ]
    wires = [_wire("wu", "utility-1", "ring-bus-0")]
    n = 6
    for i in range(n):
        comps.append(_comp(f"ring-bus-{i}", "bus",
                           {"name": f"RB{i}", "voltage_kv": 11}))
        comps.append(_comp(f"ring-cable-{i}", "cable", {
            "name": f"RC{i}", "length_km": 0.5, "r_per_km": 0.2,
            "x_per_km": 0.1, "rated_amps": 300, "voltage_kv": 11,
        }))
        wires.append(_wire(f"wa{i}", f"ring-bus-{i}", f"ring-cable-{i}"))
        wires.append(_wire(f"wb{i}", f"ring-cable-{i}", f"ring-bus-{(i + 1) % n}"))
    # Cross-ties to make it meshed, not just a single ring
    for i in range(0, n, 2):
        comps.append(_comp(f"tie-cable-{i}", "cable", {
            "name": f"TC{i}", "length_km": 0.3, "r_per_km": 0.2,
            "x_per_km": 0.1, "rated_amps": 300, "voltage_kv": 11,
        }))
        wires.append(_wire(f"wt{i}a", f"ring-bus-{i}", f"tie-cable-{i}"))
        wires.append(_wire(f"wt{i}b", f"tie-cable-{i}", f"ring-bus-{(i + 3) % n}"))

    proj = ProjectData(projectName="ring", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)

    from backend.analysis.fault import run_fault_analysis
    res = run_fault_analysis(proj)
    assert all(b.ik3 > 0 for b in res.buses.values())
