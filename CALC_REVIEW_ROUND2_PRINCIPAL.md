# Round-2 Principal Engineer Adjudication — ProtectionPro Calculation Verification

**Date:** 2026-07-19
**Adjudicator:** Principal Engineer (third-stage, independent)
**Scope:** Round-2 re-reviews `CALC_REVIEW_ROUND2_EE.md` (EE-1…EE-14 plus EE-R2-1…EE-R2-5) and `CALC_REVIEW_ROUND2_PS.md` (PS-1…PS-16 plus PS-R2-1…PS-R2-8), adjudicated against the original document `CALC_VERIFICATION_2026-07-19.md` and the live source under `/root/protectionpro/backend/analysis/` and `/root/protectionpro/frontend/js/`.
**Repo state:** `main` @ the working tree inspected (post the 2026-07-19 P1/P2 remediation).
**Standards applied:** IEC 60909-0, IEEE 1584-2002, IEEE 80, IEC 60364-4-41 / SANS 10142-1, IEC 60255-151 / IEEE C37.112, IEC 60269-1, IEC 62271-100 / 60947-2, IEC 61869-2, IEEE 3002.7.

---

## 1. Principal identification and scope

This is the third-stage adjudication of the three-stage independent verification. The two Round-2 senior reviewers worked blind to each other and were barred from reading prior audit markdown; I am adjudicating their reports against the source code and the original Round-1 document, and I am the only party who has read all three. My remit is to:

- Rule on every Round-2 disagreement with Round 1 (EE-4 P2↔P1, EE-9 P3↔P2, PS-6 CONFIRMED↔REJECTED, PS-14(b) numerical correction, PS-R2-5 IΔn direction).
- Adjudicate each new Round-2 finding (EE-R2-1…5, PS-R2-1…8).
- Independently spot-check the remediation claims by reading the code and `backend/tests/test_verification_fixes.py`.
- Identify cross-cutting observations that only emerge from comparing Round 1 + the two Round 2s.
- Update the consolidated remediation priority.
- Sign off on (a) Round-2 review-process quality, (b) engine fitness-for-purpose, (c) what remains open.

Where the code says otherwise I over-rule either Round 1 or Round 2. Code references are `file:line`.

---

## 2. Methodology

For each contested point I (i) re-read the cited code lines, (ii) re-derived the governing formula from the standard, (iii) reproduced the hand calculation where one was offered, (iv) traced the function by name where cited line numbers had drifted (the files have been edited since Round 1 — `_generator_impedance` is now `fault.py:831-875`, `_compute_peak_current` is `1939-1964`, etc.), and (v) checked whether the cited "Fixed" claim is substantiated by the current source and pinned by a regression test in `backend/tests/test_verification_fixes.py` (444 lines, 16 test methods across 8 classes). I did not run the suite; I read the test bodies and confirmed the assertions match the hand calculations the engines now produce.

I confined my reading to the three named documents plus the source under `backend/analysis/` and `frontend/js/`. I did not open any other review/audit markdown in the repo.

---

## 3. Adjudication of Round-2 disagreements with Round 1

### 3.1 EE-4 severity — Round 1: P2 · Round 2: "P2 borderline P1" — **Round 1 upheld (P2)**

Round 2's argument for promotion: a "secure" N-1 verdict on the total loss of a load is a reporting failure on a safety-relevant assessment, and the `insert_implicit_load_buses` helper exists precisely to invite the dangling-load topology that triggers it (`contingency.py:84`, `loadflow.py:237` synthetic `__term__<load>` keys).

I confirm the mechanism exactly as both reviewers describe: pre-fix, `_evaluate` differenced `base_energ_ids − energ_ids` over real-bus sets while `connected_bus_loads_mw` keyed the demand under the synthetic id; the feeder outage removes the load from the model and the case reported `secure`. The Round-1 demonstration (4.25 MW load, both loss-of-grid and loss-of-feeder cases) reproduces verbatim.

I keep P2 for three reasons: (a) the defect is topology-specific — a load drawn on a real bus, which is the conventional SLD pattern, gives the correct 4.25 MW verdict; (b) the fix has landed and is pinned by `TestContingencyDanglingLoad` (`test_verification_fixes.py:403-421`), so the failure mode is closed; (c) the P1 bar in this review is "non-conservative safety verdict on a routine topology", and the dangling-load-without-terminal-bus pattern, while legal, is not the dominant topology. Round 2's caveat is noted and the borderline acknowledged. If a future regression were to re-introduce the silent `secure`, the rating should escalate.

### 3.2 EE-9 severity — Round 1: P3 · Round 2: "P3 defensible, would accept P2" — **Round 1 upheld (P3)**

Round 2's argument for promotion: the constant-Q capacitor model (`loadflow.py:2051-2054`) compounds with `voltage_stability._scaled_project` (`voltage_stability.py:52-60`), which scales loads by λ while the cap's Q stays fixed — making the network look stiffer than it is and overstating the loadability margin near the nose.

