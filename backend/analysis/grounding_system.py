"""Grounding System Analysis — IEEE 80 (Guide for Safety in AC Substation Grounding).

Calculates ground grid resistance, touch and step potentials, ground
potential rise (GPR), and conductor sizing for each bus/substation.
Uses fault current results from IEC 60909 analysis.

Key IEEE 80 equations (uniform soil):
  - Grid resistance (Sverak, IEEE 80 §14.2):
      R_g = ρ × [1/L_T + 1/√(20A) × (1 + 1/(1 + h√(20/A)))]
  - Ground potential rise: GPR = I_G × R_g,  I_G = D_f × S_f × 3I₀ (remote share)
  - Touch voltage limit: E_touch = (1000 + 1.5 × C_s × ρ_s) × k / √t_s
  - Step voltage limit: E_step = (1000 + 6 × C_s × ρ_s) × k / √t_s
    (k = 0.116 for 50 kg body weight, 0.157 for 70 kg)
  - Mesh voltage (actual touch): E_m = ρ × I_G × K_m × K_i / L_M
  - Step voltage (actual step): E_s = ρ × I_G × K_s × K_i / L_S
  - Conductor sizing (Onderdonk, IEEE 80-2013 Eq. 37):
      A_mm² = I_kA × √(t_c × α_r × ρ_r × 10⁴ / (TCAP × ln((K_0 + T_m)/(K_0 + T_a))))
    T_m = the lower of the material's fusing point and the joint limit.

Two-layer soil model (optional, off by default):
  The simplified E_m / E_s / R_g formulas are for uniform soil only; IEEE 80
  sends layered soil to computer analysis. [G1] When two-layer soil is on,
  the SAME grid (conductors, perimeter rods) is solved numerically twice by
  the method of moments with the exact two-layer image Green's functions —
  once in the real ρ1/ρ2/h1 soil and once in uniform ρ1 — and the uniform
  IEEE 80 values are scaled by the ratios R, E_m and E_s gain from the
  layering (`_two_layer_grid_ratios`). Uniform soil is untouched, so the
  IEEE 80 hand calculation stays exact there.

Wenner four-pin interpreter (`interpret_wenner_test`):
  Fits a two-layer model (ρ1, ρ2, h1) to a set of field apparent-resistivity
  readings ρa(a) at increasing probe spacing a, using the same Sunde
  two-layer forward model (`wenner_apparent_resistivity`) and SciPy nonlinear
  least squares — an analytic alternative to the traditional graphical
  curve-matching method.
"""

import math
from ..models.schemas import ProjectData


# Material constants for grounding conductors (IEEE 80 Table 1)
CONDUCTOR_MATERIALS = {
    "copper_annealed": {
        "name": "Copper (annealed soft-drawn)",
        "alpha_r": 0.00393,  # thermal coefficient at 20°C (1/°C)
        "rho_r": 1.724,  # resistivity at 20°C (μΩ·cm)
        "K_0": 234,  # constant (°C)
        "T_m": 1083,  # fusing temperature (°C)
        "TCAP": 3.422,  # thermal capacity (J/cm³/°C)
    },
    "copper_hard": {
        "name": "Copper (hard-drawn)",
        "alpha_r": 0.00381,
        "rho_r": 1.777,
        "K_0": 242,
        "T_m": 1084,
        "TCAP": 3.422,
    },
    "steel_galvanized": {
        "name": "Steel (galvanized)",
        "alpha_r": 0.0032,
        "rho_r": 20.1,
        "K_0": 293,
        "T_m": 419,
        "TCAP": 3.93,  # [G5] IEEE 80 Table 1 zinc-coated steel rod (was 3.846, the copper-clad value)
    },
    "copper_clad_steel": {
        "name": "Copper-clad steel",
        "alpha_r": 0.00378,
        "rho_r": 5.862,
        "K_0": 245,
        "T_m": 1084,
        "TCAP": 3.846,
    },
}

# [G3] Maximum conductor temperature by joint type (IEEE 80 §11.3.1.1): the
# Onderdonk size must keep the weakest part of the circuit — the joint — below
# its limit, not only the conductor below its fusing point. Exothermic
# (welded) joints are as strong as the conductor, so T_m stays the material's
# fusing temperature. None = no joint limit.
JOINT_MAX_TEMP_C = {
    "exothermic": None,
    "brazed": 450.0,
    "pressure": 350.0,
    "bolted": 250.0,
}

# Default grounding grid parameters
DEFAULT_PARAMS = {
    "soil_resistivity": 100.0,  # ρ (Ω·m)
    "crushed_rock_resistivity": 2500.0,  # ρ_s surface layer (Ω·m)
    "crushed_rock_depth": 0.15,  # h_s (m)
    "two_layer_soil": "off",  # "on" enables the two-layer (ρ1/ρ2/h1) model below
    "soil_resistivity_lower": 100.0,  # ρ2 — lower-layer resistivity (Ω·m), used only when enabled
    "upper_layer_thickness": 3.0,  # h1 — upper-layer thickness (m), used only when enabled
    "grid_length": 30.0,  # L_x grid dimension (m)
    "grid_width": 30.0,  # L_y grid dimension (m)
    "grid_depth": 0.5,  # h burial depth (m)
    "num_conductors_x": 6,  # number of parallel conductors in x
    "num_conductors_y": 6,  # number of parallel conductors in y
    "ground_rod_length": 3.0,  # L_r per rod (m)
    "num_ground_rods": 20,  # n_R number of rods
    "conductor_diameter": 0.01167,  # d (m) — 107 mm² solid-equivalent; projects saved before conductor_area_mm2
    "conductor_material": "copper_hard",
    "grid_joint_type": "exothermic",  # [G3] sets T_m for conductor sizing
    "current_split_factor": 1.0,  # [G2] S_f — share of the remote earth-fault current entering the grid
    "fault_duration": 0.5,  # t_s shock duration (s)
    "fault_clearing_time": 0.5,  # t_c conductor heating time (s)
    "ambient_temp": 40.0,  # T_a ambient (°C)
    "body_weight": 70,  # kg — 70 kg person (IEEE 80 default)
}


def _compute_surface_derating(rho, rho_s, h_s):
    """Compute surface layer derating factor C_s per IEEE 80 eq 27.

    C_s reflects the protective effect of the surface layer (crushed rock).
    """
    if rho_s <= 0 or rho <= 0:
        return 1.0
    # Simplified C_s per IEEE 80-2013 eq 27
    C_s = 1 - 0.09 * (1 - rho / rho_s) / (2 * h_s + 0.09)
    C_s = max(0.0, min(1.0, C_s))
    return C_s


