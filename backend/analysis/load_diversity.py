"""Load Diversity & Demand Factor Calculator.

Turns installed load into the maximum demand each board and transformer must
carry. Provides:
  - Per-load installed kVA / kW, demand factor and demand
  - Per board (bus or distribution board): every outgoing circuit, the
    coincidence factor Ks for that number of circuits, the diversified demand
    and its current — including everything fed through the board
  - Per-transformer loading: installed vs. demand-adjusted utilisation
  - Reference demand factors and the Ks table

Method (review LD1–LD7, 2026-10-01):

The network is cut into *nodes* (buses and distribution boards, the nodes the
load flow solves) and *branches* (whatever lies between them: switchgear,
cables, transformers, UPSs, and the loads, sources and capacitors hanging off
them). The direction of supply comes from a breadth-first walk out of the
source nodes, so a transformer is loaded with what is on its *downstream* side
whatever its terminal wiring looks like. Each board's outgoing circuits are its
downstream branches (plus a distribution board's own schedule); demand rolls up
from the far end:

    S_board = Ks(n) · Σ (P_i + jQ_i)  +  jQ_capacitors

with the circuit demands added as phasors (the load flow's P/Q convention) and
Ks from the IEC 61439 rated diversity factor for n circuits. A board fed from
several parents (parallel transformers, a closed ring) is shared between them
by transformer rating, else equally.
"""

import math
from ..models.schemas import ProjectData
from .loadflow import sync_motor_q_sign

# Closed switchgear and instruments: no impedance, no node of their own.
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester",
                     "bus_duct", "relay"}
NODE_TYPES = {"bus", "distribution_board"}
SOURCE_TYPES = {"utility", "generator", "solar_pv", "wind_turbine", "battery"}
# [LD3] vfd: a drive is a load in the load flow; it was missing here entirely.
LOAD_TYPES = {"static_load", "motor_induction", "motor_synchronous", "vfd"}
TRANSFORMER_TYPES = {"transformer", "autotransformer"}
# The AC network ends here (DC side, control circuits, compensators).
BLOCK_TYPES = {"rectifier", "charger", "dc_battery", "dc_load", "svc",
               "offpage_connector"}

# [LD7] Typical demand factors. No IEC standard tabulates per-load demand
# factors: IEC 60364-1 §311 only requires maximum demand to be assessed, and
# IEC 61439 gives a diversity factor for an assembly's outgoing circuits (the
# Ks table below). The SANS 10142-1 Annex C values are that standard's
# informative examples; the rest are common design practice.
REFERENCE_DEMAND_FACTORS = {
    "lighting": {"description": "Lighting", "factor": 1.0,
                 "source": "practice, non-residential"},
    "heating": {"description": "Heating / air-conditioning", "factor": 1.0,
                "source": "practice"},
    "water_heaters_motors": {"description": "Water heaters, motors (residential)",
                             "factor": 1.0, "source": "SANS 10142-1 Annex C"},
    "residential_appliances": {"description": "Lighting, heating, cooking, socket outlets (residential)",
                               "factor": 0.5, "source": "SANS 10142-1 Annex C"},
    "socket_outlets": {"description": "Socket outlets (general)", "factor": 0.4,
                       "source": "practice"},
    "lift_1": {"description": "Lifts — 1 lift", "factor": 1.0,
               "source": "SANS 10142-1 Annex C"},
    "lift_2": {"description": "Lifts — 2 lifts (each)", "factor": 0.75,
               "source": "SANS 10142-1 Annex C"},
    "lift_3": {"description": "Lifts — 3 or more (each)", "factor": 0.6,
               "source": "SANS 10142-1 Annex C"},
    "motor_group": {"description": "Motor group, per motor", "factor": 0.75,
                    "source": "practice"},
    "welding": {"description": "Welding equipment", "factor": 0.3,
                "source": "practice"},
    "cooking": {"description": "Commercial cooking", "factor": 0.8,
                "source": "practice"},
}

