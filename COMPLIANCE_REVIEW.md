# Compliance Report Review

*Review date 2026-09-29. Method per `ENGINE_REVIEW_METHODOLOGY.md`. Checked
against IEC 60364-4-41 (§411.3.2, Table 41.1, §411.4.5, §411.5.3, §411.6),
IEC 60364-4-43 (§433.1, §434.5.2, §435.1, Table 43A), IEC 60909-0 (§5.3.1
minimum currents, §12 thermal equivalent current), IEC 60076-1 (vector-group
notation), IEC 62271-1 / IEC 60038 (Ur ≥ Um), IEC 60898-1 / IEC 60947-2
(conventional currents, magnetic bands) and SANS 10142-1. Findings C1–C9 and
lesser notes L1–L5 are all fixed.*

Scope: `frontend/js/compliance.js`, meaning every rule in the Compliance
Report and the on-diagram device-rating flags (`deviceRatingFlags`). The
engines it reads (fault, load flow, DB circuit check) and the trip curves it
calls (`cbTripTime`, `fuseTripTime`) were reviewed separately.

Evidence: `testing/compliance-review/`.
- `build_fault.py` builds the LV test network. It runs the real fault engine
  at maximum and minimum (c_min = 0.95, 70 °C) conditions, and the Cable
  Sizing study on the same network for parity. Run it from the repo root in
  the backend image with `PYTHONPATH=/work`.
- `v1_core.mjs` loads the real `constants.js` and `compliance.js` into a Node
  vm (`harness.mjs`) and prints predicted results next to the engine's.

The test network:

    Grid 11 kV 250 MVA → 1 MVA Dyn11 11/0.42 kV → MSB 0.4 kV
    MSB → 160 A MCCB (Ir 160 A, 10×) → 35 mm² Cu/PVC 200 m → DB-1
    DB-1 → 32 A type-C MCB → 4 mm² Cu/PVC 60 m → Sockets

| Bus | Ik3 max | Ik1 max | Ik3 min | Ik1 min |
|---|---|---|---|---|
| MSB | 26.12 kA | 26.83 kA | 22.81 kA | 23.35 kA |
| DB-1 | 2.33 kA | 1.42 kA | 1.69 kA | 1.03 kA |
| Sockets | 0.66 kA | 0.40 kA | 0.48 kA | 0.29 kA |

## 1. What held up

| Checked | Result |
|---|---|
| Table 41.1 TN times keyed on U0 with a ±10 % band (230 V → 0.4 s, 400 V → 0.2 s) | correct |
| §411.3.2.2 scope (socket finals ≤ 63 A, fixed ≤ 32 A) and §411.3.2.3 5 s for distribution circuits | correct |
| Disconnection on the minimum-current study, and a per-path fallback refused rather than passed ([PS-3]) | sound |
| Breaking basis: largest phase current of any fault type; Ib only for MV breakers (mirrors `duty_check.py` [DU1]/[DU2]) | correct in the report |
| Making factors: IEC 62271-100 2.5× / 2.6×; IEC 60947-2 Table 2 n stepped by Icu (as `duty_check.py`) | correct |
| LV voltage band ±10 % (IEC 60038) | correct |
| TT R_A·IΔn ≤ 50 V; no RCD on a TN-C PEN; IMD on IT | correct formulas (the inputs were wrong — see C4) |
| Motor FLC = P/(√3·U·η·pf); star-delta ⅓ LRC, autotransformer 0.64 (80 % tap) | correct |
| PV strings: Voc at T_min, Vmp at the hottest cell temperature, 1.25·Isc per MPPT | correct |
| Adiabatic form t ≤ (kS/I)²; k = 143/115/94/76 up to 300 mm² | correct |

## 2. Findings (marked `[Cn]` in code)

