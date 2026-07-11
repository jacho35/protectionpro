# powerprojectsindia.com — Survey for ETAP-comparable worked examples

Surveyed the full post sitemap (70 posts) on 2026-07-11 to find articles suitable for the same
hand-calc-vs-ProtectionPro verification treatment as the short-circuit article.

## Key finding
Only **one** article on the site presents the full **hand-calculation + ETAP one-line result screenshots**
cross-check — the short-circuit article already verified (`../README.md`). No other article shows ETAP
result screenshots alongside its numbers. The rest split into hand-calc-only worked examples, theory notes,
and client case-study reports.

## Tier 1 — worked examples that map to a ProtectionPro engine (verifiable; hand-calc target, no ETAP screenshots)
| Article | Maps to | Inputs (from images) | Notes |
|---|---|---|---|
| [short-circuit-calculation-symmetrical-and-asymmetrical-fault-current](https://powerprojectsindia.com/short-circuit-calculation-symmetrical-and-asymmetrical-fault-current/) | `fault.py` | Grid1 15242.047 MVAsc, Bus1 220 kV, T1 **10 MVA 220/33 kV, 8.35 %Z, Dyn1**, fault at Bus2 (33 kV); all 4 fault types | **Best next candidate** — a *second, different* network (220/33 kV) that extends fault-engine coverage. Same "actual" + "×1.1" convention (e.g. LLG = 2.0658 kA / 2.27245 kA). Hand-calc only. |
| [cable-sizing-calculation-low-voltage](https://powerprojectsindia.com/cable-sizing-calculation-low-voltage/) | `cable_sizing.py` (IEC 60364) | 90 kW / 415 V motor, η 0.9, PF 0.85; 95 mm² Cu XLPE, 120 m, buried 75 cm | Ampacity 196.23 A (k₁=0.93), VD 2.36 % run / 8.75 % start, SC withstand min 28.3 mm² (K=143, 40 kA, 0.1 s). Would be the **first check of the cable-sizing engine**. |
| [manual-calculation-to-find-out-sequence-impedance](https://powerprojectsindia.com/manual-calculation-to-find-out-sequence-impedance/) | `fault.py` (Z1/Z2/Z0) | sequence-impedance worked example | Validates the sequence-impedance building blocks the fault engine relies on. |

## Tier 2 — worked example, but no matching ProtectionPro engine
| Article | Why not | 
|---|---|
| [capacitor-bank-sizing-calculation](https://powerprojectsindia.com/capacitor-bank-sizing-calculation/) | 250 kW, PF 0.8→0.95 → 87.65 kVAR. ProtectionPro has a capacitor *component* but no PF-correction sizing analysis. |

## Tier 3 — theory / methodology only (no worked numbers)
`arc-flash` (IEEE 1584 overview), `dc-arc-flash` (Stokes-Oppenlander formula tables), `two-winding-transformer-loading`,
`vrla-battery-sizing-calculation-for-ups`, `grounding-study-report-guide`, `finding-out-different-earthing-system-by-using-zero-sequence-xr`,
`insulation-coordination`, `electrical-characteristics-of-transmission-lines`, `transmission-line-modeling`, etc.

## Tier 4 — client case-study reports (ETAP used, but NOT reproducible tutorials)
`load-flow-short-circuit-study-for-50-mw-grid-connected-solar-power-plant`, `load-flow-short-circuit-study-hospitality-facility-dammam`,
`power-system-studies-for-485mw-combined-cycle-gas-turbine-power-plant`, `power-system-studies-project-for-50mwac-risha-solar-power-plant`,
`arc-flash-study-for-schaeffler-india-limited`, `arc-flash-study-at-denso-india-private-limited-chennai-plant`, `grid-compliance-study-*`,
`short-circuit-and-relay-coordination-study-*`, `relay-coordination-protection-study-*`. These describe real projects; no clean input data to reproduce.

## Recommendation
1. **short-circuit example #2 (220/33 kV)** — highest value; re-exercises the (now verified) fault engine on a distinct topology.
2. **LV cable sizing** — opens verification of a *new* engine (`cable_sizing.py`).
Both compare against the author's IEC hand-calculations rather than ETAP screenshots, so the bar is "matches the
published hand calc" rather than "matches ETAP output."
