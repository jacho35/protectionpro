"""Regression pins for the 2026-07 independent calculation verification fixes.

Each test anchors a P1/P2 finding from CALC_VERIFICATION_2026-07-19.md to a
hand calculation, so the fixed behaviour is pinned the same way the rest of
the suite pins the engines. Finding IDs (PS-* protection specialist,
EE-* senior electrical engineer) refer to that document.
"""

import math

import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.arcflash import calc_incident_energy
from backend.analysis.motor_starting import run_motor_starting
from backend.analysis.loadflow import run_load_flow
from backend.analysis.contingency import run_contingency
from backend.analysis.voltage_stability import run_voltage_stability


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires, base_mva=100.0):
    return ProjectData(projectName="verify-fix", baseMVA=base_mva, frequency=50,
                       components=components, wires=wires)


# ── PS-1: parallel-path fault impedance (nodal Thevenin) ─────────────────────


class TestPS1ParallelPaths:
    """Two identical parallel feeders sharing one utility.

    Hand calculation (base 100 MVA, 11 kV):
      Z_Q = 1.1·100/500 ∠(X/R = 10) = 0.021890 + j0.218905 pu
      Z_c = (0.2 + j0.1) Ω / (11²/100) = 0.165289 + j0.082645 pu
      Z_eq = Z_Q + Z_c/2  →  Ik″ = 1.1/|Z_eq| × 100/(√3·11) = 20.587 kA
    Paralleling the two path totals instead gives (Z_Q+Z_c)/2 → 32.534 kA
    (+58 %), the pre-fix defect.
    """

    def _parallel_project(self):
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2, "x_per_km": 0.1,
                                  "length_km": 1.0, "voltage_kv": 11.0}),
            _comp("c2", "cable", {"name": "C2", "r_per_km": 0.2, "x_per_km": 0.1,
                                  "length_km": 1.0, "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busA", "c2"), _wire("w5", "c2", "busB"),
        ])

    def test_parallel_feeders_hand_value(self):
        res = run_fault_analysis(self._parallel_project())
        b = res.buses["busB"]
        xr = 10.0
        zq_mag = 1.1 * 100.0 / 500.0
        zq = complex(zq_mag / math.sqrt(1 + xr * xr), zq_mag * xr / math.sqrt(1 + xr * xr))
        zc = complex(0.2, 0.1) / (11.0 ** 2 / 100.0)
        ik_hand = 1.1 / abs(zq + zc / 2) * (100.0 / (math.sqrt(3) * 11.0))
        assert b.ik3 == pytest.approx(ik_hand, rel=1e-3)
        assert b.ik3 < 25.0, "per-path parallel combination (32.5 kA) has crept back"
        assert b.network_topology == "meshed"
        # Ib must not exceed Ik'' for a utility-only network (μ = 1)
        assert b.ib == pytest.approx(b.ik3, rel=1e-3)

    def test_source_bus_stays_radial(self):
        res = run_fault_analysis(self._parallel_project())
        assert res.buses["busA"].network_topology == "radial"

    def test_ps5_meshed_peak_factor(self):
        """[PS-5] meshed ip = min(1.15·κ(R/X), 2.0)·√2·Ik″ (HV cap 2.0)."""
        res = run_fault_analysis(self._parallel_project())
        b = res.buses["busB"]
        xr = 10.0
        zq_mag = 1.1 * 100.0 / 500.0
        zq = complex(zq_mag / math.sqrt(1 + xr * xr), zq_mag * xr / math.sqrt(1 + xr * xr))
        zc = complex(0.2, 0.1) / (11.0 ** 2 / 100.0)
        z_eq = zq + zc / 2
        kappa = 1.02 + 0.98 * math.exp(-3 * z_eq.real / z_eq.imag)
        kappa_b = min(1.15 * kappa, 2.0)
        assert b.kappa == pytest.approx(kappa_b, abs=2e-3)
        assert b.ip == pytest.approx(kappa_b * math.sqrt(2) * b.ik3, rel=2e-3)

    def test_radial_network_unchanged(self):
        """Radial control: single feeder — exact legacy arithmetic."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2, "x_per_km": 0.1,
                                  "length_km": 1.0, "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
        ])
        res = run_fault_analysis(proj)
        b = res.buses["busB"]
        xr = 10.0
        zq_mag = 1.1 * 100.0 / 500.0
        zq = complex(zq_mag / math.sqrt(1 + xr * xr), zq_mag * xr / math.sqrt(1 + xr * xr))
        zc = complex(0.2, 0.1) / (11.0 ** 2 / 100.0)
        ik_hand = 1.1 / abs(zq + zc) * (100.0 / (math.sqrt(3) * 11.0))
        assert b.ik3 == pytest.approx(ik_hand, abs=2e-3)
        assert b.network_topology == "radial"


# ── PS-2: machine/inverter zero-sequence gating ──────────────────────────────


class TestPS2ZeroSequenceGating:
    def _gen_project(self, grounding=None):
        props = {"name": "G1", "rated_mva": 10.0, "xd_pp": 0.15, "x_r_ratio": 40.0,
                 "voltage_kv": 11.0, "power_factor": 0.85}
        if grounding:
            props["grounding"] = grounding
        return _project(
            [_comp("g1", "generator", props),
             _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0})],
            [_wire("w1", "g1", "busA")])

    def test_ungrounded_generator_no_earth_fault(self):
        res = run_fault_analysis(self._gen_project("ungrounded"))
        assert res.buses["busA"].ik1 == 0.0

    def test_default_generator_still_sources_earth_fault(self):
        """Legacy parity: absent prop ⇒ solidly earthed (prior behaviour)."""
        res = run_fault_analysis(self._gen_project())
        assert res.buses["busA"].ik1 > 0

    def test_ps6_generator_kg_correction(self):
        """[PS-6] IEC 60909-0 §6.6.1 Eq. 18: K_G = c_max/(1 + x″d·sinφ).

        x″d = 0.15 on 10 MVA → 1.5 pu on 100 MVA base; pf 0.85 →
        K_G = 1.10/(1 + 0.15·0.5268) = 1.0194;
        Ik″ = 1.1/(1.0194·|1.5/40 + j1.5|) × 100/(√3·11) = 3.774 kA.
        """
        res = run_fault_analysis(self._gen_project())
        sin_phi = math.sqrt(1 - 0.85 ** 2)
        k_g = 1.10 / (1 + 0.15 * sin_phi)
        z = complex(1.5 / 40.0, 1.5) * k_g
        ik_hand = 1.1 / abs(z) * (100.0 / (math.sqrt(3) * 11.0))
        assert res.buses["busA"].ik3 == pytest.approx(ik_hand, abs=2e-3)

    def test_pv_inverter_no_earth_fault_by_default(self):
        proj = _project(
            [_comp("pv1", "solar_pv", {"name": "PV", "rated_kw": 1000.0,
                                       "num_inverters": 1, "voltage_kv": 0.4,
                                       "fault_contribution_pu": 1.1,
                                       "inverter_eff": 0.97}),
             _comp("busA", "bus", {"name": "A", "voltage_kv": 0.4})],
            [_wire("w1", "pv1", "busA")])
        res = run_fault_analysis(proj)
        b = res.buses["busA"]
        assert b.ik1 == 0.0, "inverter Z0 must be blocked by default"
        assert b.ik3 > 0, "positive-sequence contribution must remain"


# ── PS-3: minimum-current study mode ─────────────────────────────────────────


class TestPS3MinimumCurrentMode:
    def test_min_mode_reduces_ik1(self):
        """c_min/c_max = 0.864 before the hot-conductor term; with 70 °C cable
        resistance (+20 %) the LV-feeder Ik1 falls further."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("b0", "bus", {"name": "MV", "voltage_kv": 11.0}),
            _comp("t1", "transformer", {"name": "T1", "rated_mva": 1.0,
                                        "z_percent": 5.0, "x_r_ratio": 8.0,
                                        "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                                        "vector_group": "Dyn11",
                                        "grounding_lv": "solidly_grounded"}),
            _comp("b1", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.5, "x_per_km": 0.08,
                                  "length_km": 0.1, "r0_per_km": 2.0,
                                  "x0_per_km": 0.3, "voltage_kv": 0.4}),
            _comp("b2", "bus", {"name": "SubDB", "voltage_kv": 0.4}),
        ], [
            _wire("w1", "u1", "b0"), _wire("w2", "b0", "t1"),
            _wire("w3", "t1", "b1"), _wire("w4", "b1", "c1"),
            _wire("w5", "c1", "b2"),
        ])
        rmax = run_fault_analysis(proj)
        rmin = run_fault_analysis(proj, voltage_factor=0.95,
                                  conductor_temperature_c=70.0)
        ik1_max = rmax.buses["b2"].ik1
        ik1_min = rmin.buses["b2"].ik1
        assert ik1_min < ik1_max * (0.95 / 1.10) + 1e-6
        # temperature must contribute beyond the voltage-factor ratio alone
        r_only = run_fault_analysis(proj, voltage_factor=0.95)
        assert ik1_min < r_only.buses["b2"].ik1

    def test_default_call_unchanged(self):
        """Omitting the new parameter must not alter any result."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 15.0, "voltage_kv": 11.0}),
            _comp("b1", "bus", {"name": "B1", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "b1")])
        r1 = run_fault_analysis(proj)
        r2 = run_fault_analysis(proj, conductor_temperature_c=None)
        assert r1.buses["b1"].ik3 == r2.buses["b1"].ik3


# ── PS-4: arc flash distance exponent for the cable class ────────────────────


class TestPS4CableDistanceExponent:
    def test_cable_class_x_is_2(self):
        """IEEE 1584-2002 Table 4: cables x = 2.000 (13 mm gap).

        Hand: lg En = −0.555 + 1.081·lg(13.508) + 0.0011·13 → En;
        E = 1.5·En·(610/455)² = 12.948 cal/cm² (ungrounded, 0.2 s).
        """
        en = 10 ** (-0.555 + 1.081 * math.log10(13.508) + 0.0011 * 13)
        hand = 1.5 * en * (610.0 / 455.0) ** 2.0
        via_class = calc_incident_energy(13.508, 0.48, 0.2, 13, 455, "VCB", 508,
                                         False, equipment_class="lv_cable")
        via_gap = calc_incident_energy(13.508, 0.48, 0.2, 13, 455, "VCB", 508, False)
        assert via_class == pytest.approx(hand, rel=1e-3)
        assert via_gap == pytest.approx(hand, rel=1e-3)

    def test_switchgear_class_unchanged(self):
        """The 2026-07 review's digit-perfect switchgear anchor (11.642)."""
        e = calc_incident_energy(13.508, 0.48, 0.2, 32, 455, "VCB", 508, False)
        assert e == pytest.approx(11.642, abs=5e-3)


