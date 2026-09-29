# Equipment Duty Check Review

*Review date 2026-09-29, method per `ENGINE_REVIEW_METHODOLOGY.md`, against
IEC 60947-2 (Icu, Table 2, Icw), IEC 60269 (fuse breaking capacity),
IEC 62271-100 (Isc vs Ib, §4.101 asymmetry, making factor), IEC 62271-1 /
IEC 60038 (Ur ≥ Um) and IEC 60909-0. Findings DU1–DU3 and lesser notes
L1–L4, all fixed.*

Evidence: `testing/duty-check-review/v1_core.py` (run from the repo root in
the backend image with `PYTHONPATH=/work`).

## 1. What held up

| Checked | Result |
|---|---|
| MV making = 2.5·Isc (50 Hz) / 2.6·Isc (60 Hz), IEC 62271-100 | correct |
| Asymmetrical capability Isc·√(1+2β²), β = e^(−t/45 ms), compared at the same instant as the network's Ib,asym | consistent method |
| IEC 60947-2 Table 2 making ratio n (1.41 / 1.5 / 1.7 / 2.0 / 2.1 / 2.2) | correct |
| Through-current refinement (a feeder breaker's through-fault, never above the bus figure) | sound |
| MV breakers judged on Ib (IEC 62271-100) | correct |

## 2. Findings (marked `[DUn]` in code)

| # | Defect | Evidence → fix |
|---|---|---|
| DU1 | Every device judged on the decayed breaking current Ib. LV breakers (IEC 60947-2 Icu) and fuses (IEC 60269) are rated against the prospective I″k — no decay credit. Non-conservative near motors/generators | Motor bus (I″k 65.08, Ib 52.08 kA): a 58.6 kA MCCB and fuse passed. Now LV/fuse duty = largest prospective I″k; MV keeps Ib |
| DU2 | Three-phase fault only; the rating must cover the largest phase current of any type. Non-conservative | LV genset: Ik1 15.30 vs Ik3 12.75 kA; with DU1 the breaker was judged on 8.45 kA and a 14.0 kA ACB passed (45 % low). Now max(Ik3, Ik1, IkLL); the LLG field (earth current 3·I0 = 1.5·Ik3 there) is excluded as it is not a pole current. Making peak uses the same largest current |
| DU3 | Devices on distribution boards skipped ("no connected bus") | 6 kA MCB on a 43.3 kA board: now checked and fails |

## 3. Lesser notes (marked `[Ln]`)

| # | Note | Fix |
|---|---|---|
| L1 | Rated voltage compared with the system nominal; IEC 62271-1 requires Ur ≥ Um (IEC 60038) | Um from the IEC 60038 series (11 → 12, 22 → 24, 33 → 36, 132 → 145 kV); fail below nominal, warning between nominal and Um. CB and fuse defaults now 12 kV |
| L2 | No short-time withstand check for time-delayed (category B) breakers | optional `icw_ka` / `icw_time_s`; I²·t_sd ≤ Icw²·t_cw when no instantaneous trip; warning when the rating is missing |
| L3 | Ib and the DC component always evaluated at 0.1 s | optional `contact_parting_s`: below 0.1 s the duty is the undecayed I″k and the DC component (τ recovered from the 0.1 s figure) and the rated β are evaluated at that time |
| L4 | IEC 62271-100 asymmetry check applied to LV breakers | MV only (an IEC 60947-2 breaker covers asymmetry through its Table 2 test pf / making ratio) |

Observation, unchanged: switch-disconnectors (IEC 60947-3 / 62271-103) are
not duty-checked — no rating props exist for them yet.

`frontend/js/compliance.js` mirrors the breaking basis (and gains the 1.41
making step for Icu ≤ 4.5 kA it lacked).

**Behaviour change for saved projects:** re-run the duty check. LV breakers
and fuses near motors/generators and at gensets will show higher duties; MV
breakers rated at the system nominal (e.g. 11 kV) now warn.

Tests: `backend/tests/test_duty_check_review_fixes.py` (18).
`test_p3_fixes.py::TestPS14DutyCheck` asymmetry tests moved to 11 kV (they
applied the MV asymmetry check to a 0.4 kV breaker).
