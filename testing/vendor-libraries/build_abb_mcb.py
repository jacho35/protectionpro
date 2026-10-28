#!/usr/bin/env python3
"""ABB System pro M compact miniature circuit breakers: S200, S200M, S300P and S800 (C / N / S / P), curves B / C / D.

Writes, from data/abb_mcb_curves.json and the tables below (never edit the outputs by hand):
  testing/vendor-libraries/abb_mcb_breakers.json   import file — {"entries": [{"kind": "cbs", "data": {...}}]}
  frontend/js/vendor-trip-units-abb-mcb.js         the trip-unit profiles the entries point at (TRIP_UNITS)

Sources (ABB):
  9AKK107991A8329  Electrical installation solutions for buildings, part A01 MCBs (BE edition) —
                   technical features (Icn, Icu, Ics per series, pp. 28-31, 108, 142-150) and the
                   ordering tables (which ratings each series / characteristic is sold in: every type
                   code S201...S204, S201M..., S301P..., S801C/N/S/P...)
  9AKK108468A3912  Electrical installation solutions for buildings, technical details, part B01 MCBs —
                   tripping characteristics (tables pp. 6, 9, 10; charts pp. 11, 13, 14, 16, 28),
                   digitised by digitize_abb_mcb.py

What the numbers mean
---------------------
Each entry's long-time curve is the published IEC/EN 60898-1 (30 C, cold state) chart of its series:
the maximum curve is what the engines clear on (`thermal_curve`), the minimum the TCC band
(`long_time.min_points`). S200 / S200M / S300P have one chart up to 4 A and one for 6-63 A; S200
80-100 A has its own (B only, see below); every S800 series shares the S800 band chart. The magnetic
element is a fixed multiple of In, the band drawn on the chart: S200 / S200M / S300P B 3-5, C 5-8,
D 10-15 x In (ABB's charts are tighter than the IEC 60898-1 limits their own table quotes,
C 5-10 / D 10-20 x In, as Schneider's are); S800 B 3-5, C 5-10, D 10-20 x In (chart = table). Above
the band the breaker clears in the chart's 10 ms floor ("< 0.1 s" in the table).

`breaking_ka` is Icn (IEC 60898-1), the library's MCB convention; Icu (IEC 60947-2, 400/415 V,
multi-pole) is carried as `icu_ka` and Ics as `ics_pct` of it. Where a rating has no Icn
(S800N 6 / 8 A, S800S below 10 A) Icu is used.

Known simplifications and source conflicts (recorded, not hidden)
-----------------------------------------------------------------
* S200M Icu: A01 p.30 prints "<= 2 A: 50 kA, > 2 A: 10 kA" (a copy of the S200 column) next to an Ics
  of 11.2 kA (<= 40 A) — larger than that Icu. ABB's product data for the S200M (e.g. S201M-D25,
  2CDS271001R0251: Icu 15 kA, Ics 11.25 kA) gives 15 kA up to 40 A; 10 kA for 50 / 63 A (Ics 7.5 kA).
  15 / 10 kA is used. Icn (10 kA, what the engines use) is not in question.
* S300P Icu: "<= 6 A: 100 kA", then 25 kA; Ics <= 6 A 100 kA, <= 25 A 12.5, 32-40 A 10, > 40 A 7.5 kA.
* The S800 chart (B01 p.28) is a schematic band: its x grid sits on the log scale but its 10 s grid
  line is 0.075 decade below a log position. It is read on the regular log scale, and every S800
  entry carries a `check` saying so. ABB's S800 time-current data sheets are the better source.
* S200 80-100 A: only the B chart is published (B01 p.13); the C 80 / 100 A breakers (S201-C80 ...)
  have no chart in either document and are not included. Icn = Icu = Ics = 6 kA.
* K, Z, KM, UC / DC, MT (rolling stock), SU (UL 489), SN201, S200C compact, S800B (no ordering codes in
  A01), S800HV / PV are not included: the app's MCB characteristics are B / C / D, AC.
* The IEC 60947-2 (55 C) charts are not used; ambient derating (ca. 6 % per 10 K) is not modelled.

Run:  python testing/vendor-libraries/build_abb_mcb.py
"""
import json
import math
import os

