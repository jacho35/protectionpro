"""DC Short-Circuit — short-circuit currents in DC auxiliary systems.

Implements IEC 61660-1 (maximum short-circuit current) for the source types
that dominate stationary DC installations (substation, UPS, telecom):

  • Battery — an EMF ``E_B = 1.05·U_nB`` behind the branch resistance to the
    fault (§ battery):
        i_pB = E_B / R_BBr                  (R_BBr with 0.9·R_B)
        I_kB = 0.95·E_B / (R_BBr + 0.1·R_B)
    Rise: 1/δ = 2 / (R_BBr/L_BBr + 1/T_B), T_B = 30 ms; t_pB and τ_1B from the
    IEC 61660-1 Figure 10 as functions of 1/δ.

  • Rectifier / battery charger (diode or thyristor bridge) — the IEC rectifier
    sub-procedure, fed from the AC network impedance Z_N (supply at the AC bus
    + supply cable + converter transformer) [DC1]. Current-limiting controls
    are not effective for the maximum current (IEC 61660-1), so a
    line-commutated bridge is never capped at its rating:
        I_kD = λ_D · (3√2/π) · c·U_n/(√3·Z_N) · U_rTLV/U_rTHV
        i_pD = κ_D · I_kD           (Annex A eq. 54–56)
    A switch-mode (IGBT) converter is current-limited at ``dc_sc_factor`` × its
    rated current, as a Thevenin source that cannot exceed its own voltage.

Superposition [DC5]: IEC 61660-1 computes each partial current with the
common branch in its circuit and corrects it with a factor σ_j, because the
common branch carries every source at once. Here the resistive network is
solved nodally with every source as its Thevenin branch and the fault node at
0 V, so each source's contribution is its exact superposition share (Millman
for a single common branch) and the contributions sum to the total. A
non-linear rectifier partial is scaled by the σ_j of its linearised branch.

Conductor resistance is taken at 20 °C [DC4], the maximum-current convention
of IEC 61660-1; the insulated-cable library stores operating-temperature values.

Capacitor and DC-motor sources are not modelled.
"""

import heapq
import math
import numpy as np

from ..models.schemas import (
    ProjectData, DCShortCircuitResults, DCShortCircuitBus,
    DCShortCircuitContribution, LoadFlowWarning,
)
from .conductor_temp import base_resistance
from .dc_loadflow import (
    _num, _is_dc_bus, _bus_nominal_v, _build_bus_groups, _find_dc_branches,
    _attached_group, _transparent_closed, SOURCE_TYPES,
)

T_B = 0.030          # IEC 61660-1 battery time constant (s)
TAU2_B_MS = 100.0    # IEC 61660-1 battery decay time constant (ms)

# Current-limited (switch-mode) converter default: × rated DC current.
_DEFAULT_SC_FACTOR = {"charger": 1.5, "rectifier": 3.0}
# Converter transformer defaults when not entered.
_TX_UK_PCT = 5.0
_TX_XR = 4.0
_C_MAX_LV = 1.10     # IEC 60909-0 Table 1, LV with +10 % tolerance (app convention)


# ── conductors ────────────────────────────────────────────────────────────

def _hot_factor(props):
    """Operating-temperature factor baked into the insulated-cable library
    (`constants.js`: 20 °C DC × 1.275 Cu / 1.282 Al at 90 °C XLPE, ×1.20 PVC)."""
    if str(props.get("insulation", "")).upper() == "PVC":
        return 1.20
    return 1.282 if str(props.get("conductor", "")).upper() == "AL" else 1.275


def _r20_per_km(props):
    """[DC4] Conductor resistance at 20 °C (Ω/km per conductor).

    IEC 61660-1 takes conductor resistance at 20 °C for the maximum current.
    An overhead conductor keeps its 20 °C library base (``base_resistance``);
    insulated cables are stored hot, so the operating-temperature factor is
    divided back out."""
    if str(props.get("construction", "")).strip().lower() == "overhead":
        return float(base_resistance(props, "r_per_km", 0.1) or 0.0)
    return _num(props.get("r_per_km", 0.1), 0.1) / _hot_factor(props)


def _npar(comp):
    return max(1, int(_num(comp.props.get("num_parallel", 1), 1)))


