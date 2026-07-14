/* ProtectionPro — Application State */

// Study-result slots that carry a stability/analysis verdict. Every one is
// stamped with provenance (app version + time) when computed so a result left
// over from an OLDER engine version — which a network/topology hash can't
// detect, because the network is unchanged — is flagged stale on load.
const RESULT_SLOTS = [
  'faultResults', 'loadFlowResults', 'unbalancedLoadFlowResults', 'arcFlashResults',
  'dcArcFlashResults', 'dcLoadFlowResults', 'dcShortCircuitResults', 'cableSizingResults',
  'motorStartingResults', 'dynamicMotorResults', 'stabilityResults', 'dutyCheckResults',
  'loadDiversityResults', 'groundingResults', 'studyManagerResults',
];

// Human labels for the stale-results notice.
const RESULT_SLOT_LABELS = {
  faultResults: 'Short Circuit', loadFlowResults: 'Load Flow',
  unbalancedLoadFlowResults: 'Unbalanced Load Flow', arcFlashResults: 'Arc Flash',
  dcArcFlashResults: 'DC Arc Flash', dcLoadFlowResults: 'DC Load Flow',
  dcShortCircuitResults: 'DC Short Circuit', cableSizingResults: 'Cable Sizing',
  motorStartingResults: 'Motor Starting', dynamicMotorResults: 'Dynamic Motor Starting',
  stabilityResults: 'Transient Stability', dutyCheckResults: 'Duty Check',
  loadDiversityResults: 'Load Diversity', groundingResults: 'Grounding',
  studyManagerResults: 'Study Manager',
};

