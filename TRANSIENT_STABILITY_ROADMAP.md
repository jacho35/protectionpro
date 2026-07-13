# Transient Stability — Engine Status & Roadmap

Status of the classical time-domain rotor-angle engine
(`backend/analysis/transient_stability.py`) and what remains. Last updated
2026-07-13 (after the IBR-dynamics work).

## Implemented

Classical multi-machine swing model: constant-voltage-behind-X′d machines,
Kron reduction to machine internal nodes, RK4 integration, initial conditions
from the positive-sequence load flow, synchronism judged per **electrical
island** against that island's own centre of inertia.

- **Turbine-governor** (per generator: isochronous / droop / none) — mechanical
  power follows speed, so an islanded genset's frequency recovers instead of
  drifting. Droop + reset (isochronous returns to nominal; droop settles at an
  offset). Capacity limit with anti-windup.
- **AVR / exciter** (per generator, on/off) — regulates terminal voltage back to
  its pre-fault value; field ceiling with anti-windup.
- **Two-axis (flux-decay) machine model** — opt-in per generator. d/q transient
  EMFs E′q/E′d decay via T′do/T′qo; AVR drives the field voltage E_fd. Equal
  transient reactances X′q = X′d keep the network reduction unchanged. Classical
  results are byte-identical when not selected.
- **Dynamic loads** — voltage-dependent models (constant power / current /
  impedance / ZIP) via the `load_type` field. Constant power can drive voltage
  collapse.
- **Dynamic induction motors** — single-cage slip model (reuses the motor-
  starting nameplate fit); motors slow and can stall on a voltage dip. Network
  re-reduced each step when any dynamic device is present; otherwise the
  classical precomputed-reduction fast path (results unchanged).
- **Inverter-based resources (IBR)** — opt-in per source (`ibr_ctrl`; default
  frozen ⇒ byte-identical). **Grid-forming (GFM)**: a virtual synchronous machine
  (voltage behind the coupling reactance) with synthetic inertia and P-f droop
  in the swing, AVR voltage control, and an in-step virtual-impedance current
  limiter (bounds fault current at I_max on the first cycle); can hold an island
  with no rotating machine. **Grid-following (GFL)**: a current-source bus
  injection holding dispatched P with fast frequency response, reactive-priority
  voltage support on a dip, a hard current limit, and voltage/frequency ride-
  through trips. Peak converter current is reported per GFM.
- **Protection tripping** — under-frequency load shedding (UFLS), generator
  over-/under-frequency and under-voltage trips, load/motor under-voltage
  (contactor) trips. Definite-time relays; trip events reported.
- **Disturbances** — bolted 3-φ bus fault (optional branch trip on clearing,
  binary-search critical clearing time), generator/branch trip, load step.
- Supporting: stale-result detection (results stamped with app version; an
  out-of-date result is flagged and excluded from reports), per-field "default"
  flags, mobile launchers for the study.

## Remaining — worth doing (rough priority)

1. **Detailed governor/turbine & exciter models.** Currently first-order lags.
   Add standard turbine-governor models (diesel DEGOV/GAST, steam TGOV1, hydro
   with water-starting time / transient droop — hydro's non-minimum-phase water-
   hammer behaviour is not captured) and IEEE exciter models (AC/ST types), plus
   a **power system stabiliser (PSS)**.
2. **Unbalanced dynamic faults.** Only balanced 3-φ faults in the time domain;
   SLG / LL / LLG would need the sequence networks carried through the swing.
3. **Sub-transient dynamics** (d/q″: X″d/X″q, T″do/T″qo). Refinement over the
   two-axis model for the first few cycles.
4. **More protection functions.** ROCOF (df/dt) tripping, out-of-step / loss-of-
   synchronism relays, over-current / distance, generator over-excitation;
   auto-reclosing. IBR ROCOF/vector-shift anti-islanding is a natural extension
   of the ride-through trips now modelled.

## Lower value / out of scope

- **Machine saturation** of Xd/Xq.
- **Variable-step / implicit integrator** for stiff cases (fixed-step RK4 is
  adequate at the current dt).
- **EMT (electromagnetic transients).** Deliberately out of scope — this is an
  RMS / phasor stability tool, not an EMT solver.
- **Broader validation benchmarks** (e.g. an IEEE test-system two-machine
  anchor). Good for confidence, not a feature; the equal-area CCT anchor and the
  per-model regression tests already pin the engine.

## Assessment

For islanded-genset / campus sites (e.g. Bouchard Findlayson) the engine is
already more than sufficient — governor + AVR + dynamic loads/motors + UFLS
cover the questions those studies ask. With **IBR dynamics** now in place
(grid-following + grid-forming converters with current limiting and fast
frequency / synthetic-inertia response), modern PV-plus-battery sites are
covered too. The remaining items are refinements (detailed OEM governor/exciter
models, unbalanced dynamic faults, sub-transient d/q″) rather than capability
gaps.
