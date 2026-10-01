"""Earth-grid solver validation — every number quoted in EARTH_GRID_METHOD.md.

Run in the backend image:
  docker run --rm -v "$PWD":/work -w /work -e PYTHONPATH=/work protectionpro-backend \
      python testing/earth-grid-validation/validate.py [--convergence]

References (geometry and results from IEEE Std 80-2013 incl. Cor 1-2015):
  Annex H.3 Grids 1–6: CDEGS / ETAP / WinIGS (Tables H.5–H.10)
  Annex B Examples 1, 2, 4 and Exhibits 1, 2: EPRI TR-100622
Closed forms: Dwight (driven rod), Sunde (buried horizontal wire).
Where a figure leaves geometry open, the assumption is printed with the case.
"""

import math
import sys
import time

import numpy as np

from backend.analysis.earth_grid import analyse, solve

D2_0 = 0.0105 / 2        # 2/0 AWG Cu (Annex H)
ROD = 0.0159 / 2         # 5/8 in rod
I_H = 744.8              # Annex H grid current
S2 = math.sqrt(0.5)


def mesh(xs, ys, h=0.5, r=D2_0):
    return ([dict(a=(x, min(ys), h), b=(x, max(ys), h), radius=r) for x in xs]
            + [dict(a=(min(xs), y, h), b=(max(xs), y, h), radius=r) for y in ys])


def rod(x, y, L, h=0.5, r=ROD, g=0):
    return dict(a=(x, y, h), b=(x, y, h + L), radius=r, group=g)


def vs(sol, *pts):
    return sol.surface_potential(np.array(pts, float))


def walk(poly, step):
    pts = []
    for i in range(len(poly)):
        a = np.array(poly[i], float)
        b = np.array(poly[(i + 1) % len(poly)], float)
        n = int(round(np.linalg.norm(b - a) / step))
        pts += [tuple(a + (b - a) * k / n) for k in range(n)]
    return pts


def rect(o, L=70.0):
    return [(-o, -o), (L + o, -o), (L + o, L + o), (-o, L + o)]


ROWS = []


def row(case, qty, ours, ref, note=""):
    if isinstance(ref, tuple):
        lo, hi = ref
        if ours < lo:
            dev = (ours / lo - 1) * 100
        elif ours > hi:
            dev = (ours / hi - 1) * 100
        else:
            dev = 0.0
        refs = f"{lo:g}–{hi:g}" if lo != hi else f"{lo:g}"
    else:
        dev = (ours / ref - 1) * 100
        refs = f"{ref:g}"
    ROWS.append((case, qty, ours, refs, dev, note))


def closed_forms():
    s = solve([rod(0, 0, 3.0, h=0.0, r=0.008)], dict(rho1=100.0))
    row("Rod 3 m, a 8 mm, 100 Ω·m", "R (Ω)", s.R_g, 100 / (2 * math.pi * 3) * (math.log(12 / 0.008) - 1), "Dwight")
    s = solve([dict(a=(0, 0, 0.5), b=(20, 0, 0.5), radius=0.005)], dict(rho1=100.0))
    row("Wire 20 m, a 5 mm, h 0.5 m", "R (Ω)", s.R_g,
        100 / (math.pi * 20) * (math.log(40 / math.sqrt(2 * 0.005 * 0.5)) - 1), "Sunde")


XS = np.arange(0, 70.1, 14)
G1 = mesh(XS, XS)
G2 = G1 + [rod(x, y, 7.5) for x in XS for y in XS if x in (0, 70) or y in (0, 70)]
TL = dict(rho1=300.0, rho2=100.0, H=6.096)


def touch_raster(sol, x0, y0, x1, y1, sp=0.5):
    X, Y = np.meshgrid(np.arange(x0, x1 + 1e-9, sp), np.arange(y0, y1 + 1e-9, sp))
    return 1.0 - sol.surface_potential(np.column_stack([X.ravel(), Y.ravel()])).min()


def annex_h_1_to_3():
    for name, g, soil, ref in (
            ("H Grid 1 (uniform 140, no rods)", G1, dict(rho1=140.0),
             dict(R=(1.0, 1.01), T1=(194.9, 200.9), T3=(202.7, 209.0), S1=(87.2, 89.3))),
            ("H Grid 2 (uniform 140, 20 rods)", G2, dict(rho1=140.0),
             dict(R=(0.917, 0.92), T1=(145.4, 150.2), T3=(149.6, 154.0), S1=(70.7, 79.3))),
            ("H Grid 3 (300/100, H 6.1 m, 20 rods)", G2, TL,
             dict(R=(0.97, 0.972), T1=(261.0, 268.5), T3=(262.5, 269.7), S1=(101.9, 117.0)))):
        s = solve(g, soil)
        gpr = s.R_g * I_H
        row(name, "R_g (Ω)", s.R_g, ref["R"])
        row(name, "T1 corner-mesh centre (V)", (1 - vs(s, (7, 7))[0]) * gpr, ref["T1"])
        row(name, "T3 worst touch (V)", touch_raster(s, 0, 0, 70, 70) * gpr, ref["T3"])
        row(name, "S1 corner, 1 m diagonal (V)", (vs(s, (0, 0))[0] - vs(s, (-S2, -S2))[0]) * gpr, ref["S1"])


