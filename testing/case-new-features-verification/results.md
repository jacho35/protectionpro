# New-Feature Engine Verification — Results

**Date:** 2026-07-25
**Scope:** independent first-principles / standards-anchored verification of the twelve analysis
engines added since the last calculation-verification cycle (frequency scan, filter sizing,
reliability, voltage stability, hosting capacity, CT saturation, battery sizing, capacitor
placement, OPF, contingency, EE-10 two-port reduction, flicker).

**Harness:** [`verify_new_features.py`](verify_new_features.py) — builds a minimal network per engine
whose answer follows from a textbook identity or a standards formula (computed by hand in the
harness, **not** by reusing the engine's own arithmetic), runs the engine inside the production
backend image, and compares. Raw run in [`output.txt`](output.txt); structured data in
[`results.json`](results.json).

## How to run

```bash
# from the repo root
docker run --rm -v "$PWD":/work -w /work -e PYTHONPATH=/work \
  protectionpro-backend \
  python testing/case-new-features-verification/verify_new_features.py
```

Baseline regression suite was also run clean beforehand: **495 passed**.

## Result: 21/21 independent checks pass

| Engine | Ground truth | Predicted | Engine | Error | Tol |
|---|---|---|---|---|---|
| Frequency Scan | parallel resonance `h_r=√(S_sc/Q_c)` (250 MVA / 10 MVAr) | 5.000 | 5.000 | 0.00% | 3% |
| Filter Sizing | designed L-C resonates at tuning order `1/(2π√LC)/f₀` | 4.700 | 4.70010 | 0.002% | 0.5% |
| Reliability | SAIFI `=Σλ` radial FMEA (IEEE 1366) | 1.1040 | 1.1040 | 0.00% | 1% |
| Reliability | SAIDI `=Σλr` | 4.6320 | 4.6320 | 0.00% | 1% |
| Reliability | CAIDI `=SAIDI/SAIFI` | 4.1957 | 4.196 | 0.008% | 1% |
| Voltage Stability | λ_critical, Kundur nose `P_max=Vs²/2X` | 1.8906 | 1.8881 | 0.13% | 4% |
| Voltage Stability | nose voltage `V=Vs/√2` | 0.7071 | 0.7111 | 0.57% | 6% |
| Hosting Capacity | exact 2-bus voltage rise `P=V(V_max−V_s)/R` | 6.3525 MW | 6.3525 MW | 0.00% | 4% |
| CT Saturation | knee `V_k=0.8·ALF·I_sn·(Rct+Rb)` (IEC 61869-2) | 72.0 V | 72.0 V | 0.00% | 0.5% |
| CT Saturation | saturation current `I_sat=0.8·ALF·I_prim` | 6400 A | 6400 A | 0.00% | 0.5% |
| CT Saturation | rms clip `η=√((θ−½sin2θ)/π)` @ ks=0.5 | 9051 A | 9051 A | 0.00% | 0.5% |
| Battery Sizing | IEEE 485 energy method | 156.75 kWh | 156.75 kWh | 0.002% | 0.5% |
| Capacitor Placement | full-VAR loss drop `Q²/(P²+Q²)` | 0.360 | 0.379 | 5.3% | 12% |
| OPF | cheap generator committed by merit order | true | true | ✓ | — |
| OPF | optimized cost < baseline ($1200→$160/h) | true | true | ✓ | — |
| Contingency | radial feed flagged not N-1 secure | false | false | ✓ | — |
| Contingency | MW lost on feeder outage | 4.00 MW | 4.00 MW | 0.00% | 5% |
| EE-10 Two-Port | Kron reduction == explicit per-element model | 0.910694 | 0.910694 | 0.00% | 0.1% |
| Flicker | `Pst=(d/3)·r^0.31` at anchor | 1.0000 | 1.0000 | 0.00% | 0.5% |
| Flicker | linear in step size (d=6%) | 2.0000 | 2.0000 | 0.00% | 0.5% |
| Flicker | rate roll-off (r=10/min) | 2.0417 | 2.0417 | 0.00% | 0.5% |

Closed-form identities land at machine precision. The handful with looser tolerances are gated by an
iterative solver (voltage-stability continuation), a bisection search (hosting capacity), or a
discrete step size + constant-susceptance bank model (capacitor placement) — all well inside their
physics-justified allowance.

### Note on two references

- **Hosting capacity:** the crude linear estimate `ΔV≈P·R` gives 6.05 MW and disagrees with the
  engine by 5%. The *exact* 2-bus balance (unity-pf injection, negligible X ⇒ angle→0) is
  `P = V·(V_max−V_s)/R = 6.3525 MW`, which the engine's sweep-then-bisect matches to 0.00%. The
  engine is exact; the linear hand-estimate was the approximation.
- **Capacitor placement:** the 5.3% residual is expected and correct — banks are modelled as
  constant susceptance (Q∝V², so injected VAr rises as the bus recovers) and compensation is placed
  in discrete 250 kvar units, so the realized loss reduction slightly exceeds the ideal
  `Q²/(P²+Q²)` fixed-VAr figure.

## Finding: OPF-1 (source-only island dispatch) — FIXED 2026-07-25

Verification surfaced one genuine defect; it has since been fixed (see `BACKLOG.md` Completed).

**As found:** in a network with **no utility and two generators** (both defaulting to `standby`), OPF
re-ranked `dispatch_priority` by cost correctly, but the load-flow islanded dispatcher then subtracted
the balancer generator's *full rating* from the residual before dispatching the merit units. Under
cost-ranked priority the balancer is the most-expensive committed unit, so the cheap `merit_order` unit
was stranded at 0 MW and the dear unit balanced the whole load. OPF shipped a solution **costlier than
the input**, with no warning:

```
BEFORE FIX
baseline  $190/h   (cheap gen balances, 9.5 MW × $20)
optimized $855/h   (dear gen balances,  9.5 MW × $90)   ← 4.5× worse
```

**Fix:** the balancer fill-first guard in `loadflow.py` now applies only to standby-origin units, so a
genuine `merit_order` unit loads ahead of the (most-expensive) balancer; plus an OPF safety net that
reverts Stage-1 re-dispatch if it fails to beat baseline. After the fix:

```
AFTER FIX
baseline  $190/h
optimized $190/h   (cheap gen dispatched 9.5 MW, dear gen balancer 0.0 MW)   ✓ optimal
```

The grid-tied single-swing case (verified above, $1200→$160/h) was always correct and is unchanged.
Reproduce with [`opf_island_probe.py`](opf_island_probe.py); regression pinned by
`backend/tests/test_regression.py::TestOptimalPowerFlow::test_islanded_two_generators_merit_order`.
Full Docker suite: **496 pass**.
