# ETAP Golden Values — Short-Circuit Reference

**Source:** https://powerprojectsindia.com/short-circuit-current-calculations-for-symmetrical-and-unsymmetrical-faults/
**Retrieved:** 2026-07-11 (page HTML + 48 source images archived in `source-images/`, page snapshot in `source-page.html`)
**Method on the page:** Per-unit symmetrical components, 100 MVA base, IEC 60909-style source/transformer conversion (transformer K_t correction explicitly applied), hand-calc cross-checked against ETAP short-circuit module.

This file is the **single source of truth** for what ProtectionPro is being verified against. All numbers are transcribed verbatim from the page images (not the WebFetch text summary, which was unreliable). Every result was read directly from the calculation tables and the ETAP one-line screenshots.

---

## Common system data (all three cases)

| Element | Data |
|---|---|
| **Base** | 100 MVA |
| **Grid / Utility** | 40 kA @ 110 kV ⇒ S″k = √3·110·40 = **7620.80 MVA** (page rounds to **7621.023 MVAsc**), X/R = **14**, Wye–solidly grounded |
| **Grid Z (100 MVA base)** | R = 0.09349 %, X″ = 1.30883 %, R/X″ = 0.07  →  Z1 ≈ 0.0009349 + j0.0130886 p.u. |
| **Transformer T (25 MVA)** | 25 MVA, 110/11 kV, Z = **10 %**, X/R = **20** (R/X = 0.05) |
| **T impedance on 100 MVA base** | uncorrected 0.019975 + j0.399501 p.u.; K_t (IEC 60909-0) = **0.985918684**; corrected **Z_T = 0.019693772 + j0.393875437 p.u.** |
| **Voltage factor** | Page presents results **without** the c-factor (V = 1.0 p.u.) as the value that matches ETAP, and separately tabulates a "× 1.1 (c-factor)" column. See the **critical note** at the bottom. |

The base current at 11 kV is used to convert every 11 kV bus result:

    I_base = 100 MVA / (√3 · 11 kV) = 5.248793 kA

---

## CASE 1 — No load

One-line: `GRID → Bus3 (110 kV) → T1 (25 MVA, 110/11 kV, Z=10 %, X/R=20) → BusDuct2 (segregated-phase Cu) → Bus4 (11 kV)`. **Fault applied at Bus4.**

Sequence impedances used (p.u. on 100 MVA base):
- Z1 = Z2 = 0.02062867 + j0.40696407  (≈ R1 2.06 %, X1 40.7 %)
- Z0 = 0.01969377 + j0.39387544  (≈ R0 1.97 %, X0 39.4 %)  — grid Z0 blocked by Dyn transformer; Z0 is the transformer's grounded-star branch.

| Fault type | I_f (p.u.) | **I_f actual (kA) = ETAP** | With c = 1.1 (kA) | ETAP screenshot |
|---|---|---|---|---|
| 3-phase | 2.454069 | **12.881** | 14.16899 | 12.881 kA ∠−87.1° |
| SLG (1-φ-G) | 2.48069072 | **13.0206315** | 14.3226947 | 13.02 kA |
| LL (φ-φ) | 2.125223 | **11.15486** | 12.27034 | 11.155 kA |
| LLG (2-φ-G) | 2.507897 | **13.16343** | 14.47977 | 13.163 kA |

---

## CASE 2 — With motor load

One-line: `GRID → Bus8 (110 kV) → T3 (25 MVA, 110/11) → BusDuct1 → Bus7 (11 kV) → Cable8 (Cu, 10 m, R=0.098 Ω, X=0.09 Ω) → Bus10 (11 kV) → Mtr3`. **Fault applied at Bus7.**

Motor **Mtr3**: 5 MW induction, 11 kV, η = 90 %, PF = 95 % ⇒ S = √3·11·306.9 A = **5.847 MVA**. X″ = **0.15319 p.u.** (15.319 %) on motor base; R = X″/(X/R). (Note: SLD annotates X/R = 35, while the ETAP input-echo table shows R/X″ = 0.09 i.e. X/R ≈ 11 — **ambiguity flagged**, see PLAN.)
Cable8 on 100 MVA base: R = 6.35 %, X = 7.44 %, Z = 9.78 %.

