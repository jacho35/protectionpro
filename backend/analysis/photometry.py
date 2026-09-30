"""Luminaire photometry for road lighting — IES LM-63 and EULUMDAT (.ldt).

Every file is normalised to ONE canonical Type C web so the road-lighting engine
never has to know which format or symmetry it came from:

    c   — C-plane angles, ascending, 0 … 360 inclusive (360 repeats 0)
    g   — γ angles from nadir, ascending, 0 … 180 (or whatever the file measured)
    cd  — cd[i][j] = luminous intensity (candela, ABSOLUTE for the rated flux)
          in plane c[i] at angle g[j]
    lumens — the rated luminaire (or lamp) flux the candela values belong to
    watts  — rated system power

Frame (EN 13032-1 / EULUMDAT road convention): C0 runs along the road axis,
C90 points across the road to the street side, C angles increase anticlockwise
seen from above; γ = 0 straight down. A file using another convention is put
right with the entry's `rotate` setting (applied by the engine, not here).

The file's symmetry is expanded here (quadrant, bilateral about C0-C180 or
C90-C270, rotational), and an oversized web is resampled to at most 5° in C and
1° in γ — still far finer than the EN 13201-3 grid it feeds — so a project
carrying a few luminaires stays small.
"""

from __future__ import annotations

import math
import re

import numpy as np

MAX_DC = 5.0     # coarsest C step kept when resampling a finer file (°)
MAX_DG = 1.0     # coarsest γ step kept when resampling a finer file (°)


# ─── Canonical web helpers ──────────────────────────────────────────────

def _full_circle(c_list, rows, mirror):
    """Expand measured half-planes to a full 0…360 web.

    `mirror(c)` maps any C in [0, 360) to the measured C it equals by symmetry.
    Returns (c_full, cd_full) on the file's own C step, 360 included.
    """
    c_arr = np.asarray(c_list, dtype=float)
    rows = np.asarray(rows, dtype=float)
    if len(c_arr) == 1:
        return np.array([0.0, 360.0]), np.vstack([rows[0], rows[0]])
    steps = np.diff(c_arr)
    dc = float(np.min(steps[steps > 1e-9])) if np.any(steps > 1e-9) else 5.0
    n = int(round(360.0 / dc))
    c_full = np.linspace(0.0, 360.0, n + 1)
    out = np.empty((len(c_full), rows.shape[1]))
    for i, c in enumerate(c_full):
        cm = mirror(c % 360.0)
        out[i] = _interp_rows(c_arr, rows, cm)
    return c_full, out


def _interp_rows(c_arr, rows, c):
    """Linear interpolation between measured planes (no wrap — callers mirror first)."""
    if c <= c_arr[0] + 1e-9:
        return rows[0]
    if c >= c_arr[-1] - 1e-9:
        return rows[-1]
    j = int(np.searchsorted(c_arr, c))
    t = (c - c_arr[j - 1]) / (c_arr[j] - c_arr[j - 1])
    return rows[j - 1] * (1 - t) + rows[j] * t


def _resample(c, g, cd):
    """Coarsen a web finer than MAX_DC × MAX_DG onto a uniform grid."""
    c = np.asarray(c, float); g = np.asarray(g, float); cd = np.asarray(cd, float)
    dc = float(np.min(np.diff(c))) if len(c) > 1 else 360.0
    dg = float(np.min(np.diff(g))) if len(g) > 1 else 180.0
    if dc >= MAX_DC - 1e-9 and dg >= MAX_DG - 1e-9:
        return c, g, cd
    if dc < MAX_DC - 1e-9:
        c2 = np.linspace(0.0, 360.0, int(round(360.0 / MAX_DC)) + 1)
        cd = np.array([[np.interp(ci, c, cd[:, j]) for j in range(cd.shape[1])] for ci in c2])
        c = c2
    if dg < MAX_DG - 1e-9:
        g2 = np.arange(g[0], g[-1] + 1e-9, MAX_DG)
        if g2[-1] < g[-1] - 1e-9:
            g2 = np.append(g2, g[-1])
        cd = np.array([np.interp(g2, g, row) for row in cd])
        g = g2
    return c, g, cd


