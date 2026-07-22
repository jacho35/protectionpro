# ProtectionPro Electrical Calculation Engine — Code Review Report
## Senior Engineer #2 — Arcflash, Cable, Grounding & Other Engines

## Scope

Files reviewed (full content):
1. `/root/protectionpro/backend/analysis/arcflash.py` — IEEE 1584-2002 arc flash (900 lines)
2. `/root/protectionpro/backend/analysis/dc_arcflash.py` — Stokes-Oppenlander DC arc flash (516 lines)
3. `/root/protectionpro/backend/analysis/cable_sizing.py` — IEC 60364 / NEC cable sizing (809 lines)
4. `/root/protectionpro/backend/analysis/grounding_system.py` — IEEE 80 grounding grid (453 lines)
5. `/root/protectionpro/backend/analysis/duty_check.py` — Equipment fault duty validation (314 lines)
6. `/root/protectionpro/backend/analysis/motor_starting.py` — Locked-rotor voltage dip (269 lines)
7. `/root/protectionpro/backend/analysis/load_diversity.py` — Demand/diversity factors (331 lines)
8. `/root/protectionpro/backend/tests/test_regression.py` — Standards-anchored tests (703 lines)
9. `/root/protectionpro/backend/tests/test_arcflash_clearing.py` — Arc flash clearing tests (356 lines)

Cross-referenced: `/root/protectionpro/backend/analysis/fault.py` (`thermal_m_factor`, `C_MAX`, `FaultResultBus` schema), `/root/protectionpro/CLAUDE.md`.

## Verification Method

- Hand-traced the governing equation in every engine against the cited standard clause (IEEE 1584-2002 Eq. 1-6 & Table 4; IEEE 80-2013 Eq. 27/57/79/85/86/89/92/94/37; IEC 60909-0 §12; IEC 60364-5-52; IEC 60949; IEC 60947-2 Table 2; IEC 62271-100; NFPA 70E Table 130.7(C)(15)(a); Stokes & Oppenlander 1985; Ammerman 2010).
- Reproduced the regression-test anchors numerically in Python (arc flash En, IEEE 80 conductor area, motor-starting MVA reconstruction, DC unit conversions, distance-exponent sensitivity).
- Checked unit consistency (kA vs A, kV vs V, J vs cal, m vs ft, mm² vs kcmil), sqrt(3) placement in 3-phase formulae, and per-unit vs actual-value usage.
- Verified each test in the two test files pins a real standard clause and traced whether the test would catch the bugs found.

## Findings

### F1 — IEEE 1584-2002 MV distance exponent is wrong (underestimates MV incident energy)
- **Severity**: High
- **Location**: `backend/analysis/arcflash.py:229`
- **Issue**: For MV enclosed (V > 1 kV) the distance exponent is set to `x = 0.973`. The value `0.973` does **not** appear in IEEE 1584-2002 Table 4. The correct in-box exponents for MV switchgear are **1.641** (1–5 kV, gap 102 mm) and **1.467** (5–15 kV, gap 153 mm). All other IEEE 1584-2002 in-box exponents lie in 1.47–1.64; a sub-1.0 exponent is unphysical for enclosed gear (it implies energy falls off *slower* with distance than 1/D, opposite to the enclosure-focusing effect).
- **Standard/Expected**: IEEE 1584-2002 §5.4 Table 4 — `x = 1.641` for 1–5 kV switchgear, `x = 1.467` for 5–15 kV switchgear. The code should select by voltage band (like the LV branch already does by gap), not a single 0.973.
- **Impact**: At a typical MV working distance of 455 mm, `(610/455)^x` evaluates to 1.330 (code) vs 1.537 (x=1.467) or 1.618 (x=1.641). The code therefore **underestimates MV incident energy by ~16 % (5–15 kV) to ~22 % (1–5 kV)**, and the arc flash boundary is correspondingly underestimated — a non-conservative error on a safety calculation. Example: a 13.8 kV switchgear fault computed at 8 cal/cm² by the code is actually ~9.3 cal/cm², which can shift the PPE category.
- **Recommendation**: Replace line 228-229 with a voltage-band lookup: `x = 1.641 if voltage_kv <= 5.0 else 1.467` for MV enclosed. Add a regression test at D ≠ 610 mm that pins the MV exponent (the existing `test_cf_voltage_factor` evaluates at D=610 mm where the exponent cancels, so it cannot catch this).

