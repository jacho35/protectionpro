# DB Circuit Check Review

*Review date 2026-09-29, method per `ENGINE_REVIEW_METHODOLOGY.md`, against
IEC 60364-4-41 (§411.4, §411.5, Table 41.1), IEC 60364-4-43 §433.1,
IEC 60364-5-52 (Annex G, Table G.52.1), IEC 60364-5-54 (§543.1, Tables 54.3
and 54.7) and IEC 60228. Findings DB1–DB4 and lesser notes L1–L5, all fixed.*

Evidence: `testing/db-circuit-check-review/v1_core.py` (run from the repo
root in the backend image with `PYTHONPATH=/work`).

## 1. What held up

| Checked against | Result |
|---|---|
| Supply loop Ze = \|Z1+Z2+Z0\|/3 from a hand source + transformer sequence calculation | 0.00832 Ω hand vs 0.0083 Ω |
| Phase resistance at 70 °C (IEC 60228 R20 × 1.20) | exact |
| Way volt drop 2·I·L·(r cos φ + x sin φ)/U0 (Annex G, b = 2) | 1.2063 % hand vs 1.206 % |
| Table 54.7 selection rule | correct |
| IEC 60898-1 magnetic upper limits (B 5, C 10, D 20 × In); c_min 0.95 | correct |
| Iz with 2/3 loaded conductors | from the reviewed tables (`IEC_60364_TABLES_REVIEW.md`) |

## 2. Findings (marked `[DBn]` in code)

| # | Defect | Evidence → fix |
|---|---|---|
| DB1 | A blank ECC was assumed to be the Table 54.7 size (= live conductor), described as the worst case — but reduced-CPC cables (twin-and-earth) comply with a smaller earth, so Zs was understated. Non-conservative | 60 m 2.5 mm² C20: blank passed at 1.075 Ω; the real 1.5 mm² CPC gives 1.41 Ω and 155 A < 200 A. Now the smallest compliant ECC is assumed, and the way **warns** when the twin-and-earth CPC for its size would fail |
| DB2 | ECC tested only against Table 54.7; IEC 60364-5-54 §543.1.1 also accepts the adiabatic §543.1.2 route | 20 m 2.5/1.5 mm² T+E failed; §543.1.2 needs 1.49 mm² (I = c_max·U0/Zs = 542 A, t 0.1 s, k 115). Now passes, citing the rule; the route is refused when the protection would not operate |
| DB3 | Cumulative volt drop measured from 1.0 pu, not from the installation origin. Non-conservative when the supply sits above 1.0 pu | Source at 1.05 pu, board 120 m from the LV bus: real 5.91 % read as 1.09 %, a ~7.1 % circuit passed. Now V_origin − V_board (origin = bus fed by the source/transformer, shared with cable sizing); MV/transformer drop above the origin no longer counts |
| DB4 | Aluminium ways used the copper library resistance | 16 mm² Al at 70 °C: 1.380 → 2.292 Ω/km (IEC 60228 1.91 × 1.20) |

Correction to the original report: its DB2 example quoted the 60 m way's
1.5 mm² CPC as needing "only 0.43 mm²" — wrong, since that way never reaches
the magnetic trip, so there is no disconnection time and the adiabatic route
cannot be credited (the engine now fails it). The 20 m way above is the valid
example.

## 3. Lesser notes (marked `[Ln]`)

| # | Note | Fix |
|---|---|---|
| L1 | RCD route used the TT 50 V/IΔn rule in TN systems | TN: Zs·IΔn ≤ U0 (§411.4.4, 7.7 kΩ at 30 mA); TT keeps RA·IΔn ≤ 50 V tested on Zs (§411.5.3). Earthing system from the source/transformer feeding the board |
| L2 | Ways below the magnetic trip always failed, although Table 41.1 allows 5 s for distribution circuits | IEC 60898-1 guarantees only its conventional points, so the thermal region is not credited from the standard; a per-way disconnection time from the device's curve (bulk-edit "Disc. t") passes when within the limit |
| L3 | Zs added \|Ze\| and R1 + R2 arithmetically | complex Ze + R1 + R2 |
| L4 | Demand factor 0 read as 1.0 | 0 kept |
| L5 | Volt-drop limits fixed at public-supply values | Table G.52.1 per board: public LV 3 %/5 %, private supply 6 %/8 % (Schedules toolbar "Supply") |

Observation, unchanged: by default all of a board's ways are grouped together
(conservative, labelled in the UI).

**Behaviour change for saved projects:** re-run the circuit check. Twin-and-
earth ways with a declared reduced ECC can now pass; blank-ECC ways may warn;
cumulative drops change to the origin basis; TN ways relying on an RCD pass
more readily.

Tests: `backend/tests/test_db_circuit_check_review_fixes.py` (14);
`test_db_circuit_check.py::TestEccVerdict::test_absent_ecc_is_info_and_zs_assumes_the_minimum`
re-baselined (it pinned the table-size assumption).
