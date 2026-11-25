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


def _prot(**kw):
    base = {"module": "pv_550_mono", "inverter": "inv_10k_2mppt", "modules_per_string": 8, "strings_per_mppt": [2, 1]}
    return sp.size_protection(dict(base, **kw))


def test_protection_hand_calcs():
    r = _prot()
    by = {i["id"]: i for i in r["items"]}
    assert by["string_fuse"]["required"] is False                      # 2 strings per input
    # isolator: 1.25 * 14.0 * 2 = 35 A -> 40 A; Voc cold string = 8 * 53.7922 = 430 V
    assert by["dc_isolator"]["rating_a"] == 40 and by["dc_isolator"]["voltage_v"] == 430
    # cable: 1.25 * 14 = 17.5 A -> 2.5 mm2 carries 41 A but 2 * 30 * 14 * 0.0206 / 2.5 = 6.9 V = 2.06 % (> 1 %)
    # 4 mm2: 1.29 % > 1 %; 6 mm2: 2.884 V / (8 * 41.95 = 335.6 V) = 0.86 %
    assert by["dc_cable"]["cable"]["size_mm2"] == 6 and by["dc_cable"]["cable"]["vd_pct"] == pytest.approx(0.86, abs=0.01)
    assert r["ok"] is True


def test_protection_fuse_required_from_three_strings_and_limited_by_module():
    r = _prot(strings_per_mppt=[3, 3])
    f = {i["id"]: i for i in r["items"]}["string_fuse"]
    assert f["required"] and f["rating_a"] == 25 and f["ok"]          # 1.5 * 14 = 21 A -> 25 A, module max 25 A
    r = sp.size_protection({"module": dict(sp.get_module("pv_550_mono"), max_fuse_a=20), "inverter": "inv_10k_2mppt",
                            "modules_per_string": 8, "strings_per_mppt": [3, 3]})
    assert {i["id"]: i for i in r["items"]}["string_fuse"]["ok"] is False and r["ok"] is False


def test_protection_cable_grows_with_length_and_can_fail():
    short = {i["id"]: i for i in _prot(string_cable_m=10)["items"]}["dc_cable"]["cable"]["size_mm2"]
    long = {i["id"]: i for i in _prot(string_cable_m=120)["items"]}["dc_cable"]["cable"]["size_mm2"]
    assert short < long
    assert _prot(string_cable_m=2000)["ok"] is False


def test_protection_export_limit_and_errors():
    r = _prot(export_limit_kw=8)
    assert r["export_limited"] is True and "8 kW" in r["export_note"]
    assert _prot(export_limit_kw=10)["export_limited"] is False
    assert _prot(num_inverters=2)["total_ac_kw"] == 20
    with pytest.raises(ValueError):
        _prot(string_cable_m=0)


def test_solar_azimuth_noon_is_north_in_the_south_and_morning_is_east():
    assert sp.solar_azimuth_n(-25.75, 23.45, 0) == pytest.approx(0, abs=0.5) or sp.solar_azimuth_n(-25.75, 23.45, 0) > 359.5
    assert 60 < sp.solar_azimuth_n(-25.75, 0, -60) < 90                 # morning, east of north
    assert 270 < sp.solar_azimuth_n(-25.75, 0, 60) < 300                # afternoon, west


def test_obstruction_block_geometry():
    a0, a1, e = sp.obstruction_block(3.0, 6.0, 0, 8.0)
    assert e == pytest.approx(math.degrees(math.atan(0.5)), abs=1e-6)
    assert a0 == pytest.approx(360 - math.degrees(math.atan(4 / 6)), abs=1e-6) and a1 == pytest.approx(math.degrees(math.atan(4 / 6)), abs=1e-6)
    with pytest.raises(ValueError):
        sp.obstruction_block(0, 5, 0, 5)


def test_shading_reduces_yield_only_when_the_block_is_in_the_sun_path():
    base = {"location": "Pretoria", "tilt_deg": 25, "azimuth_deg": 0, "usable_area_m2": 40, "mode": "roof"}
    clear = sp.run_solar_size(base)
    north = sp.run_solar_size(dict(base, obstructions=[{"height_m": 4, "distance_m": 6, "bearing_deg": 0, "width_m": 20}]))
    south = sp.run_solar_size(dict(base, obstructions=[{"height_m": 4, "distance_m": 6, "bearing_deg": 180, "width_m": 20}]))
    assert "shading_loss_pct" not in clear
    assert north["shading_loss_pct"] > 5                                # 34 degree wall due north blocks the midday sun
    assert south["shading_loss_pct"] < 0.5 * north["shading_loss_pct"]
    assert north["annual_kwh"] < clear["annual_kwh"] == north["unshaded_annual_kwh"]




def test_arrays_mode_sums_roofs_and_respects_orientation():
    arrays = [{"name": "North", "area_m2": 40, "packing": 0.8, "tilt_deg": 25, "azimuth_deg": 0},
              {"name": "East", "area_m2": 20, "packing": 0.8, "tilt_deg": 25, "azimuth_deg": 90}]
    r = sp.run_solar_size({"location": "Pretoria", "arrays": arrays, "mode": "roof"})
    caps = [sp.modules_from_area(a["area_m2"], 0.8, MOD) for a in arrays]
    assert r["modules"] == sum(caps) == r["modules_roof"] and [p["modules"] for p in r["arrays"]] == caps
    north = sp.energy_yield("Pretoria", caps[0] * 0.55, 25, 0, MOD)["annual_kwh"]
    east = sp.energy_yield("Pretoria", caps[1] * 0.55, 25, 90, MOD)["annual_kwh"]
    assert r["annual_kwh"] == pytest.approx(north + east, abs=2)
    assert sum(m["kwh"] for m in r["months"]) == pytest.approx(r["annual_kwh"], abs=3)
    # load target smaller than the roofs: modules shared in proportion, never more than the roofs
    small = sp.run_solar_size({"location": "Pretoria", "arrays": arrays, "mode": "min", "annual_kwh": 6000})
    assert small["limited_by"] == "load" and small["modules"] < small["modules_roof"]
    assert sum(p["modules"] for p in small["arrays"]) == small["modules"]
    assert all(p["modules"] <= p["modules_roof"] for p in small["arrays"])
    # one array equals the single-orientation answer
    one = sp.run_solar_size({"location": "Pretoria", "arrays": arrays[:1], "mode": "roof"})
    solo = sp.run_solar_size({"location": "Pretoria", "usable_area_m2": 40, "tilt_deg": 25, "azimuth_deg": 0, "mode": "roof"})
    assert one["modules"] == solo["modules"] and one["annual_kwh"] == pytest.approx(solo["annual_kwh"], abs=1)
    with pytest.raises(ValueError):
        sp.run_solar_size({"location": "Pretoria", "arrays": [], "mode": "roof"})


def test_allocate_largest_remainder():
    assert sp._allocate(10, [1, 1, 1]) == [4, 3, 3] or sum(sp._allocate(10, [1, 1, 1])) == 10
    assert sp._allocate(7, [3, 1]) == [5, 2]
    assert sp._allocate(0, [1, 2]) == [0, 0]
