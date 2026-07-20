"""Regression pins for the Round-3 principal-verification fixes.

Finding numbers refer to CALC_REVIEW_ROUND3_PRINCIPAL.md (2026-07-20), which
adjudicated the Round-2 findings against the post-P3 tree. Round-1 P1/P2 pins
live in test_verification_fixes.py; Round-1 P3 pins in test_p3_fixes.py.
"""

import math

import pytest

from backend.models.schemas import (ProjectData, Component, Wire, FaultResults,
                                    FaultResultBus)
from backend.analysis.fault import run_fault_analysis
from backend.analysis.arcflash import run_arc_flash
from backend.analysis.contingency import run_contingency
from backend.analysis.duty_check import run_duty_check
from backend.analysis.load_diversity import _get_load_kw, _get_load_kva
from backend.analysis.motor_starting import run_motor_starting
from backend.analysis.unbalanced_loadflow import run_unbalanced_load_flow


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires, base_mva=100.0):
    return ProjectData(projectName="r3-fix", baseMVA=base_mva, frequency=50,
                       components=components, wires=wires)


# ── Finding 2: PS-1 fallback flag propagates to consumers ────────────────────


class TestFallbackFlag:
    def test_healthy_solves_carry_no_flag(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "busA")])
        res = run_fault_analysis(proj)
        assert res.buses["busA"].thevenin_basis is None

    def test_meshed_nodal_solve_carries_no_flag(self):
        # The parallel-feeder network from TestPS1ParallelPaths — meshed and
        # healthy, so the nodal path succeeds and no fallback flag is set.
        proj = _project([
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
        b = run_fault_analysis(proj).buses["busB"]
        assert b.network_topology == "meshed"
        assert b.thevenin_basis is None

    def test_arcflash_annotates_fallback_bus(self):
        # Hand-craft a FaultResults with the fallback flag set — the arc
        # flash consumer must carry an UNRELIABLE warning on that bus.
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ], [_wire("w1", "u1", "busA")])
        fr = run_fault_analysis(proj)
        fr.buses["busA"].thevenin_basis = "per-path-fallback"
        res = run_arc_flash(proj, fr)
        assert "UNRELIABLE" in res.buses["busA"].warning
        assert "per-path fallback" in res.buses["busA"].warning

    def test_duty_check_flags_fallback(self, monkeypatch):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 20.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 0.4}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 0.4}),
            _comp("cb1", "cb", {"name": "CB1", "breaking_capacity_ka": 50.0,
                                "rated_current_a": 630.0,
                                "rated_voltage_kv": 0.69}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 100.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "cb1"),
            _wire("w3", "cb1", "ld"),
        ])
        # duty_check imports the fault engine inside run_duty_check — patch
        # the source module.
        import backend.analysis.fault as fmod
        real_run = fmod.run_fault_analysis

        def _flagged(p, **kw):
            r = real_run(p, **kw)
            for b in r.buses.values():
                b.thevenin_basis = "per-path-fallback"
            return r

        monkeypatch.setattr(fmod, "run_fault_analysis", _flagged)
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        assert row["thevenin_fallback"] is True
        assert row["status"] in ("warning", "fail")
        assert any("per-path fallback" in i for i in row["issues"])


# ── PS-R2-4: through-current duty basis ──────────────────────────────────────


