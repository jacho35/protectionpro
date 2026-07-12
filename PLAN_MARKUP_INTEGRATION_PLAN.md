# Plan Markup Module — Implementation Plan

## Context

Retic Builder Pro (`retic-builder-pro-v2.0.5.html`, React) and Distribution Designer Pro (`distribution-designer-pro_v9.37.html`, vanilla JS) — both in the repo root as reference apps — each have a graphical interface for importing a site/floor plan (PDF/image), calibrating its scale, marking it up with electrical components and cable routes, and exporting the placed components as schedules. The user wants this capability rebuilt from the ground up as a new ProtectionPro module.

**User decisions (confirmed):**
- ONE combined drawing engine serving both domains, modeled on **Distribution Designer's engine/interface feel**; Retic Builder's (simpler) site-plan entities fit into it. Building-distribution entities structured in from day 1, fully populated in a later phase.
- Plan images stored on the **backend** (not IndexedDB like the source apps).
- v1 exports: **component-schedule CSVs + DXF**. (Annotated PNG/PDF drawing sheets = later phase.)
- Work goes on a **new branch off `main`** (e.g. `feature/plan-markup`), PR back to main.

**Key prior art already merged to main:** the Reticulation/ADMD workspace (`frontend/js/retic.js`, `backend/analysis/admd.py`) implements the *tabular* half of RETIC_ADMD_INTEGRATION_PLAN.md; that plan explicitly deferred "site-plan geometry" — this module is that deferred piece, and it pushes measured geometry into the existing Reticulation schedules.

---

## Reference line-number index (verified; use for porting)

**ProtectionPro:**
- Workspace pattern: `retic.js:23-60` (init/activate/deactivate), tabs `index.html:28-30`, sibling `<div id="retic-workspace">` `index.html:513`; script tags `index.html:2201-2232` (flat `<script>` globals, libs in `js/lib/`). Toggle is binary today — must generalize.
- Keyboard routing: `app.js:180-194` (retic-active branch); dark mode `app.js:135-145`.
- State hooks: `state.js` — reticulation shape :116-144, id helpers :170-178, `reset()` :707, `toJSON()` :827, load-backfill :951-977, post-load rebaseline ~:1005.
- Retic local undo: `retic.js:790-819`; `_newKiosk`/`_newErf` :88-115; `_cableOptions` (cable stored by **name** from `STANDARD_CABLES`) :412-420; `fedFromOptsFor` :474.
- Pointer pipeline to port: `canvas.js:59-194` (pointerdown on surface, move/up/cancel on **document**), pinch `:845-873`, `zoomAt` :876-883. **Project rule: native Pointer Events only — no mouse listeners.**
- Palette/properties patterns: `sidebar.js:41,77-138`; `properties.js renderField` :309; `constants.js COMPONENT_DEFS` :1105.
- CSV: `project.js csvCell` :13, assembly/download :495-497; export-button wiring :24-38. Rasterize pipeline (later phase): `project.js:263-378`.
- Backend: `database.py:39` `Project.data Text`, `:55` `Revision.data` full snapshot per save; routers `main.py:27-31`; `requirements.txt` has **no python-multipart**; `frontend/nginx.conf:26` `client_max_body_size 10m`; docker volume `db-data:/data`.

**Distribution Designer (`distribution-designer-pro_v9.37.html`) — the engine model:**
- Dual canvases `#fpC_bg`/`#fpC`, layout `rFP()` :12561; rAF draw `fpDrawSoon` :15280, `fpDraw` :15347.
- Session state `fpS` :12265-12279; centre-origin transform `fpC2W` :17270 (`wx=(cx-w/2-pan.x*z)/z`); wheel `fpWheelEv` :18136.
- Calibration `applyCal` :23469 (`factor = realDist/pxDist`, m/px); grid snap in **metres** (gridSize 0.5).
- Import `fpLoadImg` :23483, PDF rasterize `getViewport({scale:3})` → PNG blob, multi-page modal, original PDF retained; page re-render `fpPdfPage` :23523; multi-plan `fp.plans[]` + 2-pt registration :12284-12335.
- Tools: `fpSetTool` :18157; mouse handlers :17421/:17904/:18078; hit-test finders :17321/:17343/:17349 (thresholds /zoom); tie-break cycle `_tcItems` :17431; route finalize/T-junction `fpFinalizeRoute` :19519; undo :12379.
- Registries: `FP_ELS` :11246 (~150 types), `FP_ROUTE_TYPES` :11416, `FP_DEFAULT_LAYERS` :12249.
- **DXF writer (port this)**: R12/AC1009 `_makeDxfR12` :2232-2250, primitives :2251-2254, `_hexToAci` :2224, `_canvasToDxf` (bbox-relative, **Y-flip**) :2228, `fpExportDXF`/`fpExportSiteDXF` :26415/:26468, refuses when uncalibrated :26417. Uses POLYLINE/VERTEX/SEQEND (not LWPOLYLINE), LINE, CIRCLE, TEXT; no BLOCKS.

