# CLAUDE.md — ProtectionPro Reference Guide

## Development Workflow Instructions

**After building any feature**, always update `BACKLOG.md`:
1. Delete its line from the `## Outstanding Items — ordered` index at the top
2. Mark the completed item as done in its original section (strikethrough with `~~text~~`)
3. Add a concise entry to the `## Completed` section at the bottom

**Every PR sets the app version to its own PR number**: `APP_VERSION = '2.<PR number>'` in `frontend/js/constants.js` (PR #578 → `2.578`, PR #579 → `2.579`). The number is only known once the PR exists, so open the PR, then push a commit that bumps `APP_VERSION` to it. Bump the `?v=` cache-bust on `constants.js` (and on any other file the PR changes) in `index.html` to the same version in the same commit.

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
frontend/index.html, css/, js/   SPA; classic-script globals, no bundler; one js file per feature
frontend/samples/                start-screen sample projects — GENERATED (testing/samples/build_samples.mjs)
backend/main.py                  FastAPI app; routes/ (analysis, projects, reports, auth, libraries, collab WS)
backend/analysis/                one engine per study (fault, loadflow, arcflash, cable_sizing, plan/retic/lighting engines …)
backend/tests/                   pytest suite (test_regression.py = standards-anchored hand calcs)
clients/python, clients/mcp      API client + MCP server
testing/                         generators, verification cases, headless UI checks
docs/                            CODEMAP.md (every file, what it owns), ENGINES.md (endpoints + engine internals)
```

**Before changing a file, read its entry in `docs/CODEMAP.md`** (`grep -n '<file>' docs/CODEMAP.md`) — it records the
module's ownership rules, invariants and node tests. **Before changing an engine or endpoint, read its section in
`docs/ENGINES.md`.** Update the entry in the same PR when behaviour changes; a new file gets a new entry.

Frontend areas by file prefix: single line `canvas/wiring/symbols/properties/components/undo`; results `resultview/resultspanel/issues/fixes`;
site plan `plan-*.js`; Demand / reticulation `retic*.js`; street & road lighting `streetlight/sl-*/roadlight/roadplan*/roadsections*`;
indoor/outdoor lighting `lightws/roomcalc/areacalc/sportslight/emergcalc/obtrusive/light*`; boards & schedules `db*.js/schedules`;
libraries `cablelib/standard-data/libraries/shared-libs/submissions`; quantities `rates/boq/quantities/cableschedules`;
collaboration & sync `collab/collab-data/sync/links/history`; drawings & export `sheetprint/drawingset/sldexport/vectorpdf/dxfwriter/plan-dxf`.

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

## API Endpoints and Analysis Engines

All analysis endpoints are `POST /api/analysis/*` and accept ProjectData JSON (a few take their own form — noted per row).
The full endpoint table (analysis, projects, user / shared libraries, reports) and each engine's internals
(fault, load flow, voltage stability, contingency, time series, dynamic motor starting, arc flash) are in `docs/ENGINES.md`.
Rules that cut across engines:
- Changeover switches never reach an engine: every route calls `expand_changeovers`; extend that rewrite, never add `changeover` to engine code.
- Every AC engine runs `insert_implicit_load_buses`; chain walkers need `tag_transformer_hv_ports` after the other pre-passes.
- Breaker pickups go through `cbElementsA` / `cbPickupRefA` (constants.js) or `backend/analysis/cb_settings.py` — never `Ir × pickup` by hand.
- Engine results must be native Python types (cast numpy scalars) or FastAPI 500s.

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

## Component Types (43 — 34 power + 9 control-circuit)

| Category | Components |
|---|---|
| **Sources** | Utility Source, Generator, Solar PV, Wind Turbine, Battery Storage |
| **Distribution** | Bus, Transformer, Autotransformer, Cable/Feeder, Bus Duct |
| **Protection** | Circuit Breaker, Fuse, Relay, Switch, Changeover Switch (3-port: in_1 / in_2 / out) |
| **Instruments & Metering** | Current Transformer (CT), Potential Transformer (PT), Energy Meter, BMS Gateway and Plant Controller (no power ports, like a relay; the controller's dashed lines to the PCC device it measures and the sources it controls are drawn by `Canvas.renderControllerLinks`) |
| **Loads** | Induction Motor, Synchronous Motor, Static Load, Distribution Board, DC Load, Variable Frequency Drive |
| **DC systems** | UPS, Rectifier, Battery Charger, DC Battery |
| **Other** | SVC / STATCOM, Capacitor Bank, Surge Arrester, Off-page Connector |
| **Control** | Control Supply, Control Breaker (MCB), Pushbutton NO / NC, Selector Switch, Contact NO / NC, Coil / Relay, Pilot Lamp |

Component definitions (default props, ports, SVG dimensions) are in `constants.js` under `COMPONENT_DEFS`.

## Built-in Libraries

- **Cable Library** (~140 entries, the only cable library in the app — `STANDARD_CABLES`, read through `CableLib`): MV/LV armoured multicore Cu/Al XLPE/PVC 0.4-33kV (MV 3-core, LV 4-core), LV 2-core single-phase service cables, building wiring (T+E, H07V-R singles, Surfix, control) and insulated earth conductors (`construction: 'earth'`, Cu 1.5–300 mm² and Al 16–300 mm², offered only as the earth conductor in Demand's earth-fault / ECC checks). Each entry has `construction` + `cores`. Demand, plans, SLD and DB schedules all pick from it; rate/termination keys come from the entry's id. Never add a second cable list
- **Transformer Library** (22 entries): 100kVA-80MVA, vector groups, impedance values

Both are editable via the Settings modal and can be reset to defaults.

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

- Frontend files are classic scripts loaded by `index.html` (each module is a global, e.g. `AppState`, `Retic`) — no build step
- **GENERATED files are never hand-edited** — change the source data and re-run the generator named in their `docs/CODEMAP.md` entry: `frontend/samples/*.json`, `vendor-trip-units*.js`, `vendor-cascading.js`, `js/lib/pdf-fonts.js`, `iec-60364-data.js` / `iec_60364_data.py`, `cascading_data.py`, `verification-templates.js`, `img/help/*.png`, `clients/mcp/component_catalog.json`
- One cable library (`STANDARD_CABLES` via `CableLib`); never add a second cable list
- All analysis requests send the full ProjectData JSON to the backend
- Each study's results are stored on their own AppState field (`faultResults`, `loadFlowResults`, …) and rendered as SVG annotations
- Component IDs are strings from `AppState.genId(type)`: type + `_` + the `nextId` counter (e.g. `bus_1`, `transformer_2`)
- The undo system takes full state snapshots (not diffs)
- Dark mode preference persists via `localStorage` key `'protectionpro-dark-mode'`

## Editing nodes and areas (one gesture set everywhere)

Every editor that has a polyline, polygon or picked region uses the same gestures. A new feature with nodes or areas must follow this table (and must not give Shift or Alt another meaning on that canvas):

| Gesture | Nodes of a line / outline | Picked areas (detect, kerbs, road reserve) |
|---|---|---|
| **Shift-click** on an edge | add a node there (then drag it) | Pick kerbs: take just that drawn piece; Detect: add to the staged set |
| **Alt-click** on a node | remove it (the two ends of a line stay; a polygon keeps at least 3 corners, a line 2) | subtract (Alt-click a street in the reserve tool drops it) |
| **Double-click** | alias: on an edge adds a node, on a node removes it | — |
| **Drag** a node | move it (snaps like the tool does) | — |
| Backspace / Enter / Esc | take the last point or pick back / finish or create / leave | same |

Where it is done: plan routes, trenches and rooms in `plan-tools.js` (select tool: `deleteVertexAt`, `_roomEdgeAt`; a midpoint drag also adds a corner to a room or trench), road crossings in `plan-tools.js` too (drag one to move it, drag an end handle of a selected one; drawn by duct size, `PLAN_DEFS.crossings.style`; a crossing of several ducts is `PlanCrossings`: ducts sharing `group` (or Auto layout's `trench`), laid side by side `sp` m apart, the first click selects all of them and a second click on the same spot one duct, the end handles of a whole one turn / stretch the bundle), Road plan alignment points in `roadplan.js` (`_insertIp`, `_deleteVertex`), the room shape and room section editors (`roomshape.js`, `roomsection.js`), picked areas in `plan-roomdetect.js`, `plan-layout-ui.js` (kerbs), `roadplan-kerbs.js`, `plan-reserve-ui.js`. Solar roofs (`plan-solar.js`, hooked into the select tool in `plan-tools.js` and the double-click in `plan-engine.js`; live without a selection: drag a corner or a midpoint, Shift-click an edge, Alt-click / double-click a corner, double-click an edge) follow the table too; roofs are made with the Detect roof tool (`plan-roomdetect.js`, target `roof`, with its Draw mode). Street sides (`plan-sides-ui.js`) is a click tool on the verges, not nodes: a click sets a side, Alt-click puts it back on Auto (the subtract meaning); Shift has no meaning there yet. Pan is the middle button, Space-drag, or a drag on empty space, never Shift or Alt. The one deliberate exception is the single-line diagram (`canvas.js`): Alt-drag pans there, so a wire bend is added and removed by double-click (or the context menu); keep it that way unless the pan changes. A new gesture needs this table and the help text updated in the same PR.

## Where to Find Things

- **Adding a new component type**: `constants.js` (definition) → `symbols.js` (SVG) → `properties.js` (editor) → `sidebar.js` (palette category)
- **Adding a new analysis**: `backend/analysis/` (engine) → `backend/routes/analysis.py` (endpoint) → `backend/models/schemas.py` (Pydantic model) → `frontend/js/api.js` (client) → `frontend/js/app.js` (toolbar button)
- **Modifying export formats**: `frontend/js/project.js` (JSON/SVG/PNG), `frontend/js/dxfwriter.js` + `backend/analysis/drawing_dxf.py` (drawing DXF) or `backend/analysis/pdf_reports.py` (PDF) or `backend/routes/reports.py` (CSV)
- **Changing diagram rendering**: `frontend/js/canvas.js` (layout/interaction) or `frontend/js/symbols.js` (component visuals)
- **Editing TCC curves**: `frontend/js/tcc.js`
- **Standards/compliance checks**: `frontend/js/compliance.js`
