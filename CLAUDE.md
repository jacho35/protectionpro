# CLAUDE.md — ProtectionPro Reference Guide

## Development Workflow Instructions

**After building any feature**, always update `BACKLOG.md`:
1. Mark the completed item as done in its original section (strikethrough with `~~text~~`)
2. Add a concise entry to the `## Completed` section at the bottom

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
    ├── canvas.js           # SVG rendering, pan/zoom, grid, 5-layer system
    ├── sidebar.js          # Searchable component palette, drag-drop
    ├── wiring.js           # Orthogonal wire routing, port snapping
    ├── components.js       # Network graph validation, adjacency, cycle detection
    ├── symbols.js          # IEC-standard SVG symbol generators (18 types)
    ├── properties.js       # Dynamic property editor per component type
    ├── annotations.js      # Draggable fault/loadflow result badges
    ├── project.js          # Save/load/export (JSON/SVG/PNG/CSV/PDF)
    ├── api.js              # HTTP client for backend endpoints
    ├── constants.js        # Component definitions, cable/transformer libraries
    ├── standard-data.js    # Settings modal, editable cable & transformer libraries
    ├── templates.js        # Pre-built network templates (radial, ring, mesh)
    ├── tcc.js              # Time-current curve coordination plotting
    ├── dynmotor.js         # Dynamic motor starting modal + SVG time-series charts
    ├── lfstudy.js          # Load Flow Study Manager (named full-snapshot cases, attribute grid, comparison)
    ├── voltage-stability.js # Voltage stability UI (P-V / Q-V setup + charts)
    ├── freqscan.js         # Frequency scan UI (Z vs f setup + log-decade chart)
    ├── battsizing.js       # Battery sizing & discharge UI (duty editor + SoC/V charts)
    ├── opf.js              # Optimal power flow UI (objective/controls setup + comparison tables)
    ├── reliability.js      # Reliability UI (IEEE 1366 indices chips + load-point/FMEA tables)
    ├── filtersizing.js     # Passive filter sizing UI (setup + design/THD tables)
    ├── capplace.js         # Optimal capacitor placement UI (budgets setup + placement tables)
    ├── flicker.js          # Voltage flicker UI (IEC 61000-3-3 setup + Pst/Plt per-motor table)
    ├── contingency.js      # Contingency analysis UI (N-1 / N-2 setup + ranked violations table)
    ├── reports.js          # Client-side PDF via jsPDF + autoTable
    ├── compliance.js       # Standards compliance verification
    ├── minimap.js          # Scaled diagram overview widget
    └── undo.js             # Snapshot-based undo/redo (50 states max)

clients/
└── python/                 # Python API client (protectionpro_client.py, httpx) — batch/parametric scripting; see its README

backend/
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
│   ├── frequency_scan.py   # Driving-point impedance vs frequency — parallel/series resonance identification
│   ├── battery_sizing.py   # Duty-cycle battery sizing (IEEE 485-style factors) + discharge simulation
│   ├── optimal_powerflow.py # OPF — merit-order economic dispatch + greedy discrete Volt/VAR hill climb
│   ├── reliability.py      # SAIDI/SAIFI/MAIFI (IEEE 1366) — analytical FMEA over connectivity outages
│   ├── filter_sizing.py    # Passive harmonic filter sizing — single-tuned branches to IEEE 519
│   ├── capacitor_placement.py # Optimal capacitor placement — greedy loss-sensitivity over LF solves
│   ├── flicker.py          # Voltage flicker (IEC 61000-3-3/-4-15) — planning-level Pst/Plt screening for repetitive motor starts
│   ├── arcflash.py         # IEEE 1584-2002 arc flash incident energy
│   ├── cable_sizing.py     # IEC 60364 thermal, voltage drop, fault withstand
│   ├── motor_starting.py   # Locked-rotor current, voltage dip analysis
│   ├── dynamic_motor_starting.py # Time-domain motor acceleration (swing equation)
│   ├── duty_check.py       # Equipment fault current rating validation
│   ├── load_diversity.py   # Load demand factor analysis
│   ├── grounding_system.py # IEEE 80 grounding grid design
│   ├── study_manager.py    # Batch analysis orchestration
│   └── pdf_reports.py      # ReportLab PDF generation
└── routes/
    ├── analysis.py         # POST /api/analysis/* endpoints
    ├── projects.py         # CRUD /api/projects endpoints
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
  mode: 'select',          // MODE.SELECT | MODE.WIRE | MODE.PLACE (lowercase values)
  analysisResults: {},      // Latest fault/loadflow/arcflash results
  projectName: string,
  baseMVA: 100,
  frequency: 50,
  scenarios: [],            // Named network configuration snapshots
  nextId: int               // Auto-incrementing component ID counter
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
| `/api/analysis/frequency-scan` | Impedance vs frequency (resonance) | Nodal Z_kk(h) sweep on the harmonics network model |
| `/api/analysis/battery-sizing` | Duty-cycle battery sizing + discharge sim | IEEE 485-style factors, Peukert, OCV(SoC) |
| `/api/analysis/opf` | Economic dispatch + Volt/VAR optimization | Merit order by marginal cost + LF-scored hill climb |
| `/api/analysis/reliability` | SAIDI/SAIFI/MAIFI/EENS | IEEE 1366 indices, analytical FMEA (Billinton) |
| `/api/analysis/filter-sizing` | Passive harmonic filter design | Single-tuned synthesis verified vs IEEE 519 |
| `/api/analysis/capacitor-placement` | Optimal VAR placement & sizing | Greedy loss-sensitivity, LF-scored |
| `/api/analysis/flicker` | Voltage flicker (Pst/Plt) screening | IEC 61000-3-3-style curve on Thevenin d(%) — planning estimate, not a flickermeter |
| `/api/analysis/arcflash` | Arc flash | IEEE 1584-2002 |
| `/api/analysis/cable-sizing` | Cable sizing | IEC 60364 |
| `/api/analysis/motor-starting` | Voltage dip | Motor starting analysis |
| `/api/analysis/dynamic-motor-starting` | Motor acceleration | Time-domain swing-equation simulation |
| `/api/analysis/duty-check` | Equipment duty | Fault current ratings |
| `/api/analysis/load-diversity` | Demand factors | Load diversity |
| `/api/analysis/grounding` | Grounding grid | IEEE 80 |
| `/api/analysis/study-manager` | Batch all studies | Runs selected analyses |

