#!/usr/bin/env python3
"""ABB SACE Tmax XT moulded-case circuit-breaker library (XT1-XT7): thermal-magnetic TMD / TMA (TMF) and
electronic Ekip Dip / Ekip Touch trip units for power distribution.

Writes, from the tables below and data/abb_xt_curves.json (never edit the outputs by hand):
  testing/vendor-libraries/abb_xt_breakers.json   import file — {"entries": [{"kind": "cbs", "data": {...}}]}
  frontend/js/vendor-trip-units-abb-xt.js         the trip-unit profiles the entries point at (TRIP_UNITS)

Sources (ABB):
  1SDC210100D0206  SACE Tmax XT catalogue, IEC, Edition 08/2024 — p.2/2-2/7 breaking capacities (Icu / Ics at
                   415 V) per size and performance level; p.3/16-3/17 which trip unit fits which size and its In range;
                   p.3/19-3/20 TMD / TMA ratings and I1 / I3 settings (MIN / MED / MAX, amps); p.3/23-3/28 Ekip Dip
                   ratings, settings and tolerances; p.3/48-3/55 Ekip Touch / Hi-Touch ratings, settings, tolerances
  1SDC210033D0704  SACE Tmax XT technical catalogue, IEC (2017) — the thermal-magnetic trip curves (chapter 4) of
                   XT1-XT4; I1 adjustable 0.7...1 x In; TMA I3 adjustable between MIN and MAX
  9AKK108468A0163 / 9AKK108468A0227  ABB US time-current curves of XT5 / XT6 with TMA (the only published XT5 / XT6
                   TMA curves found); thermal dial 70-100 % of In in 7.5 % steps
  The curves are digitised from the vector drawings by digitize_abb_xt.py.

What the numbers mean
---------------------
Thermal-magnetic (TMD / TMA / TMF): one profile per size and rating. The long-time band is the published one in
multiples of I1: the engines clear on its top edge (`thermal_curve`), the TCC draws it down to its bottom edge
(`long_time.min_points`); no trip below 1.05 x I1, certain trip above 1.3 x I1 (IEC 60947-2). I3 is in amps on the
device (fixed for TMD / TMF, MIN...MAX for TMA) and does not move with the I1 dial, so it is held against In
(`base: 'In'`). I3 tolerance +/-20 %: the XT5 / XT6 sheets draw exactly that band (8-12 x In at I3 = 10 x In); the
IEC catalogue does not state it for XT1-XT4, and +/-20 % is the IEC 60947-2 limit for an instantaneous release. Break
time above I3: XT1-XT4 the catalogue charts' line (0.016 s); XT5 / XT6 the US sheets' maximum total clearing time
just above the I3 band (0.079 s; it falls to ~0.02 s at very high currents), minimum commit time 0.01 s.

Electronic (Ekip): the long-time curve is ABB's formula t = t1 x (3 x I1 / I)^2 (t1 at 3 x I1), as for SACE Emax 2.
S and I thresholds are multiples of In (`base: 'In'`), so the I1 dial does not move them. S is the definite-time
(t = k) characteristic.
* Ekip Dip LS/I: the S and I functions share one threshold dial and either S or I is active, so it is offered as two
  profiles, "set as L-S" and "set as L-I" (the latter also stands for Ekip Dip LIG).
* Ekip Dip LSI / LSIG (and Ekip C Dip / Dip Measuring with the same manual settings): one profile per size group
  (t1 positions differ: XT2/XT4 3-12-36-60 s, XT5 3-12-36-48 s, XT6 3-12-36-72 s (800) / 42 s (1000), XT7 eight
  positions 3-144 s).
* Ekip Touch / Hi-Touch LSI / LSIG: the IEC 60947-2 L curve, S excludable, I not (catalogue: "All the protection
  functions can be excluded if needed except for L, I, MCR").
Tolerances as published (self-powered at full power or with auxiliary supply, 2-3 phases): L trips between 1.05 and
1.3 x I1 (Dip) / 1.05 and 1.2 x I1 (Touch); L time +/-10 % up to 4 x In, +/-20 % above (Dip XT2-XT6; 6 x In on XT7
and Touch); S threshold +/-10 % (Dip) / +/-7 % up to 6 x In, +/-10 % above (Touch); I +/-10 %, trip time at most
20 ms (Dip LS/I), 40 ms (Dip LSI), 30 ms (XT7, Touch).

Known simplifications (recorded, not hidden)
--------------------------------------------
* TMD / TMA I1 is a continuous knob: offered in 0.05 x In steps (XT1-XT4) or the 7.5 % positions of the US sheets
  (XT5 / XT6); the catalogue's MIN / MED / MAX are among them. TMA I3 is offered at MIN, MED, MAX and every 0.5 x In
  between. XT1 16 / 20 A (and every TMF) have a fixed I1 = In (the 2024 table gives only MAX).
* XT5 / XT6 TMA: the curves are ABB's US (UL 489) sheets — cold trip, 40 C, published 0.01-1000 s — for 500/600 A
  (XT5) and 600/800 A (XT6), used for every IEC rating of the size (320-630 A, 630-800 A); the XT5 300-400 A sheet
  was not obtainable.
* Ekip Dip S time tolerance: XT2-XT6 LSI is +/-10 % up to 4 x In and +/-20 % above; +/-20 % is used throughout (the
  app's short-time time tolerance does not vary with current). LS/I: +/-15 % (XT2-XT6), +/-10 % (XT7). XT7 LSI and
  Touch: the better of +/-10 % and +/-40 ms.
* Ekip Touch: I1 in 0.01 x In steps (the device: 0.001), the rest in their published steps; the IDMT L curves
  (IEC 60255-151 SI / VI / EI, t = k/I^4), S I2t, S2, 2I, MCR and all G / voltage / power / frequency functions are
  not modelled. Ekip Dip: the I2t S option, G and the thermal memory are not modelled.
* Motor protection (MF / MA, Ekip M), generator protection (TMG, Ekip G), switch-disconnectors, DC ratings, the
  neutral settings and the 4-pole N 50 % thresholds are not included. Icw and the other voltages' Icu are not carried.
* Performance level x rating availability: from the catalogue's ordering codes (chapter 8): XT4 X has no TMD
  16 / 20 / 25 A, XT2 V no Ekip Dip LSI / LSIG; XT1 N / S / H 16 / 20 A are TMF (fixed I1). Otherwise every rating of a
  trip unit (p.3/19, 3/23, 3/48) is offered at every level of its size; Ekip Touch on XT2-XT5 and XT7 630 A are
  ordered as separate trip units / rating plugs, not as complete breakers.
* Defaults the catalogue does not state: I1 = In, t1 12 s, S off (set-as-L-S: I2 10 x In, t2 0.1 s), I3 10 x In;
  TMA I3 at MAX.

Run:  python testing/vendor-libraries/build_abb_xt.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "ABB"
CAT = "1SDC210100D0206"
SOURCE = f"{CAT} (SACE Tmax XT catalogue, IEC, 08/2024)"

# size -> (frame current A by rating, {level: (Icu 415 V kA, Ics % of Icu at 415 V)})
SIZES = {
    "XT1": (lambda i: 160, {"B": (18, 100), "C": (25, 100), "N": (36, 100), "S": (50, 75), "H": (70, 50)}),
    "XT2": (lambda i: 160, {"N": (36, 100), "S": (50, 100), "H": (70, 100), "L": (120, 100), "V": (150, 100)}),
    "XT3": (lambda i: 250, {"N": (36, 100), "S": (50, 50)}),
    "XT4": (lambda i: 250, {"N": (36, 100), "S": (50, 100), "H": (70, 100), "L": (120, 100), "V": (150, 100),
                            "X": (200, 100)}),
    "XT5": (lambda i: 400 if i <= 400 else 630,
            {"N": (36, 100), "S": (50, 100), "H": (70, 100), "L": (120, 100), "V": (200, 100), "X": (200, 100)}),
    "XT6": (lambda i: 800 if i <= 800 else 1000, {"N": (36, 100), "S": (50, 100), "H": (70, 100)}),
    "XT7": (lambda i: next(f for f in (800, 1000, 1250, 1600) if f >= i), {"S": (50, 100), "H": (70, 100),
                                                                           "L": (120, 100)}),
}

# ── Thermal-magnetic: size -> {In: (I3 A MIN, MED, MAX) or I3 A fixed}, catalogue p.3/20 ──
TM = {
    "XT1": {16: 450, 20: 450, 25: 450, 32: 450, 40: 450, 50: 500, 63: 630, 80: 800, 100: 1000, 125: 1250, 160: 1600},
    "XT2": {1.6: 16, 2: 20, 2.5: 25, 3.2: 32, 4: 40, 5: 50, 6.3: 63, 8: 80, 10: 100, 12.5: 125, 16: 300, 20: 300,
            25: 300, 32: 320, 40: (300, 350, 400), 50: (300, 400, 500), 63: (300, 465, 630), 80: (400, 600, 800),
            100: (500, 750, 1000), 125: (625, 940, 1250), 160: (800, 1200, 1600)},
    "XT3": {63: 630, 80: 800, 100: 1000, 125: 1250, 160: 1600, 200: 2000, 250: 2500},
    "XT4": {16: 300, 20: 300, 25: 300, 32: 320, 40: (300, 350, 400), 50: (300, 400, 500), 63: (315, 473, 630),
            80: (400, 600, 800), 100: (500, 750, 1000), 125: (625, 938, 1250), 160: (800, 1200, 1600),
            200: (1000, 1500, 2000), 225: (1125, 1688, 2250), 250: (1250, 1875, 2500)},
    "XT5": {320: (1600, 2400, 3200), 400: (2000, 3000, 4000), 500: (2500, 3750, 5000), 630: (3150, 4725, 6300)},
    "XT6": {630: (3150, 4725, 6300), 800: (4000, 6000, 8000)},
}
TM_FIXED_I1 = {("XT1", 16), ("XT1", 20)}
# not in the ordering codes: (size, level, In) thermal-magnetic, (size, level) Ekip Dip LSI / LSIG
TM_NOT = {("XT4", "X", 16), ("XT4", "X", 20), ("XT4", "X", 25)}
DIP_LSI_NOT = {("XT2", "V")}
# size (+ rating band) -> digitised chart in data/abb_xt_curves.json
TM_CHART = {"XT1": lambda i: "xt1_16_63" if i <= 63 else "xt1_80_160", "XT2": lambda i: "xt2",
            "XT3": lambda i: "xt3", "XT4": lambda i: "xt4", "XT5": lambda i: "xt5", "XT6": lambda i: "xt6"}

# ── Ekip: size -> ratings, catalogue p.3/23 (Dip) and p.3/48 (Touch) ──
DIP_IN = {"XT2": [10, 25, 63, 100, 160], "XT4": [40, 63, 100, 160, 250], "XT5": [250, 320, 400, 630],
          "XT6": [630, 800, 1000], "XT7": [630, 800, 1000, 1250, 1600]}
TOUCH_IN = {"XT2": [40, 63, 100, 160], "XT4": [100, 160, 250], "XT5": [250, 320, 400, 630],
            "XT7": [800, 1000, 1250, 1600]}


def _r(lo, hi, step, nd=3):
    out, k = [], 0
    while True:
        v = round(lo + k * step, nd)
        if v > hi + 1e-9:
            return out
        out.append(v)
        k += 1


I23_DIP = [1, 1.5, 2, 2.5, 3, 3.5, 4.5, 5.5, 6.5, 7, 7.5, 8, 8.5, 9, 10]      # I2 / I3, Ekip Dip XT2-XT6 (x In)
I1_XT7 = [0.4, 0.42, 0.45, 0.47, 0.5, 0.52, 0.55, 0.57, 0.6, 0.62, 0.65, 0.67, 0.7, 0.72, 0.75,
          0.77, 0.8, 0.82, 0.85, 0.87, 0.9, 0.92, 0.95, 0.97, 1.0]
I2_XT7 = [0.6, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10]
I3_XT7 = [1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]


def _ekip_curve(first_m, tol):
    return {"model": "i2t", "thermal": {"i2t": 3, "param": "long_time_delay", "first_m": first_m}, "tol": tol}


def _lt_tol(split):
    return {"time_tol": [[split, 0.10], [None, 0.20]]}


# Ekip Dip groups: (sizes, LS/I t1, LSI I1, LSI t1, LSI I2, LSI t2, LSI I3, LT split, LS/I S time tol,
#                   LSI S time tol, LS/I I time, LSI I time)
_ST_DIP = {"rel": 0.20, "abs": 1000}
_ST_XT7 = {"rel": 0.10, "abs": 0.04}
DIP = {
    "xt24": dict(t1_lsi_s=[12, 36], i1=_r(0.4, 1.0, 0.02, 2), t1=[3, 12, 36, 60], i2=I23_DIP, t2=[0.05, 0.1, 0.2, 0.4],
                 i3=I23_DIP, split=4, st_ls={"rel": 0.15, "abs": 1000}, st=_ST_DIP, brk_ls=0.020, brk=0.040),
    "xt5": dict(t1_lsi_s=[12, 36], i1=_r(0.4, 1.0, 0.02, 2), t1=[3, 12, 36, 48], i2=I23_DIP, t2=[0.05, 0.1, 0.2, 0.4],
                i3=I23_DIP, split=4, st_ls={"rel": 0.15, "abs": 1000}, st=_ST_DIP, brk_ls=0.020, brk=0.040),
    "xt6_800": dict(t1_lsi_s=[12, 36], i1=_r(0.4, 1.0, 0.02, 2), t1=[3, 12, 36, 72], i2=I23_DIP,
                    t2=[0.05, 0.1, 0.2, 0.4], i3=I23_DIP, split=4, st_ls={"rel": 0.15, "abs": 1000}, st=_ST_DIP,
                    brk_ls=0.020, brk=0.040),
    "xt6_1000": dict(t1_lsi_s=[12, 36], i1=_r(0.4, 1.0, 0.02, 2), t1=[3, 12, 36, 42], i2=I23_DIP,
                     t2=[0.05, 0.1, 0.2, 0.4], i3=I23_DIP, split=4, st_ls={"rel": 0.15, "abs": 1000}, st=_ST_DIP,
                     brk_ls=0.020, brk=0.040),
    "xt7": dict(t1_lsi_s=[12, 48], i1=I1_XT7, t1=[3, 12, 24, 36, 48, 72, 108, 144], i2=I2_XT7, t2=_r(0.1, 0.8, 0.1, 1),
                i3=I3_XT7, split=6, st_ls={"rel": 0.10, "abs": 1000}, st=_ST_XT7, brk_ls=0.030, brk=0.030),
}
DIP_GROUP = {"XT2": lambda i: "xt24", "XT4": lambda i: "xt24", "XT5": lambda i: "xt5",
             "XT6": lambda i: "xt6_800" if i <= 800 else "xt6_1000", "XT7": lambda i: "xt7"}
# Ekip Touch groups: t1 range, t2 maximum, I3 maximum (x In)
TOUCH = {"xt24": dict(t1=60, t2=0.4, i3=10), "xt5": dict(t1=48, t2=0.5, i3=10), "xt7": dict(t1=144, t2=0.8, i3=15)}
TOUCH_GROUP = {"XT2": "xt24", "XT4": "xt24", "XT5": "xt5", "XT7": "xt7"}


def _x(a, inn):
    return round(a / inn, 5)


def tm_id(size, inn):
    return f"abb_xt_tm_{size.lower()}_{str(inn).replace('.', '_')}"


def tm_profiles(curves):
    p = {}
    for size, ratings in TM.items():
        for inn, i3 in ratings.items():
            c = curves[TM_CHART[size](inn)]
            us = size in ("XT5", "XT6")
            if size in ("XT5", "XT6"):
                i1 = {"steps": [0.7, 0.775, 0.85, 0.925, 1.0], "def": 1.0}
            elif (size, inn) in TM_FIXED_I1:
                i1 = {"fixed": True, "def": 1.0}
            else:
                i1 = {"steps": _r(0.7, 1.0, 0.05, 2), "def": 1.0}
            if isinstance(i3, tuple):
                lo, med, hi = i3
                amps = sorted({lo, med, hi} | {a for a in _r(0, hi, inn / 2, 4) if lo < a < hi})
                mag = {"steps": [_x(a, inn) for a in amps], "def": _x(hi, inn), "base": "In"}
                kind = "TMA"
            else:
                mag = {"fixed": True, "def": _x(i3, inn), "base": "In"}
                kind = "TMD / TMF" if (size, inn) in TM_FIXED_I1 else "TMD"
            inst = {"pickup_tol": 0.20, "break_s": c["break_s"]}
            if c.get("hold_s"):
                inst["hold_s"] = c["hold_s"]
            p[tm_id(size, inn)] = {
                "maker": MAKER, "catalogue": CAT, "kind": "tm",
                "label": f"ABB {kind} thermal-magnetic {inn} A" + (" (curve: ABB US sheet)" if us else ""),
                "curve": {"model": "points", "thermal": {"points": c["max"]}, "tol": {
                    "pickup": [1.05, 1.30],
                    "long_time": {"min_points": c["min"]},
                    "instantaneous": inst}},
                "dials": {"thermal_pickup": i1, "magnetic_pickup": mag},
            }
    return p


def ekip_profiles():
    p = {}
    base = {"maker": MAKER, "catalogue": CAT, "kind": "electronic"}
    for g, d in DIP.items():
        lt = _lt_tol(d["split"])
        tol_ls = {"pickup": [1.05, 1.30], "long_time": lt,
                  "short_time": {"pickup_tol": 0.10, "time_tol": d["st_ls"]},
                  "instantaneous": {"pickup_tol": 0.10, "break_s": d["brk_ls"]}}
        i1_s = {"steps": _r(0.4, 1.0, 0.04, 2), "def": 1.0, "label": "I1"}
        t1_s = {"steps": d["t1_lsi_s"], "def": 12, "label": "t1", "unit": "s at 3 × I1"}
        p[f"abb_xt_dip_ls_{g}"] = {**base, "label": "ABB Ekip Dip LS/I, set as L-S",
                                   "curve": _ekip_curve(1.3, tol_ls), "dials": {
            "thermal_pickup": i1_s, "long_time_delay": t1_s,
            "short_time_pickup": {"steps": I23_DIP, "def": 10, "base": "In", "label": "I2"},
            "short_time_delay": {"steps": [0.1, 0.2], "def": 0.1, "label": "t2"},
            "instantaneous_pickup": {"fixed": True, "def": 0, "off": True, "base": "In", "label": "I3"}}}
        p[f"abb_xt_dip_li_{g}"] = {**base, "label": "ABB Ekip Dip LS/I set as L-I, or LIG",
                                   "curve": _ekip_curve(1.3, {k: v for k, v in tol_ls.items() if k != "short_time"}),
                                   "dials": {
            "thermal_pickup": i1_s, "long_time_delay": t1_s,
            "instantaneous_pickup": {"steps": [0] + I23_DIP, "off": True, "def": 10, "base": "In", "label": "I3"}}}
        p[f"abb_xt_dip_lsi_{g}"] = {**base, "label": "ABB Ekip Dip LSI / LSIG", "curve": _ekip_curve(1.3, {
            "pickup": [1.05, 1.30], "long_time": lt,
            "short_time": {"pickup_tol": 0.10, "time_tol": d["st"]},
            "instantaneous": {"pickup_tol": 0.10, "break_s": d["brk"]}}), "dials": {
            "thermal_pickup": {"steps": d["i1"], "def": 1.0, "label": "I1"},
            "long_time_delay": {"steps": d["t1"], "def": 12, "label": "t1", "unit": "s at 3 × I1"},
            "short_time_pickup": {"steps": [0] + d["i2"], "off": True, "def": 0, "base": "In", "label": "I2"},
            "short_time_delay": {"steps": d["t2"], "def": d["t2"][1] if g == "xt7" else 0.1, "label": "t2"},
            "instantaneous_pickup": {"steps": [0] + d["i3"], "off": True, "def": 10, "base": "In", "label": "I3"}}}
    for g, d in TOUCH.items():
        p[f"abb_xt_touch_{g}"] = {**base, "label": "ABB Ekip Touch / Hi-Touch LSI / LSIG", "curve": _ekip_curve(1.2, {
            "pickup": [1.05, 1.20], "long_time": _lt_tol(6),
            "short_time": {"pickup_tol": [[6, 0.07], [None, 0.10]], "time_tol": {"rel": 0.10, "abs": 0.04}},
            "instantaneous": {"pickup_tol": 0.10, "break_s": 0.030}}), "dials": {
            "thermal_pickup": {"steps": _r(0.4, 1.0, 0.01, 2), "def": 1.0, "label": "I1"},
            "long_time_delay": {"steps": _r(3, d["t1"], 1, 0), "def": 12, "label": "t1", "unit": "s at 3 × I1"},
            "short_time_pickup": {"steps": [0] + _r(0.6, 10, 0.1, 1), "off": True, "def": 0, "base": "In",
                                  "label": "I2"},
            "short_time_delay": {"steps": _r(0.05, d["t2"], 0.01, 2), "def": 0.1, "label": "t2"},
            "instantaneous_pickup": {"steps": _r(1.5, d["i3"], 0.1, 1), "def": 10, "base": "In", "label": "I3"}}}
    return p


def _fmt(inn):
    return f"{inn:g}"


def entries(prof):
    out = []
    for size, (frame, levels) in SIZES.items():
        tm = TM.get(size, {})
        dip = DIP_IN.get(size, [])
        touch = TOUCH_IN.get(size, [])
        for lvl, (icu, ics) in levels.items():
            for inn in sorted(set(tm) | set(dip) | set(touch)):
                units = []
                if inn in tm and (size, lvl, inn) not in TM_NOT:
                    units.append(tm_id(size, inn))
                if inn in dip:
                    g = DIP_GROUP[size](inn)
                    if (size, lvl) not in DIP_LSI_NOT:
                        units.append(f"abb_xt_dip_lsi_{g}")
                    units += [f"abb_xt_dip_ls_{g}", f"abb_xt_dip_li_{g}"]
                if inn in touch:
                    units.append(f"abb_xt_touch_{TOUCH_GROUP[size]}")
                if not units:
                    continue
                first = prof[units[0]]["dials"]
                mag = (first["magnetic_pickup"]["def"] if "magnetic_pickup" in first
                       else first["instantaneous_pickup"]["def"])
                out.append({"kind": "cbs", "data": {
                    "id": f"abb_{size.lower()}{lvl.lower()}_{_fmt(inn).replace('.', '_')}",
                    "name": f"ABB {size}{lvl} {_fmt(inn)} A",
                    "cb_type": "mccb", "manufacturer": MAKER, "series": "SACE Tmax XT", "model": f"{size}{lvl}",
                    "trip_rating_a": inn, "frame_a": frame(inn), "rated_voltage_kv": 0.4, "breaking_ka": icu,
                    "ics_pct": ics, "thermal_pickup": 1.0, "magnetic_pickup": mag,
                    "long_time_delay": 10 if units[0].startswith("abb_xt_tm_") else 12,
                    "trip_units": units, "default_trip_unit": units[0], "source": SOURCE,
                }})
    return out


def js_profiles(p):
    return (
        "// GENERATED by testing/vendor-libraries/build_abb_xt.py — do not edit by hand.\n"
        "// ABB SACE Tmax XT trip-unit profiles: TMD / TMA / TMF thermal-magnetic (`curve.thermal` the published\n"
        "// maximum long-time curve in x I1, `long_time.min_points` the minimum; I3 held against In) and Ekip Dip /\n"
        "// Touch electronic (formula long-time curve t = t1 x (3 / M)^2; S and I multiples of In).\n"
        f"Object.assign(TRIP_UNITS, {json.dumps(p, indent=1)});\n"
    )


if __name__ == "__main__":
    curves = json.load(open(os.path.join(HERE, "data", "abb_xt_curves.json")))
    prof = {**tm_profiles(curves), **ekip_profiles()}
    ents = entries(prof)
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids))
    for e in ents:
        for u in e["data"]["trip_units"]:
            assert u in prof, u
    with open(os.path.join(HERE, "abb_xt_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units-abb-xt.js"), "w") as f:
        f.write(js_profiles(prof))
    print(f"{len(ents)} entries, {len(prof)} trip-unit profiles")
