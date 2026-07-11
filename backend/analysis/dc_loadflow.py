"""DC Load Flow — resistive nodal power-flow solver for DC networks.

Solves node voltages on a DC bus network (UPS/telecom/substation-auxiliary
DC systems) built from DC buses (``bus`` with ``system == "dc"``), resistive
cables, transparent switching devices, DC sources (rectifier / charger /
DC battery) and DC loads (``dc_load``).

Method
------
Nodal analysis on bus groups (a bus plus every closed transparent device
electrically bonded to it).  Each branch cable contributes a loop conductance
``G = 1/R`` between its two bus groups; each source is a Thevenin equivalent
(regulated EMF behind an internal resistance) that both grounds the island
(a shunt conductance ``1/Rs`` to the DC reference rail) and injects a Norton
current ``E/Rs``.  Constant-power loads are linearised as a current
``I = P/V`` and the solve is repeated until the voltages converge.

Operational model: in normal operation an active converter (rectifier or
charger) holds the bus, and the battery floats (≈ 0 A).  Only when an island
has no converter does the battery become the source (backup/discharge).  This
avoids the non-physical charger↔battery circulating current a naive two-EMF
solve would produce, and mirrors how DC auxiliary systems actually run.

DC cables use loop resistance ``2·r·ℓ`` (two-wire go-and-return), which is the
correct basis for DC voltage drop.
"""

import numpy as np

from ..models.schemas import (
    ProjectData, DCLoadFlowResults, DCLoadFlowBus, DCLoadFlowBranch,
    DCLoadFlowSource, LoadFlowWarning,
)

MAX_ITERATIONS = 60
TOLERANCE = 1e-4  # volts

# Devices that pass DC through transparently when closed.
TRANSPARENT_TYPES = {"cb", "switch", "fuse"}
CONVERTER_TYPES = {"rectifier", "charger"}
SOURCE_TYPES = {"rectifier", "charger", "dc_battery"}


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if f == f else default  # reject NaN
    except (TypeError, ValueError):
        return default


def _is_dc_bus(comp):
    return comp.type == "bus" and str(comp.props.get("system", "ac")).lower() == "dc"


def _bus_nominal_v(comp):
    """Nominal DC voltage of a DC bus (V)."""
    v = _num(comp.props.get("voltage_dc_v"), 0.0)
    if v > 0:
        return v
    # Fall back to voltage_kv (kV → V) for buses toggled to DC without a Vdc set.
    return _num(comp.props.get("voltage_kv"), 0.11) * 1000.0


def _transparent_closed(comp):
    if comp.type not in TRANSPARENT_TYPES:
        return False
    if comp.type in ("cb", "switch"):
        return str(comp.props.get("state", "closed")) != "open"
    return True


def _build_bus_groups(dc_buses, adjacency, components, bus_ids):
    """Map component_id → representative DC bus id for every bus and the
    transparent devices bonded to it."""
    bus_of = {}
    for bus in dc_buses:
        stack = [bus.id]
        while stack:
            nid = stack.pop()
            if nid in bus_of:
                continue
            bus_of[nid] = bus.id
            for nb in adjacency.get(nid, []):
                if nb in bus_of:
                    continue
                if nb in bus_ids and nb != bus.id:
                    continue  # don't cross into another bus
                comp = components.get(nb)
                if comp and _transparent_closed(comp):
                    stack.append(nb)
    return bus_of


def _find_dc_branches(components, adjacency, bus_of, bus_ids):
    """Find cable branches between two DC bus groups. Series cables joined by
    transparent devices are summed. Returns (comp, group_a, group_b, R_loop, amp)."""
    branches = []
    seen = set()
    for comp in components.values():
        if comp.type != "cable" or comp.id in bus_of or comp.id in seen:
            continue
        # BFS out of the cable, walking transparent devices and further cables,
        # stopping at bus groups.
        visited = {comp.id}
        chain = {comp.id: comp}
        found = []  # (group_id, chain_ids_frozen)
        queue = [(nb, [comp.id]) for nb in adjacency.get(comp.id, [])]
        while queue:
            nid, path = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in bus_of:
                found.append((bus_of[nid], tuple(path)))
                continue
            c = components.get(nid)
            if not c:
                continue
            if _transparent_closed(c):
                for nb in adjacency.get(nid, []):
                    if nb not in visited:
                        queue.append((nb, path))
            elif c.type == "cable":
                chain[c.id] = c
                for nb in adjacency.get(nid, []):
                    if nb not in visited:
                        queue.append((nb, path + [c.id]))
            # else: source/load/other — dead end
        if len(found) < 2:
            continue
        ga, patha = found[0]
        gb, pathb = found[1]
        if ga == gb:
            continue
        cable_ids = {cid for _, p in found[:2] for cid in p if cid in chain}
        key = frozenset(cable_ids)
        if key in seen:
            continue
        seen |= cable_ids
        r_loop = 0.0
        amp = None
        rep = comp
        for cid in cable_ids:
            c = chain[cid]
            npar = max(1, int(_num(c.props.get("num_parallel", 1), 1)))
            r_loop += 2.0 * _num(c.props.get("r_per_km", 0.1), 0.1) \
                * _num(c.props.get("length_km", 0.1), 0.1) / npar
            a = _num(c.props.get("rated_amps", 0), 0) * npar
            amp = a if amp is None else min(amp, a)
        branches.append((rep, ga, gb, max(r_loop, 1e-9), amp or 0.0))
    return branches


