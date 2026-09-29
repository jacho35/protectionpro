"""Sibling engines follow the load-flow review fixes (PR #326 follow-up).

Unbalanced load flow, harmonics, frequency scan and network reduction reuse
the balanced engine's branch-chain machinery. These pin that they now agree
with it on: transformer impedance re-based to the bus voltage, cable tees
resolved with a junction node, per-zone branch currents (unbalanced), and
cascaded transformers taken in electrical order.
"""

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import run_load_flow
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow
from backend.analysis.harmonics import run_harmonics, _branch_chains
from backend.analysis.frequency_scan import run_frequency_scan
from backend.analysis.network_reduction import build_branch_ybus


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _bus(bid, kv):
    return _c(bid, "bus", {"name": bid, "voltage_kv": kv})


def _cable(cid, kv, r, x, km, amps=400):
    return _c(cid, "cable", {"name": cid, "voltage_kv": kv, "r_per_km": r,
                             "x_per_km": x, "length_km": km, "rated_amps": amps})


def _load(lid, kva, pf):
    return _c(lid, "static_load", {"name": lid, "rated_kva": kva, "power_factor": pf})


def _xfmr(tid="t", hv=11, lv=0.4, **extra):
    return _c(tid, "transformer", {"name": tid, "rated_mva": 1, "z_percent": 6,
                                   "x_r_ratio": 8, "voltage_hv_kv": hv,
                                   "voltage_lv_kv": lv, "vector_group": "Dyn11", **extra})


# ── Unbalanced: each element's current on its own side of the transformer ──

def _tx_cable_net():
    comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 500}), _bus("A", 11),
             _xfmr(), _cable("c", 0.4, 0.1, 0.08, 0.05, 1500), _bus("B", 0.4),
             _load("L", 800, 0.9)]
    return _project(comps, [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
                            ("t", "secondary", "c", "from"), ("c", "to", "B", "at_0"),
                            ("B", "at_1", "L", "in")])


def test_unbalanced_lv_cable_behind_transformer_reports_lv_current():
    proj = _tx_cable_net()
    unb = {b.elementId: b for b in run_unbalanced_load_flow(proj).branches}
    bal = {b.elementId: b for b in run_load_flow(proj).branches}
    # Was 44.8 A / 3 % — the HV-side current on a 0.4 kV cable.
    assert unb["c"].ia_amps == pytest.approx(bal["c"].i_amps, rel=1e-3)
    assert unb["c"].loading_pct == pytest.approx(bal["c"].loading_pct, abs=0.1)
    # The transformer is reported on its LV side, like the balanced engine.
    assert unb["t"].ia_amps == pytest.approx(bal["t"].i_amps, rel=1e-3)
    assert unb["t"].loading_pct == pytest.approx(bal["t"].loading_pct, abs=0.1)


# ── Transformer impedance re-based to the bus voltage ────────────────────

