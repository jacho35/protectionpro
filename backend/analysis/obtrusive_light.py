"""Obtrusive light from outdoor lighting — EN 12464-2:2024 §5.5.

Every outdoor luminaire on the floor (poles, floodlights, sports-field floods)
is assessed against the environmental zone's limits (Table 4) at check lines:

  • Property (a site boundary, a row of windows, a facade): along the line,
    every `step` metres at each of the `heights`, the vertical illuminance Ev on
    the plane facing the installation side (the face measured, as for a fence),
    the luminous intensity I of each luminaire towards each point (only
    luminaires in front of the face — "in the potentially obtrusive direction"),
    and, when the line is a building facade with a reflectance ρ, its average
    luminance Lb = ρ·Ēv/π (a diffuse facade).
  • Road (EN 12464-2 Table 5): drivers on the line, eye 1.5 m, looking along it
    in both directions 1° down with the 20° car-roof screen; the threshold
    increment TI = 65·Lv / La^0.8 against 15 %, the adaptation luminance La
    set by the road's lighting class (0.1 cd/m² with no road lighting, 1 for M5,
    2 for M4 / M3, 5 for M2 / M1). Lv as in road_lighting (CIE, age 23).
  • Upward light ratio RUL of the whole installation: flux emitted above the
    horizontal in the installed attitude (tilt and heading) ÷ total flux, by
    integrating each luminaire's intensity over the sphere.

Obtrusive light is assessed on the initial flux (no maintenance factor) — the
light a new installation gives. Post-curfew, `postPct` scales every luminaire
(dimmed or switched off after the curfew); RUL is a ratio and is unchanged.

Request: { luminaires:[…as area_lighting…], checks:[{ id, name, kind:'property'|'road',
line:[[x,y]…], closed, side, heights:[…], step, zone:'E0'…'E4', curfew:'pre'|'post',
postPct, facadeRho, roadClass:'none'|'M5'|'M4'|'M3'|'M2'|'M1' }], photometry }.
Plan metres, y up.
"""

from __future__ import annotations

import math

import numpy as np

from .area_lighting import _Lums
from .road_lighting import _Web, TI_AGE, TI_RANGE_M, TI_SCREEN_DEG, TI_VIEW_DOWN_DEG
from .room_lighting import _f, _chk, _signed_area

# EN 12464-2:2024 Table 4: Ev (lx) and I (cd) pre- / post-curfew, RUL (%), Lb (cd/m²).
ZONES = {
    "E0": {"ev": (0.0, 0.0), "i": (0.0, 0.0), "rul": 0.0, "lb": 0.1, "name": "E0 — intrinsically dark (dark-sky parks, observatories)"},
    "E1": {"ev": (2.0, 0.0), "i": (2500.0, 0.0), "rul": 0.0, "lb": 0.1, "name": "E1 — dark (national parks, protected sites)"},
    "E2": {"ev": (5.0, 1.0), "i": (7500.0, 500.0), "rul": 2.5, "lb": 5.0, "name": "E2 — low district brightness (rural)"},
    "E3": {"ev": (10.0, 2.0), "i": (10000.0, 1000.0), "rul": 5.0, "lb": 10.0, "name": "E3 — medium district brightness (suburbs)"},
    "E4": {"ev": (25.0, 5.0), "i": (25000.0, 2500.0), "rul": 15.0, "lb": 25.0, "name": "E4 — high district brightness (town centres)"},
}
# EN 12464-2:2024 Table 5: adaptation luminance (cd/m²) by the road's lighting class; TI ≤ 15 %.
ROAD_LA = {"none": 0.1, "M5": 1.0, "M4": 2.0, "M3": 2.0, "M2": 5.0, "M1": 5.0}
TI_MAX = 15.0
EYE = 1.5


def _sphere(n=4000):
    """Fibonacci directions on the unit sphere and the solid angle each stands for."""
    k = np.arange(n) + 0.5
    z = 1.0 - 2.0 * k / n
    r = np.sqrt(np.maximum(1.0 - z * z, 0.0))
    phi = k * math.pi * (3.0 - math.sqrt(5.0))
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], axis=1), 4.0 * math.pi / n


