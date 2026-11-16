# Design automation — plan

What the app should automate next, agreed 2026-11-15. Fire detection comes first and is planned in `BUILDING_AUTO_DESIGN_PLAN.md`; this file covers what follows it.

Status: **backend built 2026-11-15** (engines, routes, tests: `building_circuits.py`, `fixes.py`, `retic_mv_design.py`, `deliverables_pack.py`, `path_graph.py`). The UI screens are agreed (design canvas); the frontend is not built. The engines are Python rather than the `plan-bd*.js` files named below: the frontend calls the routes.

## 1. Decisions taken

| Question | Decision |
|---|---|
| Kinds of automation | Design automation, checking with fixes, deliverables. Not development tooling |
| First project type | Building |
| Interaction | Propose, review, create — the Auto layout pattern: a preview with Checks and fix buttons, nothing written until accepted |
| Order | 1. Fire detection (existing plan), 2. Building circuiting, 3. Fix buttons on issues, 4. Fix all with review, 5. Build deliverables, 6. Reticulation MV and street lights, 7. Single line |
| Routes | Three modes, chosen per run or per circuit type: **follow drawn containment** (tray, trunking, conduit), **along walls**, or **most direct through the ceiling** |
| Board assignment | Only to boards **already placed**. No new sub-board is proposed or placed |
| Hand-entered values | **Never changed without explicit approval.** A fix or a Fix-all pass changes automatic values only; a value typed by hand (a locked cable, a set breaker) is listed as "needs your approval" and changes only when that row is ticked |
| Deliverables | **One PDF** |
| MV design | **Ring and radial**, selectable; **volt drop, fault level and cable rating all govern**, each with its own project limit |

## 2. Building circuiting tool (BACKLOG 115)

The Power tab of the Building Auto design tool, widened beyond the switch / socket placement in `BUILDING_AUTO_DESIGN_PLAN.md` §6. It works on devices already on the plan (placed by hand, by the Lighting design, or by the Auto design).

1. **Which board feeds what.** Each room or area is assigned to one of the placed boards: nearest by route length in the chosen route mode, within the board's spare ways and capacity, same floor first. A per-room override is kept across runs. A Check where a board is out of ways or over its rating, and where a room's runs are long enough that the volt-drop limit is at risk. No board is added.
2. **Grouping into circuits.** Project rules replace the fixed caps (10 lights / 6 sockets) in `plan-circuits.js`: maximum points and maximum load per circuit by device type, circuits kept within a room or area where they fit, dedicated circuits for appliances, earth-leakage groups, spare ways (count or percentage), way order (lights, sockets, dedicated, spare). Phases balanced with the existing `DBSchedule` balance, which respects earth-leakage units.
3. **Routes.** A route from every device back to its board in one of three modes:
   - *Containment*: the shortest path along drawn tray / trunking / conduit, with a drop at each end.
   - *Along walls*: the shortest path along the room outlines and wall graph (`plan-roomdetect.js` already builds it), through door gaps.
   - *Direct in ceiling*: straight lines in the ceiling void from device to device, with vertical drops from the mounting heights.
   Devices on one circuit are chained (nearest neighbour from the board, then improved), not each run home on its own. Lengths go to the ways through `PlanCircuits.syncRoutedLengths`, so the circuit check and Size cables use them.
4. **Review.** Preview on the plan coloured by circuit; a Checks list (device with no board, board out of ways, circuit over its cap, route that cannot be found in the chosen mode — with *use direct for this circuit*); Create writes ways and routes tagged `auto: 'power'`, replaced by the next Create. A way or route made or edited by hand is left alone.

Files: `plan-bdcircuit.js` (pure engine, node tests in `testing/unit/`), the Power tab in `plan-bdauto-ui.js`, rules in `planMarkup.settings.circuiting`.

## 3. Fix buttons on issues (BACKLOG 116)

Each failing or marginal row in Issues and in the Results panel offers a proposed fix where one can be worked out:

