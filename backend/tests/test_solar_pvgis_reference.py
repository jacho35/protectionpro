"""Solar yield against PVGIS (reference values fetched by testing/solar/pvgis_reference.py, no network here).

Pins the CURRENT screening-grade error so a model change shows up as a measured improvement (or regression).
Annual specific yield difference engine vs PVGIS, per site and orientation.
"""
import json
import os

import pytest

from backend.analysis import solar_pv as sp

REF = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "testing", "solar", "pvgis_reference.json")))
AZ_N = {180: 0, -90: 90, 90: 270}   # PVGIS aspect (0 = south) -> azimuth from north
MOD = sp.get_module("pv_550_mono")

# measured 2026-11-25: engine / PVGIS - 1, annual kWh per kWp
MEASURED = {
    ("Johannesburg", "north_30"): -0.022, ("Johannesburg", "flat_ew"): +0.029,
    ("Cape Town", "north_30"): -0.112, ("Cape Town", "flat_ew"): -0.052,
    ("Upington", "north_30"): +0.087, ("Upington", "flat_ew"): +0.097,
}


def _diff(site, case):
    planes = REF["sites"][site][case]
    eng = sum(sp.energy_yield(site, 1.0 / len(planes), p["tilt"], AZ_N[p["aspect"]], MOD)["annual_kwh"] for p in planes)
    ref = sum(p["e_y"] for p in planes) / len(planes)
    return eng / ref - 1


@pytest.mark.parametrize("key", list(MEASURED))
def test_error_vs_pvgis_is_pinned(key):
    assert _diff(*key) == pytest.approx(MEASURED[key], abs=0.005)


def test_screening_grade_error_stays_within_twelve_percent():
    assert max(abs(v) for v in MEASURED.values()) < 0.12
