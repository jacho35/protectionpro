# Transient Stability — Engine Status & Roadmap

Status of the classical time-domain rotor-angle engine
(`backend/analysis/transient_stability.py`) and what remains. Last updated
2026-07-13 (after the IBR-dynamics work; next up = standard governor/exciter
models + PSS).

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

## Next up — standard governor/turbine, exciter & PSS models

The governor and AVR are today single first-order lags:

    dPm/dt = (Pm0 + Psec − Δω/(ω_s·R) − Pm)/Tg,   dPsec/dt = −Δω/(ω_s·R·Tr)
    dEf/dt = (Ka·(Vref − Vt) − (Ef − Ef0))/Ta,    Ef ∈ [Emin, Emax]

Good enough for "does it recover", but they cannot reproduce OEM step responses
(diesel dead-time, hydro's initial reverse power dip) nor **damp** an oscillation
— there is no power system stabiliser, so a lightly-damped electromechanical
swing rings for the whole window. This work adds standard block-diagram models
and a PSS.

**Scope / models** (per generator, opt-in via a model selector; the current
first-order lag stays the default so results are byte-identical when not
changed):

- **Turbine-governor** `gov_model ∈ {first_order, degov1, gast, tgov1, hygov}`:
  - *DEGOV1* (diesel) — electric actuator + engine transport dead-time; the
    right model for the genset sites that are the tool's core customers.
  - *GAST* (gas turbine) — fuel-valve lag + turbine + temperature limit.
  - *TGOV1* (steam) — governor lag + reheat lead-lag.
  - *HYGOV* (hydro) — water-starting time Tw with permanent/transient droop
    (Rp/Rt); Tw gives the **non-minimum-phase water-hammer** (power dips before
    it rises on a gate opening) the first-order lag cannot represent.
- **Exciter** `exc_model ∈ {first_order, sexs, st1, ac}` — transient-gain
  reduction (lead-lag Tb/Tc), a measurement lag Tr and a proper field-voltage
  ceiling; optional over-/under-excitation limiter later.
- **Power system stabiliser** `pss` (on/off) — a single-input (Δω or Pe) PSS:
  washout + two lead-lag stages + gain Kstab + output limits, its output Vs
  summed into the exciter voltage-error input. IEEE PSS1A shape.

**Approach (fits the existing framework).** Each selected model contributes a
few extra state variables; extend the RK4 state vector exactly as Pm/Psec/Ef/
E′q/E′d/slips are already threaded (gate the new states so an unselected model
adds nothing). Governor output → Pm; exciter output → Ef (the field voltage the
two-axis model already consumes, or |E′| for classical); PSS output → the
exciter summing junction. Anti-windup on every integrator/limit (the established
pattern). No change to the network reduction — this is all machine-local.

**New props** (per generator, shown when the model is selected, with FIELD_INFO
+ DEFAULT flags): the model selectors above plus each model's constants
(DEGOV T1–T3 + dead-time; HYGOV Tw/Rp/Rt; GAST/TGOV1 lags; exciter Tr/Tb/Tc/
ceiling; PSS Kstab/Tw_pss/T1–T4/Vs limits).

**Validation anchors:**
- *PSS damps the swing* — a lightly-damped SMIB (or two-machine) case rings
  with the PSS off and its rotor-angle oscillation envelope decays markedly
  faster (higher damping ratio) with it on.
- *Hydro water-hammer* — a gate/load step shows the characteristic initial
  power **dip** before the rise.
- *Backward-compatible* — the default (first-order) models reproduce today's
  governor/AVR trajectories byte-identically.
- Match a Kundur single-machine exciter+PSS textbook response.

## Remaining — worth doing (rough priority)

1. **Unbalanced dynamic faults.** Only balanced 3-φ faults in the time domain;
   SLG / LL / LLG would need the sequence networks carried through the swing
   (reuse `fault.py`'s sequence impedances; apply the sequence interconnection
   at the faulted bus each step). Biggest genuine *capability* gap for a
   protection-focused tool — SLG is the dominant real fault.
2. **Sub-transient dynamics** (d/q″: X″d/X″q, T″do/T″qo). Refinement over the
   two-axis model for the first few cycles; X″q ≠ X″d breaks the single-voltage-
   behind-X′d simplification, so it needs a saliency treatment in the reduction.
3. **More protection functions.** ROCOF (df/dt) tripping, out-of-step / loss-of-
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
covered too.

The designated **next** function is **standard governor/exciter models + a
PSS** (see *Next up*): it turns the first-order lags into OEM-matchable block
diagrams and — via the PSS — gives the engine its first *oscillation-damping*
capability, the one dynamic behaviour it currently cannot represent. After that,
**unbalanced dynamic faults** is the remaining genuine capability gap; the rest
are accuracy refinements.
