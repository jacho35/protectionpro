"""Unbalanced load flow review (2026-10-01, reviews/UNBALANCED_LOADFLOW_REVIEW.md):
one regression test per finding U1–U6, each reproducing the original defect
against an independent reference.

References are built here from first principles, not from the engine:
- a phase-domain solve (Z_abc = A·diag(Z0, Z1, Z2)·A⁻¹; constant-power phase
  currents iterated in phases) with the supply as a positive-sequence EMF
  behind its own sequence impedance, the EMF scaled so the terminal |V1| = 1;
- the transformer zero-sequence rules of IEC 60909-0 §6.3 as fault.py applies
  them (earthing settings authoritative; Z0T = z0_z1_ratio·Z1T);
- the balanced load flow for any network whose loads are all balanced (a
  balanced network has no V2 / V0, so both engines solve the same problem).
"""

import cmath
import math

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.loadflow import run_load_flow
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow

A_OP = cmath.exp(2j * math.pi / 3)
A_MAT = np.array([[1, 1, 1], [1, A_OP ** 2, A_OP], [1, A_OP, A_OP ** 2]], dtype=complex)
A_INV = np.linalg.inv(A_MAT)


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _project(comps, links, base_mva=1.0):
    wires = [Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)
             for k, (a, ap, b, bp) in enumerate(links)]
    return ProjectData(projectName="t", baseMVA=base_mva, frequency=50,
                       components=comps, wires=wires)


def _source_z(kv, base_mva, sk_mva, xr):
    z = (kv ** 2 / sk_mva) / (kv ** 2 / base_mva)
    return complex(z / math.sqrt(1 + xr * xr), z * xr / math.sqrt(1 + xr * xr))


def _supply_bus_reference(zs, z0_ratio, draw):
    """Phase voltages at a supply bus feeding a constant-power load directly.
    ``draw(V)`` → drawn phase currents (p.u., I = 3·conj(S_ph/V_ph))."""
    z_abc = A_MAT @ np.diag([zs * z0_ratio, zs, zs]) @ A_INV
    v = np.array([1, A_OP ** 2, A_OP], dtype=complex)
    for _ in range(1000):
        i = draw(v)
        e1 = 1 + zs * (A_INV @ i)[1]          # terminal V1 held at 1∠0
        v_new = A_MAT @ np.array([0, e1, 0]) - z_abc @ i
        if np.max(np.abs(v_new - v)) < 1e-13:
            return v_new
        v = v_new
    raise AssertionError("reference did not converge")


# ── U1 ───────────────────────────────────────────────────────────────────────

