# Transient Stability — Engine Status & Roadmap

Status of the classical time-domain rotor-angle engine
(`backend/analysis/transient_stability.py`) and what remains. Last updated
2026-07-31 (after the standard governor/exciter/PSS work; next up = unbalanced
dynamic faults).

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
- **Standard governor/turbine, exciter & PSS block models** — opt-in per
  generator (`gov_model`/`exc_model`/`pss_on`; default `first_order` for both
  selectors and PSS off ⇒ byte-identical). Standard-**shaped** reduced-order
  approximations (qualitative OEM step-response character), not certified
  vendor parameter sets; `gov_mode` (isochronous/droop/none — integral reset)
  stays orthogonal to `gov_model` (turbine-dynamics shape) — the droop+reset
  target is simply the reference fed into whichever model is selected.
  - **Turbine-governor**: DEGOV1 (diesel — actuator lag + transport dead-time,
    1st-order Padé realization), GAST (gas — fuel-valve lag + turbine lag,
    fuel capped by a simplified constant limit), TGOV1 (steam — governor lag +
    reheat lead-lag), HYGOV (hydro — temporary-droop dashpot + gate-servo lag
    feeding the water column, `ΔPm/Δgate=(1−sTw)/(1+0.5sTw)`, the textbook
    non-minimum-phase "dips before it rises" signature). Architecture: a
    generic 3-slot per-machine extra-state array (`gx`) + a per-model dispatch
    function, rather than one named state per model — keeps `deriv()`'s
    signature from growing per model.
  - **Exciter**: SEXS (Vt filtered by a lead-lag before the existing Ka/Ta
    error/lag), ST1 (fast static exciter — Vt measurement lag, error lead-lag,
    its own output lag), AC (adds self-excitation Ke + an exponential core-
    saturation term that softens the ceiling, plus a Kf/Tf rate-feedback minor
    loop) — same generic-array pattern (`ex`), Ef stays a single true
    integrated state for every model.
  - **PSS**: washout + two lead-lag stages on Δω (IEEE PSS1A shape, generic
    array `pssx`), output Vs summed into the active exciter's voltage-error
    input; requires AVR on.
  - **Calibration finding**: PSS lead-lag defaults are deliberately mild (2:1
    per stage, not the 10:1 textbook-scale ratio) — verified empirically that
    a 10:1 compounded ratio destabilised the SMIB regression case at every
    gain tested (overshoots into destabilising phase near a typical ~1 Hz
    local mode), while 2:1 damped it cleanly at every gain tested. Real PSS
    tuning compensates the phase at the specific machine's mode; this default
    does not attempt that, so it favours safety over aggressive damping.
  - **HYGOV's isochronous sensitivity**: an isochronous integral reset wrapped
    around a non-minimum-phase plant is a textbook hard-to-damp combination —
    verified empirically across a wide (temporary droop %, dashpot reset time,
    gate servo time, inertia, step size, single/paralleled machines) grid that
    nothing cleanly converges within a bounded window on an aggressive
    small/fast island. The temporary-droop dashpot is required (removing it
    is worse — diverges over a longer horizon even where a short window looks
    fine) but doesn't fully tame it. This mirrors real hydro-governor
    practice (droop mode + site-specific tuning); the regression suite tests
    the water-hammer physics (the model's defining, correctly-verified
    behaviour) without claiming universally-stable default isochronous
    tuning. Documented in the engine docstring and the HYGOV test.
  - +19 tests (per-model equilibrium unit tests for governors and exciters,
    isochronous-recovers smoke tests, DEGOV1 delay / HYGOV water-hammer-dip
    shape tests, AC saturation, PSS damping); 71 transient-stability tests
    pass. (`transient_stability.py`, `constants.js`, `properties.js`,
    `test_transient_stability.py`)

## Next up — unbalanced dynamic faults

Only balanced 3-φ faults are modelled in the time domain; SLG / LL / LLG would
need the sequence networks carried through the swing (reuse `fault.py`'s
sequence impedances; apply the sequence interconnection at the faulted bus
each step). The biggest genuine *capability* gap for a protection-focused
tool — SLG is the dominant real fault.

## Remaining — worth doing (rough priority)

1. **Sub-transient dynamics** (d/q″: X″d/X″q, T″do/T″qo). Refinement over the
   two-axis model for the first few cycles; X″q ≠ X″d breaks the single-voltage-
   behind-X′d simplification, so it needs a saliency treatment in the reduction.
2. **More protection functions.** ROCOF (df/dt) tripping, out-of-step / loss-of-
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
covered too. With **standard governor/exciter/PSS block models** now in place,
the engine can also reproduce OEM-matchable step responses (diesel dead-time,
hydro water-hammer, steam reheat lag) and has its first *oscillation-damping*
capability.

The designated **next** function is **unbalanced dynamic faults** (see
*Next up*) — the remaining genuine capability gap for a protection-focused
tool; the rest are accuracy refinements.
