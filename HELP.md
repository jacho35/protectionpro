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
9. [Arc Flash Analysis (IEEE 1584)](#arc-flash-analysis-ieee-1584)
10. [Cable Sizing (IEC 60364)](#cable-sizing-iec-60364)
11. [Equipment Duty Check](#equipment-duty-check)
12. [Grounding System Analysis (IEEE 80)](#grounding-system-analysis-ieee-80)
13. [Load Diversity Analysis](#load-diversity-analysis)
14. [Motor Starting Analysis](#motor-starting-analysis)
15. [Annotations & Data Labels](#annotations--data-labels)
16. [Overload & Voltage Warnings](#overload--voltage-warnings)
17. [Compliance Report](#compliance-report)
18. [Protection Coordination (TCC)](#protection-coordination-tcc)
19. [Project Management](#project-management)
20. [Settings & Libraries](#settings--libraries)
21. [Export & Reports](#export--reports)
22. [Keyboard Shortcuts](#keyboard-shortcuts)
23. [Component Reference](#component-reference)
24. [Roadmap — Future Features](#roadmap--future-features)

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

Calculates short-circuit currents at every bus using the IEC 60909-0 method, including initial symmetrical (I"k), peak (ip), breaking (Ib), and steady-state (Ik) currents.

**Primary standard:** IEC 60909-0:2016 — *Short-circuit currents in three-phase a.c. systems — Part 0: Calculation of currents*

### Fault Types Calculated
| Type | Symbol | Formula | Reference |
|------|--------|---------|-----------|
| Three-phase | I"k3 | `c × Vn / (√3 × \|Z₁\|)` | IEC 60909-0 §8 |
| Single line-to-ground | I"k1 | `3c × Vn / (√3 × \|Z₁ + Z₂ + Z₀\|)` | IEC 60909-0 §9 |
| Line-to-line | I"kLL | `c × Vn / \|Z₁ + Z₂\|` | IEC 60909-0 §9 |
| Double line-to-ground | I"kE2E | `3c × Vn / (√3 × \|Z₁ + 2×Z₀\|)` (Z₁=Z₂) | IEC 60909-0 §9 |

### How It Works
1. Click **Fault Analysis** in the toolbar
2. The system validates the network (checks for buses, sources, connectivity)
3. If validation passes, fault currents are computed at each bus
4. Results appear as orange annotation badges on the diagram

### Per-Unit System

All impedances are converted to per-unit on a common MVA base before computation.

```
Base impedance:   Z_base = V² / S_base          (Ω)
Base current:     I_base = S_base / (√3 × Vn)   (kA)
```

Where `S_base` is the system base MVA (default 100 MVA) and `Vn` is the nominal bus voltage (kV).

### IEC 60909 Voltage Factor c

Per IEC 60909-0 Table 1:

| Voltage Level | c_max | c_min |
|---------------|-------|-------|
| Low voltage (≤ 1 kV) | 1.05 | 0.95 |
| Medium voltage (1–35 kV) | 1.10 | 1.00 |
| High voltage (> 35 kV) | 1.10 | 1.00 |

### Component Impedance Formulas

#### Utility (Grid) Source
Per IEC 60909-0 §6.2 — impedance derived from declared fault level:
```
Z_pu = S_base / S_fault
X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
R_pu = X_pu / (X/R)
```

#### Generator
Per IEC 60909-0 §6.6 — sub-transient reactance on system base:
```
X"d_pu = X"d(rated) × S_base / S_rated
R_pu   = X"d_pu / (X/R)
```

#### Transformer
Per IEC 60909-0 §6.3.3 — with correction factor K_T:
```
Z_pu = (Z% / 100) × S_base / S_rated
X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
R_pu = X_pu / (X/R)

K_T  = 0.95 × c_max / (1 + 0.6 × x_T)
```
Where `x_T` is transformer reactance p.u. on its own rating. The corrected impedance is `Z × K_T`.

#### Cable / Feeder
Per IEC 60909-0 §6.4:
```
Z_base = V² / S_base                          (Ω)
R_pu   = (R_per_km × Length) / Z_base / n
X_pu   = (X_per_km × Length) / Z_base / n
```
Where `n` is the number of parallel cables.

#### Induction Motor
Per IEC 60909-0 §13.2 — sub-transient reactance:
```
S_motor = P_rated / η                     (input MVA)
X"_pu   = X"(rated) × S_base / S_motor
R_pu    = X"_pu / (X/R)
```

#### Synchronous Motor
Per IEC 60909-0 §13.1 — treated identically to a synchronous generator:
```
X"d_pu = X"d(rated) × S_base / S_rated
R_pu   = X"d_pu / (X/R)
```

#### Solar PV Inverter
Per IEC TR 60909-4 — current-limited inverter source:
```
Z_pv = V_rated / (fault_contribution × I_rated)   in p.u. on system base
```
Typical fault contribution factor: 1.0–1.5 × rated current.

### Time-Varying Fault Currents

#### Peak Current ip (IEC 60909-0 §8.1)
```
ip = κ × √2 × I"k3

κ  = 1.02 + 0.98 × e^(−3 × R/X)
```
Where R/X is derived from the equivalent impedance at the fault point per Method C (Eq. 56).

#### Symmetrical Breaking Current Ib (IEC 60909-0 §9.1)
For near-to-generator faults, decay factor μ is applied per source:
```
Ib = Σ(μ × I"k_path)
```
Factor μ depends on I"kG/IrG ratio and minimum breaking time t_min (Eq. 70):

| t_min | μ formula |
|-------|-----------|
| 0.02 s | μ = 0.84 + 0.26 × e^(−0.26 × I"kG/IrG) |
| 0.05 s | μ = 0.71 + 0.51 × e^(−0.30 × I"kG/IrG) |
| 0.10 s | μ = 0.62 + 0.72 × e^(−0.32 × I"kG/IrG) |
| ≥ 0.25 s | μ = 0.56 + 0.94 × e^(−0.38 × I"kG/IrG) |

For induction motors (§13.2): Ib = μ × q × I"k, where q is the motor decay factor.
For far-from-generator (utility) sources: μ = 1 (no decay).

#### Asymmetric Breaking Current (IEC 60909-0 §9.1.3)
```
Ib_asym = √(Ib² + i_DC²)
i_DC    = √2 × I"k × e^(−t_min / τ)
τ       = X / (2πfR)
```

#### Steady-State Current Ik (IEC 60909-0 §10)
- Network-fed faults: Ik ≈ I"k (no decay)
- Generator contributions: Uses synchronous reactance Xd
- Induction motor contributions: 0 (current decays to zero within ~200 ms)

### Fault Short-Circuit Power
```
S"k = √3 × Vn × I"k     (MVA)
```

### Zero-Sequence Impedance (Z₀) Model
Per IEC 60909-0 §8, for SLG and DLG faults:
- Z₁ = Z₂ = Z_eq (positive = negative sequence for static equipment)
- **Dyn / YNd**: Far-side delta provides Z₀ circulation path → Z₀_xfmr = Z_t(leakage) + 3×Z_n(grounding)
- **YNyn**: Z₀ passes through — continues to next grounded source
- **Yyn / Dd**: No Z₀ path (ungrounded star or delta on bus side)

### Motor Contribution (IEC 60909-0 §13)
- Induction motors: sub-transient current decays to zero within ~200 ms
- Synchronous motors: sustained contribution (treated like generators)
- Branch contributions computed via current divider: I_branch = c / |Z_path|

### Voltage Depression During Fault (IEC 60909 §3.6)
Retained voltage at non-faulted buses computed via Zbus matrix:
```
V_j = 1 − Z_jk / Z_kk
```
Where Z_jk is the mutual impedance and Z_kk is the driving-point impedance at the faulted bus k.

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

**Standards:** IEC 60038 (Standard voltages), IEC 61000-3-2 (Power quality)

### Methods
- **Newton-Raphson** (default) — Fast quadratic convergence, max 100 iterations, tolerance 1×10⁻⁶
- **Gauss-Seidel** — Simpler iterative method, same convergence criteria

### Bus Types
| Type | Description | Specified | Solved |
|------|-------------|-----------|--------|
| PQ | Load bus (default) | P, Q | V, δ |
| PV | Generator bus | P, \|V\| | Q, δ |
| Swing | Slack/reference bus | \|V\|, δ | P, Q |

### Power Flow Equations

The Newton-Raphson method solves the nonlinear power balance equations at each bus:

```
P_i = |V_i| × Σ |V_j| × (G_ij × cos(δ_i − δ_j) + B_ij × sin(δ_i − δ_j))
Q_i = |V_i| × Σ |V_j| × (G_ij × sin(δ_i − δ_j) − B_ij × cos(δ_i − δ_j))
```

Where G_ij + jB_ij are elements of the bus admittance matrix Y_bus.

The Jacobian matrix is formed and the system `[J] × [Δδ, ΔV]ᵀ = [ΔP, ΔQ]ᵀ` is solved iteratively until the mismatch vector falls below tolerance.

### Y-Bus (Admittance Matrix) Construction

Branch admittances are computed from component impedances and added to Y-bus:

```
For series element between bus i and j:
  y = 1 / Z_branch
  Y[i,i] += y    Y[j,j] += y
  Y[i,j] -= y    Y[j,i] -= y
```

#### Transformer Pi-Model (off-nominal tap ratio)
For a transformer with turns ratio `t` and tap on bus i:
```
Y[i,i] += y / t²
Y[j,j] += y
Y[i,j] -= y / t
Y[j,i] -= y / t
```
Off-nominal turns ratio: `t = (V_HV_rated / V_LV_rated) × (1 + tap%) / (V_bus_HV / V_bus_LV)`

### Branch Impedance Formulas

#### Transformer
```
Z_pu = (Z% / 100) × S_base / S_rated
X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
R_pu = X_pu / (X/R)
```

#### Cable / Feeder
```
Z_base = V² / S_base
R_pu   = (R_per_km × Length) / Z_base / n
X_pu   = (X_per_km × Length) / Z_base / n
```

### Power Injection Models

#### Utility Source
Modelled as shunt admittance at the connected bus:
```
Y_source = S_fault / V² = 1 / Z_source     (in p.u.)
```

#### Generator
Active and reactive power injection:
```
P_inj = S_rated × PF / S_base              (p.u.)
Q_inj = S_rated × √(1 − PF²) / S_base     (p.u.)
```

#### Static Load
Constant power consumption:
```
P_load = S_rated × PF / S_base
Q_load = S_rated × √(1 − PF²) / S_base
```

#### Induction / Synchronous Motor
```
S_input = P_rated / (η × PF)
P_load  = S_input × PF / S_base
Q_load  = S_input × √(1 − PF²) / S_base
```

#### Solar PV
```
S_total = P_rated × N_inv × Irradiance% / (η_inv × 1000)
P_inj   = S_total × |PF| / S_base
Q_inj   = S_total × √(1 − PF²) / S_base
```

#### Wind Turbine
```
S_total = S_rated × N_turb × WindSpeed%
P_inj   = S_total × |PF| / S_base
Q_inj   = S_total × √(1 − PF²) / S_base
```

#### Capacitor Bank
Pure reactive power injection:
```
Q_inj = Q_rated / S_base                   (p.u.)
```

### Results Formulas

**Bus results:**
```
V       = |V_pu| × V_nominal               (kV)
S       = √(P² + Q²)                       (MVA)
PF      = |P| / S
I       = S / (√3 × V)                     (A)
```

**Branch results:**
```
S_flow   = √(P_flow² + Q_flow²)            (MVA)
I_branch = S_flow / (√3 × V)               (A)
Loading  = (I_branch / I_rated) × 100       (%)
```

### Transparent Elements
Circuit breakers, switches, fuses, CTs, PTs, and surge arresters in the closed state are treated as transparent (zero impedance) connections. Open CBs and switches break the circuit.

---

## Arc Flash Analysis (IEEE 1584)

Calculates arc flash incident energy, arc flash boundary, and PPE requirements at every bus.

**Primary standards:**
- IEEE 1584-2018 — *Guide for Performing Arc-Flash Hazard Calculations*
- NFPA 70E-2021 — *Standard for Electrical Safety in the Workplace*

### Valid Ranges (IEEE 1584-2018 §4.2)
- Voltage: 208 V to 15,000 V (3-phase)
- Frequency: 50/60 Hz
- Bolted fault current: 500 A to 106,000 A
- Gap between conductors: 6.35 mm to 76.2 mm
- Working distance: ≥ 305 mm
- Fault clearing time: up to 2 seconds

### Electrode Configurations

The electrode configuration describes the physical arrangement of conductors (electrodes) inside electrical equipment. It is a key parameter from IEEE 1584-2018 that affects how the arc behaves and how much energy is directed toward a worker. Each configuration uses different coefficients from IEEE 1584-2018 Tables 1 and 3 to calculate arcing current and incident energy.

| Config | Full Name | Description |
|--------|-----------|-------------|
| **VCB** | Vertical conductors in a Cubic Box | Conductors are vertical inside an enclosure (e.g., switchgear, MCCs). The box concentrates arc energy outward toward the worker. This is the default and most common scenario. |
| **VCBB** | Vertical conductors terminated in a Barrier in a Box | Same as VCB but with an insulating barrier behind the electrodes, redirecting even more energy toward the opening. Typically the worst-case configuration. |
| **HCB** | Horizontal conductors in a Cubic Box | Conductors are horizontal inside an enclosure. Common in panelboards and some switchboards. |
| **VOA** | Vertical conductors in Open Air | Conductors are vertical with no enclosure. Arc energy dissipates freely in all directions, resulting in lower incident energy. |
| **HOA** | Horizontal conductors in Open Air | Conductors are horizontal with no enclosure. Also lower energy due to no focusing effect. |

**Enclosed vs. open-air:** Enclosed configurations (VCB, VCBB, HCB) concentrate arc energy toward the equipment opening where a worker stands, producing higher incident energy. Open-air configurations (VOA, HOA) allow energy to disperse in all directions, reducing the incident energy at the worker's position. Where practical, switching from an enclosed to an open-air configuration can be an effective arc flash mitigation strategy.

### Arcing Current (IEEE 1584-2002 Eq. 1–2)

**Low voltage (V < 1 kV):**
```
log(Ia) = K + 0.662×log(Ibf) + 0.0966×V + 0.000526×G
          + 0.5588×V×log(Ibf) − 0.00304×G×log(Ibf)
```
Where K = −0.153 (open air) or −0.097 (enclosed).

**Medium voltage (V ≥ 1 kV):**
```
log(Ia) = 0.00402 + 0.983×log(Ibf)
```

Where Ia = arcing current (kA), Ibf = bolted fault current (kA), V = voltage (kV), G = conductor gap (mm).

**Reduced arcing current variation** (IEEE 1584-2002 §5.5):
- LV: Ia_reduced = 0.85 × Ia
- MV: Ia_reduced = 0.90 × Ia

### Incident Energy (IEEE 1584-2002 Eq. 3–5)

**Normalised incident energy at 610 mm, 0.2 s:**
```
log(En) = K1 + K2 + 1.081×log(Ia) + 0.0011×G
```
Where K1 = −0.792 (open air) or −0.555 (enclosed); K2 = 0 (ungrounded) or −0.113 (grounded).

**Scaled to actual time and distance:**
```
E = 4.184 × Cf × En × (t / 0.2) × (610 / D)^x
```
Where:
- Cf = 1.0 for V < 1 kV, 1.5 for V ≥ 1 kV
- D = working distance (mm)
- x = distance exponent: 2.0 (open air/MV enclosed), 1.641 (LV enclosed)
- Result converted: cal/cm² = E / 4.184

### Arc Flash Boundary (IEEE 1584-2018)

The distance where incident energy equals 1.2 cal/cm² (NFPA 70E threshold), computed by iterative bisection:
```
Find D such that E(D) = 1.2 cal/cm²
Search range: 300 mm to 50,000 mm
```

### PPE Categories (NFPA 70E Table 130.7(C)(15)(a))

| Incident Energy (cal/cm²) | Category | Required PPE |
|---------------------------|----------|--------------|
| < 1.2 | 0 | No PPE required |
| 1.2 – 4.0 | 1 | Arc-rated shirt, pants, safety glasses |
| 4.0 – 8.0 | 2 | Arc-rated shirt, pants, flash suit hood, hard hat |
| 8.0 – 25.0 | 3 | Arc flash suit, hard hat, balaclava |
| 25.0 – 40.0 | 4 | Multi-layer arc flash suit |
| > 40.0 | DANGER | Do not work energized |

### Clearing Time Estimation
The fault clearing time is estimated from protection devices connected to each bus:
- Circuit breakers: based on instantaneous/long-time settings
- Fuses: ~0.02 s for high fault currents
- Relays: TDS × 0.1 + 0.08 s (relay operating time + CB time)
- Maximum: 2.0 s (per IEEE 1584)

---

## Cable Sizing (IEC 60364)

Validates cable selections against thermal, voltage drop, and fault withstand requirements.

**Primary standard:** IEC 60364-5-52 — *Electrical installations of buildings — Selection and erection of electrical equipment — Wiring systems*

### Thermal Check (Current-Carrying Capacity)

```
Derated_A = Rated_A × DF_install × DF_temp
Loading%  = (I_actual / Derated_A) × 100
```

**Temperature derating factor** (IEC 60364-5-52 Table B.52.14/15):
```
DF_temp = √[(T_max − T_ambient) / (T_max − 30)]
```
Where T_max = 90°C (XLPE) or 70°C (PVC).

**Installation method derating factors:**
| Method | Factor |
|--------|--------|
| Trefoil | 1.00 |
| Flat touching | 0.95 |
| Buried direct | 0.85 |

### Voltage Drop (3-Phase)

Per IEC 60364-5-52 §G.525:
```
V_phase = V_kv × 1000 / √3
V_drop  = I × L × (R_km × cos(φ) + X_km × sin(φ))
VD%     = (V_drop / V_phase) × 100
```
Default limit: 5% maximum voltage drop.

### Fault Withstand — Adiabatic I²t Method

Per IEC 60364-5-54 §543.1:
```
S_min = (I_fault × √t) / k
```
Where k is the adiabatic withstand constant (A√s/mm²):

| Conductor | Insulation | k |
|-----------|-----------|---|
| Copper | XLPE | 143 |
| Aluminium | XLPE | 94 |
| Copper | PVC | 115 |
| Aluminium | PVC | 76 |

Check: cable size S_cable ≥ S_min.

### Conductor Resistivity
- Copper: ρ = 0.0175 Ω·mm²/m
- Aluminium: ρ = 0.0282 Ω·mm²/m

---

## Equipment Duty Check

Verifies that protection device ratings exceed prospective fault currents at their installed locations.

**Standards:** IEC 62271 (HV switchgear), IEC 60947 (LV switchgear)

### Interrupting Capacity Check
```
I_prospective ≤ I_breaking_capacity
Utilisation% = (I_prospective / I_breaking) × 100
```
- **PASS**: utilisation ≤ 80%
- **WARN**: utilisation 80–100%
- **FAIL**: utilisation > 100%

### Making Capacity Check (IEC 62271)
```
I_making = 2.2 × I_breaking
I_peak   = κ × √2 × I"k
```
Check: I_peak ≤ I_making.

### Additional Checks
- **Continuous current**: I_load ≤ I_rated
- **Voltage rating**: V_system ≤ V_rated

---

## Grounding System Analysis (IEEE 80)

Evaluates substation grounding grid safety per IEEE 80-2013.

**Primary standard:** IEEE 80-2013 — *Guide for Safety in AC Substation Grounding*

### Grid Resistance — Schwarz/Simplified Method
```
R_g = ρ × [1/L_T + 1/√(20A) × (1 + 1/(1 + h×√(20/A)))]
```
Where A = grid area (m²), L_T = total conductor length (m), h = burial depth (m), ρ = soil resistivity (Ω·m).

### Ground Potential Rise (GPR)
```
GPR = I_G × R_g                            (V)
```
Where I_G = maximum ground fault current (A).

### Surface Layer Derating Factor (Crushed Rock)
```
C_s = 1 − 0.09 × (1 − ρ/ρ_s) / (2h_s + 0.09)
```
Where ρ_s = surface layer resistivity (Ω·m), h_s = surface layer depth (m).

### Tolerable Touch and Step Voltages (IEEE 80 §8.3)

**For 70 kg person:**
```
E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.157 / √t_s     (V)
E_step  = (1000 + 6.0 × C_s × ρ_s) × 0.157 / √t_s     (V)
```

**For 50 kg person:**
```
E_touch = (1000 + 1.5 × C_s × ρ_s) × 0.116 / √t_s     (V)
E_step  = (1000 + 6.0 × C_s × ρ_s) × 0.116 / √t_s     (V)
```
Where t_s = fault clearing time (s).

### Mesh (Touch) Voltage
```
E_m = ρ × I_G × K_m × K_i / L_M           (V)
```

### Step Voltage
```
E_s = ρ × I_G × K_s × K_i / L_S           (V)
```

### Geometric Spacing Factors
```
K_m = (1/2π) × [ln(D²/(16hd) + ...) + K_ii/K_h × ln(8/(π(2n−1)))]
K_s = (1/π) × [1/(2h) + 1/(D+h) + 1/D × (1 − 0.5^(n−2))]
K_i = 0.644 + 0.148 × n       (irregularity factor)
```
Where D = conductor spacing (m), d = conductor diameter (m), n = number of parallel conductors.

### Conductor Sizing — Onderdonk Equation (IEEE 80 Eq. 37)
```
A_mm² = I × √t_c × √[α_r × ρ_r / (TCAP × ln(1 + (T_m − T_a)/(K_0 + T_a)))]
```

| Material | K₀ (°C) | T_m (°C) | TCAP (J/cm³·°C) |
|----------|---------|----------|------------------|
| Copper (annealed) | 234 | 1083 | 3.422 |
| Steel (galvanised) | 293 | 419 | 3.846 |

### Safety Criteria
- E_mesh ≤ E_touch (tolerable) → **PASS**
- E_step_actual ≤ E_step (tolerable) → **PASS**
- GPR ≤ E_touch → no hazard exists

---

## Load Diversity Analysis

Applies demand and diversity factors per IEC 61439/60364 to determine realistic loading of distribution equipment.

**Standards:** IEC 61439 (Low-voltage switchgear), IEC 60364 (Electrical installations), IEC 60439-1 Annex H

### Load Demand Calculation
```
Demand_kVA = Installed_kVA × Demand_Factor
```
For motors:
```
kVA = kW / (η × PF)
```

### IEC Demand Factors by Load Category

| Category | Demand Factor |
|----------|--------------|
| Lighting / Heating | 1.0 |
| Single motor | 1.0 |
| Motor group (2–4) | 0.8 |
| Motor group (5–10) | 0.6 |
| Motor group (> 10) | 0.5 |
| Socket outlets | 0.4 |
| Welding equipment | 0.3 |
| Mixed commercial | 0.7 |
| Mixed industrial | 0.6 |

### Diversity Factor (IEC 60439-1 Annex H)

Interpolated from the following table based on the number of loads at each bus:

| Number of loads | Diversity Factor |
|----------------|-----------------|
| 1 | 1.00 |
| 2 | 0.90 |
| 3 | 0.86 |
| 5 | 0.78 |
| 10 | 0.70 |
| 20 | 0.60 |
| 50 | 0.52 |

### Diversified Demand
```
Diversified_kVA = Σ(Demand_kVA) × Diversity_Factor
DF_effective    = Diversified_kVA / Installed_kVA
```

### Demand Current (3-Phase)
```
I_demand = Diversified_kVA / (√3 × V_kV)   (A)
```

### Transformer Loading
```
Loading_installed% = (Installed_kVA / Rated_kVA) × 100
Loading_demand%    = (Diversified_kVA / Rated_kVA) × 100
```

---

## Motor Starting Analysis

Performs static motor starting simulation to evaluate voltage dip impact across the network.

### Full Load Current
```
FLC = P_rated / (√3 × V_kV × η × PF)      (A)
```

### Starting Current
```
I_start = FLC × LRC
```
Where LRC = locked rotor current multiplier (typically 5–7× rated).

### Starting Apparent Power
```
S_start = √3 × V_kV × I_start / 1000      (MVA)
```

### Voltage Dip Calculation
The motor is modelled as a locked-rotor impedance during starting (at approximately 0.3 power factor). A load flow is re-solved with the motor represented as its starting MVA load:
```
Dip% = [(V_pre − V_start) / V_pre] × 100
```

### Acceptance Criteria
| Location | Maximum Dip |
|----------|-------------|
| Motor terminal | V ≥ 0.80 p.u. (sufficient torque) |
| System buses | ≤ 15% dip |
| Sensitive (PQ) buses | ≤ 10% dip |

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

**Standards:** IEC 60255-151 (IDMT relay curves), IEEE C37.112 (Inverse-time characteristics), IEC 60269 (Fuses)

### Opening the TCC Chart
Click the **TCC** button in the toolbar. The chart automatically loads all 50/51 overcurrent relays and fuses from the current SLD.

### Chart Features
- **Log-log axes**: Current (1A–100kA) on the X axis, time (1ms–1000s) on the Y axis
- **IDMT relay curves**: IEC 60255 and IEEE C37.112 curve families
- **Fuse curves**: IEC 60269 gG fuse pre-arcing time-current characteristics (16A–630A)
- **Interactive tooltip**: Hover over the chart to see trip times for all visible devices at any current level
- **Device visibility**: Toggle individual device curves on/off in the device list

### IDMT Relay Curve Formulas (IEC 60255-151)

The operating time for IDMT relays is:
```
t = TDS × k / ((I/Ip)^α − 1)
```
Where TDS = time dial setting, I = fault current, Ip = pickup current (A).

| Curve Type | k | α | Standard |
|-----------|---|---|----------|
| Standard Inverse (SI) | 0.14 | 0.02 | IEC 60255 |
| Very Inverse (VI) | 13.5 | 1.0 | IEC 60255 |
| Extremely Inverse (EI) | 80.0 | 2.0 | IEC 60255 |
| Long Time Inverse (LTI) | 120.0 | 1.0 | IEC 60255 |
| Moderately Inverse | 0.0515 | 0.02 | IEEE C37.112 |
| Very Inverse | 19.61 | 2.0 | IEEE C37.112 |
| Extremely Inverse | 28.2 | 2.0 | IEEE C37.112 |

### Fuse Time-Current Characteristics (IEC 60269)

gG fuse pre-arcing times are based on manufacturer data per IEC 60269-1. Standard ratings from 16A to 630A are included with interpolated log-log curves.

### Coordination Grading Margin

The automatic coordination check verifies that upstream devices operate slower than downstream devices by at least the grading margin:
```
Margin = t_upstream − t_downstream ≥ Grading_Margin
```
Default grading margin: 0.3 s. Tested at fault current levels from 500 A to 20 kA.

### Adding Custom Devices
Use the side panel to add devices not on the SLD:
- **Relay**: Select curve type, set pickup current (A) and time dial setting (TDS)
- **Fuse**: Select a standard gG fuse rating (16A–630A)

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