def _cable_loop_r20(comp):
    """Go-and-return loop resistance at 20 °C (Ω)."""
    return 2.0 * _r20_per_km(comp.props) * _num(comp.props.get("length_km", 0.1), 0.1) / _npar(comp)


def _cable_inductance_h(comp, freq):
    """Loop inductance of a DC cable (H), from its per-conductor AC reactance:
    two conductors ⇒ twice the per-conductor inductance, (μ0/π)(¼ + ln d/r)."""
    x = _num(comp.props.get("x_per_km", 0.08), 0.08)
    length = _num(comp.props.get("length_km", 0.1), 0.1)
    if freq <= 0:
        freq = 50
    return 2.0 * x / (2.0 * math.pi * freq) * length / _npar(comp)


def _cable_ac_z_ohm(comp):
    """Per-phase AC impedance of a supply cable at 20 °C (Ω) — IEC 60909 max."""
    length = _num(comp.props.get("length_km", 0.1), 0.1)
    n = _npar(comp)
    return complex(_r20_per_km(comp.props) * length / n,
                   _num(comp.props.get("x_per_km", 0.08), 0.08) * length / n)


# ── topology helpers ──────────────────────────────────────────────────────

def _source_lead(comp, adjacency, components, bus_of, bus_ids, freq):
    """[DC2] (group, R_lead, L_lead) of a source wired to a DC bus through its
    own series cable(s) with no bus at the source terminals.

    Walks closed switching devices and cables from the source to the first DC
    bus group, summing the cables on the way. Returns None when no DC bus is
    reached (e.g. the source sits behind an open device)."""
    start = [(nb, 0.0, 0.0) for nb in adjacency.get(comp.id, [])]
    seen = {comp.id}
    queue = list(start)
    while queue:
        nid, r, l = queue.pop(0)
        if nid in seen:
            continue
        seen.add(nid)
        if nid in bus_of:
            return bus_of[nid], r, l
        if nid in bus_ids:
            continue                     # a non-DC bus
        c = components.get(nid)
        if c is None:
            continue
        if c.type == "cable":
            r2, l2 = r + _cable_loop_r20(c), l + _cable_inductance_h(c, freq)
        elif _transparent_closed(c):
            r2, l2 = r, l
        else:
            continue                     # another source / load — dead end
        for nb in adjacency.get(nid, []):
            if nb not in seen:
                queue.append((nb, r2, l2))
    return None


def _ac_supply_bus(comp, adjacency, components, bus_ids):
    """(AC bus id, supply cable impedance Ω at the bus voltage) feeding a
    converter's ``ac_in`` side, through closed devices and cables."""
    queue = [(nb, 0j) for nb in adjacency.get(comp.id, [])]
    seen = {comp.id}
    while queue:
        nid, z = queue.pop(0)
        if nid in seen:
            continue
        seen.add(nid)
        c = components.get(nid)
        if c is None:
            continue
        if nid in bus_ids:
            if _is_dc_bus(c):
                continue                 # the converter's own DC side
            return nid, z
        if c.type == "cable":
            z2 = z + _cable_ac_z_ohm(c)
        elif _transparent_closed(c):
            z2 = z
        else:
            continue
        for nb in adjacency.get(nid, []):
            if nb not in seen:
                queue.append((nb, z2))
    return None, 0j


# ── sources ───────────────────────────────────────────────────────────────

def _converter_kind(comp):
    """'bridge' (line-commutated diode / thyristor: IEC rectifier procedure) or
    'limited' (switch-mode, current-limited)."""
    key = "rectifier_type" if comp.type == "rectifier" else "bridge_type"
    t = str(comp.props.get(key, "thyristor") or "thyristor").lower()
    return "limited" if t in ("igbt", "switch_mode") else "bridge"


def _converter_rating(comp):
    """(U_dc nominal V, I_rated A)."""
    p = comp.props
    v = _num(p.get("voltage_dc_v", 125), 125)
    if comp.type == "rectifier":
        i_r = _num(p.get("rated_kw", 50), 50) * 1000.0 / max(v, 1.0)
    else:
        i_r = _num(p.get("rated_a", 200), 200)
    return v, i_r


