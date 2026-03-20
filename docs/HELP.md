# ProtectionPro — Help & User Guide

**Single Line Diagram Builder with IEC 60909 Fault Analysis & Load Flow**

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Canvas & Navigation](#canvas--navigation)
3. [Component Palette](#component-palette)
4. [Drawing Connections](#drawing-connections)
5. [Selection & Editing](#selection--editing)
6. [Properties Panel](#properties-panel)
7. [Fault Analysis (IEC 60909)](#fault-analysis-iec-60909)
8. [Load Flow Analysis](#load-flow-analysis)
9. [Annotations & Data Labels](#annotations--data-labels)
10. [Overload & Voltage Warnings](#overload--voltage-warnings)
11. [Compliance Report](#compliance-report)
12. [Protection Coordination (TCC)](#protection-coordination-tcc)
13. [Project Management](#project-management)
14. [Settings & Libraries](#settings--libraries)
15. [Export & Reports](#export--reports)
16. [Keyboard Shortcuts](#keyboard-shortcuts)
17. [Component Reference](#component-reference)
18. [Roadmap — Future Features](#roadmap--future-features)

---

## Getting Started

ProtectionPro is a browser-based single-line diagram (SLD) builder for power system analysis. Design your electrical network by dragging components onto the canvas, connecting them with wires, and running fault or load flow analysis.

**Basic workflow:**
1. Drag components from the sidebar palette onto the canvas
2. Connect component ports by clicking and dragging between them
3. Configure component parameters in the properties panel
4. Run Fault Analysis or Load Flow from the toolbar
5. View results as on-diagram annotations and in the info panel

---

## Canvas & Navigation

### Panning
- **Middle mouse button + drag** — Pan the canvas
- **Alt + Left click + drag** — Alternative pan method

### Zooming
- **Mouse wheel** — Zoom in/out (zooms toward cursor position)
- **Fit button** — Zoom to fit all components in view
- **1:1 button** — Reset to 100% zoom and center

Zoom range: 10% to 500%. Current zoom level is shown in the toolbar.

### Grid
The canvas displays a two-level grid (20px minor, 100px major) for alignment. All component placement and movement snaps to the 20px grid.

### Coordinates
The status bar at the bottom shows the current cursor position in world coordinates (X, Y).

---

## Component Palette

The left sidebar contains all available components organised by category. Drag any component onto the canvas to place it.

### Search
Type in the search box at the top of the palette to filter components by name.

### Categories
- **Sources** — Utility (grid) connections and generators
- **Distribution** — Buses, transformers, cables/feeders
- **Protection** — Circuit breakers, fuses, relays, switches
- **Instruments** — Current transformers (CT), potential transformers (PT)
- **Loads** — Induction motors, synchronous motors, static loads
- **Other** — Capacitor banks, surge arresters

The sidebar is resizable — drag the right edge to adjust width.

---

## Drawing Connections

### Wire Mode
1. Press **W** or click the **Wire** button in the toolbar
2. Click on a component port (the small circles on component edges)
3. Drag to the target component's port and release

### Quick Wiring (Select Mode)
In Select mode, clicking directly on a port starts wire drawing without switching modes.

### Port Snapping
When drawing a wire, the endpoint automatically snaps to the nearest port within 30px. A highlighted port indicates the snap target.

### Wire Routing
Wires are routed orthogonally (vertical → horizontal → vertical) for a clean diagram appearance.

### Port Hit Areas
Each port has an enlarged invisible hit area (14px radius) around the visible circle (5px radius) making connections easier to click.

---

## Selection & Editing

### Selecting Components
- **Click** a component to select it
- **Shift + Click** to add/remove from selection
- **Click + drag on empty canvas** to marquee-select multiple items
- **Shift + marquee** to add to existing selection
- **Ctrl/Cmd + A** to select all

### Moving Components
Click and drag selected components. All selected items move together, snapping to the grid.

### Clipboard Operations
- **Ctrl/Cmd + C** — Copy selected components and their connecting wires
- **Ctrl/Cmd + V** — Paste with automatic offset
- **Ctrl/Cmd + X** — Cut (copy then delete)
- **Ctrl/Cmd + D** — Duplicate with offset

### Deleting
Select items and press **Delete** or **Backspace**, or click the **Delete** toolbar button.

### Rotation
Change component rotation (0°, 90°, 180°, 270°) from the Position section in the properties panel.

---

## Properties Panel

When a component is selected, the right panel shows:

### Parameters
Editable fields specific to each component type (voltage, power rating, impedance, etc.). Fields with unit options (e.g., kV/V, MVA/kVA) have a dropdown to switch display units.

### Standard Library Selection
Cables and transformers can be selected from a built-in standards library. Choosing a standard type auto-fills all electrical parameters.

### Position
Adjust X, Y coordinates and rotation directly.

### Per-Unit Values
Automatically calculated impedance values in per-unit on the system base MVA. Click **View Calculations** to see the step-by-step working.

### Analysis Results
When fault or load flow results are available, the properties panel shows detailed results for the selected component:
- **Fault results**: Short-circuit currents at each bus
- **Load flow results**: Voltage, power, current for buses; flow data for branches

---

## Fault Analysis (IEC 60909)

Calculates initial symmetrical short-circuit currents at every bus using the IEC 60909 method.

### Fault Types Calculated
| Type | Symbol | Description |
|------|--------|-------------|
| Three-phase | I"k3 | Balanced three-phase fault |
| Single line-to-ground | I"k1 | Phase-to-earth fault |
| Line-to-line | I"kLL | Phase-to-phase fault |

### How It Works
1. Click **Fault Analysis** in the toolbar
2. The system validates the network (checks for buses, sources, connectivity)
3. If validation passes, fault currents are computed at each bus
4. Results appear as orange annotation badges on the diagram

### Method
- Per-unit impedance method on common MVA base
- Source impedance calculated from fault level (MVA) and X/R ratio
- Generator sub-transient reactance (X"d) modelling
- Transformer impedance from Z% and X/R ratio
- Cable impedance from R and X per km
- IEC voltage factor c applied (1.05 for LV ≤1kV, 1.1 for MV/HV)

### Validation Checks
Before running analysis, the system checks for:
- At least one bus present
- At least one source (utility or generator) connected
- Source connectivity to buses
- Unconnected ports (warning only)
- Voltage consistency across transformers and cables

---

## Load Flow Analysis

Solves the power flow equations to determine bus voltages, branch currents, and power flows throughout the network.

### Methods
- **Newton-Raphson** (default) — Fast quadratic convergence
- **Gauss-Seidel** — Simpler iterative method

### Bus Types
| Type | Description |
|------|-------------|
| PQ | Load bus — P and Q specified (default) |
| PV | Generator bus — P and |V| specified |
| Swing | Slack bus — V and δ specified (reference bus) |

### Results Displayed
**Bus badges** (green):
- Voltage in kV or V (matches unit selected in properties) and per-unit
- Voltage angle in degrees
- Active power P (MW or kW)
- Reactive power Q (MVAr or kVAr)
- Current I (A)

**Branch badges** (green):
- Active power flow P
- Reactive power flow Q
- Apparent power S (MVA or kVA)
- Current I (A)
- Loading percentage (% of rated capacity)

### Component Models
- **Utility**: Admittance injection from fault level
- **Generator**: P + Q injection from rating and power factor
- **Static load**: Constant power consumption
- **Motors**: Power consumption based on rating, efficiency, and power factor
- **Capacitor bank**: Reactive power injection (kVAr)
- **Transformer**: Series impedance from Z% and tap position
- **Cable**: Series impedance from R and X per km × length
- **Solid links**: Direct bus-to-bus connections modelled as very high admittance

### Transparent Elements
Circuit breakers, switches, fuses, CTs, PTs, and surge arresters in the closed state are treated as transparent (zero impedance) connections. Open CBs and switches break the circuit.

---

## Annotations & Data Labels

### Analysis Annotations
After running fault or load flow analysis, result badges appear on the diagram:
- **Fault badges** (orange) — Short-circuit currents at each bus
- **Load flow bus badges** (green) — Voltage, power, current
- **Branch flow badges** (green) — Power flow, current, loading

All annotation badges are **draggable** — click and drag to reposition them for a cleaner diagram layout.

### Component Data Labels
Toggle with the **Labels** toolbar button. Shows key parameters next to components:

| Component | Data Shown |
|-----------|-----------|
| Cable/Feeder | Size (mm²), material, length, rated current |
| Transformer | Rating (MVA/kVA), voltage ratio, Z% |
| Static Load | Name, rated kVA, power factor |
| Induction Motor | Name, rated kW, power factor |
| Synchronous Motor | Name, rated kVA, power factor |

Data labels are **draggable** — click and drag to reposition. Position offsets are saved with the project.

---

## Overload & Voltage Warnings

After running load flow analysis, the system automatically flags problematic components:

### Overloaded Equipment
A pulsing red flag with the loading percentage appears on any branch element (cable or transformer) where loading exceeds 100% of rated capacity.

### Voltage Violations
A pulsing red flag appears on any bus where voltage falls outside the acceptable range:
- **LOW V** — Voltage below 0.95 p.u.
- **HIGH V** — Voltage above 1.05 p.u.

The voltage value is displayed in the unit selected in the properties panel (kV or V).

### Unconnected Port Warnings
Toggle with the **Warnings** toolbar button. Shows pulsing dashed red circles on any component port that has no wire connected.

---

## Compliance Report

Click the **Compliance** button in the toolbar to generate a standards compliance report. The report cross-checks analysis results against equipment ratings and IEC standards limits.

### Report Sections

#### 1. Network Validation (General)
Checks network topology for errors and warnings — missing buses, isolated components, voltage mismatches, missing swing bus.

#### 2. Fault Duty Assessment (IEC 60909)
Compares prospective fault currents (I"k3) at each bus against the breaking capacity of connected circuit breakers and fuses. Flags:
- **FAIL** — Fault current exceeds device breaking capacity
- **PASS** — Device is adequately rated, with margin percentage shown
- **WARN** — No breaking capacity specified, or no protection device on bus

Requires fault analysis to be run first.

#### 3. Voltage Compliance (IEC 60038)
Checks all bus voltages from load flow against the IEC 60038 standard range of 0.95–1.05 p.u.:
- **FAIL** — Under-voltage (< 0.95 p.u.) or over-voltage (> 1.05 p.u.)
- **PASS** — Voltage within acceptable range

Requires load flow to be run first.

#### 4. Thermal Loading (IEC 60364 / IEC 60076)
Checks cable and transformer loading percentages from load flow:
- **FAIL** — Loading exceeds 100% (overloaded)
- **WARN** — Loading above 80% (limited headroom)
- **PASS** — Loading within acceptable limits

#### 5. Protection Device Ratings (IEC 62271 / IEC 60947)
Checks that circuit breaker, fuse, and switch rated voltages match the system voltage at their connected bus. Also checks rated current against load flow currents through adjacent branches.

#### 6. Equipment Inventory
Summary count of all component types in the network.

### Summary Badge
The modal header shows a summary badge:
- **Green** — All checks pass
- **Orange** — Warnings present but no failures
- **Red** — One or more failures detected

### PDF Export
Click **Download PDF** in the compliance modal to generate a formatted A4 portrait PDF with all sections, colour-coded status columns, and page numbers.

---

## Protection Coordination (TCC)

The **TCC** (Time-Current Characteristic) chart displays overcurrent protection device curves on a log-log plot, enabling visual coordination analysis.

### Opening the TCC Chart
Click the **TCC** button in the toolbar. The chart automatically loads all 50/51 overcurrent relays and fuses from the current SLD.

### Chart Features
- **Log-log axes**: Current (1A–100kA) on the X axis, time (1ms–1000s) on the Y axis
- **IDMT relay curves**: IEC 60255 (Standard, Very, Extremely, Long Time Inverse) and IEEE C37.112 (Moderately, Very, Extremely Inverse)
- **Fuse curves**: IEC 60269 gG fuse pre-arcing time-current characteristics (16A–630A)
- **Interactive tooltip**: Hover over the chart to see trip times for all visible devices at any current level
- **Device visibility**: Toggle individual device curves on/off in the device list

### Adding Custom Devices
Use the side panel to add devices not on the SLD:
- **Relay**: Select curve type, set pickup current (A) and time dial setting (TDS)
- **Fuse**: Select a standard gG fuse rating (16A–630A)

### Coordination Check
The automatic grading margin checker tests all visible device pairs at multiple fault current levels (500A–20kA) and flags any pair with less than the configured grading margin (default 0.3s). Results appear in the coordination panel with downstream/upstream device names, test current, and measured margin.

Adjust the grading margin using the **Grading Margin (s)** input field.

### Export
Click **Export PNG** to download the TCC chart as a high-resolution PNG image.

---

## Project Management

### New Project
Click **New** to start a fresh project. Warns if there are unsaved changes.

### Save
Click **Save** or press **Ctrl/Cmd + S**. On first save, prompts for a project name. Saves to the database; if the backend is unavailable, automatically falls back to JSON file download.

### Save As
Click **Save As** to save a copy with a new name. Creates a new project entry in the database.

### Open
Click **Open** to browse saved projects from the database. The picker shows project names and last-modified dates. You can also delete projects from this dialog, or import from a JSON file.

---

## Settings & Libraries

Click the **Settings** (gear) button to open the settings modal.

### System Base Tab
- **Base MVA** — System base power for all per-unit calculations (default: 100 MVA)
- **Frequency** — System frequency: 50 Hz or 60 Hz

### Cable Library Tab
Browse, add, edit, or delete cable types. The built-in library includes 70+ cables covering:
- Conductors: Copper (Cu) and Aluminium (Al)
- Insulation: XLPE and PVC
- Voltage levels: 0.4 kV, 11 kV, 22 kV, 33 kV
- Per IEC 60502 / SANS 1339 standards

Click **Reset to Defaults** to restore the original library.

### Transformer Library Tab
Browse, add, edit, or delete transformer types. The built-in library includes 22 transformers:
- Distribution: 11/0.42 kV (100 kVA to 2 MVA)
- Medium voltage: 33/11 kV (5 MVA to 40 MVA)
- Sub-transmission: 132/33 kV and 132/11 kV (20 MVA to 80 MVA)
- Standard vector groups: Dyn11, YNd11, Yyn0

### IEC Standards Tab

A built-in reference database of IEC electrical installation standards with four sub-sections:

#### Cable Ampacity (IEC 60364-5-52)
Reference current-carrying capacity tables from IEC 60364-5-52 (Tables B.52.2–B.52.5). Filter by conductor material (Copper/Aluminium) and insulation type (XLPE/PVC) to see base ampacity values across installation methods A1, B1, C, D1, D2, E, F.

- 17 standard cable sizes from 1.5 mm² to 400 mm²
- 7 installation methods
- Reference conditions: 30°C ambient air, 20°C ground, 2.5 K·m/W soil resistivity

#### Cable Sizing Calculator
Enter a design current and installation conditions, and the calculator applies all applicable IEC 60364-5-52 derating factors to recommend a cable size:

- **Inputs**: Design current (A), conductor, insulation, installation method, ambient temperature, number of grouped circuits, grouping arrangement
- **Buried cable inputs**: Soil thermal resistivity, depth of laying
- **Derating factors applied**:
  - Temperature correction (Table B.52.14/15)
  - Grouping correction (Table B.52.17)
  - Soil resistivity correction (Table B.52.16) — buried cables only
  - Depth of laying correction (Table B.52.18) — buried cables only
- **Output**: Combined derating factor, required base ampacity, recommended cable size with margin %, and a table showing all cable sizes with their derated capacities

#### Derating Factors
Browse the individual correction factor tables:

| Table | Reference | Description |
|-------|-----------|-------------|
| Temperature (B.52.14/15) | 30°C air / 20°C ground | PVC and XLPE factors for 10°C to 80°C |
| Grouping (B.52.17) | 1 circuit | Factors for 1–20 circuits across 6 arrangements |
| Soil Resistivity (B.52.16) | 2.5 K·m/W | Factors for 0.5 to 3.0 K·m/W |
| Depth of Laying (B.52.18) | 0.7 m | Factors for 0.5 m to 1.5 m |

Reference values are highlighted in each table.

#### Voltage Factors (IEC 60909)
IEC 60909 Table 1 voltage factor *c* values for maximum and minimum short-circuit current calculations:
- Low voltage (≤ 1 kV): c_max = 1.05, c_min = 0.95
- Medium voltage (1–35 kV): c_max = 1.10, c_min = 1.00
- High voltage (> 35 kV): c_max = 1.10, c_min = 1.00

---

## Export & Reports

Click the **Export** dropdown in the toolbar to access all export options.

### Export Project (JSON)
Downloads the full project as a `.json` file including all components, wires, settings, and analysis results. This file can be re-imported via Open → Import from JSON file.

### Export Diagram (SVG)
Exports a clean standalone SVG vector image of the single-line diagram with all annotations and data labels. Grid lines are removed. Suitable for embedding in documents or further editing in vector graphics software.

### Export Diagram (PNG)
Exports the diagram as a 2x resolution PNG raster image with a white background. Ideal for presentations and reports.

### Export Results (CSV)
Exports fault analysis and load flow results as a CSV spreadsheet. Includes fault currents at each bus, bus voltages/powers, and branch flows with loading percentages. Requires running analysis first.

### Export Report (PDF)
Generates a multi-page PDF report containing:
- **Title page** with project name, base MVA, frequency, and date
- **Diagram** — the single-line diagram rendered on the first page
- **Fault analysis table** — IEC 60909 short-circuit currents at each bus (blue header)
- **Load flow tables** — bus voltages/power and branch flows with loading (green header)
- **Equipment summary** — all components with type and key parameters
- Page numbers and project name footer on every page

Requires running fault analysis and/or load flow first. All export is done client-side using jsPDF.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **V** | Select mode |
| **W** | Wire mode |
| **Delete / Backspace** | Delete selection |
| **Escape** | Cancel wire drawing / clear selection |
| **Ctrl/Cmd + S** | Save project |
| **Ctrl/Cmd + A** | Select all |
| **Ctrl/Cmd + C** | Copy |
| **Ctrl/Cmd + V** | Paste |
| **Ctrl/Cmd + X** | Cut |
| **Ctrl/Cmd + D** | Duplicate |
| **Middle mouse / Alt + drag** | Pan canvas |
| **Mouse wheel** | Zoom in/out |

---

## Component Reference

### Sources

#### Utility (Grid Connection)
Represents the external power grid / infinite bus.
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Utility |
| Voltage | kV / V | 33 |
| Fault Level | MVA | 500 |
| X/R Ratio | — | 10 |

#### Generator
Synchronous or asynchronous generator.
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Gen |
| Rated MVA | MVA / kVA | 10 |
| Voltage | kV / V | 11 |
| X"d | p.u. | 0.15 |
| X'd | p.u. | 0.25 |
| Xd | p.u. | 1.5 |
| X/R Ratio | — | 20 |
| Power Factor | — | 0.85 |

### Distribution

#### Bus
Busbar node for connecting components.
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Bus |
| Voltage | kV / V | 11 |
| Bus Type | — | PQ |

Bus types: PQ (load), PV (generator voltage-controlled), Swing (slack/reference).

#### Transformer
Power or distribution transformer.
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Trafo |
| Standard Type | Library | — |
| Rated MVA | MVA / kVA | 10 |
| HV Voltage | kV | 33 |
| LV Voltage | kV | 11 |
| Z% | % | 8 |
| X/R Ratio | — | 10 |
| Tap Position | % | 0 |
| Vector Group | — | Dyn11 |

IEC symbol: two overlapping circles per IEC 60617.

#### Cable / Feeder
Transmission or distribution cable.
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Cable |
| Standard Type | Library | — |
| Length | km / m | 1 |
| R per km | Ω/km | 0.164 |
| X per km | Ω/km | 0.08 |
| Rated Current | A | 300 |
| Voltage | kV | 11 |

### Protection Devices

#### Circuit Breaker (CB)
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | CB |
| Rated Voltage | kV | 11 |
| Rated Current | A | 630 |
| Breaking Capacity | kA | 25 |
| State | — | closed |

When closed, the CB is transparent to analysis (zero impedance). When open, it breaks the circuit.

#### Fuse
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Fuse |
| Rated Voltage | kV | 11 |
| Rated Current | A | 100 |
| Breaking Capacity | kA | 25 |

#### Relay
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Relay |
| Type | — | 50/51 |
| Pickup Current | A | 100 |
| Time Dial | — | 0.1 |
| Curve Type | — | IEC Standard Inverse |

Relay types: 50/51 (overcurrent), 50N/51N (ground fault), 87 (differential), 21 (distance).

#### Switch (Disconnector)
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Switch |
| Rated Voltage | kV | 11 |
| Rated Current | A | 630 |
| State | — | closed |

### Instrument Transformers

#### Current Transformer (CT)
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | CT |
| Ratio | — | 400/5 |
| Class | — | 5P20 |
| Burden | VA | 15 |

#### Potential Transformer (PT)
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | PT |
| Ratio | — | 11000/110 |
| Class | — | 0.5 |
| Burden | VA | 25 |

### Loads

#### Static Load
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Load |
| Rating | kVA | 100 |
| Voltage | kV | 0.4 |
| Power Factor | — | 0.85 |
| Load Type | — | constant_power |

Load types: constant_power, constant_current, constant_impedance.

#### Induction Motor
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | IM |
| Rating | kW | 200 |
| Voltage | kV | 0.4 |
| Efficiency | — | 0.93 |
| Power Factor | — | 0.85 |
| LRC (× FLC) | — | 6 |
| X" | p.u. | 0.17 |

#### Synchronous Motor
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | SM |
| Rating | kVA | 500 |
| Voltage | kV | 3.3 |
| Power Factor | — | 0.9 |
| Xd" | p.u. | 0.15 |
| Xd' | p.u. | 0.25 |

### Other

#### Capacitor Bank
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Cap |
| Rating | kVAr | 100 |
| Voltage | kV | 11 |
| Steps | — | 1 |

#### Surge Arrester
| Parameter | Unit | Default |
|-----------|------|---------|
| Name | — | Arrester |
| Rated Voltage | kV | 11 |
| MCOV | kV | 8.05 |
| Class | — | Station |

Classes: Station, Intermediate, Distribution.

---

## Roadmap — Future Features

The following features are planned for upcoming releases of ProtectionPro:

### Analysis & Simulation
- **Asymmetrical fault analysis** — Full sequence component modelling (positive, negative, zero sequence) for detailed SLG, LLG, and LL fault calculations
- **Arc flash analysis** — IEEE 1584 incident energy and arc flash boundary calculations
- **Protection coordination** — Time-current curve (TCC) plotting, relay/fuse grading, coordination study with graphical TCC editor
- **Harmonic analysis** — Harmonic load flow, THD calculations, filter design assistance
- **Transient stability** — Dynamic simulation of generator swing curves, motor starting analysis
- **Motor starting study** — Voltage dip calculations during DOL/star-delta/VFD motor starting
- **Optimal power flow (OPF)** — Economic dispatch with voltage and thermal constraints
- **Relay setting calculator** — Automated relay setting suggestions based on network configuration

### Components & Modelling
- **Overhead line model** — Conductor geometry, tower configuration, sag-tension parameters
- **Auto-transformer model** — Three-winding and auto-transformer impedance models
- **Reactor / Series compensator** — Shunt and series reactive elements
- **Battery / Energy storage** — Battery model with charge/discharge characteristics
- **Solar PV / Wind generator** — Renewable energy source models with inverter characteristics
- **Variable frequency drives (VFD)** — Motor drive models with harmonic injection profiles
- **Neutral earthing resistor (NER)** — Earthing system modelling for ground fault analysis
- **Bus section / Bus coupler** — Dedicated bus section switch component

### User Interface
- **Undo / Redo** — Full history stack for all canvas operations
- **Component grouping** — Group components into reusable blocks / sub-diagrams
- **Multi-page diagrams** — Multiple sheets per project for large systems
- **Print / Page layout** — Print-ready diagram output with title block, legend, and page borders
- **Dark mode** — Full dark theme for the application
- **Zoom to selection** — Frame selected components in the viewport
- **Wire routing options** — Manual bend points, diagonal routing, spline curves
- **Component mirroring** — Horizontal and vertical flip in addition to rotation
- **Annotation text boxes** — Free-text notes and labels on the diagram
- **Layer control** — Show/hide specific annotation layers independently

### Reporting & Export
- **DXF / DWG export** — Export diagrams in AutoCAD-compatible formats
- **Compliance report** — IEC 60909 / IEEE 141 formatted analysis reports with standard references
- **Setting schedule export** — Protection device settings in tabular format

### Collaboration & Integration
- **Multi-user editing** — Real-time collaboration on the same diagram
- **Version history** — Track changes and revert to previous versions
- **Import from external tools** — Import from PSS/E, ETAP, or PowerWorld formats
- **REST API for automation** — Programmatic network building and batch analysis
- **Template library** — Pre-built network templates (substation, industrial plant, residential)
- **Cloud storage** — Project storage with user accounts and sharing

### Standards & Compliance
- **IEC 61850 mapping** — Logical node naming per IEC 61850 standards
- **IEEE 242 (Buff Book)** — Protection and coordination per IEEE 242
- **NEC / SANS 10142 compliance checks** — Automatic compliance verification
- **Equipment duty validation** — Verify that equipment ratings exceed fault duties

---

*ProtectionPro v1.0 — Built for power systems engineers.*
