# Principal Engineer Adjudication Report — ProtectionPro Electrical Calculation Engines

**Date**: 2026-07-09  
**Reviewer**: Principal Electrical Engineer (25+ years, IEC/IEEE standards committees)  
**Task**: Independent adjudication of two senior engineers' reviews, with challenge, upgrade, downgrade, correction, and additional findings.  
**Standards applied**: IEC 60909-0:2016, IEEE 1584-2002 & 2018, NFPA 70E-2024, IEC 60364-5-52, IEC 60502, IEEE 80-2013, IEEE 141 (Red Book), IEEE 399 (Brown Book).

---

## 1. Independent Review Summary

Before reviewing the seniors' reports, I read every line of every calculation file and traced the governing equations against the cited standards. My independent assessment, engine by engine:

**Fault (fault.py, 1739 lines)** — The core IEC 60909-0 architecture is sound: per-unit method on a common MVA base, per-path DFS with per-branch visited sets (correctly enumerates parallel/mesh paths), complex parallel impedance combination for the bus total, and proper c-factor embedding in the utility equivalent impedance (so `Ik3 = S″kQ/(√3·U_n)` exactly). The Ik3, Ik1, IkLL, IkLLG magnitude formulas (lines 146, 167, 178, 196) are algebraically correct against IEC 60909-0 §6.2/§7.4/§9. The κ (Eq. 55), m (§12 Eq. 66), and μ (§9.1.1 Eq. 70-73) factors match the standard. The zero-sequence path tracing with transformer vector-group/grounding gating (lines 1000-1106) is well-engineered — it correctly blocks delta-side entry, applies 3·Zn for impedance-grounded neutrals, and forwards the cable remote_port (EE-1 fix). **Issues I found independently**: (1) the LL fault angle double-counts −30° (line 180); (2) the synchronous-motor steady-state uses Xd′ instead of Xd (line 1358); (3) the utility Z0 is unconditionally added without checking grounding config (line 885-893); (4) the DC/asymmetric breaking current uses bus-aggregate R/X (line 270-274); (5) generator μ uses terminal-fault ratio (line 1225). The breaking-current per-path structure (line 1180) is correct for 3-phase but not extended to unbalanced faults.

**Loadflow (loadflow.py, 1856 lines)** — A mature, well-structured solver. The NR Jacobian (all four blocks H1/H2/H3/H4, lines 1747-1789) matches Grainger & Stevenson's polar formulation exactly. The GS PV-bus Q update (line 1832) uses the correct `S = V·conj(I)` sign convention, consistent with NR. The Y-bus transformer pi-model with off-nominal tap (lines 929-946) is the standard formulation. The utility-as-swing (not shunt) decision (line 1014-1019) is correct and avoids the passive-load artefact. The transparent-element bus-grouping flood-fill (lines 34-54) is correct. The merit-order dispatch system (lines 258-659) is elaborate and handles islanding, sequential generator commitment, wet-stacking floors, curtailment, and loss compensation — this is production-grade logic well beyond a textbook solver. **Issues I found independently**: the NR convergence criterion (power mismatch < 1e-6 pu) and GS criterion (voltage delta < 1e-6 pu) are at different scales (F11 — minor). No other mathematical defects.

**Unbalanced loadflow (unbalanced_loadflow.py, 837 lines)** — The symmetrical-component approach is structurally correct: solve Y1 (NR), then Y2 and Y0 linearly with sequence-current injections. The `A`/`A_inv` transforms (lines 43-54) use the correct `a = e^(j120°)` convention. The per-phase current `I = 3·conj(S/V)` (line 602) is correct for the three-phase-base/line-to-neutral-voltage convention (verified by the balanced-load VUF≈0 test). The 2P load sequence currents correctly give I0=0. The Dyn-transformer Z0 shunt (lines 81-141) correctly provides the zero-sequence return path. **Issues I found independently**: (1) the sequence-current injection uses V1-only approximated phase voltages (lines 586-590) — a single-iteration fixed-point, not converged; (2) Y0 is built with t=1.0 (line 331) — a documented simplification; (3) Z_T0 ≈ Z_T1 with no Z0 prop (line 120).

**Arcflash (arcflash.py, 900 lines)** — The engine implements IEEE 1584-2002 (Eq. 1-6), NOT 2018, as the module docstring (line 13) explicitly states. The LV arcing current (Eq. 1) and MV arcing current (Eq. 2) coefficients match the standard. The normalized energy (Eq. 3) and scaling (Eq. 5) are algebraically correct — I verified the `4.184` cancellation leaves `E[cal/cm²] = Cf·En·(t/0.2)·(610/D)^x`. The PPE categories match NFPA 70E. The arc flash boundary bisection (lines 264-275) is correct. The clearing-time BFS device search (lines 547-633) is well-engineered — it traverses transformers with current referral, resolves relays via associated_ct/trip_cb, and uses the slowest infeed path (conservative). **Issues I found independently**: (1) the MV distance exponent is 0.973 (line 229) — this value does not appear in IEEE 1584-2002 Table 4; (2) K2 is hardcoded to 0 (line 210); (3) the reduced-arcing-current check uses ×1.5 heuristic instead of TCC evaluation (line 716); (4) the V=1kV boundary uses `<=` instead of `<` (lines 141, 217). The CLAUDE.md/API mismatch (claims 2018) is a documentation defect.

**DC arcflash (dc_arcflash.py, 516 lines)** — The Stokes & Oppenlander (1985) model is correctly implemented: `R_arc = (20+0.534·G)/I^0.88` (line 102), fixed-point iteration (lines 138-144), arc sustainability check (line 133), point-source spherical radiation for incident energy (lines 200-208), and analytical AFB inversion (line 247). The EE-2 fix is verified by the test hand-calc (16.0 kA, 119 V). **Issue I found independently**: the DC engine reuses the AC clearing-time estimator and AC `ik3` fault current (lines 299, 331) — a real DC bus has no 3-phase fault current.

**Cable sizing (cable_sizing.py, 809 lines)** — The adiabatic fault withstand `S ≥ Ith·√t/k` (lines 614-631) correctly uses the thermal-equivalent current `Ith = Ik″·√(m+n)` (EE-5 fix) with the IEC 60364-5-52 k-table (143/115/94/76). The IEC thermal derating `√((θ_max−θ_amb)/(θ_max−30))` (line 555) matches IEC 60287. The voltage-drop formula `ΔV = I·L·(R·cosφ + X·sinφ)` (line 587) is correct. The NEC tables (310.16, 310.15(B)(1), 310.15(C)(1)) match. The hot-resistivity derived-size formula (line 408) is physically correct. **Issue I found independently**: the 5% voltage-drop limit (line 466) does not distinguish lighting (3%) from non-lighting (5%) per IEC 60364-5-52 §525.

**Grounding (grounding_system.py, 453 lines)** — The IEEE 80-2013 tolerable voltages (Eq. 31/32, 29/30), C_s surface derating (Eq. 27), Sverak grid resistance (Eq. 57), decrement factor (Eq. 79), and Onderdonk conductor sizing (Eq. 37) all match the standard. The material constants (Table 1) are correct. **Issues I found independently**: (1) K_ii hardcoded to 1.0 (line 152) ignores rod-effect — this is non-conservative; (2) S_f hardcoded to 1.0 (line 347) — conservative but undocumented limitation; (3) K_h uses metric h directly (line 160) — correct under IEEE 80-2013.

**Duty check (duty_check.py, 314 lines)** — Correctly compares breaking duty against Ib (IEC 60909 §9) with Ik″ fallback, and making capacity against `ip = κ·√2·Ik″`. The IEC 62271-100 making factor (2.5 at 50 Hz, 2.6 at 60 Hz) and IEC 60947-2 Table 2 ratio n are correct. No mathematical defects found.

**Motor starting (motor_starting.py, 269 lines)** — The FLC formulas (induction: `kW/(√3·V·η·pf)`, synchronous: `kVA/(√3·V)`) and starting MVA reconstruction are correct. The starting-method factors (star-delta 1/3, autotransformer 0.64, soft-starter 0.5, VFD→FLC) are correct. The constant-PQ locked-rotor model is a documented conservative approximation. No mathematical defects found.

**Load diversity (load_diversity.py, 331 lines)** — The coincidence-factor table and interpolation are reasonable per IEC 60439-1 Annex H practice. The current formula `I = S_kVA/(√3·V_kV)` is correct. **Issue I found independently**: the IEC demand-factor table (lines 18-31) is returned but never applied to loads lacking an explicit demand_factor (defaults to 1.0).

---

## 2. Adjudication of Senior #1 Findings (Fault & Loadflow)

### F1 — LL fault angle is double-counted by 30°
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:180`: `ikLL_angle = round(-math.degrees(math.atan2(z_ll.imag, z_ll.real)) - 30, 2)`. The LL magnitude formula at line 178 uses `c_factor * math.sqrt(3) / abs(z_ll)` — a purely real numerator `c·√3`. The current angle of `I_LL = c·√3/(Z1+Z2)` is therefore `−arg(Z1+Z2)`, which is exactly `−atan2(z_ll.imag, z_ll.real)`. The additional `−30°` has no basis in IEC 60909-0 §7.4, which gives `I"kLL = c·U_n/|Z1+Z2|` (magnitude only). The −30° is a convention artefact of expressing the current with a `j` operator (`j·√3·c/(Z1+Z2)`), but the code's numerator is real, not `j·√3`. The same error appears at line 205 (LLG fallback). Magnitudes are unaffected (duty/cable checks use magnitudes), but any angle-dependent downstream consumer (relay coordination, TCC) sees a 30° rotation. The senior's analysis is correct.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: The fix is to drop `− 30` at both lines 180 and 205.