def upward_light_ratio(lums: _Lums, n=4000) -> dict:
    """RUL (%) of the installation and the worst single luminaire, installed attitude."""
    if not lums.n:
        return {"rul": 0.0, "worst": 0.0, "worstId": None}
    D, dw = _sphere(n)
    I = lums.intensity(D[:, 0:1], D[:, 1:2], D[:, 2:3])          # [n, M], scaled by each flux factor
    tot = I.sum(axis=0) * dw
    up = (I * (D[:, 2:3] > 0)).sum(axis=0) * dw
    each = np.where(tot > 0, up / np.maximum(tot, 1e-12) * 100.0, 0.0)
    w = int(np.argmax(each))
    return {"rul": round(float(up.sum() / max(tot.sum(), 1e-12) * 100.0), 3), "worst": round(float(each[w]), 3), "worstId": lums.id[w]}


def _samples(line, closed, step, side):
    L = np.array([(_f(q[0], 0.0), _f(q[1], 0.0)) for q in line], float)
    if closed and len(L) >= 3 and _signed_area(L) < 0:
        L = L[::-1].copy()                      # counter-clockwise: the inside is on the left
    segs = list(zip(L[:-1], L[1:])) + ([(L[-1], L[0])] if closed and len(L) >= 3 else [])
    pts, nrm, tan, ss, s0 = [], [], [], [], 0.0
    for a, b in segs:
        seg = b - a
        ln = float(np.hypot(*seg))
        if ln < 1e-9:
            continue
        t = seg / ln
        left = np.array([-t[1], t[0]])
        # the face measured looks towards the installation: inside a ring, or the chosen side of a line
        n = left if side in ("left", "in") else -left
        m = max(int(math.ceil(ln / step)), 1)
        for i in range(m):
            u = (i + 0.5) / m
            pts.append(a + seg * u); nrm.append(n); tan.append(t); ss.append(s0 + u * ln)
        s0 += ln
    return np.array(pts), np.array(nrm), np.array(tan), np.array(ss), s0


def _property(c, lums, scale):
    zone = ZONES.get(c.get("zone"), ZONES["E3"])
    post = c.get("curfew") == "post"
    step = min(max(_f(c.get("step"), 2.0), 0.25), 20.0)
    hs = sorted({round(min(max(_f(h, 1.5), 0.0), 200.0), 2) for h in (c.get("heights") or [1.5])}) or [1.5]
    P2, N2, _, S, length = _samples(c.get("line") or [], bool(c.get("closed")), step, str(c.get("side") or "in"))
    if not len(P2):
        raise ValueError("the line has no length")
    pts = np.concatenate([np.c_[P2, np.full(len(P2), h)] for h in hs])
    nrm = np.concatenate([np.c_[N2, np.zeros(len(N2))] for _ in hs])
    Ev = lums.illuminance(pts, nrm) * scale if lums.n else np.zeros(len(pts))
    imax, iat, iid = 0.0, None, None
    if lums.n:
        dx = pts[:, 0:1] - lums.x[None, :]
        dy = pts[:, 1:2] - lums.y[None, :]
        dz = pts[:, 2:3] - lums.z[None, :]
        I = lums.intensity(dx, dy, dz) * scale
        facing = (nrm[:, 0:1] * dx + nrm[:, 1:2] * dy) < 0          # luminaire in front of the face
        I = np.where(facing, I, 0.0)
        k = int(np.argmax(I))
        r, col = divmod(k, lums.n)
        imax, iat, iid = float(I[r, col]), pts[r], lums.id[col]
    nh = len(hs)
    per = Ev.reshape(nh, len(P2))
    worst_h = per.max(axis=0)
    res = {"kind": "property", "length": round(length, 2), "heights": hs, "step": step, "zone": c.get("zone") or "E3",
           "zoneName": zone["name"], "curfew": "post" if post else "pre", "postPct": round(scale * 100.0, 1) if post else 100.0,
           "Evmax": round(float(Ev.max()), 3), "Evavg": round(float(Ev.mean()), 3),
           "Evat": {"x": round(float(pts[int(np.argmax(Ev))][0]), 2), "y": round(float(pts[int(np.argmax(Ev))][1]), 2), "z": round(float(pts[int(np.argmax(Ev))][2]), 2)},
           "Imax": round(imax, 1), "Iat": None if iat is None else {"x": round(float(iat[0]), 2), "y": round(float(iat[1]), 2), "z": round(float(iat[2]), 2)}, "Ifrom": iid,
           "profile": [{"s": round(float(s), 2), "x": round(float(p[0]), 3), "y": round(float(p[1]), 3), "E": round(float(e), 3)} for s, p, e in zip(S, P2, worst_h)]}
    j = 1 if post else 0
    checks = [_chk("ev", "Ev on the property (max)", res["Evmax"], zone["ev"][j], "<=", "lx"),
              _chk("i", "Luminous intensity towards it (max)", res["Imax"], zone["i"][j], "<=", "cd")]
    rho = _f(c.get("facadeRho"), 0.0)
    if rho > 0:
        res["Lb"] = round(min(rho, 1.0) * res["Evavg"] / math.pi, 3)
        checks.append(_chk("lb", "Facade luminance Lb (average)", res["Lb"], zone["lb"], "<=", "cd/m²"))
    return res, checks


