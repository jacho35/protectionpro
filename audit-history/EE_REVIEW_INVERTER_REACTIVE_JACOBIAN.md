# Engineering Verification Review — Recent Calculation Changes

**Branch:** `feat/inverter-reactive-and-jacobian` (all changes vs `main`)
**Date:** 2026-07-19
**Review panel:** Senior Electrical Engineer (independent) · Senior Protection Specialist (independent) · Principal Engineer (adjudication of both reviews)

**Scope — the calculation features under review:**

| # | Feature | Commit(s) |
|---|---|---|
| 1 | Storage-inverter reactive power (pf mode & voltage mode) + source pf | 6071ff5 |
| 2 | Singular / near-singular Jacobian trap & classification | c52213b |
| 3 | Load-flow solution-quality classification (non-convergence / low-voltage root) | 80aa124 |
| 4 | PV-generator reactive limits (over/under-excitation, PV→PQ clamp) | 5614f40 |
| 5 | Distribution-board per-circuit power factor rollup | fe3d3c0 |
| 6 | Overhead-line feeder model + cable sizing for overhead lines | d30d67f, 808d5f7 |
| 7 | Dynamic motor starting: cable-fed motors fix + prime-mover inertia auto-populate | 431cb65, 6c100e0 |

**Method:** the two senior reviewers worked independently and by different techniques — the EE extracted and exercised the NR/GS solvers verbatim against hand-solved networks, ran the engines end-to-end in the `protectionpro-backend` Docker image, and re-ran the full backend suite (333/333 pass); the Protection Specialist did analytic P-V two-root checks, IEC 60909 / 60865 hand calculations to the ampere, and behavioural probes of the clamp, sizing, fault and motor-starting paths. The Principal Engineer then reconciled their findings and independently spot-checked the load-bearing claims in source.

---

> **Remediation status (2026-07-19, post-review):** all P1 items are implemented and verified — finding #1 (clamp double-count) fixed at the dispatcher per §A.6 step 1 (`plan_dispatch` now zeroes the scheduled pf-split Q of every registered voltage-regulating unit via a `regulated_q` parameter; SVCs and island-swing balancers untouched); finding #2 (IBR clamp warning) mirrored for `ibr_pv_units`; finding #3 (explicit-0 `q_max_mvar`/`q_min_mvar` swallowed by `or q_cap`) fixed to fall back only on `None`/blank. Regression hardening added per §A.6 step 4: clamped generator delivers exactly Q_max; voltage-mode hybrid PV **with sun** (the untested scheduled-Q path) stays within its circle and warns; explicit q_max=q_min=0 clamps at 0. In-engine verification reproduces the reviewers' correct reference values (generator 0.4359 MVAr delivered, bus 0.9341 p.u.; inverter 21.8 kvar delivered). Full backend suite: **336 pass** (Docker). The conditional-ship criteria of §A.5 are met. Findings #4+ (P2–P5) are filed in `BACKLOG.md`.

## Executive summary

**Verdict: NO-SHIP in current state — one Critical defect; conditional ship once the P1 items land.** *(P1 items since remediated — see status note above.)*

Both senior reviewers, working independently with different methods, converged on the **same Critical defect with matching measurements**:

> **Post-clamp reactive double-count** (`backend/analysis/loadflow.py:2135` and `:2176`): when a PV-bus generator or voltage-mode inverter hits its reactive limit and is clamped PV→PQ, the pinned `q_lim` is added *on top of* the dispatcher's still-scheduled pf-split Q, so the solved network carries the machine at **exactly 2× its capability at default settings** (measured: 0.872 MVAr vs Q_max 0.436 MVAr; 43.6 kvar vs a 21.8 kvar circle). Post-clamp voltages are optimistically high (non-conservative), the generator warning text contradicts the solution it accompanies ("pinned at 0.44 MVAr" while the network carries 0.87), and the clamped-inverter case is **completely silent** (`converged=True`, `solution_quality="ok"`, no warning). The 333-test suite passes because the clamp tests assert only warning text and V < 1.0 — never the delivered Q.

**Operational guidance until fixed:** do not take under/over-voltage settings, var-based checks, or voltage-collapse margins from any study in which a generator or inverter reactive-limit warning appears (or, for inverters, where a voltage-mode unit is near its kVA circle) — the clamped solution is physically impossible and optimistic.

**Everything else verified sound.** The NR solver and Jacobian blocks were independently validated to ~1e-9 against textbook formulations; the singular-Jacobian trap and solution-quality gating work as designed (a diverged or near-singular case cannot be presented silently as valid); the DB power-factor rollup is a mathematically exact complex-power vector sum with exact legacy reproduction; the overhead-line library's k-factors, Carson earth-return terms and fault-path integration reproduce from IEC constants to the ampere; and the cable-fed motor fix is correct physics that previously produced no result at all.

| Area | Final verdict |
|---|---|
| 1. Inverter reactive (pf/voltage modes) + source pf | **Defect found** — Critical clamp double-count (shared with area 4); missing IBR clamp warning; pf mode itself verified correct |
| 2. Singular-Jacobian trap | **Verified correct** (solver validated to ~1e-9) |
| 3. Solution-quality classification | **Verified correct** (0.5 p.u. floor validated analytically; minor advisory gap in the 0.5–0.9 band) |
| 4. PV-generator reactive limits | **Defect found** — Critical clamp double-count; conventions & PV↔PQ switching logic otherwise correct |
| 5. DB per-circuit PF rollup | **Verified correct** (exact vector sum; diversity-invariant; legacy-identical) |
| 6. Overhead lines + sizing | Correct with reservations — fault path & k-factors exact; 20 °C resistance makes voltage drop ~12–15 % optimistic (Major, acknowledged in BACKLOG) |
| 7. Motor starting fix + prime-mover H | Verified correct / minor reservations (diesel H at top of band; tooltip contradicts auto-populate behaviour) |

---

## Part A — Principal Engineer adjudication (review of reviews)

### A.1 Adjudication narrative

#### Agreements
The two reviews were performed independently by different methods (EE: solver extraction + numpy hand-solves + Docker engine runs; Protection: analytic P-V root analysis + IEC 60909/60865 hand calcs + behavioural probes) and **converged on the same headline defect with matching measurements** (delivered Q = exactly 2×Q_max at defaults; the 0.4359/0.8718 MVAr and 21.8/43.6 kvar numbers agree across reports). Both independently identified the same test-suite gap that let it through (the clamp test asserts warning text and V < 1.0, never delivered Q). They also agree, at consistent severities, on: the clamp/dispatch Q-attribution edge case on mixed buses, the leading-pf gap in pf mode, the discarded `reason` in the unbalanced solver, the per-iteration SVD cost, the DB rollup being a correct vector sum with exact legacy reproduction, the overhead k-factors and Carson terms reproducing exactly, the cable-fed motor fix being correct physics, and the prime-mover tooltip/overwrite contradiction. Cross-corroboration of this quality is strong evidence; jointly-verified numeric claims are treated as established.

#### Disagreements resolved

