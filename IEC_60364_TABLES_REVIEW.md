# IEC 60364-5-52 Tables Review

*Review date 2026-09-29, method per `ENGINE_REVIEW_METHODOLOGY.md` — a
transcription check of `backend/analysis/iec_60364_tables.py` and its
frontend twin against IEC 60364-5-52:2009 Annex B. Findings T1–T5 and lesser
notes L1–L3, all fixed.*

## 1. Reference and method

No licensed copy of the standard was available, so the reference is the
TiSoft reproduction of Tables B.52.2–B.52.5, B.52.10–B.52.13 and
B.52.14–B.52.19 (rendered headlessly with `fetch_tisoft_tables.mjs`),
cross-checked against ecalpro's reproduction of Table B.52.2 (agrees except
1 A at A1 / 240 mm²: 320 vs 321). Two typos in the reproduction were
corrected and are flagged in the data file for confirmation against a
licensed copy:

- B.52.11, method F, two loaded, 185 mm² Al PVC printed **3463** → **363**
  (Al/Cu ratio of the neighbouring rows gives 362.6);
- B.52.18, 0.5 m clearance, 16 circuits printed **0.38** → **0.68**
  (12 → 0.71, 20 → 0.66).

The single source is `testing/iec-60364-tables-review/iec_60364_5_52_data.json`;
`build_iec_tables.py` generates `backend/analysis/iec_60364_data.py` and
`frontend/js/iec-60364-data.js` from it. `v1_diff.py` compares the engine
against the reference cell by cell.

## 2. What held up

| Checked | Result |
|---|---|
| Ambient factors, Tables B.52.14 (air) and B.52.15 (ground) | every value matched |
| Soil resistivity, Table B.52.16 | matched |
| B.52.17 "bunched" and "single layer on wall" rows | matched |
| Backend vs frontend copies | identical (380 values) — the defects were in the data, not drift |

## 3. Findings (all fixed, marked `[Tn]` in code)

| # | Defect | Evidence → fix |
|---|---|---|
| T1 | Base capacities not the standard's: only PVC-Cu A1/B1 matched; every C, D1, D2, E, F column and all XLPE A1 matched neither table, sitting above even the single-phase values (C +10.8 % median, max +16 %; F +14 %) | C / PVC-Cu / 16 mm² was 94 A (IEC 85 A single-phase, 76 A three-phase). Replaced by the reference: 0 differences over 76 columns |
| T2 | No loaded-conductor dimension — IEC tabulates two loaded (single-phase, B.52.2/3) and three loaded (three-phase, B.52.4/5) separately; three-phase circuits were rated 12–36 % high | `loaded` argument (default 3); SLD cables three-phase; DB ways 2 or 3 by pole count; calculators ask |
| T3 | Method columns shifted: engine "E" was IEC F (single-core touching), "F" was IEC G (spaced); descriptions shifted likewise; A2, B2, G had no data | all ten Table B.52.1 methods with the standard's descriptions and data |
| T4 | Grouping rows mislabelled ("floor" held the perforated-tray row, "tray touching" the ladder row, "trefoil" the wooden-ceiling row with 1.00 for 0.95, "tray spaced" unsourced); buried cables used the unburied Table B.52.17 | B.52.17 rows 1–5; B.52.18 (direct in ground) and B.52.19 (ducts) for D2/D1; legacy names map onto their IEC row. Six circuits touching, direct buried: 0.50, not 0.57 |
| T5 | "Depth of laying (Table B.52.18)" — B.52.18 is the burial grouping table; IEC 60364-5-52 has no depth factor; values unsourced and > 1 above 0.7 m | removed; depth accepted and ignored |

## 4. Lesser notes

| # | Note | Fix |
|---|---|---|
| L1 | Grouping interpolated between the listed counts (10 circuits between 9 and 12) and clamped beyond 20 silently | next listed count up (10 → the 12-circuit factor); beyond the table flagged |
| L2 | Soil factors are the buried-duct values; direct burial would be higher | kept (conservative), disclosed |
| L3 | Aluminium below 16 mm² returned nothing although IEC tabulates from 2.5 mm² | from the reference |

## 5. Effect on saved projects

Installed ratings fall — about 10 % single-phase and 12–36 % three-phase
for most methods. Cable sizing now **recomputes** each cable's saved
calculator block (`props.ampacity`) from its saved conditions with the
corrected tables, with a note on the result when the saved figure differs,
so projects saved before the fix are corrected on the next run. The DB
circuit check derates each way afresh. Re-run cable sizing and the circuit
check; re-apply the calculator to refresh the rating shown on the cable.

Tests: `backend/tests/test_iec_60364_tables_review_fixes.py` (29), including
cell-by-cell reference parity and backend/frontend parity.
`test_db_circuit_check.py::TestIecTables` re-baselined (it cited B.52.4 for
two-loaded values and pinned C 10 mm² at 70 A, in neither table).
