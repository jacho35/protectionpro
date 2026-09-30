/* ProtectionPro — Cable sizing bus focus.
 *
 * A busy diagram carries a cable-sizing result box on every cable. Focus mode
 * shows only the cables at ONE bus (or board): the incoming ones (source side,
 * the result's from_bus is the far end) and the outgoing ones (to_bus is the
 * far end). The focused bus follows the diagram selection — select another bus
 * and the focus moves; selecting a cable or empty canvas keeps the last bus.
 * Everything else on the sheet is dimmed. Session-only: not saved with the
 * project.
 */

const CableFocus = {
  active: false,
  busId: null,

  BUS_TYPES: new Set(['bus', 'distribution_board']),
  // Devices a cable reaches its bus through (mirrors Components.cableEndpointBuses)
  TRANSPARENT: new Set(['cb', 'switch', 'changeover', 'fuse', 'ct', 'pt', 'surge_arrester',
                        'offpage_connector', 'bus_duct']),

  isBus(comp) { return !!comp && this.BUS_TYPES.has(comp.type); },

  // True while the cable result boxes are filtered to one bus.
  filtering() {
    return this.active && !!this.busId && AppState.components.has(this.busId);
  },

  // Pick up the selected bus (called at the top of every Canvas.render).
  syncFromSelection() {
    if (this.busId && !AppState.components.has(this.busId)) this.busId = null;
    if (!this.active || AppState.selectedIds.size !== 1) return;
    const comp = AppState.components.get([...AppState.selectedIds][0]);
    if (this.isBus(comp)) this.busId = comp.id;
  },

  enable(busId) {
    this.active = true;
    if (busId) this.busId = busId;
    else this.syncFromSelection();
    this._refresh();
  },

  disable() {
    if (!this.active) return;
    this.active = false;
    this._refresh();
  },

  toggle(busId) { if (this.active && (!busId || busId === this.busId)) this.disable(); else this.enable(busId); },

  _refresh() {
    Canvas.render();
    if (typeof syncCableFocusButtons === 'function') syncCableFocusButtons();
  },

  // Bus ids at a cable result's two ends. New results carry the ids; older
  // (saved) ones only carry names, so match those against the buses.
  cableEnds(res) {
    if (res.from_bus_id !== undefined || res.to_bus_id !== undefined) {
      return { fromId: res.from_bus_id || null, toId: res.to_bus_id || null };
    }
    const byName = (name) => {
      if (!name) return null;
      if (AppState.components.has(name)) return name;
      for (const c of AppState.components.values()) {
        if (this.isBus(c) && (c.props?.name || c.id) === name) return c.id;
      }
      return null;
    };
    return { fromId: byName(res.from_bus), toId: byName(res.to_bus) };
  },

  SOURCES: new Set(['utility', 'generator', 'transformer', 'autotransformer', 'solar_pv',
                     'wind_turbine', 'battery', 'ups']),

  // A cable with a bus at one end only (fed straight from a transformer, or
  // feeding a load with no busbar): the first real component on the other
  // side, walking through switchgear. Returns its id or null.
  _nonBusEnd(cableId, busId) {
    const adj = new Map();
    for (const w of Components.topologyWires()) {
      if (!adj.has(w.fromComponent)) adj.set(w.fromComponent, []);
      if (!adj.has(w.toComponent)) adj.set(w.toComponent, []);
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }
    const seen = new Set([cableId, busId]);
    const queue = [...(adj.get(cableId) || [])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const c = AppState.components.get(id);
      if (!c) continue;
      if (!this.TRANSPARENT.has(c.type)) return id;
      queue.push(...(adj.get(id) || []));
    }
    return null;
  },

  // Cable results at a bus, each with dir 'in' | 'out' and the far-end id
  // (a bus, or the source / load at a bus-less end).
  cablesAt(busId, results = AppState.cableSizingResults) {
    const out = [];
    if (!busId || !results || !results.cables) return out;
    const real = (id) => (id && id.startsWith('__term__') ? id.slice(8) : id) || null;
    for (const c of results.cables) {
      const { fromId, toId } = this.cableEnds(c);
      if (toId === busId) out.push({ cable: c, dir: 'in', otherId: real(fromId) });
      else if (fromId === busId) {
        let otherId = real(toId), dir = 'out';
        if (!otherId) {
          // One-bus cable: the backend lists that bus as from_bus whichever
          // side it is on, so read the direction off the other end
          otherId = this._nonBusEnd(c.cable_id, busId);
          const other = otherId && AppState.components.get(otherId);
          if (other && this.SOURCES.has(other.type)) dir = 'in';
        }
        out.push({ cable: c, dir, otherId });
      }
    }
    return out;
  },

  // Map cable_id → 'in' | 'out' for the focused bus (null when not filtering).
  focusDirections() {
    if (!this.filtering()) return null;
    const m = new Map();
    for (const e of this.cablesAt(this.busId)) m.set(e.cable.cable_id, e.dir);
    return m;
  },

  // Components kept at full strength: the bus, its cables and far-end buses,
  // and the switchgear between them.
  _focusComponentIds() {
    const keep = new Set([this.busId]);
    const cableIds = new Set(this.cablesAt(this.busId).map(e => e.cable.cable_id));
    const adj = new Map();
    for (const w of Components.topologyWires()) {
      if (!adj.has(w.fromComponent)) adj.set(w.fromComponent, []);
      if (!adj.has(w.toComponent)) adj.set(w.toComponent, []);
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }
    // Walk out from the bus through switchgear and the focus cables; stop at
    // the next bus. A path that dead-ends without a focus cable is dropped.
    const walk = (startId, path, seen) => {
      for (const nid of adj.get(startId) || []) {
        if (seen.has(nid)) continue;
        const c = AppState.components.get(nid);
        if (!c) continue;
        if (this.isBus(c)) {
          if (path.some(id => cableIds.has(id))) { keep.add(nid); path.forEach(id => keep.add(id)); }
          continue;
        }
        if (c.type === 'cable' ? !cableIds.has(nid) : !this.TRANSPARENT.has(c.type)) {
          // A cable-fed load with no terminal bus still ends a focus cable
          if (path.some(id => cableIds.has(id))) { keep.add(nid); path.forEach(id => keep.add(id)); }
          continue;
        }
        seen.add(nid);
        walk(nid, [...path, nid], seen);
      }
    };
    walk(this.busId, [], new Set([this.busId]));
    for (const id of cableIds) keep.add(id);
    return keep;
  },

  // Called by Canvas.render after components and wires are drawn.
  applyDimming(componentsLayer, wiresLayer) {
    this._renderBar();
    if (!this.filtering()) return;
    const keep = this._focusComponentIds();
    for (const el of componentsLayer.querySelectorAll('[data-id]')) {
      if (!keep.has(el.dataset.id)) el.classList.add('cf-dim');
      else if (AppState.components.get(el.dataset.id)?.type === 'cable') el.classList.add('cf-cable');
    }
    for (const el of componentsLayer.querySelectorAll('.sld-group, .sld-group-label')) el.classList.add('cf-dim');
    for (const el of wiresLayer.querySelectorAll('[data-id]')) {
      const w = AppState.wires.get(el.dataset.id);
      if (!w || !keep.has(w.fromComponent) || !keep.has(w.toComponent)) el.classList.add('cf-dim');
    }
  },

  // The floating bar at the foot of the canvas while focus mode is on.
  _renderBar() {
    let bar = document.getElementById('cable-focus-bar');
    if (!this.active || !AppState.cableSizingResults || !AppState.showResultBoxes.cable) {
      if (bar) bar.style.display = 'none';
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cable-focus-bar';
      bar.className = 'cable-focus-bar';
      bar.setAttribute('role', 'status');
      document.getElementById('canvas-container').appendChild(bar);
      bar.addEventListener('click', (e) => {
        if (e.target.closest('[data-cf-action="all"]')) this.disable();
      });
    }
    const icon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.5"/><path d="M8 .5v3M8 12.5v3M.5 8h3M12.5 8h3"/></svg>';
    let text;
    if (this.filtering()) {
      const bus = AppState.components.get(this.busId);
      const at = this.cablesAt(this.busId);
      const nIn = at.filter(e => e.dir === 'in').length;
      const hidden = (AppState.cableSizingResults.cables || []).length - at.length;
      text = `<span class="cf-title">Cables at ${escHtml(bus.props?.name || bus.id)}</span>
        <span class="cf-counts">${nIn} incoming · ${at.length - nIn} outgoing · ${hidden} hidden</span>`;
    } else {
      text = '<span class="cf-title">Cable focus</span><span class="cf-counts">Select a bus to show only its cables</span>';
    }
    bar.innerHTML = `${icon}${text}<span class="cf-spacer"></span><kbd>Esc</kbd>
      <button type="button" data-cf-action="all">Show all cables</button>`;
    bar.style.display = '';
  },
};
