"""Sports floodlight aiming: standard patterns and the optimiser.

Field-local metres throughout (origin a corner of the playing area, x along the
length L, y across the width W); masts sit anywhere, usually outside.

Patterns — where a mast's floods point, and the zone each flood keeps to while
the optimiser evens the light out:

  • near     each mast lights the part of the pitch nearest to it (its cell of
             the masts' Voronoi diagram). Short throws, steep beams, least glare.
  • scatter  every mast's floods spread over the whole pitch, interleaved with
             the other masts' floods: each point is lit from many directions.
  • cross    each mast lights the half of the pitch on the far side of the centre
             (across from a side mast, the far end from an end mast, the far
             diagonal from a corner mast). Long throws, light on faces from
             several sides; more glare. Far points beyond the tilt limit are
             left out of the zone.
  • band     masts at the same place along the length share a strip across the
             whole width, from their own touchline to the far one; the strips
             split the length halfway between the mast positions.

A pattern spreads its floods evenly over the zone (k-means on a fine sample
grid of the zone, seeded by farthest-point sampling) and, where masts share a
zone, deals the points out in turn so each mast's floods interleave. A mast
with no pattern ("custom") is free to move anywhere on the pitch.

The optimiser (`aim`):
  1. the centroid shift of the original optimiser — weight the grid by
     (Ēh / E)², move every aim point by the difference between its footprint's
     weighted and plain centroids — clamped to each flood's zone;
  2. a local search: every flood in turn tries eight moves of a step that halves
     when nothing improves, keeping a move that lowers the cost.
  The cost is the relative shortfall against each target given (Ēh, U₂, U₁,
  GR, Ēv and U₂ towards each camera) times four, plus soft terms that keep
  improving U₂ and U₁, keep light on the pitch and keep GR down once the
  targets are met. Every flood is one column of light per grid point, camera
  plane and glare line of sight, so a move recalculates one flood only.
  3. optionally trims: `dim` scales every flood's output so the lowest
     illuminance ratio to its target is 1.02 (uniformities do not change);
     `remove` first drops floods one at a time — the one whose loss costs least,
     never a mast's last — while every target is still met at full output,
     with a short re-aim after each, then dims.

The figures are this field's own floods only, on the calculation's own grid,
observers and camera planes (sports_lighting.evaluate_field), so they agree
with a full calculation of the field without other lighting.
"""

from __future__ import annotations

import math
import time

import numpy as np

from .area_lighting import _Lums, EYE_H
from .road_lighting import _Web
from .room_lighting import _f

PATTERNS = {
    "near": "Near — each mast lights its own zone",
    "scatter": "Scattered — every mast over the whole pitch",
    "cross": "Opposite — each mast lights the far side",
    "band": "Banded — strips across the width",
}


def grid_step(length: float) -> float:
    """EN 12464-2 maximum grid size for a dimension d: p = 0.2·5^log10(d)."""
    return 0.2 * 5.0 ** math.log10(max(length, 1.0))


def aim_angles(mx, my, h, ax, ay):
    """Heading (`rotate`) and tilt that put a flood's beam axis on (ax, ay) at
    ground level from a mast at (mx, my) of height h — the _Lums frame: the
    front is (-sin r, cos r), tilt from the downward vertical towards it."""
    dx, dy = ax - mx, ay - my
    return math.degrees(math.atan2(-dx, dy)), math.degrees(math.atan2(math.hypot(dx, dy), max(h, 0.5)))


# ─── Zones and patterns ─────────────────────────────────────────────────

class _Samples:
    """A fine grid of points over the pitch, for zones and spreading."""

    def __init__(self, L, W):
        ds = max(min(L, W) / 60.0, 0.25)
        nx, ny = max(int(math.ceil(L / ds)), 4), max(int(math.ceil(W / ds)), 4)
        while nx * ny > 12000:
            ds *= 1.2
            nx, ny = max(int(math.ceil(L / ds)), 4), max(int(math.ceil(W / ds)), 4)
        X, Y = np.meshgrid((np.arange(nx) + 0.5) * L / nx, (np.arange(ny) + 0.5) * W / ny)
        self.L, self.W, self.nx, self.ny = L, W, nx, ny
        self.ds = max(L / nx, W / ny)
        self.xy = np.stack([X.ravel(), Y.ravel()], axis=1)