def total_flux(c, g, cd):
    """Luminous flux (lm) of a canonical web: ∫ I dΩ by zones.

    Each γ sample owns the zone half-way to its neighbours, each C plane the
    sector half-way to its neighbours (the full-circle web is uniform in C).
    """
    c = np.asarray(c, float); g = np.radians(np.asarray(g, float)); cd = np.asarray(cd, float)
    edges = np.concatenate([[g[0]], (g[1:] + g[:-1]) / 2, [g[-1]]])
    zone = np.cos(edges[:-1]) - np.cos(edges[1:])           # ∫ sin γ dγ per γ sample
    planes = cd[:-1] if abs(c[-1] - 360.0) < 1e-6 and abs(c[0]) < 1e-6 and len(c) > 1 else cd
    mean_i = planes.mean(axis=0)                            # uniform C spacing
    return float(2 * math.pi * np.sum(mean_i * zone))


def _canonical(name, manufacturer, c, g, cd, lumens, watts, fmt, extra=None):
    c, g, cd = _resample(c, g, cd)
    cd = np.clip(cd, 0.0, None)
    flux = total_flux(c, g, cd)
    prof = {
        "name": name.strip() or "Luminaire",
        "manufacturer": manufacturer.strip(),
        "format": fmt,
        "c": [round(float(x), 3) for x in c],
        "g": [round(float(x), 3) for x in g],
        "cd": [[round(float(v), 1) for v in row] for row in cd],
        "lumens": round(float(lumens if lumens and lumens > 0 else flux), 1),
        "fluxIntegrated": round(flux, 1),
        "watts": round(float(watts or 0), 2),
        "maxCd": round(float(cd.max()) if cd.size else 0.0, 1),
    }
    if extra:
        prof.update(extra)
    return prof


# ─── IES LM-63 ──────────────────────────────────────────────────────────

def parse_ies(text: str) -> dict:
    """IESNA LM-63 (1986/1991/1995/2002). Type C expected; A/B are flagged."""
    if not text or not text.strip():
        raise ValueError("Empty file")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    meta, tilt, i = {}, None, 0
    for i, raw in enumerate(lines):
        ln = raw.strip()
        if re.match(r"^TILT\s*=", ln, re.I):
            tilt = ln.split("=", 1)[1].strip().upper()
            i += 1
            break
        m = re.match(r"^\[([^\]]+)\]\s*(.*)$", ln)
        if m:
            meta.setdefault(m.group(1).upper(), m.group(2).strip())
    if tilt is None:
        raise ValueError("Not an IES photometric file (no TILT line)")
    nums = []
    for raw in lines[i:]:
        for tok in re.split(r"[\s,]+", raw.strip()):
            if tok:
                try:
                    nums.append(float(tok))
                except ValueError:
                    pass
    k = 0

    def take(n):
        nonlocal k
        if k + n > len(nums):
            raise ValueError("File ended mid-record — truncated or malformed")
        out = nums[k:k + n]
        k += n
        return out

    if tilt == "INCLUDE":
        take(1)
        nt = int(take(1)[0])
        take(nt); take(nt)
    (n_lamps, lm_per_lamp, cd_mult, n_v, n_h, phot_type, _units,
     _w, _l, _h) = take(10)
    ballast, _bp, watts = take(3)
    n_v, n_h = int(n_v), int(n_h)
    if n_v < 1 or n_h < 1:
        raise ValueError("Bad angle counts")
    v = take(n_v)
    h = take(n_h)
    raw = np.array(take(n_v * n_h), float).reshape(n_h, n_v) * (cd_mult or 1) * (ballast or 1)
    absolute = lm_per_lamp < 0
    lumens = 0.0 if absolute else abs(n_lamps or 1) * lm_per_lamp

    first, last = h[0], h[-1]
    if n_h == 1:
        mirror = lambda c: first  # noqa: E731 — rotational symmetry
    elif abs(first) < 1e-6 and abs(last - 90) < 1e-6:
        def mirror(c):
            c = c % 180.0
            return 180.0 - c if c > 90 else c
    elif abs(first) < 1e-6 and abs(last - 180) < 1e-6:
        mirror = lambda c: 360.0 - c if c > 180 else c  # noqa: E731
    elif abs(first - 90) < 1e-6 and abs(last - 270) < 1e-6:
        def mirror(c):
            return c if 90 <= c <= 270 else (180.0 - c) % 360.0
    else:  # full 0…360 (often stops at 355/357.5 — wrap to the first plane)
        hh = list(h) + ([h[0] + 360.0] if last < 360 - 1e-6 else [])
        rows = list(raw) + ([raw[0]] if last < 360 - 1e-6 else [])
        c_full, cd_full = _full_circle(hh, rows, lambda c: c)
        return _canonical(meta.get("LUMINAIRE") or meta.get("LUMCAT") or meta.get("TEST") or "",
                          meta.get("MANUFAC", ""), c_full, v, cd_full, lumens, watts, "IES",
                          _ies_extra(phot_type))
    c_full, cd_full = _full_circle(h, raw, mirror)
    return _canonical(meta.get("LUMINAIRE") or meta.get("LUMCAT") or meta.get("TEST") or "",
                      meta.get("MANUFAC", ""), c_full, v, cd_full, lumens, watts, "IES",
                      _ies_extra(phot_type))


