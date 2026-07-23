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
    _BREAKER_OPENING_TIME_S,
)
from backend.analysis.ct_model import ct_saturation_params, ct_effective_current


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
        Iarc ≈ 9.1 kA. Referred to 33 kV: ≈ 3.0 kA < the 5600 A magnetic
        pickup → thermal region t = k/(M²−1) ([PS-9] — the frontend TCC
        model), landing well inside (0, 2) s. Without referral the CB would
        see 9.1 kA ≥ 5.6 kA and wrongly report 0.05 s; without traversing
        the transformer at all the bus would fall back to the 2.0 s cap.
        """
        proj = _project(
            components=[
                _utility(800.0, kv=33.0),
                _comp("cb-1", "cb", {
                    "name": "HV CB", "state": "closed",
                    "trip_rating_a": 280, "magnetic_pickup": 20,
                    "long_time_delay": 5,
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
        r = res.buses["bus-1"]
        # Expected thermal time from the CB's own curve at the REFERRED
        # current: M = Iarc·(11/33)/Ir, t = k/(M²−1) with k = class×35.
        i_ref = r.arcing_current_ka * 1000.0 * 11.0 / 33.0
        m = i_ref / 280.0
        t_expected = 5 * 35 / (m * m - 1.0)
        assert 0.1 < t_expected < 1.9, "test setup drifted out of the discriminating band"
        assert r.clearing_time_s == pytest.approx(t_expected, abs=2e-3), (
            "expected the referred-current thermal time — 0.05 s indicates "
            "the arcing current was not referred across the transformer; "
            "2.0 s indicates the transformer was not traversed"
        )


# ── [PROT-1] gG fuse curve evaluation ────────────────────────────────────


class TestFuseClearing:
    def test_gg630_at_2ka_is_curve_limited_not_20ms(self):
        """Audit PROT-1 spot check: a gG 630 A fuse at ≈ 2 kA arcing current
        melts in ≈ 8 s per FUSE_CURVES_GG → total clearing capped at 2.0 s.
        The pre-fix code hardcoded 0.02 s (energy understated ×100).

        fault_mva = 38.1 → Ik3 = 38.1/(√3·11) ≈ 2.0 kA → Iarc ≈ 2.0 kA
        (MV Eq. 2). [EE-4] Z_Q now includes c, so the declared fault level
        is reproduced exactly at the connection point.
        """
        proj = _project(
            components=[
                _utility(38.1),
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
        16 kA last point) the same fuse clears in 0.004 s × 1.2 ≈ 0.005 s —
        no artificial floor is applied. (The 0.1 s-gate re-fit, PROT-21,
        lowered the curve's last pre-arcing point from 0.008 s to 0.004 s.)

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
        assert r.clearing_time_s == pytest.approx(0.0048, abs=0.002)

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

    fault_mva = 77.3 → Ik3 = 77.3/(√3·11) ≈ 4.06 kA → Iarc ≈ 4.00 kA
    (MV Eq. 2). [EE-4] Z_Q now includes c, so the declared fault level is
    reproduced exactly at the connection point.
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
                _utility(77.3),
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
        the wire path (relays have no ports — association props only).

        accuracy_class 5P40 gives this CT ample saturation headroom at the
        ~4 kA anchor current (see TestCTSaturation for the undersized-CT
        case) — this test is about associated_ct RESOLUTION, not
        saturation, so it deliberately isolates that variable."""
        proj = _project(
            components=[
                _utility(77.3),
                _comp("ct-1", "ct", {"name": "CT1", "ratio": "400/5",
                                      "accuracy_class": "5P40"}),
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


# ── [PS-9 residual] CT saturation now reaches the backend relay evaluation ──


class TestCTSaturation:
    """The backend relay/TCC clearing-time evaluation now runs the arcing
    current through the same CT saturation model the frontend TCC applies
    (ct_model.py) before evaluating the IDMT curve, and derates the
    saturation threshold by the fault point's IEC 60909 peak factor kappa
    (a bounded dc-offset/asymmetry proxy — see ct_model.py docstring).

    Formula unit anchors live in test_ct_model.py; this file cross-checks
    the WIRING — that run_arc_flash actually feeds the pipeline's own
    kappa and arcing current into the CT model and that this measurably
    slows (not speeds up) the reported clearing time, closing the
    previously non-conservative gap.
    """

    RELAY_PROPS = TestRelayClearing.RELAY_PROPS
    T_UNSATURATED = TestRelayClearing.T_EXPECTED  # ≈0.674 s, no CT in path

    def _proj(self, ct_props):
        return _project(
            components=[
                _utility(77.3),  # x_r_ratio=15 -> kappa ≈1.82 (see _utility())
                _comp("ct-1", "ct", {"name": "CT1", **ct_props}),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
                _comp("relay-1", "relay",
                      {**self.RELAY_PROPS, "associated_ct": "ct-1"}),
            ],
            wires=[
                _wire("w1", "utility-1", "ct-1"),
                _wire("w2", "ct-1", "bus-1"),
            ])

    def test_default_ct_saturates_under_typical_xr_and_slows_clearing(self):
        """A default 400/5 5P20 CT has ample SYMMETRIC headroom at the
        ~4 kA anchor current (I_sat_symmetric=6400A > 4kA — this is why
        test_relay_via_associated_ct_drives_idmt_time with the SAME ratio
        needed an explicit 5P40 override to stay unsaturated once kappa
        derating was added). Left at the default 5P20 with the utility's
        default x_r_ratio=15 (kappa≈1.82), the derated threshold
        (≈3513A) sits BELOW the ~4kA arcing current — the relay now sees
        a clipped, reduced current and trips slower than the
        no-saturation anchor, the non-conservative gap this closes.
        """
        ct_props = {"ratio": "400/5"}
        proj = self._proj(ct_props)
        fault_results = run_fault_analysis(proj)
        res = run_arc_flash(proj, fault_results)
        r = res.buses["bus-1"]

        kappa = fault_results.buses["bus-1"].kappa
        assert kappa is not None and kappa > 1.5  # sanity: meaningfully offset

        sat = ct_saturation_params(ct_props, kappa=kappa)
        assert sat["i_sat_primary"] < r.arcing_current_ka * 1000  # confirms saturating

        # The fix must make clearing SLOWER (more conservative), not faster.
        assert r.clearing_time_s > self.T_UNSATURATED + 0.005

        # Cross-check the exact wiring: reproduce the pipeline's own
        # relay-operate-time call using the actual kappa/arcing current it
        # computed, and confirm run_arc_flash's reported clearing_time_s
        # matches (i.e. the saturation model is genuinely in the loop, not
        # coincidentally slower for some other reason).
        t_relay = _relay_operate_time(self.RELAY_PROPS, r.arcing_current_ka * 1000,
                                      ct_props, kappa)
        expected_t_clear = min(t_relay + _BREAKER_OPENING_TIME_S, 2.0)
        assert r.clearing_time_s == pytest.approx(expected_t_clear, abs=0.005)

    def test_ample_alf_ct_matches_unsaturated_anchor(self):
        """A well-sized 5P40 CT (same one used to isolate the association-
        resolution test) stays within its derated threshold at this fault
        level and reproduces the plain no-saturation anchor time."""
        proj = self._proj({"ratio": "400/5", "accuracy_class": "5P40"})
        res = run_arc_flash(proj, run_fault_analysis(proj))
        assert res.buses["bus-1"].clearing_time_s == pytest.approx(
            self.T_UNSATURATED, abs=0.02)

    def test_severely_undersized_ct_hits_max_clearing_time(self):
        """A CT with almost no accuracy headroom (5P5, high burden) clips
        so hard the relay's effective current can fall below its pickup —
        the path degrades toward the unprotected 2.0 s ceiling rather than
        a modest slowdown."""
        proj = self._proj({"ratio": "400/5", "accuracy_class": "5P5",
                            "burden_va": 60})
        res = run_arc_flash(proj, run_fault_analysis(proj))
        assert res.buses["bus-1"].clearing_time_s > self.T_UNSATURATED + 0.1
        assert res.buses["bus-1"].clearing_time_s <= 2.0