def annex_h_4():
    fc = rect(4)
    posts = [rod(x, y, 0.762, h=0.0, r=0.0255, g=1) for x, y in walk(rect(3), 3.28)]
    fence = [dict(a=(*fc[i], 0.5), b=(*fc[(i + 1) % 4], 0.5), radius=D2_0, group=1) for i in range(4)] + posts
    s = solve(G2 + fence, TL)
    gpr = s.R_g * I_H
    vf = s.V_group[1]
    alone = solve([dict(w, group=0) for w in fence], TL)
    n = "H Grid 4 (Grid 3 + unbonded fence)"
    note = "fence conductor depth 0.5 m assumed"
    row(n, "R_g (Ω)", s.R_g, (0.96, 0.97))
    row(n, "R_fence alone (Ω)", alone.R_g, (1.6, 1.62), note)
    row(n, "Transfer grid→fence (V)", (1 - vf) * gpr, (309.2, 312.4))
    row(n, "T1 (V)", (1 - vs(s, (7, 7))[0]) * gpr, (259.7, 263.6))
    row(n, "T2 grid corner (V)", (1 - vs(s, (0, 0))[0]) * gpr, (127.1, 130.1))
    row(n, "T3 worst touch (V)", touch_raster(s, 0, 0, 70, 70) * gpr, (261.1, 264.9))
    row(n, "T4 fence-conductor corner (V)", (vf - vs(s, (-4, -4))[0]) * gpr, (49.9, 51.1))
    row(n, "S1 (V)", (vs(s, (0, 0))[0] - vs(s, (-S2, -S2))[0]) * gpr, (97.0, 97.4))
    row(n, "S2 fence corner (V)", (vs(s, (-4, -4))[0] - vs(s, (-4 - S2, -4 - S2))[0]) * gpr, (37.4, 38.1))


def annex_h_5_6():
    g5 = {"soil": {"rho1": 300, "two_layer": "on", "rho2": 100, "h1": 6.096},
          "conductor": {"diameter_m": 0.0105, "depth_m": 0.5},
          "layout": {"type": "l", "length_x": 70, "width_y": 105, "notch_x": 35, "notch_y": 35, "n_x": 11, "n_y": 16},
          "rods": {"rule": "perimeter_alternate", "length_m": 7.5, "diameter_m": 0.0159},
          "fences": [{"offset_m": -1, "bonded": True, "post_spacing_m": 3.28, "post_depth_m": 0.762,
                      "post_diameter_m": 0.051}]}
    a = analyse(g5)
    gpr = a["R_g"] * I_H
    n = "H Grid 5 (L-shape, bonded fence, 300/100)"
    row(n, "R_g (Ω)", a["R_g"], (0.81, 0.81))
    row(n, "GPR (V)", gpr, (602.7, 606.4))
    row(n, "Worst touch (V)", a["touch"] * gpr, (131.6, 138.1), "rods every other perimeter crossing (25)")
    row(n, "Worst step (V)", a["step"] * gpr, (83.0, 90.7))
    g6 = {"soil": {"rho1": 100, "two_layer": "on", "rho2": 300, "h1": 6.096},
          "conductor": {"diameter_m": 0.0105, "depth_m": 0.5},
          "layout": {"type": "rect", "length_x": 70, "width_y": 70, "x_lines": [0, 14, 56, 70],
                     "y_lines": [0, 14, 56, 70], "diagonals": "full"},
          "extra_rods": [{"x": x, "y": y, "length_m": 7.5 if x in (0, 70) and y in (0, 70) else 2.5,
                          "diameter_m": 0.0159}
                         for x, y in [(0, 0), (0, 70), (70, 0), (70, 70), (14, 14), (56, 14), (14, 56),
                                      (56, 56), (35, 35)]]}
    a = analyse(g6)
    gpr = a["R_g"] * I_H
    n = "H Grid 6 (diagonals, 100/300, rods 7.5/2.5 m)"
    row(n, "R_g (Ω)", a["R_g"], (1.42, 1.43))
    row(n, "GPR (V)", gpr, (1054.4, 1068.2))
    row(n, "Worst touch (V)", a["touch"] * gpr, (134.4, 140.2))
    row(n, "Worst step (V)", a["step"] * gpr, (77.4, 99.2))


