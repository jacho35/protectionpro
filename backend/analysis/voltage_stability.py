"""Voltage Stability Analysis — P-V nose curves, Q-V reactive margin,
loadability margin and voltage-collapse point.

This is a *steady-state* (long-term) voltage-stability study, distinct from the
time-domain transient-stability engine. Two classic assessments are produced:

**P-V (loadability) — load-scaling continuation.** All system loads are scaled
uniformly by a factor λ (holding each load's power factor, i.e. P and Q scale
together) and the balanced load flow is re-solved at each λ. Bus voltages are
traced against total demand; the "nose" — the maximum λ the network can supply
before the power-flow solution ceases to exist (the Jacobian turns singular and
Newton-Raphson diverges, or a bus voltage collapses) — is located by stepping λ
up and then bisecting the last-converged / first-failed bracket. The loadability
margin is (λ_critical − 1) × 100 %. This is the pragmatic continuation method for
a black-box solver: it walks the upper (stable) branch of the P-V curve up to the
nose, which is exactly the collapse point of interest.

**Q-V (reactive margin).** At a chosen bus a fictitious synchronous condenser
(a P = 0, voltage-regulating source) is installed, the bus is made a PV
(voltage-controlled) bus, and its scheduled voltage is swept from high to low.
At each setpoint the reactive power the network must inject to hold that voltage
is recorded. The bottom of the resulting Q-V curve (dQ/dV = 0) is the reactive
power margin; a minimum above zero means the bus cannot hold voltage without that
much added reactive support — an imminent-collapse indicator.
"""

import copy

from ..models.schemas import (
    ProjectData, VoltageStabilityResults, PVBusCurve, QVCurvePoint,
)
from .loadflow import run_load_flow, connected_bus_loads_mw


# Load component types scaled by λ in the P-V sweep (power factor preserved
# because demand_factor scales the rated MVA, so P and Q move together).
LOAD_SCALE_TYPES = {"static_load", "motor_induction", "motor_synchronous",
                    "distribution_board"}

BISECT_STEPS = 6            # nose-point refinement iterations
QV_CONDENSER_ID = "__qv_cond__"
QV_WIRE_ID = "__qv_cond_w__"


def _to_float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _scaled_project(project: ProjectData, lam: float) -> ProjectData:
    """A copy of *project* with every load's demand factor multiplied by λ."""
    data = project.model_dump()
    for c in data["components"]:
        if c.get("type") in LOAD_SCALE_TYPES:
            props = c.setdefault("props", {})
            df = _to_float(props.get("demand_factor", 1.0), 1.0)
            props["demand_factor"] = df * lam
    return ProjectData(**data)


def _energized(result):
    return [b for b in result.buses.values() if b.energized]


def _min_v(result):
    energ = _energized(result)
    return min((b.voltage_pu for b in energ), default=0.0)


