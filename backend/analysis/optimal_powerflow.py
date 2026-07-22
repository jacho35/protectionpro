"""Optimal power flow — economic dispatch + Volt/VAR optimization.

Two coordinated stages over the existing load-flow engine (no new solver):

**Economic dispatch** — sources carry a marginal cost (`cost_per_mwh`, engine
defaults per type below). With linear costs, cost-optimal dispatch IS merit
order by marginal cost, so the stage re-ranks every dispatchable source's
`dispatch_priority` by ascending cost and lets the existing dispatcher (which
already handles must-run constraints, min/max loading, islanding, droop
commitment and loss compensation) produce the dispatch. The most expensive
committed unit naturally becomes the island balancer — the marginal unit, as
economics requires. User `must_run` flags are honoured as constraints.

**Volt/VAR optimization** — a greedy discrete hill climb over the network's
real control variables, each move evaluated with a full load-flow solve:

  * capacitor banks: `steps_in_service` 0…`steps` (new prop, honoured by the
    load flow; absent ⇒ whole bank in service — legacy-identical);
  * transformer / autotransformer taps: `tap_percent` ±2.5 % steps in ±10 %;
  * generator PV-bus voltage setpoints (`voltage_setpoint_pu`) and the
    utility swing setpoint (`v_setpoint_pu`), 0.95…1.05 in 0.01 steps.

Moves are scored lexicographically: voltage/thermal violations first, then
the objective (`cost` → generation cost per hour, `loss` → network MW losses),
then the other of the two as tie-break. The climb stops when no single move
improves the score or the move budget is exhausted.

Reported: baseline vs optimized cost / losses / violations, the applied move
list (element, setting, from → to), the final dispatch table with per-source
costs, and the recommended control settings. Results are on-demand.

Switching (topology) optimization is out of scope — see BACKLOG.
"""

from __future__ import annotations

import json

from ..models.schemas import ProjectData
from .loadflow import run_load_flow

# Marginal-cost defaults when `cost_per_mwh` is absent (currency-neutral,
# per MWh): renewables free, storage cheap (cycling cost), grid mid, diesel
# gensets expensive. Matching UI defaults live in constants.js.
DEFAULT_COST = {"utility": 120.0, "generator": 180.0, "solar_pv": 0.0,
                "wind_turbine": 0.0, "battery": 50.0}
SOURCE_TYPES = tuple(DEFAULT_COST)

TAP_STEP = 2.5
TAP_MIN, TAP_MAX = -10.0, 10.0
VSET_STEP = 0.01
VSET_MIN, VSET_MAX = 0.95, 1.05
MAX_EVALS = 400          # hard cap on load-flow evaluations


def _cost_per_mwh(comp) -> float:
    try:
        c = comp.props.get("cost_per_mwh")
        return float(c) if c not in (None, "") else DEFAULT_COST.get(comp.type, 100.0)
    except (TypeError, ValueError):
        return DEFAULT_COST.get(comp.type, 100.0)


def _metrics(lf, components, v_min, v_max, loading_limit_pct):
    """(cost_per_h, losses_mw, violations list) of one load-flow solution."""
    cost = 0.0
    for e in lf.dispatch or []:
        comp = components.get(e.source_id)
        if comp is not None and e.dispatched_mw > 0:
            cost += e.dispatched_mw * _cost_per_mwh(comp)

    violations = []
    for bid, b in (lf.buses or {}).items():
        if not getattr(b, "energized", True):
            continue
        v = b.voltage_pu
        if v < v_min - 1e-9:
            violations.append({"kind": "undervoltage", "element_id": bid,
                               "name": b.bus_name, "value": round(v, 4),
                               "excess": round(v_min - v, 6)})
        elif v > v_max + 1e-9:
            violations.append({"kind": "overvoltage", "element_id": bid,
                               "name": b.bus_name, "value": round(v, 4),
                               "excess": round(v - v_max, 6)})
    seen = set()
    for br in lf.branches or []:
        comp = components.get(br.elementId)
        if comp is None or comp.type not in ("cable", "transformer",
                                             "autotransformer"):
            continue
        if br.elementId in seen:
            continue
        seen.add(br.elementId)
        if br.loading_pct > loading_limit_pct + 1e-6:
            violations.append({"kind": "overload", "element_id": br.elementId,
                               "name": br.element_name,
                               "value": round(br.loading_pct, 1),
                               "excess": round((br.loading_pct
                                                - loading_limit_pct) / 100.0, 6)})

    losses = sum(max(0.0, br.losses_mw) for br in lf.branches or [])
    return cost, losses, violations


