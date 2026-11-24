"""Proposed fixes for failing checks, and Fix all.

One registry behind the Issues list, the Results panel and Fix all. A fix is a
list of *changes* ({target, field, from, to}) with the check result before and
after, never an applied edit: the caller shows it, the user accepts it.

Rule that holds for every fix: a value the user typed by hand (a way whose cable
is ``cable_locked``, or any ladder item flagged ``manual``) is never part of the
automatic set. It is listed as *needs approval* and changes only when its issue
key is passed in ``approved_keys``.

Issue kinds
-----------
``db_way``   a distribution-board way that fails its circuit check: the smallest
             cable that passes (the circuit check's own sizing), proved by
             re-running the check on a copy of the project.
``ladder``   a value that has to reach a requirement and moves up a list of
             standard values: board incomer, transformer kVA, breaker breaking
             capacity, a feeder's next size. The caller supplies the ladder (the
             libraries live in the project) and the requirement.
"""

from .db_circuit_check import run_db_circuit_check, size_db_cables

CHECKS = ("coordination_status", "vd_status", "ecc_status", "zs_status", "ampacity_status")


def _way_of(project, board_id, way_id):
    for c in project.components:
        if c.id == board_id:
            for w in (c.props or {}).get("circuits") or []:
                if w.get("id") == way_id:
                    return c, w
    return None, None


def _rows(project):
    res = run_db_circuit_check(project)
    return {(r["board_id"], r["way_id"]): r for r in res["ways"]}


def _failing(row):
    return [k for k in CHECKS if row.get(k) == "fail"]


def _summary(row):
    return {"status": row.get("status"), "failing": _failing(row), "vd_pct": row.get("vd_pct"),
            "iz_a": row.get("iz_derated_a"), "cable_mm2": row.get("cable_mm2"),
            "zs_ohm": row.get("zs_ohm"), "zs_max_ohm": row.get("zs_max_ohm")}


def _apply_changes(project, changes):
    """Apply db_way changes to a project (a copy the caller made)."""
    for ch in changes:
        t = ch["target"]
        if t.get("kind") != "db_way":
            continue
        _, way = _way_of(project, t["board_id"], t["way_id"])
        if way is not None:
            way[ch["field"]] = ch["to"]


def _db_way_fixes(project, issues, before):
    out = []
    by_board = {}
    for iss in issues:
        by_board.setdefault(iss["board_id"], []).append(iss)
    for board_id, group in by_board.items():
        sized = size_db_cables(project, board_id, way_ids=[i["way_id"] for i in group])
        entries = {e["way_id"]: e for e in sized["ways"]}
        for iss in group:
            e = entries.get(iss["way_id"])
            _, way = _way_of(project, board_id, iss["way_id"])
            base = {"issue_key": iss["key"], "kind": "db_way", "board_id": board_id, "way_id": iss["way_id"]}
            if e is None or way is None:
                out.append({**base, "fix": None, "reason": "The way was not found."})
                continue
            cur = e.get("current_mm2")
            prop = e.get("proposed_mm2")
            if prop is None:
                need = e.get("needs_mm2")
                out.append({**base, "fix": None, "reason":
                            (f"No cable up to the size limit passes; it would need {need} mm²." if need
                             else "No cable size passes. Check the breaker, the run length or the supply.")})
                continue
            if cur is not None and prop <= cur + 1e-9:
                out.append({**base, "fix": None,
                            "reason": "The cable is not what fails; change the breaker, the load or the run."})
                continue
            changes = [{"target": {"kind": "db_way", "board_id": board_id, "way_id": iss["way_id"]},
                        "field": "cable_mm2", "from": cur, "to": prop,
                        "label": f"{way.get('description') or 'Way ' + str(way.get('way'))} cable"}]
            ecc = e.get("ecc_mm2")
            if ecc and (not way.get("ecc_mm2") or float(way.get("ecc_mm2")) < ecc):
                changes.append({"target": changes[0]["target"], "field": "ecc_mm2",
                                "from": way.get("ecc_mm2"), "to": ecc,
                                "label": "earth conductor"})
            trial = project.model_copy(deep=True)
            _apply_changes(trial, changes)
            after = _rows(trial).get((board_id, iss["way_id"]))
            row = before.get((board_id, iss["way_id"]))
            out.append({**base, "manual": bool(way.get("cable_locked")), "changes": changes,
                        "label": f"Cable {cur} → {prop} mm²", "governed_by": e.get("governed_by"),
                        "before": _summary(row) if row else None,
                        "after": _summary(after) if after else None,
                        "clears": bool(after) and not _failing(after), "fix": True})
    return out