def _rectifier_network(comp, project, adjacency, components, bus_ids, freq, warnings):
    """[DC1] AC-side network of a bridge converter, referred to the converter
    transformer secondary: (R_N, X_N, U_LV V, c).

    Z_N = Z_Q (IEC 60909 maximum at the AC bus) + supply cable + converter
    transformer (IEC 61660-1 Figure: R_N = R_Q + R_P + R_T + R_R)."""
    p = comp.props
    u_dc, i_r = _converter_rating(comp)
    # Converter transformer secondary: entered, else the bridge's ideal no-load
    # voltage equal to the nominal DC voltage, U_di0 = (3√2/π)·U_LV.
    u_lv = _num(p.get("tx_secondary_v", 0), 0) or u_dc * math.pi / (3.0 * math.sqrt(2.0))
    s_tx = (_num(p.get("tx_kva", 0), 0) or 1.1 * u_dc * i_r / 1000.0) * 1000.0
    uk = (_num(p.get("tx_uk_pct", 0), 0) or _TX_UK_PCT) / 100.0
    xr = _num(p.get("tx_xr", 0), 0) or _TX_XR
    z_t = uk * u_lv ** 2 / s_tx
    r_t = z_t / math.sqrt(1.0 + xr * xr)
    x_t = r_t * xr

    ac_bus, z_cable = _ac_supply_bus(comp, adjacency, components, bus_ids)
    z_q = 0j
    c = _C_MAX_LV
    name = comp.props.get("name") or comp.id
    if ac_bus is None:
        warnings.append(LoadFlowWarning(elementId=comp.id, element_name=name, message=(
            f"{name}: AC input not connected to an AC bus — the rectifier short-circuit "
            "current assumes an infinite AC supply (converter transformer only).")))
    else:
        from .fault import thevenin_z1_at_bus
        bus = components[ac_bus]
        u_hv_kv = _num(bus.props.get("voltage_kv", 0.4), 0.4)
        z_pu = thevenin_z1_at_bus(project, ac_bus, c=c, exclude_motor_paths=False)
        if z_pu is None:
            warnings.append(LoadFlowWarning(elementId=comp.id, element_name=name, message=(
                f"{name}: no AC source feeds its supply bus — no rectifier contribution.")))
            return None
        z_bus = complex(z_pu) * (u_hv_kv ** 2) / float(project.baseMVA or 100.0)
        ratio2 = (u_lv / (u_hv_kv * 1000.0)) ** 2
        z_q = (z_bus + z_cable) * ratio2
    r_n = max(z_q.real + r_t, 1e-9)
    x_n = max(z_q.imag + x_t, 1e-9)
    return r_n, x_n, u_lv, c


def _rectifier_partial(r_n, x_n, u_lv, c, r_dbr, l_dbr, freq):
    """IEC 61660-1 rectifier partial current at the fault: (I_kD, i_pD, t_pD ms,
    τ1D ms). λ_D, κ_D from Annex A eq. 54–56; t_pD, τ_1D per the standard's
    50 Hz forms, scaled by 50/f."""
    z_n = math.hypot(r_n, x_n)
    rx = r_n / x_n
    rd = max(r_dbr, 0.0) / r_n
    lam = math.sqrt((1.0 + rx * rx) / (1.0 + rx * rx * (1.0 + 2.0 / 3.0 * rd) ** 2))
    # c·U_n/√3·Z_N with U_n referred to the transformer secondary: U_rTLV/U_rTHV
    # is already applied by working on the secondary side.
    i_k = lam * (3.0 * math.sqrt(2.0) / math.pi) * c * u_lv / (math.sqrt(3.0) * z_n)
    l_n = x_n / (2.0 * math.pi * freq)
    phi = math.atan(1.0 / (rx * (1.0 + 2.0 / 3.0 * rd)))
    kappa = 1.0 + 2.0 / math.pi * math.exp(-(math.pi / 3.0 + phi) / math.tan(phi)) \
        * math.sin(phi) * (math.pi / 2.0 - math.atan(max(l_dbr, 0.0) / l_n))
    scale = 50.0 / freq
    if kappa >= 1.05:
        ratio_l = max(l_dbr, 0.0) / l_n
        tp = (3.0 * kappa + 6.0) + (4.0 * (ratio_l - 1.0) if ratio_l > 1.0 else 0.0)
        tau1 = 2.0 + (kappa - 0.9) * (2.5 + 9.0 * ratio_l)
        i_p = kappa * i_k
    else:
        # No distinct peak: IEC takes i_p = I_k (t_p = fault duration).
        tp, tau1, i_p = 0.0, 0.0, i_k
    return i_k, i_p, tp * scale, tau1 * scale


