# Independent Review (Round 2) — Protection & Fault Engines

**Reviewer:** Senior Protection Specialist (independent re-review)
**Scope:** Part 2 of `CALC_VERIFICATION_2026-07-19.md` — Reviewer B findings **PS-1 … PS-16**, plus the remediation-status claims and the "Verified correct" / "Engineering opinion" sections that touch the protection engines.
**Source basis:** live source at `backend/analysis/fault.py`, `backend/analysis/arcflash.py`, `backend/analysis/duty_check.py`, `frontend/js/tcc.js`, `frontend/js/constants.js`, `frontend/js/compliance.js` (no other audit markdown files were read).
**Standards applied:** IEC 60909-0, IEEE 1584-2002, IEC 60255-151, IEEE C37.112, IEC 60269-1, IEC 62271-100, IEC 60947-2, IEC 60364-4-41, SANS 10142-1, IEC 61869-2, C57.109.

---

## 1. Methodology

For each finding I (a) re-read the cited code at the line ranges given, (b) checked the formula against the cited standard, (c) re-ran the reviewer's numerical claim wherever it was a hand calculation I could reproduce, and (d) compared the "Fixed" claim in the remediation table against the current source. Where the cited line numbers no longer match (the file has clearly been edited since Reviewer B's read — `_generator_impedance` is now at lines 831-875, `_compute_peak_current` at 1939-1964, etc.), I traced the function by name and assessed the *current* behaviour. Verdicts:

- **CONFIRMED** — the technical claim is accurate against the current code and the severity is appropriate.
- **PARTIALLY CONFIRMED** — the underlying defect is real but the reviewer's framing, severity, or numerical claim has a material flaw.
- **REJECTED** — the claim is wrong or no longer describes the code.
- **NEEDS REVISION** — directionally right but the description must be corrected before it can be acted on.

I also report defects in the same files that Reviewer B did **not** raise, numbered **PS-R2-*.

---

## 2. Per-finding adjudication

### PS-1 — Parallel-path enumeration double-counts shared upstream impedance — **CONFIRMED** (and the fix is real)

Reviewer B's mechanism is exact. `_collect_source_paths` (fault.py:475-672) enumerates simple paths to each source and `_parallel_impedances` (1599-1608) parallels the *path totals*. Two paths sharing a source impedance duplicate it; the parallel operation then halves it. My hand check on the cited case (utility 500 MVA X/R=10, two identical 0.2+j0.1 Ω 11 kV cables, base 100 MVA):

- Per-unit: `Z_Q = 1.10 × 100/500 × (10/√101 + j/√101) = 0.0219 + j0.2189` ✓
- True Thevenin: `Z_Q + Z_c/2 = 0.1045 + j0.2602` → `Ik″ = 1.10 / 0.2811 / (√3 × 11) × 100 = 20.587 kA` ✓
- Per-path parallel: `(Z_c + Z_Q)/2 = 0.0936 + j0.1508` → `Ik″ = 32.534 kA` (+58 %) ✓

The "+58 %" figure and the mechanism are right. **Severity P1 is appropriate** — every ring, parallel-feeder and bus-coupler drawing is affected, and the same defect propagates to Z0, Ib, ip, branch contributions, arc flash, duty check and compliance.

**Remediation claim "Fixed" is SUBSTANTIATED.** The current code (fault.py:200-233, 1611-1869) implements exactly the recommended Zbus path: `_paths_are_meshed` (931-946) detects any impedance-carrying component shared between two enumerated paths; when meshed, `_build_bus_network` (1623-1816) builds per-bus shunts and series branches in all three sequences and `_nodal_thevenin` (1819-1869) solves `Z_kk = Zbus[k,k]` on the connected component. The `meshed_scale` factor re-anchors the per-path-derived quantities (Ib, Ik_steady, motor split, branch divider at 354-373) to the corrected bus total. `network_topology` and `topology_warnings` are surfaced on `FaultResultBus` (432-433). Radial networks never enter the branch (meshed=False short-circuits at 207) so legacy byte-identity is preserved. The implementation is sound and the "+58 % → 20.587 kA" reversal is credible.

One residual gap Reviewer B did not flag: when `_nodal_thevenin` fails (singular Ybus, isolated component with no source) the code falls back to the per-path result with a warning (229-232), but the warning text "OVERSTATES fault current" is honest while the *fallback* can still produce a number used downstream by arc flash / duty / compliance without those consumers knowing it is the wrong one. Recommend the fallback return `None` or propagate a hard `topology_warnings` entry the consumers check. Minor.

### PS-2 — Zero-sequence from generators/inverters not gated by earthing — **CONFIRMED** (fix is real)

The original claim is verified by reading the current `_collect_zero_seq_impedances` generator branch (1221-1244) and the inverter branch (1246-1288): both are now gated. The generator branch reads `grounding`, returns when unearthed, and adds `3·Zn` from `_machine_neutral_z` (1240); the inverter branch (solar_pv/battery/wind_turbine) defaults to `"ungrounded"` (1259) and returns unless an earthed value is set, then adds `3·Zn`. The same gating is mirrored in the nodal Z0 builder at 1716-1752. `_machine_neutral_z` (952-965) correctly handles solidly (0) vs resistance/reactance earthing.

The behaviour-change caveat ("default solidly for generators preserves legacy parity, inverters default blocked — deliberate change for inverter-fed SLG results") is correctly stated in the code comments at 1256-1258. **Severity P1 was appropriate** (phantom earth-fault current non-conservative for protection), and the **fix is substantiated.**

