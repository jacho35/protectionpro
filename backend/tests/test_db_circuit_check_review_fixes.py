"""DB circuit-check review — regression tests for findings DB1–DB4 and L1–L5.

References are hand calculations from IEC 60364-4-41, -4-43, -5-52 (Annex G,
Table G.52.1) and -5-54 (§543.1, Tables 54.3/54.7) and IEC 60228 — never the
engine's earlier output. IDs match the ``[DBn]`` / ``[Ln]`` markers in
``backend/analysis/db_circuit_check.py``.
"""

import math

import pytest

from backend.analysis.db_circuit_check import (
    _r_hot_per_km, adiabatic_ecc_mm2, run_db_circuit_check,
)
from backend.analysis.loadflow import run_load_flow
from backend.tests.test_db_circuit_check import _board_project, _comp, _way, _wire

U0 = 400 / math.sqrt(3)


def _row(p, way_id="w1"):
    return {r["way_id"]: r for r in run_db_circuit_check(p)["ways"]}[way_id]


# ── DB1 ────────────────────────────────────────────────────────────────

class TestDB1BlankEccNotOptimistic:
    """A blank ECC was assumed to be the Table 54.7 size (= the live
    conductor), claimed as the worst case. Twin-and-earth carries a reduced
    CPC: on a 60 m 2.5 mm² C20 way the blank ECC passed at 1.075 Ω while the
    real 1.5 mm² CPC gives 1.41 Ω and 155 A < 200 A."""

    def test_warns_when_twin_and_earth_would_fail(self):
        blank = _row(_board_project([_way(cable_mm2=2.5, cable_m=60, breaker_a=20, curve="C")]))
        real = _row(_board_project([_way(cable_mm2=2.5, cable_m=60, breaker_a=20, curve="C", ecc_mm2=1.5)]))
        assert real["zs_status"] == "fail"
        assert blank["zs_status"] == "warn"             # was "pass"
        assert "twin-and-earth" in blank["zs_message"]

    def test_assumes_smallest_compliant_size(self):
        """30 m: 1.0 mm² complies by §543.1.2 — R2 = 17.5/1.0 × 1.20 × 0.03 Ω,
        and √(I²·0.1)/115 ≤ 1.0 at I = 1.1·U0/Zs."""
        r = _row(_board_project([_way(cable_mm2=2.5, cable_m=30)]))
        assert r["ecc_assumed_mm2"] == 1.0
        assert r["r_ecc_ohm"] == pytest.approx(17.5 * 1.2 * 0.03, abs=1e-3)
        i_ad = 1.1 * U0 / r["zs_ohm"]
        assert math.sqrt(i_ad ** 2 * 0.1) / 115 <= 1.0


# ── DB2 ────────────────────────────────────────────────────────────────

class TestDB2AdiabaticRoute:
    """IEC 60364-5-54 §543.1.1: Table 54.7 OR §543.1.2 S ≥ √(I²t)/k. A 20 m
    2.5 mm² C20 twin-and-earth (1.5 mm² CPC) failed on the table alone."""

    def test_reduced_cpc_passes_adiabatic(self):
        r = _row(_board_project([_way(cable_mm2=2.5, cable_m=20, ecc_mm2=1.5)]))
        i_ad = 1.1 * U0 / r["zs_ohm"]                     # I = c_max·U0/Zs
        need = math.sqrt(i_ad ** 2 * 0.1) / 115           # k 115: Cu/PVC in cable, Table 54.3
        assert need <= 1.5
        assert r["ecc_adiabatic_mm2"] == pytest.approx(need, rel=1e-2)
        assert r["ecc_status"] == "pass"                  # was "fail"
        assert "§543.1.2" in r["ecc_message"]

    def test_adiabatic_needs_the_protection_to_operate(self):
        """60 m: the fault never reaches the magnetic trip, so no t exists and
        the 1.5 mm² CPC cannot be credited — Table 54.7 governs → fail."""
        r = _row(_board_project([_way(cable_mm2=2.5, cable_m=60, ecc_mm2=1.5)]))
        assert r["ecc_status"] == "fail"

    def test_formula(self):
        assert adiabatic_ecc_mm2(1000.0, 0.1, 115.0) == pytest.approx(math.sqrt(1e5) / 115)


# ── DB3 ────────────────────────────────────────────────────────────────