def _score(cost, losses, violations, objective):
    n_viol = len(violations)
    # Severity = how far OUTSIDE the band, so a move that shrinks a violation
    # without clearing it still scores as an improvement.
    sev = sum(v.get("excess", 0.0) for v in violations)
    if objective == "loss":
        return (n_viol, round(sev, 6), round(losses, 9), round(cost, 6))
    return (n_viol, round(sev, 6), round(cost, 6), round(losses, 9))


def _copy_project(project: ProjectData) -> ProjectData:
    return ProjectData(**json.loads(project.model_dump_json()))


def _build_controls(project, use_capacitors, use_taps, use_setpoints):
    """Discrete control variables: (comp_id, prop, allowed values, label)."""
    controls = []
    for c in project.components:
        p = c.props
        if use_capacitors and c.type == "capacitor_bank":
            steps = max(1, int(p.get("steps", 1) or 1))
            cur = p.get("steps_in_service")
            cur = steps if cur in (None, "") else int(cur)
            controls.append({"id": c.id, "prop": "steps_in_service",
                             "values": list(range(0, steps + 1)),
                             "current": min(steps, max(0, cur)),
                             "name": str(p.get("name", c.id)),
                             "unit": f"of {steps} steps"})
        elif use_taps and c.type in ("transformer", "autotransformer"):
            vals = [round(TAP_MIN + i * TAP_STEP, 2)
                    for i in range(int((TAP_MAX - TAP_MIN) / TAP_STEP) + 1)]
            cur = float(p.get("tap_percent", 0) or 0)
            cur = min(vals, key=lambda v: abs(v - cur))
            controls.append({"id": c.id, "prop": "tap_percent",
                             "values": vals, "current": cur,
                             "name": str(p.get("name", c.id)), "unit": "%"})
        elif use_setpoints and c.type == "generator":
            vals = [round(VSET_MIN + i * VSET_STEP, 3)
                    for i in range(int(round((VSET_MAX - VSET_MIN) / VSET_STEP)) + 1)]
            cur = float(p.get("voltage_setpoint_pu", 0)
                        or p.get("v_setpoint_pu", 0) or 1.0)
            cur = min(vals, key=lambda v: abs(v - cur))
            controls.append({"id": c.id, "prop": "voltage_setpoint_pu",
                             "values": vals, "current": cur,
                             "name": str(p.get("name", c.id)), "unit": "pu"})
        elif use_setpoints and c.type == "utility":
            vals = [round(VSET_MIN + i * VSET_STEP, 3)
                    for i in range(int(round((VSET_MAX - VSET_MIN) / VSET_STEP)) + 1)]
            cur = float(p.get("v_setpoint_pu", 1.0) or 1.0)
            cur = min(vals, key=lambda v: abs(v - cur))
            controls.append({"id": c.id, "prop": "v_setpoint_pu",
                             "values": vals, "current": cur,
                             "name": str(p.get("name", c.id)), "unit": "pu"})
    return controls