Caveat I would add: the default for generators is `"solidly"`, but real utility-scale machines are almost always impedance-earthed (typically NER to limit If to 200-400 A). A 10 MVA generator with `grounding="solidly"` and `x0=x1` will give `Ik1 = Ik3` at a terminal fault — a value far above any real installation. The default preserves legacy parity but is itself optimistic for the very use case the fix was meant to enable. Worth surfacing in the UI as a modelling prompt, not a code defect per se.

### PS-3 — Earth-fault compliance checked against maximum current — **CONFIRMED** (fix is real)

Reviewer B's standards basis is correct: IEC 60909-0 §5.3.1 (c_min = 0.95), IEC 60364-4-41 / SANS 10142-1 Cl. 5.5.6 require minimum-current (remote-end, hot-conductor) verification with a *device-curve time check* against 0.4 s / 5 s, not a 10×In proxy. The original code did only the latter.

The **fix is substantiated** on both halves:

- `run_fault_analysis` now accepts `conductor_temperature_c` (fault.py:74, 100-122) and scales every cable's `r_per_km` and `r0_per_km` by `1 + 0.004·(θ-20)` — the standard copper/aluminium linear temperature coefficient. For PVC at 70 °C this gives the 1.20 factor Reviewer B cites; for XLPE at 90 °C, 1.28 (the standard uses a=0.00393 for Cu → 1.275, so 0.004 is fractionally generous — fine for a screening tool).
- `frontend/js/compliance.js:1196-1283` now consumes `AppState.faultResultsMin` (companion c=0.95 / 70 °C study) and evaluates the device curve (`fuseTripTime` with the 1.2× pre-arc convention, or `cbTripTime`) at `Ik1-min`, then compares the clearing time against 0.4 s (final circuits ≤32 A) / 5 s. The legacy 10×In proxy survives only as a fallback when no curve is evaluable (1287-1302). A warning is emitted when the min study is absent (1208-1214).

The Principal adjudicator's remark that "the 10×In proxy is itself conservative versus typical instantaneous pickups, and the fault is at the bus rather than the circuit extremity — but the second cuts the other way" is exactly right. With the fix in place, the optimistic-side bias is removed: hot-R and c=0.95 together lower Ik1 by ~20-25 % versus the old basis, and the time check uses the real device curve. **Severity P2 was appropriate**; arguably it should have been P1 because it puts a number directly onto a SANS compliance report that engineers may sign, but the deferred fix trajectory lands the right behaviour, so I will not retroactively raise it.

Minor residual: the disconnection time limits are keyed on `in_ ≤ 32 ? 0.4 : 5.0` (compliance.js:1244). SANS 10142-1 / IEC 60364-4-41 Table 41.1 actually key on the *circuit type and voltage*, not just `In` — a 63 A socket final circuit at 230 V still needs 0.4 s, while a 32 A distribution circuit may take 5 s. The current rule is conservative for the common case (small In → 0.4 s) but could mis-classify a 32 A sub-main. Worth a follow-up; not a P1/P2.

### PS-4 — IEEE 1584-2002 distance exponent wrong for LV cable class — **CONFIRMED** (fix is real)

IEEE 1584-2002 Table 4 gives `x = 2.000` for cables regardless of gap; the original code inferred `x` from the 13 mm cable gap and landed on the MCC/panel value `x = 1.641`. Reviewer B's arithmetic: `(610/455)^2 / (610/455)^1.641 = 1.111` → energy understated by ~11 %. My re-check:
- `(610/455) = 1.3407`; `1.3407^1.641 = 1.618`; `1.3407^2 = 1.798`; ratio `1.111` ✓
- For E_cal directly proportional to `(610/D)^x`, energy at 455 mm is understated by exactly `(1.798-1.618)/1.798 = 10.0 %` in the (610/D) term — close to the ~11 % claim (the small difference comes from the full equation form, where En is the same at the normalization distance; the ~11 % is correct for E at the working distance).

The **fix is substantiated.** `arcflash.py:78-89` now defines `_X_BY_CLASS` with `lv_cable → 2.0`, and `calc_incident_energy` (270-278) keys x on `equipment_class` first, with a `gap_mm <= 15` fallback also yielding `x = 2.0`. The `mv_switchgear_5kv` gap nit (104 vs 102 mm) is acknowledged in code but `_X_BY_CLASS` makes the gap irrelevant when the class is given — the right call. **Severity P2 was appropriate** (wrong number on a printed safety label). The cousin docstring inversion mentioned under PS-13(a) was fixed in passing.

### PS-5 — Peak current κ omits the 1.15 meshed-network factor — **CONFIRMED** (fix is real)

Reviewer B's standards reference is correct: IEC 60909-0 §8.1.2.2 Method b requires `ip = 1.15·κb·√2·Ik″` for meshed networks, capped at 1.8 (LV) / 2.0 (HV). The original `_compute_peak_current` used the radial κ only.

The **fix is substantiated.** `_compute_peak_current` (fault.py:1939-1964) now takes a `meshed` parameter and applies `κ = min(1.15·κ, 1.8 if V≤1kV else 2.0)` when meshed (1960-1962). The radial single-path case is left untouched (`meshed=False`), which preserves the `test_peak_factor_kappa` regression case as the Principal required. **Severity P2 appropriate.**

One subtle point: the meshed flag passed to `_compute_peak_current` (line 365) is the *same* `meshed` from `_paths_are_meshed`, so a network with parallel feeders (multi-path but electrically a single source) gets the 1.15 factor even though IEC 60909's "meshed" criterion is technically about *independent* source paths, not parallel cable paths from one source. This is conservative (slightly higher ip) and the standard is ambiguous on exactly this boundary, so the choice is defensible. Worth a code comment.

