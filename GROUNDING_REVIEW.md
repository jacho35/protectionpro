# Grounding Review — `grounding_system.py` (IEEE 80 substation earthing)

*Review date 2026-09-30. Method: `ENGINE_REVIEW_METHODOLOGY.md`. References:
IEEE 80-2013 Annex B Examples 1 and 2 (published values), Table 1 (material
constants), Table 2 (K_f), Eq. 79 (decrement factor); an independent
**method-of-moments solve** of the grid in uniform and two-layer earth
(`v3_grid_bem.py`) with the two-layer image Green's functions checked against
their boundary conditions (`v4_green_wenner.py`); a hand zero-sequence current
division. The IEC side (IEC 61936-1 / EN 50522 permissible touch voltage,
IEC 60479-1) was compared from the reviewer's reading, since no licensed copy
is in `IEC Standards/`. No reference was taken from the module or its tests.*

## 1. Scope

`run_grounding_analysis` runs the fault study, then for every AC bus takes its
earth-fault current and the bus's grid and soil data and evaluates the IEEE 80
simplified method: C_s, tolerable touch/step, Sverak R_g, GPR, K_m / K_s / K_i
/ n / K_ii, L_M / L_S, E_m / E_s, the decrement factor D_f and the Onderdonk
conductor size. It can also apply an optional two-layer soil model and fit a
Wenner test. The review covered:
- every IEEE 80 formula against the Annex B worked examples;
- the material constants and K_f against Tables 1 and 2;
- which current becomes the grid current I_G, end to end through the fault
  engine;
- the two-layer soil model and the Wenner forward model;
- the conductor-sizing temperature basis;
- the PDF report and results modal text.

Scripts `testing/grounding-review/v1_ieee80_examples.py` …
`v6_engine_two_layer.py` are the evidence. Run them in the backend image with
`PYTHONPATH=/work`.

## 2. What holds up

| Checked against | Result |
|---|---|
| IEEE 80 Annex B Ex. 1 (70 × 70 m, 11 × 11, no rods, ρ 400 Ω·m, I_G 1908 A): C_s, E_touch70, E_step70, R_g, GPR, n, K_ii, K_m, K_i, E_m | all within the published rounding (worst 0.39 % on C_s = 0.7429 vs "0.74"; E_m 1001.6 vs 1002.1 V) |
| Ex. 2 (+ 20 × 7.5 m rods): R_g, L_M, K_m, E_m, K_s, L_S, E_s | ≤ 0.22 % (E_m 749.1 vs 747.4 V, from the published rounded K_m = 0.77) |
| Uniform-soil R_g and E_m vs the numerical reference (Ex. 1 grid) | Sverak 2.78 Ω vs 2.64 Ω numerical; E_m 1002 vs 962 V. The IEEE formulas are 4–5 % conservative, as expected for fitted equations |
| Unequal mesh spacing (engine averages D_x, D_y) vs numerical E_m, 5 rectangular grids | IEEE E_m with the mean D is 8–16 % above numerical — conservative. The max D would be 24–33 % high. No change |
| K_f (IEEE 80 Table 2, T_a 40 °C): annealed Cu 7.00, hard-drawn 7.06, Cu-clad steel 30 % 12.06 | 0.12 %, 0.07 %, 0.10 % |
| D_f (Eq. 79) vs Table 10, 60 Hz, t_f = 0.5 s, X/R 10 / 20; 0.05 s, X/R 10; 0.1 s, X/R 20 | ≤ 0.03 % (κ → X/R round trip exact) |
| Wenner two-layer ρ_a(a) (Sunde series) vs ρ_a from the surface point-source Green's function, 3 soils × 4 spacings | exact (0.0000 %) |
| Two-layer Green's functions, all 4 source/field layer combinations | V and (1/ρ)dV/dz continuous at the interface, dV/dz = 0 at the surface, reciprocal (residuals ≤ 7 × 10⁻⁵, finite-difference noise) |
| Surface derating with h_s = 0 | C_s·ρ_s = ρ exactly, so the limit reverts to native soil |
| Rectangular-grid n = n_a·n_b | as IEEE 80 Eq. 84–87 (already pinned) |

## 3. Findings

### G1 — two-layer soil: mesh voltage kept ρ1, and R_g came from an equivalent hemisphere — `run_grounding_analysis`, `_compute_two_layer_equivalent_resistivity` (removed)

**Mechanism.** With two-layer soil on, the engine put an equivalent
resistivity ρ_eq = ρ1·F into Sverak's R_g only. F came from a point source on
a hemisphere of radius √(A/π) with the images of the layer boundary. E_m and
E_s kept ρ1. Neither step is physical:
- a resistive lower layer forces the current out sideways near the surface,
  so the surface gradients inside the grid, and E_m, rise with it;
- a hemisphere the size of the grid, fed at one point, is no model of the
  wire grid when the layer is thin compared with the grid.

IEEE 80 §13.4 uses the simplified equations for uniform soil only. It sends
layered soil to computer analysis.

