#!/usr/bin/env python3
"""CBI electronic ("DE") adjustable moulded-case circuit breakers: K35DE, K50DE, K70DE, L35DE800, L70DE800, N85DE1000,
N85DE1250, N85DE1600.

Writes (never edit the outputs by hand):
  testing/vendor-libraries/cbi_<type>_breakers.json   import file — {"entries": [{"kind": "cbs", "data": {...}}]}, one per type
  frontend/js/vendor-trip-units-cbi-de.js             the trip-unit profiles (TRIP_UNITS), all eight types

Source: CBI "MCCB" catalogue (36 pages): the data sheet of each type — rated current range, Icu / Ics (IEC 60947-2) and the
"Operating Characteristics" chart, whose annotations give every setting range and tolerance:
  Ir (current setting)         the type's range, e.g. 200-400 A on K35DE (In = the top of the range)
  LTD  tr = T_L at 200 % Ir    12 - 60 - 100 - 150 s, +/-20 %; at 125 % Ir 80 / 400 / 670 / 1000 s
  STD  pickup Is               2 - 2.5 - 3 - 3.5 - 4 - 5 - 6 - 7 - 8 - 10 x Ir (N85DE: x In), +/-15 %
  STD  operating time Ts       0.06 +/-0.02, 0.1 +/-0.03, 0.2 +/-0.04, 0.3 +/-0.06 s
  INST pickup Ii               x4 - x16 (K35DE), x4 - x15 (K50DE, K70DE), x4 - x12 (L35DE800, L70DE800, N85DE) x In, +/-15 %
  max. total breaking time     0.03 s

What the numbers mean
---------------------
The long-time curve is t = T_L x (2 / M)^4 up to 200 % Ir (it reproduces the sheet's 125 % times to 2 %: 78.6 / 393 /
655 / 983 s) and t = T_L x (2 / M)^2 above (checked against the chart's upper edges at 900 %: 0.71 / 3.6 / 5.9 / 8.9 s read
0.75 / 3.9 / 6.1 / 9.4 s), with +/-20 % on the time. No trip below ~1.09 x Ir, trips above ~1.26 x Ir (the chart's two
vertical edges). The short-time and instantaneous elements are `electronic` trip-unit settings, so every engine gives the
MCCB a short-time / instantaneous region; their hold / break times are the published tolerances.

Known simplifications (recorded, not hidden)
--------------------------------------------
* The long-time shape between the published points is a formula (above), not digitised: the chart overlays eight curves on
  a dense grid. The Ir dial is offered in 1 % steps of In (the sheet says "adjustable"); Ii in whole multiples of In.
* Pre-alarm (Ip, Tp), zone selectivity and the thermal-memory behaviour are not modelled.
* Icu / Ics are the 415 V figures; L70DE800 and N85DE1000 / 1250 have no 415 V row (L70DE800: 65 kA at 440 V used; N85DE: 85 /
  43 kA, the same at 440 V and 400 V). K65DE appears in the catalogue overview only (no data sheet): not included.
* The instantaneous minimum time is not published: the 0.03 s total breaking time is used for both ends.

Run:  python testing/vendor-libraries/build_cbi_de.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "CBI"
CAT = "CBI MCCB catalogue"
TL = [12, 60, 100, 150]                                   # s at 200 % Ir
ISD = [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10]
TSD = [0.06, 0.1, 0.2, 0.3]
TS_TOL = {0.06: 0.02, 0.1: 0.03, 0.2: 0.04, 0.3: 0.06}
# type -> (In A, Ir low A, Ii max x In, STD pickup base, Icu kA, Ics kA, data-sheet page, note)
TYPES = {
    "k35de": (400, 200, 16, "Ir", 35, 35, 19, ""),
    "k50de": (630, 300, 15, "Ir", 50, 50, 23, ""),
    "k70de": (630, 300, 15, "Ir", 70, 70, 25, ""),
    "l35de800": (800, 400, 12, "Ir", 36, 18, 27, ""),
    "l70de800": (800, 400, 12, "Ir", 65, 65, 29, "no 415 V row: the 440 V figures (65 / 65 kA)"),
    "n85de1000": (1000, 500, 12, "In", 85, 43, 31, "no 415 V row: the 440 V / 400 V figures (85 / 43 kA)"),
    "n85de1250": (1250, 600, 12, "In", 85, 43, 31, "no 415 V row: the 440 V / 400 V figures (85 / 43 kA)"),
    "n85de1600": (1600, 800, 12, "In", 85, 43, 33, ""),
}
PICKUP = [1.09, 1.26]                                     # the chart's no-trip / trip edges (x Ir)


def _lt_points(tl):
    ms = [1.26, 1.5, 2, 3, 5, 10, 20]
    return [[m, round(tl * (2 / m) ** (4 if m <= 2 else 2), 4)] for m in ms]


def profile(typ):
    inn, ir_lo, ii_max, st_base, *_ = TYPES[typ]
    lo = math.ceil(ir_lo / inn * 100 - 1e-9) / 100
    dials = {
        "thermal_pickup": {"steps": [round(lo + k * 0.01, 2) for k in range(int(round((1.0 - lo) * 100)) + 1)], "def": 1.0, "label": "Ir"},
        "long_time_delay": {"steps": TL, "def": 60, "label": "tL", "unit": "s at 2 × Ir"},
        "short_time_pickup": {"steps": ISD, "def": 5, "label": "Is", **({"base": "In"} if st_base == "In" else {})},
        "short_time_delay": {"steps": TSD, "def": 0.1, "label": "Ts"},
        "instantaneous_pickup": {"steps": list(range(4, ii_max + 1)), "def": 8, "label": "Ii", "base": "In"},
    }
    tol = {
        "pickup": PICKUP,
        "long_time": {"param": "long_time_delay", "time_tol": 0.2},
        "short_time": {"pickup_tol": 0.15,
                       "hold_s": {str(t): round(t - TS_TOL[t], 3) for t in TSD},
                       "break_s": {str(t): round(t + TS_TOL[t], 3) for t in TSD}},
        "instantaneous": {"pickup_tol": 0.15, "break_s": 0.03},
    }
    return {"maker": MAKER, "catalogue": CAT, "kind": "electronic", "label": f"CBI {typ.upper()} electronic (LSI)",
            "curve": {"model": "points", "thermal": {"param": "long_time_delay", "tables": {str(t): _lt_points(t) for t in TL}}, "tol": tol},
            "dials": dials}


def entry(typ):
    inn, ir_lo, ii_max, st_base, icu, ics, page, note = TYPES[typ]
    pid = f"cbi_{typ}"
    return {"kind": "cbs", "data": {
        "id": f"cbi_{typ}", "name": f"CBI {typ.upper()} {ir_lo}-{inn} A", "cb_type": "mccb", "manufacturer": MAKER,
        "series": "DE electronic", "model": typ.upper(), "trip_rating_a": inn, "frame_a": inn, "rated_voltage_kv": 0.4,
        "breaking_ka": icu, "ics_pct": round(ics / icu * 100),
        "thermal_pickup": 1.0, "magnetic_pickup": 10, "long_time_delay": 60, "short_time_pickup": 5, "short_time_delay": 0.1,
        "instantaneous_pickup": 8, "trip_unit_kind": "electronic",
        "trip_units": [pid], "default_trip_unit": pid, "source": f"{CAT}, {typ.upper()} data sheet (p. {page - 3})",
        "check": f"Ir {ir_lo}-{inn} A; long-time curve is a formula (t = tL x (2/M)^4 to 200 %, (2/M)^2 above) matching the sheet's 125 % / 200 % times"
                 + (f"; {note}" if note else ""),
    }}


def js_profiles(p):
    return (
        "// GENERATED by testing/vendor-libraries/build_cbi_de.py — do not edit by hand.\n"
        "// CBI electronic (DE) MCCB trip-unit profiles: Ir / tL / Is / Ts / Ii dials, long-time tables by tL (x Ir, s), published\n"
        "// tolerances (+/-20 % on tL, Is +/-15 %, Ts hold / break, Ii +/-15 %, 0.03 s total breaking time).\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


if __name__ == "__main__":
    prof = {f"cbi_{t}": profile(t) for t in TYPES}
    for t in TYPES:
        with open(os.path.join(HERE, f"cbi_{t}_breakers.json"), "w") as f:
            json.dump({"entries": [entry(t)]}, f, indent=1)
            f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units-cbi-de.js"), "w") as f:
        f.write(js_profiles(prof))
    print(f"{len(TYPES)} types, {len(prof)} trip-unit profiles")
