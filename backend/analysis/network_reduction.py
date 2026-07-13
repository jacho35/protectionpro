"""Positive-sequence network reduction to a multi-port Thevenin equivalent.

Builds the bus-impedance submatrix **Z** among a requested set of "port" buses
(e.g. the terminal buses of several motors) so a time-domain study that injects
current at more than one bus at once can resolve the buses' mutual coupling —
the multi-port generalisation of the single-bus Thevenin used by
``motor_starting.py`` / ``dynamic_motor_starting.py``.

    V_port = V_pre − Z · I_inj

where ``I_inj`` is the vector of currents injected *into* the network at the
port buses (a motor drawing current is a negative injection). ``Z`` is complex,
symmetric, size = number of distinct port buses.

Modelling conventions (kept deliberately identical to the engines this feeds):

* Sources are replaced by their internal (Thevenin) impedance to the reference
  node, using the **same** per-unit impedance primitives as the IEC 60909 fault
  engine but evaluated at **c = 1.0** (operating voltage, not the worst-case
  fault factor). Consequently the diagonal ``Z_ii`` reproduces the driving-point
  impedance that ``dynamic_motor_starting._thevenin_at_bus`` computes for a
  radial network (which is the single-motor study's network model), while the
  off-diagonal ``Z_ij`` adds the cross-bus coupling that study could not see.
* **Motors and static loads are excluded** from Z — motors are the dynamic
  current injections, and loads are folded into the pre-start voltage vector,
  matching the existing single-motor superposition.
* Everything is per-unit on the system base (``project.baseMVA``); the p.u.
  impedance of a branch is invariant across an ideal nominal-ratio transformer,
  so bus voltage zones only matter for cable impedance bases (handled exactly as
  the fault walker does).
"""

import numpy as np

from .loadflow import (
    _build_bus_groups,
    _find_bus_paths,
    _get_impedance,
    _get_chain_turns_ratio,
    _is_transparent_and_closed,
)
from .fault import (
    _utility_impedance,
    _generator_impedance,
    _solar_pv_impedance,
    _battery_impedance,
    _wind_turbine_impedance,
    _transformer_far_voltage,
)

# Sources modelled as a Thevenin shunt impedance to the reference node. Motors
# are intentionally absent — they are the dynamic injections, not the network.
SOURCE_TYPES = ("utility", "generator", "solar_pv", "battery", "wind_turbine")


def _source_internal_z(comp, base_mva, c):
    """Source internal (Thevenin) positive-sequence impedance, p.u. system base."""
    t = comp.type
    if t == "utility":
        return _utility_impedance(comp, base_mva, c)
    if t == "generator":
        return _generator_impedance(comp, base_mva)
    if t == "solar_pv":
        return _solar_pv_impedance(comp, base_mva)
    if t == "battery":
        return _battery_impedance(comp, base_mva)
    if t == "wind_turbine":
        return _wind_turbine_impedance(comp, base_mva)
    return None


def _source_stub(source_id, adjacency, components, bus_of, base_mva):
    """Impedance from a source to the first bus group it reaches.

    Handles the common ``utility → transformer → bus`` / ``gen → cable → bus``
    topologies where the source does not sit directly on a bus. Returns
    ``(bus_id, z_stub)`` (z_stub p.u. on system base) or ``None`` if the source
    reaches no bus (open/isolated). Cable impedance bases track the voltage zone
    exactly as ``fault._collect_source_paths`` does — the zone is anchored at the
    reached bus and flipped back across each transformer toward the source.
    """
    visited = {source_id}
    # BFS; each queue item carries the ordered list of branch elements walked.
    queue = [(nb, []) for nb in adjacency.get(source_id, [])]
    while queue:
        nid, path = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in bus_of:
            bus_id = bus_of[nid]
            bus_comp = components.get(bus_id)
            v = float((bus_comp.props.get("voltage_kv", 11) if bus_comp else 11) or 11)
            z = complex(0.0, 0.0)
            # Walk bus → source so cable bases use the correct voltage zone.
            # Operating-point impedances (loadflow convention, no IEC 60909 K_T)
            # to stay consistent with the load-flow-derived pre-start voltages.
            for e in reversed(path):
                if e.type == "transformer":
                    z += _get_impedance(e, base_mva)
                    v = _transformer_far_voltage(e, v)
                elif e.type == "cable":
                    z_base = (v ** 2) / base_mva
                    r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    npar = max(1, int(e.props.get("num_parallel", 1)))
                    z += complex(r / z_base, x / z_base) / npar
            return bus_id, z
        comp = components.get(nid)
        if not comp:
            continue
        if _is_transparent_and_closed(comp):
            for nb in adjacency.get(nid, []):
                if nb not in visited:
                    queue.append((nb, path))
        elif comp.type in ("cable", "transformer"):
            for nb in adjacency.get(nid, []):
                if nb not in visited:
                    queue.append((nb, path + [comp]))
        # else: blocked — open device, another source, a motor, or a load.
    return None


