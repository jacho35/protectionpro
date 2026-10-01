"""Grounding study for a bus that uses an earth-grid object.

`grounding_system.run_grounding_analysis` hands every bus with an
`earth_grid_id` to `grid_bus_result`. The grid (earth_grid.py) is solved once
per study — its results are per volt of GPR — and each bus scales them by its
own grid current, fault duration and limit basis.

Two limit bases:
  * IEEE 80-2013: tolerable touch / step from §8.4 (body weight, C_s·ρ_s),
    grid current I_G = D_f × S_f × 3I₀(remote share) (§15).
  * EN 50522:2022: current to earth I_E = r × I″k1 (Table 1, low-impedance
    neutral earthing; r = the reduction factor = S_f here, the remote share
    already removes a local neutral's return, I_N), U_E = I_E × R_g, then the
    Figure 9 procedure: C2 (U_E ≤ 2·U_Tp) or C3 (U_E ≤ 4·U_Tp with the
    specified measures M) satisfy the touch criterion; otherwise C4 compares
    the calculated prospective touch voltage U_vT with U_vTp (Annex A.2/A.3).
    Step voltage is only checked when U_E > 20·U_Tp (5.4.2 NOTE 1, A.3).

Two calculation methods:
  * IEEE 80 §16.5 simplified equations — only for an unmodified, equally
    spaced rectangular mesh in uniform soil (Annex D shapes; §16.7 tested
    range). The numerical result is reported beside it as a cross-check.
  * Numerical (method of moments, §16.8) — every other grid, and always
    under EN 50522, which has no simplified touch-voltage equations.
"""

import math

import numpy as np

from .earth_grid import analyse, conductor_diameter_m
from .grounding_system import (
    CONDUCTOR_MATERIALS, DEFAULT_PARAMS, _compute_K_i, _compute_K_ii, _compute_K_m,
    _compute_K_s, _compute_L_M, _compute_conductor_size, _compute_decrement_factor,
    _compute_grid_resistance, _compute_mesh_voltage, _compute_n, _compute_step_voltage,
    _compute_surface_derating, _compute_tolerable_voltages, _max_conductor_temp,
    _select_standard_size, en50522_touch_limits,
)