def _battery_params(comp):
    """(E_B, R_B, L_B internal) — E_B = 1.05·U_nB unless measured."""
    p = comp.props
    u_nb = _num(p.get("nominal_v", 125), 125)
    e = _num(p.get("emf_v", 0), 0) or 1.05 * u_nb
    r_b = max(_num(p.get("internal_r_mohm", 20), 20) / 1000.0, 1e-5)
    l_b = _num(p.get("internal_l_uh", 0), 0) * 1e-6
    return e, r_b, l_b


def _battery_rise(r_bbr, l_bbr):
    """IEC 61660-1 battery rise: (1/δ ms, t_pB ms, τ_1B ms).

    1/δ = 2/(R_BBr/L_BBr + 1/T_B). [DC6] L_BBr = 0 gives 1/δ = 0 (an
    instantaneous rise), not T_B — T_B is a term of 1/δ, not a rise time."""
    if l_bbr <= 0:
        inv_delta = 0.0
    else:
        inv_delta = 2.0 / (r_bbr / l_bbr + 1.0 / T_B)
    tp, tau1 = _battery_fig_tp_tau1(inv_delta * 1000.0)
    return inv_delta * 1000.0, tp, tau1


# IEC 61660-1:1997 Figure 10 — t_pB and τ_1B against 1/δ are straight lines on
# log-log axes over 1/δ = 0.5–20 ms, i.e. power laws. Coefficients digitised
# from the figure (fit residual ≤ 3 %); outside 0.5–20 ms the lines are
# extended. [DC6]
_FIG10_TP = (3.055, 0.928)     # t_pB = 3.055·(1/δ)^0.928   (ms, ms)
_FIG10_TAU1 = (0.497, 1.019)   # τ_1B = 0.497·(1/δ)^1.019


def _battery_fig_tp_tau1(inv_delta_ms):
    """t_pB and τ_1B (ms) against 1/δ (ms) — IEC 61660-1 Figure 10."""
    if inv_delta_ms <= 0:
        return 0.0, 0.0
    (a, n), (b, m) = _FIG10_TP, _FIG10_TAU1
    return a * inv_delta_ms ** n, b * inv_delta_ms ** m


# ── network ───────────────────────────────────────────────────────────────

class _Island:
    """Passive DC branch network of one island: conductance Laplacian and a
    least-resistance-path inductance."""

    def __init__(self, groups, branches):
        self.groups = groups
        self.idx = {g: i for i, g in enumerate(groups)}
        m = len(groups)
        self.lap = np.zeros((m, m))
        self.adj = {}
        for (ga, gb), (g, l_par) in branches.items():
            if ga not in self.idx or gb not in self.idx:
                continue
            a, b = self.idx[ga], self.idx[gb]
            self.lap[a, a] += g
            self.lap[b, b] += g
            self.lap[a, b] -= g
            self.lap[b, a] -= g
            self.adj.setdefault(ga, []).append((gb, 1.0 / g, l_par))
            self.adj.setdefault(gb, []).append((ga, 1.0 / g, l_par))
        self.pinv = np.linalg.pinv(self.lap) if m > 1 else np.zeros((1, 1))

    def r_eff(self, a, b):
        if a == b:
            return 0.0
        ia, ib = self.idx[a], self.idx[b]
        return float(self.pinv[ia, ia] + self.pinv[ib, ib] - 2 * self.pinv[ia, ib])

    def l_path(self, a, b):
        """Inductance along the least-resistance path (near-radial systems)."""
        if a == b:
            return 0.0
        best = {a: 0.0}
        pq = [(0.0, 0.0, a)]
        while pq:
            rr, ll, node = heapq.heappop(pq)
            if node == b:
                return ll
            if rr > best.get(node, float("inf")):
                continue
            for nb, r, l in self.adj.get(node, []):
                if rr + r < best.get(nb, float("inf")):
                    best[nb] = rr + r
                    heapq.heappush(pq, (rr + r, ll + l, nb))
        return 0.0

    def contributions(self, fault, thevenins):
        """[DC5] Superposition share of each Thevenin source at the fault.

        ``thevenins`` = [(group, E, R)]. Solves G·V = I with every source's
        conductance 1/R stamped at its node and the fault node held at 0 V;
        returns each source's current into the fault with only its own EMF
        active. Linear, so the shares sum to the total fault current."""
        m = len(self.groups)
        f = self.idx[fault]
        g = self.lap.copy()
        for grp, _e, r in thevenins:
            k = self.idx[grp]
            g[k, k] += 1.0 / r
        keep = [i for i in range(m) if i != f]
        g_red = g[np.ix_(keep, keep)] if keep else np.zeros((0, 0))
        # Conductance from each kept node straight into the fault node.
        g_to_f = -self.lap[keep, f] if keep else np.zeros(0)
        out = []
        for grp, e, r in thevenins:
            k = self.idx[grp]
            if k == f:
                i_direct = e / r
                # Other nodes are driven only through the fault node at 0 V.
                out.append(i_direct)
                continue
            inj = np.zeros(len(keep))
            inj[keep.index(k)] = e / r
            v = np.linalg.solve(g_red, inj)
            out.append(float(g_to_f @ v))
        return out


