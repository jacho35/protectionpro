"""LV design for the reticulation Auto layout (``POST /api/analysis/retic-lv-design``).

What the Auto layout needs to call a proposal a *design* and not a sketch:

1. **Erf ways.** Every outgoing way to an erf is a small breaker (80 A MCCB by default). The frontend
   sends each erf with the device it resolved; this module does not change them.
2. **String breakers.** For each string head the breakers from the string current up to
   ``high × I + add`` (2.2 × I + 20 A by default) are tried; the one with the fewest earth-fault fails
   wins (the smallest rating among equals). The string current is Demand's own diversified figure: a
   string with no current is reported, never guessed.
3. **Cable ladder.** Every feeder starts on the largest size. The smallest *uniform* size that is not worse
   than that is found, then the cable is **tapered**: from the deepest kiosk to the mini-sub each feeder is
   tried one size smaller and kept only if nothing gets worse (below).
4. **Not worse** means, against the same design on the largest cable throughout:

   * every earth-fault check (the loop and the earth conductor, at every kiosk and every erf) that passed
     still passes;
   * every check that already failed is no *slower* (clearing time) and its loop impedance Zs is no higher;
   * the cumulative LV volt drop to every kiosk stays within the limit (or, where it was already over, no
     higher);
   * the cable still carries the feeder's current (rating).

   A taper that merely kept the *count* of fails would be accepted by a count test while a failing feeder got
   slower; this one is not.
5. **Size limits.** ``options.minSizeMm2`` / ``maxSizeMm2`` (0 or absent = none) keep every feeder on a cable in that range
   (a cable pinned by hand is exempt). When the range is why the design cannot pass, the module says so and what to
   allow (``limits.maxNeededMm2``); when a minimum only makes the design dearer it says by how much; a minimum above the
   maximum, or no cable in the range, is reported. A cable too small for its feeder's current, or a cumulative volt drop over
   the limit, now counts as a failed check like an earth-fault fail (it used to be reported only by the frontend).
6. **When it cannot pass** the module says why. A string whose far kiosks fail on the largest cable cannot
   be fixed by a bigger cable: the breaker at its head is too big for the fault current at the end. It then
   says which string, the breaker, the kiosks and the clearing times, and proposes the two real fixes: add a
   mini-sub, or split the string at the kiosk where the split helps most (found by trying each).

Every trial is the engine's own ``run_retic_earth_check`` (``retic_earth.py``) on just the path from the
mini-sub to one kiosk, cached on the cables of that path and the head breaker, so a trial re-checks only the
feeders it touches.

The checks that need no engine are the ones the frontend already makes with Retic's own functions
(``_vdPercent`` at pf 0.95 on 400 V, rating = the cable's rated amps); the formulas are mirrored here.
"""

from __future__ import annotations

import math

from .retic_earth import run_retic_earth_check

PF = 0.95
SINPHI = math.sqrt(1 - PF * PF)
EPS = 1e-9


def _num(v, d=0.0):
    try:
        x = float(v)
        return x if math.isfinite(x) else d
    except (TypeError, ValueError):
        return d


def _size(c):
    return _num((c or {}).get("size_mm2"))


def _empty(note=""):
    """The shape of an answer with no design in it (no kiosks, no cable in the range, a contradictory range)."""
    return {"ok": False, "passes": False, "note": note, "fails": [], "failCount": 0, "refFails": 0, "violations": [], "violationCount": 0,
            "feeders": [], "heads": [], "reasons": [], "uniform": {"cable": "", "sizeMm2": 0, "totalMm2M": 0},
            "taper": {"on": False, "totalMm2M": 0, "savedPct": 0, "sizes": [], "minMm2": 0, "maxMm2": 0, "count": 0},
            "conductor": "", "trials": 0, "engineCalls": 0}