def _clusters(xs, tol):
    """Indices grouped by nearly equal value: [[i, …], …] in increasing order."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = []
    for i in order:
        if out and xs[i] - xs[out[-1][-1]] <= tol:
            out[-1].append(i)
        else:
            out.append([i])
    return out


def _bands(mx, L):
    """Strip [x0, x1] for each mast: masts within 5 % of the length of each other
    share one; strips split halfway between their mean positions."""
    groups = _clusters(list(mx), 0.05 * L)
    cen = [float(np.mean([mx[i] for i in g])) for g in groups]
    out, gid = [None] * len(mx), [0] * len(mx)
    for k, g in enumerate(groups):
        x0 = 0.0 if k == 0 else (cen[k - 1] + cen[k]) / 2.0
        x1 = L if k == len(groups) - 1 else (cen[k] + cen[k + 1]) / 2.0
        for i in g:
            out[i], gid[i] = (min(max(x0, 0.0), L), min(max(x1, 0.0), L)), k
    return out, gid


def zone_masks(S: _Samples, masts, patterns, max_tilt):
    """Per mast: a boolean mask over the samples (its zone ∩ its reach), or None
    for a custom mast (free). Also warnings."""
    xy = S.xy
    mx = np.array([m["x"] for m in masts], float)
    my = np.array([m["y"] for m in masts], float)
    reach = np.array([m["h"] for m in masts], float) * math.tan(math.radians(max_tilt - 2.0))
    d = np.hypot(xy[:, 0:1] - mx[None, :], xy[:, 1:2] - my[None, :])        # [s, masts]
    near = np.argmin(d, axis=1)
    bands, _ = _bands(mx, S.L)
    rel = np.stack([(xy[:, 0] - S.L / 2) / S.L, (xy[:, 1] - S.W / 2) / S.W], axis=1)
    masks, notes = [], {}                                 # note → [mast names]
    name = lambda i: str(masts[i].get("name") or masts[i].get("id"))
    for i, p in enumerate(patterns):
        can = d[:, i] <= reach[i]
        if p == "near":
            z = near == i
        elif p == "scatter":
            z = np.ones(len(xy), bool)
        elif p == "cross":
            dm = np.array([(mx[i] - S.L / 2) / S.L, (my[i] - S.W / 2) / S.W])
            n = float(np.hypot(*dm))
            if n < 1e-6:
                z = np.ones(len(xy), bool)
            else:
                dot = rel @ (dm / n)
                z = dot <= 0.0
                if not (z & can).any() and can.any():
                    # nothing of the far half within reach: the farthest quarter it can reach
                    cut = np.quantile(dot[can], 0.25)
                    z = dot <= cut
                    notes.setdefault("the far side is beyond the tilt limit — aimed as far across as the limit allows", []).append(name(i))
                elif z.any() and (z & can).sum() < 0.9 * z.sum():
                    pct = 10 * round(10.0 * (1.0 - (z & can).sum() / z.sum()))
                    notes.setdefault(f"about {pct:.0f} % of the far side is beyond the tilt limit and left out of the zone", []).append(name(i))
        elif p == "band":
            x0, x1 = bands[i]
            z = (xy[:, 0] >= x0 - 1e-9) & (xy[:, 0] <= x1 + 1e-9)
        else:
            masks.append(None)
            continue
        zc = z & can
        if not zc.any():
            zc = can if can.any() else z
            if p != "cross":
                notes.setdefault("the zone is beyond the tilt limit", []).append(name(i))
        masks.append(zc)
    return masks, [f"{', '.join(v)}: {k}" for k, v in notes.items()]


def _spread(pts, k, start):
    """k points spread evenly over the sample points `pts` [s, 2]: farthest-point
    seeds from the sample nearest `start`, then Lloyd iterations (k-means)."""
    if k <= 0 or not len(pts):
        return np.zeros((0, 2))
    if len(pts) <= k:
        return np.array([pts[i % len(pts)] for i in range(k)], float)
    first = int(np.argmin(np.hypot(pts[:, 0] - start[0], pts[:, 1] - start[1])))
    seeds = [first]
    dmin = np.hypot(pts[:, 0] - pts[first, 0], pts[:, 1] - pts[first, 1])
    for _ in range(k - 1):
        j = int(np.argmax(dmin))
        seeds.append(j)
        dmin = np.minimum(dmin, np.hypot(pts[:, 0] - pts[j, 0], pts[:, 1] - pts[j, 1]))
    c = pts[seeds].astype(float)
    for _ in range(25):
        lab = np.argmin((pts[:, 0:1] - c[None, :, 0]) ** 2 + (pts[:, 1:2] - c[None, :, 1]) ** 2, axis=1)
        nc = c.copy()
        for j in range(k):
            sel = lab == j
            if sel.any():
                nc[j] = pts[sel].mean(axis=0)
        if np.allclose(nc, c, atol=1e-6):
            break
        c = nc
    # each centroid onto its nearest sample, so it is inside the zone
    j = np.argmin((pts[:, 0:1] - c[None, :, 0]) ** 2 + (pts[:, 1:2] - c[None, :, 1]) ** 2, axis=0)
    return pts[j].astype(float)


def _deal(points, members, counts, masts, reach):
    """Deal `points` to the masts `members` in turn (counts[i] each): each mast
    takes the point it can reach farthest from the ones it already has (the
    first: the one nearest it), so the masts' floods interleave."""
    left = list(range(len(points)))
    got = {i: [] for i in members}
    while left and any(len(got[i]) < counts[i] for i in members):
        for i in members:
            if len(got[i]) >= counts[i] or not left:
                continue
            M = np.array([masts[i]["x"], masts[i]["y"]])
            P = points[left]
            dm = np.hypot(P[:, 0] - M[0], P[:, 1] - M[1])
            ok = dm <= reach[i] + 1e-9
            if got[i]:
                H = points[got[i]]
                score = np.min(np.hypot(P[:, 0:1] - H[None, :, 0], P[:, 1:2] - H[None, :, 1]), axis=1)
            else:
                score = -dm
            score = np.where(ok, score, -1e9 - dm)
            k = int(np.argmax(score))
            got[i].append(left.pop(k))
    return {i: [points[j] for j in got[i]] for i in members}


