"""Emergency lighting (analysis/emergency_lighting.py): exact floor lux, EN 1838
criteria for routes, open areas and high-risk areas, walls blocking light."""
import math

import numpy as np

from backend.analysis import emergency_lighting as EM
from backend.analysis.photometry import generic_optic
from backend.analysis.road_lighting import _Web


def _prof(kind="generic_downlight_wide", lm=400.0):
    return generic_optic(kind, lm, 4.0)


def _lum(x, y, h=2.7, pct=100.0, **kw):
    d = {"id": f"e{x}_{y}", "x": x, "y": y, "h": h, "photometryId": "p", "emergPct": pct}
    d.update(kw)
    return d


def _run(item, prof=None):
    return EM.run_emergency_lighting({"items": [item], "photometry": {"p": prof or _prof()}})["items"][0]


def test_floor_lux_is_exact_inverse_square():
    prof = _prof()
    webs = {"p": _Web(prof)}
    E = EM._floor_lx(webs, [dict(x=0.0, y=0.0, h=2.7, photometryId="p", scale=1.0)], np.array([[0.0, 0.0]]), None, 1.0)[0]
    assert abs(E - prof["cd"][0][0] / 2.7 ** 2) / E < 1e-6
    half = EM._floor_lx(webs, [dict(x=0.0, y=0.0, h=2.7, photometryId="p", scale=0.5)], np.array([[0.0, 0.0]]), None, 1.0)[0]
    assert abs(half - E / 2) < 1e-9


def test_route_criteria_and_spacing():
    corridor = {"id": "r", "name": "Corridor", "type": "route", "line": [[0, 0], [24, 0]], "width": 1.2, "mf": 1.0,
                "luminaires": [_lum(x, 0.0) for x in (3, 9, 15, 21)]}
    ok = _run(dict(corridor, luminaires=[_lum(x, 0.0, pct=100) for x in range(2, 24, 4)]), _prof(lm=600))
    assert ok["pass"] is True and ok["centre"]["Emin"] >= 1.0 and ok["ratio"] <= 40
    far = _run(corridor, _prof(lm=60))
    assert far["pass"] is False
    assert any(c["key"] == "centre" and c["pass"] is False for c in far["checks"])
    # nothing in emergency mode → not compliant, with a reason
    none = _run(dict(corridor, luminaires=[_lum(3, 0.0, pct=0.0)]))
    assert none["pass"] is False and none["notes"]


def test_open_area_border_excluded_and_ratio():
    poly = [[0, 0], [10, 0], [10, 8], [0, 8]]
    item = {"id": "o", "name": "Hall", "type": "open", "polygon": poly, "mf": 1.0,
            "luminaires": [_lum(2.5, 2.0), _lum(7.5, 2.0), _lum(2.5, 6.0), _lum(7.5, 6.0)]}
    r = _run(item, _prof(lm=300))
    assert r["floor"]["Emin"] > 0.5 and r["pass"] is True
    r2 = _run(dict(item, luminaires=[_lum(5.0, 4.0)]), _prof(lm=100))
    assert r2["pass"] is False


def test_high_risk_needs_ten_percent_of_task_and_15_lx():
    poly = [[0, 0], [4, 0], [4, 4], [0, 4]]
    base = {"id": "h", "name": "Machine", "type": "highrisk", "polygon": poly, "mf": 1.0, "taskE": 500,
            "luminaires": [_lum(1.0, 1.0), _lum(3.0, 1.0), _lum(1.0, 3.0), _lum(3.0, 3.0)]}
    r = _run(base, _prof(lm=400))
    assert r["required"] == 50.0                           # 10 % of 500 lx beats the 15 lx floor
    assert _run(dict(base, taskE=100), _prof(lm=400))["required"] == 15.0


def test_walls_stop_light_in_an_l_shaped_room():
    poly = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]]
    prof = _prof(lm=800)
    lone = [_lum(8.0, 1.0)]
    lit = _run({"id": "a", "name": "A", "type": "route", "line": [[5, 1], [9, 1]], "width": 1.0, "mf": 1.0,
                "luminaires": lone, "bounds": poly}, prof)
    dark = _run({"id": "b", "name": "B", "type": "route", "line": [[1, 5], [1, 9]], "width": 1.0, "mf": 1.0,
                 "luminaires": lone, "bounds": poly}, prof)
    through = _run({"id": "c", "name": "C", "type": "route", "line": [[1, 5], [1, 9]], "width": 1.0, "mf": 1.0,
                    "luminaires": lone}, prof)
    assert lit["centre"]["Emin"] > 1.0
    assert dark["centre"]["Emax"] == 0.0 and through["centre"]["Emax"] > 0.0


def test_errors_are_reported():
    out = EM.run_emergency_lighting({"items": [{"id": "x", "type": "route", "line": [[0, 0]]}, {"id": "y", "type": "nope"}],
                                     "photometry": {"p": _prof()}})
    assert all("error" in i for i in out["items"])


def test_sans_10114_2_limits_differ_from_en_1838():
    poly = [[0, 0], [4, 0], [4, 4], [0, 4]]
    hr = {"id": "h", "name": "Machine", "type": "highrisk", "polygon": poly, "mf": 1.0, "taskE": 100,
          "luminaires": [_lum(1.0, 1.0), _lum(3.0, 1.0), _lum(1.0, 3.0), _lum(3.0, 3.0)]}
    en = _run(hr, _prof(lm=400))
    sans = _run(dict(hr, standard="SANS"), _prof(lm=400))
    assert en["required"] == 15.0 and en["standard"] == "EN 1838"          # EN 1838 4.4.1: 10 % but ≥ 15 lx
    assert sans["required"] == 20.0 and sans["standard"] == "SANS 10114-2"  # SANS 10114-2 5.4.1: 10 % or 20 lx

    hall = {"id": "o", "name": "Hall", "type": "open", "polygon": [[0, 0], [10, 0], [10, 8], [0, 8]], "mf": 1.0,
            "luminaires": [_lum(2.5, 2.0), _lum(7.5, 2.0), _lum(2.5, 6.0), _lum(7.5, 6.0)]}
    prof = _prof(lm=300)
    en_o = _run(hall, prof)
    sans_o = _run(dict(hall, standard="SANS 10114-2"), prof)
    assert next(c for c in en_o["checks"] if c["key"] == "open")["req"] == 0.5
    assert next(c for c in sans_o["checks"] if c["key"] == "open")["req"] == 1.0
    # SANS measures up to the perimeter (no border left out), so it samples more floor
    assert sans_o["floor"]["n"] > en_o["floor"]["n"]


def test_sans_route_has_no_central_band_check():
    route = {"id": "r", "name": "Corridor", "type": "route", "line": [[0, 0], [24, 0]], "width": 1.2, "mf": 1.0,
             "luminaires": [_lum(x, 0.0, pct=100) for x in range(2, 24, 4)]}
    prof = _prof(lm=600)
    assert any(c["key"] == "band" for c in _run(route, prof)["checks"])
    assert not any(c["key"] == "band" for c in _run(dict(route, standard="SANS"), prof)["checks"])
