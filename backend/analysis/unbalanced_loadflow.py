"""Unbalanced Load Flow Analysis — Symmetrical Component Method.

Solves three-phase unbalanced power systems using positive, negative,
and zero sequence networks:

  - Positive sequence (Y1): solved via Newton-Raphson (reuses balanced LF solver)
  - Negative sequence (Y2): linear solve with unbalanced load injections
  - Zero sequence (Y0):     linear solve; transformer delta windings block Z0

Parallel circuits (``num_parallel`` > 1) are scaled in the zero sequence by
``line_coupling.parallel_z0_scale``, not by a plain 1/n divide — see
``_cable_z0_pu``.

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
import re
import numpy as np
from ..models.schemas import (
    ProjectData, LoadFlowWarning,
    UnbalancedLoadFlowBus, UnbalancedLoadFlowBranch, UnbalancedLoadFlowResults,
)
from .loadflow import (
    _build_bus_groups, _find_bus_paths, _get_impedance, _is_transparent_and_closed,
    _find_components_at_bus, _get_chain_turns_ratio, _utility_admittance,
    _newton_raphson, _gauss_seidel,
    plan_dispatch, solve_with_islands, insert_implicit_load_buses,
    chain_element_zones, chain_order_from_paths, insert_junction_buses,
    _reduce_chain_two_port,
    is_synthetic_bus, SYNTHETIC_BUS_PREFIX,
    sync_motor_q_sign as _lf_sync_q_sign,
)
from .fault import _grounding_impedance
from .line_coupling import (coupling_note, parallel_z0_scale, equivalent_z0_ohm,
                            set_drawn_coupling, drawn_coupling_scope, drawn_coupling_note,
                            z0_source_note)

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

    # Delta (d/D) and zigzag (z/Z) windings both block zero-sequence
    # THROUGH-flow — the winding circulates Z0 internally rather than
    # passing it through (same classification as fault.py _transformer_zero_seq).
    if any(c in ('d', 'D', 'z', 'Z') for c in vg if c.isalpha()):
        return True

    # Ungrounded wye: Y or y not immediately followed by N or n
    for i, c in enumerate(vg):
        if c in ('Y', 'y'):
            next_c = vg[i + 1] if i + 1 < len(vg) else ''
            if next_c not in ('N', 'n'):
                return True  # Ungrounded wye — blocks zero sequence

    return False


def _xfmr_z0_shunts(comp, candidate_buses, base_mva):
    """Zero-sequence ground shunts contributed by a Z0-blocking transformer.

    A Dyn/YNd transformer blocks zero-sequence THROUGH-flow, but its
    grounded-wye winding plus the delta circulation path is itself the
    dominant zero-sequence return path for the network on the wye side
    (e.g. the LV network of a Dyn11 distribution transformer). Without this
    shunt the downstream Y0 row is singular and the zero-sequence solve
    fails. Z_T0 ≈ Z_T1 is used (no zero-sequence prop exists), plus 3·Zn
    for impedance-grounded neutrals.

    Args:
        comp: transformer component
        candidate_buses: {bus_id: nominal_voltage_kv} of buses adjacent to
            the transformer's chain
        base_mva: system base

    Returns list of (bus_id, y0_shunt_pu) tuples.
    """
    vg = comp.props.get("vector_group", "Dyn11").strip()
    lv_part = re.sub(r'^[A-Z]+', '', vg)
    hv_grounded = vg.upper().startswith("YN") or vg.upper().startswith("ZN")
    # Delta (D) and zigzag (Z) windings both provide a Z0 circulation path,
    # so either makes the grounded-wye winding on the OTHER side a Z0 source
    # (matches fault.py _transformer_zero_seq).
    hv_circulates = len(vg) > 0 and vg[0].upper() in ('D', 'Z')
    lv_grounded = lv_part.lower().startswith("yn") or lv_part.lower().startswith("zn")
    lv_circulates = len(lv_part) > 0 and lv_part[0].lower() in ('d', 'z')

    sides = []
    if lv_grounded and hv_circulates:
        sides.append('lv')   # Dyn / Dzn — shunt at the LV bus
    if hv_grounded and lv_circulates:
        sides.append('hv')   # YNd / YNz — shunt at the HV bus
    if not sides or not candidate_buses:
        return []

    v_hv = comp.props.get("voltage_hv_kv", 33)
    v_lv = comp.props.get("voltage_lv_kv", 11)
    z_t0_nameplate = _get_impedance(comp, base_mva)  # Z_T0 ≈ Z_T1, on the nameplate voltage

    shunts = []
    for side in sides:
        v_side = v_lv if side == 'lv' else v_hv
        v_other = v_hv if side == 'lv' else v_lv
        # Pick the candidate bus whose nominal voltage matches this winding
        bus_id = min(candidate_buses, key=lambda b: abs(candidate_buses[b] - v_side))
        if abs(candidate_buses[bus_id] - v_side) > abs(candidate_buses[bus_id] - v_other):
            continue  # The only adjacent bus is on the other winding
        # User grounding config is authoritative (same convention as fault.py)
        grounding_cfg = comp.props.get(
            f"grounding_{side}",
            "solidly_grounded" if side == 'lv' else "ungrounded")
        z_base_side = (v_side ** 2) / base_mva if v_side > 0 else 1.0
        z_n = _grounding_impedance(grounding_cfg, comp, side, z_base_side)
        if z_n is None:
            continue  # Winding set ungrounded — no zero-sequence path
        # Re-base the nameplate impedance to the bus it is stamped at when the
        # winding voltage differs from that bus (see loadflow._get_impedance).
        v_bus = candidate_buses[bus_id]
        z_t0 = (z_t0_nameplate * (v_side / v_bus) ** 2
                if v_side and v_bus and v_bus > 0 else z_t0_nameplate)
        z_shunt = z_t0 + 3 * z_n
        if abs(z_shunt) > 1e-15:
            shunts.append((bus_id, 1 / z_shunt))
    return shunts


def _cable_z0_self_per_km(elem):
    """Zero-sequence SELF impedance of ONE circuit (Ω/km), before any parallel
    treatment. Split out so ``_cable_z0_pu`` and the study disclosure emitted
    at the end of the run are guaranteed to describe the same quantity.

    Note this engine's fallback (3.5× the positive-sequence per-km value)
    differs from fault.py's composite 3×Z1 — a long-standing per-engine
    convention, deliberately left alone.
    """
    r0_prop = float(elem.props.get("r0_per_km", 0))
    x0_prop = float(elem.props.get("x0_per_km", 0))
    return complex(
        r0_prop if r0_prop > 0 else float(elem.props.get("r_per_km", 0.1)) * 3.5,
        x0_prop if x0_prop > 0 else float(elem.props.get("x_per_km", 0.08)) * 3.5)


def _cable_z0_pu(elem, base_mva, v_kv, freq_hz=50.0):
    """Cable zero-sequence per-unit impedance for the Y0 network.

    Factored out of the two chain-walking branches below, which each built Z0
    inline and — unlike Z1, where ``_get_impedance`` divides by ``num_parallel``
    — applied no parallel treatment at all. A double-circuit line therefore
    carried the zero-sequence impedance of a SINGLE circuit into Y0.

    Parallel circuits are not a plain Z0/n divide either. Zero-sequence current
    is in phase in all three conductors and returns through earth, so circuits
    sharing a tower couple strongly through that common return and the mutual
    term raises the effective Z0 well above Z0/n. ``parallel_z0_scale`` applies
    Z0_eff = [Z0s + (n-1)·Z0m]/n — the same correction fault.py's ``_cable_z0``
    uses, so the two engines now agree on the zero-sequence network. Single
    circuits are untouched (scale = 1).

    Second bug fixed here: the explicit-prop path used ``r0_per_km`` /
    ``x0_per_km`` directly as total ohms, never multiplying by ``length_km`` —
    so any cable with datasheet zero-sequence data contributed the Z0 of a
    single kilometre regardless of its actual length (a 10 km line was 10×
    under-impedance in Y0). The fallback path was unaffected, because it scales
    r1/x1, which already carry the length. fault.py's ``_cable_z0`` has always
    multiplied by length; the two engines now agree.

    The r0/x0 fallback (3.5× the positive-sequence value) is this engine's own
    long-standing rule and is deliberately kept, rather than adopting fault.py's
    3×Z1 composite fallback — that would move results for every project with no
    explicit r0/x0, which is a separate question from the parallel one.
    """
    z_base = (v_kv ** 2) / base_mva if v_kv > 0 else 1.0
    length = float(elem.props.get("length_km", 1))
    # Scale from the PER-KM self impedance: the coupling ratio Z0m/Z0s is
    # length-invariant, and mutual_z0_per_km is itself a per-km quantity.
    z0_ohm = equivalent_z0_ohm(elem.id)   # [LC1] drawn parallel group
    if z0_ohm is None:
        z0_self_per_km = _cable_z0_self_per_km(elem)
        z0_ohm = z0_self_per_km * length * parallel_z0_scale(
            elem.props, z0_self_per_km, freq_hz)
    return complex(z0_ohm.real / z_base, z0_ohm.imag / z_base)


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


# Sequence-network fixed-point iteration (S#1-F18): passes and the largest
# change in any sequence voltage (p.u.) between passes that counts as settled.
SEQ_MAX_ITERATIONS = 50
SEQ_TOLERANCE = 1e-9


@drawn_coupling_scope
def run_unbalanced_load_flow(
    project: ProjectData,
    method: str = "newton_raphson",
) -> UnbalancedLoadFlowResults:
    """Run three-phase unbalanced load flow using symmetrical components."""

    # Give any load or source wired behind a cable/transformer a terminal bus
    # so its demand — and the feeder's impedance — is modelled instead of
    # silently dropped by the len(results) < 2 skip below (idempotent).
    # A node at every cable tee the drawing left without a bus (same pre-pass
    # as the balanced load flow), so no cable is shared between two chains.
    project = insert_implicit_load_buses(insert_junction_buses(project))
    base_mva = project.baseMVA
    # Only the zero-sequence parallel-coupling model is frequency-dependent
    # (Carson's earth-return depth); everything else here is at nominal.
    freq_hz = float(project.frequency or 50)
    components = {c.id: c for c in project.components}
    wires = project.wires

    # distribution_board is a bus-like node carrying its own lumped load and
    # passing current through to any sub-board it feeds (see EE-1).
    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
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

    # [LC1] Overhead feeders drawn in parallel between the same two buses
    # share a tower — same coupled equivalents as fault analysis.
    drawn_groups = set_drawn_coupling(components, adjacency, _cable_z0_self_per_km, freq_hz)

    # ── Discover branch chains ──
    processed_chains: set = set()
    # Each entry: (elems, bus_a, bus_b, y1, y2, y0, t, hv_bus, cable_voltages)
    branch_chains = []
    z0_shunts: list[tuple[str, complex]] = []  # (bus_id, y0_shunt) from Dyn/YNd xfmrs

    for comp in project.components:
        if comp.type not in ("cable", "transformer"):
            continue
        if comp.id in bus_of:
            continue
        if comp.id in {eid for ck in processed_chains for eid in ck}:
            continue

        results = _find_bus_paths(comp.id, adjacency, components, bus_of)
        if len(results) < 2:
            # Single-bus transformer (e.g. utility incomer TX): not a
            # bus-to-bus branch, but a Dyn/YNd unit still grounds the
            # zero-sequence network at its wye-side bus.
            if (comp.type == "transformer" and len(results) == 1
                    and _xfmr_blocks_zero_seq(comp)):
                only_bus = results[0][0]
                only_v = (components[only_bus].props.get("voltage_kv", 11)
                          if only_bus in components else 11)
                z0_shunts.extend(_xfmr_z0_shunts(comp, {only_bus: only_v}, base_mva))
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

        has_xfmr = any(e.type in ("transformer", "autotransformer") for e in all_elems.values())
        cable_voltages: dict[str, float] = {}

        z1_total = complex(0, 0)
        z2_total = complex(0, 0)
        z0_total: complex | None = complex(0, 0)
        z0_blocked = False

        # Zone voltages are needed by BOTH branches: the transformer branch
        # assigns each cable to its own side's zone, the no-transformer branch
        # puts every cable in the single zone these buses bound.
        bus_a_v = (components[bus_a].props.get("voltage_kv", 11)
                   if bus_a in components else 11)
        bus_b_v = (components[bus_b].props.get("voltage_kv", 11)
                   if bus_b in components else 11)

        chain_order = chain_order_from_paths(path_a, path_b)
        if has_xfmr:
            # Zone by chain POSITION, not walk-path membership (which depends
            # on the seed element — see loadflow._walk_chain_zones). A
            # transformer's entry is its LV zone, to which z% is re-based.
            zones = chain_element_zones(chain_order, bus_a_v, bus_b_v)

            for e in all_elems.values():
                if e.type == "transformer":
                    z = _get_impedance(e, base_mva, v_lv_kv=zones.get(e.id))
                    z1_total += z
                    z2_total += z           # Z2 = Z1 for transformer (passive element)
                    if _xfmr_blocks_zero_seq(e):
                        z0_blocked = True
                        # H6: blocked through-flow, but a grounded-wye
                        # winding still grounds Y0 at its side's bus
                        z0_shunts.extend(_xfmr_z0_shunts(
                            e, {bus_a: bus_a_v, bus_b: bus_b_v}, base_mva))
                    else:
                        z0_total = (z0_total or complex(0, 0)) + z

                elif e.type == "cable":
                    v_kv = zones[e.id]
                    cable_voltages[e.id] = v_kv
                    z_base = (v_kv ** 2) / base_mva
                    r1 = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                    x1 = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                    # /n to match _get_impedance, which the no-transformer branch
                    # below uses for the same cable. This branch re-derives Z1
                    # inline (it needs the chain-resolved v_kv, not the cable's
                    # own voltage_kv prop) and had dropped the parallel divide,
                    # so a parallel cable sharing a chain with a transformer
                    # carried n× its true positive-sequence impedance.
                    n_par = max(1, int(e.props.get("num_parallel", 1) or 1))
                    z1_cable = complex(r1 / z_base, x1 / z_base) / n_par
                    z1_total += z1_cable
                    z2_total += z1_cable
                    if not z0_blocked:
                        z0_total = ((z0_total or complex(0, 0))
                                    + _cable_z0_pu(e, base_mva, v_kv, freq_hz))
                else:
                    # An autotransformer: metallic HV–LV path, so Z0 passes
                    # through; re-based to its LV zone like a transformer.
                    z = _get_impedance(e, base_mva, v_lv_kv=zones.get(e.id))
                    z1_total += z
                    z2_total += z
                    if not z0_blocked:
                        z0_total = (z0_total or complex(0, 0)) + z

        else:
            # No transformer — all cables, and the whole chain sits in ONE
            # voltage zone, the one its bounding buses define. Both the Z1 and
            # the Z0 base take that zone voltage, so a cable carrying a stale
            # voltage_kv prop is still referred to the right per-unit base
            # ([EE-12 mirror], see loadflow._get_impedance).
            for e in all_elems.values():
                z = _get_impedance(e, base_mva, v_kv=bus_a_v)
                z1_total += z
                z2_total += z
                if e.type == "cable":
                    cable_voltages[e.id] = bus_a_v
                    z0_total = ((z0_total or complex(0, 0))
                                + _cable_z0_pu(e, base_mva, bus_a_v, freq_hz))
                else:
                    z0_total = (z0_total or complex(0, 0)) + z * 3

        # Zero-impedance chains: tiny series reactance (large susceptance)
        # rather than a real conductance, to avoid fictitious resistive losses
        y1 = (1 / z1_total) if abs(z1_total) > 1e-15 else complex(0, -1e6)
        y2 = (1 / z2_total) if abs(z2_total) > 1e-15 else complex(0, -1e6)
        y0 = (0 if z0_blocked or z0_total is None
              else ((1 / z0_total) if abs(z0_total) > 1e-15 else complex(0, -1e6)))
        y0 = complex(y0)

        # Electrical order, so cascaded transformers multiply their ratios in
        # the order they are met (a dict gives graph-walk order).
        t, hv_bus = _get_chain_turns_ratio(chain_order, bus_a, bus_b, components)
        # [EE-10] Same exact chain reduction as the balanced engine: cascaded
        # transformers (or a tapped one sharing its chain with a cable) are
        # Kron-reduced with each unit's own local ratio instead of summing
        # every impedance under one combined ratio, which mis-refers anything
        # on the tap-referred side by up to t². Positive and negative sequence
        # share it (passive elements, Z2 = Z1); the zero-sequence stamp keeps
        # its own simplified t = 1 model below.
        n_chain_xfmrs = sum(1 for e in chain_order
                            if e.type in ("transformer", "autotransformer"))
        if n_chain_xfmrs >= 1 and (
                n_chain_xfmrs >= 2
                or (any(e.type == "cable" for e in chain_order) and abs(t - 1.0) > 1e-9)):
            xfmr_positions = [m for m, e in enumerate(chain_order)
                              if e.type in ("transformer", "autotransformer")]
            y1, t, hv_bus = _reduce_chain_two_port(
                chain_order, xfmr_positions, hv_bus, bus_a, bus_b,
                bus_a_v, bus_b_v, base_mva)
            y2 = y1
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

    # Zero-sequence ground shunts from Dyn/YNd transformers (H6)
    for shunt_bus, y_shunt in z0_shunts:
        if shunt_bus in bus_idx:
            Y0[bus_idx[shunt_bus], bus_idx[shunt_bus]] += y_shunt

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
        # Bus link: large susceptance (tiny series reactance), not conductance
        y_link = complex(0, -1e6)
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
    # The motors' share of P_phase/Q_phase. A motor is a positive-sequence
    # constant-power load with its own Z2 shunt (in Y2) — not a per-phase
    # constant-power load — so the sequence iteration below leaves it in the
    # positive sequence instead of re-evaluating it at unbalanced phase voltages.
    P_mot = np.zeros((n, 3))
    Q_mot = np.zeros((n, 3))
    bus_types = []
    V_spec = np.ones(n)
    bus_load_p_mw = np.zeros(n)  # per-bus load (consumption, MW) for dispatch
    special_bus_loads: dict[int, list] = {}  # bus_idx -> [(phase_conn, total_p_pu, total_q_pu)]

    for bus in buses:
        i = bus_idx[bus.id]
        bt = bus.props.get("bus_type", "PQ")
        # Swing assignment is decided per-island by plan_dispatch below
        # (mirrors the balanced solver); user "Swing" labels are honoured there.
        bus_types.append(1 if bt == "PV" else 0)

        connected = _find_components_at_bus(bus.id, adjacency, components)
        # A distribution board injects its own lumped load at its own node.
        if bus.type == "distribution_board":
            connected = list(connected) + [bus]
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
                # Output injection comes from the merit-order dispatcher
                # (plan_dispatch) below; only sequence impedances are added here.
                rated = comp.props.get("rated_mva", 10)
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
                # Zero sequence: use x0 if > 0, else [MG4] the typical
                # machine ratio Z0 = GEN_Z0_Z1_DEFAULT·Z1 (shared with fault.py)
                x0_val = float(comp.props.get("x0", 0))
                if x0_val > 0:
                    x0_pu = x0_val * base_mva / rated
                    r0_pu = x0_pu / xr
                    y0_gen = 1 / complex(r0_pu, x0_pu)
                else:
                    from .fault import GEN_Z0_Z1_DEFAULT
                    y0_gen = (1 / (GEN_Z0_Z1_DEFAULT * z1_gen)
                              if abs(z1_gen) > 1e-15 else 0)
                Y0[i, i] += y0_gen

            elif comp.type in ("solar_pv", "wind_turbine"):
                pass  # Injection set by the merit-order dispatcher below

            elif comp.type == "static_load" or (comp.type == "distribution_board" and comp.id == bus.id):
                rated = comp.props.get("rated_kva", 100) / 1000
                pf = comp.props.get("power_factor", 0.85)
                df = comp.props.get("demand_factor", 1.0)
                total_p = rated * pf * df / base_mva
                total_q = rated * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva
                bus_load_p_mw[i] += total_p * base_mva
                phase_conn = comp.props.get("phase_connection", "3P")

                if phase_conn in ("2P-AB", "2P-BC", "2P-CA", "1P-A", "1P-B", "1P-C"):
                    # Non-3P load: track separately for proper sequence injection.
                    # Positive-sequence contribution is added to P1/Q1 after this loop.
                    special_bus_loads.setdefault(i, []).append((phase_conn, total_p, total_q))
                else:
                    # Standard 3P load — distribute per phase percentages
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
                # IEC 60909-0 §3.8: S = kW/(η·pf) — P = S·pf = kW/η unchanged
                rated_mva = rated_kw / (eff * pf * 1000) if pf > 0 else rated_kw / (eff * 1000)
                p = rated_mva * pf * df / base_mva / 3
                # [MG5] leading (over-excited) motors supply vars
                q = (_lf_sync_q_sign(comp.props) * rated_mva
                     * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva / 3)
                P_phase[i, :] -= p
                Q_phase[i, :] -= q
                P_mot[i, :] -= p
                Q_mot[i, :] -= q
                bus_load_p_mw[i] += rated_mva * pf * df
                # Induction motor internal impedance for neg sequence network
                xr = comp.props.get("x_r_ratio", 10)
                from .fault import induction_motor_x_pp
                x_pp = induction_motor_x_pp(comp.props, xr)   # [N8]
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
                # [MG5] leading (over-excited) motors supply vars
                q = (_lf_sync_q_sign(comp.props) * rated_mva
                     * math.sqrt(max(0, 1 - pf ** 2)) * df / base_mva / 3)
                P_phase[i, :] -= p
                Q_phase[i, :] -= q
                P_mot[i, :] -= p
                Q_mot[i, :] -= q
                bus_load_p_mw[i] += rated_mva * pf * df
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

    # ── Auto-assign swing bus (M1, mirrors balanced load flow) ──
    # Without a slack reference NR/GS diverges or returns garbage.
    # MODELLING NOTE: the utility is also represented above as a Y1 shunt
    # admittance (its source impedance). With the utility bus held at
    # 1.0 p.u. by the swing constraint that shunt is benign in the
    # positive-sequence solve, and it is REQUIRED in Y2/Y0 as the source's
    # negative/zero-sequence return path — so it is kept, unlike in the
    # balanced solver which drops it entirely.
    # ── Island detection, per-island swing selection, and dispatch ──
    # Shared with the balanced solver: each electrical island gets its own
    # slack (utility connection bus, else user-labelled Swing, else the
    # lowest-merit source); sourceless islands are excluded from the solve.
    branch_pairs = [(ba, bb) for _e, ba, bb, _y1, _y2, _y0, _t, _hv, _cv in branch_chains]
    dispatch = plan_dispatch(project, components, adjacency, bus_idx, buses,
                             branch_pairs, bus_load_p_mw)
    for i in dispatch["swing_idx"]:
        bus_types[i] = 2

    # ── Sequence networks, iterated to a consistent solution (S#1-F18) ──
    # Constant-power loads draw phase currents set by their ACTUAL phase (or
    # line) voltages, and those voltages depend on the negative/zero-sequence
    # voltages the currents themselves create. Each pass:
    #   1. phase voltages from the latest V0/V1/V2,
    #   2. every phase-domain load's phase currents at those voltages → I0/I1/I2,
    #   3. Y2·V2 = I2 and Y0·V0 = I0, and the loads' positive-sequence power
    #      S1 = V1·conj(I1) fed back into the positive-sequence solve,
    # until V0/V1/V2 stop moving. The first pass is the old single-pass model
    # (all load power in the positive sequence, balanced phase voltages), so a
    # balanced network converges on pass 2 with an unchanged answer. Motors
    # stay in the positive sequence (P_mot) with their Z2 shunt; dispatched
    # sources inject balanced (positive-sequence) power.
    P_ld = P_phase - P_mot          # phase-domain constant-power loads (3P splits, caps)
    Q_ld = Q_phase - Q_mot
    P1_fixed = P_mot.sum(axis=1)
    Q1_fixed = Q_mot.sum(axis=1)
    for i, (p_mw, q_mvar) in dispatch["injections"].items():
        P1_fixed[i] += p_mw / base_mva
        Q1_fixed[i] += q_mvar / base_mva

    # Pass-1 positive-sequence load power: the full three-phase power.
    S1_loads = P_ld.sum(axis=1) + 1j * Q_ld.sum(axis=1)
    for bus_i, loads in special_bus_loads.items():
        for _ph, p_pu, q_pu in loads:
            S1_loads[bus_i] -= complex(p_pu, q_pu)

    def _load_seq_currents(V0_, V1_, V2_):
        """Sequence current injections of the phase-domain loads at the phase
        voltages built from (V0_, V1_, V2_). Per-unit convention: S is p.u.
        of the THREE-PHASE base and V p.u. line-to-neutral, so the phase
        current is I_pu = 3·conj(S_phase/V) (a balanced load S at 1 p.u.
        gives Ia = S, matching the balanced solver). 2P loads use the line
        voltage (I0 = 0 exactly); 1P loads the phase voltage (I0 ≠ 0)."""
        I0_ = np.zeros(n, dtype=complex)
        I1_ = np.zeros(n, dtype=complex)
        I2_ = np.zeros(n, dtype=complex)
        for i in range(n):
            if abs(V1_[i]) < 1e-10:
                continue   # de-energized bus — its loads draw nothing
            Va_i = V0_[i] + V1_[i] + V2_[i]
            Vb_i = V0_[i] + (_a ** 2) * V1_[i] + _a * V2_[i]
            Vc_i = V0_[i] + _a * V1_[i] + (_a ** 2) * V2_[i]
            I_abc = np.zeros(3, dtype=complex)
            for ph, v_ph in enumerate((Va_i, Vb_i, Vc_i)):
                s_ph = complex(P_ld[i, ph], Q_ld[i, ph])
                if abs(s_ph) > 0 and abs(v_ph) > 1e-10:
                    I_abc[ph] += 3 * np.conj(s_ph / v_ph)
            for phase_conn, total_p_pu, total_q_pu in special_bus_loads.get(i, []):
                S_consumed = complex(total_p_pu, total_q_pu)  # positive = consumed
                if phase_conn in ("2P-AB", "2P-BC", "2P-CA"):
                    k_from, k_to = {"2P-AB": (0, 1), "2P-BC": (1, 2), "2P-CA": (2, 0)}[phase_conn]
                    v_ll = (Va_i, Vb_i, Vc_i)[k_from] - (Va_i, Vb_i, Vc_i)[k_to]
                    if abs(v_ll) > 1e-10:
                        i_load = 3 * np.conj(S_consumed / v_ll)
                        # Current leaves on the first phase, returns on the second
                        I_abc[k_from] -= i_load
                        I_abc[k_to] += i_load
                elif phase_conn in ("1P-A", "1P-B", "1P-C"):
                    k = {"1P-A": 0, "1P-B": 1, "1P-C": 2}[phase_conn]
                    v_ph = (Va_i, Vb_i, Vc_i)[k]
                    if abs(v_ph) > 1e-10:
                        I_abc[k] -= 3 * np.conj(S_consumed / v_ph)
            I_seq = _A_inv @ I_abc
            I0_[i], I1_[i], I2_[i] = I_seq[0], I_seq[1], I_seq[2]
        return I0_, I1_, I2_

    swing_idx = [i for i, bt in enumerate(bus_types) if bt == 2]

    def _solve_seq(Y_mat, I_inj):
        """Solve sequence network with swing buses forced to zero voltage.

        Solves per connected component so that a floating subnetwork (e.g.
        buses with no zero-sequence path to ground behind a delta winding)
        only zeroes its OWN buses, instead of a single np.linalg.solve
        failure silently zeroing the entire system.
        """
        V_out = np.zeros(n, dtype=complex)
        if not np.any(np.abs(I_inj) > 1e-12):
            return V_out
        Y_mod = Y_mat.copy()
        I_mod = I_inj.copy()
        for sw in swing_idx:
            Y_mod[sw, :] = 0
            Y_mod[:, sw] = 0
            Y_mod[sw, sw] = 1.0
            I_mod[sw] = 0.0
        # Group buses into connected components via off-diagonal coupling
        unassigned = set(range(n))
        while unassigned:
            seed = unassigned.pop()
            comp_set = {seed}
            stack = [seed]
            while stack:
                k = stack.pop()
                for m in list(unassigned):
                    if abs(Y_mod[k, m]) > 1e-12:
                        unassigned.discard(m)
                        comp_set.add(m)
                        stack.append(m)
            idx = sorted(comp_set)
            sub_Y = Y_mod[np.ix_(idx, idx)]
            sub_I = I_mod[idx]
            if not np.any(np.abs(sub_I) > 1e-12):
                continue  # No injections in this component — V stays 0
            try:
                V_out[idx] = np.linalg.solve(sub_Y, sub_I)
            except np.linalg.LinAlgError:
                # Component has no reference to ground — sequence current
                # has no return path here; leave its buses at V = 0.
                pass
        return V_out

    V2 = np.zeros(n, dtype=complex)
    V0 = np.zeros(n, dtype=complex)
    V1_prev = None
    seq_converged = False
    seq_iterations = 0
    for seq_iterations in range(1, SEQ_MAX_ITERATIONS + 1):
        P1 = P1_fixed + S1_loads.real
        Q1 = Q1_fixed + S1_loads.imag
        V1, converged, iterations, solve_reason = solve_with_islands(
            Y1, P1, Q1, V_spec, bus_types, dispatch["dead_idx"], method)
        if not converged:
            break
        I0_inj, I1_inj, I2_inj = _load_seq_currents(V0, V1, V2)
        V2_new = _solve_seq(Y2, I2_inj)
        V0_new = _solve_seq(Y0, I0_inj)
        change = max(float(np.max(np.abs(V2_new - V2), initial=0.0)),
                     float(np.max(np.abs(V0_new - V0), initial=0.0)),
                     float(np.max(np.abs(V1 - V1_prev), initial=0.0))
                     if V1_prev is not None else float("inf"))
        V2, V0, V1_prev = V2_new, V0_new, V1
        # The loads' positive-sequence power at this pass's voltages.
        S1_loads = V1 * np.conj(I1_inj)
        if change < SEQ_TOLERANCE:
            seq_converged = True
            break
    if converged and not seq_converged:
        converged = False
        solve_reason = "sequence_iterations"

    # ── Reconstruct phase voltages ──
    # [Va, Vb, Vc] = A * [V0, V1, V2]
    Va = V1 + V2 + V0
    Vb = (_a ** 2) * V1 + _a * V2 + V0
    Vc = _a * V1 + (_a ** 2) * V2 + V0

    # ── Build bus results ──
    bus_results: dict[str, UnbalancedLoadFlowBus] = {}
    for bus in buses:
        i = bus_idx[bus.id]
        v_kv = bus.props.get("voltage_kv", 0.4 if bus.type == "distribution_board" else 11)
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

        # Negative-sequence current uses the same tap-adjusted pi-model as I1
        # (Y2 is built with the tap at line ~246, so the branch current must
        # be consistent — M10)
        if hv_bus == bus_a:
            I2_br = (y2 / (t ** 2)) * V2[i] - (y2 / t) * V2[j]
        elif hv_bus == bus_b:
            I2_br = y2 * V2[i] - (y2 / t) * V2[j]
        else:
            I2_br = (V2[i] - V2[j]) * y2
        I0_br = (V0[i] - V0[j]) * y0

        # The same branch seen from its bus_b end. Through a transformer the
        # current differs by the turns ratio (and a cable on the far side of
        # it carries the far-side current), so each element below is reported
        # at the end — and on the current base — of its own voltage zone.
        if hv_bus == bus_a:
            I1_b = (y1 / t) * V1[i] - y1 * V1[j]
            I2_b = (y2 / t) * V2[i] - y2 * V2[j]
        elif hv_bus == bus_b:
            I1_b = (y1 / t) * V1[i] - (y1 / (t ** 2)) * V1[j]
            I2_b = (y2 / t) * V2[i] - (y2 / (t ** 2)) * V2[j]
        else:
            I1_b, I2_b = I1_br, I2_br
        I0_b = I0_br

        def _end_amps(bus_id, i0, i1, i2):
            """Phase/sequence amps of a branch current at one end, on that
            end's bus base (I_base = S_base / (√3·U_base))."""
            comp = components.get(bus_id)
            v_kv = comp.props.get("voltage_kv", 11) if comp else 11
            i_base = (base_mva * 1e6) / (math.sqrt(3) * v_kv * 1e3) if v_kv > 0 else 1e3
            i_abc = _A @ np.array([i0, i1, i2], dtype=complex)
            return {
                "v_kv": v_kv,
                "ia": abs(i_abc[0]) * i_base, "ib": abs(i_abc[1]) * i_base,
                "ic": abs(i_abc[2]) * i_base,
                "in": abs(i_abc[0] + i_abc[1] + i_abc[2]) * i_base,
                "i1": abs(i1) * i_base, "i2": abs(i2) * i_base, "i0": abs(i0) * i_base,
            }

        end_a = _end_amps(bus_a, I0_br, I1_br, I2_br)
        end_b = _end_amps(bus_b, I0_b, I1_b, I2_b) if hv_bus is not None else end_a

        def _row(elem_id, name, amps, loading):
            return UnbalancedLoadFlowBranch(
                elementId=elem_id, element_name=name,
                from_bus=bus_a, to_bus=bus_b,
                ia_amps=round(amps["ia"], 2), ib_amps=round(amps["ib"], 2),
                ic_amps=round(amps["ic"], 2), in_amps=round(amps["in"], 2),
                i1_amps=round(amps["i1"], 2), i2_amps=round(amps["i2"], 2),
                i0_amps=round(amps["i0"], 2),
                loading_pct=round(loading, 2),
            )

        if elems is None:
            branch_results.append(_row(f"link_{bus_a}_{bus_b}", "Bus Link", end_a, 0))
        else:
            v_a, v_b = end_a["v_kv"], end_b["v_kv"]
            for elem in elems.values():
                loading = 0.0
                if elem.type in ("transformer", "autotransformer"):
                    # Reported on its LV side (the higher current), like the
                    # balanced engine; loading is S against the MVA rating.
                    amps = end_b if v_b < v_a else end_a
                    i_max = max(amps["ia"], amps["ib"], amps["ic"])
                    rated_mva_xfmr = elem.props.get("rated_mva", 10)
                    s_mva = i_max * amps["v_kv"] * math.sqrt(3) / 1e3
                    loading = (s_mva / rated_mva_xfmr * 100) if rated_mva_xfmr > 0 else 0.0
                else:
                    # A cable: the end whose voltage zone it sits in.
                    zone = cable_voltages.get(elem.id, v_a)
                    amps = end_b if abs(zone - v_b) < abs(zone - v_a) else end_a
                    if elem.type == "cable":
                        i_max = max(amps["ia"], amps["ib"], amps["ic"])
                        rated_a = (elem.props.get("rated_amps", 400)
                                   * max(1, int(elem.props.get("num_parallel", 1) or 1)))
                        loading = (i_max / rated_a * 100) if rated_a > 0 else 0.0
                branch_results.append(_row(elem.id, elem.props.get("name", elem.type),
                                           amps, loading))

    # ── Warnings: high VUF ──
    VUF_LIMIT = 2.0   # IEC 61000-3-13 limit for industrial systems
    warnings: list[LoadFlowWarning] = []
    warnings.extend(dispatch["warnings"])
    # [P5] Unlike the balanced engine (_assess_solution), this schema has no
    # solution_quality field — but a bare `converged=False` with no warning
    # at all left a non-converged unbalanced study silent about WHY, and
    # unable to distinguish a singular/near-singular Jacobian (structural —
    # e.g. an island with no reference) from ordinary non-convergence (an
    # infeasible operating point). `solve_reason` was already returned by
    # `solve_with_islands` and previously discarded.
    if not converged:
        if solve_reason == "singular_jacobian":
            warnings.insert(0, LoadFlowWarning(
                elementId="", element_name="Unbalanced Load Flow",
                message=("Unbalanced load flow could not solve: the positive-"
                         "sequence Jacobian is singular. The network is "
                         "structurally under-determined (a subnetwork with no "
                         "voltage reference / all-swing island) or sitting "
                         "exactly on the voltage-collapse boundary.")))
        elif solve_reason == "sequence_iterations":
            warnings.insert(0, LoadFlowWarning(
                elementId="", element_name="Unbalanced Load Flow",
                message=(f"Unbalanced load flow: the sequence networks did not "
                         f"settle after {seq_iterations} passes — the load "
                         "currents and the phase voltages they create are not "
                         "yet consistent, so results are unreliable. This "
                         "happens with very heavy single-phase loading on a "
                         "weak feeder (phase voltage near collapse).")))
        else:
            warnings.insert(0, LoadFlowWarning(
                elementId="", element_name="Unbalanced Load Flow",
                message=(f"Unbalanced load flow did not converge after "
                         f"{iterations} iterations — results are unreliable. "
                         "The operating point may be infeasible: load beyond "
                         "the network's loadability limit, a source too weak "
                         "for the demand, or an overloaded transformer.")))
    # [R3-1] The unbalanced engine calls the sequence solver directly and has
    # no generator-capability registration, so a user-labelled PV bus holds
    # its voltage with UNBOUNDED reactive power (the balanced engine's
    # reactive-limit clamp does not run here) — non-conservative if the
    # regulating machine cannot actually supply the Q. Surface it.
    for bus in buses:
        if str(bus.props.get("bus_type", "PQ")) == "PV":
            _i = bus_idx[bus.id]
            if _i in dispatch["dead_idx"]:
                continue
            warnings.append(LoadFlowWarning(
                elementId=bus.id,
                element_name=bus.props.get("name", bus.id),
                message=("PV bus voltage is held with UNLIMITED reactive "
                         "power in the unbalanced solver (no capability "
                         "clamp) — verify the regulating machine can supply "
                         "the implied Q, or check the setpoint with the "
                         "balanced load flow (which enforces limits)."),
            ))
    for bus_id, br in bus_results.items():
        if br.vuf_pct > VUF_LIMIT:
            warnings.append(LoadFlowWarning(
                elementId=bus_id,
                element_name=br.bus_name,
                message=(f"High voltage unbalance: VUF = {br.vuf_pct:.2f}% "
                         f"(IEC 61000-3-13 limit: {VUF_LIMIT}%)"),
            ))
    # Disclose the parallel zero-sequence treatment. It moves Z0 by ~1.7x on a
    # typical double-circuit tower, and V0 / VUF here are read straight off the
    # Y0 network — a reviewer cannot reproduce these numbers without knowing
    # the geometry that was assumed. One warning per cable (the reader needs to
    # know WHICH line), unlike fault analysis, whose flat study_assumptions
    # list has no element field and so groups by identical treatment.
    for g in drawn_groups:
        for comp in g:
            warnings.append(LoadFlowWarning(
                elementId=comp.id,
                element_name=comp.props.get("name", comp.id),
                message=drawn_coupling_note(g),
            ))
    for comp in project.components:
        if comp.type != "cable":
            continue
        note = coupling_note(comp.props, _cable_z0_self_per_km(comp), freq_hz)
        if note:
            warnings.append(LoadFlowWarning(
                elementId=comp.id,
                element_name=comp.props.get("name", comp.id),
                message=note,
            ))
        # Where Z0 came from. Same per-cable granularity and for the same
        # reason: V0 / VUF are read straight off the Y0 network, so a reviewer
        # needs to know which cable's Z0 was inferred rather than supplied —
        # and that this engine's fallback is not the one fault analysis uses.
        z0_note = z0_source_note(comp.props, composite_fallback=False)
        if z0_note:
            warnings.append(LoadFlowWarning(
                elementId=comp.id,
                element_name=comp.props.get("name", comp.id),
                message=z0_note,
            ))

    # Collapse synthetic terminal buses out of the user-facing result, as the
    # balanced solver does: drop their rows and re-point branch endpoints at
    # the real load/source they stand for. Only bus-to-bus rows exist here, so
    # no source-row re-anchoring is needed.
    syn_ids = {bid for bid in bus_results if is_synthetic_bus(bid)}
    if syn_ids:
        for bid in syn_ids:
            bus_results.pop(bid, None)
        _unsyn = lambda b: b[len(SYNTHETIC_BUS_PREFIX):] if is_synthetic_bus(b) else b
        for br in branch_results:
            br.from_bus = _unsyn(br.from_bus)
            br.to_bus = _unsyn(br.to_bus)

    return UnbalancedLoadFlowResults(
        buses=bus_results,
        branches=branch_results,
        warnings=warnings,
        converged=converged,
        iterations=iterations,
        sequence_iterations=seq_iterations,
        method="Sequence Component (Unbalanced)",
    )