def pattern_aims(L, W, masts, pattern, apply, max_tilt, patterns=None):
    """Aim points for the floods of the masts in `apply` (indices) under `pattern`.
    masts: [{x, y, h, n (floods), name}]. Returns ({mast index: [(ax, ay)…]}, warnings)."""
    S = _Samples(L, W)
    pats = list(patterns) if patterns else [None] * len(masts)
    for i in apply:
        pats[i] = pattern
    masks, warns = zone_masks(S, masts, pats, max_tilt)
    reach = [m["h"] * math.tan(math.radians(max_tilt - 2.0)) for m in masts]
    counts = {i: int(masts[i]["n"]) for i in range(len(masts))}
    groups = []
    if pattern == "scatter":
        groups = [list(apply)]
    elif pattern == "band":
        _, gid = _bands([m["x"] for m in masts], L)
        by = {}
        for i in apply:
            by.setdefault(gid[i], []).append(i)
        groups = list(by.values())
    else:
        groups = [[i] for i in apply]
    out = {}
    for g in groups:
        g = [i for i in g if counts[i] > 0]
        if not g:
            continue
        mk = np.zeros(len(S.xy), bool)
        for i in g:
            if masks[i] is not None:
                mk |= masks[i]
        pts = S.xy[mk] if mk.any() else S.xy
        start = (float(np.mean([masts[i]["x"] for i in g])), float(np.mean([masts[i]["y"] for i in g])))
        P = _spread(pts, sum(counts[i] for i in g), start)
        dealt = _deal(P, g, counts, masts, reach)
        for i, ps in dealt.items():
            # a point left over that this mast cannot reach: onto the nearest sample of its own zone
            z = S.xy[masks[i]] if masks[i] is not None and masks[i].any() else None
            if z is not None:
                ps = [p if np.min(np.hypot(z[:, 0] - p[0], z[:, 1] - p[1])) <= S.ds
                      else z[int(np.argmin(np.hypot(z[:, 0] - p[0], z[:, 1] - p[1])))] for p in ps]
            out[i] = ps
    return {i: [(float(a), float(b)) for a, b in v] for i, v in out.items()}, warns


# ─── The light model: one column per flood ──────────────────────────────

