# Survey — Tinghir 225/60/11 kV substation ETAP power-flow paper

**Source:** Sabur et al., "ETAP software based power flow analysis of 225/60/11 kV substation in Tinghir,"
*E3S Web of Conferences* **582**, 01003 (2024). https://doi.org/10.1051/e3sconf/202458201003
(open-access PDF, 16 pp; ResearchGate copy is behind a 403 — used the e3s-conferences.org original.)

## What it is
A real-substation case study. Despite the title, the load-flow analysis is on the substation's **auxiliary-
services (AS) installation** — 380 Vac LV distribution plus 127 Vdc / 48 Vdc battery systems — not the
225/60 kV transmission side. Two scenarios: (1) AS fed by the auxiliary service transformer (AST/TSA),
(2) AS fed by the 70 kW backup generator. Both AC (Newton-Raphson) and DC load flow are run in ETAP.
The paper presents **ETAP results only** — there is no independent reference (hand-calc or other software) to
validate against; "verification" here would mean rebuilding the model in ProtectionPro and comparing to the
paper's ETAP output.

## Maps to ProtectionPro
- **AC load flow** → `loadflow.py` (Newton-Raphson). ✅ engine fits
- **DC load flow** → `dc_loadflow.py`. ✅ engine fits

## Reproducibility: PARTIAL — key inputs missing
| Data needed | In the paper? |
|---|---|
| Topology (buses, connections) | ⚠ only in the Fig. 4 / Fig. 6 one-line images (dense, mostly legible) |
| Equipment ratings (200 MVAsc grids, 70/70/70 MVA 3-w transformers, 160 kVA TSA, 70 kW genset) | ✅ on the one-line |
| AC load P/Q/PF (Table 11: 4 loads, e.g. non-priority 8.49 kW/5.26 kvar, priority 5.38/2.61) | ✅ |
| DC loads (99 W, 4 kW, 2.2 kW, 1.28 kW) | ✅ (Fig. 6) |
| **Transmission line lengths / charging (225 & 60 kV)** | ❌ not given — yet this dominates the AC reactive result (−90.8 kvar generated, "101 kvar losses") |
| **Transformer impedances (3-w, TSA), LV cable R/X, DC cable R** | ❌ not tabulated — only ratings shown |
| Results to match (bus V %, branch kW/kvar, losses) | ✅ Tables 9–16 |

**Consequence:** a faithful numeric match is **not possible from the paper alone** — the defining load-flow
inputs (branch impedances and line charging) are absent. What *is* reproducible is low-value: the system is
stiff so all bus voltages sit at ~99.5–100 % (ProtectionPro would trivially agree), and the ~45 kW aux
through-flow. The distinctive numbers (the −90.8 kvar / capacitive line charging, the 99.77 vs 99.88 % DC
bus-voltage spread, the 5–17 W DC losses) all hinge on impedance data the paper does not provide.

## Additional quirks
The AC result mixes the transmission line charging into a ~48 kW study (−90.8 kvar generation, chargers
flagged "overcharged"), so even the ETAP output is dominated by elements outside the stated AS scope.

## Verdict / recommendation
Like the ETAP V&V PDF, this is **not a controlled worked example with a complete dataset** — it's a real-
project ETAP case study missing the branch-impedance inputs a load-flow reproduction requires. Recommend
**not** attempting a rigorous reproduction. A rough voltage-profile / through-flow sanity check is possible but
would neither match the paper's headline figures nor meaningfully exercise `loadflow.py`. For load-flow
verification, a self-contained textbook example (full bus/line/transformer data + published solution) is the
better route.
