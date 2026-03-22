"""Unbalanced Load Flow Analysis — Symmetrical Component Method.

Solves three-phase unbalanced power systems using positive, negative,
and zero sequence networks:

  - Positive sequence (Y1): solved via Newton-Raphson (reuses balanced LF solver)
  - Negative sequence (Y2): linear solve with unbalanced load injections
  - Zero sequence (Y0):     linear solve; transformer delta windings block Z0

Per-phase load unbalance is specified on static_load components via:
  phase_a_pct, phase_b_pct, phase_c_pct  (% of total load, default 33.33 each)

Outputs per bus:
  - Per-phase voltages (Va, Vb, Vc) in p.u. and kV
  - Sequence voltages (V1, V2, V0)
  - Voltage Unbalance Factor: VUF = |V2|/|V1| × 100%  (IEC 61000-3-13)

Outputs per branch:
  - Per-phase currents (Ia, Ib, Ic) and neutral current In
  - Sequence currents (I1, I2, I0)
  - Loading %
"""

import math
import numpy as np
from ..models.schemas import (
    ProjectData, LoadFlowWarning,
    UnbalancedLoadFlowBus, UnbalancedLoadFlowBranch, UnbalancedLoadFlowResults,
)
from .loadflow import (
    _build_bus_groups, _find_bus_paths, _get_impedance, _is_transparent_and_closed,
    _find_components_at_bus, _get_chain_turns_ratio, _utility_admittance,
    _newton_raphson, _gauss_seidel,
)

# Symmetrical component rotation operator: a = 1∠120°
_a = np.exp(1j * 2 * math.pi / 3)

# Transform matrix: [Va, Vb, Vc] = A * [V0, V1, V2]
_A = np.array([
    [1,      1,       1      ],
    [1,      _a**2,   _a     ],
    [1,      _a,      _a**2  ],
], dtype=complex)

# Inverse: [V0, V1, V2] = A_inv * [Va, Vb, Vc]
_A_inv = np.array([
    [1,  1,       1      ],
    [1,  _a,      _a**2  ],
    [1,  _a**2,   _a     ],
], dtype=complex) / 3


def _xfmr_blocks_zero_seq(comp) -> bool:
    """Return True if any transformer winding blocks zero-sequence current.

    Delta windings (d/D) and ungrounded wye (Y/y without following N/n)
    block zero-sequence current flow through the transformer.
    """
    vg = comp.props.get("vector_group", "Dyn11").strip()

    # Delta winding always blocks zero sequence
    if any(c in ('d', 'D') for c in vg if c.isalpha()):
        return True

    # Ungrounded wye: Y or y not immediately followed by N or n
    for i, c in enumerate(vg):
        if c in ('Y', 'y'):
            next_c = vg[i + 1] if i + 1 < len(vg) else ''
            if next_c not in ('N', 'n'):
                return True  # Ungrounded wye — blocks zero sequence

    return False


def _add_to_ybus(Y, i, j, y, t, hv_bus_id, bus_a_id, bus_b_id):
    """Add branch admittance to Y-bus using transformer pi-model when applicable."""
    if hv_bus_id == bus_a_id:
        Y[i, i] += y / (t * t)
        Y[j, j] += y
        Y[i, j] -= y / t
        Y[j, i] -= y / t
    elif hv_bus_id == bus_b_id:
        Y[i, i] += y
        Y[j, j] += y / (t * t)
        Y[i, j] -= y / t
        Y[j, i] -= y / t
    else:
        Y[i, i] += y
        Y[j, j] += y
        Y[i, j] -= y
        Y[j, i] -= y


