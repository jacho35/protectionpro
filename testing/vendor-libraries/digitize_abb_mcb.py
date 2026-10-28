#!/usr/bin/env python3
"""Digitise the ABB System pro M compact MCB tripping curves (S200 / S200M / S300P / S800).

Input : ABB 9AKK108468A3912 "Electrical installation solutions for buildings – Technical details,
        part B01 MCBs" (EN). The tripping-characteristic charts are vector graphics: `pdftocairo -svg`
        writes them, _svgpath.py flattens them (cbi_curves.py).
Output: data/abb_mcb_curves.json (committed; build_abb_mcb.py reads it).

    python digitize_abb_mcb.py "9AKK108468A3912_..._B01 ... MCBs _EN_ (PDF).pdf"

Charts used (PDF page, IEC/EN 60898-1, 30 C, "tripping curve from cold state"):
  12  S200 / S200M — B, C, D, up to 4 A and 6-63 A (third column = IEC 60947-2 at 55 C: not used)
  14  S200 80-100 A — B (left; right = IEC 60947-2)
  15  S200M — same layout as page 12
  17  S300P — same layout as page 12
  29  S800 — B, C, D bands (one chart per characteristic, every S800 series)

Pages 12 / 14 / 15 / 17: each chart is a minimum and a maximum curve (thick black strokes) ending in
the vertical magnetic edges, on a 1-100 x In by 0.01-10000 s log grid. Calibrated per chart on its
own frame: x = 1 at the black left axis, 100 at the right-most grey decade line; y = 10000 s at the
frame top, 0.01 s at the bottom.

Page 29: each characteristic is a filled band (one closed outline) on a 1-30 x In by 0.01-10000 s
grid. Calibrated on the frame (x = 1 at the left edge, the 10 x In dotted line = 10; y = 10000 s top,
0.01 s bottom). The chart is schematic: its x lines sit on the log scale (2, 3 ... 30 within 0.2 pt)
but its "10 s" grid line is 1.6 pt (0.075 decade) below a log position — the band is read on the
regular log scale, so read-off times carry that drawing error.
"""
import json, math, os, re, sys
import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = "ABB 9AKK108468A3912 (Electrical installation solutions for buildings, Technical details, B01 MCBs)"
# the 3 x 3 grid pages (page -> series): rows B / C / D, columns <= 4 A / 6-63 A / IEC 60947-2 (not used)
GRID = {12: "s200", 15: "s200m", 17: "s300p"}
ROWS, COLS = "BCD", ("le4", "6_63")


def _style(st, key):
    m = re.search(key + r":(rgb\([^)]*\)|[0-9.]+)", st)
    return m.group(1) if m else None


def _frames(P):
    """(x_axis, y_top, y_bottom) of each chart: the black full-height left axis line."""
    out = []
    for st, polys in P:
        c = _style(st, r"(?<!-)stroke")
        if not c or not c.startswith("rgb(0%"):
            continue
        for pl in polys:
            if len(pl) == 2 and abs(pl[0][0] - pl[1][0]) < 0.02 and abs(pl[0][1] - pl[1][1]) > 100 \
                    and float(_style(st, "stroke-width")) < 0.1:
                out.append((pl[0][0], min(pl[0][1], pl[1][1]), max(pl[0][1], pl[1][1])))
    return sorted(set((round(x, 2), round(a, 2), round(b, 2)) for x, a, b in out), key=lambda f: (f[1], f[0]))


def _grey_x(P, frame):
    x0, yt, yb = frame
    xs = []
    for st, polys in P:
        c = _style(st, r"(?<!-)stroke")
        if not c or not c.startswith("rgb(49"):
            continue
        for pl in polys:
            if len(pl) == 2 and abs(pl[0][0] - pl[1][0]) < 0.02 and abs(min(pl[0][1], pl[1][1]) - yt) < 1 \
                    and x0 < pl[0][0] < x0 + 160:
                xs.append(pl[0][0])
    return sorted(xs)


def _curves(P, frame, width):
    """The chart's thick polylines (> 2 points) and its vertical magnetic edges."""
    x0, yt, yb = frame
    curves, edges = [], []
    for st, polys in P:
        w = _style(st, "stroke-width")
        c = _style(st, r"(?<!-)stroke")
        if not w or float(w) < 0.5 or not c.startswith("rgb(0%"):
            continue
        for pl in polys:
            xs = [p[0] for p in pl]
            if not (x0 - 1 < min(xs) < x0 + width and yt - 30 < min(p[1] for p in pl) < yb):
                continue
            if len(pl) > 2:
                curves.append(pl)
            elif abs(pl[0][0] - pl[1][0]) < 0.02:
                edges.append(pl[0][0])
    return curves, sorted(edges)


def line_chart(P, frame):
    x0, yt, yb = frame
    x100 = _grey_x(P, frame)[-1]
    ax = C.Axes(x0, x100, 10000, yt, yb, 1e4, 1e-2)
    curves, edges = _curves(P, frame, x100 - x0)
    assert len(curves) == 2 and len(edges) == 2, (frame, len(curves), edges)
    mn, mx = sorted(curves, key=lambda pl: min(p[0] for p in pl))
    order = lambda pl: pl if pl[0][1] < pl[-1][1] else pl[::-1]          # top first
    lo, hi = (ax.mt(e, yb)[0] for e in edges)
    return {"min": C.to_points(order(mn), ax), "max": C.to_points(order(mx), ax),
            "magnetic_drawn": [round(lo, 3), round(hi, 3)]}


def s200_80_100(P):
    """Page 14: the left (IEC 60898-1) chart of the two."""
    return line_chart(P, min(_frames(P)))


