"""Study Manager review (reviews/STUDY_MANAGER_REVIEW.md): each batch study
equals its standalone call with the same settings."""
import pytest

from backend.analysis.fault import run_fault_analysis
from backend.analysis.study_manager import (
    run_study_manager, _extract_study_status)
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _proj(**extra):
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
                                       "fault_mva": 300.0, "x_r_ratio": 8.0}),
        _comp("bus-1", "bus", {"name": "B1", "voltage_kv": 11.0}),
        _comp("cable-1", "cable", {"name": "C", "voltage_kv": 11.0,
                                   "r_per_km": 0.3, "x_per_km": 0.1,
                                   "length_km": 3.0, "rated_amps": 400}),
        _comp("bus-2", "bus", {"name": "B2", "voltage_kv": 11.0}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "cable-1"),
             _wire("w3", "cable-1", "bus-2")]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires, **extra)


def _ik3(res, bus="bus-2"):
    b = res["buses"][bus] if isinstance(res, dict) else res.buses[bus]
    return b["ik3"] if isinstance(b, dict) else b.ik3


def test_batch_fault_honours_the_projects_study_settings():
    """[SM1] voltage factor 0.95 (c_min) and a 250 degC conductor study."""
    p = _proj(voltageFactor=0.95, conductorTemperatureC=250.0)
    standalone = run_fault_analysis(p, fault_bus_id=None, fault_type=p.faultType,
                                    voltage_factor=0.95,
                                    conductor_temperature_c=250.0)
    batch = run_study_manager(p, enabled_studies=["fault"])
    got = _ik3(batch["studies"]["fault"]["result"])
    assert got == pytest.approx(_ik3(standalone), rel=1e-9)
    # and it differs from the unconfigured (c_max, 20 degC) study
    plain = run_fault_analysis(p, fault_bus_id=None, fault_type=None)
    assert abs(_ik3(plain) - got) > 1e-6


def test_failing_ct_or_vt_fails_the_duty_batch_status():
    """[SM2] ct_checks / pt_checks were not counted."""
    base = {"devices": [{"status": "pass"}], "transformers": []}
    assert _extract_study_status("duty_check", base)["status"] == "pass"
    bad_ct = dict(base, ct_checks=[{"status": "fail"}], pt_checks=[])
    assert _extract_study_status("duty_check", bad_ct)["status"] == "fail"
    warn_pt = dict(base, ct_checks=[], pt_checks=[{"status": "warning"}])
    assert _extract_study_status("duty_check", warn_pt)["status"] == "warning"
