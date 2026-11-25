"""Solar PV design engine - phase 1 (size and yield) plus string checks and row spacing.

Pure functions; no project data needed. Screening / design-stage accuracy: the
irradiance table is approximate (solar_irradiance_data.py) and the sky model is
isotropic, so yields are good to roughly +-10 %, not bankable.

**Plane-of-array irradiation.** For each month a representative day (Klein) is
integrated hourly. Daily horizontal irradiation H is split into hourly global
(Collares-Pereira & Rabl) and diffuse (Liu-Jordan) parts, the diffuse fraction
of the day from the clearness index Kt = H / H0 (Erbs et al. daily
correlation). Plane of array = beam * cos(theta) / cos(theta_z) + diffuse *
(1 + cos beta) / 2 + ground-reflected * albedo * (1 - cos beta) / 2
(isotropic sky). Orientation: azimuth in degrees from north (0 = north, 90 =
east, 180 = south), tilt from horizontal.

**Energy.** E_month = kWp * H_poa * days * PR_month, with PR_month =
(1 + gamma * (T_cell - 25)) * (1 - soiling) * (1 - mismatch) * ... Cell
temperature T_cell = T_day + (NOCT - 20) / 800 * 700 W/m2 (a representative
generating irradiance).

**Strings** (IEC 62548 / 60364-7-712 style): cold Voc = N * Voc * (1 + k_Voc *
(T_min - 25)); hot Vmp = N * Vmp * (1 + k_Vmp * (T_cell_max - 25)).

**Row spacing** for tilted racks: pitch = L cos(beta) + L sin(beta) / tan(alpha),
alpha the solar elevation at the design hour on the winter solstice.
"""
import math

from .pv_data import DEFAULT_LOSSES, PV_INVERTERS, PV_MODULES
from .solar_irradiance_data import CITIES, SOURCE_NOTE

DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
# Klein's recommended representative day of each month (day of year)
REP_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344]
GSC = 1.367  # kW/m2 solar constant
ALBEDO = 0.2
RAD = math.pi / 180.0


# ---------------------------------------------------------------- geometry
def declination(n):
    return 23.45 * math.sin(RAD * 360.0 * (284 + n) / 365.0)


def sunset_hour_angle(lat, dec):
    x = -math.tan(lat * RAD) * math.tan(dec * RAD)
    return math.acos(max(-1.0, min(1.0, x))) / RAD  # degrees


def extraterrestrial_daily(lat, n):
    """Daily extraterrestrial horizontal irradiation H0 in kWh/m2."""
    dec = declination(n)
    ws = sunset_hour_angle(lat, dec)
    e0 = 1 + 0.033 * math.cos(RAD * 360.0 * n / 365.0)
    return (24.0 / math.pi) * GSC * e0 * (
        math.cos(lat * RAD) * math.cos(dec * RAD) * math.sin(ws * RAD)
        + ws * RAD * math.sin(lat * RAD) * math.sin(dec * RAD))


def diffuse_fraction(kt):
    """Erbs et al. daily diffuse fraction Hd / H."""
    if kt < 0.17:
        return 0.99
    if kt <= 0.75:
        return 1.188 - 2.272 * kt + 9.473 * kt ** 2 - 21.865 * kt ** 3 + 14.648 * kt ** 4
    return 0.177


def solar_elevation(lat, dec, hour_angle):
    s = (math.sin(lat * RAD) * math.sin(dec * RAD)
         + math.cos(lat * RAD) * math.cos(dec * RAD) * math.cos(hour_angle * RAD))
    return math.asin(max(-1.0, min(1.0, s))) / RAD


