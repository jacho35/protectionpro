"""Tests for the distribution-board per-way circuit check.

Covers the four verdicts the engine produces (ampacity/coordination, voltage
drop, ECC size, earth-fault loop Zs) plus the ported IEC 60364-5-52 tables the
derating depends on.

Two of these are cross-engine consistency checks rather than hand calculations:
``test_zs_matches_slg_identity`` pins the Zs derivation against
``run_fault_analysis``'s own reported Ik1 on the same network, and
``test_iz_base_matches_table`` pins the ported tables against the published
Table B.52.4 values.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.db_circuit_check import (
    C_MIN,
    MCB_CURVE_MAGNETIC,
    ecc_required_mm2,
    run_db_circuit_check,
)
from backend.analysis.iec_60364_tables import (
    base_ampacity_a,
    derating_factors,
    installed_ampacity,
    interpolate_factor,
)


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _way(**kw):
    """A way with sane defaults; override just what the test cares about."""
    base = {
        "id": kw.pop("id", "w1"), "way": "1", "description": "Socket Outlets",
        "poles": "1P", "phase": "R", "breaker_a": 20, "curve": "C",
        "el_group": "", "leakage_ma": 0, "cable_mm2": 2.5, "cable_m": 20,
        "load_va": 2000, "demand_factor": 1.0, "power_factor": 0.9,
    }
    base.update(kw)
    return base


def _board_project(ways, board_props=None, wired=True, base_mva=100.0):
    """Utility -> 11 kV bus -> Dyn11 transformer -> 400 V bus -> board."""
    props = {"name": "DB-1", "voltage_kv": 0.4, "circuits": ways}
    props.update(board_props or {})
    comps = [_comp("db-1", "distribution_board", props)]
    wires = []
    if wired:
        comps = [
            _comp("utility-1", "utility", {
                "name": "Grid", "voltage_kv": 11, "fault_mva": 500,
                "x_r_ratio": 15, "z0_z1_ratio": 1.0,
                "earthing_system": "TN-S"}),
            _comp("bus-hv", "bus", {"name": "HV", "voltage_kv": 11}),
            _comp("tx-1", "transformer", {
                "name": "TX", "rated_mva": 1.0, "z_percent": 5.0,
                "x_r_ratio": 10, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                "vector_group": "Dyn11", "grounding_lv": "solid"}),
            _comp("bus-lv", "bus", {"name": "LV", "voltage_kv": 0.4}),
        ] + comps
        wires = [
            _wire("w-1", "utility-1", "bus-hv"),
            _wire("w-2", "bus-hv", "tx-1"),
            _wire("w-3", "tx-1", "bus-lv"),
            _wire("w-4", "bus-lv", "db-1"),
        ]
    return ProjectData(name="t", components=comps, wires=wires, baseMVA=base_mva,
                       frequency=50)


def _rows(result):
    return {r["way_id"]: r for r in result["ways"]}


# ── Ported IEC 60364-5-52 tables ─────────────────────────────────────────

class TestIecTables:
    def test_iz_base_matches_table(self):
        # Table B.52.4 spot values, method B1, 2 loaded conductors.
        assert base_ampacity_a(1.5, "B1", "Cu", "PVC") == 17.5
        assert base_ampacity_a(2.5, "B1", "Cu", "PVC") == 24
        assert base_ampacity_a(4, "B1", "Cu", "PVC") == 32
        assert base_ampacity_a(10, "C", "Cu", "PVC") == 70
        assert base_ampacity_a(25, "B1", "Cu", "XLPE") == 133

    def test_absent_combination_is_none_not_zero(self):
        # Aluminium below 16 mm² is not tabulated — must be None so the caller
        # can report "info", not a silent 0 A pass.
        assert base_ampacity_a(2.5, "B1", "Al", "PVC") is None
        assert base_ampacity_a(1.5, "E", "Cu", "PVC") is None
        assert base_ampacity_a(0, "B1", "Cu", "PVC") is None

    def test_reference_conditions_give_unity_derating(self):
        f = derating_factors("B1", 30.0, "PVC", "bunched", 1)
        assert f["combined"] == pytest.approx(1.0)

    def test_derating_combines_ambient_and_grouping(self):
        # 40 °C air PVC = 0.87; 6 circuits bunched = 0.57.
        f = derating_factors("B1", 40.0, "PVC", "bunched", 6)
        assert f["temp"] == pytest.approx(0.87)
        assert f["grouping"] == pytest.approx(0.57)
        assert f["combined"] == pytest.approx(0.87 * 0.57)

    def test_interpolation_and_clamping(self):
        t = {10: 1.0, 20: 2.0}
        assert interpolate_factor(t, 15) == pytest.approx(1.5)
        assert interpolate_factor(t, 5) == pytest.approx(1.0)    # clamp low
        assert interpolate_factor(t, 99) == pytest.approx(2.0)   # clamp high
        assert interpolate_factor(t, 20) == pytest.approx(2.0)   # exact

    def test_installed_ampacity_applies_derating(self):
        amp = installed_ampacity(2.5, "B1", "Cu", "PVC", 40.0, "bunched", 6)
        assert amp["base_a"] == 24
        assert amp["derated_a"] == pytest.approx(24 * 0.87 * 0.57)


# ── ECC selection rule ───────────────────────────────────────────────────

class TestEccRule:
    def test_table_547_boundaries(self):
        assert ecc_required_mm2(1.5) == 1.5      # S <= 16 -> S
        assert ecc_required_mm2(16) == 16        # boundary stays S
        assert ecc_required_mm2(25) == 16        # 16 < S <= 35 -> 16
        assert ecc_required_mm2(35) == 16        # boundary stays 16
        assert ecc_required_mm2(50) == 25        # S > 35 -> S/2
        assert ecc_required_mm2(70) == 35
        assert ecc_required_mm2(240) == 120

    def test_rounds_up_to_a_preferred_size(self):
        # 95/2 = 47.5, which is not a preferred size -> next one up.
        assert ecc_required_mm2(95) == 50
        assert ecc_required_mm2(120) == 70       # 60 -> 70

    def test_no_size_returns_none(self):
        assert ecc_required_mm2(0) is None
        assert ecc_required_mm2(None) is None


# ── Ampacity / coordination ──────────────────────────────────────────────

class TestCoordination:
    def test_comfortable_way_passes(self):
        p = _board_project([_way(cable_mm2=4, breaker_a=20, load_va=2000)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["coordination_status"] == "pass"
        assert r["iz_base_a"] == 32
        assert r["iz_derated_a"] == pytest.approx(32.0)

    def test_breaker_above_derated_iz_fails(self):
        # 2.5 mm² B1 = 24 A base; 6 circuits bunched at 40 °C -> ~11.9 A.
        p = _board_project(
            [_way(cable_mm2=2.5, breaker_a=20, load_va=500)],
            board_props={"way_install": {"ambient_c": 40, "grouping": "bunched",
                                         "circuits": 6}})
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["iz_derated_a"] == pytest.approx(24 * 0.87 * 0.57, abs=0.05)
        assert r["coordination_status"] == "fail"
        assert "undersized" in r["coordination_message"]
        assert r["status"] == "fail"

    def test_load_above_breaker_fails(self):
        # 12 kVA single-phase at 230 V = 52 A through a 20 A breaker.
        p = _board_project([_way(cable_mm2=10, breaker_a=20, load_va=12000)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["coordination_status"] == "fail"
        assert "exceeds the 20 A breaker" in r["coordination_message"]

    def test_request_options_override_board_props(self):
        p = _board_project(
            [_way(cable_mm2=2.5, breaker_a=20, load_va=500)],
            board_props={"way_install": {"ambient_c": 30, "circuits": 1}})
        base = _rows(run_db_circuit_check(p))["w1"]
        hot = _rows(run_db_circuit_check(p, ambient_temp_c=55))["w1"]
        assert base["iz_derated_a"] > hot["iz_derated_a"]

    def test_unlisted_size_is_info_not_pass(self):
        p = _board_project([_way(cable_mm2=3, breaker_a=20)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ampacity_status"] == "info"
        assert r["iz_derated_a"] is None
        assert r["status"] != "pass"


# ── Voltage drop ─────────────────────────────────────────────────────────

class TestVoltageDrop:
    def test_single_phase_uses_two_conductor_loop(self):
        """1P must be 2·I·L·Z; 3P must be √3·I·L·Z on the same conductor."""
        common = dict(cable_mm2=10, cable_m=50, breaker_a=32,
                      load_va=6000, power_factor=1.0)
        p1 = _board_project([_way(poles="1P", phase="R", **common)])
        p3 = _board_project([_way(poles="3P", phase="RWB", **common)])
        r1 = _rows(run_db_circuit_check(p1))["w1"]
        r3 = _rows(run_db_circuit_check(p3))["w1"]

        # 10 mm² Cu PVC: 1.83 Ω/km at 20 °C, ×1.20 hot = 2.196 Ω/km.
        r_hot = 1.83 * 1.20
        i_1p = 6000 / (400 / math.sqrt(3))
        i_3p = 6000 / (math.sqrt(3) * 400)
        assert r1["vd_v"] == pytest.approx(2 * i_1p * 0.05 * r_hot, rel=1e-3)
        assert r3["vd_v"] == pytest.approx(math.sqrt(3) * i_3p * 0.05 * r_hot,
                                           rel=1e-3)

    def test_lighting_way_gets_the_3pct_limit(self):
        p = _board_project([
            _way(id="w1", description="Lighting — 10 points"),
            _way(id="w2", description="Socket Outlets"),
        ])
        rows = _rows(run_db_circuit_check(p))
        assert rows["w1"]["vd_limit_pct"] == 3.0
        assert rows["w2"]["vd_limit_pct"] == 5.0

    def test_long_run_fails_the_limit(self):
        p = _board_project([_way(cable_mm2=1.5, cable_m=120, breaker_a=10,
                                 load_va=2300, power_factor=1.0)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["vd_status"] == "fail"
        assert r["vd_pct"] > 5.0


# ── Earth-fault loop impedance ───────────────────────────────────────────

class TestEarthLoop:
    def test_zs_matches_slg_identity(self):
        """Zs must equal U0/Ik1 from the fault engine on the same network.

        The engine derives Zs from |Z1+Z2+Z0|/3; run_fault_analysis reports
        Ik1 = 3c/|Z1+Z2+Z0| in p.u. Both must describe the same loop.
        """
        p = _board_project([_way(cable_m=0, cable_mm2=2.5, ecc_mm2=2.5)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["z_supply_basis"] == "thevenin"

        fr = run_fault_analysis(p, fault_bus_id="db-1", fault_type="slg",
                                voltage_factor=C_MIN)
        ik1_a = fr.buses["db-1"].ik1 * 1000.0
        v_ph = 400.0 / math.sqrt(3)
        assert r["z_supply_ohm"] == pytest.approx(C_MIN * v_ph / ik1_a, rel=0.02)

    def test_magnetic_multiples_per_curve(self):
        p = _board_project([
            _way(id="wb", curve="B", breaker_a=20),
            _way(id="wc", curve="C", breaker_a=20),
            _way(id="wd", curve="D", breaker_a=20),
        ])
        rows = _rows(run_db_circuit_check(p))
        assert rows["wb"]["ia_a"] == pytest.approx(5 * 20)
        assert rows["wc"]["ia_a"] == pytest.approx(10 * 20)
        assert rows["wd"]["ia_a"] == pytest.approx(20 * 20)
        assert MCB_CURVE_MAGNETIC == {"B": 5.0, "C": 10.0, "D": 20.0}

    def test_short_run_trips_magnetically(self):
        p = _board_project([_way(cable_mm2=2.5, ecc_mm2=2.5, cable_m=10,
                                 breaker_a=20, curve="B")])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["zs_status"] == "pass"
        assert r["zs_basis"].startswith("magnetic")
        assert r["ief_a"] >= r["ia_a"]

    def test_long_run_fails_disconnection(self):
        p = _board_project([_way(cable_mm2=1.5, ecc_mm2=1.5, cable_m=250,
                                 breaker_a=32, curve="D")])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["zs_status"] == "fail"
        assert r["zs_ohm"] > r["zs_max_ohm"]

    def test_rcd_rescues_a_high_zs_way(self):
        """A 30 mA RCD satisfies Zs <= 50 V / IΔn where the magnetic trip fails."""
        ways = [_way(id="w1", cable_mm2=1.5, ecc_mm2=1.5, cable_m=250,
                     breaker_a=32, curve="D", el_group="EL1")]
        p = _board_project(ways, board_props={"el_ratings": {"EL1": 30}})
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["zs_status"] == "pass"
        assert r["zs_basis"].startswith("rcd")
        assert r["zs_ohm"] <= 50.0 / 0.030

    def test_declared_ze_overrides_thevenin(self):
        p = _board_project([_way(cable_m=0)], board_props={"ze_ohm": 0.35})
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["z_supply_basis"] == "declared"
        assert r["z_supply_ohm"] == pytest.approx(0.35)

    def test_unwired_board_is_info_never_pass(self):
        p = _board_project([_way()], wired=False)
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["zs_status"] == "info"
        assert r["zs_ohm"] is None
        assert r["status"] != "pass"

    def test_supply_chains_through_a_feeder_way(self):
        """A sub-board with no SLD wiring inherits Ze from its parent's feeder."""
        p = _board_project([_way(id="f1", type="feeder_db", feedsDbId="db-2",
                                 poles="3P", phase="RWB", cable_mm2=25,
                                 cable_m=40, breaker_a=63, load_va=0,
                                 downstream_a=40)])
        p.components.append(_comp("db-2", "distribution_board", {
            "name": "DB-2", "voltage_kv": 0.4,
            "circuits": [_way(id="w2", cable_m=15)]}))
        rows = _rows(run_db_circuit_check(p))
        child = rows["w2"]
        assert child["z_supply_basis"] == "chained"
        parent_supply = rows["f1"]["z_supply_ohm"]
        assert child["z_supply_ohm"] > parent_supply