def annex_b():
    xb = np.arange(0, 70.1, 7)
    s = solve(mesh(xb, xb, r=0.005), dict(rho1=400.0))
    gpr = s.R_g * 1908
    row("B Ex. 1 (70×70, 11×11, 400 Ω·m)", "R_g (Ω)", s.R_g, 2.67, "EPRI TR-100622")
    row("B Ex. 1 (70×70, 11×11, 400 Ω·m)", "Worst touch (V)", touch_raster(s, 0, 0, 70, 70) * gpr, 984.3)
    per = walk(rect(0), 7)[::2]
    s = solve(mesh(xb, xb, r=0.005) + [rod(x, y, 7.5) for x, y in per], dict(rho1=400.0))
    gpr = s.R_g * 1908
    n = "B Ex. 2 (+20 rods 7.5 m)"
    row(n, "R_g (Ω)", s.R_g, 2.52, "rods every other perimeter crossing assumed")
    row(n, "Worst touch (V)", touch_raster(s, 0, 0, 70, 70) * gpr, 756.2)
    row(n, "Step, corner diagonal (V)", (vs(s, (0, 0))[0] - vs(s, (-S2, -S2))[0]) * gpr, 459.1)
    g4 = {"soil": {"rho1": 400}, "conductor": {"diameter_m": 0.01, "depth_m": 0.5},
          "layout": {"type": "l", "length_x": 70, "width_y": 105, "notch_x": 35, "notch_y": 35, "n_x": 11, "n_y": 16},
          "rods": {"rule": "perimeter_alternate", "length_m": 7.5, "diameter_m": 0.0159}}
    a = analyse(g4)
    gpr = a["R_g"] * 1908
    n = "B Ex. 4 (L-shape, 24 rods)"
    row(n, "R_g (Ω)", a["R_g"], 2.34, "25 rods (every other crossing)")
    row(n, "Worst touch (V)", a["touch"] * gpr, 742.9)
    row(n, "Worst step (V)", a["step"] * gpr, 441.8)
    L = 60.96
    x1 = np.linspace(0, L, 5)
    g = mesh(x1, x1, r=0.005) + [rod(x, y, 9.144, r=0.00635) for x in (0, L / 2, L) for y in (0, L / 2, L)]
    s = solve(g, dict(rho1=300.0, rho2=100.0, H=4.572))
    n = "B Exhibit 1 (61×61, 300/100 H 4.57 m, 9 rods)"
    row(n, "R_g (Ω)", s.R_g, 1.353, "see §6.3")
    row(n, "E_m (% of GPR)", 100 * (1 - vs(s, (7.62, 7.62))[0]), 49.66)
    row(n, "E_s (% of GPR)", 100 * (vs(s, (0, 0))[0] - vs(s, (-S2, -S2))[0]), 18.33)
    s0 = solve(mesh(x1, x1, r=0.005), dict(rho1=300.0, rho2=100.0, H=4.572), max_len=0.5)
    row(n, "R_g without rods (Ω)", s0.R_g, 1.4102, "vs the review's independent solver")
    ls = [0, 3.048, 12.192, 24.384, 45.72, 67.056, 79.248, 88.392, 91.44]
    rp = [0, 12.192, 45.72, 79.248, 91.44]
    s = solve(mesh(ls, ls, r=0.005) + [rod(x, y, 9.2) for x in rp for y in rp], dict(rho1=300.0))
    n = "B Exhibit 2 (unequal spacing, 25 rods)"
    row(n, "R_g (Ω)", s.R_g, 1.416, "rod positions read off Fig. B.7")
    row(n, "Corner-mesh touch (% of GPR)", 100 * (1 - vs(s, (1.524, 1.524))[0]), 9.29)
    row(n, "Worst touch (% of GPR)", 100 * touch_raster(s, 0, 0, 91.44, 91.44), 17.08)


def convergence():
    print("\nElement-length convergence (Annex H Grid 3, two-layer):")
    print(f"{'max length':>10} {'elements':>9} {'R_g':>8} {'T1 (V)':>8} {'S1 (V)':>8} {'time':>6}")
    for ml in (4.0, 2.0, 1.0, 0.5):
        t = time.time()
        s = solve(G2, TL, max_len=ml)
        gpr = s.R_g * I_H
        t1 = (1 - vs(s, (7, 7))[0]) * gpr
        s1 = (vs(s, (0, 0))[0] - vs(s, (-S2, -S2))[0]) * gpr
        print(f"{ml:>10} {len(s.I):>9} {s.R_g:>8.4f} {t1:>8.1f} {s1:>8.1f} {time.time() - t:>5.1f}s")


if __name__ == "__main__":
    t0 = time.time()
    closed_forms()
    annex_h_1_to_3()
    annex_h_4()
    annex_h_5_6()
    annex_b()
    w = max(len(r[0]) for r in ROWS)
    print(f"{'case':<{w}}  {'quantity':<30} {'ours':>9}  {'reference':>13}  {'outside by':>10}  note")
    for case, qty, ours, refs, dev, note in ROWS:
        dv = "in range" if dev == 0 else f"{dev:+.1f} %"
        print(f"{case:<{w}}  {qty:<30} {ours:>9.4g}  {refs:>13}  {dv:>10}  {note}")
    if "--convergence" in sys.argv:
        convergence()
    print(f"\n{time.time() - t0:.0f} s")
