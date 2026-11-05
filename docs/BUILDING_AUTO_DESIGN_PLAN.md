# Building auto design — plan and pending items

Automated placement and checking of fire detection, switches and sockets on the Building floor plan, in the same pattern as the reticulation **Auto layout** (`plan-layout.js` / `plan-layout-ui.js`).

Status: **planning agreed, step 1 built** (room geometry and detector coverage solver, `frontend/js/plan-bdgeom.js`). Everything else below is pending.

## 1. Decisions taken

| Question | Decision |
|---|---|
| Standards | SANS 10142-1 (sockets/lights), SANS 10139 / SANS 14520 (fire), BS 5839-1 / EN 54, IEC 60364 / NFPA 72. A **selectable design basis per project** (SANS default, BS 5839-1 + EN 54, NFPA 72): the engine is the same, each basis is a data table |
| Input | Detected rooms on the floor plan (Detect room / Detect all) |
| Scope | Place devices on the plan; route wiring / containment; feed the DB schedules; BOQ + checks + report |
| Interaction | Same as Auto layout: a tool with a rules panel, live preview on the plan, a Checks list with fixes, then Create writes real items tagged `auto:` and replaced by the next Create |
| Fire delivery | Placement + coverage proof + zones (not full loop / panel design) |
| Fire zones | **User-drawn zone boundary** (polygon), not a fixed rule |
| Lights | **Reuse the Lighting workspace's design** (Rooms results). The automation places switches and sockets only, not luminaires |
| Sockets | **By a room-use schedule** (a table by room use), not by wall length |
| Build order | 1. Fire detection, 2. switches and sockets |
| Standards text | Licensed copies are on the user's server. They are **not** in the repo or this container; they must be supplied as text or PDFs (for example under `reviews/standards/`, which is local and gitignored) |

## 2. What the Building plan already has

- Device types in `plan-defs.js`: `bd_socket`, `bd_switch`, `bd_light`, `bd_smoke`, `bd_heat`, `bd_firecombo`, `bd_firedetector`, `bd_call`, `bd_strobe`, `bd_sounder`, `bd_soundersstrobe` (fire devices already have a free-text `zone` field).
- Detected rooms (`plan-roomdetect.js`), walls and DXF wall layers; closed-polygon rooms in `planMarkup.rooms`.
- Routes (conduit, final circuit, fire cable, ...) and the route machinery; `plan-circuits.js` assigns devices to DB ways, loads them, writes routed lengths.
- Room ceiling height lives in the Lighting data, `room.lighting.ceilH`.
- The Auto layout pattern to copy: pure engine, UI with preview and Checks, `auto:` tagged items.

Not there yet: a room-use model for non-lighting purposes, door / opening geometry the engine can query, design-basis rule tables, fire zones as a polygon kind.

## 3. Architecture

| File | Role | State |
|---|---|---|
| `frontend/js/plan-bdgeom.js` | Pure room geometry and detector coverage solver (`visible`, `coverage`, `layout`, `zoneOf`) | **Done**, `testing/unit/bdgeom.test.js` (15 tests) |
| `frontend/js/plan-bdrules.js` | Design-basis rule tables (SANS / BS+EN 54 / NFPA 72), each value with a clause `ref` and a `provisional` flag | Pending |
| `frontend/js/plan-bdfire.js` | Pure fire engine: detector type, layout, call points, sounders / strobes, zoning | Pending |
| `frontend/js/plan-bdpower.js` | Pure switch and socket engine | Pending (phase 2) |
| `frontend/js/plan-bdauto-ui.js` | The "Auto design" tool: Fire tab and Power tab | Pending |

Create writes real plan items tagged `auto: 'fire'` or `auto: 'power'`. The next Create replaces only that family. Hand-placed items are never touched.

### 3.1 What `plan-bdgeom.js` does now

- `visible`: a detector does not cover round a corner of the room or through an extra wall (partition, shelving run).
- `coverage`: an interior grid plus every edge and every corner against the detectors at a given radius: pass, worst point, uncovered samples.
- `layout`: the fewest detectors that pass. Regular grids turned to the longest wall, fewest first, repaired where the room is not rectangular; a greedy set cover as the alternative; redundant detectors pruned; re-proved at half the sample step. Detectors keep `clearance` from the outline and from extra walls. `stuck` lists points no allowed position can cover.
- `zoneOf`: the smallest fire-zone polygon holding a point.
- The **radius is an input**. There are no standards values in this file.
- Measured: 0.15 s to 1.2 s for 30 to 40 m rooms including L and U shapes.

## 4. Data model (pending)

- `room.fire = { use, ceilH, detector: 'auto'|'smoke'|'heat'|'combo'|'none', category }`.
  - `use` is the room use; phase 2 reuses it for the socket schedule.
  - `ceilH` falls back to `room.lighting.ceilH` when empty. A Building project with no lighting design still needs its own height field on the room panel.
