"""Obtrusive light (analysis/obtrusive_light.py): EN 12464-2:2024 Table 4 limits,
exact Ev and I at a property, facade luminance, TI on a road, upward light ratio,
post-curfew dimming."""
import math

import numpy as np
import pytest

from backend.analysis import obtrusive_light as OL
from backend.analysis.area_lighting import _Lums
from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web, TI_AGE


def _photo(kind="generic_sports_medium"):
    return {"p": generic_optic(kind, 100000.0, 800.0)}


def _lum(x, y, h=10.0, tilt=0.0, rotate=0.0, lid=None):
    return {"id": lid or f"L{x}_{y}", "x": x, "y": y, "h": h, "tilt": tilt, "rotate": rotate, "photometryId": "p"}


def _run(lums, checks, photo=None):
    return OL.run_obtrusive_light({"luminaires": lums, "checks": checks, "photometry": photo or _photo()})


def test_table_4_values():
    assert OL.ZONES["E2"]["ev"] == (5.0, 1.0) and OL.ZONES["E2"]["i"] == (7500.0, 500.0)
    assert OL.ZONES["E3"]["rul"] == 5.0 and OL.ZONES["E4"]["lb"] == 25.0
    assert OL.ZONES["E1"]["ev"] == (2.0, 0.0) and OL.ZONES["E0"]["rul"] == 0.0
    assert OL.ROAD_LA == {"none": 0.1, "M5": 1.0, "M4": 2.0, "M3": 2.0, "M2": 5.0, "M1": 5.0}


def test_upward_light_ratio_follows_the_tilt():
    photo = _photo()
    down = _run([_lum(0, 0)], [], photo)["rul"]
    level = _run([_lum(0, 0, tilt=90.0)], [], photo)["rul"]
    assert down["rul"] == pytest.approx(0.0, abs=0.05)
    assert level["rul"] == pytest.approx(50.0, abs=1.5)            # beam axis on the horizon: half up
    mixed = _run([_lum(0, 0, lid="a"), _lum(5, 0, tilt=90.0, lid="b")], [], photo)["rul"]
    assert mixed["rul"] == pytest.approx(level["rul"] / 2, abs=0.5) and mixed["worstId"] == "b"


def test_property_ev_and_intensity_are_exact():
    photo = _photo()
    lum = _lum(0.0, 0.0, h=10.0, tilt=30.0, rotate=-90.0)          # front (−sin r, cos r) = +x: tilted towards the property
    # a property line along y at x = 6 (travel +y: left is −x, towards the luminaire); one sample at (6, 0)
    chk = {"id": "c", "name": "Window", "kind": "property", "line": [[6.0, -1.0], [6.0, 1.0]], "side": "left",
           "heights": [4.0], "step": 2.0, "zone": "E2", "curfew": "pre", "facadeRho": 0.3}
    r = _run([lum, _lum(20.0, 0.0, lid="behind")], [chk], photo)["checks"][0]
    L = _Lums([lum], {"p": _Web(photo["p"])})
    d = np.array([6.0, 0.0, 4.0 - 10.0])
    I = float(L.intensity(d[0:1][None, :], d[1:2][None, :], d[2:3][None, :])[0, 0])
    dist = float(np.linalg.norm(d))
    assert r["Evmax"] == pytest.approx(I * (6.0 / dist) / dist ** 2, rel=1e-3)
    assert r["Imax"] == pytest.approx(I, rel=1e-3)                    # the luminaire behind the face does not count
    assert r["Lb"] == pytest.approx(0.3 * r["Evavg"] / math.pi, rel=1e-3)
    by = {c["key"]: c for c in r["checks"]}
    assert by["ev"]["req"] == 5.0 and by["i"]["req"] == 7500.0 and by["lb"]["req"] == 5.0 and by["rul"]["req"] == 2.5


def test_post_curfew_dimming_scales_the_light():
    lum = _lum(0.0, 0.0, h=10.0, tilt=30.0, rotate=-90.0)
    base = {"id": "c", "kind": "property", "line": [[6.0, -1.0], [6.0, 1.0]], "side": "left", "heights": [4.0], "step": 2.0, "zone": "E1"}
    pre = _run([lum], [dict(base, curfew="pre")])["checks"][0]
    half = _run([lum], [dict(base, curfew="post", postPct=50)])["checks"][0]
    off = _run([lum], [dict(base, curfew="post", postPct=0)])["checks"][0]
    assert half["Evmax"] == pytest.approx(pre["Evmax"] / 2, rel=1e-3)
    assert off["Evmax"] == 0.0 and off["Imax"] == 0.0
    by = {c["key"]: c for c in off["checks"]}
    assert by["ev"]["req"] == 0.0 and by["ev"]["pass"] is True    # E1 post-curfew: 0 lx


def test_road_threshold_increment():
    photo = _photo()
    # a flood 60 m ahead, 1 m off the road line, 8 m high, aimed back along the road towards the driver
    lum = _lum(60.0, 1.0, h=8.0, tilt=80.0, rotate=90.0)          # front = (−1, 0): towards x = 0
    chk = {"id": "r", "kind": "road", "line": [[-2.5, 0.0], [2.5, 0.0]], "step": 5.0, "roadClass": "M4"}
    r = _run([lum], [chk], photo)["checks"][0]
    # independent: the driver at (0, 0, 1.5) looking +x, 1° down
    L = _Lums([lum], {"p": _Web(photo["p"])})
    e = np.array([60.0, 1.0, 8.0 - 1.5])
    dist = float(np.linalg.norm(e))
    down = math.radians(1.0)
    cos_t = (e[0] * math.cos(down) - e[2] * math.sin(down)) / dist
    theta = math.degrees(math.acos(cos_t))
    I = float(L.intensity(-e[0:1][None, :], -e[1:2][None, :], -e[2:3][None, :])[0, 0])
    lv = 9.86 * (1 + (TI_AGE / 66.4) ** 4) * I * cos_t / dist ** 2 / theta ** 2
    assert r["La"] == 2.0
    assert r["TImax"] == pytest.approx(65.0 * lv / 2.0 ** 0.8, rel=1e-3)
    # above the 20° car-roof screen it is not seen
    near = _run([_lum(5.0, 0.0, h=8.0, tilt=80.0, rotate=90.0)], [chk], photo)["checks"][0]
    assert near["TImax"] == pytest.approx(0.0, abs=1e-9)


def test_bad_line_is_reported():
    r = _run([], [{"id": "c", "name": "X", "kind": "property", "line": [[0, 0]]}])["checks"][0]
    assert "error" in r
