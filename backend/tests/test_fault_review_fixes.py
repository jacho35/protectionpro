"""Regression tests for the 2026-09-28 fault-engine review (FAULT_ENGINE_REVIEW.md).

Each test reproduces the ORIGINAL defect against an independent reference
(hand network reduction or a phase-domain solve), never against the engine's
own earlier output. Finding IDs F1–F9 match the review document.
"""

import cmath
import math
import types

import numpy as np
import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import fault as F


C_MAX = 1.1
BASE = 100.0


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


class _Wires:
    def __init__(self):
        self.n = 0
        self.items = []

    def add(self, a, b, fp="bottom", tp="top"):
        self.n += 1
        self.items.append(Wire(id=f"w{self.n}", fromComponent=a, fromPort=fp,
                               toComponent=b, toPort=tp))
        return self


def _project(comps, wires):
    return ProjectData(projectName="t", baseMVA=BASE, frequency=50,
                       components=comps, wires=wires.items)


def _par(a, b):
    return a * b / (a + b)


# ── F1 ───────────────────────────────────────────────────────────────────


class TestF1SimultaneousCouplingSign:
    """[F1] The series-port current leaves the branch-removed network at
    bus_up and re-enters at bus_down, so a shunt bus on the LOAD side couples
    with −Z_down,P, not +Z_down,P. Only visible with prefault current.

    Reference: Z0 = Z1 = Z2 everywhere and no mutual coupling, so the three
    phases are independent single-phase networks, solved nodally. Source EMFs
    are chosen so the intact network carries I_L (real) through the branch
    and the branch-removed open-circuit voltage at the shunt bus is c — the
    engine's own driving-source convention — so only the coupling is tested.
    """

    KV = 11.0
    IL_PU = 0.4

    def _net(self, side):
        cab = lambda cid, r, x: _c(cid, "cable", r_per_km=r, x_per_km=x,
                                    r0_per_km=r, x0_per_km=x, length_km=1)
        comps = [
            _c("u", "utility", fault_mva=200, x_r_ratio=10, voltage_kv=self.KV,
               z0_z1_ratio=1, grounding="solidly"),
            _c("A", "bus", voltage_kv=self.KV), cab("K", 0.4, 0.3),
            _c("B", "bus", voltage_kv=self.KV),
            _c("g", "generator", rated_mva=5, xd_pp=0.15, voltage_kv=self.KV,
               x_r_ratio=20, grounding="solidly"),
            cab("L", 0.3, 0.2), _c("PB", "bus", voltage_kv=self.KV),
        ]
        w = _Wires().add("u", "A").add("A", "K").add("K", "B").add("g", "B")
        w.add("B" if side == "down" else "A", "L").add("L", "PB")
        return _project(comps, w)

    def _reference(self, proj, side, series, shunt):
        zb = self.KV ** 2 / BASE
        comps = {x.id: x for x in proj.components}
        zu = F._utility_impedance(comps["u"], BASE, C_MAX)
        zg = F._generator_impedance(comps["g"], BASE, self.KV)
        zk, zl = complex(0.4, 0.3) / zb, complex(0.3, 0.2) / zb
        if side == "up":
            ea, eb = C_MAX, C_MAX - self.IL_PU * (zu + zk + zg)
        else:
            eb, ea = C_MAX, C_MAX + self.IL_PU * (zu + zk + zg)
        open_ph = {"open_conductor": [0], "two_conductor_open": [1, 2]}[series]
        faulted = {"3phase": [0, 1, 2], "slg": [0]}[shunt]
        a = cmath.exp(2j * math.pi / 3)
        rot = [1, a * a, a]
        ip, ik = [], []
        for p in range(3):
            y = np.zeros((3, 3), complex)
            i = np.zeros(3, complex)

            def br(n1, n2, z):
                yy = 1 / z
                y[n1, n1] += yy; y[n2, n2] += yy; y[n1, n2] -= yy; y[n2, n1] -= yy
            y[0, 0] += 1 / zu; i[0] += ea * rot[p] / zu
            y[1, 1] += 1 / zg; i[1] += eb * rot[p] / zg
            if p not in open_ph:
                br(0, 1, zk)
            up = 1 if side == "down" else 0
            br(up, 2, zl)
            if p in faulted:
                y[2, :] = 0; y[2, 2] = 1; i[2] = 0
            v = np.linalg.solve(y, i)
            ip.append(abs((v[up] - v[2]) / zl))
            ik.append(abs((v[0] - v[1]) / zk) if p not in open_ph else 0.0)
        ibase = BASE / (math.sqrt(3) * self.KV)
        return [x * ibase for x in ip], [x * ibase for x in ik]

    @pytest.mark.parametrize("side", ["up", "down"])
    @pytest.mark.parametrize("series", ["open_conductor", "two_conductor_open"])
    @pytest.mark.parametrize("shunt", ["3phase", "slg"])
    def test_matches_phase_domain(self, monkeypatch, side, series, shunt):
        ibase = BASE / (math.sqrt(3) * self.KV)
        # The reference needs Z0 = Z1 at every element. The generator used to
        # get that from its no-x0 fallback; [MG4] made that fallback 0.5·Z1
        # (typical machine X0), so pin the assumption here explicitly.
        monkeypatch.setattr(F, "GEN_Z0_Z1_DEFAULT", 1.0)
        import backend.analysis.loadflow as lf
        monkeypatch.setattr(lf, "run_load_flow", lambda *a, **k: types.SimpleNamespace(
            converged=True,
            branches=[types.SimpleNamespace(elementId="K", i_amps=self.IL_PU * ibase * 1000)]))
        proj = self._net(side)
        r = F.run_simultaneous_fault_analysis(proj, "K", series, "PB", shunt)
        ip, ik = self._reference(proj, side, series, shunt)
        assert r.ipa_ka == pytest.approx(ip[0], rel=1e-3)
        if series == "open_conductor":
            assert r.ib_ka == pytest.approx(ik[1], rel=1e-3, abs=1e-4)
        else:
            # pre-fix: 7.711 vs 9.392 kA on the load side (−17.9 %)
            assert r.ia_ka == pytest.approx(ik[0], rel=1e-3)