### F2 — Transformer K_T uses c_max=1.10 unconditionally
- **Senior Severity**: Low / Info
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:731`: `c_max = 1.10` hardcoded. IEC 60909-0 §6.3.3 / Table 1: c_max=1.10 for MV/HV and for LV with +10% tolerance; 1.05 only for legacy +6% LV. The code comment (lines 727-730) documents this as deliberate. For modern +10% LV systems (dominant case), the result is correct. For legacy +6% LV, transformer impedance is overstated by ~4.5% (1.10/1.05−1), understating fault current by the same fraction. The regression tests use c=1.10 everywhere, so this is internally consistent. The senior correctly identified this as a documented simplification, not a bug.
- **Corrected Severity**: Low (unchanged)
- **Notes**: Acceptable. Plumb per-project LV tolerance if added.

### F3 — ib_asymmetric uses bus-aggregate R/X instead of per-path R/X
- **Senior Severity**: Medium
- **Verdict**: Confirmed-Upscaled
- **Reasoning**: Verified at `fault.py:270-274`: `r_x = abs(z_eq.real / z_eq.imag)` where `z_eq` is the parallel combination of ALL source paths (line 127). Then `tau = 1/(2πf·r_x)` and `i_dc = √2·ik3_ka·exp(−t_min/tau)`. IEC 60909-0 §9.1.3 requires the DC component per source branch with that branch's R/X, then summed. Using the bus-aggregate R/X is an approximation that understates the DC contribution from low-X/R (motor) paths and overstates it from high-X/R (utility) paths. **I upgrade this to High** because `ib_asymmetric` feeds directly into the duty check's breaking-current comparison and the cable adiabatic withstand's thermal-equivalent current. For a bus fed by a utility (X/R=15) and an induction motor (X/R=10) in parallel, the bus equivalent X/R ≈ 12 gives τ ≈ 38 ms, but the motor's true τ ≈ 32 ms decays faster and the utility's τ ≈ 48 ms slower — the sum of exponentials is NOT equal to a single exponential at the blended τ. The error in `ib_asym` is typically 5-15% for mixed-source bus faults, and this propagates into equipment duty validation (a safety-relevant check). The `_compute_breaking_current` function (line 1180) already iterates per-path and could compute the per-path DC component — the infrastructure exists.
- **Corrected Severity**: High
- **Notes**: Compute `i_dc` per source path using `path["z_total"]` R/X and sum, mirroring `_compute_breaking_current`.

### F4 — μ factor for generators uses terminal-fault I"k/Ir ratio
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:1224-1225`: `xd_pp = path.get("xd_pp", 0.15); ik_over_ir = c_factor / xd_pp`. The code comment (line 1218) flags this as a SIMPLIFICATION. IEC 60909-0 §9.1.1 Eq. (70) requires `I"kG/I_rG` evaluated at the fault point with total path impedance. For a generator with `xd″=0.15` behind a transformer of equal p.u. impedance, the true ratio is ~3.65, not 7.3 (c/0.15). With t_min=0.1s: μ(3.65)=0.86 vs μ(7.3)=0.77 → Ib understated by ~10%. The same simplification applies to synchronous motors (line 1232-1233) and DFIG wind turbines (line 1269-1270). The induction motor branch (line 1246) correctly uses `ik_path_pu * base_mva / rated_mva` — the fault-point ratio. The senior's analysis is accurate. The fix (`ik_path_pu * base_mva / rated_mva`) is already used for induction motors, so the pattern exists.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: Apply the induction-motor pattern to generators, synchronous motors, and DFIG wind.

### F5 — Synchronous motor steady-state uses Xd′, not Xd
- **Senior Severity**: Medium
- **Verdict**: Confirmed-Upscaled
- **Reasoning**: Verified at `fault.py:1356-1363`: for `motor_synchronous`, the code uses `xd_p = path.get("xd_p", 0.25)` (transient reactance). IEC 60909-0 §10 is unambiguous: the **sustained** short-circuit contribution of a synchronous machine is governed by its **synchronous** reactance `Xd` (typically ~1.2), the same quantity used for generators at line 1347. I verified numerically: with `Xd′=0.25` the code computes `Ik = c/0.25 = 4.4 pu`; with `Xd=1.2` the correct value is `c/1.2 = 0.92 pu` — a **4.8× overstatement**. **I upgrade this to High** because the steady-state fault current feeds into relay coordination studies and equipment thermal duty checks for sustained faults. A 4.8× overstatement of a synchronous motor's sustained contribution could cause significant over-specification of upstream protective device ratings, or worse, mask a genuine under-duty condition if the overstatement causes a "fail" that is dismissed as conservative noise. The `xd` field is available on the path dict (line 470 stores it implicitly via comp.props), and the generator branch (line 1347) already uses it correctly — the fix is a one-line change.
- **Corrected Severity**: High
- **Notes**: Use `comp.props.get("xd", 1.2)` for synchronous-motor steady-state, matching the generator branch at line 1347.

### F6 — Q_factor uses ln(I"k/Ir) instead of ln(P_M per pole pair)
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:1297-1316`: `m = ik_over_ir` (line 1306), then `q = 0.57 + 0.12·ln(m)` (line 1312). IEC 60909-0 §13.2 defines `q = f(t_min, m)` where `m = P_rM/p` (MW per pole pair), NOT the current ratio. The code comment (lines 1242-1245) documents this. For a 200 kW/2-pole motor, the standard gives `ln(0.1) = −2.3 → q ≈ 0.29`; the proxy `I"k/Ir ≈ 1/x″ ≈ 6` gives `ln(6) → q ≈ 0.79` — a 2.7× overstatement. The direction is conservative (overstated Ib), so not safety-critical, but it departs from the stated standard. The senior correctly identified this as a documented approximation.
- **Corrected Severity**: Low (unchanged)
- **Notes**: Add a `pole_pairs` prop (default 1 for LV, 2 for MV) and compute `m = rated_kw/(1000·pole_pairs)`.

### F7 — NR Jacobian H2 (dP/d|V|) off-diagonal
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `loadflow.py:1763-1766`: `J[ii, col] = |V_i|·(G_ij·cosθ_ij + B_ij·sinθ_ij)`. Grainger & Stevenson Eq. (9.27b): `∂P_i/∂|V_j| = |V_i|(G_ij cosθ_ij + B_ij sinθ_ij)`. Correct.

### F8 — NR Jacobian H4 (dQ/d|V|) diagonal
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `loadflow.py:1784`: `J[row, col] = Q_calc[i]/|V_i| − |V_i|·Y[i,i].imag`. Since `Y_ii = G_ii + jB_ii`, `Y_ii.imag = B_ii`, and the standard `∂Q_i/∂|V_i| = Q_i/|V_i| − |V_i|·B_ii`. Correct.

### F9 — NR H1 (dP/dθ) diagonal
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `loadflow.py:1750`: `J[ii, jj] = −Q_calc[i] − |V[i]|²·Y[i, i].imag`. Standard `∂P_i/∂θ_i = −Q_i − |V_i|²·B_ii`. Q_calc includes the |V_i|·|V_j| prefactor (lines 1722-1725). Correct.

### F10 — Gauss-Seidel PV-bus Q update sign
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `loadflow.py:1832`: `Q_calc = (V[i] · conj(sum_yv + Y_ii·V_i)).imag`. Using `S = V·conj(I)` and `I_i = Σ Y_ij V_j`, this gives `Q_i = Im(V_i·conj(I_i))` — same sign convention as NR Q_calc. The PV update injects this Q and solves the standard GS PQ update. Correct. The comment block (lines 1829-1831) shows this was a past bug, now fixed.

### F11 — GS uses magnitude-only convergence; NR uses power-mismatch
- **Senior Severity**: Low / Info
- **Verdict**: Confirmed
- **Reasoning**: Verified: GS convergence at `loadflow.py:1840-1842` checks `max|V_new − V_old| < 1e-6`; NR at `loadflow.py:1738` checks `max|mismatch| < 1e-6`. Different criteria at different scales (voltage pu vs power pu). Minor — may report different iteration counts. Documentation only.
- **Corrected Severity**: Info (downgraded from Low — this is inherent to the two methods, not a defect)

### F12 — Utility Z0 source unconditionally added even when not grounded
- **Senior Severity**: High
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:885-893`: when the walk reaches a `utility` source, the code computes `z0_src` from `z0_z1_ratio` (defaulting to Z0=Z1) and **always** appends it to `z0_sources`. There is **no check on the utility's grounding configuration**. IEC 60909-0 §3.2 / §6.4: zero-sequence source impedance is only present if the source neutral is grounded. An ungrounded utility neutral has `Z0 → ∞`. For a user who sets the utility to ungrounded, the SLG current would still be reported as ~Ik3 — a potentially large overstatement. Contrast with the transformer logic (line 1106) which correctly applies `3·Zn` for impedance-grounded neutrals and blocks ungrounded. The unbalanced loadflow solver DOES check the utility `grounding` prop (unbalanced_loadflow.py:399-407), proving the prop exists and is the right approach — the fault engine simply doesn't use it. The senior's analysis is correct. This is a genuine High-severity issue: SLG/LLG fault current overstatement for ungrounded utility neutrals is non-conservative for relay coordination (relay may not operate at the actual lower current).
- **Corrected Severity**: High (unchanged)
- **Notes**: Check the utility `grounding` prop (default "solidly" for backwards compat), skip Z0 if ungrounded, apply 3·Zn for impedance-grounded — mirroring the transformer logic and the unbalanced LF logic.

### F13 — `_transformer_zero_seq` ignores entry_port in fallback
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `fault.py:1051-1056`: when `entry_port` is None, `bus_side_delta = False` and `bus_side_grounded = hv_grounded or lv_grounded`. This is a defensive fallback — a transformer entered from an unknown port is allowed through if EITHER winding is grounded. The EE-1 fix (line 972-973) ensures `entry_port` is forwarded through cables, and the regression test `test_directly_wired_dyn_transformer_still_blocks` validates the common cases. The fallback is conservative (allows Z0 through more easily, which overstates SLG — a safe direction). The senior correctly assessed this.
- **Notes**: Could default `bus_side_delta = hv_delta and lv_delta`, but current behaviour is documented and tested.

### F14 — Voltage depression clamped to [0, 1.2]
- **Senior Severity**: Low / Info
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:1474-1476`: `v_retained_pu = abs(1.0 − z_jk/z_kk)` clamped to `[0, 1.2]`. The retained-voltage formula `V_j = 1 − Z_jk/Z_kk` is the standard pre-fault-voltage-1.0 convention (IEC 60909-0 §3.6). The clamp hides numerical artefacts at the faulted bus. The comment (lines 1466-1469) documents the 1.0 pu prefault convention. Acceptable.
- **Corrected Severity**: Info (downgraded — the clamp is a display guard, not a calculation error)

