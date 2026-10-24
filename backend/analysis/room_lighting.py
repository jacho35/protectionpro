"""Room lighting — direct + interreflected illuminance, UGR and energy for an
interior of any polygon outline, under a flat ceiling or a ceiling section.

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
not. Every surface is diffuse.

Objects (the 3D view, all optional — a room without them is calculated
exactly as before):
  • obstacles — boxes (desks, shelving, partitions, columns) on the plan,
    turned by `rot`, from z0 up h. A box that blocks light casts shadows in
    the direct light, hides patches from each other in the interreflection
    and is itself meshed into patches with its own reflectance. Floor,
    ceiling and wall patches it covers drop out; work-plane points inside it
    are left out of the statistics.
  • openings — windows and doors, a rectangle on a wall (plan end points a, b,
    sill, height). The wall patches they cover take the opening's
    reflectance (area-weighted where a patch is only partly covered). No
    daylight: a window is a surface that reflects little and lets the rest
    out.
  • surfaces — calculation surfaces (a task area on a desk, a vertical board):
    a rectangle facing up, down or sideways, gridded and reported like the
    work plane (Ē, Emin, Emax, U₀ against its own target).
  • patches: true returns every patch (centre, half-extents, maintained
    illuminance, reflectance) so the 3D view can draw the surfaces as bright
    as they are.

Ceiling section (optional — absent ⇒ the flat ceiling at ceilH, calculated
exactly as before): `ceiling: { angle, s0, points:[[s, z]…] }` gives the
ceiling height as a profile z(s) across the room, s measured along the plan
direction `angle` (degrees, counter-clockwise from +x) from s0, the profile
extruded along the other direction — pitched, mono-pitch, barrel or any
polyline. s must not decrease (two points at the same s make a vertical step,
e.g. a clerestory); beyond its ends the profile stays level. The ceiling is
meshed into tilted patches (true area, own normal) plus the step faces; walls
are cut to the ceiling above them (gable ends); where the section is not
convex from below, light paths through the ceiling are blocked (exact for a
piecewise-linear profile). A level section is the flat ceiling. Luminaires:
`recessed` / `surface` sit on the ceiling and tilt with it (the light leaving
5 cm below it; at a ridge or valley facing the bisector of the slopes);
`suspended` hang `drop` below it; `pendant` hang at `mountH` above the floor,
pointing down; `wall` sit 10 cm off the nearest wall at `mountH`, `tilt`
degrees from pointing down (0 down, 90 across the room, 180 up). Patches
close to these fittings get their direct light integrated over sub-samples
(a fitting near a surface is otherwise seen only by patch centres); flat
rooms with ceiling fittings are calculated exactly as before.

Geometry: plan metres with y up; z up from the floor. A luminaire's C0 axis
points along +x rotated by `rotate` degrees counter-clockwise.

Request (camelCase): { rooms:[{ id, name, polygon:[[x,y]…], ceilH, workH,
wallZone, rhoC, rhoW, rhoF, mf, targets:{em,uo,ugr,wallE,ceilE,ez},
luminaires:[{ id, x, y, photometryId, mount:'recessed'|'surface'|'suspended'|
'pendant'|'wall', drop, mountH, tilt, rotate, fluxPct, lumens?, watts? }],
ceiling:{ angle, s0, points }, obstacles:[{ id, cx, cy, w, d, rot,
z0, h, rho, blocks }], openings:[{ id, kind, a:[x,y], b:[x,y], sill, h, rho }],
surfaces:[{ id, name, cx, cy, w, d, rot, z, h, face:'up'|'down'|'vertical',
target }], patches }], photometry:{id: web}, detail }.
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


# ─── Ceiling section ────────────────────────────────────────────────────

class _Ceiling:
    """Ceiling height z(s) along the plan direction u = (cos a, sin a), s = p·u − s0."""

    def __init__(self, spec: dict):
        a = math.radians(_f(spec.get("angle"), 0.0))
        self.ux, self.uy = math.cos(a), math.sin(a)
        self.s0 = _f(spec.get("s0"), 0.0)
        pts = []
        for q in spec.get("points") or []:
            try:
                sv, zv = float(q[0]), float(q[1])
            except (TypeError, ValueError, IndexError):
                continue
            if math.isfinite(sv) and math.isfinite(zv):
                pts.append((sv, min(max(zv, 0.3), 40.0)))
        self.ok = len(pts) >= 2 and all(pts[i + 1][0] >= pts[i][0] - 1e-9 for i in range(len(pts) - 1)) \
            and pts[-1][0] - pts[0][0] > 1e-6
        if not self.ok:
            return
        self.S = np.array([q[0] for q in pts])
        self.Z = np.array([q[1] for q in pts])
        # Convex from below (no light path can leave through it): slopes never
        # rise again and there are no steps.
        dS, dZ = np.diff(self.S), np.diff(self.Z)
        steps = dS < 1e-9
        slopes = dZ[~steps] / dS[~steps]
        self.concave = (not steps.any()) and bool(np.all(np.diff(slopes) <= 1e-9))
        # Breakpoints for the visibility test: the lowest height at each s.
        bs, bz = [], []
        for sv, zv in zip(self.S, self.Z):
            if bs and abs(sv - bs[-1]) < 1e-9:
                bz[-1] = min(bz[-1], zv)
            else:
                bs.append(sv); bz.append(zv)
        self.bS, self.bZ = np.array(bs), np.array(bz)
        # Vertical steps: (s, z on the low-s side, z on the high-s side).
        self.steps = [(float(self.S[i]), float(self.Z[i]), float(self.Z[i + 1]))
                      for i in range(len(dS)) if steps[i] and abs(dZ[i]) > 1e-6]

    def s_of(self, x, y):
        return np.asarray(x) * self.ux + np.asarray(y) * self.uy - self.s0

    def height(self, x, y):
        return np.interp(self.s_of(x, y), self.S, self.Z)

    def slope(self, x, y):
        """dz/ds of the ceiling segment over each point (0 beyond the ends)."""
        s = self.s_of(x, y)
        dS, dZ = np.diff(self.S), np.diff(self.Z)
        with np.errstate(divide="ignore", invalid="ignore"):
            k = np.where(dS > 1e-9, dZ / np.where(dS > 1e-9, dS, 1.0), 0.0)
        i = np.clip(np.searchsorted(self.S, s, side="right") - 1, 0, len(dS) - 1)
        inside = (s > self.S[0]) & (s < self.S[-1])
        return np.where(inside, k[i], 0.0)

    def normal(self, x, y):
        """Unit normals of the ceiling over the points, pointing down into the room [n, 3]."""
        k = np.atleast_1d(self.slope(x, y))
        nz = 1.0 / np.sqrt(1.0 + k * k)
        return np.stack([k * self.ux * nz, k * self.uy * nz, -nz], axis=-1)

    def mount_normal(self, x, y):
        """The normal a fitting at (x, y) faces: at a ridge or valley the bisector of the two slopes."""
        e = 1e-4
        n = self.normal(np.array([x - self.ux * e, x + self.ux * e]), np.array([y - self.uy * e, y + self.uy * e]))
        m = n.sum(axis=0)
        return m / np.linalg.norm(m)

    def clear(self, ax, ay, az, bx, by, bz):
        """The segment A→B stays under the ceiling (arrays broadcast). Between
        breakpoints both the segment and the profile are linear in s, so it is
        enough to test the segment's height where it crosses each breakpoint."""
        shape = np.broadcast(ax, ay, az, bx, by, bz).shape
        if self.concave:
            return np.ones(shape, bool)
        sa, sb = self.s_of(ax, ay), self.s_of(bx, by)
        ds = sb - sa
        ok = np.ones(shape, bool)
        for sk, zk in zip(self.bS, self.bZ):
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (sk - sa) / ds
            cross = (np.abs(ds) > 1e-12) & (t > 1e-6) & (t < 1 - 1e-6)
            zt = az + t * (bz - az)
            ok &= ~(cross & (zt > zk + 1e-6))
        return ok