**(a) Post-clamp reactive double-count (loadflow.py:2135/2176) — Protection: Critical; EE: Major. Ruling: CRITICAL.**
Rationale: (i) the solver presents a **physically impossible operating point** (machine at 2× its reactive capability) as `converged=True`; (ii) the error is **non-conservative** — post-clamp voltages are optimistically high, which corrupts exactly the studies (under-voltage settings, collapse margins, var-based checks) this tool exists to support; (iii) in the generator case the warning **actively misstates** the solution ("pinned at 0.44 MVAr" while the network carries 0.87), and in the inverter case there is **no indication at all** (`solution_quality="ok"`, no warning — Protection measured a 0.845 vs 0.767 p.u. phantom lift); (iv) it fires precisely in the operating regime the feature was built to handle. A silent, non-conservative, contradiction-carrying wrong answer in the core solver meets the Critical bar. The disagreement is taxonomic, not substantive — the EE's own summary designates it the item "requiring action before this branch ships," which is operationally identical to Protection's "release blocker."

**(b) Overhead-line 20 °C resistance (cable_sizing.py:714-718 + overhead library) — Protection: Major; EE: Minor. Ruling: MAJOR, but not ship-blocking.**
Protection's framing is technically the stronger one: the "no temperature correction" code comment is true for the hot-value cable library but **false for the 20 °C overhead library**, VD is understated ~12-15 % at operating temperature (non-conservative for a pass/fail sizing verdict), and there is a genuine asymmetry (the cable recommendation path corrects to hot; the overhead check never does). However: it is author-acknowledged and first-ranked in BACKLOG.md with the correct fix identified; the fault path is actually *more* standards-conformant at 20 °C (IEC 60909-0 prescribes 20 °C for Ik_max); and overhead is net-new functionality, not a regression. Final: **Major severity, priority immediately after the blocker, ship-permitted with the documented limitation** — but it must land before any overhead sizing sign-off is relied upon.

**(c) Missing clamp warning for inverters (loadflow.py:2708-2717) — Protection: Major; EE: Minor. Ruling: MAJOR, fix in the same PR as the blocker.**
Confirmed by grep: `ibr_pv_units` appears at registration (1856, 1936-1943), the clamp loop (2158), and the badge branch (2596) — **there is no warning construction for IBRs anywhere**. Even after the double-count is fixed, a clamped inverter silently stops holding its setpoint — the exact "hidden infeasibility" failure mode commits 80aa124/5614f40 set out to eliminate for generators. Cost of fix is a five-line mirror of the generator loop; leaving it creates an inconsistent safety posture between two device classes doing the same thing.

**(d) Low-voltage-root 0.5–0.9 band — Protection: Minor (wants advisory); EE: Observation (none required). Ruling: MINOR, backlog.**
Protection's analytic check actually *validated* the design: its 0.611 p.u. probe was a genuine upper root, so the conservative 0.5 floor correctly avoided a false positive. The residual exposure (a true low root above 0.5 with compensated/leading loads) is real but narrow, and the canvas LOW badge plus results tables already cue the 0.5–0.9 band. A converged-bus < 0.9 p.u. *advisory* (not error) is a worthwhile low-cost refinement, not a defect.

### A.2 Principal spot-check results (independent code verification)

1. **Critical double-count — CONFIRMED, mechanism airtight.** The chain: `plan_dispatch` schedules `q_disp = q_av·(p_disp/p_av)` into `injections` for every dispatched source (loadflow.py:1215-1218; battery discharge Q at :1263-1265). Every outer pass rebuilds `Q_spec = Q_base.copy()` then adds the dispatcher injections (:2044-2047). The clamp does `Q_base[bi] += (q_lim − u["inj_q"])/base_mva` with `inj_q` initialized to 0 (:1917, :1940), i.e. Q_base gains the **full** `q_lim` (:2135 gen, :2176 IBR) and the bus flips to PQ. Next pass the PQ bus is therefore held at `q_lim + q_disp` — while it was PV, `Q_spec` was a free variable, which is exactly why the defect only manifests post-clamp. At defaults (unit dispatched at full P), `q_disp = rated·sinφ = Q_max`, giving delivered Q = 2×Q_max — matching both reviewers' in-engine measurements. The revert path (:2146, :2182) subtracts `inj_q` symmetrically, so the defect is confined to the clamped state. Also noted: the **SVC loop (:2104) shares the `Q_base += (inj − inj_q)` pattern but is unaffected** — SVCs are not dispatched sources, so no scheduled `q_disp` exists to stack (neither reviewer stated this scope boundary explicitly; it confirms the defect is limited to dispatched generators/IBRs).
2. **`or q_cap` explicit-zero swallow (loadflow.py:1911-1912) — CONFIRMED.** `float(cp.get("q_max_mvar", q_cap) or q_cap)`: an explicit `0` yields `0 or q_cap → q_cap`. Same on the `q_min` line. A unity-pf "no vars" grid-code constraint cannot be expressed; the EE's demonstration (no clamp at all with q_max=q_min=0) is consistent with the code.
3. **Missing IBR warning loop — CONFIRMED** (grep): the warning builder at :2708-2717 iterates `gen_pv_units` only.
4. **Test-gap claim — CONFIRMED.** `test_pv_generator_clamps_at_q_max` (test_regression.py:2868-2884) asserts `converged`, `V < 1.0`, and that `round(q_cap,2)` appears **in the warning message text** — the delivered/solved Q is never asserted anywhere in the clamp tests. Both reviewers' explanation for the green 333-test suite is correct.

### A.3 What both reviewers missed or got wrong

- **Missed — fix-approach fragility.** The EE's suggested fix (`Q_base[bi] += (q_lim − q_disp_at_bus − inj_q)/base`) is subtly fragile: `Q_base` adjustments **persist across outer passes** while `q_disp` is **recomputed every pass** (dispatch re-runs with `loss_adders`, :2040-2041), so a Q_base-side subtraction can drift out of sync if dispatch changes after the clamp. Protection's first alternative — **zero the scheduled `q_disp` in the dispatcher for any unit whose bus is registered in `gen_pv_units`/`ibr_pv_units`** (harmless while PV since Q_spec is ignored there; correct when clamped; self-consistent every pass) — is the right implementation and should be the one adopted.
- **Missed — SVC scope boundary** (noted above): the identical code pattern at :2104 is *not* defective, so the fix should not touch it.
- **Nothing found materially wrong in either report.** All load-bearing claims checked reproduced exactly. Minor calibration notes: Protection's local Python 3.9 test failures are correctly attributed (repo targets 3.12; the EE's Docker run at 333/333 is the authoritative result); the EE understated the protection-facing consequence of the IBR-warning gap and the overhead 20 °C issue (adjudicated above); Protection's "Major" on the IBR warning and the EE's "Major (shared)" hybrid-PV clamp finding are the same defect family, merged in the register.

### A.4 Consolidated findings register

