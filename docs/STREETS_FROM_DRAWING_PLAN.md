# Streets from the drawing — build instructions

Two features for getting street centrelines out of a DXF, both agreed with the user on 2026-11-19. Written
against `main` at `045a658` (v2.664). They share code, so build **Part B first** (its engine split is what
Part A reuses), or build them in one branch.

- **Part A — Streets from road reserve:** click inside road reserves the way Detect erven works; the app makes
  the streets (one per stretch between intersections), each with a reserve width and a carriageway width,
  real intersections and kerb returns you can drag.
- **Part B — Streets from kerbs, select by clicking:** rework of *Streets from kerb layer* / *Roads from kerbs*
  so kerb lines are picked with add / subtract clicks.

Section 0 lists the values the user has not confirmed yet.

---

## 0. Open points (confirm before or during the build)

| Point | Proposed default | Status |
|---|---|---|
| Default carriageway width | 6 m | proposed, not confirmed |
| Default kerb return radius | 8 m; 10 m where either street's reserve is wider than 16 m | proposed, not confirmed |
| Carriageway position | centred in the reserve, with an offset per street (m, + = to the left looking along the street) | proposed, not confirmed |
| Widest reserve the pairing accepts | 40 m (setting) | proposed |
| Raster step for erf-boundary drawings | 0.5 m (setting) | proposed |

---

# Part A — Streets from road reserve

## A1. What the user asked for

| Topic | Decision |
|---|---|
| Where | **Auto layout › Streets** (a fourth way next to Draw centrelines, Pick centrelines and Streets from kerbs) **and Road plan** (next to Roads from kerbs). |
| Drawings to support | **All three**, it varies by drawing: (1) one closed outline per street reserve, (2) one outline for the whole road network, (3) no road outline at all — the reserve is the space between erf boundaries. |
| Selecting | **Smart select like Detect erven:** click inside a reserve to add that region; click to remove regions (subtract); a **Draw** mode (click the corners) when detection fails. |
| Removing part of one big region | **Both:** Alt-click a street (the region is split into streets at the intersections) to drop just that street, **and** draw a **cut line** across the reserve, then Alt-click the part to drop. |
| Street | One street = **the road between two intersections** (or an intersection and an end). |
| Widths | Each street has a **reserve width** (measured, may vary along it) **and a separate carriageway width** (one default, editable per street). Services, kiosks and trenches use the reserve; kerb lines, junctions and road lighting use the carriageway. Both are **user-definable per street**. |
| Intersections | Generated properly: T-junctions, crossroads, ends on another street; cul-de-sacs end at the bulb centre. |
| Kerb returns | The radius the user drags is the **kerb return of the carriageway** (the rounded kerb corner between two streets). **Click-drag** on the plan changes it, per corner. |
| Existing streets | Create **asks each time**: replace all streets, or add to them (added ones join the existing ones at intersections). |

## A2. How it works (pipeline)

```
click(s) inside reserves ──► region mask (union of picked regions − subtracted − cut parts)
                            │
                            ▼
              boundary contours of the mask (outer + holes), in metres
                            │
                            ▼
      PlanKerbs pairing on those contours with reserve limits (wmax 40 m)   ← Part B's candidates/assemble
                            │
                            ▼
      centrelines + reserve width profile ──► split at intersections ──► streets
                            │
                            ▼
      carriageway (width, offset) + kerb returns per junction corner ──► review ──► Create
```

The key idea: a road-reserve outline is exactly a pair of "kerbs" that are further apart. The kerb engine
already pairs two parallel lines, pairs a closed outline with itself (cul-de-sac / dead end), bridges junction
mouths, runs ends on to the street they meet and fits bulb centres. So the reserve tool does **not** need a
medial-axis / skeleton algorithm: it turns the selected region's boundary into chains and hands them to
`PlanKerbs` with wider limits.

## A3. Region detection (`plan-roomdetect.js`)

### A3.1 New target `reserve`

`PlanRoomDetect` already has targets `room` and `erf` (`LIMITS`, l.849), a staged set with add / subtract
(`mode`, `staged`, `click` l.1268), hover preview (`hoverAt`), leak marking (`leakAt`), a Draw mode
(`draft`, `drawClick`, `drawClose`) and `createStaged`. Add a third target:

```js
reserve: { maxAreaM2: 2e6, minAreaM2: 50, minWidthM: 3, noun: 'road reserve', nouns: 'road reserves', Noun: 'Road reserve' },
```

and `opts('reserve')` stored in `planMarkup.settings.reserveDetect` (same shape as `erfDetect`; default layers
`RESERVE_LAYERS = 'road|reserve|street|straat|erf|erven|stand|cadastr|parcel|boundary|property|lot'` — road
outlines when there are any, otherwise the erf boundaries), plus `stepM` (raster step, default 0.5).

The `reserve` target never commits plan items itself. Its staged set is read by the street tool (A4); its
`createStaged` is not used.

### A3.2 Regions with holes

A road network is a region **with holes** (the blocks of erven are islands inside it). The current detection
returns one outer ring (`_traceOuter`). For `reserve`:

