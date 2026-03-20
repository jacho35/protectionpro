# ProtectionPro — Backlog Features

## Protection Coordination Enhancements
- **Circuit breaker TCC curves**: Trip curves for MCCB and ACB thermal-magnetic characteristics
- **CT saturation modeling**: CT ratio and burden effects on relay operating times
- **Directional relay curves**: Directional overcurrent (67) curve plotting
- **TCC curve overlay on fault results**: Show fault current levels on TCC chart from analysis results
- **TCC PDF export**: Multi-page PDF report with TCC chart and coordination table
- **Manufacturer relay/fuse libraries**: Import specific manufacturer curve data

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
- **Mini-map**: Overview panel for large diagrams
- **Dark mode**: Alternative color scheme
- **Component grouping**: Group components into reusable blocks / sub-diagrams
- **Multi-page diagrams**: Multiple sheets per project for large systems
- **Print / Page layout**: Print-ready diagram output with title block and legend
- **Wire routing options**: Manual bend points, diagonal routing, spline curves
- **Component mirroring**: Horizontal and vertical flip in addition to rotation
- **Annotation text boxes**: Free-text notes and labels on the diagram

## Multi-User & Collaboration
- **User authentication**: Login system with role-based access
- **Project sharing**: Share projects between users
- **Real-time collaboration**: Multiple users editing the same SLD simultaneously
- **Audit trail**: Track changes with user attribution
- **Version history**: Track changes and revert to previous versions

## Reports & Export
- **DXF/DWG export**: Export SLD to CAD formats
- **Customizable report templates**: User-defined report layouts
- **Comparison reports**: Compare results between scenarios
- **Setting schedule export**: Protection device settings in tabular format

## Data & Integration
- **Component library import**: Import manufacturer data (transformers, cables, etc.)
- **NEC ampacity tables**: Add NEC Article 310 ampacity data alongside existing IEC 60364
- **Import from external tools**: Import from PSS/E, ETAP, or PowerWorld formats
- **Template library**: Pre-built network templates (substation, industrial plant, residential)
- **Cloud storage**: Project storage with user accounts and sharing