def build_branch_ybus(project):
    """Build the bus-to-bus admittance matrix of the passive branch network.

    Series cable/transformer chains (with the transformer off-nominal pi-model)
    and solid bus-to-bus links — NO source, load or shunt contributions. Mirrors
    ``loadflow.run_load_flow``'s branch assembly exactly. Returns a context dict
    with the branch Ybus and everything needed to add shunts / reduce further:
    ``{Y, bus_idx, buses, components, adjacency, bus_of, base_mva}`` — or ``None``
    if the network has no AC buses.
    """
    base_mva = project.baseMVA
    components = {c_.id: c_ for c_ in project.components}
    buses = [c_ for c_ in project.components
             if c_.type in ("bus", "distribution_board")
             and str(c_.props.get("system", "ac")).lower() != "dc"]
    if not buses:
        return None
    bus_idx = {b.id: i for i, b in enumerate(buses)}
    n = len(buses)

    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    bus_of = _build_bus_groups(buses, adjacency, components, bus_idx)
    Y = np.zeros((n, n), dtype=complex)

    # ── Series branch chains between buses (cables / transformers) ──
    processed_chains = set()
    for comp in project.components:
        if comp.type not in ("cable", "transformer"):
            continue
        if comp.id in bus_of:
            continue
        if comp.id in {eid for key in processed_chains for eid in key}:
            continue
        results = _find_bus_paths(comp.id, adjacency, components, bus_of)
        if len(results) < 2:
            continue  # source stub or dangling — handled via source shunts
        bus_a, path_a = results[0]
        bus_b, path_b = results[1]
        if bus_a == bus_b:
            continue

        all_elems = {}
        for _, path in results[:2]:
            for elem in path:
                all_elems[elem.id] = elem
        chain_key = frozenset(all_elems.keys())
        if chain_key in processed_chains:
            continue
        processed_chains.add(chain_key)

        has_xfmr = any(e.type == "transformer" for e in all_elems.values())
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
                    in_a = e.id in path_a_ids
                    in_b = e.id in path_b_ids
                    if in_a and not in_b:
                        v_kv = bus_a_v
                    elif in_b and not in_a:
                        v_kv = bus_b_v
                    else:
                        v_kv = bus_a_v if len(path_a) <= len(path_b) else bus_b_v
                    z_base = (v_kv ** 2) / base_mva
                    r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    z_total += complex(r / z_base, x / z_base)
                else:
                    z_total += _get_impedance(e, base_mva)
        else:
            z_total = sum((_get_impedance(e, base_mva) for e in all_elems.values()),
                          complex(0, 0))

        y = 1 / z_total if abs(z_total) > 1e-15 else complex(0, -1e6)
        i = bus_idx[bus_a]
        j = bus_idx[bus_b]
        t, hv_bus = _get_chain_turns_ratio(all_elems, bus_a, bus_b, components)
        if hv_bus == bus_a:
            Y[i, i] += y / (t * t)
            Y[j, j] += y
            Y[i, j] -= y / t
            Y[j, i] -= y / t
        elif hv_bus == bus_b:
            Y[i, i] += y
            Y[j, j] += y / (t * t)
            Y[i, j] -= y / t
            Y[j, i] -= y / t
        else:
            Y[i, i] += y
            Y[j, j] += y
            Y[i, j] -= y
            Y[j, i] -= y

    # ── Solid bus-to-bus links (through transparent elements only) ──
    linked_pairs = set()
    for bus in buses:
        visited = {bus.id}
        queue = list(adjacency.get(bus.id, []))
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in bus_idx:
                linked_pairs.add(tuple(sorted([bus.id, nid])))
                continue
            comp = components.get(nid)
            if comp and _is_transparent_and_closed(comp):
                for nb in adjacency.get(nid, []):
                    if nb not in visited:
                        queue.append(nb)
    for pair in linked_pairs:
        i = bus_idx[pair[0]]
        j = bus_idx[pair[1]]
        y_link = complex(0, -1e6)
        Y[i, i] += y_link
        Y[j, j] += y_link
        Y[i, j] -= y_link
        Y[j, i] -= y_link

    return {"Y": Y, "bus_idx": bus_idx, "buses": buses, "components": components,
            "adjacency": adjacency, "bus_of": bus_of, "base_mva": base_mva}