# ── engine ────────────────────────────────────────────────────────────────

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

    # [DC3] Parallel cables between the same two buses add their conductances
    # (the key is unordered, so drawing direction does not matter); their
    # inductances combine in parallel likewise.
    branches = {}
    for rep, ga, gb, r, _amp, l in _find_dc_branches(
            components, adjacency, bus_of, bus_ids,
            r_of=_cable_loop_r20, l_of=lambda c: _cable_inductance_h(c, freq)):
        key = tuple(sorted((ga, gb)))
        g_old, inv_l_old = branches.get(key, (0.0, 0.0))
        branches[key] = (g_old + 1.0 / r, inv_l_old + (1.0 / l if l > 0 else 0.0))
    branches = {k: (g, (1.0 / inv_l if inv_l > 0 else 0.0)) for k, (g, inv_l) in branches.items()}

    parent = {g: g for g in groups}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for (ga, gb) in branches:
        parent[find(ga)] = find(gb)
    islands = {}
    for g in groups:
        islands.setdefault(find(g), []).append(g)
    nets = {root: _Island(isl, branches) for root, isl in islands.items()}

    # Sources: attached group plus any series lead cable [DC2].
    sources = []   # dicts
    for comp in project.components:
        if comp.type not in SOURCE_TYPES:
            continue
        g = _attached_group(comp, adjacency, components, bus_of, bus_ids)
        r_lead = l_lead = 0.0
        if g is None:
            lead = _source_lead(comp, adjacency, components, bus_of, bus_ids, freq)
            if lead is None:
                continue
            g, r_lead, l_lead = lead
        src = {"comp": comp, "group": g, "r_lead": r_lead, "l_lead": l_lead}
        if comp.type == "dc_battery":
            src["kind"] = "battery"
            src["e"], src["r_b"], src["l_b"] = _battery_params(comp)
        elif _converter_kind(comp) == "limited":
            src["kind"] = "limited"
            u, i_r = _converter_rating(comp)
            factor = _num(comp.props.get("dc_sc_factor", 0), 0) \
                or _DEFAULT_SC_FACTOR.get(comp.type, 2.0)
            src["e"] = u
            src["i_lim"] = factor * i_r
        else:
            net = _rectifier_network(comp, project, adjacency, components,
                                     bus_ids, freq, warnings)
            if net is None:
                continue
            src["kind"] = "bridge"
            src["net"] = net
            src["l_dc"] = _num(comp.props.get("l_dc_uh", 0), 0) * 1e-6
        sources.append(src)

    targets = [fault_bus_id] if fault_bus_id else groups
    out = {}
    for fbus in targets:
        if fbus not in nominal:
            continue
        root = find(fbus)
        net = nets[root]
        live = [s for s in sources if find(s["group"]) == root]

        # Each source's own partial (IEC: common branch included, alone) and
        # its linear Thevenin branch for the superposition shares.
        partial = []
        for s in live:
            r_net = net.r_eff(s["group"], fbus)
            l_net = net.l_path(s["group"], fbus)
            if s["kind"] == "battery":
                r_p = 0.9 * s["r_b"] + s["r_lead"]        # peak branch (0.9·R_B)
                r_k = s["r_b"] + s["r_lead"]              # quasi steady-state
                l_br = s["l_b"] + s["l_lead"] + l_net
                inv_d, tp, tau1 = _battery_rise(r_p + r_net, l_br)
                partial.append(dict(
                    th_p=(s["e"], r_p), th_k=(0.95 * s["e"], r_k),
                    alone_p=s["e"] / (r_p + r_net), alone_k=0.95 * s["e"] / (r_k + r_net),
                    tp=tp, tau1=tau1, r_br=r_k + r_net))
            elif s["kind"] == "limited":
                # [L1] Current-limited, but a source of voltage U cannot drive
                # more than U/R: Thevenin E = U, R = U/I_lim.
                r_int = s["e"] / max(s["i_lim"], 1e-9) + s["r_lead"]
                i_k = s["e"] / (r_int + r_net)
                partial.append(dict(
                    th_p=(s["e"], r_int), th_k=(s["e"], r_int),
                    alone_p=1.05 * i_k, alone_k=i_k, peak_factor=1.05,
                    tp=5.0, tau1=0.0, r_br=r_int + r_net))
            else:
                r_n, x_n, u_lv, c = s["net"]
                r_dbr = s["r_lead"] + r_net
                l_dbr = s["l_dc"] + s["l_lead"] + l_net
                i_k, i_p, tp, tau1 = _rectifier_partial(r_n, x_n, u_lv, c, r_dbr, l_dbr, freq)
                # Linearised branch reproducing the partial at this fault, for σ_j.
                e_lin = (3.0 * math.sqrt(2.0) / math.pi) * c * u_lv
                r_k = max(e_lin / i_k - r_net, 1e-9)
                r_p = max(e_lin / i_p - r_net, 1e-9)
                partial.append(dict(
                    th_p=(e_lin, r_p), th_k=(e_lin, r_k),
                    alone_p=i_p, alone_k=i_k, tp=tp, tau1=tau1, r_br=r_dbr))

        shares_p = net.contributions(fbus, [(s["group"],) + p["th_p"] for s, p in zip(live, partial)]) if live else []
        shares_k = net.contributions(fbus, [(s["group"],) + p["th_k"] for s, p in zip(live, partial)]) if live else []

        contribs = []
        total_ik = total_ip = 0.0
        tp_max = tau_dom = dom_ip = 0.0
        for s, p, sh_p, sh_k in zip(live, partial, shares_p, shares_k):
            # σ_j = share with every source present / the source's partial alone.
            e_p, r_p = p["th_p"]
            e_k, r_k = p["th_k"]
            r_net = net.r_eff(s["group"], fbus)
            lin_alone_p = e_p / (r_p + r_net)
            lin_alone_k = e_k / (r_k + r_net)
            sigma_p = sh_p / lin_alone_p if lin_alone_p > 0 else 0.0
            sigma_k = sh_k / lin_alone_k if lin_alone_k > 0 else 0.0
            ik = sigma_k * p["alone_k"] / 1000.0
            ip = sigma_p * p["alone_p"] / 1000.0
            if s["kind"] == "limited":
                ip = 1.05 * ik
            comp = s["comp"]
            contribs.append(DCShortCircuitContribution(
                source_id=comp.id, source_name=(comp.props.get("name") or comp.id),
                source_type=comp.type, ik_ka=round(ik, 3), ip_ka=round(ip, 3),
                tp_ms=round(p["tp"], 2), r_mohm=round(p["r_br"] * 1000.0, 3)))
            total_ik += ik
            total_ip += ip
            tp_max = max(tp_max, p["tp"])
            if ip > dom_ip:
                dom_ip, tau_dom = ip, p["tau1"]
        note = "" if contribs else "No DC source in this island — no short-circuit infeed."
        out[fbus] = DCShortCircuitBus(
            bus_id=fbus, bus_name=name_of[fbus], nominal_v=round(nominal[fbus], 1),
            ik_ka=round(total_ik, 3), ip_ka=round(total_ip, 3),
            tp_ms=round(tp_max, 2), time_constant_ms=round(tau_dom, 2),
            contributions=contribs, note=note)

    for b in dc_buses:
        r = out.get(b.id)
        if r and not r.contributions:
            warnings.append(LoadFlowWarning(
                elementId=b.id, element_name=r.bus_name,
                message="DC bus has no source in its island — no short-circuit current."))

    return DCShortCircuitResults(buses=out, warnings=warnings, converged=True)
