# CLAUDE.md — ProtectionPro Reference Guide

## Development Workflow Instructions

**After building any feature**, always update `BACKLOG.md`:
1. Delete its line from the `## Outstanding Items — ordered` index at the top
2. Mark the completed item as done in its original section (strikethrough with `~~text~~`)
3. Add a concise entry to the `## Completed` section at the bottom

**Every PR sets the app version to its own PR number**: `APP_VERSION = '1.<PR number>b'` in `frontend/js/constants.js` (PR #348 → `1.348b`). The number is only known once the PR exists, so open the PR, then push a commit that bumps `APP_VERSION` to it. Bump the `?v=` cache-bust in `index.html` in the same commit.

**Engine reviews, audits, method/validation write-ups and roadmaps** (`*_REVIEW.md`, `ENGINE_REVIEW_*.md`, `EARTH_GRID_METHOD.md`, `FEATURE_GAP_ANALYSIS.md`, `TRANSIENT_STABILITY_ROADMAP.md`, `QUANTITY_RULES_PLAN.md`, `audit-history/`) live in `reviews/` — local only, gitignored. Code comments refer to them as `reviews/<file>`; put new ones there, never in the repo root. **User-facing text (help articles, PDF reports, verification-template descriptions, UI strings) never cites a `.md` file** — users can't open them; state the result instead.

## What is ProtectionPro?

A browser-based power systems engineering tool for designing single-line diagrams (SLDs) and running electrical analysis. Think of it as a lightweight, web-based alternative to ETAP.

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3, SVG — no framework, no bundler
- **Backend**: Python 3.12, FastAPI 0.115.0, SQLAlchemy ORM, SQLite
- **Analysis**: NumPy/SciPy for numerical solvers
- **Deployment**: Docker Compose (backend + nginx frontend)

## Project Structure

```
frontend/
├── index.html              # SPA entry point
├── css/
│   ├── app.css             # Global styles & CSS variables
│   ├── toolbar.css         # Toolbar & export dropdown
│   ├── sidebar.css         # Component palette sidebar
│   ├── properties.css      # Properties panel
│   └── symbols.css         # SVG component symbols
└── js/
    ├── app.js              # Entry point, keyboard shortcuts, module initialization
    ├── state.js            # Global AppState (components, wires, selection, results)
    ├── grid.js             # GridTable — shared Excel-style table editing (keys, range select, TSV copy/paste, fill down, number cleaning); attach to every editable table
    ├── canvas.js           # SVG rendering, pan/zoom, grid, 5-layer system
    ├── sidebar.js          # Searchable component palette, drag-drop
    ├── wiring.js           # Orthogonal wire routing, port snapping
    ├── components.js       # Network graph validation, adjacency, cycle detection
    ├── symbols.js          # IEC-standard SVG symbol generators (40 types)
    ├── properties.js       # Dynamic property editor per component type
    ├── tripunit.js         # TripUnit — MCCB/ACB trip-unit profiles (TRIP_UNITS in constants.js): library pick writes the entry's settings as defaults, dial pickers + edited/reset, Ir suggestion (Ib ≤ Ir ≤ Iz), keep-or-reset dialog on a breaker swap, TCC drawer rows; `trip_unit_kind: 'electronic'` gives an MCCB short-time/instantaneous in every engine
    ├── annotations.js      # Draggable fault/loadflow result badges
    ├── cablefocus.js       # CableFocus — cable-sizing result boxes filtered to the selected bus's incoming/outgoing cables (Results menu / bus properties button / results-table 'At bus'), rest of the sheet dimmed; session-only
    ├── project.js          # Save/load/export (JSON/SVG/PNG/CSV/PDF)
    ├── api.js              # HTTP client for backend endpoints
    ├── constants.js        # Component definitions, cable/transformer libraries
    ├── cablelib.js         # CableLib — the ONE cable library (STANDARD_CABLES): construction/cores, name aliases, pickers (Demand/plan/SLD), project conductor preference, custom cables carried in the project
    ├── standard-data.js    # Settings modal, editable cable/transformer/CB/fuse/load-class libraries (layered: shipped defaults → company standard → shared libraries → the user's own overrides, saved to their account via `/api/user-libraries` as overrides-only (`format: 'overrides'`, `{set, removed}` per library); an override records the company/shared entry version it was made against (`base`), so a later change shows as Out of date + Review; a project stores only the custom/edited entries it uses as `libraryItems` (+ `libraryOrigins`: custom / edited shipped / shared library / company) and, on open, is compared with the user's libraries and asks — never overwrites them)
    ├── libraries.js        # Libraries manager (Project → Libraries…): the five libraries with source/status/history per entry, Rates & prices, Out of date, Team libraries (your layer order + clashes), Submissions, Activity log, export; the library editors (panes in #lib-panes, `lib-pane-<tab>`) are docked in here and edited in place; admins retire/restore company entries and restore earlier versions; Settings has no library tabs
    ├── submissions.js      # Company library submissions — Project → Library Submissions… queue (admins approve / request changes / reject, never their own), `pickAndSubmit` from the Libraries manager, rate prices submitted from the rate library; backend routes/library_submissions.py
    ├── notifications.js    # Notifications center — bell + side panel (Libraries / Projects / Approvals), unread polling; server writes them via backend/notifications.py `notify()`
    ├── quote.js            # Quoted-project freeze — Project → Mark as Quoted… locks the rate library + the library entries the project was quoted with (AppState.quoted / quotedLibrary / quoteLog)
    ├── shared-libs.js      # Settings › Shared Libraries panel — create/rename/delete, members + roles, leave, admin company-standard switch, "edit its entries" (edit target), Publish my entries; layering + per-entry versioned saves live in standard-data.js
    ├── templates.js        # Pre-built network templates (radial, ring, mesh)
    ├── tcc.js              # Time-current curve coordination plotting
    ├── dynmotor.js         # Dynamic motor starting modal + SVG time-series charts
    ├── dbschedule.js       # DB circuit schedule grid — renders into the #db-modal OR the Schedules workspace
    ├── schedules.js        # Schedules workspace (every board: rail + full-height grid + per-way circuit check)
    ├── sl-diagram.js       # Street lighting circuit schematic (SLDiagram): source → main run, spurs on rows below, per-pole phase/VD/Zs, span length/current/neutral; zoom, PNG/SVG export
    ├── roadlight.js        # Street lighting › Lighting design: SANS 10098 / EN 13201 road lighting on a cross-section (SANS category helper from the functional road class) (strips, luminaire rows, arrangements), luminaire library (IES/LDT import, generic optics), results/isolux, max-spacing + optimiser, apply spacing to a circuit; state in reticulation.streetLighting.roadDesigns/.photometry; PDF in roadlight-report.js
    ├── searchselect.js     # SearchSelect.attach(select) — wildcard type-to-filter box over a hidden native <select> (the select keeps its value + change handler); used by the street-light circuit + Quick calc cable and luminaire pickers; `<option data-ss-always>` is listed whatever is typed
    ├── streetlight.js      # Street lighting workspace (Reticulation): circuits fed from a kiosk/minisub as a tree of poles (3Φ R-W-B rotation, spurs carry it on, or 1Φ string), pole grid, results, Quick calc, Sync from plan; circuit kVA → source streetLightKVA (streetLightFromCircuits); luminaire pickers = built-in SL_LUMINAIRES + the project photometry library as 'ph:<id>' (StreetLight.luminaires(), rated W + pf from the photometry entry)
    ├── workspaces.js       # Project type (Reticulation / Building / Network) → which workspace tabs show, in workflow order; New-project + type dialogs
    ├── help.js             # Help 'Calculations & tools' viewer: ranked search, KaTeX (js/lib/katex) lazy-loaded; articles are data in help-{faults,flow,dynamics,protect,cables,design,workflow}.js (TeX between $…$ / $$…$$; never a literal $ in text)
    ├── header.js           # Two-row header behaviours: Results menu lists only studies with results; Ctrl K command search (index built from the menus)
    ├── earthgrid.js        # Earth grid editor (AppState.earthGrids): grid list, layout/rods/fences/added metal/calculation form, live plan / 3-D preview via /earth-grid/preview, click-to-place conductors + rods on the plan; edits a working copy — Save/Revert, discard prompt on close; buses pick a grid in their grounding section
    ├── lightning.js        # Lightning risk (IEC 62305-2, edition per assessment: 2024 default / 2010, absent ⇒ 2010): named assessments saved in the project (AppState.lightningAssessments), 4 guided steps (data-lr-ed fields per edition), live strike estimate, verdict-first results (2024: per zone + frequency F), PDF report (LightningReport)
    ├── lfstudy.js          # Load Flow Study Manager (named full-snapshot cases, attribute grid, comparison)
    ├── voltage-stability.js # Voltage stability UI (P-V / Q-V setup + charts)
    ├── freqscan.js         # Frequency scan UI (Z vs f setup + log-decade chart)
    ├── battsizing.js       # Battery sizing & discharge UI (duty editor + SoC/V charts)
    ├── opf.js              # Optimal power flow UI (objective/controls setup + comparison tables)
    ├── reliability.js      # Reliability UI (IEEE 1366 indices chips + load-point/FMEA tables)
    ├── filtersizing.js     # Passive filter sizing UI (setup + design/THD tables)
    ├── capplace.js         # Optimal capacitor placement UI (budgets setup + placement tables)
    ├── flicker.js          # Voltage flicker UI (IEC 61000-3-3 setup + Pst/Plt per-motor table)
    ├── hostingcapacity.js  # Nodal hosting capacity UI (DER limits setup + per-bus MW table)
    ├── contingency.js      # Contingency analysis UI (N-1 / N-2 setup + ranked violations table)
    ├── timeseries.js       # Time-series / quasi-dynamic load flow UI (horizon/step/profile setup + voltage/loading/SoC charts)
    ├── reports.js          # Client-side PDF via jsPDF + autoTable
    ├── rates.js            # Rate library — item-key catalogue, per-project material + labour rates, "Quantity from" rules (getRule/ruleText/parseRule), starter items, Add item, CSV/XLSX round trip with import preview
    ├── boq.js              # Bill of quantities — take-off over Demand / plans / SLD / DB schedules + rule lines from BOQ.BASES counts, material/labour split, % allowances; priced from rates.js
    ├── quantities.js       # Quantities workspace tab (last step of Reticulation / Building; opt-in for Network, or kept once the rate library has data): rail + the BOQ / Cable schedules / Rate library dialogs docked into the pane (`.q-docked`, their close() is then a no-op); Output-menu items and Ctrl K route here
    ├── cableschedules.js   # Cable schedules — retic feeders/services (Demand VD) + building sub-mains (LF) / final circuits (circuit check)
    ├── compliance.js       # Standards compliance verification
    ├── minimap.js          # Scaled diagram overview widget
    └── undo.js             # Snapshot-based undo/redo (50 states max)

clients/
├── python/                 # Python API client (protectionpro_client.py, httpx) — batch/parametric scripting; see its README
└── mcp/                    # MCP server (protectionpro_mcp) over that client: component-level read/edit tools + run_analysis for AI agents, no project deletion; component_catalog.json is generated from COMPONENT_DEFS by build_catalog.mjs; see its README

backend/
├── mailer.py               # Optional SMTP: config in app_settings (password never returned), send_email, invite/reset messages; callers fall back to a copy-able link when get_config() is None
├── main.py                 # FastAPI app, CORS, static file serving, DB init
├── models/
│   ├── database.py         # SQLAlchemy Project model, SQLite setup
│   └── schemas.py          # Pydantic request/response models
├── analysis/
│   ├── fault.py            # IEC 60909 short-circuit (3-phase, SLG, LL, LLG)
│   ├── loadflow.py         # Newton-Raphson & Gauss-Seidel solvers
│   ├── loadflow_cases.py   # Load Flow Study Manager — run load flow across named network cases
│   ├── voltage_stability.py # Steady-state voltage stability — P-V nose curves, Q-V reactive margin, loadability margin
│   ├── contingency.py      # Contingency analysis (N-1 / N-2) — element-outage security screening
│   ├── timeseries_loadflow.py # Time-series / quasi-dynamic load flow — 24h/8760h load & generation profiles, BESS SoC + OLTC tap carried between steps
│   ├── frequency_scan.py   # Driving-point impedance vs frequency — parallel/series resonance identification
│   ├── battery_sizing.py   # Duty-cycle battery sizing (IEEE 485-style factors) + discharge simulation
│   ├── optimal_powerflow.py # OPF — merit-order economic dispatch + greedy discrete Volt/VAR hill climb
│   ├── reliability.py      # SAIDI/SAIFI/MAIFI (IEEE 1366) — analytical FMEA over connectivity outages
│   ├── filter_sizing.py    # Passive harmonic filter sizing — single-tuned branches to IEEE 519
│   ├── capacitor_placement.py # Optimal capacitor placement — greedy loss-sensitivity over LF solves
│   ├── flicker.py          # Voltage flicker (IEC 61000-3-3/-4-15) — planning-level Pst/Plt screening for repetitive motor starts
│   ├── hosting_capacity.py # Nodal DER hosting capacity — voltage-rise/thermal limited PV injection sweep per bus
│   ├── arcflash.py         # Arc flash incident energy — IEEE 1584-2002 and 1584-2018
│   ├── lightning_risk.py   # IEC 62305-2:2010 R1 (the default for a request with no `edition`); dispatches edition "2024" →
│   ├── lightning_risk_2024.py # IEC 62305-2:2024 — R = R_L1 + R_L2 per zone, frequency of damage F, N_SG = k·N_G; pinned to Annex F (house/office/hospital)
│   ├── cable_sizing.py     # IEC 60364 thermal, voltage drop, fault withstand
│   ├── street_lighting.py  # Street lighting circuits — phasor VD per pole incl. neutral, cumulative VD (supply + circuit), Zs vs Ia, max-poles solver, smallest cable
│   ├── road_lighting.py    # CIE 140 / EN 13201-3 road lighting on a cross-section — E, L (CIE r-tables in road_rtables.py), Uo/Ul/TI/REI vs SANS 10098-1/-2 categories or EN 13201-2 M/C/P classes, PDI/AECI, max-spacing + height×tilt×overhang×luminaire×dimming optimiser
│   ├── photometry.py       # IES LM-63 / EULUMDAT → canonical Type C web (0–360° C planes), generic road optics
│   ├── retic_earth.py      # Reticulation earth-fault loop (Zs = transformer Ze + Σ(R1+R2+jX1)·L vs the minisub LV device's clearing time, IEC 60364-4-41) + ECC size per LV cable (Table 54.7 or §543.1.2 adiabatic, Cu/Al); per-minisub earthing system (TN-S / TN-C / TN-C-S: which LV cables take a separate earth conductor vs a PEN) and per-kiosk feeder protection (nearest upstream device clears); frontend resolves transformer/device/cables to numbers
│   ├── db_circuit_check.py # Per-way DB circuit check — derated Iz, Ib<=In<=Iz, volt drop, ECC, earth-loop Zs
│   ├── iec_60364_tables.py # IEC 60364-5-52 installed-ampacity lookups + ambient/soil tables; capacities (2/3 loaded conductors, methods A1–G) and grouping (B.52.17–19) live in the GENERATED iec_60364_data.py / frontend js/iec-60364-data.js — edit testing/iec-60364-tables-review/iec_60364_5_52_data.json and run build_iec_tables.py, never by hand
│   ├── motor_starting.py   # Locked-rotor current, voltage dip analysis
│   ├── dynamic_motor_starting.py # Time-domain motor acceleration (swing equation)
│   ├── duty_check.py       # Equipment fault current rating validation
│   ├── load_diversity.py   # Maximum demand: nodes (buses/boards) + branches, supply direction from the utility, board-by-board Ks (IEC 61439) roll-up, transformer = its downstream side (parallel units share by rating)
│   ├── grounding_system.py # IEEE 80 grounding grid design; two-layer soil = IEEE 80 values × method-of-moments ratios (layered vs uniform ρ1); I_G uses the fault engine's `ik1_remote_fraction` (share not returning to a local neutral) × S_f; review: reviews/GROUNDING_REVIEW.md
│   ├── earth_grid.py       # Earth grids of any shape (ProjectData.earthGrids, bus `earth_grid_id`): layout/rod/fence generators → wires, method-of-moments solve (bonded = GPR, unbonded groups float), surface potential, touch/step to IEEE 80 Annex H.3 conventions, connectivity + conductor-impedance checks; `preview()` for the editor
│   ├── earth_grid_study.py # Per-bus result for a bus on an earth grid: IEEE 80 simplified (plain rectangle only) or numerical headline, IEEE 80 or EN 50522 limits (C2/C3/C4); technical basis + validation: reviews/EARTH_GRID_METHOD.md
│   ├── study_manager.py    # Batch analysis orchestration
│   ├── changeover.py       # Changeover switch → 2-terminal devices, applied by every analysis route before any engine runs
│   ├── offpage.py          # Linked off-page connector pairs → closed switches + a joining wire (props.linked_to; legacy same-name), applied after changeover
│   └── pdf_reports.py      # ReportLab PDF generation
└── routes/
    ├── analysis.py         # POST /api/analysis/* endpoints
    ├── projects.py         # CRUD /api/projects endpoints
    ├── email_settings.py   # GET/PUT /api/settings/email, POST /test (admin only)
    ├── user_libraries.py   # GET/PUT/DELETE /api/user-libraries (+ /default-rates) — the signed-in user's own libraries and default rates
    ├── shared_libraries.py # /api/shared-libraries — team libraries: members (view/edit), per-entry versioned saves (409 on stale), admin company standard
    └── reports.py          # CSV & PDF export endpoints
```

## Application Flow

### Startup

1. Backend: `uvicorn backend.main:app` starts FastAPI on port 8000
2. Backend serves frontend static files from `./frontend` at root `/`
3. On startup, SQLite database is initialized via SQLAlchemy
4. Frontend loads `index.html` → `DOMContentLoaded` triggers module init in `app.js`
5. Modules initialize in order: Canvas → Sidebar → Wiring → Properties → Annotations → Project → StandardData → TCC → UndoManager → MiniMap

### User Workflow

1. **Draw**: Drag components from sidebar onto SVG canvas → snap to grid
2. **Connect**: Wire mode (W key) draws orthogonal connections between component ports
3. **Configure**: Select component → edit electrical parameters in properties panel
4. **Analyze**: Toolbar buttons send project data to backend analysis endpoints
5. **Review**: Results appear as draggable annotation badges on the diagram
6. **Export**: Save project to DB, or export as JSON/SVG/PNG/CSV/PDF

## State Management

All state lives in `state.js` as a global `AppState` object:

```javascript
AppState = {
  components: [],          // Array of {id, type, x, y, rotation, props, labelOffsets}
  wires: [],               // Array of {id, fromComponent, fromPort, toComponent, toPort}
  selection: Set,           // Selected component/wire IDs
  clipboard: [],            // Copy/paste buffer
  mode: 'select',          // MODE.SELECT | MODE.WIRE | MODE.PLACE | MODE.PAN ('select'/'wire'/'place'/'pan')
  faultResults: null,       // One field PER STUDY — loadFlowResults, arcFlashResults, cableSizingResults,
  loadFlowResults: null,    //   motorStartingResults, stabilityResults, dbCheckResults, … (see the
  // …                      //   RESULT_SLOTS in state.js). There is no analysisResults.
  projectName: string,
  baseMVA: 100,
  frequency: 50,
  scenarios: [],            // Named network configuration snapshots
  nextId: int               // Counter behind genId(prefix) → string ids like 'bus_3', 'motor_induction_7'
}
```

## Canvas Architecture

SVG-based rendering with 5 ordered layers:
1. **Diagram background** — grid lines
2. **Components** — IEC symbol SVG groups
3. **Wires** — orthogonal polyline connections
4. **Annotations** — result badges and labels
5. **Overlay** — selection box, drag preview

Key behaviors: snap-to-grid (20px), zoom 10%-500%, pan via middle-click/scroll, rotation (0/90/180/270), dynamic bus resizing via side handles.

## API Endpoints

### Analysis (all POST, accept ProjectData JSON)
| Endpoint | Engine | Standard |
|---|---|---|
| `/api/analysis/fault` | Short-circuit | IEC 60909 |
| `/api/analysis/loadflow` | Power flow | Newton-Raphson / Gauss-Seidel |
| `/api/analysis/loadflow-cases` | Load flow across named full-snapshot cases | Load Flow Study Manager |
| `/api/analysis/voltage-stability` | Steady-state voltage stability | P-V / Q-V continuation (loadability & collapse) |
| `/api/analysis/contingency` | N-1 / N-2 security screening | Load-flow contingency analysis |
| `/api/analysis/timeseries-loadflow` | Quasi-dynamic time-series load flow | 24h/8760h load & generation profile, BESS SoC + OLTC tap carried between steps |
| `/api/analysis/frequency-scan` | Impedance vs frequency (resonance) | Nodal Z_kk(h) sweep on the harmonics network model |
| `/api/analysis/battery-sizing` | Duty-cycle battery sizing + discharge sim | IEEE 485-style factors, Peukert, OCV(SoC) |
| `/api/analysis/opf` | Economic dispatch + Volt/VAR optimization | Merit order by marginal cost + LF-scored hill climb |
| `/api/analysis/reliability` | SAIDI/SAIFI/MAIFI/EENS | IEEE 1366 indices, analytical FMEA (Billinton) |
| `/api/analysis/filter-sizing` | Passive harmonic filter design | Single-tuned synthesis verified vs IEEE 519 |
| `/api/analysis/capacitor-placement` | Optimal VAR placement & sizing | Greedy loss-sensitivity, LF-scored |
| `/api/analysis/flicker` | Voltage flicker (Pst/Plt) screening | IEC 61000-3-3-style curve on Thevenin d(%) — planning estimate, not a flickermeter |
| `/api/analysis/hosting-capacity` | Nodal DER hosting capacity | Voltage/thermal-limited PV injection sweep, LF-scored |
| `/api/analysis/arcflash` | Arc flash | IEEE 1584-2002 and IEEE 1584-2018 (per-bus `arc_flash_method`) |
| `/api/analysis/cable-sizing` | Cable sizing | IEC 60364 |
| `/api/analysis/street-lighting` | Street lighting circuits (form, not ProjectData) | Phasor VD per pole (R-W-B rotation / 1Φ), cumulative VD, Zs = Ze + 2·\|Z\|·L vs Ia, max-poles solver |
| `/api/analysis/road-lighting` | Road lighting on a cross-section (form, not ProjectData); `/road-lighting/photometry` parses IES/LDT, `/road-lighting/generic` makes a generic optic | CIE 140 / EN 13201-3 E / L (CIE r-tables), Uo, Ul, TI, REI; per-design `standard`: `SANS` (SANS 10098-1 A1–A4 by night traffic + median, B1–B3 / C1–C2, SANS 10098-2 RC0–5 / CP1–6; quarter-width observer) or `EN` (EN 13201-2 M/C/P; the default when absent); EN 13201-5 PDI/AECI; `mode` verify / maxSpacing / optimise |
| `/api/analysis/retic-earth-check` | Reticulation earth-fault loop + ECC size (form, not ProjectData; run by Demand after each ADMD compute) | IEC 60364-4-41 §411.4 (5 s, c_min = 0.95, device clearing time from the CB/fuse models), IEC 60364-5-54 Table 54.7 / §543.1.2 |
| `/api/analysis/db-circuit-check` | Per-way DB circuit schedule check | IEC 60364-5-52 Iz + 4-43 §433.1; volt drop from the origin per 5-52 Table G.52.1 / SANS 10142-1 Cl. 6.6; IEC 60364-5-54 §543.1 ECC (Table 54.7 or adiabatic); IEC 60364-4-41 Zs (magnetic / RCD TN·TT / declared time) |
| `/api/analysis/motor-starting` | Voltage dip | Motor starting analysis |
| `/api/analysis/dynamic-motor-starting` | Motor acceleration | Time-domain swing-equation simulation |
| `/api/analysis/duty-check` | Equipment duty | IEC 60947-2 / IEC 60269 (LV breakers, fuses: largest prospective I″k), IEC 62271-100 (MV: Ib, asymmetry, making), Icw, Ur ≥ Um; relay-fed CTs (IEC 61869-2) and VTs (IEC 61869-3: burden, rated primary vs bus, voltage factor vs the bus earth fault factor) |
| `/api/analysis/load-diversity` | Maximum demand per board and transformer (demand rolled up from the supply, phasor P + jQ) | IEC 61439 rated diversity factor Ks per LV board; per-load demand factors |
| `/api/analysis/grounding` | Grounding grid (optional `groundingBusIds` = selected buses only) | IEEE 80 per bus; buses on an earth grid object: numerical (method of moments) with IEEE 80 or EN 50522:2022 limits; conductor size (mm²) checked against Onderdonk |
| `/api/analysis/earth-grid/preview` | Earth grid geometry for the editor (`{grid}`, not ProjectData) | plan, element count, connectivity, IEEE 80 applicability — no solve |
| `/api/analysis/lightning-risk` | Lightning risk (form, not ProjectData) | IEC 62305-2:2024 (`edition: "2024"`, R + F per zone) or 2010 (R1; absent `edition`) |
| `/api/analysis/study-manager` | Batch all studies | Runs selected analyses |

### Projects (CRUD)
- `GET /api/projects` — list all
- `POST /api/projects` — create
- `GET /api/projects/{id}` — get (returns ProjectData JSON)
- `PUT /api/projects/{id}` — update
- `DELETE /api/projects/{id}` — delete
- `GET /api/projects/{id}/export/json` — export JSON
- `GET /api/projects/{id}/export/csv` — export CSV

### User libraries
- `GET /api/user-libraries` — the user's cable/transformer/CB/fuse/load-class libraries (`data: null` until first save)
- `PUT /api/user-libraries` — replace the whole document (last write wins); `DELETE` — back to shipped defaults
- `GET/PUT/DELETE /api/user-libraries/default-rates` — the user's saved default rates (seed for a new project's rate library; "Save as my default" in the rate library)

