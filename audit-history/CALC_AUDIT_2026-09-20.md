# Calculation Audit — First-Principles Review of All Engines

**Date:** 2026-09-20
**Scope:** Every calculation engine in the application — all 43 `backend/analysis/` modules plus the calculation-bearing frontend modules (`constants.js`, `tcc.js`, `compliance.js`, `lightning.js`, `dbschedule.js`, `plan-lux.js`, `cablelib.js`, `grid.js`, `rates.js`/`boq.js`).
**Method:** Read-only review. No code was modified. Every governing formula was re-derived from first principles against its standard, and ~50 ad-hoc numerical probes (hand calculation vs engine output) were run in the backend Docker image. The existing regression suite (806 tests) was run as a baseline and passes.
**Relation to prior audits:** `audit-history/` records multiple prior review rounds (Round 3 Principal is the final word on those). This audit re-verified the previously-fixed items and, unless stated otherwise, **confirms those fixes are correct**. The findings below are new items discovered in this pass, plus verified-correct coverage notes.

---

## Verdict

The calculation engines are in **excellent shape**. The core physics — IEC 60909, Newton-Raphson, IEEE 1584 (both 2002 and 2018), IEEE 80, IEC 60364, IEC 62305-2, symmetrical components, RK4 transient integration, Carson coupling, IEEE 519, Herman-Beta statistics — reproduces the governing standards to machine precision in every probe run. Prior audit fixes (K_T, K_G, c-factor in Z_Q, meshed Zbus, EE-12 zone tracking, EE-10 Kron reduction, etc.) were spot-verified numerically and are correct.

**One High finding** was identified in this pass, one Medium, and a small number of Low/informational items.

---

## Findings

### F-1 [HIGH] Load flow: cable-only branch chains use the cable's own `voltage_kv` prop as the per-unit base — the [EE-12] zone-tracking convention was not applied on this path

**File:** `backend/analysis/loadflow.py:2343` (via `_get_impedance`, `loadflow.py:1654-1660`)

**Derivation.** When a chain between two buses contains a transformer, the chain builder resolves each cable's per-unit base from the **bus-inferred voltage zone** (`loadflow.py:2312-2339`, with an explicit comment that the cable's own `voltage_kv` prop "may be wrong or defaulted"). But for a chain with **no transformer** — the plain `bus → cable → bus` case, which is the most common topology in the app — the code falls into the `else` branch at `loadflow.py:2342-2343`:

```python
else:
    z_total = sum((_get_impedance(e, base_mva) for e in all_elems.values()), complex(0, 0))
```

and `_get_impedance` for a cable uses the cable's own prop:

```python
elif comp.type == "cable":
    v_kv = comp.props.get("voltage_kv", 11)   # ← prop, not the bus zone
    z_base = (v_kv ** 2) / base_mva
```

A cable dragged from the sidebar keeps the palette default `voltage_kv: 11` (`frontend/js/constants.js:2427`). On a 0.4 kV network, the per-unit impedance is then understated by **(11/0.4)² = 756×**.

**Numerical confirmation.** LV network: utility @ 0.4 kV (infinite bus) → 50 m cable (0.3 Ω/km) → 50 kVA load. Engine reports the far bus at **0.99999 p.u.**; the hand calculation (z_base = 0.4²/100 = 0.0016 Ω) gives **0.99536 p.u.** — a 15× understatement of the voltage drop. The branch current is also reported at the wrong base (2.62 A shown vs 72.2 A actual at 0.4 kV).

**Impact.** Voltage-drop, losses, loading-%, motor-starting dips and every downstream study that consumes load-flow branch currents on **LV cable-only chains with a stale/default cable prop** are wrong by up to three orders of magnitude. In practice the frontend plan-sync flow writes the correct `voltage_kv` from the cable library (`plan-sync.js:442`), so drawings produced through the Plan workspace are unaffected; a manually-drawn LV cable (or an API payload omitting the prop) hits the defect. Fault.py fixed exactly this class of bug with [EE-12] — the fix was never propagated to loadflow's cable-only path.

