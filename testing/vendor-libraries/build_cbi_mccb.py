#!/usr/bin/env python3
"""CBI thermal-magnetic moulded-case circuit breaker libraries: G15D / G25D, F15D / F25D, G35D, F35D, K25D, K35D, K50D.

One JSON + one trip-unit profile file per type (never edit the outputs by hand):
  testing/vendor-libraries/cbi_<type>_breakers.json      import file — {"entries": [{"kind": "cbs", "data": {...}}]}
  frontend/js/vendor-trip-units-cbi-<type>.js            the trip-unit profiles the entries point at (TRIP_UNITS)
from data/cbi_mccb_curves.json, which digitize_cbi_mccb.py reads out of the catalogue PDF's operating-characteristic charts.

Also F65DV (thermal-adjustable: an Ir dial per rating, thermal curve in x Ir, instantaneous in x In), see F65DV below.

Source: CBI "MCCB" catalogue (36 pages, the data-sheet pages of each type): rated currents, Icu / Ics (IEC 60947-2, 415 V),
and the "Operating Characteristics" charts — the minimum and maximum AC curve of each rating band, traced from the page
(the dashed DC curves are not modelled) and calibrated on the chart's own grid.

What the numbers mean
---------------------
Fixed thermal-magnetic trip units (no dials). The maximum curve is the long-time curve the engines clear on
(`thermal_curve`), the minimum is the fastest the breaker may trip (`long_time.min_points`), so the TCC draws the band;
no trip below the minimum curve's asymptote (1.05 x In), trips above the maximum curve's (~1.2 x In). The instantaneous
(magnetic) band is where the two curves reach their flat times (minimum: at the bottom of its vertical, 0.01 s, the
chart's lower edge; maximum: 0.02 s, "max. total breaking time"), so the clearing time is the published curve at every
current. The charts of the 125 A and larger ratings state the magnetic trip in x In; the 15-32 A (G15D / G25D / G35D)
band states it as a fixed current, "AC 600 +/- 120 A" (480-720 A), so for each rating the published thermal curve is
cut at, or carried on to, 480 / In and 720 / In x In and the instantaneous drop is placed there (a constructed curve,
marked in the entry).

Known simplifications (recorded, not hidden)
--------------------------------------------
* Icu / Ics are the catalogue's 415 V figures. K25D's data sheet has no 415 V row (36/18 kA at 400 V, 25/13 kA at 440 V; the
  overview gives 25 kA at 415 V): 25 / 13 kA, the 440 V figures, are used.
* G15D / G25D 40-100 A and G35D 40-100 A draw two maximum curves (40-50 A and 60-100 A) that differ by up to ~15 % in the
  thermal region; one curve through both is used.
* K50D's two charts are both titled "K50D" without a rating: they are assigned 500 A (left) and 630 A (right).
* The DC curves, the temperature-compensation curve, accessories (shunt trips, auxiliaries) and the 690 / 525 / 500 V
  ratings are not modelled.

Run:  python testing/vendor-libraries/build_cbi_mccb.py
"""
import json
import math
import os

import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "CBI"
CAT = "CBI MCCB catalogue"
INST_AC_A = (480, 720)            # "AC 600 +/- 120 A": the fixed instantaneous trip of the 15-32 A ratings