class _Model:
    """Light from each flood, as columns: horizontal E on the field grid, vertical
    E towards each camera at evHeight, and each flood's share of the veiling
    luminance at the 15 CIE 112 observers × 8 directions."""

    def __init__(self, fd, webs):
        L, W = fd["L"], fd["W"]
        self.L, self.W, self.webs = L, W, webs
        self.mf = fd["mf"]
        self.rho = fd["rho"]
        asked = fd["gridStep"]
        step = float(np.clip(asked, 0.5, 20.0)) if asked > 0 else grid_step(L)
        nx, ny = max(int(math.ceil(L / step - 1e-9)), 2), max(int(math.ceil(W / step - 1e-9)), 2)
        while nx * ny > 6000:
            step *= 1.25
            nx, ny = max(int(math.ceil(L / step)), 2), max(int(math.ceil(W / step)), 2)
        LX, LY = np.meshgrid((np.arange(nx) + 0.5) * L / nx, (np.arange(ny) + 0.5) * W / ny)
        self.nx, self.ny = nx, ny
        self.G = np.stack([LX.ravel(), LY.ravel(), np.zeros(nx * ny)], axis=1)
        zh = fd["evHeight"]
        self.P = self.G.copy()
        self.P[:, 2] = zh
        self.cams = []
        for c in fd["cameras"]:
            nrm = np.stack([c["x"] - self.P[:, 0], c["y"] - self.P[:, 1]], axis=1)
            nrm /= np.maximum(np.hypot(nrm[:, 0], nrm[:, 1]), 1e-9)[:, None]
            self.cams.append({"name": c["name"], "n": nrm})
        self.obs = np.array([(fx * L, fy * W) for fy in (0.0, 0.5, 1.0) for fx in (0.0, 0.25, 0.5, 0.75, 1.0)])
        a = np.radians(np.arange(8) * 45.0)
        self.dirs = np.stack([np.cos(a), np.sin(a)], axis=1)
        self.tg = fd["targets"]

    def columns(self, items):
        """(eh [n, k], [cam [n, k]…], glare [15·8, k], watts [k]) for luminaire items."""
        lums = _Lums(items, self.webs)
        # horizontal
        dx = self.G[:, 0:1] - lums.x[None, :]
        dy = self.G[:, 1:2] - lums.y[None, :]
        dz = self.G[:, 2:3] - lums.z[None, :]
        d = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
        I = lums.intensity(dx, dy, dz)
        cz = -dz / d
        eh = np.where(cz > 1e-9, I * cz / (d * d), 0.0) * self.mf
        cams = []
        if self.cams:
            dz2 = self.P[:, 2:3] - lums.z[None, :]
            d2 = np.maximum(np.sqrt(dx * dx + dy * dy + dz2 * dz2), 1e-6)
            I2 = lums.intensity(dx, dy, dz2)
            for c in self.cams:
                cp = -(c["n"][:, 0:1] * dx + c["n"][:, 1:2] * dy) / d2
                cams.append(np.where(cp > 1e-9, I2 * cp / (d2 * d2), 0.0) * self.mf)
        # glare: the luminaire as seen from each observer's eye
        ox = lums.x[None, :] - self.obs[:, 0:1]
        oy = lums.y[None, :] - self.obs[:, 1:2]
        oz = lums.z[None, :] - EYE_H + np.zeros_like(ox)
        dist = np.maximum(np.sqrt(ox * ox + oy * oy + oz * oz), 1e-6)
        Ie = lums.intensity(-ox, -oy, -oz) * self.mf                          # [15, k]
        rows = []
        for vx, vy in self.dirs:
            cos_t = (ox * vx + oy * vy) / dist
            th = np.degrees(np.arccos(np.clip(cos_t, -1, 1)))
            use = (cos_t > 0.0) & (th <= 60.0)
            rows.append(np.where(use, 10.0 * Ie * np.clip(cos_t, 0, 1) / (dist * dist) / np.maximum(th, 1.5) ** 2, 0.0))
        gl = np.stack(rows, axis=1).reshape(len(self.obs) * len(self.dirs), -1)   # observer-major
        return eh, cams, gl, lums.watts

    @staticmethod
    def _pmean(x, p):
        """Power mean of positive values: p → −∞ is the minimum, p → +∞ the maximum."""
        x = np.maximum(x, 1e-9)
        s = x.max() if p > 0 else x.min()
        return float(s * np.mean((x / s) ** p) ** (1.0 / p))

    def metrics(self, E, cams, gl, smooth=False):
        """Ēh, Emin, Emax, U₁, U₂, GR and each camera's Ēv / U₂. `smooth` puts power
        means (p = ∓10) in place of the minimum and maximum, for the optimiser:
        every dark spot then counts, not only the darkest."""
        avg = float(E.mean()) if len(E) else 0.0
        if smooth and avg > 0:
            mn, mx = self._pmean(E, -10.0), self._pmean(E, 10.0)
        else:
            mn, mx = float(E.min()), float(E.max())
        m = {"Eav": avg, "Emin": mn, "Emax": mx, "U1": mn / mx if mx > 0 else 0.0, "U2": mn / avg if avg > 0 else 0.0}
        lve = max(0.035 * self.rho * avg / math.pi, 1e-4)
        pos = gl[gl > 0]
        top = (self._pmean(pos, 10.0) if smooth else pos.max()) if len(pos) else 0.0
        m["GR"] = float(27.0 + 24.0 * np.log10(top / lve ** 0.9)) if len(pos) and avg > 0 else None
        m["cams"] = []
        for c, Ec in zip(self.cams, cams):
            ca = float(Ec.mean())
            cm = (self._pmean(Ec, -10.0) if smooth and ca > 0 else float(Ec.min()))
            m["cams"].append({"name": c["name"], "Eav": ca, "U2": cm / ca if ca > 0 else 0.0})
        return m

    def shortfall(self, m):
        """Σ relative shortfall against the targets given (0 = every one met)."""
        t, pen = self.tg, 0.0
        if t.get("em"):
            pen += max(0.0, 1.0 - m["Eav"] / t["em"])
        if t.get("u2"):
            pen += max(0.0, (t["u2"] - m["U2"]) / t["u2"])
        if t.get("u1"):
            pen += max(0.0, (t["u1"] - m["U1"]) / t["u1"])
        if t.get("gr") and m["GR"] is not None:
            pen += max(0.0, (m["GR"] - t["gr"]) / t["gr"])
        for c in m["cams"]:
            if t.get("evCam"):
                pen += max(0.0, 1.0 - c["Eav"] / t["evCam"])
            if t.get("evCamU2"):
                pen += max(0.0, (t["evCamU2"] - c["U2"]) / t["evCamU2"])
        return pen

    def cost(self, E, cams, gl, e_ref):
        """What the optimiser lowers, on the smooth figures."""
        t, m = self.tg, self.metrics(E, cams, gl, smooth=True)
        c = 4.0 * self.shortfall(m) + (1.0 - m["U2"]) + 0.5 * (1.0 - m["U1"]) - 0.3 * m["Eav"] / max(e_ref, 1e-9)
        if t.get("gr") and m["GR"] is not None:
            c += 0.2 * m["GR"] / t["gr"]
        for cm in m["cams"]:
            c -= 0.15 * (cm["Eav"] / max(e_ref, 1e-9) + cm["U2"])
        return c


