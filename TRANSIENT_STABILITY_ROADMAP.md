# Transient Stability — Engine Status & Roadmap

Status of the classical time-domain rotor-angle engine
(`backend/analysis/transient_stability.py`) and what remains. Last updated
2026-08-01 (after the distance (21) relay — the protection-function set is
now complete; see *Assessment*).

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

- **ROCOF, over-excitation, out-of-step protection + auto-reclose** — the four
  protection functions that extend the existing timer-accumulate-then-trip
  relay pattern (`_check_protection`) without needing any new network
  machinery, plus dead-time auto-reclose (which turned out to need none
  either — it's one more precomputed segment on the existing branch
  open/close mechanism). Over-current/distance relay was deliberately left
  out of this change — see *Next up*.
  - **ROCOF (df/dt, ANSI 81R)** — applies to generators, GFM converters (both
    already `machines[]` entries with a swing angle) and GFL converters
    (current-source injections). All three already had frequency-based
    ride-through trips reading the same per-island centre-of-inertia (COI)
    frequency (`_island_freq`), so ROCOF reuses that same observable —
    a deliberate simplification vs. a per-bus PLL measurement, consistent
    with how UF/OF already work engine-wide. A short rolling window
    (`ROCOF_WINDOW_S = 0.1`, a `rocof_hist`/`_rocof_rates` closure in
    `_simulate`) reports `None` until a sample pair spans at least half the
    window, so there's no spurious rate on the first step(s). New fields
    `trip_rocof_hzs`/`ibr_rocof_hzs` (generator/GFM dual-name ternary,
    matching `trip_of_hz`/`ibr_of_hz`) and `ibr_rocof_hzs` on GFL (shared prop
    name with GFM, matching `ibr_uv_pu` etc.).
  - **Over-excitation / volts-per-hertz (V/Hz, ANSI 24)** — generator-only (a
    GFM's virtual EMF has no iron core to saturate): `trip_vhz_pu` compares
    `vhz_pu = v / (f / freq)` — the same lagged terminal voltage and local
    frequency the UV/UF checks already read — against the threshold. Reads as
    0 (disabled) for every other component type since only the generator's
    field list defines the prop, so no `is_gfm` branching was needed.
  - **Out-of-step / loss-of-synchronism (ANSI 78)** — a new **opt-in
    per-machine protective trip**, deliberately distinct from the engine's
    existing global first-swing `unstable`/`UNSTABLE_ANGLE` verdict (untouched
    — still a pure CCT/stability metric, never removes anything from the
    network). Applies to generators and GFM (both have a `delta[i]` swing
    state); not GFL (no rotor angle). `_check_protection`'s signature grew a
    `delta` parameter so it can compute the live island-COI angle separation
    (`refs(delta)`, the same closure the global verdict uses) each step. New
    fields `trip_oos_deg`/`ibr_oos_deg`. Verified empirically that a relay set
    well inside 180° trips the machine off before a full pole-slip — which can
    leave the global `stable` verdict `True` even on an above-CCT fault, since
    that verdict only judges *live* machines: exactly the point of the relay,
    not a contradiction.
  - **Auto-reclosing** — needed **no new runtime state or architecture**.
    Branch open/close was already only ever a *precomputed*
    `(t_switch, variant)` segment (`_build_segments`/`_build_sequence`), never
    a decision made from live relay state inside the RK4 loop — and a
    dead-time reclose is just another such segment at a time that's already
    known in advance (the trip time is fixed at build time, either
    `clear_time_s` on a `fault` disturbance's `trip_element` or a `sequence`
    step's own `t`). The `fault` disturbance gained `reclose_delay_s`
    (meaningful only alongside `trip_element`): when set, a third segment
    restores the ORIGINAL topology at `t_clear + reclose_delay_s`. A
    `sequence` `trip` step gained its own optional `reclose_delay_s`: a
    pre-pass synthesizes a companion `close` step at `t + reclose_delay_s` for
    any trip step whose element resolves to a branch/breaker (not a generator
    — trip-only per the existing feature scope — or a load), so the user
    doesn't have to hand-schedule a second step. The existing sequence
    execution loop needed no changes — it already handled `close` on a
    branch.
  - +10 tests (`TestProtection`: ROCOF trip + disabled, V/Hz trip + disabled,
    out-of-step trip + no-trip-when-stable; `TestSequencedEvents`: sequence
    auto-reclose matches a manual close, reclose ignored without a delay,
    fault auto-reclose, fault no-reclose without a delay). Full backend suite
    **694 pass** (91/91 in `test_transient_stability.py`). Frontend: `constants.js`
    gained `trip_rocof_hzs`/`trip_oos_deg`/
    `trip_vhz_pu` (generator) and `ibr_rocof_hzs`/`ibr_oos_deg` (every
    IBR-capable source, the latter gated to `grid_forming` only) plus
    tooltips; `transient.js` gained an Auto-reclose field on the fault form
    and a per-step reclose field on sequence `trip` rows, both round-tripped
    through save/load, the saved-case summary, and the timeline chart's event
    markers. (`transient_stability.py`, `constants.js`, `transient.js`,
    `test_transient_stability.py`)

- **Over-current (50/51/67) relay** — the genuinely-new-architecture piece
  deferred from the change above: per-branch current, and a mid-simulation
  topology-switch decided from LIVE relay state (not a precomputed segment).
  - **Per-branch current** (`network_reduction.py`): `build_branch_ybus`
    previously folded every series chain's `(bus_a, bus_b, y, t, hv_bus)`
    stamp straight into the dense bus Ybus and discarded it. Refactored the
    stamping into a shared 2×2-stamp computation so the SAME numbers are also
    retained in a new `branches` list (single source of truth — cannot drift
    from what's actually in Y), plus a new `branch_current(branch, v_a, v_b)`
    helper returning the complex current at each terminal, correctly referred
    through the chain's own turns ratio.
  - **Relay resolution** (`_collect_oc_relays`/`_relay_branch_terminal`): a
    50/51/67 relay with `trip_cb` set resolves its monitored branch via
    `associated_ct` — the SAME association arc-flash clearing-time evaluation
    and the frontend TCC already use — via a BFS through pass-through devices
    to the branch and which of its two real-bus endpoints sits on the CT's
    own side. A relay already set up for arc-flash/TCC coordination therefore
    carries valid transient-stability settings for free; no new data model.
  - **IDMT operate-time integral** (`_check_protection`): unlike the four
    fixed-delay relays above, an inverse-time curve's target operate time
    varies continuously with current, so this accumulates
    `Σ dt/t_operate(I(t))` each step (an induction-disk emulation, resetting
    to 0 below pickup) and trips at 1.0 — evaluated via
    `arcflash._relay_operate_time`, REUSED as-is (same curve table, same CT-
    saturation derating) rather than reimplementing curve math. 67 gets a
    simplified self-polarized directional check
    (`Re(V_near·conj(I_near)) ≥ 0` = forward), not the full RCA-rotated torque
    equation — documented as a deliberate simplification, adequate for a
    bolted/near-bolted fault's near-unity power factor.
  - **Live topology switching** (`_effective_variant`'s new
    `ybus_trip_cache`): `project` is now threaded into `_simulate` so a
    relay-tripped CB can lazily rebuild/cache `build_branch_ybus` keyed by
    `frozenset(segment's own removed ids ∪ tripped_branch)`, reusing
    `_build_sequence.ybus_for`'s existing memoization pattern — turned out
    NOT to need the two-pre-built-Ybus-variant scheme originally sketched
    below; each segment's `variant()` now just carries forward its own
    `removed` id set so a scripted trip and a live relay trip compose
    correctly. A no-op, byte-identical fast path whenever no relay has
    tripped yet.
  - **Adjacent bug found and fixed**: `Component._coerce_numeric_props`
    coerces a digit-only prop string to a number for any key not in
    `_TEXTUAL_PROP_KEYS` — `relay_type: "67"` silently became the int `67`,
    so `67 not in ("50/51", "67")` filtered out every directional-overcurrent
    relay (`arcflash._build_relay_maps` had the identical bug, pre-existing —
    fixed there too, same `str(relay_type)` guard). Full Docker suite
    re-verified green (702 pass) after both fixes.
  - +8 tests (`TestOvercurrentRelay`): trip on sustained overcurrent, no-trip
    below pickup, IDMT operate time matches the closed form, higher multiple
    trips faster, 67 blocks reverse / trips forward, a scripted sequence trip
    composing correctly with a live relay trip, unresolvable-CT skip.
    Full backend suite **702 pass** (694 baseline + 8 new).
    (`network_reduction.py`, `transient_stability.py`,
    `test_transient_stability.py`)

- **Distance (21) relay** — the last remaining protection function. Reuses
  the per-branch current infrastructure and live topology-switch mechanism
  the over-current relay above added, but evaluates a TRUE Z=V/I mho
  characteristic rather than porting the frontend TCC plot's current-only
  proxy (`buildDistanceRelayZones`/`distanceRelayTripTime`, constants.js —
  that model converts reach to an equivalent pickup current since it has no
  complex bus voltage to work with; this engine does, every step).
  - **Mho zone evaluator** (`_collect_distance_relays`): resolves each
    `relay_type: "21"` relay via the SAME `_relay_branch_terminal` BFS the
    over-current relay uses, converts `z1/z2/z3_reach_ohm` (the identical
    settings the TCC "Grade Distance Zones" modal already writes) to
    per-unit reach via `Z_base = kV²/MVA_base`, and builds each zone's
    self-polarized mho circle: diameter `0 → reach·∠mho_angle`
    (center = `reach·e^{jθ}/2`, radius = `reach/2`).
  - **Directionality falls out of the geometry**: a circle through the
    origin occupies only the half-plane within ±90° of θ
    (`|Z−C|≤r ⟺ |Z|² ≤ R·Re(Z·e^{−jθ})`, which forces
    `Re(Z·e^{−jθ})≥0`) — the directionality decision the frontend
    current-only model doesn't have to make, with no extra `direction` prop
    needed. Zone 3 can be aimed in reverse via `z3_reverse` (already a
    `constants.js` default with no prior consumer) for remote-backup /
    blocking schemes.
  - **Live evaluation** (`_check_protection`): each zone runs its own
    independent definite-time timer off the lagged complex bus
    voltage/branch current (`Z_seen = V_near/I_near`, `vbus_complex_prev`
    now populated whenever EITHER an overcurrent or a distance relay is
    present); trips `trip_cb` via the same `tripped_branch`/
    `ybus_trip_cache` mechanism, so it composes with scripted sequence trips
    and over-current relays with no new re-reduction machinery. A branch
    current below `MIN_RELAY_CURRENT_PU` is treated as unloaded/open rather
    than evaluating `V/~0`.
  - +6 tests (`TestDistanceRelay`, a feeder with a 0.2+j0.08 Ω/km cable — a
    bolted far-bus fault forces the apparent impedance to exactly the line
    impedance): Z1 trips close-in, no trip beyond every zone's reach, Z2
    trips after its own delay when beyond Z1, Z3 sees a forward fault, a
    reversed Z3 does NOT (the directionality proof), unresolvable-CT skip.
    Full backend suite **708 pass** (702 baseline + 6 new).
    (`transient_stability.py`, `test_transient_stability.py`)

## Lower value / out of scope

- **Machine saturation** of Xd/Xq.
- **Variable-step / implicit integrator** for stiff cases (fixed-step RK4 is
  adequate at the current dt).
- **EMT (electromagnetic transients).** Deliberately out of scope — this is an
  RMS / phasor stability tool, not an EMT solver.
- **Broader validation benchmarks** (e.g. an IEEE test-system two-machine
  anchor). Good for confidence, not a feature; the equal-area CCT anchor and the
  per-model regression tests already pin the engine.

## Independent engineering review — findings D1–D8 (fixed)

An independent EE / protection review re-derived the engine from first
principles rather than from its own tests. The **mathematical core came through
clean** and is now pinned by those derivations:

| Checked against | Result |
|---|---|
| 3-curve equal-area CCT (2-parallel-line SMIB, mid-line fault + line trip, star-delta by hand) | **+0.21 %** |
| Pre-fault rotor angle δ₀ = asin(Pm/Pmax) | 18.2400° vs 18.2408° |
| Two-axis init E′q = Vq + X′d·Id, E′d = Vd − X′q·Iq, Efd = E′q + (Xd−X′d)Id | exact to 6 dp |
| Sub-transient init E″q = E′q − (X′d−X″d)Id, E″d = E′d + (X′q−X″q)Iq | exact to 6 dp |
| Air-gap identity Vd·Id + Vq·Iq = P | exact |
| Null-disturbance equilibrium, 13 model combinations | 0.0000° drift |
| Droop steady state Δf = −R·ΔP/P_rated | 0.0005 Hz |
| HYGOV (1−sTw)/(1+0.5sTw) · DEGOV1 Padé · TGOV1 (1+sT2)/(1+sT3) | 2.8e-4 / 5.9e-4 / 1e-5 |
| Mho reach along a line at φ = \|R\|·cos(θ−φ) | boundary exact, 6/6 |
| IDMT t = TMS·0.14/(M^0.02−1), M = 21.5 | +0.19 % |
| Sequence shunts SLG→Z2+Z0, LL→Z2, LLG→Z2∥Z0 | correct |

The defects were all at the boundaries — unit bases, network bookkeeping, and
the protection idealisations a relay engineer asks about first. All eight are
fixed, each pinned by `backend/tests/test_review_fixes.py` (42 tests).

- **[D1] Distance reach used the relay's own `voltage_kv`**, which
  `constants.js` hard-defaults to 11 kV on every relay, so a 132 kV feeder was
  mis-scaled 144× and Zone 1 tripped on settings 43× short of the fault (the
  trip message's own ohms were wrong by the same factor). Now the **near bus's**
  nominal kV — the base `_collect_oc_relays` already used — with a warning when
  the relay prop disagrees by >10 % so the data and the TCC plot get corrected.
- **[D7] GAST's fuel/temperature limit was in machine p.u. but compared against
  a system-p.u. command**, so it never bound for a machine smaller than base
  MVA; GAST was also the only turbine model returning its output unclipped. A
  10 MVA set ran to **162 % of rating**. Limit now referred to the machine base
  and the output clipped like every other model.
- **[D6] Memory polarisation for the 21 and 67 elements.** Self-polarized, a
  bolted fault at the relay's own bus gives V = 0, where Z = V/I = 0 lies
  exactly ON a mho circle through the origin and Re(V·conj(I)) = 0 passes a
  `>= 0` sign-of-power test — both elements operated for a fault *behind* them.
  Below `MEMORY_POL_V_PU` the pre-fault phasor now polarises the decision, and
  the 67 uses the proper RCA-rotated torque equation rather than the old
  sign-of-power proxy. Reverse-looking Zone 3 still sees reverse faults.
- **[D4] Fault detector + ANSI 68 power-swing blocking on the 21.** The shipped
  12 Ω Zone 3 default tripped a healthy loaded 11 kV feeder at t = 0.8 s with no
  disturbance at all, and during a genuinely stable swing tripped the line and
  flipped the verdict to unstable. Zones are now armed only on a real
  disturbance (current > 1.25× or voltage < 0.9× pre-fault) and a zone entry is
  judged fault-like or swing-like **once, at entry** (transit from an outer
  characteristic at 1.5× the widest zone), so time-delayed zones still time out
  normally. A zone circle enclosing the pre-fault load impedance is warned.
  Settable per relay: `dist_fault_detect`, `dist_psb`, `psb_transit_s`.
- **[D5] Relays blocked during an unbalanced fault.** `branch_current` /
  `vbus_complex_prev` are positive-sequence; those are phase quantities only
  while the network is balanced. Measured against a 4.6× over-reaching Zone 1,
  an SLG fault read ≈1.78 Ω (Z_line + Z2 + Z0) and never tripped, while the
  50/51 saw I₁ where the faulted phase carries 3·I₁. Both elements now block —
  with an explanatory warning — for the duration of an SLG/LL/LLG segment and
  resume once the network is balanced. Reconstructing true phase quantities from
  the sequence networks is the follow-on.
- **[D2] A load on a machine bus is a network load, not part of the rotor.**
  `_load_shunts` skipped machine buses, leaving the load folded into the
  machine's own injection: constant power, welded to the shaft, never
  collapsing with voltage. Moving a 60 MW load one zero-impedance busbar link
  took P_m from 25 MW to 85 MW and the CCT from **0.6225 s to 0.2625 s** — a
  2.4× non-conservative error decided by where the load was drawn on the SLD.
  An islanded genset carrying its board on the same bus got P_m = 0 and ignored
  load steps entirely. Local load is now stamped as a shunt on every bus and
  `_collect_machines` adds it back to recover the machine's own output; net
  power balance is unchanged.
- **[D3] Shedding such a load injected phantom generation.** `_dyn_shunt` shed
  with `y -= ybase`, subtracting an admittance the machine-bus branch never
  added — a negative conductance, i.e. +40 MW of generation where 40 MW of load
  should have gone. Falls out with D2; pinned separately.
- **[D8] Reclose onto a permanent fault.** The reclose segment restored the
  pre-trip topology with an empty `grounded` set, so only the benign outcome was
  representable. `reclose_onto_fault` (+ optional `second_clear_s`, defaulting
  to the first clearing time) now re-applies the fault on reclose and locks the
  branch out after the second clearing.

**Test-fixture consequence:** `_smib()`'s 60 MW load moved from the generator
bus to the infinite bus. The equal-area closed form is a *lossless* SMIB
criterion, and a resistive load at the machine terminal now correctly puts a
real part into the reduced Y — the anchor drifted to −11.5 %. At the infinite
bus the load is bypassed by the source's ~0 internal impedance, so the anchor
holds at **−0.25 %** while the generator still exports its full 85 MW. The old
0.6225 s CCT baseline in `TestUnbalancedFault` was pinning the D2 defect and is
now 0.245 s.

**Still open (documented, not fixed):** true phase-quantity reconstruction for
relays under unbalanced faults (D5's follow-on); `SUBTRANS_ITERS = 3` is ample
at the typical loop gain 1 − X″d/X′d ≈ 0.4 but not at the 0.999 the `xd_pp`
clamp permits; ROCOF is measured off an island COI that steps discontinuously
when a machine trips; V/Hz reads the machine's bus rather than its terminals.

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
in place, the machine model's own accuracy refinements are done too. With
**ROCOF, over-excitation, out-of-step protection and auto-reclose** now in
place, the trip set matches most of what a real protection-coordination study
would configure on a generator or feeder. With **over-current (50/51/67)**
and now **distance (21)** relay tripping both in place — sharing the same
per-branch current infrastructure and live mid-simulation topology-switch
mechanism, the distance relay adding a true Z=V/I mho evaluator with
geometry-derived directionality on top — the engine's protection-function
set is complete.
