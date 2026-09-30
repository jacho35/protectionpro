"""IEEE 80-2013 Annex B Examples 1 (no rods) and 2 (20 x 7.5 m rods), 70 kg,
formula-by-formula through the engine helpers. Published values are the
reference (B.1: Cs 0.74, Et70 838.2, Es70 2686.6, Rg 2.78, GPR 5304, Km 0.89,
Kii 0.57, Ki 2.272, Em 1002.1; B.2: Rg 2.75, LM 1786.4, Km 0.77, Em 747.4,
Ks 0.406, LS 1282.5, Es 548.9)."""
import math
from backend.analysis import grounding_system as g
def row(name, pub, eng, tol_pct=0.5):
    err = (eng - pub) / pub * 100
    print(f"{name:28s} pub {pub:10.4g}  engine {eng:10.4g}  err {err:+7.3f}%  {'OK' if abs(err) <= tol_pct else '<-- CHECK'}")
rho, rho_s, hs, h, d, D, n_c, L, ts, IG = 400, 2500, 0.102, 0.5, 0.01, 7.0, 11, 70.0, 0.5, 1908.0
A = L*L; Lc = 2*n_c*L
Cs = g._compute_surface_derating(rho, rho_s, hs); row("Cs", 0.74, Cs, 0.5)
Et, Es_ = g._compute_tolerable_voltages(rho_s, Cs, ts, 70)
# published limits use Cs rounded to 0.74
Et74, Es74 = g._compute_tolerable_voltages(rho_s, 0.74, ts, 70)
row("E_touch70 (Cs=0.74)", 838.2, Et74, 0.05); row("E_step70 (Cs=0.74)", 2686.6, Es74, 0.05)
print("--- Example 1: no rods")
n = g._compute_n(Lc, L, L, A); row("n", 11, n, 1e-6)
Rg = g._compute_grid_resistance(rho, A, Lc, h, d); row("Rg", 2.78, Rg, 0.3)
row("GPR", 5304, IG*Rg, 0.3)
Kii = g._compute_K_ii(n, False); row("Kii", 0.57, Kii, 0.5)
Km = g._compute_K_m(D, d, h, n, Kii); row("Km", 0.89, Km, 0.5)
Ki = g._compute_K_i(n); row("Ki", 2.272, Ki, 0.01)
LM = g._compute_L_M(Lc, 0, 0, L, L, False)
Em = g._compute_mesh_voltage(rho, IG, Km, Ki, LM); row("Em", 1002.1, Em, 0.5)
print("--- Example 2: 20 rods x 7.5 m")
LR = 150.0
Rg2 = g._compute_grid_resistance(rho, A, Lc+LR, h, d); row("Rg", 2.75, Rg2, 0.3)
LM2 = g._compute_L_M(Lc, LR, 7.5, L, L, True); row("LM", 1786.4, LM2, 0.05)
Km2 = g._compute_K_m(D, d, h, n, 1.0); row("Km", 0.77, Km2, 0.5)
Em2 = g._compute_mesh_voltage(rho, IG, Km2, Ki, LM2); row("Em", 747.4, Em2, 0.5)
Ks = g._compute_K_s(D, h, n); row("Ks", 0.406, Ks, 0.2)
LS = 0.75*Lc + 0.85*LR; row("LS", 1282.5, LS, 0.01)
row("Es", 548.9, g._compute_step_voltage(rho, IG, Ks, Ki, LS), 0.3)
print("--- IEEE 80 Table 2 Kf at Ta = 40 C  (A_kcmil = I_kA*Kf*sqrt(tc))")
KCMIL_PER_MM2 = 1.973525
for key, pub in [("copper_annealed", 7.00), ("copper_hard", 7.06), ("copper_clad_steel", 12.06), ("steel_galvanized", 28.96)]:
    a = g._compute_conductor_size(10000, 1.0, key, 40.0)
    row(f"Kf {key}", pub, a*KCMIL_PER_MM2/10, 0.5)
print("--- Decrement factor vs IEEE 80 Table 10 (60 Hz, tf = 0.5 s)")
for xr, pub in [(10, 1.026), (20, 1.052), (30, 1.078), (40, 1.103)]:
    kappa = 1.02 + 0.98*math.exp(-3/xr)
    row(f"Df X/R={xr}", pub, g._compute_decrement_factor(kappa, 0.5, 60), 0.1)
for xr, tf, pub in [(10, 0.05, 1.232), (40, 0.05, 1.638), (20, 0.1, 1.232)]:
    kappa = 1.02 + 0.98*math.exp(-3/xr)
    row(f"Df X/R={xr} tf={tf}", pub, g._compute_decrement_factor(kappa, tf, 60), 0.3)