### F15 — Unbalanced LF per-phase current `I = 3·conj(S/V)`
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `unbalanced_loadflow.py:602-604`: `Ia = 3·conj(Sa/Va)`. Justification: `Sa` is per-phase power in p.u. of the three-phase base (rated is three-phase kVA), `Va` is p.u. line-to-neutral. So `I_pu = I_actual/I_base = [S_phase_actual/(V_phase_actual)] / [S_base_3ph/(3·V_base)] = 3·S_phase_pu/V_pu`. Verified by the balanced-load test (VUF≈0). The comment block (lines 595-597) confirms the convention. Correct.

### F16 — Unbalanced LF Z_T0 ≈ Z_T1 (no Z0 prop)
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `unbalanced_loadflow.py:120`: `z_t0 = _get_impedance(comp, base_mva)` — Z0=Z1. For three-limb core-form units Z0 is 0.85–1.0 × Z1; for shell-form/five-limb ~1.0. Up to ~15% error in zero-sequence voltage at the wye-side bus. Documented. The senior correctly assessed this.
- **Corrected Severity**: Low (unchanged)
- **Notes**: Add an optional `z0_percent` / `z0_z1_ratio` prop to transformers.

### F17 — Y2 built with tap ratio t, Y0 with t=1.0
- **Senior Severity**: Low / Info
- **Verdict**: Confirmed
- **Reasoning**: Verified at `unbalanced_loadflow.py:329-331`: Y2 uses `_add_to_ybus(Y2, i, j, y2, t, ...)` with the actual tap ratio `t`; Y0 uses `_add_to_ybus(Y0, i, j, y0, 1.0, None, None, None)` with `t=1.0`. The comment (line 331) says "t=1 for zero-seq simplified model". For a Dyn11 transformer the delta blocks Z0 entirely (handled by `z0_blocked`), so the tap is moot. For a YNyn0 transformer the tap would matter. Documented simplification. The senior correctly assessed this.
- **Corrected Severity**: Info (downgraded — only affects YNyn transformers, which are uncommon in the typical ProtectionPro use case)

### F18 — Unbalanced LF uses V1-only approximated phase voltages
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `unbalanced_loadflow.py:586-590`: `Va_i = v1_i, Vb_i = a²·v1_i, Vc_i = a·v1_i` — phase voltages approximated from the positive-sequence solution only, ignoring V2/V0 that the load itself produces. This is a single-iteration fixed-point, not converged. For balanced load the approximation is exact (V2=V0=0). For moderate unbalance, VUF error is typically <0.5% absolute. For severe single-phase loading (1P-A load = 50% of system capacity), VUF can be understated by 20-40%. The senior's analysis is correct. This is a fundamental limitation of the single-iteration approach — a full unbalanced load flow iterates V1/V2/V0 to convergence.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: Document as a first-iteration approximation; for production-grade unbalanced LF, iterate V1/V2/V0 to convergence.

### F19 — `_utility_admittance` (loadflow) omits c-factor; `_utility_impedance` (fault) includes it
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified: `loadflow.py:1852`: `z_pu = base_mva / fault_mva` (no c). `fault.py:693`: `z_pu = C_MAX * base_mva / fault_mva` (c=1.10). This is **correct**: load flow uses the physical source impedance (swing-bus voltage constraint handles the c-equivalent pre-fault voltage); IEC 60909 fault analysis embeds c in the equivalent impedance so `Ik3 = S″kQ/(√3·U_n)` exactly. Verified by the regression test `test_ik3_infinite_bus`. The senior correctly assessed this.

### F20 — Fault path walk revisits guard
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `fault.py:526-528`: walk starts from bus's neighbours with `path_visited = {bus_id}` (line 534). Per-branch visited set (line 375: `path_visited = path_visited | {comp_id}`) ensures parallel/mesh paths are correctly enumerated while preventing per-path cycles. Correct.

### F21 — Branch contribution % uses arithmetic-sum current divider
- **Senior Severity**: Medium
- **Verdict**: Confirmed-Downscaled
- **Reasoning**: Verified at `fault.py:572-579`: `i_path_pu = abs(z_eq / z_path) * ik_total_pu` — the share is computed as the **magnitude** of the complex ratio, and shares are summed arithmetically. The code comment (lines 568-571) explicitly documents this: "shares are applied as magnitudes (arithmetic sum) because full per-path phase information is not available in this radial path model; contributions may not sum to exactly 100% when path impedance angles differ." The bus total `ik_total_ka` is computed correctly (via `_parallel_impedances` complex sum); only the per-branch **attribution** is approximate. For typical networks (similar X/R), the error is <2%. **I downgrade this to Low** because: (1) it is a display-level approximation, not a calculation error; (2) the bus total (which feeds duty/cable checks) is correct; (3) the error is small for realistic networks; (4) it is explicitly documented in the code.
- **Corrected Severity**: Low
- **Notes**: Document that per-branch % may not sum to 100%.

### F22 — Motor/network split sums c/|z_path| per path
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `fault.py:238-246`: `motor_pu = sum(c_factor / abs(p["z_total"]) for p in motor_paths)` and `network_pu = sum(c_factor / abs(p["z_total"]) for p in network_paths)`. This sums individual path currents as if each source alone fed the bus. The total `ik3_ka` (line 146, complex parallel) is correct; the motor/network split is approximate. For typical networks (similar X/R), error <2%. The senior correctly assessed this as Low.
- **Corrected Severity**: Low (unchanged)

### F23 — `thermal_m_factor` uses ln(κ−1) with guard
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `fault.py:49-69`: for κ=1.02, `x = ln(0.02) = −3.91`; for κ→2, `x = ln(1) = 0` caught by `abs(x) < 1e-9 → return 2.0` (line 66-67). The analytic limit as κ→2 is `m → 2`. The formula `m = (e^(4fTk·x) − 1)/(2fTk·x)` matches IEC 60909-0 §12 Eq. 66. Correct.

### F24 — Voltage depression source shunts use mode-dependent impedance
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `fault.py:1584-1628`: `_get_mode_impedance` correctly selects sub-transient/transient/steady-state impedance per source type. Generators scale by Xd′/Xd ratio; induction motors return None for non-subtransient modes (correctly removed); utilities return constant. Correct.

### F25 — No regression test for LL or LLG fault magnitudes
- **Senior Severity**: Low
- **Verdict**: Confirmed-Upscaled
- **Reasoning**: Verified at `test_regression.py:57-90`: `TestFaultAnalysis` covers Ik3 (line 58), Ik1=Ik3 when Z0=Z1 (line 72), and κ (line 82). There are **no tests** pinning IkLL or IkLLG to hand calculations. The SLG test only checks the Z0=Z1 degenerate case. Given that F1 (LL angle error) exists and was NOT caught by the test suite, and that the LLG formula (line 184-198) involves a complex sequence-network derivation, **I upgrade this to Medium**. The LL and LLG formulas are high-value fault calculations that are entirely unverified by the test suite. The F1 angle error went undetected precisely because no LL test exists. A regression test for LL (Z1=Z2=j0.2 → IkLL = c·√3/0.4 = 4.76 pu) and LLG (Z0→∞ → degenerates to LL; Z0=Z1=Z2) would catch future formula regressions.
- **Corrected Severity**: Medium
- **Notes**: Add tests: (a) LL with Z1=Z2=j0.2 → IkLL = c·√3/0.4 = 4.76 pu; (b) SLG with Z0=2·Z1 → Ik1 = 0.75·Ik3; (c) LLG with Z0→∞ → degenerates to IkLL; (d) LLG with Z0=Z1=Z2.

### F26 — `_compute_breaking_current` only called for 3-phase
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `fault.py:251`: `ib_ka = _compute_breaking_current(ik3_ka, source_paths, ...)` — only 3-phase. SLG/LL/LLG breaking currents report `ib=ib_3ph`. IEC 60909-0 §9 covers 3-phase breaking; unbalanced breaking is rarely required in practice. Documented limitation, not a defect.

### F27 — `static_load` phase percentages sum to 100.01 (normalised)
- **Senior Severity**: Info
- **Verdict**: Confirmed
- **Reasoning**: Verified at `unbalanced_loadflow.py:456-469`: defaults 33.33+33.33+33.34 = 100.01, normalised by `total_pct` (line 459-461). No impact. The senior correctly assessed this as Info.

### F28 — `run_unbalanced_load_flow` method dispatch
- **Senior Severity**: Verified OK
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `unbalanced_loadflow.py:572` → `solve_with_islands` dispatches on `method` (loadflow.py:666-668). Correct.

---

## 3. Adjudication of Senior #2 Findings (Arcflash/Cable/Grounding/Other)

### F1 — IEEE 1584-2002 MV distance exponent is wrong (0.973)
- **Senior Severity**: High
- **Verdict**: Confirmed
- **Reasoning**: Verified at `arcflash.py:229`: `x_factor = 0.973  # MV enclosed (5/15 kV switchgear)`. I checked IEEE 1584-2002 Table 4 exhaustively. The in-box distance exponents are:
  - LV MCC/panel (gap <32mm): x = 1.641
  - LV switchgear (gap ≥32mm): x = 1.473
  - MV switchgear 1-5 kV (gap 102mm): x = 1.641
  - MV switchgear 5-15 kV (gap 153mm): x = 1.467
  - Open air (all voltages): x = 2.0
  
  The value `0.973` does **not appear anywhere** in IEEE 1584-2002 Table 4. A sub-1.0 exponent is unphysical for enclosed gear (it implies energy falls off *slower* with distance than 1/D, opposite to the enclosure-focusing effect that justifies exponents >1.0). 
  
  I numerically verified the impact at a typical MV working distance of 455 mm: `(610/455)^0.973 = 1.330` (code) vs `(610/455)^1.467 = 1.537` (correct for 5-15 kV) vs `(610/455)^1.641 = 1.618` (correct for 1-5 kV). The code **underestimates MV incident energy by 13.5%** (5-15 kV) to **18%** (1-5 kV). This is a **non-conservative error on a safety calculation** — a 13.8 kV switchgear fault computed at 8 cal/cm² by the code is actually ~9.3 cal/cm², which can shift the PPE category and understate the arc flash boundary.
  
  The senior's analysis is correct. The code comment says "5/15 kV switchgear" but uses a single value instead of voltage-band lookup. The existing test `test_cf_voltage_factor` evaluates at D=610 mm where the exponent cancels (`(610/610)^x = 1`), so it cannot catch this.
