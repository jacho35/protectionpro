"""Optimal capacitor placement — where to add shunt VAR compensation and how
much, to minimize network losses and clear voltage violations.

The classic distribution greedy heuristic (loss-sensitivity placement, e.g.
Grainger & Lee's line of work; the discrete form used by planning tools):
repeatedly trial one standard bank unit (``unit_kvar``) at every candidate
bus with a full load-flow solve, commit the single placement that improves
the score the most, and stop when no unit improves it (or the per-bus /
total budget is hit). Scoring is lexicographic like the OPF study: voltage
violations first (count, then severity), then losses — so compensation
clears undervoltage before it chases kW, and a unit that would push a bus
over ``v_max`` is never chosen.

Placements are simulated with synthetic capacitor banks (constant
susceptance, Q ∝ V², exactly the solver's bank model), so the recommended
list — per-bus kvar — is directly applicable on the diagram as ordinary
capacitor banks. Annualized value is reported as
Δloss × 8760 h × the utility's marginal cost (``cost_per_mwh``, the OPF
prop). Results are on-demand.
"""

from __future__ import annotations

import json

from ..models.schemas import ProjectData
from .loadflow import run_load_flow, is_synthetic_bus
from .optimal_powerflow import _metrics, _score, DEFAULT_COST

MAX_EVALS = 400
HOURS_PER_YEAR = 8760.0


def _with_banks(project: ProjectData, placed: dict) -> ProjectData:
    """Copy of the project with one synthetic bank per placed bus."""
    data = json.loads(project.model_dump_json())
    comps = data["components"]
    wires = data["wires"]
    by_id = {c["id"]: c for c in comps}
    for i, (bus_id, kvar) in enumerate(sorted(placed.items())):
        if kvar <= 0:
            continue
        v_kv = float(by_id[bus_id]["props"].get("voltage_kv", 11) or 11)
        cid = f"__capopt__{i}"
        comps.append({
            "id": cid, "type": "capacitor_bank", "x": 0, "y": 0, "rotation": 0,
            "props": {"name": f"OCP {bus_id}", "voltage_kv": v_kv,
                      "rated_kvar": kvar, "steps": 1},
        })
        wires.append({"id": f"__capopt__w{i}", "fromComponent": bus_id,
                      "fromPort": f"at_c{i}", "toComponent": cid,
                      "toPort": "in"})
    return ProjectData(**data)


