# Survey — ETAP "Validation Cases and Comparison Results" PDF

**Source:** https://etap.com/docs/default-source/validation-case-documents/etap_comparisonresults.pdf
(68 pages, © Operation Technology Inc. Local copy analysed 2026-07-11.)

## Key conclusion
This is a **comparison-results summary**, not a set of reproducible worked examples. Each case shows ETAP
output next to a reference and a % difference — but the **network input data (impedances, ratings, line
constants) is NOT in the document**; it is cited to an external textbook / standard / program. The embedded
one-line figures print **results** (bus voltages, MW/Mvar, fault kA), not legible input impedances.
**Consequence: these cases cannot be rebuilt in ProtectionPro from the PDF alone** — each needs its cited
source document.

## Case-by-case map to ProtectionPro

| PDF case | ProtectionPro engine | Input source cited | Reproducible from PDF? |
|---|---|---|---|
| Load Flow #1 | `loadflow.py` | Dhar, *Computer Aided Power System Operation & Analysis*, p89 | ❌ inputs in textbook |
| Load Flow #2 | `loadflow.py` | published example (textbook) | ❌ |
| Load Flow #3 | `loadflow.py` | published textbook example | ❌ |
| Short-Circuit ANSI #1 | `fault.py` (⚠ ANSI, app is IEC) | application-engineering info | ❌ + method mismatch |
| Short-Circuit ANSI #2 (unbalanced) | `fault.py` | Anderson, *Faulted Power System Analysis* (1973) pp38-40 | ❌ + method mismatch |
| Short-Circuit ANSI #3 (3-φ duty) | `fault.py` (⚠ ANSI) | IEEE Std 399-1997 (Brown Book) §7.7 pp187-205 | ❌ + method mismatch |
| **Short-Circuit IEC #1** | `fault.py` (IEC 60909) ✅ | **IEC 60909-4:2000 Example 4** | ❌ inputs in the IEC standard |
| **Arc Flash #1** | `arcflash.py` (IEEE 1584-2002) ✅ | Matlab program + "typical" gaps/X-factors | ❌ inputs not tabulated |
| **Arc Flash #2** | `arcflash.py` ✅ | IEEE Std 1584-2002 pp4-13 (worked example) | ⚠ maybe, if the 1584 example is obtained |
| Motor Acceleration #1 | `motor_starting.py` (partial) | hand calc (torque control) | ❌ + scope (full accel vs start) |
| Motor Acceleration #2 | `motor_starting.py` (partial) | transient stability | ❌ + scope |
| **Unbalanced Load Flow #1** | `unbalanced_loadflow.py` ✅ | **IEEE 13-bus test feeder (public)** | ✅ data public — but heavy & scope risk |
| Harmonic Analysis #1 | — (not implemented) | IEEE Std 519-1992 Example 13.1 | ❌ no engine |
| Transient Stability #1–#5 | — (not implemented) | field data / IEEJ / PSS-E / 9-bus benchmark | ❌ no engine |

## What's actually verifiable, and how
1. **IEEE 13-bus feeder (Unbalanced LF #1)** — the only case whose inputs are freely public
   (IEEE PES test-feeder data). Maps to `unbalanced_loadflow.py`. **Caveat:** it's an unbalanced distribution
   feeder with voltage regulators, single-phase laterals, distributed loads and shunt capacitors — features
   ProtectionPro may not fully model. High build effort; match not guaranteed.
2. **Cases needing a source document** — SC IEC #1 (IEC 60909-4 Ex 4), Arc Flash #2 (IEEE 1584 example),
   Load Flow #1–#3 (textbooks). Fully reproducible **if** the cited source (with its input tables) is provided.
3. **Not applicable** — ANSI short-circuit (app is IEC 60909, different method), Harmonics and Transient
   Stability (no engine in ProtectionPro).

## Recommendation
Prefer **self-contained worked examples** (like the powerprojectsindia set) for direct verification. For this
PDF, the practical routes are: (a) attempt the public IEEE 13-bus unbalanced-LF case with clear scope caveats,
or (b) obtain one or more cited source documents so the network can be rebuilt faithfully.