| # | Final severity | Location | Finding | Found by | Required action | Priority |
|---|---|---|---|---|---|---|
| 1 | **Critical** | loadflow.py:2135, 2176 (root: 1215-1218, 2044-2047) | Post-clamp reactive double-count: clamped PV-gen/voltage-mode-IBR bus delivers `q_scheduled + q_lim` (2×Q_max at defaults); optimistic post-clamp voltages; gen warning contradicts solution; IBR case silent, `solution_quality="ok"` | Both (independently, matching numbers) | Zero dispatcher `q_disp` for units registered in `gen_pv_units`/`ibr_pv_units` (preferred over Q_base-side netting — q_disp is recomputed each pass); add regression asserting delivered Q == q_lim (±tol) for gen and hybrid-IBR (irradiance>0, pf<1) clamped cases | **P1 — blocker** |
| 2 | **Major** | loadflow.py:2708-2717 | No reactive-limit warning for clamped `ibr_pv_units` — clamped inverter silently off-setpoint (confirmed: no IBR warning loop exists) | Both (EE Minor → raised) | Mirror the generator warning loop for IBR units | **P1 — same PR** |
| 3 | Minor | loadflow.py:1911-1912 | `… or q_cap` / `or -q_cap` swallows an explicit 0 override on both `q_max_mvar` and `q_min_mvar` — "no vars" constraint unexpressible (confirmed in code) | EE only | Explicit `is not None / != ""` check | **P1 — same PR** (one-liner) |
| 4 | **Major** | cable_sizing.py:714-718 + constants.js `STANDARD_OVERHEAD_LINES` | Overhead R at 20 °C with no temperature correction → VD/losses ~12-15 % optimistic at operating temp; code comment ("library stores operating-temperature values") false for the overhead library; asymmetric vs cable hot-correction path. Author-acknowledged, first-ranked in BACKLOG | Both (Prot Major upheld) | Apply `R(T)=R₂₀[1+α(T−20)]` for `construction=='overhead'` before overhead sizing verdicts are relied on | P2 |
| 5 | Minor | loadflow.py:2127-2129, 2168 | Demanded-Q attribution charges co-located dispatched Q against the regulating unit's box → premature clamp on mixed buses (partially mitigated by fix #1) | Both | Net off co-located dispatched Q in `q_gen`/`q_ibr`; verify after #1 lands | P3 |
| 6 | Minor | loadflow.py:1500-1514, 1450 + constants.js `FIELD_INFO['var_mode']` | Leading/absorbing pf unsupported in pf mode (Q floored at 0; negative pf → wrong sign in `_source_output_mva`); tooltip claims "supply/absorb" | Both | Signed-pf support or align tooltip/UI range | P3 |
| 7 | Minor | loadflow.py:2158-2187 | Clamp/revert oscillation can turn a solvable voltage-mode case non-convergent, with a misleading loadability message | Protection only | Clamp-latch after N flips; name the reactive-limit oscillation in the message | P4 |
| 8 | Minor | loadflow.py:25, `_assess_solution` | Converged buses in 0.5-0.9 p.u. band carry no warnings-list entry (canvas badge only); floor itself validated as sound by analytic two-root check | Both (as minor/obs) | Add advisory (not error) for converged energized bus < 0.9 p.u. | P4 |
| 9 | Minor | cable_sizing.py:649-657 | Overhead ampacity ignores run ambient (`derated_amps = rated_amps` even at 45-50 °C) | Protection only | Simple ambient scaler or result note | P4 |
| 10 | Minor | cable_sizing.py:833-853 | Recommend-on-fail can never suggest an overhead conductor (searches `STANDARD_CABLES` for `('Al','BARE')` — no match); fail verdict itself safe/correct | EE (Prot verified safe direction) | Search an overhead-line table backend-side when `overhead` | P4 |
| 11 | Minor | constants.js:942 / properties.js:2356-2360 | `prime_mover` tooltip says it doesn't change the model, but selection silently overwrites a hand-tuned `inertia_h_s` | Both | Reword tooltip or only auto-populate when H is at default | P4 |
| 12 | Minor | constants.js `PRIME_MOVER_INERTIA_H` | Diesel H=1.5 s is top of published band (0.5-1.5), not mid-range; slightly optimistic ride-through for gensets | Protection only | Consider 1.0 s; fix map comment | P4 |
| 13 | Minor | dbschedule.js:191 | Lagging-only Q (no leading pf); `Number(pf) || fallback` treats stored 0 as absent (unreachable via UI) | EE (Prot noted lagging-only) | Document; `!= null` guard; signed pf when load model allows | P5 |
| 14 | Observation | loadflow.py:2989; unbalanced_loadflow.py:576-579; loadflow.py:1487; constants.js `LF_ATTRS`; loadflow.py:1908; loadflow.py:1912 | Grouped: per-iteration SVD cond (also inside VS/contingency loops) and cond() outside the try; unbalanced solver discards `reason`; inverter rating ÷η convention; derived board pf still case-editable in LF_ATTRS; `rated_mva` default 0-vs-10 inconsistency; symmetric −Q_max UEL default | Both/various | Backlog items; none block | P5 |

Everything else on the branch — NR/GS solver correctness (independently validated to ~1e-9), Jacobian blocks vs textbook, singular-Jacobian trap, solution-quality gating, DB pf vector-sum rollup, overhead k-factors/Carson terms/fault-path integration (exact to the ampere), cable-fed motor Thevenin fix — is **verified correct by both reviewers with corroborating independent numbers** and is accepted as-is.

### A.5 Ship / no-ship recommendation

**NO-SHIP in current state.** Finding #1 is a Critical solver defect: any study in which a generator or inverter hits its reactive limit returns a physically impossible, non-conservatively optimistic solution — silently in the inverter case, and with a self-contradicting warning in the generator case. Findings #2 and #3 must land in the same PR (both are small, both live in the same code region, and #2 is required for the fixed clamp to be *visible*).

**Conditional ship after P1:** with #1–#3 fixed and the new delivered-Q regression assertions green (plus the existing 333-test suite), the branch is fit to merge. Finding #4 does not block merge (acknowledged, documented, net-new functionality, fault path standards-conformant) but must be scheduled before any overhead-feeder sizing sign-off is issued from this tool.

### A.6 Ordered remediation plan