def _under(room, ax, ay, az, bx, by, bz):
    """True where the path A→B is not cut by the ceiling (always for a flat one)."""
    if room.ceil is None or room.ceil.concave:
        return True
    return room.ceil.clear(ax, ay, az, bx, by, bz)


def _height_at(room, x, y):
    return room.ceil.height(x, y) if room.ceil is not None else np.full(np.shape(x), room.H)


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
        self.warnings: list[str] = []
        self.ceil = None
        if isinstance(r.get("ceiling"), dict):
            c = _Ceiling(r["ceiling"])
            if c.ok and float(np.ptp(c.Z)) < 1e-9:      # a level section is a flat ceiling
                self.H = min(max(float(c.Z[0]), 1.5), 40.0)
            elif c.ok:
                self.ceil = c
                hs = c.height(P[:, 0], P[:, 1])
                self.H = float(max(c.Z.max(), 0.3))       # highest point (clamps, openings)
                self.Hmin = float(min(c.Z.min(), hs.min()))
            else:
                self.warnings.append("Ceiling section not understood (points must run one way across the room) — flat ceiling used")
        if self.ceil is None:
            self.Hmin = self.H
        self.workH = min(max(_f(r.get("workH"), 0.75), 0.0), max(self.Hmin - 0.2, 0.0))
        self.wallZone = min(max(_f(r.get("wallZone"), 0.5), 0.0), 3.0)
        self.rho = {"c": min(max(_f(r.get("rhoC"), 0.7), 0.0), 0.99),
                    "w": min(max(_f(r.get("rhoW"), 0.5), 0.0), 0.99),
                    "f": min(max(_f(r.get("rhoF"), 0.2), 0.0), 0.99)}
        self.mf = min(max(_f(r.get("mf"), 0.8), 0.05), 1.0)
        self.targets = r.get("targets") or {}
        # Calculation grid size (m) the user asked for; 0 / absent = automatic.
        self.gridStep = max(_f(r.get("gridStep"), 0.0), 0.0)
        self.detail = detail
        self.lum = self._luminaires(r.get("luminaires") or [], webs)
        self.boxes = [b for b in (_Box(o) for o in (r.get("obstacles") or []) if o.get("blocks", True) is not False) if b.ok]
        self.openings = [o for o in (r.get("openings") or []) if isinstance(o, dict)]
        self.surfaces = [o for o in (r.get("surfaces") or []) if isinstance(o, dict)]
        self.want_patches = bool(r.get("patches"))

    def _wall_spot(self, x, y):
        """The nearest wall: the point 10 cm in front of it (a fitting projects from the wall) and the angle of its inward normal."""
        best, out = math.inf, (x, y, 0.0)
        n = len(self.P)
        for i in range(n):
            (x1, y1), (x2, y2) = self.P[i], self.P[(i + 1) % n]
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            if L2 < 1e-12:
                continue
            t = min(max(((x - x1) * dx + (y - y1) * dy) / L2, 0.02), 0.98)
            px, py = x1 + t * dx, y1 + t * dy
            d = math.hypot(x - px, y - py)
            if d < best:
                L = math.sqrt(L2)
                nx, ny = -dy / L, dx / L                  # inward (outline is CCW)
                best, out = d, (px + nx * 0.10, py + ny * 0.10, math.degrees(math.atan2(ny, nx)))
        return out

    def _luminaires(self, items, webs):
        xs, ys, zs, rot, sc, wt, pid, ids, area, frames, near, lift = [], [], [], [], [], [], [], [], [], [], [], []
        framed = False
        for it in items:
            x, y = _f(it.get("x"), math.nan), _f(it.get("y"), math.nan)
            p = it.get("photometryId")
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            mount = it.get("mount") or "recessed"
            r_deg = _f(it.get("rotate"), 0.0)
            wall_ang = None
            if mount == "wall":
                x, y, wall_ang = self._wall_spot(x, y)
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
            drop = max(_f(it.get("drop"), 0.0), 0.0) if (mount == "suspended") else 0.0
            frame = None
            if self.ceil is None and mount not in ("pendant", "wall"):
                z = max(self.H - drop, 0.3)
            else:
                hc = float(_height_at(self, np.array([x]), np.array([y]))[0])
                if mount == "pendant":
                    z = min(max(_f(it.get("mountH"), hc - 0.5), 0.3), hc - 0.02)
                elif mount == "wall":
                    z = min(max(_f(it.get("mountH"), 2.0), 0.1), hc - 0.05)
                    th = math.radians(min(max(_f(it.get("tilt"), 0.0), 0.0), 180.0))
                    rr = math.radians(wall_ang - 90.0)             # C90 faces into the room
                    ex = np.array([math.cos(rr), math.sin(rr), 0.0])
                    ey0 = np.array([-math.sin(rr), math.cos(rr), 0.0])
                    frame = np.stack([ex, ey0 * math.cos(th) + np.array([0, 0, math.sin(th)]),
                                      -ey0 * math.sin(th) + np.array([0, 0, math.cos(th)])])
                    r_deg = wall_ang - 90.0
                else:
                    # under a section a ceiling fitting's light leaves 5 cm below the ceiling
                    z = max(hc - (drop if mount == "suspended" else 0.05), 0.3)
                    if mount in ("recessed", "surface") and self.ceil is not None:
                        ez = -self.ceil.mount_normal(x, y)          # up, square to the ceiling (bisector at a ridge)
                        if abs(ez[2]) < 1.0 - 1e-12:
                            a = math.radians(r_deg)
                            e0 = np.array([math.cos(a), math.sin(a), 0.0])
                            ex = e0 - ez * float(e0 @ ez)
                            ex /= np.linalg.norm(ex)
                            frame = np.stack([ex, np.cross(ez, ex), ez])
            if frame is None:
                a = math.radians(r_deg)
                frame = np.array([[math.cos(a), math.sin(a), 0.0], [-math.sin(a), math.cos(a), 0.0], [0.0, 0.0, 1.0]])
            else:
                framed = True
            xs.append(x); ys.append(y); zs.append(z)
            rot.append(r_deg); frames.append(frame)
            # A fitting flush with a flat ceiling still sends its upward light (a batten's up-light) to
            # the ceiling: it leaves just below it, as under a section — `lift`, used for ceiling points only.
            flush = self.ceil is None and mount in ("recessed", "surface")
            lift.append(_FLUSH_LIFT if flush else 0.0)
            near.append(self.ceil is not None or flush or mount in ("pendant", "wall"))
            sc.append((lm / w.lumens) * flux_pct / 100.0)
            wt.append(watts * flux_pct / 100.0)
            pid.append(p); ids.append(it.get("id"))
            area.append(_f(getattr(w, "luminous_m2", 0.0), 0.0))
        return {"x": np.array(xs), "y": np.array(ys), "z": np.array(zs), "rot": np.array(rot),
                "scale": np.array(sc), "watts": np.array(wt), "web": np.array(pid, dtype=object),
                "id": ids, "area": np.array(area), "n": len(xs),
                "frame": np.array(frames).reshape(-1, 3, 3), "framed": framed, "near": np.array(near, bool),
                "lift": np.array(lift, float)}


