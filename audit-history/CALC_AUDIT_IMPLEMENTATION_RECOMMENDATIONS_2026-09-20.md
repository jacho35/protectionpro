# Implementation Recommendations — Cable Zone-Base & Parallel-Divide Defects

**Date:** 2026-09-20
**Status:** Final — ready for implementation
**Provenance:** `CALC_AUDIT_2026-09-20.md` (audit) → `CALC_AUDIT_REVIEW_2026-09-20.md` (second review) →
independent third verification (all three probes re-run in `protectionpro-backend:latest`, every cited
line re-read, full suite re-run: **859 passed in 436 s**). Every recommendation below was verified
against the code as it stands at commit `73f797d`. This document supersedes the "Recommended
remediation" sections of both prior documents and corrects two line-number slips found during
verification (§2, §3).

**Bottom line:** two real, reproducible High defects — (1) a cable-only chain takes its per-unit
base from the cable's own (often stale, default 11 kV) `voltage_kv` prop instead of the bus zone
voltage, in **4 modules**; (2) the `/ num_parallel` divide is dropped on two chain-assembly paths.
Both sit under a fully green 859-test suite. Neither is pinned by any existing test.

---

## 0. The list, ordered

| # | Item | Type | Files touched | Effort | Risk |
|---|---|---|---|---|---|
| **R1** | Zone-authoritative cable pu base — thread bus-zone voltage through all 4 chain builders | Bug fix (High) | `loadflow.py`, `network_reduction.py`, `unbalanced_loadflow.py`, `harmonics.py` | S | Low — byte-identical when props are already correct |
| **R2** | Add the missing `/ max(1, num_parallel)` on the two inline chain re-derivations | Bug fix (High) | `loadflow.py`, `network_reduction.py` | XS | Low — byte-identical when n = 1 |
| **R3** | Regression tests pinning both defects (3 tests) | Test | `backend/tests/test_regression.py` | S | None |
| **R4** | Backend safety net: extend the 15% voltage-mismatch warning to cable-only chains | Hardening | `loadflow.py` | XS | None |
| **R5** | Documentation: `CLAUDE.md` arc-flash line; audit errata | Docs | `CLAUDE.md` (+ audit doc if archived) | XS | None |
| **R6** | Optional disclosure polish: inverter-aware Ik line in the properties panel | Polish (Low) | `frontend/js/properties.js` | XS | None |

Do R1 + R2 in one PR (same functions, same tests). R3 must land in the same PR.
R4–R6 can follow.

---

## 1. The two defects, in numbers

All figures reproduced 2026-09-20 from `audit-history/probes-2026-09-20/` (read-only synthetic
networks, no customer data).

### Defect A (audit F-1 + F-2, merged) — cable-only chains use the cable's own `voltage_kv` prop as the pu base

`_get_impedance`'s cable branch (`loadflow.py:1654-1660`) uses `comp.props.get("voltage_kv", 11)`
as the per-unit base. The palette default is 11 kV (`frontend/js/constants.js:2427`). Every chain
builder's **no-transformer** (`else`) branch sums `_get_impedance(e)` directly, so an LV cable that
still carries the 11 kV default is referred to the wrong base by (11/0.4)² = **756.25×**:

| cable `voltage_kv` | V(far bus) | cable I | losses |
|---|---|---|---|
| 11 (stale default) | 0.999994 pu | 2.62 A | below reporting resolution |
| 0.4 (correct zone) | 0.995213 pu | 72.52 A | 0.000237 MW |

Voltage drop understated ~798×, current ~27.7×. `fault.py` fixed exactly this class of bug with
`[EE-12]` (`fault.py:1248-1261`: callers pass the bus-inferred zone voltage; the prop is only a
fallback when no network context exists) — the fix was never propagated to the load-flow side.

**Blast radius (4 modules — this is the correction the review established over the audit):**