**Retic Builder (`retic-builder-pro-v2.0.5.html`) — entities & sync algorithms:**
- `sitePlan` default state + discipline layers + styles :1993-2010; `pxToM` :13218-13223.
- `pushAllToData` :14896-15278: route lengths, endpoint-smart `effectiveType` :15066-15070, kiosk auto-number `K{chain}.{seq}` :14899-14928, SL circuit BFS with per-pole spacing :14993-15052, fedFrom auto-link :15206-15247, trench push :15249-15264, crossings→ducts :14949-14959, rename propagation `renameElement` :14674-14722.
- SL auto-path: `interpolatePolyline` :14575, `finalizeSLPath` :14602.

---

## Architecture overview

New full-screen workspace "Plan" (third tab beside SLD and Reticulation). Dual-canvas 2D engine (bg = plan image + grid + calibration; fg = entities + selection + tool ghosts) with rAF-coalesced redraw, centre-origin world transform, geometry stored in **plan-image pixels**, metres derived via calibration factor. Declarative entity registry drives palette, properties, rendering, sync, and exports — adding the building domain later means adding registry rows, not engine changes.

### New files

| File | Contents |
|---|---|
| `frontend/js/plan-defs.js` | `PLAN_DEFS` entity registry, `PLAN_DOMAINS`, `PLAN_DEFAULT_LAYERS`, `PLAN_DEFAULT_STYLES` |
| `frontend/js/plan.js` | `PlanMarkup` workspace shell: DOM build, toolbar, lifecycle, local undo, keyboard |
| `frontend/js/plan-engine.js` | `PlanEngine`: dual canvases, view transform, rAF draw, hit-testing, pointer/pinch pipeline |
| `frontend/js/plan-tools.js` | `PlanTools`: tool registry/dispatch, snapping, select/place/route/calibrate/trench/crossing/measure/text/crop/slpath |
| `frontend/js/plan-images.js` | `PlanImages`: upload/fetch/cache, pdf.js rasterization, multi-page modal, page re-render |
| `frontend/js/plan-ui.js` | Palette (click-to-arm) + properties panel (registry-`fields[]`-driven) |
| `frontend/js/plan-sync.js` | `PlanSync.pushToSchedules()` into `AppState.reticulation` + rename propagation + SL circuit builder |
| `frontend/js/plan-csv.js` | `PlanCSV` schedule exports |
| `frontend/js/plan-dxf.js` | `PlanDXF` R12 writer |
| `frontend/css/plan.css` | Workspace layout, dark-mode block |
| `frontend/js/lib/pdf.min.js` + `pdf.worker.min.js` + `PDFJS-LICENSE.txt` | Vendored pdf.js **3.11.174 legacy build** (Apache-2.0); `workerSrc='js/lib/pdf.worker.min.js'` |
| `backend/routes/plan_images.py` | Image store API |
| `backend/tests/test_plan_images.py` | API tests |

Script order in `index.html` (flat globals, matching repo convention): `pdf.min.js` next to jspdf (~:2203); `plan-defs.js` after `constants.js`; `plan-engine.js`, `plan-tools.js`, `plan-images.js`, `plan-ui.js`, `plan-sync.js`, `plan-csv.js`, `plan-dxf.js`, `plan.js` after `retic-report.js`, before `app.js`.

---

## Canonical state shape — `AppState.planMarkup`

Single source of truth (reconciles both design tracks). Add `_defaultPlanMarkup()` next to `_defaultReticulation()` in `state.js`:

