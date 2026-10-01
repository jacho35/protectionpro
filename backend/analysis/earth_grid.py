"""Earth grid of any shape — method-of-moments solve and surface potentials.

The simplified IEEE 80 equations (grounding_system.py) cover equally spaced
square, rectangular, T, triangular and L-shaped grids only (IEEE 80-2013
§16.5, Annex D). Anything else — diagonal conductors, uneven spacing, rods
anywhere, separately earthed fences — needs "computer analysis" (§16.8):
model each conductor, solve for the current it leaks into the soil, then
compute the potential at any surface point. That is what this module does.

Model (quasi-static, 50/60 Hz):
  * Soil: uniform ρ1, or two horizontal layers ρ1 (thickness H) over ρ2.
    The point-source Green's functions are the image series checked in
    GROUNDING_REVIEW.md (`grounding_system._mom_images`).
  * Metal: straight thin wires (grid conductors, rods, fence wires, posts),
    each cut into elements carrying a constant leakage current per metre.
    Thin-wire kernel: field point on the element axis, source current on its
    axis seen from radius a.
  * Every conductor in one *group* is at the same potential. Group 0 is the
    energised grid, held at GPR = 1 V. Every other group is unbonded metal
    (a separately earthed fence, a pipe) whose potential floats: it takes no
    net current, and the solve returns its potential.
  * Collocation at element mid-points: [G]·I = V.

Results are per volt of GPR; `R_g = 1 / ΣI(group 0)` and every voltage scales
linearly with the grid current, so one solve serves every fault location
(bus) that shares the grid.
"""

import math

import numpy as np

from .grounding_system import (
    _MOM_SCALE, _mom_images, _mom_prefactor, _segment_integral,
)

# Element length: at most this, and at most this fraction of the conductor
# spacing near it. Chosen by the refinement study (EARTH_GRID_REVIEW.md).
DEFAULT_MAX_ELEMENT_M = 1.0
MAX_ELEMENTS = 4000
# IEEE 80 §7.3 models the foot as a 0.08 m radius disc. A surface point is
# never closer than that to an electrode that reaches the surface (a fence
# post): the potential on the post's own axis is not a place anyone stands.
FOOT_RADIUS_M = 0.08


# ── discretisation ──────────────────────────────────────────────────────────

def _seg_params(p, r, q, s):
    """Intersection parameters (t on p→p+r, u on q→q+s) of two 2-D segments.
    Returns a list of (t, u) pairs: one for a crossing / T-junction, the
    overlap end points for collinear overlapping segments, [] otherwise."""
    rxs = r[0] * s[1] - r[1] * s[0]
    qp = q - p
    rr = float(r @ r)
    ss = float(s @ s)
    tol = 1e-9
    if abs(rxs) > tol * math.sqrt(rr * ss):
        t = (qp[0] * s[1] - qp[1] * s[0]) / rxs
        u = (qp[0] * r[1] - qp[1] * r[0]) / rxs
        if -tol <= t <= 1 + tol and -tol <= u <= 1 + tol:
            return [(min(max(t, 0.0), 1.0), min(max(u, 0.0), 1.0))]
        return []
    # parallel: collinear?
    if abs(qp[0] * r[1] - qp[1] * r[0]) > 1e-7 * math.sqrt(rr):
        return []
    out = []
    for t in ((qp @ r) / rr, ((qp + s) @ r) / rr):       # q ends on p
        if -tol <= t <= 1 + tol:
            out.append((min(max(t, 0.0), 1.0), None))
    for u in ((-qp) @ s / ss, ((-qp) + r) @ s / ss):     # p ends on q
        if -tol <= u <= 1 + tol:
            out.append((None, min(max(u, 0.0), 1.0)))
    return out


def split_at_intersections(wires):
    """Split every horizontal wire where it crosses, meets or overlaps
    another horizontal wire at the same depth, and drop duplicate pieces.

    Crossings must be nodes: a crossing inside two elements puts two
    collocation points on the same spot and makes the system near-singular
    (seen on the Annex H Grid 6 diagonals). Collinear duplicates would do
    the same. Vertical/inclined wires (rods) are left whole."""
    wires = [dict(w, a=tuple(map(float, w["a"])), b=tuple(map(float, w["b"]))) for w in wires]
    horiz = [i for i, w in enumerate(wires) if abs(w["a"][2] - w["b"][2]) < 1e-9]
    cuts = {i: {0.0, 1.0} for i in horiz}
    for ii, i in enumerate(horiz):
        wi = wires[i]
        p = np.array(wi["a"][:2])
        r = np.array(wi["b"][:2]) - p
        for j in horiz[ii + 1:]:
            wj = wires[j]
            if abs(wi["a"][2] - wj["a"][2]) > 1e-9:
                continue
            q = np.array(wj["a"][:2])
            sv = np.array(wj["b"][:2]) - q
            for t, u in _seg_params(p, r, q, sv):
                if t is not None:
                    cuts[i].add(round(t, 12))
                if u is not None:
                    cuts[j].add(round(u, 12))
    # rod tops / other wires' end points lying on a horizontal wire join it there
    for i in horiz:
        wi = wires[i]
        a = np.array(wi["a"])
        b = np.array(wi["b"])
        ab = b - a
        L2 = float(ab @ ab)
        for j, wj in enumerate(wires):
            if j == i or j in horiz:
                continue
            for e in (wj["a"], wj["b"]):
                pe = np.array(e)
                if abs(pe[2] - a[2]) > 1e-6:
                    continue
                t = float((pe - a) @ ab) / L2
                if 1e-9 < t < 1 - 1e-9 and np.linalg.norm(a + ab * t - pe) < 1e-6:
                    cuts[i].add(round(t, 12))
    out = []
    seen = {}
    for i, w in enumerate(wires):
        if i not in cuts:
            out.append(w)
            continue
        a = np.array(w["a"])
        b = np.array(w["b"])
        ts = sorted(cuts[i])
        for t0, t1 in zip(ts[:-1], ts[1:]):
            if (t1 - t0) * np.linalg.norm(b - a) < 1e-6:
                continue
            pa = tuple(np.round(a + (b - a) * t0, 6))
            pb = tuple(np.round(a + (b - a) * t1, 6))
            key = (min(pa, pb), max(pa, pb), int(w.get("group", 0)))
            if key in seen:                       # overlap: keep the thicker
                k = seen[key]
                out[k]["radius"] = max(out[k]["radius"], float(w["radius"]))
                continue
            seen[key] = len(out)
            out.append(dict(w, a=pa, b=pb))
    return out


