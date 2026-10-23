"""Room lighting under a ceiling section (room_lighting.py `ceiling`): pitched,
barrel and stepped ceilings, walls cut to them, light blocked by a step, and
luminaires on the slope, as pendants and on the walls."""
import math

import numpy as np

from backend.analysis import room_lighting as RL
from backend.tests.test_room_lighting import _webs, _room, _lum, _run

RECT = [[0, 0], [8, 0], [8, 6], [0, 6]]
FOUR = [_lum(2, 1.5), _lum(6, 1.5), _lum(2, 4.5), _lum(6, 4.5)]


def _gable(eaves=3.0, apex=5.0, w=8.0):
    """Section across x (angle 0): eaves at both walls, apex in the middle."""
    return {"angle": 0, "s0": 0, "points": [[0, eaves], [w / 2, apex], [w, eaves]]}


def _patches(room, webs):
    r = RL._Room(room, webs, "full")
    return r, RL._solve(r, webs)


def test_a_level_profile_is_the_flat_ceiling():
    webs, _ = _webs()
    flat = _run(_room(RECT, FOUR), webs)
    level = _run(_room(RECT, FOUR, ceiling={"angle": 0, "s0": 0, "points": [[0, 2.7], [8, 2.7]]}), webs)
    assert abs(flat["workplane"]["Em"] - level["workplane"]["Em"]) < 1e-6
    assert abs(flat["ceiling"]["Em"] - level["ceiling"]["Em"]) < 1e-6
    assert abs(flat["walls"]["Em"] - level["walls"]["Em"]) < 1e-6


def test_gable_surfaces_have_their_true_area():
    webs, _ = _webs()
    room, S = _patches(_room(RECT, FOUR, ceiling=_gable()), webs)
    k = S["kind"]
    slope_len = math.hypot(4.0, 2.0)
    assert abs(S["area"][k == 1].sum() - 2 * slope_len * 6.0) < 1e-6          # two roof planes
    # walls: two eaves walls 6 m long × 3 m, two gable ends 8 × 3 plus the triangle 8 × 2 / 2
    walls = 2 * (6 * 3) + 2 * (8 * 3 + 8)
    assert abs(S["area"][k == 2].sum() - walls) / walls < 0.03                  # columns sample the sloping top


def test_flux_balances_under_pitched_barrel_and_stepped_ceilings():
    webs, _ = _webs()
    barrel = {"angle": 0, "s0": 0, "points": [[8 * i / 16, 3 + 2 * math.sin(math.pi * i / 16)] for i in range(17)]}
    stepped = {"angle": 90, "s0": 0, "points": [[0, 3], [3, 3], [3, 4.5], [6, 4.5]]}     # clerestory step
    mono = {"angle": 0, "s0": 0, "points": [[0, 2.6], [8, 4.2]]}
    for ceil in (_gable(), barrel, stepped, mono):
        res = _run(_room(RECT, FOUR, ceiling=ceil), webs)
        fb = res["fluxBalance"]
        assert abs(fb["absorbed"] - fb["emitted"]) / fb["emitted"] < 0.01, (ceil, fb)
        assert res["ceilingHeight"]["max"] >= res["ceilingHeight"]["min"]


def test_concave_sections_need_no_visibility_test_but_a_step_does():
    assert RL._Ceiling(_gable()).concave
    assert RL._Ceiling({"points": [[0, 2.6], [8, 4.2]]}).concave
    assert not RL._Ceiling({"points": [[0, 3], [3, 3], [3, 4.5], [6, 4.5]]}).concave
    assert not RL._Ceiling({"points": [[0, 5], [4, 3], [8, 5]]}).concave          # valley


def test_a_ceiling_step_hides_the_luminaire_behind_it():
    webs, _ = _webs(kind="generic_downlight_wide")
    # low ceiling (3 m) for y < 3, high (5 m) beyond; luminaire under the low part
    step = {"angle": 90, "s0": 0, "points": [[0, 3], [3, 3], [3, 5], [6, 5]]}
    room = RL._Room(_room(RECT, [_lum(4, 1.5)], ceiling=step), webs, "full")
    pts = np.array([[4.0, 5.5, 4.6],            # up in the high bay: the step is in the way
                    [4.0, 5.5, 0.75]])          # on the work plane: in plain sight
    up = np.array([[0.0, 0.0, -1.0], [0.0, 0.0, 1.0]])
    E = RL._direct(room, webs, pts, up)
    assert E[0] == 0.0 and E[1] > 0.0


