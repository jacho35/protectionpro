# Review of `CALC_AUDIT_2026-09-20.md`

**Date:** 2026-09-20
**Scope:** Correctness review of the calculation audit itself — are its findings real, are its
derivations right, are its severity/impact assessments sound, and did it miss anything.
**Method:** Read-only against the code it cites, plus independent numerical reproduction of
every quantitative claim in the Findings section, run in the `protectionpro-backend` image.
No code was modified.

---

## ☞ For a second reviewer — check these first

Ordered by how falsifiable each claim is. **1–3 are the ones that matter**; 4–6 are
judgement calls where a second opinion is worth more than a re-run.

Runnable probes live in **`audit-history/probes-2026-09-20/`**. From the repo root:

```bash
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  python audit-history/probes-2026-09-20/<probe>.py
```

| # | Claim to test | Probe / evidence | Falsified if |
|---|---|---|---|
| **1** | **N-1 (new defect).** `num_parallel` is dropped for cables at `loadflow.py:2338` and `network_reduction.py:206`, while `unbalanced_loadflow.py:352` applies it. | `probe_n1_num_parallel.py` | V(bus-2) **changes** across `num_parallel` 1/2/4 on the legacy path (t = 1), or Zth changes in `network_reduction` |
| **2** | **R-1.** The F-1 defect is in **4** modules and reaches transient stability + dynamic motor starting — contradicting the audit's "`network_reduction.py` … unaffected" and "the affected path is narrow". | `probe_r1_blast_radius.py`; plus read `network_reduction.py:210`, `unbalanced_loadflow.py:365-375`, `harmonics.py:274`, and the imports at `transient_stability.py:137` / `dynamic_motor_starting.py:59` | `network_reduction.py:210` does **not** contain the same `else: sum(_get_impedance(...))`, or those two engines don't import from it |
| **3** | **F-1 (confirming the audit).** Cable-only chains use the cable's own `voltage_kv` prop as the pu base. | `probe_f1_cable_base.py` | The two rows agree, or the error is not ≈ (11/0.4)² |
| **4** | **R-2.** The audit's exposure analysis is wrong **both ways** — it missed two UI guards (`voltage.js` propagation via `wiring.js:66`; `Components.validate()` via `app.js:720/903/945`) *and* missed that `loadflow.py:3553` skips cable-only chains so the defect fires silently on the API path. | Code read only | — this is the **most contestable** item: whether propagation reliably fires in real use is a judgement call, not a fact |
| **5** | **R-3.** F-5 cites a κ ≤ 1.02 guard; `fault.py:63` guards at κ ≤ 1.0. | Code read only | — |
| **6** | **R-4 / R-5.** 44 analysis modules not 43; suite is 859 tests (all passing) not 806; `CLAUDE.md` still says IEEE 1584-2018 is not implemented, but it is. | `ls backend/analysis/*.py`; `pytest backend/tests/ -q` | — |

**Do not confuse the two documents.** `CALC_AUDIT_2026-09-20.md` is the audit *under review*;
this file is the review of it. Both are untracked. Where this file confirms the audit (F-1,
F-3, F-4, F-6–F-9) agreement is the expected outcome, not a finding.

## Verdict on the audit

**The audit is substantially correct and its headline finding is real.** F-1 reproduces
exactly as described, its root-cause diagnosis is right, and the ~25 "verified correct"
coverage claims I re-sampled (K_T, κ, thermal m, IEEE 80 K_i, adiabatic k constants, IDMT
twin tables, IEC 60364 grouping twin tables, IEEE 519 bins, Ks diversity table, Z0 fallbacks)
all check out against the code and the standards.

**But three of its nine findings are wrong in ways that change what a reader would do:**

| | Audit said | Actually |
|---|---|---|
| **R-1** | F-2: blast radius is "narrow"; `network_reduction.py` "walks its own zone tracking — **unaffected**"; fix `_get_impedance` and "F-1 and F-2 [are] resolved together" | The same defect is **copy-pasted into 4 modules**, and reaches **transient stability** and **dynamic motor starting**. Fixing `_get_impedance` alone cannot resolve it. |
| **R-2** | F-1: the UI path is exposed — "a **manually-drawn LV cable** … hits the defect"; only plan-sync protects it | The UI has **two** independent guards the audit never looked at (`voltage.js` auto-propagation, `Components.validate()` pre-study warning). The real exposure is API/client payloads and one dialog-dismissal path. |
| **R-3** | F-5: the guard is at "κ ≤ 1.02 … returns m = 0" | The guard is at **κ ≤ 1.0**. The derivation in F-5 is about a branch that does not exist. (Verdict "no defect" still holds.) |