1. **Fix the double-count at the dispatcher** (P1): skip/zero scheduled `q_disp` for any source whose bus index is registered in `gen_pv_units` or `ibr_pv_units` — their Q is solver- or clamp-determined. Do **not** patch it via `Q_base` subtraction (q_disp is recomputed every outer pass; Q_base persists — drift risk). Leave the SVC loop (:2104) untouched — it has no dispatched Q and is not affected.
2. **Add the IBR clamp warning loop** (P1, same PR): mirror loadflow.py:2708-2717 for `ibr_pv_units` with inverter-appropriate wording.
3. **Fix the explicit-zero override swallow** (P1, same PR): `is not None / != ""` handling at loadflow.py:1911-1912.
4. **Regression hardening** (P1, same PR): assert delivered/solved bus Q equals `q_lim` (±tol) in the clamped state for (a) the PV generator, (b) a voltage-mode hybrid PV with irradiance > 0 and pf < 1 (the currently untested path), and (c) explicit q_max = 0. Re-run the full suite in Docker per CLAUDE.md.
5. **Overhead R(T) correction** (P2): implement the BACKLOG `temperature_c` item for `construction=='overhead'`; correct the false code comment at cable_sizing.py:714-718.
6. **Q-attribution netting on mixed buses** (P3): re-test finding #5 after step 1; net off remaining co-located dispatched Q if still reproducible.
7. **Signed-pf / tooltip alignment** (P3): pick one — implement absorption in pf mode or constrain UI range and fix `FIELD_INFO['var_mode']`.
8. **Backlog batch** (P4–P5): clamp-latch anti-oscillation; < 0.9 p.u. converged advisory; overhead ambient scaler; overhead recommend-on-fail; prime-mover tooltip/overwrite guard; diesel H; LF_ATTRS derived-pf; grouped observations (#14). File in BACKLOG.md per project convention.

— **Principal Engineer (review of reviews)**

---

## Part B — Senior Electrical Engineer report (independent review)

**Method:** full diff review + surrounding-code reading, independent hand calculations (numpy), verbatim extraction and exercise of the NR/GS solvers against a hand-solved network, end-to-end engine runs inside the `protectionpro-backend` Docker image, and the full backend regression suite.
**Test suite result:** `backend/tests/` — **333 passed, 0 failed** (Docker, 185 s). `node --check` clean on changed frontend files. Test passage was *not* relied on as proof — and indeed one Major defect passes the suite.

### B.1 Storage-inverter reactive power (pf mode, voltage mode, source pf) — commit 6071ff5

**What the code does:** `_inverter_discharge_q` (`backend/analysis/loadflow.py:1500`) adds reactive to a battery/hybrid discharge in `power_factor` mode: `Q = P·√(1−pf²)/pf`, capped by the shared kVA circle `√(S²−P_total²) − |Q_already|`, injected in the dispatcher's discharge loop (loadflow.py:1263). `voltage` mode registers the bus as PV (loadflow.py:1930–1943) with a P-dependent circle limit enforced in the outer clamp loop; `unity` keeps legacy Q=0. Every `LoadFlowBranch` gains `pf = |P|/S` (schemas.py:789).

**Verification:**
- Hand calc: 30 kW @ 0.9 pf → Q = 0.030·tan(acos 0.9) = **14.530 kvar**. Engine run (Docker): PV badge Q = **14.50 kvar**, pf = 0.901, and the utility's Q import fell from 21.10 → 6.50 kvar (Δ = 14.60, consistent with load Q = 40·sin(acos 0.85) = 21.07 kvar + line losses). Reactive power balances.
- Circle edge: P = S_rated = 50 kW → headroom √(0.05²−0.05²) = 0 → engine returns Q = 0 despite pf = 0.9. Confirmed.
- Backward-compat: `unity` and pf = 1.0 both give Q = 0 exactly (`pf >= 1` early return, loadflow.py:1508) — legacy projects unchanged. Confirmed by run.
- Sharing with PV output: `q_room` subtracts `|q_already|` linearly — conservative when signs differ; correct when co-signed.

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Minor | loadflow.py:1508 | Leading/absorbing pf unsupported: `pf <= 0` returns Q = 0, and the pre-existing `_source_output_mva` (loadflow.py:1450) injects **+Q** for a negative pf. An inverter set to absorb vars (pf −0.95, allowed by the UI min −1) silently injects nothing / the wrong sign. | Interpret negative pf as Q-absorption (negative q_target) consistently in both places. |
| Minor | loadflow.py clamp loop 2160–2189 | A clamped voltage-mode inverter raises **no warning**, unlike a clamped generator — the "no longer holding setpoint" state is invisible for IBRs. | Emit the same warning for `ibr_pv_units` with `clamped != None`. |
| Observation | loadflow.py:1487–1496 | `_inverter_rating_mva` for solar divides `rated_kw` by `inverter_eff`, making the capability-circle radius ~3 % larger than the AC nameplate. Mirrors the pre-existing `rated_full` convention (internally consistent), but physically `P_ac = P_dc·η`. Pre-existing convention, not introduced here. | Align convention repo-wide in a dedicated pass. |
| Major (shared with §B.4) | loadflow.py:2160–2189 | A voltage-mode **hybrid PV with irradiance > 0 and pf < 1** inherits the §B.4 clamp double-count: the PV part's *scheduled* dispatch Q (`q_disp`, loadflow.py:1215) is re-added on top of the pinned `q_lim` once clamped to PQ. The shipped tests only cover irradiance = 0 (scheduled Q = 0), so this path is untested. | Same fix as §B.4. |

**Verdict: Correct with reservations** — pf mode verified correct end-to-end; voltage mode correct in its tested envelope but shares the §B.4 clamp defect and lacks a clamp warning.

### B.2 Singular / near-singular Jacobian trapping — commit c52213b

**What the code does:** before each NR linear solve, `not np.all(np.isfinite(J)) or np.linalg.cond(J) > 1e12` (loadflow.py:2989, limit at :34) breaks with `reason = "singular_jacobian"`; `LinAlgError` and non-finite `dx` are backstops. Solvers now return 4-tuples `(V, converged, iterations, reason)` threaded through `solve_with_islands` to both callers; `_assess_solution` emits a distinct actionable message; the break iteration is reported instead of `MAX_ITERATIONS`.

**Verification:**
- **Jacobian entries independently verified** against the standard polar-form NR (Kundur/Bergen-Vittal): all four blocks (J1 diag `−Q_i − B_ii V_i²` / off-diag `V_iV_j(G sinθ − B cosθ)`; J2 diag `P_i/V_i + G_ii V_i`; J3 diag `P_i − G_ii V_i²`; J4 diag `Q_i/V_i − B_ii V_i`) match textbook expressions exactly.
- **Solver exercised verbatim** (functions extracted from the file, run under numpy): 2-bus network (Z = 0.05+j0.10 pu, load 0.5+j0.2 pu) → NR converged in 4 iters to |V₂| = 0.9518397406, angle −2.4085°; independent fixed-point solution of `V₂ = V₁ + conj(S₂/V₂)·Z` gives 0.9518397404 — **agreement to 2×10⁻¹⁰**. GS agrees to 4×10⁻⁹.
- Singular case (PQ bus with zero admittance row + nonzero demand): trapped at iteration 1, `reason='singular_jacobian'`, no exception. Healthy solves report `reason=''`.
- Loading the 2-bus line past its nose (P = 2.4–3.0 pu): fails as `max_iterations` (NR oscillates rather than landing exactly on the boundary) — correctly *not* classified singular.
- Threshold sanity: float64 ε ≈ 2.2×10⁻¹⁶; at cond 10¹² the solve retains ~4 significant digits — a defensible "garbage beyond here" ceiling, 8+ orders above the healthy power-flow range (10¹–10⁴).

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Observation | loadflow.py:2989 | `np.linalg.cond` performs a full SVD **every NR iteration** — O(n³) per iteration, same order as the solve itself. Negligible at SLD scale; would matter at 1000+ buses. | If ever needed: estimate cond from the LU factors or check only on solve failure/large `dx`. |
| Observation | loadflow.py:2989 | `np.linalg.cond` itself can raise `LinAlgError` (SVD non-convergence, very rare) — that call sits *outside* the try/except. | Move the cond check inside the try. |
| Observation | unbalanced_loadflow.py:579 | The reason is received as `_solve_reason` and discarded — the unbalanced solver never surfaces the singular classification. | Pass the reason into the unbalanced warnings if desired. |

**Verdict: Verified correct.**

### B.3 Load-flow solution-quality classification — commit 80aa124

**What the code does:** `_assess_solution` classifies every solve: `non_converged` (with singular-specific or actionable infeasibility message), `low_voltage_root` (converged but an energized bus with `1e-6 < V < 0.5` p.u.), else `ok`. Warning prepended; new `LoadFlowResults.solution_quality` defaults `"ok"` (back-compatible); frontend shows an error-styled banner and status text.

**Verification:**
- Floor sanity: 0.5 p.u. is far below any operable point (~0.9–1.1 normal; even severely weak feeders > 0.7) and above typical lower-branch roots — the shipped test's 0.72 p.u. "weak but operable" not-flagged case is the right discrimination test.
- The `1e-6 <` lower bound plus `energized` guard correctly excludes de-energized islands (verified in test + code).
- Overload integration case: 10 MVA load behind 30 km of 0.3+j0.4 Ω/km at 11 kV — transfer-limit estimate ≈ 4 MVA scale, so the case is genuinely past the nose; suite confirms it classifies not-ok with the warning first in the list.
- Divergence run (2-bus, P = 3.0 pu) leaves a last iterate of V = 0.156 p.u. flagged `converged=False` → correctly takes the `non_converged` branch, not the low-root branch.

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Observation | loadflow.py:2996–3000 | The low-voltage scan runs on user-facing `bus_results` after synthetic-terminal-bus stripping; a collapse root manifesting *only* at a stripped synthetic bus would be missed (its feeding real bus is normally low too, so practical exposure is small). | Assess before stripping, or include synthetic buses in the scan. |
| Observation | loadflow.py:25 | Binary threshold: a converged 0.51 p.u. root reads "ok". Deliberately conservative per the comment; acceptable. A 0.5–0.8 "suspect" band could be a future refinement. | None required. |

**Verdict: Verified correct.**

### B.4 PV-generator reactive limits (PV→PQ clamp) — commit 5614f40

**What the code does:** each generator on a `bus_type: "PV"` bus registers a capability box `±rated_MVA·sin(acos pf)` (explicit `q_max_mvar`/`q_min_mvar` override; multiple gens sum) (loadflow.py:1906–1922). The outer loop measures demanded Q as `S_reg.imag·base + bus_load_q_mvar`, clamps PV→PQ at `Q_max`/`Q_min` via `Q_base[bi] += (q_lim − inj_q)/base` (loadflow.py:2126–2140), reverts on recovery, warns, and skips island-swing machines. The badge recovers solved Q for regulating-or-clamped buses (loadflow.py:2596).

**Verification (hand + engine):**
- Box default: 1 MVA @ 0.9 pf → Q_max = 0.4359 MVAr ✓ (hand calc matches code and warning text).
- Pre-clamp demanded-Q accounting (`net injection + local load Q`) is sign-correct; capacitor banks correctly netted via `bus_load_q_mvar`. Hold-within-box case verified end-to-end: 50 MVA machine holds V = 1.0500 with solved Q = −4.56 MVAr inside ±21.79.
- Swing exemption and revert-direction logic (over-excited + V > vset ⇒ revert; under-excited + V < vset ⇒ revert) are the classic PV↔PQ heuristic — correct.
- **Then the post-clamp power balance was checked, and it is wrong.**

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| **Major (defect)** | loadflow.py:2135–2136 (and 2176–2177 for IBRs) | **The clamped bus injects `q_lim` *plus* the generator's scheduled dispatch Q — double-counting reactive.** `plan_dispatch` injects `q_disp = q_av·(p_disp/p_av)` (loadflow.py:1215) at every bus. While the bus is PV, NR ignores Q_spec — harmless; the moment the clamp flips the bus to PQ and adds `q_lim` to `Q_base`, the scheduled `q_disp` becomes active on top of it. **Demonstrated in-engine:** default box → delivered Q = 0.8718 MVAr = exactly **2×Q_max** (0.4359); explicit q_max = 0.5 → 0.9359; q_max = 0.2 → 0.6359 — in every case `delivered = q_lim + rated·sinφ`. The warning text ("pinned at 0.44 MVAr") **contradicts the solution it accompanies.** The post-clamp bus voltage is optimistic (0.9403 vs 0.9341 p.u. correctly pinned in the test network; the error grows with machine size vs network stiffness). A physically impossible operating point is presented as a converged result. The shipped test `test_pv_generator_clamps_at_q_max` only asserts V < 1.0 and warning text, so the suite passes despite this. | Pin the **total** (subtract the bus's dispatched-source Q), or zero the dispatched Q of a clamped unit's sources each pass. Add a regression assertion that the clamped delivered Q equals the limit. Same fix applies to the IBR clamp. |
| Minor | loadflow.py:1911–1912 | `float(cp.get("q_max_mvar", q_cap) or q_cap)` — an **explicit 0 override is silently ignored** (`0 or q_cap` → q_cap). Demonstrated: q_max = q_min = 0 → no clamp at all, machine absorbs −4.56 MVAr freely. A "no vars" constraint (grid-code unity-pf machine) cannot be expressed. | `v = cp.get("q_max_mvar"); q_max = float(v) if v is not None and v != "" else q_cap`. |
| Minor | loadflow.py:2129 | Demanded Q attributes the *entire* unscheduled bus injection to the generator; a co-located pf-mode solar/battery's dispatched Q is misattributed → premature clamping on mixed buses. | Subtract co-located dispatched Q from `q_gen` before the box check. |
| Minor | loadflow.py:1912 | Default under-excitation limit −Q_max (symmetric box) is generous vs. real machines (UEL typically 40–60 % of Q_max, end-region heating). Documented and overridable — acceptable as a default. | Note asymmetry in FIELD_INFO, or default q_min to −0.5·Q_max. |
| Observation | loadflow.py:1908 | `rated_mva` default here is 0 (→ zero box, instant clamp-to-0) while `_source_output_mva` defaults it to 10 — inconsistent for API-only payloads lacking the prop. Frontend always writes `rated_mva`, so no UI exposure. | Use the same default. |