def discretise(wires, max_len=DEFAULT_MAX_ELEMENT_M, H=None, end_refine=True):
    """Cut wires into elements.

    wires: iterable of dicts {a: (x,y,z), b: (x,y,z), radius, group}
           (z positive DOWN, metres below the surface).
    Each wire is split into ⌈L / max_len⌉ equal pieces; with `end_refine`
    the first and last piece are halved again (the leakage density changes
    fastest at conductor ends and junctions). A wire crossing the layer
    boundary z = H is split there so no element straddles it.
    Returns (A, B, radius, group, kind) numpy arrays.
    """
    A, B, rad, grp, kind = [], [], [], [], []
    for w in split_at_intersections(wires):
        a = np.asarray(w["a"], float)
        b = np.asarray(w["b"], float)
        cuts = [0.0, 1.0]
        if H is not None and (a[2] - H) * (b[2] - H) < 0:
            cuts.append((H - a[2]) / (b[2] - a[2]))
        cuts = sorted(set(cuts))
        for t0, t1 in zip(cuts[:-1], cuts[1:]):
            p0 = a + (b - a) * t0
            p1 = a + (b - a) * t1
            L = float(np.linalg.norm(p1 - p0))
            if L <= 1e-9:
                continue
            n = max(1, int(math.ceil(L / max_len - 1e-9)))
            ts = list(np.linspace(0.0, 1.0, n + 1))
            if end_refine and n >= 2:
                ts = [0.0, 0.5 / n] + ts[1:-1] + [1.0 - 0.5 / n, 1.0]
            for s0, s1 in zip(ts[:-1], ts[1:]):
                A.append(p0 + (p1 - p0) * s0)
                B.append(p0 + (p1 - p0) * s1)
                rad.append(float(w["radius"]))
                grp.append(int(w.get("group", 0)))
                kind.append(str(w.get("kind", "grid")))
    return (np.array(A, float), np.array(B, float),
            np.array(rad, float), np.array(grp, int), np.array(kind, dtype=object))


# ── kernel ──────────────────────────────────────────────────────────────────

def _layer_of(z, H):
    if H is None:
        return np.ones(len(z), int)
    return np.where(z < H, 1, 2)


_EPS = 1e-4          # regularises the point kernel at zero separation (self pairs)
# A pair closer than this many element lengths gets the exact line integral;
# beyond it a point source is within about 0.5 % (worst case: along a rod's axis).
NEAR_LENGTHS = 4.0


def _r_grid(rmax):
    """Horizontal-distance nodes for the tabulated point kernel: 2.5 mm to
    2 m, 25 mm to 20 m, then geometric."""
    return np.concatenate([np.linspace(0.0, 2.0, 801), np.linspace(2.025, 20.0, 720),
                           np.geomspace(20.05, max(rmax, 20.1), 600)])


def _kernel(P, P_layer, A, B, radius, soil, I=None, chunk=2000):
    """Potential at points P from uniform leakage on elements (A, B), per
    ampere of element current, through the soil images.

    Returns the dense matrix M (I is None) or M @ I (chunked, for many points).

    Every (point, element) pair first gets the point-source value of all its
    images together, read from a table of Σ c/√(r² + Δz²) built once per pair
    of depths; the exact line integral then replaces the point value of each
    image for the near pairs (closer than NEAR_LENGTHS element lengths, found with
    a k-d tree).
    """
    from scipy.spatial import cKDTree
    rho1 = float(soil["rho1"])
    rho2 = float(soil.get("rho2", rho1))
    H = soil.get("H")
    K = (rho2 - rho1) / (rho2 + rho1) if H is not None else 0.0
    Hn = float(H) if H is not None else 1e9
    mids = 0.5 * (A + B)
    L = np.linalg.norm(B - A, axis=1)
    S_layer = _layer_of(mids[:, 2], H)
    nP, nS = P.shape[0], A.shape[0]
    out = np.zeros(nP) if I is not None else np.zeros((nP, nS))
    ext = np.concatenate([P[:, :2], mids[:, :2]])
    rg = _r_grid(float(np.linalg.norm(ext.max(0) - ext.min(0))) + 1.0)
    pkey = np.round(P[:, 2], 3)
    skey = np.round(mids[:, 2], 3)
    for fl in (1, 2):
        fi = np.where(P_layer == fl)[0]
        if fi.size == 0:
            continue
        ftree = cKDTree(P[fi])
        for sl in (1, 2):
            si = np.where(S_layer == sl)[0]
            if si.size == 0:
                continue
            images, far_const = _mom_images(K, Hn, fl, sl)
            pref = _mom_prefactor(rho1, rho2, fl, sl)
            if I is not None:
                out[fi] += pref * far_const * float(I[si].sum())
            elif far_const:
                out[np.ix_(fi, si)] += pref * far_const
            # tabulated point kernel, per (field depth, source depth)
            for fk in np.unique(pkey[fi]):
                fsel = fi[pkey[fi] == fk]
                for sk in np.unique(skey[si]):
                    ssel = si[skey[si] == sk]
                    dzs = [(pref * c, fk - (sign * sk + shift)) for c, sign, shift in images]
                    direct = len(images) <= 4          # uniform soil: cheaper than a table
                    if not direct:
                        tab = np.zeros_like(rg)
                        for c, dz in dzs:
                            tab += c / np.sqrt(rg * rg + dz * dz + _EPS * _EPS)
                    ms = mids[ssel, :2]
                    for c0 in range(0, fsel.size, chunk):
                        rows = fsel[c0:c0 + chunk]
                        q = P[rows, :2]
                        r2 = (q[:, None, 0] - ms[None, :, 0]) ** 2 + (q[:, None, 1] - ms[None, :, 1]) ** 2
                        if direct:
                            vals = sum(c / np.sqrt(r2 + dz * dz + _EPS * _EPS) for c, dz in dzs)
                        else:
                            vals = np.interp(np.sqrt(r2), rg, tab)
                        if I is not None:
                            out[rows] += vals @ I[ssel]
                        else:
                            out[np.ix_(rows, ssel)] += vals
            # near pairs: exact line integral in place of the point value
            for c, sign, shift in images:
                zc = sign * mids[si, 2] + shift
                cen = np.column_stack([mids[si, :2], zc])
                lists = ftree.query_ball_point(cen, NEAR_LENGTHS * L[si])
                cnt = np.fromiter((len(l) for l in lists), int, len(lists))
                if cnt.sum() == 0:
                    continue
                pl = fi[np.concatenate([np.asarray(l, int) for l in lists if len(l)])]
                e = si[np.repeat(np.arange(si.size), cnt)]
                Ai = A[e].copy()
                Bi = B[e].copy()
                Ai[:, 2] = sign * Ai[:, 2] + shift
                Bi[:, 2] = sign * Bi[:, 2] + shift
                exact = _pair_integral(P[pl], Ai, Bi, radius[e])
                d2 = ((P[pl, :2] - mids[e, :2]) ** 2).sum(1) + (P[pl, 2] - (sign * mids[e, 2] + shift)) ** 2
                point = 1.0 / np.sqrt(d2 + _EPS * _EPS)
                delta = pref * c * (exact - point)
                if I is not None:
                    np.add.at(out, pl, delta * I[e])
                else:
                    np.add.at(out, (pl, e), delta)
    return out


def potential_matrix(P, A, B, radius, soil, P_layer=None, S_layer=None):
    """M[i, j] = potential at point P[i] per ampere leaking uniformly from
    element j (dense)."""
    H = soil.get("H")
    if P_layer is None:
        P_layer = _layer_of(P[:, 2], H)
    return _kernel(P, P_layer, A, B, radius, soil)


# ── solve ───────────────────────────────────────────────────────────────────

class GridSolution:
    """Leakage currents of a solved grid (per volt of GPR on group 0)."""

    def __init__(self, A, B, radius, group, soil, I, V_group, kind=None):
        self.A, self.B, self.radius, self.group = A, B, radius, group
        self.kind = kind
        self.soil = soil
        self.I = I                    # element leakage current (A) per 1 V GPR
        self.V_group = V_group        # group potentials (V) per 1 V GPR; [0] = 1
        self.current_per_volt = float(I[group == 0].sum())
        self.R_g = 1.0 / self.current_per_volt

    def surface_potential(self, xy):
        """Surface potential (V per 1 V GPR) at points xy (N×2).

        A surface point is never closer than the foot radius to the axis of
        an electrode that reaches the surface (FOOT_RADIUS_M)."""
        xy = np.asarray(xy, float).reshape(-1, 2)
        P = np.column_stack([xy, np.zeros(len(xy))])
        top = np.minimum(self.A[:, 2], self.B[:, 2])
        rad = np.where(top < FOOT_RADIUS_M, np.maximum(self.radius, FOOT_RADIUS_M), self.radius)
        return _kernel(P, np.ones(len(xy), int), self.A, self.B, rad, self.soil, I=self.I)