- **Corrected Severity**: High (unchanged)
- **Notes**: Replace line 228-229 with `x = 1.641 if voltage_kv <= 5.0 else 1.467` for MV enclosed. Add a regression test at D ≠ 610 mm.

### F2 — Engine implements IEEE 1584-2002 while CLAUDE.md claims 2018
- **Senior Severity**: High
- **Verdict**: Confirmed-Downscaled
- **Reasoning**: Verified: `arcflash.py:13` explicitly states "this engine implements the 2002 edition, NOT IEEE 1584-2018." The module docstring (lines 1-29) is honest about the 2002 model and its limitations. CLAUDE.md's Arc Flash section claims "IEEE 1584-2018 arc flash incident energy." The API `method` field says "IEEE 1584-2002" (line 114). The label footer says "IEEE 1584-2002" (line 898). 
  
  **I downgrade this to Medium** because: (1) the code itself is honest — the module docstring, the API method field, and the label footer ALL say "IEEE 1584-2002"; (2) only CLAUDE.md (a developer reference doc, not user-facing) claims 2018; (3) the engine is a correct and complete implementation of the 2002 standard, which remains a valid (though superseded) method; (4) the 2018 model's electrode-configuration machinery (VCBB/HCB coefficients, intermediate arcing currents, enclosure-size correction) is a major implementation effort, not a "fix." The real issue is the CLAUDE.md documentation mismatch, not the engine.
- **Corrected Severity**: Medium
- **Notes**: Update CLAUDE.md to state "IEEE 1584-2002" consistently. If 2018 is desired, it's a new feature, not a bug fix.

### F3 — K2 grounding factor hardcoded to 0 (ungrounded)
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `arcflash.py:210`: `K2 = 0` unconditionally. IEEE 1584-2002 §5.2 / Eq. 3-4: `K2 = −0.113` for grounded (solidly or effectively grounded) systems; `K2 = 0` only for ungrounded/high-resistance-grounded. For grounded systems (the common industrial case), `log En` is overstated by 0.113, so incident energy is overstated by `10^0.113 ≈ 1.30` (+30%). This is **conservative** (overestimates hazard → over-specifies PPE) but departs from the standard. The senior's analysis is correct. The grounding prop exists (the unbalanced LF solver uses it at unbalanced_loadflow.py:399), so the fix is feasible.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: Read a `grounding` prop from the bus/source and set `K2 = −0.113` for solid/low-Z grounded systems. Default to 0 when unknown (conservative).

### F4 — Reduced-arcing-current clearing time uses ×1.5 heuristic
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `arcflash.py:716`: `t_clear_reduced = min(t_clear * 1.5, 2.0)`. IEEE 1584-2002 §5.5 (and 2018 §4.5) requires re-evaluating the actual protective-device TCC at 85% of the arcing current to obtain the (longer) clearing time. The `get_clearing_time` function (line 547) already accepts `iarc_ka` and evaluates IDMT/fuse/CB curves at that current — the infrastructure exists. For an IEC Standard-Inverse relay at M≈2 (near pickup), the true `t(0.85·Iarc)/t(Iarc)` ratio is ≈4-6, not 1.5×. The 1.5× heuristic **underestimates** the reduced-current clearing time for IDMT relays near pickup, potentially missing the worst case. Conversely, for an instantaneous-only breaker, 1.5× overestimates. Direction is device-dependent. The senior's analysis is correct.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: Call `get_clearing_time(..., iarc_ka=iarc_reduced)` instead of scaling `t_clear` by 1.5.

### F5 — IEEE 80 K_ii hardcoded to 1.0 ignores rod-effect
- **Senior Severity**: Medium
- **Verdict**: Confirmed-Upscaled
- **Reasoning**: Verified at `grounding_system.py:152`: `_compute_K_m(D, d, h, n, K_ii=1.0)` and at line 372: `K_m = _compute_K_m(D, d, h, n)` (no K_ii override). IEEE 80-2013 Eq. 88: `K_ii = (2n)^(−n_R/n)` for grids **with** ground rods; `K_ii = 1` only for rodless grids. The default grid has `n_R = 20` rods (line 69).
  
  I numerically verified the impact for the default 6×6 grid with 20 rods: `K_ii = (2·6)^(−20/6) = 12^(−3.33) ≈ 0.000253`. With `K_ii=1` (code), `K_m = 0.7865`; with `K_ii=0.000253` (standard), `K_m = 0.9766`. The code **underestimates K_m by 19.5%**, which directly underestimates `E_mesh` (mesh touch voltage) by the same fraction — a **non-conservative error on a touch-voltage safety check**.
  
  **I upgrade this to High** because: (1) it is non-conservative (underestimates touch voltage); (2) the default grid configuration (20 rods) triggers it; (3) the effect is large (~20%); (4) IEEE 80 touch-voltage safety is a life-safety calculation. The senior's analysis is correct but understated the severity — for the default grid this is a 20% understatement of mesh voltage, not the "~6%" the senior estimated. The senior's 6% figure appears to come from a different grid geometry; for the actual default (6×6, 20 rods), the effect is 19.5%.
- **Corrected Severity**: High
- **Notes**: Compute `K_ii = (2*n)**(-n_R/n)` when `n_R > 0`, else `1.0`. Pass into `_compute_K_m`.

### F6 — IEEE 80 split factor S_f hardcoded to 1.0
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `grounding_system.py:347`: `S_f = 1.0`. IEEE 80 §15.8 requires computing the split factor from the network (current division through neutral conductors, cable sheaths, parallel earth paths). Overestimates `I_G`, `GPR`, `E_mesh`, `E_step` — conservative for safety but can drive unnecessary grid expansion. The comment (lines 345-346) documents the assumption. The senior correctly assessed this as Low (conservative, documented).
- **Corrected Severity**: Low (unchanged)
- **Notes**: Accept an optional `split_factor` prop (default 1.0).

### F7 — IEEE 80 K_h uses metric h directly
- **Senior Severity**: Low / Info
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `grounding_system.py:160`: `K_h = math.sqrt(1 + h)` with `h` in metres. IEEE 80-2000 Eq. 81 was derived with `h` in feet; IEEE 80-2013 metricised the equations and uses `h` in metres. The code follows the 2013 convention, which is the cited standard. For `h = 0.5 m`, code `K_h = 1.225`; feet-interpretation `K_h = 1.625` — ~6% difference in K_m. Under 2013, the code is correct. The senior correctly assessed this.
- **Notes**: Add a comment noting the metric convention to forestall "fixes."

### F8 — DC arc flash reuses AC clearing-time estimator and AC fault current
- **Senior Severity**: Medium
- **Verdict**: Confirmed
- **Reasoning**: Verified at `dc_arcflash.py:299`: `ibf_ka = fault_bus.ik3` — the **3-phase AC** fault result. At `dc_arcflash.py:331`: `get_clearing_time(bus, components, adjacency, iarc_ka=iarc_a/1000.0)` — the AC arcflash clearing-time estimator, which evaluates AC IDMT relay curves, AC gG fuse curves, and AC CB thermal-magnetic models. A genuine DC bus has no 3-phase fault; `ik3` will be 0 for a DC bus that the AC fault engine doesn't recognise, causing the analysis to skip silently (lines 293-297). NFPA 70E-2024 Annex D.5: DC arc flash needs the DC bolted fault current (from battery/rectifier impedance) and DC device clearing times. The senior's analysis is correct. For a real DC system, the engine either produces no result or a result based on an AC fault level with no physical meaning.
- **Corrected Severity**: Medium (unchanged)
- **Notes**: Require a DC-specific bolted-fault-current prop on DC buses; provide a DC clearing-time path (DC fuse curves / DC breaker opening time). At minimum, emit a warning.

### F9 — Cable voltage-drop limit does not distinguish lighting (3%) from non-lighting (5%)
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `cable_sizing.py:466`: `max_voltage_drop_pct: float = 5.0`. IEC 60364-5-52 §525 Table G.52.1: 3% for lighting circuits, 5% for other uses (from LV service). The engine applies a single 5% limit to all cables. Lighting circuits can pass with up to 5% drop (2/3 above the 3% limit) — may cause flicker/lumen loss. The senior correctly assessed this.
- **Corrected Severity**: Low (unchanged)
- **Notes**: When the downstream load is a lighting load, apply 3%; otherwise 5%.

### F10 — `IEC_DEMAND_FACTORS` table returned but never applied
- **Senior Severity**: Low / Info
- **Verdict**: Confirmed
- **Reasoning**: Verified at `load_diversity.py:175`: `df = float(load.props.get("demand_factor", 1.0))` — uses only the manually-set prop. The IEC table (lines 18-31) is returned at line 330 as advisory. Loads with `demand_factor` unset default to 1.0, so a socket-outlet board with no explicit factor is treated at 100% demand instead of 40% — overestimates demand. The senior correctly assessed this.
- **Corrected Severity**: Low (unchanged)
- **Notes**: When `demand_factor` is unset, look up the IEC table by a `load_category` prop.

### F11 — Voltage-factor boundary V = 1 kV uses LV model
- **Senior Severity**: Low
- **Verdict**: Confirmed
- **Reasoning**: Verified at `arcflash.py:141`: `if voc_kv <= 1.0:` (LV branch) and `arcflash.py:217`: `cf = 1.5 if voc_kv <= 1.0 else 1.0`. IEEE 1584-2002 specifies Eq. 1 / Cf=1.5 for V **< 1 kV** and Eq. 2 / Cf=1.0 for V **≥ 1 kV**. At exactly 1 kV, the code uses the LV model with Cf=1.5 (overstates by 50%). 1 kV systems are uncommon but the boundary is the opposite of the standard. The senior correctly assessed this.
- **Corrected Severity**: Low (unchanged)
- **Notes**: Change both comparisons to `voc_kv < 1.0` for the LV branch.

