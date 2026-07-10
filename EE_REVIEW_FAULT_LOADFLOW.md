# Electrical Calculation Engine Review — ProtectionPro
## Senior Engineer #1 — Fault & Loadflow Engines

## Scope

Files reviewed in full:
1. `/root/protectionpro/backend/analysis/fault.py` — IEC 60909 short-circuit (1739 lines)
2. `/root/protectionpro/backend/analysis/loadflow.py` — NR & GS power flow (1856 lines)
3. `/root/protectionpro/backend/analysis/unbalanced_loadflow.py` — symmetrical-component unbalanced LF (837 lines)
4. `/root/protectionpro/backend/tests/test_regression.py` — standards-anchored regression tests (703 lines)
5. `/root/protectionpro/backend/tests/test_fault_dc_fixes.py` — EE-1/EE-2 audit fixes (174 lines)

Context reference: `/root/protectionpro/CLAUDE.md`.

## Verification Method

- Hand-traced the per-unit algebra for Ik3, Ik1, IkLL, IkLLG against IEC 60909-0 §6.2 (Eq. 15), §7.4 (Eq. 22), §9 (Eq. 70–73), §12 (Eq. 85), §13.
- Verified the NR Jacobian block structure against the standard polar-form formulation (Grainger & Stevenson, "Power System Analysis").
- Verified GS PV-bus reactive update sign convention against the NR Q_calc convention used in the same file.
- Verified the symmetrical-component transforms `A` and `A_inv` and the sequence-network interconnections for SLG/LL/LLG.
- Cross-checked the EE-1 cable→transformer port-tracing fix by tracing the recursive `walk` for a Dyn11 transformer entered from the HV side through a cable.
- Confirmed numerically the formula identities (3·c/|Z| for SLG, S_kQ/(√3·U_n) for Ik3, κ(X/R=15)=1.8224) with a small Python script.

## Findings

### F1 — LL fault angle is double-counted by 30°
- **Severity**: Medium
- **Location**: `fault.py:180` and `fault.py:205`
- **Issue**: For the line-to-line fault, the angle is reported as `-atan2(Z.imag, Z.real) - 30` (degrees). The `-30°` is meant to reflect the phase shift of the line-to-line fault current relative to the `a`-phase reference, but it is applied on top of an impedance-angle that, in the per-unit convention used, already gives the current angle. The current `I_LL = c·√3/(Z1+Z2)` (purely real `c·√3` numerator) has angle `−arg(Z1+Z2)`, which is exactly what `atan2(z_ll.imag, z_ll.real)` (negated) produces. There is **no extra −30°** in the line-to-line fault current magnitude/angle formula when the numerator is taken as `c·√3` (real). The −30° would only belong if the current were expressed as a complex quantity `j·√3·c/(Z1+Z2)` (i.e. using the `j` operator for the 90° phase shift between line and phase voltages). Mixing the magnitude-only `c·√3/|Z|` formula with an angle that includes `−30°` is inconsistent: the magnitude already contains the `√3` factor, so the angle must be the pure impedance angle.
- **Standard/Expected**: IEC 60909-0 §7.4 — `I"kLL = c·U_n / |Z1 + Z2|` (line-to-line, magnitude). Phase angle (if reported) = `−arg(Z1+Z2)`. The −30° phase shift is a convention artefact of choosing which line is the reference; it is not part of the IEC magnitude equation.
- **Impact**: A 30° error in the reported LL-fault current angle. Magnitudes are unaffected, so duty/cable-sizing checks (which use magnitudes) are safe, but any downstream consumer that uses the angle (e.g. relay coordination plots in `tcc.js`) will see a 30° rotation. The LLG fallback at line 205 has the same issue.
- **Recommendation**: Drop the `− 30` term; report `−atan2(z_ll.imag, z_ll.real)` as the LL fault angle, or document explicitly that the −30° is a specific reference-phase convention. Same for line 205.