| # | Defect | Evidence → fix |
|---|---|---|
| C1 | **Non-conservative.** Earth-fault disconnection was judged at the bus the device sits on. The report looped over buses and evaluated every CB/fuse on a bus at that bus's Ik1. For an outgoing feeder, that bus is the supply end of the circuit, where the device always trips instantly. The circuit's far end, which IEC 60364-4-41 requires, was never looked at. | The socket MCB passed at DB-1's 1026 A (0.02 s). At the far end the minimum-study current is 287 A, the MCB takes 1.98 s, and the limit is 0.4 s. The 160 A sub-main MCCB passed at the MSB's 23 kA; at DB-1 it takes 8.7 s against a 5 s limit. The Sockets bus got a "no protection device" warning. **Fix:** each device is judged at the lowest minimum-study Ik1 on the load side of its own circuit. That circuit runs through its cable and non-protective series devices, and includes bus-less load terminals (`__term__`). A breaker's earth-fault release counts. The device is now named in the report. |
| C2 | **Non-conservative.** Cable withstand was checked only at the far end's I″k3 from the **maximum** study. That misses both limits of §434.5.2: the largest current (any fault type, at the source end) and the smallest (far end, minimum study, where a time-inverse device is slowest). The thermal-equivalent Ith was also ignored, devices at the load end were credited, and PVC above 300 mm² used 115/76. | The 35 mm² sub-main passed ("withstand 2.98 s"). The source-end I″kLLG is 27.6 kA, which gives Ith = I·√(m+1) and a withstand of 0.010 s against a 0.020 s clearing time. A 2.5 mm² socket run passed at 662 A; at the far-end minimum of 287 A the MCB takes 1.98 s against a withstand of 1.0 s. **Fix:** the same two-basis check as the reviewed Cable Sizing study ([CS2]/[CS5]). Only the supply-side device counts. The §435.1 exemption applies when that device gives §433.1 overload protection. k follows Table 43A, including 103/68 above 300 mm². |
| C3 | §433.1 checked In ≤ Iz only. **Non-conservative for fuses:** gG I2 = 1.6 In, so a fuse needs In ≤ 0.91·Iz. Two false fails as well: In was the breaker's frame `rated_current_a` rather than its setting Ir, and Iz ignored parallel runs. | A 100 A gG fuse on Iz 105 A passed, but I2 = 160 A > 1.45·Iz = 152 A. A 250 A-frame MCCB set to 100 A failed on "250 A > 105 A". 2 × 250 A runs on 400 A failed. **Fix:** In ≤ Iz and I2 ≤ 1.45·Iz, with In = Ir and I2 per IEC 60898-1 / 60947-2 / 60269 (as `cable_sizing._overload_device`), and Iz = rated_amps × parallel runs. |
| C4 | **Non-conservative.** Earthing was project-wide. A single TT or IT source anywhere switched the TN disconnection check off for every bus. "RCD present" meant anywhere in the project. IΔn read board ratings only, and took 300 mA for a breaker earth-fault release. | With a TN MSB and a TT transformer elsewhere, the two TN failures in C1 vanished behind "assessed per earthing system". A TT source with R_A = 20 Ω and a 5 A earth-fault release (100 V) passed as 20 Ω × 300 mA = 6 V. **Fix:** each LV source now has its own zone: everything reachable without crossing a transformer or entering an MV bus. The TN criterion applies per circuit. The TT and TN-C checks see only the residual devices in their own zone, and a release's pickup counts as IΔn. |
| C5 | **Non-conservative.** The vector group was lower-cased before looking for "yn", so the HV "YN" of a YNd11 read as an earthed LV neutral. In IEC 60076-1 notation, capitals are the HV winding. Also, a Dy11 with its LV neutral solidly earthed, which the fault engine treats as earthed, got "earthed via impedance (solidly grounded)". | YNd11 (LV delta) on a declared TN-S system: PASS "LV neutral solidly earthed". **Fix:** the LV winding comes from the lower-case part. Delta means no neutral (a warning if TN/TT is declared). For a star winding, `grounding_lv` decides, as in `fault._transformer_zero_seq`. |
| C6 | The maximum-demand check was dead. It read `p_mw`, `rated_mw` and `rated_mva`, none of which any load has (loads carry `rated_kva` or `rated_kw`), so it summed zero and emitted nothing. | 60 kVA + 37 kW motor (106.7 kVA) on 100 kVA gave no result at all. **Fix:** nameplate kVA × demand factor (induction motors at input kVA), P and Q summed as vectors, compared with the LV transformer capacity. It no longer needs a load flow. |
| C7 | MV rated voltage was compared with the nominal voltage, not Um. | An 11 kV-rated breaker on an 11 kV bus passed. IEC 62271-1 requires Ur ≥ Um = 12 kV. **Fix:** as the Duty Check's [L1]: below nominal fails, between nominal and Um warns. |
| C8 | **Non-conservative.** The on-diagram breaking flag compared Icu with I″k3 only, while the report used the largest phase current ([DU1]). | Icu 26.5 kA at the MSB: the report failed it (Ik1 26.8 kA) but the diagram showed nothing (Ik3 26.1 kA). **Fix:** the same basis as the report. |
| C9 | A transformer branch reports its LV-side current. A breaker on the HV side was compared with it. | A 630 A 11 kV breaker feeding a 1 MVA transformer (52 A) failed on "1443 A exceeds 630 A". **Fix:** a device whose voltage differs from the LV winding gets S/(√3·U_device). |

