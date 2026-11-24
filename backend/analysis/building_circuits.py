"""Building circuiting: boards, circuits and cable routes from placed devices.

Works on what is already on the plan (rooms, devices, boards) and proposes:

1. which of the *placed* boards feeds each room (nearest by route length that
   still has free ways and rating; a hand override is kept; no board is added),
2. circuits: devices grouped by room and type under project rules (points and
   load per circuit, dedicated circuits for big loads, earth-leakage groups,
   spare ways, way order), phases balanced across R / W / B,
3. a route from every circuit's board to its devices in one of three modes:
   ``containment`` (along drawn tray / trunking / conduit), ``walls`` (round
   the room outlines and through doors) or ``ceiling`` (straight lines in the
   ceiling void with vertical drops).

Everything is pure (no I/O); coordinates and lengths are metres. Nothing here
writes to a project: the caller reviews the answer and creates the items.
"""

import math

from .path_graph import PathGraph, connect, dist, nearest_on_segment

MODES = ("containment", "walls", "ceiling")
PHASES = ("R", "W", "B")

DEFAULT_RULES = {
    "max_points": {"light": 10, "socket": 6, "other": 6},   # devices per circuit
    "max_va": {"light": None, "socket": None, "other": None},  # load per circuit
    "dedicated_va": 2000,        # a device at or above this load has its own circuit
    "spare_ways": 3,             # ways left free on every board
    "el_group_size": 4,          # ways behind one earth-leakage unit
    "el_for": ["socket", "dedicated"],  # circuit groups that get earth-leakage
    "way_order": ["light", "socket", "dedicated", "other"],
    "slack_pct": 10.0,           # cable allowance on every route
    "ceil_h": 2.7,               # m, when a room has none
    "board_mount_h": 1.8,        # m
    "device_mount_h": {"light": 2.7, "socket": 0.3, "dedicated": 1.2, "other": 1.2},
    "max_drop": 3.0,             # m from a device or board to drawn containment
    "imbalance_warn_pct": 20.0,
}


def _poly_centroid(poly):
    a = cx = cy = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if abs(a) < 1e-9:
        return (sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n)
    return (cx / (3 * a), cy / (3 * a))


def _merge_rules(user):
    r = {k: (dict(v) if isinstance(v, dict) else (list(v) if isinstance(v, list) else v))
         for k, v in DEFAULT_RULES.items()}
    for k, v in (user or {}).items():
        if k in r and isinstance(r[k], dict) and isinstance(v, dict):
            r[k].update(v)
        elif k in r:
            r[k] = v
    return r


def _group_of(dev, rules):
    if dev.get("group") in ("light", "socket", "dedicated", "other"):
        return dev["group"]
    t = str(dev.get("type") or "")
    va = float(dev.get("va") or 0)
    if va >= rules["dedicated_va"] > 0:
        return "dedicated"
    if "light" in t:
        return "light"
    if "socket" in t:
        return "socket"
    return "other"


