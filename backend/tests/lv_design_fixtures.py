"""Networks for the LV design tests: a mini-sub, strings of kiosks, erven on 80 A ways, the app's own cable ladder and breaker library."""
import json
import os

_LIB = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "lv_design_library.json")))
AL = _LIB["al_xlpe_lv"]
CU = _LIB["cu_xlpe_lv"]
SVC = {"name": "16mm² Cu XLPE LV", "size_mm2": 16, "conductor": "Cu", "insulation": "XLPE", "r_per_km": 1.466, "x_per_km": 0.09}
TX = {"315": {"kva": 315, "zPercent": 4.5, "xrRatio": 5.0, "vLvKv": 0.42},
      "500": {"kva": 500, "zPercent": 4.5, "xrRatio": 6.0, "vLvKv": 0.42},
      "800": {"kva": 800, "zPercent": 5.0, "xrRatio": 7.0, "vLvKv": 0.42}}


def device(cb):
    return {"kind": "cb", "id": cb["id"], "name": cb["name"], "rating": cb["trip_rating_a"], "props": cb}


BREAKERS = [device(c) for c in _LIB["lv_breakers"]]
WAY_80A = next(b for b in BREAKERS if b["rating"] == 80)


def amps_of(n_erven, per_erf=4.0):
    """Demand's diversified current for n erven: a smooth diversity curve (about 3 A per erf at 70 erven)."""
    return per_erf * n_erven ** 0.92 if n_erven else 0.0


def network(kiosks, tx="500", svc_len=25.0, minisub="MS1", ladder=None, way=WAY_80A, subs=None, **opts):
    """``kiosks``: [(name, parent name or None, feeder length m, erven)] → a request for ``run_retic_lv_design``."""
    subs = subs or [minisub]
    kids = {n: {"id": n, "name": n, "fedFrom": p or minisub, "lengthM": ln, "n": ne} for n, p, ln, ne in kiosks}
    sub = {n: kids[n]["n"] for n in kids}
    for n in kids:                                                    # subtree erven → the string current
        cur = kids[n]["fedFrom"]
        while cur in kids:
            sub[cur] += kids[n]["n"]
            cur = kids[cur]["fedFrom"]
    out = []
    for n, k in kids.items():
        out.append({"id": n, "name": n, "fedFrom": k["fedFrom"], "lengthM": k["lengthM"], "amps": round(amps_of(sub[n]), 2),
                    "erfs": [{"id": f"{n}-{i + 1}", "erfNumber": f"{n}-{i + 1}", "service": {"cable": SVC, "earth": None, "lengthM": svc_len}}
                             for i in range(k["n"])]})
    return {"settings": {"u0": 230, "disconnectTimeS": 5, "maxFeederVD": 7},
            "minisubs": [{"id": m, "name": m, "earthing": "TN-S", "tx": TX[tx], "device": None} for m in subs],
            "kiosks": out, "ladder": ladder or AL, "breakers": BREAKERS,
            "options": {"erfDevice": way, **opts}}


def total_erven(req):
    return sum(len(k["erfs"]) for k in req["kiosks"])


# 72 erven, 12 kiosks in three strings of four (one mini-sub, 500 kVA)
def net_72():
    ks = []
    for s, lens in enumerate([(35, 60, 70, 55), (40, 65, 75, 60), (30, 55, 65, 50)], 1):
        prev = None
        for i, ln in enumerate(lens, 1):
            name = f"S{s}K{i}"
            ks.append((name, prev, ln, 6))
            prev = name
    return ks


# about 40 erven on eight kiosks of five, two strings
def net_40():
    ks = []
    for s, lens in enumerate([(40, 55, 70, 50), (45, 60, 65, 55)], 1):
        prev = None
        for i, ln in enumerate(lens, 1):
            name = f"S{s}K{i}"
            ks.append((name, prev, ln, 5))
            prev = name
    return ks


# 76 erven on 14 kiosks, one 315 kVA mini-sub; one long string carries most of it (the shape that fails on its far kiosks)
def net_mount_royal():
    ks = [("K6", None, 40, 6)]
    prev = "K6"
    for name, ln, ne in [("K7", 70, 6), ("K8", 80, 6), ("K9", 90, 6), ("K3", 85, 5), ("K4", 95, 5), ("K5", 100, 5), ("K11", 105, 5)]:
        ks.append((name, prev, ln, ne))
        prev = name
    for name, par, ln, ne in [("K1", None, 45, 6), ("K2", "K1", 70, 5), ("K10", None, 50, 5), ("K12", "K10", 75, 5), ("K13", None, 55, 4), ("K14", "K13", 80, 4)]:
        ks.append((name, par, ln, ne))
    return ks
