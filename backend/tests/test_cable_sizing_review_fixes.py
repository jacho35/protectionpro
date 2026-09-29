"""Cable sizing review — regression tests for findings CS1–CS5 and N1–N6.

Each test reproduces the ORIGINAL defect against a reference taken from the
standard itself (IEC 60364-5-52, IEC 60364-4-43, IEC 60255-151, IEC 60909-0)
or from a hand calculation — never from the engine's earlier output. IDs match
the ``[CSn]`` / ``[Nn]`` markers in ``backend/analysis/cable_sizing.py``.
"""

import math

import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.cable_sizing import (
    run_cable_sizing, _get_cable_props, _k_factor, _ambient_factor,
)
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
from backend.analysis.arcflash import _relay_operate_time


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _k16(length=0.2, kv=0.4, **extra):
    props = {"name": "K1", "standard_type": "cu_xlpe_16_lv", "conductor": "Cu",
             "insulation": "XLPE", "size_mm2": 16, "r_per_km": 1.466, "x_per_km": 0.082,
             "rated_amps": 91, "length_km": length, "voltage_kv": kv}
    props.update(extra)
    return _c("k1", "cable", props)


def _lv(cable=None, cb_in=160, load_kva=50, tx_mva=1.0, tx_z=6.0):
    """Grid → 11 kV → transformer → 0.4 kV bus → MCCB → cable → bus → load."""
    return ProjectData(projectName="c", baseMVA=100.0, frequency=50, components=[
        _c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
        _c("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        _c("t1", "transformer", {"name": "T1", "rated_mva": tx_mva, "z_percent": tx_z,
                                 "x_r_ratio": 8, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                                 "vector_group": "Dyn11"}),
        _c("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        _c("cb", "cb", {"name": "CB1", "rated_current_a": cb_in, "trip_rating_a": cb_in,
                        "magnetic_pickup": 10, "cb_type": "mccb", "long_time_delay": 10,
                        "state": "closed"}),
        cable or _k16(),
        _c("b3", "bus", {"name": "LV2", "voltage_kv": 0.4}),
        _c("ld", "static_load", {"name": "L", "rated_kva": load_kva, "power_factor": 0.9}),
    ], wires=[_w("1", "u", "b1"), _w("2", "b1", "t1"), _w("3", "t1", "b2"), _w("4", "b2", "cb"),
              _w("5", "cb", "k1"), _w("6", "k1", "b3"), _w("7", "b3", "ld")])


def _row(p, name=None, **kw):
    rows = run_cable_sizing(p, **kw)["cables"]
    return rows[0] if name is None else next(r for r in rows if r["cable_name"] == name)


# ── CS1 ────────────────────────────────────────────────────────────────

class TestCS1VoltageDropOnSystemVoltage:
    """ΔV% = √3·I·L·(R cos φ + X sin φ)/U_n (IEC 60364-5-52 Annex G) with
    U_n the voltage the cable RUNS at. The cable's own voltage_kv is its
    rated class or the palette default 11 kV: an LV cable read 0.35 % where
    the drop is 9.49 %."""

    def _hand(self, p):
        lf = run_load_flow(p, "newton_raphson")
        br = next(b for b in lf.branches if b.elementId == "k1")
        pf = abs(br.p_mw) / br.s_mva
        return math.sqrt(3) * br.i_amps * 0.2 * (1.466 * pf + 0.082 * math.sqrt(1 - pf * pf)) / 400 * 100

    @pytest.mark.parametrize("cable_kv", [0.4, 11.0, 3.3])
    def test_drop_independent_of_cable_class(self, cable_kv):
        p = _lv(_k16(kv=cable_kv))
        r = _row(p)
        assert r["voltage_drop_pct"] == pytest.approx(self._hand(p), abs=0.01)
        assert r["system_kv"] == pytest.approx(0.4)


# ── CS2 ────────────────────────────────────────────────────────────────

