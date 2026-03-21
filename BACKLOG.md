# ProtectionPro — Backlog Features

## High Priority — Core Engineering Studies

- **Cable sizing calculator**: Per-cable thermal check, voltage drop (%), and adiabatic fault withstand (k²S²); recommend minimum conductor size from standard library
- **Motor starting study**: Static voltage dip calculation during DOL/star-delta/VFD starting; check motor terminal voltage ≥ 0.8 pu and system dip ≤ 15%
- **Equipment duty check**: Compare prospective fault current (ik3, ip) against CB/fuse interrupt and making ratings; flag under-rated devices with utilisation %

## Analysis — New Studies

- **Transient stability**: Dynamic simulation of generator swing curves post-fault; equal-area criterion, CCT calculation
- **Optimal power flow (OPF)**: Economic dispatch with voltage and thermal constraints
- **Relay setting calculator**: Automated pickup and TDS suggestions based on load current, fault levels, and grading margins
- **IEC 61363 marine/offshore fault analysis**: Fault analysis for isolated marine/offshore networks with rotating machine sources

## Analysis — Enhancements to Existing

- **Sequence impedance editor**: Positive, negative, zero sequence impedance entry per component for detailed asymmetrical fault calculations
- **Harmonic load flow**: Frequency-domain analysis for non-linear loads; THD calculations and filter design assistance

## Components & Modelling

- **Overhead line model**: Conductor geometry, tower configuration, bundling, sag-tension parameters, and Carson's equations for impedance
- **Auto-transformer / 3-winding transformer**: Off-nominal tap, tertiary winding, auto-transformer impedance models
- **Reactor / series compensator**: Shunt and series reactive elements (inductors and capacitors)
- **Battery / energy storage**: Charge/discharge model, SOC tracking, inverter interface
- **Variable frequency drive (VFD)**: Motor drive model with harmonic injection profiles and reduced starting current
- **Neutral earthing resistor (NER)**: Earthing system modelling for ground fault current limitation
- **Bus section / bus coupler**: Dedicated bus section switch component for ring and double-busbar topologies

## Protection Coordination Enhancements

- **CT saturation modeling**: CT ratio and burden effects on relay operating times
- **Directional relay curves**: Directional overcurrent (67) curve plotting

## TCC Chart Enhancements

- **Drag devices between tabs**: Move devices to custom tabs via drag-and-drop
- **User-defined curve data**: Import custom manufacturer TCC data points (CSV)

## User Interface

- **Component mirroring**: Horizontal and vertical flip in addition to rotation
- **Annotation text boxes**: Free-text notes and callout labels placed on the diagram canvas
- **Layer control**: Show/hide specific annotation and result layers independently
- **Zoom to selection**: Frame selected components in the viewport

## Standards & Compliance

- **IEC 61850 mapping**: Logical node naming per IEC 61850 for protection and control devices
- **IEEE 242 (Buff Book)**: Protection and coordination study report per IEEE 242
- **NEC / SANS 10142 compliance checks**: Automatic wiring compliance verification against national standards

## Reports & Export

- **DXF/DWG export**: Export SLD to AutoCAD-compatible CAD formats

## Data & Integration

- **Component library import**: Import manufacturer data (transformers, cables, relays) from CSV/XML
- **NEC ampacity tables**: Add NEC Article 310 ampacity data alongside existing IEC 60364
- **Import from external tools**: Import network models from PSS/E (.raw), ETAP, or PowerWorld formats
- **REST API for automation**: Programmatic network building and batch analysis via documented REST API
- **Cloud storage**: Project storage with user accounts and sharing

## Multi-User & Collaboration

- **User authentication**: Login system with role-based access (viewer, editor, admin)
- **Project sharing**: Share projects between users with permission control
- **Real-time collaboration**: Multiple users editing the same SLD simultaneously
- **Audit trail**: Track changes with user attribution
- **Version history**: Track changes and revert to previous versions

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
