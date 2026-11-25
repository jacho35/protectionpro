"""PVGIS typical meteorological year (hourly) by latitude / longitude, cached.

Source: PVGIS of the European Commission Joint Research Centre, `api/v5_3/tmy` (radiation PVGIS-SARAH3 over Africa, air
temperature ERA5). PVGIS states its results are free to use, including in commercial software, provided the source is
acknowledged and the Commission's endorsement is not implied; the attribution below is shown wherever a result
built on this data is shown (results, reports). PVGIS gives no service guarantee, so every call can fail: callers
fall back to the bundled monthly table and say so.

Calls are server-side only (PVGIS refuses browser/AJAX access) and cached per coordinate rounded to 0.01 degree
(~1 km, finer than the satellite grid), in memory and on disk (`PVGIS_CACHE_DIR`, default `./pvgis_cache`), so a site is
fetched once. The PVGIS limit is 30 calls/s per IP; 429 / 529 are retried a couple of times, then PvgisUnavailable.
"""
import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.request

URL = "https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat={lat}&lon={lon}&outputformat=json"
ATTRIBUTION = "Data and calculations based on PVGIS – © European Union, Joint Research Centre"
DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

_mem = {}
_lock = threading.Lock()


class PvgisUnavailable(Exception):
    """PVGIS could not be reached or returned something unusable."""


def _cache_dir():
    return os.environ.get("PVGIS_CACHE_DIR", "./pvgis_cache")


def round_coord(x):
    return round(float(x), 2)


def _fetch(lat, lon):
    """One PVGIS call → parsed JSON. Isolated so tests can replace it."""
    url = URL.format(lat=lat, lon=lon)
    last = None
    for wait in (0, 1.0, 3.0):
        if wait:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 529):
                break
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            last = e
    raise PvgisUnavailable(f"PVGIS request failed: {last}")


def _compact(raw, lat, lon):
    """PVGIS JSON → hourly arrays (8760) + provenance. Raises PvgisUnavailable if the shape is wrong."""
    try:
        rows = raw["outputs"]["tmy_hourly"]
        meta = raw["inputs"]["meteo_data"]
        t, ghi, bn, dh, temp, ws = [], [], [], [], [], []
        for r in rows:
            t.append(r["time(UTC)"])
            ghi.append(float(r["G(h)"]))
            bn.append(float(r["Gb(n)"]))
            dh.append(float(r["Gd(h)"]))
            temp.append(float(r["T2m"]))
            ws.append(float(r["WS10m"]))
        if len(rows) < 8700:
            raise ValueError(f"{len(rows)} hourly rows")
        return {"lat": lat, "lon": lon, "elevation_m": raw["inputs"]["location"].get("elevation"),
                "radiation_db": meta.get("radiation_db"), "meteo_db": meta.get("meteo_db"),
                "years": [meta.get("year_min"), meta.get("year_max")],
                "time": t, "ghi_w_m2": ghi, "dni_w_m2": bn, "dhi_w_m2": dh, "t2m_c": temp, "ws10m_ms": ws}
    except (KeyError, TypeError, ValueError) as e:
        raise PvgisUnavailable(f"PVGIS reply not understood: {e}")


def get_tmy(lat, lon):
    """Hourly TMY for a site (cached). Raises PvgisUnavailable when it can't be had."""
    lat, lon = round_coord(lat), round_coord(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Latitude must be within ±90 and longitude within ±180 degrees")
    key = (lat, lon)
    with _lock:
        if key in _mem:
            return _mem[key]
    path = os.path.join(_cache_dir(), f"tmy_{lat:.2f}_{lon:.2f}.json.gz")
    data = None
    try:
        with gzip.open(path, "rt") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = None
    if data is None:
        data = _compact(_fetch(lat, lon), lat, lon)
        try:
            os.makedirs(_cache_dir(), exist_ok=True)
            tmp = path + ".tmp"
            with gzip.open(tmp, "wt") as f:
                json.dump(data, f)
            os.replace(tmp, path)
        except OSError:
            pass  # a read-only cache directory only costs a refetch
    with _lock:
        _mem[key] = data
    return data


def monthly_summary(tmy):
    """Monthly mean daily GHI (kWh/m2/day) and daytime air temperature (°C) — the two series the monthly model reads."""
    ghi_sum = [0.0] * 12
    t_sum = [0.0] * 12
    t_n = [0] * 12
    for ts, g, t in zip(tmy["time"], tmy["ghi_w_m2"], tmy["t2m_c"]):
        m = int(ts[4:6]) - 1
        ghi_sum[m] += g
        if g > 0:
            t_sum[m] += t
            t_n[m] += 1
    return {"ghi_kwh_m2_day": [round(ghi_sum[i] / 1000.0 / DAYS[i], 3) for i in range(12)],
            "tday_c": [round(t_sum[i] / t_n[i], 1) if t_n[i] else 0.0 for i in range(12)]}


def source_label(tmy):
    return f"{tmy.get('radiation_db') or 'PVGIS'} typical year, hourly ({tmy['years'][0]}–{tmy['years'][1]}), aggregated to monthly".replace("  ", " ")
