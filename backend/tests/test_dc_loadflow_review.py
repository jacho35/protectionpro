"""DC load flow review (reviews/DC_LOADFLOW_REVIEW.md). Hand references:
constant-power load on a Thevenin source behind a loop cable,
V2 = (E + sqrt(E^2 - 4 P R)) / 2; constant-I and constant-R closed forms;
KCL at the bus."""
import math
import pytest

from backend.analysis.dc_loadflow import run_dc_load_flow
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire

E = 125.0
RS = 0.01 * E / (50e3 / E)          # 1 % regulation at 400 A rated
R_LOOP = 2 * 0.05 * 0.1


def _net(load_kw=10.0, model="constant_power", battery=False):
    comps = [
        _comp("bus-1", "bus", {"name": "DC1", "system": "dc", "voltage_dc_v": E}),
        _comp("rect-1", "rectifier", {"name": "R", "voltage_dc_v": E,
                                      "rated_kw": 50.0}),
        _comp("cable-1", "cable", {"name": "C", "r_per_km": 0.05,
                                   "length_km": 0.1, "rated_amps": 1000}),
        _comp("bus-2", "bus", {"name": "DC2", "system": "dc", "voltage_dc_v": E}),
        _comp("dcload-1", "dc_load", {"name": "L", "load_kw": load_kw,
                                      "load_model": model, "load_a": 80.0,
                                      "resistance_ohm": 1.5}),
    ]
    wires = [_wire("w1", "rect-1", "bus-1"), _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2"), _wire("w4", "bus-2", "dcload-1")]
    if battery:
        comps.append(_comp("batt-1", "dc_battery", {
            "name": "BAT", "nominal_v": E, "ah_capacity": 200.0,
            "internal_r_mohm": 20.0}))
        wires.append(_wire("w5", "batt-1", "bus-1"))
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


@pytest.mark.parametrize("p_kw", [10.0, 40.0])
def test_constant_power_closed_form(p_kw):
    v2 = (E + math.sqrt(E * E - 4 * p_kw * 1000 * (RS + R_LOOP))) / 2
    r = run_dc_load_flow(_net(p_kw))
    assert r.converged
    assert r.buses["bus-2"].voltage_v == pytest.approx(v2, abs=0.01)
    assert r.sources[0].current_a == pytest.approx(p_kw * 1000 / v2, abs=0.01)


def test_constant_current_and_resistance():
    r = run_dc_load_flow(_net(model="constant_current"))
    assert r.buses["bus-2"].voltage_v == pytest.approx(E - 80 * (RS + R_LOOP), abs=0.01)
    r = run_dc_load_flow(_net(model="constant_resistance"))
    assert r.buses["bus-2"].voltage_v == pytest.approx(
        E * 1.5 / (1.5 + RS + R_LOOP), abs=0.01)


def test_battery_takes_over_when_the_converter_is_limited():
    """[DC2] 70 kW on a 50 kW rectifier: the rectifier clamps at 400 A and the
    battery supplies the rest; KCL closes at the load bus."""
    r = run_dc_load_flow(_net(70.0, battery=True))
    assert r.converged
    src = {s.source_type: s for s in r.sources}
    assert src["rectifier"].current_limited
    assert src["rectifier"].current_a == pytest.approx(400.0, abs=0.01)
    assert src["dc_battery"].current_a > 100.0
    v2 = r.buses["bus-2"].voltage_v
    assert src["rectifier"].current_a + src["dc_battery"].current_a == pytest.approx(
        70000.0 / v2, abs=0.5)


def test_overloaded_sole_converter_collapses_instead_of_lying():
    """[DC1] The singular system used to be swallowed and reported converged
    with 595 A of load on 400 A of supply."""
    r = run_dc_load_flow(_net(70.0))
    assert not r.converged
    assert not r.buses["bus-2"].energized
    assert any("cannot be supplied" in w.message for w in r.warnings)