# ── F3 ───────────────────────────────────────────────────────────────────


class TestF3BoardOwnRotatingLoad:
    """[F3] A faulted distribution board's own motor fraction feeds the fault
    through zero series impedance. Hand reduction:
    Z = (ZQ + Zc) ‖ ZM,  ZM = (1/LRC)·S_base/(motor_fraction·S_board)."""

    def _net(self):
        comps = [
            _c("u", "utility", fault_mva=20, x_r_ratio=10, voltage_kv=0.4),
            _c("b1", "bus", voltage_kv=0.4),
            _c("cb1", "cable", r_per_km=0.2, x_per_km=0.08, length_km=0.1),
            _c("db", "distribution_board", voltage_kv=0.4, rated_kva=500,
               motor_fraction=0.5, motor_lrc_ratio=6, x_r_ratio=10),
        ]
        w = _Wires().add("u", "b1").add("b1", "cb1").add("cb1", "db", "bottom", "in")
        return _project(comps, w)

    def test_board_fault_includes_own_motors(self):
        kv = 0.4
        zb = kv ** 2 / BASE
        zq = C_MAX * BASE / 20
        zq = complex(zq / math.hypot(1, 10), zq * 10 / math.hypot(1, 10))
        zc = complex(0.02, 0.008) / zb
        xm = (1 / 6) * BASE / 0.25
        zm = complex(xm / 10, xm)
        expected = C_MAX / abs(_par(zq + zc, zm)) * BASE / (math.sqrt(3) * kv)
        r = F.run_fault_analysis(self._net()).buses["db"]
        # pre-fix: 9.490 kA (grid only) vs 11.277 kA
        assert r.ik3 == pytest.approx(expected, rel=1e-3)
        assert r.motor_count == 1

    def test_dead_board_motors_do_not_contribute(self):
        proj = self._net()
        comps = list(proj.components) + [_c("cbo", "cb", state="open")]
        w = _Wires().add("u", "b1").add("b1", "cbo").add("cbo", "cb1").add("cb1", "db", "bottom", "in")
        r = F.run_fault_analysis(_project(comps, w)).buses["db"]
        assert r.ik3 == 0


# ── F4 ───────────────────────────────────────────────────────────────────


