"""Road lighting on a plan — EN 13201-3 / SANS 10098-1 on roads of any shape.

road_lighting.py solves a straight road that repeats every spacing S. Here the
same photometric model runs on real plan geometry: each road is a centreline
of any shape (straights, arcs, a traced kerb midline, a DXF polyline) with a
cross-section swept along it, lit by luminaires at their actual plan
positions, from every road on the plan (a side road's luminaires light the
main road's junction and vice versa).

Station / offset frame. A road point is (s, y): s the distance along the
centreline, y the cross-section coordinate of road_lighting.py (0 at the
left edge of the first strip, increasing across the section). On the plan

    P(s, y) = C(s) + d(s, y) · n(s)

with C the centreline, n the RIGHT-hand unit normal (looking towards
increasing s), and d the offset from the centreline: the centreline sits
midway between the outer kerbs (first carriageway's left edge, last
carriageway's right edge), so the cross-section's first strip is on the
left of a traveller going up the chainage. A traced road gives the kerb-to-
kerb width per chainage (`kerbWidth`); the strips between the kerbs scale
to it, the strips outside keep their widths.

Calculation fields. Each segment [s0, s1] (straight, bend; the frontend
splits at tangent points and junctions) is cut into fields of at most
`fieldMaxM` (40 m). In every field the EN 13201-3 grid is laid out in
(s, y) — longitudinal points (k + ½)·D, three points per lane for
luminance, the strip grid for illuminance — and mapped onto the plan. The
luminance observer of a lane stands 60 m before the field, on that lane's
centre line, measured ALONG the road (extrapolated on the end tangent past
either end), and the r-table angle β comes from the real plan directions.
Luminaires count for illuminance within 5H and for luminance 5H back / 12H
forward, measured along the road's local direction at the point (what the
straight engine does along x). TI: eyes move through the field in steps of D
from 2.75·(H − 1.5) before the first luminaire ahead, each looking along the
local driving direction, 1° down. A segment reports its worst field.

On a straight road with luminaires at a regular spacing this reproduces
road_lighting.evaluate() exactly — the test anchor (test_road_plan.py). On a
bend the luminance criteria are outside EN 13201-3's straight-road
assumption: the results carry `bend: true` so the UI can say so.

Junctions (conflict areas) are polygons on the plan, checked on horizontal
illuminance (EN C classes / SANS 10098-2 RC classes) over a ≤ 1 m grid.

The display grids (heatmap + isolux, luminance map) cover every road at
≈ 0.5 m; a luminance display point is seen from 60 m back in its own lane.

Objects (the 3D view, optional). `obstacles` — buildings, walls, shelters,
gantries (boxes) and trees (a trunk box and an ellipsoid crown that lets
`1 − opacity` of the light through) — shade the light from a luminaire to a
road point: every illuminance and luminance figure, the segment checks, the
junctions and the display grids then include those shadows (`shadows: true`
in the answer; EN 13201-3 itself assumes an unobstructed road). `surfaces`
are vertical checks on a facade or fence line: vertical illuminance Ev on
a grid from z0 to z1, facing one side of the line a→b, against a target.
`points` are single measurement points (horizontal, or vertical facing an
azimuth).
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np

from .road_lighting import (
    C_CLASSES, LUM_FAR_H, LUM_NEAR_H, LUM_RANGE_H, M_CLASSES, OBSERVER_BACK_M, OBSERVER_EYE_M,
    P_CLASSES, SANS_A, SANS_BC, SANS_CP, SANS_FOOTWAY_M, SANS_RC, SANS_VOLUME_BANDS, TAN_MAX,
    TI_AGE, TI_RANGE_M, TI_SCREEN_DEG, TI_VIEW_DOWN_DEG, _chk, _f, _intensity_to, _long_points,
    _RTable, _trans_points, _Web, class_family, sans_family,
)

FIELD_MAX_M = 40.0          # longest calculation field inside a segment
DISPLAY_STEP_M = 0.5        # heatmap resolution along / across
DISPLAY_MAX_ALONG = 1200    # display samples per road (coarser beyond 600 m)
DISPLAY_MAX_ACROSS = 48
CONFLICT_STEP_M = 1.0
CONFLICT_MAX_POINTS = 6000
CHUNK = 4000                # points per vectorised block


# ─── Road geometry ──────────────────────────────────────────────────────

class _Road:
    """Centreline + swept cross-section of one road."""

    def __init__(self, r: dict, standard: str):
        pts = np.asarray(r.get("centreline") or [], float)
        if pts.ndim != 2 or len(pts) < 2:
            raise ValueError(f"Road '{r.get('name', '')}': the centreline needs at least two points")
        seg = np.hypot(*np.diff(pts, axis=0).T)
        keep = np.concatenate([[True], seg > 1e-6])
        pts = pts[keep]
        if len(pts) < 2:
            raise ValueError(f"Road '{r.get('name', '')}': the centreline has no length")
        self.id = r.get("id") or ""
        self.name = r.get("name") or self.id
        self.pts = pts
        self.cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        self.length = float(self.cum[-1])
        # Unit tangent per polyline segment; a point takes the tangent of the
        # segment it lies on (a vertex: the average of both, so a smooth
        # flattened arc has a continuous direction).
        d = np.diff(pts, axis=0)
        self.seg_t = d / np.hypot(d[:, 0], d[:, 1])[:, None]
        # Cross-section (same meaning as road_lighting._Design.sections)
        y = 0.0
        self.sections = []
        for i, s in enumerate(r.get("sections") or []):
            w = max(_f(s.get("width"), 0.0), 0.0)
            if w <= 0:
                continue
            typ = s.get("type") or "carriageway"
            sec = {
                "index": i, "name": s.get("name") or typ.title(), "type": typ,
                "y0": y, "y1": y + w, "width": w,
                "lanes": max(int(_f(s.get("lanes"), 2)), 1) if typ == "carriageway" else 0,
                "cls": (s.get("cls") or "").upper(),
                "surface": (s.get("surface") or "R3").upper(),
                "direction": s.get("direction") or "forward",
                "volume": min(max(int(_f(s.get("volume"), 0)), 0), 2),
            }
            sec["family"] = sans_family(sec["cls"]) if standard == "SANS" else class_family(sec["cls"])
            self.sections.append(sec)
            y += w
        if not self.sections:
            raise ValueError(f"Road '{self.name}': no cross-section")
        self.width = y
        self.has_median = any(s["type"] == "median" for s in self.sections)
        cws = [s for s in self.sections if s["type"] == "carriageway"]
        self.kl = cws[0]["y0"] if cws else 0.0
        self.kr = cws[-1]["y1"] if cws else y
        self.yc = (self.kl + self.kr) / 2.0
        kw = r.get("kerbWidth") or []
        nominal = self.kr - self.kl
        if kw and nominal > 0:
            a = np.asarray(kw, float)
            order = np.argsort(a[:, 0])
            self.kw_s, self.kw_k = a[order, 0], np.clip(a[order, 1] / nominal, 0.05, 20.0)
        else:
            self.kw_s = None

    # s → plan point / unit tangent (extrapolated along the end tangents)
    def frame(self, s):
        s = np.asarray(s, float)
        i = np.clip(np.searchsorted(self.cum, s, side="right") - 1, 0, len(self.cum) - 2)
        t = (s - self.cum[i]) / np.maximum(self.cum[i + 1] - self.cum[i], 1e-12)
        x = self.pts[i, 0] + t * (self.pts[i + 1, 0] - self.pts[i, 0])
        y = self.pts[i, 1] + t * (self.pts[i + 1, 1] - self.pts[i, 1])
        tan = self.seg_t[i].copy()
        # smooth the direction across a vertex: blend with the neighbour over ±0.5 m
        near_v = np.abs(s - self.cum[np.clip(i, 0, None)]) < 0.5
        prev = self.seg_t[np.clip(i - 1, 0, None)]
        blend = near_v & (i > 0)
        tan[blend] = tan[blend] + prev[blend]
        near_n = np.abs(self.cum[i + 1] - s) < 0.5
        nxt = self.seg_t[np.clip(i + 1, 0, len(self.seg_t) - 1)]
        blend2 = near_n & (i + 1 < len(self.seg_t))
        tan[blend2] = tan[blend2] + nxt[blend2]
        tan /= np.maximum(np.hypot(tan[:, 0], tan[:, 1]), 1e-12)[:, None]
        return x, y, tan

    def scale(self, s):
        if self.kw_s is None:
            return np.ones_like(np.asarray(s, float))
        return np.interp(s, self.kw_s, self.kw_k)

    def offset(self, s, ycs):
        """Offset from the centreline (m, + = right) of cross-section coordinate y at s."""
        s, ycs = np.broadcast_arrays(np.asarray(s, float), np.asarray(ycs, float))
        k = self.scale(s)
        inner = (ycs - self.yc) * k
        left = (self.kl - self.yc) * k + (ycs - self.kl)
        right = (self.kr - self.yc) * k + (ycs - self.kr)
        return np.where(ycs < self.kl, left, np.where(ycs > self.kr, right, inner))

    def at(self, s, ycs):
        """Plan points (x, y) and the unit tangent (direction of increasing s)."""
        s, ycs = np.broadcast_arrays(np.atleast_1d(np.asarray(s, float)), np.atleast_1d(np.asarray(ycs, float)))
        flat_s, flat_y = s.ravel(), ycs.ravel()
        x, y, tan = self.frame(np.clip(flat_s, 0.0, self.length))
        over = flat_s - np.clip(flat_s, 0.0, self.length)       # beyond an end: run on its tangent
        x = x + over * tan[:, 0]
        y = y + over * tan[:, 1]
        d = self.offset(flat_s, flat_y)
        nx, ny = tan[:, 1], -tan[:, 0]                           # right-hand normal
        px, py = x + d * nx, y + d * ny
        return px.reshape(s.shape), py.reshape(s.shape), tan[:, 0].reshape(s.shape), tan[:, 1].reshape(s.shape)

    def project(self, qx, qy):
        """Chainage and signed offset (+ right) of plan points — nearest centreline point."""
        qx = np.atleast_1d(np.asarray(qx, float)); qy = np.atleast_1d(np.asarray(qy, float))
        a = self.pts[:-1]; d = np.diff(self.pts, axis=0)
        L2 = np.maximum((d * d).sum(axis=1), 1e-12)
        s_out = np.empty(len(qx)); off = np.empty(len(qx))
        for k0 in range(0, len(qx), 512):
            px = qx[k0:k0 + 512, None]; py = qy[k0:k0 + 512, None]
            t = np.clip(((px - a[:, 0]) * d[:, 0] + (py - a[:, 1]) * d[:, 1]) / L2, 0, 1)
            cx = a[:, 0] + t * d[:, 0]; cy = a[:, 1] + t * d[:, 1]
            dist = np.hypot(px - cx, py - cy)
            j = np.argmin(dist, axis=1); rows = np.arange(len(j))
            s_out[k0:k0 + 512] = self.cum[j] + t[rows, j] * np.sqrt(L2[j])
            tx, ty = d[j, 0] / np.sqrt(L2[j]), d[j, 1] / np.sqrt(L2[j])
            off[k0:k0 + 512] = (px[:, 0] - cx[rows, j]) * ty - (py[:, 0] - cy[rows, j]) * tx
        return s_out, off


# ─── Luminaires ─────────────────────────────────────────────────────────

def _luminaires(items, webs):
    cols = {k: [] for k in ("x", "y", "h", "phi", "tilt", "web", "scale", "watts", "road")}
    ids = []
    for i, it in enumerate(items or []):
        pid = it.get("photometryId")
        if pid not in webs:
            raise ValueError(f"Luminaire {it.get('id') or i + 1}: no photometry '{pid}'")
        web = webs[pid]
        flux = max(_f(it.get("fluxPct"), 100.0), 0.0)
        lm = _f(it.get("lumens"), 0.0) or web.lumens
        w = _f(it.get("watts"), 0.0) or web.watts
        cols["x"].append(_f(it.get("x"), 0.0)); cols["y"].append(_f(it.get("y"), 0.0))
        cols["h"].append(max(_f(it.get("h"), 10.0), 0.5))
        # aim = plan azimuth (deg, CCW from +x) of the luminaire's C90 plane
        cols["phi"].append(_f(it.get("aim"), 90.0) + _f(it.get("rotate"), 0.0))
        cols["tilt"].append(_f(it.get("tilt"), 0.0))
        cols["web"].append(pid)
        cols["scale"].append((lm / web.lumens) * flux / 100.0)
        cols["watts"].append(w * flux / 100.0)
        cols["road"].append(it.get("roadId") or "")
        ids.append(it.get("id") or f"L{i + 1}")
    if not ids:
        raise ValueError("No luminaires on the plan — place poles first")
    out = {k: np.asarray(v, float) for k, v in cols.items() if k not in ("web", "road")}
    out["web"] = np.asarray(cols["web"], dtype=object)
    out["road"] = np.asarray(cols["road"], dtype=object)
    out["ids"] = ids
    return out


def _subset(lum, mask):
    return {k: (v[mask] if isinstance(v, np.ndarray) else v) for k, v in lum.items()}


def _near_box(lum, px, py, reach):
    """Luminaires within `reach` m of the bounding box of the points."""
    m = ((lum["x"] >= px.min() - reach) & (lum["x"] <= px.max() + reach) &
         (lum["y"] >= py.min() - reach) & (lum["y"] <= py.max() + reach))
    return _subset(lum, m)


# ─── Obstacles ──────────────────────────────────────────────────────────

class _Crown:
    """A tree crown: an ellipsoid (radius r across, rz up) at (cx, cy, zc)."""

    def __init__(self, cx, cy, zc, r, rz, opacity):
        self.cx, self.cy, self.zc, self.r, self.rz = cx, cy, zc, r, rz
        self.opacity = min(max(opacity, 0.0), 1.0)

    def hits(self, ax, ay, az, bx, by, bz):
        # scale z so the ellipsoid becomes a sphere, then a segment–sphere test
        k = self.r / self.rz
        px, py, pz = ax - self.cx, ay - self.cy, (az - self.zc) * k
        dx, dy, dz = bx - ax, by - ay, (bz - az) * k
        a = dx * dx + dy * dy + dz * dz
        b = 2.0 * (px * dx + py * dy + pz * dz)
        c = px * px + py * py + pz * pz - self.r * self.r
        disc = b * b - 4.0 * a * c
        with np.errstate(invalid="ignore", divide="ignore"):
            sq = np.sqrt(np.maximum(disc, 0.0))
            t0 = (-b - sq) / (2.0 * a)
            t1 = (-b + sq) / (2.0 * a)
        return (disc > 0) & (t1 > 1e-6) & (t0 < 1.0 - 1e-6)


def _obstacles(items):
    """Boxes (fully opaque) and crowns (opacity) from the request."""
    from .room_lighting import _Box
    boxes, crowns = [], []
    for o in items or []:
        if not isinstance(o, dict) or o.get("blocks", True) is False:
            continue
        if o.get("kind") == "tree":
            cx, cy = _f(o.get("cx"), math.nan), _f(o.get("cy"), math.nan)
            h = max(_f(o.get("h"), 8.0), 0.5)
            r = max(_f(o.get("crownR"), 3.0), 0.1)
            base = min(max(_f(o.get("crownBase"), h * 0.35), 0.0), h - 0.1)
            if not (math.isfinite(cx) and math.isfinite(cy)):
                continue
            crowns.append(_Crown(cx, cy, (base + h) / 2.0, r, max((h - base) / 2.0, 0.05), _f(o.get("opacity"), 0.8)))
            tw = max(_f(o.get("trunk"), 0.4), 0.05)
            b = _Box({"cx": cx, "cy": cy, "w": tw, "d": tw, "z0": 0.0, "h": base + 0.1})
            if b.ok:
                boxes.append(b)
        else:
            b = _Box(o)
            if b.ok:
                boxes.append(b)
    return boxes, crowns


def _shade(ctx, px, py, pz, lx, ly, lz):
    """Share of each luminaire's light that reaches each point [n, m] (1 = clear)."""
    boxes, crowns = getattr(ctx, "boxes", None) or [], getattr(ctx, "crowns", None) or []
    shape = np.broadcast(px, lx).shape
    f = np.ones(shape)
    if not boxes and not crowns:
        return f
    from .room_lighting import _seg_box
    ax, ay, az, bx, by, bz = (np.broadcast_to(np.asarray(a, float), shape) for a in (px, py, pz, lx, ly, lz))
    for b in boxes:
        r = abs(b.hw * b.c) + abs(b.hd * b.s), abs(b.hw * b.s) + abs(b.hd * b.c)
        cand = ((np.maximum(az, bz) > b.z0) & (np.minimum(az, bz) < b.z1)
                & (np.maximum(ax, bx) > b.cx - r[0]) & (np.minimum(ax, bx) < b.cx + r[0])
                & (np.maximum(ay, by) > b.cy - r[1]) & (np.minimum(ay, by) < b.cy + r[1]) & (f > 0))
        k = np.nonzero(cand)
        if len(k[0]):
            hit = _seg_box(b, ax[k], ay[k], az[k], bx[k], by[k], bz[k])
            f[tuple(i[hit] for i in k)] = 0.0
    for c in crowns:
        cand = ((np.maximum(ax, bx) > c.cx - c.r) & (np.minimum(ax, bx) < c.cx + c.r)
                & (np.maximum(ay, by) > c.cy - c.r) & (np.minimum(ay, by) < c.cy + c.r)
                & (np.maximum(az, bz) > c.zc - c.rz) & (f > 0))
        k = np.nonzero(cand)
        if len(k[0]):
            hit = c.hits(ax[k], ay[k], az[k], bx[k], by[k], bz[k])
            idx = tuple(i[hit] for i in k)
            f[idx] *= (1.0 - c.opacity)
    return f


