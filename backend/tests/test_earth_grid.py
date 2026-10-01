"""Earth grids of any shape — numerical solver, EN 50522 limits, integration.

References (none taken from the module):
  * IEEE 80-2013 Annex H.3 benchmarks — CDEGS / ETAP / WinIGS results for
    Grids 1–6 (Tables H.5–H.10), including Grid 4 (separately earthed fence)
    and Grid 6 (diagonal conductors). The solver must fall inside the spread
    of the three programs, widened by a small tolerance.
  * Closed forms: Dwight's driven rod, Sunde's buried horizontal wire.
  * EN 50522:2022 Table B.4 (U_Tp), Table B.1 (I_B), Formula (A.3).
  * The per-bus IEEE 80 path: a plain rectangular grid object must give the
    same simplified values as the same grid entered on the bus.
Evidence and derivation: EARTH_GRID_METHOD.md.
"""

import math

import numpy as np
import pytest

from backend.analysis.earth_grid import analyse, build_wires, solve, split_at_intersections
from backend.analysis.grounding_system import en50522_touch_limits, run_grounding_analysis
from backend.models.schemas import Component, ProjectData, Wire

D2_0 = 0.0105 / 2          # 2/0 AWG copper, 10.5 mm
ROD = 0.0159 / 2           # 5/8 in rod
I_H = 744.8                # Annex H grid current (A)
S2 = math.sqrt(0.5)


def _mesh(xs, ys, h=0.5, r=D2_0):
    return ([dict(a=(x, min(ys), h), b=(x, max(ys), h), radius=r) for x in xs]
            + [dict(a=(min(xs), y, h), b=(max(xs), y, h), radius=r) for y in ys])


def _rod(x, y, L, h=0.5, r=ROD, group=0):
    return dict(a=(x, y, h), b=(x, y, h + L), radius=r, group=group)


def _within(value, lo, hi, tol):
    """Inside [lo, hi] widened by tol (fraction)."""
    return lo * (1 - tol) <= value <= hi * (1 + tol)


def _touch_max(sol, x0, y0, x1, y1, sp=0.5):
    X, Y = np.meshgrid(np.arange(x0, x1 + 1e-9, sp), np.arange(y0, y1 + 1e-9, sp))
    V = sol.surface_potential(np.column_stack([X.ravel(), Y.ravel()]))
    return 1.0 - V.min()


def _vs(sol, *pts):
    return sol.surface_potential(np.array(pts, float))


# ── closed forms and invariances ─────────────────────────────────────────────