**Evidence.** Numerical reference (`v3_grid_bem.py`) on the Ex. 1 grid, ρ1 = 400:

| ρ2, h1 | R ratio: true | R ratio: engine F | E_m ratio: true | E_m ratio: engine |
|---|---|---|---|---|
| 4000, 2 m | 6.26 | 9.17 | **2.37** | 1.00 |
| 4000, 10 m | 3.64 | 5.50 | 1.52 | 1.00 |
| 40, 2 m | **0.222** | 0.100 | 0.67 | 1.00 |
| 40, 5 m | **0.294** | 0.101 | 0.69 | 1.00 |

Over rock the engine's E_m was up to 2.4× low. It reported safe grids that
are not safe, which is **non-conservative**. Over a water table R_g and GPR
were up to 2.9× low, which is also non-conservative (GPR and transferred
potential). Over rock R_g was 45 % high.

**Fix [G1].** The same grid (conductors, and rods on the perimeter as IEEE 80
K_ii = 1 assumes) is solved by the method of moments twice: once in the
two-layer soil and once in uniform ρ1. The exact image Green's functions are
used, rods crossing the boundary are split there, and the kernel is a
thin-wire segment integral. The uniform IEEE 80 R_g, E_m and E_s are then
multiplied by the three ratios (`_two_layer_grid_ratios`). Uniform soil never
enters the solver, so the IEEE 80 hand calculation there is unchanged.
Engine vs reference: R within 1 % in all 8 cases. E_m is within 1 % for a
conductive lower layer and 1.5–6.3 % high over rock, because the engine uses 2
segments per mesh side against the reference's 4. That error is on the
conservative side. A 25 × 25 grid over a 100:1 layer ratio solves in 6.6 s;
typical grids take under 1 s. The results modal shows the three ratios.

*Pre-existing* (5ad28e8, 2026-07-31). The regression tests had pinned the
hemisphere's limits (`test_two_layer_thin_top_layer_limit_is_rho2` asserted
ρ_eq = ρ2 with the grid in ρ1). They are **re-baselined** to the new model's
physical limits: uniform gives 1, a thick top layer gives 1, and a grid wholly
in ρ2 gives R × ρ2/ρ1.

### G2 — the whole bus earth-fault current was driven into the soil, including current that returns to a local neutral — `run_grounding_analysis`

**Mechanism.** I_G was set to D_f × 3I₀ of the bus's own SLG fault, with
S_f = 1, on every bus. Take an LV bus fed by its own Dyn11 transformer. The
earth-fault current there returns through the protective conductor to the
transformer neutral, which is bonded to the same grid. None of it enters the
soil (IEEE 80 §15.1, Fig. 19). Only the share fed from *remote* neutrals
returns through earth.

**Evidence** (`v2_pipeline.py`). Utility 11 kV 500 MVA → MV bus → Dyn11 2 MVA
→ LV bus. The LV bus was designed for I_G = 51.6 kA, GPR = 86.6 kV, FAIL, when
its true I_G is 0. Every project with an LV board therefore showed spurious
failures. This is conservative, but it hides the real design case: the MV
bus, which is fed from the remote utility.

**Fix [G2].**
- The fault engine's zero-sequence walker now labels each Z0 path. A path is
  *local* when its source is an earthed transformer winding (delta or
  magnetising return), generator or inverter reached through switchgear only.
  Utilities are never local, and TT LV neutrals are not treated as local.
- The bus result carries `ik1_remote_fraction`, the remote share of the Z0
  admittance. For an 11 kV bus with a YNd11 earthing transformer beside the
  utility, the engine gives 0.846 against 0.845 by hand.
- I_G = D_f × S_f × remote share × 3I₀. **S_f** is a new bus prop
  (`current_split_factor`, IEEE 80 §15.9, default 1.0) for shield wires,
  cable sheaths and other electrodes.
- The grid **conductor** is still sized for the full D_f × 3I₀, since it is
  the return path, now with D_f taken at t_c.
- A note says what share returned locally and that the supply-side fault may
  be the design case.

*Pre-existing* since the engine was added (94daa8b).

### G3 — conductor sized to the fusing point whatever the joints — `_compute_conductor_size`