**Verdict: Defect found** (Major — post-clamp Q double-count; feature warns correctly but still solves with reactive the machine cannot supply).

### B.5 Distribution-board per-circuit PF rollup — commit fe3d3c0

**What the code does:** `DBSchedule.recompute` (frontend/js/dbschedule.js:188–209): per way, diversified `d = VA·DF`, then `P += d·pf`, `Q += d·√(1−pf²)`; board pf = `ΣP/hypot(ΣP,ΣQ)` written to `props.power_factor` (3 dp), which load flow, diversity, cable sizing and PDF already read. Lazy `_ensurePf` migration; per-way PF column/bulk-edit/paste/Excel; presets seed typical pf; board pf becomes read-only-derived.

**Verification (hand calcs):**
- It is a true **complex-power vector sum, not a pf average**: 100 VA @ 1.0 + 100 VA @ 0.6 → P = 160, Q = 80, pf = 160/√(160²+80²) = **0.89443** (matches; a naive average would be 0.80 — correctly not that).
- **Diversity invariance is mathematically exact**: board diversity scales P and Q identically, cancelling in the ratio (verified numerically). Per-way DF is *not* invariant — correctly applied before the split.
- **Legacy reproduction is exact**: uniform seeded pf 0.9 across ways of any VA/DF mix → rollup returns 0.9 identically. The only deviation is 3-dp rounding of a legacy > 3-dp board pf — negligible.
- Fallback chain (`Number(c.power_factor) || pfFallback`, empty board leaves prop untouched, PDF `way pf → board pf → 0.85`) is coherent.

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Minor | dbschedule.js:191 | **No leading-pf support** — Q is always positive (lagging). A capacitive circuit (PFC, some LED/electronic loads) cannot be represented; a mixed leading/lagging board would overstate net Q. Consistent with the rest of the app's load model, but a modelling limit worth documenting. | Allow signed pf (or a lead/lag flag) when the load model gains signed Q. |
| Minor | dbschedule.js:191 | `Number(c.power_factor) || pfFallback` treats a stored 0 as absent; unreachable via UI (clamp ≥ 0.05) but an imported/hand-edited 0 silently becomes the fallback. | Explicit `!= null` check. |
| Observation | constants.js LF_ATTRS | The Load Flow Study Manager grid still lists `power_factor` as an editable board attribute although it is now derived (a case override would be silently overwritten on next schedule open). | Remove from `LF_ATTRS.distribution_board` or mark read-only. |

