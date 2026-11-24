"""Photometry lengthAxis (C0 / C90 runs along a linear fitting) and the orientation flag."""
import numpy as np
from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web
from backend.tests.test_room_lighting import _room, _lum, _run

POLY = [[0, 0], [8, 0], [8, 4], [0, 4]]


def _batten(axis=None):
    prof = generic_optic("generic_batten", 3000.0, 30.0)
    if axis:
        prof["lengthAxis"] = axis
    w = _Web(prof)
    w.luminous_m2 = prof.get("luminousM2", 0.0)
    return {"p": w}


def test_c90_axis_equals_rotating_every_fitting_90():
    a = _run(_room(POLY, [_lum(2, 2), _lum(6, 2)]), _batten("C90"))["workplane"]
    b = _run(_room(POLY, [_lum(2, 2, rotate=90), _lum(6, 2, rotate=90)]), _batten())["workplane"]
    assert abs(a["Em"] - b["Em"]) < 1e-6 and abs(a["Emin"] - b["Emin"]) < 1e-6


def test_default_axis_is_unchanged():
    a = _run(_room(POLY, [_lum(2, 2)]), _batten())["workplane"]
    b = _run(_room(POLY, [_lum(2, 2)]), _batten("C0"))["workplane"]
    assert a == b


def test_axis_changes_the_result_for_a_batten():
    a = _run(_room(POLY, [_lum(2, 2)]), _batten("C0"))["workplane"]
    b = _run(_room(POLY, [_lum(2, 2)]), _batten("C90"))["workplane"]
    assert a["Emin"] != b["Emin"]


def test_canonical_profile_carries_axis_and_flag():
    from backend.analysis.photometry import _canonical, _plane_mismatch
    c = [0.0, 90.0, 180.0, 270.0, 360.0]
    g = [0.0, 30.0, 60.0, 75.0, 90.0]
    row = lambda a: [1000.0, 900.0, a, a * 0.8, 0.0]
    cd = [row(500.0), row(900.0), row(500.0), row(900.0), row(500.0)]
    prof = _canonical("t", "m", c, g, cd, 3000.0, 30.0, "LDT")
    assert prof["lengthAxis"] == "C0"
    assert prof["orientationUnconfirmed"]
    sym = [row(700.0)] * 5
    assert _plane_mismatch(c, g, sym) == ""