# [LD5] Coincidence factor Ks for an assembly with n outgoing circuits: the
# IEC 61439 rated diversity factor (IEC 61439-1 Annex E / IEC 61439-2
# Table 101, formerly IEC 60439-1 Table 1), as a step table — reviewer's
# reading, no licensed copy held. The engine used to interpolate a table of
# unknown source (0.85 at 3 circuits, down to 0.52 at 50).
# (upper circuit count, Ks)
IEC_61439_KS_TABLE = [(1, 1.0), (3, 0.9), (5, 0.8), (9, 0.7)]
IEC_61439_KS_MIN = 0.6     # 10 circuits and more


def coincidence_factor(n_circuits):
    """IEC 61439 rated diversity factor for n outgoing circuits."""
    for n_max, ks in IEC_61439_KS_TABLE:
        if n_circuits <= n_max:
            return ks
    return IEC_61439_KS_MIN


def _num(props, key, default):
    """A numeric prop; blank / unreadable falls back to the default. [LD8]"""
    v = props.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return float(default)
    return v if math.isfinite(v) else float(default)


def _pf(props, default):
    pf = _num(props, "power_factor", default)
    return pf if 0.0 < pf <= 1.0 else (1.0 if pf > 1.0 else default)


def _get_load_kva(comp):
    """Installed (connected) apparent power, kVA."""
    p = comp.props
    if comp.type in ("static_load", "distribution_board"):
        return _num(p, "rated_kva", 100)
    if comp.type == "motor_induction":
        kw, eff, pf = _num(p, "rated_kw", 200), _num(p, "efficiency", 0.93), _pf(p, 0.85)
        # Input kVA = kW / (efficiency × power factor)
        return kw / eff / pf if eff > 0 else kw / pf
    if comp.type == "motor_synchronous":
        return _num(p, "rated_kva", 500)
    if comp.type == "vfd":
        kw, eff = _num(p, "rated_kw", 200), _num(p, "efficiency", 0.96) or 0.96
        dpf = _num(p, "displacement_pf", 0.98) or 0.98
        return kw / eff / dpf
    return 0.0


def _get_load_kw(comp):
    """Installed real power, kW (input power for machines)."""
    p = comp.props
    if comp.type in ("static_load", "distribution_board"):
        return _num(p, "rated_kva", 100) * _pf(p, 0.85)
    if comp.type == "motor_induction":
        # [EE-R2-5] Installed demand is the INPUT power rated_kw/η — the
        # nameplate kW is shaft power (the load-flow P = kW/η convention).
        kw, eff = _num(p, "rated_kw", 200), _num(p, "efficiency", 0.93)
        return kw / eff if eff > 0 else kw
    if comp.type == "motor_synchronous":
        return _num(p, "rated_kva", 500) * _pf(p, 0.9)
    if comp.type == "vfd":
        kw, eff = _num(p, "rated_kw", 200), _num(p, "efficiency", 0.96) or 0.96
        return kw / eff
    return 0.0


def _load_demand(comp):
    """(installed kVA, installed kW, effective DF, demand P kW, demand Q kvar,
    pf) — P and Q exactly as run_load_flow injects them. [LD6]"""
    p = comp.props
    s_inst = _get_load_kva(comp)
    p_inst = _get_load_kw(comp)
    df = _num(p, "demand_factor", 1.0)
    if comp.type == "vfd":
        # The load flow scales a drive by its load_pct as well.
        df *= _num(p, "load_pct", 100) / 100.0
        dpf = _num(p, "displacement_pf", 0.98) or 0.98
        pf, q_sign = dpf, 1.0
    elif comp.type == "motor_synchronous":
        pf, q_sign = _pf(p, 0.9), sync_motor_q_sign(p)   # [MG5] leading supplies vars
    else:
        pf, q_sign = _pf(p, 0.85), 1.0
    p_dem = p_inst * df
    q_dem = q_sign * p_dem * math.sqrt(max(0.0, 1 - pf * pf)) / pf if pf > 0 else 0.0
    return s_inst, p_inst, df, p_dem, q_dem, pf