class TestClosedForms:
    def test_driven_rod_dwight(self):
        # R = ρ/(2πL)·[ln(4L/a) − 1], rod from the surface
        s = solve([_rod(0, 0, 3.0, h=0.0, r=0.008)], dict(rho1=100.0))
        ref = 100 / (2 * math.pi * 3) * (math.log(4 * 3 / 0.008) - 1)
        assert s.R_g == pytest.approx(ref, rel=0.01)

    def test_buried_wire_sunde(self):
        # R = ρ/(πL)·[ln(2L/√(2ah)) − 1]
        s = solve([dict(a=(0, 0, 0.5), b=(20, 0, 0.5), radius=0.005)], dict(rho1=100.0))
        ref = 100 / (math.pi * 20) * (math.log(40 / math.sqrt(2 * 0.005 * 0.5)) - 1)
        assert s.R_g == pytest.approx(ref, rel=0.01)

    def test_rotation_and_translation_invariance(self):
        """A 30° rotated, shifted copy of a diagonal grid gives the same R and
        the same potentials at the mapped points — no hidden axis alignment."""
        ln = [0, 14, 56, 70]
        g = _mesh(ln, ln) + [dict(a=(0, 0, 0.5), b=(70, 70, 0.5), radius=D2_0),
                             dict(a=(70, 0, 0.5), b=(0, 70, 0.5), radius=D2_0),
                             _rod(0, 0, 7.5), _rod(35, 35, 2.5)]
        c, s_ = math.cos(math.radians(30)), math.sin(math.radians(30))

        def T(p):
            return (c * p[0] - s_ * p[1] + 123.4, s_ * p[0] + c * p[1] - 56.7, p[2])
        a = solve(g, dict(rho1=100.0))
        b = solve([dict(w, a=T(w["a"]), b=T(w["b"])) for w in g], dict(rho1=100.0))
        assert b.R_g == pytest.approx(a.R_g, rel=1e-4)
        pts = [(7, 7), (35, 20), (-0.7, -0.7)]
        assert np.allclose(_vs(b, *[T((x, y, 0))[:2] for x, y in pts]), _vs(a, *pts), rtol=1e-3)

    def test_crossing_at_an_element_midpoint(self):
        """Two diagonals crossing where both would have an element mid-point
        made the system near-singular (negative leakage, V > GPR) until
        crossings became nodes."""
        ln = [0, 14, 56, 70]
        g = _mesh(ln, ln) + [dict(a=(0, 0, 0.5), b=(70, 70, 0.5), radius=D2_0),
                             dict(a=(70, 0, 0.5), b=(0, 70, 0.5), radius=D2_0)]
        s = solve(g, dict(rho1=100.0, rho2=300.0, H=6.096), max_len=1.0)
        assert s.I.min() > 0
        assert _vs(s, (35.5, 35.5))[0] < 1.0

    def test_split_joins_rod_tops_and_merges_overlaps(self):
        w = [dict(a=(0, 0, 0.5), b=(10, 0, 0.5), radius=0.005),
             dict(a=(4, 0, 0.5), b=(10, 0, 0.5), radius=0.006),       # overlaps the first
             dict(a=(3, 0, 0.5), b=(3, 0, 3.5), radius=0.008)]       # rod on its interior
        out = split_at_intersections(w)
        horiz = sorted((o["a"][0], o["b"][0]) for o in out if o["a"][2] == o["b"][2])
        assert horiz == [(0.0, 3.0), (3.0, 4.0), (4.0, 10.0)]


# ── IEEE 80-2013 Annex H benchmarks ──────────────────────────────────────────

XS14 = np.arange(0, 70.1, 14)
GRID1 = _mesh(XS14, XS14)
GRID2 = GRID1 + [_rod(x, y, 7.5) for x in XS14 for y in XS14 if x in (0, 70) or y in (0, 70)]
TWO_LAYER = dict(rho1=300.0, rho2=100.0, H=6.096)


