"""Road lighting — EN 13201-3 photometric calculation on a road cross-section.

A straight road, uniform along its length: a cross-section of strips
(carriageways with lanes, footpaths, verges, medians, cycle tracks) and one or
more rows of luminaires, each row repeating at the same spacing S. That is the
Ulysse / EN 13201-3 model, and it is what this engine solves:

  • Illuminance on every strip — E = Σ I(C,γ)·cos³γ / H²  ·  MF
  • Luminance on a carriageway — L = Σ I(C,γ)·r(β, tan γ) / H²  ·  MF, with
    r from the road surface's CIE reduced luminance coefficient table (R1–R4,
    C1/C2) and an observer 60 m before the field, 1.5 m high, in each lane
  • Threshold increment TI (disability glare) with the 20° car-roof screen,
    edge illumination ratio REI, overall Uo and longitudinal Ul uniformity
  • Class checks to one of two standards, chosen per design (`standard`):
      EN    EN 13201-2 M1–M6, C0–C5, P1–P6 (the default for a request without
            one — designs saved before SANS support keep their results)
      SANS  SANS 10098-1:2007 group A1–A4 (luminance, by traffic volume and
            median), B1–B3 / C1–C2 (illuminance incl. 2 m of footway), plus the
            SANS 10098-2 roadway-complex RC0–RC5 and cycle/pedestrian CP1–CP6
            classes. SANS takes L̄ and Uo from one observer a quarter of the
            carriageway width from the left, where EN takes each lane's worst.
  • The EN 13201-5 energy indicators PDI (D_P) and AECI (D_E), plus W/km and
    poles/km
  • A max-spacing solver and a multi-variable optimiser (height × tilt ×
    overhang × luminaire × dimming) ranked by W/km, poles/km or PDI

Geometry: x runs along the road (the calculation field is 0 ≤ x ≤ S, between
two consecutive luminaires of the first row), y across it from the left edge of
the first strip, z up. A luminaire's photometric frame has C0 along the road,
C90 across it towards the side it faces, γ from its (tilted) nadir.

Request (camelCase dict, see schemas.RoadLightingRequest): sections, rows,
spacing, mf, photometry {id: canonical web from photometry.py}, mode
('verify' | 'maxSpacing' | 'optimise') and the solver settings.
"""

from __future__ import annotations

import itertools
import math
import time

import numpy as np

from .road_rtables import RTABLES

# ─── EN 13201-2:2015 lighting classes (as CIE 115) ─────────────────────

M_CLASSES = {
    "M1": {"Lav": 2.00, "Uo": 0.40, "Ul": 0.70, "TI": 10, "REI": 0.35},
    "M2": {"Lav": 1.50, "Uo": 0.40, "Ul": 0.70, "TI": 10, "REI": 0.35},
    "M3": {"Lav": 1.00, "Uo": 0.40, "Ul": 0.60, "TI": 15, "REI": 0.30},
    "M4": {"Lav": 0.75, "Uo": 0.40, "Ul": 0.60, "TI": 15, "REI": 0.30},
    "M5": {"Lav": 0.50, "Uo": 0.35, "Ul": 0.40, "TI": 15, "REI": 0.30},
    "M6": {"Lav": 0.30, "Uo": 0.35, "Ul": 0.40, "TI": 20, "REI": 0.30},
}
C_CLASSES = {
    "C0": {"Eav": 50.0, "Uo": 0.40}, "C1": {"Eav": 30.0, "Uo": 0.40},
    "C2": {"Eav": 20.0, "Uo": 0.40}, "C3": {"Eav": 15.0, "Uo": 0.40},
    "C4": {"Eav": 10.0, "Uo": 0.40}, "C5": {"Eav": 7.50, "Uo": 0.40},
}
P_CLASSES = {
    "P1": {"Eav": 15.0, "Emin": 3.00}, "P2": {"Eav": 10.0, "Emin": 2.00},
    "P3": {"Eav": 7.50, "Emin": 1.50}, "P4": {"Eav": 5.00, "Emin": 1.00},
    "P5": {"Eav": 3.00, "Emin": 0.60}, "P6": {"Eav": 2.00, "Emin": 0.40},
}

