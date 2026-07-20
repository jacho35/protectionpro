# Round-2 Independent Review — Power-System Engines (Part 1 of CALC_VERIFICATION_2026-07-19.md)

**Reviewer:** Senior Electrical Engineer (power systems), round 2.
**Scope:** Reviewer A's findings EE-1 … EE-14 in `/root/protectionpro/CALC_VERIFICATION_2026-07-19.md` (Part 1), plus the "Verified correct", "Overall engineering opinion" and the top-of-document remediation-status table for EE-1…EE-6. Reviewed against the live source code only — `backend/analysis/{loadflow,loadflow_cases,voltage_stability,contingency,cable_sizing,motor_starting,dynamic_motor_starting,load_diversity,grounding_system}.py` — and against `backend/tests/test_verification_fixes.py`. No other review/audit markdown was opened.
**Standards applied:** IEC 60909-0, IEEE 80, IEC 60364, IEEE 3002.7, classical Newton-Raphson / Gauss-Seidel load-flow theory.
**Repo state:** `main` @ the working tree inspected.

---

## 1. Methodology

For each EE finding I (a) re-read the cited code lines and confirmed the cited mechanic, (b) cross-checked the numerical demonstration against an independent hand calculation, (c) verified the *current* state of the code — i.e. whether the finding still applies or has been remediated, since the verification document under review carries both the original finding and a remediation-status table — and (d) assessed the severity rating. Where the document's "Verified correct" section makes quantitative claims I checked the math. Where the remediation table claims EE-1/2/3/4/5/6 are fixed I verified the fix exists in code and is pinned by `test_verification_fixes.py`. I then went looking for adjacent defects Reviewer A did not surface.

---

## 2. Per-finding adjudication

### EE-1 — Static motor-starting omits source internal impedance — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** `motor_starting.run_motor_starting` (pre-fix) ran `run_load_flow` with the motor replaced by its starting MVA, and the load-flow engine holds the utility bus at 1.0 p.u. with zero internal impedance (`loadflow.py:1958–1963` — the utility branch in the per-bus injection loop is a `pass`; the ideal-swing convention is documented at `loadflow.py:1911–1919` and `loadflow.py:1959`). The Thevenin source impedance is therefore absent from the dip. Reviewer A's hand calculation is sound: 200 kW / 400 V / LRC 6.5× → S_start ≈ 1.609 MVA at pf 0.3, behind a 1 MVA, 5% TX fed from a 20 MVA utility. With the source impedance included (Z_th ≈ 5 pu on 100 MVA base from the 20 MVA utility + 5% on the 1 MVA TX) the terminal voltage falls below the 0.80 p.u. threshold the engine itself uses at `motor_starting.py:312`; without the source term only the TX drop is captured (~0.91 p.u., a false PASS). The non-conservative direction is unambiguous.

**Severity (P1).** Appropriate. A "will start" verdict on a motor that will in fact stall or fail to accelerate is a safety-relevant non-conservatism (under-sized starting equipment, undervoltage tripping of adjacent loads, mechanical stress from prolonged acceleration). P1 stands.

**Fix verified.** `motor_starting.py:73–104` now defines `_thevenin_z1`, delegating to `fault.thevenin_z1_at_bus` at c = 1.0 with motor paths excluded (`motor_starting.py:78–84`), and `_solve_pq_dip` (lines 87–104) iterates V = V_pre − Z_th·(S/V)*. The starting-condition load flow is still run (lines 228–236) to capture the network-side dips on every bus, then a source-side dip term `src_dip_pu = max(0, lf_terminal_v_pu − superposed_v_pu)` is computed (lines 281–283) and applied to every bus at lines 293 and 323. This is the superposition approach Reviewer A recommended.

**Caveats I note.**
1. `thevenin_z1_at_bus` (`fault.py:1872–1924`) still falls back to `_parallel_impedances([p["z_total"] for p in keep])` for *radial* topologies and only switches to the nodal Zbus for detected-meshed topologies. For a radial motor start this is exact, so EE-1's fix inherits PS-1 correctly *for radial networks*. Reviewer A did note (Part 3, cross-cutting #1) that EE-1's fix depends on PS-1; that observation is correct and well-sequenced.
2. The `_solve_pq_dip` fixed-point iteration uses a 0.7/0.3 damping (line 103) and a 100-iteration cap. Near the nose this can return `None` (treated as collapse = 0.0 p.u. at line 267). That is conservative; acceptable.
3. The constant-pf assumption for the starting load (0.30) is a standard simplification and is documented at `motor_starting.py:210`. Acceptable.

**Test pin.** `test_verification_fixes.py::TestMotorStartingSourceImpedance::test_ee1_source_impedance_included` and `test_ee1_weak_transformer_start_fails` (lines 273–292) anchor the two numerical demonstrations; the second asserts `motor_will_start is False`, which is the right regression for a non-conservative-direction fix.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-2 — Cascaded transformers in one branch chain produce a garbage "converged" solution — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** The original `_get_chain_turns_ratio` returned on the first transformer found in the chain. For TX1 = 33/11, TX2 = 11/0.4, buses 33 kV and 0.4 kV, the legacy code computed t = (33/11)/(33/0.4) = 3/82.5 = 0.03636. The π-model entries `Y[i,i] += y/t²` (now at `loadflow.py:1858`) are then wrong by 1/t² ≈ 756×. Reviewer A's mechanism and the 0.0003 p.u. "converged" garbage figure are reproduced by the same arithmetic; the `_assess_solution` heuristic (`loadflow.py:1652–1664`) does flag the implausibly-low bus but attributes it to "low-voltage/collapse root or an infeasible operating point" — a misleading diagnosis for what is in fact a topology-modelling bug, exactly as Reviewer A states.

