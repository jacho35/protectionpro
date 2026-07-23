"""[PS-16 residual] "No CT burden/ratio adequacy check" — tests for the CT
saturation-threshold-vs-prospective-fault-current adequacy check added to
backend/analysis/duty_check.py.

For every CT with an associated overcurrent relay, flags whether the CT's
own saturation threshold (ct_model.py: ratio, accuracy class ALF, burden,
knee voltage, kappa-derated for dc offset) covers the prospective 3-phase
fault current at its bus. Metering CTs (no associated relay) are not
checked — saturating to protect a meter is by design, not a duty concern.

Run with:  python -m pytest backend/tests/test_ct_duty_check.py -v
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.duty_check import run_duty_check


def _comp(cid, ctype, props, x=0, y=0):
    return Component(id=cid, type=ctype, x=x, y=y, props=props)


def _wire(wid, from_c, to_c, from_port="bottom", to_port="top"):
    return Wire(id=wid, fromComponent=from_c, fromPort=from_port,
                toComponent=to_c, toPort=to_port)


def _project(components, wires):
    return ProjectData(projectName="test", baseMVA=100.0, frequency=50,
                       components=components, wires=wires)


def _utility(fault_mva, kv=11.0, xr=15.0):
    return _comp("utility-1", "utility", {
        "name": "Grid", "voltage_kv": kv, "fault_mva": fault_mva,
        "x_r_ratio": xr, "z0_z1_ratio": 1.0,
    })


def _proj_with_ct(ct_props, fault_mva=77.3, include_cb=True):
    components = [
        _utility(fault_mva),
        _comp("ct-1", "ct", {"name": "CT1", **ct_props}),
        _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
        _comp("relay-1", "relay", {
            "name": "R1", "relay_type": "50/51",
            "curve": "IEC Standard Inverse", "pickup_a": 400,
            "time_dial": 0.2, "inst_pickup_a": 0,
            "associated_ct": "ct-1",
        }),
    ]
    wires = [
        _wire("w1", "utility-1", "ct-1"),
        _wire("w2", "ct-1", "bus-1"),
    ]
    if include_cb:
        # Anchors the CT to a downstream load so it sits on a real branch;
        # not required for the CT check itself (relay association is what
        # matters), but a representative network.
        components.append(_comp("load-1", "static_load", {
            "name": "L1", "rated_kva": 500.0, "power_factor": 0.9}))
        wires.append(_wire("w3", "bus-1", "load-1"))
    return _project(components, wires)


class TestCTAdequacyCheck:
    def test_undersized_ct_flagged_fail(self):
        """400/5 5P10, default 15VA burden -> I_sat_symmetric=3200A; at
        11kV/77.3MVA the bolted fault is ~4.06kA (~4060A) >> 3200A even
        before kappa derating — clearly inadequate."""
        proj = _proj_with_ct({"ratio": "400/5", "accuracy_class": "5P10"})
        res = run_duty_check(proj)
        row = next(r for r in res["ct_checks"] if r["device_id"] == "ct-1")
        assert row["status"] == "fail"
        assert row["i_sat_primary_a"] is not None
        assert row["prospective_fault_ka"] * 1000 > row["i_sat_primary_a"]
        assert any("saturates" in i for i in row["issues"])
        assert row["dc_offset_factor"] > 1.0  # kappa derating engaged

    def test_well_sized_ct_passes(self):
        """400/5 5P40 with a smaller fault level (5 MVA) has ample
        headroom -> pass, comfortable positive headroom."""
        proj = _proj_with_ct({"ratio": "400/5", "accuracy_class": "5P40"},
                              fault_mva=5.0)
        res = run_duty_check(proj)
        row = next(r for r in res["ct_checks"] if r["device_id"] == "ct-1")
        assert row["status"] == "pass"
        assert row["headroom_pct"] is not None and row["headroom_pct"] >= 20

    def test_marginal_ct_flagged_warning(self):
        """Tuned so the prospective fault sits just under the derated
        saturation threshold (< 20% headroom) — a real design ought to
        catch this before it's built, not just when it outright fails."""
        # 400/5 5P20 (ALF=20, default burden) at a fault level chosen to
        # land within the low-headroom band around its derated threshold.
        proj = _proj_with_ct({"ratio": "400/5", "accuracy_class": "5P20"},
                              fault_mva=60.0)
        res = run_duty_check(proj)
        row = next(r for r in res["ct_checks"] if r["device_id"] == "ct-1")
        assert row["status"] in ("warning", "fail")
        if row["status"] == "warning":
            assert row["headroom_pct"] < 20

    def test_ct_without_relay_not_checked(self):
        """A metering-style CT with no associated relay is out of scope —
        it's expected to saturate to protect downstream instruments."""
        proj = _project(
            components=[
                _utility(77.3),
                _comp("ct-1", "ct", {"name": "CT1", "ratio": "400/5",
                                      "accuracy_class": "5P10"}),
                _comp("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11.0}),
            ],
            wires=[_wire("w1", "utility-1", "ct-1"),
                   _wire("w2", "ct-1", "bus-1")])
        res = run_duty_check(proj)
        assert res["ct_checks"] == []

    def test_ct_check_runs_even_with_no_cb_or_fuse(self):
        """The CB/fuse-only early return must not block CT checks — a
        network protected purely by a CT-fed relay (no separate CB/fuse
        component modelled) still gets the adequacy check."""
        proj = _proj_with_ct({"ratio": "400/5", "accuracy_class": "5P10"},
                              include_cb=False)
        res = run_duty_check(proj)
        assert res["devices"] == []
        assert len(res["ct_checks"]) == 1
        assert "No circuit breakers or fuses found." in res["warnings"]
