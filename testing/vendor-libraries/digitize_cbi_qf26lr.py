#!/usr/bin/env python3
"""Digitise the CBI QF(26)LR time-delay curves 1 and 2 from the data sheet PDF.

Input : CBI "QF(26)LR - Series Miniature Circuit Breakers" data sheet QF26LR-SERIES-DAT, REV. B,
        April 2022 (cbi-lowvoltage.co.za): page 4 = curve 1, page 5 = curve 2 (each: minimum +
        maximum, 30 C). Curves 3 and 9 are ordered (instantaneous 3-5 / 7-12 x In) but their
        charts are not in the data sheet.
Output: data/cbi_qf26lr_curves.json (committed; build_cbi_qf26lr.py reads it).

Calibration (pt, from each page's grid lines): x = 100 % at the left-most vertical line, 5000 %
at the right-most; y = 100000 s at the top horizontal line, 0.001 s at the bottom one.
Curve 1's page also prints a trip-time table (105 ... 2000 %); it is checked against the chart.

    python digitize_cbi_qf26lr.py "CBI_QF(26)LR_SERIES_DAT_6PAGES_1.52MB_0.pdf"
"""
import json, os, sys
import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = {"1": (4, "0.376", "0.939"), "2": (5, "0.374", "0.936")}      # page, grid stroke, curve stroke

# curve 1 table: % of rated current -> (minimum s, maximum s); the 105 % column is "no trip"
TABLE1 = {130: (63, 1800), 145: (45, 503), 150: (41, 400), 200: (20, 96), 300: (7.5, 34), 400: (3.8, 17),
          500: (2.3, 10.3), 600: (1.5, 6.8), 700: (1.01, 4.9), 800: (0.7, 3.6), 900: (0.42, 2.8),
          1000: (0.1, 2.2), 2000: (0.005, 0.1)}


def digitise(pdf, curve):
    page, gs, cs = PAGES[curve]
    P = C.svg_paths(pdf, page)
    xs, ys = C.grid(P, gs)
    ax = C.Axes(xs[0], xs[-1], 5000, ys[0], ys[-1], 1e5, 1e-3)
    paths = C.thick_paths(P, cs)
    starts = sorted((min(p[0] for p in pl), pl) for pl in paths)
    # the two curves start at the 105 % (minimum) and 130 % (maximum) asymptotes, top of the chart
    tops = sorted(((pl[0] if pl[0][1] < pl[-1][1] else pl[-1]) for pl in paths), key=lambda p: (p[1], p[0]))[:2]
    tops = sorted(tops, key=lambda p: p[0])
    return {"min": C.to_points(C.chain_from(paths, tops[0]), ax),
            "max": C.to_points(C.chain_from(paths, tops[1]), ax)}


if __name__ == "__main__":
    out = {"source": "CBI QF26LR-SERIES-DAT REV. B April 2022, 30 C", "curves": {}}
    for c in PAGES:
        out["curves"][c] = digitise(sys.argv[1], c)
        print("curve", c, {k: (len(v), v[0], v[-1]) for k, v in out["curves"][c].items()})
    with open(os.path.join(HERE, "data", "cbi_qf26lr_curves.json"), "w") as f:
        json.dump(out, f)
        f.write("\n")
    c1 = out["curves"]["1"]
    for pct, (tmin, tmax) in TABLE1.items():
        print(f"  {pct:5d} %  min table {tmin:7} chart {C.at(c1['min'], pct / 100) or float('nan'):9.4g}   "
              f"max table {tmax:7} chart {C.at(c1['max'], pct / 100) or float('nan'):9.4g}")
