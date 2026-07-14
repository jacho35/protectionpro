"""Contingency Analysis (N-1 / N-2) — security assessment.

Systematically removes each single network element (N-1) — or, optionally, each
pair (N-2) — re-solves the balanced load flow, and flags any resulting thermal
overloads, bus over/under-voltages, or loss of supply (buses that de-energize).
Answers "does the system survive the loss of any one (or two) components?".

The removable set is the classic contingency list: series branches
(cables/transformers) and sources (utility, generator, solar PV, wind, battery).
Transparent devices (breakers, switches) and passive loads are not outaged —
opening a breaker is modelled by the branch it protects, and dropping a load is
not a security event.

Each contingency is an independent re-solve of the existing engine
(``run_load_flow`` never raises on islanding or non-convergence), mirroring the
Load Flow Study Manager's snapshot approach, so one pathological outage cannot
abort the batch.
"""

import itertools

from ..models.schemas import (
    ProjectData, ContingencyResults, ContingencyResult, ContingencyViolation,
)
from .loadflow import run_load_flow, connected_bus_loads_mw


# Elements whose loss is a contingency.
BRANCH_TYPES = ("cable", "transformer")
SOURCE_TYPES = ("utility", "generator", "solar_pv", "wind_turbine", "battery")
OUTAGEABLE_TYPES = BRANCH_TYPES + SOURCE_TYPES

DEFAULT_N2_CAP = 400        # hard cap on N-2 pairs actually solved


def _comp_name(comp):
    return str((comp.props or {}).get("name", comp.id))


def _project_without(project: ProjectData, remove_ids: set) -> ProjectData:
    """A copy of *project* with the given components (and any wire touching them)
    removed."""
    data = project.model_dump()
    data["components"] = [c for c in data["components"] if c["id"] not in remove_ids]
    data["wires"] = [w for w in data["wires"]
                     if w["fromComponent"] not in remove_ids
                     and w["toComponent"] not in remove_ids]
    return ProjectData(**data)


def _evaluate(project: ProjectData, method, base_loads, base_energ_ids,
              v_min, v_max, loading_limit):
    """Solve one network state and return (result, violations, metrics)."""
    result = run_load_flow(project, method)
    violations = []

    if not result.converged:
        violations.append(ContingencyViolation(
            kind="non_converged", element_id="", element_name="",
            value=0.0, limit=0.0,
            detail="Load flow did not converge — system cannot be solved in this state."))

    energ = [b for b in result.buses.values() if b.energized]
    energ_ids = {b.bus_id for b in energ}

    # Thermal overloads
    max_loading = 0.0
    worst_branch = ""
    for br in result.branches:
        if br.loading_pct > max_loading:
            max_loading = br.loading_pct
            worst_branch = br.element_name or br.elementId
        if br.loading_pct > loading_limit + 1e-6:
            violations.append(ContingencyViolation(
                kind="overload", element_id=br.elementId,
                element_name=br.element_name or br.elementId,
                value=round(br.loading_pct, 1), limit=round(loading_limit, 1),
                detail=f"{br.element_name or br.elementId} loaded to "
                       f"{br.loading_pct:.0f}% (limit {loading_limit:.0f}%)."))

    # Voltage violations (energized buses only)
    min_v = min((b.voltage_pu for b in energ), default=0.0)
    max_v = max((b.voltage_pu for b in energ), default=0.0)
    for b in energ:
        if b.voltage_pu < v_min - 1e-6:
            violations.append(ContingencyViolation(
                kind="undervoltage", element_id=b.bus_id, element_name=b.bus_name,
                value=round(b.voltage_pu, 4), limit=round(v_min, 4),
                detail=f"Bus '{b.bus_name}' at {b.voltage_pu:.3f} p.u. "
                       f"(min {v_min:.2f})."))
        elif b.voltage_pu > v_max + 1e-6:
            violations.append(ContingencyViolation(
                kind="overvoltage", element_id=b.bus_id, element_name=b.bus_name,
                value=round(b.voltage_pu, 4), limit=round(v_max, 4),
                detail=f"Bus '{b.bus_name}' at {b.voltage_pu:.3f} p.u. "
                       f"(max {v_max:.2f})."))

    # Loss of supply: buses energized in the base case that went dark, and the
    # load they were carrying.
    lost_ids = base_energ_ids - energ_ids
    lost_load = round(sum(base_loads.get(bid, 0.0) for bid in lost_ids), 4)
    for bid in lost_ids:
        name = result.buses.get(bid).bus_name if bid in result.buses else bid
        violations.append(ContingencyViolation(
            kind="deenergized", element_id=bid, element_name=name,
            value=round(base_loads.get(bid, 0.0), 4), limit=0.0,
            detail=f"Bus '{name}' de-energized — {base_loads.get(bid, 0.0):.3f} MW "
                   "of load lost."))

    metrics = {
        "converged": result.converged,
        "max_loading_pct": round(max_loading, 1),
        "worst_branch": worst_branch,
        "min_v_pu": round(min_v, 4),
        "max_v_pu": round(max_v, 4),
        "lost_load_mw": lost_load,
    }
    return result, violations, metrics