# ─── SANS 10098-1:2007 (ed. 3.3) categories — South Africa ──────────────
# Group A (luminance): Table 1, per traffic volume during darkness (motor
# vehicles / h / lane) and cross-section; values (Ln, Uo, UL, TI). Columns are
# maximum volumes: without median ≤100 / ≤300 / >600, with median ≤200 / ≤600 /
# >900 — `volume` 0 = heaviest column, 2 = lightest. A volume between two
# columns takes the heavier one (conservative).
SANS_A = {
    "A1": {"noMedian": [(2.0, 0.4, 0.7, 15), (1.5, 0.4, 0.7, 20), (1.0, 0.4, 0.6, 20)],
           "median":   [(2.0, 0.4, 0.7, 15), (1.5, 0.4, 0.7, 20), (1.0, 0.4, 0.6, 20)]},
    "A2": {"noMedian": [(1.5, 0.4, 0.7, 20), (1.0, 0.4, 0.6, 20), (0.8, 0.4, 0.5, 20)],
           "median":   [(1.5, 0.4, 0.7, 20), (1.0, 0.4, 0.6, 20), (0.8, 0.4, 0.5, 20)]},
    "A3": {"noMedian": [(1.0, 0.4, 0.6, 20), (0.6, 0.4, 0.5, 20), (0.5, 0.4, 0.5, 20)],
           "median":   [(1.0, 0.4, 0.6, 20), (0.8, 0.4, 0.5, 20), (0.5, 0.4, 0.5, 20)]},
    "A4": {"noMedian": [(0.75, 0.4, 0.5, 20), (0.5, 0.4, 0.5, 20), (0.3, 0.3, 0.5, 25)],
           "median":   [(0.75, 0.4, 0.5, 20), (0.5, 0.4, 0.5, 20), (0.3, 0.3, 0.5, 25)]},
}
SANS_VOLUME_BANDS = {"noMedian": (">600", "≤300", "≤100"), "median": (">900", "≤600", "≤200")}
# Groups B and C (horizontal illuminance): Table 2 — Ē, Emin and the
# supplementary semi-cylindrical Esc,min. On a carriageway the area extends
# onto the footways up to 2 m from its edge (Table 2 note a).
SANS_BC = {
    "B1": {"Eav": 5.0, "Emin": 1.0, "Esc": 2.0}, "B2": {"Eav": 3.0, "Emin": 0.6, "Esc": 1.0},
    "B3": {"Eav": 2.0, "Emin": 0.4, "Esc": 0.6},
    "C1": {"Eav": 10.0, "Emin": 3.0, "Esc": 7.5}, "C2": {"Eav": 7.5, "Emin": 1.5, "Esc": 3.0},
}
SANS_FOOTWAY_M = 2.0
# SANS 10098-2:2005 — roadway complexes (Table 1: Ē and 0,4, read as the
# uniformity ratio as in clause 9) and cycle / pedestrian ways (Table 3).
SANS_RC = {f"RC{i}": {"Eav": v, "Uo": 0.4} for i, v in enumerate((50.0, 30.0, 20.0, 15.0, 10.0, 7.5))}
SANS_CP = {f"CP{i + 1}": {"Eav": e, "Emin": m} for i, (e, m) in enumerate(((15, 5), (10, 3), (7.5, 1.5), (5, 1.0), (3, 0.6), (2, 0.6)))}


def sans_family(cls: str) -> str:
    c = (cls or "").upper()
    if c in SANS_A:
        return "A"
    if c in SANS_BC:
        return "B"
    if c in SANS_RC:
        return "RC"
    if c in SANS_CP:
        return "CP"
    return ""


OBSERVER_BACK_M = 60.0      # observer distance before the field (EN 13201-3 §7.1.4)
OBSERVER_EYE_M = 1.5        # eye height
LUM_RANGE_H = 5.0           # illuminance: luminaires within 5·H of a grid point (§7.2.7)
LUM_NEAR_H = 5.0            # luminance: 5·H towards the observer …
LUM_FAR_H = 12.0            # … and 12·H beyond the point, away from the observer (§7.1.5)
TI_AGE = 23.0               # observer age for the veiling luminance (§8.5)
TI_RANGE_M = 500.0          # luminaires up to 500 m ahead count for TI
TI_SCREEN_DEG = 20.0        # car-roof screening angle
TI_VIEW_DOWN_DEG = 1.0      # line of sight 1° below horizontal
TAN_MAX = 12.0              # r-tables stop at tan γ = 12 (beyond: ignored)


def class_family(cls: str) -> str:
    c = (cls or "").upper()
    if c in M_CLASSES:
        return "M"
    if c in C_CLASSES:
        return "C"
    if c in P_CLASSES:
        return "P"
    return ""


# ─── Photometry & r-table lookups (vectorised) ──────────────────────────

class _Web:
    """Canonical Type C web → bilinear I(C, γ) over numpy arrays."""

    def __init__(self, prof: dict):
        self.c = np.asarray(prof["c"], float)
        self.g = np.asarray(prof["g"], float)
        self.cd = np.asarray(prof["cd"], float)
        if self.cd.shape != (len(self.c), len(self.g)):
            raise ValueError(f"Photometry '{prof.get('name', '')}': web shape does not match its angles")
        self.lumens = float(prof.get("lumens") or 0) or 1.0
        self.watts = float(prof.get("watts") or 0)
        self.name = prof.get("name", "")
        self.g_max = float(self.g[-1])

    def intensity(self, c_deg, g_deg):
        c = np.mod(c_deg, 360.0)
        ic = np.clip(np.searchsorted(self.c, c, side="right") - 1, 0, len(self.c) - 2)
        tc = (c - self.c[ic]) / np.maximum(self.c[ic + 1] - self.c[ic], 1e-12)
        g = np.clip(g_deg, self.g[0], self.g[-1])
        ig = np.clip(np.searchsorted(self.g, g, side="right") - 1, 0, max(len(self.g) - 2, 0))
        if len(self.g) == 1:
            val = self.cd[ic, 0] * (1 - tc) + self.cd[ic + 1, 0] * tc
        else:
            tg = (g - self.g[ig]) / np.maximum(self.g[ig + 1] - self.g[ig], 1e-12)
            a = self.cd[ic, ig] * (1 - tg) + self.cd[ic, ig + 1] * tg
            b = self.cd[ic + 1, ig] * (1 - tg) + self.cd[ic + 1, ig + 1] * tg
            val = a * (1 - tc) + b * tc
        return np.where(g_deg > self.g_max + 1e-9, 0.0, val)