def source_shunt_bus(project, source_comp, ctx=None):
    """(bus_id, z_total) for a source: its internal impedance plus the stub to
    the first bus it reaches. ``z_total`` is p.u. on system base at c = 1.0, or
    ``None`` if the source reaches no bus / has no modelled impedance."""
    if ctx is None:
        ctx = build_branch_ybus(project)
        if ctx is None:
            return None
    z_src = _source_internal_z(source_comp, ctx["base_mva"], 1.0)
    if z_src is None:
        return None
    stub = _source_stub(source_comp.id, ctx["adjacency"], ctx["components"],
                        ctx["bus_of"], ctx["base_mva"])
    if stub is None:
        return None
    bus_id, z_stub = stub
    z_tot = z_stub + z_src
    return (bus_id, z_tot) if abs(z_tot) >= 1e-15 else None


def _build_thevenin_ybus(project, c=1.0):
    """Build the passive-network Ybus with sources as shunt impedances.

    Returns ``(Y, bus_idx)`` or ``(None, None)`` when the network has no buses
    or no grounded source. Branch topology comes from ``build_branch_ybus``;
    sources become shunt admittances and motors/loads are omitted.
    """
    ctx = build_branch_ybus(project)
    if ctx is None:
        return None, None
    Y, bus_idx = ctx["Y"], ctx["bus_idx"]
    base_mva = ctx["base_mva"]

    n_sources = 0
    for comp in project.components:
        if comp.type not in SOURCE_TYPES:
            continue
        z_src = _source_internal_z(comp, base_mva, c)
        if z_src is None:
            continue
        stub = _source_stub(comp.id, ctx["adjacency"], ctx["components"],
                            ctx["bus_of"], base_mva)
        if stub is None:
            continue
        bus_id, z_stub = stub
        z_tot = z_stub + z_src
        if abs(z_tot) < 1e-15:
            continue
        Y[bus_idx[bus_id], bus_idx[bus_id]] += 1.0 / z_tot
        n_sources += 1

    if n_sources == 0:
        return None, None  # no grounded reference — Y is singular
    return Y, bus_idx


def build_port_zbus(project, port_bus_ids, c=1.0):
    """Reduce the network to a multi-port Thevenin over ``port_bus_ids``.

    Returns a dict ``{"ports": [bus_id,...], "Z": ndarray}`` where ``Z[k, l]`` is
    the mutual impedance (p.u. system base) between port ``k`` and port ``l``, or
    ``None`` if the network has no grounded source or the requested buses are
    absent / the admittance matrix is singular.
    """
    Y, bus_idx = _build_thevenin_ybus(project, c=c)
    if Y is None:
        return None
    ports = [b for b in dict.fromkeys(port_bus_ids) if b in bus_idx]
    if not ports:
        return None
    try:
        Z = np.linalg.inv(Y)
    except np.linalg.LinAlgError:
        return None
    idx = [bus_idx[b] for b in ports]
    Zsub = Z[np.ix_(idx, idx)]
    return {"ports": ports, "Z": Zsub}
