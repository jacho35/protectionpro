"""Voltage flicker assessment (IEC 61000-3-3 / IEC 61000-4-15) — a planning-
level screening study for repetitive voltage changes caused by switching a
fluctuating load, chiefly a motor that starts repeatedly (an intermittent
compressor, pump, or process drive rather than a once-off start).

**Scope and honesty about the method.** A true IEC 61000-4-15 flickermeter
output (Pst/Plt) is derived from the actual AC voltage waveform sampled over
a 10-minute (Pst) / 2-hour (Plt) window through a specific demodulation +
perception-weighting filter chain. A steady-state single-line-diagram tool
has no such waveform to sample, so this study cannot reproduce a certified
flickermeter measurement. What it CAN do rigorously is compute the physical
input every flicker assessment starts from — the **relative voltage change
d(%)** a switching event causes — using the same Thevenin-superposition
machinery the static motor-starting study is built on (`motor_starting.py`),
and then translate that into a **planning-level Pst/Plt estimate** via the
analytical method IEC 61000-3-3 itself provides for exactly this purpose
(the flicker impression time, its Annex on the evaluation of Pst from d(t)):

    t_f  = 2.3 · (F · d_max)^3.2        seconds of "flicker impression" per
                                        voltage change (d in %, F the shape
                                        factor: 1 for a rectangular step)
    Pst  = (Σ t_f / T_p)^(1/3.2),       T_p = 600 s (one 10-minute window)
    Plt  = (Σ_i Pst_i³ / 12)^(1/3)      over the twelve windows of two hours

[FL1] Pst is the worst 10-minute window, not a rate average: a motor starting
twice an hour puts one whole start in some window, and that window's Pst is
the one the limit applies to. [FL2] The old curve fit, Pst = (d/3 %)·r^0.31,
was anchored at "3 % at 1 change/min ⇒ Pst = 1"; the analytical method puts
that point at d = 2.77 % (the IEC 61000-4-15 Pst = 1 curve gives ≈ 2.7 %), so
the fit understated Pst by 7–8 % at every rate, and by up to 57 % below six
starts an hour where it averaged a single start over the hour.

The shape factor F (request ``shape_factor``) defaults to 1, the rectangular
step — conservative for a motor start, whose voltage recovers as the motor
runs up (IEC 61000-3-3 gives F < 1 for that characteristic). The method is
valid for voltage changes at least about 1 s apart.

Limits ([FL4], by the connection voltage, overridable): LV — IEC 61000-3-3,
Pst ≤ 1.0, Plt ≤ 0.65, plus the voltage-change limits d_max ≤ 4 % and
d_c ≤ 3.3 % ([FL3], d_c the steady change once the motor runs); MV / HV —
IEC/TR 61000-3-7 indicative planning levels, Pst 0.9 / Plt 0.7 (MV) and
0.8 / 0.6 (HV-EHV), with no d limit applied (rapid voltage change limits at
MV/HV are network-operator allocations). d is relative to the NOMINAL
voltage (IEC 61000-3-3 §3), not the pre-start voltage.

Results are on-demand (not persisted).
"""

from __future__ import annotations

import math

from ..models.schemas import ProjectData
from .loadflow import run_load_flow, insert_implicit_load_buses
from .motor_starting import (
    _build_adjacency, _find_motor_bus, _thevenin_z1, _prestart_voltage,
    starting_current_xflc, bus_voltage_ratio,
    _solve_start_v, _locked_rotor_pf, _nameplate_unit, VFD_SUPPLY_PF,
)

DEFAULT_PST_LIMIT = 1.0     # IEC 61000-3-3 (LV)
DEFAULT_PLT_LIMIT = 0.65
D_MAX_LIMIT_PCT = 4.0       # IEC 61000-3-3 §5 (LV)
D_C_LIMIT_PCT = 3.3
TF_COEF_S = 2.3             # flicker impression time t_f = 2.3·(F·d)^3.2 s
TF_EXP = 3.2
T_SHORT_S = 600.0           # Pst window (10 min); Plt = 12 windows (2 h)


def _starts_per_hour(comp):
    try:
        v = float(comp.props.get("flicker_starts_per_hour", 0) or 0)
        return max(0.0, v)
    except (TypeError, ValueError):
        return 0.0


def _limits_for(v_kv):
    """[FL4] (Pst, Plt, d_max, d_c, basis) limits for a connection voltage.
    d limits are None where none is applied (MV/HV)."""
    v = float(v_kv or 0)
    if v <= 1.0:
        return DEFAULT_PST_LIMIT, DEFAULT_PLT_LIMIT, D_MAX_LIMIT_PCT, D_C_LIMIT_PCT, \
            "IEC 61000-3-3 (LV)"
    if v <= 35.0:
        return 0.9, 0.7, None, None, "IEC/TR 61000-3-7 MV planning level"
    return 0.8, 0.6, None, None, "IEC/TR 61000-3-7 HV planning level"