def _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight=70, footwear_ohm=0.0):
    """Compute tolerable touch and step voltages per IEEE 80.

    IEEE 80-2013 §8.4: step Eq. 29 (50 kg) / 30 (70 kg), touch Eq. 32 / 33:
      E_touch = (1000 + 1.5 × C_s × ρ_s) × k / √t_s
      E_step  = (1000 + 6.0 × C_s × ρ_s) × k / √t_s
    k = 0.157 (70 kg) or 0.116 (50 kg).

    footwear_ohm: resistance of each shoe (Ω per foot), in series with that
    foot's own resistance 3·C_s·ρ_s — the feet are in parallel for touch
    (+ R_shoe / 2) and in series for step (+ 2·R_shoe), as SESThreshold
    (CDEGS) adds it. 0 = the IEEE 80 equations above.
    """
    if t_s <= 0:
        t_s = 0.5
    sqrt_ts = math.sqrt(t_s)

    if body_weight >= 70:
        k = 0.157  # 70 kg
    else:
        k = 0.116  # 50 kg

    r_shoe = max(float(footwear_ohm or 0.0), 0.0)
    E_touch = (1000 + 1.5 * C_s * rho_s + r_shoe / 2) * k / sqrt_ts
    E_step = (1000 + 6.0 * C_s * rho_s + 2 * r_shoe) * k / sqrt_ts

    return E_touch, E_step


# ── EN 50522:2022 permissible touch voltage (Annex A / B) ──────────────────
# Table B.4: U_Tp(t_f), bare hand-to-feet contact, 5 % fibrillation, 50 %
# body impedance, weighted over four current paths (Figure 8 in the text).
EN50522_UTP = [(0.05, 725.0), (0.10, 655.0), (0.20, 525.0), (0.50, 225.0),
               (1.00, 115.0), (2.00, 95.0), (5.00, 85.0), (10.0, 85.0)]
# Table B.1: permissible body current I_B(t_f), curve c2 of IEC 60479-1 (mA).
EN50522_IB_MA = [(0.05, 900.0), (0.10, 800.0), (0.20, 600.0), (0.50, 200.0),
                 (1.00, 80.0), (2.00, 60.0), (5.00, 51.0), (10.0, 50.0)]
# Table B.3: total body impedance Z_T vs body current, hand to hand (mA → Ω).
EN50522_ZT = [(8, 3250), (20, 2500), (38, 2000), (58, 1725), (81, 1550), (107, 1400),
              (132, 1325), (157, 1275), (184, 1225), (421, 950), (588, 850), (903, 775), (1290, 775)]


def _interp_log_t(table, t, log_y=False):
    """Interpolate a table in log(t) — Figure 8 / Table B.1 are read on a log
    time axis. Outside the table the end value holds."""
    if t <= table[0][0]:
        return table[0][1]
    if t >= table[-1][0]:
        return table[-1][1]
    for (t0, y0), (t1, y1) in zip(table[:-1], table[1:]):
        if t0 <= t <= t1:
            f = (math.log(t) - math.log(t0)) / (math.log(t1) - math.log(t0))
            if log_y:
                return math.exp(math.log(y0) + f * (math.log(y1) - math.log(y0)))
            return y0 + f * (y1 - y0)
    return table[-1][1]


def en50522_touch_limits(t_f, rho_surface, footwear_ohm=0.0, hand_ohm=0.0):
    """EN 50522:2022 limits for fault duration t_f (s).

    U_Tp  — permissible touch voltage, Table B.4 (log-t interpolation; below
            0.05 s the 0.05 s value is kept, conservative against Figure 8;
            beyond 10 s the NOTE value 80 V).
    U_vTp — prospective permissible touch voltage, Formula (A.3):
            U_vTp = U_Tp + I_B(t_f)/HF · (R_H + R_F), HF = 1 (left hand to
            feet), R_F = R_F1 (footwear) + R_F2, R_F2 = 1.5 m⁻¹ · ρ_S.
    U_Sp  — permissible step voltage per A.3: I_B/HF · Z_T · BF with HF =
            0.04 (foot to foot), BF = 1, Z_T at that body current (Table B.3),
            no additional resistances (conservative).
    """
    t = max(float(t_f), 1e-3)
    u_tp = 80.0 if t > 10.0 else _interp_log_t(EN50522_UTP, t)
    i_b = _interp_log_t(EN50522_IB_MA, t, log_y=True) / 1000.0
    r_f2 = 1.5 * max(float(rho_surface), 0.0)
    r_f = max(float(footwear_ohm), 0.0) + r_f2
    u_vtp = u_tp + i_b * (max(float(hand_ohm), 0.0) + r_f)
    i_step = i_b / 0.04
    z_t = _interp_zt(i_step * 1000.0)
    u_sp = i_step * z_t
    return dict(U_Tp=u_tp, U_vTp=u_vtp, I_B=i_b, R_F=r_f, R_F2=r_f2, U_Sp=u_sp)


def _interp_zt(i_ma):
    t = EN50522_ZT
    if i_ma <= t[0][0]:
        return float(t[0][1])
    if i_ma >= t[-1][0]:
        return float(t[-1][1])
    for (a, za), (b, zb) in zip(t[:-1], t[1:]):
        if a <= i_ma <= b:
            f = (math.log(i_ma) - math.log(a)) / (math.log(b) - math.log(a))
            return za + f * (zb - za)
    return float(t[-1][1])


def _two_layer_reflection_factor(rho1, rho2):
    """Reflection factor K = (ρ2 − ρ1) / (ρ2 + ρ1) (IEEE 80-2013 §7.4, Eq. 21).

    K > 0: lower layer more resistive (e.g. rock below topsoil) — raises the
    equivalent resistivity above ρ1. K < 0: lower layer more conductive
    (e.g. a water table) — lowers it. K = 0 (ρ1 = ρ2): uniform soil.
    """
    denom = rho1 + rho2
    if denom <= 0:
        return 0.0
    return (rho2 - rho1) / denom


# ── [G1] Two-layer soil: method of moments on the actual grid ──────────────
#
# The grid (horizontal conductors + perimeter rods) is cut into straight
# segments carrying a uniform leakage current each, all held at 1 V; the
# potential kernel is the exact two-layer point-source Green's function,
# integrated along each segment (thin-wire kernel, conductor radius a).
# Field/source in the upper (1) or lower (2) layer, K = (ρ2−ρ1)/(ρ2+ρ1),
# layer boundary at depth H:
#   1←1: ρ1/4π · Σ_{n∈Z} K^|n| [1/R(z−z0+2nH) + 1/R(z+z0+2nH)]
#   2←1: ρ1(1+K)/4π · Σ_{n≥0} K^n [1/R(z−z0+2nH) + 1/R(z+z0+2nH)]
#   1←2: ρ1(1+K)/4π · Σ_{n≥0} K^n [1/R(z0−z+2nH) + 1/R(z+z0+2nH)]
#   2←2: ρ2/4π · [1/R(z−z0) − K/R(z+z0−2H) + (1−K²) Σ_{n≥0} K^n/R(z+z0+2nH)]
# Each term is an image segment at z' = sign·z0 + shift (listed below). The
# forms satisfy dV/dz = 0 at the surface and continuity of V and of
# (1/ρ)dV/dz at z = H (checked numerically in the review, reviews/GROUNDING_REVIEW.md).

