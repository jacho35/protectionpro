# Solar PV — accuracy and industry-parity scope

Status: proposed 2026-11-25. Nothing in this document is built yet.
Companion to `docs/SOLAR_DESIGN_PLAN.md` (the agreed phased plan, BACKLOG items 121–125). This scope covers what is
needed to move the module from screening grade towards results that can be compared with PVsyst, Helioscope and PVGIS.

## 1. Positioning

A roof-mounted commercial and industrial design tool that is integrated with the electrical studies (fault, load flow,
hosting capacity, arc flash, TCC, BESS). Not a PVsyst replacement and not a utility-scale ground-mount tool.

What already sets the module apart and is not in scope to change:

- The array is a real `solar_pv` component, so every network study runs on it.
- Roof geometry: gable, hip, mono, pyramid, cross-gable wings, flat, overhang and lean-to, with per-plane orientation.
- SANS / NRS 097-2 and IEC 62548 string and DC protection checks.

## 2. Current state (gaps against industry tools)

Reviewed from `backend/analysis/solar_pv.py`, `docs/ENGINES.md` and the frontend `solar*.js` / `roof*.js` / `plan-solar*.js`.

| Area | Today | Industry tools |
|---|---|---|
| Irradiance | Bundled monthly table per city (`solar_irradiance_data.py`), flagged screening grade | Hourly TMY from Meteonorm, PVGIS, NREL, SolarGIS |
| Time step | One representative day per month | Hourly or finer |
| Transposition | Isotropic sky (Liu-Jordan) | Perez, Hay-Davies |
| Losses | Fixed lumped stack: temperature, soiling, mismatch, wiring, inverter efficiency, availability | IAM, LID, low-light, spectral, clipping, degradation, per-string mismatch |
| Inverter clipping | Not modelled; DC/AC ratio reported only | Modelled hourly |
| Shading | Horizon blocks from obstructions; 3D view shows cast shadows, but nothing is integrated over the year | Annual 3D shading, per-string / substring electrical shading |
| Libraries | Small default module and inverter set plus user entries | Thousands of modules and inverters (`.PAN` / `.OND`) |
| Mounting | Roofs only | Ground mount, trackers, bifacial, terrain |
| Validation | None against an external reference | Bankable, benchmarked |

## 3. Work packages

Ordered by value for effort. Each is its own PR and follows the repo rules (tests, `docs/ENGINES.md` and
`docs/CODEMAP.md` entries, BACKLOG update, version bump).

### WP1 — Reference check (do first) — DONE 2026-11-25 (branch `solar-wp1-pvgis-reference`)
Quantify the current error before changing the model, so every later package shows a measured improvement.

- Run `solar_pv.py` against the PVGIS PV calculator for 3 South African locations (coastal, Highveld, Karoo) and 2
  array orientations each (north 30° tilt, flat east-west).
- Record annual and monthly differences.
- Pinned as a backend test (`test_solar_pvgis_reference.py`) with PVGIS values in `testing/solar/pvgis_reference.json`. Not added as an in-app verification template: that machinery is for engine hand calcs, and this is a model-error measurement.
- Done when: the error per location is documented in `docs/ENGINES.md` (as a result, not a file citation).

### WP2 — PVGIS hourly data
- New lookup of hourly TMY by latitude / longitude (server-side proxy; cache per rounded coordinate).
- Offline fallback to the bundled monthly table, clearly labelled as screening grade in the result.
- Project setting for site coordinates; the location picker already used by the Plan feeds it.
- Decision needed: PVGIS terms and rate limits allow server-side caching for this use; confirm before building.
- Done when: yield can be produced from hourly data and the result states its data source.

### WP3 — Hourly model: Perez, IAM, clipping, degradation
Depends on WP2 for hourly input.

- Perez transposition replaces isotropic sky (keep isotropic selectable for regression comparison).
- Angle-of-incidence loss (ASHRAE b0 or Martin-Ruiz) on beam and a fixed factor on diffuse and ground-reflected.
- Hourly inverter model with AC clipping at the inverter rating and a DC/AC-ratio-aware efficiency curve.
- Year-by-year degradation (first-year LID plus annual rate) and a 25-year energy table.
- The fixed loss stack stays for items without a model (soiling, wiring, availability); mismatch stays a percentage.
- Done when: results agree with the WP1 reference within an agreed tolerance (target ±3 % annual) and clipping appears
  in the result at DC/AC > 1.

### WP4 — Annual shading from the 3D geometry
- Reuse the `roof3d.js` scene: compute, per module and hour, whether the beam is blocked, using the same geometry as
  the cast shadows.
- Shading factor by module, aggregated per string; a string loses output in proportion to its shaded modules
  (simple series-string rule first; substring / bypass-diode behaviour is a later refinement).
- Replace the single-obstruction horizon for roofs that have a 3D scene; keep the horizon blocks for the modal's
  quick sizing.
- Done when: the result shows a monthly shading loss and a per-string table, and a flat-roof row-to-row case matches
  the closed-form row-spacing shading.

### WP5 — Module and inverter library import
- Importer for PVsyst `.PAN` and `.OND` files into the project library tab, and CSV import.
- Never overwrites user libraries (see the libraries and project-data principles); entries land in the project layer
  first.
- Done when: a module and inverter imported from PVsyst files produce the same string-check and yield inputs as the
  same parts entered by hand.

### WP6 — Report
- One Solar PV report (PDF through `pdf_reports.py`): site, array layout, loss tree, monthly and annual yield,
  string checks, DC protection, shading, data source and the reference-check result.
- User-facing text states results and sources, never a `.md` file.

## 4. Out of scope (separate decisions)

- Ground mount, trackers, bifacial and terrain. These need their own scope; PVcase and PVsyst already serve that
  market. Revisit after WP1–WP6 if customers ask.
- Sales proposals and finance modelling (Aurora / OpenSolar territory).
- Bankable certification. The module should be described as design grade, not bankable, in every report.
- NEC 690 standards pack and SPDs / AC cable sizing: tracked in BACKLOG #124 and the standards plan.

## 5. Order and dependencies

```
WP1 reference ──┬─> WP2 hourly data ──> WP3 hourly model ──> WP6 report
                └─> WP4 annual shading (independent of WP2/WP3 for geometry; needs hourly sun position, which WP2 provides)
WP5 library import (independent)
```

WP1 and WP5 can start immediately. WP3 and WP4 both need WP2.

## 6. Risks

- **Data licensing.** PVGIS and Meteonorm have usage terms; WP2 must confirm what may be cached and redistributed.
- **Performance.** Hourly yield per roof plane for 8760 h, plus per-module shading, must stay interactive in the
  modal. Compute server-side and cache by array geometry; run shading only on request.
- **Result drift.** WP3 changes every yield number. Existing projects keep their saved results (they restore on load),
  so the UI should mark the model version and prompt a re-run rather than silently differing.
- **Over-claiming.** Even after WP3, the output is design grade. Reports must say so until a bankable validation exists.