def daily_poa(lat, n, h_horizontal, tilt, azimuth_n):
    """Plane-of-array daily irradiation (kWh/m2) from daily horizontal H (kWh/m2).

    Returns (h_poa, h_diffuse_horizontal). azimuth_n: degrees from north.
    """
    dec = declination(n)
    ws = sunset_hour_angle(lat, dec)
    h0 = extraterrestrial_daily(lat, n)
    kt = max(0.0, min(1.0, h_horizontal / h0)) if h0 > 0 else 0.0
    hd = diffuse_fraction(kt) * h_horizontal
    wsr = ws * RAD
    denom = math.sin(wsr) - wsr * math.cos(wsr)
    if denom <= 0:
        return 0.0, hd
    a = 0.409 + 0.5016 * math.sin(wsr - 60 * RAD)
    b = 0.6609 - 0.4767 * math.sin(wsr - 60 * RAD)
    beta = tilt * RAD
    gam = (azimuth_n - 180.0) * RAD   # surface azimuth from south, east negative
    phi, d = lat * RAD, dec * RAD
    total = 0.0
    for hr in range(24):
        w = (hr + 0.5 - 12.0) * 15.0
        if abs(w) >= ws:
            continue
        wr = w * RAD
        rt = (math.pi / 24.0) * (a + b * math.cos(wr)) * (math.cos(wr) - math.cos(wsr)) / denom
        rd = (math.pi / 24.0) * (math.cos(wr) - math.cos(wsr)) / denom
        g = max(0.0, rt * h_horizontal)
        dif = min(g, max(0.0, rd * hd))
        beam_h = g - dif
        cos_z = math.cos(phi) * math.cos(d) * math.cos(wr) + math.sin(phi) * math.sin(d)
        cos_t = (math.sin(d) * math.sin(phi) * math.cos(beta)
                 - math.sin(d) * math.cos(phi) * math.sin(beta) * math.cos(gam)
                 + math.cos(d) * math.cos(phi) * math.cos(beta) * math.cos(wr)
                 + math.cos(d) * math.sin(phi) * math.sin(beta) * math.cos(gam) * math.cos(wr)
                 + math.cos(d) * math.sin(beta) * math.sin(gam) * math.sin(wr))
        beam_t = beam_h * max(0.0, cos_t) / cos_z if cos_z > 0.05 else 0.0
        total += (beam_t + dif * (1 + math.cos(beta)) / 2.0
                  + g * ALBEDO * (1 - math.cos(beta)) / 2.0)
    return total, hd


# ---------------------------------------------------------------- data lookups
def get_city(name):
    if name not in CITIES:
        raise ValueError(f"Unknown location '{name}'. Choose one of: {', '.join(sorted(CITIES))}")
    return CITIES[name]


def get_module(module):
    """A module dict from the request, or a default-library id."""
    if isinstance(module, dict):
        m = dict(module)
    else:
        found = [x for x in PV_MODULES if x["id"] == module]
        if not found:
            raise ValueError(f"Unknown module '{module}'")
        m = dict(found[0])
    for key in ("pmax_w", "voc_v", "vmp_v", "isc_a"):
        if not m.get(key) or m[key] <= 0:
            raise ValueError(f"Module needs a positive {key}")
    m.setdefault("k_pmax_pct", -0.35)
    m.setdefault("noct_c", 44)
    if "area_m2" not in m:
        m["area_m2"] = float(m.get("length_m", 0)) * float(m.get("width_m", 0))
    return m


def get_inverter(inv):
    if isinstance(inv, dict):
        return dict(inv)
    found = [x for x in PV_INVERTERS if x["id"] == inv]
    if not found:
        raise ValueError(f"Unknown inverter '{inv}'")
    return dict(found[0])


# ---------------------------------------------------------------- sizing
def modules_from_area(usable_area_m2, packing, module):
    if usable_area_m2 < 0 or not 0 < packing <= 1:
        raise ValueError("Usable area must be >= 0 and the packing factor in (0, 1]")
    if module["area_m2"] <= 0:
        raise ValueError("Module area is needed to size from roof area (length and width)")
    return int(math.floor(usable_area_m2 * packing / module["area_m2"]))


def modules_from_load(annual_kwh, share, specific_yield, module):
    if annual_kwh < 0 or not 0 < share <= 1.5 or specific_yield <= 0:
        raise ValueError("Consumption must be >= 0, share in (0, 1.5] and specific yield > 0")
    kwp = annual_kwh * share / specific_yield
    return int(math.ceil(kwp / (module["pmax_w"] / 1000.0) - 1e-9))


