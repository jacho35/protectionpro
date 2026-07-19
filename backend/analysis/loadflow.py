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

# On a *converged* solve, an energized bus below this per-unit voltage is not a
# credible operating point — normal networks run ~0.9–1.1 p.u., and even a badly
# sagging weak feeder stays well above this. A converged solution this low is
# almost always the low-voltage/collapse root (the lower P-V branch) or an
# infeasible operating point that Newton-Raphson happened to settle into, and
# must not be presented as a valid answer. Set conservatively low to avoid
# flagging legitimately weak-but-operable buses.
V_IMPLAUSIBLE_PU = 0.5

# Newton-Raphson Jacobian condition-number ceiling. A well-posed power-flow
# Jacobian is well-conditioned (cond ~ 1e1–1e4); it blows up towards ∞ only when
# the system is structurally singular (a subnetwork with no voltage reference)
# or sitting on the voltage-collapse boundary (the P-V nose). Past this ceiling
# the linear solve is numerical garbage, so we stop and report a singular
# Jacobian rather than stepping on a meaningless dx or letting np.linalg.solve
# raise an unhandled LinAlgError. Set far above any well-posed network.
JACOBIAN_COND_LIMIT = 1e12

# Components that are "transparent" — zero impedance pass-through
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}


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
    start_path = [start_comp] if start_comp and start_comp.type in ("cable", "transformer", "autotransformer") else []

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
        elif comp.type in ("cable", "transformer", "autotransformer"):
            new_path = path + [comp]
            for neighbor in adjacency.get(nid, []):
                if neighbor not in visited:
                    queue.append((neighbor, new_path))
        # else: blocked (open CB or unknown component type)

    return found


def _bus_via_port(comp_id, port_id, adjacency_ports, adjacency, components, bus_of):
    """Return the bus-group id reachable from a specific port of a component,
    walking through transparent closed devices. None if no bus is found.

    Used to orient a standalone cable branch by its drawn ports so the reported
    from→to direction is deterministic (rather than depending on graph-walk
    order), matching the frontend's port-based direction display."""
    visited = {comp_id}
    queue = list(adjacency_ports.get((comp_id, port_id), []))
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in bus_of:
            return bus_of[nid]
        comp = components.get(nid)
        if not comp:
            continue
        if _is_transparent_and_closed(comp):
            for neighbor in adjacency.get(nid, []):
                if neighbor not in visited:
                    queue.append(neighbor)
    return None


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


# ── Implicit load-terminal buses ─────────────────────────────────────
# A load (motor, static load, capacitor bank) wired to the network only
# through a series element (cable/transformer) has no busbar at its own
# terminal. The solver gathers loads by walking out from each bus through
# TRANSPARENT devices only, so such a load is never attached to any bus and
# silently vanishes from the solve — and the cable feeding it, reaching just
# one bus, is dropped as a branch too. Drawing a bus between the load and its
# cable fixes it, so we synthesise exactly that node here, transparently.
SYNTHETIC_BUS_PREFIX = "__term__"
LOAD_TERMINAL_TYPES = {"motor_induction", "motor_synchronous",
                       "static_load", "capacitor_bank", "vfd", "svc"}


def is_synthetic_bus(bus_id):
    """True if bus_id is an auto-inserted load-terminal node."""
    return bool(bus_id) and bus_id.startswith(SYNTHETIC_BUS_PREFIX)


def _load_reaches_bus(load_id, adjacency, components):
    """True if a bus is reachable from a load through transparent devices only."""
    visited = {load_id}
    stack = list(adjacency.get(load_id, []))
    while stack:
        nid = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        comp = components.get(nid)
        if not comp:
            continue
        if comp.type in ("bus", "distribution_board"):
            return True
        if _is_transparent_and_closed(comp):
            for nb in adjacency.get(nid, []):
                if nb not in visited:
                    stack.append(nb)
    return False