**Correct treatment.** Use the bus-zone voltage (the chain's `bus_a_v`/`bus_b_v`, or the single bus voltage when both ends share it) as the per-unit base for every cable in a no-transformer chain, exactly as the transformer-chain branch already does — the two branches should share one zone-resolution helper. Add a regression test with a 0.4 kV network and a default-props cable.

---

### F-2 [MEDIUM] `_get_impedance` cable branch also bases standalone-cable calls on the prop (same root cause, wider blast radius)

**File:** `backend/analysis/loadflow.py:1654-1660`

The same helper is consumed by:
- `_reduce_chain_two_port` (transformer chains pass an explicit zone voltage through their own code, so unaffected),
- `network_reduction.py` (walks its own zone tracking — unaffected),
- **any future caller** that passes `v_kv=None` — the fallback is the cable prop.

Because the defect is concentrated in one function, fixing `_get_impedance` to accept (and require, where topology is known) the bus-zone voltage resolves F-1 and F-2 together. Severity is Medium only because the affected path is narrow; the engineering consequence is the same as F-1 where it fires.

---

### F-3 [LOW] Unbalanced load flow vs fault engine: divergent Z0 fallback conventions (documented, but a silent 17% disagreement)

**Files:** `backend/analysis/unbalanced_loadflow.py:150-163` (3.5× positive-sequence per-km fallback) vs `backend/analysis/fault.py:1131-1146` (3× composite Z1 fallback).

Both engines disclose the difference in comments ("a long-standing per-engine convention, deliberately left alone"), and both prefer explicit `r0_per_km`/`x0_per_km` props, which the frontend library always writes (`constants.js` cables carry `r0_per_km`/`x0_per_km`). So in practice the two engines agree. But for a cable with **no zero-sequence props** (API payload), the same network produces IEC-60909 SLG currents and unbalanced-LF V0 values from **different Z0 networks** (3.5·R1+j3.5·X1 vs 3·(R1+jX1) — ~17% apart on magnitude for a typical R/X). Recommend either unifying the fallback or emitting a study warning when the fallback (not explicit props) was the source of Z0.

---

### F-4 [LOW] `fault.py` motor steady-state contribution for `solar_pv`/`battery`/`wind_turbine` paths

`_compute_steady_state_current` (`fault.py:2554-2604`) handles `utility`, `generator`, `motor_synchronous`, `motor_induction`, then returns — inverter sources and wind contribute nothing to Ik (steady state). For DFIG/SCIG wind and Type-4 converters this is defensible (converter current limits are transient phenomena; induction machines contribute ~0 to steady state), and the omission is conservative-**neutral** for Ik. No action required; noted for completeness because `ib` (breaking) *does* credit these sources while `ik_steady` does not, which is internally consistent but worth a sentence in the method disclosure.

---

### F-5 [LOW] `thermal_m_factor` guard at κ ≤ 1.02 returns m = 0, removing the DC heating term entirely

**File:** `backend/analysis/fault.py:63`.

At exactly κ = 1.02 (R/X → ∞, pure resistance) the exponential DC component is zero, so m = 0 is first-principles correct. The guard is fine; noting only that `ith_ka = ik3·√(m+n)` with n = 1 gives Ith = Ik″ — correct. **No defect.** (Verified: the IEC 60909-1 Eq. 87 derivation matches exactly, including the κ→2 limit of m→2.)

---

### F-6 [INFO] Flicker Pst anchor is a planning estimate, not a flickermeter

**File:** `backend/analysis/flicker.py:70-79`.

`Pst = (d/d_anchor)·r^0.31` with the 3%-at-1-change/min anchor. The module docstring is exemplary in stating this is a screening estimate and exposing `d_anchor_pct`/`exponent` as request parameters. The exponent 0.31 and the 3% anchor reproduce the classic rectangular-waveform Pst=1 curve to planning accuracy. Confirmed fit-for-purpose; recorded so future auditors don't re-derive it as a defect.

---

### F-7 [INFO] `dc_shortcircuit` converter peak (ip = 1.05·Ik) and battery τ fallback (30 ms) are IEC 61660-1-style defaults

Verified against the standard's structure: E_B = 1.05·U_nB, I_kB = 0.95·E_B/R_BBr, peak resistance 0.9·R_B, quasi steady state on full R_B. All match. The converter current-limit model (fixed ×rated, no AC-side dependence) is the documented simplification. No defect.

---

### F-8 [INFO] Frontend/backend "twin" tables verified identical

Spot-diffed, no divergence found:
- IDMT constants: `constants.js:454-463` ≡ `arcflash.py:747-755` (IEC 0.14/0.02, 13.5/1.0, 80/2.0, 120/1.0; IEEE A/B/p per C37.112).
- CT saturation model: `constants.js:489-573` ≡ `ct_model.py` (same 0.8·ALF knee, same η = √((θ−sin2θ/2)/π) clipping law, mirrored line-for-line).
- IEC 60364 grouping/ambient/soil tables: `constants.js` ≡ `iec_60364_tables.py` (bunched {1:1.00, 2:0.80 …} identical).
- Lightning: `lightning.js:68-83` live-estimate A_D/A_M/N_D ≡ `lightning_risk.py:167-188` equations and Table A.1 factors.
- DB way current: `dbschedule.js:_wayCurrentA` ≡ `db_circuit_check._way_current_a` (both referred to the board's own V_LL).
- Fuse gG curves: `arcflash.py:_FUSE_CURVES_GG` states it is ported verbatim from `constants.js`; entries spot-checked.

This twin discipline is a genuine strength of the codebase.

---

### F-9 [INFO] `plan-lux.js` photometry verified

Intensity I = Φ/(2π(1−cos(β/2))) is the exact mean spherical intensity for a uniform cone (solid angle Ω = 2π(1−cos(β/2)) — the derivation is correct), and E = I·cosθ/d² is the inverse-square law with nadir cosine. The IES-web path (`PlanIES.intensity` at off-nadir angle + azimuth) is the correct use of a measured photometric web.

---

## Coverage — formulas verified correct from first principles

### IEC 60909 (fault.py, fault_ansi.py)
| Item | Check | Result |
|---|---|---|
| Z_Q = c·U²/S″k (Eq. 15, [EE-4]) | 500 MVA @ 11 kV round-trips to 26.243 kA declared level | ✅ exact |
| κ = 1.02+0.98e^(−3R/X) (Eq. 55) | closed form, X/R=15 → 1.8224; ip = κ√2·Ik″ | ✅ exact |
| Meshed κ_b Method b (§8.1.2.2) | 1.15×κ capped 1.8 LV / 2.0 HV | ✅ per standard |
| μ factor (Eq. 70-73, all 4 t_min brackets) | coefficients 0.84+0.26e^(−0.26I) etc. | ✅ exact |
| q factor (Eq. 71/§13.2) | 1.03+0.12 ln m etc., m = MW/pole-pair ([PS-7]) | ✅ exact |
| Thermal m (60909-1 Eq. 87) | (e^(4fT·ln(κ−1))−1)/(2fT·ln(κ−1)); κ→2 limit → 2 | ✅ exact |
| K_G (Eq. 18) with U_n/U_rG ratio & fictitious R_G (0.05/0.07/0.15·X″d) | 10 MVA, X″d=0.20, pf 0.85 → K_G = 0.99514; hand ≡ engine | ✅ exact |
| K_T (§6.3.3) | 0.95·c_max/(1+0.6·x_T); 1 MVA 4.5% X/R 10 → 1.0422; hand ≡ engine | ✅ exact |
| SLG/LL/LLG sequence interconnection | Ik1 = 3c/(Z1+Z2+Z0); IkLL = √3c/(Z1+Z2) = 0.866·Ik3 @ Z2=Z1; LLG I″kE2E = 3·Ia0 (earth-current field, [PS-12]) | ✅ exact |
| Meshed topology Zbus ([PS-1]) | 2 parallel cables + shared Z_Q: engine 15.072 kA vs hand Z_Q+(Zc‖Zc) chain 15.072 kA | ✅ exact |
| Motor I″kM (§13, §3.8 S=kW/(η·pf)) | 200 kW motor infeed 0.0858 kA vs hand 0.0855 | ✅ exact |
| Transformer Z0 family | delta blocks; YNyn pass-through w/ both 3Zn ([PS-8a]); single-earthed Yy via Z0m three-limb 0.6 pu / 5-limb blocked ([PS-R2-3]); Dyn yn-side SLG ≈ Ik3 (ratio 1.016 measured, ≈1 expected with Z0T≈Z1) | ✅ per CLAUDE.md spec |
| Voltage depression | V_j = 1−Z_jk/Z_kk nodal; 1 pu prefault convention (documented) | ✅ sound |
| Open-conductor / 2-open / simultaneous | boundary-condition matrices inspected: one-open ↔ LLG-dual, two-open ↔ SLG-dual, Ia1=Ia2=Ia0 identity ✓; 12-var coupled 2-port system construction matches Anderson's method | ✅ sound |
| ANSI C37.010-1979 | §5.4.1 multipliers (3.0/1.2 medium, 1.5/1.0 large, 1.5/1.0 sync, <50 hp neglect), E/X method, 1.6× momentary, 80%/X/R≤15 screening rule, K-factor capability | ✅ per standard |
| DC short circuit (61660-1) | see F-7 | ✅ |

### CT/PT/duty (ct_model.py, pt_model.py, duty_check.py)
- V_AL = ALF·I_sn·(Rct+Rb) [IEC 61869-2], knee ≈ 0.8·V_AL; clipping η = √((θ−sin2θ/2)/π) with θ = arccos(1−2Ks) — **derived from first principles** (RMS of a clipped half-cycle): exact.
- κ-derate as bounded dc-offset proxy: conservative direction, documented residual.
- Duty check: IEC 60947-2 Table 2 n-ladder (1.41 ≤4.5 kA, 1.5, 1.7, 2.0, 2.1, 2.2) exact; Icm = 2.5·Icu (50 Hz) per IEC 62271-100; asym capability Icu·√(1+2β²) with β = e^(−t/τ) — RMS asymmetry identity verified; Ib-basis breaking duty; through-fault max(row, total−row) logic sound.

### Load flow (loadflow.py)
- Full NR Jacobian (all 8 blocks, polar form) ≡ textbook to the term; mismatch equations correct; V-floor guard [EE-11] sound.
- Gauss-Seidel V_k = (1/Y_kk)(S*/V* − ΣY_kjV_j) and PV Q-evaluation sign convention: correct.
- Two-bus probe: engine V2 = 0.96757 vs hand complex-divider 0.96756 (10⁻⁵ agreement).
- Off-nominal tap pi-stamp: y/t², y/t, y/t, y both orientations; `_kron_reduce_two_port` verified as exact Gaussian elimination; `_get_chain_turns_ratio` oriented product walk verified for cascades.
- Thevenin grid model [lf_grid_model]: sag probe — hand series-Z solve 0.96040 vs engine 0.96042; `thevenin_z1_at_bus` @ c=1 matches Z_Q+Z_line to 1e-4.
- Capacitor banks as constant susceptance Q∝V² [EE-9], PV→PQ reactive limits, inverter kVA-circle: all structurally correct.
- Implicit load buses, changeover rewrite, chain-collapse paths: verified logically on read.
- **F-1/F-2 are the exceptions on the cable-base path.**

### IEEE 1584 (arcflash.py)
- **2002**: Eq. 1 coefficients exact including the −0.00304·G·lg(Ibf) term; verified numerically Ia = 14.3441 kA (hand 14.3441) for the canonical 25 kA/480 V/25 mm case; Eq. 3-5 En/E chain: hand IE = 24.707 cal/cm² ≡ engine; K2 grounding −0.113; Cf 1.5/1.0; Table 4 x-exponents (1.473/1.641/0.973/2.0, [PS-4] cable class fix confirmed); MV Eq. 2 lg Ia = 0.00402+0.983 lg Ibf exact; §5.5 85% LV reduced current; documented 0.90 MV extension (conservative).
- **2018**: three-anchor regression structure, blend formulas (quadratic-in-1/I² below 600 V, linear between anchors), enclosure CF with shallow-box inversion and VCB height asymmetry — matches the standard's model as transcribed from the official validation spreadsheet (144k-row verified per provenance note). Boundary closed-form inverse algebra verified symbolically.
- Clearing time: IDMT constants, DT handling, inst. element min(t) logic, 0.08 s breaker opening, 2.0 s cap, fuse ×1.2 pre-arc→total, CB thermal t = k/(M²−1) with k = class×35 (t(6×Ir) = class seconds — verified by substitution).

### IEEE 80 (grounding_system.py)
- Tolerable touch/step (Eq. 33/34 form, 0.157/0.116 for 70/50 kg), C_s (Eq. 27), Sverak R_g (Eq. 57), K_m (Eq. 85) with K_h=√(1+h) convention, K_s (Eq. 93), K_i = 0.644+0.148n (Eq. 89), L_M Eq. 87/88 rod weighting, L_S = 0.75L_c+0.85L_rod, D_f (Eq. 79) with τ from κ — all verified against the standard's published forms.
- Conductor sizing (Eq. 37/41): constants match IEEE 80 Table 7 verbatim; **re-derived independently from c_v/α/ρ physics: k = 142.4 computed vs 143 published** (0.4% = rounding of α/ρ inputs).
- Two-layer ρ_eq via image series with exact limits (h→∞ → ρ1, h→0 → ρ2 through (1+K)/(1−K)); Wenner Sunde formula exact.

### IEC 60364 family (cable_sizing.py, db_circuit_check.py, iec_60364_tables.py)
- Adiabatic k constants re-derived from material physics: Cu/XLPE → computed 142.4 vs table 143 ✅; Cu/PVC 115, Al/XLPE 94, Al/PVC 76, BARE Cu/Al 129/84 (200 °C limit) all match published values.
- Volt drop: 3φ √3·I·L·(Rcosφ+Xsinφ) and 1φ 2× loop (db_circuit_check) — verified numerically identical to hand.
- Ambient derate √((Tmax−Ta)/(Tmax−30)): 40 °C XLPE → 0.913 (IEC 0.91) ✅.
- Ib≤In≤Iz §433.1, ECC Table 54.7 ladder (S≤16→S, ≤35→16, >35→S/2 + round-up), MCB B/C/D upper-band multiples 5/10/20, disconnection 0.4/5 s, RCD 50 V/IΔn alternative route, Zs = |Z1+Z2+Z0|/3 (exact identity from U0/Ik1) — all correct.
- IEC 60364-5-52 tables (B.52.x ampacity, ambient, grouping, soil, depth) spot-checked ≡ standard.
- NEC tables (310.16, 310.15(B)(1), (C)(1)) present for the NEC path.

### Other engines (verified on read + targeted probes)
- **voltage_stability**: λ-scaled P-V with bisection nose, v_floor collapse criteria, fictitious-condenser Q-V — methodology sound.
- **contingency**: element removal → full LF re-solve; ranking loss-of-supply > violations > secure; N-2 capping — sound.
- **hosting_capacity**: LF-scored sweep with fault-level screen + duty degradation check — sound.
- **opf**: merit order = marginal-cost sort (correct for linear costs); greedy Volt/VAR hill climb with lexicographic violation-first scoring — sound.
- **capacitor_placement**: LF-scored greedy bank placement, material-improvement gate — sound.
- **timeseries_loadflow**: SoC integration √η one-way with correct discharge/charge directions, clamps + warnings; flat profile ≡ single-shot LF by construction — verified.
- **battery_sizing**: IEEE 485-style factors (aging 1.25 = 1/0.8 EOL, design 1.10, K_temp from Table-1 shape), Peukert I_eff = I·(I/I_r)^(k−1) (the classic 2×-rate ⇒ H/2^k result), OCV(SoC) per chemistry — verified.
- **frequency_scan**: Z_kk(h) nodal sweep, per-h shunt scaling (X×h, B×h), resonance detection — sound.
- **filter_sizing**: **numerically verified** — X_C = X_eff·h_t²/(h_t²−1), X_L = X_C/h_t², R = (X_C/h_t)/Q reproduce exact resonance at h_t·f₀ and exact rated-kvar fundamental output (probe: 2 Mvar @ 11 kV, h_t 4.7 → resonance at 235.0 Hz exactly).
- **harmonics**: IEEE 519-2014 Table 1 voltage limits (5/8, 3/5, 1.5/2.5, 1/1.5) and Table 2 TDD bins (5/8/12/15/20% at 20/50/100/1000 Isc/IL) exact; VFD spectra typical-published; CIGRÉ type-2 load damping.
- **flicker**: see F-6 — fit for purpose.
- **line_coupling**: Carson De = 658.87√(ρ/f) = 931.8 m @ 100 Ω·m/50 Hz ✅; r_e = π²f10⁻⁴ = 0.04935 Ω/km ✅; Z0m = 3·z_m computed 0.148+j0.897 Ω/km — classic values; parallel-scale [1+(n−1)Z0m/Z0s]/n derivation verified.
- **transient_stability**: RK4 classic (dt/6·(k1+2k2+2k3+k4)); swing dω/dt = ωs/2H·(Pm−Pe−D·Δω) textbook; two-axis flux decay dE'q/dt = (Efd−E'q−(X'd−X″d)Id)/T'd0 etc. standard; droop on machine base; COI islands; IDMT operate-time integral (Σdt/t_op, trip at 1.0) — the standard induction-disk emulation; unbalanced-fault positive-sequence blocking of ground elements [D5] correctly reasoned.
- **unbalanced_loadflow**: Fortescque A/a matrices exact; **probe: balanced load → VUF = 0 exactly; 70/20/10 split → Va 0.9942/Vc 0.9992 sag on the loaded phase, VUF 0.252%** — physics correct (see F-3 for the Z0 fallback note).
- **dc_loadflow**: proper nodal conductance solve with converter/battery priority logic.
- **motor_starting**: Thevenin PQ-dip fixed point; starters star-delta 1/3, AT 0.64 = 0.8², soft 0.5, VFD ≈ FLC; LRC df forced to 1 [EE-5]; constant-PQ locked-rotor is a documented conservative approximation.
- **dynamic_motor_starting** (read): 2H dω/dt = Te−TL RK2, single-cage deep-bar fit to LRC/LRT — sound.
- **reliability**: IEEE 1366 SAIFI/SAIDI/CAIDI/ASAI/MAIFI/EENS formulas exact; λr default rates typical IEEE 493; connectivity FMEA per Billinton.
- **load_diversity**: Ks table ≡ IEC 60439-1 Annex H (2:0.9 … 50:0.52); coincidence-vs-diversity naming disclosed.
- **admd**: Beta(α,β) moments **re-derived from the Beta distribution** (mean a/(a+b)c, σ, skew 2(b−a)√(a+b+1)/((a+b+2)√ab)) — exact; Cornish-Fisher z + (z²−1)γ₁/6 — the standard first-order expansion.
- **backup_autonomy**: island walk, √η one-way energy, DoD floor — sound.
- **lightning_risk**: IEC 62305-2:2010 equations and all factor tables (A.1–A.5, B.2/B.3/B.7/B.9, C.2–C.6) match the standard.
- **dc_arcflash**: Stokes & Oppenlander R_arc = (20+0.534G)/I^0.88 verbatim; sustained-arc minimum voltage gate; fixed-point solve — correct.
- **raceway**: NEC Ch. 9 fill (53/31/40%), jam ratio 1.05·ID/OD with 2.8–3.2 band, B.52.17 grouping — correct.
- **conductor_temp**: R(T) = R₂₀(1+α(T−20)) idempotent with stashed base — correct; verified constants (Cu α 0.00393, ACSR 0.00403).
- **network_reduction**: multi-port Zbus at c=1 with zone-tracked cable bases — sound.
- **study_manager**: payload construction matches each engine's entry point; status extraction sane (incl. the ppe −1 = DANGER ≥ severity fix).
- **changeover**: rewrite preserves selected-input topology; open stub on the other input; case-snapshot propagation — verified on read.

### Frontend
- `constants.js` STANDARD_CABLES r_per_km values = IEC 60228 R₂₀ × 1.275 (Cu)/1.282 (Al) to 90 °C — verified for 16/50/95 mm² Cu and 95 mm² Al; 240 mm² matches the 60228 shaped-conductor base. Z0 ratios (r0 3.8×r1 MV Cu etc.) per the stated IEC 60502 convention.
- `tcc.js`: log-log transforms standard; relay/fuse curve evaluation via the same `idmtTripTime`/`fuseTripTime` the backend mirrors.
- `compliance.js`: Table 41.1 0.4/0.2/0.8 s bands at 132/253/440 V tolerance — correct per IEC 60364-4-41; minimum-current basis enforcement and per-curve disconnection-time evaluation ([PS-3]) present.
- `lightning.js`: twin match (F-8).
- `dbschedule.js`: way currents, worst-phase current, board-nominal referral — correct, backend-twin identical.
- `grid.js` `cleanNumber`: handles comma-decimal, thousands separators, currency/unit suffixes; no numeric corruption found in the parsing path.
- `plan-lux.js`: F-9.
- `rates.js`/`boq.js`: rule parsing and quantity arithmetic reviewed — rule application is lookup-based (no hidden arithmetic beyond count×length×factor patterns); no defects found.

---

## Test-coverage observations (non-blocking)

1. The regression suite (806 tests) is strong and standards-anchored. **Gap:** no test pins the F-1 cable-only-chain base case — an LV two-bus network with a default-props cable would catch it.
2. `test_smoke.py` etc. pass in the backend Docker image (Python 3.12). The host Python is 3.9 and cannot even import the package (`X | None` runtime annotations in `study_manager.py:99`) — harmless, but worth remembering when running tests outside Docker (documented in CLAUDE.md).
3. Six test modules error on collection in this environment for missing optional deps (`bcrypt`, `ezdxf`) — unrelated to calculations; excluded from the baseline run.

---

## Summary table

| ID | Severity | Engine | Issue |
|---|---|---|---|
| F-1 | **High** | loadflow.py | Cable-only chains use cable `voltage_kv` prop as pu base (756× under-impedance at LV with default prop); [EE-12] convention not propagated |
| F-2 | Medium | loadflow.py | Same root in `_get_impedance` — fix once, both resolved |
| F-3 | Low | unbalanced_loadflow vs fault | Z0 fallback 3.5× vs 3× divergence (only when no explicit r0/x0 props; disclosed in code) |
| F-4 | Low | fault.py | Inverter/wind sources absent from Ik steady-state (defensible; disclosure suggestion) |
| F-5 | Low | fault.py | κ≤1.02 → m=0 guard — verified correct, no defect |
| F-6 | Info | flicker.py | Planning-level Pst anchor — fit for purpose, disclosed |
| F-7 | Info | dc_shortcircuit.py | 61660-1 defaults verified |
| F-8 | Info | frontend/backend twins | All twin tables verified identical |
| F-9 | Info | plan-lux.js | Photometry exact |

**Recommended next step (when code changes are next permitted):** fix F-1/F-2 by routing the no-transformer chain branch through the same bus-zone voltage resolution the transformer branch already uses, and add an LV cable-only-chain regression test with a default-props cable.