"""Hourly PV energy model on a PVGIS typical year (8760 h): Perez transposition, angle-of-incidence loss,
cell-temperature derate, inverter efficiency curve with AC clipping, and year-by-year degradation.

Why it exists: the monthly Klein-day model in solar_pv.py is screening grade (about +-12 % annual against PVGIS on the
bundled table). This model reads the hourly irradiance (GHI, beam normal, diffuse) and air temperature the PVGIS lookup
caches, so clipping, incidence angle and sky-diffuse anisotropy are modelled instead of lumped.

Chain per hour (all numpy-vectorised):
  1. sun position from the time stamp (Spencer declination and equation of time, solar time from longitude)
  2. plane-of-array irradiance: beam = DNI cos(theta); sky diffuse = Perez (1990, all-sites composite) or isotropic;
     ground-reflected = GHI * albedo * (1 - cos beta) / 2. Beam is zeroed when the sun is behind a horizon block.
  3. angle-of-incidence loss, ASHRAE b0 = 0.05 on the beam, and on diffuse / ground at the equivalent incidence angles of
     Brandemuehl & Beckman (sky 59.7 - 0.1388 beta + 0.001497 beta^2, ground 90 - 0.5788 beta + 0.002693 beta^2)
  4. cell temperature = air + (NOCT - 20) / 800 * G_poa; power = kWp * G_eff / 1000 * (1 + gamma (Tc - 25))
  5. DC-side losses (soiling, mismatch, DC wiring) -> inverter: Ploss = Prated (a + b x + c x^2), x = Pdc / Prated, with c
     set so the European-weighted efficiency equals the inverter's stated efficiency, then clipped at the AC rating
     -> AC-side losses (AC wiring, availability)
Not modelled: spectral and low-light losses, snow, wind cooling, per-string / substring shading (WP4).
Year-by-year: first-year LID then an annual rate; `annual_kwh` stays the as-new typical year so it can be compared with
PVGIS, the `lifetime` table carries the degradation.
"""
import math

import numpy as np

from .pv_data import DEFAULT_LOSSES

RAD = math.pi / 180.0
GSC = 1367.0
ALBEDO = 0.2
AOI_B0 = 0.05
SOILING_DC = ("soiling", "mismatch", "dc_wiring")
AC_SIDE = ("ac_wiring", "availability")
MONTH_START = np.cumsum([0] + [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])[:12]
EURO_W = [(0.05, 0.03), (0.10, 0.06), (0.20, 0.13), (0.30, 0.10), (0.50, 0.48), (1.00, 0.20)]
A_LOSS = 0.002   # standby / no-load loss, fraction of rated DC power
B_LOSS = 0.002   # linear loss term

# Perez 1990 all-sites composite coefficients, per clearness bin: F11 F12 F13 F21 F22 F23
_PEREZ_EDGES = np.array([1.0, 1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2])
_PEREZ = np.array([
    [-0.0083117, 0.5877285, -0.0620636, -0.0596012, 0.0721249, -0.0220216],
    [0.1299457, 0.6825954, -0.1513752, -0.0189325, 0.0659650, -0.0288748],
    [0.3296958, 0.4868735, -0.2210958, 0.0554140, -0.0639588, -0.0260542],
    [0.5682053, 0.1874525, -0.2951290, 0.1088631, -0.1519229, -0.0139754],
    [0.8730280, -0.3920403, -0.3616149, 0.2255647, -0.4620442, 0.0012448],
    [1.1326077, -1.2367284, -0.4118494, 0.2877813, -0.8230357, 0.0558651],
    [1.0601591, -1.5999137, -0.3589221, 0.2642124, -1.1272340, 0.1310694],
    [0.6777470, -0.3272588, -0.2504286, 0.1561313, -1.3765031, 0.2506212]])