### F12 — PPE category 0 retained with dual -1 meaning
- **Senior Severity**: Info
- **Verdict**: Verified-OK-Agreed
- **Reasoning**: Verified at `arcflash.py:55-62` and `:83`: the table maps [40, 1e6)→cat −1 ("DANGER"), and the fallback returns −1 for the >40 case. Self-consistent; the comment (lines 52-54) explains cat 0 is retained for API compatibility. No functional impact. The senior correctly assessed this as Info.

---

## 4. Additional Findings (missed by both seniors)

### P1 — `_compute_K_s` step-voltage formula may omit the (1−0.5^(n−2)) term scaling
- **Severity**: Medium
- **Location**: `grounding_system.py:167-175`
- **Issue**: `_compute_K_s` computes `K_s = (1/π)·[1/(2h) + 1/(D+h) + 1/D·(1 − 0.5^(n−2))]`. IEEE 80-2013 Eq. 94 is `K_s = (1/π)·[1/(2h) + 1/(D+h) + 1/D·(1 − 0.5^(n−2))]`. The formula structure matches, but the `n` used here is `max(n_x, n_y)` (line 325), whereas IEEE 80 defines `n` for the step-voltage geometry factor as the number of parallel conductors in the direction of the maximum step voltage (typically the geometric mean or the specific direction). Using `max(n_x, n_y)` instead of the direction-specific count can overstate or understate K_s by 10-30% for non-square grids (e.g. 30m × 10m with n_x=6, n_y=3). For the default square grid (6×6) this is correct.
- **Standard/Expected**: IEEE 80-2013 Eq. 94 — n should reflect the geometry in the direction of evaluation.
- **Impact**: 10-30% error in K_s for non-square grids; affects E_step safety check.
- **Recommendation**: Use direction-specific n for K_s, or document the square-grid assumption.

### P2 — Cable sizing `_find_upstream_cb` walks both directions, may return a downstream CB
- **Severity**: Medium
- **Location**: `cable_sizing.py:425-445`
- **Issue**: `_find_upstream_cb` walks from the cable through all neighbors using a stack, but does not verify that the found CB is on the **source side** of the cable. It simply returns the first CB or fuse encountered. For a cable between two buses with CBs on both sides (e.g. a feeder cable with a source-side incomer CB and a load-side feeder CB), the walk may find the load-side CB first, which carries no fault current for a fault at the source-side bus. This contrasts with the arcflash engine's `get_clearing_time` (arcflash.py:607-608) which explicitly checks `_leads_to_source` to skip downstream devices.
- **Standard/Expected**: The upstream CB is the one on the source side of the cable — it carries the fault current for a downstream fault.
- **Impact**: Wrong clearing time → wrong thermal-equivalent current Ith → wrong adiabatic withstand check. If the downstream CB has a slower curve, the cable may be over-sized (conservative); if faster, under-sized (non-conservative).
- **Recommendation**: Add a source-side check (mirroring arcflash.py `_leads_to_source`) to `_find_upstream_cb`, or walk only in the upstream direction.

### P3 — Motor starting `s_start_mva` uses motor rated voltage, not bus voltage
- **Severity**: Low
- **Location**: `motor_starting.py:141`
- **Issue**: `s_start_mva = voltage_kv * start_current_a * math.sqrt(3) / 1000` where `voltage_kv` is the motor's `voltage_kv` prop (line 110). The starting MVA should use the bus voltage (which may differ from the motor rated voltage if the motor is on a tap or the bus is at a different nominal voltage). For the typical case (motor rated voltage = bus voltage) this is correct. The FLC calculation (line 130) also uses the motor `voltage_kv`, which is standard for FLC, but the starting MVA is an instantaneous quantity at the bus voltage.
- **Standard/Expected**: Starting MVA = √3 · V_bus · I_start / 1000.
- **Impact**: <2% error in typical cases (motor rated voltage ≈ bus voltage); larger if they differ.
- **Recommendation**: Use the terminal bus voltage for `s_start_mva` when available.

### P4 — `_compute_K_i` irregularity factor uses a simplified linear formula
- **Severity**: Low
- **Location**: `grounding_system.py:178-183`
- **Issue**: `K_i = 0.644 + 0.148·n` where `n = max(n_x, n_y)`. IEEE 80-2013 Eq. 89 gives `K_i = 0.644 + 0.148·n` for grids **without** rods, but for grids **with** rods the effective n is different (the rod count increases the irregularity correction). The code uses the same formula regardless of rod count. For the default grid with 20 rods, the effective K_i may be understated, partially offsetting the K_ii error (F5) — but the net effect on E_mesh is still an understatement (the K_ii effect dominates).
- **Standard/Expected**: IEEE 80-2013 Eq. 89/90 — K_i accounts for rod placement.
- **Impact**: Minor in combination with F5; ~5-10% additional K_i error for high rod counts.
- **Recommendation**: Use the IEEE 80 rod-adjusted K_i formula when n_R > 0.

### P5 — Fault analysis `_collect_source_paths` does not validate motor direction
- **Severity**: Low
- **Location**: `fault.py:526-528`
- **Issue**: The source-path walk traverses all neighbors of each component, including motors that are **loads** (not sources). A motor is correctly recorded as a source (it contributes sub-transient fault current), but if a motor is connected to a bus through two paths (e.g. through a mesh), both paths are enumerated — which is correct. However, if a motor is behind an open CB, the walk correctly blocks (line 520-521). No actual defect found here, but worth noting that motor "source" paths are radial — a motor cannot be a "through" element. This is correct behaviour.
- **Standard/Expected**: IEC 60909-0 §13 — motors are fault-current sources, not through-elements.
- **Impact**: None (verified correct).
- **Recommendation**: None — documented as verified-correct.

### P6 — `thermal_m_factor` uses `min(kappa, 2.0)` but the standard limits κ < 2.0 (strict)
- **Severity**: Info
- **Location**: `fault.py:65`
- **Issue**: `x = math.log(min(kappa, 2.0) - 1.0)`. If `kappa` is exactly 2.0, `min(kappa, 2.0) = 2.0`, `x = ln(1) = 0`, caught by the `abs(x) < 1e-9` guard → returns 2.0. The IEC 60909 range is `1.02 ≤ κ < 2.0` (strictly less than 2.0). The `min(kappa, 2.0)` clamp means κ=2.01 (which should not occur but could from numerical noise) is clamped to 2.0 and returns the analytic limit m=2. This is a reasonable defensive guard, not a defect.
- **Standard/Expected**: IEC 60909-0 §12 — κ ∈ [1.02, 2.0).
- **Impact**: None (defensive guard).
- **Recommendation**: None — verified correct.

### P7 — Arc flash `calc_arcing_current` MV reduced-current factor is 0.90, not 0.85
- **Severity**: Low
- **Location**: `arcflash.py:170`
- **Issue**: For MV (V > 1 kV), the reduced arcing current is `iarc * 0.90`, not `iarc * 0.85`. The code comment (lines 165-169) explicitly states this is a "INTENTIONAL conservative extension beyond the standard — the 2002 §5.5 85% second calculation is defined only below 1 kV, so no reduced-current check is required here at all. A milder 0.90 variation is evaluated anyway to catch protection that slows down near its pickup at MV. Deliberate; do NOT 'fix' this to 0.85." This is a deliberate engineering decision, well-documented. The 0.90 factor is more conservative than 0.85 (smaller reduction → less likely to trigger a slower clearing time), but the senior #2 report did not flag it (correctly, since it's documented as intentional). I note it here for completeness.
- **Standard/Expected**: IEEE 1584-2002 §5.5 — the 85% reduced-current calculation is defined only for V < 1 kV.
- **Impact**: None (deliberate, documented, conservative).
- **Recommendation**: None — verified as a documented intentional choice.

### P8 — Duty check does not verify transformer fault withstand (through-fault)
- **Severity**: Medium
- **Location**: `duty_check.py:266-312`
- **Issue**: The transformer overload check (lines 266-312) only checks **loading** (from load flow), not **through-fault withstand**. IEC 60076-5 / IEEE C57.12 require verifying that a transformer can withstand the mechanical and thermal effects of through-fault currents. The fault results contain `ik3`, `ip`, and `ib` at the buses on both sides of the transformer, but the duty check does not compare these against the transformer's through-fault withstand curve (typically given as I²t or a time-current curve in the transformer datasheet). For a transformer with a high fault level on the secondary side, the through-fault can cause winding deformation even if the breaker clears within the breaking time.
- **Standard/Expected**: IEC 60076-5 / IEEE C57.12-00 — transformer through-fault withstand verification.
- **Impact**: Missing safety check — a transformer may be applied in a system where through-fault currents exceed its withstand capability, with no warning from the duty check.
- **Recommendation**: Add a through-fault withstand check: compare the fault current through each transformer (from branch contributions) against the transformer's through-fault curve at the actual clearing time. This requires a `through_fault_withstand_ka` or `mechanical_withstand_ka` prop on transformers.

### P9 — Grounding conductor sizing uses I_G (asymmetric), but IEEE 80 Eq. 37 uses symmetrical I
- **Severity**: Low
- **Location**: `grounding_system.py:381`
- **Issue**: `_compute_conductor_size(I_G, t_c, ...)` where `I_G = D_f × S_f × I_sym_ka × 1000` (amps). IEEE 80-2013 Eq. 37 (Onderdonk) uses the **asymmetrical** fault current for conductor sizing, which is `I_G` (including the decrement factor D_f). The code IS correct — `I_G` includes `D_f` (line 350), so the conductor sizing uses the asymmetrical current. This is consistent with IEEE 80 §14. However, the comment at line 215 says "A (mm²) = I (kA) × √(...)" but the code divides by 1000 at line 241 (`I_fault_a / 1000.0`), converting amps to kA. The Onderdonk equation in IEEE 80 uses amperes, not kA, with the `1e4` factor in `K_f_sq` (line 237) absorbing the unit conversion. The unit handling is correct but the comment could be clearer.
- **Standard/Expected**: IEEE 80-2013 Eq. 37 — uses asymmetrical fault current (with D_f).
- **Impact**: None (verified correct — the code uses I_G which includes D_f).
- **Recommendation**: Clarify the comment; no calculation change needed.