| Module | Defective site | Reaches |
|---|---|---|
| `loadflow.py` | `:2343` (else branch) → `_get_impedance` | load flow + every study built on it (voltage stability, contingency, OPF, hosting capacity, capacitor placement, timeseries, motor starting baselines) |
| `network_reduction.py` | `:210-211` (else branch) | `build_branch_ybus` → **transient stability** (`transient_stability.py:137`); `build_port_zbus` → **dynamic motor starting** (`dynamic_motor_starting.py:59`) |
| `unbalanced_loadflow.py` | `:369` (Z1/Z2 via `_get_impedance`) and `:374` (Z0 — passes `e.props.get("voltage_kv", 11)` explicitly to `_cable_z0_pu`) | unbalanced load flow |
| `harmonics.py` | **`:276`** (else branch: `v_kv = e.props.get("voltage_kv", va) or va` — a present default of 11 still wins) | harmonic penetration. *(Line-number correction: the review cited :274; that is the has-transformer branch, which is already correct — bus-zone voltages + the parallel divide at :280. The defective line is :276.)* |

The has-transformer branches in `loadflow.py:2324-2339` and `network_reduction.py:194-206` resolve
per-cable zone voltages correctly (as does `harmonics.py:274` and the whole of
`unbalanced_loadflow.py:316-358`) — **only** the no-transformer branches are wrong.

### Defect B (review N-1, new) — `num_parallel` divide dropped on two inline chain re-derivations

The has-transformer branches re-derive the cable impedance inline (to pick up the zone voltage)
and omit the divide that `_get_impedance` applies (`loadflow.py:1659-1660`):

```python
z_base = (v_kv ** 2) / base_mva
r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
z_total += complex(r / z_base, x / z_base)     # ← missing / max(1, num_parallel)
```

- `loadflow.py:2336-2339` *(correction: the review cites :2338; the accumulation needing the divide
  is :2339 — cite the range 2336-2339)*
- `network_reduction.py:203-206`

Same bug, already found and fixed on the unbalanced side (`unbalanced_loadflow.py:346-353`, with a
comment documenting it) and correctly present in `network_reduction`'s own `_source_stub`
(`:106-107`), `fault.py:1260-1261` and `harmonics.py:280-281`.

**When it fires:** in `loadflow.py` only on the legacy path — a chain with exactly one transformer,
at least one cable, and combined ratio t exactly 1 (nameplate matches the buses, no tap) — i.e. the
well-specified network. In `network_reduction` there is no exact-path alternative, so it is always
affected. Reproduction: V(bus-2) = 0.977838 **bit-identical** across num_parallel 1/2/4 on the
legacy path (Zth identical in `network_reduction`); the exact `_kron_reduce_two_port` path varies
correctly (1.028939 / 1.038304 / 1.042922). Loading-% is *not* affected (it uses
`rated_amps × num_parallel`), so the UI shows a comfortably-loaded cable beside an inflated drop.

**Direction:** voltage drop / losses / Thevenin impedance overstated up to n× — conservative for
cable sizing, wrong (pessimistic) for hosting capacity, OPF, capacitor placement, voltage
stability, motor-starting dips and transient-stability swings.

---

## 2. R1 — Zone-authoritative cable pu base

**Fix shape (mirrors the proven `[EE-12]` pattern already in `fault.py:_cable_impedance`):**

1. `loadflow.py:_get_impedance` (`:1646-1661`) — add an optional zone-voltage parameter:

```python
def _get_impedance(comp, base_mva, v_kv=None):
    ...
    elif comp.type == "cable":
        # [EE-12 mirror] Callers that walk the network pass the BUS-inferred
        # zone voltage; the cable's own voltage_kv prop is only a fallback
        # when no network context is available.
        if v_kv is None or v_kv <= 0:
            v_kv = comp.props.get("voltage_kv", 11)
        ...
```

   Default `None` keeps the prop fallback, so **every other caller is unchanged**.