**And it missed a second, independent, reproducible defect in the very code it was reading** —
see **N-1** below: cables' `num_parallel` divide is dropped on two chain-assembly paths, so a
2× or 4× parallel run is modelled with the impedance of a single circuit.

Net effect on the audit's bottom line: the recommended fix is **under-scoped** (4 sites, not 1),
the High finding's **severity is if anything understated** (it reaches the transient-stability
Thevenin), while its **likelihood in the UI is overstated**.

---

## Part 1 — Confirmed findings

### F-1 [HIGH] — CONFIRMED, reproduced

The structural claim is exactly right. `loadflow.py:2342-2343` falls to
`sum(_get_impedance(e, base_mva) …)`, and `_get_impedance`'s cable branch
(`loadflow.py:1654-1660`) uses `comp.props.get("voltage_kv", 11)` as the per-unit base.
Cable palette default is `voltage_kv: 11` (`frontend/js/constants.js:2427`).

Independent reproduction — utility @ 0.4 kV → 50 m cable (0.3 + j0.08 Ω/km) → load:

| cable `voltage_kv` | V(far bus) | cable I | loading | losses |
|---|---|---|---|---|
| 11 (default, stale) | **0.999994 pu** | 2.62 A | 0.66 % | 0.000000 MW |
| 0.4 (correct) | **0.995213 pu** | 72.52 A | 18.13 % | 0.000237 MW |

Voltage drop understated **798×**; current understated **27.7×** (= 11/0.4); losses fall below
the 1e-6 MW reporting resolution entirely. The impedance error is exactly
(11/0.4)² = **756.25×**, as the audit states.

These reproduce the audit's own figures closely (it quotes 2.62 A vs 72.2 A for the same
network), which corroborates its probe — and makes its "15×" drop figure, below, harder
to account for, not easier.

The audit's diagnosis that this is the un-propagated `[EE-12]` fix is corroborated by the
codebase itself — `fault.py:1250-1256` carries a docstring naming this exact failure
("11 kV left on a 0.4 kV run, which near-zeroes its fault-path impedance by (11/0.4)² ≈ 756×")
and says it mirrors "the convention loadflow.py uses for cables **in transformer chains**".
The no-transformer branch was indeed never brought across.

> **One arithmetic slip inside F-1.** It reports engine 0.99999 vs hand 0.99536 and calls that
> "a **15×** understatement of the voltage drop". From its own two numbers the ratio is
> **1 − 0.99999 : 1 − 0.99536 = 464×**, and from the probe above **798×**. A 756× impedance
> error cannot produce a 15× drop error.
> The "2.62 A vs 72.2 A" current figure in the same paragraph is self-consistent (27.5 = 11/0.4).

### F-3 [LOW] — CONFIRMED

`unbalanced_loadflow.py:162-163` falls back to 3.5× the per-km R1/X1 unconditionally;
`fault.py:1141-1146` uses 3.5× only when **one** of `r0_per_km`/`x0_per_km` is set, and
`3.0 × (R1 + jX1)` when **neither** is. So the two engines diverge only in the
neither-set case, exactly as the audit says, by 3.5/3.0 = **16.7 %**. Both carry comments
disclosing it. Assessment and severity are right.

### F-4 [LOW] — CONFIRMED as to fact; the rationale is wrong, the verdict survives

`_compute_steady_state_current` (`fault.py:2554-2603`) handles `utility`, `generator`,
`motor_synchronous`, `motor_induction` and falls through for `solar_pv`, `battery`,
`wind_turbine` (which *are* real source types — `fault.py:737/750/766`). Confirmed.

The audit's justification — "the omission is conservative-**neutral** for Ik" — is not right.
A full-size converter is a sustained current-limited source (~1.1–1.2× rated) that
IEC 60909-0 does credit to Ik; omitting it **understates** Ik, which is the
non-conservative direction for "will the device see enough current to trip". The audit's
"no action required" verdict nonetheless stands, for a reason it did not establish:
**`ik_steady` is display-only.** Its sole consumer is the properties panel
(`frontend/js/properties.js:1695-1698`); no compliance, duty-check or grading path reads it.

Worth noting for the disclosure the audit suggests: on an all-inverter island `ik_total`
is 0, so `ik_steady` returns `None` and the **entire Ik line silently disappears** from the
panel rather than showing zero — and the panel's explanatory text names only generators and
induction motors, never inverters.

### F-5 [LOW] — the code citation is WRONG; the "no defect" verdict is right

`fault.py:63` reads:

```python
if not kappa or kappa <= 1.0 + 1e-9 or duration_s <= 0 or freq_hz <= 0:
    return 0.0
```

The guard is **κ ≤ 1.0**, not κ ≤ 1.02. F-5's entire derivation ("At exactly κ = 1.02
(R/X → ∞, pure resistance) … m = 0 is first-principles correct") describes a branch that
isn't there: at κ = 1.02 the function computes m normally (x = ln 0.02 = −3.912, giving a
small but non-zero m ≈ 5.1e-3 at Tk = 0.5 s). The κ→2 limit and the Ith = Ik″·√(m+n)
identity the audit checks are correct. Also a citation slip: F-5 says "IEC 60909-1 Eq. 87";
the docstring says IEC 60909-0 §12.

Harmless in outcome, but F-5 is presented as a first-principles verification, and it
verified something the code does not do.

### F-6 / F-7 / F-9 — CONFIRMED, no issues

Flicker's planning-level Pst anchor, the IEC 61660-1 DC defaults, and the `plan-lux.js`
mean-spherical-intensity derivation all check out as described.

### F-8 twin tables — CONFIRMED by direct diff

Re-diffed the two the audit names most specifically:

- IDMT: `constants.js:454-462` ≡ `arcflash.py:748-756` — IEC (0.14, 0.02), (13.5, 1.0),
  (80, 2.0), (120, 1.0); IEEE (0.0515, 0.02, 0.114), (19.61, 2.0, 0.491),
  (28.2, 2.0, 0.1217). Identical.
- IEC 60364 grouping: `constants.js:320-325` ≡ `iec_60364_tables.py:199-212` — all six
  tables identical entry-for-entry, not just the `bunched` row.

Also verified: adiabatic k (Cu/XLPE 143, Al/XLPE 94, Cu/PVC 115) at `cable_sizing.py:146-148`;
K_T = 0.95·c_max/(1+0.6·x_T) at `fault.py:1240`; κ = 1.02 + 0.98·e^(−3R/X) at `fault.py:2369`;
IEEE 80 K_i = 0.644 + 0.148n at `grounding_system.py:354`; Ks diversity (2, 0.9) … (50, 0.52)
at `load_diversity.py:41-53`. All as claimed.

---

## Part 2 — Errors in the audit

### R-1 [MAJOR] F-2's blast-radius analysis is wrong — the defect is in 4 modules, not 1

F-2 states the affected path is "narrow", that `network_reduction.py` "walks its own zone
tracking — **unaffected**", and that fixing `_get_impedance` "resolves F-1 and F-2 together".
All three are wrong.

The `has_xfmr` / `else` chain-assembly block is **copy-pasted into four modules**, and every
copy's `else` branch takes the cable's own prop as its per-unit base:

| Module | Defective line | Feeds |
|---|---|---|
| `loadflow.py` | 2343 | load flow + every study built on it |
| `network_reduction.py` | **210** | `build_port_zbus` → **dynamic motor starting**; `build_branch_ybus` → **transient stability** |
| `unbalanced_loadflow.py` | 365-375 | unbalanced LF Z1/Z2 **and** Z0 (`e.props.get("voltage_kv", 11)` passed explicitly at :374) |
| `harmonics.py` | 274 | harmonic penetration (partially mitigated: `… or va` falls back to the bus only when the prop is absent/zero — a **present** default of 11 still wins) |

`network_reduction.py` does have its own correctly zone-tracked walk — but that is
`_source_stub` at lines 85-110. The **chain builder** at 180-210 is a separate function
(`build_branch_ybus`) and carries the defect. The audit appears to have read the first and
generalised to the second.

Reproduction on the same 0.4 kV network (cable prop 11 vs correct 0.4):

```
network_reduction.build_branch_ybus  chain Z:  0.01240+0.00331j  vs  9.37500+2.50000j pu   (756.2×)
network_reduction.build_port_zbus    Zth:      0.03230+0.20231j  vs  9.39490+2.69901j pu
unbalanced_loadflow                  V(far):   0.999994          vs  0.995214 pu
```

`build_port_zbus` is the Thevenin source impedance `dynamic_motor_starting.py:59` uses, and
`build_branch_ybus` is imported by `transient_stability.py:137`. A stale cable prop therefore
also corrupts **motor acceleration time, voltage-dip trajectory and transient stability
swing curves** — none of which the audit lists as affected.

**Consequence for the recommendation.** "Fix `_get_impedance`" cannot work on its own:
the function has no topology and no way to know the zone. The fix has to be the shared
zone-resolution helper the audit proposes, threaded through **all four** call sites. F-2
should be merged into F-1 as one High finding spanning four modules, not kept as a
separate Medium.