# ─── Point calculations (plan geometry) ────────────────────────────────

def _illum(ctx, lum, px, py, tx, ty):
    """Maintained horizontal illuminance at plan points; luminaires within 5H
    along the local road direction (tx, ty) of each point."""
    px = np.asarray(px, float).ravel(); py = np.asarray(py, float).ravel()
    tx = np.broadcast_to(np.asarray(tx, float).ravel(), px.shape)
    ty = np.broadcast_to(np.asarray(ty, float).ravel(), px.shape)
    out = np.zeros(len(px))
    hmax = float(lum["h"].max()) if len(lum["h"]) else 10.0
    for k0 in range(0, len(px), CHUNK):
        sl = slice(k0, k0 + CHUNK)
        lm = _near_box(lum, px[sl], py[sl], LUM_RANGE_H * hmax + 1.0)
        if not len(lm["x"]):
            continue
        dx = px[sl, None] - lm["x"][None, :]
        dy = py[sl, None] - lm["y"][None, :]
        h = lm["h"][None, :]
        along = -(dx * tx[sl, None] + dy * ty[sl, None])
        near = np.abs(along) <= LUM_RANGE_H * h
        I = _intensity_to(ctx, lm, dx, dy, -np.broadcast_to(h, dx.shape))
        if getattr(ctx, "boxes", None) or getattr(ctx, "crowns", None):
            I = I * _shade(ctx, px[sl, None], py[sl, None], 0.0, lm["x"][None, :], lm["y"][None, :], h)
        d3 = (dx * dx + dy * dy + h * h) ** 1.5
        out[sl] = np.where(near, I * h / d3, 0.0).sum(axis=1)
    return out * ctx.mf