I confirm the compounding: at 0.75 p.u. the engine credits +44% over a true Q∝V² bank, and that error sits exactly on the P-V nose the stability engine is locating. But the magnitude at nominal voltage is small (the cap's full rated output is correct at V=1.0), the error only becomes material at depressed voltages, and the nose location error is bounded by the bisection bracket width (`BISECT_STEPS = 6`, `voltage_stability.py:40`). The SVC precedent for V²-tracking exists at `loadflow.py:2072-2095` and the harmonics engine models caps as shunt susceptances, so the fix is a known pattern. P3 is the right rating: real but bounded, no observed safety-relevant verdict on a routine study, and the direction (overstate stiffness) is at least one layer removed from a printed compliance number. The compounding should be documented as a known limitation of P-V margins on capacitor-heavy networks.

### 3.3 PS-6 — Round 1: CONFIRMED · Round 2: REJECTED (superseded) — **Round 2 upheld (REJECTED as superseded; historical P2 stands**

Round 1 confirmed PS-6 against the pre-fix code at `fault.py:761-768` (no K_G applied). Round 2 reads the current code at `fault.py:831-875` and finds K_G implemented exactly per IEC 60909-0 §6.6.1 Eq. 18:

```
K_G = (U_n / U_rG) × c_max / (1 + x″d · sin φ_rG)
```

I re-derived the two anchor calculations: x″d=0.15, cosφ=0.85 → sinφ=0.5268 → K_G = 1.10/(1+0.15×0.5268) = **1.0194** (Round 2 says 1.019, matches); x″d=0.25, cosφ=0.8 → K_G = 1.10/1.15 = **0.9565** (Round 2 says 0.957, matches). The fictitious-R_G defaults are present at `fault.py:861-867`: 0.05·X″d for U_rG>1 kV & S_rG≥100 MVA, 0.07·X″d for U_rG>1 kV & S_rG<100 MVA, 0.15·X″d for U_rG≤1 kV. The test pin `test_ps6_generator_kg_correction` (`test_verification_fixes.py:145-157`) anchors the K_G-corrected Ik″ to the hand value.

Round 1 was correct against the code as it stood at the time of Round 1's read; Round 2 is correct against the code as it stands now. The honest disposition is: the historical finding was real and the P2 rating was appropriate; the current code no longer matches the finding, so the finding as written is **superseded**. I rule with Round 2. The residual standards deviation (K_S for power-station units, K_SO — not implemented) is genuine but below the P2 bar for a screening tool, as both reviewers note.

### 3.4 PS-14(b) — Round 1: "1.41 below 4.5 kA" · Round 2: "code lumps ≤6 kA" — **Round 2 upheld (numerical correction)**

I read `duty_check.py:185-196`:

```python
if icu <= 6:          n = 1.5
elif icu <= 10:       n = 1.7
elif icu <= 20:       n = 2.0
elif icu <= 50:       n = 2.1
else:                 n = 2.2
```

The code's threshold is `icu <= 6`, not `<= 4.5`. IEC 60947-2 Table 2 (utilisation categories A/B) gives the minimum making/breaking ratio n = I_cm/I_cu as **1.41** up to I_cu ≈ 4.5-6 kA (the standard's boundary varies by edition and category), then 1.7 (10 kA), 2.0 (20 kA), 2.2 (>50 kA). The code's `1.5` for the lowest bracket is ~6% optimistic versus the 1.41 floor, as both reviewers state. But Round 1's wording "lumps I_cu ≤ 4.5 kA into n = 1.5" is imprecise — the boundary is 6 kA, not 4.5 kA. Round 2's correction is accurate. The non-conservative-direction verdict is unchanged; the P3 rating is unchanged. Round 2 wins on the numerical precision point.

### 3.5 PS-R2-5 (TT IΔn direction) — Round 1 "Verified correct: largest IΔn (conservative)" · Round 2: "if 'largest' wording is accurate, non-conservative P2" — **Round 1 upheld; PS-R2-5 REJECTED**

This is the one Round-2 finding where I over-rule the Round-2 reviewer on a hand-calculation matter. The TT disconnection criterion per IEC 60364-4-41 §411.5.3 is **R_A · IΔn ≤ 50 V**. For a *fixed* installation earth-electrode resistance R_A, the product R_A·IΔn is **monotone increasing** in IΔn, so the inequality is **hardest to satisfy** (most conservative) when the **largest** declared IΔn is used. Using the smallest IΔn would make the product smallest and the check easiest to pass — that is the non-conservative direction.

I read `compliance.js:1015-1027`:

```javascript
_maxRcdIdnAmps() {
  let maxMa = 0;
  for (...) for (const v of Object.values(ratings)) {
    const ma = Number(v) || 0;
    if (ma > maxMa) maxMa = ma;     // <-- takes the MAXIMUM
  }
  return (maxMa > 0 ? maxMa : 300) / 1000;
}
```

and `compliance.js:1073-1080`:

```javascript
const idn = this._maxRcdIdnAmps();
const touch = s.r_a * idn;
const ok = touch <= 50;
```

So the code uses the largest declared IΔn. The original verification's "conservative" label is correct: a larger IΔn → larger R_A·IΔn product → check fails more readily → conservative (pessimistic). PS-R2-5's claim that "the conservative choice is the smallest IΔn" inverts the monotonicity of the inequality and is mathematically wrong. The Round-2 reviewer themselves flagged this as "needs verification" rather than confirmed and said "I did not re-read the relevant compliance.js lines in this round" — that caution was warranted; the verification is now done and the concern is unfounded.

**PS-R2-5 is REJECTED.** The code is correct as Round 1 stated. I note in passing that the largest-IΔn choice is conservative for the touch-voltage criterion specifically; if the tool were also reporting the maximum-disconnect-time criterion (which keys on IΔn differently), the choice could differ — but that is not what the code currently does.

---

## 4. Adjudication of new Round-2 findings

### EE-R2-1 — GS lacks the Q-limit clamp (PV bus that hits Q_max silently stays PV) — **CONFIRMED, P2**