def test_ceiling_mounted_luminaire_tilts_with_the_slope():
    webs, _ = _webs(kind="generic_downlight_wide")
    ceil = {"angle": 0, "s0": 0, "points": [[0, 3.0], [8, 3.0 + 8 * math.tan(math.radians(30))]]}   # 30° mono pitch
    room = RL._Room(_room(RECT, [_lum(4, 3)], ceiling=ceil), webs, "full")
    lx, ly, lz = room.lum["x"][0], room.lum["y"][0], room.lum["z"][0]
    assert abs(lz - (3.0 + 4 * math.tan(math.radians(30)) - 0.05)) < 1e-9          # light leaves 5 cm below the ceiling
    n = room.ceil.normal(np.array([lx]), np.array([ly]))[0]
    d = 1.5
    on_axis = np.array([[lx + n[0] * d, ly + n[1] * d, lz + n[2] * d]])
    E_axis = RL._direct(room, webs, on_axis, -n[None, :])[0]
    I0 = webs["p"].intensity(np.array([[0.0]]), np.array([[0.0]]))[0, 0]
    assert abs(E_axis - I0 / d ** 2) / (I0 / d ** 2) < 1e-6        # nadir square to the ceiling
    assert room.lum["framed"]


def test_pendant_hangs_at_its_height_and_wall_uplight_lights_upwards():
    webs, _ = _webs(kind="generic_downlight_wide")
    room = RL._Room(_room(RECT, [_lum(4, 3, mount="pendant", mountH=2.4),
                                 _lum(0.3, 3, id="w", mount="wall", mountH=2.0, tilt=180)], ceiling=_gable()), webs, "full")
    assert abs(room.lum["z"][0] - 2.4) < 1e-9
    assert abs(room.lum["x"][1] - 0.10) < 1e-9 and abs(room.lum["z"][1] - 2.0) < 1e-9      # on the wall, 10 cm off it
    # only the uplight: nothing on the floor below it, light on the ceiling above
    only = RL._Room(_room(RECT, [_lum(0.3, 3, id="w", mount="wall", mountH=2.0, tilt=180)], ceiling=_gable()), webs, "full")
    floor = RL._direct(only, webs, np.array([[0.6, 3.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))[0]
    hc = float(only.ceil.height(np.array([0.6]), np.array([3.0]))[0])
    ceil = RL._direct(only, webs, np.array([[0.6, 3.0, hc - 0.01]]), only.ceil.normal(np.array([0.6]), np.array([3.0])))[0]
    assert floor == 0.0 and ceil > 0.0


def test_a_bad_section_falls_back_to_flat_with_a_warning():
    webs, _ = _webs()
    res = _run(_room(RECT, FOUR, ceiling={"angle": 0, "points": [[0, 3], [5, 4], [2, 3]]}), webs)
    assert any("Ceiling section" in w for w in res["warnings"])
    assert "ceilingHeight" not in res


def test_layout_suggestion_works_under_a_pitched_ceiling():
    webs, prof = _webs()
    room = _room(RECT, [], ceiling=_gable(), targets={"em": 300, "uo": 0.4})
    out = RL.suggest_layout({"room": room, "photometry": {"p": prof}, "photometryId": "p"})
    assert out["candidates"] and out["candidates"][0]["count"] >= 1


def test_flux_balances_for_fittings_on_the_ridge_on_walls_and_hanging():
    """Near a surface the direct light is integrated over sub-samples of the
    patches, and a fitting on the ridge faces the bisector of the slopes."""
    webs, _ = _webs()
    big = [[0, 0], [12, 0], [12, 8], [0, 8]]
    gable = {"angle": 90, "s0": 0, "points": [[0, 3], [4, 6], [8, 3]]}
    cases = [([_lum(6, 4)], gable), ([_lum(6, 4, mount="pendant", mountH=2.6)], gable),
             ([_lum(0.3, 4, mount="wall", mountH=2.0, tilt=180)], gable),
             ([_lum(0.3, 4, mount="wall", mountH=2.0, tilt=0)], gable),
             ([_lum(0.3, 4, mount="wall", mountH=2.0, tilt=90)], None)]
    for lums, ceil in cases:
        fb = _run(_room(big, lums, ceiling=ceil), webs)["fluxBalance"]
        assert abs(fb["absorbed"] - fb["emitted"]) / fb["emitted"] < 0.02, (lums, fb)