class _RTable:
    """CIE reduced luminance coefficient table → r(β, tan γ) (true value, not ×10⁴)."""

    def __init__(self, name: str):
        t = RTABLES.get((name or "R3").upper())
        if t is None:
            raise ValueError(f"Unknown road surface '{name}' (R1–R4, C1, C2)")
        self.name = (name or "R3").upper()
        self.q0 = t["q0"]
        self.beta = np.asarray(t["beta"], float)
        self.tan = np.asarray(t["tan"], float)
        self.r = np.asarray(t["r"], float) * 1e-4

    def lookup(self, beta_deg, tan_g):
        b = np.clip(beta_deg, 0.0, 180.0)
        tg = np.clip(tan_g, 0.0, self.tan[-1])
        ib = np.clip(np.searchsorted(self.beta, b, side="right") - 1, 0, len(self.beta) - 2)
        it = np.clip(np.searchsorted(self.tan, tg, side="right") - 1, 0, len(self.tan) - 2)
        ub = (b - self.beta[ib]) / (self.beta[ib + 1] - self.beta[ib])
        ut = (tg - self.tan[it]) / (self.tan[it + 1] - self.tan[it])
        r = self.r
        a = r[it, ib] * (1 - ub) + r[it, ib + 1] * ub
        c = r[it + 1, ib] * (1 - ub) + r[it + 1, ib + 1] * ub
        return np.where(tan_g > self.tan[-1] + 1e-9, 0.0, a * (1 - ut) + c * ut)


# ─── Design model ───────────────────────────────────────────────────────

def _f(v, d):
    try:
        x = float(v)
        return x if math.isfinite(x) else d
    except (TypeError, ValueError):
        return d


class _Design:
    def __init__(self, req: dict, webs: dict | None = None):
        self.req = req
        self.mf = min(max(_f(req.get("mf"), 0.8), 0.05), 1.0)
        self.hours = max(_f(req.get("hoursPerYear"), 4100.0), 0.0)
        # "EN" (EN 13201-2/-3, the default for a request without one — designs
        # saved before SANS support) or "SANS" (SANS 10098-1/-2).
        self.standard = "SANS" if str(req.get("standard") or "EN").upper().startswith("SANS") else "EN"
        self.webs = webs if webs is not None else {k: _Web(v) for k, v in (req.get("photometry") or {}).items()}
        y = 0.0
        self.sections = []
        for i, s in enumerate(req.get("sections") or []):
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
            sec["family"] = sans_family(sec["cls"]) if self.standard == "SANS" else class_family(sec["cls"])
            self.sections.append(sec)
            y += w
        self.width = y
        self.rows = []
        for i, r in enumerate(req.get("rows") or []):
            pid = r.get("photometryId")
            if pid not in self.webs:
                raise ValueError(f"Luminaire row {i + 1}: no photometry '{pid}'")
            web = self.webs[pid]
            flux_pct = max(_f(r.get("fluxPct"), 100.0), 0.0)
            lm = _f(r.get("lumens"), 0.0) or web.lumens
            watts = _f(r.get("watts"), 0.0) or web.watts
            self.rows.append({
                "index": i, "name": r.get("name") or f"Row {i + 1}",
                "y": _f(r.get("y"), 0.0), "overhang": _f(r.get("overhang"), 0.0),
                "facing": 1.0 if (r.get("facing") or "right") == "right" else -1.0,
                "height": max(_f(r.get("height"), 10.0), 0.5),
                "tilt": _f(r.get("tilt"), 0.0), "rotate": _f(r.get("rotate"), 0.0),
                "xOffset": _f(r.get("xOffset"), 0.0),      # fraction of S (0 or 0.5 staggered)
                "web": pid, "scale": (lm / web.lumens) * flux_pct / 100.0,
                "watts": watts * flux_pct / 100.0,
                "pole": r.get("pole"),                    # shared pole key (twin arms)
            })
        if not self.rows:
            raise ValueError("No luminaire rows")
        if not self.sections:
            raise ValueError("No road cross-section")
        # SANS Table 1 picks its column by the cross-section: with or without a median.
        self.has_median = any(s["type"] == "median" for s in self.sections)

    def with_params(self, **kw):
        """A copy with every row's height/tilt/overhang/photometry/flux overridden."""
        req = dict(self.req)
        rows = []
        for r in self.req.get("rows") or []:
            r2 = dict(r)
            for k in ("height", "tilt", "overhang", "photometryId", "fluxPct"):
                if kw.get(k) is not None:
                    r2[k] = kw[k]
            if kw.get("photometryId") is not None:
                r2.pop("lumens", None); r2.pop("watts", None)
            rows.append(r2)
        req["rows"] = rows
        return _Design(req, self.webs)


def _long_points(S):
    """EN 13201-3 longitudinal grid: N = 10 for S ≤ 30 m, else D ≤ 3 m."""
    n = 10 if S <= 30.0 + 1e-9 else int(math.ceil(S / 3.0 - 1e-9))
    d = S / n
    return (np.arange(n) + 0.5) * d, d


def _trans_points(y0, w, d_max=1.5, n_min=3):
    n = max(n_min, int(math.ceil(w / d_max - 1e-9)))
    d = w / n
    return y0 + (np.arange(n) + 0.5) * d


def _luminaires(des: _Design, S: float, x_lo: float, x_hi: float):
    """Every luminaire (all rows) with x in [x_lo, x_hi] for spacing S."""
    cols = {k: [] for k in ("x", "y", "h", "phi", "tilt", "web", "scale", "row")}
    for r in des.rows:
        x0 = r["xOffset"] * S
        k0 = int(math.floor((x_lo - x0) / S)) - 1
        k1 = int(math.ceil((x_hi - x0) / S)) + 1
        for k in range(k0, k1 + 1):
            x = x0 + k * S
            if x < x_lo - 1e-9 or x > x_hi + 1e-9:
                continue
            cols["x"].append(x)
            cols["y"].append(r["y"] + r["overhang"] * r["facing"])
            cols["h"].append(r["height"])
            cols["phi"].append((90.0 if r["facing"] > 0 else -90.0) + r["rotate"])
            cols["tilt"].append(r["tilt"])
            cols["web"].append(r["web"])
            cols["scale"].append(r["scale"])
            cols["row"].append(r["index"])
    out = {k: np.asarray(v, float) for k, v in cols.items() if k != "web"}
    out["web"] = np.asarray(cols["web"], dtype=object)
    return out