## 3. Lesser notes (marked `[Ln]`)

| # | Note | Fix |
|---|---|---|
| L1 | "No Swing (slack) bus defined" warned on every project without a bus labelled Swing, but the load flow picks each island's slack from its sources | Now warns only when there is no source |
| L2 | The minimum-size check read `props.size_mm2`, which a library pick does not write, so it skipped every library cable | Size from the library entry, then the ampacity block, then props |
| L3 | Earthing-system details cited "IEC 60364-1 §411.5/§411.6"; §411 is in part 4-41 | Now IEC 60364-4-41 §411.4.5 / §411.5.3 / §411.6 |
| L4 | The motor starting-current warning used the top of the magnetic band (C: 10·In), where tripping is certain; the breaker is only guaranteed to hold below the bottom (C: 5·In) | Now IEC 60898-1 B 3×, C 5×, D 10× In, and IEC 60947-2 instantaneous setting −20 % |
| L5 | Validation findings showed "—" as the component: `validate()` returns `compId`, the report read `id` | Reads `compId`, shows the name |

Relay-tripped breakers are no longer evaluated on the breaker's own
(default 630 A MCCB) trip unit, which gave a spurious 20 ms pass. The report
now points to the Cable Sizing study and the TCC, which evaluate the relay
through its CT.

## 4. Cross-module notes (not changed here)

- **Cable Sizing's far-end minimum ignores hot conductors.**
  `cable_sizing._min_fault` runs the fault study at c_min but at 20 °C. The
  compliance minimum study (`app.js`) uses 70 °C per IEC 60909-0 §5.3.1. On
  the test network the far end of the sub-main is 1222 A there and 1026 A
  here. The Cable Sizing figure is optimistic. It is a one-line change
  (`conductor_temperature_c=70`), but it moves reviewed results, so it is
  left for a follow-up.
- **Magnetic clearing time.** The frontend curves take 20 ms in the
  instantaneous region; the backend takes 50 ms (`arcflash._cb_self_clearing_time`).
  Near the limit the two studies can disagree: for the 4 mm² socket run,
  Cable Sizing fails it at 50 ms and compliance passes it at 20 ms. A
  current-limiting MCB clears in well under 10 ms, so 20 ms is not
  optimistic for an MCB. For an ACB, 50 ms is closer.

Observations, left unchanged:
- NRS 048-2 may set ±5 % rather than ±10 % from 500 V (525 V and 690 V
  systems). The LV band is applied up to 1 kV. Check against a licensed copy.
- No minimum cross-section for aluminium (IEC 60364-5-52 Table 52.2).
- ELV circuits (U0 ≤ 50 V) are not excluded from Table 41.1. The IT second
  fault is not checked. An RCD on a TN circuit is not credited as the
  disconnection means, which is conservative. U0 is V/√3 of the bus
  voltage, so a single-phase bus drawn at 220 V reads 127 V (0.8 s instead
  of 0.4 s).
- aM fuses are timed on the gG curve. They give no overload protection, so
  the §433.1 row is optimistic for them.
- **Not covered:** the fault-duty and making rows beyond the duty-check
  mirror, the PV and thermal-loading rows beyond their formulas, and the
  PDF/HTML rendering.

**Behaviour change for saved projects.** Re-open the Compliance Report. The
report is generated when opened, so nothing stale persists, but expect:
- earth-fault rows now under the device name, judged at the far end, with
  new failures on long final circuits and sub-mains;
- withstand rows at both current bases;
- new I2 failures for fuses, and fewer false failures for adjustable
  breakers and parallel runs;
- TT verdicts per installation;
- a maximum-demand row for the first time.

Tests: `frontend/tests/test_compliance.mjs` (35 assertions, in CI as
"Compliance rules"). Every finding's assertion fails on the pre-review
`compliance.js`.