def _pst_plt(d_pct, starts_per_hour, shape_factor=1.0):
    """[FL1/FL2] (Pst, Plt) for one voltage change of d_pct (%) repeated
    starts_per_hour times an hour, by the IEC 61000-3-3 analytical method
    (module docstring). Pst is the worst 10-minute window; starts are spread
    evenly over two hours for Plt. (0, 0) for a non-repetitive event."""
    if starts_per_hour <= 0 or d_pct <= 0:
        return 0.0, 0.0
    t_f = TF_COEF_S * (max(shape_factor, 0.0) * d_pct) ** TF_EXP
    n_10 = max(1, math.ceil(starts_per_hour / 6.0 - 1e-9))   # worst window
    pst = (n_10 * t_f / T_SHORT_S) ** (1 / TF_EXP)
    n_2h = max(1, math.ceil(2.0 * starts_per_hour - 1e-9))
    counts = [0] * 12
    for k in range(n_2h):
        counts[min(11, int(((k + 0.5) * 120.0 / n_2h) // 10))] += 1
    plt = (sum(((c * t_f / T_SHORT_S) ** (1 / TF_EXP)) ** 3 for c in counts) / 12) ** (1 / 3)
    return pst, plt


def _pst_estimate(d_pct, starts_per_hour, shape_factor=1.0):
    """Worst-window Pst (see _pst_plt). Kept for callers of the old name."""
    return _pst_plt(d_pct, starts_per_hour, shape_factor)[0]


def run_flicker_analysis(project: ProjectData, pst_limit: float = None,
                         plt_limit: float = None, shape_factor: float = None,
                         d_anchor_pct: float = None, exponent: float = None) -> dict:
    """``pst_limit`` / ``plt_limit`` override the by-voltage defaults for every
    bus. ``d_anchor_pct`` / ``exponent`` belonged to the old curve fit and are
    ignored (with a warning)."""
    shape = 1.0 if shape_factor is None else min(max(float(shape_factor), 0.05), 1.0)

    project = insert_implicit_load_buses(project)
    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    motors = [c for c in project.components
             if c.type in ("motor_induction", "motor_synchronous")
             and _starts_per_hour(c) > 0]
    if not motors:
        return {"converged": False, "note": (
            "No motors flagged with a repetitive starting rate — set "
            "'Starts per Hour' on any motor that starts intermittently "
            "(a compressor, pump, or process drive) to include it in the "
            "flicker screening. A motor that starts once and runs "
            "continuously does not cause flicker."),
            "warnings": [], "sources": []}

    baseline = run_load_flow(project, "newton_raphson", include_synthetic=True)
    if not baseline.converged:
        baseline = run_load_flow(project, "gauss_seidel", include_synthetic=True)
    if not baseline.converged:
        return {"converged": False,
                "note": "Baseline load flow did not converge.",
                "warnings": [], "sources": []}
    v_pre = {bid: b.voltage_pu for bid, b in (baseline.buses or {}).items()}

    warnings = []
    if d_anchor_pct is not None or exponent is not None:
        warnings.append("Curve anchor / exponent are no longer used: Pst and Plt "
                        "now follow the IEC 61000-3-3 analytical method "
                        "(t_f = 2.3·(F·d)^3.2). Use the shape factor F instead.")
    sources = []
    for motor in motors:
        mp = motor.props
        is_sync = motor.type == "motor_synchronous"
        name = str(mp.get("name", motor.id))
        voltage_kv = float(mp.get("voltage_kv", 0) or 0)
        power_factor = float(mp.get("power_factor", 0.9 if is_sync else 0.85) or 0.85)
        lrc = float(mp.get("locked_rotor_current", 5.5 if is_sync else 6.0) or 6.0)
        starts_hr = _starts_per_hour(motor)

        if is_sync:
            rated_kva = float(mp.get("rated_kva", 0) or 0)
            if rated_kva <= 0 or voltage_kv <= 0:
                warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
                continue
            flc_a = rated_kva / (math.sqrt(3) * voltage_kv)
        else:
            rated_kw = float(mp.get("rated_kw", 0) or 0)
            efficiency = float(mp.get("efficiency", 0.93) or 0.93)
            if rated_kw <= 0 or voltage_kv <= 0:
                warnings.append(f"Motor '{name}' has invalid ratings, skipped.")
                continue
            flc_a = rated_kw / (math.sqrt(3) * voltage_kv * efficiency * power_factor)

        mult, method_label = starting_current_xflc(mp, lrc)   # [MG8] shared
        start_current_a = flc_a * mult

        terminal_bus = _find_motor_bus(motor.id, adj, comp_map)
        if terminal_bus is None:
            warnings.append(f"Motor '{name}': no terminal bus found, skipped.")
            continue
        vr = bus_voltage_ratio(terminal_bus, comp_map, voltage_kv)   # [MG9]
        start_current_a *= vr
        s_start_mva = voltage_kv * vr * start_current_a * math.sqrt(3) / 1000.0
        bus_comp = comp_map.get(terminal_bus)
        bus_name = str(bus_comp.props.get("name", terminal_bus)) if bus_comp else terminal_bus

        z_th = _thevenin_z1(project, terminal_bus, motor.id)
        if z_th is None:
            warnings.append(f"Motor '{name}': no source path found for the "
                            "Thevenin voltage-step calculation, skipped.")
            continue

        # d is the step from motor-off to starting (IEC 61000-3-3 ΔU/U), so
        # V_pre is with THIS motor off — the running baseline would count its
        # load twice (see motor_starting._prestart_voltage).
        v_pre_term = _prestart_voltage(project, motor.id, terminal_bus,
                                       v_pre.get(terminal_bus, 1.0))
        # [N1] Same starting-load model as the motor-starting study: a locked
        # rotor is a constant impedance at its locked-rotor pf, a soft starter
        # a constant current, a VFD constant power at pf 0.95.
        s_pu = s_start_mva / project.baseMVA
        method_key = str(mp.get("starting_method", "dol")).lower()
        if method_key == "vfd":
            start_pf = VFD_SUPPLY_PF
        else:
            start_pf = _locked_rotor_pf(mp, _nameplate_unit(motor, comp_map, adj, project))
        s_cplx = s_pu * complex(start_pf, math.sqrt(1 - start_pf ** 2))
        kind = {"soft_starter": "i", "vfd": "pq"}.get(method_key, "z")
        v_start = _solve_start_v(kind, v_pre_term, z_th, s_cplx)
        if v_start is None:
            warnings.append(f"Motor '{name}': starting load exceeds the "
                            "network's transfer capability (voltage "
                            "collapse) — flicker screening not meaningful "
                            "until the starting condition itself is fixed.")
            continue

        # [FL5] d relative to the NOMINAL voltage (IEC 61000-3-3 §3: ΔU/U_n);
        # per-unit voltages are on the bus's nominal, so U_n = 1.
        d_pct = max(0.0, (v_pre_term - v_start) * 100.0)
        # [FL3] d_c: the steady change from motor off to motor running — the
        # baseline load flow has every motor in service.
        v_run = v_pre.get(terminal_bus, v_pre_term)
        d_c_pct = max(0.0, (v_pre_term - v_run) * 100.0)
        pst, plt = _pst_plt(d_pct, starts_hr, shape)

        bus_kv = float(bus_comp.props.get("voltage_kv", voltage_kv) or voltage_kv) if bus_comp else voltage_kv
        lim_pst, lim_plt, lim_dmax, lim_dc, basis = _limits_for(bus_kv)
        if pst_limit is not None:
            lim_pst = float(pst_limit)
        if plt_limit is not None:
            lim_plt = float(plt_limit)
        if pst_limit is not None or plt_limit is not None:
            basis = "user limit"
        pst_ok = pst <= lim_pst + 1e-9
        plt_ok = plt <= lim_plt + 1e-9
        dmax_ok = lim_dmax is None or d_pct <= lim_dmax + 1e-9
        dc_ok = lim_dc is None or d_c_pct <= lim_dc + 1e-9
        sources.append({
            "motor_id": motor.id,
            "motor_name": name,
            "terminal_bus": bus_name,
            "starting_method": method_label,
            "starts_per_hour": round(starts_hr, 3),
            "relative_voltage_change_pct": round(d_pct, 3),
            "steady_voltage_change_pct": round(d_c_pct, 3),
            "pst": round(pst, 3),
            "plt": round(plt, 3),
            "pst_limit": lim_pst,
            "plt_limit": lim_plt,
            "d_max_limit_pct": lim_dmax,
            "d_c_limit_pct": lim_dc,
            "limit_basis": basis,
            "pst_compliant": pst_ok,
            "plt_compliant": plt_ok,
            "d_max_compliant": dmax_ok,
            "d_c_compliant": dc_ok,
            "compliant": bool(pst_ok and plt_ok and dmax_ok and dc_ok),
        })

    sources.sort(key=lambda s: -s["pst"])
    overall_compliant = all(s["compliant"] for s in sources) if sources else True

    return {
        "converged": True,
        "sources": sources,
        "compliant": overall_compliant,
        "shape_factor": shape,
        "method": ("Planning-level screening estimate: the relative voltage "
                   "change d (% of nominal) from Thevenin superposition (the "
                   "motor-starting model), converted to Pst and Plt by the IEC "
                   "61000-3-3 analytical method: flicker impression time "
                   f"t_f = 2.3·(F·d)^3.2 s per start (F = {shape:g}), Pst = "
                   "(Σt_f / 600 s)^(1/3.2) in the worst 10-minute window, Plt "
                   "the cube-root mean of the twelve 10-minute Pst values in "
                   "two hours. Not a certified IEC 61000-4-15 flickermeter "
                   "measurement — confirm a borderline result by measurement."),
        "warnings": warnings,
        "note": "",
    }
