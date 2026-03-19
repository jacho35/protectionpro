# ProtectionPro

Single Line Diagram (SLD) Builder with IEC 60909 fault analysis and Newton-Raphson / Gauss-Seidel load flow.

## Quick Start

```bash
./run.sh
```

Then open http://localhost:8000 in your browser.

## Features

- **Visual SLD Builder** — Drag-and-drop components onto an SVG canvas with pan/zoom
- **Component Library** — Buses, transformers, generators, utility sources, cables, circuit breakers, fuses, switches, relays, CTs, PTs, motors, static loads, capacitor banks, surge arresters
- **IEC 60909 Fault Analysis** — 3-phase, SLG, and line-to-line symmetrical short-circuit currents
- **Load Flow** — Newton-Raphson and Gauss-Seidel solvers with per-unit system
- **Per-Unit Calculations** — Automatic conversion with calculation step popups
- **On-Diagram Annotations** — Fault currents and voltage/power displayed directly on the SLD
- **Project Persistence** — SQLite database with JSON export/import
- **Reports** — CSV and PDF export of analysis results

## Tech Stack

- **Frontend**: Vanilla JS + SVG, HTML5, CSS3
- **Backend**: Python FastAPI + SQLAlchemy + SQLite
- **Analysis**: NumPy/SciPy for numerical solvers
- **Reports**: ReportLab for PDF generation

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Select mode |
| W | Wire mode |
| Delete | Delete selected |
| Escape | Cancel / Deselect |
| Ctrl+A | Select all |
| Alt+Click | Pan canvas |
| Scroll | Zoom in/out |