def _lumin(ctx, lum, px, py, rt, ox, oy, vx, vy):
    """Luminance at plan points, each seen from its observer (ox, oy) driving
    along (vx, vy) — the direction of travel at the point."""
    px = np.asarray(px, float).ravel(); py = np.asarray(py, float).ravel()
    shp = px.shape
    ox, oy, vx, vy = (np.broadcast_to(np.asarray(a, float).ravel(), shp) for a in (ox, oy, vx, vy))
    out = np.zeros(len(px))
    hmax = float(lum["h"].max()) if len(lum["h"]) else 10.0
    for k0 in range(0, len(px), CHUNK):
        sl = slice(k0, k0 + CHUNK)
        lm = _near_box(lum, px[sl], py[sl], LUM_FAR_H * hmax + 1.0)
        if not len(lm["x"]):
            continue
        dx = lm["x"][None, :] - px[sl, None]          # point → luminaire
        dy = lm["y"][None, :] - py[sl, None]
        h = lm["h"][None, :]
        beyond = dx * vx[sl, None] + dy * vy[sl, None]
        near = (beyond >= -LUM_NEAR_H * h) & (beyond <= LUM_FAR_H * h)
        I = _intensity_to(ctx, lm, -dx, -dy, -np.broadcast_to(h, dx.shape))
        if getattr(ctx, "boxes", None) or getattr(ctx, "crowns", None):
            I = I * _shade(ctx, px[sl, None], py[sl, None], 0.0, lm["x"][None, :], lm["y"][None, :], h)
        rho = np.hypot(dx, dy)
        tan_g = rho / h
        vox = (px[sl] - ox[sl])[:, None]; voy = (py[sl] - oy[sl])[:, None]
        dot = vox * dx + voy * dy
        cross = np.hypot(vox, voy) * rho
        beta = np.degrees(np.arccos(np.clip(dot / np.maximum(cross, 1e-12), -1, 1)))
        beta = np.where(rho < 1e-9, 0.0, beta)
        r = rt.lookup(beta, tan_g)
        out[sl] = np.where(near & (tan_g <= TAN_MAX + 1e-9), I * r / (h * h), 0.0).sum(axis=1)
    return out * ctx.mf