# ── EE-1/EE-5/EE-12: static motor-starting cluster ───────────────────────────


_MOTOR = {"name": "M1", "rated_kw": 200.0, "voltage_kv": 0.4, "efficiency": 0.93,
          "power_factor": 0.85, "locked_rotor_current": 6.5,
          "starting_method": "dol"}


class TestMotorStartingSourceImpedance:
    def _tx_project(self, motor_extra=None):
        props = dict(_MOTOR)
        if motor_extra:
            props.update(motor_extra)
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 20.0,
                                    "x_r_ratio": 5.0, "voltage_kv": 11.0}),
            _comp("b0", "bus", {"name": "MV", "voltage_kv": 11.0}),
            _comp("t1", "transformer", {"name": "T1", "rated_mva": 1.0,
                                        "z_percent": 5.0, "x_r_ratio": 8.0,
                                        "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                                        "vector_group": "Dyn11"}),
            _comp("b1", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _comp("m1", "motor_induction", props),
        ], [
            _wire("w1", "u1", "b0"), _wire("w2", "b0", "t1"),
            _wire("w3", "t1", "b1"), _wire("w4", "b1", "m1"),
        ])

    def test_ee1_source_impedance_included(self):
        """[EE-1] Motor directly on a weak (20 MVA) utility bus: the ideal-swing
        load flow reported dip = 0 %; the Thevenin superposition gives ≈9 %
        (hand: S_start = 1.62 MVA at pf 0.3 behind Z_th = 100/20 pu ∠78.7°)."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 20.0,
                                    "x_r_ratio": 5.0, "voltage_kv": 0.4}),
            _comp("b1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            _comp("m1", "motor_induction", dict(_MOTOR)),
        ], [_wire("w1", "u1", "b1"), _wire("w2", "b1", "m1")])
        r = run_motor_starting(proj)["motors"][0]
        assert 0.88 < r["motor_terminal_voltage_pu"] < 0.94
        assert r["max_system_dip_pct"] > 5.0

    def test_ee1_weak_transformer_start_fails(self):
        """[EE-1] 200 kW DOL start behind a 1 MVA/5 % TX on a 20 MVA grid is at/
        below the 0.80 p.u. accept threshold — previously reported 0.913/pass."""
        r = run_motor_starting(self._tx_project())["motors"][0]
        assert r["motor_terminal_voltage_pu"] < 0.85
        assert not r["motor_will_start"]

    def test_ee5_demand_factor_does_not_scale_locked_rotor(self):
        r_full = run_motor_starting(self._tx_project())["motors"][0]
        r_half = run_motor_starting(self._tx_project({"demand_factor": 0.5}))["motors"][0]
        assert r_half["motor_terminal_voltage_pu"] == pytest.approx(
            r_full["motor_terminal_voltage_pu"], abs=0.02)

    def test_ee12_distribution_board_terminal_found(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 20.0,
                                    "x_r_ratio": 5.0, "voltage_kv": 0.4}),
            _comp("db1", "distribution_board", {"name": "DB1", "voltage_kv": 0.4,
                                                "rated_kva": 0}),
            _comp("m1", "motor_induction", dict(_MOTOR)),
        ], [_wire("w1", "u1", "db1"), _wire("w2", "db1", "m1")])
        r = run_motor_starting(proj)["motors"][0]
        assert r["terminal_bus"], "distribution board must be a motor terminal"
        assert r["motor_terminal_voltage_pu"] < 0.95


# ── EE-2: cascaded transformers in one branch chain ──────────────────────────


class TestCascadedTransformerChain:
    def _cascade(self, with_mid_bus):
        comps = [
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 5000.0,
                                    "x_r_ratio": 15.0, "voltage_kv": 33.0}),
            _comp("b33", "bus", {"name": "B33", "voltage_kv": 33.0}),
            _comp("t1", "transformer", {"name": "T1", "rated_mva": 20.0,
                                        "z_percent": 10.0, "x_r_ratio": 20.0,
                                        "voltage_hv_kv": 33.0, "voltage_lv_kv": 11.0,
                                        "vector_group": "Dyn11"}),
            _comp("t2", "transformer", {"name": "T2", "rated_mva": 20.0,
                                        "z_percent": 10.0, "x_r_ratio": 20.0,
                                        "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                                        "vector_group": "Dyn11"}),
            _comp("b04", "bus", {"name": "B04", "voltage_kv": 0.4}),
            _comp("l1", "static_load", {"name": "L1", "rated_kva": 1000.0,
                                        "power_factor": 0.9, "demand_factor": 1.0}),
        ]
        wires = [_wire("w1", "u1", "b33"), _wire("w2", "b33", "t1"),
                 _wire("w5", "b04", "l1")]
        if with_mid_bus:
            comps.insert(4, _comp("b11", "bus", {"name": "B11", "voltage_kv": 11.0}))
            wires += [_wire("w3", "t1", "b11"), _wire("w3b", "b11", "t2"),
                      _wire("w4", "t2", "b04")]
        else:
            wires += [_wire("w3", "t1", "t2"), _wire("w4", "t2", "b04")]
        return _project(comps, wires)

    def test_cascade_matches_explicit_bus_model(self):
        r_chain = run_load_flow(self._cascade(False), "newton_raphson")
        r_bus = run_load_flow(self._cascade(True), "newton_raphson")
        v_chain = r_chain.buses["b04"].voltage_pu
        v_bus = r_bus.buses["b04"].voltage_pu
        assert v_chain > 0.9, "cascaded-chain garbage solution (0.0003 p.u.) is back"
        assert v_chain == pytest.approx(v_bus, abs=5e-3)

    def test_cascade_emits_modelling_warning(self):
        r = run_load_flow(self._cascade(False), "newton_raphson")
        assert any("cascaded transformers" in w.message.lower() for w in r.warnings)


# ── EE-3: series-chain loss apportioning ─────────────────────────────────────


class TestChainLossApportioning:
    def _feeder(self, split):
        cables = ([_comp("c1", "cable", {"name": "C1", "r_per_km": 0.3,
                                         "x_per_km": 0.1, "length_km": 5.0,
                                         "voltage_kv": 11.0})]
                  if not split else
                  [_comp("c1", "cable", {"name": "C1", "r_per_km": 0.3,
                                         "x_per_km": 0.1, "length_km": 2.5,
                                         "voltage_kv": 11.0}),
                   _comp("c2", "cable", {"name": "C2", "r_per_km": 0.3,
                                         "x_per_km": 0.1, "length_km": 2.5,
                                         "voltage_kv": 11.0})])
        comps = [
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 5000.0,
                                    "x_r_ratio": 15.0, "voltage_kv": 11.0}),
            _comp("bA", "bus", {"name": "A", "voltage_kv": 11.0}),
            *cables,
            _comp("bB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("l1", "static_load", {"name": "L1", "rated_kva": 5000.0,
                                        "power_factor": 0.85, "demand_factor": 1.0}),
        ]
        if not split:
            wires = [_wire("w1", "u1", "bA"), _wire("w2", "bA", "c1"),
                     _wire("w3", "c1", "bB"), _wire("w4", "bB", "l1")]
        else:
            wires = [_wire("w1", "u1", "bA"), _wire("w2", "bA", "c1"),
                     _wire("w3", "c1", "c2"), _wire("w3b", "c2", "bB"),
                     _wire("w4", "bB", "l1")]
        return _project(comps, wires)

    def test_split_chain_rows_sum_to_true_loss(self):
        whole = run_load_flow(self._feeder(False), "newton_raphson")
        split = run_load_flow(self._feeder(True), "newton_raphson")
        tot_whole = sum(br.losses_mw for br in whole.branches)
        tot_split = sum(br.losses_mw for br in split.branches)
        assert tot_split == pytest.approx(tot_whole, abs=1e-4), \
            "series-chain rows double-count losses again"


# ── EE-4: contingency loss-of-supply for dangling loads ──────────────────────


class TestContingencyDanglingLoad:
    def test_dangling_load_outages_are_counted(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 15.0, "voltage_kv": 11.0}),
            _comp("b1", "bus", {"name": "B1", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2, "x_per_km": 0.08,
                                  "length_km": 1.0, "voltage_kv": 11.0}),
            _comp("l1", "static_load", {"name": "L1", "rated_kva": 5000.0,
                                        "power_factor": 0.85, "demand_factor": 1.0}),
        ], [_wire("w1", "u1", "b1"), _wire("w2", "b1", "c1"), _wire("w3", "c1", "l1")])
        res = run_contingency(proj)
        grid = next(c for c in res.contingencies if "Grid" in c.label)
        cable = next(c for c in res.contingencies if "C1" in c.label)
        # 5 MVA × 0.85 = 4.25 MW served to the dangling load
        assert grid.lost_load_mw == pytest.approx(4.25, abs=0.01)
        assert cable.status != "secure", \
            "outaging the sole feeder to a dangling load reported SECURE again"
        assert cable.lost_load_mw == pytest.approx(4.25, abs=0.01)
        assert not res.n_minus_1_secure


# ── EE-6: voltage stability false-collapse flag ──────────────────────────────


class TestVoltageStabilityCollapseFlag:
    def test_sweep_overshoot_is_not_collapse(self):
        """Stiff network, step 0.35 with λ_max 4.0 (never lands on 4.0):
        previously reported collapsed=True with the weakest bus at 1.000 p.u."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 100000.0,
                                    "x_r_ratio": 15.0, "voltage_kv": 11.0}),
            _comp("b1", "bus", {"name": "B1", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.001, "x_per_km": 0.001,
                                  "length_km": 0.1, "voltage_kv": 11.0}),
            _comp("b2", "bus", {"name": "B2", "voltage_kv": 11.0}),
            _comp("l1", "static_load", {"name": "L1", "rated_kva": 1000.0,
                                        "power_factor": 0.9, "demand_factor": 1.0}),
        ], [_wire("w1", "u1", "b1"), _wire("w2", "b1", "c1"),
            _wire("w3", "c1", "b2"), _wire("w4", "b2", "l1")])
        res = run_voltage_stability(proj, step=0.35, lambda_max=4.0)
        assert res.collapsed is False
        assert "lower bound" in res.note