def _intensity_to(des: _Design, lum, dx, dy, dz):
    """Candela from every luminaire towards the direction (dx, dy, dz) —
    arrays broadcast as [..., M]. Scaled by the row's flux factor."""
    phi = np.radians(lum["phi"]); th = np.radians(lum["tilt"])
    a = phi - math.pi / 2
    ex = (np.cos(a), np.sin(a), 0.0)
    ey0 = (np.cos(phi), np.sin(phi))
    ey = (ey0[0] * np.cos(th), ey0[1] * np.cos(th), np.sin(th))
    ez = (-ey0[0] * np.sin(th), -ey0[1] * np.sin(th), np.cos(th))
    u = dx * ex[0] + dy * ex[1]
    v = dx * ey[0] + dy * ey[1] + dz * ey[2]
    w = dx * ez[0] + dy * ez[1] + dz * ez[2]
    n = np.sqrt(dx * dx + dy * dy + dz * dz)
    g = np.degrees(np.arccos(np.clip(-w / np.maximum(n, 1e-12), -1, 1)))
    c = np.degrees(np.arctan2(v, u))
    out = np.zeros(np.broadcast(dx, lum["x"]).shape)
    for pid in set(lum["web"].tolist()):
        m = lum["web"] == pid
        out[..., m] = des.webs[pid].intensity(c[..., m], g[..., m])
    return out * lum["scale"]


def _illuminance(des, lum, px, py, initial=False):
    """Horizontal illuminance (lx) at ground points (px, py) — maintained unless `initial`."""
    dx = px[:, None] - lum["x"][None, :]
    dy = py[:, None] - lum["y"][None, :]
    h = lum["h"][None, :]
    dz = -np.broadcast_to(h, dx.shape)
    near = np.abs(dx) <= LUM_RANGE_H * h
    I = _intensity_to(des, lum, dx, dy, dz)
    d3 = (dx * dx + dy * dy + h * h) ** 1.5
    E = np.where(near, I * h / d3, 0.0).sum(axis=1)
    return E if initial else E * des.mf


def _luminance(des, lum, px, py, rt: _RTable, ox, oy, sign):
    """Luminance (cd/m²) at points for an observer at (ox, oy) looking along sign·x."""
    dx = lum["x"][None, :] - px[:, None]          # point → luminaire
    dy = lum["y"][None, :] - py[:, None]
    h = lum["h"][None, :]
    beyond = sign * dx                            # + = past the point, away from the observer
    near = (beyond >= -LUM_NEAR_H * h) & (beyond <= LUM_FAR_H * h)
    I = _intensity_to(des, lum, -dx, -dy, -np.broadcast_to(h, dx.shape))
    rho = np.hypot(dx, dy)
    tan_g = rho / h
    vox = (px - ox)[:, None]; voy = (py - oy)[:, None]      # observer → point
    dot = vox * dx + voy * dy
    cross = np.hypot(vox, voy) * rho
    beta = np.degrees(np.arccos(np.clip(dot / np.maximum(cross, 1e-12), -1, 1)))
    beta = np.where(rho < 1e-9, 0.0, beta)
    r = rt.lookup(beta, tan_g)
    L = np.where(near & (tan_g <= TAN_MAX + 1e-9), I * r / (h * h), 0.0).sum(axis=1)
    return L * des.mf


def _threshold_increment(des, lum_far, ox, oy, sign, lav_init):
    """TI (%) for eyes at (ox[k], oy, 1.5) looking along sign·x, 1° down —
    the worst over the observer positions `ox` (scalar or array)."""
    if lav_init <= 0:
        return float("inf")
    ox = np.atleast_1d(np.asarray(ox, float))[:, None]          # K × 1
    ex = lum_far["x"][None, :] - ox
    ey = np.broadcast_to(lum_far["y"][None, :] - oy, ex.shape)
    ez = np.broadcast_to(lum_far["h"][None, :] - OBSERVER_EYE_M, ex.shape)
    ahead = sign * ex
    horiz = np.hypot(ex, ey)
    elev = np.degrees(np.arctan2(ez, horiz))
    ok = (ahead > 0) & (ahead <= TI_RANGE_M) & (elev <= TI_SCREEN_DEG)
    if not np.any(ok):
        return 0.0
    dist = np.sqrt(ex * ex + ey * ey + ez * ez)
    down = math.radians(TI_VIEW_DOWN_DEG)
    sx, sz = sign * math.cos(down), -math.sin(down)
    cos_t = np.clip((ex * sx + ez * sz) / np.maximum(dist, 1e-12), -1, 1)
    theta = np.degrees(np.arccos(cos_t))
    ok &= (theta >= 0.1) & (theta <= 60.0)
    I = _intensity_to(des, lum_far, -ex, -ey, -ez)       # luminaire → eye
    e_eye = I * cos_t / np.maximum(dist * dist, 1e-12)
    th = np.maximum(theta, 1e-9)
    # CIE disability glare: 9.86·[1 + (A/66.4)⁴]·E/θ² for 1.5° ≤ θ ≤ 60°, the
    # CIE 146 small-angle form below 1.5° (pigmentation factor 0).
    wide = 9.86 * (1 + (TI_AGE / 66.4) ** 4) * e_eye / th ** 2
    close = e_eye * (10.0 / th ** 3 + 5.0 / th ** 2 * (1 + (TI_AGE / 62.5) ** 4))
    lv = float(np.max(np.sum(np.where(ok, np.where(theta >= 1.5, wide, close), 0.0), axis=1)))
    if lav_init <= 5.0:
        return 65.0 * lv / lav_init ** 0.8
    return 95.0 * lv / lav_init ** 1.05


