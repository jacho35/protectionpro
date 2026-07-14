"""Load Flow Study Manager — run load flow across several named network cases.

A "case" is a self-contained snapshot of a network configuration (its own
components, wires, base MVA and solver method). This module builds a project
for each case, runs the existing balanced load-flow engine on it, and returns a
compact per-case summary alongside the full result — so the frontend can
tabulate the effect of different configurations on one system side by side.

The current live network is included as an implicit "Current network" case so
every study is compared against the as-built baseline.
"""

from ..models.schemas import (
    ProjectData, LoadFlowCaseInput, LoadFlowCaseResult, LoadFlowCaseSummary,
    LoadFlowResults,
)
from .loadflow import run_load_flow

OVERLOAD_PCT = 100.0


def _project_for_case(base: ProjectData, case: LoadFlowCaseInput) -> ProjectData:
    """A project built from the case snapshot, falling back to the live network
    for any field the case did not capture."""
    update = {}
    if case.components:
        update["components"] = case.components
    if case.wires:
        update["wires"] = case.wires
    if case.baseMVA is not None:
        update["baseMVA"] = case.baseMVA
    if case.loadFlowMethod:
        update["loadFlowMethod"] = case.loadFlowMethod
    return base.model_copy(update=update) if update else base


def _summary(result: LoadFlowResults) -> LoadFlowCaseSummary:
    energized = [b for b in result.buses.values() if b.energized]
    min_b = min(energized, key=lambda b: b.voltage_pu, default=None)
    max_b = max(energized, key=lambda b: b.voltage_pu, default=None)
    over = [br for br in result.branches if br.loading_pct > OVERLOAD_PCT]
    worst = max(result.branches, key=lambda br: br.loading_pct, default=None)
    return LoadFlowCaseSummary(
        converged=result.converged,
        iterations=result.iterations,
        min_v_pu=round(min_b.voltage_pu, 4) if min_b else None,
        min_v_bus=min_b.bus_name if min_b else "",
        max_v_pu=round(max_b.voltage_pu, 4) if max_b else None,
        max_v_bus=max_b.bus_name if max_b else "",
        total_losses_mw=round(sum(br.losses_mw for br in result.branches), 4),
        overloaded_branch_count=len(over),
        worst_branch_name=worst.element_name if worst else "",
        worst_branch_loading_pct=round(worst.loading_pct, 1) if worst else 0,
        deenergized_bus_count=sum(1 for b in result.buses.values() if not b.energized),
    )


def run_loadflow_cases(project: ProjectData, cases, method="newton_raphson",
                       include_current=True):
    """Run load flow for each case (plus the current network) and summarise.

    ``run_load_flow`` never raises on islanding or non-convergence — it reports
    ``converged=False`` / de-energized buses — so one pathological case does not
    abort the batch."""
    runlist = []
    if include_current:
        # The live network exactly as submitted, no snapshot override.
        runlist.append(LoadFlowCaseInput(id="__current__", name="Current network"))
    runlist.extend(cases)

    out = []
    for case in runlist:
        p = _project_for_case(project, case)
        m = case.loadFlowMethod or method
        result = run_load_flow(p, m)
        out.append(LoadFlowCaseResult(
            id=case.id, name=case.name or case.id,
            result=result, summary=_summary(result)))
    return out
