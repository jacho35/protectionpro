"""Outdoor area lighting — car parks, yards, walkways and security perimeters.

Direct light only (an outdoor surface has no enclosure to interreflect with):

  • Areas — horizontal illuminance on the ground over a polygon:
    E = I(C, γ)·cos θ / d², maintained (× MF). Reports Ēm, Emin, Emax, U₀ and
    the glare rating GR of CIE 112:1994 at a grid of observers (eye 1.5 m,
    eight viewing directions): GR = 27 + 24·log10(Lvl / Lve^0.9) with the
    veiling luminance Lvl = 10·Σ E_eye,i / θ_i² (θ in degrees) and the
    environment's Lve = 0.035·Lav, Lav = ρ·Ēm/π.
  • Perimeters — vertical illuminance at the fence height (default 1.5 m) on a
    plane facing out of (or into) the site, every `step` metres along the line:
    Ev min / average and the ratio of the two.
  • Luminaires are poles / floodlights anywhere on the sheet — a pole outside the
    area still lights it. Each has a mounting height, a tilt towards its front
    and a heading; the photometric frame is the one road_lighting uses (C0
    along the luminaire's axis, C90 across it towards the front, γ from the
    tilted nadir).

Geometry: plan metres with y up; z up from the ground.

Request (camelCase): { luminaires:[{ id, x, y, h, rotate, tilt, photometryId,
fluxPct, lumens?, watts? }], areas:[{ id, name, polygon:[[x,y]…], mf, groundRho,
targets:{em,uo,gr} }], perimeters:[{ id, name, line:[[x,y]…], closed, side:
'out'|'in'|'left'|'right', height, step, mf, targets:{evMin, evRatio} }],
photometry:{id: web} }.
"""

from __future__ import annotations

import math
import time

import numpy as np

from .road_lighting import _Web
from .room_lighting import _pip, _dist_to_edges, _signed_area, _f, _chk

EYE_H = 1.5


class _Lums:
    def __init__(self, items, webs):
        xs, ys, zs, rot, tilt, sc, wt, pid, ids, area = [], [], [], [], [], [], [], [], [], []
        self.warnings = []
        for it in items or []:
            x, y = _f(it.get("x"), math.nan), _f(it.get("y"), math.nan)
            p = it.get("photometryId")
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            if p not in webs:
                self.warnings.append(f"Luminaire {it.get('id') or ''}: no photometry '{p}' — left out")
                continue
            w = webs[p]
            flux_pct = max(_f(it.get("fluxPct"), 100.0), 0.0)
            lm = _f(it.get("lumens"), 0.0) or w.lumens
            watts = _f(it.get("watts"), 0.0) or w.watts
            xs.append(x); ys.append(y); zs.append(max(_f(it.get("h"), 6.0), 0.5))
            rot.append(_f(it.get("rotate"), 0.0)); tilt.append(min(max(_f(it.get("tilt"), 0.0), -90.0), 90.0))
            sc.append((lm / w.lumens) * flux_pct / 100.0); wt.append(watts * flux_pct / 100.0)
            pid.append(p); ids.append(it.get("id")); area.append(_f(getattr(w, "luminous_m2", 0.0), 0.0))
        self.x, self.y, self.z = np.array(xs), np.array(ys), np.array(zs)
        self.rot, self.tilt = np.array(rot), np.array(tilt)
        self.scale, self.watts = np.array(sc), np.array(wt)
        self.web = np.array(pid, dtype=object)
        self.id, self.area, self.n = ids, np.array(area), len(xs)
        self.webs = webs

    def intensity(self, dx, dy, dz):
        """Candela from every luminaire along the direction (dx, dy, dz) [n, M]
        (luminaire → target), scaled by each luminaire's flux factor."""
        rot = np.radians(self.rot)[None, :]
        th = np.radians(self.tilt)[None, :]
        ex = (np.cos(rot), np.sin(rot))
        ey0 = (-np.sin(rot), np.cos(rot))
        ey = (ey0[0] * np.cos(th), ey0[1] * np.cos(th), np.sin(th))
        ez = (-ey0[0] * np.sin(th), -ey0[1] * np.sin(th), np.cos(th))
        u = dx * ex[0] + dy * ex[1]
        v = dx * ey[0] + dy * ey[1] + dz * ey[2]
        w = dx * ez[0] + dy * ez[1] + dz * ez[2]
        n = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-9)
        g = np.degrees(np.arccos(np.clip(-w / n, -1, 1)))
        c = np.degrees(np.arctan2(v, u))
        out = np.zeros(g.shape)
        for pid in set(self.web.tolist()):
            m = self.web == pid
            out[:, m] = self.webs[pid].intensity(c[:, m], g[:, m])
        return out * self.scale[None, :]

    def illuminance(self, pts, nrm, chunk=500):
        """Initial illuminance (lx) at points [n,3] on planes with unit normals [n,3]."""
        n = len(pts)
        E = np.zeros(n)
        if not self.n:
            return E
        for s in range(0, n, chunk):
            p, q = pts[s:s + chunk], nrm[s:s + chunk]
            dx = p[:, 0:1] - self.x[None, :]
            dy = p[:, 1:2] - self.y[None, :]
            dz = p[:, 2:3] - self.z[None, :]
            d = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
            I = self.intensity(dx, dy, dz)
            cos_p = -(q[:, 0:1] * dx + q[:, 1:2] * dy + q[:, 2:3] * dz) / d
            E[s:s + chunk] = np.where(cos_p > 1e-9, I * cos_p / (d * d), 0.0).sum(axis=1)
        return E


