/* ProtectionPro — Application State */

const AppState = {
  // Project
  projectId: null,
  projectName: 'Untitled Project',
  dirty: false,

  // Project details for report covers
  projectDetails: {
    projectNumber: '',
    clientCompany: '',
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
  showDeviceLabels: false,
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

  // Generate unique ID
  genId(prefix) {
    return `${prefix}_${this.nextId++}`;
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
    for (const id of this.selectedIds) {
      if (this.components.has(id)) {
        this.removeComponent(id);
      } else if (this.wires.has(id)) {
        this.removeWire(id);
      }
    }
    this.selectedIds.clear();
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

  // Paste clipboard contents with an offset
  pasteClipboard() {
    if (!this.clipboard || this.clipboard.components.length === 0) return;
    const offset = 40; // paste offset in world coords
    const idMap = new Map(); // old id -> new id
    this.clearSelection();
    // Paste components
    for (const comp of this.clipboard.components) {
      const newId = this.genId(comp.type);
      idMap.set(comp.id, newId);
      const newComp = {
        ...comp,
        id: newId,
        x: comp.x + offset,
        y: comp.y + offset,
        props: { ...comp.props, name: comp.props.name + ' copy' },
      };
      this.components.set(newId, newComp);
      this.selectedIds.add(newId);
    }
    // Paste wires with remapped IDs
    for (const wire of this.clipboard.wires) {
      const newFrom = idMap.get(wire.fromComponent);
      const newTo = idMap.get(wire.toComponent);
      if (newFrom && newTo) {
        this.addWire(newFrom, wire.fromPort, newTo, wire.toPort);
      }
    }
    this.dirty = true;
    // Snapshot is already taken by addWire/addComponent calls above
  },

  // Save current network configuration as a scenario
  saveScenario(name, description = '') {
    const id = `scenario_${this._scenarioNextId++}`;
    const scenario = {
      id,
      name,
      description,
      timestamp: new Date().toISOString(),
      components: JSON.parse(JSON.stringify([...this.components.values()])),
      wires: JSON.parse(JSON.stringify([...this.wires.values()])),
      nextId: this.nextId,
    };
    this.scenarios.push(scenario);
    this.dirty = true;
    return scenario;
  },

  // Load a scenario, replacing current network configuration
  loadScenario(scenarioId) {
    const scenario = this.scenarios.find(s => s.id === scenarioId);
    if (!scenario) return false;
    this.components.clear();
    this.wires.clear();
    this.selectedIds.clear();
    this.faultResults = null;
    this.faultedBusId = null;
    this.loadFlowResults = null;
    this.unbalancedLoadFlowResults = null;
    this.arcFlashResults = null;
    for (const c of scenario.components) {
      this.components.set(c.id, JSON.parse(JSON.stringify(c)));
    }
    for (const w of scenario.wires) {
      this.wires.set(w.id, JSON.parse(JSON.stringify(w)));
    }
    this.nextId = scenario.nextId;
    this.dirty = true;
    return true;
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

  // Clear all results
  clearResults() {
    this.faultResults = null;
    this.faultedBusId = null;
    this.loadFlowResults = null;
    this.unbalancedLoadFlowResults = null;
    this.arcFlashResults = null;
  },

  // Reset entire state
  reset() {
    this.projectId = null;
    this.projectName = 'Untitled Project';
    this.dirty = false;
    this.projectDetails = {
      projectNumber: '', clientCompany: '', engineerName: '',
      checkedBy: '', approvedBy: '', revisionNumber: '',
      date: '', description: '', companyLogo: null,
    };
    this.components.clear();
    this.wires.clear();
    this.nextId = 1;
    this.selectedIds.clear();
    this.faultResults = null;
    this.faultedBusId = null;
    this.loadFlowResults = null;
    this.unbalancedLoadFlowResults = null;
    this.arcFlashResults = null;
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
  },

  // Export to JSON
  toJSON() {
    return {
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
      annotationOffsets: Annotations.offsets.size > 0
        ? Object.fromEntries(Annotations.offsets)
        : undefined,
    };
  },

  // Import from JSON
  fromJSON(data) {
    this.reset();
    this.projectName = data.projectName || 'Untitled Project';
    if (data.projectDetails) {
      this.projectDetails = {
        projectNumber: data.projectDetails.projectNumber || '',
        clientCompany: data.projectDetails.clientCompany || '',
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
    this.nextId = data.nextId || 1;
    this.scenarios = data.scenarios || [];
    this._scenarioNextId = this.scenarios.length > 0
      ? Math.max(...this.scenarios.map(s => parseInt(s.id.replace('scenario_', '')) || 0)) + 1
      : 1;
    for (const c of data.components || []) {
      this.components.set(c.id, c);
    }
    for (const w of data.wires || []) {
      this.wires.set(w.id, w);
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
    // Restore annotation badge positions
    if (data.annotationOffsets && typeof Annotations !== 'undefined') {
      Annotations.offsets.clear();
      for (const [key, val] of Object.entries(data.annotationOffsets)) {
        Annotations.offsets.set(key, val);
      }
    }
    this.dirty = false;
  },
};

// Snap coordinate to grid
function snapToGrid(val) {
  return Math.round(val / SNAP_SIZE) * SNAP_SIZE;
}
