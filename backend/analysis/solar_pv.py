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

**DC protection** (phase 3, IEC 62548 / 60364-7-712 style): string overcurrent protection is
required where 3 or more strings share an input ((n - 1) x Isc can exceed a module's
reverse-current rating); gPV fuse In >= 1.5 x Isc, rounded up to a standard size and
never above the module's maximum series fuse. DC isolator current >= 1.25 x Isc x
strings on the input, voltage >= cold Voc of the string. DC string cable: smallest
PV1-F size whose current rating (free air at 60 degC, typical manufacturer data) is
>= 1.25 x Isc and whose two-way voltage drop (rho 0.0206 ohm mm2/m, copper at 70 degC)
is within the limit. The export limit is checked at the connection point. Everything
electrical beyond this (string voltage / current checks, fault contribution, voltage
rise, loading, hosting capacity) is done by the app's existing engines on the placed
PV component, never here.

**Shading (phase 4)**: obstructions (parapet, vent, tree, neighbouring building) become
horizon blocks. A block of height h at distance d, bearing b and width w covers
azimuths b +- atan(w / 2d) up to elevation atan(h / d). In the hourly integration
the beam is zero whenever the sun is behind a block; diffuse and ground-reflected
irradiance are unchanged (a conservative simplification).

**Row spacing** for tilted racks: pitch = L cos(beta) + L sin(beta) / tan(alpha),
alpha the solar elevation at the design hour on the winter solstice.
"""
import math

from . import pvgis_tmy, solar_hourly
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


def solar_azimuth_n(lat, dec, hour_angle):
    """Solar azimuth in degrees from north (0 = north, 90 = east), either hemisphere."""
    w, p, d = hour_angle * RAD, lat * RAD, dec * RAD
    east = -math.cos(d) * math.sin(w)
    north = math.sin(d) * math.cos(p) - math.cos(d) * math.sin(p) * math.cos(w)
    return math.degrees(math.atan2(east, north)) % 360.0


def obstruction_block(height_m, distance_m, bearing_deg, width_m):
    """An obstruction as a horizon block: (azimuth from, azimuth to, elevation) in degrees."""
    if height_m <= 0 or distance_m <= 0 or width_m <= 0:
        raise ValueError("Obstruction height, distance and width must be positive")
    half = math.degrees(math.atan((width_m / 2.0) / distance_m))
    return ((bearing_deg - half) % 360.0, (bearing_deg + half) % 360.0,
            math.degrees(math.atan(height_m / distance_m)))


def _blocked(blocks, az, elev):
    for a0, a1, e in blocks or ():
        inside = (a0 <= az <= a1) if a0 <= a1 else (az >= a0 or az <= a1)
        if inside and elev < e:
            return True
    return False


def daily_poa(lat, n, h_horizontal, tilt, azimuth_n, horizon=None):
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
        if horizon and _blocked(horizon, solar_azimuth_n(lat, dec, w), math.asin(max(-1.0, min(1.0, cos_z))) / RAD):
            beam_t = 0.0
        total += (beam_t + dif * (1 + math.cos(beta)) / 2.0
                  + g * ALBEDO * (1 - math.cos(beta)) / 2.0)
    return total, hd


# ---------------------------------------------------------------- data lookups
def get_city(name):
    if isinstance(name, dict):      # a site already resolved (e.g. from PVGIS data): lat, ghi_kwh_m2_day, tday_c
        return name
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


def resolve_site(req):
    """The irradiance site for a request: (site dict, info dict for the result).

    `irradiance_source` 'pvgis' with `lat` / `lon` (else the named location's coordinates) takes the monthly means from the
    hourly PVGIS typical year; if PVGIS can't be reached the bundled table is used and the result says so. Anything else
    is the bundled table, labelled screening grade.
    """
    name = req.get("location", "Pretoria")
    table = get_city(name)
    table_info = {"irradiance_source": "Bundled monthly table (screening grade)", "data_note": SOURCE_NOTE,
                  "model": "monthly representative day, isotropic sky"}
    if req.get("irradiance_source") != "pvgis":
        return table, table_info
    lat = req["lat"] if req.get("lat") is not None else table["lat"]
    lon = req["lon"] if req.get("lon") is not None else table["lon"]
    try:
        tmy = pvgis_tmy.get_tmy(lat, lon)
    except pvgis_tmy.PvgisUnavailable as e:
        table_info["data_note"] = "PVGIS could not be reached, so the bundled monthly table was used. " + SOURCE_NOTE
        table_info["pvgis_error"] = str(e)
        return table, table_info
    site = dict(table)
    site.update(pvgis_tmy.monthly_summary(tmy))
    site["tmy"] = tmy
    site["transposition"] = req.get("transposition") or "perez"
    if site["transposition"] not in ("perez", "isotropic"):
        raise ValueError("transposition must be perez or isotropic")
    site["lid_pct"] = req.get("lid_pct")
    site["degradation_pct"] = req.get("degradation_pct")
    site["lat"] = float(lat)
    site["lon"] = float(lon)
    label = pvgis_tmy.source_label(tmy)
    return site, {"irradiance_source": label, "data_note": label + "; hourly model, " + site["transposition"]
                  + " sky, incidence-angle loss, inverter clipping. " + pvgis_tmy.ATTRIBUTION,
                  "attribution": pvgis_tmy.ATTRIBUTION, "model": "hourly, " + site["transposition"] + " sky"}


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
def energy_yield(city_name, kwp, tilt, azimuth_n, module, losses=None, inverter_eff_pct=None, horizon=None, ac_kw=None, eff_curve=None):
    """Monthly and annual AC energy for kwp of modules at one orientation.

    A site carrying an hourly year (`tmy`, from resolve_site) uses the hourly model, with AC clipping at `ac_kw`;
    otherwise the monthly representative-day model."""
    city = get_city(city_name)
    if kwp < 0 or not 0 <= tilt <= 90:
        raise ValueError("kWp must be >= 0 and tilt between 0 and 90 degrees")
    if city.get("tmy"):
        return solar_hourly.hourly_yield(city["tmy"], kwp, tilt, azimuth_n, module, losses, inverter_eff_pct, horizon, ac_kw,
                                         city.get("transposition", "perez"), city.get("lid_pct"), city.get("degradation_pct"), eff_curve=eff_curve)
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
        poa, _ = daily_poa(city["lat"], REP_DAY[i], h, tilt, azimuth_n, horizon)
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


def _allocate(total, weights):
    """Split a whole-number total over weights by largest remainder."""
    w = float(sum(weights))
    if total <= 0 or w <= 0:
        return [0] * len(weights)
    raw = [total * x / w for x in weights]
    out = [int(math.floor(x)) for x in raw]
    for i in sorted(range(len(raw)), key=lambda k: raw[k] - out[k], reverse=True)[: total - sum(out)]:
        out[i] += 1
    return out


def _target_modules(req, module):
    """Modules for the design's kWp target (`target_kwp`, the array size the designer sets; the load plays no part)."""
    if req.get("target_kwp") is None or float(req["target_kwp"]) <= 0:
        raise ValueError("mode 'kwp' needs target_kwp > 0")
    return max(1, int(round(float(req["target_kwp"]) * 1000.0 / module["pmax_w"])))


def curve_note(module, inverter):
    """Where the incidence loss and the inverter efficiency came from (hourly model): the manufacturer's data when an imported part has it."""
    return {"incidence": "manufacturer's table" if module.get("iam_profile") else "ASHRAE, b0 0.05",
            "inverter": "manufacturer's curve" if inverter and inverter.get("eff_curve") else "generic curve at the stated efficiency"}


def run_solar_arrays(req, module, city, inverter):
    """Several roof planes, each with its own area, tilt and azimuth (roofs drawn on the plan).

    Roof capacity is the sum of each plane's modules. The load target uses the capacity-weighted
    specific yield. The chosen module count is shared over the planes in proportion to their
    capacity (largest remainder), and each plane's yield is worked out at its own orientation.
    """
    mode = req.get("mode", "min")
    if mode not in ("roof", "load", "min", "kwp"):
        raise ValueError("mode must be roof, load, min or kwp")
    arrays = req["arrays"]
    if not arrays:
        raise ValueError("No roofs given")
    horizon = [obstruction_block(o["height_m"], o["distance_m"], o["bearing_deg"], o.get("width_m", 5.0))
               for o in (req.get("obstructions") or [])] or None

    def horizon_of(a):
        # the request's obstructions plus this array's own (the other roofs seen from it)
        own = [obstruction_block(o["height_m"], o["distance_m"], o["bearing_deg"], o.get("width_m", 5.0))
               for o in (a.get("obstructions") or [])]
        return ((horizon or []) + own) or None

    caps, specs = [], []
    for a in arrays:
        caps.append(modules_from_area(float(a["area_m2"]), float(a.get("packing", 0.8)), module))
        specs.append(energy_yield(city, 1.0, float(a["tilt_deg"]), float(a.get("azimuth_deg", 0)), module,
                                  req.get("losses"), horizon=horizon_of(a))["annual_kwh"])
    # a roof's own "maximum panels": the arrays sharing a `group` (one roof's planes) hold at most `max_modules` together
    groups = {}
    for i, a in enumerate(arrays):
        if a.get("max_modules") is not None and float(a["max_modules"]) >= 0:
            groups.setdefault(a.get("group") or a.get("name") or i, (int(float(a["max_modules"])), []))[1].append(i)
    for limit, idx in groups.values():
        if sum(caps[i] for i in idx) > limit:
            for i, n in zip(idx, _allocate(limit, [caps[i] for i in idx])):
                caps[i] = n
    target_mods = _target_modules(req, module) if mode == "kwp" else None
    # an array with `modules` is already laid out (Place array on the plan): that count is the design, whatever the mode
    fixed = {}
    if mode in ("roof", "kwp"):
        for i, a in enumerate(arrays):
            if a.get("modules") is not None and float(a["modules"]) >= 0:
                fixed[i] = int(float(a["modules"]))
                caps[i] = fixed[i]
    free = [i for i in range(len(arrays)) if i not in fixed]
    fixed_total = sum(fixed.values())
    roof_total = sum(caps)
    spec = (sum(c * sp for c, sp in zip(caps, specs)) / roof_total) if roof_total else (sum(specs) / len(specs))
    load_mods = None
    if req.get("annual_kwh") is not None:
        load_mods = modules_from_load(float(req["annual_kwh"]), float(req.get("share_pct", 70)) / 100.0, spec, module)
    if mode == "kwp":
        total = fixed_total + min(sum(caps[i] for i in free), max(0, target_mods - fixed_total))
        limited = "target" if target_mods <= roof_total else "roof"
    elif mode == "roof" or (mode == "min" and load_mods is None):
        total, limited = roof_total, "roof"
    elif mode == "load" or roof_total == 0:
        if load_mods is None:
            raise ValueError("mode 'load' needs annual_kwh")
        total, limited = load_mods, "load"
    else:
        total = min(roof_total, load_mods)
        limited = "roof" if roof_total <= load_mods else "load"
    if fixed:
        got = dict(zip(free, _allocate(total - fixed_total, [caps[i] for i in free]) if free else []))
        shares = [fixed[i] if i in fixed else got[i] for i in range(len(arrays))]
    else:
        shares = _allocate(total, caps if roof_total else [1] * len(arrays))
    months = [0.0] * 12
    parts, annual, kwp_total, poa_w, clip, life = [], 0.0, 0.0, 0.0, 0.0, None
    ac_total = inverter["ac_kw"] * req.get("num_inverters", 1) if inverter else None
    all_kwp = sum(shares) * module["pmax_w"] / 1000.0
    for idx, (a, n, cap) in enumerate(zip(arrays, shares, caps)):
        kwp = round(n * module["pmax_w"] / 1000.0, 3)
        y = energy_yield(city, kwp, float(a["tilt_deg"]), float(a.get("azimuth_deg", 0)), module, req.get("losses"),
                         inverter["efficiency_pct"] if inverter else None, horizon_of(a),
                         ac_total * kwp / all_kwp if ac_total and all_kwp else None, inverter.get("eff_curve") if inverter else None)
        clip += y.get("clipping_kwh", 0.0)
        if "lifetime" in y:
            life = [{"year": r["year"], "kwh": (life[i]["kwh"] if life else 0) + r["kwh"]} for i, r in enumerate(y["lifetime"])]
        for i, m in enumerate(y["months"]):
            months[i] += m["kwh"]
        annual += y["annual_kwh"]
        kwp_total += kwp
        parts.append({"name": a.get("name"), "modules": n, "modules_roof": cap, "laid_out": idx in fixed, "kwp": kwp, "tilt_deg": a["tilt_deg"],
                      "azimuth_deg": a.get("azimuth_deg", 0), "annual_kwh": y["annual_kwh"]})
    out = {"location": req.get("location", "Pretoria"), "mode": mode, "limited_by": limited,
           "modules_roof": roof_total, "modules_load": load_mods, "modules_target": target_mods, "target_kwp": float(req["target_kwp"]) if target_mods else None, "modules": total, "kwp": round(kwp_total, 3),
           "annual_kwh": round(annual, 0),
           "specific_yield_kwh_kwp": round(annual / kwp_total, 0) if kwp_total else 0.0,
           "months": [{"month": i + 1, "kwh": round(v, 1)} for i, v in enumerate(months)],
           "arrays": parts, "tilt_deg": None, "azimuth_deg": None, "performance_ratio": None,
           "data_note": SOURCE_NOTE, "exceeds_roof": total > roof_total}
    if city.get("tmy"):
        out["clipping_kwh"] = round(clip, 0)
        out["curves"] = curve_note(module, inverter)
        out["lifetime"] = life
        out["clipping_loss_pct"] = round(100.0 * clip / (annual + clip), 2) if annual + clip > 0 else 0.0
    if req.get("annual_kwh"):
        out["load_share_pct"] = round(100.0 * annual / float(req["annual_kwh"]), 1)
    if inverter:
        out["dc_ac_ratio"] = round(kwp_total / (inverter["ac_kw"] * req.get("num_inverters", 1)), 2)
    return out


def run_solar_size(req):
    """Phase 1: size from roof area and / or load, then the yield of the chosen size."""
    module = get_module(req.get("module", "pv_550_mono"))
    name = req.get("location", "Pretoria")
    city, info = resolve_site(req)
    if req.get("arrays"):
        out = run_solar_arrays(req, module, city, get_inverter(req["inverter"]) if req.get("inverter") else None)
        out.update(info)
        return out
    tilt = float(req.get("tilt_deg", 20))
    az = float(req.get("azimuth_deg", 0))
    mode = req.get("mode", "min")
    if mode not in ("roof", "load", "min", "kwp"):
        raise ValueError("mode must be roof, load, min or kwp")
    # specific yield of one kWp at this orientation sets the load-based size
    ref = energy_yield(city, 1.0, tilt, az, module, req.get("losses"))
    spec = ref["annual_kwh"]
    roof_mods = load_mods = None
    if req.get("usable_area_m2") is not None:
        roof_mods = modules_from_area(float(req["usable_area_m2"]), float(req.get("packing", 0.8)), module)
    if req.get("annual_kwh") is not None:
        load_mods = modules_from_load(float(req["annual_kwh"]), float(req.get("share_pct", 70)) / 100.0, spec, module)
    cands = {"roof": roof_mods, "load": load_mods}
    target_mods = _target_modules(req, module) if mode == "kwp" else None
    if mode == "kwp":
        modules = target_mods if roof_mods is None else min(target_mods, roof_mods)
        limited_by = "target" if roof_mods is None or target_mods <= roof_mods else "roof"
    elif mode == "min":
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
    horizon = [obstruction_block(o["height_m"], o["distance_m"], o["bearing_deg"], o.get("width_m", 5.0))
               for o in (req.get("obstructions") or [])]
    ac_kw = inverter["ac_kw"] * req.get("num_inverters", 1) if inverter else None
    y = energy_yield(city, kwp, tilt, az, module, req.get("losses"),
                     inverter["efficiency_pct"] if inverter else None, horizon or None, ac_kw, inverter.get("eff_curve") if inverter else None)
    out = {"location": name, "tilt_deg": tilt, "azimuth_deg": az, "mode": mode, "limited_by": limited_by,
           "modules_roof": roof_mods, "modules_load": load_mods, "modules_target": target_mods, "target_kwp": float(req["target_kwp"]) if target_mods else None, "modules": modules, "kwp": kwp,
           "annual_kwh": y["annual_kwh"], "specific_yield_kwh_kwp": y["specific_yield_kwh_kwp"],
           "performance_ratio": y["performance_ratio"], "poa_kwh_m2_year": y["poa_kwh_m2_year"],
           "ghi_kwh_m2_year": y["ghi_kwh_m2_year"], "months": y["months"],
           "data_note": SOURCE_NOTE}
    for k in ("clipping_kwh", "clipping_loss_pct", "lifetime"):
        if k in y:
            out[k] = y[k]
    if city.get("tmy"):
        out["curves"] = curve_note(module, inverter)
    if horizon:
        clear = energy_yield(city, kwp, tilt, az, module, req.get("losses"),
                             inverter["efficiency_pct"] if inverter else None, None, ac_kw, inverter.get("eff_curve") if inverter else None)
        out["shading_loss_pct"] = round(100.0 * (1 - y["annual_kwh"] / clear["annual_kwh"]), 2) if clear["annual_kwh"] else 0.0
        out["unshaded_annual_kwh"] = clear["annual_kwh"]
    if req.get("annual_kwh"):
        out["load_share_pct"] = round(100.0 * y["annual_kwh"] / float(req["annual_kwh"]), 1)
    if inverter:
        out["dc_ac_ratio"] = round(kwp / (inverter["ac_kw"] * req.get("num_inverters", 1)), 2)
    out.update(info)
    return out


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


# ---------------------------------------------------------------- DC / AC protection
FUSE_SIZES_A = [10, 12, 15, 16, 20, 25, 30, 32, 40, 50, 63]
# PV1-F cable, current rating in A (free air, 60 degC ambient, typical manufacturer data)
PV_CABLE_A = {2.5: 41, 4: 55, 6: 70, 10: 98, 16: 132, 25: 176}
RHO_CU_70 = 0.0206  # ohm mm2 / m
STANDARD_DC_ISOLATORS_A = [16, 25, 32, 40, 63, 80, 125]


def _next_up(sizes, x):
    for v in sizes:
        if v >= x - 1e-9:
            return v
    return None


def size_protection(req):
    """Phase 3: string fuses, DC isolator, DC string cable and the export limit (the rest is the app's own studies)."""
    module = get_module(req["module"])
    inverter = get_inverter(req["inverter"])
    n = int(req["modules_per_string"])
    per_mppt = [int(x) for x in req["strings_per_mppt"]]
    if n < 1 or not per_mppt:
        raise ValueError("Need modules per string and strings per MPPT")
    length = float(req.get("string_cable_m", 30))
    vd_limit = float(req.get("vd_limit_pct", 1.0))
    num_inv = int(req.get("num_inverters", 1))
    if length <= 0 or vd_limit <= 0 or num_inv < 1:
        raise ValueError("Cable length, voltage-drop limit and inverter count must be positive")
    isc = module["isc_a"]
    worst = max(per_mppt)
    items = []
    # string overcurrent protection
    fuse_needed = worst >= 3
    max_fuse = float(module.get("max_fuse_a", 25))
    fuse = None
    if fuse_needed:
        want = 1.5 * isc
        fuse = _next_up(FUSE_SIZES_A, want)
        ok = fuse is not None and fuse <= max_fuse
        items.append({"id": "string_fuse", "ok": ok, "rating_a": fuse, "required": True,
                      "label": f"String fuse gPV {fuse} A (>= 1.5 x Isc = {want:.1f} A, module max {max_fuse:g} A)"
                      if fuse else "No standard fuse fits", "min_a": round(want, 2), "max_a": max_fuse})
    else:
        items.append({"id": "string_fuse", "ok": True, "rating_a": None, "required": False,
                      "label": f"No string fuse needed ({worst} string(s) per input; required from 3)"})
    # DC isolator
    voc_cold_string = n * module["voc_v"] * (1 + module.get("k_voc_pct", -0.27) / 100.0
                                             * (float(req.get("t_min_c", -5)) - 25))
    iso_a = _next_up(STANDARD_DC_ISOLATORS_A, 1.25 * isc * worst)
    items.append({"id": "dc_isolator", "ok": iso_a is not None, "rating_a": iso_a,
                  "voltage_v": round(voc_cold_string, 0),
                  "label": f"DC isolator {iso_a} A, at least {voc_cold_string:.0f} V DC" if iso_a else "No standard isolator fits"})
    # DC string cable
    need_a = 1.25 * isc
    chosen = None
    for size, amp in PV_CABLE_A.items():
        if amp < need_a:
            continue
        vd = 2 * length * isc * RHO_CU_70 / size
        vd_pct = 100.0 * vd / (n * module["vmp_v"])
        if vd_pct <= vd_limit:
            chosen = {"size_mm2": size, "rating_a": amp, "vd_v": round(vd, 2), "vd_pct": round(vd_pct, 2)}
            break
    items.append({"id": "dc_cable", "ok": chosen is not None, "cable": chosen,
                  "label": (f"DC string cable {chosen['size_mm2']} mm2 PV1-F, drop {chosen['vd_pct']} % over {length:g} m"
                            if chosen else f"No PV cable up to 25 mm2 keeps the drop within {vd_limit} %")})
    total_kw = inverter["ac_kw"] * num_inv
    out = {"items": items, "ok": all(i["ok"] for i in items), "total_ac_kw": total_kw}
    limit = req.get("export_limit_kw")
    if limit is not None:
        limit = float(limit)
        out["export_limit_kw"] = limit
        out["export_limited"] = total_kw > limit
        out["export_note"] = (f"Inverter output {total_kw:g} kW exceeds the {limit:g} kW export limit at the connection point; "
                              f"set the inverter's export control to {limit:g} kW" if total_kw > limit
                              else f"Within the {limit:g} kW export limit")
    return out


def sun_position(lat, hour_angle_deg=0.0, month=None):
    """Solar elevation and azimuth (degrees from north) at an hour angle: on the winter solstice, or (month 1-12) on the
    middle day of that month, when the sun's declination, and so its path across the sky, is different."""
    if month:
        dec = declination(REP_DAY[int(month) - 1])
    else:
        dec = -23.45 if lat >= 0 else 23.45
    elev = solar_elevation(lat, dec, hour_angle_deg)
    az = solar_azimuth_n(lat, dec, hour_angle_deg)
    if az > 359.99:
        az = 0.0
    return {"elevation_deg": round(elev, 2), "azimuth_deg": round(az, 2), "declination_deg": dec}


# ---------------------------------------------------------------- annual shading from the 3D scene
def run_solar_shading(req):
    """Annual shading loss from per-module shade flags worked out in the 3D roof scene.

    `arrays`: [{name, tilt_deg, azimuth_deg, modules, per_string, shade}] where `shade` is one string of '0' / '1' per
    module, one character per entry of `solar_hourly.sun_samples(lat)` (1 = that module's beam is blocked). Modules are
    chunked into strings of `per_string` in layout order. A string loses beam energy in proportion to its shaded modules
    (diffuse and ground-reflected stay); it is then run through the same hourly model as the unshaded array, with the
    inverter's AC capacity shared by kWp. Needs the PVGIS hourly year.
    """
    module = get_module(req.get("module", "pv_550_mono"))
    site, info = resolve_site(dict(req, irradiance_source="pvgis"))
    if not site.get("tmy"):
        raise ValueError("Annual shading needs the PVGIS hourly data, which could not be reached")
    tmy = site["tmy"]
    inverter = get_inverter(req["inverter"]) if req.get("inverter") else None
    arrays = req.get("arrays") or []
    if not arrays:
        raise ValueError("No roofs given")
    samples = solar_hourly.sun_samples(site["lat"])
    idx = solar_hourly.hour_index(tmy)
    all_mods = sum(int(a["modules"]) for a in arrays)
    if all_mods <= 0:
        raise ValueError("No modules to check")
    ac_total = inverter["ac_kw"] * req.get("num_inverters", 1) if inverter else None
    eff = inverter["efficiency_pct"] if inverter else None
    curve = inverter.get("eff_curve") if inverter else None
    pmax = module["pmax_w"] / 1000.0
    opts = (site.get("transposition", "perez"), site.get("lid_pct"), site.get("degradation_pct"))
    un_m, sh_m = [0.0] * 12, [0.0] * 12
    strings_out = []
    for a in arrays:
        n = int(a["modules"])
        if n <= 0:
            continue
        shade = a.get("shade") or []
        if len(shade) != n or any(len(row) != len(samples) for row in shade):
            raise ValueError(f"Shade data for '{a.get('name')}' must be {n} modules x {len(samples)} sun positions")
        flags = [[1 if ch == "1" else 0 for ch in row] for row in shade]
        per = max(1, int(a.get("per_string") or n))
        tilt, az = float(a["tilt_deg"]), float(a.get("azimuth_deg", 0))
        for k0 in range(0, n, per):
            chunk = flags[k0:k0 + per]
            kwp = len(chunk) * pmax
            ac = ac_total * kwp / (all_mods * pmax) if ac_total else None
            frac = [sum(col) / len(chunk) for col in zip(*chunk)]
            bf = 1.0 - solar_hourly.shaded_fraction_by_hour(idx, samples, frac)
            clear = solar_hourly.hourly_yield(tmy, kwp, tilt, az, module, req.get("losses"), eff, None, ac, *opts, eff_curve=curve)
            shaded = solar_hourly.hourly_yield(tmy, kwp, tilt, az, module, req.get("losses"), eff, None, ac, *opts, beam_factor=bf, eff_curve=curve)
            for i in range(12):
                un_m[i] += clear["months"][i]["kwh"]
                sh_m[i] += shaded["months"][i]["kwh"]
            strings_out.append({"array": a.get("name"), "string": k0 // per + 1, "modules": len(chunk), "kwp": round(kwp, 3),
                                "unshaded_kwh": clear["annual_kwh"], "shaded_kwh": shaded["annual_kwh"],
                                "loss_pct": round(100.0 * (1 - shaded["annual_kwh"] / clear["annual_kwh"]), 2) if clear["annual_kwh"] else 0.0})
    un, sh = sum(un_m), sum(sh_m)
    return {"irradiance_source": info["irradiance_source"], "attribution": info.get("attribution"), "samples": len(samples),
            "unshaded_kwh": round(un, 0), "shaded_kwh": round(sh, 0), "loss_pct": round(100.0 * (1 - sh / un), 2) if un else 0.0,
            "months": [{"month": i + 1, "unshaded_kwh": round(un_m[i], 1), "shaded_kwh": round(sh_m[i], 1),
                        "loss_pct": round(100.0 * (1 - sh_m[i] / un_m[i]), 2) if un_m[i] else 0.0} for i in range(12)],
            "strings": strings_out,
            "note": "Beam shading from the 3D roof scene on the middle day of each month at every solar hour; a string loses beam energy "
                    "in proportion to its shaded modules. Replaces the horizon-based shading figure for these roofs."}


def sun_grid(req):
    """The sun positions the 3D scene must be checked at for this site (see solar_hourly.sun_samples)."""
    site = get_city(req.get("location", "Pretoria"))
    lat = float(req["lat"]) if req.get("lat") is not None else site["lat"]
    return {"lat": lat, "samples": solar_hourly.sun_samples(lat)}
