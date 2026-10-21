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
    python digitize_cbi_qf.py jframe "CBI_JFRAME_DATASHEET_2605001_ REVA 2026.pdf"   (the charts end at 2000 %)
"""
import json, os, re, sys
import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
TYPES = {   # type -> (source note, {curve: PDF page})
    "qf26lr": ("CBI QF26LR-SERIES-DAT REV. B April 2022, 30 C", {"1": 4, "2": 5}),
    "qf26hr": ("CBI QF26HR-SERIES-DAT REV. C April 2022, 30 C", {"1": 5, "2": 6}),
    "qf13": ("CBI QF13-SERIES-DAT REV. G June 2024, 30 C", {"1": 5, "2": 6}),
    "qf18": ("CBI QF18-SERIES-DAT REV. F August 2022, 30 C", {"1": 6, "2": 7, "9": 8}),
    # J-Series: curve "a" = 225-250 A (page 4), "b" = 12-200 A (page 5); the charts end at 2000 %
    "jframe": ("CBI J-SERIES-DAT REV.A April 2026, 30 C", {"a": 4, "b": 5}, 2000),
}

# trip-time tables printed under the charts: % of rated current -> (minimum s, maximum s). The 105 %
# column is "no trip". The sheets' minimum rows have a few misprints (curve 2: 0.001 s at 600 %,
# 0.041 s at 900 %), so only the columns that read monotonically are used for the minimum.
TABLES = {
    "a": {130: (300, 6000), 135: (264, 2860), 150: (197, 1300), 200: (100, 450), 300: (32, 150), 400: (11, 70),
          500: (2, 37), 600: (0.4, 15), 700: (0.1, 4.2), 800: (0.03, 1.7), 900: (0.01, 1.11), 1000: (0.005, 1), 2000: (0.004, 1)},
    "b": {130: (85, 1800), 135: (70, 1200), 150: (47, 500), 200: (23, 105), 300: (7.5, 35), 400: (3.4, 18),
          500: (1.6, 8.4), 600: (0.4, 5), 700: (0.09, 3.3), 800: (0.02, 1.8), 900: (0.009, 0.6), 1000: (0.005, 0.18), 2000: (0.004, 0.02)},
    "1": {130: (63, 1800), 145: (45, 503), 150: (41, 400), 200: (20, 96), 300: (7.5, 34), 400: (3.8, 17),
          500: (2.3, 10.3), 600: (1.5, 6.8), 700: (1.01, 4.9), 800: (0.7, 3.6), 900: (0.42, 2.8),
          1000: (0.1, 2.2), 2000: (0.005, 0.1)},
    "2": {130: (22, 660), 145: (15.4, 180), 150: (14, 144), 200: (6.3, 40), 300: (2.1, 12), 400: (0.85, 5.5),
          500: (0.1, 3), 600: (None, 1.92), 700: (0.006, 1.3), 800: (0.005, 0.86), 900: (None, 0.47),
          1000: (0.004, 0.1), 2000: (0.004, 0.02)},
    "9": {130: (75, 1500), 145: (50, 360), 150: (45, 295), 200: (22, 100), 300: (7.6, 38), 400: (3.6, 19),
          500: (2, 11.8), 600: (1, 7.7), 700: (0.1, 5.3), 800: (0.01, 3.6), 900: (0.008, 2.6),
          1200: (0.005, 0.06), 2000: (0.005, 0.02)},
}


def strokes(P):
    """(grid stroke, curve stroke) of a chart page: the width whose full-length lines form the grid, and
    the width of the ~20 dense paths that are the two curves."""
    grid = curve = None
    widths = {m.group(1) for st, _ in P for m in [re.search(r"stroke-width:([0-9.]+)", st)] if m}
    for w in widths:
        xs, ys = C.grid(P, w)
        if len(xs) > 5 and len(ys) > 5:
            grid = w
    n = {w: len(C.thick_paths(P, w)) for w in widths}
    cands = [w for w, c in n.items() if 15 <= c <= 30]
    curve = max(cands, key=float)
    return grid, curve


def digitise(pdf, pages, curve, xmax=5000):
    P = C.svg_paths(pdf, pages[curve])
    gs, cs = strokes(P)
    xs, ys = C.grid(P, gs)
    ax = C.Axes(xs[0], xs[-1], xmax, ys[0], ys[-1], 1e5, 1e-3)
    paths = C.thick_paths(P, cs)
    # the two curves start at the 105 % (minimum) and 130 % (maximum) asymptotes, top of the chart
    tops = sorted(((pl[0] if pl[0][1] < pl[-1][1] else pl[-1]) for pl in paths), key=lambda p: (p[1], p[0]))[:2]
    tops = sorted(tops, key=lambda p: p[0])
    return {"min": C.to_points(C.chain_from(paths, tops[0]), ax),
            "max": C.to_points(C.chain_from(paths, tops[1]), ax)}


if __name__ == "__main__":
    typ, pdf = sys.argv[1], sys.argv[2]
    note, pages, *rest = TYPES[typ]
    xmax = rest[0] if rest else 5000
    out = {"source": note, "curves": {}}
    worst = 0.0
    for c in pages:
        d = out["curves"][c] = digitise(pdf, pages, c, xmax)
        print("curve", c, {k: (len(v), v[0], v[-1]) for k, v in d.items()})
        for pct, (tmin, tmax) in TABLES[c].items():
            for k, t in (("min", tmin), ("max", tmax)):
                v = C.at(d[k], pct / 100)
                if t is None or v is None or v >= 9999:     # 130 % max: the near-vertical start, clipped
                    continue
                err = abs(v / t - 1)
                worst = max(worst, err)
                if err > 0.08:
                    print(f"  curve {c} {k} {pct} %: table {t} chart {v:.4g} ({err:.0%})")
    print(f"worst chart-vs-table error: {worst:.1%}")
    with open(os.path.join(HERE, "data", f"cbi_{typ}_curves.json"), "w") as f:
        json.dump(out, f)
        f.write("\n")
