# Conductor Temperature Review — `conductor_temp.py` and the fault study's line resistance

*Review date 2026-09-29. Method: `ENGINE_REVIEW_METHODOLOGY.md`. References:
IEC 60909-0:2001 §2.4, §2.5 eq. (3), §3.4 (in `IEC Standards/`, text layer);
IEC 60228 Table 1 (20 °C conductor resistances); IEC 60364-4-43 Table 43A
(final short-circuit temperatures); temperature coefficients from IEC 60228,
IEC 60889 (hard-drawn Al) and IEC 60104 (AlMgSi). IEC 60865-1 (bare-conductor
short-circuit temperature, 200 °C) is the reviewer's reading, since that
standard is not in the folder. No reference was derived from the module or its tests.*

## 1. Scope

`conductor_temp.py` corrects an overhead line's resistance from the 20 °C
overhead library to its operating temperature, once, when a `ProjectData` is
built. The rest of the question is which resistance temperature each study
should see, because the two conductor libraries are on different bases:

| Library | Stored basis (verified, §2) |
|---|---|
| `STANDARD_CABLES` (insulated, 113 entries) | R20 × 1.275 Cu XLPE / 1.282 Al XLPE (90 °C), × 1.20 PVC (70 °C), × the AC skin factor from 150 mm² up |
| `STANDARD_OVERHEAD_LINES` | 20 °C (codeword convention) |

Load flow, volt drop and losses want operating temperature. IEC 60909 does
not. It wants **20 °C for maximum currents** (§2.4: "resistance R_L of
lines (overhead lines and cables) are to be introduced at a temperature of
20 °C") and **the end-of-fault temperature θe for minimum currents** (§2.5,
eq. 3: R_L = [1 + 0.004·(θe − 20 °C)]·R_L20).

## 2. What holds up

| Checked against | Result |
|---|---|
| α: Cu 0.00393 (IEC 60228), Al 0.00403 (IEC 60889), AAAC 0.00360 (IEC 60104), ACSR as its Al strands | correct |
| Library `r_per_km` vs IEC 60228 R20, all 113 entries (`v1_library_basis.py`) | armoured cables exactly R20 × factor (±0.02 %) up to 120 mm², then the skin factor (1.013 at 150 mm² to 1.083 at 400 mm² Cu); building wiring within ±2.5 % (catalogue rounding) |
| Engine given R20 vs a hand IEC 60909 calculation (Z_Q eq. 15, K_T eq. 12a) | exact, 9.229 vs 9.229 kA |
| Overhead correction: idempotent, re-targetable, save/load restores 20 °C | holds |
| Load flow sees the hot cable value and the 75 °C overhead value | correct for steady state |

## 3. Findings

### CT1 — maximum-current study used hot resistances (non-conservative) — `fault.py:73`

The fault engine took `r_per_km` as it stood: 90 °C / 70 °C for cables, and
overhead lines after the central 75 °C correction. §2.4 requires 20 °C.
`v2_max_fault_temperature.py` (100 m line after a 1 MVA 6 % transformer, 250 MVA
grid):

| Line | Hand at 20 °C | Engine before | Error |
|---|---|---|---|
| 95 mm² Cu XLPE | 9.229 kA | 8.017 kA | −13.1 % |
| 16 mm² Cu XLPE | 2.158 kA | 1.705 kA | −21.0 % |
| ACSR Dog overhead | 4.742 kA | 4.454 kA | −6.1 % |

**Non-conservative.** An understated maximum makes every consumer of the
maximum study look better than it is: breaking duty (`duty_check`), cable
withstand at the largest current (`cable_sizing`, `compliance.js`), arc flash,
grounding GPR and the PDF report. The DC review had already fixed the same
defect for IEC 61660-1 (DC4). The AC engine was never changed.

**Fix.** `_lines_at_study_temperature` rebuilds the study copy of the
project. Insulated cables have the library factor divided back out
(`conductor_temp.insulated_hot_factor`, factor from the library id), and
overhead lines are re-targeted to 20 °C through the central correction. The
caller's project and every non-fault engine keep operating temperatures. The
open-conductor / simultaneous-fault entry points (`_series_fault_break_thevenin`)
use the same basis for their impedances. Their pre-fault load flow stays hot.