def _pair_integral(P, A, B, a):
    """Row-wise `_segment_integral`: P[k] against element (A[k], B[k])."""
    AB = B - A
    L = np.linalg.norm(AB, axis=1)
    u = AB / L[:, None]
    AP = A - P
    t1 = np.einsum('ij,ij->i', AP, u)
    t2 = t1 + L
    perp2 = np.maximum(np.einsum('ij,ij->i', AP, AP) - t1 * t1, 0.0) + a * a
    rp = np.sqrt(perp2)
    return (np.arcsinh(t2 / rp) - np.arcsinh(t1 / rp)) / L


def solve(wires, soil, max_len=DEFAULT_MAX_ELEMENT_M, end_refine=True):
    """Solve a grid. wires as in `discretise`; soil {rho1, rho2, H}."""
    H = soil.get("H")
    A, B, rad, grp, kind = discretise(wires, max_len, H, end_refine)
    if A.shape[0] == 0:
        raise ValueError("The earth grid has no conductors.")
    if A.shape[0] > MAX_ELEMENTS:
        raise ValueError(f"The earth grid needs {A.shape[0]} elements (limit {MAX_ELEMENTS}); "
                         f"use a coarser element length.")
    if not np.any(grp == 0):
        raise ValueError("No conductor is bonded to the earth grid.")
    ext = np.concatenate([A[:, :2], B[:, :2]])
    _MOM_SCALE[0] = max(float(np.linalg.norm(ext.max(0) - ext.min(0))), 10.0)
    mid = 0.5 * (A + B)
    G = potential_matrix(mid, A, B, rad, soil)
    groups = sorted(set(int(g) for g in grp))
    floating = [g for g in groups if g != 0]
    n, k = A.shape[0], len(floating)
    if k == 0:
        I = np.linalg.solve(G, np.ones(n))
        V_group = {0: 1.0}
    else:
        # [G  −E] [I]   [b]      b = 1 on bonded rows, 0 on floating rows
        # [Eᵀ  0] [V] = [0]      Eᵀ: each floating group carries no net current
        E = np.zeros((n, k))
        for j, g in enumerate(floating):
            E[grp == g, j] = 1.0
        Mbig = np.block([[G, -E], [E.T, np.zeros((k, k))]])
        rhs = np.concatenate([(grp == 0).astype(float), np.zeros(k)])
        x = np.linalg.solve(Mbig, rhs)
        I = x[:n]
        V_group = {0: 1.0}
        V_group.update({g: float(x[n + j]) for j, g in enumerate(floating)})
    return GridSolution(A, B, rad, grp, soil, I, V_group, kind)


# ── geometry: an earth-grid object → wires ──────────────────────────────────
#
# A project stores each earth grid once (ProjectData.earthGrids); buses point
# to it by `earth_grid_id`. The layout generators give the common shapes; the
# extra conductor / rod lists and the fences add anything else.

def _f(v, default):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _lines(total, n, explicit):
    """Conductor positions along one side: explicit list, else n equal."""
    if explicit:
        pts = sorted({round(_f(p, 0.0), 6) for p in explicit if 0.0 <= _f(p, -1) <= total + 1e-9})
        pts = sorted(set(pts) | {0.0, round(total, 6)})
        return pts
    n = max(int(_f(n, 2)), 2)
    return [round(total * i / (n - 1), 6) for i in range(n)]


def layout_outline(layout):
    """Outline polygon of the generated layout (counter-clockwise), or None."""
    t = str(layout.get("type", "rect")).lower()
    Lx = _f(layout.get("length_x"), 30.0)
    Ly = _f(layout.get("width_y"), 30.0)
    if t == "rect":
        return [(0.0, 0.0), (Lx, 0.0), (Lx, Ly), (0.0, Ly)]
    if t == "l":
        nx = _f(layout.get("notch_x"), Lx / 2)
        ny = _f(layout.get("notch_y"), Ly / 2)
        return [(0.0, 0.0), (Lx, 0.0), (Lx, ny), (nx, ny), (nx, Ly), (0.0, Ly)]
    return None


def _inside_L(x, y, layout):
    """Point (x, y) inside or on the generated outline."""
    t = str(layout.get("type", "rect")).lower()
    if t != "l":
        return True
    nx = _f(layout.get("notch_x"), _f(layout.get("length_x"), 30.0) / 2)
    ny = _f(layout.get("notch_y"), _f(layout.get("width_y"), 30.0) / 2)
    return not (x > nx + 1e-6 and y > ny + 1e-6)


def _layout_wires(layout, depth, radius):
    """Mesh conductors of a rect / L layout, plus optional diagonals."""
    t = str(layout.get("type", "rect")).lower()
    if t not in ("rect", "l"):
        return [], []
    Lx = _f(layout.get("length_x"), 30.0)
    Ly = _f(layout.get("width_y"), 30.0)
    xs = _lines(Lx, layout.get("n_x", 6), layout.get("x_lines"))
    ys = _lines(Ly, layout.get("n_y", 6), layout.get("y_lines"))
    nx = _f(layout.get("notch_x"), Lx / 2) if t == "l" else Lx
    ny = _f(layout.get("notch_y"), Ly / 2) if t == "l" else Ly
    if t == "l":
        xs = sorted(set(xs) | {round(nx, 6)})
        ys = sorted(set(ys) | {round(ny, 6)})
    wires = []
    for x in xs:                                   # conductors along y
        top = Ly if x <= nx + 1e-6 else ny
        wires.append(dict(a=(x, 0.0, depth), b=(x, top, depth), radius=radius, group=0, kind="grid"))
    for y in ys:                                   # conductors along x
        right = Lx if y <= ny + 1e-6 else nx
        wires.append(dict(a=(0.0, y, depth), b=(right, y, depth), radius=radius, group=0, kind="grid"))
    diag = str(layout.get("diagonals", "none")).lower()
    if diag in ("corner_meshes", "all_meshes"):
        # a diagonal across each chosen mesh: through the outline corner in a
        # corner mesh, otherwise pointing away from the outline's centroid
        outline = layout_outline(layout)
        verts = {(round(v[0], 6), round(v[1], 6)) for v in outline}
        cx = sum(v[0] for v in outline) / len(outline)
        cy = sum(v[1] for v in outline) / len(outline)
        for i in range(len(xs) - 1):
            for j in range(len(ys) - 1):
                x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
                mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                if not _inside_L(mx, my, layout):
                    continue
                hit = [c for c in ((x0, y0), (x1, y1), (x0, y1), (x1, y0))
                       if (round(c[0], 6), round(c[1], 6)) in verts
                       and _is_convex_vertex(outline, c)]
                if diag == "corner_meshes" and not hit:
                    continue
                if hit:
                    c = hit[0]
                    a, b = c, (x0 + x1 - c[0], y0 + y1 - c[1])
                elif (mx - cx) * (my - cy) >= 0:
                    a, b = (x0, y0), (x1, y1)
                else:
                    a, b = (x0, y1), (x1, y0)
                wires.append(dict(a=(a[0], a[1], depth), b=(b[0], b[1], depth),
                                  radius=radius, group=0, kind="diagonal"))
    elif diag == "full":
        corners = layout_outline(layout)
        if t == "rect":
            pairs = [((0.0, 0.0), (Lx, Ly)), ((Lx, 0.0), (0.0, Ly))]
        else:  # L: a diagonal across each of the two rectangles
            pairs = [((0.0, 0.0), (Lx, ny)), ((Lx, 0.0), (0.0, ny)),
                     ((0.0, ny), (nx, Ly)), ((nx, ny), (0.0, Ly))]
        for a, b in pairs:
            wires.append(dict(a=(a[0], a[1], depth), b=(b[0], b[1], depth),
                              radius=radius, group=0, kind="diagonal"))
    nodes = [(x, y) for x in xs for y in ys if _inside_L(x, y, layout)]
    return wires, nodes


