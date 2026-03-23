# ProtectionPro — Backlog Features

## Protection Coordination Enhancements

## Fault Analysis Enhancements
- ~~**Sequence impedance editor**: Positive, negative, zero sequence impedance entry per component~~
- **IEC 61363 marine/offshore fault analysis**: Fault analysis for isolated marine/offshore networks

## Load Flow Enhancements
- ~~**Source/generator load split**: Fix generator vs utility power split when utility is behind a source-connected transformer~~
- **Harmonic load flow**: Frequency-domain analysis for non-linear loads

## TCC Chart Enhancements

## Multi-User & Collaboration
- **User authentication**: Login system with role-based access
- **Project sharing**: Share projects between users
- **Real-time collaboration**: Multiple users editing the same SLD simultaneously
- **Audit trail**: Track changes with user attribution
- **Version history**: Track changes and revert to previous versions

## Reports & Export
- ~~**Detailed calculations report**: Multi-section PDF showing formulas, intermediate values, and step-by-step calculations for fault analysis (IEC 60909), load flow, arc flash (IEEE 1584-2018), cable sizing (IEC 60364), motor starting, duty check, load diversity, and grounding (IEEE 80)~~
- **DXF/DWG export**: Export SLD to CAD formats

## Data & Integration
- **Component library import**: Import manufacturer data (transformers, cables, etc.)
- ~~**NEC ampacity tables**: Add NEC Article 310 ampacity data alongside existing IEC 60364~~
- **Import from external tools**: Import from PSS/E, ETAP, or PowerWorld formats
- ~~**Cloud storage**: Project storage with user accounts and sharing~~ (file manager with folders implemented; user accounts pending)

---

## ETAP Feature Parity

Features identified by comparing ProtectionPro against ETAP's full module set.

### Analysis Modules

- **Transient Stability Analysis**: Time-domain simulation of system disturbances — load shedding, fast bus transfer, critical clearing time, generator start-up with speed-torque dynamics
- **Harmonic Analysis (full)**: THD calculation, harmonic current/voltage sources (VFD, UPS, converters), harmonic resonance identification, filter design; extends existing harmonic load flow backlog item
- **Frequency Scan**: Impedance vs. frequency sweep across the network for resonance identification
- **DC Load Flow**: Load flow solver for DC buses (UPS, battery, telecom DC systems)
- **DC Short Circuit**: Short circuit analysis for DC networks
- ~~**DC Arc Flash**: DC arc flash per Stokes & Oppenlander and DGUV-I 203-077 methods (AC arc flash already implemented)~~
- **Battery Sizing & Discharge Analysis**: Size batteries from duty cycle, model discharge curves, voltage performance over time
- **Optimal Power Flow (OPF)**: Economic dispatch, Volt/VAR optimization, switching optimization
- **Reliability Assessment**: SAIDI, SAIFI, MAIFI indices; failure mode & effect analysis (FMEA) for distribution networks
- **Voltage Stability Analysis**: P-V and Q-V curves, nose curves, voltage collapse prediction
- ~~**Unbalanced Load Flow**: Three-phase asymmetric network analysis for unbalanced distribution systems~~ ✓
- **Contingency Analysis (N-1 / N-2)**: Security analysis for single and double outage scenarios
- **Motor Acceleration (Full Dynamic)**: Time-domain simulation with speed-torque curves, acceleration time, starter/contactor selection — beyond current locked-rotor static analysis
- **Passive Filter Sizing**: Size LC/C harmonic filters to meet THD limits
- **Optimal Capacitor Placement**: VAR compensation placement and sizing optimization
- **Transformer Tap Optimization**: Automatic tap position optimization for voltage regulation
- **Flicker Analysis**: Voltage flicker assessment per IEC 61000-3-3 / IEC 61000-4-15
- **Feeder Hosting Capacity**: Nodal HC, Stochastic HC, and DER impact analysis for renewable integration planning
- **Lightning Risk Assessment**: Structural and system lightning risk per IEC 62305-2

### Standards Coverage

- **ANSI/IEEE C37 Short Circuit**: Short circuit analysis per ANSI standards alongside existing IEC 60909 (required for US market)
- **AS/NZS 3000 Thermal & Shock Protection**: Australian/NZ wiring rules compliance checks
- ~~**SANS 10142 Wiring of Premises**: Automatic compliance checks for South African wiring rules~~

### Component & Modelling Gaps

- **Battery Energy Storage System (BESS)**: BESS component for SLD with charge/discharge modelling in load flow and dynamics
- **Variable Frequency Drive (VFD)**: Harmonic current source model for drives and converters
- **Autotransformer (2W & 3W)**: Autotransformer model with tap-changing voltage regulation
- ~~**UPS / Rectifier / Charger**: DC system source components for battery-backed systems~~ ✓
- **Static VAR Compensator (SVC) / STATCOM**: Reactive compensation FACTS devices for voltage control
- **HVDC Link**: DC interconnection between AC buses for HVDC system modelling

