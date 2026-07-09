"""Load Flow Analysis — Newton-Raphson and Gauss-Seidel solvers.

Solves the power flow equations for bus voltages and branch flows
using per-unit system on a common MVA base.
"""

import math
import numpy as np
from ..models.schemas import (
    ProjectData, LoadFlowResults, LoadFlowBus, LoadFlowBranch, LoadFlowWarning,
    DispatchEntry,
)


MAX_ITERATIONS = 100
TOLERANCE = 1e-6

# Components that are "transparent" — zero impedance pass-through
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester"}


def _is_transparent_and_closed(comp):
    """Check if a component is transparent (pass-through) and in closed/active state."""
    if comp.type not in TRANSPARENT_TYPES:
        return False
    # CBs and switches can be open — block current flow
    if comp.type in ("cb", "switch"):
        state = comp.props.get("state", "closed")
        if state == "open":
            return False
    return True


def _build_bus_groups(buses, adjacency, components, bus_idx):
    """Build bus groups: each bus and all transparent elements reachable from it.
    Returns bus_of dict mapping component_id -> bus_id for all group members."""
    bus_of = {}
    for bus in buses:
        stack = [bus.id]
        while stack:
            nid = stack.pop()
            if nid in bus_of:
                continue
            bus_of[nid] = bus.id
            for neighbor in adjacency.get(nid, []):
                if neighbor in bus_of:
                    continue
                # Don't cross into another bus
                if neighbor in bus_idx and neighbor != bus.id:
                    continue
                comp = components.get(neighbor)
                if comp and _is_transparent_and_closed(comp):
                    stack.append(neighbor)
    return bus_of


def _find_bus_paths(comp_id, adjacency, components, bus_of):
    """BFS from a branch element through transparent elements AND other branch elements
    to find connected buses. Returns list of (bus_id, path_of_branch_components).
    Stops at bus boundaries — does not walk past a bus."""
    visited = {comp_id}
    start_comp = components.get(comp_id)
    start_path = [start_comp] if start_comp and start_comp.type in ("cable", "transformer") else []

    queue = [(nid, list(start_path)) for nid in adjacency.get(comp_id, [])]
    found = []

    while queue:
        nid, path = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)

        # Check if this node is in a bus group
        if nid in bus_of:
            found.append((bus_of[nid], path))
            continue  # Don't walk past a bus

        comp = components.get(nid)
        if not comp:
            continue

        if _is_transparent_and_closed(comp):
            for neighbor in adjacency.get(nid, []):
                if neighbor not in visited:
                    queue.append((neighbor, list(path)))
        elif comp.type in ("cable", "transformer"):
            new_path = path + [comp]
            for neighbor in adjacency.get(nid, []):
                if neighbor not in visited:
                    queue.append((neighbor, new_path))
        # else: blocked (open CB or unknown component type)

    return found


def _find_components_at_bus(bus_id, adjacency, components):
    """Find non-transparent components connected to a bus through transparent elements."""
    visited = {bus_id}
    queue = list(adjacency.get(bus_id, []))
    found = []
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        comp = components.get(nid)
        if not comp:
            continue
        if _is_transparent_and_closed(comp):
            for neighbor_id in adjacency.get(nid, []):
                if neighbor_id not in visited:
                    queue.append(neighbor_id)
        else:
            found.append(comp)
    return found


# ── Generation dispatch (merit order) ───────────────────────────────
#
# Sources carry three optional props:
#   dispatch_priority — merit order, 1 = dispatched first (defaults below)
#   dispatch_mode     — "must_run" (always inject full available output,
#                       the historical behaviour) or "merit_order"
#                       (dispatched only up to remaining island demand)
#   allow_export      — utility only: "yes" lets the swing absorb excess
#                       generation (export); "no" curtails instead
#
# Within each electrical island the source with the HIGHEST priority
# number acts as the balancer (slack): utility by default, else a
# generator, else an inverter source. Islands with no source are
# reported de-energized instead of making the whole solve singular.

DEFAULT_DISPATCH_PRIORITY = {"solar_pv": 1, "wind_turbine": 1, "generator": 2, "utility": 3}
_BALANCER_TYPE_RANK = {"utility": 3, "generator": 2, "wind_turbine": 1, "solar_pv": 0}
DISPATCHABLE_SOURCE_TYPES = ("generator", "solar_pv", "wind_turbine")


def _fmt_power_mw(mw):
    """Format a MW quantity with adaptive units (kW below 1 MW)."""
    if abs(mw) < 1.0:
        return f"{mw * 1000:.0f} kW"
    return f"{mw:.2f} MW"


def _dispatch_priority(comp):
    try:
        p = float(comp.props.get("dispatch_priority", 0) or 0)
    except (TypeError, ValueError):
        p = 0
    return p if p > 0 else DEFAULT_DISPATCH_PRIORITY.get(comp.type, 2)


_DEFAULT_DISPATCH_MODE = {"generator": "standby"}  # others default to must_run


def _dispatch_mode(comp):
    default = _DEFAULT_DISPATCH_MODE.get(comp.type, "must_run")
    mode = str(comp.props.get("dispatch_mode", default) or default)
    return mode if mode in ("must_run", "merit_order", "standby") else default


def _utility_allows_export(util):
    return str(util.props.get("allow_export", "yes")).lower() != "no"


def _gen_control(comp):
    """Paralleling scheme: 'droop' (rating-proportional sharing, historical)
    or 'sequential' (load-demand start: lead set fully loaded before the
    next starts, DSE/ComAp controller style)."""
    mode = str(comp.props.get("gen_control", "droop") or "droop")
    return mode if mode in ("droop", "sequential") else "droop"


def _start_threshold(comp):
    """Load-demand start threshold, % of running capacity (default 90)."""
    try:
        pct = float(comp.props.get("start_threshold_pct", 90) or 90)
    except (TypeError, ValueError):
        pct = 90.0
    return max(50.0, min(100.0, pct))


def _gen_min_load_mw(comp):
    """Minimum running load for a generator, MW (wet-stacking floor).

    Diesel sets running below ~30% of rating for extended periods suffer
    wet stacking; manufacturers recommend 30-35% minimum and NFPA 110
    exercises at >=30% of nameplate. Settable via min_load_pct (default 30)."""
    if comp.type != "generator":
        return 0.0
    try:
        pct = float(comp.props.get("min_load_pct", 30) or 0)
    except (TypeError, ValueError):
        pct = 30.0
    rated = comp.props.get("rated_mva", 10)
    pf = comp.props.get("power_factor", 0.85)
    return rated * pf * max(0.0, min(100.0, pct)) / 100.0


