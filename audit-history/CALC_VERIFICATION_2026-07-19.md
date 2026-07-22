# Independent Calculation Verification — Full Application Review

**Date:** 2026-07-19
**Repo state:** `main` @ `5ba69bc`
**Purpose:** Pre-feature-freeze independent check of every calculation engine, from first principles, before further feature development.

## Review protocol

Three-stage independent verification:

1. **Reviewer A — Senior Electrical Engineer (power systems):** first-principles verification of the power-system engines: `loadflow.py`, `loadflow_cases.py`, `voltage_stability.py`, `contingency.py`, `cable_sizing.py`, `motor_starting.py`, `dynamic_motor_starting.py`, `load_diversity.py`, `grounding_system.py`. Findings **EE-1 … EE-14**.
2. **Reviewer B — Senior Protection Specialist:** first-principles verification of the protection engines: `fault.py` (IEC 60909), `arcflash.py` (IEEE 1584-2002), `duty_check.py`, `frontend/js/tcc.js` + curve constants, `frontend/js/compliance.js`, instrument-transformer usage. Findings **PS-1 … PS-16**.
3. **Reviewer C — Principal Engineer:** adjudication of all 30 findings — each verified against the cited code, and every P1/P2 numerical demonstration independently re-run. Cross-cutting analysis, consolidated remediation priority, and sign-off.

Both senior reviewers worked **blind**: neither saw the other's report, and both were barred from reading the prior review/audit documents in this repo (`EE_REVIEW_*.md`, `AUDIT_REPORT.md`, `audit-*.md`). Every formula was re-derived from the governing standard (IEC 60909-0, IEEE 1584-2002, IEEE 80, IEC 60364/SANS 10142-1, IEC 60255-151/IEEE C37.112, IEC 62271-100/60947-2, IEEE 3002.7) and checked term-by-term; hand calculations were executed against the live engines. The pinned regression suite passes throughout — all findings below are in behaviour the suite does not pin.

## Verdict summary

- **30 findings** (5 × P1, 9 × P2, 16 × P3). Principal adjudication: **all 30 CONFIRMED**, none rejected; every P1/P2 numerical demonstration reproduced.
- **Headline P1s:** parallel-path fault impedance double-counting (fault currents +58 % on routine ring/parallel-feeder topologies) · zero-sequence current fabricated for generators/inverters (earth-fault studies) · static motor-start engine omits source impedance and scales locked-rotor draw by demand factor (false "will start" verdicts) · cascaded transformers in one branch chain produce a converged garbage solution.
- **Non-conservative (unsafe-direction) findings:** EE-1, EE-4, EE-5, EE-9, EE-12, EE-13, EE-14(fuse), PS-1 (for arc flash/min-current), PS-2, PS-3, PS-4, PS-5, PS-8(b), PS-9, PS-14(b), PS-16.
- **Verified correct to hand-calculation accuracy:** NR/GS solver core and Jacobian, single-transformer tap model, per-unit system, IEC 60909 radial formula layer (incl. LV earthing systems and star-star Z0 magnetising), IEEE 1584-2002 equation layer (digit-perfect), IEEE 80 grounding (3–4 significant figures vs Annex-B-style hand calc), dynamic motor starting physics, IDMT/TCC constants, duty-check factor tables, cable-sizing formulas.
- **Principal's bottom line:** the formula-level engineering is more careful than several commercial screening tools; the defects are concentrated one layer up — network representation (path enumeration, chain handling) and result aggregation. Fit for radial utility-fed distribution studies today; the P1 block plus PS-3/PS-4 must be closed before further feature work, and ring/meshed fault results must be treated as invalid until PS-1 lands.

## Remediation status (2026-07-19, same session)

All **P1 and P2 findings fixed** and pinned by 21 new standards-anchored regression tests (`backend/tests/test_verification_fixes.py`); the full Docker suite passes (336 pre-existing + 21 new). P3 findings remain open (tracked in BACKLOG.md).

| Finding | Status | Fix |
|---|---|---|
| PS-1 (P1) | **Fixed** | Meshed topologies detected (shared-element check on enumerated paths) and Z1/Z2/Z0 solved nodally (Ybus/Zbus per sequence); Ib/Ik_steady/motor-split re-anchored; `network_topology` + `topology_warnings` surfaced in results (incl. path truncation). Radial results byte-identical. Parallel-feeder case now 20.587 kA (hand value), was 32.534. |
| PS-2 (P1) | **Fixed** | Generator Z0 gated on `grounding` (default solidly = legacy parity, 3·Zn supported); inverter sources (PV/BESS/wind) blocked from Z0 by default, explicit earthed opt-in. Deliberate behaviour change for inverter-fed SLG results. |
| EE-1+EE-5+EE-12 (P1) | **Fixed** | Static motor start solves the terminal voltage by Thevenin superposition incl. source impedance (shared PS-1-aware `thevenin_z1_at_bus`); source-side dip superimposed on all bus dips; `demand_factor` forced to 1.0 in the starting condition; distribution boards accepted as motor terminals (both engines). Reviewer's TX case now 0.78 p.u./FAIL (was 0.913/PASS). |
| EE-2 (P1) | **Fixed** | Chain turns ratio = product of per-transformer oriented ratios walked in electrical order; cascade solves to 0.99513 p.u. (= explicit-bus control); modelling warning emitted. Single-TX chains bit-identical. |
| PS-3 (P2) | **Fixed** | `conductor_temperature_c` min-current mode in fault.py (IEC 60909-0 §5.3.1); frontend fetches a companion c_min=0.95 / 70 °C study (`AppState.faultResultsMin`); SANS 10142-1 check verifies device disconnection TIME at Ik1-min vs 0.4 s/5 s (10×In only as fallback), and labels its basis. |
| PS-4 (P2) | **Fixed** | Distance exponent keyed on equipment class (`lv_cable` → x = 2.000 per Table 4); gap fallback treats ≤15 mm as cable. PS-13(a) docstring inversion fixed in passing. |
| PS-5 (P2) | **Fixed** | ip = 1.15·κ√2·Ik″ on meshed topologies, capped 1.8 (LV) / 2.0 (HV); radial κ untouched. |
| PS-6 (P2) | **Fixed** | K_G per IEC 60909-0 §6.6.1 Eq. 18 applied; fictitious R_G class defaults when no X/R prop. |
| EE-3 (P2) | **Fixed** | Chain losses apportioned per element by I²R share — rows sum to the true chain loss; Study Manager totals correct. |
| EE-4 (P2) | **Fixed** | Contingency accounting synthetic-inclusive; dangling-load feeder outage now `islanded` with the true MW lost (was SECURE / 0.0 MW). |
| EE-6 (P2) | **Fixed** | `collapsed` requires an observed failed solve; sweep overshoot reports "margin is a lower bound". |
| All P3 findings | Open | Tracked for follow-up (EE-7…EE-14 remainder, PS-7…PS-16). |

---

# Part 1 — Senior Electrical Engineer: Power-System Engines (EE-1 … EE-14)

# ProtectionPro — Independent First-Principles Verification of Power-System Engines