_MOM_IMAGE_TOL = 1e-6      # drop image terms whose weight is below this


def _mom_images(K, H, field_layer, src_layer):
    """[(coef, sign, shift)] for the block, plus the far-image constant.

    Coefficients exclude the ρ/4π prefactor, which `_mom_prefactor` gives.
    Images further than the far threshold are lumped as coef/|shift| (their
    distance to every field point is ≈ |shift| — error ≤ 2 % on terms that
    are themselves small).
    """
    out = []
    far_const = 0.0
    far_dist = 5.0 * _MOM_SCALE[0]
    aK = abs(K)

    def terms(n_iter, coef_fn, pairs):
        nonlocal far_const
        for n in n_iter:
            c = coef_fn(n)
            if abs(c) < _MOM_IMAGE_TOL * 1e-3:
                break
            for sign, shift in pairs(n):
                if abs(shift) > far_dist and n != 0:
                    far_const += c / abs(shift)
                elif abs(c) >= _MOM_IMAGE_TOL or n == 0:
                    out.append((c, sign, shift))

    def n_all():
        yield 0
        n = 1
        while True:
            yield n
            yield -n
            n += 1

    if aK < 1e-12:
        return [(1.0, 1, 0.0), (1.0, -1, 0.0)], 0.0   # uniform: source + surface image
    if field_layer == 1 and src_layer == 1:
        terms(n_all(), lambda n: K ** abs(n), lambda n: [(1, -2 * n * H), (-1, -2 * n * H)])
    elif field_layer == 2 and src_layer == 1:
        terms(_count(), lambda n: (1 + K) * K ** n, lambda n: [(1, -2 * n * H), (-1, -2 * n * H)])
    elif field_layer == 1 and src_layer == 2:
        terms(_count(), lambda n: (1 + K) * K ** n, lambda n: [(1, 2 * n * H), (-1, -2 * n * H)])
    else:
        out.append((1.0, 1, 0.0))
        out.append((-K, -1, 2 * H))
        terms(_count(), lambda n: (1 - K * K) * K ** n, lambda n: [(-1, -2 * n * H)])
    return out, far_const


def _count():
    n = 0
    while True:
        yield n
        n += 1


_MOM_SCALE = [100.0]  # grid diagonal of the current solve (far-image threshold)


def _mom_prefactor(rho1, rho2, field_layer, src_layer):
    if field_layer == 2 and src_layer == 2:
        return rho2 / (4 * math.pi)
    return rho1 / (4 * math.pi)


def _segment_integral(P, A, B, a):
    """∫_A^B ds / √(|P − s|² + a²) for every field point × segment (numpy)."""
    import numpy as np
    AB = B - A
    L = np.linalg.norm(AB, axis=-1)
    u = AB / L[..., None]
    AP = A[None, :, :] - P[:, None, :]
    t1 = np.einsum('ijk,jk->ij', AP, u)
    t2 = t1 + L[None, :]
    perp2 = np.maximum(np.einsum('ijk,ijk->ij', AP, AP) - t1 * t1, 0.0) + a * a
    rp = np.sqrt(perp2)
    return (np.arcsinh(t2 / rp) - np.arcsinh(t1 / rp)) / L[None, :]


def _mom_grid_segments(L_x, L_y, n_x, n_y, h, n_R, L_r, H):
    """Segments (A, B arrays) of the grid; rods on the perimeter (corners
    first, then evenly spaced — the IEEE 80 K_ii = 1 arrangement, Eq. 87),
    split where they cross the layer boundary H."""
    import numpy as np
    n_x = max(int(n_x), 2)
    n_y = max(int(n_y), 2)
    n_horiz = n_x * (n_y - 1) + n_y * (n_x - 1)
    sub = 2 if 2 * n_horiz <= 900 else 1
    segs = []
    xs = np.linspace(0.0, L_x, n_x)
    ys = np.linspace(0.0, L_y, n_y)
    yy = np.linspace(0.0, L_y, (n_y - 1) * sub + 1)
    xx = np.linspace(0.0, L_x, (n_x - 1) * sub + 1)
    for x in xs:
        segs += [((x, yy[i], h), (x, yy[i + 1], h)) for i in range(len(yy) - 1)]
    for y in ys:
        segs += [((xx[i], y, h), (xx[i + 1], y, h)) for i in range(len(xx) - 1)]
    if n_R > 0 and L_r > 0:
        per = 2.0 * (L_x + L_y)
        corners = [(0.0, 0.0), (L_x, 0.0), (L_x, L_y), (0.0, L_y)]
        pts = corners[:min(n_R, 4)]
        extra = n_R - len(pts)

        def on_perimeter(sp):
            if sp < L_x:
                return (sp, 0.0)
            if sp < L_x + L_y:
                return (L_x, sp - L_x)
            if sp < 2 * L_x + L_y:
                return (2 * L_x + L_y - sp, L_y)
            return (0.0, per - sp)
        for k in range(extra):
            pts.append(on_perimeter(per * (k + 0.5) / extra))
        z_cuts = sorted({h, h + L_r} | ({H} if h < H < h + L_r else set()))
        for (x, y) in pts:
            for z0, z1 in zip(z_cuts[:-1], z_cuts[1:]):
                nz = max(1, int(math.ceil((z1 - z0) / 1.5)))
                zz = np.linspace(z0, z1, nz + 1)
                segs += [((x, y, zz[i]), (x, y, zz[i + 1])) for i in range(nz)]
    S = np.array(segs, dtype=float)
    return S[:, 0], S[:, 1]


def _mom_matrix(P, P_layer, A, B, S_layer, a, rho1, rho2, H):
    import numpy as np
    K = _two_layer_reflection_factor(rho1, rho2)
    M = np.zeros((P.shape[0], A.shape[0]))
    for fl in (1, 2):
        fi = np.where(P_layer == fl)[0]
        if fi.size == 0:
            continue
        for sl in (1, 2):
            si = np.where(S_layer == sl)[0]
            if si.size == 0:
                continue
            images, far_const = _mom_images(K, H, fl, sl)
            pref = _mom_prefactor(rho1, rho2, fl, sl)
            blk = np.zeros((fi.size, si.size))
            Pf = P[fi]
            As, Bs = A[si], B[si]
            mids = 0.5 * (As + Bs)
            seg_len = float(np.max(np.linalg.norm(Bs - As, axis=1)))
            r2 = ((Pf[:, None, 0] - mids[None, :, 0]) ** 2
                  + (Pf[:, None, 1] - mids[None, :, 1]) ** 2)
            zp_lo, zp_hi = float(Pf[:, 2].min()), float(Pf[:, 2].max())
            for c, sign, shift in images:
                zc = sign * mids[:, 2] + shift
                gap = max(float(zc.min()) - zp_hi, zp_lo - float(zc.max()), 0.0)
                if gap > 3.0 * seg_len:
                    # Distant image: a segment seen from ≥ 3 lengths away is a
                    # point source to < 1 % — much cheaper than the integral.
                    dz = Pf[:, None, 2] - zc[None, :]
                    blk += c / np.sqrt(r2 + dz * dz)
                    continue
                Ai = As.copy()
                Bi = Bs.copy()
                Ai[:, 2] = sign * Ai[:, 2] + shift
                Bi[:, 2] = sign * Bi[:, 2] + shift
                blk += c * _segment_integral(Pf, Ai, Bi, a)
            blk += far_const
            M[np.ix_(fi, si)] = pref * blk
    return M


