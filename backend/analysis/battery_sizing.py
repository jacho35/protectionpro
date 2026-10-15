"""Battery sizing & discharge analysis — duty-cycle capacity sizing and a
time-step discharge simulation with terminal-voltage performance.

Complements the snapshot backup-autonomy study (backup_autonomy.py): where
that answers "does the installed battery ride through the present load", this
answers "how big must the battery be for a specified duty cycle" and "what do
state of charge and terminal voltage look like over the discharge".

**Sizing** (energy method with IEEE 485-style correction factors):

    E_required = Σ(P_i · t_i) / η_inv / DoD · K_age · K_design · K_temp

  * η_inv — one-way conversion efficiency √(round-trip η) (battery_rt_eff);
  * DoD   — usable depth-of-discharge window (battery_dod_pct);
  * K_age — aging margin, default 1.25 (IEEE 485 §6.3.3: size so the battery
    still meets the duty at its 80 % end-of-life capacity);
  * K_design — design/growth margin, default 1.10 (IEEE 485 §6.3.2);
  * K_temp — low-temperature capacity correction. Lead-acid from the IEEE 485
    Table-1 shape (1.00 at 25 °C rising toward cold); Li-ion is much flatter
    (1.00 ≥ 10 °C, 1.10 below).

**Discharge simulation** (1-minute RK-free forward steps over the duty cycle):

  * SoC from the AC energy drawn through η_inv; for lead-acid the drawn
    current is Peukert-corrected, I_eff = I·(I/I_rated)^(k−1) with k = 1.25
    on the battery's hour rating (Li-ion k ≈ 1.0 — negligible), so a 2×-rate
    discharge empties a lead-acid bank in H/2^k hours (the classic Peukert
    result), not H/2.
  * Terminal voltage V(t) = OCV(SoC) − sag·(I/I_1C), per-chemistry OCV(SoC)
    lookup (per-unit of nominal) and a rated 1C voltage-sag fraction standing
    in for internal resistance (LFP 3 %, NMC 5 %, lead-acid 10 %).
  * Flags: discharge-power limit exceeded, inverter overload, DoD floor
    reached before the duty ends, low-voltage cutoff reached.

Results are on-demand (not persisted).
"""

from __future__ import annotations

import math

from ..models.schemas import ProjectData
from .loadflow import _battery_params, _prop_float
from .backup_autonomy import _island_map, _load_kw_kvar

DT_MIN = 1.0            # simulation step (minutes)
MAX_POINTS = 400        # decimation cap for the returned trajectory

# Per-chemistry model constants:
#   ocv    — (SoC fraction, V per-unit of nominal) breakpoints, descending SoC
#   sag_1c — terminal-voltage sag fraction at a 1C discharge (≈ I·R_int)
#   cutoff — low-voltage cutoff, per-unit of nominal
#   peukert— Peukert exponent k (applied to the battery's hour rating)
CHEMISTRY = {
    "lfp": {
        "label": "Lithium iron phosphate (LFP)",
        "ocv": [(1.00, 1.078), (0.90, 1.047), (0.20, 1.006), (0.10, 0.994),
                (0.05, 0.963), (0.00, 0.875)],
        "sag_1c": 0.03, "cutoff": 0.875, "peukert": 1.0,
    },
    "nmc": {
        "label": "Lithium NMC",
        "ocv": [(1.00, 1.135), (0.80, 1.054), (0.50, 1.000), (0.20, 0.946),
                (0.05, 0.892), (0.00, 0.811)],
        "sag_1c": 0.05, "cutoff": 0.811, "peukert": 1.0,
    },
    "lead_acid": {
        "label": "Lead-acid (VRLA/flooded)",
        "ocv": [(1.00, 1.058), (0.80, 1.029), (0.50, 0.990), (0.20, 0.947),
                (0.00, 0.899)],
        "sag_1c": 0.10, "cutoff": 0.875, "peukert": 1.25,
    },
}


def _k_temp(chemistry: str, temperature_c: float) -> float:
    """Low-temperature capacity correction factor (≥ 1)."""
    t = float(temperature_c)
    if chemistry == "lead_acid":
        # IEEE 485 Table-1 shape: 1.00 at 25 °C, ~1.11 at 15.6 °C, ~1.30 at 4.4 °C
        if t >= 25.0:
            return 1.0
        return min(1.6, 1.0 + (25.0 - t) * 0.0145)
    return 1.0 if t >= 10.0 else 1.10


