"""Emergency lighting — floor illuminance from the luminaires in emergency mode,
judged against the EN 1838 / SANS 10114-2 criteria for the three kinds of area:

  • escape route — a centre line of width w (≤ 2 m): at least 1 lx on the centre
    line, 0.5 lx across the central band (the middle half of the width), and
    Emax / Emin ≤ 40 : 1 along the centre line;
  • open area (anti-panic, over 60 m²) — at least 0.5 lx over the floor with a
    0.5 m border left out, Emax / Emin ≤ 40 : 1;
  • high-risk task area — at least 10 % of the maintained task illuminance and
    never less than 15 lx, Emin / Emax ≥ 0.1.

Only direct light counts (no reflected component), on the floor, with each
luminaire at its emergency output. Obstruction: where a `bounds` polygon is
given (the room the item sits in) a luminaire only lights points it can see
inside that outline — it does not shine through walls. The limits are
provisional table values; confirm them against the standard you design to.

Request (camelCase): { items:[{ id, name, type:'route'|'open'|'highrisk',
line:[[x,y]…] + width (route) | polygon (open, highrisk), taskE (highrisk),
bounds?, mf, luminaires:[{ id, x, y, h, photometryId, emergPct, watts? }] }],
photometry:{id: web} }.
"""

from __future__ import annotations

import math

import numpy as np

from .road_lighting import _Web
from .room_lighting import _pip, _dist_to_edges, _signed_area, _f, _clear, _is_convex

ROUTE_CENTRE_LX = 1.0
ROUTE_BAND_LX = 0.5
OPEN_LX = 0.5
OPEN_BORDER = 0.5
RATIO_MAX = 40.0
HIGHRISK_FRAC = 0.10
HIGHRISK_MIN_LX = 15.0


def _floor_lx(webs, lums, pts, bounds, mf):
    """Direct illuminance on the floor [lx] at points [n,2], unit flux factor × emergency output."""
    n = len(pts)
    if not lums or n == 0:
        return np.zeros(n)
    x = np.array([l["x"] for l in lums]); y = np.array([l["y"] for l in lums]); h = np.array([max(l["h"], 0.3) for l in lums])
    sc = np.array([l["scale"] for l in lums])
    pid = np.array([l["photometryId"] for l in lums], dtype=object)
    E = np.zeros(n)
    for s in range(0, n, 500):
        p = pts[s:s + 500]
        dx = p[:, 0:1] - x[None, :]
        dy = p[:, 1:2] - y[None, :]
        dz = -np.broadcast_to(h[None, :], dx.shape)
        d = np.sqrt(dx * dx + dy * dy + dz * dz)
        g = np.degrees(np.arccos(np.clip(-dz / d, -1, 1)))
        c = np.degrees(np.arctan2(dy, dx))
        I = np.zeros(d.shape)
        for k in set(pid.tolist()):
            m = pid == k
            I[:, m] = webs[k].intensity(c[:, m], g[:, m])
        e = I * sc[None, :] * (np.broadcast_to(h[None, :], d.shape) / d) / (d * d)
        if bounds is not None:
            e = np.where(_clear(bounds, p[:, 0:1], p[:, 1:2], x[None, :], y[None, :]), e, 0.0)
        E[s:s + 500] = e.sum(axis=1)
    return E * mf


def _check(key, label, value, req, op, unit):
    if value is None:
        return {"key": key, "label": label, "value": None, "req": req, "op": op, "unit": unit, "pass": None}
    ok = (value >= req - 1e-9) if op == ">=" else (value <= req + 1e-9)
    return {"key": key, "label": label, "value": round(float(value), 3), "req": req, "op": op, "unit": unit, "pass": bool(ok)}