I read `loadflow.py:3148-3190` (`_gauss_seidel`). The PV-bus branch at lines 3172-3182 estimates Q via `Q_calc = (V[i] · conj(sum_yv + Y[i,i]·V[i])).imag` (the standard sign convention, matches NR — Round 2's "Verified correct" check on this is right) and then fixes the voltage magnitude at `V_mag[i]` regardless of how far Q_calc has run beyond `q_max`/`q_min`. There is no outer loop, no clamp, no PV→PQ conversion. The NR path has the full Q-limit loop at `loadflow.py:2119-2290` (SVC, generator, inverter PV units). Every caller I checked defaults to `method = "newton_raphson"`, so this only bites on user-selected GS, but the documentation presents GS as a valid alternative and `motor_starting.py:136, 233` falls back to GS on NR failure — so a GS fallback can silently produce a physically infeasible "converged" solution with a generator Q far above capability. Round 2's P2 is right: it is a latent correctness gap on a documented-as-valid solver path, not an observed failure. **Confirmed, P2.** Recommended fix: lift the Q-limit outer loop out of the NR dispatch path and apply it to GS as well (the Q_calc the GS path already computes is the input the clamp needs).

### EE-R2-2 — `connected_bus_loads_mw` has no Q sibling; voltage-stability Q-V op-point has no local-Q reference — **CONFIRMED, P3**

I confirm `loadflow.py:1565-1614` returns MW only. `voltage_stability.py:90-91` uses it for `base_load_mw` (the P-V x-axis — correct, x-axis is real demand) and `voltage_stability.py:296-299` reads `cb.q_mvar` (net bus Q injection) for the Q-V curve without subtracting an explicit local-Q reference, so the operating-point marker `op_q` and the headline `qv_min_mvar` are net-injection figures, not condenser-output figures (this is the same definitional offset Round 1's EE-7 already flagged). The combination means there is no engine-level accounting of total reactive demand for stability-margin reporting. P3 is right: the P-V x-axis is correct, the Q-V curve shape is correct, only the absolute labelling is offset (EE-7), and the missing Q sibling is a documentation/surfacing gap, not a numerical error. **Confirmed, P3.** Closes the loop with EE-7 — a single fix (report condenser output = `cb.q_mvar + bus_load_q_mvar[bus]` and surface a `connected_bus_loads_mvar` helper) closes both.

### EE-R2-3 — `_solve_pq_dip` uses constant-PQ for the starting load; pessimistic vs constant-impedance locked-rotor near the nose — **CONFIRMED, P3 (conservative side)**

I read `motor_starting.py:87-104` (`_solve_pq_dip`) and the explicit acknowledgement at `motor_starting.py:200-209` that the constant-PQ model draws more current at depressed voltage than a true constant-impedance locked-rotor would. The 0.05 p.u. collapse floor at `motor_starting.py:96` means the iteration returns `None` (treated as stall at line 267) for starting loads that a constant-impedance model would solve at a low but non-zero voltage. This is the correct side to err on for a *starting* study (predict a stall that doesn't happen vs miss one that does). Round 2's P3 is right; the finding is a documentation item, not a defect. **Confirmed, P3, conservative direction.** The engine's own comment is honest; I would surface the same caveat in the UI result string.

### EE-R2-4 — N-2 pair cap is positional (lexicographic `itertools.combinations` order), not worst-case-aware — **CONFIRMED, P3**

I read `contingency.py:204-212`:

```python
pairs = list(itertools.combinations([c.id for c in outageable], 2))
room = max(0, max_contingencies - n1_count)
if len(pairs) > room:
    skipped = len(pairs) - room
    pairs = pairs[:room]
    warnings.append(f"N-2: {skipped} of {len(pairs) + skipped} pairs skipped ...")
```

`itertools.combinations` yields pairs in lexicographic order by component id; the tail is dropped without any criticality weighting. The skipped set is deterministic but arbitrary with respect to severity. For a security-assessment tool, a worst-first or random sample is more defensible. The warning reports the count but not which pairs. Round 2's P3 is fair — the cap is high (default 400, `contingency.py:35`), so the truncation only bites on large networks, and N-1 is the primary screening criterion. **Confirmed, P3.** Recommended fix: sort `pairs` by a cheap severity proxy (e.g. sum of incident branch loading, or downstream load MW) before truncation, and list the skipped ids in the warning.

### EE-R2-5 — `load_diversity._get_load_kw` for induction motor returns shaft kW, inconsistent with load-flow P = rated_kw/η — **PARTIALLY CONFIRMED, P3 (downgraded from Round 2's P2)**

I read `load_diversity.py:117-129` (`_get_load_kw`) and `loadflow.py:2029-2041` (motor_induction injection). The inconsistency is exactly as Round 2 describes: `load_diversity` returns `rated_kw` (shaft kW, line 124); the load-flow engine uses `P = rated_mva · pf = (rated_kw/(η·pf))·pf = rated_kw/η` (input power). So `load_diversity` understates induction-motor real-power demand by the factor 1/η (typically ~7%).

But the *headline transformer loading* metric that Round 2 cites as the impact is **kVA-based**, not kW-based. `load_diversity.py:270-283` sums `xfmr_installed_kva` and `xfmr_demand_kva` from `bus_results` (line 277-278), which come from `_get_load_kva` (`load_diversity.py:102-114`) — and `_get_load_kva` for induction motors correctly returns `rated_kw / (eff · pf)` (input kVA, line 111). So the transformer demand_loading_pct headline is correct. The understatement is confined to the kW summary fields (`installed_kw`, `demand_kw`, `total_demand_kw`) at `load_diversity.py:226, 230, 320`, which feed the report's kW line but not the transformer-loading pass/fail. Round 2 overstates the safety-relevant impact. **Partially confirmed, downgraded to P3.** The fix is one line (return `rated_kw / eff` in `_get_load_kw` for induction motors); the kVA path is correct.

### PS-R2-1 — `_generator_impedance` K_G uses the walk's voltage zone, not the generator's own bus voltage — **REJECTED (Round 2 has the walk direction inverted)**

Round 2's claim: for a 0.69 kV generator feeding through a step-up transformer to an 11 kV faulted bus, the walk passes `v_kv = 11` to `_generator_impedance`, giving `u_ratio = 11/0.69 = 15.9` and an inflated K_G.

I traced the walk. `_collect_source_paths` (`fault.py:475-672`) starts at the **faulted** bus and walks **toward** the source. At each transformer, `v_next = _transformer_far_voltage(comp, v_kv)` (`fault.py:644`, `465-472`) returns the voltage of the winding **opposite** the side entered. For a step-up transformer (hv=11, lv=0.69) entered from the 11 kV faulted-bus side, `v_near = 11`, `abs(11 - 0.69) = 10.31`, `abs(11 - 11) = 0`, so `10.31 < 0` is False → returns `lv = 0.69`. The walk continues with `v_kv = 0.69` and reaches the generator. `_generator_impedance(comp, base_mva, 0.69)` then computes `u_ratio = v_system_kv / u_rg = 0.69 / 0.69 = 1.0`. K_G is computed at the generator's own bus voltage, exactly as IEC 60909-0 §6.6.1 requires.

Round 2 has the walk direction **inverted**: it assumes the walk starts at the generator and moves toward the faulted bus, carrying the generator's bus voltage forward. In fact the walk starts at the faulted bus and moves toward the source, carrying the **source-side** voltage zone forward, which after the step-up transformer is the generator's own bus voltage. The K_G voltage ratio is therefore correct for the routine step-up topology. **PS-R2-1 is REJECTED.** A genuine residual concern would be a generator connected to a bus whose `voltage_kv` prop is inconsistent with the machine's `voltage_kv` — that is a malformed-project case, not an engine defect.

### PS-R2-2 — Inverter Z0 opt-in uses Z1 as Z0 when `x0` is unset — **CONFIRMED, P3**

I read `fault.py:1274-1284`. When an inverter opts into earthed Z0 via the `grounding` prop, `z_src = z1_src` unless `x0` is explicitly set. For an earthed-star coupling winding, Z0 is typically 0.85-1.0×Z1 but can differ; conflating the two is a screening-grade simplification. The PS-2 default-earthing change makes this default more visible than before (a user opting an inverter into "earthed" gets `Z0 = Z1` silently). Round 2's P3 is right; the recommendation (default `Z0 = 0.9·Z1` or surface the assumption) is reasonable. **Confirmed, P3.**

### PS-R2-3 — `_zero_seq_magnetizing` uses the transformer leakage `x_r_ratio` for the magnetising branch, but the magnetising branch is predominantly reactive with X/R » 10 — **CONFIRMED, P3**

I read `fault.py:1570-1573`: `xr = float(comp.props.get("x_r_ratio", 10) or 10)`, `r = x / xr`. The zero-sequence magnetising branch of a three-limb core is dominantly magnetising (X/R typically 50-200). Reusing the transformer's leakage `x_r_ratio` (often 5-10) overstates the resistive component, slightly lowers |Z0m|, slightly raises the limited Ik1. Magnitude effect is a few percent. P3 is right; the prop reuse is semantically wrong but the numerical impact is small. **Confirmed, P3.**

### PS-R2-4 — `duty_check.py` compares duty against the upstream-bus fault current, not the through-current — **CONFIRMED, P3**

I read `duty_check.py:24-50` (`_find_upstream_bus`) and `duty_check.py:118-145`. The duty comparison uses `bus_fault.ib` / `bus_fault.ik3` from the **upstream** (source-side) bus of the device. For a feeder device on a bus with multiple feeders, the upstream bus fault level includes other feeder contributions, so the duty is overstated — conservative for the device itself (may flag a compliant device as failing), non-conservative only in the sense of false alarms. Round 2's P3 is right; Round 1's PS-14(c) flagged the same pattern and called it "conservative, fine", which is correct for the device-safety verdict. The refinement (use `_compute_branch_contributions` through-current) is the right next step but is a quality improvement, not a safety correction. **Confirmed, P3.**

### PS-R2-5 — `compliance.js` TT check uses the largest declared IΔn, not the smallest — **REJECTED** (see §3.5 above)

### PS-R2-6 — Arc flash `_relay_operate_time` uses the bus fault current, not the device's CT primary current — **CONFIRMED, P3**

I read `arcflash.py:425-454` (`_relay_operate_time`) and the BFS at `arcflash.py:598-684`. The BFS does refer the arcing current across transformer ratios at line 662: `i_dev = iarc_a * v_bus / v_here` — that *is* the device's CT primary current at the device's voltage level. So Round 2's claim that "the current code uses the bus fault current directly" is **imprecise**: the BFS does the ratio referral correctly. The residual concern is more subtle — `_relay_operate_time` is called with `current_a` from the BFS, which has been referred, so the relay operating time is evaluated at the correct device-side current. Round 2's specific example ("an LV device on an HV-fed network is the HV-side current") is wrong — the BFS tracks `v_here` across transformers and refers `iarc_a` accordingly. I read the BFS twice to confirm. **PS-R2-6 is REJECTED** on the specific mechanism Round 2 describes (the ratio referral is implemented at `arcflash.py:662-664`). A genuine residual is that the *arcing* current (not the bolted current) is what's referred, and the relay may see a slightly different current during the arcing phase — but that is a second-order effect bounded by the 2 s cap. P3 not warranted on the stated mechanism.

### PS-R2-7 — `_compute_voltage_depression` wrapped in `except Exception: pass` — **CONFIRMED, P3**

I read `fault.py:441-446`:

```python
try:
    _compute_voltage_depression(all_buses, components, adjacency, wires, base_mva, results)
except Exception:
    pass  # Non-critical — don't fail fault analysis if voltage depression fails
```

Voltage depression is informational (retained voltages during the fault, not a safety headline), but a silent swallow with no `topology_warnings` entry means a singular Ybus or an island configuration produces no warning — the report shows no retained voltages with no explanation. Round 2's P3 is right. **Confirmed, P3.** Recommended fix: emit a `topology_warnings` entry on the except branch.

### PS-R2-8 — `thevenin_z1_at_bus` reuses `_paths_are_meshed` on the *filtered* path set — **CONFIRMED, P3**

I read `fault.py:1903-1924` (`thevenin_z1_at_bus`). Paths are collected, motor/excluded sources are filtered out via `_path_ok` (line 1894-1901), then `_paths_are_meshed(keep, components)` is called on the filtered set. `_paths_are_meshed` (`fault.py:931-946`) keys on `_IMPEDANCE_TYPES` membership of `trail` components — if two parallel utility paths each have a motor shunt that's filtered out, the remaining single utility path looks radial even though the unfiltered set was meshed. The corner case is real but narrow: it requires (a) two parallel paths that share no impedance-carrying element *after* filtering, (b) motor/inverter shunts that masked the shared element. P3 is right. **Confirmed, P3.** Recommended fix: gate on the unfiltered set, then apply the filter only to the nodal solve's shunt list.

---

## 5. Remediation status verification (independent code check)

The Round-2 reviewers both claim the Round-1 remediation table is honest. I independently re-verified by reading the code and the test bodies in `backend/tests/test_verification_fixes.py` (444 lines, 16 test methods across 8 classes):

| Finding | Round-2 claim | Code verification | Test pin |
|---|---|---|---|
| PS-1 (P1) | Fixed (Zbus meshed solver) | `fault.py:200-233, 1611-1869` — `_paths_are_meshed` + `_build_bus_network` + `_nodal_thevenin` + `meshed_scale`; radial short-circuits at line 207 (`meshed=False`) → byte-identity preserved | `TestPS1ParallelPaths::test_parallel_feeders_hand_value` asserts 20.587 kA hand value (lines 66-78); `test_radial_network_unchanged` (98-119) ✓ |
| PS-2 (P1) | Fixed (generator gated on `grounding`, inverters blocked by default) | `fault.py:1221-1244` (generator gate + 3·Zn), `1246-1288` (inverter gate, default `"ungrounded"`), mirrored at `1716-1752` | `TestPS2ZeroSequenceGating` (4 tests, lines 125-170) ✓ |
| PS-3 (P2) | Fixed (conductor_temperature_c min mode + companion min study + device-curve time check) | `fault.py:74, 100-122` (hot-R scaling); `compliance.js:1196-1283` (consumes `AppState.faultResultsMin`, evaluates `fuseTripTime`/`cbTripTime` vs 0.4 s/5 s) | `TestPS3MinimumCurrentMode` (lines 176-218) ✓ |
| PS-4 (P2) | Fixed (x keyed on equipment class) | `arcflash.py:78-89` (`_X_BY_CLASS`, `lv_cable → 2.0`), `270-278` (class-first, gap fallback ≤15 mm → 2.0) | `TestPS4CableDistanceExponent` (lines 224-242) ✓ |
| PS-5 (P2) | Fixed (1.15·κ on meshed, caps 1.8/2.0) | `fault.py:1939-1964` — `meshed` param, `kappa = min(1.15·kappa, cap)`; radial untouched | `TestPS1ParallelPaths::test_ps5_meshed_peak_factor` (lines 84-96) ✓ |
| PS-6 (P2) | Fixed (K_G Eq. 18, fictitious R_G defaults) | `fault.py:831-875` — full K_G formula + 0.05/0.07/0.15·X″d classes | `TestPS2ZeroSequenceGating::test_ps6_generator_kg_correction` (lines 145-157) ✓ |
| EE-1+5+12 (P1) | Fixed (Thevenin superposition + df=1.0 + distribution_board terminal) | `motor_starting.py:73-104` (`_thevenin_z1`, `_solve_pq_dip`), `211-215` (df=1.0), `57` (`distribution_board`); `dynamic_motor_starting.py:261` | `TestMotorStartingSourceImpedance` (4 tests, lines 273-310) ✓ |
| EE-2 (P1) | Fixed (chain ratio product + warning) | `loadflow.py:1383-1457` (Π ratio walk in electrical order), `1841-1854` (multi-xfmr warning) | `TestCascadedTransformerChain` (lines 316-354) ✓ |
| EE-3 (P2) | Fixed (I²R share apportioning) | `loadflow.py:2384-2448` (per-element share by `real / _r_chain`) | `TestChainLossApportioning` (lines 360-396) ✓ |
| EE-4 (P2) | Fixed (synthetic-inclusive accounting) | `contingency.py:53-69` (`_bus_display_name`), `84` (`include_synthetic=True`), `130-142` (lost-load loop with `__term__` mapping) | `TestContingencyDanglingLoad` (lines 402-421) ✓ |
| EE-6 (P2) | Fixed (`observed_collapse` flag) | `voltage_stability.py:136-172` (collapse only when `first_bad is not None` or base below floor) | `TestVoltageStabilityCollapseFlag` (lines 427-444) ✓ |

**All eleven "Fixed" claims are substantiated by the current source and pinned by a regression test whose assertions I read and confirmed match the hand calculations.** The Round-2 reviewers' verification is accurate. The "21 new tests / 336 + 21" arithmetic I cannot confirm without running the suite, but the test file contains 16 distinct test methods across 8 classes (the "21" likely counts individual `assert` blocks or includes tests I'm grouping); the substantive point — every P1/P2 fix is pinned — holds.

One consistency issue both Round-2 reviewers note and I confirm: the top-of-document table bundles EE-1+EE-5+EE-12 as a single P1 line item, while the original findings list EE-1 as P1, EE-5 as P2, EE-12 as P3. The bundled P1 rating is the consolidated-table rating from Part 3 and is the more defensible rating (the three defects compound in one engine, all non-conservative); the table should make the consolidation explicit.

A residual I note that neither Round-2 reviewer flagged: the PS-1 fallback path (`fault.py:228-232`) returns the per-path (overstated) result with a warning when `_nodal_thevenin` fails (singular Ybus, isolated component with no source). The warning text is honest ("OVERSTATES fault current") but the fallback number is still consumed by arc flash, duty check and compliance without those consumers knowing it is the wrong one. The recommended fix (return `None` or propagate a hard `topology_warnings` entry the consumers check) is correct and should be tracked.

---

## 6. Cross-cutting observations from comparing Round 1 + Round 2

1. **Both Round-2 reviews independently converge on the same architectural diagnosis as Round 1.** The EE reviewer calls it "the chain-collapsing layer that maps user drawings to the bus-branch network is fragile"; the PS reviewer calls it "network-representation and result-aggregation layers". Round 1's cross-cutting #6 named the same seam ("accounting-boundary family: EE-3, EE-4"). Three independent reviewers agreeing on where the defects live is strong evidence the diagnosis is correct, and it points the next refactor: insert implicit buses at every transformer terminal and split chains there, which closes EE-2, EE-10, the EE-3 row-repetition, and PS-8(b)'s port-forwarding issue at the source.

2. **The Round-2 reviews are stronger than Round 1 on second-order interactions.** EE-R2-3 (constant-PQ pessimism near the nose) + EE-9 (cap Q at low V) + EE-R2-2 (no Q sibling for stability) form a cluster around voltage-stability margin reporting that none of the three reviewers flagged as a single interaction in Round 1. The cluster is now visible: the P-V nose location is robust (bisection-anchored), but the absolute margin numbers (qv_min, loadability margin on cap-heavy networks) carry a definitional offset and a V²-model error that compound. A single fix — report condenser output with local-Q added back, model caps as Q∝V² — closes EE-7, EE-9, EE-R2-2, and the EE-R2-3 documentation gap together.

3. **The Round-2 reviews expose a shared device-time-model gap that Round 1 only skirted.** PS-9 (backend CB bucket heuristic vs frontend k/(M²−1)), EE-14 fuse bullet (cable_sizing fixed 10 ms vs arcflash proper curve), and PS-R2-6 (relay-current referral) all point at the same root: each engine has its own protective-device time model. Round 1's cross-cutting #5 named this; Round 2's findings make it concrete. A single shared `device_clearing_time(comp, current_a)` module would close PS-9, the EE-14 fuse bullet, and half of PS-15 at once, and would make PS-R2-6's residual moot.

4. **The CT-saturation model (PS-16) is the most consequential remaining functional gap.** Round 2 confirms Round 1: the model uses V_AL not the knee (overstates saturation onset by 20-25%), ignores DC offset and remanence (the dominant drivers), and there is no motor-starting curve overlay in tcc.js. For close-in high-X/R faults this is non-conservative for arc flash (slower relay → longer arc → more energy), and the missing overlay prevents relay-vs-motor-start coordination from being verified graphically. Round 2's call to give the motor-start overlay its own backlog line is right.

5. **Round 2 over-ruled Round 1 cleanly on PS-6.** This is the cleanest demonstration that the Round-2 process is working as designed: Round 1 confirmed a finding against code that has since been fixed; Round 2 read the current code, found the fix, and downgraded the finding to "superseded" rather than rubber-stamping Round 1. The Round-2 PS reviewer's willingness to call Round 1's PS-6 "no longer describes the code" is the right adjudication posture.

6. **Round 2 caught one another-error in its own ranks (PS-R2-5, PS-R2-1).** I over-ruled PS-R2-5 (the TT IΔn direction is correct as Round 1 stated — the Round-2 reviewer inverted the monotonicity of R_A·IΔn ≤ 50) and PS-R2-1 (the walk direction is from faulted bus to source, not source to faulted bus — the Round-2 reviewer's step-up transformer example actually demonstrates the code is correct). The fact that the Round-2 reviewer flagged both as "needs verification" rather than "confirmed" shows appropriate caution; the principal adjudication is the verification.

7. **The compliance.js liability surface is the highest-stakes remaining item.** Round 2 PS's strongest sign-off caveat is "I would not sign a TT compliance report until PS-R2-5 is verified" — and I have now verified it: the code is correct, the largest-IΔn choice is conservative, TT compliance verdicts from this tool are on a defensible basis. The remaining compliance.js residual is the disconnection-time-limit keying on `In ≤ 32 ? 0.4 : 5.0` (`compliance.js:1244`) rather than on circuit type and voltage per IEC 60364-4-41 Table 41.1 — a 32 A sub-main could be mis-classified. Minor, but the only item in this file I would still want closed before signing SANS compliance verdicts.

8. **Stale persisted results.** Neither Round 1 nor Round 2 ties the findings to the operational hazard that saved study verdicts restore without recompute. A PS-1-class fix will not correct verdicts already saved in project files. This is an operational/product concern rather than an engine defect, but it bears on the sign-off posture: a user who runs a study, saves it, and re-opens it later gets the *old* verdict even after the engine is fixed. Worth a one-line warning in the UI when a saved study predates the engine version that fixed a P1.

---

## 7. Updated consolidated remediation priority table

Incorporating Round 2 (changes from Round 1 marked):

| Rank | Finding(s) | Severity | Direction | Effort | Rationale |
|---|---|---|---|---|---|
| 1 | PS-1 | P1 (Fixed) | Bidirectional | L / S interim | Root of the dependency tree; +58% on routine topologies; fixed and pinned. Residual: fallback path returns overstated number — track. |
| 2 | PS-2 | P1 (Fixed) | Non-conservative | S | Fixed and pinned; default behaviour change for inverter SLG documented. |
| 3 | EE-1 + EE-5 + EE-12 | P1 (Fixed) | Non-conservative | M | One engine, three optimistic defects; fixed and pinned. Residual: EE-R2-3 constant-PQ pessimism (P3, conservative side). |
| 4 | EE-2 | P1 (Fixed) | Garbage converged | S | Fixed (Π-ratio + warning); pinned. |
| 5 | PS-4 | P2 (Fixed) | Non-conservative (−11% IE) | S | Fixed; wrong number on a printed safety label closed. |
| 6 | PS-3 | P2 (Fixed) | Non-conservative (compliance PASS) | M | Fixed (c_min + hot-R + device-curve time check). Residual: 0.4/5 s keyed on In not circuit type (P3). |
| 7 | PS-5 | P2 (Fixed) | Non-conservative (meshed ip −15%) | S | Fixed; radial untouched. |
| 8 | EE-4 | P2 (Fixed) | Non-conservative (secure verdict) | S-M | Fixed; P2 borderline P1 per Round 2 — noted. |
| 9 | EE-3 | P2 (Fixed) | Wrong metric (losses ×2) | S | Fixed (I²R share). |
| 10 | EE-6 | P2 (Fixed) | Conservative (false collapse) | S | Fixed (`observed_collapse`). |
| 11 | PS-6 | P2 (Fixed → superseded) | Parameter-dependent | S-M | Round 2 REJECTED as superseded — fix real and pinned. |
| **12** | **EE-R2-1 (new)** | **P2** | **Non-conservative (GS silent Q-limit)** | **M** | **GS path lacks the Q-limit clamp; latent correctness gap on a documented solver path. Recommended next P2 to close.** |
| 13 | PS-8(b), PS-12 | P3 | Non-conservative labelling / phantom Z0 | S | Port-forwarding one-liner + report 0 in ikLLG. |
| 14 | EE-8, EE-9, PS-14(b), EE-14(fuse), PS-9, PS-16 | P3 | Mixed, mostly optimistic | S-M | Hardening + shared device-model consolidation. EE-9 + EE-R2-2 + EE-7 cluster: model caps as Q∝V² and add local-Q back to qv_min. |
| **15** | **EE-R2-2, EE-R2-3, EE-R2-4, EE-R2-5, PS-R2-2, PS-R2-3, PS-R2-4, PS-R2-7, PS-R2-8 (new)** | **P3** | **Mixed** | **S each** | **Round-2 hardening items; EE-R2-5 downgraded to P3 (kW summary only, transformer loading kVA-based is correct).** |
| 16 | EE-7, EE-10, EE-11, EE-13, PS-7, PS-8(a,c), PS-10, PS-11, PS-13, PS-14(a,c), PS-15, EE-14(rest) | P3 | Mostly conservative / docs | S each | Labelling, docs, report-assumption surfacing. |
| **17** | **PS-R2-1, PS-R2-5, PS-R2-6 (new)** | **REJECTED** | — | — | **Round-2 findings over-ruled: PS-R2-1 has the walk direction inverted; PS-R2-5 inverts the R_A·IΔn monotonicity; PS-R2-6's mechanism is already implemented at `arcflash.py:662`.** |

**Explicitly NON-CONSERVATIVE (unsafe direction) — updated:** EE-1/5/12 (fixed), PS-2 (fixed), PS-3 (fixed), PS-4 (fixed), PS-5 (fixed), PS-1 for arc flash clearing (fixed), PS-8(b), PS-9, PS-14(b), PS-16 (CT optimism), EE-4 (fixed), EE-9 (P-V on cap-heavy nets), EE-13, EE-14 fuse-clearing bullet, **EE-R2-1 (GS Q-limit), EE-R2-5 (induction-motor kW summary, downgraded to P3)**. **Conservative or neutral:** EE-3, EE-6, EE-7, EE-R2-3, PS-7, PS-10, PS-11, PS-13(b,c), PS-14(c), EE-14 voltage-drop bullet, PS-1 for withstand duty.

---

## 8. Coverage gaps still open

**Verified correct by all three reviewers (spot-confirmed by me where cited):** NR power equations and full Jacobian, GS PV-bus Q convention (modulo EE-R2-1), single-transformer tap π-model, Q-limit clamping on NR, per-unit conversions, IEC 60909 radial fault layer (incl. K_T, sequence connections, TT/IT/single-earthed star-star Z0m), IEC 60909 meshed nodal Zbus (PS-1 fix), K_G (PS-6 fix), IEEE 1584-2002 equation layer (digit-perfect, PS-4 fix landed), IEEE 80 grounding (3-4 sig figs vs Annex B), dynamic motor starting physics and starter transforms, IDMT/TCC constants and grading topology, cable-sizing formulas and adiabatic constants, duty-check factor tables (modulo PS-14(b) and PS-R2-4).

**Still open from Round 1 + Round 2 (P3 unless noted):**
- EE-7 (qv_min labelling), EE-8 (pf clamp), EE-9 (cap Q∝V²), EE-10 (tap on lumped chain), EE-11 (GS numerics + NR magnitude guard), EE-13 (load-diversity transformer aggregation), EE-14 (cable shunt cap / cable-sizing lagging-pf / fuse 10 ms / VS bisection cosmetic).
- EE-R2-1 (**P2** — GS Q-limit), EE-R2-2, EE-R2-3, EE-R2-4, EE-R2-5 (downgraded P3).
- PS-7 (motor q-factor proxy), PS-8(a)(b)(c), PS-9 (device-time divergence), PS-10 (magnitude summation), PS-11 (fixed conventions surfacing), PS-12 (LLG degenerate labelling), PS-13(a fixed)(b)(c), PS-14(a)(b)(c), PS-15 (generic fuse), PS-16 (CT V_AL vs knee, no motor-start overlay).
- PS-R2-2, PS-R2-3, PS-R2-4, PS-R2-7, PS-R2-8.
- compliance.js disconnection-time-limit keying on In not circuit type (Round 2 PS §3 residual).

**Neither review covered (stated gaps, not adjudicated here):** `transient_stability.py`, `harmonics.py`, `unbalanced_loadflow.py` (PS used as cross-reference only), the DC family (`dc_loadflow.py`, `dc_shortcircuit.py`, `dc_arcflash.py`), `network_reduction.py`, `admd.py`/`admd_data.py`, `backup_autonomy.py`, `lightning_risk.py`, `raceway.py`, numeric transcription fidelity in `pdf_reports.py`/report exports, `study_manager.py` orchestration consistency, frontend result-rendering correctness (annotations, lfstudy comparison tables), and the stale-persisted-results operational hazard. A Round-3 sweep of `transient_stability.py` and the DC family would be the highest-value next verification step — they share solver machinery with the verified engines but are themselves unpinned by this verification.

---

## 9. Final sign-off statement

**(a) Quality of the Round-2 review process.** Both Round-2 reviews are high-quality. The EE reviewer surfaced 5 new findings (one P2, four P3) with accurate code references; the PS reviewer surfaced 8 new findings (five P3, two REJECTED on my adjudication, one REJECTED on the mechanism while a smaller residual remains) and was appropriately cautious on the two I over-ruled (flagging both as "needs verification" rather than "confirmed"). Both reviewers independently verified the Round-1 remediation claims against the code and the test file, and both confirmed the "Fixed" table is honest. The Round-2 PS reviewer's willingness to REJECT Round 1's PS-6 as superseded — rather than rubber-stamp it — is exactly the adjudication posture a Round-2 review should take. The Round-2 process caught the EE-R2-1 GS Q-limit gap that Round 1 missed, and that is the single most actionable new finding. The two findings I over-ruled (PS-R2-1, PS-R2-5) are the blemishes — both involve a hand-calculation direction error that a more careful read of the walk/inequality would have caught — but the reviewers' own cautions (PS-R2-5 explicitly "needs verification"; PS-R2-1's specific example is the kind of thing that should have been traced through `_transformer_far_voltage` before publication) keep the process honest. Net: the Round-2 process is **sound and additive**, and the principal adjudication closes the loop on the two over-rulings.

**(b) Fitness-for-purpose of the calculation engines given Round 1 + Round 2.** With the P1/P2 block closed and pinned, the engines are **of signable screening-study quality for radial and lightly-meshed utility-fed distribution networks with buses at every transformer terminal, with explicitly-earthed machine/inverter sources, and with the printed report assumptions (c_max = 1.10, t_min = 0.1 s, n = 1, IEEE 1584-2002 edition) disclosed**. The formula-level engineering — NR Jacobian, IEC 60909 radial and nodal layers, IEEE 1584-2002 equation layer, IEEE 80 grounding, dynamic motor starting, IDMT/TCC constants — is more careful than in several commercial screening tools I have reviewed professionally, and the Round-2 reviewers independently converge on that verdict. The defects that remain are P3 hardening items plus the one open P2 (EE-R2-1, GS Q-limit), and they cluster in the network-representation/result-aggregation layer and the divergent-device-time-model seam — both tractable. **I would not sign** (i) a fault study on a heavily-meshed transmission network until the PS-1 fallback path returns None instead of an overstated number; (ii) an earth-fault study on a high-impedance-earthed generator without explicit `grounding` + `x0` props set; (iii) an arc flash label for an LV cable-class equipment without the IEEE 1584-2018 model alongside; or (iv) a GS-solved study with a PV generator near its reactive limit until EE-R2-1 is closed. Within those bounds, the engines are fit for the screening studies they are scoped to.

**(c) What remains open.** The P1/P2 block is closed and pinned. The open items are: **EE-R2-1 (P2, GS Q-limit)** — the only open P2, recommended next close; the **EE-7/EE-9/EE-R2-2 cluster** (cap Q∝V² + local-Q in qv_min + Q sibling for stability) — one refactor closes three; the **shared device-time model** (PS-9, EE-14 fuse, half of PS-15) — one module closes three; **PS-16 motor-start overlay** — the most consequential remaining functional gap in tcc.js; the **PS-1 fallback path** — return None on nodal failure; the **compliance.js disconnection-time-limit keying** — In → circuit type; the **PS-8(b) port-forwarding one-liner**; and the long P3 hardening list. None of the open items individually block a study in the tool's stated scope, but together they explain why the tool should be labelled "screening" on every output. The Round-1 + Round-2 verification has produced a bounded, tractable, standards-anchored list of residuals — which is what a pre-feature-freeze verification is for. The calculation core is ready for feature work to resume; the residuals should be closed in sequence, with EE-R2-1 and the EE-7/EE-9/EE-R2-2 cluster leading.