- **DXF path:** rasterise the segments from `segmentsFromDxf(data, layerOk, opts)` (already filtered to the
  working area, respects `sameLayer` and hidden layers) into a mask at `stepM` over the working area's bbox
  (or the drawing's bbox), lines drawn `max(1 px, gapM/stepM)` thick so the existing gap setting still closes
  small openings. Flood fill from the click (`_component`). This is the raster path the image detection already
  uses, fed from vector lines; it handles all three drawing types the same way.
- Trace **every** contour of the filled component: the outer one with `_traceOuter`, and each hole (a
  4-connected component of non-filled pixels fully enclosed by the region) with the same tracer. Simplify each
  with `_simplifyClosed(ring, stepM)`.
- Return `{ ok, outer: [{x,y}], holes: [[{x,y}]], mask, bbox, step }` (world coordinates, as `detectAt` does).
- Size guard: if the raster would exceed ~16 M pixels, raise `stepM` and say so in a toast.

### A3.3 The estate entrance leak

The road network nearly always opens to the outside (the entrance road, a road that continues off the
drawing), so a click "leaks" and gives `not-enclosed`. Two fixes, both needed:

1. For target `reserve`, when a **working area** is set (`PlanWorkArea`), draw its polygon edges into the mask
   as walls. The user draws a working area round the estate and the road space is closed at the boundary.
2. **Cut lines** (A3.5) are walls too, so the user can close an entrance with one line.

When it still leaks, keep the existing leak marking (`leakAt`) and change the toast for this target:
"The road space runs out of the drawing here. Set a working area round the development, or draw a cut line
across the road."

### A3.4 Selection = a mask

Keep the reserve selection as one mask (`Uint8Array` on the shared raster grid) rather than a list of polygons:

- **Add** (click): OR the clicked region into the mask, then **close the seams** — clear the wall pixels that
  lie between two selected pixels (a 1–2 px morphological close restricted to wall pixels). This is what merges
  drawing type (1), one closed outline per street, into one road space: the shared outline between two
  adjacent street reserves disappears.
- **Subtract** (Alt-click): remove the connected selected region under the click (after cut lines, A3.5).
- **Draw** (by hand): rasterise the drawn polygon into the mask (add), or, with Alt, subtract it.
- Keep an undo list of masks (Backspace) — cheap enough at these sizes, or store the ops and replay.
- Hover preview: show the region a click would add, as Detect erven does (`hoverAt`, cached by `_sig`).

### A3.5 Cut lines

A new sub-tool **Cut** in the reserve panel: click two or more points across the reserve, Enter or a double
click finishes. A cut line is drawn into the raster as a wall (thickness 2 px) and kept in the stage
(`cuts: [[{x,y}…]]`). After a cut, the selected mask is split; Alt-click the part to drop. Cut lines are
session-only (drawn dashed red on the plan) and are not written to the project.

## A4. From the mask to streets

Put the pure part in a new node-testable module **`frontend/js/plan-reserve.js`** (`PlanReserve`,
`testing/unit/reserve.test.js`), so it can run on plain arrays, and the UI part in the street tools.

### A4.1 Contours → chains → pairing

```js
PlanReserve.streets(contours, o)
// contours: [[x,y]…] in metres (outer + holes, closed)
// o: { wmin: 6, wmax: 40, gap: 25, minStreet: 15, step: 1 } (reserve limits)
// returns { streets: [{ id, pts, w, ws: [[s, w]…], bulb? }], junctions: [...], unpaired: [...] }
```

1. Each contour becomes a closed chain `{ pts, closed: true }`.
2. `PlanKerbs.candidates(chains, o)` + `PlanKerbs.assemble(cands, allIds, [], o)` (B3.3) with the
   reserve limits. A road between two blocks pairs one hole's edge with the next hole's edge; a road on the
   estate edge pairs a hole with the outer contour; a dead end or a single outline pairs with itself; bulbs are
   circle-fitted as today (raise the bulb radius limit for reserves: `fitCircle` accepts r ≤ 25 m today, use
   `o.bulbMax`, default 30).
3. **Splay corners** (the 45° chamfers of the reserve at intersections) shorten the parallel runs near a
   junction; that is what `bridge` / `extend` already cover. Check with a test that a crossroads with 3 m splays
   gives one vertex shared by four streets.
4. Keep the per-sample widths (`ws`) as a width profile `[[s, w]…]` along the centreline (like Road plan's
   `kerbWidth`), plus `w` = median.

### A4.2 Split at intersections

`PlanKerbs.solve` returns streets that may run through junctions (bridged pieces). Add
`PlanReserve.split(streets)`:

- A **junction** = a point where 3 or more street ends / interior vertices meet within 0.5 m (`extend` and
  `connect` already insert the hit point as a vertex of both streets), or 2 street ends meeting at an angle
  over 30° (a corner).
- Split every street at every junction vertex it passes through. One street = the stretch between two
  junctions, or a junction and a free end / bulb.
- Give each junction a stable key from its rounded position (0.5 m grid) and return
  `junctions: [{ key, x, y, legs: [{ streetId, atEnd, dir }] }]`, legs sorted by angle.
- Drop pieces shorter than 3 m left over from splitting.

### A4.3 Carriageway, kerb lines and kerb returns

Per street: `reserveW` (profile + median), `carriageW` (default A0), `cwOffset` (default 0). The kerb lines are
the centreline offset by `cwOffset ± carriageW / 2`.

Per junction, per **corner** (two adjacent legs by angle, the right kerb of one and the left kerb of the next):

- Intersect the two kerb lines near the junction → corner point P, angle θ between the legs.
- A kerb return of radius R is the tangent arc between the two kerb lines; tangent length `t = R / tan(θ/2)`.
  Clamp R so `t` is not longer than 80 % of either leg and R stays in [2, 30] m. Over 170° (nearly straight)
  there is no corner — skip it.
- Default R from A0. Store **only the radii the user changed**:
  `returns: { [junctionKey]: { [cornerIndex]: R } }` where the corner index is the leg index going round; also
  store each corner's two street ids so a reorder after an edit can re-match it.

Pure functions in `PlanReserve`: `kerbLines(street)`, `corners(junction, streets)`, `returnArc(corner, R)` →
`{ t1, t2, centre, pts }`, `radiusFromDrag(corner, point)` (R from the pointer: the distance from the pointer
to P along the bisector `d` gives `R = d·sin(θ/2) / (1 − sin(θ/2))`).

## A5. The review step (UI)

### A5.1 Auto layout (`plan-layout-ui.js`)

- In Streets (`step` 1), add **Streets from road reserve**. It opens a review block like the kerb one:
  - **Add / Subtract / Draw / Cut** mode buttons (same look as Part B), Backspace = undo last action,
    Enter = Create, Esc = leave.
  - Settings: default carriageway width, default kerb return, widest reserve (wmax), raster step, gap.
  - Lists: streets (name from the nearest text, reserve width min–max, carriageway width input, offset input),
    junctions (count, corner radii), and problems (leaks, pieces not paired, networks not joined —
    reuse *Join networks up to*).
- Clicks: the plan tool routes the click to `PlanRoomDetect.click(pt, 'reserve', e)` in Add / Subtract, to the
  draft in Draw, to the cut draft in Cut. After every change: recompute contours → `PlanReserve.streets` →
  `split` → draw. If recomputing the whole network on each click is too slow for a large estate, debounce
  200 ms and show the region preview straight away.
- **Alt-click on an amber street** (not on a region edge) drops that street: keep a set of dropped street keys
  (a key = the two junction keys it runs between), so a later recompute keeps it dropped.
- **Drag a kerb return:** a small handle at each arc midpoint; pointer-down on it starts a drag; move updates R
  through `radiusFromDrag`; release stores it in the stage. Double-click a handle = back to the default.
- Banner (`hint()` / `syncHint()`), per mode:
  - Add: "Click inside a road reserve to add it · Alt-click: subtract · Alt-click a street: drop it · drag a corner handle: kerb return · Enter: create · Backspace: undo · Esc: leave"
  - Subtract: "Click a selected reserve to remove it · Alt-click a street: drop it · …"
  - Draw: "Click the corners of the reserve · click the first corner or Enter to close · Backspace: last corner · Esc: stop drawing"
  - Cut: "Click across the road to cut it · Enter or double-click: finish · then Alt-click the part to drop"
- Drawing (`kerbDraw` style): selected mask as a light amber fill, cut lines red dashed, centrelines amber with
  the reserve width, carriageway kerb lines grey, kerb returns with their handle and radius label, junction dots.

### A5.2 Create in Auto layout — what is written

Street routes (`pm.routes`, `type: 'street'`), one per split street:

```js
props: {
  name,                     // nearest text, else 'Street N'
  width,                    // = reserve width (median). Keeps today's meaning for the layout engine: an erf faces
                            //   a street within width/2 + 4 m, cables and kiosks are placed from the erf boundary
  reserveProfile: [[s, w]…],// measured, for drawing / later use
  carriageW, cwOffset,      // carriageway
  auto: 'reserve',          // made by this tool
}
```

Kerb returns: `planMarkup.settings.layout.streetReturns = { [junctionKey]: { [corner]: R } }` (only edited ones).

Before writing, **ask each time** (a small dialog): *Replace all streets on this floor* / *Add to them* /
*Cancel*. Replace = one snapshot, remove every `type: 'street'` route, write the new ones. Add = write the new
ones and join their ends to existing streets with `PlanKerbs.attach` / `connect` (existing streets as
`extras`), then write the vertices those joins add to the existing routes too.

The layout engine (`plan-layout.js`) only reads `width` today, so nothing in the engine has to change. Check
that **every** place that copies or edits street props keeps the new fields (DXF manager convert, street
properties panel, Collab `collab-data.js` route sync, the BOQ / CSV skip of streets via `noTakeoff`).

Drawing: wherever street routes are drawn on the plan (find the renderer for `type === 'street'`), when a street
has `carriageW` draw its two kerb lines and the kerb returns at its junctions (light, below the centreline).
Street properties panel: add reserve width (read-only min–max), carriageway width, offset.

### A5.3 Road plan (`roadplan.js`, new `roadplan-reserve.js`)

- The Road plan works on its own background (`RoadPlan.rp.bg.ents`, metres). Run the same pure pipeline: the
  region mask is built from `bg.ents` segments (no working area there; leak toast suggests a cut line).
  Put the Road plan's click / draw / overlay in `roadplan-reserve.js` (`RoadReserve`, same pattern as
  `RoadKerbs`: `open`, `down`, `key`, `overlay`, `panelHtml`, `act`, `change`, `create`, `hint`; tool id
  `reserveauto`; hooks in `roadplan.js` beside the `kerbauto` ones).
