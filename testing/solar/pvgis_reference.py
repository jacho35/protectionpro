"""Fetch PVGIS (PVcalc, SARAH/ERA5 default DB) reference yields for the solar accuracy check.

Writes testing/solar/pvgis_reference.json (committed; the backend test reads it, no network in CI).
System loss is set to the engine's own fixed stack (soiling, mismatch, wiring, inverter, availability = 9.61 %) so the
difference measures irradiance, transposition and temperature, not the loss assumptions.
Run: python testing/solar/pvgis_reference.py
"""
import json, os, urllib.request

LOSS = 9.61
SITES = {"Johannesburg": (-26.2, 28.04), "Cape Town": (-33.92, 18.42), "Upington": (-28.45, 21.26)}
# PVGIS aspect: 0 = south, 180 = north, -90 = east, 90 = west (southern hemisphere: north-facing is 180)
CASES = {"north_30": [(30, 180)], "flat_ew": [(10, -90), (10, 90)]}


def fetch(lat, lon, angle, aspect):
    url = (f"https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat={lat}&lon={lon}&peakpower=1&loss={LOSS}"
           f"&angle={angle}&aspect={aspect}&outputformat=json")
    with urllib.request.urlopen(url, timeout=60) as r:
        d = json.load(r)
    m = d["outputs"]["monthly"]["fixed"]
    return {"e_m": [x["E_m"] for x in m], "h_m": [x["H(i)_m"] for x in m],
            "e_y": d["outputs"]["totals"]["fixed"]["E_y"], "h_y": d["outputs"]["totals"]["fixed"]["H(i)_y"]}


out = {"loss_pct": LOSS, "sites": {}}
for site, (lat, lon) in SITES.items():
    out["sites"][site] = {}
    for case, planes in CASES.items():
        out["sites"][site][case] = [dict(tilt=a, aspect=s, **fetch(lat, lon, a, s)) for a, s in planes]
path = os.path.join(os.path.dirname(__file__), "pvgis_reference.json")
json.dump(out, open(path, "w"), indent=1)
print("wrote", path)

# The hourly typical years used by backend/tests/test_solar_hourly.py are the cache files of pvgis_tmy.get_tmy for these
# sites, copied to testing/solar/tmy/ (set PVGIS_CACHE_DIR, call get_tmy for each site, copy tmy_<lat>_<lon>.json.gz).