def to_native(x):
    """numpy scalars/arrays → plain Python (FastAPI cannot serialise numpy)."""
    if isinstance(x, dict):
        return {str(k): to_native(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [to_native(v) for v in x]
    if isinstance(x, np.ndarray):
        return to_native(x.tolist())
    if isinstance(x, np.bool_):
        return bool(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.floating):
        return float(x)
    return x


SIMPLE_ROD_RULES = ("none", "perimeter_even", "perimeter_nodes", "perimeter_alternate",
                    "corners", "all_nodes")


def _num(v, default):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def ieee80_applicability(grid):
    """(applicable, reason). The §16.5 equations assume a square/rectangular
    grid of equally spaced conductors in uniform soil, rods at the perimeter,
    corners or throughout (K_ii = 1) or none."""
    layout = grid.get("layout") or {}
    soil = grid.get("soil") or {}
    if str(layout.get("type", "rect")).lower() != "rect":
        return False, "the grid is not rectangular"
    if layout.get("x_lines") or layout.get("y_lines"):
        return False, "the conductor spacing is uneven (IEEE 80 §16.8)"
    if str(layout.get("diagonals", "none")).lower() != "none":
        return False, "the grid has diagonal conductors (IEEE 80 Annex H.3.6)"
    if grid.get("extra_conductors") or grid.get("extra_rods"):
        return False, "the grid has conductors or rods added by hand"
    if grid.get("fences"):
        return False, "the grid has a fence (IEEE 80 §17.3)"
    if str(soil.get("two_layer", "off")).lower() in ("on", "true", "1", "yes"):
        return False, "the soil is two-layer (IEEE 80 §16.8)"
    rule = str((grid.get("rods") or {}).get("rule", "none")).lower()
    if rule not in SIMPLE_ROD_RULES:
        return False, "the rod arrangement is not one the equations cover"
    if isinstance(grid.get("touch_area"), list):
        return False, "a touch area has been drawn"
    return True, ""


def _rod_count(grid, analysis):
    return sum(1 for r in analysis["plan"]["rods"] if r[2] == "rod")


def _ieee80_simplified(grid, analysis, rho, I_G):
    """IEEE 80 §14.2 / §16.5 values for a plain rectangular grid object."""
    layout = grid.get("layout") or {}
    cond = grid.get("conductor") or {}
    rods = grid.get("rods") or {}
    L_x = _num(layout.get("length_x"), 30.0)
    L_y = _num(layout.get("width_y"), 30.0)
    n_x = max(int(_num(layout.get("n_x"), 6)), 2)
    n_y = max(int(_num(layout.get("n_y"), 6)), 2)
    h = _num(cond.get("depth_m"), 0.5)
    d = conductor_diameter_m(cond)
    n_R = _rod_count(grid, analysis)
    L_r = _num(rods.get("length_m"), 3.0) if n_R else 0.0
    A = L_x * L_y
    L_c = n_x * L_y + n_y * L_x
    L_rod = n_R * L_r
    L_T = L_c + L_rod
    L_S = 0.75 * L_c + 0.85 * L_rod                  # Eq. 98
    has_rods = n_R > 0 and L_r > 0
    L_M = _compute_L_M(L_c, L_rod, L_r, L_x, L_y, has_rods)   # Eq. 95/96
    D = (L_x / (n_x - 1) + L_y / (n_y - 1)) / 2
    n = _compute_n(L_c, L_x, L_y, A)                 # Eq. 89–93
    K_ii = _compute_K_ii(n, has_rods)                # Eq. 87
    R_g = _compute_grid_resistance(rho, A, L_T, h, d)   # Eq. 57
    K_m = _compute_K_m(D, d, h, n, K_ii)             # Eq. 86
    K_s = _compute_K_s(D, h, n)                      # Eq. 99
    K_i = _compute_K_i(n)                            # Eq. 94
    notes = []
    # IEEE 80-2013 §16.7: the range the equations were compared over; §16.5.2
    # gives the depth range for K_s.
    meshes = max(n_x, n_y) - 1
    if not 6.25 <= A <= 10000.0:
        notes.append(f"Grid area {A:.0f} m² is outside the 6.25–10 000 m² range the IEEE 80 equations were checked over (§16.7).")
    if meshes > 40:
        notes.append(f"{meshes} meshes along a side is outside the 1–40 range of IEEE 80 §16.7.")
    if not (2.5 <= min(L_x / (n_x - 1), L_y / (n_y - 1)) and max(L_x / (n_x - 1), L_y / (n_y - 1)) <= 22.5):
        notes.append("Mesh size is outside the 2.5–22.5 m range of IEEE 80 §16.7.")
    if not 0.25 < h < 2.5:
        notes.append(f"Grid depth {h} m is outside 0.25–2.5 m (IEEE 80 §16.5.2, K_s).")
    return dict(
        R_g=R_g, E_m_per_A=_compute_mesh_voltage(rho, 1.0, K_m, K_i, L_M),
        E_s_per_A=_compute_step_voltage(rho, 1.0, K_s, K_i, L_S),
        K_m=K_m, K_s=K_s, K_i=K_i, K_ii=K_ii, n=n, L_M=L_M, L_S=L_S, L_T=L_T, D=D, notes=notes,
    )


def grid_bus_result(bus, grid, cache, fault_results, frequency, warnings):
    """Result dict for one bus on an earth-grid object (same keys as the
    per-bus IEEE 80 result, plus method / basis / location detail)."""
    bp = bus.props
    bus_name = bp.get("name", bus.id)
    gid = str(grid.get("id"))
    gname = grid.get("name") or gid
    if gid not in cache:
        try:
            cache[gid] = dict(ok=True, a=analyse(grid, frequency or 50.0), grid=grid)
        except (ValueError, np.linalg.LinAlgError) as e:
            cache[gid] = dict(ok=False, error=str(e), grid=grid)
    entry = cache[gid]
    if not entry["ok"]:
        warnings.append(f"Bus '{bus_name}': earth grid '{gname}' could not be solved — {entry['error']}")
        return None
    a = entry["a"]
    notes = []

    # ── fault current (as the per-bus path) ──
    I3 = I1 = 0.0
    kappa = 1.8
    remote = 1.0
    if fault_results and bus.id in fault_results.buses:
        bf = fault_results.buses[bus.id]
        I3 = bf.ik3 or 0.0
        I1 = bf.ik1 or 0.0
        if bf.kappa:
            kappa = bf.kappa
        if I1 > 0 and bf.ik1_remote_fraction is not None:
            remote = float(bf.ik1_remote_fraction)
    I_sym_ka = I1 if I1 > 0 else I3
    override = _num(bp.get("design_earth_fault_ka"), 0.0)
    if override > 0:
        I_sym_ka = override
        remote = 1.0
        notes.append(f"Design earth-fault current {override:.3f} kA entered for this bus — used in place of the "
                     f"fault study (e.g. I_C or I_RES of an isolated or resonant-earthed system, EN 50522 Table 1).")
    elif I1 <= 0 < I3:
        notes.append(f"No earth-fault current at this bus (unearthed or isolated neutral) — the 3-phase current "
                     f"{I3:.2f} kA is used instead, which overstates the grid current; enter the design "
                     f"earth-fault current for this bus.")
    if I_sym_ka <= 0:
        warnings.append(f"Bus '{bus_name}': no fault current available, skipping.")
        return None
    if remote < 1.0:
        notes.append(f"{(1 - remote) * 100:.0f}% of the earth-fault current returns through a transformer or "
                     f"generator neutral at this bus (bonded to this grid), so it does not enter the soil "
                     f"(IEEE 80 §15.1; EN 50522 Table 1, I_N).")

    t_s = _num(bp.get("fault_duration"), DEFAULT_PARAMS["fault_duration"])
    t_c = _num(bp.get("fault_clearing_time"), DEFAULT_PARAMS["fault_clearing_time"])
    T_a = _num(bp.get("ambient_temp"), DEFAULT_PARAMS["ambient_temp"])
    S_f = min(max(_num(bp.get("current_split_factor"), 1.0), 0.0), 1.0)

    soil = grid.get("soil") or {}
    rho1 = _num(soil.get("rho1"), 100.0)
    surf = grid.get("surface") or {}
    rho_s = _num(surf.get("rho_s"), DEFAULT_PARAMS["crushed_rock_resistivity"])
    h_s = _num(surf.get("h_s"), DEFAULT_PARAMS["crushed_rock_depth"])
    if h_s <= 0 or rho_s <= 0:
        rho_s, h_s = rho1, 0.0
    body_weight = int(_num(grid.get("body_weight"), 70))
    basis = str(grid.get("limits", "ieee80")).lower()
    basis = "en50522" if basis in ("en50522", "en", "iec") else "ieee80"
    pref = str(grid.get("method", "auto")).lower()
    applicable, why = ieee80_applicability(grid)

    freq = frequency or 50
    D_f = _compute_decrement_factor(kappa, t_s, freq)
    D_f_c = _compute_decrement_factor(kappa, t_c, freq)
    I_cond = D_f_c * I_sym_ka * 1000.0

    cond = grid.get("conductor") or {}
    mat_key = cond.get("material", "copper_hard")
    joint = str(cond.get("joint", "exothermic") or "exothermic").lower()
    min_mm2 = _compute_conductor_size(I_cond, t_c, mat_key, T_a, joint)
    mat = CONDUCTOR_MATERIALS.get(mat_key, CONDUCTOR_MATERIALS["copper_hard"])
    area = _num(cond.get("area_mm2"), 0.0) or None

    if basis == "ieee80":
        I_G = D_f * S_f * remote * I_sym_ka * 1000.0
    else:
        I_G = S_f * remote * I_sym_ka * 1000.0         # EN 50522 Table 1: I_E = r·I″k1
    method = "numerical"
    simple = None
    if basis == "ieee80" and pref in ("auto", "ieee80") and applicable:
        method = "ieee80"
    elif pref == "ieee80" and basis == "ieee80":
        notes.append(f"The IEEE 80 simplified equations were asked for, but {why} — the numerical "
                     f"method is used instead (IEEE 80 §16.8).")
    elif basis == "en50522" and pref == "ieee80":
        notes.append("EN 50522 has no simplified touch-voltage equations — the numerical method is used.")
    if applicable:
        simple = _ieee80_simplified(grid, a, rho1, I_G)

    R_num = a["R_g"]
    touch_num = a["touch"] * R_num * I_G
    step_num = a["step"] * R_num * I_G
    if method == "ieee80":
        R_g = simple["R_g"]
        E_mesh = simple["E_m_per_A"] * I_G
        E_step = simple["E_s_per_A"] * I_G
        notes += simple["notes"]
    else:
        R_g = R_num
        E_mesh = touch_num
        E_step = step_num
    GPR = I_G * R_g

    fences = []
    for fc in a["fences"]:
        if fc["bonded"]:
            fences.append(dict(name=fc["name"], bonded=True))
            continue
        fences.append(dict(name=fc["name"], bonded=False,
                           potential_v=round(fc["potential"] * R_num * I_G, 1),
                           touch_v=round(fc["touch"] * R_num * I_G, 1),
                           touch_location_m=[round(v, 2) for v in fc["touch_at"]],
                           transfer_v=round(fc["transfer"] * R_num * I_G, 1)))

    issues = []
    en = None
    footwear = _num((grid.get("ieee80") or {}).get("footwear_ohm"), 0.0) if basis == "ieee80" else 0.0
    if basis == "ieee80":
        C_s = _compute_surface_derating(rho1, rho_s, h_s) if h_s > 0 else 1.0
        tol_touch, tol_step = _compute_tolerable_voltages(rho_s, C_s, t_s, body_weight, footwear)
        touch_ok = E_mesh <= tol_touch
        step_ok = E_step <= tol_step
        for f in fences:
            if not f["bonded"] and f["touch_v"] > tol_touch:
                touch_ok = False
                issues.append(f"Touch voltage on '{f['name']}' {f['touch_v']:.0f}V exceeds the touch limit {tol_touch:.0f}V")
        if E_mesh > tol_touch:
            issues.insert(0, f"Touch voltage {E_mesh:.0f}V exceeds touch limit {tol_touch:.0f}V")
        if not step_ok:
            issues.append(f"Step voltage {E_step:.0f}V exceeds step limit {tol_step:.0f}V")
        if GPR > tol_touch and touch_ok:
            issues.append(f"GPR {GPR:.0f}V exceeds touch limit but touch voltages are safe — verify transferred potentials")
        status = "fail" if not (touch_ok and step_ok) else ("warning" if GPR > tol_touch else "pass")
    else:
        C_s = None
        ef = grid.get("en50522") or {}
        lim = en50522_touch_limits(t_s, rho_s, _num(ef.get("footwear_ohm"), 0.0), _num(ef.get("hand_ohm"), 0.0))
        measures = str(ef.get("measures_m", "no")).lower() in ("yes", "true", "1", "on")
        U_E = GPR
        tol_touch = lim["U_vTp"]
        tol_step = lim["U_Sp"]
        if U_E <= 2 * lim["U_Tp"]:
            condition = "C2"
            touch_ok = True
        elif U_E <= 4 * lim["U_Tp"] and measures:
            condition = "C3"
            touch_ok = True
        else:
            condition = "C4"
            touch_ok = E_mesh <= tol_touch
            if not touch_ok:
                issues.append(f"Prospective touch voltage {E_mesh:.0f}V exceeds U_vTp {tol_touch:.0f}V (EN 50522 C4)")
            for f in fences:
                if not f["bonded"] and f["touch_v"] > tol_touch:
                    touch_ok = False
                    issues.append(f"Touch voltage on '{f['name']}' {f['touch_v']:.0f}V exceeds U_vTp {tol_touch:.0f}V")
        step_required = U_E > 20 * lim["U_Tp"]
        step_ok = (E_step <= tol_step) if step_required else True
        if step_required and not step_ok:
            issues.append(f"Step voltage {E_step:.0f}V exceeds the permissible step voltage {tol_step:.0f}V (EN 50522 A.3)")
        status = "fail" if not (touch_ok and step_ok) else "pass"
        notes.append("Transferred potentials (EN 50522 §6, Table 2 for LV systems) are to be checked separately.")
        notes.append("Conductor size by the IEEE 80 Onderdonk equation (§11.3); EN 50522 Annex D is not implemented.")
        en = dict(U_E_v=round(U_E, 0), U_Tp_v=round(lim["U_Tp"], 0), U_vTp_v=round(lim["U_vTp"], 0),
                  R_F_ohm=round(lim["R_F"], 0), I_B_a=round(lim["I_B"], 3), U_Sp_v=round(lim["U_Sp"], 0),
                  condition=condition, measures_m=measures, step_required=step_required)

    conductor_ok = None
    if area:
        conductor_ok = area >= min_mm2
        if not conductor_ok:
            issues.append(f"Grid conductor {area:g} mm² is below the {min_mm2:.1f} mm² the fault current needs "
                          f"for {t_c:g} s (IEEE 80 §11.3) — use {_select_standard_size(min_mm2)} mm²")
            status = "fail"
    notes += a["notes"]
    return to_native({
        "bus_id": bus.id,
        "bus_name": bus_name,
        "voltage_kv": float(bp.get("voltage_kv", 11)),
        "earth_grid_id": gid,
        "earth_grid_name": gname,
        "method": method,
        "limit_basis": basis,
        "ieee80_applicable": applicable,
        "ieee80_not_applicable_reason": None if applicable else why,
        # inputs
        "soil_resistivity": rho1,
        "two_layer_soil_enabled": "H" in a["soil"],
        "soil_resistivity_lower": a["soil"].get("rho2"),
        "upper_layer_thickness_m": a["soil"].get("H"),
        "grid_area_m2": round(a["area_m2"], 1),
        "total_conductor_length_m": round(a["conductor_length_m"], 1),
        "num_ground_rods": sum(1 for r in a["plan"]["rods"] if r[2] in ("rod", "extra_rod")),
        "conductor_material": mat["name"],
        "fault_current_ka": round(I_G / 1000.0, 2),
        "symmetrical_fault_ka": round(I_sym_ka, 2),
        "decrement_factor_df": round(D_f, 4) if basis == "ieee80" else None,
        "remote_fraction": round(remote, 4),
        "current_split_factor": S_f,
        "conductor_current_ka": round(I_cond / 1000.0, 2),
        "grid_joint_type": joint,
        "conductor_max_temp_c": _max_conductor_temp(mat_key, joint),
        "fault_duration_s": t_s,
        # results
        "grid_resistance_ohm": round(R_g, 4),
        "gpr_v": round(GPR, 0),
        "surface_derating_Cs": round(C_s, 4) if C_s is not None else None,
        "tolerable_touch_v": round(tol_touch, 0),
        "tolerable_step_v": round(tol_step, 0),
        "footwear_ohm": footwear if footwear > 0 else None,
        "mesh_voltage_v": round(E_mesh, 0),
        "step_voltage_v": round(E_step, 0),
        "touch_location_m": [round(v, 2) for v in a["touch_at"]] if method == "numerical" else None,
        "step_location_m": [round(v, 2) for v in a["step_at"]] if method == "numerical" else None,
        "touch_ok": touch_ok,
        "step_ok": step_ok,
        "fences": fences,
        "numerical": dict(grid_resistance_ohm=round(R_num, 4), touch_v=round(touch_num, 0),
                          step_v=round(step_num, 0),
                          touch_location_m=[round(v, 2) for v in a["touch_at"]],
                          step_location_m=[round(v, 2) for v in a["step_at"]],
                          elements=a["elements"], raster_m=a["raster_m"]),
        "ieee80_simplified": None if simple is None else dict(
            grid_resistance_ohm=round(simple["R_g"], 4), mesh_voltage_v=round(simple["E_m_per_A"] * I_G, 0),
            step_voltage_v=round(simple["E_s_per_A"] * I_G, 0), K_m=round(simple["K_m"], 4),
            K_s=round(simple["K_s"], 4), K_i=round(simple["K_i"], 4), n=round(simple["n"], 3)),
        "en50522": en,
        "potential_variation_pct": None if a["potential_variation"] is None
        else round(a["potential_variation"] * 100.0, 1),
        "min_conductor_mm2": round(min_mm2, 1),
        "recommended_conductor_mm2": _select_standard_size(min_mm2),
        "conductor_area_mm2": area,
        "conductor_ok": conductor_ok,
        "status": status,
        "issues": issues,
        "notes": notes,
    })


def grids_summary(cache):
    """Top-level `grids` entry: per earth grid, the plan and the per-unit
    results (drawn once in the results window, however many buses use it)."""
    out = {}
    for gid, e in cache.items():
        if not e["ok"]:
            out[gid] = dict(name=e["grid"].get("name") or gid, error=e["error"])
            continue
        a = e["a"]
        out[gid] = dict(
            name=e["grid"].get("name") or gid,
            grid_resistance_ohm=round(a["R_g"], 4),
            touch_pu=round(a["touch"], 5), step_pu=round(a["step"], 5),
            touch_location_m=a["touch_at"], step_location_m=a["step_at"],
            elements=a["elements"], raster_m=a["raster_m"],
            potential_variation_pct=None if a["potential_variation"] is None
            else round(a["potential_variation"] * 100.0, 1),
            connected=a["connected"], area_m2=round(a["area_m2"], 1),
            conductor_length_m=round(a["conductor_length_m"], 1),
            fences=[{k: v for k, v in f.items()} for f in a["fences"]],
            plan=a["plan"], notes=a["notes"],
        )
    return to_native(out)
