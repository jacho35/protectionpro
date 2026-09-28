"""Unbalanced load flow: sequence networks iterated to a consistent solution
(BACKLOG S#1-F18).

The engine used to solve the positive sequence once, compute every load's
negative/zero-sequence current from phase voltages ASSUMED balanced
(Va = V1, Vb = a²V1, Vc = aV1), solve Y2·V2 = I2 and Y0·V0 = I0 once, and stop.
A heavily single-phase-loaded feeder then saw the wrong phase voltage at its
load, so its currents — and the voltage unbalance factor — were mis-stated.

Reference: an independent PHASE-DOMAIN solve of the same 2-bus feeder. The
source bus is an ideal balanced 1 p.u. (the engine's swing: V2 = V0 = 0), the
cable's phase impedance matrix is Zabc = A·diag(Z0, Z1, Z2)·A⁻¹ built from the
same per-km data, and the constant-power load's phase current is iterated to
V_B = V_A + Zabc·I_inj directly in phases — no sequence networks, no NR.
Per-unit convention matches the engine: S is p.u. of the three-phase base,
V is p.u. line-to-neutral, so I_pu = 3·conj(S_phase / V).
"""

import cmath
import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow
from backend.analysis.loadflow import run_load_flow

A_OP = cmath.exp(2j * math.pi / 3)
A_MAT = np.array([[1, 1, 1], [1, A_OP ** 2, A_OP], [1, A_OP, A_OP ** 2]], dtype=complex)

# 1 MVA base: the positive-sequence solver stops at a 1e-6 p.u. power
# mismatch, which on the 100 MVA default is 100 W — coarse against these
# ~100 kVA LV loads (~3e-5 p.u. of voltage). At 1 MVA it is 1 W, so the
# comparison below tests the MODEL to ~1e-6 p.u.; one test also runs at the
# 100 MVA default with a tolerance to match.
BASE_MVA = 1.0
KV = 0.4
R1, X1, R0, X0, KM = 0.3, 0.08, 1.2, 0.3, 0.2   # ohm/km and length


def _feeder(load_props, base_mva=None):
    comps = [
        Component(id="u", type="utility", x=0, y=0,
                  props={"voltage_kv": KV, "fault_mva": 500, "grounding": "solidly"}),
        Component(id="A", type="bus", x=0, y=0, props={"name": "A", "voltage_kv": KV}),
        Component(id="c", type="cable", x=0, y=0,
                  props={"name": "c", "voltage_kv": KV, "r_per_km": R1, "x_per_km": X1,
                         "r0_per_km": R0, "x0_per_km": X0, "length_km": KM,
                         "rated_amps": 400}),
        Component(id="B", type="bus", x=0, y=0, props={"name": "B", "voltage_kv": KV}),
        Component(id="L", type="static_load", x=0, y=0, props=load_props),
    ]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c", "from"),
             ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=base_mva or BASE_MVA, frequency=50,
                       components=comps, wires=wires)


def _phase_domain_reference(inj_currents, base_mva=None):
    """Solve V_B = V_A + Zabc·I_inj(V_B) by fixed-point iteration in phases."""
    z_base = KV ** 2 / (base_mva or BASE_MVA)
    z1 = complex(R1, X1) * KM / z_base
    z0 = complex(R0, X0) * KM / z_base
    z_abc = A_MAT @ np.diag([z0, z1, z1]) @ np.linalg.inv(A_MAT)
    v_a = np.array([1, A_OP ** 2, A_OP], dtype=complex)
    v_b = v_a.copy()
    for _ in range(500):
        v_new = v_a + z_abc @ inj_currents(v_b)
        if np.max(np.abs(v_new - v_b)) < 1e-12:
            return v_new
        v_b = v_new
    raise AssertionError("phase-domain reference did not converge")


