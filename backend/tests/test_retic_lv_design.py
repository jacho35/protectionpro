"""The Auto layout's LV design (analysis/retic_lv_design.py): 80 A ways, string breakers, the smallest uniform cable, the taper.

Every check runs the real earth-fault engine (retic_earth.py) on networks built from the app's own cable ladder and breaker
library (fixtures/lv_design_library.json, generated from constants.js).
"""
import math
import time

import pytest

from backend.analysis.retic_earth import run_retic_earth_check
from backend.analysis.retic_lv_design import PF, SINPHI, _Design, run_retic_lv_design
from backend.tests.lv_design_fixtures import (AL, BREAKERS, CU, WAY_80A, net_40, net_72, net_mount_royal, network,
                                              total_erven)


def earth_of(req, res, force_size=None):
    """The whole network through the earth engine with the design's cables and breakers (or one size throughout)."""
    byk = {f["kioskId"]: f for f in res["feeders"]}
    lad = {c["name"]: c for c in AL + CU}
    heads = {h["kioskId"]: h["device"] for h in res["heads"]}
    ks = []
    for k in req["kiosks"]:
        cab = lad[byk[k["id"]]["cable"]] if force_size is None else next(c for c in AL if c["size_mm2"] == force_size)
        head = not any(x["id"] == k["fedFrom"] for x in req["kiosks"])
        ks.append({"id": k["id"], "name": k["name"], "fedFrom": k["fedFrom"], "device": heads.get(k["id"]) if head else None,
                   "feeder": {"cable": cab, "earth": None, "lengthM": k["lengthM"]},
                   "erfs": [{**e, "device": WAY_80A, "deviceSource": "kiosk"} for e in k["erfs"]]})
    return run_retic_earth_check({"settings": {"u0": 230, "disconnectTimeS": 5}, "minisubs": req["minisubs"], "kiosks": ks})


def fail_items(earth):
    out = {}
    for k in earth["kiosks"]:
        for key, d in [((k["kioskId"], None, "loop"), k["loop"]), ((k["kioskId"], None, "ecc"), k["ecc"])] + [
                ((k["kioskId"], e["erfId"], w), e[w]) for e in k["erfs"] for w in ("loop", "ecc")]:
            if d and d["status"] == "fail":
                out[key] = d
    return out


def cum_vd(req, res, kid):
    byk = {f["kioskId"]: f for f in res["feeders"]}
    return sum(byk[c]["vdPct"] for c in chain(req, kid))


def chain(req, kid):
    ks = {k["id"]: k for k in req["kiosks"]}
    out = []
    while kid in ks:
        out.append(kid)
        kid = ks[kid]["fedFrom"]
    return out


def test_72_erven_passes_on_80a_ways_with_a_string_breaker_per_string():
    req = network(net_72())
    assert total_erven(req) == 72
    res = run_retic_lv_design(req)
    assert res["ok"] and res["failCount"] == 0 and not res["reasons"]
    assert len(res["heads"]) == 3
    for h in res["heads"]:                                   # the breaker comes from the string current Demand gave, in range
        assert h["amps"] > 0 and not h["noCurrent"]
        assert h["amps"] <= h["device"]["rating"] <= 2.2 * h["amps"] + 20
    # the engine agrees: the design as returned has no failing check anywhere
    assert fail_items(earth_of(req, res)) == {}
    # every erf's way was the 80 A MCCB
    e = earth_of(req, res)
    assert {x["loop"]["device"] for k in e["kiosks"] for x in k["erfs"]} == {"MCCB 80A"}


def test_taper_uses_less_cable_than_one_size_and_sizes_stay_on_the_ladder():
    res = run_retic_lv_design(network(net_72()))
    assert res["taper"]["totalMm2M"] <= res["uniform"]["totalMm2M"]
    assert res["taper"]["savedPct"] > 0
    assert set(res["taper"]["sizes"]) <= {c["size_mm2"] for c in AL}
    off = run_retic_lv_design(network(net_72(), taper=False))
    assert off["taper"]["on"] is False and len({f["sizeMm2"] for f in off["feeders"]}) == 1
    assert off["taper"]["totalMm2M"] == pytest.approx(off["uniform"]["totalMm2M"])


def test_the_uniform_size_is_the_smallest_that_passes():
    req = network(net_72())
    res = run_retic_lv_design(req)
    u = res["uniform"]["sizeMm2"]
    smaller = [c["size_mm2"] for c in AL if c["size_mm2"] < u]
    assert smaller, "something to compare with"
    below = earth_of(req, res, force_size=max(smaller))
    # on the next size down at least one of: an earth-fault check, the cable rating or the volt drop breaks
    d = _Design(req)
    d.dev = {h["kioskId"]: h["device"] for h in res["heads"]}
    d.idx = {k["id"]: [c["size_mm2"] for c in AL].index(max(smaller)) for k in req["kiosks"]}
    bad_rating = any(not d.rating_ok(k["id"]) for k in req["kiosks"])
    bad_vd = any(d.cum_vd(k["id"]) > 7 for k in req["kiosks"])
    assert fail_items(below) or bad_rating or bad_vd


