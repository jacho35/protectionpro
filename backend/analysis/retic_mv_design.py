"""MV network between the mini-subs of a reticulation layout (radial or ring).

Takes the placed mini-subs, one MV supply point and (optionally) the street
centrelines, lays the MV cable along the streets and picks the smallest cable
from the supplied ladder that passes **all three** checks:

* volt drop at every mini-sub primary, full load, against a project limit,
* fault level: the prospective fault current at the sending end of every
  section against the cable's short-circuit withstand for the clearing time
  (and the switchgear rating when one is given),
* cable rating: the section current against the installed rating (base rating
  × laying factor).

A ring is checked with every single section out of service in turn (the open
point moves, each half then feeds the whole ring), and the normal open point is
the section whose opening gives the lowest worst volt drop. One cable size is
used for the whole network (a ring half must carry the whole ring).

Lengths are metres, power kVA, voltage kV, impedances ohm/km. Pure: no I/O.
"""

import itertools
import math

from .path_graph import PathGraph, connect, dist

INF = float("inf")
K_SC = {"Cu": 143.0, "Al": 94.0}   # IEC 60364-4-43 Table 43.1, XLPE 90 → 250 °C, A·√s/mm²
SUPPLY = "S"


def _legs(points, graph):
    """Pairwise route lengths and polylines between named points."""
    names = list(points)
    legs = {}
    for a, b in itertools.combinations(names, 2):
        if graph is None:
            r = {"length": dist(points[a], points[b]), "points": [points[a], points[b]]}
        else:
            r = connect(graph, points[a], points[b])
        legs[(a, b)] = legs[(b, a)] = r
    return legs


def _len(legs, a, b):
    r = legs.get((a, b))
    return r["length"] if r else INF


def _mst(subs, legs):
    """Prim from the supply: {sub: (parent, length)}."""
    inside = {SUPPLY}
    tree = {}
    while len(inside) <= len(subs):
        best = None
        for s in subs:
            if s in inside:
                continue
            for p in inside:
                d = _len(legs, p, s)
                if best is None or d < best[0]:
                    best = (d, p, s)
        if best is None or best[0] == INF:
            return None
        tree[best[2]] = (best[1], best[0])
        inside.add(best[2])
    return tree


def _tour(subs, legs):
    """Closed tour through the supply and every sub: nearest neighbour + 2-opt."""
    order = [SUPPLY]
    left = list(subs)
    while left:
        nxt = min(left, key=lambda s: _len(legs, order[-1], s))
        left.remove(nxt)
        order.append(nxt)

    def total(o):
        return sum(_len(legs, o[i], o[(i + 1) % len(o)]) for i in range(len(o)))
    improved = len(order) > 3
    while improved:
        improved = False
        for i in range(1, len(order) - 1):
            for j in range(i + 1, len(order)):
                cand = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                if total(cand) < total(order) - 1e-9:
                    order, improved = cand, True
    return order if total(order) < INF else None


def _ring_scenarios(order, legs):
    """One scenario per section taken out: {sub: (parent, length, section)}."""
    n = len(order)               # supply + subs
    out = {}
    for k in range(n):           # section k joins order[k] and order[(k+1) % n]
        tree = {}
        for m in range(1, k + 1):          # forward arm from the supply
            tree[order[m]] = (order[m - 1], _len(legs, order[m - 1], order[m]), m - 1)
        for m in range(n - 1, k, -1):      # backward arm
            nxt = order[(m + 1) % n]
            tree[order[m]] = (nxt, _len(legs, nxt, order[m]), m)
        out[k] = tree
    return out


def _evaluate(tree, kva, cable, cfg):
    """Volt drop, section current and fault level of one feeding tree with one cable."""
    u = cfg["u_kv"] * 1000.0
    sin = math.sqrt(max(0.0, 1 - cfg["pf"] ** 2))
    r, x = cable["r_ohm_km"], cable["x_ohm_km"]
    xs = u * u / (cfg["fault_mva"] * 1e6)
    parent = {s: p for s, (p, _, _) in tree.items()}
    down = {s: kva[s] for s in tree}
    for s in sorted(tree, key=lambda s: -_depth(s, parent)):     # leaves first
        p = parent[s]
        if p != SUPPLY:
            down[p] += down[s]
    vd, zc, sections = {}, {SUPPLY: complex(0, xs)}, []
    for s in sorted(tree, key=lambda s: _depth(s, parent)):      # root first
        p, length, sec = tree[s]
        km = length / 1000.0
        i = down[s] * 1000.0 / (math.sqrt(3) * u)
        d = math.sqrt(3) * i * km * (r * cfg["pf"] + x * sin) / u * 100.0
        vd[s] = vd.get(p, 0.0) + d
        z_send = zc[p]
        zc[s] = z_send + complex(r * km, x * km)
        ik = cfg["c"] * u / (math.sqrt(3) * abs(z_send))
        sections.append({"to": s, "from": p, "section": sec, "length_m": length,
                         "current_a": i, "ik_send_a": ik, "kva": down[s]})
    worst_vd = max(vd.items(), key=lambda kv: kv[1]) if vd else (None, 0.0)
    return {"vd": worst_vd, "sections": sections,
            "i_max": max((s["current_a"] for s in sections), default=0.0),
            "ik_max": max((s["ik_send_a"] for s in sections), default=0.0)}