2. Pass the zone voltage at the four no-transformer sites. A cable-only chain has no transformer,
   so all its cables sit in one zone — use the from-bus voltage (same convention as `fault.py`):

   - `loadflow.py:2342-2343` — hoist the `bus_a_v` / `bus_b_v` lookups above the `has_xfmr` if/else
     (they are currently computed inside the transformer branch only), then
     `_get_impedance(e, base_mva, v_kv=bus_a_v)`.
   - `network_reduction.py:209-211` — same hoist (lookups at `:188-189`), same pass.
   - `unbalanced_loadflow.py:369` — pass the chain-resolved zone voltage to `_get_impedance`;
     **and** `:372-375` — pass it to `_cable_z0_pu(...)` in place of
     `e.props.get("voltage_kv", 11)` (the Z0 half of the same defect).
   - `harmonics.py:276` — replace `v_kv = e.props.get("voltage_kv", va) or va` with `v_kv = va`
     (the bus-zone voltage; matches what the has-transformer branch at `:274` already does).

**Do not** change the has-transformer branches' zone resolution — it is correct. **Do not** delete
the prop: it remains the fallback for context-free callers and is still used by cable rating
selection. This is deliberately *zone-authoritative for impedance*, not *prop removal*.

**Regression safety:** for networks whose cable props already match their zone (the only case any
existing test pins), the passed zone voltage equals the prop, so results are bit-identical and the
859-test suite stays green.

## 3. R2 — Restore the parallel divide

At `loadflow.py:2336-2339` and `network_reduction.py:203-206`, divide by the parallel count before
accumulating — exactly as the neighbouring correct sites do (`network_reduction.py:106-107`,
`unbalanced_loadflow.py:352-353`, `harmonics.py:280-281`):

```python
npar = max(1, int(e.props.get("num_parallel", 1) or 1))
z_total += complex(r / z_base, x / z_base) / npar
```

`num_parallel = 1` (the default, and everything the current suite pins) divides by 1 — bit-identical.

## 4. R3 — Regression tests (must land with R1/R2)

Add to `backend/tests/test_regression.py`, using the probe fixtures from
`audit-history/probes-2026-09-20/_net.py` (hand-built synthetic networks — lift them into the test):

1. **Zone base (Defect A):** the `lv_cable_only()` network (utility @ 0.4 kV → 50 m cable → load)
   with the cable left at the palette default `voltage_kv: 11`. Assert `run_load_flow` gives
   V(bus-2) ≈ **0.995213 pu** (the 0.4 kV-zone result, pinned to the hand pu drop
   z = 0.015 + j0.004 pu on the 0.4²/100 base) — *not* 0.999994. Assert the same for
   `network_reduction.build_port_zbus` Zth and `build_branch_ybus` chain Z (9.375 + j2.5 pu).
   This is the single most valuable test: it pins the audit's headline finding.
2. **Parallel divide (Defect B):** the `xfmr_chain()` network at `voltage_lv_kv = 0.4` (t = 1 →
   legacy path). Assert V(bus-2) **changes** between num_parallel 1 / 2 / 4 and equals the
   hand-computed value using z_cable/n; assert `build_port_zbus` Zth likewise.
3. **Legacy vs exact-path agreement:** the same chain at t = 1 (legacy path) vs an explicit-bus
   redraw (bus at the transformer secondary) — the two must agree within solver tolerance; this
   guards the "legacy path is exact at t = 1" invariant documented at `loadflow.py:2394-2399`.

Run: `docker run --rm -v "$PWD":/work -w /work protectionpro-backend sh -c "pip install pytest httpx -q && python -m pytest backend/tests/ -q"` — expect **859 + new, all passing**.

## 5. R4 — Backend safety net (defence against API payloads)

The load-flow voltage-mismatch warning cannot fire on the defective path today:
`loadflow.py:3552-3554` skips chains with `hv_bus is None` — which is precisely the cable-only
chain (`_get_chain_turns_ratio` returns `(1.0, None)` when there is no transformer,
`loadflow.py:1842-1843`). The frontend has two guards the audit missed — `voltage.js` propagation
(`wiring.js:66-67` calls `propagateFromWire` on every wire created; `resolveZoneVoltage`/`
applyVoltageToZone` write the bus voltage onto zone members) and the `Components.validate()` 15%
cable-vs-bus warning (`components.js:778-786`, called at `app.js:720/903/945`) — but **none of that
exists for Python-client / API payloads**, and the bus-change dialog (`voltage.js:334,369`) can be
dismissed. After R1 the engine is correct regardless, but a residual warning costs nothing: lower
the skip so cable-only chains (`hv_bus is None` but `elems is not None`) still compare each cable's
prop against its resolved zone voltage and warn at the existing 15% tolerance.

