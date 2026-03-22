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
    ├── reports.js          # Client-side PDF via jsPDF + autoTable
    ├── compliance.js       # Standards compliance verification
    ├── minimap.js          # Scaled diagram overview widget
    └── undo.js             # Snapshot-based undo/redo (50 states max)

backend/
├── main.py                 # FastAPI app, CORS, static file serving, DB init
├── models/
│   ├── database.py         # SQLAlchemy Project model, SQLite setup
│   └── schemas.py          # Pydantic request/response models
├── analysis/
│   ├── fault.py            # IEC 60909 short-circuit (3-phase, SLG, LL, LLG)
│   ├── loadflow.py         # Newton-Raphson & Gauss-Seidel solvers
│   ├── arcflash.py         # IEEE 1584-2018 arc flash incident energy
│   ├── cable_sizing.py     # IEC 60364 thermal, voltage drop, fault withstand
│   ├── motor_starting.py   # Locked-rotor current, voltage dip analysis
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
  mode: 'SELECT',          // SELECT | WIRE | PLACE
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
| `/api/analysis/arcflash` | Arc flash | IEEE 1584-2018 |
| `/api/analysis/cable-sizing` | Cable sizing | IEC 60364 |
| `/api/analysis/motor-starting` | Voltage dip | Motor starting analysis |
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

### Load Flow (loadflow.py)
- Bus types: PQ (load), PV (generator), Swing (reference)
- Newton-Raphson: builds Jacobian, iterates until convergence
- Gauss-Seidel: simpler iteration, slower convergence
- Transparent elements (CBs, switches, fuses) are collapsed — connected buses grouped
- Outputs: bus voltages/angles, branch MW/MVAR flows, losses

### Arc Flash (arcflash.py)
- IEEE 1584-2018 method
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

No automated tests exist yet. Testing is done manually via the browser UI.

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