class TestU1SupplySequenceImpedance:
    """The swing bus was forced to V2 = V0 = 0, making the utility an infinite
    negative/zero-sequence sink: the point of supply always read VUF = 0."""

    @pytest.mark.parametrize("z0_ratio", [1.0, 2.0])
    def test_single_phase_load_at_a_weak_supply(self, z0_ratio):
        kv, sk, xr, s_kva = 0.4, 2.0, 3.0, 60
        comps = [_c("u", "utility", voltage_kv=kv, fault_mva=sk, x_r_ratio=xr,
                    z0_z1_ratio=z0_ratio),
                 _c("A", "bus", name="A", voltage_kv=kv),
                 _c("L", "static_load", rated_kva=s_kva, power_factor=0.9,
                    phase_connection="1P-A")]
        res = run_unbalanced_load_flow(_project(
            comps, [("u", "out", "A", "at_0"), ("A", "at_1", "L", "in")]))
        s = s_kva / 1000 * complex(0.9, math.sqrt(1 - 0.81))

        def draw(v):
            i = np.zeros(3, dtype=complex)
            i[0] = 3 * np.conj(s / v[0])
            return i
        v = _supply_bus_reference(_source_z(kv, 1.0, sk, xr), z0_ratio, draw)
        seq = A_INV @ v
        b = res.buses["A"]
        assert b.vuf_pct == pytest.approx(abs(seq[2]) / abs(seq[1]) * 100, rel=1e-4)
        assert b.v0_pu == pytest.approx(abs(seq[0]), rel=1e-4)
        assert b.va_pu == pytest.approx(abs(v[0]), abs=2e-6)
        assert b.vuf_pct > 3.0          # was 0.0

    def test_line_to_line_load(self):
        kv, sk, xr = 0.4, 2.0, 3.0
        comps = [_c("u", "utility", voltage_kv=kv, fault_mva=sk, x_r_ratio=xr),
                 _c("A", "bus", name="A", voltage_kv=kv),
                 _c("L", "static_load", rated_kva=80, power_factor=0.9,
                    phase_connection="2P-AB")]
        res = run_unbalanced_load_flow(_project(
            comps, [("u", "out", "A", "at_0"), ("A", "at_1", "L", "in")]))
        s = 0.08 * complex(0.9, math.sqrt(1 - 0.81))

        def draw(v):
            i = 3 * np.conj(s / (v[0] - v[1]))
            return np.array([i, -i, 0], dtype=complex)
        v = _supply_bus_reference(_source_z(kv, 1.0, sk, xr), 1.0, draw)
        b = res.buses["A"]
        for got, ref in ((b.va_pu, v[0]), (b.vb_pu, v[1]), (b.vc_pu, v[2])):
            assert got == pytest.approx(abs(ref), abs=2e-6)
        assert b.v0_pu == pytest.approx(0.0, abs=1e-9)


# ── U2 ───────────────────────────────────────────────────────────────────────

def _feeder_11kv(extra=(), extra_links=(), util=None, bus_b=None):
    comps = [_c("u", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15, **(util or {})),
             _c("A", "bus", name="A", voltage_kv=11),
             _c("c", "cable", name="c", voltage_kv=11, r_per_km=0.2, x_per_km=0.1,
                length_km=5, rated_amps=400),
             _c("B", "bus", name="B", voltage_kv=11, **(bus_b or {})),
             _c("L", "static_load", rated_kva=3000, power_factor=0.9)]
    links = [("u", "out", "A", "at_0"), ("A", "at_1", "c", "from"),
             ("c", "to", "B", "at_0"), ("B", "at_1", "L", "in")]
    return _project(comps + list(extra), links + list(extra_links), 100.0)


U2_CASES = {
    "vfd": dict(extra=[_c("d", "vfd", rated_kw=1000, efficiency=0.96, load_pct=100,
                          displacement_pf=0.98)], extra_links=[("B", "at_2", "d", "in")]),
    "capacitor_steps": dict(extra=[_c("k", "capacitor_bank", rated_kvar=2000, steps=4,
                                      steps_in_service=1)],
                            extra_links=[("B", "at_2", "k", "in")]),
    "capacitor_constant_z": dict(extra=[_c("k", "capacitor_bank", rated_kvar=2000)],
                                 extra_links=[("B", "at_2", "k", "in")]),
    "utility_setpoint": dict(util={"v_setpoint_pu": 1.05}),
    "thevenin_grid": dict(util={"lf_grid_model": "thevenin"}),
    "svc_regulating": dict(extra=[_c("s", "svc", rated_mvar=3, v_setpoint_pu=1.0)],
                           extra_links=[("B", "at_2", "s", "in")]),
    "pv_label_no_regulator": dict(bus_b={"bus_type": "PV"}),
    "generator_q_limited": dict(
        extra=[_c("g", "generator", rated_mva=5, power_factor=0.85,
                  voltage_setpoint_pu=1.02, dispatch_mode="fixed", p_set_mw=1)],
        extra_links=[("B", "at_2", "g", "out")], bus_b={"bus_type": "PV"}),
}