def _mom_solve(L_x, L_y, n_x, n_y, h, d, n_R, L_r, rho1, rho2, H):
    """(R_g, E_m per ampere, E_s per ampere) of the grid by the method of moments."""
    import numpy as np
    _MOM_SCALE[0] = max(math.hypot(L_x, L_y), 10.0)
    A, B = _mom_grid_segments(L_x, L_y, n_x, n_y, h, n_R, L_r, H)
    mid = 0.5 * (A + B)
    layer = np.where(mid[:, 2] < H, 1, 2)
    G = _mom_matrix(mid, layer, A, B, layer, d / 2.0, rho1, rho2, H)
    I = np.linalg.solve(G, np.ones(A.shape[0]))
    R = 1.0 / float(I.sum())
    # Surface potential (per unit GPR): corner mesh for E_m, 1 m steps out
    # of the corner and edge mid-points for E_s.
    Dx = L_x / (max(int(n_x), 2) - 1)
    Dy = L_y / (max(int(n_y), 2) - 1)
    gx, gy = np.meshgrid(np.linspace(0, Dx, 9), np.linspace(0, Dy, 9))
    mesh_pts = np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], 1)
    s2 = 1 / math.sqrt(2)
    step_in = np.array([[0, 0, 0], [L_x / 2, 0, 0], [0, L_y / 2, 0]], float)
    step_out = np.array([[-s2, -s2, 0], [L_x / 2, -1, 0], [-1, L_y / 2, 0]], float)
    Ps = np.vstack([mesh_pts, step_in, step_out])
    Vs = _mom_matrix(Ps, np.ones(Ps.shape[0], int), A, B, layer, 1e-6, rho1, rho2, H) @ I
    nm = mesh_pts.shape[0]
    em_frac = 1.0 - float(Vs[:nm].min())
    es_frac = float(np.max(Vs[nm:nm + 3] - Vs[nm + 3:nm + 6]))
    return R, em_frac * R, es_frac * R


def _two_layer_grid_ratios(L_x, L_y, n_x, n_y, h, d, n_R, L_r, rho1, rho2, H):
    """[G1] Ratios (R_g, E_m, E_s) of the grid in two-layer soil to the same
    grid in uniform ρ1, from `_mom_solve`. The IEEE 80 uniform-soil values
    are multiplied by these, so the ratios carry only the layering effect
    (the uniform formulas' own approximation cancels)."""
    r2, em2, es2 = _mom_solve(L_x, L_y, n_x, n_y, h, d, n_R, L_r, rho1, rho2, H)
    r1, em1, es1 = _mom_solve(L_x, L_y, n_x, n_y, h, d, n_R, L_r, rho1, rho1, H)
    return r2 / r1, em2 / em1, es2 / es1


def wenner_apparent_resistivity(rho1, rho2, h1, a, n_terms=100):
    """Apparent resistivity ρa(a) a Wenner four-pin test would read over a
    two-layer earth (upper ρ1/thickness h1, semi-infinite lower ρ2) at probe
    spacing a — the classical Sunde (1949) two-layer formula, reproduced in
    Tagg "Earth Resistances" and the informative annexes of IEEE Std 81:

        ρa(a) = ρ1 × [1 + 4 × Σ_{n=1}^N ( K^n/√(1+(2nh1/a)²) − K^n/√(4+(2nh1/a)²) )]

    K = (ρ2−ρ1)/(ρ2+ρ1). Reduces to ρa = ρ1 for uniform soil (K=0) and to
    ρa → ρ2 as h1 → 0.
    """
    if a <= 0 or rho1 <= 0:
        return rho1
    K = _two_layer_reflection_factor(rho1, rho2)
    if abs(K) < 1e-12:
        return rho1
    total = 0.0
    for n in range(1, n_terms + 1):
        Kn = K ** n
        if abs(Kn) < 1e-15:
            break
        arg = (2 * n * h1 / a) ** 2
        total += Kn / math.sqrt(1 + arg) - Kn / math.sqrt(4 + arg)
    return rho1 * (1.0 + 4.0 * total)


def interpret_wenner_test(measurements):
    """Fit a two-layer soil model (ρ1, ρ2, h1) to Wenner four-pin field data.

    measurements: iterable of (spacing_m, apparent_resistivity_ohm_m) pairs,
    typically taken at increasing probe spacing a on a logarithmic sweep.
    Needs >= 3 distinct spacings (3 unknowns). Fits via SciPy nonlinear
    least squares on the relative residual of `wenner_apparent_resistivity`
    against each reading — an analytic alternative to the traditional
    graphical (Sunde master-curve) matching method.

    Returns a dict: rho1_ohm_m, rho2_ohm_m, upper_layer_thickness_m,
    rmse_pct (fit quality), converged, and per-point measured/fitted/error.
    """
    import numpy as np
    from scipy.optimize import least_squares

    pts = [(float(a), float(r)) for a, r in measurements if float(a) > 0 and float(r) > 0]
    if len(pts) < 3:
        raise ValueError("Need at least 3 Wenner readings at distinct positive spacings to fit ρ1/ρ2/h1.")

    spacings = np.array([p[0] for p in pts])
    measured = np.array([p[1] for p in pts])

    rho1_0 = float(measured[np.argmin(spacings)])
    rho2_0 = float(measured[np.argmax(spacings)])
    h1_0 = float(np.median(spacings))
    x0 = (max(rho1_0, 1.0), max(rho2_0, 1.0), max(h1_0, 0.1))

    def residuals(x):
        rho1, rho2, h1 = x
        model = np.array([wenner_apparent_resistivity(rho1, rho2, h1, a) for a in spacings])
        return (model - measured) / measured

    bounds = ([0.1, 0.1, 0.01], [1.0e6, 1.0e6, 2000.0])
    result = least_squares(residuals, x0=x0, bounds=bounds)
    rho1, rho2, h1 = (float(v) for v in result.x)

    model = np.array([wenner_apparent_resistivity(rho1, rho2, h1, a) for a in spacings])
    err_pct = (model - measured) / measured * 100.0
    rmse_pct = float(np.sqrt(np.mean(err_pct ** 2)))

    points = [
        {
            "spacing_m": float(a),
            "measured_ohm_m": float(m),
            "fitted_ohm_m": float(f),
            "error_pct": round(float(e), 3),
        }
        for a, m, f, e in zip(spacings, measured, model, err_pct)
    ]

    return {
        "rho1_ohm_m": round(rho1, 2),
        "rho2_ohm_m": round(rho2, 2),
        "upper_layer_thickness_m": round(h1, 3),
        "rmse_pct": round(rmse_pct, 3),
        "converged": bool(result.success),
        "points": points,
    }


