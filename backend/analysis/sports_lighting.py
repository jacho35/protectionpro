"""Sports field lighting — floodlit pitches and courts (EN 12193 style).

Direct light only, from floodlights on masts aimed at points on the pitch:

  • Horizontal illuminance on the principal area (PA): a rectangle in its own
    frame (origin at a corner, x along the length, y across the width), points
    at the centres of an nx × ny grid. Ēh, Emin, Emax, U₁ = Emin/Emax and
    U₂ = Emin/Ēh, maintained (× MF). The automatic grid step is the
    EN 12464-2 formula p = 0.2·5^log10(d) on the field's length — EN 12193
    gives a grid per sport; type a step to use that one instead.
  • Vertical illuminance at 1.5 m (default) on planes facing each camera (TV)
    and towards the four ends / sides of the pitch (players): Ēv, Emin/Ēv.
  • Glare rating GR (CIE 112:1994) at observers on the pitch: a 5 × 3 grid
    over the PA (ends, quarter lines, halfway; touchlines and centre line),
    eye 1.5 m, viewing directions every 45°, Lve from the ground reflectance
    and Ēh — CIE 112 §5 allows observers on a grid and directions in equal steps.
  • Aiming: the steepest flood (tilt from the downward vertical) of the field's
    own masts against a limit (70° keeps the beam below the horizontal).

Luminaires are the area engine's (_Lums): plan position, height, heading
`rotate`, `tilt` towards the front; every luminaire in the request lights every
field (a neighbour's masts spill onto this pitch). `fieldId` marks a
luminaire as one of a field's own, for its power, count and tilt check.

Request (camelCase): { luminaires:[{ id, x, y, h, rotate, tilt, photometryId,
fluxPct, lumens?, watts?, fieldId? }], fields:[{ id, name, origin:[x,y],
axis:[ux,uy], side:[vx,vy], length, width, gridStep, mf, groundRho, evHeight,
cameras:[{ id, name, x, y, z }], targets:{ em, u1, u2, gr, maxTilt, evCam,
evCamU2 } }], photometry:{ id: web } }. Plan metres, y up.
"""

from __future__ import annotations

import math
import time

import numpy as np

from .area_lighting import _Lums, glare_rating
from .road_lighting import _Web
from .room_lighting import _f, _chk


def _unit(v, fallback):
    try:
        a = np.array([float(v[0]), float(v[1])], float)
    except (TypeError, ValueError, IndexError):
        return np.array(fallback, float)
    n = float(np.hypot(*a))
    return a / n if n > 1e-9 and math.isfinite(n) else np.array(fallback, float)


def grid_step(length: float) -> float:
    """EN 12464-2 maximum grid size for a dimension d: p = 0.2·5^log10(d)."""
    return 0.2 * 5.0 ** math.log10(max(length, 1.0))


def _stats(E):
    avg = float(E.mean()) if len(E) else 0.0
    mn = float(E.min()) if len(E) else 0.0
    mx = float(E.max()) if len(E) else 0.0
    return {"Eav": round(avg, 2), "Emin": round(mn, 2), "Emax": round(mx, 2),
            "U1": round(mn / mx, 3) if mx > 0 else 0.0, "U2": round(mn / avg, 3) if avg > 0 else 0.0, "n": int(len(E))}


