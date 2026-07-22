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
documented simplified method IEC 61000-3-3 itself provides for exactly this
purpose (Annex B): repetitive rectangular voltage steps of magnitude d(%),
occurring r times per minute, have an empirically-curve-fitted severity.

The curve-fit used here is anchored at the single most consistently-cited
reference point in the flicker literature — a ~3 % step at 1 change/minute
corresponds to Pst ≈ 1 (the IEC "Pst = 1" borderline-of-irritability curve) —
with the well-established high-frequency roll-off exponent 0.31:

    Pst_estimate = (d / d_anchor) · r^exponent,   d_anchor = 3.0 (%), exponent = 0.31

Both `d_anchor` and `exponent` are exposed as request parameters so a user
with the actual IEC 61000-3-3 table at hand can recalibrate the estimate.
**This is a screening estimate, not a certified measurement** — a borderline
or failing result should be confirmed against the standard's own curve/table
or by field measurement before being used as a compliance determination.

For Plt, IEC 61000-3-3 permits Plt ≈ Pst when the disturbance source's
emission does not vary materially over the 2-hour assessment window (the
normal case for a single repetitively-switched load) — used here directly.

Compliance limits default to the IEC 61000-3-3 LV connection values
(Pst ≤ 1.0, Plt ≤ 0.65); MV/HV connections are assessed against
utility/IEC 61000-3-7-allocated planning levels, which are project-specific
and passed in as overrides rather than hard-coded.

Results are on-demand (not persisted).
"""

from __future__ import annotations

import math

from ..models.schemas import ProjectData
from .loadflow import run_load_flow, insert_implicit_load_buses
from .motor_starting import (
    _build_adjacency, _find_motor_bus, _thevenin_z1, _solve_pq_dip,
    _STARTING_METHODS,
)

DEFAULT_PST_LIMIT = 1.0
DEFAULT_PLT_LIMIT = 0.65
DEFAULT_D_ANCHOR_PCT = 3.0
DEFAULT_EXPONENT = 0.31


def _starts_per_hour(comp):
    try:
        v = float(comp.props.get("flicker_starts_per_hour", 0) or 0)
        return max(0.0, v)
    except (TypeError, ValueError):
        return 0.0


def _pst_estimate(d_pct, starts_per_hour, d_anchor_pct=DEFAULT_D_ANCHOR_PCT,
                  exponent=DEFAULT_EXPONENT):
    """Planning-level Pst estimate for a repetitive rectangular voltage step
    of magnitude d_pct (%) occurring starts_per_hour times per hour — see the
    module docstring for the method, calibration anchor and its limits.
    Returns 0.0 for a non-repetitive (starts_per_hour <= 0) event."""
    if starts_per_hour <= 0 or d_pct <= 0:
        return 0.0
    r_per_min = starts_per_hour / 60.0
    return (d_pct / d_anchor_pct) * (r_per_min ** exponent)


def run_flicker_analysis(project: ProjectData, pst_limit: float = None,
                         plt_limit: float = None, d_anchor_pct: float = None,
                         exponent: float = None) -> dict:
    pst_limit = DEFAULT_PST_LIMIT if pst_limit is None else float(pst_limit)
    plt_limit = DEFAULT_PLT_LIMIT if plt_limit is None else float(plt_limit)
    d_anchor = DEFAULT_D_ANCHOR_PCT if d_anchor_pct is None else max(0.01, float(d_anchor_pct))
    exp = DEFAULT_EXPONENT if exponent is None else float(exponent)

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

        method_key = str(mp.get("starting_method", "dol")).lower()
        factor, method_label = _STARTING_METHODS.get(method_key, _STARTING_METHODS["dol"])
        start_current_a = flc_a if factor is None else flc_a * lrc * factor
        s_start_mva = voltage_kv * start_current_a * math.sqrt(3) / 1000.0

        terminal_bus = _find_motor_bus(motor.id, adj, comp_map)
        if terminal_bus is None:
            warnings.append(f"Motor '{name}': no terminal bus found, skipped.")
            continue
        bus_comp = comp_map.get(terminal_bus)
        bus_name = str(bus_comp.props.get("name", terminal_bus)) if bus_comp else terminal_bus

        z_th = _thevenin_z1(project, terminal_bus, motor.id)
        if z_th is None:
            warnings.append(f"Motor '{name}': no source path found for the "
                            "Thevenin voltage-step calculation, skipped.")
            continue

        v_pre_term = v_pre.get(terminal_bus, 1.0)
        s_pu = s_start_mva / project.baseMVA
        start_pf = 0.3
        s_cplx = s_pu * complex(start_pf, math.sqrt(1 - start_pf ** 2))
        v_start = _solve_pq_dip(v_pre_term, z_th, s_cplx)
        if v_start is None:
            warnings.append(f"Motor '{name}': starting load exceeds the "
                            "network's transfer capability (voltage "
                            "collapse) — flicker screening not meaningful "
                            "until the starting condition itself is fixed.")
            continue

        d_pct = max(0.0, (v_pre_term - v_start) / v_pre_term * 100.0) if v_pre_term > 0 else 0.0
        pst = _pst_estimate(d_pct, starts_hr, d_anchor, exp)
        plt = pst   # stationary repetitive source — IEC 61000-3-3 simplification

        pst_ok = pst <= pst_limit + 1e-9
        plt_ok = plt <= plt_limit + 1e-9
        sources.append({
            "motor_id": motor.id,
            "motor_name": name,
            "terminal_bus": bus_name,
            "starting_method": method_label,
            "starts_per_hour": round(starts_hr, 3),
            "relative_voltage_change_pct": round(d_pct, 3),
            "pst": round(pst, 3),
            "plt": round(plt, 3),
            "pst_limit": pst_limit,
            "plt_limit": plt_limit,
            "pst_compliant": pst_ok,
            "plt_compliant": plt_ok,
            "compliant": bool(pst_ok and plt_ok),
        })

    sources.sort(key=lambda s: -s["pst"])
    overall_compliant = all(s["compliant"] for s in sources) if sources else True

    return {
        "converged": True,
        "sources": sources,
        "compliant": overall_compliant,
        "d_anchor_pct": d_anchor,
        "exponent": exp,
        "method": ("Planning-level screening estimate: relative voltage "
                   "change d(%) from Thevenin-superposition (motor-starting "
                   "machinery), translated to Pst via the IEC 61000-3-3-style "
                   "simplified curve Pst = (d/d_anchor)*r^exponent "
                   f"(default anchor {DEFAULT_D_ANCHOR_PCT}% at 1 change/min, "
                   f"exponent {DEFAULT_EXPONENT}); Plt = Pst for a stationary "
                   "repetitive source. NOT a certified IEC 61000-4-15 "
                   "flickermeter measurement — verify borderline/failing "
                   "results against the standard's own curve or by field "
                   "measurement."),
        "warnings": warnings,
        "note": "",
    }