class TestAnnexH:
    def test_grid1_uniform_no_rods(self):
        s = solve(GRID1, dict(rho1=140.0))
        gpr = s.R_g * I_H
        assert _within(s.R_g, 1.0, 1.01, 0.02)
        assert _within((1 - _vs(s, (7, 7))[0]) * gpr, 194.9, 200.9, 0.03)            # T1
        assert _within(_touch_max(s, 0, 0, 70, 70) * gpr, 202.7, 209.0, 0.03)          # T3
        assert _within((_vs(s, (0, 0))[0] - _vs(s, (-S2, -S2))[0]) * gpr, 87.2, 89.3, 0.05)   # S1

    def test_grid2_uniform_with_rods(self):
        s = solve(GRID2, dict(rho1=140.0))
        gpr = s.R_g * I_H
        assert _within(s.R_g, 0.917, 0.92, 0.02)
        assert _within((1 - _vs(s, (7, 7))[0]) * gpr, 145.4, 150.2, 0.03)
        assert _within(_touch_max(s, 0, 0, 70, 70) * gpr, 149.6, 154.0, 0.03)
        assert _within((_vs(s, (0, 0))[0] - _vs(s, (-S2, -S2))[0]) * gpr, 70.7, 79.3, 0.05)

    def test_grid3_two_layer_with_rods(self):
        s = solve(GRID2, TWO_LAYER)
        gpr = s.R_g * I_H
        assert _within(s.R_g, 0.97, 0.972, 0.02)
        assert _within((1 - _vs(s, (7, 7))[0]) * gpr, 261.0, 268.5, 0.03)
        assert _within(_touch_max(s, 0, 0, 70, 70) * gpr, 262.5, 269.7, 0.03)
        assert _within((_vs(s, (0, 0))[0] - _vs(s, (-S2, -S2))[0]) * gpr, 101.9, 117.0, 0.05)

    def test_grid4_separately_earthed_fence(self):
        """Fence 3 m outside the grid, fence conductor 1 m outside the fence,
        posts every 3.28 m — unbonded: its potential floats (zero net current)."""
        def ring(o):
            return [(-o, -o), (70 + o, -o), (70 + o, 70 + o), (-o, 70 + o)]
        fc = ring(4)
        posts = []
        for (ax, ay), (bx, by) in zip(ring(3), ring(3)[1:] + ring(3)[:1]):
            n = int(round(math.hypot(bx - ax, by - ay) / 3.28))
            posts += [_rod(ax + (bx - ax) * k / n, ay + (by - ay) * k / n, 0.762, h=0.0, r=0.0255, group=1)
                      for k in range(n)]
        fence = [dict(a=(*fc[i], 0.5), b=(*fc[(i + 1) % 4], 0.5), radius=D2_0, group=1) for i in range(4)] + posts
        s = solve(GRID2 + fence, TWO_LAYER)
        gpr = s.R_g * I_H
        vf = s.V_group[1]
        assert _within(s.R_g, 0.96, 0.97, 0.02)
        assert _within((1 - vf) * gpr, 309.2, 312.4, 0.03)                          # transfer
        assert _within((1 - _vs(s, (7, 7))[0]) * gpr, 259.7, 263.6, 0.03)          # T1
        assert _within((1 - _vs(s, (0, 0))[0]) * gpr, 127.1, 130.1, 0.03)          # T2
        assert _within((vf - _vs(s, (-4, -4))[0]) * gpr, 49.9, 51.1, 0.05)         # T4
        assert _within((_vs(s, (0, 0))[0] - _vs(s, (-S2, -S2))[0]) * gpr, 97.0, 97.4, 0.05)       # S1
        assert _within((_vs(s, (-4, -4))[0] - _vs(s, (-4 - S2, -4 - S2))[0]) * gpr, 37.4, 38.1, 0.08)  # S2

    def test_grid6_diagonal_conductors(self):
        """Non-orthogonal conductors, rods of unequal length — the case the
        IEEE 80 equations do not cover (Table H.10)."""
        grid = {
            "soil": {"rho1": 100, "two_layer": "on", "rho2": 300, "h1": 6.096},
            "conductor": {"diameter_m": 0.0105, "depth_m": 0.5},
            "layout": {"type": "rect", "length_x": 70, "width_y": 70,
                       "x_lines": [0, 14, 56, 70], "y_lines": [0, 14, 56, 70], "diagonals": "full"},
            "extra_rods": [{"x": x, "y": y, "length_m": 7.5 if x in (0, 70) and y in (0, 70) else 2.5,
                            "diameter_m": 0.0159}
                           for x, y in [(0, 0), (0, 70), (70, 0), (70, 70), (14, 14), (56, 14),
                                        (14, 56), (56, 56), (35, 35)]],
        }
        a = analyse(grid)
        gpr = a["R_g"] * I_H
        assert _within(a["R_g"], 1.42, 1.43, 0.02)
        assert _within(a["touch"] * gpr, 134.4, 140.2, 0.03)
        assert _within(a["step"] * gpr, 77.4, 99.2, 0.05)
        assert a["connected"] and a["potential_variation"] < 0.05


# ── EN 50522 limits ──────────────────────────────────────────────────────────

class TestEN50522:
    @pytest.mark.parametrize("t,u", [(0.05, 725), (0.1, 655), (0.2, 525), (0.5, 225),
                                     (1.0, 115), (2.0, 95), (5.0, 85), (10.0, 85)])
    def test_table_b4(self, t, u):
        assert en50522_touch_limits(t, 0.0)["U_Tp"] == pytest.approx(u)

    def test_beyond_10_s_note_value(self):
        assert en50522_touch_limits(30.0, 0.0)["U_Tp"] == 80.0

    def test_prospective_formula_a3(self):
        # U_vTp = U_Tp + I_B·(R_H + R_F1 + 1.5·ρ_s); t = 0.5 s: 225 + 0.2·(1000 + 750)
        lim = en50522_touch_limits(0.5, 500.0, footwear_ohm=1000.0)
        assert lim["R_F"] == pytest.approx(1750.0)
        assert lim["U_vTp"] == pytest.approx(225 + 0.2 * 1750)

    def test_permissible_step_a3(self):
        # I_B/HF with HF = 0.04 → 5 A at 0.5 s; Z_T = 775 Ω above 1.29 A
        assert en50522_touch_limits(0.5, 0.0)["U_Sp"] == pytest.approx(5.0 * 775.0)