def evaluate_field(fd: dict, lums: _Lums) -> dict:
    t0 = time.time()
    name = fd.get("name") or "Field"
    L = _f(fd.get("length"), 0.0)
    W = _f(fd.get("width"), 0.0)
    if not (L > 0.5 and W > 0.5):
        raise ValueError(f"{name}: the field needs a length and a width")
    O = np.array([_f((fd.get("origin") or [0, 0])[0], 0.0), _f((fd.get("origin") or [0, 0])[1], 0.0)])
    u = _unit(fd.get("axis"), [1.0, 0.0])
    v = _unit(fd.get("side"), [-u[1], u[0]])
    mf = min(max(_f(fd.get("mf"), 0.8), 0.05), 1.0)
    asked = max(_f(fd.get("gridStep"), 0.0), 0.0)
    auto = grid_step(L)
    step = float(np.clip(asked, 0.5, 20.0)) if asked > 0 else auto
    nx = max(int(math.ceil(L / step - 1e-9)), 2)
    ny = max(int(math.ceil(W / step - 1e-9)), 2)
    while nx * ny > 6000:
        step *= 1.25
        nx, ny = max(int(math.ceil(L / step)), 2), max(int(math.ceil(W / step)), 2)
    dx, dy = L / nx, W / ny
    lx = (np.arange(nx) + 0.5) * dx
    ly = (np.arange(ny) + 0.5) * dy
    LX, LY = np.meshgrid(lx, ly)                      # [ny, nx] → row-major j * nx + i
    lxf, lyf = LX.ravel(), LY.ravel()
    wx = O[0] + lxf * u[0] + lyf * v[0]
    wy = O[1] + lxf * u[1] + lyf * v[1]
    n = len(wx)

    own = [i for i, fid in enumerate(lums.field) if fid == fd.get("id")]
    res = {"id": fd.get("id"), "name": name, "length": round(L, 3), "width": round(W, 3), "area": round(L * W, 2),
           "luminaires": len(own), "allLuminaires": lums.n, "warnings": list(lums.warnings), "notes": []}
    if not lums.n:
        res["notes"].append("No floodlights — add masts to the field")
    if asked > 0 and step > asked * 1.001:
        res["notes"].append(f"Grid {asked:g} m would need too many points — calculated at {step:.2f} m")

    up = np.tile([0.0, 0.0, 1.0], (n, 1))
    Eh = lums.illuminance(np.stack([wx, wy, np.zeros(n)], axis=1), up) * mf
    hz = _stats(Eh)
    hz.update({"nx": nx, "ny": ny, "dx": round(dx, 4), "dy": round(dy, 4), "step": round(step, 3), "autoStep": round(auto, 3),
               "values": [round(float(e), 1) for e in Eh]})
    res["horizontal"] = hz

    # Vertical: cameras and the four player directions, on the same grid at evHeight.
    zh = min(max(_f(fd.get("evHeight"), 1.5), 0.0), 10.0)
    P = np.stack([wx, wy, np.full(n, zh)], axis=1)
    cams = []
    for c in (fd.get("cameras") or []):
        cx, cy, cz = _f(c.get("x"), math.nan), _f(c.get("y"), math.nan), _f(c.get("z"), zh)
        if not (math.isfinite(cx) and math.isfinite(cy)):
            continue
        nrm = np.stack([cx - wx, cy - wy, np.zeros(n)], axis=1)
        ln = np.maximum(np.hypot(nrm[:, 0], nrm[:, 1]), 1e-9)
        nrm[:, 0] /= ln
        nrm[:, 1] /= ln
        E = lums.illuminance(P, nrm) * mf if lums.n else np.zeros(n)
        s = _stats(E)
        s.update({"id": c.get("id"), "name": c.get("name") or "Camera", "height": zh})
        cams.append(s)
    res["cameras"] = cams
    players = []
    for label, d in (("Towards end x = 0", -u), ("Towards end x = L", u), ("Towards side y = 0", -v), ("Towards side y = W", v)):
        nrm = np.tile([d[0], d[1], 0.0], (n, 1))
        E = lums.illuminance(P, nrm) * mf if lums.n else np.zeros(n)
        s = _stats(E)
        s["label"] = label
        players.append(s)
    res["players"] = {"height": zh, "directions": players}

    # Glare rating at observers on the pitch.
    gr = None
    if lums.n and hz["Eav"] > 0:
        rho = min(max(_f(fd.get("groundRho"), 0.2), 0.01), 0.9)
        lve = max(0.035 * rho * hz["Eav"] / math.pi, 1e-4)
        base = math.degrees(math.atan2(u[1], u[0]))
        obs = []
        for fy in (0.0, 0.5, 1.0):
            for fx in (0.0, 0.25, 0.5, 0.75, 1.0):
                ox, oy = fx * L, fy * W
                g, a = glare_rating(lums, O[0] + ox * u[0] + oy * v[0], O[1] + ox * u[1] + oy * v[1], mf, lve,
                                    dirs=[base + k * 45.0 for k in range(8)])
                obs.append({"x": round(ox, 2), "y": round(oy, 2), "gr": None if g is None else round(g, 1),
                            "dir": None if a is None else round((a - base) % 360.0, 1)})
        vals = [o for o in obs if o["gr"] is not None]
        if vals:
            w = max(vals, key=lambda o: o["gr"])
            gr = {"max": w["gr"], "at": {"x": w["x"], "y": w["y"], "dir": w["dir"]}, "observers": obs,
                  "note": "CIE 112 at 15 observers (ends, quarter lines, halfway × touchlines, centre line), eye 1.5 m, every 45°; ground reflectance %.2f" % rho}
    res["gr"] = gr

    # Aiming and power: the field's own floodlights.
    tilts = [float(lums.tilt[i]) for i in own]
    res["aiming"] = {"maxTilt": round(max(tilts), 1) if tilts else None}
    watts = float(sum(lums.watts[i] for i in own))
    res["power"] = {"watts": round(watts, 1), "wm2": round(watts / (L * W), 3), "count": len(own)}

    tg = fd.get("targets") or {}
    checks = []
    if tg.get("em") is not None:
        checks.append(_chk("em", "Ēh maintained", hz["Eav"], _f(tg.get("em"), None), ">=", "lx"))
    if tg.get("u2") is not None:
        checks.append(_chk("u2", "U₂ = Emin / Ēh", hz["U2"], _f(tg.get("u2"), None), ">=", ""))
    if tg.get("u1") is not None:
        checks.append(_chk("u1", "U₁ = Emin / Emax", hz["U1"], _f(tg.get("u1"), None), ">=", ""))
    if tg.get("gr") is not None and gr:
        checks.append(_chk("gr", "GR max", gr["max"], _f(tg.get("gr"), None), "<=", ""))
    if tg.get("maxTilt") is not None and tilts:
        checks.append(_chk("tilt", "Steepest flood tilt", res["aiming"]["maxTilt"], _f(tg.get("maxTilt"), None), "<=", "°"))
    for c in cams:
        if tg.get("evCam") is not None:
            checks.append(_chk("evCam", f"Ēv → {c['name']}", c["Eav"], _f(tg.get("evCam"), None), ">=", "lx"))
        if tg.get("evCamU2") is not None:
            checks.append(_chk("evCamU2", f"U₂ v → {c['name']}", c["U2"], _f(tg.get("evCamU2"), None), ">=", ""))
    res["checks"] = checks
    known = [c for c in checks if c["pass"] is not None]
    res["pass"] = (all(c["pass"] for c in known) if known and lums.n else None)
    res["ms"] = round((time.time() - t0) * 1000.0, 1)
    return res


