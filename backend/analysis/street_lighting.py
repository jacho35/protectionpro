"""Street lighting circuit calculation (Reticulation › Street lighting).

A street lighting circuit is a tree of poles fed from a kiosk or a minisub.
Each pole carries one luminaire. Two systems:

* ``3ph`` — 4-core cable, each pole tapped onto the next phase in turn
  (R → W → B → R …). A spur continues the rotation from its tee pole: its
  first pole takes the phase AFTER the tee pole's, exactly as the next pole on
  the main run would.
* ``1ph`` — 2-core cable, every pole on the same phase (``singlePhase``).

The solve is a phasor one, so the neutral current left by an uneven pole count,
a spur or a mixed lamp size is carried rather than assumed away:

    I_lamp   = P / (pf · U0) ∠ (θ_phase − φ)             constant current
    I_p,k    = Σ lamp currents on phase p in pole k's subtree (span into k)
    I_n,k    = Σ_p I_p,k                                   neutral return
    ΔU_p,k   = ΔU_p,parent + Z_k · (I_p,k + I_n,k)          Z_k = (R + jX)·L_k
    VD%      = (U0 − |U0∠θ_p − ΔU_p,k|) / U0 × 100          on the lamp's own phase

A 1Φ string therefore gives the familiar 2·Z·I per span (the neutral carries
the same current back), and a balanced 3Φ run has no neutral drop at all.

Two volt-drop checks:
* from the source (kiosk / minisub) — ``vdLimitPct`` (default 5 %)
* cumulative — ``supplyVdPct`` (the drop already present at the source, from
  the Demand feeder calc; 0 at a minisub's own LV board) + the circuit's own
  drop, against ``cumVdLimitPct`` (default 10 %).

Earth loop at each pole (TN, phase + neutral/PE of the same cable):

    Zs = Ze + 2·|R + jX|·L_from_source          (arithmetic, conservative)
    Ik1 = 0.95 · U0 / Zs  ≥  Ia                 (device disconnection current)

Span length: ``L = spacing × (1 + snaking %) + loop-in per pole``.

Resistances are the cable library's operating-temperature values, which is
conservative for Zs. Switching/control effects (driver inrush, HPS run-up
current, contactor ratings) are not modelled — see BACKLOG.
"""

import cmath
import math

U0 = 230.0
C_MIN = 0.95
PHASES = ("R", "W", "B")
_ANG = {"R": 0.0, "W": -2.0 * math.pi / 3.0, "B": 2.0 * math.pi / 3.0}
_NEXT = {"R": "W", "W": "B", "B": "R"}

DEFAULT_VD_LIMIT = 5.0
DEFAULT_CUM_VD_LIMIT = 10.0
MAX_SOLVER_POLES = 400


