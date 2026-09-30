"""Unequal mesh spacing: the engine feeds K_m/K_s the MEAN of Dx and Dy.
Compare the IEEE formula's error vs the numerical reference for square meshes
(baseline error of the formula) and for rectangular meshes (mean vs max D)."""
import sys; sys.path.insert(0, __import__("os").path.dirname(__file__))
from v3_grid_bem import solve
from backend.analysis import grounding_system as g
rho, IG, h, d = 100.0, 1000.0, 0.5, 0.01
def ieee_em(Lx, Ly, nx, ny, D):
    A = Lx*Ly; Lc = nx*Ly + ny*Lx; n = g._compute_n(Lc, Lx, Ly, A)
    Km = g._compute_K_m(D, d, h, n, g._compute_K_ii(n, False))
    return g._compute_mesh_voltage(rho, IG, Km, g._compute_K_i(n), Lc)
for (Lx, Ly, nx, ny) in [(60, 60, 6, 6), (60, 60, 11, 11), (60, 30, 6, 6), (60, 30, 6, 11), (80, 20, 5, 11)]:
    Dx, Dy = Lx/(nx-1), Ly/(ny-1)
    R, emf = solve(Lx, Ly, nx, ny, h, d, rho, sub=2)
    em_num = emf*R*IG
    e_mean = ieee_em(Lx, Ly, nx, ny, (Dx+Dy)/2); e_max = ieee_em(Lx, Ly, nx, ny, max(Dx, Dy))
    print(f"{Lx}x{Ly} {nx}x{ny} Dx={Dx:.1f} Dy={Dy:.1f}: Em num {em_num:6.0f} | IEEE D=mean {e_mean:6.0f} ({(e_mean/em_num-1)*100:+.0f}%)  D=max {e_max:6.0f} ({(e_max/em_num-1)*100:+.0f}%)")
