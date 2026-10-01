# Earth grids of any shape — technical basis and modelling guide

*Engines: `backend/analysis/earth_grid.py` (geometry, solver, evaluation),
`backend/analysis/earth_grid_study.py` (limits and per-bus results), EN 50522
limits in `backend/analysis/grounding_system.py`. Tests:
`backend/tests/test_earth_grid.py`. Every validation number in §8 is printed by
`testing/earth-grid-validation/validate.py`. Written 2026-09-30.*

References used (licensed copies, not in the repository):
- **IEEE Std 80-2013** incl. Cor 1-2015, *Guide for Safety in AC Substation Grounding*
  — §3 / §8.1 definitions, §7.3 foot model, §8.4 tolerable voltages, §15 grid current,
  §16.4–16.8 design procedure, simplified equations and computer analysis, Annex B
  (examples, EPRI TR-100622 results), Annex D (simplified equations), Annex H
  (benchmarks against CDEGS, ETAP, WinIGS).
- **EN 50522:2022**, *Earthing of power installations exceeding 1 kV a.c.* — Table 1
  (relevant currents), §5.4 (touch voltage, conditions C1–C4, Figure 9), Annex A/B
  (U_Tp, U_vTp, step voltage), Annex J (resistance to earth, effective length).
- **IEC 61936-1:2010/AMD1:2014** — the replaced Annex D earthing-design flow chart
  (steps a–l) that EN 50522 §5.4.3 cites.