def _utility_supply_capacity(util):
    """Utility supply capacity in MVA; 0 = unlimited (infinite bus)."""
    try:
        return float(util.props.get("supply_capacity_mva", 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def _source_connection_bus(src, adjacency, components, bus_idx):
    """Nearest bus reachable from a source through closed elements.

    Walks through cables/transformers/transparent devices, blocked by open
    CBs/switches. Returns a bus id, or None if the source is disconnected."""
    visited = {src.id}
    queue = list(adjacency.get(src.id, []))
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in bus_idx:
            return nid
        comp = components.get(nid)
        if not comp:
            continue
        if comp.type in ("cb", "switch") and comp.props.get("state", "closed") == "open":
            continue  # Open device blocks the path
        for nb in adjacency.get(nid, []):
            if nb not in visited:
                queue.append(nb)
    return None


def _compute_islands(n, bus_idx, branch_pairs):
    """Union-find over bus indices; returns island id per bus index."""
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in branch_pairs:
        ra, rb = find(bus_idx[a]), find(bus_idx[b])
        if ra != rb:
            parent[ra] = rb

    island_of = {}
    island_ids = {}
    for i in range(n):
        root = find(i)
        island_ids.setdefault(root, len(island_ids) + 1)
        island_of[i] = island_ids[root]
    return island_of


def plan_dispatch(project, components, adjacency, bus_idx, buses,
                  branch_pairs, bus_load_p_mw, loss_adders=None):
    """Island detection, per-island swing selection, and merit-order dispatch.

    bus_load_p_mw: per-bus-index total load MW (positive = consumption).
    loss_adders: optional {island_number: MW} added to that island's demand —
    used by the loss-compensation pass so curtailed sources also cover the
    measured network losses instead of leaving them on a no-export utility.

    Returns dict with:
      swing_idx     — set of bus indices to run as Swing
      dead_idx      — set of bus indices in de-energized (sourceless) islands
      injections    — {bus_index: [p_mw, q_mvar]} dispatched output of
                      non-balancer direct sources (to add to P_spec/Q_spec)
      dispatched_by_comp — {comp_id: (p_mw, q_mvar)} same data per source
      entries       — list of dicts for the DispatchEntry results table
                      (balancer output is filled in post-solve by the caller)
      warnings      — list of LoadFlowWarning
      island_of     — {bus_index: island number}
    """
    n = len(buses)
    island_of = _compute_islands(n, bus_idx, branch_pairs)
    warnings = []
    entries = []
    injections = {}
    dispatched_by_comp = {}
    swing_idx = set()
    dead_idx = set()

    # ── Locate every source's connection bus ──
    # Direct sources (reachable through transparent elements only) can be
    # dispatched via P_spec. Sources behind a cable/transformer only anchor
    # the island's reference (matching the historical utility-behind-TX
    # promotion); their output is recovered from the slack solution.
    direct_src_bus = {}   # comp_id -> bus_index
    for bus in buses:
        for comp in _find_components_at_bus(bus.id, adjacency, components):
            if comp.type in DISPATCHABLE_SOURCE_TYPES or comp.type == "utility":
                direct_src_bus.setdefault(comp.id, bus_idx[bus.id])

    island_sources = {}   # island -> list of (comp, bus_index, direct)
    for comp in project.components:
        if comp.type not in DISPATCHABLE_SOURCE_TYPES and comp.type != "utility":
            continue
        if comp.id in direct_src_bus:
            bi = direct_src_bus[comp.id]
            direct = True
        else:
            conn = _source_connection_bus(comp, adjacency, components, bus_idx)
            if conn is None:
                entries.append({
                    "source_id": comp.id,
                    "source_name": str(comp.props.get("name", comp.type)),
                    "source_type": comp.type, "bus_id": "", "island": 0,
                    "priority": _dispatch_priority(comp), "mode": _dispatch_mode(comp),
                    "role": "offline",
                    "available_mw": round(_source_output_mva(comp)[0], 4),
                    "dispatched_mw": 0.0, "curtailed_mw": 0.0,
                })
                continue  # Disconnected (e.g. behind an open CB)
            bi = bus_idx[conn]
            direct = False
        island_sources.setdefault(island_of[bi], []).append((comp, bi, direct))

    user_swing_islands = {}
    for bus in buses:
        if bus.props.get("bus_type", "PQ") == "Swing":
            user_swing_islands.setdefault(island_of[bus_idx[bus.id]], bus_idx[bus.id])

    # ── Per-island swing selection and dispatch ──
    islands = sorted({island_of[i] for i in range(n)})
    for isl in islands:
        isl_buses = [i for i in range(n) if island_of[i] == isl]
        sources = island_sources.get(isl, [])
        utilities = [(c, bi, d) for c, bi, d in sources if c.type == "utility"]

        if not sources:
            if isl in user_swing_islands:
                # User-forced swing with no modelled source — honour it
                swing_idx.add(user_swing_islands[isl])
            else:
                dead_idx.update(isl_buses)
                _bname = buses[isl_buses[0]].props.get("name", buses[isl_buses[0]].id)
                warnings.append(LoadFlowWarning(
                    elementId=buses[isl_buses[0]].id,
                    element_name=str(_bname),
                    message=(f"Island containing bus '{_bname}' has no connected "
                             "source — reported de-energized (0 V)."),
                ))
            continue

        demand_mw = (sum(bus_load_p_mw[i] for i in isl_buses)
                     + (loss_adders or {}).get(isl, 0.0))

        # ── Sequential generator commitment (load-demand start) ──
        # Islanded sets with gen_control='sequential' commit in dispatch_priority
        # order: the lead set runs first; the next starts only when the running
        # capacity utilisation would exceed the start threshold. Committed sets
        # before the last run FIXED at full output; the last committed set is
        # the island balancer (slack). Uncommitted sets are OFF.
        # (Grid-tied sequential sets keep their dispatch_mode behaviour —
        # 'standby' already fills shortfall in priority order.)
        seq_gens = sorted(
            [(c, bi, d) for c, bi, d in sources
             if c.type == "generator" and _gen_control(c) == "sequential"],
            key=lambda e: (_dispatch_priority(e[0]), str(e[0].props.get("name", e[0].id))))
        seq_balancer_entry = None
        seq_fixed = []     # committed, non-last: fixed-output entries
        seq_off = []       # uncommitted entries
        seq_fixed_target = {}  # comp_id -> fixed MW (fill-first allocation)
        if seq_gens and not utilities:
            renewable_mw = sum(
                _source_output_mva(c)[0] for c, _bi, d in sources
                if d and c.type in ("solar_pv", "wind_turbine"))
            gen_borne = max(0.0, demand_mw - renewable_mw)
            committed = [seq_gens[0]]   # lead set always runs (island slack)
            for entry in seq_gens[1:]:
                cap = sum(_source_output_mva(c)[0] for c, _b, _d in committed)
                thr = _start_threshold(committed[-1][0])
                if gen_borne > cap * thr / 100.0:
                    committed.append(entry)
                    warnings.append(LoadFlowWarning(
                        elementId=entry[0].id,
                        element_name=str(entry[0].props.get("name", entry[0].type)),
                        message=(f"Set '{entry[0].props.get('name', entry[0].id)}' brought "
                                 f"online — running capacity exceeded the {thr:.0f}% "
                                 "start threshold."),
                    ))
                else:
                    seq_off.append(entry)
            seq_balancer_entry = committed[-1]
            seq_fixed = committed[:-1]
            # Fill-first sharing with a floor for the balancing set: earlier
            # sets take as much as possible, but leave the last-committed set
            # at least its minimum load (so a set brought online just past
            # the threshold doesn't backfeed — the lead set backs off instead)
            avail_for_fixed = max(0.0, gen_borne - min(
                _source_output_mva(seq_balancer_entry[0])[0],
                _gen_min_load_mw(seq_balancer_entry[0])) if seq_fixed else gen_borne)
            for c, _b, _d in seq_fixed:
                rated = _source_output_mva(c)[0]
                seq_fixed_target[c.id] = min(rated, avail_for_fixed)
                avail_for_fixed = max(0.0, avail_for_fixed - seq_fixed_target[c.id])
            if seq_off:
                held = ", ".join(f"'{e[0].props.get('name', e[0].id)}'" for e in seq_off)
                warnings.append(LoadFlowWarning(
                    elementId=seq_off[0][0].id,
                    element_name=str(seq_off[0][0].props.get("name", "generator")),
                    message=(f"Sequence set(s) {held} held off — committed capacity "
                             "covers the island demand."),
                ))

        # Balancer: highest dispatch priority number; ties broken by type
        # (utility > generator > wind > solar) then largest available output.
        def _balancer_key(entry):
            comp = entry[0]
            return (_dispatch_priority(comp),
                    _BALANCER_TYPE_RANK.get(comp.type, 0),
                    _source_output_mva(comp)[0] if comp.type != "utility" else float("inf"))

        if utilities:
            balancers = utilities
        elif seq_balancer_entry is not None:
            balancers = [seq_balancer_entry]
        else:
            balancers = [max(sources, key=_balancer_key)]
        balancer_ids = {c.id for c, _bi, _d in balancers}

        for comp, bi, _d in balancers:
            swing_idx.add(bi)
        if not utilities and isl in user_swing_islands:
            # No utility: a user-labelled Swing bus overrides source choice
            swing_idx -= {bi for _c, bi, _d in balancers}
            swing_idx.add(user_swing_islands[isl])

        bcomp = balancers[0][0]
        if not utilities and bcomp.type == "generator":
            warnings.append(LoadFlowWarning(
                elementId=bcomp.id,
                element_name=str(bcomp.props.get("name", bcomp.type)),
                message=(f"Island without utility — generator "
                         f"'{bcomp.props.get('name', bcomp.id)}' acts as the "
                         "reference (slack) source."),
            ))
        elif not utilities and bcomp.type in ("solar_pv", "wind_turbine"):
            warnings.append(LoadFlowWarning(
                elementId=bcomp.id,
                element_name=str(bcomp.props.get("name", bcomp.type)),
                message=(f"Island without utility — inverter source "
                         f"'{bcomp.props.get('name', bcomp.id)}' acts as the "
                         "reference. A real island requires grid-forming "
                         "inverter capability."),
            ))

        # ── Merit-order dispatch of the non-balancer direct sources ──
        seq_managed_ids = ({c.id for c, _b, _d in seq_fixed} |
                           {c.id for c, _b, _d in seq_off})
        dispatchable = [(c, bi) for c, bi, d in sources
                        if d and c.type in DISPATCHABLE_SOURCE_TYPES
                        and c.id not in balancer_ids
                        and c.id not in seq_managed_ids]

        _merit_key = lambda e: (_dispatch_priority(e[0]),
                                str(e[0].props.get("name", e[0].id)))
        plan = []  # [comp, bus_index, p_avail, q_avail, p_dispatch, p_target]
        must_run = [e for e in dispatchable if _dispatch_mode(e[0]) == "must_run"]
        merit = [e for e in dispatchable if _dispatch_mode(e[0]) == "merit_order"]
        standby = [e for e in dispatchable if _dispatch_mode(e[0]) == "standby"]
        # Committed sequential sets before the last run fixed at full output
        must_run += [(c, bi) for c, bi, d in seq_fixed if d]
        # Uncommitted sequence sets are OFF: zero output, own role in the table
        for comp, bi, _d in seq_off:
            dispatched_by_comp[comp.id] = (0.0, 0.0)
            entries.append({
                "source_id": comp.id,
                "source_name": str(comp.props.get("name", comp.type)),
                "source_type": comp.type,
                "bus_id": buses[bi].id, "island": isl,
                "priority": _dispatch_priority(comp), "mode": "sequential",
                "role": "off",
                "available_mw": round(_source_output_mva(comp)[0], 4),
                "dispatched_mw": 0.0, "curtailed_mw": 0.0,
            })
        if not utilities:
            # Islanded from the utility: standby sources join the merit order
            merit += standby
            standby = []
        merit.sort(key=_merit_key)
        standby.sort(key=_merit_key)

        for comp, bi in must_run:
            p_av, q_av, _s, _r = _source_output_mva(comp)
            # Committed sequential sets run at their fill-first allocation
            p_tgt = seq_fixed_target.get(comp.id, p_av)
            plan.append([comp, bi, p_av, q_av, p_tgt, p_tgt])

        remaining = demand_mw - sum(e[4] for e in plan)
        for comp, bi in merit:
            p_av, q_av, _s, _r = _source_output_mva(comp)
            p_disp = min(p_av, max(0.0, remaining))
            remaining -= p_disp
            plan.append([comp, bi, p_av, q_av, p_disp, p_disp])

        # ── Standby sources: run only for demand beyond the utility's
        # supply capacity (utility supply_capacity_mva; 0 = unlimited) ──
        if standby:
            caps = [_utility_supply_capacity(u) for u, _b, _d in utilities]
            cap = None if any(c <= 0 for c in caps) else sum(caps)
            shortfall = (demand_mw - sum(e[4] for e in plan) - cap) if cap is not None else 0.0
            for comp, bi in standby:
                p_av, q_av, _s, _r = _source_output_mva(comp)
                p_disp = min(p_av, max(0.0, shortfall))
                shortfall -= p_disp
                if p_disp > 1e-9:
                    plan.append([comp, bi, p_av, q_av, p_disp, p_disp])
                    warnings.append(LoadFlowWarning(
                        elementId=comp.id,
                        element_name=str(comp.props.get("name", comp.type)),
                        message=(f"Standby source '{comp.props.get('name', comp.id)}' "
                                 f"dispatched at {_fmt_power_mw(p_disp)} — island demand "
                                 f"exceeds the utility supply capacity ({_fmt_power_mw(cap)})."),
                    ))
                else:
                    # Idle standby: record an explicit zero so branch badges
                    # don't fall back to rated output
                    dispatched_by_comp[comp.id] = (0.0, 0.0)
                    entries.append({
                        "source_id": comp.id,
                        "source_name": str(comp.props.get("name", comp.type)),
                        "source_type": comp.type,
                        "bus_id": buses[bi].id, "island": isl,
                        "priority": _dispatch_priority(comp), "mode": "standby",
                        "role": "standby",
                        "available_mw": round(p_av, 4),
                        "dispatched_mw": 0.0, "curtailed_mw": 0.0,
                    })

        # ── Generator minimum load (wet-stacking floor) ──
        # Any RUNNING generator is raised to at least min_load_pct of its
        # rating, and that floor is protected from the curtailment pass so
        # solar/wind give way first.
        min_floor = {}
        for e in plan:
            comp = e[0]
            if comp.type == "generator" and e[4] > 1e-9:
                floor = min(e[2], _gen_min_load_mw(comp))
                if floor > 0:
                    min_floor[comp.id] = floor
                    if e[4] < floor - 1e-9:
                        warnings.append(LoadFlowWarning(
                            elementId=comp.id,
                            element_name=str(comp.props.get("name", comp.type)),
                            message=(f"Generator '{comp.props.get('name', comp.id)}' "
                                     f"raised to its minimum load "
                                     f"({_fmt_power_mw(floor)}) to avoid wet stacking."),
                        ))
                        e[4] = floor
                        e[5] = max(e[5], floor)

        # ── Curtail when there is no export path for the excess ──
        export_ok = bool(utilities) and all(_utility_allows_export(u) for u, _b, _d in utilities)
        total = sum(e[4] for e in plan)
        if total > demand_mw and not export_ok:
            excess = total - demand_mw
            # Curtail least-preferred sources first (highest priority number),
            # never below a running generator's minimum-load floor
            for e in sorted(plan, key=lambda e: -_dispatch_priority(e[0])):
                if excess <= 1e-9:
                    break
                cut = min(max(0.0, e[4] - min_floor.get(e[0].id, 0.0)), excess)
                e[4] -= cut
                excess -= cut
                if cut > 1e-9:
                    warnings.append(LoadFlowWarning(
                        elementId=e[0].id,
                        element_name=str(e[0].props.get("name", e[0].type)),
                        message=(f"'{e[0].props.get('name', e[0].id)}' curtailed by "
                                 f"{_fmt_power_mw(cut)} — generation exceeds island "
                                 "demand and no export path exists."),
                    ))

        # ── Balancer generators (islanded): curtail solar/wind so the slack
        # generator itself carries at least its minimum load ──
        gen_balancers = [c for c, _b, _d in balancers if c.type == "generator"]
        gen_balancer_min = sum(min(_source_output_mva(c)[0], _gen_min_load_mw(c))
                               for c in gen_balancers)
        if gen_balancer_min > 0:
            expected = demand_mw - sum(e[4] for e in plan)
            shortfall = gen_balancer_min - expected
            bname = gen_balancers[0].props.get("name", gen_balancers[0].id)
            if shortfall > 1e-9:
                renewables = [e for e in plan
                              if e[0].type in ("solar_pv", "wind_turbine") and e[4] > 1e-9]
                for e in sorted(renewables, key=lambda e: -_dispatch_priority(e[0])):
                    if shortfall <= 1e-9:
                        break
                    cut = min(e[4], shortfall)
                    e[4] -= cut
                    shortfall -= cut
                    warnings.append(LoadFlowWarning(
                        elementId=e[0].id,
                        element_name=str(e[0].props.get("name", e[0].type)),
                        message=(f"'{e[0].props.get('name', e[0].id)}' curtailed by "
                                 f"{_fmt_power_mw(cut)} — keeps generator '{bname}' at "
                                 f"its minimum load ({_fmt_power_mw(gen_balancer_min)})."),
                    ))
                if shortfall > 1e-9:
                    warnings.append(LoadFlowWarning(
                        elementId=gen_balancers[0].id,
                        element_name=str(bname),
                        message=(f"Generator '{bname}' runs {_fmt_power_mw(shortfall)} below "
                                 f"its minimum load ({_fmt_power_mw(gen_balancer_min)}) — "
                                 "wet-stacking risk; island demand is too low."),
                    ))

        for comp, bi, p_av, q_av, p_disp, p_target in plan:
            q_disp = q_av * (p_disp / p_av) if p_av > 0 else 0.0
            inj = injections.setdefault(bi, [0.0, 0.0])
            inj[0] += p_disp
            inj[1] += q_disp
            dispatched_by_comp[comp.id] = (p_disp, q_disp)
            # "Curtailed" means output was actively cut below its target;
            # a merit-order source dispatched below capacity is just partial.
            curtailed = max(0.0, p_target - p_disp)
            entries.append({
                "source_id": comp.id,
                "source_name": str(comp.props.get("name", comp.type)),
                "source_type": comp.type,
                "bus_id": buses[bi].id, "island": isl,
                "priority": _dispatch_priority(comp), "mode": _dispatch_mode(comp),
                "role": "curtailed" if curtailed > 1e-9 else "dispatched",
                "available_mw": round(p_av, 4),
                "dispatched_mw": round(p_disp, 4),
                "curtailed_mw": round(curtailed, 4),
            })

        for comp, bi, _d in balancers:
            p_av = (_source_output_mva(comp)[0] if comp.type != "utility"
                    else _utility_supply_capacity(comp))
            _bmode = ("sequential" if comp.type == "generator"
                      and _gen_control(comp) == "sequential" else _dispatch_mode(comp))
            entries.append({
                "source_id": comp.id,
                "source_name": str(comp.props.get("name", comp.type)),
                "source_type": comp.type,
                "bus_id": buses[bi].id, "island": isl,
                "priority": _dispatch_priority(comp), "mode": _bmode,
                "role": "balancer",
                "available_mw": round(p_av, 4),
                "dispatched_mw": 0.0,   # filled post-solve from the slack solution
                "curtailed_mw": 0.0,
            })

    return {
        "swing_idx": swing_idx,
        "dead_idx": dead_idx,
        "injections": injections,
        "dispatched_by_comp": dispatched_by_comp,
        "entries": entries,
        "warnings": warnings,
        "island_of": island_of,
    }


def solve_with_islands(Y, P_spec, Q_spec, V_spec, bus_types, dead_idx, method):
    """Run NR/GS excluding de-energized buses; returns full-size V with 0 V there."""
    n = len(P_spec)
    if not dead_idx:
        if method == "gauss_seidel":
            return _gauss_seidel(Y, P_spec, Q_spec, V_spec, bus_types)
        return _newton_raphson(Y, P_spec, Q_spec, V_spec, bus_types)

    alive = [i for i in range(n) if i not in dead_idx]
    V = np.zeros(n, dtype=complex)
    if not alive:
        return V, True, 0
    idx = np.array(alive)
    Y_s = Y[np.ix_(idx, idx)]
    bt_s = [bus_types[i] for i in alive]
    if method == "gauss_seidel":
        V_s, converged, iterations = _gauss_seidel(
            Y_s, P_spec[idx], Q_spec[idx], V_spec[idx], bt_s)
    else:
        V_s, converged, iterations = _newton_raphson(
            Y_s, P_spec[idx], Q_spec[idx], V_spec[idx], bt_s)
    V[idx] = V_s
    return V, converged, iterations


def _find_source_side_neighbor(elem_id, bus_id, adjacency, bus_of):
    """Find the immediate neighbor of an element on its non-bus side.

    For source-connected elements (e.g. utility incomer TX), walks from the
    element away from the bus to find the first non-bus-group neighbor.
    Returns the neighbor component ID, or elem_id as fallback.
    """
    for neighbor_id in adjacency.get(elem_id, []):
        # Skip components that belong to the bus cluster
        if neighbor_id == bus_id or bus_of.get(neighbor_id) == bus_id:
            continue
        return neighbor_id
    return elem_id  # fallback: use the element itself


def _get_impedance(comp, base_mva):
    """Get branch impedance in per-unit on common MVA base."""
    if comp.type == "transformer":
        rated_mva = comp.props.get("rated_mva", 10)
        z_pct = comp.props.get("z_percent", 8)
        xr = comp.props.get("x_r_ratio", 10)
        z_pu = (z_pct / 100) * base_mva / rated_mva
        x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
        r_pu = x_pu / xr
        return complex(r_pu, x_pu)
    elif comp.type == "cable":
        v_kv = comp.props.get("voltage_kv", 11)
        z_base = (v_kv ** 2) / base_mva
        r = comp.props.get("r_per_km", 0.1) * comp.props.get("length_km", 1)
        x = comp.props.get("x_per_km", 0.08) * comp.props.get("length_km", 1)
        n = max(1, int(comp.props.get("num_parallel", 1)))
        return complex(r / z_base, x / z_base) / n
    return complex(0, 0)


def _get_chain_turns_ratio(elems, bus_a_id, bus_b_id, components):
    """Find transformer in a branch chain and compute its off-nominal turns ratio.

    Uses the standard transformer model where the tap is on the HV side.
    The turns ratio t accounts for both tap position and any mismatch between
    transformer rated voltages and bus base voltages.

    Returns (t, hv_bus_id) where t is the per-unit turns ratio and hv_bus_id
    is the bus on the HV (tap) side, or (1.0, None) if no transformer in chain.
    """
    for e in elems.values():
        if e.type != "transformer":
            continue

        v_hv_rated = e.props.get("voltage_hv_kv", 33)
        v_lv_rated = e.props.get("voltage_lv_kv", 11)
        tap_pct = e.props.get("tap_percent", 0)

        bus_a_comp = components.get(bus_a_id)
        bus_b_comp = components.get(bus_b_id)
        bus_a_v = bus_a_comp.props.get("voltage_kv", 11) if bus_a_comp else 11
        bus_b_v = bus_b_comp.props.get("voltage_kv", 11) if bus_b_comp else 11

        # Match buses to HV/LV sides based on voltage proximity
        if abs(bus_a_v - v_hv_rated) <= abs(bus_b_v - v_hv_rated):
            hv_bus_id = bus_a_id
            base_ratio = bus_a_v / bus_b_v if bus_b_v > 0 else 1.0
        else:
            hv_bus_id = bus_b_id
            base_ratio = bus_b_v / bus_a_v if bus_a_v > 0 else 1.0

        # Off-nominal turns ratio: actual ratio / base voltage ratio
        # When base voltages match transformer ratings, this equals (1 + tap_pct/100)
        nominal_ratio = v_hv_rated / v_lv_rated if v_lv_rated > 0 else 1.0
        actual_ratio = nominal_ratio * (1 + tap_pct / 100)
        t = actual_ratio / base_ratio if base_ratio > 0 else 1.0

        return t, hv_bus_id

    return 1.0, None


def _utility_loading_base_mva(util):
    """Denominator for utility 'loading %' annotations.

    Uses a rated/contracted MVA prop when present; falls back to fault_mva.
    Loading vs fault level is only indicative — fault_mva is a short-circuit
    capacity, not a supply rating.
    """
    return (util.props.get("rated_mva", 0)
            or util.props.get("contract_mva", 0)
            or util.props.get("fault_mva", 500))


def _source_output_mva(comp):
    """Return (p_mw, q_mvar, s_mva, rated_mva) for a directly-connected source component."""
    if comp.type == "generator":
        rated = comp.props.get("rated_mva", 10)
        pf = comp.props.get("power_factor", 0.85)
        p = rated * pf
        q = rated * math.sqrt(max(0.0, 1 - pf ** 2))
        return p, q, rated, rated
    elif comp.type == "solar_pv":
        rated_kw = comp.props.get("rated_kw", 100)
        n_inv = comp.props.get("num_inverters", 1)
        eff = comp.props.get("inverter_eff", 0.97)
        pf = comp.props.get("power_factor", 1.0)
        irr = comp.props.get("irradiance_pct", 100) / 100.0
        rated_full = rated_kw * n_inv / (eff * 1000)   # full-sun capacity
        s_mva = rated_full * irr
        p = s_mva * abs(pf)
        q = s_mva * math.sqrt(max(0.0, 1 - pf ** 2))
        return p, q, s_mva, rated_full
    elif comp.type == "wind_turbine":
        rated = comp.props.get("rated_mva", 2.0)
        n_turb = comp.props.get("num_turbines", 1)
        pf = comp.props.get("power_factor", 0.95)
        wind_pct = comp.props.get("wind_speed_pct", 100) / 100.0
        rated_full = rated * n_turb
        s_mva = rated_full * wind_pct
        p = s_mva * abs(pf)
        q = s_mva * math.sqrt(max(0.0, 1 - pf ** 2))
        return p, q, s_mva, rated_full
    return 0.0, 0.0, 0.0, 0.0


def run_load_flow(project: ProjectData, method: str = "newton_raphson") -> LoadFlowResults:
    """Run load flow analysis."""
    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}
    wires = project.wires

    # Build bus list and index
    buses = [c for c in project.components if c.type == "bus"]
    if not buses:
        return LoadFlowResults(
            buses={}, branches=[], converged=False, iterations=0, method=method
        )

    n = len(buses)
    bus_idx = {b.id: i for i, b in enumerate(buses)}

    # Build adjacency
    adjacency = {}
    for w in wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    # Build bus groups (bus + reachable transparent elements)
    bus_of = _build_bus_groups(buses, adjacency, components, bus_idx)

    # Build Y-bus admittance matrix
    Y = np.zeros((n, n), dtype=complex)

    # ── Find all branch chains between buses ──
    # A chain is a series path of cables/transformers (with transparent elements)
    # between two buses. Series impedances are summed.
    processed_chains = set()  # frozenset of element IDs to avoid duplicates
    branch_chains = []  # list of (elements_dict, bus_a, bus_b, admittance)

    for comp in project.components:
        if comp.type not in ("cable", "transformer"):
            continue
        if comp.id in bus_of:
            continue  # Inside a bus group — shouldn't happen

        # Check if already processed as part of another chain
        if comp.id in {eid for chain_key in processed_chains for eid in chain_key}:
            continue

        # Find buses reachable from this element (walking through everything)
        results = _find_bus_paths(comp.id, adjacency, components, bus_of)

        if len(results) < 2:
            continue

        bus_a, path_a = results[0]
        bus_b, path_b = results[1]

        if bus_a == bus_b:
            continue  # Loop to same bus — skip

        # Combine all unique branch elements from both direction paths
        all_elems = {}
        for _, path in results[:2]:
            for elem in path:
                all_elems[elem.id] = elem

        chain_key = frozenset(all_elems.keys())
        if chain_key in processed_chains:
            continue
        processed_chains.add(chain_key)

        # Compute total series impedance
        # For chains with a transformer, cable impedances must use the bus voltage
        # on their side of the transformer as the impedance base — not the cable's
        # own voltage_kv property, which may be wrong or defaulted.
        has_xfmr = any(e.type == "transformer" for e in all_elems.values())
        cable_voltages = {}  # elem_id -> effective voltage_kv

        if has_xfmr:
            path_a_ids = {e.id for e in path_a}
            path_b_ids = {e.id for e in path_b}
            bus_a_comp = components.get(bus_a)
            bus_b_comp = components.get(bus_b)
            bus_a_v = bus_a_comp.props.get("voltage_kv", 11) if bus_a_comp else 11
            bus_b_v = bus_b_comp.props.get("voltage_kv", 11) if bus_b_comp else 11

            z_total = complex(0, 0)
            for e in all_elems.values():
                if e.type == "transformer":
                    z_total += _get_impedance(e, base_mva)
                elif e.type == "cable":
                    # Determine which side of transformer this cable is on
                    in_a = e.id in path_a_ids
                    in_b = e.id in path_b_ids
                    if in_a and not in_b:
                        v_kv = bus_a_v
                    elif in_b and not in_a:
                        v_kv = bus_b_v
                    else:
                        # In both paths (starting element) — closer to shorter path's bus
                        v_kv = bus_a_v if len(path_a) <= len(path_b) else bus_b_v
                    cable_voltages[e.id] = v_kv
                    z_base = (v_kv ** 2) / base_mva
                    r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    z_total += complex(r / z_base, x / z_base)
                else:
                    z_total += _get_impedance(e, base_mva)
        else:
            z_total = sum((_get_impedance(e, base_mva) for e in all_elems.values()), complex(0, 0))

        if abs(z_total) > 1e-15:
            y = 1 / z_total
        else:
            # Zero-impedance chain: model as a tiny series REACTANCE
            # (large susceptance) — a real conductance of 1e6 would inject
            # fictitious resistive losses into the solution.
            y = complex(0, -1e6)

        i = bus_idx[bus_a]
        j = bus_idx[bus_b]

        # Determine if chain contains a transformer and compute turns ratio
        t, hv_bus = _get_chain_turns_ratio(all_elems, bus_a, bus_b, components)

        if hv_bus == bus_a:
            # Tap on bus_a (i) side — standard transformer pi-model
            Y[i, i] += y / (t * t)
            Y[j, j] += y
            Y[i, j] -= y / t
            Y[j, i] -= y / t
        elif hv_bus == bus_b:
            # Tap on bus_b (j) side
            Y[i, i] += y
            Y[j, j] += y / (t * t)
            Y[i, j] -= y / t
            Y[j, i] -= y / t
        else:
            # No transformer — simple series element
            Y[i, i] += y
            Y[j, j] += y
            Y[i, j] -= y
            Y[j, i] -= y

        branch_chains.append((all_elems, bus_a, bus_b, y, t, hv_bus, cable_voltages))

    # ── Find direct bus-to-bus connections (solid links through transparent elements only) ──
    linked_pairs = set()
    for bus in buses:
        # Walk from bus through ONLY transparent elements
        visited = {bus.id}
        queue = list(adjacency.get(bus.id, []))
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in bus_idx:
                pair = tuple(sorted([bus.id, nid]))
                if pair not in linked_pairs:
                    linked_pairs.add(pair)
                continue
            comp = components.get(nid)
            if comp and _is_transparent_and_closed(comp):
                for neighbor in adjacency.get(nid, []):
                    if neighbor not in visited:
                        queue.append(neighbor)

    for pair in linked_pairs:
        i = bus_idx[pair[0]]
        j = bus_idx[pair[1]]
        # Bus link: tiny series reactance (large susceptance) rather than a
        # real conductance, to avoid fictitious resistive losses.
        y_link = complex(0, -1e6)
        Y[i, i] += y_link
        Y[j, j] += y_link
        Y[i, j] -= y_link
        Y[j, i] -= y_link
        branch_chains.append((None, pair[0], pair[1], y_link, 1.0, None, {}))

    # ── Pre-scan: identify which buses have a utility source ──
    # A utility source is an "infinite bus" in power systems — it should be the
    # NR slack/swing reference, not a passive shunt admittance to ground.
    # We collect these bus IDs first so that bus_type assignment can use the info.
    _utility_bus_ids = set()
    for _bus in buses:
        if any(c.type == "utility"
               for c in _find_components_at_bus(_bus.id, adjacency, components)):
            _utility_bus_ids.add(_bus.id)

    # ── Set up power injections ──
    P_spec = np.zeros(n)
    Q_spec = np.zeros(n)
    bus_types = []  # 0=PQ, 1=PV, 2=Swing
    V_spec = np.ones(n)
    bus_load_p_mw = np.zeros(n)  # per-bus load (consumption, MW) for dispatch
    bus_load_q_mvar = np.zeros(n)  # per-bus load Q, for swing-bus source badges

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")

        # Initial bus type from user setting; Swing assignment is decided
        # per-island by plan_dispatch below (utility connection bus, else
        # user-labelled Swing, else the lowest-merit source acting as balancer).
        bus_types.append(1 if bt == "PV" else 0)

        # Find all components connected to this bus (walking through CBs/switches)
        connected = _find_components_at_bus(bus.id, adjacency, components)
        for comp in connected:
            if comp.type == "utility":
                # Utility bus is the NR swing reference — voltage is held at 1 pu.
                # Do NOT add a shunt admittance: y_shunt to ground models the
                # utility as a passive load (draining current), which is wrong.
                # Power balance is handled by the swing-bus voltage constraint.
                pass
            elif comp.type == "generator":
                # Output injection comes from the merit-order dispatcher
                # (plan_dispatch) below. Only the PV voltage setpoint is
                # read here.
                vset = float(comp.props.get("voltage_setpoint_pu", 0)
                             or comp.props.get("v_setpoint_pu", 0) or 0)
                if vset > 0 and bt == "PV":
                    V_spec[i] = vset
            elif comp.type in ("solar_pv", "wind_turbine"):
                pass  # Injection set by the dispatcher below
            elif comp.type in ("static_load", "distribution_board"):
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                P_spec[i] -= rated * pf * df / base_mva
                Q_spec[i] -= rated * math.sqrt(1 - pf**2) * df / base_mva
                bus_load_p_mw[i] += rated * pf * df
                bus_load_q_mvar[i] += rated * math.sqrt(1 - pf**2) * df
            elif comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                # IEC 60909-0 §3.8 / load_diversity.py convention:
                # S = kW/(η·pf), so P = S·pf = kW/η (unchanged) and Q is
                # consistent with the rated power factor.
                rated_mva = rated_kw / (eff * pf * 1000) if pf > 0 else rated_kw / (eff * 1000)
                P_spec[i] -= rated_mva * pf * df / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) * df / base_mva
                bus_load_p_mw[i] += rated_mva * pf * df
                bus_load_q_mvar[i] += rated_mva * math.sqrt(1 - pf**2) * df
            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                pf = comp.props.get("power_factor", 0.9)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = rated_kva / 1000
                P_spec[i] -= rated_mva * pf * df / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) * df / base_mva
                bus_load_p_mw[i] += rated_mva * pf * df
                bus_load_q_mvar[i] += rated_mva * math.sqrt(1 - pf**2) * df
            elif comp.type == "capacitor_bank":
                kvar = comp.props.get("rated_kvar", 100)
                Q_spec[i] += kvar / 1000 / base_mva
                bus_load_q_mvar[i] -= kvar / 1000  # capacitor supplies Q

    # ── Island detection, per-island swing selection, and dispatch ──
    # Each electrical island gets its own slack (utility connection bus,
    # else user-labelled Swing bus, else the lowest-merit source). Islands
    # with no source are excluded from the solve and reported de-energized.
    branch_pairs = [(ba, bb) for _e, ba, bb, _y, _t, _hv, _cv in branch_chains]

    # ── Dispatch + solve, with loss compensation ──
    # When a no-export utility ends up carrying only the network losses while
    # a curtailed source still has headroom, add the measured losses to the
    # island demand and re-dispatch, so "PV covers the load" really leaves
    # the utility at ~0 kW instead of importing the losses.
    P_base, Q_base = P_spec.copy(), Q_spec.copy()
    loss_adders = {}
    for _pass in range(3):
        dispatch = plan_dispatch(project, components, adjacency, bus_idx, buses,
                                 branch_pairs, bus_load_p_mw, loss_adders)
        for i in dispatch["swing_idx"]:
            bus_types[i] = 2
        P_spec, Q_spec = P_base.copy(), Q_base.copy()
        for i, (p_mw, q_mvar) in dispatch["injections"].items():
            P_spec[i] += p_mw / base_mva
            Q_spec[i] += q_mvar / base_mva

        V, converged, iterations = solve_with_islands(
            Y, P_spec, Q_spec, V_spec, bus_types, dispatch["dead_idx"], method)
        if not converged:
            break

        S_tmp = V * np.conj(Y @ V)
        util_import = {}   # island -> utility balancer real import (MW)
        headroom = {}      # island -> curtailed MW still available
        for e in dispatch["entries"]:
            if e["role"] == "balancer" and e["source_type"] == "utility" and e["bus_id"]:
                bi = bus_idx[e["bus_id"]]
                inj = dispatch["injections"].get(bi, (0.0, 0.0))
                util_import[e["island"]] = (util_import.get(e["island"], 0.0)
                                            + S_tmp[bi].real * base_mva
                                            + bus_load_p_mw[bi] - inj[0])
            elif e["role"] == "curtailed":
                headroom[e["island"]] = headroom.get(e["island"], 0.0) + e["curtailed_mw"]

        adjusted = False
        for isl, imp in util_import.items():
            prev = loss_adders.get(isl, 0.0)
            if headroom.get(isl, 0.0) > 1e-6 and imp > 2e-4:
                loss_adders[isl] = prev + min(imp, headroom[isl])
                adjusted = True
            elif prev > 0 and imp < -2e-4:
                # Overshoot (losses dropped once the source supplied locally)
                loss_adders[isl] = max(0.0, prev + imp)
                adjusted = True
        if not adjusted:
            break

    # ── Build results ──
    # Compute actual bus power injections from solved voltages.
    # S_bus = V * conj(Y @ V) gives the true injection at each bus,
    # including the swing bus whose scheduled injection is zero but
    # which actually supplies all system losses and unspecified power.
    I_bus = Y @ V
    S_bus = V * np.conj(I_bus)

    # Power carried by each busbar: outgoing branch flows plus local load.
    # Accumulated in the branch loop below; net injection (S_bus) alone is
    # ~0 for pass-through buses and for swing buses serving local load.
    s_through = np.zeros(n, dtype=complex)  # MVA

    # ── Branch flows ──
    branch_results = []
    for elems, from_bus, to_bus, y, t, hv_bus, cable_voltages in branch_chains:
        i = bus_idx[from_bus]
        j = bus_idx[to_bus]

        if hv_bus is not None:
            # Transformer branch — use pi-model current equations
            if hv_bus == from_bus:
                # Tap on i (from) side
                I_i = (y / (t * t)) * V[i] - (y / t) * V[j]
                I_j = -(y / t) * V[i] + y * V[j]
            else:
                # Tap on j (to) side
                I_i = y * V[i] - (y / t) * V[j]
                I_j = -(y / t) * V[i] + (y / (t * t)) * V[j]
            s_ij = V[i] * np.conj(I_i)
            s_ji = V[j] * np.conj(I_j)
        else:
            # Simple series element
            i_branch_pu = (V[i] - V[j]) * y
            s_ij = V[i] * np.conj(i_branch_pu)
            s_ji = V[j] * np.conj(-i_branch_pu)

        p_mw = s_ij.real * base_mva
        q_mvar = s_ij.imag * base_mva
        s_mva = abs(s_ij) * base_mva
        losses_mw = (s_ij.real + s_ji.real) * base_mva

        # Outgoing flow counts toward the sending bus's through-power
        if s_ij.real > 0:
            s_through[i] += s_ij * base_mva
        if s_ji.real > 0:
            s_through[j] += s_ji * base_mva

        if elems is None:
            # Bus-to-bus link (no branch elements)
            from_bus_comp = components.get(from_bus)
            v_kv_from = from_bus_comp.props.get("voltage_kv", 11) if from_bus_comp else 11
            i_amps = (s_mva * 1000) / (math.sqrt(3) * v_kv_from) if v_kv_from > 0 else 0
            branch_results.append(LoadFlowBranch(
                elementId=f"link_{from_bus}_{to_bus}",
                element_name="Bus Link",
                from_bus=from_bus, to_bus=to_bus,
                p_mw=round(p_mw, 4), q_mvar=round(q_mvar, 4),
                s_mva=round(s_mva, 4), i_amps=round(i_amps, 2),
                loading_pct=0, losses_mw=round(losses_mw, 6),
            ))
        else:
            # Report flow for each element in the series chain.
            # NOTE (display-level): every element in a series chain carries the
            # SAME branch flow, so each element row repeats the chain's
            # p_mw/q_mvar/losses — summing rows over a chain double-counts.
            # For transformer chains, compute LV-side apparent power for accurate reporting
            s_lv_mva = abs(s_ji) * base_mva if hv_bus == from_bus else s_mva
            s_hv_mva = s_mva if hv_bus == from_bus else abs(s_ji) * base_mva

            for elem in elems.values():
                loading = 0
                if elem.type == "cable":
                    # Use the bus-inferred voltage for cables in transformer chains,
                    # falling back to the cable's own voltage_kv property
                    v_kv = cable_voltages.get(elem.id, elem.props.get("voltage_kv", 11))
                    # Use the power at the cable's voltage level
                    cable_s_mva = s_mva
                    if hv_bus is not None:
                        hv_v_kv = components.get(hv_bus).props.get("voltage_kv", 33) if components.get(hv_bus) else 33
                        # Cable on HV side uses HV power, LV side uses LV power
                        cable_s_mva = s_hv_mva if abs(v_kv - hv_v_kv) <= abs(v_kv) * 0.5 else s_lv_mva
                    elem_i_amps = (cable_s_mva * 1000) / (math.sqrt(3) * v_kv) if v_kv > 0 else 0
                    rated_a = elem.props.get("rated_amps", 400) * max(1, int(elem.props.get("num_parallel", 1)))
                    rated_mva = math.sqrt(3) * v_kv * rated_a / 1000
                    loading = (cable_s_mva / rated_mva * 100) if rated_mva > 0 else 0
                elif elem.type == "transformer":
                    rated_mva_xfmr = elem.props.get("rated_mva", 10)
                    loading = (s_mva / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0
                    # Report current at the LV side (higher current) using LV-side power
                    lv_kv = min(
                        elem.props.get("voltage_hv_kv", 11),
                        elem.props.get("voltage_lv_kv", 0.42)
                    )
                    elem_i_amps = (s_lv_mva * 1000) / (math.sqrt(3) * lv_kv) if lv_kv > 0 else 0
                else:
                    from_bus_comp = components.get(from_bus)
                    v_kv_fb = from_bus_comp.props.get("voltage_kv", 11) if from_bus_comp else 11
                    elem_i_amps = (s_mva * 1000) / (math.sqrt(3) * v_kv_fb) if v_kv_fb > 0 else 0

                branch_results.append(LoadFlowBranch(
                    elementId=elem.id,
                    element_name=elem.props.get("name", elem.type),
                    from_bus=from_bus, to_bus=to_bus,
                    p_mw=round(p_mw, 4), q_mvar=round(q_mvar, 4),
                    s_mva=round(s_mva, 4), i_amps=round(elem_i_amps, 2),
                    loading_pct=round(loading, 2), losses_mw=round(losses_mw, 6),
                ))

    # ── Bus results ──
    bus_results = {}
    for bus in buses:
        i = bus_idx[bus.id]
        v_kv = bus.props.get("voltage_kv", 11)
        # Busbar through-power: outgoing branch flows + the local load it
        # serves (zero for de-energized buses — their load is unserved)
        s_th = (s_through[i] + complex(bus_load_p_mw[i], bus_load_q_mvar[i])
                if i not in dispatch["dead_idx"] else complex(0, 0))
        bus_results[bus.id] = LoadFlowBus(
            bus_id=bus.id,
            bus_name=bus.props.get("name", bus.id),
            voltage_pu=round(abs(V[i]), 6),
            voltage_kv=round(abs(V[i]) * v_kv, 4),
            angle_deg=round(math.degrees(np.angle(V[i])), 4),
            p_mw=round(S_bus[i].real * base_mva, 4),
            q_mvar=round(S_bus[i].imag * base_mva, 4),
            energized=i not in dispatch["dead_idx"],
            p_through_mw=round(s_th.real, 4),
            q_through_mvar=round(s_th.imag, 4),
        )

    # ── Source-connected transformers (one bus end, one source end) ──
    # Transformers whose HV side connects to a utility/generator (not a bus) are
    # skipped by the bus-to-bus chain logic above, so their loading is never computed.
    # We handle them here: find the single connected bus, then split the bus's
    # total source injection equally among all active source-connected transformers
    # at that bus (handles the case of parallel utility + generator incomer TXs).
    processed_elem_ids = {eid for chain_key in processed_chains for eid in chain_key}

    # Map bus_id -> list of active source-connected transformer components
    source_tx_by_bus: dict[str, list] = {}
    for comp in project.components:
        if comp.type != "transformer" or comp.id in processed_elem_ids:
            continue
        results = _find_bus_paths(comp.id, adjacency, components, bus_of)
        if len(results) != 1:
            continue  # 0 buses (isolated) or 2 buses (already handled above)
        bus_id = results[0][0]
        source_tx_by_bus.setdefault(bus_id, []).append(comp)

    # Detect which source-connected TXs connect to a utility source.
    # Walk from each TX away from the bus to find what's on the other side.
    _utility_tx_bus_map: dict[str, list] = {}  # bus_id -> [(tx_comp, util_comp)]
    _utility_tx_ids = set()
    for bus_id, tx_list in source_tx_by_bus.items():
        for tx in tx_list:
            visited_src = set()
            for cid, mapped in bus_of.items():
                if mapped == bus_id:
                    visited_src.add(cid)
            visited_src.add(tx.id)
            src_queue = [nb for nb in adjacency.get(tx.id, []) if nb not in visited_src]
            util_found = None
            while src_queue and not util_found:
                nid = src_queue.pop(0)
                if nid in visited_src:
                    continue
                visited_src.add(nid)
                c = components.get(nid)
                if not c:
                    continue
                if c.type == "utility":
                    util_found = c
                elif _is_transparent_and_closed(c):
                    for nb in adjacency.get(nid, []):
                        if nb not in visited_src:
                            src_queue.append(nb)
            if util_found:
                _utility_tx_bus_map.setdefault(bus_id, []).append((tx, util_found))
                _utility_tx_ids.add(tx.id)

    # Non-utility source-connected TXs (generator incomers, etc.)
    for bus_id, tx_list in source_tx_by_bus.items():
        non_util_txs = [tx for tx in tx_list if tx.id not in _utility_tx_ids]
        if not non_util_txs:
            continue
        bus_i = bus_idx[bus_id]
        n_sources = len(non_util_txs)
        s_net_pu = S_bus[bus_i] - complex(P_spec[bus_i], Q_spec[bus_i])
        s_net_mva = abs(s_net_pu) * base_mva
        s_per_tx = s_net_mva / n_sources if n_sources > 0 else 0
        p_per_tx = (s_net_pu.real * base_mva) / n_sources if n_sources > 0 else 0
        q_per_tx = (s_net_pu.imag * base_mva) / n_sources if n_sources > 0 else 0

        for tx in non_util_txs:
            rated_mva_xfmr = tx.props.get("rated_mva", 10)
            loading = (s_per_tx / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0
            lv_kv = min(
                tx.props.get("voltage_hv_kv", 11),
                tx.props.get("voltage_lv_kv", 0.42)
            )
            elem_i_amps = (s_per_tx * 1000) / (math.sqrt(3) * lv_kv) if lv_kv > 0 else 0
            source_side = _find_source_side_neighbor(tx.id, bus_id, adjacency, bus_of)
            branch_results.append(LoadFlowBranch(
                elementId=tx.id,
                element_name=tx.props.get("name", tx.type),
                from_bus=source_side, to_bus=bus_id,
                p_mw=round(p_per_tx, 4), q_mvar=round(q_per_tx, 4),
                s_mva=round(s_per_tx, 4), i_amps=round(elem_i_amps, 2),
                loading_pct=round(loading, 2), losses_mw=0,
            ))

    # ── Source output annotations ──
    #
    # SOURCE MODEL — PROPORTIONAL LOAD SHARING (DROOP)
    # ──────────────────────────────────────────────────
    # On a swing bus, S_bus = total injection the bus must provide to the network.
    # ALL sources at that bus (generators + utility TX) share S_bus proportionally
    # by their rated MVA.  This models droop-based load sharing and gives uniform
    # loading across all sources connected to the bus.
    #
    # When utility is directly connected (infinite bus): generators at rated,
    # utility absorbs/supplies the residual (standard swing model).
    #
    # On non-swing PQ buses: NR enforces P_spec → generators at scheduled output.
    _SOURCE_TYPES = {"generator", "solar_pv", "wind_turbine"}

    for bus in buses:
        bus_i = bus_idx[bus.id]
        v_kv_actual = abs(V[bus_i]) * bus.props.get("voltage_kv", 11)
        is_swing = (bus_types[bus_i] == 2)
        has_utility = bus.id in _utility_bus_ids
        has_utility_via_tx = bus.id in _utility_tx_bus_map

        all_at_bus = _find_components_at_bus(bus.id, adjacency, components)
        gen_sources = [s for s in all_at_bus if s.type in _SOURCE_TYPES]
        util_sources = [s for s in all_at_bus if s.type == "utility"]

        # ── Swing bus: attribute each merit-dispatched source its dispatched
        # output; the residual (remainder + losses) is shared among the
        # balancing entries (utility TX / balancer generators) by rating ──
        if is_swing and gen_sources:
            # Total demand on this bus's sources: network injection plus the
            # local load, which NR's slack accounting cannot see (local P/Q
            # specs are ignored at the swing bus).
            s_actual = (S_bus[bus_i] * base_mva
                        + complex(bus_load_p_mw[bus_i], bus_load_q_mvar[bus_i]))

            dispatched_here = []  # (src, p_mw, q_mvar)
            source_pool = []      # residual sharers: (kind, object(s), rated_mva)
            for src in gen_sources:
                if src.id in dispatch["dispatched_by_comp"]:
                    p_d, q_d = dispatch["dispatched_by_comp"][src.id]
                    dispatched_here.append((src, p_d, q_d))
                else:
                    _p, _q, s_rated, rated_mva = _source_output_mva(src)
                    source_pool.append(('gen', src, rated_mva))

            if has_utility_via_tx and not has_utility:
                # Utility behind TX: TX rating limits utility contribution
                for tx, util in _utility_tx_bus_map[bus.id]:
                    tx_rated = tx.props.get("rated_mva", 10)
                    source_pool.append(('util_tx', (tx, util), tx_rated))

            s_residual = s_actual - complex(
                sum(p for _s, p, _q in dispatched_here),
                sum(q for _s, _p, q in dispatched_here))
            total_pool_mva = sum(entry[2] for entry in source_pool)

            for src, p_out, q_out in dispatched_here:
                _p, _q, _s, rated_mva = _source_output_mva(src)
                s_out = math.hypot(p_out, q_out)
                loading = (s_out / rated_mva * 100) if rated_mva > 0 else 0
                i_amps = (s_out * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=src.id,
                    element_name=src.props.get("name", src.type),
                    from_bus=src.id, to_bus=bus.id,
                    p_mw=round(p_out, 4), q_mvar=round(q_out, 4),
                    s_mva=round(s_out, 4), i_amps=round(i_amps, 2),
                    loading_pct=round(loading, 2), losses_mw=0,
                ))

            for kind, obj, rated_mva in source_pool:
                if total_pool_mva <= 0 or rated_mva <= 0:
                    continue
                fraction = rated_mva / total_pool_mva
                p_out = s_residual.real * fraction
                q_out = s_residual.imag * fraction
                s_out = abs(s_residual) * fraction
                loading = s_out / rated_mva * 100

                if kind == 'gen':
                    src = obj
                    i_amps = (s_out * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                    branch_results.append(LoadFlowBranch(
                        elementId=src.id,
                        element_name=src.props.get("name", src.type),
                        from_bus=src.id, to_bus=bus.id,
                        p_mw=round(p_out, 4), q_mvar=round(q_out, 4),
                        s_mva=round(s_out, 4), i_amps=round(i_amps, 2),
                        loading_pct=round(loading, 2), losses_mw=0,
                    ))
                elif kind == 'util_tx':
                    tx, util = obj
                    # Utility TX annotation
                    lv_kv = min(tx.props.get("voltage_hv_kv", 11),
                                tx.props.get("voltage_lv_kv", 0.42))
                    tx_i_amps = (s_out * 1000) / (math.sqrt(3) * lv_kv) if lv_kv > 0 else 0
                    branch_results.append(LoadFlowBranch(
                        elementId=tx.id,
                        element_name=tx.props.get("name", tx.type),
                        from_bus=util.id, to_bus=bus.id,
                        p_mw=round(p_out, 4), q_mvar=round(q_out, 4),
                        s_mva=round(s_out, 4), i_amps=round(tx_i_amps, 2),
                        loading_pct=round(loading, 2), losses_mw=0,
                    ))
                    # Utility source annotation
                    util_base = _utility_loading_base_mva(util)
                    util_loading = (s_out / util_base * 100) if util_base > 0 else 0
                    util_i_amps = (s_out * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                    branch_results.append(LoadFlowBranch(
                        elementId=util.id,
                        element_name=util.props.get("name", "Utility"),
                        from_bus=util.id, to_bus=bus.id,
                        p_mw=round(p_out, 4), q_mvar=round(q_out, 4),
                        s_mva=round(s_out, 4), i_amps=round(util_i_amps, 2),
                        loading_pct=round(util_loading, 2), losses_mw=0,
                    ))

            # Track actual gen output for direct-utility residual calc
            gen_pool_mva = sum(e[2] for e in source_pool if e[0] == 'gen')
            _gen_share = gen_pool_mva / total_pool_mva if total_pool_mva > 0 else 0
            _gen_actual_p = (sum(p for _s, p, _q in dispatched_here)
                             + s_residual.real * _gen_share)
            _gen_actual_q = (sum(q for _s, _p, q in dispatched_here)
                             + s_residual.imag * _gen_share)

        elif gen_sources:
            # Non-swing bus: NR enforces P_spec → sources sit at their
            # dispatched output (full available for must_run, merit-order
            # allocation otherwise).
            for src in gen_sources:
                _p, _q, s_rated, rated_mva = _source_output_mva(src)
                if rated_mva <= 0:
                    continue
                _p, _q = dispatch["dispatched_by_comp"].get(src.id, (_p, _q))
                s_disp = math.hypot(_p, _q)
                i_amps = (s_disp * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=src.id,
                    element_name=src.props.get("name", src.type),
                    from_bus=src.id, to_bus=bus.id,
                    p_mw=round(_p, 4), q_mvar=round(_q, 4),
                    s_mva=round(s_disp, 4), i_amps=round(i_amps, 2),
                    loading_pct=round(s_disp / rated_mva * 100, 2), losses_mw=0,
                ))

        # ── Utility source annotations (directly connected) ──
        if util_sources:
            s_bus_total = S_bus[bus_i] * base_mva
            # On the swing bus, NR ignores local P/Q specs: loads and source
            # injections at this bus are invisible to S_bus. The utility's
            # real output = network injection + local load − local generation,
            # otherwise PV serving a local load shows up as phantom utility
            # import/export.
            s_local_load = complex(bus_load_p_mw[bus_i], bus_load_q_mvar[bus_i]) \
                if is_swing else complex(0, 0)
            if gen_sources and is_swing:
                s_util = complex(s_bus_total.real + s_local_load.real - _gen_actual_p,
                                 s_bus_total.imag + s_local_load.imag - _gen_actual_q)
            elif gen_sources:
                gen_p_disp = sum(dispatch["dispatched_by_comp"].get(
                    s.id, _source_output_mva(s)[:2])[0] for s in gen_sources)
                gen_q_disp = sum(dispatch["dispatched_by_comp"].get(
                    s.id, _source_output_mva(s)[:2])[1] for s in gen_sources)
                s_util = complex(s_bus_total.real - gen_p_disp,
                                 s_bus_total.imag - gen_q_disp)
            else:
                s_util = s_bus_total + s_local_load

            for util in util_sources:
                util_base = _utility_loading_base_mva(util)
                s_out = abs(s_util)
                loading = (s_out / util_base * 100) if util_base > 0 else 0
                i_amps = (s_out * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=util.id,
                    element_name=util.props.get("name", "Utility"),
                    from_bus=util.id, to_bus=bus.id,
                    p_mw=round(s_util.real, 4), q_mvar=round(s_util.imag, 4),
                    s_mva=round(s_out, 4), i_amps=round(i_amps, 2),
                    loading_pct=round(loading, 2), losses_mw=0,
                ))

        # ── Utility behind TX (no generators at this bus) ──
        # When there are no generators, the utility TX handles the full S_bus.
        # (When generators ARE present, utility TX is handled in the pool above.)
        if has_utility_via_tx and not gen_sources:
            s_bus_total = S_bus[bus_i] * base_mva
            # Same swing-bus correction as above: count the local load the
            # solver's slack accounting can't see.
            if is_swing:
                s_bus_total += complex(bus_load_p_mw[bus_i], bus_load_q_mvar[bus_i])
            tx_util_list = _utility_tx_bus_map[bus.id]
            n_util_tx = len(tx_util_list)
            for tx, util in tx_util_list:
                s_this_tx = complex(s_bus_total.real / n_util_tx,
                                    s_bus_total.imag / n_util_tx)
                s_this_mva = abs(s_this_tx)

                rated_mva_xfmr = tx.props.get("rated_mva", 10)
                tx_loading = (s_this_mva / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0
                lv_kv = min(tx.props.get("voltage_hv_kv", 11),
                            tx.props.get("voltage_lv_kv", 0.42))
                tx_i_amps = (s_this_mva * 1000) / (math.sqrt(3) * lv_kv) if lv_kv > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=tx.id,
                    element_name=tx.props.get("name", tx.type),
                    from_bus=util.id, to_bus=bus.id,
                    p_mw=round(s_this_tx.real, 4), q_mvar=round(s_this_tx.imag, 4),
                    s_mva=round(s_this_mva, 4), i_amps=round(tx_i_amps, 2),
                    loading_pct=round(tx_loading, 2), losses_mw=0,
                ))

                util_base = _utility_loading_base_mva(util)
                util_loading = (s_this_mva / util_base * 100) if util_base > 0 else 0
                util_i_amps = (s_this_mva * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=util.id,
                    element_name=util.props.get("name", "Utility"),
                    from_bus=util.id, to_bus=bus.id,
                    p_mw=round(s_this_tx.real, 4), q_mvar=round(s_this_tx.imag, 4),
                    s_mva=round(s_this_mva, 4), i_amps=round(util_i_amps, 2),
                    loading_pct=round(util_loading, 2), losses_mw=0,
                ))

    # ── Voltage mismatch warnings ──
    # Check every device in transformer chains for incorrect voltage ratings.
    # Walk from each bus through transparent devices to find all components
    # on each side of the transformer and verify their voltage ratings.
    voltage_warnings = []
    voltage_warnings.extend(dispatch["warnings"])
    warned_ids = set()  # Avoid duplicate warnings for the same component
    tolerance = 0.15  # 15% mismatch threshold

    for elems, from_bus, to_bus, y, t, hv_bus, cvs in branch_chains:
        if elems is None or hv_bus is None:
            continue  # Skip bus links and non-transformer chains

        # Determine bus voltages for each side
        from_v = components[from_bus].props.get("voltage_kv", 0) if from_bus in components else 0
        to_v = components[to_bus].props.get("voltage_kv", 0) if to_bus in components else 0

        # Find the transformer to use as the walk boundary
        xfmr_id = None
        for eid, e in elems.items():
            if e.type == "transformer":
                xfmr_id = eid
                break
        if not xfmr_id:
            continue

        # Walk from each bus toward the transformer, collecting ALL components on that side
        for side_bus, expected_v in [(from_bus, from_v), (to_bus, to_v)]:
            if expected_v <= 0:
                continue
            visited = {side_bus}
            stack = list(adjacency.get(side_bus, []))
            while stack:
                nid = stack.pop()
                if nid in visited or nid == xfmr_id:
                    continue
                visited.add(nid)
                # Don't cross into another bus
                if nid in bus_idx and nid != side_bus:
                    continue
                comp = components.get(nid)
                if not comp:
                    continue

                # Check voltage property based on component type
                actual_v = 0
                if comp.type == "cable":
                    actual_v = comp.props.get("voltage_kv", 0)
                elif comp.type in ("cb", "switch", "fuse", "surge_arrester"):
                    actual_v = comp.props.get("rated_voltage_kv", 0)
                elif comp.type in ("ct", "pt"):
                    actual_v = comp.props.get("voltage_kv", 0)

                if actual_v > 0 and abs(actual_v - expected_v) / expected_v > tolerance and comp.id not in warned_ids:
                    warned_ids.add(comp.id)
                    voltage_warnings.append(LoadFlowWarning(
                        elementId=comp.id,
                        element_name=comp.props.get("name", comp.type),
                        message=f"Voltage mismatch: rated {actual_v} kV, expected {expected_v} kV from connected bus",
                        expected_kv=round(expected_v, 3),
                        actual_kv=round(actual_v, 3),
                    ))

                # Continue walking through chain elements and transparent devices
                if comp.id in elems or _is_transparent_and_closed(comp):
                    for neighbor in adjacency.get(nid, []):
                        if neighbor not in visited:
                            stack.append(neighbor)

    # ── Dispatch summary ──
    # Balancer (slack) sources: actual output = network injection at the
    # swing bus plus the local load it also serves, split proportionally by
    # rating when several balancers share a bus (droop, as in the annotations).
    # GENERATOR balancers are attributed ISLAND-wide instead (slack output =
    # Σ island net injections + island load − island dispatched injections):
    # their connection bus is not necessarily the island's swing bus (e.g. a
    # user-labelled Swing bus elsewhere), where the per-bus formula reads ~0.
    island_of = dispatch.get("island_of", {})
    balancer_entries = {}
    for entry in dispatch["entries"]:
        if entry["role"] == "balancer" and entry["bus_id"]:
            balancer_entries.setdefault(entry["bus_id"], []).append(entry)
    for bus_id, entries_at_bus in balancer_entries.items():
        bi = bus_idx[bus_id]
        inj = dispatch["injections"].get(bi, (0.0, 0.0))
        gen_balanced = all(e["source_type"] == "generator" for e in entries_at_bus)
        if gen_balanced:
            isl = island_of.get(bi)
            isl_buses = [i for i in range(len(buses)) if island_of.get(i) == isl]
            p_out = (sum(S_bus[i].real * base_mva + bus_load_p_mw[i] for i in isl_buses)
                     - sum(dispatch["injections"].get(i, (0.0, 0.0))[0] for i in isl_buses))
        else:
            p_out = S_bus[bi].real * base_mva + bus_load_p_mw[bi] - inj[0]
        n_bal = len(entries_at_bus)
        weights = []
        for entry in entries_at_bus:
            comp = components.get(entry["source_id"])
            if comp is not None and comp.type == "utility":
                weights.append(_utility_loading_base_mva(comp))
            elif comp is not None:
                weights.append(_source_output_mva(comp)[3] or 1.0)
            else:
                weights.append(1.0)
        w_total = sum(weights) or float(n_bal)
        for entry, w in zip(entries_at_bus, weights):
            entry["dispatched_mw"] = round(p_out * (w / w_total), 4)
            # Sync the canvas badge for generator balancers — the annotation
            # pass ran before this fill and fell back to rated output
            if entry["source_type"] == "generator":
                comp = components.get(entry["source_id"])
                rated = _source_output_mva(comp)[3] if comp is not None else 0
                pf = comp.props.get("power_factor", 0.85) if comp is not None else 0.85
                p_b = entry["dispatched_mw"]
                s_b = abs(p_b) / pf if pf > 0 else abs(p_b)
                for br in branch_results:
                    if br.elementId == entry["source_id"]:
                        br.p_mw = round(p_b, 4)
                        br.q_mvar = round(math.sqrt(max(0.0, s_b**2 - p_b**2)), 4)
                        br.s_mva = round(s_b, 4)
                        br.loading_pct = round(s_b / rated * 100, 2) if rated > 0 else 0
                        v_kv_b = comp.props.get("voltage_kv", 0.4) if comp is not None else 0.4
                        br.i_amps = round((s_b * 1000) / (math.sqrt(3) * v_kv_b), 2) if v_kv_b > 0 else 0
                        break
            # Utility supplying beyond its declared capacity → overload warning
            cap = entry["available_mw"]
            if (entry["source_type"] == "utility" and cap > 0
                    and entry["dispatched_mw"] > cap * 1.005):
                voltage_warnings.append(LoadFlowWarning(
                    elementId=entry["source_id"],
                    element_name=entry["source_name"],
                    message=(f"Utility '{entry['source_name']}' supplies "
                             f"{_fmt_power_mw(entry['dispatched_mw'])}, exceeding its "
                             f"supply capacity of {_fmt_power_mw(cap)} — consider "
                             "standby generation or load reduction."),
                ))

    dispatch_results = [DispatchEntry(**e) for e in dispatch["entries"]]

    return LoadFlowResults(
        buses=bus_results,
        branches=branch_results,
        warnings=voltage_warnings,
        converged=converged,
        iterations=iterations,
        method=method,
        dispatch=dispatch_results,
    )