class _Design:
    def __init__(self, req):
        self.req = req
        s = req.get("settings") or {}
        self.u0 = _num(s.get("u0"), 230.0)
        self.t_allow = _num(s.get("disconnectTimeS"), 5.0)
        self.vd_limit = _num(s.get("maxFeederVD"), 7.0)
        self.minisubs = list(req.get("minisubs") or [])
        self.ms_ids = {m.get("id") for m in self.minisubs}
        self.kiosks = {}
        for k in req.get("kiosks") or []:
            self.kiosks[k["id"]] = {
                "id": k["id"], "name": k.get("name", k["id"]), "fedFrom": k.get("fedFrom") or "source",
                "len": _num(k.get("lengthM")), "amps": _num(k.get("amps")), "erfs": list(k.get("erfs") or []),
            }
        ed = (req.get("options") or {}).get("erfDevice")
        if ed:                                                       # the way to every erf: this device unless the erf has its own
            for k in self.kiosks.values():
                k["erfs"] = [e if e.get("device") else {**e, "device": ed, "deviceSource": "kiosk"} for e in k["erfs"]]
        self.order = list(self.kiosks)
        o0 = req.get("options") or {}
        self.min_size, self.max_size = _num(o0.get("minSizeMm2")), _num(o0.get("maxSizeMm2"))
        self.ladder_all = sorted(req.get("ladder") or [], key=_size)
        self.ladder = [c for c in self.ladder_all if (not self.min_size or _size(c) >= self.min_size - EPS) and (not self.max_size or _size(c) <= self.max_size + EPS)]
        self.breakers = sorted(req.get("breakers") or [], key=lambda b: _num(b.get("rating")))
        o = req.get("options") or {}
        self.taper = o.get("taper", True) is not False
        self.pinned_cable = dict(o.get("pinnedCables") or {})
        self.pinned_breaker = dict(o.get("pinnedBreakers") or {})
        r = o.get("headRange") or {}
        self.hi_mul, self.hi_add = _num(r.get("high"), 2.2), _num(r.get("add"), 20.0)
        # tree
        self.parent = {kid: (k["fedFrom"] if k["fedFrom"] in self.kiosks else None) for kid, k in self.kiosks.items()}
        self.children = {kid: [] for kid in self.kiosks}
        for kid, p in self.parent.items():
            if p:
                self.children[p].append(kid)
        self._chain_cache, self._depth = {}, {}
        for kid in self.kiosks:
            self._depth[kid] = len(self.chain(kid))
        self.heads = [kid for kid in self.kiosks if not self.parent[kid]]
        self.head_of = {kid: self.chain(kid)[0] for kid in self.kiosks}
        # state
        self.idx = {}                     # ladder index per kiosk
        self.dev = {}                     # head breaker (device dict) per head
        self._items_cache = {}
        self.trials = 0
        self.engine_calls = 0

    # ── tree helpers ──
    def chain(self, kid):
        if kid not in self._chain_cache:
            out, seen, cur = [], set(), kid
            while cur and cur in self.kiosks and cur not in seen:
                seen.add(cur)
                out.append(cur)
                cur = self.parent[cur]
            self._chain_cache[kid] = out[::-1]
        return self._chain_cache[kid]

    def subtree(self, kid):
        out, stack = [], [kid]
        while stack:
            x = stack.pop()
            out.append(x)
            stack.extend(self.children[x])
        return out

    def string(self, head):
        return self.subtree(head)

    # ── the state's cables ──
    def cable(self, kid):
        p = self.pinned_cable.get(kid)
        if p:
            return p
        return self.ladder[self.idx[kid]]

    def frozen(self, kid):
        return kid in self.pinned_cable

    # ── checks that need no engine ──
    def leg_vd(self, kid):
        k, c = self.kiosks[kid], self.cable(kid)
        if not k["len"] or not k["amps"]:
            return 0.0
        z = _num(c.get("r_per_km")) * PF + _num(c.get("x_per_km")) * SINPHI
        return math.sqrt(3) * k["amps"] * (k["len"] / 1000.0) * z / 400.0 * 100.0

    def cum_vd(self, kid):
        return sum(self.leg_vd(c) for c in self.chain(kid))

    def rating_ok(self, kid):
        r = _num(self.cable(kid).get("rated_amps", self.cable(kid).get("rating_a")))
        return not r or self.kiosks[kid]["amps"] <= r + EPS

    def violations(self):
        """Checks that need no engine and fail at the final state: a cable below its feeder's current, a volt drop over the limit."""
        out = []
        for k in self.order:
            c, kk = self.cable(k), self.kiosks[k]
            r = _num(c.get("rated_amps", c.get("rating_a")))
            if r and kk["amps"] > r + EPS:
                out.append({"kioskId": k, "kind": "rating", "value": round(kk["amps"], 1), "limit": r, "cable": c.get("name")})
            v = self.cum_vd(k)
            if v > self.vd_limit + EPS:
                out.append({"kioskId": k, "kind": "vd", "value": round(v, 2), "limit": self.vd_limit, "cable": c.get("name")})
        return out

    # ── the engine, one kiosk's path at a time ──
    def _dev_key(self, d):
        return (d or {}).get("id") or (d or {}).get("name") or ""

    def kiosk_items(self, kid):
        """{(erf or None, 'loop'|'ecc'): {...}} for one kiosk: the earth engine on the path to it."""
        chain = self.chain(kid)
        head = chain[0]
        key = (kid, tuple((self.cable(c).get("name"), self.kiosks[c]["len"]) for c in chain), self._dev_key(self.dev.get(head)))
        hit = self._items_cache.get(key)
        if hit is not None:
            return hit
        kiosks = []
        for c in chain:
            kk = self.kiosks[c]
            kiosks.append({"id": c, "name": kk["name"], "fedFrom": kk["fedFrom"],
                           "device": self.dev.get(head) if c == head else None,
                           "feeder": {"cable": self.cable(c), "earth": None, "lengthM": kk["len"]},
                           "erfs": kk["erfs"] if c == kid else []})
        res = run_retic_earth_check({"settings": {"u0": self.u0, "disconnectTimeS": self.t_allow},
                                     "minisubs": self.minisubs, "kiosks": kiosks})
        self.engine_calls += 1
        mine = next(r for r in res["kiosks"] if r["kioskId"] == kid)
        out = {}

        def put(erf, what, d):
            if d:
                out[(erf, what)] = {"status": d.get("status"), "t": d.get("tS") if what == "loop" else None,
                                    "zs": d.get("zsOhm"), "zsMax": d.get("zsMaxOhm"), "note": d.get("note", "")}
        put(None, "loop", mine.get("loop"))
        put(None, "ecc", mine.get("ecc"))
        for e in mine.get("erfs") or []:
            put(e["erfId"], "loop", e.get("loop"))
            put(e["erfId"], "ecc", e.get("ecc"))
        self._items_cache[key] = out
        return out

    def items(self, kids=None):
        out = {}
        for kid in (kids if kids is not None else self.order):
            for (erf, what), v in self.kiosk_items(kid).items():
                out[(kid, erf, what)] = v
        return out

    @staticmethod
    def fails(items):
        return sum(1 for v in items.values() if v["status"] == "fail")

    @staticmethod
    def not_worse(ref, new):
        """Nothing that passed fails; nothing that failed gets slower or gets a higher loop impedance."""
        for key, r in ref.items():
            n = new.get(key)
            if n is None:
                continue
            if r["status"] != "fail":
                if n["status"] == "fail":
                    return False
                continue
            if n["status"] != "fail":
                continue                                   # a failing check that now passes is better
            rt = math.inf if r["t"] is None else r["t"]
            nt = math.inf if n["t"] is None else n["t"]
            if nt > rt + 1e-6 or _num(n["zs"]) > _num(r["zs"]) + 1e-6:
                return False
        return True

    # ── head breakers ──
    def candidates(self, head):
        amps = self.kiosks[head]["amps"]
        if head in self.pinned_breaker:
            return [self.pinned_breaker[head]]
        lo, hi = amps, amps * self.hi_mul + self.hi_add
        c = [b for b in self.breakers if lo - EPS <= _num(b.get("rating")) <= hi + EPS]
        if not c:                                   # the string is above the library: the largest there is
            above = [b for b in self.breakers if _num(b.get("rating")) >= amps - EPS]
            c = above[:1] or self.breakers[-1:]
        return c

    def _score(self, head):
        its = self.items(self.string(head))
        bad = [v for v in its.values() if v["status"] == "fail"]
        t = sum(1e6 if v["t"] is None else v["t"] for v in bad)
        return (len(bad), t)

    def choose_heads(self, heads=None):
        for h in (heads if heads is not None else self.heads):
            if self.kiosks[h]["amps"] <= 0 and h not in self.pinned_breaker:
                self.dev[h] = None               # no current from Demand: never a guess
                continue
            best = None
            for b in self.candidates(h):
                self.dev[h] = b
                sc = self._score(h) + (_num(b.get("rating")),)
                if best is None or sc < best[0]:
                    best = (sc, b)
            self.dev[h] = best[1] if best else None

    # ── the state's totals ──
    def cable_total(self):
        return sum(_size(self.cable(k)) * self.kiosks[k]["len"] for k in self.order)

    def vd_ok(self, kids, ref_vd):
        for k in kids:
            v = self.cum_vd(k)
            if v > self.vd_limit + EPS and v > ref_vd.get(k, 0.0) + EPS:
                return False
        return True

    def acceptable(self, ref_items, ref_vd, ref_rate, kids):
        for k in kids:
            if not self.rating_ok(k) and ref_rate.get(k, True):
                return False
        if not self.vd_ok(kids, ref_vd):
            return False
        return self.not_worse({k: v for k, v in ref_items.items() if k[0] in set(kids)}, self.items(kids))

    # ── the search ──
    def run(self):
        if not self.kiosks:
            return self._result(note="no kiosks")
        if not self.ladder:
            return self._result(note="no cable ladder")
        top = len(self.ladder) - 1
        for k in self.order:
            self.idx[k] = top
        self.choose_heads()                                      # on the best cable: what the breakers can do
        ref_items = self.items()
        ref_vd = {k: self.cum_vd(k) for k in self.order}
        ref_rate = {k: self.rating_ok(k) for k in self.order}
        ref_fails = self.fails(ref_items)

        # the smallest uniform size that is not worse than the largest
        uniform = top
        for u in range(top + 1):
            for k in self.order:
                self.idx[k] = u
            self.trials += 1
            if self.acceptable(ref_items, ref_vd, ref_rate, self.order):
                uniform = u
                break
        for k in self.order:
            self.idx[k] = uniform
        uniform_idx = uniform
        uniform_total = self.cable_total()
        self.uniform_cable = self.ladder[uniform_idx]
        self.uniform_idx = uniform_idx

        if self.taper and len(self.kiosks) > 1:
            # Two ways in: down from the uniform size, and down from the largest (large near the mini-sub, small far out, which
            # is where a taper saves most). The one with less cable is the design.
            tries = []
            for start in (uniform_idx, top):
                for k in self.order:
                    self.idx[k] = start
                self._taper(ref_items, ref_vd, ref_rate)
                tries.append((self.cable_total(), start != uniform_idx, dict(self.idx)))
            tries.sort(key=lambda t: (round(t[0], 6), t[1]))
            self.idx = dict(tries[0][2])
        # the breakers again on the final cable; a change is kept only if it is not worse
        before = {h: self.dev.get(h) for h in self.heads}
        before_items = self.items()
        self.choose_heads()
        if before != {h: self.dev.get(h) for h in self.heads} and not self.not_worse(before_items, self.items()):
            self.dev.update(before)
        return self._result(ref_items=ref_items, ref_fails=ref_fails, uniform_idx=uniform_idx, uniform_total=uniform_total)

    def _taper(self, ref_items, ref_vd, ref_rate):
        """Deepest kiosk first, one size smaller at a time, kept only if nothing downstream gets worse."""
        order = sorted(self.order, key=lambda k: (-self._depth[k], self.order.index(k)))
        for _pass in range(2):
            changed = False
            for k in order:
                if self.frozen(k) or self.kiosks[k]["len"] < 1.0 or self.kiosks[k]["amps"] <= 0:
                    continue
                while self.idx[k] > 0:
                    floor = max([self.idx[c] for c in self.children[k] if not self.frozen(c)] or [0])
                    if self.idx[k] - 1 < floor:                # never bigger further out than nearer the mini-sub
                        break
                    self.idx[k] -= 1
                    self.trials += 1
                    sub = self.subtree(k)
                    if self.acceptable(ref_items, ref_vd, ref_rate, sub):
                        changed = True
                        continue
                    self.idx[k] += 1
                    break
            if not changed:
                break

    # ── what to say ──
    def _fail_rows(self, items):
        rows = []
        for (kid, erf, what), v in items.items():
            if v["status"] == "fail":
                rows.append({"kioskId": kid, "erfId": erf, "check": what, "tS": v["t"], "zsOhm": v["zs"], "zsMaxOhm": v["zsMax"], "note": v["note"]})
        return rows

    def _split_candidates(self, head):
        """Where splitting the string helps: each kiosk tried as a new head, its own breaker straight off the mini-sub
        (a separate feeder along the same route, on the largest cable), the head breakers chosen again."""
        string = self.string(head)
        base = self.fails(self.items(string))
        top = len(self.ladder) - 1
        saved = {"parent": dict(self.parent), "dev": dict(self.dev), "len": {k: v["len"] for k, v in self.kiosks.items()},
                 "idx": dict(self.idx), "heads": list(self.heads), "head_of": dict(self.head_of), "amps": self.kiosks[head]["amps"]}
        best = None
        for x in string:
            if x == head:
                continue
            path_len = sum(self.kiosks[c]["len"] for c in self.chain(x))
            amps_x = self.kiosks[x]["amps"]
            self.parent[x] = None
            self.kiosks[x]["len"] = path_len
            self.kiosks[head]["amps"] = saved["amps"] - amps_x
            if x not in self.pinned_cable:
                self.idx[x] = top
            self._chain_cache = {}
            self.heads = [k for k in self.kiosks if not self.parent[k]]
            for kid in self.kiosks:
                self.head_of[kid] = self.chain(kid)[0]
            self.choose_heads([head, x])
            f = self.fails(self.items([k for k in string if self.head_of[k] in (head, x)]))
            sc = (f, max(self.kiosks[head]["amps"], amps_x))
            if best is None or sc < best[0]:
                best = (sc, x, f)
            self.parent, self.dev, self.idx, self.heads, self.head_of = (dict(saved["parent"]), dict(saved["dev"]), dict(saved["idx"]), list(saved["heads"]), dict(saved["head_of"]))
            for k, v in saved["len"].items():
                self.kiosks[k]["len"] = v
            self.kiosks[head]["amps"] = saved["amps"]
            self._chain_cache = {}
        if best and best[2] < base:
            return {"kiosk": best[1], "fails": best[2], "was": base}
        return None

    def _reasons(self, items):
        fails = self._fail_rows(items)
        if not fails:
            return []
        by_head = {}
        for f in fails:
            by_head.setdefault(self.head_of[f["kioskId"]], []).append(f)
        out = []
        for head, rows in by_head.items():
            kids = []
            for r in rows:
                if r["kioskId"] not in kids:
                    kids.append(r["kioskId"])
            ts = [r["tS"] for r in rows if r["check"] == "loop"]
            never = any(t is None for t in ts)
            finite = [t for t in ts if t is not None]
            amps = self.kiosks[head]["amps"]
            dev = self.dev.get(head) or {}
            name = dev.get("name") or "no breaker"
            names = lambda ids: ", ".join(self.kiosks[i]["name"] for i in ids)
            if finite:
                when = (f"{min(finite):.1f} to {max(finite):.1f} s" if len(finite) > 1 and abs(max(finite) - min(finite)) > 0.05 else f"{finite[0]:.1f} s")
                if never:
                    when += " or never"
            else:
                when = "never"
            capped = bool(self.ladder and self.ladder_all and _size(self.ladder[-1]) < _size(self.ladder_all[-1]) - EPS)
            why = (f"on the largest cable allowed ({_size(self.ladder[-1]):g} mm²)" if capped else "")
            text = (f"String {self.kiosks[head]['name']} carries {amps:.0f} A and needs a {name}. "
                    f"{names(kids)} clear{'s' if len(kids) == 1 else ''} in {when} against {self.t_allow:g} s"
                    + (f" {why}. " if capped else ": the cable is already the largest that suits, so a bigger one does not fix it. ")
                    + "Add a mini-sub or split the string.")
            fixes = [{"action": "addSub", "text": "Add a mini-sub"}]
            sp = self._split_candidates(head)
            if sp:
                fixes.append({"action": "split", "kiosk": sp["kiosk"], "text": f"Split the string at {self.kiosks[sp['kiosk']]['name']}",
                              "failsAfter": sp["fails"], "failsBefore": sp["was"]})
                text = text.replace("Add a mini-sub or split the string.", f"Add a mini-sub, or split the string at {self.kiosks[sp['kiosk']]['name']}.")
            out.append({"head": head, "headName": self.kiosks[head]["name"], "amps": amps, "breaker": name, "kiosks": kids,
                        "tMin": min(finite) if finite else None, "tMax": max(finite) if finite else None, "never": never, "text": text, "fixes": fixes})
        return out

    def _violation_reasons(self, viol):
        out = []
        for kind, title in (("rating", "carries more than its cable is rated for"), ("vd", "is over the volt-drop limit")):
            rows = [v for v in viol if v["kind"] == kind]
            if not rows:
                continue
            ids = [v["kioskId"] for v in rows]
            names = ", ".join(self.kiosks[i]["name"] for i in ids)
            if kind == "rating":
                v0 = max(rows, key=lambda v: v["value"] / (v["limit"] or 1))
                text = (f"{names}: {'feeder' if len(ids) == 1 else 'feeders'} carry{'ies' if len(ids) == 1 else ''} more than the cable is rated for "
                        f"({self.kiosks[v0['kioskId']]['name']} {v0['value']:g} A on {v0['cable']}, rated {v0['limit']:g} A).")
            else:
                v0 = max(rows, key=lambda v: v["value"])
                text = (f"The LV volt drop to {names} is over the {self.vd_limit:g} % limit "
                        f"({self.kiosks[v0['kioskId']]['name']} {v0['value']:g} %).")
            out.append({"head": None, "headName": "", "amps": 0, "breaker": "", "kiosks": ids, "tMin": None, "tMax": None, "never": False,
                        "kind": kind, "text": text, "fixes": [{"action": "addSub", "text": "Add a mini-sub"}]})
        return out

    def _result(self, note="", ref_items=None, ref_fails=0, uniform_idx=0, uniform_total=0.0):
        if note:
            return _empty(note)
        items = self.items()
        fails = self._fail_rows(items)
        viol = self.violations()
        feeders = []
        for k in self.order:
            kk, c = self.kiosks[k], self.cable(k)
            feeders.append({"kioskId": k, "name": kk["name"], "fedFrom": kk["fedFrom"], "cable": c.get("name"), "sizeMm2": _size(c),
                            "lengthM": kk["len"], "amps": kk["amps"], "ratingA": _num(c.get("rated_amps", c.get("rating_a"))),
                            "vdPct": round(self.leg_vd(k), 3), "vdCumPct": round(self.cum_vd(k), 3),
                            "head": k in self.heads, "pinned": self.frozen(k),
                            "setBy": "you" if self.frozen(k) else ("uniform" if self.idx[k] == uniform_idx else "taper")})
        heads = [{"kioskId": h, "name": self.kiosks[h]["name"], "amps": self.kiosks[h]["amps"],
                  "device": self.dev.get(h), "breaker": (self.dev.get(h) or {}).get("name"), "pinned": h in self.pinned_breaker,
                  "noCurrent": self.kiosks[h]["amps"] <= 0, "kiosks": [self.kiosks[x]["name"] for x in self.string(h)]} for h in self.heads]
        sizes = sorted({_size(f) for f in [self.cable(k) for k in self.order]})
        taper_total = self.cable_total()
        saved = (1 - taper_total / uniform_total) * 100 if uniform_total else 0.0
        reasons = self._reasons(items) + self._violation_reasons(viol)
        return {"ok": not fails and not viol, "passes": not fails and not viol, "fails": fails, "failCount": len(fails), "refFails": ref_fails,
                "violations": viol, "violationCount": len(viol),
                "feeders": feeders, "heads": heads, "reasons": reasons,
                "uniform": {"cable": self.uniform_cable.get("name"), "sizeMm2": _size(self.uniform_cable), "totalMm2M": round(uniform_total, 1)},
                "taper": {"on": self.taper and len(self.kiosks) > 1, "totalMm2M": round(taper_total, 1), "savedPct": round(saved, 1),
                          "sizes": sizes, "minMm2": sizes[0] if sizes else 0, "maxMm2": sizes[-1] if sizes else 0, "count": len(sizes)},
                "conductor": (self.ladder[0].get("conductor") if self.ladder else ""),
                "trials": self.trials, "engineCalls": self.engine_calls}


