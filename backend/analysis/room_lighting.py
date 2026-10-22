"""Room lighting — direct + interreflected illuminance, UGR and energy for an
interior of any polygon outline under a flat ceiling.

The room is the polygon extruded to the ceiling height. Its floor, ceiling and
wall surfaces are meshed into patches. The calculation follows the usual
lighting-design chain:

  • Direct light — every luminaire is a point source with the canonical Type C
    web of photometry.py: E = I(C, γ)·cos θ / d². In a room that is not convex
    a luminaire (or patch) can be hidden behind a corner, so each direct path
    and each patch-to-patch path is tested against the outline.
  • Interreflection — diffuse (Lambertian) radiosity between the patches:
    B = ρ·(E_direct + F·B). The form factors are symmetric by construction
    (A_i F_ij = A_j F_ji) and balanced so every patch sees a closed
    enclosure (ΣF = 1), which makes the solution conserve flux exactly:
    Σ A_i (1 − ρ_i) E_i = Φ.
  • Work plane — a regular grid at the work-plane height, the wall zone left
    out, giving Ēm, Emin, Emax and U₀ = Emin/Ēm (EN 12464-1 §4.? grid rule:
    p = 0.2·5^log10(d), refined to ≤ 0.5 m).
  • Walls and ceiling — mean illuminance over their patches; cylindrical
    illuminance Ēz = mean over 8 directions of max(0, E_v) at 1.2 m.
  • UGR — CIE 117 / CIE 190 unified glare rating at the standard observer
    positions (eye 1.2 m, looking along the room axes from the middle of each
    wall), UGR = 8·log10( 0.25/Lb · Σ L²ω/p² ), with Lb = E_ind/π at the eye
    and the Guth position index p from Einhorn's formula. Evaluated with the
    luminaires' initial flux.
  • Energy — installed W, W/m² and W/m² per 100 lx.

Illuminance is reported maintained (× the room's maintenance factor); UGR is
not. Everything is diffuse, empty and obstruction-free: furniture, windows and
doors are not modelled.

Geometry: plan metres with y up; z up from the floor. A luminaire's C0 axis
points along +x rotated by `rotate` degrees counter-clockwise.

Request (camelCase): { rooms:[{ id, name, polygon:[[x,y]…], ceilH, workH,
wallZone, rhoC, rhoW, rhoF, mf, targets:{em,uo,ugr,wallE,ceilE,ez},
luminaires:[{ id, x, y, photometryId, mount:'recessed'|'surface'|'suspended',
drop, rotate, fluxPct, lumens?, watts? }] }], photometry:{id: web}, detail }.
"""

from __future__ import annotations

import math
import time

import numpy as np

from .road_lighting import _Web

EYE_H = 1.2          # seated observer eye height (m)
CYL_H = 1.2          # cylindrical illuminance plane height (m)
MAX_PATCHES = 1800   # cap on the radiosity system size


def _f(v, d):
    try:
        x = float(v)
        return x if math.isfinite(x) else d
    except (TypeError, ValueError):
        return d


# ─── Polygon helpers (plan view) ────────────────────────────────────────