def _ti(ctx, lum, ex_, ey_, vx, vy, lav_init):
    """TI (%) — the worst over eyes (ex_[k], ey_[k], 1.5 m) each looking along
    (vx[k], vy[k]), 1° down."""
    if lav_init <= 0:
        return float("inf")
    ex_ = np.atleast_1d(ex_)[:, None]; ey_ = np.atleast_1d(ey_)[:, None]
    vx = np.atleast_1d(vx)[:, None]; vy = np.atleast_1d(vy)[:, None]
    ex = lum["x"][None, :] - ex_
    ey = lum["y"][None, :] - ey_
    ez = np.broadcast_to(lum["h"][None, :] - OBSERVER_EYE_M, ex.shape)
    ahead = ex * vx + ey * vy
    horiz = np.hypot(ex, ey)
    elev = np.degrees(np.arctan2(ez, horiz))
    ok = (ahead > 0) & (ahead <= TI_RANGE_M) & (elev <= TI_SCREEN_DEG)
    if not np.any(ok):
        return 0.0
    dist = np.sqrt(ex * ex + ey * ey + ez * ez)
    down = math.radians(TI_VIEW_DOWN_DEG)
    cos_t = np.clip((ahead * math.cos(down) - ez * math.sin(down)) / np.maximum(dist, 1e-12), -1, 1)
    theta = np.degrees(np.arccos(cos_t))
    ok &= (theta >= 0.1) & (theta <= 60.0)
    I = _intensity_to(ctx, lum, -ex, -ey, -ez)
    e_eye = I * cos_t / np.maximum(dist * dist, 1e-12)
    th = np.maximum(theta, 1e-9)
    wide = 9.86 * (1 + (TI_AGE / 66.4) ** 4) * e_eye / th ** 2
    close = e_eye * (10.0 / th ** 3 + 5.0 / th ** 2 * (1 + (TI_AGE / 62.5) ** 4))
    lv = float(np.max(np.sum(np.where(ok, np.where(theta >= 1.5, wide, close), 0.0), axis=1)))
    if lav_init <= 5.0:
        return 65.0 * lv / lav_init ** 0.8
    return 95.0 * lv / lav_init ** 1.05


# ─── One field of one segment ──────────────────────────────────────────