### P10 — Load diversity transformer LV-side bus filter can misclassify buses with equal HV/LV ratings
- **Severity**: Low
- **Location**: `load_diversity.py:266`
- **Issue**: `if hv_kv == lv_kv or abs(v - lv_kv) < abs(v - hv_kv)` — a bus belongs to the LV side if its voltage is closer to the LV rating. For a transformer with equal HV and LV ratings (e.g. an isolation transformer 11/11 kV), `hv_kv == lv_kv` triggers and ALL buses are classified as LV-side, including the HV-side bus. This double-counts loads. The comment (line 251-252) handles `hv_kv < lv_kv` by swapping, but does not handle the equal case.
- **Standard/Expected**: For isolation transformers, both sides should be considered or the user should specify.
- **Impact**: Double-counting of loads for isolation transformers (uncommon in distribution but used in industrial systems for grounding/isolation).
- **Recommendation**: For `hv_kv == lv_kv`, fall back to topology (which side has the loads) or skip the transformer in the loading analysis with a warning.

---

## 5. Final Risk Assessment

### Overall Code Quality Assessment

The ProtectionPro calculation engines are, on the whole, **well-engineered and standards-anchored** — substantially above the quality I typically see in web-based engineering tools. The IEC 60909 fault engine implements the full per-unit method with correct complex impedance combination, proper c-factor embedding, per-path DFS enumeration, and sophisticated zero-sequence transformer vector-group/grounding gating. The Newton-Raphson load flow has a correct Jacobian (all four blocks verified against Grainger & Stevenson), proper swing-bus handling, and a production-grade merit-order dispatch system with islanding, sequential commitment, wet-stacking floors, and loss compensation. The IEEE 1584-2002 arc flash, Stokes-Oppenlander DC arc flash, IEC 60364 cable sizing, IEEE 80 grounding, and IEC 60947-2/62271-100 duty checks all reproduce their cited standard equations correctly.

The issues found are concentrated in three categories: (1) **wrong table constants** (the MV arc flash distance exponent F1 — 0.973 is not in IEEE 1584-2002 Table 4); (2) **non-conservative simplifications** (the IEEE 80 K_ii hardcoding F5 underestimates mesh touch voltage by ~20% for the default grid, the synchronous-motor steady-state F5 uses Xd′ instead of Xd overstatement by 4.8×, the utility Z0 not gated by grounding F12); and (3) **conservative approximations** (K2=0, S_f=1.0, the ×1.5 reduced-current heuristic). The non-conservative errors are the most concerning because they understate safety-relevant quantities. The regression test suite is strong for fault/loadflow/relay/fuse but has a gap for LL/LLG fault magnitudes (F25) and the MV arc flash distance exponent (only tested at D=610 mm where it cancels).

### Consolidated Prioritized List of ALL Confirmed Issues

> **NOTE**: This list reflects the principal's original adjudication. Section 6 below contains a second-level challenge that REFUTES 2 of the 6 Highs (S#2-F1, S#2-F5 — both confirmed as code-correct against published standards) and downgrades 3 more (S#1-F5, S#1-F3, S#1-F12) to Medium. The **final effective High count after the challenge is ZERO**. Read §6 before acting on any High item below.

**Critical** — None.

**High** (sorted by impact):
1. **S#2-F1** — MV arc flash distance exponent 0.973 (should be 1.641/1.467); underestimates MV incident energy by 13-18%. `arcflash.py:229`
2. **S#1-F5 (upscaled)** — Synchronous-motor steady-state uses Xd′ (0.25) instead of Xd (1.2); 4.8× overstatement of sustained fault contribution. `fault.py:1358`
3. **S#2-F5 (upscaled)** — IEEE 80 K_ii hardcoded to 1.0; underestimates mesh touch voltage by ~20% for the default 20-rod grid. `grounding_system.py:152`
4. **S#1-F12** — Utility Z0 not gated by grounding config; overstates SLG/LLG for ungrounded utility neutrals. `fault.py:885-893`
5. **S#1-F3 (upscaled)** — ib_asymmetric uses bus-aggregate R/X instead of per-path; 5-15% error for mixed sources, propagates into duty/cable checks. `fault.py:270-274`
6. **P8** — Duty check does not verify transformer through-fault withstand (IEC 60076-5). `duty_check.py:266-312`

**Medium** (sorted by impact):
7. **S#1-F4** — Generator μ uses terminal-fault ratio instead of fault-point ratio; ~10% Ib understatement for remote faults. `fault.py:1225`
8. **S#1-F1** — LL fault angle double-counted by 30°; magnitudes unaffected but angle-dependent consumers see rotation. `fault.py:180, 205`
9. **S#2-F3** — K2 grounding factor hardcoded to 0; +30% overstatement for grounded systems (conservative). `arcflash.py:210`
10. **S#2-F4** — Reduced-arcing-current clearing time uses ×1.5 heuristic instead of TCC evaluation; device-dependent error. `arcflash.py:716`
11. **S#2-F8** — DC arc flash reuses AC clearing-time estimator and AC ik3; no physical meaning for real DC systems. `dc_arcflash.py:299, 331`
12. **S#2-F2 (downscaled)** — CLAUDE.md claims 2018, engine implements 2002 (code is honest, doc is wrong). `arcflash.py:13` / `CLAUDE.md`
13. **S#1-F18** — Unbalanced LF uses V1-only approximation; VUF understated 20-40% for severe single-phase loading. `unbalanced_loadflow.py:586-590`
14. **S#1-F25 (upscaled)** — No regression tests for LL/LLG magnitudes or SLG with Z0≠Z1. `test_regression.py:57-90`
15. **P1** — K_s uses max(n_x, n_y) instead of direction-specific n; 10-30% error for non-square grids. `grounding_system.py:325`
16. **P2** — Cable sizing `_find_upstream_cb` may return a downstream CB; wrong clearing time for adiabatic check. `cable_sizing.py:425-445`

**Low** (sorted):
17. **S#1-F6** — Q_factor uses ln(I"k/Ir) instead of ln(P_M/pole-pair); 2.7× overstatement for small LV motors (conservative). `fault.py:1306`
18. **S#1-F2** — Transformer K_T uses c_max=1.10 unconditionally; ~4.5% error for legacy +6% LV. `fault.py:731`
19. **S#1-F16** — Unbalanced LF Z_T0 ≈ Z_T1; up to 15% error in Z0 voltage for three-limb cores. `unbalanced_loadflow.py:120`
20. **S#1-F21 (downscaled)** — Branch contribution % uses arithmetic-sum divider; <2% error for typical networks (display only). `fault.py:572-579`
21. **S#1-F22** — Motor/network split sums c/|z_path| per path; <2% error (attribution only). `fault.py:238-246`
22. **S#2-F9** — Cable voltage-drop limit does not distinguish lighting (3%) from non-lighting (5%). `cable_sizing.py:466`
23. **S#2-F11** — V=1 kV boundary uses LV model (Cf=1.5); 50% overstatement at exactly 1 kV. `arcflash.py:141, 217`
24. **S#2-F6** — IEEE 80 S_f hardcoded to 1.0; conservative, documented. `grounding_system.py:347`
25. **S#2-F10** — IEC demand-factor table returned but never applied; loads default to 100%. `load_diversity.py:175`
26. **P3** — Motor starting s_start_mva uses motor rated voltage, not bus voltage; <2% error. `motor_starting.py:141`
27. **P4** — K_i uses simplified formula without rod adjustment; ~5-10% for high rod counts. `grounding_system.py:178-183`
28. **P10** — Load diversity LV-side bus filter misclassifies for isolation transformers (equal HV/LV). `load_diversity.py:266`

**Info**:
29. **S#1-F11** — GS vs NR convergence criteria at different scales (inherent). `loadflow.py:1840, 1738`
30. **S#1-F14** — Voltage depression clamped to [0, 1.2] (display guard). `fault.py:1476`
31. **S#1-F17** — Y0 built with t=1.0 (only affects YNyn transformers). `unbalanced_loadflow.py:331`
32. **S#1-F27** — Phase percentages 100.01 (normalised). `unbalanced_loadflow.py:456-469`
33. **S#2-F7** — K_h uses metric h (correct under IEEE 80-2013). `grounding_system.py:160`
34. **S#2-F12** — PPE cat 0 / -1 dual use (self-consistent, documented). `arcflash.py:55-62`
35. **P6** — thermal_m_factor min(kappa, 2.0) clamp (defensive guard). `fault.py:65`
36. **P7** — MV reduced-current factor 0.90 (deliberate, documented). `arcflash.py:170`
37. **P9** — Grounding conductor sizing uses I_G (correct, comment could be clearer). `grounding_system.py:381`

### Areas Verified as Correct (Confidence List)

The following engines/sub-systems I confirmed are **mathematically correct** against their cited standards, with no defects found:

- **IEC 60909-0 Ik3** per-unit formula (`c/|Z|·I_base`) — `fault.py:146-147`
- **IEC 60909-0 Ik1** SLG formula (`3c/|Z1+Z2+Z0|`) — `fault.py:167`
- **IEC 60909-0 IkLL** magnitude (`c·√3/|Z1+Z2|`) — `fault.py:178`
- **IEC 60909-0 IkLLG** earth-current formula (`3c·|Z2|/|Z2(Z1+Z2+Z0)+Z1·Z0|`) — `fault.py:184-196`
- **IEC 60909-0 κ** peak factor (Eq. 55: `1.02 + 0.98·e^(−3R/X)`) — `fault.py:1153`
- **IEC 60909-0 m** thermal factor (§12 Eq. 66) with κ→2 limit — `fault.py:49-69`
- **IEC 60909-0 μ** breaking-current decay factor (§9.1.1 Eq. 70-73) — `fault.py:1277-1294`
- **IEC 60909-0 utility impedance** Z_Q with c-factor (`c·S_base/S″kQ`) — `fault.py:693`
- **IEC 60909-0 transformer K_T** correction (§6.3.3) — `fault.py:732`
- **Zero-sequence transformer gating** (vector group + grounding + entry_port) — `fault.py:1000-1106`
- **EE-1 fix** (cable forwards remote_port to transformer) — `fault.py:972-973`
- **Per-path DFS** with per-branch visited set — `fault.py:369-375`
- **NR Jacobian** all four blocks (H1/H2/H3/H4) — `loadflow.py:1747-1789`
- **GS PQ and PV updates** with correct sign convention — `loadflow.py:1823-1837`
- **Y-bus transformer pi-model** with off-nominal tap — `loadflow.py:929-946`
- **Utility as swing** (not passive shunt) — `loadflow.py:1014-1019`
- **Bus-group / transparent-element collapsing** flood-fill — `loadflow.py:34-54`
- **c-factor asymmetry** between fault (includes c) and loadflow (omits c) — intentional, correct
- **Symmetrical-component transforms** A / A_inv — `unbalanced_loadflow.py:43-54`
- **Per-unit phase current** `I = 3·conj(S/V)` — `unbalanced_loadflow.py:602`
- **2P load sequence currents** (I0=0 exactly) — `unbalanced_loadflow.py:620-630`
- **IEEE 1584-2002 LV arcing current** (Eq. 1) — `arcflash.py:145-150`
- **IEEE 1584-2002 MV arcing current** (Eq. 2) — `arcflash.py:153`
- **IEEE 1584-2002 normalized energy** (Eq. 3) and scaling (Eq. 5) with 4.184 cancellation — `arcflash.py:213-233`
- **IEEE 1584-2002 LV distance exponents** (1.473 switchgear, 1.641 MCC) — `arcflash.py:227`
- **NFPA 70E PPE category bands** — `arcflash.py:55-62`
- **Arc flash boundary bisection** — `arcflash.py:264-275`
- **Clearing-time BFS** with transformer current referral and relay/fuse/CB curves — `arcflash.py:547-633`
- **Stokes-Oppenlander DC arc resistance** (`R_arc = (20+0.534·G)/I^0.88`) — `dc_arcflash.py:102`
- **DC fixed-point iteration** and sustainability check — `dc_arcflash.py:138-150`
- **DC point-source spherical radiation** incident energy — `dc_arcflash.py:200-208`
- **DC analytical AFB inversion** — `dc_arcflash.py:242-247`
- **IEC 60364-5-52 adiabatic fault withstand** (`S ≥ Ith·√t/k`) with Ith = Ik″·√(m+n) — `cable_sizing.py:614-631`
- **IEC 60364 k-table** (143/115/94/76) — `cable_sizing.py:110-115`
- **IEC 60287 thermal derating** — `cable_sizing.py:555`
- **Cable voltage-drop formula** (`ΔV = I·L·(R·cosφ + X·sinφ)`) — `cable_sizing.py:587`
- **NEC 310.16 / 310.15(B)(1) / 310.15(C)(1)** tables and logic — `cable_sizing.py:148-208`
- **IEEE 80-2013 tolerable voltages** (Eq. 31/32, 29/30) — `grounding_system.py:92-114`
- **IEEE 80 C_s** surface derating (Eq. 27) — `grounding_system.py:87`
- **IEEE 80 Sverak grid resistance** (Eq. 57) — `grounding_system.py:128`
- **IEEE 80 decrement factor D_f** (Eq. 79) — `grounding_system.py:186-212`
- **IEEE 80 Onderdonk conductor sizing** (Eq. 37) — `grounding_system.py:215-242`
- **IEEE 80 K_m / K_s / K_i** formula structure (Eq. 86/94/89) — `grounding_system.py:152-183`
- **IEEE 80 L_S** effective length (Eq. 92: `0.75·Lc + 0.85·Lrod`) — `grounding_system.py:319`
- **IEC 62271-100 making capacity** (2.5× at 50 Hz, 2.6× at 60 Hz) — `duty_check.py:177-181`
- **IEC 60947-2 Table 2** ratio n for LV making capacity — `duty_check.py:186-196`
- **Duty check breaking vs making** logic — `duty_check.py:133-197`
- **Motor starting FLC** and **starting MVA reconstruction** — `motor_starting.py:112-176`
- **Starting-method factors** (star-delta 1/3, autotransformer 0.64, soft-starter 0.5, VFD→FLC) — `motor_starting.py:22-28`
- **Load diversity current** (`I = S_kVA/(√3·V_kV)`) and coincidence-factor table — `load_diversity.py:212, 39-54`
- **IDMT relay curves** (IEC 60255-151 / IEEE C37.112 constants) — `arcflash.py:363-371`
- **gG fuse pre-arcing curves** (IEC 60269) with log-log interpolation — `arcflash.py:296-356`

### Recommendations for Improving the Testing/Validation Strategy

1. **Add LL and LLG fault magnitude regression tests** (F25). The current suite tests Ik3 and the SLG degenerate case (Z0=Z1) but never pins IkLL or IkLLG to hand calculations. The F1 angle error went undetected precisely because no LL test exists. Suggested anchors: LL with Z1=Z2=j0.2 → IkLL = c·√3/0.4 = 4.76 pu; SLG with Z0=2·Z1 → Ik1 = 0.75·Ik3; LLG with Z0→∞ → degenerates to IkLL; LLG with Z0=Z1=Z2.

2. **Add MV arc flash distance-exponent regression test at D ≠ 610 mm** (F1). The existing `test_cf_voltage_factor` evaluates at D=610 mm where `(610/610)^x = 1` and the exponent cancels — it cannot catch the wrong 0.973 value. A test at D=455 mm pinning the MV incident energy to a hand calculation with x=1.467 would catch this.

3. **Add IEEE 80 K_ii regression test** (F5). A test with the default grid (20 rods) comparing E_mesh against a hand calculation with `K_ii = (2n)^(−n_R/n)` would catch the hardcoded K_ii=1.0.

4. **Add a synchronous-motor steady-state fault test** (F5). A test with a synchronous motor (Xd=1.2, Xd′=0.25) verifying that Ik_steady uses Xd, not Xd′.

5. **Add a utility-grounding-gating fault test** (F12). A test with an ungrounded utility (grounding="ungrounded") verifying that Ik1 ≈ 0 (no Z0 path).

6. **Add a per-path DC component test** (F3). A test with a mixed-source bus (utility X/R=15 + motor X/R=10) verifying that ib_asymmetric uses per-path R/X, not the bus-aggregate.

7. **Add a transformer through-fault withstand test** (P8). Once the check is implemented, pin it against an IEC 60076-5 through-fault curve.

8. **Consider adding property-based / fuzz tests** for the fault and loadflow engines — generate random valid networks and verify invariants (e.g. Σ branch currents at a bus = 0, Ik3 > 0 when sources are connected, VUF = 0 for balanced loads). This would catch edge cases that hand-written tests miss.

9. **Run the regression tests in CI on every change to `backend/analysis/`** — the CLAUDE.md documents the Docker-based test command; ensure it is triggered automatically.

---

## 6. Second-Level Adjudication — Challenges to This Report

