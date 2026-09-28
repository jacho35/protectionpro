# Cable Sizing Review

*Review date 2026-09-28, method per `ENGINE_REVIEW_METHODOLOGY.md`, against
IEC 60364-5-52, IEC 60364-4-43, IEC 60949, IEC 60255-151 and IEC 60909-0 §12.
Findings CS1–CS5 and lesser notes N1–N6 (N5 withdrawn), all fixed.*

Evidence scripts: `testing/cable-sizing-review/` (run from the repo root in
the backend image, `docker run --rm -e PYTHONPATH=/work -v "$PWD":/work -w
/work protectionpro-backend python testing/cable-sizing-review/v1_core.py`).

## 1. Scope

`backend/analysis/cable_sizing.py`: thermal rating, voltage drop, fault
withstand, recommendation search. Not covered: the IEC 60364-5-52 table
transcription and frontend ampacity calculator (tracker item 2), the NEC
path, single-phase circuits (the SLD is three-phase).

## 2. What holds up

| Checked against | Result |
|---|---|
| √3·I·L·(R cos φ + X sin φ)/U (IEC 60364-5-52 Annex G) with the right U | 9.492 % hand vs 9.49 % |
| k, IEC 60364-4-43 Table 43A, Cu/Al × PVC/XLPE ≤ 300 mm² | 143 / 94 / 115 / 76 exact |
| Bare-conductor k by the IEC 60949 formula, 80 → 200 °C | 128.5 / 84.9 vs 129 / 84 |
| R(θ) = R20·(1 + α(θ − 20)) | ×1.275 / ×1.282 / ×1.20 exact |
| m, IEC 60909-0 §12 | same equation |
| √ ambient law vs Table B.52.14 | ≤ 0.5 % (see N5) |

## 3. Findings (marked `[CSn]` in code)

| # | Defect | Before → after |
|---|---|---|
| CS1 | Volt drop divided by the cable's own `voltage_kv` — its rated class or the palette default 11 kV — not the voltage it runs at | LV cable at the 11 kV default: 0.35 % → 9.49 % (hand 9.492 %); an 11 kV-class cable on 3.3 kV no longer understated 3.3× |
| CS2 | Clearing time 50 ms (80 ms ACB) whenever `magnetic_pickup` was set — every palette breaker — ignoring relays and whether the current reaches the setting | 11 kV feeder on a SI relay (200 A, TMS 0.3, 13.1 kA): 35 mm² passed at 50 ms → fails at 669 ms (relay curve 0.481 s = IEC 60255-151 exactly, + CT saturation + 80 ms opening). Far-end minimum fault (c_min) now checked too |
| CS3 | No IEC 60364-4-43 §433.1 check (Ib ≤ In ≤ Iz, I2 ≤ 1.45·Iz) | 160 A MCCB on a 91 A cable: pass → fail; I2 = 1.45 In MCB, 1.30 In MCCB/ACB, 1.6/1.9/2.1 In gG fuse; LV only; Iz of all parallel conductors |
| CS4 | Volt drop judged per cable, not from the origin (§525, Table G.52.1) | 2.67 % + 3.2 % both passed with 5.85 % at the load → K2 fails on Σ 5.83 % from the transformer-fed bus |
| CS5 | Withstand used Ik3 only | Largest of Ik3 / Ik1 / Ik2 / Ik2E (Dyn11 LV bus: 41.17 kA LLG vs 39.66 kA Ik3) |

Design decisions:

- **CS2** reuses the arc-flash/TCC device models (`_relay_operate_time`,
  `_cb_self_clearing_time`, `_fuse_prearc_time`) but without the 2 s IEEE
  1584 cap; a fault not cleared within 5 s fails, except at the far end when
  §433.1 holds (§435.1). No device modelled → 100 ms assumed and flagged.
  The far-end minimum uses a second fault run at c_min (0.95 LV / 1.0 MV);
  the fault engine's `conductor_temperature_c` option is not used because it
  rescales an `r_per_km` that is already at operating temperature (noted for
  the fault engine).
- **CS4** reads the cumulative drop from the load-flow bus voltages: origin =
  the bus of the same voltage zone fed directly by a source or transformer.
  A cable feeding a load directly gets a synthetic terminal bus, as load flow
  already does internally.
- The recommendation honours all four checks: a size must restore §433.1
  (which also restores the far end), keep Σ drop within the limit, and meet
  the largest-current withstand. A cable with no library type is recommended
  at the system's voltage class.

## 4. Lesser notes (marked `[Nn]`)

| # | Note | Fix |
|---|---|---|
| N1 | Area back-calculated from r_per_km (95 mm² Al read 88.1) | `size_mm2` prop wins |
| N2 | PVC > 300 mm² used 115/76 | 103/68 (Table 43A) |
| N3 | Unlisted insulation → 143 even for Al | conductor's PVC k, with a warning |
| N4 | Non-IEC install factors (flat 0.95, buried 0.85); buried used the 30 °C air reference | removed; buried selects the ground table (20 °C, B.52.15); the library-rating path says grouping/method are not applied |
| N5 | *Withdrawn*: the review compared the √ law with a mis-read PVC 25 °C value (1.03; the table gives 1.06). The law was within 0.5 %. The engine now reads Tables B.52.14/15 directly anyway (needed for N4) |
| N6 | Overhead √ ambient law presented as a rating | labelled approximate in the result (IEC 60364 does not cover bare conductors) |

**Behaviour change for saved projects:** re-run cable sizing. Results now
fail for oversized protective devices, relay/long-time clearing, and
cumulative drop; LV cables left at the 11 kV default show their real drop.

Tests: `backend/tests/test_cable_sizing_review_fixes.py` (27).
