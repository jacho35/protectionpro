"""Distribution reliability assessment — SAIDI / SAIFI / MAIFI (IEEE 1366)
via analytical failure-mode-and-effect analysis (FMEA).

Every failable component carries a permanent failure rate λ (occ/yr — for
cables/lines a per-km rate × length) and a mean repair time r (hours). Each
failure mode is analysed as a sustained outage: the component is removed and
the buses that lose ALL source paths (connectivity walk through closed
switching devices, no load-flow solve needed) are the interrupted load
points — the perfect-selectivity assumption used by the classic radial FMEA
method (Billinton & Allan, "Reliability Evaluation of Power Systems" ch. 7).
Sectionalizing / backfeed restoration via normally-open points is out of
scope (no NO-point modelling in the SLD yet).

Load points carry customer counts (`customers` prop on loads and
distribution boards, default 1) and their demand MW (the load-flow engine's
own `connected_bus_loads_mw` walker, so demand accounting matches the
solver). Per IEEE 1366:

    SAIFI = Σ λ_k·N_k / N_total          (interruptions / customer·yr)
    SAIDI = Σ λ_k·r_k·N_k / N_total      (hours / customer·yr)
    CAIDI = SAIDI / SAIFI                (hours / interruption)
    ASAI  = (8760 − SAIDI) / 8760
    MAIFI = Σ λm_k·N_k / N_total         (momentary, from λm — overhead
                                          lines' temporary faults cleared
                                          by reclosing)
    EENS  = Σ λ_k·r_k·P_k                (MWh / yr not supplied)

Default rates (overridable per component via `failure_rate_per_yr` /
`failure_rate_per_km_yr`, `repair_time_h`, `momentary_rate_per_km_yr`) are
typical IEEE 493 "Gold Book" / distribution-planning figures — see
DEFAULT_RATES. Results are on-demand (not persisted).
"""

from __future__ import annotations

from ..models.schemas import ProjectData
from .loadflow import connected_bus_loads_mw, _find_components_at_bus

HOURS_PER_YEAR = 8760.0

# (λ /yr [or /km·yr where per_km], repair h). Sources' λ models loss of that
# in-feed (for the utility: upstream-grid sustained interruptions).
DEFAULT_RATES = {
    "cable_underground": {"lambda_per_km": 0.05, "repair_h": 26.0,
                          "momentary_per_km": 0.0},
    "cable_overhead": {"lambda_per_km": 0.10, "repair_h": 5.0,
                       "momentary_per_km": 0.30},
    "transformer": {"lambda": 0.015, "repair_h": 72.0},
    "autotransformer": {"lambda": 0.015, "repair_h": 72.0},
    "bus": {"lambda": 0.002, "repair_h": 8.0},
    "distribution_board": {"lambda": 0.002, "repair_h": 8.0},
    "cb": {"lambda": 0.003, "repair_h": 12.0},
    "switch": {"lambda": 0.002, "repair_h": 8.0},
    "fuse": {"lambda": 0.002, "repair_h": 4.0},
    "utility": {"lambda": 1.0, "repair_h": 2.0},
    "generator": {"lambda": 0.5, "repair_h": 24.0},
    "solar_pv": {"lambda": 0.2, "repair_h": 24.0},
    "wind_turbine": {"lambda": 0.4, "repair_h": 48.0},
    "battery": {"lambda": 0.2, "repair_h": 24.0},
}
SOURCE_TYPES = ("utility", "generator", "solar_pv", "wind_turbine", "battery")
LOAD_TYPES = ("static_load", "motor_induction", "motor_synchronous")


def _fnum(props, key, default):
    try:
        v = props.get(key)
        return float(v) if v not in (None, "") else float(default)
    except (TypeError, ValueError):
        return float(default)


def _failure_model(comp):
    """(λ_per_yr, repair_h, λ_momentary_per_yr) for one component, or None."""
    p = comp.props
    if comp.type == "cable":
        overhead = str(p.get("construction", "cable")).lower() == "overhead"
        d = DEFAULT_RATES["cable_overhead" if overhead
                          else "cable_underground"]
        km = max(0.0, _fnum(p, "length_km", 1.0))
        lam = _fnum(p, "failure_rate_per_km_yr", d["lambda_per_km"]) * km
        rep = _fnum(p, "repair_time_h", d["repair_h"])
        mom = _fnum(p, "momentary_rate_per_km_yr", d["momentary_per_km"]) * km
        return lam, rep, mom
    d = DEFAULT_RATES.get(comp.type)
    if d is None:
        return None
    lam = _fnum(p, "failure_rate_per_yr", d["lambda"])
    rep = _fnum(p, "repair_time_h", d["repair_h"])
    return lam, rep, 0.0


def _energized_buses(project, components, adjacency, removed_id=None):
    """Bus ids reachable from any source through closed devices, with
    `removed_id` (the failed component) blocked."""

    def blocked(cid):
        if cid == removed_id:
            return True
        comp = components.get(cid)
        if comp is None:
            return True
        if (comp.type in ("cb", "switch")
                and comp.props.get("state", "closed") == "open"):
            return True
        return False

    seen = set()
    stack = [c.id for c in project.components
             if c.type in SOURCE_TYPES and not blocked(c.id)]
    seen.update(stack)
    while stack:
        cid = stack.pop()
        for nb in adjacency.get(cid, []):
            if nb in seen or blocked(nb):
                continue
            seen.add(nb)
            stack.append(nb)
    return {c.id for c in project.components
            if c.type in ("bus", "distribution_board") and c.id in seen}