def run_voltage_stability(project: ProjectData, method: str = "newton_raphson",
                          qv_bus_id: str = None, step: float = 0.1,
                          lambda_max: float = 4.0,
                          v_floor: float = 0.4) -> VoltageStabilityResults:
    """Run the P-V loadability sweep (and a Q-V curve at the weakest / requested
    bus) and return the collapse point, margins and curves.

    step        — λ increment for the coarse sweep (default 0.10 = +10 % steps)
    lambda_max  — cap on λ; if reached without collapse the margin is a lower bound
    v_floor     — a converged solution whose weakest bus is below this p.u. is
                  treated as collapsed (avoids reporting a spurious low-voltage
                  root as stable)
    """
    step = max(0.01, min(1.0, _to_float(step, 0.1)))
    lambda_max = max(1.1, min(20.0, _to_float(lambda_max, 4.0)))
    v_floor = max(0.05, min(0.9, _to_float(v_floor, 0.4)))
    warnings = []

    base_loads = connected_bus_loads_mw(project)
    base_load_mw = sum(base_loads.values())

    base = run_load_flow(project, method)
    base_energ_ids = {b.bus_id for b in base.buses.values() if b.energized}

    def ok(result) -> bool:
        if not result.converged:
            return False
        energ = _energized(result)
        if not energ:
            return False
        if min(b.voltage_pu for b in energ) < v_floor:
            return False
        # A bus that was energized in the base case going dark = voltage/island
        # collapse under load — treat as past the nose.
        now = {b.bus_id for b in result.buses.values() if b.energized}
        if base_energ_ids - now:
            return False
        return True

    def eval_lam(lam):
        if abs(lam - 1.0) < 1e-9:
            return base
        return run_load_flow(_scaled_project(project, lam), method)

    # Each record: (lam, result)
    records = []

    if not base.converged:
        warnings.append("Base-case load flow did not converge — the network is "
                        "already at or beyond its voltage-stability limit.")
        return VoltageStabilityResults(
            converged=False, collapsed=True,
            lambda_critical=1.0, loading_margin_pct=0.0,
            base_load_mw=round(base_load_mw, 4), critical_load_mw=round(base_load_mw, 4),
            method="P-V load-scaling continuation", warnings=warnings,
            note="Base case does not solve; increase generation or reduce load.",
        )

    # [EE-6] "collapsed" means a non-solving / below-floor state was actually
    # OBSERVED and bracketed. The previous test (lam_critical < lambda_max)
    # also fired when the λ sweep merely overshot lambda_max without landing
    # on it (any user step that doesn't divide the range), declaring a bus at
    # 1.000 p.u. "collapsed". When the sweep exhausts λ without a failure the
    # margin is a lower bound, not a nose.
    observed_collapse = False
    if not ok(base):
        warnings.append(f"Base case solves but its weakest bus is below the "
                        f"collapse floor ({v_floor:.2f} p.u.) — no positive margin.")
        records.append((1.0, base))
        observed_collapse = True
    else:
        records.append((1.0, base))
        last_good = 1.0
        lam = 1.0 + step
        first_bad = None
        while lam <= lambda_max + 1e-9:
            r = eval_lam(lam)
            if ok(r):
                records.append((lam, r))
                last_good = lam
                lam = round(lam + step, 6)
            else:
                first_bad = lam
                break
        # Refine the nose by bisecting the last-good / first-bad bracket.
        if first_bad is not None:
            observed_collapse = True
            lo, hi = last_good, first_bad
            for _ in range(BISECT_STEPS):
                mid = (lo + hi) / 2.0
                r = eval_lam(mid)
                if ok(r):
                    lo = mid
                    records.append((mid, r))
                else:
                    hi = mid
            last_good = lo

    records.sort(key=lambda e: e[0])
    lam_critical = records[-1][0]
    collapsed = observed_collapse
    nose_result = records[-1][1]

    # Critical bus = weakest energized bus at the nose.
    nose_energ = _energized(nose_result)
    crit_bus = min(nose_energ, key=lambda b: b.voltage_pu, default=None)
    critical_bus_id = crit_bus.bus_id if crit_bus else ""
    critical_bus_name = crit_bus.bus_name if crit_bus else ""
    nose_v_pu = crit_bus.voltage_pu if crit_bus else 0.0

    lam_list = [round(l, 4) for l, _ in records]
    load_list = [round(base_load_mw * l, 4) for l, _ in records]
    min_v_list = [round(_min_v(r), 4) for _, r in records]

    # Per-bus P-V curves (buses present in every solved case).
    bus_ids = [b.bus_id for b in _energized(base)]
    bus_names = {b.bus_id: b.bus_name for b in base.buses.values()}
    bus_curves = []
    for bid in bus_ids:
        vals = []
        for _, r in records:
            rb = r.buses.get(bid)
            vals.append(round(rb.voltage_pu, 4) if rb and rb.energized else None)
        bus_curves.append(PVBusCurve(
            bus_id=bid, bus_name=bus_names.get(bid, bid),
            is_critical=(bid == critical_bus_id), v_pu=vals))

    margin_pct = round((lam_critical - 1.0) * 100.0, 2)
    if collapsed:
        note = (f"Voltage collapses at λ = {lam_critical:.3f} "
                f"({load_list[-1]:.2f} MW total demand); weakest bus "
                f"'{critical_bus_name}' at {nose_v_pu:.3f} p.u.")
    else:
        note = (f"No collapse up to λ = {lam_critical:.2f} "
                f"(+{margin_pct:.0f} % load) — margin is a lower bound; raise "
                f"lambda_max to find the nose.")

    # ── Q-V reactive-margin curve at the requested / weakest bus ──
    qv_target = qv_bus_id or critical_bus_id
    qv_curve, qv_name, qv_min, qv_op_v, qv_op_q = _qv_curve(
        project, qv_target, method, warnings)

    return VoltageStabilityResults(
        converged=True,
        collapsed=collapsed,
        lambda_critical=round(lam_critical, 4),
        loading_margin_pct=margin_pct,
        base_load_mw=round(base_load_mw, 4),
        critical_load_mw=round(base_load_mw * lam_critical, 4),
        critical_bus_id=critical_bus_id,
        critical_bus_name=critical_bus_name,
        nose_v_pu=round(nose_v_pu, 4),
        lam=lam_list,
        load_mw=load_list,
        min_v_pu=min_v_list,
        bus_curves=bus_curves,
        qv_bus_id=qv_target if qv_curve else "",
        qv_bus_name=qv_name,
        qv_curve=qv_curve,
        qv_min_mvar=qv_min,
        qv_operating_v_pu=qv_op_v,
        qv_operating_mvar=qv_op_q,
        method="P-V load-scaling continuation",
        warnings=warnings,
        note=note,
    )