**Severity (P1).** Appropriate. A legal drawing yielding a numerically converged but meaningless solution, with a warning that mis-attributes the cause to voltage collapse, is a genuine P1: the user has no reliable signal that the result is wrong. Reviewer A's preference for a hard modelling error over Π-ratio accumulation is the safer call, and I note the implemented fix went with the Π-ratio approach *plus* a modelling warning — a defensible compromise.

**Fix verified.** `_get_chain_turns_ratio` (`loadflow.py:1383–1457`) now accumulates `ratio *= actual` (stepping down) or `ratio /= actual` (stepping up) while walking the electrically-ordered chain, tracking the running voltage zone (lines 1425–1453). Callers pass the chain in electrical order (lines 1834–1854), and chains with ≥2 transformers emit a `multi_xfmr_chain_warnings` entry (lines 1843–1853). For a 33/11 + 11/0.4 cascade walked from the 33 kV side, the product is (33/11)·(11/0.4) / (33/0.4) = 1.0 — exactly the explicit-bus per-unit ratio. Reviewer A's "control case" (insert the 11 kV bus → 0.99513 p.u.) is reproduced by the test pin.

**Test pin.** `TestCascadedTransformerChain::test_cascade_matches_explicit_bus_model` and `test_cascade_emits_modelling_warning` (lines 344–354) anchor both the numeric fix and the warning.

**Caveat I note.** The walking logic at lines 1427–1434 identifies the "tap-side bus" as the side facing the *first* transformer's HV winding; if a user draws a cable on the HV side, then TX1, then TX2, then a cable on the LV side, the cables' per-side voltage assignment in `cable_voltages` (lines 1797–1811) is still correct because each cable is classified by the bus it faces. EE-10 (tap-on-lumped-chain) remains a separate, smaller residual issue. No interaction problem here.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-3 — Series-chain losses repeated on every element row, Study Manager double-counts — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** At `loadflow.py:2384–2448` (current code) each element in a series chain now carries `losses_mw * _share` where `_share` is the element's I²R fraction of the chain (`_elem_z[elem.id].real / _r_chain`, lines 2432–2438). The legacy behaviour (every row repeated the full chain loss) would have produced 2× the true loss when summed across a two-element chain. `loadflow_cases._summary` (`loadflow_cases.py:50`) sums `br.losses_mw for br in result.branches`, so the legacy double-count propagated directly to the Study Manager headline — the metric the feature exists to compare. Reviewer A's 0.1092 vs 0.2183 MW demonstration is consistent with this.

**Severity (P2).** Appropriate. It corrupts the headline comparison metric, but it is conservative-direction (overstates losses) and the per-branch flow figures are correct, so it does not produce a safety-relevant wrong answer. P2 is the right rating.

**Fix verified.** The apportioning by I²R share is the physically meaningful choice Reviewer A recommended; the code comment at lines 2357–2363 acknowledges the row repetition and explains the share computation. The fallback to |Z| share (line 2435) when the chain has zero resistance (e.g. ideal reactor pair) and the equal split when both are zero (line 2438) are sensible degenerate-case handlers.

**Test pin.** `TestChainLossApportioning::test_split_chain_rows_sum_to_true_loss` (lines 390–396) asserts the summed loss of a split-cable chain matches the single-cable chain to within 1e-4 MW. Directly pins the fix.

**Reviewer A's analysis is accurate. One minor omission:** the same row-repetition also affects contingency thermal-overload counting on a chain — if a chain has multiple elements each row repeats the chain flow, so the overload check at `contingency.py:99–109` could in principle flag the same chain N times. Reviewer A alludes to this in Part 3 ("minor, same root") but does not list it as a finding. Not material.

---

### EE-4 — Contingency loss-of-supply missed for synthetic-bus dangling loads — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** The original `_evaluate` differenced `base_energ_ids − energ_ids` over real-bus result sets, while `connected_bus_loads_mw` (`loadflow.py:1565–1604`) keys a dangling load's MW under the synthetic `__term__<load>` id (line 237 of loadflow.py). Two failure modes follow: (a) de-energizing a real bus that feeds a dangling load reports 0 MW lost (the load's key is the synthetic id, not the real bus); (b) outaging the sole feeder cable removes the load from the model entirely, leaving the synthetic bus absent from the result and the contingency reported as `secure`. Reviewer A's 4.25 MW demonstration (5 MVA × 0.85 pf) reproduces both failure modes in mechanism.

**Severity (P2).** I would push this toward P1 — Reviewer A's verdict P2 is *borderline-low*. A "secure" N-1 verdict for the total loss of a load is a reporting failure on a safety-relevant security assessment; the user can conclude a network is N-1 secure when it is not. The reason I accept P2 is that the defect only bites for one specific topology class (dangling loads without a drawn terminal bus), and the properly-drawn control case (load on a real bus) works correctly — so an engineer who draws their SLD conventionally will not see it. Still, the topology `insert_implicit_load_buses` exists to support precisely the dangling case, so users are invited to use it. P2 with a strong caveat.

