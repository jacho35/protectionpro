"""Load Flow Analysis — Newton-Raphson and Gauss-Seidel solvers.

Solves the power flow equations for bus voltages and branch flows
using per-unit system on a common MVA base.
"""

import math
import numpy as np
from ..models.schemas import (
    ProjectData, LoadFlowResults, LoadFlowBus, LoadFlowBranch, LoadFlowWarning
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
            y = complex(1e6, 0)

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
        y_link = complex(1e6, 0)
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

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")

        # Bus-type priority:
        #   1. Bus with utility source → always Swing (infinite-bus reference)
        #   2. Bus user-labelled "Swing" but utility is elsewhere → demote to PQ
        #      (generators there inject via P_spec, which NR enforces for PQ buses)
        #   3. Otherwise honour user setting
        if bus.id in _utility_bus_ids:
            bus_types.append(2)  # Swing
        elif bt == "Swing":
            if _utility_bus_ids:
                # Utility elsewhere provides slack — demote to PQ so generator
                # P_spec injections are enforced by the NR solver
                bus_types.append(0)
            else:
                bus_types.append(2)  # No utility in network, keep user swing
        elif bt == "PV":
            bus_types.append(1)
        else:
            bus_types.append(0)

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
                rated = comp.props.get("rated_mva", 10)
                pf = comp.props.get("power_factor", 0.85)
                P_spec[i] += rated * pf / base_mva
                Q_spec[i] += rated * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "solar_pv":
                rated_kw = comp.props.get("rated_kw", 100)
                n_inv = comp.props.get("num_inverters", 1)
                eff = comp.props.get("inverter_eff", 0.97)
                pf = comp.props.get("power_factor", 1.0)
                irr = comp.props.get("irradiance_pct", 100) / 100.0
                rated_mva = rated_kw * n_inv * irr / (eff * 1000)
                P_spec[i] += rated_mva * abs(pf) / base_mva
                if pf < 0:
                    Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) / base_mva
                else:
                    Q_spec[i] += rated_mva * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "wind_turbine":
                rated = comp.props.get("rated_mva", 2.0)
                n_turb = comp.props.get("num_turbines", 1)
                pf = comp.props.get("power_factor", 0.95)
                wind_pct = comp.props.get("wind_speed_pct", 100) / 100.0
                total_mva = rated * n_turb * wind_pct
                P_spec[i] += total_mva * abs(pf) / base_mva
                if pf < 0:
                    Q_spec[i] -= total_mva * math.sqrt(1 - pf**2) / base_mva
                else:
                    Q_spec[i] += total_mva * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "static_load":
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                P_spec[i] -= rated * pf * df / base_mva
                Q_spec[i] -= rated * math.sqrt(1 - pf**2) * df / base_mva
            elif comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = rated_kw / eff / 1000
                P_spec[i] -= rated_mva * pf * df / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) * df / base_mva
            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                pf = comp.props.get("power_factor", 0.9)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = rated_kva / 1000
                P_spec[i] -= rated_mva * pf * df / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) * df / base_mva
            elif comp.type == "capacitor_bank":
                kvar = comp.props.get("rated_kvar", 100)
                Q_spec[i] += kvar / 1000 / base_mva

    # ── Solve ──
    if method == "gauss_seidel":
        V, converged, iterations = _gauss_seidel(Y, P_spec, Q_spec, V_spec, bus_types)
    else:
        V, converged, iterations = _newton_raphson(Y, P_spec, Q_spec, V_spec, bus_types)

    # ── Build results ──
    # Compute actual bus power injections from solved voltages.
    # S_bus = V * conj(Y @ V) gives the true injection at each bus,
    # including the swing bus whose scheduled injection is zero but
    # which actually supplies all system losses and unspecified power.
    I_bus = Y @ V
    S_bus = V * np.conj(I_bus)

    bus_results = {}
    for bus in buses:
        i = bus_idx[bus.id]
        v_kv = bus.props.get("voltage_kv", 11)
        bus_results[bus.id] = LoadFlowBus(
            bus_id=bus.id,
            bus_name=bus.props.get("name", bus.id),
            voltage_pu=round(abs(V[i]), 6),
            voltage_kv=round(abs(V[i]) * v_kv, 4),
            angle_deg=round(math.degrees(np.angle(V[i])), 4),
            p_mw=round(S_bus[i].real * base_mva, 4),
            q_mvar=round(S_bus[i].imag * base_mva, 4),
        )

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
            # Report flow for each element in the series chain
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

        # ── Swing bus: proportional load sharing among ALL sources ──
        if is_swing and gen_sources:
            s_actual = S_bus[bus_i] * base_mva  # complex MVA total demand

            # Build the source pool: (kind, object(s), rated_mva)
            source_pool = []
            for src in gen_sources:
                _p, _q, s_rated, rated_mva = _source_output_mva(src)
                source_pool.append(('gen', src, rated_mva))

            if has_utility_via_tx and not has_utility:
                # Utility behind TX: TX rating limits utility contribution
                for tx, util in _utility_tx_bus_map[bus.id]:
                    tx_rated = tx.props.get("rated_mva", 10)
                    source_pool.append(('util_tx', (tx, util), tx_rated))

            total_pool_mva = sum(entry[2] for entry in source_pool)

            for kind, obj, rated_mva in source_pool:
                if total_pool_mva <= 0 or rated_mva <= 0:
                    continue
                fraction = rated_mva / total_pool_mva
                p_out = s_actual.real * fraction
                q_out = s_actual.imag * fraction
                s_out = abs(s_actual) * fraction
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
                    fault_mva = util.props.get("fault_mva", 500)
                    util_loading = (s_out / fault_mva * 100) if fault_mva > 0 else 0
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
            _gen_actual_p = s_actual.real * gen_pool_mva / total_pool_mva if total_pool_mva > 0 else 0
            _gen_actual_q = s_actual.imag * gen_pool_mva / total_pool_mva if total_pool_mva > 0 else 0

        elif gen_sources:
            # Non-swing bus: NR enforces P_spec → generator injects at rated.
            for src in gen_sources:
                _p, _q, s_rated, rated_mva = _source_output_mva(src)
                if rated_mva <= 0:
                    continue
                i_amps = (s_rated * 1000) / (math.sqrt(3) * v_kv_actual) if v_kv_actual > 0 else 0
                branch_results.append(LoadFlowBranch(
                    elementId=src.id,
                    element_name=src.props.get("name", src.type),
                    from_bus=src.id, to_bus=bus.id,
                    p_mw=round(_p, 4), q_mvar=round(_q, 4),
                    s_mva=round(s_rated, 4), i_amps=round(i_amps, 2),
                    loading_pct=round(s_rated / rated_mva * 100, 2), losses_mw=0,
                ))

        # ── Utility source annotations (directly connected) ──
        if util_sources:
            s_bus_total = S_bus[bus_i] * base_mva
            if gen_sources and is_swing:
                s_util = complex(s_bus_total.real - _gen_actual_p,
                                 s_bus_total.imag - _gen_actual_q)
            elif gen_sources:
                gen_p_rated = sum(_source_output_mva(s)[0] for s in gen_sources)
                gen_q_rated = sum(_source_output_mva(s)[1] for s in gen_sources)
                s_util = complex(s_bus_total.real - gen_p_rated,
                                 s_bus_total.imag - gen_q_rated)
            else:
                s_util = s_bus_total

            for util in util_sources:
                fault_mva = util.props.get("fault_mva", 500)
                s_out = abs(s_util)
                loading = (s_out / fault_mva * 100) if fault_mva > 0 else 0
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

                fault_mva = util.props.get("fault_mva", 500)
                util_loading = (s_this_mva / fault_mva * 100) if fault_mva > 0 else 0
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

    return LoadFlowResults(
        buses=bus_results,
        branches=branch_results,
        warnings=voltage_warnings,
        converged=converged,
        iterations=iterations,
        method=method,
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
        if np.max(np.abs(mismatch)) < TOLERANCE:
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
                Q_calc = -(V[i] * np.conj(sum_yv + Y[i, i] * V[i])).imag
                S_spec = complex(P_spec[i], Q_calc)
                if abs(V[i]) > 1e-10:
                    V[i] = (1 / Y[i, i]) * (np.conj(S_spec) / np.conj(V[i]) - sum_yv)
                # Fix voltage magnitude
                V[i] = V_mag[i] * V[i] / abs(V[i])

        # Check convergence
        max_diff = np.max(np.abs(V - V_old))
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