@pytest.mark.parametrize("net,tx", [(net_72, "500"), (net_40, "500")])
def test_no_feeder_can_go_one_size_smaller(net, tx):
    """The proof that each size is the smallest: dropping any one feeder a size breaks a check (or the taper rule)."""
    req = network(net(), tx=tx)
    res = run_retic_lv_design(req)
    assert res["ok"]
    lad = [c["size_mm2"] for c in AL]
    ks = {k["id"]: k for k in req["kiosks"]}
    for f in res["feeders"]:
        i = lad.index(f["sizeMm2"])
        if i == 0:
            continue
        smaller = dict((x["kioskId"], x["sizeMm2"]) for x in res["feeders"])
        smaller[f["kioskId"]] = lad[i - 1]
        # re-run the engine with that one feeder a size smaller and the same breakers
        byname = {c["size_mm2"]: c for c in AL}
        heads = {h["kioskId"]: h["device"] for h in res["heads"]}
        kk = [{"id": k["id"], "name": k["name"], "fedFrom": k["fedFrom"],
               "device": heads.get(k["id"]) if k["fedFrom"] not in ks else None,
               "feeder": {"cable": byname[smaller[k["id"]]], "earth": None, "lengthM": k["lengthM"]},
               "erfs": [{**e, "device": WAY_80A, "deviceSource": "kiosk"} for e in k["erfs"]]} for k in req["kiosks"]]
        e = run_retic_earth_check({"settings": {"u0": 230, "disconnectTimeS": 5}, "minisubs": req["minisubs"], "kiosks": kk})
        d = _Design(req)
        d.idx = {k: lad.index(v) for k, v in smaller.items()}
        rating_bad = not d.rating_ok(f["kioskId"])
        vd_bad = any(d.cum_vd(k) > 7 for k in smaller)
        # a child may not be larger than its parent: that rule also stops a size
        child_bigger = any(lad.index(smaller[c["id"]]) > i - 1 for c in req["kiosks"] if c["fedFrom"] == f["kioskId"])
        assert fail_items(e) or rating_bad or vd_bad or child_bigger, f"{f['name']} could be {lad[i - 1]} mm²"


def test_a_string_with_no_current_is_reported_not_guessed():
    req = network(net_40())
    for k in req["kiosks"]:
        if k["id"] == "S1K1":
            k["amps"] = 0
    res = run_retic_lv_design(req)
    h = next(x for x in res["heads"] if x["kioskId"] == "S1K1")
    assert h["noCurrent"] and h["device"] is None and h["breaker"] is None
    other = next(x for x in res["heads"] if x["kioskId"] == "S2K1")
    assert other["device"]["rating"] >= other["amps"]


def test_head_breaker_with_fewest_fails_wins_and_never_below_the_string_current():
    req = network(net_72())
    res = run_retic_lv_design(req)
    for h in res["heads"]:
        assert h["device"]["rating"] >= h["amps"] - 1e-9
    # a pinned breaker is kept as given
    pin = next(b for b in BREAKERS if b["rating"] == 160)
    res2 = run_retic_lv_design(network(net_72(), pinnedBreakers={"S1K1": pin}))
    assert next(h for h in res2["heads"] if h["kioskId"] == "S1K1")["device"]["rating"] == 160
    assert next(h for h in res2["heads"] if h["kioskId"] == "S1K1")["pinned"]


def test_a_pinned_cable_is_never_changed():
    pin = next(c for c in AL if c["size_mm2"] == 240)
    res = run_retic_lv_design(network(net_72(), pinnedCables={"S1K3": pin}))
    f = next(x for x in res["feeders"] if x["kioskId"] == "S1K3")
    assert f["sizeMm2"] == 240 and f["pinned"] and f["setBy"] == "you"
    assert res["ok"]


def test_a_single_kiosk_passes_with_no_taper():
    req = network([("K1", None, 60, 6)])
    res = run_retic_lv_design(req)
    assert res["ok"] and len(res["feeders"]) == 1
    assert res["taper"]["on"] is False and res["taper"]["count"] == 1
    assert fail_items(earth_of(req, res)) == {}


