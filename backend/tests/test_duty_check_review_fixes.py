"""Equipment duty check review — regression tests for DU1–DU3 and L1–L4.

References: IEC 60947-2 (Icu vs prospective current, Table 2, Icw),
IEC 60269 (fuse breaking capacity), IEC 62271-100 (Isc vs Ib, §4.101
asymmetry), IEC 62271-1 / IEC 60038 (Ur ≥ Um), IEC 60909-0 (fault currents).
IDs match the ``[DUn]`` / ``[Ln]`` markers in ``backend/analysis/duty_check.py``.
"""

import math

import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.duty_check import run_duty_check, highest_system_voltage_kv
from backend.analysis.fault import run_fault_analysis

C = lambda i, t, p: Component(id=i, type=t, x=0, y=0, props=p)
W = lambda i, a, b: Wire(id=i, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _dev(project, dev_id="d"):
    return next(d for d in run_duty_check(project)["devices"] if d["device_id"] == dev_id)


def _motor_bus(dev_type, rating, kv=0.4):
    """Grid → 2 MVA Dyn11 → LV bus with 2 × 800 kW motors → device → bus."""
    return ProjectData(projectName="m", baseMVA=100.0, frequency=50, components=[
        C("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
        C("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        C("t", "transformer", {"name": "T", "rated_mva": 2.0, "z_percent": 6, "x_r_ratio": 8,
                               "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "vector_group": "Dyn11"}),
        C("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        C("m1", "motor_induction", {"name": "M1", "rated_kw": 800, "voltage_kv": 0.4, "poles": 4}),
        C("m2", "motor_induction", {"name": "M2", "rated_kw": 800, "voltage_kv": 0.4, "poles": 4}),
        C("d", dev_type, {"name": "D", "rated_voltage_kv": 0.415, "rated_current_a": 400,
                          "breaking_capacity_ka": rating, "cb_type": "mccb", "state": "closed"}),
        C("b3", "bus", {"name": "LV2", "voltage_kv": 0.4}),
    ], wires=[W("1", "u", "b1"), W("2", "b1", "t"), W("3", "t", "b2"), W("4", "b2", "m1"),
              W("5", "b2", "m2"), W("6", "b2", "d"), W("7", "d", "b3")])


def _genset(icu):
    return ProjectData(projectName="g", baseMVA=100.0, frequency=50, components=[
        C("g", "generator", {"name": "G", "rated_mva": 1.0, "voltage_kv": 0.4, "xd_pp": 0.12,
                             "power_factor": 0.8, "dispatch_mode": "must_run"}),
        C("b", "bus", {"name": "B", "voltage_kv": 0.4}),
        C("d", "cb", {"name": "CB", "rated_voltage_kv": 0.415, "rated_current_a": 1600,
                      "breaking_capacity_ka": icu, "cb_type": "acb", "state": "closed"}),
        C("b2", "bus", {"name": "B2", "voltage_kv": 0.4}),
    ], wires=[W("1", "g", "b"), W("2", "b", "d"), W("3", "d", "b2")])


def _mv(icu=25.0, **cb):
    props = {"name": "CB", "rated_voltage_kv": 12, "rated_current_a": 630,
             "breaking_capacity_ka": icu, "cb_type": "mccb", "state": "closed"}
    props.update(cb)
    return ProjectData(projectName="v", baseMVA=100.0, frequency=50, components=[
        C("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 300, "x_r_ratio": 30}),
        C("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        C("d", "cb", props),
        C("b2", "bus", {"name": "MV2", "voltage_kv": 11}),
    ], wires=[W("1", "u", "b1"), W("2", "b1", "d"), W("3", "d", "b2")])


# ── DU1 ────────────────────────────────────────────────────────────────

class TestDU1ProspectiveBasisForLvAndFuses:
    """IEC 60947-2 Icu and IEC 60269 are rated against the prospective I″k;
    only an IEC 62271-100 MV breaker takes the decayed Ib. At a motor bus
    (I″k 65.1, Ib 52.1 kA) a 58.6 kA MCCB and fuse passed on Ib."""

    @pytest.mark.parametrize("kind", ["cb", "fuse"])
    def test_lv_device_judged_on_prospective(self, kind):
        fr = run_fault_analysis(_motor_bus("cb", 0), fault_type="3phase").buses["b2"]
        assert fr.ib < fr.ik3
        rating = (fr.ik3 + fr.ib) / 2
        d = _dev(_motor_bus(kind, rating))
        assert d["breaking_duty_ka"] >= fr.ik3 - 0.01
        assert d["interrupt_ok"] is False
        assert d["duty_basis"].startswith("ik_max")

    def test_mv_breaker_keeps_ib(self):
        d = _dev(_mv())
        assert d["duty_basis"].startswith("ib")


# ── DU2 ────────────────────────────────────────────────────────────────

class TestDU2LargestFaultType:
    """At an LV genset (Z0 = 0.5·Z1) Ik1 = 3/(2 + 0.5)·Ik3 = 1.2·Ik3 is the
    largest phase current. ikLLG (the earth current 3·I0 = 1.5·Ik3) is not a
    pole current and must not be used."""

    def test_uses_ik1_not_earth_current(self):
        fr = run_fault_analysis(_genset(0)).buses["b"]
        assert fr.ik1 == pytest.approx(1.2 * fr.ik3, rel=1e-3)
        assert fr.ikLLG > fr.ik1                      # the earth-current field
        d = _dev(_genset((fr.ik3 + fr.ik1) / 2))
        assert d["breaking_duty_ka"] == pytest.approx(fr.ik1, abs=0.01)
        assert d["interrupt_ok"] is False

    def test_making_uses_largest_current(self):
        fr = run_fault_analysis(_genset(0)).buses["b"]
        d = _dev(_genset(50))
        assert d["peak_fault_ka"] == pytest.approx(fr.kappa * math.sqrt(2) * fr.ik1, rel=1e-3)


# ── DU3 ────────────────────────────────────────────────────────────────

class TestDU3DistributionBoards:
    def test_device_on_board_checked(self):
        p = ProjectData(projectName="d", baseMVA=100.0, frequency=50, components=[
            C("u", "utility", {"name": "Grid", "voltage_kv": 0.4, "fault_mva": 30}),
            C("db", "distribution_board", {"name": "DB", "voltage_kv": 0.4, "rated_kva": 0}),
            C("d", "cb", {"name": "CB", "rated_voltage_kv": 0.415, "rated_current_a": 63,
                          "breaking_capacity_ka": 6, "cb_type": "mcb", "state": "closed"}),
            C("l", "static_load", {"name": "L", "rated_kva": 10}),
        ], wires=[W("1", "u", "db"), W("2", "db", "d"), W("3", "d", "l")])
        d = _dev(p)
        assert d["location_bus"] == "DB"
        assert d["interrupt_ok"] is False            # 6 kA MCB on a ~43 kA board


# ── L1–L4 ──────────────────────────────────────────────────────────────

class TestL1RatedVoltageVsUm:
    @pytest.mark.parametrize("un,um", [(3.3, 3.6), (6.6, 7.2), (11, 12), (22, 24),
                                       (33, 36), (66, 72.5), (132, 145), (0.4, 0.4)])
    def test_um(self, un, um):
        assert highest_system_voltage_kv(un) == um

    def test_nominal_rating_warns_below_nominal_fails(self):
        d = _dev(_mv(rated_voltage_kv=11))
        assert d["voltage_ok"] is True and d["status"] == "warning"
        assert any("Um" in i for i in d["issues"])
        assert _dev(_mv(rated_voltage_kv=12))["status"] == "pass"
        assert _dev(_mv(rated_voltage_kv=7.2))["voltage_ok"] is False


class TestL2ShortTimeWithstand:
    """IEC 60947-2 category B: I²·t_sd ≤ Icw²·t_cw."""

    def _acb(self, icw):
        p = _genset(100)
        for c in p.components:
            if c.id == "d":
                c.props.update(short_time_pickup=4, short_time_delay=0.4, instantaneous_pickup=0,
                               trip_rating_a=1600, icw_ka=icw, icw_time_s=1.0)
        return p

    def test_icw(self):
        i = run_fault_analysis(_genset(0)).buses["b"].ik1          # largest phase current
        need = i * math.sqrt(0.4 / 1.0)                            # Icw for 1 s
        assert _dev(self._acb(need * 0.95))["icw_ok"] is False
        assert _dev(self._acb(need * 1.05))["icw_ok"] is True


class TestL3ContactParting:
    def test_fast_breaker_gets_no_decay_credit(self):
        slow = _dev(_mv())
        fast = _dev(_mv(contact_parting_s=0.05))
        assert fast["duty_basis"].startswith("ik_max")
        assert fast["asym_duty_ka"] > slow["asym_duty_ka"]
        beta = math.exp(-0.05 / 0.045)
        assert fast["asym_capability_ka"] == pytest.approx(25 * math.sqrt(1 + 2 * beta ** 2), abs=0.01)


class TestL4AsymmetryMvOnly:
    def test_lv_breaker_has_no_62271_asym_check(self):
        assert _dev(_genset(50))["asym_ok"] is None
        assert _dev(_mv())["asym_ok"] is not None