def _grid(P, step):
    xmin, ymin = P.min(axis=0)
    xmax, ymax = P.max(axis=0)
    nx = max(int(math.ceil((xmax - xmin) / step)), 1)
    ny = max(int(math.ceil((ymax - ymin) / step)), 1)
    while nx * ny > 9000:
        step *= 1.25
        nx = max(int(math.ceil((xmax - xmin) / step)), 1)
        ny = max(int(math.ceil((ymax - ymin) / step)), 1)
    xs = xmin + (np.arange(nx) + 0.5) * (xmax - xmin) / nx
    ys = ymin + (np.arange(ny) + 0.5) * (ymax - ymin) / ny
    X, Y = np.meshgrid(xs, ys)
    return X, Y, xs, ys, step


def evaluate_area(a: dict, lums: _Lums, with_gr: bool = True) -> dict:
    t0 = time.time()
    name = a.get("name") or "Area"
    P = np.array([(_f(p[0], 0.0), _f(p[1], 0.0)) for p in (a.get("polygon") or [])], float)
    if len(P) > 1 and np.allclose(P[0], P[-1]):
        P = P[:-1]
    if len(P) < 3 or abs(_signed_area(P)) < 1e-6:
        raise ValueError(f"{name}: an area needs an outline with at least 3 corners")
    area = abs(_signed_area(P))
    mf = min(max(_f(a.get("mf"), 0.8), 0.05), 1.0)
    d = max(np.ptp(P[:, 0]), np.ptp(P[:, 1]))
    step = float(np.clip(0.2 * 5.0 ** math.log10(max(d, 1.0)), 0.5, 2.0))
    X, Y, xs, ys, step = _grid(P, step)
    fx, fy = X.ravel(), Y.ravel()
    inside = _pip(P, fx, fy)
    pts = np.stack([fx[inside], fy[inside], np.zeros(int(inside.sum()))], axis=1)
    res = {"id": a.get("id"), "name": name, "area": round(area, 2), "luminaires": lums.n,
           "warnings": list(lums.warnings), "notes": []}
    if not lums.n:
        res["notes"].append("No luminaires on the sheet")
    E = lums.illuminance(pts, np.tile([0.0, 0.0, 1.0], (len(pts), 1))) * mf if len(pts) else np.array([])
    if len(E) and lums.n:
        em = float(E.mean())
        res["workplane"] = {"Em": round(em, 2), "Emin": round(float(E.min()), 2), "Emax": round(float(E.max()), 2),
                            "U0": round(float(E.min() / em), 3) if em > 0 else 0.0,
                            "Ud": round(float(E.min() / E.max()), 3) if E.max() > 0 else 0.0, "n": int(len(E)), "step": round(step, 3)}
    else:
        res["workplane"] = {"Em": 0.0, "Emin": 0.0, "Emax": 0.0, "U0": 0.0, "Ud": 0.0, "n": int(len(E)), "step": round(step, 3)}

    gr = None
    if with_gr and lums.n and len(E):
        em = res["workplane"]["Em"]
        rho = min(max(_f(a.get("groundRho"), 0.07), 0.01), 0.9)
        lve = max(0.035 * rho * em / math.pi, 1e-4)
        hm = float(lums.z.mean())
        so = float(np.clip(3.0 * hm, 4.0, 30.0))
        OX, OY, oxs, oys, so = _grid(P, so)
        ins = _pip(P, OX.ravel(), OY.ravel())
        obs = np.stack([OX.ravel()[ins], OY.ravel()[ins]], axis=1)
        if len(obs) > 150:
            obs = obs[np.linspace(0, len(obs) - 1, 150).astype(int)]
        worst, worst_at = None, None
        for ox, oy in obs:
            dx = lums.x - ox
            dy = lums.y - oy
            dz = lums.z - EYE_H
            dist = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
            # intensity from the luminaire towards the eye
            I = lums.intensity((-dx)[None, :], (-dy)[None, :], (-dz)[None, :])[0] * mf
            for k in range(8):
                a_v = math.radians(k * 45.0)
                vx, vy = math.cos(a_v), math.sin(a_v)
                cos_t = (dx * vx + dy * vy) / dist
                theta = np.degrees(np.arccos(np.clip(cos_t, -1, 1)))
                use = (cos_t > 0.0) & (theta <= 90.0)
                th = np.maximum(theta, 1.5)
                e_eye = np.where(use, I * np.clip(cos_t, 0, 1) / (dist * dist), 0.0)
                lvl = 10.0 * float((e_eye / (th * th)).sum())
                if lvl <= 0:
                    continue
                g = 27.0 + 24.0 * math.log10(lvl / lve ** 0.9)
                if worst is None or g > worst:
                    worst, worst_at = g, (float(ox), float(oy), k * 45.0)
        if worst is not None:
            gr = {"max": round(worst, 1), "at": {"x": round(worst_at[0], 2), "y": round(worst_at[1], 2), "dir": worst_at[2]},
                  "observers": int(len(obs)), "note": "CIE 112 worst observer, eye 1.5 m, eight directions, ground reflectance %.2f" % rho}
    res["gr"] = gr

    watts = float(lums.watts.sum()) if lums.n else 0.0
    em = res["workplane"]["Em"]
    res["power"] = {"watts": round(watts, 1), "wm2": round(watts / area, 3), "count": lums.n}
    tg = a.get("targets") or {}
    checks = []
    if tg.get("em") is not None:
        checks.append(_chk("em", "Ēm ground", res["workplane"]["Em"], _f(tg.get("em"), None), ">=", "lx"))
    if tg.get("uo") is not None:
        checks.append(_chk("uo", "U₀", res["workplane"]["U0"], _f(tg.get("uo"), None), ">=", ""))
    if tg.get("gr") is not None and gr:
        checks.append(_chk("gr", "GR", gr["max"], _f(tg.get("gr"), None), "<=", ""))
    res["checks"] = checks
    known = [c for c in checks if c["pass"] is not None]
    res["pass"] = (all(c["pass"] for c in known) if known and lums.n else None)
    if len(pts):
        vals = np.full(X.shape, np.nan)
        flat = vals.ravel()
        flat[np.flatnonzero(inside)] = E
        res["grid"] = {"x0": float(xs[0] - (xs[1] - xs[0]) / 2.0) if len(xs) > 1 else float(P[:, 0].min()),
                       "y0": float(ys[0] - (ys[1] - ys[0]) / 2.0) if len(ys) > 1 else float(P[:, 1].min()),
                       "dx": float(xs[1] - xs[0]) if len(xs) > 1 else float(np.ptp(P[:, 0])),
                       "dy": float(ys[1] - ys[0]) if len(ys) > 1 else float(np.ptp(P[:, 1])),
                       "nx": int(len(xs)), "ny": int(len(ys)),
                       "values": [None if not math.isfinite(v) else round(float(v), 2) for v in flat]}
    res["ms"] = round((time.time() - t0) * 1000.0, 1)
    return res