def _newton_raphson(Y, P_spec, Q_spec, V_mag, bus_types):
    """Newton-Raphson power flow solver."""
    n = len(P_spec)
    V = np.array(V_mag, dtype=complex)
    theta = np.zeros(n)

    for iteration in range(MAX_ITERATIONS):
        # Calculate power mismatches
        P_calc = np.zeros(n)
        Q_calc = np.zeros(n)

        for i in range(n):
            for j in range(n):
                P_calc[i] += abs(V[i]) * abs(V[j]) * (
                    Y[i, j].real * math.cos(theta[i] - theta[j]) +
                    Y[i, j].imag * math.sin(theta[i] - theta[j])
                )
                Q_calc[i] += abs(V[i]) * abs(V[j]) * (
                    Y[i, j].real * math.sin(theta[i] - theta[j]) -
                    Y[i, j].imag * math.cos(theta[i] - theta[j])
                )

        # Mismatch vectors (exclude swing bus)
        dP = P_spec - P_calc
        dQ = Q_spec - Q_calc

        # Build index lists for non-swing buses
        pq_idx = [i for i in range(n) if bus_types[i] == 0]
        pv_idx = [i for i in range(n) if bus_types[i] == 1]
        non_swing = [i for i in range(n) if bus_types[i] != 2]

        # Check convergence
        mismatch = np.concatenate([dP[non_swing], dQ[pq_idx]])
        if len(mismatch) == 0 or np.max(np.abs(mismatch)) < TOLERANCE:
            V = np.array([abs(V[i]) * np.exp(1j * theta[i]) for i in range(n)])
            return V, True, iteration + 1

        # Build Jacobian
        n_eq = len(non_swing) + len(pq_idx)
        J = np.zeros((n_eq, n_eq))

        # J1: dP/dtheta, J2: dP/d|V|, J3: dQ/dtheta, J4: dQ/d|V|
        for ii, i in enumerate(non_swing):
            for jj, j in enumerate(non_swing):
                if i == j:
                    J[ii, jj] = -Q_calc[i] - abs(V[i])**2 * Y[i, i].imag
                else:
                    J[ii, jj] = abs(V[i]) * abs(V[j]) * (
                        Y[i, j].real * math.sin(theta[i] - theta[j]) -
                        Y[i, j].imag * math.cos(theta[i] - theta[j])
                    )

        for ii, i in enumerate(non_swing):
            for jj, j in enumerate(pq_idx):
                col = len(non_swing) + jj
                if i == j:
                    J[ii, col] = P_calc[i] / abs(V[i]) + abs(V[i]) * Y[i, i].real
                else:
                    J[ii, col] = abs(V[i]) * (
                        Y[i, j].real * math.cos(theta[i] - theta[j]) +
                        Y[i, j].imag * math.sin(theta[i] - theta[j])
                    )

        for ii, i in enumerate(pq_idx):
            row = len(non_swing) + ii
            for jj, j in enumerate(non_swing):
                if i == j:
                    J[row, jj] = P_calc[i] - abs(V[i])**2 * Y[i, i].real
                else:
                    J[row, jj] = -abs(V[i]) * abs(V[j]) * (
                        Y[i, j].real * math.cos(theta[i] - theta[j]) +
                        Y[i, j].imag * math.sin(theta[i] - theta[j])
                    )

        for ii, i in enumerate(pq_idx):
            row = len(non_swing) + ii
            for jj, j in enumerate(pq_idx):
                col = len(non_swing) + jj
                if i == j:
                    J[row, col] = Q_calc[i] / abs(V[i]) - abs(V[i]) * Y[i, i].imag
                else:
                    J[row, col] = abs(V[i]) * (
                        Y[i, j].real * math.sin(theta[i] - theta[j]) -
                        Y[i, j].imag * math.cos(theta[i] - theta[j])
                    )

        # Solve J * dx = mismatch
        try:
            dx = np.linalg.solve(J, mismatch)
        except np.linalg.LinAlgError:
            break

        # Update
        for ii, i in enumerate(non_swing):
            theta[i] += dx[ii]
        for ii, i in enumerate(pq_idx):
            V[i] = abs(V[i]) + dx[len(non_swing) + ii]

    # Rebuild complex V
    V = np.array([abs(V[i]) * np.exp(1j * theta[i]) for i in range(n)])
    return V, False, MAX_ITERATIONS


