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
  2. identifies the dominant injected orders from the VFDs' harmonic CURRENTS
     (I_h = (I_h/I_1)·I_1 of each drive, [FS1]) at the chosen bus (default:
     the worst-THD bus);
  3. adds one tuned branch per dominant order — each simulated by inserting a
     synthetic `capacitor_bank` with `tuned_order`/`quality_factor` props into
     a copy of the project (the harmonics + frequency-scan engines model tuned
     banks as series C-L-R), splitting the total kvar equally across branches
     — and re-runs the harmonics engine;
  4. stops at the first branch count that meets IEEE 519 everywhere (or
     reports the best attempt with the residual violations);
  5. [FS2] checks each branch's CAPACITOR against the IEC 60871-1 (> 1 kV) /
     IEC 60831-1 (≤ 1 kV) continuous limits — 1.10·U_N (r.m.s., harmonics
     included), 1.30·I_N, 1.35·Q_N — from the harmonic voltages the study
     solved at the filter bus, and recommends its nameplate (U_N, Q_N).

A tuned branch's capacitor does not sit at bus voltage: the series reactor
lifts its fundamental voltage by h_t²/(h_t²−1) (+4.7 % at h_t = 4.7), and the
harmonic current it absorbs adds U_Ch = I_h·X_C/h on top. The kvar the design
quotes is the branch's NET fundamental output at bus voltage (what the load
flow and harmonics engines model for a tuned `capacitor_bank`); the capacitor
itself must be bought at the recommended U_N / Q_N.

