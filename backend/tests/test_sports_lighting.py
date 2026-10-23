"""Sports field lighting (analysis/sports_lighting.py): the field frame and grid,
exact horizontal and vertical illuminance from aimed floods, uniformities, GR at
the observers, the aiming / power checks and the aim optimiser."""
import math

import numpy as np
import pytest

from backend.analysis import sports_lighting as SL
from backend.analysis.area_lighting import _Lums, glare_rating
from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web


def _photo(kind="generic_sports_narrow", lumens=150000.0, watts=1200.0):
    return {"p": generic_optic(kind, lumens, watts)}


def _webs(photo):
    return {k: _Web(v) for k, v in photo.items()}


def _flood(fid, mx, my, h, ax, ay, field="F"):
    rot, tilt = SL.aim_angles(mx, my, h, ax, ay)
    return {"id": fid, "x": mx, "y": my, "h": h, "rotate": rot, "tilt": tilt, "photometryId": "p", "fieldId": field}


def _field(**kw):
    d = {"id": "F", "name": "Pitch", "origin": [0.0, 0.0], "axis": [1.0, 0.0], "side": [0.0, 1.0],
         "length": 10.0, "width": 10.0, "gridStep": 5.0, "mf": 0.8}
    d.update(kw)
    return d


def _run(lums, field, photo=None):
    return SL.run_sports_lighting({"luminaires": lums, "fields": [field], "photometry": photo or _photo()})["fields"][0]


def test_grid_step_is_the_en_12464_2_formula():
    assert SL.grid_step(105.0) == pytest.approx(0.2 * 5 ** math.log10(105.0))
    r = _run([_flood("a", 52.5, -10, 30, 52.5, 34)], _field(length=105.0, width=68.0, gridStep=0))
    hz = r["horizontal"]
    assert (hz["nx"], hz["ny"]) == (21, 14)          # 105 / 5.17 → 21, 68 / 5.17 → 14
    assert len(hz["values"]) == 21 * 14


def test_flood_aimed_at_a_grid_point_gives_its_peak_there():
    photo = _photo()
    I0 = float(_Web(photo["p"]).intensity(np.array([0.0]), np.array([0.0]))[0])
    # mast 20 m behind the point, 25 m high; the grid point (local 2.5, 2.5) is world (0, 10)
    h, mx, my = 25.0, 0.0, -10.0
    r = _run([_flood("a", mx, my, h, 0.0, 10.0)], _field(origin=[-2.5, 7.5]), photo)
    d = math.hypot(20.0, h)
    E = I0 * (h / d) / d ** 2 * 0.8                # on the beam axis: I(0)·cos(incidence)/d², × MF
    assert r["horizontal"]["values"][0] == pytest.approx(E, rel=2e-3)


def test_field_frame_rotation_gives_the_same_statistics():
    lums = [_flood("a", 5.0, -6.0, 18.0, 5.0, 3.0), _flood("b", 5.0, 16.0, 18.0, 5.0, 7.0)]
    r0 = _run(lums, _field())
    # the same square described from another corner: origin (10, 0), x along +y, y along −x
    r1 = _run(lums, _field(origin=[10.0, 0.0], axis=[0.0, 1.0], side=[-1.0, 0.0]))
    a, b = r0["horizontal"], r1["horizontal"]
    assert a["Eav"] == pytest.approx(b["Eav"], rel=1e-6)
    assert sorted(a["values"]) == pytest.approx(sorted(b["values"]), rel=1e-6)


def test_uniformities_follow_from_the_grid():
    lums = [_flood("a", 5.0, -6.0, 18.0, 2.0, 3.0), _flood("b", 5.0, 16.0, 18.0, 8.0, 7.0)]
    hz = _run(lums, _field(gridStep=2.0))["horizontal"]
    v = np.array(hz["values"])
    assert hz["Emin"] == pytest.approx(v.min(), abs=0.06)
    assert hz["U1"] == pytest.approx(hz["Emin"] / hz["Emax"], abs=2e-3)
    assert hz["U2"] == pytest.approx(hz["Emin"] / hz["Eav"], abs=2e-3)


