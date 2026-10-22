"""Room lighting with objects (analysis/room_lighting.py): obstacles that cast
shadows and take part in the interreflection, windows / doors on the walls,
calculation surfaces and the patch output the 3D view draws."""
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


RECT = [[0, 0], [6, 0], [6, 5], [0, 5]]
FOUR = [_lum(1.5, 1.25), _lum(4.5, 1.25), _lum(1.5, 3.75), _lum(4.5, 3.75)]
DESK = {"id": "desk", "cx": 2.0, "cy": 2.5, "w": 1.6, "d": 0.8, "rot": 0, "z0": 0.72, "h": 0.03, "rho": 0.45}
SHELF = {"id": "shelf", "cx": 5.0, "cy": 4.6, "w": 1.8, "d": 0.4, "rot": 0, "z0": 0.0, "h": 2.0, "rho": 0.4}
SCREEN = {"id": "scr", "cx": 3.6, "cy": 2.5, "w": 0.05, "d": 2.0, "rot": 15, "z0": 0.0, "h": 1.5, "rho": 0.5}
COLUMN = {"id": "col", "cx": 3.0, "cy": 4.0, "w": 0.4, "d": 0.4, "rot": 0, "z0": 0.0, "h": 2.7, "rho": 0.6}


def test_no_objects_and_non_blocking_objects_change_nothing():
    webs, _ = _webs()
    base = _run(_room(RECT, FOUR), webs)
    ghost = dict(DESK, blocks=False)
    same = _run(_room(RECT, FOUR, obstacles=[ghost], openings=[], surfaces=[]), webs)
    for k in ("workplane", "walls", "ceiling", "floor", "fluxBalance", "ugr", "cylindrical", "grid"):
        assert base[k] == same[k], k


def test_flux_still_balances_with_obstacles_and_openings():
    webs, _ = _webs()
    win = {"id": "w", "kind": "window", "a": [1.0, 5.0], "b": [3.4, 5.0], "sill": 0.9, "h": 1.4, "rho": 0.1}
    door = {"id": "d", "kind": "door", "a": [6.0, 0.5], "b": [6.0, 1.5], "sill": 0.0, "h": 2.1, "rho": 0.4}
    for obs in ([DESK], [SHELF, SCREEN], [DESK, SHELF, SCREEN, COLUMN]):
        res = _run(_room(RECT, FOUR, obstacles=obs, openings=[win, door]), webs)
        fb = res["fluxBalance"]
        # the interreflection conserves flux exactly; what is left is the direct light
        # sampled at patch centres, coarser on a thin screen than on a wall
        assert abs(fb["absorbed"] - fb["emitted"]) / fb["emitted"] < 0.02, (obs, fb)


def test_a_box_between_the_luminaire_and_a_point_blocks_the_direct_light():
    webs, _ = _webs("generic_downlight_narrow", 3000.0)
    slab = {"id": "s", "cx": 2.0, "cy": 2.0, "w": 1.0, "d": 1.0, "z0": 0.72, "h": 0.03}
    clear = RL._Room(_room([[0, 0], [4, 0], [4, 4], [0, 4]], [_lum(2, 2)]), webs, "full")
    shaded = RL._Room(_room([[0, 0], [4, 0], [4, 4], [0, 4]], [_lum(2, 2)], obstacles=[slab]), webs, "full")
    up = np.array([[0.0, 0.0, 1.0]] * 3)
    pts = np.array([[2.0, 2.0, 0.0],      # floor under the slab
                    [2.0, 2.0, 0.75],     # on its top
                    [3.6, 2.0, 0.0]])     # clear of it
    e0 = RL._direct(clear, webs, pts, up)
    e1 = RL._direct(shaded, webs, pts, up)
    assert e0[0] > 0 and e1[0] == 0.0
    assert abs(e1[1] - RL._direct(clear, webs, pts[1:2], up[1:2])[0]) < 1e-9
    assert abs(e1[2] - e0[2]) < 1e-9


def test_shelving_shades_the_floor_behind_it_and_points_inside_are_left_out():
    webs, _ = _webs()
    wall = {"id": "tall", "cx": 3.0, "cy": 2.5, "w": 0.6, "d": 5.0, "z0": 0.0, "h": 2.0, "rho": 0.5}
    lone = [_lum(1.5, 2.5)]
    a = _run(_room(RECT, lone), webs)
    b = _run(_room(RECT, lone, obstacles=[wall]), webs)
    # the far half of the room only gets light over the top of the partition
    g, gb = a["grid"], b["grid"]
    def at(gr, x, y):
        i = int((x - gr["x0"]) / gr["dx"]); j = int((y - gr["y0"]) / gr["dy"])
        return gr["values"][j * gr["nx"] + i]
    assert at(gb, 4.5, 2.5) < 0.5 * at(g, 4.5, 2.5)
    # points inside the partition are not on the work plane
    assert at(gb, 3.0, 2.5) is None
    assert any("inside objects" in n for n in b["notes"])