# ── integration into the grounding study ─────────────────────────────────────

def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b, fp, tp):
    return Wire(id=wid, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


BUS_GRID_PROPS = {"soil_resistivity": 100, "crushed_rock_resistivity": 2500, "crushed_rock_depth": 0.15,
                  "grid_length": 30, "grid_width": 30, "grid_depth": 0.5, "num_conductors_x": 6,
                  "num_conductors_y": 6, "ground_rod_length": 3.0, "num_ground_rods": 20,
                  "conductor_diameter": 0.01167}
GRID_OBJ = {"id": "eg1", "name": "Main grid", "soil": {"rho1": 100},
            "surface": {"rho_s": 2500, "h_s": 0.15},
            "conductor": {"material": "copper_hard", "diameter_m": 0.01167, "depth_m": 0.5},
            "layout": {"type": "rect", "length_x": 30, "width_y": 30, "n_x": 6, "n_y": 6},
            "rods": {"rule": "perimeter_even", "count": 20, "length_m": 3.0, "diameter_m": 0.016}}


def _project(grid=None, bus_extra=None):
    comps = [_c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 15,
                                 "z0_z1_ratio": 1.0, "grounding": "solidly"}),
             _c("b1", "bus", {"name": "Legacy", "voltage_kv": 11, **BUS_GRID_PROPS}),
             _c("b2", "bus", {"name": "Grid bus", "voltage_kv": 11, "earth_grid_id": "eg1", **(bus_extra or {})})]
    wires = [_w("w1", "u", "b1", "out", "top"), _w("w2", "b1", "b2", "bottom", "top")]
    return ProjectData(projectName="eg", baseMVA=100.0, frequency=50, components=comps, wires=wires,
                       earthGrids=[grid] if grid else [])


def _bus(r, name):
    return next(b for b in r["buses"] if b["bus_name"] == name)


def _all_native(x):
    if isinstance(x, dict):
        return all(isinstance(k, str) and _all_native(v) for k, v in x.items())
    if isinstance(x, list):
        return all(_all_native(v) for v in x)
    return x is None or type(x) in (str, int, float, bool)


