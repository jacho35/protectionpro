# CT Saturation Model Review

*Review date 2026-09-29, method per `ENGINE_REVIEW_METHODOLOGY.md`, against
IEC 61869-2 (class P / PR / PX / TPx definitions, accuracy-limit EMF,
transient dimensioning factor Ktf), IEEE C37.110 (time to saturation) and
IEC 60255-151 (IDMT operate time). Scope: `backend/analysis/ct_model.py`,
its mirror in `frontend/js/constants.js` (`ctSaturationParams`,
`ctEffectiveCurrent`), and its two consumers — arc-flash relay clearing time
(`arcflash._relay_operate_time`) and the duty check's CT Saturation Adequacy
table. Findings C1–C4 and lesser notes L1–L3, all fixed (marked `[Cn]` / `[Ln]`
in code).*

Evidence: `testing/ct-model-review/` — run from that directory in the
backend image, e.g.
`docker run --rm -v "$PWD":/work -v "$PWD/testing/ct-model-review":/s -w /s protectionpro-backend python v2b_transient.py`.

## Independent reference

`ctsim.py` is a time-domain square-loop CT: resistive secondary loop
(Rct + burden), no magnetising current below saturation, secondary current
zero while the primary drives the flux beyond ±Ψsat (Ψsat = √2·Vsat/ω).
The primary current is either symmetrical or fully offset,
i = √2·I·(e^(−t/Tp) − cos ωt). The relay measures the one-cycle DFT
fundamental and integrates the IEC 60255-151 curve dynamically
(∫dt / t(M) = 1). Delays are always quoted as the saturated simulation
minus the same simulation with an ideal CT, so the DFT window cancels. The
reference assumes zero remanence (the most favourable case).

## 1. What held up

| Checked | Result |
|---|---|
| Saturation-angle clipping, θ = acos(1 − 2Ks), RMS η = √((θ − sin 2θ / 2)/π) | matches the simulated steady-state RMS to 0.5 % across Ks = 0.1 to 0.95 (`v1_clip.py`) |
| Saturation onset at Ks = 1 (knee EMF = I·(Rct + Rb)) | consistent with the square-loop flux swing |
| Accuracy-limit EMF E_AL = ALF·Isn·(Rct + Rb) | IEC 61869-2 definition, correct |
| Ratio parsing, backend/frontend parity (ratio, burden, Rct, knee) | identical, including malformed input |
| Guards (i ≤ i_sat, ks ≥ 1, non-finite threshold) | sound |

## 2. Findings

| # | Defect | Evidence → proposed fix |
|---|---|---|
| C1 | **The clipped current is the true RMS; relays measure the fundamental.** Numerical IEC 60255-151 relays filter to the fundamental (DFT). The fundamental of a clipped wave is lower than its RMS (the energy moves into harmonics), so the model understates saturation delay. **Non-conservative** for arc-flash clearing times and TCC grading. The frontend has the same defect | Symmetrical sim, SI 400 A TMS 0.3, 400/5 5P20, 32 kA: true delay 220 ms, engine 137 ms (−38 %); EI 800 A TMS 0.2, 16 kA: 134 vs 68 ms (−49 %). At Ks = 0.3 the RMS is 1.37× the fundamental. Fix: fundamental η₁ = √((θ − sin 2θ/2)² + sin⁴θ)/π, which matches the simulated DFT within 2 ms in every case |
| C2 | **Burden and Rct have no effect unless a knee voltage is entered, and the connected burden is not modelled.** The auto knee is 0.8·ALF·Isn·(Rct + Rb) and onset is Vk/(Rct + Rb), so both cancel: onset is always 0.8·ALF·Ipn. `burden_va` is the *rated* burden (its tooltip says so), and there is nowhere to enter the burden the CT actually drives (relay plus leads). An overburdened CT, most often a 5 A secondary with long leads, is invisible. A user who types their real 60 VA into "Burden" sees no change. **Non-conservative** | 400/5 5P20: burden 2.5 / 15 / 30 / 60 VA → I_sat 6400 A every time (`v3_edges.py`). A 15 VA core driving 30 VA (leads) really has ALF′ = 20·(0.3 + 0.6)/(0.3 + 1.2) = 12, so the engine is 67 % optimistic. Fix: new `connected_burden_va` (relay plus lead loop; absent or 0 = rated burden, so legacy projects are unchanged), with ALF′ = ALF·(Rct + R_rated)/(Rct + R_connected), the textbook and manufacturer criterion. Mirror it in the frontend with a tooltip |
| C3 | **The κ "dc-offset proxy" is not the physics of dc saturation.** The flux demand of an offset current is the IEC 61869-2 transient factor Ktf = 1 + ωTp·(1 − e^(−t/Tp)), up to 1 + X/R (11 at X/R = 10), not κ (1.75). Dividing the knee by κ misses dc saturation entirely when the symmetrical current is below the κ-derated threshold, and grossly overstates it elsewhere. It also breaks the documented TCC parity, because the frontend has no κ. In the duty check the `dc_offset_factor` column implies coverage the model does not give | 1200/1 5P20 10 VA, EI, X/R 40, 10 kA (below the symmetrical threshold): true delay 215 ms, engine 0. Across 324 cases (`v2c_candidates.py`), the κ model under-reads by more than 5 ms in 47 cases (worst −213 ms) and over-reads by up to +2.0 s. **Fix approach needs a decision; see §4** |
| C4 | **Accuracy-class parsing silently fabricates ALF 20.** `5PR10` (IEC 61869-2 low-remanence class) → 20 (should be 10, **2× non-conservative**); `5P 10` → 20; `PX`, `TPX/TPY/TPZ`, ANSI `C200` and metering classes (`0.5`, `0.5FS5`) → 20 with no warning | `v3_edges.py`. Fix: parse PR and tolerate spaces. For ANSI C-class, use E_AL = V_C + 20·Isn·Rct. For PX/TPx without a knee, and for a metering core feeding a relay (use FS as the limit factor when given), warn in the duty check instead of guessing |