def _attached_group(comp, adjacency, components, bus_of, bus_ids):
    """DC bus group a source/load attaches to (through transparent devices)."""
    visited = {comp.id}
    queue = list(adjacency.get(comp.id, []))
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in bus_of:
            return bus_of[nid]
        if nid in bus_ids:
            continue  # a non-DC bus — stop
        c = components.get(nid)
        if c and _transparent_closed(c):
            for nb in adjacency.get(nid, []):
                if nb not in visited:
                    queue.append(nb)
    return None


def _source_params(comp):
    """(emf_v, rs_ohm, i_limit_a, rated_a) for a DC source. i_limit None = unlimited."""
    p = comp.props
    if comp.type == "rectifier":
        v = _num(p.get("voltage_dc_v", 125), 125)
        i_r = _num(p.get("rated_kw", 50), 50) * 1000.0 / max(v, 1.0)
        rs = 0.01 * v / max(i_r, 1e-6)  # ~1 % regulation at rated
        return v, rs, i_r, i_r
    if comp.type == "charger":
        v = _num(p.get("float_voltage_v", 0), 0) or _num(p.get("voltage_dc_v", 125), 125)
        i_r = _num(p.get("rated_a", 200), 200)
        limit = i_r * _num(p.get("current_limit_pct", 100), 100) / 100.0
        rs = 0.01 * v / max(i_r, 1e-6)
        return v, rs, limit, i_r
    # dc_battery
    v = _num(p.get("nominal_v", 125), 125)
    r_int = _num(p.get("internal_r_mohm", 20), 20) / 1000.0
    ah = _num(p.get("ah_capacity", 0), 0)
    # A stiff limit so load flow stays well-conditioned: 10 C, or rated if given.
    limit = _num(p.get("max_discharge_a", 0), 0) or (10.0 * ah if ah > 0 else None)
    return v, max(r_int, 1e-4), limit, (limit or 0.0)


def _load_current(comp, v):
    """Current drawn by a dc_load at bus voltage v (A). Constant-R handled via
    conductance instead, so it returns 0 here."""
    p = comp.props
    model = str(p.get("load_model", "constant_power"))
    if model == "constant_current":
        return _num(p.get("load_a", 0), 0)
    if model == "constant_resistance":
        return 0.0  # folded into G
    kw = _num(p.get("load_kw", 0), 0)
    return (kw * 1000.0) / max(v, 1.0)


