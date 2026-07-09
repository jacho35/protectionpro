"""Standards-anchored tests for arc-flash clearing-time device tracing.

Pins the 2026-07 audit fixes in backend/analysis/arcflash.py:

- [EE-6/PROT-3] The upstream device search is a BFS from the faulted bus
  toward the source (through cables, closed switches, CTs, transformers),
  not a one-wire-hop neighbor scan — so `bus — CB — cable — bus` layouts
  get the CB's clearing time instead of the 2.0 s fallback.
- [PROT-1] Fuse clearing time is the gG pre-arcing curve (ported from the
  frontend FUSE_CURVES_GG) evaluated at the ARCING current × 1.2 for total
  clearing, capped at 2.0 s — not a hardcoded 0.02 s.
- [PROT-2] Relays are resolved via associated_ct / trip_cb and their actual
  IDMT curve is evaluated at the arcing current (+ 0.08 s breaker opening),
  replacing the dead `tds*0.1+0.08` heuristic. A relay-tripped CB uses the
  relay curve instead of its own thermal-magnetic model.

Hand-calculation anchors use the IEEE 1584-2002 MV arcing-current model
(Eq. 2): log Ia = 0.00402 + 0.983·log Ibf, with Ik3 = c·Ibase/|Z1| per the
engine's IEC 60909 convention (c = 1.10 at 11 kV, Ibase = 5.2486 kA).

Run with:  python -m pytest backend/tests/ -v
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.arcflash import (
    run_arc_flash,
    _fuse_prearc_time,
    _relay_operate_time,
)


# ── Helpers ──────────────────────────────────────────────────────────────


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires):
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=components, wires=wires)


def _utility(fault_mva, kv=11.0):
    return _comp("utility-1", "utility", {
        "name": "Grid", "voltage_kv": kv, "fault_mva": fault_mva,
        "x_r_ratio": 15.0, "z0_z1_ratio": 1.0,
    })


def _arc_flash(project):
    return run_arc_flash(project, run_fault_analysis(project))


# ── [EE-6/PROT-3] BFS device search ──────────────────────────────────────


class TestDeviceSearchBFS:
    def test_cb_behind_cable_is_found(self):
        """Canonical layout utility — CB — cable — bus: the CB clears the
        bus fault. Pre-fix, the one-hop search saw only the cable and fell
        back to 2.0 s.

        fault_mva = 350 → Ik3 ≈ 1.10·5.2486·3.5 ≈ 20.2 kA → Iarc ≈ 19.4 kA,
        far above the 630 A × 10 instantaneous pickup → 0.05 s.
        """
        proj = _project(
            components=[
                _utility(350.0),
                _comp("cb-1", "cb", {
                    "name": "CB1", "state": "closed",
                    "trip_rating_a": 630, "magnetic_pickup": 10,
                    "long_time_delay": 10,
                }),
                _comp("cable-1", "cable", {
                    "name": "C1", "length_km": 0.01, "r_per_km": 0.1,
                    "x_per_km": 0.08, "voltage_kv": 11.0, "rated_amps": 400,
                }),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[
                _wire("w1", "utility-1", "cb-1"),
                _wire("w2", "cb-1", "cable-1"),
                _wire("w3", "cable-1", "bus-1"),
            ])
        res = _arc_flash(proj)
        t = res.buses["bus-1"].clearing_time_s
        assert t == pytest.approx(0.05, abs=0.005), (
            f"clearing time {t}s — 2.0 s indicates the one-hop device "
            "search regression (EE-6/PROT-3)"
        )

    def test_unprotected_bus_falls_back_to_2s(self):
        """A bus fed straight from the utility with no device on the infeed
        path keeps the IEEE 1584 2.0 s maximum."""
        proj = _project(
            components=[
                _utility(350.0),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[_wire("w1", "utility-1", "bus-1")])
        res = _arc_flash(proj)
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(2.0)

    def test_open_cb_does_not_clear(self):
        """An open CB on the only wired path blocks the walk; with no live
        infeed device the 2.0 s fallback applies (and the bus has no fault
        current anyway — guard that the walk skips open devices)."""
        proj = _project(
            components=[
                _utility(350.0),
                _comp("bus-1", "bus", {"name": "A", "voltage_kv": 11.0}),
                _comp("cb-1", "cb", {"name": "Feeder CB", "state": "closed",
                                     "trip_rating_a": 630,
                                     "magnetic_pickup": 10}),
                _comp("bus-2", "bus", {"name": "B", "voltage_kv": 11.0}),
            ],
            wires=[
                _wire("w1", "utility-1", "bus-1"),
                _wire("w2", "bus-1", "cb-1"),
                _wire("w3", "cb-1", "bus-2"),
            ])
        res = _arc_flash(proj)
        # bus-1: its only device neighbor (cb-1) leads downstream, not to a
        # source → unprotected utility infeed governs at 2.0 s
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(2.0)
        # bus-2 is cleared by cb-1 (closed, upstream of it)
        assert res.buses["bus-2"].clearing_time_s == pytest.approx(0.05, abs=0.005)

    def test_primary_cb_found_through_transformer_with_current_referral(self):
        """utility(33 kV) — CB — transformer 33/11 kV — bus(11 kV): the
        primary-side CB clears the secondary bus fault; the arcing current
        must be referred to the CB's voltage (I_CB = Iarc·11/33).

        Z ≈ 100/800 + 0.10·K_T·(100/20) ≈ 0.62 pu → Ik3 ≈ 9.3 kA at 11 kV,
        Iarc ≈ 9.1 kA. Referred to 33 kV: ≈ 3.0 kA < 6300 A instantaneous
        pickup → LT bucket (class 10) = 1.0 s. Without referral the CB
        would see 9.1 kA > 6.3 kA and wrongly report 0.05 s.
        """
        proj = _project(
            components=[
                _utility(800.0, kv=33.0),
                _comp("cb-1", "cb", {
                    "name": "HV CB", "state": "closed",
                    "trip_rating_a": 630, "magnetic_pickup": 10,
                    "long_time_delay": 10,
                }),
                _comp("transformer-1", "transformer", {
                    "name": "TX1", "rated_mva": 20.0, "z_percent": 10.0,
                    "x_r_ratio": 10.0, "voltage_hv_kv": 33.0,
                    "voltage_lv_kv": 11.0, "vector_group": "Dyn11",
                }),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[
                _wire("w1", "utility-1", "cb-1"),
                _wire("w2", "cb-1", "transformer-1"),
                _wire("w3", "transformer-1", "bus-1"),
            ])
        res = _arc_flash(proj)
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(1.0), (
            "expected the LT-delay bucket (1.0 s) — 0.05 s indicates the "
            "arcing current was not referred across the transformer; 2.0 s "
            "indicates the transformer was not traversed"
        )


# ── [PROT-1] gG fuse curve evaluation ────────────────────────────────────


class TestFuseClearing:
    def test_gg630_at_2ka_is_curve_limited_not_20ms(self):
        """Audit PROT-1 spot check: a gG 630 A fuse at ≈ 2 kA arcing current
        melts in ≈ 8 s per FUSE_CURVES_GG → total clearing capped at 2.0 s.
        The pre-fix code hardcoded 0.02 s (energy understated ×100).

        fault_mva = 34.64 → Ik3 ≈ 2.0 kA → Iarc ≈ 2.0 kA (MV Eq. 2).
        """
        proj = _project(
            components=[
                _utility(34.64),
                _comp("fuse-1", "fuse", {
                    "name": "F1", "fuse_type": "gG", "rated_current_a": 630,
                }),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[
                _wire("w1", "utility-1", "fuse-1"),
                _wire("w2", "fuse-1", "bus-1"),
            ])
        res = _arc_flash(proj)
        r = res.buses["bus-1"]
        assert 1.9 < r.arcing_current_ka < 2.1  # anchor the operating point
        assert r.clearing_time_s == pytest.approx(2.0), (
            f"clearing time {r.clearing_time_s}s — 0.02 s indicates the "
            "hardcoded fuse time regression (PROT-1)"
        )

    def test_gg630_current_limiting_region_is_fast(self):
        """Deep in the current-limiting region (Iarc ≈ 24 kA > the curve's
        16 kA last point) the same fuse clears in 0.008 s × 1.2 ≈ 0.01 s —
        no artificial floor is applied.

        fault_mva = 433 → Ik3 ≈ 25 kA → Iarc ≈ 23.9 kA.
        """
        proj = _project(
            components=[
                _utility(433.0),
                _comp("fuse-1", "fuse", {
                    "name": "F1", "fuse_type": "gG", "rated_current_a": 630,
                }),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[
                _wire("w1", "utility-1", "fuse-1"),
                _wire("w2", "fuse-1", "bus-1"),
            ])
        res = _arc_flash(proj)
        r = res.buses["bus-1"]
        assert r.arcing_current_ka > 20.0
        assert 0 < r.clearing_time_s < 0.1
        assert r.clearing_time_s == pytest.approx(0.0096, abs=0.003)

    def test_prearc_interpolation_matches_table_and_convention(self):
        """Unit anchors on the ported curve: exact table point, log-log
        interpolation between points, and infinity below the minimum
        operating current (frontend fuseTripTime convention)."""
        assert _fuse_prearc_time(630, 2000) == pytest.approx(8.0)
        # Log-log between [1600, 30] and [2000, 8]:
        t = _fuse_prearc_time(630, 1800)
        lo = 10 ** (math.log10(30) +
                    (math.log10(1800) - math.log10(1600)) /
                    (math.log10(2000) - math.log10(1600)) *
                    (math.log10(8) - math.log10(30)))
        assert t == pytest.approx(lo, rel=1e-6)
        assert math.isinf(_fuse_prearc_time(630, 500))
        # Non-tabulated rating scales geometrically from the nearest curve
        # (550 A → 500 A curve × 1.1): min operating point 800 × 1.1 = 880 A
        assert math.isinf(_fuse_prearc_time(550, 870))
        assert math.isfinite(_fuse_prearc_time(550, 900))


# ── [PROT-2] Relay resolution and IDMT evaluation ────────────────────────


class TestRelayClearing:
    """SI curve hand anchor: pickup 400 A, TMS 0.2, Iarc = 4 kA → M = 10 →
    t = 0.2·0.14/(10^0.02 − 1) = 0.594 s; + 0.08 s breaker = 0.674 s.

    fault_mva = 70.3 → Ik3 ≈ 4.06 kA → Iarc ≈ 4.00 kA (MV Eq. 2).
    """

    RELAY_PROPS = {
        "name": "R1", "relay_type": "50/51",
        "curve": "IEC Standard Inverse",
        "pickup_a": 400, "time_dial": 0.2, "inst_pickup_a": 0,
    }
    T_EXPECTED = 0.2 * 0.14 / (10 ** 0.02 - 1) + 0.08  # ≈ 0.674 s

    def _cb_project(self, relay_extra=None):
        return _project(
            components=[
                _utility(70.3),
                _comp("cb-1", "cb", {
                    "name": "CB1", "state": "closed",
                    "trip_rating_a": 630, "magnetic_pickup": 10,
                    "long_time_delay": 10,
                }),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
                _comp("relay-1", "relay",
                      {**self.RELAY_PROPS, "trip_cb": "cb-1",
                       **(relay_extra or {})}),
            ],
            wires=[
                _wire("w1", "utility-1", "cb-1"),
                _wire("w2", "cb-1", "bus-1"),
            ])

    def test_relay_via_trip_cb_drives_idmt_time(self):
        """The relay's SI curve governs the CB it trips — not the CB's own
        thermal-magnetic model (which would give 1.0 s here) and not the
        dead pre-fix heuristic (tds·0.1+0.08 = 0.1 s)."""
        res = _arc_flash(self._cb_project())
        r = res.buses["bus-1"]
        assert 3.9 < r.arcing_current_ka < 4.1  # anchor M ≈ 10
        assert r.clearing_time_s == pytest.approx(self.T_EXPECTED, abs=0.02)

    def test_relay_via_associated_ct_drives_idmt_time(self):
        """Same anchor with the relay resolved through its measuring CT on
        the wire path (relays have no ports — association props only)."""
        proj = _project(
            components=[
                _utility(70.3),
                _comp("ct-1", "ct", {"name": "CT1", "ratio": "400/5"}),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
                _comp("relay-1", "relay",
                      {**self.RELAY_PROPS, "associated_ct": "ct-1"}),
            ],
            wires=[
                _wire("w1", "utility-1", "ct-1"),
                _wire("w2", "ct-1", "bus-1"),
            ])
        res = _arc_flash(proj)
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(
            self.T_EXPECTED, abs=0.02)

    def test_relay_below_pickup_leaves_path_unprotected(self):
        """Iarc ≈ 4 kA ≤ pickup 8 kA with no instantaneous element: the
        relay never trips — the path counts as unprotected (2.0 s), not the
        CB's own model."""
        res = _arc_flash(self._cb_project({"pickup_a": 8000}))
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(2.0)

    def test_instantaneous_element_overrides_idmt(self):
        """Iarc ≈ 4 kA ≥ inst pickup 2 kA → inst delay 0.05 s + 0.08 s
        breaker = 0.13 s instead of the 0.674 s IDMT time."""
        res = _arc_flash(self._cb_project({"inst_pickup_a": 2000}))
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(0.13, abs=0.01)

    def test_definite_time_curve_is_time_dial_seconds(self):
        """Definite Time: operate time = time_dial seconds (+ breaker)."""
        res = _arc_flash(self._cb_project(
            {"curve": "Definite Time", "time_dial": 0.4}))
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(0.48, abs=0.01)

    def test_idmt_constants_hand_anchors(self):
        """Unit anchors per IEC 60255-151 at M = 10, TMS 0.2 (matching the
        frontend IDMT_CURVES constants)."""
        props = {"pickup_a": 400, "time_dial": 0.2, "inst_pickup_a": 0}
        si = _relay_operate_time({**props, "curve": "IEC Standard Inverse"}, 4000)
        assert si == pytest.approx(0.2 * 0.14 / (10 ** 0.02 - 1), rel=1e-6)
        vi = _relay_operate_time({**props, "curve": "IEC Very Inverse"}, 4000)
        assert vi == pytest.approx(0.2 * 13.5 / 9.0, rel=1e-6)
        ei = _relay_operate_time({**props, "curve": "IEC Extremely Inverse"}, 4000)
        assert ei == pytest.approx(0.2 * 80.0 / 99.0, rel=1e-6)
        # IEEE curves include the additive B constant: t = TDS·(A/(M^p−1)+B)
        mi = _relay_operate_time({**props, "curve": "IEEE Moderately Inverse"}, 4000)
        assert mi == pytest.approx(0.2 * (0.0515 / (10 ** 0.02 - 1) + 0.114), rel=1e-6)
        # At/below pickup the relay never operates
        assert _relay_operate_time({**props, "curve": "IEC Standard Inverse"}, 400) is None
        assert _relay_operate_time({**props, "curve": "IEC Standard Inverse"}, 100) is None