## 3. Lesser notes

| # | Note | Proposed fix |
|---|---|---|
| L1 | With the auto-derived knee, the square-loop model contradicts the class definition. The engine clips hard from 0.8·E_AL, so at ALF·In and rated burden it reports 7.4 % RMS (11.9 % fundamental) error, where 5P guarantees ≤ 5 % composite. This is conservative, but after C1 it would compound | Saturation EMF = E_AL when derived from the class (onset exactly at ALF′·Ipn, the standard's own criterion); keep Vk as the saturation EMF when a PX knee is entered (conservative, since saturation sits above the knee) |
| L2 | `rct_ohm` = 0 is read as unset, and the shipped default is an explicit 0.3 Ω, so the 3 Ω fallback for 1 A cores never fires. After C2, Rct always matters | New CTs default `rct_ohm` to 0 = typical for the secondary rating; tooltip says so |
| L3 | Duty check uses the bus Ik3 for every relay CT, including a core-balance CT on an earth-fault relay (should be Ik1). Differential (87) and distance (21) relays need transient dimensioning (Ktd), which a symmetrical check does not cover | Use Ik1 for `core_balance` CTs; for 87/21 relays report "transient dimensioning (Ktd) not checked" |

## 4. C3 decision and result

Chosen: **the square-loop time-domain CT in the arc-flash relay timing**
(`ct_model.ct_fundamental_series`, 64 samples/cycle, full offset, zero
remanence). The relay time is the TCC-consistent symmetrical time plus the
dc-offset delay: the relay's operate time over the offset waveform minus
over the symmetrical one, both through the same CT and one-cycle DFT. The
51 element is integrated as ∫dt/t(I) = 1, the 50 element as a resetting
definite timer. X/R comes from κ (IEC 60909-0 Eq. 55 inverted). The
simulation is skipped when (1 + X/R)·I·Z ≤ V_sat, because the core cannot
saturate.

Against the 400-sample reference over 243 cases (`v4_engine_vs_ref.py`):
no under-read above 8 ms, mean error 9 ms, worst over-read +73 ms, and
1.8 ms per evaluation. The rejected alternatives were a fitted 1.3·Tp
allowance (10 of 324 cases under-read) and keeping κ.

The duty check judges on the symmetrical criterion and reports effective
ALF′, X/R and the IEC 61869-2 / IEEE C37.110 time to saturation (new
"ALF′" and "t sat" columns). `dc_offset_factor` is kept as 1.0 for
compatibility.

**Behaviour change for saved projects:** re-run arc flash and the duty
check.
- Relay clearing times through a CT change. They are now longer wherever a
  fully offset fault saturates the CT, which at X/R ≥ 10 includes CTs that
  are symmetrically ample.
- CT adequacy verdicts move to the class criterion: the threshold rises
  from 0.8·ALF·I_pn/κ to ALF′·I_pn.
- CTs with a guessed accuracy class, or feeding 87/21 relays, now warn.
- In the TCC, a saturating CT's curve shifts. Clipping now starts at the
  accuracy-limit EMF (not 0.8 of it), and above that point it clips to the
  lower fundamental.

Tests: `backend/tests/test_ct_model_review_fixes.py` (27). Re-baselined,
with the reason recorded in each: `test_ct_model.py` (0.8·E_AL knee →
E_AL, RMS → fundamental, κ derating removed), `test_ct_duty_check.py` (κ
assertions → time to saturation; the marginal case re-tuned to 130 MVA),
and `test_arcflash_clearing.py`. The "unsaturated" fixtures used a 5P40
core, which a fully offset 4 kA fault at X/R 15 does saturate (it needs
64 kA of flux capacity), so they now use a 1000 V knee.

## 5. Verdict

The clipping mathematics is right. What it is fed and what it is compared with are wrong: RMS instead of fundamental, burden ignored, κ standing in for dc offset, and class strings guessed. C1, C2 and C4 are non-conservative on common real configurations, and C1 fires on every saturating CT at default settings. All fixed in that order.