### F2 — Arc flash engine implements IEEE 1584-2002 while CLAUDE.md claims IEEE 1584-2018
- **Severity**: High (documentation / standard-compliance)
- **Location**: `backend/analysis/arcflash.py:1-29` (module docstring explicitly says 2002); `CLAUDE.md` (Arc Flash section) claims "IEEE 1584-2018 arc flash incident energy".
- **Issue**: The engine uses the 2002 empirical model (Eq. 1-6, single K1/K2, no electrode-config-specific k1-k5 coefficients, no intermediate arcing currents at 600/2700/14 300 V, no enclosure-size correction, no 85 %/15 % final-energy weighting). CLAUDE.md and the API surface advertise 2018. The two standards differ substantially: 2018 introduces five electrode configurations (VCB/VCBB/HCB/VOA/HOA) with distinct coefficient sets, intermediate arcing-current computation at three reference voltages with logarithmic interpolation, enclosure-size correction `CFE`, and the final `E = 0.85·E@100 % + 0.15·E@85 %` weighting.
- **Standard/Expected**: IEEE 1584-2018 §4.2–§4.6.
- **Impact**: Users relying on the documented "IEEE 1584-2018" labelling will design PPE against a model that ignores the configuration-specific coefficients that, per the 2018 standard, can change incident energy by factors of 2–4× (e.g., HCB vs VCB at the same voltage/current).
- **Recommendation**: Either (a) update CLAUDE.md, the API `method` field, and the label footer to state "IEEE 1584-2002" consistently, or (b) implement the 2018 model. The code already accepts `electrode_config` and `enclosure_mm` props that are unused — a 2018 upgrade would consume them.

### F3 — K2 grounding factor hardcoded to 0 (ungrounded) for all systems
- **Severity**: Medium
- **Location**: `backend/analysis/arcflash.py:210`
- **Issue**: `K2 = 0` is applied unconditionally. IEEE 1584-2002 Eq. 3-4 requires `K2 = -0.113` for grounded (solidly or effectively grounded) systems and `K2 = 0` only for ungrounded/high-resistance-grounded systems.
- **Standard/Expected**: IEEE 1584-2002 §5.2 — K2 selected by system grounding.
- **Impact**: For grounded systems (the common industrial case), `log En` is overstated by 0.113, so incident energy is overstated by `10^0.113 ≈ 1.30` (+30 %). Conservative (overestimates hazard → over-specifies PPE) but still a deviation from the standard that can push a 3.1 cal/cm² result into Category 2.
- **Recommendation**: Read a grounding-mode prop from the bus/source (e.g., `grounding` ∈ {`solid`, `hr`, `ungrounded`}) and set `K2 = -0.113` for solid/low-Z grounded systems. Default to 0 only when grounding is unknown.

### F4 — Reduced-arcing-current clearing time uses a fixed ×1.5 heuristic instead of TCC evaluation at 85 %
- **Severity**: Medium
- **Location**: `backend/analysis/arcflash.py:716`
- **Issue**: `t_clear_reduced = min(t_clear * 1.5, 2.0)`. IEEE 1584-2002 §5.5 (and 2018 §4.5) requires re-evaluating the actual protective-device TCC at 85 % of the arcing current to obtain the (longer) clearing time, then computing incident energy at that longer time. Multiplying by a flat 1.5 ignores the real relay/fuse curve shape: an IDMT relay at 0.85·Iarc may take 3–5× longer (not 1.5×) if it sits near pickup, while a current-limiting fuse may not lengthen at all.
- **Standard/Expected**: IEEE 1584-2002 §5.5 / 2018 §4.5 — evaluate device curve at the reduced current.
- **Impact**: For an IEC Standard-Inverse relay at M≈2 (near pickup), the true t(0.85·Iarc)/t(Iarc) ratio is ≈4–6; the 1.5× heuristic **underestimates** the reduced-current clearing time and thus the reduced-current incident energy, potentially missing the worst case. Conversely, for an instantaneous-only breaker the 1.5× overestimates. Direction of error is device-dependent.
- **Recommendation**: Call `get_clearing_time(..., iarc_ka=iarc_reduced)` to evaluate the actual TCC at the reduced current, rather than scaling `t_clear` by 1.5. The infrastructure already exists (`get_clearing_time` accepts `iarc_ka`).

