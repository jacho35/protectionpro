# ProtectionPro Verification — vs. standards / textbook / first-principles

Cross-checks of ProtectionPro's analysis engines — **32 of 40 analyses have an independent numerical reference,
8 are pinned by consistency tests only; see [Coverage](#coverage)** — against published standards (IEC 60909, 60364,
61660; IEEE 1584, 80), textbook worked examples (Glover load flow, Ammerman DC arc flash), published IEC/ETAP
figures, and exact first-principles / hand calculations. The short-circuit work began from the worked examples at
[powerprojectsindia.com](https://powerprojectsindia.com/); site survey of candidate examples:
[`reference/site-survey.md`](reference/site-survey.md). Survey of ETAP's official V&V PDF (found to be a
results-comparison doc that cites external sources for its inputs — not directly reproducible):
[`reference/etap-vv-pdf-survey.md`](reference/etap-vv-pdf-survey.md). Survey of the Tinghir 225/60/11 kV
substation E3S paper (real-project ETAP case study missing the branch-impedance inputs needed to reproduce):
[`reference/tinghir-e3s-paper-survey.md`](reference/tinghir-e3s-paper-survey.md).

| Area | Source | Engine | Result |
|---|---|---|---|
| Short-circuit (3 progressive cases) | [main article](https://powerprojectsindia.com/short-circuit-current-calculations-for-symmetrical-and-unsymmetrical-faults/) | `fault.py` | **12/12 PASS** ≤0.13 % |
| Short-circuit (220/33 kV, ETAP screenshots) | [SC-2 article](https://powerprojectsindia.com/short-circuit-calculation-symmetrical-and-asymmetrical-fault-current/) | `fault.py` | **4/4 PASS** 0.00 % (+ found a hand-calc error) |
| LV cable sizing (IEC 60364) | [cable article](https://powerprojectsindia.com/cable-sizing-calculation-low-voltage/) | `cable_sizing.py` | **Qualified** — formulas exact, integrated engine more conservative |
| Load flow (Newton-Raphson, 3-bus) | ESE 470 / Glover textbook example | `loadflow.py` | **PASS** — voltages/angles ≤0.002 pu / 0.04°, 4-iter convergence |
| Arc flash (IEEE 1584-2002) | Standards hand-calc (Eq. 1–5) | `arcflash.py` | **PASS** — Iₐ/E/AFB exact (0.000 %), LV + MV |
| Grounding (IEEE 80) | Standards hand-calc (square grid + rods) | `grounding_system.py` | **PASS** — all quantities exact, incl. mesh voltage (full Eq. 84–88 n / K_ii / L_M) |
| Earth grids of any shape (numerical) | IEEE 80-2013 Annex H benchmarks (CDEGS / ETAP / WinIGS, Grids 1–6 incl. diagonals and a separately earthed fence) + closed forms | `earth_grid.py` | **PASS** — R_g and touch inside the programs' spread or within 2.5 %, step within 5 %; rod / wire closed forms 0.1 % ([`earth-grid-validation/validate.py`](earth-grid-validation/validate.py), `EARTH_GRID_METHOD.md` §8) |
| Motor starting (voltage dip) | Standards hand-calc + independent 2-bus solve | `motor_starting.py` | **PASS** — FLC / starting current (5 methods) / dip exact; constant-PQ model characterized |
| DC load flow | First-principles resistive circuit | `dc_loadflow.py` | **PASS** — voltages / currents / losses exact (≤0.005 %) |
| DC short circuit (IEC 61660-1) | Published IEC 61660 battery example | `dc_shortcircuit.py` | **PASS** — reproduces the published 5422 A peak exactly from raw nameplate (full 0.9·R_B / 1.05·U_nB / +0.1·R_B factors) |
| Equipment duty check | Hand-calc over verified fault engine | `duty_check.py` | **PASS** — peak / making / breaking-duty comparisons exact |
| Load diversity | Exact demand-aggregation hand-calc | `load_diversity.py` | **PASS** — demand factors, IEC Ks, diversified demand exact |
| DC arc flash (Stokes & Oppenlander) | Published Ammerman/CED DC method | `dc_arcflash.py` | **PASS** — arc operating point + incident energy exact (≤0.06 %) |
| Unbalanced load flow (symmetrical comp.) | Independent phase-domain solve + balanced limit | `unbalanced_loadflow.py` | **PASS** — phase voltages & VUF match a phase-domain (Zabc) solve exactly; balanced limit |

- **Plan & decisions:** [`PLAN.md`](PLAN.md)
- **Main SC reference data:** [`reference/etap-golden-values.md`](reference/etap-golden-values.md)
- **Per-case working:** [`case-1-noload/`](case-1-noload/results.md) · [`case-2-motor/`](case-2-motor/results.md) · [`case-3-motor-lump/`](case-3-motor-lump/results.md) · [`case-sc2-220-33kv/`](case-sc2-220-33kv/results.md) · [`case-cable-sizing-lv/`](case-cable-sizing-lv/results.md) · [`case-loadflow-3bus/`](case-loadflow-3bus/results.md) · [`case-arcflash-ieee1584/`](case-arcflash-ieee1584/results.md) · [`case-grounding-ieee80/`](case-grounding-ieee80/results.md) · [`case-motor-starting/`](case-motor-starting/results.md) · [`case-dc-loadflow/`](case-dc-loadflow/results.md) · [`case-dc-shortcircuit/`](case-dc-shortcircuit/results.md) · [`case-duty-check/`](case-duty-check/results.md) · [`case-load-diversity/`](case-load-diversity/results.md) · [`case-dc-arcflash/`](case-dc-arcflash/results.md) · [`case-unbalanced-loadflow/`](case-unbalanced-loadflow/results.md)

## Method
Each example is rebuilt as a reproducible ProtectionPro project (`case-*/project.json`) and solved two ways
that agree to within display rounding: (1) direct calls to the `backend/analysis/*` engine (authoritative),
and (2) the **real app UI driven headlessly** — the screenshots in each `case-*/screenshots/` folder are
genuine renders. **Match tolerance: ±2 %.** The IEC 60909 voltage factor `c` is set to whatever each
article's reference used (main article: c = 1.0; SC-2: c = 1.10, the app default).

## Scorecard — short circuit: 16 / 16 PASS

### Main article (c = 1.0 to match its ETAP screenshots)
| Case | 3-phase | SLG | LL | LLG |
|---|---|---|---|---|
| 1 — no load (Bus4) | 0.00 % | −0.01 % | 0.00 % | 0.00 % |
| 2 — motor (Bus7) | −0.09 % | −0.06 % | −0.08 % | −0.03 % |
| 3 — motor + lump (Bus5) | −0.13 % | −0.07 % | −0.13 % | −0.03 % |

### SC-2 — 220/33 kV, 10 MVA Dyn1 (c = 1.10 to match its ETAP screenshots)
| Fault | ETAP (kA) | ProtectionPro (kA) | Error |
|---|---|---|---|
| 3-phase | 2.296 | 2.296 | 0.00 % ✅ |
| SLG | 2.302 | 2.302 | 0.00 % ✅ |
| LL | 1.988 | 1.988 | 0.00 % ✅ |
| LLG | 2.309 | 2.309 | 0.00 % ✅ |

Worst-case short-circuit error **0.13 %**, well inside ±2 %. Impedances match to 5 sig-figs including the
IEC 60909 transformer K_T correction and the motor sub-transient split.

## Cable sizing (IEC 60364) — qualified match
The engine's **voltage-drop and adiabatic fault-withstand formulas reproduce the article exactly**
(running VD per-amp to 0.3 %; bare adiabatic 40 kA·√0.1/143 = 88.455 mm² to the digit). Its *final* numbers
differ by **documented methodology, not defects**: it is network-integrated (current from load flow, fault
from fault analysis) and more conservative (sizes for the IEC 60909-0 §12 thermal-equivalent current
I_th = Ik″·√(m+n), not bare Isc). Full detail: [`case-cable-sizing-lv/results.md`](case-cable-sizing-lv/results.md).

## Load flow (Newton-Raphson) — PASS
First verification of `loadflow.py`, against a self-contained textbook example (Glover/ESE 470 3-bus: slack at 1.0 pu,
one PV, one PQ, charging-free lines). ProtectionPro reproduces the published solution essentially exactly — V₂ = 1.0500∠−2.06°
(ref 1.05∠−2.1°), V₃ = 0.9782∠−8.78° (ref 0.98∠−8.8°), slack 308.35 MW/−81.66 Mvar (ref 308/−82), same 4-iteration
convergence. Full detail: [`case-loadflow-3bus/results.md`](case-loadflow-3bus/results.md).

## Arc flash (IEEE 1584-2002) — PASS
First verification of `arcflash.py`. No clean public **2002** worked example exists (current material is 2018), so
this uses a standards-anchored hand calculation (the project's own V&V method). The app reproduces the IEEE
1584-2002 arcing-current (Eq. 1 & 2), incident-energy (Eq. 3–5) and arc-flash-boundary results **exactly (0.000 %)**
for both a 480 V MCC and a 4.16 kV switchgear case, and end-to-end in the real app (E = 12.82 cal/cm², PPE Cat 3,
AFB 1.93 m). Full detail: [`case-arcflash-ieee1584/results.md`](case-arcflash-ieee1584/results.md).

## Grounding (IEEE 80) — PASS
First verification of `grounding_system.py`, via a standards-anchored hand calculation on a square grid with
rods. The app reproduces the IEEE 80 tolerable touch/step voltages, surface derating C_s, grid resistance R_g
(Sverak Eq. 57), GPR, K_m/K_s/K_i, step voltage, decrement factor, and conductor sizing **exactly (0.000 %)**,
end-to-end in the real app. The previously-conservative **mesh (touch) voltage is now exact too** — the full
IEEE 80 Eq. 84–88 effective number of conductors `n = n_a·n_b·n_c·n_d`, corrective factor `K_ii` (with the
no-rods `1/(2n)^(2/n)` branch) and rod-weighted effective length `L_M` are implemented, so the mesh voltage
drops from the old +5.7 % (792 V) to the exact 749 V, and rectangular / no-rods geometries are correct. Full
detail: [`case-grounding-ieee80/results.md`](case-grounding-ieee80/results.md).

**2026-09-30 review** (`GROUNDING_REVIEW.md`): uniform soil re-checked against the IEEE 80-2013 Annex B
Examples 1 and 2 (≤ 0.4 %). Two-layer soil now has an independent reference, a method-of-moments solve of
the grid with the exact two-layer image Green's functions (`grounding-review/v3_grid_bem.py`); the engine's
R_g ratio matches it within 1 % and E_m within +6 % (conservative). The grid current's local/remote split is
checked against a hand zero-sequence current division (0.846 vs 0.845).

## Motor starting (voltage dip) — PASS
First verification of `motor_starting.py`. Full-load current, starting current for all five starting methods
(DOL / star-delta / autotransformer / soft-starter / VFD), and starting MVA match hand calculations **exactly**;
the voltage dip **exactly** reproduces an independent solve of the engine's constant-PQ 2-bus model (0.01 %,
terminal V 0.778 pu / 20.92 % dip). The constant-PQ rotor model converges with the textbook constant-Z divider
and SC-MVA-ratio methods for normal dips and is deliberately conservative for weak systems. Full detail:
[`case-motor-starting/results.md`](case-motor-starting/results.md).

## DC engines — PASS
First cross-check of the DC engines against a worked example. **DC load flow** reproduces an exact
first-principles resistive-circuit solution to ≤0.005 % (bus voltages, cable currents, losses). **DC short
circuit** now reproduces the published IEC 61660-1 battery peak **exactly (0.00 %) from raw nameplate inputs** —
the full standard factors are applied internally (E_B = 1.05·U_nB or an explicit `emf_v`, peak
i_p = E_B/(0.9·R_B + R_net), quasi-steady I_k = 0.95·E_B/(R_B + R_net), T_B = 30 ms rise-time when the branch
inductance is unknown), and the converter current-limit is exact. Detail:
[`case-dc-loadflow/results.md`](case-dc-loadflow/results.md) · [`case-dc-shortcircuit/results.md`](case-dc-shortcircuit/results.md).

## Duty check, load diversity, DC arc flash, unbalanced LF — PASS
- **Equipment duty check** — peak (κ·√2·I″k), making capacity (2.5·Icu MV / IEC 60947-2 LV), breaking duty (Ib)
  and pass/fail comparisons reproduce hand calculations exactly, on top of the verified fault engine.
- **Load diversity** — per-load demand factors, IEC group coincidence factor Ks, diversified demand, effective
  demand factor and demand current all exact.
- **DC arc flash** — the Stokes & Oppenlander arc operating point and the spherical incident-energy / boundary
  reproduce the published Ammerman/CED DC method exactly (≤0.06 %, calorie rounding).
- **Unbalanced load flow** — phase voltages and VUF match an independent phase-domain solve (Zabc =
  A·diag(Z0,Z1,Z2)·A⁻¹, load currents iterated at the actual phase voltages) exactly, and it collapses to the
  balanced solution when balanced. Before 2026-09-28 a single-pass solve understated this case's VUF by ~5 %
  (0.76 vs 0.80 %). (A full IEEE 13-bus abc-frame match is out of scope for this sequence-based engine.)

Detail: [`case-duty-check/`](case-duty-check/results.md) · [`case-load-diversity/`](case-load-diversity/results.md) · [`case-dc-arcflash/`](case-dc-arcflash/results.md) · [`case-unbalanced-loadflow/`](case-unbalanced-loadflow/results.md).

## Discrepancy register
| # | Item | Type | Status |
|---|---|---|---|
| 1 | Main article's ETAP uses c = 1.0; SC-2's uses c = 1.10 | Convention | **Resolved** — `c` is configurable (Settings → *Voltage Factor c*); each case run at its article's c. |
| 2 | Case-3 `static_load` contributes no fault current → under-predicts 9–29 % | Modeling convention | **Qualified** — model back-feeding loads as induction-motor equivalents (per IEC 60909). Backlog item raised. |
| 3 | **SC-2 article's own hand-calc is ~15 % low** (mixes 100 MVA-base grid + 10 MVA-base transformer) | **Error in the source** | ProtectionPro & ETAP both compute correctly and agree exactly; the app exposes the tutorial's base-mixing mistake. |
| 4 | Cable sizing: engine uses thermal-equivalent I_th (43.3 kA) vs article's bare Isc (40 kA); derives area from R; current from load flow | Methodology (more rigorous) | **Qualified** — formulas verified; backlog item to allow direct Isc/clearing-time entry for standalone checks. |
| 5 | Motor X/R: SC SLD annotates 35 / cable article implies 10.8 | Source ambiguity | **Noted** — used the value each article's math implies. |
| 6 | PV-bus generator badge shows *scheduled* reactive (capped at MVA rating), not the solver-computed PV reactive | Cosmetic reporting | **Qualified** — solution unaffected (V held, slack Q matches). Backlog item raised. |
| 7 | Arc flash: conductor gap auto-selected from voltage (LV fixed at 25 mm MCC/panel) — cannot model LV switchgear (32 mm) | Modelling limitation | **Qualified** — equations exact; backlog item to expose gap / equipment class per bus. |
| 8 | Grounding: mesh voltage uses simplified L_M = L_c + L_rod (omits IEEE 80 Eq. 88 rod weighting); `n = max(n_x,n_y)` (square only); `K_ii = 1.0` (rods only) | Modelling simplification | **Resolved** — full IEEE 80 Eq. 84–88 `n = n_a·n_b·n_c·n_d`, `K_ii` (no-rods `1/(2n)^(2/n)`) and rod-weighted `L_M` implemented; mesh voltage now exact (792 → 749 V) and rectangular/no-rods grids correct. |
| 9 | DC short circuit: simplified IEC 61660-1 battery omits 0.9·R_B (peak), 1.05·U_nB (EMF), +0.1·R_B (I_k), T_B (τ) | Modelling simplification | **Resolved** — factors applied to raw nameplate: E_B = 1.05·U_nB (or explicit `emf_v`), i_p = E_B/(0.9·R_B + R_net), I_k = 0.95·E_B/(R_B + R_net), T_B = 30 ms. Published 5422 A peak now reproduced exactly from nameplate. |

## App changes made during verification
- **Backend:** `fault.py`/`schemas.py`/`routes/analysis.py` — IEC 60909 voltage factor `c` is a request/project parameter (`voltageFactor`, default 1.10; transformer K_T keeps its internal c_max = 1.10). 127 backend regression tests pass.
- **Frontend:** Settings → System Base gains a **Voltage Factor c** control, persisted in the project and flowed into fault analysis.

## Verdict
- **Short circuit** — across **two independent articles** (four networks, 16 fault calculations) the fault engine
  reproduces the references to **≤0.13 %**, and on SC-2 it matches ETAP exactly while exposing an arithmetic error
  in the published hand-calc.
- **Cable sizing** — the IEC 60364 formulas reproduce exactly; the integrated engine differs from the simplified
  hand-calc only in well-understood, more-conservative modeling choices.
- **Load flow** — Newton-Raphson reproduces a textbook 3-bus solution essentially exactly (≤0.002 pu / 0.04°).
- **Arc flash** — IEEE 1584-2002 arcing-current, incident-energy and boundary equations reproduce hand calculations exactly (0.000 %) across LV and MV.
- **Grounding** — IEEE 80 tolerable voltages, grid resistance, GPR, geometric factors, step voltage, decrement factor, conductor sizing **and mesh voltage** reproduce hand calculations exactly (full Eq. 84–88 n / K_ii / L_M).
- **Motor starting** — full-load & starting current (all methods) and voltage dip reproduce hand calculations / an independent 2-bus solve exactly; the constant-PQ rotor model is conservative for weak systems.
- **DC load flow** — bus voltages, cable currents and losses reproduce an exact resistive-circuit solution (≤0.005 %).
- **DC short circuit** — the IEC 61660-1 battery peak reproduces the published example **exactly from raw nameplate** (full 0.9·R_B / 1.05·U_nB / +0.1·R_B / T_B factors), and the converter current-limit is exact.
- **Duty check / load diversity / DC arc flash / unbalanced LF** — all reproduce their governing formulas (κ·√2·I″k & making capacity; IEC demand factors & Ks; Stokes & Oppenlander + spherical incident energy; symmetrical-component transform & VUF) exactly.

## Surveyed but not reproducible (recorded, not verified)
- ETAP official V&V PDF — results-comparison doc, inputs cited to external sources: [`reference/etap-vv-pdf-survey.md`](reference/etap-vv-pdf-survey.md).
- Tinghir 225/60/11 kV E3S paper — real-project case study missing branch impedances: [`reference/tinghir-e3s-paper-survey.md`](reference/tinghir-e3s-paper-survey.md).

## Coverage

One table for every analysis the app runs (the Study Manager only orchestrates these and is not counted). The same
list is in the in-app report (`frontend/verification.html#coverage`) — keep the two in step.

**Independent reference** = the expected number was produced without the engine (published example, the standard's
equations worked by hand, or an independent closed-form solve). **Consistency only** = tests pin behaviour
(direction of change, limiting cases, agreement with another verified engine) but no independent number.

| Analysis | Engine | Reference | Where |
|---|---|---|---|
| Short circuit (4 networks, 16 points) | `fault.py` | IEC 60909 — powerprojectsindia / ETAP | case-1/2/3, case-sc2 + template |
| LV cable sizing | `cable_sizing.py` | IEC 60364 article (qualified) | case-cable-sizing-lv + template |
| Load flow (NR) | `loadflow.py` | Glover / ESE 470 3-bus | case-loadflow-3bus + template |
| Unbalanced load flow | `unbalanced_loadflow.py` | Independent phase-domain solve (Zabc = A·diag(Z0,Z1,Z2)·A⁻¹) — exact; balanced limit | case-unbalanced-loadflow + template + `test_unbalanced_lf_sequence_iteration.py` |
| Arc flash, IEEE 1584-2002 | `arcflash.py` | Standard Eq. 1–5 hand calc | case-arcflash-ieee1584 + template |
| Arc flash, IEEE 1584-2018 | `arcflash.py` | Official IEEE validation spreadsheet (6 fixtures) | `TestArcFlash2018` |
| Grounding | `grounding_system.py` | IEEE 80 hand calc | case-grounding-ieee80 + template |
| Earth grids of any shape | `earth_grid.py`, `earth_grid_study.py` | IEEE 80-2013 Annex H (CDEGS / ETAP / WinIGS) + Dwight / Sunde closed forms; EN 50522 Table B.4 | `test_earth_grid.py`, `earth-grid-validation/validate.py` |
| Motor starting | `motor_starting.py` | Hand calc + independent 2-bus solve | case-motor-starting + template |
| Duty check | `duty_check.py` | κ·√2·I″k / making / breaking hand calc | case-duty-check + template |
| Load diversity | `load_diversity.py` | Demand-aggregation hand calc | case-load-diversity + template |
| DC load flow | `dc_loadflow.py` | Exact resistive circuit | case-dc-loadflow + template |
| DC short circuit | `dc_shortcircuit.py` | IEC 61660-1 published example | case-dc-shortcircuit + template |
| DC arc flash | `dc_arcflash.py` | Ammerman / CED published method | case-dc-arcflash + template |
| Transient stability | `transient_stability.py` | Equal-area CCT | `TestTransientStabilitySMIB` |
| Voltage stability | `voltage_stability.py` | Closed-form P-V nose | `TestVoltageStabilityNose` + harness |
| Contingency | `contingency.py` | Independent 2-bus solve | `TestContingencyWorkedExample` + harness |
| Dynamic motor starting | `dynamic_motor_starting.py` | Chapman / IEEE 3002.7 hand calc | `TestDynamicMotorStarting`, `test_dynamic_motor_starting.py` |
| ANSI fault duty | `fault_ansi.py` | C37.010-1979 worked examples | `TestAnsiFaultDuty` |
| Frequency scan | `frequency_scan.py` | Closed-form resonance | harness |
| Filter sizing | `filter_sizing.py` | Closed-form tuning | harness |
| Reliability | `reliability.py` | Hand FMEA (IEEE 1366) | harness |
| Hosting capacity | `hosting_capacity.py` | Exact 2-bus voltage rise | harness |
| CT saturation model | `ct_model.py` | IEC 61869-2 knee / clip | harness |
| Battery sizing | `battery_sizing.py` | IEEE 485 energy method | harness |
| Capacitor placement | `capacitor_placement.py` | Closed-form loss drop (5.3 % discrete-bank residual) | harness |
| Optimal power flow | `optimal_powerflow.py` | Merit-order dispatch + cost hand calc | harness + `TestOptimalPowerFlow` |
| Flicker | `flicker.py` | IEC 61000-3-3 Pst curve | harness |
| Lightning risk | `lightning_risk.py` | IEC 62305-2 Eq. A.2 / A.4, R1 hand calc | `TestLightningRisk` |
| Raceway | `raceway.py` | NEC fill, IEC 60364-5-52 B.52.17 hand calc | `TestRaceway` |
| Backup autonomy | `backup_autonomy.py` | Usable-energy hand calc | `TestBackupAutonomy` |
| DB circuit check | `db_circuit_check.py` | IEC 60364-5-52 table values, VD / Zs hand calc | `test_db_circuit_check.py` |
| *Consistency only* | | | |
| Harmonic penetration | `harmonics.py` | Trends + IEEE 519 limit tables | `TestHarmonics` |
| SVC / STATCOM | `loadflow.py` | Set-point hold, Q clamp, Q ∝ V² | `TestSVC` |
| Autotransformer & OLTC | `loadflow.py` | Regulation direction, clamping, star identity | `TestAutotransformer`, `TestTransformerOLTC` |
| Time-series load flow | `timeseries_loadflow.py` | Flat profile = single-shot LF, SoC conservation | `test_timeseries_loadflow.py` |
| Load Flow Study Manager | `loadflow_cases.py` | Current case = direct LF | `test_loadflow_cases.py` |
| Series & simultaneous faults | `fault.py` | Sequence identities, decoupled limits | `TestOpenConductor`, `TestTwoConductorOpen`, `TestSimultaneousFault` |
| Wenner interpretation | `grounding_system.py` | Recovers its own forward model | `TestGrounding` (Wenner) |
| ADMD | `admd.py` | Source-app formulas as ported | `TestADMD` |

"case-… + template" rows are also in-app templates; `backend/tests/test_verification_templates.py` re-runs every
template through its analysis route in CI and asserts the headline numbers (the single source for those numbers is
`EXPECTED` in `build_verification_templates.py`). "harness" = `case-new-features-verification/verify_new_features.py`,
also run in CI. The UI channel is automated too: `testing/ui/verify_templates_ui.mjs` loads every template through
Project → Templates in headless Chromium, runs its study from the Analyse menu and asserts the same numbers on the
result stored for the diagram badges (CI job `ui-templates`). The `case-*/screenshots/` are the July 2026 archive.

The two previously qualified items (grounding mesh voltage, DC-SC battery factors) are **resolved**. The only
remaining refinement for the case set is a full IEEE 13-bus abc-frame unbalanced comparison — out of scope for the
simplified sequence-based engine and non-blocking.
