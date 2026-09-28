# Fault Engine Review — `backend/analysis/fault.py`

*Review date 2026-09-28, method per `ENGINE_REVIEW_METHODOLOGY.md` (independent
references, not the module's own tests). Findings F1–F9; lesser notes L1–L8.*

Evidence scripts live in `testing/fault-review/` (one per theme, each prints
`predicted | engine | error %`). Run them in the backend image:

```bash
docker run --rm -v "$PWD":/work -w /work/testing/fault-review protectionpro-backend python v1_core.py
```

## 1. Scope and method

`fault.py` top to bottom (IEC 60909 shunt faults, nodal Zbus path, Ib/Ik/Ith,
voltage depression, motor re-acceleration, open-conductor / two-open /
simultaneous series faults). References: IEC 60909-0 hand calculations in
ohms, a hand network reduction, and an independent **phase-domain** nodal
solve for the series-fault family (elements with Z0 = Z1 = Z2 and no mutual
coupling decouple into three single-phase networks).

Not covered: `fault_ansi.py`; Z0 of impedance-earthed YNyn, autotransformer
and parallel-circuit coupling; meshed Ib/Ik scaling; CT saturation model.

## 2. What holds up

| Checked against | Result |
|---|---|
| IEC 60909 hand calc, grid → Dyn11 11/0.42 kV (off-nominal) → 0.4 kV bus: Ik3, Ik1, Ik2, I″kE2E, ip (`v1_core.py`) | 0.00 % on all five |
| Scale invariance — same network ×30 voltage | ≤ 0.04 % (3-dp rounding) |
| Shared-cable topology via nodal Zbus: Zc + ZQ‖ZM (`v2_topology.py`) | 0.01 % |
| DB rotating load seen from the upstream bus | 0.00 % |
| Simultaneous fault, shunt bus UPSTREAM of break — 1- and 2-conductor-open × 3φ / SLG, with and without prefault current (`v4`, `v5`) | 0.00 % vs phase-domain solve |
| Open-conductor (Z2‖Z0) and two-open (series) interconnections | derived by hand — identical |
| κ Eq. 55, μ Eq. 70, q Eq. 71, thermal m, K_T, K_G, fictitious R_G classes, TT 3(R_A+R_B) | correct by reading against the standard |

Baseline: 151 fault-related backend tests pass (baseline only, not evidence).

## 3. Defects (ranked)

| ID | Finding | Evidence | Status |
|---|---|---|---|
| F1 | Simultaneous fault: transfer-impedance sign wrong when the shunt bus is DOWNSTREAM of the break | break current −17.9 %, shunt current −4.9 % (`v5`) | fixed |
| F2 | Bus-less tee (3+ connections on a non-bus node) becomes phantom bus-to-bus branches in the nodal builders | Ik3 +22.9 % at the teed bus (`v6_tee.py`) | fixed |
| F3 | Distribution board's own rotating-load fraction omitted when faulting AT the board (radial path) | Ik3 −15.9 % (`v2_topology.py`) | fixed |
| F4 | One unsourced bus makes the voltage-depression Ybus singular → table silently lost for every bus | `voltage_depression=None`, no warning (`v3_secondary.py`) | fixed |
| F5 | UPS / VFD / rectifier / charger are zero-impedance pass-throughs | 100 kVA UPS output bus shows 31.2 kA; motor behind VFD back-feeds (`v2`) | fixed |
| F6 | ip for a radial multi-infeed bus uses κ of the combined R/X instead of Σ ip_i (IEC 60909-0 §8.1.2) | ip −4.4 % (`v3`) | fixed |
| F7 | Branch kA across an off-nominal transformer converted by bus-voltage ratio, not rated ratio | HV-side currents −4.8 % (`v3`) | fixed |
| F8 | Motor re-acceleration profile flat 1.0 unless a utility sits on the faulted bus; includes every motor in the project | min v_pu = 1.0 behind a transformer (`v3`) | fixed |
| F9 | Generator steady-state Ik = c/Xd at the terminals — neither IEC Ik_max nor Ik_min | at x_d 1.2: −58 % vs λ_max, +76 % vs λ_min (IEC figs. 18/19) | fixed (replaced by IEC 60909-0 §4.6) |

### F1 — simultaneous-fault coupling sign
`_solve_simultaneous_fault` / `run_simultaneous_fault_analysis`. The series
port current IF leaves the network at `bus_up` and re-enters at `bus_down`,
so with the network split radially

    VF + Za·IF + (Z_A,P − Z_B,P)·IP = Ea
    VP + Zp·IP + (Z_P,A − Z_P,B)·IF = Ep

The engine always uses `+Z_attach,P`; correct only for `attach = bus_up`.
The sign is invisible with zero prefault current (the series-port boundary
conditions are invariant under IF,VF → −IF,−VF), which is why a no-load check
passes. Introduced with the engine (d50dd80). Fix: `zfp *= −1` when the shunt
bus is on the load side.

### F2 — bus-less tees in the nodal builders
`_build_bus_network.walk1/walk0` and `_find_bus_branches` walk from each bus
with a shared visited set, recording every bus reached. A tee T of legs Z1
(to b1), Z2 (b2), Z3 (b3) becomes branches Z1+Z2, Z1+Z3, Z2+Z3 — not the
star. A radial network with a motor behind one leg already triggers the nodal
path (shared impedance). Overstatement is conservative for duty but
non-conservative for arc-flash clearing times. Fix: promote non-bus junctions
with ≥ 3 connections to internal nodes and Kron-reduce them.

### F3 — DB's own rotating load at a DB fault
`_collect_source_paths` starts at the faulted node's neighbours, so the DB's
own `motor_fraction` equivalent is never added; the nodal builder does add it
(radial/meshed disagree). Non-conservative for duty at the board.

### F4 — voltage depression lost on an unsourced bus
`_compute_voltage_depression` inverts one Ybus for the whole project; an
island without source shunts is singular and the mode is silently skipped.
Fix: solve per energised connected component; say which buses were skipped.

### F5 — converters are transparent
Types without a walker branch fall through with zero impedance. A UPS output
bus reports the full upstream level (the inverter delivers ~1.5–3 × In); a
motor behind a VFD back-feeds (IEC 60909-0 §13: converter-fed motors don't
contribute unless regenerative). Fix: stop the walk at ups/vfd/rectifier/
charger; model a UPS output as a current-limited source.

### F6 — ip for radial multi-infeed
IEC 60909-0 §8.1.2: for a non-meshed network ip = Σ ip,i over the separate
branches. Engine applies κ(R_eq/X_eq) to the total. Non-conservative for
peak/making duty.

### F7 — branch kA across off-nominal transformers
`_compute_branch_contributions` converts per-unit (faulted-bus base) current
to kA with each element's bus voltage. Across a transformer the current ratio
is the rated ratio. Exposed by 83dd483 (referral moved to rated ratios; this
conversion did not).

### F8 — motor re-acceleration profile
`_calc_motor_reacceleration` uses only utility shunts directly on the faulted
bus (else Z = 0 → no dip) and `_collect_motor_data` collects every motor in
the project. Clearing time is inferred from a CB's `long_time_delay`.
Displayed in `app.js:3475`.

### F9 — generator steady-state Ik
`_compute_steady_state_current`: c/(Xd·base/S_r) with no series path
impedance or rated-ratio scaling. Display only (`properties.js:1750`).
Not an IEC quantity: IEC 60909-0 §4.6 gives Ik = λ·I_rG from the
excitation-ceiling curves. Against figs. 18/19 at x_d 1.2 the old value was
58 % below λ_max and 76 % above λ_min — unusable as either bound.

## 4. Lesser notes

- **L1** Inverter sources (PV/BESS/Type 4) modelled as impedance behind c with
  Z2 = Z1; IEC 60909-0:2016 treats full-converter units as positive-sequence
  current sources with zero negative-sequence contribution.
- **L2** Generator + unit transformer uses K_G and K_T separately, not K_S
  (IEC 60909-0 §6.7) — ~6 % lower impedance by hand estimate (conservative).
- **L3** K_G not applied to Z2/Z0 when `x2`/`x0` are given; those use X/R 40.
- **L4** LV motor default X/R 10 (R/X 0.1); IEC gives R_M/X_M = 0.42 for LV
  motor groups — κ slightly high (conservative).
- **L5** Transformer Z0 side detection uses port + `winding_config`; all other
  logic uses voltage matching. An upside-down drawing flips Dyn11 earth-fault
  behaviour (frontend voltage-mismatch warning partly covers it).
- **L6** Simultaneous fault: I_L assumed in phase with Ep (load PF ignored);
  Ep = c taken as the branch-removed open-circuit voltage; a downstream shunt
  bus needs a load-side source.
- **L7** Voltage depression uses c_max utility impedance regardless of the
  requested voltage factor.
- **L8** Comment typo in the LLG formula (~line 338); code correct.

## 5. Fix order and status

F1 → F3 → F4 → F2 → F5 → F7 → F6 → F8 → F9 — all fixed 2026-09-28, each
marked `[Fn]` in code with a regression test in
`backend/tests/test_fault_review_fixes.py` (45 tests; each finding's
tests fail on the pre-fix engine, and the F9 set is anchored to IEC 60909-0
figs. 18/19 and TR 60909-1 Eq. 88). Every `testing/fault-review/` script now agrees with its
reference to rounding. Design decisions taken while fixing:

- **F2** reuses load flow's `insert_junction_buses`; the tee node stays in
  fault results (its fault level is a useful figure).
- **F5** UPS: `static_bypass` (default `yes` = pass-through, the max-duty
  assumption, so existing projects are unchanged) and `fault_contribution_pu`
  (default 2.0) for an online unit without bypass; VFD `fault_contribution_pu`
  default 1.5 for a drive-output fault; AFE drives contribute as a motor with
  I_LR/I_rM = 3, R/X 0.1. Converter current limits are not scaled by c.
- **F8** clearing time fixed at 0.1 s (the breaker long-time-delay guess was
  removed); magnitudes of Σ Z_kj·I_j are added (in-phase, conservative).
- **F9** replaced by IEC 60909-0:2001 §4.6; every run reports Ik_max
  (`ik_steady`) and Ik_min (`ik_steady_min`):
  - λ_max from IEC TR 60909-1:2002 Eq. (88)–(90), the closed form behind
    figs. 18/19, with each machine's own x″d and cos φ; capped at
    λ ≤ I″kG/I_rG. Reproduces 12 points read off the figures within 3 %.
  - λ_min: TR 60909-1 gives no closed form. The figures' single curve per
    rotor type is reproduced (within reading accuracy) by 1/(x_ref − 0.2 +
    1.105·I_rG/I″kG), x_ref = 2.0 turbo / 0.97 salient — an inferred fit,
    deliberately the standard's curve rather than the machine's own x_dsat.
  - §4.6.1.1 terminal-fed static exciter at the terminals → 0; §4.6.1.2
    compound excitation Ik_min by Eq. (80)/(81) with I_kP; §4.6.2 radial
    Σ λ·I_rGt with I_rG referred through the unit transformer's rated ratio;
    §4.6.3 meshed Ik_max = I″k without asynchronous motors, Ik_min = I″k_min;
    §2.5 minimum: c_min (Table 1), motors neglected; §3.6.2 unregulated
    synchronous motors held at constant excitation (λ_min), disclosed.
  - New props: generator `rotor_type`, `scr`, `excitation_series`,
    `excitation_type`, `ikp_pu`; synchronous motor `voltage_regulated`, `scr`.
    Without an SCR, x_dsat = Xd (disclosed per machine).
  - The old c/Xd method was removed, not kept alongside — it is not a
    standard quantity.

Lesser notes L1–L8 remain open.