### Cable & Raceway

- **Underground Raceway System (URS)**: Conduit fill analysis and thermal derating for bundled cables in conduit
- **Cable Pulling Analysis**: Tension, sidewall pressure, and jam ratio calculations for cable installation

### Control & Schematic

- **Control Circuit / Schematic Diagram**: AC/DC control circuit simulation — ladder logic, interlocking, panel wiring
- **Protective Device Sequence of Operation**: Simulate and verify the sequence of relay/CB operations during a fault event

### Integration & Interoperability

- **IEC CIM (Common Information Model) Import/Export**: Standard utility data interchange format
- **GIS Integration**: Geospatial mapping and overlay of the network diagram
- **Real-Time SCADA Integration**: Live data feeds for operational digital twin monitoring and control

### Platform

- **AI / Natural Language Search**: Query the model and run analyses using plain-language prompts

---

## Completed
- ~~Mobile interface: responsive layout with bottom navigation, slide-up component/analysis/properties/menu sheets, pinch-to-zoom and pan touch gestures, floating action buttons for mode and zoom, tap-to-place components~~
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
- ~~Fix bus detection: validation and unconnected-port warnings now use dynamic bus ports instead of static placeholders~~
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
- ~~CT saturation modeling: CT ratio and burden effects on relay operating times~~
- ~~Directional relay curves: Directional overcurrent (67) curve plotting~~
- ~~Detailed calculation formulas and standard references in HELP documentation for all analysis functions (Fault, Load Flow, Arc Flash, Cable Sizing, Duty Check, Grounding, Load Diversity, Motor Starting, TCC)~~
- ~~Drag devices between tabs: Move devices to custom tabs via drag-and-drop~~
- ~~User-defined curve data: Import custom manufacturer TCC data points (CSV)~~
- ~~UPS / Rectifier / Battery Charger: DC system source components for battery-backed systems~~
- ~~Directional flow arrows on wire connections (animated direction indicators)~~
- ~~Unbalanced load flow: Three-phase asymmetric network analysis using symmetrical component method~~
- ~~NEC ampacity tables: NEC Article 310.16 ampacity data alongside existing IEC 60364~~
- ~~Sequence impedance editor: Positive, negative, zero sequence impedance fields for utility, generator, cable, and motor components~~
- ~~DC arc flash analysis: Stokes & Oppenlander method with DGUV-I 203-077, DC arcing current, incident energy, PPE categories, and arc flash boundary~~
- ~~SANS 10142 automatic compliance checks: LV voltage tolerance (±10%, NRS 048-2), cable protection coordination (In ≤ Iz, Cl. 5.5.2), minimum conductor size (Cl. 5.6.3), transformer neutral earthing (Cl. 8.3.1), maximum demand vs supply capacity (Appendix B), earth fault disconnection current (Cl. 5.5.6)~~
- ~~Source/generator load split: Fix incorrect proportional split when utility source connects via transformer — generators now report at rated output, utility takes residual~~
- ~~Detailed calculations report: Multi-section PDF with formulas and intermediate values for all analysis types (fault, load flow, arc flash, cable sizing, motor starting, duty check, load diversity, grounding)~~
- ~~Help documentation update: Comprehensive help with all 22 component types, new Studies tab (cable sizing, motor starting, duty check, load diversity, grounding), DC arc flash docs, unbalanced load flow, TCC enhancements, compliance details, updated shortcuts, templates, export options, scenarios, and mobile support~~
- ~~Apparent power (S) display in load flow annotation badges~~
- ~~Toolbar quick access bar: Favourited/commonly used tools pinned to the toolbar for one-click access, with editor modal and localStorage persistence~~
- ~~File manager: folder-based project organization, project/folder rename, move projects between folders~~
- ~~Hide busbar connection points once connected: bus ports are hidden after a wire is attached, reducing visual clutter~~
- ~~Independent flow arrows: Load flow arrows show independently when load flow is run; fault current arrows show only when a specific bus is faulted, with direction toward the faulted bus~~
- ~~Fix sheet display bug: annotations, data labels, overload flags, and unconnected port warnings from other sheets no longer bleed through to the active sheet~~
- ~~Fix fault branch current display: upstream branch fault currents now account for transformer turns ratios by converting per-unit current to actual kA at each element's operating voltage level~~
- ~~Fix cable sizing warnings: warnings no longer recommend the same cable already selected; warning badges and results table now show tooltip explanations for why the cable is near limits~~
- ~~Reports menu: moved report exports (CSV, PDF, templates, settings schedule, arc flash labels, calculations, scenario comparison) from File menu to dedicated Reports menu~~
- ~~Fix print/page layout PDF export: add dynamic jsPDF loading with fallback when CDN script fails to load~~
- ~~Fix single-line diagram missing from PDF reports: rasterize SVG client-side and embed in server-generated PDF~~
- ~~Connection warning logic: unconnected port warnings on buses only shown when the bus has zero connections, not on every empty port~~