def run_opf(project: ProjectData, objective: str = "cost",
            v_min: float = 0.95, v_max: float = 1.05,
            loading_limit_pct: float = 100.0,
            use_dispatch: bool = True, use_capacitors: bool = True,
            use_taps: bool = True, use_setpoints: bool = True,
            max_moves: int = 25, method: str = "newton_raphson") -> dict:
    objective = objective if objective in ("cost", "loss") else "cost"
    warnings = []
    components = {c.id: c for c in project.components}
    sources = [c for c in project.components if c.type in SOURCE_TYPES]
    if not sources:
        return {"converged": False, "note": "No sources in the network.",
                "warnings": [], "moves": [], "dispatch": [],
                "baseline": {}, "optimized": {}}

    # ── Baseline ──
    base_lf = run_load_flow(project, method)
    if not base_lf.converged:
        return {"converged": False,
                "note": "Base-case load flow does not converge — fix the "
                        "network before optimizing.",
                "warnings": [w.message for w in base_lf.warnings or []][:5],
                "moves": [], "dispatch": [],
                "baseline": {}, "optimized": {}}
    b_cost, b_loss, b_viol = _metrics(base_lf, components, v_min, v_max,
                                      loading_limit_pct)

    work = _copy_project(project)
    wcomps = {c.id: c for c in work.components}
    moves = []
    evals = 0

    # ── Stage 1: economic dispatch (merit order by marginal cost) ──
    if use_dispatch:
        ranked = sorted((c for c in work.components if c.type in SOURCE_TYPES),
                        key=_cost_per_mwh)
        for rank, c in enumerate(ranked, start=1):
            old = c.props.get("dispatch_priority")
            if old in (None, "") or float(old or 0) != rank:
                c.props["dispatch_priority"] = rank
            if c.type in ("generator", "solar_pv", "wind_turbine"):
                # Economically dispatched up to demand; user must_run is a
                # constraint and stays.
                mode = str(c.props.get("dispatch_mode", "") or "")
                if mode != "must_run":
                    c.props["dispatch_mode"] = "merit_order"

    # ── Stage 2: greedy discrete Volt/VAR hill climb ──
    controls = _build_controls(work, use_capacitors, use_taps, use_setpoints)

    def apply_and_solve():
        nonlocal evals
        evals += 1
        return run_load_flow(work, method)

    cur_lf = apply_and_solve()
    if not cur_lf.converged:
        warnings.append("Economic re-dispatch did not converge — reverting "
                        "to the user dispatch settings.")
        work = _copy_project(project)
        wcomps = {c.id: c for c in work.components}
        controls = _build_controls(work, use_capacitors, use_taps,
                                   use_setpoints)
        cur_lf = apply_and_solve()
    _c0, _l0, _v0 = _metrics(cur_lf, wcomps, v_min, v_max, loading_limit_pct)
    cur_score = _score(_c0, _l0, _v0, objective)

    max_moves = max(0, min(100, int(max_moves)))
    for _round in range(max_moves):
        best = None
        for ctl in controls:
            comp = wcomps[ctl["id"]]
            idx = ctl["values"].index(ctl["current"])
            for nidx in (idx - 1, idx + 1):
                if nidx < 0 or nidx >= len(ctl["values"]):
                    continue
                if evals >= MAX_EVALS:
                    break
                trial = ctl["values"][nidx]
                old = comp.props.get(ctl["prop"])
                comp.props[ctl["prop"]] = trial
                lf = apply_and_solve()
                if lf.converged:
                    c, l, v = _metrics(lf, wcomps, v_min, v_max,
                                       loading_limit_pct)
                    s = _score(c, l, v, objective)
                    if best is None or s < best["score"]:
                        if s < cur_score:
                            best = {"score": s, "ctl": ctl, "value": trial}
                # revert
                if old is None:
                    comp.props.pop(ctl["prop"], None)
                else:
                    comp.props[ctl["prop"]] = old
        if best is None or evals >= MAX_EVALS:
            break
        ctl = best["ctl"]
        comp = wcomps[ctl["id"]]
        moves.append({"element_id": ctl["id"], "name": ctl["name"],
                      "prop": ctl["prop"], "unit": ctl["unit"],
                      "from": ctl["current"], "to": best["value"]})
        comp.props[ctl["prop"]] = best["value"]
        ctl["current"] = best["value"]
        cur_score = best["score"]
    if evals >= MAX_EVALS:
        warnings.append(f"Move budget exhausted ({MAX_EVALS} load-flow "
                        "evaluations) — result may be improvable further.")

    # ── Final solution ──
    final_lf = run_load_flow(work, method)
    o_cost, o_loss, o_viol = _metrics(final_lf, wcomps, v_min, v_max,
                                      loading_limit_pct)

    dispatch = []
    for e in final_lf.dispatch or []:
        comp = wcomps.get(e.source_id)
        rate = _cost_per_mwh(comp) if comp is not None else 0.0
        dispatch.append({
            "source_id": e.source_id, "source_name": e.source_name,
            "source_type": e.source_type, "role": e.role,
            "dispatched_mw": e.dispatched_mw,
            "cost_per_mwh": round(rate, 2),
            "cost_per_h": round(max(0.0, e.dispatched_mw) * rate, 2),
        })
    dispatch.sort(key=lambda d: -d["cost_per_h"])

    settings = [{"element_id": c["id"], "name": c["name"], "prop": c["prop"],
                 "value": c["current"], "unit": c["unit"]}
                for c in controls]

    return {
        "converged": bool(final_lf.converged),
        "objective": objective,
        "baseline": {"cost_per_h": round(b_cost, 2),
                     "losses_mw": round(b_loss, 4),
                     "violations": b_viol},
        "optimized": {"cost_per_h": round(o_cost, 2),
                      "losses_mw": round(o_loss, 4),
                      "violations": o_viol},
        "savings_per_h": round(b_cost - o_cost, 2),
        "loss_reduction_kw": round((b_loss - o_loss) * 1000.0, 2),
        "moves": moves,
        "settings": settings,
        "dispatch": dispatch,
        "lf_evaluations": evals + 1,
        "v_min": v_min, "v_max": v_max,
        "loading_limit_pct": loading_limit_pct,
        "method": ("Merit-order economic dispatch (linear marginal costs) + "
                   "greedy discrete Volt/VAR hill climb (caps / taps / "
                   "setpoints), each move scored by a full load-flow solve"),
        "warnings": warnings,
        "note": "",
    }