Sequence impedances (p.u. on 100 MVA base, network+motor in parallel): R1 ≈ 2.08 %, X1 ≈ 35.4 %; R0 1.97 %, X0 39.4 %.

| Fault type | I_f (p.u.) | **I_f actual (kA) = ETAP total** | With c = 1.1 (kA) | ETAP screenshot (total / grid / motor) |
|---|---|---|---|---|
| 3-phase | 2.824214209 | **14.82371514** | 16.30608666 | Bus7 total **14.813**; grid 12.881; motor 1.936 |
| SLG | 2.72101673 | **14.2820529** | 15.7102582 | 14.273 kA |
| LL | 2.44577 | **12.83734** | 14.12107105 | 12.825 kA |
| LLG | 2.625095 | **13.77858** | 15.15643825 | 13.778 kA |

---

## CASE 3 — With motor load AND lump load

One-line: `GRID → Bus6 (110 kV) → T2 (25 MVA, 110/11) → BusDuct4 → Bus5 (11 kV)`, and at Bus5: `Lump2 (18 MVA)` plus `Cable21 (Cu, 10 m, R=0.098, X=0.09) → Bus11 → Mtr1 (5 MW)`. **Fault applied at Bus5.**

- **Mtr1**: identical to Mtr3 (5 MW, 5.848 MVA, X″ = 15.31 %).
- **Lump2**: 18 MVA, 11 kV, PF = 85 %, FLA 944.8 A. **Modeled on the page as a MOTOR load** (fault contributor): machine-base %R = 1.53, %X″ = 15.31, R/X = 0.10, Delta. On 100 MVA base: 0.015308 + j0.85044444 p.u.

Sequence impedances (p.u. on 100 MVA base): R1 ≈ 1.77 %, X1 ≈ 25.0 %; R0 1.97 %, X0 39.4 %.

| Fault type | I_f (p.u.) | **I_f actual (kA) = ETAP** | With c = 1.1 (kA) | ETAP screenshot |
|---|---|---|---|---|
| 3-phase | 3.99635049 | **20.9760156** | 23.07361717 | Bus5 **20.95** kA |
| SLG | 3.3526143 | **17.5971777** | 19.35689548 | 17.584 kA |
| LL | 3.46084 | **18.16523** | 19.98175 | 18.14 kA |
| LLG | 2.887494 | **15.15586** | 16.67144 | 15.153 kA |

---

## ⚠ CRITICAL METHODOLOGY NOTE — the voltage factor (c)

The page's **ETAP screenshots match the "I_f actual" column, which uses V = 1.0 p.u. (c = 1.0)**. The "× 1.1" column is a separate hand-calc add-on that ETAP does **not** reproduce here.

ProtectionPro's `fault.py` **hard-codes `C_MAX = 1.10`** into every fault current (and into the utility-feeder equivalent impedance), with a code comment noting "there is no project-level tolerance setting yet." Consequences:

- ProtectionPro's raw output will be ≈ **1.10 × the ETAP screenshot values** — i.e. it should land very close to the page's **"× 1.1" column**, not the ETAP column.
- To compare against the ETAP screenshots, ProtectionPro's result must be **divided by 1.10**, OR the code must be changed to make `c` configurable.

This is the single most important decision for the verification methodology and is raised as Question 1 in `PLAN.md`.

## Secondary modeling notes to resolve before execution
1. **Lump load (Case 3):** ProtectionPro's `static_load` does **not** contribute fault current — it is not treated as a source in `_collect_source_paths`. To reproduce Case 3 the 18 MVA lump must be modeled as an **induction motor** equivalent, else the app under-predicts by the lump's contribution.
2. **Motor X/R ambiguity (Cases 2 & 3):** SLD says X/R = 35; the ETAP input-echo table implies X/R ≈ 11 (R/X = 0.09). The X/R mainly affects R (and thus peak/asymmetrical values), less so |Z| and I″k. Pick one and document it.
3. **Cable per-unit base:** Cable8/Cable21 given in ohms (R = 0.098, X = 0.09, 10 m). ProtectionPro takes `r_per_km`/`x_per_km` × `length_km`; enter as 9.8 Ω/km & 9.0 Ω/km × 0.01 km (or 0.098/0.09 Ω/km × 1 km). Zero-sequence cable data not given on the page (Z0 path is through the transformer only).
