#!/usr/bin/env python3
"""Digitise the CBI L Frame (L20 / L40 AC) time-delay curves from the datasheet PDF.

Input : CBI "L Frame - Series Moulded Case Circuit Breakers" data sheet L-SERIES-DAT, MAR 2016
        (cbi-lowvoltage.co.za), page 5 "Time Delay Curves", the right-hand chart "L20 / L40 AC".
Output: data/cbi_l_curves.json (committed; build_cbi.py reads it).

The chart is vector graphics: the two curves (minimum / maximum, 30 C) are exact 2.16 pt
strokes. `pdftocairo -svg` writes them, _svgpath.py flattens them and the chart is
calibrated on its own grid: x = 100 % at 340.53 pt, 5000 % at 531.48 pt (log); y = 0.001 s
at 415.36 pt, 1000 min (60000 s) at 160.62 pt (log). The published "Time Delay Data" table
on the same page (130 / 200 / 300 / 400 / 600 / 1000 %) is checked against the curves.

    python digitize_cbi.py "LFRAME_SERIES_DAT 10102016.pdf"
"""
import json, math, os, subprocess, sys, tempfile
from _svgpath import parse

HERE = os.path.dirname(os.path.abspath(__file__))
X100, X5000 = 340.53, 531.48
Y_TOP, Y_BOT = 160.62, 415.36            # 60000 s, 0.001 s
W = (X5000 - X100) / math.log10(50)
DY = (Y_BOT - Y_TOP) / math.log10(60000 / 0.001)
CHART_X0 = 340.0                          # the AC chart is the right-hand one


def to_m_t(x, y):
    return 10 ** ((x - X100) / W), 0.001 * 10 ** ((Y_BOT - y) / DY)


def chain(segs, start_x, T):
    """Join the stroke segments end to end, from the vertical at start_x (the asymptote) down."""
    pool = [list(s) for s in segs]
    i = next(i for i, s in enumerate(pool) if abs(s[0][0] - start_x) < 0.3 and abs(s[-1][0] - start_x) < 0.3)
    v = pool.pop(i)
    top, bottom = sorted(v, key=lambda p: p[1])[0], sorted(v, key=lambda p: p[1])[-1]   # top = long times
    path = [top, bottom]
    while True:
        end = path[-1]
        for i, s in enumerate(pool):
            r = s if math.hypot(s[0][0] - end[0], s[0][1] - end[1]) < 0.6 else (
                s[::-1] if math.hypot(s[-1][0] - end[0], s[-1][1] - end[1]) < 0.6 else None)
            if r:
                pool.pop(i); path += r[1:]; break
        else:
            break
    res = []
    for m, t in (to_m_t(x, y) for x, y in path):
        if t > T:                       # the 60000 s asymptote: clipped to the engine's 10000 s cap
            if not res: res.append((m, T))
            continue
        if res and (m - res[-1][0] < 1e-4 or t >= res[-1][1] - 1e-12):
            continue
        res.append((m, t))
    return res


def main(pdf, T=10000.0):
    with tempfile.TemporaryDirectory() as d:
        svg = os.path.join(d, "p.svg")
        subprocess.run(["pdftocairo", "-svg", "-f", "5", "-l", "5", pdf, svg], check=True)
        P = parse(svg)
    segs = [pl for st, polys in P if "stroke-width:2.16" in st for pl in polys
            if min(p[0] for p in pl) >= CHART_X0]
    # the minimum curve's vertical is the left-most (105 %), the maximum's the next one (130 %)
    verts = sorted({round(s[0][0], 1) for s in segs if abs(s[0][0] - s[-1][0]) < 0.3 and abs(s[0][1] - s[-1][1]) > 20})
    assert len(verts) == 2, verts
    res = {"min": chain(segs, verts[0], T), "max": chain(segs, verts[1], T)}
    out = {k: [[round(m, 4), float(f"{t:.4g}")] for m, t in v] for k, v in res.items()}
    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    with open(os.path.join(HERE, "data", "cbi_l_curves.json"), "w") as f:
        json.dump({"source": "CBI L-SERIES-DAT MAR 2016, page 5, L20 / L40 AC, 30 C", "max": out["max"], "min": out["min"]}, f)
        f.write("\n")
    return out


def at(pts, m):
    for (m0, t0), (m1, t1) in zip(pts, pts[1:]):
        if m0 <= m <= m1:
            f = (math.log(m) - math.log(m0)) / (math.log(m1) - math.log(m0))
            return math.exp(math.log(t0) + f * (math.log(t1) - math.log(t0)))


if __name__ == "__main__":
    o = main(sys.argv[1])
    TABLE = {"min": {1.3: 225, 2: 75, 3: 14, 4: 0.2, 6: 0.005, 10: 0.0045},
             "max": {1.3: 6000, 2: 345, 3: 110, 4: 50, 6: 5, 10: 0.24}}
    for k in ("min", "max"):
        print(k, len(o[k]), o[k][0], o[k][-1])
        for m, t in TABLE[k].items():
            print(f"  {m*100:.0f} %  table {t}  chart {at(o[k], m)}")