class _Field:
    def __init__(self, ctx, road: _Road, lum, s0, s1, lum_s):
        self.ctx, self.road, self.lum = ctx, road, lum
        self.s0, self.s1 = s0, s1
        L = s1 - s0
        xs, D = _long_points(L)
        self.ss, self.D = s0 + xs, D
        self.lum_s = lum_s           # (chainage, height) of this road's own luminaires

    def grid(self, ys):
        gs, gy = np.meshgrid(self.ss, ys, indexing="ij")
        px, py, tx, ty = self.road.at(gs, gy)
        return px, py, tx, ty

    def E(self, ys):
        px, py, tx, ty = self.grid(ys)
        return _illum(self.ctx, self.lum, px, py, tx, ty).reshape(px.shape)

    def observer(self, oy, sign):
        s_start = self.s0 if sign > 0 else self.s1
        ox, oyy, _, _ = self.road.at(s_start - sign * OBSERVER_BACK_M, oy)
        return float(ox[0]), float(oyy[0])

    def L(self, ys, rt, oy, sign):
        px, py, tx, ty = self.grid(ys)
        ox, oyy = self.observer(oy, sign)
        return _lumin(self.ctx, self.lum, px, py, rt, ox, oyy, sign * tx, sign * ty).reshape(px.shape)

    def TI(self, oy, sign, lav_init):
        # TI observer (EN 13201-3 §8.5): starts 2.75·(H − 1.5) before the first
        # luminaire ahead of the field and moves over it in steps of D.
        s_l, h_l = self.lum_s
        if sign > 0:
            ahead = np.where(s_l >= self.s0 - 1e-9)[0]
            k = ahead[np.argmin(s_l[ahead])] if len(ahead) else None
        else:
            ahead = np.where(s_l <= self.s1 + 1e-9)[0]
            k = ahead[np.argmax(s_l[ahead])] if len(ahead) else None
        first = s_l[k] if k is not None else (self.s0 if sign > 0 else self.s1)
        h = h_l[k] if k is not None else float(self.lum["h"].max())
        s_eye = first - sign * 2.75 * max(h - OBSERVER_EYE_M, 0.0) + sign * np.arange(len(self.ss)) * self.D
        ex, ey, tx, ty = self.road.at(s_eye, np.full(len(s_eye), oy))
        return _ti(self.ctx, self.lum, ex, ey, sign * tx, sign * ty, lav_init)


def _strip_E(f: _Field, sec):
    ys = _trans_points(sec["y0"], sec["width"])
    E = f.E(ys)
    eav = float(E.mean())
    return {"Eav": eav, "Emin": float(E.min()), "Emax": float(E.max()), "UoE": float(E.min() / eav) if eav > 0 else 0.0}


def _lane_points(sec):
    wl = sec["width"] / sec["lanes"]
    return wl, np.concatenate([sec["y0"] + k * wl + (np.arange(3) + 0.5) * wl / 3 for k in range(sec["lanes"])])


def _field_luminance_en(f: _Field, sec):
    rt = _RTable(sec["surface"])
    wl, ys = _lane_points(sec)
    sign = -1.0 if sec["direction"] == "reverse" else 1.0
    obs = []
    for k in range(sec["lanes"]):
        oy = sec["y0"] + (k + 0.5) * wl
        L = f.L(ys, rt, oy, sign)
        lav = float(L.mean())
        centre = L[:, 3 * k + 1]
        obs.append({"lane": k + 1, "Lav": lav, "Uo": float(L.min() / lav) if lav > 0 else 0.0,
                    "Ul": float(centre.min() / centre.max()) if centre.max() > 0 else 0.0,
                    "TI": f.TI(oy, sign, lav / f.ctx.mf)})
    return {"Lav": min(o["Lav"] for o in obs), "Uo": min(o["Uo"] for o in obs),
            "Ul": min(o["Ul"] for o in obs), "TI": max(o["TI"] for o in obs), "observers": obs,
            "surface": rt.name}


def _field_luminance_sans(f: _Field, road: _Road, sec):
    rt = _RTable(sec["surface"])
    wl, ys = _lane_points(sec)
    sign = -1.0 if sec["direction"] == "reverse" else 1.0
    oy_q = sec["y0"] + sec["width"] / 4 if sign > 0 else sec["y1"] - sec["width"] / 4
    Lq = f.L(ys, rt, oy_q, sign)
    lav = float(Lq.mean())
    out = {"Lav": lav, "Uo": float(Lq.min() / lav) if lav > 0 else 0.0, "TI": f.TI(oy_q, sign, lav / f.ctx.mf),
           "surface": rt.name, "observerY": oy_q}
    lanes = []
    for k in range(sec["lanes"]):
        oy = sec["y0"] + (k + 0.5) * wl
        centre = f.L(ys, rt, oy, sign)[:, 3 * k + 1]
        lanes.append({"lane": k + 1, "Ul": float(centre.min() / centre.max()) if centre.max() > 0 else 0.0})
    out["observers"] = lanes
    out["Ul"] = min(o["Ul"] for o in lanes)
    return out


def _field_edge_ratio(f: _Field, road: _Road, sec):
    w = min(5.0, sec["width"] / 2.0)
    i = road.sections.index(sec)
    sides = []
    for side in ("left", "right"):
        nb = road.sections[i - 1] if side == "left" and i > 0 else \
            (road.sections[i + 1] if side == "right" and i + 1 < len(road.sections) else None)
        if nb is not None and nb["type"] == "carriageway":
            continue
        edge = sec["y0"] if side == "left" else sec["y1"]
        y_in = _trans_points(edge if side == "left" else edge - w, w)
        y_out = _trans_points(edge - w if side == "left" else edge, w)
        e_in, e_out = float(f.E(y_in).mean()), float(f.E(y_out).mean())
        sides.append({"side": side, "Ein": e_in, "Eout": e_out, "REI": e_out / e_in if e_in > 0 else 0.0})
    if not sides:
        return None, []
    return min(s["REI"] for s in sides), sides


def _footway_reach(road, i, step):
    reach, j = 0.0, i + step
    while 0 <= j < len(road.sections) and reach < SANS_FOOTWAY_M - 1e-9:
        nb = road.sections[j]
        if nb["type"] in ("carriageway", "median"):
            break
        reach += nb["width"]
        j += step
    return min(reach, SANS_FOOTWAY_M)


def _field_strip(std, f: _Field, road: _Road, sec):
    """Every metric one strip's class needs, in one field (no pass/fail yet)."""
    m = _strip_E(f, sec)
    fam = sec["family"]
    if std == "SANS":
        if fam == "A" and sec["type"] == "carriageway":
            m.update(_field_luminance_sans(f, road, sec))
            rei, sides = _field_edge_ratio(f, road, sec)
            m["ES"] = rei
        elif fam == "B" and sec["type"] == "carriageway":
            i = road.sections.index(sec)
            y0 = sec["y0"] - _footway_reach(road, i, -1)
            y1 = sec["y1"] + _footway_reach(road, i, +1)
            if y1 - y0 > sec["width"] + 1e-9:
                E = f.E(_trans_points(y0, y1 - y0))
                m.update({"Eav": float(E.mean()), "Emin": float(E.min()), "Emax": float(E.max()),
                          "UoE": float(E.min() / E.mean()) if E.mean() > 0 else 0.0, "areaY": [y0, y1]})
    elif fam == "M" and sec["type"] == "carriageway":
        m.update(_field_luminance_en(f, sec))
        m["REI"], _ = _field_edge_ratio(f, road, sec)
    return m


