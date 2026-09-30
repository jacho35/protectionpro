"""Road lighting (EN 13201-3) engine and photometry parsers.

Closed-form anchors — each isolates one piece of the calculation:
  • r-tables: S1 = r(0, 2)/r(0, 0) reproduces every CIE class's published S1
  • illuminance: E = I·cos³γ/H² for a uniform-intensity source, × MF
  • luminance: L = I·r(β, tan γ)/H², with r read from the table at the exact
    geometry, and L = Q0·E on a perfectly diffuse (Lambertian) test surface
  • β convention: luminaire beyond the point (seen past it) ⇒ β = 0
  • frame: C90 points to the side a row faces; tilt throws light further across
  • TI: Lv ∝ flux and Li ∝ flux ⇒ TI(k·Φ)/TI(Φ) = k^0.2 exactly (Li ≤ 5)
  • EN 13201-3 grid counts; IES / LDT symmetry expansion and flux
"""

import json
import math

import numpy as np
import pytest

from backend.analysis import road_rtables as RT
from backend.analysis import road_lighting as RL
from backend.analysis.photometry import parse_ies, parse_ldt, generic_optic, total_flux


def uniform_web(cd=1000.0, g_max=90.0, lumens=None):
    """Same intensity in every direction of the lower hemisphere (γ ≤ g_max)."""
    c = list(np.arange(0, 361, 15.0))
    g = list(np.arange(0, g_max + 1e-9, 5.0))
    web = [[cd] * len(g) for _ in c]
    flux = total_flux(c, g, web)
    return {"name": "uniform", "c": c, "g": g, "cd": web, "lumens": lumens or flux, "watts": 50}


def half_web(cd=1000.0):
    """Intensity only towards the C0–C180 half containing C90 (street side)."""
    c = list(np.arange(0, 361, 5.0))
    g = list(np.arange(0, 91, 5.0))
    web = [[cd if 0 < ci < 180 else 0.0 for _ in g] for ci in c]
    return {"name": "half", "c": c, "g": g, "cd": web, "lumens": 1000, "watts": 50}


def design(sections, rows, phot, **kw):
    req = {"sections": sections, "rows": rows, "photometry": phot, "spacing": kw.pop("spacing", 30), "mf": kw.pop("mf", 1.0)}
    req.update(kw)
    return req


# ─── r-tables ────────────────────────────────────────────────────────────

class TestRTables:
    PUBLISHED_S1 = {"R1": 0.25, "R2": 0.58, "R3": 1.11, "R4": 1.55, "C1": 0.24, "C2": 0.97}

    @pytest.mark.parametrize("name", ["R1", "R2", "R3", "R4", "C1", "C2"])
    def test_specular_factor_matches_published(self, name):
        r = RT.RTABLES[name]["r"]
        i2 = RT.TAN.index(2)
        assert r[i2][0] / r[0][0] == pytest.approx(self.PUBLISHED_S1[name], abs=0.006)

    def test_shape_and_r3_anchor(self):
        for t in RT.RTABLES.values():
            assert len(t["r"]) == 29 and all(len(row) == 20 for row in t["r"])
        assert RT.RTABLES["R3"]["r"][0][0] == 294          # R3 r(0,0)·10⁴

    def test_lookup_is_exact_on_table_nodes(self):
        rt = RL._RTable("R3")
        tb = RT.RTABLES["R3"]["r"]
        for it, ib in [(0, 0), (4, 5), (10, 13), (8, 19)]:
            got = rt.lookup(np.array([RT.BETA[ib]], float), np.array([RT.TAN[it]], float))[0]
            assert got == pytest.approx(tb[it][ib] * 1e-4)

    def test_beyond_table_is_ignored(self):
        rt = RL._RTable("R3")
        assert rt.lookup(np.array([0.0]), np.array([12.5]))[0] == 0.0


# ─── Grid rules (EN 13201-3 §7.1.3, §7.2.7) ─────────────────────────────

