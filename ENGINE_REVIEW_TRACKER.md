# Engine Review Tracker — correctness against IEC standards

Module-by-module status of the independent engine reviews. Each review follows
`ENGINE_REVIEW_METHODOLOGY.md`: derive the answer from the **standard itself**
(its equations, tables and worked examples) or from first principles, never
from the module's own tests; report, then fix with `[ID]` markers and one
regression test per finding.

*Created 2026-09-28. Update this file when a review lands (status, date, PR,
write-up).*

**Status:** ✅ reviewed · 🟡 partly reviewed · ⬜ not reviewed

**IEC fit:** **Direct** — the module implements an IEC standard, so review
against its clauses and worked examples. **Partial** — IEC governs the inputs
or limits, not the method. **None** — no IEC standard applies (IEEE / national
standard, or first principles only); the review checks against that instead.

---

## Done

| Module | Status | IEC fit | Standard(s) reviewed against | Scope covered | Review / PR |
|---|---|---|---|---|---|
| `fault.py` | ✅ 2026-09-28 | Direct | IEC 60909-0:2016, IEC TR 60909-1:2002, IEC 60909-4 examples | I″k 3Φ/SLG/LL/LLG, ip (κ), Ib (μ, q), Ith (m, n), K_T / K_G / fictitious R, steady-state Ik (λ, §4.6), motor & converter contributions, series / simultaneous faults, voltage depression, rated-ratio referral; generator Z0 default, sync-motor K_G, induction-motor X″ from LRC | `FAULT_ENGINE_REVIEW.md` (F1–F9, L1–L8), PR #331; `GENERATOR_MOTOR_REVIEW.md` (MG4, N6, N8), PR #332. **Not covered:** Z0 of impedance-earthed YNyn, autotransformer Z0, meshed Ib/Ik scaling, K_S for power-station units (L2) |
| `motor_starting.py` | ✅ 2026-09-28 | Partial | IEC 60034-12 (starting performance), IEC 60909-0 impedances; method per IEEE 3002.7 | Starting current per starter, constant-Z locked-rotor dip, Thevenin superposition, torque run-up, island handling | `GENERATOR_MOTOR_REVIEW.md` (MG7–MG8, N1–N3), PR #332 |
| `dynamic_motor_starting.py` | ✅ 2026-09-28 | Partial | IEC 60034-12; IEEE 3002.7 | Nameplate circuit fit, swing equation, starters, rotor I²t, stall/crawl, running motors, voltage bases | `GENERATOR_MOTOR_REVIEW.md` (MG2–MG3, MG6, MG9–MG10, N4–N5), PR #332 |
| `transient_stability.py` | ✅ 2026-08-02 | None | Kundur / IEEE 1110 machine models, IEEE 421.5 exciters, IEEE governor models; equal-area criterion | Machine init, two-axis / sub-transient, governors, exciters, PSS, relays (IDMT, mho), load models, CCT; dynamic induction motor (MG1, MG9) | PR #260 (D1–D8); PR #332 (MG1, MG9) |
| `cable_sizing.py` | ✅ 2026-09-28 | Direct | IEC 60364-5-52 (Annex G, Tables B.52.14/15), IEC 60364-4-43 (§433.1, §434.5.2, §435.1, Table 43A), IEC 60949, IEC 60255-151, IEC 60909-0 §12 | Volt drop (system voltage, cumulative from origin), overload coordination, fault withstand at largest and minimum current with real device clearing times, k values, ambient factors, recommendation | `CABLE_SIZING_REVIEW.md` (CS1–CS5, N1–N6) |
| `iec_60364_tables.py` (+ `iec_60364_data.py`, `iec-60364-data.js`) | ✅ 2026-09-29 | Direct | IEC 60364-5-52:2009 Tables B.52.1–B.52.19 (published reproduction; two reference typos flagged for a licensed copy) | Every capacity cell (2- and 3-loaded, all methods), temperature, soil and grouping tables, backend/frontend parity | `IEC_60364_TABLES_REVIEW.md` (T1–T5, L1–L3) |
| `loadflow.py` | ✅ 2026-09-28 | Partial | IEC 60038 voltage bands, IEC 60076-1 tap/ratio conventions; method from first principles (hand 2/3-bus, power balance) | Voltage zones in transformer chains, tees, PV/PQ handling, reactive limits, SoC, branch currents; sync-motor pf sign (MG5) | Load-flow review PR #326 (16 findings) + sibling alignment `baffd40`; PR #332 (MG5) |

## Partly reviewed

