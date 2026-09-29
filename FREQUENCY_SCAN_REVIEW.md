# Frequency Scan Review — `frequency_scan.py` (driving-point impedance vs frequency)

*Review date 2026-09-29. Method: `ENGINE_REVIEW_METHODOLOGY.md`. References:
closed-form RLC impedances (source ∥ capacitor, source ∥ single-tuned
filter), an independent nodal solve in **ohms with an ideal transformer**
(`v3_network.py`), the h_r = √(S_sc/Q_c) screening rule, and the standard
topographic definition of peak prominence. IEC 61000-3-6 sets no numeric
method for a frequency scan. It only recommends a resonance assessment, so
the fit is **Partial**. No reference was taken from the module or its tests.*

## 1. Scope

`run_frequency_scan` sweeps h from 1 to h_max. At each step it builds the
harmonic network shared with `harmonics.py` (`_branch_chains`,
`bus_shunt_admittance`, `_build_yh`), inverts Y_h and reads Z_kk(h) for each
scanned bus. It then finds the parallel resonances (peaks) and series
resonances (dips) and ranks them. The review covered:
- the curve against closed forms and a hand nodal solve;
- how peaks and dips are detected, located and valued;
- the ranking across voltage levels;
- which network is scanned: dead islands, SVC operating point, idle
  generators, switched banks;
- the branch model's transformer ratio (shared with harmonics);
- units, rounding and the results modal.

Scratch scripts `v1_parallel.py` … `v8_harmonics_ratio.py` are the evidence.

## 2. What holds up

| Checked against | Result |
|---|---|
| Source ∥ capacitor, \|Z(h)\| over the whole sweep, X/R 5 to 10⁴ | max relative error 4 × 10⁻⁶ (output rounding) |
| Parallel resonance location vs √(S_sc/Q_c) and vs a dense search | exact (lossless h_r = 5.000, 7.071; damped peaks at the dense-search order) |
| Source ∥ single-tuned filter: series dip at h_t, parallel peak at √(X_C/(X_s+X_L)) | curve 1 × 10⁻⁵; peak and dip at the dense-search orders |
| 11 kV / 2 MVA / 0.4 kV network with a cable, load, board and motor, matched nameplates, at every bus | exact (0.000 % after the rounding fix) |
| Scale invariance: 11 kV / 100 MVA, 11 kV / 10 MVA, 33 kV, 0.4 kV / 1 MVA | identical per-unit peak and order |
| Distribution board = static load of the same kVA (H2 shared model) | identical curves |
| 60 Hz system | f = h·60, same h |
| A STATCOM is not a resonance driver (H3 shared model) | confirmed |

## 3. Findings

### FS1 — the "worst resonance" was ranked in ohms across voltage levels — `run_frequency_scan` (sort)

A harmonic current I_h in per unit of the study base raises V_h = Z_pu·I_h.
So Z_pu is what compares buses at different voltages. Ohms scale with U²,
so every 11 kV peak outranked every 0.4 kV peak. `v7_ranking.py` has an
11 kV bus with a 1.5 Mvar bank and a 1 MVA transformer to a 0.4 kV bus with
400 kVAr of PFC:

| Resonance | h | \|Z\| (Ω) | \|Z\| (pu) |
|---|---|---|---|
| 0.4 kV bus | **6.78** | 0.638 | **398** |
| 11 kV bus | 13.72 | 21.66 | 17.9 |
| Headline, before | 11 kV at h 13.7 | | |
| Headline, after | **0.4 kV at h 6.8** | | |

**Non-conservative.** The LV resonance sits beside the 7th harmonic, a
characteristic order of every 6-pulse drive, at 22 times the per-unit
impedance. The headline, the ◆ curve and the chart markers all pointed at
the benign MV peak. Mixed-voltage networks are the normal case.

**Fix.** Resonances are now ranked by `z_pu`. The result also carries
`worst_z_pu` and `base_mva`. The modal adds a per-unit column and plots per
unit when the scanned buses have different voltages.

### FS2 — peak |Z| and order were read off the sample grid — `_detect_resonances`

The reported resonance was the largest sample. Near a resonance |Z| changes
over a band of width about h_r/Q. If that band is narrower than the step,
the sample can land well down the flank. `v1_parallel.py`:

| Case (default Δh 0.05) | True peak | Before | After |
|---|---|---|---|
| 100 MVA X/R 15, 4 Mvar (h 5.006) | 453.79 Ω | 447.63 (−1.4 %) | 453.79 |
| 100 MVA X/R 15, 1 Mvar (h 10.011) | 1815.04 Ω | 1722.09 (−5.1 %) | 1815.04 |
| Near-lossless, 2 Mvar (h 7.071) | > 5 × 10⁵ Ω | 1433.7 (−99.7 %) | 6.0 × 10⁵ |

The ranking uses the peak |Z|, so one resonance could outrank a sharper
one. The order is also limited to ±Δh/2.

**Fix.** Each detected extremum is refined by a golden-section search of
the exact Z_kk(h) between its neighbouring samples, to a tolerance of
10⁻⁵ in h. The detector itself is unchanged. The refinement cannot return a
worse value than the sample it started from.

### FS3 — transformer turns ratio left out of the harmonic network — `harmonics._branch_chains` / `_build_yh` (shared)

The chain model summed per-unit R + jX with no ideal transformer. That is
right only when the turns ratio equals the drawn bus ratio. Two common cases
break it:
- every LV unit in the shipped library is 11/0.42 kV on a 0.4 kV bus;
- any transformer with a tap.

