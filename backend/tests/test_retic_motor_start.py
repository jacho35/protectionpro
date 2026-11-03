"""Demand motor starting check — same criteria as the static Motor Starting study."""
import pytest
from backend.analysis.retic_motor_start import run_retic_motor_start

CABLE = {"r_per_km": 0.32, "x_per_km": 0.08}


def _case(motor, feeder_m=150):
    return {
        "minisubs": [{"id": "ms", "tx": {"kva": 500, "zPercent": 5, "xrRatio": 5, "vLvKv": 0.42}}],
        "kiosks": [{"id": "k", "fedFrom": "ms", "feeder": {"cable": CABLE, "lengthM": feeder_m}}],
        "motors": [{"id": "m", "name": "Pump", "supplyId": "k", "kw": 55, "volt": 400, "phases": 3,
                    "pf": 0.85, "eff": 0.93, "lrc": 6, "method": "DOL", "lengthM": 40, "cable": CABLE, **motor}],
    }


def test_dol_vs_star_delta_dip():
    dol = run_retic_motor_start(_case({}))["motors"][0]
    sd = run_retic_motor_start(_case({"method": "Star-delta"}))["motors"][0]
    assert dol["terminalVoltagePu"] < sd["terminalVoltagePu"]
    assert dol["startCurrentA"] == pytest.approx(3 * sd["startCurrentA"], rel=0.01)
    assert dol["status"] == "pass"


def test_weak_supply_fails():
    r = run_retic_motor_start(_case({"kw": 160}, feeder_m=900))["motors"][0]
    assert r["status"] == "fail" and not r["willStart"]
    assert any("p.u." in i or "collapse" in i for i in r["issues"])


def test_no_transformer_is_info_and_single_phase_skipped():
    d = _case({})
    d["minisubs"][0]["tx"] = None
    assert run_retic_motor_start(d)["motors"][0]["status"] == "info"
    assert run_retic_motor_start(_case({"phases": 1}))["motors"][0]["status"] == "info"
