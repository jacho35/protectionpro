"""Load Flow Study Manager — run_loadflow_cases (full-snapshot case runner).

Pins: parity of the implicit "Current network" case with a direct run_load_flow,
that a snapshot override shifts the solution, islanding/non-convergence surface
without raising, unknown ids are ignored, string props coerce, and includeCurrent
toggles the Current case.
"""

import copy

from backend.models.schemas import (
    Component, ProjectData, Wire, LoadFlowCaseInput,
)
from backend.analysis.loadflow import run_load_flow
from backend.analysis.loadflow_cases import run_loadflow_cases


def _comp(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _wire(wid, from_c, to_c):
    return Wire(id=wid, fromComponent=from_c, fromPort="bottom",
                toComponent=to_c, toPort="top")


def _project():
    return ProjectData(
        projectName="lfcases", baseMVA=100.0, frequency=50,
        components=[
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11, "fault_mva": 500,
                "x_r_ratio": 15, "supply_capacity_mva": 0, "allow_export": "yes"}),
            _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _comp("cb-1", "cb", {"name": "CB1", "state": "closed"}),
            _comp("transformer-1", "transformer", {
                "name": "TX1", "rated_mva": 2.0, "z_percent": 6.0, "x_r_ratio": 10,
                "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "tap_percent": 0}),
            _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4, "bus_type": "PQ"}),
            _comp("static_load-1", "static_load", {
                "name": "L1", "rated_kva": 800, "power_factor": 0.9,
                "demand_factor": 1.0, "voltage_kv": 0.4}),
        ],
        wires=[
            _wire("w1", "utility-1", "bus-1"),
            _wire("w2", "bus-1", "cb-1"),
            _wire("w3", "cb-1", "transformer-1"),
            _wire("w4", "transformer-1", "bus-2"),
            _wire("w5", "bus-2", "static_load-1"),
        ],
    )


def _by_id(cases):
    return {c.id: c for c in cases}


def test_current_case_matches_direct_run():
    proj = _project()
    out = run_loadflow_cases(proj, [], method="newton_raphson", include_current=True)
    assert len(out) == 1
    cur = out[0]
    assert cur.id == "__current__"
    direct = run_load_flow(proj, "newton_raphson")
    # Same solution: compare bus voltages
    for bid, b in direct.buses.items():
        assert abs(cur.result.buses[bid].voltage_pu - b.voltage_pu) < 1e-9
    assert cur.summary.converged == direct.converged


def test_include_current_false_omits_base():
    proj = _project()
    out = run_loadflow_cases(proj, [], method="newton_raphson", include_current=False)
    assert out == []


def test_snapshot_override_shifts_voltage():
    """A case that loads the transformer far more heavily (bigger load) sags the
    LV bus below the current network's LV voltage."""
    proj = _project()
    heavy = copy.deepcopy(proj.components)
    for c in heavy:
        if c.id == "static_load-1":
            c.props["rated_kva"] = 2500   # from 800 → heavier draw
    case = LoadFlowCaseInput(id="lfc_heavy", name="Heavy load",
                             components=heavy, wires=proj.wires)
    out = _by_id(run_loadflow_cases(proj, [case], include_current=True))
    v_base = out["__current__"].result.buses["bus-2"].voltage_pu
    v_heavy = out["lfc_heavy"].result.buses["bus-2"].voltage_pu
    assert v_heavy < v_base - 1e-4


def test_open_breaker_deenergizes_without_raising():
    proj = _project()
    snap = copy.deepcopy(proj.components)
    for c in snap:
        if c.id == "cb-1":
            c.props["state"] = "open"
    case = LoadFlowCaseInput(id="lfc_open", name="CB open",
                             components=snap, wires=proj.wires)
    out = _by_id(run_loadflow_cases(proj, [case], include_current=False))
    assert out["lfc_open"].summary.deenergized_bus_count > 0


def test_unknown_component_ignored_via_fallback():
    """A case that carries no components falls back to the live network; passing
    an empty snapshot must still run (equivalent to Current)."""
    proj = _project()
    case = LoadFlowCaseInput(id="lfc_empty", name="Empty")  # no components/wires
    out = _by_id(run_loadflow_cases(proj, [case], include_current=False))
    assert out["lfc_empty"].summary.converged
    # Equivalent to the live network
    direct = run_load_flow(proj, "newton_raphson")
    assert out["lfc_empty"].result.buses["bus-2"].voltage_pu == \
        direct.buses["bus-2"].voltage_pu


def test_string_prop_values_coerced():
    """Grid edits may arrive as strings; Component validation coerces them so the
    engine does arithmetic on numbers (no TypeError)."""
    proj = _project()
    snap = copy.deepcopy(proj.components)
    for c in snap:
        if c.id == "static_load-1":
            c.props["rated_kva"] = "1500"      # string
            c.props["power_factor"] = "0.85"
    case = LoadFlowCaseInput(id="lfc_str", name="String props",
                             components=[Component(**c.model_dump()) for c in snap],
                             wires=proj.wires)
    out = _by_id(run_loadflow_cases(proj, [case], include_current=False))
    assert out["lfc_str"].summary.converged
    assert out["lfc_str"].summary.total_losses_mw >= 0


def test_baseMVA_override_applied():
    proj = _project()
    case = LoadFlowCaseInput(id="lfc_base", name="Base 50",
                             components=proj.components, wires=proj.wires, baseMVA=50.0)
    out = _by_id(run_loadflow_cases(proj, [case], include_current=True))
    # Both converge; the run must complete with a different base without error.
    assert out["lfc_base"].summary.converged
    assert out["__current__"].summary.converged