| Module | Status | IEC fit | Standard(s) | Done so far | Still to check |
|---|---|---|---|---|---|
| `unbalanced_loadflow.py` | 🟡 | Partial | IEC 61000-2-2 / 61000-4-30 (voltage unbalance definition), IEC 60076-1 vector groups | Sequence-network iteration verified against a phase-domain solve (`ab1b044`); zone / current bases (`baffd40`); generator Z0 default (MG4) | Transformer Z0 by vector group and earthing through the LF path; VUF = V2/V1 definition and 2 % limit; single-phase loads' phase allocation; power balance per phase |
| `network_reduction.py` | 🟡 | None | Kron reduction identity, two-port equivalence | Exercised indirectly by the transient-stability and dynamic-starting reviews | Standalone: Z_port against a hand Kron reduction, transformer ratios, parallel paths, source stubs |
| `flicker.py` | 🟡 | Direct | IEC 61000-3-3 (limits, Pst from d(t)), IEC 61000-3-11, IEC 61000-4-15 (flickermeter) | Starting-load model shared with motor starting (N1, MG8, MG9) | Pst–d–rate curve against IEC 61000-3-3 Figure 4 / Annex; Plt aggregation (cube-root law); d_max / d_c limits (3.3 %, 4 %, 6 %, 7 %); emission vs planning levels (IEC 61000-3-7) |

## Not yet reviewed — suggested order

### Tier 1 — IEC standard implemented directly, safety-relevant

| # | Module | IEC fit | Standard(s) | Review scope |
|---|---|---|---|---|
| 3 | `db_circuit_check.py` | Direct | IEC 60364-5-52, 4-43 §433.1, 5-54 Table 54.7 (PE sizing), 4-41 §411.4 (Zs, disconnection times), SANS 10142-1 Cl. 6.6 (volt drop) | Per-way chain by hand; single-phase loop (2×) vs three-phase volt drop; Zs = Ze + (R1+R2) at operating temperature against the device's magnetic trip (IEC 60898 B/C/D); agreement with `cable_sizing.py` on an identical cable |
| 4 | `duty_check.py` | Direct | IEC 62271-100 (Isc breaking, making = 2.5/2.6 × Isc, DC time constant), IEC 60947-2 (Icu / Ics / Icw), IEC 60898-1 (Icn), IEC 60269 (fuse breaking capacity) | Which fault quantity is compared with which rating (Ib vs breaking, ip vs making, Ith·t vs Icw), X/R above the standard's test value → derating, rating at the device's own voltage |
| 5 | `ct_model.py` | Direct | IEC 61869-2 (5P/10P accuracy-limit factor, knee point, PX class), IEC 61869-2 Annex (transient TPX/TPY) | ALF → knee voltage, burden + Rct, saturation current, κ-derated threshold vs the standard's Ktd approach; dc offset treatment disclosed |
| 6 | `pt_model.py` | Direct | IEC 61869-3 / -5 (accuracy classes, rated burden, voltage factor) | Burden-vs-accuracy check, ratio and phase error bands per class, voltage factor 1.2/1.5/1.9 |
| 7 | `tcc.js` (frontend) | Direct | IEC 60255-151 (IDMT SI/VI/EI/LTI curves), IEC 60898-1 (B/C/D bands), IEC 60947-2 (MCCB/ACB release settings), IEC 60269-1/-2 (fuse gates, gG/gM), IEC 60076-5 / ANSI (transformer damage), inrush | Curve equations and constants, tolerance bands, discrimination margins, CT-saturation interaction with `ct_model.py`, distance zone grading |
| 8 | `compliance.js` (frontend) | Direct | IEC 60364-4-41 (disconnection times Table 41.1, RCD 30 mA), 4-43, 5-52, 5-54; SANS 10142-1 | Every rule's condition and threshold against the clause; TN / TT / IT branching; RCD requirements |
| 9 | `dc_shortcircuit.py` | Direct | IEC 61660-1 (battery, rectifier, capacitor, motor sources) and its Annex worked examples | Peak and quasi-steady currents, time constants τ1/τ2, rise time, superposition of sources, correction factors |
| 10 | `lightning_risk.py` + `lightning.js` | Direct | IEC 62305-2:2010 (R1, collection areas A_D/A_M/A_L/A_I, N_D, P_x, L_x) | Collection-area formulas, location / environment factors, probabilities per LPL, loss values, tolerable risk 10⁻⁵; Annex worked example |
| 11 | `conductor_temp.py` | Direct | IEC 60228 (R20, α), IEC 60287-1-1 (operating temperature) | R(θ) = R20·(1 + α(θ − 20)) with the right α for Cu/Al; library reference temperatures; which studies use 20 °C vs operating temperature (IEC 60909 uses 20 °C for max, θe for min) |
| 12 | `line_coupling.py` | Direct | IEC TR 60909-2 (line data), IEC 60909-3 (earth currents), Carson's equations | Mutual Z0 between parallel circuits against the Carson closed form; earth-return depth vs soil resistivity; effect on SLG results |
| 13 | `harmonics.py` | Partial | IEC 61000-3-6 (planning levels), IEC 61000-2-4 (compatibility, THD 8 %), IEC 61000-3-12 (equipment); engine uses IEEE 519-2014 | Current injection spectra, frequency-dependent R (skin effect), transformer phase shift, THD/TDD formulas, IEEE 519 limit tables — and whether IEC 61000-3-6 limits should be offered |
| 14 | `frequency_scan.py` | Partial | IEC 61000-3-6 (resonance assessment) | Z(h) against an analytic RLC parallel/series resonance; h_r = √(S_sc/Q_c) |
| 15 | `filter_sizing.py` | Partial | IEC 61642 (filters and capacitors), IEC 60871 / 60831 (capacitor ratings); engine designs to IEEE 519 / IEEE 1531 | Tuning h_n, Q, detuning, capacitor voltage/current/kvar duty against the IEC capacitor limits (1.1 U, 1.3 I, 1.35 Q) |
| 16 | `grounding_system.py` | Partial | IEC 61936-1 / EN 50522 (permissible touch voltage vs time), IEC 60479-1 (body current); engine uses IEEE 80 | IEEE 80 worked examples (grid R, Em, Es, GPR, conductor size); note where the IEC touch-voltage curve would give a different verdict |
| 17 | `load_diversity.py` | Partial | IEC 60364-3 (maximum demand and diversity), SANS 10142-1 | Demand-factor tables and their source, per-bus and per-transformer aggregation, kW vs kVA consistency with load flow |