_FLUSH_LIFT = 0.05                              # m below a flat ceiling that a flush fitting's up-light leaves


# ─── Obstacles ──────────────────────────────────────────────────────────

class _Box:
    """A box on the plan: centre (cx, cy), w along its own x (turned `rot`°
    counter-clockwise), d along its y, from z0 to z0 + h."""

    def __init__(self, o: dict):
        self.id = o.get("id")
        self.cx, self.cy = _f(o.get("cx"), math.nan), _f(o.get("cy"), math.nan)
        self.hw = max(_f(o.get("w"), 0.0), 0.0) / 2.0
        self.hd = max(_f(o.get("d"), 0.0), 0.0) / 2.0
        self.z0 = max(_f(o.get("z0"), 0.0), 0.0)
        self.z1 = self.z0 + max(_f(o.get("h"), 0.0), 0.0)
        a = math.radians(_f(o.get("rot"), 0.0))
        self.c, self.s = math.cos(a), math.sin(a)
        self.rho = min(max(_f(o.get("rho"), 0.5), 0.0), 0.99)
        self.ok = (math.isfinite(self.cx) and math.isfinite(self.cy) and self.hw > 1e-3 and self.hd > 1e-3
                   and self.z1 - self.z0 > 1e-3)

    def local(self, x, y):
        dx, dy = x - self.cx, y - self.cy
        return dx * self.c + dy * self.s, -dx * self.s + dy * self.c

    def world(self, u, v):
        return self.cx + u * self.c - v * self.s, self.cy + u * self.s + v * self.c

    def contains(self, x, y, z, pad=0.0):
        u, v = self.local(x, y)
        return ((np.abs(u) < self.hw - pad) & (np.abs(v) < self.hd - pad)
                & (z > self.z0 + pad) & (z < self.z1 - pad))

    def covers(self, x, y):
        u, v = self.local(x, y)
        return (np.abs(u) < self.hw) & (np.abs(v) < self.hd)


def _seg_box(b: _Box, ax, ay, az, bx, by, bz):
    """The segment A→B passes through the inside of box b (arrays broadcast)."""
    pu, pv = b.local(ax, ay)
    qu, qv = b.local(bx, by)
    t0 = np.zeros(np.broadcast(pu, qu, az, bz).shape)
    t1 = np.ones(t0.shape)
    for p, q, lo, hi in ((pu, qu, -b.hw, b.hw), (pv, qv, -b.hd, b.hd), (az, bz, b.z0, b.z1)):
        d = q - p
        par = np.abs(d) < 1e-12
        with np.errstate(divide="ignore", invalid="ignore"):
            ta = (lo - p) / d
            tb = (hi - p) / d
        inside = (p > lo) & (p < hi)
        tmin = np.where(par, np.where(inside, -np.inf, np.inf), np.minimum(ta, tb))
        tmax = np.where(par, np.where(inside, np.inf, -np.inf), np.maximum(ta, tb))
        t0 = np.maximum(t0, tmin)
        t1 = np.minimum(t1, tmax)
    return (t1 - t0) > 1e-6


