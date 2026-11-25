"""Hourly PV model: closed-form checks, inverter clipping / efficiency, degradation, and the PVGIS reference (<= 3 % annual)."""
import gzip
import json
import math
import os

import numpy as np
import pytest

from backend.analysis import pvgis_tmy, solar_hourly as sh, solar_pv as sp

HERE = os.path.dirname(__file__)
TMY_DIR = os.path.join(HERE, "..", "..", "testing", "solar", "tmy")
REF = json.load(open(os.path.join(HERE, "..", "..", "testing", "solar", "pvgis_reference.json")))
MOD = sp.get_module("pv_550_mono")
SITES = {"Johannesburg": (-26.2, 28.04), "Cape Town": (-33.92, 18.42), "Upington": (-28.45, 21.26)}
AZ_N = {180: 0, -90: 90, 90: 270}


def _tmy(site):
    lat, lon = SITES[site]
    with gzip.open(os.path.join(TMY_DIR, f"tmy_{lat:.2f}_{lon:.2f}.json.gz"), "rt") as f:
        return json.load(f)


@pytest.mark.parametrize("site", list(SITES))
@pytest.mark.parametrize("case", ["north_30", "flat_ew"])
def test_annual_energy_within_three_percent_of_pvgis(site, case):
    t = _tmy(site)
    planes = REF["sites"][site][case]
    eng = sum(sh.hourly_yield(t, 1.0 / len(planes), p["tilt"], AZ_N[p["aspect"]], MOD)["annual_kwh"] for p in planes)
    ref = sum(p["e_y"] for p in planes) / len(planes)
    assert abs(eng / ref - 1) < 0.03


def test_incidence_modifier_is_one_at_normal_and_falls_toward_grazing():
    f = sh._aoi_factor(np.array([1.0, math.cos(math.radians(60)), math.cos(math.radians(80)), 0.0, -0.2]))
    assert f[0] == pytest.approx(1.0)
    assert f[1] == pytest.approx(1 - 0.05 * (2 - 1), abs=1e-9)          # 60 deg: 1 / cos = 2
    assert f[2] == pytest.approx(1 - 0.05 * (1 / math.cos(math.radians(80)) - 1), abs=1e-9)
    assert f[3] == 0 and f[4] == 0


def test_sun_at_solar_noon_on_the_equinox_is_at_colatitude():
    t = {"time": ["20100321:1200"], "lat": -30.0, "lon": 0.0, "time_offset_h": 0.0}
    el, az, _, _ = sh._sun(t)
    # equinox, lon 0, near noon: elevation ~ 90 - |lat| = 60 (equation of time ~ -7 min and declination ~ 0.4 deg off)
    assert math.degrees(el[0]) == pytest.approx(60.0, abs=1.0)
    assert math.degrees(az[0]) == pytest.approx(0.0, abs=6.0) or math.degrees(az[0]) == pytest.approx(360.0, abs=6.0)  # north in the south


def test_perez_and_isotropic_differ_but_agree_within_a_few_percent_on_poa():
    t = _tmy("Johannesburg")
    a = sh.plane_of_array(t, 30, 0, "perez")["poa"].sum()
    b = sh.plane_of_array(t, 30, 0, "isotropic")["poa"].sum()
    assert a != b and abs(a / b - 1) < 0.08


def test_flat_plane_poa_is_ghi():
    t = _tmy("Johannesburg")
    p = sh.plane_of_array(t, 0, 0, "isotropic")
    # beam on a horizontal plane = DNI cos(zenith) must reproduce GHI - DHI within the hourly data's own consistency
    assert p["poa"].sum() == pytest.approx(np.asarray(t["ghi_w_m2"]).sum(), rel=0.03)


def test_inverter_efficiency_curve_hits_the_stated_euro_efficiency():
    for eff in (97.5, 98.0, 98.6):
        prated = 10.0 / (eff / 100)
        got = 0.0
        for x, w in sh.EURO_W:
            pac, _ = sh.inverter_ac(np.array([x * prated]), 10.0, eff)
            got += w * pac[0] / (x * prated)
        assert got == pytest.approx(eff / 100, abs=0.0005)


def test_clipping_appears_above_dc_ac_one_and_not_below():
    t = _tmy("Upington")
    big = sh.hourly_yield(t, 15.0, 20, 0, MOD, None, 98.0, None, 10.0)      # DC/AC 1.5
    small = sh.hourly_yield(t, 8.0, 20, 0, MOD, None, 98.0, None, 10.0)     # DC/AC 0.8
    assert big["clipping_loss_pct"] > 1.0
    assert small["clipping_loss_pct"] == pytest.approx(0.0, abs=0.05)
    # output never exceeds the AC rating
    assert max(m["kwh"] for m in big["months"]) < 10.0 * 24 * 31


def test_lifetime_table_applies_lid_then_annual_rate():
    r = sh.hourly_yield(_tmy("Cape Town"), 5.0, 30, 0, MOD, lid_pct=1.5, degradation_pct=0.5)
    y1, y25 = r["lifetime"][0]["kwh"], r["lifetime"][24]["kwh"]
    assert y1 == pytest.approx(r["annual_kwh"] * 0.985, abs=1)
    assert y25 == pytest.approx(r["annual_kwh"] * 0.985 * 0.995 ** 24, abs=1)
    assert len(r["lifetime"]) == 25


def test_horizon_block_removes_beam_and_lowers_yield():
    t = _tmy("Johannesburg")
    clear = sh.hourly_yield(t, 5.0, 30, 0, MOD)["annual_kwh"]
    block = sp.obstruction_block(8.0, 5.0, 0.0, 30.0)   # a tall wall to the north (where the sun is)
    shaded = sh.hourly_yield(t, 5.0, 30, 0, MOD, horizon=[block])["annual_kwh"]
    assert shaded < clear * 0.9