def evaluate_perimeter(p: dict, lums: _Lums) -> dict:
    name = p.get("name") or "Perimeter"
    L = np.array([(_f(q[0], 0.0), _f(q[1], 0.0)) for q in (p.get("line") or [])], float)
    closed = bool(p.get("closed"))
    if len(L) < 2:
        raise ValueError(f"{name}: a perimeter needs at least 2 points")
    side = str(p.get("side") or "out")
    if closed and len(L) >= 3 and _signed_area(L) < 0:
        L = L[::-1].copy()                      # counter-clockwise: the interior is on the left
    mf = min(max(_f(p.get("mf"), 0.8), 0.05), 1.0)
    h = min(max(_f(p.get("height"), 1.5), 0.0), 10.0)
    step = min(max(_f(p.get("step"), 1.0), 0.25), 10.0)
    segs = list(zip(L[:-1], L[1:])) + ([(L[-1], L[0])] if closed and len(L) >= 3 else [])
    pts, nrm, ss = [], [], []
    s0 = 0.0
    for a, b in segs:
        seg = b - a
        ln = float(np.hypot(*seg))
        if ln < 1e-9:
            continue
        t = seg / ln
        left = np.array([-t[1], t[0]])
        # closed ring: out = right of travel (interior left); open line: 'out' = right as well
        n = left if side in ("left", "in") else -left
        m = max(int(math.ceil(ln / step)), 1)
        for i in range(m):
            u = (i + 0.5) / m
            c = a + seg * u
            pts.append([c[0], c[1], h]); nrm.append([n[0], n[1], 0.0]); ss.append(s0 + u * ln)
        s0 += ln
    if not pts:
        raise ValueError(f"{name}: the line has no length")
    pts, nrm = np.array(pts), np.array(nrm)
    E = lums.illuminance(pts, nrm) * mf
    res = {"id": p.get("id"), "name": name, "length": round(s0, 2), "luminaires": lums.n,
           "warnings": list(lums.warnings), "notes": []}
    if not lums.n:
        res["notes"].append("No luminaires on the sheet")
    avg = float(E.mean())
    res["vertical"] = {"Evmin": round(float(E.min()), 2), "Evavg": round(avg, 2), "Evmax": round(float(E.max()), 2),
                       "ratio": round(float(E.min() / avg), 3) if avg > 0 else 0.0, "n": int(len(E)), "height": h, "step": step}
    res["profile"] = [{"s": round(float(s), 2), "x": round(float(q[0]), 3), "y": round(float(q[1]), 3), "E": round(float(e), 2)}
                      for s, q, e in zip(ss, pts, E)]
    tg = p.get("targets") or {}
    checks = []
    if tg.get("evMin") is not None:
        checks.append(_chk("evMin", "Ev min", res["vertical"]["Evmin"], _f(tg.get("evMin"), None), ">=", "lx"))
    if tg.get("evRatio") is not None:
        checks.append(_chk("evRatio", "Ev min / avg", res["vertical"]["ratio"], _f(tg.get("evRatio"), None), ">=", ""))
    res["checks"] = checks
    known = [c for c in checks if c["pass"] is not None]
    res["pass"] = (all(c["pass"] for c in known) if known and lums.n else None)
    return res


