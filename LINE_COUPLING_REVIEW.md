# Line Coupling Review — `line_coupling.py` (parallel zero-sequence coupling)

*Review date 2026-09-29. Method: `ENGINE_REVIEW_METHODOLOGY.md`. References:
IEC 60909-3:2009 eq. (34)–(36) and Table 2 (in `IEC Standards/`, text
layer), and an independent phase-domain Carson model of a double-circuit line
(6 conductors, earth return, no earth wire), solved with both circuits
paralleled at both ends. No reference was derived from the module or its tests.*

## 1. Scope

`line_coupling.py` gives a feeder with `num_parallel = n` the zero-sequence
impedance Z0_eff = [Z0s + (n−1)·Z0m]/n. Z0m is the Carson mutual between two
three-phase circuits, 3·[π²f·10⁻⁴ + j·4πf·10⁻⁴·ln(δ/D_m)] Ω/km. Both the fault
study (`fault._cable_z0`) and the unbalanced load flow (`_cable_z0_pu`) use
it. The review also covers what happens when a double circuit is drawn as
separate feeders.

## 2. What holds up

| Checked against | Result |
|---|---|
| δ = 658.87·√(ρ/f) vs IEC 60909-3 eq. (36) δ = 1.851/√(ωμ0/ρ) and Table 2 | exact vs eq. (36); Table 2 within its rounding (931 m at 100 Ω·m, 2950 m at 1000, 9300 m at 10 000) |
| Earth-return resistance μ0ω/8 | 0.04935 Ω/km, as the standard's worked example |
| Z0m = 3·z_m with D_m = GMD of the nine inter-circuit distances | correct |
| Z0_eff formula vs the phase-domain solve (`v1_phase_domain.py`): 132 kV tower (Zebra), 11 kV pole (Dog, flat), 22 kV pole (Hare, vertical), at 100 and 1000 Ω·m | within 0.08 % (untransposed geometry) |
| Library overhead r0 = R20 + 3·R_e | all 16 entries (0.148 Ω/km, Carson) |
| Fault and unbalanced engines use the same scale | yes |
| 0.95 cap on |Z0m/Z0s|, disclosure text | correct and disclosed |

## 3. Findings

### LC1 — a double circuit drawn as two feeders was not coupled — `line_coupling.py` (drawn groups)

`num_parallel` couples the circuits of one component. The same line drawn as
two overhead feeders between the same two buses (the usual way to give each
circuit its own breaker) got no coupling: Z0 = Z0s/2, the naive divide the
module was written to replace. `v2_inputs.py`, 10 km of ACSR Dog at 11 kV,
earth fault at the far bus:

| Model | Ik1 |
|---|---|
| single circuit | 0.909 kA |
| `num_parallel = 2` (coupled) | 1.254 kA |
| two drawn feeders, before | 1.706 kA (+36 %) |
| two drawn feeders, after | 1.254 kA |

The error overstates earth-fault current. That is non-conservative for
earth-fault protection sensitivity and for the minimum-current disconnection
check.

**Fix (decision 2026-09-29: couple automatically).** Overhead feeders that
reach the same pair of buses through closed switchgear only are taken to
share a tower, the same physical default as `num_parallel`. Setting
`z0_coupling: none` on a feeder opts it out; an open breaker takes it out.
For k feeders the coupled Z0 matrix has:
- Z_ii = each feeder's own Z0, including its `num_parallel` treatment;
- Z_ij = Z0m·min(L_i, L_j).

With a common voltage across the group, each feeder behaves as the uncoupled
branch Z_i′ = 1/(Z⁻¹·1)_i. That reproduces the group impedance and each
feeder's current share, so the engines keep their per-branch stamping. For
two identical feeders Z_i′ = Z0s + Z0m. For a non-identical pair (Dog + Wolf
on one pole, `v4_drawn_pair.py`) the result matches the phase-domain solve:
group Z0 within 0.03 % and each circuit's share within 0.0001.

The equivalents are held in a per-call context
(`drawn_coupling_scope` / `set_drawn_coupling`), never written into the
project. They are applied in `run_fault_analysis`, `thevenin_sequence_at_bus`
and `run_unbalanced_load_flow`, and disclosed in the study assumptions and
load-flow warnings.

## 4. Lesser notes

- **L1. The default circuit spacing is a tower figure.** 8 m applies at
  every voltage. Two 11/22 kV circuits on one pole have a GMD of about 2.2 m.
  With the default, Ik1 comes out 6.7 % high on the example above (coupling
  understated). The default is stored in every component, so it cannot be
  made voltage-dependent without a migration; the tooltip now gives the pole figure.
- **L2. Soil resistivity reaches the mutual term only.** Carson adds the same
  j·3·(μ0ω/2π)·ln δ to Z0s and Z0m, so the pair is consistent only when Z0s
  was calculated at the entered ρ (`v3_rho.py`). With the library's nominal Z0,
  moving ρ from 100 to 1000 Ω·m changes a double circuit but not a single
  one: Z0 is 11 % low for the single circuit and 6.5 % low for the double
  against Carson. The tooltip and help now say to enter the ρ that Z0 was
  calculated at (100 Ω·m with library conductors).
- **L3. Library x0 is 3.5 × x1, and earth wires are not modelled.** That is
  about 25 % below a Carson estimate for a bare MV line with no earth wire.
  The IEC 60909-3 earth-wire reduction (eq. 33–35) is not modelled for Z0s or
  Z0m. Left for the Tier 4 library check.

## 5. Not covered

- Open-conductor / simultaneous faults on one circuit of a drawn pair (the
  series-fault engines keep uncoupled Z0 for the partner);
- feeders coupled over part of their route, or ending at different buses;
- earth wires;
- untransposed-line unbalance in the positive sequence;
- the out-of-service circuit earthed at both ends (IEC 60909-3 NOTE 2).

No saved project in the live database has an overhead line, so no stored
results change.

Scripts (session scratchpad `lc/`): `v1_phase_domain.py`, `v2_inputs.py`,
`v3_rho.py`, `v4_drawn_pair.py`.