### F2 — Transformer impedance correction factor K_T applied with wrong-side c_max for HV-side faults
- **Severity**: Low / Info (documented as deliberate)
- **Location**: `fault.py:727–732`
- **Issue**: `_transformer_impedance` applies the IEC 60909-0 §6.3.3 impedance correction `K_T = 0.95·c_max / (1 + 0.6·x_T)` with `c_max = 1.10` unconditionally. The standard selects `c_max` from the **nominal voltage of the side where the fault is calculated** (IEC 60909-0 Table 1: `c_max=1.10` for MV/HV and for LV with +10% tolerance; `1.05` only for legacy +6% LV). The code comment acknowledges this is a deliberate simplification (lines 727–730) and notes there is no per-project tolerance setting.
- **Standard/Expected**: IEC 60909-0 §6.3.3 — `K_T` uses the `c` of the **fault-side** voltage level. For a fault on the HV side of a HV/MV transformer the code is correct (c=1.10). For a fault on the LV side of a +6% tolerance system (legacy LV, c=1.05) the factor is slightly high.
- **Impact**: For modern +10% LV systems (the dominant case) the result is correct. For legacy +6% LV the transformer impedance is overstated by ~4.5% (1.10/1.05 − 1), understating fault current by the same fraction. The code's own regression tests use `c=1.10` everywhere, so this is internally consistent.
- **Recommendation**: Acceptable as documented. If per-project LV tolerance is added later, plumb that value here instead of the hard-coded `1.10`.

