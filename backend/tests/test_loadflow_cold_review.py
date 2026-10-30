"""Regression tests for the load-flow cold review (reviews/LOADFLOW_COLD_REVIEW.md:
LF-C1, LF-C2, LF-R1, LF-R2, P1–P6, and backlog #4). Each test reproduces the
original defect. Reference voltages come from pandapower 3.5 (independent
PYPOWER Newton-Raphson, trafo `tap_changer_type="Ratio"`, pi model, no
magnetising branch) or from a hand calculation, never from the engine.
"""

import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import _newton_raphson, run_load_flow


def _c(cid, t, **props):
    props.setdefault("name", cid)
    return Component(id=cid, type=t, x=0, y=0, props=props)


class _Net:
    def __init__(self, base_mva=100.0):
        self.base = base_mva
        self.comps, self.wires = [], []

    def add(self, cid, t, **props):
        self.comps.append(_c(cid, t, **props))
        return cid

    def wire(self, a, ap, b, bp):
        self.wires.append(Wire(id=f"w{len(self.wires)}", fromComponent=a, fromPort=ap,
                               toComponent=b, toPort=bp))

    def project(self):
        return ProjectData(projectName="t", baseMVA=self.base, components=self.comps,
                           wires=self.wires)

    def run(self, **kw):
        return run_load_flow(self.project(), "newton_raphson", **kw)


def _row(res, eid):
    return next(b for b in res.branches if b.elementId == eid)


def _disp(res, eid):
    return next(d for d in res.dispatch if d.source_id == eid)


# ── LF-C1 · equal-voltage transformer oriented by its HV port ──────────────

def _one_to_one(order, winding_config=None, tap_mode="fixed", tap=5.0, hv_on="S"):
    """11 kV utility bus S → 10 MVA 11/11 kV 6 % X/R 10 transformer (tap on
    the HV winding) → bus D with a 5 MVA 0.9 pf load. `hv_on` names the bus
    on the HV port; `order` only changes which of the two wires is listed
    first."""
    n = _Net()
    n.add("S", "bus", voltage_kv=11)
    n.add("D", "bus", voltage_kv=11)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "S", "p0")
    props = dict(rated_mva=10, voltage_hv_kv=11, voltage_lv_kv=11, z_percent=6,
                 x_r_ratio=10, tap_percent=tap, tap_mode=tap_mode)
    if winding_config:
        props["winding_config"] = winding_config
    n.add("T", "transformer", **props)
    hv_port = "secondary" if winding_config == "step_up" else "primary"
    lv_port = "primary" if hv_port == "secondary" else "secondary"
    lv_on = "D" if hv_on == "S" else "S"
    pair = [(hv_on, hv_port), (lv_on, lv_port)]
    if order == "lv_first":
        pair.reverse()
    for bus, port in pair:
        n.wire(bus, "p1", "T", port)
    n.add("L", "static_load", rated_kva=5000, power_factor=0.9)
    n.wire("D", "p2", "L", "in")
    return n


@pytest.mark.parametrize("order", ["hv_first", "lv_first"])
def test_lfc1_tap_side_follows_the_hv_port_not_wire_order(order):
    """[LF-C1] The secondary-first wire order put the +5 % tap on the load
    side: 1.033 pu instead of 0.935, with no warning."""
    res = _one_to_one(order).run()
    assert res.buses["D"].voltage_pu == pytest.approx(0.93520246, abs=2e-6)  # pandapower


@pytest.mark.parametrize("order", ["hv_first", "lv_first"])
def test_lfc1_step_up_unit_has_its_hv_winding_on_the_secondary(order):
    """A step-up unit's HV winding is its secondary port (fault.py's rule):
    secondary on the source bus is the same network as a step-down unit with
    its primary there."""
    res = _one_to_one(order, winding_config="step_up").run()
    assert res.buses["D"].voltage_pu == pytest.approx(0.93520246, abs=2e-6)


def test_lfc1_hv_port_on_the_load_side_is_respected():
    """Tap on the load side (HV port wired to D) raises D — the other answer,
    now reached by the drawing rather than by wire order."""
    a = _one_to_one("hv_first", hv_on="D").run().buses["D"].voltage_pu
    b = _one_to_one("lv_first", hv_on="D").run().buses["D"].voltage_pu
    assert a == pytest.approx(b, abs=1e-9)
    assert a > 1.0