# ─── One layout at one spacing ──────────────────────────────────────────

def evaluate(des: _Design, S: float, full: bool = True, stop_on_fail: bool = False) -> dict:
    S = float(S)
    if S <= 0:
        raise ValueError("Spacing must be positive")
    xs, D = _long_points(S)
    hmax = max(r["height"] for r in des.rows)
    reach = max(LUM_RANGE_H, LUM_NEAR_H, LUM_FAR_H) * hmax + 1.0
    lum = _luminaires(des, S, -reach, S + reach)
    areas, all_pass = [], True
    lit_power_area = 0.0     # Σ Ē·A for the PDI
    lit_area = 0.0
    for idx, sec in enumerate(des.sections):
        res = {"index": sec["index"], "name": sec["name"], "type": sec["type"], "cls": sec["cls"],
               "family": sec["family"], "y0": round(sec["y0"], 3), "y1": round(sec["y1"], 3),
               "width": sec["width"], "checks": [], "pass": None}
        ys = _trans_points(sec["y0"], sec["width"])
        gx, gy = np.meshgrid(xs, ys, indexing="ij")
        E = _illuminance(des, lum, gx.ravel(), gy.ravel()).reshape(gx.shape)
        e_av = float(E.mean())
        res["Eav"], res["Emin"], res["Emax"] = e_av, float(E.min()), float(E.max())
        res["UoE"] = float(E.min() / e_av) if e_av > 0 else 0.0
        if full:
            res["gridE"] = {"x": xs.round(3).tolist(), "y": ys.round(3).tolist(), "v": E.round(3).tolist()}
        if sec["family"]:
            lit_power_area += e_av * sec["width"] * S
            lit_area += sec["width"] * S
        fam = sec["family"]
        if des.standard == "SANS":
            _sans_checks(des, sec, res, xs, D, S, lum, full, E)
        elif fam == "M" and sec["type"] == "carriageway":
            _luminance_checks(des, sec, res, xs, D, S, lum, full)
        elif fam == "C":
            req = C_CLASSES[sec["cls"]]
            res["checks"] = [
                _chk("Eav", "Ē", e_av, req["Eav"], ">=", "lx"),
                _chk("Uo", "Uo", res["UoE"], req["Uo"], ">=", ""),
            ]
        elif fam == "P":
            req = P_CLASSES[sec["cls"]]
            res["checks"] = [
                _chk("Eav", "Ē", e_av, req["Eav"], ">=", "lx"),
                _chk("Emin", "Emin", res["Emin"], req["Emin"], ">=", "lx"),
            ]
            if e_av > 1.5 * req["Eav"]:
                res["note"] = f"Ē is more than 1.5 × the {sec['cls']} value — over-lit (EN 13201-2 advises ≤ 1.5 ×)"
        elif fam == "M":
            res["note"] = "M classes apply to a carriageway — this strip is not checked"
        if res["checks"]:
            res["pass"] = all(c["pass"] for c in res["checks"])
            all_pass = all_pass and res["pass"]
        areas.append(res)
        if stop_on_fail and res["pass"] is False:
            return {"spacing": S, "pass": False, "areas": areas, "partial": True}

    power = sum(r["watts"] for r in des.rows)
    poles = len({(r["pole"] if r.get("pole") not in (None, "") else f"row{r['index']}", round(r["xOffset"] % 1.0, 3)) for r in des.rows})
    energy = {
        "powerPerFieldW": round(power, 2),
        "wPerKm": round(power * 1000.0 / S, 1),
        "polesPerKm": round(poles * 1000.0 / S, 2),
        "luminairesPerKm": round(len(des.rows) * 1000.0 / S, 2),
        "pdi": round(power / lit_power_area, 4) if lit_power_area > 0 else None,        # W/(lx·m²)
        "aeci": round(power * des.hours / 1000.0 / lit_area, 3) if lit_area > 0 else None,  # kWh/(m²·yr)
    }
    out = {"spacing": S, "pass": all_pass, "areas": areas, "energy": energy,
           "grid": {"nLong": len(xs), "D": round(D, 3)}}
    if full:
        out["isolux"] = _display_grid(des, S, lum)
        out["luminaires"] = [
            {"x": round(float(x), 3), "y": round(float(y), 3), "h": float(h), "row": int(r)}
            for x, y, h, r in zip(lum["x"], lum["y"], lum["h"], lum["row"]) if -1e-9 <= x <= S + 1e-9
        ]
    return out