class TestU2BalancedLimit:
    """With balanced loads, V1 must equal the balanced load flow. Each case is
    one input the balanced engine reads and this one used to ignore (errors
    were 0.03 % … 5 %)."""

    @pytest.mark.parametrize("case", sorted(U2_CASES))
    def test_matches_balanced_load_flow(self, case):
        p = _feeder_11kv(**U2_CASES[case])
        bal = run_load_flow(p)
        unb = run_unbalanced_load_flow(p)
        assert bal.converged and unb.converged
        for bid in ("A", "B"):
            assert unb.buses[bid].v1_pu == pytest.approx(bal.buses[bid].voltage_pu, abs=2e-6)
            assert unb.buses[bid].vuf_pct == pytest.approx(0.0, abs=1e-3)

    def test_thevenin_internals_not_reported(self):
        res = run_unbalanced_load_flow(_feeder_11kv(util={"lf_grid_model": "thevenin"}))
        assert sorted(res.buses) == ["A", "B"]
        assert all(not br.elementId.startswith("__gridz__") for br in res.branches)


# ── U3 ───────────────────────────────────────────────────────────────────────

BASE = 1.0
Z1T = complex(0.1 / math.sqrt(26), 0.1 * 5 / math.sqrt(26))   # 5 % on 0.5 MVA, X/R 5, 1 MVA base
ZB_LV = 0.4 ** 2 / BASE


def _lv_case(xprops, cable=None):
    comps = [_c("u", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15),
             _c("M", "bus", name="M", voltage_kv=11),
             _c("t", "transformer", name="t", rated_mva=0.5, z_percent=5, x_r_ratio=5,
                voltage_hv_kv=11, voltage_lv_kv=0.4, **xprops),
             _c("B", "bus", name="B", voltage_kv=0.4),
             _c("L", "static_load", rated_kva=50, power_factor=1.0, phase_connection="1P-A")]
    links = [("u", "out", "M", "at_0"), ("M", "at_1", "t", "primary")]
    if cable:
        comps.append(_c("c", "cable", name="c", voltage_kv=0.4, rated_amps=300, **cable))
        links += [("t", "secondary", "c", "from"), ("c", "to", "B", "at_0")]
    else:
        links += [("t", "secondary", "B", "at_0")]
    links.append(("B", "at_1", "L", "in"))
    return run_unbalanced_load_flow(_project(comps, links, BASE)).buses["B"]


def _v0_expected(b, z0_shunt):
    """V0 = Z0_shunt·I0 for the 1P load's current at the reported Va."""
    va = b.va_pu * cmath.exp(1j * math.radians(b.angle_a_deg))
    i = np.zeros(3, dtype=complex)
    i[0] = -3 * np.conj(0.05 / va)
    return abs(z0_shunt * (A_INV @ i)[0])


class TestU3TransformerZeroSequence:
    """Transformer Z0 was read from the vector-group letters, not the earthing
    settings, and summed in dict order."""

    def test_z0_z1_ratio_applies(self):           # was +17.6 %
        b = _lv_case(dict(vector_group="Dyn11", z0_z1_ratio=0.85))
        assert b.v0_pu == pytest.approx(_v0_expected(b, 0.85 * Z1T), rel=5e-4)

    def test_yny_default_hv_earthing_is_single_earthed(self):   # was −92 %
        # YNyn0 with grounding_hv at its shipped default 'ungrounded': no
        # through path; the earthed LV neutral sources I0 through Z0T + Z0m
        # (three-limb, 0.6 p.u. on the 0.5 MVA unit, X/R 5).
        b = _lv_case(dict(vector_group="YNyn0", grounding_hv="ungrounded",
                          grounding_lv="solidly_grounded"))
        z0m = complex(1.2 / 5, 1.2)
        assert b.v0_pu == pytest.approx(_v0_expected(b, Z1T + z0m), rel=5e-4)

    def test_cable_after_dyn_is_in_the_earth_path(self):   # was −77 %
        r0, x0, km = 1.2, 0.3, 0.05
        b = _lv_case(dict(vector_group="Dyn11"),
                     cable=dict(r_per_km=0.3, x_per_km=0.08, r0_per_km=r0,
                                x0_per_km=x0, length_km=km))
        z_sh = Z1T + complex(r0, x0) * km / ZB_LV
        assert b.v0_pu == pytest.approx(_v0_expected(b, z_sh), rel=5e-4)