# ── ECC verdict + back-compat ────────────────────────────────────────────

class TestEccVerdict:
    def test_absent_ecc_is_info_and_zs_assumes_the_minimum(self):
        p = _board_project([_way(cable_mm2=2.5, cable_m=30)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ecc_status"] == "info"
        assert r["ecc_mm2"] is None
        assert r["ecc_required_mm2"] == 2.5
        assert "assumed_min_ecc" in (r["zs_basis"] or "")
        # The assumed conductor is the required minimum, so R_ecc == R_phase.
        assert r["r_ecc_ohm"] == pytest.approx(r["r_phase_ohm"])

    def test_undersized_ecc_fails(self):
        p = _board_project([_way(cable_mm2=10, ecc_mm2=4)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ecc_status"] == "fail"
        assert r["status"] == "fail"

    def test_adequate_ecc_passes(self):
        p = _board_project([_way(cable_mm2=10, ecc_mm2=10)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ecc_status"] == "pass"

    def test_oversized_ecc_passes(self):
        p = _board_project([_way(cable_mm2=50, ecc_mm2=35)])
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ecc_status"] == "pass"       # required is 25


# ── Envelope, rollup and serialization ───────────────────────────────────

class TestEnvelope:
    def test_no_boards_returns_empty_envelope(self):
        p = ProjectData(name="t", components=[], wires=[], baseMVA=100.0)
        out = run_db_circuit_check(p)
        assert out["ways"] == []
        assert out["boards"] == []
        assert out["summary"]["ways"] == 0

    def test_status_is_worst_of_the_sub_verdicts(self):
        p = _board_project([_way(cable_mm2=10, ecc_mm2=4)])   # ECC fails only
        r = _rows(run_db_circuit_check(p))["w1"]
        assert r["ecc_status"] == "fail"
        assert r["coordination_status"] == "pass"
        assert r["status"] == "fail"
        assert any("ECC" in m for m in r["messages"])
        # Passing sub-checks contribute no noise to the tooltip.
        assert not any("Ib" in m and "≤" in m for m in r["messages"])

    def test_board_summary_counts(self):
        p = _board_project([
            _way(id="w1", cable_mm2=10, ecc_mm2=10),
            _way(id="w2", cable_mm2=10, ecc_mm2=4),
        ])
        out = run_db_circuit_check(p)
        board = out["boards"][0]
        assert board["way_count"] == 2
        assert board["counts"]["fail"] == 1
        assert board["worst_status"] == "fail"

    def test_all_values_are_json_native(self):
        """Guards the numpy-scalar -> Pydantic 500 that direct calls miss."""
        import json
        p = _board_project([_way(ecc_mm2=2.5)])
        out = run_db_circuit_check(p)
        json.dumps(out)          # raises TypeError on a numpy scalar
        for r in out["ways"]:
            for k, v in r.items():
                assert v is None or isinstance(v, (str, int, float, bool, list)), \
                    f"{k} is {type(v)}"

    def test_basis_block_declares_the_conventions(self):
        p = _board_project([_way()])
        basis = run_db_circuit_check(p)["basis"]
        assert basis["c_min"] == 0.95
        assert basis["magnetic_multiples"]["D"] == 20.0
        assert "54.7" in basis["ecc_rule"]


# ── Endpoint + PDF integration ───────────────────────────────────────────

class TestIntegration:
    def test_route_handler_and_serialization(self):
        """Route function + request model + FastAPI's own JSON encoding.

        Exercised by calling the handler directly rather than through
        TestClient: the API is auth-gated, and standing up a throwaway DB and
        registering a user would test the auth middleware, not this engine.
        What matters here is that the request model accepts a ProjectData body
        and that every value survives FastAPI's encoder — the numpy-scalar trap
        a plain engine call cannot see.
        """
        from fastapi.encoders import jsonable_encoder
        from backend.routes.analysis import DbCircuitCheckRequest, db_circuit_check

        p = _board_project([_way(ecc_mm2=2.5)])
        req = DbCircuitCheckRequest(**p.model_dump())
        out = db_circuit_check(req)
        assert len(out["ways"]) == 1
        assert out["ways"][0]["board_id"] == "db-1"
        assert "basis" in out and "summary" in out
        encoded = jsonable_encoder(out)
        assert encoded["ways"][0]["way_id"] == "w1"

    def test_route_options_are_forwarded(self):
        from backend.routes.analysis import DbCircuitCheckRequest, db_circuit_check

        p = _board_project([_way(cable_mm2=2.5, breaker_a=20, load_va=500)])
        cool = db_circuit_check(DbCircuitCheckRequest(**p.model_dump(),
                                                     ambient_temp_c=30))
        hot = db_circuit_check(DbCircuitCheckRequest(**p.model_dump(),
                                                    ambient_temp_c=55))
        assert hot["ways"][0]["iz_derated_a"] < cool["ways"][0]["iz_derated_a"]

    def test_pdf_renders_with_and_without_check_results(self):
        """The report gains result columns when the check has been run and
        falls back to the undegraded ampacity check when it has not."""
        from backend.analysis.pdf_reports import generate_full_report

        p = _board_project([_way(id="w1", cable_mm2=2.5, breaker_a=20)])
        components = [{"id": c.id, "type": c.type, "props": c.props}
                      for c in p.components]
        check = run_db_circuit_check(p)

        without = generate_full_report("T", 100.0, 50, components=components,
                                       sections=["db_schedules"]).getvalue()
        with_check = generate_full_report("T", 100.0, 50, components=components,
                                          sections=["db_schedules"],
                                          db_check_results=check).getvalue()
        assert without.startswith(b"%PDF")
        assert with_check.startswith(b"%PDF")
        # The checked report carries the extra columns, so it is larger.
        assert len(with_check) > len(without)
