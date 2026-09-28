# Generator & Motor Review

*Review date 2026-09-28, method per `ENGINE_REVIEW_METHODOLOGY.md` (independent
references, not the modules' own tests). Findings MG1–MG10 and lesser notes
N1–N8, all fixed.*

Evidence scripts live in `testing/generator-motor-review/` (one per theme).
Run them in the backend image from the repo root:

```bash
docker run --rm -e PYTHONPATH=/work -v "$PWD":/work -w /work protectionpro-backend \
  sh -c "pip install -q pytest; python testing/generator-motor-review/v2_dms.py"
```

## 1. Scope and method

`motor_starting.py`, `dynamic_motor_starting.py`, and the generator/motor code
in `transient_stability.py` (machine collection, dynamic induction motor),
`loadflow.py` (motor loads) and `fault.py` (machine impedances — only where the
same-day F1–F9 / L1–L8 fault review did not already cover it). References: a
hand constant-PQ Thevenin solve, the null-disturbance invariant, sequence-
network interconnection, and first-principles starter / per-unit identities.

## 2. What holds up

| Checked against | Result |
|---|---|
| Static start, hand constant-PQ Thevenin solve (500 MVA grid, 10 MVA 10 % transformer, 200 kW DOL) | 0.9819 vs 0.9819, exact (before and after the fixes) |
| Full-load torque η·pf/(1−s), rated-point quadratic root, deep-bar R2 intercept | agree with derivation |
| Star-delta (I, T ÷ 3) and autotransformer (I a², T at a·V) seen from the supply | correct |
| Motor → system admittance base (`y_base_factor`) | correct |
| Transient stability, null disturbance with the motor model off | 0.0000 Hz, exact |
| Generator K_G (IEC 60909-0 Eq. 18) | matches the standard |

## 3. Findings (all fixed, marked `[MGn]` in code)

| # | Defect | Evidence before → after |
|---|---|---|
| MG1 | Transient stability: the dynamic induction motor (on by default) did not start at the load-flow point — fitted P/Q 0.733/0.391 vs LF 0.850/0.527 on the motor base, `demand_factor` ignored (and df = 0 read as 1) | Zero-size load step, governor off: +3.37 Hz / −9.49 Hz (df 0.5) and "unstable" → < 0.0003 Hz. Default governor: 0.25–0.63 Hz → 0.000 |
| MG2 | Dynamic starting: rotor I²t from supply line current, not winding current (star: 1/9 instead of 1/3 of DOL heating; autotransformer a⁴ instead of a²) — non-conservative | Star-delta 0.7 % → 2.0 % |
| MG3 | Dynamic starting: a motor hung below breakdown speed was reported "started" — non-conservative | 52.8 % speed, "started", 14.1 s → "stalled", fail |
| MG4 | Generator with no `x0` used Z0 = Z1, so Ik1 = Ik3 at a solidly earthed set | 0.5 MVA LV set: Ik1 5.24 → 6.29 kA (datasheet X0 0.05–0.08 gives 6.75–6.22) |
| MG5 | Load flow: synchronous motors always absorbed vars; the UI documents the 0.9 default as leading | Leading 500 kVA motor now exports 0.218 MVAr |
| MG6 | Dynamic starting: "running" motors counted in the baseline AND on the Thevenin network | 1.48 % dip with nothing starting → 0.0 % |
| MG7 | Static starting: source-side dip subtracted from every bus, including separate islands | Unconnected plant 3.13 % → 0.0 % |
| MG8 | Static starting (and flicker, TCC overlay): soft starter a fixed 0.5 × LRC, ignoring `ss_current_limit_xflc` | Limit 2.0 / 3.5 / 5.0 → all 3.00 × FLC before; now follow the setting |
| MG9 | Motor rated voltage ≠ bus voltage: bus p.u. used as the motor's own (dynamic starting, transient stability, static, flicker) | 415 V motor on 400 V bus: T(0) 1.163 → 1.080 (= ×(400/415)²), I 5.90 → 5.69 × FLC |
| MG10 | Dynamic starting: the < 0.80 p.u. check read the winding voltage, so every star-delta / autotransformer start warned | Healthy star-delta: "warning" → "pass"; new `min_v_supply_pu` |

Design decisions taken while fixing:

- **MG1** keeps the load-torque *shape* and breakaway but sizes the curve so
  torque balance falls exactly at the load-flow power; the leftover reactive
  difference (nameplate-assumed magnetizing current) is a fixed shunt that
  leaves with the motor when it trips. `load_torque_pct` no longer affects
  transient stability — the load flow is the pre-fault state.
- **MG4** default is `GEN_Z0_Z1_DEFAULT = 0.5` (typical X0 = 0.3–0.6·X″d),
  shared by the path walker, nodal builder and unbalanced load flow, and
  disclosed per machine in the study assumptions. Explicit `x0` is unchanged
  (L3 of the fault review — no K_G on Z0 — still applies).
- **MG5** new prop `pf_mode` (`leading` / `lagging`). New motors default to
  leading (matching the documented default); motors saved before it existed
  stay lagging, with a load-flow warning.
- **MG6** the baseline switches off every simulated motor; the reported
  pre-start voltage is the simulated voltage just before each motor energises.
- **MG3** a soft starter still on its voltage ramp is exempt from the stall
  test (it is meant to sit low until the ramp builds torque).

**Behaviour change for saved projects:** re-run transient stability (any
induction motor), dynamic and static motor starting, flicker, and SLG fault
studies at generators without `x0`. Saved results restore unrecomputed.

## 4. Lesser notes (all fixed, marked `[Nn]` in code)

| # | Note | Fix |
|---|---|---|
| N1 | Static starting modelled the locked rotor as constant PQ and called a no-solution case "voltage collapse" (400 kW on 1 MVA: collapse, V = 0) | Locked rotor = constant impedance, closed-form divider V = V_pre/(1 + Z_th·Y) → 0.7362 p.u., equal to the hand value. Soft starter = constant current, VFD = constant power; only those two can collapse. Flicker uses the same model |
| N2 | Static VFD start at pf 0.3 | Drive front-end pf 0.95 (`VFD_SUPPLY_PF`) |
| N3 | Static starting pf fixed at 0.3; torque never checked | pf from new prop `locked_rotor_pf`, else the dynamic study's nameplate fit (Re Y/|Y| at s = 1). Torque run-up check to breakdown speed at the starting voltage (star-delta against a constant 90 % load now fails) |
| N4 | Dynamic starting's bus walk lacked `bus_duct` | Shares `motor_starting.TRANSPARENT_TYPES` |
| N5 | Dynamic starting: running motors pinned at rated slip; `v_pre or 1.0` read a dead bus as 1.0 | Running motors start at their torque-balance slip, are integrated (slow during a start, stall reported) and the run continues until they settle; dead-bus motors are skipped with a warning |
| N6 | Synchronous motor fault impedance: no K_G, X/R 40 fallback | K_G = 1.1/(1 + x″d·sin φ) (not in nameplate context) and IEC §6.6.1 fictitious R when no X/R, for Z1 and Z2 |
| N7 | Palette generator `x_r_ratio: 40` made the fictitious-R classes unreachable | Default removed (field clearable, "auto (IEC 60909 R_G)"); the properties calc mirrors it. Existing generators keep their saved value |
| N8 | Induction-motor fault X″ from `x_pp`, independent of the LRC field | Shared `induction_motor_x_pp`: explicit `x_pp` wins, else IEC 60909-0 §3.8.2 from LRC (IEC and ANSI fault, harmonics, unbalanced LF, properties calc). New motors carry no `x_pp`; saved ones keep theirs |

Re-baselined because they pinned the old constant-PQ rotor (each now carries
its constant-Z hand value): `TestMotorStarting` (dip 8.978 → 7.324 %, V
0.90326 → 0.91967, 0.7781 → 0.85294), `TestFlickerAnalysis` (d 9.674 →
8.033 %), `test_ee1_weak_transformer_*` (0.86 p.u. — above 0.80 once the
rotor is an impedance), `test_r3_fixes` model label, and the `ver_motor_start`
verification template (0.7782 / 20.92 % / no → 0.8529 / 13.33 % / yes; the
case now pins `locked_rotor_pf: 0.3` so its anchor is hand-computable —
`testing/case-motor-starting/results.md`). The old weak-supply "collapse" test
became a deep-dip test, and collapse is now tested on a constant-current
soft-starter start.

Tests: `backend/tests/test_generator_motor_review_fixes.py` (44 tests, one
class per finding and note). `TestF1SimultaneousCouplingSign` now pins
`GEN_Z0_Z1_DEFAULT = 1` — its phase-domain reference needs Z0 = Z1 everywhere
and had been relying on the old generator fallback.