### Projects (CRUD)
- `GET /api/projects` — list all
- `POST /api/projects` — create
- `GET /api/projects/{id}` — get (returns ProjectData JSON)
- `PUT /api/projects/{id}` — update
- `DELETE /api/projects/{id}` — delete
- `GET /api/projects/{id}/export/json` — export JSON
- `GET /api/projects/{id}/export/csv` — export CSV

### Reports
- `POST /api/reports/pdf` — generate full PDF report
- `POST /api/reports/arcflash-labels` — generate arc flash warning labels

## Database

SQLite with one table:

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

## Component Types (18)

| Category | Components |
|---|---|
| **Sources** | Utility Source, Generator, Solar PV, Wind Turbine |
| **Distribution** | Bus, Transformer, Cable/Feeder |
| **Protection** | Circuit Breaker, Fuse, Relay, Switch |
| **Instruments** | Current Transformer (CT), Potential Transformer (PT) |
| **Loads** | Induction Motor, Synchronous Motor, Static Load |
| **Other** | Capacitor Bank, Surge Arrester, Off-page Connector |

Component definitions (default props, ports, SVG dimensions) are in `constants.js` under `COMPONENT_DEFS`.

## Built-in Libraries

- **Cable Library** (~70 entries): Copper/Aluminium, XLPE/PVC, 0.4-33kV, R/X per km, ampacity (per IEC 60502/SANS 1339)
- **Transformer Library** (22 entries): 100kVA-80MVA, vector groups, impedance values

Both are editable via the Settings modal and can be reset to defaults.

## Analysis Engine Details

### Fault Analysis (fault.py)
- Per-unit impedance method with configurable base MVA
- Traces source paths through network to build impedance to each bus
- Handles motor fault contribution per IEC 60909
- Calculates Ik'' (initial), Ip (peak), Ib (breaking), Ith (thermal) currents
- Supports 3-phase, single-line-to-ground, line-to-line, double-line-to-ground
- LV earthing systems (IEC 60364-1): each LV source (≤1 kV) carries an `earthing_system` prop (TN-S/TN-C/TN-C-S/TT/IT). TT adds the soil earth-return `3·(R_A+R_B)` to the zero-sequence loop (Ik1 collapses); IT blocks the first-fault path (Ik1 ≈ 0); TN-* use the metallic return. Absent field ⇒ TN-S (legacy-identical). Compliance branches the SANS 10142-1 disconnection rules on it (RCD for TT, insulation monitoring for IT, no RCD on a PEN for TN-C).
- Transformer zero-sequence (`_transformer_zero_seq`): the **grounding setting is authoritative**, not the vector-group letters. The vector group only classifies each winding as delta/zigzag (an internal I₀ circulation path — a Z0 source regardless of earthing) vs star; a star winding passes/carries I₀ only if its `grounding_hv`/`grounding_lv` prop is earthed. When a grounding prop is absent (legacy projects) it falls back to the vector-group `n` letter, so old studies are byte-identical. A **single-earthed star-star** (one neutral earthed, the other floating, no delta) is NOT a through-element — the earthed neutral sources earth-fault current only through the core zero-sequence magnetising branch Z₀ₘ (`_zero_seq_magnetizing`), set by the `core_construction` prop: **three_limb** ⇒ finite Z₀ₘ (default 0.6 pu on unit base, tank phantom-delta) so Ik1 is limited-but-real; **five_limb/shell/single_phase_bank** ⇒ Z₀ₘ ≈ open ⇒ Ik1 ≈ 0. A `z0m_pu` prop (e.g. datasheet open-circuit zero-seq impedance) overrides the core-type default.

