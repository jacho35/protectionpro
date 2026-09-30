"""Engine two-layer ratios vs the v3 reference (independent script, sub=4).
Reference (R2L/Ru, Em2L/Emu) from v3 for the IEEE 80 Example 1 grid."""
import time
from backend.analysis import grounding_system as g
ref = {(4000, 2): (6.262, 2.368), (4000, 5): (4.769, 1.905), (4000, 10): (3.642, 1.521), (4000, 25): (2.410, 1.146),
       (40, 2): (0.222, 0.671), (40, 5): (0.294, 0.690), (40, 10): (0.391, 0.761), (40, 25): (0.585, 0.903)}
for (rho2, h1), (rR, rEm) in ref.items():
    t = time.time()
    R, m, s_ = g._two_layer_grid_ratios(70, 70, 11, 11, 0.5, 0.01, 0, 0.0, 400.0, float(rho2), float(h1))
    print(f"rho2={rho2:5} h1={h1:3}: R {R:6.3f} vs {rR:6.3f} ({(R/rR-1)*100:+5.1f}%)  Em {m:6.3f} vs {rEm:6.3f} ({(m/rEm-1)*100:+5.1f}%)  Es {s_:6.3f}  [{time.time()-t:.1f}s]")
# limits
print("uniform:", g._two_layer_grid_ratios(30, 30, 6, 6, 0.5, 0.01, 20, 3.0, 100.0, 100.0, 3.0))
print("thick top (h1=5000):", g._two_layer_grid_ratios(30, 30, 6, 6, 0.5, 0.01, 20, 3.0, 100.0, 1000.0, 5000.0))
print("grid wholly in rho2 (h1=0.05, R -> rho2/rho1 = 10):", g._two_layer_grid_ratios(30, 30, 6, 6, 0.5, 0.01, 0, 0.0, 100.0, 1000.0, 0.05))
print("rods crossing the interface (h1=2, 3 m rods):", g._two_layer_grid_ratios(30, 30, 6, 6, 0.5, 0.01, 20, 3.0, 100.0, 1000.0, 2.0))
t=time.time(); print("extreme K (rho2/rho1=100, h1=1):", g._two_layer_grid_ratios(70, 70, 11, 11, 0.5, 0.01, 20, 7.5, 100.0, 10000.0, 1.0), f"{time.time()-t:.1f}s")
t=time.time(); print("big grid 25x25:", g._two_layer_grid_ratios(200, 200, 25, 25, 0.5, 0.01, 40, 3.0, 100.0, 1000.0, 3.0), f"{time.time()-t:.1f}s")
