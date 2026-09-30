"""Breaker trip-unit profiles (frontend tripunit.js) — the backend side.

An MCCB picked with an electronic trip-unit profile carries
``trip_unit_kind: "electronic"``; its short-time / instantaneous settings (×Ir)
must then act in the clearing-time model exactly as an ACB's do, with the
MCCB's own instantaneous clearing time (IEEE 1584 Table 1: 1.5 cycles). A
breaker without the prop keeps the thermal-magnetic model. Cable sizing
reports each cable's protective device and parallel count, which the panel's
Ir suggestion (Ib ≤ Ir ≤ Iz) reads.
"""

import pytest

from backend.analysis.arcflash import (
    _cb_self_clearing_time, _cb_has_electronic_trip, _BREAKER_OPENING_TIME_S,
)
from backend.tests.test_cable_sizing_review_fixes import _lv, _row

# 400 A electronic MCCB: Ir = 400 A, Isd = 4 × Ir = 1600 A @ 0.2 s,
# Ii = 10 × Ir = 4000 A (magnetic mirrors the instantaneous dial)
ETU = {"cb_type": "mccb", "trip_rating_a": 400, "thermal_pickup": 1.0,
       "magnetic_pickup": 10, "long_time_delay": 10,
       "short_time_pickup": 4, "short_time_delay": 0.2, "instantaneous_pickup": 10,
       "trip_unit": "etu_lsi_mccb", "trip_unit_kind": "electronic"}


class TestElectronicMccb:
    def test_kind_gates_the_electronic_model(self):
        assert _cb_has_electronic_trip(ETU)
        assert _cb_has_electronic_trip({"cb_type": "acb"})
        assert not _cb_has_electronic_trip({**ETU, "trip_unit_kind": "tm"})
        assert not _cb_has_electronic_trip({k: v for k, v in ETU.items() if k != "trip_unit_kind"})
        assert not _cb_has_electronic_trip({"cb_type": "mcb", "trip_unit_kind": "electronic"})

    def test_short_time_band(self):
        # 2000 A: above Isd (1600 A), below Ii (4000 A) → tsd + opening time
        assert _cb_self_clearing_time(ETU, 2000.0) == pytest.approx(0.2 + _BREAKER_OPENING_TIME_S)

    def test_instantaneous_uses_mccb_clearing_time(self):
        # 5000 A ≥ Ii: moulded-case integral trip, 0.025 s (not the ACB 0.05 s)
        assert _cb_self_clearing_time(ETU, 5000.0) == pytest.approx(0.025)

    def test_legacy_mccb_unchanged(self):
        # The same settings without trip_unit_kind: short-time ignored, so
        # 2000 A sits in the thermal region (below Im = 4000 A) — as before
        legacy = {k: v for k, v in ETU.items() if k not in ("trip_unit", "trip_unit_kind")}
        t = _cb_self_clearing_time(legacy, 2000.0)
        m, mnt = 2000.0 / 400.0, 1.05
        assert t == pytest.approx(10 * (36 - mnt * mnt) / (m * m - mnt * mnt))

    def test_short_time_off_matches_thermal_magnetic(self):
        # Profile default (Isd off, Ii = magnetic = 10): identical curve to the
        # thermal-magnetic MCCB the library gave before profiles
        etu_off = {**ETU, "short_time_pickup": 0}
        legacy = {k: v for k, v in etu_off.items() if k not in ("trip_unit", "trip_unit_kind")}
        for i in (600.0, 2000.0, 3999.0, 4000.0, 9000.0):
            assert _cb_self_clearing_time(etu_off, i) == pytest.approx(_cb_self_clearing_time(legacy, i))


class TestCableSizingReportsDevice:
    def test_protective_device_and_parallel_count(self):
        r = _row(_lv())
        assert r["protective_device_id"] == "cb"
        assert r["num_parallel"] == 1
