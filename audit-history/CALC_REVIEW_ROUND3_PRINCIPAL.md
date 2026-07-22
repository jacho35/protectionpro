# Round-3 Principal Engineer Verification — ProtectionPro Calculation Review

**Date:** 2026-07-20
**Reviewer:** Principal Electrical Engineer (third-stage verification pass)
**Scope:** Re-verification of every finding left open by the Round-2 adjudication (`CALC_REVIEW_ROUND2_PRINCIPAL.md`) — EE-R2-1..5, PS-R2-2/3/4/7/8, the PS-1 fallback residual, the compliance.js disconnection-time keying, the stale-persisted-results hazard, and the tcc.js motor-start overlay gap — against the code **as it stands now**.
**Repo state:** branch `fix/calc-verification-p1-p2`, HEAD `83c541f`, **working tree including the uncommitted 2026-07-20 P3 remediation** (all 16 Round-1 P3 findings closed; `backend/tests/test_p3_fixes.py` added). All Round-2 line references have drifted; every citation below is against the current working tree.
**Standards applied:** IEC 60909-0, IEC 60364-4-41 / SANS 10142-1, IEC 62271-100, IEC 60947-2, IEEE 1584-2002, IEEE 3002.7, IEC 61869-2.

---

## 1. Methodology

For each finding I (i) read the current source at the cited functions (all references are current-tree `file:line`), (ii) attempted to **refute** the finding before confirming it — including re-deriving the governing physics/standards claim, (iii) checked whether the uncommitted 2026-07-20 P3 work closed or altered it, and (iv) where the verdict turned on solver behaviour, reproduced it numerically inside the project's Docker image (`protectionpro-backend`, Python 3.12/NumPy) by building small `ProjectData` networks and calling the engines directly. No code was modified. Verdict vocabulary: **CONFIRMED / PARTIALLY CONFIRMED / REJECTED / SUPERSEDED-BY-P3-WORK**; direction is the safety direction of the error (conservative = pessimistic).

Two Round-2 CONFIRMED findings are over-ruled in this pass (EE-R2-1, PS-R2-8). In both cases the refutation is mechanical — one by direct numerical demonstration, one by re-deriving the validity condition of the per-path parallel combination — and is laid out in full so it can be checked.

---

## 2. Per-finding adjudication

### Finding 1 — EE-R2-1 (P2): Gauss-Seidel lacks the PV-bus reactive-limit clamp — **REJECTED (over-ruling Round 2)**

**Claim:** `_gauss_seidel` (`loadflow.py:3230-3285`) has no Q-limit clamp; a PV generator solved with GS holds voltage with unbounded Q and reports a physically infeasible "converged" solution. Reachable without user selection because `motor_starting.py:136, 233` falls back to GS.

**What the code actually does.** The reactive-limit clamp does not live inside either solver — it lives in `run_load_flow`'s **outer loop**, which is method-agnostic:

- `loadflow.py:2182-2187` — "Outer loop enforces reactive limits on voltage-regulating buses…" wrapping
- `loadflow.py:2199-2200` — `solve_with_islands(Y, P_spec, Q_spec, V_spec, bus_types, dispatch["dead_idx"], method)`, which dispatches to `_gauss_seidel` at `loadflow.py:1331-1332` / `1342-1344` when `method == "gauss_seidel"`;
- the clamp then evaluates `S_reg = V · conj(Y·V)` on the **converged solution from whichever solver ran** and converts PV→PQ at `q_max`/`q_min` (`loadflow.py:2286-2316` for generators, `2323-2352` for inverters, `2254-2279` for SVC/STATCOM), re-solving until stable.

`_newton_raphson` (`loadflow.py:3100-3227`) contains no internal Q-limit either — the architecture is identical for both methods. The only callers of `_gauss_seidel` are the two lines inside `solve_with_islands`; there is no clamp-free GS entry point in `run_load_flow`.

**Numerical demonstration (Docker, current tree).** 11 kV utility (swing) — 8 km cable (0.3+j0.35 Ω/km) — PV bus with a 5 MVA generator (vset 1.03 pu, `q_max_mvar = 0.5`) and a 6 MVA, 0.7-pf load:

| method | converged | gen Q | bus-B voltage | warning |
|---|---|---|---|---|
| newton_raphson | True (5 it.) | pinned **0.5 MVAr** | 0.7807 pu (floats) | "Generator hit its reactive limit at over-excitation (Q_max): pinned at 0.5 MVAr and no longer holding 1.03 p.u." |
| gauss_seidel | True (11 it.) | pinned **0.5 MVAr** | 0.7807 pu (identical) | identical warning |

GS produces the **same clamped, feasible solution** as NR, with the same infeasibility warning. The alleged failure (voltage held at 1.03 with Q ≈ 4 MVAr > capability) does not occur.

**Was it ever true?** I checked HEAD (`83c541f`, the state Round 2 adjudicated): the outer loop at HEAD:2124 already wrapped `solve_with_islands(..., method)` at HEAD:2136. The Round-2 adjudication read `_gauss_seidel` in isolation, saw no internal clamp, and attributed the outer loop to "the NR dispatch path" — but the outer loop was never method-gated. The finding's mechanism was wrong at adjudication time, not merely closed since.

**Two accurate fragments survive:**
1. The 2026-07-20 GS power-mismatch acceptance check (`GS_MISMATCH_TOLERANCE`, `loadflow.py:3274-3283`) indeed does **not** bound PV-bus Q — it checks P for all non-swing buses but Q only for PQ buses (`bus_types[i] == 0`, line 3280-3281). That is correct behaviour (Q is a free variable at a PV bus) and is moot because the outer clamp bounds it.
2. **Genuine residual, new:** `unbalanced_loadflow.py:579` calls `solve_with_islands` **directly**, bypassing the clamp loop entirely, and marks user-labelled PV buses at `unbalanced_loadflow.py:388`. The unbounded-Q PV exposure EE-R2-1 alleged is real **in the unbalanced engine, for both NR and GS**. That engine was outside Round-2 scope (adjudication §8); the residual is logged below as R3-1.

**Verdict: REJECTED** for the balanced load-flow engine as claimed (with numerical proof). **Severity of the true residual (R3-1, unbalanced engine): P3** — the unbalanced engine is a secondary study, PV-bus use there requires an explicit user `bus_type` label, and there is no generator-capability registration in that engine at all (so no false "regulating" warning either; the bus simply holds voltage). **Direction:** non-conservative (infeasible support). **Recommended fix:** route the unbalanced positive-sequence solve through the same registration + clamp pass, or refuse PV bus types there with a warning. The motor-starting GS fallback (`motor_starting.py:136, 233`) goes through `run_load_flow` and is therefore clamped — no exposure.

### Finding 2 — PS-1 fallback residual: nodal-solve failure falls back to the overstating per-path result — **CONFIRMED, P3 (upgrade trigger defined below)**

**Mechanism verified** at `fault.py:205-232`: when `_paths_are_meshed` is true but `_nodal_thevenin` returns `None`, `z_eq` silently remains `z_eq_paths` (the per-path parallel combination, which double-counts shared upstream impedance and **overstates** Ik on meshed topologies) and only a string is appended to `study_warnings` (line 229-232, honest text: "…OVERSTATES fault current…"), attached per-bus as `topology_warnings` (`fault.py:436`). `_nodal_thevenin` returns `None` when the faulted bus is missing from the bus network (`fault.py:1905`), no source shunt exists in its connected component (`1920-1921`), Ybus inversion fails (`1940-1943`), or Z_kk is non-finite/degenerate (`1945-1946`). The same fallback exists in `thevenin_z1_at_bus` (`fault.py:2002`: `return z_kk if z_kk is not None else z_paths`) feeding motor-starting dip studies.

**Consumers do not check the warning — verified:**
- `arcflash.py:770-775` reads `fault_bus.ik3` directly; no reference to `topology_warnings` or `network_topology` anywhere in the file.
- `duty_check.py:124-147` reads `ik3`/`ib`/`ib_asymmetric` from the bus result; no warning check.
- `frontend/js/compliance.js` consumes `AppState.faultResults.buses` (lines 91, 352, 1217) and `AppState.faultResultsMin.buses`; no `topology_warnings` consumption in `compliance.js`, `reports.js`, or `pdf_reports.py`.