class _Router:
    """Leg lengths between two points in one of the three modes."""

    def __init__(self, req, rules):
        self.rules = rules
        self.rooms = {r["id"]: r for r in req.get("rooms", [])}
        self._graphs = {}
        self.req = req

    def _graph(self, mode):
        if mode in self._graphs:
            return self._graphs[mode]
        g = None
        if mode == "containment":
            lines = [pl for pl in self.req.get("containment", []) if len(pl) >= 2]
            g = PathGraph(lines) if lines else None
        elif mode == "walls":
            rings = []
            for r in self.rooms.values():
                p = [tuple(q) for q in r.get("polygon", [])]
                if len(p) >= 3:
                    rings.append(p + [p[0]])
            extra = []
            for d in self.req.get("doors", []):
                door = (float(d["x"]), float(d["y"]))
                for rid in d.get("rooms", []):
                    poly = self.rooms.get(rid, {}).get("polygon", [])
                    best = None
                    for i in range(len(poly)):
                        c, dd = nearest_on_segment(door, poly[i], poly[(i + 1) % len(poly)])
                        if best is None or dd < best[1]:
                            best = (c, dd)
                    if best is not None:
                        extra.append((best[0], door))
            g = PathGraph(rings, extra) if rings else None
        self._graphs[mode] = g
        return g

    def leg(self, a, b, mode, mount_a=None, mount_b=None, ceil_h=None):
        """{length, points} for one leg, or None when the mode has no route."""
        if mode == "ceiling":
            h = ceil_h if ceil_h is not None else self.rules["ceil_h"]
            da = abs(h - mount_a) if mount_a is not None else 0.0
            db = abs(h - mount_b) if mount_b is not None else 0.0
            return {"length": dist(a, b) + da + db, "points": [tuple(a), tuple(b)]}
        g = self._graph(mode)
        if g is None:
            return None
        md = self.rules["max_drop"] if mode == "containment" else None
        r = connect(g, a, b, md)
        if r is None:
            return None
        return {"length": r["length"], "points": r["points"]}


def _chain(origin, devs):
    """Visit order: nearest neighbour from the board, then 2-opt on the open path."""
    left = list(devs)
    order = []
    cur = origin
    while left:
        nxt = min(left, key=lambda d: dist(cur, (d["x"], d["y"])))
        left.remove(nxt)
        order.append(nxt)
        cur = (nxt["x"], nxt["y"])
    pts = lambda o: [origin] + [(d["x"], d["y"]) for d in o]

    def length(o):
        p = pts(o)
        return sum(dist(p[i], p[i + 1]) for i in range(len(p) - 1))
    improved = len(order) > 2 and len(order) <= 16
    while improved:
        improved = False
        for i in range(len(order) - 1):
            for j in range(i + 1, len(order)):
                cand = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                if length(cand) < length(order) - 1e-9:
                    order, improved = cand, True
    return order


def _split(devs, group, rules):
    """Chunk an ordered device list into circuits under the point / load caps."""
    if group == "dedicated":
        return [[d] for d in devs]
    cap_n = int(rules["max_points"].get(group) or rules["max_points"]["other"])
    cap_va = rules["max_va"].get(group)
    out, cur, load = [], [], 0.0
    for d in devs:
        va = float(d.get("va") or 0)
        if cur and (len(cur) >= cap_n or (cap_va and load + va > cap_va)):
            out.append(cur)
            cur, load = [], 0.0
        cur.append(d)
        load += va
    if cur:
        out.append(cur)
    return out


def _count_circuits(devs, rules):
    by = {}
    for d in devs:
        by.setdefault(_group_of(d, rules), []).append(d)
    return sum(len(_split(v, g, rules)) for g, v in by.items())