class TestF4VoltageDepressionUnsourcedIsland:
    """[F4] A spare (unsourced) bus made the single project-wide Ybus
    singular and every bus lost its voltage-depression table, silently.
    Invariant: adding a disconnected, sourceless bus must not change any
    other bus's retained voltage."""

    def _net(self, spare):
        comps = [
            _c("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=11),
            _c("b1", "bus", voltage_kv=11),
            _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8,
               voltage_hv_kv=11, voltage_lv_kv=0.42, vector_group="Dyn11",
               grounding_hv="ungrounded", grounding_lv="solidly_grounded"),
            _c("b2", "bus", voltage_kv=0.4),
        ]
        w = _Wires().add("u", "b1").add("b1", "t", "bottom", "primary").add("t", "b2", "secondary", "top")
        if spare:
            comps.append(_c("spare", "bus", voltage_kv=0.4))
        return _project(comps, w)

    def test_spare_bus_does_not_erase_table(self):
        ref = F.run_fault_analysis(self._net(False)).buses["b2"].voltage_depression
        got = F.run_fault_analysis(self._net(True)).buses["b2"].voltage_depression
        assert got is not None  # pre-fix: None
        for bid in ("b1", "b2"):
            assert got[bid]["subtransient_pu"] == pytest.approx(ref[bid]["subtransient_pu"])
        assert "spare" not in got  # a dead bus has no voltage to retain


# ── F2 ───────────────────────────────────────────────────────────────────


