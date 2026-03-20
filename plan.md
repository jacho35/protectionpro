# Voltage Depression During Faults — Implementation Plan

## Overview
Add voltage sag/depression calculation during faults per IEC 60909, with time-varying voltage profile (sub-transient → transient → steady-state) and post-fault motor reacceleration recovery. Display as color-coded SLD overlay + results table.

## IEC 60909 Voltage Depression Theory

**Retained voltage at bus j during fault at bus k:**
```
V_j = V_pre × (1 - Z_jk / Z_kk)
```
Where:
- Z_jk = transfer impedance (off-diagonal of Zbus matrix)
- Z_kk = driving-point impedance at faulted bus (diagonal of Zbus)
- V_pre = pre-fault voltage (c × V_n / √3)

**Time-varying voltage uses different impedance matrices:**
- Sub-transient (0 to ~5 cycles): Generators use Xd'', motors use X''
- Transient (~5 cycles to ~0.5s): Generators use Xd', motors decay out
- Steady-state (>0.5s): Generators use Xd, motors fully decayed

**Motor reacceleration (post-clearing):**
- Motors decelerate during fault (reduced voltage → reduced torque)
- After clearing, draw high reacceleration current (approaching LRA)
- V_recovery(t) = V_pre - Z_network × Σ I_motor_reaccel(t)
- I_reaccel decays exponentially as motors recover speed

## Implementation Steps

### Step 1: Build Zbus Matrix (backend/analysis/fault.py)

Add `_build_zbus_matrix(buses, components, wires, base_mva, impedance_mode)` function:

1. Number all buses (create bus index map: bus_id → integer index)
2. Build Ybus (admittance matrix) from branch impedances:
   - For each transformer/cable between bus i and bus j: Y_ij = -1/Z_branch, Y_ii += 1/Z_branch
   - For each source at bus i: Y_ii += 1/Z_source
   - For each motor at bus i: Y_ii += 1/Z_motor (sub-transient mode only)
3. `impedance_mode` parameter selects which impedance to use:
   - `"subtransient"`: Xd'' for generators, X'' for motors
   - `"transient"`: Xd' for generators, motors removed (decayed)
   - `"steadystate"`: Xd for generators, motors removed
4. Invert Ybus → Zbus using numpy (already available for loadflow)
5. Return Zbus matrix + bus index map

### Step 2: Calculate Voltage Depression (backend/analysis/fault.py)

Add to `run_fault_analysis()` after existing calculations:

For each faulted bus k:
1. Get Z_kk from Zbus diagonal
2. For each other bus j: `V_j_retained = 1.0 - Z_jk / Z_kk` (in p.u.)
3. Compute for all three time periods (sub-transient, transient, steady-state)
4. Store as `voltage_depression` dict in FaultResultBus:
   ```python
   voltage_depression = {
       bus_id: {
           "subtransient_pu": 0.72,
           "transient_pu": 0.68,
           "steadystate_pu": 0.65,
           "retained_kv": 7.92,
       }
   }
   ```
5. At the faulted bus itself: V = 0 (bolted fault) or V = Z_f × I_f for impedance faults

### Step 3: Motor Reacceleration Voltage Recovery (backend/analysis/fault.py)

Add `_calc_motor_reacceleration(buses, motors, z_network, clearing_time)`:

1. During fault: motors decelerate, speed drops based on inertia (H constant) and voltage
2. Post-clearing voltage recovery profile:
   - t=0 (clearing): V_initial = V_pre - Z_net × Σ(I_motor_start)
   - Motors modeled as decaying current sources: I(t) = I_LRA × e^(-t/τ)
   - τ depends on motor inertia and load torque
3. Generate time-series: [t_ms, V_pu] pairs for 0 to ~5 seconds post-clearing
4. Simple exponential recovery model per IEC 62271-110 guidance

### Step 4: Update Schemas (backend/models/schemas.py)

Add to FaultResultBus:
```python
# Voltage depression at this bus during fault at each other bus
voltage_depression: Optional[dict] = None
# {faulted_bus_id: {subtransient_pu, transient_pu, steadystate_pu, retained_kv}}

# Voltage at THIS bus when IT is faulted (should be ~0 for bolted)
v_fault_pu: Optional[float] = None

# Time-varying voltage profile at this bus (for the selected fault bus)
voltage_profile: Optional[list] = None
# [{t_ms: float, v_pu: float, period: str}]

# Motor reacceleration recovery curve (post-clearing)
motor_recovery_profile: Optional[list] = None
# [{t_ms: float, v_pu: float}]
```

### Step 5: Frontend — Voltage Depression Overlay (frontend/js/canvas.js)

When fault results contain `voltage_depression` data and a specific bus is faulted:
1. Color-code all buses by retained voltage:
   - Green (>80%): normal
   - Yellow (50-80%): moderate sag
   - Orange (30-50%): severe sag
   - Red (<30%): near-collapse
2. Show retained voltage percentage on each bus badge
3. Highlight the faulted bus in red with "FAULT" label

### Step 6: Frontend — Voltage Depression Table (frontend/js/app.js)

Add voltage depression results panel/modal:
- Table: Bus | Rated kV | Sub-transient V | Transient V | Steady-state V | Recovery Time
- Sortable by retained voltage
- Motor recovery curve chart (simple SVG line chart or integrate with existing charting)

### Step 7: Frontend — Annotations Update (frontend/js/annotations.js)

Update fault badge to show:
- Existing fault currents
- NEW: Retained voltage during fault (e.g., "V: 72% (7.92 kV)")
- Color the voltage line based on severity

## File Changes

| File | Changes |
|------|---------|
| `backend/analysis/fault.py` | Add Zbus builder, voltage depression calc, motor reacceleration |
| `backend/models/schemas.py` | Add voltage depression fields to FaultResultBus |
| `frontend/js/canvas.js` | Add bus color-coding overlay for voltage depression |
| `frontend/js/annotations.js` | Update fault badge with retained voltage |
| `frontend/js/app.js` | Add voltage depression table/modal display |
| `frontend/css/symbols.css` | Add voltage depression color classes |
| `frontend/index.html` | Add voltage depression results panel |

## Dependencies
- numpy (already used in loadflow for matrix operations)
- Existing fault analysis must run first (voltage depression is a post-processing step)