def _worst(fields):
    """Merge one strip's per-field metrics: the worst of each."""
    out = dict(fields[0])
    for m in fields[1:]:
        for k, v in m.items():
            if not isinstance(v, (int, float)) or k in ("observerY",):
                continue
            if k in ("TI", "Emax"):
                out[k] = max(out.get(k, v), v)
            elif out.get(k) is None or v is None:
                out[k] = None
            else:
                out[k] = min(out[k], v)
    obs = {}
    for m in fields:
        for o in m.get("observers") or []:
            cur = obs.setdefault(o["lane"], dict(o))
            for k, v in o.items():
                if k == "lane":
                    continue
                cur[k] = max(cur[k], v) if k == "TI" else min(cur[k], v)
    if obs:
        out["observers"] = [{k: (_r(v) if isinstance(v, float) else v) for k, v in o.items()} for o in obs.values()]
    return out


def _checks(std, road, sec, m):
    fam, cls = sec["family"], sec["cls"]
    checks, note = [], None
    if std == "SANS":
        if fam == "A":
            if sec["type"] != "carriageway":
                return [], "Group A categories apply to a carriageway — this strip is not checked"
            band = "median" if road.has_median else "noMedian"
            ln, uo, ul, ti = SANS_A[cls][band][sec["volume"]]
            checks = [_chk("Lav", "L̄", m["Lav"], ln, ">=", "cd/m²"), _chk("Uo", "Uo", m["Uo"], uo, ">=", ""),
                      _chk("Ul", "Ul", m["Ul"], ul, ">=", ""), _chk("TI", "TI", m["TI"], ti, "<=", "%")]
            note = f"Night traffic {SANS_VOLUME_BANDS[band][sec['volume']]} per lane, {'with' if road.has_median else 'without'} median"
        elif fam == "B":
            req = SANS_BC[cls]
            checks = [_chk("Eav", "Ē", m["Eav"], req["Eav"], ">=", "lx"), _chk("Emin", "Emin", m["Emin"], req["Emin"], ">=", "lx")]
            note = f"Semi-cylindrical Esc,min {req['Esc']} lx (supplementary) is not calculated."
        elif fam == "RC":
            req = SANS_RC[cls]
            checks = [_chk("Eav", "Ē", m["Eav"], req["Eav"], ">=", "lx"), _chk("Uo", "Uo", m["UoE"], req["Uo"], ">=", "")]
        elif fam == "CP":
            req = SANS_CP[cls]
            checks = [_chk("Eav", "Ē", m["Eav"], req["Eav"], ">=", "lx"), _chk("Emin", "Emin", m["Emin"], req["Emin"], ">=", "lx")]
        return checks, note
    if fam == "M" and sec["type"] == "carriageway":
        req = M_CLASSES[cls]
        checks = [_chk("Lav", "L̄", m["Lav"], req["Lav"], ">=", "cd/m²"), _chk("Uo", "Uo", m["Uo"], req["Uo"], ">=", ""),
                  _chk("Ul", "Ul", m["Ul"], req["Ul"], ">=", ""), _chk("TI", "TI", m["TI"], req["TI"], "<=", "%")]
        if m.get("REI") is not None:
            checks.append(_chk("REI", "REI", m["REI"], req["REI"], ">=", ""))
    elif fam == "C":
        req = C_CLASSES[cls]
        checks = [_chk("Eav", "Ē", m["Eav"], req["Eav"], ">=", "lx"), _chk("Uo", "Uo", m["UoE"], req["Uo"], ">=", "")]
    elif fam == "P":
        req = P_CLASSES[cls]
        checks = [_chk("Eav", "Ē", m["Eav"], req["Eav"], ">=", "lx"), _chk("Emin", "Emin", m["Emin"], req["Emin"], ">=", "lx")]
        if m["Eav"] > 1.5 * req["Eav"]:
            note = f"Ē is more than 1.5 × the {cls} value — over-lit (EN 13201-2 advises ≤ 1.5 ×)"
    elif fam == "M":
        note = "M classes apply to a carriageway — this strip is not checked"
    return checks, note


def _r(v, dp=4):
    return round(float(v), dp) if isinstance(v, (int, float)) and v is not None and math.isfinite(v) else None


def evaluate_segment(ctx, road: _Road, lum, seg: dict, field_max: float, lum_s):
    s0 = max(0.0, _f(seg.get("s0"), 0.0))
    s1 = min(road.length, _f(seg.get("s1"), road.length))
    if s1 - s0 < 0.5:
        return None
    n = max(1, int(math.ceil((s1 - s0) / field_max - 1e-9)))
    edges = np.linspace(s0, s1, n + 1)
    fields = [_Field(ctx, road, lum, float(a), float(b), lum_s) for a, b in zip(edges[:-1], edges[1:])]
    strips, all_pass = [], True
    for sec in road.sections:
        ms = [_field_strip(ctx.standard, f, road, sec) for f in fields]
        m = _worst(ms)
        checks, note = _checks(ctx.standard, road, sec, m) if sec["family"] else ([], None)
        res = {"index": sec["index"], "name": sec["name"], "type": sec["type"], "cls": sec["cls"],
               "family": sec["family"], "checks": checks, "pass": (all(c["pass"] for c in checks) if checks else None)}
        for k in ("Eav", "Emin", "Emax", "UoE", "Lav", "Uo", "Ul", "TI", "REI", "ES"):
            if k in m:
                res[k] = _r(m[k])
        if m.get("observers"):
            res["observers"] = m["observers"]
        if m.get("surface"):
            res["surface"] = m["surface"]
        if note:
            res["note"] = note
        if res["pass"] is False:
            all_pass = False
        strips.append(res)
    return {"id": seg.get("id") or "", "name": seg.get("name") or "", "kind": seg.get("kind") or "",
            "radius": seg.get("radius"), "s0": round(s0, 2), "s1": round(s1, 2), "fields": n,
            "fieldLength": round((s1 - s0) / n, 2), "D": round(fields[0].D, 3),
            "bend": (seg.get("kind") == "bend"), "pass": all_pass, "strips": strips}