def _perimeter_walk(poly, spacing=None, count=None):
    """Points around a closed polygon: every `spacing` m, or `count` evenly
    (the first point is the first vertex; vertices are always included when
    spacing is given)."""
    segs = [(np.array(poly[i], float), np.array(poly[(i + 1) % len(poly)], float))
            for i in range(len(poly))]
    lens = [float(np.linalg.norm(b - a)) for a, b in segs]
    per = sum(lens)
    pts = []
    if count:
        for k in range(int(count)):
            s = per * k / int(count)
            for (a, b), L in zip(segs, lens):
                if s <= L + 1e-9:
                    pts.append(tuple(a + (b - a) * (s / L)))
                    break
                s -= L
        return pts
    for (a, b), L in zip(segs, lens):
        n = max(1, int(round(L / spacing)))
        for k in range(n):
            pts.append(tuple(a + (b - a) * (k / n)))
    return pts


def offset_polygon(poly, d):
    """Offset a simple polygon outward by d (inward for d < 0) — miter joins."""
    P = np.array(poly, float)
    n = len(P)
    area = 0.5 * sum(P[i, 0] * P[(i + 1) % n, 1] - P[(i + 1) % n, 0] * P[i, 1] for i in range(n))
    sgn = 1.0 if area > 0 else -1.0             # ccw → outward normal is (dy, −dx)
    out = []
    for i in range(n):
        p0, p1, p2 = P[i - 1], P[i], P[(i + 1) % n]
        e1 = (p1 - p0) / np.linalg.norm(p1 - p0)
        e2 = (p2 - p1) / np.linalg.norm(p2 - p1)
        n1 = sgn * np.array([e1[1], -e1[0]])
        n2 = sgn * np.array([e2[1], -e2[0]])
        m = n1 + n2
        m = m / np.linalg.norm(m)
        cos_half = float(m @ n1)
        out.append(tuple(p1 + m * d / max(cos_half, 0.2)))
    return out


def area_to_diameter_m(area_mm2):
    """Diameter of a solid round conductor of cross-section A (mm²):
    d = √(4A/π). A stranded conductor of the same area is about 10–15 %
    larger outside; the solid value is the smaller (conservative) radius."""
    return math.sqrt(4.0 * float(area_mm2) / math.pi) / 1000.0


def conductor_diameter_m(cond, default_m=0.01167):
    """Grid-conductor diameter for the geometry: a measured outside diameter
    (`diameter_m`) when given, else the solid-equivalent of the size
    (`area_mm2`, e.g. 70 mm²), else the default."""
    cond = cond or {}
    if cond.get("diameter_m") not in (None, ""):
        return _f(cond.get("diameter_m"), default_m)
    if cond.get("area_mm2") not in (None, ""):
        return area_to_diameter_m(cond["area_mm2"])
    return default_m


def _num_strict(v, what):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number (got {v!r}).")
    if not math.isfinite(x):
        raise ValueError(f"{what} must be a finite number.")
    return x


def validate_grid(grid):
    """Refuse geometry that cannot exist, with a message the editor shows.
    Called by build_wires, so both the preview and the study use it."""
    layout = grid.get("layout") or {}
    t = str(layout.get("type", "rect")).lower()
    cond = grid.get("conductor") or {}
    if cond.get("area_mm2") not in (None, "") and _num_strict(cond["area_mm2"], "Conductor size") <= 0:
        raise ValueError("Conductor size must be greater than 0 mm².")
    if cond.get("diameter_m") not in (None, "") and _num_strict(cond["diameter_m"], "Conductor outside diameter") <= 0:
        raise ValueError("Conductor outside diameter must be greater than 0.")
    if _num_strict(cond.get("depth_m", 0.5), "Burial depth") <= 0:
        raise ValueError("Burial depth must be greater than 0 (conductors are buried).")
    soil = grid.get("soil") or {}
    if _num_strict(soil.get("rho1", 100), "Soil resistivity ρ1") <= 0:
        raise ValueError("Soil resistivity ρ1 must be greater than 0.")
    if str(soil.get("two_layer", "off")).lower() in ("on", "true", "1", "yes"):
        if _num_strict(soil.get("rho2", 100), "Lower-layer resistivity ρ2") <= 0:
            raise ValueError("Lower-layer resistivity ρ2 must be greater than 0.")
        if _num_strict(soil.get("h1", 3.0), "Upper-layer thickness h1") <= 0:
            raise ValueError("Upper-layer thickness h1 must be greater than 0.")
    if t in ("rect", "l"):
        Lx = _num_strict(layout.get("length_x", 30), "Grid length")
        Ly = _num_strict(layout.get("width_y", 30), "Grid width")
        if Lx <= 0 or Ly <= 0:
            raise ValueError("Grid length and width must both be greater than 0.")
        for key, total, name in (("x_lines", Lx, "x"), ("y_lines", Ly, "y")):
            lines = layout.get(key)
            if lines:
                vals = [_num_strict(v, f"Uneven spacing ({name} positions)") for v in lines]
                inside = {round(v, 6) for v in vals if -1e-9 <= v <= total + 1e-9}
                if len(inside | {0.0, round(total, 6)}) < 2:
                    raise ValueError(f"Uneven spacing ({name}) needs positions between 0 and {total:g} m.")
                if any(v < -1e-9 or v > total + 1e-9 for v in vals):
                    raise ValueError(f"Uneven spacing ({name}): every position must lie between 0 and {total:g} m.")
            elif int(_num_strict(layout.get("n_x" if name == "x" else "n_y", 6), "Number of conductors")) < 2:
                raise ValueError("At least 2 conductors are needed in each direction.")
        if t == "l":
            nx = _num_strict(layout.get("notch_x", Lx / 2), "L-shape notch x")
            ny = _num_strict(layout.get("notch_y", Ly / 2), "L-shape notch y")
            if not (0 < nx < Lx and 0 < ny < Ly):
                raise ValueError(f"The L-shape notch corner must lie inside the grid (0 < x < {Lx:g} m, 0 < y < {Ly:g} m).")
    elif not (grid.get("extra_conductors") or grid.get("extra_rods")):
        raise ValueError("The grid has no layout and no added conductors or rods.")
    for k, c in enumerate(grid.get("extra_conductors") or []):
        if c.get("area_mm2") not in (None, "") and _num_strict(c["area_mm2"], f"Added conductor {k + 1} size") <= 0:
            raise ValueError(f"Added conductor {k + 1} size must be greater than 0 mm².")
        x1, y1, x2, y2 = (_num_strict(c.get(n), f"Added conductor {k + 1} {n}") for n in ("x1", "y1", "x2", "y2"))
        if math.hypot(x2 - x1, y2 - y1) < 1e-6:
            raise ValueError(f"Added conductor {k + 1} has zero length.")
    for k, r in enumerate(grid.get("extra_rods") or []):
        _num_strict(r.get("x"), f"Added rod {k + 1} x")
        _num_strict(r.get("y"), f"Added rod {k + 1} y")
        if r.get("length_m") not in (None, "") and _num_strict(r["length_m"], f"Added rod {k + 1} length") <= 0:
            raise ValueError(f"Added rod {k + 1} length must be greater than 0.")
    rods = grid.get("rods") or {}
    if str(rods.get("rule", "none")).lower() != "none":
        if _num_strict(rods.get("length_m", 3.0), "Rod length") <= 0:
            raise ValueError("Rod length must be greater than 0.")
        if _num_strict(rods.get("diameter_m", 0.016), "Rod diameter") <= 0:
            raise ValueError("Rod diameter must be greater than 0.")