def _blocked(room, ax, ay, az, bx, by, bz):
    """Any blocking obstacle of the room on the segment A→B. Only the segments
    whose bounding box meets a box's bounding box are traced through it."""
    ax, ay, az, bx, by, bz = np.broadcast_arrays(ax, ay, az, bx, by, bz)
    shape = ax.shape
    ax, ay, az, bx, by, bz = (a.ravel() for a in (ax, ay, az, bx, by, bz))
    lox, hix = np.minimum(ax, bx), np.maximum(ax, bx)
    loy, hiy = np.minimum(ay, by), np.maximum(ay, by)
    loz, hiz = np.minimum(az, bz), np.maximum(az, bz)
    out = np.zeros(ax.shape, bool)
    for b in room.boxes:
        r = abs(b.hw * b.c) + abs(b.hd * b.s), abs(b.hw * b.s) + abs(b.hd * b.c)
        cand = ((hiz > b.z0) & (loz < b.z1) & (hix > b.cx - r[0]) & (lox < b.cx + r[0])
                & (hiy > b.cy - r[1]) & (loy < b.cy + r[1]) & ~out)
        k = np.flatnonzero(cand)
        if len(k):
            out[k] = _seg_box(b, ax[k], ay[k], az[k], bx[k], by[k], bz[k])
    return out.reshape(shape)


def _in_boxes(room, x, y, z):
    m = np.zeros(np.shape(x), bool)
    for b in room.boxes:
        m |= b.contains(x, y, z)
    return m


# ─── Direct light ───────────────────────────────────────────────────────

def _intensity(webs, lum, c_deg, g_deg):
    """Candela [n, M] towards the direction given by (C, γ) arrays [n, M]."""
    out = np.zeros(c_deg.shape)
    for pid in set(lum["web"].tolist()):
        m = lum["web"] == pid
        out[:, m] = webs[pid].intensity(c_deg[:, m], g_deg[:, m])
    return out * lum["scale"][None, :]