def run_area_lighting(req: dict) -> dict:
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    lums = _Lums(req.get("luminaires"), webs)
    areas, perims = [], []
    for a in (req.get("areas") or []):
        try:
            areas.append(evaluate_area(a, lums, with_gr=bool(req.get("gr", True))))
        except ValueError as e:
            areas.append({"id": a.get("id"), "name": a.get("name") or "Area", "error": str(e)})
    for p in (req.get("perimeters") or []):
        try:
            perims.append(evaluate_perimeter(p, lums))
        except ValueError as e:
            perims.append({"id": p.get("id"), "name": p.get("name") or "Perimeter", "error": str(e)})
    return {"areas": areas, "perimeters": perims}


# ─── Auto layout: poles to the area's targets ───────────────────────────

class _Outline:
    """Just enough of a room for room_lighting._lattices."""
    def __init__(self, P):
        self.P = P


def suggest_area_layout(req: dict) -> dict:
    """Propose pole grids for an area. req: { area, photometry, photometryId,
    h, tilt, fluxPct }. Each pole faces the area's centre. Ranked passing first,
    then fewest poles, then lowest power."""
    from .room_lighting import _lattices  # local import: keeps module load order simple
    t0 = time.time()
    pid = req.get("photometryId")
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    if pid not in webs:
        raise ValueError("Pick a luminaire for the layout")
    area = dict(req.get("area") or {})
    P = np.array([(_f(p[0], 0.0), _f(p[1], 0.0)) for p in (area.get("polygon") or [])], float)
    if len(P) > 1 and np.allclose(P[0], P[-1]):
        P = P[:-1]
    if len(P) < 3 or abs(_signed_area(P)) < 1e-6:
        raise ValueError("The area needs an outline with at least 3 corners")
    if _signed_area(P) < 0:
        P = P[::-1].copy()
    tg = area.get("targets") or {}
    if _f(tg.get("em"), 0.0) <= 0:
        raise ValueError("Set a target Ēm for the area first")
    h = max(_f(req.get("h"), 8.0), 3.0)
    tilt = _f(req.get("tilt"), 0.0)
    flux_pct = max(_f(req.get("fluxPct"), 100.0), 1.0)
    centre = P.mean(axis=0)
    outline = _Outline(P)

    def poles(pts):
        out = []
        for i, (x, y) in enumerate(pts):
            brg = math.degrees(math.atan2(centre[1] - y, centre[0] - x)) if math.hypot(centre[0] - x, centre[1] - y) > 0.5 else 90.0
            out.append({"id": f"s{i}", "x": float(x), "y": float(y), "h": h, "rotate": brg - 90.0, "tilt": tilt,
                        "photometryId": pid, "fluxPct": flux_pct})
        return out

    def shortfall(r):
        return sum(max(0.0, (k["req"] - k["value"]) / max(abs(k["req"]), 1e-9)) if k["op"] == ">=" else max(0.0, (k["value"] - k["req"]) / max(abs(k["req"]), 1e-9))
                   for k in r["checks"] if k["pass"] is False)

    def assess(pts):
        """Both headings — every pole facing the centre, and all alike — keep the better."""
        best = None
        for facing in (True, False):
            pl = poles(pts)
            if not facing:
                for q in pl:
                    q["rotate"] = 0.0
            lums = _Lums(pl, webs)
            r = evaluate_area(dict(area, polygon=P.tolist()), lums, with_gr=True)
            r.pop("grid", None)
            r["_poles"] = pl
            if best is None or (r["pass"] and not best["pass"]) or (not r["pass"] and not best["pass"] and shortfall(r) < shortfall(best)):
                best = r
        return best, None

    n_trial = max(int(math.ceil(float(abs(_signed_area(P))) / (4.0 * h) ** 2)), 1)
    trial = next(iter(_lattices(outline, n_trial, [0.0])), None)
    if trial is None:
        raise ValueError("No pole grid fits this outline")
    r_t, _ = assess(trial["pts"])
    em_t = r_t["workplane"]["Em"]
    if em_t <= 0:
        raise ValueError("The luminaire gives no light on the area")
    n_seed = max(int(round(len(trial["pts"]) * _f(tg.get("em"), 0.0) / em_t)), 1)
    # Uniformity, not Ēm, usually sets the pole count outdoors, so search a wide
    # range from the fewest poles upward and stop once a few layouts pass.
    base = max(n_seed, len(trial["pts"]))
    pool = _lattices(outline, base, [0.0], hi=6.0, lo=0.25)
    best_by_count = {}
    for c in pool:
        n = len(c["pts"])
        if n not in best_by_count or abs(math.log(c["sx"] / c["sy"])) < abs(math.log(best_by_count[n]["sx"] / best_by_count[n]["sy"])):
            best_by_count[n] = c
    cands = [best_by_count[n] for n in sorted(best_by_count)][:40]
    scored, passed = [], 0
    for c in cands:
        if time.time() - t0 > 14.0 or passed >= 3:
            break
        r, lums = assess(c["pts"])
        if r["pass"]:
            passed += 1
        scored.append({
            "rows": c["rows"], "cols": c["cols"], "count": len(c["pts"]),
            "spacingX": round(c["sx"], 2), "spacingY": round(c["sy"], 2), "mountH": h, "tilt": tilt,
            "luminaires": [{"x": round(l["x"], 3), "y": round(l["y"], 3), "rotate": round(l["rotate"], 2)} for l in r["_poles"]],
            "result": {"Em": r["workplane"]["Em"], "U0": r["workplane"]["U0"], "Emin": r["workplane"]["Emin"],
                       "gr": (r["gr"] or {}).get("max"), "wm2": r["power"]["wm2"], "watts": r["power"]["watts"],
                       "checks": r["checks"], "pass": r["pass"]},
        })
    if not scored:
        raise ValueError("No pole grid fits this outline")

    scored.sort(key=lambda s: (0 if s["result"]["pass"] else 1, s["count"] if s["result"]["pass"] else shortfall(s["result"]), s["result"]["watts"]))
    return {"seed": {"count": n_seed, "trialCount": len(trial["pts"]), "trialEm": em_t},
            "candidates": scored[:4], "evaluated": len(scored), "ms": round((time.time() - t0) * 1000.0)}