class TestStudyIntegration:
    def test_plain_rectangle_matches_the_per_bus_path(self):
        r = run_grounding_analysis(_project(GRID_OBJ))
        legacy, grid = _bus(r, "Legacy"), _bus(r, "Grid bus")
        assert grid["method"] == "ieee80" and grid["ieee80_applicable"]
        for k in ("grid_resistance_ohm", "mesh_voltage_v", "step_voltage_v", "tolerable_touch_v", "gpr_v"):
            assert grid[k] == legacy[k], k
        # the numerical cross-check sits below the (conservative) Sverak value
        assert grid["numerical"]["grid_resistance_ohm"] < grid["grid_resistance_ohm"]

    def test_diagonals_switch_to_numerical(self):
        g = dict(GRID_OBJ, layout=dict(GRID_OBJ["layout"], diagonals="corner_meshes"))
        b = _bus(run_grounding_analysis(_project(g)), "Grid bus")
        assert b["method"] == "numerical" and not b["ieee80_applicable"]
        assert "diagonal" in b["ieee80_not_applicable_reason"]
        assert b["touch_location_m"] is not None

    def test_en50522_route(self):
        g = dict(GRID_OBJ, limits="en50522")
        b = _bus(run_grounding_analysis(_project(g)), "Grid bus")
        en = b["en50522"]
        assert b["limit_basis"] == "en50522" and b["method"] == "numerical"
        assert en["U_Tp_v"] == 225 and en["U_vTp_v"] == pytest.approx(225 + 0.2 * 1.5 * 2500, abs=1)
        assert en["condition"] == "C4"                     # U_E far above 4·U_Tp
        assert b["decrement_factor_df"] is None            # EN has no D_f

    def test_en50522_c2_small_current(self):
        g = dict(GRID_OBJ, limits="en50522")
        b = _bus(run_grounding_analysis(_project(g, {"design_earth_fault_ka": 0.05})), "Grid bus")
        assert b["en50522"]["condition"] == "C2" and b["touch_ok"]

    def test_unbonded_fence_reported(self):
        g = dict(GRID_OBJ, fences=[{"offset_m": 2, "bonded": False, "post_spacing_m": 3,
                                    "post_depth_m": 0.8, "post_diameter_m": 0.05}])
        b = _bus(run_grounding_analysis(_project(g)), "Grid bus")
        f = b["fences"][0]
        assert not f["bonded"] and 0 < f["potential_v"] < b["gpr_v"]
        assert f["transfer_v"] == pytest.approx(b["gpr_v"] - f["potential_v"], abs=2)

    def test_disconnected_bonded_piece_is_flagged(self):
        g = dict(GRID_OBJ, extra_conductors=[{"x1": 40, "y1": 0, "x2": 50, "y2": 0}])
        b = _bus(run_grounding_analysis(_project(g)), "Grid bus")
        assert any("separate pieces" in n for n in b["notes"])

    def test_missing_grid_falls_back_with_warning(self):
        r = run_grounding_analysis(_project(None, {**BUS_GRID_PROPS}))
        assert any("not found" in w for w in r["warnings"])
        assert "method" not in _bus(r, "Grid bus")

    def test_results_are_plain_python(self):
        g = dict(GRID_OBJ, fences=[{"offset_m": 2, "bonded": False}], limits="en50522")
        r = run_grounding_analysis(_project(g))
        assert _all_native(r["grids"]) and _all_native(r["buses"])

    def test_build_wires_l_shape_corner_diagonals(self):
        geo = build_wires({"layout": {"type": "l", "length_x": 70, "width_y": 105, "notch_x": 35,
                                      "notch_y": 35, "n_x": 11, "n_y": 16, "diagonals": "corner_meshes"}})
        diags = sorted((w["a"][:2], w["b"][:2]) for w in geo["wires"] if w["kind"] == "diagonal")
        # one per convex corner, each starting at the outline corner
        assert [d[0] for d in diags] == [(0.0, 0.0), (0.0, 105.0), (35.0, 105.0), (70.0, 0.0), (70.0, 35.0)]


class TestGeometryValidation:
    """Impossible geometry is refused with a message (the editor shows it
    inline; the study reports it as a warning) instead of being drawn."""
    BASE = {"layout": {"type": "rect", "length_x": 30, "width_y": 30, "n_x": 6, "n_y": 6}}

    @pytest.mark.parametrize("grid,msg", [
        ({"layout": {"type": "rect", "length_x": -5, "width_y": 30}}, "greater than 0"),
        ({"layout": {"type": "rect", "length_x": 0, "width_y": 30}}, "greater than 0"),
        ({"layout": {"type": "l", "length_x": 30, "width_y": 30, "notch_x": 40, "notch_y": 10}}, "notch"),
        ({"layout": {"type": "rect", "length_x": 30, "width_y": 30, "x_lines": ["a", 3]}}, "must be a number"),
        ({"layout": {"type": "rect", "length_x": 30, "width_y": 30, "x_lines": [0, 45]}}, "between 0 and 30"),
        ({"layout": {"type": "none"}}, "no layout"),
        ({**BASE, "fences": [{"offset_m": -20}]}, "past the middle"),
        ({**BASE, "extra_conductors": [{"x1": 1, "y1": 1, "x2": 1, "y2": 1}]}, "zero length"),
        ({**BASE, "soil": {"rho1": 0}}, "resistivity"),
    ])
    def test_refused(self, grid, msg):
        from backend.analysis.earth_grid import preview
        with pytest.raises(ValueError, match=msg):
            preview(grid)

    def test_inward_fence_within_the_grid_is_fine(self):
        from backend.analysis.earth_grid import preview
        assert preview({**self.BASE, "fences": [{"offset_m": -5}]})["elements"] > 0

    def test_study_reports_a_bad_grid_as_a_warning(self):
        bad = dict(GRID_OBJ, layout=dict(GRID_OBJ["layout"], length_x=-5))
        r = run_grounding_analysis(_project(bad))
        assert any("could not be solved" in w for w in r["warnings"])