### R-2 [MODERATE] F-1's exposure analysis is wrong in both directions

**Overstated on the UI side.** F-1 says "a **manually-drawn LV cable** … hits the defect"
and credits only `plan-sync.js:442` as protection. There are two more guards it did not find:

1. **`frontend/js/voltage.js` — automatic voltage propagation.** `cable: 'voltage_kv'` is in
   `VOLTAGE_KEYS` (:17). `wiring.js:66` calls `VoltagePropagation.propagateFromWire()` on
   **every wire created**; `resolveZoneVoltage` (:152-174) skips components still at their
   default and lets the bus's set voltage win, then `applyVoltageToZone` (:180-193)
   unconditionally writes it to every zone member **including the cable**. So the ordinary
   "set the bus to 0.4 kV, then wire the cable" flow *does* write `voltage_kv: 0.4`.
2. **`Components.validate()`** warns on a cable whose `voltage_kv` differs from its bus by
   >15 % (`components.js:779-786`), and `app.js:720/903/945` runs it before studies.

The realistic exposure is therefore narrower than F-1 implies: **API / Python-client payloads**
(`clients/python/`) that omit the prop, and the wire-first-then-change-bus-voltage order,
where `propagateFromBusChange` (`voltage.js:369`) asks for confirmation and a user who
dismisses the dialog leaves the cable at 11 kV.

**Understated on the backend side.** The audit does not mention that the load flow's own
voltage-mismatch warning **cannot fire on this path**. `loadflow.py:3552-3553`:

```python
for elems, from_bus, to_bus, y, t, hv_bus, cvs in branch_chains:
    if elems is None or hv_bus is None:
        continue  # Skip bus links and non-transformer chains
```

`hv_bus is None` is precisely the cable-only chain. So when the defect does fire — via an
API payload, where none of the frontend guards exist — it fires **completely silently**, with
no warning in the result. That materially strengthens F-1 and belongs in it.

### R-3 [MINOR] F-5 misreads the code (detailed above)

### R-4 [MINOR] Scope-count and baseline claims don't reproduce

- "all **43** `backend/analysis/` modules" — there are **44** (45 files less `__init__.py`).
  Four are absent from the coverage section: `loadflow_cases.py` (a real orchestration
  module), `admd_data.py`, `plan_dxf.py`, `pdf_reports.py`.
- "**806 tests**" and "six test modules error on collection … missing `bcrypt`, `ezdxf`" —
  with the documented command, `backend/tests/` collects **859 tests with zero collection
  errors** in the current `protectionpro-backend` image (both optional deps are present),
  and the full suite runs **859 passed in 434 s**. The 53-test gap is consistent with the
  audit having excluded those six files, so the numbers reconcile — but "the regression
  suite (806 tests)" reads as the suite size and is not. The full suite is 859, and the
  audit's "passes as a baseline" claim is confirmed on all 859.

  Note this also confirms that **neither F-1 nor N-1 is pinned by any existing test** — both
  defects sit under a fully green suite.

### R-5 [MINOR] A stale-doc contradiction went unflagged

The audit correctly documents that IEEE 1584-**2018** is implemented (`arcflash.py:1`,
`_2018`-suffixed functions, three-anchor model, and it's the default for new buses per
`constants.js`). `CLAUDE.md` still states "IEEE 1584-2002 method (the engine docstring is
explicit; **2018 is not implemented**)". An audit that read both should have raised the
contradiction. The audit also passes over a caveat its own source states: `_RATIO_2018`
is **not** from the official spreadsheet — it was Vandermonde-fitted to seven Voc values
(`arcflash.py:27-30`). That is well-disclosed in code, but "transcribed from the official
validation spreadsheet (144k-row verified)" flattens it.

---

## Part 3 — Defect the audit missed

### N-1 [HIGH] `num_parallel` is dropped for cables on two chain-assembly paths

**Files:** `backend/analysis/loadflow.py:2334-2338`, `backend/analysis/network_reduction.py:204-206`

Both `has_xfmr` branches re-derive the cable impedance inline to get the zone voltage, and
both omit the parallel divide that `_get_impedance` applies:

```python
z_base = (v_kv ** 2) / base_mva
r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
z_total += complex(r / z_base, x / z_base)     # ← no  / num_parallel
```

