"""Digitise the operating-characteristic charts of the CBI MCCB catalogue (thermal-magnetic "D" types).

The catalogue page is a vector drawing, but the curves are split across many small strokes of several
widths, so the curves are traced from a high-resolution raster instead; the axes are calibrated from the
vector grid lines (exact positions, in pt):
  x: % of rated current / 100 (log), left edge = 1; y: operating time (log), top = 4 h, bottom = 0.01 s.
Every horizontal grid line must land on one of the labelled times and every vertical one on a labelled
current, which pins the scale of each chart (checked, not assumed).
"""
import math, os, re, subprocess, tempfile
import numpy as np
from PIL import Image
from scipy import ndimage as nd
import cbi_curves as C

Image.MAX_IMAGE_PIXELS = None
DPI = 600
# the labelled times on the vertical axis (s) and currents (x In) on the horizontal one
T_LABELS = [14400, 7200, 3600, 1800, 1200, 840, 600, 360, 240, 120, 60, 30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]
X_LABELS = [1, 1.05, 1.13, 1.25, 1.3, 1.45, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100]


def grid_lines(P, stroke="0.481", min_len=60, min_v=100):
    vs, hs = [], []
    for st, polys in P:
        if f"stroke-width:{stroke}" not in st:
            continue
        for pl in polys:
            if len(pl) != 2:
                continue
            (x0, y0), (x1, y1) = pl
            if abs(x0 - x1) < 0.02 and abs(y0 - y1) > min_v:
                vs.append((round(x0, 2), min(y0, y1), max(y0, y1)))
            elif abs(y0 - y1) < 0.02 and abs(x0 - x1) > min_len:
                hs.append((round(y0, 2), min(x0, x1), max(x0, x1)))
    return vs, hs


def charts(P):
    """Chart frames on a page: [(x_left, x_right, y_top, y_bottom)]. The x extent is that of the long horizontal grid
    lines the frame is made of (top and bottom lines with the same extent); the y extent is that of the tall vertical
    grid lines inside it (a legend box can hide the top frame line)."""
    from collections import defaultdict
    vs, hs = grid_lines(P, min_v=60)
    g = defaultdict(list)
    for y, x0, x1 in hs:
        if x1 - x0 > 60:
            g[(round(x0), round(x1))].append((y, x0, x1))
    res = []
    for k, rows in sorted(g.items()):
        if max(r[0] for r in rows) - min(r[0] for r in rows) <= 80:
            continue
        x0, x1 = rows[0][1], rows[0][2]
        inside = [v for v in vs if x0 - 1 <= v[0] <= x1 + 1]
        if len(inside) < 5:
            continue
        tall = max(v[2] - v[1] for v in inside)
        if tall < 90:
            continue
        top = [v for v in inside if v[2] - v[1] >= 0.9 * tall]
        res.append((x0, x1, min(v[1] for v in top), max(v[2] for v in top)))
    return res


def calibrate(P, frame):
    """x: left frame = 1 x In; the decade width is the one for which the most vertical grid lines land on a labelled
    current (brute force, then least squares on those); y: top frame = 4 h, bottom frame = 0.01 s (the labelled
    lines in between agree within a few %)."""
    x0, x1, y0, y1 = frame
    vs, hs = grid_lines(P, min_v=0.85 * (y1 - y0))
    xs = sorted({v[0] for v in vs if x0 + 1 < v[0] < x1 - 1})
    err = lambda x, W: min(abs(math.log10(10 ** ((x - x0) / W) / l)) for l in X_LABELS)
    best = None
    for W in np.arange(50.0, 120.0, 0.02):
        e = [err(x, W) for x in xs]
        k = (sum(1 for v in e if v < 0.005), -sum(e))
        if best is None or k > best[0]:
            best = (k, W)
    W = best[1]
    for _ in range(4):                                   # least squares on the lines that sit on a label
        ok = [(x, min(X_LABELS, key=lambda l: abs(math.log10(10 ** ((x - x0) / W) / l)))) for x in xs if err(x, W) < 0.01]
        ok = [(x, l) for x, l in ok if l > 1]
        if len(ok) >= 2:
            W = sum((x - x0) * math.log10(l) for x, l in ok) / sum(math.log10(l) ** 2 for x, l in ok)
    hit = sum(1 for x in xs if err(x, W) < 0.006)
    H = (y1 - y0) / math.log10(14400 / 0.01)
    return dict(left=x0, W=W, hit=hit, nx=len(xs), top=y0, H=H, right_x=10 ** ((x1 - x0) / W))