**Fix verified.** `_evaluate` (`contingency.py:72–152`) now calls `run_load_flow(..., include_synthetic=True)` (line 84) so synthetic terminal buses appear in `result.buses`; the lost-load loop at lines 130–142 keys `base_loads` over both real and synthetic ids. The `_bus_display_name` helper (lines 53–69) maps a `__term__X` id back to "Load X (terminal)" for human-readable output, and lines 134–137 distinguish "disconnected from the network" (the synthetic bus is gone entirely — the feeder outage) from "de-energized" (still present but dark). The baseline at `contingency.py:189` is also synthetic-inclusive. Reviewer A's two-point fix (synthetic-inclusive accounting + "load no longer connected" violation) is implemented verbatim.

**Test pin.** `TestContingencyDanglingLoad::test_dangling_load_outages_are_counted` (lines 403–421) anchors the 4.25 MW demonstration for both the loss-of-grid and the loss-of-feeder cases, and asserts `not res.n_minus_1_secure`.

**Reviewer A's analysis is accurate. The P2 rating is defensible but I would accept P1.**

---

### EE-5 — Static motor-start scales locked-rotor draw by `demand_factor` — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** The starting condition at `motor_starting.py:194–225` rewrites `power_factor`, `rated_kw` (or `rated_kva`), and `efficiency` for the modified motor. The legacy code left `demand_factor` untouched; the load-flow load model at `loadflow.py:2024–2028` (static_load) and `loadflow.py:2033–2041` (motor_induction) multiplies the per-unit load by `df`. Locked-rotor current is a machine property that does not scale with the running duty factor, so applying df to the starting load silently halves the dip for df = 0.5. Reviewer A's mechanism and 12.83% → 5.80% demonstration are consistent with the code.

**Severity (P2).** Reviewer A filed this as P2, but in the consolidated table (Part 3) it is bundled with EE-1+EE-5+EE-12 as a P1 cluster. The bundle is correct: EE-1, EE-5, and EE-12 are three defects in one engine, all biased in the non-conservative direction, and EE-5 on its own can flip a FAIL to a PASS for any motor with df < 1 — a routine operating condition. **As a cluster, P1; standalone, P2.** I agree with the consolidated rating.

**Fix verified.** `motor_starting.py:211–215` explicitly sets `mod_motor.props["demand_factor"] = 1.0` in the starting condition, with a comment explaining the rationale. One-line fix, exactly as Reviewer A recommended.

**Test pin.** `TestMotorStartingSourceImpedance::test_ee5_demand_factor_does_not_scale_locked_rotor` (lines 294–298) asserts `r_half["motor_terminal_voltage_pu"] ≈ r_full["motor_terminal_voltage_pu"]` to within 0.02 p.u. — the dip is df-independent post-fix.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-6 — Voltage stability reports "collapse" when the λ sweep merely ran out of steps — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** The original `collapsed = lam_critical < lambda_max − 1e-6` at `voltage_stability.py:139–163` fired whenever `1 + k·step` overshot `lambda_max` without landing on it (i.e. for any user step that doesn't divide the range), leaving `first_bad = None` but `collapsed = True`. The note at lines 200–203 then declared "Voltage collapses at λ = 3.800 … weakest bus 'B2' at 1.000 p.u." — a bus at nominal voltage declared collapsed. Reviewer A's demonstration with step = 0.35, λ_max = 4.0 reproduces this exactly.

**Severity (P2).** Reviewer A rates P2 and notes it's a P2/P3 boundary. I concur: the error is in the conservative direction (declares a collapse that isn't), but the *note* asserts a false engineering conclusion that a user could act on (e.g. add cap bank, reconductor). P2 is right.

**Fix verified.** `voltage_stability.py:136–172` now tracks `observed_collapse` as a boolean set only when `first_bad is not None` (line 158) or the base case itself is below floor (line 141). The final `collapsed = observed_collapse` at line 172. When the sweep exhausts λ without failure, the note at lines 204–207 reads "No collapse up to λ = … — margin is a lower bound; raise lambda_max to find the nose." Exactly Reviewer A's recommended fix.

**Test pin.** `TestVoltageStabilityCollapseFlag::test_sweep_overshoot_is_not_collapse` (lines 428–444) uses a 100 000 MVA utility and step 0.35/λ_max 4.0, asserting `res.collapsed is False` and `"lower bound" in res.note`.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-7 — Q-V "reactive margin" is net bus injection, not condenser output — **CONFIRMED**

**Claim verified.** `voltage_stability.py:285–297` (current code: lines 293–299) records `cb.q_mvar` — the net bus injection (condenser Q minus local reactive load) — as the curve point. The inline comment at line 294 acknowledges "condenser Q − local reactive load". Reviewer A's analytic verification is sound: for a pure X = 0.25 pu link, E = 1, P = 100 MW, the closed-form net-injection minimum is Q(V) = 4V² − 4√(V² − (PX)²), dQ/dV = 0 at V = 0.559, Q_min = −0.75 pu = −75 MVAr. The engine returns −74.96, matching to 0.05% — the math is right. Adding a 30 MVAr local load shifts the engine's reported minimum to −95.96, whereas the classical fictitious-condenser margin is −65.96 — overstating the available reactive margin by exactly the local Q load.

**Severity (P3).** Appropriate. The curve shape and the op-point-to-minimum distance are preserved (both shift together), so the curve is still usable; only the headline `qv_min_mvar` label is misleading at load buses. P3 stands.

**Fix status.** *Not fixed.* The remediation table lists EE-7 as open (P3 findings "tracked for follow-up"). Consistent with Reviewer A's recommendation, the in-code comment documents the convention. Acceptable for a P3.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-8 — Power factor > 1 crashes load flow with unhandled `ValueError` — **CONFIRMED**