def _luminance_checks(des, sec, res, xs, D, S, lum, full):
    req = M_CLASSES[sec["cls"]]
    rt = _RTable(sec["surface"])
    lanes = sec["lanes"]
    wl = sec["width"] / lanes
    ys = np.concatenate([sec["y0"] + k * wl + (np.arange(3) + 0.5) * wl / 3 for k in range(lanes)])
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    px, py = gx.ravel(), gy.ravel()
    sign = -1.0 if sec["direction"] == "reverse" else 1.0
    ox0 = -OBSERVER_BACK_M if sign > 0 else S + OBSERVER_BACK_M
    # TI observer (§8.5): starts 2.75·(H − 1.5) before the first luminaire in
    # front of the field — the distance at which the 20° roof screen uncovers it
    # — and moves forward over the field in steps of D.
    r0 = des.rows[0]
    first = (r0["xOffset"] % 1.0) * S if sign > 0 else S - ((1.0 - r0["xOffset"] % 1.0) % 1.0) * S
    ti_x0 = first - sign * 2.75 * max(r0["height"] - OBSERVER_EYE_M, 0.0)
    far = _luminaires(des, S, min(ti_x0, 0.0) - 10, S + TI_RANGE_M + 10) if sign > 0 else \
        _luminaires(des, S, -TI_RANGE_M - 10, max(ti_x0, S) + 10)
    obs = []
    for k in range(lanes):
        oy = sec["y0"] + (k + 0.5) * wl
        L = _luminance(des, lum, px, py, rt, ox0, oy, sign).reshape(gx.shape)
        lav = float(L.mean())
        uo = float(L.min() / lav) if lav > 0 else 0.0
        centre = L[:, 3 * k + 1]
        ul = float(centre.min() / centre.max()) if centre.max() > 0 else 0.0
        lav_init = lav / des.mf
        # observer moved over one field in steps of D
        ti = _threshold_increment(des, far, ti_x0 + sign * np.arange(len(xs)) * D, oy, sign, lav_init)
        obs.append({"lane": k + 1, "y": round(oy, 3), "Lav": lav, "Uo": uo, "Ul": ul, "TI": ti,
                    "grid": L})
    worst = min(obs, key=lambda o: o["Lav"])
    res["Lav"] = min(o["Lav"] for o in obs)
    res["Uo"] = min(o["Uo"] for o in obs)
    res["Ul"] = min(o["Ul"] for o in obs)
    res["TI"] = max(o["TI"] for o in obs)
    res["surface"] = rt.name
    res["observers"] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in o.items() if k != "grid"} for o in obs]
    res["REI"], res["REIsides"] = _edge_ratio(des, sec, xs, lum)
    if full:
        res["gridL"] = {"x": xs.round(3).tolist(), "y": ys.round(3).tolist(), "v": worst["grid"].round(4).tolist(),
                        "observerLane": worst["lane"]}
    res["checks"] = [
        _chk("Lav", "L̄", res["Lav"], req["Lav"], ">=", "cd/m²"),
        _chk("Uo", "Uo", res["Uo"], req["Uo"], ">=", ""),
        _chk("Ul", "Ul", res["Ul"], req["Ul"], ">=", ""),
        _chk("TI", "TI", res["TI"], req["TI"], "<=", "%"),
    ]
    if res["REI"] is not None:
        res["checks"].append(_chk("REI", "REI", res["REI"], req["REI"], ">=", ""))


def _sans_checks(des, sec, res, xs, D, S, lum, full, E):
    """SANS 10098-1 / -2 checks for one strip (res already holds its Ē grid)."""
    fam, cls = sec["family"], sec["cls"]
    if fam == "A":
        if sec["type"] != "carriageway":
            res["note"] = "Group A categories apply to a carriageway — this strip is not checked"
            return
        _sans_luminance(des, sec, res, xs, D, S, lum, full)
    elif fam == "B":
        # On a carriageway the area runs onto the footways up to 2 m from each
        # edge (Table 2 note a); on a footway / pedestrian strip, just the strip.
        y0, y1 = sec["y0"], sec["y1"]
        if sec["type"] == "carriageway":
            i = des.sections.index(sec)
            y0 -= _footway_reach(des, i, -1)
            y1 += _footway_reach(des, i, +1)
            if y1 - y0 > sec["width"] + 1e-9:
                ys = _trans_points(y0, y1 - y0)
                gx, gy = np.meshgrid(xs, ys, indexing="ij")
                E = _illuminance(des, lum, gx.ravel(), gy.ravel()).reshape(gx.shape)
                res["Eav"], res["Emin"], res["Emax"] = float(E.mean()), float(E.min()), float(E.max())
                res["UoE"] = float(E.min() / E.mean()) if E.mean() > 0 else 0.0
                res["areaY"] = [round(y0, 3), round(y1, 3)]
                if full:
                    res["gridE"] = {"x": xs.round(3).tolist(), "y": ys.round(3).tolist(), "v": E.round(3).tolist()}
        req = SANS_BC[cls]
        res["checks"] = [
            _chk("Eav", "Ē", res["Eav"], req["Eav"], ">=", "lx"),
            _chk("Emin", "Emin", res["Emin"], req["Emin"], ">=", "lx"),
        ]
        res["note"] = (f"Semi-cylindrical Esc,min {req['Esc']} lx (supplementary, for higher-security areas) is not calculated."
                       + (f" Area includes the footways up to {SANS_FOOTWAY_M:g} m from the carriageway edge ({res['areaY'][0]:g}–{res['areaY'][1]:g} m)."
                          if res.get("areaY") else ""))
    elif fam == "RC":
        req = SANS_RC[cls]
        res["checks"] = [
            _chk("Eav", "Ē", res["Eav"], req["Eav"], ">=", "lx"),
            _chk("Uo", "Uo", res["UoE"], req["Uo"], ">=", ""),
        ]
    elif fam == "CP":
        req = SANS_CP[cls]
        res["checks"] = [
            _chk("Eav", "Ē", res["Eav"], req["Eav"], ">=", "lx"),
            _chk("Emin", "Emin", res["Emin"], req["Emin"], ">=", "lx"),
        ]


def _footway_reach(des, i, step):
    """How far (≤ 2 m) the strips beside carriageway i extend on one side,
    stopping at another carriageway or a median."""
    reach, j = 0.0, i + step
    while 0 <= j < len(des.sections) and reach < SANS_FOOTWAY_M - 1e-9:
        nb = des.sections[j]
        if nb["type"] in ("carriageway", "median"):
            break
        reach += nb["width"]
        j += step
    return min(reach, SANS_FOOTWAY_M)