def test_vertical_illuminance_towards_players_and_cameras():
    photo = _photo()
    webs = _webs(photo)
    lum = _flood("a", 0.0, -10.0, 20.0, 0.0, 0.0)
    # grid centre (local 2.5, 2.5) = world (0, 0), planes at 1.5 m
    r = _run([lum], _field(origin=[-2.5, -2.5], evHeight=1.5,
                           cameras=[{"id": "c", "name": "Main", "x": 0.0, "y": -40.0, "z": 10.0}]), photo)
    L = _Lums([lum], webs)
    dvec = np.array([0.0, 10.0, 1.5 - 20.0])           # luminaire → point
    d = float(np.linalg.norm(dvec))
    I = float(L.intensity(dvec[0:1][None, :], dvec[1:2][None, :], dvec[2:3][None, :])[0, 0])
    expect = I * (10.0 / d) / d ** 2 * 0.8               # plane facing −y (towards the mast)
    towards_y0 = next(p for p in r["players"]["directions"] if p["label"].endswith("y = 0"))
    assert towards_y0["Emax"] >= expect * 0.999
    # the camera straight down −y sees the point (0, 0) on the same plane
    cam = r["cameras"][0]
    assert cam["name"] == "Main" and cam["Emax"] >= expect * 0.999
    # the face turned away from the mast gets nothing from this flood
    away = next(p for p in r["players"]["directions"] if p["label"].endswith("y = W"))
    assert away["Emax"] == pytest.approx(0.0, abs=1e-9)


def test_gr_at_the_observers_matches_the_area_engine():
    photo = _photo()
    lums = [_flood("a", 50.0, -8.0, 25.0, 50.0, 20.0), _flood("b", 50.0, 58.0, 25.0, 50.0, 30.0)]
    f = _field(length=100.0, width=50.0, gridStep=0, groundRho=0.2)
    r = _run(lums, f, photo)
    gr = r["gr"]
    assert len(gr["observers"]) == 15
    lve = 0.035 * 0.2 * r["horizontal"]["Eav"] / math.pi
    g, _ = glare_rating(_Lums(lums, _webs(photo)), 50.0, 0.0, 0.8, lve)
    obs = next(o for o in gr["observers"] if (o["x"], o["y"]) == (50.0, 0.0))
    assert obs["gr"] == pytest.approx(g, abs=0.051)
    assert gr["max"] == max(o["gr"] for o in gr["observers"] if o["gr"] is not None)


def test_checks_power_and_tilt_count_only_the_fields_own_floods():
    lums = [_flood("a", 5.0, -6.0, 18.0, 2.0, 2.0), _flood("x", 5.0, 30.0, 18.0, 5.0, 5.0, field="other")]
    for it in lums:
        it["watts"] = 1000.0
    r = _run(lums, _field(targets={"em": 1.0, "u2": 0.99, "maxTilt": 10.0}))
    assert r["luminaires"] == 1 and r["allLuminaires"] == 2
    assert r["power"]["watts"] == pytest.approx(1000.0)
    assert r["power"]["wm2"] == pytest.approx(10.0)
    tilt = math.degrees(math.atan2(math.hypot(3.0, 8.0), 18.0))
    assert r["aiming"]["maxTilt"] == pytest.approx(tilt, abs=0.05)
    by = {c["key"]: c for c in r["checks"]}
    assert by["em"]["pass"] is True and by["u2"]["pass"] is False and by["tilt"]["pass"] is False
    assert r["pass"] is False


def test_bad_field_is_reported():
    r = SL.run_sports_lighting({"luminaires": [], "fields": [_field(length=0)], "photometry": {}})["fields"][0]
    assert "error" in r


