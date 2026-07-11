/* ProtectionPro — Application State */

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
    duty: true,
    loadDiversity: true,
    grounding: true,
  },

  // Clipboard for copy/paste
  clipboard: null, // { components: [], wires: [] }

  // Analysis results
  faultResults: null,
  faultedBusId: null,  // ID of the specific bus that was faulted (null = all buses)
  loadFlowResults: null,
  unbalancedLoadFlowResults: null,
  arcFlashResults: null,

  // Scenarios — saved snapshots of network configuration
  scenarios: [],  // [{id, name, description, timestamp, components, wires, nextId}]
  _scenarioNextId: 1,

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
  _defaultPlanMarkup() {
    const layers = (typeof PLAN_DEFAULT_LAYERS !== 'undefined')
      ? PLAN_DEFAULT_LAYERS.map(l => ({ ...l }))
      : [];
    return {
      version: 1,
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
      layers,             // discipline layers (filter by entity type)
      activeLayerId: null,
      styles: {},         // sparse overrides merged over PLAN_DEFS defaults
      settings: {
        domain: 'retic', gridSize: 0.5,
        snapGrid: true, snapEl: true, snapVtx: true, snapRoute: true,
        showGrid: true, greyBg: false, invertBg: false, slPoleKVA: 0.15,
        // Bill-of-quantities rates (currency-neutral; 0 until the user sets them)
        rates: { cablePerM: 0, equipUnit: 0, trenchPerM: 0, wasteFactorPct: 5 },
      },
      _seq: 1,            // single counter for all pm* ids
      nameCounters: {},   // per-type auto-name numbering {kiosk:4, pole:12, ...}
    };
  },

  // Mint a plan-markup id. All prefixes start with "pm" so they can never
  // collide with SLD ids (<type>_<n>) or reticulation ids (kiosk_/erf_/minisub_).
  planGenId(prefix) {
    return `${prefix}_${this.planMarkup._seq++}`;
  },

  // True when the module holds nothing worth persisting — keeps toJSON() from
  // adding a planMarkup key to projects that never used the workspace.
  _planMarkupIsEmpty() {
    const p = this.planMarkup;
    if (!p) return true;
    return !p.plans.length && !p.elements.length && !p.routes.length &&
      !p.trenches.length && !p.crossings.length && !p.texts.length &&
      !p.measurements.length && !(p.rooms && p.rooms.length) && !p.scale;
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
      props: { ...def.defaults },
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
        props: { ...comp.props, name: this._uniqueCopyName(comp.props.name, takenNames) },
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
    this.cableSizingResults = null;
    this.motorStartingResults = null;
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
      planMarkup: this._planMarkupIsEmpty() ? undefined : this.planMarkup,
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
      cableSizingResults: this.cableSizingResults || undefined,
      motorStartingResults: this.motorStartingResults || undefined,
      dutyCheckResults: this.dutyCheckResults || undefined,
      loadDiversityResults: this.loadDiversityResults || undefined,
      groundingResults: this.groundingResults || undefined,
      studyManagerResults: this.studyManagerResults || undefined,
      lightningRisk: this.lightningRisk || undefined,
      raceways: this.raceways.length ? this.raceways : undefined,
    };
  },

  // Import from JSON
  fromJSON(data) {
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
      this.planMarkup = {
        version: p.version || 1,
        plans: arr(p.plans),
        scale: p.scale || null,
        cropBox: p.cropBox || null,
        elements: arr(p.elements),
        routes: arr(p.routes),
        trenches: arr(p.trenches),
        crossings: arr(p.crossings),
        rooms: arr(p.rooms),
        texts: arr(p.texts),
        measurements: arr(p.measurements),
        layers: (Array.isArray(p.layers) && p.layers.length) ? p.layers : pdef.layers,
        activeLayerId: p.activeLayerId || null,
        styles: (p.styles && typeof p.styles === 'object') ? p.styles : {},
        settings: { ...pdef.settings, ...(p.settings || {}) },
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
      for (const el of this.planMarkup.elements) {
        const m = ELEM_MIGRATE[el.type];
        if (m) { el.type = m.type; if (m.props) el.props = { ...(el.props || {}), ...m.props }; }
      }
      for (const rt of this.planMarkup.routes) if (ROUTE_MIGRATE[rt.type]) rt.type = ROUTE_MIGRATE[rt.type];
      // Repair _seq so planGenId never collides with a loaded id
      let maxSeq = 0;
      const scanSeq = (a) => {
        for (const it of a) {
          const m = /_(\d+)$/.exec(String((it && it.id) || ''));
          if (m) maxSeq = Math.max(maxSeq, +m[1]);
        }
      };
      const pm = this.planMarkup;
      scanSeq(pm.plans); scanSeq(pm.elements); scanSeq(pm.routes);
      scanSeq(pm.trenches); scanSeq(pm.crossings); scanSeq(pm.rooms);
      scanSeq(pm.texts); scanSeq(pm.measurements);
      pm._seq = Math.max(pm._seq, maxSeq + 1);
      // Drop dangling reticId backrefs (defensive against hand-edited files)
      const reticIds = new Set([
        ...this.reticulation.minisubs.map(m => m.id),
        ...this.reticulation.kiosks.map(k => k.id),
        ...this.reticulation.kiosks.flatMap(k => (k.erfs || []).map(e => e.id)),
      ]);
      for (const el of pm.elements) {
        if (el.reticId && !reticIds.has(el.reticId)) el.reticId = null;
      }
    }
    // Restore annotation badge positions
    if (data.annotationOffsets && typeof Annotations !== 'undefined') {
      Annotations.offsets.clear();
      for (const [key, val] of Object.entries(data.annotationOffsets)) {
        Annotations.offsets.set(key, val);
      }
    }
    // Restore analysis results so result boxes appear on load
    this.faultResults = data.faultResults || null;
    this.faultedBusId = data.faultedBusId || null;
    this.loadFlowResults = data.loadFlowResults || null;
    this.unbalancedLoadFlowResults = data.unbalancedLoadFlowResults || null;
    this.arcFlashResults = data.arcFlashResults || null;
    this.dcArcFlashResults = data.dcArcFlashResults || null;
    this.cableSizingResults = data.cableSizingResults || null;
    this.motorStartingResults = data.motorStartingResults || null;
    this.dutyCheckResults = data.dutyCheckResults || null;
    this.loadDiversityResults = data.loadDiversityResults || null;
    this.groundingResults = data.groundingResults || null;
    this.studyManagerResults = data.studyManagerResults || null;
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