# ─── The optimiser ──────────────────────────────────────────────────────

def _field(req):
    fd = req.get("field") or {}
    L, W = _f(fd.get("length"), 0.0), _f(fd.get("width"), 0.0)
    if not (L > 0.5 and W > 0.5):
        raise ValueError("The field needs a length and a width")
    tg = fd.get("targets") or {}
    targets = {k: _f(tg.get(k), 0.0) for k in ("em", "u1", "u2", "gr", "evCam", "evCamU2")}
    targets = {k: v for k, v in targets.items() if v > 0}
    cams = []
    for c in (fd.get("cameras") or []):
        x, y = _f(c.get("x"), math.nan), _f(c.get("y"), math.nan)
        if math.isfinite(x) and math.isfinite(y):
            cams.append({"name": c.get("name") or "Camera", "x": x, "y": y})
    return {
        "L": L, "W": W, "mf": min(max(_f(fd.get("mf"), 0.8), 0.05), 1.0),
        "maxTilt": min(max(_f(fd.get("maxTilt"), 70.0), 10.0), 89.0),
        "gridStep": max(_f(fd.get("gridStep"), 0.0), 0.0),
        "rho": min(max(_f(fd.get("groundRho"), 0.2), 0.01), 0.9),
        "evHeight": min(max(_f(fd.get("evHeight"), 1.5), 0.0), 10.0),
        "targets": targets, "cameras": cams,
    }


def _masts(req, L, W):
    out = []
    for m in (req.get("masts") or []):
        fl = [dict(x) for x in (m.get("floods") or [])]
        for x in fl:
            x["ax"], x["ay"] = _f(x.get("ax"), L / 2), _f(x.get("ay"), W / 2)
            x["fluxPct"] = min(max(_f(x.get("fluxPct"), 100.0), 0.0), 100.0)
        p = m.get("pattern")
        out.append({"id": m.get("id"), "name": m.get("name"), "x": _f(m.get("x"), 0.0), "y": _f(m.get("y"), 0.0),
                    "h": max(_f(m.get("h"), 20.0), 0.5), "pattern": p if p in PATTERNS else None, "floods": fl})
    return out


class _State:
    """Aim points, outputs and light columns of the modelled floods."""

    def __init__(self, model, masts, webs, movable, masks, max_tilt):
        self.model, self.masts = model, masts
        self.F = []                                       # (mast index, flood dict)
        for i, m in enumerate(masts):
            for fl in m["floods"]:
                if fl.get("photometryId") in webs:
                    self.F.append((i, fl))
        self.movable = np.array([movable[i] for i, _ in self.F], bool)
        self.a = np.array([(fl["ax"], fl["ay"]) for _, fl in self.F], float).reshape(-1, 2)
        self.pct = np.array([fl["fluxPct"] for _, fl in self.F], float)
        self.on = np.ones(len(self.F), bool)
        self.mxy = np.array([(masts[i]["x"], masts[i]["y"]) for i, _ in self.F], float).reshape(-1, 2)
        self.h = np.array([masts[i]["h"] for i, _ in self.F], float)
        self.reach = self.h * math.tan(math.radians(max_tilt - 2.0))
        S = _Samples(model.L, model.W)
        self.zone = []                                    # sample coords each flood may aim at, or None
        for i, _ in self.F:
            mk = masks[i]
            self.zone.append(S.xy[mk] if mk is not None and mk.any() else None)
        self.ds = S.ds
        self.full()

    def items(self, idx, aims, pct=None):
        out = []
        for j, (ax, ay) in zip(idx, aims):
            i, fl = self.F[j]
            rot, tilt = aim_angles(self.mxy[j, 0], self.mxy[j, 1], self.h[j], ax, ay)
            out.append({"id": j, "x": self.mxy[j, 0], "y": self.mxy[j, 1], "h": self.h[j], "rotate": rot, "tilt": tilt,
                        "photometryId": fl.get("photometryId"), "lumens": fl.get("lumens"),
                        "fluxPct": 100.0 if pct is None else pct})
        return out

    def full(self):
        """Columns at full output; sums use the floods' output %."""
        idx = list(range(len(self.F)))
        eh, cams, gl, w = self.model.columns(self.items(idx, self.a))
        self.eh, self.cams, self.gl, self.w = eh, cams, gl, w

    def weight(self):
        return np.where(self.on, self.pct / 100.0, 0.0)

    def sums(self, wv=None):
        wv = self.weight() if wv is None else wv
        return self.eh @ wv, [c @ wv for c in self.cams], self.gl @ wv

    def metrics(self, wv=None):
        return self.model.metrics(*self.sums(wv))

    def clamp(self, j, p):
        p = np.array([min(max(p[0], 0.0), self.model.L), min(max(p[1], 0.0), self.model.W)])
        z = self.zone[j]
        if z is not None:
            d2 = (z[:, 0] - p[0]) ** 2 + (z[:, 1] - p[1]) ** 2
            k = int(np.argmin(d2))
            if d2[k] > (0.75 * self.ds) ** 2:              # outside the zone: onto its nearest sample
                p = z[k].astype(float)
        v = p - self.mxy[j]
        d = float(np.hypot(*v))
        if d > self.reach[j]:
            p = self.mxy[j] + v / d * self.reach[j]
        return p

    def set_aims(self, js, P):
        if not len(js):
            return
        eh, cams, gl, _ = self.model.columns(self.items(js, P))
        for k, j in enumerate(js):
            self.a[j] = P[k]
            self.eh[:, j] = eh[:, k]
            for c, cc in zip(self.cams, cams):
                c[:, j] = cc[:, k]
            self.gl[:, j] = gl[:, k]