### Tier 2 — governed by a non-IEC standard (review against that standard)

| # | Module | Standard(s) | Review scope |
|---|---|---|---|
| 18 | `arcflash.py` | IEEE 1584-2002 and 1584-2018; NFPA 70E (PPE categories) | 2018 three-anchor model against the official spreadsheet cases, enclosure correction, AFB inverse, clearing time from `ct_model` + TCC, PPE category mapping (IEC has no incident-energy method; IEC 61482-1-2 box test for PPE only) |
| 19 | `fault_ansi.py` | ANSI/IEEE C37.010, C37.013, C37.5 | E/X multiplying factors, remote/local curves, 1st-cycle vs interrupting networks, motor multipliers |
| 20 | `dc_arcflash.py` | Stokes & Oppenlander; DGUV-I 203-077; NFPA 70E Annex D.8 | Arc resistance model, iterative arcing current, max-power method bound, incident energy vs distance |
| 21 | `battery_sizing.py` | IEEE 485 (lead-acid), IEEE 1115 (Ni-Cd); IEC 62485-2 (installation); IEC 60896 (cells) | Duty-cycle sections method against the IEEE 485 worked example, temperature / ageing / design margins, Peukert |
| 22 | `raceway.py` | NEC Chapter 9 Table 1; IEC 61386 / SANS 10142-1 fill rules | Fill percentages by cable count, grouping factors cross-referenced with IEC 60364-5-52 |
| 23 | `reliability.py` | IEEE 1366 | SAIDI/SAIFI/MAIFI/EENS by hand on a small radial feeder; switching and restoration logic |
| 24 | `admd.py` + `admd_data.py` | NRS 034-1 (South Africa) | Herman beta / ADMD curves against the published NRS tables; porting fidelity from Retic Builder Pro |

### Tier 3 — no applicable standard (first principles)

| # | Module | Reference to use | Review scope |
|---|---|---|---|
| 25 | `voltage_stability.py` | Hand P-V nose of a 2-bus line (P_max = V²/2X at unity pf) | Continuation and bisection accuracy, collapse criteria, Q-V margin |
| 26 | `contingency.py` | Standalone load flow per outage | Outage set, islanding and lost load, violation ranking |
| 27 | `timeseries_loadflow.py` | A flat profile must reproduce the single-shot result; energy conservation | Profile interpolation, SoC integration, OLTC carry-over |
| 28 | `hosting_capacity.py` | Hand voltage rise ΔV ≈ (P·R + Q·X)/V; IEC 60038 / EN 50160 band | Limit detection (voltage, thermal, fault-level screen) |
| 29 | `capacitor_placement.py` | Exhaustive enumeration on a small feeder | Greedy result vs optimum; capacitor as constant susceptance |
| 30 | `optimal_powerflow.py` | Merit order by hand; exhaustive Volt/VAR on a tiny case | Dispatch order, limits, loss accounting |
| 31 | `backup_autonomy.py` | Energy balance over the autonomy period | Island grouping, battery energy and inverter limits |
| 32 | `dc_loadflow.py` | Hand 2-bus DC solution; power balance | Resistive network, converter models, voltage limits |
| 33 | `loadflow_cases.py` | Each case equals a standalone `run_load_flow` | Snapshot isolation |
| 34 | `study_manager.py` | Each study equals its standalone call | Orchestration and result mapping |

### Tier 4 — support, data and output (transcription checks)

| # | Module | Scope |
|---|---|---|
| 35 | `constants.js` libraries | Cable R/X/R0/X0 against IEC 60228 and manufacturer data; transformer library impedances against IEC 60076-5 Table 1 minimums; CB and fuse ratings; component defaults that silently apply (methodology archetype 2) |
| 36 | `dbschedule.js`, `cableschedules.js`, `retic.js` | Values passed to the engines match the schedule; unit conversions |
| 37 | `changeover.py`, `offpage.py` | Topology rewrite correctness |
| 38 | `pdf_reports.py` | Reported numbers equal the engine output |
| 39 | `plan_dxf.py`, `plan-lux.js` | DXF round-trip; lux against the IES/CIBSE point method |