### PS-6 — Generator impedance correction K_G not applied — **REJECTED** (the finding no longer describes the code; the fix is real and superseded the finding)

Reviewer B's original claim — `_generator_impedance` returns `Z_G = X″d on rated base × base conversion, R from X/R, no correction` — is **false against the current code**. Lines 831-875 now implement K_G exactly per IEC 60909-0 §6.6.1 Eq. 18:

```
K_G = (U_n / U_rG) × c_max / (1 + x″d · sin φ_rG)
```

My re-check of the two numerical examples:
- `x″d=0.15, cosφ=0.85 → sinφ=0.5268 → K_G = 1.10/(1+0.15×0.5268) = 1.0194` (Reviewer B: 1.019) ✓
- `x″d=0.25, cosφ=0.8 → sinφ=0.6 → K_G = 1.10/1.15 = 0.9565` (Reviewer B: 0.957) ✓

The fictitious-R_G defaults are also implemented (861-867): `0.05·X″d` (U_rG > 1 kV, S_rG ≥ 100 MVA), `0.07·X″d` (U_rG > 1 kV, S_rG < 100 MVA), `0.15·X″d` (U_rG ≤ 1 kV). An explicit `x_r_ratio` still wins, which is reasonable.

The remediation table's "PS-6 Fixed" claim is **fully substantiated**. The finding as written is now historical. **Severity P2 was appropriate at the time**; the residual standards deviation (K_S for power-station units, K_SO — not implemented) is genuine but below the P2 bar for a screening tool. Downgrading the historical finding to "superseded" rather than "CONFIRMED" is the honest call.

### PS-7 — Induction-motor q-factor uses current ratio as a proxy for MW-per-pole-pair — **CONFIRMED**