def _untangle(st):
    """Floods of one mast aimed at the same point have the same light and would
    move as one: fan each such stack out on a ring a tenth of the pitch across."""
    r = min(st.model.L, st.model.W) / 10.0
    done = set()
    for j in range(len(st.F)):
        if j in done or not st.movable[j]:
            continue
        stack = [k for k in range(j, len(st.F)) if st.movable[k] and st.F[k][0] == st.F[j][0]
                 and float(np.hypot(*(st.a[k] - st.a[j]))) < 0.5]
        done.update(stack)
        if len(stack) > 1:
            c = st.a[j].copy()
            for n, k in enumerate(stack):
                t = 2.0 * math.pi * n / len(stack)
                st.a[k] = c + r * np.array([math.cos(t), math.sin(t)])


def _centroid_phase(st, iters, t_end, e_ref):
    """The original optimiser's centroid shift, clamped to the zones; keeps the
    best set by cost."""
    G = st.model.G[:, :2]
    best = (st.model.cost(*st.sums(), e_ref), st.a.copy())
    mov = np.where(st.movable & st.on)[0]
    for _ in range(iters):
        if time.time() > t_end or not len(mov):
            break
        wv = st.weight()
        E = st.eh @ wv
        avg = float(E.mean())
        if avg <= 0:
            break
        w = (avg / np.maximum(E, avg * 1e-3)) ** 2
        C = st.eh[:, mov]
        tot = np.maximum(C.sum(axis=0), 1e-12)
        cen = (C.T @ G) / tot[:, None]
        cw = C * w[:, None]
        cen_w = (cw.T @ G) / np.maximum(cw.sum(axis=0), 1e-12)[:, None]
        P = np.array([st.clamp(j, st.a[j] + (cen_w[k] - cen[k])) for k, j in enumerate(mov)])
        st.set_aims(list(mov), P)
        c = st.model.cost(*st.sums(), e_ref)
        if c < best[0]:
            best = (c, st.a.copy())
    if not np.allclose(best[1], st.a):
        st.set_aims(list(range(len(st.F))), best[1])
    return best[0]


def _local_phase(st, t_end, e_ref, step0=None):
    """Each flood in turn tries eight moves; the step halves when a sweep finds nothing."""
    m = st.model
    step = step0 or max(m.L, m.W) / 10.0
    mov = [j for j in range(len(st.F)) if st.movable[j] and st.on[j]]
    if not mov:
        return
    wv = st.weight()
    Eh, Cs, Gl = st.sums(wv)
    cur = m.cost(Eh, Cs, Gl, e_ref)
    dirs = [(math.cos(k * math.pi / 4), math.sin(k * math.pi / 4)) for k in range(8)]
    rng = np.random.default_rng(7)
    while step >= max(st.ds * 0.5, 0.2) and time.time() < t_end:
        improved = False
        for j in rng.permutation(mov):
            if time.time() > t_end:
                break
            cand = []
            for dx, dy in dirs:
                p = st.clamp(j, st.a[j] + np.array([dx, dy]) * step)
                if np.hypot(*(p - st.a[j])) > 1e-6 and not any(np.allclose(p, q) for q in cand):
                    cand.append(p)
            if not cand:
                continue
            eh, cams, gl, _ = m.columns(st.items([j] * len(cand), cand))
            wj = wv[j]
            base_e = Eh - st.eh[:, j] * wj
            base_c = [c - cc[:, j] * wj for c, cc in zip(Cs, st.cams)]
            base_g = Gl - st.gl[:, j] * wj
            best_k, best_c = -1, cur - 1e-7
            for k in range(len(cand)):
                ck = m.cost(base_e + eh[:, k] * wj, [b + cc[:, k] * wj for b, cc in zip(base_c, cams)], base_g + gl[:, k] * wj, e_ref)
                if ck < best_c:
                    best_k, best_c = k, ck
            if best_k >= 0:
                st.a[j] = cand[best_k]
                st.eh[:, j] = eh[:, best_k]
                for c, cc in zip(st.cams, cams):
                    c[:, j] = cc[:, best_k]
                st.gl[:, j] = gl[:, best_k]
                Eh, Cs, Gl = st.sums(wv)
                cur = best_c
                improved = True
        if not improved:
            step /= 2.0