def _nameplate_net(bus_lv_kv):
    comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 500}), _bus("A", 11),
             _xfmr(lv=0.42), _bus("B", bus_lv_kv), _load("L", 1000, 0.85)]
    return _project(comps, [("u", "out", "A", "at_0"), ("A", "at_1", "t", "primary"),
                            ("t", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")])


def test_unbalanced_nameplate_mismatch_matches_balanced():
    # Both engines re-base the same way, so they agree on every drawing, and
    # the physical LV voltage no longer depends on the bus's drawn kV.
    kv_b = {}
    for kv in (0.40, 0.42):
        bal = run_load_flow(_nameplate_net(kv)).buses["B"]
        unb = run_unbalanced_load_flow(_nameplate_net(kv)).buses["B"]
        assert unb.va_pu == pytest.approx(bal.voltage_pu, abs=1e-4)
        kv_b[kv] = unb.va_pu * kv
    assert kv_b[0.40] == pytest.approx(kv_b[0.42], abs=2e-4)


def test_harmonic_chain_rebases_transformer_impedance():
    def x_pu(kv):
        chains = _branch_chains(_nameplate_net(kv), 100.0)[0]
        return next(x for a, b, _r, x, _st in chains if {a, b} == {"A", "B"})
    # Same ohms, so on the 0.40 kV base the pu value is (0.42/0.40)² larger.
    assert x_pu(0.40) == pytest.approx(x_pu(0.42) * (0.42 / 0.40) ** 2, rel=1e-9)


def test_network_reduction_rebases_transformer_impedance():
    def y_ab(kv):
        ctx = build_branch_ybus(_nameplate_net(kv))
        return abs(ctx["Y"][ctx["bus_idx"]["B"], ctx["bus_idx"]["B"]])
    # Y_BB = y on the LV side, so it shrinks by the same (0.42/0.40)² factor.
    assert y_ab(0.40) == pytest.approx(y_ab(0.42) / (0.42 / 0.40) ** 2, rel=1e-9)


# ── Cascaded transformers taken in electrical order ──────────────────────

def _cascade(order):
    # 66/33 + 33/11 (tapped) + 11/0.4 drawn with no bus between them. Listing
    # the MIDDLE unit first makes it the walk's seed, so the path-built dict
    # comes out [t1, t0, t2] — not the electrical order — and a ratio walk
    # over it tracks the voltage zones wrongly.
    parts = {"t0": _xfmr("t0", hv=66, lv=33),
             "t1": _xfmr("t1", hv=33, lv=11, tap_percent=5),
             "t2": _xfmr("t2", hv=11, lv=0.4)}
    comps = [parts[k] for k in order] + [
        _c("u", "utility", {"voltage_kv": 66, "fault_mva": 2000}),
        _bus("A", 66), _bus("B", 0.4), _load("L", 500, 0.9)]
    return _project(comps, [("u", "out", "A", "at_0"), ("A", "at_1", "t0", "primary"),
                            ("t0", "secondary", "t1", "primary"),
                            ("t1", "secondary", "t2", "primary"),
                            ("t2", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")])


def test_network_reduction_cascade_ratio_independent_of_list_order():
    y_ref = build_branch_ybus(_cascade(["t0", "t1", "t2"]))["Y"]
    y_mid = build_branch_ybus(_cascade(["t1", "t0", "t2"]))["Y"]
    assert np.allclose(y_mid, y_ref)


def test_unbalanced_cascade_independent_of_list_order():
    def v_b(order):
        return run_unbalanced_load_flow(_cascade(order)).buses["B"].va_pu
    ref = v_b(["t0", "t1", "t2"])
    # Was 0.024 p.u. with the middle unit listed first (vs 0.894).
    assert v_b(["t1", "t0", "t2"]) == pytest.approx(ref, abs=1e-6)


# ── Cable tees resolved with a junction node ─────────────────────────────

def _tee(explicit):
    comps = [_c("u", "utility", {"voltage_kv": 11, "fault_mva": 500}), _bus("A", 11),
             _bus("B", 11), _bus("C", 11),
             _cable("c1", 11, 0.2, 0.1, 2, 300), _cable("c2", 11, 0.2, 0.1, 2, 300),
             _cable("c3", 11, 0.2, 0.1, 2, 300), _load("LB", 1000, 0.9), _load("LC", 1000, 0.9),
             _c("vfd", "vfd", {"name": "VFD", "rated_kw": 400, "voltage_kv": 11,
                               "pulse_number": 6, "front_end": "diode"})]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c1", "from"),
             ("c2", "to", "B", "at_0"), ("c3", "to", "C", "at_0"),
             ("B", "at_1", "LB", "in"), ("C", "at_1", "LC", "in"), ("B", "at_2", "vfd", "in")]
    if explicit:
        comps.append(_bus("J", 11))
        links += [("c1", "to", "J", "at_0"), ("J", "at_1", "c2", "from"),
                  ("J", "at_2", "c3", "from")]
    else:
        links += [("c1", "to", "c2", "from"), ("c1", "to", "c3", "from")]
    return _project(comps, links)


def test_unbalanced_tee_matches_explicit_junction():
    def v(explicit, bid):
        return run_unbalanced_load_flow(_tee(explicit)).buses[bid].va_pu
    for bid in ("B", "C"):
        assert v(False, bid) == pytest.approx(v(True, bid), abs=1e-6)


def test_harmonics_tee_matches_explicit_junction():
    def thd(explicit):
        res = run_harmonics(_tee(explicit))
        return {b["id"]: b["thd_v_pct"] for b in res["buses"]}
    tee, ref = thd(False), thd(True)
    for bid in ("B", "C"):
        assert tee[bid] == pytest.approx(ref[bid], abs=0.01)


def test_frequency_scan_tee_matches_explicit_junction():
    def z(explicit):
        res = run_frequency_scan(_tee(explicit), bus_ids=["B"])
        return next(b for b in res["buses"] if b["id"] == "B")["z_ohm"]
    assert np.allclose(z(False), z(True), rtol=1e-6)


# ── Autotransformer voltage-mismatch warning ─────────────────────────────

def test_autotransformer_chain_gets_voltage_mismatch_warning():
    comps = [_c("u", "utility", {"voltage_kv": 132, "fault_mva": 5000}), _bus("A", 132),
             _c("at", "autotransformer", {"name": "AT", "rated_mva": 50, "z_percent": 8,
                                          "x_r_ratio": 30, "voltage_hv_kv": 132,
                                          "voltage_lv_kv": 66}),
             _cable("c", 11, 0.05, 0.1, 1, 800),   # stale 11 kV on a 66 kV run
             _bus("B", 66), _load("L", 10000, 0.9)]
    res = run_load_flow(_project(comps, [
        ("u", "out", "A", "at_0"), ("A", "at_1", "at", "primary"),
        ("at", "secondary", "c", "from"), ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]))
    assert any(w.elementId == "c" and "Voltage mismatch" in w.message for w in res.warnings)