def _assert_matches(res, v_ref, tol=2e-6):
    b = res.buses["B"]
    for mag, ang, ref in ((b.va_pu, b.angle_a_deg, v_ref[0]),
                          (b.vb_pu, b.angle_b_deg, v_ref[1]),
                          (b.vc_pu, b.angle_c_deg, v_ref[2])):
        assert mag == pytest.approx(abs(ref), abs=tol)
        assert ang == pytest.approx(math.degrees(cmath.phase(ref)), abs=1000 * tol)
    v1 = (v_ref[0] + A_OP * v_ref[1] + A_OP ** 2 * v_ref[2]) / 3
    v2 = (v_ref[0] + A_OP ** 2 * v_ref[1] + A_OP * v_ref[2]) / 3
    assert b.vuf_pct == pytest.approx(abs(v2) / abs(v1) * 100, abs=2e-3)


def test_single_phase_load_matches_phase_domain_reference():
    kva, pf = 60.0, 0.9
    s = complex(kva * pf, kva * math.sqrt(1 - pf ** 2)) / 1000 / BASE_MVA   # consumed, 3φ base

    def inj(v):
        return np.array([-3 * np.conj(s / v[0]), 0, 0], dtype=complex)

    v_ref = _phase_domain_reference(inj)
    res = run_unbalanced_load_flow(_feeder({"name": "L", "rated_kva": kva, "power_factor": pf,
                                            "phase_connection": "1P-A"}))
    assert res.converged
    _assert_matches(res, v_ref)
    # Heavy enough that the old one-pass answer was visibly off.
    assert abs(v_ref[0]) < 0.9


def test_line_to_line_load_matches_phase_domain_reference():
    kva, pf = 80.0, 0.85
    s = complex(kva * pf, kva * math.sqrt(1 - pf ** 2)) / 1000 / BASE_MVA

    def inj(v):
        i = 3 * np.conj(s / (v[0] - v[1]))
        return np.array([-i, i, 0], dtype=complex)

    v_ref = _phase_domain_reference(inj)
    res = run_unbalanced_load_flow(_feeder({"name": "L", "rated_kva": kva, "power_factor": pf,
                                            "phase_connection": "2P-AB"}))
    assert res.converged
    _assert_matches(res, v_ref)


@pytest.mark.parametrize("base_mva,tol", [(1.0, 2e-6), (100.0, 1e-4)],
                         ids=["1MVA-base", "100MVA-default"])
def test_uneven_three_phase_load_matches_phase_domain_reference(base_mva, tol):
    kva, pf = 150.0, 0.9
    pct = np.array([0.6, 0.25, 0.15])
    s = complex(kva * pf, kva * math.sqrt(1 - pf ** 2)) / 1000 / base_mva

    def inj(v):
        return -3 * np.conj(s * pct / v)

    v_ref = _phase_domain_reference(inj, base_mva)
    res = run_unbalanced_load_flow(_feeder({"name": "L", "rated_kva": kva, "power_factor": pf,
                                            "phase_connection": "3P", "phase_a_pct": 60,
                                            "phase_b_pct": 25, "phase_c_pct": 15}, base_mva))
    assert res.converged and res.sequence_iterations > 2
    _assert_matches(res, v_ref, tol)
    # Old single pass: phase A 0.8224 vs 0.7762 — 4.6 points optimistic.
    assert res.buses["B"].va_pu < 0.78


def test_balanced_load_matches_balanced_engine_and_has_no_unbalance():
    props = {"name": "L", "rated_kva": 150, "power_factor": 0.9,
             "phase_a_pct": 1, "phase_b_pct": 1, "phase_c_pct": 1}
    res = run_unbalanced_load_flow(_feeder(props))
    bal = run_load_flow(_feeder(props))
    b = res.buses["B"]
    assert b.vuf_pct == pytest.approx(0.0, abs=1e-9)
    for v in (b.va_pu, b.vb_pu, b.vc_pu):
        assert v == pytest.approx(bal.buses["B"].voltage_pu, abs=1e-6)