@pytest.mark.parametrize("order", ["hv_first", "lv_first"])
def test_lfc1_one_to_one_oltc_regulates_the_load_bus(order):
    """[LF-C1] With the wrong wire order the OLTC regulated the swing bus and
    left the load bus at 0.973 pu against a 1.000 target, silently."""
    n = _one_to_one(order, tap_mode="regulating", tap=0.0)
    t = next(c for c in n.comps if c.id == "T")
    t.props.update(regulated_side="lv", v_target_pu=1.0, tap_step_pct=1.25,
                   tap_min_pct=-10, tap_max_pct=10)
    res = n.run()
    assert res.buses["D"].voltage_pu == pytest.approx(1.0, abs=0.0125 / 2 + 1e-6)


# ── LF-C2 · terminal bus at the zone voltage ───────────────────────────────

@pytest.mark.parametrize("load_first", [False, True])
def test_lfc2_terminal_bus_takes_the_feeder_zone(load_first):
    """[LF-C2] A load left at 0.4 kV on 2 km of 11 kV cable: one wire order
    put the cable on a 0.4 kV base (756× its impedance) and the solve failed."""
    n = _Net()
    n.add("S", "bus", voltage_kv=11)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "S", "p0")
    n.add("C", "cable", r_per_km=0.2, x_per_km=0.1, length_km=2.0, voltage_kv=11,
          rated_amps=400)
    n.add("LT", "static_load", rated_kva=3000, power_factor=0.85, voltage_kv=0.4)
    w = [("S", "p1", "C", "from"), ("C", "to", "LT", "in")]
    for a in (reversed(w) if load_first else w):
        n.wire(*a)
    res = n.run(include_synthetic=True)
    assert res.converged
    assert res.buses["__term__LT"].voltage_pu == pytest.approx(0.98883, abs=2e-5)  # pandapower
    assert any(w.elementId == "LT" and "Voltage mismatch" in w.message for w in res.warnings)
    assert not any(w.elementId == "C" for w in res.warnings)


def test_lfc2_nameplate_close_to_the_zone_is_kept():
    """A 0.4 kV motor behind an 11/0.42 kV unit keeps its 0.4 kV base, so its
    terminal reads above 1 pu as before."""
    n = _Net()
    n.add("S", "bus", voltage_kv=11)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "S", "p0")
    n.add("T", "transformer", rated_mva=1, voltage_hv_kv=11, voltage_lv_kv=0.42,
          z_percent=5, x_r_ratio=6)
    n.add("M", "static_load", rated_kva=50, power_factor=0.9, voltage_kv=0.4)
    n.wire("S", "p1", "T", "primary")
    n.wire("T", "secondary", "M", "in")
    res = n.run(include_synthetic=True)
    assert res.buses["__term__M"].voltage_kv / res.buses["__term__M"].voltage_pu == pytest.approx(0.4, rel=1e-4)
    assert res.buses["__term__M"].voltage_pu > 1.03
    assert not any(w.elementId == "M" for w in res.warnings)


@pytest.mark.parametrize("swap", [False, True])
def test_lfc2_cable_between_mismatched_buses_is_order_independent(swap):
    """A cable joining an 11 kV and a 0.4 kV bus (a drawing error) is referred
    to the bus matching its own rating whichever end the walk meets first,
    and the error is reported."""
    n = _Net()
    n.add("A", "bus", voltage_kv=11)
    n.add("B", "bus", voltage_kv=0.4)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "A", "p0")
    n.add("C", "cable", r_per_km=0.2, x_per_km=0.1, length_km=2.0, voltage_kv=11)
    w = [("A", "p1", "C", "from"), ("C", "to", "B", "p1")]
    for a in (reversed(w) if swap else w):
        n.wire(*a)
    n.add("L", "static_load", rated_kva=50, power_factor=0.9)
    n.wire("B", "p2", "L", "in")
    res = n.run()
    assert res.converged
    # 11 kV base: ΔV ≈ (R·P + X·Q)/U² for 45 kW / 21.8 kvar over 0.4+j0.2 Ω.
    dv = (0.4 * 0.045 + 0.2 * 0.0218) / 11 ** 2
    assert res.buses["B"].voltage_pu == pytest.approx(1 - dv, abs=1e-5)
    assert any(w.elementId == "C" and "no transformer" in w.message for w in res.warnings)


# ── LF-R1 · island balancer reactive attribution ───────────────────────────

