# ProtectionPro — Backlog Features

## Protection Coordination Enhancements
- **CT saturation modeling**: CT ratio and burden effects on relay operating times
- **Directional relay curves**: Directional overcurrent (67) curve plotting
- **Distance relay (21) TCC curves**: Impedance-based relay plotting on TCC
- **Auto-coordination engine**: Automatically set relay/CB grading based on upstream/downstream topology

## Fault Analysis Enhancements
- **Sequence impedance editor**: Positive, negative, zero sequence impedance entry per component
- **IEC 61363 marine/offshore fault analysis**: Fault analysis for isolated marine/offshore networks
- **Protection relay miscoordination detection**: Flag relays that won't trip in correct sequence for a given fault

## Arc Flash
- **IEEE 1584-2018 arc flash calculations**: Incident energy, arc flash boundary, PPE category
- **Equipment labeling**: Auto-generate arc flash warning labels per NFPA 70E
- **Working distance configuration**: Per-bus working distance settings

## Load Flow Enhancements
- **Distributed generation**: Solar PV and wind turbine models
- **Harmonic load flow**: Frequency-domain analysis for non-linear loads

## TCC Chart Enhancements
- **Drag devices between tabs**: Move devices to custom tabs via drag-and-drop
- **User-defined curve data**: Import custom manufacturer TCC data points (CSV)

## UI / UX
- **Component grouping**: Group components into reusable blocks / sub-diagrams
- **Multi-page diagrams**: Multiple sheets per project for large systems
- **Print / Page layout**: Print-ready diagram output with title block and legend
- **Wire diagonal/spline routing**: Diagonal routing, spline curves (bend points already implemented)

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
