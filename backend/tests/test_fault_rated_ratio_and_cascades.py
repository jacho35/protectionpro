"""BACKLOG 53/54 — rated transformation ratio in the fault engines, and the
exact cascaded-transformer reduction in unbalanced load flow / network
reduction.

53: IEC 60909 refers impedances through the transformers' RATED ratio. The
    walkers used the ratio of the drawn bus voltages instead, so an 11/0.42 kV
    unit on a 0.4 kV bus carried (0.42/0.4)² too little impedance — its own
    and the grid's behind it — and the LV fault level read ~10 % high. The
    invariant pinned here: drawing the same LV bus at 0.40 or 0.42 kV leaves
    the network's ohms unchanged, so Ik'' = c·Un/(√3·|Z|) scales with Un.
54: a bus-less transformer cascade is Kron-reduced exactly (as the balanced
    engine does, EE-10) instead of summed under one combined ratio.
"""

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.fault_ansi import run_ansi_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow
from backend.analysis.network_reduction import build_branch_ybus


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _xfmr(tid, hv, lv, **extra):
    return _c(tid, "transformer", {"name": tid, "rated_mva": 1, "z_percent": 6,
                                   "x_r_ratio": 8, "voltage_hv_kv": hv, "voltage_lv_kv": lv,
                                   "vector_group": "Dyn11",
                                   "grounding_lv": "solidly_grounded", **extra})


# ── 53: fault level behind a 0.42 kV-nameplate transformer ──────────────

def _lv_fault_net(lv_bus_kv, parallel=False):
    comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 15}),
             _c("A", "bus", {"voltage_kv": 11}), _xfmr("t", 11, 0.42),
             _c("B", "bus", {"voltage_kv": lv_bus_kv})]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
             ("t", "secondary", "B", "at_0")]
    if parallel:   # a mesh → the nodal (off-nominal branch) solver
        comps.append(_xfmr("t2", 11, 0.42))
        links += [("A", "at_2", "t2", "primary"), ("t2", "secondary", "B", "at_1")]
    return _project(comps, links)


@pytest.mark.parametrize("parallel", [False, True], ids=["radial", "meshed"])
def test_iec60909_lv_fault_uses_rated_ratio(parallel):
    at_040 = run_fault_analysis(_lv_fault_net(0.40, parallel)).buses["B"]
    at_042 = run_fault_analysis(_lv_fault_net(0.42, parallel)).buses["B"]
    # Was 1.05 (radial 25.31 vs 24.10 kA): the 0.40 kV drawing lost 10 % of Z.
    assert at_040.ik3 / at_042.ik3 == pytest.approx(0.40 / 0.42, rel=1e-4)
    assert at_040.ik1 / at_042.ik1 == pytest.approx(0.40 / 0.42, rel=1e-4)


def test_ansi_lv_fault_uses_rated_ratio():
    def i_sym(kv):
        return run_ansi_fault_analysis(_lv_fault_net(kv))["buses"]["B"]["i_sym_momentary_ka"]
    assert i_sym(0.40) / i_sym(0.42) == pytest.approx(0.40 / 0.42, rel=1e-4)


# ── 54: exact cascaded-transformer reduction ─────────────────────────────

def _cascade(explicit_mid_buses=False):
    comps = [_xfmr("t0", 66, 33), _xfmr("t1", 33, 11, tap_percent=5), _xfmr("t2", 11, 0.4),
             _c("u", "utility", {"voltage_kv": 66, "fault_mva": 2000}),
             _c("A", "bus", {"voltage_kv": 66}), _c("B", "bus", {"voltage_kv": 0.4}),
             _c("L", "static_load", {"rated_kva": 500, "power_factor": 0.9})]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "t0", "primary"),
             ("t2", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")]
    if explicit_mid_buses:
        comps += [_c("M1", "bus", {"voltage_kv": 33}), _c("M2", "bus", {"voltage_kv": 11})]
        links += [("t0", "secondary", "M1", "at_0"), ("M1", "at_1", "t1", "primary"),
                  ("t1", "secondary", "M2", "at_0"), ("M2", "at_1", "t2", "primary")]
    else:
        links += [("t0", "secondary", "t1", "primary"), ("t1", "secondary", "t2", "primary")]
    return _project(comps, links)


def test_unbalanced_cascade_matches_balanced_and_explicit_buses():
    unb = run_unbalanced_load_flow(_cascade()).buses["B"].va_pu
    # Was 0.8938 vs 0.8959 (impedances summed under one combined ratio).
    assert unb == pytest.approx(run_load_flow(_cascade()).buses["B"].voltage_pu, abs=1e-5)
    assert unb == pytest.approx(
        run_unbalanced_load_flow(_cascade(explicit_mid_buses=True)).buses["B"].va_pu, abs=1e-5)


def test_network_reduction_cascade_equals_explicit_bus_kron():
    lumped = build_branch_ybus(_cascade())
    explicit = build_branch_ybus(_cascade(explicit_mid_buses=True))
    # Kron-reduce the explicit network's intermediate buses away: the
    # remaining A–B two-port must equal the lumped chain's stamp.
    Y, idx = explicit["Y"], explicit["bus_idx"]
    keep = [idx["A"], idx["B"]]
    drop = [idx["M1"], idx["M2"]]
    Yr = (Y[np.ix_(keep, keep)]
          - Y[np.ix_(keep, drop)] @ np.linalg.solve(Y[np.ix_(drop, drop)], Y[np.ix_(drop, keep)]))
    Yl, il = lumped["Y"], lumped["bus_idx"]
    Yl2 = Yl[np.ix_([il["A"], il["B"]], [il["A"], il["B"]])]
    assert np.allclose(Yl2, Yr, rtol=1e-9, atol=1e-9)