class TestGrid:
    def test_longitudinal(self):
        xs, d = RL._long_points(30.0)
        assert len(xs) == 10 and d == pytest.approx(3.0) and xs[0] == pytest.approx(1.5)
        xs, d = RL._long_points(36.0)
        assert len(xs) == 12 and d == pytest.approx(3.0)
        xs, d = RL._long_points(37.0)
        assert len(xs) == 13 and d <= 3.0

    def test_transverse(self):
        assert len(RL._trans_points(0, 7.0)) == 5                  # d ≤ 1.5 m
        assert len(RL._trans_points(0, 2.0)) == 3                  # n ≥ 3
        ys = RL._trans_points(1.0, 3.0)
        assert ys[0] == pytest.approx(1.5) and ys[-1] == pytest.approx(3.5)


# ─── Illuminance and luminance, closed form ─────────────────────────────

def one_lum_design(web, mf=0.8, surface="R3", facing="right", tilt=0, height=10.0, S=1000.0):
    """One luminaire per (very long) spacing so exactly one lights the field."""
    req = design([{"type": "carriageway", "width": 10, "lanes": 1, "cls": "M3", "surface": surface}],
                 [{"y": 0.0, "overhang": 0.0, "facing": facing, "height": height, "tilt": tilt, "photometryId": "w"}],
                 {"w": web}, spacing=S, mf=mf)
    return RL._Design(req)


class TestPhotometricLaws:
    def test_illuminance_cos_cubed(self):
        des = one_lum_design(uniform_web(1000.0), mf=0.8)
        lum = RL._luminaires(des, 1000.0, -1, 1)
        px = np.array([0.0, 0.0, 5.0]); py = np.array([0.0, 10.0, 0.0])
        E = RL._illuminance(des, lum, px, py)
        for e, (x, y) in zip(E, zip(px, py)):
            d = math.sqrt(x * x + y * y + 100.0)
            assert e == pytest.approx(0.8 * 1000.0 * 10.0 / d ** 3, rel=1e-9)

    def test_luminance_equals_I_r_over_H2(self):
        des = one_lum_design(uniform_web(1000.0), mf=0.9)
        lum = RL._luminaires(des, 1000.0, -1, 1)
        rt = RL._RTable("R3")
        # Point 20 m before the luminaire, on its line: β = 0 (seen past the point), tan γ = 2
        L = RL._luminance(des, lum, np.array([-20.0]), np.array([0.0]), rt, -80.0, 0.0, 1.0)[0]
        r = RT.RTABLES["R3"]["r"][RT.TAN.index(2)][0] * 1e-4
        assert L == pytest.approx(0.9 * 1000.0 * r / 100.0, rel=1e-9)
        # Same point, luminaire now BEHIND it (observer past the luminaire): β = 180
        L2 = RL._luminance(des, lum, np.array([20.0]), np.array([0.0]), rt, -40.0, 0.0, 1.0)[0]
        r180 = RT.RTABLES["R3"]["r"][RT.TAN.index(2)][19] * 1e-4
        assert L2 == pytest.approx(0.9 * 1000.0 * r180 / 100.0, rel=1e-9)

    def test_lambertian_surface_L_equals_q0_E(self, monkeypatch):
        q0 = 0.07
        lam = {"q0": q0, "beta": RT.BETA, "tan": RT.TAN, "r": [[q0 * 1e4 / (1 + t * t) ** 1.5] * 20 for t in RT.TAN]}
        monkeypatch.setitem(RT.RTABLES, "LAMB", lam)
        des = one_lum_design(uniform_web(1000.0), mf=1.0)
        lum = RL._luminaires(des, 1000.0, -1, 1)
        rt = RL._RTable("LAMB")
        for t_node in (0.0, 1.0, 3.0):                  # on tan nodes, exact under linear interp
            px, py = np.array([-10.0 * t_node]), np.array([0.0])
            L = RL._luminance(des, lum, px, py, rt, -100.0, 0.0, 1.0)[0]
            E = RL._illuminance(des, lum, px, py)[0]
            assert L == pytest.approx(q0 * E, rel=1e-9)

    def test_c90_points_to_the_facing_side(self):
        for facing, lit_y, dark_y in (("right", 5.0, -5.0), ("left", -5.0, 5.0)):
            des = one_lum_design(half_web(), facing=facing)
            lum = RL._luminaires(des, 1000.0, -1, 1)
            E = RL._illuminance(des, lum, np.array([0.0, 0.0]), np.array([lit_y, dark_y]))
            assert E[0] > 0 and E[1] == 0.0

    def test_tilt_throws_light_across(self):
        web = {"name": "beam", "c": [0, 360], "g": list(range(0, 91)),
               "cd": [[1000.0 if gg <= 10 else 0.0 for gg in range(0, 91)]] * 2, "lumens": 1000, "watts": 10}
        flat = one_lum_design(web, tilt=0)
        tilted = one_lum_design(web, tilt=15)
        lum_f = RL._luminaires(flat, 1000.0, -1, 1); lum_t = RL._luminaires(tilted, 1000.0, -1, 1)
        y = np.array([4.0])                              # γ = 21.8° from plumb: outside a 10° beam…
        assert RL._illuminance(flat, lum_f, np.array([0.0]), y)[0] == 0.0
        assert RL._illuminance(tilted, lum_t, np.array([0.0]), y)[0] > 0.0   # …inside it once tilted 15°