def _compute_grid_resistance(rho, A, L_T, h, d=0.01167):
    """Compute grid resistance per IEEE 80 Schwarz/simplified method.

    R_g = ρ × [1/(L_T) + 1/(√(20A)) × (1 + 1/(1 + h×√(20/A)))]
    Simplified from IEEE 80-2013 eq 57.
    """
    if L_T <= 0 or A <= 0:
        return float('inf')

    sqrt_A = math.sqrt(A)
    # IEEE 80-2013 simplified equation
    R_g = rho * (1 / L_T + 1 / (math.sqrt(20 * A)) * (1 + 1 / (1 + h * math.sqrt(20 / A))))
    return R_g


def _compute_mesh_voltage(rho, I_G, K_m, K_i, L_M):
    """Compute mesh (touch) voltage per IEEE 80 eq 85.

    E_m = ρ × I_G × K_m × K_i / L_M
    """
    if L_M <= 0:
        return float('inf')
    return rho * I_G * K_m * K_i / L_M


def _compute_step_voltage(rho, I_G, K_s, K_i, L_S):
    """Compute step voltage per IEEE 80-2013 Eq. 97.

    E_s = ρ × I_G × K_s × K_i / L_S
    """
    if L_S <= 0:
        return float('inf')
    return rho * I_G * K_s * K_i / L_S


def _compute_K_m(D, d, h, n, K_ii=1.0):
    """Compute spacing factor K_m per IEEE 80 eq 86.

    K_m = (1/(2π)) × [ln(D²/(16hd) + (D+2h)²/(8Dd) - h/(4d)) + K_ii/K_h × ln(8/(π(2n-1)))]
    Simplified version.
    """
    if D <= 0 or d <= 0 or h <= 0 or n < 2:
        return 0.5  # fallback
    K_h = math.sqrt(1 + h)  # correction for depth
    term1 = math.log(D * D / (16 * h * d) + (D + 2 * h) ** 2 / (8 * D * d) - h / (4 * d))
    term2 = (K_ii / K_h) * math.log(8 / (math.pi * (2 * n - 1)))
    K_m = (1 / (2 * math.pi)) * (term1 + term2)
    return max(K_m, 0.01)


def _compute_K_s(D, h, n):
    """Compute step voltage spacing factor K_s per IEEE 80-2013 Eq. 99.

    K_s = (1/π) × [1/(2h) + 1/(D+h) + 1/D × (1 - 0.5^(n-2))]
    """
    if D <= 0 or h <= 0 or n < 2:
        return 0.3  # fallback
    K_s = (1 / math.pi) * (1 / (2 * h) + 1 / (D + h) + 1 / D * (1 - 0.5 ** (n - 2)))
    return max(K_s, 0.01)


def _compute_K_i(n):
    """Compute irregularity correction factor K_i per IEEE 80-2013 Eq. 94.

    K_i = 0.644 + 0.148 × n
    """
    return 0.644 + 0.148 * n


def _compute_n(L_c, L_x, L_y, A):
    """Effective number of parallel conductors n per IEEE 80-2013 Eq. 89–93.

    n = n_a·n_b·n_c·n_d.  For a square grid this equals n_x (= the old
    ``max(n_x, n_y)`` shortcut); for rectangular grids n_a·n_b differs, which
    is the correct value.  n_c and n_d are 1 for square/rectangular grids and
    only depart from 1 for L-shaped / irregular grids, which this tool does
    not model, so they are held at 1.
    """
    if L_x <= 0 or L_y <= 0 or A <= 0:
        return 1.0
    L_p = 2.0 * (L_x + L_y)                     # peripheral length of the grid
    n_a = 2.0 * L_c / L_p if L_p > 0 else 1.0
    n_b = math.sqrt(L_p / (4.0 * math.sqrt(A))) # = 1.0 for a square grid
    n_c = 1.0                                    # rectangular → 1
    n_d = 1.0                                    # rectangular → 1
    return n_a * n_b * n_c * n_d


def _compute_K_ii(n, has_rods):
    """Corrective weighting factor K_ii per IEEE 80-2013 Eq. 87.

    Grids with ground rods along the perimeter / corners: K_ii = 1.0.
    Grids without rods (or few rods): K_ii = 1 / (2n)^(2/n).
    """
    if has_rods:
        return 1.0
    if n <= 0:
        return 1.0
    return 1.0 / (2.0 * n) ** (2.0 / n)


def _compute_L_M(L_c, L_rod, L_r, L_x, L_y, has_rods):
    """Effective buried length for the mesh voltage per IEEE 80-2013 Eq. 95/96.

    Without rods (Eq. 95):  L_M = L_c + L_rod
    With rods (Eq. 96):     L_M = L_c + [1.55 + 1.22·(L_r/√(L_x²+L_y²))]·L_R
                            (L_R = total rod length = L_rod)

    The previous simplification used L_c + L_rod in both cases, which
    under-states L_M for rod grids and so over-states the mesh voltage by a
    few percent (conservative).  The full Eq. 96 restores the exact value.
    """
    if not has_rods or L_rod <= 0:
        return L_c + L_rod
    diag = math.sqrt(L_x ** 2 + L_y ** 2)
    weight = 1.55 + 1.22 * (L_r / diag) if diag > 0 else 1.55
    return L_c + weight * L_rod


def _compute_decrement_factor(kappa, t_s, freq_hz=50.0):
    """Decrement factor D_f per IEEE 80-2013 Eq. 84 (§15.10, Table 10).

        D_f = √(1 + (Ta / t_f) × (1 − e^(−2·t_f/Ta)))
        Ta  = X / (ω·R)   (DC offset time constant, s)

    The system X/R at the bus is derived from the IEC 60909 peak factor κ
    carried in the fault results:  κ = 1.02 + 0.98·e^(−3R/X)
        →  R/X = −ln((κ − 1.02) / 0.98) / 3

    D_f accounts for the asymmetrical (DC-offset) component of the earth
    fault current over the fault duration t_f; typical values 1.0-1.1 for
    t_f ≥ 0.5 s, larger for very short faults on high-X/R systems.
    Guards: κ ≤ 1.02 → no DC offset → D_f = 1; κ ≥ 2 → X/R capped high.
    """
    if t_s <= 0 or freq_hz <= 0 or not kappa:
        return 1.0
    ratio = (kappa - 1.02) / 0.98
    if ratio <= 1e-9:
        return 1.0  # κ ≤ 1.02: fully damped — no DC offset
    if ratio >= 1.0:
        r_over_x = 1e-4  # κ at/above the theoretical 2.0 limit
    else:
        r_over_x = -math.log(ratio) / 3.0
    x_over_r = 1.0 / max(r_over_x, 1e-4)
    ta = x_over_r / (2.0 * math.pi * freq_hz)
    return math.sqrt(1.0 + (ta / t_s) * (1.0 - math.exp(-2.0 * t_s / ta)))