- Create writes roads in `mode: 'kerbs'` with `kerbs: { a, b }` = the carriageway kerb lines (so the lighting
  calculation sees the carriageway, not the reserve), plus `reserve: { a, b }` (the reserve lines, display only)
  and `carriageW`, `cwOffset`. Ask replace / add as in A5.2.
- Kerb returns: store in `rp.junctionReturns = { [junction.key]: { [corner]: R } }` (snapshot it in `_snapshot`,
  restore it in the undo restore at l.165, sync it in `collab-data.js`). Note Road plan junction keys are
  `${main}:${side}:${end}` / `${A}x${B}:${s}` (`junctions()`, l.421), not the reserve tool's position keys:
  on Create, map each reserve junction to the Road plan junction within 5 m.
- **Conflict areas include the returns:** `conflictAreas` (l.696) are built from `_kerbPolygon` over the
  junction ranges. Add, per corner with a return, the polygon between the two kerb lines and the arc (the
  corner fillet area) to that junction's `polygons`, so the junction is lit and checked to its real kerb line.
  Draw the returns in the plan render (l.1427 area). Road plan roads that do not come from this tool have no
  `junctionReturns` entry and behave exactly as today.
- Drag handles for the returns in the Road plan's select tool, same maths (`PlanReserve.radiusFromDrag`).