def _cg(lum, vx, vy, vz, d):
    """C and γ (degrees) of the directions (vx, vy, vz) [n, M] from each luminaire,
    in its own photometric frame (C0 along its x, γ from its nadir)."""
    if not lum["framed"]:
        g = np.degrees(np.arccos(np.clip(-vz / d, -1, 1)))
        c = np.degrees(np.arctan2(vy, vx)) - lum["rot"][None, :]
        return c, g
    F = lum["frame"]
    u = vx * F[None, :, 0, 0] + vy * F[None, :, 0, 1] + vz * F[None, :, 0, 2]
    v = vx * F[None, :, 1, 0] + vy * F[None, :, 1, 1] + vz * F[None, :, 1, 2]
    w = vx * F[None, :, 2, 0] + vy * F[None, :, 2, 1] + vz * F[None, :, 2, 2]
    return np.degrees(np.arctan2(v, u)), np.degrees(np.arccos(np.clip(-w / d, -1, 1)))


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
        zl = lum["z"][None, :] - np.where(np.abs(p[:, 2:3] - room.H) < 1e-6, lum.get("lift", 0.0 * lum["z"])[None, :], 0.0)
        vz = p[:, 2:3] - zl
        d = np.sqrt(vx * vx + vy * vy + vz * vz)
        d = np.maximum(d, 1e-6)
        c, g = _cg(lum, vx, vy, vz, d)
        I = _intensity(webs, lum, c, g)
        cos_p = -(q[:, 0:1] * vx + q[:, 1:2] * vy + q[:, 2:3] * vz) / d
        e = np.where(cos_p > 1e-9, I * cos_p / (d * d), 0.0)
        if not room.convex:
            vis = _clear(room.P, p[:, 0:1], p[:, 1:2], lum["x"][None, :], lum["y"][None, :])
            e = np.where(vis, e, 0.0)
        if room.boxes:
            pe = p + q * 1e-3
            blk = _blocked(room, pe[:, 0:1], pe[:, 1:2], pe[:, 2:3], lum["x"][None, :], lum["y"][None, :], lum["z"][None, :])
            e = np.where(blk, 0.0, e)
        if room.ceil is not None and not room.ceil.concave:
            pe = p + q * 1e-3
            e = np.where(_under(room, pe[:, 0:1], pe[:, 1:2], pe[:, 2:3], lum["x"][None, :], lum["y"][None, :], lum["z"][None, :]), e, 0.0)
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
    hx, hy = (room.xmax - room.xmin) / nx / 2.0, (room.ymax - room.ymin) / ny / 2.0
    pos, nrm, area, rho, kind, du, dv, src = [], [], [], [], [], [], [], []

    def add(p, n, a, r, k, u, v, o=-1, du_dv=None):
        m = len(p)
        pos.append(p); nrm.append(np.tile(n, (m, 1)) if np.ndim(n) == 1 else n)
        area.append(np.full(m, a) if np.ndim(a) == 0 else a)
        rho.append(np.full(m, r) if np.ndim(r) == 0 else r)
        kind.append(np.full(m, k))
        if du_dv is not None:
            du.append(du_dv[0]); dv.append(du_dv[1])
        else:
            du.append(np.tile(u, (m, 1)) if np.ndim(u) == 1 else u); dv.append(np.tile(v, (m, 1)) if np.ndim(v) == 1 else v)
        src.append(np.full(m, o))

    for z, nz, r, k in ((0.0, 1.0, room.rho["f"], 0), (room.H, -1.0, room.rho["c"], 1)):
        keep = np.ones(len(X), bool)
        Hc = _height_at(room, X, Y)
        for b in room.boxes:                # floor under a box standing on it, ceiling above one reaching it
            if k == 0 and b.z0 < 0.01:
                keep &= ~b.covers(X, Y)
            elif k == 1:
                keep &= ~(b.covers(X, Y) & (b.z1 > Hc - 0.01))
        if not keep.any():
            keep[0] = True
        if k == 1 and room.ceil is not None:     # tilted patches: true area, own normal
            Xk, Yk = X[keep], Y[keep]
            sl = np.atleast_1d(room.ceil.slope(Xk, Yk))
            g = np.sqrt(1.0 + sl * sl)
            add(np.stack([Xk, Yk, room.ceil.height(Xk, Yk)], axis=1), room.ceil.normal(Xk, Yk), cell_a * g, r, k,
                None, None, du_dv=(
                    np.stack([np.full(len(sl), hx), np.zeros(len(sl)), hx * sl * room.ceil.ux], axis=1),
                    np.stack([np.zeros(len(sl)), np.full(len(sl), hy), hy * sl * room.ceil.uy], axis=1)))
            continue
        add(np.stack([X[keep], Y[keep], np.full(int(keep.sum()), z)], axis=1), [0.0, 0.0, nz], cell_a, r, k,
            [hx, 0.0, 0.0], [0.0, hy, 0.0])
    if room.ceil is not None:
        _step_patches(room, cs, add)
    ws = cs * 1.5
    nv = max(int(math.ceil(room.H / ws)), 2)
    n = len(room.P)
    zs = (np.arange(nv) + 0.5) / nv * room.H
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
        if room.ceil is None:
            PX = np.repeat(px, nv); PY = np.repeat(py, nv); PZ = np.tile(zs, ns)
            TT = np.repeat(t * L, nv)
            HZ = np.full(len(PX), room.H / nv / 2.0)
        else:                               # each column of the wall up to the ceiling above it
            top = room.ceil.height(px + inx * 1e-3, py + iny * 1e-3)
            cols = [max(int(math.ceil(h / ws)), 2) for h in top]
            PX = np.concatenate([np.full(c, x) for c, x in zip(cols, px)])
            PY = np.concatenate([np.full(c, y) for c, y in zip(cols, py)])
            PZ = np.concatenate([(np.arange(c) + 0.5) / c * h for c, h in zip(cols, top)])
            TT = np.concatenate([np.full(c, tt * L) for c, tt in zip(cols, t)])
            HZ = np.concatenate([np.full(c, h / c / 2.0) for c, h in zip(cols, top)])
        r = np.full(len(PX), room.rho["w"])
        if room.openings:
            r = _opening_rho(room, r, p0, ex, ey, L, TT, PZ, L / ns / 2.0, HZ)
        keep = np.ones(len(PX), bool)
        if room.boxes:                      # a box pushed against the wall hides that piece of it
            keep = ~_in_boxes(room, PX + inx * 1e-2, PY + iny * 1e-2, PZ)
            if not keep.any():
                keep[0] = True
        m = int(keep.sum())
        add(np.stack([PX[keep], PY[keep], PZ[keep]], axis=1), [inx, iny, 0.0], (L / ns) * 2.0 * HZ[keep], r[keep], 2,
            np.tile([ex * L / ns / 2.0, ey * L / ns / 2.0, 0.0], (m, 1)),
            np.stack([np.zeros(m), np.zeros(m), HZ[keep]], axis=1))
    for bi, b in enumerate(room.boxes):
        _box_patches(room, b, bi, cs, add)
    pos = np.vstack(pos); nrm = np.vstack(nrm)
    area = np.concatenate(area); rho = np.concatenate(rho); kind = np.concatenate(kind)
    du = np.vstack(du); dv = np.vstack(dv); src = np.concatenate(src)
    if len(pos) > MAX_PATCHES:
        room.warnings.append(f"{len(pos)} surface patches — coarse mesh recommended for a room this large")
    return pos, nrm, area, rho, kind, du, dv, src