# ── U4 ───────────────────────────────────────────────────────────────────────

class TestU4MachineZeroSequence:
    def test_synchronous_motor_adds_no_earth(self):       # V0 moved −11.7 %
        def run(with_motor):
            comps = [_c("u", "utility", voltage_kv=11, fault_mva=500, x_r_ratio=15),
                     _c("M", "bus", name="M", voltage_kv=11),
                     _c("t", "transformer", name="t", rated_mva=0.5, z_percent=5,
                        x_r_ratio=5, voltage_hv_kv=11, voltage_lv_kv=0.4,
                        vector_group="Dyn11"),
                     _c("B", "bus", name="B", voltage_kv=0.4),
                     _c("L", "static_load", rated_kva=50, power_factor=1.0,
                        phase_connection="1P-A")]
            links = [("u", "out", "M", "at_0"), ("M", "at_1", "t", "primary"),
                     ("t", "secondary", "B", "at_0"), ("B", "at_1", "L", "in")]
            if with_motor:
                comps.append(_c("m", "motor_synchronous", rated_kva=200,
                                power_factor=0.9, demand_factor=0.0001))
                links.append(("B", "at_2", "m", "in"))
            return run_unbalanced_load_flow(_project(comps, links, BASE)).buses["B"]
        assert run(True).v0_pu == pytest.approx(run(False).v0_pu, rel=5e-4)

    def test_unearthed_generator_has_no_zero_sequence(self):
        def run(grounding):
            comps = [_c("g", "generator", rated_mva=1, power_factor=0.85, xd_pp=0.15,
                        grounding=grounding, voltage_kv=0.4),
                     _c("A", "bus", name="A", voltage_kv=0.4, bus_type="Swing"),
                     _c("L", "static_load", rated_kva=50, power_factor=1.0,
                        phase_connection="1P-A")]
            return run_unbalanced_load_flow(_project(
                comps, [("g", "out", "A", "at_0"), ("A", "at_1", "L", "in")])).buses["A"]
        assert run("solidly").v0_pu > 1e-4
        assert run("ungrounded").v0_pu == pytest.approx(0.0, abs=1e-12)


# ── U5 ───────────────────────────────────────────────────────────────────────

class TestU5PerPhasePower:
    def test_single_phase_load_reported_on_its_phase(self):   # was 0 / 0 / 0
        comps = [_c("u", "utility", voltage_kv=0.4, fault_mva=50, x_r_ratio=5),
                 _c("B", "bus", name="B", voltage_kv=0.4),
                 _c("L", "static_load", rated_kva=50, power_factor=1.0,
                    phase_connection="1P-A")]
        b = run_unbalanced_load_flow(_project(
            comps, [("u", "out", "B", "at_0"), ("B", "at_1", "L", "in")])).buses["B"]
        assert b.pa_mw == pytest.approx(-0.05, abs=1e-4)
        assert b.pb_mw == pytest.approx(0.0, abs=1e-6)
        assert b.pc_mw == pytest.approx(0.0, abs=1e-6)


# ── U6 ───────────────────────────────────────────────────────────────────────

class TestU6VufLimitByVoltage:
    @pytest.mark.parametrize("kv,limit", [(0.4, 2.0), (11.0, 1.8), (132.0, 1.4)])
    def test_limit(self, kv, limit):
        from backend.analysis.unbalanced_loadflow import _vuf_limit
        assert _vuf_limit(kv)[0] == limit