def _signed_area(P):
    x, y = P[:, 0], P[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _pip(P, x, y):
    """Point-in-polygon for arrays x, y (even-odd)."""
    inside = np.zeros(np.shape(x), bool)
    n = len(P)
    for i in range(n):
        x1, y1 = P[i]
        x2, y2 = P[(i + 1) % n]
        cond = (y1 > y) != (y2 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
        inside ^= cond & (x < xin)
    return inside


def _dist_to_edges(P, x, y):
    best = np.full(np.shape(x), np.inf)
    n = len(P)
    for i in range(n):
        x1, y1 = P[i]
        x2, y2 = P[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = np.clip(((x - x1) * dx + (y - y1) * dy) / max(L2, 1e-18), 0.0, 1.0)
        best = np.minimum(best, np.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def _is_convex(P):
    n = len(P)
    for i in range(n):
        a, b, c = P[i], P[(i + 1) % n], P[(i + 2) % n]
        if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-9:
            return False
    return True


def _clear(P, ax, ay, bx, by):
    """2-D visibility: the segment A→B stays inside the polygon (arrays broadcast)."""
    rx, ry = bx - ax, by - ay
    blocked = np.zeros(np.broadcast(rx, ry).shape, bool)
    n = len(P)
    eps = 1e-6
    for i in range(n):
        qx, qy = P[i]
        sx, sy = P[(i + 1) % n][0] - qx, P[(i + 1) % n][1] - qy
        den = rx * sy - ry * sx
        qpx, qpy = qx - ax, qy - ay
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (qpx * sy - qpy * sx) / den
            u = (qpx * ry - qpy * rx) / den
        blocked |= (np.abs(den) > 1e-12) & (t > eps) & (t < 1 - eps) & (u > eps) & (u < 1 - eps)
    mid = _pip(P, (ax + bx) / 2.0, (ay + by) / 2.0)
    return ~blocked & mid


# ─── Room model ─────────────────────────────────────────────────────────

class _Room:
    def __init__(self, r: dict, webs: dict, detail: str):
        self.id = r.get("id")
        self.name = r.get("name") or "Room"
        poly = [(_f(p[0], 0.0), _f(p[1], 0.0)) for p in (r.get("polygon") or [])]
        if len(poly) > 1 and abs(poly[0][0] - poly[-1][0]) < 1e-9 and abs(poly[0][1] - poly[-1][1]) < 1e-9:
            poly = poly[:-1]
        if len(poly) < 3:
            raise ValueError(f"{self.name}: a room needs at least 3 corners")
        P = np.array(poly, float)
        a = _signed_area(P)
        if abs(a) < 1e-6:
            raise ValueError(f"{self.name}: the outline has no area")
        if a < 0:
            P = P[::-1].copy()
        self.P = P
        self.area = abs(a)
        self.convex = _is_convex(P)
        self.xmin, self.ymin = P.min(axis=0)
        self.xmax, self.ymax = P.max(axis=0)
        self.H = min(max(_f(r.get("ceilH"), 2.7), 1.5), 40.0)
        self.workH = min(max(_f(r.get("workH"), 0.75), 0.0), self.H - 0.2)
        self.wallZone = min(max(_f(r.get("wallZone"), 0.5), 0.0), 3.0)
        self.rho = {"c": min(max(_f(r.get("rhoC"), 0.7), 0.0), 0.99),
                    "w": min(max(_f(r.get("rhoW"), 0.5), 0.0), 0.99),
                    "f": min(max(_f(r.get("rhoF"), 0.2), 0.0), 0.99)}
        self.mf = min(max(_f(r.get("mf"), 0.8), 0.05), 1.0)
        self.targets = r.get("targets") or {}
        self.detail = detail
        self.warnings: list[str] = []
        self.lum = self._luminaires(r.get("luminaires") or [], webs)

    def _luminaires(self, items, webs):
        xs, ys, zs, rot, sc, wt, pid, ids, area = [], [], [], [], [], [], [], [], []
        for it in items:
            x, y = _f(it.get("x"), math.nan), _f(it.get("y"), math.nan)
            p = it.get("photometryId")
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            if p not in webs:
                self.warnings.append(f"Luminaire {it.get('id') or ''}: no photometry '{p}' — left out")
                continue
            if not bool(_pip(self.P, np.array([x]), np.array([y]))[0]):
                self.warnings.append(f"Luminaire {it.get('id') or ''} is outside the room outline — left out")
                continue
            w = webs[p]
            flux_pct = max(_f(it.get("fluxPct"), 100.0), 0.0)
            lm = _f(it.get("lumens"), 0.0) or w.lumens
            watts = _f(it.get("watts"), 0.0) or w.watts
            drop = max(_f(it.get("drop"), 0.0), 0.0) if (it.get("mount") == "suspended") else 0.0
            xs.append(x); ys.append(y); zs.append(max(self.H - drop, 0.3))
            rot.append(_f(it.get("rotate"), 0.0))
            sc.append((lm / w.lumens) * flux_pct / 100.0)
            wt.append(watts * flux_pct / 100.0)
            pid.append(p); ids.append(it.get("id"))
            area.append(_f(getattr(w, "luminous_m2", 0.0), 0.0))
        return {"x": np.array(xs), "y": np.array(ys), "z": np.array(zs), "rot": np.array(rot),
                "scale": np.array(sc), "watts": np.array(wt), "web": np.array(pid, dtype=object),
                "id": ids, "area": np.array(area), "n": len(xs)}


# ─── Direct light ───────────────────────────────────────────────────────

def _intensity(webs, lum, c_deg, g_deg):
    """Candela [n, M] towards the direction given by (C, γ) arrays [n, M]."""
    out = np.zeros(c_deg.shape)
    for pid in set(lum["web"].tolist()):
        m = lum["web"] == pid
        out[:, m] = webs[pid].intensity(c_deg[:, m], g_deg[:, m])
    return out * lum["scale"][None, :]


def _direct(room, webs, pts, nrm, chunk=400):
    """Initial direct illuminance (lx) at points [n,3] with unit normals [n,3]."""
    lum = room.lum
    n = len(pts)
    E = np.zeros(n)
    if not lum["n"]:
        return E
    for s in range(0, n, chunk):
        p = pts[s:s + chunk]
        q = nrm[s:s + chunk]
        vx = p[:, 0:1] - lum["x"][None, :]
        vy = p[:, 1:2] - lum["y"][None, :]
        vz = p[:, 2:3] - lum["z"][None, :]
        d = np.sqrt(vx * vx + vy * vy + vz * vz)
        d = np.maximum(d, 1e-6)
        g = np.degrees(np.arccos(np.clip(-vz / d, -1, 1)))
        c = np.degrees(np.arctan2(vy, vx)) - lum["rot"][None, :]
        I = _intensity(webs, lum, c, g)
        cos_p = -(q[:, 0:1] * vx + q[:, 1:2] * vy + q[:, 2:3] * vz) / d
        e = np.where(cos_p > 1e-9, I * cos_p / (d * d), 0.0)
        if not room.convex:
            vis = _clear(room.P, p[:, 0:1], p[:, 1:2], lum["x"][None, :], lum["y"][None, :])
            e = np.where(vis, e, 0.0)
        E[s:s + chunk] = e.sum(axis=1)
    return E


# ─── Patches and radiosity ──────────────────────────────────────────────

def _patches(room: _Room):
    A = room.area
    full = room.detail != "fast"
    cs = float(np.clip(math.sqrt(A / (300.0 if full else 110.0)), 0.35 if full else 0.6, 1.4))
    cs = min(cs, max(min(room.xmax - room.xmin, room.ymax - room.ymin) / 2.0, 0.2))
    nx = max(int(math.ceil((room.xmax - room.xmin) / cs)), 1)
    ny = max(int(math.ceil((room.ymax - room.ymin) / cs)), 1)
    xs = room.xmin + (np.arange(nx) + 0.5) * (room.xmax - room.xmin) / nx
    ys = room.ymin + (np.arange(ny) + 0.5) * (room.ymax - room.ymin) / ny
    X, Y = np.meshgrid(xs, ys)
    X, Y = X.ravel(), Y.ravel()
    ins = _pip(room.P, X, Y)
    X, Y = X[ins], Y[ins]
    if len(X) == 0:                       # a sliver: use the centroid
        X, Y = np.array([room.P[:, 0].mean()]), np.array([room.P[:, 1].mean()])
    cell_a = room.area / len(X)           # patches share the true area exactly
    pos, nrm, area, rho, kind = [], [], [], [], []
    for z, nz, r, k in ((0.0, 1.0, room.rho["f"], 0), (room.H, -1.0, room.rho["c"], 1)):
        pos.append(np.stack([X, Y, np.full(len(X), z)], axis=1))
        nrm.append(np.tile([0.0, 0.0, nz], (len(X), 1)))
        area.append(np.full(len(X), cell_a)); rho.append(np.full(len(X), r)); kind.append(np.full(len(X), k))
    ws = cs * 1.5
    nv = max(int(math.ceil(room.H / ws)), 2)
    n = len(room.P)
    for i in range(n):
        p0, p1 = room.P[i], room.P[(i + 1) % n]
        L = float(np.hypot(*(p1 - p0)))
        if L < 1e-6:
            continue
        ns = max(int(math.ceil(L / ws)), 1)
        t = (np.arange(ns) + 0.5) / ns
        ex, ey = (p1 - p0) / L
        inx, iny = -ey, ex                                  # inward normal (outline is CCW)
        px = p0[0] + t * (p1[0] - p0[0])
        py = p0[1] + t * (p1[1] - p0[1])
        zs = (np.arange(nv) + 0.5) / nv * room.H
        PX = np.repeat(px, nv); PY = np.repeat(py, nv); PZ = np.tile(zs, ns)
        pos.append(np.stack([PX, PY, PZ], axis=1))
        nrm.append(np.tile([inx, iny, 0.0], (len(PX), 1)))
        area.append(np.full(len(PX), (L / ns) * (room.H / nv)))
        rho.append(np.full(len(PX), room.rho["w"])); kind.append(np.full(len(PX), 2))
    pos = np.vstack(pos); nrm = np.vstack(nrm)
    area = np.concatenate(area); rho = np.concatenate(rho); kind = np.concatenate(kind)
    if len(pos) > MAX_PATCHES:
        room.warnings.append(f"{len(pos)} surface patches — coarse mesh recommended for a room this large")
    return pos, nrm, area, rho, kind


def _balanced_form_factors(room, pos, nrm, area):
    """Symmetric, row-balanced form-factor matrix F (ΣF = 1, A_i F_ij = A_j F_ji)."""
    N = len(pos)
    K = np.zeros((N, N))
    xy_eff = pos[:, :2] + nrm[:, :2] * 1e-3               # nudge wall patches inside for visibility
    for s in range(0, N, 256):
        i = slice(s, min(s + 256, N))
        r = pos[None, :, :] - pos[i, None, :]
        d2 = np.maximum((r * r).sum(axis=2), 1e-12)
        d = np.sqrt(d2)
        ci = (nrm[i, None, :] * r).sum(axis=2) / d
        cj = -(nrm[None, :, :] * r).sum(axis=2) / d
        k = ci * cj * area[i, None] * area[None, :] / (math.pi * d2 + 0.5 * (area[i, None] + area[None, :]))
        k = np.where((ci > 1e-9) & (cj > 1e-9), k, 0.0)
        if not room.convex:
            vis = _clear(room.P, xy_eff[i, None, 0], xy_eff[i, None, 1], xy_eff[None, :, 0], xy_eff[None, :, 1])
            k = np.where(vis, k, 0.0)
        K[i] = k
    np.fill_diagonal(K, 0.0)
    K = 0.5 * (K + K.T)
    x = np.ones(N)
    for _ in range(60):                                   # symmetric matrix balancing
        Kx = K @ x
        x = np.sqrt(x * area / np.maximum(Kx, 1e-18))
    F = (x[:, None] * K * x[None, :]) / area[:, None]
    return F


def _solve(room, webs):
    pos, nrm, area, rho, kind = _patches(room)
    Ed = _direct(room, webs, pos, nrm)
    F = _balanced_form_factors(room, pos, nrm, area)
    N = len(pos)
    B = np.linalg.solve(np.eye(N) - rho[:, None] * F, rho * Ed)
    E_tot = Ed + F @ B
    return {"pos": pos, "nrm": nrm, "area": area, "rho": rho, "kind": kind, "Ed": Ed, "B": B, "E": E_tot, "F": F}


def _indirect(room, S, pts, nrm, chunk=300):
    """Illuminance (lx) at points from the radiosity of the surfaces only."""
    pos, pn, area, B = S["pos"], S["nrm"], S["area"], S["B"]
    n = len(pts)
    out = np.zeros(n)
    xy_eff = pos[:, :2] + pn[:, :2] * 1e-3
    for s in range(0, n, chunk):
        p = pts[s:s + chunk]
        q = nrm[s:s + chunk]
        r = pos[None, :, :] - p[:, None, :]
        d2 = np.maximum((r * r).sum(axis=2), 1e-12)
        d = np.sqrt(d2)
        cp = (q[:, None, :] * r).sum(axis=2) / d
        cj = -(pn[None, :, :] * r).sum(axis=2) / d
        e = B[None, :] * cp * cj * area[None, :] / (math.pi * d2 + area[None, :])
        e = np.where((cp > 1e-9) & (cj > 1e-9), e, 0.0)
        if not room.convex:
            vis = _clear(room.P, p[:, None, 0], p[:, None, 1], xy_eff[None, :, 0], xy_eff[None, :, 1])
            e = np.where(vis, e, 0.0)
        out[s:s + chunk] = e.sum(axis=1)
    return out


# ─── Work-plane grid, cylindrical, UGR ──────────────────────────────────

def _grid_step(room, detail):
    d = max(room.xmax - room.xmin, room.ymax - room.ymin)
    p = 0.2 * 5.0 ** math.log10(max(d, 1.0))               # EN 12464-1 maximum grid size
    step = min(p, 0.5 if detail != "fast" else 1.0)
    return float(np.clip(step, 0.1, 2.0))


def _work_grid(room, step):
    nx = max(int(math.ceil((room.xmax - room.xmin) / step)), 1)
    ny = max(int(math.ceil((room.ymax - room.ymin) / step)), 1)
    while nx * ny > 9000:
        step *= 1.25
        nx = max(int(math.ceil((room.xmax - room.xmin) / step)), 1)
        ny = max(int(math.ceil((room.ymax - room.ymin) / step)), 1)
    xs = room.xmin + (np.arange(nx) + 0.5) * (room.xmax - room.xmin) / nx
    ys = room.ymin + (np.arange(ny) + 0.5) * (room.ymax - room.ymin) / ny
    X, Y = np.meshgrid(xs, ys)
    return X, Y, xs, ys, step


def _guth(sigma_deg, tau_deg):
    s, t = sigma_deg, tau_deg
    a = (35.2 - 0.31889 * t - 1.22 * np.exp(-2.0 * t / 9.0)) * 1e-3 * s
    b = (21.0 + 0.26667 * t - 0.002963 * t * t) * 1e-5 * s * s
    return np.exp(a + b)


def _ugr_at(room, webs, S, ox, oy, view_deg):
    lum = room.lum
    if not lum["n"]:
        return None
    vx, vy = math.cos(math.radians(view_deg)), math.sin(math.radians(view_deg))
    dx = lum["x"] - ox
    dy = lum["y"] - oy
    dz = lum["z"] - EYE_H
    d = np.sqrt(dx * dx + dy * dy + dz * dz)
    h = np.hypot(dx, dy)
    use = (dz > 0.05) & (dx * vx + dy * vy > 0.0) & (d > 0.1)
    if not use.any():
        return None
    if not room.convex:
        use &= _clear(room.P, np.array(ox), np.array(oy), lum["x"], lum["y"])
        if not use.any():
            return None
    dd = np.maximum(d, 1e-6)
    # candela from the luminaire towards the eye
    g = np.degrees(np.arccos(np.clip(dz / dd, -1, 1)))
    c = np.degrees(np.arctan2(-dy, -dx)) - lum["rot"]
    I = _intensity(webs, lum, c[None, :], g[None, :])[0]
    area = np.where(lum["area"] > 0, lum["area"], 0.09)
    a_proj = area * np.maximum(dz / dd, 0.1)
    # position index: σ off the line of sight, τ the azimuth between the two vertical planes
    sigma = np.degrees(np.arccos(np.clip((dx * vx + dy * vy) / dd, -1, 1)))
    tau = np.abs(np.degrees(np.arctan2(dx * vy - dy * vx, dx * vx + dy * vy)))
    p = _guth(np.minimum(sigma, 90.0), np.minimum(tau, 90.0))
    term = np.where(use, I * I / (a_proj * dd * dd * p * p), 0.0).sum()
    e_ind = float(_indirect(room, S, np.array([[ox, oy, EYE_H]]), np.array([[vx, vy, 0.0]]))[0])
    lb = max(e_ind / math.pi, 0.05)
    if term <= 0:
        return None
    return float(8.0 * math.log10(0.25 / lb * term))


def _observers(room, step):
    """Standard observers: the middle of each side of the outline's bounding box,
    1 m in from the wall, looking along the room axis (moved inside if needed)."""
    cx, cy = (room.xmin + room.xmax) / 2.0, (room.ymin + room.ymax) / 2.0
    cand = [("x+", room.xmin + 1.0, cy, 0.0), ("x−", room.xmax - 1.0, cy, 180.0),
            ("y+", cx, room.ymin + 1.0, 90.0), ("y−", cx, room.ymax - 1.0, 270.0)]
    out = []
    for lab, x, y, v in cand:
        if not bool(_pip(room.P, np.array([x]), np.array([y]))[0]):
            # nearest grid point of the outline along the same sight line
            found = False
            for k in range(1, 400):
                for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = x + sx * k * step, y + sy * k * step
                    if bool(_pip(room.P, np.array([xx]), np.array([yy]))[0]) and float(_dist_to_edges(room.P, np.array([xx]), np.array([yy]))[0]) > 0.3:
                        x, y, found = xx, yy, True
                        break
                if found:
                    break
            if not found:
                continue
        out.append((lab, float(x), float(y), v))
    return out


# ─── One room ───────────────────────────────────────────────────────────

def _chk(key, label, value, req, op, unit):
    if value is None or req is None:
        return {"key": key, "label": label, "value": value, "req": req, "op": op, "unit": unit, "pass": None}
    ok = (value >= req - 1e-9) if op == ">=" else (value <= req + 1e-9)
    return {"key": key, "label": label, "value": value, "req": req, "op": op, "unit": unit, "pass": bool(ok)}


def evaluate_room(room: _Room, webs: dict, with_ugr: bool = True, with_cyl: bool = True) -> dict:
    t0 = time.time()
    S = _solve(room, webs)
    step = _grid_step(room, room.detail)
    X, Y, xs, ys, step = _work_grid(room, step)
    flat_x, flat_y = X.ravel(), Y.ravel()
    inside = _pip(room.P, flat_x, flat_y)
    pts = np.stack([flat_x[inside], flat_y[inside], np.full(int(inside.sum()), room.workH)], axis=1)
    up = np.tile([0.0, 0.0, 1.0], (len(pts), 1))
    E_wp = _direct(room, webs, pts, up) + _indirect(room, S, pts, up) if len(pts) else np.array([])
    E_wp = E_wp * room.mf
    dist = _dist_to_edges(room.P, pts[:, 0], pts[:, 1]) if len(pts) else np.array([])
    zone = dist >= room.wallZone - 1e-9
    if len(pts) and not zone.any():
        room.warnings.append("The wall zone covers the whole room — statistics use every point")
        zone = np.ones(len(pts), bool)
    res: dict = {"id": room.id, "name": room.name, "area": round(room.area, 3), "convex": room.convex,
                 "luminaires": room.lum["n"], "warnings": room.warnings, "notes": []}
    kind = S["kind"]
    E_surf = S["E"] * room.mf
    if len(pts) and room.lum["n"]:
        sel = E_wp[zone]
        em = float(sel.mean())
        res["workplane"] = {"Em": round(em, 1), "Emin": round(float(sel.min()), 1), "Emax": round(float(sel.max()), 1),
                            "U0": round(float(sel.min() / em), 3) if em > 0 else 0.0,
                            "Ud": round(float(sel.min() / sel.max()), 3) if sel.max() > 0 else 0.0,
                            "n": int(zone.sum()), "step": round(step, 3), "height": room.workH}
    else:
        res["workplane"] = {"Em": 0.0, "Emin": 0.0, "Emax": 0.0, "U0": 0.0, "Ud": 0.0, "n": int(zone.sum()) if len(pts) else 0,
                            "step": round(step, 3), "height": room.workH}
        if not room.lum["n"]:
            res["notes"].append("No luminaires in this room")
    res["walls"] = {"Em": round(float((E_surf[kind == 2] * S["area"][kind == 2]).sum() / S["area"][kind == 2].sum()), 1)}
    res["ceiling"] = {"Em": round(float((E_surf[kind == 1] * S["area"][kind == 1]).sum() / S["area"][kind == 1].sum()), 1)}
    res["floor"] = {"Em": round(float((E_surf[kind == 0] * S["area"][kind == 0]).sum() / S["area"][kind == 0].sum()), 1)}
    # flux balance — the radiosity solution must absorb everything emitted
    absorbed = float(((1 - S["rho"]) * S["area"] * S["E"]).sum())
    emitted = float(sum((webs[p].lumens * s) for p, s in zip(room.lum["web"], room.lum["scale"])))
    res["fluxBalance"] = {"emitted": round(emitted, 1), "absorbed": round(absorbed, 1)}

    # cylindrical illuminance
    ez = None
    if with_cyl and room.lum["n"] and zone.any():
        idx = np.flatnonzero(zone)
        if len(idx) > 300:
            idx = idx[np.linspace(0, len(idx) - 1, 300).astype(int)]
        cp = np.stack([pts[idx, 0], pts[idx, 1], np.full(len(idx), CYL_H)], axis=1)
        tot = np.zeros(len(idx))
        for k in range(8):
            a = math.radians(k * 45.0)
            nv = np.tile([math.cos(a), math.sin(a), 0.0], (len(idx), 1))
            ev = _direct(room, webs, cp, nv) + _indirect(room, S, cp, nv)
            tot += np.maximum(ev, 0.0)
        ezp = tot / 8.0 * room.mf
        ez = {"Ez": round(float(ezp.mean()), 1), "Ezmin": round(float(ezp.min()), 1)}
    res["cylindrical"] = ez

    # UGR
    ugr_info = None
    if with_ugr and room.lum["n"]:
        obs = []
        for lab, ox, oy, v in _observers(room, step):
            u = _ugr_at(room, webs, S, ox, oy, v)
            if u is not None:
                obs.append({"label": lab, "x": round(ox, 2), "y": round(oy, 2), "dir": v, "ugr": round(u, 1)})
        if obs:
            ugr_info = {"max": max(o["ugr"] for o in obs), "observers": obs,
                        "note": "CIE 117 at the middle of each wall, eye 1.2 m, initial luminaire flux"}
            if any(room.lum["area"] <= 0):
                res["notes"].append("A luminaire has no luminous-area data — UGR assumes 0.09 m²")
    res["ugr"] = ugr_info

    # energy
    watts = float(room.lum["watts"].sum()) if room.lum["n"] else 0.0
    em = res["workplane"]["Em"]
    res["power"] = {"watts": round(watts, 1), "wm2": round(watts / room.area, 2),
                    "wm2per100lx": round(watts / room.area / (em / 100.0), 2) if em > 0 else None,
                    "count": room.lum["n"]}

    # verdict against the room's targets
    tg = room.targets
    checks = []
    if tg.get("em") is not None:
        checks.append(_chk("em", "Ēm work plane", res["workplane"]["Em"], _f(tg.get("em"), None), ">=", "lx"))
    if tg.get("uo") is not None:
        checks.append(_chk("uo", "U₀", res["workplane"]["U0"], _f(tg.get("uo"), None), ">=", ""))
    if tg.get("ugr") is not None and ugr_info:
        checks.append(_chk("ugr", "UGR", ugr_info["max"], _f(tg.get("ugr"), None), "<=", ""))
    if tg.get("wallE"):
        checks.append(_chk("wallE", "Ēm walls", res["walls"]["Em"], _f(tg.get("wallE"), None), ">=", "lx"))
    if tg.get("ceilE"):
        checks.append(_chk("ceilE", "Ēm ceiling", res["ceiling"]["Em"], _f(tg.get("ceilE"), None), ">=", "lx"))
    if tg.get("ez") and ez:
        checks.append(_chk("ez", "Ēz cylindrical", ez["Ez"], _f(tg.get("ez"), None), ">=", "lx"))
    res["checks"] = checks
    known = [c for c in checks if c["pass"] is not None]
    res["pass"] = (all(c["pass"] for c in known) if known and room.lum["n"] else None)

    # display grid (work plane, all inside points, wall zone included)
    if len(pts):
        vals = np.full(X.shape, np.nan)
        flat = vals.ravel()
        flat[np.flatnonzero(inside)] = E_wp
        res["grid"] = {"x0": float(xs[0] - (xs[1] - xs[0]) / 2.0) if len(xs) > 1 else float(room.xmin),
                       "y0": float(ys[0] - (ys[1] - ys[0]) / 2.0) if len(ys) > 1 else float(room.ymin),
                       "dx": float(xs[1] - xs[0]) if len(xs) > 1 else float(room.xmax - room.xmin),
                       "dy": float(ys[1] - ys[0]) if len(ys) > 1 else float(room.ymax - room.ymin),
                       "nx": int(len(xs)), "ny": int(len(ys)),
                       "values": [None if not math.isfinite(v) else round(float(v), 1) for v in flat]}
    res["ms"] = round((time.time() - t0) * 1000.0, 1)
    return res


def run_room_lighting(req: dict) -> dict:
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    detail = "fast" if req.get("detail") == "fast" else "full"
    out = []
    for r in (req.get("rooms") or []):
        try:
            room = _Room(r, webs, detail)
            out.append(evaluate_room(room, webs, with_ugr=bool(req.get("ugr", True)), with_cyl=bool(req.get("cylindrical", True))))
        except ValueError as e:
            out.append({"id": r.get("id"), "name": r.get("name") or "Room", "error": str(e)})
    return {"rooms": out}


# ─── Auto layout: a luminaire grid to the room's targets ────────────────

def _rot(P, ang_deg):
    a = math.radians(ang_deg)
    c, s = math.cos(a), math.sin(a)
    return np.stack([P[:, 0] * c + P[:, 1] * s, -P[:, 0] * s + P[:, 1] * c], axis=1)


def _unrot(P, ang_deg):
    return _rot(P, -ang_deg)


def _lattices(room: _Room, n_seed: int, angles):
    """Candidate lattices (axis-aligned in a rotated frame, half-spacing to the
    bounding box), clipped to the outline and kept ≥ 0.3 m off the walls."""
    seen, out = set(), []
    for ang in angles:
        Q = _rot(room.P, ang)
        x0, y0 = Q.min(axis=0)
        x1, y1 = Q.max(axis=0)
        W, Hh = x1 - x0, y1 - y0
        for nc in range(1, 16):
            for nr in range(1, 16):
                sx, sy = W / nc, Hh / nr
                if not (0.55 <= sx / sy <= 1.8):
                    continue
                xs = x0 + (np.arange(nc) + 0.5) * sx
                ys = y0 + (np.arange(nr) + 0.5) * sy
                X, Y = np.meshgrid(xs, ys)
                pts = _unrot(np.stack([X.ravel(), Y.ravel()], axis=1), ang)
                ok = _pip(room.P, pts[:, 0], pts[:, 1]) & (_dist_to_edges(room.P, pts[:, 0], pts[:, 1]) >= 0.3)
                pts = pts[ok]
                n = len(pts)
                if n < 1 or n > max(2.2 * n_seed, n_seed + 4) or n < 0.45 * n_seed:
                    continue
                key = (round(ang, 1), tuple(sorted((round(p[0], 2), round(p[1], 2)) for p in pts)))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"angle": ang, "rows": nr, "cols": nc, "sx": sx, "sy": sy, "pts": pts})
    out.sort(key=lambda c: (abs(len(c["pts"]) - n_seed), abs(math.log(c["sx"] / c["sy"]))))
    return out


def suggest_layout(req: dict) -> dict:
    """Propose luminaire grids that meet the room's targets.

    req: { room: <a room as in run_room_lighting, no luminaires needed>,
           photometry: {id: web}, photometryId, mount, drop, fluxPct, maxCandidates }
    Returns up to four candidates ranked passing-first, then fewest fittings,
    then lowest power; if nothing passes, the closest ones with `pass: false`."""
    t0 = time.time()
    pid = req.get("photometryId")
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    if pid not in webs:
        raise ValueError("Pick a luminaire for the layout")
    base_req = dict(req.get("room") or {})
    base_req["luminaires"] = []
    room0 = _Room(base_req, webs, "fast")
    tg = room0.targets
    em_t = _f(tg.get("em"), 0.0)
    if em_t <= 0:
        raise ValueError("Set a target Ēm for the room first")
    web = webs[pid]
    flux_pct = max(_f(req.get("fluxPct"), 100.0), 1.0)
    mount = req.get("mount") or "recessed"
    drop = _f(req.get("drop"), 0.0)

    def lum_at(pts, rot):
        return [{"id": f"s{i}", "x": float(p[0]), "y": float(p[1]), "photometryId": pid, "mount": mount,
                 "drop": drop, "rotate": rot, "fluxPct": flux_pct} for i, p in enumerate(pts)]

    # Seed: one trial lattice at ~1.8 × mounting height, scaled by Ēm_target / Ēm_trial.
    hm = max(room0.H - room0.workH - (drop if mount == "suspended" else 0.0), 0.5)
    n_trial = max(int(math.ceil(room0.area / (1.8 * hm) ** 2)), 1)
    ang_long = 0.0
    n_e = len(room0.P)
    best_len = 0.0
    for i in range(n_e):
        d = room0.P[(i + 1) % n_e] - room0.P[i]
        L = float(np.hypot(*d))
        if L > best_len:
            best_len, ang_long = L, math.degrees(math.atan2(d[1], d[0])) % 90.0
    angles = [0.0] if (abs(ang_long) < 1.0 or abs(ang_long - 90.0) < 1.0) else [round(ang_long, 2), 0.0]
    trial = None
    for c in _lattices(room0, n_trial, angles[:1]) or []:
        trial = c
        break
    if trial is None:
        raise ValueError("No luminaire grid fits this room outline")
    r_trial = _Room(dict(base_req, luminaires=lum_at(trial["pts"], trial["angle"])), webs, "fast")
    em_trial = evaluate_room(r_trial, webs, with_ugr=False, with_cyl=False)["workplane"]["Em"]
    if em_trial <= 0:
        raise ValueError("The luminaire gives no light on the work plane")
    n_seed = max(int(round(len(trial["pts"]) * em_t / em_trial)), 1)

    cands = _lattices(room0, n_seed, angles)[: int(req.get("maxCandidates") or 18)]
    def assess(c, detail):
        room = _Room(dict(base_req, luminaires=lum_at(c["pts"], c["angle"])), webs, detail)
        res = evaluate_room(room, webs, with_ugr=True, with_cyl=False)
        res.pop("grid", None)
        return res

    def rank_key(s):
        return (0 if s["result"]["pass"] else 1, s["count"] if s["result"]["pass"] else shortfall(s), s["result"]["watts"])

    # Screen every lattice on the coarse mesh, then re-check the best few on the
    # full one, so the numbers shown are the ones the placed layout will give.
    screened = []
    for c in cands:
        if time.time() - t0 > 10.0:
            break
        screened.append((c, assess(c, "fast")))
    if not screened:
        raise ValueError("No luminaire grid fits this room outline")

    def shortfall(s):
        return sum(max(0.0, (k["req"] - k["value"]) / max(abs(k["req"]), 1e-9)) if k["op"] == ">=" else max(0.0, (k["value"] - k["req"]) / max(abs(k["req"]), 1e-9))
                   for k in s["result"]["checks"] if k["pass"] is False)

    def pack(c, res):
        return {
            "angle": c["angle"], "rows": c["rows"], "cols": c["cols"], "count": len(c["pts"]),
            "spacingX": round(c["sx"], 2), "spacingY": round(c["sy"], 2),
            "spacingToHeight": round(max(c["sx"], c["sy"]) / hm, 2),
            "positions": [[round(float(p[0]), 3), round(float(p[1]), 3)] for p in c["pts"]],
            "rotate": c["angle"],
            "result": {"Em": res["workplane"]["Em"], "U0": res["workplane"]["U0"], "Emin": res["workplane"]["Emin"],
                       "ugr": (res["ugr"] or {}).get("max"), "wm2": res["power"]["wm2"], "watts": res["power"]["watts"],
                       "checks": res["checks"], "pass": res["pass"]},
        }

    order = sorted(((pack(c, r), c) for c, r in screened), key=lambda t: rank_key(t[0]))
    scored = []
    for item, c in order[:6]:
        scored.append(item if time.time() - t0 > 14.0 else pack(c, assess(c, "full")))
    scored.sort(key=rank_key)
    return {"seed": {"count": n_seed, "trialCount": len(trial["pts"]), "trialEm": em_trial, "mountingHeight": round(hm, 2)},
            "candidates": scored[:4], "evaluated": len(screened), "ms": round((time.time() - t0) * 1000.0)}