import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "ABB"
CAT = "9AKK107991A8329 / 9AKK108468A3912"
SOURCE = "ABB 9AKK107991A8329 (A01 MCBs) + 9AKK108468A3912 (B01 MCBs, tripping characteristics)"
HOLD_S = BREAK_S = 0.010                                  # the charts' floor; table "< 0.1 s"
MAG = {"S200": {"B": (3, 5), "C": (5, 8), "D": (10, 15)},  # drawn on the IEC 60898-1 charts (x In)
       "S800": {"B": (3, 5), "C": (5, 10), "D": (10, 20)}}

_LOW = [0.5, 1, 1.6, 2, 3, 4]
_STD = [6, 8, 10, 13, 16, 20, 25, 32, 40, 50, 63]
# series -> chart family, frame, curves {letter: ratings}, Icn(In), Icu(In), Ics kA(In)  (400/415 V)
SERIES = {
    "S200": dict(chart="s200", mag="S200", frame=63,
                 ratings={"B": [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100],
                          "C": _LOW + _STD, "D": _LOW + _STD},
                 icn=lambda i: 6, icu=lambda i: 50 if i <= 2 else 6 if i >= 80 else 10,
                 ics=lambda i: 6 if i >= 80 else 7.5),
    "S200M": dict(chart="s200m", mag="S200", frame=63,
                  ratings={"B": [6, 10, 13, 16, 20, 25, 32, 40, 50, 63], "C": _LOW + _STD, "D": _LOW + _STD},
                  icn=lambda i: 10, icu=lambda i: 50 if i <= 2 else 15 if i <= 40 else 10,
                  ics=lambda i: 11.2 if i <= 40 else 7.5),
    "S300P": dict(chart="s300p", mag="S200", frame=63,
                  ratings={"B": _STD, "C": _LOW + _STD, "D": _LOW + _STD},
                  icn=lambda i: 25 if i <= 25 else 20 if i <= 40 else 15, icu=lambda i: 100 if i <= 6 else 25,
                  ics=lambda i: 100 if i <= 6 else 12.5 if i <= 25 else 10 if i <= 40 else 7.5),
    "S800C": dict(chart="s800", mag="S800", frame=63, ratings={c: _STD[2:] for c in "BCD"},
                  icn=lambda i: 15, icu=lambda i: 25, ics=lambda i: 25),
    "S800N": dict(chart="s800", mag="S800", frame=63, ratings={c: _STD for c in "BCD"},
                  icn=lambda i: 20 if i >= 10 else None, icu=lambda i: 36, ics=lambda i: 30),
    "S800S": dict(chart="s800", mag="S800", frame=63, ratings={c: [0.5, 1, 1.6, 2, 2.5, 3, 4, 5] + _STD for c in "BCD"},
                  icn=lambda i: 25 if i >= 10 else None, icu=lambda i: 50, ics=lambda i: 40),
    "S800P": dict(chart="s800", mag="S800", frame=125, ratings={c: [80, 100, 125] for c in "BCD"},
                  icn=lambda i: 25 if i <= 80 else 15, icu=lambda i: 50, ics=lambda i: 40),
}
S800_CHECK = "S800 band chart (B01 p.28) is schematic: read on a regular log scale, its 10 s grid line is 0.075 decade off"


def chart_key(series, curve, inn):
    fam = SERIES[series]["chart"]
    if fam == "s800":
        return f"s800_{curve.lower()}"
    if inn >= 80:
        return f"{fam}_{curve.lower()}_80_100"
    return f"{fam}_{curve.lower()}_{'le4' if inn <= 4 else '6_63'}"