| Failure | Fix offered | Source |
|---|---|---|
| Way: Ib ≤ In ≤ Iz, volt drop, Zs | Next cable size that passes; next breaker; split the circuit | `/analysis/db-cable-size`, the circuit check |
| Sub-main / feeder on the single line | Next cable size | cable sizing results |
| Board over its incomer | Next incomer rating | load diversity |
| Retic feeder volt drop / earth fault | Next cable size; next breaker; split the string | `/analysis/retic-lv-design` |
| Breaker duty | Next breaking capacity in the same range | duty check, breaker library |
| Out-of-date study | Re-run (exists) | — |

A fix is shown before it is applied: the value now, the value proposed, and the check results after. Applying is one undo step. Where the value was entered by hand the button reads *Change my value…* and asks first.

Design: a `Fixes` registry — `Fixes.forIssue(issue)` returns `{ label, changes: [{ target, field, from, to, manual }], verify }`. Issues, the Results panel and Fix all read the same registry.

## 4. Fix all, with review (BACKLOG 117)

One pass over every open issue that has a fix:

1. Collect the fixes; where two touch the same value keep the one that clears both (the larger cable, the higher rating).
2. Re-run the checks on a copy of the project with the fixes applied; drop any fix that makes another check worse.
3. Show the list grouped by board / feeder: change, before, after, which issues it clears. Automatic values are ticked; **hand-entered values are listed unticked under "Needs your approval"**.
4. Apply the ticked rows as one `ProjectHistory.group` entry, then re-run and report what is still open.

## 5. Build deliverables — Building (BACKLOG 118)

Output › Build deliverables: one PDF for the project.

- Cover, contents, revision table (from Project info).
- Design report: basis and assumptions, maximum demand, circuit checks per board, cable sizing, fault levels and duty, lighting summary, fire design (when present), open findings.
- Drawings: each floor plan, DB single lines, GA drawings, the SLD drawing set — vector pages through `VectorPDF`.
- Schedules: circuit schedules, cable schedules, meter schedule, priced BOQ.

A dialog lists the sections with ticks and remembers the choice per project. Before building it runs Calculate all; if anything fails or is out of date it says so and lets the user build anyway (a warning, not a block — the open findings are in the report). Built from the existing report generators; no result is recomputed differently for the pack.

## 6. Reticulation MV design and street lights (BACKLOG 119)

Auto layout designs no MV today; the mini-subs are fed from outside the layout.

- **Input:** the placed mini-subs, one or more MV supply points, the street network.
- **Topology:** *radial* (a tree from the supply) or *ring* (a loop through every mini-sub with a normally-open point, each half able to carry the whole ring). Routes along the street verges, sharing trenches and crossings with LV through the existing `PlanLayout.trenches`.
- **Sizing and checks:** MV cable from the library, smallest size that passes **all three** checks; ring switching per mini-sub (RMU ways); a ring is checked with either end open (every mini-sub fed from the other side).
  - **Volt drop:** at every mini-sub primary, at full load, against a project limit. The default is Demand's own limit (`Retic.settings.maxFeederVD`), so the layout and Demand agree.
  - **Fault level:** the prospective fault current at every MV point against the cable's short-circuit withstand for the protection clearing time (the cable's I²t against the fault level and the upstream device time), and against the switchgear's breaking rating. The supply fault level is an input.
  - **Cable rating:** the load current against the cable's installed rating (laying, depth, grouping), with the ring's open-end case as the governing load.
  - Every limit is a project setting shown in the Rules step with its source; a size that fails any one of them is reported with the check that governs it, and a *Fix* offers the next size.
- **Street lights:** pole placement from the Road plan design and `RoadCircuits.plan` run from the layout, so a Create gives poles and circuits fed from the nearest kiosk or mini-sub.

Open: the default values of the fault-level inputs (supply fault level, protection clearing time) and the cable laying conditions; these come from the project, not from the engine.

## 7. Single line (BACKLOG 120)

Last, because the building and Demand syncs already draw most of a single line.

- Size the drawn cables, transformers and breakers in one reviewed pass (the Fix-all machinery, run on parts that pass but have no size chosen).
- Tidy layout of a synced single line.

## 8. Cross-cutting

- Every engine is pure and node-tested; the UI follows `plan-layout-ui.js` (steps, one footer button, Checks with fixes).
- Nothing automatic overwrites a hand-entered value; every Create and every Apply is one named undo step.
- Help guide per tool; `CLAUDE.md` file list and `BACKLOG.md` updated as each piece lands.