The total filter kvar defaults to the reactive demand of every load in the
network (`_connected_bus_loads`), at least 50 kvar, overridable per request —
the filter doubles as power-factor correction, the usual sizing basis. The
recommended design is expressed in the same `capacitor_bank` props the user
can apply on the diagram (rated kvar + tuning order + quality factor), plus
engineering values (µF / mH / Ω per branch). Results are on-demand.
"""

from __future__ import annotations

import json
import math

from ..models.schemas import ProjectData
from .harmonics import run_harmonics
from .loadflow import connected_bus_loads_mw, _connected_bus_loads

TUNING_OFFSET = 0.94       # tune to 94 % of the harmonic order (detuned design)
MAX_BRANCHES = 4
# [FS2] Capacitor continuous-duty limits, IEC 60871-1 (> 1 kV) and IEC 60831-1
# (≤ 1 kV): voltage r.m.s. incl. harmonics, current r.m.s., reactive output,
# each as a multiple of the capacitor's rated value.
CAP_U_LIMIT = 1.10
CAP_I_LIMIT = 1.30
CAP_Q_LIMIT = 1.35


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


def _capacitor_duty(v_kv, v1_pu, ihd_pct, el):
    """[FS2] Duty of one tuned branch's capacitor and reactor from the bus
    voltage spectrum (v1_pu of nominal; ihd_pct {order: % of V1}).

    Per phase (star equivalent): I_h = V_h / |R + j(h·X_L − X_C/h)|, the
    capacitor voltage U_Ch = I_h·X_C/h. Returned in line kV / A / kvar:
    fundamental and r.m.s. capacitor voltage, r.m.s. current, the capacitor's
    total reactive power Σ U_Ch·I_h, the recommended rating (U_N the larger of
    the fundamental capacitor voltage and U_rms/1.10, Q_N = U_N²/X_C) and the
    IEC 60871-1 / 60831-1 ratios against it."""
    x_c, x_l, r = el["x_c_ohm"], el["x_l_ohm"], el["r_ohm"]
    if x_c <= 0:
        return None
    v_ph1 = v1_pu * v_kv / math.sqrt(3)                  # kV, per phase
    spectrum = {1: v_ph1}
    for order, pct in (ihd_pct or {}).items():
        h = int(order)
        if h > 1 and pct:
            spectrum[h] = float(pct) / 100.0 * v_ph1
    i_h, u_ch = {}, {}
    for h, v_ph in spectrum.items():
        z = abs(complex(r, h * x_l - x_c / h))
        i = v_ph / z if z > 0 else 0.0                   # kA
        i_h[h] = i
        u_ch[h] = i * x_c / h * math.sqrt(3)             # line kV across C
    u_c1 = u_ch[1]
    u_rms = math.sqrt(sum(u * u for u in u_ch.values()))
    i_rms = math.sqrt(sum(i * i for i in i_h.values()))
    q_c = math.sqrt(3) * sum(u_ch[h] * i_h[h] for h in i_h) * 1000   # kvar, √3·U_line·I
    u_n = max(u_c1, u_rms / CAP_U_LIMIT)
    # Round the recommended rating up to 1 % of the bus voltage.
    step = 0.01 * v_kv
    u_n = math.ceil(u_n / step - 1e-9) * step
    q_n = u_n * u_n / x_c * 1000                         # kvar at U_N, 50/60 Hz
    i_n = q_n / (math.sqrt(3) * u_n)                     # A
    worst_h = max((h for h in i_h if h > 1), key=lambda h: i_h[h], default=None)
    return {
        "cap_u1_kv": round(u_c1, 4),
        "cap_u_rms_kv": round(u_rms, 4),
        "cap_i_rms_a": round(i_rms * 1000, 2),
        "cap_q_kvar": round(q_c, 1),
        "cap_rated_kv": round(u_n, 4),
        "cap_rated_kvar": round(q_n, 1),
        "cap_u_ratio": round(u_rms / u_n, 3),
        "cap_i_ratio": round(i_rms * 1000 / i_n, 3) if i_n > 0 else 0.0,
        "cap_q_ratio": round(q_c / q_n, 3) if q_n > 0 else 0.0,
        "cap_compliant": bool(u_rms <= CAP_U_LIMIT * u_n + 1e-9
                              and i_rms * 1000 <= CAP_I_LIMIT * i_n + 1e-9
                              and q_c <= CAP_Q_LIMIT * q_n + 1e-9),
        "reactor_i1_a": round(i_h[1] * 1000, 2),
        "reactor_i_rms_a": round(i_rms * 1000, 2),
        "largest_harmonic_order": worst_h,
        "largest_harmonic_a": round(i_h[worst_h] * 1000, 2) if worst_h else 0.0,
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

    base = run_harmonics(_copy(project), method, limits="ieee519")
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

    # [FS1] Dominant injected orders by CURRENT, largest first: each drive's
    # I_h = (I_h/I_1)·I_1 from the harmonics study's own source list (energised
    # drives only). Summing the per-unit ratios weighted a 20 kW drive like a
    # 2 MW one — a small 6-pulse drive made the 5th "dominant" over a large
    # 12-pulse drive's 11th.
    order_amps = {}
    for src in base.get("vfd_sources", []):
        i1 = float(src.get("i1_pu", 0) or 0)
        for order, ratio in (src.get("spectrum") or {}).items():
            order_amps[int(order)] = order_amps.get(int(order), 0.0) + float(ratio) * i1
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
                              method, limits="ieee519")
        cand = {"n": n, "branches": branches, "result": trial,
                "worst": trial.get("worst_thd_pct", 999.0),
                "compliant": bool(trial.get("compliant", False))}
        if best is None or cand["worst"] < best["worst"]:
            best = cand
        if cand["compliant"]:
            best = cand
            break

    # [FS2] Capacitor duty from the voltages solved WITH the filter in place.
    fbus = next((b for b in best["result"].get("buses", []) if b["id"] == target_bus), {})
    v1_pu = float(fbus.get("v1_pu", 1.0) or 1.0)
    ihd = fbus.get("ihd", {}) or {}
    design = []
    for br in best["branches"]:
        el = _branch_elements(br["kvar"], v_kv, br["tuned_order"],
                              br["quality_factor"], f0)
        duty = _capacitor_duty(v_kv, v1_pu, ihd, el) or {}
        design.append({
            "harmonic_order": br["order"],
            "tuned_order": br["tuned_order"],
            "quality_factor": br["quality_factor"],
            "kvar": round(br["kvar"], 1),
            **el,
            **duty,
        })
        if duty and not duty["cap_compliant"]:
            warnings.append(
                f"h{br['order']} branch: capacitor duty exceeds the IEC "
                f"{'60871-1' if v_kv > 1.0 else '60831-1'} limits at the "
                f"recommended {duty['cap_rated_kv']:.4g} kV rating "
                f"(U {duty['cap_u_ratio']:.2f}/1.10, I {duty['cap_i_ratio']:.2f}/1.30, "
                f"Q {duty['cap_q_ratio']:.2f}/1.35 of rated) — choose a higher "
                "capacitor voltage, or a larger branch.")
    if base.get("compliant"):
        warnings.append("The network already meets IEEE 519 without a filter — "
                        "the design is sized as power-factor correction.")

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
                   "branches in place; each capacitor checked against IEC "
                   "60871-1 / 60831-1 (1.10·U_N r.m.s., 1.30·I_N, 1.35·Q_N) "
                   "at the solved harmonic voltages"),
        "warnings": warnings,
        "note": ("Apply a branch on the diagram as a capacitor bank with the "
                 "listed kvar + Tuned Order + Quality Factor. The kvar is the "
                 "branch's net output at bus voltage; buy the capacitor at the "
                 "recommended rated voltage and kvar."),
    }
