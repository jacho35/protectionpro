"""Feeder hosting capacity — the maximum DER (PV) that can be interconnected
at a bus before a technical limit is violated.

**Nodal hosting capacity** (deterministic, per candidate bus): a synthetic
unity-pf solar PV source is injected at increasing power, the load flow
re-solved at each step, until a limit is crossed. This follows the same
sweep-then-bisect pattern the voltage-stability nose search already uses
(`voltage_stability.py`): step up in `step_mw` increments to bracket the
violation, then bisect `BISECT_STEPS` times to refine the boundary. Two
"screens" are checked — the two dominant, most commonly binding constraints
in utility hosting-capacity studies (e.g. EPRI's DRIVE methodology):

  * **voltage rise** — reverse power flow from the DER raises the local
    (and upstream) bus voltage; capacity is limited when any bus exceeds
    `v_max`;
  * **thermal overload** — the added generation loads the feeder/transformer
    beyond `loading_limit_pct` in the *export* direction.

Both screens reuse `optimal_powerflow._metrics`, the exact violation-scoring
helper the OPF and capacitor-placement studies already use, so a bus's
"capacity" is precisely the largest injection with zero `_metrics`
violations. The binding one (whichever crosses first) is reported per bus.

**Deliberately out of scope**: fault-level / protection-coordination impact
and a *stochastic* hosting capacity (Monte Carlo over uncertain load/DER
combinations — this tool has no load/irradiance uncertainty model to sample
from). Run the existing Fault Analysis / Duty Check studies with the
recommended DER capacity applied to confirm no equipment or protection
issue, exactly as any new source addition should be checked.

Results are on-demand (not persisted).
"""

from __future__ import annotations

import json

from ..models.schemas import ProjectData
from .loadflow import run_load_flow, is_synthetic_bus
from .optimal_powerflow import _metrics

BISECT_STEPS = 8
DEFAULT_STEP_MW = 0.5
DEFAULT_MAX_MW_PER_BUS = 10.0


def _with_der(project: ProjectData, bus_id: str, mw: float,
              power_factor: float = 1.0) -> ProjectData:
    """Copy of the project with a synthetic unity-eff/unity-irradiance solar
    PV source wired to bus_id, injecting exactly mw MW at power_factor."""
    data = json.loads(project.model_dump_json())
    comps = data["components"]
    wires = data["wires"]
    by_id = {c["id"]: c for c in comps}
    v_kv = float(by_id[bus_id]["props"].get("voltage_kv", 11) or 11)
    cid = "__hc_der__"
    comps.append({
        "id": cid, "type": "solar_pv", "x": 0, "y": 0, "rotation": 0,
        "props": {"name": "HC trial DER", "voltage_kv": v_kv,
                  "rated_kw": max(0.0, mw) * 1000.0, "num_inverters": 1,
                  "inverter_eff": 1.0, "power_factor": power_factor,
                  "irradiance_pct": 100, "pv_array_mode": "rated",
                  "dispatch_mode": "must_run"},
    })
    wires.append({"id": "__hc_der__w", "fromComponent": bus_id,
                  "fromPort": "__hc_der__p", "toComponent": cid,
                  "toPort": "in"})
    return ProjectData(**data)


def _feasible(project, bus_id, mw, power_factor, v_min, v_max,
             loading_limit_pct, method):
    """(ok: bool, violations, result) for one trial injection level."""
    if mw <= 1e-9:
        lf = run_load_flow(project, method)
    else:
        lf = run_load_flow(_with_der(project, bus_id, mw, power_factor), method)
    if not lf.converged:
        return False, [{"kind": "non_converged", "element_id": "", "name": "",
                        "value": 0, "excess": 0}], lf
    # Built from the ORIGINAL (unmodified) project, so the synthetic DER never
    # appears as a lookup key — _metrics' thermal loop skips any branch row
    # with no matching component (comp is None), which is exactly right: the
    # trial DER is a measuring stick, not a real rated element to overload-check.
    components = {c.id: c for c in project.components}
    _cost, _loss, violations = _metrics(lf, components, v_min, v_max,
                                        loading_limit_pct)
    return (len(violations) == 0), violations, lf


