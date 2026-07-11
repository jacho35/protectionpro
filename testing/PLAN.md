# Verification Plan — ProtectionPro vs. ETAP (Short-Circuit)

**Goal:** Verify ProtectionPro's short-circuit engine against the published ETAP-validated worked examples at
https://powerprojectsindia.com/short-circuit-current-calculations-for-symmetrical-and-unsymmetrical-faults/,
working from basic (Case 1) to complex (Case 3), documenting matches with screenshots and qualifying every discrepancy.

**Status:** ✅ Complete — 12/12 PASS within 0.13 %. See [`README.md`](README.md) scorecard. Decisions locked 2026-07-11 (see § Decisions).

## Decisions (locked)
1. **c-factor:** Make the IEC 60909 voltage factor `c` configurable (default stays 1.10) and run verification with **c = 1.0** to match the ETAP screenshots directly. The transformer K_T correction keeps its internal `c_max = 1.10` (K_T always uses c_max per IEC 60909-0 §6.3.3 — confirmed: reproduces the article's K_t = 0.985919).
2. **Tolerance:** PASS if within **±2 %** of the ETAP value; anything beyond is investigated and qualified.
3. **Case 3 lump load:** Run **both** — (a) as an induction-motor equivalent (matches ETAP) and (b) as `static_load` (quantifies what the app's static-load model omits).
4. **Screenshots/scope:** Capture real app screenshots **headlessly via the `verify` skill**; short-circuit first, then look for / ask about further ETAP examples to broaden into.

---

## 1. What is being verified

The source article contains **3 progressively complex cases**, each solved for **4 fault types** = **12 comparison points**, all on a common 100 MVA base, 110/11 kV network, fault at the 11 kV bus. Full extracted inputs and golden numbers are in `reference/etap-golden-values.md`.

| Case | Network | Fault bus | Adds |
|---|---|---|---|
| 1 | Grid → T (25 MVA) → 11 kV bus | Bus4 | baseline |
| 2 | Case 1 + Cable + 5 MW induction motor | Bus7 | motor fault contribution |
| 3 | Case 1 + 5 MW motor + 18 MVA lump load | Bus5 | multiple contributors |

Fault types per case: **3-phase, SLG (1-φ-G), LL (φ-φ), LLG (2-φ-G)**.

**Scope decision needed:** This one article is the full short-circuit scope. Whether the exercise extends to other analyses (load flow, arc flash, cable sizing) or other source pages is Question 4.

---

## 2. Mapping to ProtectionPro

| Article element | ProtectionPro component + props |
|---|---|
| Grid 40 kA @110 kV, X/R 14 | `utility`: `fault_mva=7621.023`, `x_r_ratio=14`, `grounding=solidly`, `voltage_kv=110` |
| Transformer 25 MVA, Z=10 %, X/R=20 | `transformer`: `rated_mva=25`, `z_percent=10`, `x_r_ratio=20`, `voltage_hv_kv=110`, `voltage_lv_kv=11`, vector group giving a grounded-star 11 kV side (e.g. `Dyn11`) |
| BusDuct (segregated Cu) | modeled as short `cable` or ideal bus link (near-zero Z; article treats as negligible) |
| Cable 10 m, R=0.098 Ω, X=0.09 Ω | `cable`: `r_per_km=9.8`, `x_per_km=9.0`, `length_km=0.01` (or 0.098/0.09 × 1 km) |
| 5 MW induction motor | `motor_induction`: `rated_kw=5000`, `efficiency=0.90`, `power_factor=0.95`, `x_pp=0.15319`, `x_r_ratio=` (Q2) |
| 18 MVA lump load (Case 3) | **modeled as `motor_induction`** equivalent per Q3, OR `static_load` (no fault contribution) |

**Engine facts already confirmed by reading `backend/analysis/fault.py`:**
- Applies IEC 60909 transformer correction factor K_T — matches the article's K_t = 0.9859. ✅
- Motor MVA = kW/(η·PF) — matches article's 5.848 MVA. ✅
- Utility Z from `c·S_base/S″k` — matches article's grid conversion. ✅
- **Hard-codes `c = 1.10`** into all fault currents → see Question 1. ⚠
- `static_load` is **not** a fault source → see Question 3. ⚠

---

## 3. Execution method (per case)

1. **Build the network** as a ProtectionPro project JSON (saved under `testing/case-N-*/project.json`), reproducing the exact one-line and inputs.
2. **Run fault analysis** for each of the 4 fault types. Two channels:
   - **Numeric (authoritative):** POST the project JSON to `/api/analysis/fault` (per bus, per fault type) via the running backend and record `ik3 / ik1 / ikLL / ikLLG` in kA.
   - **Visual (deliverable):** drive the frontend headlessly via the `verify` skill to capture screenshots of the result badges on the one-line, per the user's screenshot requirement.
3. **Compare** app result (adjusted per the Question 1 decision) against the ETAP golden value.
4. **Record** in `testing/case-N-*/results.md`: a table of ETAP vs App vs % error vs PASS/FAIL, plus the screenshot(s), plus a short note on any discrepancy and its likely cause.

---

## 4. Deliverables (folder layout)

```
testing/
  PLAN.md                         ← this file
  README.md                       ← summary + final scorecard (written last)
  reference/
    etap-golden-values.md         ← transcribed inputs + ETAP results (DONE)
    source-page.html              ← archived page (DONE)
    source-images/                ← 48 source PNGs (DONE)
  case-1-noload/
    project.json                  ← reproducible ProtectionPro model
    results.md                    ← ETAP vs App table + discrepancy notes
    screenshots/                  ← app one-line + result badges
  case-2-motor/ …
  case-3-motor-lump/ …
```

Final `README.md` carries a **scorecard** (12 points: PASS within tolerance / FAIL / qualified) and a consolidated discrepancy register.

---

## 5. Predicted discrepancies (hypotheses to confirm during execution)

1. **Systematic +10 % from the c-factor** — app output ≈ 1.10 × ETAP screenshots (app should instead match the article's "×1.1" column). Resolution per Question 1.
2. **Case 3 under-prediction** if lump load is left as `static_load` (app ignores its contribution). Resolution per Question 3.
3. **Minor % differences** in |Z| composition from BusDuct idealization and motor X/R choice — expected < 1–2 %.
4. **Angles** — app reports fault-current angles; the article's ETAP screenshots also show angles (e.g. −87.1°). These can be cross-checked as a bonus.

---

## 6. Open Questions (BLOCKING — see chat)

1. **c-factor handling** — the decisive one. Compare app÷1.1 to ETAP, change code to make c configurable, or compare app directly to the article's "×1.1" column?
2. **Motor X/R** — use 35 (from SLD) or ~11 (from ETAP input echo)?
3. **Lump load (Case 3)** — model as induction motor (matches article) or as static load (app ignores it)?
4. **Scope & screenshots** — short-circuit only vs. broader; and headless-app screenshots via `verify` skill vs. manual.
5. **Match tolerance** — ±1 %, ±2 %, or ±5 %?

Once these are answered, this plan is updated and execution begins case-by-case.