# type -> series, Icu / Ics (kA, 415 V), data-sheet page, bands: [(ratings, chart key, fixed-amps?, label)]
TYPES = {
    "g15d": dict(series="G15D", icu=15, ics=15, page=5, frame=125, bands=[
        ([16, 20, 32], "5_0", True, "15-32 A"), ([40, 50, 63, 80, 100], "5_1", False, "40-100 A"), ([125], "5_2", False, "125 A")]),
    "g25d": dict(series="G25D", icu=25, ics=25, page=5, frame=125, bands=[
        ([16, 20, 32], "5_0", True, "15-32 A"), ([40, 50, 63, 80, 100], "5_1", False, "40-100 A"), ([125], "5_2", False, "125 A")]),
    "f15d": dict(series="F15D", icu=15, ics=15, page=7, frame=250, bands=[
        ([125, 150, 160, 175, 200, 225], "7_0", False, "125-225 A"), ([250], "7_1", False, "250 A")]),
    "f25d": dict(series="F25D", icu=25, ics=25, page=7, frame=250, bands=[
        ([125, 150, 160, 175, 200, 225], "7_0", False, "125-225 A"), ([250], "7_1", False, "250 A")]),
    "g35d": dict(series="G35D", icu=35, ics=35, page=9, frame=100, bands=[
        ([16, 20, 32], "9_0", True, "16-32 A"), ([40, 50, 63, 80, 100], "9_1", False, "40-100 A")]),
    "f35d": dict(series="F35D", icu=35, ics=35, page=11, frame=250, bands=[
        ([125, 150, 160, 175, 200, 225], "11_0", False, "125-225 A"), ([250], "11_1", False, "250 A")]),
    "k25d": dict(series="K25D", icu=25, ics=13, page=15, frame=400, bands=[([250, 300, 350, 400], "15_0", False, "250-400 A")],
                 note="Icu / Ics: the data sheet's 440 V figures (no 415 V row)"),
    "k35d": dict(series="K35D", icu=35, ics=35, page=17, frame=630, bands=[([250, 300, 350, 400], "17_0", False, "250-400 A")],
                 more=[dict(ratings=[500, 630], icu=36, ics=18, chart="17_0", label="500-630 A")]),
    "k50d": dict(series="K50D", icu=50, ics=50, page=21, frame=630, bands=[([500], "21_0", False, "500 A"), ([630], "21_1", False, "630 A")],
                 note="the two K50D charts are unlabelled; assigned 500 A (left) and 630 A (right)"),
}


def _loglog(pts, m):
    """t at m on the polyline pts (log-log), extended along the last / first segment's slope."""
    for (m0, t0), (m1, t1) in zip(pts, pts[1:]):
        if m <= m1:
            break
    f = (math.log(m) - math.log(m0)) / (math.log(m1) - math.log(m0))
    return math.exp(math.log(t0) + f * (math.log(t1) - math.log(t0)))