def _pid(key):
    return f"abb_mcb_{key}"


def _num(inn):
    return int(inn) if float(inn).is_integer() else inn


def profiles():
    charts = json.load(open(os.path.join(HERE, "data", "abb_mcb_curves.json")))["charts"]
    used = sorted({(chart_key(s, c, i), SERIES[s]["mag"], c) for s, f in SERIES.items()
                   for c, rs in f["ratings"].items() for i in rs})
    out = {}
    for key, mag, curve in used:
        ch = charts[key]
        lo, hi = MAG[mag][curve]
        # the drawn vertical edges are the band (1 % for the vector charts, 2 % for the S800 sketch)
        assert all(abs(d / v - 1) < 0.02 for d, v in zip(ch["magnetic_drawn"], (lo, hi))), (key, ch["magnetic_drawn"])
        series = {"s200": "S200", "s200m": "S200M", "s300p": "S300P", "s800": "S800"}[key.split("_")[0]]
        rng = " 80-100 A" if key.endswith("80_100") else " up to 4 A" if key.endswith("le4") else \
              " 6-63 A" if key.endswith("6_63") else ""
        p = C.tm_profile(MAKER, f"ABB {series} MCB, curve {curve}{rng} (IEC 60898-1)", CAT,
                         ch["max"], ch["min"], band=(lo, hi, HOLD_S, BREAK_S))
        out[_pid(key)] = p
    return out


def entries(prof):
    out = []
    for series, f in SERIES.items():
        for curve, ratings in f["ratings"].items():
            for inn in ratings:
                pid = _pid(chart_key(series, curve, inn))
                icn, icu, ics = f["icn"](inn), f["icu"](inn), f["ics"](inn)
                num = _num(inn)
                d = {
                    "id": f"abb_{series.lower()}_{curve.lower()}_{str(num).replace('.', '_')}",
                    "name": f"ABB {series} {curve}{num}", "cb_type": "mcb", "mcb_curve": curve,
                    "manufacturer": MAKER, "series": "S800" if series.startswith("S800") else series, "model": series,
                    "trip_rating_a": inn, "frame_a": 100 if series == "S200" and inn >= 80 else f["frame"],
                    "rated_voltage_kv": 0.4, "breaking_ka": icn if icn is not None else icu,
                    "icu_ka": icu, "ics_pct": round(ics / icu * 100, 1),
                    "thermal_pickup": 1.0, "magnetic_pickup": prof[pid]["dials"]["magnetic_pickup"]["def"],
                    "long_time_delay": 10, "trip_units": [pid], "default_trip_unit": pid, "source": SOURCE,
                }
                if f["chart"] == "s800":
                    d["check"] = S800_CHECK
                out.append({"kind": "cbs", "data": d})
    return out


def js_profiles(p):
    return (
        "// GENERATED by testing/vendor-libraries/build_abb_mcb.py — do not edit by hand.\n"
        "// ABB S200 / S200M / S300P / S800 MCB curves B, C, D (IEC 60898-1 charts, digitised by digitize_abb_mcb.py):\n"
        "// `curve.thermal` is the published maximum curve (x In, s), `curve.tol.long_time.min_points` the minimum\n"
        "// (copied onto the breaker as `thermal_curve` / `trip_tol`, see cbTripBand); the magnetic pickup is a\n"
        "// multiple of In.\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


if __name__ == "__main__":
    prof = profiles()
    ents = entries(prof)
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids))
    with open(os.path.join(HERE, "abb_mcb_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb-mcb.js"), "w") as f:
        f.write(js_profiles(prof))
    for k, v in prof.items():
        print(f"  {k}: Im {v['dials']['magnetic_pickup']['def']} x In +/-{v['curve']['tol']['instantaneous']['pickup_tol']}")
    print(f"{len(ents)} entries, {len(prof)} trip-unit profiles")
