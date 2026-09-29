# Lightning Risk Review — `lightning_risk.py` + `lightning.js`

*Review date 2026-09-29. Method: `ENGINE_REVIEW_METHODOLOGY.md`. The
reference is an independent R1 implementation written from the IEC
62305-2:2010 equations (A.2–A.11, B.1–B.11, C.1–C.4) and tables. It was not
derived from the module or its tests.*

**Source caveat.** The 2010 edition the engine implements is not in
`IEC Standards/`, and its public previews end before the annexes. So 2010
table values are the reviewer's reading, cross-checked where the 2024 edition
kept the same table (below). **LR3 (2010 Table B.9) is confirmed** from GOST R
IEC 62305-2-2010, the identical Russian adoption of the 2010 text:
- power lines: 1 / 0.6 / 0.3 / 0.16 / 0.1;
- telecommunication lines: 1 / 0.5 / **0.2** / 0.08 / 0.04;
- at U_W = 1 / 1.5 / 2.5 / 4 / 6 kV.

**IEC 62305-1:2024 (Ed. 3, in `IEC Standards/`, scanned).** Part 1 has no
risk tables, but it confirms two things independently:
- **§5.2 and Table 2 back LR1.** Loss L1 includes D3 (failure of internal
  systems) only "in structures where failure of internal systems endangers
  human life, for example in structures with a risk of explosion and
  hospitals". Table 1 puts hotels and schools with theatres and department
  stores (panic, failed fire alarms), and hospitals separately (intensive
  care, immobile people).
- **Table 5 backs P_SPD and P_EB** (Tables B.3/B.7). The probability that
  current parameters stay below the LPL maximum is 0.99 / 0.98 / 0.95 / 0.95
  for LPL I–IV. That gives 1 − p = 0.01 / 0.02 / 0.05 / 0.05, as the engine
  uses.

It also raises an edition question, E1 in §4.

**IEC 62305-2:2024 (Ed. 3, in `IEC Standards/`, text layer).** This is the
current Part 2. The 2010 edition the engine implements is not in the folder.
The 2024 text keeps several 2010 tables unchanged and so confirms these
findings:

| Finding | 2024 clause | Confirms |
|---|---|---|
| LR1 | Table 3 note a, eq. (7); Table C.2 lists hotels and schools as *normal loss*, and note e allows L_O only with explosion or life-endangering failure | Hotels and schools carry no L_O |
| LR2 (r_p) | B.4: "In zones with a risk of explosion, r_p = 1 for all cases unless provisions are taken…" | r_p = 1 |
| LR4 | Table C.2 note a: operating rooms and ICUs are *very high loss*, L_O1 up to 10⁻² | ICU L_O = 10⁻² |
| LR5 | Table B.11: P_LD columns 1 / 1.5 / 2.5 / 4 / 6 kV are 1, 1, 0.95, 0.9, 0.8 / 0.9, 0.8, 0.6, 0.3, 0.1 / 0.6, 0.4, 0.2, 0.04, 0.02 by R_S band | P_LD by R_S and U_W, exactly as quoted |
| LR6 | eq. (10) P_C = 1 − Π(1 − P_Ci); Table B.9: C_LD = 0 with no external line | both parts |
| LR2 (L_F) | Explosion is *very high loss* (L_F1 up to 2 × 10⁻¹) | direction only; 2024 has no single 10⁻¹ value |
| LR3 | Table B.9 of 2010 (P_LI) no longer exists: 2024 moves U_W into A_I and sets P_Z = P_SPD·C_LI | not in 2024; **confirmed from the 2010 text** (GOST R IEC 62305-2-2010 Table B.9) |

**The 2024 method gives different answers (E1, promoted to a finding in §3).**
V5 (`v5_house2024.py`) reproduces the 2024 Annex F.2 house exactly from the
2024 equations (R_B 0.062, R_U 0.003, R_V 1.728, **R = 1.793 × 10⁻⁵**, Table
F.8). The engine, on the same house (N_G = N_SG/k = 4), gives **R1 = 0.151 ×
10⁻⁵ and "No protection required"**, where 2024 requires SPDs LPL IV at the
entrance. The 12× gap is:
- 2× from strike-point density: N_SG = k·N_G, k = 2 by default (A.1);
- 2× from the loss class: L_F1 = 2 × 10⁻² for a private house (2010:
  10⁻²);
- 3× from the single risk: 2024 adds R_B2 and R_V2 (L2, with no P_P factor)
  to the same R.

