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


def _find_buses_for_element(comp_id, adjacency, components, bus_idx):
    """Walk from a branch element through transparent elements, cables, and
    transformers to find connected buses.  This allows cable-transformer chains
    (no intermediate bus) to still discover the endpoint buses."""
    visited = {comp_id}
    queue = list(adjacency.get(comp_id, []))
    found = []
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in bus_idx:
            found.append(nid)
            continue
        comp = components.get(nid)
        if not comp:
            continue
        # Walk through transparent elements AND other branch elements (cable/transformer)
        if _is_transparent_and_closed(comp) or comp.type in ("cable", "transformer"):
            for neighbor_id in adjacency.get(nid, []):
                if neighbor_id not in visited:
                    queue.append(neighbor_id)
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

    # Find branches between buses (through transformers, cables, walking through CBs/switches)
    branch_elements = []
    for comp in project.components:
        if comp.type in ("transformer", "cable"):
            connected_buses = _find_buses_for_element(
                comp.id, adjacency, components, bus_idx
            )
            if len(connected_buses) >= 2:
                i = bus_idx[connected_buses[0]]
                j = bus_idx[connected_buses[1]]
                y = _get_admittance(comp, base_mva)
                Y[i, i] += y
                Y[j, j] += y
                Y[i, j] -= y
                Y[j, i] -= y
                branch_elements.append((comp, connected_buses[0], connected_buses[1], y))

    # Find direct bus-to-bus connections (solid links / bus couplers)
    # Walk from each bus through transparent elements; if we reach another bus, add link
    linked_pairs = set()
    for bus in buses:
        connected_buses = _find_buses_for_element(bus.id, adjacency, components, bus_idx)
        for other_id in connected_buses:
            pair = tuple(sorted([bus.id, other_id]))
            if pair not in linked_pairs:
                linked_pairs.add(pair)
                i = bus_idx[bus.id]
                j = bus_idx[other_id]
                # Very low impedance link (effectively zero impedance bus coupler)
                y_link = complex(1e6, 0)  # very high admittance = very low impedance
                Y[i, i] += y_link
                Y[j, j] += y_link
                Y[i, j] -= y_link
                Y[j, i] -= y_link
                # Record as branch for flow reporting
                branch_elements.append((None, bus.id, other_id, y_link))

    # Set up power injections
    P_spec = np.zeros(n)  # specified real power (generation - load)
    Q_spec = np.zeros(n)  # specified reactive power
    bus_types = []  # 0=PQ, 1=PV, 2=Swing
    V_spec = np.ones(n)  # specified voltage magnitudes

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
                # Add source admittance
                y_src = _utility_admittance(comp, base_mva)
                Y[i, i] += y_src
            elif comp.type == "generator":
                rated = comp.props.get("rated_mva", 10)
                pf = comp.props.get("power_factor", 0.85)
                P_spec[i] += rated * pf / base_mva  # p.u.
                Q_spec[i] += rated * math.sqrt(1 - pf**2) / base_mva
            elif comp.type == "static_load":
                rated = comp.props.get("rated_kva", 100) / 1000  # MVA
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
                Q_spec[i] += kvar / 1000 / base_mva  # Capacitor injects Q

    # Solve
    if method == "gauss_seidel":
        V, converged, iterations = _gauss_seidel(Y, P_spec, Q_spec, V_spec, bus_types)
    else:
        V, converged, iterations = _newton_raphson(Y, P_spec, Q_spec, V_spec, bus_types)

    # Build results
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

    # Branch flows
    branch_results = []
    for comp, from_bus, to_bus, y in branch_elements:
        i = bus_idx[from_bus]
        j = bus_idx[to_bus]
        i_branch_pu = (V[i] - V[j]) * y
        s_ij = V[i] * np.conj(i_branch_pu)
        s_ji = V[j] * np.conj(-i_branch_pu)
        p_mw = s_ij.real * base_mva
        q_mvar = s_ij.imag * base_mva
        s_mva = abs(s_ij) * base_mva

        # Losses = power in from side + power in to side
        losses_mw = (s_ij.real + s_ji.real) * base_mva

        # Current in amps: use from-bus voltage
        from_bus_comp = components.get(from_bus)
        v_kv_from = from_bus_comp.props.get("voltage_kv", 11) if from_bus_comp else 11
        i_amps = (s_mva * 1000) / (math.sqrt(3) * v_kv_from) if v_kv_from > 0 else 0

        # Loading percentage (for cables and transformers)
        loading = 0
        if comp and comp.type == "cable":
            rated_a = comp.props.get("rated_amps", 400)
            v_kv = comp.props.get("voltage_kv", 11)
            rated_mva = math.sqrt(3) * v_kv * rated_a / 1000
            loading = (s_mva / rated_mva * 100) if rated_mva > 0 else 0
        elif comp and comp.type == "transformer":
            rated_mva = comp.props.get("rated_mva", 10)
            loading = (s_mva / rated_mva * 100) if rated_mva > 0 else 0

        # Element identification
        elem_id = comp.id if comp else f"link_{from_bus}_{to_bus}"
        elem_name = comp.props.get("name", comp.type) if comp else "Bus Link"

        branch_results.append(LoadFlowBranch(
            elementId=elem_id,
            element_name=elem_name,
            from_bus=from_bus,
            to_bus=to_bus,
            p_mw=round(p_mw, 4),
            q_mvar=round(q_mvar, 4),
            s_mva=round(s_mva, 4),
            i_amps=round(i_amps, 2),
            loading_pct=round(loading, 2),
            losses_mw=round(losses_mw, 6),
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


def _get_admittance(comp, base_mva):
    """Get branch admittance in per-unit."""
    if comp.type == "transformer":
        rated_mva = comp.props.get("rated_mva", 10)
        z_pct = comp.props.get("z_percent", 8)
        xr = comp.props.get("x_r_ratio", 10)
        z_pu = (z_pct / 100) * base_mva / rated_mva
        x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
        r_pu = x_pu / xr
        z = complex(r_pu, x_pu)
        return 1 / z if abs(z) > 1e-15 else complex(0, 0)
    elif comp.type == "cable":
        v_kv = comp.props.get("voltage_kv", 11)
        z_base = (v_kv ** 2) / base_mva
        r = comp.props.get("r_per_km", 0.1) * comp.props.get("length_km", 1)
        x = comp.props.get("x_per_km", 0.08) * comp.props.get("length_km", 1)
        z = complex(r / z_base, x / z_base)
        return 1 / z if abs(z) > 1e-15 else complex(0, 0)
    return complex(0, 0)


def _utility_admittance(comp, base_mva):
    """Utility source admittance."""
    fault_mva = comp.props.get("fault_mva", 500)
    xr = comp.props.get("x_r_ratio", 15)
    z_pu = base_mva / fault_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    z = complex(r_pu, x_pu)
    return 1 / z if abs(z) > 1e-15 else complex(0, 0)
