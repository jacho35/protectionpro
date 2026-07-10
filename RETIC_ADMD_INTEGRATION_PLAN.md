# Reticulation / ADMD Integration Plan

**Goal:** Bring Retic Builder Pro's ADMD (After Diversity Maximum Demand) methodology into
ProtectionPro as a **parallel "Reticulation" workspace** — kiosks + erven + service/LV/street-light
cable runs, per-phase diversity aggregation, and feeder volt-drop chains — driven by an editable
NRS 034-1 / CTEF100 load-class library, using **both** the Empirical and Herman-Beta estimation
methods.

**Source reference:** `retic-builder-pro-v2.0.5.html` (in repo). Verified against the latest cloud
build `retic-builder-pro-2.0.44.html` — the ADMD engine (class tables, correction factors,
Herman-Beta/Empirical formulas, per-phase aggregation) is **identical** across the two versions, so
2.0.5 is a safe basis.

---

## 1. What we are porting — the ADMD engine (spec)

Two estimation methods, selected per project via `estimationMethod`.

### Empirical — `Diversified demand = N × ADMD × DCF(N)`
```
I_admd    = ADMD × 1000 / (230 × phaseMult)        # per-consumer current, A
totalI    = N × I_admd × DCF(N)
totalKVA  = totalI × 230 × phaseMult / 1000
feederI   = totalI × UCF(N)                         # UCF used for VD only, NOT for kVA total
```
Correction sets (`CORRECTION_METHODS`):
| Method  | DCF(N, admd)                        | UCF(N)              |
|---------|-------------------------------------|---------------------|
| AMEU    | `1 + 2/N`                           | `1 + 2.8/√N`        |
| British | `1 + (admd≤5 ? 8 : 12)/(admd·N)`    | `1 + 4.14/√N`       |
| None    | `1`                                 | `1`                 |

### Herman-Beta — statistical Beta(α,β)·c → Normal(µ,σ), summed over N
```
µ    = α/(α+β) · c
σ    = c · √( αβ / ((α+β)²(α+β+1)) )
γ₁   = 2(β−α)√(α+β+1) / ((α+β+2)√(αβ))              # Beta skewness
z    = 1.28                                          # 10% risk / 90% confidence
z_cf = z + (z²−1)/6 · (γ₁/√N)                        # Cornish-Fisher 1st-order
I    = N·µ + z_cf·√N·σ
totalKVA = I × 230 × phaseMult / 1000
```
DCF/UCF are **not** applied under Herman-Beta — diversity is inherent in the √N term.

### Constants & conventions
- Single-phase 230 V; three-phase line 400 V (√3·400 for kVA↔A).
- A **3-phase erf counts as 3 single-phase connections**, split across R/W/B.
- ADMD tables are **per-phase** (no phase multiplier in `calcBetaParams`).
- Default ADMD fallback 4.04 kVA (Urban Residential I).
- `ampsOverride` on an erf ⇒ fixed, **undiversified** load: `amps × (3ph? √3·400 : 230)/1000`.

### Load-class tables (to become the editable library)
- `LOAD_CLASSES` — CTEF100 Appendix A1 (CoCT-modified NRS 034-1 Table 3, 15-yr): informal,
  township, urban I/II, upmarket I, upmarket I/II (3Φ). *(active default set)*
- `LOAD_CLASSES_NRS034` — NRS 034-1 Table 3a reference (rural→estate).
- `LOAD_CLASSES_COMMERCIAL` — `vaPerM2` (commercial/industrial) or `fixedKVA` (school/church/clinic).
  **Note:** defined in both retic versions but never actually computed — treat as future work,
  not part of the faithful port.

### Aggregation up the network (per-phase superposition)
- **Per kiosk** (`calcKioskDiversifiedDemand`): bucket erven into R/W/B (3-phase + unassigned
  spread across all three), run the demand calc per bucket, sum kVA.
- **Downstream tree / feeder** (`computeLVCableLoads`): recursively collect all downstream kiosks
  (cycle-guarded). Herman-Beta accumulates erven into a `clsId|phase` map so the √N benefit sees
  the *whole* downstream count; Empirical sums weighted N so DCF sees the full N. Override kVA and
  street-lighting kVA are added on top **undiversified**.
- Net behaviour: as N grows, Empirical DCF→1 and Herman-Beta per-consumer share shrinks — the
  coincidence/diversity effect.

---

## 2. Architectural context — two different paradigms