def design_circuits(req):
    rules = _merge_rules(req.get("rules"))
    mode = req.get("mode") or "walls"
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    by_group = req.get("mode_by_group") or {}
    overrides = req.get("mode_overrides") or {}      # "<room>:<group>" -> mode
    router = _Router(req, rules)
    checks = []

    def check(sev, code, text, **kw):
        checks.append({"severity": sev, "code": code, "text": text, **kw})

    boards = {b["id"]: dict(b) for b in req.get("boards", [])}
    rooms = {r["id"]: r for r in req.get("rooms", [])}
    devices = [d for d in req.get("devices", []) if d.get("room_id") in rooms]
    for b in boards.values():
        # no way count on the board (or 0) = not limited
        b["_free"] = (int(b["ways_total"]) - int(b.get("ways_used") or 0)) if b.get("ways_total") else math.inf
        b["_va"] = float(b.get("max_va") or 0) - float(b.get("used_va") or 0) if b.get("max_va") else math.inf
        b["_pos"] = (float(b["x"]), float(b["y"]))
        b["_rooms"] = []

    # 1. rooms to boards ----------------------------------------------------
    by_room = {}
    for d in devices:
        by_room.setdefault(d["room_id"], []).append(d)
    order = sorted(by_room, key=lambda rid: -sum(float(d.get("va") or 0) for d in by_room[rid]))
    assignment = {}
    for rid in order:
        r = rooms[rid]
        devs = by_room[rid]
        need = _count_circuits(devs, rules)
        load = sum(float(d.get("va") or 0) for d in devs)
        ctr = _poly_centroid(r["polygon"]) if len(r.get("polygon", [])) >= 3 else (devs[0]["x"], devs[0]["y"])
        forced = r.get("board_override")
        if forced and forced in boards:
            cands = [boards[forced]]
        else:
            def rank(b):
                same = 0 if b.get("floor") == r.get("floor") else 1
                leg = router.leg(b["_pos"], ctr, mode)
                return (same, leg["length"] if leg else dist(b["_pos"], ctr) * 3 + 1e6)
            cands = sorted(boards.values(), key=rank)
        chosen = None
        for b in cands:
            if b["_free"] >= need and b["_va"] >= load:
                chosen = b
                break
        if chosen is None:
            check("fail", "no_board",
                  f"{r.get('name') or rid}: no placed board has {need} free way(s) and {round(load)} VA of rating left.",
                  room_id=rid)
            continue
        if cands and chosen is not cands[0] and not forced:
            check("warn", "board_not_nearest",
                  f"{r.get('name') or rid}: fed from {chosen.get('name') or chosen['id']}; the nearest board is full.",
                  room_id=rid, board_id=chosen["id"])
        chosen["_free"] -= need
        chosen["_va"] -= load
        chosen["_rooms"].append(rid)
        assignment[rid] = chosen["id"]

    # 2. circuits per board ---------------------------------------------------
    circuits = []
    board_out = []
    for b in boards.values():
        raw = []
        for rid in b["_rooms"]:
            groups = {}
            for d in by_room[rid]:
                groups.setdefault(_group_of(d, rules), []).append(d)
            for g, devs in groups.items():
                ordered = _chain(b["_pos"], devs)
                for chunk in _split(ordered, g, rules):
                    raw.append({"group": g, "room_id": rid, "devices": chunk})
        rank = {g: i for i, g in enumerate(rules["way_order"])}
        raw.sort(key=lambda c: (rank.get(c["group"], 99), c["room_id"]))
        way = int(b.get("ways_used") or 0)
        el_seq = 0
        el_n = 0
        for c in raw:
            way += 1
            c["way"] = way
            c["va"] = sum(float(d.get("va") or 0) for d in c["devices"])
            c["poles"] = "3P" if any(d.get("poles") == "3P" for d in c["devices"]) else "1P"
            if c["group"] in rules["el_for"] and rules["el_group_size"]:
                if el_n % int(rules["el_group_size"]) == 0:
                    el_seq += 1
                c["el_group"] = f"EL{el_seq}"
                el_n += 1
            else:
                c["el_group"] = ""
        # phases: whole units (an earth-leakage group shares a phase), largest first
        base = dict((b.get("phase_va") or {}))
        load = {p: float(base.get(p) or 0) for p in PHASES}
        units = {}
        for c in raw:
            if c["poles"] == "3P":
                c["phase"] = "RWB"
                for p in PHASES:
                    load[p] += c["va"] / 3
                continue
            units.setdefault(c["el_group"] or f"w{c['way']}", []).append(c)
        for key, cs in sorted(units.items(), key=lambda kv: -sum(c["va"] for c in kv[1])):
            p = min(PHASES, key=lambda q: load[q])
            for c in cs:
                c["phase"] = p
            load[p] += sum(c["va"] for c in cs)
        mean = sum(load.values()) / 3
        imb = (max(load.values()) - min(load.values())) / mean * 100 if mean > 0 else 0.0
        if imb > rules["imbalance_warn_pct"]:
            check("warn", "phase_imbalance",
                  f"{b.get('name') or b['id']}: phase loads differ by {imb:.0f} % "
                  f"(R {round(load['R'])} · W {round(load['W'])} · B {round(load['B'])} VA).",
                  board_id=b["id"])
        spare = (int(b["ways_total"]) - way) if b.get("ways_total") else None
        if spare is not None and spare < int(rules["spare_ways"]):
            check("warn", "spare_ways",
                  f"{b.get('name') or b['id']} has {max(spare, 0)} spare way(s); the rule is {int(rules['spare_ways'])}.",
                  board_id=b["id"])
        board_out.append({"board_id": b["id"], "ways_new": len(raw), "ways_spare": spare,
                          "phase_va": {p: round(load[p], 1) for p in PHASES},
                          "imbalance_pct": round(imb, 1)})

        # 3. routes ------------------------------------------------------------
        for c in raw:
            room = rooms[c["room_id"]]
            cm = overrides.get(f"{c['room_id']}:{c['group']}") or by_group.get(c["group"]) or mode
            if cm not in MODES:
                cm = mode
            ceil = float(room.get("ceil_h") or rules["ceil_h"])
            mh = rules["device_mount_h"]
            cur = b["_pos"]
            cur_h = float(b.get("mount_h") or rules["board_mount_h"])
            pts, total, ok = [b["_pos"]], 0.0, True
            for d in c["devices"]:
                dh = float(d.get("mount_h") if d.get("mount_h") is not None else mh.get(c["group"], 1.2))
                leg = router.leg(cur, (d["x"], d["y"]), cm, cur_h, dh, ceil)
                if leg is None:
                    ok = False
                    break
                total += leg["length"]
                pts += leg["points"][1:]
                cur, cur_h = (d["x"], d["y"]), dh
            c["mode"] = cm
            c["route"] = [list(p) for p in pts] if ok else None
            c["length_m"] = round(total * (1 + rules["slack_pct"] / 100), 2) if ok else None
            if not ok:
                check("fail", "no_route",
                      f"{room.get('name') or c['room_id']} {c['group']} circuit (way {c['way']}): "
                      f"no route in {cm} mode.",
                      room_id=c["room_id"], board_id=b["id"], way=c["way"],
                      fix={"label": "Use direct in ceiling for this circuit",
                           "mode_override": {f"{c['room_id']}:{c['group']}": "ceiling"}})
            circuits.append({
                "id": f"{b['id']}:{c['way']}", "board_id": b["id"], "way": c["way"],
                "group": c["group"], "room_id": c["room_id"], "device_ids": [d["id"] for d in c["devices"]],
                "va": round(c["va"], 1), "poles": c["poles"], "phase": c["phase"],
                "el_group": c["el_group"], "mode": cm, "length_m": c["length_m"],
                "route": c["route"], "status": "ok" if ok else "no_route"})

    placed = {i for c in circuits for i in c["device_ids"]}
    unplaced = [d["id"] for d in devices if d["id"] not in placed]
    for d in req.get("devices", []):
        if d.get("room_id") not in rooms:
            unplaced.append(d["id"])
            check("warn", "device_no_room", f"Device {d['id']} is in no room, so it was not circuited.",
                  device_id=d["id"])
    if not any(c["severity"] in ("fail", "warn") for c in checks):
        check("pass", "all_ok", "Every device is on a circuit within its limits.")
    return {
        "mode": mode,
        "assignments": [{"room_id": r, "board_id": b} for r, b in assignment.items()],
        "circuits": circuits,
        "boards": board_out,
        "unplaced_device_ids": unplaced,
        "totals": {"circuits": len(circuits),
                   "devices": len(placed),
                   "cable_m": round(sum(c["length_m"] or 0 for c in circuits), 1)},
        "checks": checks,
    }
