#!/usr/bin/env python3
"""Digitise the ABB SACE Tmax XT thermal-magnetic trip curves.

Inputs (vector PDFs, no bitmaps):
  1SDC210033D0704  SACE Tmax XT technical catalogue, IEC, Spanish edition (2017) — chapter 4 "Curvas de actuación
                   con relés termomagnéticos", pages 4/4 and 4/5 (PDF pages 100-101): XT1 160 TMD In=16...63 A,
                   XT1 160 TMD In=80...160 A, XT2 160 TMD/TMA In=1.6...160 A, XT3 250 TMD In=63...250 A,
                   XT4 250 TMA In=16...250 A. x = multiples of I1, t = s; the band (red + blue fill) is the whole
                   tolerance band, so its bottom edge is the minimum curve and its top edge the maximum.
  9AKK108468A0163  ABB US time-current curve "Tmax XT5 with TMA trip unit, 500/600 A" (April 2023)
  9AKK108468A0227  ABB US time-current curve "Tmax XT6 with TMA trip unit, 600/800 A"
                   x = multiples of In, t = s (0.01-1000 s), cold trip, 40 C; two grey bands, I1 = 0.7 x In with
                   I3 at its minimum and I1 = 1 x In with I3 at its maximum. The I1 = 1 x In band is used (its x is
                   then x I1); its bottom edge is the minimum total commit time, its top the maximum total clearing
                   time.
The 2024 catalogue (1SDC210100D0206) has no trip curves; ABB's IEC curves for XT5 / XT6 TMA could not be found.

Output: data/abb_xt_curves.json — per chart: {"min": [[x I1, s], ...], "max": [...], "break_s": s, "hold_s": s?,
        "mag": [lo, hi] (US sheets: the I3-maximum band, x In), "source": ...}

    python digitize_abb_xt.py 1SDC210033D0704.pdf "XT5 TMA 500-600A.pdf" "XT6 TMA 600-800A.pdf"
"""
import json
import os
import sys

import cbi_curves as C

HERE = os.path.dirname(os.path.abspath(__file__))
RED = "fill:rgb(88.627625%,0%,10.195923%)"
BLUE = "fill:rgb(0%,39.607239%,63.922119%)"
GREY = "fill:rgb(82.351685%,82.351685%,82.351685%)"
GRID_US = "stroke:rgb(75.292969%,75.292969%,75.292969%)"


def _scan(edges, X, Y, n=1500):
    """Vertical scan of a filled band: per x, the top (largest t) and bottom (smallest t) edge -> two (x, t) lists."""
    xs = [q[0] for e in edges for q in e]
    lo, hi = min(xs), max(xs)
    top, bot = [], []
    for k in range(1, n):
        x = lo + (hi - lo) * k / n
        ys = [a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]) for a, b in edges if (a[0] - x) * (b[0] - x) < 0]
        if len(ys) < 2:
            continue
        top.append((X(x), Y(min(ys))))
        bot.append((X(x), Y(max(ys))))
    return bot, top, X(hi)


# ── IEC catalogue charts: frame 0.1-100 x I1 by 0.01-10 000 s ──

def iec_frames(P):
    """Chart frames (x_left, x_right, y_top, y_bottom) from the 0.374 pt frame lines, top to bottom, left to right."""
    H, V = set(), set()
    for st, polys in P:
        if "stroke-width:0.374" not in st or "stroke:rgb(0%,0%,0%)" not in st:
            continue
        for p in polys:
            for a, b in zip(p, p[1:]):
                if abs(a[1] - b[1]) < 0.05 and abs(a[0] - b[0]) > 150:
                    H.add(round(a[1], 2))
                if abs(a[0] - b[0]) < 0.05 and abs(a[1] - b[1]) > 150:
                    V.add((round(a[0], 2), round(min(a[1], b[1]), 1)))
    out = set()
    for top in sorted(H):
        bots = [h for h in H if 200 < h - top < 215]
        if not bots:
            continue
        xs = sorted(x for x, y0 in V if abs(y0 - top) < 3)
        for i in range(len(xs) - 1):
            if 200 < xs[i + 1] - xs[i] < 230:
                out.add((xs[i], xs[i + 1], top, bots[0]))
    return sorted(out, key=lambda f: (f[2], f[0]))