### Load Flow (loadflow.py)
- Bus types: PQ (load), PV (generator), Swing (reference)
- Newton-Raphson: builds Jacobian, iterates until convergence
- Gauss-Seidel: simpler iteration, slower convergence
- Transparent elements (CBs, switches, fuses) are collapsed — connected buses grouped
- Outputs: bus voltages/angles, branch MW/MVAR flows, losses
- The utility source defaults to an **ideal infinite/swing bus** (held at `v_setpoint_pu`, default 1.0 p.u.) — its `fault_mva` is *not* modelled, so loadability/voltage-collapse behaviour is set by the network impedance alone. Setting the utility prop `lf_grid_model: "thevenin"` instead re-hangs it behind its Thevenin source impedance Z = U²/S″k (R+jX from `x_r_ratio`, no IEC 60909 c factor) via an internal EMF bus that becomes the swing (`_insert_grid_source_impedance`) — the point of supply then sags with load, and voltage stability / contingency / motor-starting baselines inherit the finite grid strength. The synthetic EMF bus + impedance element are collapsed out of user-facing results
- `connected_bus_loads_mw(project)` — public helper returning per-bus local real load (MW) using the engine's own bus/load walkers; reused by voltage stability and contingency so their demand accounting matches the solver

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

### Dynamic Motor Starting (dynamic_motor_starting.py)
- Time-domain acceleration: integrates 2H·dω/dt = T_e − T_L (RK2)
- Single-cage equivalent circuit + magnetizing branch, linear deep-bar R₂(s),
  fitted to nameplate LRC / LRT / rated point (IEEE 3002.7 methodology)
- Network as Thevenin superposition (Z_th from the fault-path walker at c=1.0,
  motor infeeds excluded; V_pre from a baseline load flow with the motor off)
- Starters: DOL, star-delta, autotransformer, soft starter (current-limited); VFD not simulated
- Reports accel time, stall, peak current, voltage dip trajectory, rotor I²t thermal use

### Arc Flash (arcflash.py)
- IEEE 1584-2002 method (the engine docstring is explicit; 2018 is not implemented)
- Calculates arcing current, incident energy at working distance
- Determines PPE category (1-4) and arc flash boundary
- Gap selection based on equipment type and voltage class

## Keyboard Shortcuts

| Key | Action |
|---|---|
| V | Select mode |
| W | Wire mode |
| Delete | Delete selected |
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

None currently implemented. CORS allows all origins. Auth is in the backlog.

## Testing

Backend regression tests live in `backend/tests/test_regression.py` — standards-anchored hand calculations (IEC 60909, IEEE 1584-2002, IEEE 80) that pin the analysis engines. Run them inside the backend Docker image:

```bash
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  sh -c "pip install pytest httpx -q && python -m pytest backend/tests/ -q"
```

Run these after any change to `backend/analysis/`. Frontend testing is still manual via the browser UI; `node --check frontend/js/*.js` catches syntax errors.

## Key Conventions

- Frontend uses vanilla JS modules with ES6 imports — no build step
- All analysis requests send the full ProjectData JSON to the backend
- Results are stored in `AppState.analysisResults` and rendered as SVG annotations
- Component IDs are auto-incrementing integers prefixed by type (e.g., `bus-1`, `transformer-2`)
- The undo system takes full state snapshots (not diffs)
- Dark mode preference persists via `localStorage` key `'protectionpro-dark-mode'`

## Where to Find Things

- **Adding a new component type**: `constants.js` (definition) → `symbols.js` (SVG) → `properties.js` (editor) → `sidebar.js` (palette category)
- **Adding a new analysis**: `backend/analysis/` (engine) → `backend/routes/analysis.py` (endpoint) → `backend/models/schemas.py` (Pydantic model) → `frontend/js/api.js` (client) → `frontend/js/app.js` (toolbar button)
- **Modifying export formats**: `frontend/js/project.js` (JSON/SVG/PNG) or `backend/analysis/pdf_reports.py` (PDF) or `backend/routes/reports.py` (CSV)
- **Changing diagram rendering**: `frontend/js/canvas.js` (layout/interaction) or `frontend/js/symbols.js` (component visuals)
- **Editing TCC curves**: `frontend/js/tcc.js`
- **Standards/compliance checks**: `frontend/js/compliance.js`
