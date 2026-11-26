"""Fetch PVGIS (PVcalc, SARAH/ERA5 default DB) reference yields for the solar accuracy check.

Writes testing/solar/pvgis_reference.json (committed; the backend test reads it, no network in CI).
System loss is set to the engine's own fixed stack (soiling, mismatch, wiring, inverter, availability = 9.61 %) so the
difference measures irradiance, transposition and temperature, not the loss assumptions.
Run: python testing/solar/pvgis_reference.py
"""
import json, os, urllib.request

LOSS = 9.61
SITES = {"Johannesburg": (-26.2, 28.04), "Cape Town": (-33.92, 18.42), "Upington": (-28.45, 21.26),
         "Durban": (-29.86, 31.02), "Polokwane": (-23.9, 29.45), "Bloemfontein": (-29.12, 26.21), "Gqeberha": (-33.96, 25.6)}
# PVGIS aspect: 0 = south, 180 = north, -90 = east, 90 = west (southern hemisphere: north-facing is 180)
CASES = {"north_30": [(30, 180)], "flat_ew": [(10, -90), (10, 90)],
         "north_15": [(15, 180)], "north_45": [(45, 180)], "west_30": [(30, 90)], "ew_5": [(5, -90), (5, 90)]}


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



# the hourly typical years the hourly-model test uses: PVGIS TMY for every site above, written to testing/solar/tmy/ through the app's own lookup
import gzip, shutil, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ["PVGIS_CACHE_DIR"] = tempfile.mkdtemp(prefix="pvgis-tmy-")
from backend.analysis import pvgis_tmy
os.makedirs(os.path.join(os.path.dirname(__file__), "tmy"), exist_ok=True)
for site, (lat, lon) in SITES.items():
    pvgis_tmy.get_tmy(lat, lon)
    f = f"tmy_{lat:.2f}_{lon:.2f}.json.gz"
    shutil.copy(os.path.join(os.environ["PVGIS_CACHE_DIR"], f), os.path.join(os.path.dirname(__file__), "tmy", f))
print("wrote", len(SITES), "typical years")
