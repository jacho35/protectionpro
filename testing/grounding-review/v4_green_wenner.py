"""(a) Two-layer point-source Green's functions for all four source/field layer
combinations: check V continuity and (1/rho) dV/dz continuity at z = h, and
dV/dz = 0 at the surface, numerically.  (b) Wenner apparent resistivity:
engine's Sunde series vs rho_a = 2*pi*a*2[V(a) - V(2a)]/I from the surface
point-source Green's function (independent derivation)."""
import math, numpy as np
from backend.analysis import grounding_system as g
def G(r, z, z0, rho1, rho2, h, N=4000):
    K = (rho2-rho1)/(rho2+rho1); R = lambda dz: 1/np.sqrt(r*r+dz*dz)
    if z0 < h and z < h:
        return rho1/(4*math.pi)*sum(K**abs(n)*(R(z-z0+2*n*h)+R(z+z0+2*n*h)) for n in range(-N, N+1))
    if z0 < h <= z:
        return rho1*(1+K)/(4*math.pi)*sum(K**n*(R(z-z0+2*n*h)+R(z+z0+2*n*h)) for n in range(N))
    if z < h <= z0:
        return rho1*(1+K)/(4*math.pi)*sum(K**n*(R(z0-z+2*n*h)+R(z+z0+2*n*h)) for n in range(N))
    return rho2/(4*math.pi)*(R(z-z0) - K*R(z+z0-2*h) + (1-K*K)*sum(K**n*R(z+z0+2*n*h) for n in range(N)))
rho1, rho2, h, r, e = 100.0, 700.0, 2.0, 1.3, 1e-5
for z0 in (0.7, 3.1):
    Va, Vb = G(r, h-e, z0, rho1, rho2, h), G(r, h+e, z0, rho1, rho2, h)
    Ja = (G(r, h-e, z0, rho1, rho2, h)-G(r, h-3*e, z0, rho1, rho2, h))/(2*e)/rho1
    Jb = (G(r, h+3*e, z0, rho1, rho2, h)-G(r, h+e, z0, rho1, rho2, h))/(2*e)/rho2
    Js = (G(r, 2e-4, z0, rho1, rho2, h)-G(r, 0.0, z0, rho1, rho2, h))/2e-4
    print(f"source z0={z0}: V jump {abs(Va-Vb)/abs(Va):.1e}  current-density jump {abs(Ja-Jb)/abs(Ja):.1e}  surface dV/dz rel {abs(Js)/abs(Va):.1e}")
print("reciprocity G(1->2) vs G(2->1):", G(r, 3.1, 0.7, rho1, rho2, h), G(r, 0.7, 3.1, rho1, rho2, h))
print("\nWenner:  a    engine    independent   err%")
for (r1, r2, h1) in [(100, 1000, 2.0), (500, 50, 3.0), (200, 200, 1.0)]:
    for a in (0.5, 2, 8, 32):
        V = lambda x: G(x, 0.0, 0.0, r1, r2, h1)   # unit current at the surface
        ind = 2*math.pi*a*2*(V(a)-V(2*a))
        eng = g.wenner_apparent_resistivity(r1, r2, h1, a)
        print(f"  {r1}/{r2}/{h1}  a={a:4}: {eng:9.3f} {ind:11.3f}  {(eng-ind)/ind*100:+.4f}")
