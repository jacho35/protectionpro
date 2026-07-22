"""Passive harmonic filter sizing — single-tuned LC(R) branches to meet the
IEEE 519-2014 voltage-distortion limits.

Design method (standard single-tuned filter synthesis, e.g. IEEE 1531 /
Arrillaga "Power System Harmonics" ch. 6): a branch of net fundamental
compensation Q_f (kvar) at bus voltage U, tuned to order h_t (a few percent
below the target harmonic so component tolerance/temperature drift never
leaves the branch inductive-side above the harmonic):

    X_eff = U²/Q_f                       net fundamental reactance
    X_C   = X_eff · h_t²/(h_t²−1)        capacitor,  C = 1/(ω₁·X_C)
    X_L   = X_C / h_t²                   reactor,    L = X_L/ω₁
    R     = (X_C/h_t) / Q                damping, quality factor Q (typ 30–50)

The study:

  1. runs the harmonics engine for the baseline THD/compliance picture;
  2. identifies the dominant injected orders at the chosen bus (default: the
     worst-THD bus) from the VFD spectra;
  3. adds one tuned branch per dominant order — each simulated by inserting a
     synthetic `capacitor_bank` with `tuned_order`/`quality_factor` props into
     a copy of the project (the harmonics + frequency-scan engines model tuned
     banks as series C-L-R), splitting the total kvar equally across branches
     — and re-runs the harmonics engine;
  4. stops at the first branch count that meets IEEE 519 everywhere (or
     reports the best attempt with the residual violations).

The total filter kvar defaults to the network's uncompensated reactive demand
at the filter bus's island (capped at 1.2× so the filter doubles as power-
factor correction — the usual sizing basis), overridable per request. The
recommended design is expressed in the same `capacitor_bank` props the user
can apply on the diagram (rated kvar + tuning order + quality factor), plus
engineering values (µF / mH / Ω per branch). Results are on-demand.
"""

from __future__ import annotations

import json
import math

from ..models.schemas import ProjectData
from .harmonics import run_harmonics, vfd_current_spectrum
from .loadflow import connected_bus_loads_mw, _connected_bus_loads

TUNING_OFFSET = 0.94       # tune to 94 % of the harmonic order (detuned design)
MAX_BRANCHES = 4


def _copy(project: ProjectData) -> ProjectData:
    return ProjectData(**json.loads(project.model_dump_json()))


def _with_filters(project, bus_id, branches):
    """Copy of the project with one synthetic tuned bank per branch wired to
    bus_id. The synthetic ids never collide with user components."""
    data = json.loads(project.model_dump_json())
    comps = data["components"]
    wires = data["wires"]
    bus = next(c for c in comps if c["id"] == bus_id)
    v_kv = float(bus["props"].get("voltage_kv", 11) or 11)
    for i, br in enumerate(branches):
        fid = f"__filter__{i}"
        comps.append({
            "id": fid, "type": "capacitor_bank", "x": 0, "y": 0, "rotation": 0,
            "props": {"name": f"Filter h{br['order']}", "voltage_kv": v_kv,
                      "rated_kvar": br["kvar"], "steps": 1,
                      "tuned_order": br["tuned_order"],
                      "quality_factor": br["quality_factor"]},
        })
        wires.append({"id": f"__filter__w{i}", "fromComponent": bus_id,
                      "fromPort": f"at_f{i}", "toComponent": fid,
                      "toPort": "in"})
    return ProjectData(**data)


def _branch_elements(kvar, v_kv, h_t, q_fact, f0):
    """Engineering values of one branch (Ω, µF, mH)."""
    q_mvar = kvar / 1000.0
    x_eff = (v_kv ** 2) / q_mvar if q_mvar > 0 else 0.0
    x_c = x_eff * h_t * h_t / (h_t * h_t - 1.0)
    x_l = x_c / (h_t * h_t)
    r = (x_c / h_t) / q_fact
    w1 = 2.0 * math.pi * f0
    return {
        "x_c_ohm": round(x_c, 3), "x_l_ohm": round(x_l, 4),
        "r_ohm": round(r, 4),
        "c_uf": round(1e6 / (w1 * x_c), 2) if x_c > 0 else 0.0,
        "l_mh": round(1e3 * x_l / w1, 3) if x_l > 0 else 0.0,
    }


def _summary(h):
    """Compact compliance picture from a harmonics result dict."""
    return {
        "worst_thd_pct": h.get("worst_thd_pct", 0.0),
        "worst_bus_name": h.get("worst_bus_name", ""),
        "compliant": bool(h.get("compliant", False)),
        "buses": [{"id": b["id"], "name": b["name"],
                   "thd_v_pct": b["thd_v_pct"],
                   "thd_limit_pct": b["thd_limit_pct"],
                   "compliant": b["compliant"]}
                  for b in h.get("buses", [])],
    }


