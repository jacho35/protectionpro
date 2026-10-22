"""Road lighting on plan geometry (analysis/road_plan.py).

Anchors:
  • A straight road on the plan, lit by luminaires at a regular spacing, is
    the straight-road model of road_lighting.py: one calculation field between
    two luminaires must give the same Ē/Emin/Uo, L̄/Uo/Ul, TI and REI — EN and
    SANS, one-way and dual carriageways (reverse lanes).
  • The plan has no preferred axis: rotating and shifting the whole scene
    leaves every result unchanged.
  • The kerb-width profile only rescales the strips between the kerbs.
  • A conflict area is the mean / min of the illuminance on its own grid.
"""

import math

import numpy as np
import pytest

from backend.analysis import road_lighting as RL
from backend.analysis import road_plan as RP
from backend.analysis.photometry import generic_optic

WEB = generic_optic("generic_medium", 10000, 80)   # symmetric C ↔ 180−C (see the mirror note below)
S = 30.0

ONE_WAY = [{"type": "footpath", "width": 2, "cls": "P4"},
           {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": "M4", "surface": "R3"},
           {"type": "footpath", "width": 2, "cls": "P4"}]
DUAL = [{"type": "footpath", "width": 2, "cls": "P4"},
        {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": "M3", "surface": "R3", "direction": "forward"},
        {"type": "median", "width": 4},
        {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": "M3", "surface": "R3", "direction": "reverse"},
        {"type": "footpath", "width": 2, "cls": "P4"}]
SANS_ONE_WAY = [{"type": "footpath", "width": 2, "cls": "CP4"},
                {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": "A4", "surface": "R3"},
                {"type": "footpath", "width": 2, "cls": "CP4"}]


def _rows(secs):
    cws = [i for i, s in enumerate(secs) if s["type"] == "carriageway"]
    y = np.cumsum([0] + [s["width"] for s in secs])
    kl, kr = y[cws[0]], y[cws[-1] + 1]
    return [{"y": kl - 1.0, "overhang": 1.5, "facing": "right", "height": 10, "tilt": 5, "xOffset": 0, "photometryId": "g"},
            {"y": kr + 1.0, "overhang": 1.5, "facing": "left", "height": 10, "tilt": 5, "xOffset": 0.5, "photometryId": "g"}]


def _scene(secs, standard="EN", angle=0.0, shift=(0.0, 0.0)):
    """The straight-road design and the same road drawn on the plan.

    road_lighting's frame is right-handed (y to the LEFT of +x); the plan frame
    puts the cross-section's first strip on the left of a traveller, so the plan
    scene is the mirror image. With a web symmetric about its C90–C270 plane
    (I(C) = I(180° − C), as every road optic and the generic ones are) the
    mirror changes nothing."""
    req = {"sections": secs, "rows": _rows(secs), "photometry": {"g": WEB}, "spacing": S, "mf": 0.8, "standard": standard}
    des = RL._Design(req)
    lay = [s for s in des.sections if s["type"] == "carriageway"]
    yc = (lay[0]["y0"] + lay[-1]["y1"]) / 2
    ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))

    def tr(x, y):
        return [x * ca - y * sa + shift[0], x * sa + y * ca + shift[1]]

    lums = []
    for r in des.rows:
        for k in range(-14, 32):
            x = r["xOffset"] * S + k * S
            yrl = r["y"] + r["overhang"] * r["facing"]
            phi = 90.0 if r["facing"] > 0 else -90.0
            px, py = tr(x, -(yrl - yc))
            lums.append({"x": px, "y": py, "h": r["height"], "aim": -phi + angle, "tilt": r["tilt"],
                         "photometryId": "g", "roadId": "r1"})
    plan = {"standard": standard, "mf": 0.8, "photometry": {"g": WEB}, "display": False,
            "roads": [{"id": "r1", "name": "R", "centreline": [tr(-420, 0), tr(960, 0)], "sections": secs,
                       "segments": [{"id": "f", "s0": 420.0, "s1": 420.0 + S}]}],
            "luminaires": lums}
    return des, plan


KEYS = ("Eav", "Emin", "UoE", "Lav", "Uo", "Ul", "TI", "REI", "ES")


@pytest.mark.parametrize("secs,standard", [(ONE_WAY, "EN"), (DUAL, "EN"), (SANS_ONE_WAY, "SANS")])
def test_straight_road_matches_cross_section_engine(secs, standard):
    des, plan = _scene(secs, standard)
    ref = RL.evaluate(des, S, full=False)
    seg = RP.run_road_plan(plan)["roads"][0]["segments"][0]
    assert seg["fields"] == 1
    for a, b in zip(ref["areas"], seg["strips"]):
        for k in KEYS:
            if k in a:
                assert b[k] == pytest.approx(a[k], rel=1e-3, abs=1e-4), (a["name"], k)
        assert [c["pass"] for c in a["checks"]] == [c["pass"] for c in b["checks"]]


def test_rotation_and_shift_invariant():
    _, p0 = _scene(DUAL)
    _, p1 = _scene(DUAL, angle=37.0, shift=(1250.0, -830.0))
    a = RP.run_road_plan(p0)["roads"][0]["segments"][0]
    b = RP.run_road_plan(p1)["roads"][0]["segments"][0]
    for sa, sb in zip(a["strips"], b["strips"]):
        for k in KEYS:
            if sa.get(k) is not None:
                assert sb[k] == pytest.approx(sa[k], rel=1e-6, abs=1e-6), (sa["name"], k)


def test_segment_is_cut_into_fields_of_at_most_40m():
    _, plan = _scene(ONE_WAY)
    plan["roads"][0]["segments"] = [{"id": "long", "s0": 400.0, "s1": 500.0}]
    seg = RP.run_road_plan(plan)["roads"][0]["segments"][0]
    assert seg["fields"] == 3 and seg["fieldLength"] == pytest.approx(100 / 3, abs=0.01)


def test_kerb_width_profile_scales_only_between_the_kerbs():
    road = RP._Road({"centreline": [[0, 0], [100, 0]], "sections": ONE_WAY,
                     "kerbWidth": [[0, 7.4], [100, 11.1]]}, "EN")
    # centreline midway between the kerbs (y 2 … 9.4); offsets to the right
    assert road.offset(0.0, 2.0) == pytest.approx(-3.7)
    assert road.offset(100.0, 9.4) == pytest.approx(5.55)            # 1.5 × half-width
    assert road.offset(100.0, 11.4) == pytest.approx(5.55 + 2.0)     # footpath keeps 2 m
    assert road.offset(50.0, 0.0) == pytest.approx(-(3.7 * 1.25) - 2.0)
    # the right-hand normal of a road heading +x is −y
    _, py, _, _ = road.at(0.0, 9.4)
    assert py[0] == pytest.approx(-3.7)


def test_projection_round_trip_on_a_curve():
    th = np.linspace(0, math.pi / 2, 200)
    road = RP._Road({"centreline": np.c_[50 * np.cos(th), 50 * np.sin(th)].tolist(), "sections": ONE_WAY}, "EN")
    s = np.array([5.0, 30.0, 70.0])
    px, py, _, _ = road.at(s, np.array([2.0, 5.7, 9.4]))
    s2, off = road.project(px, py)
    assert s2 == pytest.approx(s, abs=0.05)
    assert off == pytest.approx([-3.7, 0.0, 3.7], abs=0.02)


def _curved_plan():
    th = np.linspace(0, math.pi / 2, 300)
    R = 60.0
    cl = np.c_[R * np.sin(th), R - R * np.cos(th)]          # heads +x, turns left
    road = RP._Road({"centreline": cl.tolist(), "sections": ONE_WAY}, "EN")
    lums = []
    for s in np.arange(5, road.length, 25.0):
        x, y, tx, ty = road.at(s, 9.4 + 1.0)                   # right-hand kerb + 1 m
        aim = math.degrees(math.atan2(tx[0], -ty[0]))          # facing back over the road (left normal)
        lums.append({"x": x[0] - 1.5 * ty[0], "y": y[0] + 1.5 * tx[0], "h": 10, "aim": aim, "tilt": 0,
                     "photometryId": "g", "roadId": "c"})
    return {"standard": "EN", "mf": 0.8, "photometry": {"g": WEB},
            "roads": [{"id": "c", "name": "Bend", "centreline": cl.tolist(), "sections": ONE_WAY,
                       "segments": [{"id": "b", "name": "Bend", "s0": 0, "s1": road.length, "kind": "bend", "radius": R}]}],
            "luminaires": lums,
            "conflictAreas": [{"id": "j", "name": "J", "cls": "C3",
                               "polygons": [[[0, -3.7], [20, -3.7], [20, 3.7], [0, 3.7]]]}]}


def test_curved_road_results_and_display_grid():
    out = RP.run_road_plan(_curved_plan())
    road = out["roads"][0]
    seg = road["segments"][0]
    assert seg["bend"] is True and seg["fields"] == math.ceil(seg["s1"] / 40.0)
    cw = next(s for s in seg["strips"] if s["type"] == "carriageway")
    assert cw["Lav"] > 0 and 0 < cw["Uo"] <= 1 and 0 < cw["Ul"] <= 1 and cw["TI"] >= 0
    assert len(cw["observers"]) == 2
    g = road["display"]
    n_s, n_y = len(g["s"]), len(g["yc"])
    assert np.asarray(g["E"]).shape == (n_s, n_y) and np.asarray(g["x"]).shape == (n_s, n_y)
    assert min(min(r) for r in g["E"]) >= 0
    # luminance only on the carriageway columns
    for j, y in enumerate(g["yc"]):
        col = [row[j] for row in g["L"]]
        if 2.0 + 1e-6 < y < 9.4 - 1e-6:
            assert all(v is not None for v in col)
        elif y < 2.0 - 1e-6 or y > 9.4 + 1e-6:
            assert all(v is None for v in col)
    assert road["energy"]["luminaires"] == len(_curved_plan()["luminaires"])


def test_conflict_area_is_the_mean_of_its_grid():
    plan = _curved_plan()
    out = RP.run_road_plan(plan)
    ca = out["conflictAreas"][0]
    assert ca["points"] == 20 * 7         # 1 m grid inside 20 × 7.4 m (cell centres)
    ctx = RP.SimpleNamespace(webs={"g": RL._Web(WEB)}, mf=0.8, standard="EN")
    lum = RP._luminaires(plan["luminaires"], ctx.webs)
    gx, gy = np.meshgrid(np.arange(0.5, 20, 1.0), np.arange(-3.7 + 0.5, 3.7, 1.0), indexing="ij")
    road = RP._Road(plan["roads"][0], "EN")
    s, _ = road.project(gx.ravel(), gy.ravel())
    _, _, tx, ty = road.at(s, np.full(len(s), road.yc))
    E = RP._illum(ctx, lum, gx.ravel(), gy.ravel(), tx, ty)
    assert ca["Eav"] == pytest.approx(float(E.mean()), rel=1e-3)
    assert ca["Emin"] == pytest.approx(float(E.min()), rel=1e-3)
    assert [c["key"] for c in ca["checks"]] == ["Eav", "Uo"]


def test_errors():
    plan = _curved_plan()
    plan["luminaires"][0]["photometryId"] = "missing"
    with pytest.raises(ValueError, match="no photometry"):
        RP.run_road_plan(plan)
    plan = _curved_plan()
    plan["luminaires"] = []
    with pytest.raises(ValueError, match="No luminaires"):
        RP.run_road_plan(plan)
    with pytest.raises(ValueError, match="at least two points"):
        RP._Road({"centreline": [[0, 0]], "sections": ONE_WAY}, "EN")
