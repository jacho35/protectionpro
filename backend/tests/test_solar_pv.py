"""Solar PV engine: closed-form hand calcs for sizing, strings, row spacing and yield sanity."""
import math

import pytest

from backend.analysis import solar_pv as sp
from backend.analysis.pv_data import PV_INVERTERS, PV_MODULES
from backend.analysis.solar_irradiance_data import CITIES

MOD = sp.get_module("pv_550_mono")
INV = sp.get_inverter("inv_10k_2mppt")


def test_every_requested_city_is_present_with_twelve_months():
    for name in ("Johannesburg", "Pretoria", "Cape Town", "Durban", "Gqeberha (Port Elizabeth)", "Bloemfontein",
                 "East London", "Polokwane", "Mbombela (Nelspruit)", "Kimberley", "Pietermaritzburg", "Rustenburg",
                 "Upington", "George", "Mahikeng", "Richards Bay", "Hermanus"):
        c = CITIES[name]
        assert len(c["ghi_kwh_m2_day"]) == 12 and len(c["tday_c"]) == 12
        mean = sum(g * d for g, d in zip(c["ghi_kwh_m2_day"], sp.DAYS)) / 365.0
        assert 4.5 < mean < 6.6


def test_modules_from_area_hand_calc():
    # 78 m2 * 0.8 / (2.28 * 1.13 = 2.5764 m2) = 24.2 -> 24 modules
    assert sp.modules_from_area(78, 0.8, MOD) == 24


def test_modules_from_load_hand_calc():
    # 18500 kWh * 0.7 / 1750 = 7.4 kWp -> ceil(7.4 / 0.55) = 14
    assert sp.modules_from_load(18500, 0.7, 1750, MOD) == 14


def test_declination_and_extraterrestrial_reference_values():
    assert sp.declination(172) == pytest.approx(23.45, abs=0.1)        # June solstice
    assert sp.declination(355) == pytest.approx(-23.4, abs=0.2)
    # equator at the equinox: H0 = 24 / pi * 1.367 kW/m2 * eccentricity (1.006) = 10.5 kWh/m2
    assert sp.extraterrestrial_daily(0, 80) == pytest.approx(24 / math.pi * 1.367 * 1.0063, abs=0.02)


def test_flat_plane_poa_equals_horizontal():
    poa, _ = sp.daily_poa(-25.75, 105, 5.0, 0.0, 0.0)
    assert poa == pytest.approx(5.0, rel=0.02)


def test_orientation_ordering_in_southern_hemisphere():
    y = lambda tilt, az: sp.energy_yield("Pretoria", 1.0, tilt, az, MOD)["annual_kwh"]
    north, flat, east, south = y(25, 0), y(0, 0), y(25, 90), y(25, 180)
    assert north > flat > east > south
    assert y(25, 90) == pytest.approx(y(25, 270), rel=0.01)           # east / west symmetric


def test_yield_is_in_a_plausible_south_african_range():
    s = sp.energy_yield("Pretoria", 1.0, 25, 0, MOD)
    assert 1650 < s["specific_yield_kwh_kwp"] < 1950
    assert 0.78 < s["performance_ratio"] < 0.88
    assert sp.energy_yield("Cape Town", 1.0, 25, 0, MOD)["specific_yield_kwh_kwp"] < s["specific_yield_kwh_kwp"] * 1.05


def test_yield_scales_with_kwp_and_cape_town_is_summer_peaked():
    a = sp.energy_yield("Hermanus", 1.0, 20, 0, MOD)
    b = sp.energy_yield("Hermanus", 5.0, 20, 0, MOD)
    assert b["annual_kwh"] == pytest.approx(5 * a["annual_kwh"], rel=0.002)
    kwh = [m["kwh"] for m in a["months"]]
    assert kwh[0] > 2.5 * kwh[5]                                      # Jan far above Jun


def test_run_size_modes_and_limit_reporting():
    base = {"location": "Pretoria", "tilt_deg": 25, "azimuth_deg": 0, "usable_area_m2": 78, "annual_kwh": 18500}
    both = sp.run_solar_size(dict(base, mode="min"))
    assert both["modules_roof"] == 24 and both["modules"] == both["modules_load"] < 24
    assert both["limited_by"] == "load"
    roof = sp.run_solar_size(dict(base, mode="roof"))
    assert roof["modules"] == 24 and roof["kwp"] == pytest.approx(13.2)
    tight = sp.run_solar_size(dict(base, usable_area_m2=20))
    assert tight["limited_by"] == "roof" and tight["modules"] == 6
    with_inv = sp.run_solar_size(dict(base, mode="roof", inverter="inv_10k_2mppt"))
    assert with_inv["dc_ac_ratio"] == pytest.approx(1.32)
    assert with_inv["load_share_pct"] > 100 * both["load_share_pct"] / 100


def test_run_size_errors():
    with pytest.raises(ValueError):
        sp.run_solar_size({"location": "Atlantis"})
    with pytest.raises(ValueError):
        sp.run_solar_size({"location": "Pretoria"})                    # no area, no load
    with pytest.raises(ValueError):
        sp.run_solar_size({"location": "Pretoria", "mode": "roof", "annual_kwh": 1000})