def _max_conductor_temp(material_key, joint_type="exothermic"):
    """[G3] T_m for conductor sizing: the lower of the material's fusing
    temperature and the joint's limit (IEEE 80 §11.3.1.1)."""
    mat = CONDUCTOR_MATERIALS.get(material_key, CONDUCTOR_MATERIALS["copper_hard"])
    limit = JOINT_MAX_TEMP_C.get(str(joint_type or "exothermic").lower())
    return mat["T_m"] if limit is None else min(mat["T_m"], limit)


def _compute_conductor_size(I_fault_a, t_c, material_key="copper_hard", T_a=40.0,
                            joint_type="exothermic"):
    """Compute minimum conductor cross-section per IEEE 80-2013 Eq. 37 (Onderdonk).

    A_mm² = I × √(t_c) × √(α_r × ρ_r / (TCAP × ln(1 + (T_m - T_a)/(K_0 + T_a))))
    T_m per `_max_conductor_temp` (joint limit). Returns area in mm².
    """
    mat = CONDUCTOR_MATERIALS.get(material_key, CONDUCTOR_MATERIALS["copper_hard"])

    alpha_r = mat["alpha_r"]
    rho_r = mat["rho_r"]  # μΩ·cm
    K_0 = mat["K_0"]
    T_m = _max_conductor_temp(material_key, joint_type)
    TCAP = mat["TCAP"]

    if T_m <= T_a or t_c <= 0:
        return 0

    ln_term = math.log(1 + (T_m - T_a) / (K_0 + T_a))
    if ln_term <= 0:
        return 0

    # IEEE 80 Eq. 37 metric form: A (mm²) = I (kA) × √(α_r × ρ_r × 1e4 / (TCAP × ln_term) × t_c)
    K_f_sq = alpha_r * rho_r * 1e4 / (TCAP * ln_term)
    if K_f_sq <= 0:
        return 0

    A_mm2 = (I_fault_a / 1000.0) * math.sqrt(K_f_sq * t_c)
    return A_mm2


# Standard conductor sizes (mm²)
STANDARD_SIZES_MM2 = [16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300]


def _select_standard_size(min_mm2):
    """Select smallest standard conductor size >= min_mm2."""
    for size in STANDARD_SIZES_MM2:
        if size >= min_mm2:
            return size
    return min_mm2  # larger than any standard


def _build_adjacency(project):
    """Build adjacency map: component_id -> [neighbor_id, ...]."""
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append(w.toComponent)
        adj.setdefault(w.toComponent, []).append(w.fromComponent)
    return adj


