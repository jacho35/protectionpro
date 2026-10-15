"""PDF report review (reviews/PDF_REPORTS_REVIEW.md): the numbers in the
tables are the engine's, in the right columns, and the report survives the
characters the engines emit."""
import dataclasses
import pytest

import backend.analysis.pdf_reports as pr
from backend.analysis.arcflash import run_arc_flash
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.models.schemas import ProjectData
from backend.tests.test_regression import _comp, _wire


def _proj():
    comps = [
        _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": 11.0,
              "fault_mva": 250.0, "x_r_ratio": 8.0}),
        _comp("bus-1", "bus", {"name": "HV Bus", "voltage_kv": 11.0}),
        _comp("transformer-1", "transformer", {
            "name": "TX1", "rated_mva": 1.0, "voltage_hv_kv": 11.0,
            "voltage_lv_kv": 0.4, "z_percent": 5.0, "x_r_ratio": 6.0,
            "vector_group": "Dyn11"}),
        _comp("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4}),
        _comp("cable-1", "cable", {"name": "CAB", "voltage_kv": 0.4,
              "r_per_km": 0.15, "x_per_km": 0.08, "length_km": 0.15,
              "rated_amps": 400}),
        _comp("bus-3", "bus", {"name": "Sub Bus", "voltage_kv": 0.4}),
        _comp("load-1", "static_load", {"name": "L", "rated_kva": 400.0,
              "power_factor": 0.9, "demand_factor": 1.0, "voltage_kv": 0.4}),
    ]
    wires = [_wire("w1", "utility-1", "bus-1"), _wire("w2", "bus-1", "transformer-1"),
             _wire("w3", "transformer-1", "bus-2"), _wire("w4", "bus-2", "cable-1"),
             _wire("w5", "cable-1", "bus-3"), _wire("w6", "bus-3", "load-1")]
    return ProjectData(projectName="T", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _dump(r):
    return r.model_dump() if hasattr(r, "model_dump") else dataclasses.asdict(r)


@pytest.fixture(scope="module")
def results():
    p = _proj()
    fr = run_fault_analysis(p, fault_bus_id=None, fault_type=None)
    lf = run_load_flow(p, "newton_raphson")
    af = run_arc_flash(p, fr)
    return p, _dump(fr), _dump(lf), _dump(af)


def test_report_builds_with_the_engines_own_assumptions_text(results):
    """[PR1] An em dash in the study assumptions crashed multi_cell()."""
    p, fr, lf, af = results
    assert fr.get("study_assumptions")
    buf = pr.generate_full_report("T", 100.0, 50, fr, lf, af,
                                  [c.model_dump() for c in p.components])
    assert buf.read(5) == b"%PDF-"


def test_unicode_assumptions_keep_their_letters():
    """[PR2] cp1252 'replace' turned lambda into '?'."""
    assert "lambda" in pr._pdf_safe("λ_max from Eq. 88")
    assert "?" not in pr._pdf_safe("κ and μ and —")


def test_table_columns_hold_the_engines_numbers(results, monkeypatch):
    p, fr, lf, af = results
    captured = []
    monkeypatch.setattr(pr, "_table",
                        lambda pdf, headers, rows, *a, **k: captured.append((headers, rows)))
    pr.generate_full_report("T", 100.0, 50, fr, lf, af,
                            [c.model_dump() for c in p.components],
                            sections=["fault", "loadflow_bus", "loadflow_branch"])
    by_head = {tuple(h)[:3]: rows for h, rows in captured}
    fault = next(rows for h, rows in captured if h[2].startswith('I"k3'))
    for row in fault:
        b = next(x for x in fr["buses"].values() if x["bus_name"] == row[0])
        assert float(row[2]) == pytest.approx(b["ik3"], abs=5e-4)
        assert float(row[3]) == pytest.approx(b["ip"], abs=5e-4)
    lfrows = next(rows for h, rows in captured if h[1] == "V (p.u.)")
    for row in lfrows:
        b = next(x for x in lf["buses"].values() if x["bus_name"] == row[0])
        assert float(row[1]) == pytest.approx(b["voltage_pu"], abs=5e-5)
        assert float(row[4]) == pytest.approx(b["p_mw"], abs=5e-5)
    br = next(rows for h, rows in captured if h[0] == "Element")
    assert not any("bus-" in r[1] or "bus-" in r[2] for r in br)   # names, not ids
