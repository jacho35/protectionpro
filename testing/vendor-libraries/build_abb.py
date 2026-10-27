#!/usr/bin/env python3
"""ABB SACE Emax 2 air circuit-breaker library (Ekip Dip, Ekip Touch / Hi-Touch).

Writes, from the tables below (never edit the outputs by hand):
  testing/vendor-libraries/abb_breakers.json   import file — {"entries": [{"kind": "cbs", "data": {...}}]}
  frontend/js/vendor-trip-units-abb.js         the trip-unit profiles the entries point at (TRIP_UNITS)

Source (ABB, downloaded from library.e.abb.com):
  1SDC200023D0204  SACE Emax 2 technical catalogue, Edition 2015.10 —
                   p.2/4 breaking capacities and ratings per performance level,
                   p.3/37-3/39 "Technical characteristics for protection trip units"
                   (thresholds, steps, trip times, tolerances), factory defaults
                   (manual 1SDH000999R0002: L 1 x In / 144 s, I 4 x In).

What the numbers mean
---------------------
ABB's S and I thresholds are multiples of In (I2 = 0.6...10 x In, I3 = 1.5...15
x In), like I1 itself; the library holds them against In (`base: 'In'`) so the
I1 dial does not move them. The long-time curve is the formula
t = t1 x (3 x I1 / I)^2 (t1 = the trip time at 3 x I1, 3...144 s; minimum 1 s,
self-protection): `thermal_curve.i2t`. Published tolerances: L trips between
1.05 and 1.2 x I1, time +/-10 % up to 6 x In and +/-20 % above; S threshold
+/-7 % up to 6 x In and +/-10 % above, time the better of +/-10 % and +/-40 ms;
I +/-10 %, trip time at most 30 ms.

Known simplifications (recorded, not hidden)
--------------------------------------------
* Ekip Touch / Hi-Touch: I1 is offered in 0.01 x In steps (the device: 0.001),
  the other thresholds in their published steps.
* S is the definite-time (t = k) characteristic; the I2t-ON option, zone
  selectivity, start-up and the G / Gext / IU / Rc / voltage / frequency
  protections are not modelled. Ekip Touch's IDMT L curves (SI / VI / EI) are
  not offered.
* The service ratings Ics and Icw(3 s) are not carried; Icw (1 s) is.
* Performance level x rating availability is as the catalogue's table lays
  out its columns (E1.2: B / C 630-1600, N 250-1600, L 630-1250; E2.2: B
  1600-2000, N / H 800-2500, S 250-2500; E4.2: N / S / H 3200-4000, V
  2000-4000; E6.2: H / V / X 4000-6300).
* Not included here: Tmax XT is build_abb_xt.py (abb_xt_breakers.json);
  Tmax T and S200 MCBs are not carried.

Run:  python testing/vendor-libraries/build_abb.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "ABB"
CAT = "1SDC200023D0204"
SOURCE = f"{CAT} (SACE Emax 2 technical catalogue, 2015.10)"

# frame -> (frame current, {level: (Icu 400-415 V kA, Icw 1 s kA, ratings)})
EMAX2 = {
    "E1.2": (1600, {
        "B": (42, 42, [630, 800, 1000, 1250, 1600]),
        "C": (50, 42, [630, 800, 1000, 1250, 1600]),
        "N": (66, 50, [250, 630, 800, 1000, 1250, 1600]),
        "L": (150, 15, [630, 800, 1000, 1250]),
    }),
    "E2.2": (2500, {
        "B": (42, 42, [1600, 2000]),
        "N": (66, 66, [800, 1000, 1250, 1600, 2000, 2500]),
        "S": (85, 66, [250, 800, 1000, 1250, 1600, 2000, 2500]),
        "H": (100, 85, [800, 1000, 1250, 1600, 2000, 2500]),
    }),
    "E4.2": (4000, {
        "N": (66, 66, [3200, 4000]),
        "S": (85, 66, [3200, 4000]),
        "H": (100, 85, [3200, 4000]),
        "V": (150, 100, [2000, 2500, 3200, 4000]),
    }),
    "E6.2": (6300, {
        "H": (100, 100, [4000, 5000, 6300]),
        "V": (150, 100, [4000, 5000, 6300]),
        "X": (150, 120, [4000, 5000, 6300]),
    }),
}


def _r(lo, hi, step, nd=3):
    out, k = [], 0
    while True:
        v = round(lo + k * step, nd)
        if v > hi + 1e-9:
            return out
        out.append(v)
        k += 1


I1_DIP = [0.4, 0.42, 0.45, 0.47, 0.5, 0.52, 0.55, 0.57, 0.6, 0.62, 0.65, 0.67, 0.7, 0.72, 0.75,
          0.77, 0.8, 0.82, 0.85, 0.87, 0.9, 0.92, 0.95, 0.97, 1.0]
T1_DIP = [3, 12, 24, 36, 48, 72, 108, 144]
I2_DIP = [0.6, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10]
T2_DIP = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
I3_DIP = [1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

TOL = {
    "pickup": [1.05, 1.20],                                   # trip between 1.05 and 1.2 x I1
    "long_time": {"time_tol": [[6, 0.10], [None, 0.20]]},     # +/-10 % up to 6 x In, +/-20 % above
    "short_time": {"pickup_tol": [[6, 0.07], [None, 0.10]],   # +/-7 % up to 6 x In, +/-10 % above
                   "time_tol": {"rel": 0.10, "abs": 0.04}},   # the better of +/-10 % and +/-40 ms
    "instantaneous": {"pickup_tol": 0.10, "break_s": 0.030},  # +/-10 %, at most 30 ms
}
CURVE = {"model": "i2t",
         "thermal": {"i2t": 3, "param": "long_time_delay", "floor_s": 1, "first_m": 1.2},
         "tol": TOL}


def profiles():
    base = {"maker": MAKER, "catalogue": CAT, "kind": "electronic"}
    def dials(i1, t1, i2, t2, i3, s=True, i_off=True):
        # ABB's own names: I1 / t1 (at 3 x I1) / I2 / t2 / I3
        d = {"thermal_pickup": {"steps": i1, "def": 1.0, "label": "I1"},
             "long_time_delay": {"steps": t1, "def": 144, "label": "t1", "unit": "s at 3 × I1"}}
        if s:
            d["short_time_pickup"] = {"steps": [0] + i2, "off": True, "def": 0, "base": "In", "label": "I2"}
            d["short_time_delay"] = {"steps": t2, "def": t2[0], "label": "t2"}
        d["instantaneous_pickup"] = {"steps": ([0] if i_off else []) + i3, "def": 4, "label": "I3",
                                     "base": "In", **({"off": True} if i_off else {})}
        return d
    tol_li = {k: v for k, v in TOL.items() if k != "short_time"}
    return {
        "abb_emax2_dip_lsi": {**base, "label": "ABB Ekip Dip LSI", "curve": CURVE,
                              "dials": dials(I1_DIP, T1_DIP, I2_DIP, T2_DIP, I3_DIP)},
        "abb_emax2_dip_li": {**base, "label": "ABB Ekip Dip LI", "curve": {**CURVE, "tol": tol_li},
                             "dials": dials(I1_DIP, T1_DIP, I2_DIP, T2_DIP, I3_DIP, s=False, i_off=False)},
        "abb_emax2_touch_lsi": {**base, "label": "ABB Ekip Touch / Hi-Touch LSI", "curve": CURVE,
                                "dials": dials(_r(0.4, 1.0, 0.01, 2), _r(3, 144, 1, 0), _r(0.6, 10, 0.1, 1),
                                               _r(0.05, 0.8, 0.01, 2), _r(1.5, 15, 0.1, 1))},
    }


def entries():
    out = []
    for frame, (frame_a, levels) in EMAX2.items():
        for lvl, (icu, icw, ratings) in levels.items():
            for inn in ratings:
                out.append({"kind": "cbs", "data": {
                    "id": f"abb_{frame.lower().replace('.', '_')}_{lvl.lower()}_{inn}",
                    "name": f"ABB {frame} {lvl} {inn} A",
                    "cb_type": "acb", "manufacturer": MAKER, "series": "SACE Emax 2", "model": f"{frame} {lvl}",
                    "trip_rating_a": inn, "frame_a": frame_a, "rated_voltage_kv": 0.4, "breaking_ka": icu,
                    "icw_ka": icw, "thermal_pickup": 1.0, "magnetic_pickup": 4, "long_time_delay": 144,
                    "trip_units": ["abb_emax2_dip_lsi", "abb_emax2_dip_li", "abb_emax2_touch_lsi"],
                    "default_trip_unit": "abb_emax2_dip_lsi", "source": SOURCE,
                }})
    return out


def js_profiles(p):
    return (
        "// GENERATED by testing/vendor-libraries/build_abb.py — do not edit by hand.\n"
        "// ABB SACE Emax 2 trip-unit profiles (Ekip Dip LI / LSI, Ekip Touch / Hi-Touch LSI).\n"
        "// `curve.thermal` is the formula long-time curve t = T x (3 / M)^2 (thermal_curve.i2t),\n"
        "// `curve.tol` the published tolerances (trip_tol, see cbTripBand); S and I are multiples\n"
        "// of In (`base: 'In'`, pickup_base).\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


if __name__ == "__main__":
    prof, ents = profiles(), entries()
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids))
    with open(os.path.join(HERE, "abb_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb.js"), "w") as f:
        f.write(js_profiles(prof))
    print(f"{len(ents)} entries, {len(prof)} trip-unit profiles")