def _sun(tmy):
    """Per hour: sun elevation (rad), azimuth from north (rad), day of year, month index, extraterrestrial normal W/m2."""
    ts = tmy["time"]
    mon = np.array([int(t[4:6]) for t in ts])
    day = np.array([int(t[6:8]) for t in ts])
    hh = np.array([int(t[9:11]) + int(t[11:13]) / 60.0 for t in ts])
    n = MONTH_START[mon - 1] + day                      # day of year, non-leap
    b = 2 * math.pi * (n - 1) / 365.0
    dec = (0.006918 - 0.399912 * np.cos(b) + 0.070257 * np.sin(b) - 0.006758 * np.cos(2 * b)
           + 0.000907 * np.sin(2 * b) - 0.002697 * np.cos(3 * b) + 0.00148 * np.sin(3 * b))
    eot = 229.18 * (0.000075 + 0.001868 * np.cos(b) - 0.032077 * np.sin(b) - 0.014615 * np.cos(2 * b)
                    - 0.04089 * np.sin(2 * b))          # minutes
    st = hh + float(tmy.get("time_offset_h", 0.0)) + tmy["lon"] / 15.0 + eot / 60.0
    w = (st - 12.0) * 15.0 * RAD
    phi = tmy["lat"] * RAD
    sin_el = np.sin(phi) * np.sin(dec) + np.cos(phi) * np.cos(dec) * np.cos(w)
    el = np.arcsin(np.clip(sin_el, -1, 1))
    east = -np.cos(dec) * np.sin(w)
    north = np.sin(dec) * np.cos(phi) - np.cos(dec) * np.sin(phi) * np.cos(w)
    az = np.arctan2(east, north) % (2 * math.pi)
    i0n = GSC * (1 + 0.033 * np.cos(2 * math.pi * n / 365.0))
    return el, az, mon - 1, i0n


def _aoi_factor(cos_i):
    """ASHRAE incidence-angle modifier, 1 at normal incidence, 0 at or past grazing."""
    c = np.clip(cos_i, 1e-3, 1.0)
    return np.where(cos_i <= 0, 0.0, np.clip(1 - AOI_B0 * (1.0 / c - 1), 0, 1))


def plane_of_array(tmy, tilt, azimuth_n, transposition="perez", horizon=None):
    """Hourly POA components (W/m2): beam, sky diffuse, ground, plus cos(incidence) and hours the horizon blocked."""
    el, az, mon, i0n = _sun(tmy)
    ghi = np.asarray(tmy["ghi_w_m2"], float)
    dni = np.asarray(tmy["dni_w_m2"], float)
    dhi = np.asarray(tmy["dhi_w_m2"], float)
    beta = tilt * RAD
    gam = azimuth_n * RAD
    zen = math.pi / 2 - el
    cos_z = np.sin(el)
    cos_i = np.sin(el) * math.cos(beta) + np.cos(el) * math.sin(beta) * np.cos(az - gam)
    up = el > 0.0
    beam_n = np.where(up, dni, 0.0)
    if horizon:
        blocked = np.zeros(len(el), bool)
        for a0, a1, e in horizon:
            a0r, a1r = a0 * RAD, a1 * RAD
            inside = (az >= a0r) & (az <= a1r) if a0r <= a1r else (az >= a0r) | (az <= a1r)
            blocked |= inside & (el < e * RAD)
        beam_n = np.where(blocked, 0.0, beam_n)
    beam = beam_n * np.maximum(cos_i, 0.0)
    ground = ghi * ALBEDO * (1 - math.cos(beta)) / 2.0
    if transposition == "isotropic":
        sky = dhi * (1 + math.cos(beta)) / 2.0
    else:
        with np.errstate(divide="ignore", invalid="ignore"):
            kz = 1.041 * zen ** 3
            eps = np.where(dhi > 0, ((dhi + dni) / dhi + kz) / (1 + kz), 1.0)
            am = 1.0 / (np.cos(zen) + 0.50572 * (96.07995 - np.degrees(zen)) ** -1.6364)   # Kasten & Young 1989
            delta = np.where(dhi > 0, dhi * am / i0n, 0.0)
        k = np.searchsorted(_PEREZ_EDGES, eps, side="right") - 1
        k = np.clip(k, 0, 7)
        f = _PEREZ[k]
        f1 = np.maximum(0.0, f[:, 0] + f[:, 1] * delta + f[:, 2] * zen)
        f2 = f[:, 3] + f[:, 4] * delta + f[:, 5] * zen
        a = np.maximum(0.0, cos_i)
        b = np.maximum(math.cos(85 * RAD), cos_z)
        sky = dhi * ((1 - f1) * (1 + math.cos(beta)) / 2.0 + f1 * a / b + f2 * math.sin(beta))
        sky = np.maximum(sky, 0.0)
    sky = np.where(up, sky, 0.0)
    ground = np.where(up, ground, 0.0)
    return {"beam": beam, "sky": sky, "ground": ground, "cos_i": cos_i, "mon": mon,
            "poa": beam + sky + ground, "ghi": ghi}


def _eff_curve_c(eff):
    """Quadratic coefficient c of the inverter loss so the Euro-weighted efficiency equals eff (fraction)."""
    s1 = sum(w / x for x, w in EURO_W)
    s3 = sum(w * x for x, w in EURO_W)
    return max(0.0, (1 - eff - A_LOSS * s1 - B_LOSS) / s3)


