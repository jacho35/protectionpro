# Review of the ProtectionPro Verification System

**Date:** 2026-09-27
**Scope:** Read-only audit of the app's verification & validation (V&V) apparatus — correctness of
its claims, quality of its tests, sync of its artifacts, and honesty of its coverage claims.
**Method:** re-ran the backend suite and the independent new-features harness in the backend Docker
image; diffed the generated template file against its sources; re-ran the 2026-09-20 audit probes;
read the regression tests' hand-calculations against the code; cross-checked every scorecard/claim
against the source tree. No code was modified.

---

## 1. What the verification system consists of

| # | Layer | Location | Size / state |
|---|---|---|---|
| 1 | Standards-anchored regression suite | `backend/tests/` (36 files) | **917 tests, all pass** (re-ran 2026-09-27, 6:49 in `protectionpro-backend`) |
| 2 | Core regression file | `backend/tests/test_regression.py` | 292 tests in 51 classes, each pinning a standard equation or hand calc |
| 3 | Per-engine V&V cases | `testing/case-*/` (16 cases) | each: reproducible `project.json` + `results.md` + headless-app screenshots; scorecard in `testing/README.md` |
| 4 | Independent harness for newer engines | `testing/case-new-features-verification/` | 21 closed-form checks; **21/21 PASS on re-run** |
| 5 | In-app V&V report | `frontend/verification.html` + Help → Verification tab | 19 case cards; linked from Help |
| 6 | In-app verification templates | `frontend/js/verification-templates.js` | 15 loadable templates, generated from `testing/case-*/project.json` |
| 7 | Audit history & review chain | `audit-history/` | 6 dated rounds with an explicit authority order (`audit-history/README.md`) |
| 8 | Reproduction probes for the last audit | `audit-history/probes-2026-09-20/` | 3 scripts; **re-ran: all outputs match the recorded "post-fix" values** |
| 9 | CI | `.github/workflows/backend-tests.yml` | pytest on every PR / push to main |
| 10 | Headless-app verification methodology | `.claude/skills/verify/SKILL.md` | browser-driving playbook; frontend-only, manual |

---

## 2. What was verified in this review (all checks made, results)

1. **Backend suite green.** `917 passed, 23 warnings in 409 s` in the official Docker image. The
   only warnings are deprecations (`on_event`, FPDF `ln=`), none in analysis code paths.
2. **Templates are in sync.** Loaded `verification-templates.js` via Node, compared every template's
   embedded project against its `testing/case-*/project.json` source, normalising the three fields
   the generator sets (`projectName`, `voltageFactor`, `projectDetails`). **Zero drift**; meta/data
   ids agree 15/15; order matches the generator's `CASES`; `dataVersion: 2` stamped on all; the
   four SC templates carry the verified voltage factor (1.0/1.0/1.0/1.1).
3. **Independent new-features harness passes today.** 21/21 (frequency scan, filter, reliability,
   voltage stability, hosting capacity, CT model, battery sizing, cap placement, OPF, contingency,
   EE-10 two-port, flicker). Worst error 5.3 % (cap placement) — documented as the discrete-bank /
   constant-susceptance model, inside its stated 12 % allowance.
4. **The audit→probe→fix→pin loop is real.** The 2026-09-20 defects (F-1 cable pu-base, N-1
   `num_parallel` divide, R-1 blast radius) were re-run via the probes: the previously-broken
   outputs (V identical across `num_parallel` 1/2/4; 756× pu-base error) are now correct in the
   current image, and the fixes are pinned by `TestCableZoneBase` (5), `TestCableParallelDivide`
   (3) and `TestCableZoneWarning` (2) — which state in their docstrings that each failed before the
   fix. `BACKLOG.md` records the remediation chronology with suite counts (859 → 867 → 869 → 873).
