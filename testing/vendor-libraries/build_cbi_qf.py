#!/usr/bin/env python3
"""CBI QF-series hydraulic-magnetic miniature circuit breaker libraries: QF(13), QF(18), QF(26)LR, QF(26)HR.

One JSON + one trip-unit profile file per type (never edit the outputs by hand):
  testing/vendor-libraries/cbi_<type>_breakers.json      import file — {"entries": [{"kind": "cbs", "data": {...}}]}
  frontend/js/vendor-trip-units-cbi-<type>.js            the trip-unit profiles the entries point at (TRIP_UNITS)
from data/cbi_<type>_curves.json, which digitize_cbi_qf.py reads out of the type's data sheet PDF.

Sources (CBI data sheets, cbi-lowvoltage.co.za): QF13-SERIES-DAT REV. G (June 2024), QF18-SERIES-DAT
REV. F (August 2022), QF26LR-SERIES-DAT REV. B and QF26HR-SERIES-DAT REV. C (April 2022): Technical Data
(Icu), Long Code / Ordering Information (ratings, time delays and their instantaneous trip points), Time Delay
Curve pages (minimum + maximum at 30 C from the PDF's vector charts, checked against the trip-time table
printed under each chart: within ~6 % at every column; on the steep part of curve 9 up to ~10 % in the time,
which is a 4-6 % offset in current).

What the numbers mean
---------------------
Hydraulic-magnetic, 100 % rated: the trip points are not affected by ambient temperature. The maximum curve is
the long-time curve the engines clear on (`thermal_curve`), the minimum is the fastest the breaker may trip
(`long_time.min_points`), so the TCC draws the band. No trip below 1.05 x In, trips above 1.30 x In. The sheets'
instantaneous trip point is 10-20 x In (curve 1, orange handle), 5-10 x In (curve 2) and 7-12 x In (curve 9):
where the times start to collapse. The modelled pickup band is where the charts reach their flat times, so the
clearing time is the published curve at every current. The curve letter is the IEC 60898-1 band the sheet's trip
point matches: 1 = D (10-20), 2 = C (5-10); curve 9 (7-12) lies between C and D and is tagged C (its midpoint).
QF(26)HR's charts and table are the same as QF(26)LR's (identical to 0.01 %); each type keeps its own profile.

Known simplifications (recorded, not hidden)
--------------------------------------------
* Icu is the VC 8036 (SANS 556-1) figure, 5 kA at 240 / 415 V; the sheets give 6 kA for the IEC / DIN version.
  The QF(26)LR's Ics (2.5 kA) is carried; the other sheets publish no Ics.
* The sheets' trip-time tables have misprints in the minimum rows of curve 2 (0.001 s at 600 %, 0.041 s at
  900 %); the chart is used.
* QF(26)LR curve 3 (3-5 x In) and curve 9 (7-12 x In) are orderable but have no chart in that sheet: not modelled.
* Ratings: QF(26)LR / QF13 those of the sheet's internal-impedance table within the range (5-63 A / 1-25 A);
  QF(26)HR the ordering list (60-125 A; DIN / EN data starts at 70 A); QF(18) the ordering list (1-63 A; the
  UL 1077 version stops at 60 A). Ratings vary by certification.
* The UL 1077 / UL 489 / GB / AS/NZS 3111 versions, switch disconnectors, shunt trips, auxiliaries, the pole count
  and the internal-impedance tables are not modelled; the temperature-compensation curve is "on request".

Run:  python testing/vendor-libraries/build_cbi_qf.py
"""
import json
import os

import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "CBI"
LETTER = {"1": ("D", "10-20"), "2": ("C", "5-10"), "9": ("C", "7-12")}     # IEC curve letter, the sheet's instantaneous trip point (x In)