### Shared (team) libraries
- `GET /api/shared-libraries` — every library the caller can read (owned, member, or the company standard) with its entries
- `POST` create; `PATCH /{id}` rename; `DELETE /{id}` (owner); `PUT /{id}/company-default` (admin only, one at a time; everyone then reads it read-only)
- `GET/POST /{id}/members`, `PATCH|DELETE /{id}/members/{user_id}` — owner manages view/edit roles; a member may remove themselves
- `PUT /{id}/entries/{kind}/{entry_id}` with `base_version` (omit to create) — **409 with the current entry if someone changed it first**; `DELETE` (optional `base_version`); `POST /{id}/entries/import` (create-only bulk)

### Reports
- `POST /api/reports/pdf` — generate full PDF report
- `POST /api/reports/arcflash-labels` — generate arc flash warning labels

## Database

SQLite; the main table is `Project` (plus users, folders, revisions, shares, plan images and `user_libraries`, `user_default_rates` — one row per user — and `shared_libraries` / `shared_library_members` / `shared_library_entries`):

```
Project:
  id          INTEGER PRIMARY KEY
  name        VARCHAR(255)
  data        TEXT          -- Full ProjectData as JSON string
  base_mva    FLOAT         -- Default 100.0
  frequency   INTEGER       -- Default 50 Hz
  created_at  DATETIME
  updated_at  DATETIME
```