5. **Hand-calculations are genuine, not engine echoes.** Spot-checked anchors:
   - `test_ik3_infinite_bus` — 500/(√3·11) = 26.24 kA, with the pre-fix 1.1× bug documented;
   - fault-type identities (√3/2·Ik3, 0.75·Ik3, 0.6·Ik3 for Z0=2Z1) — correct IEC 60909 relations;
   - IEEE 1584-2002 E at 610 mm/0.2 s worked out digit-by-digit in the docstring;
   - IEEE 1584-2018: six fixtures from the official validation spreadsheet, all 5 electrode
     configs, all 3 voltage-blend regions, both max and reduced-arcing passes, to rel 1e-5/1e-4;
   - IEEE 80: Eq. 84–88 `n`, `K_ii`, rod-weighted `L_M` (1786.4 m vs the old 1690), two-layer
     limits (ρ_eq→ρ1/ρ2) and Wenner forward/limit behaviour;
   - SMIB CCT vs the equal-area closed form; P-V nose vs E²/(2X)·cosφ/(1+sinφ); contingency vs an
     independent lossless 2-bus solve (157.5 % survivor loading); Thevenin grid sag vs the two-bus
     quadratic (abs 5e-4).
6. **Test-quality discipline is unusually good.** 290 of the 292 core approx tolerances are ≤5 %
   and 193 of them ≤0.5 %; the handful of loose ones (rel ≤ 0.06) are documented as
   solver/discretisation residuals. Self-referential checks (Wenner fit against its own forward
   model; hosting-capacity boundary re-checked via direct `run_load_flow`) are **explicitly
   labelled** as algorithm-consistency tests, not independent physics checks — the honest framing.

---

## 3. Findings

### V-1 [MEDIUM] — Engine-count claims are inconsistent and, read strictly, overstated

Three documents state three different numbers:

| Document | Claim |
|---|---|
| `testing/README.md` (Coverage §) | "**All twelve** analysis engines are now cross-checked" |
| `frontend/verification.html` | "Every one of ProtectionPro's **sixteen** analysis engines is cross-checked" · metric card "**16 / 16** engines cross-checked" |
| `frontend/index.html` (Help → Verification) | "All **sixteen** analysis engines are cross-checked…" |

Actual count: `backend/analysis/` holds **46 modules** (~30 user-facing analysis endpoints,
38 `@router.post` routes in `routes/analysis.py`); `frontend/js/constants.js` defines **40
component types** (CLAUDE.md still says 18). The scorecard's 16 are the original SC(4 rows count
one engine)/cable/LF/unbal/AF/gnd/motor/duty/div/DCLF/DCSC/DCAF/TS/VS/cont/dynmot set.

