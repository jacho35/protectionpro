"""Annual 3D shading: sun-position grid, shade-flag mapping to hours, and the string rule, on a PVGIS typical year."""
import gzip
import json
import math
import os

import numpy as np
import pytest

from backend.analysis import pvgis_tmy, solar_hourly as sh, solar_pv as sp

TMY_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "testing", "solar", "tmy")


def _tmy():
    with gzip.open(os.path.join(TMY_DIR, "tmy_-26.20_28.04.json.gz"), "rt") as f:
        return json.load(f)


@pytest.fixture(autouse=True)
def _site(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "get_tmy", lambda la, lo: _tmy())


def test_sun_grid_is_the_middle_day_of_each_month_with_the_sun_up():
    g = sh.sun_samples(-26.2)
    assert {s["month"] for s in g} == set(range(1, 13))
    assert all(s["elevation_deg"] > 1 and 5 <= s["hour"] <= 19 for s in g)
    dec = [s for s in g if s["month"] == 12 and s["hour"] == 12][0]            # Dec 15 solar noon, 26.2 S: ~ 90 - 26.2 + 23.3 = 87
    assert dec["elevation_deg"] == pytest.approx(90 - 26.2 + 23.3, abs=0.6)
    jun = [s for s in g if s["month"] == 6 and s["hour"] == 12][0]
    assert jun["elevation_deg"] == pytest.approx(90 - 26.2 - 23.3, abs=0.6)
    assert jun["azimuth_deg"] == pytest.approx(0.0, abs=1.0) or jun["azimuth_deg"] == pytest.approx(360.0, abs=1.0)   # sun in the north
    assert len([s for s in g if s["month"] == 6]) < len([s for s in g if s["month"] == 12])       # shorter winter day


def test_hours_between_samples_take_the_nearest_sampled_hour():
    t = _tmy()
    idx = sh.hour_index(t)
    smp = sh.sun_samples(t["lat"])
    frac = [1.0 if s["hour"] == 12 else 0.0 for s in smp]                     # shaded only at solar noon
    f = sh.shaded_fraction_by_hour(idx, smp, frac)
    mon, hour, up = idx
    assert f[(hour == 12) & up].min() == 1.0 and f[(hour == 8) & up].max() == 0.0
    assert (f[~up] == 0).all()


def _req(shade_fn, n=12, per_string=6):
    smp = sh.sun_samples(-26.2)
    return {"location": "Johannesburg", "module": "pv_550_mono", "inverter": "inv_10k_2mppt",
            "arrays": [{"name": "North", "tilt_deg": 30, "azimuth_deg": 0, "modules": n, "per_string": per_string,
                        "shade": ["".join("1" if shade_fn(i, s) else "0" for s in smp) for i in range(n)]}]}


def test_no_shade_flags_is_no_loss_and_full_shade_loses_the_beam_share():
    none = sp.run_solar_shading(_req(lambda i, s: False))
    assert none["loss_pct"] == 0.0 and none["strings"][0]["loss_pct"] == 0.0
    allsh = sp.run_solar_shading(_req(lambda i, s: True))
    assert 40 < allsh["loss_pct"] < 80          # the beam is most of a clear-climate plane-of-array year; diffuse stays
    assert all(m["loss_pct"] > 0 for m in allsh["months"])
    assert allsh["attribution"].startswith("Data and calculations based on PVGIS")


def test_a_string_loses_in_proportion_to_its_shaded_modules():
    full = sp.run_solar_shading(_req(lambda i, s: True))["loss_pct"]
    # first string (modules 0-5) completely shaded, second string clear: half the array's beam is lost
    half = sp.run_solar_shading(_req(lambda i, s: i < 6))
    assert half["strings"][0]["loss_pct"] == pytest.approx(full, rel=0.02)
    assert half["strings"][1]["loss_pct"] == 0.0
    assert half["loss_pct"] == pytest.approx(full / 2, rel=0.03)
    # shading 3 of 6 modules in one string: half that string's beam
    # (not exactly half: the inverter's efficiency curve and the cell temperature are not linear in the beam)
    part = sp.run_solar_shading(_req(lambda i, s: i < 3, per_string=6))
    assert part["strings"][0]["loss_pct"] == pytest.approx(full / 2, rel=0.06)


def test_only_morning_shade_loses_less_than_all_day_shade():
    morning = sp.run_solar_shading(_req(lambda i, s: s["hour"] < 9))["loss_pct"]
    full = sp.run_solar_shading(_req(lambda i, s: True))["loss_pct"]
    assert 0 < morning < full / 3


def test_bad_shade_data_is_a_value_error():
    r = _req(lambda i, s: False)
    r["arrays"][0]["shade"] = r["arrays"][0]["shade"][:-1]
    with pytest.raises(ValueError):
        sp.run_solar_shading(r)
    with pytest.raises(ValueError):
        sp.run_solar_shading({"location": "Johannesburg", "arrays": []})


def test_beam_factor_zero_removes_the_beam():
    t = _tmy()
    mod = sp.get_module("pv_550_mono")
    a = sh.hourly_yield(t, 5.0, 30, 0, mod)["annual_kwh"]
    b = sh.hourly_yield(t, 5.0, 30, 0, mod, beam_factor=np.zeros(8760))["annual_kwh"]
    assert 0.2 * a < b < 0.6 * a