def _prep(it, webs):
    lums = []
    for l in it.get("luminaires") or []:
        p = l.get("photometryId")
        pct = max(_f(l.get("emergPct"), 0.0), 0.0)
        if p not in webs or pct <= 0:
            continue
        w = webs[p]
        lm = _f(l.get("lumens"), 0.0) or w.lumens
        lums.append({"x": _f(l.get("x"), 0.0), "y": _f(l.get("y"), 0.0), "h": _f(l.get("h"), 2.7), "photometryId": p,
                     "scale": (lm / w.lumens) * pct / 100.0, "id": l.get("id")})
    return lums


def evaluate_item(it: dict, webs: dict) -> dict:
    name = it.get("name") or "Emergency"
    typ = it.get("type")
    mf = min(max(_f(it.get("mf"), 0.8), 0.05), 1.0)
    lums = _prep(it, webs)
    bounds = None
    if it.get("bounds"):
        B = np.array([(_f(p[0], 0.0), _f(p[1], 0.0)) for p in it["bounds"]], float)
        if len(B) >= 3 and abs(_signed_area(B)) > 1e-6 and not _is_convex(B if _signed_area(B) > 0 else B[::-1]):
            bounds = B if _signed_area(B) > 0 else B[::-1].copy()
    res = {"id": it.get("id"), "name": name, "type": typ, "luminaires": len(lums), "notes": []}
    if not lums:
        res["notes"].append("No luminaires in emergency mode here — set an emergency output on the fittings")
    checks = []
    if typ == "route":
        L = np.array([(_f(p[0], 0.0), _f(p[1], 0.0)) for p in (it.get("line") or [])], float)
        if len(L) < 2:
            raise ValueError(f"{name}: a route needs at least 2 points")
        width = min(max(_f(it.get("width"), 1.2), 0.3), 20.0)
        if width > 2.0:
            res["notes"].append("Wider than 2 m: EN 1838 treats this as several 2 m strips or an open area")
        step = 0.5
        cl, bands, s_acc = [], [], []
        s0 = 0.0
        for k in range(len(L) - 1):
            a, b = L[k], L[k + 1]
            seg = b - a
            ln = float(np.hypot(*seg))
            if ln < 1e-9:
                continue
            t = seg / ln
            nrm = np.array([-t[1], t[0]])
            m = max(int(math.ceil(ln / step)), 1)
            for i in range(m + 1 if k == len(L) - 2 else m):
                u = i / m
                c = a + seg * u
                cl.append(c)
                s_acc.append(s0 + u * ln)
                for off in (-width / 4.0, width / 4.0):
                    bands.append(c + nrm * off)
            s0 += ln
        cl, bands = np.array(cl), np.array(bands)
        Ec = _floor_lx(webs, lums, cl, bounds, mf)
        Eb = _floor_lx(webs, lums, bands, bounds, mf)
        e_min, e_max = float(Ec.min()), float(Ec.max())
        res["centre"] = {"Emin": round(e_min, 3), "Emax": round(e_max, 3), "n": int(len(Ec))}
        res["band"] = {"Emin": round(float(min(Eb.min(), e_min)), 3)}
        ratio = (e_max / e_min) if e_min > 1e-9 else None
        res["ratio"] = None if ratio is None else round(ratio, 1)
        res["profile"] = [{"s": round(float(s), 2), "x": round(float(c[0]), 3), "y": round(float(c[1]), 3), "E": round(float(e), 3)}
                          for s, c, e in zip(s_acc, cl, Ec)]
        checks = [_check("centre", "Centre line Emin", e_min, ROUTE_CENTRE_LX, ">=", "lx"),
                  _check("band", "Central band Emin", res["band"]["Emin"], ROUTE_BAND_LX, ">=", "lx"),
                  _check("ratio", "Emax / Emin", ratio if ratio is not None else 1e9, RATIO_MAX, "<=", ":1")]
    elif typ in ("open", "highrisk"):
        P = np.array([(_f(p[0], 0.0), _f(p[1], 0.0)) for p in (it.get("polygon") or [])], float)
        if len(P) < 3 or abs(_signed_area(P)) < 1e-6:
            raise ValueError(f"{name}: an area needs an outline with at least 3 corners")
        area = abs(_signed_area(P))
        border = OPEN_BORDER if typ == "open" else 0.0
        step = 0.5 if area < 400 else 1.0
        xmin, ymin = P.min(axis=0); xmax, ymax = P.max(axis=0)
        nx = max(int(math.ceil((xmax - xmin) / step)), 1); ny = max(int(math.ceil((ymax - ymin) / step)), 1)
        while nx * ny > 8000:
            step *= 1.3
            nx = max(int(math.ceil((xmax - xmin) / step)), 1); ny = max(int(math.ceil((ymax - ymin) / step)), 1)
        xs = xmin + (np.arange(nx) + 0.5) * (xmax - xmin) / nx
        ys = ymin + (np.arange(ny) + 0.5) * (ymax - ymin) / ny
        X, Y = np.meshgrid(xs, ys)
        fx, fy = X.ravel(), Y.ravel()
        ok = _pip(P, fx, fy) & (_dist_to_edges(P, fx, fy) >= border)
        pts = np.stack([fx[ok], fy[ok]], axis=1)
        if len(pts) == 0:
            raise ValueError(f"{name}: the area is too small for the calculation")
        E = _floor_lx(webs, lums, pts, bounds if bounds is not None else (None), mf)
        e_min, e_max = float(E.min()), float(E.max())
        ratio = (e_max / e_min) if e_min > 1e-9 else None
        res["area"] = round(area, 2)
        res["floor"] = {"Emin": round(e_min, 3), "Emax": round(e_max, 3), "Eavg": round(float(E.mean()), 3), "n": int(len(E))}
        res["ratio"] = None if ratio is None else round(ratio, 1)
        if typ == "open":
            if area < 60.0:
                res["notes"].append("Under 60 m²: not an anti-panic area by EN 1838 — checked as one anyway")
            checks = [_check("open", "Floor Emin", e_min, OPEN_LX, ">=", "lx"),
                      _check("ratio", "Emax / Emin", ratio if ratio is not None else 1e9, RATIO_MAX, "<=", ":1")]
        else:
            need = max(HIGHRISK_MIN_LX, HIGHRISK_FRAC * _f(it.get("taskE"), 0.0))
            res["required"] = round(need, 1)
            checks = [_check("highrisk", "Floor Emin", e_min, need, ">=", "lx"),
                      _check("ratio", "Emax / Emin", ratio if ratio is not None else 1e9, 10.0, "<=", ":1")]
        vals = np.full(X.shape, np.nan)
        flat = vals.ravel()
        flat[np.flatnonzero(ok)] = E
        res["grid"] = {"x0": float(xs[0] - (xs[1] - xs[0]) / 2.0) if len(xs) > 1 else float(xmin),
                       "y0": float(ys[0] - (ys[1] - ys[0]) / 2.0) if len(ys) > 1 else float(ymin),
                       "dx": float(xs[1] - xs[0]) if len(xs) > 1 else float(xmax - xmin),
                       "dy": float(ys[1] - ys[0]) if len(ys) > 1 else float(ymax - ymin),
                       "nx": int(len(xs)), "ny": int(len(ys)),
                       "values": [None if not math.isfinite(v) else round(float(v), 3) for v in flat]}
    else:
        raise ValueError(f"{name}: unknown emergency item type '{typ}'")
    res["checks"] = checks
    res["pass"] = (all(c["pass"] for c in checks if c["pass"] is not None) and bool(lums)) if lums else False
    return res


def run_emergency_lighting(req: dict) -> dict:
    webs = {k: _Web(v) for k, v in (req.get("photometry") or {}).items()}
    out = []
    for it in (req.get("items") or []):
        try:
            out.append(evaluate_item(it, webs))
        except ValueError as e:
            out.append({"id": it.get("id"), "name": it.get("name") or "Emergency", "error": str(e)})
    return {"items": out}