def run_dc_load_flow(project: ProjectData) -> DCLoadFlowResults:
    components = {c.id: c for c in project.components}
    dc_buses = [c for c in project.components if _is_dc_bus(c)]
    warnings = []
    if not dc_buses:
        return DCLoadFlowResults(
            converged=False, iterations=0,
            warnings=[LoadFlowWarning(elementId="", message=(
                "No DC buses in the network. Set a bus's System property to 'DC' "
                "to model a DC network."))],
        )

    bus_ids = {b.id for b in project.components if b.type == "bus"}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    bus_of = _build_bus_groups(dc_buses, adjacency, components, bus_ids)
    groups = [b.id for b in dc_buses]
    gidx = {g: i for i, g in enumerate(groups)}
    n = len(groups)
    nominal = {b.id: _bus_nominal_v(b) for b in dc_buses}
    name_of = {b.id: (b.props.get("name") or b.id) for b in dc_buses}

    branches = _find_dc_branches(components, adjacency, bus_of, bus_ids)

    # Islands: union-find over branch connectivity.
    parent = {g: g for g in groups}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        parent[find(a)] = find(b)

    for _, ga, gb, _, _ in branches:
        union(ga, gb)

    # Collect sources and loads per group.
    src_by_group = {}   # group -> list of (comp, emf, rs, limit, rated)
    load_by_group = {}  # group -> list of comp
    for comp in project.components:
        if comp.type in SOURCE_TYPES:
            g = _attached_group(comp, adjacency, components, bus_of, bus_ids)
            if g is not None:
                src_by_group.setdefault(g, []).append((comp,) + _source_params(comp))
        elif comp.type == "dc_load":
            g = _attached_group(comp, adjacency, components, bus_of, bus_ids)
            if g is not None:
                load_by_group.setdefault(g, []).append(comp)

    islands = {}
    for g in groups:
        islands.setdefault(find(g), []).append(g)

    V = {g: nominal[g] for g in groups}
    energized = {g: False for g in groups}
    src_current = {}     # comp.id -> A (positive = supplying)
    src_limited = {}
    iterations = 0

    for isl_root, isl_groups in islands.items():
        # Which sources ground this island? In normal operation converters
        # hold the bus; batteries float. Only if no converter does the battery
        # act as source.
        conv_present = any(
            s[0].type in CONVERTER_TYPES
            for g in isl_groups for s in src_by_group.get(g, [])
        )
        active = {}  # group -> list of (comp, emf, rs, limit)
        any_source = False
        for g in isl_groups:
            for (comp, emf, rs, limit, rated) in src_by_group.get(g, []):
                if comp.type == "dc_battery" and conv_present:
                    src_current[comp.id] = 0.0  # floating
                    src_limited[comp.id] = False
                    continue
                active.setdefault(g, []).append([comp, emf, rs, limit])
                any_source = True
        if not any_source:
            for g in isl_groups:
                energized[g] = False
            continue
        for g in isl_groups:
            energized[g] = True

        local = [g for g in isl_groups]
        lidx = {g: i for i, g in enumerate(local)}
        m = len(local)

        # Iterative nodal solve (constant-power loads + converter current limits).
        prev = np.array([nominal[g] for g in local], dtype=float)
        limited = {}  # comp.id -> clamp current
        for it in range(MAX_ITERATIONS):
            iterations = max(iterations, it + 1)
            G = np.zeros((m, m))
            I = np.zeros(m)
            # branches
            for _, ga, gb, r, _ in branches:
                if ga not in lidx or gb not in lidx:
                    continue
                a, b = lidx[ga], lidx[gb]
                g_ab = 1.0 / r
                G[a, a] += g_ab
                G[b, b] += g_ab
                G[a, b] -= g_ab
                G[b, a] -= g_ab
            # sources
            for g, lst in active.items():
                i = lidx[g]
                for (comp, emf, rs, limit) in lst:
                    if comp.id in limited:
                        I[i] += limited[comp.id]   # clamped → current source
                    else:
                        G[i, i] += 1.0 / rs
                        I[i] += emf / rs
            # loads
            for g, lst in load_by_group.items():
                if g not in lidx:
                    continue
                i = lidx[g]
                for comp in lst:
                    model = str(comp.props.get("load_model", "constant_power"))
                    if model == "constant_resistance":
                        r = _num(comp.props.get("resistance_ohm", 0), 0)
                        if r > 0:
                            G[i, i] += 1.0 / r
                    else:
                        I[i] -= _load_current(comp, prev[i])
            try:
                v = np.linalg.solve(G, I)
            except np.linalg.LinAlgError:
                v = prev
            # Re-check converter current limits.
            changed = False
            for g, lst in active.items():
                i = lidx[g]
                for (comp, emf, rs, limit) in lst:
                    if limit is None:
                        continue
                    if comp.id not in limited:
                        i_out = (emf - v[i]) / rs
                        if i_out > limit * 1.0001:
                            limited[comp.id] = limit
                            changed = True
            if np.max(np.abs(v - prev)) < TOLERANCE and not changed:
                prev = v
                break
            prev = v

        for g in local:
            V[g] = float(prev[lidx[g]])
        # source currents
        for g, lst in active.items():
            i = lidx[g]
            for (comp, emf, rs, limit) in lst:
                if comp.id in limited:
                    src_current[comp.id] = limited[comp.id]
                    src_limited[comp.id] = True
                else:
                    src_current[comp.id] = (emf - prev[i]) / rs
                    src_limited[comp.id] = False

    # ── Assemble results ──
    out_buses = {}
    for b in dc_buses:
        g = b.id
        vnom = nominal[g]
        vv = V[g] if energized[g] else 0.0
        load_kw = 0.0
        for comp in load_by_group.get(g, []):
            load_kw += _bus_load_kw(comp, vv)
        out_buses[g] = DCLoadFlowBus(
            bus_id=g, bus_name=name_of[g],
            voltage_v=round(vv, 2), nominal_v=round(vnom, 2),
            voltage_pu=round(vv / vnom, 4) if vnom else 0.0,
            drop_pct=round((vnom - vv) / vnom * 100.0, 2) if (vnom and energized[g]) else 0.0,
            load_kw=round(load_kw, 3), energized=energized[g],
        )

    out_branches = []
    for rep, ga, gb, r, amp in branches:
        va, vb = V[ga], V[gb]
        if not (energized[ga] and energized[gb]):
            i_a = 0.0
        else:
            i_a = (va - vb) / r
        drop = abs(va - vb) if (energized[ga] and energized[gb]) else 0.0
        out_branches.append(DCLoadFlowBranch(
            elementId=rep.id, element_name=(rep.props.get("name") or rep.id),
            from_bus=ga, to_bus=gb, current_a=round(i_a, 2),
            voltage_drop_v=round(drop, 3), loss_kw=round(i_a * i_a * r / 1000.0, 4),
            resistance_ohm=round(r, 5),
            loading_pct=round(abs(i_a) / amp * 100.0, 1) if amp else 0.0,
        ))

    out_sources = []
    for comp in project.components:
        if comp.type not in SOURCE_TYPES:
            continue
        g = _attached_group(comp, adjacency, components, bus_of, bus_ids)
        if g is None:
            continue
        emf, rs, limit, rated = _source_params(comp)
        i_out = src_current.get(comp.id, 0.0)
        vt = V[g] if energized[g] else 0.0
        out_sources.append(DCLoadFlowSource(
            source_id=comp.id, source_name=(comp.props.get("name") or comp.id),
            source_type=comp.type, bus_id=g, voltage_v=round(vt, 2),
            current_a=round(i_out, 2), power_kw=round(i_out * vt / 1000.0, 3),
            loading_pct=round(abs(i_out) / rated * 100.0, 1) if rated else 0.0,
            current_limited=src_limited.get(comp.id, False),
        ))

    # Warnings: de-energized buses, voltage bands, overloaded branches/sources.
    for b in dc_buses:
        r = out_buses[b.id]
        if not r.energized:
            warnings.append(LoadFlowWarning(
                elementId=b.id, element_name=r.bus_name,
                message="DC bus is in an island with no active source (de-energized)."))
        elif abs(r.drop_pct) > 5.0:
            warnings.append(LoadFlowWarning(
                elementId=b.id, element_name=r.bus_name,
                message=f"DC bus voltage deviates {r.drop_pct:.1f}% from nominal "
                        f"({r.voltage_v:.1f} V vs {r.nominal_v:.0f} V).",
                expected_kv=round(r.nominal_v / 1000.0, 4),
                actual_kv=round(r.voltage_v / 1000.0, 4)))
    for br in out_branches:
        if br.loading_pct > 100.0:
            warnings.append(LoadFlowWarning(
                elementId=br.elementId, element_name=br.element_name,
                message=f"DC cable overloaded: {br.current_a:.0f} A ({br.loading_pct:.0f}% of rating)."))
    for s in out_sources:
        if s.current_limited:
            warnings.append(LoadFlowWarning(
                elementId=s.source_id, element_name=s.source_name,
                message=f"{s.source_name} is current-limited at {s.current_a:.0f} A — "
                        f"the load exceeds its rating."))

    return DCLoadFlowResults(
        buses=out_buses, branches=out_branches, sources=out_sources,
        warnings=warnings, converged=True, iterations=iterations,
    )


def _bus_load_kw(comp, v):
    """kW a dc_load draws at voltage v (for reporting)."""
    model = str(comp.props.get("load_model", "constant_power"))
    if model == "constant_current":
        return _num(comp.props.get("load_a", 0), 0) * v / 1000.0
    if model == "constant_resistance":
        r = _num(comp.props.get("resistance_ohm", 0), 0)
        return (v * v / r) / 1000.0 if r > 0 else 0.0
    return _num(comp.props.get("load_kw", 0), 0)