def _qv_curve(project: ProjectData, bus_id: str, method: str, warnings: list):
    """Sweep a fictitious condenser's voltage setpoint at *bus_id* and record the
    reactive injection needed to hold it. Returns
    (points, bus_name, min_mvar, operating_v_pu, operating_mvar)."""
    if not bus_id:
        return [], "", None, None, None
    data = project.model_dump()
    bus = next((c for c in data["components"] if c.get("id") == bus_id), None)
    if not bus or bus.get("type") not in ("bus", "distribution_board"):
        return [], "", None, None, None
    bus_name = str((bus.get("props") or {}).get("name", bus_id))

    # A bus that is itself a source terminal (utility/generator connected) is
    # already voltage-controlled — a Q-V sweep there is meaningless.
    src_ids = {w["fromComponent"] for w in data["wires"] if w["toComponent"] == bus_id}
    src_ids |= {w["toComponent"] for w in data["wires"] if w["fromComponent"] == bus_id}
    by_id = {c["id"]: c for c in data["components"]}
    if any(by_id.get(sid, {}).get("type") in ("utility", "generator")
           for sid in src_ids):
        warnings.append(f"Q-V skipped for '{bus_name}' — it is a source-controlled "
                        "bus (already voltage-regulated).")
        return [], bus_name, None, None, None

    # Operating-point voltage for the marker (base solve).
    base = run_load_flow(project, method)
    op_v = None
    rb = base.buses.get(bus_id)
    if rb and rb.energized:
        op_v = round(rb.voltage_pu, 4)

    setpoints = [round(1.15 - 0.025 * i, 4) for i in range(29)]  # 1.15 → 0.45
    points = []
    op_q = None
    for vv in setpoints:
        d2 = copy.deepcopy(data)
        b2 = next(c for c in d2["components"] if c["id"] == bus_id)
        b2.setdefault("props", {})["bus_type"] = "PV"
        d2["components"].append({
            "id": QV_CONDENSER_ID, "type": "generator",
            "x": b2.get("x", 0), "y": b2.get("y", 0), "rotation": 0,
            "props": {"name": "Q-V condenser", "rated_mva": 99999,
                      "power_factor": 0.0, "voltage_setpoint_pu": vv,
                      "dispatch_mode": "standby"},
        })
        d2["wires"].append({
            "id": QV_WIRE_ID, "fromComponent": QV_CONDENSER_ID, "fromPort": "out",
            "toComponent": bus_id, "toPort": "at_0",
        })
        try:
            r = run_load_flow(ProjectData(**d2), method)
        except Exception:
            continue
        cb = r.buses.get(bus_id)
        if r.converged and cb and cb.energized:
            # Net reactive injection at the bus = condenser Q − local reactive
            # load; the Q the source supplies to hold this voltage.
            points.append(QVCurvePoint(v_pu=round(cb.voltage_pu, 4),
                                       q_mvar=round(cb.q_mvar, 3)))
            if op_v is not None and op_q is None and cb.voltage_pu <= op_v + 1e-6:
                op_q = round(cb.q_mvar, 3)

    if not points:
        return [], bus_name, None, None, None
    qv_min = round(min(p.q_mvar for p in points), 3)
    return points, bus_name, qv_min, op_v, op_q