Contents: [1 What it is for](#1-what-it-is-for) ·
[2 Which method, which limits](#2-which-method-which-limits) ·
[3 Physical model](#3-physical-model) · [4 Numerical method](#4-numerical-method) ·
[5 Touch, step and transferred voltage](#5-touch-step-and-transferred-voltage) ·
[6 Limits and design currents](#6-limits-and-design-currents) ·
[7 Built-in checks](#7-built-in-checks) · [8 Validation](#8-validation) ·
[9 Limitations](#9-limitations) · [10 Modelling guide](#10-modelling-guide) ·
[11 Data model](#11-data-model)

---

## 1. What it is for

The IEEE 80 simplified equations (§16.5, Annex D) describe an equally spaced
square, rectangular, T, triangular or L-shaped mesh in uniform soil, with rods
at the perimeter or throughout. They were fitted to computer solutions over a
stated range (§16.7): grid area 6.25–10 000 m², 1–40 meshes along a side, mesh
2.5–22.5 m, uniform soil, uniform spacing. IEEE 80 §16.8 lists when computer
analysis is justified instead: parameters beyond those limits, two-layer soil,
uneven conductor or rod spacing "that cannot be analyzed using the approximate
methods of 16.5", flexibility in finding local danger points, and buried metal
not connected to the grid.

An **earth grid object** describes the grid once for the project — shape, rods,
fences and any conductors added by hand — and any number of buses use it. Its
calculation handles everything in the §16.8 list:
- diagonal (non-orthogonal) conductors, e.g. across corner meshes;
- uneven spacing, e.g. conductors closer together towards the perimeter;
- L-shaped outlines;
- rods at any position, of any length;
- fences, bonded to the grid or separately earthed;
- two-layer soil;
- the worst touch and step voltage located anywhere, not only at the corner mesh.

A bus without an earth grid keeps the per-bus IEEE 80 calculation, unchanged.

## 2. Which method, which limits

| Grid | IEEE 80 limits (default) | EN 50522 limits |
|---|---|---|
| Plain rectangle: equal spacing, uniform soil, rods by rule or none, no diagonals, extras or fences | **IEEE 80 simplified** equations are the headline (standard-anchored, checkable by hand). The numerical result is shown beside them. | Numerical |
| Anything else | **Numerical** (method of moments). The reason the equations don't apply is stated. | Numerical |

The `method` setting can force *numerical* on a plain rectangle. *IEEE 80* on a
grid the equations don't cover falls back to numerical with a note. EN 50522 has
no simplified touch-voltage equations, so it always uses the numerical result.

**Compare like with like.** The simplified equations are conservative on a
plain rectangle. On the 30 × 30 m, 6 × 6, 20-rod default grid, Sverak gives
R_g = 1.68 Ω against 1.46 Ω numerically, and E_m is 8 % above the numerical
worst touch. So a design change — adding diagonals, for instance — should be
judged numerical against numerical. The results window shows the numerical
value for every grid for this reason.

## 3. Physical model

### 3.1 The field problem

At 50/60 Hz the current field in soil is quasi-static. The electromagnetic skin
depth in soil, δ = 503·√(ρ/f), is about 710 m at 100 Ω·m and 50 Hz, far larger
than a substation. So the soil potential V obeys the steady conduction
equation ∇·(σ∇V) = 0 with:
- **ground surface** insulating: ∂V/∂z = 0 at z = 0;
- **layer interface** (two-layer soil, depth H): V and σ·∂V/∂z continuous;
- **remote earth**: V → ρI/(2πr) → 0.

### 3.2 The metal

Grid conductors, rods, fence posts and buried fence wires are thin straight
wires with a radius. Metal that is bonded together is at a single potential.
Two kinds of group exist:
- **group 0 — the grid**: everything bonded to it, including bonded fences.
  Its potential is the GPR;
- **unbonded groups**: each separately earthed fence, or conductor marked not
  bonded. Its potential floats: it takes no net current from the fault, and the
  solve returns its potential.

This "every bonded conductor at the same potential" assumption is IEEE 80's.
Once it holds, topology does not enter the equations: a diagonal is just more
metal at the GPR. The assumption is checked for every grid (§7.2), because a
long, thin conductor in low-resistivity soil is not at one potential along its
length. EN 50522 Figures J.4/J.5 show this for a single 95 mm² Cu wire at 0.6 m:
its earth impedance stops falling beyond an effective length of about 0.7 km at
50 Ω·m, 1.0 km at 100 Ω·m and 3.2 km at 1000 Ω·m.

### 3.3 Soil

**Uniform ρ₁**, or **two horizontal layers**: ρ₁ from the surface to depth H over
ρ₂ below. The reflection factor is K = (ρ₂ − ρ₁)/(ρ₂ + ρ₁). The potential of a
point source is the classical image series — Sunde; used by Dawalibi & Mukhedkar
and in IEEE 80 §16.5's reference programs. Source at depth z₀, field at depth z,
horizontal distance r, R(ζ) = √(r² + ζ²):

| Field / source layer | Potential per ampere |
|---|---|
| 1 ← 1 | ρ₁/4π · Σₙ K^\|n\| [1/R(z−z₀+2nH) + 1/R(z+z₀+2nH)], n ∈ ℤ |
| 2 ← 1 | ρ₁(1+K)/4π · Σ_{n≥0} Kⁿ [1/R(z−z₀+2nH) + 1/R(z+z₀+2nH)] |
| 1 ← 2 | ρ₁(1+K)/4π · Σ_{n≥0} Kⁿ [1/R(z₀−z+2nH) + 1/R(z+z₀+2nH)] |
| 2 ← 2 | ρ₂/4π · [1/R(z−z₀) − K/R(z+z₀−2H) + (1−K²) Σ_{n≥0} Kⁿ/R(z+z₀+2nH)] |

These satisfy the three boundary conditions. The grounding review
(GROUNDING_REVIEW.md, `v4_green_wenner.py`) checked them numerically: V and
(1/ρ)∂V/∂z are continuous at the interface and ∂V/∂z = 0 at the surface
(residual ≤ 7 × 10⁻⁵). Uniform soil is K = 0: the source plus its surface image.
Terms with weight below 10⁻⁶ are dropped. Images farther than five grid
diagonals are lumped as a constant.

**Surface layer (crushed rock).** It is not part of the field model: it is thin,
highly resistive and carries almost none of the grid current. It enters only the
body circuit — IEEE 80 C_s (§7.4), or EN 50522 R_F2 = 1.5·ρ_S. That is how both
standards treat it.

## 4. Numerical method

### 4.1 Geometry → wires

The layout generator produces the wires. For a rectangle or L it builds the
conductors, the diagonals and the rods by rule. Conductors and rods added by
hand are appended, and each fence is built from its offset of the outline: posts
along the fence line, plus a buried fence conductor if one is set.

Before discretising, every horizontal wire is **split where it meets or crosses
another** at the same depth, and where a rod top or another wire's end lands on
its interior. Collinear duplicates are merged, keeping the larger radius.

This matters numerically, not only for tidiness. When two conductors cross
inside elements that both have their mid-point at the crossing, two rows of the
system become nearly identical. In the Annex H Grid 6 diagonals at 1 m elements
this produced negative leakage currents and a surface potential above GPR. With
crossings as nodes it cannot happen (`test_crossing_at_an_element_midpoint`).

### 4.2 Elements

Each wire is cut into ⌈L / ℓ⌉ equal elements (ℓ = element length, default
1 m). The first and last element of each wire are halved again, because leakage
density changes fastest at conductor ends and junctions. A wire crossing the
layer interface is split there, so no element straddles two layers. Each element
carries a uniform leakage current.

### 4.3 Thin-wire kernel and collocation

The potential at point P from element j carrying current I_j uniformly along
its length L_j uses the reduced thin-wire kernel. The source current sits on the
element's axis, the field point on the other element's axis, and the element's
radius a_j keeps the self-term finite:

  V(P) = I_j / L_j · ∫_{A_j}^{B_j} ds / √(|P − s|² + a_j²)
       = I_j / L_j · [asinh(t₂/ρ⊥) − asinh(t₁/ρ⊥)],

where t₁ and t₂ are the element ends measured along its direction from the foot
of the perpendicular from P, and ρ⊥² = (perpendicular distance)² + a_j². Each
image term applies the same integral to the mirrored element.

Enforcing the group potential at every element mid-point gives

  [G] · I = V,  G_ij = potential at mid-point i per ampere in element j.

### 4.4 Floating groups

With unbonded groups the unknowns are the element currents plus one potential
per floating group, V_k:

```
[ G   −E ] [ I ]   [ b ]      b_i = 1 for grid (group-0) elements, 0 otherwise
[ Eᵀ   0 ] [ V ] = [ 0 ]      E_ik = 1 if element i belongs to floating group k
```

The last rows state that each floating group takes no net current.

### 4.5 Resistance and scaling

The solve is per volt of GPR: R_g = 1 / Σ I (group 0). Every voltage scales
linearly with the grid current, so one solve serves every bus that uses the
grid. Each bus multiplies the per-unit results by its own GPR = I_G × R_g.

### 4.6 Evaluating the kernel quickly

The matrix entries and the surface potentials use the same kernel. It is
evaluated in two parts:
- **Point-source part, tabulated.** For each pair of depths (field point depth,
  element depth) the sum over all soil images of c/√(r² + Δz²) is a function of
  the horizontal distance r alone. It is tabulated once — 2.5 mm nodes to 2 m,
  25 mm to 20 m, then geometric — and each (point, element) pair costs one
  interpolation however many images the two-layer series has. In uniform soil
  (two images) the point kernel is evaluated directly.
- **Exact part for near pairs.** Within 4 element lengths of an element image
  (found with a k-d tree), the point value is replaced by the exact line
  integral of §4.3. Beyond 4 lengths a point source is within about 0.5 %
  (worst case: along a rod's axis).

**Accuracy.** Checked against a reference that evaluates each image's exact
integral whenever it is close. On a 100 × 100 m grid over resistive rock
(100/1000 Ω·m, H = 3 m) the results agree to 0.004 % on R_g and 0.02 % on touch
voltage. This matters: over a large grid on rock the surface sits at about 97 %
of GPR, so touch (1 − V) magnifies an error in V roughly thirtyfold.

**Speed.** A 200 × 200 m, 21 × 21 grid (3460 elements) takes about 2 s to solve.
The whole study takes 14 s in uniform soil and 35 s in two-layer soil.

**Foot radius.** A surface point is never taken closer than **0.08 m** — the
IEEE 80 §7.3 foot radius — to the axis of an electrode that reaches the
surface, such as a fence post. Without this, a raster point that falls exactly
on a post axis reports the post's own potential as a step. In Annex H Grid 5
that gave 123 V against the programs' 83–91 V; with it, 87.7 V. Buried
conductors are unaffected.

### 4.7 Element length

Convergence on Annex H Grid 3 (two-layer, 20 rods crossing the interface),
printed by `validate.py --convergence`:

| max element (m) | elements | R_g (Ω) | T1 (V) | S1 (V) | solve |
|---|---|---|---|---|---|
| 4.0 | 460 | 0.9687 | 262.8 | 106.3 | 0.1 s |
| 2.0 | 660 | 0.9692 | 262.9 | 104.1 | 0.2 s |
| **1.0** (default) | 1200 | 0.9668 | 261.5 | 102.0 | 0.5 s |
| 0.5 | 2200 | 0.9663 | 261.3 | 101.2 | 0.9 s |

Going from 1 m to 0.5 m changes R_g by 0.05 %, touch by 0.1 % and step by 1 %.
A grid that would need more than 4000 elements has its element length raised
automatically; the note gives the longest element used.
The limit is 4000 elements; a finer element length can be set per grid.

## 5. Touch, step and transferred voltage

### 5.1 Definitions (IEEE 80 §3 / §8.1)

- **Touch voltage**: GPR minus the surface potential where a person stands with
  a hand on a grounded structure.
- **Mesh voltage**: the maximum touch voltage within a mesh.
- **Step voltage**: the surface-potential difference over 1 m with the feet,
  touching no grounded object.
- **Transferred voltage**: a touch voltage carried into or out of the site by a
  conductor earthed elsewhere.

The simplified equations evaluate E_m at the centre of the corner mesh and E_s
from the outer corner to 1 m diagonally outside (Table 12). IEEE 80 §16.1 notes
that even on an equally spaced square grid the true worst mesh voltage lies
slightly off the corner-mesh centre, towards the corner. It also notes that the
corner mesh stops being the worst case when the grid is unsymmetrical, has rods
on or near the perimeter, or has very non-uniform spacing. That is why computer
analysis may evaluate "any point" (§16.1). **Annex B Exhibit 2
shows why a search is needed.** On an unequally spaced grid, the worst touch
voltage (17.08 % of GPR) is over the largest interior mesh, and the corner mesh
gives only 9.29 %.

### 5.2 Where the voltages are evaluated

These follow the evaluation rules of IEEE 80 Annex H.3, the ones the commercial
programs were benchmarked on:

| Quantity | Area | Reference potential |
|---|---|---|
| Touch, grid | inside the grid outline (H.3.6 "inside perimeter conductor"); extended to 1 m outside a **bonded** fence (H.3.5) | GPR |
| Touch, unbonded fence | within 1 m of the fence line, either side | the fence's own potential |
| Step | from 1 m outside the grid perimeter inward (H.3.5/H.3.6 S1), and 1 m outside each fence line | — |
| Transfer, grid → unbonded fence | — | GPR − V_fence |

A custom touch area can be given as a polygon for the case in IEEE 80 §17.1:
a fence enclosing more than the grid, with service areas people can reach.

### 5.3 Search

- **Touch.** Surface potential on a 0.5 m raster over the touch area (Annex H
  spacing; coarsened only when more than about 60 000 points would be needed).
  The twelve lowest points are refined on a 0.1 m sub-raster. The worst touch
  voltage and its location are reported.
- **Step.** Axis-aligned 1 m differences are read off the raster to screen the
  400 steepest points, plus the raster edge. At each candidate the exact 1 m step
  is computed in 16 directions, so the worst step and its direction are found
  anywhere, not only at the corner diagonal.

### 5.4 Fences

- **Bonded fence** (IEEE 80 §17.3): posts, and optionally a buried fence
  conductor, belong to group 0. The touch area extends to 1 m outside the fence,
  because people touch the fence from outside.
- **Unbonded (separately earthed) fence:** its own floating group. Reported for
  it:
  - its potential;
  - the worst touch voltage within 1 m reach, referred to the fence;
  - the grid-to-fence transfer voltage.
  
  **Convention difference with Annex H:** Annex H's T4 is taken at the corner of
  the fence's perimeter conductor, 1 m outside the fence line and so 1.41 m from
  the fence corner. That point lies beyond 1 m reach and is not used here.
  §8 checks the T4 point value separately (49.0 V against 49.9–51.1 V).

## 6. Limits and design currents

### 6.1 IEEE 80 basis

- **Tolerable voltages** (§8.4, Eq. 29/30 step and 32/33 touch, 50 or 70 kg):
  E_touch = (1000 + 1.5·C_s·ρ_s)·k/√t_s and
  E_step = (1000 + 6·C_s·ρ_s)·k/√t_s, with k = 0.116 or 0.157. The surface-layer
  derating factor C_s is Eq. 27. With no surface layer, ρ_s = ρ₁ and C_s = 1.
- **Grid current** (§15, Eqs. 3–4): I_G = D_f × S_f × I_f.
  - I_f is the fault study's I″k1 at the bus, reduced to the share fed from
    remote sources. The share that returns through a transformer or generator
    neutral at the bus stays in the metal (§15.1).
  - S_f is the bus's split factor (§15.9, Annex C).
  - D_f is the decrement factor for the bus's X/R and t_s (§15.10).
- **Worst fault location** (§15.8): each bus on the grid is evaluated with its
  own current. The design case is the worst bus. A fault on the supply side of
  a local transformer is often it, which is why the LV bus of a Dyn transformer
  shows a GPR near zero.

### 6.2 EN 50522 basis

- **Current to earth** (Table 1):
  - low-impedance neutral earthing: I_E = r·I″k1 without neutral earthing in the
    substation, r·(I″k1 − I_N) with it;
  - here, r is the bus's split factor (reduction factor, Annex I) and the remote
    share removes I_N;
  - there is **no decrement factor**;
  - **isolated or resonant-earthed systems** need I_E = r·I_C, r·I_RES or
    r·√(I_L² + I_RES²). The fault study does not produce these, so enter them as
    the bus's *Design earth-fault current*.
- **U_E = I_E × R_g.**
- **U_Tp(t_f)**: Table B.4, 725 V at 0.05 s … 85 V at 5–10 s, interpolated in
  log t as Figure 8 is drawn. Below 0.05 s the 0.05 s value is kept, which is
  conservative against Figure 8. Beyond 10 s it is 80 V (NOTE to Figure 8). The
  fault duration t_f is the bus's *Fault Duration (shock, t_s)*.
- **U_vTp** (Formula A.3): U_vTp = U_Tp + I_B(t_f)/HF · (R_H + R_F).
  - HF = 1 (left hand to feet);
  - I_B from Table B.1 (log–log interpolation);
  - R_F = R_F1 (footwear, default 0 Ω; EN notes 1000 Ω for old wet shoes) +
    R_F2 = 1.5 m⁻¹·ρ_S;
  - ρ_S = the surface-layer resistivity, or ρ₁ with none. R_F2 = 1.5·ρ is the
    same foot model as IEEE 80 §7.3 Eq. 15.
- **Procedure** (§5.4.2, Figure 9):

  | Condition | Test | Outcome |
  |---|---|---|
  | C2 | U_E ≤ 2·U_Tp | touch criterion met without calculating U_T |
  | C3 | U_E ≤ 4·U_Tp **and** the specified measures M (Annex E) are applied | met (a per-grid yes/no) |
  | C4 | otherwise | the calculated prospective touch voltage (the numerical worst touch, open circuit) is compared with U_vTp; unbonded-fence touch voltages likewise |

  C1 (part of a global earthing system) is an engineering judgement made outside
  the program.
- **Step voltage** is checked only when U_E > 20·U_Tp (§5.4.2 NOTE 1, A.3).
  - Permissible U_Sp = (I_B/0.04) · Z_T(I_B/0.04) · 1, with HF = 0.04 foot to
    foot and BF = 1.
  - Z_T is from Table B.3; 775 Ω above 1.29 A.
  - No additional resistance is credited, which is conservative.
- **Always noted:** transferred potentials (§6, Table 2 for LV systems) are
  checked separately. Conductor size uses IEEE 80's Onderdonk equation (§11.3);
  EN 50522 Annex D is not implemented.

### 6.3 Conductor size and sizing (both bases)

The grid conductor is specified by its **cross-section in mm²** (e.g. 70 mm²
bare copper), as conductors are bought. The geometry uses the solid-equivalent
diameter d = √(4A/π). A stranded conductor of the same area is about 10–15 %
larger outside, so the solid value is slightly conservative: a thinner
conductor gives a marginally higher resistance and touch voltage. A measured
outside diameter can be entered instead, for the geometry only — the Annex H
template does this for its 2/0 conductor (67.4 mm², 10.5 mm). Rod and post
diameters are entered in mm. A project saved with a diameter converts, on
opening, to its solid-equivalent size (to 0.01 mm²), which returns the same
diameter.

Minimum size: Onderdonk (IEEE 80 §11.3) on the full D_f × I″k1 over t_c. The
grid conductor carries the whole fault current back to a local neutral, not
only I_G. T_m is the lower of the material's fusing point and the joint limit
(§11.3.1.1). **A conductor smaller than the minimum fails the study**, and the
issue names the next standard size.

## 7. Built-in checks

### 7.1 Connectivity

A union-find over the elements' end points confirms that every bonded
non-fence conductor forms one metallic network. A piece that touches nothing
would otherwise be silently treated as bonded. If the network splits, the note
gives the number of pieces. Fences are excluded, because their fabric joins the
posts.

### 7.2 Conductor impedance (the equal-potential assumption)

The leakage currents from the solve are made to flow along the conductors.
Each conductor has a series impedance with earth return (Carson, simplified):

  z = R_ac + ω·μ₀/8 + j·ω·μ₀/(2π)·ln(D_e/a),  D_e = 658.87·√(ρ₁/f)

The fault current is injected in turn at the four extreme nodes of the grid.
The largest potential drop relative to the injection node is reported as a
percentage of GPR. **Above 5 % the assumption is questionable** and a note says
so.

This is a first-order check: it takes the equipotential leakage distribution
and ignores mutual coupling between conductors. Mutual coupling between
parallel same-direction currents raises the effective inductance, so large
drops should be taken seriously. The Annex H grids give 0.8–1.5 %.

### 7.3 IEEE 80 applicability

The reason the simplified equations do not apply is stated, for example "the
grid has diagonal conductors (IEEE 80 Annex H.3.6)". For a plain rectangle the
§16.7 tested range is checked, together with the §16.5.2 depth range for K_s.

## 8. Validation

`validate.py` output. "In range" means inside the spread of the three
commercial programs (CDEGS, ETAP, WinIGS) in IEEE 80 Annex H. Otherwise the
deviation is to the nearer end.

### 8.1 Closed forms and invariances

| Case | Ours | Reference | Deviation |
|---|---|---|---|
| Rod 3 m, a = 8 mm, 100 Ω·m (Dwight) | 33.53 Ω | 33.49 Ω | +0.1 % |
| Buried wire 20 m, a = 5 mm, h = 0.5 m (Sunde) | 8.486 Ω | 8.496 Ω | −0.1 % |
| Grid 6 rotated 30° and shifted | R to 3 × 10⁻⁶, potentials to 10⁻⁵ | identical | — |
| Exhibit 1 grid without rods vs the review's independent solver | 1.411 Ω | 1.410 Ω | +0.03 % |

### 8.2 IEEE 80 Annex H (CDEGS / ETAP / WinIGS)

| Case | Quantity | Ours | Programs | |
|---|---|---|---|---|
| Grid 1 (uniform 140 Ω·m, no rods) | R_g | 1.000 Ω | 1.0–1.01 | in range |
| | T1 corner-mesh centre | 195.4 V | 194.9–200.9 | in range |
| | T3 worst touch | 203.1 V | 202.7–209.0 | in range |
| | S1 | 91.1 V | 87.2–89.3 | +2.0 % |
| Grid 2 (+20 rods) | R_g | 0.917 Ω | 0.917–0.92 | in range |
| | T1 / T3 | 145.5 / 149.7 V | 145.4–150.2 / 149.6–154.0 | in range |
| | S1 | 70.7 V | 70.7–79.3 | in range |
| Grid 3 (two-layer 300/100 Ω·m, H 6.1 m) | R_g | 0.967 Ω | 0.97–0.972 | −0.3 % |
| | T1 / T3 | 261.5 / 262.9 V | 261.0–268.5 / 262.5–269.7 | in range |
| | S1 | 102.0 V | 101.9–117.0 | in range |
| Grid 4 (+ separately earthed fence) | R_g | 0.965 Ω | 0.96–0.97 | in range |
| | grid → fence transfer | 310.2 V | 309.2–312.4 | in range |
| | T1 / T2 / T3 | 260.5 / 129.5 / 261.7 V | within each range | in range |
| | T4 (fence-conductor corner) | 49.0 V | 49.9–51.1 | −1.9 % |
| | S1 / S2 | 95.5 / 39.8 V | 97.0–97.4 / 37.4–38.1 | −1.5 % / +4.3 % |
| | R_fence alone | 1.69 Ω | 1.6–1.62 | +4.1 % ¹ |
| Grid 5 (L-shape, bonded fence, two-layer) | R_g / GPR | 0.807 Ω / 601 V | 0.81 / 602.7–606.4 | −0.3 % / −0.2 % |
| | worst touch | 128.5 V | 131.6–138.1 | −2.3 % ² |
| | worst step | 87.8 V | 83.0–90.7 | in range |
| **Grid 6 (diagonals, rods 7.5/2.5 m, two-layer)** | R_g / GPR | 1.426 Ω / 1062 V | 1.42–1.43 / 1054–1068 | in range |
| | worst touch | 136.3 V | 134.4–140.2 | in range |
| | worst step | 84.4 V | 77.4–99.2 | in range |

¹ The fence-conductor depth is not given; 0.5 m is assumed. ² The rod count
"every other perimeter crossing" gives 25 rods on this outline; the three
programs themselves spread 5 % here.

### 8.3 IEEE 80 Annex B (EPRI TR-100622, an older program)

| Case | Quantity | Ours | EPRI | Deviation |
|---|---|---|---|---|
| Ex. 1 (70 × 70, 11 × 11, 400 Ω·m) | R_g | 2.645 Ω | 2.67 | −0.9 % |
| | worst touch | 965.0 V | 984.3 | −2.0 % |
| Ex. 2 (+20 rods) ³ | R_g | 2.489 Ω | 2.52 | −1.2 % |
| | worst touch | 709.9 V | 756.2 | −6.1 % |
| | step | 460.5 V | 459.1 | +0.3 % |
| Ex. 4 (L-shape) | R_g / touch / step | 2.313 Ω / 713.8 V / 457.8 V | 2.34 / 742.9 / 441.8 | −1.1 / −3.9 / +3.6 % |
| Exhibit 1 (two-layer, 9 rods 9.1 m) | R_g | 1.137 Ω | 1.353 | −15.9 % ⁴ |
| Exhibit 2 (unequal spacing) ³ | R_g | 1.462 Ω | 1.416 | +3.3 % |
| | corner-mesh / worst touch (% GPR) | 8.6 / 15.4 | 9.29 / 17.08 | −7 / −10 % |

³ Rod positions are read off the figures. For Ex. 2, "every other perimeter
crossing" is assumed.

⁴ Without the rods, our result equals the review's independent solver (8.1),
so the difference comes from the rods, which reach into the more conductive
lower layer. Rods crossing the interface are validated by Annex H Grids 3 and 4,
where three modern programs agree with this solver to 0.5 %. The Exhibit 1
difference is recorded as unexplained. It is not tuned away.

**Reading of the evidence.** Against the three current programs of Annex H the
solver is inside their spread, or within 2.5 % of it, for resistance and touch
voltage on every grid. That includes the diagonal grid (Grid 6) and the
separately earthed fence (Grid 4). Step voltages sit within 5 %, the same order
as the programs' own spread (WinIGS is 20 % below the others on Grid 6). The
EPRI program of Annex B gives 1 % more resistance and 2 % more touch voltage
on the one fully specified case (Ex. 1). Where rod positions are read from the
figures (Ex. 2, 4, Exhibit 2) the touch-voltage gap grows to 4–10 %. No case is
solved by both EPRI and the modern programs, so which is closer cannot be
settled from the standard. The Annex H agreement is the stronger evidence:
three independent programs, fully specified geometry.

**Engineering margin.** A touch voltage within a few percent of its limit
should be treated as marginal.

## 9. Limitations

- **Equal potential of bonded metal.** It is checked (§7.2) but not relaxed.
  Large sites with thin or steel conductors in low-resistivity soil — PV farms
  are the typical case — need a solver with conductor impedance.
- **Soil.** Horizontal layers only: one or two, no lateral variation, no more
  than two layers. IEEE 80 §16.2.3 notes that real soil varies laterally too.
- **Crossing between layers.** Fine for rods. The surface-layer (crushed-rock)
  resistivity is in the body circuit only (§3.3).
- **Frequency.** Power frequency only — no lightning or switching transients
  (IEEE 80 §17.7, EN 50522 Annex F).
- **Voltages not computed.** Metal-to-metal touch (IEEE 80 §8.2) and
  transferred voltages beyond the unbonded fences modelled (pipes, cable
  sheaths, rails; IEEE 80 §17.9, EN 50522 §6) are not computed.
- **Ground surface.** Flat ground only. The touch area is the grid outline (or
  fence + 1 m) unless drawn.
- **EN 50522.**
  - C1 (global earthing system) is not assessed.
  - Isolated or resonant-earthed currents are user inputs.
  - Table 2 (LV transferred potential) and Annex D conductor sizing are not
    implemented.
- **Fault location.** One per bus. The worst over the buses on the grid is the
  design case.

## 10. Modelling guide

- **Start from the bus.** "Create from bus" turns the bus's existing IEEE 80
  data into an earth grid that reproduces the same result exactly. Then edit it.
- **One grid per site.** The HV and LV buses of a substation share one grid:
  point both buses at it. The HV bus usually sets the design current. The LV
  bus of a Dyn transformer has little remote current (§6.1).
- **Corner meshes first.** The corner mesh has the highest touch voltage on an
  evenly spaced grid (Annex H Grid 1, T3 on the corner diagonal). Remedies,
  in the order of IEEE 80 §16.6:
  - diagonals across the corner meshes (`Diagonals: corner meshes`);
  - closer spacing at the perimeter (uneven spacing, `x_lines` / `y_lines`);
  - rods at the perimeter, especially the corners;
  - a perimeter conductor 1 m outside the fence;
  - more surface-layer resistivity or thickness;
  - faster clearing.
  
  Compare each change numerically against numerical (§2).
- **Uneven spacing.** Enter the conductor positions, e.g.
  `0, 3, 12, 24, 45.7, 67, 79, 88.4, 91.4`. The worst touch voltage can then be
  in an interior mesh (Exhibit 2): read the location in the results, not only
  the value.
- **Fences.**
  - A fence **bonded** to the grid extends the touch area to 1 m outside it.
    Lay a perimeter conductor about 1 m outside the fence (`conductor offset`)
    so the potential outside does not drop steeply (IEEE 80 §17.3).
  - A **separately earthed** fence (not bonded, typically 2–3 m outside the grid
    with its own conductor) reduces the touch voltage on the fence. It creates a
    grid-to-fence transfer voltage: nothing may bridge the two.
  - Posts: spacing about 3 m, depth about 0.8 m, diameter about 50 mm.
- **Rods.**
  - *Perimeter, even* reproduces the per-bus placement (corners first).
  - *Perimeter crossings* or *every other crossing* put rods at conductor
    joints, as IEEE 80's examples do.
  - Rods into a lower, more conductive layer are very effective (Exhibit 1);
    rods ending in a resistive lower layer much less so.
- **Soil.** Use the Wenner interpreter to fit ρ₁/ρ₂/H from field readings. With
  a resistive lower layer (K > 0), surface gradients and touch voltage rise
  sharply. The uniform-soil equations underestimate touch voltage there by up to
  2.4× (GROUNDING_REVIEW.md G1).
- **Design current.** Check the split factor S_f (IEEE 80 §15.9, Annex C;
  EN 50522 Annex I reduction factor r) and the fault duration. For isolated or
  resonant systems enter the design earth-fault current.
- **Element length.** 1 m is adequate (§4.7). Use 0.5 m to confirm a marginal
  result.
- **Reading the plan.**
  - The heatmap is touch voltage over the touch area, scaled to the limit.
  - ✕ marks the worst touch point; the short segment marks the worst 1 m step.
  - Fence posts are squares and rods are dots.
  - Unbonded metal is drawn dashed.

## 11. Data model

`ProjectData.earthGrids[]` — each grid:

| Field | Meaning |
|---|---|
| `id`, `name` | identity; buses refer to `id` via `earth_grid_id` |
| `soil` | `rho1`, `two_layer` (`on`/`off`), `rho2`, `h1` |
| `surface` | `rho_s`, `h_s` (h_s = 0: no surface layer) |
| `conductor` | `material`, `area_mm2` (size), optional `diameter_m` (measured outside diameter, geometry only), `depth_m`, `joint` |
| `layout` | `type` `rect` / `l` / `none`; `length_x`, `width_y`; `n_x`, `n_y` or `x_lines`, `y_lines` (explicit positions); `notch_x`, `notch_y` (L); `diagonals` `none` / `corner_meshes` / `all_meshes` / `full` |
| `rods` | `rule` `none` / `perimeter_even` (with `count`) / `perimeter_nodes` / `perimeter_alternate` / `corners` / `all_nodes`; `length_m`, `diameter_m` |
| `fences[]` | `name`, `offset_m` (+ out / − in), `bonded`, `post_spacing_m`, `post_depth_m`, `post_diameter_m`, `conductor_offset_m` (none = no fence conductor), `conductor_depth_m` |
| `extra_conductors[]` | `x1, y1, x2, y2`, optional `depth_m`, `area_mm2` (or `diameter_m`), `bonded` |
| `extra_rods[]` | `x, y`, optional `length_m`, `diameter_m`, `bonded` |
| `touch_area` | optional polygon `[[x, y], …]` |
| `method` | `auto` / `ieee80` / `numerical` |
| `limits` | `ieee80` / `en50522` |
| `body_weight` | 50 / 70 (IEEE 80) |
| `en50522` | `footwear_ohm`, `hand_ohm`, `measures_m` (`yes`/`no`) |
| `element_length_m` | numerical element length, 0.2–5 m |

The study request may carry `groundingBusIds` to evaluate only those buses;
the fault study still covers the whole network.

Per bus: `earth_grid_id`, plus `fault_duration` (t_s / t_f),
`fault_clearing_time` (t_c), `current_split_factor` (S_f or r), `ambient_temp`,
and the optional `design_earth_fault_ka`.

Results: each bus carries the usual keys (`grid_resistance_ohm`, `gpr_v`,
`mesh_voltage_v`, `step_voltage_v`, the limits, `status`) plus `method`,
`limit_basis`, the worst-point locations, `numerical`, `ieee80_simplified`,
`en50522`, `fences`, and `potential_variation_pct`. The study result carries
`grids{id}`: the plan, a surface-potential map as a fraction of GPR, and the
per-unit results.