### F5 — IEEE 80 K_ii hardcoded to 1.0 ignores rod-effect on mesh voltage (non-conservative)
- **Severity**: Medium
- **Location**: `backend/analysis/grounding_system.py:152` (`_compute_K_m(..., K_ii=1.0)`) and `:164` (no override at call site `:372`)
- **Issue**: `K_ii` is the "projected mutual grounding resistance" factor. IEEE 80-2013 Eq. 88 sets `K_ii = 1/(2n)^(n_R/n)` for grids **with** ground rods placed along the perimeter/corners, and `K_ii = 1` only for rodless grids. The default grid has `n_R = 20` rods, yet `K_ii = 1.0` is used.
- **Standard/Expected**: IEEE 80-2013 Eq. 88 — `K_ii = (2n)^(-n_R/n)` for grids with rods; `1` for no rods.
- **Impact**: `K_ii` scales the second (negative) term of `K_m`. With `K_ii = 1`, the negative term is maximised in magnitude, making `K_m` **smaller**, so `E_mesh` is **underestimated** for grids with rods — a non-conservative error on a touch-voltage safety check. For the default 6×6 grid with 20 rods, `K_ii` should be `(2·6)^(-20/6) ≈ 12^(-3.33) ≈ 0.0004`, nearly eliminating the second term and raising `K_m` by ~6 %; for fewer rods the effect is larger.
- **Recommendation**: Compute `K_ii = (2*n)**(-n_R/n)` when `n_R > 0`, else `1.0`. Pass it into `_compute_K_m`.

### F6 — IEEE 80 split factor S_f hardcoded to 1.0 (conservative but undocumented limitation)
- **Severity**: Low
- **Location**: `backend/analysis/grounding_system.py:347`
- **Issue**: `S_f = 1.0` assumes 100 % of the earth-fault current returns through the grid, ignoring current division through neutral conductors, cable sheaths, and parallel earth paths. IEEE 80 §15.8 requires computing the split factor from the network.
- **Standard/Expected**: IEEE 80-2013 §15.8 / Fig 16–20 — `S_f` from the division between grid, neutral, and earth return.
- **Impact**: Overestimates `I_G`, `GPR`, `E_mesh`, `E_step` — conservative for safety but can drive unnecessary grid expansion. The comment at `:345-346` documents the assumption, so this is a known limitation rather than a silent bug.
- **Recommendation**: Accept an optional `split_factor` prop (default 1.0) so users with known division can supply it; surface `S_f` in the result so reviewers know the basis.

### F7 — IEEE 80 K_h uses metric h directly (defensible under 2013, ~6 % vs imperial)
- **Severity**: Low / Info
- **Location**: `backend/analysis/grounding_system.py:160`
- **Issue**: `K_h = sqrt(1 + h)` with `h` in metres. IEEE 80-2000 Eq. 81 was derived with `h` in feet; IEEE 80-2013 metricised the equations and uses `h` in metres. The code follows the 2013 convention, which is the cited standard. Some practitioners still convert `h` to feet (`K_h = sqrt(1 + h_ft)`), giving a larger `K_h`.
- **Impact**: For `h = 0.5 m`, code `K_h = 1.225` vs feet-interpretation `1.625`; this propagates to a ~6 % difference in `K_m` and thus `E_mesh`. Under the 2013 metric convention the code is correct.
- **Recommendation**: No change required if 2013 is the target. Add a one-line comment noting the metric convention to forestall "fixes" that convert to feet.

### F8 — DC arc flash reuses the AC clearing-time estimator and AC fault current
- **Severity**: Medium
- **Location**: `backend/analysis/dc_arcflash.py:331` (clearing time) and `:299` (bolted fault current)
- **Issue**: (a) `get_clearing_time` from the AC arcflash module is called with the DC arcing current; it evaluates AC IDMT relay curves, AC gG fuse curves, and AC CB thermal-magnetic models. DC protection devices (DC-rated fuses/breakers) have different characteristics and no natural zero-crossing, so AC clearing times are a rough proxy. (b) The DC bolted fault current is taken from `fault_bus.ik3` — the **3-phase AC** fault result. A genuine DC bus has no 3-phase fault; `ik3` will be 0 for a DC bus that the AC fault engine doesn't recognise, causing the analysis to skip silently (`:293-297`).
- **Standard/Expected**: NFPA 70E-2021 Annex D.5 — DC arc flash needs the DC bolted fault current (from battery/rectifier impedance) and DC device clearing times.
- **Impact**: For a real DC system (battery bank, PV string), the engine either produces no result (`ik3 = 0`) or produces a result based on an AC fault level that has no physical meaning for the DC source. Where it does produce a result, the clearing time may be significantly wrong for DC-rated vs AC-rated devices.
- **Recommendation**: Either (a) require a DC-specific bolted-fault-current prop on DC buses and skip the `ik3` dependency, and (b) provide a DC clearing-time path (DC fuse curves / DC breaker opening time). At minimum, emit a warning when the bus appears to be DC (e.g., a `dc_system` prop) but `ik3` is being used as the DC fault current.