class TestDB3DropFromOrigin:
    """Upstream drop is from the ORIGIN (bus fed by the transformer), not
    from 1.0 pu. Source at 1.05 pu, board 120 m down a 16 mm² cable: the real
    5.9 % read as 1.1 %."""

    def _project(self):
        p = _board_project([_way()])
        for c in p.components:
            if c.id == "utility-1":
                c.props["v_setpoint_pu"] = 1.05
            if c.id == "db-1":
                c.props["rated_kva"] = 60
        p.wires = [w for w in p.wires if w.id != "w-4"]
        p.components += [_comp("k-1", "cable", {"name": "Sub", "r_per_km": 1.466, "x_per_km": 0.082,
                                                "length_km": 0.12, "voltage_kv": 0.4, "rated_amps": 91}),
                         _comp("bus-db", "bus", {"name": "DBbus", "voltage_kv": 0.4})]
        p.wires += [_wire("w-4a", "bus-lv", "k-1"), _wire("w-4b", "k-1", "bus-db"),
                    _wire("w-4c", "bus-db", "db-1")]
        return p

    def test_upstream_is_origin_minus_board(self):
        p = self._project()
        lf = run_load_flow(p, "newton_raphson")
        hand = (lf.buses["bus-lv"].voltage_pu - lf.buses["bus-db"].voltage_pu) * 100
        r = _row(p)
        assert hand > 5
        assert r["vd_upstream_pct"] == pytest.approx(hand, abs=0.01)
        assert r["vd_origin"] == "LV"
        assert r["vd_status"] == "fail"

    def test_board_at_origin_has_no_upstream_drop(self):
        """Board on the transformer-fed bus: the MV and transformer drop lie
        upstream of the origin and must not count."""
        r = _row(_board_project([_way()]))
        assert r["vd_upstream_pct"] == pytest.approx(0.0, abs=1e-6)


# ── DB4 ────────────────────────────────────────────────────────────────

class TestDB4AluminiumResistance:
    def test_al_uses_al_resistance(self):
        # IEC 60228: 16 mm² Al 1.91 Ω/km at 20 °C; ×1.20 at 70 °C (PVC)
        assert _r_hot_per_km(16, "Al", "PVC") == pytest.approx(1.91 * 1.20, rel=1e-3)
        assert _r_hot_per_km(16, "Cu", "PVC") == pytest.approx(1.15 * 1.20, rel=1e-3)


# ── L1–L5 ──────────────────────────────────────────────────────────────

class TestL1RcdRuleTn:
    def test_tn_uses_u0_over_idn(self):
        """TN §411.4.4: Zs·IΔn ≤ U0 → 7.7 kΩ at 30 mA; the TT 50 V rule
        (1.67 kΩ) was applied. A 3 Ω declared Ze way without magnetic trip:"""
        p = _board_project([_way(el_group="L1", cable_m=10)], board_props={"ze_ohm": 3.0})
        r = _row(p)
        assert r["zs_status"] == "pass" and "Zs·IΔn ≤ U0" in r["zs_message"]
        assert f"{U0 / 0.03:.1f}" in r["zs_message"]

    def test_tt_keeps_50v(self):
        p = _board_project([_way(el_group="L1", cable_m=10)])
        for c in p.components:
            if c.id == "tx-1":
                c.props.update(earthing_system="TT", earth_electrode_r_source=10,
                               earth_electrode_r_installation=40)
        r = _row(p)
        assert r["earthing_system"] == "TT"
        assert "50 V" in r["zs_message"]


class TestL2DeclaredDisconnectionTime:
    def test_feeder_with_declared_time_passes(self):
        way = _way(type="feeder_db", breaker_a=63, cable_mm2=16, cable_m=200)
        base = _row(_board_project([way]))
        assert base["zs_status"] == "fail"
        r = _row(_board_project([dict(way, disconnect_time_s=2.0)]))
        assert r["zs_status"] == "pass" and "declared" in r["zs_basis"]
        r = _row(_board_project([dict(way, disconnect_time_s=8.0)]))   # > 5 s limit
        assert r["zs_status"] == "fail"


class TestL3ComplexLoop:
    def test_loop_added_as_impedance(self):
        r = _row(_board_project([_way(ecc_mm2=2.5)]))
        assert r["zs_ohm"] < r["z_supply_ohm"] + r["r_phase_ohm"] + r["r_ecc_ohm"]


class TestL4DemandFactorZero:
    def test_zero_is_zero(self):
        assert _row(_board_project([_way(demand_factor=0)]))["ib_a"] == 0


class TestL5PrivateSupplyLimits:
    def test_private_supply_uses_table_g52_1_b(self):
        p = _board_project([_way(description="Heater")],
                           board_props={"way_install": {"supply": "private"}})
        assert _row(p)["vd_limit_pct"] == 8.0
        p = _board_project([_way(description="Lights")],
                           board_props={"way_install": {"supply": "private"}})
        assert _row(p)["vd_limit_pct"] == 6.0
        assert _row(_board_project([_way(description="Heater")]))["vd_limit_pct"] == 5.0
