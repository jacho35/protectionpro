#!/usr/bin/env python3
"""Digitise the time-delay curves of a CBI QF-series miniature breaker data sheet.

Input : the type's data sheet PDF (cbi-lowvoltage.co.za). Each curve page is a log-log chart of
        the minimum and maximum curves (30 C) drawn as vector strokes: `pdftocairo -svg` writes
        them, _svgpath.py flattens them (cbi_curves.py).
Output: data/cbi_<type>_curves.json (committed; build_cbi_<type>.py reads it).

Calibration (pt, from each page's grid lines): x = 100 % at the left-most vertical line, 5000 %
at the right-most; y = 100000 s at the top horizontal line, 0.001 s at the bottom one.
The trip-time table printed under curve 1 (105 ... 2000 %) is checked against the chart.

    python digitize_cbi_qf.py qf26lr "CBI_QF(26)LR_SERIES_DAT_6PAGES_1.52MB_0.pdf"
    python digitize_cbi_qf.py qf26hr "CBI_QF(26)HR_SERIES_DAT_7PAGES_1.29MB_0.pdf"
"""
import json, os, sys
import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
TYPES = {   # type -> (source note, {curve: (page, grid stroke, curve stroke)})
    "qf26lr": ("CBI QF26LR-SERIES-DAT REV. B April 2022, 30 C", {"1": (4, "0.376", "0.939"), "2": (5, "0.374", "0.936")}),
    "qf26hr": ("CBI QF26HR-SERIES-DAT REV. C April 2022, 30 C", {"1": (5, "0.376", "0.939"), "2": (6, "0.374", "0.936")}),
}

# curve 1 table: % of rated current -> (minimum s, maximum s); the 105 % column is "no trip"
TABLE1 = {130: (63, 1800), 145: (45, 503), 150: (41, 400), 200: (20, 96), 300: (7.5, 34), 400: (3.8, 17),
          500: (2.3, 10.3), 600: (1.5, 6.8), 700: (1.01, 4.9), 800: (0.7, 3.6), 900: (0.42, 2.8),
          1000: (0.1, 2.2), 2000: (0.005, 0.1)}


def digitise(pdf, pages, curve):
    page, gs, cs = pages[curve]
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
    typ, pdf = sys.argv[1], sys.argv[2]
    note, pages = TYPES[typ]
    out = {"source": note, "curves": {}}
    for c in pages:
        out["curves"][c] = digitise(pdf, pages, c)
        print("curve", c, {k: (len(v), v[0], v[-1]) for k, v in out["curves"][c].items()})
    with open(os.path.join(HERE, "data", f"cbi_{typ}_curves.json"), "w") as f:
        json.dump(out, f)
        f.write("\n")
    c1 = out["curves"]["1"]
    for pct, (tmin, tmax) in TABLE1.items():
        print(f"  {pct:5d} %  min table {tmin:7} chart {C.at(c1['min'], pct / 100) or float('nan'):9.4g}   "
              f"max table {tmax:7} chart {C.at(c1['max'], pct / 100) or float('nan'):9.4g}")
