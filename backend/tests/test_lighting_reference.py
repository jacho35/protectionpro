"""Lighting engines against published, independently derived reference values.

Sources
  CIE 171:2006 "Test cases to assess the accuracy of lighting computer
  programs" — the analytical test cases, with the reference values as printed in
  the public validation report of Relux Desktop 2019 (Bouroussis, Nikolaou,
  Topalis, NTUA, May 2019, Tables 49, 57 and 63):
    TC5.2  direct illuminance on a 4 x 4 m surface under a diffuse point source
           (I = 1000 cd x cos γ, 3 m above the centre) — Table 49
    TC5.4  flux conservation in a closed 4 x 4 x 3 m room — Table 57
    TC5.8  interreflection in a closed 4 x 4 x 4 m room, isotropic 10 000 lm
           source at the centre, wall reflectance 0 … 95 % — Table 63

  The TC5.2 points A–J are the 0.5 m lattice points whose polar angles give the
  printed intensity column (Table 50): A (0,0) B (.5,0) C (1,0) D (1.5,0)
  E (.5,.5) F (1,.5) G (1.5,.5) H (1,1) I (1.5,1) J (1.5,1.5).

  Closed form for a dense row of luminaires (road): E(y) = 2 I H / (S (H² + y²)).

What these cannot show: UGR (the CIE 117 tables are not covered by a published
numeric case here), road luminance against CIE 140's test data (a separate part
of that report), or agreement with a particular program for a real luminaire.
"""
import math

import numpy as np
import pytest

from backend.analysis import area_lighting as AL
from backend.analysis import road_lighting as RL
from backend.analysis import room_lighting as ROOM
from backend.analysis.road_lighting import _Web


def _web(fn, lumens=1.0):
    """Canonical web from I(C, γ) = fn(C, γ) cd."""
    c = list(range(0, 361, 10))
    g = list(range(0, 181, 1))
    prof = {"c": c, "g": g, "cd": [[fn(cc, gg) for gg in g] for cc in c], "lumens": lumens, "watts": 0.0}
    w = _Web(prof)
    w.luminous_m2 = 0.0
    return {"p": w}


def _lambert(i0=1000.0):
    return _web(lambda c, g: i0 * math.cos(math.radians(g)) if g <= 90 else 0.0)


def _room(ceil_h, rho, webs, side=4.0, lum=None, **kw):
    h = side / 2.0
    r = {"id": "r", "polygon": [[-h, -h], [h, -h], [h, h], [-h, h]], "ceilH": ceil_h, "workH": 0.0, "mf": 1.0,
         "rhoC": rho, "rhoW": rho, "rhoF": rho, "wallZone": 0.0,
         "luminaires": [lum or {"id": "l", "x": 0, "y": 0, "photometryId": "p", "mount": "recessed"}]}
    r.update(kw)
    return ROOM._Room(r, webs, "full")


# ─── CIE 171 TC5.2 — direct illuminance, point source ───────────────────

TC52_POINTS = {"A": (0, 0), "B": (.5, 0), "C": (1, 0), "D": (1.5, 0), "E": (.5, .5), "F": (1, .5),
               "G": (1.5, .5), "H": (1, 1), "I": (1.5, 1), "J": (1.5, 1.5)}
TC52_REF = {"A": 111.11, "B": 105.21, "C": 90.02, "D": 71.11, "E": 99.73, "F": 85.64, "G": 68.06,
            "H": 74.36, "I": 59.98, "J": 49.39}


def test_tc52_room_engine_direct_illuminance():
    webs = _lambert()
    room = _room(3.0, 0.0, webs)
    P = np.array([[x, y, 0.0] for x, y in TC52_POINTS.values()])
    E = ROOM._direct(room, webs, P, np.tile([0.0, 0.0, 1.0], (len(P), 1)))
    for k, e in zip(TC52_POINTS, E):
        assert e == pytest.approx(TC52_REF[k], rel=0.001), k       # CIE values are printed to 4 figures


