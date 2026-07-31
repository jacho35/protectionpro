# Transient Stability — Engine Status & Roadmap

Status of the classical time-domain rotor-angle engine
(`backend/analysis/transient_stability.py`) and what remains. Last updated
2026-07-31 (after sub-transient (d/q″) machine dynamics; next up = more
protection functions).

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
- **Unbalanced (SLG/LL/LLG) dynamic faults** — the `fault` disturbance gains a
  `fault_type` selector (`3phase` default | `slg` | `ll` | `llg`, byte-identical
  when omitted). Modelled the same way `fault.py`'s steady-state engine already
  does an unbalanced fault, rather than carrying three sequence networks
  through RK4: a positive-sequence **shunt fault impedance** `Zf` at the fault
  bus, built once at fault onset from the negative/zero-sequence Thevenin
  equivalents (`Zf = Z2+Z0` SLG, `Z2` LL, `Z2‖Z0` LLG — Anderson & Fouad /
  Kundur's standard compensation-network treatment), added to `_reduce()`'s
  diagonal exactly like a load shunt. The 3-phase case is untouched (still a
  bolted bus elimination via `grounded`, Zf=0). Z1/Z2/Z0 don't change mid-fault
  (topology only changes at clearing, same as the existing 3-phase case), so
  this needed no change to the RK4 loop itself, the dynamic re-reduction path,
  the CCT binary search, or any recorder/protection-trip code — all already
  generic over "whatever the current network variant is." New
  `fault.thevenin_sequence_at_bus()` (sibling to the existing
  `thevenin_z1_at_bus`) supplies Z1/Z2/Z0, sharing the same radial-exact /
  meshed-nodal-Zbus split ([PS-1]) `run_fault_analysis` already uses. A bus
  with no zero-sequence return path (ungrounded source, delta winding) needs no
  special-casing — Z0→∞ collapses SLG's Zf toward infinite (negligible fault)
  and LLG's `Z2‖Z0` toward `Z2` alone (LLG degenerates to a plain LL fault),
  both falling straight out of the formulas. +5 tests (`TestUnbalancedFault`):
  default-stays-3phase byte-identical, SLG/LL/LLG-less-severe-than-3phase CCT
  ordering plus the LLG<LL<SLG severity ordering among the unbalanced types,
  stable-below/unstable-above the SLG CCT, no-zero-sequence-path doesn't
  crash, and the faulted bus reporting a real finite voltage dip (rather than
  the 3-phase case's bus elimination) during an unbalanced fault. Full backend
  suite 672 pass. Frontend: `transient.js` gained a "Fault type" selector in
  the fault disturbance setup, threaded through save/load and the saved-case
  summary label. (`transient_stability.py`, `fault.py`, `transient.js`,
  `test_transient_stability.py`)
- **Sub-transient (d/q″) machine dynamics** — opt-in refinement on top of
  `two_axis` (`subtransient_on`, requires `machine_model: two_axis`). Real
  machines have `X″d ≠ X″q` (saliency), which breaks the two-axis model's
  equal-transient-reactance simplification that lets a machine sit in the
  network's Kron reduction as one isotropic complex impedance. Rather than
  reformulate that reduction (`Yred`, fixed per topology segment and relied on
  by the fast path / CCT search / dynamic re-reduction / GFM current limiter),
  sub-transient EMFs `E″q`/`E″d` are two more per-machine RK4 states that relax
  toward the existing `E′q`/`E′d` transient states:
  ```
  T″do·dE″q/dt = E′q − E″q − (X′d − X″d)·Id
  T″qo·dE″d/dt = −E″d + E′d + (X′q − X″q)·Iq
  ```
  and are converted to an equivalent "voltage behind X′d" EMF each step
  (`E′q_eff = E″q + (X′d−X″d)·Id`, `E′d_eff = E″d − (X′q−X″q)·Iq`) via a new
  closure `_eint_sub` — a short (`SUBTRANS_ITERS=3`) in-step Gauss-Seidel
  fixed-point loop (no `Yred` rebuild, a few extra matvecs), mirroring the
  existing GFM current-limiter's in-step iteration pattern. `_eint_sub` is a
  drop-in replacement for `_eint` at every live-EMF call site, short-circuiting
  to `_eint` with byte-identical numerics whenever no active machine has the
  feature on. Reuses the existing `xd_pp` prop (previously read only by the
  steady-state fault engine); adds `xq_pp` (defaults to `xd_pp`, round-rotor
  fallback), `tdo_pp`, `tqo_pp` (default 0.03 s, floored at 3·dt as an
  explicit-RK4 stability guard). Verified empirically that the saliency
  correction has a real, continuous, monotonic effect: sweeping `Xq″` from
  0.6×–1.4×`Xd″` at a fixed clearing time moved the first-swing peak rotor
  angle continuously (51.06°→51.68° in the SMIB fixture) — CCT itself proved
  too coarse a metric to assert this against directly (it can plateau across a
  parameter range near a marginal case even while the swing trajectory moves
  continuously). +5 tests (`TestSubTransient`): pre-fault-equilibrium no-drift,
  `subtransient_on: off` reproduces plain two-axis exactly, an AVR-on smoke
  test, the saliency-changes-the-swing check above, and an `Xd″ > X′d` clamp
  doesn't crash. Full backend suite 677 pass (81/81 in
  `test_transient_stability.py`). Frontend: `constants.js` gained a
  `Sub-transient Dynamics` toggle in the generator's Stability section (shown
  only under `machine_model: two_axis`) plus `Xq″`/`T″do`/`T″qo` fields (shown
  only when the toggle is on); `properties.js`'s conditional re-render trigger
  list gained `subtransient_on`. (`transient_stability.py`, `constants.js`,
  `properties.js`, `test_transient_stability.py`)

## Next up — more protection functions

1. **More protection functions.** ROCOF (df/dt) tripping, out-of-step / loss-of-
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
capability. With **unbalanced (SLG/LL/LLG) dynamic faults** now in place — SLG
being the dominant real-world fault type — the engine's remaining genuine
*capability* gap is closed. With **sub-transient (d/q″) machine dynamics** now
in place, the machine model's own accuracy refinements are done too; everything
left (see *Next up*) is additional protection functions, not a missing
fault/disturbance type or machine-model fidelity gap.