# ─── Threshold increment ─────────────────────────────────────────────────

def test_ti_scales_with_flux_to_the_power_0_2():
    web = generic_optic("generic_medium", 8000, 60)
    base = design([{"type": "carriageway", "width": 7, "lanes": 2, "cls": "M4", "surface": "R3"}],
                  [{"y": -1.0, "overhang": 1.5, "facing": "right", "height": 10, "photometryId": "g", "fluxPct": 50}],
                  {"g": web}, spacing=35, mf=0.8)
    lo = RL.run_road_lighting(base)["result"]["areas"][0]
    base["rows"][0]["fluxPct"] = 100
    hi = RL.run_road_lighting(base)["result"]["areas"][0]
    assert hi["Lav"] < 5 / 0.8 * 0.8
    assert hi["TI"] / lo["TI"] == pytest.approx(2 ** 0.2, rel=1e-6)
    assert hi["Uo"] == pytest.approx(lo["Uo"], rel=1e-9)     # uniformities are flux-free


# ─── Classes, solvers, serialisation ────────────────────────────────────

def two_lane(**kw):
    web = generic_optic("generic_medium", 12000, 90)
    return design([
        {"type": "footpath", "width": 2, "cls": "P4"},
        {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": "M4", "surface": "R3"},
        {"type": "footpath", "width": 2, "cls": "P4"},
    ], [{"y": 1.0, "overhang": 1.5, "facing": "right", "height": 10, "tilt": 0, "photometryId": "g"}],
        {"g": web}, spacing=kw.pop("spacing", 35), mf=0.8, **kw)


def test_verify_checks_and_json():
    out = RL.run_road_lighting(two_lane())
    json.dumps(out)                                          # no numpy scalars
    r = out["result"]
    cw = r["areas"][1]
    assert [c["key"] for c in cw["checks"]] == ["Lav", "Uo", "Ul", "TI", "REI"]
    assert cw["checks"][0]["req"] == RL.M_CLASSES["M4"]["Lav"]
    assert [c["key"] for c in r["areas"][0]["checks"]] == ["Eav", "Emin"]
    assert r["pass"] == all(a["pass"] for a in r["areas"] if a["pass"] is not None)
    e = r["energy"]
    assert e["wPerKm"] == pytest.approx(90 * 1000 / 35, abs=0.1)
    assert e["polesPerKm"] == pytest.approx(1000 / 35, abs=0.01)


def test_max_spacing_is_the_largest_passing():
    req = two_lane(mode="maxSpacing", spacingSweep={"min": 20, "max": 60, "step": 2})
    out = RL.run_road_lighting(req)
    json.dumps(out)
    passing = [p["spacing"] for p in out["sweep"] if p["pass"]]
    assert out["best"] == (max(passing) if passing else None)
    if out["best"] is not None:
        assert out["result"]["pass"] is True


def test_optimise_ranks_passing_options():
    req = two_lane(mode="optimise", optimise={"heights": [8, 10], "tilts": [0, 10], "fluxPcts": [70, 100],
                                              "spacing": {"min": 20, "max": 50, "step": 2}, "rank": "wPerKm"})
    out = RL.run_road_lighting(req)
    json.dumps(out)
    assert out["nEvaluated"] == 8
    w = [o["energy"]["wPerKm"] for o in out["options"]]
    assert w == sorted(w)
    for o in out["options"][:3]:                            # each option really passes at its spacing
        chk = two_lane(spacing=o["spacing"])
        chk["rows"][0].update(height=o["height"], tilt=o["tilt"], fluxPct=o["fluxPct"])
        assert RL.run_road_lighting(chk)["result"]["pass"] is True


def test_unknown_photometry_is_a_clear_error():
    req = two_lane()
    req["rows"][0]["photometryId"] = "nope"
    with pytest.raises(ValueError, match="photometry"):
        RL.run_road_lighting(req)


# ─── Photometry files ───────────────────────────────────────────────────

IES_BILATERAL = """IESNA:LM-63-2002
[MANUFAC] Test Co
[LUMINAIRE] Test road
TILT=NONE
1 -1 1 3 3 1 2 0.3 0.6 0.1
1 1 60
0 45 90
0 90 180
100 200 50
300 400 60
500 600 70
"""


def test_ies_bilateral_expansion():
    p = parse_ies(IES_BILATERAL)
    assert p["c"][0] == 0 and p["c"][-1] == 360
    c = np.array(p["c"]); cd = np.array(p["cd"])
    at = lambda deg: cd[int(np.argmin(np.abs(c - deg)))]
    assert list(at(90)) == [300, 400, 60]
    assert list(at(270)) == [300, 400, 60]                  # mirror of C90 about C0–C180
    assert list(at(180)) == [500, 600, 70]
    assert p["watts"] == 60 and p["name"] == "Test road"
    assert p["lumens"] == pytest.approx(p["fluxIntegrated"])  # absolute photometry


def ldt_text(isym=1, mc=1, dc=0, planes=1, value=100.0, flux=2000.0):
    g = list(range(0, 91, 10))
    lines = ["Maker", "1", str(isym), str(mc), str(dc), str(len(g)), "10", "rep", "LDT road", "no", "f.ldt", "date",
             "500", "200", "100", "400", "150", "0", "0", "0", "0", "100", "80", "1", "0", "1",
             "1", "LED", str(flux), "4000", "80", "40"]
    lines += ["0.5"] * 10
    lines += [str(i * (dc or 0)) for i in range(mc)]
    lines += [str(x) for x in g]
    lines += [str(value)] * (planes * len(g))
    return "\n".join(lines) + "\n"


def test_ldt_rotational_symmetry_and_scaling():
    p = parse_ldt(ldt_text())
    cd = np.array(p["cd"])
    assert np.allclose(cd[:, :10], 100.0 * 2000 / 1000)     # cd/klm × klm
    assert p["lumens"] == 2000 and p["watts"] == 40
    assert p["fluxIntegrated"] == pytest.approx(200.0 * 2 * math.pi * (1 - math.cos(math.radians(90))), rel=0.01)


def test_ldt_c0_c180_symmetry():
    txt = ldt_text(isym=2, mc=4, dc=90, planes=3)
    p = parse_ldt(txt)
    assert p["c"][0] == 0 and p["c"][-1] == 360


def test_generic_optics_integrate_to_rated_flux():
    for k in ("generic_narrow", "generic_medium", "generic_wide"):
        p = generic_optic(k, 10000, 80)
        assert p["fluxIntegrated"] == pytest.approx(10000, rel=0.002)
        cd = np.array(p["cd"]); c = np.array(p["c"])
        house = cd[int(np.argmin(np.abs(c - 270)))][60]; street = cd[int(np.argmin(np.abs(c - 90)))][60]
        assert street > 10 * house


# ─── SANS 10098-1 / -2 ──────────────────────────────────────────────────

def sans_road(cls="A4", volume=0, median=False, **kw):
    web = generic_optic("generic_medium", 12000, 90)
    secs = [{"type": "footpath", "width": 2, "cls": ""},
            {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": cls, "surface": "R3", "volume": volume}]
    if median:
        secs += [{"type": "median", "width": 3}, {"type": "carriageway", "width": 7.4, "lanes": 2, "cls": cls, "surface": "R3",
                                                   "volume": volume, "direction": "reverse"}]
    secs.append({"type": "footpath", "width": 2, "cls": ""})
    return design(secs, [{"y": 1.0, "overhang": 1.5, "facing": "right", "height": 10, "photometryId": "g"}],
                  {"g": web}, spacing=kw.pop("spacing", 35), mf=0.8, standard="SANS", **kw)


class TestSans:
    def test_group_a_requirements_follow_table_1(self):
        cw = RL.run_road_lighting(sans_road("A2", volume=1))["result"]["areas"][1]
        req = {c["key"]: c["req"] for c in cw["checks"]}
        assert req == {"Lav": 1.0, "Uo": 0.4, "Ul": 0.6, "TI": 20}           # A2, ≤300 veh/h/lane, no median
        assert "REI" not in req and cw["ES"] is not None                      # ES reported, not checked
        cw = RL.run_road_lighting(sans_road("A3", volume=1, median=True))["result"]["areas"][1]
        assert {c["key"]: c["req"] for c in cw["checks"]}["Lav"] == 0.8      # A3 with median, ≤600
        assert cw["crossSection"] == "with median"
        cw = RL.run_road_lighting(sans_road("A4", volume=2))["result"]["areas"][1]
        req = {c["key"]: c["req"] for c in cw["checks"]}
        assert req == {"Lav": 0.3, "Uo": 0.3, "Ul": 0.5, "TI": 25}

    def test_quarter_width_observer(self):
        r = RL.run_road_lighting(sans_road("A4"))["result"]["areas"][1]
        assert r["observer"]["y"] == pytest.approx(2 + 7.4 / 4)
        assert len(r["observers"]) == 2                                      # Ul per lane
        # A reverse carriageway's left-hand side is its high-y edge
        r2 = RL.run_road_lighting(sans_road("A4", median=True))["result"]["areas"][3]
        assert r2["observer"]["y"] == pytest.approx(2 + 7.4 + 3 + 7.4 - 7.4 / 4)

    def test_quarter_width_observer_luminance_matches_direct_call(self):
        req = sans_road("A4")
        out = RL.run_road_lighting(req)["result"]["areas"][1]
        des = RL._Design(req)
        S = 35.0
        xs, _ = RL._long_points(S)
        lum = RL._luminaires(des, S, -121, S + 121)
        ys = np.concatenate([2 + k * 3.7 + (np.arange(3) + 0.5) * 3.7 / 3 for k in range(2)])
        gx, gy = np.meshgrid(xs, ys, indexing="ij")
        L = RL._luminance(des, lum, gx.ravel(), gy.ravel(), RL._RTable("R3"), -60.0, 2 + 7.4 / 4, 1.0)
        assert out["Lav"] == pytest.approx(float(L.mean()), rel=1e-12)

    def test_group_b_area_includes_2m_of_footway(self):
        req = sans_road("B2")
        req["sections"][0]["width"] = 3.0                                     # only 2 m of it counts
        cw = RL.run_road_lighting(req)["result"]["areas"][1]
        assert cw["areaY"] == [1.0, 3.0 + 7.4 + 2.0]
        assert {c["key"]: c["req"] for c in cw["checks"]} == {"Eav": 3.0, "Emin": 0.6}

    def test_sans_10098_2_classes(self):
        req = sans_road("RC3")
        req["sections"][0]["cls"] = "CP4"
        a = RL.run_road_lighting(req)["result"]["areas"]
        assert {c["key"]: c["req"] for c in a[1]["checks"]} == {"Eav": 15.0, "Uo": 0.4}
        assert {c["key"]: c["req"] for c in a[0]["checks"]} == {"Eav": 5, "Emin": 1.0}

    def test_en_default_unchanged(self):
        req = sans_road("A4")
        req.pop("standard")
        req["sections"][1]["cls"] = "M4"
        cw = RL.run_road_lighting(req)["result"]["areas"][1]
        assert [c["key"] for c in cw["checks"]] == ["Lav", "Uo", "Ul", "TI", "REI"]