def _cap_kvar(comp):
    """Capacitor bank output at rated voltage (steps in service), kvar."""
    p = comp.props
    kvar = _num(p, "rated_kvar", 100)
    steps = max(1, int(_num(p, "steps", 1) or 1))
    sis = p.get("steps_in_service")
    if sis not in (None, ""):
        kvar *= min(steps, max(0, int(_num(p, "steps_in_service", steps)))) / steps
    return kvar


def _is_open(comp):
    return (comp.type in TRANSPARENT_TYPES
            and str(comp.props.get("state", "closed")).lower() != "closed")


def _name(comp):
    return str(comp.props.get("name", comp.id))


def _node_kv(comp):
    return _num(comp.props, "voltage_kv", 0)


def _build_graph(project, comp_map):
    """Undirected adjacency with ports: id -> [(neighbour, own port)]."""
    adj = {}
    for w in project.wires:
        a, b = w.fromComponent, w.toComponent
        if a not in comp_map or b not in comp_map:
            continue
        adj.setdefault(a, []).append((b, w.fromPort))
        adj.setdefault(b, []).append((a, w.toPort))
    return adj


def _branches(nodes, comp_map, adj):
    """Cut the network at its nodes. A branch is a connected set of non-node
    components (open switchgear and blocking elements removed), with the nodes
    it touches. Two nodes wired straight together form a member-less branch."""
    branches = []
    seen = set()
    for cid, comp in comp_map.items():
        if cid in seen or cid in nodes:
            continue
        if _is_open(comp) or comp.type in BLOCK_TYPES:
            continue
        members, ends, stack = set(), set(), [cid]
        seen.add(cid)
        while stack:
            x = stack.pop()
            members.add(x)
            for nb, _ in adj.get(x, []):
                if nb in nodes:
                    ends.add(nb)
                    continue
                c = comp_map[nb]
                if nb in seen or _is_open(c) or c.type in BLOCK_TYPES:
                    continue
                # A motor behind its drive is the drive's load, already
                # counted as the drive's input.
                tx_ = comp_map[x].type
                if "vfd" in (tx_, c.type) and tx_ in LOAD_TYPES and c.type in LOAD_TYPES:
                    continue
                seen.add(nb)
                stack.append(nb)
        branches.append({"members": members, "ends": ends})
    pairs = set()
    for nid in nodes:
        for nb, _ in adj.get(nid, []):
            if nb in nodes and nb != nid:
                key = tuple(sorted((nid, nb)))
                if key not in pairs:
                    pairs.add(key)
                    branches.append({"members": set(), "ends": set(key)})
    for i, b in enumerate(branches):
        b["id"] = i
        types = [comp_map[m].type for m in b["members"]]
        b["has_utility"] = "utility" in types
        b["has_source"] = any(t in SOURCE_TYPES for t in types)
        b["loads"] = sorted(m for m in b["members"] if comp_map[m].type in LOAD_TYPES)
        b["caps"] = sorted(m for m in b["members"] if comp_map[m].type == "capacitor_bank")
        b["xfmrs"] = sorted(m for m in b["members"] if comp_map[m].type in TRANSFORMER_TYPES)
    return branches


def _depths(nodes, branches, comp_map):
    """Breadth-first distance from the supply, per connected group of nodes.
    Roots: nodes on a branch with a utility; else the group's highest-voltage
    nodes — those with a source if any has one. A generator on an LV board
    does not turn its transformer round: an island's MV board still feeds
    its LV boards."""
    nadj = {n: set() for n in nodes}
    for b in branches:
        for a in b["ends"]:
            nadj[a] |= b["ends"] - {a}
    depth, util_group, groups = {}, {}, []
    for start in sorted(nodes):
        if any(start in g for g in groups):
            continue
        g, stack = {start}, [start]
        while stack:
            x = stack.pop()
            for y in nadj[x]:
                if y not in g:
                    g.add(y)
                    stack.append(y)
        groups.append(g)
    for g in groups:
        roots = {n for b in branches if b["has_utility"] for n in b["ends"] if n in g}
        for n in g:
            util_group[n] = bool(roots)
        if not roots:
            vmax = max(_node_kv(comp_map[n]) for n in g)
            top = {n for n in g if _node_kv(comp_map[n]) == vmax}
            roots = {n for b in branches if b["has_source"] for n in b["ends"]
                     if n in top} or top
        frontier = sorted(roots)
        for r in frontier:
            depth[r] = 0
        while frontier:
            nxt = []
            for x in frontier:
                for y in sorted(nadj[x]):
                    if y not in depth:
                        depth[y] = depth[x] + 1
                        nxt.append(y)
            frontier = nxt
    return depth, util_group


