# Motor Starting (Voltage Dip) — Results

**Method:** standards-anchored verification (as with grounding / arc flash — no freely-available worked example
publishes a full motor-starting result; toolgrit, the CED "Introduction to Motor Starting Analysis" course, and
IEEE 3002.7 give methodology only). The closed-form outputs are checked against hand calculations; the voltage
dip is checked against an **independent exact solve of the engine's own model** (constant-PQ, 2-bus) and then
characterized against the two standard textbook methods.

## Case
Strong utility (swing, 1.0 pu) → cable representing the system source impedance Z = 0.166 + j1.658 pu
(|Z| = 1.667 pu ⇒ **S_sc ≈ 60 MVA**, X/R = 10) → motor bus (6.6 kV) → **1500 kW induction motor**
(η = 0.95, PF = 0.9, LRC = 6.0, DOL). Base 100 MVA. Model: [`project.json`](project.json).

## Closed-form outputs (exact)
| Quantity | Hand-calc | App | Diff |
|---|---|---|---|
| Full-load current | 153.47 A | 153.5 A | 0.00 % |
| Starting current (DOL) | 920.8 A | 920.8 A | 0.00 % |
| Starting MVA | 10.526 MVA | — | — |

### Starting-method factors (I_start = FLC × LRC × factor; VFD → FLC)
| Method | Factor | Expected | App | Diff |
|---|---|---|---|---|
| Direct-on-Line | 1.0 | 920.8 A | 920.8 A | 0.00 % |
| Star-Delta | 1/3 | 306.9 A | 306.9 A | 0.00 % |
| Autotransformer (80 %) | 0.64 | 589.3 A | 589.3 A | 0.00 % |
| Soft Starter | 0.5 | 460.4 A | 460.4 A | 0.00 % |
| VFD | — (≈ FLC) | 153.5 A | 153.5 A | 0.00 % |

## Voltage dip (engine's constant-PQ model — exact)
The engine substitutes the starting motor as a constant-PQ load (S_start at 0.3 PF) and re-runs the
(independently-verified Newton-Raphson) load flow. Solving that exact 2-bus equation by hand
(`x² − x + (y² + P·R + Q·X) = 0`, upper root) reproduces the engine:

| Quantity | Independent solve | App | Diff |
|---|---|---|---|
| Baseline terminal V | 0.9841 pu | 0.9841 pu | — |
| Starting terminal V | 0.7783 pu | 0.7782 pu | −0.01 % |
| Max voltage dip (vs baseline) | 20.92 % | 20.92 % | 0.00 % |
| Motor will start (≥ 0.8 pu) | No | No | — |

## Model characterization vs textbook methods
The engine models the locked rotor as **constant-PQ** (the code notes this is intentionally, slightly
conservative vs a true constant-impedance rotor). For this **weak** system (S_start/S_sc ≈ 0.18):

| Method | Terminal V |
|---|---|
| Engine (constant-PQ, exact NR) | 0.778 |
| Constant-Z voltage divider `V = Z_m/(Z_s+Z_m)` | 0.853 |
| SC-MVA ratio `V = S_sc/(S_sc+S_start)` | 0.851 |

Constant-PQ gives a **deeper dip** because at the depressed voltage it draws more current (I = S/V) than a
fixed impedance — the gap widens near the "nose" of the PV curve. For a **moderate** system (S_sc ≈ 300 MVA,
same motor) the three methods converge:

| Method | Terminal V (moderate system) |
|---|---|
| Engine (constant-PQ) | 0.9644 |
| Constant-Z divider | 0.9668 |
| SC-MVA ratio | 0.9661 |

→ within ~0.2 %. So the modeling choice matters only for weak systems / large dips, where the engine is the
**conservative** (safe) choice.

## Screenshot (real app)
![motor starting result](screenshots/motor-starting-result.png)

Shows Start Current 921 A (DOL), Terminal V 0.778 pu, Will Start **NO**, Max Dip 20.9 % — matching.

## Verdict
ProtectionPro's motor-starting engine computes full-load current, starting current for all five starting
methods, and starting MVA **exactly**, and its voltage-dip calculation **exactly** reproduces an independent
solve of its constant-PQ load-flow model (0.01 %). The constant-PQ rotor model agrees with the classic
constant-Z voltage divider and SC-MVA-ratio methods for normal dips and is deliberately conservative for weak
systems.
