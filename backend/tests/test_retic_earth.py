"""Reticulation earth-fault loop + ECC check (analysis/retic_earth.py).

Hand calculations: 500 kVA, 4.5 %, X/R 6, 420 V transformer →
Ze = 0.045·420²/500000 = 0.015876 Ω (R = 0.002 Ω-ish, X = 6R).
"""
import math

import pytest

from backend.analysis.retic_earth import run_retic_earth_check

CU95 = {"name": "95mm² Cu XLPE LV", "size_mm2": 95, "conductor": "Cu", "insulation": "XLPE",
        "r_per_km": 0.2461, "x_per_km": 0.08}
CU16 = {"name": "16mm² Cu XLPE LV", "size_mm2": 16, "conductor": "Cu", "insulation": "XLPE",
        "r_per_km": 1.466, "x_per_km": 0.09}
CU25_E = {"name": "25mm² H07V-R Cu", "size_mm2": 25, "conductor": "Cu", "insulation": "PVC",
          "r_per_km": 0.87, "x_per_km": 0}
AL16_E = {"name": "16mm² Al", "size_mm2": 16, "conductor": "Al", "insulation": "PVC",
          "r_per_km": 2.3, "x_per_km": 0}
TX500 = {"kva": 500, "zPercent": 4.5, "xrRatio": 6.0, "vLvKv": 0.42}
GG200 = {"kind": "fuse", "name": "gG 200A", "props": {"rated_current_a": 200}}
MCCB400 = {"kind": "cb", "name": "MCCB 400A", "props": {
    "cb_type": "mccb", "trip_rating_a": 400, "thermal_pickup": 1.0, "magnetic_pickup": 10, "long_time_delay": 10}}


def req(device=GG200, feeder_len=100, svc_len=30, svc_earth=CU25_E, feeder_earth=CU25_E, svc=CU16):
    return {
        "settings": {},
        "minisubs": [{"id": "source", "name": "MS1", "tx": TX500, "device": device}],
        "kiosks": [{"id": "k1", "name": "K1", "fedFrom": "source",
                    "feeder": {"cable": CU95, "earth": feeder_earth, "lengthM": feeder_len},
                    "erfs": [{"id": "e1", "erfNumber": "1",
                              "service": {"cable": svc, "earth": svc_earth, "lengthM": svc_len}}]}],
    }


def test_loop_impedance_matches_hand_calc():
    res = run_retic_earth_check(req())
    erf = res["kiosks"][0]["erfs"][0]["loop"]
    ze = 0.045 * 420 ** 2 / 500000
    r = ze / math.sqrt(1 + 36)
    z = complex(r, 6 * r)
    z += complex((0.2461 + 0.87) * 0.1, 0.08 * 0.1)      # feeder: phase + earth, 100 m
    z += complex((1.466 + 0.87) * 0.03, 0.09 * 0.03)     # service, 30 m
    assert erf["zsOhm"] == pytest.approx(abs(z), abs=1e-3)
    assert erf["ifA"] == pytest.approx(0.95 * 230 / abs(z), abs=1)


def test_fuse_clears_a_healthy_fault_within_five_seconds():
    res = run_retic_earth_check(req())
    erf = res["kiosks"][0]["erfs"][0]
    assert erf["loop"]["status"] == "pass"
    assert 0 < erf["loop"]["tS"] <= 5.0
    assert erf["loop"]["zsMaxOhm"] > erf["loop"]["zsOhm"]


def test_long_service_fails_disconnection():
    res = run_retic_earth_check(req(device=MCCB400, svc_len=900))
    erf = res["kiosks"][0]["erfs"][0]
    assert erf["loop"]["status"] == "fail"
    assert res["status"] == "fail"


def test_no_device_is_info_not_pass():
    res = run_retic_earth_check(req(device=None))
    assert res["kiosks"][0]["erfs"][0]["loop"]["status"] == "info"


def test_ecc_table_route_16mm_phase_needs_16():
    # 16 mm² phase → Table 54.7 requires 16 mm²; a 25 mm² earth passes, aluminium 16 (needs ~25 equiv) fails.
    ok = run_retic_earth_check(req(svc_earth=CU25_E))["kiosks"][0]["erfs"][0]["ecc"]
    assert ok["tableMm2"] == 16.0 and ok["status"] == "pass"
    bad = run_retic_earth_check(req(svc_earth=AL16_E))["kiosks"][0]["erfs"][0]["ecc"]
    assert bad["tableMm2"] == 35.0           # 16 mm² Cu ≈ 26 mm² Al (ρ ratio 1.64), next standard size
    assert bad["status"] in ("fail", "pass")  # adiabatic route may still pass; table route must not
    assert bad["byTable"] is False