def _island(with_statcom=False, with_bess=False):
    n = _Net()
    for b in ("A", "B", "C"):
        n.add(b, "bus", voltage_kv=11)
    n.add("G1", "generator", rated_mva=20, power_factor=0.8, voltage_setpoint_pu=1.0,
          voltage_kv=11, dispatch_mode="standby")
    n.wire("G1", "out", "A", "pa")
    n.add("AB", "cable", r_per_km=0.2, x_per_km=0.1, length_km=3, voltage_kv=11)
    n.add("BC", "cable", r_per_km=0.2, x_per_km=0.1, length_km=3, voltage_kv=11)
    n.wire("A", "p1", "AB", "from"); n.wire("AB", "to", "B", "p1")
    n.wire("B", "p2", "BC", "from"); n.wire("BC", "to", "C", "p1")
    n.add("LB", "static_load", rated_kva=6000, power_factor=0.8)
    n.add("LC", "static_load", rated_kva=5000, power_factor=0.75)
    n.wire("B", "p3", "LB", "in"); n.wire("C", "p2", "LC", "in")
    if with_statcom:
        n.add("S", "svc", device_mode="statcom", rated_mvar=10,
              control_mode="voltage_regulating", v_setpoint_pu=1.0)
        n.wire("S", "out", "C", "p3")
    if with_bess:
        n.add("BT", "battery", rated_kva=2000, battery_kwh=4000, battery_mode="discharging",
              battery_soc_pct=80, battery_max_discharge_kw=1000, battery_max_charge_kw=1000,
              var_mode="voltage", v_setpoint_pu=1.0)
        n.wire("BT", "out", "C", "p4")
    return n


def test_lfr1_statcom_q_is_not_charged_to_the_genset():
    """[LF-R1] The genset truly absorbs 2.70 Mvar (pandapower) but was reported
    supplying +7.30 Mvar — the STATCOM's 10 Mvar added to it."""
    res = _island(with_statcom=True).run()
    assert _disp(res, "G1").dispatched_mvar == pytest.approx(-2.6996, abs=2e-4)
    assert _row(res, "G1").q_mvar == pytest.approx(_row(res, "AB").q_mvar, abs=2e-4)


def test_lfr1_voltage_mode_battery_q_is_not_charged_to_the_genset():
    """The genset's reported Q is what leaves its bus (its only branch)."""
    res = _island(with_bess=True).run()
    assert _disp(res, "G1").dispatched_mvar == pytest.approx(_row(res, "AB").q_mvar, abs=2e-4)


def test_p5_balancer_current_uses_its_bus_voltage():
    """[P5] A balancer genset without voltage_kv on an 11 kV bus had its
    current computed at 0.4 kV (27.5× too high)."""
    n = _island()
    next(c for c in n.comps if c.id == "G1").props.pop("voltage_kv")
    res = n.run()
    g = _row(res, "G1")
    i_hand = g.s_mva * 1000 / (math.sqrt(3) * 11 * res.buses["A"].voltage_pu)
    assert g.i_amps == pytest.approx(i_hand, rel=1e-3)


# ── LF-R2 · droop sets share vars by rating ────────────────────────────────

def test_lfr2_droop_sets_share_reactive_by_rating():
    """[LF-R2] 2 + 1 MVA sets, 1.5 MVA load at 0.99 pf: the 1 MVA set ran at
    rated pf (+0.388 Mvar) and the 2 MVA reference set absorbed −0.123."""
    n = _Net()
    for b in ("G", "H", "L"):
        n.add(b, "bus", voltage_kv=0.4)
    n.add("G1", "generator", rated_mva=2.0, power_factor=0.8, voltage_kv=0.4,
          dispatch_mode="must_run")
    n.add("G2", "generator", rated_mva=1.0, power_factor=0.8, voltage_kv=0.4,
          dispatch_mode="must_run")
    n.wire("G1", "out", "G", "a"); n.wire("G2", "out", "H", "b")
    n.add("C0", "cable", r_per_km=0.1, x_per_km=0.08, length_km=0.05, voltage_kv=0.4,
          num_parallel=4)
    n.add("C", "cable", r_per_km=0.1, x_per_km=0.08, length_km=0.15, voltage_kv=0.4,
          num_parallel=4)
    n.wire("G", "p1", "C0", "from"); n.wire("C0", "to", "H", "p1")
    n.wire("H", "p2", "C", "from"); n.wire("C", "to", "L", "p1")
    n.add("LD", "static_load", rated_kva=1500, power_factor=0.99)
    n.wire("L", "p2", "LD", "in")
    res = n.run()
    q1, q2 = _disp(res, "G1").dispatched_mvar, _disp(res, "G2").dispatched_mvar
    p1, p2 = _disp(res, "G1").dispatched_mw, _disp(res, "G2").dispatched_mw
    assert q1 > 0 and q2 > 0
    assert q1 / q2 == pytest.approx(2.0, rel=1e-3)
    assert p1 / p2 == pytest.approx(2.0, rel=1e-3)
    # G1's reported Q is what leaves its bus.
    assert q1 == pytest.approx(_row(res, "C0").q_mvar, abs=2e-4)


