"""Road plan with objects (analysis/road_plan.py): buildings and trees that
shade the road, facade checks (vertical illuminance) and measurement points."""

import math
from types import SimpleNamespace

import numpy as np
import pytest

from backend.analysis import road_plan as RP
from backend.analysis.road_lighting import _intensity_to, _Web
from backend.analysis.photometry import generic_optic

WEB = generic_optic("generic_medium", 10000, 80)
SECS = [{"type": "footpath", "width": 2, "cls": "P4"},
        {"type": "carriageway", "width": 7, "lanes": 2, "cls": "M4", "surface": "R3"},
        {"type": "footpath", "width": 2, "cls": "P4"}]


def _plan(**kw):
    lums = [{"id": f"L{k}", "x": 10.0 + 30.0 * k, "y": 4.0, "h": 10.0, "aim": -90.0, "tilt": 0.0,
             "photometryId": "g", "roadId": "r1"} for k in range(4)]
    p = {"standard": "EN", "mf": 0.8, "photometry": {"g": WEB}, "display": False,
         "roads": [{"id": "r1", "name": "R", "centreline": [[0.0, 0.0], [100.0, 0.0]], "sections": SECS,
                    "segments": [{"id": "s", "s0": 10.0, "s1": 70.0}]}],
         "luminaires": lums}
    p.update(kw)
    return p


def _ctx(obstacles=None):
    ctx = SimpleNamespace(webs={"g": _Web(WEB)}, mf=0.8, standard="EN")
    ctx.boxes, ctx.crowns = RP._obstacles(obstacles or [])
    return ctx


def _lum():
    return RP._luminaires(_plan()["luminaires"], {"g": _Web(WEB)})


def test_no_objects_or_non_blocking_objects_change_nothing():
    a = RP.run_road_plan(_plan())
    b = RP.run_road_plan(_plan(obstacles=[{"kind": "building", "cx": 25, "cy": 0, "w": 4, "d": 4, "h": 6, "blocks": False}],
                               surfaces=[], points=[]))
    assert a["roads"] == b["roads"] and a["conflictAreas"] == b["conflictAreas"]
    assert a["shadows"] is False and b["shadows"] is False


def test_a_box_over_the_road_shades_it_completely():
    lum = _lum()
    pt = {"x": 10.0, "y": -2.0, "z": 0.0}
    clear = RP.evaluate_point(_ctx(), lum, pt)["E"]
    # a gantry deck between the luminaire L0 at (10, 4, 10) and the point
    deck = {"kind": "gantry", "cx": 10.0, "cy": 1.0, "w": 3.0, "d": 3.0, "z0": 5.0, "h": 0.3}
    shaded = RP.evaluate_point(_ctx([deck]), lum, pt)["E"]
    only_l0 = float(RP._point_E(_ctx(), RP._subset(lum, np.array([True, False, False, False])),
                                np.array([[10.0, -2.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))[0])
    assert only_l0 > 0 and shaded == pytest.approx(clear - only_l0, abs=1e-3)


def test_a_tree_crown_lets_through_one_minus_its_opacity():
    lum = RP._subset(_lum(), np.array([True, False, False, False]))
    P, N = np.array([[10.0, -4.0, 0.0]]), np.array([[0.0, 0.0, 1.0]])
    clear = float(RP._point_E(_ctx(), lum, P, N)[0])
    # crown centred on the ray from (10, 4, 10) to (10, -4, 0), trunk well off it
    tree = {"kind": "tree", "cx": 10.0, "cy": 0.0, "h": 9.0, "crownR": 1.0, "crownBase": 3.0, "opacity": 0.6}
    ctx = _ctx([tree])
    ctx.boxes = []                                       # the trunk is not on this ray anyway
    got = float(RP._point_E(ctx, lum, P, N)[0])
    assert got == pytest.approx(0.4 * clear, rel=1e-9)


def test_shadows_reach_the_segment_checks_and_display():
    a = RP.run_road_plan(_plan(display=True))
    block = {"kind": "building", "cx": 40.0, "cy": 3.0, "w": 6.0, "d": 1.0, "z0": 0.0, "h": 9.0}
    b = RP.run_road_plan(_plan(display=True, obstacles=[block]))
    assert b["shadows"] is True
    sa, sb = a["roads"][0]["segments"][0], b["roads"][0]["segments"][0]
    cw = lambda s: next(x for x in s["strips"] if x.get("Lav") is not None)
    assert cw(sb)["Emin"] < cw(sa)["Emin"]
    Ea = np.array(a["roads"][0]["display"]["E"]); Eb = np.array(b["roads"][0]["display"]["E"])
    assert (Eb <= Ea + 1e-9).all() and (Eb < Ea - 1e-6).any()


def test_facade_vertical_illuminance_is_the_point_formula():
    lum = RP._subset(_lum(), np.array([True, False, False, False]))
    # a facade on the far side of the road, facing the luminaire (the left of a → b is +y)
    fac = {"id": "f", "name": "Block A", "a": [8.0, -8.0], "b": [12.0, -8.0], "z0": 0.0, "z1": 2.0, "grid": 1.0, "target": 1}
    out = RP.evaluate_surface(_ctx(), lum, fac)
    assert out["nu"] == 4 and out["nv"] == 2
    web = SimpleNamespace(webs={"g": _Web(WEB)})
    for k, v in enumerate(out["values"]):
        u, z = (k % 4) + 0.5, (k // 4) + 0.5
        px, py = 8.0 + u, -8.0 + 0.02
        dx, dy, dz = px - 10.0, py - 4.0, z - 10.0
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        I = float(_intensity_to(web, lum, np.array([[dx]]), np.array([[dy]]), np.array([[dz]]))[0, 0])
        assert v == pytest.approx(round(0.8 * I * (-dy / d) / d ** 2, 2), abs=0.01)
    assert out["pass"] is (out["Evmin"] >= 1)