**Verdict: Verified correct.**

### B.6 Overhead-line feeders: model (d30d67f) + cable sizing (808d5f7)

**What the code does:** `construction: 'overhead'` swaps the type selector to `STANDARD_OVERHEAD_LINES` (16 ACSR/AAAC codewords, R₁/X₁/R₀/X₀ + in-air rating), populating the same r/x/rating props the engines read (no backend model change). Cable sizing resolves overhead as bare Al: area from 20 °C resistivity (cable_sizing.py:425), rating used underated (:649–657), new bare k-factors 84/129 with MAX_TEMP BARE = 200 °C.

**Verification (hand calcs):**
- **k-factors reproduce from IEC 60949/60865 constants**: k = K·√ln((β+θf)/(β+θi)); Al (K=148, β=228), 80→200 °C → **84.9** (code 84, rounded down = conservative); Cu (K=226, β=234.5) → **128.5** (code 129, +0.4 % — within rounding). Cross-check against the existing insulated table: Al XLPE 90→250 °C → 94.5 (table 94), Cu → 143.1 (table 143) — same constants family. ✔
- **Wolf area**: ρ_Al20 = 0.0282 → S = 150.7 mm² vs actual Wolf Al area 158.1 mm² — 5 % low because ACSR stranding/steel core raises R above the equivalent solid-Al value; a *smaller* derived area is conservative for the adiabatic check. ✔
- **Library internal consistency**: R₀−R₁ = 0.147–0.150 Ω/km across entries = 3× the Carson earth-return resistance at 50 Hz (0.148 Ω/km) ✔; X₀/X₁ ≈ 3.5 (typical no-earth-wire) ✔; ratings plausible (Squirrel 107 A, Wolf 405 A, Zebra 730 A still-air 75 °C class) ✔.
- Not derating the in-air rating by IEC 60364-5-52 tables is correct — those tables are for installed insulated cables. `num_parallel` handled consistently. An applied underground `ampacity` block is correctly ignored once the feeder is overhead.
- Edge "no library entry": a custom overhead feeder keeps generic defaults — no crash, thermal check still runs off `rated_amps`.

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Minor | cable_sizing.py:425 + constants.js library | Overhead R is 20 °C while the cable library stores hot values: overhead **load-flow losses / voltage drop read ~15-25 % optimistic** in a mixed study (α_Al ≈ 0.004/K). Explicitly logged in BACKLOG.md with the correct fix as the first-ranked follow-up — acknowledged, not silent. | Implement the backlog `temperature_c` item. |
| Minor | cable_sizing.py:833–853 | The recommend-on-fail path searches `STANDARD_CABLES` for `('Al','BARE')` — never matches — so a failing overhead line always gets the generic "No standard cable size satisfies all checks…" instead of suggesting the next codeword conductor. Fail verdict itself is still correct. | Search `STANDARD_OVERHEAD_LINES` (backend needs a copy) when overhead. |
| Observation | cable_sizing.py:118–127 | Overhead is hard-assumed aluminium; a legacy copper OH line can't be represented (`('Cu','BARE')=129` exists but is unreachable). | With a Cu OH entry, honour an explicit `conductor` prop. |
| Observation | constants.js:1609–1640 | X₁ is a fixed "typical spacing" value and Z₀ has no soil-resistivity/earth-wire dependence — both explicitly caveated in the library comment and ranked in BACKLOG. | Backlog items already filed. |

**Verdict: Verified correct** (numerically sound and conservative; fidelity limits documented by the author).

### B.7 Dynamic motor starting fixes — cable-fed motors (431cb65) + prime-mover inertia (6c100e0)

**What the code does:** `run_dynamic_motor_starting` now calls `insert_implicit_load_buses` first (dynamic_motor_starting.py:849–850), so a motor behind a feeder gets a synthetic terminal bus: the Thevenin walk now **includes the feeder impedance**, and `_baseline_voltages` runs with `include_synthetic=True`. Prime mover: frontend-only `prime_mover` select whose change writes `PRIME_MOVER_INERTIA_H[value]` into `inertia_h_s` (properties.js:2356–2360); placement default H 4 → 1.5 s.

**Verification:**
- `insert_implicit_load_buses` verified to **deep-copy** (no caller-side mutation) and to be idempotent; truly isolated motors still warn. Synthetic bus voltage falls back load → series neighbour → 0.4 kV.
- The physics claim holds structurally: pre-fix the walk stopped at the cable (motor skipped); post-fix the cable is a branch between the real and synthetic buses, so both Z_th and V_pre include the feeder. Regression test passes (30-test dynamic suite green).
- **H values vs literature** (Kundur §3.9 / IEEE 3002.3 bands): diesel 1.5 s (0.5–2 ✔), gas engine 1.0 ✔, gas turbine 4.0 (heavy-frame 3–5 ✔), steam 6.0 (4–9 ✔), hydro 3.0 (2–4 ✔), wind 3.0 (rotor H plausible, though converter-decoupled). `other` intentionally absent → H untouched ✔. Legacy projects keep stored H ✔.

**Findings:**

| Sev | Ref | Description | Fix |
|---|---|---|---|
| Minor | constants.js:942 vs properties.js:2356 | The `prime_mover` tooltip says it "does not change the electrical model … set H explicitly", but selecting one **overwrites `inertia_h_s`**, silently clobbering a hand-tuned H. | Reword tooltip, or confirm before overwriting a non-default H. |
| Observation | dynamic_motor_starting results | `terminal_bus` now carries the synthetic id/name ("M terminal") for cable-fed motors — a visible naming change, arguably desirable. | None needed. |

**Verdicts:** cable-fed motor fix — **Verified correct**; prime-mover inertia — **Correct with reservations** (values sound; tooltip/overwrite UX inconsistency).

### B.8 Overall summary (EE)

| Area | Verdict |
|---|---|
| Inverter reactive (pf / voltage / source pf) | Correct with reservations |
| Singular Jacobian trapping | **Verified correct** (solver independently validated to 1e-9) |
| Solution-quality classification | **Verified correct** |
| PV-generator reactive limits | **Defect found** — clamped bus delivers `Q_limit + scheduled dispatch Q` (exactly 2×Q_max at defaults) |
| DB per-circuit PF rollup | **Verified correct** |
| Overhead lines + sizing | **Verified correct** (documented fidelity limits) |
| Dynamic motor fixes / prime-mover H | Verified correct / correct with reservations |