DB path: `DATABASE_URL` env var, defaults to `sqlite:///./protectionpro.db`

## Component Types (40 — 31 power + 9 control-circuit)

| Category | Components |
|---|---|
| **Sources** | Utility Source, Generator, Solar PV, Wind Turbine, Battery Storage |
| **Distribution** | Bus, Transformer, Autotransformer, Cable/Feeder, Bus Duct |
| **Protection** | Circuit Breaker, Fuse, Relay, Switch, Changeover Switch (3-port: in_1 / in_2 / out) |
| **Instruments** | Current Transformer (CT), Potential Transformer (PT) |
| **Loads** | Induction Motor, Synchronous Motor, Static Load, Distribution Board, DC Load, Variable Frequency Drive |
| **DC systems** | UPS, Rectifier, Battery Charger, DC Battery |
| **Other** | SVC / STATCOM, Capacitor Bank, Surge Arrester, Off-page Connector |
| **Control** | Control Supply, Control Breaker (MCB), Pushbutton NO / NC, Selector Switch, Contact NO / NC, Coil / Relay, Pilot Lamp |

Component definitions (default props, ports, SVG dimensions) are in `constants.js` under `COMPONENT_DEFS`.

## Built-in Libraries

- **Cable Library** (~140 entries, the only cable library in the app — `STANDARD_CABLES`, read through `CableLib`): MV/LV armoured multicore Cu/Al XLPE/PVC 0.4-33kV (MV 3-core, LV 4-core), LV 2-core single-phase service cables, building wiring (T+E, H07V-R singles, Surfix, control) and insulated earth conductors (`construction: 'earth'`, Cu 1.5–300 mm² and Al 16–300 mm², offered only as the earth conductor in Demand's earth-fault / ECC checks). Each entry has `construction` + `cores`. Demand, plans, SLD and DB schedules all pick from it; rate/termination keys come from the entry's id. Never add a second cable list
- **Transformer Library** (22 entries): 100kVA-80MVA, vector groups, impedance values

Both are editable via the Settings modal and can be reset to defaults.

## Analysis Engine Details

### Fault Analysis (fault.py)
- Per-unit impedance method with configurable base MVA
- Traces source paths through network to build impedance to each bus
- Handles motor fault contribution per IEC 60909
- Calculates Ik'' (initial), Ip (peak), Ib (breaking), Ith (thermal) currents
- Impedances are referred through each transformer's **rated** ratio, not the drawn bus-voltage ratio: every walker carries the cumulative rated ratio `rho` and scales elements by `_zone_scale` (exactly 1 when nameplates match their buses); nodal branches carry an off-nominal ratio `k` (`_branch_ratio`). An 11/0.42 kV unit on a 0.4 kV bus therefore adds (0.42/0.4)² to its own and the upstream impedance. Load flow re-bases the same way (`loadflow._get_impedance(v_lv_kv=)`, `chain_element_zones`)
- Supports 3-phase, single-line-to-ground, line-to-line, double-line-to-ground
- Parallel overhead circuits (`line_coupling.py`): `num_parallel` gets Z0_eff = [Z0s + (n−1)·Z0m]/n with a Carson Z0m (circuit GMD, soil ρ). Overhead feeders **drawn** between the same two buses (through closed switchgear) are coupled the same way, via exact uncoupled equivalents held in a per-call context (`set_drawn_coupling`, never written to the project); `z0_coupling: none` opts out. Review: `reviews/LINE_COUPLING_REVIEW.md`
- Line resistance per IEC 60909-0 (`_lines_at_study_temperature`): the maximum study takes every cable and overhead line at **20 °C** (§2.4). The hot cable library value (90 °C XLPE / 70 °C PVC) is divided back out by `conductor_temp.insulated_hot_factor`, which reads the library id. The minimum study (`conductorTemperatureC`: a number, or `"final"` = each line at its end-of-fault θe: PVC 160 °C, XLPE 250 °C, bare overhead 200 °C) applies eq. (3) to R20. Other engines keep operating temperatures. Review: `reviews/CONDUCTOR_TEMP_REVIEW.md`
- Converters are not links (`_converter_action`): rectifier/charger block; a diode-front-end VFD blocks motor back-feed, an AFE VFD contributes as an IEC §13.2.1 motor (I_LR/I_rM = 3); a fault on a VFD or UPS output is fed at `fault_contribution_pu` × I_r (not scaled by c); a UPS passes the upstream level unless it is `online_double` with `static_bypass: no`. Bus-less cable tees get a junction node (`insert_junction_buses`, shared with load flow) before any fault walk. Review history: `reviews/FAULT_ENGINE_REVIEW.md` (F1–F9)
- Steady-state Ik follows IEC 60909-0:2001 §4.6: `ik_steady` = Ik_max, `ik_steady_min` = Ik_min. Synchronous machines give λ·I_rG — λ_max from IEC TR 60909-1 Eq. 88, λ_min from the figs. 18/19 curve (fit in `_lambda_min`). Network feeders and converters give Ik = I″k; induction motors give 0. Meshed buses use Eqs. 84/85. Ik_min uses c_min with motors neglected (§2.5). Generator props: `rotor_type`, `scr` (x_dsat = 1/SCR, else Xd), `excitation_series`, `excitation_type` (rotating / static_terminal / compound), `ikp_pu`
- LV earthing systems (IEC 60364-1): each LV source (≤1 kV) carries an `earthing_system` prop (TN-S/TN-C/TN-C-S/TT/IT). TT adds the soil earth-return `3·(R_A+R_B)` to the zero-sequence loop (Ik1 collapses); IT blocks the first-fault path (Ik1 ≈ 0); TN-* use the metallic return. Absent field ⇒ TN-S (legacy-identical). Compliance branches the SANS 10142-1 disconnection rules on it (RCD for TT, insulation monitoring for IT, no RCD on a PEN for TN-C).
- Transformer zero-sequence (`_transformer_zero_seq`): the **grounding setting is authoritative**, not the vector-group letters. The vector group only classifies each winding as delta/zigzag (an internal I₀ circulation path — a Z0 source regardless of earthing) vs star; a star winding passes/carries I₀ only if its `grounding_hv`/`grounding_lv` prop is earthed. When a grounding prop is absent (legacy projects) it falls back to the vector-group `n` letter, so old studies are byte-identical. A **single-earthed star-star** (one neutral earthed, the other floating, no delta) is NOT a through-element — the earthed neutral sources earth-fault current only through the core zero-sequence magnetising branch Z₀ₘ (`_zero_seq_magnetizing`), set by the `core_construction` prop: **three_limb** ⇒ finite Z₀ₘ (default 0.6 pu on unit base, tank phantom-delta) so Ik1 is limited-but-real; **five_limb/shell/single_phase_bank** ⇒ Z₀ₘ ≈ open ⇒ Ik1 ≈ 0. A `z0m_pu` prop (e.g. datasheet open-circuit zero-seq impedance) overrides the core-type default.

### Load Flow (loadflow.py)
- Bus types: PQ (load), PV (generator), Swing (reference)
- Newton-Raphson: builds Jacobian, iterates until convergence
- Gauss-Seidel: simpler iteration, slower convergence
- Transparent elements (CBs, switches, fuses) are collapsed — connected buses grouped
- **Changeover switches** (`changeover`, 3 ports, `state` = `in_1` / `off` / `in_2`, `co_type` manual I–0–II / manual I–II / ATS / interlocked breaker pair) never reach an engine: every `/api/analysis/*` route (route class in `routes/analysis.py`, incl. Load Flow Study Manager case snapshots) and the CSV export call `expand_changeovers`, which rewrites each into its own id as a switch (a CB for a breaker pair) wired selected-input → out, plus an open stub `<id>__in_k` on the other input. A breaker pair's legs take their own trip-unit settings from the changeover's `cb1_*` / `cb2_*` props (the TCC plots both, as `<id>__in_1` / `__in_2`). Engines build component-level adjacency and only know 2-terminal switching devices, so do not add `changeover` to engine code — extend the rewrite. Frontend walkers use `Components.topologyWires()` (drops wires on the unselected input) and `Components.isOpenSwitching()` for the same semantics
- `insert_implicit_load_buses(project)` is an idempotent pre-pass run by every AC engine: any **load or source** wired to the network only through a series cable/transformer, with no busbar at its own terminal, gets a synthetic `__term__` bus so the feeding element becomes a real two-bus branch. Without it the element reaches only one bus and the chain builder drops it — no Y-bus stamp, no voltage drop, no branch flow, no loading check — silently modelling the load/source as if it sat on the far bus. A **source behind an open CB** is deliberately excluded (`_reaches_series_element`): it reaches no bus because it is switched out, and giving it a terminal node would promote it to its own live island instead of leaving it offline. Synthetic buses are stripped from load-flow output (`is_synthetic_bus`) — the source's own row and dispatch entry re-anchor to the point of supply so nothing collapses to a self-loop — but are **kept** in fault results, where the terminal fault level is the useful output
- Outputs: bus voltages/angles, branch MW/MVAR flows, losses
- The utility source defaults to an **ideal infinite/swing bus** (held at `v_setpoint_pu`, default 1.0 p.u.) — its `fault_mva` is *not* modelled, so loadability/voltage-collapse behaviour is set by the network impedance alone. Setting the utility prop `lf_grid_model: "thevenin"` instead re-hangs it behind its Thevenin source impedance Z = U²/S″k (R+jX from `x_r_ratio`, no IEC 60909 c factor) via an internal EMF bus that becomes the swing (`_insert_grid_source_impedance`) — the point of supply then sags with load, and voltage stability / contingency / motor-starting baselines inherit the finite grid strength. The synthetic EMF bus + impedance element are collapsed out of user-facing results
- `connected_bus_loads_mw(project)` — public helper returning per-bus local real load (MW) using the engine's own bus/load walkers; reused by voltage stability and contingency so their demand accounting matches the solver
- A series chain of cables/transformers between two real buses with no intervening bus is collapsed into one branch. A chain with ONE OR MORE tapped transformers plus any number of cables (before/after/between, any order) is modelled EXACTLY via `_reduce_chain_two_port` — a nameplate-driven walk that hands each transformer its own LOCAL off-nominal ratio and each cable its own zone voltage (a zone bounded by a real bus uses that bus's `voltage_kv`; a zone between two internal chain nodes takes the nearer transformer terminal's nameplate voltage — exactly what a user would type into an explicit intermediate bus) to `_kron_reduce_two_port`, a pure Kron reduction of the chain's own internal nodes — so a cable's impedance is never mis-referred through any tap ratio in the chain, however many transformers it cascades. The only remaining caveat for a 2+ transformer chain is informational, not numerical: there is no bus at the internal junction between cascaded transformers, so no load/generation/protection device can be attached there — draw one if you need to model equipment at that point.

### Voltage Stability (voltage_stability.py)
- Steady-state (long-term) voltage stability — distinct from the time-domain transient-stability engine
- **P-V (loadability)**: load-scaling continuation — all loads scaled by λ (constant power factor, via `demand_factor`), `run_load_flow` re-solved each step; the nose (max λ the solution exists for) is found by stepping λ up then **bisecting** the last-converged/first-failed bracket. Loadability margin = (λ_critical − 1) × 100 %; a stiff network that doesn't collapse within the λ cap reports the margin as a lower bound. Collapse = NR divergence, weakest bus below a floor, or an energized bus going dark
- **Q-V (reactive margin)**: installs a fictitious synchronous condenser (P = 0, voltage-regulating) at the weakest/chosen bus, makes it a PV bus, sweeps its voltage setpoint high→low and records the reactive injection needed; the bottom of the curve (dQ/dV = 0) is the reactive margin. Skipped for source-controlled buses
- Outputs: λ_critical, loadability margin %, per-bus P-V curves, min-V envelope, critical bus & nose voltage, Q-V curve + margin. Results are on-demand (not persisted)

### Contingency Analysis (contingency.py)
- N-1 (single outage) and optional N-2 (pairs) security screening; each contingency removes the element(s) and re-solves `run_load_flow` (never raises — mirrors the Load Flow Study Manager snapshot approach)
- Outageable set: series branches (cables/transformers) + sources (utility/generator/solar/wind/battery); transparent devices and passive loads are not outaged
- Flags per outage: thermal overloads (loading > limit), bus under/over-voltage (band configurable), and loss of supply (de-energized buses + MW lost, via `connected_bus_loads_mw`)
- N-2 pairs are capped (default 400) with skipped pairs reported; results ranked worst-first (loss-of-supply > violations > secure). A network is **N-1 secure** when every single outage is violation-free. Results are on-demand (not persisted)

### Time-Series / Quasi-Dynamic Load Flow (timeseries_loadflow.py)
- Re-runs the existing balanced `run_load_flow` once per time step over a 24 h / 8760 h load & generation profile — a thin composition layer, no new power-flow mathematics
- Every profile-eligible load/source (`static_load`, `motor_induction`, `motor_synchronous`, `distribution_board`, `solar_pv`, `wind_turbine`, `generator`) is assigned a named profile — a 24-point hourly shape, linearly interpolated for sub-hourly steps and tiled across the horizon — via the request's `profile_overrides` (component id → name), else the component's own `ts_profile` prop, else the request's `default_profile`, else a per-type built-in (residential/industrial for loads, clear-sky for solar, flat elsewhere). The profile multiplies the component's OWN nameplate value captured at t=0 (`demand_factor` for loads, `irradiance_pct` for solar, `wind_speed_pct` for wind, `rated_mva` for a scheduled generator) — a "flat" profile therefore reproduces the single-shot `run_load_flow` result exactly at every step
- **Quasi-dynamic, not N independent snapshots**: BESS state of charge is integrated each step from the actual dispatched power (`LoadFlowResults.dispatch`, one-way efficiency √(round-trip η)) and carried into the next step's `battery_soc_pct` — a battery at 0%/100% clamps there (warned) rather than crossing the bound. `_battery_params` only gates dispatch on the SoC at the START of a step (power-level check, no notion of step duration), so a coarse step can still dispatch full power for the whole step even if that exceeds the energy actually stored — the clamp is a post-hoc fix, not a re-solve, so the boundary step's reported dispatch/voltages aren't strictly energy-consistent. **Use a finer step size (15-60 min, not 1 h+) for any run where a battery is expected to fully deplete or fill mid-horizon.** OLTC tap position is carried forward via `loadflow._run_oltc` so each step's regulation starts from the PREVIOUS step's converged tap, not the network's static default; switched capacitor banks opting into `cap_control_mode: "auto"` get a simple voltage-hysteresis controller (on/off band) on their local bus, read from the previous step's solved voltage
- Outputs: per-bus min/max voltage envelope (with the step each occurred), per-branch peak loading, integrated energy losses (MWh) over the horizon, count of steps with a voltage/thermal violation, and BESS SoC/dispatch trajectories. Never raises — a step whose solver diverges is recorded in `non_converged_steps` and the run continues. Results are on-demand (not persisted)
- Performance: cost scales with step count × per-solve cost (network size). Measured: a 2-bus feeder is ~4.5s for 8760 steps, the same feeder with an OLTC-regulating transformer ~9s, a 20-bus radial feeder ~60s — comfortably under the "10 minutes" concern threshold at the network sizes this tool targets. A genuine NR solver warm start (seeding V/θ from the previous step) is the documented next mitigation if a much larger network needs it — deliberately not added to the shared `loadflow.py` core for a problem that doesn't exist at measured sizes

### Dynamic Motor Starting (dynamic_motor_starting.py)
- Time-domain acceleration: integrates 2H·dω/dt = T_e − T_L (RK2)
- Single-cage equivalent circuit + magnetizing branch, linear deep-bar R₂(s),
  fitted to nameplate LRC / LRT / rated point (IEEE 3002.7 methodology)
- Network as Thevenin superposition (Z_th from the fault-path walker at c=1.0 with nameplate impedances — `thevenin_z1_at_bus(..., nameplate=True)` drops the IEC 60909 K_T/K_G short-circuit corrections; static motor starting and flicker use the same,
  motor infeeds excluded; V_pre from a baseline load flow with the motor off)
- Starters: DOL, star-delta, autotransformer, soft starter (current-limited); VFD not simulated
- Reports accel time, stall, peak current, voltage dip trajectory, rotor I²t thermal use

### Arc Flash (arcflash.py)
- **Both editions are implemented**, selected per bus by the `arc_flash_method` prop. Absent ⇒ `IEEE 1584-2002`, so projects saved before the 2018 method was added stay byte-identical; **new buses default to `IEEE 1584-2018`** (`frontend/js/constants.js`), the current edition.
- **IEEE 1584-2002** (functions without a `_2018` suffix): arcing current (Eq. 1-2), incident energy (Eq. 3-6), arc flash boundary in closed form (Eq. 7). Its electrode model distinguishes open-air from enclosed only (the K1 factor) — no enclosure-size correction.
- **IEEE 1584-2018** (`_2018`-suffixed): the three-current-anchor regression model — arcing current and incident energy computed at 600 V / 2700 V / 14,300 V via per-electrode-configuration (VCB/VCBB/HCB/VOA/HOA) coefficient tables, then blended by voltage range, plus an enclosure-size correction factor (box configs only) and a closed-form arc-flash-boundary inverse. Coefficients were transcribed from the official IEEE 1584-2018 validation spreadsheet via the MIT-licensed reference implementation `github.com/jgrimard/arc-flash-calculator`; the variation factor is the standard's Table 2 (`_VARCF_2018`, Iarc_min = Iarc·(1 − 0.5·VarCf)). The arc flash review (2026-10-02) ran the engine against **all 144,000 rows** of that spreadsheet (≤ 2.4e-6, every enclosure branch); nine typical-enclosure rows are pinned in `test_arcflash_review_fixes.py`, six shallow-box rows in `test_regression.py::TestArcFlash2018`.
- Clearing time: each upstream device is timed at **its own share** of the arcing current, I_arc × I_bf,device / I_bf from the fault study's branch contributions (`device_current_shares`, review AF1); the slowest infeed governs. Fuses never clear faster than 0.01 s (AF3); the 2002 boundary is Eq. 7 in closed form (AF2). Labels follow NFPA 70E §130.5(H): energy at the working distance + minimum arc rating, no PPE category (AF6). Review: `reviews/ARCFLASH_REVIEW.md`
- Determines PPE category (1-4) and arc flash boundary
- Gap selection based on equipment type and voltage class
- Relay/CB clearing-time evaluation (`get_clearing_time`) shares `analysis/ct_model.py` with the frontend TCC: when a relay has an `associated_ct`, the arcing current is run through the symmetrical CT saturation model (square-loop core, saturation EMF = IEC 61869-2 accuracy-limit EMF from the class, or the entered knee; `connected_burden_va` gives the effective ALF′; the relay sees the clipped waveform's FUNDAMENTAL) — the same curve the TCC plots. The dc offset is then added in the time domain: `ct_fundamental_series` simulates the square-loop CT under a fully offset fault (X/R from the bus κ, zero remanence) and the extra relay operate time vs the symmetrical fault is added (review C3; κ no longer derates the knee). `duty_check.py` judges CT adequacy on the symmetrical class criterion (ALF′·I_pn vs the prospective Ik3, Ik1 for core-balance CTs) and reports the IEC 61869-2 / IEEE C37.110 time to saturation ("CT Saturation Adequacy" table, protection-relay-connected CTs only). Review: `reviews/CT_MODEL_REVIEW.md`

## Keyboard Shortcuts

| Key | Action |
|---|---|
| V | Select mode |
| W | Wire mode |
| Delete | Delete selected |
| Ctrl+K | Search every command, analysis, export and setting |
| Ctrl+S | Save project |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+C/V/X | Copy/Paste/Cut |
| Ctrl+A | Select all |
| Ctrl+D | Duplicate |
| R | Rotate selected 90° |
| Escape | Cancel / deselect |

## Running Locally

```bash
# Quick start
./run.sh

# Manual
pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

# Docker
docker-compose up --build
```

Access at `http://localhost:8000`

## Authentication

JWT bearer auth (`backend/auth.py`, `routes/auth.py`, frontend `auth.js` login gate; `setup.js` wizard on a server with no users). Invites (`/auth/invites`, optionally emailed, expiry in days) and password reset (`/auth/forgot` → emailed 1-hour single-use link, `/auth/reset`; admin `/auth/users/{id}/reset-link` for servers without email) work with or without a mail server — links are `/#invite=<code>` and `/#reset=<token>`. Every `/api/*` route except `/api/auth/*` and `/api/health` needs `Authorization: Bearer <token>`. The first registered user is the admin; further users register with an admin-minted invite code. Projects are owned per user and can be shared (`/api/projects/{id}/shares`, view/edit). CORS allows all origins.

## Testing

Backend tests live in `backend/tests/` (35 modules, ~920 tests; CI runs all of them). The core is `test_regression.py` — standards-anchored hand calculations (IEC 60909, IEEE 1584-2002 and 1584-2018, IEEE 80, …) that pin the analysis engines; the other modules cover specific engines, review-finding fixes, auth, projects and libraries. `test_verification_templates.py` re-runs every in-app verification template (built from `testing/case-*/project.json`) and asserts its expected numbers, which live in `EXPECTED` in `testing/build_verification_templates.py` — change them there and regenerate `frontend/js/verification-templates.js` with `python testing/build_verification_templates.py`, never by hand. Which analyses have an independent reference and which only consistency tests: `testing/README.md` → Coverage. Run the suite inside the backend Docker image:

```bash
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  sh -c "pip install pytest httpx -q && python -m pytest backend/tests/ -q"
```

Run these after any change to `backend/analysis/`. Frontend testing is mostly manual via the browser UI; `node --check frontend/js/*.js` catches syntax errors. The one automated UI check is `testing/ui/verify_templates_ui.mjs` (CI job `ui-templates`): it loads every verification template through Project → Templates in headless Chromium, runs its study from the Analyse menu and asserts the expected numbers — run it against a full stack on a throwaway DB (see its header). The `verify` skill (`.claude/skills/verify/SKILL.md`) is the playbook for driving the app headlessly. CI also runs `testing/case-new-features-verification/verify_new_features.py --no-results` (21 closed-form checks of the newer engines; exits 1 on any FAIL).

## Key Conventions

- Frontend uses vanilla JS modules with ES6 imports — no build step
- All analysis requests send the full ProjectData JSON to the backend
- Each study's results are stored on their own AppState field (`faultResults`, `loadFlowResults`, …) and rendered as SVG annotations
- Component IDs are strings from `AppState.genId(type)`: type + `_` + the `nextId` counter (e.g. `bus_1`, `transformer_2`)
- The undo system takes full state snapshots (not diffs)
- Dark mode preference persists via `localStorage` key `'protectionpro-dark-mode'`

## Where to Find Things

- **Adding a new component type**: `constants.js` (definition) → `symbols.js` (SVG) → `properties.js` (editor) → `sidebar.js` (palette category)
- **Adding a new analysis**: `backend/analysis/` (engine) → `backend/routes/analysis.py` (endpoint) → `backend/models/schemas.py` (Pydantic model) → `frontend/js/api.js` (client) → `frontend/js/app.js` (toolbar button)
- **Modifying export formats**: `frontend/js/project.js` (JSON/SVG/PNG) or `backend/analysis/pdf_reports.py` (PDF) or `backend/routes/reports.py` (CSV)
- **Changing diagram rendering**: `frontend/js/canvas.js` (layout/interaction) or `frontend/js/symbols.js` (component visuals)
- **Editing TCC curves**: `frontend/js/tcc.js`
- **Standards/compliance checks**: `frontend/js/compliance.js`