def _depth(s, parent):
    d = 0
    while s != SUPPLY:
        s = parent[s]
        d += 1
    return d


def _verdict(cable, scen, cfg):
    """Pass / fail of the three checks (plus switchgear) for one cable over every scenario."""
    a = cable["size_mm2"]
    k = cable.get("k_sc") or K_SC.get(cable.get("conductor", "Al"), K_SC["Al"])
    i_allow = k * a / math.sqrt(cfg["clearing_s"])
    rating = cable["rating_a"] * cfg["laying"]
    worst = {"vd": (None, 0.0, None), "i": (0.0, None), "ik": 0.0}
    for key, tree_eval in scen.items():
        ev = tree_eval(cable)
        if ev["vd"][1] > worst["vd"][1]:
            worst["vd"] = (ev["vd"][0], ev["vd"][1], key)
        if ev["i_max"] > worst["i"][0]:
            worst["i"] = (ev["i_max"], key)
        worst["ik"] = max(worst["ik"], ev["ik_max"])
    fails = []
    if worst["vd"][1] > cfg["vd_pct"] + 1e-9:
        fails.append("volt_drop")
    if worst["ik"] > i_allow + 1e-9:
        fails.append("fault_level")
    if worst["i"][0] > rating + 1e-9:
        fails.append("cable_rating")
    if cfg.get("switchgear_ka") and worst["ik"] / 1000 > cfg["switchgear_ka"] + 1e-9:
        fails.append("switchgear")
    return {"fails": fails, "worst": worst, "i_allow_a": i_allow, "rating_a": rating}