def run_unbalanced_load_flow(
    project: ProjectData,
    method: str = "newton_raphson",
) -> UnbalancedLoadFlowResults:
    """Run three-phase unbalanced load flow using symmetrical components."""

    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}
    wires = project.wires

    buses = [c for c in project.components if c.type == "bus"]
    if not buses:
        return UnbalancedLoadFlowResults(
            buses={}, branches=[], warnings=[],
            converged=False, iterations=0,
            method="Sequence Component (Unbalanced)",
        )

    n = len(buses)
    bus_idx = {b.id: i for i, b in enumerate(buses)}

    # ── Build adjacency ──
    adjacency: dict[str, list[str]] = {}
    for w in wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    bus_of = _build_bus_groups(buses, adjacency, components, bus_idx)

    # ── Discover branch chains ──
    processed_chains: set = set()
    # Each entry: (elems, bus_a, bus_b, y1, y2, y0, t, hv_bus, cable_voltages)
    branch_chains = []

    for comp in project.components:
        if comp.type not in ("cable", "transformer"):
            continue
        if comp.id in bus_of:
            continue
        if comp.id in {eid for ck in processed_chains for eid in ck}:
            continue

        results = _find_bus_paths(comp.id, adjacency, components, bus_of)
        if len(results) < 2:
            continue

        bus_a, path_a = results[0]
        bus_b, path_b = results[1]
        if bus_a == bus_b:
            continue

        all_elems: dict = {}
        for _, path in results[:2]:
            for elem in path:
                all_elems[elem.id] = elem

        chain_key = frozenset(all_elems.keys())
        if chain_key in processed_chains:
            continue
        processed_chains.add(chain_key)

        has_xfmr = any(e.type == "transformer" for e in all_elems.values())
        cable_voltages: dict[str, float] = {}

        z1_total = complex(0, 0)
        z2_total = complex(0, 0)
        z0_total: complex | None = complex(0, 0)
        z0_blocked = False

        if has_xfmr:
            path_a_ids = {e.id for e in path_a}
            path_b_ids = {e.id for e in path_b}
            bus_a_v = (components[bus_a].props.get("voltage_kv", 11)
                       if bus_a in components else 11)
            bus_b_v = (components[bus_b].props.get("voltage_kv", 11)
                       if bus_b in components else 11)

            for e in all_elems.values():
                if e.type == "transformer":
                    z = _get_impedance(e, base_mva)
                    z1_total += z
                    z2_total += z           # Z2 = Z1 for transformer (passive element)
                    if _xfmr_blocks_zero_seq(e):
                        z0_blocked = True
                    else:
                        z0_total = (z0_total or complex(0, 0)) + z

                elif e.type == "cable":
                    in_a = e.id in path_a_ids and e.id not in path_b_ids
                    in_b = e.id in path_b_ids and e.id not in path_a_ids
                    v_kv = (bus_a_v if in_a else
                            bus_b_v if in_b else
                            (bus_a_v if len(path_a) <= len(path_b) else bus_b_v))
                    cable_voltages[e.id] = v_kv
                    z_base = (v_kv ** 2) / base_mva
                    r1 = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x1 = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    z1_cable = complex(r1 / z_base, x1 / z_base)
                    z1_total += z1_cable
                    z2_total += z1_cable
                    if not z0_blocked:
                        r0_prop = float(e.props.get("r0_per_km", 0))
                        x0_prop = float(e.props.get("x0_per_km", 0))
                        r0 = r0_prop if r0_prop > 0 else r1 * 3.5
                        x0 = x0_prop if x0_prop > 0 else x1 * 3.5
                        z0_total = (z0_total or complex(0, 0)) + complex(r0 / z_base, x0 / z_base)
                else:
                    z = _get_impedance(e, base_mva)
                    z1_total += z
                    z2_total += z
                    if not z0_blocked:
                        z0_total = (z0_total or complex(0, 0)) + z

        else:
            # No transformer — all cables
            for e in all_elems.values():
                z = _get_impedance(e, base_mva)
                z1_total += z
                z2_total += z
                if e.type == "cable":
                    v_kv = e.props.get("voltage_kv", 11)
                    z_base = (v_kv ** 2) / base_mva
                    r1 = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x1 = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    r0_prop = float(e.props.get("r0_per_km", 0))
                    x0_prop = float(e.props.get("x0_per_km", 0))
                    r0 = r0_prop if r0_prop > 0 else r1 * 3.5
                    x0 = x0_prop if x0_prop > 0 else x1 * 3.5
                    z0_total = (z0_total or complex(0, 0)) + complex(r0 / z_base, x0 / z_base)
                else:
                    z0_total = (z0_total or complex(0, 0)) + z * 3

        y1 = (1 / z1_total) if abs(z1_total) > 1e-15 else complex(1e6, 0)
        y2 = (1 / z2_total) if abs(z2_total) > 1e-15 else complex(1e6, 0)
        y0 = (0 if z0_blocked or z0_total is None
              else ((1 / z0_total) if abs(z0_total) > 1e-15 else complex(1e6, 0)))
        y0 = complex(y0)

        t, hv_bus = _get_chain_turns_ratio(all_elems, bus_a, bus_b, components)
        branch_chains.append((all_elems, bus_a, bus_b, y1, y2, y0, t, hv_bus, cable_voltages))

    # ── Initialise Y matrices ──
    Y1 = np.zeros((n, n), dtype=complex)
    Y2 = np.zeros((n, n), dtype=complex)
    Y0 = np.zeros((n, n), dtype=complex)

    for elems, bus_a, bus_b, y1, y2, y0, t, hv_bus, _ in branch_chains:
        i = bus_idx[bus_a]
        j = bus_idx[bus_b]
        _add_to_ybus(Y1, i, j, y1, t, hv_bus, bus_a, bus_b)
        # Negative/zero sequence: same tap ratio (passive element property, not sequence-dependent)
        _add_to_ybus(Y2, i, j, y2, t, hv_bus, bus_a, bus_b)
        _add_to_ybus(Y0, i, j, y0, 1.0, None, None, None)  # t=1 for zero-seq simplified model

    # ── Direct bus-to-bus links (through transparent elements only) ──
    linked_pairs: set = set()
    for bus in buses:
        visited = {bus.id}
        queue = list(adjacency.get(bus.id, []))
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in bus_idx:
                pair = tuple(sorted([bus.id, nid]))
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
        for Y in (Y1, Y2, Y0):
            Y[i, i] += y_link
            Y[j, j] += y_link
            Y[i, j] -= y_link
            Y[j, i] -= y_link
        branch_chains.append((None, pair[0], pair[1], y_link, y_link, y_link, 1.0, None, {}))

    # ── Per-phase power injections ──
    # P_phase[i, ph] and Q_phase[i, ph] in per-unit on base_mva (positive = generation)
    P_phase = np.zeros((n, 3))
    Q_phase = np.zeros((n, 3))
    bus_types = []
    V_spec = np.ones(n)

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")
        bus_types.append(2 if bt == "Swing" else (1 if bt == "PV" else 0))

        connected = _find_components_at_bus(bus.id, adjacency, components)
        for comp in connected:
            if comp.type == "utility":
                y_src = _utility_admittance(comp, base_mva)
                Y1[i, i] += y_src
                # Negative sequence: apply z2_z1_ratio if specified
                # Also accept legacy "x2_ratio" key for backwards compatibility
                z2_z1 = float(comp.props.get("z2_z1_ratio", 0) or comp.props.get("x2_ratio", 0))
                if z2_z1 > 0 and abs(z2_z1 - 1.0) > 1e-6:
                    # Z2 = Z1 * z2_z1_ratio, so Y2 = Y1 / z2_z1_ratio
                    Y2[i, i] += y_src / z2_z1
                else:
                    Y2[i, i] += y_src
                grounding = comp.props.get("grounding", "solidly")
                if grounding in ("solidly", "direct", ""):
                    # Zero sequence: apply z0_z1_ratio if specified
                    # Also accept legacy "x0_ratio" key for backwards compatibility
                    z0_z1 = float(comp.props.get("z0_z1_ratio", 0) or comp.props.get("x0_ratio", 0))
                    if z0_z1 > 0 and abs(z0_z1 - 1.0) > 1e-6:
                        Y0[i, i] += y_src / z0_z1
                    else:
                        Y0[i, i] += y_src  # Grounded neutral — zero-seq path exists

            elif comp.type == "generator":
                rated = comp.props.get("rated_mva", 10)
                pf = comp.props.get("power_factor", 0.85)
                p = rated * pf / base_mva / 3
                q = rated * math.sqrt(1 - pf ** 2) / base_mva / 3
                P_phase[i, :] += p
                Q_phase[i, :] += q
                # Generator internal impedance for neg/zero sequence networks
                xd_pp = comp.props.get("xd_pp", 0.15)
                xr = comp.props.get("x_r_ratio", 40)
                x1_pu = xd_pp * base_mva / rated
                r1_pu = x1_pu / xr
                z1_gen = complex(r1_pu, x1_pu)
                # Negative sequence: use x2 if > 0, else Z2 = Z1
                x2_val = float(comp.props.get("x2", 0))
                if x2_val > 0:
                    x2_pu = x2_val * base_mva / rated
                    r2_pu = x2_pu / xr
                    y2_gen = 1 / complex(r2_pu, x2_pu)
                else:
                    y2_gen = 1 / z1_gen if abs(z1_gen) > 1e-15 else 0
                Y2[i, i] += y2_gen
                # Zero sequence: use x0 if > 0, else Z0 = Z1
                x0_val = float(comp.props.get("x0", 0))
                if x0_val > 0:
                    x0_pu = x0_val * base_mva / rated
                    r0_pu = x0_pu / xr
                    y0_gen = 1 / complex(r0_pu, x0_pu)
                else:
                    y0_gen = 1 / z1_gen if abs(z1_gen) > 1e-15 else 0
                Y0[i, i] += y0_gen

            elif comp.type == "solar_pv":
                rated_kw = comp.props.get("rated_kw", 100)
                n_inv = comp.props.get("num_inverters", 1)
                eff = comp.props.get("inverter_eff", 0.97)
                pf = comp.props.get("power_factor", 1.0)
                irr = comp.props.get("irradiance_pct", 100) / 100.0
                rated_mva = rated_kw * n_inv * irr / (eff * 1000)
                p = rated_mva * abs(pf) / base_mva / 3
                q = rated_mva * math.sqrt(max(0, 1 - pf ** 2)) / base_mva / 3
                P_phase[i, :] += p
                Q_phase[i, :] += (q if pf >= 0 else -q)

            elif comp.type == "wind_turbine":
                rated = comp.props.get("rated_mva", 2.0)
                n_turb = comp.props.get("num_turbines", 1)
                pf = comp.props.get("power_factor", 0.95)
                wind_pct = comp.props.get("wind_speed_pct", 100) / 100.0
                total_mva = rated * n_turb * wind_pct
                p = total_mva * abs(pf) / base_mva / 3
                q = total_mva * math.sqrt(max(0, 1 - pf ** 2)) / base_mva / 3
                P_phase[i, :] += p
                Q_phase[i, :] += (q if pf >= 0 else -q)

            elif comp.type == "static_load":
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                total_p = rated * pf * df / base_mva
                total_q = rated * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva
                # Per-phase percentages (default: balanced 33.33% each)
                raw_a = float(comp.props.get("phase_a_pct", 33.33))
                raw_b = float(comp.props.get("phase_b_pct", 33.33))
                raw_c = float(comp.props.get("phase_c_pct", 33.34))
                total_pct = raw_a + raw_b + raw_c
                if total_pct > 0:
                    pct_a, pct_b, pct_c = raw_a / total_pct, raw_b / total_pct, raw_c / total_pct
                else:
                    pct_a = pct_b = pct_c = 1 / 3
                P_phase[i, 0] -= total_p * pct_a
                P_phase[i, 1] -= total_p * pct_b
                P_phase[i, 2] -= total_p * pct_c
                Q_phase[i, 0] -= total_q * pct_a
                Q_phase[i, 1] -= total_q * pct_b
                Q_phase[i, 2] -= total_q * pct_c

            elif comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = rated_kw / eff / 1000
                p = rated_mva * pf * df / base_mva / 3
                q = rated_mva * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva / 3
                P_phase[i, :] -= p
                Q_phase[i, :] -= q
                # Induction motor internal impedance for neg sequence network
                x_pp = comp.props.get("x_pp", 0.17)
                xr = comp.props.get("x_r_ratio", 10)
                x1_pu = x_pp * base_mva / rated_mva
                r1_pu = x1_pu / xr
                z1_mot = complex(r1_pu, x1_pu)
                # Negative sequence: use x2 if > 0, else Z2 = Z1
                x2_val = float(comp.props.get("x2", 0))
                if x2_val > 0:
                    x2_pu = x2_val * base_mva / rated_mva
                    r2_pu = x2_pu / xr
                    y2_mot = 1 / complex(r2_pu, x2_pu)
                else:
                    y2_mot = 1 / z1_mot if abs(z1_mot) > 1e-15 else 0
                Y2[i, i] += y2_mot

            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                pf = comp.props.get("power_factor", 0.9)
                df = comp.props.get("demand_factor", 1.0)
                rated_mva = rated_kva / 1000
                p = rated_mva * pf * df / base_mva / 3
                q = rated_mva * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva / 3
                P_phase[i, :] -= p
                Q_phase[i, :] -= q
                # Synchronous motor internal impedance for neg/zero sequence networks
                xd_pp = comp.props.get("xd_pp", 0.15)
                xr = comp.props.get("x_r_ratio", 40)
                x1_pu = xd_pp * base_mva / rated_mva
                r1_pu = x1_pu / xr
                z1_mot = complex(r1_pu, x1_pu)
                # Negative sequence: use x2 if > 0, else Z2 = Z1
                x2_val = float(comp.props.get("x2", 0))
                if x2_val > 0:
                    x2_pu = x2_val * base_mva / rated_mva
                    r2_pu = x2_pu / xr
                    y2_mot = 1 / complex(r2_pu, x2_pu)
                else:
                    y2_mot = 1 / z1_mot if abs(z1_mot) > 1e-15 else 0
                Y2[i, i] += y2_mot
                # Zero sequence: use x0 if > 0, else Z0 = Z1
                x0_val = float(comp.props.get("x0", 0))
                if x0_val > 0:
                    x0_pu = x0_val * base_mva / rated_mva
                    r0_pu = x0_pu / xr
                    y0_mot = 1 / complex(r0_pu, x0_pu)
                else:
                    y0_mot = 1 / z1_mot if abs(z1_mot) > 1e-15 else 0
                Y0[i, i] += y0_mot

            elif comp.type == "capacitor_bank":
                kvar = comp.props.get("rated_kvar", 100)
                q = kvar / 1000 / base_mva / 3
                Q_phase[i, :] += q

    # ── Solve positive sequence (Newton-Raphson or Gauss-Seidel) ──
    P1 = P_phase.sum(axis=1)
    Q1 = Q_phase.sum(axis=1)

    if method == "gauss_seidel":
        V1, converged, iterations = _gauss_seidel(Y1, P1, Q1, V_spec, bus_types)
    else:
        V1, converged, iterations = _newton_raphson(Y1, P1, Q1, V_spec, bus_types)

    # ── Compute sequence current injections from unbalanced loads ──
    # Phase reference voltages (approximate using V1 = positive sequence result)
    # Va ≈ V1, Vb ≈ a²·V1, Vc ≈ a·V1
    I2_inj = np.zeros(n, dtype=complex)
    I0_inj = np.zeros(n, dtype=complex)

    for i, bus in enumerate(buses):
        v1_i = V1[i]
        if abs(v1_i) < 1e-10:
            continue

        # Approximate per-phase voltages at this bus
        Va_i = v1_i
        Vb_i = (_a ** 2) * v1_i
        Vc_i = _a * v1_i

        # Per-phase complex power injections (in per-unit on base_mva)
        Sa = complex(P_phase[i, 0], Q_phase[i, 0])
        Sb = complex(P_phase[i, 1], Q_phase[i, 1])
        Sc = complex(P_phase[i, 2], Q_phase[i, 2])

        # Per-phase currents in per-unit: I = (S / V)*
        Ia = np.conj(Sa / Va_i) if abs(Va_i) > 1e-10 else 0
        Ib = np.conj(Sb / Vb_i) if abs(Vb_i) > 1e-10 else 0
        Ic = np.conj(Sc / Vc_i) if abs(Vc_i) > 1e-10 else 0

        # Sequence currents: [I0, I1, I2] = A_inv * [Ia, Ib, Ic]
        I_abc = np.array([Ia, Ib, Ic], dtype=complex)
        I_seq = _A_inv @ I_abc

        I0_inj[i] = I_seq[0]
        I2_inj[i] = I_seq[2]

    # ── Solve negative sequence: Y2 * V2 = I2_inj ──
    swing_idx = [i for i, bt in enumerate(bus_types) if bt == 2]
    V2 = np.zeros(n, dtype=complex)
    V0 = np.zeros(n, dtype=complex)

    def _solve_seq(Y_mat, I_inj):
        """Solve sequence network with swing buses forced to zero voltage."""
        if not np.any(np.abs(I_inj) > 1e-12):
            return np.zeros(n, dtype=complex)
        Y_mod = Y_mat.copy()
        I_mod = I_inj.copy()
        for sw in swing_idx:
            Y_mod[sw, :] = 0
            Y_mod[:, sw] = 0
            Y_mod[sw, sw] = 1.0
            I_mod[sw] = 0.0
        try:
            return np.linalg.solve(Y_mod, I_mod)
        except np.linalg.LinAlgError:
            return np.zeros(n, dtype=complex)

    V2 = _solve_seq(Y2, I2_inj)
    V0 = _solve_seq(Y0, I0_inj)

    # ── Reconstruct phase voltages ──
    # [Va, Vb, Vc] = A * [V0, V1, V2]
    Va = V1 + V2 + V0
    Vb = (_a ** 2) * V1 + _a * V2 + V0
    Vc = _a * V1 + (_a ** 2) * V2 + V0

    # ── Build bus results ──
    bus_results: dict[str, UnbalancedLoadFlowBus] = {}
    for bus in buses:
        i = bus_idx[bus.id]
        v_kv = bus.props.get("voltage_kv", 11)
        # Phase-to-neutral base voltage = V_line / √3
        v_base_ln = v_kv / math.sqrt(3)

        v1_m = abs(V1[i])
        v2_m = abs(V2[i])
        vuf = (v2_m / v1_m * 100) if v1_m > 1e-10 else 0.0

        bus_results[bus.id] = UnbalancedLoadFlowBus(
            bus_id=bus.id,
            bus_name=bus.props.get("name", bus.id),
            voltage_kv=v_kv,
            va_pu=round(abs(Va[i]), 6),
            vb_pu=round(abs(Vb[i]), 6),
            vc_pu=round(abs(Vc[i]), 6),
            angle_a_deg=round(math.degrees(float(np.angle(Va[i]))), 4),
            angle_b_deg=round(math.degrees(float(np.angle(Vb[i]))), 4),
            angle_c_deg=round(math.degrees(float(np.angle(Vc[i]))), 4),
            va_kv=round(abs(Va[i]) * v_base_ln, 4),
            vb_kv=round(abs(Vb[i]) * v_base_ln, 4),
            vc_kv=round(abs(Vc[i]) * v_base_ln, 4),
            v1_pu=round(v1_m, 6),
            v2_pu=round(v2_m, 6),
            v0_pu=round(abs(V0[i]), 6),
            vuf_pct=round(vuf, 4),
            pa_mw=round(P_phase[i, 0] * base_mva, 4),
            pb_mw=round(P_phase[i, 1] * base_mva, 4),
            pc_mw=round(P_phase[i, 2] * base_mva, 4),
        )

    # ── Build branch results ──
    branch_results: list[UnbalancedLoadFlowBranch] = []

    for elems, bus_a, bus_b, y1, y2, y0, t, hv_bus, cable_voltages in branch_chains:
        i = bus_idx[bus_a]
        j = bus_idx[bus_b]

        # Positive-sequence branch current
        if hv_bus == bus_a:
            I1_br = (y1 / (t ** 2)) * V1[i] - (y1 / t) * V1[j]
        elif hv_bus == bus_b:
            I1_br = y1 * V1[i] - (y1 / t) * V1[j]
        else:
            I1_br = (V1[i] - V1[j]) * y1

        I2_br = (V2[i] - V2[j]) * y2
        I0_br = (V0[i] - V0[j]) * y0

        # Phase currents: [Ia, Ib, Ic] = A * [I0, I1, I2]
        I_seq_br = np.array([I0_br, I1_br, I2_br], dtype=complex)
        I_abc_br = _A @ I_seq_br

        # Convert to amperes
        from_comp = components.get(bus_a)
        v_kv_from = from_comp.props.get("voltage_kv", 11) if from_comp else 11
        i_base = (base_mva * 1e6) / (math.sqrt(3) * v_kv_from * 1e3) if v_kv_from > 0 else 1e3

        ia_a = abs(I_abc_br[0]) * i_base
        ib_a = abs(I_abc_br[1]) * i_base
        ic_a = abs(I_abc_br[2]) * i_base
        in_a = abs(I_abc_br[0] + I_abc_br[1] + I_abc_br[2]) * i_base
        i1_a = abs(I1_br) * i_base
        i2_a = abs(I2_br) * i_base
        i0_a = abs(I0_br) * i_base

        i_max = max(ia_a, ib_a, ic_a)

        if elems is None:
            branch_results.append(UnbalancedLoadFlowBranch(
                elementId=f"link_{bus_a}_{bus_b}",
                element_name="Bus Link",
                from_bus=bus_a, to_bus=bus_b,
                ia_amps=round(ia_a, 2), ib_amps=round(ib_a, 2), ic_amps=round(ic_a, 2),
                in_amps=round(in_a, 2),
                i1_amps=round(i1_a, 2), i2_amps=round(i2_a, 2), i0_amps=round(i0_a, 2),
                loading_pct=0,
            ))
        else:
            for elem in elems.values():
                loading = 0.0
                if elem.type == "cable":
                    rated_a = (elem.props.get("rated_amps", 400)
                               * max(1, int(elem.props.get("num_parallel", 1))))
                    loading = (i_max / rated_a * 100) if rated_a > 0 else 0.0
                elif elem.type == "transformer":
                    rated_mva_xfmr = elem.props.get("rated_mva", 10)
                    s_mva = i_max * v_kv_from * math.sqrt(3) / 1e3
                    loading = (s_mva / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0.0

                branch_results.append(UnbalancedLoadFlowBranch(
                    elementId=elem.id,
                    element_name=elem.props.get("name", elem.type),
                    from_bus=bus_a, to_bus=bus_b,
                    ia_amps=round(ia_a, 2), ib_amps=round(ib_a, 2), ic_amps=round(ic_a, 2),
                    in_amps=round(in_a, 2),
                    i1_amps=round(i1_a, 2), i2_amps=round(i2_a, 2), i0_amps=round(i0_a, 2),
                    loading_pct=round(loading, 2),
                ))

    # ── Warnings: high VUF ──
    VUF_LIMIT = 2.0   # IEC 61000-3-13 limit for industrial systems
    warnings: list[LoadFlowWarning] = []
    for bus_id, br in bus_results.items():
        if br.vuf_pct > VUF_LIMIT:
            warnings.append(LoadFlowWarning(
                elementId=bus_id,
                element_name=br.bus_name,
                message=(f"High voltage unbalance: VUF = {br.vuf_pct:.2f}% "
                         f"(IEC 61000-3-13 limit: {VUF_LIMIT}%)"),
            ))

    return UnbalancedLoadFlowResults(
        buses=bus_results,
        branches=branch_results,
        warnings=warnings,
        converged=converged,
        iterations=iterations,
        method="Sequence Component (Unbalanced)",
    )
