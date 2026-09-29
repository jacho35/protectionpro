# DC Short-Circuit Engine Review — `dc_shortcircuit.py`

*Review date 2026-09-29; fixed the same day (§6). Method: `ENGINE_REVIEW_METHODOLOGY.md` — every
reference below is derived from IEC 61660-1 (as reproduced with worked examples
in CED Engineering course E03-035, "Arc Flash Hazard Calculations in DC
Systems", Examples 1 and 3) or from circuit first principles, never from the
module's own tests.*

Reference scripts: `v1_single_battery.py` … `v6_edges.py` (scratchpad, shared
helper `dc_common.py`); each prints `predicted | engine | error %`.

## 1. Scope

`run_dc_short_circuit` — battery and converter (rectifier / charger) partial
currents, the network between source and fault (loop resistance, Laplacian
effective resistance, least-resistance-path inductance), superposition at the
fault, time to peak and rise time constant. Helpers shared with
`dc_loadflow.py` (`_build_bus_groups`, `_find_dc_branches`, `_attached_group`)
were exercised through this engine.

## 2. What holds up

| Checked against | Result |
|---|---|
| IEC 61660-1 battery peak, published Example 1 at the terminals: i_pB = 1.05·120 / 18.238 mΩ = 6908.6 A | 6909 A, **+0.01 %** |
| Same, at the breaker through 5 mΩ / 14 µH: 5422 A | 5422 A, **0.00 %** |
| Quasi steady-state I_kB = 0.95·E_B / (R_BBr + 0.1·R_B) (eq. 13), terminal and breaker | **0.00 %** / **−0.01 %** |
| Loop resistance 2·r·ℓ and loop inductance 2·(x/ω)·ℓ vs the two-conductor formula (μ0/π)(0.25 + ln d/r) | consistent (x_per_km is per-conductor) |
| Cable tee through a closed CB, no bus at the tee | **exact** (V6a) |
| Several sources with no common branch (IEC fault location F1): i_p = Σ E/R_j | **exact** (V3b, V3c) |
| `num_parallel = 2` on one cable | **exact** |
| Island separation, open CB isolates a source | correct |

The battery core — EMF 1.05·U_nB, 0.9·R_B on the peak, full R_B on the quasi
steady-state — is right. The defects are in everything around it.

## 3. Defects, ranked

### DC1 — Rectifiers and chargers are current-limited at 3× / 1.5× rated; IEC 61660-1 computes them from the AC supply — **critical, non-conservative, fires on defaults**

`dc_shortcircuit.py:67-74, 224-229`. The converter's contribution is
`dc_sc_factor × I_rated` (default 3.0 rectifier, 1.5 charger), independent of the
AC network and of the DC resistance to the fault. IEC 61660-1 states that
**rectifier current-limiting controls are not effective** for the maximum
short-circuit current and derives the rectifier's partial current from the
AC-side impedance Z_N (source + supply cable + rectifier transformer +
commutating reactor):

I_kD = λ_D · (3√2/π) · c·U_n/(√3·Z_N) · U_rTLV/U_rTHV,  i_pD = κ_D·I_kD,  λ_D and κ_D from R_N/X_N, R_DBr/R_N and L_DBr/L_N (eq. 32–41).

Evidence (V4): published Example 3 — 480/120 V, 100 kVA, u_k 3 %, 30 MVA
source. Our implementation of eq. 32–41 reproduces it (λ_D 0.897, κ_D 1.204,
t_pD 9.62 ms, τ_1D 3.83 ms at the published rounding): **I_kD = 18.4 kA
(22× rated), i_pD = 22.1 kA**. The engine gives **2.50 / 2.63 kA — −86 % / −88 %**.
`dc_sc_factor` has no UI field, so the defaults are always what runs
(methodology archetype 2). Anyone sizing a DC breaker's breaking or peak rating
from this result is under-rating it by close to an order of magnitude. The
error is present since the engine was added (`e48bb05`).

The λ_D and κ_D expressions were then checked against IEC 61660-1:1997
Annex A itself (eq. 54–56): they are the ones used above.

**Fix:** implement the IEC rectifier sub-procedure for `rectifier` and
`charger` types `diode` / `thyristor`. Z_N = the IEC 60909 maximum Z at the AC
bus the `ac_in` port is wired to (from `fault.py`, c_max, its R/X), plus a
converter transformer (new props: `tx_kva` defaulting from the rating,
`tx_uk_pct` default 4 %, `tx_xr` default 5, secondary voltage =
`voltage_ac_kv`) and optional smoothing reactor `l_dc_uh`. With nothing wired
to `ac_in`, use the transformer alone (infinite bus) and warn. Keep the
current-limited model only for a switch-mode (`igbt`) converter, with
`dc_sc_factor` exposed as a field.

### DC2 — A source wired to its bus through its own cable is dropped — **high, non-conservative**

`_attached_group` (`dc_loadflow.py:155`) walks only closed switching devices,
and `_find_dc_branches` needs a bus at both ends, so battery → lead cable → DC
board (no bus at the battery terminals, the usual way to draw a battery with its
lead) finds no group. That source contributes **0 A**.

Evidence (V2a): 20 mΩ battery behind a 10 mΩ lead; IEC gives
i_p = 126/(18+10) mΩ = **4.50 kA**; engine **0 kA** plus the warning "DC bus has no
source in its island". With a second source elsewhere the loss is silent. The
same helper feeds DC load flow, so that engine also loses the source there.

**Fix:** when a source reaches a DC bus through series cables (and closed
devices) only, fold that chain's loop R and L into the source's branch, the same
way the AC engines give such a source a terminal bus (`insert_implicit_load_buses`).

### DC3 — Parallel cables between the same two buses: only the lowest-resistance cable counts, and the result depends on drawing direction — **high, non-conservative**

`dc_shortcircuit.py:158-160`: `branches_r[(ga, gb)] = min(...)` keeps one cable
per ordered bus pair instead of adding conductances. A second cable drawn A→B is
discarded; one drawn B→A gets a different key and is (correctly) kept.

Evidence (V2b/c): two 20 mΩ cables A–B, i_p at B = 126/(18 + 10) mΩ =
**4.50 kA**. Engine **3.32 kA (−26 %)** when both are drawn A→B, **4.50 kA** when one is
drawn reversed. `branches_l` is overwritten by the last cable.

**Fix:** key by `frozenset((ga, gb))` and sum conductances (G = Σ 1/R); combine
inductance the same way.

### DC4 — Cable resistance at operating temperature; IEC 61660-1 uses 20 °C for the maximum current — **medium, non-conservative**

The underground cable library stores hot resistance (90 °C XLPE = R20 × 1.275
Cu / 1.282 Al; `conductor_temp.py` header). IEC 61660-1 (and IEC 60909-0 for
AC) takes conductor resistance at 20 °C for the maximum current. The engine
uses `r_per_km` as-is.

Evidence (V5): 125 V battery, 20 mΩ, 50 m of 95 mm² Cu (library 0.2461 Ω/km):
IEC i_p = **3.38 kA**, engine **2.96 kA (−12.5 %)**. A cable-dominated circuit
approaches −21.6 % (1 − 1/1.275).

**Fix:** refer library cable resistance to 20 °C for the maximum current (divide
by the insulation's factor; for an overhead conductor use `base_resistance`).
*Cross-module:* `fault.py` uses the same hot values for the IEC 60909
maximum — that belongs to tracker item #11 (`conductor_temp.py`, "which studies
use 20 °C vs operating temperature") and is not changed here.

### DC5 — Sources sharing a common branch are superposed without the IEC correction — **medium, conservative**

Each source's partial current is E/(R_j + R_eff(j, F)), computed as if it were
alone. IEC 61660-1 computes partials with the common branch R_Y included, then
applies correction factors σ_j, because the common branch carries all of them.
The linear network gives this directly (Millman): I_F = Σ(E_j/R_j) / (1 + R_Y·Σ1/R_j).

Evidence (V3a): two 20 mΩ batteries on one bus, 10 mΩ common cable to the
fault: exact i_p = **6.63 kA**, I_k = **5.99 kA**; engine **9.00 / 7.98 kA
(+36 % / +33 %)**. Safe for equipment duty, but it inflates every per-source
contribution the table shows and would mislead a protection-sensitivity or
arc-energy use.

**Fix:** solve the resistive network nodally (sources as Thevenin branches,
converters as injections) with the fault node grounded, once for peak (E, 0.9·R_B)
and once for quasi steady-state (0.95·E, R_B). Per-source contributions come from
superposition and sum exactly to the total. This also makes DC3 fall out
naturally.

### DC6 — Time to peak and rise time constant do not follow IEC 61660-1 — **medium**

`dc_shortcircuit.py:220-222`: τ = L_BBr/R_BBr (or 30 ms when L = 0), t_p =
min(50 ms, 3τ). IEC 61660-1 forms 1/δ = 2/(R_BBr/L_BBr + 1/T_B), T_B = 30 ms, and
reads t_pB and τ_1B from Figure 10 as functions of 1/δ; τ_2B = 100 ms.

Evidence (V1, published Example 1):

| | 1/δ | t_pB published | engine | τ_1B published | engine |
|---|---|---|---|---|---|
| Terminals | 1.56 ms | 4.3 ms | 2.18 ms (**−49 %**) | 0.75 ms | 0.73 ms |
| Breaker | 2.40 ms | 5.4 ms | 3.42 ms (**−37 %**) | 1.3 ms | 1.14 ms (−12 %) |

The fallback is backwards: with the shipped default `internal_l_uh = 0`, a fault
on the battery's own bus reports **t_p = 50 ms, τ = 30 ms** (V6b), whereas IEC
gives 1/δ → 0 and a very fast rise. T_B is a term inside 1/δ, not a substitute
rise time constant. t_p decides whether a fast DC breaker or fuse clears before
the peak.

**Fix:** compute 1/δ per IEC and take t_pB, τ_1B from the standard's battery
figure (IEC 61660-1:1997 Figure 10); drop the 30 ms fallback.

*Resolved:* Figure 10 was supplied and digitised — see §6. It also shows that
the CED example's 5.4 ms at the breaker is a misreading (the figure gives 6.8 ms).

## 4. Lesser notes

- **L1** — A converter is an ideal current source whatever the resistance: a
  125 V charger forces 300 A through 2 Ω, which it cannot (≤ 62 A) (V6c).
  Resolved by the nodal solve in DC5 if the converter is modelled as a
  Norton/Thevenin source, or cap it at U/R.
- **L2** — The bus i_p is the sum of partial peaks that occur at different
  times (documented as conservative) and the bus t_p is the latest partial t_p.
  That is not the time of the total peak. IEC adds the time functions.
- **L3** — Only the maximum is computed. IEC 61660-1 also defines the minimum
  (discharged battery, hot conductors, c_min on the rectifier supply), which is
  what DC protection sensitivity needs.
- **L4** — Capacitor and DC-motor sources are not modelled (documented). A UPS
  DC link is not a source either.
- **L5** — The module docstring and help cite "IEC TR 60909-4" for the converter
  factor. That report holds AC worked examples and does not support the factor.
- **L6** — `testing/case-dc-shortcircuit/results.md` explains the published
  4796 A vs engine 4769 A as "input rounding". It is not: the published figure
  uses 0.95 × 120 V instead of 0.95·E_B = 0.95 × 126 V. The engine follows eq. 13.
- **L7** — A converter's reported `r_mohm` is the network resistance only, which
  means nothing for a current source.
- **Source note** — CED Example 3's τ_2D = 4.58 ms does not follow from its own
  eq. 41 (which gives 3.5–3.8 ms). Check against a licensed copy before pinning
  a test to τ_2D.

## 5. Verdict and fix order

The battery arithmetic is exact against the published example. The engine
around it under-reports in the configurations that matter most: any
rectifier-fed DC board (DC1, ~−87 %), a battery drawn with its lead cable (DC2,
source lost), parallel cables (DC3, −26 %) and hot cable resistance (DC4, up to
−22 %). All four are non-conservative for equipment duty.

Suggested order: **DC3 + DC5** (one nodal rewrite, also covers L1) → **DC2** →
**DC4** → **DC1** (new props, AC-side data from the fault engine, UI fields) →
**DC6** (1/δ now; Figure 10 when the data is available).

## 6. Fixes (2026-09-29)

Every Phase 2 script re-run after the fixes. Fixtures store library-style hot
resistance (20 °C × 1.275), since the engine now refers it back to 20 °C:

| Script | Case | Before | After |
|---|---|---|---|
| v1 | Example 1 peak, terminals / breaker | 0.01 % / 0.00 % | 0.01 % / 0.00 % (unchanged) |
| v1 | t_pB terminals / breaker, vs Figure 10 (4.6 / 6.8 ms) | 2.18 / 3.42 ms (−53 % / −50 %) | 4.62 / 6.79 ms (on the figure's lines) |
| v1 | τ_1B terminals / breaker, vs Figure 10 (0.78 / 1.19 ms) | 0.73 / 1.14 ms | 0.78 / 1.19 ms |
| v2 | battery behind its own lead | 0 A (−100 %) | **0.00 %** |
| v2 | parallel cables, either drawing direction | −26 % / 0 % | **0.00 %** / 0.00 % |
| v3 | two batteries through a common cable, i_p / I_k | +36 % / +33 % | **+0.01 % / 0.00 %** |
| v3 | no common branch (F1) | 0.00 % | 0.00 % (unchanged) |
| v5 | 50 m 95 mm² Cu, 20 °C | −12.5 % | **0.00 %** |
| v6 | cable tee through a CB | 0.00 % | 0.00 % (unchanged) |
| v6 | L = 0 at the battery bus | t_p 50 ms, τ 30 ms | 1/δ = 0, t_p 0 |
| v6 | switch-mode charger through 2 Ω | 300 A (> U/R) | 52 A (U/(R_int + R)) |
| v7 | Annex A at Example 3's published ratios: λ_D, κ_D, t_pD, τ_1D | — | 0.897, 1.2175 (pub 1.204 from rounded ratios), 9.65, 3.75 ms |
| v7 | Example 3 drawn (utility → AC bus → rectifier → 2 mΩ): I_kD, i_pD vs eq. 54–56 by hand | 2.50 kA (−87 %) | **0.00 %** (19.35 / 23.80 kA at c = 1.10) |

**Implementation.** One nodal solve per fault (`_Island.contributions`): every
source is a Thevenin branch (battery E, 0.9·R_B for the peak and 0.95·E, R_B
for the quasi steady-state; switch-mode converter U, U/I_lim), the fault node is
held at 0 V, and each contribution is the fault current with only that source's
EMF active. A bridge rectifier's partial is computed per IEC with its own path
(common branch included) and scaled by the σ_j of its linearised branch.
Rectifier AC data: `thevenin_z1_at_bus` (IEC 60909 maximum, c = 1.10) at the
bus the `ac_in` side reaches, plus the supply cable at 20 °C, plus the converter
transformer (`tx_kva`, `tx_uk_pct`, `tx_xr`, `tx_secondary_v`), all referred to
the secondary; `l_dc_uh` is the smoothing reactor. With nothing on `ac_in` the
supply is taken as infinite and a warning is raised.

**Pre-existing tests.** Three `TestDCShortCircuit` fixtures and the
verification case fed a cable resistance meant at 20 °C through `r_per_km`,
which the app treats as a hot library value: the fixtures now store it × 1.275
(the expected numbers — including the template's 5422 A — are unchanged). The
charger test was about a current-limited converter, so it now declares one
(`bridge_type: switch_mode`).

**DC6 — Figure 10.** IEC 61660-1:1997 Figure 10 (supplied by the project
owner) plots t_pB and τ_1B against 1/δ as straight lines on log-log axes over
0.5–20 ms. Digitised from the image's own gridlines (≈ 600 points per line, fit
residual ≤ 3 %): **t_pB = 3.055·(1/δ)^0.928**, **τ_1B = 0.497·(1/δ)^1.019**
(ms). These replace the CED readings: at 1/δ = 1.56 ms the figure gives
4.6 / 0.78 ms (CED "around 4.3" / 0.75); at the breaker, 1/δ = 2.37 ms, it
gives **6.8** / 1.19 ms where CED quotes 5.4 / 1.3 ms — CED's time to peak is a
misreading of the figure (5.4 ms sits at 1/δ ≈ 1.85 ms). Outside 0.5–20 ms the
lines are extended.

**Still open.** L2 (sum of partial peaks), L3 (minimum current) and L4 (capacitor, DC
motor) are unchanged and recorded in `BACKLOG.md`. DC load flow still drops a
source behind its own lead cable (same helper) — for its own review (#32).
L5 fixed (citation removed), L6 corrected in the case notes, L7: a switch-mode
converter now reports its Thevenin branch resistance.
