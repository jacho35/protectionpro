# PT (Voltage Transformer) Model Review

*Review date 2026-09-29. Method per `ENGINE_REVIEW_METHODOLOGY.md`. Checked
against IEC 61869-3:2011 (Table 301 measuring limits, Table 302 protective
limits, Table 303 rated voltage factors, the 5.5 burden ranges) and
IEC 61869-1 / IEC 60071-1 (earth fault factor; effectively earthed at k ≤ 1.4).
Findings PT1–PT4 and lesser notes L1–L2 are all fixed.*

Scope: `backend/analysis/pt_model.py`, the PT block of `duty_check.py`, the PT
component in `constants.js`, and the Duty Check PT table in `app.js`.

Evidence: `testing/pt-model-review/v1_core.py`. Run it from the repo root in
the backend image with `PYTHONPATH=/work`.

## 1. What held up

| Checked | Result |
|---|---|
| Table 301 measuring limits (0.1 / 0.2 / 0.5 / 1.0 / 3.0 → ±0.1 %/5′, ±0.2 %/10′, ±0.5 %/20′, ±1.0 %/40′, ±3.0 %/—) | correct |
| Table 302 protective limits (3P ±3 %/120′, 6P ±6 %/240′) | correct |
| Burden range II band, 25–100 % of rated output, boundaries inclusive | correct |
| Only relay-fed PTs checked (`associated_pt`) | sound |
| Overburden → fail, underburden → warning | sound |

## 2. Findings (marked `[PTn]` in code)

| # | Defect | Evidence → fix |
|---|---|---|
| PT1 | **Non-conservative.** The rated voltage factor was not modelled at all. On a phase-to-earth VT the healthy phases rise to k × U/√3 during an earth fault: √3 with no earth, and slightly more than √3 behind a resistance, since R0 ≫ X1 gives Vc → a − 1 + 3jX1/R0. A 1.2-rated VT on a resistance-earthed or unearthed 11 kV bus passed. | 33/11 kV Dyn11 with a 6.35 Ω NER: k = 1.79. Unearthed (Dd0): k = 1.732. The engine now computes k from the bus Z1 and Z0 given by the fault study, with Z2 = Z1: k = max\|a² − (Z0−Z1)/(2Z1+Z0)\|, \|a − …\|. It matches the closed form √3·√(1+m+m²)/(2+m) to 1e-12. New props `connection` and `voltage_factor` (Table 303). The verdict fails when Vf < k·U/Upr. A 30 s rating on a non-effectively earthed bus warns, because it is adequate only with automatic earth-fault tripping; otherwise 8 h is needed. If no factor is declared, a non-effectively earthed bus warns. |
| PT2 | The rated primary was never compared with the bus voltage. Also, "11kV/110V", "11000:110" and "33000/√3/110/√3" failed to parse and silently became 11000/110. | A 33000/110 VT on an 11 kV bus sits at 33 %, outside the 80–120 % measuring range, and passed. A 6350/63.5 unit declared phase-to-phase on 11 kV sits at 173 %, above the 1.2 continuous factor, and passed. The fix matches Upr to Un or Un/√3, whichever is nearer (a declared phase-to-phase winding always uses Un). Above 120 % fails; below 80 % warns. The parser now reads kV/V units, `√3` and a secondary `/3`, and warns when a ratio can't be read. |
| PT3 | Class parsing: "1" and "3" missed the "1.0"/"3.0" keys and were reported as class 0.5. A dual "0.5/3P" also read as 0.5, even though a relay-fed winding is judged on its protective class. Unrecognised strings silently became 0.5. | Bare numbers are now normalised. A dual class keeps both labels and uses the protective limits for relays. An unrecognised class now warns. |
| PT4 | Burden range I (rated 1, 2.5, 5 or 10 VA at unity pf) is classed from 0 VA, not 25 %. A 5 VA VT driving a 0.5 VA digital relay was warned as under-burdened. | Rated < 10 VA → range I, no floor. 10 VA appears in both ranges and keeps the range II floor. |

## 3. Lesser notes (marked `[Ln]`)

| # | Note | Fix |
|---|---|---|
| L1 | Table references cited "Table 2 / Table 3", the pre-61869 numbering | Now IEC 61869-3 Tables 301 / 302 / 303 |
| L2 | The rated-burden tooltip listed 10/25/50/100/200/400 VA, which are not IEC 61869-3 rated outputs | Now lists the two burden ranges |

Observations, left unchanged:
- The 30 VA default is an IEC 60044-2 value, not an IEC 61869-3 rated output. It only matters once a connected burden is entered.
- Burden is compared in VA, ignoring power factor: range II is rated at 0.8 pf, while a digital relay is roughly resistive. This is accepted practice.
- **Not covered:** a VT equivalent circuit (actual ratio or phase error versus burden), ferroresonance, capacitor voltage transformers (IEC 61869-5, which the app has no model for), residual (open-delta) winding rating, and secondary lead or fuse drop.

The distance-relay scope note in the module docstring still stands: nothing in the app uses a PT secondary voltage.

**Behaviour change for saved projects.** Re-run the duty check. Every
relay-fed PT on a bus now gets a row, including PTs without a connected burden,
which used to be skipped. PTs on non-effectively earthed buses with no declared
voltage factor now warn.

Tests: `backend/tests/test_pt_model_review_fixes.py` (19).
`test_pt_duty_check.py::test_absent_connected_burden_not_checked` has been
re-baselined as `…_skips_burden_only`. It asserted that no row appeared at all,
which also hid the voltage checks.