The single item requiring action before this branch ships as-is is the clamp double-count: the PV→PQ clamp does not actually enforce the limit it warns about. The fix should be paired with a regression assertion that the delivered Q equals the limit — the current tests assert only warning text and V < 1.0, which is how this slipped through a green 333-test suite. Everything else verified is numerically sound, conservative where it approximates, and genuinely backward-compatible.

— *Senior Electrical Engineer (independent review)*

---

## Part C — Senior Protection Specialist report (independent review)

**Method:** code inspection, independent hand calculations (IEC 60909 / IEC 60865 / adiabatic k / P-V two-root analytics), and live behavioural probes against `run_load_flow`, `run_fault_analysis`, `run_cable_sizing`, and `run_dynamic_motor_starting`. New-feature backend test suites re-run locally (22/22 pass; 3 unrelated failures in `test_dynamic_motor_starting.py::TestIntegrations` are a local Python 3.9 environment artifact — repo targets 3.12).

### C.1 Storage-inverter reactive power (pf mode & voltage mode) + source PF — commit 6071ff5

**What it does:** adds `var_mode` (`power_factor` / `voltage` / `unity`) to battery and solar-PV inverters. In pf mode, battery discharge injects Q = P·tan(acos pf) bounded by the kVA circle √(S²−P²) shared with any PV output (`_inverter_discharge_q`, loadflow.py:1500). In voltage mode the bus becomes a PV bus regulated to `v_setpoint_pu`, clamped PV→PQ at the P-dependent circle (loadflow.py:2158). Every branch/source result gains a calculated `pf = |P|/S`.

**How verified:** hand-calc of Q targets and circle headroom (30 kW @ 0.9 → 14.53 kvar, circle 41.9 kvar — matches solver to < 0.5 kvar); mode-comparison probes (unity vs pf vs voltage) on a weak 0.4 kV feeder; capability-circle audit of the clamped solution.

**Findings:**

**[CRITICAL] Post-clamp reactive double-count — clamped voltage-regulating sources inject up to 2× their physical capability**
(loadflow.py:1215-1218 dispatcher pf-split Q vs :2135/:2176 clamp pins.) The dispatcher schedules every dispatched source's pf-split Q into the bus injections on **every** pass. While the bus is PV this is harmless; the moment the reactive-limit loop clamps PV→PQ, the pinned `q_lim` is **added on top of** the still-scheduled `q_disp`.

Reproduced and measured:
- Voltage-mode hybrid PV, irr 100 %, pf 0.9, 50 kVA inverter, clamped: delivered **Q = 43.6 kvar against a 21.8 kvar circle** (exactly 2×); PCC voltage reported 0.8446 p.u. vs 0.7669 (unity) — an optimistic phantom lift, returned `converged=True, solution_quality="ok"`, **no warning**.
- PV-bus generator, 1 MVA @ 0.9 rated pf (Q_max = 0.436 MVAr), clamped: delivered **Q = 0.872 MVAr = 2×Q_max**; the warning says *"pinned at 0.44 MVAr"* while the solution carries 0.87; gen-bus voltage 0.9403 p.u. correspondingly optimistic.

Protection consequence: voltages downstream of any clamped machine/inverter are wrong on the **unsafe side**, so under-voltage element settings, over-excitation assessments and voltage-collapse margins taken from a clamped case cannot be trusted; the reported machine Q (2× nameplate) corrupts any var-based protection review. The repo's own tests pass because they only assert warning text and V < setpoint — never that delivered Q respects the box.
*Recommendation:* zero the scheduled `q_disp` for any unit in `gen_pv_units`/`ibr_pv_units`, or pin the clamp at `q_lim − q_scheduled`. Add a regression asserting delivered branch Q ≤ Q_max (+tol) in the clamped state.

**[MAJOR] Clamped voltage-mode inverter raises no warning** (loadflow.py:2708-2716 covers `gen_pv_units` only). A clamped inverter silently stops holding its setpoint — the exact "hidden infeasibility" failure mode this branch set out to surface for generators. *Recommendation:* mirror the generator warning for clamped IBR units.

**[MINOR] Pf mode is export-only; tooltip claims supply/absorb** (loadflow.py:1500-1514 floors Q at 0 and returns 0 for pf ≤ 0; `FIELD_INFO['var_mode']` says "supply/absorb VArs"). Align doc or implement signed pf.

**[MINOR] Clamp/revert loop can turn a solvable network non-convergent** — battery-only voltage-mode probe (irr 0, vset 1.05, 100 kVA @ 0.7 load) diverges while the identical unity-mode network converges; flagged, but the message blames loadability rather than reactive-limit oscillation. Consider a clamp-latch after N flips.

**[OBSERVATION]** Inverter kVA rating divides by efficiency (~3 % circle inflation, pre-existing convention). **[OBSERVATION]** Branch `pf` is unsigned (|P|/S) — acceptable since signed P and Q are displayed alongside.

**Verdict: DEFECT FOUND** (critical double-count at the clamp; pf-mode itself verified correct within limits).

### C.2 PV-generator reactive limits, over/under-excitation, PV→PQ — commit 5614f40

**How verified:** convention audit; hand-calc Q_max (1 MVA @ 0.9 → 0.436 MVAr, matches the warning); clamp probe (above); repo tests re-run (4/4 pass).

**Findings:**
- **Convention check — correct.** `q_max` (+) = over-excited var export, `q_min` (−) = under-excited absorption; clamp comparisons and the revert heuristic are the classic PV↔PQ switching logic on the correct sides. Warning text names the correct regime. Swing exemption correct.
- **[CRITICAL — shared with C.1]** The clamp double-count applies identically (measured 2×Q_max).
- **[MINOR]** Q attribution assumes the generator owns all bus reactive (loadflow.py:2129) — a co-located pf-mode inverter's scheduled Q is charged against the generator's box. Edge case; document or net it off.
- **[OBSERVATION]** Default box is a rectangle ±Q_cap independent of dispatched P — no D-curve derating; matches standard Q-limit load-flow practice; acceptable with explicit overrides available.

**Verdict: DEFECT FOUND** (same root cause as C.1; convention and switching logic otherwise verified correct).

### C.3 Solution-quality classification (80aa124) + singular-Jacobian trap (c52213b)

**How verified:** load sweep on a weak 11 kV feeder to bracket the nose; analytic two-root solution of the P-V quadratic to identify which root NR returned; message-distinctness and 4-tuple contract via the repo tests; frontend threshold check.

**Findings:**
- **The 0.5 p.u. floor is a sound choice — verified analytically.** A converged 0.611 p.u. probe reported `ok`; solving the P-V quadratic by hand gives roots at 0.611 / 0.406 p.u. — the solver was on the **genuine upper root** of a grossly overloaded feeder, so flagging it would have been a false positive.
- **[MINOR]** A converged near-nose result in the 0.5–0.9 band carries no warnings-list entry — the only cue is the canvas "LOW" badge (canvas.js:1572-1580) and the results tables. A true low root above 0.5 (possible with leading-pf/compensated loads) would pass as `ok`. *Recommendation:* advisory (not error) for any energized bus < 0.9 p.u. on a converged solve.
- **[MINOR]** unbalanced_loadflow.py:576-578 discards the `reason` — the unbalanced solver cannot distinguish singular-Jacobian from ordinary divergence.
- **[OBSERVATION]** Gauss-Seidel never reports `singular_jacobian` (documented). **[OBSERVATION]** `np.linalg.cond(J)` (full SVD) runs every NR iteration — also inside voltage-stability and contingency loops; consider a cheap estimate if large studies slow down.
- **Safety-critical question answered:** a near-singular or diverged case **cannot** be silently presented as valid — `converged=False` + prepended warning + red UI banner. Residual silent risk is confined to the 0.5–0.9 band.