def run_sports_lighting(req: dict) -> dict:
    webs = {}
    for k, v in (req.get("photometry") or {}).items():
        w = _Web(v)
        w.luminous_m2 = _f(v.get("luminousM2"), 0.0)
        webs[k] = w
    items = req.get("luminaires") or []
    lums = _Lums(items, webs)
    # _Lums skips luminaires without a position or a photometry; keep fieldId aligned with what it kept.
    by_id = {}
    for it in items:
        by_id.setdefault(it.get("id"), it.get("fieldId"))
    lums.field = [by_id.get(i) for i in lums.id]
    out = []
    for fd in (req.get("fields") or []):
        try:
            out.append(evaluate_field(fd, lums))
        except ValueError as e:
            out.append({"id": fd.get("id"), "name": fd.get("name") or "Field", "error": str(e)})
    return {"fields": out}


# ─── Aiming: move aim points until the pitch is even ─────────────────────

def _contrib(lums: _Lums, pts):
    """Horizontal illuminance from each luminaire [n, M] at ground points [n, 3]."""
    dx = pts[:, 0:1] - lums.x[None, :]
    dy = pts[:, 1:2] - lums.y[None, :]
    dz = pts[:, 2:3] - lums.z[None, :]
    d = np.maximum(np.sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
    I = lums.intensity(dx, dy, dz)
    cos_p = -dz / d
    return np.where(cos_p > 1e-9, I * cos_p / (d * d), 0.0)


def aim_angles(mx, my, h, ax, ay):
    """Heading (`rotate`) and tilt that put a flood's beam axis on (ax, ay) at
    ground level from a mast at (mx, my) of height h — the _Lums frame: the
    front is (-sin r, cos r), tilt from the downward vertical towards it."""
    dx, dy = ax - mx, ay - my
    return math.degrees(math.atan2(-dx, dy)), math.degrees(math.atan2(math.hypot(dx, dy), max(h, 0.5)))


def optimise_aiming(req: dict) -> dict:
    """Move each flood's aim point so the horizontal illuminance on the field
    evens out. Field-local metres (origin a corner, x along the length).

    Each step weights the grid by (Ēh / E)^2 and shifts every aim point by the
    difference between its footprint's weighted and unweighted centroids — the
    flood follows the dark side of its own patch of light. A medium beam
    (≈ 30°) reaches U₂ 0.85–0.9 on a 6-mast football pitch; a narrow beam on a
    short throw leaves a bright spot no aiming removes. Aim points stay on
    the field and within `maxTilt` − 2° of the vertical; the best (highest U₂)
    set seen is returned. req: { field:{ length, width, gridStep, mf, maxTilt },
    masts:[{ id, x, y, h, floods:[{ id, ax, ay, photometryId, fluxPct, lumens? }] }],
    photometry, iterations }."""
    t0 = time.time()
    webs = {k: _Web(v) for k, v in (req.get("photometry") or {}).items()}
    fd = req.get("field") or {}
    L, W = _f(fd.get("length"), 0.0), _f(fd.get("width"), 0.0)
    if not (L > 0.5 and W > 0.5):
        raise ValueError("The field needs a length and a width")
    mf = min(max(_f(fd.get("mf"), 0.8), 0.05), 1.0)
    max_tilt = min(max(_f(fd.get("maxTilt"), 70.0), 10.0), 89.0)
    asked = max(_f(fd.get("gridStep"), 0.0), 0.0)
    step = float(np.clip(asked, 0.5, 20.0)) if asked > 0 else grid_step(L)
    nx, ny = max(int(math.ceil(L / step - 1e-9)), 2), max(int(math.ceil(W / step - 1e-9)), 2)
    gx = (np.arange(nx) + 0.5) * L / nx
    gy = (np.arange(ny) + 0.5) * W / ny
    G = np.array([(x, y, 0.0) for y in gy for x in gx])

    floods = []                                          # (mast, flood dict)
    for m in (req.get("masts") or []):
        for fl in (m.get("floods") or []):
            if fl.get("photometryId") in webs:
                floods.append((m, fl))
    if not floods:
        raise ValueError("No floodlights with a luminaire to aim")
    mx = np.array([_f(m.get("x"), 0.0) for m, _ in floods])
    my = np.array([_f(m.get("y"), 0.0) for m, _ in floods])
    mh = np.array([max(_f(m.get("h"), 20.0), 0.5) for m, _ in floods])
    aims = np.array([(_f(fl.get("ax"), L / 2), _f(fl.get("ay"), W / 2)) for _, fl in floods], float)
    reach = mh * math.tan(math.radians(max_tilt - 2.0))

    def clamp(a):
        a[:, 0] = np.clip(a[:, 0], 0.0, L)
        a[:, 1] = np.clip(a[:, 1], 0.0, W)
        v = a - np.stack([mx, my], axis=1)
        d = np.hypot(v[:, 0], v[:, 1])
        far = d > reach
        a[far] = np.stack([mx, my], axis=1)[far] + v[far] / d[far, None] * reach[far, None]
        return a

    def evaluate(a):
        items = []
        for i, (m, fl) in enumerate(floods):
            rot, tilt = aim_angles(mx[i], my[i], mh[i], a[i, 0], a[i, 1])
            items.append({"id": i, "x": mx[i], "y": my[i], "h": mh[i], "rotate": rot, "tilt": tilt,
                          "photometryId": fl.get("photometryId"), "fluxPct": fl.get("fluxPct", 100), "lumens": fl.get("lumens")})
        C = _contrib(_Lums(items, webs), G) * mf
        return C, C.sum(axis=1)

    aims = clamp(aims)
    first = None
    best = None
    iters = int(min(max(_f(req.get("iterations"), 40), 0), 120))
    for it in range(iters + 1):
        C, E = evaluate(aims)
        avg = float(E.mean())
        u2 = float(E.min() / avg) if avg > 0 else 0.0
        if first is None:
            first = (u2, avg)
        if best is None or u2 > best[0]:
            best = (u2, avg, it, aims.copy(), float(E.min()), float(E.max()))
        if it == iters or avg <= 0 or time.time() - t0 > 12.0:
            break
        w = (avg / np.maximum(E, avg * 1e-3)) ** 2
        tot = np.maximum(C.sum(axis=0), 1e-12)
        cen = (C.T @ G[:, :2]) / tot[:, None]
        cw = C * w[:, None]
        cen_w = (cw.T @ G[:, :2]) / np.maximum(cw.sum(axis=0), 1e-12)[:, None]
        aims = clamp(aims + (cen_w - cen))

    u2, avg, it, a, emin, emax = best
    out, k = {}, 0
    for (m, fl) in floods:
        out.setdefault(m.get("id"), []).append({"id": fl.get("id"), "ax": round(float(a[k, 0]), 2), "ay": round(float(a[k, 1]), 2)})
        k += 1
    return {"masts": [{"id": mid, "floods": fls} for mid, fls in out.items()],
            "before": {"U2": round(first[0], 3), "Eav": round(first[1], 1)},
            "after": {"U2": round(u2, 3), "Eav": round(avg, 1), "Emin": round(emin, 1), "Emax": round(emax, 1)},
            "iteration": it, "grid": {"nx": nx, "ny": ny}, "ms": round((time.time() - t0) * 1000.0)}
