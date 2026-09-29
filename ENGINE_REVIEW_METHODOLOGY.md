# Engine Review Methodology

How to review a ProtectionPro analysis engine as an independent senior engineer:
derive the physics yourself, compare it against the code, and fix what disagrees.

This is the method that produced findings **D1–D8** on
`transient_stability.py` (PR #260). It is written so another agent can apply it
to any other module without re-deriving the process. Read all of §1–§7 before
starting; §8 is the module inventory and running status.

*Last updated 2026-09-18: test commands now run in the backend Docker image;
§8 adds `db_circuit_check.py` / `iec_60364_tables.py` and records which
engines changed after their review.*

---

## 1. The one rule that makes this work

> **Never validate an engine against its own tests.**

A module's test suite encodes the same assumptions as the module. If the author
got the per-unit base wrong, the test fixture uses the same wrong base and
passes. Two of the eight `transient_stability.py` defects were **actively pinned
by passing tests**:

- `TestUnbalancedFault` hard-coded `cct_s == 0.6225`, which was the *wrong*
  critical clearing time produced by the load-netting defect (correct: 0.245 s).
- `TestDistanceRelay` only ever built 11 kV networks, so a relay prop that
  hard-defaults to 11 kV never revealed itself.

Your reference must come from **outside the codebase**: a textbook closed form,
a hand network reduction, a standard's own formula, or a physical invariant.
If you cannot construct an independent reference for a behaviour, say so in the
report rather than pretending the module's tests cover it.

A corollary: **a green suite is not evidence.** Run it to establish a baseline
(and to identify pre-existing environment failures), then set it aside.

---

## 2. Process

### Phase 0 — Scope and baseline (~10 min)

```bash
git log --oneline -15                 # what changed recently
git log --format='%ad %s' --date=short -- backend/analysis/<module>.py   # history of this engine
git diff --stat                       # uncommitted work in scope
grep -n "^def \|^class " backend/analysis/<module>.py    # outline
# BASELINE only — run in the backend image (Python 3.12 + every dependency);
# host python is 3.9 and lacks fastapi/ezdxf/bcrypt, so it fails for
# reasons unrelated to the engine.
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  sh -c "pip install pytest httpx -q && python -m pytest backend/tests/test_<module>.py -q"
```

Record the baseline pass/fail. The full suite (~840 tests, ~6 min) was green on
2026-09-18, so any failure you see is either new or environmental — confirm
with `git stash` before attributing it to your own changes. Run your Phase 2
scratch scripts in the same image (`docker run … python "$SCRATCH/v1_x.py"`)
so reference and engine see identical library versions.

### Phase 1 — Read the engine, not the tests

Read the module top to bottom, including docstrings. ProtectionPro engines carry
unusually detailed rationale in comments — **read it as a claim to be tested,
not as documentation**. Phrases like "deliberate simplification", "adequate
for", "byte-identical", "documented follow-up" mark exactly where to probe.

Note every place the code:
- converts between per-unit bases, or between machine base and system base;
- reads a component prop with a default (`props.get(k, default)`);
- nets, skips, or folds one quantity into another;
- adds or subtracts a term to a shared accumulator;
- takes a branch on a value that could be zero or degenerate.

### Phase 2 — Build an independent reference

This is the phase that produces findings. For each core behaviour, construct a
case where the answer is known *a priori*, then compare.

Work in the scratchpad, one script per theme, each self-contained and printing
`predicted vs engine vs error %`. Keep them — they are the re-verification
harness in Phase 6.

Design cases so the analytic answer is **exact**, not approximate:
- lossless where the closed form assumes lossless (`r_per_km: 0.0`,
  `x_r_ratio: 10000`);
- disable anything the closed form does not model (`gov_mode: "none"`,
  `avr_mode: "off"`, `damping_pu: 0`);
- make the disturbance severe enough to exercise the limit you are testing (a
  fault the machine rides through trivially proves nothing).

**Cross-check the setup before trusting a discrepancy.** In the
`transient_stability.py` review the hand-derived pre-fault angle matched the
engine to 5 decimal places *first* — which established that the network
reduction and initialisation were sound, so any later disagreement had to be in
the dynamics, not the setup.

### Phase 3 — Probe the boundaries

The core mathematics is usually right. Defects live at the edges. Work through
the archetype checklist in §3 deliberately — do not wait to notice them.

### Phase 4 — Report before fixing

Write the findings up and hand them over. Each finding gets: mechanism,
first-principles proof, reproducible evidence with numbers, severity, and the
fix you would make. **Lead with what you verified as correct** — a review that
lists only defects gives no signal about coverage, and the reader cannot tell
"clean" from "not checked". See §5.

### Phase 5 — Fix in severity order

See §6 for the rules, especially the one about re-baselining tests.

### Phase 6 — Re-verify

1. Re-run **every** Phase 2 script. The verified-correct results must be
   *unchanged*; the defect cases must flip.
2. Write a regression test per finding that reproduces the original defect.
3. Run the module suite, the rest of the backend (in the Docker image — see
   Phase 0), and `node --check` on any touched JS.
4. Any newly-failing pre-existing test is a decision point, not a nuisance —
   see §6.

---

## 3. Defect archetypes

The checklist below is derived from what actually surfaced. Walk it explicitly.

| # | Archetype | What to do | Real example |
|---|---|---|---|
| 1 | **Per-unit base mismatch** | For every ohm/amp/volt conversion, ask *which* base. Build the same network at two voltages and check the answer scales correctly. | **D1**: reach ohms → p.u. used the relay's prop, not the bus's kV. 132 kV network mis-reached 144× |
| 2 | **A default that silently applies** | Grep `constants.js` for the component's `defaults`. Any hard-coded number is present in *every real project*, so a "fallback" is actually the normal path. | **D1**: `voltage_kv: 11` on every relay, including 132 kV ones |
| 3 | **Machine base vs system base** | Any per-unit prop described as "% of rating" must be multiplied by `rating/base_MVA` before meeting a system-base quantity. | **D7**: GAST fuel limit 1.15 compared against a system-p.u. command — never bound |
| 4 | **Netting vs stamping** | When a quantity is "folded into" something else, ask what happens to it when voltage collapses or the element trips. | **D2**: load on a machine bus netted off P_m — constant power welded to the rotor, 2.4× CCT error |
| 5 | **Add/remove asymmetry** | Every `x -= y` must have a matching `x += y` on the same path. Probe the accumulator directly. | **D3**: shed did `y -= ybase` on a bus that never carried it → 40 MW of phantom generation |
| 6 | **Degenerate cases** | Feed the model exactly 0, exactly the boundary, exactly equal. `<=` on a circle boundary and `>= 0` on a sign test both admit the degenerate point. | **D6**: V = 0 put Z = 0 *on* the mho circle and made Re(V·conj(I)) = 0 read "forward" |
| 7 | **Feature composition** | List features added in separate commits and test each *pair*. Neither author tested the combination. | **D5**: unbalanced faults (commit N) + relays (commit N+1) — relays read sequence quantities as phase quantities |
| 8 | **Missing real-world supervision** | Ask "what does the real device do that this model omits?" — blinders, blocking, memory, interlocks, resets. | **D4**: no load blinder and no ANSI 68 power-swing block; the shipped default tripped a healthy feeder |
| 9 | **Self-referential test** | Any hard-coded expected number: derive it independently. If you cannot, it is pinning behaviour, not physics. | The 0.6225 s CCT baseline |
| 10 | **Only the benign outcome modelled** | For any restore/retry/recover path, check the failure branch exists at all. | **D8**: auto-reclose could only ever be onto a healthy line |
| 11 | **Iteration-count sufficiency** | For any fixed-iteration loop, derive the contraction factor and check it against the allowed parameter range. | `SUBTRANS_ITERS = 3` is ample at gain ≈ 0.4 but not at the 0.999 the clamp permits |
| 12 | **Discontinuous measurement** | Anything averaged over a *live* set steps when a member leaves. | ROCOF off an island COI that jumps when a machine trips |

---

## 4. Independent references by module type

| Module type | Anchor to derive from |
|---|---|
| Rotor-angle / transient stability | Equal-area criterion (use the **3-curve** form: pre-fault / fault-on / post-fault Pmax all different — the degenerate Pmax_fault = 0 case is too weak); hand star-delta / Kron reduction |
| Machine models | Textbook d-q initialisation: `E′q = Vq + X′d·Id`, `E′d = Vd − X′q·Iq`, `Efd = E′q + (Xd−X′d)Id`, `E″q = E′q − (X′d−X″d)Id`; the air-gap identity `Vd·Id + Vq·Iq = P` |
| Control blocks (governor / exciter / PSS) | Simulate the state equations directly and compare against the Laplace step response by partial fractions. Check **DC gain = 1** and the initial value (HYGOV's non-minimum-phase −2 is a strong signature) |
| Load flow | Hand 2-bus/3-bus solutions; power balance `ΣP_gen = ΣP_load + ΣP_loss`; symmetry and reciprocity of Ybus |
| Fault / short circuit | IEC 60909 or ANSI worked examples; sequence-network interconnection rules (SLG: Z1+Z2+Z0+3Zf; LL: Z1+Z2+Zf; LLG: Z1 + Z2∥(Z0+3Zf)) |
| Protection curves | The standard's own equation, e.g. IEC 60255 SI `t = TMS·0.14/(M^0.02 − 1)` |
| Distance / impedance elements | Mho geometry: reach along a line at angle φ for a mho at θ is `\|R\|·cos(θ−φ)`; the circle through the origin occupies the half-plane within ±90° of θ |
| Arc flash | IEEE 1584 worked examples (note the engine implements **1584-2002**, not 2018) |
| Grounding | IEEE 80 worked examples; touch/step voltage limit formulas |
| Cable sizing | IEC 60364-5-52 derating tables; `ΔV = √3·I·(R cosφ + X sinφ)·L` |
| Time-series / quasi-dynamic | A flat profile **must** reproduce the single-shot solve exactly; energy conservation over the horizon |
| Reliability | IEEE 1366 index definitions computed by hand over a small radial feeder |
| Economic dispatch / OPF | Merit order by hand; verify the optimum against exhaustive enumeration on a tiny case |

**Universal invariants** worth checking on any engine:
- **Null-disturbance equilibrium** — a zero-magnitude disturbance must produce
  exactly zero drift in every state, for every option combination.
- **Scale invariance** — the same network at 11 kV and 132 kV must give the same
  per-unit answer. (This alone catches archetype 1.)
- **Topological invariance** — moving an element across a zero-impedance link
  must not change the answer. (This alone catches archetype 4; it is how D2 was
  found.)
- **Monotonicity** — more inertia ⇒ longer CCT; more fault current ⇒ faster
  trip; higher load ⇒ lower voltage.

---

## 5. Report format

Deliver as a written review, not a bare list.

1. **Scope and method** — what you reviewed, and that you derived independently.
2. **What holds up** — a table of `checked against | result` with the actual
   error figures. This is not padding: it tells the reader what is trustworthy
   and bounds what you did *not* check.
3. **Defects, ranked by severity**, each with:
   - one-line statement of the defect and a `file.py:line` anchor;
   - the mechanism, in physical terms;
   - **reproducible evidence** — the case, the correct answer, the engine's
     answer, the error;
   - the fix you would make;
   - whether it is pre-existing or newly introduced (`git log -S`).
4. **Lesser notes** — real but low-impact, with the reasoning.
5. **Verdict and suggested fix order.**

Severity: judge by *how wrong the delivered answer is and how likely the
configuration is*, not by how hard the fix is. A defect that fires on shipped
default settings outranks one needing an unusual setup. State plainly when an
error is **non-conservative** (the tool says "safe" when it is not) — that is
the highest-consequence class in this domain.

---

## 6. Rules for fixing

- **Fix in the order you reported.** Cheap high-impact first.
- **Mark every fix in-code** with its finding ID (`# [D4] ...`) and the physical
  reason, not just the change. Future readers need to know why the obvious-
  looking simpler version is wrong.
- **One regression test per finding**, reproducing the *original* defect. Put
  them in a dedicated `test_<review>_fixes.py` with the finding IDs and physics
  in the docstrings, so the rationale survives.
- **Preserve verified-correct behaviour.** Re-run the Phase 2 scripts; anything
  that was exact must stay exact.
- **New user-facing options need frontend props** (`constants.js` defaults +
  `fields` + `FIELD_INFO` tooltip) and save/load round-tripping, or they are
  unreachable.
- **Correct stale UI text.** D2 was documented in `transient.js` as intended
  behaviour; that text had to change with the fix.

### When a pre-existing test starts failing

This is the judgement call that matters most. Decide **which of the two is
wrong — the engine or the test** — and say so explicitly in the write-up.

- If the test encoded the defect → **re-baseline it**, and comment the old value
  with *why* it was wrong.
- If the test's analytic reference no longer matches its own assumptions →
  **fix the fixture**, not the tolerance. Moving `_smib()`'s load off the
  generator bus restored a lossless SMIB and took the equal-area anchor from
  −11.5 % back to −0.25 %.
- If the divergence is genuine physics → **sharpen the test rather than widen
  it**. The 6.7 % classical-vs-two-axis gap turned out to be entirely saliency,
  so the test now asserts *exact* agreement at Xq → X′d plus a monotone bound,
  which is a stronger test than the loose tolerance it replaced.
- **Never** widen a tolerance to make a failure disappear without establishing
  which of the three cases applies.

### Flag behaviour changes for existing saved projects

Per `persisted-study-results-go-stale`: saved study results restore from disk
without recomputation. If a fix changes numeric output, say so prominently in
the commit body and PR — affected studies need re-running, not trusting.

---

## 7. Prior review history — read before starting

Several modules have been through earlier review rounds. Their markers appear
in-code as `[EE-n]`, `[PS-n]`, `[EE-R2-n]`, `[PS-R2-n]`, `[P3]`–`[P5]`,
`[OPF-n]`.

> **Those rounds are closed.** `ROUND3_PRINCIPAL` was the final adjudication;
> all findings were resolved on 2026-07-20 (PRs #230, #234). Do **not** act on
> raw EE/PS round reports — they contain findings that were investigated and
> rejected. Treat an in-code marker as "this line has a reason to be the way it
> is; read the comment before changing it."

Those rounds were a multi-agent adjudication process, **not** this
first-principles method. A module carrying `[EE-n]` markers has been reviewed,
but not necessarily with independent analytic anchors — a pass with this method
can still be worthwhile, at lower priority than an unreviewed module.

---

## 8. Module inventory and status

### Completed — reviewed with this methodology

| Module | Review | Findings | Outcome |
|---|---|---|---|
| `frequency_scan.py` (+ harmonic-network turns ratio) | FS1–FS5, L1–L8, 2026-09-29 | 5 fixed + 3 warnings | `FREQUENCY_SCAN_REVIEW.md`. Z(h) exact vs closed-form RLC and a hand ohmic solve with an ideal transformer; resonances refined to the true extremum and ranked in per unit; dead islands dropped, regulating SVC from the load flow. Tests in `test_frequency_scan_review_fixes.py` |
| `harmonics.py` (+ `frequency_scan.py` shunts) | H1–H6, L1–L8, 2026-09-29 | 6 fixed + IEC option | `HARMONICS_REVIEW.md`. Nodal solve exact vs a hand 2-bus solve (1e-3 %); IEEE 519 Tables 2–4 now held in full and graded per order; boards, STATCOM/SVC and dead islands corrected. Tests in `test_harmonics_review_fixes.py` |
| `line_coupling.py` | LC1, 2026-09-29 | 1 fixed + 3 lesser | `LINE_COUPLING_REVIEW.md`. Z0_eff exact vs a 6-conductor phase-domain Carson solve (≤0.08 %); drawn parallel feeders now coupled (exact equivalents). Tests in `test_line_coupling_review_fixes.py` |
| `conductor_temp.py` (+ fault-study line resistance) | CT1–CT2, L1–L2, 2026-09-29 | 2 fixed + 2 lesser | `CONDUCTOR_TEMP_REVIEW.md`. Maximum study now exact vs a hand IEC 60909 calculation at 20 °C; minimum study eq. (3) at θe to 0.03 %. Tests in `test_conductor_temp_review_fixes.py` |
| `lightning_risk.py` (+ new `lightning_risk_2024.py`) | E1, LR1–LR7, 2026-09-29 | 7 fixed + 2024 edition added | `LIGHTNING_RISK_REVIEW.md`. 2010 R1 exact (4.7e-16) over 55,296 combinations; 2024 engine reproduces the standard's Annex F house/office/hospital tables. Tests in `test_lightning_review_fixes.py` |
| `dc_shortcircuit.py` | DC1–DC6, 2026-09-29 | 6 fixed | `DC_SHORTCIRCUIT_REVIEW.md`. Battery exact vs IEC 61660-1 Example 1; rectifier procedure (Annex A eq. 54–56) exact vs hand calc through a drawn AC network. +15 tests in `test_dc_shortcircuit_review_fixes.py` |
| `transient_stability.py` (+ `network_reduction.branch_current`) | D1–D8, 2026-08-01 | 8 fixed | PR #260. Core verified to 0.21 % (equal-area), 6 dp (machine init), 1e-5 (turbine transfer functions). +42 tests in `test_review_fixes.py`. Open items recorded in `TRANSIENT_STABILITY_ROADMAP.md` |

### Reviewed in earlier rounds (not by this method)

Lower priority for a fresh pass, but not exempt — see §7.

**Changed since its review** — engines whose code moved after the review round
that covers them. Re-read the new paths before trusting the markers:

| Module | Change | Date |
|---|---|---|
| `loadflow.py` | feeder to a source with no terminal bus is now modelled (`insert_implicit_load_buses` covers sources); a Swing *bus label* no longer fabricates a source; dispatch shown in kVA | 2026-08-05/06 |
| `fault.py` | no fault current reported on de-energised buses | 2026-08-05 |
| `admd.py` (Tier 2, unreviewed) | 3-phase load classes fixed; one per-phase reading per erf; overrides in A or kVA | 2026-09-18 |

| Module | Markers |
|---|---|
| `loadflow.py` | `[EE-2] [EE-3] [EE-8] [EE-9] [EE-10] [EE-11] [EE-14] [EE-R2-2] [OPF-1] [P3] [P4] [P5]` |
| `fault.py` | `[EE-4] [EE-7] [EE-8] [EE-11] [EE-12] [PS-1..7] [PS-12] [PS-R2-2/3/7]` |
| `motor_starting.py` | `[EE-1] [EE-5] [EE-12] [EE-R2-3] [PS-1]` |
| `cable_sizing.py` | `[EE-5] [EE-9] [EE-14] [P4]` |
| `arcflash.py` | `[EE-10] [PS-4] [PS-9]` |
| `voltage_stability.py` | `[EE-6] [EE-7] [EE-14] [EE-R2-2]` |
| `ct_model.py` | `[PS-9] [PS-16]` |
| `dynamic_motor_starting.py` | `[EE-12] [PS-1]` |
| `contingency.py` | `[EE-4] [EE-R2-4]` |
| `load_diversity.py` | `[EE-13] [EE-R2-5]` |
| `grounding_system.py` | `[EE-5]` |
| `unbalanced_loadflow.py` | `[P5]` |
| `optimal_powerflow.py` | `[OPF-1]` |
| `pt_model.py` | `[PS-16]` — first-principles pass done 2026-09-29, `PT_MODEL_REVIEW.md` (PT1–PT4) |
| `fault_ansi.py` | `[PS-1]` |
| `duty_check.py` | `[PS-R2-4]` |

### Not yet reviewed

Suggested order: safety-consequential and standards-anchored engines first
(a wrong answer here goes onto a drawing or a label), then the optimisation and
planning engines, then support modules.

**Tier 1 — safety / standards-anchored, no review markers at all**

| Module | Anchor to use |
|---|---|
| `dc_arcflash.py` | Stokes & Oppenlander / NFPA 70E DC incident energy |
| `dc_loadflow.py` | Hand 2-bus DC solution; power balance |
| `raceway.py` | IEC 60364 / SANS 10142-1 fill and grouping factors |
| `db_circuit_check.py` | Per-way chain by hand: derated Iz (IEC 60364-5-52 tables × grouping/temperature factors), Ib ≤ In ≤ Iz (60364-4-43 §433.1), single-phase loop vs three-phase volt drop (SANS 10142-1 Cl. 6.6 — the 2× loop is the classic slip), ECC from 60364-5-54 Table 54.7, Zs against the breaker's magnetic trip (60364-4-41). Check it agrees with `cable_sizing.py` on an identical cable |
| `iec_60364_tables.py` | **Transcription**, not physics: spot-check every table against the published IEC 60364-5-52 values, and check parity with its frontend twin in `constants.js` (the two must not drift) |

**Tier 2 — analysis engines, no review markers**

| Module | Anchor to use |
|---|---|
| `battery_sizing.py` | IEEE 485 worked duty-cycle example; Peukert |
| `filter_sizing.py` | Single-tuned filter resonance `h = 1/(2π√(LC))`; IEEE 519 verification |
| `capacitor_placement.py` | Exhaustive enumeration on a small feeder vs the greedy result |
| `hosting_capacity.py` | Hand voltage-rise `ΔV ≈ (P·R + Q·X)/V` |
| `flicker.py` | IEC 61000-3-3 curve points; Pst from a known dip magnitude/rate |
| `reliability.py` | IEEE 1366 indices by hand on a small radial feeder |
| `timeseries_loadflow.py` | Flat profile must reproduce single-shot exactly; energy conservation |
| `loadflow_cases.py` | Each case must equal a standalone `run_load_flow` on the same snapshot |
| `admd.py` / `admd_data.py` | Published ADMD/diversity curves |
| `backup_autonomy.py` | Energy balance over the autonomy period |
| `network_reduction.py` | Kron reduction identity; two-port equivalence (partially exercised by D-round) |
| `study_manager.py` | Orchestration — verify each study matches its standalone call |

**Tier 3 — output and support**

`pdf_reports.py`, `plan_dxf.py`, `backend/routes/*.py`, `backend/models/*.py`
— review for correctness of *transcription* (do the reported numbers match the
engine's?) rather than physics.

`plan_dxf.py` was rewritten on 2026-09-18 (PR #270: structured DXF import —
blocks, attributes, all curve types, layers, units) and has 23 tests in
`test_plan_dxf_import.py`, written alongside the code — by §1 those are not an
independent reference. Anchors for a pass: a DXF built with known geometry must
come back with exact coordinates after the origin shift and rounding
(tolerance = the documented tol/10); `$INSUNITS` codes against the DXF
reference table; a mirrored (extrusion −Z) block and a rotated/scaled nested
block must land where AutoCAD draws them; and our export → import round-trip
must be the identity for every entity type in both plan domains.

**Frontend** (`frontend/js/`, 76 modules) — the physics-bearing ones are
`constants.js` (component defaults and library data — archetype 2 lives here),
`tcc.js` (curve maths and distance zone grading — curves reviewed 2026-09-29, `TCC_REVIEW.md`), `compliance.js` (standards
rules — reviewed 2026-09-29, `COMPLIANCE_REVIEW.md`), `dbschedule.js`, `retic.js`, `plan-lux.js`. The rest are UI and follow
the frontend verification path in the `verify` skill instead.

---

## 9. Quick start

```bash
# 0. baseline (record, then set aside) — in the backend image, not host python
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  sh -c "pip install pytest httpx -q && python -m pytest backend/tests/ -q" 2>&1 | tail -5

# 1. outline the module
grep -n "^def \|^class " backend/analysis/<module>.py

# 2. scratchpad, one script per theme
#    each prints: predicted | engine | error %
mkdir -p "$SCRATCH" && $EDITOR "$SCRATCH/v1_<theme>.py"

# 3. walk the §3 archetype checklist deliberately

# 4. report (§5) — verified-correct table FIRST

# 5. fix in order, marking each with its finding ID

# 6. re-run every scratchpad script + the full suite + node --check
```

Keep the scratchpad scripts referenced in the report. They are the evidence, and
they are what the next reviewer of that module starts from.