def _need(m, tg):
    """Smallest output factor that still meets every illuminance target (> 1: short)."""
    r = []
    if tg.get("em"):
        r.append(tg["em"] / max(m["Eav"], 1e-9))
    if tg.get("evCam"):
        r += [tg["evCam"] / max(c["Eav"], 1e-9) for c in m["cams"]]
    return max(r) if r else None


def _ratio_ok(m, tg):
    """Every target that does not scale with output (uniformities, GR) is met."""
    if tg.get("u2") and m["U2"] < tg["u2"]:
        return False
    if tg.get("u1") and m["U1"] < tg["u1"]:
        return False
    if tg.get("gr") and m["GR"] is not None and m["GR"] > tg["gr"]:
        return False
    for c in m["cams"]:
        if tg.get("evCamU2") and c["U2"] < tg["evCamU2"]:
            return False
    return True


def _remove(st, t_end, e_ref, warns):
    """Drop floods while every target is met at full output (never a mast's last)."""
    tg, m = st.model.tg, st.model
    removed = []
    full = lambda: np.where(st.on, 1.0, 0.0)
    mf = st.metrics(full())
    if not (_ratio_ok(mf, tg) and (_need(mf, tg) or 0) <= 1.0):
        warns.append("Floods not removed: the targets are not all met with every flood at full output")
        return removed
    while time.time() < t_end:
        per = {}
        for j in np.where(st.on)[0]:
            per[st.F[j][0]] = per.get(st.F[j][0], 0) + 1
        cands = [j for j in np.where(st.on & st.movable)[0] if per[st.F[j][0]] > 1]
        best = None
        for j in cands:
            wv = full()
            wv[j] = 0.0
            mk = st.metrics(wv)
            if not _ratio_ok(mk, tg) or (_need(mk, tg) or 0) > 1.0:
                continue
            c = m.cost(*st.sums(wv), e_ref)
            if best is None or c < best[0]:
                best = (c, j)
        if best is None:
            break
        j = best[1]
        st.on[j] = False
        keep_pct = st.pct.copy()
        st.pct[st.on] = 100.0
        _local_phase(st, min(t_end, time.time() + 0.6), e_ref, step0=max(m.L, m.W) / 20.0)
        mk = st.metrics(full())
        st.pct = keep_pct
        if not (_ratio_ok(mk, tg) and (_need(mk, tg) or 0) <= 1.0):
            st.on[j] = True                                  # the re-aim broke a target: put it back, stop
            break
        removed.append(j)
    return removed


def _dim(st, warns):
    """Scale every modelled flood's output so the tightest illuminance target is met with 2 % in hand."""
    st.pct[st.on] = 100.0
    need = _need(st.metrics(), st.model.tg)
    if need is None:
        warns.append("Not dimmed: no illuminance target to dim to")
        return
    if need > 1.0:
        warns.append(f"Not dimmed: the floods at full output give {100.0 / need:.0f} % of the illuminance target")
        return
    st.pct[st.on] = np.minimum(100.0, np.ceil(need * 1.02 * 100.0))


def _summary(st, m):
    tilts = [math.degrees(math.atan2(float(np.hypot(*(st.a[j] - st.mxy[j]))), st.h[j])) for j in range(len(st.F)) if st.on[j]]
    out = {"Eav": round(m["Eav"], 1), "Emin": round(m["Emin"], 1), "Emax": round(m["Emax"], 1),
           "U1": round(m["U1"], 3), "U2": round(m["U2"], 3), "GR": None if m["GR"] is None else round(m["GR"], 1),
           "cameras": [{"name": c["name"], "Eav": round(c["Eav"], 1), "U2": round(c["U2"], 3)} for c in m["cams"]],
           "maxTilt": round(max(tilts), 1) if tilts else None,
           "watts": round(float(st.w @ st.weight()), 1), "count": int(st.on.sum())}
    out["pass"] = st.model.shortfall(m) <= 1e-4 if st.model.tg else None      # the calculation's rounding
    return out