# ── page 29: S800 bands ─────────────────────────────────────────────────────

def _split_band(poly, ax):
    """Closed band outline -> (min chain, max chain), each from the top of the chart down to the corner
    where it turns into its vertical magnetic edge (the rounded bottom of the outline is cut off)."""
    pts = [ax.mt(x, y) for x, y in poly]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    n, top = len(pts), max(t for _, t in pts)
    tops = [i for i, (m, t) in enumerate(pts) if t > top * 0.9]
    i_min, i_max = min(tops, key=lambda i: pts[i][0]), max(tops, key=lambda i: pts[i][0])
    i_bot = min(range(n), key=lambda i: pts[i][1])

    def walk(i, step):
        out = [pts[i]]
        while i != i_bot:
            i = (i + step) % n
            out.append(pts[i])
        return out
    # each chain is the way round the outline that does not pass the other chain's start
    fwd, bwd = walk(i_min, 1), walk(i_min, -1)
    low = bwd if pts[i_max] in fwd else fwd
    fwd, bwd = walk(i_max, 1), walk(i_max, -1)
    up = bwd if pts[i_min] in fwd else fwd
    cut = lambda ch: [p for p in ch[:next((k for k, p in enumerate(ch) if p[1] < 0.05), len(ch))]]
    return cut(low), cut(up)


def _mt_points(ch, T=10000.0):
    out = []
    for m, t in ch:
        if t >= T * 0.97:                                   # the top of the outline: the asymptote
            out = [(m, T)]
            continue
        if out and (m <= out[-1][0] * 1.00005 or t >= out[-1][1]):
            continue
        out.append((m, t))
    thin = C._dp([(math.log10(m), math.log10(t)) for m, t in out], 0.0015)
    return [[round(10 ** a, 4), float(f"{10 ** b:.4g}")] for a, b in thin]


def s800(P):
    bands = []
    for st, polys in P:
        f = _style(st, "fill")
        if f and f.startswith("rgb(76.86") and _style(st, "stroke-width"):
            bands += [pl for pl in polys if len(pl) > 20]
    # frame of each chart: the 0.5 dark full-height vertical (x = 1) and the full-width horizontals
    frames = []
    for st, polys in P:
        if _style(st, "stroke-width") == "0.5" and (_style(st, r"(?<!-)stroke") or "").startswith("rgb(11.37"):
            for pl in polys:
                if len(pl) == 2 and abs(pl[0][0] - pl[1][0]) < 0.02 and abs(pl[0][1] - pl[1][1]) > 100:
                    frames.append((pl[0][0], min(pl[0][1], pl[1][1]), max(pl[0][1], pl[1][1])))
    out = {}
    for band in bands:
        bx = min(p[0] for p in band); by = min(p[1] for p in band)
        x_left = max(f[0] for f in frames if bx - 10 < f[0] < bx + 0.5 and abs(f[1] - by) < 3)
        x_right = max(f[0] for f in frames if abs(f[1] - by) < 3 and x_left < f[0] < x_left + 100)
        yt = min(f[1] for f in frames if abs(f[0] - x_left) < 0.1)
        # the bottom (0.01 s): the band's own floor, which lies on the frame's bottom line
        yb = max(p[1] for p in band)
        ax = C.Axes(x_left, x_right, 3000, yt, yb, 1e4, 1e-2)               # right edge = 30 x In
        low, up = _split_band(band, ax)
        out[(round(by), round(x_left))] = {"min": _mt_points(low), "max": _mt_points(up),
                                           "magnetic_drawn": [round(low[-1][0], 3), round(up[-1][0], 3)]}
    # the first row of the page is B, C, D left to right
    first_row = sorted(k for k in out if k[0] == min(k2[0] for k2 in out))
    return {c: out[k] for c, k in zip("BCD", first_row)}


def main(pdf):
    res = {"_about": "Tripping-time bands of ABB System pro M compact MCBs, IEC/EN 60898-1 (30 C), digitised "
                     "from the vector charts of " + SOURCE + " by digitize_abb_mcb.py. Each curve is a list of "
                     "[I/In, t(s)]: `max` = the slowest trip time (upper boundary), `min` = the fastest (lower). "
                     "`magnetic_drawn` = where the drawn vertical magnetic edges stand (x In).",
           "source": SOURCE, "charts": {}}
    for page, series in GRID.items():
        P = C.svg_paths(pdf, page)
        fr = _frames(P)
        assert len(fr) == 9, (page, fr)
        rows, cols = sorted({round(f[1]) for f in fr}), sorted({round(f[0]) for f in fr})
        for f in fr:
            r, col = rows.index(round(f[1])), cols.index(round(f[0]))
            if col < 2:
                res["charts"][f"{series}_{ROWS[r].lower()}_{COLS[col]}"] = {"page": page, **line_chart(P, f)}
    res["charts"]["s200_b_80_100"] = {"page": 14, **s200_80_100(C.svg_paths(pdf, 14))}
    for c, d in s800(C.svg_paths(pdf, 29)).items():
        res["charts"][f"s800_{c.lower()}"] = {"page": 29, **d}
    path = os.path.join(HERE, "data", "abb_mcb_curves.json")
    with open(path, "w") as f:
        json.dump(res, f, indent=1)
        f.write("\n")
    for k, d in res["charts"].items():
        print(f"{k:18s} p{d['page']}  mag {d['magnetic_drawn']}  min {d['min'][0]}..{d['min'][-1]}  max {d['max'][0]}..{d['max'][-1]}")


if __name__ == "__main__":
    main(sys.argv[1])