In both, the network beyond the transformer was referred through the bus
ratio instead of the turns ratio. The load flow stamps the ratio
(`_reduce_chain_two_port`), and so does `network_reduction`. Only the
harmonic network did not. `v3_network.py` gives the error against a hand
solve in ohms with an ideal 11/0.42 transformer:

| Bus | \|Z\| error, before | Parallel peak h, before → after (reference) |
|---|---|---|
| 0.4 kV | up to 2.7 % | 10.28 → 10.229 (10.229) |
| 0.4 kV far end | up to 12.7 % (near the dip) | 9.75 → 9.700 (9.700) |
| 11 kV | up to 3.6 % | — |

The harmonics study shares this network. `v8_harmonics_ratio.py`:

| Case | HV THD_V, before | HV THD_V, after |
|---|---|---|
| 11/0.42 kV | 1.17 % | 1.22 % |
| 11/0.42 kV, tap −5 % | 1.11 % | 1.21 % |

So the old model was mildly non-conservative at HV.

**Fix.** A chain whose local ratio is off-nominal now carries its elements
in electrical order: `(R, X, t, hv_near_a)`, with the ratios from the load
flow's `_walk_chain_zones`. `_chain_block` stamps each transformer as the
load-flow π (y/t², y, −y/t) and Kron-reduces the internal junctions at each
h, which is exact. Chains at nominal ratio keep the plain series sum, so
their results are unchanged (the harmonics suite passes unchanged).

### FS4 — dead islands were scanned — `run_frequency_scan`

A capacitor bank behind an open breaker, with a motor on the same dead bus,
resonated with the motor's X″ (`v4_probes.py` P3: h 2.85, 146 Ω). It was
reported like any live resonance and could head the results. A bus with no
source carries no voltage, so it has no harmonic impedance of interest.

**Fix.** The scan now runs the fundamental load flow once, through the new
shared `harmonics.fundamental_operating_point`. Buses the load flow reports
de-energised are not scanned, and they are named in a warning. If the load
flow raises, every bus is taken as live, as before.

### FS5 — a voltage-regulating SVC contributed nothing — `run_frequency_scan`

This was carried over from `HARMONICS_REVIEW.md` H3 (BACKLOG #5). The scan
had no load flow, so a regulating SVC, which has no fixed Q, was a zero
shunt. The same load flow as FS4 now supplies its solved output as a
susceptance. A 4 Mvar SVC at full capacitive output now resonates at
h 5.13, against √(100/3.85) = 5.10 lossless.

## 4. Lesser notes

- **L1. Peak prominence (fixed).** The col was taken as the minimum over
  the whole side of the curve, reaching past a larger neighbouring peak to
  the low Z(1). A ripple on that peak's shoulder then passed the 2×
  threshold: 5.3× by the old rule, 1.95× by the standard definition. The col
  is now the lowest point before a higher peak (a deeper dip for series
  resonances), which is the definition the docstring already claimed.
- **L2. The "no capacitor" warning (fixed).** It fired on component type.
  A bank with no steps in service, a bank on a dead island, or an idle or
  inductive SVC suppressed the warning. It now tests whether a live shunt's
  susceptance grows with h.
- **L3. Resonance above h_max (warned).** A curve still climbing at the top
  of the sweep on a network with capacitance means a resonance may lie
  above h_max. It was silent; now it is a warning.
- **L4. Rounding (fixed).** Values were rounded to fixed decimals: z_ohm to
  5, z1_ohm and peaks to 4. A 0.4 kV Z(1) of 0.0057 Ω kept two digits
  (±1 %), and the modal showed "0.006" and "0.00" decade labels. Both now
  use significant figures.
- **L5. The empty result reported 50 Hz** whatever the project frequency
  (fixed).
- **L6. Idle generators (warned, not changed).** A generator with a closed
  breaker is part of the source impedance even when the load flow leaves it
  at 0 MW in standby. A 10 MVA set moved h_r from 5.0 to 6.48 (`v6_standby.py`).
  This follows the app's convention that the breaker, not the dispatch
  mode, decides whether a machine is on line (fault study, transient
  stability). The scan now names such generators and says to open their
  breakers to scan the grid-only case. Scanning both states automatically
  is a possible follow-up.
- **L7. Documented simplifications, unchanged:**
  - positive-sequence and balanced only, so the triplen and zero-sequence
    network is not scanned;
  - no cable capacitance (BACKLOG, line charging);
  - R constant with h;
  - no transformer magnetising or stray capacitance;
  - capacitor `voltage_kv` is not used. The rating is taken at bus voltage,
    as in the load flow;
  - at most 12 buses per scan (warned).
- **L8. Near-lossless peaks** are bounded only by the modelled resistance:
  the X/R 10⁴ cases above report 3 × 10⁵ to 6 × 10⁵ Ω. Real networks have
  load damping, and the model includes loads, so this matters only for
  idealised inputs.

## 5. Behaviour changes for saved projects

Frequency scan results are not saved, so the next run shows the new
behaviour. Harmonics results are saved and not recomputed on load. Re-run
the harmonics study on any project with a transformer whose rated ratio
differs from its drawn buses or that has a tap (FS3). That covers every
11/0.42 kV library unit on a 0.4 kV bus. HV THD rises by a few percent of
its value.

## 6. Tests

`backend/tests/test_frequency_scan_review_fixes.py` has 15 tests: FS1–FS5
and L1–L6, each against a closed form or a hand solve in ohms. The existing
`TestFrequencyScan`, `TestHarmonics`, `TestFilterSizing` and
`test_harmonics_review_fixes.py` pass unchanged. One fixture in
`test_sibling_engine_lf_parity.py` now unpacks the new chain tuple.
