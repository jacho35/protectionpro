"""Room lighting engine (analysis/room_lighting.py): direct light, radiosity
interreflection, visibility in non-convex rooms, UGR scaling, flux balance."""
import math

import numpy as np

from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web
from backend.analysis import room_lighting as RL


def _webs(kind="generic_panel", lumens=4000.0, watts=36.0, pid="p"):
    prof = generic_optic(kind, lumens, watts)
    w = _Web(prof)
    w.luminous_m2 = prof.get("luminousM2", 0.0)
    return {pid: w}, prof


def _room(poly, lum, **kw):
    r = {"id": "r1", "name": "R", "polygon": poly, "ceilH": 2.7, "workH": 0.75, "wallZone": 0.5,
         "rhoC": 0.7, "rhoW": 0.5, "rhoF": 0.2, "mf": 1.0, "targets": {}, "luminaires": lum}
    r.update(kw)
    return r


def _lum(x, y, **kw):
    d = {"id": f"l{x}_{y}", "x": x, "y": y, "photometryId": "p", "mount": "recessed"}
    d.update(kw)
    return d


def _run(room, webs, detail="full", **kw):
    return RL.evaluate_room(RL._Room(room, webs, detail), webs, **kw)


def test_direct_only_matches_inverse_square_exactly():
    webs, prof = _webs("generic_downlight_narrow", 3000.0)
    room = RL._Room(_room([[0, 0], [4, 0], [4, 4], [0, 4]], [_lum(2, 2)], rhoC=0, rhoW=0, rhoF=0), webs, "full")
    H = 2.7
    I0 = prof["cd"][0][0]
    E = RL._direct(room, webs, np.array([[2.0, 2.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))[0]
    assert abs(E - I0 / H ** 2) / (I0 / H ** 2) < 1e-6
    # off-axis point: E = I(γ)·cosγ / d², cosγ = H/d
    x = 1.0
    d = math.hypot(x, H)
    g = math.degrees(math.acos(H / d))
    Ig = webs["p"].intensity(np.array([0.0]), np.array([g]))[0]
    E2 = RL._direct(room, webs, np.array([[2.0 + x, 2.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))[0]
    assert abs(E2 - Ig * (H / d) / d ** 2) / E2 < 1e-6


def test_flux_balance_convex_and_l_shaped():
    webs, _ = _webs()
    rect = _room([[0, 0], [6, 0], [6, 5], [0, 5]], [_lum(1.5, 1.25), _lum(4.5, 1.25), _lum(1.5, 3.75), _lum(4.5, 3.75)])
    ell = _room([[0, 0], [10, 0], [10, 4], [4, 4], [4, 8], [0, 8]], [_lum(2, 2), _lum(7, 2), _lum(2, 6)])
    for r in (rect, ell):
        res = _run(r, webs)
        fb = res["fluxBalance"]
        assert abs(fb["absorbed"] - fb["emitted"]) / fb["emitted"] < 0.01, (r["polygon"], fb)


def test_interreflection_raises_illuminance_and_lumen_method_is_plausible():
    webs, _ = _webs()
    lum = [_lum(x, y) for x in (1.0, 3.0, 5.0) for y in (1.25, 3.75)]
    poly = [[0, 0], [6, 0], [6, 5], [0, 5]]
    dark = _run(_room(poly, lum, rhoC=0, rhoW=0, rhoF=0, wallZone=0), webs)
    lit = _run(_room(poly, lum, wallZone=0), webs)
    assert lit["workplane"]["Em"] > dark["workplane"]["Em"] * 1.15
    # Whole work plane, six 4000 lm panels over 30 m², room index 1.4, 70/50/20:
    # the tabulated utilisation factor for a near-Lambertian luminaire is ~0.75-0.85.
    uf = lit["workplane"]["Em"] * 30.0 / (6 * 4000.0)
    assert 0.72 < uf < 0.90, uf


def test_symmetric_room_gives_symmetric_grid():
    webs, _ = _webs()
    poly = [[0, 0], [6, 0], [6, 6], [0, 6]]
    res = _run(_room(poly, [_lum(1.5, 1.5), _lum(4.5, 1.5), _lum(1.5, 4.5), _lum(4.5, 4.5)]), webs)
    g = res["grid"]
    a = np.array([np.nan if v is None else v for v in g["values"]]).reshape(g["ny"], g["nx"])
    assert np.allclose(a, a.T, rtol=0.01, atol=0.5)
    assert np.allclose(a, a[::-1, :], rtol=0.01, atol=0.5)


def test_corner_blocks_direct_light_in_l_shaped_room():
    webs, _ = _webs()
    poly = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]]
    room = RL._Room(_room(poly, [_lum(8.0, 1.0)], rhoC=0, rhoW=0, rhoF=0), webs, "full")
    up = np.array([[0.0, 0.0, 1.0]])
    seen = RL._direct(room, webs, np.array([[6.0, 1.0, 0.75]]), up)[0]
    hidden = RL._direct(room, webs, np.array([[1.0, 8.0, 0.75]]), up)[0]
    assert seen > 10 and hidden == 0.0


def test_ugr_scales_with_flux_and_is_in_a_sane_range():
    webs, _ = _webs()
    poly = [[0, 0], [8, 0], [8, 6], [0, 6]]
    lum = [_lum(x, y) for x in (1.5, 4.0, 6.5) for y in (1.5, 4.5)]
    a = _run(_room(poly, lum), webs)
    webs2, _ = _webs(lumens=8000.0, watts=72.0)
    b = _run(_room(poly, lum), webs2)
    assert 10 < a["ugr"]["max"] < 35
    assert abs((b["ugr"]["max"] - a["ugr"]["max"]) - 8 * math.log10(2.0)) < 0.2
    assert len(a["ugr"]["observers"]) == 4


def test_verdict_energy_and_cylindrical():
    webs, _ = _webs()
    poly = [[0, 0], [6, 0], [6, 5], [0, 5]]
    lum = [_lum(x, y) for x in (1.0, 3.0, 5.0) for y in (1.25, 3.75)]
    res = _run(_room(poly, lum, targets={"em": 300, "uo": 0.4, "ugr": 40, "wallE": 50, "ceilE": 30, "ez": 50}), webs)
    assert res["pass"] is True and all(c["pass"] for c in res["checks"])
    assert abs(res["power"]["watts"] - 6 * 36.0) < 1e-6
    assert abs(res["power"]["wm2"] - 216.0 / 30.0) < 0.01
    assert res["cylindrical"]["Ez"] > 50
    fail = _run(_room(poly, lum[:1], targets={"em": 500}), webs)
    assert fail["pass"] is False
    none = _run(_room(poly, [], targets={"em": 500}), webs)
    assert none["pass"] is None


def test_mf_scales_illuminance_not_ugr():
    webs, _ = _webs()
    poly = [[0, 0], [6, 0], [6, 5], [0, 5]]
    lum = [_lum(1.5, 1.25), _lum(4.5, 3.75)]
    a = _run(_room(poly, lum, mf=1.0), webs)
    b = _run(_room(poly, lum, mf=0.8), webs)
    assert abs(b["workplane"]["Em"] / a["workplane"]["Em"] - 0.8) < 0.005
    assert a["ugr"]["max"] == b["ugr"]["max"]


def test_bad_inputs_are_reported_not_raised():
    webs, prof = _webs()
    out = RL.run_room_lighting({"rooms": [
        {"id": "a", "polygon": [[0, 0], [1, 1]]},
        _room([[0, 0], [4, 0], [4, 4], [0, 4]], [_lum(2, 2), _lum(9, 9), _lum(1, 1, photometryId="nope")]),
    ], "photometry": {"p": prof}})
    assert "error" in out["rooms"][0]
    r = out["rooms"][1]
    assert r["luminaires"] == 1 and len(r["warnings"]) == 2


def test_suggest_layout_meets_targets_and_fits_the_outline():
    webs, prof = _webs(lumens=3600.0, watts=34.0)
    room = _room([[0, 0], [8, 0], [8, 6], [0, 6]], [], targets={"em": 500, "uo": 0.6, "ugr": 19, "wallE": 75, "ceilE": 50})
    out = RL.suggest_layout({"room": room, "photometry": {"p": prof}, "photometryId": "p"})
    c = out["candidates"][0]
    assert c["result"]["pass"] is True
    assert c["result"]["Em"] >= 500 and c["result"]["U0"] >= 0.6 and c["result"]["ugr"] <= 19
    P = np.array(room["polygon"], float)
    assert all(RL._pip(P, np.array([x]), np.array([y]))[0] for x, y in c["positions"])
    assert c["count"] == len(c["positions"]) == c["rows"] * c["cols"]
    # ranked: a passing layout never comes after a failing one, and counts rise among passers
    flags = [x["result"]["pass"] for x in out["candidates"]]
    assert flags == sorted(flags, reverse=True)
    counts = [x["count"] for x in out["candidates"] if x["result"]["pass"]]
    assert counts == sorted(counts)
    # the suggestion re-evaluated with the full engine still passes on Em
    full = _run(dict(room, luminaires=[_lum(x, y) for x, y in c["positions"]]), webs)
    assert full["workplane"]["Em"] >= 0.95 * 500


def test_suggest_layout_l_shape_stays_inside_and_errors_are_clear():
    webs, prof = _webs(lumens=3600.0, watts=34.0)
    poly = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 8], [0, 8]]
    room = _room(poly, [], targets={"em": 300, "uo": 0.4})
    out = RL.suggest_layout({"room": room, "photometry": {"p": prof}, "photometryId": "p"})
    P = np.array(poly, float)
    for cand in out["candidates"]:
        assert all(RL._pip(P, np.array([x]), np.array([y]))[0] for x, y in cand["positions"])
    import pytest
    with pytest.raises(ValueError):
        RL.suggest_layout({"room": _room(poly, [], targets={}), "photometry": {"p": prof}, "photometryId": "p"})
    with pytest.raises(ValueError):
        RL.suggest_layout({"room": room, "photometry": {"p": prof}, "photometryId": "zz"})
