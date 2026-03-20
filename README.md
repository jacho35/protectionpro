# ProtectionPro

**Single Line Diagram (SLD) Builder with IEC 60909 Fault Analysis & Load Flow**

A browser-based power systems engineering tool for designing single-line diagrams, running short-circuit fault analysis per IEC 60909, and performing Newton-Raphson / Gauss-Seidel load flow studies — all from your browser.

---

## Quick Start

```bash
./run.sh
```

Then open **http://localhost:8000** in your browser.

### Docker

```bash
docker-compose up --build
```

---

## Features

### Visual SLD Builder
- Drag-and-drop **18 component types** from a searchable sidebar palette
- SVG canvas with pan (middle-click / Alt+drag), zoom (scroll wheel, 10%–500%), and snap-to-grid
- Orthogonal wire routing with port-snap connection drawing
- Marquee and shift-click multi-selection
- Copy, paste, cut, duplicate with automatic rename
- Component rotation (0°/90°/180°/270°)

### Component Library

| Category | Components |
|----------|-----------|
| **Sources** | Utility (grid), Generator |
| **Distribution** | Bus, Transformer, Cable/Feeder |
| **Protection** | Circuit Breaker, Fuse, Relay (50/51, 50N/51N, 87, 21), Switch |
| **Instruments** | Current Transformer (CT), Potential Transformer (PT) |
| **Loads** | Induction Motor, Synchronous Motor, Static Load |
| **Other** | Capacitor Bank, Surge Arrester |

Each component has configurable electrical parameters, built-in per-unit calculation with step-by-step view, and IEC-standard SVG symbols.

### IEC 60909 Fault Analysis
- **Three-phase** (I"k3), **single line-to-ground** (I"k1), and **line-to-line** (I"kLL) fault currents
- Per-unit impedance method on common MVA base
- Generator sub-transient reactance modelling
- IEC voltage factor c (1.05 LV, 1.1 MV/HV)
- Results displayed as draggable annotation badges on the diagram

### Load Flow Analysis
- **Newton-Raphson** (default) and **Gauss-Seidel** solvers
- Bus types: PQ (load), PV (generator), Swing (slack)
- Transparent element modelling — closed CBs, switches, fuses, CTs, PTs pass through
- Bus voltage, angle, P, Q results with branch flow, current, and loading %
- **Overload warnings** — pulsing red flags on equipment exceeding rated capacity
- **Voltage violation alerts** — flags on buses outside 0.95–1.05 p.u. range

### On-Diagram Annotations
- Fault current badges (orange) and load flow badges (green) rendered on the SLD
- Component data labels showing cable sizes, transformer ratings, load parameters
- All annotations are draggable for clean diagram layout
- Toggle labels and warnings from the toolbar

### Standards Libraries
- **Cable library**: 70+ cables (Cu/Al, XLPE/PVC, 0.4–33 kV) per IEC 60502 / SANS 1339
- **Transformer library**: 22 standard types (100 kVA–80 MVA, 0.42–132 kV)
- Fully editable — add, modify, delete, or reset to defaults

### Export & Reports
- **JSON** — Full project data (re-importable)
- **SVG** — Clean vector diagram with all annotations
- **PNG** — 2x resolution raster image
- **CSV** — Fault and load flow results as spreadsheet
- **PDF** — Multi-page report with diagram, analysis tables, and equipment summary

### Project Management
- Save / Open / Save As with SQLite database persistence
- JSON file import/export for portability
- Unsaved changes detection

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JS, SVG, HTML5, CSS3 |
| **Backend** | Python 3, FastAPI, SQLAlchemy, SQLite |
| **Analysis** | NumPy / SciPy (numerical solvers) |
| **PDF (server)** | ReportLab |
| **PDF (client)** | jsPDF + autoTable |

No build step, no bundler, no framework — pure vanilla JS for maximum simplicity and portability.

---

## Project Structure

```
protectionpro/
├── frontend/
│   ├── index.html              # Main application page
│   ├── css/
│   │   ├── app.css             # Global styles & CSS variables
│   │   ├── toolbar.css         # Toolbar & export dropdown
│   │   ├── sidebar.css         # Component palette sidebar
│   │   ├── properties.css      # Properties panel
│   │   └── symbols.css         # SVG component symbol styling
│   └── js/
│       ├── app.js              # Application entry point & keyboard shortcuts
│       ├── constants.js        # Component definitions & standards data
│       ├── state.js            # Application state & clipboard
│       ├── canvas.js           # SVG canvas rendering, pan/zoom
│       ├── sidebar.js          # Component palette & drag-drop
│       ├── symbols.js          # IEC SVG symbol generators
│       ├── wiring.js           # Wire/connection drawing
│       ├── components.js       # Validation & network graph
│       ├── properties.js       # Property panel rendering
│       ├── annotations.js      # Result badges & data labels
│       ├── project.js          # Save/load/export (JSON, SVG, PNG, CSV, PDF)
│       ├── api.js              # Backend API calls
│       └── standard-data.js    # Settings modal & library editor
├── backend/
│   ├── main.py                 # FastAPI application
│   ├── analysis/
│   │   ├── fault.py            # IEC 60909 fault analysis engine
│   │   └── loadflow.py         # Newton-Raphson & Gauss-Seidel solver
│   ├── models/
│   │   ├── database.py         # SQLAlchemy models & DB setup
│   │   └── schemas.py          # Pydantic request/response schemas
│   └── routes/
│       ├── analysis.py         # POST /analysis/fault, /analysis/loadflow
│       ├── projects.py         # CRUD /projects endpoints
│       └── reports.py          # CSV & PDF server-side export
├── docs/
│   └── HELP.md                 # Full user guide & feature reference
├── HELP.md                     # User guide (also in docs/)
├── BACKLOG.md                  # Feature backlog
├── run.sh                      # Start script
├── docker-compose.yml          # Docker orchestration
└── Dockerfile                  # Container build
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **V** | Select mode |
| **W** | Wire mode |
| **Delete / Backspace** | Delete selection |
| **Escape** | Cancel wire / clear selection |
| **Ctrl+S** | Save project |
| **Ctrl+A** | Select all |
| **Ctrl+C** | Copy |
| **Ctrl+V** | Paste |
| **Ctrl+X** | Cut |
| **Ctrl+D** | Duplicate |
| **Middle mouse / Alt+drag** | Pan canvas |
| **Mouse wheel** | Zoom in/out |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/analysis/fault` | Run IEC 60909 fault analysis |
| POST | `/analysis/loadflow` | Run load flow analysis |
| GET | `/projects` | List all projects |
| POST | `/projects` | Create new project |
| GET | `/projects/{id}` | Get project data |
| PUT | `/projects/{id}` | Update project |
| DELETE | `/projects/{id}` | Delete project |
| GET | `/projects/{id}/export/json` | Export as JSON |
| GET | `/projects/{id}/export/csv` | Export as CSV |
| GET | `/projects/{id}/export/pdf` | Export as PDF |

---

## Documentation

See **[docs/HELP.md](docs/HELP.md)** for the full user guide, including:
- Getting started walkthrough
- Detailed feature documentation
- Complete component reference with parameter tables
- Analysis methodology explanations
- Roadmap of planned future features

---

## License

All rights reserved.