```js
{
  version: 1,
  plans: [            // background plan images; bytes live on the backend
    // { id:'pmimg_1', name:'Site Layout', imageId: 42, sourcePdfId: 41,
    //   pdfPage: 3, pdfPages: [1,3,7], imgW: 7152, imgH: 5052,
    //   opacity: 1, visible: true, offX: 0, offY: 0, rotation: 0, scaleAdj: 1 }
  ],
  scale: null,        // { p1:{x,y}, p2:{x,y}, realDist, pxDist, factor }  factor = m/px
  cropBox: null,      // {x,y,w,h} | null
  elements: [],       // { id:'pmel_1', type:'kiosk', x, y, rotation:0, name:'K1', reticId:null, props:{} }
  routes: [],         // { id:'pmrt_1', type:'lv', fromId, toId, points:[{x,y,snappedTo?}],
                      //   cableType:'', curved:false, props:{} }
  trenches: [],       // { id:'pmtr_1', name:'T1', excType:'LV/SL', points:[{x,y}],
                      //   widthOverride:null, depthOverride:null }
  crossings: [],      // { id:'pmcr_1', name:'RC1', size:'110', p1:{x,y}, p2:{x,y} }
  texts: [],          // { id:'pmtx_1', x, y, text:'', fontSize:14, color:'#111827' }
  measurements: [],   // { id:'pmms_1', points:[{x,y},...] }   length derived
  layers: [...PLAN_DEFAULT_LAYERS],   // discipline layers filter by entity TYPE (source-app behavior)
  activeLayerId: null,                // null = show all
  styles: {},         // sparse overrides merged over PLAN_DEFS defaults
  settings: { domain:'retic', gridSize:0.5, snapGrid:true, snapEl:true, snapVtx:true,
              snapRoute:true, showGrid:true, greyBg:false, invertBg:false, slPoleKVA:0.15 },
  _seq: 1,            // one counter for all pm* ids
  nameCounters: {}    // per-type auto-name numbering { kiosk:4, pole:12, ... }
}
```

Rules:
- **All geometry in base-plan image pixels**; metres derived via `scale.factor`. Recalibration never moves geometry (source behavior).
- **Image bytes never in this object** — only integer backend ids. Keeps `Project.data` and every `Revision.data` snapshot small.
- **ID namespace**: every id starts with `pm` (`pmel/pmrt/pmtr/pmcr/pmtx/pmms/pmimg`) — collision-proof vs SLD ids (`<type>_<n>`) and retic ids (`kiosk_/erf_/minisub_`). Helper `AppState.planGenId(prefix)` uses `_seq`.
- `elements[].reticId` is the sync back-reference written on first push (§Sync).
- `plans[]` is an array from day 1 so Phase-later multi-plan overlays need no migration; Phase 1 UI only uses `plans[0]`.

**state.js wiring (mirror reticulation exactly, 4 spots):**
1. `reset()` (~:707): `this.planMarkup = this._defaultPlanMarkup();`
2. `toJSON()` (~:827): `planMarkup: this._planMarkupIsEmpty() ? undefined : this.planMarkup` (old projects stay byte-identical).
3. Load backfill (~:951-977 block): merge settings over defaults, default layers if missing, coerce arrays, **repair `_seq`** from max `/_(\d+)$/` suffix, drop dangling `reticId`s.
4. Post-load (~:1005): `if (typeof PlanMarkup !== 'undefined') PlanMarkup.rebaseline();` (reset undo baseline, `PlanImages.syncCache()`, redraw if active).

---

## Phase 0 — Backend image store + pdf.js vendoring

**Storage decision: BLOBs in the existing SQLite DB (`LargeBinary`)** — the only persistent volume is `db-data:/data` anyway; transactional deletes; trivial tests. API contract is storage-agnostic if a files-dir swap is ever needed.

**`backend/models/database.py`** — new model (add `LargeBinary` import; `init_db()` create_all handles the new table, no migration):

```python
class PlanImage(Base):
    __tablename__ = "plan_images"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    kind = Column(String(16), nullable=False, default="raster")   # 'raster' | 'pdf'
    name = Column(String(255), nullable=False, default="")
    mime = Column(String(64), nullable=False, default="image/png")
    width = Column(Integer, default=0); height = Column(Integer, default=0)
    size_bytes = Column(Integer, default=0)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
```