### CT2 — minimum study applied eq. (3) to the hot value — `fault.py:73`

The compliance disconnection check and the cable-sizing far-end check run a
minimum study at "70 °C". The engine multiplied the *hot* library value by
1 + 0.004·50, so the resistance actually used was R20 × 1.53 for XLPE (≈152 °C)
and R20 × 1.44 for PVC (≈130 °C). That is neither 70 °C nor any stated θe.
`v3_min_fault_temperature.py` gives the size of the error for 16 mm² at the
far end: against eq. (3) at 70 °C the engine read 21 % low (XLPE) / 16 % low
(PVC). Against the IEC 60364-4-43 final temperatures it read 25 % high (XLPE,
250 °C) / 8 % high (PVC, 160 °C).

**Decision (2026-09-29): θe = the end-of-fault temperature per insulation**,
IEC 60909-0 §2.5 literally:
- PVC 160 °C (140 °C above 300 mm²);
- XLPE/EPR 250 °C (Table 43A);
- bare overhead conductors 200 °C (IEC 60865-1).

The request field `conductorTemperatureC` now takes `"final"` for this (the
frontend minimum study and cable sizing send it). A number still puts every
line at that temperature. §4.6's Ik_min (`ik_steady_min`) carries §2.5's
conditions, so the maximum study now builds the θe line set for it too. Before,
it inherited whatever the maximum study used.

Post-fix, `v4_min_fault_eq3.py` matches eq. (3) within 0.03 % for Cu/Al XLPE,
PVC and overhead lines, at 70 °C and at θe.

## 4. Lesser notes

- **L1. AAAC took aluminium's α.** The properties panel copies r/x/rating
  from the overhead library but not `material`, so `alpha_for(None)` fell back
  to 0.00403. An AAAC line at 75 °C was 1.222 × R20 instead of 1.198 × R20
  (+2 %). `overhead_material` now reads the library id (`overhead_type`).
- **L2. DC hot factor ignored the library id.** `dc_shortcircuit._hot_factor`
  read `conductor`/`insulation` props, which the panel never sets, so PVC and
  Al cables were divided by the Cu XLPE 1.275. A PVC cable's R20 came out 6 %
  low. It now shares `insulated_hot_factor`.

## 5. Tests re-based

Each of these fixture changes was made because the old test encoded the
defect. None was made to widen a tolerance:

- `test_fault_review_fixes.py` F1/F2/F3/F9, `test_verification_fixes.py` PS-1:
  the hand reductions work in 20 °C ohms, but the fixture cables stored that
  figure as `r_per_km`, which by contract is hot. The fixtures now store
  r20 × `insulated_hot_factor({})` and the hand values are unchanged. F9's
  Ik_min now takes the lines at 250 °C (CT2).
- `test_conductor_temp.py::test_minimum_fault_study_retargets_instead_of_multiplying`
  compared a 70 °C minimum study with a maximum study of a line whose prop was
  70 °C. That pinned the maximum study to the operating temperature (CT1). It
  now asserts that the study result does not depend on the prop, plus a new
  maximum-study counterpart.
- `test_compliance_review_followups.py` far-end minimum: now `"final"`, with
  the new message text.

## 6. Effect on saved projects

The maximum study on the 15 projects in the live database (101 bus results):
- Ik3 rose by a median of +3.0 % and a maximum of +25.5 %;
- 34 bus results rose by more than 10 %;
- none fell.

Minimum-study results for XLPE cables fall (the 250 °C basis), and PVC results
fall slightly. Stored fault, duty, arc-flash and compliance results are not
recomputed on load, so **re-run them**.

## 7. Not covered

- `fault_ansi.py` (ANSI C37 has its own resistance convention);
- the DB circuit check's Ze from `thevenin_sequence_at_bus`, which stays hot;
- the rectifier's AC supply impedance in `dc_shortcircuit.py`, which stays hot;
- skin effect at 20 °C (the library's 90 °C skin factor is kept, <1 % on R
  at 400 mm²);
- the overhead library's 20 °C values against BS 215 / IEC 61089 (Tier 4
  library check).

Scripts (session scratchpad): `v1_library_basis.py`, `v2_max_fault_temperature.py`,
`v3_min_fault_temperature.py` (pre-fix evidence), `v4_min_fault_eq3.py`.