def _thermal_part(mx):
    """The maximum curve before its magnetic bend: the segments whose log-log slope stays within 1.7 x that of the
    1-30 s stretch."""
    segs = [((a[0], a[1]), (b[0], b[1])) for a, b in zip(mx, mx[1:])]
    sl = lambda a, b: (math.log(b[1]) - math.log(a[1])) / (math.log(b[0]) - math.log(a[0]))
    mid = sorted(sl(a, b) for a, b in segs if 1 <= (a[1] + b[1]) / 2 <= 30 and b[0] > a[0] * 1.02)
    ref = mid[len(mid) // 2]
    keep = [mx[0]]
    for a, b in zip(mx, mx[1:]):
        if b[0] > a[0] * 1.02 and abs(sl(a, b)) > 1.7 * abs(ref) and a[1] < 30:
            break
        keep.append(b)
    return keep


def amps_curves(c, inn):
    """Minimum / maximum curve of one rating of a fixed-instantaneous band: the chart's thermal curves with the
    instantaneous drop at 480 / In and 720 / In x In (minimum: at 0.01 s; maximum: to 0.02 s)."""
    return construct(c, INST_AC_A[0] / inn, INST_AC_A[1] / inn)


def construct(c, lo_m, hi_m):
    """The chart's thermal curves with the instantaneous drop moved to lo_m (minimum curve) and hi_m (maximum), in x In."""
    th = _thermal_part(c["min"][:-1])                      # the minimum curve before its knee
    if lo_m <= th[-1][0]:
        th_min = [p for p in th if p[0] < lo_m] + [[lo_m, _loglog(th, lo_m)]]
    else:                                                  # carried on along the last thermal segment
        a, b = th[-2], th[-1]
        s = (math.log(b[1]) - math.log(a[1])) / (math.log(b[0]) - math.log(a[0]))
        th_min = th + [[lo_m, b[1] * (lo_m / b[0]) ** s]]
    mn = th_min + [[lo_m * 1.003, c["min"][-1][1]]]
    th = _thermal_part(c["max"])
    if hi_m <= th[-1][0]:
        th_max = [p for p in th if p[0] < hi_m] + [[hi_m, _loglog(th, hi_m)]]
    else:
        a, b = th[-2], th[-1]
        s = (math.log(b[1]) - math.log(a[1])) / (math.log(b[0]) - math.log(a[0]))
        th_max = th + [[hi_m, b[1] * (hi_m / b[0]) ** s]]
    mx = th_max + [[hi_m * 1.003, c["max"][-1][1]]]
    return mn, mx


# F65DV (thermal-adjustable): rating In -> (setting range Ir lo-hi A, chart, instantaneous trip). Charts: A = Ir up to 32 A,
# B = 32-50 A (both "AC 600 +/- 120 A"), C and D = 45-250 A ("AC 1000 +/- 200 % x In"). The data-sheet table lists 20-25, 32-40,
# 45-63, 70-100, 90-125, 125-160 and 175-250 A; the chart legends add 25-32 and 35-50 A (and a second In = 100 A line, 63-100 A,
# that conflicts with the table's 70-100 A): all of them are offered.
F65DV = {25: (20, "A"), 32: (25, "A"), 40: (32, "B"), 50: (35, "B"), 63: (45, "C"), 100: (70, "D"), 125: (90, "D"), 160: (125, "D"), 250: (175, "D")}
TYPES["f65dv"] = dict(series="F65DV", icu=65, ics=65, page=13, frame=250)


def f65dv_profiles():
    data = json.load(open(os.path.join(HERE, "data", "cbi_mccb_curves.json")))
    out = {}
    for inn, (ir_lo, key) in F65DV.items():
        c = data[f"13_{key}"]
        lo_m, hi_m = (INST_AC_A[0] / inn, INST_AC_A[1] / inn) if inn <= 50 else (8.0, 12.0)
        mn, mx = construct(c, lo_m, hi_m)
        # the thermal part only: the points are in x Ir, the instantaneous drop is against In and is set by the band
        p = C.tm_profile(MAKER, f"CBI F65DV thermal-adjustable, {inn} A (Ir {ir_lo}-{inn} A)", CAT, mx[:-1], mn[:-1],
                         band=(lo_m, hi_m * 1.003, c["min"][-1][1], c["max"][-1][1]))
        lo_x = math.ceil(ir_lo / inn * 100 - 1e-9) / 100
        p["dials"]["thermal_pickup"] = {"steps": [round(lo_x + k * 0.01, 2) for k in range(int(round((1.0 - lo_x) * 100)) + 1)], "def": 1.0}
        out[f"cbi_f65dv_{inn}"] = p
    return out


def f65dv_entries(prof):
    out = []
    for inn, (ir_lo, key) in F65DV.items():
        pid = f"cbi_f65dv_{inn}"
        out.append({"kind": "cbs", "data": {
            "id": f"cbi_f65dv_{inn}", "name": f"CBI F65DV {inn} A", "cb_type": "mccb", "manufacturer": MAKER, "series": "F65DV",
            "model": "F65DV", "trip_rating_a": inn, "frame_a": 250, "rated_voltage_kv": 0.4, "breaking_ka": 65, "ics_pct": 100,
            "thermal_pickup": 1.0, "magnetic_pickup": prof[pid]["dials"]["magnetic_pickup"]["def"], "long_time_delay": 10,
            "trip_units": [pid], "default_trip_unit": pid, "source": f"{CAT}, F65DV data sheet (p. 10)",
            "check": f"thermal-adjustable Ir {ir_lo}-{inn} A; instantaneous " + ("AC 600 +/- 120 A fixed" if inn <= 50 else "AC 1000 +/- 200 % x In")
                     + "; the catalogue's rating ranges and chart legends differ (see the build script)",
        }})
    return out


def _pid(typ, key, inn=None):
    return f"cbi_{typ}_p{key}" + (f"_{inn}" if inn else "")


def profiles(typ):
    t = TYPES[typ]
    data = json.load(open(os.path.join(HERE, "data", "cbi_mccb_curves.json")))
    out = {}
    for ratings, key, fixed, label in t["bands"] + [(m["ratings"], m["chart"], False, m["label"]) for m in t.get("more", [])]:
        c = data[key]
        if fixed:
            for inn in ratings:
                mn, mx = amps_curves(c, inn)
                out[_pid(typ, key, inn)] = C.tm_profile(MAKER, f"CBI {t['series']} thermal-magnetic, {inn} A", CAT, mx, mn)
        else:
            out[_pid(typ, key)] = C.tm_profile(MAKER, f"CBI {t['series']} thermal-magnetic, {label}", CAT, c["max"], c["min"])
    return out


def entries(typ, prof):
    t = TYPES[typ]
    out = []
    groups = [(r, k, f, lb, t["icu"], t["ics"]) for r, k, f, lb in t["bands"]]
    groups += [(m["ratings"], m["chart"], False, m["label"], m["icu"], m["ics"]) for m in t.get("more", [])]
    for ratings, key, fixed, label, icu, ics in groups:
        for inn in ratings:
            pid = _pid(typ, key, inn if fixed else None)
            mid = prof[pid]["dials"]["magnetic_pickup"]["def"]
            chk = (f"instantaneous AC 600 +/- 120 A fixed: curve constructed from the published thermal curve" if fixed
                   else "instantaneous band = where the chart's curves reach their flat times")
            if t.get("note"):
                chk += "; " + t["note"]
            out.append({"kind": "cbs", "data": {
                "id": f"cbi_{typ}_{inn}", "name": f"CBI {t['series']} {inn} A", "cb_type": "mccb",
                "manufacturer": MAKER, "series": t["series"], "model": t["series"],
                "trip_rating_a": inn, "frame_a": t["frame"], "rated_voltage_kv": 0.4, "breaking_ka": icu,
                "ics_pct": round(ics / icu * 100),
                "thermal_pickup": 1.0, "magnetic_pickup": mid, "long_time_delay": 10,
                "trip_units": [pid], "default_trip_unit": pid,
                "source": f"{CAT}, {t['series']} data sheet (p. {t['page'] - 3 + 0})", "check": chk,
            }})
    return out


def js_profiles(typ, p):
    return (
        "// GENERATED by testing/vendor-libraries/build_cbi_mccb.py — do not edit by hand.\n"
        f"// CBI {TYPES[typ]['series']} thermal-magnetic MCCB trip-unit profiles ({'thermal-adjustable Ir dial' if typ == 'f65dv' else 'fixed'}): `curve.thermal` is the published maximum\n"
        "// operating curve (x In, s), `curve.tol.long_time.min_points` the minimum curve (copied onto the breaker as\n"
        "// `thermal_curve` / `trip_tol`, see cbTripBand); the magnetic pickup is a multiple of In.\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


def build(typ):
    prof = f65dv_profiles() if typ == "f65dv" else profiles(typ)
    ents = f65dv_entries(prof) if typ == "f65dv" else entries(typ, prof)
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids))
    with open(os.path.join(HERE, f"cbi_{typ}_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", f"vendor-trip-units-cbi-{typ}.js"), "w") as f:
        f.write(js_profiles(typ, prof))
    for k, v in prof.items():
        t = v["curve"]["tol"]
        print(f"  {k}: Im {v['dials']['magnetic_pickup']['def']} +/-{t['instantaneous']['pickup_tol']}, pickup {t['pickup']}, hold {t['instantaneous']['hold_s']} break {t['instantaneous']['break_s']}")
    print(f"{typ}: {len(ents)} entries, {len(prof)} trip-unit profiles")


if __name__ == "__main__":
    import sys
    for typ in (sys.argv[1:] or [t for t in TYPES]):
        build(typ)