def _offset_is_valid(poly, line):
    """An inward offset is valid while every edge keeps its direction and the
    polygon keeps a positive area."""
    def area(P):
        return 0.5 * sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))
    if area(poly) * area(line) <= 0 or abs(area(line)) < 1e-6:
        return False
    for i in range(len(poly)):
        a = np.subtract(poly[(i + 1) % len(poly)], poly[i])
        b = np.subtract(line[(i + 1) % len(line)], line[i])
        if float(a @ b) <= 0:
            return False
    return True


def build_wires(grid):
    """Wires, outline and descriptive geometry of an earth-grid object.

    Returns dict(wires, outline, rods, fences, groups, notes) where every
    wire is {a, b, radius, group, kind}. Group 0 = bonded to the grid; each
    unbonded fence (or unbonded extra metal) gets its own group number.
    """
    validate_grid(grid)
    cond = grid.get("conductor") or {}
    depth = _f(cond.get("depth_m"), 0.5)
    radius = conductor_diameter_m(cond) / 2.0
    layout = grid.get("layout") or {}
    wires, nodes = _layout_wires(layout, depth, radius)
    outline = layout_outline(layout)
    notes = []

    rods_cfg = grid.get("rods") or {}
    rule = str(rods_cfg.get("rule", "none")).lower()
    r_len = _f(rods_cfg.get("length_m"), 3.0)
    r_rad = _f(rods_cfg.get("diameter_m"), 0.016) / 2.0
    rod_pts = []
    if outline and r_len > 0:
        if rule == "perimeter_even":
            # corners first, then evenly spaced round the perimeter — the
            # IEEE 80 K_ii = 1 arrangement, and the legacy per-bus placement
            cnt = int(_f(rods_cfg.get("count"), 0))
            if cnt > 0:
                rod_pts = [tuple(v) for v in outline[:min(cnt, len(outline))]]
                rest = cnt - len(rod_pts)
                per = sum(float(np.linalg.norm(np.array(outline[(i + 1) % len(outline)], float)
                                               - np.array(outline[i], float)))
                          for i in range(len(outline)))
                rod_pts += [_perimeter_point(outline, per * (k + 0.5) / rest) for k in range(rest)]
        elif rule in ("perimeter_nodes", "perimeter_alternate", "corners", "all_nodes"):
            on_perim = [p for p in nodes if _on_polygon(p, outline)]
            if rule == "all_nodes":
                rod_pts = list(nodes)
            elif rule == "corners":
                rod_pts = [tuple(v) for v in outline]
            elif rule == "perimeter_nodes":
                rod_pts = on_perim
            else:
                order = sorted(on_perim, key=lambda p: _perimeter_position(p, outline))
                rod_pts = order[::2]
    rods = [dict(x=float(x), y=float(y), length=r_len, radius=r_rad, group=0, kind="rod")
            for x, y in rod_pts]

    for c in grid.get("extra_conductors") or []:
        z = _f(c.get("depth_m"), depth)
        wires.append(dict(a=(_f(c.get("x1"), 0), _f(c.get("y1"), 0), z),
                          b=(_f(c.get("x2"), 0), _f(c.get("y2"), 0), z),
                          radius=(area_to_diameter_m(c["area_mm2"]) if c.get("area_mm2") not in (None, "")
                                  else _f(c.get("diameter_m"), 2 * radius)) / 2.0,
                          group=0 if c.get("bonded", True) not in (False, "no", "false") else -1,
                          kind="extra"))
    for r in grid.get("extra_rods") or []:
        rods.append(dict(x=_f(r.get("x"), 0), y=_f(r.get("y"), 0),
                         length=_f(r.get("length_m"), r_len),
                         radius=_f(r.get("diameter_m"), 2 * r_rad) / 2.0,
                         group=0 if r.get("bonded", True) not in (False, "no", "false") else -1,
                         kind="extra_rod"))

    fences = []
    next_group = 1
    for k, fc in enumerate(grid.get("fences") or []):
        base = outline or _hull([w["a"][:2] for w in wires] + [w["b"][:2] for w in wires])
        if not base:
            continue
        off = _num_strict(fc.get("offset_m", 2.0), f"Fence {k + 1} offset")
        line = offset_polygon(base, off)
        if off < 0 and not _offset_is_valid(base, line):
            raise ValueError(f"Fence {k + 1}: an offset of {off:g} m reaches past the middle of the grid — "
                             f"use a smaller inward offset.")
        bonded = fc.get("bonded", True) not in (False, "no", "false")
        g = 0 if bonded else next_group
        if not bonded:
            next_group += 1
        spacing = _f(fc.get("post_spacing_m"), 3.0)
        pdep = _f(fc.get("post_depth_m"), 0.8)
        prad = _f(fc.get("post_diameter_m"), 0.05) / 2.0
        name = fc.get("name") or f"Fence {k + 1}"
        if spacing > 0 and pdep > 0:
            for x, y in _perimeter_walk(line, spacing=spacing):
                rods.append(dict(x=x, y=y, length=pdep, radius=prad, group=g, kind="post",
                                 top=0.0, fence=k))
        pc = fc.get("conductor_offset_m")
        if pc not in (None, "", "none"):
            ring = offset_polygon(line, _f(pc, 1.0))
            z = _f(fc.get("conductor_depth_m"), depth)
            for i in range(len(ring)):
                a, b = ring[i], ring[(i + 1) % len(ring)]
                wires.append(dict(a=(a[0], a[1], z), b=(b[0], b[1], z), radius=radius,
                                  group=g, kind="fence_conductor", fence=k))
        fences.append(dict(index=k, name=name, bonded=bonded, group=g, line=line))

    # unbonded extras become one group each
    for item in wires + rods:
        if item.get("group") == -1:
            item["group"] = next_group
            next_group += 1

    all_wires = list(wires)
    for r in rods:
        top = r.get("top", depth)
        all_wires.append(dict(a=(r["x"], r["y"], top), b=(r["x"], r["y"], top + r["length"]),
                              radius=r["radius"], group=r["group"], kind=r["kind"],
                              fence=r.get("fence")))
    if outline is None:
        outline = _hull([w["a"][:2] for w in all_wires if w["group"] == 0]
                        + [w["b"][:2] for w in all_wires if w["group"] == 0])
        custom = grid.get("touch_area")
        if outline and not (isinstance(custom, list) and len(custom) >= 3):
            notes.append("No generated layout — the touch area is the convex hull of the bonded conductors.")
    return dict(wires=all_wires, outline=outline, rods=rods, fences=fences, notes=notes,
                depth=depth, conductor_radius=radius)