### F9 — Cable voltage-drop limit does not distinguish lighting (3 %) from non-lighting (5 %)
- **Severity**: Low
- **Location**: `backend/analysis/cable_sizing.py:466` (`max_voltage_drop_pct: float = 5.0`)
- **Issue**: IEC 60364-5-52 Table G.52.1 specifies 3 % for lighting circuits and 5 % for other uses (from LV service). The engine applies a single 5 % limit to all cables regardless of load type.
- **Standard/Expected**: IEC 60364-5-52 §525 Table G.52.1.
- **Impact**: Lighting circuits can pass the check with up to 5 % drop, 2/3 above the standard's 3 % limit — may cause noticeable flicker / lumen loss.
- **Recommendation**: When the downstream load is a lighting load (load category prop), apply 3 %; otherwise 5 %. Expose both limits in the result so the caller can see which applied.

### F10 — `IEC_DEMAND_FACTORS` table is returned but never applied
- **Severity**: Low / Info
- **Location**: `backend/analysis/load_diversity.py:18-31` (table), `:175` (uses per-load `demand_factor` prop only), `:330` (returns table as advisory)
- **Issue**: The module advertises "IEC-recommended demand factors by load category" but the analysis uses only the manually-set `demand_factor` prop on each load. The IEC table values (e.g., 0.4 for socket outlets, 0.5 for >10-motor groups) are never applied to loads that lack an explicit factor.
- **Standard/Expected**: IEC 61439-1 / IEC 60439-1 — demand factors by category should be the default when a load's category is known.
- **Impact**: Loads with `demand_factor` unset default to 1.0 (`:175`), so a socket-outlet board with no explicit factor is treated at 100 % demand instead of 40 % — overestimates demand and transformer loading.
- **Recommendation**: When `demand_factor` is unset, look up the IEC table by a `load_category` prop (lighting, socket_outlets, motor_group_*, …) and use that as the default; fall back to 1.0 only when category is also unknown.

### F11 — Voltage-factor boundary `V = 1 kV` uses the LV model (Cf=1.5, Eq. 1)
- **Severity**: Low
- **Location**: `backend/analysis/arcflash.py:141` (arcing current) and `:217` (Cf)
- **Issue**: Both the arcing-current equation selection and the Cf factor use `voc_kv <= 1.0` to pick the LV branch. IEEE 1584-2002 specifies Eq. 1 / Cf=1.5 for V **< 1 kV** and Eq. 2 / Cf=1.0 for V **≥ 1 kV**. At exactly 1 kV the code uses the LV model with Cf=1.5.
- **Impact**: At V = 1.0 kV exactly, incident energy is overstated by 50 % (Cf=1.5 vs 1.0) and the arcing current uses the more complex LV equation instead of Eq. 2. 1 kV systems are uncommon but the boundary is the opposite of the standard.
- **Recommendation**: Change both comparisons to `voc_kv < 1.0` for the LV branch.

### F12 — PPE category 0 retained with `cat = 0` and `cat = -1` both meaning "no/DANGER" ambiguity
- **Severity**: Info
- **Location**: `backend/analysis/arcflash.py:55-62`, `:82`
- **Issue**: The table maps [1.2, 4.0)→cat 1, …, [40, 1e6)→cat -1 ("DANGER"). Below 1.2 cal/cm² maps to cat 0 ("No arc-rated PPE"). The `_get_ppe` fallback at `:83` returns `-1, "DANGER"` for the >40 case, duplicating the table's last row. The comment at `:52-54` explains cat 0 is retained for API compatibility. This is self-consistent but the dual use of `-1` (table + fallback) is brittle if the table's upper bound changes.
- **Impact**: None functionally; informational. A future edit that lowers the `1e6` upper bound could make the fallback unreachable while the table's -1 still fires.
- **Recommendation**: No change needed; the comment documents the design.

---

## Verified OK (areas checked and found correct)