## A6. Edge cases

1. **Drawing type (2), one outline for all roads:** one click selects the whole network; split at intersections
   gives the streets. Alt-click a street or cut to drop parts.
2. **Drawing type (3), erf boundaries only:** the road space is the gap between erven, plus open ground,
   parks and servitudes that are not erven. These come in as reserve too. The user subtracts them (click) or
   cuts them off. Mention it in the guide.
3. **Erf boundaries with gaps** (an erf missing): the region bleeds into the erf; the leak / area is visible in
   the preview. The gap setting and Draw cover it.
4. **Splays and truncated corners** at intersections: handled by bridge / extend; tested (A7).
5. **Roundabouts:** the island is a hole; the circulating road pairs round it as a ring (closed chain pairing
   with the outer ring). Accept a ring street; junction detection treats each entry as a junction on the ring.
6. **Median / dual carriageway in one reserve:** the median is a hole → two streets side by side. Offer
   *Merge into one street* on the pair in the list (one centreline down the middle, reserve = both + median).
7. **Very wide reserves** (> wmax): reported as unpaired with "wider than 40 m: raise *widest reserve*".
8. **Cul-de-sac bulbs over 30 m diameter:** `bulbMax` setting.
9. **Units / scale:** nothing works until the plan is calibrated — same message as the kerb tool.
10. **Collab:** the stage is session-only; only Create writes, as one snapshot.

## A7. Tests (`testing/unit/reserve.test.js`, plus additions to `roomdetect.test.js`)

1. **Rasterised region with holes:** a 3 × 2 grid of block rectangles inside an outer rectangle → one region,
   6 holes, contours traced (outer + 6).
2. **Seam closing:** two adjacent closed street outlines sharing an edge, both added → one region, no wall
   between.
3. **T-junction:** reserve outline of a T (13 m main, 10 m side, 3 m splays) → 3 streets, one junction with 3
   legs, widths 13 / 13 / 10 ± 0.5.
4. **Crossroads:** 4 streets, one junction, 4 corners.
5. **Cul-de-sac:** a dead-end reserve with a 15 m radius bulb → the street ends at the bulb centre.
6. **Erf boundaries only:** a block of 12 erven either side of a 16 m road, closed by a working area → 1 street,
   w ≈ 16.
7. **Split:** a street through a crossroads becomes 2.
8. **Kerb return:** a 90° corner, R = 8 → tangent length 8, arc midpoint at the right place; `radiusFromDrag`
   inverts `returnArc` (round trip within 1 cm); R clamped on a short leg.
9. **Cut line:** a cut across a straight reserve splits the selection in two; subtracting one half leaves one
   street.
10. **Leak:** an open entrance gives `not-enclosed`; with a working area round it, it closes.

## A8. Checking it in the app

1. A survey or SG layout DXF with road reserve outlines: Auto layout › Streets › *Streets from road reserve*.
   Click one reserve; the preview fills; streets appear with widths. Click the next reserve; the seam goes.
2. A cadastral DXF with erf boundaries only: set a working area round the estate, click the road space once;
   the whole network appears, split at the intersections. Alt-click a street to drop it; cut across a road and
   Alt-click the part to drop it.
3. Drag a kerb return; the radius label follows; double-click resets it.
4. Change the carriageway width of one street in the list; its kerb lines and returns move.
5. Create → the replace / add question; the streets have `width` = reserve, carriageway, offset. Run the layout:
   kiosks / cables / trenches as before.
6. The same in Road plan: roads in kerbs mode at the carriageway; junction conflict areas include the returns;
   run the lighting calculation.

---

# Part B — Streets from kerbs: select by clicking

Rework of **Auto layout › Streets › Streets from kerb layer** and **Road plan › Roads from kerbs** so the
user builds the set of streets by clicking kerb lines (add / subtract), instead of pairing a whole layer at
once and then pruning.

---

## B1. What the user asked for (agreed spec)