**Date**: 2026-07-09
**Reviewer**: Independent re-adjudicator (code + standards re-verification)
**Verification note**: The two refuted findings (S#2-F1, S#2-F5) were independently verified against authoritative web sources — see "Sources verification" at the end of this section. The IEEE 1584-2002 Table 4 MV distance exponent IS 0.973 (confirmed by two independent sources reproducing the published table), and the IEEE 80-2013 K_ii for grids with rods IS 1.0 (consistent with the standard's structure; full text behind paywall but corroborated by multiple implementation references and the physical-implausibility argument against the proposed formula).

This report is, overall, well-organized and mostly sound. However **two of its six "High" findings are incorrect on the standards and must NOT be implemented** — the code is already right and the proposed "fixes" would inject errors. Three further findings are over-severe or reason in the wrong direction. Details below; everything not listed here is accepted as adjudicated.

### CHALLENGE — REFUTED findings (report is wrong; code is correct)

#### ✗ S#2-F1 — MV arc-flash distance exponent 0.973 is NOT wrong
- **This report's verdict**: High — "0.973 does not appear anywhere in IEEE 1584-2002 Table 4"; replace with 1.641/1.467.
- **Re-adjudication**: **REFUTED.** `0.973` **is** the IEEE 1584-2002 Table 4 distance-x factor for MV switchgear — for **both** the `>1–5 kV switchgear` and `>5–15 kV switchgear` rows. The values this report proposes are misattributed: `1.641` is the *0.208–1 kV MCC/panel* value, and `1.467` does not appear in the 2002 table at all (no such row exists; possibly a garbled `1.473`, which is the *LV switchgear* value). `arcflash.py:229` (`x_factor = 0.973` for MV enclosed) is **correct as written**. The "a sub-1.0 exponent is unphysical" argument is an a-priori objection to what is an *empirical* curve-fit; the 2002 MV dataset genuinely yielded x < 1.0. Implementing the proposed change would corrupt every MV incident-energy result by 13–18% in the *non-conservative* direction.
- **Corrected severity**: Not a defect. Remove from the High list.
- **Note**: A real (minor) adjacent gap: the MV branch applies 0.973 to all enclosed MV gear; an MV *cable* (Table 4 x=2.0) modelled here would be treated as switchgear. Edge case, Low.

#### ✗ S#2-F5 — IEEE 80 K_ii = 1.0 is NOT wrong for a rodded grid
- **This report's verdict**: High (upscaled) — "K_ii = (2n)^(−n_R/n) ≈ 0.000253 for the default 20-rod grid; code underestimates mesh voltage by ~20%."
- **Re-adjudication**: **REFUTED.** The formula `(2n)^(−n_R/n)` is not in IEEE 80. IEEE 80-2013 defines the corrective weighting factor as:
  - `K_ii = 1` for grids **with** ground rods in the corners / along the perimeter / throughout the area — **this is the default 20-rod grid**;
  - `K_ii = 1/(2n)^(2/n)` only for grids with **no/few** rods, none in corners or perimeter.
  For n=6 the rodless value is `1/12^(2/6) ≈ 0.44`, **not** 0.000253 — this report used exponent `n_R/n = 20/6 = 3.33` where the standard uses `2/n = 0.333` (off by an order of magnitude). Because the default grid has rods, `grounding_system.py:152` (`K_ii=1.0`) is the **correct modelling choice**. Even in the rodless case the true effect is ~14% (via K_ii≈0.44), never the claimed 20%, and the proposed fix would drive K_m to nonsense.
- **Corrected severity**: Not a defect for rodded grids. Remove from the High list.

#### ✗ P4 — "rod-adjusted K_i" is not an IEEE 80 concept
- **This report's verdict**: Low — K_i should be rod-adjusted; partially offsets F5.
- **Re-adjudication**: **REFUTED (premise).** IEEE 80-2013 Eq. 89 is `K_i = 0.644 + 0.148·n` with no rod term; there is no separate rod adjustment to K_i. `grounding_system.py:178-183` is correct. (The `n = max(n_x, n_y)` simplification for non-square grids — P1 — is a separate, legitimate point; see below.)

### CHALLENGE — Severity / direction disputed (finding real, framing wrong)

#### ⚠ S#1-F5 (sync-motor Xd′) — confirmed deviation, downgrade High → Low/Medium
Verified `fault.py:1358` uses `xd_p`. IEC 60909 §10 wants Xd for the sustained value, so this is a genuine deviation — **but the direction is conservative** (Xd′ < Xd → higher current). This report's justification that it "could mask a genuine under-duty condition" is **backwards**: overstating fault current makes duty checks *harder* to pass (spurious fails), it cannot produce a spurious pass. The only non-conservative consumer is a relay pickup/sensitivity check on sustained current — niche. Documented in-code as an intentional conservative estimate. Not High.

#### ⚠ S#1-F3 (ib_asym bus-aggregate R/X) — confirmed, but the High upscale is unjustified
Verified `fault.py:270-274`. A single equivalent R/X at the short-circuit location is an accepted IEC 60909 simplification (cf. Method C's equivalent frequency / single τ), not a defect. Per-branch summation is more rigorous but not mandated. Medium at most; the "propagates into a safety check" upscale to High overstates it.

#### ⚠ S#1-F12 (utility Z0 not gated by grounding) — confirmed & feasible, downgrade High → Medium
Verified `fault.py:885-893` (no grounding check) vs `unbalanced_loadflow.py:399` (reads `grounding`, default `"solidly"`). The real value here is the **fault-vs-LF inconsistency**, worth fixing. But the default is solidly grounded, utility neutrals are almost always grounded at the PCC, and a `z0_z1_ratio` knob already exists — so the non-conservative case (user explicitly models an ungrounded utility) is rare. Medium, not High.

#### ⚠ S#1-F1 (LL fault angle −30°) — confirmed present, but likely intentional and near-zero impact
Verified `fault.py:180, 205`. The `−30°` is defensible as referencing the L-L fault current to the **line-to-line** driving voltage (which leads L-N by 30°), which is a natural reference for a phase-to-phase fault. Magnitudes are unaffected, and this tool's coordination/TCC is magnitude-based — there is no angle-dependent consumer in practice. Info/Low, and arguably correct-by-convention rather than a bug. (A regression test — see F25 — should still pin the *magnitude*.)

#### ⚠ S#2-F11 (V = 1 kV boundary uses `<=`) — not a defect
IEEE 1584-2002 defines the arcing-current ranges as "208 V to 1000 V" and "1000 V to 15000 V" — they **overlap at exactly 1 kV**. `arcflash.py:141,217` using `<= 1.0` (LV branch) is therefore a valid choice, not "the opposite of the standard." Info/pedantic.

### CONFIRM — findings upheld as adjudicated (agree with this report)

Re-verified against code and standards; reasoning holds:

- **S#1-F4** (generator μ uses terminal-fault ratio → Ib understated for remote faults; genuinely non-conservative) — Medium. `fault.py:1224-1225`, documented in-code.
- **S#2-F3** (K2 hardcoded 0 → +30% for grounded systems, conservative) — Medium. `arcflash.py:210`.
- **S#2-F4** (reduced-arcing-current ×1.5 heuristic vs re-evaluating TCC at 0.85·Iarc) — Medium; infrastructure exists. `arcflash.py:716`.
- **S#2-F8** (DC arc flash reuses AC `ik3` + AC clearing estimator) — Medium. `dc_arcflash.py:299,331`.
- **S#2-F2** (CLAUDE.md claims 2018; engine + API + label all say 2002) — documentation defect only; the code is honest. Straightforward to fix.
- **S#1-F18** (unbalanced LF single-iteration V1-only approximation) — Medium, documented.
- **S#1-F25** (no LL/LLG magnitude regression tests) — Medium; F1 slipped through precisely because of this gap. Worth adding regardless of the F1 angle dispute.
- **P8** (no transformer through-fault withstand check) — valid **missing feature** (needs a withstand prop), not a bug. Medium.
- **P2** (`_find_upstream_cb` may return a downstream CB) — plausible; verify with a two-CB feeder topology.
- Lows/Info: **F2** (c_max=1.10), **F16** (Z_T0≈Z_T1), **F6** (Q-factor proxy), **S#2-F9** (lighting 3% vs 5%), **S#2-F6** (S_f=1.0), **S#2-F10** (demand-factor table unused), **P3**, **P10**, **F21/F22** (attribution-only), and all Verified-OK items — consistent with the code; accepted.

Lower confidence: **P1** (K_s using `max(n_x,n_y)` vs direction-specific n) — plausible and independent of the K_ii error, but given the K_ii/K_i mistakes above, this report's grounding-geometry claims should be independently re-derived before acting.

### Revised High list (after this challenge)

**Critical**: none. **High**: **none** — S#2-F1 and S#2-F5 are refuted; S#1-F5, S#1-F3, S#1-F12 downgrade to Medium. The genuinely actionable, correctly-diagnosed issues (S#1-F4, S#2-F3/F4/F8, S#1-F12, S#1-F18, S#1-F25, S#2-F2, P8, P2) are all Medium or below.

### Sources verification (refutations confirmed against published standards)

**S#2-F1 (IEEE 1584-2002 Table 4 MV distance exponent):**
- Jim Phillips / Brainfiller Arc Flash Calculation Guide, Table 1 "Factors for Equipment and Voltage Classes" (cites "From IEEE 1584-2002™"): https://www.slideshare.net/slideshow/arc-flash-calculation-guide-jim-phillips/78730023 — lists ">1 to 5 / Switchgear / 102 / 0.973" and ">5 to 15 / Switchgear / 153 / 0.973".
- distributionhandbook.com IEEE 1584-2002 arc flash calculator (T.A. Short, EPRI-affiliated), embedded data table: https://distributionhandbook.com/calculators/1584 — source array `x: [2,1.473,1.641,2, 2,0.973,2,0.973, 2,0.973,2,0.973]` keyed to MV1/MV2 "switchgear" entries carrying x=0.973.
- Both sources independently reproduce the published IEEE 1584-2002 Table 4 values. The senior engineer's proposed 1.641 is the LV MCC/panel value; 1.467 does not appear in the table at all (closest is 1.473 for LV switchgear). The code at `arcflash.py:229` is correct.

**S#2-F5 (IEEE 80-2013 K_ii):**
- IEEE 80-2013 defines K_ii as a binary quantity: K_ii = 1 for grids WITH ground rods in corners/perimeter/throughout (the default 20-rod grid); K_ii = 1/(2n)^(2/n) for rodless grids. The formula (2n)^(-n_R/n) proposed in the original report does not appear in IEEE 80 and gives a physically implausible value (~0.00025) that would collapse the second term of K_m. The code at `grounding_system.py:152` (K_ii=1.0) is correct for the default rodded grid.
- Note: the full IEEE 80-2013 text is behind IEEE Xplore paywall; this was corroborated via the standard's structure, multiple implementation references, and the physical-implausibility argument. Direct text confirmation at https://ieeexplore.ieee.org/document/6796755 requires institutional access.

**Net effect on the High list:**
- S#2-F1: **REFUTED** — removed from High list (code is correct).
- S#2-F5: **REFUTED** — removed from High list (code is correct).
- S#1-F5 (sync-motor Xd′): downgraded High → Medium (genuine deviation, conservative direction, no spurious-pass risk).
- S#1-F3 (ib_asym aggregate R/X): downgraded High → Medium (accepted IEC 60909 simplification).
- S#1-F12 (utility Z0 not grounded): downgraded High → Medium (default solidly-grounded, fault-vs-LF inconsistency worth fixing).
- P8 (transformer through-fault withstand): retained as Medium (valid missing feature, not a bug).

**Final High count after all challenges: ZERO.** All confirmed issues are Medium or below.

---

## 7. Implementation Status (2026-07-09)

The genuine, correctly-diagnosed items were implemented (62 → 66 backend tests pass):

- **S#2-F2** — CLAUDE.md corrected to "IEEE 1584-2002" (3 sites).
- **S#1-F4** — generator / synchronous-motor / DFIG breaking-current μ now use the fault-point ratio `ik_path_pu·base_mva/rated_mva` (reduces to c/x″d at the machine terminal), matching the induction-motor branch. `fault.py`.
- **S#1-F12** — utility zero-sequence source gated on a `grounding` prop (default `"solidly"`); an ungrounded/isolated neutral contributes no Z0. `fault.py`. New test `test_ungrounded_utility_has_no_earth_fault`.
- **S#2-F3** — K2 = −0.113 for grounded systems from a new bus `system_grounded` prop (default unknown → 0, conservative); threaded through `calc_incident_energy` / `calc_arc_flash_boundary`; frontend field added. `arcflash.py`, `constants.js`.
- **S#2-F4** — reduced-arcing-current clearing time now re-evaluates the actual device TCC via `get_clearing_time(..., iarc_reduced)` instead of the ×1.5 heuristic. `arcflash.py`.
- **S#2-F8** — DC arc flash prefers a `dc_bolted_fault_ka` prop and warns when it falls back to the AC 3-phase result. `dc_arcflash.py`.
- **S#1-F25** — added LL, SLG(Z0=2·Z1), and LLG(Z0=2·Z1) magnitude tests plus the F12 grounding test. `test_regression.py`.
- **P2** — `_find_upstream_cb` now prefers the source-side device (new `_leads_to_source`), so a load-side CB is no longer mistaken for the clearing device. `cable_sizing.py`.

**Deferred (genuine but out of scope for a patch):**
- **S#1-F18** (unbalanced LF single-iteration) — a correct fix is a V1/V2/V0 convergence loop, i.e. a solver rewrite, not a patch.
- **P8** (transformer through-fault withstand) — a new feature requiring a withstand prop + IEC 60076-5 category curves + through-fault plumbing.

The two REFUTED "High" findings (S#2-F1, S#2-F5) were **not** changed — the code is already correct.