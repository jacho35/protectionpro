# Feature Gap Analysis — ProtectionPro vs ETAP, DIgSILENT PowerFactory & Siemens PSS®

**Date:** 2026-07-19
**Compared against:** ETAP 2026, DIgSILENT PowerFactory 2026, Siemens PSS®E (Gridscale X) + PSS®SINCAL
**Method:** inventory of every implemented engine/module in this repo (backend/analysis/, frontend/js/, BACKLOG.md Completed section) cross-checked against the vendors' current published module sets.

---

## 1. Where ProtectionPro stands

ProtectionPro today is a credible **LV/MV distribution & industrial plant design tool** — functionally an "ETAP-lite" with several capabilities the big three don't have at all (browser-native, LV DB circuit schedules, SANS/NRS compliance, NRS 034 ADMD reticulation, floor/site-plan markup with BOQ, in-app standards-anchored V&V). Its analysis breadth now covers most of ETAP's core network-analysis catalogue.

Where it is **not** competitive is (a) transmission-scale work (PSS®E territory: huge networks, linear sensitivities, OPF, market/planning tools), (b) advanced dynamics (EMT, small-signal/modal, user-defined models), and (c) enterprise data/workflow (CIM/GIS/SCADA, multi-user concurrency, scripting automation).

### Implemented today (verified in source)

| Domain | Coverage |
|---|---|
| Load flow | NR + GS, islanding & merit-order/droop/standby dispatch, PV Q-limits with PV↔PQ switching, SVC/STATCOM, storage-inverter var modes, autotransformer OLTC iteration, fixed transformer taps, solution-quality classification, DC load flow, unbalanced (sym-component) LF with 1P/2P/3P loads, Load Flow Study Manager (named cases + comparison) |
| Short circuit | IEC 60909 (3φ, SLG, LL, LLG), configurable c-factor, per-component sequence impedances, motor contribution, LV earthing systems (TN-S/TN-C/TN-C-S/TT/IT), detailed transformer zero-sequence (grounding-authoritative, core construction Z₀ₘ), DC short circuit (IEC 61660), equipment duty check |
| Arc flash | IEEE 1584-**2002** + NFPA 70E PPE, per-bus gap/electrode class, DC arc flash (Stokes & Oppenlander / DGUV-I 203-077), label PDFs |
| Protection | TCC with mini-SLD, auto-coordination engine, miscoordination detection, Sequence-of-Operation study, 50/51/67/21(display)/EF/CBCT, CT saturation, IEC 60898 B/C/D, gG fuses, custom curve CSV import |
| Dynamics | Transient stability (classical + opt-in two-axis, AVR, governor, GFM/GFL IBR, UFLS + in-run protective tripping, dynamic loads & induction motors, sequenced events, frequency-collapse verdicts); dynamic motor starting (coupled multi-motor, DOL/YΔ/auto-tx/soft-starter, rotor I²t) |
| Power quality | Harmonic penetration study (VFD spectra by pulse number, THD_V/IHD, PCC TDD, IEEE 519-2014 verdicts) |
| Stability (steady-state) | Voltage stability P-V/Q-V (loadability margin, collapse), contingency N-1/N-2 with ranked violations |
| Cables & raceway | IEC 60364 sizing (thermal/Vdrop/fault withstand + standalone mode), IEC 60364-5-52 installed-ampacity calculator, NEC 310 tables, conduit fill/jam/grouping derating, overhead lines (ACSR/AAAC library) |
| Grounding / lightning | IEEE 80 (full geometric factors, uniform soil + surface layer), IEC 62305-2 lightning risk |
| DER / storage | Solar PV (string/panel sizing, hybrid inverters), BESS (dispatch, dynamics, IEC TR 60909-4 fault infeed), wind, backup-supply & battery-autonomy study, UPS/rectifier/charger |
| LV design | Distribution boards with circuit schedules (Excel I/O, phase balance, earth leakage), ADMD/NRS 034 reticulation workspace, SANS 10142 compliance, load diversity |
| Drafting/platform | Multi-page SLD, plan markup (multi-floor, PDF/DXF import, DXF/BOQ export, lux heatmap), control-circuit simulation, CB interlocking logic, auth + sharing + revisions, PDF/CSV reporting with formula-level calculation reports, mobile UI, in-app V&V page |