**Reviewer scope:** loadflow.py, loadflow_cases.py, voltage_stability.py, contingency.py, cable_sizing.py, motor_starting.py, dynamic_motor_starting.py, load_diversity.py, grounding_system.py (repo @ `main`, commit 5ba69bc).
**Method:** every governing formula was re-derived from the standard/physics and checked term-by-term; each engine was exercised against independent hand/analytic calculations executed with a separate fixed-point solver (not the engine's own code) inside the `protectionpro-backend` image. The pinned regression suite (336 tests) passes; findings below are all backed by code read and, where feasible, a number I computed.

---

## Findings

### EE-1 (P1) — Static motor-starting study excludes the source internal impedance: voltage dips systematically under-reported, "will start" verdicts non-conservative

**Files:** `backend/analysis/motor_starting.py` (whole method, lines 68–274); root cause in `backend/analysis/loadflow.py:1897–1902` (utility modelled as ideal swing bus, `fault_mva` not represented in load flow).

**What the code does:** The engine re-runs the load flow with the motor replaced by its starting MVA. The load flow holds the utility (or slack generator) bus at exactly 1.0 p.u. with zero internal impedance, so the entire dip contribution of the source (utility fault level, generator subtransient/transient reactance) is missing. Only cable/transformer drops between the swing bus and the motor are captured.

**What it should do:** The classic dip estimate is V ≈ V_pre − Z_th·I_start where Z_th **includes the source impedance** (that is usually the dominant term). The project's own dynamic engine does this correctly via the IEC 60909 fault-path Thevenin.

**Numerical demonstration** (200 kW, 400 V motor, LRC 6.5×, S_start = 1.609 MVA at pf 0.3; utility fault level 20 MVA, X/R 5):

| Case | Engine result | Correct (hand, const-PQ incl. Z_source) |
|---|---|---|
| Motor directly on utility bus | terminal V = **1.000 p.u., dip 0 %** | **0.912 p.u.** |
| Motor behind 1 MVA, 5 % TX | terminal V = **0.913 p.u., dip 7.97 %** (exactly my TX-only hand value 0.9133) | **0.801 p.u.** — below the engine's own 0.80 "will not accelerate" threshold |

The engine passes a start that is in reality marginal/failing. The dynamic engine on the same network gives min bus V = 0.926 (consistent with my 0.912 hand value given its slightly lower fitted inrush of 6.02×), confirming the static engine is the outlier.

**Fix:** solve the starting condition against a Thevenin superposition (reuse `build_port_zbus`/`_collect_source_paths` at c = 1.0, exactly as `dynamic_motor_starting.py` does), or synthesize a source-impedance branch into the load-flow model for this study. At minimum, warn that dips exclude source impedance.

---

### EE-2 (P1) — Two cascaded transformers in one branch chain (no bus between them) produce a grossly wrong turns ratio and a garbage "converged" solution

**File:** `backend/analysis/loadflow.py:1383–1422` (`_get_chain_turns_ratio` — returns on the **first** transformer found in the chain), used at 1793–1812.

**What the code does:** For a series chain bus_A—TX1—TX2—bus_B, the off-nominal ratio is computed from TX1 alone: `t = (v_hv1/v_lv1)/(busA_v/busB_v)`. With TX1 = 33/11 kV, TX2 = 11/0.4 kV, buses 33 kV and 0.4 kV: t = 3/82.5 = 0.036 instead of 1.0 (both transformers nominal ⇒ per-unit ratio should be 1). The Ybus entries `y/t²`, `y/t` are then wrong by ~×760.

**What it should do:** the chain's effective off-nominal ratio is the **product of every transformer's off-nominal ratio** in the chain (or the tool should refuse the topology and instruct the user to insert a bus).

**Numerical demonstration:** 33 kV grid → TX1 (20 MVA, 10 %) → TX2 (20 MVA, 10 %) → 0.4 kV bus, 1 MVA load at pf 0.9. Correct answer (independent solve, t = 1, z = 1.0 pu): **V_LV = 0.99513 p.u.** Engine: **V_LV = 0.00036 p.u.**, converged = True. Inserting an intermediate 11 kV bus gives the engine 0.995135 — matching my hand value to 6 digits, proving the fault is chain-ratio handling, not the solver. Mitigation: the solution-quality heuristic flags "implausibly low voltage", but its message misattributes the cause to voltage collapse/loadability — a user would draw a wrong engineering conclusion from a legal drawing.

**Fix:** accumulate `t = Π t_i` over all transformers in `all_elems` (walking the chain in electrical order so each `base_ratio` uses the correct intermediate voltage), or detect ≥2 transformers per chain and emit a hard modelling error.

---

### EE-3 (P2) — Series-chain losses (and P/Q flows) are repeated on every element row; case summaries double-count total losses

**Files:** `backend/analysis/loadflow.py:2294–2358` (each element in a chain gets the full chain `losses_mw`; the code itself admits it at line 2296–2298), `backend/analysis/loadflow_cases.py:50` (`total_losses_mw = sum(br.losses_mw for br in result.branches)`).

**Numerical demonstration:** Case A of my bench (11 kV, 5 km cable, 5 MVA load) has true losses 0.1092 MW (verified analytically). Splitting the same impedance into two series cables (legal drawing, no bus between):

```
cable-1: losses_mw = 0.109156
cable-2: losses_mw = 0.109156
loadflow_cases summary total_losses_mw = 0.2183   (true: 0.1092)
```

Any chain of cable+transformer without an intermediate bus — a very common SLD pattern — doubles its loss contribution in the Load Flow Study Manager comparison table, corrupting exactly the metric users compare cases on.

**Fix:** compute the chain loss once and either report it only on one row, or apportion I²·Z per element (by each element's share of the chain impedance — also more physically meaningful per element). `_summary` should sum unique chains, not rows.

---

### EE-4 (P2) — Contingency analysis misses loss-of-supply for loads on synthetic terminal buses; outaging the sole feeder to a dangling load reports "secure"

**File:** `backend/analysis/contingency.py:100–108` (lost load = `base_energ_ids − energ_ids` over **real** bus results) vs `loadflow.py:2895–2903` (synthetic `__term__*` buses are stripped from results) and `connected_bus_loads_mw` (keys lost load under the synthetic id).

**What the code does:** `base_loads` keys a dangling load's MW under `__term__<load>`; energized-bus sets contain only real buses. So (a) when a real bus feeding a dangling load de-energizes, the lost MW is not counted; (b) when the **feeder cable itself** is outaged, the load is silently removed from the model and no violation of any kind is raised.

**Numerical demonstration:** grid → bus1 → cable → 4.25 MW static load (no terminal bus drawn — exactly the topology `insert_implicit_load_buses` exists to support):

```
Loss of Grid: status=islanded  lost_load=0.0 MW   (actual: 4.25 MW)
Loss of C1:   status=secure    lost_load=0.0 MW   (actual: total loss of the load)
N-1 secure = False only because of the Grid case; the C1 case is invisibly unsafe
```

The properly-drawn control case (load on a real bus) correctly reports 4.25 MW for both outages.

**Fix:** run the loss-of-supply accounting on the synthetic-inclusive result (`run_load_flow(..., include_synthetic=True)` inside `_evaluate`), mapping `__term__X` to load X's name for reporting; additionally treat "load component no longer connected to any energized bus" as a deenergized violation so a removed sole feeder is caught.

---

### EE-5 (P2) — Static motor-starting scales the locked-rotor draw by the motor's `demand_factor`

**File:** `backend/analysis/motor_starting.py:154–181` (starting-condition motor props rewritten, `demand_factor` left untouched) interacting with `loadflow.py:1968–1980` (`P_spec −= …·df`).

**What the code does:** the starting load is injected through the normal load model, which multiplies by `demand_factor`. Locked-rotor current is a physical machine property — it does not diminish because the running duty is 50 %.

**Numerical demonstration:** identical network to EE-1's TX case, motor `demand_factor = 0.5`: reported start current unchanged (2321 A) but terminal V = **0.9587, dip 3.76 %** vs the correct df-independent **0.9133, dip 7.97 %**. The dip is silently halved — non-conservative for any motor with df < 1 (routine).

**Fix:** set `mod_motor.props["demand_factor"] = 1.0` when constructing the starting condition.

---

### EE-6 (P2) — Voltage stability reports "voltage collapses at λ = …" when the λ sweep simply ran out of steps (no failed solve observed)

**File:** `backend/analysis/voltage_stability.py:139–163` — `collapsed = lam_critical < lambda_max − 1e-6`, but the while-loop exits with `first_bad = None` whenever `1 + k·step` overshoots `lambda_max` without landing on it.

**Numerical demonstration:** stiff network (essentially no impedance), `step = 0.35`, `lambda_max = 4.0`:

```
collapsed = True, lambda_critical = 3.8
note: "Voltage collapses at λ = 3.800 (3.42 MW total demand); weakest bus 'B2' at 1.000 p.u."
```

A bus at 1.000 p.u. declared collapsed. The default step (0.1) happens to divide the default range, so this bites only for user-chosen steps — but the P-V study exposes `step` as an input.

**Fix:** `collapsed = first_bad is not None` (propagate whether a non-`ok()` solve was actually bracketed); when the loop exhausts λ without failure, take the "no collapse up to λ_max, margin is a lower bound" path even if the last tested λ < λ_max.

---

### EE-7 (P3) — Q-V "reactive margin" is the net bus injection, not the condenser output: the absolute minimum is offset by the local reactive load

**File:** `backend/analysis/voltage_stability.py:285–288` (curve point `q_mvar = cb.q_mvar` = S_bus injection; the comment acknowledges "condenser Q − local reactive load").

**Verification:** for a pure X = 0.25 pu link, E = 1, P = 100 MW load: analytic net-injection minimum is Q(V) = 4V² − 4√(V² − (PX)²), dQ/dV = 0 at V = 0.559, Q_min = −0.75 pu = −75 MVAr. Engine: **qv_min = −74.96 at the curve bottom** — the *math* is exactly right. But adding a 30 MVAr local load shifts the reported minimum to **−95.96**, whereas the classical (Taylor/WECC) fictitious-condenser margin is −65.96: the report overstates available reactive margin by exactly the bus's local Q load. The *distance* from the plotted operating point to the curve bottom is preserved (both shift together), so the curve is still usable — but the headline `qv_min_mvar` labelled "reactive margin" is optimistic at load buses.

**Fix:** add `bus_load_q_mvar` back (report condenser output), or relabel/document `qv_min_mvar` as net-injection minimum and surface the op-point-to-minimum distance as the margin.

---

### EE-8 (P3) — Power factor > 1 (bad user input) crashes the load flow with an unhandled `ValueError`

**File:** `backend/analysis/loadflow.py:1965, 1978, 1987` — `math.sqrt(1 - pf**2)` without the `max(0, …)` clamp used elsewhere (e.g. line 1890, 1443).

**Demonstration:** a static load with `power_factor: 1.2` raises `ValueError: math domain error` → HTTP 500 for the whole study, instead of a per-component warning. Same pattern for both motor types.

**Fix:** `math.sqrt(max(0.0, 1 - pf*pf))` everywhere, plus (better) clamp pf into (0, 1] with a warning.

---

### EE-9 (P3) — Capacitor banks modelled as constant-Q injection rather than constant susceptance (Q ∝ V²)

**File:** `backend/analysis/loadflow.py:1990–1993`.

A capacitor's output falls with V²; at 0.9 p.u. a "4 Mvar" bank delivers 3.24 Mvar, the model delivers 4.0 (+23 %). Verified the constant-Q behaviour numerically (bus at 0.968 p.u. still credited full 4 Mvar). Optimistic in exactly the situations capacitors matter (depressed voltage, P-V studies near the nose — where voltage_stability.py holds cap Q constant while scaling load). Note the engine's own SVC model *does* track Q_nom·V² when susceptance-limited (loadflow.py:2133–2140), so the physics precedent exists in the codebase.

**Fix:** model the bank as a shunt admittance in Ybus (y = j·Q_rated/V_rated² pu) or iterate Q = Q_rated·V² like the clamped SVC.

---

### EE-10 (P3) — Off-nominal tap ratio applied to the lumped chain admittance, not at the transformer terminal

**File:** `backend/analysis/loadflow.py:1779–1812`. In a chain cable+TX between two buses, the total series z (cable + TX) is built first and the ideal-ratio π-model is then wrapped around the *whole chain*. Electrically the cable on the tap side should sit outside the ideal transformer. At tap = ±10 % this mis-refers the cable impedance by up to t² ≈ 1.21 on the cable's share of the chain — a few-percent error on that branch's drop. Exact at t = 1 and for cable-free chains (verified Case B to 6 digits at tap +5 % with TX-only chain).

**Fix:** apply the ratio to the transformer element and combine via series two-port math, or (pragmatically) document that chains with taps should have a bus at the transformer terminal.

---

### EE-11 (P3) — Solver numerics: Gauss-Seidel convergence is ΔV-based; NR magnitude update unguarded

**File:** `backend/analysis/loadflow.py:3093–3097` and 3044–3048.

- GS declares convergence on max|ΔV| < 1e-6 per sweep. GS converges geometrically (ratio ρ often > 0.9 on meshed nets), so the true error can be ΔV/(1−ρ) ≫ tolerance, and the 100-iteration cap is tight for GS on anything but small radial nets. All my GS tests matched NR to 6 digits, so this is a latent risk, not an observed error. Suggest a final power-mismatch check before reporting `converged=True`.
- NR update `V[i] = abs(V[i]) + dx` can drive the stored magnitude negative on a violent step; `abs()` then silently flips it (implicit 180° shift). Standard guard: floor |V| at a small positive value or damp the step.

---

### EE-12 (P3) — Motor-bus walk does not recognize `distribution_board` terminals

**Files:** `backend/analysis/motor_starting.py:40–58`, `backend/analysis/dynamic_motor_starting.py:249–266` — both `_find_motor_bus` walks stop only at `type == "bus"`. A motor wired to a distribution board (which the load-flow treats as a bus-like node, loadflow.py:1671–1673) gets `terminal_bus = None`: the static engine then defaults its terminal voltage to 1.0 (falsely "will start"); the dynamic engine skips the motor as "not connected to a bus".

**Fix:** accept `("bus", "distribution_board")` in both walks, mirroring the load-flow's bus set.

---

### EE-13 (P3) — Load-diversity transformer loading counts only directly-connected LV buses

**File:** `backend/analysis/load_diversity.py:253–279`. The demand aggregated against a transformer is the sum over LV-side buses reachable through *transparent elements only*; loads on sub-boards/buses behind a feeder cable are excluded, under-stating `demand_loading_pct` for the normal main-sub distribution pattern. (The load-flow engine reports true transformer loading, so cross-checking is possible, but this module's headline "transformer demand loading" is optimistic on multi-level networks.)

**Fix:** walk through series branches to collect the full downstream tree (stop at sources / at buses whose supply path is not through this transformer), or state the limitation in the result.

---

### EE-14 (P3) — Miscellaneous conservatism/robustness notes

- **Cable shunt capacitance is ignored** in load flow (`_get_impedance`, loadflow.py:1373–1379 — series RL only). Negligible at LV, a few Mvar for tens of km of MV XLPE — acceptable for the tool's scope, worth a doc note.
- **Cable-sizing voltage drop treats all flows as lagging** (`cable_sizing.py:712–713`: `sin_phi = +√(1−cos²)` with pf = |P|/S). A leading-pf branch (PV export, capacitive) actually sees a smaller drop or a rise; the code over-states the drop — conservative, but the report can flag a compliant cable.
- **Fuse clearing time fixed at 10 ms** (`cable_sizing.py:535–536`) is realistic for bolted faults ≫ the fuse rating but optimistic near the melting threshold; combined with the k√t adiabatic check the resulting minimum size can be under-estimated when the actual fault current is only a few × I_n of a large upstream fuse. Suggest scaling with I_fault/I_n or letting the user override (the standalone `clearing_time_s` override already exists).
- **`voltage_stability` records both bisection endpoints only when `ok()`** — the published λ list can contain near-duplicate points; cosmetic.

---

## Verified correct (per engine, with the numbers used)

### loadflow.py
- **NR power equations & full Jacobian** (lines 2943–3021): all eight block formulas match the standard polar forms (∂P/∂θ diag = −Q_i − B_ii·V_i², ∂P/∂V diag = P_i/V_i + G_ii·V_i, ∂Q/∂θ diag = P_i − G_ii·V_i², ∂Q/∂V diag = Q_i/V_i − B_ii·V_i, and off-diagonals) — checked symbolically term-by-term. Numerically: 2-bus case (z = 0.4132 + j0.3306 pu, load 4 + j3 MVA) → engine V₂ = 0.972815∠−0.0487°, my independent fixed-point solve 0.972814∠−0.0487°; branch flow 4.1091 + j3.0873 MVA, losses 0.109156 MW vs hand 0.109160 MW; I = 269.76 A vs 269.77 A. Converged in 3 iterations to 1e-6 pu.
- **Gauss-Seidel including PV-bus Q estimation sign convention** (3057–3099): identical answers to NR on PQ and clamped-PV cases (V₂ = 0.972814; PV-clamp case matched NR to 6 digits).
- **Transformer off-nominal tap π-model** (single transformer): `y/t²`, `y`, `−y/t` placement with tap on the HV bus verified against my independent tap-model solve — Case B (33/11, 10 %, X/R 20, tap +5 %) matched V, angle, S_hv, S_lv and losses (0.029166 MW) to all printed digits; tap direction physically correct (+5 % HV tap lowers LV volts).
- **Generator PV-bus reactive-limit clamp**: 10 MVA/0.8 pf machine (Q_max = 6 Mvar) asked to hold 1.02 pu against a 12 MVA 0.85 pf load — engine pins Q at exactly 6.0 Mvar, converts to PQ, lets the bus float to 0.9892 and emits the "no longer holding setpoint" warning; grid import P = 2.217 MW = load + losses − gen 8 MW, Q import 0.372 ≈ 6.32 − 6.0 + line Q — internally consistent power balance.
- **Capacitor-bank arithmetic** (given the constant-Q model, EE-9): bus V 0.967970 matches independent solve 0.967970 exactly.
- **Per-unit conversions**: cable Z on V²/S base, transformer Z% on rated MVA rescaled by base MVA, motor S = kW/(η·pf) (input power = kW/η — physically correct), √3 factors in every current annotation (S·1000/(√3·kV)) — all checked by hand in the cases above.
- **Islanding/dead-bus handling**: sourceless island reported de-energized rather than crashing the solve (exercised implicitly by the contingency runs).

### loadflow_cases.py
Case plumbing (snapshot override, per-case method fallback, never-raise batch) read and exercised via `_summary` — correct apart from EE-3.

### voltage_stability.py
- **P-V nose**: analytic maximum for E = 1, X = 0.25 pu, unity-pf load is P_max = 1/(2X)·E² = 2.0 pu with nose voltage 1/√2. Engine: λ_critical = **1.9984** (0.08 % low — bisection bracket width), nose V 0.7209 (last converged point, correctly above the true nose voltage), margin +99.84 %, correct critical bus.
- **Q-V curve mathematics**: engine bottom −74.96 MVAr at the curve minimum vs my closed-form −75.0 MVAr at V = 0.559 (Q(V) = 4V² − 4√(V²−(PX)²)); with P = 40 MW, engine −95.96 vs analytic −96.0. The sweep/PV-condenser mechanics are exactly right (EE-7 is a definitional offset only).
- λ scaling via demand_factor holds each load's pf constant (P and Q scale together) — correct continuation semantics for a black-box solver; base-case-failure and v_floor guards behave as documented.

### contingency.py
N-1 over branches and sources with re-solve, overload/voltage banding, ranking and `n_minus_1_secure` logic verified on a properly-modelled radial network: loss of grid and loss of the feeder both correctly reported `islanded`, lost_load = 4.25 MW (= 5 MVA × 0.85), violations counted. N-2 cap bookkeeping (skipped-pairs message) arithmetic checked by reading. (EE-4 applies only to dangling-load topologies.)

### cable_sizing.py
- **Three-phase voltage drop** `%ΔV = I·L·(R·cosφ + X·sinφ)/(V_LL/√3)`: engine 1.84 % vs hand 1.8372 % (100 A, 0.2 km, 0.2 + j0.08 Ω/km, 400 V, pf 0.85) — formula and √3 convention correct for 3-phase.
- **Adiabatic constants**: k = 143/94/115/76 (Cu-XLPE/Al-XLPE/Cu-PVC/Al-PVC) match IEC 60364-4-43 / BS 7671 Table 43.1; minimum area S = I_th·√t/k implemented correctly.
- **Thermal-equivalent current**: `thermal_m_factor(1.8, 0.2 s, 50 Hz)` = 0.22404, my hand evaluation of the IEC 60909-0 m-formula = 0.2241; √(m+n) applied with n = 1 (conservative upper bound, documented).
- **IEC ambient derating** √((θ_max−θ_amb)/(θ_max−30)) and the zero-ampacity guard at θ_amb ≥ θ_max are the standard forms; size-from-resistance uses hot resistivity consistently with the payload convention (0.0175 × 1.275 × 1000/0.2 = 111.56 mm² — engine 111.6).
- Source-side CB selection for clearing time, parallel-cable current division (I/n vs Z/n) — consistent.

### motor_starting.py
FLC = kW/(√3·V·η·pf): engine 2321.1 A start current vs hand 2321.11 A (6.5×FLC). Starter factors (star-delta ⅓, autotransformer 0.8² = 0.64, soft-start 0.5, VFD ≈ FLC) are correct. The constant-PQ locked-rotor approximation is documented and conservative *in itself* — but see EE-1/EE-5, which dominate the result in the non-conservative direction.

### dynamic_motor_starting.py
- **Swing equation** 2H·dω/dt = T_e − T_L in per-unit on T_base = S_base/ω_sync is dimensionally correct (re-derived: dω_pu/dt = T_pu/2H with H = ½JΩ_sync²/S_base); numerically, mid-trajectory dω/dt from the returned curves = 2.180 s⁻¹ vs (T_e−T_L)/2H = 2.178 s⁻¹.
- **Nameplate fit anchors**: fitted model reproduces |I(s=1, V=1)| = 6.4999 ×FLC (nameplate 6.5) and T_LR = 1.228974 pu vs required 1.5·T_FL = 1.228950 pu; T_FL,pu = η·pf/(1−s_r) correct.
- **Accel-time consistency**: independently integrating 2H·dω/(T_e−T_L) over the reported curves gives 0.4288 s vs reported 0.43 s.
- **Network coupling**: (I + Z·D)V = V_pre derivation correct; base conversion `y_base_factor = (S_m/S_sys)(V_bus/V_m)²` correct; Thevenin sanity: reported sc_mva_at_bus = 20.0 = the utility's 20 MVA fault level. Star-delta (Y/3, T/3, V/√3), autotransformer (a²Y, a·V) and soft-starter (αY, α²T) transformations all check out. Rotor I²t vs LRC²·t_stall is a reasonable IEEE 3002.7-style screen (line current slightly over-counts rotor heat near speed — conservative).

### load_diversity.py
Motor input kVA = kW/(η·pf), demand kVA = installed × df, bus coincidence factor interpolated from the table and applied multiplicatively, effective df = diversified/installed — arithmetic verified by reading (simple products); the coincidence-vs-diversity naming caveat is correctly documented in-code. (EE-13 covers the transformer-aggregation gap.)

### grounding_system.py — checked against IEEE 80 Annex-B-style hand calculation (400 Ω·m, 2500 Ω·m/0.102 m surface, 70×70 m, 11×11 conductors, h 0.5 m, d 0.01 m, no rods, t 0.5 s, I_G 1908 A)

| Quantity | Engine | Hand / IEEE 80 |
|---|---|---|
| C_s (Eq. 27) | 0.7429 | 0.7429 (std rounds 0.74) |
| R_g (Sverak Eq. 57) | 2.7757 Ω | 2.7756 (Annex B 2.78) |
| E_touch,70 | 840.5 V | 840.5 (std 838 with C_s = 0.74) |
| E_step,70 | 2696.1 V | 2696 |
| n (n_a·n_b), K_ii, K_h | 11.0, 0.5701, √1.5 | 11, 0.5700, 1.2247 |
| K_m (Eq. 86) | 0.8896 | 0.8896 (Annex B 0.89) |
| K_i | 2.272 | 2.272 |
| K_s (Eq. 94 form) | 0.4061 | 0.40605 |
| E_m | 1001.6 V | 1001.7 (Annex B 1002.1) |
| GPR | 5296 V | ≈5304 |
| D_f (κ=1.8, 0.5 s) | 1.0410 | 1.0410 (consistent with Table 10 interpolation at X/R≈13) |
| Onderdonk A (20 kA, 0.5 s, hard Cu, 40 °C) | 50.56 mm² | 50.6 mm² (= 99.8 kcmil via Eq. 39, K_f 7.06) |

Also correct: L_M rod weighting 1.55 + 1.22·L_r/√(Lx²+Ly²) (Eq. 88), L_S = 0.75L_c + 0.85L_R, use of Ik1 (3I₀) with S_f = 1 conservative, ln(1+(T_m−T_a)/(K₀+T_a)) ≡ ln((K₀+T_m)/(K₀+T_a)). Only nit: K_s validity range (0.25 m < h < 2.5 m) is unguarded, and D is the mean of x/y spacings for rectangular grids — both minor and conventional.

---

## Overall engineering opinion — fitness for purpose

- **loadflow.py** — The numerical core (NR/GS, Jacobian, tap model, per-unit system, Q-limit switching) is *correct and verified to textbook accuracy*; the dispatch layer is elaborate but did not produce power-balance errors in any test. Fit for purpose for radial/lightly-meshed distribution studies **provided** EE-2 (cascaded TX chains) is fixed or hard-blocked — that one silently invalidates a legal drawing. The ideal-source swing model is a documented scope decision but must be kept in mind for anything voltage-dip related.
- **loadflow_cases.py / contingency.py / voltage_stability.py** — Sound architecture (never-raise batch re-solves) and verified continuation math; fix EE-3 (loss double-count) before trusting case-comparison loss figures, EE-4 before trusting N-1 verdicts on schematics with dangling loads, and EE-6/EE-7 for correct labelling. With those, fit for screening-level security and stability studies.
- **cable_sizing.py** — Formula-faithful to IEC 60364/60909-0 §12 and conservative in the right places; fit for purpose. Clearing-time estimation is the weakest input — encourage the explicit override.
- **motor_starting.py (static)** — **Not currently fit for its stated purpose** (voltage-dip acceptance) on stiff-looking drawings: EE-1 + EE-5 both bias non-conservative and I demonstrated a pass verdict on a start that is really at/below the 0.80 p.u. limit. The dynamic engine already contains the correct machinery; port it or gate the static result with a warning.
- **dynamic_motor_starting.py** — The strongest engine reviewed: physics, per-unit bases, starter models and the multi-motor coupling all verified independently; nameplate fitting honest about its anchor points. Fit for purpose within its single-cage/IEEE 3002.7 scope.
- **load_diversity.py** — Simple and correct at bus level; transformer-level aggregation (EE-13) under-counts multi-level networks — treat those figures as indicative only until fixed.
- **grounding_system.py** — Implements IEEE 80 faithfully (every factor matched my hand calculation to 3–4 significant figures, including D_f and Onderdonk sizing). Fit for purpose for preliminary grid design; S_f = 1 and the single-layer soil model are appropriately conservative simplifications and are disclosed.

**Priority of remediation:** EE-1 and EE-5 (motor-start dips, non-conservative safety verdicts), EE-2 (garbage solutions from a legal drawing), then EE-3/EE-4 (corrupted comparison/security metrics), then the P3 hardening items.

---

# Part 2 — Senior Protection Specialist: Protection & Fault Engines (PS-1 … PS-16)

# Independent Protection Engineering Review — ProtectionPro Calculation Engines
**Scope:** `backend/analysis/fault.py`, `backend/analysis/arcflash.py`, `backend/analysis/duty_check.py`, `frontend/js/tcc.js` (+ curve constants in `frontend/js/constants.js`), `frontend/js/compliance.js`, instrument-transformer usage.
**Method:** first-principles read of every formula against IEC 60909-0, IEEE 1584-2002, IEC 60255-151/IEEE C37.112, IEC 60269, C57.109, IEC 60364/SANS 10142-1; independent hand calculations executed against the live engines (Python 3, `backend.analysis` imported directly; JS constants exercised in node). The 170-case regression suite passes; the findings below are in behaviour the suite does not pin.

---

## Findings

### PS-1 — P1 — Parallel-path enumeration double-counts shared upstream impedance (fault currents overstated up to ~60% in ring/parallel-feeder networks)
**File:** `backend/analysis/fault.py`, `_collect_source_paths` (lines 377–602) + `_parallel_impedances` (1363–1372), also `_collect_zero_seq_impedances` (956–1143), `_compute_breaking_current`, `_compute_branch_contributions`.

**What the code does:** enumerates every simple path from the faulted bus to each source, sums each path's series impedance, then parallels the *path totals*: `z_eq = _parallel_impedances([p["z_total"] for p in paths])`.

**What it should do:** solve the actual network (nodal/Zbus reduction). Paralleling path totals is only exact when parallel paths share **no** common element. When two parallel feeders share the same source (or transformer), the shared impedance is duplicated into each path and then halved by the parallel combination — i.e. the source impedance itself is halved.

**Numerical demonstration** (utility 500 MVA X/R=10 → 11 kV bus → **two identical parallel cables** 0.2+j0.1 Ω → faulted 11 kV bus, base 100 MVA):
- Correct: Z_eq = Z_Q + Z_c/2 = (0.0219+j0.2189) + (0.0826+j0.0413) = 0.1045+j0.2602 pu → **Ik″ = 20.587 kA**
- Engine: Z_eq = (Z_c+Z_Q)/2 = 0.0936+j0.1508 pu → **Ik″ = 32.534 kA** (**+58%**)

Any ring-main, bus-coupler, or duplicated-feeder network — completely routine topologies — is affected, and the same defect propagates into Z0 (SLG), Ib, ip (via Z_eq R/X), the branch-contribution divider, and everything downstream (arc flash, duty check). The irony is that `_compute_voltage_depression` (line 1610+) already builds a correct Ybus/Zbus for the same network; the headline currents don't use it. Note also the path/expansion caps (`MAX_FAULT_PATHS=200`, line 357) truncate silently on meshed networks (console `print` only — the API response carries no warning).

**Fix:** compute Z_kk from the Zbus already built for voltage depression (extended with the Z0 network), or at minimum detect shared elements across paths and refuse/star-mesh-reduce. Until then, document that results are valid for **radial** networks only.

---

### PS-2 — P1 — Zero-sequence contribution from generators, solar PV, BESS and wind is not gated by neutral earthing (SLG current fabricated/overstated)
**File:** `backend/analysis/fault.py`, `_collect_zero_seq_impedances` lines 1007–1042.

**What the code does:** the utility branch correctly blocks Z0 when `grounding` is ungrounded (lines 995–997), but a **generator** is added as a Z0 source unconditionally with Z0 = Z1 fallback (1007–1021), and **solar_pv / battery / wind_turbine** are added with their *positive-sequence* impedance as Z0 (1023–1042) — no earthing check at all, no 3Zn.

**What it should do:** a machine or inverter feeds zero-sequence current only if its neutral (or the star point of its coupling arrangement) is earthed; utility-scale generators are almost universally high-impedance earthed (Ik1 contribution ≈ a few amps), and inverter sources (3-wire or delta-coupled) present Z0 → ∞. IEC 60909-0 §10/§6.4: Z(0) path exists only through earthed neutrals.

**Demonstrated:** a lone 10 MVA generator bus reports Ik1 = Ik3 = **3.848 kA even with `grounding: "ungrounded"` set** (no prop is consulted); a lone 1 MW PV inverter bus reports Ik1 = Ik3 = 1.792 kA. Consequence: earth-fault relay sensitivity and the SANS 10142-1 disconnection check (compliance.js consumes `ik1`) are validated against current that will not exist — non-conservative for protection decisions in any network with embedded generation.

**Fix:** mirror the utility gate for all machine/inverter sources; add generator `x0`, `neutral_grounding` and 3Zn handling (already exists for transformers via `_grounding_impedance`); block inverter sources from Z0 by default.

---

### PS-3 — P2 — Earth-fault disconnection compliance is checked against the *maximum* fault current (c = 1.10), and via a 10×In proxy instead of disconnection times
**File:** `frontend/js/compliance.js` `_sans10142_earthFaultCurrent` (1171–1250); `backend/analysis/fault.py` (no min-fault mode in the compliance workflow).

**What the code does:** takes `faultResult.ik1` — computed with c_max = 1.10, cold-conductor resistance, and the PS-1 overstatement — and passes the bus if Ik1 ≥ 10×In of a connected device.

**What it should do:** IEC 60909-0 §5.3.1/§8 and IEC 60364-4-41/SANS 10142-1 Cl. 5.5.6 require disconnection to be verified with the **minimum** earth-fault current: c_min = 0.95, conductor resistance at end-of-fault temperature (R·[1+0.004(θ−20)]), fault at the remote end of the circuit — and then a **device-curve time check** against the 0.4 s / 5 s limits. The API's `voltage_factor` override exists, but no temperature correction exists anywhere, and compliance never uses cmin. The 10×In criterion also ignores the actual device curve (the code has `fuseTripTime`/`cbTripTime` available) and evaluates devices found by an undirected walk (including downstream feeder devices). Every LV TN pass in this section is therefore optimistic by ≥ 1.10/0.95 ≈ 16% before temperature effects (~+24% on R for 70 °C PVC).

**Fix:** run an Ik1-min study (c=0.95 + resistance temperature factor) for the disconnection section, and check t_disconnect from the device curve at that current against 0.4 s/5 s.

---

### PS-4 — P2 — IEEE 1584-2002 distance exponent wrong for the LV cable equipment class
**File:** `backend/analysis/arcflash.py`, lines 247–253 with `_GAP_BY_CLASS["lv_cable"] = 13` (line 73).

**What the code does:** LV enclosed → `x = 1.473 if gap_mm >= 32 else 1.641`. A bus with `equipment_class: "lv_cable"` (gap 13 mm) gets x = 1.641.

**What it should do:** IEEE 1584-2002 Table 4 gives **x = 2.000 for cables** (13 mm gap); 1.641 is MCC/panelboard. At 455 mm working distance the (610/D)^x factor is 1.797 vs 1.618 → incident energy **understated ~11%** for cable-class buses (non-conservative). Minor cousin: `mv_switchgear_5kv` gap is 104 mm (the 2018 value); 2002 Table 4 uses 102 mm (negligible: 0.0011×2 mm in lg En).

**Fix:** key the x-factor on the equipment class directly (`lv_cable` → 2.0) instead of inferring from gap.

---

### PS-5 — P2 — Peak current κ omits the 1.15 meshed-network factor (Method B incomplete)
**File:** `backend/analysis/fault.py`, `_compute_peak_current` (1387–1408).

**What the code does:** κ = 1.02+0.98e^(−3R/X) from the R/X of the reduced Z_eq — exact for radial single-path networks (verified below), but for meshed networks IEC 60909-0 §8.1.2.2 (Method b) requires **ip = 1.15·κb·√2·Ik″** (capped at 1.8κ√2 LV / 2.0 HV), or the Method c equivalent-frequency procedure. The docstring admits the omission. In a meshed network ip — and therefore the making-capacity duty check in `duty_check.py`/compliance — is understated by up to 15% (non-conservative). Combined with PS-1 the meshed-network ip is not trustworthy in either direction.

**Fix:** apply the 1.15 factor (with the standard's caps) whenever more than one source path exists; long-term, Method c.

---

### PS-6 — P2 — Generator impedance correction factor K_G (and unit K_S/K_SO) not applied
**File:** `backend/analysis/fault.py`, `_generator_impedance` (761–768).

**What the code does:** Z_G = x″d on rated base × base conversion, R from X/R. No correction.

**What it should do:** IEC 60909-0 §6.6.1 Eq. (18): **K_G = (Un/UrG)·c_max/(1 + x″d·sinφ_rG)** applied to Z_G; §6.7 K_S for power-station units (generator+unit transformer). Example: x″d = 0.15, cosφ = 0.85 → K_G = 1.10/(1+0.15×0.527) = **1.019** → engine overstates the generator's Ik″ contribution by ~2%; with x″d = 0.25, cosφ = 0.8 → K_G = 1.10/1.15 = 0.957 → engine *understates* by ~4.5%. Direction is parameter-dependent, so this is a genuine standards deviation, not a conservative simplification. Also, IEC 60909-0 §6.6.1 specifies fictitious R_G values (0.05/0.07/0.15·X″d by class); the default `x_r_ratio = 40` (R = 0.025X″d) is lower than any of them, slightly raising κ at generator buses.

**Fix:** compute K_G from x″d, rated pf and Un/UrG; default R_G per the standard when no X/R is supplied.

---

### PS-7 — P3 — Induction-motor q-factor uses the current ratio as a proxy for MW-per-pole-pair
**File:** `fault.py` `_compute_breaking_current` lines 1470–1482, `_q_factor` 1532–1551.
The q coefficients themselves match IEC 60909-0 (1.03+0.12 ln m, 0.79+…, 0.57+…, 0.26+0.10 ln m), but the standard's argument m is **rated active power per pole pair (MW)**; the code passes I″kM/I_rM (≈5–7). For a typical 200 kW 4-pole motor m ≈ 0.1 → q(0.1 s) = 0.29, while the proxy gives q ≈ 0.79 — Ib from motors overstated ~2.7×. Direction is conservative for breaking duty, and the code flags the simplification, but pole count should become a motor prop. (Also: μ/q breakpoints are stepped, not interpolated, though the μ docstring says "interpolates" — doc nit.)

### PS-8 — P3 — YNyn pass-through zero-sequence omissions
**File:** `fault.py` `_transformer_zero_seq`/`_collect_zero_seq_impedances` lines 1072–1079, 1264–1303.
(a) When Z0 passes through a YNyn transformer, only the **bus-side** 3Zn is added; the far-side neutral impedance 3Zn(far) belongs in series in the through path — impedance-earthed YNyn banks get an optimistic Ik1. (b) The pass-through recursion deliberately passes `entry_port=None` (line 1079), so a transformer met immediately after falls into the "port unknown — check both sides" fallback (1216–1221), which can classify a Dyn unit as a Z0 source from its delta side. (c) Transformer Z0T is fixed at Z1T (no x0/x1 prop; typical Dyn 3-limb Z0T ≈ 0.85·Z1T), and the cable Z0 fallback is 3.0×Z1 in one branch but 3.5× per-component in the other (lines 1106–1110) — inconsistent.

### PS-9 — P3 — Backend clearing-time model diverges from the frontend TCC device model
**File:** `arcflash.py` `_cb_self_clearing_time` (479–522), `_relay_operate_time` (398–427).
The thermal region of a CB is a 0.5/1.0/2.0 s "bucket heuristic" while the frontend uses t = k/(M²−1); and the backend relay evaluation ignores CT saturation, which the frontend TCC applies (`ctEffectiveCurrent`). A saturated CT slows the relay → **longer** clearing → higher incident energy; ignoring it in arc flash is the non-conservative direction. Impact is bounded by the 2.0 s IEEE 1584 cap, hence P3.

### PS-10 — P3 — Arithmetic magnitude summation of path currents
**File:** `fault.py` lines 260–269, 633–640, 1440–1441.
Ib, Ik_steady, the motor/network split and branch contributions sum |c/Z_path| arithmetically; since Σ1/|Z_i| ≥ |Σ1/Z_i| this overstates (conservative) and branch percentages can exceed 100% when path angles differ (documented in code). Acceptable, but should be stated in reports.

### PS-11 — P3 — Fixed study conventions
`fault.py`: c_max = 1.10 applied at every voltage level (Table 1's 1.05 for legacy +6% LV systems not selectable — conservative, documented); Ith uses n = 1 (conservative); breaking time t_min fixed at 0.1 s (not exposed through `run_fault_analysis`); Ib_asym uses a fixed 100 ms and a τ from the reduced Z_eq. All defensible screening conventions; they should be surfaced as report assumptions.

### PS-12 — P3 — LLG degenerate case reports a phase current in the earth-current field
**File:** `fault.py` lines 222–228. `ikLLG` is defined as I″kE2E = |3Ia0| (earth-return current); when no Z0 path exists the true earth current is **0**, but the code reports the LL phase current in the same field. Physically nonzero phase current does flow, but the quantity changes meaning; report 0 (or a separate phase-current field).

### PS-13 — P3 — Arc flash documentation/coverage nits
**File:** `arcflash.py`. (a) Docstring at line 207 says "Cf = 1.0 for V<1kV, 1.5 for V>=1kV" — inverted; the **code is correct** (1.5 for ≤1 kV). (b) The IEEE 1584-2002 §9.3.2 exemption (<240 V fed by a single transformer <125 kVA) is not applied — conservative, but worth a note in results. (c) The bisection floor of 300 mm means AFB is never reported below 300 mm — conservative.

### PS-14 — P3 — Duty check gaps
**File:** `duty_check.py`. (a) `ib_asymmetric` is computed by the fault engine but never compared to any rating (asymmetrical breaking / DC-component duty per IEC 62271-100 §4.101 unchecked). (b) The LV making-ratio table lumps Icu ≤ 4.5 kA into n = 1.5 (standard minimum is 1.41 below 4.5 kA) — ~6% optimistic on *assumed* making capacity for miniature breakers. (c) Duty is checked against the worst adjacent-bus total fault current, not the through-current — conservative, fine.

### PS-15 — P3 — Fuse curves are a single generic gG shape
**File:** `constants.js` 560–636 / `arcflash.py` 312–380. One shape ratio-scaled per rating (anchored 0.1 s at 8×In), not the per-rating IEC 60269-1 gate corridor; total clearing = 1.2×pre-arc convention. Documented in code; adequate for screening, not for tight fuse grading — the UI should carry the same caveat the code comments do.

### PS-16 — P3 — Instrument transformer modelling gaps
**File:** `constants.js` 422–514. The CT saturation model (used by TCC trip times) treats **Vk ≈ ALF·I_sn·(Rct+R_b)** — that is the accuracy-limit voltage, not the knee point (Vk ≈ 0.8·V_AL for 5P cores), and the symmetric-clipping RMS model ignores DC offset and remanence, the dominant saturation drivers at high X/R — the model is optimistic for close-in faults. Rct defaults to 0 (overstates I_sat when burden is small). PT parameters are not used in any calculation. No CT burden/ratio adequacy check exists. Also: **no motor-starting curve overlay exists in tcc.js** (motors appear only in the mini-SLD and the compliance nuisance-trip check), so relay-vs-motor-start coordination cannot be verified graphically.

---

## Verified correct (with worked numbers)

### fault.py — IEC 60909 core (radial networks)
Test network: utility 500 MVA, X/R 10 → 11 kV bus → Dyn11 1 MVA, 6%, X/R 5 (LV solidly earthed) → 0.4 kV bus; base 100 MVA, c = 1.10. My independent hand calculation vs engine:

| Quantity | Hand | Engine |
|---|---|---|
| Z_Q (Eq. 15, c included) | 0.0219+j0.2189 pu | identical |
| K_T = 0.95·1.1/(1+0.6·0.0588) | 1.00937 | applied (Z_T = 1.1877+j5.9386) |
| Ik″3 @11 kV / @0.4 kV | 26.243 / 25.301 kA | 26.243 / 25.301 |
| Ik″1 (3c/\|Z1+Z2+Z0\|, Z0 = Z_T only — delta blocks upstream) | 25.599 kA | 25.599 |
| Ik″2 (√3c/\|Z1+Z2\|) | 21.912 kA | 21.912 |
| I″kE2E (3\|Ia0\|, Ia1 = c/(Z1+Z2‖Z0)) | 25.904 kA | 25.904 |
| κ = 1.02+0.98e^(−3R/X), ip = κ√2Ik″ | 1.564 / 55.948 kA | 1.564 / 55.947 |
| m-factor (Tk=1 s) → Ith = Ik″√(m+1) | m = 0.01744, 25.521 kA | 25.521 |

- **Sequence connections** all correct in per-unit (E = c pu): SLG 3c/|Z1+Z2+Z0|, LL √3c/|Z1+Z2| (√3 factor verified analytically), LLG earth current via Ia1/Ia0 — all match IEC 60909-0 §8.3.2/8.3.3.
- **Dyn delta-side blocking** verified: Ik1 at the 11 kV bus = utility-only (2Z1+Z0 = 3Z_Q → Ik1 = Ik3 with Z0/Z1 = 1 default).
- **μ coefficients** (0.84+0.26e^−0.26x etc.) and **q coefficients** match IEC 60909-0 Eq. (70)/(71) digit-for-digit; μ = 1 below I″k/Ir = 2 correct; generator I″kG/IrG correctly evaluated at the fault point. Motor case verified end-to-end: 2 MW motor, x″ = 0.167 → engine motor infeed 0.823 kA, Ib = 26.707 kA — matches my hand μ = 0.7084, q = 0.7956 exactly.
- **3Zn grounding** in Z0 (not K_T-corrected — correct per §6.3.3), K_T on Z1 only.
- **TT earthing**: 3(R_A+R_B) correctly enters Z0 — 25 Ω total gives Ik1 = 10.2 A vs hand 1.1×230/25 = 10.1 A. **IT**: Ik1 = 0 ✓. **Single-earthed YNyn**: three-limb core gives Ik1 = 5.969 kA via Z0m = 0.6 pu on unit base (hand: 3×1.1×144.34/|2Z1+Z_T+Z0m| = 5.97 ✓); five-limb → 0 ✓. Physically sound and well documented.
- Cable per-unit conversion uses the bus-inferred voltage zone (correct; avoids the (11/0.4)² trap), parallel-cable count handled, open CB/switch blocks the walk, motor S_rM = P/(η·cosφ) per §3.8.

### arcflash.py — IEEE 1584-2002
Digit-by-digit hand calc, 480 V switchgear, 25 kA, G=32 mm, D=455 mm, VCB, ungrounded, t=0.2 s:
lg Ia = −0.097+0.662·lg25+0.0966·0.48+0.000526·32+0.5588·0.48·lg25−0.00304·32·lg25 = 1.13061 → **Ia = 13.508 kA** (engine 13.508). lg En = −0.555+1.081·lg13.508+0.0011·32 → En = 5.0395 J/cm²; E = 4.184·1.5·En·(t/0.2)·(610/455)^1.473 = 48.71 J/cm² = **11.642 cal/cm²** (engine 11.642). AFB closed-form 2128 mm = engine bisection 2128 mm. MV check (11 kV, 12.5 kA, grounded, 153 mm, 910 mm, 0.5 s): hand Ia = 12.086 kA, E = 7.928 cal/cm² — engine identical. K1/K2/Cf/coefficients all correct; 85% reduced-current second calculation with **re-evaluated device clearing time** (better than the common 1.5× heuristic); 2 s cap; 700 A–106 kA and 6.35–76.2 mm validity warnings; clearing-time BFS refers Iarc across transformer ratios and takes the slowest infeed (conservative); relay/fuse/CB models consistent with the frontend conventions.

### duty_check.py
Verified numerically: Ib preferred over Ik″3 (fallback conservative); ip = κ√2·Ik″ = 1.564·√2·25.3 = 55.96 kA ✓; making capacity 2.5×/2.6× per IEC 62271-100 (MV, 50/60 Hz) and the IEC 60947-2 n-ratio ladder (25 kA → 2.1× = 52.5 kA ✓, correctly failed against 55.96 kA); voltage and continuous-current checks sound; correct current (breaking→breaking rating, peak→making rating) compared throughout.

### tcc.js / constants.js
- **IDMT constants exactly match** IEC 60255-151 (SI 0.14/0.02, VI 13.5/1, EI 80/2, LTI 120/1) and IEEE C37.112 (MI 0.0515/0.02/0.114, VI 19.61/2/0.491, EI 28.2/2/0.1217). Spot values computed in node: IEC SI M=10 TMS=0.1 → **0.2971 s** ✓; IEC VI M=5 TMS=0.2 → 0.675 s ✓; IEEE VI M=5 TDS=1 → 1.3081 s ✓.
- Cable adiabatic k: 143/115/94/76 (Cu-XLPE/Cu-PVC/Al-XLPE/Al-PVC) = IEC 60364-5-54 ✓; damage curve I²t = k²S² with the ≤5 s adiabatic validity label.
- C57.109: Cat I t = 1250/I²pu ✓ (drawn ≥3.5×Ir), Cat II–IV anchored 2 s at Ir/Zpu — reasonable representation; inrush point 12×In @ 0.1 s.
- Voltage referral I_ref = I·(V_actual/V_ref) correct in both the plot and the pairwise grading (`_referCurrent`).
- Grading engine is genuinely good: topology-derived series pairs only, test points restricted to buses actually downstream of the pair (kills the fictitious ratio-referred test point), earth vs phase element classes graded at ik1 vs ik3, zero-sequence blocking by Dyn/zigzag correctly excludes ik1 referral, fuse–fuse by the 1.6:1 (≥2:1 recommended) IEC 60269 ratio rule with R10 tolerance, damage curves excluded from time-grading, reverse-directional 67 excluded, order-aware CTI (0.3 s relay-relay, 0.2 s over a downstream fuse, full margin under an upstream fuse) — all defensible practice.

### compliance.js
TT: R_A·IΔn ≤ 50 V per IEC 60364-4-41 §411.5.3 with the *largest* declared IΔn (conservative) ✓; TT-without-RCD = fail ✓; TN-C with an RCD = fail (RCD cannot work on a PEN) ✓; TN-C-S RCD-below-split note ✓; IT → IMD warning ✓; In ≤ Iz ✓; adiabatic t_clear ≤ k²S²/I² with actual device curves ✓; making/breaking duty mirrors the backend (verified factors) ✓; LV ±10% / MV ±5% voltage bands sensible.

---

## Engineering opinion — fitness for purpose

- **fault.py:** The IEC 60909 formula layer is implemented with unusual care — every constant, correction factor and sequence connection I hand-checked is right, and the LV earthing-system / star-star magnetising modelling is genuinely sophisticated. However, the **path-enumeration network solver (PS-1) restricts trustworthy use to radial networks**, and the ungated machine/inverter Z0 sources (PS-2) make SLG results unreliable wherever embedded generation exists. **Fit for radial, utility-fed distribution studies; not fit for ring/meshed networks or earth-fault studies on generator/inverter-fed systems until PS-1/PS-2 are fixed.**
- **arcflash.py:** Faithful, digit-perfect IEEE 1584-2002 with honest documentation of what the 2002 model can and cannot do, and a clearing-time integration better than most screening tools. Fix the cable-class x-factor (PS-4). **Fit for use as a 2002-edition study** — but the industry has moved to 1584-2018; results should be labelled accordingly on safety documentation.
- **duty_check.py:** Correct quantities compared to correct ratings with correct derivation factors. **Fit for purpose** (subject to the fault currents it consumes — see PS-1), with asymmetrical-breaking duty as the missing refinement.
- **tcc.js:** Curve mathematics and constants are correct and the topology-aware grading logic exceeds what several commercial screening tools do. The generic fuse family and the absence of a motor-start overlay mean final grading must still be done against manufacturer curves. **Fit for coordination screening; not a substitute for manufacturer-data grading.**
- **compliance.js:** The earthing-system rules (TT/IT/TN-C) are correct and valuable. The TN disconnection check needs a minimum-fault-current basis (PS-3) before its PASS verdicts should be relied on.

---

# Part 3 — Principal Engineer Adjudication

## Adjudication of findings

### EE-1 — CONFIRMED
Reproduced independently: a 200 kW motor placed directly on a 20 MVA utility bus returns terminal V = 1.000 p.u., dip = 0.00%, will_start = True — the source impedance contributes nothing because `run_motor_starting` (backend/analysis/motor_starting.py:68-274) evaluates the dip through `run_load_flow`, which holds the utility at 1.0 p.u. with zero internal impedance (loadflow.py:1897-1902, deliberate and documented for load flow, fatal for a dip study). Behind a 1 MVA / 5% TX my run gave V = 0.859 counting the TX drop only; adding the 20 MVA source Thevenin (~5 pu on 100 MVA) pushes the true value below the engine's own 0.80 will-start threshold (motor_starting.py:225) — a false "pass". My absolute numbers differ slightly from the reviewer's (different starting-MVA prop conventions) but the mechanism and the non-conservative verdict are fully reproduced. The proposed fix (Thevenin superposition as in dynamic_motor_starting.py) is right, with two caveats: (a) the fault-path walker it would reuse carries the PS-1 parallel-path defect, so sequence the fixes; (b) `test_regression.py::TestMotorStarting` pins the current constant-PQ reconstruction and must be deliberately re-anchored.

### EE-2 — CONFIRMED
Code verified: `_get_chain_turns_ratio` (loadflow.py:1383-1422) returns inside the loop on the **first** transformer found; a two-transformer chain gets one transformer's ratio applied to the lumped chain admittance. Reproduced: 33 kV → TX1(33/11) → TX2(11/0.4) → 0.4 kV load with no intermediate bus gives LV bus V = **0.00029 p.u. with converged = True**; inserting the 11 kV bus gives 0.99612. A syntactically legal drawing yields a numerically converged garbage solution. The solution-quality heuristic (loadflow.py:1583+) attributes implausibly-low voltage to collapse/loadability — a misleading diagnosis here. Fix: I prefer the hard modelling error (detect ≥2 transformers per chain) over the Π-ratio accumulation — the chain walk order is fragile and a refusal is safer; either is acceptable.

### EE-3 — CONFIRMED
Reproduced: splitting a 5 km cable into two 2.5 km series cables (no bus between) puts the full chain loss 0.724687 MW on **each** row (control single cable: 0.724687 MW), and `loadflow_cases._summary` line 50 sums rows → 1.449 MW, 2× true. The code itself admits the repetition (loadflow.py:2296-2298 "summing rows over a chain double-counts") but the Study Manager summary sums anyway — corrupting exactly the comparison metric the feature exists for. Fix (apportion I²Z per element, or sum unique chains) is sound and physically better per-element. Note the same row repetition also lets contingency overload screening flag one chain multiple times — minor, same root.

### EE-4 — CONFIRMED
Reproduced exactly: grid → bus → cable → dangling 4.25 MW load (the topology `insert_implicit_load_buses` explicitly supports). Loss of Grid: `islanded`, lost_load = **0.0** MW; loss of the sole feeder C1: **`secure`**, zero violations. Control with a drawn terminal bus reports 4.25 MW on both. Root cause verified: `_evaluate` (contingency.py:100-108) diffs energized real-bus sets while `connected_bus_loads_mw` keys the demand under the stripped `__term__*` synthetic id, and outaging the feeder removes the load from the model entirely. A "secure" verdict for total loss of a load is a genuinely dangerous reporting failure for an N-1 study. Fix (synthetic-inclusive accounting + "load no longer connected" violation) is correct and self-contained.

### EE-5 — CONFIRMED
Code verified: the starting condition rewrites `power_factor`/`rated_kw`/`efficiency` (motor_starting.py:171-181) but leaves `demand_factor`, and the load model multiplies by df (loadflow.py:1972-1978). Reproduced: df = 0.5 halves the reported dip (12.83% → 5.80%) at identical reported starting current (2191 A). Locked-rotor current is a machine property; scaling it by a demand factor is simply wrong and non-conservative for every motor with df < 1. The one-line fix (`demand_factor = 1.0` in the modified project) is correct and low-risk.

### EE-6 — CONFIRMED
Reproduced verbatim: stiff network, step = 0.35, λ_max = 4.0 → `collapsed=True, lambda_critical=3.8`, note "Voltage collapses at λ = 3.800 … weakest bus 'B2' at 1.000 p.u." — a bus at nominal voltage declared collapsed, purely because 1 + k·0.35 never lands on 4.0 (voltage_stability.py:139-163, `first_bad` stays None yet `collapsed = lam_critical < lambda_max − 1e-6`). Only bites for user-chosen steps that don't divide the range, and errs conservative (declares a collapse that isn't) — I would rate it P2/P3 boundary, but the note asserts a false engineering conclusion, so P2 stands. Fix (`collapsed = first_bad is not None`) is exactly right.

### EE-7 — CONFIRMED
Code verified: the Q-V curve point is `cb.q_mvar` — the net bus injection — and the inline comment (voltage_stability.py:285-286) acknowledges it equals "condenser Q − local reactive load". The reviewer's own analytic cross-check (−74.96 vs −75.0 closed-form; offset by exactly the local Q load) demonstrates the math is right and only the headline label is wrong: `qv_min_mvar` overstates the classical fictitious-condenser margin by the bus's local Q at load buses. Relabelling or adding the local-Q term back are both fine; the curve itself is usable as-is.

### EE-8 — CONFIRMED
Reproduced: a static load with `power_factor: 1.2` raises `ValueError: math domain error` from the unclamped `math.sqrt(1 - pf**2)` at loadflow.py:1965 (also 1978, 1987), while the distribution-board path at 1890/1892 uses `max(0, …)`. Whole-study HTTP 500 from one bad user prop. Fix is the existing in-codebase pattern; trivial.

### EE-9 — CONFIRMED
Code verified: capacitor bank injects constant Q (loadflow.py:1990-1993) rather than Q ∝ V² susceptance. Optimistic (+23% credited output at 0.9 p.u.) exactly where it matters — depressed voltage and P-V continuation near the nose, where voltage_stability.py holds cap Q fixed while scaling loads. The SVC precedent for V²-tracking exists in the same file, so the fix is a known pattern. P3 appropriate.

### EE-10 — CONFIRMED
Code verified (loadflow.py:1779-1812): the chain series impedance is lumped first and the off-nominal π-model wraps the whole chain, so a cable in a tapped-transformer chain is mis-referred by up to t² ≈ 1.21 at ±10% tap. Exact at t = 1 and for cable-free chains, which is why the regression suite doesn't see it. Few-percent branch-drop error; P3 correct. Pragmatic fix (document "put a bus at the transformer terminal when tapping") is acceptable short-term.

### EE-11 — CONFIRMED
Code verified: GS declares convergence on max|ΔV| per sweep (loadflow.py:3093-3097) with no final power-mismatch check; NR magnitude update `V[i] = abs(V[i]) + dx` (line 3048) is unguarded against a step driving |V| negative (the later `abs()` silently flips phase). Latent-risk hardening, no observed error — the reviewer is appropriately honest about that. P3 correct.

### EE-12 — CONFIRMED
Reproduced: a motor wired to a `distribution_board` gets `terminal_bus = None`, terminal V defaults to **1.0**, will_start = True — even while the system dip (12.83%) is correctly computed, because load flow does treat the board as a bus (loadflow.py:1671-1673) but both `_find_motor_bus` walks stop only at `type == "bus"` (motor_starting.py:52, dynamic_motor_starting.py:~260). The safety-relevant output (terminal voltage / will-start) is the part that breaks. One-line fix in each walk; correct.

### EE-13 — CONFIRMED
Code verified (load_diversity.py:253-267): transformer demand aggregates only buses reachable through transparent elements, LV-side filtered — loads behind a feeder cable (main-board → sub-board, the standard pattern) are excluded, understating `demand_loading_pct`. Non-conservative for transformer adequacy screening, though load flow reports true loading elsewhere. Fix or a stated limitation both acceptable; P3 fair.

### EE-14 — CONFIRMED
All four bullets verified in code: cable shunt capacitance ignored (`_get_impedance` series RL, loadflow.py:1373-1379 — acceptable scope, document); cable-sizing `sin_phi = +√(1−cos²)` always lagging (cable_sizing.py:713 — conservative except for the note that a report can then flag a compliant cable); fuse clearing fixed at 0.01 s (cable_sizing.py:534-535 — optimistic near the melting threshold for the adiabatic check, the genuinely non-conservative bullet in this set, and inconsistent with the proper fuse-curve evaluation arc flash uses); voltage-stability bisection records only ok() points (cosmetic). Grouping as P3 miscellany is appropriate, but the fuse-clearing bullet deserves individual tracking.

### PS-1 — CONFIRMED
Reproduced digit-for-digit: two identical parallel 11 kV cables from one 500 MVA utility → engine Ik″ = **32.534 kA** vs correct 20.587 kA (+58%), matching the predicted (Z_Q+Z_c)/2 error exactly — the shared source impedance is duplicated into each enumerated path and then halved by `_parallel_impedances` (fault.py:150, 377-602, 1363-1372). Verified the same paralleling drives Z0, Ib, ip (R/X of the wrong Z_eq), and the branch divider; verified the "irony": `_compute_voltage_depression` (fault.py:1610+) already builds a genuine Ybus/Zbus for the identical network; verified the path-cap truncation warning is a console `print` only (1139-1141). This is the single most consequential defect in the codebase: every ring/parallel-feeder/bus-coupler topology produces wrong headline currents feeding arc flash, duty check, TCC test points and compliance. Note the direction is **bidirectionally dangerous**: overstated current is conservative for withstand duty but non-conservative for arc flash (faster assumed clearing → lower energy) and for any minimum-current reasoning. Fix via Zbus (Z_kk) is right; the interim "radial networks only" documentation is the correct honest stopgap. Not pinned by the regression suite (all fault tests are radial).

### PS-2 — CONFIRMED
Reproduced: a lone 10 MVA generator with `grounding: "ungrounded"` reports Ik1 = Ik3 = 3.848 kA (no prop consulted — fault.py:1007-1021 adds the generator to Z0 unconditionally with Z0 = Z1 fallback); a lone 1 MW PV inverter reports Ik1 = Ik3 = 1.792 kA with positive-sequence Z as Z0 (1023-1042). The utility branch has the exact gate the machines lack (995-997). Earth-fault protection and the SANS disconnection check are validated against current that will not exist — non-conservative, and increasingly common topologies. Fix (mirror the utility gate, default generators "solidly" for legacy parity, block inverters from Z0 by default) is right; note that blocking inverters **changes results for existing PV projects** — a deliberate, documented behaviour change, and no regression test currently pins inverter Ik1, so the suite survives.

### PS-3 — CONFIRMED
Code verified: `_sans10142_earthFaultCurrent` (compliance.js:1171-1250) passes/fails on `faultResult.ik1` — computed at c_max = 1.10 with cold conductors (no temperature correction exists anywhere in fault.py) — against a 10×In proxy from devices found by an undirected walk; the `voltage_factor` override exists in the API (fault.py:73) but the compliance workflow never uses it, and there is no min-fault/remote-end mode. Two partial mitigations the reviewer under-weights: 10×In is itself conservative versus typical instantaneous pickups, and the fault is at the bus rather than the circuit extremity — but the second cuts the other way (the standard requires the remote end, adding loop impedance the check never sees). Net verdict stands: TN disconnection PASSes are optimistic by ≥16% before temperature and end-of-circuit effects. The fix (Ik1-min study at c = 0.95 + hot resistance + device-curve time vs 0.4 s/5 s) is the correct standards basis; the curve-evaluation machinery already exists in the codebase.

### PS-4 — CONFIRMED
Code verified: `_GAP_BY_CLASS["lv_cable"] = 13` (arcflash.py:72) → `x = 1.641` via the gap-threshold inference (247-253); IEEE 1584-2002 Table 4 gives x = 2.000 for cables. Arithmetic checked: (610/455)^2.0/(610/455)^1.641 = 1.111 → incident energy ~11% understated at 455 mm — non-conservative on a safety label. The mv_switchgear 104 vs 102 mm nit is real and negligible as stated. Fix (key x on equipment class, not gap) is clean; no regression test pins the cable class.

### PS-5 — CONFIRMED
Code verified: `_compute_peak_current` (fault.py:1387-1408) applies κ from Z_eq R/X with no 1.15 Method-b factor — the docstring itself concedes it. Meshed-network ip (and the making-capacity comparison in duty_check.py:145, 197) understated up to 15%: non-conservative. Combined with PS-1 the meshed ip is untrustworthy in both directions, as the reviewer says. Fix (1.15 with the LV 1.8κ√2 / HV 2.0 caps when >1 source path exists) is standard-correct and small; ensure the radial single-path case is left untouched so `test_peak_factor_kappa` keeps passing.

### PS-6 — CONFIRMED
Code verified: `_generator_impedance` (fault.py:761-768) applies no K_G; the reviewer's numbers re-check: K_G = 1.10/(1+0.15×0.527) = 1.019 and 1.10/1.15 = 0.957, so the deviation is parameter-dependent in direction (±2-5%), a genuine IEC 60909 §6.6.1 non-compliance rather than a conservative simplification. The fictitious-R_G observation (default X/R = 40 → R = 0.025X″d, below the standard's 0.05-0.15·X″d classes, slightly raising κ) is also correct. P2 is defensible given generator-fed studies are in-scope; magnitude is the smallest of the P2s. Fix is straightforward and won't disturb utility-only regression cases.

### PS-7 — CONFIRMED
Code verified (fault.py:1470-1482, 1532-1551): the q coefficients match IEC 60909-0 but the argument passed is I″kM/I_rM instead of MW per pole pair; the code flags the proxy explicitly (1475-1478). Direction conservative for breaking duty (Ib from motors overstated ~2.7× on the reviewer's example — arithmetic consistent with q(0.1)=0.29 vs 0.79). The `_mu_factor` docstring says "interpolates" while the implementation is stepped buckets — doc nit confirmed (1512-1527). P3 with a pole-pair prop as the eventual fix: agreed.

### PS-8 — CONFIRMED
All three sub-claims verified in code: (a) YNyn pass-through adds only the bus-side 3Zn (`_get_grounding(bus_side)` at 1264-1265; z0_element = z_xfmr + z_gnd at 1051, far-side neutral impedance never enters the through path); (b) the pass-through recursion passes `entry_port=None` (1079) so the next transformer hits the port-unknown fallback (1216-1221, `bus_side_delta = False`) and a Dyn unit can be classified a Z0 source from its delta side — note the cable branch was already fixed to forward the port (1112-1119), making the transformer branch's omission an evident oversight; (c) Z0T ≡ Z1T with no x0/x1 prop, and the cable Z0 fallback is 3.5× per-component in one branch vs 3.0× lumped in the other (1106-1110). P3 collectively is fair; (b) is the one that fabricates current and should lead the fix.

### PS-9 — CONFIRMED
Verified both halves: backend `_cb_self_clearing_time` thermal region is the 0.5/1.0/2.0 s bucket heuristic (arcflash.py:517-522, self-described "crude bucket heuristic") while the frontend uses t = k/(M²−1) (constants.js:703); backend `_relay_operate_time` (398-427) takes raw primary amps while the frontend TCC applies `ctEffectiveCurrent` (tcc.js:1088, 1936). Saturated CT → slower relay → longer arc → more energy, so ignoring it in arc flash is non-conservative; correctly bounded by the 2 s IEEE 1584 cap. P3 appropriate; the right fix is a shared device-time model (see cross-cutting).

### PS-10 — CONFIRMED
Code verified: Ib (`ib_total += μ·|c/Z_path|`, fault.py:1433-1482), the motor/network split (260-269) and branch contributions sum magnitudes arithmetically; Σ1/|Z| ≥ |Σ1/Z| so overstated (conservative), branch percentages can exceed 100%, documented in code. Accept as-is; surface as a report assumption. P3 correct.

### PS-11 — CONFIRMED
Verified: c_max = 1.10 at every voltage level (Table 1's 1.05 option not selectable; the per-request `voltage_factor` override exists), Ith n = 1, breaking t_min = 0.1 s hard-coded (default parameter, not exposed through `run_fault_analysis`), Ib_asym at fixed 100 ms with τ from the reduced Z_eq. All conservative or neutral screening conventions; agreeing with the reviewer that they belong in the printed report assumptions rather than the code alone. P3 correct.

### PS-12 — CONFIRMED
Reproduced: ungrounded utility → ik1 = 0.0 (correct) but ikLLG = 22.727 kA = ikLL — the LL phase current reported in the field defined as I″kE2E earth-return current (fault.py:222-228). The true earth current is 0; a nonzero value in an earth-current field could mislead earth-fault relay reasoning (mildly non-conservative as a labelling matter). Report 0 in ikLLG (or split out a phase-current field); watch that no regression test pins the degenerate value — none does.

### PS-13 — CONFIRMED
Verified: docstring line 207 states Cf inverted; code line 241 (`1.5 if voc_kv <= 1.0`) is correct per IEEE 1584-2002 — docstring-only fix. The <240 V/<125 kVA exemption absence and the 300 mm AFB bisection floor are conservative, note-in-results items. P3 correct.

### PS-14 — CONFIRMED
Verified: (a) `ib_asymmetric` is computed by fault.py but never referenced in duty_check.py (grep-clean) — asymmetrical breaking duty unchecked; (b) the LV making-ratio ladder lumps Icu ≤ 6 kA into n = 1.5 (duty_check.py:186-187) where IEC 60947-2 gives n = 1.41 below 4.5 kA — ~6% optimistic on assumed making capacity for miniature breakers, non-conservative but small; (c) duty against worst adjacent-bus total current (120-145) — conservative, fine. P3 correct on all three.

### PS-15 — CONFIRMED
Verified: one generic gG shape ratio-scaled per rating (constants.js:574-610), anchored 0.1 s at 8×In, explicitly documented in-code as "not the per-rating min/max gate corridor… use manufacturer data", mirrored verbatim in arcflash.py. Adequate for screening; the recommendation to surface the caveat in the UI (not just code comments) is right and cheap. P3 correct.

### PS-16 — CONFIRMED
Verified: `ctSaturationParams` derives Vk = ALF·I_sn·(Rct+R_b) (constants.js:467-470) — the accuracy-limit voltage, not the knee (≈0.8·V_AL for 5P) — and the symmetric-clipping RMS model ignores DC offset/remanence, so saturation onset is optimistic for close-in high-X/R faults; Rct defaults to 0 (line 460 — materially optimistic when the user supplies an explicit knee voltage); PT props appear in no calculation; no burden/ratio adequacy check; and tcc.js has no motor-starting curve overlay (motors appear only as load classification/mini-SLD — grep confirms). All correct; P3 as a cluster, with the missing motor-start overlay being a functional gap worth its own backlog line.

## Cross-cutting observations

1. **PS-1 is the root of a dependency tree.** The path-enumeration Z_eq feeds ik3/ik1/ip/Ib/Ith → arcflash.py (bolted current AND the clearing-time evaluation), duty_check.py (breaking and making duty), compliance.js (disconnection and duty mirrors), TCC grading test currents, **and** `_thevenin_at_bus` in dynamic_motor_starting.py. Critically, EE-1's recommended fix — port the fault-path Thevenin into the static motor-start engine — would inherit PS-1's defect on non-radial networks. Remediation must therefore fix PS-1 (or land the Zbus path) before or together with the EE-1 port.
2. **Overstated fault current is not automatically "safe".** PS-1/PS-2/PS-8(b) all fabricate or inflate current. In arc flash, higher assumed bolted current → higher arcing current → faster assumed device clearing → **lower** incident energy; in compliance, inflated Ik1 makes disconnection PASS. The naive "conservative because bigger" intuition fails for exactly the two safety documents this tool prints.
3. **The static motor-start cluster (EE-1, EE-5, EE-12) is one engine with three defects, all biased optimistic**, while the dynamic engine on the same drawings is verified sound. That asymmetry is the cleanest remediation story in the review: gate or replace the static engine with the dynamic machinery.
4. **Compounding of PS-2 + PS-3:** earth-fault compliance passes are checked against a current that is both maximised by convention (c_max, cold conductors, bus location) and potentially fabricated (inverter/generator Z0). The compliance verdict is the product of two independent optimisms.
5. **Divergent device models across engines** (PS-9, PS-15, EE-14 fuse bullet): fuse clearing is a fixed 10 ms in cable_sizing, a proper curve in arcflash, and 1.2×pre-arc in TCC; CB thermal is a bucket heuristic in the backend and k/(M²−1) in the frontend; CT saturation exists only in the frontend. A single shared protective-device time model would close PS-9, the EE-14 fuse bullet, and half of PS-15 at once.
6. **Accounting-boundary family (EE-3, EE-4):** both stem from the series-chain/synthetic-bus representation leaking into result aggregation. Fixing the aggregation layer (unique-chain losses; synthetic-inclusive contingency accounting) addresses both.
7. **Reviewer agreement:** no material conflicts. Both independently verified the numerical cores (NR/Jacobian; IEC 60909 radial layer; IEEE 1584 equations; IEEE 80) to hand-calculation accuracy, which raises confidence that the defect lists are near-complete within scope. Both also converge on the same theme from opposite sides: the formula layers are excellent; the network-representation/dispatch layers are where the defects live.

## Coverage assessment

**Verified correct by the reviewers (spot-confirmed by me where cited):** NR power equations and full Jacobian, GS PV-bus Q convention, single-transformer tap π-model, Q-limit clamping, per-unit conversions (loadflow); IEC 60909 radial fault layer including K_T, sequence connections, TT/IT/single-earthed star-star Z0 (fault.py — I re-ran the LV-earthing regression class, 170/170 pass); IEEE 1584-2002 equation layer digit-perfect (arcflash); duty-check factor tables (MV 2.5/2.6, LV n-ladder); IDMT constants and TCC grading topology logic; IEEE 80 grounding to 3-4 significant figures; dynamic motor starting physics and starter transforms; cable-sizing formulas and adiabatic constants.

**Neither reviewer covered (stated as gaps, not reviewed here):** `transient_stability.py` (1,780 lines), `harmonics.py`, `unbalanced_loadflow.py` (PS used it only as a cross-reference), the DC family (`dc_loadflow.py`, `dc_shortcircuit.py`, `dc_arcflash.py`), `network_reduction.py`, `admd.py`/`admd_data.py`, `backup_autonomy.py`, `lightning_risk.py`, `raceway.py`, numeric transcription fidelity in `pdf_reports.py`/report exports, `study_manager.py` orchestration consistency (e.g. whether batch runs propagate the same conventions), and frontend result-rendering correctness (annotations, lfstudy comparison tables). The stale-persisted-results behaviour (saved study verdicts restoring without recompute) is a known operational hazard that neither report ties to these findings: a PS-1-class fix will not correct verdicts already saved in project files.

## Consolidated remediation priority

| Rank | Finding(s) | Severity | Direction | Effort | Rationale |
|---|---|---|---|---|---|
| 1 | PS-1 | P1 | Bidirectional (non-conservative for arc flash & disconnection; conservative for duty) | L (Zbus) / S (interim radial-only guard + API warning) | Root of the dependency tree; +58% on routine topologies; ship the guard immediately, the Zbus properly |
| 2 | PS-2 | P1 | Non-conservative (fabricated Ik1) | S | Earth-fault protection validated against phantom current; gate exists as a pattern (utility branch) |
| 3 | EE-1 + EE-5 + EE-12 | P1 | Non-conservative (false "will start", dips understated) | M | One engine, three optimistic defects; EE-5/EE-12 are one-liners, EE-1 needs the Thevenin port — after rank 1 |
| 4 | EE-2 | P1 | Undefined (garbage converged result) | S (hard error) | Legal drawing → 0.0003 p.u. "converged"; refuse the topology now, Π-ratio later if wanted |
| 5 | PS-4 | P2 | Non-conservative (−11% incident energy) | S | Wrong number on a printed safety label; trivial fix |
| 6 | PS-3 | P2 | Non-conservative (compliance PASS on max current) | M | Needs an Ik1-min mode (c=0.95 + hot-R) + device-curve time check; compounds with PS-2 |
| 7 | PS-5 | P2 | Non-conservative (meshed ip −15%) | S | Making-duty understated; apply 1.15 with caps when multi-path |
| 8 | EE-4 | P2 | Non-conservative (secure verdict on total loss of load) | S-M | N-1 verdicts on dangling-load schematics are silently wrong |
| 9 | EE-3 | P2 | Wrong metric (losses ×2) | S | Corrupts the Study Manager's headline comparison |
| 10 | EE-6 | P2 | Conservative (false collapse) | S | One-line flag fix; wrong conclusion from legal input |
| 11 | PS-6 | P2 | Parameter-dependent ±2-5% | S-M | Standards deviation (K_G, R_G defaults) on generator studies |
| 12 | PS-8(b), PS-12 | P3 | Non-conservative labelling / phantom Z0 source | S | Port-forwarding one-liner (mirrors the cable-branch fix) + report 0 in ikLLG |
| 13 | EE-8, EE-9, PS-14(b), EE-14(fuse), PS-9, PS-16 | P3 | Mixed, mostly optimistic | S-M | Hardening + shared device-model consolidation |
| 14 | EE-7, EE-10, EE-11, EE-13, PS-7, PS-8(a,c), PS-10, PS-11, PS-13, PS-14(a,c), PS-15, EE-14(rest) | P3 | Mostly conservative / documentation | S each | Labelling, docs, report-assumption surfacing |

**Explicitly NON-CONSERVATIVE (unsafe direction):** EE-1, EE-5, EE-12 (motor-start acceptance), PS-2 (fabricated earth-fault current), PS-3 (disconnection compliance), PS-4 (incident energy), PS-5 (peak/making duty), PS-1 (for arc flash clearing and any minimum-current reasoning), PS-8(b), PS-9, PS-14(b), PS-16 (CT optimism), EE-4 (security verdict), EE-9 (cap Q at low V), EE-13 (transformer loading), EE-14 fuse-clearing bullet. **Conservative or neutral:** EE-3 (inflates losses), EE-6, EE-7 (labelling), PS-7, PS-10, PS-11, PS-13(b,c), PS-14(c), EE-14 voltage-drop bullet, PS-1 for withstand duty.

All recommended fixes are compatible with the pinned regression philosophy provided: (i) the PS-2 inverter-Z0 block and any EE-1 re-anchoring of `TestMotorStarting` are landed as deliberate, documented behaviour changes with new pinned hand-calculations; (ii) PS-5's 1.15 factor is gated on multi-path so `test_peak_factor_kappa` (radial) is untouched; (iii) every fix adds a standards-anchored regression case for the previously-unpinned behaviour, which is precisely the suite's design intent.

## Principal engineer sign-off statement

Both reviews are high quality: every one of the 30 findings verified as real — 28 CONFIRMED outright and 2 confirmed with only remarks (EE-6 severity is boundary-P2; PS-3's optimism is partially offset by the conservative 10×In proxy). All eight P1/P2 numerical demonstrations I re-ran reproduced exactly or in mechanism. No finding is rejected.

**What the tool can be relied on for today:** balanced load flow and voltage-drop studies on radial or lightly-meshed distribution networks with buses drawn at every transformer terminal; IEC 60909 fault studies on **radial, utility-fed** networks (verified to hand-calculation accuracy, including the genuinely sophisticated LV earthing-system and star-star Z0 modelling); IEEE 1584-**2002** arc flash on radial networks for non-cable equipment classes; equipment duty screening (with fault currents from radial studies); cable sizing per IEC 60364 (with explicit clearing-time overrides for fuse-protected runs); IEEE 80 grounding pre-design; dynamic motor starting on radial networks; TCC coordination screening ahead of manufacturer-curve grading.

**What must be fixed before further feature work:** the P1 block — PS-1 (or, minimum, a hard "radial only" guard that refuses parallel-path topologies rather than a console print), PS-2, EE-2, and the static motor-start cluster EE-1/EE-5/EE-12 — plus the two compliance-facing P2s, PS-3 and PS-4, because those two put optimistic numbers directly onto documents (arc-flash labels, SANS compliance reports) that carry professional liability. Until PS-1 lands, every fault-derived result on a drawing containing a ring, bus coupler, or duplicated feeder must be treated as invalid, and I would not sign a study from this tool on such a network. On radial utility-fed distribution work, with the P1/P2 list closed and the fixed conventions (c_max, t_min, n=1) printed as report assumptions, the calculation core is of signable screening-study quality — the formula-level engineering here is demonstrably more careful than in several commercial screening tools; the defects are concentrated one layer up, in network representation and result aggregation, and they are all tractable.