const AppState = {
  // Project
  projectId: null,
  projectName: 'Untitled Project',
  dirty: false,

  // Project details for report covers
  projectDetails: {
    projectNumber: '',
    client: '',
    company: '',
    engineerName: '',
    checkedBy: '',
    approvedBy: '',
    revisionNumber: '',
    date: '',
    description: '',
    companyLogo: null,  // base64 data URL
  },

  // System base settings
  baseMVA: DEFAULT_BASE_MVA,
  frequency: DEFAULT_FREQUENCY,
  voltageFactor: DEFAULT_VOLTAGE_FACTOR,  // IEC 60909 voltage factor c for fault analysis
  defaultLengthUnit: 'm',  // Default display unit for cable length ('m' or 'km')

  // Canvas transform
  zoom: 1,
  panX: 0,
  panY: 0,

  // Interaction mode
  mode: MODE.SELECT,
  placingType: null, // component type being placed

  // Component data: Map<id, componentData>
  components: new Map(),
  wires: new Map(),
  nextId: 1,

  // Selection
  selectedIds: new Set(),
  hoveredId: null,

  // Wire drawing state
  wireStart: null, // {componentId, portId, x, y}

  // Drag state
  dragState: null, // {startX, startY, offsetX, offsetY, ids}

  // Display toggles
  showCableLabels: true,
  showDeviceLabels: true,
  showWarnings: true,
  showFaultAngles: false,
  showRatingFlags: true,  // on-diagram warning markers for under-rated devices

  // Flow arrow visibility — per analysis type
  showFlowArrows: {
    loadflow: false,
    fault: false,
  },

  // Result box visibility — per analysis type
  showResultBoxes: {
    fault: true,
    loadflow: true,
    unbalancedLF: true,
    arcflash: true,
    cable: true,
    motor: true,
    dynMotor: true,
    duty: true,
    loadDiversity: true,
    grounding: true,
    dcLoadflow: true,
    dcShortCircuit: true,
  },

  // Clipboard for copy/paste
  clipboard: null, // { components: [], wires: [] }

  // Analysis results — the RESULT_SLOTS listed above are exposed as accessors
  // (defined after this literal) that stamp provenance on assignment; the
  // backing store is AppState._results and provenance is AppState.resultsMeta.
  faultedBusId: null,  // ID of the specific bus that was faulted (null = all buses)

  // Scenarios — saved snapshots of network configuration
  scenarios: [],  // [{id, name, description, timestamp, components, wires, nextId}]
  _scenarioNextId: 1,

  // Study config persisted with the project (NOT results, so it survives
  // topology edits — see clearResults). Transient-stability disturbance cases;
  // dynamic-motor start schedule + named saved schedules. See transient.js /
  // dynmotor.js.
  stabilityCases: [],          // [{id, name, disturbance}]
  dynamicMotorSchedule: null,  // {motors: [{id, role, start_time_s}]}
  dynamicMotorCases: [],       // [{id, name, schedule}]
  loadFlowCases: [],           // [{id, name, baseMVA, loadFlowMethod, components, wires}] — Load Flow Study Manager

  // Component groups — reusable blocks
  groups: new Map(), // Map<groupId, {id, name, memberIds: Set<string>, collapsed: boolean}>
  _groupNextId: 1,

  // Multi-page diagram sheets
  pages: [{ id: 'page_1', name: 'Sheet 1' }],
  activePageId: 'page_1',
  _pageNextId: 2,

  // Wire routing mode: 'orthogonal' | 'diagonal' | 'spline'
  wireRouteMode: 'orthogonal',

  // ─── Reticulation module (LV distribution / NRS 034-1 ADMD design) ───
  // Raceway/conduit-fill study definitions: {id, name, nominal_mm,
  // custom_id_mm, cableIds: []} — persisted with the project.
  raceways: [],

  // Independent workspace from the SLD canvas. Kiosks feed groups of erven
  // (stands); demand is estimated via the backend /api/analysis/admd engine.
  reticulation: {
    settings: {
      estimationMethod: 'Empirical',   // 'Empirical' | 'Herman Beta'
      correctionMethod: 'AMEU',        // 'AMEU' | 'British' | 'None'
      loadClass: 'urban1',             // default load-class id
      admd: 4.04,                      // default ADMD (kVA) for Empirical
      riskZ: 1.28,                     // Herman-Beta risk factor
      maxRunVD: 5,                     // service/erf volt-drop limit (%)
      maxFeederVD: 7,                  // feeder volt-drop limit (%)
      // Quick Build defaults (also used by the per-kiosk quick-add buttons)
      quickKiosks: 4,                  // kiosks to add per build
      quickErven: 6,                   // erven per kiosk
      quickServiceCable: '',           // service cable applied to each erf
      quickServiceLen: 60,             // worst-case service run length (m)
      quickFeederCable: '',            // feeder cable applied to each kiosk
      quickFeederLen: 100,             // feeder segment length (m)
      quickChain: true,                // daisy-chain kiosks (else star from minisub)
      quickFeedFrom: 'source',         // minisub the quick build feeds from
      networkDiversity: 1.0,           // × on Σ minisub demands (NMD estimate)
    },
    // Minisubs/transformer sources: ADMD diversity is applied per minisub
    // across its downstream kiosks. The first id is 'source' so legacy
    // kiosk.fedFrom values resolve unchanged.
    minisubs: [{ id: 'source', name: 'Minisub 1' }],
    kiosks: [],   // [{id,name,fedFrom,loadClass,admdOverride,feederCable,feederLength,erfs:[]}]
    _kioskSeq: 1,
    _erfSeq: 1,
    _msSeq: 2,
  },
  reticResults: null,   // latest /api/analysis/admd response

  // Plan Markup workspace: geographic markup over an imported site/floor plan.
  // Geometry is stored in plan-image pixels; metres derived via scale.factor.
  // Background images live on the backend (referenced by integer id here), so
  // this object stays small enough to ride in the project JSON + revisions.
  // Initialized just after the AppState literal (needs PLAN_DEFAULT_LAYERS).
  planMarkup: null,

  // Generate unique ID
  genId(prefix) {
    return `${prefix}_${this.nextId++}`;
  },

  // Synthetic load-terminal buses the backend inserts for a load wired behind
  // a cable/transformer with no busbar of its own (see loadflow.py
  // SYNTHETIC_BUS_PREFIX). They exist only in analysis results, not on the
  // diagram; the id encodes the load: `__term__<loadId>`.
  SYNTHETIC_BUS_PREFIX: '__term__',
  isSyntheticBus(id) {
    return typeof id === 'string' && id.startsWith(this.SYNTHETIC_BUS_PREFIX);
  },
  syntheticBusLoadId(id) {
    return this.isSyntheticBus(id) ? id.slice(this.SYNTHETIC_BUS_PREFIX.length) : null;
  },
  // Resolve the on-diagram component that a result bus id belongs to — the bus
  // itself, or (for a synthetic terminal) the load it hangs off — so a badge
  // has somewhere to anchor. Returns null if nothing on the active page matches.
  resultBusComponent(busId, pageComps = null) {
    const get = pageComps ? (id) => pageComps.get(id) : (id) => this.components.get(id);
    return get(busId) || (this.isSyntheticBus(busId) ? get(this.syntheticBusLoadId(busId)) : null) || null;
  },

  // ─── Reticulation helpers ───
  _defaultReticulation() {
    return {
      settings: {
        estimationMethod: 'Empirical', correctionMethod: 'AMEU',
        loadClass: 'urban1', admd: 4.04, riskZ: 1.28,
        maxRunVD: 5, maxFeederVD: 7,
        quickKiosks: 4, quickErven: 6,
        quickServiceCable: '', quickServiceLen: 60,
        quickFeederCable: '', quickFeederLen: 100, quickChain: true,
        quickFeedFrom: 'source', networkDiversity: 1.0,
      },
      minisubs: [{ id: 'source', name: 'Minisub 1' }],
      kiosks: [], _kioskSeq: 1, _erfSeq: 1, _msSeq: 2,
    };
  },

  reticGenKioskId() {
    return `kiosk_${this.reticulation._kioskSeq++}`;
  },

  reticGenErfId() {
    return `erf_${this.reticulation._erfSeq++}`;
  },

  reticGenMinisubId() {
    return `minisub_${this.reticulation._msSeq++}`;
  },

  // ─── Plan Markup helpers ───

  // The per-floor drawing collections. Each floor owns its own copy of these;
  // the active floor's copies are mirrored onto planMarkup.<key> as the live
  // working set the engine + tools read/write directly (see switchFloor).
  _PLAN_FLOOR_KEYS: ['plans', 'scale', 'cropBox', 'elements', 'routes',
    'trenches', 'crossings', 'rooms', 'texts', 'measurements'],

  // A fresh, empty per-floor data bundle.
  _newPlanFloorData() {
    return {
      plans: [],          // background images: {id,name,imageId,sourcePdfId,pdfPage,
                          //   pdfPages,imgW,imgH,opacity,visible,offX,offY,rotation,scaleAdj}
      scale: null,        // {p1,p2,realDist,pxDist,factor}  factor = metres per pixel
      cropBox: null,      // {x,y,w,h}
      elements: [],       // {id,type,x,y,rotation,name,reticId,props}
      routes: [],         // {id,type,fromId,toId,points:[{x,y,snappedTo}],cableType,curved,props}
      trenches: [],       // {id,name,excType,points:[{x,y}],widthOverride,depthOverride}
      crossings: [],      // {id,name,size,p1,p2}
      rooms: [],          // {id,name,points:[{x,y}],color}  (closed polygon zones)
      texts: [],          // {id,x,y,text,fontSize,color}
      measurements: [],   // {id,points:[{x,y}]}
    };
  },

  // A named floor sheet. `level` is the storey index (Ground = 0, up positive,
  // basements negative); `height` is its floor-to-floor height in metres, used
  // for vertical riser cable runs. `data` holds this floor's drawing.
  _newPlanFloor(name, level, height) {
    return {
      id: this.planGenId('pmfloor'),
      name: name || 'Ground',
      level: level == null ? 0 : level,
      height: height == null ? 3.5 : height,
      data: this._newPlanFloorData(),
    };
  },

  _defaultPlanMarkup() {
    const layers = (typeof PLAN_DEFAULT_LAYERS !== 'undefined')
      ? PLAN_DEFAULT_LAYERS.map(l => ({ ...l }))
      : [];
    const pm = {
      version: 2,
      floors: [],         // [{id,name,level,height,data:{…per-floor collections}}]
      activeFloorId: null,
      layers,             // discipline layers (filter by entity type) — shared
      activeLayerId: null,
      styles: {},         // sparse overrides merged over PLAN_DEFS defaults — shared
      settings: {
        domain: 'retic', gridSize: 0.5,
        snapGrid: true, snapEl: true, snapVtx: true, snapRoute: true,
        showGrid: true, greyBg: false, invertBg: false, slPoleKVA: 0.15,
        floorHeight: 3.5,   // default storey height (m) for new floors
        riserFactor: 1.1,   // vertical-run slack multiplier (bends/terminations)
        // Bill-of-quantities rates (currency-neutral; 0 until the user sets them)
        rates: { cablePerM: 0, equipUnit: 0, trenchPerM: 0, wasteFactorPct: 5 },
      },
      _seq: 1,            // single counter for all pm* ids
      nameCounters: {},   // per-type auto-name numbering {kiosk:4, pole:12, ...}
    };
    // Seed the Ground floor (mint its id from pm._seq directly — planGenId reads
    // this.planMarkup, which isn't this object yet).
    const gf = { id: `pmfloor_${pm._seq++}`, name: 'Ground', level: 0, height: 3.5, data: this._newPlanFloorData() };
    pm.floors = [gf];
    pm.activeFloorId = gf.id;
    // Mirror the active floor's (empty) collections onto the live working set.
    for (const k of this._PLAN_FLOOR_KEYS) pm[k] = gf.data[k];
    return pm;
  },

  // Mint a plan-markup id. All prefixes start with "pm" so they can never
  // collide with SLD ids (<type>_<n>) or reticulation ids (kiosk_/erf_/minisub_).
  planGenId(prefix) {
    return `${prefix}_${this.planMarkup._seq++}`;
  },

  // ─── Floor sheets ───
  // The active floor's collections live on planMarkup.<key> directly (the live
  // working set). switchFloor() stashes those back into the outgoing floor's
  // `data` and hydrates the incoming floor's — so the engine/tools keep reading
  // planMarkup.elements etc. unaware of which floor is showing.

  planActiveFloor() {
    const p = this.planMarkup;
    if (!p || !Array.isArray(p.floors)) return null;
    return p.floors.find(f => f.id === p.activeFloorId) || p.floors[0] || null;
  },

  // Copy the live working collections back into the active floor's `data`, so
  // `data` is authoritative before serialising or reading across all floors.
  _stashActiveFloor() {
    const p = this.planMarkup;
    const fl = this.planActiveFloor();
    if (!fl) return;
    fl.data = fl.data || {};
    for (const k of this._PLAN_FLOOR_KEYS) fl.data[k] = p[k];
  },

  // Make `id` the active floor, mirroring its data onto the live working set.
  switchFloor(id) {
    const p = this.planMarkup;
    if (!p) return false;
    const target = p.floors.find(f => f.id === id);
    if (!target || target.id === p.activeFloorId) return false;
    this._stashActiveFloor();
    p.activeFloorId = target.id;
    target.data = target.data || this._newPlanFloorData();
    for (const k of this._PLAN_FLOOR_KEYS) {
      if (target.data[k] === undefined) target.data[k] = this._newPlanFloorData()[k];
      p[k] = target.data[k];
    }
    return true;
  },

  // Add a new floor above the highest existing level; returns it (not switched).
  addPlanFloor(name) {
    const p = this.planMarkup;
    const maxLevel = p.floors.reduce((m, f) => Math.max(m, f.level || 0), -Infinity);
    const level = isFinite(maxLevel) ? maxLevel + 1 : 0;
    const h = (p.settings && p.settings.floorHeight) || 3.5;
    const fl = this._newPlanFloor(name || `Floor ${level}`, level, h);
    p.floors.push(fl);
    return fl;
  },

  // Remove a floor (never the last one). If it was active, switches to a
  // neighbour first. Its background images are dropped from the project.
  removePlanFloor(id) {
    const p = this.planMarkup;
    if (!p || p.floors.length <= 1) return false;
    const idx = p.floors.findIndex(f => f.id === id);
    if (idx < 0) return false;
    if (p.activeFloorId === id) {
      const neighbour = p.floors[idx + 1] || p.floors[idx - 1];
      this.switchFloor(neighbour.id);
    } else {
      this._stashActiveFloor();
    }
    p.floors.splice(idx, 1);
    return true;
  },

  // Re-point the live working keys at the active floor's data refs. Call after
  // wholesale replacing planMarkup (e.g. undo restore via JSON.parse) so the
  // mirror + floor.data share array refs again and scalars are consistent.
  _hydrateActiveFloor() {
    const p = this.planMarkup;
    const fl = this.planActiveFloor();
    if (!fl) return;
    fl.data = fl.data || this._newPlanFloorData();
    for (const k of this._PLAN_FLOOR_KEYS) {
      if (fl.data[k] === undefined) fl.data[k] = this._newPlanFloorData()[k];
      p[k] = fl.data[k];
    }
  },

  // All floors with their `data` current (active floor stashed first). Use for
  // whole-building reads (SLD sync, schedules, BOQ, DXF, drawing register).
  planFloors() {
    this._stashActiveFloor();
    return (this.planMarkup && this.planMarkup.floors) || [];
  },

  // Flatten one per-floor collection across every floor. Returns the real
  // object refs (active-floor items alias planMarkup.<key>), so callers may
  // mutate in place; no transient keys are added.
  _planAllOf(key) {
    const out = [];
    for (const fl of this.planFloors()) {
      const arr = (fl.data && fl.data[key]) || [];
      for (const it of arr) out.push(it);
    }
    return out;
  },
  planAllElements() { return this._planAllOf('elements'); },
  planAllRoutes() { return this._planAllOf('routes'); },
  planAllPlans() { return this._planAllOf('plans'); },

  // Vertical cable run (metres) between two storey levels, through the riser
  // shaft: the floor-to-floor heights spanned, inflated by the riser factor for
  // bends/terminations. Mirrors Distribution Designer's riser breakdown.
  planVerticalRunM(levelA, levelB) {
    const p = this.planMarkup;
    const lo = Math.min(levelA, levelB), hi = Math.max(levelA, levelB);
    if (lo === hi) return 0;
    let sum = 0;
    for (const f of (p.floors || [])) {
      // A floor's `height` is its floor-to-next height, so count [lo, hi).
      if ((f.level || 0) >= lo && (f.level || 0) < hi) sum += (f.height || 0);
    }
    const rf = (p.settings && p.settings.riserFactor) || 1;
    return +(sum * rf).toFixed(3);
  },

  // Risers on other floors sharing this riser's (case-insensitive) name form one
  // vertical shaft — DD's convention. Returns the shaft's floors sorted by level
  // as [{floor, riser}] (excluding none; includes the given riser's floor).
  planRiserShaft(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return [];
    const out = [];
    for (const fl of this.planFloors()) {
      for (const e of (fl.data.elements || [])) {
        if (e.type === 'bd_riser' && String(e.name || '').trim().toLowerCase() === key) {
          out.push({ floor: fl, riser: e });
          break;
        }
      }
    }
    return out.sort((a, b) => (a.floor.level || 0) - (b.floor.level || 0));
  },

  // Map every element/route id → the floor object it lives on (across floors).
  planEntityFloorMap() {
    const m = new Map();
    for (const fl of this.planFloors()) {
      for (const e of (fl.data.elements || [])) m.set(e.id, fl);
      for (const r of (fl.data.routes || [])) m.set(r.id, fl);
    }
    return m;
  },

  // Persistable form of planMarkup: floors[] are the single source of truth for
  // the per-floor collections, so stash the active floor and drop the live
  // top-level mirror keys (they'd otherwise duplicate floors[active].data).
  _planMarkupToJSON() {
    this._stashActiveFloor();
    const p = this.planMarkup;
    const out = {};
    for (const k of Object.keys(p)) {
      if (this._PLAN_FLOOR_KEYS.includes(k)) continue;   // mirror of active floor
      out[k] = p[k];
    }
    return out;
  },

  // True when the module holds nothing worth persisting — keeps toJSON() from
  // adding a planMarkup key to projects that never used the workspace.
  _planMarkupIsEmpty() {
    const p = this.planMarkup;
    if (!p) return true;
    this._stashActiveFloor();
    const floors = p.floors || [];
    // A lone empty floor with no scale is "unused".
    if (floors.length > 1) return false;
    const d = (floors[0] && floors[0].data) || {};
    return !((d.plans || []).length) && !((d.elements || []).length) && !((d.routes || []).length) &&
      !((d.trenches || []).length) && !((d.crossings || []).length) && !((d.texts || []).length) &&
      !((d.measurements || []).length) && !((d.rooms || []).length) && !d.scale;
  },

  // Add component
  addComponent(type, x, y) {
    const def = COMPONENT_DEFS[type];
    if (!def) return null;
    const id = this.genId(type);
    const comp = {
      id,
      type,
      x: snapToGrid(x),
      y: snapToGrid(y),
      rotation: 0,
      pageId: this.activePageId,
      // Deep-clone so nested props (e.g. distribution_board `circuits`, `el_ratings`)
      // are not shared by reference across components or with the global default.
      props: structuredClone(def.defaults),
    };
    // Auto-increment names
    const count = [...this.components.values()].filter(c => c.type === type).length;
    comp.props.name = `${def.defaults.name}${count > 0 ? count + 1 : ''}`;
    this.components.set(id, comp);
    this.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    return comp;
  },

  // Remove component
  removeComponent(id) {
    // Remove connected wires
    for (const [wid, w] of this.wires) {
      if (w.fromComponent === id || w.toComponent === id) {
        this.wires.delete(wid);
      }
    }
    this.components.delete(id);
    this.selectedIds.delete(id);
    this.dirty = true;
  },

  // Add wire
  addWire(fromComp, fromPort, toComp, toPort, skipSnapshot = false) {
    const id = this.genId('wire');
    const wire = {
      id,
      fromComponent: fromComp,
      fromPort: fromPort,
      toComponent: toComp,
      toPort: toPort,
    };
    this.wires.set(id, wire);
    this.dirty = true;
    if (!skipSnapshot && typeof UndoManager !== 'undefined') UndoManager.snapshot();
    return wire;
  },

  // Remove wire
  removeWire(id) {
    this.wires.delete(id);
    this.selectedIds.delete(id);
    this.dirty = true;
  },

  // Clear selection
  clearSelection() {
    this.selectedIds.clear();
  },

  // Select single
  select(id) {
    this.selectedIds.clear();
    this.selectedIds.add(id);
  },

  // Toggle selection
  toggleSelect(id) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
  },

  // Delete selected
  deleteSelected() {
    let removed = 0;
    for (const id of this.selectedIds) {
      if (this.components.has(id)) {
        this.removeComponent(id);
        removed++;
      } else if (this.wires.has(id)) {
        this.removeWire(id);
        removed++;
      }
    }
    this.selectedIds.clear();
    if (removed === 0) return; // nothing mutated — keep results and history
    this.invalidateResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  // Copy selected components and their connecting wires to clipboard
  copySelected() {
    if (this.selectedIds.size === 0) return;
    const comps = [];
    const compIds = new Set();
    for (const id of this.selectedIds) {
      const comp = this.components.get(id);
      if (comp) {
        comps.push(JSON.parse(JSON.stringify(comp)));
        compIds.add(id);
      }
    }
    // Copy wires that connect two selected components
    const wires = [];
    for (const [wid, wire] of this.wires) {
      if (compIds.has(wire.fromComponent) && compIds.has(wire.toComponent)) {
        wires.push(JSON.parse(JSON.stringify(wire)));
      }
    }
    this.clipboard = { components: comps, wires };
  },

  // Generate a unique "Name copy" / "Name copy 2" / ... name for pasted components
  _uniqueCopyName(name, taken) {
    const base = String(name || 'Component').replace(/ copy( \d+)?$/, '');
    let candidate = `${base} copy`;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base} copy ${n++}`;
    }
    taken.add(candidate);
    return candidate;
  },

  // Paste clipboard contents with an offset.
  // Optional `target` ({x, y} world point, e.g. the context-menu cursor):
  // the pasted selection's centroid is shifted onto it BEFORE the undo
  // snapshot below, so undo/redo restore the final positions. Without a
  // target (Ctrl+V / Ctrl+D) behaviour is unchanged: a fixed +40px offset.
  pasteClipboard(target = null) {
    if (!this.clipboard || this.clipboard.components.length === 0) return;
    const offset = 40; // paste offset in world coords
    const idMap = new Map(); // old id -> new id
    this.clearSelection();
    // Existing names, for unique copy-name generation
    const takenNames = new Set([...this.components.values()].map(c => c.props?.name));
    // Paste components
    for (const comp of this.clipboard.components) {
      const newId = this.genId(comp.type);
      idMap.set(comp.id, newId);
      const newComp = {
        ...comp,
        id: newId,
        x: comp.x + offset,
        y: comp.y + offset,
        pageId: this.activePageId,
        // Deep-clone so a pasted component's nested props (e.g. distribution_board
        // `circuits`) are independent of the clipboard and of sibling pastes.
        props: { ...structuredClone(comp.props), name: this._uniqueCopyName(comp.props.name, takenNames) },
      };
      this.components.set(newId, newComp);
      this.selectedIds.add(newId);
    }
    // Paste wires with remapped IDs (skip per-wire snapshots; one is taken below)
    for (const wire of this.clipboard.wires) {
      const newFrom = idMap.get(wire.fromComponent);
      const newTo = idMap.get(wire.toComponent);
      if (newFrom && newTo) {
        this.addWire(newFrom, wire.fromPort, newTo, wire.toPort, true);
      }
    }
    // Shift the pasted selection so its centroid lands at the target point
    // (grid-snapped delta). Must happen before the snapshot below.
    if (target) {
      const pasted = [...this.selectedIds]
        .map(id => this.components.get(id)).filter(Boolean);
      if (pasted.length > 0) {
        const cx = pasted.reduce((s, c) => s + c.x, 0) / pasted.length;
        const cy = pasted.reduce((s, c) => s + c.y, 0) / pasted.length;
        const dx = snapToGrid(target.x - cx);
        const dy = snapToGrid(target.y - cy);
        for (const c of pasted) { c.x += dx; c.y += dy; }
      }
    }
    this.dirty = true;
    this.invalidateResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  // Save current network configuration as a scenario
  saveScenario(name, description = '', applies = null) {
    const id = `scenario_${this._scenarioNextId++}`;
    const scenario = {
      id,
      name,
      description,
      timestamp: new Date().toISOString(),
      components: JSON.parse(JSON.stringify([...this.components.values()])),
      wires: JSON.parse(JSON.stringify([...this.wires.values()])),
      nextId: this.nextId,
      // Groups and pages belong to the snapshot too — restoring components
      // without them desyncs comp.groupId / comp.pageId references. Legacy
      // scenarios without these fields get reconciled on load instead.
      groups: [...this.groups.values()].map(g => ({ ...g, memberIds: [...g.memberIds] })),
      pages: JSON.parse(JSON.stringify(this.pages)),
      activePageId: this.activePageId,
      // What loading this scenario applies (snapshot always stores everything;
      // names are never applied). Missing/legacy → all true.
      applies: applies || { switching: true, settings: true, layout: true },
    };
    this.scenarios.push(scenario);
    this.dirty = true;
    return scenario;
  },

  // Load a scenario. What it applies is controlled by the scenario's saved
  // `applies` flags (switching / settings / layout — legacy scenarios apply
  // all). Device NAMES are never applied: renames made after a scenario was
  // saved always survive loading it.
  //
  // All flags ticked → full snapshot restore (components/wires added or
  // removed since the save are restored/removed too). Any flag unticked →
  // overlay mode: the selected categories are applied onto the CURRENT
  // network, matched by component id; topology is left untouched.
  loadScenario(scenarioId) {
    const scenario = this.scenarios.find(s => s.id === scenarioId);
    if (!scenario) return false;
    const applies = scenario.applies || { switching: true, settings: true, layout: true };
    const full = applies.switching && applies.settings && applies.layout;
    const SWITCHING_TYPES = new Set(['cb', 'switch']);

    this.selectedIds.clear();
    this.faultResults = null;
    this.faultedBusId = null;
    this.loadFlowResults = null;
    this.unbalancedLoadFlowResults = null;
    this.arcFlashResults = null;
    this.dcLoadFlowResults = null;
    this.dcShortCircuitResults = null;

    if (full) {
      // Full restore, preserving current device names by id
      const currentNames = new Map();
      for (const [id, c] of this.components) {
        if (c.props && c.props.name != null) currentNames.set(id, c.props.name);
      }
      this.components.clear();
      this.wires.clear();
      for (const c of scenario.components) {
        const copy = JSON.parse(JSON.stringify(c));
        if (currentNames.has(c.id)) copy.props.name = currentNames.get(c.id);
        this.components.set(c.id, copy);
      }
      for (const w of scenario.wires) {
        this.wires.set(w.id, JSON.parse(JSON.stringify(w)));
      }
      this.nextId = scenario.nextId;
      // Restore groups/pages when the snapshot carries them (newer scenarios);
      // legacy snapshots keep the current groups/pages and rely on the
      // reconciliation below to drop anything that no longer lines up.
      if (Array.isArray(scenario.groups)) {
        this.groups.clear();
        for (const g of scenario.groups) {
          const copy = JSON.parse(JSON.stringify(g));
          this.groups.set(g.id, { ...copy, memberIds: new Set(copy.memberIds) });
        }
        this._groupNextId = Math.max(this._groupNextId,
          ...scenario.groups.map(g => (parseInt(String(g.id).replace('group_', '')) || 0) + 1));
      }
      if (Array.isArray(scenario.pages) && scenario.pages.length > 0) {
        this.pages = JSON.parse(JSON.stringify(scenario.pages));
        this.activePageId = this.pages.some(p => p.id === scenario.activePageId)
          ? scenario.activePageId
          : this.pages[0].id;
        this._pageNextId = Math.max(this._pageNextId,
          ...this.pages.map(p => (parseInt(String(p.id).replace('page_', '')) || 0) + 1));
      }
      // A full snapshot can resurrect stale groupId/pageId references
      // (groups deleted since the save, pages added since, …) — reconcile.
      this._reconcileGroupsAndPages();
    } else {
      // Overlay: apply selected categories to matching current components
      for (const snap of scenario.components) {
        const cur = this.components.get(snap.id);
        if (!cur) continue;
        if (applies.layout) {
          cur.x = snap.x;
          cur.y = snap.y;
          cur.rotation = snap.rotation || 0;
        }
        if (!snap.props) continue;
        const isSwitchgear = SWITCHING_TYPES.has(cur.type);
        for (const [k, v] of Object.entries(snap.props)) {
          if (k === 'name') continue;                       // identity: never applied
          if (k === 'state' && isSwitchgear) {
            if (applies.switching) cur.props[k] = JSON.parse(JSON.stringify(v));
            continue;
          }
          if (k === 'busWidth') {
            if (applies.layout) cur.props[k] = v;
            continue;
          }
          if (applies.settings) cur.props[k] = JSON.parse(JSON.stringify(v));
        }
      }
    }
    this.dirty = true;
    return true;
  },

  // Reconcile group and page references after a full-snapshot restore:
  //  - drop group memberIds that reference missing components;
  //  - delete groups left with <2 members (createGroup requires ≥2) and
  //    untag any surviving member;
  //  - strip comp.groupId when the group no longer exists;
  //  - remap comp.pageId (and activePageId) referencing a nonexistent page
  //    to the active/first page so components can't become unreachable.
  _reconcileGroupsAndPages() {
    for (const [gid, group] of [...this.groups]) {
      for (const cid of [...group.memberIds]) {
        if (!this.components.has(cid)) group.memberIds.delete(cid);
      }
      if (group.memberIds.size < 2) {
        for (const cid of group.memberIds) {
          const comp = this.components.get(cid);
          if (comp) delete comp.groupId;
        }
        this.groups.delete(gid);
      }
    }
    const pageIds = new Set(this.pages.map(p => p.id));
    if (!pageIds.has(this.activePageId)) this.activePageId = this.pages[0].id;
    for (const comp of this.components.values()) {
      if (comp.groupId && !this.groups.has(comp.groupId)) delete comp.groupId;
      // Components without pageId belong to page_1 (legacy convention)
      if (!pageIds.has(comp.pageId || 'page_1')) comp.pageId = this.activePageId;
    }
  },

  // Update scenario description
  updateScenario(scenarioId, name, description) {
    const scenario = this.scenarios.find(s => s.id === scenarioId);
    if (!scenario) return false;
    if (name != null) scenario.name = name;
    if (description != null) scenario.description = description;
    this.dirty = true;
    return true;
  },

  // Delete a scenario
  deleteScenario(scenarioId) {
    const idx = this.scenarios.findIndex(s => s.id === scenarioId);
    if (idx === -1) return false;
    this.scenarios.splice(idx, 1);
    this.dirty = true;
    return true;
  },

  // Apply a Load Flow Study case snapshot onto the live network — a full
  // restore of topology + attributes (mirrors loadScenario's full branch),
  // preserving current device names by id. Used by the Study Manager's
  // "Apply to network". loadFlowMethod is a per-run choice, not a live field,
  // so it is not applied here; baseMVA is.
  applyLoadFlowCase(caseObj) {
    if (!caseObj || !Array.isArray(caseObj.components)) return false;
    this.selectedIds.clear();
    this.clearResults();
    const currentNames = new Map();
    for (const [id, c] of this.components) {
      if (c.props && c.props.name != null) currentNames.set(id, c.props.name);
    }
    this.components.clear();
    this.wires.clear();
    for (const c of caseObj.components) {
      const copy = JSON.parse(JSON.stringify(c));
      if (currentNames.has(c.id)) copy.props.name = currentNames.get(c.id);
      this.components.set(c.id, copy);
    }
    for (const w of (caseObj.wires || [])) {
      this.wires.set(w.id, JSON.parse(JSON.stringify(w)));
    }
    if (Number.isFinite(caseObj.nextId)) {
      this.nextId = caseObj.nextId;
    } else {
      let maxN = 0;
      for (const id of this.components.keys()) {
        const m = /(\d+)$/.exec(id);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
      this.nextId = Math.max(this.nextId, maxN + 1);
    }
    if (caseObj.baseMVA != null) this.baseMVA = caseObj.baseMVA;
    this._reconcileGroupsAndPages();
    this.dirty = true;
    return true;
  },

  // ── Component Grouping ──

  createGroup(name) {
    const selectedComps = [...this.selectedIds].filter(id => this.components.has(id));
    if (selectedComps.length < 2) return null;
    const id = `group_${this._groupNextId++}`;
    const group = { id, name: name || `Group ${this._groupNextId - 1}`, memberIds: new Set(selectedComps), collapsed: false };
    this.groups.set(id, group);
    // Tag components with groupId
    for (const cid of selectedComps) {
      const comp = this.components.get(cid);
      if (comp) comp.groupId = id;
    }
    this.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    return group;
  },

  ungroupSelected() {
    const groupIds = new Set();
    for (const id of this.selectedIds) {
      const comp = this.components.get(id);
      if (comp?.groupId) groupIds.add(comp.groupId);
    }
    for (const gid of groupIds) {
      const group = this.groups.get(gid);
      if (!group) continue;
      for (const cid of group.memberIds) {
        const comp = this.components.get(cid);
        if (comp) delete comp.groupId;
      }
      this.groups.delete(gid);
    }
    this.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  getGroupBounds(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cid of group.memberIds) {
      const comp = this.components.get(cid);
      if (!comp) continue;
      const def = COMPONENT_DEFS[comp.type];
      const hw = (def?.width || 60) / 2;
      const hh = (def?.height || 60) / 2;
      minX = Math.min(minX, comp.x - hw);
      minY = Math.min(minY, comp.y - hh);
      maxX = Math.max(maxX, comp.x + hw);
      maxY = Math.max(maxY, comp.y + hh);
    }
    // Every member missing (e.g. stale group after a snapshot restore):
    // never emit an Infinity rect — callers treat null as "nothing to draw".
    if (!isFinite(minX)) return null;
    return { x: minX - 10, y: minY - 10, w: maxX - minX + 20, h: maxY - minY + 20 };
  },

  selectGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const cid of group.memberIds) this.selectedIds.add(cid);
  },

  // ── Multi-Page Diagrams ──

  addPage(name) {
    const id = `page_${this._pageNextId++}`;
    this.pages.push({ id, name: name || `Sheet ${this.pages.length + 1}` });
    this.dirty = true;
    return id;
  },

  deletePage(pageId) {
    if (this.pages.length <= 1) return false;
    // Remove components on this page
    for (const [cid, comp] of this.components) {
      if (comp.pageId === pageId) this.removeComponent(cid);
    }
    this.pages = this.pages.filter(p => p.id !== pageId);
    if (this.activePageId === pageId) this.activePageId = this.pages[0].id;
    this.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    return true;
  },

  renamePage(pageId, name) {
    const page = this.pages.find(p => p.id === pageId);
    if (page) { page.name = name; this.dirty = true; }
  },

  getActivePageComponents() {
    // Components without pageId belong to page_1 (legacy)
    const result = new Map();
    for (const [id, comp] of this.components) {
      const cPage = comp.pageId || 'page_1';
      if (cPage === this.activePageId) result.set(id, comp);
    }
    return result;
  },

  getActivePageWires() {
    const pageComps = this.getActivePageComponents();
    const result = new Map();
    for (const [id, wire] of this.wires) {
      if (pageComps.has(wire.fromComponent) || pageComps.has(wire.toComponent)) {
        result.set(id, wire);
      }
    }
    return result;
  },

  // Topology-mutation commit ritual — the same sequence a properties-panel
  // edit performs: show the results-cleared status notice (only when there
  // are results to clear), then clear every stale analysis result slot.
  // Call from every path that mutates network topology (delete, cut, paste,
  // new wire, bus resize).
  invalidateResults() {
    if (typeof Properties !== 'undefined' && Properties._notifyResultsCleared) {
      Properties._notifyResultsCleared();
    }
    this.clearResults();
  },

  // Clear all results
  clearResults() {
    this.faultResults = null;
    this.faultedBusId = null;
    this.loadFlowResults = null;
    this.unbalancedLoadFlowResults = null;
    this.arcFlashResults = null;
    this.dcArcFlashResults = null;
    this.dcLoadFlowResults = null;
    this.dcShortCircuitResults = null;
    this.cableSizingResults = null;
    this.motorStartingResults = null;
    this.dynamicMotorResults = null;
    this.stabilityResults = null;
    // NB: stabilityCases / dynamicMotorCases / loadFlowCases are project config,
    // NOT results — they must survive topology edits (clearResults runs on every
    // mutation), so they are reset only in reset() / reloaded in fromJSON.
    this.dutyCheckResults = null;
    this.loadDiversityResults = null;
    this.groundingResults = null;
    this.studyManagerResults = null;
  },

  // Reset entire state
  reset() {
    this.projectId = null;
    this.projectName = 'Untitled Project';
    this.dirty = false;
    this.projectDetails = {
      projectNumber: '', client: '', company: '', engineerName: '',
      checkedBy: '', approvedBy: '', revisionNumber: '',
      date: '', description: '', companyLogo: null,
    };
    this.components.clear();
    this.wires.clear();
    this.nextId = 1;
    this.selectedIds.clear();
    this.clearResults();
    this.stabilityCases = [];  // saved transient-stability disturbance cases
    this.dynamicMotorSchedule = null;
    this.dynamicMotorCases = [];
    this.loadFlowCases = [];   // saved load-flow study cases
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.mode = MODE.SELECT;
    this.placingType = null;
    this.wireStart = null;
    this.dragState = null;
    this.scenarios = [];
    this._scenarioNextId = 1;
    this.groups.clear();
    this._groupNextId = 1;
    this.pages = [{ id: 'page_1', name: 'Sheet 1' }];
    this.activePageId = 'page_1';
    this._pageNextId = 2;
    this.wireRouteMode = 'orthogonal';
    this.reticulation = this._defaultReticulation();
    this.reticResults = null;
    this.planMarkup = this._defaultPlanMarkup();
    this.lightningRisk = null;   // saved IEC 62305-2 form inputs
    this.raceways = [];
    // Clear annotation drag offsets
    if (typeof Annotations !== 'undefined') {
      Annotations.offsets.clear();
    }
    // Project identity changed (new project, import, load, template…):
    // rotate the local-revision namespace so revisions of the previous
    // unsaved project can never leak into this one — even from a switch
    // path that forgot to call RevisionTimeline.clearLocal().
    if (typeof RevisionTimeline !== 'undefined' && RevisionTimeline.onProjectIdentityReset) {
      RevisionTimeline.onProjectIdentityReset();
    }
    // Reticulation workspace: drop its local undo history and refresh its view
    if (typeof Retic !== 'undefined' && Retic.onProjectChanged) {
      Retic.onProjectChanged();
    }
    // Plan Markup workspace: same — re-baseline its local undo + image cache
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.onProjectChanged) {
      PlanMarkup.onProjectChanged();
    }
  },

  // Migrate pre-v2 cable resistances (20°C DC) to operating-temperature values
  // to match the corrected cable library and the backend's hot-resistance
  // convention. Operates in place on a plain components array (main diagram or
  // a scenario snapshot). Returns per-category counts so the caller can log a
  // diagnosable summary: {snapped, scaled, skipped}.
  //   snapped — stored value matched the OLD (20°C) library value → replaced
  //             with the corrected hot library value;
  //   scaled  — user-edited (or library-less) 20°C value → multiplied by the
  //             temperature factor;
  //   skipped — stored value ALREADY matches the current (hot) library value
  //             (v1-era file saved after the library hot-correction but before
  //             dataVersion stamping) → normalized to the exact library figure,
  //             NOT scaled again.
  _migrateCableResistances(components) {
    const round4 = (v) => Number(v.toPrecision(4));
    // Within 1% of a reference value
    const near = (v, ref) => typeof ref === 'number' && ref > 0 &&
      Math.abs(v - ref) / ref < 0.01;
    const factorFor = (stdType) => {
      const t = String(stdType || '').toLowerCase();
      if (t.includes('cu_xlpe')) return 1.275;
      if (t.includes('al_xlpe')) return 1.282;
      if (t.includes('cu_pvc')) return 1.20;
      if (t.includes('al_pvc')) return 1.213;
      return 1.275; // default: assume Cu XLPE (pre-v2 data was 20°C DC)
    };
    const lib = (typeof STANDARD_CABLES !== 'undefined') ? STANDARD_CABLES : [];
    const stats = { snapped: 0, scaled: 0, skipped: 0 };
    for (const c of components) {
      if (!c || c.type !== 'cable' || !c.props) continue;
      const p = c.props;
      if (typeof p.r_per_km !== 'number' || p.r_per_km <= 0) continue;
      const factor = factorFor(p.standard_type);
      const std = p.standard_type ? lib.find(l => l.id === p.standard_type) : null;
      const hasR0 = typeof p.r0_per_km === 'number' && p.r0_per_km > 0;
      if (std && near(p.r_per_km, std.r_per_km)) {
        // Already stores the CURRENT (operating-temperature) library value —
        // a file from the window after the library hot-correction but before
        // dataVersion stamping. Snap to the exact library figure; do NOT
        // scale again (scaling here permanently inflated R by ×factor).
        p.r_per_km = std.r_per_km;
        if (hasR0 && near(p.r0_per_km, std.r0_per_km)) {
          p.r0_per_km = std.r0_per_km;
        }
        stats.skipped++;
      } else if (std) {
        // If the stored value still matches the OLD (20°C) library value, snap
        // to the library's corrected figures exactly; otherwise the user edited
        // it, so scale the user's value by the temperature factor.
        const oldLibR = std.r_per_km / factor;
        if (near(p.r_per_km, oldLibR)) {
          p.r_per_km = std.r_per_km;
          if (std.r0_per_km != null) p.r0_per_km = std.r0_per_km;
          stats.snapped++;
        } else {
          p.r_per_km = round4(p.r_per_km * factor);
          if (hasR0) {
            // Same already-hot guard per field: an r0 that already matches
            // the current library value must not be re-scaled.
            if (near(p.r0_per_km, std.r0_per_km)) {
              p.r0_per_km = std.r0_per_km;
            } else if (near(p.r0_per_km, std.r0_per_km != null ? std.r0_per_km / factor : null)) {
              p.r0_per_km = std.r0_per_km;
            } else {
              p.r0_per_km = round4(p.r0_per_km * factor);
            }
          }
          stats.scaled++;
        }
      } else {
        // No library entry to compare against — assume 20°C and scale.
        p.r_per_km = round4(p.r_per_km * factor);
        if (hasR0) p.r0_per_km = round4(p.r0_per_km * factor);
        stats.scaled++;
      }
    }
    return stats;
  },

  // Export to JSON
  toJSON() {
    return {
      // Schema version. v2: cable r_per_km/r0_per_km store conductor
      // operating-temperature resistance (was 20°C DC in v1).
      dataVersion: 2,
      projectName: this.projectName,
      projectDetails: this.projectDetails,
      baseMVA: this.baseMVA,
      frequency: this.frequency,
      voltageFactor: this.voltageFactor,
      defaultLengthUnit: this.defaultLengthUnit,
      components: [...this.components.values()],
      wires: [...this.wires.values()],
      nextId: this.nextId,
      scenarios: this.scenarios,
      groups: [...this.groups.values()].map(g => ({ ...g, memberIds: [...g.memberIds] })),
      pages: this.pages,
      activePageId: this.activePageId,
      wireRouteMode: this.wireRouteMode,
      reticulation: this.reticulation,
      planMarkup: this._planMarkupIsEmpty() ? undefined : this._planMarkupToJSON(),
      annotationOffsets: Annotations.offsets.size > 0
        ? Object.fromEntries(Annotations.offsets)
        : undefined,
      // Persist analysis results so result boxes survive save/load
      faultResults: this.faultResults || undefined,
      faultedBusId: this.faultedBusId || undefined,
      loadFlowResults: this.loadFlowResults || undefined,
      unbalancedLoadFlowResults: this.unbalancedLoadFlowResults || undefined,
      arcFlashResults: this.arcFlashResults || undefined,
      dcArcFlashResults: this.dcArcFlashResults || undefined,
      dcLoadFlowResults: this.dcLoadFlowResults || undefined,
      dcShortCircuitResults: this.dcShortCircuitResults || undefined,
      cableSizingResults: this.cableSizingResults || undefined,
      motorStartingResults: this.motorStartingResults || undefined,
      dynamicMotorResults: this.dynamicMotorResults || undefined,
      stabilityResults: this.stabilityResults || undefined,
      stabilityCases: (this.stabilityCases && this.stabilityCases.length) ? this.stabilityCases : undefined,
      dynamicMotorSchedule: (this.dynamicMotorSchedule && this.dynamicMotorSchedule.motors
        && this.dynamicMotorSchedule.motors.length) ? this.dynamicMotorSchedule : undefined,
      dynamicMotorCases: (this.dynamicMotorCases && this.dynamicMotorCases.length) ? this.dynamicMotorCases : undefined,
      loadFlowCases: (this.loadFlowCases && this.loadFlowCases.length) ? this.loadFlowCases : undefined,
      dutyCheckResults: this.dutyCheckResults || undefined,
      loadDiversityResults: this.loadDiversityResults || undefined,
      groundingResults: this.groundingResults || undefined,
      studyManagerResults: this.studyManagerResults || undefined,
      // Provenance for the persisted results (app version + time per slot) so a
      // result computed on an older engine version is detected as stale on load.
      resultsMeta: (this.resultsMeta && Object.keys(this.resultsMeta).length)
        ? this.resultsMeta : undefined,
      lightningRisk: this.lightningRisk || undefined,
      raceways: this.raceways.length ? this.raceways : undefined,
    };
  },

  // Import from JSON
  // Validate that `data` is a plausible ProtectionPro project before we
  // discard the current one. JSON.parse accepts ANY valid JSON, so without
  // this an unrelated file ({}, [], or another app's export) would silently
  // load as an empty diagram and report success. Throwing lets the import
  // caller's catch surface a clear error, and — because callers validate
  // before touching state — leaves the current project intact on a bad file.
  _validateProjectData(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not a ProtectionPro project — expected a JSON object.');
    }
    if (!Array.isArray(data.components)) {
      throw new Error('not a ProtectionPro project — missing a "components" array.');
    }
    if (data.wires !== undefined && !Array.isArray(data.wires)) {
      throw new Error('malformed project — "wires" must be an array.');
    }
    data.components.forEach((c, i) => {
      if (c === null || typeof c !== 'object' || Array.isArray(c) ||
          c.id === undefined || c.type === undefined) {
        throw new Error(`malformed project — components[${i}] is not a valid component (needs id and type).`);
      }
    });
    (data.wires || []).forEach((w, i) => {
      if (w === null || typeof w !== 'object' || Array.isArray(w) || w.id === undefined) {
        throw new Error(`malformed project — wires[${i}] is not a valid wire (needs an id).`);
      }
    });
  },

  fromJSON(data) {
    this._validateProjectData(data);
    this.reset();
    this.projectName = data.projectName || 'Untitled Project';
    if (data.projectDetails) {
      this.projectDetails = {
        projectNumber: data.projectDetails.projectNumber || '',
        // Accept legacy 'clientCompany' key for backward compatibility
        client: data.projectDetails.client || data.projectDetails.clientCompany || '',
        company: data.projectDetails.company || '',
        engineerName: data.projectDetails.engineerName || '',
        checkedBy: data.projectDetails.checkedBy || '',
        approvedBy: data.projectDetails.approvedBy || '',
        revisionNumber: data.projectDetails.revisionNumber || '',
        date: data.projectDetails.date || '',
        description: data.projectDetails.description || '',
        companyLogo: data.projectDetails.companyLogo || null,
      };
    }
    this.baseMVA = data.baseMVA || DEFAULT_BASE_MVA;
    this.frequency = data.frequency || DEFAULT_FREQUENCY;
    this.voltageFactor = data.voltageFactor || DEFAULT_VOLTAGE_FACTOR;
    this.defaultLengthUnit = data.defaultLengthUnit || 'm';
    // nextId must clear every loaded id: a stale/hand-edited nextId below an
    // existing suffix would let genId() mint a duplicate id, and Map.set would
    // silently overwrite that component (its wires re-attaching to the new
    // one). Take the max of the stored counter and (highest numeric suffix
    // across all component AND wire ids) + 1.
    let maxIdSuffix = 0;
    for (const list of [data.components || [], data.wires || []]) {
      for (const item of list) {
        const m = /_(\d+)$/.exec(String(item && item.id || ''));
        if (m) maxIdSuffix = Math.max(maxIdSuffix, parseInt(m[1], 10));
      }
    }
    this.nextId = Math.max(data.nextId || 1, maxIdSuffix + 1);
    this.scenarios = data.scenarios || [];
    this._scenarioNextId = this.scenarios.length > 0
      ? Math.max(...this.scenarios.map(s => parseInt(s.id.replace('scenario_', '')) || 0)) + 1
      : 1;

    // Migrate legacy cable resistances (pre-v2 projects stored 20°C DC values;
    // the backend now treats cable r_per_km as operating-temperature). Applies
    // to the main diagram and every scenario snapshot.
    if (!data.dataVersion || data.dataVersion < 2) {
      const stats = this._migrateCableResistances(data.components || []);
      for (const sc of this.scenarios) {
        const s = this._migrateCableResistances(sc.components || []);
        stats.snapped += s.snapped;
        stats.scaled += s.scaled;
        stats.skipped += s.skipped;
      }
      if (stats.snapped + stats.scaled + stats.skipped > 0) {
        if (stats.snapped + stats.scaled > 0) this.dirty = true;
        console.warn(
          `[migration] "${this.projectName}": dataVersion 1→2 cable resistance migration — ` +
          `${stats.snapped} snapped to hot library values, ` +
          `${stats.scaled} scaled by temperature factor, ` +
          `${stats.skipped} already at operating temperature (left unscaled).`
        );
      }
    }

    for (const c of data.components || []) {
      this.components.set(c.id, c);
    }
    for (const w of data.wires || []) {
      this.wires.set(w.id, w);
    }
    // Migrate legacy bus port ids (left/right/top_i/bottom_i) to free-position
    // 'at_<x>' attachments so they stay put through bus resizes. The render
    // fallback still resolves unmigrated ids, so this is safe best-effort.
    if (typeof Symbols !== 'undefined' && Symbols.getBusPortLocal) {
      for (const w of this.wires.values()) {
        for (const [compKey, portKey] of [['fromComponent', 'fromPort'], ['toComponent', 'toPort']]) {
          const comp = this.components.get(w[compKey]);
          if (!comp || comp.type !== 'bus') continue;
          const pid = String(w[portKey] || '');
          if (pid.startsWith('at_')) continue;
          const loc = Symbols.getBusPortLocal(comp, pid);
          if (loc) w[portKey] = `at_${Math.round(loc.x)}`;
        }
      }
    }
    // Restore groups
    if (data.groups) {
      for (const g of data.groups) {
        this.groups.set(g.id, { ...g, memberIds: new Set(g.memberIds) });
      }
      this._groupNextId = data.groups.length > 0
        ? Math.max(...data.groups.map(g => parseInt(g.id.replace('group_', '')) || 0)) + 1 : 1;
    }
    // Restore pages
    if (data.pages && data.pages.length > 0) {
      this.pages = data.pages;
      this.activePageId = data.activePageId || data.pages[0].id;
      this._pageNextId = Math.max(...data.pages.map(p => parseInt(p.id.replace('page_', '')) || 0)) + 1;
    }
    if (data.wireRouteMode) this.wireRouteMode = data.wireRouteMode;
    // Restore reticulation module (backfill defaults for older projects)
    if (data.reticulation && typeof data.reticulation === 'object') {
      const def = this._defaultReticulation();
      const r = data.reticulation;
      this.reticulation = {
        settings: { ...def.settings, ...(r.settings || {}) },
        minisubs: Array.isArray(r.minisubs) && r.minisubs.length
          ? r.minisubs : [{ id: 'source', name: 'Minisub 1' }],
        kiosks: Array.isArray(r.kiosks) ? r.kiosks : [],
        _kioskSeq: r._kioskSeq || 1,
        _erfSeq: r._erfSeq || 1,
        _msSeq: r._msSeq || 2,
      };
      // Repair id sequence counters so genId never collides with loaded ids
      let maxK = 0, maxE = 0, maxM = 0;
      for (const k of this.reticulation.kiosks) {
        const mk = /_(\d+)$/.exec(String(k.id || '')); if (mk) maxK = Math.max(maxK, +mk[1]);
        for (const e of (k.erfs || [])) {
          const me = /_(\d+)$/.exec(String(e.id || '')); if (me) maxE = Math.max(maxE, +me[1]);
        }
      }
      for (const m of this.reticulation.minisubs) {
        const mm = /^minisub_(\d+)$/.exec(String(m.id || '')); if (mm) maxM = Math.max(maxM, +mm[1]);
      }
      this.reticulation._kioskSeq = Math.max(this.reticulation._kioskSeq, maxK + 1);
      this.reticulation._erfSeq = Math.max(this.reticulation._erfSeq, maxE + 1);
      this.reticulation._msSeq = Math.max(this.reticulation._msSeq, maxM + 1);
    }
    // Restore plan-markup module (backfill defaults for older projects)
    if (data.planMarkup && typeof data.planMarkup === 'object') {
      const pdef = this._defaultPlanMarkup();
      const p = data.planMarkup;
      const arr = (v) => (Array.isArray(v) ? v : []);
      const settings = { ...pdef.settings, ...(p.settings || {}) };
      // Normalise a per-floor drawing bundle (from a floor.data, or — for
      // legacy pre-floors projects — from the flat top-level planMarkup).
      const normData = (d) => {
        d = d || {};
        return {
          plans: arr(d.plans), scale: d.scale || null, cropBox: d.cropBox || null,
          elements: arr(d.elements), routes: arr(d.routes), trenches: arr(d.trenches),
          crossings: arr(d.crossings), rooms: arr(d.rooms), texts: arr(d.texts),
          measurements: arr(d.measurements),
        };
      };
      // v2+ carries floors[]; older projects had one flat plan → wrap it as the
      // Ground floor (floors[] is designed so this needs no other migration).
      let floors;
      if (Array.isArray(p.floors) && p.floors.length) {
        floors = p.floors.map((f, i) => ({
          id: f.id || `pmfloor_leg${i}`,
          name: f.name || (i === 0 ? 'Ground' : `Floor ${i}`),
          level: (f.level == null ? i : f.level),
          height: (f.height == null ? (settings.floorHeight || 3.5) : f.height),
          data: normData(f.data),
        }));
      } else {
        floors = [{ id: 'pmfloor_leg0', name: 'Ground', level: 0,
          height: (settings.floorHeight || 3.5), data: normData(p) }];
      }
      const activeFloorId = (p.activeFloorId && floors.some(f => f.id === p.activeFloorId))
        ? p.activeFloorId : floors[0].id;
      this.planMarkup = {
        version: 2,
        floors, activeFloorId,
        layers: (Array.isArray(p.layers) && p.layers.length) ? p.layers : pdef.layers,
        activeLayerId: p.activeLayerId || null,
        styles: (p.styles && typeof p.styles === 'object') ? p.styles : {},
        settings,
        _seq: p._seq || 1,
        nameCounters: (p.nameCounters && typeof p.nameCounters === 'object') ? p.nameCounters : {},
      };
      // Migrate consolidated / dynamic-block types. Main DB → one DB; old
      // Main/Sub-Main feeders → one Feeder; and the separate socket/light/
      // switch variants collapse into parametric families driven by props.
      const ELEM_MIGRATE = {
        bd_mdb: { type: 'bd_db' },
        bd_socket2: { type: 'bd_socket', props: { gangs: '2' } },
        bd_socket_ip: { type: 'bd_socket', props: { weatherproof: true } },
        bd_downlight: { type: 'bd_light', props: { kind: 'downlight' } },
        bd_batten: { type: 'bd_light', props: { kind: 'batten' } },
        bd_floodlight: { type: 'bd_light', props: { kind: 'floodlight' } },
        bd_emergency: { type: 'bd_light', props: { kind: 'emergency' } },
        bd_exit: { type: 'bd_light', props: { kind: 'exit' } },
        bd_switch2: { type: 'bd_switch', props: { gangs: '2' } },
        bd_dimmer: { type: 'bd_switch', props: { kind: 'dimmer' } },
      };
      const ROUTE_MIGRATE = { main_feeder: 'feeder', sub_main: 'feeder' };
      const pm = this.planMarkup;
      // Repair _seq so planGenId never collides with a loaded id
      let maxSeq = 0;
      const scanSeq = (a) => {
        for (const it of a) {
          const m = /_(\d+)$/.exec(String((it && it.id) || ''));
          if (m) maxSeq = Math.max(maxSeq, +m[1]);
        }
      };
      const reticIds = new Set([
        ...this.reticulation.minisubs.map(m => m.id),
        ...this.reticulation.kiosks.map(k => k.id),
        ...this.reticulation.kiosks.flatMap(k => (k.erfs || []).map(e => e.id)),
      ]);
      for (const fl of pm.floors) {
        const d = fl.data;
        for (const el of d.elements) {
          const m = ELEM_MIGRATE[el.type];
          if (m) { el.type = m.type; if (m.props) el.props = { ...(el.props || {}), ...m.props }; }
          // Sockets: legacy `gangs` (1/2/3) → `outlets` (single/double).
          if (el.type === 'bd_socket' && el.props && el.props.gangs != null && el.props.outlets == null) {
            el.props.outlets = (String(el.props.gangs) === '1') ? 'single' : 'double';
            delete el.props.gangs;
          }
          if (el.reticId && !reticIds.has(el.reticId)) el.reticId = null;   // drop dangling backrefs
        }
        for (const rt of d.routes) if (ROUTE_MIGRATE[rt.type]) rt.type = ROUTE_MIGRATE[rt.type];
        scanSeq(d.plans); scanSeq(d.elements); scanSeq(d.routes);
        scanSeq(d.trenches); scanSeq(d.crossings); scanSeq(d.rooms);
        scanSeq(d.texts); scanSeq(d.measurements);
      }
      scanSeq(pm.floors);
      pm._seq = Math.max(pm._seq, maxSeq + 1);
      // Mirror the active floor's collections onto the live working set.
      const active = pm.floors.find(f => f.id === pm.activeFloorId) || pm.floors[0];
      for (const k of this._PLAN_FLOOR_KEYS) pm[k] = active.data[k];
    }
    // Restore annotation badge positions
    if (data.annotationOffsets && typeof Annotations !== 'undefined') {
      Annotations.offsets.clear();
      for (const [key, val] of Object.entries(data.annotationOffsets)) {
        Annotations.offsets.set(key, val);
      }
    }
    // Restore analysis results so result boxes appear on load. Write straight
    // into the backing store (NOT through the stamping accessors) and restore
    // the saved provenance verbatim — so a result computed on an older app/
    // engine version stays flagged stale (see resultsMeta / isResultStale).
    // A save that predates provenance has no resultsMeta ⇒ every result reads
    // as stale, which is the safe default.
    this._results = {};
    this.resultsMeta = (data.resultsMeta && typeof data.resultsMeta === 'object')
      ? { ...data.resultsMeta } : {};
    for (const slot of RESULT_SLOTS) {
      if (data[slot] != null) this._results[slot] = data[slot];
    }
    this.faultedBusId = data.faultedBusId || null;
    this.stabilityCases = Array.isArray(data.stabilityCases) ? data.stabilityCases : [];
    this.dynamicMotorSchedule = (data.dynamicMotorSchedule && Array.isArray(data.dynamicMotorSchedule.motors))
      ? data.dynamicMotorSchedule : null;
    this.dynamicMotorCases = Array.isArray(data.dynamicMotorCases) ? data.dynamicMotorCases : [];
    this.loadFlowCases = Array.isArray(data.loadFlowCases) ? data.loadFlowCases : [];
    this.lightningRisk = data.lightningRisk || null;
    this.raceways = Array.isArray(data.raceways) ? data.raceways : [];
    this.dirty = false;
    // Re-baseline the reticulation workspace on the loaded project's data
    // (reset() above ran with the default empty reticulation).
    if (typeof Retic !== 'undefined' && Retic.onProjectChanged) {
      Retic.onProjectChanged();
    }
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.onProjectChanged) {
      PlanMarkup.onProjectChanged();
    }
  },
};

// Initialize the Plan Markup sub-store now that the AppState methods exist.
// (PLAN_DEFAULT_LAYERS comes from plan-defs.js, loaded before this file.)
AppState.planMarkup = AppState._defaultPlanMarkup();

// ── Study-result provenance ────────────────────────────────────────────────
// Expose every RESULT_SLOTS entry as an accessor over AppState._results so that
// EVERY assignment (from any run path — no compute site can be missed) records
// when and by which app version the result was produced. On load, fromJSON
// writes the backing store directly and restores the saved provenance, so a
// result computed on an older engine version reads as stale. This catches the
// case a topology hash cannot: an engine fix that changes the verdict without
// changing the network (e.g. the per-island transient-stability COI fix).
AppState._results = AppState._results || {};
AppState.resultsMeta = AppState.resultsMeta || {};   // slot -> { v, at, run }
AppState._runSeq = 0;
for (const slot of RESULT_SLOTS) {
  Object.defineProperty(AppState, slot, {
    configurable: true,
    enumerable: true,
    get() {
      const v = this._results[slot];
      return v == null ? null : v;
    },
    set(v) {
      if (v == null) {
        delete this._results[slot];
        delete this.resultsMeta[slot];
        return;
      }
      this._results[slot] = v;
      this.resultsMeta[slot] = {
        v: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null),
        at: Date.now(),
        run: ++this._runSeq,
      };
    },
  });
}

// A stored result is stale if it exists but its provenance is missing or was
// stamped by a different app version than the one now running.
AppState.isResultStale = function (slot) {
  if (this._results[slot] == null) return false;
  const m = this.resultsMeta[slot];
  return !m || m.v !== (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null);
};

AppState.resultMetaInfo = function (slot) {
  return this.resultsMeta[slot] || null;
};

AppState.staleResultSlots = function () {
  return RESULT_SLOTS.filter((s) => this.isResultStale(s));
};

// The result for a slot, or null when it is stale — used to keep out-of-date
// results out of reports.
AppState.freshResult = function (slot) {
  return this.isResultStale(slot) ? null : (this._results[slot] || null);
};

// Shared "out of date — re-run" banner for a study view. Returns '' when the
// slot's result is current (or absent), so callers can prepend it blindly.
AppState.staleBannerHTML = function (slot) {
  if (!this.isResultStale(slot)) return '';
  const m = this.resultsMeta[slot];
  const ver = (m && m.v) ? escHtml(m.v) : 'an earlier version';
  let when = '';
  if (m && m.at) {
    try { when = ' (' + escHtml(new Date(m.at).toLocaleString()) + ')'; } catch (e) { when = ''; }
  }
  return '<div class="stale-result-banner" role="alert" style="'
    + 'display:flex;gap:8px;align-items:flex-start;margin:0 0 10px;padding:8px 11px;'
    + 'border:1px solid #e0a800;border-radius:6px;background:#fff8e1;color:#7a5c00;'
    + 'font-size:12px;line-height:1.4">'
    + '<span style="font-size:14px">⚠</span><span><strong>Out of date.</strong> '
    + 'These results were computed on ' + ver + when + ', not the current version. '
    + 'Re-run the study to update — they are shown for reference and are excluded from reports.'
    + '</span></div>';
};

// Snap coordinate to grid
function snapToGrid(val) {
  return Math.round(val / SNAP_SIZE) * SNAP_SIZE;
}

// Escape a string for safe interpolation into HTML/SVG markup
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