class TestF2BuslessTee:
    """[F2] Three cables meeting on one breaker terminal (no bus), motor
    behind one leg. The shared leg sends the solve down the nodal path,
    which used to stamp each PAIR of tee legs as a bus-to-bus branch.
    Hand reduction at b2: Z = Z2 + (ZQ + Z1) ‖ (Z3 + ZM)."""

    def test_teed_bus_fault_level(self):
        kv = 11.0
        zb = kv ** 2 / BASE
        cab = lambda cid, r, x: _c(cid, "cable", r_per_km=r, x_per_km=x, length_km=1)
        comps = [
            _c("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=kv),
            _c("b1", "bus", voltage_kv=kv), cab("c1", 0.3, 0.2),
            _c("tee", "cb", state="closed"), cab("c2", 0.4, 0.25),
            _c("b2", "bus", voltage_kv=kv), cab("c3", 0.5, 0.3),
            _c("b3", "bus", voltage_kv=kv),
            _c("m", "motor_induction", rated_kw=2000, efficiency=0.95,
               power_factor=0.9, x_pp=0.17, x_r_ratio=10),
        ]
        w = (_Wires().add("u", "b1").add("b1", "c1").add("c1", "tee").add("tee", "c2")
             .add("c2", "b2").add("tee", "c3").add("c3", "b3").add("b3", "m"))
        proj = _project(comps, w)
        zq = F._utility_impedance(comps[0], BASE, C_MAX)
        z1, z2, z3 = (complex(0.3, 0.2) / zb, complex(0.4, 0.25) / zb,
                      complex(0.5, 0.3) / zb)
        xm = 0.17 * BASE / (2000 / (0.95 * 0.9 * 1000))
        zm = complex(xm / 10, xm)
        expected = C_MAX / abs(z2 + _par(zq + z1, z3 + zm)) * BASE / (math.sqrt(3) * kv)
        # pre-fix: 7.339 kA vs 5.971 kA (+22.9 %)
        assert F.run_fault_analysis(proj).buses["b2"].ik3 == pytest.approx(expected, rel=1e-3)


# ── F5 ───────────────────────────────────────────────────────────────────


class TestF5Converters:
    """[F5] UPS / VFD used to be zero-impedance links: a UPS output bus saw
    the full upstream level and a motor behind a VFD back-fed the supply."""

    KV = 0.4

    def _net(self, bypass="no", front_end="diode", motor_bus=False):
        comps = [
            _c("u", "utility", fault_mva=20, x_r_ratio=10, voltage_kv=self.KV),
            _c("b1", "bus", voltage_kv=self.KV),
            _c("ups", "ups", rated_kva=100, topology="online_double",
               static_bypass=bypass, fault_contribution_pu=2.0),
            _c("b2", "bus", voltage_kv=self.KV),
            _c("vfd", "vfd", rated_kw=200, efficiency=0.96, front_end=front_end,
               fault_contribution_pu=1.5),
            _c("m", "motor_induction", rated_kw=200, efficiency=0.95,
               power_factor=0.85, x_pp=0.17, x_r_ratio=10),
        ]
        w = (_Wires().add("u", "b1").add("b1", "ups", "bottom", "ac_in")
             .add("ups", "b2", "ac_out", "top").add("b1", "vfd", "bottom", "in"))
        if motor_bus:
            comps.append(_c("b3", "bus", voltage_kv=self.KV))
            w.add("vfd", "b3", "out", "top").add("b3", "m", "bottom", "in")
        else:
            w.add("vfd", "m", "out", "in")
        return _project(comps, w)

    def _grid(self):
        z = C_MAX * BASE / 20
        return C_MAX / z * BASE / (math.sqrt(3) * self.KV)

    def test_online_ups_without_bypass_is_inverter_limited(self):
        r = F.run_fault_analysis(self._net("no")).buses
        # pre-fix: 28.87 kA (upstream level) at a 100 kVA UPS output
        assert r["b2"].ik3 == pytest.approx(2.0 * 0.1 / (math.sqrt(3) * self.KV), rel=5e-3)
        assert r["b2"].ik1 == 0  # inverter output: no zero-sequence source

    def test_ups_static_bypass_passes_upstream_level(self):
        r = F.run_fault_analysis(self._net("yes")).buses
        assert r["b2"].ik3 == pytest.approx(self._grid(), rel=1e-3)

    def test_diode_vfd_blocks_motor_backfeed(self):
        r = F.run_fault_analysis(self._net("no")).buses
        assert r["b1"].ik3 == pytest.approx(self._grid(), rel=1e-3)
        assert r["b1"].motor_count == 0

    def test_afe_vfd_contributes_as_iec_motor(self):
        s_rm = 0.2 / 0.96
        zm = (1 / 3) * BASE / s_rm * complex(0.1, 1) / abs(complex(0.1, 1))
        zq = C_MAX * BASE / 20 * complex(1, 10) / abs(complex(1, 10))
        expected = C_MAX / abs(_par(zq, zm)) * BASE / (math.sqrt(3) * self.KV)
        r = F.run_fault_analysis(self._net("no", "afe")).buses
        assert r["b1"].ik3 == pytest.approx(expected, rel=1e-3)

    def test_drive_output_fault_is_current_limited(self):
        s_r = 0.2 / 0.96
        xm = 0.17 * BASE / (200 / (0.95 * 0.85 * 1000))
        zm = complex(xm / 10, xm)
        zd = C_MAX / 1.5 * BASE / s_r * complex(0.1, 1) / abs(complex(0.1, 1))
        expected = C_MAX / abs(_par(zd, zm)) * BASE / (math.sqrt(3) * self.KV)
        r = F.run_fault_analysis(self._net("no", motor_bus=True)).buses
        assert r["b3"].ik3 == pytest.approx(expected, rel=1e-3)


# ── F7 ───────────────────────────────────────────────────────────────────


class TestF7BranchCurrentRatedRatio:
    """[F7] Across an 11/0.42 kV unit on a 0.4 kV bus the HV-side current is
    I_LV × 0.42/11 (ampere-turn balance), not I_LV × 0.4/11 (−4.8 %)."""

    def test_hv_side_current(self):
        comps = [
            _c("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=11),
            _c("b1", "bus", voltage_kv=11), _c("cbh", "cb", state="closed"),
            _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8,
               voltage_hv_kv=11, voltage_lv_kv=0.42, vector_group="Dyn11",
               grounding_hv="ungrounded", grounding_lv="solidly_grounded"),
            _c("b2", "bus", voltage_kv=0.4),
        ]
        w = (_Wires().add("u", "b1").add("b1", "cbh").add("cbh", "t", "bottom", "primary")
             .add("t", "b2", "secondary", "top"))
        r = F.run_fault_analysis(_project(comps, w), fault_type="3phase").buses["b2"]
        br = {b.element_id: b for b in r.branches}
        expected = r.ik3 * 0.42 / 11
        for eid in ("cbh", "t", "u"):
            assert br[eid].ik_ka == pytest.approx(expected, rel=2e-3)


# ── F6 ───────────────────────────────────────────────────────────────────


class TestF6PeakCurrentSumOfBranches:
    """[F6] IEC 60909-0 §8.1.2: non-meshed multi-infeed → ip = Σ κ_i·√2·I″k,i.
    Weak X/R 3 grid ‖ X/R 40 generator: one κ from the combined R/X gave
    34.38 kA against 35.97 kA."""

    def test_sum_of_branch_peaks(self):
        comps = [
            _c("u", "utility", fault_mva=150, x_r_ratio=3, voltage_kv=11),
            _c("g", "generator", rated_mva=20, xd_pp=0.15, voltage_kv=11, x_r_ratio=40),
            _c("b1", "bus", voltage_kv=11),
        ]
        proj = _project(comps, _Wires().add("u", "b1").add("g", "b1"))
        zu = C_MAX * BASE / 150 * complex(1, 3) / abs(complex(1, 3))
        zg = F._generator_impedance(comps[1], BASE, 11)
        ib = BASE / (math.sqrt(3) * 11)
        expected = sum((1.02 + 0.98 * math.exp(-3 * z.real / z.imag)) * math.sqrt(2) * C_MAX / abs(z) * ib
                       for z in (zu, zg))
        r = F.run_fault_analysis(proj).buses["b1"]
        assert r.ip == pytest.approx(expected, rel=1e-3)
        assert r.kappa == pytest.approx(expected / (math.sqrt(2) * r.ik3), abs=2e-3)


# ── F8 ───────────────────────────────────────────────────────────────────


class TestF8MotorReacceleration:
    """[F8] The recovery curve read only a utility wired directly to the
    faulted bus, so behind a transformer it was flat at 1.0 p.u., and it
    counted motors anywhere in the project. Hand value at t = 0:
    V = 1 − |ZQ + ZT|·LRA·(t_clear/2H)·S_M/S_base, ZQ and ZT referred to the
    0.4 kV bus through the rated 11/0.42 ratio (K_T applied)."""

    def _net(self, stray_motor=False):
        comps = [
            _c("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=11),
            _c("b1", "bus", voltage_kv=11),
            _c("t", "transformer", rated_mva=1, z_percent=6, x_r_ratio=8,
               voltage_hv_kv=11, voltage_lv_kv=0.42, vector_group="Dyn11",
               grounding_hv="ungrounded", grounding_lv="solidly_grounded"),
            _c("b2", "bus", voltage_kv=0.4),
            _c("m", "motor_induction", rated_kw=200, efficiency=0.93,
               power_factor=0.85, x_pp=0.17, x_r_ratio=10, lra_multiplier=6,
               h_constant=0.5),
        ]
        w = (_Wires().add("u", "b1").add("b1", "t", "bottom", "primary")
             .add("t", "b2", "secondary", "top").add("b2", "m"))
        if stray_motor:  # a big motor on a separate, unsupplied island
            comps += [_c("b9", "bus", voltage_kv=0.4),
                      _c("m9", "motor_induction", rated_kw=5000, lra_multiplier=6)]
            w.add("b9", "m9")
        return _project(comps, w)

    def _expected_v0(self):
        rho2 = (0.42 / 0.4) ** 2
        zq = C_MAX * BASE / 250 * complex(1, 10) / abs(complex(1, 10)) * rho2
        xt = 0.06 * 8 / math.hypot(1, 8)
        kt = 0.95 * C_MAX / (1 + 0.6 * xt)
        zt = 0.06 * BASE / 1 * complex(1, 8) / abs(complex(1, 8)) * kt * rho2
        s_m = 200 / (0.93 * 0.85 * 1000)
        return 1 - abs(zq + zt) * 6 * (0.1 / 1.0) * s_m / BASE

    def test_dip_behind_transformer(self):
        prof = F.run_fault_analysis(self._net()).buses["b2"].motor_recovery
        assert prof[0]["v_pu"] == pytest.approx(self._expected_v0(), abs=2e-4)  # pre-fix: 1.0

    def test_motor_on_another_island_ignored(self):
        prof = F.run_fault_analysis(self._net(stray_motor=True)).buses["b2"].motor_recovery
        assert prof[0]["v_pu"] == pytest.approx(self._expected_v0(), abs=2e-4)


# ── F9 ───────────────────────────────────────────────────────────────────


SIN85 = math.sqrt(1 - 0.85 ** 2)


def _eq88(x_dsat, r, u_fmax, xd_pp=0.2, s=SIN85):
    """IEC TR 60909-1:2002 Eq. (88), written out independently."""
    lam = u_fmax * math.sqrt(1 + 2 * x_dsat * s + x_dsat ** 2) / (x_dsat - xd_pp + (1 + xd_pp * s) / r)
    return min(r, lam)


class TestF9SteadyStateIk:
    """[F9] Steady-state Ik per IEC 60909-0:2001 §4.6. The pre-fix engine
    reported c/Xd at the machine terminals — neither Ik_max nor Ik_min (at
    x_d 1.2: −58 % against λ_max and +76 % against λ_min)."""

    # Values read off IEC 60909-0 figures 18/19 (±0.05 chart accuracy).
    FIG_LAMBDA_MAX = [  # (rotor, series, x_dsat, r, λ_max)
        ("cylindrical", 1, 1.2, 2, 1.60), ("cylindrical", 1, 1.2, 4, 1.95),
        ("cylindrical", 1, 1.2, 8, 2.20), ("cylindrical", 1, 1.6, 8, 1.95),
        ("cylindrical", 1, 2.2, 8, 1.75), ("cylindrical", 2, 1.2, 8, 2.72),
        ("cylindrical", 2, 2.2, 8, 2.15), ("salient", 1, 0.6, 8, 4.25),
        ("salient", 1, 1.0, 8, 3.05), ("salient", 1, 2.0, 8, 2.25),
        ("salient", 2, 0.6, 8, 5.30), ("salient", 2, 1.2, 8, 3.45),
    ]
    FIG_LAMBDA_MIN = [("cylindrical", 2, 0.40), ("cylindrical", 4, 0.47),
                      ("cylindrical", 8, 0.52), ("salient", 2, 0.75), ("salient", 8, 1.10)]

    @pytest.mark.parametrize("rotor,series,x_dsat,r,fig", FIG_LAMBDA_MAX)
    def test_lambda_max_reproduces_figures(self, rotor, series, x_dsat, r, fig):
        u = F._U_FMAX[(rotor, series)]
        assert F._lambda_max(r, x_dsat, 0.2, SIN85, u) == pytest.approx(fig, rel=0.03)

    @pytest.mark.parametrize("rotor,r,fig", FIG_LAMBDA_MIN)
    def test_lambda_min_reproduces_figures(self, rotor, r, fig):
        assert F._lambda_min(r, rotor) == pytest.approx(fig, rel=0.07)

    def test_lambda_capped_at_initial_ratio(self):
        # figures' curves join the λ = I″kG/I_rG line at low ratios
        assert F._lambda_max(1.2, 1.2, 0.2, SIN85, 1.3) == pytest.approx(1.2)

    def _gen(self, **extra):
        props = dict(rated_mva=10, xd_pp=0.2, xd=1.8, scr=1 / 1.2, voltage_kv=11,
                     power_factor=0.85, x_r_ratio=1e6)
        props.update(extra)
        return _c("g", "generator", **props)

    def _k_g(self):
        return C_MAX / (1 + 0.2 * SIN85)   # IEC 60909-0 Eq. (18), U_n = U_rG

    def test_single_generator_terminal_fault(self):
        proj = _project([self._gen(), _c("bg", "bus", voltage_kv=11)], _Wires().add("g", "bg"))
        r_res = F.run_fault_analysis(proj).buses["bg"]
        i_rg = 10 / (math.sqrt(3) * 11)
        z_machine = 0.2 * self._k_g()                      # machine base
        r_max = C_MAX / z_machine                          # I″kG/I_rG at c_max
        r_min = 1.00 / z_machine                           # c_min = 1.00 at 11 kV
        assert r_res.ik_steady == pytest.approx(_eq88(1.2, r_max, 1.3) * i_rg, rel=2e-3)
        lam_min = 1 / (2.0 - 0.2 + (1 + 0.2 * SIN85) / r_min)
        assert r_res.ik_steady_min == pytest.approx(lam_min * i_rg, rel=2e-3)

    def test_power_station_unit_hv_side(self):
        """§4.6.2: λ·I_rGt, I_rG transferred to the HV side (11/33 kV)."""
        comps = [self._gen(), _c("bg", "bus", voltage_kv=11),
                 _c("t", "transformer", rated_mva=10, z_percent=10, x_r_ratio=1e6,
                    voltage_hv_kv=33, voltage_lv_kv=11, vector_group="YNd11",
                    winding_config="step_up", grounding_hv="solidly_grounded",
                    grounding_lv="ungrounded"),
                 _c("bh", "bus", voltage_kv=33)]
        w = _Wires().add("g", "bg").add("bg", "t", "bottom", "primary").add("t", "bh", "secondary", "top")
        res = F.run_fault_analysis(_project(comps, w)).buses["bh"]
        k_t = 0.95 * C_MAX / (1 + 0.6 * 0.10)
        z = 0.2 * self._k_g() + 0.10 * k_t                 # machine base (same MVA)
        i_rg_hv = 10 / (math.sqrt(3) * 11) * 11 / 33
        assert res.ik_steady == pytest.approx(_eq88(1.2, C_MAX / z, 1.3) * i_rg_hv, rel=2e-3)

    def test_static_exciter_at_terminals_contributes_nothing(self):
        proj = _project([self._gen(excitation_type="static_terminal"),
                         _c("bg", "bus", voltage_kv=11)], _Wires().add("g", "bg"))
        res = F.run_fault_analysis(proj).buses["bg"]
        assert not res.ik_steady and not res.ik_steady_min

    def test_compound_excitation_minimum_eq80(self):
        """Eq. (80)/(81) at the terminals: Ik_min = c_min·U_n/(√3·X_dP) = c_min·I_kP."""
        proj = _project([self._gen(excitation_type="compound", ikp_pu=3.0),
                         _c("bg", "bus", voltage_kv=11)], _Wires().add("g", "bg"))
        res = F.run_fault_analysis(proj).buses["bg"]
        assert res.ik_steady_min == pytest.approx(1.00 * 3.0 * 10 / (math.sqrt(3) * 11), rel=2e-3)

    def test_meshed_uses_eq84_85(self):
        """§4.6.3 on the F2 tee network (nodal path): Ik_max = I″k without the
        asynchronous motor, Ik_min = I″k at c_min (utility Z_Q with c_min)."""
        kv = 11.0
        zb = kv ** 2 / BASE
        cab = lambda cid, r, x: _c(cid, "cable", r_per_km=r, x_per_km=x, length_km=1)
        comps = [
            _c("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=kv),
            _c("b1", "bus", voltage_kv=kv), cab("c1", 0.3, 0.2),
            _c("tee", "cb", state="closed"), cab("c2", 0.4, 0.25),
            _c("b2", "bus", voltage_kv=kv), cab("c3", 0.5, 0.3),
            _c("b3", "bus", voltage_kv=kv),
            _c("m", "motor_induction", rated_kw=2000, efficiency=0.95,
               power_factor=0.9, x_pp=0.17, x_r_ratio=10),
        ]
        w = (_Wires().add("u", "b1").add("b1", "c1").add("c1", "tee").add("tee", "c2")
             .add("c2", "b2").add("tee", "c3").add("c3", "b3").add("b3", "m"))
        res = F.run_fault_analysis(_project(comps, w)).buses["b2"]
        assert res.network_topology == "meshed"
        z_lines = (complex(0.3, 0.2) + complex(0.4, 0.25)) / zb
        zq = lambda c: c * BASE / 250 * complex(1, 10) / abs(complex(1, 10))
        ib = BASE / (math.sqrt(3) * kv)
        assert res.ik_steady == pytest.approx(C_MAX / abs(zq(C_MAX) + z_lines) * ib, rel=2e-3)
        assert res.ik_steady_min == pytest.approx(1.0 / abs(zq(1.0) + z_lines) * ib, rel=2e-3)

    def test_inverter_sustains_its_limit(self):
        comps = [_c("pv", "battery", rated_kva=1000, fault_contribution_pu=1.1),
                 _c("b", "bus", voltage_kv=0.4)]
        r = F.run_fault_analysis(_project(comps, _Wires().add("pv", "b"))).buses["b"]
        assert r.ik_steady == pytest.approx(r.ik3, rel=1e-3)  # pre-fix: None