def test_a_taper_never_makes_a_failing_check_slower():
    """The failing string: nothing that fails on the largest cable gets slower or a higher Zs in the design."""
    req = network(net_mount_royal(), tx="315")
    res = run_retic_lv_design(req)
    assert not res["ok"]
    ref = fail_items(earth_of(req, res, force_size=300))
    now = fail_items(earth_of(req, res))
    assert ref, "the largest cable alone does not pass: the breaker is the problem"
    assert set(now) <= set(ref) | set(), "a taper must not make a passing check fail"
    for key, d in now.items():
        r = ref[key]
        rt = math.inf if r.get("tS") is None else r["tS"]
        nt = math.inf if d.get("tS") is None else d["tS"]
        assert nt <= rt + 1e-6 and d["zsOhm"] <= r["zsOhm"] + 1e-6, key


def test_when_it_cannot_pass_it_says_why_and_offers_the_real_fixes():
    req = network(net_mount_royal(), tx="315")
    res = run_retic_lv_design(req)
    assert not res["ok"] and res["reasons"]
    r = res["reasons"][0]
    assert r["headName"] == "K6" and "String K6" in r["text"] and "bigger one does not fix it" in r["text"]
    assert r["tMin"] is not None and r["tMin"] > 5.0
    acts = [f["action"] for f in r["fixes"]]
    assert "addSub" in acts and "split" in acts
    sp = next(f for f in r["fixes"] if f["action"] == "split")
    assert sp["failsAfter"] < sp["failsBefore"]
    assert sp["kiosk"] in r["text"], "the message names the kiosk to split at"


def test_splitting_the_string_where_it_says_clears_the_failures():
    ks = net_mount_royal()
    req = network(ks, tx="315")
    res = run_retic_lv_design(req)
    x = next(f for f in res["reasons"][0]["fixes"] if f["action"] == "split")["kiosk"]
    # the kiosk becomes its own string: a feeder straight off the mini-sub along the same route
    byname = {k[0]: k for k in ks}
    path = 0.0
    cur = x
    while cur:
        path += byname[cur][2]
        cur = byname[cur][1]
    split = [(n, None, path, ne) if n == x else (n, p, ln, ne) for n, p, ln, ne in ks]
    after = run_retic_lv_design(network(split, tx="315"))
    assert after["failCount"] < res["failCount"]


def test_two_mini_subs_clear_it():
    """The same 76 erven on two mini-subs (the long string split between them) pass."""
    ks = net_mount_royal()
    chain2 = {"K3", "K4", "K5", "K11"}
    moved = [(n, ("MS2" if n == "K3" else p), ln, ne) for n, p, ln, ne in ks]
    req = network(moved, tx="315", subs=["MS1", "MS2"])
    res = run_retic_lv_design(req)
    assert res["ok"], res["reasons"]
    assert fail_items(earth_of(req, res)) == {}


def test_a_big_network_is_fast():
    req = network(net_mount_royal(), tx="315")
    t = time.time()
    res = run_retic_lv_design(req)
    assert time.time() - t < 20.0
    assert res["engineCalls"] < res["trials"] * len(req["kiosks"])       # the cache: a trial re-checks only the affected feeders


def test_it_is_deterministic():
    a = run_retic_lv_design(network(net_72()))
    b = run_retic_lv_design(network(net_72()))
    assert [(f["kioskId"], f["cable"]) for f in a["feeders"]] == [(f["kioskId"], f["cable"]) for f in b["feeders"]]
    assert [h["breaker"] for h in a["heads"]] == [h["breaker"] for h in b["heads"]]


def test_a_copper_ladder_works_too():
    res = run_retic_lv_design(network(net_72(), ladder=CU))
    assert res["ok"] and res["conductor"] == "Cu"


def test_the_volt_drop_and_rating_checks_match_retic():
    """Retic._vdPercent at pf 0.95 on 400 V: √3·I·L·(R·pf + X·sinφ)/400."""
    req = network(net_72())
    res = run_retic_lv_design(req)
    for f in res["feeders"]:
        c = next(x for x in AL if x["name"] == f["cable"])
        want = math.sqrt(3) * f["amps"] * f["lengthM"] / 1000 * (c["r_per_km"] * PF + c["x_per_km"] * SINPHI) / 400 * 100
        assert f["vdPct"] == pytest.approx(want, abs=1e-3)
        assert f["ratingA"] >= f["amps"] - 1e-9
    assert all(f["vdCumPct"] <= 7.0 + 1e-9 for f in res["feeders"])


