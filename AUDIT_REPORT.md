# ProtectionPro — Consolidated Engineering & UX Audit Report

**Date:** 2026-06-11
**Status:** Final — synthesized and spot-verified by lead reviewer

## Scope & Methodology

Three-agent review of the full application:

1. **Electrical engineering audit** — (a) all backend analysis engines (`backend/analysis/`: fault, load flow, unbalanced load flow, arc flash, cable sizing, motor starting, duty check, grounding, load diversity) plus routes/schemas; (b) frontend protection engineering (`tcc.js`, `compliance.js`, curve math in `constants.js`); (c) component data (`constants.js` libraries and defaults, `properties.js` editor, `components.js` graph validation), including the current uncommitted diff.
2. **UX/operability audit** — full read of `index.html`, all CSS, and all frontend JS modules.
3. **Software lead synthesis** (this report) — every Critical finding and the most consequential High findings were independently re-verified against the source before endorsement. Duplicated findings across specialist reports were reconciled. Severity definitions used consistently:

- **Critical** — wrong results that endanger safety, or silent corruption/loss of user data.
- **High** — materially wrong results or a broken core workflow.
- **Medium** — degraded accuracy or usability.
- **Low** — polish, dead code, documentation mismatch.

Verification labels: **[VERIFIED]** = lead reviewer confirmed against source (and, where applicable, by hand calculation); **[ENDORSED]** = specialist derivation reviewed and found sound, not independently re-executed.

---

## Executive Summary

ProtectionPro's foundations are genuinely strong: the IEC 60909 fault-current algebra (κ, μ factors, sequence networks, transformer vector-group Z0 topology), the Newton-Raphson load flow (Jacobian, tap model, transparent-element collapsing), the IEC 60255-151/IEEE C37.112 curve constants, and the per-unit display math all check out against the standards. The "View Calculations" step-by-step derivation modal is better than most commercial tools.

However, the audit found **eight Critical defects**. Four are calculation bugs that produce *non-conservative* (unsafe-side) results in exactly the studies engineers rely on for personnel safety: arc flash incident energy is understated 33% on every LV bus (the reversed Cf factor); single-line-to-ground fault currents are understated ~40% by a spurious ×3 on source zero-sequence impedance (which also poisons the grounding study inputs); grounding conductor sizing is off by ~×506 due to a unit error; and motor-starting voltage dips are understated ~3×. Two more Criticals are silent no-ops in the frontend protection engineering: the compliance engine's connectivity walker reads wire fields that don't exist, so most standards cross-checks never actually run while the report looks plausible; and the TCC coordination/auto-grading engines skip transformer voltage referral, so any cross-transformer grading check or auto-set TDS is wrong. The final two Criticals are data-integrity defects: the undo stack survives project loads (Ctrl+Z can resurrect Project A into Project B and a save then overwrites B), and opening a project or closing the tab discards unsaved work without warning.

All eight Criticals were verified in source by the lead reviewer; none of the specialists' Critical claims failed verification. Most fixes are small and surgical (several are one-liners). The single most important process recommendation: **there are zero automated tests, and every Critical calculation bug is detectable with a ten-line regression test against a standards worked example.** A regression suite should land before any further engine changes.

---

## Critical Findings

### C1. Arc flash: voltage factor Cf is reversed — LV incident energy understated 33% **[VERIFIED]**
- **File:** `backend/analysis/arcflash.py:221` — `cf = 1.0 if voc_kv < 1.0 else 1.5`
- **Issue:** IEEE 1584-2002 Eq. 6 specifies Cf = 1.5 for ≤ 1 kV and Cf = 1.0 for > 1 kV. The code has it backwards.
- **Impact:** Every LV bus — where most arc flash injuries occur — gets incident energy understated by 33%; workers can be assigned PPE Category 1 where Category 2 is required. MV buses overstated 50%. The most dangerous single bug in the codebase.
- **Fix:** `cf = 1.5 if voc_kv < 1.0 else 1.0` (one line).
- **Verification:** Confirmed at source; condition is exactly inverted relative to the standard.

### C2. Fault: source zero-sequence impedances multiplied by a spurious ×3 — SLG currents understated ~40% **[VERIFIED]**
- **File:** `backend/analysis/fault.py:734, 748, 750, 758, 765`
- **Issue:** Utility Z0 is computed as `z_src * z0_z1 * 3` (and `z_src * 3` fallback); generator user-supplied X0 and solar/wind source Z0 are likewise multiplied by 3. The frontend (`constants.js:829`, default `z0_z1_ratio: 1.0`, label "Z₀/Z₁ Ratio") defines the prop as the literal Z0/Z1 ratio. The code confuses the 3Zn neutral-impedance term (already correctly applied separately at `fault.py:934` for transformer grounding) with Z0 itself. The ×3 fallback for *cables* lacking R0/X0 data (`fault.py:807`) is a different, legitimate Z0≈3Z1 approximation — only the source terms are wrong.
- **Impact:** For a solidly grounded utility with Z0 = Z1, Ik1 comes out 0.6× the true value — **SLG fault current understated 40%**, propagating into LLG results and into grounding analysis (GPR, mesh/step voltages all understated → non-conservative grid designs). Earth-fault relay reach checks non-conservative.
- **Fix:** Remove the `* 3` on utility/generator/solar/wind source Z0; keep 3Zn only for neutral grounding impedances. Reconcile the frontend label with engine semantics.
- **Verification:** All five occurrences confirmed at source; frontend default and label confirmed.

### C3. Grounding: conductor sizing off by ~×506 (amps fed into a kA formula, plus bogus unit conversion) **[VERIFIED]**
- **File:** `backend/analysis/grounding_system.py:209-215`
- **Issue:** `K_f_sq = αr·ρr·1e4/(TCAP·ln_term)` is precisely the IEEE 80 Eq. 37 form that yields **mm² with I in kA**. The code feeds amperes (×1000), then applies a kcmil→mm² factor (×0.5067) to a number that was already mm².
- **Impact:** Lead-reviewer hand calculation (10 kA, 0.5 s, hard-drawn Cu): correct ≈ 25 mm²; code produces ≈ 12,800 mm². Every grounding run recommends an absurd conductor, and `_select_standard_size` passes the raw value through since it exceeds 300 mm².
- **Fix:** `A_mm2 = (I_fault_a / 1000.0) * math.sqrt(K_f_sq * t_c)`; delete the 0.5067 line.
- **Verification:** Confirmed at source; hand calculation reproduces the ×506.7 error factor exactly.

