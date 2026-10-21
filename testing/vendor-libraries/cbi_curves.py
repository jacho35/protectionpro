"""Shared helpers for the CBI data-sheet curve digitisers (digitize_cbi*.py).

The data sheets' time-delay charts are vector graphics: pdftocairo -svg writes the minimum /
maximum curves as thick strokes, _svgpath.py flattens them, and the chart is calibrated on its
own grid lines (the left-most / right-most vertical grid line = the x-axis ends, the top /
bottom horizontal ones = the y-axis ends).
"""
import math, os, subprocess, tempfile
from _svgpath import parse


def svg_paths(pdf, page):
    with tempfile.TemporaryDirectory() as d:
        svg = os.path.join(d, "p.svg")
        subprocess.run(["pdftocairo", "-svg", "-f", str(page), "-l", str(page), pdf, svg], check=True)
        return parse(svg)


def grid(P, stroke, min_len=150):
    """x / y positions of the chart's full-length grid lines (those of stroke-width `stroke`)."""
    xs, ys = set(), set()
    for st, polys in P:
        if f"stroke-width:{stroke}" not in st:
            continue
        for pl in polys:
            if len(pl) != 2:
                continue
            (x0, y0), (x1, y1) = pl
            if abs(x0 - x1) < 0.02 and abs(y0 - y1) > min_len:
                xs.add(round(x0, 2))
            if abs(y0 - y1) < 0.02 and abs(x0 - x1) > min_len:
                ys.add(round(y0, 2))
    return sorted(xs), sorted(ys)


class Axes:
    """x: 100 % at x_lo ... x_hi_pct at x_hi; y: t_top at y_top ... t_bot at y_bot (both log)."""
    def __init__(self, x_lo, x_hi, x_hi_pct, y_top, y_bot, t_top, t_bot):
        self.x_lo, self.W = x_lo, (x_hi - x_lo) / math.log10(x_hi_pct / 100)
        self.y_bot, self.t_bot = y_bot, t_bot
        self.DY = (y_bot - y_top) / math.log10(t_top / t_bot)

    def mt(self, x, y):
        """(multiple of In, seconds)"""
        return 10 ** ((x - self.x_lo) / self.W), self.t_bot * 10 ** ((self.y_bot - y) / self.DY)


def thick_paths(P, stroke, x0=0):
    return [pl for st, polys in P if f"stroke-width:{stroke}" in st for pl in polys
            if len(pl) > 2 and min(p[0] for p in pl) >= x0]


def chain_from(paths, start_pt, tol=0.8):
    """Concatenate paths end to end beginning with the one that has `start_pt` as an end."""
    pool = [list(p) for p in paths]
    d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
    i = min(range(len(pool)), key=lambda i: min(d(pool[i][0], start_pt), d(pool[i][-1], start_pt)))
    cur = pool.pop(i)
    if d(cur[-1], start_pt) < d(cur[0], start_pt):
        cur = cur[::-1]
    path = cur
    while True:
        end = path[-1]
        for i, s in enumerate(pool):
            if d(s[0], end) < tol:
                path += pool.pop(i)[1:]; break
            if d(s[-1], end) < tol:
                path += pool.pop(i)[::-1][1:]; break
        else:
            return path


def _dp(pts, eps):
    """Douglas-Peucker on (log m, log t) — keeps every corner of the published curve."""
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy) or 1e-12
    k, dmax = 0, -1
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / n
        if d > dmax:
            k, dmax = i, d
    if dmax <= eps:
        return [pts[0], pts[-1]]
    return _dp(pts[:k + 1], eps)[:-1] + _dp(pts[k:], eps)


def to_points(path, ax, T=10000.0, eps=0.0015):
    """Chart path -> [[x In, s], ...]: strictly rising x, falling t, clipped to T (the engine's cap)."""
    raw = [ax.mt(x, y) for x, y in path]
    pts = []
    for m, t in raw:
        if t > T:                                    # the asymptote above the cap
            if not pts: pts.append((m, T))
            continue
        if pts and (m <= pts[-1][0] * 1.00005 or t >= pts[-1][1]):
            continue
        pts.append((m, t))
    thin = _dp([(math.log10(m), math.log10(t)) for m, t in pts], eps)
    return [[round(10 ** a, 4), float(f"{10 ** b:.4g}")] for a, b in thin]


def at(pts, m):
    for (m0, t0), (m1, t1) in zip(pts, pts[1:]):
        if m0 <= m <= m1:
            f = (math.log(m) - math.log(m0)) / (math.log(m1) - math.log(m0))
            return math.exp(math.log(t0) + f * (math.log(t1) - math.log(t0)))


def flat_from(pts, tol=1.02):
    """First multiple of In at which a curve is within `tol` of its final (instantaneous) time."""
    floor = pts[-1][1]
    return next(m for m, t in pts if t <= floor * tol)


def tm_profile(maker, label, catalogue, mx, mn):
    """Fixed thermal-magnetic trip unit from a published maximum / minimum curve (x In, s).

    The long-time curve the engines clear on is the maximum; the minimum is the TCC band.
    The instantaneous band is where the two curves reach their flat times, so the engines
    (which hold the element's break time above the band) read the published curve everywhere.
    """
    lo, hi = flat_from(mn), flat_from(mx)
    tol = math.floor((hi - lo) / (hi + lo) * 1e5) / 1e5      # rounded DOWN: nominal x (1 + tol) never passes the band's top
    return {
        "maker": maker, "catalogue": catalogue, "label": label, "kind": "tm",
        "curve": {"model": "points", "thermal": {"points": mx}, "tol": {
            "pickup": [round(mn[0][0], 3), round(mx[0][0], 3)],                  # no trip below / trip above (x In)
            "long_time": {"min_points": mn},
            "instantaneous": {"pickup_tol": tol, "hold_s": mn[-1][1], "break_s": mx[-1][1]}}},
        "dials": {
            "thermal_pickup": {"fixed": True, "def": 1.0},
            "magnetic_pickup": {"fixed": True, "def": round((lo + hi) / 2, 3), "base": "In"},
        },
    }


def thin_mt(pts, T=10000.0, eps=0.0015):
    """(x In, s) traced points -> strictly rising x / falling t polyline, clipped to T, with near-vertical drops kept
    (a vertical run is collapsed to its top and its bottom, the bottom 0.3 % to the right) and thinned on
    (log x, log t) with Douglas-Peucker."""
    out, low = [], None                                   # `low`: the lowest t of the vertical run being collapsed
    for m, t in pts:
        if t > T:
            if not out:
                out.append((m, T))
            continue
        if out and m <= out[-1][0] * 1.003:               # still on a vertical stroke
            low = t if low is None else min(low, t)
            continue
        if low is not None and low < out[-1][1] * 0.98:
            out.append((out[-1][0] * 1.003, low))
        low = None
        if out and t >= out[-1][1] * 0.9995:
            continue
        out.append((m, t))
    if low is not None and low < out[-1][1] * 0.98:
        out.append((out[-1][0] * 1.003, low))
    thin = _dp([(math.log10(m), math.log10(t)) for m, t in out], eps)
    return [[round(10 ** a, 4), float(f"{10 ** b:.4g}")] for a, b in thin]