---

## 2. Comparison matrix

Legend: ✔ implemented · ◐ partial · ✘ missing. "E" = ETAP, "PF" = PowerFactory, "PSS" = PSS®E/SINCAL. Only rows where at least one competitor has the capability are listed.

### 2.1 Steady-state analysis

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| Balanced AC load flow | ✔ | ✔ | ✔ | ✔ | |
| Unbalanced / 3-phase LF | ✔ | ✔ | ✔ | ✔ (SINCAL) | |
| DC load flow | ✔ | ✔ | ✔ | ✔ | |
| **Time-series / quasi-dynamic LF (load & generation profiles)** | ✘ | ✔ | ✔ (QDS) | ✔ (Time Series PF, SINCAL profiles) | Biggest steady-state gap. Needed for PV self-consumption, EV charging, seasonal loading, storage cycling. Backup-autonomy study is the only time-domain energy sim today. |
| Voltage stability (P-V/Q-V) | ✔ | ✔ | ✔ | ✔ | |
| Contingency N-1/N-2 | ✔ | ✔ | ✔ | ✔ | |
| **Linear sensitivities (PTDF/LODF), transfer-limit analysis** | ✘ | ◐ | ✔ | ✔ (Advanced Linear Analysis) | Transmission-planning staple; low value at LV/MV scale. |
| **Optimal power flow / Volt-VAR optimization** | ✘ | ✔ | ✔ | ✔ (OPF module) | In backlog. |
| **Probabilistic / stochastic load flow** | ✘ | ◐ | ✔ | ✔ | Monte-Carlo over load/DER uncertainty. |
| **State estimation** | ✘ | ✔ | ✔ | ✔ | Operational/digital-twin use; low priority for a design tool. |
| Transformer tap optimization / automatic OLTC on 2-winding units | ◐ | ✔ | ✔ | ✔ | OLTC regulation iterates only for autotransformers; standard transformers have fixed `tap_percent`. |
| Optimal capacitor placement | ✘ | ✔ | ✔ | ✔ (SINCAL) | In backlog. |
| Network reconfiguration / tie-open-point optimization | ✘ | ✔ | ✔ | ✔ (SINCAL) | Distribution-planning optimizer. |

### 2.2 Short circuit & protection

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| IEC 60909 | ✔ | ✔ | ✔ | ✔ | Verified against published examples incl. an ETAP cross-check. |
| **ANSI/IEEE C37.010 short circuit** | ✘ | ✔ | ✔ | ✔ | In backlog; required for the US market. |
| IEC 61363 (marine/offshore) | ✘ | ✔ | ✔ | ◐ | In backlog. |
| **Open-conductor / series faults, simultaneous faults** | ✘ | ✔ | ✔ | ✔ | Fault engine covers shunt faults only. Open-phase (broken conductor) matters for rural MV feeders and generator interconnects. |
| Fault current decay / time-varying (sub-transient→steady) | ✔ | ✔ | ✔ | ✔ | |
| TCC coordination + auto-grading | ✔ | ✔ (STAR) | ✔ | ✔ (SINCAL OC / CAPE) | |
| **Manufacturer protective-device library depth** | ◐ | ✔ (100k+ devices) | ✔ | ✔ (CAPE/SINCAL) | ProtectionPro ships generic curves + editable libraries + CSV import; the big three ship huge verified vendor libraries. Structural gap — mitigate via import tooling rather than curation. |
| **Distance (21) protection coordination** | ◐ | ✔ | ✔ | ✔ (CAPE) | Mho characteristic is displayed on an R-X inset, but there is no zone-reach calculation/grading against line impedances or infeed. |
| Sequence of operation simulation | ✔ | ✔ | ◐ | ✔ | |
| CT saturation / burden | ✔ | ✔ | ✔ | ✔ | |

### 2.3 Arc flash & safety

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| **IEEE 1584-2018** | ✘ (2002 only) | ✔ | ✔ | ◐ | The engine docstring is explicit: 2018 electrode-configuration coefficients, 600 V/2.7 kV/14.3 kV interpolation and enclosure-size correction are not implemented. 2002 is superseded — this is the single most visible standards gap for safety studies. |
| DC arc flash | ✔ | ✔ | ✘ | ✘ | Ahead of PF/PSS here. |
| **HV arc flash (>15 kV)** | ✘ | ✔ | ◐ | ✘ | EPRI/ArcPro-class methods; niche. |
| Arc flash labels | ✔ | ✔ | ◐ | ✘ | |