class TestConductorSizeAndScope:
    def test_area_gives_the_solid_equivalent_diameter(self):
        from backend.analysis.earth_grid import conductor_diameter_m
        assert conductor_diameter_m({"area_mm2": 70}) == pytest.approx(math.sqrt(4 * 70 / math.pi) / 1000)
        # a measured outside diameter wins for the geometry
        assert conductor_diameter_m({"area_mm2": 67.43, "diameter_m": 0.0105}) == 0.0105

    def test_bus_area_reproduces_the_diameter_result(self):
        """An older bus (diameter only) converted to its exact solid-equivalent
        size gives the same result — the frontend converts on load."""
        d = BUS_GRID_PROPS["conductor_diameter"]
        old = _bus(run_grounding_analysis(_project(None)), "Legacy")
        props = {k: v for k, v in BUS_GRID_PROPS.items() if k != "conductor_diameter"}
        props["conductor_area_mm2"] = math.pi / 4 * (d * 1000) ** 2
        p = _project(None)
        p.components[1].props = {"name": "Legacy", "voltage_kv": 11, **props}
        new = _bus(run_grounding_analysis(p), "Legacy")
        for k in ("grid_resistance_ohm", "mesh_voltage_v", "step_voltage_v"):
            assert new[k] == old[k], k
        assert new["conductor_ok"] is True

    def test_undersized_conductor_fails(self):
        g = dict(GRID_OBJ, conductor=dict(GRID_OBJ["conductor"], area_mm2=16))
        g["conductor"].pop("diameter_m", None)
        b = _bus(run_grounding_analysis(_project(g)), "Grid bus")
        assert b["conductor_ok"] is False and b["status"] == "fail"
        assert any("below the" in i and "mm²" in i for i in b["issues"])

    def test_scope_selected_bus_only(self):
        p = _project(GRID_OBJ)
        p.groundingBusIds = ["b2"]
        r = run_grounding_analysis(p)
        assert [b["bus_name"] for b in r["buses"]] == ["Grid bus"]
        assert r["scope"] == {"bus_ids": ["b2"]}
        assert run_grounding_analysis(_project(GRID_OBJ))["scope"] is None


class TestPreviewDepths:
    """The editor's 3-D view reads depths from the preview: conductor rows
    carry z1, z2 after the 2-D fields; rod rows carry their top depth and
    length (fence posts start at the surface)."""

    def test_conductor_and_rod_depths(self):
        from backend.analysis.earth_grid import preview
        grid = {"layout": {"type": "rect", "length_x": 20, "width_y": 20, "n_x": 3, "n_y": 3},
                "conductor": {"depth_m": 0.6},
                "rods": {"rule": "corners", "length_m": 2.4},
                "extra_conductors": [{"x1": 0, "y1": 0, "x2": -5, "y2": 0, "depth_m": 1.0}],
                "extra_rods": [{"x": -5, "y": 0, "length_m": 6}],
                "fences": [{"offset_m": 2, "post_depth_m": 0.9}]}
        plan = preview(grid)["plan"]
        grid_rows = [c for c in plan["conductors"] if c[4] == "grid"]
        assert grid_rows and all(c[6] == c[7] == 0.6 for c in grid_rows)
        assert [c[6:] for c in plan["conductors"] if c[4] == "extra"] == [[1.0, 1.0]]
        rods = [r for r in plan["rods"] if r[2] == "rod"]
        assert len(rods) == 4 and all(r[4:] == [0.6, 2.4] for r in rods)
        assert [r[4:] for r in plan["rods"] if r[2] == "extra_rod"] == [[0.6, 6.0]]
        posts = [r for r in plan["rods"] if r[2] == "post"]
        assert posts and all(r[4:] == [0.0, 0.9] for r in posts)


