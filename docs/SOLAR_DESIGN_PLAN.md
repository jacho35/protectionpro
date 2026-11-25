# Solar PV design — plan

Agreed 2026-11-25 from a design canvas (nine boards: sizing on the site plan, roadmap, 3D roof, roof entry, sizing mode, string design, SLD generation, module / inverter library, flat-roof row spacing). Status (2026-11-25): **built** — engine, routes, tests for phases 1-3 and the closed-form parts of phase 4 (row spacing, obstruction shading, voltage rise); the Solar PV Design modal (`solar.js`) with five steps. Roof Detect / Draw on the plan is built (`plan-solar.js`, Plan › Solar › Detect roof). The project's own modules / inverters can be added in the modal's Library tab (kept in the project). The 3D roof view is built (`roof3d.js`, read only, modules and the obstruction shown, no cast shadows). **Open** — roof corner editing on the plan, moving the module / inverter libraries into the account / shared / company layers (`standard-data.js`, `user_libraries.py` keys), shading from real 3D geometry (cast shadows, hourly loss), battery / hybrid dispatch, load-flow / fault integration of the PV source, SLD generation of the isolator and string fuse parts.

## 1. Decisions taken

| Question | Decision |
|---|---|
| Where it lives | **Site plan** — a Solar tool next to the existing plan tools; the SLD gets the generated chain |
| First deliverable | System sizing and energy yield |
| Sizing input | **Both**: from usable roof area and from the Demand load total; the user picks roof capacity, load target or the smaller of the two |
| Irradiance data | **Bundled table** of monthly values per city (offline, repeatable, easy to test against hand calcs). PVGIS as an optional lookup later |
| Libraries | **New**: PV modules and inverters, same editable / resettable behaviour as the cable and transformer libraries; user and shared libraries like the others. Never a second cable list |
| Standards | A selectable pack per project. **SANS 10142-1-2 / NRS 097-2 and IEC 62548 / 60364-7-712 first**, NEC 690 later |
| Roof shapes | **Gable and flat (tilted racks)**. Ground mount later |
| Roof entry | **Detect** (as room / erf detect), **Draw** (nodes), and **Generate from a dialog** (as rooms are today). Node gestures follow the single table in `CLAUDE.md` |
| Export limit | **Sits on the connection point** (phase 3), not a project setting |
| Advanced | Shading and 3D roof, battery / hybrid and export limit, DC / AC protection and cable sizing, grid impact (fault, load flow, voltage rise) |

## 2. Phases

1. **Size and yield (backlog 121).** Roof entry, module library, array tilt / azimuth, sizing from roof or load, monthly and annual kWh with losses.
2. **Strings and inverter (122).** Series / parallel counts. Cold Voc and hot Vmp against the inverter's MPPT window and maximum voltage; per-MPPT current; DC/AC ratio; all modules used. Generate the PV source, string protection, isolator, inverter and AC breaker on the SLD (123).
3. **DC and AC protection (124).** String fuses (1.25 × Isc), DC isolators, SPDs, DC cable sizing and voltage drop, AC connection, export limit, inverter fault contribution. Reuses cable sizing, fault and compliance engines.
4. **Shading, storage, grid (125).** Flat-roof row spacing, then hourly shading from obstructions, 3D roof planes, battery and hybrid dispatch, voltage rise and load flow with solar.

## 3. Formulas pinned by tests

- Cold Voc = N · Voc · (1 + k_Voc · (T_min − 25)); hot Vmp = N · Vmp · (1 + k_Vmp · (T_cell − 25)). Limits: cold Voc ≤ inverter max DC V and ≤ module system voltage; hot Vmp ≥ MPPT min; Vmp (STC) ≤ MPPT max; strings on one MPPT × Isc ≤ MPPT max current.
- Row pitch = L·cos β + L·sin β / tan α, α the sun elevation at the design hour on the winter solstice: sin α = sin φ sin δ + cos φ cos δ cos h. Ground cover ratio = L / pitch.
- Roof capacity: modules = floor(usable area × packing factor / module area). Load target: kWp = annual kWh × share / specific yield; modules = ceil(kWp / module kW).
- Specific yield and monthly kWh from the irradiance table with tilt / azimuth factor and a loss stack.

## 4. Where it goes

| Piece | Home |
|---|---|
| Module / inverter data, library, defaults | `frontend/js/pv-library.js` (read through one accessor, like `CableLib`), `backend/analysis/pv_data.py` |
| Irradiance table (generated) | `backend/analysis/solar_irradiance_data.py` from a source file under `testing/`, generated, never hand-edited |
| Engine | `backend/analysis/solar_pv.py`: sizing, yield, string check, row spacing (pure functions) |
| Endpoints | `POST /api/analysis/solar-size`, `/solar-strings` in `backend/routes/analysis.py`; Pydantic models in `schemas.py`; client in `api.js` |
| Roof entry | `plan-solar-roof.js` (detect reuses `plan-roomdetect.js`, draw reuses the select-tool node gestures, generate reuses the room dialog) |
| Solar panel and results | `plan-solar-ui.js`, `solar-strings-ui.js` |
| SLD generation | `solar-sld.js`: places `solar_pv`, fuse, switch, inverter, breaker and wires, then hands over to the existing studies |
| 3D roof view | `roof3d.js` (CSS 3D, read-only first, edits stay on the plan) |

Each new file gets its entry in `docs/CODEMAP.md`, and the endpoints a section in `docs/ENGINES.md`, in the same PR. A new gesture needs the `CLAUDE.md` table and the help text updated in the same PR.

## 5. Tests

- `backend/tests/test_solar_pv.py`: closed-form hand calcs for each formula in §3, plus an inverter-limit failure case for each string check.
- A verification template (`testing/case-solar-*/`, `EXPECTED` in `testing/build_verification_templates.py`) once phase 2 lands.
- Node tests for the roof geometry (area, usable area after setback, row count) per the `docs/CODEMAP.md` node-test pattern.

## 6. Open questions

- The irradiance table covers all major South African cities and Hermanus (17 locations) but its annual means are approximate, not a licensed dataset. Replace them with PVGIS / SolarGIS monthly values before any certified use.
- Default inverter fault multiple and whether it is per-inverter or per-library entry.