| Topic | Decision |
|---|---|
| Where | Both Auto layout › Streets and Road plan › Roads from kerbs, identical behaviour (they already share `PlanKerbs.stage`). |
| Start | Opens with **nothing selected**. No layer has to be chosen first: a kerb on **any layer** can be clicked. The layer list stays as a suggestion. |
| Pair all | Keep a **Pair all on layer** button (today's one-shot pairing). Its result is edited with the same clicks. |
| Click (Add) | Takes the **whole joined kerb line** under the pointer and adds **every street it touches**. The opposite kerbs are found automatically. |
| Shift-click (Add) | Takes only the **one drawn piece** under the pointer, so normally one street. |
| Modes | **Add** / **Subtract** buttons in the panel (Add is the default). **Alt-click** = subtract for that one click while in Add mode. |
| Subtract | Mirrors Add: click a kerb line = remove every street that line touches; Shift-click = remove only the street at that piece. |
| Re-picks | Adding something already in, or subtracting something not in, does nothing (no toggle). |
| No partner | A clicked kerb with no partner stays selected, **red dashed, "no partner"**. Two fixes: click it then click its partner kerb (pair by hand), or Ctrl-click it then click the road side (street half the set width in). |
| Banner | A line at the **top of the plan** lists the shortcuts while the tool is on, and follows the mode. |
| Undo | **Backspace** takes back the last pick. Enter creates, Esc leaves. |

Banner text (Add mode):

> Click: add a kerb line and its streets · Shift-click: just this piece · Alt-click: subtract · Ctrl-click: lone kerb · Enter: create · Backspace: undo pick · Esc: leave

Banner text (Subtract mode):

> Click: remove the streets of a kerb line · Shift-click: just this street · Enter: create · Backspace: undo pick · Esc: leave

**Behaviour change to call out in the PR:** Shift-click used to mean "pair these two kerbs". It now means
"one piece". Pairing by hand moves to *click a red (no partner) kerb, then click its partner*.

---

## B2. Files involved

| File | Role today | Change |
|---|---|---|
| `frontend/js/plan-kerbs.js` | Pure engine: `joinPieces`, `solve`, `pairManual`, `offsetOne`, `attach`, `connect`, `components`, `sides`, `stage` | Split `solve` into candidates + assemble, add piece spans, new pick-based `stage` |
| `frontend/js/plan-layout-ui.js` | Auto layout UI: `kerbOpt`, `kerbStage`, `kerbStart` (l.505), `kerbSolve`, `kerbOne`, `kerbInfo`, `kerbCancel`, `kerbClick` (l.535), `kerbCreate` (l.550), `kerbDraw` (l.567), `_kerbPieces` (l.419), panel `kerbBlock` (~l.1316), `hint()` (l.826), `syncHint()` (l.844), key handling (l.1586–1587), `data-act` handlers (~l.1497–1510) | New start (no layer), pool over all layers, modes, banner, Backspace |
| `frontend/js/roadplan-kerbs.js` | Road plan UI: `open`, `find`, `down`, `key`, `overlay`, `panelHtml`, `act`, `change`, `create`, `hint` | Same changes, on `RoadPlan.rp.bg.ents` |
| `frontend/js/roadplan.js` | Calls `RoadKerbs.hint()` via `_hint()`, routes tool `kerbauto` events | Only if a new key (Backspace) has to be routed |
| `testing/unit/kerbs.test.js` | 166 lines of engine tests | New tests (section 7) |
| `frontend/js/help-guides.js` (l.519), `frontend/js/help-design.js` (l.269–276) | Guide / article text for Streets / Road plan | Describe click add / subtract |
| `CLAUDE.md` | Entries for `plan-kerbs.js`, `roadplan-kerbs.js`, `plan-layout-ui.js` | Update the kerb wording |
| `BACKLOG.md` | — | Completed entry (see the workflow rules in CLAUDE.md) |
| `frontend/js/constants.js`, `frontend/index.html` | `APP_VERSION`, `?v=` | PR number bump, plus `?v=` on every changed file |

---

## B3. Engine changes (`plan-kerbs.js`)

The current `solve(chains, o)` does everything in one pass: `assign` → `runs` → pieces → `bridge` →
`extend` → bulb rings → `connect`. A street that is extended (`extend`) or snapped to another street's
centreline is only right if that other street is also in the result. With click selection the result is a
**subset** of what the layer can make, so the junction work must run **after** the subset is known.

### B3.1 Record where each piece came from in `joinPieces`

Each chain must know the arc-length interval of every original drawn piece it was built from, so Shift-click
("this piece only") can be mapped onto the chain.

- While building `pts` in `joinPieces`, keep a parallel list of piece boundaries. After the chain is
  finished, turn them into `parts: [{ s0, s1 }]` (metres along the chain, same parameter `resample` uses for
  `S[k].s`).
- The chain object becomes `{ pts, closed, parts }`. Nothing else reads `parts`, so existing callers are unaffected.
- Note `joinPieces` prepends pieces (`side === 1`) and reverses pieces, so compute `parts` from the final `pts`
  and the vertex index where each piece starts. Recording the vertex count on each concat is enough.

### B3.2 Give each piece a span per chain in `runs` / `solve`

In `runs(R, A, i, j, o)` each kept run already has `k0`, `k1` (samples on chain `i`) and `last.qs`.
Also collect the partner's `qs` over `r.ks` and return:

```js
spans: { [i]: [S[r.k0].s, S[r.k1].s], [j]: [min qs, max qs] }
```

For a cul-de-sac (`j === i`) the span on `i` is the arm-1 stretch plus the matched arm-2 stretch (two
intervals on the same chain). Store spans as `{ [chain]: [[s0, s1], ...] }` (a list of intervals per
chain) so merging is uniform.

In `bridge`, when two pieces merge, concatenate their interval lists per chain. Bulb-ring streets get the
whole ring `[0, len]` on `b.i`.

### B3.3 Split `solve` into two functions

```js
// every street the given chains can make, before junction work. Pure, cacheable per layer.
function candidates(chains, o) -> { pieces: [{ id, pts, ws, chains, spans, bulbs }], bulbRings, unpaired, chains }

// the streets for a chosen set of candidate pieces (+ hand-made ones): extend, bulbs, connect.
function assemble(cands, ids, extras, o) -> { streets: [{ pts, w, chains, spans, src }] }
```

- `candidates` = today's `solve` up to and including `bridge(pieces, o)`, plus the bulb-ring detection.
  Give each piece a stable `id` (its index after `bridge` is fine because the input chains are fixed for a cache entry).
- `assemble` = today's `extend(pieces, all, o)`, the bulb-ring attach loop (only rings whose chain is in a
  chosen piece's `chains`, or that were clicked themselves), the vertex re-read and `connect(streets, o.gap)`,
  run **on the chosen pieces only**. `extras` = hand-made streets (from `pairManual` / `offsetOne`); include
  them and run `extend` on them as `attach` does today.
- Keep `solve(chains, o)` as `assemble(candidates(chains, o), all ids, [], o)` and keep its output identical, so
  `pairedShare`, the existing tests and anything else calling `solve` are unchanged. **Run the existing
  `kerbs.test.js` before and after this split; it must not change.**

### B3.4 Pick-based `stage`

Replace the internals of `stage(chains, o)` with a state that is a **replayable list of picks**. The
streets are a fold over the picks, so Backspace is `picks.pop()`, and changing the width range or bridge gap
re-solves the candidates and replays the same picks.

```js
pick = { op: 'add' | 'sub', layer, chain, span: [s0, s1] | null }      // span null = whole kerb line
     | { op: 'pair', layer, a, b }                                     // hand pair of two chains
     | { op: 'one', layer, chain, side: [x, y] }                        // street beside a lone kerb
     | { op: 'cut', streetKey }                                         // subtract clicked on a street, not a kerb (see B4.4)
```

Fold rules:

1. Start with an empty set of chosen candidate ids, an empty `extras` list and an empty `lonely` set.
2. `add`, `span == null`: add every candidate piece of `layer` whose `chains` includes `chain`. If none, put
   `layer:chain` in `lonely` (shown red, "no partner").
3. `add` with a span: add the candidate pieces whose interval on `chain` overlaps the span by at least
   `min(5 m, 50 % of the span)`. If none, put it in `lonely`.
4. `sub`: the same matching, removing instead (and removing `extras` whose `chains` include `chain`). A `sub`
   on a whole line also takes the line out of `lonely`.
5. `pair`: `pairManual(chains, a, b, o)` → push to `extras` (remove `a` and `b` from `lonely`). If it
   returns null, the pick is dropped and the UI says "those two kerbs do not run beside each other".
6. `one`: `offsetOne(...)` → push to `extras`, remove from `lonely`.
7. Finally `assemble(cands[layer]..., chosen, extras, o)` per layer, then one `connect` across all of them
   (streets from two layers can meet).

Public surface of the new stage (both UIs drive only this):

```js
T.mode            // 'add' | 'sub'
T.picks           // the list above
T.streets         // folded result
T.lonely          // [{ layer, chain }]: clicked, no partner (red)
T.addChain(layer, chain, span)    // honours T.mode; returns { added, removed, lonely } counts for the toast
T.pairWith(layer, a, b)           // the hand pair
T.arm(layer, chain) / T.place(pt) // the lone-kerb road (as today)
T.pairAll(layer)                  // every candidate of a layer = one 'add' pick per chain that has candidates
T.undo()                          // picks.pop() + refold
T.setOpt(o)                       // new width range / gap: drop the candidate cache, refold
T.join(maxGap) / T.networks()     // as today
```

Keep `chainAt` / `streetAt` / `info`. They now search over all layers (see B4.1).

Keep the old method names (`solve`, `remove`, `pair`) only if something else calls them; `grep -n "\.pair(\|\.remove(\|kerbStage\.\|stage\.solve" frontend/js`
before deleting.

### B3.5 Partners only on the same layer

Erf boundaries across a road are parallel lines 13–20 m apart. If kerbs were paired across all layers they
would pair with boundaries. So candidates are solved **per layer** (cache key `layer + chain count + options`),
and a clicked kerb only looks for partners on its own layer. Add a panel option **"Look for partners on any
layer"** (off by default) for drawings with the two kerbs on different layers. When it is on, the candidate
pool for a click is the clicked layer plus every layer that already has a pick.

---

## B4. Auto layout UI (`plan-layout-ui.js`)

### B4.1 One pool of clickable kerbs across all layers

- New `_kerbPool()` builds `{ layers: { [layer]: { chains, pieces } } }` for **every** DXF on the floor and
  every layer that is **not hidden or frozen** (`PlanDxfImport.layerHidden(desc, name)`; the new Freeze layer
  tool sets the same flag), limited to the working area (`PlanWorkArea.recKeeper(d)`, already used in
  `_kerbPieces`). Reuse `_kerbPieces(d, layer)` per layer; skip HATCH (it already does).
- Key the pool by `descId + '|' + layer` so two DXFs with the same layer name stay apart.
- Build lazily: the chains for hit-testing need only `joinPieces` (cheap). `PlanKerbs.candidates` is run for a
  layer **on its first click** and cached. For a layer over ~4000 entities show a busy toast first, since `assign`
  is roughly O(samples × nearby chains).
- Rebuild the pool (and keep the picks) when the working area, a layer's hidden state or the plan scale changes.
  Picks whose chain no longer exists are dropped with a toast.

### B4.2 Start, panel and modes

- `kerbStart()` no longer takes a layer. The *Streets from kerb layer* button becomes **Pick kerbs**, and the
  stage opens empty in Add mode. Rename the panel block title to **Streets from kerbs: pick**.
- At the top of the block: two toggle buttons **Add** / **Subtract** (`data-act="kerbmode" data-m="add|sub"`,
  `aria-pressed`). Then the layer select + **Pair all on layer** (`data-act="kerbpairall"`), which calls
  `T.pairAll(layer)`.
- Keep: the width range / bridge gap inputs (now `T.setOpt`), *Join networks up to*, the separate-networks
  warning, the half-width input.
- The red list becomes **"Clicked, no partner"** from `T.lonely`, each row with *show* (existing `kerbshow`),
  **pair…** (arms hand pairing, see 4.3) and **one side…** (existing `kerbOne`).
- Picks list (collapsed, newest first): "Added kerb line on Layer X (3 streets)", "Removed 1 street", each with
  an × that removes that pick and refolds. Plus an **Undo last pick** button (same as Backspace).
- Create button: `Create N streets`, disabled at 0. `kerbCreate` is unchanged apart from reading `T.streets`,
  and since streets can come from several DXFs, the namer must be built per DXF (`this._namer(data, d, f)`
  for each DXF that has a pick).

### B4.3 `kerbClick(pt, e)`

```text
if armed lone kerb (T.one) and no modifier      -> T.place(m)
if armed hand pair (T.pairFrom) and no modifier -> chain under click: T.pairWith(...); else toast
Ctrl/Cmd                                        -> arm lone kerb on the chain under the click
hit = nearest chain over the whole pool within tol (14 px / zoom, as today)
if hit is in T.lonely and mode is add and no Shift -> arm hand pair (T.pairFrom = hit), toast
                                                   "Now click the kerb across the road."
op = e.altKey ? 'sub' : T.mode
span = e.shiftKey ? the drawn piece's [s0, s1] from chain.parts at the click : null
if no chain hit:
   op 'sub' and a street is under the click -> remove that street (see B4.4)
   else toast "Click on a kerb line."
else T.addChain(...) with op, and toast what changed:
   "Added 3 streets", "No partner found: shown red. Click it again, then the kerb across the road",
   "Already in", "Removed 2 streets", "Nothing to remove there"
```

To find the drawn piece: project the click onto the chain (nearest segment → arc length `s`), then the
`parts` entry with `s0 <= s <= s1`.

### B4.4 Subtract by clicking a street

When Subtract hits no kerb but is on an amber centreline, remove that street: add a `{ op: 'sub', layer,
chain, span }` pick for each of its `chains` using the street's `spans`. That keeps everything replayable
without a separate street-id pick. Drop the `cut` pick type from B3.4 if this covers it.

### B4.5 Banner, keys, drawing

- `hint()` (l.826): when `kerbStage` is on, return the Add or Subtract text from section B1 (prefix
  `'Auto layout · '` as the others). When a lone kerb or hand pair is armed, return what the next click does
  instead. Call `this.syncHint()` after every click, mode change and pick change. `syncHint` writes
  `PlanMarkup._toolMsg`, the line over the plan. Make sure it stays visible while the tool is open, which is
  what the user means by "tooltip at the top of the screen".
- Keys (l.1586–1587 block): Enter = create (as today), Esc = leave (as today), **Backspace = `T.undo()`**.
  The tool's key handler must return true for Backspace so `plan.js` does not delete a selected plan item
  (see how `keyFirst` is used for Detect room's Backspace).
- Optional: `A` / `S` to switch mode. Check `plan.js` for existing single-key shortcuts first and skip it on a clash.
- `kerbDraw`: draw every pool chain grey as today (only layers that are visible). Chosen kerb lines stronger
  grey/blue, `T.lonely` red dashed, the armed chain blue, streets amber/orange as today. On hover, highlight
  the line (or piece, with Shift held) that a click would take, in green for Add or red for Subtract. Hover
  needs `onMove` on the tool to store the hovered chain/span and request a draw.
- Cursor: crosshair in Add, a minus cursor (or `not-allowed` style) in Subtract.

### B4.6 Things to leave alone

- *Pick centrelines* and *All lines as streets* are unchanged.
- `kerbLike` / the "kerbs (pair them)" marker in the layer list stays. It now only orders the list for Pair all.

---

## B5. Road plan UI (`roadplan-kerbs.js`)

Same behaviour, different plumbing:

- Pool = every layer of `RoadPlan.rp.bg.ents` (already metres; no working area or freeze there). `chainsOf(layer)`
  needs the same `parts` (it calls `PlanKerbs.joinPieces`, so it gets them for free).
- `open()` goes straight into the pick stage (no `find()` step). The *Find roads* button becomes **Pair all on
  layer**, and *Change layer* goes.
- `down(wx, wy, e)` follows B4.3, tol = `12 / RoadPlan._view.z` as today.
- `hint()` returns the banner text from section B1 (Roads instead of Streets). It is shown through `RoadPlan._hint()`.
- `key(e)`: add Backspace = undo pick. Check that `roadplan.js` passes Backspace to `RoadKerbs.key` before its
  own delete handling.
- `overlay` follows B4.5's colours. Hover needs a move hook. Check how `roadplan.js` routes pointer moves to
  tool `kerbauto`.
- `panelHtml` gets the Add / Subtract buttons, picks list and "Clicked, no partner" list. `create()` is unchanged
  (it uses `PlanKerbs.sides(st, T.chains, T.o)`; pass the chains of the street's own layer, since chain indices are
  now per layer).

---

## B6. Edge cases to handle

1. **A kerb line round a whole block** pairs with several streets. Click adds them all; Shift-click picks one.
   This is the intended behaviour.
2. **Bridged streets** (one street through a junction mouth made of pieces from four chains): clicking any of
   its kerbs adds the whole bridged street; subtracting any of them removes it. Fine and predictable.
3. **Extend / snap at junctions only to chosen streets:** a chosen street must not run on to the centreline
   of a street that is not chosen. `assemble` handles this because it only sees chosen pieces. Test it (7.4).
4. **Cul-de-sac bulbs:** a lone round kerb (bulb ring) is added when it is clicked itself or when the street it
   attaches to is added.
5. **Options change** (`wmin`, `wmax`, `gap`): drop the candidate cache, replay the picks. A pick that now
   matches nothing goes to `lonely` instead of silently vanishing.
6. **Two DXFs on one floor** with the same layer name: pool keys include the DXF id.
7. **Undo of the plan** (Ctrl+Z) while the stage is open: the stage is session-only and Create is one snapshot,
   as today. Ctrl+Z inside the stage should not undo picks (Backspace does).
8. **Performance:** clicking must feel instant. The candidates for a layer are computed once. Folding is cheap
   (set operations plus `extend` and `connect` over the chosen pieces). If `assemble` is slow on a big estate
   (hundreds of streets), refold only the touched layer and cache the per-layer assembled result.

---

## B7. Tests (`testing/unit/kerbs.test.js`, run with `node testing/unit/kerbs.test.js`)

1. **No change to `solve`:** every existing case gives the same streets after the split (compare `pts`, `w`,
   `chains` exactly).
2. **`parts`:** two collinear lines joined into one chain → `parts` = two intervals that meet; a reversed second
   piece still gives the right intervals.
3. **Click adds every street of a line:** an L-shaped block kerb with a straight kerb across each arm → `addChain`
   on the L adds 2 streets.
4. **Shift-click adds one:** same drawing, span on one arm → 1 street, and it does **not** run on to the
   centreline of the street that was not chosen.
5. **Subtract mirrors add:** add the L (2 streets), subtract with a span on one arm → 1 left. Subtract the whole
   line → 0.
6. **Lonely:** a single kerb with no partner → `lonely` has it, 0 streets. Then `pairWith` a parallel kerb drawn
   23 m away (beyond `wmax`, within `pairManual`'s 1.5 × `wmax`) → 1 street, `lonely` empty.
7. **Undo:** three picks, `undo()` twice → same as after the first pick.
8. **Options replay:** set `wmax` below the road width → the pick goes to `lonely`; set it back → the street
   returns.
9. **Two layers:** kerbs on layer A, erf boundaries 15 m apart on layer B. Clicking a B line does not pair it with A
   (same-layer rule), and A's streets are unaffected.
10. **Pair all:** `pairAll(layer)` gives the same streets as the old `solve(chains)` on that layer.

Also run `node --check` on every changed JS file.

---

## B8. Checking it in the app (the `verify` skill has the headless recipe)

1. Open a project with a survey DXF of kerb lines, calibrate, Plan › Auto layout › Streets › **Pick kerbs**.
2. The banner shows the Add text. Click one block kerb: its streets go amber, and the toast gives the count.
3. Shift-click a piece of another block: one street.
4. Alt-click a kerb: its streets go. Press **Subtract**, click: the same. The banner changes text.
5. Click a lone kerb: red, "no partner". Click it again, then the kerb across: a street.
6. Backspace three times: back to the start.
7. **Pair all on layer**, then subtract two streets, then Enter: the streets are created with names and widths,
   as before.
8. Freeze a layer with the Freeze layer tool: its lines can no longer be clicked.
9. The same flow in Street lighting › Road plan › Roads from kerbs, ending in Create.
10. Run the existing Auto layout verification with the created streets to confirm nothing downstream changed.

---

---

# Housekeeping (both parts, from CLAUDE.md)

Two PRs (B first, then A) or one; each PR does all of this for what it changes.

- **CLAUDE.md** Project Structure entries:
  - Part B: update `plan-kerbs.js` (candidates / assemble, `parts`, spans, pick-based stage),
    `roadplan-kerbs.js` and `plan-layout-ui.js` (the "Alt-click removes, Shift-click two kerbs adds" wording changes).
  - Part A: add `plan-reserve.js` (PlanReserve: contours → streets, split at junctions, carriageway, kerb returns;
    node test `testing/unit/reserve.test.js`) and `roadplan-reserve.js` (RoadReserve); extend `plan-roomdetect.js`
    (target `reserve`: raster regions with holes, seam closing, working area + cut lines as walls),
    `plan-layout-ui.js` (Streets from road reserve, street props `reserveProfile` / `carriageW` / `cwOffset` /
    `auto: 'reserve'`, `settings.layout.streetReturns`) and `roadplan.js` (`rp.junctionReturns`, returns in the
    conflict areas).
- **New script tags** in `index.html` for `plan-reserve.js` (before `plan-layout-ui.js`) and `roadplan-reserve.js`
  (after `roadplan-kerbs.js`), with `?v=` = the PR version.
- **Collab:** sync `rp.junctionReturns` and `settings.layout.streetReturns` (`collab-data.js` descriptors).
- **Help text** (never cite a `.md` file in user-facing text):
  - `help-guides.js` l.519 (Auto layout streets step): add road reserve, and describe click add / subtract for kerbs.
  - `help-design.js` Road plan article (l.269–276): Roads from road reserve, kerb returns, click-picked kerbs.
- **BACKLOG.md:** a Completed entry per part; if listed as outstanding, remove it from the index and strike it through.
- **Version:** open the PR, then push a commit setting `APP_VERSION = '2.<PR number>'` in `constants.js` and
  bumping `?v=` on `constants.js` and on every changed file in `index.html` (`plan-kerbs.js` is still on
  `?v=2.627`, `roadplan-kerbs.js` on `?v=2.661`).
- **Checks:** `node --check` on every changed JS file, `node testing/unit/kerbs.test.js`,
  `node testing/unit/reserve.test.js`, `node testing/unit/roomdetect.test.js`; nothing in `backend/analysis/`
  changes, so the backend suite is not required (run it anyway if `road_plan.py` is touched for the conflict
  area polygons).