def render(pdf, page, box):
    """Raster of a chart box (pt) at DPI -> grayscale array, plus the pixel origin."""
    x0, x1, y0, y1 = box
    s = DPI / 72.0
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "c")
        subprocess.run(["pdftocairo", "-png", "-r", str(DPI), "-f", str(page), "-l", str(page), "-singlefile",
                        "-x", str(int(x0 * s)), "-y", str(int(y0 * s)), "-W", str(int((x1 - x0) * s) + 1),
                        "-H", str(int((y1 - y0) * s) + 1), pdf, out], check=True)
        return np.array(Image.open(out + ".png").convert("L")), (int(x0 * s), int(y0 * s))


def curves_in(pdf, page, P, ch, thick_pt=1.0, min_len_pt=15, k=None):
    """The solid thick curves of a chart as lists of (x In, s), left-most top start first."""
    cal = calibrate(P, ch)
    gx0, gx1, y0, y1 = ch
    pad = 2
    img, (ox, oy) = render(pdf, page, (gx0 - pad, gx1 + pad, y0 - pad, y1 + pad))
    s = DPI / 72.0
    dark = img < 110
    k = k or max(3, int(thick_pt * s * 0.55) | 1)
    core = nd.binary_opening(dark, structure=np.ones((k, k)))       # strokes at least `thick_pt` wide survive
    lab, n = nd.label(core, structure=np.ones((3, 3)))
    out = []
    gy0 = y0
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        if (xs.max() - xs.min() + ys.max() - ys.min()) < min_len_pt * s:
            continue
        # centre-line: row centres where the stroke is steep, column centres where it is shallow
        pts = []
        for y in range(ys.min(), ys.max() + 1):
            r = xs[ys == y]
            if len(r) and r.max() - r.min() < 2.2 * k:
                pts.append((r.mean(), y))
        for x in range(xs.min(), xs.max() + 1):
            c = ys[xs == x]
            if len(c) and c.max() - c.min() < 2.2 * k:
                pts.append((x, c.mean()))
        pts.sort(key=lambda p: p[0] + p[1])
        if len(pts) > 200:                                   # arrowheads touching a stroke: a running median removes them
            a = np.array(pts)
            w = 81
            for c in (0, 1):
                a[:, c] = nd.median_filter(a[:, c], size=w, mode="nearest")
            pts = [tuple(p) for p in a]
        if not pts:
            continue
        px = [(ox + a) / s for a, b in pts]; py = [(oy + b) / s for a, b in pts]
        out.append(list(zip(px, py)))
    # a curve split by an arrow or a leader line: join a component that starts where another ended (not at the top)
    top_y = gy0 + 3
    comps = sorted(out, key=lambda c: c[0][0])
    merged = []
    for c in comps:
        for m in merged:
            ex, ey = m[-1]
            if c[0][1] > top_y and math.hypot(c[0][0] - ex, c[0][1] - ey) < 12 and c[0][0] >= ex - 0.5 and c[0][1] >= ey - 0.5:
                m.extend(c); break
        else:
            merged.append(list(c))
    res = []
    for c in merged:
        m = [10 ** ((x - cal["left"]) / cal["W"]) for x, y in c]
        t = [14400 * 10 ** (-(y - cal["top"]) / cal["H"]) for x, y in c]
        res.append((c[0][0], list(zip(m, t))))
    out = res
    out.sort(key=lambda c: (c[1][0][1] < 0, c[0]))
    return cal, out


