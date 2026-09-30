"""Independent numerical reference: equipotential grid in uniform or two-layer
earth by the method of moments (constant leakage per segment, point matching
on the conductor surface, exact two-layer image Green's function for source and
field in the upper layer:
  G = rho1/(4 pi) * sum_{n=-inf..inf} K^|n| [1/|r - r'(z0-2nh)| + 1/|r - r'(-z0-2nh)|]
which satisfies dV/dz = 0 at the surface and the rho1/rho2 interface
conditions (checked for K = +-1 analytically).  Gives R_g, and E_m as
GPR - surface potential, maximised over the corner mesh."""
import math, numpy as np, sys
sys.path.insert(0, "/work")
from backend.analysis import grounding_system as g

def seg_integral(P, A, B, a):
    # int_A^B ds / sqrt(|P-s|^2 + a^2)   (thin-wire reduced kernel), vectorised
    AB = B - A; L = np.linalg.norm(AB, axis=-1); u = AB / L[..., None]
    t1 = np.einsum('...k,...k->...', A - P, u); t2 = t1 + L
    perp2 = np.maximum(np.einsum('...k,...k->...', A - P, A - P) - t1**2, 0) + a*a
    return np.arcsinh(t2/np.sqrt(perp2)) - np.arcsinh(t1/np.sqrt(perp2)), L

def build(Lx, Ly, nx, ny, h, sub, rods=0, Lr=0.0):
    segs = []
    xs = np.linspace(0, Lx, nx); ys = np.linspace(0, Ly, ny)
    for x in xs:  # conductors along y
        yy = np.linspace(0, Ly, (ny-1)*sub+1)
        segs += [((x, yy[i], h), (x, yy[i+1], h)) for i in range(len(yy)-1)]
    for y in ys:
        xx = np.linspace(0, Lx, (nx-1)*sub+1)
        segs += [((xx[i], y, h), (xx[i+1], y, h)) for i in range(len(xx)-1)]
    if rods:  # perimeter rods, evenly spaced
        per = 2*(Lx+Ly); pts = []
        for k in range(rods):
            s = per*k/rods
            if s < Lx: pts.append((s, 0))
            elif s < Lx+Ly: pts.append((Lx, s-Lx))
            elif s < 2*Lx+Ly: pts.append((2*Lx+Ly-s, Ly))
            else: pts.append((0, per-s))
        for (x, y) in pts:
            zz = np.linspace(h, h+Lr, 5)
            segs += [((x, y, zz[i]), (x, y, zz[i+1])) for i in range(4)]
    S = np.array(segs, float)
    return S[:, 0], S[:, 1]

def images(K, h1, nmax):
    out = []   # (coef, sign, shift): z' = sign*z - 2 n h1
    for n in range(-nmax, nmax+1):
        c = K**abs(n) if K != 0 else (1.0 if n == 0 else 0.0)
        if abs(c) < 1e-7: continue
        out.append((c, 1, -2*n*h1)); out.append((c, -1, -2*n*h1))
    return out

def potential_matrix(P, A, B, a, rho1, K, h1):
    nmax = 0 if K == 0 else int(math.log(1e-7)/math.log(abs(K))) + 1
    M = np.zeros((P.shape[0], A.shape[0]))
    for c, sgn, sh in images(K, h1, nmax):
        Ai = A.copy(); Bi = B.copy()
        Ai[:, 2] = sgn*A[:, 2] + sh; Bi[:, 2] = sgn*B[:, 2] + sh
        I, L = seg_integral(P[:, None, :], Ai[None], Bi[None], a)
        M += c * I / L
    return rho1/(4*math.pi) * M

def solve(Lx, Ly, nx, ny, h, d, rho1, rho2=None, h1=1e9, sub=4, rods=0, Lr=0.0):
    rho2 = rho1 if rho2 is None else rho2
    K = (rho2-rho1)/(rho2+rho1)
    A, B = build(Lx, Ly, nx, ny, h, sub, rods, Lr)
    mid = (A+B)/2
    G = potential_matrix(mid, A, B, d/2, rho1, K, h1)
    I = np.linalg.solve(G, np.ones(len(A)))
    R = 1/I.sum()
    # surface potential over the corner mesh, per unit GPR
    Dx, Dy = Lx/(nx-1), Ly/(ny-1)
    gx, gy = np.meshgrid(np.linspace(0, Dx, 9), np.linspace(0, Dy, 9))
    Ps = np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], 1)
    Vs = potential_matrix(Ps, A, B, 0.0, rho1, K, h1) @ I
    return R, 1 - Vs.min()        # R (ohm), E_m / GPR (fraction)

if __name__ == "__main__":
    L, n, h, d = 70.0, 11, 0.5, 0.01
    A = L*L; Lc = 2*n*L
    print("== uniform 400 ohm.m, IEEE 80 Example 1 grid (no rods)")
    for sub in (2, 4):
        R, emf = solve(L, L, n, n, h, d, 400.0, sub=sub)
        print(f" sub={sub}: R_num {R:.4f}  (Sverak {g._compute_grid_resistance(400, A, Lc, h):.4f})  Em_num {emf*R*1908:.0f} V (IEEE formula 1002 V)")
    R_u, emf_u = solve(L, L, n, n, h, d, 400.0, sub=4)
    print("== two-layer, rho1 = 400")
    print(" rho2   h1 |  R2L/Ru num  engine F | Em2L/Emu num  (engine 1.0)")
    for rho2 in (4000.0, 40.0):
        for h1 in (2.0, 5.0, 10.0, 25.0):
            R2, emf2 = solve(L, L, n, n, h, d, 400.0, rho2, h1, sub=4)
            rho_eq, K, F = g._compute_two_layer_equivalent_resistivity(400.0, rho2, h1, h, A)
            em_ratio = (emf2*R2)/(emf_u*R_u)
            print(f" {rho2:5.0f} {h1:4.0f} |  {R2/R_u:8.3f}   {F:8.3f} | {em_ratio:8.3f}")