def test_tc52_outdoor_engine_direct_illuminance():
    webs = _lambert()
    L = AL._Lums([{"id": "p", "x": 0, "y": 0, "h": 3.0, "photometryId": "p", "rotate": 0.0, "tilt": 0.0}], webs)
    P = np.array([[x, y, 0.0] for x, y in TC52_POINTS.values()])
    E = L.illuminance(P, np.tile([0.0, 0.0, 1.0], (len(P), 1)))
    for k, e in zip(TC52_POINTS, E):
        assert e == pytest.approx(TC52_REF[k], rel=0.001), k


# ─── CIE 171 TC5.4 — flux conservation in a closed room ─────────────────

def test_tc54_closed_room_conserves_flux():
    webs = _lambert()                                            # Φ = π · 1000 = 3141.6 lm (Table 57: 3142)
    res = ROOM.evaluate_room(_room(3.0, 0.0, webs), webs, with_ugr=False, with_cyl=False)
    on_surfaces = res["walls"]["Em"] * 48.0 + res["ceiling"]["Em"] * 16.0 + res["floor"]["Em"] * 16.0
    assert on_surfaces == pytest.approx(math.pi * 1000.0, rel=0.01)      # Relux 2019: −0.04 %; patch sampling here


# ─── CIE 171 TC5.8 — interreflection, closed 4 x 4 x 4 m room ───────────

TC58_REF = {0.05: 5.48, 0.1: 11.6, 0.2: 26.0, 0.3: 44.6, 0.4: 69.4, 0.5: 104.0, 0.6: 156.0, 0.7: 243.0,
            0.8: 417.0, 0.9: 937.0, 0.95: 1979.0}


def _surface_mean(res):
    return (res["walls"]["Em"] * 64.0 + res["ceiling"]["Em"] * 16.0 + res["floor"]["Em"] * 16.0) / 96.0


def test_tc58_indirect_illuminance_for_every_reflectance():
    webs = _web(lambda c, g: 10000.0 / (4 * math.pi), lumens=10000.0)      # isotropic, 10 000 lm
    centre = {"id": "l", "x": 0, "y": 0, "photometryId": "p", "mount": "suspended", "drop": 2.0}
    run = lambda rho: ROOM.evaluate_room(_room(4.0, rho, webs, lum=centre, workH=0.5), webs, with_ugr=False, with_cyl=False)
    direct = _surface_mean(run(0.0))
    assert direct == pytest.approx(10000.0 / 96.0, rel=0.005)              # Φ / total surface area
    for rho, ref in TC58_REF.items():
        indirect = _surface_mean(run(rho)) - direct
        assert indirect == pytest.approx(ref, rel=0.01), rho               # Relux 2019 is within 4 % of the same table


# ─── Road: a dense row of luminaires is a line source ───────────────────

def test_dense_row_matches_line_source_closed_form():
    """Row of luminaires every 2 m, 10 m high, uniform 1000 cd. Counting the
    luminaires within ±5 H of the point (EN 13201-3 §7.2.7, what the engine
    does) the sum is the integral of I·H / (a² + x²)^(3/2) over ±5 H, with
    a² = H² + y²:   E(y) = (I / S) · 2 H · 5 H / (a² · sqrt(a² + 25 H²)).
    Without the range rule it would be 2 I H / (S a²)."""
    I, H, S = 1000.0, 10.0, 2.0
    web = {"name": "u", "c": list(np.arange(0, 361, 15.0)), "g": list(np.arange(0, 91, 5.0)),
           "cd": [[I] * 19 for _ in range(25)], "lumens": 1000, "watts": 50}
    req = {"sections": [{"type": "carriageway", "width": 12, "lanes": 1, "cls": "M3", "surface": "R3"}],
           "rows": [{"y": 0.0, "overhang": 0.0, "facing": "right", "height": H, "tilt": 0, "photometryId": "w"}],
           "photometry": {"w": web}, "spacing": S, "mf": 1.0}
    des = RL._Design(req)
    lum = RL._luminaires(des, S, -400.0, 400.0)
    for y in (0.0, 3.0, 6.0, 12.0):
        a2 = H * H + y * y
        want = (I / S) * 2 * H * 5 * H / (a2 * math.sqrt(a2 + 25 * H * H))
        E = RL._illuminance(des, lum, np.array([0.3]), np.array([y]))[0]
        assert E == pytest.approx(want, rel=0.002), y
        assert E < 2 * I * H / (S * a2)            # and the range rule really does remove light
