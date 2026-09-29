# Harmonics Review — `harmonics.py` (harmonic current-injection study)

*Review date 2026-09-29. Method: `ENGINE_REVIEW_METHODOLOGY.md`. References:
IEEE 519-2014 Tables 1–4 (reviewer's reading of the published text), an
independent 2-bus nodal solve written in the scratchpad (`v1_reference.py`,
`v6_new_models.py`), and first principles for the element models. No IEC
61000 copy is in `IEC Standards/`, so the IEC limit values added here are the
published values as the reviewer read them. Confirm them against a licensed
copy of IEC 61000-3-6:2008 Table 2 and IEC 61000-2-4:2002 Tables 2–4. No
reference was derived from the module or its tests.*

## 1. Scope

`run_harmonics` treats each VFD as a harmonic current source. The source is
I_h = (I_h/I_1)·I_1, with the spectrum chosen by pulse number and reactor.
The engine solves Y_h·V_h = I_h at each order and reports three things:
- per-bus IHD and THD_V;
- the current into the utility, as TDD against I_L;
- a compliance verdict.

The shunt model (`_shunt_admittance_at_h`) and branch model (`_branch_chains`)
are shared with `frequency_scan.py`. `filter_sizing.py` re-runs this engine to
verify its designs. The review covered:
- the network model: sources, machines, lumped loads, capacitors, tuned
  filters, SVC/STATCOM and branches;
- the indices;
- the IEEE 519 limit tables;
- degenerate topologies;
- whether IEC limits should be offered (they now are; decision 2026-09-29).

## 2. What holds up

| Checked against | Result |
|---|---|
| Independent nodal solve: 250 MVA utility → 11 kV → 2 MVA 6 % → 0.4 kV, 800 kW 6-pulse drive, 1 MVA load, 250 kVAr PFC | every order of IHD at LV and HV matches to 1e-3 %; THD_V 11.309 vs 11.31, 1.307 vs 1.31 |
| TDD and Isc/IL formulas | 24.731 vs 24.73; 135.11 vs 135.1 |
| Parallel resonance near h_r = √(S_sc/Q_c) | h_r = 10.85 in the case above; the 11th is the amplified order |
| IEEE 519-2014 Table 1 voltage limits (5/8, 3/5, 1.5/2.5, 1/1.5) | correct |
| Table 2 and Table 3 TDD columns | correct (Table 3 = Table 2 halved) |
| Tuned-filter synthesis X_C = X_eff·h_t²/(h_t²−1), X_L = X_C/h_t², R = (X_C/h_t)/Q | the net fundamental reactance equals the rating exactly |
| Scale invariance: base 10 vs 100 MVA, 11 vs 33 kV HV | identical |
| Rated-ratio zones of transformer z% and cables (shared with load flow) | as reviewed in the load-flow review |

## 3. Findings

### H1 — only TDD was checked; the individual current limits were not — `harmonics.py` (PCC verdict)

IEEE 519 Tables 2–4 limit **each order** as a % of I_L, in bands of order,
and even orders at 25 % of the odd limit. The engine compared only the total.
`v3_ieee519.py`, a 12-pulse 800 kW drive with 100 kVA of other load:

| | Engine (before) | IEEE 519 Table 2 (Isc/IL 263) |
|---|---|---|
| TDD | 9.62 % — pass | limit 15 % — pass |
| 11th | not checked | 7.48 % vs 5.5 % — **fail** |
| Verdict | compliant | **not compliant** |

**Non-conservative.** A 12-pulse drive moves its energy into the 11th/13th,
and the 11–17 band limit is less than half the h < 11 limit, so this is the
normal failure mode for such a drive.

**Fix.** Tables 2, 3 and 4 are now held in full (`_IEEE519_T2/T3/T4`) and
`_current_limit(h, Isc/IL, kV)` checks every order. The PCC result carries
`harmonic_limits` and `exceeding_orders`, and the results modal shows each
order against its limit.

### H2 — a distribution board's load was ignored — `harmonics.py` (shunts, I_L)

A distribution board is a node carrying its own lumped load. The load flow
injects that load explicitly. The harmonics engine only walked components
connected *at* the node, so the board's load contributed neither harmonic
damping nor I_L. `v2_probes.py` P3 draws the same 1000 kVA as a board instead
of a static load:

| | Static load | Board (before) | Board (after) |
|---|---|---|---|
| LV THD_V | 11.31 % | 97.98 % | 11.31 % |
| TDD | 24.73 % | 306 % | 24.73 % |
| Isc/IL | 135.1 | 294.0 | 135.1 |

Every building project models its loads as boards, so the missing damping
put resonance peaks at their undamped height. Missing I_L also moved the
Isc/IL row, so the verdict could go either way. The frequency scan had the
same omission.

**Fix.** A new `bus_shunt_admittance` adds a board's own load, using the same
lumped-load model as a static load. The harmonics study and the frequency scan
now both call it. Board loads also count in I_L.

### H3 — a STATCOM, and a voltage-regulating SVC, were modelled as a capacitor of their full rating — `_shunt_admittance_at_h`

The palette default is a STATCOM in voltage-regulating mode with
`q_output_mvar: 0`. The engine fell back to `rated_mvar` (a hidden 50) and
treated it as capacitance (B·h). The default device was therefore a 50 Mvar
capacitor. Physically:
- a **STATCOM** is a voltage-source converter. At harmonic orders it is its
  coupling reactance to an internal source that holds no harmonic voltage,
  i.e. an inductive shunt X_c·h, whatever its fundamental output;
- an **SVC** is a susceptance at its operating point.

`v2_probes.py` P1, the reference network with a STATCOM on the 11 kV bus:

| | HV THD_V |
|---|---|
| none | 1.31 % |
| 2 Mvar STATCOM idle, before | 3.26 % (phantom resonance) |
| 2 Mvar STATCOM, after (X_c 0.15 pu) | 1.24 % |
| 50 Mvar STATCOM, before / after | 0.19 % / 0.58 % (after matches a hand solve exactly) |

**Fix (decision 2026-09-29: coupling-reactance prop).**
- **STATCOM:** a new prop `coupling_x_pu` (default 0.15 pu) on the
  converter rating. The rating is the larger of |Q max| and |Q min|, the
  limits the user edits; `rated_mvar` only seeds them.
- **SVC:** uses the Q the fundamental load flow solved, as a susceptance
  Q/V². Fixed-Q mode uses its set output. It never uses the rating.
- **Frequency scan:** has no load flow, so a regulating SVC there contributes
  0 (noted for the #14 review).

### H4 — a drive on a de-energised island still injected — `run_harmonics`

Behind an open breaker the load flow gives the bus V = 0 and
`energized = False`. The engine read `voltage_pu` 0 as falsy, used 1.0, and
injected the drive's full spectrum into an island with no source (P4):
- THD 21.7 % on the dead bus;
- 3.3 × 10⁹ % with nothing else on it, through the 1e-9 regularisation;
- the overall verdict turned to fail.

**Fix.** Drives on de-energised buses are left out and named in a warning.
De-energised buses are not graded. If the load flow fails, every bus is taken
as live, the legacy behaviour.

### H5 — > 161 kV current limits were Table 2 × 0.25 — `_tdd_limit`

Table 4 has its own rows: Isc/IL < 25, 25–50 and ≥ 50, with TDD 1.5, 2.5 and
3.75 %. It is not a scaled Table 2:

| Isc/IL | 10 | 22 | 30 | 60 | 150 | 2000 |
|---|---|---|---|---|---|---|
| Table 4 | 1.5 | 1.5 | 2.5 | 3.75 | 3.75 | 3.75 |
| before | 1.25 | 2.0 | 2.0 | 3.0 | 3.75 | **5.0** |

The old scale was lenient at Isc/IL 20–25 and above 1000. It is rare in
practice (a > 161 kV PCC with drives on it). **Fix:** Table 4 is now held
verbatim; Table 3 already matched.

### H6 — `demand_factor: 0` read as 1 — `run_harmonics`, `_shunt_admittance_at_h`

`df = p.get("demand_factor", 1.0) or 1.0` turned an explicit 0 into 1 for the
drive's injection and the static-load shunt. The load flow reads 0 as 0. So a
drive the load flow says draws nothing still injected its whole spectrum
(P10: LV THD 11.1 % instead of 0). **Fix:** `_num()` keeps an explicit 0.

## 4. Lesser notes

- **L1. The PCC current included generators on the PCC bus (fixed).** IEEE
  519's PCC current is what flows into the utility. A site generator on the
  same bus is on the customer's side. The engine summed both shunts, which
  overstated TDD by about 13 % with a 5 MVA generator (24.75 vs 21.85 %, hand
  solve 21.848). Now the utility only.
- **L2. Several utilities (warned).** Only one PCC is evaluated. It is now
  the first utility drawn, not the last found, and the others are named in a
  warning. I_L is the whole network's load, which is right for one PCC only.
- **L3. The rotating share of a lumped load (fixed).** `motor_fraction`,
  which the fault study already reads, now becomes an induction-motor
  X″ = 1/LRC sink. The rest stays parallel R–L, and both are
  demand-factored. Verified against a hand solve (15.723 vs 15.72 %).
  Absent or 0 leaves the result unchanged.
- **L4. Documented simplifications, unchanged:**
  - R does not vary with frequency (no skin effect). This is conservative:
    less damping gives higher peaks.
  - Transformer phase shift is not applied, and same-order sources add in
    phase. Also conservative: it overstates totals where Dy/Yy pairs cancel.
  - Cable shunt capacitance is omitted ([EE-14]). **Not** conservative for
    tens of km of MV cable, which moves the resonance.
- **L5. I_L is demand-factored connected load, not the 12-month maximum
  demand of IEEE 519 §3.** Motors now carry their demand factor too, as in
  the load flow.
- **L6. IEEE 519 voltage limits are applied at every bus.** The standard sets
  them at the PCC, so internal buses are being screened against a PCC
  criterion. This is stated in the results footnote.
- **L7. An SVC on the swing bus reports that bus's whole reactive injection**
  in `loadflow.py`'s `svc` summary: 0.55 Mvar with nothing to regulate, which
  is really the utility's supply of the load's Q. The harmonics study takes
  this as the SVC's output. It is a load-flow reporting issue, recorded for
  that module.
- **L8. Drive spectra are typical manufacturer values, not a standard.** The
  per-set THD comments check out (39 % for a 3 % reactor, 83 % with none).
  IEC 61000-3-12 sets equipment emission limits, not spectra, so there is no
  standard to test them against.

## 5. IEC limits (added)

A new study setting `harmonicsLimits` has two values: `"ieee519"` (the
default) or `"iec"`. It is saved with the project and chosen in the results
modal. In IEC mode:

| Bus | Basis | Per order | THD_V |
|---|---|---|---|
| ≤ 1 kV | IEC 61000-2-4 Class 2 compatibility level (= IEC 61000-2-2 public LV) | 5: 6, 7: 5, 11: 3.5, 13: 3; 17–49: 2.27·17/h − 0.27; triplen 3: 5, 9: 1.5, 15: 0.4, 21: 0.3, else 0.2; even 2: 2, 4: 1, 6, 8: 0.5, else 0.25·10/h + 0.25 | 8 % |
| 1–35 kV | IEC 61000-3-6 MV indicative planning level | 5: 5, 7: 4, 11: 3, 13: 2.5; 17–49: 1.9·17/h − 0.2; triplen 3: 4, 9: 1.2, 15: 0.3, else 0.2; even 2: 1.8, 4: 1, 6: 0.5, else 0.25·10/h + 0.22 | 6.5 % |
| > 35 kV | IEC 61000-3-6 HV-EHV planning level | 5, 7: 2, 11, 13: 1.5; 17–49: 1.2·17/h; triplen 3: 2, 9: 1, 15: 0.3, else 0.2; even 2: 1.4, 4: 0.8, 6: 0.4, else 0.19·10/h + 0.16 | 3 % |

Each order is graded against its own limit. Each bus reports its critical
order (the one nearest its limit) and its basis. The PCC current is reported
but **not graded** in IEC mode. IEC 61000-3-6 allocates emission to each
customer from planning data the model does not hold (agreed power S_i, supply
capacity S_t, transfer coefficients); stage 2 allocation is a possible
follow-up.

Filter sizing is labelled and designed to IEEE 519, so it passes
`limits="ieee519"` explicitly and the project setting does not change it
(pinned by a test).

## 6. Behaviour changes for saved projects

Saved harmonics results are not recomputed on load, so re-run the study. It
changes when a project has any of:
- distribution boards (H2);
- an SVC/STATCOM (H3);
- a drive on a dead island (H4);
- `motor_fraction` on a lumped load (L3);
- a generator on the PCC bus (L1);
- motor demand factors (L5).

A verdict can also turn to fail when an individual order exceeds its limit
(H1). The frequency scan changes for boards and STATCOMs.

## 7. Tests

`backend/tests/test_harmonics_review_fixes.py` has 15 tests. Each reproduces
a finding against IEEE 519 table values or a hand nodal solve. The existing
`TestHarmonics`, `TestFilterSizing` and `TestFrequencyScan` pass unchanged.