class TestFootwearAndDrawnArea:
    """IEEE 80 limits with footwear (SESThreshold form) and a drawn touch area
    bounding the step check."""

    def test_footwear_adds_shoe_resistance_to_the_body_circuit(self):
        from backend.analysis.grounding_system import _compute_tolerable_voltages
        k = 0.116 / math.sqrt(0.5)
        t0, s0 = _compute_tolerable_voltages(400, 0.8269, 0.5, 50)
        t1, s1 = _compute_tolerable_voltages(400, 0.8269, 0.5, 50, footwear_ohm=1000)
        assert t0 == pytest.approx((1000 + 1.5 * 0.8269 * 400) * k)          # Eq. 32 unchanged
        assert t1 - t0 == pytest.approx(500 * k)                             # feet in parallel
        assert s1 - s0 == pytest.approx(2000 * k)                            # feet in series

    def test_footwear_reproduces_a_sesthreshold_limit(self):
        # SESThreshold, 50 kg, 0.5 s, 1000 Ω body, foot 1059.5 Ω, shoe 1000 Ω, D_f 1.0618:
        # touch 313.61 V, step 790.92 V. Same body circuit with C_s chosen so 3·C_s·ρ_s = 1059.5 Ω.
        from backend.analysis.grounding_system import _compute_tolerable_voltages
        cs = 1059.5 / (3 * 400)
        t, s = _compute_tolerable_voltages(400, cs, 0.5, 50, footwear_ohm=1000)
        assert t / 1.0618 == pytest.approx(313.61, rel=1e-3)
        assert s / 1.0618 == pytest.approx(790.92, rel=1e-3)

    def test_study_reports_footwear_and_raises_the_limits(self):
        r0 = _bus(run_grounding_analysis(_project(dict(GRID_OBJ, method="numerical"))), "Grid bus")
        r1 = _bus(run_grounding_analysis(_project(dict(GRID_OBJ, method="numerical", ieee80={"footwear_ohm": 1000}))), "Grid bus")
        assert r0["footwear_ohm"] is None and r1["footwear_ohm"] == 1000
        assert r1["tolerable_touch_v"] > r0["tolerable_touch_v"] and r1["tolerable_step_v"] > r0["tolerable_step_v"]
        assert r1["mesh_voltage_v"] == r0["mesh_voltage_v"]

    def test_drawn_touch_area_also_bounds_the_step_check(self):
        # Two loops 40 m apart joined by one conductor: the hull spans the bare
        # ground between them; a drawn area round the first loop keeps touch
        # and step inside it, and the hull note is not given.
        loops = []
        for x0 in (0, 50):
            pts = [(x0, 0), (x0 + 10, 0), (x0 + 10, 10), (x0, 10)]
            loops += [dict(x1=a[0], y1=a[1], x2=b[0], y2=b[1]) for a, b in zip(pts, pts[1:] + pts[:1])]
        grid = {"soil": {"rho1": 100}, "conductor": {"depth_m": 0.5, "area_mm2": 70}, "layout": {"type": "none"},
                "extra_conductors": loops + [dict(x1=10, y1=5, x2=50, y2=5)]}
        area = [[-0.5, -0.5], [10.5, -0.5], [10.5, 10.5], [-0.5, 10.5]]
        a_hull = analyse(grid)
        a_area = analyse(dict(grid, touch_area=area))
        assert any("convex hull" in n for n in a_hull["notes"])
        assert not any("convex hull" in n for n in a_area["notes"])
        tx, ty = a_area["touch_at"]
        sx1, sy1, _, _ = a_area["step_at"]
        assert -0.5 <= tx <= 10.5 and -0.5 <= ty <= 10.5
        assert -0.5 <= sx1 <= 10.5 and -0.5 <= sy1 <= 10.5
        assert a_area["touch"] < a_hull["touch"]
