"""Shared helpers for the 2026-10 cold-eyes review of backend/analysis/fault.py.

Write-up: reviews/FAULT_ENGINE_COLD_REVIEW.md (local, gitignored).
Run any script from the repo root, e.g.
    python testing/fault-cold-review/findings.py
"""
import contextlib
import io
import math
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (ROOT, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from backend.models.schemas import Component, ProjectData, Wire  # noqa: E402
from backend.analysis import fault as F  # noqa: E402
import ref60909 as R  # noqa: E402

SQ3 = math.sqrt(3.0)
_n = [0]


def C(cid, t, **p):
    return Component(id=cid, type=t, x=0, y=0, props=p)


def W(a, b, fp="out", tp="in"):
    _n[0] += 1
    return Wire(id=f"w{_n[0]}", fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


def P(comps, wires, base=100.0, f=50):
    return ProjectData(projectName="t", baseMVA=base, frequency=f, components=comps, wires=wires)


def par(*zs):
    return 1 / sum(1 / z for z in zs)


def cmp(label, expected, engine, tol=0.5):
    """Print one comparison; return the relative error in % (inf for 0 vs non-zero)."""
    if expected:
        err = (engine - expected) / expected * 100
    else:
        err = 0.0 if abs(engine) < 1e-9 else float("inf")
    flag = "ok " if abs(err) <= tol else "XX "
    print(f"  {flag}{label:58s} expected {expected:11.5f}  engine {engine:11.5f}  err {err:+8.2f}%")
    return err


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def compare(proj, c=1.1, label="", tol=0.1, opts=None, kinds=("ik3", "ik1", "ikLL", "ikLLG"),
            show_all=False, engine_kwargs=None):
    """Engine vs the independent reference at every drawn bus. The engine
    rounds kA to 3 decimals, so differences within 0.0006 kA are ignored."""
    eng = quiet(F.run_fault_analysis, proj, voltage_factor=c, **(engine_kwargs or {}))
    ref = R.faults(proj, c, opts)
    worst, lines = 0.0, []
    for bid, r in ref.items():
        e = eng.buses.get(bid)
        if e is None:
            lines.append(f"    {bid}: missing in engine")
            continue
        for k in kinds:
            rv, ev = r[k], getattr(e, k) or 0.0
            if rv < 1e-6 and ev < 1e-6:
                continue
            err = (ev - rv) / rv * 100 if rv > 1e-9 else float("inf")
            if abs(ev - rv) <= 0.0006 and not show_all:
                err = 0.0
            worst = max(worst, abs(err))
            if abs(err) > tol or show_all:
                lines.append(f"    {'XX' if abs(err) > tol else 'ok'} {bid:>14s} {k:5s} ref {rv:10.4f} "
                             f"eng {ev:10.4f} err {err:+8.2f}%")
    print(f"{label}: worst |err| = {worst:.3f}%")
    for ln in lines:
        print(ln)
    return worst
