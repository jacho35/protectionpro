# Unbalanced Load Flow (Symmetrical Components) — Results

**Method:** the engine iterates the three sequence networks to a consistent solution: phase voltages from the
latest V0/V1/V2 → each constant-power load's phase currents at those voltages → I0/I1/I2 → Y2·V2 = I2, Y0·V0 = I0,
and the loads' positive-sequence power V1·conj(I1) fed back into the Newton-Raphson positive-sequence solve, until the
sequence voltages stop moving. It then reports `[Va,Vb,Vc] = A·[V0,V1,V2]` and VUF = |V2|/|V1|.

**Independent reference (2026-09-28):** the same feeder solved directly in the **phase domain**. The line's phase
impedance matrix is Zabc = A·diag(Z0, Z1, Z1)·A⁻¹, the source an ideal balanced 1 p.u. (the engine's swing), and the
load's phase currents are iterated to V_B = V_A + Zabc·I(V_B). There are no sequence networks and no Newton-Raphson, so
it shares no code with the engine. Engine and reference agree to every reported digit.

**Correction:** before 2026-09-28 the engine solved the sequences in a single pass, with load currents taken at phase
voltages *assumed balanced*. On this case it reported VUF 0.7618 % and Va 0.96146 pu. The phase-domain solve gives
**0.8045 %** and **0.95967 pu**: the old answer understated the unbalance by ~5 % and was optimistic on the loaded
phase. The earlier "V1 equals the balanced load flow exactly" check was a symptom of the flaw: with unbalanced
constant-power loads, V1 is *not* the balanced result. The case, template and EXPECTED values were updated.

## Case
Utility (11 kV swing) → line (Z1 = 0.5+j1.0, Z0 = 1.5+j3.0 Ω/km) → load bus → 2000 kVA / 0.9 PF static load.

## Balanced-limit check (phase split 33.33 / 33.33 / 33.34)
| Quantity | Result |
|---|---|
| Va, Vb, Vc | 0.98508 / 0.98507 / 0.98506 pu (equal) |
| V2, V0 | 2×10⁻⁶, 6×10⁻⁶ (≈ 0) |
| VUF | 0.0002 % (≈ 0) ✅ |

→ the sequence machinery correctly collapses to the balanced solution when the load is balanced.

## Unbalanced case (phase split 60 / 20 / 20)
| Quantity | Engine | Phase-domain reference |
|---|---|---|
| Va | 0.95967 | 0.959671 |
| Vb | 1.00541 | 1.005410 |
| Vc | 0.98975 | 0.989750 |
| VUF | 0.8045 % | 0.8045 % |

| Check | Result |
|---|---|
| Phase voltages vs independent phase-domain solve | **exact** (all three phases, 6 d.p.) |
| VUF = \|V2\|/\|V1\| vs reference | **0.8045 % = 0.8045 %** |
| Same case at a 1 MVA base (solver tolerance 1 W instead of 100 W) | identical — the model, not the tolerance, sets the answer |

Regression: `backend/tests/test_unbalanced_lf_sequence_iteration.py` pins the same phase-domain reference for a
1-phase, a line-to-line and an uneven 3-phase load on a 0.4 kV feeder.

## Screenshot (real app — on-canvas per-phase badges)
![unbalanced load flow](screenshots/unbalanced-canvas.png)

*(Screenshot predates the 2026-09-28 correction; it shows the old single-pass values VUF 0.76 %, Va 0.9615.)*

## Verdict
The unbalanced load flow is verified against an **independent phase-domain solution**: all three phase voltages and the
VUF agree exactly, and it collapses to the balanced solution when the load is balanced. It remains a sequence-based
engine: a full IEEE 13-bus feeder (voltage regulators, single-phase laterals, distributed loads) is outside its model
and was not attempted.