def _is_convex_vertex(poly, c):
    n = len(poly)
    area = 0.5 * sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))
    for i in range(n):
        if abs(poly[i][0] - c[0]) < 1e-6 and abs(poly[i][1] - c[1]) < 1e-6:
            p0, p1, p2 = poly[i - 1], poly[i], poly[(i + 1) % n]
            cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])
            return cr * area > 0
    return False


def _perimeter_point(poly, s):
    for i in range(len(poly)):
        a = np.array(poly[i], float)
        b = np.array(poly[(i + 1) % len(poly)], float)
        L = float(np.linalg.norm(b - a))
        if s <= L + 1e-9:
            return tuple(a + (b - a) * (s / L))
        s -= L
    return tuple(poly[0])


def _perimeter_position(p, poly):
    s = 0.0
    for i in range(len(poly)):
        a = np.array(poly[i], float)
        b = np.array(poly[(i + 1) % len(poly)], float)
        L = float(np.linalg.norm(b - a))
        ap = np.array(p, float) - a
        t = float(ap @ (b - a)) / (L * L)
        if -1e-9 <= t <= 1 + 1e-9 and abs(ap[0] * (b - a)[1] - ap[1] * (b - a)[0]) / L < 1e-6:
            return s + t * L
        s += L
    return s


def _on_polygon(p, poly):
    for i in range(len(poly)):
        a = np.array(poly[i], float)
        b = np.array(poly[(i + 1) % len(poly)], float)
        L = float(np.linalg.norm(b - a))
        ap = np.array(p, float) - a
        t = float(ap @ (b - a)) / (L * L)
        if -1e-9 <= t <= 1 + 1e-9 and abs(ap[0] * (b - a)[1] - ap[1] * (b - a)[0]) / L < 1e-6:
            return True
    return False


def _hull(points):
    """Convex hull (Andrew's monotone chain), counter-clockwise."""
    pts = sorted(set((round(float(x), 6), round(float(y), 6)) for x, y in points))
    if len(pts) < 3:
        return None

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return hull if len(hull) >= 3 else None


def point_in_polygon(P, poly):
    """Boolean mask: points P (N×2) inside or on the boundary of poly."""
    P = np.asarray(P, float)
    x, y = P[:, 0], P[:, 1]
    inside = np.zeros(len(P), bool)
    on = np.zeros(len(P), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        crosses = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-300) + x1)
        inside ^= crosses
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = np.clip(((x - x1) * dx + (y - y1) * dy) / L2, 0, 1)
        on |= np.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < 1e-6
    return inside | on


# ── analysis: zones, worst touch / step, checks ─────────────────────────────
#
# Evaluation conventions follow IEEE 80-2013 Annex H.3 (the benchmark the
# commercial programs were compared on):
#   touch — every point 0.5 m apart in the touch area: inside the grid
#           outline (H.3.6), extended to 1 m outside a bonded fence (H.3.5);
#           for an unbonded fence, within 1 m of the fence line, referred to
#           the fence's own potential (H.3.4, T4);
#   step  — every point 0.5 m apart from 1 m outside the perimeter inward
#           (H.3.5 / H.3.6, S1), each fence line likewise; the 1 m pair may
#           point in any direction.
# Mesh voltage is the worst touch voltage within a mesh (IEEE 80 §3), so the
# scan replaces the simplified method's corner-mesh assumption — which
# Annex B Exhibit 2 shows can miss the worst mesh on an uneven grid.

RASTER_M = 0.5
MAX_RASTER_POINTS = 60000
REACH_M = 1.0                   # touch reach and step length (IEEE 80 §3)
STEP_CANDIDATES = 400
MU0 = 4e-7 * math.pi


def _raster(polys, spacing):
    P = np.array([p for poly in polys for p in poly], float)
    lo, hi = P.min(0), P.max(0)
    while True:
        nx = int(math.floor((hi[0] - lo[0]) / spacing + 1e-9)) + 1
        ny = int(math.floor((hi[1] - lo[1]) / spacing + 1e-9)) + 1
        if nx * ny <= MAX_RASTER_POINTS * 1.6:
            break
        spacing *= 1.25
    xs = lo[0] + spacing * np.arange(nx)
    ys = lo[1] + spacing * np.arange(ny)
    X, Y = np.meshgrid(xs, ys)
    pts = np.column_stack([X.ravel(), Y.ravel()])
    mask = np.zeros(len(pts), bool)
    for poly in polys:
        mask |= point_in_polygon(pts, poly)
    return pts[mask], spacing


def _dist_to_polyline(P, line, closed=True):
    d = np.full(len(P), np.inf)
    n = len(line)
    for i in range(n if closed else n - 1):
        a = np.array(line[i], float)
        b = np.array(line[(i + 1) % n], float)
        ab = b - a
        t = np.clip(((P - a) @ ab) / float(ab @ ab), 0, 1)
        d = np.minimum(d, np.linalg.norm(P - (a + t[:, None] * ab), axis=1))
    return d


def _refine_min(sol, pts, V, spacing, mask_fn, ref, k=12):
    """Refine the lowest-V (highest touch) candidates on a 0.1 m sub-raster."""
    order = np.argsort(V)[:k]
    best_v, best_p = float(V[order[0]]), pts[order[0]]
    for i in order:
        c = pts[i]
        g = np.arange(-spacing, spacing + 1e-9, 0.1)
        X, Y = np.meshgrid(c[0] + g, c[1] + g)
        Q = np.column_stack([X.ravel(), Y.ravel()])
        Q = Q[mask_fn(Q)]
        if len(Q) == 0:
            continue
        v = sol.surface_potential(Q)
        j = int(np.argmin(v))
        if v[j] < best_v:
            best_v, best_p = float(v[j]), Q[j]
    return ref - best_v, best_p


def _worst_step(sol, pts, V, spacing):
    """Largest |V(p) − V(p + 1 m·u)| over the step raster, any direction u."""
    # screen with the axis-aligned 1 m differences read off the raster
    x0, y0 = pts[:, 0].min(), pts[:, 1].min()
    lookup = {(round((x - x0) / spacing), round((y - y0) / spacing)): v for (x, y), v in zip(pts, V)}
    n1 = max(1, int(round(REACH_M / spacing)))
    screen = np.zeros(len(pts))
    for idx, ((x, y), v) in enumerate(zip(pts, V)):
        ix, iy = round((x - x0) / spacing), round((y - y0) / spacing)
        best = 0.0
        for dx, dy in ((n1, 0), (-n1, 0), (0, n1), (0, -n1)):
            w = lookup.get((ix + dx, iy + dy))
            if w is not None:
                best = max(best, abs(v - w))
        screen[idx] = best
    edge = screen == 0      # raster edge: no neighbour inside — keep as candidates
    cand = np.unique(np.concatenate([np.argsort(-screen)[:STEP_CANDIDATES], np.where(edge)[0][:STEP_CANDIDATES]]))
    C = pts[cand]
    Vc = V[cand]
    best, bp, bq = 0.0, None, None
    for k in range(16):
        a = 2 * math.pi * k / 16
        Q = C + REACH_M * np.array([math.cos(a), math.sin(a)])
        d = np.abs(Vc - sol.surface_potential(Q))
        j = int(np.argmax(d))
        if d[j] > best:
            best, bp, bq = float(d[j]), C[j], Q[j]
    return best, bp, bq