def _with_options(req, **kw):
    out = dict(req)
    o = dict(req.get("options") or {})
    for k, v in kw.items():
        if v is None:
            o.pop(k, None)
        else:
            o[k] = v
    out["options"] = o
    return out


def run_retic_lv_design(req: dict) -> dict:
    """The design, and (when a minimum or maximum cable size is set) whether those sizes are what stops it."""
    res = _Design(req).run()
    o = req.get("options") or {}
    mn, mx = _num(o.get("minSizeMm2")), _num(o.get("maxSizeMm2"))
    sizes = sorted({_size(c) for c in req.get("ladder") or []})
    inrange = [x for x in sizes if (not mn or x >= mn - EPS) and (not mx or x <= mx + EPS)]
    lim = {"minMm2": mn or None, "maxMm2": mx or None, "sizes": inrange, "allSizes": sizes, "maxNeededMm2": None, "minAddsPct": None}
    res["limits"] = lim
    if not (mn or mx):
        return res
    reasons = res.setdefault("reasons", [])
    if mn and mx and mn > mx + EPS:
        res = _empty("range")
        res["limits"] = lim
        res["reasons"].append({"head": None, "headName": "", "amps": 0, "breaker": "", "kiosks": [], "tMin": None, "tMax": None, "never": False, "kind": "range",
                               "text": f"The smallest LV cable allowed ({mn:g} mm²) is larger than the largest ({mx:g} mm²): no size fits.",
                               "fixes": [{"action": "clearSize", "text": "Remove the size limits"}]})
        return res
    if not inrange:
        res = _empty("range")
        res["limits"] = lim
        res["reasons"].append({"head": None, "headName": "", "amps": 0, "breaker": "", "kiosks": [], "tMin": None, "tMax": None, "never": False, "kind": "range",
                               "text": f"The cable library has no LV cable between {mn or sizes[0]:g} and {mx or sizes[-1]:g} mm²: no size fits.",
                               "fixes": [{"action": "clearSize", "text": "Remove the size limits"}]})
        return res
    free = _Design(_with_options(req, minSizeMm2=None, maxSizeMm2=None)).run()
    lim["freeTotalMm2M"] = free["taper"]["totalMm2M"]
    lim["freeOk"] = bool(free.get("ok"))
    if res.get("ok"):
        if mn and free["taper"]["totalMm2M"] > 0:
            lim["minAddsPct"] = round((res["taper"]["totalMm2M"] / free["taper"]["totalMm2M"] - 1) * 100, 1)
        return res
    # it fails inside the range: would it pass without the range? and with how large a maximum?
    if not free.get("ok"):
        lim["freeFails"] = free.get("failCount", 0) + free.get("violationCount", 0)
        mine = res.get("failCount", 0) + res.get("violationCount", 0)
        if mx and mine > lim["freeFails"]:                   # not only a size problem, but the limit makes it worse
            reasons.insert(0, {"head": None, "headName": "", "amps": 0, "breaker": "", "kiosks": [], "tMin": None, "tMax": None, "never": False, "kind": "maxSizeWorse",
                               "text": f"The largest LV cable allowed ({mx:g} mm²) makes it worse: {mine} checks fail with it, {lim['freeFails']} without it. It does not pass either way: see the string below.",
                               "fixes": [{"action": "clearSize", "text": "Remove the size limits"}]})
        return res                                           # the string / breaker, said below
    need = None
    for cap in [x for x in sizes if (not mx or x > mx + EPS)]:
        t = _Design(_with_options(req, maxSizeMm2=cap)).run()
        if t.get("ok"):
            need = cap
            break
    lim["maxNeededMm2"] = need
    if need is not None:
        text = (f"The largest LV cable allowed ({mx:g} mm²) is too small: the design passes with up to {need:g} mm² allowed "
                f"({free['taper']['maxMm2']:g} mm² is the largest it then uses).")
        fixes = [{"action": "maxSize", "size": need, "text": f"Allow up to {need:g} mm²"}, {"action": "addSub", "text": "Add a mini-sub"}]
    else:
        text = (f"The sizes allowed ({mn or sizes[0]:g} to {mx or sizes[-1]:g} mm²) are why this fails: without them it passes. "
                f"Widen the range.")
        fixes = [{"action": "clearSize", "text": "Remove the size limits"}, {"action": "addSub", "text": "Add a mini-sub"}]
    bad = [f["name"] for f in res["feeders"] if mx and _size({"size_mm2": f["sizeMm2"]}) >= mx - EPS]
    if bad:
        text += f" Feeders on the largest size: {', '.join(bad[:8])}{'…' if len(bad) > 8 else ''}."
    reasons.insert(0, {"head": None, "headName": "", "amps": 0, "breaker": "", "kiosks": [], "tMin": None, "tMax": None, "never": False,
                       "kind": "maxSize", "text": text, "fixes": fixes})
    return res