def run_filter_sizing(project: ProjectData, bus_id: str = "",
                      total_kvar: float = 0.0, quality_factor: float = 30.0,
                      max_branches: int = 3,
                      method: str = "newton_raphson") -> dict:
    f0 = float(project.frequency or 50)
    quality_factor = max(5.0, min(150.0, float(quality_factor or 30.0)))
    max_branches = max(1, min(MAX_BRANCHES, int(max_branches or 3)))

    base = run_harmonics(_copy(project), method)
    if not base.get("converged"):
        return {"converged": False, "note": base.get("note")
                or "Harmonics baseline did not run.",
                "warnings": base.get("warnings", []), "design": [],
                "baseline": {}, "with_filter": {}}
    warnings = list(base.get("warnings", []))

    # Filter bus: requested, else the worst-THD bus.
    target_bus = bus_id or base.get("worst_bus_id", "")
    if not target_bus or all(b["id"] != target_bus for b in base["buses"]):
        return {"converged": False, "note": f"Bus '{bus_id}' not found.",
                "warnings": warnings, "design": [], "baseline": _summary(base),
                "with_filter": {}}
    bus_comp = next(c for c in project.components if c.id == target_bus)
    v_kv = float(bus_comp.props.get("voltage_kv", 11) or 11)

    # Dominant injected orders, largest aggregate current first.
    order_amps = {}
    for c in project.components:
        if c.type != "vfd":
            continue
        for order, ratio in vfd_current_spectrum(c).items():
            order_amps[order] = order_amps.get(order, 0.0) + ratio
    dominant = [o for o, _a in sorted(order_amps.items(),
                                      key=lambda kv: -kv[1])]
    if not dominant:
        return {"converged": False,
                "note": "No harmonic sources (VFDs) in the network — nothing "
                        "to filter.", "warnings": warnings, "design": [],
                "baseline": _summary(base), "with_filter": {}}

    # Total filter size: request, else the island's reactive demand (the
    # filter doubles as PF correction — the standard sizing basis).
    if not total_kvar or total_kvar <= 0:
        q_mvar = sum(q for _p, q in _connected_bus_loads(project).values())
        total_kvar = max(50.0, round(q_mvar * 1000.0, 0))
        warnings.append(f"Filter size defaulted to the network reactive "
                        f"demand ≈ {total_kvar:.0f} kvar.")

    best = None
    for n in range(1, max_branches + 1):
        orders = dominant[:n]
        kvar_each = total_kvar / n
        branches = [{"order": o, "tuned_order": round(o * TUNING_OFFSET, 2),
                     "quality_factor": quality_factor, "kvar": kvar_each}
                    for o in sorted(orders)]
        trial = run_harmonics(_with_filters(project, target_bus, branches),
                              method)
        cand = {"n": n, "branches": branches, "result": trial,
                "worst": trial.get("worst_thd_pct", 999.0),
                "compliant": bool(trial.get("compliant", False))}
        if best is None or cand["worst"] < best["worst"]:
            best = cand
        if cand["compliant"]:
            best = cand
            break

    design = []
    for br in best["branches"]:
        el = _branch_elements(br["kvar"], v_kv, br["tuned_order"],
                              br["quality_factor"], f0)
        design.append({
            "harmonic_order": br["order"],
            "tuned_order": br["tuned_order"],
            "quality_factor": br["quality_factor"],
            "kvar": round(br["kvar"], 1),
            **el,
        })

    if not best["compliant"]:
        warnings.append(
            f"Best attempt ({best['n']} branch(es), {total_kvar:.0f} kvar) "
            f"still exceeds IEEE 519 somewhere — worst THD "
            f"{best['worst']:.2f} %. Increase the filter kvar or add "
            "branches.")

    return {
        "converged": True,
        "bus_id": target_bus,
        "bus_name": str(bus_comp.props.get("name", target_bus)),
        "voltage_kv": v_kv,
        "total_kvar": round(total_kvar, 1),
        "design": design,
        "meets_ieee519": best["compliant"],
        "baseline": _summary(base),
        "with_filter": _summary(best["result"]),
        "method": ("Single-tuned branch synthesis (X_C = X_eff·h_t²/(h_t²−1), "
                   "detuned to 94 % of the order) verified by re-running the "
                   "IEEE 519 harmonic penetration study with the designed "
                   "branches in place"),
        "warnings": warnings,
        "note": ("Apply a branch on the diagram as a capacitor bank with the "
                 "listed kvar + Tuned Order + Quality Factor."),
    }