### 2.4 Dynamics & transients

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| RMS transient stability | ✔ | ✔ | ✔ | ✔ | Classical + two-axis/AVR/governor/IBR — respectable mid-tier coverage. |
| **Standard dynamics model library (GENROU/EXST1/GAST…)** | ✘ | ✔ | ✔ | ✔ | ProtectionPro's machine/exciter/governor models are fixed built-ins; no named industry-standard model set, so studies can't be exchanged or matched against utility model data. |
| **User-defined dynamic models** | ✘ | ✔ (UDM) | ✔ (DSL/Modelica) | ✔ (user models) | |
| **EMT (electromagnetic transient) simulation** | ✘ | ◐ | ✔ (parallelised in PF 2026) | ✔ (NETOMAC) | Switching/lightning overvoltages, ferroresonance, SSR, inrush, detailed inverter switching. A different solver class entirely — treat as out of scope unless the product aims at transmission/IBR interconnection niches. |
| **Small-signal / modal / eigenvalue analysis** | ✘ | ◐ | ✔ (incl. impedance-based IBR stability, PF 2026) | ✔ | Oscillatory-stability screening; increasingly demanded for inverter-heavy grids. |
| Motor acceleration (time-domain) | ✔ | ✔ | ✔ | ✔ | VFD starting profile not simulated (soft starter is). |
| Grid-code / fault-ride-through compliance studies | ◐ | ✔ (Grid Code Interconnection, ETAP 2026) | ✔ | ✔ | IBR LVRT behaviour exists in the TS engine, but there's no grid-code template (ride-through envelope overlay, reactive-support verdicts). |

### 2.5 Power quality

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| Harmonic penetration + IEEE 519 | ✔ | ✔ | ✔ | ✔ (SINCAL) | |
| **Frequency scan (Z vs f)** | ✘ | ✔ | ✔ | ✔ | In backlog. Cheap to add — the h-scaled Y-matrix already exists in `harmonics.py`; sweep it continuously instead of at integer h. |
| **Passive filter sizing** | ✘ | ✔ | ✔ | ✔ | In backlog. |
| Harmonic phase-angle diversity / IEC 61000-3-6 summation | ✘ | ✔ | ✔ | ✔ | Current engine sums same-order sources in phase (conservative screening). |
| Background/utility harmonic distortion input | ✘ | ✔ | ✔ | ✔ | |
| **Flicker (IEC 61000-4-15 / 61000-3-3)** | ✘ | ✔ (ETAP 2026 module) | ✔ | ✔ | In backlog. |
| Voltage sag/depression during faults | ✔ | ✔ | ✔ | ✔ | |

### 2.6 Cables, lines, grounding

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| Cable sizing (IEC 60364) + installed ampacity derating | ✔ | ✔ | ◐ | ◐ | |
| **First-principles cable thermal rating (IEC 60287 / Neher-McGrath / FEM)** | ✘ | ✔ (URS thermal + FEM) | ◐ | ✘ | ProtectionPro derates library ampacities; it cannot compute ampacity from soil thermal resistivity, laying depth, and mutual heating of buried groups. |
| Conduit fill / jam / grouping | ✔ | ✔ | ✘ | ✘ | |
| Cable pulling tension | ✘ | ✔ | ✘ | ✘ | In backlog. |
| **Line/cable constants from geometry (Carson/Pollaczek)** | ✘ | ✔ | ✔ | ✔ | Overhead lines are library R/X with a fixed Z₀ multiplier; no tower-geometry, bundling, earth-wire or soil-resistivity derivation. Several sub-items already ranked in the backlog's Overhead Line section. |
| Line charging / π-model shunt B | ✘ | ✔ | ✔ | ✔ | All series R+jX today; matters ≥132 kV or long cables. |
| IEEE 738 thermal line rating | ✘ | ✔ | ◐ | ◐ | In backlog (overhead section). |
| IEEE 80 grounding grid | ✔ | ✔ (GroundMat) | ✘ | ✘ | |
| **Two-layer soil model / Wenner-data soil derivation, FEM grids** | ✘ | ✔ | ✘ | ✘ | Engine assumes uniform soil + crushed-rock surface layer; two-layer soil changes grid resistance materially. |