**Mechanism.** T_m was always the material's fusing temperature (Cu 1083 °C).
IEEE 80 §11.3.1.1 limits the temperature to the weakest part of the path:
250 °C for bolted joints, 350 °C for pressure-type connectors and 450 °C for
brazed joints (reviewer's reading). Only exothermic welds withstand the
conductor's own fusing point.

**Evidence.** Hard-drawn Cu K_f is 7.06 at 1084 °C and 11.78 at 250 °C
(IEEE 80 Table 2). A bolted grid needs 67 % more copper area than the engine
gave, which is **non-conservative** for mechanical joints.

**Fix [G3].** New bus prop `grid_joint_type` (exothermic, the default so
results are unchanged; brazed, pressure or bolted). T_m is the lower of the
fusing point and the joint limit, and T_m is reported. The engine gives
K_f 11.77 for bolted copper against 11.78 in Table 2. *Pre-existing.*

### G4 — no earth-fault path: the 3-phase current stood in silently — `run_grounding_analysis`

When Ik1 = 0 (an unearthed or isolated neutral), the engine used Ik3 as 3I₀
and did not say so. On an isolated MV system the earth-fault current is
capacitive, tens of amps (backlog: zero-sequence line capacitance), so the
result is grossly conservative and misleading. **Fix [G4]:** the fallback is
kept, since a cross-country double earth fault is of the Ik3 order, and a note
now names it and asks for the real earth-fault current.

### G5 — transcription — `CONDUCTOR_MATERIALS`, `pdf_reports._calc_grounding`, module docstring

- Galvanised (zinc-coated) steel had TCAP 3.846, which is the copper-clad
  value. IEEE 80 Table 1 gives 3.93. K_f was 29.28 against Table 2's 28.96
  (1.1 % over-size, conservative). Fixed; K_f is now 28.96.
- The PDF printed the 50 kg constant (0.116) while the default is 70 kg, gave
  the wrong equation numbers, and showed a grid-resistance formula that is
  neither Sverak's nor what the engine computes. The module docstring called
  the Laurent–Niemann form "Schwarz". Both now print the formulas as
  evaluated. The PDF also lists 3I₀, remote share, S_f and I_G.
- Informational notes were printed with `multi_cell`, which the PDF's
  Unicode sanitiser does not cover, so "Ω" crashed the report. Notes are now
  sanitised explicitly.

## 4. Lesser notes

- **L1 — validity range.** The simplified equations are fitted for n ≤ 25,
  0.25 ≤ h ≤ 2.5 m, D ≥ 2.5 m and d < 0.25 h (IEEE 80 §16.5). The engine now
  adds a note when a grid is outside that range. Results are unchanged.
- **L2 — every bus is analysed.** Bus defaults are written on creation, so
  the analysis can't tell entered data from defaults. A note now flags a bus
  whose soil and grid data are all the shipped defaults.
- **L3 — D_f basis.** X/R comes from the 3-phase κ, not the earth-fault loop
  (X1+X2+X0)/(R1+R2+R0), and D_f uses t_s for the shock (IEEE 80 uses t_f).
  The effect is ≤ 2 % at t ≥ 0.5 s. Left as is and documented.
- **L4 — rod placement.** K_ii = 1 and L_M Eq. 91 assume rods on the
  perimeter or at the corners. The numerical two-layer solve places them the
  same way. Interior rods are not modelled.
- **L5 — step voltage in two-layer soil.** The E_s ratio comes from the same
  numerical solve, taken 1 m out from the corner and edge mid-points. There
  is no independent reference for the location, only the shared kernel,
  which was verified in G1.
- **L6 — IEC 61936-1 / EN 50522 would give a different verdict** in the
  1–3 s range. EN 50522 permissible touch voltage U_Tp (body only, reviewer's
  reading) against IEEE 80 70 kg with no surface layer, E = 157/√t:

  | t_F (s) | 0.1 | 0.2 | 0.5 | 1 | 2 | 5 | 10 |
  |---|---|---|---|---|---|---|---|
  | EN 50522 U_Tp (V) | 654 | 537 | 220 | 117 | 96 | 86 | 85 |
  | IEEE 80, 70 kg (V) | 496 | 351 | 222 | 157 | 111 | 70 | 50 |

  The two agree at 0.5 s, the default. IEEE is 34 % *less* strict at 1 s and
  16 % less strict at 2 s. It is stricter below 0.5 s and above about 3 s. A
  backup-cleared 1 s fault with a 140 V touch voltage passes IEEE 80 70 kg
  but fails EN 50522. Not implemented: the U_Tp curve and the additional
  foot/footwear resistances need a licensed EN 50522 / IEC 60479-1 copy.
  Added to BACKLOG.

## 5. Behaviour changes for saved projects

Grounding results are saved and are not recomputed on load. Re-run the study
on:
- any bus with **two-layer soil on** (G1). E_m and E_s rise over a resistive
  lower layer, and R_g and GPR rise over a conductive one;
- any bus whose earth-fault current is fed by a transformer or generator
  neutral connected straight to it, typically every LV board at its
  transformer (G2). I_G, GPR, E_m and E_s fall, to zero where the return is
  wholly local;
- grids of galvanised steel (G5). The minimum size falls by 1.1 %.

Uniform-soil buses fed from remote sources are unchanged. So is the IEEE 80
verification template.

## 6. Tests

`backend/tests/test_grounding_review_fixes.py`: G1 (numerical ratios against
the reference, and the pipeline scaling), G2 (local return, utility-fed bus,
YNd split, S_f), G3 (Table 2 K_f at 250 °C, low-melting material), G4, G5
(zinc-coated steel K_f), Ex. 1 unchanged, and the L1 note. In
`test_regression.py::TestGrounding` the five two-layer tests are re-baselined
(G1) and the rest pass unchanged.