def insert_implicit_load_buses(project: ProjectData) -> ProjectData:
    """Return a copy of *project* with a synthetic terminal bus inserted at
    every dangling load — one wired to the rest of the network only through a
    series cable/transformer, with no busbar of its own.

    Idempotent: a load that already reaches a bus (directly or through a
    CB/switch) is left untouched, so well-modelled projects and repeated calls
    are unchanged. Synthetic buses carry an id prefix (see SYNTHETIC_BUS_PREFIX)
    so callers can strip them from user-facing output.
    """
    import json
    components = {c.id: c for c in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    dangling = []
    for c in project.components:
        if c.type not in LOAD_TERMINAL_TYPES:
            continue
        if str(c.props.get("system", "ac")).lower() == "dc":
            continue  # DC loads belong to the DC solver
        if not adjacency.get(c.id):
            continue  # truly isolated — nothing to attach
        if _load_reaches_bus(c.id, adjacency, components):
            continue  # already has a terminal bus
        dangling.append(c)

    if not dangling:
        return project

    data = json.loads(project.model_dump_json())
    wires = data["wires"]
    for load in dangling:
        syn_id = f"{SYNTHETIC_BUS_PREFIX}{load.id}"
        # Terminal voltage base: the load's own rating, else a series
        # neighbour's rating, else an LV default.
        v_kv = load.props.get("voltage_kv")
        if not v_kv:
            for nb in adjacency.get(load.id, []):
                nc = components.get(nb)
                if nc and nc.type in ("cable", "transformer", "autotransformer"):
                    v_kv = nc.props.get("voltage_lv_kv") or nc.props.get("voltage_kv")
                    if v_kv:
                        break
        # Rewire: the load hangs off the new bus, and everything the load used
        # to touch now hangs off the new bus instead (load → syn → cable → …).
        load_port = "in"
        for w in wires:
            if w["fromComponent"] == load.id:
                load_port = w.get("fromPort", "in")
                w["fromComponent"], w["fromPort"] = syn_id, "at_0"
            elif w["toComponent"] == load.id:
                load_port = w.get("toPort", "in")
                w["toComponent"], w["toPort"] = syn_id, "at_0"
        wires.append({
            "id": f"{SYNTHETIC_BUS_PREFIX}w_{load.id}",
            "fromComponent": load.id, "fromPort": load_port,
            "toComponent": syn_id, "toPort": "at_0",
        })
        data["components"].append({
            "id": syn_id, "type": "bus", "x": load.x, "y": load.y, "rotation": 0,
            "props": {
                "name": f"{load.props.get('name', load.id)} terminal",
                "voltage_kv": float(v_kv or 0.4),
                "bus_type": "PQ", "system": "ac",
                "synthetic": True,
            },
        })

    return ProjectData(**data)


# ── Three-winding autotransformer expansion ─────────────────────────────


THREE_WINDING_STAR_PREFIX = "__at3w__"


def _neighbor_on_port(comp_id, port, wires):
    """Return (neighbor_component_id, neighbor_port) wired to comp_id's port."""
    for w in wires:
        if w.get("fromComponent") == comp_id and w.get("fromPort") == port:
            return w.get("toComponent"), w.get("toPort")
        if w.get("toComponent") == comp_id and w.get("toPort") == port:
            return w.get("fromComponent"), w.get("fromPort")
    return None, None


def _star_impedances_pct(z_hl, z_ht, z_lt):
    """Star (T) equivalent leg impedances from the three measured pair
    short-circuit impedances (all % on the same base). Standard three-winding
    transformer decomposition — a leg may be negative, which is physical."""
    z_h = 0.5 * (z_hl + z_ht - z_lt)
    z_l = 0.5 * (z_hl + z_lt - z_ht)
    z_t = 0.5 * (z_ht + z_lt - z_hl)
    return z_h, z_l, z_t


def _expand_three_winding(project: ProjectData) -> ProjectData:
    """Replace each fully-wired 3-winding autotransformer with an internal star
    node and three equivalent two-winding transformer legs, so the standard
    load-flow branch machinery (which already models two-winding transformers)
    handles it unchanged.

    Idempotent: after expansion no ``windings == 3`` autotransformer remains, so
    a second call is a no-op. A 3-winding unit whose tertiary port is unwired is
    left alone (it then behaves as an ordinary HV–LV branch)."""
    import json

    targets = []
    for c in project.components:
        if c.type != "autotransformer":
            continue
        if int(c.props.get("windings", 2) or 2) != 3:
            continue
        targets.append(c)
    if not targets:
        return project

    data = json.loads(project.model_dump_json())
    wires = data["wires"]
    comps = data["components"]

    for at in targets:
        prim = _neighbor_on_port(at.id, "primary", wires)
        sec = _neighbor_on_port(at.id, "secondary", wires)
        ter = _neighbor_on_port(at.id, "tertiary", wires)
        if not (prim[0] and sec[0] and ter[0]):
            continue  # tertiary (or another port) not wired — treat as 2-winding

        p = at.props
        rated = p.get("rated_mva", 20)
        xr = p.get("x_r_ratio", 30)
        v_hv = p.get("voltage_hv_kv", 132)
        v_lv = p.get("voltage_lv_kv", 66)
        v_tv = p.get("voltage_tv_kv", 11)
        z_h, z_l, z_t = _star_impedances_pct(
            float(p.get("z_percent", 8) or 0),
            float(p.get("z_ht_percent", 26) or 0),
            float(p.get("z_lt_percent", 16) or 0))
        tap = float(p.get("tap_percent", 0) or 0)
        star_id = f"{THREE_WINDING_STAR_PREFIX}{at.id}"

        # Remove the original autotransformer and its port wires.
        comps[:] = [c for c in comps if c["id"] != at.id]
        wires[:] = [w for w in wires
                    if w.get("fromComponent") != at.id and w.get("toComponent") != at.id]

        # Internal star node (voltage base = HV side; the pu leg impedances
        # already carry each winding's turns ratio).
        comps.append({
            "id": star_id, "type": "bus", "x": at.x, "y": at.y, "rotation": 0,
            "props": {"name": f"{p.get('name', at.id)} star", "voltage_kv": float(v_hv),
                      "bus_type": "PQ", "system": "ac", "synthetic": True},
        })

        def _leg(suffix, v_high, v_low, z_pct, tap_pct):
            return {
                "id": f"{THREE_WINDING_STAR_PREFIX}{at.id}_{suffix}",
                "type": "transformer", "x": at.x, "y": at.y, "rotation": 0,
                "props": {"name": f"{p.get('name', at.id)}-{suffix.upper()}",
                          "rated_mva": rated, "z_percent": z_pct, "x_r_ratio": xr,
                          "voltage_hv_kv": v_high, "voltage_lv_kv": v_low,
                          "tap_percent": tap_pct, "synthetic": True},
            }

        # HV leg carries the tap; star sits at HV base so H-leg is ~1:1(+tap).
        comps.append(_leg("h", v_hv, v_hv, z_h, tap))
        comps.append(_leg("l", v_hv, v_lv, z_l, 0.0))
        comps.append(_leg("t", v_hv, v_tv, z_t, 0.0))

        def _w(wid, fc, fp, tc, tp):
            wires.append({"id": wid, "fromComponent": fc, "fromPort": fp,
                          "toComponent": tc, "toPort": tp})

        hid = f"{THREE_WINDING_STAR_PREFIX}{at.id}_h"
        lid = f"{THREE_WINDING_STAR_PREFIX}{at.id}_l"
        tid = f"{THREE_WINDING_STAR_PREFIX}{at.id}_t"
        # primary-net — H — star — L — secondary-net ; star — T — tertiary-net
        _w(f"{hid}_p", prim[0], prim[1], hid, "primary")
        _w(f"{hid}_s", hid, "secondary", star_id, "at_0")
        _w(f"{lid}_p", star_id, "at_1", lid, "primary")
        _w(f"{lid}_s", lid, "secondary", sec[0], sec[1])
        _w(f"{tid}_p", star_id, "at_2", tid, "primary")
        _w(f"{tid}_s", tid, "secondary", ter[0], ter[1])

    return ProjectData(**data)


def _autotransformer_regulated_bus(at, adjacency, components, bus_of):
    """Return (regulated_bus_id, hv_bus_id) for a regulating 2-winding
    autotransformer, or (None, None) if it does not span two buses."""
    results = _find_bus_paths(at.id, adjacency, components, bus_of)
    if len(results) < 2:
        return None, None
    ba = results[0][0]
    bb = results[1][0]
    _t, hv = _get_chain_turns_ratio({at.id: at}, ba, bb, components)
    lv = bb if hv == ba else ba
    side = str(at.props.get("regulated_side", "lv") or "lv").lower()
    return (hv if side == "hv" else lv), hv


def _run_oltc(project: ProjectData, method: str, regulators, max_passes: int = 12) -> ProjectData:
    """Iterate the on-load tap changer of each regulating autotransformer to
    hold its regulated bus at the target voltage. Mutates and returns a working
    copy of *project* with the converged tap positions; each pass re-solves the
    load flow with regulation disabled to read the controlled voltages."""
    import json
    work = ProjectData(**json.loads(project.model_dump_json()))

    components = {c.id: c for c in work.components}
    adjacency = {}
    for w in work.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)
    buses = [c for c in work.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
    bus_idx = {b.id: i for i, b in enumerate(buses)}
    bus_of = _build_bus_groups(buses, adjacency, components, bus_idx)

    reg_info = []
    for at in regulators:
        reg_bus, hv_bus = _autotransformer_regulated_bus(at, adjacency, components, bus_of)
        if reg_bus is not None:
            reg_info.append((at.id, reg_bus))
    if not reg_info:
        return work

    for _pass in range(max_passes):
        res = run_load_flow(work, method, include_synthetic=True, _regulate=False)
        changed = False
        for at_id, reg_bus in reg_info:
            at = next(c for c in work.components if c.id == at_id)
            vb = (res.buses or {}).get(reg_bus)
            if not vb or getattr(vb, "energized", True) is False:
                continue
            v = abs(vb.voltage_pu)
            target = float(at.props.get("v_target_pu", 1.0) or 1.0)
            step = abs(float(at.props.get("tap_step_pct", 1.25) or 1.25)) or 1.25
            tmin = float(at.props.get("tap_min_pct", -10) or -10)
            tmax = float(at.props.get("tap_max_pct", 10) or 10)
            tap = float(at.props.get("tap_percent", 0) or 0)
            side = str(at.props.get("regulated_side", "lv") or "lv").lower()
            deadband = step / 200.0            # half a tap step, in per-unit
            if abs(v - target) <= deadband:
                continue
            # Tap is on the HV winding: raising it lowers the LV voltage.
            raise_v = v < target
            direction = -1 if raise_v else 1
            if side == "hv":
                direction = -direction
            desired = tap + direction * step
            desired = max(tmin, min(tmax, desired))
            if abs(desired - tap) > 1e-9:
                at.props["tap_percent"] = round(desired, 4)
                changed = True
        if not changed:
            break

    return work


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

DEFAULT_DISPATCH_PRIORITY = {"solar_pv": 1, "wind_turbine": 1, "generator": 2,
                             "utility": 3, "battery": 1}
_BALANCER_TYPE_RANK = {"utility": 3, "generator": 2, "wind_turbine": 1,
                       "solar_pv": 0, "battery": 1}
DISPATCHABLE_SOURCE_TYPES = ("generator", "solar_pv", "wind_turbine")


def _battery_params(comp):
    """Normalized storage parameters for a BESS or a hybrid solar_pv.

    Battery power is AC-side and inverter-limited: a standalone BESS by its
    rated_kva; a DC-coupled hybrid's discharge by the inverter headroom the
    PV output leaves (charging from PV/grid uses the full inverter rating).
    A snapshot solve has no time axis, so state of charge only GATES
    charge/discharge (above the DoD reserve floor / below 100%), it does not
    scale power. Returns None when the component has no battery.
    """
    p = comp.props
    if comp.type == "battery":
        kwh = float(p.get("battery_kwh", 200) or 0)
        inverter_mva = float(p.get("rated_kva", 100) or 0) / 1000
        headroom_mva = inverter_mva
    elif comp.type == "solar_pv" and str(p.get("inverter_type", "")) == "hybrid":
        kwh = float(p.get("battery_kwh", 0) or 0)
        _pp, _qq, s_now, rated_full = _source_output_mva(comp)
        inverter_mva = rated_full
        headroom_mva = max(0.0, rated_full - s_now)
    else:
        return None
    if kwh <= 0 or inverter_mva <= 0:
        return None
    mode = str(p.get("battery_mode", "auto") or "auto")
    if mode not in ("auto", "charging", "discharging", "idle"):
        mode = "auto"
    dod = min(100.0, max(0.0, float(p.get("battery_dod_pct", 90) or 0)))
    soc = min(100.0, max(0.0, float(p.get("battery_soc_pct", 100) or 100)))
    max_ch = float(p.get("battery_max_charge_kw", 0) or 0) / 1000
    max_dis = float(p.get("battery_max_discharge_kw", 0) or 0) / 1000
    avail_kwh = kwh * max(0.0, soc - (100.0 - dod)) / 100.0
    return {
        "mode": mode,
        "max_charge_mw": min(max_ch, inverter_mva),
        "max_discharge_mw": min(max_dis, headroom_mva),
        "can_charge": soc < 100.0 - 1e-9 and max_ch > 0,
        "can_discharge": avail_kwh > 1e-9 and max_dis > 0,
        "available_kwh": avail_kwh,
    }


def _battery_is_grid_forming(comp):
    """A storage unit anchors an island (may act as slack) only when the user
    explicitly set it to discharge — 'auto' is grid-following self-consumption."""
    bp = _battery_params(comp)
    return bool(bp and bp["mode"] == "discharging" and bp["can_discharge"])


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


def _gen_max_load_mw(comp):
    """Maximum running load for a generator, MW (dispatch ceiling).

    Caps how heavily a set is loaded — e.g. to hold spinning reserve or
    respect a site derating. Settable via max_load_pct; the absent field
    (or 100) means no cap (legacy-identical). Returns +inf for non-generators
    so the merit/standby loops can apply it unconditionally. Note this ceiling
    binds only on dispatched (merit/must-run/standby) sets — an island-slack
    generator carries the residual set by the solve, not this plan."""
    if comp.type != "generator":
        return float("inf")
    try:
        pct = float(comp.props.get("max_load_pct", 100) or 100)
    except (TypeError, ValueError):
        pct = 100.0
    pct = max(0.0, min(100.0, pct))
    if pct >= 100.0:
        return float("inf")   # no cap — keep legacy behaviour byte-identical
    rated = comp.props.get("rated_mva", 10)
    pf = comp.props.get("power_factor", 0.85)
    return rated * pf * pct / 100.0


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
            if (comp.type in DISPATCHABLE_SOURCE_TYPES or comp.type == "utility"
                    or comp.type == "battery"):
                direct_src_bus.setdefault(comp.id, bus_idx[bus.id])

    island_sources = {}   # island -> list of (comp, bus_index, direct)
    for comp in project.components:
        if comp.type == "battery" and not _battery_is_grid_forming(comp):
            continue  # auto/charging/idle storage never anchors an island
        if (comp.type not in DISPATCHABLE_SOURCE_TYPES and comp.type != "utility"
                and comp.type != "battery"):
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

    # ── Locate storage units (BESS + hybrid solar_pv batteries) per island ──
    island_batts = {}   # island -> list of (comp, bus_index, params)
    for comp in project.components:
        if comp.type not in ("battery", "solar_pv"):
            continue
        bp = _battery_params(comp)
        if not bp or bp["mode"] == "idle":
            continue
        if comp.id in direct_src_bus:
            bi = direct_src_bus[comp.id]
        else:
            conn = _source_connection_bus(comp, adjacency, components, bus_idx)
            if conn is None:
                continue  # disconnected (e.g. behind an open CB)
            bi = bus_idx[conn]
        island_batts.setdefault(island_of[bi], []).append((comp, bi, bp))

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

        # ── Battery storage pass (BESS + hybrid PV batteries) ──
        # Resolved BEFORE generator commitment and merit dispatch so both see
        # the storage-adjusted demand:
        #   charging    — draws from the bus (grid/PV charges the battery)
        #   discharging — fixed injection, applied after the plan loop
        #                 (a balancer battery is skipped — slack covers it)
        #   auto        — self-consumption: discharges into the island's
        #                 renewable shortfall, else charges from the surplus
        isl_batts = island_batts.get(isl, [])
        batt_charge = []      # (comp, bus_index, p_mw drawn, params)
        batt_discharge = []   # (comp, bus_index, p_mw injected, params)
        if isl_batts:
            renewable_avail_mw = sum(
                _source_output_mva(c)[0] for c, _bi, d in sources
                if d and c.type in ("solar_pv", "wind_turbine"))
            deficit = max(0.0, demand_mw - renewable_avail_mw)
            surplus = max(0.0, renewable_avail_mw - demand_mw)
            for comp, bi, bp in isl_batts:
                if bp["mode"] == "charging" and bp["can_charge"]:
                    batt_charge.append((comp, bi, bp["max_charge_mw"], bp))
                elif bp["mode"] == "discharging" and bp["can_discharge"]:
                    batt_discharge.append((comp, bi, bp["max_discharge_mw"], bp))
                elif bp["mode"] == "auto":
                    if deficit > 1e-9 and bp["can_discharge"]:
                        p = min(bp["max_discharge_mw"], deficit)
                        deficit -= p
                        if p > 1e-9:
                            batt_discharge.append((comp, bi, p, bp))
                    elif surplus > 1e-9 and bp["can_charge"]:
                        p = min(bp["max_charge_mw"], surplus)
                        surplus -= p
                        if p > 1e-9:
                            batt_charge.append((comp, bi, p, bp))
            # Charging is extra island demand; renewables then serve it
            # instead of being curtailed, or the balancer imports it
            for _c, _bi, p, _bp in batt_charge:
                demand_mw += p

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
            batt_mw = sum(p for _c, _bi, p, _bp in batt_discharge)
            gen_borne = max(0.0, demand_mw - renewable_mw - batt_mw)
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

        # ── Droop parallel load-sharing (islanded synchronous gensets) ──
        # With no utility to hold the island, two or more droop-controlled
        # generators run in parallel and share the load in proportion to their
        # ratings — the physical behaviour of governor droop, and what the
        # 'droop' control scheme has always promised. (The 'sequential' scheme
        # handled above instead fills one set before starting the next.)
        # Without this, the engine nominated a single slack machine and loaded
        # it up to its full rating first, so the reference set could show a
        # false overload while a parallel set sat lightly loaded.
        #
        # Committed sets each carry a fixed share proportional to rating; the
        # reference (slack) set carries its own share plus the network losses
        # via the solve. Sets are committed in dispatch-priority order until the
        # committed capacity covers the genset-borne demand, so a lightly-loaded
        # island doesn't parallel more sets than it needs (a must-run set is
        # always committed). This reuses the seq_* plan variables the sequential
        # scheme feeds — it is mutually exclusive with sequential (only runs when
        # no sequential set has already claimed the balancer).
        droop_share = {}   # comp_id -> proportional MW share (only when ≥2 run)
        if seq_balancer_entry is None and not utilities:
            droop_gens = [(c, bi, d) for c, bi, d in sources
                          if c.type == "generator" and d
                          and _gen_control(c) != "sequential"]
            if len(droop_gens) >= 2:
                renewable_mw = sum(
                    _source_output_mva(c)[0] for c, _bi, dd in sources
                    if dd and c.type in ("solar_pv", "wind_turbine"))
                batt_mw = sum(p for _c, _bi, p, _bp in batt_discharge)
                gen_borne = max(0.0, demand_mw - renewable_mw - batt_mw)
                # Reference set (always committed): highest priority, then
                # largest — it holds the island frequency and has the most
                # headroom to absorb the losses on top of its share. Additional
                # sets parallel in, most-preferred first, only while the running
                # capacity can't yet cover the demand — so a lightly-loaded
                # island runs a single set rather than paralleling needlessly.
                # A must-run set is always committed.
                ref = max(droop_gens, key=_balancer_key)
                ordered = [ref] + sorted(
                    [e for e in droop_gens if e[0].id != ref[0].id],
                    key=_balancer_key, reverse=True)
                committed, off, cap = [], [], 0.0
                for entry in ordered:
                    forced = _dispatch_mode(entry[0]) == "must_run"
                    if not committed or forced or cap < gen_borne - 1e-9:
                        committed.append(entry)
                        cap += _source_output_mva(entry[0])[0]
                    else:
                        off.append(entry)
                # Only engage proportional sharing when ≥2 sets actually run;
                # a single committed set falls through to the ordinary
                # single-balancer path (and any surplus set is left off there).
                if len(committed) >= 2:
                    share_base = sum(_source_output_mva(c)[0]
                                     for c, _b, _d in committed)
                    seq_balancer_entry = ref
                    seq_fixed = [e for e in committed if e[0].id != ref[0].id]
                    seq_off = off
                    for c, _b, _d in committed:
                        rated = _source_output_mva(c)[0]
                        droop_share[c.id] = (gen_borne * rated / share_base
                                             if share_base > 0 else 0.0)
                    for c, _b, _d in seq_fixed:
                        seq_fixed_target[c.id] = droop_share[c.id]
                    shared = ", ".join(
                        f"'{c.props.get('name', c.id)}' {_fmt_power_mw(droop_share[c.id])}"
                        for c, _b, _d in committed)
                    warnings.append(LoadFlowWarning(
                        elementId=ref[0].id,
                        element_name=str(ref[0].props.get("name", "generator")),
                        message=(f"Droop parallel operation — island load shared "
                                 f"in proportion to rating across {shared} (the "
                                 "reference set also carries the network losses)."),
                    ))
                    if seq_off:
                        held = ", ".join(f"'{e[0].props.get('name', e[0].id)}'"
                                         for e in seq_off)
                        warnings.append(LoadFlowWarning(
                            elementId=seq_off[0][0].id,
                            element_name=str(seq_off[0][0].props.get("name", "generator")),
                            message=(f"Generator(s) {held} held off — the paralleled "
                                     "set(s) already cover the island demand."),
                        ))

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
            # No utility: a user-labelled Swing bus overrides the automatic
            # source choice — but ONLY if that bus is itself backed by a real
            # source in this island. A Swing bus with no source cannot act as
            # an infinite slack; honouring it there fabricates power (e.g. a
            # utility-incomer bus left labelled Swing after its utility is
            # islanded away by an open breaker would inject phantom current
            # down the dead feeder). When the labelled bus has no source, keep
            # the real island source as the reference instead.
            uidx = user_swing_islands[isl]
            source_bis = {bi for _c, bi, _d in sources}
            if uidx in source_bis:
                swing_idx -= {bi for _c, bi, _d in balancers}
                swing_idx.add(uidx)

        bcomp = balancers[0][0]
        if not utilities and bcomp.type == "generator" and not droop_share:
            # (When droop sharing is active a dedicated warning already names
            # the reference set and its parallel partners — don't double up.)
            warnings.append(LoadFlowWarning(
                elementId=bcomp.id,
                element_name=str(bcomp.props.get("name", bcomp.type)),
                message=(f"Island without utility — generator "
                         f"'{bcomp.props.get('name', bcomp.id)}' acts as the "
                         "reference (slack) source."),
            ))
        elif not utilities and bcomp.type in ("solar_pv", "wind_turbine", "battery"):
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
            p_av = min(p_av, _gen_max_load_mw(comp))   # generator dispatch ceiling
            # Committed sequential sets run at their fill-first allocation
            p_tgt = min(seq_fixed_target.get(comp.id, p_av), p_av)
            plan.append([comp, bi, p_av, q_av, p_tgt, p_tgt])

        # A fixed (must-run/discharging) battery is committed generation just
        # like a must-run source: it must reduce the demand that merit
        # generators are sized against and count toward the excess/curtailment
        # check. Omitting it over-commits generators and dumps the surplus onto
        # the slack source as negative power (a diesel set cannot motor). A
        # battery that is itself the island balancer is excluded — its output
        # is recovered from the slack solution, not a fixed injection.
        batt_discharge_mw = sum(p for c, _bi, p, _bp in batt_discharge
                                if c.id not in balancer_ids)

        remaining = demand_mw - sum(e[4] for e in plan) - batt_discharge_mw
        # The island balancer (slack) generator is already committed as the
        # reference set, so let it carry the residual up to its own capacity
        # before starting any additional standby/merit generator. Otherwise a
        # standby set fires just to serve a small residual the running slack
        # set could easily absorb (e.g. a second genset starting for a few kW
        # when a must-run battery already meets nearly all the island load).
        # Skipped when a sequential-commitment scheme owns the balancer.
        if seq_balancer_entry is None:
            remaining -= sum(_source_output_mva(c)[0] for c, _bi, _d in balancers
                             if c.type == "generator")
        for comp, bi in merit:
            p_av, q_av, _s, _r = _source_output_mva(comp)
            p_av = min(p_av, _gen_max_load_mw(comp))   # generator dispatch ceiling
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
                p_av = min(p_av, _gen_max_load_mw(comp))   # generator dispatch ceiling
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
        total = sum(e[4] for e in plan) + batt_discharge_mw
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
            expected = demand_mw - sum(e[4] for e in plan) - batt_discharge_mw
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

        # ── Apply storage set-points (accumulating: a hybrid PV shares its
        # component id between the PV plan entry and its battery) ──
        for comp, bi, p_ch, bp in batt_charge:
            inj = injections.setdefault(bi, [0.0, 0.0])
            inj[0] -= p_ch
            prev = dispatched_by_comp.get(comp.id, (0.0, 0.0))
            dispatched_by_comp[comp.id] = (prev[0] - p_ch, prev[1])
            entries.append({
                "source_id": comp.id,
                "source_name": (str(comp.props.get("name", comp.type))
                                + (" (battery)" if comp.type == "solar_pv" else "")),
                "source_type": "battery",
                "bus_id": buses[bi].id, "island": isl,
                "priority": _dispatch_priority(comp), "mode": bp["mode"],
                "role": "charging",
                "available_mw": round(bp["max_charge_mw"], 4),
                "dispatched_mw": round(-p_ch, 4), "curtailed_mw": 0.0,
            })
        for comp, bi, p_dis, bp in batt_discharge:
            if comp.id in balancer_ids:
                continue   # island slack — output comes from the solve
            inj = injections.setdefault(bi, [0.0, 0.0])
            inj[0] += p_dis
            prev = dispatched_by_comp.get(comp.id, (0.0, 0.0))
            dispatched_by_comp[comp.id] = (prev[0] + p_dis, prev[1])
            entries.append({
                "source_id": comp.id,
                "source_name": (str(comp.props.get("name", comp.type))
                                + (" (battery)" if comp.type == "solar_pv" else "")),
                "source_type": "battery",
                "bus_id": buses[bi].id, "island": isl,
                "priority": _dispatch_priority(comp), "mode": bp["mode"],
                "role": "discharging",
                "available_mw": round(bp["max_discharge_mw"], 4),
                "dispatched_mw": round(p_dis, 4), "curtailed_mw": 0.0,
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
    """Run NR/GS excluding de-energized buses; returns full-size V with 0 V there.

    Returns (V, converged, iterations, reason); `reason` propagates the solver's
    non-convergence classification ("" | "max_iterations" | "singular_jacobian").
    """
    n = len(P_spec)
    if not dead_idx:
        if method == "gauss_seidel":
            return _gauss_seidel(Y, P_spec, Q_spec, V_spec, bus_types)
        return _newton_raphson(Y, P_spec, Q_spec, V_spec, bus_types)

    alive = [i for i in range(n) if i not in dead_idx]
    V = np.zeros(n, dtype=complex)
    if not alive:
        return V, True, 0, ""
    idx = np.array(alive)
    Y_s = Y[np.ix_(idx, idx)]
    bt_s = [bus_types[i] for i in alive]
    if method == "gauss_seidel":
        V_s, converged, iterations, reason = _gauss_seidel(
            Y_s, P_spec[idx], Q_spec[idx], V_spec[idx], bt_s)
    else:
        V_s, converged, iterations, reason = _newton_raphson(
            Y_s, P_spec[idx], Q_spec[idx], V_spec[idx], bt_s)
    V[idx] = V_s
    return V, converged, iterations, reason


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
    if comp.type in ("transformer", "autotransformer"):
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
        if e.type not in ("transformer", "autotransformer"):
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
        if str(comp.props.get("pv_array_mode", "rated")) == "array":
            # Array mode: output follows the DC array (panels × strings) at
            # the modelled irradiance, clipped at the inverter nameplate —
            # an oversized array (DC/AC > 1) clips near full sun.
            dc_kw = (float(comp.props.get("pv_panel_w", 550) or 0)
                     * max(1, int(comp.props.get("pv_panels_per_string", 1) or 1))
                     * max(1, int(comp.props.get("pv_strings", 1) or 1))) / 1000
            avail_kw = min(dc_kw * irr, rated_kw)
            s_mva = avail_kw * n_inv / (eff * 1000)
        else:
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
    elif comp.type == "battery":
        # Available output only in explicit 'discharging' mode; auto-mode
        # storage is dispatched by the battery pass, not the merit order
        rated_mva = float(comp.props.get("rated_kva", 100) or 0) / 1000
        bp = _battery_params(comp)
        if bp and bp["mode"] == "discharging" and bp["can_discharge"]:
            return bp["max_discharge_mw"], 0.0, bp["max_discharge_mw"], rated_mva
        return 0.0, 0.0, 0.0, rated_mva
    return 0.0, 0.0, 0.0, 0.0


def connected_bus_loads_mw(project: ProjectData) -> dict:
    """Per-bus local real load (MW), gathered exactly as ``run_load_flow`` does.

    Returns ``{bus_id: p_mw}`` (buses with no local load are omitted). Shared by
    the voltage-stability engine (total demand for the P-V x-axis) and the
    contingency engine (load lost when a bus de-energizes), so both agree with
    the solver's own load model. Synthetic load-terminal buses are included so a
    load wired behind a cable is still counted; their id carries the synthetic
    prefix (see ``is_synthetic_bus``).
    """
    project = insert_implicit_load_buses(project)
    components = {c.id: c for c in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)
    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
    loads = {}
    for bus in buses:
        p = 0.0
        if bus.type == "distribution_board":
            rated = bus.props.get("rated_kva", 100) / 1000
            pf = bus.props.get("power_factor", 0.85)
            df = bus.props.get("demand_factor", 1.0)
            p += rated * pf * df
        for comp in _find_components_at_bus(bus.id, adjacency, components):
            if comp.type == "static_load":
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                p += rated * pf * df
            elif comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = (rated_kw / (eff * pf * 1000) if pf > 0
                             else rated_kw / (eff * 1000))
                p += rated_mva * pf * df
            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                pf = comp.props.get("power_factor", 0.9)
                df = comp.props.get("demand_factor", 1.0)
                p += (rated_kva / 1000) * pf * df
        if abs(p) > 1e-12:
            loads[bus.id] = p
    return loads


def _assess_solution(bus_results, converged, iterations, reason=""):
    """Classify a load-flow solution beyond raw convergence, and produce any
    solution-level warnings. Returns (quality: str, warnings: list).

    Three failure modes the raw `converged` flag alone hides:
      • a singular / near-singular Jacobian — a structurally under-determined
        network (a subnetwork with no voltage reference) or an operating point
        exactly on the voltage-collapse boundary; caught and named, never left
        as an unhandled solver error (`reason == "singular_jacobian"`);
      • non-convergence — surfaced with an actionable message (an infeasible
        operating point, i.e. load beyond the loadability limit / collapse,
        looks the same to the solver as any other divergence);
      • a converged but implausibly low-voltage root — a mathematically valid
        power-flow solution on the lower P-V branch that must not be handed back
        as a normal operating point (the "clean-looking but wrong" case).
    """
    if not converged:
        if reason == "singular_jacobian":
            return "non_converged", [LoadFlowWarning(
                elementId="", element_name="Load Flow",
                message=("Load flow could not solve: the system Jacobian is "
                         "singular. The network is structurally under-determined "
                         "(a subnetwork with no voltage reference / all-swing "
                         "island) or sitting exactly on the voltage-collapse "
                         "boundary. Check that every energized island has one "
                         "swing/reference source and is not loaded to its "
                         "collapse point."))]
        return "non_converged", [LoadFlowWarning(
            elementId="", element_name="Load Flow",
            message=(f"Load flow did not converge after {iterations} iterations — "
                     "results are unreliable. The operating point may be "
                     "infeasible: load beyond the network's loadability limit "
                     "(voltage collapse), a source too weak for the demand, or an "
                     "overloaded transformer. Check source strength, transformer "
                     "ratings and total load."))]

    lows = [(bid, b) for bid, b in bus_results.items()
            if getattr(b, "energized", True) and 1e-6 < b.voltage_pu < V_IMPLAUSIBLE_PU]
    if lows:
        worst_id, worst = min(lows, key=lambda kv: kv[1].voltage_pu)
        extra = (f" ({len(lows)} energized buses below {V_IMPLAUSIBLE_PU:.2f} p.u.)"
                 if len(lows) > 1 else "")
        return "low_voltage_root", [LoadFlowWarning(
            elementId=worst_id, element_name=worst.bus_name,
            message=(f"Converged to an implausibly low voltage — {worst.voltage_pu:.3f} "
                     f"p.u. at '{worst.bus_name}'{extra}. This is almost certainly the "
                     "low-voltage/collapse root or an infeasible operating point, not a "
                     "normal operating solution. Verify source strength and loading; the "
                     "network may be past its loadability limit."))]

    return "ok", []


def run_load_flow(project: ProjectData, method: str = "newton_raphson",
                  include_synthetic: bool = False,
                  _regulate: bool = True) -> LoadFlowResults:
    """Run load flow analysis.

    include_synthetic: keep auto-inserted load-terminal buses (see
    insert_implicit_load_buses) in the results. Off by default so they stay
    invisible to the UI/reports; motor-starting turns it on to read the motor
    terminal voltage.

    _regulate: when True (default), on-load tap changers of regulating
    autotransformers are iterated to hold their target voltage before the final
    solve. Set False internally to break the tap-solve recursion.
    """
    # Give any load wired behind a cable/transformer a terminal bus so its
    # demand is modelled instead of silently dropped (idempotent).
    project = insert_implicit_load_buses(project)
    # Expand 3-winding autotransformers into a star node + three 2-winding legs
    # (idempotent) so the standard branch machinery handles them.
    project = _expand_three_winding(project)
    # Iterate OLTC taps of regulating autotransformers to their setpoint.
    if _regulate:
        regulators = [c for c in project.components
                      if c.type == "autotransformer"
                      and str(c.props.get("tap_mode", "fixed") or "fixed").lower() == "regulating"]
        if regulators:
            project = _run_oltc(project, method, regulators)
    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}
    wires = project.wires

    # Build bus list and index.
    # A distribution_board is modelled as a bus-like node: it is a busbar that
    # carries its own lumped load AND passes current through (in→out) to any
    # sub-board it feeds. Without this, a board blocks every network walk, so a
    # feeder cable to a sub-board never becomes a branch and the sub-board's
    # demand vanishes from the solution (see EE-1).
    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
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

    # Port-aware adjacency: (component_id, port_id) -> [neighbor_ids]. Used to
    # orient a standalone cable branch by its own from/to ports (see the cable
    # branch emission below), so reported flow direction is deterministic.
    adjacency_ports = {}
    for w in wires:
        adjacency_ports.setdefault((w.fromComponent, w.fromPort), []).append(w.toComponent)
        adjacency_ports.setdefault((w.toComponent, w.toPort), []).append(w.fromComponent)

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
        if comp.type not in ("cable", "transformer", "autotransformer"):
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
        has_xfmr = any(e.type in ("transformer", "autotransformer") for e in all_elems.values())
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
                if e.type in ("transformer", "autotransformer"):
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
    svc_units = []  # FACTS shunt compensators: list of dicts (see svc branch below)
    gen_pv_units = {}  # bus index -> PV-generator reactive-limit unit (see below)

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")

        # Initial bus type from user setting; Swing assignment is decided
        # per-island by plan_dispatch below (utility connection bus, else
        # user-labelled Swing, else the lowest-merit source acting as balancer).
        bus_types.append(1 if bt == "PV" else 0)

        # A distribution board carries its own lumped load at its own node.
        # (It is not found by _find_components_at_bus below — that walk starts
        # from the node's neighbours — so inject it explicitly here. The load
        # type list below no longer includes distribution_board, so a board wired
        # to another bus is not double-counted at that neighbour.)
        if bus.type == "distribution_board":
            rated = bus.props.get("rated_kva", 100) / 1000
            pf = bus.props.get("power_factor", 0.85)
            df = bus.props.get("demand_factor", 1.0)
            P_spec[i] -= rated * pf * df / base_mva
            Q_spec[i] -= rated * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva
            bus_load_p_mw[i] += rated * pf * df
            bus_load_q_mvar[i] += rated * math.sqrt(max(0, 1 - pf ** 2)) * df

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
                # A generator on a PV bus regulates voltage with unbounded Q
                # unless we cap it. Register its reactive capability so the outer
                # loop can clamp it PV→PQ at Q_max/Q_min (see the SVC loop). The
                # capability defaults to the rated-power-factor limit of the
                # machine (a symmetric ±Q box); explicit props override. Skipped
                # when the bus is the island swing (bus_types set to 2 below) —
                # a slack has no Q constraint. Multiple generators on one bus
                # sum their capability into a single unit.
                if bt == "PV":
                    cp = comp.props
                    rated_mva = float(cp.get("rated_mva", 0) or 0)
                    pf = float(cp.get("power_factor", 0.85) or 0.85)
                    q_cap = rated_mva * math.sqrt(max(0.0, 1 - pf ** 2))
                    q_max = float(cp.get("q_max_mvar", q_cap) or q_cap)          # over-excited (supplies vars)
                    q_min = float(cp.get("q_min_mvar", -q_cap) or -q_cap)        # under-excited (absorbs vars)
                    ge = gen_pv_units.get(i)
                    if ge is None:
                        ge = {"i": i, "id": comp.id, "name": cp.get("name", comp.id),
                              "q_max": 0.0, "q_min": 0.0, "vset": vset if vset > 0 else 1.0,
                              "clamped": None, "inj_q": 0.0}
                        gen_pv_units[i] = ge
                    ge["q_max"] += q_max
                    ge["q_min"] += q_min
                    if vset > 0:
                        ge["vset"] = vset
            elif comp.type in ("solar_pv", "wind_turbine", "battery"):
                pass  # Injection set by the dispatcher / battery pass below
            elif comp.type == "static_load":
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
            elif comp.type == "vfd":
                # A VFD is a converter load: the DC link decouples the motor
                # from the supply, so the drive draws a near-unity DISPLACEMENT
                # power factor at fundamental frequency regardless of motor PF.
                # (Harmonic current is handled by the harmonics engine, not the
                # fundamental load flow.) Input real power = shaft kW ÷ efficiency.
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.96) or 0.96
                load = float(comp.props.get("load_pct", 100) or 0) / 100.0
                dpf = float(comp.props.get("displacement_pf", 0.98) or 0.98)
                df = comp.props.get("demand_factor", 1.0)
                p_mw = rated_kw * load / (eff * 1000)
                q_mvar = p_mw * math.sqrt(max(0.0, 1 - dpf ** 2)) / dpf if dpf > 0 else 0.0
                P_spec[i] -= p_mw * df / base_mva
                Q_spec[i] -= q_mvar * df / base_mva
                bus_load_p_mw[i] += p_mw * df
                bus_load_q_mvar[i] += q_mvar * df
            elif comp.type == "svc":
                # SVC / STATCOM — a FACTS shunt reactive compensator (P ≈ 0).
                # Voltage-regulating: hold the bus at the setpoint (a PV bus,
                # like a synchronous condenser) within its reactive limits;
                # a hit limit converts it to a fixed-Q shunt (see the Q-limit
                # loop below). Fixed mode simply injects a set Q.
                cp = comp.props
                mode = str(cp.get("device_mode", "statcom") or "statcom").lower()
                q_max = float(cp.get("q_max_mvar", cp.get("rated_mvar", 50)) or 50)      # capacitive
                q_min = float(cp.get("q_min_mvar", -abs(float(cp.get("rated_mvar", 50) or 50))) or -50)  # inductive
                ctrl = str(cp.get("control_mode", "voltage_regulating") or "voltage_regulating").lower()
                if ctrl == "fixed_q":
                    q_out = float(cp.get("q_output_mvar", 0) or 0)
                    Q_spec[i] += q_out / base_mva
                    bus_load_q_mvar[i] -= q_out
                else:
                    vset = float(cp.get("v_setpoint_pu", 1.0) or 1.0)
                    bus_types[i] = 1                     # PV — hold |V| at setpoint
                    V_spec[i] = vset
                    svc_units.append({
                        "i": i, "id": comp.id, "name": cp.get("name", comp.id),
                        "device": mode, "q_max": q_max, "q_min": q_min,
                        "vset": vset, "clamped": None, "inj_q": 0.0,
                    })

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
    # Outer loop enforces reactive limits on voltage-regulating buses: a
    # SVC/STATCOM or a PV generator that would exceed its Q range is clamped to
    # the limit and switched from a voltage-holding PV bus to a fixed-Q PQ
    # injection, then the network is re-solved (one extra pass per unit that
    # hits a limit; the bound allows a clamp and a later revert per unit).
    for _svc_pass in range(2 * (len(svc_units) + len(gen_pv_units)) + 3):
        for _pass in range(3):
            dispatch = plan_dispatch(project, components, adjacency, bus_idx, buses,
                                     branch_pairs, bus_load_p_mw, loss_adders)
            for i in dispatch["swing_idx"]:
                bus_types[i] = 2
            P_spec, Q_spec = P_base.copy(), Q_base.copy()
            for i, (p_mw, q_mvar) in dispatch["injections"].items():
                P_spec[i] += p_mw / base_mva
                Q_spec[i] += q_mvar / base_mva

            V, converged, iterations, solve_reason = solve_with_islands(
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

        # Reactive-limit check on the converged solution (SVC/STATCOM, then PV
        # generators). A regulating unit that would exceed its Q range is
        # clamped to the limit and reverts to a fixed-Q PQ injection. A STATCOM
        # holds a constant MVAr at the limit; an SVC is susceptance-limited, so
        # its delivered Q follows Q = Q_nom·V² — refined across passes as V settles.
        if not converged or (not svc_units and not gen_pv_units):
            break
        S_reg = V * np.conj(Y @ V)
        changed = False
        for u in svc_units:
            bi = u["i"]
            vmag = abs(V[bi]) if abs(V[bi]) > 1e-6 else 1.0
            if u["clamped"] is None:
                # Reactive output the PV constraint is currently demanding.
                q_svc = S_reg[bi].imag * base_mva + bus_load_q_mvar[bi]
                v2 = vmag * vmag if u["device"] == "svc" else 1.0
                if q_svc > u["q_max"] * v2 + 1e-6:
                    u["clamped"], q_nom = "cap", u["q_max"]
                elif q_svc < u["q_min"] * v2 - 1e-6:
                    u["clamped"], q_nom = "ind", u["q_min"]
                else:
                    continue
                bus_types[bi] = 0                # PV → PQ at the reactive limit
                inj = q_nom * (vmag * vmag if u["device"] == "svc" else 1.0)
                Q_base[bi] += (inj - u["inj_q"]) / base_mva
                u["inj_q"] = inj
                changed = True
            elif u["device"] == "svc":
                # Already limited: keep the susceptance fixed → track Q_nom·V².
                q_nom = u["q_max"] if u["clamped"] == "cap" else u["q_min"]
                inj = q_nom * vmag * vmag
                if abs(inj - u["inj_q"]) > 1e-3:
                    Q_base[bi] += (inj - u["inj_q"]) / base_mva
                    u["inj_q"] = inj
                    changed = True

        # PV-generator reactive-limit check (over-/under-excitation). A generator
        # holding voltage with more Q than its capability box is clamped to the
        # limit (PV → fixed-Q PQ). Once clamped it stays a constant MVAr source,
        # but reverts to voltage regulation if the setpoint becomes holdable
        # within limits again — the classic PV↔PQ switching heuristic.
        for u in gen_pv_units.values():
            bi = u["i"]
            if bus_types[bi] == 2:
                continue   # generator is this island's swing — no Q constraint
            vmag = abs(V[bi]) if abs(V[bi]) > 1e-6 else 1.0
            if u["clamped"] is None:
                q_gen = S_reg[bi].imag * base_mva + bus_load_q_mvar[bi]
                if q_gen > u["q_max"] + 1e-6:
                    u["clamped"], q_lim = "over", u["q_max"]
                elif q_gen < u["q_min"] - 1e-6:
                    u["clamped"], q_lim = "under", u["q_min"]
                else:
                    continue
                bus_types[bi] = 0                # PV → PQ at the reactive limit
                Q_base[bi] += (q_lim - u["inj_q"]) / base_mva
                u["inj_q"] = q_lim
                changed = True
            else:
                # Revert to voltage regulation when the setpoint is again
                # holdable within limits: clamped over-excited (Q_max) but the
                # bus has risen above setpoint ⇒ it now needs less Q; clamped
                # under-excited (Q_min) but the bus is below setpoint ⇒ it now
                # needs to absorb less.
                if ((u["clamped"] == "over" and vmag > u["vset"] + 1e-6) or
                        (u["clamped"] == "under" and vmag < u["vset"] - 1e-6)):
                    Q_base[bi] -= u["inj_q"] / base_mva
                    u["inj_q"] = 0.0
                    u["clamped"] = None
                    bus_types[bi] = 1               # restore PV regulation
                    V_spec[bi] = u["vset"]
                    changed = True
        if not changed:
            break

    # Final SVC/STATCOM output summary (for reporting).
    svc_results = []
    if svc_units and converged:
        S_svc = V * np.conj(Y @ V)
        for u in svc_units:
            bi = u["i"]
            q_out = (u["inj_q"] if u["clamped"] is not None
                     else S_svc[bi].imag * base_mva + bus_load_q_mvar[bi])
            svc_results.append({
                "id": u["id"], "name": u["name"], "device": u["device"],
                "bus_id": buses[bi].id if bi < len(buses) else "",
                "q_mvar": round(q_out, 3), "v_pu": round(abs(V[bi]), 4),
                "v_setpoint_pu": u["vset"], "q_min_mvar": u["q_min"],
                "q_max_mvar": u["q_max"], "at_limit": u["clamped"] is not None,
            })

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
                # Row-local reporting direction; may be flipped for standalone
                # cables (see below). Magnitudes (s_mva, i_amps, losses) are
                # direction-independent, so only from/to and P/Q signs change.
                row_from, row_to = from_bus, to_bus
                row_p, row_q = p_mw, q_mvar
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
                    # Orient a standalone cable branch by its own 'from'→'to'
                    # ports so the reported direction is deterministic (as drawn,
                    # typically source→load) instead of graph-walk order, then
                    # apply the user's optional manual flip (props.reverse).
                    if len(elems) == 1 and hv_bus is None:
                        port_from = _bus_via_port(elem.id, "from", adjacency_ports,
                                                  adjacency, components, bus_of)
                        swap = port_from == to_bus  # 'from' port sits on the to-side
                        if bool(elem.props.get("reverse", False)):
                            swap = not swap
                        if swap:
                            row_from, row_to = row_to, row_from
                            row_p, row_q = -row_p, -row_q
                elif elem.type in ("transformer", "autotransformer"):
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
                    from_bus=row_from, to_bus=row_to,
                    p_mw=round(row_p, 4), q_mvar=round(row_q, 4),
                    s_mva=round(s_mva, 4), i_amps=round(elem_i_amps, 2),
                    loading_pct=round(loading, 2), losses_mw=round(losses_mw, 6),
                ))

    # ── Bus results ──
    def _through(branch, local):
        """Combine branch through-flow with the local P (or Q) at a bus.

        A local CONSUMER (positive `local`: loads, motors) is served in addition
        to whatever the bar passes downstream, so it adds on top of the outgoing
        branch flow. A local INJECTOR (negative `local`: capacitor banks,
        over-excited machines) instead FEEDS the bar — its output leaves through
        the branches and is therefore already captured in `s_through`. Adding the
        negative load on top then cancels the value to ~0 (the "capacitor bus
        reports 0 kVAr" bug), so a net injection is reported directly with its
        own (leading/supplying) sign rather than double-counted against its own
        export.
        """
        return branch + local if local >= 0 else local

    bus_results = {}
    for bus in buses:
        i = bus_idx[bus.id]
        v_kv = bus.props.get("voltage_kv", 0.4 if bus.type == "distribution_board" else 11)
        # Busbar through-power: outgoing branch flows + the local load it
        # serves (zero for de-energized buses — their load is unserved)
        s_th = (complex(_through(s_through[i].real, bus_load_p_mw[i]),
                        _through(s_through[i].imag, bus_load_q_mvar[i]))
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
        if comp.type not in ("transformer", "autotransformer") or comp.id in processed_elem_ids:
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
    _SOURCE_TYPES = {"generator", "solar_pv", "wind_turbine", "battery"}

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
            # [gap #6] At a PV bus the generator's reactive output is whatever
            # holds the setpoint voltage, not its scheduled/dispatched Q.
            # Recover the true Q from the converged solution — net reactive
            # injection at the bus (Im{V·conj(Y·V)}) plus the local load Q —
            # and split it across the bus's generators by rating. P is
            # unchanged (NR enforced P_spec).
            pv_q_solved = None
            gen_rated_total = 0.0
            if bus_types[bus_i] == 1:
                q_inj = (V[bus_i] * np.conj(Y[bus_i, :] @ V)).imag * base_mva
                pv_q_solved = q_inj + bus_load_q_mvar[bus_i]
                gen_rated_total = sum(_source_output_mva(s)[3] for s in gen_sources
                                      if _source_output_mva(s)[3] > 0)
            for src in gen_sources:
                _p, _q, s_rated, rated_mva = _source_output_mva(src)
                if rated_mva <= 0:
                    continue
                _p, _q = dispatch["dispatched_by_comp"].get(src.id, (_p, _q))
                if pv_q_solved is not None and gen_rated_total > 0:
                    _q = pv_q_solved * (rated_mva / gen_rated_total)
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

    # PV generators that hit their reactive capability: they can no longer hold
    # their voltage setpoint (this is exactly the "reported holding voltage
    # while demanding Q it can't supply" failure — now flagged, not hidden).
    for u in gen_pv_units.values():
        if u["clamped"] is not None:
            _lim = "over-excitation (Q_max)" if u["clamped"] == "over" else "under-excitation (Q_min)"
            voltage_warnings.append(LoadFlowWarning(
                elementId=u["id"],
                element_name=str(u["name"]),
                message=(f"Generator hit its reactive limit at {_lim}: pinned at "
                         f"{round(u['inj_q'], 2)} MVAr and no longer holding "
                         f"{round(u['vset'], 3)} p.u. — bus voltage floats."),
            ))

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

    # Collapse synthetic load-terminal buses out of the user-facing result:
    # drop their bus rows and re-point any branch endpoint that lands on one
    # back to the real load it represents (syn id = prefix + load id).
    if not include_synthetic:
        syn_ids = {bid for bid in bus_results if is_synthetic_bus(bid)}
        if syn_ids:
            for bid in syn_ids:
                bus_results.pop(bid, None)
            _unsyn = lambda b: b[len(SYNTHETIC_BUS_PREFIX):] if is_synthetic_bus(b) else b
            for br in branch_results:
                br.from_bus = _unsyn(br.from_bus)
                br.to_bus = _unsyn(br.to_bus)

    # Classify the solution (non-convergence / low-voltage-collapse root) and
    # surface it at the top of the warnings so a suspect-but-converged result
    # isn't mistaken for a valid operating point.
    solution_quality, solution_warnings = _assess_solution(
        bus_results, converged, iterations, solve_reason)
    voltage_warnings = solution_warnings + voltage_warnings

    return LoadFlowResults(
        buses=bus_results,
        branches=branch_results,
        warnings=voltage_warnings,
        converged=converged,
        iterations=iterations,
        method=method,
        dispatch=dispatch_results,
        svc=svc_results,
        solution_quality=solution_quality,
    )


def _newton_raphson(Y, P_spec, Q_spec, V_mag, bus_types):
    """Newton-Raphson power flow solver.

    Returns (V, converged, iterations, reason), where `reason` is "" on success,
    "max_iterations" when the iteration limit is hit while still stepping, or
    "singular_jacobian" when the Jacobian is (near-)singular and no reliable step
    can be taken.
    """
    n = len(P_spec)
    V = np.array(V_mag, dtype=complex)
    theta = np.zeros(n)
    reason = "max_iterations"

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
            return V, True, iteration + 1, ""

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

        # Guard against a singular / near-singular Jacobian before using its
        # solve: a subnetwork with no voltage reference, an all-swing island, or
        # an operating point on the voltage-collapse boundary drives cond(J) → ∞,
        # and stepping on that solve would fabricate a meaningless "solution".
        # np.linalg.cond returns inf for an exactly singular J (it does not
        # raise), so this also subsumes the LinAlgError case; the except below
        # stays as a backstop.
        if not np.all(np.isfinite(J)) or np.linalg.cond(J) > JACOBIAN_COND_LIMIT:
            reason = "singular_jacobian"
            break

        # Solve J * dx = mismatch
        try:
            dx = np.linalg.solve(J, mismatch)
        except np.linalg.LinAlgError:
            reason = "singular_jacobian"
            break
        if not np.all(np.isfinite(dx)):
            reason = "singular_jacobian"
            break

        # Update
        for ii, i in enumerate(non_swing):
            theta[i] += dx[ii]
        for ii, i in enumerate(pq_idx):
            V[i] = abs(V[i]) + dx[len(non_swing) + ii]

    # Rebuild complex V. Report the iteration actually reached — MAX_ITERATIONS
    # for a genuine iteration-limit failure, or the (small) break iteration when
    # a singular Jacobian stopped us early — so the count isn't misleading.
    V = np.array([abs(V[i]) * np.exp(1j * theta[i]) for i in range(n)])
    return V, False, iteration + 1, reason


def _gauss_seidel(Y, P_spec, Q_spec, V_mag, bus_types):
    """Gauss-Seidel power flow solver.

    Returns (V, converged, iterations, reason) — same contract as the NR solver.
    Gauss-Seidel builds no Jacobian, so it never reports "singular_jacobian";
    a failure is always "max_iterations".
    """
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
            return V, True, iteration + 1, ""

    return V, False, MAX_ITERATIONS, "max_iterations"


def _utility_admittance(comp, base_mva):
    """Utility source admittance."""
    fault_mva = comp.props.get("fault_mva", 500)
    xr = comp.props.get("x_r_ratio", 15)
    z_pu = base_mva / fault_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    z = complex(r_pu, x_pu)
    return 1 / z if abs(z) > 1e-15 else complex(0, 0)