The honest position is close and the Help tab does disclose the split ("the stability, contingency
and dynamic-motor cases are anchored to the backend regression suite") — but several engines have
**no independent-reference check in either channel**, only engine-consistency or smoke coverage:
harmonics, SVC, autotransformer/OLTC (engine-consistency only), time-series LF, loadflow-cases,
db-circuit-check (IEC 60364 tables are twin-table-pinned), raceway, backup autonomy, ADMD
(source-app ported formulas). And the `testing/` dual-channel (engine + headless screenshot)
was performed for only the cases with screenshots; `case-new-features-verification` has none.

**Recommendation:** state the real numbers (e.g. "16 engines verified against external references,
14 further engines pinned to hand-derived invariants in test_regression.py — 0 untested"), or make
all three documents agree on one enumeration with an explicit "not independently verified" column.
The current wording invites the reading that every engine has a standards cross-check.

### V-2 [MEDIUM] — The frontend is verified only by one-off scripted sessions; nothing re-runs it

There are **no automated frontend tests** (the `verify` skill says so itself; the only gate is
`node --check`). The dual-channel UI screenshots date from 2026-07-11 and cannot be re-verified
mechanically — a re-render regression in symbols.js/canvas.js, or a template-loading regression,
would surface only by manual re-driving. The backend suite and the 21-check harness are CI-covered
or one-command; the frontend channel is neither. (This review also cannot view the PNGs — image
input unsupported in this session — so the "genuine renders" claim rests on file inspection only.)
**Recommendation:** keep a checked-in Playwright script per verification template (load → run →
assert headline number) so the UI channel is re-runnable in CI, not archived screenshots.

### V-3 [MEDIUM] — CLAUDE.md is a stale second source of truth

Known-wrong items the `verify` skill itself has to warn against, plus more found here:
- `AppState.analysisResults` documented at CLAUDE.md:152/373 — **does not exist at runtime**
  (SKILL.md:79 documents this; each study uses its own field, confirmed at `app.js:757-761`);
- "Component Types (18)" — constants.js has **40** defs;
- the `## Testing` section names only `test_regression.py`, implying it is the suite, while the
  suite is 36 files / 917 tests (CI runs all of them);
- `AppState.mode` doc omits lowercase values actually used; `nextId` counter description
  ("auto-incrementing integer") vs `id: 'utility-1'` string ids in practice.
A new contributor reading CLAUDE.md alone would form wrong models of state and coverage. The
verify skill is the corrective — but it lives in `.claude/`, not in CLAUDE.md.

### V-4 [LOW] — The 21-check harness is not in CI

`verify_new_features.py` is the fastest independent engine cross-check in the repo (runs in
seconds, needs only the backend image) yet `.github/workflows/backend-tests.yml` runs only
`pytest backend/tests/`. Adding it (plus the three probes as canary assertions) would guard the
newer engines at zero maintenance cost.

### V-5 [LOW] — Template "expected result" strings are hand-typed and unverified

The 15 templates' instructions bake expected numbers (e.g. "Expected I″k3 ≈ 12.88 kA") as text.
If an engine changes, nothing flags the stale string — the number is verified only if someone
re-runs the case. Low risk (the engines themselves are test-pinned), but a template whose
expected value silently drifts undermines the trust the feature is meant to project.
**Recommendation:** generate those strings from the same `results.json`/cases the generator
already reads.

### V-6 [LOW] — A few tests assert bands, not points, where a point is available

Examples: the motor-dip band `4.0 < dip < 13.0` (expected ≈7 %) and the flicker engine reuse of
the same band. The bands are documented and the width is justified (iterative solver), but a
regression from 7 % to 4.5 % — a 36 % error — would pass. The docstrings say exactly this, so
this is a known, disclosed trade-off, not a defect. Worth a point-value companion assert where a
closed form exists (the Thevenin-sag test already shows the pattern, abs 5e-4).

### V-7 [INFO] — Scorecard arithmetic is right where it counts

- "16/16 short-circuit points PASS": 3 cases × 4 fault types + 4 SC-2 faults = 16 ✓; worst error
  0.13 % ✓ (matches case-3 table).
- "0.00 %" SC-2 row matches `case-sc2-220-33kv/results.md` ✓ — and the finding that the article's
  own hand-calc mixes bases is a genuine, checkable claim (ETAP 2.296 vs article 1.9675@c=1.0).
- "≤0.002 pu / 0.04°" 3-bus LF matches `case-loadflow-3bus/results.md` ✓.
- Discrepancy register items #8, #9 marked **Resolved** are actually resolved (full Eq. 84–88 in
  `grounding_system.py`; IEC 61660 factors in `dc_shortcircuit.py`, both pinned by tests).
- The OPF-1 defect (OPF shipping a solution costlier than baseline in a source-only island) is a
  real catch-and-fix with a probe and a regression pin — evidence the process finds bugs.

### V-8 [INFO] — Untracked docs at repo root

`CALC_AUDIT_2026-09-20.md`, `CALC_AUDIT_REVIEW_2026-09-20.md`, `CALC_AUDIT_IMPLEMENTATION_…`,
`ENGINE_REVIEW_METHODOLOGY.md`, `ROADMAP_TO_SAAS.md` are untracked working files; the review of
the audit lives at root while its probes live in `audit-history/`. Move them into
`audit-history/` with the established authority-order entry so the chain stays complete.

---

## 4. Verdict

**The verification system is sound and, in several respects, exemplary.** The chain
audit → independent review → probes → fixes → failing-first regression pins is genuinely
practised (not just documented); the hand calculations are derivable from the cited standards
rather than transcribed from the engines; the generated artifacts (templates) are provably in
sync with their sources today; and every quantitative claim I could re-execute reproduced
(917/917, 21/21, probes post-fix).

The weaknesses are in **bookkeeping, not physics**: three inconsistent engine-count claims
(V-1), a manual-only frontend channel (V-2), a stale CLAUDE.md that contradicts both the code
and the verify skill (V-3), and the strongest independent harness sitting outside CI (V-4).
All are cheap to close; none undermines the verified numbers.

### Priority order

1. V-3 — correct CLAUDE.md (state fields, component count, testing section).
2. V-1 — reconcile the "twelve/sixteen" claims into one honest enumerated coverage table.
3. V-4 — add the harness + probes to CI.
4. V-2 — a re-runnable headless UI script per verification template.
5. V-5, V-8, V-6 — housekeeping.