def test_an_opening_takes_its_own_reflectance_area_weighted():
    webs, _ = _webs()
    room = RL._Room(_room(RECT, FOUR, openings=[{"kind": "window", "a": [0.0, 5.0], "b": [6.0, 5.0], "sill": 0.0, "h": 2.7, "rho": 0.0}]), webs, "full")
    pos, nrm, area, rho, kind, du, dv, src = RL._patches(room)
    north = (kind == 2) & (np.abs(pos[:, 1] - 5.0) < 1e-6)
    assert north.any() and np.allclose(rho[north], 0.0)
    assert np.allclose(rho[(kind == 2) & ~north], 0.5)
    # half the height covered → half way between the wall and the window
    half = RL._Room(_room(RECT, FOUR, openings=[{"kind": "door", "a": [0.0, 5.0], "b": [6.0, 5.0], "sill": 0.0, "h": 1.35, "rho": 0.1}]), webs, "full")
    pos, nrm, area, rho, kind, du, dv, src = RL._patches(half)
    north = (kind == 2) & (np.abs(pos[:, 1] - 5.0) < 1e-6)
    wa = (rho[north] * area[north]).sum() / area[north].sum()
    assert abs(wa - (0.5 + 0.1) / 2) < 1e-9
    # a dark wall-sized window lowers the work plane
    plain = _run(_room(RECT, FOUR), webs)
    glazed = _run(_room(RECT, FOUR, openings=[{"kind": "window", "a": [0.0, 5.0], "b": [6.0, 5.0], "sill": 0.0, "h": 2.7, "rho": 0.0}]), webs)
    assert glazed["workplane"]["Em"] < plain["workplane"]["Em"]


def test_calculation_surfaces_match_the_point_calculation():
    webs, prof = _webs("generic_downlight_narrow", 3000.0)
    lum = [_lum(2, 2)]
    dark = dict(rhoC=0, rhoW=0, rhoF=0)
    surf_up = {"id": "t", "name": "Task", "cx": 2.0, "cy": 2.0, "w": 0.4, "d": 0.4, "z": 0.75, "face": "up", "target": 100, "grid": 0.2}
    # vertical board 1 m east of the luminaire, facing it (its x axis runs south → north, normal −x)
    surf_v = {"id": "v", "name": "Board", "cx": 3.0, "cy": 2.0, "w": 0.2, "z": 1.0, "h": 0.2, "rot": 90, "face": "vertical", "grid": 0.1}
    res = _run(_room([[0, 0], [4, 0], [4, 4], [0, 4]], lum, surfaces=[surf_up, surf_v], **dark), webs)
    s = {x["id"]: x for x in res["surfaces"]}
    room = RL._Room(_room([[0, 0], [4, 0], [4, 4], [0, 4]], lum, **dark), webs, "full")
    # 2×2 grid at ±0.1 m around (2, 2)
    p = np.array([[2.0 + dx, 2.0 + dy, 0.75] for dy in (-0.1, 0.1) for dx in (-0.1, 0.1)])
    e = RL._direct(room, webs, p, np.tile([0.0, 0.0, 1.0], (4, 1)))
    assert np.allclose(s["t"]["values"], np.round(e, 1))
    assert s["t"]["pass"] is True and any(c["key"] == "surf:t" for c in res["checks"])
    # vertical: E = I(γ)·cos(incidence)/d² with the normal pointing back at the luminaire (−x)
    H = 2.7
    for (yy, zz), v in zip([(1.95, 1.05), (2.05, 1.05), (1.95, 1.15), (2.05, 1.15)], s["v"]["values"]):
        dx, dy, dz = 1.0, yy - 2.0, zz - H
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        g = math.degrees(math.acos(-dz / d))
        c = math.degrees(math.atan2(dy, dx))
        I = webs["p"].intensity(np.array([c]), np.array([g]))[0]
        assert abs(v - round(I * (dx / d) / d ** 2, 1)) <= 0.1


def test_patches_carry_the_flux_balance():
    webs, _ = _webs()
    res = _run(_room(RECT, FOUR, obstacles=[DESK, SHELF], patches=True, mf=0.8), webs)
    P = res["patches"]
    n = len(P["E"])
    assert n == len(P["c"]) == len(P["u"]) == len(P["v"]) == len(P["rho"]) == len(P["kind"]) == len(P["src"])
    assert 3 in P["kind"] and set(P["src"]) >= {-1, 0, 1}
    area = np.array([4 * np.linalg.norm(np.cross(u, v)) for u, v in zip(P["u"], P["v"])])
    absorbed = float(((1 - np.array(P["rho"])) * area * np.array(P["E"])).sum())
    assert abs(absorbed - 0.8 * res["fluxBalance"]["emitted"]) / absorbed < 0.02