def _num(v, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def _r(x, d=3):
    return round(float(x), d)


def _phase_of(parent_phase, system, phase_start, single_phase, override):
    if override in PHASES:
        return override
    if system == "1ph":
        return single_phase
    if parent_phase is None:
        return phase_start
    return _NEXT[parent_phase]


def _order(poles):
    """Poles in parent-before-child order. A pole whose parent is missing (or
    that sits on a parent cycle) is fed from the source, and reported."""
    ids = {p["id"] for p in poles}
    children = {}
    roots = []
    orphaned = []
    for p in poles:
        par = p.get("parent")
        if par is None or par == "" or par not in ids or par == p["id"]:
            if par not in (None, "") and par != p["id"] and par not in ids:
                orphaned.append(p["id"])
            roots.append(p)
        else:
            children.setdefault(par, []).append(p)
    out, seen = [], set()
    stack = list(reversed(roots))
    while stack:
        p = stack.pop()
        if p["id"] in seen:
            continue
        seen.add(p["id"])
        out.append(p)
        stack.extend(reversed(children.get(p["id"], [])))
    # Anything unreached is on a cycle: feed it from the source.
    for p in poles:
        if p["id"] not in seen:
            orphaned.append(p["id"])
            seen.add(p["id"])
            p = dict(p, parent=None)
            out.append(p)
    return out, orphaned


def solve_circuit(c):
    """Solve one circuit. ``c`` uses the frontend's camelCase keys (see the
    module docstring and frontend/js/streetlight.js ``_payload``)."""
    system = "1ph" if c.get("system") == "1ph" else "3ph"
    phase_start = c.get("phaseStart") if c.get("phaseStart") in PHASES else "R"
    single_phase = c.get("singlePhase") if c.get("singlePhase") in PHASES else "R"
    cable = c.get("cable") or {}
    r_km = max(0.0, _num(cable.get("r")))
    x_km = max(0.0, _num(cable.get("x")))
    rated_a = _num(cable.get("ratedA"), 0.0)
    cores = int(_num(cable.get("cores"), 0))
    lum = c.get("luminaire") or {}
    def_w = max(0.0, _num(lum.get("watts"), 0.0))
    def_pf = min(1.0, max(0.05, _num(lum.get("pf"), 0.95)))
    def_span = max(0.0, _num(c.get("spacingM"), 0.0))
    snaking = _num(c.get("snakingPct"), 0.0)
    loop = max(0.0, _num(c.get("loopInM"), 0.0))
    ze = max(0.0, _num(c.get("zeOhm"), 0.0))
    supply_vd = max(0.0, _num(c.get("supplyVdPct"), 0.0))
    vd_limit = _num(c.get("vdLimitPct"), DEFAULT_VD_LIMIT) or DEFAULT_VD_LIMIT
    cum_limit = _num(c.get("cumVdLimitPct"), DEFAULT_CUM_VD_LIMIT) or DEFAULT_CUM_VD_LIMIT
    prot = c.get("protection") or {}
    ia = max(0.0, _num(prot.get("iaA"), 0.0))

    raw = []
    for i, p in enumerate(c.get("poles") or []):
        pid = str(p.get("id") or f"p{i}")
        raw.append({**p, "id": pid, "parent": (str(p["parent"]) if p.get("parent") not in (None, "") else None)})
    poles, orphaned = _order(raw)

    warnings = []
    if system == "3ph" and cores and cores < 4:
        warnings.append(f"A 3Φ circuit needs a 4-core cable; {cable.get('name') or 'this cable'} has {cores} cores.")
    no_cable = r_km <= 0
    if no_cable:
        warnings.append("Pick a cable — without its resistance there is no volt drop or Zs to check.")
    if orphaned:
        warnings.append(f"{len(orphaned)} pole(s) had a missing or looping 'fed from' pole and are fed from the source.")

    z_km = complex(r_km, x_km)
    by_id = {}
    for p in poles:
        par = by_id.get(p["parent"]) if p["parent"] else None
        phase = _phase_of(par["phase"] if par else None, system, phase_start, single_phase, p.get("phase"))
        w = _num(p.get("watts"), def_w) if p.get("watts") not in (None, "") else def_w
        pf = _num(p.get("pf"), def_pf) if p.get("pf") not in (None, "") else def_pf
        pf = min(1.0, max(0.05, pf))
        span_in = _num(p.get("spacingM"), def_span) if p.get("spacingM") not in (None, "") else def_span
        seg = max(0.0, span_in) * (1.0 + snaking / 100.0) + loop
        i_mag = w / (pf * U0) if w > 0 else 0.0
        i_lamp = cmath.rect(i_mag, _ANG[phase] - math.acos(pf))
        by_id[p["id"]] = {
            "src": p, "parent": p["parent"] if par else None, "phase": phase,
            "watts": w, "pf": pf, "seg": seg, "i_lamp": i_lamp,
            "sub": {f: 0j for f in PHASES},
        }
    # Subtree sums (children before parents).
    for p in reversed(poles):
        n = by_id[p["id"]]
        n["sub"][n["phase"]] += n["i_lamp"]
        if n["parent"]:
            ps = by_id[n["parent"]]["sub"]
            for f in PHASES:
                ps[f] += n["sub"][f]

    rows = []
    worst = None
    worst_zs = None
    over_rating = []
    total_len = 0.0
    for p in poles:
        n = by_id[p["id"]]
        par = by_id[n["parent"]] if n["parent"] else None
        z = z_km * n["seg"] / 1000.0
        i_n = sum(n["sub"].values())
        drop = {}
        for f in PHASES:
            base = par["drop"][f] if par else 0j
            drop[f] = base + z * (n["sub"][f] + i_n)
        n["drop"] = drop
        n["dist"] = (par["dist"] if par else 0.0) + n["seg"]
        total_len += n["seg"]
        u = cmath.rect(U0, _ANG[n["phase"]]) - drop[n["phase"]]
        vd = (U0 - abs(u)) / U0 * 100.0
        if abs(drop[n["phase"]]) >= U0:
            # Past the point where the phasor wraps round (|ΔU| ≥ U0 — a load
            # no real circuit carries): report it as a total collapse so the
            # checks, and the solver's bisection, stay monotonic.
            vd = max(vd, 100.0)
        zs = ze + 2.0 * abs(z_km) * n["dist"] / 1000.0
        ik = C_MIN * U0 / zs if zs > 0 else float("inf")
        i_span = max(abs(n["sub"][f]) for f in PHASES)
        vd_ok = vd <= vd_limit + 1e-9
        cum = supply_vd + vd
        cum_ok = cum <= cum_limit + 1e-9
        zs_ok = ia <= 0 or ik >= ia
        amp_ok = rated_a <= 0 or max(i_span, abs(i_n)) <= rated_a
        if not amp_ok:
            over_rating.append(p["id"])
        row = {
            "id": p["id"], "name": p.get("name") or "",
            "parent": n["parent"], "phase": n["phase"],
            "watts": _r(n["watts"], 1), "pf": _r(n["pf"], 3),
            "spanM": _r(n["seg"], 2), "distM": _r(n["dist"], 1),
            "iSpanA": _r(i_span, 3), "iNeutralA": _r(abs(i_n), 3),
            "vdPct": _r(vd, 3), "cumVdPct": _r(cum, 3),
            "zsOhm": _r(zs, 3), "ik1A": _r(ik, 1) if math.isfinite(ik) else None,
            "vdOk": vd_ok, "cumOk": cum_ok, "zsOk": zs_ok, "ampOk": amp_ok,
        }
        row["ok"] = vd_ok and cum_ok and zs_ok and amp_ok
        rows.append(row)
        if worst is None or vd > worst["vdPct"]:
            worst = row
        if worst_zs is None or zs > worst_zs["zsOhm"]:
            worst_zs = row

    # At the source: the root spans' currents summed.
    src = {f: 0j for f in PHASES}
    for n in by_id.values():
        if not n["parent"]:
            for f in PHASES:
                src[f] += n["sub"][f]
    counts = {f: 0 for f in PHASES}
    watts = {f: 0.0 for f in PHASES}
    kva = {f: 0.0 for f in PHASES}
    for n in by_id.values():
        counts[n["phase"]] += 1
        watts[n["phase"]] += n["watts"]
        kva[n["phase"]] += n["watts"] / n["pf"] / 1000.0 if n["pf"] else 0.0
    total_kva = sum(kva.values())

    vd_pass = all(r["vdOk"] for r in rows)
    cum_pass = all(r["cumOk"] for r in rows)
    zs_pass = all(r["zsOk"] for r in rows)
    amp_pass = not over_rating
    fails = []
    if not vd_pass:
        fails.append("vd")
    if not cum_pass:
        fails.append("cumVd")
    if not zs_pass:
        fails.append("zs")
    if not amp_pass:
        fails.append("rating")
    if no_cable:
        fails.append("cable")
    return {
        "id": c.get("id"), "name": c.get("name") or "",
        "system": system, "poleCount": len(rows),
        "poles": rows,
        "worstVdPct": _r(worst["vdPct"], 3) if worst else 0.0,
        "worstVdPole": worst["id"] if worst else None,
        "worstCumVdPct": _r(supply_vd + (worst["vdPct"] if worst else 0.0), 3),
        "maxZsOhm": _r(worst_zs["zsOhm"], 3) if worst_zs else _r(ze, 3),
        "maxZsPole": worst_zs["id"] if worst_zs else None,
        "minIk1A": worst_zs["ik1A"] if worst_zs else None,
        "zsMaxAllowedOhm": _r(C_MIN * U0 / ia, 3) if ia > 0 else None,
        "iaA": ia,
        "supplyVdPct": _r(supply_vd, 3),
        "vdLimitPct": vd_limit, "cumVdLimitPct": cum_limit,
        "phaseA": {f: _r(abs(src[f]), 3) for f in PHASES},
        "neutralA": _r(abs(sum(src.values())), 3),
        "phaseCount": counts,
        "phaseW": {f: _r(watts[f], 1) for f in PHASES},
        "phaseKVA": {f: _r(kva[f], 4) for f in PHASES},
        "totalW": _r(sum(watts.values()), 1),
        "totalKVA": _r(total_kva, 4),
        "cableLengthM": _r(total_len, 1),
        "vdPass": vd_pass, "cumVdPass": cum_pass, "zsPass": zs_pass, "ratingPass": amp_pass,
        "pass": not fails, "fails": fails,
        "warnings": warnings,
    }


def _uniform(c, n):
    """The circuit's defaults as a plain n-pole string (no overrides, no spurs)."""
    return dict(c, poles=[{"id": f"u{i}", "parent": (f"u{i - 1}" if i else None)} for i in range(n)])


def _passes(res):
    return res["pass"] and res["poleCount"] > 0


def max_uniform_poles(c, cap=MAX_SOLVER_POLES):
    """Largest n for which the circuit's default build-up (spacing, luminaire,
    cable, protection) passes every check as a single string. Every check
    worsens monotonically with n, so this is a bisection. Returns
    ``{maxPoles, maxLengthM, limitedBy}``; limitedBy names the check that fails
    at maxPoles + 1 (or None when even ``cap`` poles pass)."""
    if _num((c.get("cable") or {}).get("r")) <= 0:
        return {"maxPoles": 0, "maxLengthM": 0.0, "limitedBy": "cable"}
    if not _passes(solve_circuit(_uniform(c, 1))):
        first = solve_circuit(_uniform(c, 1))
        return {"maxPoles": 0, "maxLengthM": 0.0, "limitedBy": (first["fails"] or [None])[0]}
    top = solve_circuit(_uniform(c, cap))
    if _passes(top):
        return {"maxPoles": cap, "maxLengthM": top["cableLengthM"], "limitedBy": None, "capped": True}
    lo, hi = 1, cap          # lo passes, hi fails
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if _passes(solve_circuit(_uniform(c, mid))):
            lo = mid
        else:
            hi = mid
    ok = solve_circuit(_uniform(c, lo))
    bad = solve_circuit(_uniform(c, hi))
    return {"maxPoles": lo, "maxLengthM": ok["cableLengthM"], "limitedBy": (bad["fails"] or [None])[0]}


def smallest_cable(c, candidates):
    """The first candidate cable (smallest first, i.e. highest resistance) for
    which the circuit as drawn passes every check. None when none does."""
    system = "1ph" if c.get("system") == "1ph" else "3ph"
    usable = [k for k in candidates or []
              if _num(k.get("r")) > 0 and (system == "1ph" or int(_num(k.get("cores"), 4)) >= 4)]
    usable.sort(key=lambda k: -_num(k.get("r")))
    for k in usable:
        if _passes(solve_circuit(dict(c, cable=k))):
            return k.get("name")
    return None


def run_street_lighting(request):
    """Entry point for POST /api/analysis/street-lighting.

    ``request``: ``{circuits: [...], candidateCables: [{name, r, x, ratedA, cores}]}``.
    Returns ``{circuits: [result + solver]}``; results are on demand (not
    persisted with the project).
    """
    candidates = request.get("candidateCables") or []
    out = []
    for c in request.get("circuits") or []:
        res = solve_circuit(c)
        res["solver"] = max_uniform_poles(c)
        res["smallestCable"] = smallest_cable(c, candidates) if candidates else None
        out.append(res)
    return {"circuits": out}