def _ies_extra(phot_type):
    if int(phot_type) in (2, 3):
        return {"warning": f"Type {'B' if int(phot_type) == 2 else 'A'} photometry — evaluated on the Type C convention, so off-axis values are approximate"}
    return None


# ─── EULUMDAT ───────────────────────────────────────────────────────────

def parse_ldt(text: str) -> dict:
    """EULUMDAT (.ldt). Intensities are cd/klm of the lamp set's total flux."""
    if not text or not text.strip():
        raise ValueError("Empty file")
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]

    def num(idx):
        try:
            return float(lines[idx].replace(",", "."))
        except (IndexError, ValueError):
            raise ValueError(f"EULUMDAT line {idx + 1} is not a number — not an .ldt file?")

    company = lines[0]
    isym = int(num(2))
    mc, dc, ng, dg = int(num(3)), num(4), int(num(5)), num(6)
    name = lines[8] if len(lines) > 8 else ""
    conv = num(23) or 1.0
    tilt = num(24)
    n_sets = int(num(25))
    if mc < 1 or ng < 1 or n_sets < 1:
        raise ValueError("Bad EULUMDAT header (plane / angle / lamp-set counts)")
    base = 26
    lamps = [num(base + s) for s in range(n_sets)]
    base += n_sets * 2                     # number of lamps, lamp type (text)
    fluxes = [num(base + s) for s in range(n_sets)]
    base += n_sets * 3                     # flux, colour temperature, CRI (text)
    watts = [num(base + s) for s in range(n_sets)]
    base += n_sets
    base += 10                             # direct ratios
    c_all = [num(base + s) for s in range(mc)]
    base += mc
    g = [num(base + s) for s in range(ng)]
    base += ng

    if isym == 1:
        planes = [0]
    elif isym == 2:
        planes = list(range(0, mc // 2 + 1))
    elif isym == 3:
        start = int(round(90.0 / dc)) if dc > 0 else mc // 4
        planes = list(range(start, start + mc // 2 + 1))
    elif isym == 4:
        planes = list(range(0, mc // 4 + 1))
    else:
        planes = list(range(mc))
    vals = []
    for s in range(len(planes) * ng):
        vals.append(num(base + s))
    rows = np.array(vals, float).reshape(len(planes), ng)
    flux_total = sum(abs(f) for f in fluxes) or 1000.0
    rows = rows * conv * flux_total / 1000.0
    c_meas = [c_all[p] if p < len(c_all) else p * dc for p in planes]

    if isym == 1:
        mirror = lambda c: c_meas[0]  # noqa: E731
    elif isym == 2:
        mirror = lambda c: 360.0 - c if c > 180 else c  # noqa: E731
    elif isym == 3:
        def mirror(c):
            return c if 90 <= c <= 270 else (180.0 - c) % 360.0
    elif isym == 4:
        def mirror(c):
            c = c % 180.0
            return 180.0 - c if c > 90 else c
    else:
        c_meas = list(c_meas) + [360.0]
        rows = np.vstack([rows, rows[0]])
        mirror = lambda c: c  # noqa: E731
    c_full, cd_full = _full_circle(c_meas, rows, mirror)
    extra = {}
    if abs(tilt) > 1e-6:
        extra["measurementTilt"] = tilt
    return _canonical(name, company, c_full, g, cd_full, flux_total,
                      sum(watts) if watts else 0, "LDT", extra or None)


def parse_photometry(text: str, filename: str = "") -> dict:
    """Pick the parser from the file name, else from the content."""
    fn = (filename or "").lower()
    if fn.endswith(".ldt") or fn.endswith(".eul"):
        return parse_ldt(text)
    if fn.endswith(".ies") or re.search(r"^\s*TILT\s*=", text or "", re.M | re.I):
        return parse_ies(text)
    return parse_ldt(text)


# ─── Generic road optics (feasibility only — not a real product) ────────
#
# A smooth road distribution: two throw lobes angled a little towards the street
# (either side of the C90 plane, so it is bilateral along the road), a broad
# street-biased base, house-side cut-off and full cut-off above ~80°. Tuned so
# the peak sits where real road optics put it (γ 60–70°). Scaled to `lumens`.

GENERIC_OPTICS = {
    "generic_narrow": {"name": "Generic road optic — narrow (1–2 lanes)", "gl": 64.0, "cl": 12.0, "sig": 13.0, "base": 0.28, "house": 0.30},
    "generic_medium": {"name": "Generic road optic — medium (2–3 lanes)", "gl": 68.0, "cl": 20.0, "sig": 14.0, "base": 0.24, "house": 0.28},
    "generic_wide":   {"name": "Generic road optic — wide (3–4 lanes)",   "gl": 70.0, "cl": 30.0, "sig": 16.0, "base": 0.22, "house": 0.26},
}


def generic_optic(kind: str, lumens: float = 10000.0, watts: float = 80.0) -> dict:
    spec = GENERIC_OPTICS.get(kind)
    if not spec:
        raise ValueError(f"Unknown generic optic '{kind}'")
    c = np.arange(0.0, 360.0 + 1e-9, 5.0)
    g = np.arange(0.0, 180.0 + 1e-9, 1.0)
    C, G = np.meshgrid(np.radians(c), np.radians(g), indexing="ij")
    d = np.stack([np.sin(G) * np.cos(C), np.sin(G) * np.sin(C), -np.cos(G)], axis=-1)

    def lobe(c_deg, g_deg, sig):
        cc, gg = math.radians(c_deg), math.radians(g_deg)
        ax = np.array([math.sin(gg) * math.cos(cc), math.sin(gg) * math.sin(cc), -math.cos(gg)])
        ang = np.degrees(np.arccos(np.clip(d @ ax, -1, 1)))
        return np.exp(-(ang / sig) ** 2 / 2)

    cl, gl, sig = spec["cl"], spec["gl"], spec["sig"]
    lobes = lobe(cl, gl, sig) + lobe(180 - cl, gl, sig)
    down = np.clip(np.cos(G), 0, None)
    base = spec["base"] * down * (1 + 0.6 * np.sin(G) * np.sin(C))
    rel = lobes + base
    house = np.where(np.sin(C) < 0, np.exp(-((np.sin(G) * np.abs(np.sin(C))) / spec["house"]) ** 2), 1.0)
    cutoff = np.clip((85.0 - np.degrees(G)) / 10.0, 0, 1)
    rel = rel * house * cutoff
    flux_rel = total_flux(c, g, rel)
    cd = rel * (lumens / flux_rel)
    return _canonical(spec["name"], "Generic", c, g, cd, lumens, watts, "generic",
                      {"generic": kind, "warning": "Generic distribution for feasibility — not a real product. Import the manufacturer's IES/LDT for a compliance design."})