## 6. R5 — Documentation

1. **`CLAUDE.md` arc-flash lines are stale** (`:99`, `:186`, and especially `:298` — "IEEE
   1584-2002 method … 2018 is not implemented"). Reality: both editions are implemented
   (`arcflash.py:1-32`), IEEE 1584-**2018** is the three-anchor model and is the default for new
   buses (`frontend/js/constants.js:2190`). Update all three lines, and disclose the one caveat
   the docstring already carries: `_RATIO_2018` was Vandermonde-fitted (residual ~1e-15) to the
   seven Voc values of the official validation spreadsheet, not transcribed from it.
2. **Audit errata (if the audit/review docs are archived):** module count 44 not 43; suite 859 not
   806 (the audit excluded six collection-error files; both optional deps are present in the
   image); the F-1 "15×" figure is an arithmetic slip — the drop understatement is ~464× from the
   audit's own numbers, ~798× from the probe; F-5's κ guard is at κ ≤ 1.0 (`fault.py:63`), not
   1.02 — at κ = 1.02 the function computes m ≈ 5.1e-3 normally (verified), so F-5's derivation
   describes a branch that does not exist (verdict "no defect" survives).

## 7. R6 — Optional polish (from confirmed Low findings — none blocking)

- **F-4 (Ik display):** `_compute_steady_state_current` (`fault.py:2554-2604`) has no branch for
  inverter sources (`solar_pv`/`battery`/`wind_turbine` are real path sources, `fault.py:737/750/766`),
  so on an all-inverter island `ik_steady` returns `None` and the Ik line silently disappears from
  the properties panel (`properties.js:1695-1698`). The verdict "no action required" stands (the
  value is display-only — no compliance/duty/grading path reads it), but if touched: name inverters
  in the panel's explanatory text and show `Ik ≈ 0` rather than dropping the line.
- **F-3 (Z0 fallback divergence):** `unbalanced_loadflow.py:162-163` (unconditional 3.5×) vs
  `fault.py:1141-1146` (3.5× if one r0/x0 set, 3×Z1 if neither). Both are commented as deliberate
  per-engine conventions; 16.7% divergence only in the neither-set case. **No action.**
- **F-8 (twin tables):** IDMT constants and IEC 60364 grouping tables verified identical frontend/
  backend by direct diff. No action; a periodic consistency test is a nice-to-have, not a
  recommendation.

## 8. Acceptance criteria

1. All three probes (`audit-history/probes-2026-09-20/`) now show the **correct** row in both the
   11 kV and 0.4 kV columns (F-1: V = 0.995213 regardless of the stale prop; N-1: V/Zth vary with
   num_parallel) — keep the probes as-is; their expected-output block in `README.md` should be
   updated to the post-fix values.
2. Full backend suite green: 859 + the new tests.
3. Bit-identical results for legacy networks with correct cable props and n = 1 (no existing
   pinned result moves).
4. `node --check frontend/js/*.js` clean if R6 is taken (properties.js only).

## 9. BACKLOG.md integration

When the fixes land, follow the CLAUDE.md workflow: remove the corresponding line(s) from the
Outstanding index, strike through the item in its section, and add a Completed entry. Suggested
index lines to add when the work starts (one PR):

```
1. Cable pu base from own prop on cable-only chains — zone-authoritative base across
   loadflow / network_reduction / unbalanced_loadflow / harmonics (+ num_parallel divide on the
   two inline chain paths) *(Audit remediation 2026-09-20 — see CALC_AUDIT_IMPLEMENTATION_RECOMMENDATIONS_2026-09-20.md)*
```

---

*Verification trail: `audit-history/probes-2026-09-20/` (probes + fixtures + expected output);
`CALC_AUDIT_REVIEW_2026-09-20.md` §"check these first" items 1–6 all independently reproduced on
2026-09-20, including the two line-number corrections noted in §1.*