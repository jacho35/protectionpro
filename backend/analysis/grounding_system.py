"""Grounding System Analysis — IEEE 80 (Guide for Safety in AC Substation Grounding).

Calculates ground grid resistance, touch and step potentials, ground
potential rise (GPR), and conductor sizing for each bus/substation.
Uses fault current results from IEC 60909 analysis.

Key IEEE 80 equations:
  - Grid resistance (Schwarz): R_g = ρ / (4√(A/π)) + ρ / L_T
  - Ground potential rise: GPR = I_G × R_g
  - Touch voltage limit: E_touch = (1000 + 1.5 × C_s × ρ_s) × k / √t_s
  - Step voltage limit: E_step = (1000 + 6 × C_s × ρ_s) × k / √t_s
    (k = 0.116 for 50 kg body weight, 0.157 for 70 kg)
  - Mesh voltage (actual touch): E_m = ρ × I_G × K_m × K_i / L_M
  - Step voltage (actual step): E_s = ρ × I_G × K_s × K_i / L_S
  - Conductor sizing (Onderdonk): A = I × √(t_c × α_r × ρ_r / (TCAP × ln(1 + (T_m - T_a) / (K_0 + T_a))))

Two-layer soil model (IEEE 80 §14.5, optional, off by default):
  The uniform-soil formulas above assume a single ρ. When the native soil is
  layered (upper ρ1/thickness h1 over a semi-infinite lower ρ2), R_g and GPR
  are computed using an EQUIVALENT resistivity ρ_eq derived from the classical
  method-of-images solution for a hemispherical electrode at the boundary of
  two-layer earth (Sunde 1949 / Tagg, "Earth Resistances") — the same image
  physics that underlies the Wenner two-layer apparent-resistivity formula
  used by the field-test interpreter below. ρ_eq replaces ρ only in the grid
  RESISTANCE formula (`_compute_grid_resistance`); the mesh/step voltage
  formulas keep using ρ1 (the layer the grid and a person's feet are actually
  in), consistent with standard practice for two-layer analysis. See
  `_compute_two_layer_equivalent_resistivity` for the exact form and its two
  analytic limits (ρ_eq → ρ1 for a thick top layer, ρ_eq → ρ2 for h1 → 0),
  used as the correctness anchor since no closed-form IEEE 80 worked example
  is published for this case.

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
        "TCAP": 3.846,
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
    "conductor_diameter": 0.01167,  # d (m) — ~4/0 AWG copper
    "conductor_material": "copper_hard",
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


def _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight=70):
    """Compute tolerable touch and step voltages per IEEE 80.

    For 70 kg person (IEEE 80 eq 32, 33):
      E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.157 / √t_s
      E_step  = (1000 + 6.0 × C_s × ρ_s) × 0.157 / √t_s

    For 50 kg person (IEEE 80 eq 29, 30):
      same formulae with the 0.116 body-current constant
    """
    if t_s <= 0:
        t_s = 0.5
    sqrt_ts = math.sqrt(t_s)

    if body_weight >= 70:
        k = 0.157  # 70 kg
    else:
        k = 0.116  # 50 kg

    E_touch = (1000 + 1.5 * C_s * rho_s) * k / sqrt_ts
    E_step = (1000 + 6.0 * C_s * rho_s) * k / sqrt_ts

    return E_touch, E_step


def _two_layer_reflection_factor(rho1, rho2):
    """Reflection factor K = (ρ2 − ρ1) / (ρ2 + ρ1) (IEEE 80 §14.5).

    K > 0: lower layer more resistive (e.g. rock below topsoil) — raises the
    equivalent resistivity above ρ1. K < 0: lower layer more conductive
    (e.g. a water table) — lowers it. K = 0 (ρ1 = ρ2): uniform soil.
    """
    denom = rho1 + rho2
    if denom <= 0:
        return 0.0
    return (rho2 - rho1) / denom


def _two_layer_correction_factor(K, h_rel, r0, n_terms=100):
    """Multiplicative correction F such that ρ_eq = ρ1 × F.

    Derived from the method-of-images solution for a hemispherical electrode
    of radius r0 sitting h_rel below (i.e. at depth h_rel into) the ρ1 layer,
    with a ρ1/ρ2 interface a further distance below it:

        F = 1 + 2 × Σ_{n=1}^N  K^n / √(1 + (2·n·h_rel/r0)²)

    Two exact analytic limits anchor this formula (used as the regression
    test in lieu of a published worked example): h_rel → ∞ (thick top layer)
    ⇒ F → 1 ⇒ ρ_eq → ρ1; h_rel → 0 (grid sitting right at the interface)
    ⇒ F → (1+K)/(1−K) ⇒ ρ_eq → ρ2 exactly.
    """
    if r0 <= 0 or abs(K) < 1e-12:
        return 1.0
    h_rel = max(h_rel, 0.0)
    total = 0.0
    for n in range(1, n_terms + 1):
        Kn = K ** n
        if abs(Kn) < 1e-15:
            break
        total += Kn / math.sqrt(1 + (2 * n * h_rel / r0) ** 2)
    return 1.0 + 2.0 * total


def _compute_two_layer_equivalent_resistivity(rho1, rho2, h1, grid_depth, A):
    """Equivalent uniform resistivity ρ_eq for grid-resistance purposes.

    r0 = √(A/π) is the standard IEEE 80 equivalent-hemisphere radius for a
    grid of area A. h_rel is the thickness of ρ1 soil remaining BELOW the
    grid before the ρ2 interface is reached (h1 measured from the surface,
    grid buried at depth grid_depth); a grid already buried below the
    interface (h1 ≤ grid_depth) is treated as h_rel = 0 (sitting at/below
    the boundary — the most conservative case for a resistive lower layer).

    Returns (rho_eq, K, F).
    """
    K = _two_layer_reflection_factor(rho1, rho2)
    r0 = math.sqrt(A / math.pi) if A > 0 else 0.0
    h_rel = max(h1 - grid_depth, 0.0)
    F = _two_layer_correction_factor(K, h_rel, r0)
    return rho1 * F, K, F


def wenner_apparent_resistivity(rho1, rho2, h1, a, n_terms=100):
    """Apparent resistivity ρa(a) a Wenner four-pin test would read over a
    two-layer earth (upper ρ1/thickness h1, semi-infinite lower ρ2) at probe
    spacing a — the classical Sunde (1949) two-layer formula, reproduced in
    Tagg "Earth Resistances" and the informative annexes of IEEE Std 81:

        ρa(a) = ρ1 × [1 + 4 × Σ_{n=1}^N ( K^n/√(1+(2nh1/a)²) − K^n/√(4+(2nh1/a)²) )]

    K = (ρ2−ρ1)/(ρ2+ρ1). Reduces to ρa = ρ1 for uniform soil (K=0) and to
    ρa → ρ2 as h1 → 0 (same identity used by `_two_layer_correction_factor`).
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
    """Compute step voltage per IEEE 80 eq 92.

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
    """Compute step voltage spacing factor K_s per IEEE 80 eq 94.

    K_s = (1/π) × [1/(2h) + 1/(D+h) + 1/D × (1 - 0.5^(n-2))]
    """
    if D <= 0 or h <= 0 or n < 2:
        return 0.3  # fallback
    K_s = (1 / math.pi) * (1 / (2 * h) + 1 / (D + h) + 1 / D * (1 - 0.5 ** (n - 2)))
    return max(K_s, 0.01)


def _compute_K_i(n):
    """Compute irregularity correction factor K_i per IEEE 80 eq 89.

    K_i = 0.644 + 0.148 × n
    """
    return 0.644 + 0.148 * n


def _compute_n(L_c, L_x, L_y, A):
    """Effective number of parallel conductors n per IEEE 80 Eq. 84–87.

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
    """Corrective weighting factor K_ii per IEEE 80 Eq. 90/91.

    Grids with ground rods along the perimeter / corners: K_ii = 1.0.
    Grids without rods (or few rods): K_ii = 1 / (2n)^(2/n).
    """
    if has_rods:
        return 1.0
    if n <= 0:
        return 1.0
    return 1.0 / (2.0 * n) ** (2.0 / n)