def test_string_temperature_corrected_voltages():
    # Voc cold = 49.9 * (1 + (-0.26 / 100) * (-5 - 25)) = 49.9 * 1.078 = 53.7922
    # Vmp hot  = 41.95 * (1 + (-0.34 / 100) * (70 - 25)) = 41.95 * 0.847 = 35.5317
    lim = sp.string_limits(MOD, INV, -5, 70)
    assert lim["voc_cold_v"] == pytest.approx(53.7922, abs=1e-3)
    assert lim["vmp_hot_v"] == pytest.approx(35.5317, abs=1e-3)


def test_string_limits_take_the_tighter_of_voltage_and_mppt_max():
    lim = sp.string_limits(MOD, INV, -5, 70)
    assert lim["n_max"] == min(math.floor(1000 / 53.7922), math.floor(800 / 41.95))
    assert lim["n_min"] == math.ceil(200 / 35.5317)


def test_check_strings_pass_and_each_failure():
    ok = sp.check_strings({"module": "pv_550_mono", "inverter": "inv_10k_2mppt",
                           "modules_per_string": 8, "strings_per_mppt": [2, 1]})
    assert ok["ok"] and ok["total_modules"] == 24 and ok["kwp"] == pytest.approx(13.2)
    assert ok["dc_ac_ratio"] == pytest.approx(1.32)
    assert ok["string_isc_design_a"] == pytest.approx(1.25 * 14.0, abs=0.01)

    def failing(**kw):
        r = sp.check_strings(dict({"module": "pv_550_mono", "inverter": "inv_10k_2mppt",
                                   "modules_per_string": 8, "strings_per_mppt": [2, 1]}, **kw))
        return {c["id"] for c in r["checks"] if not c["ok"]}

    assert failing(modules_per_string=19) >= {"max_voltage"}           # 19 * 53.8 = 1022 V
    assert failing(modules_per_string=5) == {"mppt_min"}               # 5 * 35.5 = 178 V
    assert failing(strings_per_mppt=[3, 1]) == {"mppt_current"}        # 3 * 14.0 = 42 A
    assert failing(strings_per_mppt=[1, 1, 1]) == {"mppt_count"}
    assert failing(modules_per_string=19)                              # also above the MPPT ceiling


def test_row_spacing_hand_calc():
    # lat 25.75 S winter solstice noon: alpha = 90 - 25.75 - 23.45 = 40.8 deg
    r = sp.row_spacing(-25.75, 15, 2.28, 0.0, 9.2)
    assert r["sun_elevation_deg"] == pytest.approx(40.8, abs=0.05)
    expect = 2.28 * math.cos(math.radians(15)) + 2.28 * math.sin(math.radians(15)) / math.tan(math.radians(40.8))
    assert r["pitch_m"] == pytest.approx(expect, abs=1e-3)
    assert r["ground_cover_ratio"] == pytest.approx(2.28 / expect, abs=1e-3)
    # (9.2 - 2.28 cos 15) / 2.886 = 2.4 -> 2 + 1 rows
    assert r["rows"] == 3
    later = sp.row_spacing(-25.75, 15, 2.28, 45.0, 9.2)
    assert later["pitch_m"] > r["pitch_m"] and later["rows"] < r["rows"]


def test_default_libraries_are_well_formed():
    ids = [m["id"] for m in PV_MODULES] + [i["id"] for i in PV_INVERTERS]
    assert len(ids) == len(set(ids))
    for m in PV_MODULES:
        assert m["vmp_v"] < m["voc_v"] and m["imp_a"] <= m["isc_a"]
        assert m["voc_v"] * m["isc_a"] > m["pmax_w"]
        assert m["pmax_w"] == pytest.approx(m["vmp_v"] * m["imp_a"], rel=0.03)
    for i in PV_INVERTERS:
        assert i["mppt_min_v"] < i["mppt_max_v"] < i["max_dc_v"]


def test_module_defaults_match_the_frontend_panel_list():
    """frontend/js/constants.js PV_PANELS is the app's module list; pv_data mirrors it."""
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "frontend" / "js" / "constants.js").read_text()
    block = src[src.index("const PV_PANELS = ["):]
    block = block[:block.index("];")]
    rows = re.findall(r"id: '(\w+)'.*?w: (\d+), voc: ([\d.]+), vmp: ([\d.]+),\s+isc: ([\d.]+), imp: ([\d.]+),"
                      r"\s+beta_voc: (-?[\d.]+), gamma_vmp: (-?[\d.]+)", block)
    assert len(rows) == len(PV_MODULES)
    for (pid, w, voc, vmp, isc, imp, beta, gamma), m in zip(rows, PV_MODULES):
        assert m["id"] == pid and m["pmax_w"] == float(w)
        assert (m["voc_v"], m["vmp_v"], m["isc_a"], m["imp_a"]) == (float(voc), float(vmp), float(isc), float(imp))
        assert (m["k_voc_pct"], m["k_vmp_pct"]) == (float(beta), float(gamma))