**Claim verified.** `loadflow.py:2026` (static_load), `2039` (motor_induction), `2048` (motor_synchronous) all use `math.sqrt(1 - pf**2)` without the `max(0.0, …)` clamp. The distribution_board path at line 1951 uses the clamped form `math.sqrt(max(0, 1 - pf ** 2))`, the generator path at line 1984 uses `math.sqrt(max(0.0, 1 - pf ** 2))`, and the VFD path at line 2067 uses the clamped form. The inconsistency is exactly as Reviewer A describes. A user-supplied `power_factor: 1.2` on a static_load or motor raises `ValueError: math domain error` → HTTP 500 for the whole study.

**Severity (P3).** Appropriate. It's a robustness/handling defect, not a numerical correctness one.

**Fix status.** *Not fixed.* The three unclamped lines remain. Trivial one-line fix; consistent with the in-codebase pattern.

**Reviewer A's analysis is accurate.**

---

### EE-9 — Capacitor banks modelled as constant-Q, not constant-susceptance (Q ∝ V²) — **CONFIRMED**

**Claim verified.** `loadflow.py:2051–2054`:
```python
elif comp.type == "capacitor_bank":
    kvar = comp.props.get("rated_kvar", 100)
    Q_spec[i] += kvar / 1000 / base_mva
    bus_load_q_mvar[i] -= kvar / 1000
```
This injects the *rated* Q regardless of bus voltage. A capacitor's true output is Q = ω·C·V² = Q_rated·(V/V_rated)²; at 0.9 p.u. the bank delivers 81% of rated, but the engine credits 100% — a +23% over-credit at 0.9 p.u. (Reviewer A's number), growing to +44% at 0.75 p.u. The SVC model in the same file (line 2072+) does track Q via the voltage-regulating PV bus with reactive limits, and the `harmonics.py` engine (lines 163–174) models capacitor banks as shunt susceptances scaled by harmonic order `h` — so the constant-susceptance precedent exists in the codebase. The defect is conservative-direction for *normal* operation (banks slightly under-rated in real life get full credit) but **non-conservative in the specific situation capacitors matter**: depressed voltage and P-V continuation near the nose, where `voltage_stability._scaled_project` (lines 52–60) scales loads by λ while the cap bank's Q stays constant — making the network look stiffer than it is and overstating the loadability margin.

**Severity (P3).** I would accept P2. Reviewer A rates P3 on the basis that "the engine's own SVC model does track Q_nom·V²", proving the physics precedent; and that the error is small at nominal voltage. But for a P-V study specifically — which the codebase explicitly supports via `voltage_stability.py` — the cap bank's V²-dependence is the dominant physical effect that determines the nose location. The combination of EE-9 + voltage_stability's load-scaling continuation is a non-conservative loadability-margin overstatement. **P3 is defensible; I would accept P2.**

**Fix status.** *Not fixed.* Trivial: model `Q = Q_rated · V²` in the iteration (or inject as a shunt admittance `y = j·Q_rated/V_rated²` into Ybus).

**Reviewer A's analysis is accurate but slightly understates the impact in P-V continuation.**

---

### EE-10 — Off-nominal tap applied to lumped chain admittance, not at the transformer terminal — **CONFIRMED**

**Claim verified.** `loadflow.py:1784–1815` lumps all chain series impedance into `z_total` first (cable + transformer), then `loadflow.py:1854–1873` wraps the standard π-model around the *whole chain*: `Y[i,i] += y/t²`, `Y[j,j] += y`, `Y[i,j] -= y/t`. Physically, in a chain cable+TX, the cable on the tap side sits *outside* the ideal transformer and should not be scaled by 1/t². At ±10% tap, 1/t² ≈ 1.21, so the cable's referred impedance is mis-stated by ~21% on its share of the chain drop — a few-percent branch-drop error. Exact at t = 1 and for cable-free chains.

**Severity (P3).** Appropriate. Few-percent error, exact at unity tap, documented in the existing test suite. P3 stands.

**Fix status.** *Not fixed.* Reviewer A's pragmatic recommendation (document "put a bus at the transformer terminal when tapping") remains the short-term mitigation. The proper fix is two-port series combination with the tap applied at the transformer element only.

**Reviewer A's analysis is accurate. No errors.**

---

### EE-11 — GS convergence is ΔV-based; NR magnitude update unguarded — **CONFIRMED**

**Claim verified.** Two sub-claims:

1. **GS.** `loadflow.py:3185–3188`: `diff = np.abs(V - V_old); max_diff = np.max(diff); if max_diff < TOLERANCE: return V, True, …`. Convergence is declared on max|ΔV| < 1e-6 per sweep. GS converges geometrically with ratio ρ often > 0.9 on meshed nets, so the true residual error is ΔV/(1−ρ) ≫ tolerance. There is no final power-mismatch check before reporting `converged=True`. The 100-iteration cap (`MAX_ITERATIONS = 100`, line 15) is tight for GS on anything but small radial nets. Reviewer A correctly flags this as latent risk, not observed error — all GS tests match NR to 6 digits in their suite.

2. **NR.** `loadflow.py:3138–3139`: `for ii, i in enumerate(pq_idx): V[i] = abs(V[i]) + dx[len(non_swing) + ii]`. The `abs()` silently flips a negative magnitude, equivalent to a 180° phase shift on a violent step. Standard guard: floor |V| at a small positive value, or damp the step.

**Severity (P3).** Appropriate for both. Latent-risk hardening, no observed error in the regression suite.

**Fix status.** *Not fixed.* Both sub-issues remain.

**Reviewer A's analysis is accurate and appropriately honest about the latent-vs-observed distinction.**

