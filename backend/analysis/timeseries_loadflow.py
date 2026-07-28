"""Time-series / quasi-dynamic load flow (QDS).

Runs the existing balanced load-flow solver (``loadflow.run_load_flow``) once
per time step over a 24 h or 8760 h load/generation profile — the PowerFactory
QDS / PSS(R)E Time-Series PF / ETAP load-profile workhorse. This is deliberately
a thin composition layer: no new power-flow mathematics, just profile
application, BESS state-of-charge integration, and carrying discrete control
state (OLTC tap position, switched-capacitor steps) forward between steps.

**Quasi-dynamic, not N independent snapshots** — the distinguishing behaviour
callers should notice:

  * BESS state of charge is integrated from the *actual* dispatched power at
    each step (read back from ``LoadFlowResults.dispatch``) and carried into
    the next step's ``battery_soc_pct``. A battery at 0% SoC cannot discharge
    at the next step; one at 100% cannot charge — the dispatch itself already
    enforces this (``loadflow._battery_params``), so simply feeding the
    integrated SoC forward is suffient.
  * OLTC tap position is carried forward: each step's regulation
    (``loadflow._run_oltc``) starts from the PREVIOUS step's converged tap,
    not the network's static default, so the tap only moves the few steps a
    normal load change requires instead of re-traversing its full range every
    snapshot. This is both more physically realistic (a real OLTC does not
    instantly re-home every time interval) and materially faster.
  * Switched capacitor banks with ``cap_control_mode: "auto"`` are switched
    by a simple hysteresis controller on their local bus voltage (read from
    the PREVIOUS step's solved result) — a bank switched in at a low-voltage
    step stays in until voltage recovers past the high band, rather than
    being independently re-decided from scratch each step. Banks without
    that prop keep their static ``steps_in_service`` unchanged (legacy
    behaviour, trivially "carried" since nothing touches it).

**Profiles** — every load/source component is assigned a named profile (a
24-point hourly shape, linearly interpolated for sub-hourly steps and tiled
across the horizon for a full 8760 h run): explicitly via the request's
``profile_overrides`` (component id -> name), else the component's own
``ts_profile`` prop, else the request's ``default_profile``, else a sane
per-type built-in (residential for general loads, industrial for motors,
clear-sky for solar PV, flat/unchanged for everything else). The profile
multiplies the component's OWN nameplate value captured at t=0 (its
``demand_factor`` for loads, ``irradiance_pct`` for solar, ``wind_speed_pct``
for wind, ``rated_mva`` for a scheduled generator) — a "flat" profile (all
multipliers = 1.0) therefore reproduces the single-shot ``run_load_flow``
result exactly at every step, which anchors the regression test.

**Performance** — an 8760-step run is 8760 full Newton-Raphson solves; cost
scales with step count times per-solve cost, and per-solve cost scales with
network size (``loadflow.py``'s NR is a plain nested-loop Jacobian build/solve,
not vectorised or sparse). Measured on this branch (see
``backend/tests/test_timeseries_loadflow.py::test_8760_step_performance``):
a 2-bus feeder is ~4.5s for 8760 steps (~0.5 ms/step); the same feeder with an
OLTC-regulating transformer is ~9s (~1 ms/step — the tap carry-forward below
keeps this from being far worse); a 20-bus radial feeder is ~60s (~7 ms/step).
All comfortably under the 10-minute concern threshold for the network sizes
this tool is used for. The one mitigation this module DOES apply is the OLTC
tap carry-forward (see above): each step's regulation starts from the
previous step's converged tap instead of the network's static default, so it
typically needs 0-1 internal re-solves per step instead of retraversing the
full tap range from scratch. A genuine solver-level warm start (seeding
Newton-Raphson's initial V/theta from the previous step's converged solution
— the standard QDS mitigation when per-solve cost dominates) was deliberately
NOT implemented here: it would require changing ``loadflow._newton_raphson``
/ ``_gauss_seidel``'s flat-start initialisation, which is shared by every
other analysis engine in this codebase, for a mitigation this module doesn't
currently need at measured network sizes. If a much larger network (~100+
buses) makes an 8760-step study slow, that warm start is the documented next
step, not a silent gap.

Never raises: a step whose solver diverges or hits a singular Jacobian is
recorded in ``non_converged_steps`` and the run continues — mirroring
``loadflow_cases.py`` / ``contingency.py``.

Results are on-demand (not persisted with the project).
"""