**Direction — bidirectional, and not benign:** overstated Ik is conservative for withstand/duty verdicts but **non-conservative** for (a) arc-flash clearing time (higher assumed current → faster assumed device operation → shorter arc duration → lower incident energy) and (b) the [PS-3] minimum-current disconnection check, which needs a *minimum* Ik1 — the fallback overstates it, so a disconnection PASS can be wrong.

**Severity:** P3 as an open item, because the trigger is narrow (meshed topology **and** a degenerate nodal model — a healthy meshed network solves). It should be **treated as P2 the moment any project reproducibly hits the fallback**, because from that point the tool prints unfagged wrong numbers on safety documents. **Recommended fix (minimal):** set a per-bus boolean (e.g. `thevenin_basis: "per-path-fallback"`) on `FaultResultBus`, have arc flash and duty check annotate affected rows, and have compliance.js refuse a PASS on the disconnection check for fallback buses. Returning `None` (no result) for the affected bus is the stricter alternative the Round-2 adjudication suggested; either closes the silent-consumption path.

### Finding 3 — EE-R2-2 residual after `qv_margin_mvar`: — **SUPERSEDED-BY-P3-WORK (substance); residual labelling item, P3→documentation**

The 2026-07-20 work added `qv_margin_mvar` at `voltage_stability.py:242-250`: margin = `qv_op_q − qv_min`, where both the operating-point Q and the curve minimum are net-injection figures from the same sweep (`_qv_curve`, `voltage_stability.py:257-321`; op-point capture at 315-316). Because the local-Q-load offset that EE-7/EE-R2-2 identified shifts **both** points equally, the difference is offset-free — the headline safety number (reactive margin to collapse) is now correct. This closes the substance of EE-R2-2 and EE-7 together.

**What remains (verified):**
1. The **absolute** curve labels are still net-injection: `qv_curve` points (`voltage_stability.py:313-314`), `qv_min_mvar` (320) and `qv_operating_mvar` are the bus net Q, not fictitious-condenser output. An engineer comparing `qv_min_mvar` against a condenser/SVC datasheet rating still sees a figure offset by the bus's local Q load. Cosmetic/definitional, now that the margin is right.
2. No `connected_bus_loads_mvar` sibling exists (`loadflow.py:1575` remains MW-only; grep confirms no Q variant in any engine) — the surfacing gap stands but its safety consequence is gone.
3. Minor new observation: `op_q` is captured at the first sweep setpoint at/below the operating voltage (0.025-pu grid, `voltage_stability.py:287, 315-316`), so the margin carries a discretization error of up to (curve slope × 0.025 pu). Near the operating point the Q-V curve is shallow, so this is small; worth a one-line comment.

**Verdict: SUPERSEDED-BY-P3-WORK** in substance. **Residual severity:** P3 (labelling/doc only). **Direction:** neutral (the margin — the number a verdict would key on — is correct). **Recommended fix:** rename/annotate `qv_min_mvar` as net-injection in the schema docstring and UI, or add local Q back for a `condenser_output_mvar` display value; add `connected_bus_loads_mvar` when convenient.

### Finding 4 — EE-R2-3 (P3): constant-PQ starting-load model pessimistic vs constant-impedance locked rotor; UI silent — **CONFIRMED, P3, conservative**

Verified against the current tree: `_solve_pq_dip` (`motor_starting.py:87-104`) iterates `V = V_pre − Z_th·(S/V)*` with S **held constant** and a 0.05-pu collapse floor (line 96) returning `None`, mapped to terminal voltage 0.0 = stall (`motor_starting.py:264-271`). Physics: a locked rotor is (to first order) a constant impedance, so its drawn S falls as V² — the constant-PQ model draws more current at depressed voltage, deepens the dip, and near the transfer-capability nose can fail to find an operating point where the constant-Z divider always has one. The engine comment at `motor_starting.py:201-209` says exactly this; the result payload (`motor_starting.py:344-359`) and the issues strings (330-335) carry **no model caveat**, and the stall warning (268-271) presents "network cannot supply the starting load" as fact rather than as the constant-PQ model's verdict. Unchanged by the P3 work.