# ---------------------------------------------------------------- yield
def energy_yield(city_name, kwp, tilt, azimuth_n, module, losses=None, inverter_eff_pct=None):
    """Monthly and annual AC energy for kwp of modules at one orientation."""
    city = get_city(city_name)
    if kwp < 0 or not 0 <= tilt <= 90:
        raise ValueError("kWp must be >= 0 and tilt between 0 and 90 degrees")
    loss = dict(DEFAULT_LOSSES)
    loss.update(losses or {})
    if inverter_eff_pct:
        loss["inverter"] = 1 - inverter_eff_pct / 100.0
    fixed = 1.0
    for v in loss.values():
        fixed *= (1 - v)
    gamma = module.get("k_pmax_pct", -0.35) / 100.0
    noct = module.get("noct_c", 44)
    months = []
    for i in range(12):
        h = city["ghi_kwh_m2_day"][i]
        poa, _ = daily_poa(city["lat"], REP_DAY[i], h, tilt, azimuth_n)
        tcell = city["tday_c"][i] + (noct - 20.0) / 800.0 * 700.0
        temp_f = 1 + gamma * (tcell - 25.0)
        pr = temp_f * fixed
        months.append({"month": i + 1, "ghi_kwh_m2": round(h * DAYS[i], 1),
                       "poa_kwh_m2": round(poa * DAYS[i], 1), "pr": round(pr, 4),
                       "kwh": round(kwp * poa * DAYS[i] * pr, 1)})
    annual = sum(m["kwh"] for m in months)
    ghi_year = sum(m["ghi_kwh_m2"] for m in months)
    poa_year = sum(m["poa_kwh_m2"] for m in months)
    return {"months": months, "annual_kwh": round(annual, 0),
            "specific_yield_kwh_kwp": round(annual / kwp, 0) if kwp > 0 else 0.0,
            "ghi_kwh_m2_year": round(ghi_year, 0), "poa_kwh_m2_year": round(poa_year, 0),
            "performance_ratio": round(annual / (kwp * poa_year), 3) if kwp > 0 and poa_year > 0 else 0.0}


def run_solar_size(req):
    """Phase 1: size from roof area and / or load, then the yield of the chosen size."""
    module = get_module(req.get("module", "pv_550_mono_144"))
    city = req.get("location", "Pretoria")
    tilt = float(req.get("tilt_deg", 20))
    az = float(req.get("azimuth_deg", 0))
    mode = req.get("mode", "min")
    if mode not in ("roof", "load", "min"):
        raise ValueError("mode must be roof, load or min")
    # specific yield of one kWp at this orientation sets the load-based size
    ref = energy_yield(city, 1.0, tilt, az, module, req.get("losses"))
    spec = ref["annual_kwh"]
    roof_mods = load_mods = None
    if req.get("usable_area_m2") is not None:
        roof_mods = modules_from_area(float(req["usable_area_m2"]), float(req.get("packing", 0.8)), module)
    if req.get("annual_kwh") is not None:
        load_mods = modules_from_load(float(req["annual_kwh"]), float(req.get("share_pct", 70)) / 100.0, spec, module)
    cands = {"roof": roof_mods, "load": load_mods}
    if mode == "min":
        have = [v for v in cands.values() if v is not None]
        if not have:
            raise ValueError("Give a usable roof area, an annual consumption, or both")
        modules = min(have)
        limited_by = "roof" if roof_mods is not None and modules == roof_mods and (
            load_mods is None or roof_mods <= load_mods) else "load"
    else:
        if cands[mode] is None:
            raise ValueError(f"mode '{mode}' needs its input ({'usable_area_m2' if mode == 'roof' else 'annual_kwh'})")
        modules = cands[mode]
        limited_by = mode
    kwp = round(modules * module["pmax_w"] / 1000.0, 3)
    inverter = get_inverter(req["inverter"]) if req.get("inverter") else None
    y = energy_yield(city, kwp, tilt, az, module, req.get("losses"),
                     inverter["efficiency_pct"] if inverter else None)
    out = {"location": city, "tilt_deg": tilt, "azimuth_deg": az, "mode": mode, "limited_by": limited_by,
           "modules_roof": roof_mods, "modules_load": load_mods, "modules": modules, "kwp": kwp,
           "annual_kwh": y["annual_kwh"], "specific_yield_kwh_kwp": y["specific_yield_kwh_kwp"],
           "performance_ratio": y["performance_ratio"], "poa_kwh_m2_year": y["poa_kwh_m2_year"],
           "ghi_kwh_m2_year": y["ghi_kwh_m2_year"], "months": y["months"],
           "data_note": SOURCE_NOTE}
    if req.get("annual_kwh"):
        out["load_share_pct"] = round(100.0 * y["annual_kwh"] / float(req["annual_kwh"]), 1)
    if inverter:
        out["dc_ac_ratio"] = round(kwp / (inverter["ac_kw"] * req.get("num_inverters", 1)), 2)
    return out


