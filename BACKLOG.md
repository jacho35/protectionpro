# ProtectionPro — Backlog Features

## Protection Coordination Enhancements
- **CT saturation modeling**: CT ratio and burden effects on relay operating times
- **Directional relay curves**: Directional overcurrent (67) curve plotting

## Fault Analysis Enhancements
- **Sequence impedance editor**: Positive, negative, zero sequence impedance entry per component
- **IEC 61363 marine/offshore fault analysis**: Fault analysis for isolated marine/offshore networks

## Load Flow Enhancements
- **Harmonic load flow**: Frequency-domain analysis for non-linear loads

## TCC Chart Enhancements
- **Drag devices between tabs**: Move devices to custom tabs via drag-and-drop
- **User-defined curve data**: Import custom manufacturer TCC data points (CSV)

## Multi-User & Collaboration
- **User authentication**: Login system with role-based access
- **Project sharing**: Share projects between users
- **Real-time collaboration**: Multiple users editing the same SLD simultaneously
- **Audit trail**: Track changes with user attribution
- **Version history**: Track changes and revert to previous versions

## Reports & Export
- **DXF/DWG export**: Export SLD to CAD formats

## Data & Integration
- **Component library import**: Import manufacturer data (transformers, cables, etc.)
- **NEC ampacity tables**: Add NEC Article 310 ampacity data alongside existing IEC 60364
- **Import from external tools**: Import from PSS/E, ETAP, or PowerWorld formats
- **Cloud storage**: Project storage with user accounts and sharing

---

## Completed
- ~~Overlay fault current markers on TCC~~
- ~~TCC comparison mode (side-by-side before/after)~~
- ~~Toolbar reorganization (two rows)~~
- ~~TCC CB instantaneous line dragging (magnetic pickup)~~
- ~~TCC editable settings panel for selected curves~~
- ~~Customizable report templates~~
- ~~Scenario comparison reports~~
- ~~Settings schedule export (CSV)~~
- ~~Pre-built network template library (substation, industrial, residential, generator)~~
- ~~Component grouping (Ctrl+G / Ctrl+Shift+G)~~
- ~~Multi-page diagrams (sheet tabs, add/delete/rename)~~
- ~~Print / page layout (PDF with title block, legend, border)~~
- ~~Wire diagonal/spline routing~~
- ~~Off-page connectors (cross-page electrical links)~~
- ~~Draggable bus resizing with dynamic connection ports~~
- ~~Distributed generation: Solar PV and wind turbine models~~
- ~~IEEE 1584-2018 arc flash calculations with incident energy, PPE categories, and arc flash boundary~~
- ~~Per-bus working distance and electrode configuration settings~~
- ~~Arc flash on-diagram annotations with PPE-category color coding~~
- ~~Arc flash improvement recommendations per bus~~
- ~~Help modal with comprehensive documentation~~
- ~~Voltage depression during fault (Zbus matrix, retained voltage at all buses)~~
- ~~Time-varying voltage profile (sub-transient/transient/steady-state)~~
- ~~Motor reacceleration voltage recovery post-fault clearing~~
- ~~Color-coded voltage sag map on SLD~~
- ~~Distance relay (21) TCC curves with mho characteristic R-X inset~~
- ~~Auto-coordination engine: topology-aware relay/CB grading~~
- ~~Protection relay miscoordination detection~~
- ~~Arc flash label PDF export (server-side)~~
- ~~Relay-CT-CB linking (associated CT and trip CB)~~
- ~~Server-side PDF report generation (fpdf2)~~
- ~~Parallel cable impedance modeling~~