- `planMarkup.fireZones`: `{ id, name, points, floor }`, user-drawn polygons with their own colour.
- `planMarkup.settings.fire`: design basis, mounting height, wall clearance.
- Collab descriptors in `collab-data.js` for each new collection. Undo names in `undonames.js`.
- Check for a collision between `room.use` and `room.lighting.task` before adding.

## 5. Phase 1 — fire detection (pending)

1. **Rule tables** (`plan-bdrules.js`): detector radius and area per type, reductions for ceiling height and slope, minimum distance from walls and beams, call-point travel distance and mounting height, sounder dB targets by room use. Every value carries a clause reference and a `provisional` flag, and is made non-provisional only once checked against the licensed copy.
2. **Detector type per room use**: smoke / heat / combo, with a ceiling-height check against the limits.
3. **Layout**: `PlanBdGeom.layout` with the radius from the rules.
4. **Coverage proof**: coverage circles drawn on the plan, gaps flagged, a fix that adds a detector at the worst point.
5. **Call points**: at exits and on exit routes, repeated until the travel distance is met.
6. **Sounders and strobes**: sized to the dB or visual target per room use.
7. **Zones**: each detector gets the name of the fire-zone polygon holding it (`zoneOf`); detectors outside every zone are a Check. New "Fire zone" drawing tool (closed polygon, like rooms).
8. **Loop and cable limits**: checks only; no loop allocation.
9. **UI**: rules panel, live preview with coverage circles and gaps in red, Checks list with fixes, Create.
10. **Outputs**: Issues rows, BOQ lines, a fire design section in the report, undo names.

## 6. Phase 2 — switches and sockets (pending)

1. **Lights** are read from the Lighting workspace (luminaires per room); none are placed.
2. **Switches**: at the door on the latch side at the standard height; two-way switching for rooms with several doors; luminaires grouped to switches.
3. **Sockets** from a **room-use schedule** (table by room use: counts and spacing along wall runs), avoiding doors and openings; special zones (kitchens, wet areas); dedicated circuits for appliances. Needs door and opening geometry in `plan-bdgeom.js` (wall-run sampling).
4. **Circuits**: assign devices to DB ways with the maximum points per circuit and RCD rules, loaded through `plan-circuits.js`.
5. **Wiring**: conduit / cable routes from each device to its DB using the existing route machinery; lengths feed the circuit check and cable sizing.
6. **Outputs**: Checks, BOQ, report.

## 7. Cross-cutting

- Project setting **Design basis** in Project settings.
- Tests: node tests for geometry and each engine in `testing/unit/`; at least three worked fire rooms with hand-checked results (rectangle, L-shape, high ceiling), with values taken from the standards copies, not from memory.
- Help: a guide for each tool (`help-guides.js`), and rule tables described in user-facing text without citing any `.md` file.
- `BACKLOG.md` (item 114) and `CLAUDE.md` file list updated as each piece lands.
- `APP_VERSION` bumped to the PR number in the PR that ships it.

## 8. Pending items

| # | Item | Needs |
|---|---|---|
| 1 | Supply the standards text (SANS 10139 / 14520 clauses, BS 5839-1 / EN 54, NFPA 72, SANS 10142-1 for sockets) | The user: PDFs or pasted tables, for example in `reviews/standards/` |
| 2 | `plan-bdrules.js` with the table structure, PROVISIONAL placeholders until item 1 arrives | Item 1 to finish |
| 3 | `room.fire` (use, ceiling height) and its room-panel fields; check against `room.lighting.task` | - |
| 4 | `fireZones` collection, Fire zone drawing tool, Collab descriptor, undo names | - |
| 5 | `plan-bdfire.js` engine: detector type, call points, sounders / strobes, zoning, loop / cable limit checks | Items 2-4 |
| 6 | Auto design tool UI (Fire tab): rules panel, preview with coverage circles, Checks with fixes, Create (`auto: 'fire'`) | Item 5 |
| 7 | Fire outputs: Issues, BOQ, report, help guide | Item 6 |
| 8 | Door / opening geometry and wall-run sampling in `plan-bdgeom.js` | - |
| 9 | Room-use schedule table (sockets) and its editor | SANS 10142-1 text |
| 10 | `plan-bdpower.js`: switches, sockets, circuits to ways | Items 8-9, Lighting design |
| 11 | Wiring routes from devices to the DB | Item 10 |
| 12 | Power tab UI, outputs, tests, help guide | Items 10-11 |

## 9. Open questions

- Is `room.fire` plus a separate `fireZones` polygon list the right shape, or should rooms and fire zones be one polygon type?
- Live preview for large floors: layouts take up to about 1.2 s per room today; may need caching or a worker.
- Sound-level and visual-alarm coverage rules differ between bases; confirm which clauses apply once the standards text is available.
- The coverage proof is sample-based (0.12 m final step). Decide whether that is acceptable for the design report wording, or whether the report should state the sample step.