def _gauss_seidel(Y, P_spec, Q_spec, V_mag, bus_types):
    """Gauss-Seidel power flow solver."""
    n = len(P_spec)
    V = np.array(V_mag, dtype=complex)

    for iteration in range(MAX_ITERATIONS):
        V_old = V.copy()

        for i in range(n):
            if bus_types[i] == 2:  # Swing bus — fixed voltage
                continue

            # Sum Y[i,j] * V[j] for j != i
            sum_yv = sum(Y[i, j] * V[j] for j in range(n) if j != i)

            if bus_types[i] == 0:  # PQ bus
                S_spec = complex(P_spec[i], Q_spec[i])
                if abs(V[i]) > 1e-10:
                    V[i] = (1 / Y[i, i]) * (np.conj(S_spec) / np.conj(V[i]) - sum_yv)
            elif bus_types[i] == 1:  # PV bus
                # Q_i = Im{S_i} = Im{V_i · conj(Σ_j Y_ij V_j)} — same sign
                # convention as the NR Q_calc (G·sinθ − B·cosθ form).
                # (A leading minus here would require conj(V_i)·I_i, not
                # V_i·conj(I_i), and reverses the PV reactive injection.)
                Q_calc = (V[i] * np.conj(sum_yv + Y[i, i] * V[i])).imag
                S_spec = complex(P_spec[i], Q_calc)
                if abs(V[i]) > 1e-10:
                    V[i] = (1 / Y[i, i]) * (np.conj(S_spec) / np.conj(V[i]) - sum_yv)
                # Fix voltage magnitude
                V[i] = V_mag[i] * V[i] / abs(V[i])

        # Check convergence
        diff = np.abs(V - V_old)
        max_diff = np.max(diff) if len(diff) > 0 else 0.0
        if max_diff < TOLERANCE:
            return V, True, iteration + 1

    return V, False, MAX_ITERATIONS


def _utility_admittance(comp, base_mva):
    """Utility source admittance."""
    fault_mva = comp.props.get("fault_mva", 500)
    xr = comp.props.get("x_r_ratio", 15)
    z_pu = base_mva / fault_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    z = complex(r_pu, x_pu)
    return 1 / z if abs(z) > 1e-15 else complex(0, 0)