**Verdict: CORRECT WITH RESERVATIONS.**

### C.4 Overhead-line feeder model + cable sizing for overhead — commits d30d67f, 808d5f7

**How verified (independent calculations):**
- **k-factors exact:** IEC 60865/BS 7671 form k = K√ln((θf+β)/(θi+β)) gives Al 84.9, Cu 128.5 for 80→200 °C — matches 84/129 (Al rounded conservatively down). Same formula reproduces the insulated table values exactly.
- **Library constants plausible and internally consistent:** Wolf R₁ = 0.1871 Ω/km is the published 20 °C value; back-derived area 150.7 mm² vs true 158.1 mm² — 5 % under-statement, conservative for the withstand check. R₀−R₁ ≈ 0.145–0.150 Ω/km matches the Carson earth-return term 3ω·μ₀/8 = 0.148 Ω/km at 50 Hz exactly; X₀/X₁ = 3.5 uniformly — reasonable no-earth-wire lumped value (caveat documented).
- **Fault-engine integration exact:** hand IEC 60909 calc through 2 km of Wolf from a 500 MVA / X/R 15 source: Ik3(B2) = 6.937 kA and SLG Ik1 = 4.482 kA (2Z₁+Z₀, c = 1.1) — both match `run_fault_analysis` **to the ampere**. Overhead lines and cables treated identically by the fault engine (fault.py:812-814, 1098-1107); per-km scaling and `num_parallel` confirmed.
- **Recommend-on-fail safety:** a failing overhead line cannot be "recommended" an underground cable — clear failure reported. Safe direction.

**Findings:**
- **[MAJOR — acknowledged in BACKLOG] Overhead R at 20 °C makes voltage-drop (and losses) systematically optimistic** (cable_sizing.py:714-718). At 75 °C conductor, R is ×1.222 (α_Al = 0.00403); for Wolf at pf 0.9 total VD is understated ~12 %. A marginally passing overhead feeder can exceed the VD limit in service — and the internal-recommendation path corrects cable R to hot (cable_sizing.py:930) while the overhead check never does. Apply `R(T) = R₂₀·[1+α(T−20)]` for overhead before any sizing sign-offs use overhead feeders.
- **[MINOR]** Ambient temperature ignored entirely for overhead thermal rating (`derated_amps = rated_amps` even at 45 °C; library assumes ~40 °C). Recommend a √((75−T_amb)/(75−40)) scaler or a result note.
- **[MINOR]** Fault-withstand initial temperature (80 °C) vs rating basis (75 °C) — internally consistent and conservative. No action.
- **[OBSERVATION]** IEC 60909 temperature consistency runs the right way for overhead (60909-0 prescribes 20 °C for Ik_max). Neither engine offers an Ik_min (hot-conductor) mode for protection-sensitivity/earth-fault-reach studies — worth a BACKLOG entry.
- **[OBSERVATION]** `num_parallel` divides Z₀ with no mutual coupling — understates double-circuit earth-fault Z₀; already top of the BACKLOG list.

**Verdict: CORRECT WITH RESERVATIONS** (fault path and k-factors verified exact; VD/ampacity optimism at temperature is real, non-conservative, and acknowledged but unfixed).

### C.5 Dynamic motor starting: cable-fed motors + prime-mover inertia — commits 431cb65, 6c100e0

**How verified:** directional probe — 150 kW / 0.4 kV DOL motor, direct vs through 150 m of cable: peak current 1524 → 1330 A, accel time 0.415 → 0.575 s, terminal bus = synthetic. Physically correct direction: the feeder impedance *reduces* the starting current the upstream relay sees and *deepens* the terminal dip. Before the fix this motor produced **no result at all**. H values checked against published bands.

**Findings:**
- **Fix verified correct.** Idempotent; truly isolated motors still skipped with the warning. Feeder in the Thevenin is required physics for contactor drop-out and 27/48 assessment at the motor terminal.
- **[MINOR]** Diesel H = 1.5 s is the top of the published band (0.5–1.5), not "mid-range" as the map comment claims — small-diesel transient-stability results skew slightly optimistic. Recommend ≈ 1.0 s. Gas turbine 4.0, steam 6.0, hydro 3.0, gas engine 1.0 — all plausible.
- **[MINOR]** Tooltip contradicts behaviour — selector silently overwrites a hand-tuned `inertia_h_s`.
- **[OBSERVATION]** Wind H = 3.0 s physically reasonable but converter-decoupled in practice; harmless metadata.

**Verdict: VERIFIED CORRECT** (cable-fed fix); **correct with reservations** (inertia auto-populate).

### C.6 Distribution board per-circuit PF rollup — commit fe3d3c0

**How verified:** independent vector-sum calc (1000 VA @ 1.0 + 1000 VA @ 0.6 → 0.894, matches); back-compat algebra (uniform pf ways roll up to exactly that pf — legacy board values reproduce byte-for-byte); traced the derived pf into load flow / cable sizing (all consume `props.power_factor` unchanged).

**Findings:**
- **Rollup mathematics verified correct** — the P/Q vector sum is the right aggregation and diversity-invariance holds.
- **[MINOR]** Lagging-only assumption — a leading (capacitive) circuit cannot be represented; pf floored at 0.05. Almost always fine for LV boards; note in the PF column tooltip.
- **[OBSERVATION]** Preset pf values (geyser/stove 1.0, lighting 0.95, motors/aircon 0.85, EV 0.98) are reasonable defaults; PDF fallback chain sensible.

**Verdict: VERIFIED CORRECT.**

### C.7 Overall summary (Protection)

**Release blocker:** the reactive-limit clamp double-count. Until the dispatcher's scheduled Q is netted out of clamped buses, any study in which a generator or inverter hits its reactive limit reports voltages that are optimistically high and machine reactive outputs up to twice physical capability — with the generator warning actively misstating the pinned value and the inverter case silent. Under/over-voltage settings, reverse-power/var-based checks, and collapse margins must not be taken from a clamped case on this build. Everything the branch ships for **unclamped** operation — pf-mode var injection, fault-engine treatment of overhead lines, bare-conductor withstand constants, motor-fix Thevenin, solution-quality gating — verified correct against independent hand calculations.

Secondary priorities: (1) overhead-line R temperature correction before overhead sizing verdicts are relied on; (2) mirror the clamp warning for inverters; (3) advisory for converged buses in the 0.5–0.9 p.u. band.

— *Senior Protection Specialist (independent review)*

---

*Document compiled 2026-07-19. Review artifacts: full branch diff (`git diff main..feat/inverter-reactive-and-jacobian`), Docker test run (333/333 pass), independent reviewer worksheets.*