---

### EE-12 — Motor-bus walk does not recognize `distribution_board` terminals — **CONFIRMED (original defect); fix VERIFIED in code**

**Original claim verified.** The legacy `_find_motor_bus` walked only to `type == "bus"`. The load-flow engine treats `distribution_board` as a bus-like node (`loadflow.py:1946–1953` injects the board's own load at its node; `connected_bus_loads_mw` at lines 1581–1583 includes it in the bus list). A motor wired to a distribution board therefore got `terminal_bus = None`, terminal voltage defaulted to 1.0 (falsely "will start"), and the dynamic engine skipped the motor entirely.

**Severity (P2 → bundled as P1 cluster).** Same comment as EE-5: standalone P2, in the EE-1/5/12 cluster P1. Agreed.

**Fix verified.** `motor_starting.py:57` and `dynamic_motor_starting.py:261` both now accept `comp.type in ("bus", "distribution_board")`. The load-flow convention is mirrored.

**Test pin.** `TestMotorStartingSourceImpedance::test_ee12_distribution_board_terminal_found` (lines 300–310) asserts the terminal bus is found and the voltage is below 0.95 p.u. on a 20 MVA grid.

**Reviewer A's analysis is accurate.**

---

### EE-13 — Load-diversity transformer loading counts only directly-connected LV buses — **CONFIRMED**

**Claim verified.** `load_diversity.py:253–279` (current lines 253–280): the transformer's `connected = _find_components_at_bus(xfmr.id, adj, comp_map)` returns only the buses *directly* connected to the transformer (the walk goes through transparent devices only — `TRANSPARENT_TYPES` at line 15 does not include `cable` or `transformer`). Loads on sub-boards behind a feeder cable are therefore excluded, understating `demand_loading_pct` for the normal main-sub distribution pattern. The `bus_results` list (lines 219–234) is built per-bus independently and is not aggregated across downstream feeders.

**Severity (P3).** Appropriate. Non-conservative for transformer adequacy screening (understates loading), but the load-flow engine reports true transformer loading elsewhere, so cross-checking is possible. P3 stands.

**Fix status.** *Not fixed.* The downstream-tree walk Reviewer A suggests, or a stated-limitation note, is the right next step.

**Reviewer A's analysis is accurate.**

---

### EE-14 — Miscellaneous conservatism/robustness notes — **CONFIRMED** (with one sub-bullet deserving promotion)

All four bullets verified:

1. **Cable shunt capacitance ignored.** `loadflow.py:1363–1380` (`_get_impedance`): the cable branch returns only series R and X; no shunt susceptance. Negligible at LV, a few Mvar for tens of km of MV XLPE — acceptable for the tool's stated LV/MV distribution scope. Worth a doc note. Confirmed.

2. **Cable-sizing voltage drop always lagging.** `cable_sizing.py:713`: `sin_phi = math.sqrt(max(0.0, 1 - cos_phi ** 2))` — always positive. A leading-pf branch (PV export, capacitive) sees a smaller drop or a rise; the engine over-states the drop. Conservative, but the report can flag a compliant cable as non-compliant. Confirmed. Reviewer A's direction tag (conservative) is correct.

3. **Fuse clearing time fixed at 10 ms.** `cable_sizing.py:534–535`: `if cb_comp.type == "fuse": return 0.01`. Realistic for bolted faults ≫ the fuse rating but optimistic near the melting threshold. The k²S²/I²t adiabatic check uses this t, so the resulting minimum size can be under-estimated for large upstream fuses where the actual fault current is only a few × I_n. **This is the genuinely non-conservative bullet in the set** — and it is *inconsistent* with the proper fuse-curve evaluation `arcflash.py` uses. Reviewer A correctly flags this. I would promote this to its own P3 finding rather than burying it in miscellany; the consolidated table does this (EE-14 fuse bullet appears separately in the "non-conservative" list).

4. **Voltage-stability records only ok() points.** Cosmetic. Confirmed.

**Severity (P3).** Appropriate for the bundle. The fuse bullet deserves individual tracking, as Reviewer A notes.

**Fix status.** *Not fixed.* All four remain.

**Reviewer A's analysis is accurate.**

---

## 3. Additional findings Reviewer A missed

### EE-R2-1 — GS reactive-limit clamp is silent: a PV bus that hits Q_max in GS does not convert to PQ

**File:** `loadflow.py:3148–3190` (`_gauss_seidel`). The NR solver has an outer Q-limit-clamp loop (`gen_pv_units`, `ibr_pv_units`, `svc_units` registered at lines 1980–2095, clamped in the outer loop after line 2119+). The GS solver has no such outer loop: a PV bus that exceeds its reactive capability silently keeps V_mag fixed at `V_mag[i]` (line 3182) regardless of Q. A generator asked to hold 1.05 p.u. against a heavy inductive load will report a converged solution with Q far above `q_max` — no PV→PQ conversion, no warning. Reviewer A's EE-11 covers GS numerics but does not flag the missing Q-limit. Impact: any GS-solved network with a PV generator near its reactive limit returns a physically infeasible "converged" solution. The codebase defaults to NR (`method = "newton_raphson"` in every caller I checked), so this only bites on user-selected GS, but the documentation presents GS as a valid alternative. P2/P3 boundary; I would rate **P2**.

### EE-R2-2 — `connected_bus_loads_mw` does not include the reactive component, but `voltage_stability`'s Q-V consumption depends on it

**File:** `loadflow.py:1565–1614`, `voltage_stability.py:90–91`. `connected_bus_loads_mw` returns MW only; `voltage_stability.run_voltage_stability` uses it for `base_load_mw` (the P-V x-axis) and the collapse-bus identification. That is correct for the P-V x-axis (which is real demand). However, the Q-V curve at `voltage_stability.py:240–304` sweeps a condenser and reads `cb.q_mvar` (the *net bus Q injection*), so the operating-point marker `op_q` is computed without an explicit local-Q reference — and the EE-7 issue compounds here. Reviewer A covered EE-7 but did not note that `connected_bus_loads_mw` not having a Q sibling means *no* engine-level accounting of total reactive demand exists for stability-margin reporting. Minor, but a documented limitation worth surfacing. **P3.**

### EE-R2-3 — `_solve_pq_dip` (the EE-1 fix) uses a constant-power-factor starting load; near the nose it is more pessimistic than the true constant-impedance locked-rotor model

**File:** `motor_starting.py:87–104`. The starting load is modelled as constant-PQ at pf 0.30. A locked rotor is physically a constant impedance (S ∝ V²), so as the terminal voltage depresses, the constant-PQ model draws *more* current than the true locked-rotor impedance would — pessimistic, which the in-code comment at `motor_starting.py:202–207` acknowledges. This is the right side to err on for a *starting* study (better to predict a stall that does not happen than miss one that does). But the EE-1 Thevenin superposition fix uses this same constant-PQ load in `_solve_pq_dip`, which means the *fixed-point iteration* can report `None` (collapse) for a starting load that, modelled as a constant impedance, would actually converge at a low but non-zero voltage. Combined with the 0.05 p.u. collapse floor at line 96, the EE-1 fix is conservative at very low voltages. Acceptable, but worth noting in the engine's documentation. **P3.**

### EE-R2-4 — Contingency N-2 pair cap is positional (`itertools.combinations` order), not worst-case-aware

**File:** `contingency.py:204–212`. `pairs = list(itertools.combinations([c.id for c in outageable], 2))` then `pairs = pairs[:room]`. The skipped pairs are *not* randomly sampled or selected by criticality — they are simply the tail of `itertools.combinations`, which is lexicographic by component-id order. If the user has a network where the highest-impact N-2 pairs involve components near the end of the id list, those pairs are silently dropped. The warning at lines 210–211 reports the count but not *which* pairs were skipped. Reviewer A notes "N-2 cap bookkeeping (skipped-pairs message) arithmetic checked by reading" but does not flag that the skipped set is deterministic-but-arbitrary with respect to severity. For a security-assessment tool, a random or criticality-weighted sample would be more defensible. **P3.**

### EE-R2-5 — `load_diversity._get_load_kw` for `motor_synchronous` uses `pf` to back-calculate kW from kVA, but `_get_load_kva` returns the rated kVA directly — inconsistent with the load-flow engine's `P = rated_kva·pf` convention

**File:** `load_diversity.py:112–114` vs `loadflow.py:2042–2050`. `load_diversity._get_load_kw` returns `rated_kva * pf` for a synchronous motor; `loadflow.py:2047` does the same. That is consistent. But for an induction motor, `load_diversity._get_load_kw` returns `rated_kw` (line 124) — the *shaft* kW — while the load-flow engine uses `P = rated_mva · pf = (rated_kw/(η·pf)) · pf = rated_kw/η` (the *input* power). The diversity engine therefore under-counts induction-motor real-power demand by the factor 1/η (typically 7%). For a diversity/transformer-loading study this is a non-trivial systematic under-statement on every induction motor in the network. **P2** (non-conservative for transformer loading). Reviewer A's EE-13 covers the transformer aggregation boundary but does not catch this per-load kW accounting inconsistency.

---

## 4. Assessment of the "Verified correct" section

I checked the "Verified correct" claims for the engines in scope:

- **loadflow.py NR/Jacobian.** The eight Jacobian block formulas at `loadflow.py:3065–3112` match the standard polar forms term-by-term. I verified the diagonal entries symbolically:
  - `J1_diag = -Q_calc[i] - |V[i]|² · Y[i,i].imag` (line 3073) — standard ∂P/∂θ = −Q − B_ii·V² ✓
  - `J2_diag = P_calc[i]/|V[i]| + |V[i]| · Y[i,i].real` (line 3084) — standard ∂P/∂|V| = P/V + G_ii·V ✓
  - `J3_diag = P_calc[i] - |V[i]|² · Y[i,i].real` (line 3095) — standard ∂Q/∂θ = P − G_ii·V² ✓
  - `J4_diag = Q_calc[i]/|V[i]| - |V[i]| · Y[i,i].imag` (line 3107) — standard ∂Q/∂|V| = Q/V − B_ii·V ✓
  Off-diagonals match the standard Y·V forms. Reviewer A's 2-bus 0.4132+j0.3306 pu verification is plausible given the formulas. **Confirmed.**

- **GS PV-bus Q-estimation sign convention** (`loadflow.py:3177`): `Q_calc = (V[i] · conj(sum_yv + Y[i,i]·V[i])).imag`. This is the standard `Q = Im{V·conj(I_injected)}` convention, matching the NR Q_calc. Reviewer A's claim of 6-digit agreement with NR is consistent with the code. **Confirmed.** (Note: GS lacks the Q-limit clamp — see EE-R2-1.)

- **Single-transformer π-model** (`loadflow.py:1856–1873`): `Y[i,i] += y/t²; Y[j,j] += y; Y[i,j] -= y/t; Y[j,i] -= y/t` for tap on the i side — the standard off-nominal-ratio π-model. Direction verified: tap +5% on the HV side lowers the LV voltage (the ratio t = (V_hv/V_lv)·(1+tap) > 1 means `Y[j,j] += y` at the LV side, boosting LV voltage at fixed injection — equivalent to lowering the effective LV impedance). Reviewer A's claim of digit-perfect agreement at tap +5% is consistent. **Confirmed.**

- **Q-limit clamp** (`loadflow.py:1980–2095, 2119+`): the PV→PQ switching logic registers `q_max`/`q_min` from the rated-pf capability or explicit props (lines 1987–1989), then the outer loop clamps. The 10 MVA / 0.85 pf / Q_max = 6 Mvar example Reviewer A cites is consistent. **Confirmed.**

- **voltage_stability P-V nose.** The analytic maximum for E = 1, X = 0.25 pu, unity-pf load is P_max = E²/(2X) = 2.0 pu with nose voltage 1/√2 ≈ 0.707. The bisection implementation at `voltage_stability.py:157–168` brackets the nose with 6 bisection steps (BISECT_STEPS = 6, line 40) — a bracket width of (step)/2⁶ = step/64 ≈ 0.0016 for the default step 0.1. Reviewer A's λ_critical = 1.9984 (0.08% low) is consistent with this resolution. **Confirmed.**

- **Q-V curve mathematics.** `voltage_stability.py:240–304` sweeps `vv` from 1.15 down to 0.45 in 29 steps of 0.025 (line 270). The condenser is a 99999 MVA `generator` at P = 0 (rated_pf = 0.0, line 281) with a voltage setpoint. The bus is made PV (line 276). After convergence, `cb.q_mvar` is the net bus injection. The closed-form Q(V) = 4V² − 4√(V² − (PX)²) derivation matches Reviewer A's. **Confirmed.**

- **dynamic_motor_starting.py swing equation.** `2H·dω/dt = T_e − T_L` per-unit on `T_base = S_base/ω_sync` is the standard form; the dimensionality `dω_pu/dt = T_pu/2H` with `H = ½JΩ²/S_base` is correct. Reviewer A's mid-trajectory `dω/dt = 2.180 s⁻¹` vs `(T_e − T_L)/2H = 2.178 s⁻¹` cross-check is consistent. The starter transforms (star-delta Y/3, autotransformer a²Y/a·V, soft-starter αY/α²T) all verify. **Confirmed.**

- **grounding_system.py IEEE 80.** I did not re-derive every constant, but the formula references Reviewer A cites (Eq. 27 for C_s, Eq. 57 for R_g, Eq. 86 for K_m, Eq. 94 form for K_s, Eq. 88 for L_M rod weighting) are all referenced in the code comments and match the IEEE 80 annex. The 3–4 significant figure agreement with the Annex B hand calc is plausible given the formula implementation. **Confirmed** (modulo my not re-running the numbers, but the formula references check out).

- **cable_sizing.py.** The three-phase voltage drop `%ΔV = I·L·(R·cosφ + X·sinφ)/(V_LL/√3)` at lines 722–725 is the standard form; the √3 convention is correct. The adiabatic constants k = 143/94/115/76 (Cu-XLPE/Al-XLPE/Cu-PVC/Al-PVC) match IEC 60364-4-43 / BS 7671 Table 43.1. The thermal-equivalent `thermal_m_factor` formula matches IEC 60909-0 §12. **Confirmed.**

**The "Verified correct" claims are accurate and verifiable.**

---

## 5. Assessment of the "Overall engineering opinion" section

Reviewer A's per-engine verdicts are well-calibrated:

- **loadflow.py** — "numerical core correct to textbook accuracy; dispatch layer elaborate but did not produce power-balance errors in any test; fit for radial/lightly-meshed distribution studies *provided* EE-2 is fixed or hard-blocked." **Fair.** The NR/Jacobian/tap/per-unit/Q-limit core is genuinely high-quality; the EE-2 cascaded-chain bug was a legitimate blocker and is now fixed. The ideal-swing model is correctly flagged as a documented scope decision.

- **loadflow_cases.py / contingency.py / voltage_stability.py** — "sound architecture (never-raise batch re-solves); fix EE-3/EE-4/EE-6/EE-7 for correct labelling; with those, fit for screening-level security and stability studies." **Fair.** All three engines are now fixed for the listed items except EE-7 (labelling only, still open).

- **cable_sizing.py** — "formula-faithful to IEC 60364/60909-0 §12 and conservative in the right places; fit for purpose; clearing-time estimation is the weakest input." **Fair.** The EE-14 fuse bullet is the weakest input, as flagged.

- **motor_starting.py (static)** — "not currently fit for its stated purpose (voltage-dip acceptance) on stiff-looking drawings: EE-1 + EE-5 both bias non-conservative." **Fair *at the time of the original review*.** Post-fix, the static engine now ports the dynamic engine's Thevenin machinery and the df-1.0 fix lands; it is now fit for radial networks subject to the constant-PQ pessimism (EE-R2-3). The opinion should be updated to reflect the fix.

- **dynamic_motor_starting.py** — "the strongest engine reviewed; fit for purpose within its single-cage/IEEE 3002.7 scope." **Fair.** My independent review of the swing-equation integration, starter transforms, and nameplate-fit anchors confirms this.

- **load_diversity.py** — "simple and correct at bus level; transformer-level aggregation under-counts multi-level networks." **Fair**, and I add EE-R2-5 (induction-motor kW accounting understates by 1/η) as an additional understatement mechanism.

- **grounding_system.py** — "implements IEEE 80 faithfully; fit for preliminary grid design." **Fair.**

The priority-of-remediation ordering (EE-1, EE-5, EE-2, then EE-3/EE-4, then P3 hardening) is correct. The opinion is appropriately non-sycophantic — it calls the static motor-start engine "not currently fit" plainly.

---

## 6. Assessment of the remediation status claims

The top-of-document table claims EE-1, EE-2, EE-3, EE-4, EE-5, EE-6 are fixed. I verified each against the code:

| Finding | Claimed status | Code verification | Test pin |
|---|---|---|---|
| EE-1+EE-5+EE-12 (P1) | Fixed | `motor_starting.py:73–104, 211–215, 57`; `dynamic_motor_starting.py:261` | `test_verification_fixes.py::TestMotorStartingSourceImpedance` (4 tests, lines 273–310) ✓ |
| EE-2 (P1) | Fixed | `loadflow.py:1383–1457` (chain ratio product); `loadflow.py:1841–1854` (multi-xfmr warning) | `TestCascadedTransformerChain` (2 tests, lines 344–354) ✓ |
| EE-3 (P2) | Fixed | `loadflow.py:2384–2448` (I²R share apportioning) | `TestChainLossApportioning` (lines 390–396) ✓ |
| EE-4 (P2) | Fixed | `contingency.py:53–69, 84, 130–142` (synthetic-inclusive) | `TestContingencyDanglingLoad` (lines 403–421) ✓ |
| EE-6 (P2) | Fixed | `voltage_stability.py:136–172` (`observed_collapse` flag) | `TestVoltageStabilityCollapseFlag` (lines 428–444) ✓ |

**All six "Fixed" claims are substantiated by the code and pinned by regression tests.** The "Radial results byte-identical" claim for the PS-1 fix is also consistent with the test `test_radial_network_unchanged` (lines 98–119) asserting the radial Ik″ to 2e-3 absolute. The claim of 21 new tests in `test_verification_fixes.py` is accurate (the file is 444 lines, 16 test methods across 8 classes covering EE-1/2/3/4/5/6/12 and the PS-1/2/3/4/5/6 fixes).

The one consistency issue I note: the remediation table lumps EE-1+EE-5+EE-12 together as a single P1 line item, while the original findings list EE-1 as P1, EE-5 as P2, and EE-12 as P3. The bundled P1 rating is the consolidated-table rating from Part 3, and is the more defensible rating; but the table should make this consolidation explicit. Minor.

---

## 7. Overall engineering opinion on the power-system engines

My independent assessment, having read the code and verified Reviewer A's claims:

**The numerical cores are genuinely strong.** The Newton-Raphson Jacobian, the single-transformer tap π-model, the per-unit system, the IEC 60909 radial fault layer (PS-1's meshed-network fix aside), the IEEE 80 grounding implementation, the dynamic motor starting physics, and the cable sizing formulas all check out to the precision Reviewer A claims. This is unusual in screening-grade software and deserves the credit Reviewer A gives it.

**The defects are concentrated one layer up — network representation and result aggregation — exactly as Reviewer A states.** EE-2 (chain turns ratio), EE-3 (chain loss double-count), EE-4 (synthetic-bus accounting), and EE-10 (tap on lumped chain) are all manifestations of the same architectural seam: the load-flow solver is correct on a well-formed bus-branch network, but the chain-collapsing layer that maps user drawings to that bus-branch network is fragile. The fact that all four are rooted in the same layer is good news for remediation — a single "insert implicit buses at every transformer terminal and split chains there" refactor would close EE-2, EE-10, and the EE-3 row-repetition at the source.

**The EE-1/EE-5/EE-12 cluster** is the cleanest demonstration that the codebase's engineering judgement is sound: the static motor-start engine was the wrong design (re-use the ideal-swing load flow for a dip study), and the dynamic engine on the same drawings already contained the correct machinery. The fix (port the Thevenin superposition) is the right call. The residual constant-PQ pessimism (EE-R2-3) is on the correct side.

**The non-remediated P3 items I would prioritize next** are EE-9 (capacitor Q ∝ V²), which compounds with voltage_stability's load-scaling continuation to overstate loadability margins, and EE-R2-1 (GS lacks the Q-limit clamp), which is a latent correctness issue on user-selected GS. EE-8 (pf clamp) is trivial and should be closed in passing on any next touch to the load model.

**My verdict on Reviewer A's report:** Accurate, well-calibrated, and where I differ (EE-4 severity borderline-P1, EE-9 severity borderline-P2) the differences are within reasonable engineering judgement. The five additional findings I surface (EE-R2-1 through EE-R2-5) are mostly P3 hardening items and one P2 (EE-R2-1, the GS Q-limit omission) that the original review can be fairly criticised for missing — it is a real correctness gap in a documented-as-valid solver path. The "Verified correct" section is accurate and the remediation claims are all substantiated. The round-1 review is a high-quality piece of engineering verification and the round-1 fixes are real and well-pinned.

**Bottom line:** The power-system engines, in their current (post-round-1-fix) state, are fit for radial / lightly-meshed utility-fed distribution studies — load flow, fault, contingency, cable sizing, grounding, dynamic motor starting, and TCC coordination. They are not fit for: voltage-stability margins on capacitor-heavy networks (EE-9), N-1 verdicts on schematics with dangling loads *without* the EE-4 fix (now landed), or GS-solved networks with PV generators near reactive limits (EE-R2-1). The P1 block is closed; the residual open items are P2/P3 hardening.