Reference scripts (scratchpad `lr/`): `ref.py` (the independent 2010 R1),
`v1_core.py`, `v2_edges.py`, `v3_verdicts.py`, `v4_hotel.py`,
`v5_house2024.py`. Each prints `reference | engine | error`.

## 1. Scope

`run_lightning_risk` / `_compute_r1`: collection areas, dangerous events,
probabilities, losses, R1 composition and the recommendation ladder. Also the
dialog's live estimate (`LightningUI.updateLive`), and the request built by
`collectLightningParams` (`app.js`) with its defaults. R2–R4 are not
implemented and were not reviewed.

## 2. What holds up

| Checked against | Result |
|---|---|
| A_D (eq. A.2), A_M (A.7), A_L = 40·L_L (A.9), A_I = 4000·L_L (A.11) | exact |
| N_D (A.4), N_M (A.6), N_L (A.8), N_I (A.10) with C_D, C_I, C_E, C_T (Tables A.1–A.4) | exact |
| P_A = P_TA·P_B, P_B (Table B.2), P_SPD (B.3), P_EB (B.7), P_MS = (K_S1·K_S2·K_S3·K_S4)² with K_S4 = 1/U_W | exact |
| P_U = P_TU·P_EB·P_LD·C_LD, P_V, P_W, P_Z (eq. B.8–B.11), unshielded line | exact |
| L_A = L_U, L_B = L_V, L_C = L_M = L_W = L_Z (eq. C.1–C.4); r_t, r_p, r_f, h_z (Tables C.3–C.6); L_T, L_F by use (Table C.2) | exact |
| R1 composition (§4.3 eq. 1), with R_C/R_M/R_W/R_Z counted only where internal-system failure endangers life | exact |
| **V1: 55,296 input combinations** (location, use, floor, fire, hazard, U_W, LPS, SPD, one power line of every installation/environment/C_T, or none) | worst relative error **4.7 × 10⁻¹⁶** on every component |
| Dialog live estimate (A_D, N_D, N_M) vs the engine | same formulas, same C_D table |

The core arithmetic is right. Every defect is either a table value or a case
the engine folds into the wrong category.

## 3. Defects, ranked

### E1 — The engine implements the superseded 2010 edition; IEC 62305-2:2024 gives materially higher risk — **decision needed, non-conservative against 2024**

The whole module (`lightning_risk.py`, the dialog, the PDF) follows IEC
62305-2:2010. The third edition (2024-09) changes the method:
- **Strike-point density.** N_SG = k·N_G (k = 2 unless the LLS provider
  gives one) replaces N_G (A.1).
- **Areas near the structure and line.** A_M uses r_M = 350/U_W, and A_I
  = 2·r_I·L_L with r_I = 2000/U_W^1.8. N_M and N_I carry 1/k (A.7, A.11).
- **Single risk.** R = R_L1 + R_L2, adding physical damage (L_F2, L_O2) to
  loss of life (eq. 6–8), with P_P = t_z/8760 and P_e = t_e/8760 as explicit
  factors (Table 3, B.11, B.12).
- **Loss classes.** Four classes (low / normal / high / very high) with value
  ranges, highest recommended by default, replace the per-use L_F
  (Table C.2).
- **New factors.**
  - P_B = P_S·P_LPS·r_f·r_p, with P_S by construction (B.4, Table B.4).
  - Fire factors now apply to R_V: P_V = P_EB·P_LD·C_LD·r_f·r_p.
  - Soil or floor type now applies to R_U: P_U includes r_t.
  - K_S4 is dropped, since U_W now enters through A_M (B.6 Note 3).
  - C_I buried = 0.3 (was 0.5).
  - SPD probabilities are split between LV and telecom lines
    (Tables B.7/B.8).
  - Thunderstorm warning systems (P_TWS) and people exposed on roofs (R_AD)
    are new.
- **Frequency of damage.** F against F_T = 0.1 or 1 per year (clause 9)
  replaces risk for internal systems.
- **Tolerable risk.** R_T = 10⁻⁵ becomes "representative" (7.3 Note 1).

On the standard's own house example (V5), the engine says **no protection
required** at R1 = 0.15 × 10⁻⁵, where 2024 gives 1.79 × 10⁻⁵ and requires
SPDs. Against 2024, the engine is non-conservative by about 12× on a plain
dwelling.

**Options:**
1. **Stay on 2010, fix LR1–LR7.** This is defensible where the 2010 text is
   still the adopted national standard (SANS 62305-2 is, to the reviewer's
   knowledge, still the 2010 text; confirm). The dialog and PDF then say
   "IEC 62305-2:2010", and R_T becomes an input with 10⁻⁵ as the default.