def _conductor_impedance(grid, radius, rho1, freq):
    """Series impedance per metre of a buried conductor with earth return
    (Carson, simplified): R + ω·μ0/8 + jω·μ0/(2π)·ln(De / a), with the
    equivalent return depth De = 658.87·√(ρ/f)."""
    from .grounding_system import CONDUCTOR_MATERIALS
    cond = grid.get("conductor") or {}
    mat = CONDUCTOR_MATERIALS.get(cond.get("material", "copper_hard"), CONDUCTOR_MATERIALS["copper_hard"])
    rho_m = mat["rho_r"] * 1e-8                      # μΩ·cm → Ω·m
    R = rho_m / (math.pi * radius * radius)
    w = 2 * math.pi * freq
    De = 658.87 * math.sqrt(max(rho1, 1e-3) / freq)
    return complex(R + w * MU0 / 8.0, w * MU0 / (2 * math.pi) * math.log(De / radius))


def _network(sol, kinds):
    """Metallic network of the bonded, non-fence elements: node index of each
    element end, for the connectivity and conductor-impedance checks."""
    keep = np.where((sol.group == 0) & np.isin(kinds, ["grid", "diagonal", "rod", "extra", "extra_rod"]))[0]
    key = {}
    ends = np.zeros((len(keep), 2), int)
    for r, e in enumerate(keep):
        for c, p in enumerate((sol.A[e], sol.B[e])):
            k = tuple(np.round(p, 4))
            ends[r, c] = key.setdefault(k, len(key))
    return keep, ends, len(key)


def _components(n, ends):
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in ends:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = {find(i) for i in range(n)}
    return len(roots), [find(i) for i in range(n)]


