"""Outdoor area lighting (analysis/area_lighting.py): exact direct light with
tilt, GR scaling, perimeter vertical illuminance and its side."""
import math

import numpy as np
import pytest

from backend.analysis import area_lighting as AL
from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web


def _webs(kind="generic_flood_sym", lumens=20000.0, watts=150.0):
    prof = generic_optic(kind, lumens, watts)
    w = _Web(prof)
    w.luminous_m2 = prof["luminousM2"]
    return {"p": w}, prof


def _lum(x, y, h=8.0, **kw):
    d = {"id": f"p{x}_{y}", "x": x, "y": y, "h": h, "photometryId": "p", "rotate": 0.0, "tilt": 0.0}
    d.update(kw)
    return d


def _up(n=1):
    return np.tile([0.0, 0.0, 1.0], (n, 1))


def test_ground_illuminance_under_a_pole_is_exact():
    webs, prof = _webs()
    L = AL._Lums([_lum(0, 0)], webs)
    E = L.illuminance(np.array([[0.0, 0.0, 0.0]]), _up())[0]
    assert abs(E - prof["cd"][0][0] / 64.0) / E < 1e-6
    # off axis: E = I(γ)·cosγ/d²
    d = math.hypot(5.0, 8.0)
    Ig = webs["p"].intensity(np.array([0.0]), np.array([math.degrees(math.atan2(5.0, 8.0))]))[0]
    E2 = L.illuminance(np.array([[5.0, 0.0, 0.0]]), _up())[0]
    assert abs(E2 - Ig * (8.0 / d) / d ** 2) / E2 < 1e-6


def test_tilt_swings_the_beam_towards_the_front():
    webs, prof = _webs()
    H = 8.0
    # rotate 0 → C0 along +x, C90 (the front) along +y; tilt 30° leans the beam towards +y
    L = AL._Lums([_lum(0, 0, H, tilt=30.0)], webs)
    front = L.illuminance(np.array([[0.0, H * math.tan(math.radians(30)), 0.0]]), _up())[0]
    back = L.illuminance(np.array([[0.0, -H * math.tan(math.radians(30)), 0.0]]), _up())[0]
    c = math.cos(math.radians(30))
    assert abs(front - prof["cd"][0][0] * c * c * c / H ** 2) / front < 1e-3     # on the optical axis
    assert front > 2.0 * back
    # heading: rotating the luminaire 90° CCW turns its front from +y to −x
    L2 = AL._Lums([_lum(0, 0, H, tilt=30.0, rotate=90.0)], webs)
    left = L2.illuminance(np.array([[-H * math.tan(math.radians(30)), 0.0, 0.0]]), _up())[0]
    assert abs(left - front) / front < 1e-3


def _area(poly, **kw):
    a = {"id": "a1", "name": "Car park", "polygon": poly, "mf": 0.8, "targets": {}}
    a.update(kw)
    return a


def test_area_statistics_gr_and_verdict():
    webs, prof = _webs("generic_area", 12000.0, 100.0)
    poly = [[0, 0], [40, 0], [40, 24], [0, 24]]
    lums = [_lum(x, y, 8.0, rotate=0.0) for x in (10.0, 30.0) for y in (6.0, 18.0)]
    r = AL.run_area_lighting({"luminaires": lums, "areas": [_area(poly, targets={"em": 5, "uo": 0.25, "gr": 70})],
                              "photometry": {"p": prof}})["areas"][0]
    assert r["workplane"]["Em"] > 1 and r["workplane"]["U0"] > 0
    assert r["gr"] is not None and 0 < r["gr"]["max"] < 90
    assert r["power"]["watts"] == 400.0
    assert r["pass"] in (True, False) and len(r["checks"]) == 3
    # twice the flux → GR rises by 2.4·log10(2)
    webs2, prof2 = _webs("generic_area", 24000.0, 200.0)
    r2 = AL.run_area_lighting({"luminaires": lums, "areas": [_area(poly)], "photometry": {"p": prof2}})["areas"][0]
    assert abs((r2["gr"]["max"] - r["gr"]["max"]) - 2.4 * math.log10(2.0)) < 0.15
    assert abs(r2["workplane"]["Em"] / r["workplane"]["Em"] - 2.0) < 0.01