- **Arc flash arcing current (LV Eq. 1 / MV Eq. 2)** — `arcflash.py:145-153`: coefficients and signs match IEEE 1584-2002 Eq. 1 & 2. Hand-traced for Ibf=10 kA, V=0.48 kV, G=32 mm → reproduces the regression-test anchor `En = 3.642 J/cm²`, `E = 5.46 cal/cm²`.
- **Arc flash normalized energy Eq. 3 & scaling Eq. 5** — `arcflash.py:213-233`: `log En = K1 + K2 + 1.081·log Ia + 0.0011·G`, then `E = 4.184·Cf·En·(t/0.2)·(610/D)^x / 4.184`. The `4.184` cancels correctly, leaving `E[cal/cm²] = Cf·En·(t/0.2)·(610/D)^x`. Verified the LV distance exponents (1.473 for switchgear gap≥32, 1.641 for MCC gap<32) match IEEE 1584-2002 Table 4.
- **PPE category bands** — `arcflash.py:55-62`: match NFPA 70E-2021 Table 130.7(C)(15)(a) (Cat 1: 1.2–4, Cat 2: 4–8, Cat 3: 8–25, Cat 4: 25–40, >40 DANGER).
- **Arc flash boundary bisection** — `arcflash.py:264-275`: solves for D where E = 1.2 cal/cm²; 50 iterations on [300, 50000] mm converges to <0.1 mm. Correct.
- **DC arc flash S&O model** — `dc_arcflash.py:97-150`: `R_arc = (20+0.534·G)/I^0.88`, fixed-point iteration, `V_arc = I·R_arc = (20+0.534·G)·I^0.12`. Matches Stokes & Oppenlander 1985 / Ammerman 2010. Sustainability check at I=1 A is a reasonable proxy.
- **DC incident energy point-source sphere** — `dc_arcflash.py:200-208`: `E = P·t/(4π·D²)` then `/41868` to cal/cm². Matches Ammerman 2010. Unit conversion 41868 (thermochemical) vs 41840 (IT) is 0.07 % — negligible. Analytical AFB inversion at `:242` is algebraically correct.
- **Cable adiabatic fault withstand** — `cable_sizing.py:614-631`: uses `Ith = Ik″·√(m+n)` (IEC 60909-0 §12) with `m` from `thermal_m_factor` at the actual clearing time, then `S ≥ Ith·√t/k`. The `k` table (143 Cu/XLPE, 115 Cu/PVC, 94 Al/XLPE, 76 Al/PVC) matches IEC 60364-5-52 Annex A / IEC 60949 Table 1.
- **Cable thermal derating (IEC)** — `cable_sizing.py:554-559`: `temp_df = √((θ_max−θ_amb)/(θ_max−30))` matches IEC 60287 derating. Guards `θ_amb ≥ θ_max → 0` correctly forces a FAIL rather than a silent pass.
- **Cable voltage-drop formula** — `cable_sizing.py:586-588`: per-phase `ΔV = I·L·(R·cosφ + X·sinφ)`, then `% = ΔV/V_phase·100` with `V_phase = V_LL/√3`. This equals LL-drop/LL-voltage % — correct.
- **Cable r_per_km temperature handling** — payload values treated as operating-temp (hot), internal `STANDARD_CABLES` as 20 °C DC corrected via `_temp_correction()`. Consistent, no double-correction. The derived-size formula `S = ρ·1000/R` uses hot resistivity, giving the true physical area for the adiabatic check.
- **NEC 310.16 ampacity / 310.15(B)(1) temp correction / 310.15(C)(1) conductor count** — tables and lookup logic match NEC. The 20 % metric/AWG tolerance consistently selects a smaller AWG → conservative ampacity.
- **IEEE 80 tolerable voltages** — `grounding_system.py:92-114`: `E_touch = (1000+1.5·Cs·ρs)·k/√ts`, `E_step = (1000+6·Cs·ρs)·k/√ts` with `k=0.157` (70 kg) / `0.116` (50 kg). Matches IEEE 80-2013 Eq. 31/32 (70 kg) and Eq. 29/30 (50 kg).
- **IEEE 80 C_s surface derating** — `:87`: `Cs = 1 − 0.09·(1−ρ/ρs)/(2·hs+0.09)` matches IEEE 80-2013 Eq. 27.
- **IEEE 80 grid resistance (Sverak)** — `:128`: `Rg = ρ·[1/L_T + 1/√(20A)·(1 + 1/(1+h·√(20/A)))]` matches IEEE 80-2013 Eq. 57.
- **IEEE 80 decrement factor** — `:186-212`: `Df = √(1 + (Ta/tf)·(1−e^(−2tf/Ta)))`, `Ta = X/(ωR)`, X/R derived from IEC 60909 κ. Matches IEEE 80-2013 Eq. 79.
- **IEEE 80 conductor sizing (Onderdonk Eq. 37)** — `:215-242`: `A[mm²] = I[kA]·√(α·ρ·10⁴·t/(TCAP·ln(1+(Tm−Ta)/(K0+Ta))))`. Verified 10 kA/0.5 s hard-drawn Cu → 25.28 mm² (test expects 18–32). Material constants (Table 1) match.
- **IEEE 80 mesh/step voltage structure** — `:132-149`: `Em = ρ·IG·Km·Ki/LM`, `Es = ρ·IG·Ks·Ki/LS`; `Km` and `Ks` formulae match IEEE 80 Eq. 86/94 structurally. `L_S = 0.75·Lc+0.85·Lrod` matches Eq. 92.
- **Duty check breaking vs making** — `duty_check.py:133-197`: breaking duty uses `Ib` (IEC 60909 §9) with Ik″ fallback; making capacity uses `ip = κ·√2·Ik″` vs IEC 62271-100 `Icm = 2.5·Icu` (50 Hz) / 2.6 (60 Hz) for MV, and IEC 60947-2 Table 2 ratio `n` for LV. All match the standards.
- **Motor starting locked-rotor & MVA reconstruction** — `motor_starting.py:112-176`: FLC for induction `= kW/(√3·V·η·pf)`, for synchronous `= kVA/(√3·V)`; starting MVA `= √3·V·I_start/1000`; constant-PQ reconstruction reproduces `S_start` exactly. Starting-method factors: star-delta 1/3 (line current), autotransformer 0.8²=0.64 (supply-side), soft-starter 0.5, VFD→FLC — all correct.
- **Motor starting acceptance thresholds** — terminal V ≥ 0.8 pu (NEMA MG-1), system dip ≤ 15 %, sensitive PQ-bus dip ≤ 10 % — reasonable per IEC 61000-2-5.
- **Load diversity current** — `load_diversity.py:212`: `I = S_kVA/(√3·V_kV)` gives amperes directly. Correct. Coincidence-factor table and interpolation match IEC 60439-1 Annex H practice.
- **IEC 60909 thermal m factor** — `fault.py:49-69`: `m = (e^(4fTk·ln(κ−1))−1)/(2fTk·ln(κ−1))` matches IEC 60909-0 §12 Eq. 66. Guards at κ≤1 and κ→2 (analytic limit m=2) are correct.
- **Regression tests** — `test_regression.py` and `test_arcflash_clearing.py`: every hand-anchor traced (Ik3 at 11 kV, κ at X/R=15, SLG=3φ when Z0=Z1, Cf ratio, En hand calc, IEEE 80 conductor area, motor-starting dip band, IDMT constants at M=10, gG fuse curve interpolation, relay via trip_cb/associated_ct). All anchors are arithmetically consistent with the standards and with the engine. Test coverage is strong for fault/load-flow/relay/fuse; the one gap is F1 (MV distance exponent only tested at D=610 mm where it cancels).

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 (F1, F2) |
| Medium | 4 (F3, F4, F5, F8) |
| Low | 3 (F6, F9, F11) |
| Info | 3 (F7, F10, F12) |

**Most actionable items:**
1. **F1** (High) — Fix the MV distance exponent in `arcflash.py:229` from `0.973` to `1.641`/`1.467`; add a regression test at D ≠ 610 mm. This is a silent under-reporting of MV arc flash energy.
2. **F2** (High) — Reconcile CLAUDE.md/API label (claims 2018) with the engine (implements 2002).
3. **F5** (Medium) — Compute `K_ii` for grids with rods in `grounding_system.py`; current code underestimates mesh touch voltage for the default 20-rod grid.
4. **F8** (Medium) — DC arc flash depends on AC `ik3` and AC clearing times; either provide a DC fault-current input path or emit an explicit warning.

No Critical issues were found — the core arithmetic (IEC 60909, IEEE 80 Onderdonk, IEEE 1584-2002 LV, Stokes-Oppenlander, IEC 60947-2/62271-100 duty) is correct and well-anchored by the regression tests. The errors found are confined to: one wrong table constant (F1), a documentation/standard-edition mismatch (F2), several conservative or non-conservative simplifications (F3, F5, F6, F8), and minor boundary/table-application issues (F9, F10, F11).