### C4. Motor starting: modeled starting load is 0.3× the locked-rotor MVA — voltage dips understated ~3× **[VERIFIED]**
- **File:** `backend/analysis/motor_starting.py:127-129` with `backend/analysis/loadflow.py:485-487`
- **Issue:** The starting motor is given `rated_kw = s_start_mva*1000*0.3`, `pf = 0.3`, `eff = 1.0`. The load-flow motor model computes `rated_mva = rated_kw/eff/1000`, so apparent power drawn = 0.3 × S_start (and P = 0.09 × S_start).
- **Impact:** Voltage dips understated roughly 3×. Motors that will stall and contactors that will drop out are reported "pass".
- **Fix:** `rated_kw = s_start_mva * 1000` (so rated_mva = S_start at eff = 1.0) keeping pf = 0.3; better, model the locked rotor as constant impedance (S ∝ V²), which is the physically correct characteristic.
- **Verification:** Both files confirmed at source; the multiplication chain checks out.

### C5. Compliance engine: connectivity walker reads non-existent wire fields — most standards cross-checks are dead code **[VERIFIED]**
- **File:** `frontend/js/compliance.js:763-764` vs `frontend/js/state.js:149`
- **Issue:** `_findConnectedDevices` tests `wire.from`/`wire.to`, but wires are created with only `fromComponent`/`toComponent`. The BFS never finds a neighbor.
- **Impact:** The IEC 60909 fault-duty section reports "No circuit breaker or fuse connected to bus" for every bus; protection-device voltage adequacy, SANS cable protection (In ≤ Iz), earth-fault disconnection, and max-demand LV-bus matching all silently produce nothing. The report fills with plausible-looking warnings/info while the actual rating cross-checks never execute — a compliance report that claims verification it never performed.
- **Fix:** Use `wire.fromComponent`/`wire.toComponent`; delete `_extractCompId` (assumes a port-ref schema that doesn't exist).
- **Verification:** Wire schema confirmed in `state.js`; dead field reads confirmed in `compliance.js`.

### C6. TCC: coordination, miscoordination detection, and auto-grading ignore voltage referral across transformers **[VERIFIED — code paths confirmed; numerics endorsed]**
- **File:** `frontend/js/tcc.js:2466-2497` (`_runCoordinationCheck`), `:3115-3165` (`detectMiscoordination`), `:2694-2758` (`autoCoordinate`)
- **Issue:** All three engines feed the same raw amps to every device regardless of `dev.voltage_kv`. The chart itself refers currents correctly (`_scaleCurrent`), but the checks do not. An 8 kA fault at 0.4 kV appears to an 11 kV upstream relay as ~291 A, not 8000 A.
- **Impact:** Any protection path crossing a transformer gets wrong margins and false pass/fail, and `autoCoordinate` writes wrong TDS settings — the exact error voltage referral exists to prevent. Mis-set grading is a safety outcome.
- **Fix:** In all three functions, convert each test current into device-local amps using the device voltage, pinned to the faulted-bus voltage rather than `this.referenceVoltage`.

### C7. Undo history survives project load — Ctrl+Z can overwrite one project with another **[VERIFIED]**
- **File:** `frontend/js/project.js` (all load paths: recent menu, file manager, JSON import, backup restore, template/scenario load) and `frontend/js/undo.js:102`
- **Issue:** `UndoManager.clear()` exists but is never called from any load path — `grep` confirms zero `UndoManager` references in `project.js`. After opening Project B, the undo stack still holds Project A snapshots; Ctrl+Z restores A's diagram while `AppState.projectId` points at B; saving then **overwrites Project B with Project A's contents**.
- **Fix:** Call `UndoManager.clear()` (which re-snapshots loaded state) in every load path.
- **Verification:** Absence of clear-on-load confirmed by grep; restore/save mechanism confirmed.

### C8. Opening a project / closing the tab destroys unsaved work with no warning **[VERIFIED — endorsed against code structure]**
- **File:** `frontend/js/project.js:561-577, 614-634` (no dirty check on open); `project.js:43-47` (`beforeunload` only writes a local backup, and only when auto-save is enabled)
- **Issue:** `newProject()` and template load check `AppState.dirty` and confirm; opening another project does not. No `beforeunload` unsaved-changes prompt exists.
- **Impact:** Silent loss of user work — closing the tab with dirty state and auto-save off (the default) loses everything.
- **Fix:** Guard all load paths with the same dirty-confirm used in `newProject()`; add a `beforeunload` handler that calls `e.preventDefault()` when dirty.

---

## High Findings

### Backend analysis engines

**H1. Arc flash engine is IEEE 1584-2002 but labeled 1584-2018 throughout.** **[ENDORSED]** `arcflash.py:1-48, 130-238`, `schemas.py:240`. Docstring, result `method` field, and printed NFPA labels claim 2018, but the equations are the 2002 model (internal docstrings admit it). The 2018 machinery is absent: no intermediate arcing currents at 600 V/2700 V/14.3 kV with interpolation; `enclosure_mm` accepted and ignored; `_IARC_COEFFS`/`_BOX_FACTORS` are placeholder tables with identical values for all five electrode configs and are never referenced. VCBB/HCB configs (up to ~2× VCB energy under 2018) silently return VCB-equivalent numbers. **Fix:** implement 1584-2018 properly or relabel honestly as 1584-2002.

**H2. Arc flash: MV enclosed distance exponent wrong (2.0 vs 0.973).** **[VERIFIED]** `arcflash.py:224-229`. IEEE 1584-2002 Table 4 gives x = 0.973 for 5/15 kV switchgear; code uses 2.0 for all MV enclosed cases — understates MV incident energy ~34% at typical 910 mm working distance (non-conservative). LV enclosed always uses 1.641 (MCC/panel); LV switchgear should be 1.473.

**H3. Arc flash: clearing time taken as the minimum across all adjacent devices, including downstream feeders.** **[ENDORSED]** `arcflash.py:278-316`. A downstream feeder breaker does not clear a bus fault; a bus with a fast feeder fuse and slow incomer gets the fuse's 20 ms, massively understating energy. Also: `inst_threshold` computed but never compared to arcing current; trip time guessed from `long_time_delay` buckets instead of evaluating the TCC at the reduced arcing current (IEEE 1584 §4.5); reduced-current case uses an arbitrary t×1.5; the 0.90 MV time-reduction factor is invented (2002 applies none). **Fix:** restrict to source-side devices and evaluate actual device curves at Iarc.

**H4. Fault: single shared `visited` set in source-path tracing — parallel/ring paths silently dropped.** **[ENDORSED]** `fault.py:262-422` (`_collect_source_paths`; same defect in `_collect_zero_seq_impedances`). In any ring or parallel-feeder network the second path to a source is never traversed — fault current understated (one of two parallel cables counted). The radial "current divider" model is only valid for radial networks; for meshed systems, the Zbus machinery that already exists for voltage depression (`fault.py:1193+`) should compute Ik too.

**H5. Unbalanced load flow: sequence current injections missing factor 3 — VUF and neutral currents ~3× low.** **[ENDORSED]** `unbalanced_loadflow.py:498-544` (includes the uncommitted 1P/2P code). Per-phase powers are p.u. on the three-phase base while voltages are p.u. line-to-neutral; correct relation is `Ia_pu = 3·conj(Sa_pu/Va_pu)` but the code computes `conj(Sa/Va)`. All I2/I0 injections, hence V2, V0, VUF, In, are 3× too small. The new 2P/1P branch repeats the omission (its connection topology is otherwise correct). **Must be fixed before the uncommitted diff ships.**

**H6. Unbalanced load flow: delta transformer makes Y0 singular — entire zero-sequence solve silently zeroed.** **[ENDORSED]** `unbalanced_loadflow.py:54-73, 177-180, 551-565`. Blocking Z0 through-flow for Dyn is correct, but the grounded-wye winding's Z0 shunt (the dominant LV return path) is never added to `Y0[i,i]`. Downstream buses get an all-zero Y0 row → `np.linalg.solve` raises → `_solve_seq` returns zeros for all buses. On a Dyn11 LV system (the most common topology) 1P loads show V0 = 0. **Fix:** add a Y0 shunt of 1/(Z_T0 + 3Zn) at the grounded-wye bus; pseudo-ground isolated Y0 buses rather than letting the whole solve fail.

**H7. Gauss-Seidel PV-bus reactive power sign error.** **[ENDORSED]** `loadflow.py:1074` — `Q_calc = -(V[i]·conj(ΣYV)).imag` computes −Q_i (the minus-sign shorthand requires `conj(V)·I`, not `V·conj(I)`). PV buses iterate with reversed reactive injection; GS results with PV buses are wrong (NR path unaffected).

### Frontend protection (TCC / compliance)

**H8. Earth-fault compliance check reads a field that is never emitted.** **[VERIFIED]** `compliance.js:673` reads `faultResult.islg`; the backend emits `ik1` (`fault.py:115`; `annotations.js` reads `result.ik1`). Always undefined → every bus skipped → SANS 10142-1 Cl. 5.5.6 disconnection verification never runs, reported misleadingly as "No LV buses with earth fault data found." **Fix:** read `ik1`.

**H9. No instantaneous (50) element and no definite-time curve.** **[ENDORSED]** `tcc.js:431-461`, `constants.js:322-330, 1184-1190`. A "50/51" relay is modeled as a pure 51: at high fault currents the model overstates trip time, so grading checks can pass schemes with real 50-element/fuse races, and auto-coordination raises TDS where the actual constraint is the 50 setting. **Fix:** add `inst_pickup_a`/`inst_delay_s` props and a definite-time branch in trip-time math and curve drawing.

**H10. `_resolveDeviceVoltage` returns the transformer LV voltage regardless of device side.** **[ENDORSED]** `tcc.js:407-409`. An HV-side relay/fuse whose BFS reaches the transformer first is tagged with the LV voltage — with referral active, its curve is mis-referred by the full turns ratio (e.g. 27.5× for 11/0.4 kV). **Fix:** track entry winding or stop the BFS at transformers.

**H11. Sequence-of-operation verification expects devices downstream of the fault to trip.** **[ENDORSED]** `tcc.js:2976-3024, 2819-2956`. Every device on a path "sees" every bus; downstream devices (which carry no bus-fault current) are flagged "failed_to_operate"/"out_of_sequence" — systematic false criticals in any multi-bus network. **Fix:** restrict candidates to source-side devices ranked by electrical proximity.

### Component data & input integrity

**H12. Cable library R values are 20°C DC, but the header claims 90°C — all results optimistic.** **[VERIFIED]** `constants.js:15` ("Values: R and X at 90°C") vs lines 18-101: every R1 is the IEC 60228 Class 2 DC value at 20°C (95 mm² Cu = 0.193 Ω/km confirmed at source; the 90°C AC value is ≈ 0.247). Same 20°C table duplicated in `backend/analysis/cable_sizing.py:14-34`. Systematic ~22-28% under-estimate of cable R → voltage drop, losses, and load flow optimistic; minimum-fault-current (relay reach) checks non-conservative; cable-sizing voltage-drop checks pass cables that would fail. **Fix:** apply the 90°C correction (Cu ×1.275, Al ×1.282, plus skin/proximity ≥185 mm²) or correct the header and apply temperature correction in the engines — in both copies.

**H13. Field min/max/step constraints defined in COMPONENT_DEFS are never rendered or enforced.** **[VERIFIED]** `properties.js:346` emits `<input type="number" ... step="any">` only — the carefully declared `min`/`max`/`step` attributes are silently dropped, and `onFieldChange` does no clamping (invalid text is silently discarded, `properties.js:430-432`). Negative `r_per_km`/`z_percent`/`voltage_kv`, PF > 1, efficiency > 1 all reach the solvers; `components.js` validates only a handful of props (it catches `z_percent ≤ 0` but not negative cable R+X, Xd″ ≤ 0, X/R ≤ 0). Consolidates the UX audit's inline-validation finding. **Fix:** emit min/max attributes, clamp in `onFieldChange`, red border + message on invalid input.

### UX / operability

**H14. Ctrl+V (paste) is broken — shadowed by the Select-mode shortcut.** **[VERIFIED]** `app.js:92-93` has `case 'v': case 'V':` (Select mode, no modifier check) before the Ctrl+V paste case at line 139, which is unreachable (first matching case wins). Pressing Ctrl+V switches to Select mode instead of pasting; the Edit menu has no Paste item either. *Downgraded from the specialist's Critical: a broken core workflow, but no data corruption.* **Fix:** check modifiers first; add Cut/Copy/Paste/Duplicate/Select All to the Edit menu.

**H15. Marquee select and Ctrl+A operate on ALL sheets, not just the visible one.** **[VERIFIED — Ctrl+A confirmed at `app.js:125`; marquee endorsed]** `canvas.js:633`, `app.js:122-130`. Rendering is page-filtered but selection is not: a user on Sheet 1 can marquee-select and Delete, silently destroying invisible Sheet 2 components. **Fix:** iterate `AppState.getActivePageComponents()` in both places.

**H16. Per-keystroke undo snapshots + result clearing make undo nearly useless during property editing.** **[VERIFIED]** `properties.js:182-192, 463-465`, `undo.js` 50-snapshot cap. Typing "1000" fires ~5 snapshots, 5 full re-renders, and 5 `clearResults()` calls; a few values typed evicts the user's structural editing history, and undo becomes character-by-character. (Reported independently by both the component-data and UX audits — consolidated here.) **Fix:** debounce ~400 ms or snapshot on `change`/blur; coalesce consecutive edits to the same field.

**H17. Undo doesn't cover pages, groups, scenarios, or annotation positions; page deletion is not undoable.** **[ENDORSED]** `undo.js:27-32` (snapshot = components + wires + nextId only); `state.js:383-393` (`deletePage` takes no snapshot — deleting a sheet is unrecoverable); paste of unwired components records no snapshot. **Fix:** include pages/activePageId/groups in snapshots; snapshot at end of `deletePage` and `pasteClipboard`.

**H18. Library customizations are in-memory only; "Reset to Defaults" has no confirmation.** **[VERIFIED]** `standard-data.js` — grep confirms zero `localStorage` usage; working copies are cloned at init, reset handlers have no `confirm()`. A user's painstakingly entered utility cable data vanishes on page refresh or one accidental click. **Fix:** persist libraries to localStorage (and/or project JSON); wrap resets in confirm().

**H19. Documented interactions don't exist: "R = rotate" and "Space+drag = pan".** **[ENDORSED]** Help modal documents both; `app.js` keydown has no `r` case (rotation is 3 clicks deep in Properties → Position), and pan requires Alt+left or middle button. **Fix:** implement both (table stakes for diagram editors) or correct the help.

**H20. Dark mode makes result badges and data labels unreadable.** **[ENDORSED]** `symbols.css:108-160` badges keep hardcoded light fills while `.annotation-text` flips to near-white → white text on cream boxes; `canvas.js:942` labels hardcoded `#555` on the dark canvas. The primary analysis-review surface is illegible in dark mode. **Fix:** dark-mode badge fills; theme labels via CSS class.

**H21. Failed DB save silently masquerades as success.** **[ENDORSED]** `project.js:87-97, 119-125`. Any `API.saveProject()` error falls into a catch that downloads a JSON file and sets `AppState.dirty = false` — title bar claims saved while the DB copy is stale; dismissing the download means the only copy is gone on tab close. **Fix:** keep `dirty = true` on failure; distinguish network-unreachable from server errors; explicit non-transient error.

**H22. Drag operations break when the mouse leaves the SVG.** **[ENDORSED]** `canvas.js:47-49` — mousemove/mouseup bound to the SVG only; releasing outside leaves dragState/busResize/marquee active ("sticky drag"), and skipped mouseups corrupt undo pairing. **Fix:** bind to `document` or use Pointer Events with `setPointerCapture`; bail when `e.buttons === 0`.

**H23. No keyboard accessibility.** **[ENDORSED]** Zero ARIA/role/tabindex anywhere; `outline: none` on focused inputs; palette items, file-manager rows, page-tab close are divs/spans; modals have no focus trap and **Escape does not close them**. Unusable without a mouse. **Fix (incremental):** Escape-to-close + initial focus for modals; `:focus-visible` outlines; focusable palette buttons; role/aria-modal labels.

---

## Medium Findings

### Backend engines

- **M1. No swing bus when the utility sits behind a transformer.** `loadflow.py:398-435` auto-promotes only buses with a *directly connected* utility; utility→TX→bus networks have no slack unless manually labeled (divergence/garbage). `unbalanced_loadflow.py:291` is worse: never auto-assigns swing and models the utility as a Y1 shunt admittance — the exact "passive load" modeling the balanced LF's own comments call wrong.
- **M2. Motor MVA convention drops power factor.** `fault.py:619`, `loadflow.py:485`, properties display (`properties.js:581/1237`): S = kW/η instead of IEC 60909-0 §3.8's S = kW/(η·cosφ) — which `load_diversity.py:108` gets right. Motor fault contribution ~15% understated (non-conservative for duty checks); in load flow, motor P understated by the pf factor. (Found independently by backend and component-data audits — consolidated; frontend and engine at least agree with each other.)
- **M3. Breaking current Ib details.** `fault.py:1039-1090`: generator I″kG/IrG ignores external impedance (understates Ib close-in, non-conservative for breaker selection); `_q_factor` feeds a current ratio where IEC 60909-0 §9.1.2 wants MW per pole pair; Ib_asym hardcodes 50 Hz (ignores `project.frequency`) and t_min = 0.1 s; dead `i_rg_ka` variable.
- **M4. Transformer correction KT uses HV-side c_max.** `fault.py:592` and identically `properties.js:1133`: IEC 60909-0 §6.3.3 ties c_max to the **LV-side** nominal voltage; an 11/0.4 kV unit gets 1.1 instead of 1.05 (~4.5% impedance error). Also missing: generator K_G and power-station K_S/K_SO corrections. (Found by two audits — consolidated; frontend and backend agree, so one fix in each.)
- **M5. Duty check gaps.** `duty_check.py`: peak/making verified only for ACBs at a fixed 2.2× (n actually varies 1.5-2.2 per IEC 60947-2; MV breakers use 2.5/2.6 per IEC 62271-100); MCCBs, fuses, MV breakers get no peak check; no Icw short-time withstand check at all.
- **M6. Cable sizing gaps.** `cable_sizing.py`: no grouping/soil-resistivity/burial-depth derating on the IEC path; `ambient ≥ max_temp` leaves derating = 1.0 instead of failing; fixed cosφ = 0.85; if load flow fails, current silently = 0 and every check passes; area derived from ρ20DC/R overestimates → optimistic adiabatic check; no single-phase Vdrop. The route layer (`routes/analysis.py:95-102`) never exposes `ambient_temp_c`/`install_method`/`max_voltage_drop_pct` — dead engine inputs.
- **M7. Branch contribution math inconsistent per fault type.** `fault.py:444-453`: LL/LLG per-path currents use the positive-sequence path only while bus totals use the full sequence network — contributions don't sum to 100%; path magnitudes summed arithmetically without phase.
- **M8. Voltage-depression Ybus dedups parallel branches.** `fault.py:1224-1230` keys branches by bus pair, collapsing parallel cables; computed `c_factor` at line 1276 never used.
- **M9. NR load-flow refinements absent.** No Q-limit/PV→PQ switching; PV setpoint hardcoded 1.0 pu (generator setpoint prop ignored); capacitors constant-Q rather than Q∝V²; cable charging B/2 omitted; bus links injected as G = 1e6 real conductance (distorts losses) — use large susceptance or node merging.
- **M10. Unbalanced LF: I2 branch current ignores the transformer tap model** (`unbalanced_loadflow.py:625` vs Y2 built with tap at :246; I1 handles it correctly).
- **M11. Load diversity transformer aggregation can double-count** (loads on the HV-side bus added alongside LV); "diversity factor" applied multiplicatively to already demand-factored loads conflates diversity with coincidence factor Ks (`load_diversity.py:241-254`).

### TCC / compliance

- **M12. Max-demand check uses wrong motor type names** (`compliance.js:610`: `induction_motor`/`synchronous_motor` vs actual `motor_induction`/`motor_synchronous`) — motors silently excluded from LV maximum demand.
- **M13. TCC curve selection not persisted** — writes `comp.props.curve_type` but the SLD key is `curve`; reopening the TCC reverts the curve while pickup/TDS persist (`tcc.js:2276` vs `constants.js:1190`). Settings-record integrity issue for a protection tool.
- **M14. Directional 67 relays excluded from coordination paths** (`tcc.js:2590-2592` accepts only 50/51, 50N/51N, 21) though they're loaded onto the chart — invisible to autoCoordinate/detection/sequence checks.
- **M15. Phase and earth-fault elements graded against each other at the same current** — 50N/51N (low pickup) tested against phase devices at 3-phase currents produces false miscoordination flags (`tcc.js:2466, 3117-3120`).
- **M16. The automatic pairwise check has no topology** — `_runCoordinationCheck` compares all visible pairs (parallel feeders, separate branches) and labels the faster device "Downstream" without ever determining hierarchy; the topology-aware `detectMiscoordination` exists but isn't what runs on every change.
- **M17. ACB model: chart and trip-time function disagree** — `cbTripTime` gives no 20 ms instantaneous region when ST pickup is set, but `_drawCBCurve` always draws one; what the engineer sees plotted is not what coordination checks (`constants.js:567-580`, `tcc.js:1366-1394`; `magTimeACB` dead).
- **M18. CB thermal class constants are invented and the citation is wrong** — `CB_TRIP_CLASSES` k-values {5:80, 10:200, 20:500, 30:1000} attributed to "IEC 60947-2 Annex F"; classes 5/10/20/30 are IEC 60947-4-1 motor-starter classes, and the curve sits below the class-10 band. Recalibrate (e.g. k = class×35 so t(6·Ir) = class) and fix the citation.
- **M19. `_nearestFuseRating` 20% guard is dead code** (`tcc.js:571-573`: both branches return `best`) — a 1000 A fuse silently coordinates as a 630 A gG curve.
- **M20. Fuse model is pre-arcing only** — downstream-fuse coordination must use total-clearing time (≈1.1-1.2× pre-arc, or I²t below 0.1 s per IEC 60269 practice); margins overstated. Curves are one 9-point shape ratio-scaled (synthetic, not gate-verified) and clamp at 8 ms — acceptable approximations but unlabeled.
- **M21. Transformer damage curve drawn into an invalid region; no inrush point.** 1250/I² applied from 2×Ir where C57.109 gives ~2000 s, not 312 s (valid only above ~3.5×); ANSI category and Z-limited mechanical portion ignored; magnetizing inrush (≈8-12×In @ 0.1 s) not plotted, so "above inrush, below damage" cannot be verified (`tcc.js:1681-1698`).
- **M22. Fixed 0.3 s CTI for all device-type pairs** — fuse-fuse needs I²t/2:1-rating rules, not time margin; sub-0.1 s pairs can never pass and always flag. Margins should depend on pair type (relay-relay 0.3-0.4 s; relay-fuse ~0.2 s + CB time; fuse-fuse I²t).
- **M23. "IEC 60038" voltage limits mislabeled and contradictory** — ±5% applied to every bus citing IEC 60038 (LV utilization tolerance is ±10%); the same LV bus can fail this section at 0.93 pu while passing the SANS ±10% section (`compliance.js:165-168` vs `:366-368`).
- **M24. Fault duty uses Ik″ only** — breaking duty should compare Ib (already computed by the backend as `ib_ka`) and making/peak duty should compare ip against making capacity; ip never checked; any margin > 0% passes with no warning band (`compliance.js:90,112`).

### Component data / properties / graph

- **M25. `applyStandardType` doesn't copy library R0/X0.** **[VERIFIED]** `properties.js:500-507` copies only r/x/amps/voltage; the new `r0_per_km`/`x0_per_km` columns (commits ddc3a3f/556d316) never reach the component, so the backend falls back to 3.5×R1/3.5×X1 — the X0 fallback differs from the library's 2.8×X1 by 25%, changing SLG results. The reset-button logic even compares against `stdCable.r0_per_km`, so every library cable immediately shows R0/X0 as "modified". This also undermines the otherwise-correct uncommitted unbalanced-LF diff.
- **M26. Library transformer selection doesn't sync grounding props.** **[VERIFIED]** `properties.js:508-517` — the vector-group→grounding auto-default runs only on manual change; picking a YNd11 from the library leaves `grounding_hv: 'ungrounded'` → SLG results wrong/zero.
- **M27. 20 MVA 33/11 kV library unit is `YNd11`** (`constants.js:123`) — delta on the 11 kV side leaves the downstream network with no earth-fault source (and no earthing-transformer component exists). Almost certainly should be Dyn11; the 132/33 kV YNd11 units deserve at least a comment about NECRT practice.
- **M28. Cable "Voltage drop (at rated)" display formula reduces to Rpu(system base)×100** (`properties.js:1226`) — ~13× error at defaults (shows 0.83% where the true R-drop is 0.06%). Display-only but on an engineering-credibility surface. Fix: `√3·I·R/(V·1000)·100`.
- **M29. `utility.x0_r0_ratio` is a dead knob** — never read by any backend code; the utility Z0 angle is taken from Z1. Gives a false sense of control over earth-fault X/R. (The related Z0 ×3 contradiction is Critical C2.)
- **M30. Loads/sources behind a terminal cable (no intervening bus) are silently dropped from the graph** — `components.js:199-247`: `Bus → Cable → Motor` yields a one-bus cable branch (discarded) and the motor never enters `graph.loads`; validation passes clean. Fix: warn when a cable/transformer port resolves to no bus, or fold terminal cables into the load connection.

### UX

- **M31. Client/Company project fields dropped on save→load round trip** — key mismatch between `state.js` initial keys (`client`, `company`), `reset()` (`clientCompany`), `fromJSON` (reads only `clientCompany`), and the form (reads `d.client`/`d.company`). Report covers lose client info after reopening.
- **M32. Editing any property silently wipes all analysis results** (`properties.js:464`) — correct for staleness but badges vanish per keystroke with no explanation; mark results visually stale instead. Pair with H16 debouncing.
- **M33. Result badge spam** — after "Run All Studies" every bus sprouts ~6 fixed-offset boxes that overlap each other and adjacent buses (`annotations.js:36-200`); needs collision-avoiding stacking or a combined per-bus badge. (Visibility toggles, `H` hotkey, drag persistence already exist — good.)
- **M34. Single-bus vs all-bus fault scope is implicit** — if exactly one bus happens to be selected, fault analysis silently runs on it alone (`app.js:286-303`); only cue is status-bar text.
- **M35. Feedback channel is a 3-second status message** — no spinner, no disabled buttons during requests, no fetch timeout/cancel; double-firing possible; a hung backend leaves "Running…" forever.
- **M36. Validation modal findings aren't actionable** — errors carry `compId` but render as plain text; no click-to-zoom (the pattern already exists for cable-sizing/duty tables).
- **M37. Declining the local-backup restore permanently deletes the backup** (`project.js:500-503`) — Cancel destroys it; offer Restore / Keep / Discard.
- **M38. Component names interpolated unescaped into HTML and SVG** (`properties.js:53,346`, `canvas.js:940-942`, annotations) — a name with `"` or `<` breaks the panel/SVG; stored-XSS vector if projects are shared. The `_esc()` convention exists but isn't applied to props.
- **M39. Wire editing affordances invisible** — double-click bend points undocumented, routing mode buried in View menu, right-click suppressed with no context menu, failed wire-drops cancel silently.
- **M40. Additive zoom step** (`zoom += 0.1`) — one wheel tick doubles scale at 10% but is 2% at 500%; no keyboard zoom. Use multiplicative.
- **M41. No arrow-key nudge, no alignment/distribution tools.**
- **M42. Annotation badge drags don't set the dirty flag** (`canvas.js:552-555`) — arranged layouts not flagged for autosave.
- **M43. Palette is drag-only on desktop** — no click-to-place although `MODE.PLACE` machinery exists (mobile has tap-to-place).

---

## Low Findings

### Backend
- `fault.py:79` — c = 1.05 for LV; IEC 60909 Table 1 prescribes 1.10 for +10%-tolerance LV systems (most modern networks); make it a project setting.
- `fault.py:789` — YNyn cascade walk passes `entry_port=None` onward, degrading vector-group side detection; 3-limb YNyn magnetizing Z0 ignored; no transformer z0/z1 prop.
- `fault.py:1000` — "Method C" for meshed networks claimed in docstring but it's plain R/X of Z_eq.
- `arcflash.py:362-371` — validity warnings overwrite each other (one string kept); gap validity range (6.35-76.2 mm) never checked though `_TYPICAL_GAP` can return 153 mm; AFB computed for full Iarc only, not worst of full/reduced.
- `arcflash.py:66-73` — "Category 0" was removed from NFPA 70E in 2015; label < 1.2 cal/cm² as "no arc-rated PPE required".
- `grounding_system.py` — body-weight constants correct in code but swapped in docstring; `reflection_factor` dead; n = max(nx, ny) vs IEEE 80 composite n; L_M omits rod enhancement (conservative); I_G uses total Ik1 with no split factor Sf or decrement Df.
- `loadflow.py:556-612` — every element in a series chain reports the whole chain's P/Q/losses (display duplication); droop "proportional sharing" annotations are presentation-layer fiction (utility "loading" computed against fault_mva).
- `schemas.py:26-42` — numeric coercion converts any digit-string prop including `name: "123"` → int, which would make `sorted()` joins in `fault.py:545` raise; coerce only known numeric keys.
- `motor_starting.py` — synchronous motors excluded; no starting-method modeling (DOL/star-delta/soft-start/VFD); constant-PQ is the wrong locked-rotor characteristic (should be constant-Z; see C4 fix).
- `cable_sizing.py:692` — fallback returns the existing failing size labeled "(no standard cable found)".

### TCC / compliance
- CT knee-point approximated as the accuracy-limit EMF (Vk ≈ 0.7-0.8·E_AL in reality) — saturation predicted late; label the η clipping model "approximate".
- Distance-relay TCC conversion ignores source impedance — zone steps plot at higher currents than reality; add a caveat label.
- CB thermal pickup adjustable to 1.3×In (real Ir max is 1.0×In) — lets users defeat overload protection in the model.
- Dead code: `totalSupplyMVA` with a bogus "fault_mva/20" comment (`compliance.js:584-592`); unused `passes` (`tcc.js:2468`); unused `magTimeACB` (`tcc.js:1368`).
- Adiabatic cable/transformer curves drawn to 1000 s; validity is ≤ 5 s (conservative direction, unlabeled).
- Peak current ip plotted on an RMS TCC axis — apples-to-oranges; annotate or drop.
- `_getMiniSLDRating` reads wrong prop keys (`fault_level_mva`, `mva_rating`, `fuse_rating_a`, `cable_size_mm2` vs actual `fault_mva`, `rated_mva`, `rated_current_a`, `size_mm2`) — most mini-SLD rating labels blank.
- SANS cable checks require `voltage_kv` on the cable itself; cables inheriting voltage from the bus are silently skipped.
- Relay pickups treated everywhere as primary amps — internally consistent, but real settings sheets use secondary amps; no conversion surfaced.

### Component data
- Cable `r2_per_km`/`x2_per_km` editable fields have zero backend readers (Z2 = Z1 for cables anyway) — remove or wire up.
- Fixed R0/X0 multipliers (3.8×R1, 2.8×X1) are a simplification of screen/armour return paths — acceptable for a generic library; X0 = 2.8× is at the low edge of guidance.
- Induction motor default `x_r_ratio: 10` is high for a 200 kW LV motor (IEC 60909-0 suggests X/R ≈ 2.4 for LV motor groups) — overstates peak contribution.
- Wind turbine `rated_mva` unit option labeled "kW" — should be kVA.
- "MCCB 200/400/630A 11kV" library entries — MCCBs are LV devices (IEC 60947-2); 11 kV uses VCB/SF6 with relays. "gG" MV fuses likewise mislabeled (IEC 60282-1 classes are not gG).
- `rectifier.num_pulses` default is number `6` but options are strings — select never shows stored value as selected.
- Capacitor `steps` has no min — 0/negative accepted.
- Default `rct_ohm: 2.0` is typical for 1 A CTs; for the default 5 A 400/5 CT, 0.1-0.5 Ω is typical.
- Missing Swing bus is a blocking error even for fault-only studies (should be a warning or load-flow-scoped); cable bus-voltage consistency uses strict equality (0.4 vs 0.42 kV nags) while other checks use 15%; `traceUpstreamProtection` enumerates all simple paths (exponential on meshed networks — cap it).

### UX
- MiniMap.toggle() dead (no UI binding); minimap shows all sheets while canvas shows one and can hide content.
- Undo status "Undo 3/12" cryptic.
- Pasted names accumulate " copy copy copy"; auto-name collisions after deletions — use numbered unique suffixes.
- `prompt()`/`confirm()`/`alert()` used for rename/save-as/folders, inconsistent with the polished modal system.
- Duty-check badge uses emoji shield in SVG text (renders inconsistently); icon variable computed but unused.
- Help claims "Drag devices between tabs" — no such drop handling exists.
- Status-bar X:/Y: coordinates low-value; snap/sheet/selection-count readout would serve better.
- Annotation-hover highlights its bus but no reverse affordance, mouse-only.
- Print preview via `window.open` + `document.write` — eaten silently by popup blockers.
- First-run experience is a blank grid — no empty-state hint ("Drag a component from the left, or File → Templates").
- Fault-type dropdown buried as a compound row inside the Analysis menu — better in a persistent analysis bar.

---

## What's Done Well

**Fault analysis (fault.py):** κ = 1.02 + 0.98e^(−3R/X) exact per IEC 60909 Eq. 55; ip = κ√2·Ik″; all four μ-factor equations match Eq. 70-73; LL = (√3/2)·Ik3; SLG 3c/(Z1+Z2+Z0) form and LLG sequence algebra correct; KT formula correct; the transformer vector-group Z0 topology engine (delta-on-fault-side blocks, yn pass-through, 3Zn for impedance grounding, user grounding prop authoritative) is genuinely well designed with per-path provenance strings; branch kA correctly re-based across voltage zones; time-staged Zbus voltage depression (X″/X′/Xd) is a standout feature.

**Load flow (loadflow.py):** polar NR Jacobian correct in all four blocks; off-nominal-tap π-model correct with sensible HV-side tap placement; transparent-element collapsing cleanly handles CB/switch/fuse/CT/PT chains with open-state blocking; swing injection recomputed from S = V·conj(YV); chain-aware voltage re-basing with mismatch warnings.

**Unbalanced LF:** symmetrical-component matrices, phase reconstruction, and true IEC VUF = |V2|/|V1| correct; the uncommitted 1P/2P work has the right connection topology (2P-AB gives exactly I0 = 0) — it needs H5/H6 fixed before shipping, but the structure is sound, and the frontend half of the diff was verified key-for-key against backend output.

**Arc flash:** the 2002 equations that are present are transcribed accurately; Iarc clamped ≤ Ibf; robust bisection AFB solver; K2 = 0 conservative; useful mitigation recommendations.

**Cable sizing / grounding / duty / diversity:** adiabatic k values match IEC 60364-5-54 Table 54.2; Sverak grid resistance, Cs, Km/Ks/Ki and body constants match IEEE 80-2013; duty peak via bus-specific κ; `load_diversity.py`'s kW/(η·pf) motor convention is the correct one the other engines should adopt.

**Protection curve math:** IEC 60255-151 and IEEE C37.112 constants exact; cable k-factors and the C57.109 1250/I² constant right; chart voltage-referral and log-log math correct; fuse log-log interpolation correct; CT burden/saturation basics sound; `_deviceTripTime` applies CT saturation consistently in coordination.

**Component data:** transformer library Z% and X/R progressions textbook (IEC 60076-5/SANS 780); Dyn11 for 11/0.42 kV correct SA practice; source/motor/CT/arrester defaults verified sensible; all unit-conversion multipliers verified; IEC voltage factors, IEC 60364-5-52 and NEC 310.16 tables spot-checked correct. Graph code: open CB/switch correctly blocks branches and source reachability; port-directional BFS distinguishes transformer windings; off-page connector pairing is a clean multi-page solution; parallel branches correctly retained.

**UX:** Quick Access favourites; voltage-aware searchable cable picker; modified-from-library highlighting with one-click reset; per-field unit selectors with correct round-trip conversion; the "View Calculations" IEC 60909 step-by-step modal (outstanding for engineering trust); validation gate with errors-block/warnings-continue; click-to-highlight from result tables; draggable persisted annotations with visibility toggles; local backup + revision timeline + recent projects; dedicated mobile UI; deep TCC module (tooltips, draggable curves, mini-SLD, CSV import).

---

## Recommended Action Plan

Top 10, ordered by risk reduction per unit effort (S < 1 day, M = days, L = week+):

| # | Fix | Effort | Rationale |
|---|-----|--------|-----------|
| 1 | **C1** arcflash Cf swap | S (one line) | Highest safety exposure; LV PPE selection currently non-conservative on every study. |
| 2 | **C3** grounding conductor units | S | One-line unit fix; every grounding run currently absurd. |
| 3 | **C2** remove ×3 on source Z0 (+ reconcile frontend label, M29) | S | SLG 40% low; feeds grounding GPR/step/touch results. |
| 4 | **C4** motor starting S_start (constant-Z model preferred) | S-M | Voltage dips 3× low; stall/dropout risks hidden. |
| 5 | **C5 + H8 + M12** compliance field-name fixes (`fromComponent`/`toComponent`, `ik1`, motor type names) | S | Three tiny renames resurrect the entire compliance engine. |
| 6 | **C7 + C8** UndoManager.clear() on load, dirty-guards, beforeunload | S (~20 lines) | Eliminates the two silent data-loss/corruption paths. |
| 7 | **C6 + H10** TCC voltage referral in coordination/auto-grade + device-side resolution | M | Cross-transformer grading and autoCoordinate currently write wrong settings. |
| 8 | **H5 + H6** unbalanced-LF factor-3 + Y0 shunt for Dyn transformers | M | Must land before the uncommitted 1P/2P diff ships; also fix M25 (R0/X0 library copy, 3 lines) at the same time. |
| 9 | **H12** cable library 90°C resistance correction (both copies) + **H13/M6** input min/max enforcement | M | Removes the systematic optimistic bias across load flow, Vdrop, sizing, relay-reach; stops garbage inputs reaching solvers. |
| 10 | **H2/H3** arc flash MV exponent + upstream-only clearing time; then **H14-H16** (Ctrl+V, page-scoped selection, debounced undo) | M | Closes the remaining non-conservative arc-flash paths; restores core editing workflow. |

Follow-on tranches: H1 (1584-2018 implementation or honest relabel — L), H4/H7 (meshed-network Ik via the existing Zbus machinery; GS PV sign — M), H17-H23 UX hardening (M), then the Medium backlog.

### Strategic recommendation: standards-anchored regression suite

There are **zero automated tests**, and every Critical calculation bug found here is detectable by a short hand-calculation test. Before any further engine changes, build a pytest regression suite anchored to published worked examples:

- **IEC 60909**: infinite bus + transformer → known Ik3/Ik1/ip/Ib (catches C2, M2-M4, H4).
- **IEEE 1584** worked examples (both 2002 and 2018 annexes) → incident energy and AFB (catches C1, H1-H3).
- **IEEE 80 Annex B** grid example → conductor size, Rg, mesh/step voltages (catches C3).
- A 2-bus motor-start case with a hand-computed dip (catches C4).
- A balanced 3-phase case through the unbalanced solver must reproduce the balanced solver's voltages, and a known unbalanced case must give the textbook VUF (catches H5/H6).
- Frontend: a headless test that builds a 2-transformer network and asserts the compliance walker finds devices and coordination checks refer currents (catches C5/C6/H8) — even a Node-based unit test of the pure functions would suffice.

Estimated effort: ~1 week for the backend suite; it converts every future engine change from "hope" to "verified". This is the single highest-leverage investment available to the project.

---

## Appendix: Finding Counts by Severity and Area

| Area | Critical | High | Medium | Low |
|------|----------|------|--------|-----|
| Backend analysis engines | 4 (C1-C4) | 7 (H1-H7) | 11 (M1-M11) | 10 |
| TCC / compliance (frontend protection) | 2 (C5-C6) | 4 (H8-H11) | 13 (M12-M24) | 9 |
| Component data / properties / graph | 0 | 2 (H12-H13) | 6 (M25-M30) | 9 |
| UX / operability | 2 (C7-C8) | 10 (H14-H23) | 13 (M31-M43) | 11 |
| **Total** | **8** | **23** | **43** | **39** |

Notes on reconciliation: per-keystroke undo snapshots (component-data + UX reports) consolidated as H16; motor PF omission (backend + component-data) consolidated as M2; KT c_max HV-vs-LV (backend + component-data) consolidated as M4; the utility Z0 ×3 / label contradiction (backend + component-data) folded into C2 with the dead `x0_r0_ratio` knob retained as M29; input min/max enforcement (component-data High + UX M6) consolidated as H13. The UX audit's "Ctrl+V broken" was downgraded from Critical to High (H14) per the severity definitions — broken core workflow, but no data corruption. All eight Critical findings were independently verified in source by the lead reviewer; no specialist Critical claim failed verification.
