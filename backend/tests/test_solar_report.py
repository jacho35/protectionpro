"""Solar PV report PDF: builds from a solar-size result, prints the attribution and the reference check, rejects a missing result."""
import gzip
import json
import os

import pytest

from backend.analysis import pvgis_tmy, solar_pv as sp
from backend.analysis.solar_report import generate_solar_report

TMY = os.path.join(os.path.dirname(__file__), "..", "..", "testing", "solar", "tmy", "tmy_-26.20_28.04.json.gz")


@pytest.fixture(autouse=True)
def _site(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "get_tmy", lambda la, lo: json.load(gzip.open(TMY, "rt")))


def _text(buf):
    from pypdf import PdfReader
    return " ".join(p.extract_text() for p in PdfReader(buf).pages)


def _res(source="pvgis"):
    return sp.run_solar_size({"location": "Johannesburg", "module": "pv_550_mono", "inverter": "inv_10k_2mppt", "mode": "kwp",
                              "target_kwp": 12, "tilt_deg": 30, "azimuth_deg": 0, "irradiance_source": source})


def test_report_has_every_section_and_the_pvgis_attribution():
    buf = generate_solar_report("Test project", {
        "inputs": {"location": "Johannesburg", "module": "550 W Mono PERC", "inverter": "10 kW", "perString": 8},
        "result": _res(),
        "strings": {"strings": 3, "items": [{"status": "pass", "message": "String Voc at -5C: 400 V vs 1000 V"}]},
        "protection": {"items": [{"ok": True, "label": "String fuse 15 A"}], "export_note": "Export limited"},
        "shading": {"loss_pct": 3.2, "unshaded_kwh": 100, "shaded_kwh": 97, "months": [{"month": m, "loss_pct": 1.0} for m in range(1, 13)],
                    "strings": [{"array": "A", "string": 1, "modules": 8, "kwp": 4.4, "loss_pct": 3.2}], "note": "n"},
    })
    t = _text(buf)
    for s in ("Solar PV Design Report", "1. Site and data", "2. Array layout", "3. Energy yield", "4. Losses", "5. Energy over the system life",
              "6. String design checks", "7. DC protection and export", "8. Annual shading", "9. Accuracy and limits",
              "Data and calculations based on PVGIS", "Design grade, not bankable", "within 3 %", "Inverter clipping"):
        assert s in t, s
    assert ".md" not in t


def test_table_data_report_says_screening_grade_and_has_no_attribution():
    t = _text(generate_solar_report("P", {"inputs": {}, "result": _res("table")}))
    assert "screening grade" in t and "up to about 12 %" in t and "based on PVGIS" not in t


def test_report_needs_a_result():
    with pytest.raises(ValueError):
        generate_solar_report("P", {"inputs": {}})