def _six_masts(L=105.0, W=68.0, h=30.0, per=12):
    masts, n = [], 0
    for side, y in (("A", -5.0), ("B", W + 5.0)):
        for fx in (0.1, 0.5, 0.9):
            floods = []
            for k in range(per):
                floods.append({"id": f"f{n}", "ax": fx * L + (k % 3 - 1) * 12.0,
                               "ay": (k // 3 + 0.5) / 4 * W / 2 + (0 if y < 0 else W / 2), "photometryId": "p"})
                n += 1
            masts.append({"id": f"{side}{fx}", "x": fx * L, "y": y, "h": h, "floods": floods})
    return masts


def test_aim_optimiser_evens_the_pitch_and_respects_limits():
    L, W = 105.0, 68.0
    masts = _six_masts()
    out = SL.optimise_aiming({"field": {"length": L, "width": W, "mf": 0.8, "maxTilt": 70.0},
                              "masts": masts, "photometry": _photo()})
    assert out["after"]["U2"] >= out["before"]["U2"]
    assert out["after"]["U2"] >= 0.75
    mast = {m["id"]: m for m in masts}
    for m in out["masts"]:
        M = mast[m["id"]]
        for fl in m["floods"]:
            assert 0.0 <= fl["ax"] <= L and 0.0 <= fl["ay"] <= W
            tilt = math.degrees(math.atan2(math.hypot(fl["ax"] - M["x"], fl["ay"] - M["y"]), M["h"]))
            assert tilt <= 68.0 + 0.05
    # the full calculation agrees with the optimiser's own figure on the same grid
    lums = []
    for m in out["masts"]:
        M = mast[m["id"]]
        lums += [_flood(fl["id"], M["x"], M["y"], M["h"], fl["ax"], fl["ay"]) for fl in m["floods"]]
    r = _run(lums, _field(length=L, width=W, gridStep=0))
    assert r["horizontal"]["U2"] == pytest.approx(out["after"]["U2"], abs=2e-3)


def test_aim_optimiser_needs_floods():
    with pytest.raises(ValueError):
        SL.optimise_aiming({"field": {"length": 10, "width": 10}, "masts": [], "photometry": _photo()})


def test_aerial_layers_are_the_mean_of_four_vertical_planes():
    photo = _photo()
    lums = [_flood("a", 5.0, -6.0, 18.0, 5.0, 3.0), _flood("b", 5.0, 16.0, 18.0, 5.0, 7.0)]
    r = _run(lums, _field(aerial={"heights": [10, 2, 2]}, targets={"aerialEv": 1.0}), photo)
    layers = r["aerial"]["layers"]
    assert [l["height"] for l in layers] == [2.0, 10.0]
    L = _Lums(lums, _webs(photo))
    P = np.array([[x, y, 10.0] for y in (2.5, 7.5) for x in (2.5, 7.5)])
    ev = [L.illuminance(P, np.tile([d[0], d[1], 0.0], (4, 1))) * 0.8 for d in ((1, 0), (-1, 0), (0, 1), (0, -1))]
    assert layers[1]["Evavg"] == pytest.approx(float(np.mean(ev)), rel=1e-3)
    assert [c["key"] for c in r["checks"]].count("aerialEv") == 2


def test_stand_seats_faces_and_spectator_glare():
    photo = _photo()
    lums = [_flood("a", 50.0, -8.0, 25.0, 50.0, 20.0), _flood("b", 50.0, 58.0, 25.0, 50.0, 30.0)]
    stand = {"id": "s", "name": "Main stand", "corners": [[20, -3], [80, -3], [80, -15], [20, -15]], "zFront": 0.5, "zBack": 6.0,
             "targets": {"em": 0.1, "gr": 99}}
    r = _run(lums, _field(length=100.0, width=50.0, gridStep=0, stands=[stand]), photo)
    st = r["stands"][0]
    assert st["length"] == pytest.approx(60.0) and st["depth"] == pytest.approx(12.0)
    assert (st["nx"], st["ny"]) == (30, 6)
    assert st["seats"]["Eav"] > 0 and st["faces"]["Eav"] > 0
    # the seat grid for the 3D view: row by row from the front, its mean is Ēh on the seats
    assert len(st["values"]) == 30 * 6
    assert sum(st["values"]) / len(st["values"]) == pytest.approx(st["seats"]["Eav"], abs=0.1)
    assert st["gr"] and len(st["gr"]["observers"]) == 6
    # the eye rises with the rake: front row 0.5 + 0.15·5.5 + 1.2
    assert st["gr"]["observers"][0]["z"] == pytest.approx(0.5 + 0.15 * 5.5 + 1.2, abs=0.01)
    keys = [c["key"] for c in r["checks"]]
    assert "standEm" in keys and "standGr" in keys
    assert "_targets" not in st


# ─── Aiming patterns, the multi-target optimiser, trimming, comparison ───

from backend.analysis import sports_aiming as SA  # noqa: E402


def _pitch_req(pattern=None, **kw):
    L, W = 105.0, 68.0
    masts = []
    for side, y in (("S", -5.0), ("N", W + 5.0)):
        for fx in (0.1, 0.5, 0.9):
            masts.append({"id": f"{side}{fx}", "name": f"{side}{fx}", "x": fx * L, "y": y, "h": 25.0,
                          "floods": [{"id": f"{side}{fx}-{k}", "ax": L / 2, "ay": W / 2, "photometryId": "p"} for k in range(8)]})
    req = {"field": {"length": L, "width": W, "mf": 0.8, "maxTilt": 70.0, "groundRho": 0.2, "evHeight": 1.5,
                     "targets": {"em": 200, "u2": 0.6, "gr": 50}, "cameras": [{"name": "Main", "x": L / 2, "y": -25.0}]},
           "masts": masts, "photometry": _photo("generic_sports_medium", 120000.0, 1000.0), "pattern": pattern, "budget": 4}
    req.update(kw)
    return req


def _lums_of(req, out):
    by = {m["id"]: m for m in req["masts"]}
    lums = []
    for m in out["masts"]:
        M = by[m["id"]]
        lums += [dict(_flood(fl["id"], M["x"], M["y"], M["h"], fl["ax"], fl["ay"]), fluxPct=fl["fluxPct"]) for fl in m["floods"]]
    return lums


def _zone_of(L, W, masts, i, pattern):
    S = SA._Samples(L, W)
    geo = [{"x": m["x"], "y": m["y"], "h": m["h"], "id": m["id"]} for m in masts]
    masks, _ = SA.zone_masks(S, geo, [pattern] * len(masts), 70.0)
    return S, masks[i]


@pytest.mark.parametrize("pattern", ["near", "scatter", "cross", "band"])
def test_pattern_places_every_flood_in_its_zone_within_the_tilt_limit(pattern):
    req = _pitch_req(pattern, optimise=False)
    out = SA.aim(req)
    L, W = 105.0, 68.0
    for i, m in enumerate(out["masts"]):
        assert m["pattern"] == pattern
        M = req["masts"][i]
        S, z = _zone_of(L, W, req["masts"], i, pattern)
        pts = S.xy[z]
        assert len(m["floods"]) == 8
        for fl in m["floods"]:
            assert math.degrees(math.atan2(math.hypot(fl["ax"] - M["x"], fl["ay"] - M["y"]), M["h"])) <= 68.0 + 0.05
            assert np.min(np.hypot(pts[:, 0] - fl["ax"], pts[:, 1] - fl["ay"])) <= S.ds   # on a sample of its zone
        # the floods of one mast are spread out, not stacked
        P = np.array([(fl["ax"], fl["ay"]) for fl in m["floods"]])
        d = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1]) + np.eye(len(P)) * 1e9
        assert d.min() > 2.0


def test_pattern_shapes():
    req = _pitch_req(None, optimise=False)
    W = 68.0
    south = [i for i, m in enumerate(req["masts"]) if m["y"] < 0]
    near = SA.aim(dict(req, pattern="near"))
    cross = SA.aim(dict(req, pattern="cross"))
    scatter = SA.aim(dict(req, pattern="scatter"))
    band = SA.aim(dict(req, pattern="band"))
    for i in south:
        assert all(fl["ay"] <= W / 2 + 1 for fl in near["masts"][i]["floods"])       # own half
        assert all(fl["ay"] >= W / 2 - 1 for fl in cross["masts"][i]["floods"])      # the far half
        ys = [fl["ay"] for fl in band["masts"][i]["floods"]]
        assert max(ys) - min(ys) > W / 2                                             # well across the width
        x0 = req["masts"][i]["x"]
        opp = [j for j, m in enumerate(req["masts"]) if m["y"] > W and abs(m["x"] - x0) < 1][0]
        both = ys + [fl["ay"] for fl in band["masts"][opp]["floods"]]
        assert min(both) < W / 4 and max(both) > 3 * W / 4                           # the strip, touchline to touchline
        assert all(abs(fl["ax"] - x0) <= 105.0 / 3 + 1 for fl in band["masts"][i]["floods"])   # its third
    # scattered: a mast's floods reach well past its own near zone, along and across
    xs = [fl["ax"] for fl in scatter["masts"][0]["floods"]]
    ys = [fl["ay"] for fl in scatter["masts"][0]["floods"]]
    assert max(xs) - min(xs) > 40 and max(ys) - min(ys) > 30


def test_optimiser_keeps_the_pattern_and_meets_the_targets():
    req = _pitch_req("near")
    out = SA.aim(req)
    a = out["after"]
    assert a["pass"] is True and a["U2"] >= 0.6 and a["GR"] <= 50
    for i, m in enumerate(out["masts"]):
        S, z = _zone_of(105.0, 68.0, req["masts"], i, "near")
        pts = S.xy[z]
        for fl in m["floods"]:
            assert np.min(np.hypot(pts[:, 0] - fl["ax"], pts[:, 1] - fl["ay"])) <= S.ds
    # the optimiser's figures are the full calculation's (this field's floods only)
    cam = {"name": "Main", "x": 52.5, "y": -25.0, "z": 10.0}
    r = _run(_lums_of(req, out), _field(length=105.0, width=68.0, gridStep=0, groundRho=0.2, cameras=[cam]),
             _photo("generic_sports_medium", 120000.0, 1000.0))
    assert r["horizontal"]["U2"] == pytest.approx(a["U2"], abs=2e-3)
    assert r["horizontal"]["U1"] == pytest.approx(a["U1"], abs=2e-3)
    assert r["horizontal"]["Eav"] == pytest.approx(a["Eav"], rel=1e-3)
    assert r["gr"]["max"] == pytest.approx(a["GR"], abs=0.1)
    assert r["cameras"][0]["Eav"] == pytest.approx(a["cameras"][0]["Eav"], rel=1e-3)


def test_dimming_meets_the_illuminance_target_with_two_percent_in_hand():
    out = SA.aim(_pitch_req("band", trim="dim"))
    a = out["after"]
    pcts = {fl["fluxPct"] for m in out["masts"] for fl in m["floods"]}
    assert len(pcts) == 1 and next(iter(pcts)) < 100
    assert 200.0 <= a["Eav"] <= 200.0 * 1.02 * (1 + 1.0 / next(iter(pcts)))   # 2 % margin, whole per cent up
    assert a["watts"] < 48 * 1000.0 * 0.6


def test_removing_floods_keeps_every_target_and_a_flood_on_every_mast():
    out = SA.aim(_pitch_req("near", trim="remove", budget=6))
    a = out["after"]
    assert out["removed"] and a["count"] == 48 - len(out["removed"])
    assert a["pass"] is True
    assert all(len(m["floods"]) >= 1 for m in out["masts"])
    left = {fl["id"] for m in out["masts"] for fl in m["floods"]}
    assert not (left & set(out["removed"]))


def test_one_mast_only_moves_and_others_keep_their_aims():
    req = _pitch_req("near", apply=["S0.1"], move=["S0.1"])
    out = SA.aim(req)
    assert out["masts"][0]["pattern"] == "near"
    for m in out["masts"][1:]:
        assert m["pattern"] is None
        assert all((fl["ax"], fl["ay"]) == (52.5, 34.0) for fl in m["floods"])


def test_pattern_without_photometry_still_places_floods():
    req = _pitch_req("scatter", optimise=False, photometry={})
    out = SA.aim(req)
    assert out["after"] is None and len(out["masts"][0]["floods"]) == 8
    with pytest.raises(ValueError):
        SA.aim(dict(req, optimise=True))
    with pytest.raises(ValueError):
        SA.aim(dict(req, pattern="spiral"))


def test_compare_gives_a_row_per_pattern_and_the_current_aiming():
    out = SA.compare(_pitch_req(None, budget=1.5))
    rows = out["options"]
    assert [r["pattern"] for r in rows] == [None, "near", "scatter", "cross", "band"]
    assert rows[0]["before"]["U2"] == pytest.approx(rows[0]["after"]["U2"])
    assert all(r["after"]["U2"] > rows[0]["after"]["U2"] for r in rows[1:])