def _opening_rho(room, r, p0, ex, ey, L, t, z, ht, hz):
    """Wall reflectance with the windows and doors on this wall laid over it,
    weighted by how much of each patch they cover."""
    cover = np.zeros(len(r))
    rho_open = np.zeros(len(r))
    for o in room.openings:
        try:
            ax, ay = float(o["a"][0]), float(o["a"][1])
            bx, by = float(o["b"][0]), float(o["b"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        # both ends on this wall's line (within 10 cm)
        na = abs((ax - p0[0]) * ey - (ay - p0[1]) * ex)
        nb = abs((bx - p0[0]) * ey - (by - p0[1]) * ex)
        if na > 0.1 or nb > 0.1:
            continue
        ta = (ax - p0[0]) * ex + (ay - p0[1]) * ey
        tb = (bx - p0[0]) * ex + (by - p0[1]) * ey
        t0, t1 = max(min(ta, tb), 0.0), min(max(ta, tb), L)
        if t1 - t0 < 1e-3:
            continue
        z0 = max(_f(o.get("sill"), 0.0), 0.0)
        z1 = min(z0 + max(_f(o.get("h"), 0.0), 0.0), room.H)
        ro = min(max(_f(o.get("rho"), 0.1 if o.get("kind") == "window" else 0.4), 0.0), 0.99)
        ov = (np.clip(np.minimum(t + ht, t1) - np.maximum(t - ht, t0), 0.0, None)
              * np.clip(np.minimum(z + hz, z1) - np.maximum(z - hz, z0), 0.0, None)) / (4.0 * ht * hz)
        ov = np.minimum(ov, 1.0 - cover)
        rho_open += ov * ro
        cover += ov
    return r * (1.0 - cover) + rho_open


def _box_patches(room, b: _Box, bi, cs, add):
    """Patches on the faces of one box (its base only when lifted, its top only
    when below the ceiling); faces outside the outline are left out."""
    def grid(n_u, n_v):
        u = (np.arange(n_u) + 0.5) / n_u * 2.0 - 1.0
        v = (np.arange(n_v) + 0.5) / n_v * 2.0 - 1.0
        U, V = np.meshgrid(u, v)
        return U.ravel(), V.ravel()

    ux = np.array([b.c, b.s, 0.0]); uy = np.array([-b.s, b.c, 0.0]); uz = np.array([0.0, 0.0, 1.0])
    hz = (b.z1 - b.z0) / 2.0
    ctr = np.array([b.cx, b.cy, b.z0 + hz])
    faces = []
    if b.z1 < float(_height_at(room, np.array([b.cx]), np.array([b.cy]))[0]) - 0.01:
        faces.append((ctr + uz * hz, uz, ux * b.hw, uy * b.hd))
    if b.z0 > 0.01:
        faces.append((ctr - uz * hz, -uz, ux * b.hw, uy * b.hd))
    faces += [(ctr + ux * b.hw, ux, uy * b.hd, uz * hz), (ctr - ux * b.hw, -ux, uy * b.hd, uz * hz),
              (ctr + uy * b.hd, uy, ux * b.hw, uz * hz), (ctr - uy * b.hd, -uy, ux * b.hw, uz * hz)]
    for c, n, eu, ev in faces:
        lu, lv = float(np.linalg.norm(eu)) * 2.0, float(np.linalg.norm(ev)) * 2.0
        n_u, n_v = max(int(math.ceil(lu / cs)), 1), max(int(math.ceil(lv / cs)), 1)
        U, V = grid(n_u, n_v)
        P = c[None, :] + U[:, None] * eu[None, :] + V[:, None] * ev[None, :]
        q = P + n[None, :] * 1e-2
        keep = _pip(room.P, q[:, 0], q[:, 1]) & (q[:, 2] > 0.0) & (q[:, 2] < _height_at(room, q[:, 0], q[:, 1]))
        if not keep.any():
            continue
        add(P[keep], n, (lu / n_u) * (lv / n_v), b.rho, 3, eu / n_u, ev / n_v, bi)


def _chords(P, ux, uy, s_abs):
    """Pieces of the plan line p·u = s_abs that lie inside the outline: [(a, b)] points."""
    vx, vy = -uy, ux
    hits = []
    n = len(P)
    for i in range(n):
        (x1, y1), (x2, y2) = P[i], P[(i + 1) % n]
        f1, f2 = x1 * ux + y1 * uy - s_abs, x2 * ux + y2 * uy - s_abs
        if (f1 > 0) != (f2 > 0):
            t = f1 / (f1 - f2)
            hits.append((x1 + t * (x2 - x1), y1 + t * (y2 - y1)))
    hits.sort(key=lambda q: q[0] * vx + q[1] * vy)
    out = []
    for i in range(0, len(hits) - 1):
        a, b = hits[i], hits[i + 1]
        mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
        if bool(_pip(P, np.array([mx]), np.array([my]))[0]):
            out.append((a, b))
    return out


def _step_patches(room, cs, add):
    """The vertical faces of the ceiling's steps, across the room, facing into the higher part."""
    c = room.ceil
    for sk, z_lo_side, z_hi_side in c.steps:
        z0, z1 = min(z_lo_side, z_hi_side), max(z_lo_side, z_hi_side)
        sgn = 1.0 if z_hi_side > z_lo_side else -1.0           # faces the high side: +u when the ceiling rises going +s
        n = np.array([sgn * c.ux, sgn * c.uy, 0.0])
        for (ax, ay), (bx, by) in _chords(room.P, c.ux, c.uy, sk + c.s0):
            L = math.hypot(bx - ax, by - ay)
            if L < 1e-6:
                continue
            ns = max(int(math.ceil(L / (cs * 1.5))), 1)
            nv = max(int(math.ceil((z1 - z0) / (cs * 1.5))), 1)
            t = (np.arange(ns) + 0.5) / ns
            zs = z0 + (np.arange(nv) + 0.5) / nv * (z1 - z0)
            PX = np.repeat(ax + t * (bx - ax), nv) + n[0] * 1e-4
            PY = np.repeat(ay + t * (by - ay), nv) + n[1] * 1e-4
            PZ = np.tile(zs, ns)
            ex, ey = (bx - ax) / L, (by - ay) / L
            add(np.stack([PX, PY, PZ], axis=1), n, (L / ns) * ((z1 - z0) / nv), room.rho["c"], 1,
                [ex * L / ns / 2.0, ey * L / ns / 2.0, 0.0], [0.0, 0.0, (z1 - z0) / nv / 2.0])


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
        if room.boxes:
            pe = pos + nrm * 1e-3
            blk = _blocked(room, pe[i, None, 0], pe[i, None, 1], pe[i, None, 2], pe[None, :, 0], pe[None, :, 1], pe[None, :, 2])
            k = np.where(blk, 0.0, k)
        if room.ceil is not None and not room.ceil.concave:
            pe = pos + nrm * 1e-3
            k = np.where(_under(room, pe[i, None, 0], pe[i, None, 1], pe[i, None, 2], pe[None, :, 0], pe[None, :, 1], pe[None, :, 2]), k, 0.0)
        K[i] = k
    np.fill_diagonal(K, 0.0)
    K = 0.5 * (K + K.T)
    x = np.ones(N)
    for _ in range(60):                                   # symmetric matrix balancing
        Kx = K @ x
        x = np.sqrt(x * area / np.maximum(Kx, 1e-18))
    F = (x[:, None] * K * x[None, :]) / area[:, None]
    return F


def _lum_subset(lum, idx):
    out = dict(lum)
    for k in ("x", "y", "z", "rot", "scale", "watts", "web", "area", "frame", "lift"):
        out[k] = lum[k][idx]
    out["id"] = [lum["id"][i] for i in idx]
    out["n"] = len(idx)
    return out


def _near_field(room, webs, pos, nrm, du, dv, Ed):
    """Direct light on the patches close to a wall, pendant or sloped-ceiling
    fitting, integrated over sub-samples of each patch instead of its centre:
    a fitting a few centimetres from a surface would otherwise light that
    surface's patches by their centre point alone."""
    lum = room.lum
    if not lum["n"] or not lum["near"].any() or room.detail == "fast":   # the layout screen stays quick
        return Ed
    half = np.sqrt((du * du).sum(axis=1) + (dv * dv).sum(axis=1))      # patch half-diagonal
    Ed = Ed.copy()
    full = room.lum
    for j in np.flatnonzero(lum["near"]):
        L = np.array([lum["x"][j], lum["y"][j], lum["z"][j] - (lum["lift"][j] if "lift" in lum else 0.0)])
        d = np.sqrt(((pos - L[None, :]) ** 2).sum(axis=1))
        close = np.flatnonzero(d < 6.0 * half)
        if not len(close):
            continue
        one = _lum_subset(full, [j])
        room.lum = one
        try:
            centre = _direct(room, webs, pos[close], nrm[close])
            ns = np.clip(np.ceil(8.0 * half[close] / np.maximum(d[close], 0.02)), 3, 16).astype(int)
            for n in np.unique(ns):
                k = close[ns == n]
                a = (np.arange(n) + 0.5) / n * 2.0 - 1.0
                U, V = (g.ravel() for g in np.meshgrid(a, a))
                sub_p = (pos[k][:, None, :] + U[None, :, None] * du[k][:, None, :] + V[None, :, None] * dv[k][:, None, :]).reshape(-1, 3)
                sub_n = np.repeat(nrm[k], len(U), axis=0)
                acc = _direct(room, webs, sub_p, sub_n).reshape(len(k), len(U)).mean(axis=1)
                Ed[k] += acc - centre[ns == n]
        finally:
            room.lum = full
    return Ed


def _solve(room, webs):
    pos, nrm, area, rho, kind, du, dv, src = _patches(room)
    Ed = _direct(room, webs, pos, nrm)
    Ed = _near_field(room, webs, pos, nrm, du, dv, Ed)
    F = _balanced_form_factors(room, pos, nrm, area)
    N = len(pos)
    B = np.linalg.solve(np.eye(N) - rho[:, None] * F, rho * Ed)
    E_tot = Ed + F @ B
    return {"pos": pos, "nrm": nrm, "area": area, "rho": rho, "kind": kind, "Ed": Ed, "B": B, "E": E_tot, "F": F,
            "du": du, "dv": dv, "src": src}


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
        if room.boxes:
            pe = p + q * 1e-3
            qe = pos + pn * 1e-3
            blk = _blocked(room, pe[:, None, 0], pe[:, None, 1], pe[:, None, 2], qe[None, :, 0], qe[None, :, 1], qe[None, :, 2])
            e = np.where(blk, 0.0, e)
        if room.ceil is not None and not room.ceil.concave:
            pe = p + q * 1e-3
            qe = pos + pn * 1e-3
            e = np.where(_under(room, pe[:, None, 0], pe[:, None, 1], pe[:, None, 2], qe[None, :, 0], qe[None, :, 1], qe[None, :, 2]), e, 0.0)
        out[s:s + chunk] = e.sum(axis=1)
    return out


# ─── Work-plane grid, cylindrical, UGR ──────────────────────────────────

def _en_max_step(room):
    d = max(room.xmax - room.xmin, room.ymax - room.ymin)
    return 0.2 * 5.0 ** math.log10(max(d, 1.0))            # EN 12464-1 maximum grid size


def _grid_step(room, detail):
    # A grid size the user set is used as given on a full calculation; the
    # layout screen ("fast") never goes finer than the automatic grid.
    if room.gridStep > 0 and detail != "fast":
        return float(np.clip(room.gridStep, 0.05, 5.0))
    step = min(_en_max_step(room), 0.5 if detail != "fast" else 1.0)
    return float(np.clip(step, 0.1, 2.0))


def _grid_notes(asked, used, en_max, notes):
    """Say when the grid differs from what was asked, or is coarser than EN 12464-1 allows."""
    if asked > 0 and used > asked * 1.001:
        notes.append(f"Grid {asked:g} m would need more than 9000 points here — calculated at {used:.2f} m")
    if used > en_max * 1.001:
        notes.append(f"Grid {used:.2f} m is coarser than the EN 12464-1 maximum of {en_max:.2f} m for this size")


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
    if room.boxes:
        use &= ~_blocked(room, np.array(ox), np.array(oy), np.array(EYE_H), lum["x"], lum["y"], lum["z"])
        if not use.any():
            return None
    if room.ceil is not None and not room.ceil.concave:
        use &= _under(room, np.array(ox), np.array(oy), np.array(EYE_H), lum["x"], lum["y"], lum["z"])
        if not use.any():
            return None
    dd = np.maximum(d, 1e-6)
    # candela from the luminaire towards the eye
    c, g = _cg(lum, -dx[None, :], -dy[None, :], -dz[None, :], dd[None, :])
    c, g = c[0], g[0]
    I = _intensity(webs, lum, c[None, :], g[None, :])[0]
    area = np.where(lum["area"] > 0, lum["area"], 0.09)
    # luminous area seen from the eye: cos of the angle off the luminaire's own axis
    cos_axis = np.cos(np.radians(g)) if lum["framed"] else dz / dd
    a_proj = area * np.maximum(cos_axis, 0.1)
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
    n_hidden = 0
    if room.boxes:                       # points inside furniture are not on the work plane
        hid = inside & _in_boxes(room, flat_x, flat_y, np.full(len(flat_x), room.workH))
        n_hidden = int(hid.sum())
        inside &= ~hid
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
    if room.ceil is not None:
        res["ceilingHeight"] = {"min": round(room.Hmin, 3), "max": round(room.H, 3)}
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
    if room.detail != "fast":
        _grid_notes(room.gridStep, step, _en_max_step(room), res["notes"])
    if n_hidden:
        res["notes"].append(f"{n_hidden} work-plane point{'s' if n_hidden != 1 else ''} inside objects left out")
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
        if room.boxes:
            idx = idx[~_in_boxes(room, pts[idx, 0], pts[idx, 1], np.full(len(idx), CYL_H))]
        cp = np.stack([pts[idx, 0], pts[idx, 1], np.full(len(idx), CYL_H)], axis=1)
        tot = np.zeros(len(idx))
        for k in range(8):
            a = math.radians(k * 45.0)
            nv = np.tile([math.cos(a), math.sin(a), 0.0], (len(idx), 1))
            ev = _direct(room, webs, cp, nv) + _indirect(room, S, cp, nv)
            tot += np.maximum(ev, 0.0)
        ezp = tot / 8.0 * room.mf
        ez = {"Ez": round(float(ezp.mean()), 1), "Ezmin": round(float(ezp.min()), 1)} if len(idx) else None
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
    if room.surfaces:
        res["surfaces"] = [x for x in (_surface(room, webs, S, o) for o in room.surfaces) if x]
        for x in res["surfaces"]:
            if x.get("pass") is not None:
                checks.append(_chk("surf:" + str(x["id"]), f"Ē {x['name']}", x["Em"], x["target"], ">=", "lx"))
        known = [c for c in checks if c["pass"] is not None]
        res["pass"] = (all(c["pass"] for c in known) if known and room.lum["n"] else None)
    if room.want_patches:
        E = S["E"] * room.mf
        r3 = lambda a: np.round(a, 3).tolist()
        res["patches"] = {"c": r3(S["pos"]), "u": r3(S["du"]), "v": r3(S["dv"]), "E": np.round(E, 1).tolist(),
                          "rho": np.round(S["rho"], 3).tolist(), "kind": S["kind"].astype(int).tolist(),
                          "src": S["src"].astype(int).tolist()}
    res["ms"] = round((time.time() - t0) * 1000.0, 1)
    return res


def _surface(room, webs, S, o):
    """One calculation surface: grid, Ē, Emin, Emax, U₀ (maintained)."""
    cx, cy = _f(o.get("cx"), math.nan), _f(o.get("cy"), math.nan)
    w, d = max(_f(o.get("w"), 0.0), 0.0), max(_f(o.get("d"), 0.0), 0.0)
    face = o.get("face") if o.get("face") in ("up", "down", "vertical") else "up"
    z = _f(o.get("z"), room.workH)
    hgt = max(_f(o.get("h"), d), 0.0) if face == "vertical" else 0.0
    if not (math.isfinite(cx) and math.isfinite(cy)) or w < 0.02 or (d < 0.02 if face != "vertical" else hgt < 0.02):
        return None
    a = math.radians(_f(o.get("rot"), 0.0))
    ex = np.array([math.cos(a), math.sin(a), 0.0])
    if face == "vertical":
        ev, lu, lv = np.array([0.0, 0.0, 1.0]), w, hgt
        nrm = np.array([-math.sin(a), math.cos(a), 0.0])        # faces the left of its x axis
        org = np.array([cx, cy, z]) - ex * w / 2.0
    else:
        ev, lu, lv = np.array([-math.sin(a), math.cos(a), 0.0]), w, d
        nrm = np.array([0.0, 0.0, 1.0 if face == "up" else -1.0])
        org = np.array([cx, cy, z]) - ex * w / 2.0 - ev * d / 2.0
    step = _f(o.get("grid"), 0.0)
    if step <= 0:
        step = float(np.clip(0.2 * 5.0 ** math.log10(max(lu, lv, 1e-3)), 0.05, 0.5))
    nu = int(min(max(math.ceil(lu / step), 1), 60))
    nv = int(min(max(math.ceil(lv / step), 1), 60))
    U = (np.arange(nu) + 0.5) / nu * lu
    V = (np.arange(nv) + 0.5) / nv * lv
    UU, VV = np.meshgrid(U, V)
    P = org[None, :] + UU.ravel()[:, None] * ex[None, :] + VV.ravel()[:, None] * ev[None, :]
    ok = _pip(room.P, P[:, 0], P[:, 1]) & (P[:, 2] >= 0.0) & (P[:, 2] <= _height_at(room, P[:, 0], P[:, 1]))
    if room.boxes:
        ok &= ~_in_boxes(room, P[:, 0], P[:, 1], P[:, 2])
    vals = np.full(len(P), np.nan)
    if ok.any():
        Q = P[ok]
        nn = np.tile(nrm, (len(Q), 1))
        vals[ok] = (_direct(room, webs, Q, nn) + _indirect(room, S, Q, nn)) * room.mf
    good = vals[np.isfinite(vals)]
    target = _f(o.get("target"), 0.0)
    out = {"id": o.get("id"), "name": o.get("name") or "Surface", "face": face, "n": int(len(good)),
           "nu": nu, "nv": nv, "values": [None if not math.isfinite(v) else round(float(v), 1) for v in vals],
           "target": target if target > 0 else None}
    if len(good):
        em = float(good.mean())
        out.update({"Em": round(em, 1), "Emin": round(float(good.min()), 1), "Emax": round(float(good.max()), 1),
                    "U0": round(float(good.min() / em), 3) if em > 0 else 0.0})
    else:
        out.update({"Em": 0.0, "Emin": 0.0, "Emax": 0.0, "U0": 0.0})
    out["pass"] = (out["Em"] >= target - 1e-9) if (target > 0 and len(good) and room.lum["n"]) else None
    return out


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


def _lattices(room: _Room, n_seed: int, angles, hi: float = 2.2, lo: float = 0.45):
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
                if n < 1 or n > max(hi * n_seed, n_seed + 4) or n < lo * n_seed:
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
    h_ceil = room0.H if room0.ceil is None else float(_height_at(room0, room0.P[:, 0], room0.P[:, 1]).mean() + room0.H) / 2.0
    hm = max(h_ceil - room0.workH - (drop if mount == "suspended" else 0.0), 0.5)
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