### F3 — ib_asymmetric uses bus-aggregate R/X instead of per-path R/X
- **Severity**: Medium
- **Location**: `fault.py:270–274`
- **Issue**:
  ```
  r_x = abs(z_eq.real / z_eq.imag)         # this is R/X, not X/R
  tau = 1 / (2 * math.pi * freq * r_x)    # τ = 1/(2πf·(R/X)) = X/(2πf·R) — OK
  ```
  The variable is named `r_x` but the formula `τ = 1/(2πf·(R/X))` is in fact correct (it equals `X/(2πf·R)`), so the time constant is right. **However**, the DC component is computed as
  ```
  i_dc = sqrt(2) * ik3_ka * exp(-t_min/tau)
  ```
  using `ik3_ka` (the **symmetrical r.m.s.** I"k3) as the DC amplitude. The real defect is that `τ` is computed from the **equivalent bus impedance** `z_eq` (the parallel combination of all source paths), not from the per-path R/X. IEC 60909-0 §9.1.3 / IEEE C37.010 compute the DC component per-source and combine; using the bus equivalent R/X understates the DC contribution from low-X/R (motor) paths and overstates it from high-X/R (utility) paths because the parallel impedance is dominated by the lowest-X/R branch.
- **Standard/Expected**: IEC 60909-0 §9.1.3 — DC component `i_dc,t = √2·I"k·exp(−2πf·t·R/X)` evaluated **per source branch** with that branch's R/X, then summed. The bus-aggregate `R/X` is an approximation, not the standard method.
- **Impact**: For a bus fed by a utility (X/R=15) and an induction motor (X/R=10) in parallel, the bus equivalent X/R ≈ 12, giving τ ≈ 38 ms. The motor's true τ ≈ 32 ms decays faster, the utility's τ ≈ 48 ms slower; the sum of exponentials is not equal to a single exponential at the blended τ. Error in `ib_asym` is typically 5–15% for mixed-source bus faults.
- **Recommendation**: Compute `i_dc` per source path (the source_paths list already carries per-path `z_total`) and sum, mirroring the structure of `_compute_breaking_current`.

### F4 — μ factor for generators uses terminal-fault I"k/Ir ratio, not the fault-point ratio
- **Severity**: Medium
- **Location**: `fault.py:1217–1226` (and 1229–1235 for sync motors)
- **Issue**: The code itself flags this as a SIMPLIFICATION (line 1218). For a generator behind external impedance, μ should use `I"kG/IrG` evaluated at the **fault point** with the **total path impedance** (IEC 60909-0 §9.1.1). The code instead uses `c_factor / xd_pp`, which is the ratio for a bolted fault **at the generator terminals**, ignoring the external cable/transformer impedance in the path. This overstates `I"k/IrG`, which (because μ decreases with increasing ratio) **understates** μ and therefore understates Ib for remote generator faults.
- **Standard/Expected**: IEC 60909-0 §9.1.1, Eq. (70) — the ratio is `I"kG/I_rG` where `I"kG` is the generator's contribution to the actual fault.
- **Impact**: For a generator with `xd″=0.15` feeding through a transformer of equal p.u. impedance, the true ratio is ~3.65, not 7.3. With t_min=0.1 s: μ(3.65)=0.86 vs μ(7.3)=0.77 → Ib understated by ~10%.
- **Recommendation**: Replace `c_factor / xd_pp` with `ik_path_pu * base_mva / rated_mva` (the actual per-unit current the generator pushes into the fault, scaled to its own base) — the same form already used correctly for induction motors at line 1246.

### F5 — Steady-state current Ik for synchronous motors uses transient reactance Xd′, not synchronous Xd
- **Severity**: Medium
- **Location**: `fault.py:1356–1363`
- **Issue**: For `motor_synchronous` steady-state, the code uses `xd_p` (transient reactance). A synchronous motor's **sustained** short-circuit contribution is governed by its **synchronous** reactance `Xd` (the same quantity used for generators at line 1347). Using `Xd′` (typically ~0.25 vs `Xd`~1.2) overstates the motor's steady-state fault current by ~5×.
- **Standard/Expected**: IEC 60909-0 §10 — steady-state short-circuit current for synchronous machines uses `Xd` (synchronous reactance). The `xd` field is already present on the motor path dict (line 471 stores `xd` implicitly via `comp.props`), so the data is available.
- **Impact**: For a 500 kVA sync motor with `Xd″=0.15, Xd′=0.25, Xd=1.2`: Ik_steady is computed as `c/0.25 = 4.4` pu instead of `c/1.2 = 0.92` pu — a ~4.8× overstatement of the sustained fault contribution.
- **Recommendation**: Use `comp.props.get("xd", 1.2)` for synchronous-motor steady-state, matching the generator branch.

### F6 — Q_factor uses ln(I"k/Ir) as the argument, but the standard uses ln(P_M per pole pair)
- **Severity**: Low (documented as approximation)
- **Location**: `fault.py:1297–1316`
- **Issue**: The code itself documents this (lines 1242–1245). IEC 60909-0 §13.2 defines `q` as a function of `m = rated active power per pole pair` (MW/pole-pair), not the current ratio `I"k/Ir`. The motor pole count is not modelled in ProtectionPro, so the current ratio is used as a proxy. For 2-pole LV motors (the common case) `m ≈ P_rM/2`, and the proxy `I"k/Ir` ≈ `1/x″ ≈ 6` for a typical motor gives `q ≈ 0.57 + 0.12·ln(6) = 0.79` at t_min=0.1 s, vs the standard's `q = 0.57 + 0.12·ln(P_M/2)`. For a 200 kW/2-pole motor the standard gives `ln(0.1) = −2.3` → q ≈ 0.29; the proxy gives 0.79 — a ~2.7× overstatement of the motor's breaking-current contribution.
- **Standard/Expected**: IEC 60909-0 §13.2 — `q = f(t_min, m)` with `m = P_rM/p` (MW per pole pair).
- **Impact**: Motor breaking-current contribution overstated for small LV motors; conservative (overstated Ib), so not safety-critical but departs from the stated standard.
- **Recommendation**: Add a `pole_pairs` prop to motor components (default 1 for LV, 2 for MV) and compute `m = rated_kw/(1000·pole_pairs)`.

### F7 — NR Jacobian H2 (dP/d|V|) sign on the off-diagonal
- **Severity**: Verified OK (after detailed trace)
- **Location**: `loadflow.py:1757–1766`
- **Issue examined**: For off-diagonal `J[ii, col] = |V_i|·(G_ij·cosθ_ij + B_ij·sinθ_ij)`. The standard polar Jacobian H2 (also called J12) off-diagonal element is `|V_i|·(G_ij cosθ_ij + B_ij sinθ_ij)`. Verified correct.
- **Standard/Expected**: Grainger & Stevenson, Eq. (9.27b): `∂P_i/∂|V_j| = |V_i|(G_ij cosθ_ij + B_ij sinθ_ij)`. **Verified OK.**

### F8 — NR Jacobian H4 (dQ/d|V|) diagonal uses +Y_ii.imag where the standard form has −B_ii
- **Severity**: Verified OK
- **Location**: `loadflow.py:1784`
- **Issue examined**: Diagonal element `J[row,col] = Q_calc[i]/|V_i| − |V_i|·Y[i,i].imag`. Since `Y_ii = G_ii + jB_ii`, `Y_ii.imag = B_ii`, and the standard `∂Q_i/∂|V_i| = Q_i/|V_i| − |V_i|·B_ii`. **Verified OK.**

### F9 — NR H1 (dP/dθ) diagonal: `−Q_calc[i] − |V_i|²·Y_ii.imag`
- **Severity**: Verified OK
- **Location**: `loadflow.py:1750`
- **Issue examined**: Standard `∂P_i/∂θ_i = −Q_i − |V_i|²·B_ii`. Verified the code's convention: the Jacobian operates on the mismatch vector `[dP; dQ]` and the update is `θ += dx` and `|V| += dx`. With `Q_calc` already including the |V|² factor (line 1722–1725 builds Q_calc with the |V_i|·|V_j| prefactor), the diagonal `−Q_calc[i] − |V_i|²·B_ii` is the standard form. **Verified OK.**

### F10 — Gauss-Seidel PV-bus Q update sign
- **Severity**: Verified OK (this was a likely hot-spot — the comment block at 1829–1831 shows it was a past bug)
- **Location**: `loadflow.py:1832–1835`
- **Issue examined**: `Q_calc = (V_i · conj(sum_yv + Y_ii·V_i)).imag`. Using `S = V·conj(I)` and `I_i = sum Y_ij V_j`, this gives `Q_i = Im(V_i·conj(I_i))` which is the same sign convention as the NR `Q_calc`. The PV update then injects this Q as `S_spec = (P_spec, Q_calc)` and solves `V_i = (1/Y_ii)·(conj(S_spec)/conj(V_i) − sum_yv)`, which is the standard GS PQ update. **Verified OK.**

### F11 — GS uses magnitude-only convergence; NR uses power-mismatch convergence
- **Severity**: Low / Info
- **Location**: `loadflow.py:1840–1842` (GS) vs `1737–1738` (NR)
- **Issue**: GS convergence checks `max|V_new − V_old| < 1e-6`; NR checks `max|mismatch| < 1e-6`. These are different criteria at different scales (voltage pu vs power pu), so the two solvers may report different iteration counts and may stop at slightly different points for the same problem.
- **Recommendation**: Documentation only.

### F12 — Zero-sequence: utility Z0 source unconditionally added even when not grounded
- **Severity**: High
- **Location**: `fault.py:885–893`
- **Issue**: In `_collect_zero_seq_impedances`, when the walk reaches a `utility` source, the code computes `z0_src` from the `z0_z1_ratio` prop (defaulting to Z0=Z1) and **always** appends it to `z0_sources`. There is **no check on the utility's grounding configuration**. A utility with an ungrounded or impedance-grounded neutral would still contribute a full Z0 path here.
- **Standard/Expected**: IEC 60909-0 §3.2 / §6.4 — zero-sequence source impedance is only present if the source neutral is grounded (solidly or via impedance). An ungrounded utility neutral has `Z0 → ∞` (no SLG/LLG path).
- **Impact**: For a utility with `z0_z1_ratio=1.0` (the default in the test helper `_utility_bus_project`), `Ik1 = Ik3` is enforced by the test `test_slg_equals_3ph_when_z0_equals_z1`. If a user sets the utility to ungrounded, the SLG current would still be reported as ~Ik3, a potentially large overstatement. The same applies to LLG.
- **Recommendation**: Check the utility `grounding` prop (with a sensible default of solidly grounded for backwards compatibility) and skip the Z0 contribution if ungrounded; apply `3·Zn` for impedance-grounded neutrals (mirroring the transformer logic at `fault.py:1106`).

### F13 — `_transformer_zero_seq` ignores `entry_port` when determining bus_side for the fallback case
- **Severity**: Verified OK (defensive fallback is conservative)
- **Location**: `fault.py:1051–1056`
- **Issue examined**: When `entry_port` is None, the code sets `bus_side_delta = False` and `bus_side_grounded = hv_grounded or lv_grounded`. This means a transformer entered from an unknown port will be allowed through if EITHER winding is grounded. However, the EE-1 fix (`fault.py:972–973`) ensures the `entry_port` is forwarded through cables. Regression test `test_directly_wired_dyn_transformer_still_blocks` confirms the common cases work.
- **Recommendation**: Defensive — could default `bus_side_delta = hv_delta and lv_delta`, but the current behaviour is documented and tested.

### F14 — Voltage depression uses `1.0 − Z_jk/Z_kk` but Zbus is built without the c-factor, then the result is clamped to [0, 1.2]
- **Severity**: Low / Info
- **Location**: `fault.py:1454–1488`
- **Issue**: The retained-voltage formula `V_j = 1 − Z_jk/Z_kk` is the standard pre-fault-voltage-1.0 convention. The clamp to [0, 1.2] hides numerical artefacts at the faulted bus.
- **Standard/Expected**: IEC 60909-0 §3.6 — retained voltage during fault uses the pre-fault voltage (typically 1.0 pu) minus the impedance-ratio drop.
- **Recommendation**: Acceptable. Document the 1.2 clamp as a display guard.

### F15 — Unbalanced LF: per-phase current `I = 3·conj(S/V)` — the `3` factor
- **Severity**: Verified OK (the comment block at 595–597 confirms the convention)
- **Location**: `unbalanced_loadflow.py:602–604`
- **Issue examined**: `Ia = 3·conj(Sa/Va)`. Justification: `Sa` is per-phase power in p.u. of the **three-phase** base (because `P_phase` is built as `rated·pf/base_mva`, where `rated` is the three-phase kVA). Phase voltage `Va` is p.u. line-to-neutral. So `I_pu = I_actual/I_base = [S_phase_actual/(V_phase_actual)] / [S_base_3ph/(3·V_base)] = 3·S_phase_pu/V_pu`. **Verified OK.**

### F16 — Unbalanced LF: zero-sequence shunt from Dyn transformers uses Z_T0 ≈ Z_T1 (no Z0 prop)
- **Severity**: Low (documented)
- **Location**: `unbalanced_loadflow.py:120`
- **Issue**: `z_t0 = _get_impedance(comp, base_mva)` — Z0=Z1 is a reasonable default only when Z0 is unknown. For three-limb core-form units Z0 is 0.85–1.0 × Z1; for shell-form/five-limb ~1.0.
- **Impact**: Up to ~15% error in zero-sequence voltage at the wye-side bus of a three-limb transformer.
- **Recommendation**: Add an optional `z0_percent` / `z0_z1_ratio` prop to transformers.

### F17 — Unbalanced LF: Y2 built with tap ratio `t` (line 330) but Y0 with `t=1.0` (line 331)
- **Severity**: Low / Info (documented as simplified)
- **Location**: `unbalanced_loadflow.py:329–331`
- **Issue**: Zero-sequence Y0 is built with `t=1.0` "simplified model". For a Dyn11 transformer the delta blocks Z0 entirely (handled by `z0_blocked`), so the tap is moot there. For a YNyn0 transformer the tap would matter.
- **Recommendation**: Acceptable for the simplified model; could use `t` for Y0 too if precision is required.

### F18 — Unbalanced LF: I2_inj and I0_inj use approximated phase voltages (V1 only), not the iterated solution
- **Severity**: Medium
- **Location**: `unbalanced_loadflow.py:586–590`
- **Issue**: The sequence-current injections from unbalanced loads are computed using `Va_i = v1_i, Vb_i = a²·v1_i, Vc_i = a·v1_i` — i.e. the phase voltages are approximated from the **positive-sequence** solution only, ignoring the V2/V0 that the load itself produces. This is a fixed-point iteration that runs **once** rather than to convergence. For small unbalance this is fine; for large unbalance the V2/V0 drop is non-negligible and the current is overstated (because the actual phase voltage is lower than V1).
- **Standard/Expected**: Full unbalanced load flow iterates the phase voltages until the power-balance mismatch converges in all three phases.
- **Impact**: For the regression test `test_balanced_load_gives_zero_vuf` (balanced load) the approximation is exact (V2=V0=0). For moderately unbalanced LV networks the VUF error is typically <0.5% absolute. For severe single-phase loading (e.g. 1P-A load = 50% of system capacity) the VUF can be understated by 20–40%.
- **Recommendation**: Document as a first-iteration approximation; for production-grade unbalanced LF, iterate V1/V2/V0 to convergence.

### F19 — `_utility_admittance` (used by unbalanced LF) does NOT include the c-factor, while `_utility_impedance` (used by fault) DOES
- **Severity**: Verified OK (correct — different purposes)
- **Location**: `loadflow.py:1848–1856` vs `fault.py:681–696`
- **Issue examined**: `_utility_admittance` computes `z_pu = base_mva / fault_mva` (no `c`), used to build the Y1/Y2/Y0 shunt for load flow. `_utility_impedance` computes `z_pu = C_MAX·base_mva / fault_mva` (with `c=1.10`), used for fault impedance. This is **correct**: load flow uses the physical source impedance (the swing-bus voltage constraint handles the c-equivalent pre-fault voltage), while IEC 60909 fault analysis embeds c in the equivalent impedance. Verified by the regression test `test_ik3_infinite_bus`. **Verified OK.**

### F20 — Fault path walk revisits guard
- **Severity**: Verified OK
- **Location**: `fault.py:526–528` and `533–534`
- **Issue examined**: The walk starts from the bus's neighbours with `path_visited = {bus_id}`, so the faulted bus can never be re-entered. Parallel paths through a mesh are correctly enumerated because `path_visited` is per-branch. **Verified OK.**

### F21 — Branch contribution % uses arithmetic-sum current divider, not complex-sum
- **Severity**: Medium (documented at lines 568–571)
- **Location**: `fault.py:572–579`
- **Issue**: `i_path_pu = |z_eq/z_path| · ik_total_pu` — the share is computed as the **magnitude** of the complex ratio, and shares are summed arithmetically. For paths with different X/R the arithmetic sum of magnitudes exceeds the true complex-summed current.
- **Impact**: For a bus fed by a utility (angle 86°) and a motor (angle 84°), the angle difference is ~2° and the arithmetic-sum error is <0.1%. For a utility in parallel with a long cable (angle could be 70°), the error can reach 5–10%. The bus total `ik_total_ka` is computed correctly (via `_parallel_impedances`); only the **per-branch attribution** is approximate.
- **Recommendation**: Acceptable as a display-level approximation. Document that per-branch % may not sum to 100%.

### F22 — Motor contribution to `ik3_motor`/`ik3_network` sums `c/|z_path|` per path, not the parallel-complex current
- **Severity**: Low
- **Location**: `fault.py:238–246`
- **Issue**: `motor_pu = sum(c/|z_path| for motor_paths)` and `network_pu = sum(c/|z_path| for network_paths)`. This sums the **individual** path currents as if each source alone fed the bus. The reported `ik3_motor + ik3_network` can exceed `ik3_ka` when paths have different angles.
- **Impact**: The total `ik3_ka` is correct (line 146, complex parallel). The motor/network **split** is approximate; for typical networks (similar X/R) the error is <2%.
- **Recommendation**: Use the complex current divider for the motor/network attribution, or note that `ik3_motor + ik3_network ≠ ik3_ka` exactly.

### F23 — `thermal_m_factor` uses `ln(κ−1)` with guard
- **Severity**: Verified OK
- **Location**: `fault.py:49–69`
- **Issue examined**: For κ=1.02, `x = ln(0.02) = −3.91`; for κ=2.0, `x = ln(1) = 0` (caught by the `abs(x) < 1e-9 → return 2.0` guard). The analytic limit as κ→2 is `m → 2`. **Verified OK.**

### F24 — `_compute_voltage_depression` source shunts use sub-transient impedance for ALL modes
- **Severity**: Low / Verified OK
- **Location**: `fault.py:1441–1446` and `_get_mode_impedance` at 1584–1628
- **Issue examined**: For each mode, `_get_mode_impedance` is called per source. For generators it correctly scales; for induction motors it returns `None` for non-subtransient modes (correctly removing them); for utilities it returns the constant `z_subtransient`. **Verified OK.**

### F25 — Test coverage gap: no regression test for LL or LLG fault magnitudes
- **Severity**: Low
- **Location**: `test_regression.py:57–90`
- **Issue**: `TestFaultAnalysis` covers Ik3 (line 58), Ik1=Ik3 when Z0=Z1 (line 72), and κ (line 82). There are **no tests** that pin IkLL or IkLLG to a hand calculation. The SLG test only checks the Z0=Z1 degenerate case.
- **Recommendation**: Add tests: (a) LL with Z1=Z2=j0.2 → IkLL = c·√3/0.4 = 4.76 pu; (b) SLG with Z0=2·Z1 → Ik1 = 0.75·Ik3; (c) LLG with Z0→∞ → should degenerate to IkLL; (d) LLG with Z0=Z1=Z2.

### F26 — `_compute_breaking_current` only called for 3-phase
- **Severity**: Verified OK
- **Location**: `fault.py:1180–1274`
- **Issue examined**: Ib is computed per-source-path for 3-phase only. SLG/LL/LLG breaking currents are not computed separately (they report `ib=ib_3ph`). This is a minor limitation (IEC 60909-0 §9 covers 3-phase breaking; unbalanced breaking is rarely required) but should be documented.

### F27 — `static_load` phase percentages sum to 100.01 (normalised)
- **Severity**: Info
- **Location**: `unbalanced_loadflow.py:456–469`
- **Issue**: Default phase percentages 33.33+33.33+33.34 = 100.01. The code normalises by `total_pct` (line 459–461). Deliberate rounding, correctly handled.
- **Impact**: None (normalised).

### F28 — `run_unbalanced_load_flow` method dispatch
- **Severity**: Verified OK
- **Location**: `unbalanced_loadflow.py:572` → `solve_with_islands` dispatches on `method` (loadflow.py:666–668). **Verified OK.**

---

## Verified-OK Summary (areas checked and found correct)

- **Per-unit base conversion** for Ik3 (`c/|Z|·I_base`, line 146–147): correct.
- **Utility impedance** `Z_Q = c·S_base/S_kQ` (fault.py:693): correct, reproduces declared fault level (regression test `test_ik3_infinite_bus`).
- **SLG per-unit formula** `3c/|Z1+Z2+Z0|` (fault.py:167): algebraically verified equals `√3·c·U_n/|Z_ohm|`.
- **LL per-unit magnitude** `c·√3/|Z1+Z2|` (fault.py:178): correct (the angle in F1 is wrong, the magnitude is right).
- **LLG formula** `3c·|Z2|/|Z2·(Z1+Z2+Z0)+Z1·Z0|` (fault.py:184): correct sequence-network derivation for the earth (zero-sequence) current.
- **Peak factor κ** `1.02 + 0.98·e^(−3R/X)` (fault.py:1153): IEC 60909-0 Eq. 55, verified for X/R=15 → 1.8224.
- **Thermal factor m** (fault.py:49–69): correct IEC 60909-0 §12 formula with proper κ→2 limit.
- **Per-path DFS** with per-branch visited set (fault.py:369–375): correctly enumerates parallel/mesh paths.
- **EE-1 fix** (fault.py:972–973): cable forwards `remote_port` to transformer, correctly disambiguating Dyn11 delta-side entry. Regression test `test_dyn_transformer_behind_cable_contributes_no_z0` validates.
- **NR Jacobian** all four blocks (H1/H2/H3/H4, loadflow.py:1747–1789): verified against Grainger & Stevenson polar formulation.
- **GS PQ and PV updates** (loadflow.py:1823–1837): correct sign convention, consistent with NR Q_calc.
- **Bus-group / transparent-element collapsing** (loadflow.py:34–54): correct flood-fill that doesn't cross bus boundaries.
- **Y-bus transformer pi-model with tap** (loadflow.py:929–946): standard formulation, tap on correct side.
- **Utility as swing, not shunt** (loadflow.py:1014–1019): correct — avoids the "passive load" artefact.
- **Unbalanced LF symmetrical-component transforms** `_A` and `_A_inv` (unbalanced_loadflow.py:43–54): correct `a = e^(j120°)` convention.
- **Per-unit phase current** `I = 3·conj(S/V)` (unbalanced_loadflow.py:602): correct for the three-phase-base / line-to-neutral-voltage convention.
- **2P load sequence currents** give I0=0 exactly (unbalanced_loadflow.py:620–630): correct — line-to-line loads have no zero-sequence current.
- **Mode-dependent source impedance scaling** for voltage depression (fault.py:1584–1628): correct subtransient/transient/steady-state selection.
- **c-factor asymmetry** between fault (`_utility_impedance` includes c) and loadflow (`_utility_admittance` omits c): intentional and correct (F19).

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | F12 |
| Medium | 6 | F1, F3, F4, F5, F18, F21 |
| Low | 8 | F2, F6, F11, F16, F17, F22, F25, F27 |
| Info / Verified OK | 11 | F7, F8, F9, F10, F13, F14, F15, F19, F20, F23, F24, F26, F28 |

**Most actionable items** (in priority order):
1. **F12** — Utility Z0 path not gated by grounding config; can overstate SLG/LLG for ungrounded utility neutrals.
2. **F5** — Synchronous-motor steady-state uses Xd′ instead of Xd; ~5× overstatement of sustained contribution.
3. **F4** — Generator μ uses terminal-fault ratio instead of fault-point ratio; ~10% Ib understatement for remote generator faults.
4. **F3** — DC/asymmetric breaking current uses bus-aggregate R/X instead of per-path; 5–15% error for mixed sources.
5. **F18** — Unbalanced LF uses single-iteration V1-only approximation for sequence-current injection; VUF understated for severe single-phase loading.
6. **F25** — No regression tests for LL/LLG magnitudes or SLG with Z0≠Z1; high-value fault formulas are unverified by the test suite.