# ── P1 / P6 · capacitor banks ──────────────────────────────────────────────

def _cap_feeder(cap_kvar=150.0, cap_kv=None):
    n = _Net()
    n.add("A", "bus", voltage_kv=0.4)
    n.add("B", "bus", voltage_kv=0.4)
    n.add("U", "utility", voltage_kv=0.4, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "A", "p0")
    n.add("C", "cable", r_per_km=0.32, x_per_km=0.08, length_km=0.3, voltage_kv=0.4,
          num_parallel=2)
    n.wire("A", "p1", "C", "from"); n.wire("C", "to", "B", "p1")
    n.add("L", "static_load", rated_kva=300, power_factor=0.8)
    n.wire("B", "p2", "L", "in")
    props = {"rated_kvar": cap_kvar}
    if cap_kv is not None:
        props["voltage_kv"] = cap_kv
    n.add("Q", "capacitor_bank", **props)
    n.wire("B", "p3", "Q", "in")
    return n


def test_p1_capacitor_is_an_exact_susceptance():
    """[P1] The V² tracking stopped on a 1 kvar change, up to 2.3e-4 pu off
    on LV banks; the susceptance is now in the solved matrix."""
    res = _cap_feeder().run()
    assert res.buses["B"].voltage_pu == pytest.approx(0.9170850, abs=2e-6)  # pandapower


def test_p6_capacitor_rating_voltage_scales_its_output():
    """[P6] 150 kvar at 0.525 kV on a 0.4 kV bus delivers 150·(0.4/0.525)²."""
    rated = _cap_feeder(cap_kvar=150.0, cap_kv=0.525).run()
    equiv = _cap_feeder(cap_kvar=150.0 * (0.4 / 0.525) ** 2).run()
    assert rated.buses["B"].voltage_pu == pytest.approx(equiv.buses["B"].voltage_pu, abs=1e-9)


def test_p6_implausible_capacitor_rating_is_ignored_and_reported():
    """The 11 kV palette default left on an LV bank is not a rating."""
    res = _cap_feeder(cap_kv=11).run()
    plain = _cap_feeder().run()
    assert res.buses["B"].voltage_pu == pytest.approx(plain.buses["B"].voltage_pu, abs=1e-9)
    assert any(w.elementId == "Q" and "rated 11 kV" in w.message for w in res.warnings)


# ── P2 · Newton-Raphson stopping rule ──────────────────────────────────────

def test_p2_newton_raphson_reaches_a_tight_mismatch():
    """[P2] 1e-6 pu absolute on the study base left ~3e-5 pu at weak LV
    buses. A 0.4 kV feeder on a 100 MVA base: residual mismatch < 1e-9."""
    z_base = 0.4 ** 2 / 100
    y = 1 / complex(0.02 / z_base, 0.01 / z_base)
    Y = np.array([[y, -y], [-y, y]])
    P = np.array([0.0, -0.2 / 100])
    Q = np.array([0.0, -0.1 / 100])
    V, ok, _it, _r = _newton_raphson(Y, P, Q, np.ones(2), [2, 0])
    assert ok
    S = V * np.conj(Y @ V)
    assert abs(S[1] - complex(P[1], Q[1])) < 1e-9


# ── P3 · over-voltage in the warnings list ─────────────────────────────────

def test_p1_heavy_capacitor_on_a_resistive_feeder_converges():
    """The outer V² loop did not converge with 2000 / 3000 kvar on this
    resistive LV cable; pandapower solves both (the bank cannot lift a
    feeder whose R ≫ X)."""
    for kvar, v_ref in ((2000, 0.9053860), (3000, 0.8071746)):
        res = _cap_feeder(cap_kvar=kvar).run()
        assert res.converged
        assert res.buses["B"].voltage_pu == pytest.approx(v_ref, abs=2e-6)