def _bus_customers(project, components, adjacency):
    """{bus_id: customers} — `customers` prop of every load served from the
    bus (walking through transparent devices), plus a board's own count."""
    out = {}
    for bus in project.components:
        if bus.type not in ("bus", "distribution_board"):
            continue
        n = 0.0
        if bus.type == "distribution_board":
            n += _fnum(bus.props, "customers", 1.0)
        for comp in _find_components_at_bus(bus.id, adjacency, components):
            if comp.type in LOAD_TYPES:
                n += _fnum(comp.props, "customers", 1.0)
        if n > 0:
            out[bus.id] = n
    return out


def run_reliability(project: ProjectData) -> dict:
    components = {c.id: c for c in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    base_energized = _energized_buses(project, components, adjacency)
    customers = _bus_customers(project, components, adjacency)
    loads_mw = connected_bus_loads_mw(project)
    # Only customers/loads that are actually served in the base case count.
    served = {b for b in base_energized if customers.get(b, 0) > 0
              or loads_mw.get(b, 0) > 0}
    n_total = sum(customers.get(b, 0) for b in base_energized)
    if n_total <= 0:
        return {"converged": False, "note": (
            "No served customers — add loads (each carries a `customers` "
            "count) on energized buses."), "warnings": [], "fmea": [],
            "load_points": [], "indices": {}}

    warnings = []
    fmea = []
    # Per-load-point accumulators (Billinton load-point indices)
    lp_lambda = {b: 0.0 for b in served}
    lp_hours = {b: 0.0 for b in served}
    saifi_num = saidi_num = maifi_num = eens = 0.0

    for comp in project.components:
        model = _failure_model(comp)
        if model is None:
            continue
        lam, rep, mom = model
        if lam <= 0 and mom <= 0:
            continue
        energized = _energized_buses(project, components, adjacency,
                                     removed_id=comp.id)
        affected = [b for b in served if b in base_energized
                    and b not in energized]
        n_aff = sum(customers.get(b, 0) for b in affected)
        p_aff = sum(loads_mw.get(b, 0) for b in affected)
        if n_aff <= 0 and p_aff <= 0:
            continue
        saifi_c = lam * n_aff / n_total
        saidi_c = lam * rep * n_aff / n_total
        maifi_c = mom * n_aff / n_total
        eens_c = lam * rep * p_aff
        saifi_num += saifi_c
        saidi_num += saidi_c
        maifi_num += maifi_c
        eens += eens_c
        for b in affected:
            lp_lambda[b] += lam
            lp_hours[b] += lam * rep
        fmea.append({
            "element_id": comp.id,
            "name": str(comp.props.get("name", comp.type)),
            "type": comp.type,
            "lambda_per_yr": round(lam, 5),
            "repair_h": round(rep, 2),
            "momentary_per_yr": round(mom, 5),
            "customers_affected": round(n_aff, 1),
            "load_mw_affected": round(p_aff, 4),
            "saifi_contrib": round(saifi_c, 5),
            "saidi_contrib_h": round(saidi_c, 5),
            "eens_mwh_yr": round(eens_c, 4),
        })

    fmea.sort(key=lambda f: -f["saidi_contrib_h"])
    saifi = saifi_num
    saidi = saidi_num
    caidi = saidi / saifi if saifi > 1e-12 else 0.0
    asai = (HOURS_PER_YEAR - saidi) / HOURS_PER_YEAR

    load_points = []
    for b in sorted(served, key=lambda x: -lp_hours.get(x, 0)):
        comp = components.get(b)
        lam_lp = lp_lambda.get(b, 0.0)
        u_lp = lp_hours.get(b, 0.0)
        load_points.append({
            "bus_id": b,
            "name": str(comp.props.get("name", b)) if comp else b,
            "customers": round(customers.get(b, 0), 1),
            "load_mw": round(loads_mw.get(b, 0), 4),
            "lambda_per_yr": round(lam_lp, 4),
            "unavailability_h_yr": round(u_lp, 4),
            "caidi_h": round(u_lp / lam_lp, 3) if lam_lp > 1e-12 else 0.0,
        })

    unserved = [b for b in customers if b not in base_energized]
    if unserved:
        warnings.append(f"{len(unserved)} load bus(es) de-energized in the "
                        "base case — excluded from the indices.")

    return {
        "converged": True,
        "indices": {
            "saifi": round(saifi, 4),
            "saidi_h": round(saidi, 4),
            "saidi_min": round(saidi * 60.0, 2),
            "caidi_h": round(caidi, 3),
            "asai": round(asai, 6),
            "asai_pct": round(asai * 100.0, 4),
            "maifi": round(maifi_num, 4),
            "eens_mwh_yr": round(eens, 4),
            "customers_total": round(n_total, 1),
        },
        "fmea": fmea,
        "load_points": load_points,
        "method": ("Analytical FMEA (Billinton & Allan) over source-"
                   "connectivity outages; IEEE 1366 indices; IEEE 493-style "
                   "default rates, overridable per component"),
        "warnings": warnings,
        "note": "",
    }
