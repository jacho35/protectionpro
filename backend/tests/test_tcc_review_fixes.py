"""TCC review (2026-09-29) — backend regression tests for TC1-TC3.

The arc-flash engine mirrors the frontend TCC curves (constants.js), so each
curve defect lived in both. References are the standards' own gates, never
the previous output. Write-up: TCC_REVIEW.md; frontend twin:
frontend/tests/test_tcc_curves.mjs; evidence: testing/tcc-review/.
"""

import math

import pytest

from backend.analysis.arcflash import (
    _cb_self_clearing_time, _fuse_prearc_time, _relay_operate_time,
)

# IEC 60269-1 Table 3 gG gates: In -> (Imin(10 s), Imax(5 s), Imin(0.1 s), Imax(0.1 s))
_GATES = {16: (33, 65, 85, 150), 32: (75, 150, 200, 350), 63: (160, 320, 450, 820),
          100: (290, 580, 820, 1450), 200: (610, 1250, 1910, 3420),
          400: (1420, 2840, 4500, 8060), 630: (2200, 5100, 8060, 14140)}


class TestTC1FuseGates:
    """[TC1] The old single shape put 0.1 s at 8·In, reading Imin(0.1 s) as a
    'clears by' limit: from 100 A every rating pre-arced faster than the
    standard allows (100 A: 0.090 s at 820 A), understating arc-flash
    clearing time."""

    @pytest.mark.parametrize("rating", sorted(_GATES))
    def test_inside_all_gates(self, rating):
        i10, i5, i01a, i01b = _GATES[rating]
        assert _fuse_prearc_time(rating, i10) >= 10.0
        assert _fuse_prearc_time(rating, i5) <= 5.0
        assert _fuse_prearc_time(rating, i01a) >= 0.1
        assert _fuse_prearc_time(rating, i01b) <= 0.1

    def test_100a_at_its_0p1s_gate_is_not_faster_than_0p1s(self):
        # the headline case: 0.090 s before the fix
        assert _fuse_prearc_time(100, 820) > 0.1

    def test_400a_0p01s_i2t_inside_table7_corridor(self):
        # IEC 60269-1 Table 7: 0.76e6 (min pre-arcing) .. 2.25e6 (max operating)
        # A²s. Old table: 6300 A at 0.01 s = 0.40e6, below the minimum.
        i = 12000.0
        assert _fuse_prearc_time(400, i) == pytest.approx(0.01)
        assert 0.76e6 <= i * i * 0.01 <= 2.25e6


class TestTC2IdmtHold:
    """[TC2] IEC 60255-151 inverse characteristic ends at G_D = 20 x Gs;
    relays hold t(20). The pure equation kept falling — EI 84 % faster at
    50x than at 20x — shortening the arc-flash clearing time."""

    BASE = {"relay_type": "50/51", "pickup_a": 100, "time_dial": 0.2, "inst_pickup_a": 0}

    @pytest.mark.parametrize("curve,k,a", [("IEC Standard Inverse", 0.14, 0.02),
                                           ("IEC Very Inverse", 13.5, 1.0),
                                           ("IEC Extremely Inverse", 80.0, 2.0)])
    def test_held_at_20x(self, curve, k, a):
        props = {**self.BASE, "curve": curve}
        t20 = 0.2 * k / (20 ** a - 1)
        assert _relay_operate_time(props, 5000.0) == pytest.approx(t20)  # 50x
        assert _relay_operate_time(props, 2000.0) == pytest.approx(t20)  # 20x

    def test_limit_zero_is_pure_equation(self):
        props = {**self.BASE, "curve": "IEC Extremely Inverse", "idmt_max_multiple": 0}
        assert _relay_operate_time(props, 5000.0) == pytest.approx(0.2 * 80 / (50 ** 2 - 1))

    def test_custom_limit(self):
        props = {**self.BASE, "curve": "IEC Very Inverse", "idmt_max_multiple": 30}
        assert _relay_operate_time(props, 5000.0) == pytest.approx(0.2 * 13.5 / 29)

    def test_below_limit_unchanged(self):
        props = {**self.BASE, "curve": "IEC Standard Inverse"}
        assert _relay_operate_time(props, 1000.0) == pytest.approx(
            0.2 * 0.14 / (10 ** 0.02 - 1))


class TestTC3BreakerThermal:
    """[TC3] t = k/(M²−1) tripped at any M > 1: an MCB at 1.13 In in 21 min and
    an MCCB at 1.05 Ir in 57 min — both must hold for the conventional time
    (IEC 60898-1 Table 7, IEC 60947-2 Table 6)."""

    def _cb(self, cb_type, cls=10, rating=100.0):
        return {"cb_type": cb_type, "trip_rating_a": rating, "thermal_pickup": 1.0,
                "magnetic_pickup": 10.0, "long_time_delay": cls}

    def test_mcb_conventional_currents(self):
        p = self._cb("mcb", rating=16.0)
        assert _cb_self_clearing_time(p, 16 * 1.13) == 10000.0      # no trip
        assert _cb_self_clearing_time(p, 16 * 1.45) < 3600.0        # trips < 1 h
        assert 1.0 <= _cb_self_clearing_time(p, 16 * 2.55) <= 60.0  # 2.55 In gate

    @pytest.mark.parametrize("cls", [5, 10, 20, 30])
    def test_mccb_conventional_currents(self, cls):
        p = self._cb("mccb", cls)
        assert _cb_self_clearing_time(p, 105.0) == 10000.0          # 1.05 Ir: no trip
        assert _cb_self_clearing_time(p, 130.0) < 7200.0            # 1.30 Ir: trips
        assert _cb_self_clearing_time(p, 600.0) == pytest.approx(cls)  # class = s at 6 Ir
