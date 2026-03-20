/* ProtectionPro — Application State */

const AppState = {
  // Project
  projectId: null,
  projectName: 'Untitled Project',
  dirty: false,

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

  // Clipboard for copy/paste
  clipboard: null, // { components: [], wires: [] }

  // Analysis results
  faultResults: null,
  loadFlowResults: null,

  // Scenarios — saved snapshots of network configuration
  scenarios: [],  // [{id, name, description, timestamp, components, wires, nextId}]
  _scenarioNextId: 1,

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
  addWire(fromComp, fromPort, toComp, toPort) {
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
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
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
    this.loadFlowResults = null;
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

  // Clear all results
  clearResults() {
    this.faultResults = null;
    this.loadFlowResults = null;
  },

  // Reset entire state
  reset() {
    this.projectId = null;
    this.projectName = 'Untitled Project';
    this.dirty = false;
    this.components.clear();
    this.wires.clear();
    this.nextId = 1;
    this.selectedIds.clear();
    this.faultResults = null;
    this.loadFlowResults = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.mode = MODE.SELECT;
    this.placingType = null;
    this.wireStart = null;
    this.dragState = null;
    this.scenarios = [];
    this._scenarioNextId = 1;
  },

  // Export to JSON
  toJSON() {
    return {
      projectName: this.projectName,
      baseMVA: this.baseMVA,
      frequency: this.frequency,
      defaultLengthUnit: this.defaultLengthUnit,
      components: [...this.components.values()],
      wires: [...this.wires.values()],
      nextId: this.nextId,
      scenarios: this.scenarios,
      annotationOffsets: Annotations.offsets.size > 0
        ? Object.fromEntries(Annotations.offsets)
        : undefined,
    };
  },

  // Import from JSON
  fromJSON(data) {
    this.reset();
    this.projectName = data.projectName || 'Untitled Project';
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
