"""Grounding System Analysis — IEEE 80 (Guide for Safety in AC Substation Grounding).

Calculates ground grid resistance, touch and step potentials, ground
potential rise (GPR), and conductor sizing for each bus/substation.
Uses fault current results from IEC 60909 analysis.

Key IEEE 80 equations:
  - Grid resistance (Schwarz): R_g = ρ / (4√(A/π)) + ρ / L_T
  - Ground potential rise: GPR = I_G × R_g
  - Touch voltage limit: E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.116 / √t_s
  - Step voltage limit: E_step = (1000 + 6 × C_s × ρ_s) × 0.116 / √t_s
  - Mesh voltage (actual touch): E_m = ρ × I_G × K_m × K_i / L_M
  - Step voltage (actual step): E_s = ρ × I_G × K_s × K_i / L_S
  - Conductor sizing (Onderdonk): A = I × √(t_c × α_r × ρ_r / (TCAP × ln(1 + (T_m - T_a) / (K_0 + T_a))))
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
    reflection_factor = (rho - rho_s) / (rho + rho_s)
    # Simplified C_s per IEEE 80-2013 eq 27
    C_s = 1 - 0.09 * (1 - rho / rho_s) / (2 * h_s + 0.09)
    C_s = max(0.0, min(1.0, C_s))
    return C_s


def _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight=70):
    """Compute tolerable touch and step voltages per IEEE 80.

    For 70 kg person (IEEE 80 eq 32, 33):
      E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.116 / √t_s
      E_step  = (1000 + 6.0 × C_s × ρ_s) × 0.116 / √t_s

    For 50 kg person (IEEE 80 eq 29, 30):
      E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.116 / √t_s  (same formula, different constant)
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

    # IEEE 80 uses kcmil, we convert to mm²
    # A (kcmil) = I × K_f × √t_c  where K_f = √(α_r × ρ_r × 1e4 / (TCAP × ln_term))
    K_f_sq = alpha_r * rho_r * 1e4 / (TCAP * ln_term)
    if K_f_sq <= 0:
        return 0

    A_kcmil = I_fault_a * math.sqrt(K_f_sq * t_c)
    A_mm2 = A_kcmil * 0.5067  # 1 kcmil = 0.5067 mm²
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

    buses = [c for c in project.components if c.type == "bus"]
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
        L_M = L_c + L_rod  # effective length for mesh voltage
        L_S = 0.75 * L_c + 0.85 * L_rod  # effective length for step voltage

        # Conductor spacing
        D_x = L_x / max(n_x - 1, 1)  # spacing between x conductors
        D_y = L_y / max(n_y - 1, 1)
        D = (D_x + D_y) / 2  # average spacing
        n = max(n_x, n_y)  # effective n for geometry factors

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
        I_G_ka = I_fault_1ph_ka if I_fault_1ph_ka > 0 else I_fault_ka
        I_G = I_G_ka * 1000  # convert to amps

        if I_G <= 0:
            analysis_warnings.append(f"Bus '{bus_name}': no fault current available, skipping.")
            continue

        # ── IEEE 80 Calculations ──

        # Surface layer derating
        C_s = _compute_surface_derating(rho, rho_s, h_s)

        # Tolerable voltages
        E_touch_tol, E_step_tol = _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight)

        # Grid resistance
        R_g = _compute_grid_resistance(rho, A, L_T, h, d)

        # Ground potential rise
        GPR = I_G * R_g

        # Geometry factors
        K_m = _compute_K_m(D, d, h, n)
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
            "grid_area_m2": round(A, 1),
            "grid_dimensions": f"{L_x}m × {L_y}m",
            "total_conductor_length_m": round(L_T, 1),
            "num_ground_rods": n_R,
            "conductor_material": mat["name"],
            "fault_current_ka": round(I_G_ka, 2),
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
