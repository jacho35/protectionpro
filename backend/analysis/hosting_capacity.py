"""Feeder hosting capacity — the maximum DER (PV) that can be interconnected
at a bus before a technical limit is violated.

**Nodal hosting capacity** (deterministic, per candidate bus): a synthetic
unity-pf solar PV source is injected at increasing power, the load flow
re-solved at each step, until a limit is crossed. This follows the same
sweep-then-bisect pattern the voltage-stability nose search already uses
(`voltage_stability.py`): step up in `step_mw` increments to bracket the
violation, then bisect `BISECT_STEPS` times to refine the boundary. Three
"screens" are checked — the constraints that actually bind in utility
hosting-capacity studies (e.g. EPRI's DRIVE methodology):

  * **voltage rise** — reverse power flow from the DER raises the local
    (and upstream) bus voltage; capacity is limited when any bus exceeds
    `v_max`;
  * **thermal overload** — the added generation loads the feeder/transformer
    beyond `loading_limit_pct` in the *export* direction.

Those two reuse `optimal_powerflow._metrics`, the exact violation-scoring
helper the OPF and capacitor-placement studies already use, so a bus's
load-flow capacity is precisely the largest injection with zero `_metrics`
violations. The binding one (whichever crosses first) is reported per bus.

  * **fault level / protection** — voltage rise and thermal are not the only
    things that bind, and often not the first. A DER-heavy bus can raise the
    prospective fault current past switchgear breaking capacity, or contribute
    enough infeed to desensitize an overcurrent relay, well before either of
    the screens above trips. This used to be left to the user as a manual
    follow-up named only in the docstring; it is now run automatically. At each
    bus's discovered capacity the existing **Fault Analysis** and **Duty Check**
    engines are re-run with the DER in place and compared against the base
    case, folding a `fault_level_ok` flag into the per-bus result:

      - any protective device whose duty-check verdict **degrades to `fail`**
        with the DER connected (breaking / making / asymmetrical capacity
        exceeded) fails the screen;
      - a prospective fault-level rise above `fault_rise_limit_pct` at any bus
        fails it;
      - a DER contribution above `der_share_limit_pct` of the fault level at
        its own bus raises a **coordination-review** advisory — the usual
        industry trigger for re-grading the feeder's overcurrent protection.

    When the screen fails, the capacity that *would* pass it is found by the
    same bisection and reported as `fault_limited_mw`; `screened_capacity_mw`
    is the binding minimum across all three screens.

**Deliberately out of scope**: *stochastic* hosting capacity (Monte Carlo over
uncertain load/DER combinations — this tool has no load/irradiance uncertainty
model to sample from).

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

# Fault screen defaults.
# A 10 % rise in prospective fault level is the usual point at which a utility
# re-checks switchgear ratings rather than accepting the interconnection on the
# existing study.
DEFAULT_FAULT_RISE_LIMIT_PCT = 10.0
# A DER supplying more than 10 % of the fault current at its own bus is the
# common trigger for re-grading feeder overcurrent protection.
DEFAULT_DER_SHARE_LIMIT_PCT = 10.0
# The fault screen costs a fault study + duty check per trial, so it bisects
# more coarsely than the (cheap) load-flow screens.
FAULT_BISECT_STEPS = 5


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


def _fault_snapshot(project: ProjectData):
    """(bus fault levels, duty verdicts) for a project, or None if unavailable.

    Returns ({bus_id: ik3_kA}, {device_id: status}). Never raises: a network the
    fault engine cannot solve must degrade the hosting-capacity study to
    "screen not run", not fail it outright.
    """
    from .fault import run_fault_analysis
    from .duty_check import run_duty_check
    try:
        fr = run_fault_analysis(project, fault_bus_id=None, fault_type="3phase")
    except Exception:
        return None, None
    levels = {}
    for bid, b in (fr.buses or {}).items():
        ik = getattr(b, "ik3", None)
        if ik:
            levels[bid] = float(ik)
    try:
        duty = run_duty_check(project)
        verdicts = {d["device_id"]: d for d in (duty.get("devices") or [])}
    except Exception:
        verdicts = None
    return levels, verdicts


def _fault_screen(base_levels, base_duty, project, bus_id, mw, power_factor,
                  fault_rise_limit_pct, der_share_limit_pct):
    """Screen one injection level for fault-level / protection impact.

    Returns a dict with `ok` plus the evidence behind the verdict. `ok` is True
    when nothing binds; the caller uses it both for the reported flag and for
    the fault-limited bisection.
    """
    out = {
        "ok": True, "ran": True, "new_failures": [], "max_rise_pct": 0.0,
        "max_rise_bus": "", "der_share_pct": 0.0,
        "coordination_review": False, "note": "",
    }
    if base_levels is None:
        out["ran"] = False
        out["note"] = ("Fault analysis could not be solved for this network — "
                       "fault-level screen not run.")
        return out

    levels, duty = _fault_snapshot(_with_der(project, bus_id, mw, power_factor))
    if levels is None:
        out["ran"] = False
        out["note"] = ("Fault analysis failed with the trial DER connected — "
                       "fault-level screen not run.")
        return out

    # Prospective fault-level rise, bus by bus.
    for bid, ik in levels.items():
        base_ik = base_levels.get(bid)
        if not base_ik or base_ik <= 0:
            continue
        rise = (ik / base_ik - 1.0) * 100.0
        if rise > out["max_rise_pct"]:
            out["max_rise_pct"] = rise
            out["max_rise_bus"] = bid
    if out["max_rise_pct"] > fault_rise_limit_pct:
        out["ok"] = False

    # The DER's own share of the fault level at its point of connection.
    base_at_bus = base_levels.get(bus_id) or 0.0
    with_at_bus = levels.get(bus_id) or 0.0
    if with_at_bus > 0:
        out["der_share_pct"] = max(0.0, (with_at_bus - base_at_bus) / with_at_bus * 100.0)
    if out["der_share_pct"] > der_share_limit_pct:
        out["coordination_review"] = True

    # Equipment duty: only a DEGRADATION counts. A device already failing in the
    # base case is a pre-existing problem, not something this DER caused, and
    # holding the interconnection responsible for it would be wrong.
    if duty is not None and base_duty is not None:
        for did, d in duty.items():
            if d.get("status") != "fail":
                continue
            if (base_duty.get(did) or {}).get("status") == "fail":
                continue
            out["new_failures"].append({
                "device_id": did,
                "device_name": d.get("device_name", did),
                "issues": (d.get("issues") or [])[:3],
            })
        if out["new_failures"]:
            out["ok"] = False
    elif duty is None:
        out["note"] = "Duty check unavailable — only the fault-level rise was screened."

    if not out["note"]:
        if not out["ok"]:
            bits = []
            if out["new_failures"]:
                bits.append(f"{len(out['new_failures'])} device(s) newly exceed their duty rating")
            if out["max_rise_pct"] > fault_rise_limit_pct:
                bits.append(f"fault level rises {out['max_rise_pct']:.1f}% "
                            f"(limit {fault_rise_limit_pct:g}%)")
            out["note"] = "; ".join(bits)
        elif out["coordination_review"]:
            out["note"] = (f"The DER supplies {out['der_share_pct']:.1f}% of the fault "
                           f"current at its own bus — re-grade the feeder overcurrent "
                           f"protection before interconnection.")
    return out


def _apply_fault_screen(row, base_levels, base_duty, project, bus_id, capacity_mw,
                        power_factor, enabled, fault_rise_limit_pct,
                        der_share_limit_pct):
    """Run the fault screen at a bus's discovered capacity and fold it into the
    result row (in place), bisecting for a fault-limited capacity if it fails."""
    if not enabled or capacity_mw <= 1e-9:
        row["fault_level_ok"] = None
        row["fault_screen"] = "not_run" if not enabled else "no_capacity"
        row["screened_capacity_mw"] = row["hosting_capacity_mw"]
        return

    scr = _fault_screen(base_levels, base_duty, project, bus_id, capacity_mw,
                        power_factor, fault_rise_limit_pct, der_share_limit_pct)
    row["fault_level_ok"] = scr["ok"] if scr["ran"] else None
    row["fault_screen"] = "ok" if (scr["ran"] and scr["ok"]) else (
        "fail" if scr["ran"] else "not_run")
    row["fault_level_rise_pct"] = round(scr["max_rise_pct"], 2)
    row["fault_level_rise_bus"] = scr["max_rise_bus"]
    row["der_fault_share_pct"] = round(scr["der_share_pct"], 2)
    row["coordination_review"] = scr["coordination_review"]
    row["fault_new_failures"] = scr["new_failures"]
    row["fault_limited_mw"] = None
    row["screened_capacity_mw"] = row["hosting_capacity_mw"]
    if scr["note"]:
        row["note"] = (row["note"] + " " if row["note"] else "") + scr["note"]

    if not scr["ran"] or scr["ok"]:
        return

    # The fault screen binds before voltage/thermal — find where. Zero is known
    # to pass (it is the base case), the discovered capacity is known to fail.
    lo, hi = 0.0, capacity_mw
    for _ in range(FAULT_BISECT_STEPS):
        mid = (lo + hi) / 2.0
        s = _fault_screen(base_levels, base_duty, project, bus_id, mid,
                          power_factor, fault_rise_limit_pct, der_share_limit_pct)
        if s["ran"] and s["ok"]:
            lo = mid
        else:
            hi = mid
    row["fault_limited_mw"] = round(lo, 4)
    row["screened_capacity_mw"] = round(min(row["hosting_capacity_mw"], lo), 4)
    row["limiting_factor"] = "fault_level"
    if row["fault_new_failures"]:
        row["limiting_element"] = row["fault_new_failures"][0]["device_name"]
    elif scr["max_rise_bus"]:
        row["limiting_element"] = scr["max_rise_bus"]


def run_hosting_capacity(project: ProjectData, bus_ids=None,
                         power_factor: float = 1.0, v_min: float = 0.95,
                         v_max: float = 1.05, loading_limit_pct: float = 100.0,
                         step_mw: float = None, max_mw_per_bus: float = None,
                         method: str = "newton_raphson",
                         fault_screen: bool = True,
                         fault_rise_limit_pct: float = None,
                         der_share_limit_pct: float = None) -> dict:
    power_factor = max(0.0, min(1.0, float(power_factor or 1.0)))
    step_mw = max(0.01, float(step_mw)) if step_mw else DEFAULT_STEP_MW
    max_mw_per_bus = (max(step_mw, float(max_mw_per_bus)) if max_mw_per_bus
                      else DEFAULT_MAX_MW_PER_BUS)
    fault_rise_limit_pct = (float(fault_rise_limit_pct)
                            if fault_rise_limit_pct is not None
                            else DEFAULT_FAULT_RISE_LIMIT_PCT)
    der_share_limit_pct = (float(der_share_limit_pct)
                           if der_share_limit_pct is not None
                           else DEFAULT_DER_SHARE_LIMIT_PCT)
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

    # Base-case fault level + duty verdicts, solved once and reused as the
    # comparison point for every candidate bus.
    base_levels = base_duty = None
    if fault_screen:
        base_levels, base_duty = _fault_snapshot(project)
        if base_levels is None:
            warnings.append("Fault analysis could not be solved for the base case — "
                            "the fault-level / protection screen was skipped.")
        elif base_duty is None:
            warnings.append("Duty check unavailable for the base case — the fault "
                            "screen checks the fault-level rise only.")

    results = []
    for bus_id in candidates:
        bus_name = str(comp_map[bus_id].props.get("name", bus_id))

        ok0, _v0, _lf0 = _feasible(project, bus_id, 0.0, power_factor,
                                   v_min, v_max, loading_limit_pct, method)
        if not ok0:
            row = {
                "bus_id": bus_id, "bus_name": bus_name,
                "hosting_capacity_mw": 0.0, "capped": False,
                "limiting_factor": "baseline_violation",
                "limiting_element": "",
                "note": "The network already has a violation at this bus "
                        "with zero DER — fix the base case first.",
            }
            # No capacity to screen; the flag must read "not applicable", not
            # "passed", or a broken base case would look like a clean bus.
            _apply_fault_screen(row, base_levels, base_duty, project, bus_id, 0.0,
                                power_factor, fault_screen, fault_rise_limit_pct,
                                der_share_limit_pct)
            results.append(row)
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
            row = {
                "bus_id": bus_id, "bus_name": bus_name,
                "hosting_capacity_mw": round(last_good, 4), "capped": True,
                "limiting_factor": "none_within_cap",
                "limiting_element": "",
                "note": (f"No violation found up to the {max_mw_per_bus:g} MW "
                        "search cap — this is a LOWER BOUND; raise "
                        "max_mw_per_bus to find the true limit."),
            }
            # Voltage/thermal never bound, but the fault screen still might —
            # which is exactly the case the manual follow-up used to miss.
            _apply_fault_screen(row, base_levels, base_duty, project, bus_id,
                                last_good, power_factor, fault_screen,
                                fault_rise_limit_pct, der_share_limit_pct)
            results.append(row)
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
        row = {
            "bus_id": bus_id, "bus_name": bus_name,
            "hosting_capacity_mw": round(lo, 4), "capped": False,
            "limiting_factor": binding["kind"] if binding else "unknown",
            "limiting_element": binding["name"] if binding else "",
            "note": "",
        }
        _apply_fault_screen(row, base_levels, base_duty, project, bus_id, lo,
                            power_factor, fault_screen, fault_rise_limit_pct,
                            der_share_limit_pct)
        results.append(row)

    # Rank by the screened capacity — the number a planner acts on — so a bus
    # whose voltage/thermal headroom is large but whose fault screen cuts it
    # down is not left looking like the best candidate.
    results.sort(key=lambda r: r.get("screened_capacity_mw", r["hosting_capacity_mw"]))

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
                   "studies), then re-running Fault Analysis + Duty Check at "
                   "that capacity to screen the fault-level rise, any newly "
                   "exceeded equipment duty, and the DER's share of the fault "
                   "current at its own bus. Stochastic (Monte Carlo) hosting "
                   "capacity remains out of scope."
                   if fault_screen else
                   "studies). The fault-level / protection screen was "
                   "disabled for this run — verify the recommended capacity "
                   "with Fault Analysis / Duty Check before interconnection."),
        "fault_screen": bool(fault_screen),
        "fault_rise_limit_pct": fault_rise_limit_pct,
        "der_share_limit_pct": der_share_limit_pct,
        "warnings": warnings,
        "note": "",
    }
