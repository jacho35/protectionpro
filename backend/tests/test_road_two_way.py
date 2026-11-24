"""Two-way carriageways (`direction: "two"`, 2 lanes only).

Anchors:
  • A two-way carriageway is one lane each way: lane 1 (the left looking up the
    chainage) travels up it when traffic drives on the left, down it when on
    the right. Each lane's observer (L̄, Uo, Ul, TI) is exactly that lane's
    observer in the same carriageway drawn one way in its direction.
  • SANS 10098-1: one quarter-width observer per direction of travel — on 2
    lanes that is each lane's centre; L̄ / Uo are the worse of the two, TI the
    higher.
  • "two" on any other lane count is read as one way up the chainage.
  • The Road plan engine on a straight road matches the cross-section engine.
"""

import pytest

from backend.analysis import road_lighting as RL
from backend.analysis import road_plan as RP
from backend.tests.test_road_plan import KEYS, S, WEB, _scene

OBS_KEYS = ("Lav", "Uo", "Ul", "TI")


def _secs(direction, cls="M4", lanes=2):
    return [{"type": "footpath", "width": 2, "cls": "P4"},
            {"type": "carriageway", "width": 7.4, "lanes": lanes, "cls": cls, "surface": "R3", "direction": direction},
            {"type": "footpath", "width": 2, "cls": "P4"}]


def _rows(secs=None):
    # a stagger at 0.3 S (not 0.5) is not symmetric front to back, so the two
    # directions of travel see the road differently
    return [{"y": 1.0, "overhang": 1.5, "facing": "right", "height": 10, "tilt": 5, "xOffset": 0, "photometryId": "g"},
            {"y": 12.4, "overhang": 1.5, "facing": "left", "height": 10, "tilt": 5, "xOffset": 0.3, "photometryId": "g"}]


@pytest.fixture(autouse=True)
def _asymmetric_scene(monkeypatch):
    import backend.tests.test_road_plan as TRP
    monkeypatch.setattr(TRP, "_rows", _rows)


def _cw(direction, standard="EN", drive=None, lanes=2):
    cls = "A4" if standard == "SANS" else "M4"
    req = {"sections": _secs(direction, cls, lanes), "rows": _rows(), "photometry": {"g": WEB}, "spacing": S,
           "mf": 0.8, "standard": standard}
    if drive:
        req["driveSide"] = drive
    res = RL.evaluate(RL._Design(req), S, full=False)
    return next(a for a in res["areas"] if a["type"] == "carriageway")


@pytest.mark.parametrize("drive,lane1,lane2", [(None, "forward", "reverse"), ("left", "forward", "reverse"),
                                               ("right", "reverse", "forward")])
def test_each_lane_is_seen_from_its_own_direction(drive, lane1, lane2):
    two = _cw("two", drive=drive)
    one = {d: _cw(d) for d in ("forward", "reverse")}
    assert [o["dir"] for o in two["observers"]] == [lane1, lane2]
    for k, d in enumerate((lane1, lane2)):
        for key in OBS_KEYS:
            assert two["observers"][k][key] == pytest.approx(one[d]["observers"][k][key], rel=1e-9), (k, key)
    # observers are reported to 4 dp
    assert two["Lav"] == pytest.approx(min(o["Lav"] for o in two["observers"]), abs=1e-4)
    assert two["TI"] == pytest.approx(max(o["TI"] for o in two["observers"]), abs=1e-4)


def test_two_way_differs_from_one_way():
    # the point of the setting: the opposing lane no longer looks the same way
    fwd, rev = _cw("forward"), _cw("reverse")
    assert abs(fwd["observers"][1]["Ul"] - rev["observers"][1]["Ul"]) > 0.02
    two = _cw("two")
    for key in OBS_KEYS:
        assert two["observers"][1][key] == pytest.approx(rev["observers"][1][key], abs=1e-4)


def test_sans_one_quarter_observer_per_direction():
    two = _cw("two", "SANS")
    fwd, rev = _cw("forward", "SANS"), _cw("reverse", "SANS")
    # on 2 lanes the quarter-width observer of each direction is its lane centre
    assert [d["dir"] for d in two["directions"]] == ["forward", "reverse"]
    assert two["directions"][0]["Lav"] == pytest.approx(fwd["Lav"], abs=1e-4)   # reported to 4 dp
    assert two["directions"][1]["Lav"] == pytest.approx(rev["Lav"], abs=1e-4)
    assert two["Lav"] == pytest.approx(min(fwd["Lav"], rev["Lav"]), rel=1e-9)
    assert two["Uo"] == pytest.approx(min(fwd["Uo"], rev["Uo"]), rel=1e-9)
    assert two["TI"] == pytest.approx(max(fwd["TI"], rev["TI"]), rel=1e-9)
    assert two["observers"][0]["Ul"] == pytest.approx(fwd["observers"][0]["Ul"], rel=1e-9)
    assert two["observers"][1]["Ul"] == pytest.approx(rev["observers"][1]["Ul"], rel=1e-9)
    assert "directions" not in fwd


def test_two_on_other_lane_counts_is_one_way():
    for n in (1, 3):
        a, b = _cw("two", lanes=n), _cw("forward", lanes=n)
        for key in OBS_KEYS:
            assert a[key] == pytest.approx(b[key], rel=1e-12)
        assert all(o["dir"] == "forward" for o in a["observers"])


@pytest.mark.parametrize("standard,drive", [("EN", "left"), ("EN", "right"), ("SANS", "left")])
def test_road_plan_matches_cross_section_engine(standard, drive):
    secs = [dict(s, cls=("CP4" if standard == "SANS" else "P4")) if s["type"] == "footpath" else
            dict(s, cls=("A4" if standard == "SANS" else "M4")) for s in _secs("two")]
    des, plan = _scene(secs, standard)
    des.req["driveSide"] = drive
    des = RL._Design(dict(des.req))
    plan["roads"][0]["driveSide"] = drive
    ref = RL.evaluate(des, S, full=False)
    seg = RP.run_road_plan(plan)["roads"][0]["segments"][0]
    for a, b in zip(ref["areas"], seg["strips"]):
        for k in KEYS:
            if k in a:
                assert b[k] == pytest.approx(a[k], rel=1e-3, abs=1e-4), (a["name"], k)
        if a.get("observers") and "Lav" in a["observers"][0]:
            assert [o["dir"] for o in a["observers"]] == [o["dir"] for o in b["observers"]]


def test_road_plan_luminance_map_per_lane():
    """The luminance map shows each lane as seen the way it travels."""
    def disp(direction):
        _, plan = _scene(_secs(direction))
        plan["display"] = True
        return RP.run_road_plan(plan)["roads"][0]["display"]
    two, fwd, rev = disp("two"), disp("forward"), disp("reverse")
    for j, y in enumerate(two["yc"]):
        if not 2.0 <= y <= 9.4:
            continue
        ref = fwd if y < 2.0 + 3.7 else rev
        a = [r[j] for r in two["L"]]
        b = [r[j] for r in ref["L"]]
        assert a == pytest.approx(b, rel=1e-9, abs=1e-9), y