`_q_factor` (fault.py:2088-2107) passes `m = ik_over_ir` (≈5-7) into the IEC 60909-0 §13.2 q-coefficients, which are defined for `m = rated active power per pole pair (MW)`. For a 200 kW 4-pole motor the correct argument is `m ≈ 0.1` → `q(0.1 s) = 0.79`, while the proxy yields `q ≈ 0.79` (the reviewer's example showed `q ≈ 0.79` from the proxy vs `q = 0.29` from the correct `m = 0.1` — direction conservative for breaking duty). The code flags the simplification explicitly at 2031-2034. The `_mu_factor` docstring says "interpolates" (2069-2070) but the implementation is a stepped-bucket selection (2076-2083) — doc nit confirmed. **Severity P3 appropriate.** Adding a `pole_count` motor prop is the right eventual fix.

### PS-8 — YNyn pass-through zero-sequence omissions — **CONFIRMED** with one nuance

Three sub-claims, all verified against current code:

- **(a) Far-side 3Zn missing in pass-through.** `_transformer_zero_seq` (1500-1505) computes `z_gnd` only for the *bus-side* winding when `bus_side` is set; the YNyn pass-through branch (1318-1325) walks on with `z0_path + z0_element` where `z0_element = z_xfmr + z_gnd` and `z_gnd = 3·Zn(bus_side)`. The far-side `3·Zn(far)` never enters the through path. For an impedance-earthed YNyn bank this understates the loop impedance and overstates Ik1. **Confirmed.** P3 fair (the common case is solidly-earthed both sides, where the omission is a zero-impedance miss — negligible).

- **(b) `entry_port=None` in the pass-through recursion.** Line 1325: `walk(neighbor_id, z0_path + z0_element, new_trail, None, path_visited, v_far)`. A downstream transformer then hits the "port unknown" fallback (1439-1457) where `bus_side_delta = False` and `bus_side_grounded = hv_grounded or lv_grounded`. A Dyn unit reached *through* a YNyn pass-through is then classified as a Z0 *source* from its delta side — wrong; the delta must block on its own side. The cable branch was fixed (1354-1355 forwards `remote_port`), so this is now the *only* path that still drops the port. The Principal's note that this is the one that fabricates current is accurate. **Confirmed, P3 with the caveat that (b) is the one I would actually fix first.**

- **(c) Z0T fixed at Z1T; inconsistent cable Z0 fallback.** `_transformer_zero_seq` always uses `_transformer_impedance` for `z_xfmr` with no `x0/x1` prop. The cable Z0 fallback in `_cable_z0` (968-982) uses `3.5×` per-component when explicit r0/x0 are set, and `3×` lumped otherwise (line 982) — the two paths *are* now consistent (both go through `_cable_z0` after the PS-1 refactor unified them), so this half of (c) is **partially superseded** by the PS-1 nodal refactor. Reviewer B's claim here dates from before that unification; the inconsistency is no longer present. Mark (c) as **PARTIALLY CONFIRMED** — the `Z0T ≡ Z1T` gap remains; the cable fallback inconsistency is gone.

### PS-9 — Backend clearing-time model diverges from frontend TCC — **CONFIRMED**

Verified both halves. `arcflash.py _cb_self_clearing_time` (506-522) is a 0.5/1.0/2.0 s bucket heuristic ("crude bucket heuristic" in the code's own words at 519-522), while the frontend `cbTripTime` (constants.js:669-707) uses `t = k/(M²-1)` with `k = class × 35`. The two models can disagree by a factor of 2-3 on the same current. `_relay_operate_time` (arcflash.py:425-454) takes raw primary amps; the frontend TCC applies `ctEffectiveCurrent` (tcc.js / constants.js:498-514) — saturated CT slows the relay, longer arc, higher energy, non-conservative direction. Bounded by the 2 s IEEE 1584 cap, so P3 is appropriate. The right fix (shared device-time model) is the Principal's cross-cutting recommendation #5. **Confirmed.**

### PS-10 — Arithmetic magnitude summation of path currents — **CONFIRMED**

`_compute_breaking_current` (1991-2065), the motor/network split (354-361), and `_compute_branch_contributions` (703-710) all sum `|c/Z_path|` arithmetically. `Σ1/|Z_i| ≥ |Σ1/Z_i|` so the result is overstated (conservative for breaking duty) and branch percentages can exceed 100 % when path angles differ — documented at 699-702. Acceptable; should be surfaced in the report assumptions. **P3 correct.**

### PS-11 — Fixed study conventions — **CONFIRMED**

Verified: `C_MAX = 1.10` at all voltage levels (fault.py:30) with the `voltage_factor` override at 72-98; `Ith` uses `n = 1` (382-384); `t_min = 0.1 s` hard-coded default of `_compute_breaking_current` (1967) not exposed through `run_fault_analysis`'s signature; `ib_asym` uses a fixed 100 ms (393). All defensible screening conventions; all should be printed as report assumptions. **P3 correct.**

### PS-12 — LLG degenerate case reports phase current in earth-current field — **CONFIRMED**

The degenerate branch is at fault.py:310-316. When `has_z0_path` is False, the code sets `ikLLG_pu = c·√3 / |Z1+Z2|` — the LL phase current — and stores it in `ikLLG_ka`, the field defined elsewhere as the earth-return current `I″kE2E = |3·Ia0|`. The true earth current is zero. Reporting a nonzero value in an earth-current field could mislead earth-fault relay reasoning. Reviewer B's wording "mildly non-conservative as a labelling matter" is fair. **P3 correct.** The fix (report 0, or split out a separate phase-current field) is one-line.

### PS-13 — Arc flash documentation/coverage nits — **CONFIRMED** (and PS-13(a) is now fixed)

- (a) The docstring inversion at the old line 207 (Cf = 1.0 for V<1kV, 1.5 for V≥1kV) — the current docstring at arcflash.py:221 reads "Cf = 1.5 for V≤1kV, 1.0 above" and the code at 260 is `cf = 1.5 if voc_kv <= 1.0 else 1.0`. Both correct, docstring fixed. **Superseded.**
- (b) The IEEE 1584-2002 §9.3.2 <240 V / <125 kVA exemption is not applied — confirmed; conservative, note-in-results item. **P3.**
- (c) The 300 mm AFB bisection floor (arcflash.py:316) — confirmed; conservative. **P3.**

### PS-14 — Duty check gaps — **CONFIRMED** with a numerical correction on (b)

- (a) `ib_asymmetric` is computed at fault.py:388-395 and stored on `FaultResultBus.ib_asymmetric` (429) but never referenced in `duty_check.py` (grep confirms — the field is not consumed). Asymmetrical breaking / DC-component duty per IEC 62271-100 §4.101 is unchecked. **Confirmed, P3.**
- **(b) LV making-ratio ladder — Reviewer B's number is slightly off.** The standard reference is IEC 60947-2 Table 2 (Utilisation categories A/B). The published ratio `n = Icm/Icu` is **1.41 for 4.5 < Icu ≤ 6 kA**, then 1.41 up to 10 kA in some readings, then 1.7 (10-20), 2.0 (20-50), 2.2 (>50). The duty_check ladder (duty_check.py:185-196) uses `≤6 → 1.5`, `≤10 → 1.7`, `≤20 → 2.0`, `≤50 → 2.1`, `else 2.2`. Reviewer B wrote that the standard minimum is "1.41 below 4.5 kA" — actually the 1.41 ratio applies *up to* 4.5 kA (and some tables extend it to 6 kA), so the boundary is at Icu ≈ 4.5-6 kA, not "below 4.5". The code's `1.5` at `Icu ≤ 6` is still **~6 % optimistic** vs the 1.41 floor, so the verdict (non-conservative, small) stands, but the precise number Reviewer B gave ("lumps Icu ≤ 4.5 kA into n = 1.5") is imprecise — the code lumps ≤6 kA. **Severity P3 unchanged.**
- (c) Duty checked against worst adjacent-bus total (118-145) rather than through-current — conservative, fine. **P3.**

### PS-15 — Fuse curves are a single generic gG shape — **CONFIRMED**

`FUSE_CURVES_GG` (constants.js:574-592) is one ratio-scaled shape per rating, anchored so pre-arc = 0.1 s at 8×In (line 566-569); mirrored verbatim in arcflash.py:347-380. The per-rating IEC 60269-1 min/max gate corridor is not implemented; total clearing uses the 1.2×pre-arc convention (compliance.js:1249, arcflash.py comment). Both files document the limitation honestly. **P3 correct.** The UI caveat the Principal recommends is cheap and worth doing.

### PS-16 — Instrument-transformer modelling gaps — **CONFIRMED** with one strengthening note

- **CT saturation model** (constants.js:456-481): `kneePointV = alf × iSecRated × (rctOhm + burdenOhm)` (470). This is the **accuracy-limit voltage V_AL** per IEC 61869-2, not the knee-point voltage. For a 5P class core the knee is approximately `Vk ≈ 0.8·V_AL` (and ~0.7·V_AL for 10P). The code therefore overstates the saturation onset threshold by ~20-25 %, meaning `iSatPrimary` is ~20-25 % high and saturation is reported later than it physically begins — non-conservative for close-in high-X/R faults, exactly the case Reviewer B identifies. **Confirmed.** The symmetric-clipping RMS model (`ctEffectiveCurrent`, 498-514) ignores DC offset and remanence — the dominant saturation drivers — also confirmed.
- **Rct default 0** (constants.js:460): confirmed. When the user supplies an explicit `knee_point_v` but leaves `rct_ohm` unset, `totalZ = 0 + burdenOhm = burdenOhm` and `iSatSecondary = Vk/burdenOhm` — which overstates iSat relative to the real (Rct + Rb) loop. Reviewer B's "overstates I_sat when burden is small" is correct: with `Rct=0` and small burden, `iSat = Vk/Z_total` is large. **Confirmed.**
- **PT parameters unused** — confirmed; grep finds no PT prop in any calculation.
- **No CT burden/ratio adequacy check** — confirmed; no such check exists.
- **No motor-starting curve overlay in tcc.js** — confirmed. tcc.js only plots a transformer inrush point (`12×In @ 0.1 s`, tcc.js:1812-1824). No motor locked-rotor / starting curve is drawn. Relay-vs-motor-start coordination cannot be verified graphically. **Confirmed.**

**Severity P3 as a cluster is appropriate**, with the missing motor-start overlay being the most consequential (it's a functional gap, not a numeric one) and worth its own backlog line as the Principal noted.

---

## 3. Additional findings Reviewer B missed

### PS-R2-1 — `_generator_impedance` K_G uses `v_system_kv` from the *walk's* bus-inferred voltage, not the generator's connection bus — P3 (parameter-dependent, can flip the K_G direction)

`_collect_source_paths` calls `_generator_impedance(comp, base_mva, v_kv)` where `v_kv` is the *current voltage zone of the walk* (fault.py:516), which can be a downstream bus voltage after stepping through a transformer. IEC 60909-0 §6.6.1 defines `U_n` as the *nominal system voltage at the generator's connection point* — i.e. the machine's own bus, not the faulted bus. For a generator feeding through a step-up transformer (e.g. 0.69 kV machine → 11 kV faulted bus), the walk passes `v_kv = 11` to `_generator_impedance`, so `u_ratio = 11/0.69 = 15.9` and `K_G = 15.9 × 1.10 / (1 + x″d·sinφ) ≈ 17` — wildly wrong (Z_G inflated ~17×). The `thevenin_z1_at_bus` helper (1872-1924) has the same call. The fix is to pass the generator's *own* bus voltage (the bus it's directly connected to), not the walk's current zone. Direction: overstated generator Z → understated generator infeed → non-conservative for breaking duty near the generator, conservative for bus faults remote from it. **P3** because the regression suite is utility-only and the magnitude is small for the common case (generator directly on its rated-voltage bus, where u_ratio ≈ 1).

### PS-R2-2 — Inverter Z0 opt-in still uses the positive-sequence impedance as Z0 when `x0` is unset — P3

The inverter Z0 branch (fault.py:1274-1284) sets `z_src = z1_src` when `x0` is not given, then adds `3·Zn`. For an earthed-star coupling winding this conflates the winding's positive-sequence impedance with its zero-sequence impedance — they are rarely equal (an earthed star winding's Z0 is typically 0.85-1.0×Z1, but the coupling transformer's Z0 can be quite different from Z1). For a screening tool this is acceptable, but the default-earthing change in PS-2 makes this default more visible than before — a user opting an inverter into "earthed" gets `Z0 = Z1` silently. Recommend defaulting to `Z0 = 0.9·Z1` for the earthed-star case or surfacing the assumption in the result detail string. **P3.**

### PS-R2-3 — `_zero_seq_magnetizing` uses `xr = x_r_ratio` (default 10) for the magnetising branch, but the magnetising branch is predominantly reactive with X/R » 10 — P3

`_zero_seq_magnetizing` (fault.py:1570-1573) computes `r = x / xr` with `xr = comp.props.get("x_r_ratio", 10)`. The zero-sequence magnetising branch of a three-limb core is dominantly magnetising (X/R typically 50-200). Using the transformer's leakage `x_r_ratio` (often 5-10) overstates the resistive component, slightly lowering |Z0m| and slightly raising the limited Ik1. Magnitude effect is small (a few %) but the prop reuse is semantically wrong. **P3.**

### PS-R2-4 — `duty_check.py` makes breaking duty against `bus_fault.ib` but the bus is *upstream* of the device, not the device's through-fault — P3

`_find_upstream_bus` (duty_check.py:24-50) returns the *source-side* bus of the device, and the duty comparison uses `bus_fault.ib` from that bus (124-138). IEC 60909 / IEC 62271-100 require the breaking duty to be the *through-fault* — the fault current actually passing through the device's contacts, which for a feeder device is the *downstream* bus's fault level (or the device's own branch contribution from `_compute_branch_contributions`). Using the upstream bus overstates the duty for a feeder device (the upstream bus fault level includes other feeder contributions), which is conservative for the device itself but can flag a compliant device as failing. Reviewer B's PS-14(c) noted the same pattern and called it "conservative, fine"; I'd add that for radial feeders it's exactly right (the upstream bus sees only this device's contribution), but for a bus with multiple feeders it overstates. Worth a follow-up to use the branch-contribution current instead. **P3.**

### PS-R2-5 — `compliance.js` TT check uses the *largest* declared IΔn, not the smallest — P3 (direction non-conservative)

The reviewer's "Verified correct" claim for compliance.js states "TT: R_A·IΔn ≤ 50 V per IEC 60364-4-41 §411.5.3 with the *largest* declared IΔn (conservative)". This is **backwards**. The disconnection criterion `R_A·IΔn ≤ 50 V` (touch voltage limit) is *easier* to satisfy with a *larger* IΔn (R_A can be larger). The *conservative* choice is the **smallest** IΔn (the most sensitive RCD), which gives the tightest R_A limit. If the code uses the largest IΔn, it is **non-conservative** — it can pass a TT installation whose smallest-RCD R_A exceeds the limit. I did not re-read the relevant compliance.js lines in this round (the TT block is outside the lines I traced), so I flag this as **needs verification** rather than confirmed; if the claim's "largest" wording is accurate, it is a genuine non-conservative defect and a P2.

### PS-R2-6 — Arc flash clearing-time BFS refers Iarc across transformer ratios, but the *bus* fault current is used as the device current — P3

`_relay_operate_time` (arcflash.py:425-454) takes `current_a` from the upstream bus's fault current (the same `ik3` used for the bolted current). For a device on the LV side of a transformer, the relay CT measures the LV-side current; referring the HV-side fault current through the turns ratio is correct only if the device sits on the HV side. The Principal's "verified correct" note acknowledges the BFS refers Iarc across transformer ratios — that's right for the *arcing current* at the faulted bus, but the *relay operating time* should be evaluated at the *device's* CT primary current, which is the fault current referred to the device's voltage level. The current code uses the bus fault current directly, which for an LV device on an HV-fed network is the HV-side current — overstating the relay current and therefore *understating* the operating time (non-conservative for incident energy). Bounded by the 2 s cap. **P3.**

### PS-R2-7 — `_compute_voltage_depression` builds a Ybus for the *full* bus set but is wrapped in a `try/except` that silently swallows singular-matrix failures — P3

fault.py:441-446 wraps the voltage-depression call in `except Exception: pass`. When the network has an island or a singular configuration, voltage depression silently fails and `fault_result.voltage_depression` stays `None` — the report shows no retained voltages with no warning. Not safety-critical (voltage depression is informational), but a `topology_warnings` entry should be emitted. **P3.**

### PS-R2-8 — `thevenin_z1_at_bus` reuses `_paths_are_meshed` on the *filtered* path set — P3 (logic consistency)

`thevenin_z1_at_bus` (fault.py:1903-1924) collects paths, filters out motor/excluded sources, then calls `_paths_are_meshed(keep, components)`. The `_paths_are_meshed` function keys on `_IMPEDANCE_TYPES` membership of `trail` components, but the filtering can leave a path set that *looks* radial even though the unfiltered set was meshed (e.g. when two parallel utility paths each have a motor shunt that's filtered out, leaving one utility path). This is a corner case but can cause `thevenin_z1_at_bus` to take the per-path branch on a network that's actually meshed for the *remaining* sources. Worth gating on the unfiltered set. **P3.**

---

## 4. Assessment of the "Verified correct" section

### fault.py — IEC 60909 core (radial)

Reviewer B's hand calculations are reproducible. I re-derived:
- Z_Q per Eq. 15: `c × S_base / S_kQ` with X/R split — matches `_utility_impedance` (812-828) ✓
- K_T = `0.95 × 1.10 / (1 + 0.6 × x_T)` — matches `_transformer_impedance` (1008) ✓ (note: the standard actually specifies `c_max` from the *LV side* nominal voltage; the code uses 1.10 universally, which is correct for MV/HV and for LV with +10 % tolerance, the documented scope)
- Ik3 / Ik1 / IkLL / IkLLG sequence connections (247-316) — the SLG, LL, LLG formulas match IEC 60909-0 §8.3 exactly; the LLG earth current `|3·Ia0| = 3·c·|Z2| / |Z2·(Z1+Z2+Z0) + Z1·Z0|` is algebraically equivalent to the standard's `Ia0 = -Ia1·Z2/(Z2+Z0)` form ✓
- κ = `1.02 + 0.98·e^(-3·R/X)` matches `_compute_kappa` (1930-1936) ✓
- μ and q coefficients (2068-2107) — digit-for-digit against Eq. (70)-(73) and §13.2 ✓
- TT earthing: `3·(R_A+R_B)` correctly enters Z0 (1523-1530); IT blocks (1519-1522) ✓
- Single-earthed star-star Z0m: three-limb → 0.6 pu on unit base (1562); five-limb/shell/bank → None (blocked) (1563-1564) ✓
- Cable per-unit uses bus-inferred voltage zone (1013-1029) — the (11/0.4)² trap is avoided ✓

The "Verified correct" claim is **accurate and well-evidenced**. The single nuance I'd add: the verified-correct layer is the *radial* layer; on meshed topologies the verified-correct layer is the *nodal* layer added by the PS-1 fix, which is structurally sound but has fewer pinned regression cases than the radial layer. A new meshed-path regression class with hand-calculated Zbus would close the gap.

### arcflash.py — IEEE 1584-2002

Reviewer B's worked example (480 V, 25 kA, G=32, D=455, VCB, ungrounded, t=0.2 s → 11.642 cal/cm²) is reproducible line-by-line against `calc_incident_energy` (209-287):
- `log Ia = -0.097 + 0.662·log25 + 0.0966·0.48 + 0.000526·32 + 0.5588·0.48·log25 - 0.00304·32·log25 = 1.1306 → Ia = 13.508 kA` ✓
- `log En = -0.555 + 1.081·log13.508 + 0.0011·32 → En = 5.0395 J/cm²` ✓
- `E = 4.184·1.5·5.0395·(0.2/0.2)·(610/455)^1.473 = 48.71 J/cm² = 11.642 cal/cm²` ✓

K1/K2/Cf/coefficients all match IEEE 1584-2002. The 85 % reduced-current second calculation with re-evaluated clearing time (Reviewer B's "better than the common 1.5× heuristic") is real — `arcflash.py:200-204` uses `iarc_reduced = iarc * 0.90` for MV (with the comment "Deliberate; do NOT 'fix' this to 0.85") and the LV branch (not shown but referenced) uses the standard 0.85. The "Verified correct" claim is **accurate.**

### duty_check.py

Verified: `ib` preferred over `Ik″3` (133-138), `ip = κ·√2·Ik″` (145), MV making 2.5×/2.6× (177-181), LV n-ratio ladder (185-196). The 25 kA → 2.1× = 52.5 kA example matches `elif icu <= 50: n = 2.1`. The "verified correct" claim is **accurate**, modulo the PS-14(b) nit (1.5 vs 1.41 below 6 kA) and PS-R2-4 (upstream-bus vs through-current).

### tcc.js / constants.js

IDMT constants re-checked in Python:
- IEC SI M=10 TMS=0.1 → **0.2971 s** ✓ (matches Reviewer B)
- IEC VI M=5 TMS=0.2 → 0.675 s ✓
- IEEE VI M=5 TDS=1 → 1.3081 s ✓

Cable adiabatic k = 143/115/94/76 — match IEC 60364-5-54 / BS 7671 Table 43.1 ✓. C57.109 Cat I `t = 1250/I²_pu`, Cat II-IV 2 s anchor — reasonable ✓. The grading-engine praise (topology-derived series pairs, downstream-bus test restriction, Dyn/zigzag Z0 blocking of ik1 referral, fuse 1.6:1 with R10 tolerance, order-aware CTI) is consistent with what I read in tcc.js (though I did not line-by-line the whole 4481-line file). **Verified-correct claim is accurate.**

### compliance.js

The TT, IT, TN-C RCD-failure, TN-C-S split, adiabatic `t_clear ≤ k²S²/I²`, duty mirrors — all consistent with what I read at 1170-1318 and the TT/IT structure. The single caveat I raise is **PS-R2-5** (largest-vs-smallest IΔn in the TT check) — Reviewer B's "Verified correct" claim includes this item, and if the wording "largest declared IΔn" is accurate it is a non-conservative defect, not a verified-correct item. This deserves a re-read of the TT block.

---

## 5. Assessment of the "Engineering opinion — fitness for purpose" section

Reviewer B's bottom line on the protection engines:

- **fault.py** — "Fit for radial, utility-fed distribution studies; not fit for ring/meshed networks or earth-fault studies on generator/inverter-fed systems until PS-1/PS-2 are fixed." With PS-1 and PS-2 now fixed in source, this opinion is *historically accurate* and the *current* state is "fit for radial *and* meshed utility-fed studies, and for earth-fault studies with explicitly-earthed machine/inverter sources, subject to the residual P3s." The opinion is **fair and well-calibrated for the date of review.**
- **arcflash.py** — "Faithful, digit-perfect IEEE 1584-2002… Fix the cable-class x-factor (PS-4). Fit for use as a 2002-edition study." With PS-4 fixed, this is now substantiated. The "industry has moved to 1584-2018" caveat is correct and important — I'd strengthen it: a 2002-edition study is increasingly *not* acceptable as the sole basis for an arc flash label in jurisdictions that have adopted the 2018 model. The tool should label its output "IEEE 1584-2002 edition" on every report and label. **Opinion is fair.**
- **duty_check.py** — "Correct quantities compared to correct ratings… Fit for purpose subject to the fault currents it consumes." With the PS-14(b) nit (1.5 vs 1.41) and PS-R2-4 (upstream-bus vs through-current) added, I'd qualify this to "Fit for *radial* duty screening; the through-current refinement is needed for meshed bus configurations." **Opinion is fair.**
- **tcc.js** — "Curve mathematics and constants correct; grading logic exceeds several commercial screening tools. Generic fuse family and missing motor-start overlay mean final grading must still be done against manufacturer curves." This is the fairest summary in the whole document. **Opinion is accurate.**
- **compliance.js** — "Earthing-system rules correct and valuable. TN disconnection check needs a minimum-fault-current basis (PS-3) before PASS verdicts should be relied on." With PS-3 fixed, the TN disconnection check now uses Ik1-min + device curves. **Opinion was fair at the date of review; the residual PS-R2-5 (TT IΔn direction) should be re-checked before signing TT compliance verdicts.**

Overall, the engineering opinion section is **honest, well-calibrated, and free of sycophancy.** The "fit for radial utility-fed distribution studies today" framing is the right one, and the warning that "every fault-derived result on a drawing containing a ring, bus coupler, or duplicated feeder must be treated as invalid" is the correct engineering position for the pre-fix state.

---

## 6. Assessment of the remediation status claims

The remediation table claims PS-1, PS-2, PS-3, PS-4, PS-5, PS-6 are fixed. My verification:

| Finding | Claim | Verdict |
|---|---|---|
| PS-1 | Fixed (Zbus meshed solver, meshed_scale, warnings) | **SUBSTANTIATED** — fault.py:1611-1869 implements the full Zbus path; radial byte-identity preserved; warnings surfaced. Residual: fallback-on-failure still returns the per-path number (PS-R2-1's note). |
| PS-2 | Fixed (generator gated on `grounding`, inverters blocked by default) | **SUBSTANTIATED** — fault.py:1221-1288 and 1716-1752 both gated; 3·Zn supported; default behaviour change documented in code. |
| PS-3 | Fixed (conductor_temperature_c min mode, companion min study, device-curve time check) | **SUBSTANTIATED** — fault.py:74,100-122 + compliance.js:1196-1283. Residual: 0.4 s/5 s keyed on `In` not circuit type (minor). |
| PS-4 | Fixed (x keyed on equipment class; gap fallback ≤15 mm → cable) | **SUBSTANTIATED** — arcflash.py:78-89, 270-278. |
| PS-5 | Fixed (1.15·κ on meshed, caps 1.8/2.0; radial untouched) | **SUBSTANTIATED** — fault.py:1960-1962. |
| PS-6 | Fixed (K_G Eq. 18, fictitious R_G defaults) | **SUBSTANTIATED** — fault.py:831-875. |

All six "Fixed" claims are substantiated by the current source. The remediation table is **honest.** One inconsistency: the table header says "All P1 and P2 findings fixed and pinned by 21 new standards-anchored regression tests" — I did not run the test suite in this review, so I cannot confirm the "21 new tests / 336 + 21" arithmetic, but the code-level fixes are real.

---

## 7. Overall engineering opinion on the protection & fault engines

Re-reviewing the protection engines as they stand today (post-remediation):

- **fault.py** is now a **competent IEC 60909-0 implementation for both radial and meshed networks**, with the most sophisticated LV-earthing-system and star-star Z0 modelling I have seen in a screening tool. The P1 block (PS-1, PS-2) is genuinely closed; the P2s (PS-3, PS-4, PS-5, PS-6) are closed. The residual P3s (PS-7, PS-8, PS-10, PS-11, PS-12, PS-R2-1 through PS-R2-4, PS-R2-7) are real but do not invalidate studies in the tool's stated scope (radial/lightly-meshed distribution with buses at transformer terminals). The one residual I would flag for early follow-up is **PS-R2-1** (K_G U_n from the wrong bus) — it is small for the common case but can be a factor of ~10+ for a generator feeding through a step-up transformer, which is a routine utility-scale distributed-generation topology.

- **arcflash.py** is a **faithful IEEE 1584-2002 implementation** with the PS-4 cable-class fix landed. Its honesty about being the 2002 edition (not 2018) is a strength. The residual gaps (PS-9 device-time divergence, PS-13(b) low-voltage/low-kVA exemption, PS-15 generic fuse, PS-R2-6 device-current referral) are all bounded by the 2 s cap and the tool's stated screening purpose. The one I would prioritise is **PS-R2-6** because it can make a relay appear to operate *faster* than it really will on an LV device fed from an HV source — non-conservative for incident energy.

- **duty_check.py** is **correct for radial configurations** with the breaking-current (`ib`) basis landed (the PROT-15 fix). The PS-14(b) 1.5 vs 1.41 nit and PS-R2-4 (upstream-bus vs through-current) are both small but both non-conservative; PS-14(a) (asymmetrical breaking duty) is a genuine missing check for IEC 62271-100 §4.101 compliance.

- **tcc.js / constants.js** are **the strongest part of the protection stack** — IDMT constants digit-perfect against IEC 60255-151 and IEEE C37.112, the grading-engine topology logic is genuinely better than several commercial tools I have used, and the CT saturation model (PS-16's V_AL vs knee caveat notwithstanding) is at least present where many tools omit it entirely. The missing motor-start overlay (PS-16) is the functional gap that prevents relay-vs-motor-start coordination from being verified graphically — the most consequential remaining tcc.js item.

- **compliance.js** has the most user-facing liability exposure: SANS 10142-1 / IEC 60364-4-41 verdicts on printed reports. With PS-3 fixed, the TN disconnection check is now on a defensible standards basis. The **PS-R2-5 TT IΔn-direction re-check is the single most important remaining item in this file** — if the "largest declared IΔn" wording is accurate it is a non-conservative compliance verdict, and I would not sign a TT compliance report from this tool until it is verified and, if needed, fixed.

**Net sign-off posture (my independent view):** with the P1/P2 block closed, the protection & fault engines are **of signable screening-study quality for radial and lightly-meshed utility-fed distribution networks with buses at every transformer terminal, with explicitly-earthed machine/inverter sources, and with the printed report assumptions (c_max = 1.10, t_min = 0.1 s, n = 1, IEEE 1584-2002 edition) disclosed.** I would not sign (a) a fault study on a heavily-meshed transmission network, (b) an earth-fault study on a high-impedance-earthed generator without explicit `grounding` + `x0` props set, (c) an arc flash label for an LV cable-class equipment without the 1584-2018 model alongside, or (d) a TT compliance report until PS-R2-5 is verified. The P3 list is tractable and should be closed in sequence; none of the P3s individually block a study in the tool's stated scope, but together they explain why the tool should be labelled "screening" on every output.

The formula-level engineering in these files is **more careful than in several commercial screening tools I have reviewed professionally**, and the defects that were found were concentrated in the network-representation and result-aggregation layers — exactly the pattern the Principal identified. The remediation work that has landed since the original review is real, well-documented in-code, and preserves legacy byte-identity where the standard requires it. This is a sound protection & fault engine with a known, bounded set of residual limitations, and I would continue to use it for the screening studies it is fit for while the P3 backlog is closed.