def _compute_L_M(L_c, L_rod, L_r, L_x, L_y, has_rods):
    """Effective buried length for the mesh voltage per IEEE 80 Eq. 87/88.

    Without rods (Eq. 87):  L_M = L_c + L_rod
    With rods (Eq. 88):     L_M = L_c + [1.55 + 1.22·(L_r/√(L_x²+L_y²))]·L_R
                            (L_R = total rod length = L_rod)

    The previous simplification used L_c + L_rod in both cases, which
    under-states L_M for rod grids and so over-states the mesh voltage by a
    few percent (conservative).  The full Eq. 88 restores the exact value.
    """
    if not has_rods or L_rod <= 0:
        return L_c + L_rod
    diag = math.sqrt(L_x ** 2 + L_y ** 2)
    weight = 1.55 + 1.22 * (L_r / diag) if diag > 0 else 1.55
    return L_c + weight * L_rod


def _compute_decrement_factor(kappa, t_s, freq_hz=50.0):
    """Decrement factor D_f per IEEE 80-2013 Eq. 79.

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


def _compute_conductor_size(I_fault_a, t_c, material_key="copper_hard", T_a=40.0):
    """Compute minimum conductor cross-section per IEEE 80 eq 37 (Onderdonk).

    A_mm² = I × √(t_c) × √(α_r × ρ_r / (TCAP × ln(1 + (T_m - T_a)/(K_0 + T_a))))
    Returns area in mm².
    """
    mat = CONDUCTOR_MATERIALS.get(material_key, CONDUCTOR_MATERIALS["copper_hard"])

    alpha_r = mat["alpha_r"]
    rho_r = mat["rho_r"]  # μΩ·cm
    K_0 = mat["K_0"]
    T_m = mat["T_m"]
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
    if not buses:
        return {"buses": [], "warnings": ["No buses found."], "summary": {}}

    results = []
    analysis_warnings = []

    for bus in buses:
        bp = bus.props
        bus_name = bp.get("name", bus.id)
        voltage_kv = float(bp.get("voltage_kv", 11))

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
        L_S = 0.75 * L_c + 0.85 * L_rod  # effective length for step voltage (Eq. 93)
        has_rods = n_R > 0 and L_r > 0
        # IEEE 80 Eq. 88 effective length for mesh voltage (rod-weighted)
        L_M = _compute_L_M(L_c, L_rod, L_r, L_x, L_y, has_rods)

        # Conductor spacing
        D_x = L_x / max(n_x - 1, 1)  # spacing between x conductors
        D_y = L_y / max(n_y - 1, 1)
        D = (D_x + D_y) / 2  # average spacing
        # IEEE 80 Eq. 84–87 effective n (equals max(n_x,n_y) for square grids)
        n = _compute_n(L_c, L_x, L_y, A)
        K_ii = _compute_K_ii(n, has_rods)

        # Get fault current at this bus
        I_fault_ka = 0
        I_fault_1ph_ka = 0
        kappa = 1.8
        if fault_results and bus.id in fault_results.buses:
            bus_fault = fault_results.buses[bus.id]
            I_fault_ka = bus_fault.ik3 or 0
            I_fault_1ph_ka = bus_fault.ik1 or 0
            if bus_fault.kappa:
                kappa = bus_fault.kappa

        # Use single-phase fault for grounding (if available, else 3-phase)
        I_sym_ka = I_fault_1ph_ka if I_fault_1ph_ka > 0 else I_fault_ka

        # [EE-5] IEEE 80 Eq. 79/64: I_G = D_f × S_f × 3I₀ — apply the
        # decrement factor D_f (asymmetrical DC-offset heating over the
        # fault duration t_s) to the symmetrical earth fault current.
        # X/R is derived from the κ carried in the fault results.
        # S_f (current division / split factor) is kept at 1.0 — the
        # conservative assumption that the grid carries the full current.
        S_f = 1.0
        freq = project.frequency or 50
        D_f = _compute_decrement_factor(kappa, t_s, freq)
        I_G_ka = D_f * S_f * I_sym_ka
        I_G = I_G_ka * 1000  # convert to amps

        if I_G <= 0:
            analysis_warnings.append(f"Bus '{bus_name}': no fault current available, skipping.")
            continue

        # ── IEEE 80 Calculations ──

        # Surface layer derating
        C_s = _compute_surface_derating(rho, rho_s, h_s)

        # Tolerable voltages
        E_touch_tol, E_step_tol = _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight)

        # Two-layer soil (IEEE 80 §14.5, optional): ρ_eq replaces ρ for grid
        # resistance/GPR only — mesh/step voltage keep using ρ1 (native `rho`,
        # the layer the grid and a person's feet are actually in).
        if two_layer_enabled:
            rho_eq, two_layer_K, two_layer_F = _compute_two_layer_equivalent_resistivity(rho, rho2, h1_layer, h, A)
        else:
            rho_eq, two_layer_K, two_layer_F = rho, 0.0, 1.0

        # Grid resistance
        R_g = _compute_grid_resistance(rho_eq, A, L_T, h, d)

        # Ground potential rise
        GPR = I_G * R_g

        # Geometry factors
        K_m = _compute_K_m(D, d, h, n, K_ii)
        K_s = _compute_K_s(D, h, n)
        K_i = _compute_K_i(n)

        # Actual mesh (touch) and step voltages
        E_mesh = _compute_mesh_voltage(rho, I_G, K_m, K_i, L_M)
        E_step = _compute_step_voltage(rho, I_G, K_s, K_i, L_S)

        # Conductor sizing
        min_conductor_mm2 = _compute_conductor_size(I_G, t_c, mat_key, T_a)
        recommended_size_mm2 = _select_standard_size(min_conductor_mm2)

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

        if not touch_ok or not step_ok:
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
            "status": status,
            "issues": issues,
        })

    # Summary
    n_pass = sum(1 for r in results if r["status"] == "pass")
    n_warn = sum(1 for r in results if r["status"] == "warning")
    n_fail = sum(1 for r in results if r["status"] == "fail")

    return {
        "buses": results,
        "summary": {
            "total": len(results),
            "pass": n_pass,
            "warning": n_warn,
            "fail": n_fail,
        },
        "warnings": analysis_warnings,
        "material_options": {k: v["name"] for k, v in CONDUCTOR_MATERIALS.items()},
    }