def test_missing_earth_is_assumed_and_flagged():
    ecc = run_retic_earth_check(req(svc_earth=None))["kiosks"][0]["erfs"][0]["ecc"]
    assert ecc["assumed"] is True
    assert ecc["status"] == "info"
    assert ecc["sizeMm2"] == 16.0


def test_adiabatic_size_follows_sqrt_i2t_over_k():
    ecc = run_retic_earth_check(req(device=MCCB400))["kiosks"][0]["erfs"][0]["ecc"]
    k = 115.0                       # Cu, PVC (Table 54.3)
    expect = math.sqrt(ecc["adiabaticI"] ** 2 * ecc["adiabaticT"]) / k
    assert ecc["adiabaticMm2"] == pytest.approx(expect, abs=0.1)


def test_chained_kiosks_accumulate_impedance():
    r = req()
    r["kiosks"].append({"id": "k2", "name": "K2", "fedFrom": "k1",
                        "feeder": {"cable": CU95, "earth": CU25_E, "lengthM": 100}, "erfs": []})
    res = run_retic_earth_check(r)
    z1 = res["kiosks"][0]["loop"]["zsOhm"]
    z2 = res["kiosks"][1]["loop"]["zsOhm"]
    assert z2 > z1


def test_no_transformer_is_info():
    r = req()
    r["minisubs"][0]["tx"] = None
    res = run_retic_earth_check(r)
    assert res["kiosks"][0]["loop"]["status"] == "info"


def test_endpoint_roundtrip():
    from fastapi.testclient import TestClient
    from backend.main import app
    # auth is required on /api/*; the engine itself is covered above — just make sure the route exists
    c = TestClient(app)
    assert c.post("/api/analysis/retic-earth-check", json=req()).status_code in (200, 401)


def test_tns_has_separate_earth_on_feeder_and_service():
    res = run_retic_earth_check(req())
    k = res["kiosks"][0]
    assert k["earthing"] == "TN-S"
    assert not k["ecc"].get("pen") and not k["erfs"][0]["ecc"].get("pen")


def test_tnc_uses_pen_everywhere_and_skips_ecc():
    r = req(); r["minisubs"][0]["earthing"] = "TN-C"
    k = run_retic_earth_check(r)["kiosks"][0]
    assert k["ecc"]["pen"] and k["erfs"][0]["ecc"]["pen"]
    # PEN return = the phase conductor size → loop R doubles the phase R
    ze = 0.045 * 420 ** 2 / 500000
    rr = ze / math.sqrt(37)
    z = complex(rr, 6 * rr) + complex(2 * 0.2461 * 0.1, 0.08 * 0.1) + complex(2 * 1.466 * 0.03, 0.09 * 0.03)
    assert k["erfs"][0]["loop"]["zsOhm"] == pytest.approx(abs(z), abs=1e-3)


def test_tncs_pen_on_feeders_separate_earth_on_services():
    r = req(); r["minisubs"][0]["earthing"] = "TN-C-S"
    k = run_retic_earth_check(r)["kiosks"][0]
    assert k["ecc"]["pen"] is True
    assert not k["erfs"][0]["ecc"].get("pen")
    assert k["erfs"][0]["ecc"]["sizeMm2"] == 25          # the chosen service earth


def test_pen_below_minimum_fails():
    r = req(svc=CU16); r["minisubs"][0]["earthing"] = "TN-C"
    r["kiosks"][0]["feeder"]["cable"] = {**CU16, "size_mm2": 6, "name": "6mm²"}
    k = run_retic_earth_check(r)["kiosks"][0]
    assert k["ecc"]["status"] == "fail"