def run_capacitor_placement(project: ProjectData, bus_ids=None,
                            unit_kvar: float = 100.0,
                            max_kvar_per_bus: float = 2000.0,
                            max_total_kvar: float = 5000.0,
                            v_min: float = 0.95, v_max: float = 1.05,
                            min_loss_reduction_kw: float = 0.05,
                            method: str = "newton_raphson") -> dict:
    unit_kvar = max(10.0, float(unit_kvar or 100.0))
    max_kvar_per_bus = max(unit_kvar, float(max_kvar_per_bus or 2000.0))
    max_total_kvar = max(unit_kvar, float(max_total_kvar or 5000.0))
    warnings = []

    components = {c.id: c for c in project.components}
    base_lf = run_load_flow(project, method)
    if not base_lf.converged:
        return {"converged": False,
                "note": "Base-case load flow does not converge — fix the "
                        "network before optimizing.",
                "warnings": [w.message for w in base_lf.warnings or []][:5],
                "placements": [], "moves": [], "baseline": {}, "optimized": {}}
    b_cost, b_loss, b_viol = _metrics(base_lf, components, v_min, v_max, 100.0)

    # Candidate buses: requested, else every real energized bus.
    candidates = []
    for c in project.components:
        if c.type not in ("bus", "distribution_board"):
            continue
        if is_synthetic_bus(c.id):
            continue
        if bus_ids and c.id not in bus_ids:
            continue
        b = (base_lf.buses or {}).get(c.id)
        if b is None or not getattr(b, "energized", True):
            continue
        candidates.append(c.id)
    if not candidates:
        return {"converged": False,
                "note": "No candidate buses (energized, non-synthetic) found.",
                "warnings": warnings, "placements": [], "moves": [],
                "baseline": {}, "optimized": {}}

    placed = {}
    moves = []
    evals = 0
    cur_score = _score(b_cost, b_loss, b_viol, "loss")
    cur_loss = b_loss

    while sum(placed.values()) + unit_kvar <= max_total_kvar + 1e-9:
        best = None
        for bus_id in candidates:
            if placed.get(bus_id, 0.0) + unit_kvar > max_kvar_per_bus + 1e-9:
                continue
            if evals >= MAX_EVALS:
                break
            trial = dict(placed)
            trial[bus_id] = trial.get(bus_id, 0.0) + unit_kvar
            lf = run_load_flow(_with_banks(project, trial), method)
            evals += 1
            if not lf.converged:
                continue
            tcomps = {c.id: c for c in project.components}
            c_, l_, v_ = _metrics(lf, tcomps, v_min, v_max, 100.0)
            s = _score(c_, l_, v_, "loss")
            if s < cur_score and (best is None or s < best["score"]):
                best = {"score": s, "bus": bus_id, "loss": l_, "viol": v_}
        if best is None or evals >= MAX_EVALS:
            break
        # require a material improvement unless violations improved
        loss_gain_kw = (cur_loss - best["loss"]) * 1000.0
        viol_better = best["score"][:2] < cur_score[:2]
        if not viol_better and loss_gain_kw < min_loss_reduction_kw:
            break
        placed[best["bus"]] = placed.get(best["bus"], 0.0) + unit_kvar
        moves.append({"bus_id": best["bus"],
                      "name": str(components[best["bus"]].props.get(
                          "name", best["bus"])),
                      "kvar_added": unit_kvar,
                      "total_kvar": placed[best["bus"]],
                      "loss_reduction_kw": round(loss_gain_kw, 3)})
        cur_score = best["score"]
        cur_loss = best["loss"]
    if evals >= MAX_EVALS:
        warnings.append(f"Evaluation budget exhausted ({MAX_EVALS} load-flow "
                        "solves) — result may be improvable further.")

    final_lf = run_load_flow(_with_banks(project, placed), method)
    o_cost, o_loss, o_viol = _metrics(final_lf, components, v_min, v_max,
                                      100.0)

    # Annualized value at the utility's marginal cost.
    util = next((c for c in project.components if c.type == "utility"), None)
    rate = DEFAULT_COST["utility"]
    if util is not None:
        try:
            r = util.props.get("cost_per_mwh")
            rate = float(r) if r not in (None, "") else rate
        except (TypeError, ValueError):
            pass
    savings_mwh_yr = max(0.0, (b_loss - o_loss)) * HOURS_PER_YEAR

    placements = [{"bus_id": bid,
                   "name": str(components[bid].props.get("name", bid)),
                   "kvar": round(kv, 1),
                   "v_before": round((base_lf.buses or {})[bid].voltage_pu, 4)
                   if bid in (base_lf.buses or {}) else None,
                   "v_after": round((final_lf.buses or {})[bid].voltage_pu, 4)
                   if bid in (final_lf.buses or {}) else None}
                  for bid, kv in sorted(placed.items(), key=lambda x: -x[1])
                  if kv > 0]

    if not placements:
        warnings.append("No placement improves the network — losses are "
                        "already minimal for the modelled load / the unit "
                        "size is too coarse.")

    return {
        "converged": bool(final_lf.converged),
        "unit_kvar": unit_kvar,
        "total_kvar": round(sum(placed.values()), 1),
        "placements": placements,
        "moves": moves,
        "baseline": {"losses_mw": round(b_loss, 5), "violations": b_viol},
        "optimized": {"losses_mw": round(o_loss, 5), "violations": o_viol},
        "loss_reduction_kw": round((b_loss - o_loss) * 1000.0, 2),
        "energy_savings_mwh_yr": round(savings_mwh_yr, 2),
        "savings_per_yr": round(savings_mwh_yr * rate, 0),
        "cost_per_mwh": rate,
        "lf_evaluations": evals + 2,
        "v_min": v_min, "v_max": v_max,
        "method": ("Greedy loss-sensitivity placement: one standard unit per "
                   "round at the bus with the largest scored improvement "
                   "(violations first, then losses), each trial a full "
                   "load-flow solve; banks modelled as constant susceptance "
                   "(Q ∝ V²)"),
        "warnings": warnings,
        "note": ("Apply each placement on the diagram as a capacitor bank "
                 "with the listed kvar."),
    }