def run_grounding_analysis(project: ProjectData):
    """Run IEEE 80 grounding system analysis for all buses.

    Uses fault analysis results internally for fault current at each bus.
    Returns dict with 'buses' list, 'summary', and 'material_options'.
    """
    from .fault import run_fault_analysis

    comp_map = {c.id: c for c in project.components}

    # Run fault analysis to get fault currents
    fault_results = None
    try:
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type=None)
    except Exception:
        return {"buses": [], "warnings": ["Fault analysis failed — cannot compute grounding."], "summary": {}}

    buses = [c for c in project.components if c.type == "bus" and str(c.props.get("system", "ac")).lower() != "dc"]
    scope = None
    if project.groundingBusIds:
        wanted = {str(b) for b in project.groundingBusIds}
        scope = [b.id for b in buses if b.id in wanted]
        buses = [b for b in buses if b.id in wanted]
        if not buses:
            return {"buses": [], "warnings": ["None of the selected buses is an AC bus — nothing to evaluate."],
                    "summary": {}, "scope": {"bus_ids": []}}
    if not buses:
        return {"buses": [], "warnings": ["No buses found."], "summary": {}}

    results = []
    analysis_warnings = []
    # Earth grids of any shape (earth_grid.py) — a bus that names one is
    # solved numerically / against EN 50522 by earth_grid_study; every other
    # bus keeps the per-bus IEEE 80 calculation below, unchanged.
    grids = {str(g.get("id")): g for g in (project.earthGrids or [])
             if isinstance(g, dict) and g.get("id") is not None}
    grid_cache = {}

    for bus in buses:
        bp = bus.props
        bus_name = bp.get("name", bus.id)
        voltage_kv = float(bp.get("voltage_kv", 11))
        gid = bp.get("earth_grid_id")
        if gid not in (None, "", "none"):
            if str(gid) in grids:
                from .earth_grid_study import grid_bus_result
                r = grid_bus_result(bus, grids[str(gid)], grid_cache, fault_results,
                                    project.frequency or 50, analysis_warnings)
                if r:
                    results.append(r)
                continue
            analysis_warnings.append(f"Bus '{bus_name}': earth grid '{gid}' not found in the project — "
                                     f"its own grid data are used.")

        # Get grounding parameters (from bus props or defaults)
        rho = float(bp.get("soil_resistivity", DEFAULT_PARAMS["soil_resistivity"]))
        rho_s = float(bp.get("crushed_rock_resistivity", DEFAULT_PARAMS["crushed_rock_resistivity"]))
        h_s = float(bp.get("crushed_rock_depth", DEFAULT_PARAMS["crushed_rock_depth"]))
        two_layer_enabled = str(bp.get("two_layer_soil", DEFAULT_PARAMS["two_layer_soil"])).lower() in ("on", "true", "1")
        rho2 = float(bp.get("soil_resistivity_lower", DEFAULT_PARAMS["soil_resistivity_lower"]))
        h1_layer = float(bp.get("upper_layer_thickness", DEFAULT_PARAMS["upper_layer_thickness"]))
        L_x = float(bp.get("grid_length", DEFAULT_PARAMS["grid_length"]))
        L_y = float(bp.get("grid_width", DEFAULT_PARAMS["grid_width"]))
        h = float(bp.get("grid_depth", DEFAULT_PARAMS["grid_depth"]))
        n_x = int(bp.get("num_conductors_x", DEFAULT_PARAMS["num_conductors_x"]))
        n_y = int(bp.get("num_conductors_y", DEFAULT_PARAMS["num_conductors_y"]))
        L_r = float(bp.get("ground_rod_length", DEFAULT_PARAMS["ground_rod_length"]))
        n_R = int(bp.get("num_ground_rods", DEFAULT_PARAMS["num_ground_rods"]))
        # The conductor is specified by its size in mm² (conductor_area_mm2);
        # older projects carry a diameter. Solid-equivalent d = √(4A/π).
        area_mm2 = bp.get("conductor_area_mm2")
        if area_mm2 not in (None, ""):
            area_mm2 = float(area_mm2)
            d = math.sqrt(4.0 * area_mm2 / math.pi) / 1000.0
        else:
            area_mm2 = None
            d = float(bp.get("conductor_diameter", DEFAULT_PARAMS["conductor_diameter"]))
        mat_key = bp.get("conductor_material", DEFAULT_PARAMS["conductor_material"])
        t_s = float(bp.get("fault_duration", DEFAULT_PARAMS["fault_duration"]))
        t_c = float(bp.get("fault_clearing_time", DEFAULT_PARAMS["fault_clearing_time"]))
        T_a = float(bp.get("ambient_temp", DEFAULT_PARAMS["ambient_temp"]))
        body_weight = int(bp.get("body_weight", DEFAULT_PARAMS["body_weight"]))

        # Grid geometry
        A = L_x * L_y  # grid area (m²)
        L_c = n_x * L_y + n_y * L_x  # total conductor length (m)
        L_rod = n_R * L_r  # total rod length (m)
        L_T = L_c + L_rod  # total buried conductor length (m)
        L_S = 0.75 * L_c + 0.85 * L_rod  # effective length for step voltage (Eq. 98)
        has_rods = n_R > 0 and L_r > 0
        # IEEE 80 Eq. 96 effective length for mesh voltage (rod-weighted)
        L_M = _compute_L_M(L_c, L_rod, L_r, L_x, L_y, has_rods)

        # Conductor spacing
        D_x = L_x / max(n_x - 1, 1)  # spacing between x conductors
        D_y = L_y / max(n_y - 1, 1)
        D = (D_x + D_y) / 2  # average spacing
        # IEEE 80 Eq. 89–93 effective n (equals max(n_x,n_y) for square grids)
        n = _compute_n(L_c, L_x, L_y, A)
        K_ii = _compute_K_ii(n, has_rods)

        joint_type = str(bp.get("grid_joint_type", DEFAULT_PARAMS["grid_joint_type"]) or "exothermic").lower()
        try:
            S_f = float(bp.get("current_split_factor", DEFAULT_PARAMS["current_split_factor"]))
        except (TypeError, ValueError):
            S_f = 1.0
        S_f = min(max(S_f, 0.0), 1.0)
        notes = []

        # Get fault current at this bus
        I_fault_ka = 0
        I_fault_1ph_ka = 0
        kappa = 1.8
        remote_fraction = 1.0
        if fault_results and bus.id in fault_results.buses:
            bus_fault = fault_results.buses[bus.id]
            I_fault_ka = bus_fault.ik3 or 0
            I_fault_1ph_ka = bus_fault.ik1 or 0
            if bus_fault.kappa:
                kappa = bus_fault.kappa
            if I_fault_1ph_ka > 0 and bus_fault.ik1_remote_fraction is not None:
                remote_fraction = float(bus_fault.ik1_remote_fraction)

        # Use single-phase fault for grounding (if available, else 3-phase)
        I_sym_ka = I_fault_1ph_ka if I_fault_1ph_ka > 0 else I_fault_ka
        if I_fault_1ph_ka <= 0 < I_fault_ka:
            # [G4] No earth-fault path (unearthed / isolated neutral): the
            # 3-phase current stands in, which is conservative but is not the
            # earth-fault current (capacitive on an isolated system).
            notes.append(f"No earth-fault current at this bus (unearthed or isolated neutral) — "
                         f"the 3-phase current {I_fault_ka:.2f} kA is used instead, which overstates "
                         f"the grid current; enter the earth-fault current as the design basis.")

        # [EE-5] IEEE 80 Eq. 3/4: I_G = D_f × S_f × 3I₀ — apply the
        # decrement factor D_f (asymmetrical DC-offset heating over the
        # fault duration t_s) to the symmetrical earth fault current.
        # X/R is derived from the κ carried in the fault results.
        # [G2] Only the part of 3I₀ fed from REMOTE neutrals flows through
        # earth into the grid (IEEE 80 §15.1): the share sourced by a
        # transformer / generator neutral at this bus returns to it through
        # the grid conductors. S_f (IEEE 80 §15.9: shield wires, cable
        # sheaths, other electrodes) then scales the remote share; it
        # defaults to 1.0, the conservative assumption.
        freq = project.frequency or 50
        D_f = _compute_decrement_factor(kappa, t_s, freq)
        I_G_ka = D_f * S_f * remote_fraction * I_sym_ka
        I_G = I_G_ka * 1000  # convert to amps
        # The grid conductor still carries the whole fault current (it is the
        # return path to the local neutral), so conductor sizing uses the full
        # D_f × 3I₀ over the clearing time t_c — not the reduced I_G.
        D_f_c = _compute_decrement_factor(kappa, t_c, freq)
        I_cond = D_f_c * I_sym_ka * 1000

        if I_sym_ka <= 0:
            analysis_warnings.append(f"Bus '{bus_name}': no fault current available, skipping.")
            continue
        if remote_fraction < 1.0:
            notes.append(f"{(1 - remote_fraction) * 100:.0f}% of the earth-fault current returns through a "
                         f"transformer or generator neutral at this bus (bonded to this grid), so it does "
                         f"not enter the soil (IEEE 80 §15.1). A fault on the supply side of that "
                         f"transformer may be the design case.")

        # ── IEEE 80 Calculations ──

        # Surface layer derating
        C_s = _compute_surface_derating(rho, rho_s, h_s)

        # Tolerable voltages
        E_touch_tol, E_step_tol = _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight)

        # Uniform-soil IEEE 80 values (per the simplified equations)
        R_g = _compute_grid_resistance(rho, A, L_T, h, d)
        K_m = _compute_K_m(D, d, h, n, K_ii)
        K_s = _compute_K_s(D, h, n)
        K_i = _compute_K_i(n)
        E_mesh = _compute_mesh_voltage(rho, I_G, K_m, K_i, L_M)
        E_step = _compute_step_voltage(rho, I_G, K_s, K_i, L_S)

        # [G1] Two-layer soil: scale the uniform values by the ratios the
        # layering produces on this grid (method of moments). The previous
        # equivalent-hemisphere ρ_eq applied to R_g only and kept ρ1 for
        # E_m / E_s — up to 2.4× low on E_m over rock and 3× low on R_g
        # over a conductive lower layer.
        two_layer_K = 0.0
        ratio_R = ratio_m = ratio_s = 1.0
        if two_layer_enabled and rho > 0 and rho2 > 0 and h1_layer > 0 and abs(rho2 - rho) > 1e-9:
            two_layer_K = _two_layer_reflection_factor(rho, rho2)
            ratio_R, ratio_m, ratio_s = _two_layer_grid_ratios(
                L_x, L_y, n_x, n_y, h, d, n_R, L_r, rho, rho2, h1_layer)
            R_g *= ratio_R
            E_mesh *= ratio_m
            E_step *= ratio_s
        rho_eq = rho * ratio_R

        # Ground potential rise
        GPR = I_G * R_g

        # Conductor sizing
        min_conductor_mm2 = _compute_conductor_size(I_cond, t_c, mat_key, T_a, joint_type)
        recommended_size_mm2 = _select_standard_size(min_conductor_mm2)
        conductor_ok = None if area_mm2 is None else area_mm2 >= min_conductor_mm2

        # [L1] Range the simplified equations were compared over (IEEE 80-2013
        # §16.7: area 6.25–10 000 m², 1–40 meshes a side, mesh 2.5–22.5 m) and
        # the burial depth of the K_s equation (§16.5.2, 0.25 < h < 2.5 m).
        meshes = max(n_x, n_y) - 1
        if not 6.25 <= A <= 10000.0:
            notes.append(f"Grid area {A:.0f} m² is outside the 6.25–10 000 m² range the IEEE 80 equations were checked over (§16.7).")
        if meshes > 40:
            notes.append(f"{meshes} meshes along a side is outside the 1–40 range of IEEE 80 §16.7.")
        if not (2.5 <= min(D_x, D_y) and max(D_x, D_y) <= 22.5):
            notes.append(f"Conductor spacing {D_x:.2f} × {D_y:.2f} m is outside the 2.5–22.5 m mesh range of IEEE 80 §16.7.")
        if not 0.25 <= h <= 2.5:
            notes.append(f"Grid depth {h} m is outside 0.25–2.5 m — the IEEE 80 E_m / E_s equations are not validated there (§16.5.2).")
        if all(float(bp.get(k, v)) == float(v) for k, v in DEFAULT_PARAMS.items()
               if k in ("soil_resistivity", "grid_length", "grid_width", "num_conductors_x",
                        "num_conductors_y", "num_ground_rods", "ground_rod_length")):
            notes.append("Grid and soil data are the shipped defaults (100 Ω·m, 30 × 30 m, 6 × 6, 20 rods) — "
                         "enter this bus's measured soil and grid design.")

        # Safety checks
        touch_ok = E_mesh <= E_touch_tol
        step_ok = E_step <= E_step_tol
        gpr_exceeds_touch = GPR > E_touch_tol  # if GPR < E_touch, grid is inherently safe

        # Status and issues
        issues = []
        if not touch_ok:
            issues.append(f"Mesh voltage {E_mesh:.0f}V exceeds touch limit {E_touch_tol:.0f}V")
        if not step_ok:
            issues.append(f"Step voltage {E_step:.0f}V exceeds step limit {E_step_tol:.0f}V")
        if GPR > E_touch_tol and touch_ok:
            issues.append(f"GPR {GPR:.0f}V exceeds touch limit but mesh voltage is safe — verify transferred potentials")

        if conductor_ok is False:
            issues.append(f"Grid conductor {area_mm2:g} mm² is below the {min_conductor_mm2:.1f} mm² the fault "
                          f"current needs for {t_c:g} s (IEEE 80 §11.3) — use {recommended_size_mm2} mm²")

        if not touch_ok or not step_ok or conductor_ok is False:
            status = "fail"
        elif GPR > E_touch_tol:
            status = "warning"
        else:
            status = "pass"

        mat = CONDUCTOR_MATERIALS.get(mat_key, CONDUCTOR_MATERIALS["copper_hard"])

        results.append({
            "bus_id": bus.id,
            "bus_name": bus_name,
            "voltage_kv": voltage_kv,
            # Inputs
            "soil_resistivity": rho,
            "two_layer_soil_enabled": two_layer_enabled,
            "soil_resistivity_lower": rho2 if two_layer_enabled else None,
            "upper_layer_thickness_m": h1_layer if two_layer_enabled else None,
            "two_layer_reflection_factor_K": round(two_layer_K, 4) if two_layer_enabled else None,
            "equivalent_resistivity_ohm_m": round(rho_eq, 2) if two_layer_enabled else None,
            "two_layer_ratio_R": round(ratio_R, 4) if two_layer_enabled else None,
            "two_layer_ratio_Em": round(ratio_m, 4) if two_layer_enabled else None,
            "two_layer_ratio_Es": round(ratio_s, 4) if two_layer_enabled else None,
            "grid_area_m2": round(A, 1),
            "grid_dimensions": f"{L_x}m × {L_y}m",
            "total_conductor_length_m": round(L_T, 1),
            "num_ground_rods": n_R,
            # Raw grid geometry (plan-view diagram passthrough — no calc effect)
            "grid_length_m": round(L_x, 3),
            "grid_width_m": round(L_y, 3),
            "num_conductors_x": n_x,
            "num_conductors_y": n_y,
            "conductor_spacing_x_m": round(D_x, 3),
            "conductor_spacing_y_m": round(D_y, 3),
            "ground_rod_length_m": round(L_r, 3),
            "conductor_material": mat["name"],
            "fault_current_ka": round(I_G_ka, 2),
            "symmetrical_fault_ka": round(I_sym_ka, 2),
            "decrement_factor_df": round(D_f, 4),
            "remote_fraction": round(remote_fraction, 4),
            "current_split_factor": S_f,
            "conductor_current_ka": round(I_cond / 1000, 2),
            "grid_joint_type": joint_type,
            "conductor_max_temp_c": _max_conductor_temp(mat_key, joint_type),
            "fault_duration_s": t_s,
            # Results
            "grid_resistance_ohm": round(R_g, 4),
            "gpr_v": round(GPR, 0),
            "surface_derating_Cs": round(C_s, 4),
            "tolerable_touch_v": round(E_touch_tol, 0),
            "tolerable_step_v": round(E_step_tol, 0),
            "mesh_voltage_v": round(E_mesh, 0),
            "step_voltage_v": round(E_step, 0),
            "touch_ok": touch_ok,
            "step_ok": step_ok,
            "min_conductor_mm2": round(min_conductor_mm2, 1),
            "recommended_conductor_mm2": recommended_size_mm2,
            "conductor_area_mm2": area_mm2,
            "conductor_ok": conductor_ok,
            "status": status,
            "issues": issues,
            "notes": notes,
        })

    # Summary
    n_pass = sum(1 for r in results if r["status"] == "pass")
    n_warn = sum(1 for r in results if r["status"] == "warning")
    n_fail = sum(1 for r in results if r["status"] == "fail")

    out_grids = {}
    if grid_cache:
        from .earth_grid_study import grids_summary
        out_grids = grids_summary(grid_cache)
    return {
        "buses": results,
        "grids": out_grids,
        "summary": {
            "total": len(results),
            "pass": n_pass,
            "warning": n_warn,
            "fail": n_fail,
        },
        "warnings": analysis_warnings,
        "scope": {"bus_ids": scope} if scope is not None else None,
        "material_options": {k: v["name"] for k, v in CONDUCTOR_MATERIALS.items()},
    }
