# Earth grid with diagonals — IEEE 80-2013 Annex H.3.6 (Grid 6)

**Engine:** `earth_grid.py` / `earth_grid_study.py` (numerical, method of moments).
**Reference:** IEEE Std 80-2013 Annex H, Table H.10 — CDEGS, ETAP and WinIGS
results for the same grid. The Clause 16 simplified equations are "not intended
for this type of grid", so the standard gives computer results only.

## Grid
- 70 × 70 m perimeter, cross-conductors at 14 m and 56 m both ways, and both
  corner-to-corner diagonals; 2/0 Cu (10.5 mm) at 0.5 m.
- Rods, 5/8 in: 7.5 m at the four corners; 2.5 m at the four inner diagonal
  crossings and the centre.
- Soil: ρ₁ = 100 Ω·m to 6.096 m over ρ₂ = 300 Ω·m.
- Grid current 744.8 A. The bus's *Design Earth-Fault Current* = 0.7448 kA with
  S_f = 1, and the source X/R is low enough that κ = 1.02, so D_f = 1 exactly.

## Result

| Quantity | ProtectionPro | CDEGS | ETAP | WinIGS |
|---|---|---|---|---|
| R_g (Ω) | 1.4265 | 1.42 | 1.43 | 1.43 |
| GPR (V) | 1062 | 1054.4 | 1068.2 | 1063.1 |
| Worst touch, inside the perimeter (V) | 136 | 134.4 | 140.2 | 136.6 |
| Worst step, from 1 m outside inward (V) | 84 | 96.4 | 99.2 | 77.4 (S2 84.9) |

**PASS.** Every quantity lies inside the programs' range. Evaluation follows
Annex H.3.6: touch at every point 0.5 m apart inside the perimeter conductor,
step at every point 0.5 m apart from 1 m outside the perimeter inward, in any
direction. Full validation set: `EARTH_GRID_METHOD.md` §8 and
`testing/earth-grid-validation/validate.py`.