def test_run_solar_size_uses_the_hourly_model_and_reports_clipping(monkeypatch):
    lat, lon = SITES["Upington"]
    monkeypatch.setattr(pvgis_tmy, "get_tmy", lambda la, lo: _tmy("Upington"))
    req = {"location": "Upington", "module": "pv_550_mono", "inverter": "inv_10k_2mppt", "mode": "kwp", "target_kwp": 15,
           "tilt_deg": 20, "azimuth_deg": 0, "irradiance_source": "pvgis"}
    r = sp.run_solar_size(req)
    assert r["model"].startswith("hourly") and r["clipping_loss_pct"] > 1.0 and len(r["lifetime"]) == 25
    iso = sp.run_solar_size(dict(req, transposition="isotropic"))
    assert iso["annual_kwh"] != r["annual_kwh"] and "isotropic" in iso["model"]
    with pytest.raises(ValueError):
        sp.run_solar_size(dict(req, transposition="bogus"))
    arr = sp.run_solar_size(dict(req, arrays=[{"name": "A", "area_m2": 90, "packing": 0.8, "tilt_deg": 20, "azimuth_deg": 0}]))
    assert arr["clipping_kwh"] >= 0 and len(arr["lifetime"]) == 25
    table = sp.run_solar_size(dict(req, irradiance_source="table"))
    assert table["model"].startswith("monthly") and "clipping_kwh" not in table


# ---------------------------------------------------------------- manufacturer data from imported parts
# the Chint Power CPS SCH275KTL efficiency curve as the importer reads it (DC load relative to the nominal DC input, efficiency)
CPS_CURVE = [[0.00494, 0], [0.02964, 0.92307], [0.04941, 0.95], [0.09881, 0.97], [0.19763, 0.982], [0.29644, 0.985],
             [0.59289, 0.9901], [0.98814, 0.986], [1.08696, 0.983]]
# the ET Solar ET-M772BH550GL incidence table as the importer reads it
ET_IAM = [[0, 1], [20, 1], [30, 1], [40, 0.99], [50, 0.98], [60, 0.96], [70, 0.89], [80, 0.66], [90, 0]]


def test_inverter_curve_is_read_at_each_load_and_clips_at_the_ac_rating():
    ac = 250.0
    prated = ac / float(np.interp(1.0, [a for a, _ in CPS_CURVE], [e for _, e in CPS_CURVE]))
    for x, eff in ((0.29644, 0.985), (0.59289, 0.9901), (0.19763, 0.982)):           # points of the curve: exactly the file's efficiency
        pac, _ = sh.inverter_ac(np.array([x * prated]), ac, 98.49, CPS_CURVE)
        assert pac[0] / (x * prated) == pytest.approx(eff, abs=1e-4)
    assert sh.inverter_ac(np.array([0.003 * prated]), ac, 98.49, CPS_CURVE)[0][0] == 0.0         # below the first point nothing is delivered
    pac, clipped = sh.inverter_ac(np.array([1.3 * prated, 0.5 * prated]), ac, 98.49, CPS_CURVE)
    assert pac[0] == ac and clipped > 0 and pac[1] < ac


def test_curve_and_generic_inverter_agree_on_a_year_but_are_not_the_same_model():
    t = _tmy("Johannesburg")
    gen = sh.hourly_yield(t, 350.0, 20, 0, MOD, None, 98.49, None, 250.0)
    cur = sh.hourly_yield(t, 350.0, 20, 0, MOD, None, 98.49, None, 250.0, eff_curve=CPS_CURVE)
    assert cur["annual_kwh"] != gen["annual_kwh"]
    assert abs(cur["annual_kwh"] / gen["annual_kwh"] - 1) < 0.02            # both describe the same machine: within 2 % of each other
    assert cur["clipping_loss_pct"] > 0.5                                    # DC/AC 1.4 clips


def test_module_incidence_table_replaces_ashrae():
    t = _tmy("Cape Town")
    ashrae = sh.hourly_yield(t, 5.0, 30, 0, MOD)["annual_kwh"]
    flat = sh.hourly_yield(t, 5.0, 30, 0, dict(MOD, iam_profile=[[0, 1], [90, 1]]))["annual_kwh"]      # no incidence loss at all (except past grazing)
    harsh = sh.hourly_yield(t, 5.0, 30, 0, dict(MOD, iam_profile=[[0, 1], [40, 0.9], [70, 0.5], [90, 0]]))["annual_kwh"]
    et = sh.hourly_yield(t, 5.0, 30, 0, dict(MOD, iam_profile=ET_IAM))["annual_kwh"]
    assert harsh < et <= flat and harsh < ashrae < flat * 1.001
    assert abs(et / ashrae - 1) < 0.02                                      # the ET table is close to ASHRAE b0 0.05: a small change


def test_result_says_where_the_curves_came_from(monkeypatch):
    monkeypatch.setattr(pvgis_tmy, "get_tmy", lambda la, lo: _tmy("Upington"))
    inv = dict(sp.get_inverter("inv_10k_2mppt"), eff_curve=CPS_CURVE)
    req = {"location": "Upington", "module": dict(MOD, iam_profile=ET_IAM), "inverter": inv, "mode": "kwp", "target_kwp": 12,
           "tilt_deg": 20, "azimuth_deg": 0, "irradiance_source": "pvgis"}
    r = sp.run_solar_size(req)
    assert r["curves"] == {"incidence": "manufacturer's table", "inverter": "manufacturer's curve"}
    plain = sp.run_solar_size(dict(req, module="pv_550_mono", inverter="inv_10k_2mppt"))
    assert plain["curves"]["incidence"].startswith("ASHRAE") and plain["curves"]["inverter"].startswith("generic")