def _ladder_fix(iss):
    base = {"issue_key": iss["key"], "kind": "ladder"}
    cur, req = iss.get("current"), iss.get("required")
    items = sorted(iss.get("ladder") or [], key=lambda i: i["value"])
    if req is None or not items:
        return {**base, "fix": None, "reason": "No standard values to choose from."}
    pick = next((i for i in items if i["value"] >= req - 1e-9 and (cur is None or i["value"] > cur + 1e-9)), None)
    if pick is None:
        return {**base, "fix": None, "reason": f"Nothing in the list reaches {req}; the next size is not available."}
    unit = iss.get("unit") or ""
    change = {"target": iss.get("target") or {}, "field": iss.get("field") or "value",
              "from": cur, "to": pick["value"], "to_id": pick.get("id"),
              "label": iss.get("label") or "value"}
    return {**base, "manual": bool(iss.get("manual")), "changes": [change],
            "label": f"{cur}{unit} → {pick['value']}{unit}",
            "before": {"value": cur, "required": req, "ok": cur is not None and cur >= req},
            "after": {"value": pick["value"], "required": req, "ok": True},
            "clears": True, "fix": True}


def propose_fixes(project, issues):
    """One proposal per issue; ``fix`` is None (with a ``reason``) when none exists."""
    before = _rows(project)
    db = [i for i in issues if i.get("kind") == "db_way"]
    out = {f["issue_key"]: f for f in _db_way_fixes(project, db, before)} if db else {}
    for iss in issues:
        if iss.get("kind") == "ladder":
            out[iss["key"]] = _ladder_fix(iss)
        elif iss.get("kind") != "db_way":
            out[iss["key"]] = {"issue_key": iss["key"], "kind": iss.get("kind"), "fix": None,
                               "reason": "No fix is available for this kind of issue."}
    return [out[i["key"]] for i in issues if i["key"] in out]


def _target_key(ch):
    t = ch["target"]
    return (t.get("kind") or t.get("id"), t.get("board_id") or t.get("id"), t.get("way_id"), ch["field"])


def fix_all(project, issues, approved_keys=()):
    """Every available fix, checked together on a copy of the project.

    Returns the automatic fixes (ticked), those that need approval (hand-entered
    values, unticked unless in ``approved_keys``), what could not be fixed, and
    the combined result. A fix is dropped when applying everything makes a way
    fail a check it passed before.
    """
    approved = set(approved_keys or ())
    fixes = propose_fixes(project, issues)
    usable = [f for f in fixes if f.get("fix")]
    skipped = [{"issue_key": f["issue_key"], "reason": f.get("reason", "")} for f in fixes if not f.get("fix")]

    # two fixes on one value: the larger one clears both
    best = {}
    for f in usable:
        for ch in f["changes"]:
            k = _target_key(ch)
            if k not in best or (ch["to"] or 0) > (best[k][1]["to"] or 0):
                best[k] = (f, ch)
    merged = []
    for f in usable:
        keep = [ch for ch in f["changes"] if best[_target_key(ch)][0] is f]
        if keep:
            merged.append({**f, "changes": keep})
        else:
            winner = next(best[_target_key(ch)][0] for ch in f["changes"])
            skipped.append({"issue_key": f["issue_key"],
                            "reason": f"Cleared by the larger change for {winner['issue_key']}."})
    ticked = [f for f in merged if not f.get("manual") or f["issue_key"] in approved]
    needs = [f for f in merged if f.get("manual") and f["issue_key"] not in approved]

    # check everything ticked together; drop any fix that breaks a way
    before = _rows(project)
    dropped = []
    for _ in range(len(ticked) + 1):
        trial = project.model_copy(deep=True)
        _apply_changes(trial, [ch for f in ticked for ch in f["changes"]])
        after = _rows(trial)
        worse = {k for k, r in after.items() if k in before
                 and set(_failing(r)) - set(_failing(before[k]))}
        bad = [f for f in ticked if f["kind"] == "db_way" and (f["board_id"], f["way_id"]) in worse]
        if not bad:
            break
        for f in bad:
            ticked.remove(f)
            dropped.append(f)
            skipped.append({"issue_key": f["issue_key"],
                            "reason": "Applied together with the others it makes a way fail another check."})
    cleared = 0
    for f in ticked:
        if f["kind"] == "db_way":
            r = after.get((f["board_id"], f["way_id"]))
            f["clears"] = bool(r) and not _failing(r)
        cleared += 1 if f.get("clears") else 0
    return {
        "automatic": ticked,
        "needs_approval": needs,
        "not_fixed": skipped,
        "summary": {"issues": len(issues), "cleared": cleared,
                    "automatic": sum(len(f["changes"]) for f in ticked),
                    "needs_approval": sum(len(f["changes"]) for f in needs),
                    "new_failures": len(worse)},
    }