def _peukert_factor(p_dc_kw: float, i_rated_kw: float, k: float) -> float:
    """Capacity-drain multiplier for a discharge at p_dc_kw against the power
    at the battery's hour rating. [BS2] Never below 1: the Peukert power law
    is a fit above the rated rate, and extrapolating it below that credits a
    lightly loaded bank with capacity the datasheet does not give."""
    if k <= 1.0 or i_rated_kw <= 0 or p_dc_kw <= 0:
        return 1.0
    return max(1.0, (p_dc_kw / i_rated_kw) ** (k - 1.0))


def _usable_capacity_needed(duty, eta_1way: float, dod: float, hour_rating: float,
                            k: float) -> float:
    """[BS1] Smallest rate-corrected bank (kWh, at the hour rating, before the
    temperature / aging / design factors) whose usable window `dod` covers the
    duty with the SAME Peukert law the discharge simulation uses.

    With k = 1 this is Σ(P·t)/η/DoD. For k > 1 the drain depends on the bank
    size itself (a bigger bank runs nearer its hour rate), so solve
    f(C) = Σ P_dc·t·peukert(P_dc, C/H) = DoD·C; f falls and DoD·C rises with
    C, so the root is unique and bisection finds it.
    """
    steps = [(s["load_kw"] / eta_1way, s["duration_min"] / 60.0) for s in duty
             if s["load_kw"] > 0]
    e_dc = sum(p * t for p, t in steps)
    if e_dc <= 0:
        return 0.0
    if k <= 1.0:
        return e_dc / dod

    def drain(c):
        return sum(p * t * _peukert_factor(p, c / hour_rating, k) for p, t in steps)

    lo = e_dc / dod                       # no Peukert penalty: a lower bound
    hi = lo
    while drain(hi) > dod * hi and hi < lo * 1e6:
        hi *= 2.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if drain(mid) > dod * mid:
            lo = mid
        else:
            hi = mid
    return hi


def _ocv_pu(chem: dict, soc: float) -> float:
    """Piecewise-linear OCV lookup, per-unit of nominal voltage."""
    pts = chem["ocv"]
    soc = min(1.0, max(0.0, soc))
    for (s_hi, v_hi), (s_lo, v_lo) in zip(pts, pts[1:]):
        if soc >= s_lo:
            f = (soc - s_lo) / (s_hi - s_lo) if s_hi > s_lo else 0.0
            return v_lo + f * (v_hi - v_lo)
    return pts[-1][1]


def _find_battery(project, battery_id):
    """The requested (or first) battery-backed unit: BESS or hybrid PV."""
    units = [c for c in project.components
             if c.type == "battery"
             or (c.type == "solar_pv"
                 and str(c.props.get("inverter_type", "")) == "hybrid")]
    if battery_id:
        units = [c for c in units if c.id == battery_id]
    return units[0] if units else None


def _default_duty(project, batt, autonomy_target_min):
    """One-step duty cycle from the battery island's essential load."""
    island_of = _island_map(project)
    isl = island_of.get(batt.id)
    load_kw = 0.0
    load_kvar = 0.0
    for comp in project.components:
        if island_of.get(comp.id) != isl:
            continue
        if str(comp.props.get("essential", "yes")).lower() == "no":
            continue
        kw, kvar = _load_kw_kvar(comp)
        load_kw += kw
        load_kvar += kvar
    return [{"duration_min": float(autonomy_target_min), "load_kw": load_kw,
             "load_kvar": load_kvar}]