def _side_sets(xid, branch, comp_map, adj):
    """For a transformer in a branch: per own port, the branch members and
    end nodes reached from that port without crossing the transformer."""
    by_port = {}
    for nb, port in adj.get(xid, []):
        by_port.setdefault(port or "", []).append(nb)
    sides = {}
    for port, starts in by_port.items():
        reach, stack = set(), list(starts)
        while stack:
            x = stack.pop()
            if x in reach or x == xid:
                continue
            if x not in branch["members"] and x not in branch["ends"]:
                continue
            reach.add(x)
            if x in branch["ends"] or comp_map[x].type in LOAD_TYPES:
                continue
            stack.extend(nb for nb, _ in adj.get(x, []))
        sides[port] = reach
    return sides


def _leaf_board(node, res):
    """A distribution board whose only circuit is its own schedule."""
    c = res["_circuits"]
    return node.type == "distribution_board" and len(c) == 1 and c[0]["kind"] == "schedule"


def run_load_diversity(project: ProjectData):
    """Run load diversity and demand factor analysis.

    Returns dict with 'buses' (one row per board, buses and distribution
    boards alike), 'transformers', 'summary', 'warnings', the reference
    demand factors and the Ks table.
    """
    comp_map = {c.id: c for c in project.components}
    adj = _build_graph(project, comp_map)
    nodes = {c.id for c in project.components
             if c.type in NODE_TYPES
             and str(c.props.get("system", "ac")).lower() != "dc"}
    branches = _branches(nodes, comp_map, adj)
    depth, util_group = _depths(nodes, branches, comp_map)
    warnings = []

    # ── Orientation: each branch's parents (nearest the supply) and children.
    for b in branches:
        ends = [n for n in b["ends"] if n in depth]
        if b["has_source"]:
            # A supply branch feeds the root boards only. A local generator
            # on a utility-fed board is not an infeed for sharing (its output
            # is not netted off the demand — conservative).
            b["parents"] = []
            b["children"] = sorted(n for n in ends if depth[n] == 0
                                   and (b["has_utility"] or not util_group[n]))
            continue
        if not ends:
            b["parents"], b["children"] = [], []
            continue
        dmin = min(depth[n] for n in ends)
        b["parents"] = sorted(n for n in ends if depth[n] == dmin)
        b["children"] = sorted(n for n in ends if depth[n] > dmin)

    incoming = {n: [] for n in nodes}
    for b in branches:
        for c in b["children"]:
            incoming[c].append(b)

    def _share(child, b):
        """Share of a child's demand carried by branch b: by transformer
        rating when every incoming branch has one, else equal."""
        inc = incoming[child]
        if len(inc) <= 1:
            return 1.0
        def w(br):
            return sum(_num(comp_map[x].props, "rated_mva", 1.0) for x in br["xfmrs"])
        ws = [w(br) for br in inc]
        if all(v > 0 for v in ws):
            return w(b) / sum(ws)
        return 1.0 / len(inc)

    load_info = {lid: _load_demand(comp_map[lid])
                 for b in branches for lid in b["loads"]}
    node_res = {}

    def _branch_flow(b):
        """(installed kVA, installed kW, P, Q, cap kvar) carried by branch b
        toward its children and loads, as seen by one of its parents."""
        k = 1.0 / max(1, len(b["parents"]))
        s = sum(load_info[l][0] for l in b["loads"])
        kw = sum(load_info[l][1] for l in b["loads"])
        p = sum(load_info[l][3] for l in b["loads"])
        q = sum(load_info[l][4] for l in b["loads"])
        for c in b["children"]:
            r, sh = node_res[c], _share(c, b)
            s += sh * r["_s_inst"]
            kw += sh * r["_kw_inst"]
            p += sh * r["_p"]
            q += sh * r["_q"]
        cap = sum(_cap_kvar(comp_map[x]) for x in b["caps"])
        return s * k, kw * k, p * k, q * k, cap * k

    # ── Roll demand up from the far end (deepest nodes first).
    for nid in sorted(nodes, key=lambda n: (-depth.get(n, -1), n)):
        node = comp_map[nid]
        circuits, s_inst, kw_inst, p_sum, q_sum, cap = [], 0.0, 0.0, 0.0, 0.0, 0.0
        if node.type == "distribution_board":
            # The board's own schedule (already diversified by DBSchedule:
            # Σ way VA × way DF × board diversity) is one circuit.
            s0, p0, dfi, pd, qd, pfi = _load_demand(node)
            if s0 > 0:
                circuits.append({"kind": "schedule", "id": nid, "name": f"{_name(node)} (schedule)",
                                 "loads": [nid], "installed_kva": s0, "installed_kw": p0,
                                 "p": pd, "q": qd})
                load_info[nid] = (s0, p0, dfi, pd, qd, pfi)
        for b in branches:
            if nid not in b["parents"]:
                continue
            bs, bkw, bp, bq, bc = _branch_flow(b)
            cap += bc
            if bs <= 0 and abs(bp) <= 0 and abs(bq) <= 0:
                continue
            if b["children"]:
                cn = [_name(comp_map[c]) for c in b["children"]]
                kind, cname = "feeder", ", ".join(cn)
            elif len(b["loads"]) == 1:
                kind, cname = "load", _name(comp_map[b["loads"][0]])
            else:
                kind, cname = "load", f"{len(b['loads'])} loads ({', '.join(_name(comp_map[l]) for l in b['loads'])})"
            # Parallel feeders to the same board(s) (two transformers, a
            # double-circuit cable) are one circuit for Ks.
            twin = next((c for c in circuits if b["children"] and not b["loads"]
                         and not c["loads"] and c["children"] == b["children"]), None)
            if twin:
                for k, v in (("installed_kva", bs), ("installed_kw", bkw), ("p", bp), ("q", bq)):
                    twin[k] += v
                continue
            circuits.append({"kind": kind, "id": (b["children"] or b["loads"] or [str(b["id"])])[0],
                             "name": cname, "loads": list(b["loads"]),
                             "children": list(b["children"]),
                             "installed_kva": bs, "installed_kw": bkw, "p": bp, "q": bq})
        for c in circuits:
            s_inst += c["installed_kva"]
            kw_inst += c["installed_kw"]
            p_sum += c["p"]
            q_sum += c["q"]
        # IEC 61439 covers LV assemblies; an MV board sums its circuits.
        kv = _node_kv(node)
        ks = coincidence_factor(len(circuits)) if kv <= 1.0 else 1.0
        p_div, q_div = ks * p_sum, ks * q_sum - cap
        node_res[nid] = {"_s_inst": s_inst, "_kw_inst": kw_inst, "_p": p_div, "_q": q_div,
                         "_p0": p_sum, "_q0": q_sum, "_cap": cap,
                         "_ks": ks, "_circuits": circuits}

    # ── Board rows.
    bus_results = []
    for nid in sorted(nodes, key=lambda n: (depth.get(n, 99), n)):
        r = node_res[nid]
        if r["_s_inst"] <= 0:
            continue
        node = comp_map[nid]
        if _leaf_board(node, r) and incoming[nid]:
            continue            # listed as a load of the board feeding it
        kv = _node_kv(node)
        s_div = math.hypot(r["_p"], r["_q"])
        s_dem = math.hypot(r["_p0"], r["_q0"])
        loads = []
        for c in r["_circuits"]:
            for lid in c["loads"]:
                s0, p0, dfi, pd, qd, pfi = load_info[lid]
                lc = comp_map[lid]
                loads.append({
                    "load_id": lid, "load_name": _name(lc), "load_type": lc.type,
                    "installed_kva": round(s0, 2), "installed_kw": round(p0, 2),
                    "demand_factor": round(dfi, 3),
                    "demand_kva": round(s0 * dfi, 2), "demand_kw": round(pd, 2),
                    "power_factor": round(pfi, 3),
                })
        # A leaf board (only its schedule) reads as a load of its parent.
        for c in r["_circuits"]:
            for ch in c.get("children", []):
                if _leaf_board(comp_map[ch], node_res[ch]):
                    s0, p0, dfi, pd, qd, pfi = load_info[ch]
                    loads.append({
                        "load_id": ch, "load_name": _name(comp_map[ch]),
                        "load_type": "distribution_board",
                        "installed_kva": round(s0, 2), "installed_kw": round(p0, 2),
                        "demand_factor": round(dfi, 3),
                        "demand_kva": round(s0 * dfi, 2), "demand_kw": round(pd, 2),
                        "power_factor": round(pfi, 3),
                    })
        parents = sorted({p for b in incoming[nid] for p in b["parents"]})
        bus_results.append({
            "bus_id": nid,
            "bus_name": _name(node),
            "node_type": node.type,
            "voltage_kv": kv,
            "fed_from": [_name(comp_map[p]) for p in parents],
            "num_loads": len(loads),
            "num_circuits": len(r["_circuits"]),
            "circuits": [{"kind": c["kind"], "id": c["id"], "name": c["name"],
                          "installed_kva": round(c["installed_kva"], 2),
                          "demand_kva": round(math.hypot(c["p"], c["q"]), 2),
                          "demand_kw": round(c["p"], 2)} for c in r["_circuits"]],
            "loads": loads,
            "installed_kva": round(r["_s_inst"], 2),
            "installed_kw": round(r["_kw_inst"], 2),
            "demand_kva": round(s_dem, 2),
            "demand_kw": round(r["_p0"], 2),
            "diversity_factor": round(r["_ks"], 3),
            "capacitor_kvar": round(r["_cap"], 2),
            "diversified_demand_kva": round(s_div, 2),
            "diversified_demand_kw": round(r["_p"], 2),
            "diversified_demand_kvar": round(r["_q"], 2),
            "effective_demand_factor": round(s_div / r["_s_inst"], 3) if r["_s_inst"] > 0 else 1.0,
            "demand_current_a": round(s_div / (math.sqrt(3) * kv), 1) if kv > 0 else 0,
        })

    # ── Transformer loading.
    branch_of = {m: b for b in branches for m in b["members"]}
    transformer_results = []
    for xfmr in [c for c in project.components if c.type in TRANSFORMER_TYPES]:
        rated_kva = _num(xfmr.props, "rated_mva", 1.0) * 1000
        b = branch_of.get(xfmr.id)
        s_inst = p = q = 0.0
        fed, issues, shared = [], [], []
        if b is None:
            issues.append("Not connected to the network (switched out)")
        else:
            sides = _side_sets(xfmr.id, b, comp_map, adj)
            up = [port for port, reach in sides.items()
                  if (reach & set(b["parents"]))
                  or any(comp_map[x].type in SOURCE_TYPES for x in reach if x in comp_map)]
            dangling = len(sides) == 1 and not b["has_source"]
            if not dangling and (len(sides) < 2 or len(up) != 1):
                issues.append("Supply direction not found — no load counted")
            else:
                # One winding drawn, nothing on the other: the undrawn side
                # is the supply.
                down = set().union(*(reach for port, reach in sides.items()
                                     if dangling or port != up[0]))
                for lid in sorted(x for x in down if x in b["loads"]):
                    s0, _, _, pd, qd, _ = load_info[lid]
                    s_inst += s0
                    p += pd
                    q += qd
                    fed.append(_name(comp_map[lid]))
                for ch in sorted(x for x in down if x in nodes
                                 and (x in b["children"] or dangling)):
                    r, sh = node_res[ch], (1.0 if dangling else _share(ch, b))
                    s_inst += sh * r["_s_inst"]
                    p += sh * r["_p"]
                    q += sh * r["_q"]
                    fed.append(_name(comp_map[ch]))
                    if sh < 1.0:
                        shared += [_name(comp_map[x]) for ob in incoming[ch] if ob is not b
                                   for x in ob["xfmrs"]]
                q -= sum(_cap_kvar(comp_map[x]) for x in down if x in b["caps"])
        s_dem = math.hypot(p, q)
        installed_pct = s_inst / rated_kva * 100 if rated_kva > 0 else 0
        demand_pct = s_dem / rated_kva * 100 if rated_kva > 0 else 0
        if demand_pct > 100:
            status = "fail"
        elif demand_pct > 80 or installed_pct > 100:
            status = "warning"
        else:
            status = "pass"
        if demand_pct > 100:
            issues.append(f"Demand-adjusted loading {demand_pct:.0f}% exceeds transformer rating")
        elif installed_pct > 100:
            issues.append(f"Installed load {installed_pct:.0f}% exceeds rating, but demand-adjusted {demand_pct:.0f}% is within limits")
        if demand_pct > 80:
            issues.append(f"Transformer loading {demand_pct:.0f}% — consider capacity margin")
        if shared:
            issues.append("Shares its load with " + ", ".join(sorted(set(shared)))
                          + " in proportion to rating")
        transformer_results.append({
            "transformer_id": xfmr.id,
            "transformer_name": _name(xfmr),
            "rated_kva": round(rated_kva, 1),
            "fed_buses": fed,
            "shared_with": sorted(set(shared)),
            "installed_kva": round(s_inst, 2),
            "demand_kva": round(s_dem, 2),
            "demand_kw": round(p, 2),
            "installed_loading_pct": round(installed_pct, 1),
            "demand_loading_pct": round(demand_pct, 1),
            "status": status,
            "issues": issues,
        })

    # ── Summary: every load once; demand at the supply (root) boards.
    roots = [n for n in nodes if depth.get(n) == 0]
    counted = {l for b in branches if b["parents"] for l in b["loads"]} | \
              {n for n in nodes if comp_map[n].type == "distribution_board"}
    total_inst_kva = sum(node_res[n]["_s_inst"] for n in roots)
    total_inst_kw = sum(node_res[n]["_kw_inst"] for n in roots)
    total_p = sum(node_res[n]["_p"] for n in roots)
    total_dem_kva = sum(math.hypot(node_res[n]["_p"], node_res[n]["_q"]) for n in roots)
    # A motor behind its drive is represented by the drive; a load behind an
    # open device is switched out.
    orphans = [_name(c) for c in project.components
               if c.type in LOAD_TYPES and c.id not in counted
               and not any(_is_open(comp_map[nb]) or comp_map[nb].type == "vfd"
                           for nb, _ in adj.get(c.id, []))]
    if orphans:
        warnings.append("Not counted (no bus or board found upstream): " + ", ".join(sorted(orphans)))
    overall_df = total_dem_kva / total_inst_kva if total_inst_kva > 0 else 1.0
    summary = {
        "total_installed_kva": round(total_inst_kva, 2),
        "total_installed_kw": round(total_inst_kw, 2),
        "total_demand_kva": round(total_dem_kva, 2),
        "total_demand_kw": round(total_p, 2),
        "overall_demand_factor": round(overall_df, 3),
        "num_buses_with_loads": len(bus_results),
        "num_transformers": len(transformer_results),
    }

    return {
        "buses": bus_results,
        "transformers": transformer_results,
        "summary": summary,
        "warnings": warnings,
        "reference_demand_factors": REFERENCE_DEMAND_FACTORS,
        "ks_table": [{"circuits": "1", "ks": 1.0}, {"circuits": "2–3", "ks": 0.9},
                     {"circuits": "4–5", "ks": 0.8}, {"circuits": "6–9", "ks": 0.7},
                     {"circuits": "10 and more", "ks": 0.6}],
    }

