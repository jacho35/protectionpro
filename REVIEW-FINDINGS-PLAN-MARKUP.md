# Plan Markup — Consolidated Review Findings (for implementation)

**Date:** 2026-07-12
**Scope:** The Plan Markup / Distribution Plan workspace and its plan↔SLD integration, built over roughly the last 60 commits (PRs #139–#144): floor-plan device placement, array/path placement, per-device circuit attributes, auto-circuiting, DB schedule editing from the plan, plan↔SLD sync (From-SLD adoption, plan-first feeders, DB→DB feeding), DXF round-trip, DD import, mobile toolbar.
**Method:** Three independent passes — a UI/UX expert review of the new interfaces, an electrical-engineering review of the plan↔SLD data flow, and an adversarial senior-developer verification of every finding against the code (every cited line opened; "never written" claims grep-verified; cable-library name intersection computed programmatically; EE-1 reproduced empirically in the backend Docker image).
**Status:** Findings only — **no changes have been implemented.** Severities below are the post-challenge adjusted calls. Line numbers are as of commit `e85601f`.

---

## What works well (for calibration)

The plan→SLD bridge is thoughtfully architected: id-linked idempotent sync with deletion propagation behind a confirm (`plan-sync.js:594-599`), per-floor scale calibration flowing into every length computation, and a sound lumped-board model — `DBSchedule.recompute()` correctly separates connected VA, per-way demand factors, board diversity, and per-phase (R/W/B) demand shares feeding the unbalanced load flow. Switches/detectors/ELV points correctly carry no load. On the UX side: escape-to-cancel and snapshot-undo idioms mirror the SLD, snap feedback uses color-coded rings, the mobile overflow menu has real 40 px touch targets, and dark mode is a clean CSS-custom-prop theme flip.

---

## Recommended implementation order

The EE reviewer's "EE-1 gates everything" argument was verified empirically and is correct: until `distribution_board` participates in the network walkers, the wrong cable data of EE-4/EE-6/EE-9 is at least not *used* — fixing those first would create the illusion of working analysis. EE-7 comes early because it changes the data model that the EE-2/EE-3 fixes would otherwise be built on twice.

1. **EE-1** — make `distribution_board` walkable in all analysis walkers; add the regression test.
2. **EE-7** — stable internal way ids (substrate for every conflict-resolution fix).
3. **F-PIN (UX-2 ≡ EE-2, + EE-14 poles guard)** — actually set the pin flags; pinned/auto indicator + unpin.
4. **EE-3** — zero/flag orphaned ways in `syncLoads`; sync on device delete/unassign.
5. **EE-4** — resolve plan cable types to real electrical parameters.
6. **EE-6 (+ EE-9's cable_mm2 half)** — length/name pin semantics for feeder cables (same PR as #5).
7. **EE-5** — feeder direction from source-path inference, prompt fallback.
8. **UX-4 + SD-1** — cross-stack undo design for sync operations (do this *after* the sync semantics above are stable, or it gets redesigned twice).
9. **UX-1** — floating Done/Cancel chip for multi-point drafts (touch completion).
10. **UX-3 + UX-7 (+ UX-14 readout)** — plan-toolbar undo/redo buttons and a live status/mode line (also neutralises UX-13).

Then the minors, roughly: UX-6, UX-12, EE-8, EE-10, EE-11/EE-12, UX-9 docs, UX-11, UX-15, UX-16/UX-17, and a cleanup batch of EE-15/EE-16/UX-18/SD-3.

---

## CRITICAL

### EE-1 — Sub-boards fed via plan-synced feeders are invisible to load flow, fault analysis and cable sizing
**Verdict:** CONFIRMED (empirically, in the backend Docker image).
**Where:** `plan-sync.js:357-368, 373-386, 662-691`; `backend/analysis/loadflow.py:18-19, 57-94, 1021, 1196-1203`; `backend/analysis/fault.py:531-543`; `backend/analysis/cable_sizing.py:335, 479, 577-579`.
**Finding:** The sync wires DB→DB feeding as `MDB(out) → outgoing bus → cable → SDB(in)`, but `distribution_board` is neither in `TRANSPARENT_TYPES` nor a branch element, so every network walk terminates at a board: the feeder cable never becomes a Y-bus branch, the outgoing bus forms a sourceless island, and a board fed through a cable is never found by `_find_components_at_bus`. Reproduced with the exact sync topology (utility → bus → MDB 50 kVA; MDB bus → 30 m cable → SDB 30 kVA): the utility supplies exactly 0.0425 MW (MDB only), the outgoing bus reports *"Island … has no connected source — reported de-energized (0 V)"*, and the SDB's 30 kVA vanishes from the solution. The same walker blockage in `fault.py` means no fault level downstream of any board, and cable sizing gets `load_current = 0` for every plan-created feeder, so thermal/volt-drop checks trivially pass on unloaded cables. The flagship DB→DB feature draws correctly but analyses wrongly.
**Fix direction:** Make `distribution_board` walkable (pass through `in`→`out` as a zero-impedance link while still attaching its lumped load at the incomer side) in loadflow, unbalanced loadflow, fault, and the cable-sizing/arc-flash adjacency. Add a regression test with the exact plan-sync topology asserting the utility supplies MDB + SDB demand and the feeder cable carries the SDB current.

### F-PIN (UX-2 ≡ EE-2) — Manual schedule edits are silently overwritten: the "pin" flags are never set anywhere
**Verdict:** CONFIRMED (grep-verified). Both reviewers found this independently; merged into one ticket.
**Where:** Reads at `plan-circuits.js:11, 114-116, 324` (`_manualLoadOverride`, `_nameOverride`, `_cableManual`); **no writes anywhere in `frontend/js/`**; `dbschedule.js:425-460` (cell change handler sets `c[k]` but never a flag); trigger path `plan-ui.js:425-431` and `plan.js:127-133`.
**Finding:** `syncLoads()`/`syncRoutedLengths()` deliberately skip ways "a user has pinned" — dead code, since nothing ever sets those flags. And sync is not just a button: **every commit of any device circuit attribute calls `PlanCircuits.syncLoads()`** (`plan-ui.js:425-431`). A user who opens "📋 Edit Circuit Schedule" (from SLD or plan), hand-tunes a way's `load_va`, description or `cable_m`, then tweaks any device's attribute on the plan, silently loses their edits. The plan always wins, invisibly — worse than a visible conflict because the engineer believes the corrected figure stuck. Silent data loss in the feature's core loop.
**Fix direction:** Set `_manualLoadOverride`/`_cableManual` in the `DBSchedule` change handler when the user edits `load_va`/`cable_m` on a way with `plan_qty > 0` (and `_nameOverride` for description). Extend the guard to poles/phase demotion (see EE-14). Show a per-way "auto / pinned" indicator with an unpin control. Build on the stable way ids from EE-7.

---

## MAJOR

### UX-1 — Several drawing tools cannot be completed on a touch device
**Verdict:** PARTLY — scope narrowed from "most tools" (downgraded from Critical).
**Where:** `plan-tools.js:437-441` (free-ended routes), `:571-575` (trench/measure/room), `:701-705` (SL path), `:967-970` (devpath); `plan-engine.js:689-693`.
**Finding:** Trench, measurement, room, SL path, devpath, and routes ending in free space finish **only on Enter** — impossible on a phone (no on-canvas Done button; double-tap is reserved for vertex deletion). Devpath being dead on mobile is the one real workflow hole in the building domain. *Corrections from verification:* element-terminated routes (the dominant circuit gesture), single place, placeSld, crossing, calibrate, align, crop, text, and notably the **array tool** (pointer-up driven, `plan-tools.js:920`) all complete fine on touch.
**Fix direction:** Floating "✓ Done / ✕ Cancel" chip on the stage whenever a tool holds a multi-point draft (also helps desktop discoverability). "Tap the last placed vertex to finish" is a cheap, conflict-free alternative (draft vertices don't collide with the dblclick-delete of committed routes).

### UX-3 — No undo affordance except Ctrl+Z; plan undo unreachable on mobile
**Verdict:** CONFIRMED.
**Where:** `plan.js:38-100` (toolbar has no undo/redo buttons), `plan.js:554-563`, `app.js:243-254`. Compare SLD toolbar buttons at `app.js:174-175`.
**Finding:** The plan has a working 50-deep undo stack invocable only via Ctrl+Z/Ctrl+Y. On a phone, a mis-tap delete or a bad auto-tag batch is unrecoverable.
**Fix direction:** Add ↶/↷ buttons to the plan toolbar primary row (not the overflow).

### UX-4 — Cross-view sync mutates the SLD outside both undo stacks
**Verdict:** CONFIRMED, but the original recommendation is insufficient — see SD-1 below; this needs a design decision.
**Where:** `plan-sync.js:601, 653, 676-678`; `plan-circuits.js:107-123`; plan `_snapshot` serializes only `AppState.planMarkup` (`plan.js:543-551`); no `UndoManager.snapshot()` call in either file; `UndoManager.snapshot()` itself excludes `planMarkup` (`undo.js:28-37`).
**Finding:** Sync, bulk-assign and auto-tag create/delete SLD components and rewrite board schedules without pushing any SLD snapshot. Ctrl+Z after a sync half-reverts the world: the plan rolls back (including `sldId` link fields) while the SLD keeps its new boards/cables — dangling links.
**Fix direction:** Simply adding `UndoManager.snapshot()` is a footgun (see SD-1): after an SLD-side undo, the next sync's `_collectDeletions` (`plan-sync.js:539`) interprets the undo as a cross-view deletion and offers to delete the user's plan boards. Either (a) sync operations push **paired** snapshots to both stacks and dangling links from undo are handled leniently (the "Keep both" re-link logic at `plan-sync.js:612-619` is reusable), or (b) include the plan link fields in the SLD snapshot. Sequence this after the sync-semantics fixes (F-PIN, EE-3, EE-6) are stable.

### UX-5 — Linked entities are visually indistinguishable in both views
**Verdict:** CONFIRMED (grep: zero rendering reads of `sldId`/`planLink`/`swLink` in `canvas.js`, `symbols.js`, `properties.js`, `plan-engine.js`, `plan-symbols.js`).
**Where:** Links set at `plan-sync.js:448-461, 511-523`; only hint is the unlinked-board note at `plan-ui.js:338`.
**Finding:** The plan↔SLD bridge is invisible: no linked badge on either canvas, no counterpart named in either properties panel. The deletion-propagation confirm at next sync reads as a surprise, and "which view is authoritative?" has no on-screen answer.
**Fix direction:** Small link glyph on linked plan elements and linked SLD boards/cables; "Linked to: <name> (open)" row in both properties panels with a jump-to action.

### UX-6 — Mobile: touching an element to drag it slides the properties drawer over the canvas mid-gesture
**Verdict:** CONFIRMED.
**Where:** `plan.js:401-413` (`selectOnly` auto-opens the props drawer on mobile), called from select-tool **onDown** (`plan-tools.js:154`); drawer is `min(86vw, 320px)` with a backdrop (`mobile.css:637-659`).
**Finding:** The drawer + dimming backdrop animate over most of the screen on **pointerdown**, before the user has disambiguated tap-to-edit vs touch-to-drag; the drag continues behind the drawer.
**Fix direction:** Open the drawer on pointer**up** only when the gesture never moved (a tap); keep drag starts drawer-free.

### UX-7 — Armed placement/route modes have no visible indicator (none at all on mobile)
**Verdict:** CONFIRMED.
**Where:** `plan.js:523-533` (`onToolChanged` highlights only `data-tool` toolbar buttons; place/route/array/devpath have none), `plan.js:532` (mobile closes the palette drawer on arming), `plan.js:95` (`#plan-info` static hint, never updated). Compare the SLD status-bar mode readout (`app.js:111-112`).
**Finding:** Arming "Ceiling Light → Path" on mobile leaves zero on-screen indication of the active tool, armed device type, or how to finish/exit. Desktop's only cue is a crosshair cursor plus a highlight inside a closed drawer.
**Fix direction:** Repurpose `#plan-info` as a live mode/status line ("Placing: 2× Socket — tap to place, Esc/Select to stop"), updated from `onToolChanged` and the tools. Combine with UX-9 (shortcuts docs) and UX-14 (calibration readout) as one status-line pass.

### UX-9 — Advertised/expected shortcuts don't work; plan shortcuts undocumented
**Verdict:** CONFIRMED.
**Where:** `plan.js:46` (title "Select / move (V)") vs `plan.js:483-521` (no `v` case; key swallowed at `app.js:256`); Ctrl+C/V/X/D/A suspended in plan (`app.js:243-257`); Help lists SLD-only keys (`index.html:2133-2161`).
**Finding:** The Select tooltip promises a V shortcut that does nothing; copy/paste/duplicate/select-all listed in Help silently no-op in the plan. The plan's real power keys (G snap, Enter finish, Shift+click insert vertex, dblclick/right-click delete vertex, R rotate) appear in no Help tab.
**Fix direction:** Implement V (and at minimum Ctrl+A/Ctrl+D — duplication is very common when placing devices); add a "Plan workspace" section to the Help shortcuts table.

### EE-3 — Ghost loads: deleting or re-tagging all devices on a way leaves its load_va, plan_qty and cable_m stale forever
**Verdict:** CONFIRMED.
**Where:** `plan-circuits.js:79-125` (`syncLoads` iterates only ways present in `agg`), `:305-329` (`syncRoutedLengths` same pattern); `plan.js:435-444` (`deleteSelected` never calls `syncLoads`); no sync before analysis runs.
**Finding:** Delete the last 10 lights on way 3 (or retag them) and way 3 keeps its 1000 VA, `plan_qty: 10` and `cable_m` indefinitely — even after an explicit re-sync. The board's `rated_kva`, phase balance and leakage totals silently overstate the design. Stark asymmetry with F-PIN: user edits are overwritten, but device deletions are never reflected.
**Fix direction:** In `syncLoads`, for every linked board also visit ways with `plan_qty > 0` that received no aggregate this pass: zero `load_va`/`plan_qty` (or flag "orphaned way — devices removed") unless pinned. Call `syncLoads()` from `deleteSelected` when building devices were removed.

### EE-4 — Plan feeder cable types never map to electrical parameters
**Verdict:** CONFIRMED (programmatically: **zero** name intersection between the 39 `BUILDING_CABLES` and 78 `STANDARD_CABLES` entries).
**Where:** `plan-sync.js:683-686` (`STANDARD_CABLES.find(c => c.name === r.cableType)` can never match; even on a match only `standard_type` is set, never r/x); `plan-defs.js:26-71` (`BUILDING_CABLES` carries r/x/rating that go nowhere); `constants.js:1496-1508` (palette defaults); `loadflow.py:860-866` (pu conversion uses the cable's own `voltage_kv`); `compliance.js:794` (`if (!sizeMm2) continue` — check skipped entirely).
**Finding:** A plan feeder drawn as "10mm² x4C Cu PVC/SWA" (r = 2.2 Ω/km, 70 A) becomes an SLD cable whose name says 10 mm² SWA but whose props remain palette defaults: `r_per_km` 0.1 (22× too low), `rated_amps` 400 (5.7× too high), `voltage_kv` 11 on a 400 V feeder — so where a branch does form, per-unit impedance is additionally wrong by (11/0.4)² ≈ 756×. Volt-drop, fault contribution, ampacity, and the SANS 10142-1 In≤Iz compliance check (skipped: no `size_mm2`) all run on fictitious data while the diagram confidently displays the selected type.
**Fix direction:** In `syncBuildingToSLD`/`reflectSldFeeders`, resolve `r.cableType` against `BUILDING_CABLES` first and copy `r_per_km`/`x_per_km`/`rated_amps`/`size_mm2`; set `voltage_kv` from the boards (0.4). Consider registering `BUILDING_CABLES` entries in the standard cable library. Same PR as EE-6/EE-9.

### EE-5 — Feeder direction (who feeds whom) is determined purely by route draw order
**Verdict:** CONFIRMED.
**Where:** `plan-sync.js:665-689` (`a = elById[r.fromId]` unconditionally upstream); `:322-324` (reflection fallback `ends.find(e => e.viaBus) || ends[0]` is wire-iteration order).
**Finding:** A feeder drawn from the sub-board toward the main board inverts the hierarchy: outgoing bus and "Feeder to Sub-board" way land under the sub-board, and the SLD wires SDB → cable → MDB. No validation against supply topology, no warning; with EE-1 unfixed, load flow doesn't catch it either.
**Fix direction:** Infer direction from the SLD (which end has a source path / is closer to an intake) or a board hierarchy; at minimum prompt "Which board feeds?" when both ends are DBs, and flag reversed feeders.

### EE-6 — Every sync overwrites SLD cable lengths (and names) with plan straight-line distances
**Verdict:** CONFIRMED, blast radius slightly narrower than reported.
**Where:** `plan-sync.js:334-339` (reflected route is a 2-point chord between symbols), `:684` (`if (rf) cable.props.length_km = …` unconditional; name likewise at `:683`). Mitigation found in verification: cross-floor feeders are skipped (`:332-333`), so riser lengths on *cross-floor* cables survive; the overwrite bites same-floor feeders.
**Finding:** When an SLD cable is auto-reflected onto the plan as a straight chord, the next sync replaces the engineer's SLD-entered `length_km` with that chord length — typically shortening it, which understates volt drop and fault-loop impedance (the non-conservative direction). No manual-length pin exists for feeders.
**Fix direction:** Only write `length_km` when the plan route has been edited since the last sync (or is longer than current); never overwrite from an auto-generated 2-point reflected route; add a per-cable manual-length pin mirroring the F-PIN semantics. Same PR as EE-4.

### EE-7 — Way identity is a mutable, non-unique string: renumbering or duplicates silently remap device loads
**Verdict:** CONFIRMED.
**Where:** `plan-circuits.js:106` (`circuits.find(x => String(x.way) === way)` — first match wins); `plan-sync.js:395` (feeder way numbered `String(circuits.length + 1)` — collides after deletions); `dbschedule.js:274` (way freely editable), `:407, :487, :519` (`length + 1` numbering).
**Finding:** Device tags reference ways by number with no uniqueness or stability guarantee. Delete way 2 of 5, add a feeder way → it mints way "5", duplicating the existing way 5; `syncLoads` can then dump lighting/socket VA onto the feeder row. Renumbering ways silently redirects every plan device's load into a different physical circuit.
**Fix direction:** Give ways a stable internal id (tags reference the id; the way number becomes a display/print field), or enforce unique way numbers and re-map plan tags on renumber. **Do this early — it's the substrate for the F-PIN and EE-3 fixes.**

---

## MINOR

### UX-8 — Array/slpath prompts discard the drawn draft on bad input; no preview
**Verdict:** PARTLY (downgraded from Major — devpath already keeps its draft, contradicting "every parametric tool").
**Where:** `plan-tools.js:925` (array clears the rect *before* the prompt), `:716` (slpath nulls `_pts` on bad spacing); devpath correctly returns without clearing (`:990`); calibrate costs two clicks.
**Fix direction:** Keep the draft alive across invalid entry and re-prompt (copy devpath's pattern); longer-term, a non-modal chip with count/spacing steppers and a live ghost preview.

### UX-10 — No busy state for backend round-trips; raw `alert()` calls
**Verdict:** CONFIRMED (downgraded from Major — errors do surface, payloads are small; polish, not data loss).
**Where:** `plan-dxf.js:103-121`; `plan-images.js:61-125`, raw `alert()` at `:66, :86, :92, :123`.
**Fix direction:** Disable the trigger button + toast/spinner for the duration; swap `alert()` for `UI.alert`.

### UX-11 — Selecting a measurement renders a completely blank properties panel
**Verdict:** CONFIRMED.
**Where:** `plan-ui.js:286-288` (`else { el.innerHTML = ''; return; }`). Worse on mobile where the blank drawer auto-opens.
**Fix direction:** "Measurement — 12.4 m" title plus the standard Delete button.

### UX-12 — Per-keystroke undo snapshots and SLD re-renders from the properties panel
**Verdict:** CONFIRMED, plus a correction: even circuit-attr fields snapshot per keystroke — the `:425` guard only gates the *sync*, not the fall-through snapshot at `:440`.
**Where:** `plan-ui.js:18-19` (bound to both `input` and `change`), `:440` (snapshot per event), `:420-422` (rename → `PlanSync.onElementRenamed` → `Canvas.render()` per keystroke via `plan-sync.js:717`).
**Fix direction:** Apply value on `input`, snapshot/propagate only on `change`, for all fields.

### UX-13 — Tiny targets on plan-row buttons; unconfirmed plan-image removal
**Verdict:** CONFIRMED, with mitigation: remove-plan *is* undoable (plans live in planMarkup snapshots; image bytes stay server-side keyed by `imageId`) — the real problem is unreachable undo (UX-3).
**Where:** `plan-ui.js:126-128, 168-174`; `plan.css:171, 186-193`; floor delete confirms (`plan.js:374`), plan-image delete doesn't.
**Fix direction:** ≥32 px hit areas on touch; implement together with UX-3; an undo-toast beats another confirm.

### UX-14 — Calibration state buried; snapping silently no-ops when uncalibrated
**Verdict:** CONFIRMED.
**Where:** `plan.js:86` (scale readout inside `#plan-tb-overflow` — hidden in the ⋯ menu on mobile); `plan-tools.js:89-94` (grid snap requires `factor()`); `plan-engine.js` `_drawGrid` early-returns uncalibrated.
**Fix direction:** Move the scale readout to the always-visible status pill; render as a warning chip when uncalibrated, tappable to start Calibrate. Part of the UX-7 status-line pass.

### UX-15 — The domain switch is an unlabeled dropdown, defaulting to Reticulation
**Verdict:** CONFIRMED.
**Where:** `state.js:238` (default `domain: 'retic'`); `plan-ui.js:43-45` (bare `<select>`, no label/title); `plan.js:207-215` (Push button silently relabels per domain).
**Finding:** A user opening "Plan" to mark up a floor plan (the headline feature) lands in site-reticulation mode; the building toolset only appears after changing an anonymous select that looks like a filter.
**Fix direction:** Label it ("Plan type"), add a `title`; consider a first-open chooser (Site plan / Building floor plan).

### UX-16 — Floor-manager modal: no dialog semantics, no focus move, leaks DOM on Escape
**Verdict:** CONFIRMED.
**Where:** `plan.js:298-339` (no `role="dialog"`/`aria-modal`/focus) vs `ui.js:96-97`; `app.js:369` (generic Escape hides but doesn't remove — orphaned `.modal` overlays accumulate and perturb the topmost-modal Escape logic).
**Fix direction:** Reuse `UI._dialog`-style scaffolding, or at least add role/aria, focus the first field, and remove-on-Escape via a scoped keydown like `dbschedule.js:42-47`.

### UX-17 — Plan canvas has zero keyboard/AT reachability
**Verdict:** CONFIRMED.
**Where:** `plan.js:93-94` (no tabindex; SLD canvas has tabindex/role at `index.html:408`); `plan-engine.js:672-708` (pointer-only) vs SLD arrow navigation (`app.js:115-163`).
**Fix direction:** Make `#plan-canvas-fg` focusable (`tabindex="0"`, `role="application"`, `aria-label`); port the SLD's arrow-key nearest-entity navigation so the existing nudge/rotate/delete keys become reachable.

### EE-8 — Auto-created ways are class-blind: socket circuits get lighting defaults (10 A, 1.5 mm², DF 1.0)
**Verdict:** CONFIRMED (grep confirms no way-level load-vs-breaker check anywhere).
**Where:** `plan-circuits.js:131` (`_newWay` hard-codes the lighting preset); `constants.js:1085` (socket preset: 20 A / 2.5 mm² / DF 0.4); contradicts the app's own compliance text (`compliance.js:812`, SANS 10142-1 ≥ 2.5 mm² for socket outlets).
**Finding:** A socket way minted from plan tags lands with 1.5 mm² and DF 1.0 — overstating demand while understating the conductor. Also: no check anywhere that way current ≤ `breaker_a` or breaker ≤ cable ampacity; 5 000 VA on a 10 A way passes silently.
**Fix direction:** `_newWay` seeds from the aggregate's dominant class preset; add per-row warnings (way current vs `breaker_a`; `cable_mm2 < 2.5` on socket ways). Closes EE-17(b) automatically.

### EE-9 — "Feeder to Sub-board" ratings (63 A / 25 mm²) never validated against sub-board demand
**Verdict:** CONFIRMED.
**Where:** `plan-sync.js:389-405` (static defaults; `cableType` stored in `c.cable`, which has no column in the schedule table — `dbschedule.js:336-341`); `constants.js:1093-1096`.
**Fix direction:** On sync, copy sub-board `rated_kva × demand_factor` into a read-only "downstream demand" on the feeder way; warn when it exceeds `breaker_a`; derive `cable_mm2` from the chosen `BUILDING_CABLES` entry (same PR as EE-4/EE-6).

### EE-10 — Auto-tagging picks the "nearest" board across all floors by 2D coordinates
**Verdict:** CONFIRMED.
**Where:** `plan-circuits.js:61-69` (`boardEls()` spans floors), `:264-267` (2D distance only).
**Finding:** Level-3 lights can be tagged to a Level-1 DB in the same riser position, with no indication.
**Fix direction:** Restrict candidates to the active floor; fall back to other floors only when the active floor has none, with a toast naming the chosen board and floor.

### EE-11 — DD import silently drops circuit assignments, board schedules, and non-lighting wattages
**Verdict:** CONFIRMED.
**Where:** `plan-dd-import.js:16-18` (documented drop of `building.dbs`), `:244` (`_ddWatts` written, never read), `:260-263` (`_socketGangs` writes `props.gangs` while the editor uses `outlets` — an imported double socket computes 400 VA while the panel shows "Single"); completion dialog (`:61-63`) omits the drop.
**Fix direction:** Map DD circuit tags to `circuitDbId`/`circuitNo` (boards import as `bd_db`; ids are in `idMap`); promote `_ddWatts` to `load_va` for load devices; translate gangs→`outlets`. At minimum, list "circuits/schedules not imported" in the completion dialog.

### EE-12 — DXF round-trip severs routes from devices and freezes auto loads
**Verdict:** CONFIRMED.
**Where:** `plan-dxf-import.js:62-67` (routes rebuilt `fromId/toId: null`, points without `snappedTo`), `:93` (`LOAD_VA` → explicit `props.load_va` override — a 20 W light comes back pinned at 20 VA); `plan-dxf.js:55-57` (export writes effective VA); DBOARD relink by lowercased name, duplicates overwrite (`:49`).
**Finding:** After a round-trip, routes are pure geometry — `propagateFrom`, `bulkAssign` and `syncRoutedLengths` can no longer see them, so routed lengths and tag propagation silently stop working.
**Fix direction:** On import, re-snap route endpoints/vertices to devices within a small coordinate tolerance (the geometry is exact — it's ours); only set `props.load_va` when it differs from the recomputed auto VA.

### EE-13 — Route lengths understate reality: splines measured as chords, no vertical-drop allowance
**Verdict:** CONFIRMED; recommendation revised to reuse existing machinery.
**Where:** `plan-sync.js:22-26`, `plan-circuits.js:311-314`, `plan-csv.js:42-46` (all sum straight segments) vs the Catmull-Rom renderer (`plan-engine.js:581-596`).
**Fix direction:** Measure curved routes by sampling the actual spline. For vertical allowance, **do not invent a new setting** — the app already has `settings.riserFactor`, per-floor heights, and `AppState.planVerticalRunM()` (`state.js:370-383`), currently consumed only by the CSV BOQ (`plan-csv.js:101-126`); extend `syncRoutedLengths`/feeder lengths to consume that existing riser model, plus an optional per-point drop allowance knob.

### EE-14 — syncLoads demotes 3P ways to 1P-on-R without confirmation
**Verdict:** PARTLY — narrower than reported: an existing 1P way's phase is preserved unless it was 'RWB'; Auto Balance assignments on 1P ways survive syncs. The genuine defect: a way the engineer set to 3P is demoted to 1P and forced onto phase R whenever its devices declare 1P, every sync, with no pin.
**Where:** `plan-circuits.js:111-113` (outside the pin guard); device editor mislabels poles as "Phase" (`plan-ui.js:322-326`).
**Fix direction:** Only escalate 1P→3P; never demote without confirmation (fold into the F-PIN guard). Rename the device field to "Poles".

---

## NITS

### UX-18 — `UI.toast(..., 'warn')` produces an unstyled toast
`plan-tools.js:417, 448, 620, 822` pass `'warn'` → class `toast-warn`; only `.toast-warning` exists (`app.css:116`). Base `.toast` style still shows, so cosmetic. Fix: use `'warning'` or alias inside `UI.toast`.

### EE-15 — Duplicate `deviceVA` key in the PlanCircuits object literal
`plan-circuits.js:45-50` and `:53-58` — identical bodies, second silently shadows the first. Delete one.

### EE-16 — Board demand current always uses the three-phase formula
`dbschedule.js:294-295, :570-571` — a 10 kVA all-1P board shows 14.4 A instead of ~43 A at 230 V. Fix: if every way is 1P (or a supply-phases prop says single-phase), compute at 230 V; otherwise also show worst-phase current.

### EE-17 — Load-model conventions (partial)
(a) Lighting W≈VA summed into `load_va`, then the board lump applies PF 0.85 to everything (`loadflow.py:1197`) — lighting-heavy boards under-report P ~15% and invent Q. (b) Plan-derived socket ways at DF 1.0 vs the preset's 0.4 — same six sockets cost 1 200 VA from the plan vs 480 VA from the preset; **closed by the EE-8 fix**. (c) *Partially refuted:* FCU load is not immutable — `props.load_va` is an editable per-device override with an "auto:" placeholder (`plan-ui.js:327-329`); reduces to a defaults/documentation nit. Fix: document conventions in the circuit editor tooltip.

---

## Additional findings from the senior-developer verification pass

### SD-1 — Major — SLD undo can escalate into a two-view data-loss prompt
**Where:** `undo.js:28-37` (SLD snapshots exclude `planMarkup`); `plan-sync.js:539, 596-599` (`_collectDeletions`: "plan element whose primary SLD component is gone").
**Finding:** Beyond UX-4: *any* SLD undo/redo crossing a sync boundary strands `sldId`/`planLink` pairs, and the next sync's deletion-propagation prompt then proposes deleting plan boards that were never deleted — an ordinary undo escalates into a two-view data-loss prompt. The most dangerous interaction neither specialist named explicitly. Fix together with UX-4 (item 8 in the order); the "Keep both" re-link path at `plan-sync.js:612-619` is the reusable ingredient.

### SD-2 — Major — DBSchedule Excel import nukes plan-integration fields
**Where:** `dbschedule.js:718` (`comp.props.circuits = circuits` wholesale replace).
**Finding:** Importing a schedule into a plan-linked board drops `type:'feeder_db'`/`feedsDbId`, `plan_qty`, and any future `_manual*` pin flags. The next sync re-mints a duplicate "Feeder to Sub-board" way via `_ensureFeederCircuit` alongside the imported plain copy, and `_newWay` re-creates plan ways that collide with imported way numbers (compounding EE-7).
**Fix direction:** Merge imported rows into existing ways by way id (post-EE-7) instead of wholesale replacement; preserve integration fields; warn when importing into a plan-linked board.

### SD-3 — Minor — Inconsistent light-load defaults (100 W vs 20 W)
**Where:** `plan-circuits.js:30` (`LOAD_TYPES.bd_light` falls back to **100** W) vs `plan-defs.js:143` (placed-device default **20** W).
**Finding:** Clear a light's watts field and its circuit contribution silently quintuples. Fix: single shared default.

---

## Duplicates / merges (ticketing guidance)

- **UX-2 ≡ EE-2** → merged above as **F-PIN**; EE-2's write-up has the more precise trigger analysis.
- **EE-8(b) ⊂ EE-17(b)** — same fact; the EE-8 fix closes both.
- **UX-13 depends on UX-3** — implement together; undo-toast beats another confirm.
- **EE-4 + EE-6 + EE-9 (cable_mm2 half)** — all live in `syncBuildingToSLD`/`reflectSldFeeders`/`_ensureFeederCircuit`; one PR.
- **UX-7 + UX-9 + UX-14** — converge on one "live status line + shortcut docs" UI pass.
- **UX-4 + SD-1** — one cross-stack-undo design task.