def run_hosting_capacity(project: ProjectData, bus_ids=None,
                         power_factor: float = 1.0, v_min: float = 0.95,
                         v_max: float = 1.05, loading_limit_pct: float = 100.0,
                         step_mw: float = None, max_mw_per_bus: float = None,
                         method: str = "newton_raphson") -> dict:
    power_factor = max(0.0, min(1.0, float(power_factor or 1.0)))
    step_mw = max(0.01, float(step_mw)) if step_mw else DEFAULT_STEP_MW
    max_mw_per_bus = (max(step_mw, float(max_mw_per_bus)) if max_mw_per_bus
                      else DEFAULT_MAX_MW_PER_BUS)
    warnings = []

    base_lf = run_load_flow(project, method)
    if not base_lf.converged:
        return {"converged": False,
                "note": "Base-case load flow does not converge — fix the "
                        "network before assessing hosting capacity.",
                "warnings": [w.message for w in base_lf.warnings or []][:5],
                "buses": []}

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
                "warnings": warnings, "buses": []}

    comp_map = {c.id: c for c in project.components}
    results = []
    for bus_id in candidates:
        bus_name = str(comp_map[bus_id].props.get("name", bus_id))

        ok0, _v0, _lf0 = _feasible(project, bus_id, 0.0, power_factor,
                                   v_min, v_max, loading_limit_pct, method)
        if not ok0:
            results.append({
                "bus_id": bus_id, "bus_name": bus_name,
                "hosting_capacity_mw": 0.0, "capped": False,
                "limiting_factor": "baseline_violation",
                "limiting_element": "",
                "note": "The network already has a violation at this bus "
                        "with zero DER — fix the base case first.",
            })
            continue

        last_good, first_bad = 0.0, None
        first_bad_violations = None
        mw = step_mw
        while mw <= max_mw_per_bus + 1e-9:
            ok, viol, _lf = _feasible(project, bus_id, mw, power_factor,
                                      v_min, v_max, loading_limit_pct, method)
            if ok:
                last_good = mw
                mw = round(mw + step_mw, 6)
            else:
                first_bad = mw
                first_bad_violations = viol
                break

        if first_bad is None:
            results.append({
                "bus_id": bus_id, "bus_name": bus_name,
                "hosting_capacity_mw": round(last_good, 4), "capped": True,
                "limiting_factor": "none_within_cap",
                "limiting_element": "",
                "note": (f"No violation found up to the {max_mw_per_bus:g} MW "
                        "search cap — this is a LOWER BOUND; raise "
                        "max_mw_per_bus to find the true limit."),
            })
            continue

        lo, hi = last_good, first_bad
        lo_viol = first_bad_violations
        for _ in range(BISECT_STEPS):
            mid = (lo + hi) / 2.0
            ok, viol, _lf = _feasible(project, bus_id, mid, power_factor,
                                      v_min, v_max, loading_limit_pct, method)
            if ok:
                lo = mid
            else:
                hi = mid
                lo_viol = viol

        binding = sorted(lo_viol, key=lambda v: -v.get("excess", 0))[0] if lo_viol else None
        results.append({
            "bus_id": bus_id, "bus_name": bus_name,
            "hosting_capacity_mw": round(lo, 4), "capped": False,
            "limiting_factor": binding["kind"] if binding else "unknown",
            "limiting_element": binding["name"] if binding else "",
            "note": "",
        })

    results.sort(key=lambda r: r["hosting_capacity_mw"])

    return {
        "converged": True,
        "buses": results,
        "power_factor": power_factor,
        "v_min": v_min, "v_max": v_max,
        "loading_limit_pct": loading_limit_pct,
        "step_mw": step_mw, "max_mw_per_bus": max_mw_per_bus,
        "method": ("Nodal hosting capacity — incremental unity-pf PV "
                   "injection (sweep-then-bisect) at each candidate bus, "
                   "stopping at the first voltage-rise or thermal-overload "
                   "violation (same scoring as the OPF/capacitor-placement "
                   "studies). Fault-level/protection impact and stochastic "
                   "(Monte Carlo) hosting capacity are out of scope — verify "
                   "the recommended capacity with Fault Analysis / Duty "
                   "Check before interconnection."),
        "warnings": warnings,
        "note": "",
    }
