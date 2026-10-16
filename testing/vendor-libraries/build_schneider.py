#!/usr/bin/env python3
"""Schneider Electric low-voltage breaker library: ComPacT NSX / NSXm, Acti9 MCBs,
Masterpact MTZ.

Writes, from the tables below (never edit the outputs by hand):
  testing/vendor-libraries/schneider_breakers.json   import file — {"entries": [{"kind": "cbs", "data": {...}}]}
                                                      for POST /api/shared-libraries/{id}/entries/import
  frontend/js/vendor-trip-units.js                   the trip-unit profiles the entries point at (TRIP_UNITS)

Sources (Schneider Electric, downloaded from se.com / productinfo.se.com):
  LVPED221001EN  ComPacT NSX & NSXm catalogue 2021 — breaking capacity (A-3, A-7, A-8), which trip unit fits which
                 frame (B-4 .. B-15), TM-D / MicroLogic settings and long-time points
  DOCA0187EN-04  ComPacT NSX circuit breakers 100-630 A user guide — TM-D and MicroLogic 2 settings
  DOCA0188EN-03  ComPacT NSX MicroLogic 5/6/7 user guide — Ir / tr / Isd / tsd / Ii values, tr table
  Acti9_A9XPH212_CAT  Acti9 catalogue, Version 2.0 - May 2017 — iC60N/H/L and C120N/H ratings, breaking
                 capacities, magnetic bands, the IEC 60898-1 tripping-curve bands (data/acti9_iec60898_curves.json,
                 digitised by digitize_acti9.py)
  DOCA0102EN-12 MasterPacT MTZ MicroLogic X control unit user guide — Ir / tr / Isd / tsd / Ii settings, tolerances,
                 operating times; DOCA0100EN-08 (MTZ1) and DOCA0101EN-09 (MTZ2/MTZ3) — performance levels

What the numbers mean (the point of the `base` flags below)
-----------------------------------------------------------
Schneider fixes the instantaneous element against the trip-unit rating In:
TM-D Ii is a fixed (or dial) value in amps, MicroLogic 2 Ii is fixed in amps
and MicroLogic 5/6/7 Ii is set "in multiples of In". It therefore does NOT move
when the Ir dial is turned. Isd is a multiple of Ir. The library stores each
pickup as a multiple of the current its dial is of — `base: 'In'` on the Ii
dials makes the app hold Ii against In (props.pickup_base, cb_settings.py) —
so the amps shown are the amps on the device at every Ir position.

NSX / NSXm: one profile per trip-unit rating In (the Ir dial positions are in
amps and differ per rating; the dial steps are amps / In). Masterpact MTZ:
two profiles (MicroLogic 2.0 X and 5.0 X / 6.0 X / 7.0 X) — the ranges are
multiples of In, the same for every sensor plug.

Known simplifications (recorded, not hidden)
--------------------------------------------
* Ir: NSX / NSXm the dial presets only (MicroLogic's keypad fine-tuning in 1 A
  steps, 0.9-1.0 x Io on MicroLogic 2, is not offered). MTZ: 0.05 x In steps
  of the published 0.4-1 x In range (the device steps in 1 A).
* The NSX 250 A rating's fifth Ir preset is 160 A in the 2021 catalogue (four
  tables) and 150 A in DOCA0188EN-03; the catalogue's 160 A is used.
* tsd: the dial value is the setting (0 / 0.1 / 0.2 / 0.3 / 0.4 s). The TCC
  band and the engines use the published non-tripping (hold) and maximum break
  times of that setting (20/80, 80/140, 140/200, 230/320, 350/500 ms); the
  I2t ON option is not modelled.
* Tolerances (`curve.tol`, drawn as the TCC's min-max band; the engines use the
  maximum): long-time 0 to -20 % of the published time, pickup somewhere in
  1.05-1.20 x Ir (the curve is published from 1.5 x Ir; below that it is
  marked as the pickup zone and only dotted in, not claimed); Isd +/-10 %
  (+/-15 % on MicroLogic 2 in DOCA0187EN-04 p.180 while the catalogue says
  10 % — the wider is used); Ii +/-15 % with 10 ms non-trip / 50 ms maximum
  break. TM-D: Ii +/-20 %; its long-time band is 120-400 s at 1.5 x In and is
  extended at the same 0.3 ratio (only that point is published); its
  instantaneous time is not published (generic 25 ms).
* TM-D Ii on NSX100: 80 A is 640 A in the user guide and the catalogue's
  setting table (650 A in the 400 Hz derating table); 640 A is used.
* Defaults the sources do not state: Isd 1.5 x Ir on MicroLogic 2 / Vigi 4.1,
  the adjustable TM-D Ii at its maximum dial position. NSXm TM-D: the Ir dial
  positions are taken from the NSX TM-D tables (same "0.7-1 x In, 11-160 A"),
  its long-time curve is not published (generic model), Ii +/-20 % and the
  1.05-1.20 x Ir pickup are.
* NSXm MicroLogic Vigi 4.1: the earth-leakage function is not modelled.
* Acti9: iC60N / H / L B, C, D and C120N / H B, C, D. The K, Z and MA curves
  are not offered (the app's MCB curve letters are B / C / D). `breaking_ka`
  is Icn (IEC 60898-1, the library's MCB convention); Icu (IEC 60947-2) and
  Ics are carried as `icu_ka` / `ics_pct`. iC60L 50 / 63 A has no Icn: Icu is used.
  The curves are the IEC 60898-1 (30 C) band of the catalogue; the magnetic
  edges are the drawn ones (B 3.2-4.8, C 6.4-9.6, D 10-14 x In) and the
  breaking time is "less than 10 ms" above them. The 1P / 1P+N Icu (a
  single-phase figure) is not used: entries are for 3-phase systems.
* Masterpact MTZ: the performance-level (Icu) values are published; WHICH
  ratings each level is offered in is in catalogue LVPED216026EN, which could
  not be downloaded — every level of the frame is listed for every rating and
  the entries carry `check: "level x rating availability not verified"`.
  Fast (30 ms) Ii mode, I2t ON, ZSI and dual settings are not modelled; the
  NT / NW range is not included (its catalogue could not be downloaded).
  Factory settings are the defaults (tr 0.5 s, Isd 1.5 x Ir, tsd 0, Ii 2 x In).

Run:  python testing/vendor-libraries/build_schneider.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MAKER = "Schneider Electric"
CAT = "LVPED221001EN"
SOURCE = f"{CAT}; DOCA0187EN-04; DOCA0188EN-03"
DATA = os.path.join(HERE, "data")

# ── breaking capacity Icu (kA rms) at 380/415 V, catalogue pages A-7 / A-8 ──
ICU_415 = {
    100: {"B": 25, "F": 36, "N": 50, "H": 70, "S": 100, "L": 150},
    160: {"B": 25, "F": 36, "N": 50, "H": 70, "S": 100, "L": 150},
    250: {"B": 25, "F": 36, "N": 50, "H": 70, "S": 100, "L": 150},
    400: {"F": 36, "N": 50, "H": 70, "S": 100, "L": 150},
    630: {"F": 36, "N": 50, "H": 70, "S": 100, "L": 150},
}

# ── TM-D (thermal-magnetic) — catalogue B-5 matrix: NSX100 TM16D-TM100D,
#    NSX160 TM32D-TM160D, NSX250 TM63D-TM250D ──
TMD_IN = {
    100: [16, 25, 32, 40, 50, 63, 80, 100],
    160: [32, 40, 50, 63, 80, 100, 125, 160],
    250: [63, 80, 100, 125, 160, 200, 250],
}
# Ir dial positions (A) per rating — DOCA0187EN-04 pp.155-158
TMD_IR_A = {
    16: [11, 13, 14, 16], 25: [18, 20, 23, 25], 32: [22, 26, 29, 32], 40: [28, 32, 36, 40],
    50: [35, 40, 45, 50], 63: [44, 50, 57, 63], 80: [56, 64, 72, 80], 100: [70, 80, 90, 100],
    125: [88, 100, 113, 125], 160: [112, 128, 144, 160], 200: [140, 160, 180, 200],
    250: [175, 200, 225, 250],
}
# Fixed Ii (A, +/-20 %), ratings below 200 A
TMD_II_FIXED_A = {16: 190, 25: 300, 32: 400, 40: 500, 50: 500, 63: 500,
                  80: 640, 100: 800, 125: 1250, 160: 1250}
# Ii dial positions (A) of TM200D / TM250D
TMD_II_DIAL_A = {
    200: [1000, 1200, 1400, 1600, 1800, 2000],
    250: [1250, 1500, 1750, 2000, 2250, 2500],
}
# Published long-time points, catalogue B-5: tr at 1.5 x In 120-400 s, tr at 6 x Ir 15 s.
# 400 s is the upper edge of the band (the curve is plotted at its maximum).
TMD_LT = {"points": [[1.5, 400], [6, 15]]}

# Published tolerances -> the TCC band and the engines' maximum clearing time
TOL_TMD = {
    "pickup": [1.05, 1.20],                       # tripping between 1.05 and 1.20 x Ir
    "long_time": {"min_factor": 0.3},             # 120 s / 400 s at 1.5 x In
    "instantaneous": {"pickup_tol": 0.20},        # Ii accuracy +/-20 %
}
# MicroLogic tsd -> non-tripping (hold) time and maximum break time (s), catalogue B-13
TSD_HOLD = {"0": 0.02, "0.1": 0.08, "0.2": 0.14, "0.3": 0.23, "0.4": 0.35}
TSD_BREAK = {"0": 0.08, "0.1": 0.14, "0.2": 0.20, "0.3": 0.32, "0.4": 0.50}


def _tol_ml(isd_tol):
    return {
        "pickup": [1.05, 1.20],
        "long_time": {"min_factor": 0.8},          # accuracy 0 to -20 %
        "short_time": {"pickup_tol": isd_tol, "hold_s": TSD_HOLD, "break_s": TSD_BREAK},
        "instantaneous": {"pickup_tol": 0.15, "hold_s": 0.010, "break_s": 0.050},
    }

# ── MicroLogic — which In fits which frame (catalogue B-10, B-12) ──
ML2_IN = {100: [40, 100], 160: [40, 100, 160], 250: [40, 100, 160, 250],
          400: [250, 400], 630: [250, 400, 630]}
ML567_IN = {100: [40, 100], 160: [40, 100, 160], 250: [40, 100, 160, 250],
            400: [400], 630: [400, 630]}
# Ir dial presets Io (A) per rating — catalogue B-10 / B-13, DOCA0188EN-03 p.61.
# The 40 A row lists 18 twice (two positions round to the same value).
IO_A = {
    40: [18, 20, 23, 25, 28, 32, 36, 40],
    100: [40, 45, 50, 55, 63, 70, 80, 90, 100],
    160: [63, 70, 80, 90, 100, 110, 125, 150, 160],
    250: [100, 110, 125, 140, 160, 175, 200, 225, 250],
    400: [160, 180, 200, 230, 250, 280, 320, 360, 400],
    630: [250, 280, 320, 350, 400, 450, 500, 570, 630],
}
IO_A_250_ON_NSX400 = [70, 100, 125, 140, 160, 175, 200, 225, 250]   # MicroLogic 2 "In = 250 A (NSX400)"
# Instantaneous Ii = 15 x In (40-160 A), 12 x In (250-400 A), 11 x In (630 A)
II_X_IN = {40: 15, 100: 15, 160: 15, 250: 12, 400: 12, 630: 11}
ISD_DIAL = [1.5, 2, 3, 4, 5, 6, 7, 8, 10]          # MicroLogic 2: dial positions
# MicroLogic 5/6/7: dial presets and the keypad's 0.5 x Ir steps over 1.5-10
# MicroLogic long-time: published maximum trip time (s) at 1.5 / 6 / 7.2 x Ir per tr setting
ML_LT = {
    "0.5": [[1.5, 15], [6, 0.5], [7.2, 0.35]],
    "1":   [[1.5, 25], [6, 1], [7.2, 0.7]],
    "2":   [[1.5, 50], [6, 2], [7.2, 1.4]],
    "4":   [[1.5, 100], [6, 4], [7.2, 2.8]],
    "8":   [[1.5, 200], [6, 8], [7.2, 5.5]],
    "16":  [[1.5, 400], [6, 16], [7.2, 11]],
}


def _frange(lo, hi, step):
    out, v = [], lo
    while v <= hi + 1e-9:
        out.append(round(v, 4))
        v += step
    return out


def _x_in(amps, rating):
    """A dial position in amps as a multiple of the trip-unit rating."""
    return round(amps / rating, 5)


def _tmd_id(inn):
    return f"se_nsx_tmd_{inn}"


def _ml2_id(inn, frame):
    return "se_nsx_ml2_250_400" if inn == 250 and frame in (400, 630) else f"se_nsx_ml2_{inn}"


def _ml567_id(inn):
    return f"se_nsx_ml567_{inn}"


def nsx_profiles():
    p = {}
    base = {"maker": MAKER, "catalogue": CAT}

    # TM-D: one per rating (its Ir positions and Ii are in amps)
    for inn in sorted({i for ins in TMD_IN.values() for i in ins}):
        if inn in TMD_II_DIAL_A:
            steps = [_x_in(a, inn) for a in TMD_II_DIAL_A[inn]]
            ii = {"steps": steps, "def": steps[-1], "base": "In"}
        else:
            ii = {"fixed": True, "def": _x_in(TMD_II_FIXED_A[inn], inn), "base": "In"}
        p[_tmd_id(inn)] = {
            **base, "label": "Schneider TM-D thermal-magnetic", "kind": "tm",
            "curve": {"model": "points", "thermal": TMD_LT, "tol": TOL_TMD},
            "dials": {
                "thermal_pickup": {"steps": [_x_in(a, inn) for a in TMD_IR_A[inn]], "def": 1.0},
                "magnetic_pickup": ii,
            },
        }

    # MicroLogic 2 (LS0I): fixed tr, fixed tsd, fixed Ii
    for frame, ins in ML2_IN.items():
        for inn in ins:
            pid = _ml2_id(inn, frame)
            if pid in p:
                continue
            io = IO_A_250_ON_NSX400 if pid == "se_nsx_ml2_250_400" else IO_A[inn]
            p[pid] = {
                **base, "label": "Schneider MicroLogic 2 (LS0I)", "kind": "electronic",
                "curve": {"model": "points", "thermal": {"points": ML_LT["16"]}, "tol": _tol_ml(0.15)},
                "dials": {
                    "thermal_pickup": {"steps": [_x_in(a, inn) for a in io], "def": 1.0},
                    "long_time_delay": {"fixed": True, "def": 16},
                    "short_time_pickup": {"steps": ISD_DIAL, "def": 1.5},
                    # S0: fixed delay — non-tripping 20 ms, maximum break 80 ms (the tsd = 0 row)
                    "short_time_delay": {"fixed": True, "def": 0},
                    "instantaneous_pickup": {"fixed": True, "def": II_X_IN[inn], "base": "In"},
                },
            }

    # MicroLogic 5 / 6 / 7 (LSI): adjustable tr, Isd, tsd and Ii
    for inn in sorted({i for ins in ML567_IN.values() for i in ins}):
        mx = II_X_IN[inn]
        p[_ml567_id(inn)] = {
            **base, "label": "Schneider MicroLogic 5 / 6 / 7 (LSI)", "kind": "electronic",
            "curve": {"model": "points", "thermal": {"param": "long_time_delay", "tables": ML_LT},
                      "tol": _tol_ml(0.10)},
            "dials": {
                "thermal_pickup": {"steps": [_x_in(a, inn) for a in IO_A[inn]], "def": 1.0},
                "long_time_delay": {"steps": [0.5, 1, 2, 4, 8, 16], "def": 16},
                "short_time_pickup": {"steps": _frange(1.5, 10, 0.5), "def": 1.5},
                "short_time_delay": {"steps": [0, 0.1, 0.2, 0.3, 0.4], "def": 0},
                "instantaneous_pickup": {"steps": _frange(1.5, mx, 0.5), "def": mx, "base": "In"},
            },
        }
    return p


def nsx_entries():
    out = []
    for frame, classes in ICU_415.items():
        tm = TMD_IN.get(frame, [])
        ml2 = ML2_IN[frame]
        ml5 = ML567_IN[frame]
        for cls, icu in classes.items():
            for inn in sorted(set(tm) | set(ml2) | set(ml5)):
                units = []
                if inn in tm:
                    units.append(_tmd_id(inn))
                if inn in ml2:
                    units.append(_ml2_id(inn, frame))
                if inn in ml5:
                    units.append(_ml567_id(inn))
                # magnetic: the TM-D Ii (x In) when there is a TM-D, else the MicroLogic Ii maximum
                if inn in tm:
                    ii_a = TMD_II_DIAL_A[inn][-1] if inn in TMD_II_DIAL_A else TMD_II_FIXED_A[inn]
                    mag = round(ii_a / inn, 4)
                else:
                    mag = II_X_IN[inn]
                out.append({"kind": "cbs", "data": {
                    "id": f"se_nsx{frame}{cls.lower()}_{inn}",
                    "name": f"Schneider NSX{frame}{cls} {inn} A",
                    "cb_type": "mccb",
                    "manufacturer": MAKER,
                    "series": "ComPacT NSX",
                    "model": f"NSX{frame}{cls}",
                    "trip_rating_a": inn,
                    "frame_a": frame,
                    "rated_voltage_kv": 0.4,
                    "breaking_ka": icu,
                    "thermal_pickup": 1.0,
                    # x In — Schneider fixes Ii against the trip-unit rating
                    "magnetic_pickup": mag,
                    # TM-D: 15 s at 6 x Ir (catalogue); MicroLogic: tr 16 s at 6 x Ir, the dial snaps to it
                    "long_time_delay": 15 if inn in tm else 16,
                    # short-time / instantaneous: blank = each trip unit's own default
                    "trip_units": units,
                    "default_trip_unit": units[0],
                    "source": SOURCE,
                }})
    return out


# ═══════════════════════════ ComPacT NSXm ═══════════════════════════

NSXM_ICU_415 = {"E": 16, "B": 25, "F": 36, "N": 50, "H": 70}     # catalogue A-3, 380/415 V
NSXM_TMD_IN = [16, 25, 32, 40, 50, 63, 80, 100, 125, 160]
NSXM_II_FIXED_A = {16: 500, 25: 600, 32: 600, 40: 600, 50: 600, 63: 800, 80: 1000,
                   100: 1250, 125: 1250, 160: 1250}               # catalogue B-5, +/-20 %
NSXM_VIGI_IN = [25, 50, 100, 160]                                 # catalogue B-15
NSXM_VIGI_IO_A = {
    25: [10, 11, 12, 14, 16, 18, 20, 22, 25],
    50: [20, 22, 25, 28, 32, 36, 40, 45, 50],
    100: [40, 45, 50, 56, 63, 70, 80, 90, 100],
    160: [63, 70, 80, 90, 100, 115, 130, 145, 160],
}
NSXM_VIGI_II_A = {25: 375, 50: 750, 100: 1500, 160: 2000}         # fixed, +/-15 %
NSXM_VIGI_LT = {"points": [[1.5, 200], [6, 8], [7.2, 5]]}          # tr non-adjustable, 0 to -20 %


def _nsxm_tmd_id(inn):
    return f"se_nsxm_tmd_{inn}"


def _nsxm_vigi_id(inn):
    return f"se_nsxm_vigi41_{inn}"


def nsxm_profiles():
    p = {}
    base = {"maker": MAKER, "catalogue": CAT}
    for inn in NSXM_TMD_IN:
        p[_nsxm_tmd_id(inn)] = {
            **base, "label": "Schneider NSXm TM-D thermal-magnetic (long-time curve not published)", "kind": "tm",
            # no published long-time curve: the generic model, with the published pickup zone and Ii accuracy
            "curve": {"model": "generic", "tol": {
                "pickup": [1.05, 1.20], "instantaneous": {"pickup_tol": 0.20}}},
            "dials": {
                "thermal_pickup": {"steps": [_x_in(a, inn) for a in TMD_IR_A[inn]], "def": 1.0},
                "magnetic_pickup": {"fixed": True, "def": _x_in(NSXM_II_FIXED_A[inn], inn), "base": "In"},
            },
        }
    for inn in NSXM_VIGI_IN:
        hold = 0.005 if inn == 160 else 0.010
        p[_nsxm_vigi_id(inn)] = {
            **base, "label": "Schneider MicroLogic Vigi 4.1 (LS0I + earth leakage)", "kind": "electronic",
            "curve": {"model": "points", "thermal": NSXM_VIGI_LT, "tol": {
                "pickup": [1.05, 1.20],
                "long_time": {"min_factor": 0.8},
                "short_time": {"pickup_tol": 0.15, "hold_s": {"0": 0.02}, "break_s": {"0": 0.08}},
                "instantaneous": {"pickup_tol": 0.15, "hold_s": hold, "break_s": 0.050}}},
            "dials": {
                "thermal_pickup": {"steps": [_x_in(a, inn) for a in NSXM_VIGI_IO_A[inn]], "def": 1.0},
                "long_time_delay": {"fixed": True, "def": 8},
                "short_time_pickup": {"steps": ISD_DIAL, "def": 1.5},
                "short_time_delay": {"fixed": True, "def": 0},
                "instantaneous_pickup": {"fixed": True, "def": _x_in(NSXM_VIGI_II_A[inn], inn), "base": "In"},
            },
        }
    return p


def nsxm_entries():
    out = []
    for cls, icu in NSXM_ICU_415.items():
        for inn in sorted(set(NSXM_TMD_IN) | set(NSXM_VIGI_IN)):
            units = []
            if inn in NSXM_TMD_IN:
                units.append(_nsxm_tmd_id(inn))
            if inn in NSXM_VIGI_IN:
                units.append(_nsxm_vigi_id(inn))
            mag = _x_in(NSXM_II_FIXED_A[inn], inn) if inn in NSXM_TMD_IN else _x_in(NSXM_VIGI_II_A[inn], inn)
            out.append({"kind": "cbs", "data": {
                "id": f"se_nsxm_{cls.lower()}_{inn}",
                "name": f"Schneider NSXm{cls} {inn} A",
                "cb_type": "mccb", "manufacturer": MAKER, "series": "ComPacT NSXm", "model": f"NSXm{cls}",
                "trip_rating_a": inn, "frame_a": 160, "rated_voltage_kv": 0.4, "breaking_ka": icu,
                "thermal_pickup": 1.0, "magnetic_pickup": mag, "long_time_delay": 10 if inn in NSXM_TMD_IN else 8,
                "trip_units": units, "default_trip_unit": units[0], "source": SOURCE,
            }})
    return out


# ═══════════════════════ Acti9 iC60 / C120 MCBs ═══════════════════════

ACTI9_SOURCE = "Acti9_A9XPH212_CAT (Version 2.0 - May 2017)"
# Magnetic band drawn on the IEC 60898-1 tripping curves: nominal and +/- fraction
_MAG = {"B": (3.2, 4.8), "C": (6.4, 9.6), "D": (10.0, 14.0)}
# family -> curves, ratings, frame, Icn (A), Icu 380/415 V by rating band, Ics
_STD_RATINGS = [0.5, 1, 2, 3, 4, 6, 10, 13, 16, 20, 25, 32, 40, 50, 63]
ACTI9 = {
    "iC60N": dict(curves="BCD", ratings=_STD_RATINGS, frame=63, icn=6,
                  icu=lambda i: 50 if i <= 4 else 10, ics=lambda i: 100 if i <= 4 else 75),
    "iC60H": dict(curves="BCD", ratings=_STD_RATINGS, frame=63, icn=10,
                  icu=lambda i: 70 if i <= 4 else 15, ics=lambda i: 100 if i <= 4 else 50),
    "iC60L": dict(curves="BC", ratings=[r for r in _STD_RATINGS if r != 13], frame=63, icn=15,
                  icu=lambda i: 100 if i <= 4 else 25 if i <= 25 else 20 if i <= 40 else 15,
                  ics=lambda i: 100 if i <= 4 else 50),
    "C120N": dict(curves="BCD", ratings=[63, 80, 100, 125], frame=125, icn=10,
                  icu=lambda i: 10, ics=lambda i: 75),
    "C120H": dict(curves="BCD", ratings=[63, 80, 100, 125], frame=125, icn=15,
                  icu=lambda i: 15, ics=lambda i: 50),
}


def _acti9_chart(model, inn):
    return "c120" if model.startswith("C120") else ("le4" if inn <= 4 else "6_63")


def _acti9_pid(chart, curve):
    return f"se_acti9_{curve.lower()}_{chart}"


def acti9_profiles():
    data = json.load(open(os.path.join(DATA, "acti9_iec60898_curves.json")))
    p = {}
    for chart, c in data["charts"].items():
        for curve, (lo, hi) in _MAG.items():
            mid = round((lo + hi) / 2, 3)
            p[_acti9_pid(chart, curve)] = {
                "maker": MAKER, "catalogue": "Acti9 catalogue 2017",
                "label": f"Schneider Acti9 MCB, curve {curve} (IEC 60898-1)", "kind": "tm",
                "curve": {"model": "points", "thermal": {"points": c["max"]}, "tol": {
                    "pickup": [1.13, 1.45],                      # IEC 60898-1: no trip / trip within 1 h
                    "long_time": {"min_points": c["min"]},
                    "instantaneous": {"pickup_tol": math.floor((hi - lo) / (hi + lo) * 1e5) / 1e5,   # rounded DOWN: nominal x (1 + tol) never exceeds the band's top
                                      "hold_s": 0.010, "break_s": 0.010}}},   # "less than 10 ms"
                "dials": {
                    "thermal_pickup": {"fixed": True, "def": 1.0},
                    "magnetic_pickup": {"fixed": True, "def": mid, "base": "In"},
                },
            }
    return p


def acti9_entries():
    out = []
    for model, f in ACTI9.items():
        for curve in f["curves"]:
            lo, hi = _MAG[curve]
            for inn in f["ratings"]:
                icu, ics = f["icu"](inn), f["ics"](inn)
                has_icn = not (model == "iC60L" and inn > 40)
                chart = _acti9_chart(model, inn)
                num = int(inn) if float(inn).is_integer() else inn
                out.append({"kind": "cbs", "data": {
                    "id": f"se_{model.lower()}_{curve.lower()}_{str(num).replace('.', '_')}",
                    "name": f"Schneider {model} {curve}{num}",
                    "cb_type": "mcb", "mcb_curve": curve, "manufacturer": MAKER,
                    "series": "Acti9 C120" if model.startswith("C120") else "Acti9 iC60", "model": model,
                    "trip_rating_a": inn, "frame_a": f["frame"], "rated_voltage_kv": 0.4,
                    "breaking_ka": f["icn"] if has_icn else icu,
                    "icu_ka": icu, "ics_pct": ics,
                    "thermal_pickup": 1.0, "magnetic_pickup": round((lo + hi) / 2, 3), "long_time_delay": 10,
                    "trip_units": [_acti9_pid(chart, curve)], "default_trip_unit": _acti9_pid(chart, curve),
                    "source": ACTI9_SOURCE,
                }})
    return out


# ═══════════════════ Masterpact MTZ (MicroLogic X) ═══════════════════

MTZ_SOURCE = "DOCA0102EN-12; DOCA0100EN-08; DOCA0101EN-09"
MTZ = {  # frame -> (frame current, ratings In, {level: Icu 415 V kA})
    "MTZ1": (1600, [630, 800, 1000, 1250, 1600], {"H1": 42, "H2": 50, "H3": 66, "L1": 150}),
    "MTZ2": (4000, [800, 1000, 1250, 1600, 2000, 2500, 3200, 4000],
             {"N1": 42, "H1": 66, "H2": 100, "H2V": 100, "H3": 150, "L1": 150}),
    "MTZ3": (6300, [4000, 5000, 6300], {"H1": 66, "H2": 100}),
}
MTZ_TR = [0.5, 1, 2, 4, 8, 12, 16, 20, 24]
# tripping time (s) at 1.5 / 6 / 7.2 x Ir per tr setting, cold state (DOCA0102EN-12 p.107)
MTZ_LT = {
    "0.5": [[1.5, 12.5], [6, 0.5], [7.2, 0.34]], "1": [[1.5, 25], [6, 1], [7.2, 0.69]],
    "2": [[1.5, 50], [6, 2], [7.2, 1.38]], "4": [[1.5, 100], [6, 4], [7.2, 2.7]],
    "8": [[1.5, 200], [6, 8], [7.2, 5.5]], "12": [[1.5, 300], [6, 12], [7.2, 8.3]],
    "16": [[1.5, 400], [6, 16], [7.2, 11]], "20": [[1.5, 500], [6, 20], [7.2, 13.8]],
    "24": [[1.5, 600], [6, 24], [7.2, 16.6]],
}
# accuracy on tr: -20 % (tr > 2 s), -25 % (tr = 2 s), -30 % (tr < 2 s)
MTZ_LT_MIN = {str(t): (0.8 if t > 2 else 0.75 if t == 2 else 0.7) for t in MTZ_TR}


def mtz_profiles():
    base = {"maker": MAKER, "catalogue": "DOCA0102EN-12"}
    ir = {"steps": _frange(0.4, 1.0, 0.05), "def": 1.0}
    isd = {"steps": _frange(1.5, 10, 0.5), "def": 1.5}
    tr = {"steps": MTZ_TR, "def": 0.5}
    common_tol = {
        "pickup": [1.05, 1.20],                                  # I < 1.05 Ir no trip, I > 1.2 Ir trip
        "long_time": {"param": "long_time_delay", "min_factor": MTZ_LT_MIN},
        "short_time": {"pickup_tol": 0.10, "hold_s": TSD_HOLD, "break_s": TSD_BREAK},
    }
    curve = {"model": "points", "thermal": {"param": "long_time_delay", "tables": MTZ_LT}}
    return {
        "se_mtz_ml2x": {
            **base, "label": "Schneider MicroLogic 2.0 X (LS0I)", "kind": "electronic",
            "curve": {**curve, "tol": {**common_tol}},
            "dials": {
                "thermal_pickup": ir, "long_time_delay": tr, "short_time_pickup": isd,
                # 2.0 X: the instantaneous protection IS Isd without a time setting (20 ms / 80 ms)
                "short_time_delay": {"fixed": True, "def": 0},
                "instantaneous_pickup": {"fixed": True, "def": 0, "off": True, "base": "In"},
            },
        },
        "se_mtz_ml5x": {
            **base, "label": "Schneider MicroLogic 5.0 X / 6.0 X / 7.0 X (LSI)", "kind": "electronic",
            "curve": {**curve, "tol": {**common_tol,
                                       "instantaneous": {"pickup_tol": 0.10, "hold_s": 0.020, "break_s": 0.050}}},
            "dials": {
                "thermal_pickup": ir, "long_time_delay": tr, "short_time_pickup": isd,
                "short_time_delay": {"steps": [0, 0.1, 0.2, 0.3, 0.4], "def": 0},
                # 2.0-15 x In, OFF allowed; factory 2.0 x In
                "instantaneous_pickup": {"steps": [0] + _frange(2, 15, 0.5), "off": True, "def": 2, "base": "In"},
            },
        },
    }


def mtz_entries():
    out = []
    for frame, (frame_a, ratings, levels) in MTZ.items():
        for lvl, icu in levels.items():
            for inn in ratings:
                out.append({"kind": "cbs", "data": {
                    "id": f"se_{frame.lower()}_{lvl.lower()}_{inn}",
                    "name": f"Schneider {frame} {lvl} {inn} A",
                    "cb_type": "acb", "manufacturer": MAKER, "series": "Masterpact MTZ", "model": f"{frame} {lvl}",
                    "trip_rating_a": inn, "frame_a": frame_a, "rated_voltage_kv": 0.4, "breaking_ka": icu,
                    "thermal_pickup": 1.0, "magnetic_pickup": 2, "long_time_delay": 0.5,
                    "trip_units": ["se_mtz_ml5x", "se_mtz_ml2x"], "default_trip_unit": "se_mtz_ml5x",
                    "source": MTZ_SOURCE,
                    "check": "level x rating availability not verified (catalogue LVPED216026EN)",
                }})
    return out


def profiles():
    return {**nsx_profiles(), **nsxm_profiles(), **acti9_profiles(), **mtz_profiles()}


def entries():
    return nsx_entries() + nsxm_entries() + acti9_entries() + mtz_entries()


def js_profiles(p):
    body = json.dumps(p, indent=1)
    return (
        "// GENERATED by testing/vendor-libraries/build_schneider.py — do not edit by hand.\n"
        "// Schneider Electric trip-unit profiles: ComPacT NSX / NSXm (TM-D, MicroLogic 2 / 5 / 6 / 7, Vigi 4.1),\n"
        "// Acti9 iC60 / C120 MCB curves, Masterpact MTZ (MicroLogic 2.0 X / 5.0 X / 6.0 X / 7.0 X).\n"
        "// Registered into TRIP_UNITS (constants.js). `curve.thermal` is the published long-time\n"
        "// curve (copied onto the breaker as `thermal_curve`, see cbThermalCurveTime), `curve.tol` its\n"
        "// published tolerances (`trip_tol`, see cbTripBand); a dial with `base: 'In'` is a multiple of\n"
        "// the trip-unit rating, so it does not move with the Ir dial (`pickup_base`, see cbPickupRefA).\n"
        f"Object.assign(TRIP_UNITS, {body});\n"
    )


if __name__ == "__main__":
    prof = profiles()
    ents = entries()
    ids = [e["data"]["id"] for e in ents]
    assert len(ids) == len(set(ids)), "duplicate entry ids"
    for e in ents:
        for u in e["data"]["trip_units"]:
            assert u in prof, (e["data"]["id"], u)
    with open(os.path.join(HERE, "schneider_breakers.json"), "w") as f:
        json.dump({"entries": ents}, f, indent=1)
        f.write("\n")
    with open(os.path.join(ROOT, "frontend", "js", "vendor-trip-units.js"), "w") as f:
        f.write(js_profiles(prof))
    print(f"{len(ents)} entries, {len(prof)} trip-unit profiles")