### 2.7 Planning, reliability, DER

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| Reliability indices (SAIDI/SAIFI/EENS, FMEA) | ✘ | ✔ | ✔ | ✔ (SINCAL) | In backlog. |
| **Feeder hosting capacity** | ✘ | ✔ (ETAP 2026) | ✔ | ✔ | In backlog. |
| Battery sizing from duty cycle | ✘ | ✔ | ◐ | ◐ | In backlog; autonomy study covers the discharge half. |
| ADMD / after-diversity LV design | ✔ (NRS 034) | ◐ | ✘ | ◐ | ProtectionPro advantage in SA/LV market. |
| **Load allocation / estimation from metering** | ✘ | ✔ | ✔ | ✔ (SINCAL) | Scale feeder loads to measured feeder-head/AMI data — the standard way utilities build usable distribution models. |
| HVDC link | ✘ | ✔ | ✔ | ✔ | In backlog; transmission niche. |

### 2.8 Platform, data & interoperability

| Capability | ProtectionPro | E | PF | PSS | Notes |
|---|---|---|---|---|---|
| **Scripting / automation API (etapPy · PF Python · psspy)** | ◐ | ✔ | ✔ | ✔ | The REST endpoints accept full ProjectData JSON, so automation is *possible*, but there's no documented Python client, no batch/parametric study runner, no result-object model. Cheap high-leverage gap. |
| **CIM / PSS-E RAW / DGS import-export** | ✘ | ✔ | ✔ | ✔ | In backlog ("Import from external tools", CIM). Without at least RAW/CIM import, no migration path from incumbent tools. |
| GIS / geographic network view | ◐ (site-plan markup with scale, not geo-coordinates) | ✔ | ✔ | ✔ | In backlog. |
| SCADA/real-time integration | ✘ | ✔ | ✔ | ✔ | In backlog; operational product line. |
| Multi-user concurrency / enterprise DB | ◐ (auth, sharing, revisions — no concurrent editing, SQLite store) | ✔ | ✔ (multi-user DB, versioning) | ✔ | Real-time co-editing + audit trail in backlog. |
| **Variants / expansion stages (time-phased network development)** | ◐ | ✔ | ✔ | ✔ | Scenarios + LF cases snapshot *operating states*; there is no "network as of 2028" construction-stage concept for planning studies. |
| Network size / solver scalability | ◐ | ✔ | ✔ | ✔ (200k+ buses) | Dense NumPy matrices, full-JSON round-trips, SQLite, browser SVG. Fine for ≤ a few hundred buses (the target market); not a transmission tool. Accept and document rather than fix. |
| Switching-procedure / permit management | ✘ | ◐ | ✔ | ◐ | Operations niche. |
| Result verification transparency | ✔ (in-app V&V, 15+ standards-anchored cases) | ◐ | ◐ | ◐ | ProtectionPro advantage. |

---

## 3. Shortcomings ranked (what to actually do)

### Tier 1 — gaps that undermine the tool's core "protection & safety studies" promise
1. **IEEE 1584-2018 arc flash.** The tool is named ProtectionPro and computes arc flash to a superseded 2002 edition. Every serious competitor is on 2018 (electrode configurations, enclosure-size correction, three-current interpolation). The engine already has per-bus gap/electrode class fields — the 2018 coefficient machinery slots into the existing structure.
2. **Frequency scan.** Trivial extension of the existing harmonic Y(h) solve; unlocks resonance identification, which the harmonics report currently only infers.
3. **Time-series / quasi-dynamic load flow.** PF QDS / PSS®E Time-Series PF / ETAP load profiles are the workhorse of modern DER studies. ProtectionPro already models PV irradiance, BESS SoC and dispatch — running the existing LF over a 24 h/8760 h profile with storage state carried between steps is a natural, high-value increment (and makes the existing battery-autonomy study a special case).
4. **ANSI C37 short circuit** (already in backlog) — gates the entire North-American market.
5. **Open-conductor / series faults** — real protection-engineering need (broken-conductor detection on MV feeders), fits the existing sequence-network machinery.

