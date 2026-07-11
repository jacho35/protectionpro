"""DC Short-Circuit — short-circuit currents in DC auxiliary systems.

Implements the superposition method of IEC 61660-1 for the two source types
that dominate stationary DC installations (substation, UPS, telecom):

  • Battery  — an EMF ``E_B`` behind the branch resistance/inductance to the
    fault. The standard's quasi steady-state and peak currents follow the RL
    step response the IEC 61660 time-function approximates:
        I_kB = 0.95 · E_B / R_BBr        (quasi steady-state)
        i_pB =        E_B / R_BBr        (peak, full EMF during the transient)
        τ_B  = L_BBr / R_BBr             (rise time constant)

  • Converter (rectifier / battery charger) — current-limited per
    IEC TR 60909-4: the partial short-circuit current is a fixed multiple of
    the converter's rated DC current (``dc_sc_factor``), independent of the
    downstream resistance. Peak ≈ 1.05 × quasi steady-state (fast, near-flat).

Each source's branch resistance to the fault is its internal resistance plus
the effective (Laplacian) resistance of the passive cable network between the
source's bus and the faulted bus. Partial currents are superposed at the
fault (conservative peak summation).

Simplifications (documented, matching the tool's engineering-estimate ethos):
the rigorous IEC 61660 rectifier subprocedure needs the feeding AC network's
short-circuit data; here converters are treated as current-limited sources.
Capacitor and DC-motor source contributions are not yet modelled.
"""

import math
import numpy as np

from ..models.schemas import (
    ProjectData, DCShortCircuitResults, DCShortCircuitBus,
    DCShortCircuitContribution, LoadFlowWarning,
)
from .dc_loadflow import (
    _num, _is_dc_bus, _bus_nominal_v, _build_bus_groups, _find_dc_branches,
    _attached_group, SOURCE_TYPES, CONVERTER_TYPES,
)

# Default converter short-circuit factors (× rated DC current). Chargers
# current-limit hard; uncontrolled rectifiers pass a larger surge.
_DEFAULT_SC_FACTOR = {"charger": 1.5, "rectifier": 3.0}


def _cable_inductance_h(comp, freq):
    """Loop inductance of a DC cable (H), estimated from its AC reactance."""
    x = _num(comp.props.get("x_per_km", 0.08), 0.08)
    length = _num(comp.props.get("length_km", 0.1), 0.1)
    npar = max(1, int(_num(comp.props.get("num_parallel", 1), 1)))
    if freq <= 0:
        freq = 50
    l_per_km = x / (2.0 * math.pi * freq)          # H/km per conductor
    return 2.0 * l_per_km * length / npar          # two-wire loop


def _source_sc_params(comp, freq):
    """(kind, E or None, R_int, L_int, I_rated, sc_factor)."""
    p = comp.props
    if comp.type == "dc_battery":
        u_nb = _num(p.get("nominal_v", 125), 125)
        # IEC 61660-1: open-circuit EMF E_B = 1.05·U_nB when not measured.
        e = _num(p.get("emf_v", 0), 0) or 1.05 * u_nb
        r_int = _num(p.get("internal_r_mohm", 20), 20) / 1000.0
        l_int = _num(p.get("internal_l_uh", 0), 0) * 1e-6
        return "battery", e, max(r_int, 1e-5), l_int, 0.0, 0.0
    # converter
    if comp.type == "rectifier":
        v = _num(p.get("voltage_dc_v", 125), 125)
        i_r = _num(p.get("rated_kw", 50), 50) * 1000.0 / max(v, 1.0)
    else:  # charger
        i_r = _num(p.get("rated_a", 200), 200)
    factor = _num(p.get("dc_sc_factor", 0), 0) or _DEFAULT_SC_FACTOR.get(comp.type, 2.0)
    return "converter", None, 0.0, 0.0, i_r, factor


def _effective_resistance(island_groups, branches_r, branches_l):
    """Return (R_eff_fn, L_path_fn) for a passive DC branch network.

    R_eff uses the Moore-Penrose pseudo-inverse of the conductance Laplacian
    (exact node-to-node resistance, including parallel paths). L_path uses the
    shortest-resistance path inductance (adequate for the near-radial DC
    systems this serves)."""
    idx = {g: i for i, g in enumerate(island_groups)}
    m = len(island_groups)
    L = np.zeros((m, m))
    for (ga, gb), r in branches_r.items():
        if ga in idx and gb in idx:
            a, b = idx[ga], idx[gb]
            g = 1.0 / r
            L[a, a] += g
            L[b, b] += g
            L[a, b] -= g
            L[b, a] -= g
    Lp = np.linalg.pinv(L) if m > 1 else np.zeros((1, 1))

    # Dijkstra on resistance for the inductance of the least-resistance path.
    adj = {}
    for (ga, gb), r in branches_r.items():
        adj.setdefault(ga, []).append((gb, r, branches_l.get((ga, gb), 0.0)))
        adj.setdefault(gb, []).append((ga, r, branches_l.get((ga, gb), 0.0)))

    def r_eff(a, b):
        if a == b:
            return 0.0
        if a not in idx or b not in idx:
            return float("inf")
        ia, ib = idx[a], idx[b]
        return float(Lp[ia, ia] + Lp[ib, ib] - 2 * Lp[ia, ib])

    def l_path(a, b):
        if a == b:
            return 0.0
        dist = {a: (0.0, 0.0)}  # node -> (resistance, accumulated L)
        pq = [(0.0, 0.0, a)]
        import heapq
        while pq:
            rr, ll, node = heapq.heappop(pq)
            if node == b:
                return ll
            if rr > dist.get(node, (float("inf"),))[0]:
                continue
            for (nb, r, l) in adj.get(node, []):
                nr = rr + r
                if nr < dist.get(nb, (float("inf"), 0.0))[0]:
                    dist[nb] = (nr, ll + l)
                    heapq.heappush(pq, (nr, ll + l, nb))
        return dist.get(b, (0.0, 0.0))[1]

    return r_eff, l_path


