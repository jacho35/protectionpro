"""Cascading (back-up protection, IEC 60947-2 Annex A / IEC 60364-5-53 §536.4.2).

A breaker whose own breaking capacity is below the fault current where it is
installed is still acceptable when a breaker upstream of it, TESTED IN
COMBINATION with it, gives a reinforced breaking capacity that covers the fault.
The figure only exists in a manufacturer's table (cascading_data.py, generated
from the Schneider Electric guide by
testing/vendor-libraries/build_schneider_cascading.py) — it is never computed.

The rule, as the guide states it for three breakers A > B > C in series: C is
covered when A + C reaches the fault at C, or when B + C does and B is itself
adequate (its own capacity, or covered by A). `cover` applies it to a chain;
`supply_chain` finds the chain of series breakers above a diagram breaker. The
frontend mirror is frontend/js/cascading.js (DB schedules, compliance).
"""

from .cascading_data import CASCADE_TABLES, LIBRARY_MODELS

SOURCE_TYPES = {"utility", "generator", "solar_pv", "wind_turbine", "battery"}
# Elements the supply-path walk passes through (same voltage, no protection of
# their own that the tables know). A transformer ends the walk: the tables are
# for breakers on one system voltage.
_PASS_THROUGH = {"bus", "distribution_board", "cable", "switch", "fuse", "ct", "pt",
                 "surge_arrester", "bus_duct", "offpage_connector"}


def applies_at(kv):
    """The tables' Ue: 380-415 V AC three-phase, or its 220-240 V Ph/N circuits
    (the 380-415 V figures cover the line-to-earth fault there, the guide's A-193
    note)."""
    kv = float(kv or 0)
    return 0.38 - 1e-9 <= kv <= 0.415 + 1e-9 or 0.22 - 1e-9 <= kv <= 0.24 + 1e-9


def device_ref(props):
    """{model, rating_a, maker} of a diagram breaker picked from a manufacturer
    library (its `standard_type` id), else None."""
    hit = LIBRARY_MODELS.get(str((props or {}).get("standard_type") or ""))
    if not hit:
        return None
    return {"model": hit[0], "rating_a": float(hit[1]),
            "maker": CASCADE_TABLES[0]["manufacturer"]}


def _in(rating, band):
    return band is None or band[0] - 1e-9 <= rating <= band[1] + 1e-9


def reinforced_ka(up, down):
    """Reinforced breaking capacity (kA) of `down` behind `up` (refs from
    device_ref), or None when the pair is not a tested combination."""
    if not up or not down or up.get("maker") != down.get("maker"):
        return None
    for doc in CASCADE_TABLES:
        if doc["manufacturer"] != up["maker"]:
            continue
        for t in doc["tables"]:
            cols = [k for k, u in enumerate(t["upstream"])
                    if u["model"] == up["model"] and _in(up["rating_a"], u["rating_a"])]
            if not cols:
                continue
            for r in t["rows"]:
                if r["model"] == down["model"] and _in(down["rating_a"], r["rating_a"]):
                    vals = [r["values"][k] for k in cols if r["values"][k]]
                    if vals:
                        return float(max(vals))
    return None


def source_note():
    d = CASCADE_TABLES[0]
    return f"{d['manufacturer']} cascading table, {d['standard']}"


def cover(chain):
    """Back-up cover of chain[0] by the breakers above it.

    chain: nearest-first list of {"ref", "capacity_ka", "duty_ka"} — chain[0]
    the breaker being checked, chain[1] the next breaker towards the source, …
    Returns {"by": index, "reinforced_ka"} for the nearest breaker that covers
    chain[0] (the combination reaches its duty and that breaker is adequate in
    turn), or None.
    """
    memo = {}

    def adequate(i):
        if i in memo:
            return memo[i]
        memo[i] = False                      # cycle guard
        c = chain[i]
        ok = (c.get("capacity_ka") or 0) >= (c.get("duty_ka") or 0) - 1e-9 or covered(i) is not None
        memo[i] = ok
        return ok

    def covered(i):
        duty = chain[i].get("duty_ka") or 0
        for j in range(i + 1, len(chain)):
            ka = reinforced_ka(chain[j].get("ref"), chain[i].get("ref"))
            if ka is not None and ka >= duty - 1e-9 and adequate(j):
                return {"by": j, "reinforced_ka": ka}
        return None

    return covered(0)


def _reaches_source(start, blocked, adj, comp_map):
    seen = set(blocked) | {start}
    stack = [start]
    while stack:
        nid = stack.pop()
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type in SOURCE_TYPES:
            return True
        if comp.type in ("cb", "switch") and str(comp.props.get("state", "closed")).lower() == "open":
            continue
        for nb, _ in adj.get(nid, []):
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return False


def supply_chain(device_id, adj, comp_map):
    """Series breakers above a diagram breaker, nearest first.

    Returns (chain_ids, note). The walk goes from the breaker's supply side
    through buses, cables, closed switches, fuses, CTs … to the next breaker,
    and on from that breaker's supply side. It stops at a transformer or a
    source, and it stops — without the breaker it reached — where the fault is
    fed from more than one side (a second infeed or a meshed path): the
    upstream breaker would then carry only part of the fault, which is not what
    the combination was tested for.
    """
    chain, note = [], None
    cur, seen = device_id, {device_id}
    while True:
        sides = [nb for nb, _ in adj.get(cur, []) if nb not in seen
                 and _reaches_source(nb, seen | {cur}, adj, comp_map)]
        if len(sides) != 1:
            if len(sides) > 1:
                note = "fed from both sides"
            break
        # the region on the supply side, up to the next breaker(s) and whatever
        # else bounds it (sources, transformers, loads)
        region, stack, found, edge = set(), [sides[0]], [], []
        while stack:
            nid = stack.pop()
            if nid in region or nid in seen or nid in found or nid in edge:
                continue
            comp = comp_map.get(nid)
            if not comp:
                continue
            if comp.type == "cb":
                if str(comp.props.get("state", "closed")).lower() != "open":
                    found.append(nid)
                continue
            if comp.type not in _PASS_THROUGH:
                edge.append(nid)
                continue
            region.add(nid)
            if comp.type == "switch" and str(comp.props.get("state", "closed")).lower() == "open":
                continue
            for nb, _ in adj.get(nid, []):
                stack.append(nb)
        blocked = seen | region | {cur}
        ups = [b for b in found if _reaches_source(b, blocked, adj, comp_map)]
        # a source, or a transformer leading to one, feeding the region
        # straight (not through a breaker)
        direct = any(comp_map[e].type in SOURCE_TYPES or _reaches_source(e, blocked, adj, comp_map)
                     for e in edge)
        if len(ups) + (1 if direct else 0) > 1:
            note = "more than one infeed"
            break
        if not ups:
            break
        chain.append(ups[0])
        seen |= region | {cur}
        cur = ups[0]
    return chain, note