def iec_chart(P, fr):
    xl, xr, yt, yb = fr
    X = lambda x: 10 ** (-1 + 3 * (x - xl) / (xr - xl))
    Y = lambda y: 10 ** (4 - 6 * (y - yt) / (yb - yt))
    edges = []
    for st, polys in P:
        if not ((RED in st or BLUE in st) and "stroke:none" in st):
            continue
        for p in polys:
            cx, cy = sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p)
            if xl <= cx <= xr and yt <= cy <= yb:
                edges += list(zip(p, p[1:]))
    bot, top, end = _scan(edges, X, Y)
    # the band's right-hand end is where the chart stops drawing it (I3, or the end of the thermal zone): cut
    cut = lambda pts: [q for q in pts if q[0] < end * 0.99]
    mn, mx = C.thin_mt(cut(bot)), C.thin_mt(cut(top))
    # the top of the band runs along the frame (10 000 s) until the maximum curve leaves it
    k = next(i for i, q in enumerate(mx) if q[1] < 9000)
    mx = [[mx[k - 1][0], 10000.0]] + mx[k:]
    # instantaneous: the horizontal break-time line at the bottom of the chart
    brk = None
    for st, polys in P:
        if "stroke-width:0.7" not in st:
            continue
        for p in polys:
            for a, b in zip(p, p[1:]):
                if abs(a[1] - b[1]) < 0.05 and abs(a[0] - b[0]) > 20 and xl - 1 <= a[0] <= xr + 1 and yb - 30 < a[1] < yb:
                    brk = a[1] if brk is None else max(brk, a[1])
    return {"min": mn, "max": mx, "end": round(end, 3), "break_s": float(f"{Y(brk):.3g}")}


# ── ABB US sheets: 0.5-10 000 x In by 0.01-1000 s ──

def us_chart(pdf):
    P = C.svg_paths(pdf, 1)
    V = sorted({round(a[0], 2) for st, ps in P if GRID_US in st and "fill:none" in st for p in ps
                for a, b in zip(p, p[1:]) if abs(a[0] - b[0]) < 0.05 and abs(a[1] - b[1]) > 300})
    H = sorted({round(a[1], 2) for st, ps in P if GRID_US in st and "fill:none" in st for p in ps
                for a, b in zip(p, p[1:]) if abs(a[1] - b[1]) < 0.05 and abs(a[0] - b[0]) > 300})
    x1, x10 = V[5], V[14]                 # grid lines 0.5 .. 0.9 (5), then 1 .. 9 (9): the 6th is 1, the 15th 10
    y1000, y100 = H[0], H[9]              # 1000, 900 .. 200 (9), then 100
    X = lambda x: 10 ** ((x - x1) / (x10 - x1))
    Y = lambda y: 10 ** (3 - (y - y1000) / (y100 - y1000))
    bands = []
    for st, ps in P:
        if GREY in st:
            bands.append(_scan([e for p in ps for e in zip(p, p[1:])], X, Y, n=3000))
    # the band whose thermal edge starts furthest right is I1 = 1 x In (the other is I1 = 0.7 x In)
    bot, top, _ = max(bands, key=lambda b: b[0][0][0])
    bot, top = C.thin_mt(bot, T=1000), C.thin_mt(top, T=1000)

    def split(pts):
        """Thermal part (up to the vertical drop into the magnetic zone) and the x of the drop."""
        for i in range(1, len(pts)):
            if pts[i][1] < pts[i - 1][1] / 20:
                return pts[:i], pts[i - 1][0]
        raise ValueError("no magnetic drop")
    mn, mag_lo = split(bot)
    mx, mag_hi = split(top)
    # the top of the band runs along the chart's 1000 s edge until the maximum curve leaves it
    k = next(i for i, q in enumerate(mx) if q[1] < 0.97 * mx[0][1])
    mx = [[mx[k - 1][0], mx[0][1]]] + mx[k:]
    # maximum total clearing time just above the magnetic band (the US curve steps down from there to ~0.02 s
    # at very high currents) and the minimum total commit time (the chart's floor)
    after = top[top.index(mx[-1]) + 1:] if mx[-1] in top else []
    return {"min": mn, "max": mx, "mag": [round(mag_lo, 3), round(mag_hi, 3)],
            "break_s": after[0][1] if after else None, "hold_s": bot[-1][1]}


def main(es, xt5, xt6):
    out = {}
    names = {100: ["xt1_16_63", "xt1_80_160", "xt2", "xt3"], 101: ["xt4"]}
    for pg, keys in names.items():
        P = C.svg_paths(es, pg)
        frs = iec_frames(P)
        assert len(frs) == len(keys), (pg, frs)
        for key, fr in zip(keys, frs):
            out[key] = {**iec_chart(P, fr), "source": f"1SDC210033D0704 p.4/{pg - 96}"}
    out["xt5"] = {**us_chart(xt5), "source": "9AKK108468A0163 (XT5 TMA 500/600 A)"}
    out["xt6"] = {**us_chart(xt6), "source": "9AKK108468A0227 (XT6 TMA 600/800 A)"}
    for k, v in out.items():
        print(k, "min", v["min"][0], v["min"][-1], "max", v["max"][0], v["max"][-1], "break", v["break_s"], v.get("mag"))
    with open(os.path.join(HERE, "data", "abb_xt_curves.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:4])