from __future__ import annotations

import json
import math
import time

from ..models.schemas import (
    ProjectData, TimeSeriesLoadFlowResults, TimeSeriesBusEnvelope,
    TimeSeriesBranchPeak, TimeSeriesBatteryTrajectory,
)
from .loadflow import run_load_flow, _run_oltc, _is_transparent_and_closed


# ── Built-in daily shapes: 24 hourly multipliers (0..1), index = hour of day ──
BUILTIN_PROFILES = {
    "flat": [1.0] * 24,
    # Residential: morning bump, daytime trough (occupants out), evening peak.
    "residential": [0.42, 0.38, 0.35, 0.33, 0.33, 0.36, 0.45, 0.55, 0.60, 0.58,
                    0.55, 0.54, 0.56, 0.55, 0.54, 0.58, 0.68, 0.85, 1.00, 0.98,
                    0.88, 0.72, 0.58, 0.48],
    # Commercial/office: sharp daytime peak, low overnight.
    "commercial": [0.25, 0.22, 0.20, 0.20, 0.20, 0.22, 0.30, 0.55, 0.80, 0.92,
                   0.98, 1.00, 0.97, 0.98, 0.95, 0.90, 0.80, 0.62, 0.45, 0.35,
                   0.30, 0.28, 0.27, 0.26],
    # Industrial: high base load (shift work), broad daytime plateau.
    "industrial": [0.65, 0.62, 0.60, 0.60, 0.62, 0.68, 0.82, 0.95, 1.00, 0.99,
                   0.97, 0.90, 0.80, 0.90, 0.98, 1.00, 0.97, 0.90, 0.78, 0.72,
                   0.70, 0.68, 0.67, 0.66],
    # Clear-sky PV: zero at night, bell curve peaking at solar noon.
    "pv_clear_sky": [0, 0, 0, 0, 0, 0, 0.02, 0.12, 0.32, 0.55, 0.75, 0.90,
                     1.00, 0.95, 0.82, 0.60, 0.35, 0.13, 0.02, 0, 0, 0, 0, 0],
}

# Which prop a profile multiplies, per component type, and its fallback
# nameplate value when the prop is absent.
_PROFILE_TARGET = {
    "static_load": ("demand_factor", 1.0),
    "motor_induction": ("demand_factor", 1.0),
    "motor_synchronous": ("demand_factor", 1.0),
    "distribution_board": ("demand_factor", 1.0),
    "solar_pv": ("irradiance_pct", 100.0),
    "wind_turbine": ("wind_speed_pct", 100.0),
    "generator": ("rated_mva", 10.0),
}
_PCT_TARGETS = {"irradiance_pct", "wind_speed_pct"}   # clipped to [0, 100]

DEFAULT_PROFILE_BY_TYPE = {
    "static_load": "residential",
    "motor_induction": "industrial",
    "motor_synchronous": "industrial",
    "distribution_board": "residential",
    "solar_pv": "pv_clear_sky",
    "wind_turbine": "flat",
    "generator": "flat",
}

def _shape_multiplier(name: str, hour_frac: float) -> float:
    """Linearly-interpolated multiplier from a 24-point hourly shape at a
    fractional hour-of-day (wraps at 24h so an 8760 h run tiles the daily
    shape across the whole horizon)."""
    pts = BUILTIN_PROFILES.get(name) or BUILTIN_PROFILES["flat"]
    h = hour_frac % 24.0
    i0 = int(math.floor(h)) % 24
    i1 = (i0 + 1) % 24
    f = h - math.floor(h)
    return pts[i0] * (1 - f) + pts[i1] * f


