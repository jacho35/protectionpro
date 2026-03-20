"""Load Flow Analysis — Newton-Raphson and Gauss-Seidel solvers.

Solves the power flow equations for bus voltages and branch flows
using per-unit system on a common MVA base.
"""

import math
import numpy as np
from ..models.schemas import (
    ProjectData, LoadFlowResults, LoadFlowBus, LoadFlowBranch
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
        return complex(r / z_base, x / z_base)
    return complex(0, 0)


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

    # Build Y-bus admittance matrix
    Y = np.zeros((n, n), dtype=complex)

    # Build adjacency
    adjacency = {}
    for w in wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    # Build bus groups (bus + reachable transparent elements)
    bus_of = _build_bus_groups(buses, adjacency, components, bus_idx)

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
        z_total = sum((_get_impedance(e, base_mva) for e in all_elems.values()), complex(0, 0))

        if abs(z_total) > 1e-15:
            y = 1 / z_total
        else:
            y = complex(1e6, 0)

        i = bus_idx[bus_a]
        j = bus_idx[bus_b]
        Y[i, i] += y
        Y[j, j] += y
        Y[i, j] -= y
        Y[j, i] -= y

        branch_chains.append((all_elems, bus_a, bus_b, y))

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
        branch_chains.append((None, pair[0], pair[1], y_link))

    # ── Set up power injections ──
    P_spec = np.zeros(n)
    Q_spec = np.zeros(n)
    bus_types = []  # 0=PQ, 1=PV, 2=Swing
    V_spec = np.ones(n)

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")
        if bt == "Swing":
            bus_types.append(2)
        elif bt == "PV":
            bus_types.append(1)
        else:
            bus_types.append(0)

        # Find all components connected to this bus (walking through CBs/switches)
        connected = _find_components_at_bus(bus.id, adjacency, components)
        for comp in connected:
            if comp.type == "utility":
                y_src = _utility_admittance(comp, base_mva)
                Y[i, i] += y_src
            elif comp.type == "generator":
                rated = comp.props.get("rated_mva", 10)
                pf = comp.props.get("power_factor", 0.85)
                P_spec[i] += rated * pf / base_mva
                Q_spec[i] += rated * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "static_load":
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                P_spec[i] -= rated * pf / base_mva
                Q_spec[i] -= rated * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                rated_mva = rated_kw / eff / 1000
                P_spec[i] -= rated_mva * pf / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                pf = comp.props.get("power_factor", 0.9)
                rated_mva = rated_kva / 1000
                P_spec[i] -= rated_mva * pf / base_mva
                Q_spec[i] -= rated_mva * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "capacitor_bank":
                kvar = comp.props.get("rated_kvar", 100)
                Q_spec[i] += kvar / 1000 / base_mva

    # ── Solve ──
    if method == "gauss_seidel":
        V, converged, iterations = _gauss_seidel(Y, P_spec, Q_spec, V_spec, bus_types)
    else:
        V, converged, iterations = _newton_raphson(Y, P_spec, Q_spec, V_spec, bus_types)

    # ── Build results ──
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
            p_mw=round(P_spec[i] * base_mva, 4),
            q_mvar=round(Q_spec[i] * base_mva, 4),
        )

    # ── Branch flows ──
    branch_results = []
    for elems, from_bus, to_bus, y in branch_chains:
        i = bus_idx[from_bus]
        j = bus_idx[to_bus]
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
            for elem in elems.values():
                loading = 0
                if elem.type == "cable":
                    v_kv = elem.props.get("voltage_kv", 11)
                    elem_i_amps = (s_mva * 1000) / (math.sqrt(3) * v_kv) if v_kv > 0 else 0
                    rated_a = elem.props.get("rated_amps", 400)
                    rated_mva = math.sqrt(3) * v_kv * rated_a / 1000
                    loading = (s_mva / rated_mva * 100) if rated_mva > 0 else 0
                elif elem.type == "transformer":
                    rated_mva_xfmr = elem.props.get("rated_mva", 10)
                    loading = (s_mva / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0
                    # Report current at the LV side (higher current)
                    lv_kv = min(
                        elem.props.get("voltage_hv_kv", 11),
                        elem.props.get("voltage_lv_kv", 0.42)
                    )
                    elem_i_amps = (s_mva * 1000) / (math.sqrt(3) * lv_kv) if lv_kv > 0 else 0
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

    return LoadFlowResults(
        buses=bus_results,
        branches=branch_results,
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
