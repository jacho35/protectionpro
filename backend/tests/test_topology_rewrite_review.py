"""Changeover / off-page rewrite review (reviews/TOPOLOGY_REWRITES_REVIEW.md):
the rewritten network must solve exactly like the same network drawn with a
plain wire to the selected source."""
import pytest

from backend.analysis.changeover import expand_changeovers
from backend.analysis.offpage import expand_offpage_links
from backend.analysis.loadflow import run_load_flow
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire

KV = 11.0


def _sources():
    return [
        _comp("utility-1", "utility", {"name": "Grid A", "voltage_kv": KV,
                                       "fault_mva": 400.0, "v_setpoint_pu": 1.02}),
        _comp("utility-2", "utility", {"name": "Grid B", "voltage_kv": KV,
                                       "fault_mva": 150.0, "v_setpoint_pu": 0.98}),
    ]


def _load_side():
    return [
        _comp("bus-1", "bus", {"name": "LP", "voltage_kv": KV}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": 3000.0,
              "power_factor": 0.9, "demand_factor": 1.0, "voltage_kv": KV}),
    ]


def _with_changeover(state):
    comps = _sources() + [_comp("co-1", "changeover", {
        "name": "ATS", "state": state, "co_type": "ats", "voltage_kv": KV})] + _load_side()
    wires = [_wire("w1", "utility-1", "co-1", "out", "in_1"),
             _wire("w2", "utility-2", "co-1", "out", "in_2"),
             _wire("w3", "co-1", "bus-1", "out", "at_0"),
             _wire("w4", "bus-1", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _plain(which):
    comps = _sources() + _load_side()
    wires = [_wire("w1", which, "bus-1", "out", "at_0"), _wire("w4", "bus-1", "load-1")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _v(p):
    r = run_load_flow(p, "newton_raphson")
    return r.converged, r.buses["bus-1"].voltage_pu, r.buses["bus-1"].energized


@pytest.mark.parametrize("state,src", [("in_1", "utility-1"), ("in_2", "utility-2")])
def test_changeover_follows_the_blade(state, src):
    conv, v, en = _v(expand_changeovers(_with_changeover(state)))
    c0, v0, e0 = _v(_plain(src))
    assert conv and c0 and en and e0
    assert v == pytest.approx(v0, abs=1e-6)


def test_changeover_off_is_dead():
    conv, v, en = _v(expand_changeovers(_with_changeover("off")))
    assert not en


def test_offpage_pair_is_a_zero_impedance_wire():
    """Utility -> connector A ... connector B -> bus, paired by link."""
    comps = [_sources()[0],
             _comp("op-a", "offpage_connector", {"name": "X1", "linked_to": "op-b"}),
             _comp("op-b", "offpage_connector", {"name": "X1", "linked_to": "op-a"})] + _load_side()
    wires = [_wire("w1", "utility-1", "op-a", "out", "port"),
             _wire("w2", "op-b", "bus-1", "port", "at_0"),
             _wire("w4", "bus-1", "load-1")]
    p = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                    components=comps, wires=wires)
    conv, v, en = _v(expand_offpage_links(p))
    c0, v0, e0 = _v(_plain("utility-1"))
    assert conv and en
    assert v == pytest.approx(v0, abs=1e-6)
    # an unlinked connector pair of different names is a dead end
    comps[1].props["linked_to"] = ""
    comps[2].props["linked_to"] = ""
    comps[2].props["name"] = "Y9"
    assert not _v(expand_offpage_links(p))[2]