def design_mv(req):
    topology = req.get("topology") or "radial"
    if topology not in ("radial", "ring"):
        raise ValueError("topology must be 'radial' or 'ring'")
    sup = req["supply"]
    subs_in = req.get("subs") or []
    if not subs_in:
        raise ValueError("at least one mini-sub is needed")
    lim = req.get("limits") or {}
    cfg = {"u_kv": float(req.get("voltage_kv") or 11.0), "pf": float(lim.get("pf") or 0.95),
           "vd_pct": float(lim.get("vd_pct") or 2.0), "fault_mva": float(sup["fault_mva"]),
           "clearing_s": float(sup.get("clearing_time_s") or 0.5), "c": float(lim.get("c") or 1.1),
           "laying": float((req.get("laying") or {}).get("factor") or 1.0),
           "switchgear_ka": lim.get("switchgear_ka")}
    ladder = sorted(req.get("cables") or [], key=lambda c: c["size_mm2"])
    if not ladder:
        raise ValueError("a cable ladder is needed")
    pts = {SUPPLY: (float(sup["x"]), float(sup["y"]))}
    kva = {}
    for s in subs_in:
        pts[s["id"]] = (float(s["x"]), float(s["y"]))
        kva[s["id"]] = float(s.get("kva") or 0)
    names = [s["id"] for s in subs_in]
    graph = PathGraph(req["network"]) if req.get("network") else None
    legs = _legs(pts, graph)
    checks = []

    def check(sev, code, text, **kw):
        checks.append({"severity": sev, "code": code, "text": text, **kw})

    note = None
    if topology == "ring" and len(names) < 2:
        topology, note = "radial", "A ring needs at least two mini-subs; designed as radial."
        check("warn", "ring_needs_two", note)

    if topology == "radial":
        tree = _mst(names, legs)
        if tree is None:
            check("fail", "unreachable", "A mini-sub cannot be reached along the streets.")
            return {"topology": topology, "cable": None, "sections": [], "checks": checks}
        scen = {0: tree}
        order = None
        trees = {0: {s: (p, d, i) for i, (s, (p, d)) in enumerate(tree.items())}}
    else:
        order = _tour(names, legs)
        if order is None:
            check("fail", "unreachable", "A mini-sub cannot be reached along the streets.")
            return {"topology": topology, "cable": None, "sections": [], "checks": checks}
        trees = _ring_scenarios(order, legs)

    def scen_for(cable):
        return {k: (lambda c, t=t: _evaluate(t, kva, c, cfg)) for k, t in trees.items()}
    scenarios = scen_for(None)

    chosen, governing, last = None, None, None
    prev = None
    for cable in ladder:
        v = _verdict(cable, scenarios, cfg)
        last = (cable, v)
        if not v["fails"]:
            chosen = (cable, v)
            governing = prev[1]["fails"] if prev else []
            break
        prev = (cable, v)
    cable, v = chosen or last

    # the normal open point of a ring: the section whose opening gives the lowest worst volt drop
    open_point = None
    if topology == "ring":
        drops = {k: _evaluate(trees[k], kva, cable, cfg)["vd"][1] for k in trees}
        open_point = min(drops, key=drops.get)
        normal_tree = trees[open_point]
    else:
        normal_tree = trees[0]
    ev = _evaluate(normal_tree, kva, cable, cfg)

    ring_names = None
    if order:
        n = len(order)
        ring_names = [{"section": k, "from": order[k], "to": order[(k + 1) % n],
                       "length_m": round(_len(legs, order[k], order[(k + 1) % n]), 1)} for k in range(n)]
    sections = []
    for s in ev["sections"]:
        leg = legs.get((s["from"], s["to"]))
        sections.append({"from": s["from"], "to": s["to"], "length_m": round(s["length_m"], 1),
                         "current_a": round(s["current_a"], 1), "kva": round(s["kva"], 1),
                         "ik_send_ka": round(s["ik_send_a"] / 1000, 2),
                         "route": [list(p) for p in leg["points"]] if leg else None})

    w = v["worst"]
    lims = {"volt_drop": cfg["vd_pct"]}
    if not v["fails"]:
        check("pass", "all_pass", f"{cable['size_mm2']} mm² passes volt drop, fault level and cable rating"
                                  + (" with any one section out." if topology == "ring" else "."))
    for f in v["fails"]:
        if f == "volt_drop":
            where = f" at {w['vd'][0]}" + (f" with section {w['vd'][2]} out" if topology == "ring" else "")
            check("fail", f, f"Volt drop {w['vd'][1]:.2f} %{where}, over {cfg['vd_pct']:.2f} %.", fix=_next(ladder, cable))
        elif f == "fault_level":
            check("fail", f, f"Fault current {w['ik'] / 1000:.1f} kA against {v['i_allow_a'] / 1000:.1f} kA "
                             f"withstand for {cfg['clearing_s']} s.", fix=_next(ladder, cable))
        elif f == "cable_rating":
            check("fail", f, f"Section current {w['i'][0]:.0f} A against an installed rating of {v['rating_a']:.0f} A"
                             + (f" with section {w['i'][1]} out." if topology == "ring" else "."), fix=_next(ladder, cable))
        else:
            check("fail", f, f"Fault current {w['ik'] / 1000:.1f} kA exceeds the switchgear rating "
                             f"{cfg['switchgear_ka']} kA.")
    return {
        "topology": topology, "voltage_kv": cfg["u_kv"],
        "cable": {k: cable[k] for k in cable} if not v["fails"] else None,
        "tried_largest": cable if v["fails"] else None,
        "governed_by": governing,
        "open_point": open_point,
        "ring_sections": ring_names,
        "sections": sections,
        "worst": {"vd_pct": round(w["vd"][1], 3), "vd_at": w["vd"][0], "vd_scenario": w["vd"][2],
                  "current_a": round(w["i"][0], 1), "ik_ka": round(w["ik"] / 1000, 2),
                  "withstand_ka": round(v["i_allow_a"] / 1000, 2), "rating_a": round(v["rating_a"], 1)},
        "normal": {"vd_pct": round(ev["vd"][1], 3), "vd_at": ev["vd"][0]},
        "total_length_m": round(sum(s["length_m"] for s in sections), 1),
        "limits": lims, "checks": checks,
    }


def _next(ladder, cable):
    i = ladder.index(cable)
    if i + 1 < len(ladder):
        return {"label": f"Next size: {ladder[i + 1]['size_mm2']} mm²", "size_mm2": ladder[i + 1]["size_mm2"]}
    return None