def aim(req: dict, budget: float = None) -> dict:
    """Apply a pattern and/or optimise a field's aiming.

    req: { field:{ length, width, gridStep, mf, maxTilt, groundRho, evHeight,
    targets:{ em, u1, u2, gr, evCam, evCamU2 }, cameras:[{ name, x, y }] },
    masts:[{ id, name, x, y, h, pattern?, floods:[{ id, ax, ay, photometryId,
    fluxPct, lumens? }] }], photometry, pattern?, apply?:[mast ids] (default
    all), optimise? (default true), move?:[mast ids] (default all), trim?:
    'none' | 'dim' | 'remove', iterations?, budget? (seconds) }.
    Field-local metres; cameras in field metres too."""
    t0 = time.time()
    budget = float(budget if budget is not None else min(max(_f(req.get("budget"), 10.0), 1.0), 25.0))
    t_end = t0 + budget
    webs = {k: _Web(v) for k, v in (req.get("photometry") or {}).items()}
    fd = _field(req)
    L, W, max_tilt = fd["L"], fd["W"], fd["maxTilt"]
    masts = _masts(req, L, W)
    warns = []
    ids = [m["id"] for m in masts]
    pattern = req.get("pattern")
    if pattern is not None and pattern not in PATTERNS:
        raise ValueError(f"Unknown aiming pattern '{pattern}'")
    apply = [i for i, mid in enumerate(ids) if req.get("apply") is None or mid in req.get("apply")]
    model = _Model(fd, webs)
    optimise = req.get("optimise", True) is not False
    modelled = any(fl.get("photometryId") in webs for m in masts for fl in m["floods"])
    if not modelled and (optimise or req.get("trim") in ("dim", "remove")):
        raise ValueError("No floodlights with a luminaire to aim")

    before = None
    if modelled:
        pre = _State(model, masts, webs, [True] * len(masts), [None] * len(masts), max_tilt)
        before = _summary(pre, pre.metrics())

    if pattern:
        geo = [{"x": m["x"], "y": m["y"], "h": m["h"], "n": len(m["floods"]), "name": m["name"], "id": m["id"]} for m in masts]
        pts, w = pattern_aims(L, W, geo, pattern, apply, max_tilt, [m["pattern"] for m in masts])
        warns += w
        for i in apply:
            masts[i]["pattern"] = pattern
            for fl, (ax, ay) in zip(masts[i]["floods"], pts.get(i, [])):
                fl["ax"], fl["ay"] = ax, ay

    removed = []
    after = None
    if modelled:
        S = _Samples(L, W)
        masks, w = zone_masks(S, [{"x": m["x"], "y": m["y"], "h": m["h"], "name": m["name"], "id": m["id"]} for m in masts],
                              [m["pattern"] for m in masts], max_tilt)
        if not pattern:
            warns += w
        move = req.get("move")
        movable = [move is None or m["id"] in move for m in masts]
        st = _State(model, masts, webs, movable, masks, max_tilt)
        e_ref = max(st.metrics()["Eav"], 1e-6)
        if optimise:
            iters = int(min(max(_f(req.get("iterations"), 40), 0), 120))
            # the original optimiser's points on the pitch, then the zones
            _untangle(st)
            for j in range(len(st.F)):
                st.a[j] = st.clamp(j, st.a[j])
            st.full()
            _centroid_phase(st, iters, t0 + budget * 0.35, e_ref)
            _local_phase(st, t0 + budget * (0.6 if req.get("trim") == "remove" else 0.95), e_ref)
        trim = req.get("trim") or "none"
        if trim == "remove":
            removed = _remove(st, t0 + budget * 0.97, e_ref, warns)
        if trim in ("dim", "remove"):
            _dim(st, warns)
        after = _summary(st, st.metrics())
        for j, (i, fl) in enumerate(st.F):
            fl["ax"], fl["ay"] = float(st.a[j, 0]), float(st.a[j, 1])
            if trim in ("dim", "remove"):
                fl["fluxPct"] = float(st.pct[j])
        removed = [st.F[j][1].get("id") for j in removed]

    out_masts = []
    for m in masts:
        out_masts.append({"id": m["id"], "pattern": m["pattern"],
                          "floods": [{"id": fl.get("id"), "ax": round(fl["ax"], 2), "ay": round(fl["ay"], 2), "fluxPct": round(fl["fluxPct"], 1)}
                                     for fl in m["floods"] if fl.get("id") not in removed]})
    return {"masts": out_masts, "removed": removed, "before": before, "after": after,
            "warnings": list(dict.fromkeys(warns)), "grid": {"nx": model.nx, "ny": model.ny},
            "ms": round((time.time() - t0) * 1000.0)}


def compare(req: dict) -> dict:
    """Every pattern applied to every mast and optimised (with the trim asked
    for), and the current aiming as it is: one row each for the user to pick."""
    t0 = time.time()
    per = min(max(_f(req.get("budget"), 4.0), 1.0), 8.0)
    base = {k: v for k, v in req.items() if k not in ("pattern", "apply", "move", "optimise")}
    cur = aim(dict(base, optimise=False, trim="none"), budget=1.0)
    rows = [{"pattern": None, "label": "Current aiming", **cur}]
    for p, label in PATTERNS.items():
        r = aim(dict(base, pattern=p, optimise=True), budget=per)
        rows.append({"pattern": p, "label": label, **r})
    return {"options": rows, "ms": round((time.time() - t0) * 1000.0)}