def inverter_ac(pdc_kw, ac_kw, eff_pct):
    """AC output (kW) per hour for DC input `pdc_kw` into an inverter rated `ac_kw` with stated efficiency; plus the kWh clipped."""
    eff = eff_pct / 100.0
    prated = ac_kw / eff
    x = pdc_kw / prated
    c = _eff_curve_c(eff)
    loss = prated * (A_LOSS + B_LOSS * x + c * x * x)
    pac = np.where(pdc_kw > 0, pdc_kw - loss, 0.0)
    pac = np.maximum(pac, 0.0)
    unclipped = pac
    return np.minimum(unclipped, ac_kw), float(np.sum(np.maximum(unclipped - ac_kw, 0.0)))


def hourly_yield(tmy, kwp, tilt, azimuth_n, module, losses=None, inverter_eff_pct=None, horizon=None, ac_kw=None,
                 transposition="perez", lid_pct=None, degradation_pct=None):
    """Monthly and annual AC energy for kwp at one orientation from the hourly year. Same result shape as
    solar_pv.energy_yield, plus clipping and the lifetime table."""
    loss = dict(DEFAULT_LOSSES)
    loss.update(losses or {})
    gamma = module.get("k_pmax_pct", -0.35) / 100.0
    noct = module.get("noct_c", 44)
    p = plane_of_array(tmy, tilt, azimuth_n, transposition, horizon)
    beta = tilt * RAD
    cos_i = p["cos_i"]
    f_beam = _aoi_factor(cos_i)
    th_sky = (59.7 - 0.1388 * tilt + 0.001497 * tilt ** 2) * RAD
    th_gnd = (90.0 - 0.5788 * tilt + 0.002693 * tilt ** 2) * RAD
    f_sky = float(_aoi_factor(np.array(math.cos(th_sky))))
    f_gnd = float(_aoi_factor(np.array(math.cos(th_gnd))))
    g_eff = p["beam"] * f_beam + p["sky"] * f_sky + p["ground"] * f_gnd
    tair = np.asarray(tmy["t2m_c"], float)
    tcell = tair + (noct - 20.0) / 800.0 * p["poa"]
    pdc = kwp * g_eff / 1000.0 * (1 + gamma * (tcell - 25.0))
    pdc = np.where(g_eff > 0, pdc, 0.0)
    dc_f = 1.0
    for k in SOILING_DC:
        dc_f *= 1 - loss[k]
    ac_f = 1.0
    for k in AC_SIDE:
        ac_f *= 1 - loss[k]
    pdc = pdc * dc_f
    clip_kwh = 0.0
    if ac_kw and inverter_eff_pct:
        pac, clip_kwh = inverter_ac(pdc, ac_kw, inverter_eff_pct)
        pac = pac * ac_f
        clip_kwh *= ac_f
    else:
        eff = (inverter_eff_pct / 100.0) if inverter_eff_pct else (1 - loss["inverter"])
        pac = pdc * eff * ac_f
    months, annual, poa_y, ghi_y = [], 0.0, 0.0, 0.0
    mon = p["mon"]
    for m in range(12):
        sel = mon == m
        e = float(pac[sel].sum())
        poa_m = float(p["poa"][sel].sum()) / 1000.0
        ghi_m = float(p["ghi"][sel].sum()) / 1000.0
        months.append({"month": m + 1, "ghi_kwh_m2": round(ghi_m, 1), "poa_kwh_m2": round(poa_m, 1),
                       "pr": round(e / (kwp * poa_m), 4) if kwp > 0 and poa_m > 0 else 0.0, "kwh": round(e, 1)})
        annual += e
        poa_y += poa_m
        ghi_y += ghi_m
    lid = 1.0 if lid_pct is None else lid_pct
    deg = 0.4 if degradation_pct is None else degradation_pct
    years = [{"year": y, "kwh": round(annual * (1 - lid / 100.0) * (1 - deg / 100.0) ** (y - 1), 0)} for y in range(1, 26)]
    return {"months": months, "annual_kwh": round(annual, 0),
            "specific_yield_kwh_kwp": round(annual / kwp, 0) if kwp > 0 else 0.0,
            "ghi_kwh_m2_year": round(ghi_y, 0), "poa_kwh_m2_year": round(poa_y, 0),
            "performance_ratio": round(annual / (kwp * poa_y), 3) if kwp > 0 and poa_y > 0 else 0.0,
            "clipping_kwh": round(clip_kwh, 0),
            "clipping_loss_pct": round(100.0 * clip_kwh / (annual + clip_kwh), 2) if annual + clip_kwh > 0 else 0.0,
            "lifetime": years, "lid_pct": lid, "degradation_pct_yr": deg, "model": f"hourly, {transposition} sky"}