2. **Move to 2024.** This is a rewrite of `_compute_r1` plus new dialog
   inputs:
   - N_SG and k;
   - construction (P_S);
   - U_W per internal system, power and telecom;
   - K_S3 wiring;
   - loss class;
   - t_e;
   - screen R_S;
   - TWS.

   It also adds F against F_T as a second verdict. Annex F (house, office,
   hospital) gives three published end-to-end checks.
3. **Both editions, selectable per assessment**, as arc flash does for IEEE
   1584-2002/2018. The absent field means 2010, so saved assessments
   reproduce. New assessments default to 2024.

Pre-existing since the engine was added (`f349ccd`, 2026-07-10). The 2024
edition was already published by then.

### LR1 — Hotels and schools are treated as structures where an internal-system failure endangers life — **high, over-specifies protection, fires on a shipped option**

`lightning_risk.py:147-152, 221`. The "Hospital, hotel, school" card sets
`systems_life_risk = True` and L_O = 10⁻³. IEC 62305-2 counts R_C, R_M, R_W
and R_Z in R1 only for structures with a risk of explosion, and for hospitals
or other structures where an internal-system failure immediately endangers
life (§4.3, footnote to eq. 1). Table C.2 gives L_O only for those cases. For a
hotel or school, L_F = 10⁻¹ (right in the engine) and L_O does not apply.

Evidence (V4): a 20 × 15 × 8 m hotel, 200 occupants, N_G = 4, one buried power
line. The engine gives **R1 = 7.98 × 10⁻⁴**, and 7.81 × 10⁻⁴ of that is
internal-system risk that should not be there. The correct R1 is
**1.71 × 10⁻⁵, overstated 47×**. The engine recommends **LPS class I + SPDs
LPL I**. The correct minimum is **SPDs LPL III-IV alone** (8.8 × 10⁻⁶).

This is conservative, but it tells a client they need the most expensive LPS
class, when coordinated surge protection alone meets the limit. It has been
present since the engine was added (`f349ccd`).

**Fix:** split the card into *Hospital* (life-critical internal systems,
L_O = 10⁻³, plus an "intensive care / operating theatres" option at
L_O = 10⁻², see LR4) and *Hotel, school, civic building* (L_F = 10⁻¹, no
L_O). Keep the saved key `hospital_hotel_school` mapped to *Hospital*, so
existing assessments reproduce, and say so in the PR.

### LR2 — Explosion risk: L_F stays at the use value and r_p still credits fire protection — **high on R_B, non-conservative**