def _mv_relay():
    return ProjectData(projectName="m", baseMVA=100.0, frequency=50, components=[
        _c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
        _c("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        _c("ct", "ct", {"name": "CT", "ratio_primary_a": 400, "ratio_secondary_a": 1}),
        _c("cb", "cb", {"name": "CB", "rated_current_a": 630, "magnetic_pickup": 10,
                        "cb_type": "mccb", "state": "closed"}),
        _c("rl", "relay", {"name": "R", "relay_type": "50/51", "associated_ct": "ct",
                           "trip_cb": "cb", "pickup_a": 200, "time_dial": 0.3,
                           "curve": "IEC Standard Inverse", "inst_pickup_a": 0}),
        _c("k1", "cable", {"name": "K1", "standard_type": "cu_xlpe_35_11kv", "conductor": "Cu",
                           "insulation": "XLPE", "size_mm2": 35, "r_per_km": 0.6681,
                           "x_per_km": 0.110, "rated_amps": 170, "length_km": 1.0,
                           "voltage_kv": 11}),
        _c("b2", "bus", {"name": "MV2", "voltage_kv": 11}),
        _c("ld", "static_load", {"name": "L", "rated_kva": 1000, "power_factor": 0.9}),
    ], wires=[_w("1", "u", "b1"), _w("2", "b1", "ct"), _w("3", "ct", "cb"), _w("4", "cb", "k1"),
              _w("5", "k1", "b2"), _w("6", "b2", "ld")])


class TestCS2ClearingTimeFromTheDevice:
    """A relay-tripped feeder clears on the relay's IEC 60255-151 curve,
    t = TMS·0.14/((I/Is)^0.02 − 1), not the breaker's own 50 ms. At 13.1 kA a
    200 A / TMS 0.3 SI relay needs ≈ 0.48 s, so 35 mm² XLPE (needs ≈ 67 mm²
    on the bare current alone) must fail; it passed."""

    def test_relay_curve_matches_iec_60255(self):
        props = {"relay_type": "50/51", "pickup_a": 200, "time_dial": 0.3,
                 "curve": "IEC Standard Inverse", "inst_pickup_a": 0}
        # 13120/200 = 65.6 x pickup: held at the 20 x time ([TC2], IEC
        # 60255-151 G_D) — the uncapped equation gave 0.48 s.
        assert _relay_operate_time(props, 13120.0) == pytest.approx(
            0.3 * 0.14 / (20 ** 0.02 - 1), rel=1e-9)

    def test_relay_protected_feeder_fails(self):
        p = _mv_relay()
        r = _row(p)
        ik = run_fault_analysis(p).buses["b1"].ik3 * 1000
        t_curve = 0.3 * 0.14 / ((ik / 200) ** 0.02 - 1)
        assert r["clearing_time_s"] >= t_curve            # curve + opening (+ CT)
        assert r["fault_withstand_ok"] is False
        assert r["status"] == "fail"
        assert ik * math.sqrt(t_curve) / 143 > 35         # the hand requirement

    def test_breaker_below_magnetic_uses_long_time_region(self):
        """Far-end fault below 10×Ir clears on the I²t long-time region
        (seconds), so it is judged on that time — not 50 ms."""
        from backend.analysis.cable_sizing import _device_trip_time
        cb = _c("cb", "cb", {"trip_rating_a": 160, "magnetic_pickup": 10,
                             "cb_type": "mccb", "long_time_delay": 10})
        # MCCB instantaneous total clearing, IEEE 1584 Table 1 (was 0.05, the
        # ACB figure — re-baselined in the compliance-review follow-up)
        assert _device_trip_time(cb, 5000.0, {}, {}, {}) == pytest.approx(0.025)
        assert _device_trip_time(cb, 800.0, {}, {}, {}) > 10.0


# ── CS3 ────────────────────────────────────────────────────────────────

class TestCS3OverloadProtection:
    """IEC 60364-4-43 §433.1: Ib ≤ In ≤ Iz and I2 ≤ 1.45·Iz. A 160 A MCCB on
    a 91 A cable passed with status 'pass'."""

    def _p(self, cb_in):
        return _lv(_k16(length=0.03), cb_in=cb_in, load_kva=40, tx_mva=0.2, tx_z=4.0)

    def test_oversized_breaker_fails(self):
        r = _row(self._p(160))
        assert r["overload_protection_ok"] is False
        assert r["status"] == "fail"
        assert any("§433.1" in i for i in r["issues"])

    def test_i2_rule_for_mccb(self):
        """MCCB I2 = 1.30·In: at In = 90 A ≤ Iz 91 A, I2 = 117 ≤ 1.45·91 = 132 → OK;
        at In = 100 A, In > Iz → fail."""
        assert _row(self._p(90))["overload_protection_ok"] is True
        assert _row(self._p(100))["overload_protection_ok"] is False

    def test_gg_fuse_i2(self):
        """gG fuse I2 = 1.6·In: In = 90 A ≤ Iz 91 A but I2 = 144 > 1.45·91 = 132 → fail."""
        p = self._p(90)
        p.components = [(_c("cb", "fuse", {"name": "F1", "rated_current_a": 90})
                         if c.id == "cb" else c) for c in p.components]
        r = _row(p)
        assert r["overload_protection_ok"] is False
        assert "I2" in r["overload_protection_note"]

    def test_recommendation_restores_coordination(self):
        """An oversized breaker also leaves the far-end minimum fault uncleared
        within 5 s; the fix is a cable with Iz ≥ In (§435.1), not "no size".
        Library 50 mm² Cu XLPE LV is rated 167 A: In 160 ≤ 167, I2 208 ≤ 242."""
        r = _row(_lv(_k16(length=0.1), cb_in=160, load_kva=20, tx_mva=0.2, tx_z=4.0))
        assert r["overload_protection_ok"] is False
        assert r["min_size_mm2"] == 50
        assert r["recommended_cable"].startswith("50mm² Cu XLPE 0.4")

    def test_not_applied_to_mv_or_relay_protected(self):
        assert _row(_mv_relay())["overload_protection_ok"] is None


# ── CS4 ────────────────────────────────────────────────────────────────

class TestCS4CumulativeVoltageDrop:
    """IEC 60364-5-52 §525: the limit is from the ORIGIN of the installation.
    Two cables of 2.7 % and 3.2 % both passed a 5 % limit; the load sees 5.9 %."""

    def test_series_cables_judged_from_origin(self):
        p = _lv(_k16(length=0.1), cb_in=80, load_kva=20, tx_mva=0.2, tx_z=4.0)
        p.components += [
            _c("k2", "cable", {"name": "K2", "conductor": "Cu", "insulation": "XLPE",
                               "size_mm2": 16, "r_per_km": 1.466, "x_per_km": 0.082,
                               "rated_amps": 91, "length_km": 0.35, "voltage_kv": 0.4}),
            _c("b4", "bus", {"name": "LV3", "voltage_kv": 0.4}),
            _c("ld2", "static_load", {"name": "L2", "rated_kva": 10, "power_factor": 0.9})]
        p.wires += [_w("8", "b3", "k2"), _w("9", "k2", "b4"), _w("10", "b4", "ld2")]
        rows = {r["cable_name"]: r for r in run_cable_sizing(p)["cables"]}
        lf = run_load_flow(p, "newton_raphson")
        hand = (lf.buses["b2"].voltage_pu - lf.buses["b4"].voltage_pu) * 100
        assert rows["K2"]["voltage_drop_pct"] < 5 and rows["K1"]["voltage_drop_pct"] < 5
        assert rows["K2"]["cumulative_voltage_drop_pct"] == pytest.approx(hand, abs=0.01)
        assert rows["K2"]["voltage_drop_origin"] == "LV"
        assert rows["K2"]["voltage_drop_ok"] is False
        assert rows["K1"]["voltage_drop_ok"] is True


# ── CS5 ────────────────────────────────────────────────────────────────

class TestRecommendationVoltageClass:
    def test_untyped_cable_recommended_at_system_class(self):
        """A cable with no library type carries only the palette's 11 kV
        default; its recommendation must be an LV cable on an LV feeder."""
        cable = _c("k1", "cable", {"name": "K1", "conductor": "Cu", "insulation": "XLPE",
                                   "size_mm2": 16, "r_per_km": 1.466, "x_per_km": 0.082,
                                   "rated_amps": 91, "length_km": 0.6, "voltage_kv": 11})
        r = _row(_lv(cable, cb_in=80, load_kva=20, tx_mva=0.2, tx_z=4.0))
        assert r["status"] == "fail"
        assert "0.4kV" in r["recommended_cable"]


class TestCS5LargestFaultCurrent:
    """§434.5.2 needs the largest fault current of any type; at a Dyn11 LV
    bus the earth faults exceed Ik3 (Ik1 40.4 vs Ik3 39.7 kA here)."""

    def test_sizes_on_largest_fault_type(self):
        p = ProjectData(projectName="g", baseMVA=100.0, frequency=50, components=[
            _c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 15}),
            _c("b1", "bus", {"name": "MV", "voltage_kv": 11}),
            _c("t1", "transformer", {"name": "T1", "rated_mva": 1.6, "z_percent": 6,
                                     "x_r_ratio": 8, "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                                     "vector_group": "Dyn11", "grounding_lv": "solidly"}),
            _c("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _k16(length=0.01, sizing_override={"clearing_time_s": 0.2}),
            _c("b3", "bus", {"name": "LV2", "voltage_kv": 0.4}),
        ], wires=[_w("1", "u", "b1"), _w("2", "b1", "t1"), _w("3", "t1", "b2"),
                  _w("4", "b2", "k1"), _w("5", "k1", "b3")])
        fb = run_fault_analysis(p).buses["b2"]
        largest = max(v for v in (fb.ik3, fb.ik1, fb.ikLL, fb.ikLLG) if v)
        assert largest > fb.ik3
        r = _row(p, adiabatic_basis="bare_isc")
        assert r["fault_withstand_ok"] is False
        assert f"Ik {largest:.2f}kA" in r["issues"][0]


# ── Lesser notes ───────────────────────────────────────────────────────

class TestN1NominalArea:
    def test_size_prop_wins_over_resistance(self):
        cp = _get_cable_props(_c("k", "cable", {"conductor": "Al", "insulation": "XLPE",
                                                "size_mm2": 95, "r_per_km": 0.4102}))
        assert cp["size_mm2"] == 95      # was 88.1 from r_per_km


class TestN2N3KFactor:
    """IEC 60364-4-43 Table 43A."""

    def test_pvc_above_300(self):
        assert _k_factor("Cu", "PVC", 400) == 103 and _k_factor("Al", "PVC", 400) == 68
        assert _k_factor("Cu", "PVC", 300) == 115 and _k_factor("Al", "PVC", 300) == 76

    def test_unlisted_insulation_takes_lowest(self):
        warn = []
        assert _k_factor("Al", "EPR", 95, warn, "K") == 76     # was 143
        assert warn


class TestN4N5AmbientFactor:
    """IEC 60364-5-52 Tables B.52.14 (air, 30 °C) and B.52.15 (ground, 20 °C)."""

    @pytest.mark.parametrize("ins,t,f", [("PVC", 25, 1.06), ("PVC", 40, 0.87), ("XLPE", 50, 0.82),
                                         ("XLPE", 60, 0.71)])
    def test_air_table(self, ins, t, f):
        assert _ambient_factor(ins, t, False) == pytest.approx(f)

    @pytest.mark.parametrize("ins,t,f", [("PVC", 20, 1.00), ("PVC", 30, 0.89), ("XLPE", 30, 0.93)])
    def test_ground_table(self, ins, t, f):
        assert _ambient_factor(ins, t, True) == pytest.approx(f)

    def test_no_invented_install_factor(self):
        """'flat' carried a 0.95 and 'buried' a 0.85 with no IEC basis."""
        p = _lv(_k16(length=0.03), cb_in=80, load_kva=40, tx_mva=0.2, tx_z=4.0)
        assert _row(p, install_method="flat")["derated_ampacity_a"] == pytest.approx(91.0)
        assert _row(p, install_method="buried", ambient_temp_c=20)["derated_ampacity_a"] == pytest.approx(91.0)

    def test_library_path_disclosed(self):
        p = _lv(_k16(length=0.03), cb_in=80, load_kva=40, tx_mva=0.2, tx_z=4.0)
        assert any("grouping not applied" in w for w in _row(p)["warning_reasons"])


class TestN6OverheadDisclosure:
    def test_overhead_rating_labelled_approximate(self):
        p = _lv(_c("k1", "cable", {"name": "OH", "construction": "overhead",
                                   "overhead_type": "acsr_dog", "size_mm2": 100,
                                   "r_per_km": 0.2733, "x_per_km": 0.350, "rated_amps": 305,
                                   "length_km": 0.2, "voltage_kv": 0.4}), cb_in=80, load_kva=20)
        assert "approximate" in _row(p)["ampacity_conditions"]