def _sans_luminance(des, sec, res, xs, D, S, lum, full):
    """SANS 10098-1 §4.1.3 / Appendix D: L̄ and Uo from ONE observer a quarter
    of the carriageway width in from the left-hand side (for traffic travelling
    towards −x, the left is the high-y side); Ul along each lane's centre line
    with the observer in that lane; TI at the conventional (quarter-width)
    observer. Calculation per CIE 140 — the same grid and luminaire inclusion
    as EN 13201-3."""
    band_set = "median" if des.has_median else "noMedian"
    ln, uo_req, ul_req, ti_req = SANS_A[sec["cls"]][band_set][sec["volume"]]
    rt = _RTable(sec["surface"])
    lanes = sec["lanes"]
    wl = sec["width"] / lanes
    ys = np.concatenate([sec["y0"] + k * wl + (np.arange(3) + 0.5) * wl / 3 for k in range(lanes)])
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    px, py = gx.ravel(), gy.ravel()
    sign = -1.0 if sec["direction"] == "reverse" else 1.0
    ox0 = -OBSERVER_BACK_M if sign > 0 else S + OBSERVER_BACK_M
    r0 = des.rows[0]
    first = (r0["xOffset"] % 1.0) * S if sign > 0 else S - ((1.0 - r0["xOffset"] % 1.0) % 1.0) * S
    ti_x0 = first - sign * 2.75 * max(r0["height"] - OBSERVER_EYE_M, 0.0)
    far = _luminaires(des, S, min(ti_x0, 0.0) - 10, S + TI_RANGE_M + 10) if sign > 0 else \
        _luminaires(des, S, -TI_RANGE_M - 10, max(ti_x0, S) + 10)
    oy_q = sec["y0"] + sec["width"] / 4 if sign > 0 else sec["y1"] - sec["width"] / 4
    Lq = _luminance(des, lum, px, py, rt, ox0, oy_q, sign).reshape(gx.shape)
    lav = float(Lq.mean())
    uo = float(Lq.min() / lav) if lav > 0 else 0.0
    ti = _threshold_increment(des, far, ti_x0 + sign * np.arange(len(xs)) * D, oy_q, sign, lav / des.mf)
    lanes_out = []
    for k in range(lanes):
        oy = sec["y0"] + (k + 0.5) * wl
        L = _luminance(des, lum, px, py, rt, ox0, oy, sign).reshape(gx.shape)
        centre = L[:, 3 * k + 1]
        lanes_out.append({"lane": k + 1, "y": round(oy, 3),
                          "Ul": round(float(centre.min() / centre.max()) if centre.max() > 0 else 0.0, 4)})
    res["Lav"], res["Uo"], res["TI"] = lav, uo, ti
    res["Ul"] = min(o["Ul"] for o in lanes_out)
    res["surface"] = rt.name
    res["observer"] = {"y": round(oy_q, 3), "rule": "quarter of the carriageway width from the left-hand side"}
    res["observers"] = lanes_out
    res["volumeBand"] = SANS_VOLUME_BANDS[band_set][sec["volume"]]
    res["crossSection"] = "with median" if des.has_median else "without median"
    # Surround ratio ES (§3.6.1 d): a design parameter without a tabulated
    # limit — reported, not checked.
    rei, sides = _edge_ratio(des, sec, xs, lum)
    res["ES"], res["ESsides"] = rei, sides
    if full:
        res["gridL"] = {"x": xs.round(3).tolist(), "y": ys.round(3).tolist(), "v": Lq.round(4).tolist(),
                        "observerY": round(oy_q, 3)}
    res["checks"] = [
        _chk("Lav", "L̄", lav, ln, ">=", "cd/m²"),
        _chk("Uo", "Uo", uo, uo_req, ">=", ""),
        _chk("Ul", "Ul", res["Ul"], ul_req, ">=", ""),
        _chk("TI", "TI", ti, ti_req, "<=", "%"),
    ]


def _edge_ratio(des, sec, xs, lum):
    """REI: Ē of a strip just outside each carriageway edge over Ē of the strip
    just inside it, strip width min(5 m, half the carriageway). An edge that
    abuts another carriageway has no 'outside' and is skipped."""
    w = min(5.0, sec["width"] / 2.0)
    i = des.sections.index(sec)
    sides = []
    for side in ("left", "right"):
        nb = des.sections[i - 1] if side == "left" and i > 0 else \
            (des.sections[i + 1] if side == "right" and i + 1 < len(des.sections) else None)
        if nb is not None and nb["type"] == "carriageway":
            continue
        edge = sec["y0"] if side == "left" else sec["y1"]
        y_in = _trans_points(edge if side == "left" else edge - w, w)
        y_out = _trans_points(edge - w if side == "left" else edge, w)
        ev = []
        for yy in (y_in, y_out):
            gx, gy = np.meshgrid(xs, yy, indexing="ij")
            ev.append(float(_illuminance(des, lum, gx.ravel(), gy.ravel()).mean()))
        rei = ev[1] / ev[0] if ev[0] > 0 else 0.0
        sides.append({"side": side, "Ein": round(ev[0], 3), "Eout": round(ev[1], 3), "REI": round(rei, 4)})
    if not sides:
        return None, []
    return min(s["REI"] for s in sides), sides


def _chk(key, label, value, req, op, unit):
    ok = value >= req - 1e-9 if op == ">=" else value <= req + 1e-9
    return {"key": key, "label": label, "value": round(float(value), 4) if math.isfinite(value) else None,
            "req": req, "op": op, "unit": unit, "pass": bool(ok)}