def _status(metrics, violations):
    if not metrics["converged"]:
        return "non_converged"
    if any(v.kind == "deenergized" for v in violations):
        return "islanded"
    if violations:
        return "violations"
    return "secure"


# Severity ranks the status classes for sorting worst-first; within a class the
# violation count and overload magnitude break ties.
_STATUS_RANK = {"non_converged": 3, "islanded": 2, "violations": 1, "secure": 0}


def _severity(status, metrics, violations):
    return (_STATUS_RANK[status], metrics["lost_load_mw"], len(violations),
            metrics["max_loading_pct"])


def run_contingency(project: ProjectData, method: str = "newton_raphson",
                    include_n2: bool = False, v_min: float = 0.95,
                    v_max: float = 1.05, loading_limit_pct: float = 100.0,
                    max_contingencies: int = DEFAULT_N2_CAP) -> ContingencyResults:
    """Run N-1 (and optionally N-2) contingency screening."""
    v_min = float(v_min)
    v_max = float(v_max)
    loading_limit = float(loading_limit_pct)
    warnings = []

    base_loads = connected_bus_loads_mw(project)
    base = run_load_flow(project, method)
    base_energ_ids = {b.bus_id for b in base.buses.values() if b.energized}
    _br, base_violations, _bm = _evaluate(
        project, method, base_loads, base_energ_ids, v_min, v_max, loading_limit)
    if base_violations:
        warnings.append(f"Base case already has {len(base_violations)} "
                        "violation(s) before any outage.")

    outageable = [c for c in project.components if c.type in OUTAGEABLE_TYPES]

    # Build the contingency list: single elements, then optional pairs.
    combos = [(c.id,) for c in outageable]
    n1_count = len(combos)
    skipped = 0
    if include_n2:
        pairs = list(itertools.combinations([c.id for c in outageable], 2))
        room = max(0, max_contingencies - n1_count)
        if len(pairs) > room:
            skipped = len(pairs) - room
            pairs = pairs[:room]
            warnings.append(f"N-2: {skipped} of {len(pairs) + skipped} pairs "
                            "skipped (contingency cap reached).")
        combos.extend(pairs)

    by_id = {c.id: c for c in project.components}
    results = []
    for combo in combos:
        remove = set(combo)
        names = ", ".join(_comp_name(by_id[cid]) for cid in combo if cid in by_id)
        p = _project_without(project, remove)
        _r, violations, metrics = _evaluate(
            p, method, base_loads, base_energ_ids, v_min, v_max, loading_limit)
        status = _status(metrics, violations)
        results.append((
            _severity(status, metrics, violations),
            ContingencyResult(
                id="+".join(combo),
                label=("Loss of " + names) if names else "+".join(combo),
                outaged_ids=list(combo),
                outaged_names=names,
                order=len(combo),
                converged=metrics["converged"],
                status=status,
                violation_count=len(violations),
                max_loading_pct=metrics["max_loading_pct"],
                worst_branch=metrics["worst_branch"],
                min_v_pu=metrics["min_v_pu"],
                max_v_pu=metrics["max_v_pu"],
                lost_load_mw=metrics["lost_load_mw"],
                violations=violations,
            )))

    # Worst first.
    results.sort(key=lambda e: e[0], reverse=True)
    ordered = [r for _, r in results]

    n1_secure = all(r.status == "secure" for r in ordered if r.order == 1)
    worst = ordered[0] if ordered and ordered[0].status != "secure" else None

    return ContingencyResults(
        base_converged=base.converged,
        base_violation_count=len(base_violations),
        base_violations=base_violations,
        n_minus_1_secure=n1_secure,
        n_minus_1_count=n1_count,
        analyzed=len(ordered),
        skipped=skipped,
        mode="N-1 + N-2" if include_n2 else "N-1",
        worst_case_id=worst.id if worst else "",
        worst_case_label=worst.label if worst else "",
        limits={"v_min": v_min, "v_max": v_max, "loading_limit_pct": loading_limit},
        contingencies=ordered,
        method="Load-flow contingency screening",
        warnings=warnings,
    )