TYPES = {
    "qf26lr": dict(series="QF(26)LR", code="QF26LR", cat="QF26LR-SERIES-DAT REV. B", date="April 2022", frame=63,
                   ratings=[5, 6, 10, 15, 20, 25, 30, 32, 40, 50, 60, 63], ics_pct=50),
    "qf26hr": dict(series="QF(26)HR", code="QF26HR", cat="QF26HR-SERIES-DAT REV. C", date="April 2022", frame=125,
                   ratings=[60, 70, 80, 90, 100, 125]),
    "qf13": dict(series="QF(13)", code="QF13", cat="QF13-SERIES-DAT REV. G", date="June 2024", frame=25,
                 ratings=[1, 2, 5, 6, 10, 15, 20, 25]),
    "qf18": dict(series="QF(18)", code="QF18", cat="QF18-SERIES-DAT REV. F", date="August 2022", frame=63,
                 ratings=[1, 2, 5, 10, 15, 16, 20, 25, 30, 32, 35, 40, 45, 50, 60, 63]),
}


def _pid(typ, c):
    return f"cbi_{typ}_c{c}"


def profiles(typ):
    t = TYPES[typ]
    data = json.load(open(os.path.join(HERE, "data", f"cbi_{typ}_curves.json")))["curves"]
    return {_pid(typ, c): C.tm_profile(MAKER, f"CBI {t['series']} thermal-magnetic, curve {c}", t["cat"], d["max"], d["min"])
            for c, d in data.items()}


def entries(typ, prof):
    t = TYPES[typ]
    out = []
    for pid in prof:
        c = pid.rsplit("_c", 1)[1]
        letter, band = LETTER[c]
        mid = prof[pid]["dials"]["magnetic_pickup"]["def"]
        for inn in t["ratings"]:
            d = {
                "id": f"cbi_{typ}_c{c}_{inn}", "name": f"CBI {t['code']} {inn} A curve {c}", "cb_type": "mcb",
                "mcb_curve": letter, "manufacturer": MAKER, "series": t["series"], "model": f"{t['code']} curve {c}",
                "trip_rating_a": inn, "frame_a": t["frame"], "rated_voltage_kv": 0.4, "breaking_ka": 5,
            }
            if "ics_pct" in t:
                d["ics_pct"] = t["ics_pct"]
            d.update({
                "thermal_pickup": 1.0, "magnetic_pickup": mid, "long_time_delay": 10,
                "trip_units": [pid], "default_trip_unit": pid,
                "source": f"CBI data sheet {t['cat']} ({t['date']})",
                "check": f"sheet instantaneous trip point {band} x In; modelled pickup band = where the curves reach their flat times",
            })
            out.append({"kind": "cbs", "data": d})
    return out


def js_profiles(typ, p):
    return (
        f"// GENERATED by testing/vendor-libraries/build_cbi_qf.py — do not edit by hand.\n"
        f"// CBI {TYPES[typ]['series']} hydraulic-magnetic MCB, time-delay curves {', '.join(k.rsplit('_c', 1)[1] for k in p)}: `curve.thermal` is the published maximum\n"
        "// curve (x In, s), `curve.tol.long_time.min_points` the minimum curve (copied onto the breaker as\n"
        "// `thermal_curve` / `trip_tol`, see cbTripBand); the magnetic pickup is a multiple of In.\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


def build(typ):
    prof = profiles(typ)
    ents = entries(typ, prof)
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids))
    with open(os.path.join(HERE, f"cbi_{typ}_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", f"vendor-trip-units-cbi-{typ}.js"), "w") as f:
        f.write(js_profiles(typ, prof))
    for k, v in prof.items():
        t = v["curve"]["tol"]
        print(f"  {k}: Im {v['dials']['magnetic_pickup']['def']} +/-{t['instantaneous']['pickup_tol']}, pickup {t['pickup']}")
    print(f"{typ}: {len(ents)} entries, {len(prof)} trip-unit profiles")


if __name__ == "__main__":
    import sys
    for typ in (sys.argv[1:] or TYPES):
        build(typ)