def _profile_for(comp, default_profile, overrides) -> str:
    if comp.id in overrides and overrides[comp.id]:
        name = str(overrides[comp.id])
    else:
        name = str(comp.props.get("ts_profile", "") or "")
        if not name:
            name = str(default_profile or "") or DEFAULT_PROFILE_BY_TYPE.get(comp.type, "flat")
    return name if name in BUILTIN_PROFILES else "flat"


def _is_hybrid_battery(comp) -> bool:
    return comp.type == "solar_pv" and str(comp.props.get("inverter_type", "")) == "hybrid"


def _find_local_bus(comp_id, adjacency, bus_ids, components):
    """BFS from a leaf component (e.g. a capacitor bank) through transparent
    elements (breakers/switches/CTs/...) to the bus it is electrically
    connected to. Returns None if it does not reach one."""
    visited = {comp_id}
    stack = [comp_id]
    while stack:
        nid = stack.pop()
        for nb in adjacency.get(nid, []):
            if nb in visited:
                continue
            visited.add(nb)
            if nb in bus_ids:
                return nb
            comp = components.get(nb)
            if comp is not None and _is_transparent_and_closed(comp):
                stack.append(nb)
    return None


def run_timeseries_loadflow(project: ProjectData, method: str = "newton_raphson",
                            horizon_hours: float = 24.0, step_minutes: float = 60.0,
                            default_profile: str | None = None,
                            profile_overrides: dict | None = None,
                            v_min: float = 0.95, v_max: float = 1.05,
                            loading_limit_pct: float = 100.0) -> TimeSeriesLoadFlowResults:
    """Run the quasi-dynamic time-series load flow. Never raises — a step that
    fails to converge is recorded and the run continues."""
    t_wall_start = time.perf_counter()
    warnings: list[str] = []
    overrides = {str(k): str(v) for k, v in (profile_overrides or {}).items()}
    v_min = float(v_min); v_max = float(v_max)
    loading_limit = float(loading_limit_pct)

    step_minutes = max(1.0, float(step_minutes or 60.0))
    horizon_hours = max(step_minutes / 60.0, float(horizon_hours or 24.0))
    n_steps = max(1, round(horizon_hours * 60.0 / step_minutes))
    dt_h = step_minutes / 60.0

    base_components = {c.id: c for c in project.components}

    # ── Profile plan: (component_id, target_prop, base_nameplate_value, profile_name) ──
    plan = []
    profiles_used = {}
    for comp in project.components:
        target = _PROFILE_TARGET.get(comp.type)
        if not target:
            continue
        prop, fallback = target
        base_val = comp.props.get(prop, fallback)
        try:
            base_val = float(base_val) if base_val not in (None, "") else fallback
        except (TypeError, ValueError):
            base_val = fallback
        prof = _profile_for(comp, default_profile, overrides)
        plan.append((comp.id, prop, base_val, prof))
        profiles_used[comp.id] = prof

    # ── Batteries (BESS + DC-coupled hybrid PV) — carried SoC ──
    batt_ids = [c.id for c in project.components
                if c.type == "battery" or _is_hybrid_battery(c)]
    soc = {}
    kwh_nameplate = {}
    eta_1way = {}
    for bid in batt_ids:
        comp = base_components[bid]
        kwh_nameplate[bid] = float(comp.props.get("battery_kwh", 0) or 0)
        rt = float(comp.props.get("battery_rt_eff", 0.95) or 0.95)
        eta_1way[bid] = math.sqrt(min(1.0, max(0.05, rt)))
        soc[bid] = min(100.0, max(0.0, float(comp.props.get("battery_soc_pct", 100) or 100)))
    soc_traj = {bid: [] for bid in batt_ids}
    dispatch_traj = {bid: [] for bid in batt_ids}

    # ── OLTC regulators — tap carried forward via the persistent `work` copy ──
    reg_ids = {c.id for c in project.components
               if c.type in ("transformer", "autotransformer")
               and str(c.props.get("tap_mode", "fixed") or "fixed").lower() == "regulating"}

    # ── Switched capacitor banks in "auto" (voltage-hysteresis) mode ──
    cap_auto_ids = [c.id for c in project.components
                    if c.type == "capacitor_bank"
                    and str(c.props.get("cap_control_mode", "fixed") or "fixed").lower() == "auto"]
    cap_bus = {}
    if cap_auto_ids:
        adjacency = {}
        for w in project.wires:
            adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
            adjacency.setdefault(w.toComponent, []).append(w.fromComponent)
        bus_ids = {c.id for c in project.components
                   if c.type in ("bus", "distribution_board")}
        for cid in cap_auto_ids:
            cap_bus[cid] = _find_local_bus(cid, adjacency, bus_ids, base_components)

    # Persistent working copy: carries OLTC tap position + cap steps_in_service
    # forward between steps. Everything else (loads/PV/wind/SoC) is freshly
    # recomputed from the ORIGINAL nameplate values each step, so it never drifts.
    work = ProjectData(**json.loads(project.model_dump_json()))

    non_converged: list[int] = []
    bus_env: dict[str, dict] = {}       # bus_id -> {name, min_v, min_step, max_v, max_step}
    branch_env: dict[str, dict] = {}    # element_id -> {name, peak_pct, peak_step, peak_p}
    t_hours = []
    min_v_series = []
    max_v_series = []
    max_loading_series = []
    losses_series = []
    total_losses_mwh = 0.0
    violation_steps = 0
    prev_bus_v: dict[str, float] = {}
    converged_any = False
    clamped_batteries: set = set()

    for step in range(n_steps):
        t = step * dt_h
        t_hours.append(round(t, 6))
        hour_of_day = t % 24.0

        step_proj = ProjectData(**json.loads(work.model_dump_json()))
        comps_by_id = {c.id: c for c in step_proj.components}

        # Load / generation profile multipliers, from the ORIGINAL nameplate.
        for comp_id, prop, base_val, prof in plan:
            comp = comps_by_id.get(comp_id)
            if comp is None:
                continue
            mult = _shape_multiplier(prof, hour_of_day)
            val = base_val * mult
            if prop in _PCT_TARGETS:
                val = max(0.0, min(100.0, val))
            comp.props[prop] = val

        # BESS SoC gates this step's dispatch (loadflow._battery_params reads it).
        for bid in batt_ids:
            comp = comps_by_id.get(bid)
            if comp is not None:
                comp.props["battery_soc_pct"] = round(soc[bid], 4)

        # Switched-cap hysteresis, decided from the PREVIOUS step's bus voltage.
        for cid in cap_auto_ids:
            comp = comps_by_id.get(cid)
            if comp is None:
                continue
            bus_id = cap_bus.get(cid)
            v = prev_bus_v.get(bus_id) if bus_id else None
            if v is None:
                continue
            steps_n = max(1, int(comp.props.get("steps", 1) or 1))
            cur = comp.props.get("steps_in_service")
            cur = steps_n if cur in (None, "") else max(0, min(steps_n, int(cur)))
            v_low = float(comp.props.get("cap_v_low_pu", 0.98) or 0.98)
            v_high = float(comp.props.get("cap_v_high_pu", 1.02) or 1.02)
            if v < v_low and cur < steps_n:
                cur += 1
            elif v > v_high and cur > 0:
                cur -= 1
            comp.props["steps_in_service"] = cur

        # OLTC: regulate from the CARRIED tap position (see module docstring).
        regulated = step_proj
        if reg_ids:
            regs = [c for c in step_proj.components if c.id in reg_ids]
            try:
                regulated = _run_oltc(step_proj, method, regs)
            except Exception as e:  # never let one bad step abort the run
                warnings.append(f"Step {step} (t={t:.2f}h): OLTC regulation "
                                f"raised {e!r} — tap held at its prior position.")
                regulated = step_proj

        result = None
        try:
            result = run_load_flow(regulated, method, _regulate=False)
        except Exception as e:
            warnings.append(f"Step {step} (t={t:.2f}h): solver raised "
                            f"{e!r} — recorded as non-converged.")

        if result is None or not result.converged:
            non_converged.append(step)
            min_v_series.append(None)
            max_v_series.append(None)
            max_loading_series.append(None)
            losses_series.append(None)
            for bid in batt_ids:
                soc_traj[bid].append(round(soc[bid], 3))
                dispatch_traj[bid].append(0.0)
            continue
        converged_any = True

        # Carry OLTC tap + cap steps_in_service forward into `work`.
        reg_by_id = {c.id: c for c in regulated.components}
        for c in work.components:
            src = reg_by_id.get(c.id)
            if src is None:
                continue
            if c.id in reg_ids:
                c.props["tap_percent"] = src.props.get("tap_percent", c.props.get("tap_percent"))
            if c.id in cap_auto_ids:
                c.props["steps_in_service"] = src.props.get(
                    "steps_in_service", c.props.get("steps_in_service"))

        # ── Aggregate: bus voltage envelope, branch loading peak, losses ──
        energized = [b for b in result.buses.values() if b.energized]
        step_min_v = min((b.voltage_pu for b in energized), default=None)
        step_max_v = max((b.voltage_pu for b in energized), default=None)
        min_v_series.append(round(step_min_v, 5) if step_min_v is not None else None)
        max_v_series.append(round(step_max_v, 5) if step_max_v is not None else None)
        prev_bus_v = {b.bus_id: b.voltage_pu for b in energized}

        for b in energized:
            e = bus_env.setdefault(b.bus_id, {
                "name": b.bus_name, "min_v": b.voltage_pu, "min_step": step,
                "max_v": b.voltage_pu, "max_step": step,
            })
            if b.voltage_pu < e["min_v"]:
                e["min_v"], e["min_step"] = b.voltage_pu, step
            if b.voltage_pu > e["max_v"]:
                e["max_v"], e["max_step"] = b.voltage_pu, step

        step_max_loading = 0.0
        step_losses = 0.0
        for br in result.branches:
            step_losses += br.losses_mw
            if br.loading_pct > step_max_loading:
                step_max_loading = br.loading_pct
            e = branch_env.setdefault(br.elementId, {
                "name": br.element_name or br.elementId,
                "peak_pct": br.loading_pct, "peak_step": step, "peak_p": br.p_mw,
            })
            if br.loading_pct > e["peak_pct"]:
                e.update(peak_pct=br.loading_pct, peak_step=step, peak_p=br.p_mw)
        max_loading_series.append(round(step_max_loading, 3))
        losses_series.append(round(step_losses, 6))
        total_losses_mwh += step_losses * dt_h

        step_violation = (
            (step_min_v is not None and step_min_v < v_min - 1e-6)
            or (step_max_v is not None and step_max_v > v_max + 1e-6)
            or step_max_loading > loading_limit + 1e-6
        )
        if step_violation:
            violation_steps += 1

        # ── BESS: read actual dispatched AC power back, integrate SoC ──
        for bid in batt_ids:
            p_bat = 0.0
            for de in result.dispatch:
                if de.source_id == bid and de.source_type == "battery":
                    p_bat += de.dispatched_mw
            dispatch_traj[bid].append(round(p_bat, 5))
            kwh = kwh_nameplate[bid]
            if kwh > 1e-9:
                eta = eta_1way[bid]
                if p_bat > 0:       # discharging: DC energy drawn > AC delivered
                    d_kwh = (p_bat / eta) * dt_h * 1000.0
                    new_soc = soc[bid] - d_kwh / kwh * 100.0
                    if new_soc < -1e-6 and bid not in clamped_batteries:
                        clamped_batteries.add(bid)
                        bname = str(base_components[bid].props.get("name", bid))
                        warnings.append(
                            f"Battery '{bname}': step {step} (t={t:.2f}h) would "
                            "discharge more energy than is stored at this step "
                            "size — SoC clamped to 0%. A battery at 0% cannot "
                            "discharge further; use a finer step for exact "
                            "depletion timing.")
                    soc[bid] = max(0.0, new_soc)
                elif p_bat < 0:     # charging: DC energy stored < AC drawn
                    d_kwh = (-p_bat * eta) * dt_h * 1000.0
                    new_soc = soc[bid] + d_kwh / kwh * 100.0
                    if new_soc > 100.0 + 1e-6 and bid not in clamped_batteries:
                        clamped_batteries.add(bid)
                        bname = str(base_components[bid].props.get("name", bid))
                        warnings.append(
                            f"Battery '{bname}': step {step} (t={t:.2f}h) would "
                            "charge past 100% at this step size — SoC clamped "
                            "to 100%; use a finer step for exact full-charge "
                            "timing.")
                    soc[bid] = min(100.0, new_soc)
            soc_traj[bid].append(round(soc[bid], 3))

    solve_time_s = time.perf_counter() - t_wall_start

    bus_envelopes = [
        TimeSeriesBusEnvelope(bus_id=bid, bus_name=str(e["name"]),
                              min_v_pu=round(e["min_v"], 5), min_v_step=e["min_step"],
                              max_v_pu=round(e["max_v"], 5), max_v_step=e["max_step"])
        for bid, e in bus_env.items()
    ]
    branch_peaks = [
        TimeSeriesBranchPeak(element_id=eid, element_name=str(e["name"]),
                            peak_loading_pct=round(e["peak_pct"], 2),
                            peak_step=e["peak_step"], peak_p_mw=round(e["peak_p"], 4))
        for eid, e in branch_env.items()
    ]
    battery_trajectories = [
        TimeSeriesBatteryTrajectory(
            battery_id=bid,
            battery_name=str(base_components[bid].props.get("name", bid)),
            soc_pct=soc_traj[bid], dispatched_mw=dispatch_traj[bid])
        for bid in batt_ids
    ]

    if non_converged:
        warnings.append(f"{len(non_converged)} of {n_steps} step(s) did not "
                        "converge — excluded from the envelope/loss aggregates.")
    if n_steps > 2000 and solve_time_s > 60.0:
        warnings.append(
            f"{n_steps}-step run took {solve_time_s:.1f}s wall-clock "
            f"({1000 * solve_time_s / n_steps:.1f} ms/step). For 8760-step "
            "studies consider a coarser step (1h instead of 15min) if this "
            "becomes a bottleneck.")

    return TimeSeriesLoadFlowResults(
        converged=converged_any,
        steps=n_steps,
        step_minutes=step_minutes,
        horizon_hours=horizon_hours,
        t_hours=t_hours,
        non_converged_steps=non_converged,
        violation_step_count=violation_steps,
        total_losses_mwh=round(total_losses_mwh, 5),
        bus_envelopes=bus_envelopes,
        branch_peaks=branch_peaks,
        battery_trajectories=battery_trajectories,
        min_v_pu_series=min_v_series,
        max_v_pu_series=max_v_series,
        max_loading_pct_series=max_loading_series,
        losses_mw_series=losses_series,
        limits={"v_min": v_min, "v_max": v_max, "loading_limit_pct": loading_limit},
        solve_time_s=round(solve_time_s, 3),
        method=method,
        profiles_used=profiles_used,
        warnings=warnings,
        note="",
    )
