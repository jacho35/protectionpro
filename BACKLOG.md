# ProtectionPro — Backlog Features

## Fault Analysis Enhancements
- **Full IEC 60909 time-varying fault currents**: I"k (initial), Ip (peak), Ib (breaking), Ik (steady-state)
- **Motor contribution to faults**: Induction and synchronous motor sub-transient contributions with decay modeling
- **DLG (Double Line-to-Ground) fault type**: Add to existing 3-phase, SLG, LL fault calculations
- **Sequence impedance editor**: Positive, negative, zero sequence impedance entry per component

## Arc Flash
- **IEEE 1584-2018 arc flash calculations**: Incident energy, arc flash boundary, PPE category
- **Equipment labeling**: Auto-generate arc flash warning labels per NFPA 70E
- **Working distance configuration**: Per-bus working distance settings

## Load Flow Enhancements
- **Voltage regulator modeling**: Tap-changing transformers with automatic tap adjustment
- **Distributed generation**: Solar PV and wind turbine models
- **Harmonic load flow**: Frequency-domain analysis for non-linear loads

## UI / UX
- **Undo/Redo system**: Full action history with keyboard shortcuts
- **Copy/paste components**: Duplicate sections of the SLD
- **Multi-select and group operations**: Move/delete multiple components at once
- **Zoom-to-fit**: Auto-frame the entire diagram
- **Mini-map**: Overview panel for large diagrams
- **Dark mode**: Alternative color scheme
- **Component search**: Search bar in the sidebar palette

## Multi-User & Collaboration
- **User authentication**: Login system with role-based access
- **Project sharing**: Share projects between users
- **Real-time collaboration**: Multiple users editing the same SLD simultaneously
- **Audit trail**: Track changes with user attribution

## Reports & Export
- **DXF/DWG export**: Export SLD to CAD formats
- **SVG export**: High-quality vector export of the diagram
- **Customizable report templates**: User-defined report layouts
- **Comparison reports**: Compare results between scenarios

## Data & Integration
- **Component library import**: Import manufacturer data (transformers, cables, etc.)
- **Standards database**: Built-in cable ampacity tables (IEC 60364, NEC)
- **API integration**: REST API for external tool integration
