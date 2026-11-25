"""PVGIS hourly typical-year lookup: caching, monthly aggregation, fallback and the result's data source (no network)."""
import math

import pytest

from backend.analysis import pvgis_tmy, solar_pv as sp

DAYS = pvgis_tmy.DAYS


def _raw(ghi_peak=800.0, hours=8760):
    """A synthetic PVGIS reply: a clean daylight bell 6h-18h, 20 C by day."""
    rows = []
    for m, nd in enumerate(DAYS, start=1):
        for d in range(1, nd + 1):
            for h in range(24):
                g = ghi_peak * math.sin(math.pi * (h - 6) / 12) if 6 <= h <= 18 else 0.0
                rows.append({"time(UTC)": f"2010{m:02d}{d:02d}:{h:02d}00", "T2m": 20.0 if g > 0 else 10.0, "RH": 50.0,
                             "G(h)": g, "Gb(n)": g * 0.7, "Gd(h)": g * 0.3, "IR(h)": 300.0, "WS10m": 2.0, "WD10m": 0.0, "SP": 1e5})
    return {"inputs": {"location": {"latitude": -26.2, "longitude": 28.04, "elevation": 1750.0},
                       "meteo_data": {"radiation_db": "PVGIS-SARAH3", "meteo_db": "ERA5", "year_min": 2005, "year_max": 2023}},
            "outputs": {"tmy_hourly": rows[:hours]}}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("PVGIS_CACHE_DIR", str(tmp_path))
    pvgis_tmy._mem.clear()
    yield
    pvgis_tmy._mem.clear()


def test_monthly_summary_is_the_mean_daily_energy_and_daytime_temperature(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: _raw())
    s = pvgis_tmy.monthly_summary(pvgis_tmy.get_tmy(-26.2, 28.04))
    # sum over 13 hourly points of 800 sin(pi (h-6)/12), h=6..18 = 800 * 2/ (pi/12) ... closed form: 800 * cot(pi/24) = 6065.7 Wh
    assert s["ghi_kwh_m2_day"][0] == pytest.approx(800 / math.tan(math.pi / 24) / 1000.0, abs=0.002)
    assert s["tday_c"] == [20.0] * 12


def test_second_lookup_for_a_nearby_point_is_cached_and_memory_survives_disk(monkeypatch):
    calls = []
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: calls.append((lat, lon)) or _raw())
    pvgis_tmy.get_tmy(-26.2001, 28.0399)
    pvgis_tmy.get_tmy(-26.2, 28.04)            # same 0.01 degree cell
    assert calls == [(-26.2, 28.04)]
    pvgis_tmy._mem.clear()                      # a restart: the disk cache answers
    pvgis_tmy.get_tmy(-26.2, 28.04)
    assert len(calls) == 1


def test_bad_reply_is_unavailable_not_a_crash(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: _raw(hours=100))
    with pytest.raises(pvgis_tmy.PvgisUnavailable):
        pvgis_tmy.get_tmy(-26.2, 28.04)
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: {"outputs": {}})
    with pytest.raises(pvgis_tmy.PvgisUnavailable):
        pvgis_tmy.get_tmy(-26.2, 28.04)


def test_bad_coordinates_are_a_value_error():
    with pytest.raises(ValueError):
        pvgis_tmy.get_tmy(95, 10)


BASE = {"location": "Johannesburg", "module": "pv_550_mono", "mode": "kwp", "target_kwp": 10, "tilt_deg": 30, "azimuth_deg": 0}


def test_table_is_the_default_and_is_labelled_screening_grade():
    r = sp.run_solar_size(dict(BASE))
    assert r["irradiance_source"].startswith("Bundled monthly table")
    assert "attribution" not in r


def test_yield_from_pvgis_data_states_its_source_and_attribution(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: _raw())
    r = sp.run_solar_size(dict(BASE, irradiance_source="pvgis", lat=None, lon=None))
    assert "PVGIS-SARAH3" in r["irradiance_source"] and "2005" in r["irradiance_source"]
    assert r["attribution"] == "Data and calculations based on PVGIS – © European Union, Joint Research Centre"
    assert r["attribution"] in r["data_note"]
    table = sp.run_solar_size(dict(BASE))
    # the synthetic year has 6.07 kWh/m2/day every month: the yield follows the data, not the table
    assert r["ghi_kwh_m2_year"] == pytest.approx(6.0657 * 365, rel=0.01)
    assert r["annual_kwh"] != table["annual_kwh"]


def test_pvgis_works_for_roof_arrays_too(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "_fetch", lambda lat, lon: _raw())
    req = dict(BASE, irradiance_source="pvgis", arrays=[{"name": "N", "area_m2": 60, "packing": 0.8, "tilt_deg": 30, "azimuth_deg": 0}])
    r = sp.run_solar_size(req)
    assert "PVGIS" in r["irradiance_source"] and r["annual_kwh"] > 0


def test_pvgis_outage_falls_back_to_the_table_and_says_so(monkeypatch):
    def down(lat, lon):
        raise pvgis_tmy.PvgisUnavailable("offline")
    monkeypatch.setattr(pvgis_tmy, "_fetch", down)
    r = sp.run_solar_size(dict(BASE, irradiance_source="pvgis"))
    assert r["irradiance_source"].startswith("Bundled monthly table")
    assert "could not be reached" in r["data_note"]
    assert r["annual_kwh"] == sp.run_solar_size(dict(BASE))["annual_kwh"]