def overlay(pdf, page, P, frame, curves, path):
    """Debug picture: the chart raster with the traced curves drawn over it (red = first, blue = second, ...)."""
    from PIL import ImageDraw
    cal = calibrate(P, frame)
    x0, x1, y0, y1 = frame
    img, (ox, oy) = render(pdf, page, (x0 - 2, x1 + 2, y0 - 2, y1 + 2))
    im = Image.fromarray(img).convert("RGB")
    d = ImageDraw.Draw(im)
    s = DPI / 72.0
    cols = ["red", "blue", "green", "orange", "purple"]
    for k, (_, pts) in enumerate(curves):
        xy = [((x0 - 2 + 0) * s - ox + (cal["left"] + cal["W"] * math.log10(m) - (x0 - 2)) * s,
               (y0 - 2) * 0 + (cal["top"] + cal["H"] * math.log10(14400 / t)) * s - oy) for m, t in pts]
        xy = [(cal["left"] * s - ox + cal["W"] * math.log10(m) * s, cal["top"] * s - oy + cal["H"] * math.log10(14400 / t) * s) for m, t in pts]
        d.line(xy, fill=cols[k % 5], width=3)
    im = im.resize((im.size[0] // 3, im.size[1] // 3))
    im.save(path)


def chain_mono(segs, start, tol=0.7, gap=2.2):
    """Follow vector pieces from `start` always right and down (a trip curve is monotone), skipping the leader lines
    of the "Max." / "Min." labels, which leave the curve upwards or to the left. The drawing has tiny gaps between
    pieces: when nothing joins within `tol`, pieces starting within `gap` are taken."""
    d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
    pool = [list(p) for p in segs]
    used = [False] * len(pool)
    path = [start]
    while True:
        end = path[-1]
        best = None
        for reach in (tol, gap):
            for i, s in enumerate(pool):
                if used[i]:
                    continue
                for r in (s, s[::-1]):
                    if d(r[0], end) < reach:
                        dx, dy = r[-1][0] - r[0][0], r[-1][1] - r[0][1]
                        if dx >= -0.15 and dy >= -0.15 and (dx > 0.05 or dy > 0.05):
                            score = math.hypot(dx, dy)                  # prefer the longer continuation (the curve over a stub)
                            if best is None or score > best[0]:
                                best = (score, i, r)
            if best:
                break
        if best is None:
            return path
        used[best[1]] = True
        for j, s in enumerate(pool):                      # an identical duplicate piece is not another branch
            if not used[j] and len(s) == len(pool[best[1]]) and d(s[0], pool[best[1]][0]) < 0.05 and d(s[-1], pool[best[1]][-1]) < 0.05:
                used[j] = True
        path.extend(best[2][1:])


def curves_vec(P, frame, stroke, tol=0.7):
    """The two solid thick curves of a chart, chained from the vector pieces of one stroke width: [(x In, s)] — the one
    that starts left-most at the top (minimum), then the next (maximum)."""
    cal = calibrate(P, frame)
    x0, x1, y0, y1 = frame
    segs = []
    for st, polys in P:
        if f"stroke-width:{stroke}" not in st or "dash" in st:
            continue
        for pl in polys:
            xs = [p[0] for p in pl]; ys = [p[1] for p in pl]
            if x0 - 1 <= min(xs) and max(xs) <= x1 + 1 and y0 - 1 <= min(ys) and max(ys) <= y1 + 1 and len(pl) >= 2:
                segs.append(pl)
    # the curves start on the top frame line: the two left-most distinct x of the piece ends there
    tops = sorted({round(p[0], 1) for s in segs for p in (s[0], s[-1]) if p[1] < y0 + 2})
    cl = []
    for x in tops:
        if not cl or x - cl[-1] > 1.5:
            cl.append(x)
    tops = [(x, min(p[1] for s in segs for p in (s[0], s[-1]) if abs(p[0] - x) < 1.5 and p[1] < y0 + 2)) for x in cl]
    out = []
    for st in tops[:2]:
        path = chain_mono(segs, st, tol)
        out.append([(10 ** ((x - cal["left"]) / cal["W"]), 14400 * 10 ** (-(y - cal["top"]) / cal["H"])) for x, y in path])
    return out