| | ProtectionPro | Retic Builder Pro |
|---|---|---|
| Model | SLD node-graph (components + wires) | Reticulation layout (kiosks → erven, cable schedules, site plan) |
| Analysis | Per-unit IEC 60909 / IEEE / N-R load flow | NRS 034-1 demand → cable/txfmr sizing, feeder VD |
| Voltage | kV, per-unit | 230/400 V LV |
| Frontend | **Vanilla JS**, no framework | **React** (JSX / transpiled) |
| Backend | Python/FastAPI engines | none — all client-side JS |

**Consequences that shape the plan:**
1. The React code **cannot be pasted in** — the workspace UI must be re-implemented in vanilla JS
   to match ProtectionPro's architecture (`app.js` module pattern, `AppState`, SVG canvas).
2. The **calculation core should move to the backend** (Python) so it is testable with the existing
   regression harness and reusable by cable-sizing / transformer / report engines. The frontend
   calls it like every other study.
3. The two apps have **separate cable libraries** — these must be reconciled (see §7).

---

## 3. Backend plan

### 3.1 `backend/analysis/admd.py` — the engine (reusable core, Phase 0)
Pure port of the spec in §1. Functions:
- `beta_params(cls) -> {mean, sigma, skewness, admd_kva, phase}`
- `herman_beta_demand(n, cls, risk_z=1.28) -> {total_kva, current_a, admd_kva, design_i}`
- `empirical_demand(n, cls_or_admd, corr_method) -> {total_kva, current_a, admd_kva, dcf, ucf, feeder_current_a}`
- `calc_demand(n, est_method, corr_method, cls_or_admd)` — dispatcher
- `aggregate_demand(erven, est_method, corr_method, param)` — per-phase superposition (R/W/B
  bucketing, 3-phase = 3 conns, override handling)
- `roll_up_feeder(tree, ...)` — downstream accumulation (per-class-phase for Herman-Beta;
  combined-N for Empirical) + undiversified override/street-light kVA on top.

### 3.2 `backend/analysis/admd_data.py` — default class tables
`LOAD_CLASSES`, `LOAD_CLASSES_NRS034`, `LOAD_CLASSES_COMMERCIAL`, `CORRECTION_METHODS` (as data +
named formula keys) copied verbatim from §1. These are the *defaults*; a project may override them
(see §6 library).

### 3.3 Route `POST /api/analysis/admd` (`routes/analysis.py`)
Accepts the reticulation block (or a whole `ProjectData` with a `reticulation` section) plus demand
settings; returns per-kiosk, per-feeder, and total diversified demand, current, and the calc
breakdown (mirroring `buildDemandDetail`). Add Pydantic models in `models/schemas.py`.

### 3.4 Tests — `backend/tests/test_regression.py`
Pin hand-calculated values for each method against the standard, e.g.:
- Urban I (ADMD 4.04), N=1 → I = 4.04·1000/230·(1+2/1) A; N=100 → DCF≈1.02.
- Herman-Beta Urban I, N=1 → I≈µ + z_cf·σ; large N → I/N → µ.
- 3-phase erf counts as 3; override erf excluded from diversified N.
These lock the port to the source app's numbers.

---

## 4. Frontend plan (vanilla JS)

### 4.1 New workspace / mode
Add a **"Reticulation"** workspace toggle (top-level view switch, like a second tab beside the SLD
canvas). It renders its own panels rather than the component palette + SVG SLD.

New modules under `frontend/js/retic/`:
- `retic-state.js` — `AppState.reticulation` sub-store (kiosks, erven, cable rows, demand settings).
- `retic-kiosks.js` — kiosk & erf schedule tables (add/edit/delete, phase assignment, class,
  ADMD override, amps override, cable-type pick, length).
- `retic-demand.js` — calls `/api/analysis/admd`, renders per-kiosk badges (kVA / A / ADMD) and the
  calc-detail popover.
- `retic-feeder.js` — chain summary + cumulative feeder volt-drop table (reuses backend VD).
- `retic-streetlight.js` — SL circuits (poles, luminaires) → SL kVA rollup *(later phase)*.
- `retic-report.js` — demand schedule / cable schedule export.

### 4.2 State & persistence
- Extend `state.js`: `AppState.reticulation = { projectInfo, kiosks, cableRows, serviceCable,
  streetLight }`, included in `serialize()` / `load()` and in undo snapshots.
- Persists automatically through the existing project save/load + SQLite `data` JSON blob.

### 4.3 API client (`api.js`)
`runAdmd(data)` → `/analysis/admd`; include reticulation results in the study-manager batch and the
`buildProjectPayload` export.

---

## 5. Data model (extends `ProjectData`)