**`backend/routes/plan_images.py`** (`APIRouter(prefix="/plan-images")`, style of `routes/projects.py`):
- `POST /api/plan-images` — multipart: `file`, form `project_id?`, `kind`, `name`, `width`, `height` (client supplies raster dims — no server-side decoding/Pillow). Validate kind, mime whitelist (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`), 60 MB cap → 413. Returns meta.
- `GET /api/plan-images/{id}` — bytes with `Cache-Control: private, max-age=31536000, immutable` (rows immutable).
- `GET /api/plan-images/{id}/meta`; `PATCH /api/plan-images/{id}` (`{project_id}` — claim orphan on first project save); `DELETE` (404-tolerant).
- `POST /api/plan-images/cleanup` *(Phase 4)* — delete rows with `project_id IS NULL` older than 24 h (project-delete already covered by FK SET NULL). **Metadata queries must never select `data`** (query explicit columns).

**Also:** `schemas.py` `PlanImageMeta`; `main.py` include_router; `requirements.txt` + `python-multipart==0.0.20`; `frontend/nginx.conf:26` → `client_max_body_size 60m`; docker-compose **unchanged** (blobs ride the existing DB volume — do not add a volume).

**Deletion policy:** removing a plan from a project does NOT delete the image (revisions may reference it); rely on the conservative cleanup endpoint. Fire-and-forget DELETE only for never-claimed uploads.

**Tests** (`test_plan_images.py`, TestClient): upload → meta → byte-equal fetch → PATCH claim → delete → 404; oversize 413.

---

## Phase 1 — Engine MVP + registry

### Workspace integration
- `index.html`: third tab `#btn-workspace-plan` at :30; sibling `<div id="plan-workspace" style="display:none">` after :513; script/CSS tags.
- **Generalize the switcher** in `app.js`: `WORKSPACES = { sld:{btn,el,mod:null}, retic:{...,mod:()=>Retic}, plan:{...,mod:()=>PlanMarkup} }`; `App.switchWorkspace(id)` hides all, calls outgoing `deactivate()` / incoming `activate()`, toggles `.active`/`aria-selected`, `Canvas.render()` on return to SLD. Refactor `retic.js:23-33` button binding to route through it (keep Retic's activate/deactivate bodies intact — no behavior change).
- **Keyboard branch** in `app.js` after :194: when `PlanMarkup._active` — Ctrl+Z/Y → local undo/redo; then `PlanMarkup.onKeydown(e)` (Delete, Escape, Enter finish-route, R rotate, G grid-snap toggle, arrows nudge); swallow other SLD shortcuts except Escape/Ctrl+S.
- Dark mode: engine reads `--plan-stage-bg`/`--plan-grid` custom props via `getComputedStyle`; patch the dark-mode toggle (`app.js:136`) to also `PlanEngine.requestDraw({all:true})`.

### `PlanMarkup` shell (`plan.js`) — clone of Retic's lifecycle
- `_active`, local undo `_undoStack`/`_undoIndex` (cap 50, JSON snapshots of `AppState.planMarkup` — safe: no image bytes by construction). Snapshot **on gesture commit** only (pointerup-that-changed-state, route finalize, prop change, delete, calibrate).
- `buildDOM()`: DD-style layout — top toolbar (tools, snap pills, import, calibrate, zoom-fit, grid size, layer select, Push/Export buttons), left palette, centre `#plan-stage` with the two canvases + info overlay (scale readout, cursor coords in m, hints), right props panel. `ResizeObserver` on stage → `PlanEngine.resize()`.
- `markDirty()` → `AppState.dirty = true` (existing save pipeline picks it up).

### `PlanEngine` (`plan-engine.js`)
- Canvases: `#plan-canvas-bg` (plan images, crop mask, metric grid when calibrated — `step_px = gridSize/factor`, skip when `step_px*zoom < 6`; calibration line) with `pointer-events:none`; `#plan-canvas-fg` (entities z-order: trenches → crossings → routes → elements → texts → measures → selection → tool overlay) owns events. devicePixelRatio-aware sizing (`ctx.setTransform(dpr,...)` base).
- View: session-local `{zoom:0.5, panX, panY}` (not persisted); `screenToWorld` = DD's `fpC2W` math; `zoomAt` ported from `canvas.js:876`; wheel 0.9/1.1, clamp [0.02, 20]; `zoomFit()`.
- `requestDraw({bg,fg,all})` — dirty flags + single rAF (DD's `fpDrawSoon`). All chrome scaled 1/zoom (`lineWidth = k/z`, handles `r/z`, min screen font).
- Hit-testing: analytic finders with /zoom thresholds (element 18, route/trench seg 10, vertex 8); `hitStack(pt)` for tie-break cycling (wired Phase 2).
- **Pointer pipeline (Pointer Events only)**: `pointerdown` on fg; `move/up/cancel` on document; `touchPointers` Map; second touch → `PlanTools.cancel()` then pinch (`_pinchFrom/_pinchMove` ported from `canvas.js:852-873`); space-hold/middle-drag pan; `wheel` passive:false; `contextmenu` preventDefault (right-click = cancel gesture).
- Rendering delegates to `PLAN_DEFS` (`drawElement(ctx, el, {zoom, selected, color})`) with a built-in fallback (circle + initial + label) so the engine runs before the registry symbol set is complete.

### `PlanTools` (`plan-tools.js`) — tool framework
Registry `{id, cursor, onActivate/onDeactivate, onDown/onMove/onUp, onDblClick, onKey, drawOverlay(ctx), cancel()}`; `PlanTools.set(id, opts)`; every tool a small state machine over its own `_draft`. **Snapping** `PlanTools.snap(pt, opts)` priority vertex(8/z) → element(12/z) → route projection(10/z) → grid (metres, only when calibrated), each gated by `settings.snap*`; snap-ring indicator drawn by engine.

Phase-1 tools: **select** (click priority element>vertex>route>trench>text; drag element/vertex; Shift+click segment inserts vertex), **place** (ghost follows cursor; click commits `{id: planGenId('pmel'), type, x, y, rotation:0, name: auto from namePrefix+nameCounters, props: defaults}`; repeat placement; Esc→select), **route** (click-to-add polyline, live ghost, Enter/dblclick finalize, Esc abort; registry `requiresEndpoints` — retic mv/lv/service must start+end snapped to elements storing `fromId/toId`), **calibrate** (2 clicks → modal for metres → `scale = {p1,p2,realDist,pxDist,factor}`; info overlay shows scale; DD's `applyCal`).

### `PlanImages` (`plan-images.js`) — Phase 1: raster only
- `_cache Map(imageId → HTMLImageElement)` via object-URL fetch of `GET /api/plan-images/{id}`; async load then `requestDraw({bg})` (no await in draw path); `syncCache()` on activate/load.
- `importFile(file)`: raster → dims via `createImageBitmap`; **downscale guard** longest side ≤ 8192 px; `POST` FormData (project_id if saved, else null); push plan entry; `zoomFit()`; snapshot; markDirty. PDF path → Phase 2 toast (or single-page direct if trivial).
- Save-claim hook in `project.js` save path: after first successful save, `PlanImages.claimOrphans(projectId)` → PATCH each referenced null-project image.

### `PLAN_DEFS` registry (`plan-defs.js`)
Declarative, `COMPONENT_DEFS`-style; `fields[]` follow `properties.js renderField` conventions; one new field type **`cable_select`** — a select of `STANDARD_CABLES` **names** grouped LV(≤1 kV)/MV exactly like `Retic._cableOptions` (retic.js:412), filtered by `field.voltage`, so sync is a straight string copy.

**Retic domain — complete v1 set** (colors/scales from source styles block :2004-2008):
- Elements: `minisub` (TX, square 2.5 m, rotatable, schedule:'minisub'), `kiosk` (square 1.2 m, rotatable, schedule:'kiosk', namePrefix K), `rmu` (square 1.8 m), `pole` (circle 0.4 m, schedule:'pole', prefix P), `erf` (circle 0.8 m, schedule:'erf', field "Erf Number"), `manhole` (square 1.0 m, prefix MH). Each: `{name, domain:'retic', group, color, scale, symbol, dxf:{shape,sizeM}, rotatable, schedule, namePrefix, defaults, fields}`.
- Routes: `mv` (#ef4444, dxfLayer MV_RETICULATION), `lv` (#3b82f6, schedule:'feeder'), `service` (#22c55e, schedule:'service'), `sl` (#f59e0b, schedule:'sl'), `fibreBB` (dashed #a855f7), `fibreErf` (#c084fc). Each with `cableVoltage`, `dxfLayer`, `cable_select` field.
- Trench types (widths/depths from source :2019, band colors :13226): `MV` 0.6×1.0, `LV/SL` 0.5×0.8, `MV/LV/SL` 0.9×1.0, `FI` 0.3×0.6. Crossings: sizes 110/160.
- **Building starter set** (proves registry scales; full ~150-type port is a later phase): `bd_db`, `bd_light` (watts field), `bd_socket`, `bd_switch` under `domain:'building'`; palette domain switch in settings.
- `PLAN_DEFAULT_LAYERS` — 5 discipline layers from source :1996-2000 (MV / LV / Trenching / Fibre / SL), each `{id, name, discipline, color, visibleElementTypes, routeTypes, trenchTypes, showCrossings, drawingNo, revision}`. **Layers filter by entity type** (source behavior) — no per-entity layerId in v1; non-primary entities dim to 0.2 alpha.
- `PLAN_DEFAULT_STYLES` — verbatim from source :2004-2009 (elementColors/Scales, routeColors/LineStyles, defaultCableTypes, routeLabelPosition:'along'). Style precedence: `planMarkup.styles.X ?? PLAN_DEFS default`.

### `plan-ui.js`
- Palette: groups from registry filtered by active domain; **click-to-arm** (DD model, touch-friendly — deliberate divergence from sidebar.js drag-drop); search filter.
- Props panel: registry `fields[]` rendered with a local simplified copy of the `renderField` conventions; commit → snapshot → markDirty → redraw.

---

## Phase 2 — Full toolset + PDF pipeline

1. **PDF import** (port DD :23483-23520, API instead of IndexedDB): `pdfjsLib.getDocument({data})`; multi-page → modal with thumbnails + all/range/pick; rasterize `getViewport({scale:3})` with **adaptive cap ≤ 8192 px** long side → PNG blob → upload as raster; upload original PDF once (`kind:'pdf'`) → `sourcePdfId`; toolbar ◀/▶ page nav re-renders client-side from the fetched PDF and swaps `plan.imageId` (old raster left for cleanup).
2. Tools: **trench** (free polyline, band width `width_m/factor` px), **crossing** (2-click hatched band), **measure** (line/polyline/area), **text**, **crop** (box + handles → `cropBox`, bg mask), box/multi-select + tie-break click-cycling, rotate handle, **curved** routes (Catmull-Rom — reuse `Canvas._buildSplinePath` math), route finalize **auto-split/T-junction** (port `fpFinalizeRoute` :19519).
3. Snap-pill toolbar wiring; layer visibility panel.

---

## Phase 3 — Push-to-schedules sync + CSV + DXF (the v1 exports)

### `PlanSync.pushToSchedules()` (`plan-sync.js`)
One-way, **idempotent** push into `AppState.reticulation` (which has ONLY: `settings`, `minisubs[{id,name}]`, `kiosks[{id,name,fedFrom,loadClass,admdOverride,streetLightKVA,feederCable,feederLength,collapsed,erfs[]}]`, erfs `{id,erfNumber,length,phase,cableType,ampsOverride}` — verified; the source app's mvCable/excavation/erfRegister/fibre targets **do not exist** here and are served by CSV/DXF instead).

- Helpers: `pxToM()` (confirm-dialog if uncalibrated → push topology with length 0), `routeLen(r)`, `effectiveType(r)` (endpoint-smart: kiosk+erf→service, manhole+erf→fibreErf, pole→sl; port of :15066).
- **Matching precedence everywhere: (1) `el.reticId` if resolvable, (2) case-insensitive name, (3) append** — then write back `el.reticId`. Stronger than source name-matching; makes rename-then-repush safe.
- Steps (single `Retic._snapshot()` at end):
  1. Auto-number kiosks `K{chain}.{seq}` via BFS from minisubs/RMUs over lv+service routes (:14899); only auto-named/blank kiosks renamed.
  2. Minisubs → `reticulation.minisubs` (adopt the default `'source'` entry if it's the only untouched one).
  3. Kiosks → append via `Retic._newKiosk()` shape with `AppState.reticGenKioskId()`; update only `name` on re-push — never touch user's loadClass/admdOverride.
  4. Service routes → kiosk `erfs[]`: match by erfNumber/reticId; update `length` (if >0) + `cableType` (if set); append with round-robin phase `['Red','White','Blue']` (retic.js:105).
  5. LV graph walk (BFS from each minisub, cycle-guarded) → `kiosk.fedFrom` (minisub or upstream kiosk id — both legal per retic.js:474), `feederLength`, `feederCable`.
  6. SL circuits (BFS over sl routes, per-pole spacing = feeding route length; port :14993) → `kiosk.streetLightKVA = poleCount × settings.slPoleKVA` (assign, not +=; skip kiosks with no SL circuits so manual values survive). Expose `PlanSync.buildSLCircuits()` for the CSV.
  7. MV routes / trenches / crossings / fibre / manholes / RMUs: no reticulation home — summary dialog states "included in CSV/DXF exports only".
  8. `AppState.dirty = true; Retic._snapshot();` re-render/recompute if Retic active; summary alert with counts.
- `PlanSync.onElementRenamed(el, old, new)` — immediate rename of the back-referenced kiosk/minisub/erf row (port :14674). Deleting a plan element never deletes schedule rows (source behavior).

### `PlanCSV` (`plan-csv.js`)
Reuse `csvCell()` (project.js:13); `'﻿'` BOM + `text/csv;charset=utf-8`; filenames `` `${proj}_plan_<what>.csv` ``; `=== SECTION ===` banner style from `exportResultsCSV`.
1. **elements.csv** — `Type, Name, Domain, Layer(s), X (m), Y (m)` + per-type count summary.
2. **routes.csv** — `Route Type (effective), From, To, Cable Type, Measured Length (m), Layer(s)` + per-type length totals.
3. **trenches.csv** — `Name, Excavation Type, Width, Depth, Length, Volume (m³)` (override ?? registry defaults) + totals per excType.
4. **crossings.csv** — `Name, Duct Size (mm), Length (m)` + totals per size.
5. **streetlights.csv** — from `buildSLCircuits()`: `Circuit, Source, Pole #, Pole Name, Phase, Spacing (m), Cumulative (m), Cable`.
6. `exportAll()` fires 1-5, skipping empties.

### `PlanDXF` (`plan-dxf.js`)
Faithful port of DD's R12 writer (:2232-2269) upgraded to metres:
- HEADER: `$ACADVER=AC1009`, `$INSUNITS 70=6` (metres), real `$EXTMIN/$EXTMAX`. TABLES: LAYER per entry (`_hexToAci` extended to nearest-ACI by RGB distance). ENTITIES only — **POLYLINE/VERTEX/SEQEND** (R12-safe, not LWPOLYLINE), LINE, CIRCLE, TEXT. No BLOCKS in v1.
- Transform: `t(x,y) = { x:(x-bbox.minX)*factor, y:(bbox.maxY-y)*factor }` — **Y-flip** mandatory. **Refuse export when uncalibrated** (alert, mirrors :26417).
- Mapping: routes → open POLYLINE on `dxfLayer` (MV_RETICULATION/LV_RETICULATION/SERVICE_CABLES/STREET_LIGHTING/FIBRE) + mid-vertex TEXT `"{cableType} {len} m"` on CABLE_LABELS; elements → CIRCLE or rotated closed POLYLINE square per registry `dxf.{shape,sizeM}` on ELEMENTS + name TEXT on ELEMENT_LABELS; trenches → centerline POLYLINE + `"{name} {excType} {w}×{d}"` TEXT on TRENCHING; crossings → LINE + `"{name} {size}mm duct"` on CROSSINGS; texts → TEXT (h = px×factor, min 0.3 m); measurements → POLYLINE + length TEXT on DIMENSIONS; background raster **not embedded** — NOTES-layer TEXT explains overlay + "1 unit = 1 m".
- Export everything regardless of layer visibility (CAD users toggle layers). File `${proj}_plan_markup.dxf`, MIME `application/dxf`.

---

## Phase 4 — Retic extras + hygiene
- **slpath** tool: polyline → dialog (pole spacing m; requires calibration) → `interpolatePolyline` (port :14575) generates evenly-spaced `pole` elements + connecting `sl` routes as ONE undo step.
- Plan list UI (opacity/visibility/nudge offX-offY), discipline-layer management (add/rename/color/drawingNo/revision).
- `POST /api/plan-images/cleanup` + settings button.

## Later phases (explicitly out of scope now)
- Full building domain (~150 `FP_ELS` types, conduit/tray route types with sizes, `FP_DEFAULT_LAYERS`, rooms, circuit tagging + circuit-schedule/BOQ/wiring CSVs, lux).
- MV-cable / excavation / SL-circuit / erf-register schedule modules in the Retic workspace (natural homes for the sync targets that don't exist yet; algorithms already written in the source app).
- Annotated PNG/PDF drawing sheets with title block/legend/revision table (reuse `project.js:_rasterizeSVG` pattern or canvas snapshot + jsPDF; `pdf_reports.py:_render_diagram` accepts a PNG for backend reports).
- Multi-plan overlays + 2-point registration (state supports it — solve similarity transform into offX/offY/rotation/scaleAdj); DXF BLOCK symbols; DXF import.

---

## Risks
| Risk | Mitigation |
|---|---|
| Huge rasters (A0/A1 @ scale 3 → 50-100 MP) | Adaptive raster cap ≤ 8192 px; nginx 60m; server 60 MB cap → clear 413 toast |
| SQLite growth from blobs | ids-only in project JSON (revisions stay tiny); cleanup endpoint; VACUUM note in docs |
| Deleting images referenced by old revisions | Never delete on plan removal; conservative cleanup only (orphans > 24 h) |
| `python-multipart` missing → UploadFile 500s | Added to requirements; pytest catches |
| Pinch vs in-progress gesture | Second touch always `PlanTools.cancel()` first (engine rule) |
| Retic/SLD regressions from switcher refactor | Keep Retic activate/deactivate bodies intact; verify all three tabs |
| Sync clobbering user data | reticId-first matching; only geometry-derived fields written; assign-not-add for SL kVA |

## Verification
1. `node --check frontend/js/plan*.js frontend/js/state.js frontend/js/app.js`.
2. Backend: `docker run --rm -v "$PWD":/work -w /work protectionpro-backend sh -c "pip install pytest httpx -q && python -m pytest backend/tests/ -q"` (existing regression suite must stay green; new plan-image tests pass).
3. **`verify` skill (headless)**: switch to Plan tab; upload fixture image via page-context fetch; simulate PointerEvents for calibration (2 clicks + modal) → assert `scale.factor`; place element → assert `elements.length`; Ctrl+Z undo; save/reload → `planMarkup` round-trips; all three workspace tabs still switch cleanly.
4. **Hand-checkable numerics**: calibrate 100 m between two points, draw an LV route exactly between them → routes CSV `100.00`, push → kiosk `feederLength` 100 in the Retic workspace. TX—K1—K2 chain → fedFrom ids correct. Push twice → no duplicates; loadClass edits survive. 3-pole SL chain @ 40 m → CSV spacings 40.00 / phases R,W,B / kiosk SL kVA 0.45. 50 m LV/SL trench → volume 20.00 m³.
5. **DXF**: open export in a viewer (sharecad.org / ODA converter) → layers per mapping, north-up orientation, 100 m line measures 100 units, file starts `0\nSECTION\n2\nHEADER`, ends `0\nEOF`.
6. Update `BACKLOG.md` after each phase (CLAUDE.md workflow).

## Git
`git checkout main && git checkout -b feature/plan-markup`. (Current branch `feature/dc-loadflow-shortcircuit` and its untracked `distribution-designer-pro_v9.37.html` are left untouched; the two reference HTML apps stay in the repo root as porting references.)

## Suggested commit-sized order
1. Phase 0 backend (model/routes/schemas/main/requirements/nginx) + tests.
2. Vendor pdf.js + license + index.html tag.
3. state.js hooks + plan.css + tab/div/script tags + `App.switchWorkspace` refactor (Retic still green).
4. `plan-defs.js` registry + `plan.js` shell + `plan-engine.js` (empty scene pan/zoom/pinch).
5. `plan-images.js` raster import + bg draw + zoomFit.
6. `plan-tools.js` (select/place/route/calibrate) + `plan-ui.js` + keyboard branch + undo.
7. Phase 2 tools + PDF pipeline. 8. Phase 3 sync + CSV + DXF. 9. Phase 4 extras. Each phase ends with the verification pass + BACKLOG.md update.