# ---------------------------------------------------------------- strings
def string_limits(module, inverter, t_min_c, t_cell_max_c):
    """Smallest and largest modules per string for this module / inverter pair."""
    voc_cold = module["voc_v"] * (1 + module.get("k_voc_pct", -0.27) / 100.0 * (t_min_c - 25))
    vmp_hot = module["vmp_v"] * (1 + module.get("k_vmp_pct", -0.34) / 100.0 * (t_cell_max_c - 25))
    limit_v = min(inverter["max_dc_v"], module.get("max_system_v", inverter["max_dc_v"]))
    n_max = int(math.floor(limit_v / voc_cold + 1e-9))
    n_max = min(n_max, int(math.floor(inverter["mppt_max_v"] / module["vmp_v"] + 1e-9)))
    n_min = int(math.ceil(inverter["mppt_min_v"] / vmp_hot - 1e-9))
    return {"voc_cold_v": voc_cold, "vmp_hot_v": vmp_hot, "n_min": n_min, "n_max": n_max}


def check_strings(req):
    """Check an array layout: modules per string, strings per MPPT, against the inverter."""
    module = get_module(req["module"])
    inverter = get_inverter(req["inverter"])
    n = int(req["modules_per_string"])
    per_mppt = [int(x) for x in req["strings_per_mppt"]]
    if n < 1 or not per_mppt or any(x < 0 for x in per_mppt):
        raise ValueError("Need at least 1 module per string and a non-negative strings-per-MPPT list")
    t_min = float(req.get("t_min_c", -5))
    t_cell_max = float(req.get("t_cell_max_c", 70))
    lim = string_limits(module, inverter, t_min, t_cell_max)
    voc_cold = n * lim["voc_cold_v"]
    vmp_hot = n * lim["vmp_hot_v"]
    vmp_stc = n * module["vmp_v"]
    worst_a = max(per_mppt) * module["isc_a"]
    limit_v = min(inverter["max_dc_v"], module.get("max_system_v", inverter["max_dc_v"]))
    checks = [
        {"id": "max_voltage", "ok": voc_cold <= limit_v, "value": round(voc_cold, 1), "limit": limit_v,
         "label": "Max system voltage (cold Voc)"},
        {"id": "mppt_min", "ok": vmp_hot >= inverter["mppt_min_v"], "value": round(vmp_hot, 1),
         "limit": inverter["mppt_min_v"], "label": "MPPT start window (hot Vmp)"},
        {"id": "mppt_max", "ok": vmp_stc <= inverter["mppt_max_v"], "value": round(vmp_stc, 1),
         "limit": inverter["mppt_max_v"], "label": "MPPT upper limit (Vmp at STC)"},
        {"id": "mppt_current", "ok": worst_a <= inverter["max_a_per_mppt"], "value": round(worst_a, 2),
         "limit": inverter["max_a_per_mppt"], "label": "MPPT input current"},
        {"id": "mppt_count", "ok": len(per_mppt) <= inverter["mppt_count"], "value": len(per_mppt),
         "limit": inverter["mppt_count"], "label": "MPPT inputs used"},
    ]
    total_modules = n * sum(per_mppt)
    kwp = total_modules * module["pmax_w"] / 1000.0
    return {"ok": all(c["ok"] for c in checks), "checks": checks, "n_min": lim["n_min"], "n_max": lim["n_max"],
            "voc_cold_per_module_v": round(lim["voc_cold_v"], 2), "vmp_hot_per_module_v": round(lim["vmp_hot_v"], 2),
            "string_isc_design_a": round(1.25 * module["isc_a"], 2),
            "total_modules": total_modules, "kwp": round(kwp, 3),
            "dc_ac_ratio": round(kwp / inverter["ac_kw"], 2)}


# ---------------------------------------------------------------- row spacing
def row_spacing(lat, tilt, module_length_m, hour_angle_deg=0.0, roof_depth_m=None):
    """Row pitch for tilted racks so no row shades the next at the design hour (winter solstice)."""
    dec = -23.45 if lat >= 0 else 23.45
    alpha = solar_elevation(lat, dec, hour_angle_deg)
    if alpha <= 0.5:
        raise ValueError("The sun is not up at the chosen design hour")
    b = tilt * RAD
    pitch = module_length_m * math.cos(b) + module_length_m * math.sin(b) / math.tan(alpha * RAD)
    out = {"sun_elevation_deg": round(alpha, 2), "pitch_m": round(pitch, 3),
           "ground_cover_ratio": round(module_length_m / pitch, 3)}
    if roof_depth_m is not None:
        span = module_length_m * math.cos(b)
        out["rows"] = int(math.floor((roof_depth_m - span) / pitch + 1e-9)) + 1 if roof_depth_m >= span else 0
    return out