Add an optional `reticulation` object (keeps SLD projects untouched when absent):
```
reticulation: {
  projectInfo:  { estimationMethod: "Empirical"|"Herman Beta",
                  correctionMethod: "AMEU"|"British"|"None",
                  loadClass: "urban1", admd: 4.04, earthingSystem },
  kiosks:       [ { id, name, fedFrom, loadClass?, admdOverride?, erfs: [
                    { id, erfNumber, length, phase:"Red|White|Blue|3 Phase",
                      cableType, ratedAmps, ampsOverride } ] } ],
  cableRows:    [ { id, from, to, cableType, ... } ],   // LV / MV feeder segments
  serviceCable: { snaking, additional, maxRunVD, defaultAmps, ... },
  streetLight:  { circuits: [...] },                     // later phase
  loadClassLib: [ ...class rows... ]                     // project override of defaults (§6)
}
```
Topology is by name reference (`fedFrom`, `from`/`to`) exactly as the source app — simplest faithful
port; graph walks are cycle-guarded server-side.

---

## 6. Editable Load-Class library (Settings modal)

Mirror the existing cable/transformer libraries in `standard-data.js`:
- New **"Load Classes"** tab in the Settings modal listing each class with editable
  `label, α, β, c, ADMD, µ, σ, phase`, plus **Reset to defaults** (NRS 034-1 / CTEF100).
- Also expose editable **correction-method** selection (AMEU / British / None) and default
  `estimationMethod` / project ADMD.
- Persist in the project (`reticulation.loadClassLib`) and cache to `localStorage` like the cable
  library. Backend `admd_data.py` supplies the seed defaults; if a project ships its own
  `loadClassLib`, the engine uses that.

---

## 7. Integration with existing ProtectionPro engines

1. **Cable sizing** (`cable_sizing.py`, IEC 60364): feed the diversified feeder current
   (`feeder_current_a`, i.e. including UCF for VD) and the diversified kVA current into the existing
   ampacity / volt-drop / fault-withstand checks — reuse rather than reimplement retic's cable math.
2. **Transformer loading** (`load_diversity.py`): a reticulation feeder's rolled-up diversified kVA
   becomes the demand seen by its supplying transformer/mini-sub; compare to rating exactly as the
   IEC path does today.
3. **Represent a feeder on the SLD (optional bridge):** allow a reticulation feeder to appear as an
   equivalent `static_load` / `distribution_board` on the SLD canvas (rated_kva = diversified kVA),
   so fault / load-flow studies can include it. This links the two workspaces.
4. **Cable library reconciliation:** ProtectionPro's library is keyed by kV and R/X per km; retic's
   is LV-centric with ampacity/rating fields. Task: map retic cable types onto ProtectionPro's
   library schema (or extend it with the missing LV ampacity fields) so one library serves both.

---

## 8. Phased delivery (each phase independently shippable/testable)

| Phase | Deliverable | Risk |
|-------|-------------|------|
| **0** | `admd.py` + `admd_data.py` + `/api/analysis/admd` + regression tests | Low — pure, testable core; de-risks everything |
| **1** | Editable Load-Class library in Settings (§6) | Low |
| **2** | `reticulation` data model + save/load/undo/DB (§5) | Low–Med |
| **3** | Reticulation workspace UI: kiosk/erf tables + per-kiosk demand badges (§4) | **High** — bulk of the work, vanilla-JS rebuild |
| **4** | Feeder chains, per-phase rollup, cumulative volt-drop | Med |
| **5** | Integration: cable sizing, transformer loading, SLD-feeder bridge (§7) | Med |
| **6** | Reporting (demand + cable schedule PDF/CSV) + street lighting | Med |

Recommendation: **build Phase 0 first as a standalone, fully-tested engine.** It delivers immediate
value (an ADMD calculator endpoint) and guarantees numeric fidelity before the large UI investment.

---

## 9. Open questions / risks

- **Vanilla-JS rebuild of a React app** is the dominant cost — Phase 3 is where the estimate lives
  or dies. Consider whether a lighter "ADMD calculator + demand schedule table" (no site-plan
  geometry) satisfies the real need before committing to the full geographic workspace.
- **Cable library reconciliation** (§7.4) touches shared data — scope carefully to avoid regressing
  existing SLD cable sizing.
- **Site-plan geometry** (routes/trenches/drawings) from retic is a large sub-app; recommend
  deferring or excluding unless geographic layout is a hard requirement.
- **Commercial load classes** (`vaPerM2`/`fixedKVA`) are unused in the source — port the data but
  flag the calc as new work, not a faithful port.

---

## 10. Standards provenance
- NRS 034-1 (SA distribution load estimation, Herman-Beta), CTEF100 Appendix A1 (CoCT-modified
  Table 3, 15-year), AMEU / British diversity correction factors, "ReticMaster" DCF/UCF forms.
- LV service voltages 230 V (1Φ) / 400 V (3Φ); risk level z=1.28 (10%).