### Tier 2 — expected by users migrating from the big three
6. **Passive filter sizing** (backlog) — completes the harmonics story: measure → scan → fix.
7. **Distance-protection grading** — compute zone reaches from line impedances (Z1/Z2/Z3 with margins, infeed effect), not just draw the mho circle.
8. **Documented automation API / Python client** — parametric studies, CI-style batch runs; the backend is already stateless JSON-in/JSON-out, so this is mostly packaging + docs.
9. **PSS-E RAW / CIM / DGS import** (backlog) — the migration on-ramp.
10. **Line/cable constants from geometry** + π-model charging (backlog, overhead section) — needed the moment users go above ~66 kV or model long cable runs.
11. **Two-layer soil model** for IEEE 80 + Wenner-measurement soil interpretation.
12. **Grid-code ride-through overlay** on the existing transient-stability IBR results.
13. **IEC 60287 first-principles cable ampacity** (soil ρ, depth, group mutual heating) to complement the table-based derating.
14. **Reliability indices** (backlog) and **hosting capacity** (backlog) — the two remaining planning modules ETAP 2026 markets hard.

### Tier 3 — structural / accept-as-positioning
15. **EMT simulation** — different solver class (µs steps, Dommel line models, switching-level converters). Recommend explicitly declaring out of scope.
16. **Small-signal / modal analysis** — valuable but demands the standard-model library first.
17. **Standard + user-defined dynamic model library** — large sustained investment; without it, transient results can't be reconciled with utility-supplied model data.
18. **Manufacturer device-library depth** — thousands of verified relay/breaker/fuse models is a curation business, not a coding task. Mitigate with the existing CSV import plus per-manufacturer import templates.
19. **State estimation, SCADA digital twin, OPF at transmission scale, switching management** — operational-software territory; only pursue if the product aims there.
20. **Solver scalability** (dense matrices, SQLite, full-JSON transfer) — fine for the target market; revisit only if >1000-bus networks become a real use case.

### Existing partials worth finishing (already known, restated for completeness)
- OLTC auto-regulation on standard 2-winding transformers (only autotransformers iterate today).
- VFD starting profile in dynamic motor starting (soft-starter is modelled; VFD is not).
- Overhead-line fidelity items already ranked in the backlog (R(T), Z₀ mutual coupling, geometry-driven X, earth-wire Z₀, IEEE 738).
- Harmonic phase-angle summation (IEC 61000-3-6) and background distortion.
- Real-time collaboration + audit trail (backlog).

---

## 4. Capabilities the big three lack (differentiators to protect)

- **Browser-native, zero-install, mobile-capable** — none of the three run in a browser.
- **LV detail design**: DB circuit schedules with phase balancing/earth-leakage, SANS 10142 compliance, NRS 034 ADMD reticulation, floor-plan auto-circuiting, BOQ — this is Amtech/Hager-class functionality fused to network analysis; ETAP/PF/PSS have nothing comparable.
- **Plan markup workspace** (site/floor plans, DXF round-trip, lux heatmap, multi-floor risers).
- **DC arc flash** (PF and PSS lack it).
- **In-app verification & validation transparency** — every engine pinned to published standard calculations, visible to the user.
- **Control-circuit simulation + CB interlocking logic** at the price point.

---

## Sources

- [ETAP 2026 release](https://etap.com/product-releases/etap-2026-release) · [ETAP products](https://etap.com/product) · [ETAP network analysis package](https://etap.com/packages/network-analysis)
- [DIgSILENT PowerFactory 2026 release](https://www.digsilent.de/en/newsreader/digsilent-releases-powerfactory-2026.html) · [PF EMT simulation](https://www.digsilent.de/en/electromagnetic-transients-emt.html) · [PF stability (RMS) functions](https://www.digsilent.de/en/stability-analysis.html)
- [Siemens Gridscale X PSS®E](https://www.siemens.com/en-us/products/pss-software/psse/) · [PSS®SINCAL platform](https://www.siemens.com/en-us/products/pss-software/pss-sincal/) · [PSS®SINCAL electricity modules](https://www.siemens.com/en-us/products/pss-software/pss-sincal-electricity/)