def run_dc_short_circuit(project: ProjectData, fault_bus_id=None) -> DCShortCircuitResults:
    components = {c.id: c for c in project.components}
    dc_buses = [c for c in project.components if _is_dc_bus(c)]
    warnings = []
    if not dc_buses:
        return DCShortCircuitResults(
            converged=False,
            warnings=[LoadFlowWarning(elementId="", message=(
                "No DC buses in the network. Set a bus's System property to 'DC' "
                "to model a DC network."))])

    freq = project.frequency or 50
    bus_ids = {b.id for b in project.components if b.type == "bus"}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    bus_of = _build_bus_groups(dc_buses, adjacency, components, bus_ids)
    groups = [b.id for b in dc_buses]
    nominal = {b.id: _bus_nominal_v(b) for b in dc_buses}
    name_of = {b.id: (b.props.get("name") or b.id) for b in dc_buses}

    branches = _find_dc_branches(components, adjacency, bus_of, bus_ids)
    branches_r, branches_l = {}, {}
    for rep, ga, gb, r, _amp in branches:
        branches_r[(ga, gb)] = min(branches_r.get((ga, gb), float("inf")), r)
        branches_l[(ga, gb)] = _cable_inductance_h(rep, freq)

    # Islands via union-find over branches.
    parent = {g: g for g in groups}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for (ga, gb) in branches_r:
        parent[find(ga)] = find(gb)
    islands = {}
    for g in groups:
        islands.setdefault(find(g), []).append(g)

    # Sources with their attached group.
    src_list = []  # (comp, group, kind, E, R_int, L_int, I_rated, factor)
    for comp in project.components:
        if comp.type in SOURCE_TYPES:
            g = _attached_group(comp, adjacency, components, bus_of, bus_ids)
            if g is not None:
                src_list.append((comp, g) + _source_sc_params(comp, freq))

    # Effective-resistance functions per island.
    reff_fns = {}
    for root, isl in islands.items():
        reff_fns[root] = _effective_resistance(isl, branches_r, branches_l)

    targets = [fault_bus_id] if fault_bus_id else groups
    out = {}
    for fbus in targets:
        if fbus not in nominal:
            continue
        root = find(fbus)
        r_eff, l_path = reff_fns[root]
        contribs = []
        total_ik = 0.0
        total_ip = 0.0
        tp_max = 0.0
        tau_dom = 0.0
        dom_ip = 0.0
        for (comp, g, kind, e, r_int, l_int, i_r, factor) in src_list:
            if find(g) != root:
                continue  # different island — no contribution
            r_net = r_eff(g, fbus)
            if not math.isfinite(r_net):
                continue
            if kind == "battery":
                # IEC 61660-1 refinements (applied to raw nameplate inputs):
                #   peak resistance uses 0.9·R_B; quasi steady-state uses the
                #   full physical R_B (= 0.9·R_B + 0.1·R_B); E_B = 1.05·U_nB
                #   is already folded into `e`.
                r_peak = 0.9 * r_int + r_net      # peak-current branch R
                r_ik = r_int + r_net              # quasi-steady branch R
                l_br = l_int + l_path(g, fbus)
                ip = e / r_peak / 1000.0          # kA (peak, full EMF)
                ik = 0.95 * e / r_ik / 1000.0     # kA (quasi steady-state)
                # Rise-time constant: L/R when the branch inductance is known,
                # else the IEC 61660-1 battery time constant T_B ≈ 30 ms.
                tau = (l_br / r_ik) if (l_br > 0 and r_ik > 0) else 0.030
                tp = min(0.05, 3.0 * tau)
                tp_ms = tp * 1000.0
                r_br = r_ik                       # reported R_BBr (physical)
            else:  # converter — current-limited
                ik = factor * i_r / 1000.0        # kA
                ip = 1.05 * ik
                tau = 0.0
                tp_ms = 5.0
                r_br = r_int + r_net
            contribs.append(DCShortCircuitContribution(
                source_id=comp.id, source_name=(comp.props.get("name") or comp.id),
                source_type=comp.type, ik_ka=round(ik, 3), ip_ka=round(ip, 3),
                tp_ms=round(tp_ms, 2), r_mohm=round(r_br * 1000.0, 3)))
            total_ik += ik
            total_ip += ip
            tp_max = max(tp_max, tp_ms)
            if ip > dom_ip:
                dom_ip = ip
                tau_dom = tau
        note = ""
        if not contribs:
            note = "No DC source in this island — no short-circuit infeed."
        out[fbus] = DCShortCircuitBus(
            bus_id=fbus, bus_name=name_of[fbus], nominal_v=round(nominal[fbus], 1),
            ik_ka=round(total_ik, 3), ip_ka=round(total_ip, 3),
            tp_ms=round(tp_max, 2), time_constant_ms=round(tau_dom * 1000.0, 2),
            contributions=contribs, note=note)

    for b in dc_buses:
        r = out.get(b.id)
        if r and not r.contributions:
            warnings.append(LoadFlowWarning(
                elementId=b.id, element_name=r.bus_name,
                message="DC bus has no source in its island — no short-circuit current."))

    return DCShortCircuitResults(buses=out, warnings=warnings, converged=True)