def _potential_variation(sol, kinds, z_per_m, keep, ends, n_nodes):
    """Largest drop of conductor potential below the injection point, as a
    fraction of GPR, when the leakage currents of the equipotential solve
    flow along conductors of impedance z per metre — the first-order check of
    the equipotential assumption. Worst of injection at the extreme nodes."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
    if len(keep) == 0 or n_nodes < 2:
        return 0.0
    L = np.linalg.norm(sol.B[keep] - sol.A[keep], axis=1)
    y = 1.0 / (z_per_m * np.maximum(L, 1e-6))
    a, b = ends[:, 0], ends[:, 1]
    rows = np.concatenate([a, b, a, b])
    cols = np.concatenate([a, b, b, a])
    vals = np.concatenate([y, y, -y, -y])
    Y = coo_matrix((vals, (rows, cols)), shape=(n_nodes, n_nodes)).tocsr()
    leak = np.zeros(n_nodes, complex)
    np.add.at(leak, a, 0.5 * sol.I[keep])
    np.add.at(leak, b, 0.5 * sol.I[keep])
    coords = np.zeros((n_nodes, 3))
    coords[a] = sol.A[keep]
    coords[b] = sol.B[keep]
    cands = {int(np.argmin(coords[:, 0] + coords[:, 1])), int(np.argmax(coords[:, 0] + coords[:, 1])),
             int(np.argmin(coords[:, 0] - coords[:, 1])), int(np.argmax(coords[:, 0] - coords[:, 1]))}
    total = leak.sum()
    worst = 0.0
    for k in cands:
        J = -leak.copy()
        J[k] += total
        idx = np.array([i for i in range(n_nodes) if i != k])
        Yr = Y[idx][:, idx]
        V = spsolve(Yr.tocsc(), J[idx])
        worst = max(worst, float(np.max(np.abs(V))))
    return worst          # per 1 V of GPR


def analyse(grid, frequency=50.0):
    """Solve an earth-grid object and evaluate it per 1 V of GPR.

    Returns a dict of per-unit results (voltages as fractions of GPR) that
    `grounding_system` scales by each bus's grid current, plus the plan data
    for the results drawing. Raises ValueError for an unusable grid.
    """
    geo = build_wires(grid)
    soil_cfg = grid.get("soil") or {}
    rho1 = _f(soil_cfg.get("rho1"), 100.0)
    two = str(soil_cfg.get("two_layer", "off")).lower() in ("on", "true", "1", "yes")
    rho2 = _f(soil_cfg.get("rho2"), rho1)
    h1 = _f(soil_cfg.get("h1"), 3.0)
    soil = dict(rho1=rho1)
    if two and rho2 > 0 and h1 > 0 and abs(rho2 - rho1) > 1e-9:
        soil.update(rho2=rho2, H=h1)
    wires = geo["wires"]
    if not any(w["group"] == 0 for w in wires):
        raise ValueError("The earth grid has no bonded conductors.")
    max_len = max(0.2, min(_f(grid.get("element_length_m"), DEFAULT_MAX_ELEMENT_M), 5.0))
    asked = max_len
    while len(discretise(wires, max_len, soil.get("H"))[0]) > MAX_ELEMENTS and max_len < 20.0:
        max_len *= 1.25
    sol = solve(wires, soil, max_len=max_len)
    notes_len = []
    if max_len > asked * 1.001:
        longest = float(np.max(np.linalg.norm(sol.B - sol.A, axis=1)))
        notes_len.append(f"The grid needs more than {MAX_ELEMENTS} elements at {asked:g} m, so elements up to "
                         f"{longest:.1f} m long are used (on Annex H Grid 3, 4 m elements are within 0.3 % on "
                         f"R_g, 0.5 % on touch voltage and 5 % on step voltage — EARTH_GRID_METHOD.md §4.7).")
    kinds = sol.kind
    notes = list(geo["notes"]) + notes_len

    outline = geo["outline"]
    fences = geo["fences"]
    touch_polys = [outline]
    step_polys = [offset_polygon(outline, REACH_M)]
    for fc in fences:
        step_polys.append(offset_polygon(fc["line"], REACH_M))
        if fc["bonded"]:
            touch_polys.append(offset_polygon(fc["line"], REACH_M))
    custom = grid.get("touch_area")
    if isinstance(custom, list) and len(custom) >= 3:
        # A drawn touch area is where people stand: the step check covers the
        # same area (as CDEGS does with one observation area for both).
        touch_polys = [[(float(p[0]), float(p[1])) for p in custom]]
        step_polys = touch_polys + step_polys[1:]
        if _hull_outline(grid):
            outline = touch_polys[0]        # drawn and reported instead of the convex hull
    in_step = lambda Q: np.any([point_in_polygon(Q, poly) for poly in step_polys], axis=0)

    def in_touch(Q):
        m = np.zeros(len(Q), bool)
        for poly in touch_polys:
            m |= point_in_polygon(Q, poly)
        return m

    # one surface evaluation on one raster covering the touch, step and fence
    # areas; each area is a mask over it
    pts, sp = _raster(step_polys + touch_polys, RASTER_M)
    V = sol.surface_potential(pts)
    tm = in_touch(pts)
    touch, touch_at = _refine_min(sol, pts[tm], V[tm], sp, in_touch, 1.0)
    sm = in_step(pts)
    step, step_a, step_b = _worst_step(sol, pts[sm], V[sm], sp)

    # unbonded fences / metal: within reach of the fence line, referred to
    # the fence's own potential
    fence_out = []
    for fc in fences:
        if fc["bonded"]:
            fence_out.append(dict(name=fc["name"], bonded=True, line=[list(map(float, p)) for p in fc["line"]]))
            continue
        vg = sol.V_group.get(fc["group"], 0.0)
        near = _dist_to_polyline(pts, fc["line"]) <= REACH_M + 1e-9
        ft, fat = _refine_min(sol, pts[near], V[near], sp,
                              lambda Q, L=fc["line"]: _dist_to_polyline(Q, L) <= REACH_M + 1e-9, vg)
        fence_out.append(dict(name=fc["name"], bonded=False, potential=vg, touch=max(ft, 0.0),
                              touch_at=[float(fat[0]), float(fat[1])], transfer=1.0 - vg,
                              line=[list(map(float, p)) for p in fc["line"]]))

    # checks
    keep, ends, n_nodes = _network(sol, kinds)
    n_comp, _ = _components(n_nodes, ends) if n_nodes else (0, [])
    if n_comp > 1:
        notes.append(f"The bonded conductors form {n_comp} separate pieces with no metallic joint between "
                     f"them, but the calculation treats them as one grid at the same potential. Join them "
                     f"(conductor ends must meet a conductor or a crossing) or mark the piece as not bonded.")
    z = _conductor_impedance(grid, geo["conductor_radius"], rho1, frequency)
    variation = _potential_variation(sol, kinds, z, keep, ends, n_nodes) if n_comp == 1 else None
    if variation is not None and variation > 0.05:
        notes.append(f"Conductor impedance lowers the grid potential by up to {variation * 100:.0f} % of GPR "
                     f"away from the injection point — the grid is too large (or its conductors too thin) "
                     f"for the equal-potential assumption. Results away from the injection point are "
                     f"then conservative for touch and step near it, but the GPR is not uniform.")

    # plan data: conductors in 2-D, rods, outline and a coarse map of V/GPR
    allp = np.array([p for poly in step_polys for p in poly], float)
    lo, hi = allp.min(0) - 1.0, allp.max(0) + 1.0
    span = float(max(hi - lo))
    msp = max(span / 90.0, 0.25)
    mx = lo[0] + msp * np.arange(int((hi[0] - lo[0]) / msp) + 1)
    my = lo[1] + msp * np.arange(int((hi[1] - lo[1]) / msp) + 1)
    MX, MY = np.meshgrid(mx, my)
    mv = sol.surface_potential(np.column_stack([MX.ravel(), MY.ravel()])).reshape(MY.shape)

    total_len = float(sum(np.linalg.norm(np.array(w["b"]) - np.array(w["a"])) for w in wires if w["group"] == 0
                          and w.get("kind") not in ("post",)))
    return dict(
        R_g=sol.R_g,
        touch=float(max(touch, 0.0)), touch_at=[float(touch_at[0]), float(touch_at[1])],
        step=float(step), step_at=[float(step_a[0]), float(step_a[1]), float(step_b[0]), float(step_b[1])],
        fences=fence_out,
        elements=int(len(sol.I)),
        raster_m=float(sp),
        potential_variation=variation,
        connected=n_comp <= 1,
        soil=soil,
        notes=notes,
        conductor_length_m=total_len,
        area_m2=float(abs(0.5 * sum(outline[i][0] * outline[(i + 1) % len(outline)][1]
                                    - outline[(i + 1) % len(outline)][0] * outline[i][1]
                                    for i in range(len(outline))))),
        plan=dict(
            outline=[list(map(float, p)) for p in outline],
            touch_area=[[list(map(float, p)) for p in poly] for poly in touch_polys],
            conductors=[[w["a"][0], w["a"][1], w["b"][0], w["b"][1], w.get("kind", "grid"), int(w["group"])]
                        for w in wires if abs(w["a"][2] - w["b"][2]) > -1 and
                        (abs(w["a"][0] - w["b"][0]) > 1e-9 or abs(w["a"][1] - w["b"][1]) > 1e-9)],
            rods=[[r["x"], r["y"], r["kind"], int(r["group"])] for r in geo["rods"]],
            map=dict(x0=float(mx[0]), y0=float(my[0]), dx=float(msp), nx=int(len(mx)), ny=int(len(my)),
                     v=[round(float(v), 4) for v in mv.ravel()]),
        ),
    )


def _hull_outline(grid):
    """No generated layout: the outline is only the convex hull of the metal,
    so a drawn touch area stands in for it (plan and grid area)."""
    return str((grid.get("layout") or {}).get("type", "rect")).lower() not in ("rect", "l")


def preview(grid):
    """Geometry of an earth-grid object for the editor — no solve.

    Returns the plan (conductors, rods, fences, outline, touch area — with
    depths, for the editor's 3-D view), the element count the solve would use, whether the bonded conductors form one
    metallic network, and the notes a solve would raise about geometry."""
    geo = build_wires(grid)
    soil_cfg = grid.get("soil") or {}
    two = str(soil_cfg.get("two_layer", "off")).lower() in ("on", "true", "1", "yes")
    H = _f(soil_cfg.get("h1"), 3.0) if two else None
    max_len = max(0.2, min(_f(grid.get("element_length_m"), DEFAULT_MAX_ELEMENT_M), 5.0))
    wires = geo["wires"]
    notes = list(geo["notes"])
    A, B, rad, grp, kind = discretise(wires, max_len, H)
    n_comp = 0
    if len(A):
        class _S:
            pass
        s = _S()
        s.A, s.B, s.group = A, B, grp
        keep, ends, n_nodes = _network(s, kind)
        n_comp = _components(n_nodes, ends)[0] if n_nodes else 0
        if n_comp > 1:
            notes.append(f"The bonded conductors form {n_comp} separate pieces with no metallic joint between them.")
    if len(A) > MAX_ELEMENTS:
        notes.append(f"{len(A)} elements exceeds the limit of {MAX_ELEMENTS} — use a longer element length.")
    outline = geo["outline"]
    touch_polys = [outline] if outline else []
    for fc in geo["fences"]:
        if fc["bonded"] and outline:
            touch_polys.append(offset_polygon(fc["line"], REACH_M))
    custom = grid.get("touch_area")
    if isinstance(custom, list) and len(custom) >= 3:
        touch_polys = [[(float(p[0]), float(p[1])) for p in custom]]
        if _hull_outline(grid):
            outline = touch_polys[0]
    return dict(
        elements=int(len(A)),
        connected=n_comp <= 1,
        pieces=int(n_comp),
        notes=notes,
        plan=dict(
            outline=[list(map(float, p)) for p in outline] if outline else [],
            touch_area=[[list(map(float, p)) for p in poly] for poly in touch_polys],
            # [x1, y1, x2, y2, kind, group, z1, z2] — depths (m, + down) for the 3-D view
            conductors=[[float(w["a"][0]), float(w["a"][1]), float(w["b"][0]), float(w["b"][1]),
                         w.get("kind", "grid"), int(w["group"]), float(w["a"][2]), float(w["b"][2])]
                        for w in wires if abs(w["a"][0] - w["b"][0]) > 1e-9 or abs(w["a"][1] - w["b"][1]) > 1e-9],
            # [x, y, kind, group, top depth, length]
            rods=[[float(r["x"]), float(r["y"]), r["kind"], int(r["group"]),
                   float(r.get("top", geo["depth"])), float(r["length"])] for r in geo["rods"]],
            fences=[dict(name=f["name"], bonded=f["bonded"], line=[list(map(float, p)) for p in f["line"]])
                    for f in geo["fences"]],
        ),
    )
