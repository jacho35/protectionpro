# Engine Review Tracker — correctness against IEC standards

Module-by-module status of the independent engine reviews. Each review follows
`ENGINE_REVIEW_METHODOLOGY.md`: derive the answer from the **standard itself**
(its equations, tables and worked examples) or from first principles, never
from the module's own tests; report, then fix with `[ID]` markers and one
regression test per finding.

*Created 2026-09-28; last updated 2026-09-30 (grounding review). Update this
file when a review lands (status, date, PR, write-up).*

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
| `cable_sizing.py` | ✅ 2026-09-28 | Direct | IEC 60364-5-52 (Annex G, Tables B.52.14/15), IEC 60364-4-43 (§433.1, §434.5.2, §435.1, Table 43A), IEC 60949, IEC 60255-151, IEC 60909-0 §12 | Volt drop (system voltage, cumulative from origin), overload coordination, fault withstand at largest and minimum current with real device clearing times, k values, ambient factors, recommendation | `CABLE_SIZING_REVIEW.md` (CS1–CS5, N1–N6), PR #333 |
| `iec_60364_tables.py` (+ `iec_60364_data.py`, `iec-60364-data.js`) | ✅ 2026-09-29 | Direct | IEC 60364-5-52:2009 Tables B.52.1–B.52.19 (published reproduction; two reference typos flagged for a licensed copy) | Every capacity cell (2- and 3-loaded, all methods), temperature, soil and grouping tables, backend/frontend parity | `IEC_60364_TABLES_REVIEW.md` (T1–T5, L1–L3), PR #334 |
| `db_circuit_check.py` | ✅ 2026-09-29 | Direct | IEC 60364-4-41 §411.4/411.5, 4-43 §433.1, 5-52 Annex G / Table G.52.1, 5-54 §543.1 (Tables 54.3, 54.7), IEC 60228 | Ze, R1+R2, Zs/disconnection (magnetic, RCD TN/TT, declared time), ECC by table or adiabatic, volt drop from origin, aluminium | `DB_CIRCUIT_CHECK_REVIEW.md` (DB1–DB4, L1–L5), PR #335 |
| `duty_check.py` | ✅ 2026-09-29 | Direct | IEC 60947-2 (Icu, Table 2, Icw), IEC 60269, IEC 62271-100 (Ib, §4.101, making), IEC 62271-1 / IEC 60038 (Um) | Breaking basis per device class and fault type, making, asymmetry, short-time withstand, voltage, board-mounted devices | `DUTY_CHECK_REVIEW.md` (DU1–DU3, L1–L4), PR #336 |
| `ct_model.py` (+ `constants.js` CT model, arc-flash relay timing, duty-check CT table) | ✅ 2026-09-29 | Direct | IEC 61869-2 (class P/PR/PX/TPx, E_AL, Ktf), IEEE C37.110 (time to saturation), IEEE C57.13 (C-class), IEC 60255-151 | Clipping law vs a time-domain square-loop reference, fundamental vs RMS, rated vs connected burden, dc offset (time-domain CT replaces the κ proxy), accuracy-class parsing, duty-check basis | `CT_MODEL_REVIEW.md` (C1–C4, L1–L3), PR #337. **Not covered:** remanence, CT secondary time constant (Ts), non-square-loop cores |
| `pt_model.py` (+ duty-check PT table, `constants.js` PT props) | ✅ 2026-09-29 | Direct | IEC 61869-3:2011 (Tables 301/302/303, burden ranges I/II), IEC 61869-1 / IEC 60071-1 (earth fault factor) | Class limits, burden band per range, rated primary vs bus voltage (80–120 %), rated voltage factor vs the bus earth fault factor from the fault study's Z1/Z0, ratio and class parsing | `PT_MODEL_REVIEW.md` (PT1–PT4, L1–L2), PR #339. **Not covered:** VT equivalent circuit (actual ratio/phase error), ferroresonance, CVTs (IEC 61869-5 — no model in the app), residual-winding rating |
| `tcc.js` curve functions (`constants.js` IDMT / gG / CB / distance, mirrored in `arcflash.py`) | ✅ 2026-09-29 | Direct | IEC 60255-151, IEEE C37.112, IEC 60269-1 (Tables 2/3/7), IEC 60898-1 Table 7, IEC 60947-2 Table 6, IEC 60364-4-43 Table 43A, IEEE C57.109 / IEC 60076-5 | IDMT constants and range (G_D = 20·Gs), gG gates and 0.01 s I²t, MCB/MCCB conventional currents, MCB magnetic bands, fuse selectivity ratio, cable k, transformer damage, distance-relay voltage base; frontend/backend parity | `TCC_REVIEW.md` (TC1–TC4, L1–L5), PR #338. **Not covered:** drawing/interaction, auto-coordinate search, sequence-of-operation topology, user CSV curves |
| `compliance.js` (frontend, + `deviceRatingFlags` diagram markers) | ✅ 2026-09-29 | Direct | IEC 60364-4-41 (§411.3.2, Table 41.1, §411.4.5, §411.5.3), IEC 60364-4-43 (§433.1, §434.5.2, §435.1, Table 43A), IEC 60909-0 §5.3.1 / §12, IEC 60076-1, IEC 62271-1 / IEC 60038; SANS 10142-1 | Earth-fault disconnection per circuit at its far end, cable withstand at largest and minimum current, §433.1 incl. I2, earthing system per LV installation, LV neutral from the vector group, maximum demand, rated voltage vs Um, diagram flag basis, HV-side device current | `COMPLIANCE_REVIEW.md` (C1–C9, L1–L5, cross-module X1 Cable Sizing minimum at 70 °C, X2 IEEE 1584 instantaneous clearing times on both sides), PR #340. **Not covered:** NRS 048-2 band above 500 V, Al minimum size, IT second fault, ELV |
| `dc_shortcircuit.py` | ✅ 2026-09-29 | Direct | IEC 61660-1:1997 (Figure 10, Annex A eq. 54–56; battery clauses and worked Examples 1 and 3 as published in CED E03-035) | Battery peak / quasi-steady / 1/δ / t_pB, τ_1B (Figure 10), rectifier λ_D, κ_D, t_pD, τ_1D from the AC supply impedance, superposition with a common branch, source lead cables, parallel cables, 20 °C conductor resistance | `DC_SHORTCIRCUIT_REVIEW.md` (DC1–DC6, L1–L7), PR #341. **Not covered:** minimum current, capacitor and DC-motor sources, 60 Hz rectifier time forms |
| `lightning_risk.py` + `lightning_risk_2024.py` + `lightning.js` | ✅ 2026-09-29 | Direct | IEC 62305-2:2024 (Ed. 3, incl. Annex F worked examples), IEC 62305-1:2024; IEC 62305-2:2010 tables (reviewer's reading, cross-checked where 2024 kept them; Table B.9 confirmed from GOST R IEC 62305-2-2010) | 2010 R1 exact over 55,296 input combinations; loss categories, explosion, P_LI, P_LD by screen, P_C combination, ladder; **2024 method added** (edition per assessment) and pinned to Annex F house / office / hospital, R and F, unprotected and protected | `LIGHTNING_RISK_REVIEW.md` (E1, LR1–LR7, L1–L5), PR #342. **Not covered:** TWS, N_DJ, Annex E, multi-zone dialog |
| `conductor_temp.py` (+ the fault study's line-resistance basis, `dc_shortcircuit` hot factor) | ✅ 2026-09-29 | Direct | IEC 60909-0:2001 §2.4, §2.5 eq. (3); IEC 60228 (R20, α), IEC 60889 / IEC 60104 (Al, AlMgSi α); IEC 60364-4-43 Table 43A (θe); IEC 60865-1 (bare conductors) | α per material, library basis (all 113 cables vs IEC 60228), overhead correction idempotence, maximum study at 20 °C, minimum study eq. (3) at θe per insulation, Ik_min, series faults | `CONDUCTOR_TEMP_REVIEW.md` (CT1–CT2, L1–L2), PR #343. **Not covered:** `fault_ansi.py` basis, DB-check Ze and rectifier AC supply impedance (stay hot), skin effect at 20 °C |
| `line_coupling.py` (+ drawn parallel feeders in `fault.py` / `unbalanced_loadflow.py`) | ✅ 2026-09-29 | Direct | IEC 60909-3:2009 eq. (34)–(36), Table 2; Carson phase-domain model (6 conductors, earth return) | δ and earth-return R, Z0m for the inter-circuit GMD, Z0_eff = [Z0s + (n−1)Z0m]/n vs phase domain (tower + MV poles, two resistivities), library r0, drawn parallel feeders | `LINE_COUPLING_REVIEW.md` (LC1, L1–L3), PR #344. **Not covered:** earth wires, partial-route coupling, series faults on a drawn pair, library x0 |
| `harmonics.py` (+ shared shunt model in `frequency_scan.py`) | ✅ 2026-09-29 | Partial | IEEE 519-2014 Tables 1–4; IEC 61000-3-6:2008 Table 2 planning levels and IEC 61000-2-4 Class 2 (added as an option, values from the reviewer's reading); independent nodal solve | Nodal solve per order, IHD/THD_V/TDD/Isc/IL, Table 1 voltage and Tables 2–4 current limits (each order, even 25 %), tuned filter, lumped loads incl. boards and motor share, STATCOM (coupling reactance) / SVC (solved Q), dead islands, PCC current, demand factor 0; IEC limit option | `HARMONICS_REVIEW.md` (H1–H6, L1–L8), PR #346. **Not covered:** drive spectra (typical values, no standard), skin effect, transformer phase shift, cable capacitance, IEC 61000-3-6 emission allocation |
| `frequency_scan.py` (+ shared transformer ratio in `harmonics._branch_chains`) | ✅ 2026-09-29 | Partial | IEC 61000-3-6 (resonance assessment, no numeric method); closed-form RLC resonance; hand nodal solve in ohms with an ideal transformer | Z(h) curve, h_r = √(S_sc/Q_c), tuned-filter peak and dip, peak refinement, prominence, ranking across voltage levels (per unit), dead islands, regulating SVC from the load flow, turns ratio / taps, idle generators, rounding | `FREQUENCY_SCAN_REVIEW.md` (FS1–FS5, L1–L8), PR #348. **Not covered:** zero-sequence (triplen) scan, cable capacitance, frequency-dependent R |
| `grounding_system.py` (+ Z0 local/remote split in `fault.py`) | ✅ 2026-09-30 | Partial | IEEE 80-2013 Annex B Ex. 1–2, Tables 1, 2, 10, §11.3.1.1, §15; independent method-of-moments grid solve (uniform + two-layer); IEC 61936-1 / EN 50522 touch-voltage curve compared (reviewer's reading) | C_s, tolerable touch/step, Sverak R_g, GPR, n / K_ii / K_m / K_s / K_i / L_M / L_S, E_m / E_s, D_f, Onderdonk size and joint limit, material constants, grid current (local neutral return, S_f), two-layer soil, Wenner forward model, PDF text | `GROUNDING_REVIEW.md` (G1–G5, L1–L6), PR #374. **Not covered:** transferred potentials, interior rods, irregular (L-shaped) grids, IEC touch-voltage option (backlog) |
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
| 15 | `filter_sizing.py` | Partial | IEC 61642 (filters and capacitors), IEC 60871 / 60831 (capacitor ratings); engine designs to IEEE 519 / IEEE 1531 | Tuning h_n, Q, detuning, capacitor voltage/current/kvar duty against the IEC capacitor limits (1.1 U, 1.3 I, 1.35 Q) |
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
