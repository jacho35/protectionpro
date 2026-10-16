#!/usr/bin/env python3
"""Digitise the Acti9 IEC 60898-1 tripping-curve bands from the catalogue PDF.

Input : the Acti9 catalogue (Version 2.0 - May 2017, download.se.com Doc Ref
        Acti9_A9XPH212_CAT, file "A9PCM04 CATALOGO 1.pdf"), PDF page 128 = the
        two "Tripping curves" pages (206 / 207).
Output: data/acti9_iec60898_curves.json (committed; build_schneider.py reads it).

The charts are vector graphics, so the band outlines are exact paths, not a
scan: `pdftocairo -svg` writes them, _svgpath.py flattens them, and each chart
is calibrated on its own grid (the 0.425 pt decade lines and the 2..9 minor
lines of the log-log axes; the bottom edge is 0.01 s). Run:

    python digitize_acti9.py catalogue.pdf

Chart regions (pt, page 128, left page): le4 = iC60 up to 4 A, 6_63 = iC60
6-63 A, c120 = C120N/H. Which outline is the maximum / minimum boundary was
read off the rendered page; the selection indices below are that reading.
"""
import json, math, os, re, subprocess, sys, tempfile
from _svgpath import parse

HERE = os.path.dirname(os.path.abspath(__file__))
BOXES = {"le4": (60, 300, 165, 425), "6_63": (300, 540, 165, 425), "c120": (60, 300, 490, 760)}
CAL = {  # x1: x of I/In = 1, W: width of a decade, y0: y of 0.01 s, DY: decade height (pt)
    "le4": dict(x1=77.5, W=153.3, y0=414.75, DY=40.37),
    "6_63": dict(x1=332.2, W=152.1, y0=414.6, DY=40.35),
    "c120": dict(x1=77.9, W=153.2, y0=742.5, DY=40.37),
}


def outlines(P, box, cal):
    out = []
    for st, polys in P:
        if "stroke:rgb(0%,0%,0%)" not in st or "stroke-width:1.417" not in st:
            continue
        for pl in polys:
            xs = [p[0] for p in pl]; ys = [p[1] for p in pl]
            if box[0] <= min(xs) and max(xs) <= box[1] and box[2] <= min(ys) and max(ys) <= box[3]:
                out.append([(10 ** ((x - cal["x1"]) / cal["W"]),
                             0.01 * 10 ** ((cal["y0"] - y) / cal["DY"])) for x, y in pl])
    return out


def assemble(parts):
    """Ascending I, strictly falling t, vertical edges (on the 0.01 s floor) dropped."""
    pts = sorted({(x, t) for pl in parts for x, t in pl if t > 0.05})
    out = []
    for x, t in pts:
        if out and (x - out[-1][0] < 1e-3 or t >= out[-1][1]):
            continue
        out.append((x, t))
    return out


def clip(pts, T=3600.0):
    out = []
    for i, (x, t) in enumerate(pts):
        if t > T:
            if i + 1 < len(pts) and pts[i + 1][1] <= T:
                x2, t2 = pts[i + 1]
                a = (math.log(t2) - math.log(t)) / (math.log(x2) - math.log(x))
                out.append((math.exp(math.log(x) + (math.log(T) - math.log(t)) / a), T))
            continue
        out.append((x, t))
    return out


def main(pdf):
    with tempfile.TemporaryDirectory() as d:
        svg = os.path.join(d, "p.svg")
        subprocess.run(["pdftocairo", "-svg", "-f", "128", "-l", "128", pdf, svg], check=True)
        P = parse(svg)
    res = {}
    for k in BOXES:
        o = outlines(P, BOXES[k], CAL[k])
        # order of the outlines is the file's: indices read off the rendered page
        if k == "6_63":
            mx, mn = [o[0]], [o[1], o[3], o[4]]
        elif k == "le4":
            mx, mn = [o[1], o[5]], [o[0], o[2], o[4]]
        else:
            mx = [o[1], o[3][1:10], o[2][1:3]]
            mn = [o[0], [(4.803, 0.6224), (6.398, 0.3316)], [(9.599, 0.1584), (10.006, 0.1489)]]
        res[k] = dict(max=[[round(x, 3), round(t, 3)] for x, t in clip(assemble(mx))],
                      min=[[round(x, 3), round(t, 3)] for x, t in clip(assemble(mn))])
    print(json.dumps(res)[:300], "...")
    return res


if __name__ == "__main__":
    main(sys.argv[1])