def run_battery_sizing(project: ProjectData, battery_id: str = "",
                       duty_cycle=None, aging_factor: float = 1.25,
                       design_margin: float = 1.10,
                       temperature_c: float = 25.0,
                       autonomy_target_min: float = 120.0) -> dict:
    warnings = []
    batt = _find_battery(project, battery_id)
    if batt is None:
        return {"converged": False, "note": (
            "No battery (BESS or hybrid-PV) component found"
            + (f" with id '{battery_id}'" if battery_id else "")
            + " — add one, or pick a different unit."),
            "warnings": [], "duty": [], "trajectory": {}, "violations": []}

    p = batt.props
    chem_key = str(p.get("battery_chemistry", "lfp") or "lfp").lower()
    if chem_key not in CHEMISTRY:
        warnings.append(f"Unknown chemistry '{chem_key}' — using LFP.")
        chem_key = "lfp"
    chem = CHEMISTRY[chem_key]

    installed_kwh = float(p.get("battery_kwh", 0) or 0)
    inverter_kva = (float(p.get("rated_kva", 100) or 0) if batt.type == "battery"
                    else float(p.get("rated_kw", 100) or 0))
    bp = _battery_params(batt) or {}
    max_dis_kw = float(bp.get("max_discharge_mw", 0.0)) * 1000.0
    dod = min(1.0, max(0.05, float(p.get("battery_dod_pct", 90) or 90) / 100.0))
    eta_1way = math.sqrt(min(1.0, max(0.05, float(
        p.get("battery_rt_eff", 0.95) or 0.95))))
    soc0 = min(1.0, max(0.0, _prop_float(p, "battery_soc_pct", 100) / 100.0))
    hour_rating = max(0.5, float(p.get("battery_hour_rating_h", 10 if chem_key == "lead_acid" else 1) or 1))
    nominal_v = float(p.get("battery_nominal_v", 48) or 48)

    if chem_key == "lead_acid" and hour_rating < 5.0:
        # [BS3] lead-acid capacity is quoted at C8–C20; the component default
        # of 1 h applies to every chemistry, so a lead-acid unit left at 1 h
        # has its Peukert correction referenced to the wrong rate.
        warnings.append(
            f"Lead-acid capacity is normally quoted at the 10 h rating but the "
            f"hour rating is {hour_rating:g} h — the Peukert correction is "
            f"referenced to that rate. Set the Hour Rating to the datasheet's.")

    aging_factor = max(1.0, float(aging_factor or 1.25))
    design_margin = max(1.0, float(design_margin or 1.10))
    k_temp = _k_temp(chem_key, temperature_c)

    # ── Duty cycle ──
    duty = []
    for step in (duty_cycle or []):
        d = float(step.get("duration_min", 0) or 0)
        kw = float(step.get("load_kw", 0) or 0)
        if d > 0 and kw >= 0:
            duty.append({"duration_min": d, "load_kw": kw,
                         "load_kvar": float(step.get("load_kvar", 0) or 0)})
    derived_duty = False
    if not duty:
        duty = _default_duty(project, batt, autonomy_target_min)
        derived_duty = True
        if duty[0]["load_kw"] <= 1e-9:
            warnings.append("Battery island carries no essential load — "
                            "specify a duty cycle explicitly.")

    duty_kwh = sum(s["duration_min"] / 60.0 * s["load_kw"] for s in duty)
    duty_min = sum(s["duration_min"] for s in duty)
    peak_kw = max((s["load_kw"] for s in duty), default=0.0)
    # [BS4] the inverter is rated in kVA: judge it on apparent power, not kW
    peak_kva = max((math.hypot(s["load_kw"], s.get("load_kvar", 0.0))
                    for s in duty), default=0.0)

    # ── Sizing ──
    k_peukert = chem["peukert"]
    usable_kwh = _usable_capacity_needed(duty, eta_1way, dod, hour_rating,
                                         k_peukert)     # [BS1]
    required_kwh = usable_kwh * aging_factor * design_margin * k_temp
    required_ah = required_kwh * 1000.0 / nominal_v if nominal_v > 0 else 0.0
    sized_ok = installed_kwh + 1e-9 >= required_kwh
    n_units = (math.ceil(required_kwh / installed_kwh - 1e-9)
               if installed_kwh > 0 else None)   # [BS5] no installed unit to count

    violations = []
    if peak_kw > max_dis_kw + 1e-9 and max_dis_kw > 0:
        violations.append({
            "kind": "discharge_limit",
            "message": (f"Duty peak {peak_kw:.1f} kW exceeds the battery "
                        f"discharge limit {max_dis_kw:.1f} kW.")})
    if peak_kva > inverter_kva + 1e-9 and inverter_kva > 0:
        violations.append({
            "kind": "inverter",
            "message": (f"Duty peak {peak_kva:.1f} kVA exceeds the inverter "
                        f"rating {inverter_kva:.1f} kVA.")})

    # ── Discharge simulation on the INSTALLED battery ──
    # Effective usable capacity derated by temperature (cold battery gives
    # less); aging/design margins are sizing conservatism, not physics, so
    # they do not derate the simulation.
    cap_kwh = installed_kwh / k_temp
    i_rated_kw = cap_kwh / hour_rating if hour_rating > 0 else 0.0  # power at the hour rating
    k = chem["peukert"]
    soc_floor = 1.0 - dod

    ts, socs, vs, loads = [], [], [], []
    soc = soc0
    t = 0.0
    runtime_to_floor_min = None
    cutoff_hit_min = None
    for step in duty:
        remaining = step["duration_min"]
        p_ac = step["load_kw"]
        p_dc = p_ac / eta_1way
        while remaining > 1e-9:
            dt = min(DT_MIN, remaining)
            # Peukert correction on the DC power draw (rate vs hour rating)
            p_eff = p_dc * _peukert_factor(p_dc, i_rated_kw, k)
            rate_c = p_dc / cap_kwh if cap_kwh > 0 else 0.0   # in 1/h (×1C)
            v_pu = _ocv_pu(chem, soc) - chem["sag_1c"] * rate_c
            ts.append(t); socs.append(soc); vs.append(v_pu); loads.append(p_ac)
            if runtime_to_floor_min is None and soc <= soc_floor + 1e-12:
                runtime_to_floor_min = t
            if cutoff_hit_min is None and v_pu <= chem["cutoff"] + 1e-12:
                cutoff_hit_min = t
            soc = soc - (p_eff * dt / 60.0) / cap_kwh if cap_kwh > 0 else 0.0
            soc = max(0.0, soc)
            t += dt
            remaining -= dt
    # terminal point
    v_end = _ocv_pu(chem, soc)
    ts.append(t); socs.append(soc); vs.append(v_end); loads.append(0.0)
    if runtime_to_floor_min is None and soc <= soc_floor + 1e-12:
        runtime_to_floor_min = t

    if runtime_to_floor_min is not None and runtime_to_floor_min < duty_min - 1e-6:
        violations.append({
            "kind": "capacity",
            "message": (f"Installed battery reaches its {100 * (1 - dod):.0f}% "
                        f"SoC floor after {runtime_to_floor_min:.0f} min — "
                        f"before the {duty_min:.0f} min duty ends.")})
    if cutoff_hit_min is not None:
        violations.append({
            "kind": "cutoff",
            "message": (f"Terminal voltage reaches the low-voltage cutoff "
                        f"({chem['cutoff']:.3f} pu) after {cutoff_hit_min:.0f} min.")})

    # Decimate the trajectory
    stride = max(1, math.ceil(len(ts) / MAX_POINTS))
    traj = {
        "t_min": [round(v, 2) for v in ts[::stride]],
        "soc_pct": [round(v * 100.0, 3) for v in socs[::stride]],
        "v_pu": [round(v, 4) for v in vs[::stride]],
        "load_kw": [round(v, 3) for v in loads[::stride]],
    }

    return {
        "converged": True,
        "battery_id": batt.id,
        "battery_name": str(p.get("name", batt.id)),
        "chemistry": chem_key,
        "chemistry_label": chem["label"],
        "installed_kwh": round(installed_kwh, 2),
        "inverter_kva": round(inverter_kva, 2),
        "max_discharge_kw": round(max_dis_kw, 2),
        "duty": [{"duration_min": round(s["duration_min"], 1),
                  "load_kw": round(s["load_kw"], 2),
                  "load_kvar": round(s.get("load_kvar", 0.0), 2)} for s in duty],
        "duty_derived": derived_duty,
        "duty_kwh": round(duty_kwh, 3),
        "duty_min": round(duty_min, 1),
        "peak_kw": round(peak_kw, 2),
        "peak_kva": round(peak_kva, 2),
        "factors": {"eta_inverter_1way": round(eta_1way, 4),
                    "dod": round(dod, 3), "aging": aging_factor,
                    "design_margin": design_margin,
                    "k_temp": round(k_temp, 3),
                    "temperature_c": temperature_c,
                    "peukert_k": k, "hour_rating_h": hour_rating},
        "required_kwh": round(required_kwh, 2),
        "required_ah": round(required_ah, 1),
        "nominal_v": nominal_v,
        "sized_ok": sized_ok,
        "units_of_installed_needed": n_units,
        "runtime_to_floor_min": (round(runtime_to_floor_min, 1)
                                 if runtime_to_floor_min is not None else None),
        "min_v_pu": round(min(vs), 4) if vs else None,
        "end_soc_pct": round(soc * 100.0, 2),
        "violations": violations,
        "trajectory": traj,
        "method": ("Energy sizing with IEEE 485-style correction factors "
                   "(aging / design / temperature) + time-step discharge "
                   "simulation (per-chemistry OCV, 1C sag, Peukert on "
                   "lead-acid)"),
        "warnings": warnings,
        "note": "",
    }