def _display_grid(des, S, lum):
    """Fine illuminance grid over the whole cross-section for the isolux plot."""
    y_lo = 0.0
    y_hi = des.width
    nx = int(min(81, max(21, math.ceil(S / 0.5) + 1)))
    ny = int(min(61, max(11, math.ceil((y_hi - y_lo) / 0.5) + 1)))
    x = np.linspace(0.0, S, nx)
    y = np.linspace(y_lo, y_hi, ny)
    gx, gy = np.meshgrid(x, y, indexing="ij")
    E = _illuminance(des, lum, gx.ravel(), gy.ravel()).reshape(gx.shape)
    return {"x": x.round(3).tolist(), "y": y.round(3).tolist(), "v": E.round(2).tolist()}


# ─── Solvers ────────────────────────────────────────────────────────────

def _spacings(cfg, default_lo=10.0, default_hi=60.0, default_step=1.0):
    lo = max(_f((cfg or {}).get("min"), default_lo), 1.0)
    hi = max(_f((cfg or {}).get("max"), default_hi), lo)
    step = max(_f((cfg or {}).get("step"), default_step), 0.1)
    n = int(math.floor((hi - lo) / step + 1e-9)) + 1
    return [round(lo + k * step, 3) for k in range(min(n, 400))]


def _summary(r):
    s = {"spacing": r["spacing"], "pass": r["pass"]}
    for a in r["areas"]:
        if a.get("checks"):
            s.setdefault("worst", [])
            for c in a["checks"]:
                if not c["pass"]:
                    s["worst"].append(f"{a['name']} {c['label']}")
    if "energy" in r:
        s["wPerKm"] = r["energy"]["wPerKm"]
        s["polesPerKm"] = r["energy"]["polesPerKm"]
    return s


def max_spacing(des: _Design, cfg: dict) -> dict:
    """Sweep every spacing; the answer is the LARGEST one that passes."""
    sweep = []
    best = None
    for S in _spacings(cfg):
        r = evaluate(des, S, full=False)
        row = _summary(r)
        row["metrics"] = _key_metrics(r)
        sweep.append(row)
        if r["pass"]:
            best = S
    result = evaluate(des, best, full=True) if best is not None else None
    return {"sweep": sweep, "best": best, "result": result}


def _key_metrics(r):
    out = {}
    for a in r["areas"]:
        for c in a.get("checks") or []:
            out[f"{a['index']}:{c['key']}"] = c["value"]
    return out


def _largest_passing(des, grid):
    """Largest passing spacing on `grid` (ascending). Bisects assuming pass(S)
    falls with S, then checks the next two steps above the boundary so a small
    non-monotonic bump is not missed."""
    def ok(i):
        return evaluate(des, grid[i], full=False, stop_on_fail=True)["pass"]
    if not ok(0):
        return None
    lo, hi = 0, len(grid) - 1
    if ok(hi):
        return hi
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if ok(mid):
            lo = mid
        else:
            hi = mid
    best = lo
    for j in (lo + 2, lo + 3):
        if j < len(grid) and ok(j):
            best = j
    return best


RANKS = {
    "wPerKm": (lambda e, S: e["wPerKm"], False),
    "polesPerKm": (lambda e, S: (e["polesPerKm"], e["wPerKm"]), False),
    "pdi": (lambda e, S: e["pdi"] if e["pdi"] is not None else 1e9, False),
    "spacing": (lambda e, S: S, True),
}


def optimise(des: _Design, cfg: dict) -> dict:
    t0 = time.time()
    base_row = (des.req.get("rows") or [{}])[0]
    def vals(key, cast=float):
        v = cfg.get(key)
        if not v:
            return [None]
        out = []
        for x in v:
            try:
                out.append(cast(x))
            except (TypeError, ValueError):
                pass
        return out or [None]
    heights, tilts, overhangs = vals("heights"), vals("tilts"), vals("overhangs")
    phots = [p for p in (cfg.get("photometryIds") or []) if p in des.webs] or [None]
    fluxes = vals("fluxPcts")
    combos = list(itertools.product(heights, tilts, overhangs, phots, fluxes))
    cap = int(_f(cfg.get("maxCombos"), 1500))
    skipped = max(0, len(combos) - cap)
    combos = combos[:cap]
    grid = _spacings(cfg.get("spacing") or {})
    rank_key, desc = RANKS.get(cfg.get("rank") or "wPerKm", RANKS["wPerKm"])
    found, evaluated = [], 0
    for h, t, o, p, fl in combos:
        d2 = des.with_params(height=h, tilt=t, overhang=o, photometryId=p, fluxPct=fl)
        i = _largest_passing(d2, grid)
        evaluated += 1
        if i is None:
            continue
        S = grid[i]
        r = evaluate(d2, S, full=False)
        found.append({
            "height": h if h is not None else base_row.get("height"),
            "tilt": t if t is not None else base_row.get("tilt", 0),
            "overhang": o if o is not None else base_row.get("overhang", 0),
            "photometryId": p if p is not None else base_row.get("photometryId"),
            "fluxPct": fl if fl is not None else base_row.get("fluxPct", 100),
            "spacing": S, "energy": r["energy"], "metrics": _key_metrics(r),
        })
    found.sort(key=lambda f: rank_key(f["energy"], f["spacing"]), reverse=desc)
    return {"options": found[:int(_f(cfg.get("top"), 50))], "nPassing": len(found),
            "nEvaluated": evaluated, "nSkipped": skipped, "seconds": round(time.time() - t0, 2),
            "rank": cfg.get("rank") or "wPerKm"}


def run_road_lighting(req: dict) -> dict:
    des = _Design(req)
    mode = req.get("mode") or "verify"
    if mode == "maxSpacing":
        return {"mode": mode, **max_spacing(des, req.get("spacingSweep") or {})}
    if mode == "optimise":
        return {"mode": mode, **optimise(des, req.get("optimise") or {})}
    return {"mode": "verify", "result": evaluate(des, _f(req.get("spacing"), 30.0), full=True)}