def test_the_route_runs_the_design_behind_sign_in(tmp_path, monkeypatch):
    """POST /api/analysis/retic-lv-design: needs a token, returns the same design as the engine."""
    import os
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{tmp_path}/lv.db")
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from backend.models import database as _database
    from backend.main import app
    from backend.tests.lv_design_fixtures import net_40

    _database.engine = create_engine(f"sqlite:///{tmp_path}/lv2.db", connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    req = network(net_40())
    with TestClient(app) as c:
        assert c.post("/api/analysis/retic-lv-design", json=req).status_code == 401
        tok = c.post("/api/auth/register", json={"email": "a@x.com", "password": "password123"}).json()["access_token"]
        r = c.post("/api/analysis/retic-lv-design", json=req, headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200, r.text
        body = r.json()
        want = run_retic_lv_design(req)
        assert body["ok"] and [f["cable"] for f in body["feeders"]] == [f["cable"] for f in want["feeders"]]


# ── a minimum and a maximum LV cable size ──

def sizes_used(res):
    return sorted({f["sizeMm2"] for f in res["feeders"]})


def test_the_cables_stay_inside_the_range_and_the_report_lists_it():
    res = run_retic_lv_design(network(net_72(), minSizeMm2=95, maxSizeMm2=185))
    assert res["ok"] and all(95 <= s <= 185 for s in sizes_used(res))
    assert res["limits"]["sizes"] == [95, 120, 150, 185] and res["limits"]["minMm2"] == 95 and res["limits"]["maxMm2"] == 185


def test_a_range_that_is_wide_enough_changes_nothing():
    free = run_retic_lv_design(network(net_72()))
    wide = run_retic_lv_design(network(net_72(), minSizeMm2=16, maxSizeMm2=300))
    assert [f["cable"] for f in wide["feeders"]] == [f["cable"] for f in free["feeders"]]
    assert wide["limits"]["maxNeededMm2"] is None


def test_a_maximum_that_is_too_small_is_named_as_the_reason_with_what_would_work():
    req = network(net_72(), maxSizeMm2=70)
    res = run_retic_lv_design(req)
    assert not res["ok"] and res["failCount"] > 0
    r0 = res["reasons"][0]
    assert r0["kind"] == "maxSize" and "too small" in r0["text"] and "70 mm²" in r0["text"]
    need = res["limits"]["maxNeededMm2"]
    assert need == 95                                                     # what the free design needs on its worst feeder
    fix = next(f for f in r0["fixes"] if f["action"] == "maxSize")
    assert fix["size"] == need
    assert run_retic_lv_design(network(net_72(), maxSizeMm2=need))["ok"]    # allowing it works...
    assert not run_retic_lv_design(network(net_72(), maxSizeMm2=70))["ok"]  # ...and the next size down below it does not
    below = max(s for s in res["limits"]["allSizes"] if s < need)
    assert not run_retic_lv_design(network(net_72(), maxSizeMm2=below))["ok"]


def test_a_minimum_says_what_it_costs():
    free = run_retic_lv_design(network(net_72()))
    res = run_retic_lv_design(network(net_72(), minSizeMm2=120))
    assert res["ok"] and sizes_used(res) == [120]
    assert res["limits"]["minAddsPct"] == pytest.approx((res["taper"]["totalMm2M"] / free["taper"]["totalMm2M"] - 1) * 100, abs=0.1)
    assert res["limits"]["minAddsPct"] > 0


def test_a_minimum_above_the_maximum_and_a_range_with_no_cable_in_it():
    a = run_retic_lv_design(network(net_72(), minSizeMm2=240, maxSizeMm2=120))
    assert not a["ok"] and a["reasons"][0]["kind"] == "range" and "no size fits" in a["reasons"][0]["text"] and a["feeders"] == []
    b = run_retic_lv_design(network(net_72(), minSizeMm2=17, maxSizeMm2=18))
    assert not b["ok"] and "no LV cable between" in b["reasons"][0]["text"]
    assert any(f["action"] == "clearSize" for f in a["reasons"][0]["fixes"])


def test_a_cable_too_small_for_its_current_or_a_volt_drop_over_the_limit_is_a_failed_check():
    res = run_retic_lv_design(network(net_72(), maxSizeMm2=16))
    assert not res["ok"] and res["violationCount"] > 0
    kinds = {v["kind"] for v in res["violations"]}
    assert kinds <= {"rating", "vd"} and kinds
    assert any(r.get("kind") in ("rating", "vd") for r in res["reasons"])


def test_a_pinned_cable_is_exempt_from_the_range():
    pin = next(c for c in AL if c["size_mm2"] == 240)
    res = run_retic_lv_design(network(net_72(), maxSizeMm2=150, pinnedCables={"S1K3": pin}))
    assert next(f for f in res["feeders"] if f["kioskId"] == "S1K3")["sizeMm2"] == 240
    assert all(f["sizeMm2"] <= 150 for f in res["feeders"] if f["kioskId"] != "S1K3")


def test_a_cap_on_a_string_that_cannot_pass_anyway_says_the_limit_makes_it_worse():
    res = run_retic_lv_design(network(net_mount_royal(), tx="315", maxSizeMm2=185))
    assert not res["ok"]
    assert res["reasons"][0]["kind"] == "maxSizeWorse" and "makes it worse" in res["reasons"][0]["text"]
    assert any("largest cable allowed (185 mm²)" in r["text"] for r in res["reasons"])      # the string reason no longer says a bigger cable cannot help