class TestThroughCurrentDuty:
    def test_feeder_device_excludes_downstream_motor_infeed(self):
        """A feeder CB with a large motor beyond it: the CB's breaking duty
        for a fault just downstream of itself excludes the motor's own
        back-feed — previously the whole-bus figure (utility + motor) was
        used (conservative false alarms)."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 200.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("cb1", "cb", {"name": "FeederCB", "breaking_capacity_ka": 25.0,
                                "rated_current_a": 400.0,
                                "rated_voltage_kv": 12.0}),
            _comp("m1", "motor_induction", {"name": "M1", "rated_kw": 2000.0,
                                            "efficiency": 0.95,
                                            "power_factor": 0.88,
                                            "voltage_kv": 11.0, "x_pp": 0.167,
                                            "x_r_ratio": 10.0}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "cb1"),
            _wire("w3", "cb1", "m1"),
        ])
        fr = run_fault_analysis(proj).buses["busA"]
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        # The device's branch row at busA is the motor infeed through it —
        # its through-duty is the bus total minus that infeed.
        motor_row = next(br for br in fr.branches if br.element_id == "cb1")
        expected = fr.ik3 - motor_row.ik_ka
        assert row["through_fault_ka"] == pytest.approx(expected, abs=0.02)
        assert row["through_fault_ka"] < row["prospective_fault_ka"]
        assert "+through" in row["duty_basis"]

    def test_sole_path_device_keeps_bus_figure(self):
        """A device with no source beyond it has no branch row — legacy
        whole-bus duty is retained (conservative)."""
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 200.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("cb1", "cb", {"name": "CB1", "breaking_capacity_ka": 25.0,
                                "rated_current_a": 400.0,
                                "rated_voltage_kv": 12.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 500.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "cb1"),
            _wire("w3", "cb1", "ld"),
        ])
        res = run_duty_check(proj)
        row = next(r for r in res["devices"] if r["device_id"] == "cb1")
        assert row["through_fault_ka"] == pytest.approx(
            row["prospective_fault_ka"], abs=0.01)
        assert "+through" not in row["duty_basis"]


# ── EE-R2-4: N-2 pair ranking before truncation ──────────────────────────────


class TestN2PairRanking:
    def _radial_with_feeders(self, n_feeders):
        comps = [
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
        ]
        wires = [_wire("w1", "u1", "busA")]
        for i in range(n_feeders):
            comps += [
                _comp(f"c{i}", "cable", {"name": f"C{i}", "r_per_km": 0.2,
                                         "x_per_km": 0.1, "length_km": 1.0,
                                         "voltage_kv": 11.0}),
                _comp(f"bus{i}", "bus", {"name": f"B{i}", "voltage_kv": 11.0}),
                _comp(f"ld{i}", "static_load", {"name": f"L{i}",
                                                "rated_kva": 1000.0 * (i + 1),
                                                "power_factor": 0.9}),
            ]
            wires += [
                _wire(f"wa{i}", "busA", f"c{i}"),
                _wire(f"wb{i}", f"c{i}", f"bus{i}"),
                _wire(f"wc{i}", f"bus{i}", f"ld{i}"),
            ]
        return _project(comps, wires)

    def test_truncation_keeps_most_severe_pairs(self):
        proj = self._radial_with_feeders(4)  # 5 outageable → 10 pairs
        # Cap allows N-1 (5) + only 3 pairs → 7 pairs skipped after ranking.
        res = run_contingency(proj, include_n2=True, max_contingencies=8)
        assert res.skipped == 7
        pair_results = [c for c in res.contingencies if c.order == 2]
        assert len(pair_results) == 3
        # The utility is the most severe single outage (islands everything),
        # so every analysed pair must include it after severity ranking —
        # lexicographic truncation would instead keep (c0,c1)-style pairs.
        for c in pair_results:
            assert "u1" in c.outaged_ids
        # The warning names dropped pairs and states the subset coverage.
        w = " ".join(res.warnings)
        assert "ranked by combined N-1 severity" in w
        assert "analysed subset" in w


# ── EE-R2-5: induction-motor kW is input power ───────────────────────────────


class TestMotorInputKw:
    def test_kw_is_input_power(self):
        m = _comp("m1", "motor_induction", {"rated_kw": 200.0,
                                            "efficiency": 0.93,
                                            "power_factor": 0.85})
        assert _get_load_kw(m) == pytest.approx(200.0 / 0.93)
        # kVA path (transformer loading) was always input power — unchanged.
        assert _get_load_kva(m) == pytest.approx(200.0 / (0.93 * 0.85))


# ── EE-R2-3: constant-PQ model disclosure ────────────────────────────────────


class TestMotorStartModelDisclosure:
    def test_result_carries_model_field(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 100.0,
                                    "voltage_kv": 0.4}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 0.4}),
            _comp("m1", "motor_induction", {"name": "M1", "rated_kw": 55.0,
                                            "voltage_kv": 0.4,
                                            "locked_rotor_current": 6.0}),
        ], [_wire("w1", "u1", "busA"), _wire("w2", "busA", "m1")])
        res = run_motor_starting(proj)
        assert res["motors"], "motor study returned no rows"
        assert all("constant-PQ" in m["model"] for m in res["motors"])


# ── R3-1: unbalanced engine warns on unclamped PV buses ──────────────────────


class TestUnbalancedPVWarning:
    def test_pv_bus_warns(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.3,
                                  "x_per_km": 0.2, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0,
                                  "bus_type": "PV"}),
            _comp("g1", "generator", {"name": "G1", "rated_mva": 5.0,
                                      "voltage_kv": 11.0,
                                      "voltage_setpoint_pu": 1.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 2000.0,
                                        "power_factor": 0.9}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busB", "g1"), _wire("w5", "busB", "ld"),
        ])
        res = run_unbalanced_load_flow(proj)
        assert any("UNLIMITED reactive" in w.message for w in res.warnings)

    def test_pq_only_network_stays_silent(self):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("ld", "static_load", {"name": "L", "rated_kva": 2000.0,
                                        "power_factor": 0.9}),
        ], [_wire("w1", "u1", "busA"), _wire("w2", "busA", "ld")])
        res = run_unbalanced_load_flow(proj)
        assert not any("UNLIMITED reactive" in w.message for w in res.warnings)


# ── R3-2: nodal Z0 builder honors the inverter x0 prop ───────────────────────


class TestNodalInverterX0:
    def _proj(self, meshed, x0=0.0):
        pv_props = {"name": "PV", "rated_kw": 1000.0, "num_inverters": 1,
                    "voltage_kv": 11.0, "grounding": "solidly"}
        if x0 > 0:
            pv_props["x0"] = x0
        comps = [
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "x_r_ratio": 10.0, "voltage_kv": 11.0,
                                    "grounding": "ungrounded"}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2,
                                  "x_per_km": 0.1, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
            _comp("pv", "solar_pv", pv_props),
        ]
        wires = [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
            _wire("w4", "busB", "pv"),
        ]
        if meshed:
            comps.append(_comp("c2", "cable", {"name": "C2", "r_per_km": 0.2,
                                               "x_per_km": 0.1,
                                               "length_km": 1.0,
                                               "voltage_kv": 11.0}))
            wires += [_wire("w5", "busA", "c2"), _wire("w6", "c2", "busB")]
        return _project(comps, wires)

    def test_radial_and_meshed_agree_with_x0(self):
        """The identical earthed inverter with an explicit x0 must give the
        same Ik1 at its own bus whether the network is drawn radial or with
        a duplicated (parallel) feeder — previously the nodal builder ignored
        x0 and the two topologies diverged."""
        radial = run_fault_analysis(self._proj(False, x0=0.9)).buses["busB"]
        meshed = run_fault_analysis(self._proj(True, x0=0.9)).buses["busB"]
        assert meshed.network_topology == "meshed"
        # The Z0 shunt is the inverter itself in both cases (utility Z0 is
        # blocked); the parallel feeder halves only the Z1/Z2 side.
        assert radial.z0_mag == pytest.approx(meshed.z0_mag, rel=1e-3)

    def test_x0_changes_nodal_z0(self):
        base = run_fault_analysis(self._proj(True)).buses["busB"]
        with_x0 = run_fault_analysis(self._proj(True, x0=2.0)).buses["busB"]
        assert with_x0.z0_mag != pytest.approx(base.z0_mag, rel=1e-3)

    def test_z0_default_disclosed_in_detail(self):
        b = run_fault_analysis(self._proj(False)).buses["busB"]
        assert any("Z0=Z1 default" in d for d in (b.z0_sources_detail or []))


# ── PS-R2-3: dedicated magnetising-branch X/R prop ───────────────────────────


class TestZ0mXrProp:
    def _proj(self, z0m_xr=None):
        props = {"name": "T1", "rated_mva": 1.0, "z_percent": 6.0,
                 "x_r_ratio": 5.0, "voltage_hv_kv": 11.0, "voltage_lv_kv": 0.4,
                 "vector_group": "YNyn0",
                 "grounding_hv": "ungrounded",
                 "grounding_lv": "solidly_grounded",
                 "core_construction": "three_limb"}
        if z0m_xr:
            props["z0m_x_r_ratio"] = z0m_xr
        return _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busH", "bus", {"name": "H", "voltage_kv": 11.0}),
            _comp("tx", "transformer", props),
            _comp("busL", "bus", {"name": "L", "voltage_kv": 0.4}),
        ], [
            _wire("w1", "u1", "busH"),
            _wire("w2", "busH", "tx", "bottom", "primary"),
            _wire("w3", "tx", "busL", "secondary", "top"),
        ])

    def test_prop_overrides_leakage_xr(self):
        legacy = run_fault_analysis(self._proj()).buses["busL"]
        dedicated = run_fault_analysis(self._proj(z0m_xr=100.0)).buses["busL"]
        # Single-earthed star-star: Z0 is dominated by Z0m; a higher X/R
        # shrinks its resistive part (small but pinned change).
        assert dedicated.z0_real < legacy.z0_real
        assert legacy.ik1 and dedicated.ik1  # both still source a limited Ik1


# ── PS-R2-7: voltage-depression failure is no longer silent ──────────────────


class TestVoltageDepressionWarning:
    def test_failure_emits_warning(self, monkeypatch):
        proj = _project([
            _comp("u1", "utility", {"name": "Grid", "fault_mva": 500.0,
                                    "voltage_kv": 11.0}),
            _comp("busA", "bus", {"name": "A", "voltage_kv": 11.0}),
            _comp("c1", "cable", {"name": "C1", "r_per_km": 0.2,
                                  "x_per_km": 0.1, "length_km": 1.0,
                                  "voltage_kv": 11.0}),
            _comp("busB", "bus", {"name": "B", "voltage_kv": 11.0}),
        ], [
            _wire("w1", "u1", "busA"),
            _wire("w2", "busA", "c1"), _wire("w3", "c1", "busB"),
        ])
        import backend.analysis.fault as f

        def _boom(*a, **k):
            raise RuntimeError("synthetic failure")

        monkeypatch.setattr(f, "_compute_voltage_depression", _boom)
        res = f.run_fault_analysis(proj)
        for b in res.buses.values():
            assert any("Voltage-depression calculation failed" in w
                       for w in (b.topology_warnings or []))