This is the *identical* bug `unbalanced_loadflow.py:346-352` documents as already found and
fixed on its own side ("had dropped the parallel divide, so a parallel cable sharing a chain
with a transformer carried n× its true positive-sequence impedance"). It was never fixed in
`loadflow.py` or `network_reduction.py`. The audit read both files and both comments.

**Reproduction.** 11 kV utility → 1 MVA 11/0.4 kV transformer → 100 m cable → 0.4 kV bus + load:

| | `num_parallel`=1 | =2 | =4 |
|---|---|---|---|
| V(bus-2), legacy path (`voltage_lv_kv` 0.4, t = 1) | 0.977838 | **0.977838** | **0.977838** |
| V(bus-2), exact path (`voltage_lv_kv` 0.42, t ≠ 1) | 1.028939 | 1.038304 | 1.042922 |
| `network_reduction` Zth(bus-2), all cases | 19.269+10.195j | **19.269+10.195j** | **19.269+10.195j** |

The exact `_kron_reduce_two_port` path honours `num_parallel` correctly. The legacy sum does
not — V is bit-identical across 1, 2 and 4 parallel circuits. `network_reduction` has **no**
exact-path alternative, so it is always wrong here.

**When it fires.** The legacy path is selected at `loadflow.py:2412-2415` when a chain has
exactly one transformer and (no cable **or** combined ratio t = 1). So the defect needs:
one transformer + at least one cable + **t exactly 1** — i.e. the transformer's nameplate
matching its buses with no tap. That is the *well-specified* network, which makes this
unusually easy to hit and unusually easy to miss in testing.

**Direction.** Voltage drop and losses are overstated by up to n× (conservative for cable
sizing, wrong for hosting capacity, OPF, capacitor placement and voltage stability). In
`network_reduction` the Thevenin impedance is overstated n×, so **motor-starting dips and
transient-stability swings are pessimistic** — and `loading_pct` is *not* affected (it uses
`rated_amps × num_parallel`), so the UI shows a comfortably loaded cable next to an
inflated voltage drop, which reads as a modelling contradiction rather than a bug.

---

## Part 4 — Corrected summary table

| ID | Audit severity | Reviewed severity | Status |
|---|---|---|---|
| F-1 | High | **High** | Confirmed & reproduced. Fold F-2 in; add the 3 extra modules; add the silent-failure note; drop the "15×" figure; correct the UI-exposure paragraph |
| F-2 | Medium | *(merge into F-1)* | Blast-radius analysis wrong — see **R-1** |
| **N-1** | *(not found)* | **High** | **New.** `num_parallel` dropped, `loadflow.py:2338` + `network_reduction.py:206` |
| F-3 | Low | Low | Confirmed |
| F-4 | Low | Low | Fact confirmed; rationale wrong (understates, not neutral); verdict survives because `ik_steady` is display-only |
| F-5 | Low | *(no defect)* | Code citation wrong — guard is κ ≤ 1.0, not 1.02 |
| F-6/7/8/9 | Info | Info | Confirmed, incl. two direct table diffs |
| — | — | Minor | **R-4** module count 44 not 43; suite is 859 tests not 806 |
| — | — | Minor | **R-5** `CLAUDE.md` contradicts the audit on IEEE 1584-2018 |

## Reproduction

All probes, fixtures and expected output: **`audit-history/probes-2026-09-20/`**
(see its `README.md`). Run them from the repo root in the backend image:

```bash
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  python audit-history/probes-2026-09-20/probe_n1_num_parallel.py
```

Every number in this document is the output of one of those three scripts, recorded
2026-09-20 against `protectionpro-backend:latest` with the full suite green (859 passed).

## Recommended remediation (supersedes the audit's "next step")

1. One shared `_cable_zone_voltage(chain, bus_a, bus_b, …)` helper, applied to **all four**
   chain builders' `else` branches — `loadflow.py:2343`, `network_reduction.py:210`,
   `unbalanced_loadflow.py:365-375`, `harmonics.py:274`.
2. In the same edit, add the missing `/ max(1, num_parallel)` at `loadflow.py:2338` and
   `network_reduction.py:206` (**N-1**).
3. Regression tests: (a) 0.4 kV two-bus network with a default-props cable, asserted against
   the hand pu drop, for load flow **and** `build_port_zbus`; (b) a parallel-cable
   transformer chain at t = 1, asserting V changes with `num_parallel` and that the legacy
   and exact paths agree.
4. Either lift the `hv_bus is None` skip at `loadflow.py:3553` so cable-only chains get the
   voltage-mismatch warning, or make the zone voltage authoritative and drop the prop as an
   impedance input entirely (preferred — it removes the failure mode rather than warning
   about it).
5. Update `CLAUDE.md`'s arc-flash line to record that IEEE 1584-2018 is implemented and is
   the default for new buses.