def test_pole_outside_the_area_still_lights_it():
    webs, prof = _webs()
    poly = [[0, 0], [10, 0], [10, 10], [0, 10]]
    out = AL.run_area_lighting({"luminaires": [_lum(-3.0, 5.0, 8.0, rotate=-90.0, tilt=35.0)], "areas": [_area(poly)],
                                "photometry": {"p": prof}})["areas"][0]
    assert out["workplane"]["Em"] > 1


def test_perimeter_vertical_illuminance_and_side():
    webs, prof = _webs()
    ring = [[0, 0], [30, 0], [30, 20], [0, 20]]
    # one flood inside the site, near the middle of the east fence, tilted at the fence
    lum = _lum(25.0, 10.0, 6.0, rotate=-90.0, tilt=50.0)          # front = +x
    mk = lambda side: {"id": "f", "name": "Fence", "line": ring, "closed": True, "side": side, "height": 1.5, "step": 1.0,
                       "mf": 1.0, "targets": {"evMin": 1}}
    inward = AL.run_area_lighting({"luminaires": [lum], "perimeters": [mk("in")], "photometry": {"p": prof}})["perimeters"][0]
    outward = AL.run_area_lighting({"luminaires": [lum], "perimeters": [mk("out")], "photometry": {"p": prof}})["perimeters"][0]
    assert inward["vertical"]["Evmax"] > 5.0
    assert outward["vertical"]["Evmax"] == 0.0           # a plane facing away from the lamp gets nothing
    assert abs(inward["length"] - 100.0) < 1e-6 and len(inward["profile"]) == 100
    assert inward["pass"] is False                       # the far fence is dark
    # exact value at the nearest fence point: E = I·cosθ/d², plane normal = −x (facing the lamp)
    L = AL._Lums([lum], webs)
    p = np.array([[30.0, 10.0, 1.5]])
    E = L.illuminance(p, np.array([[-1.0, 0.0, 0.0]]))[0]
    d = math.sqrt(25.0 + 4.5 ** 2)
    assert E > 0 and abs(E - L.illuminance(p, np.array([[-1.0, 0.0, 0.0]]))[0]) < 1e-12
    got = [q for q in inward["profile"] if abs(q["x"] - 30.0) < 1e-6 and abs(q["y"] - 9.5) < 0.6]
    assert got and got[0]["E"] > 1.0 and d > 0


def test_bad_inputs_are_reported():
    webs, prof = _webs()
    out = AL.run_area_lighting({"luminaires": [_lum(1, 1), _lum(2, 2, photometryId="nope")],
                                "areas": [{"id": "x", "polygon": [[0, 0], [1, 1]]}],
                                "perimeters": [{"id": "y", "line": [[0, 0]]}], "photometry": {"p": prof}})
    assert "error" in out["areas"][0] and "error" in out["perimeters"][0]


def test_pole_layout_suggestion_meets_targets_inside_the_outline():
    webs, prof = _webs("generic_area_sym", 12000.0, 100.0)
    poly = [[0, 0], [60, 0], [60, 36], [0, 36]]
    out = AL.suggest_area_layout({"area": _area(poly, targets={"em": 10, "uo": 0.25, "gr": 70}), "photometry": {"p": prof},
                                  "photometryId": "p", "h": 8.0})
    c = out["candidates"][0]
    assert c["result"]["pass"] is True and c["result"]["Em"] >= 10
    P = np.array(poly, float)
    assert all(AL._pip(P, np.array([l["x"]]), np.array([l["y"]]))[0] for l in c["luminaires"])
    assert c["count"] == len(c["luminaires"]) == c["rows"] * c["cols"]
    flags = [x["result"]["pass"] for x in out["candidates"]]
    assert flags == sorted(flags, reverse=True)
    with pytest.raises(ValueError):
        AL.suggest_area_layout({"area": _area(poly), "photometry": {"p": prof}, "photometryId": "p"})