def _road(c, lums, scale):
    step = min(max(_f(c.get("step"), 5.0), 0.5), 50.0)
    P2, _, T2, S, length = _samples(c.get("line") or [], False, step, "right")
    if not len(P2):
        raise ValueError("the line has no length")
    cls = c.get("roadClass") if c.get("roadClass") in ROAD_LA else "none"
    la = ROAD_LA[cls]
    worst, w_at, prof = 0.0, None, []
    down = math.radians(TI_VIEW_DOWN_DEG)
    for p, t, s in zip(P2, T2, S):
        best = 0.0
        for sign in (1.0, -1.0):
            vx, vy = sign * t[0], sign * t[1]
            ex, ey, ez = lums.x - p[0], lums.y - p[1], lums.z - EYE
            ahead = ex * vx + ey * vy
            elev = np.degrees(np.arctan2(ez, np.hypot(ex, ey)))
            dist = np.maximum(np.sqrt(ex * ex + ey * ey + ez * ez), 1e-9)
            cos_t = np.clip((ex * vx * math.cos(down) + ey * vy * math.cos(down) - ez * math.sin(down)) / dist, -1, 1)
            theta = np.degrees(np.arccos(cos_t))
            ok = (ahead > 0) & (ahead <= TI_RANGE_M) & (elev <= TI_SCREEN_DEG) & (theta >= 0.1) & (theta <= 60.0)
            if not np.any(ok):
                continue
            I = lums.intensity((-ex)[None, :], (-ey)[None, :], (-ez)[None, :])[0] * scale
            e_eye = I * cos_t / (dist * dist)
            th = np.maximum(theta, 1e-9)
            wide = 9.86 * (1 + (TI_AGE / 66.4) ** 4) * e_eye / th ** 2
            close = e_eye * (10.0 / th ** 3 + 5.0 / th ** 2 * (1 + (TI_AGE / 62.5) ** 4))
            lv = float(np.sum(np.where(ok, np.where(theta >= 1.5, wide, close), 0.0)))
            ti = 65.0 * lv / la ** 0.8
            best = max(best, ti)
        prof.append({"s": round(float(s), 2), "x": round(float(p[0]), 3), "y": round(float(p[1]), 3), "E": round(best, 2)})
        if best > worst:
            worst, w_at = best, p
    res = {"kind": "road", "length": round(length, 2), "step": step, "roadClass": cls, "La": la, "TImax": round(worst, 2),
           "TIat": None if w_at is None else {"x": round(float(w_at[0]), 2), "y": round(float(w_at[1]), 2)}, "profile": prof,
           "curfew": "post" if c.get("curfew") == "post" else "pre"}
    return res, [_chk("ti", "Threshold increment TI (max)", res["TImax"], TI_MAX, "<=", "%")]


def run_obtrusive_light(req: dict) -> dict:
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    lums = _Lums(req.get("luminaires"), webs)
    rul = upward_light_ratio(lums)
    out = []
    for c in (req.get("checks") or []):
        name = c.get("name") or "Check"
        try:
            post = c.get("curfew") == "post"
            scale = min(max(_f(c.get("postPct"), 100.0), 0.0), 100.0) / 100.0 if post else 1.0
            res, checks = (_road if c.get("kind") == "road" else _property)(c, lums, scale)
            if res["kind"] == "property":
                zone = ZONES.get(c.get("zone"), ZONES["E3"])
                checks.append(_chk("rul", "Upward light ratio RUL (installation)", rul["rul"], zone["rul"], "<=", "%"))
            res.update({"id": c.get("id"), "name": name, "luminaires": lums.n, "rul": rul, "checks": checks,
                        "warnings": list(lums.warnings), "notes": [] if lums.n else ["No outdoor luminaires on the sheet"]})
            known = [k for k in checks if k["pass"] is not None]
            res["pass"] = (all(k["pass"] for k in known) if known and lums.n else None)
            out.append(res)
        except ValueError as e:
            out.append({"id": c.get("id"), "name": name, "error": f"{name}: {e}"})
    return {"checks": out, "rul": rul, "zones": {k: {kk: vv for kk, vv in z.items()} for k, z in ZONES.items()}}