def test_p3_over_voltage_is_reported():
    n = _cap_feeder(cap_kvar=0)
    next(c for c in n.comps if c.id == "U").props["v_setpoint_pu"] = 1.13
    res = n.run()
    assert res.buses["A"].voltage_pu == pytest.approx(1.13)
    assert res.solution_quality == "ok"
    assert any(w.elementId == "A" and "Over-voltage" in w.message for w in res.warnings)


# ── P4 · transformer loading is a current ratio ────────────────────────────

def test_p4_transformer_loading_is_lv_current_over_rated_current():
    """[P4] |S|/S_r at the walk-first terminal under-read: 76.07 % vs 77.97 %
    by current in the 33/11.5 kV case. The two agree only while the terminal
    sits at its nameplate voltage; here the HV bus is at 0.95 pu, so the
    windings carry 1/0.95 of the S/S_r figure."""
    n = _Net()
    n.add("H", "bus", voltage_kv=11)
    n.add("L", "bus", voltage_kv=0.4)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15, v_setpoint_pu=0.95)
    n.wire("U", "out", "H", "p0")
    n.add("T", "transformer", rated_mva=1, voltage_hv_kv=11, voltage_lv_kv=0.42,
          z_percent=8, x_r_ratio=6)
    n.wire("H", "p1", "T", "primary"); n.wire("T", "secondary", "L", "p1")
    n.add("LD", "static_load", rated_kva=1000, power_factor=0.8)
    n.wire("L", "p2", "LD", "in")
    res = n.run()
    t = _row(res, "T")
    i_r = 1 * 1000 / (math.sqrt(3) * 0.42)
    assert t.loading_pct == pytest.approx(t.i_amps / i_r * 100, rel=1e-3)
    assert t.loading_pct > t.s_mva / 1 * 100 + 1   # depressed LV: S/S_r under-reads


# ── Backlog #4 · SVC on the swing bus ──────────────────────────────────────

def test_svc_on_the_swing_bus_reports_zero():
    """The swing source holds the bus; the STATCOM there has nothing to
    regulate and reported the utility's whole 3.70 Mvar as its own."""
    n = _Net()
    n.add("A", "bus", voltage_kv=11)
    n.add("B", "bus", voltage_kv=11)
    n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
    n.wire("U", "out", "A", "p0")
    n.add("C", "cable", r_per_km=0.2, x_per_km=0.1, length_km=2, voltage_kv=11)
    n.wire("A", "p1", "C", "from"); n.wire("C", "to", "B", "p1")
    n.add("L", "static_load", rated_kva=6000, power_factor=0.8)
    n.wire("B", "p2", "L", "in")
    n.add("S", "svc", device_mode="statcom", rated_mvar=5, q_max_mvar=1, q_min_mvar=-1,
          control_mode="voltage_regulating", v_setpoint_pu=1.0)
    n.wire("S", "out", "A", "p3")
    res = n.run()
    assert res.converged
    svc = next(u for u in res.svc if u["id"] == "S")
    assert svc["q_mvar"] == 0.0 and not svc["at_limit"]
    assert res.buses["A"].voltage_pu == pytest.approx(1.0, abs=1e-9)


def test_svc_on_the_swing_bus_set_above_it_runs_to_its_limit():
    """Set above the voltage the swing holds, the SVC sits at its capacitive
    limit (it cannot raise a stiff bus), and the utility supplies that much
    less reactive power — the bank's Q is not counted twice."""
    def net(with_svc):
        n = _Net()
        n.add("A", "bus", voltage_kv=11)
        n.add("U", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15)
        n.wire("U", "out", "A", "p0")
        n.add("L", "static_load", rated_kva=8000, power_factor=0.8)
        n.wire("A", "p1", "L", "in")
        if with_svc:
            n.add("S", "svc", device_mode="statcom", rated_mvar=4, q_max_mvar=4,
                  q_min_mvar=-4, control_mode="voltage_regulating", v_setpoint_pu=1.02)
            n.wire("S", "out", "A", "p2")
        return n.run()
    res, base = net(True), net(False)
    assert next(u for u in res.svc if u["id"] == "S")["q_mvar"] == pytest.approx(4.0)
    assert _row(res, "U").q_mvar == pytest.approx(_row(base, "U").q_mvar - 4.0, abs=1e-3)