`lightning_risk.py:210, 213`. With `explosion_risk`, Table C.2 gives
L_F = 10⁻¹ whatever the use, and the note to Table C.4 sets r_p = 1 ("in
structures with risk of explosion, r_p = 1 for all cases"). The engine keeps
L_F from the use (10⁻² for *other*, 2 × 10⁻² for *industrial*) and applies the
fire-protection credit (0.5 manual, 0.2 automatic).

Evidence (V2-A): an industrial plant with an explosion risk and automatic
extinguishing. **R_B is 2.64 × 10⁻⁵ against the correct 6.60 × 10⁻⁴ (−96 %,
25× low)**. L_F alone accounts for 5× and r_p for the other 5×.

In the grid tried (V3-A) the verdict does not flip, because R_C and R_M
(L_O = 10⁻¹) dominate and keep the result non-compliant. But the reported
R_B, its share and the PDF breakdown are wrong by 25×. Any future measure that
lowers R_C/R_M would expose the error.

**Fix:** `lf = 1e-1` and `rp = 1.0` when `explosion_risk`, each marked `[LR2]`.
Mention it on the explosion checkbox text.

### LR3 — Table B.9 P_LI for telecom lines at U_W = 2.5 kV is 0.15; the table gives 0.2 — **medium, non-conservative, flips recommendations**

`lightning_risk.py:157`. The TLC row is 1 / 0.5 / **0.2** / 0.08 / 0.04 (the
engine has 0.15). 2.5 kV is the dialog's default U_W.

Evidence (V2-C, V3-C): a hospital with a telecom line has R_Z **23 % low**. In
the V3 grid of hospitals with a power line plus an aerial telecom line,
**28 of 48 recommended options do not actually meet R_T**. The worst is
LPS I + SPD I: 8.84 × 10⁻⁶ from the engine, 1.08 × 10⁻⁵ correct. That means
"Install LPS class I + SPDs LPL I" is shown as sufficient when it isn't. For
these cases the engine should warn that LPS + SPD alone cannot reach R_T.

**Fix:** 0.15 → 0.2 (`[LR3]`). Confirmed from the 2010 text (see the source note at the top).

### LR4 — Hospital intensive care and operating theatres use L_O = 10⁻³; Table C.2 gives 10⁻² — **medium, non-conservative**

`lightning_risk.py:150-151`. The dialog has no way to enter the ICU and
operating-block value, so a hospital's internal-system risk is 10× low
wherever life-support equipment is installed (V2-B: R1 7.98 × 10⁻⁴ against
7.82 × 10⁻³, −90 %). **Fix:** add it with LR1, as a *Hospital* option.

### LR5 — A shielded line always gets P_LD = 0.2; Table B.8 sets it from the screen resistance R_S and U_W — **medium, non-conservative**

`lightning_risk.py:246`. Table B.8: a screen bonded at the entrance gives, at
U_W = 1 / 1.5 / 2.5 / 4 / 6 kV:
- 1.0 / 1.0 / 0.95 / 0.9 / 0.8 for 5 < R_S ≤ 20 Ω/km;
- 0.9 / 0.8 / 0.6 / 0.3 / 0.1 for 1 < R_S ≤ 5;
- 0.6 / 0.4 / 0.2 / 0.04 / 0.02 for R_S ≤ 1.

A screen that is not bonded gives P_LD = 1. So 0.2 is the best case at 2.5 kV
only. Evidence (V2-D): a shielded aerial telecom line at U_W = 1.5 kV. R_U and
R_V are **80 % low for a typical telecom screen (5–20 Ω/km)**, 75 % low for
1–5 Ω/km, and still 50 % low for R_S ≤ 1 Ω/km. The same table also gives
C_LI = 0 for a bonded screen. The engine keeps C_LI = 1, which is
conservative on R_Z.

**Fix:** replace the "shielded" checkbox with a screen choice (*unshielded*,
*screen not bonded*, and *bonded* with R_S ≤ 1 / 1–5 / 5–20 Ω/km). Take P_LD
from Table B.8 by U_W, and C_LI from Table B.4. The old `shielded: true` maps
to *bonded, R_S ≤ 1 Ω/km*, the only reading under which 0.2 was ever right.

### LR6 — P_C does not combine over several lines, and a structure with no lines still gets P_C = P_SPD — **low**

`lightning_risk.py:238`. P_C = P_SPD·C_LD is per internal system, and several
systems combine as P_C = 1 − Π(1 − P_C,i). With no external line at all,
C_LD = 0 and P_C = 0 (Table B.4).

- With two lines and SPDs fitted, R_C is 49 % low (V2-E). No recommendation
  flipped in V3-E.
- With no lines, R_C is 7.6 × 10⁻⁶ instead of 0. This is conservative, and
  the dialog already warns that no lines were entered.

**Fix:** `pc = 1 − Π(1 − P_SPD)` over the lines, and 0 with none (`[LR6]`).

### LR7 — The recommendation ladder skips combinations and can over-specify — **low**

`lightning_risk.py:278-285`. Only six (LPS, SPD) pairs are tried, so "SPDs LPL
II or I without an LPS" is never offered. In V2-F, **4 of 52 cases recommend a
higher LPS class than needed**. For example, a hospital with 10 occupants at
N_G = 2 is recommended "LPS class II + SPDs LPL II", when SPDs LPL I with no
LPS meets R_T. **Fix:** evaluate all 5 × 4 pairs. Recommend the cheapest
compliant one, ordered by LPS class first and then SPD level. Show the
compliant options in the options table.

## 4. Lesser notes

- **L1** — The tolerable risk is cited as "Table 7" (engine docstring,
  `index.html` rail, results page, PDF). That is the 2006 edition's number.
  In IEC 62305-2:2010 it is **Table 4**.
- **L2** — The default location factor is *surrounded by objects of the same
  height* (C_D = 0.5), which halves N_D for any user who doesn't change it.
  That is a reasonable urban default. *Isolated* (1.0) would be the
  conservative one. The live estimate shows the effect, so this is noted
  rather than changed.
- **L3** — Options the standard offers that the dialog omits are all
  conservative when absent:
  - C_I = 0.01 for a buried cable running inside a meshed earth termination;
  - r_f for explosion zones 1/21 (10⁻¹) and 2/22 (10⁻³); explosion is always
    zone 0/20 (r_f = 1);
  - P_TA and P_TU measures (warning notices, insulation, physical
    restriction);
  - C_LI = 0 for a bonded screen (LR5).
- **L4** — Input validation: `hours_per_year` > 8760 and n_z > n_t are not
  clamped by the backend. The dialog's `max` stops the first in normal use.
- **L5** — N_DJ (flashes to an adjacent structure at the far end of a line)
  and multi-zone assessments are omitted. Both are documented in the module
  docstring.

## 5. Verdict and suggested fix order

The 2010 R1 arithmetic is exact across the whole input space. The 2010
findings are classification and table values. LR1 is the most consequential
in practice: it routinely sends hotels and schools to LPS class I. LR2 and
LR3 are the non-conservative ones. **E1 comes first because it decides the
rest:** under option 2 or 3, LR1–LR7 are fixed inside the 2024 rewrite rather
than patched in the 2010 path. Under option 1, they are fixed as below.

Suggested order:
1. LR1 + LR4 (the structure-use split, one UI change).
2. LR2 and LR3 (one-line table fixes).
3. LR6 and LR7 (engine only).
4. LR5 (needs the new screen input).
5. L1 (text).

Each fix gets an `[LRn]` marker and a regression test in
`test_lightning_review_fixes.py`. Saved assessments restore their stored
result without recomputing (`persisted-study-results-go-stale`), and the
dialog marks a result stale only when the inputs change. So the PR must say
that hotel, school, explosion-risk and telecom assessments need
re-assessing.

## 6. Fixes (2026-09-29)

Decision on E1: **both editions, selectable per assessment** (option 3). This
follows the arc-flash pattern for IEEE 1584-2002/2018.

| ID | Fix | Where |
|---|---|---|
| E1 | New `lightning_risk_2024.py`, dispatched on the request's `edition`. An absent value means 2010, so saved assessments reproduce; new assessments default to 2024. The engine is multi-zone. The dialog gives one inside zone plus an optional exposed zone. | `lightning_risk_2024.py`, `schemas.py` (`Lightning2024*`, zone results), `lightning.js`, `app.js`, `index.html` |
| LR1 | Split into *Hotel / school / civic* (no L_O) and *Hospital* (L_O 10⁻³). The saved key `hospital_hotel_school` reads as *Hospital*. | `lightning_risk.py` `LO_BY_USE`, `_LEGACY_USE` |
| LR2 | L_F = 10⁻¹ and r_p = 1 with a risk of explosion | `_compute_r1` |
| LR3 | TLC P_LI at 2.5 kV changed from 0.15 to 0.2, confirmed from GOST R IEC 62305-2-2010 Table B.9 | `PLI_TABLE` |
| LR4 | *Hospital, intensive care / theatres* at L_O = 10⁻² | `LO_BY_USE` |
| LR5 | `screen` per line; P_LD from Table B.8 by R_S band and U_W; C_LI from Table B.4. Legacy `shielded: true` becomes bonded with R_S ≤ 1. | `PLD_TABLE`, `_line_screen`, `_line_cld_cli` |
| LR6 | P_C = 1 − Π(1 − P_SPD·C_LD) over the lines, 0 with none | `_compute_r1` |
| LR7 | Every LPS × SPD pair evaluated; one row per LPS class | `_ladder` |
| L1 | R_T is an input (`tolerable_risk`, default 10⁻⁵), cited as 2010 Table 4 / 2024 7.3 | engine, dialog, PDF |

**Re-verification.**
- V1 is exact again (4.7 × 10⁻¹⁶). Its reference now uses the standard P_C of LR6.
- V2 A, C, E and F agree with the reference. B and D deliberately use the
  legacy inputs (`hospital_hotel_school`, `shielded: true`), which reproduce
  the old numbers by design. The new inputs are covered by the tests.
- The 2024 engine matches every published value in Tables F.5, F.8/F.9,
  F.14, F.21–F.24, F.28 and F.35–F.38 to the printed precision. The one
  exception is Table F.38's F_Z for Z3, printed 0.0011 for the 0.00115 that
  N_I·P_SPD gives.
- In the headless dialog run, the F.2 house entered through the form gives
  R = 1.793 × 10⁻⁵ and recommends entrance SPDs of LPL III–IV, as F.2.7 does.
  A saved pre-edition assessment restores as 2010 with an identical result.
  Both PDFs export.

**Pre-existing test re-based.** `test_regression.py::test_explosion_risk_enables_system_components`
asserted R_C = N_D·L_O on a structure with no service lines. That encoded LR6,
because with no external line C_LD = 0. The fixture now has one power line, so
the assertion tests what it meant to.

**Saved results.** Stored 2010 results are not recomputed on load. Hotel,
school, hospital, explosion-risk, telecom-line and multi-line assessments
should be re-assessed.
