"""Load-flow gap cleanup (follow-up to the load-flow review, PRs #326-#328).

Pins: a warning when several utilities share an island; cable tees made
through a breaker get a junction node (and an open breaker still isolates);
network reduction resolves tees like the load flow; a bus duct between a bus
and a branch gets that branch's current; an open-ended transformer (its far
side switched out) reports zero flow instead of a share of the swing supply.
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import run_load_flow
from backend.analysis.network_reduction import build_branch_ybus


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _util(uid, kv=11):
    return _c(uid, "utility", {"name": uid, "voltage_kv": kv, "fault_mva": 500})


def _cable(cid, kv=11, km=2, amps=300):
    return _c(cid, "cable", {"name": cid, "voltage_kv": kv, "r_per_km": 0.2,
                             "x_per_km": 0.1, "length_km": km, "rated_amps": amps})


def _load(lid, kva=1000):
    return _c(lid, "static_load", {"name": lid, "rated_kva": kva, "power_factor": 0.9})


# ── Several utilities in one island ─────────────────────────────────────

def test_two_utilities_in_one_island_warn():
    comps = [_util("U1"), _util("U2"), _c("A", "bus", {"voltage_kv": 11}),
             _c("B", "bus", {"voltage_kv": 11}), _cable("c", km=1), _load("L")]
    links = [("U1", "out", "A", "at_0"), ("U2", "out", "B", "at_0"),
             ("A", "at_1", "c", "from"), ("c", "to", "B", "at_1"), ("B", "at_2", "L", "in")]
    res = run_load_flow(_project(comps, links))
    assert any("utilities" in w.message and "fixed voltage reference" in w.message
               for w in res.warnings)
    # One utility per island (coupling cable removed): no warning.
    res1 = run_load_flow(_project(comps, [l for l in links if "c" not in (l[0], l[2])]))
    assert not any("fixed voltage reference" in w.message for w in res1.warnings)


# ── Cable tee through a breaker ─────────────────────────────────────────

def _tee_via_cb(state="closed", explicit=False):
    comps = [_util("u"), _c("A", "bus", {"voltage_kv": 11}), _c("B", "bus", {"voltage_kv": 11}),
             _c("C", "bus", {"voltage_kv": 11}), _cable("c1"), _cable("c2"), _cable("c3"),
             _c("cb", "cb", {"state": state}), _load("LB"), _load("LC")]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c1", "from"),
             ("c1", "to", "cb", "in"),
             ("c2", "to", "B", "at_0"), ("c3", "to", "C", "at_0"),
             ("B", "at_1", "LB", "in"), ("C", "at_1", "LC", "in")]
    if explicit:
        comps.append(_c("J", "bus", {"voltage_kv": 11}))
        links += [("cb", "out", "J", "at_0"), ("J", "at_1", "c2", "from"),
                  ("J", "at_2", "c3", "from")]
    else:
        links += [("cb", "out", "c2", "from"), ("cb", "out", "c3", "from")]
    return _project(comps, links)


def test_tee_through_breaker_matches_explicit_junction():
    res = run_load_flow(_tee_via_cb())
    ref = run_load_flow(_tee_via_cb(explicit=True))
    for bid in ("B", "C"):
        assert res.buses[bid].voltage_pu == pytest.approx(ref.buses[bid].voltage_pu, abs=1e-6)
    c1 = [b for b in res.branches if b.elementId == "c1"]
    assert len(c1) == 1 and c1[0].s_mva == pytest.approx(
        next(b for b in ref.branches if b.elementId == "c1").s_mva, abs=1e-4)
    assert not any("tees off" in w.message for w in res.warnings)


def test_open_breaker_at_tee_still_isolates():
    res = run_load_flow(_tee_via_cb(state="open"))
    assert res.buses["B"].energized is False
    assert res.buses["C"].energized is False


# ── Network reduction resolves tees like the load flow ──────────────────

def _tee(explicit):
    comps = [_util("u"), _c("A", "bus", {"voltage_kv": 11}), _c("B", "bus", {"voltage_kv": 11}),
             _c("C", "bus", {"voltage_kv": 11}), _cable("c1"), _cable("c2"), _cable("c3")]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c1", "from"),
             ("c2", "to", "B", "at_0"), ("c3", "to", "C", "at_0")]
    if explicit:
        comps.append(_c("J", "bus", {"voltage_kv": 11}))
        links += [("c1", "to", "J", "at_0"), ("J", "at_1", "c2", "from"),
                  ("J", "at_2", "c3", "from")]
    else:
        links += [("c1", "to", "c2", "from"), ("c1", "to", "c3", "from")]
    return _project(comps, links)


def test_network_reduction_tee_equals_explicit_junction():
    def ybus_abc(ctx, drop):
        Y, idx = ctx["Y"], ctx["bus_idx"]
        keep = [idx[b] for b in ("A", "B", "C")]
        d = [idx[b] for b in drop]
        if not d:
            return Y[np.ix_(keep, keep)]
        return (Y[np.ix_(keep, keep)]
                - Y[np.ix_(keep, d)] @ np.linalg.solve(Y[np.ix_(d, d)], Y[np.ix_(d, keep)]))
    tee = build_branch_ybus(_tee(False))
    ref = build_branch_ybus(_tee(True))
    junction = [b for b in tee["bus_idx"] if b.startswith("__tee__")]
    assert len(junction) == 1          # was: c1 stamped into both A–B and A–C
    assert np.allclose(ybus_abc(tee, junction), ybus_abc(ref, ["J"]), rtol=1e-9)


# ── Bus duct between a bus and a branch ─────────────────────────────────

def test_bus_duct_before_cable_reports_branch_current():
    comps = [_util("u", 0.4), _c("A", "bus", {"voltage_kv": 0.4}),
             _c("bd", "bus_duct", {"name": "BD", "rated_current_a": 1000, "length_m": 5}),
             _cable("c", kv=0.4, km=0.05, amps=900), _c("B", "bus", {"voltage_kv": 0.4}),
             _load("L", 500)]
    res = run_load_flow(_project(comps, [
        ("u", "out", "A", "at_0"), ("A", "at_1", "bd", "from"), ("bd", "to", "c", "from"),
        ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]))
    duct = next(b for b in res.branches if b.elementId == "bd")   # was: no row at all
    cable = next(b for b in res.branches if b.elementId == "c")
    assert duct.i_amps == pytest.approx(cable.i_amps, rel=1e-3)
    assert duct.loading_pct == pytest.approx(cable.i_amps / 1000 * 100, rel=1e-3)


# ── Open-ended transformer ──────────────────────────────────────────────

def test_open_ended_transformer_reports_zero_flow():
    comps = [_util("u"), _c("A", "bus", {"voltage_kv": 11}), _load("L", 800),
             _c("t", "transformer", {"name": "GSU", "rated_mva": 2, "z_percent": 6,
                                     "x_r_ratio": 8, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4}),
             _c("cb", "cb", {"state": "open"}),
             _c("g", "generator", {"rated_mva": 1.5, "power_factor": 0.8, "voltage_kv": 0.4})]
    res = run_load_flow(_project(comps, [
        ("u", "out", "A", "at_0"), ("A", "at_1", "L", "in"), ("A", "at_2", "t", "primary"),
        ("t", "secondary", "cb", "in"), ("cb", "out", "g", "out")]))
    tx = next(b for b in res.branches if b.elementId == "t")
    # Was 0.8 MVA / 40 %: the swing bus's whole supply attributed to it.
    assert tx.s_mva == 0 and tx.loading_pct == 0
    util = next(b for b in res.branches if b.elementId == "u")
    assert util.p_mw == pytest.approx(0.72, abs=1e-3)