# ─── Conflict areas ─────────────────────────────────────────────────────

def _in_poly(px, py, poly):
    poly = np.asarray(poly, float)
    x0, y0 = poly[:, 0], poly[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    inside = np.zeros(px.shape, bool)
    for a, b, c, d in zip(x0, y0, x1, y1):
        cond = ((b > py) != (d > py)) & (px < (c - a) * (py - b) / np.where(d - b == 0, 1e-12, d - b) + a)
        inside ^= cond
    return inside


def evaluate_conflict(ctx, lum, area: dict, roads):
    polys = [p for p in (area.get("polygons") or []) if len(p) >= 3]
    if not polys:
        return None
    allp = np.concatenate([np.asarray(p, float) for p in polys])
    x0, y0 = allp.min(axis=0); x1, y1 = allp.max(axis=0)
    step = CONFLICT_STEP_M
    while ((x1 - x0) / step + 1) * ((y1 - y0) / step + 1) > CONFLICT_MAX_POINTS * 4:
        step *= 1.5
    gx, gy = np.meshgrid(np.arange(x0 + step / 2, x1, step), np.arange(y0 + step / 2, y1, step), indexing="ij")
    px, py = gx.ravel(), gy.ravel()
    inside = np.zeros(px.shape, bool)
    for p in polys:
        inside |= _in_poly(px, py, p)
    px, py = px[inside], py[inside]
    if not len(px):
        return None
    # local road direction for the 5H inclusion: the nearest road's tangent
    tx, ty = np.ones_like(px), np.zeros_like(px)
    best = np.full(px.shape, np.inf)
    for road in roads:
        s, off = road.project(px, py)
        _, _, rtx, rty = road.at(s, np.full(len(s), road.yc))
        closer = np.abs(off) < best
        tx = np.where(closer, rtx, tx); ty = np.where(closer, rty, ty)
        best = np.minimum(best, np.abs(off))
    E = _illum(ctx, lum, px, py, tx, ty)
    eav = float(E.mean())
    cls = (area.get("cls") or "").upper()
    fam = sans_family(cls) if ctx.standard == "SANS" else class_family(cls)
    m = {"Eav": eav, "Emin": float(E.min()), "Emax": float(E.max()), "UoE": float(E.min() / eav) if eav > 0 else 0.0}
    checks = []
    if fam in ("C", "RC"):
        req = (C_CLASSES if fam == "C" else SANS_RC)[cls]
        checks = [_chk("Eav", "Ē", eav, req["Eav"], ">=", "lx"), _chk("Uo", "Uo", m["UoE"], req["Uo"], ">=", "")]
    elif fam in ("P", "CP", "B"):
        req = {"P": P_CLASSES, "CP": SANS_CP, "B": SANS_BC}[fam][cls]
        checks = [_chk("Eav", "Ē", eav, req["Eav"], ">=", "lx"), _chk("Emin", "Emin", m["Emin"], req["Emin"], ">=", "lx")]
    return {"id": area.get("id") or "", "name": area.get("name") or "", "cls": cls, "family": fam,
            "points": int(len(px)), "step": round(step, 3), "area": round(len(px) * step * step, 1),
            **{k: _r(v) for k, v in m.items()},
            "checks": checks, "pass": (all(c["pass"] for c in checks) if checks else None)}


# ─── Facades and measurement points ────────────────────────────────────

def _point_E(ctx, lum, P, N):
    """Maintained illuminance at points P [n, 3] on planes with unit normals N
    [n, 3], from every luminaire, with shadows."""
    out = np.zeros(len(P))
    if not len(P):
        return out
    for k0 in range(0, len(P), CHUNK):
        p, n = P[k0:k0 + CHUNK], N[k0:k0 + CHUNK]
        dx = p[:, 0:1] - lum["x"][None, :]                 # luminaire → point
        dy = p[:, 1:2] - lum["y"][None, :]
        dz = p[:, 2:3] - lum["h"][None, :]
        d = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
        I = _intensity_to(ctx, lum, dx, dy, dz)
        I = I * _shade(ctx, p[:, 0:1], p[:, 1:2], p[:, 2:3] + 1e-3, lum["x"][None, :], lum["y"][None, :], lum["h"][None, :])
        cos = -(n[:, 0:1] * dx + n[:, 1:2] * dy + n[:, 2:3] * dz) / d
        out[k0:k0 + CHUNK] = np.where(cos > 1e-9, I * cos / (d * d), 0.0).sum(axis=1)
    return out * ctx.mf


def evaluate_surface(ctx, lum, o: dict):
    """Vertical illuminance on a facade / fence line a→b from z0 to z1, facing
    the left of a→b (or the right with side: 'right')."""
    try:
        ax, ay = float(o["a"][0]), float(o["a"][1])
        bx, by = float(o["b"][0]), float(o["b"][1])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    L = math.hypot(bx - ax, by - ay)
    z0 = max(_f(o.get("z0"), 0.0), 0.0)
    z1 = max(_f(o.get("z1"), z0 + 3.0), z0 + 0.1)
    if L < 0.1:
        return None
    ex, ey = (bx - ax) / L, (by - ay) / L
    sgn = -1.0 if o.get("side") == "right" else 1.0
    nx, ny = -ey * sgn, ex * sgn
    step = max(_f(o.get("grid"), 0.0), 0.0) or min(max(L / 30.0, 0.5), 2.0)
    nu = int(min(max(math.ceil(L / step), 1), 120))
    nv = int(min(max(math.ceil((z1 - z0) / step), 1), 20))
    U = (np.arange(nu) + 0.5) / nu * L
    V = z0 + (np.arange(nv) + 0.5) / nv * (z1 - z0)
    UU, VV = np.meshgrid(U, V)
    P = np.stack([ax + UU.ravel() * ex + nx * 0.02, ay + UU.ravel() * ey + ny * 0.02, VV.ravel()], axis=1)
    E = _point_E(ctx, lum, P, np.tile([nx, ny, 0.0], (len(P), 1)))
    ev = float(E.mean())
    target = _f(o.get("target"), 0.0)
    return {"id": o.get("id") or "", "name": o.get("name") or "Facade", "nu": nu, "nv": nv,
            "values": np.round(E, 2).tolist(), "Ev": _r(ev), "Evmin": _r(float(E.min())), "Evmax": _r(float(E.max())),
            "target": target if target > 0 else None,
            "pass": (float(E.min()) >= target - 1e-9) if target > 0 else None}


def evaluate_point(ctx, lum, o: dict):
    x, y = _f(o.get("x"), math.nan), _f(o.get("y"), math.nan)
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    z = max(_f(o.get("z"), 0.0), 0.0)
    if o.get("face") == "vertical":
        a = math.radians(_f(o.get("dir"), 0.0))
        n = [math.cos(a), math.sin(a), 0.0]
    else:
        n = [0.0, 0.0, 1.0]
    E = float(_point_E(ctx, lum, np.array([[x, y, z]]), np.array([n]))[0])
    target = _f(o.get("target"), 0.0)
    return {"id": o.get("id") or "", "name": o.get("name") or "Point", "E": _r(E), "face": o.get("face") or "up",
            "target": target if target > 0 else None, "pass": (E >= target - 1e-9) if target > 0 else None}


# ─── Display grids ──────────────────────────────────────────────────────

def display_grid(ctx, road: _Road, lum, with_luminance=True):
    n_s = int(min(DISPLAY_MAX_ALONG, max(2, math.ceil(road.length / DISPLAY_STEP_M) + 1)))
    ss = np.linspace(0.0, road.length, n_s)
    n_y = int(min(DISPLAY_MAX_ACROSS, max(5, math.ceil(road.width / DISPLAY_STEP_M) + 1)))
    ys = np.linspace(0.0, road.width, n_y)
    gs, gy = np.meshgrid(ss, ys, indexing="ij")
    px, py, tx, ty = road.at(gs, gy)
    E = _illum(ctx, lum, px, py, tx, ty).reshape(px.shape)
    out = {"roadId": road.id, "s": ss.round(2).tolist(), "yc": ys.round(3).tolist(),
           "x": px.round(2).tolist(), "y": py.round(2).tolist(), "E": E.round(2).tolist(), "L": None}
    if with_luminance:
        Lg = np.full(px.shape, np.nan)
        for sec in road.sections:
            if sec["type"] != "carriageway":
                continue
            j = np.where((ys >= sec["y0"] - 1e-9) & (ys <= sec["y1"] + 1e-9))[0]
            if not len(j):
                continue
            sign = -1.0 if sec["direction"] == "reverse" else 1.0
            wl = sec["width"] / sec["lanes"]
            lane = np.clip(((ys[j] - sec["y0"]) // wl).astype(int), 0, sec["lanes"] - 1)
            oy = sec["y0"] + (lane + 0.5) * wl                      # each point's own lane centre
            S, OY = np.meshgrid(ss, oy, indexing="ij")
            ox, oyy, _, _ = road.at(S - sign * OBSERVER_BACK_M, OY)
            sub_px, sub_py = px[:, j], py[:, j]
            vals = _lumin(ctx, lum, sub_px, sub_py, _RTable(sec["surface"]), ox, oyy,
                          sign * tx[:, j], sign * ty[:, j])
            Lg[:, j] = vals.reshape(sub_px.shape)
        out["L"] = [[None if not math.isfinite(v) else round(float(v), 3) for v in row] for row in Lg]
    return out


# ─── Entry point ────────────────────────────────────────────────────────

def run_road_plan(req: dict) -> dict:
    standard = "SANS" if str(req.get("standard") or "EN").upper().startswith("SANS") else "EN"
    webs = {k: _Web(v) for k, v in (req.get("photometry") or {}).items()}
    ctx = SimpleNamespace(webs=webs, mf=min(max(_f(req.get("mf"), 0.8), 0.05), 1.0), standard=standard)
    ctx.boxes, ctx.crowns = _obstacles(req.get("obstacles"))
    roads = [_Road(r, standard) for r in (req.get("roads") or [])]
    if not roads:
        raise ValueError("No roads on the plan")
    lum = _luminaires(req.get("luminaires"), webs)
    field_max = max(_f(req.get("fieldMaxM"), FIELD_MAX_M), 5.0)
    want_display = req.get("display", True) is not False
    out_roads = []
    hours = max(_f(req.get("hoursPerYear"), 4100.0), 0.0)
    for road, r in zip(roads, req.get("roads") or []):
        own = lum["road"] == road.id
        if own.any():
            s_l, _ = road.project(lum["x"][own], lum["y"][own])
            lum_s = (s_l, lum["h"][own])
        else:
            lum_s = (np.zeros(0), np.zeros(0))
        segs = r.get("segments") or [{"id": "all", "name": road.name, "s0": 0.0, "s1": road.length, "kind": "straight"}]
        results = [x for x in (evaluate_segment(ctx, road, lum, s, field_max, lum_s) for s in segs) if x]
        watts = float(lum["watts"][own].sum()) if own.any() else 0.0
        entry = {"id": road.id, "name": road.name, "length": round(road.length, 2),
                 "segments": results, "pass": all(s["pass"] for s in results) if results else None,
                 "energy": {"luminaires": int(own.sum()), "watts": round(watts, 1),
                            "wPerKm": round(watts * 1000.0 / road.length, 1) if road.length > 0 else None,
                            "kWhPerYear": round(watts * hours / 1000.0, 1)}}
        if want_display:
            entry["display"] = display_grid(ctx, road, lum, with_luminance=req.get("luminanceDisplay", True) is not False)
        out_roads.append(entry)
    conflicts = [x for x in (evaluate_conflict(ctx, lum, a, roads) for a in (req.get("conflictAreas") or [])) if x]
    ok = [r["pass"] for r in out_roads if r["pass"] is not None] + [c["pass"] for c in conflicts if c["pass"] is not None]
    surfaces = [x for x in (evaluate_surface(ctx, lum, o) for o in (req.get("surfaces") or []) if isinstance(o, dict)) if x]
    points = [x for x in (evaluate_point(ctx, lum, o) for o in (req.get("points") or []) if isinstance(o, dict)) if x]
    return {"standard": standard, "mf": ctx.mf, "roads": out_roads, "conflictAreas": conflicts,
            "surfaces": surfaces, "points": points, "shadows": bool(ctx.boxes or ctx.crowns),
            "pass": all(ok) if ok else None, "fieldMaxM": field_max}