**Verdict: CONFIRMED. Severity P3 upheld. Direction: conservative** (predicts stalls/dips that a real locked rotor might not produce — the right side to err on for a starting study). **Recommended fix (minimal):** append a fixed sentence to the result (or a `model: "constant-PQ (pessimistic near collapse)"` field) and extend the stall warning with "…under the conservative constant-PQ starting-load model".

### Finding 5 — EE-R2-4 (P3): N-2 pair cap truncates in lexicographic order, unweighted, skipped pairs unnamed — **CONFIRMED, P3**

Verified unchanged (contingency.py untouched by the P3 work): `contingency.py:205-211` — `pairs = list(itertools.combinations([c.id for c in outageable], 2))`, `pairs = pairs[:room]`, warning reports only the count ("N-2: {skipped} of {N} pairs skipped (contingency cap reached)"). Order is lexicographic by component id (i.e. effectively by drawing/creation order) — deterministic but severity-blind; the dropped tail could contain the binding double outage. Mitigants: cap default 400 (`contingency.py:35`), N-1 always complete, results ranked worst-first among what was solved, and the `skipped` count is surfaced in `ContingencyResults.skipped`.

**Verdict: CONFIRMED. Severity P3 upheld** (bites only above ~28 outageable elements with N-2 enabled). **Direction: non-conservative** when it bites (a secure-looking N-2 verdict on an incomplete pair set). **Recommended fix:** pre-rank pairs by a cheap severity proxy (sum of the two elements' N-1 severity scores — already computed for every single outage before pairs run) before truncating, and name the first few skipped pairs in the warning; alternatively state in the results header that the N-2 verdict covers only the analyzed subset.

### Finding 6 — EE-R2-5 (P3): induction-motor `_get_load_kw` returns shaft kW — **CONFIRMED, P3, confined to kW summary fields; EE-13 path unaffected**

Verified: `load_diversity.py:123-124` still returns `rated_kw` (shaft kW) for `motor_induction`, while the load-flow engine injects P = kW/η (`loadflow.py:2081-2093`, comment cites the S = kW/(η·pf) convention). The kW fields (`installed_kw`/`demand_kw` per load 187-190, per bus 226-231, totals 358-361) understate motor real demand by ×η (typically ~7%).

**kVA path re-verified correct:** `_get_load_kva` (`load_diversity.py:106-111`) returns `rated_kw/(η·pf)` — input kVA. Transformer demand loading is built exclusively from kVA: the counted-bus rows sum `installed_kva`/`diversified_demand_kva` (`load_diversity.py:309-314`) and — the specific check requested — the **new [EE-13] extra-loads path** for loads behind cables (`load_diversity.py:315-320`) calls `_get_load_kva(lc)` and multiplies by the load's own demand factor. It is therefore **not** affected by the kW defect; `demand_loading_pct` and the pass/warn/fail transformer verdicts remain correct.

**Verdict: CONFIRMED (scope exactly as Round 2's downgrade: kW summary/report lines only). Severity P3 upheld. Direction: non-conservative** on the kW lines only. **Recommended fix:** one line — `return rated_kw / eff` (with the same guard pattern as `_get_load_kva`) in the `motor_induction` branch of `_get_load_kw`.

### Finding 7 — PS-R2-2 (P3): earthed inverter uses Z1 as Z0 when `x0` unset — **CONFIRMED at both sites, P3 — plus a new site divergence**

- **Path walker** (`fault.py:1295-1337`): for `solar_pv`/`battery`/`wind_turbine` with an earthed `grounding` prop, `z_src` is the positive-sequence inverter impedance (1314-1321) unless `x0 > 0` is given, in which case Z0 = j·x0 (machine base → study base) with X/R = 10 (1323-1332). Default therefore Z0 = Z1 + 3Zn.
- **Nodal builder** (`fault.py:1816-1830`): same gating, but the `x0` prop is **not read at all** — `z_src` is always the positive-sequence impedance.

So beyond the confirmed default (Z0 = Z1, a screening simplification the comment at 1303-1304 discloses), there is a **new inconsistency**: on a *meshed* network the nodal zero-sequence solve ignores a user-supplied inverter `x0`, so radial and meshed answers diverge for the identical earthed inverter. Filed as R3-2.

**Verdict: CONFIRMED. Severity P3 upheld** (opt-in earthed inverters only; coupling-transformer Z0 usually dominates the loop). **Direction:** parameter-dependent, roughly neutral-to-slightly-off either way. **Recommended fix:** honor `x0` in the nodal builder (copy the 10-line block from the path walker), and document the Z0 = Z1 default on the Z0-detail string (the path walker's `desc` already prints Z0_src — add "(=Z1 default)" when x0 is unset).

### Finding 8 — PS-R2-3 (P3): `_zero_seq_magnetizing` reuses the leakage `x_r_ratio` — **CONFIRMED, P3, effect < 1%**

Verified: `fault.py:1620-1652` — `xr = float(comp.props.get("x_r_ratio", 10) or 10)`, `r = x / xr` applied to Z0m. Reusing the *leakage* X/R for the *magnetising* branch is semantically wrong. Two physics notes temper the original claim: (a) the classical magnetising branch has X/R ≫ 10, but the **three-limb zero-sequence** path is a tank-return "phantom delta" with substantial eddy losses, so its true X/R is genuinely lower than a positive-sequence magnetising branch and poorly known — the reviewer's "50-200" is itself optimistic for this specific branch; (b) numerically, R = X/10 inflates |Z0m| by only √(1+1/100) ≈ 0.5%, and Z0m is itself a representative default (0.6 pu, `fault.py:1641`) unless the datasheet `z0m_pu` is supplied. The Ik1 effect is well under 1% — far inside the uncertainty of the 0.6-pu default.

**Verdict: CONFIRMED (semantic defect, negligible number). Severity P3 upheld (low). Direction: near-neutral.** **Recommended fix:** use a dedicated X/R (e.g. 20) or accept a `z0m_x_r` prop; a comment acknowledging the tank-loss uncertainty would be honest.

### Finding 9 — PS-R2-4 (P3): duty compared against worst adjacent-bus fault, not device through-current — **CONFIRMED, P3, conservative; PS-14a inherits the same basis**

Verified: `_find_upstream_bus` (`duty_check.py:24-50`) collects the first bus in **every** direction from the device; the duty loop (`duty_check.py:124-147`) takes the worst `ik3` among them and reads `ib`, `kappa` and — the new [PS-14a] check — `ib_asymmetric` (line 143) from that same bus record. The asymmetrical-duty comparison at `duty_check.py:212-229` therefore inherits the bus-total basis exactly as anticipated. For a feeder device on a multi-infeed bus the bus total exceeds the device through-current, so all four fault-duty checks (breaking, making at line 150, asym, utilisation) are pessimistic — false FAILs possible, missed failures not.

**Verdict: CONFIRMED. Severity P3 upheld. Direction: conservative.** **Recommended fix:** use `_compute_branch_contributions` through-currents for feeder devices where available; keep the bus figure for incomers (where it is the correct duty). This is a refinement, not a safety correction.

### Finding 10 — PS-R2-7 (P3): `_compute_voltage_depression` silently swallowed — **CONFIRMED, P3 (unchanged by P3 work)**

Verified: `fault.py:443-449` — `try: _compute_voltage_depression(...) except Exception: pass`. No `topology_warnings` entry, no study warning; a singular Zbus or malformed island silently yields a report with no retained-voltage table and no explanation. The 2026-07-20 work did not touch this (the [PS-10/PS-11] assumptions block added directly below at 451+ shows the area was edited around, not through).

**Verdict: CONFIRMED. Severity P3 upheld. Direction: neutral** (informational output missing, headline currents unaffected). **Recommended fix:** in the except branch, append one string to each affected bus's `topology_warnings` (or a study-level warning): "Voltage-depression calculation failed — retained voltages not available."

### Finding 11 — PS-R2-8 (P3): `thevenin_z1_at_bus` runs the meshed test on the filtered path set — **REJECTED (over-ruling Round 2)**

Verified code: `fault.py:1981-1987` — paths filtered by `_path_ok` (excluded sources + motor paths, 1972-1979), then `_paths_are_meshed(keep, components)` decides per-path vs nodal.

**Why the mechanism cannot mis-classify.** `_paths_are_meshed` (`fault.py:962-977`) returns True iff any impedance-carrying element — and `_IMPEDANCE_TYPES` (`fault.py:955-959`) **includes the sources themselves**, which appear in every path's trail (`fault.py:530-660`) — is shared by two of the tested paths. The per-path parallel combination of a path set is exact **iff** no element is shared *within that set* — that is precisely what is being tested, on precisely the set being combined. Sharing between a kept path and a *filtered* path cannot invalidate the kept combination: motor/excluded sources are shunt infeeds, and removing a shunt cannot create shared series impedance among the remaining paths. The adjudicated scenario ("two parallel utility paths each have a motor shunt that's filtered out → the remaining single utility path looks radial") fails on its own terms: two parallel paths from one utility share the utility element in their trails and are detected on the kept set; if instead only one utility path remains after filtering, its series z_total **is** the correct Thevenin impedance for the non-motor source set. I also verified consistency on the meshed side: the nodal branch filters motor shunts by `source_type` (`fault.py:1995-2000`), and lumped-load motor-equivalents are tagged `"motor_induction"` in the nodal builder (`fault.py:1763, 1873`), so radial and meshed handling exclude the same set.

**Genuine (different, narrower) residual:** `thevenin_z1_at_bus` calls `_collect_source_paths` without the `meta` argument (`fault.py:1981`), so a *truncated* enumeration (`MAX_FAULT_PATHS`/`MAX_FAULT_EXPANSIONS`, warning printed at `fault.py:697`) could in principle drop the path that would have revealed sharing. That is a heavily-meshed-network completeness concern shared with the main analysis (which at least warns, `fault.py:201-204`), not the filtering defect PS-R2-8 describes. Filed as R3-3 (P4/hardening: pass `meta` and treat `truncated` as meshed).

**Verdict: REJECTED** as stated. No severity (the replacement residual R3-3 is P4). **Direction:** n/a.

### Finding 12 — compliance.js disconnection-time keying on `In ≤ 32` — **CONFIRMED, P3 with genuinely non-conservative cases; highest-priority open compliance item**

Verified: `compliance.js:1243-1244` — `const tLimit = in_ <= 32 ? 0.4 : 5.0;`, applied to the [PS-3] device-curve disconnection check for every LV bus device (context 1195-1290).

**Standards position (IEC 60364-4-41 ed. 5.1 §411.3.2 / Table 41.1; SANS 10142-1 follows it):** the 0.4 s / 5 s split keys on **circuit function and U0**, not on the device rating alone:
- 0.4 s (TN, U0 = 230 V) applies to **final circuits ≤ 32 A**, and per §411.3.2.2 as amended to final circuits **up to 63 A with socket-outlets** (and ≤ 32 A fixed-equipment circuits).
- **Distribution circuits** may use 5 s (TN) regardless of rating — including ones ≤ 32 A.
- Table 41.1 also shortens the limit at higher U0 (0.2 s at 400 V; TT systems: 0.2 s/1 s) — the code applies 0.4/5 s with no U0 or earthing-system branch at this line.

**Direction analysis:** (a) **non-conservative**: a 40-63 A socket-outlet final circuit gets 5 s where 0.4 s is required — a real, printable wrong PASS; likewise any LV system with U0 > 230 V gets 0.4 s where 0.2 s applies. (b) **conservative**: a ≤ 32 A sub-main/distribution circuit is held to 0.4 s and may false-FAIL. The model has no circuit-type metadata, so the code cannot currently do better than a rating proxy.

**Verdict: CONFIRMED. Severity: P3 upheld** (screening tool; the check is new with [PS-3] and better than the 10×In proxy it replaced) — but this is the item I would close **first** among the P3s because it sits directly on a printed SANS compliance verdict with a non-conservative branch. **Recommended fix:** add a `circuit_type` prop (`final_socket` / `final_fixed` / `distribution`) on CBs/fuses or their downstream circuit; key `tLimit` on it plus U0 (and the TT branch already known to `_sans10142_earthingSystem`); default unknown circuits to **0.4 s** (conservative) with an assumption note, rather than 5 s.

### Finding 13 — Stale persisted study verdicts restore without recompute — **PARTIALLY CONFIRMED: mechanism now exists and is sound, but the current uncommitted engine fixes do not trigger it**

The operational hazard as originally stated is **superseded**: the codebase now has a full result-provenance system (landed with commit `a451ec4` "…stale-result guards").
- Every result slot (16, including `stabilityResults`, `faultResults`, `dutyCheckResults` — `state.js:7-12`) is an accessor that stamps `{v: APP_VERSION, at, run}` on **every** assignment (`state.js:1581-1603`).
- On load, results are restored into the backing store with their **saved** provenance (`state.js:1529-1540`), so a result stamped by a different `APP_VERSION` reads stale (`isResultStale`, `state.js:1607-1611`).
- Stale results are banner-flagged in study views (`staleBannerHTML`, `state.js:1629-1645`), announced on project load (`project.js:572-575`), and **excluded from reports** (`reports.js:153, 185, 220, 253, 383, 430, 905` gate on `isResultStale`/`freshResult`).

**The surviving defect is procedural and live right now:** provenance keys on the hand-maintained `APP_VERSION = 'V4'` (`constants.js:3`), which the uncommitted 2026-07-20 P3 remediation — 16 engine-behaviour changes including fault, duty-check and voltage-stability verdict changes — **does not bump** (working-tree diff leaves it 'V4'). Every study saved under the pre-fix V4 engine will read *fresh* under the post-fix V4 engine: exactly the hazard, resurrected by process rather than by architecture.

**Verdict: PARTIALLY CONFIRMED** (architecture superseded; process gap current). **Severity: P3. Direction: non-conservative** (pre-fix verdicts presented as current). **Recommended fix:** bump `APP_VERSION` in the pending P3 commit (one character), and adopt the rule "any `backend/analysis/` behaviour change bumps `APP_VERSION`" — or derive the stamp from the build/commit hash so it cannot be forgotten.

### Finding 14 — No motor starting-current overlay in tcc.js — **CONFIRMED (functional gap, P3)**

Verified by exhaustive grep: every `motor` reference in `frontend/js/tcc.js` is mini-SLD furniture — load classification (`tcc.js:3233-3234, 4198`), device-label kW text (`4240-4242`), path-endpoint types (`4162`), and the M-circle icon (`4477-4481`). There is no locked-rotor current marker, no starting-current-vs-time trajectory (I_LR → FLC over t_accel), no hot/cold stall-withstand point, and no motor thermal-damage curve — so relay/fuse coordination against motor starting cannot be checked graphically, and an overcurrent element that would trip during a normal start is not visually detectable. The data needed is already computed elsewhere (LRC/starting method in `motor_starting.py`, acceleration time in `dynamic_motor_starting.py`). Note the *other half* of PS-16 (CT knee vs V_AL, default Rct) **was** closed by the 2026-07-20 work (`constants.js` diff: knee-point handling + Rct default 0.3/3.0 Ω).

**Verdict: CONFIRMED. Severity: P3** (functional gap, no wrong number printed — the tool simply cannot do this check). **Direction: non-conservative by omission** (nuisance-trip-during-start coordination errors pass unremarked). **Recommended fix:** overlay per-motor `I_start(t)`: vertical segment at I_LR×(starter factor) from 0.1 s to t_accel (dynamic engine result when available, else a user prop), stepping to FLC — plus the stall-time point when given. This is the concrete backlog line Round 2 asked for.

---

## 3. Updated remediation priority (open items after this pass)

| Rank | Item | Severity | Direction | Effort | Notes |
|---|---|---|---|---|---|
| 1 | **APP_VERSION not bumped by the pending P3 engine changes** (Finding 13 residual) | P3 (process; upgrade to P2 if the changeset ships without it) | Non-conservative | XS | One-line change in the very commit under review; adopt the bump-on-engine-change rule. |
| 2 | **compliance.js `tLimit` keying** (Finding 12) | P3 | Non-conservative for 33-63 A socket finals & U0 > 230 V | S | Circuit-type prop + U0/earthing branch; default unknown → 0.4 s. |
| 3 | **PS-1 fallback consumed unflagged** (Finding 2) | P3 (→P2 on first observed trigger) | Bidirectional (non-conservative for arc flash & min-fault disconnection) | S | Per-bus basis flag; consumers annotate/refuse PASS. |
| 4 | **tcc.js motor-start overlay** (Finding 14) | P3 | Non-conservative by omission | M | Remaining half of PS-16; data already computed. |
| 5 | **N-2 truncation severity-blind** (Finding 5) | P3 | Non-conservative when cap binds | S | Rank pairs by N-1 severity proxy before truncation. |
| 6 | **R3-1: unbalanced engine PV buses bypass the Q-limit clamp** (new, from Finding 1) | P3 | Non-conservative | S-M | `unbalanced_loadflow.py:388, 579`; route through the clamp or reject PV there. |
| 7 | **`_get_load_kw` motor shaft-kW** (Finding 6) | P3 | Non-conservative (kW report lines only) | XS | `rated_kw/eff`; kVA/transformer verdicts already correct. |
| 8 | **R3-2: nodal builder ignores inverter `x0`** (new, from Finding 7) + Z0=Z1 default disclosure | P3 | Parameter-dependent | XS | Mirror the path walker's x0 block at `fault.py:1824-1830`. |
| 9 | **Motor-start model caveat in results** (Finding 4) | P3 | Conservative | XS | One sentence in payload/warning. |
| 10 | **Voltage-depression silent swallow** (Finding 10) | P3 | Neutral | XS | Warning on the except branch, `fault.py:448`. |
| 11 | **Duty through-current refinement** (Finding 9) | P3 | Conservative | M | Quality improvement; PS-14a inherits basis. |
| 12 | **Q-V absolute labelling + `connected_bus_loads_mvar`** (Finding 3 residual) | P3 (doc) | Neutral | S | Margin already correct. |
| 13 | **Z0m X/R prop reuse** (Finding 8) | P3 (low) | Near-neutral (<1%) | XS | Dedicated X/R or `z0m_x_r` prop. |
| 14 | **R3-3: `thevenin_z1_at_bus` ignores truncation meta** (new, from Finding 11) | P4 | Non-conservative (extreme meshing only) | XS | Pass `meta`; treat truncated as meshed. |
| — | ~~EE-R2-1 (GS Q-limit)~~ | **REJECTED** | — | — | Clamp is method-agnostic in `run_load_flow`; proven numerically identical GS/NR clamped solutions. The only open P2 from Round 2 is hereby closed without a code change. |
| — | ~~PS-R2-8 (filtered meshed test)~~ | **REJECTED** | — | — | Filtered-set test is the mathematically correct validity condition for the filtered combination. |

**No open P2 items remain** (EE-R2-1, the sole Round-2 P2, is rejected). Items 1-3 are the ones I would close before the next customer-facing release; item 1 belongs in the P3 changeset itself.

---

## 4. Sign-off

I verified all fourteen assigned findings against the working tree of 2026-07-20 (HEAD `83c541f` plus the uncommitted P3 remediation), reading the current source at every citation and reproducing the decisive case numerically in the project's Docker image. The 2026-07-20 P3 work is genuine and, in three places, closed or defused Round-2 findings as a side effect: `qv_margin_mvar` closes the substance of EE-R2-2/EE-7, the result-provenance system closes the stale-persisted-results architecture gap, and the CT knee/Rct fixes close half of PS-16. Two Round-2 CONFIRMED findings are over-ruled with mechanical refutations: **EE-R2-1** (the reactive-limit clamp lives in `run_load_flow`'s method-agnostic outer loop — demonstrated by identical clamped GS and NR solutions on a purpose-built over-capability case; the true residual lives in the out-of-scope unbalanced engine and is logged as R3-1) and **PS-R2-8** (the filtered-set meshed test is the correct validity condition; shunt-source filtering cannot invalidate the kept parallel combination). All remaining confirmed items are P3 hardening, documentation, or process items; the single action I require of the pending changeset before merge is the **`APP_VERSION` bump**, without which the new provenance system will present pre-fix verdicts as current. Within the tool's stated screening scope, and subject to the priority list above, the calculation core remains of signable screening-study quality as characterised in the Round-2 sign-off — now with its last open P2 discharged.

*Principal Electrical Engineer — Round-3 verification, 2026-07-20*