def test_kiosk_device_overrides_and_is_inherited():
    small = {"kind": "fuse", "name": "gG 63A", "props": {"rated_current_a": 63}}
    r = req(device=MCCB400)
    r["kiosks"][0]["device"] = small
    r["kiosks"].append({"id": "k2", "name": "K2", "fedFrom": "k1",
                        "feeder": {"cable": CU95, "earth": CU25_E, "lengthM": 100},
                        "erfs": [{"id": "e2", "erfNumber": "2",
                                  "service": {"cable": CU16, "earth": CU25_E, "lengthM": 30}}]})
    res = run_retic_earth_check(r)
    k1, k2 = res["kiosks"]
    assert k1["device"] == "gG 63A" and k2["device"] == "gG 63A"        # K2 inherits K1's
    # the small fuse clears a fault the 400 A MCCB would not
    assert k1["erfs"][0]["loop"]["status"] == "pass"
    r2 = req(device=MCCB400)
    assert run_retic_earth_check(r2)["kiosks"][0]["erfs"][0]["loop"]["status"] == "fail"


def test_service_cable_is_checked_against_its_own_protection():
    """Outgoing way protection: the erf's device (not the string breaker)
    judges the service cable's loop; none given falls back to the string."""
    from backend.analysis.retic_earth import run_retic_earth_check
    mccb = {"cb_type": "mccb", "trip_rating_a": 160, "thermal_pickup": 1.0,
            "magnetic_pickup": 10, "long_time_delay": 10}
    mcb = {"cb_type": "mcb", "trip_rating_a": 40, "thermal_pickup": 1.0,
           "magnetic_pickup": 10, "long_time_delay": 10}
    al = {"name": "120 Al", "size_mm2": 120, "conductor": "Al", "insulation": "PVC",
          "r_per_km": 0.32, "x_per_km": 0.075}
    cu = {"name": "16 Cu", "size_mm2": 16, "conductor": "Cu", "insulation": "PVC",
          "r_per_km": 1.38, "x_per_km": 0.082}
    string_dev = {"kind": "cb", "name": "MCCB 160A", "props": mccb}
    own_dev = {"kind": "cb", "name": "MCB 40A (C)", "props": mcb}

    def run(erf_device):
        e = {"id": "e1", "erfNumber": "1", "service": {"cable": cu, "earth": None, "lengthM": 60}}
        if erf_device:
            e["device"] = erf_device
            e["deviceSource"] = "kiosk"
        r = run_retic_earth_check({
            "settings": {},
            "minisubs": [{"id": "ms", "name": "M", "earthing": "TN-S",
                          "tx": {"kva": 500, "zPercent": 4.5, "xrRatio": 5, "vLvKv": 0.42}}],
            "kiosks": [{"id": "k", "name": "K", "fedFrom": "ms", "device": string_dev,
                        "feeder": {"cable": al, "earth": None, "lengthM": 73}, "erfs": [e]}]})
        return r["kiosks"][0]["erfs"][0]["loop"]

    up = run(None)
    own = run(own_dev)
    assert up["deviceSource"] == "string" and up["device"] == "MCCB 160A"
    assert own["deviceSource"] == "kiosk" and own["device"] == "MCB 40A (C)"
    assert up["ifA"] == own["ifA"]                      # same loop, different device
    assert up["status"] == "fail" and up["tS"] > 5      # 160 A string breaker: thermal region, too slow
    assert own["status"] == "pass" and own["tS"] < 0.1  # 40 A MCB: past 10 x Ir = 400 A, instantaneous


def test_withstand_is_the_weakest_earth_fault_conductor():
    """Mini TCC cable I²t line: k²S² of the smaller of k·S over phase and earth
    (Table 54.3 k, as the ECC check), the PEN itself on a PEN leg."""
    res = run_retic_earth_check(req())
    k = res["kiosks"][0]
    feeder = k["loop"]["withstand"]                  # 95 Cu XLPE (143·95) vs 25 Cu PVC earth (115·25)
    assert feeder["conductor"] == "earth" and feeder["k"] == 115.0
    assert feeder["k2s2"] == round((115 * 25) ** 2)
    svc = k["erfs"][0]["loop"]["withstand"]          # 16 Cu XLPE (143·16 = 2288) < 25 Cu PVC (2875)
    assert svc["conductor"] == "phase" and svc["k2s2"] == round((143 * 16) ** 2)

    r = req()
    r["minisubs"][0]["earthing"] = "TN-C"
    pen = run_retic_earth_check(r)["kiosks"][0]["erfs"][0]["loop"]["withstand"]
    assert pen["conductor"] == "PEN" and pen["sizeMm2"] == 16 and pen["k"] == 143.0
