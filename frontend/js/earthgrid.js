/* ProtectionPro — Earth grids of any shape (project level).
 *
 * AppState.earthGrids holds named earth grid objects: soil, surface layer,
 * conductor, a layout generator (rectangle / L-shape, equal or uneven spacing,
 * diagonals), a rod rule, fences (bonded or separately earthed), conductors
 * and rods added by hand, the calculation method and the limit basis. A bus
 * uses one through its `earth_grid_id` prop; a bus without one keeps its own
 * flat IEEE 80 fields (grounding_system.py's per-bus path, unchanged).
 *
 * This file is the editor (#earth-grid-modal: rail of grids | form | live
 * plan from POST /analysis/earth-grid/preview, with a 3-D view and tools to
 * place conductors and rods by clicking the plan) and the grounding results
 * card for a bus on an earth grid (plan with the touch-voltage heatmap).
 *
 * The editor works on a copy of the grids (and of the buses' grid choices):
 * nothing reaches the project until Save, and closing with unsaved changes
 * asks before discarding them.
 * Geometry and every number come from the backend — nothing is recomputed
 * here except which map points fall inside the touch area.
 */

const EarthGridEditor = {
  activeId: null,     // grid shown in the editor
  busId: null,        // bus the editor was opened from (Create from bus / Use for bus)
  _bound: false,
  _previewTimer: null,
  _previewSeq: 0,
  _lastPreview: null,
  _work: null,        // working copy of the grids while the editor is open
  _busMap: null,      // bus id → earth grid id (null = none) chosen in the editor, not yet saved
  _base: '',          // _stateJson() as last opened / saved — dirty = differs
  view: 'plan',       // 'plan' | '3d'
  tool: null,         // null | 'conductor' | 'rod' — click-to-add on the plan
  _pend: null,        // [x, y] start of the conductor being drawn

  // Defaults for a new grid — the same values as a new bus's grounding fields
  // (COMPONENT_DEFS.bus.defaults), so "Create from bus" and "New" agree.
  DEFAULT: {
    soil: { rho1: 100, two_layer: 'off', rho2: 100, h1: 3.0 },
    surface: { rho_s: 2500, h_s: 0.15 },
    conductor: { material: 'copper_hard', area_mm2: 70, depth_m: 0.5, joint: 'exothermic' },
    layout: { type: 'rect', length_x: 30, width_y: 30, n_x: 6, n_y: 6, x_lines: null, y_lines: null,
      notch_x: 15, notch_y: 15, diagonals: 'none' },
    rods: { rule: 'perimeter_even', count: 20, length_m: 3.0, diameter_m: 0.016 },
    fences: [],
    extra_conductors: [],
    extra_rods: [],
    method: 'auto',
    limits: 'ieee80',
    body_weight: 70,
    en50522: { footwear_ohm: 0, hand_ohm: 0, measures_m: 'no' },
    ieee80: { footwear_ohm: 0 },
    element_length_m: 1.0,
  },

  FENCE_DEFAULT: { name: 'Fence', offset_m: 2.0, bonded: true, post_spacing_m: 3.0, post_depth_m: 0.8,
    post_diameter_m: 0.05, conductor_offset_m: null, conductor_depth_m: 0.5 },

  JOINTS: [
    { value: 'exothermic', label: 'Exothermic (welded)' },
    { value: 'brazed', label: 'Brazed (450 °C)' },
    { value: 'pressure', label: 'Pressure connector (350 °C)' },
    { value: 'bolted', label: 'Bolted (250 °C)' },
  ],

  // ── Data ───────────────────────────────────────────────────────────
  // The working copy while the editor is open, else the project's grids.
  list() {
    if (this._work) return this._work;
    if (!Array.isArray(AppState.earthGrids)) AppState.earthGrids = [];
    return AppState.earthGrids;
  },
  get(id) { return this.list().find(g => g.id === id) || null; },
  current() { return this.get(this.activeId) || this.list()[0] || null; },
  // A bus's grid, counting a choice made in the editor but not yet saved.
  gridIdOf(bus) {
    return this._busMap && this._busMap.has(bus.id) ? this._busMap.get(bus.id) : (bus.props.earth_grid_id || null);
  },
  busesUsing(id) {
    return [...AppState.components.values()].filter(c => c.type === 'bus' && c.props && this.gridIdOf(c) === id);
  },

  _clone(o) { return JSON.parse(JSON.stringify(o)); },
  _genId() {
    const used = new Set(this.list().map(g => g.id));
    let n = this.list().length + 1;
    while (used.has('eg_' + n)) n++;
    return 'eg_' + n;
  },
  _nextName(base = 'Earth grid') {
    const names = new Set(this.list().map(g => g.name));
    let n = this.list().length + 1;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  },

  // Fill any missing part of a grid from the defaults (older / hand-edited
  // objects) so the form never reads through undefined. Values present stay.
  _normalize(g) {
    const D = this.DEFAULT;
    // A grid saved with only a diameter: its solid-equivalent size (0.01 mm²),
    // so the engine's √(4A/π) gives the same diameter back.
    const c = g.conductor;
    if (c && typeof c === 'object' && c.area_mm2 == null && Number.isFinite(+c.diameter_m) && +c.diameter_m > 0) {
      c.area_mm2 = Math.round(Math.PI / 4 * Math.pow(+c.diameter_m * 1000, 2) * 100) / 100;
      delete c.diameter_m;
    }
    for (const k of ['soil', 'surface', 'conductor', 'layout', 'rods', 'en50522', 'ieee80']) {
      g[k] = Object.assign(this._clone(D[k]), (g[k] && typeof g[k] === 'object') ? g[k] : {});
    }
    for (const k of ['fences', 'extra_conductors', 'extra_rods']) if (!Array.isArray(g[k])) g[k] = [];
    for (const k of ['method', 'limits', 'body_weight', 'element_length_m']) if (g[k] == null) g[k] = D[k];
    if (!g.name) g.name = g.id;
    return g;
  },

  create(name, from) {
    const g = this._normalize(Object.assign(this._clone(from || this.DEFAULT), { id: this._genId(), name }));
    this.list().push(g);
    this.activeId = g.id;
    this._changed(true);
    return g;
  },

  // A grid that reproduces a bus's per-bus (legacy) grounding fields exactly:
  // same rectangle, mesh, rods, soil, surface layer, conductor and body weight.
  fromBus(bus) {
    const d = (COMPONENT_DEFS.bus && COMPONENT_DEFS.bus.defaults) || {};
    const p = bus.props || {};
    const v = (k, fb) => {
      const x = p[k] ?? d[k];
      const n = parseFloat(x);
      return Number.isFinite(n) ? n : fb;
    };
    const s = (k, fb) => (p[k] ?? d[k] ?? fb);
    return {
      soil: { rho1: v('soil_resistivity', 100), two_layer: s('two_layer_soil', 'off') === 'on' ? 'on' : 'off',
        rho2: v('soil_resistivity_lower', 100), h1: v('upper_layer_thickness', 3.0) },
      surface: { rho_s: v('crushed_rock_resistivity', 2500), h_s: v('crushed_rock_depth', 0.15) },
      conductor: { material: s('conductor_material', 'copper_hard'), area_mm2: this._busArea(p, d),
        depth_m: v('grid_depth', 0.5), joint: s('grid_joint_type', 'exothermic') },
      layout: { type: 'rect', length_x: v('grid_length', 30), width_y: v('grid_width', 30),
        n_x: Math.round(v('num_conductors_x', 6)), n_y: Math.round(v('num_conductors_y', 6)),
        x_lines: null, y_lines: null, notch_x: v('grid_length', 30) / 2, notch_y: v('grid_width', 30) / 2, diagonals: 'none' },
      rods: { rule: 'perimeter_even', count: Math.round(v('num_ground_rods', 20)), length_m: v('ground_rod_length', 3.0), diameter_m: 0.016 },
      fences: [], extra_conductors: [], extra_rods: [],
      method: 'auto', limits: 'ieee80', body_weight: v('body_weight', 70) === 50 ? 50 : 70,
      en50522: { footwear_ohm: 0, hand_ohm: 0, measures_m: 'no' },
      ieee80: { footwear_ohm: 0 },
      element_length_m: 1.0,
    };
  },

  // A bus's conductor size (mm²); an older bus with only a diameter gets its
  // solid-equivalent size (0.01 mm²).
  _busArea(p, d) {
    const a = parseFloat(p.conductor_area_mm2);
    if (Number.isFinite(a) && a > 0) return a;
    const dia = parseFloat(p.conductor_diameter);
    if (Number.isFinite(dia) && dia > 0) return Math.round(Math.PI / 4 * Math.pow(dia * 1000, 2) * 100) / 100;
    const da = parseFloat(d.conductor_area_mm2);
    return Number.isFinite(da) && da > 0 ? da : 70;
  },

  // Results: the grid conductor against the size the fault current needs
  // (Onderdonk); older results without a selected size show the recommendation.
  conductorHtml(b) {
    const min = b.min_conductor_mm2 != null ? (+b.min_conductor_mm2).toFixed(1) : null;
    if (b.conductor_area_mm2 != null) {
      const a = +(+b.conductor_area_mm2).toPrecision(4);
      const ok = b.conductor_ok !== false;
      return `<strong${ok ? '' : ' class="eg-bad"'}>${a} mm²</strong> <span class="eg-muted">(min ${min}${ok ? '' : `, use ${b.recommended_conductor_mm2}`})</span>`;
    }
    return `<strong>${b.recommended_conductor_mm2} mm²</strong>${min ? ` <span class="eg-muted">(min ${min})</span>` : ''}`;
  },

  // Standard bare-conductor sizes (mm²) offered in the size fields.
  SIZES_MM2: [16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300],

  // ── Working copy, dirty state, save ────────────────────────────────
  // Copy the project's grids into the editor; nothing is unsaved after this.
  _begin() {
    this._work = this._clone(Array.isArray(AppState.earthGrids) ? AppState.earthGrids : []);
    this._work.forEach(g => this._normalize(g));
    this._busMap = new Map();
    this._base = this._stateJson();
  },
  // The editor's state, with bus choices that equal the saved ones left out
  // (so choosing a grid and choosing back again is not a change).
  _stateJson() {
    const buses = [...(this._busMap || new Map())].filter(([bid, id]) => {
      const b = AppState.components.get(bid);
      return b && (b.props.earth_grid_id || null) !== (id || null);
    }).sort();
    return JSON.stringify([this._work, buses]);
  },
  isDirty() { return !!this._work && this._stateJson() !== this._base; },

  // An edit happened — refresh the unsaved-changes state.
  _changed() { this._updateDirty(); },

  _updateDirty() {
    const dirty = this.isDirty();
    const ind = this._el('eg-dirty');
    if (ind) ind.hidden = !dirty;
    for (const id of ['btn-eg-save', 'btn-eg-revert']) { const b = this._el(id); if (b) b.disabled = !dirty; }
    const m = this._el('earth-grid-modal');
    if (m) m.classList.toggle('eg-is-dirty', dirty);
  },

  // Write the working copy to the project: one undo step, stale grounding
  // results dropped.
  save() {
    if (!this._work) return;
    if (!this.isDirty()) return;
    AppState.earthGrids = this._clone(this._work);
    for (const [bid, id] of this._busMap) {
      const b = AppState.components.get(bid);
      if (!b) continue;
      if (id) b.props.earth_grid_id = id; else delete b.props.earth_grid_id;
    }
    this._busMap.clear();
    AppState.dirty = true;
    if (AppState.groundingResults) AppState.groundingResults = null;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    this._base = this._stateJson();
    this._updateDirty();
    this._refreshProps();
    const st = document.getElementById('status-info');
    if (st) st.textContent = 'Earth grids saved.';
  },

  async revert() {
    if (!this.isDirty()) return;
    if (!(await UI.confirm('Discard the unsaved changes to the earth grids?', { danger: true, okText: 'Discard' }))) return;
    this._begin();
    this._pend = null;
    if (!this.get(this.activeId)) this.activeId = (this.list()[0] || {}).id || null;
    this.render();
  },

  _refreshProps() {
    if (typeof Properties !== 'undefined' && Properties.currentId && AppState.components.has(Properties.currentId)) {
      Properties.show(Properties.currentId);
    }
  },

  // Undo/redo replaced AppState.earthGrids. With nothing unsaved, show what
  // is there now; unsaved edits are kept (Save still writes them).
  onStateRestored() {
    if (!this._isOpen() || this.isDirty()) return;
    this._begin();
    if (!this.get(this.activeId)) this.activeId = (this.list()[0] || {}).id || null;
    this.render();
  },

  // ── Modal ──────────────────────────────────────────────────────────
  _el(id) { return document.getElementById(id); },
  _isOpen() { const m = this._el('earth-grid-modal'); return !!m && m.style.display !== 'none'; },

  open(opts = {}) {
    this._bind();
    if (this._isOpen()) return;
    this.busId = opts.busId || null;
    this._begin();
    this._pend = null;
    const bus = this.busId ? AppState.components.get(this.busId) : null;
    if (bus && bus.props.earth_grid_id && this.get(bus.props.earth_grid_id)) this.activeId = bus.props.earth_grid_id;
    if (!this.get(this.activeId)) this.activeId = (this.list()[0] || {}).id || null;
    this._el('earth-grid-modal').style.display = '';
    this.render();
    this._updateDirty();
  },

  // Close; with unsaved changes, ask first (Cancel keeps the editor open).
  async close() {
    if (!this._isOpen()) return;
    if (this.isDirty()) {
      if (!(await UI.confirm('The earth grids have unsaved changes. Close and discard them?',
        { danger: true, okText: 'Discard changes', cancelText: 'Keep editing' }))) return;
    }
    this._el('earth-grid-modal').style.display = 'none';
    clearTimeout(this._previewTimer);
    this._work = null;
    this._busMap = null;
    this._pend = null;
    this._stop3d();
    // The bus panel lists the grids by name — refresh it.
    this._refreshProps();
  },

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const m = this._el('earth-grid-modal');
    this._el('btn-close-earth-grid').addEventListener('click', () => this.close());
    this._el('btn-eg-save').addEventListener('click', () => this.save());
    this._el('btn-eg-revert').addEventListener('click', () => this.revert());
    m.addEventListener('click', (e) => { if (e.target === m) this.close(); });
    m.addEventListener('keydown', (e) => {
      // Ctrl+S saves the grids (not the project) while the editor is open
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); e.stopPropagation();
        this.save();
        return;
      }
      if (e.key !== 'Escape' || e.target.closest('.gt-grid')) return;
      e.stopPropagation();          // the app's Escape would hide the modal without asking
      if (this._pend) { this._pend = null; this._drawEditOverlay(); return; }
      if (this.tool) { this._setTool(null); return; }
      this.close();
    });
    this._bindPreview();

    this._el('eg-rail').addEventListener('click', (e) => {
      const item = e.target.closest('[data-eg-pick]');
      if (item) { this.activeId = item.dataset.egPick; this.render(); return; }
      const act = e.target.closest('[data-eg-act]');
      if (act) this._railAction(act.dataset.egAct);
    });

    this._el('eg-rail').addEventListener('change', (e) => {
      if (e.target.classList.contains('eg-rail-select')) { this.activeId = e.target.value; this.render(); }
    });

    const form = this._el('eg-form');
    form.addEventListener('input', (e) => this._onInput(e, false));
    form.addEventListener('change', (e) => this._onInput(e, true));
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eg-row-add], [data-eg-row-del]');
      if (!b) return;
      const g = this.current();
      if (!g) return;
      if (b.dataset.egRowAdd) this._addRow(g, b.dataset.egRowAdd);
      else {
        const [list, idx] = b.dataset.egRowDel.split(':');
        g[list].splice(+idx, 1);
        this._renderTable(list);
        this._changed(true);
        this._schedulePreview();
      }
    });
    // Section open/closed state survives re-renders
    form.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.dataset && d.dataset.egSec) this._openSecs[d.dataset.egSec] = d.open;
    }, true);
  },
  _openSecs: { general: true, soil: true, layout: true, rods: true },

  async _railAction(act) {
    const g = this.current();
    if (act === 'new') {
      this.create(this._nextName());
      this.render();
    } else if (act === 'dup' && g) {
      const copy = this._clone(g);
      delete copy.id;
      this.create(`${g.name} (copy)`, copy);
      this.render();
    } else if (act === 'del' && g) {
      const users = this.busesUsing(g.id);
      const who = users.length ? ` ${users.length} bus${users.length > 1 ? 'es use' : ' uses'} it and will go back to ${users.length > 1 ? 'their' : 'its'} own grounding fields.` : '';
      if (!(await UI.confirm(`Delete the earth grid “${g.name}”?${who}`, { danger: true, okText: 'Delete' }))) return;
      this._work.splice(this._work.indexOf(g), 1);
      for (const b of users) this._busMap.set(b.id, null);
      this.activeId = (this.list()[0] || {}).id || null;
      this._changed(true);
      this.render();
    } else if (act === 'from-bus') {
      const bus = AppState.components.get(this.busId);
      if (!bus) return;
      const g2 = this.create(`${bus.props.name || bus.id} grid`, this.fromBus(bus));
      this._busMap.set(bus.id, g2.id);
      this._changed(true);
      this.render();
    } else if (act === 'use' && g) {
      const bus = AppState.components.get(this.busId);
      if (!bus) return;
      this._busMap.set(bus.id, g.id);
      this._changed(true);
      this.render();
    }
  },

  // ── Render ─────────────────────────────────────────────────────────
  render() {
    this._renderRail();
    const g = this.current();
    this.activeId = g ? g.id : null;
    const form = this._el('eg-form');
    if (!g) {
      form.innerHTML = `<div class="eg-empty">
        <p>No earth grids in this project yet.</p>
        <p class="eg-muted">An earth grid can have any shape — diagonals, uneven spacing, an L-shape, rods anywhere,
        bonded or separately-earthed fences — and one or more buses can use it through their <b>Earth Grid</b> field.</p>
        <button type="button" class="btn btn-primary" data-eg-act-empty="new">New earth grid</button>
        ${this._bus() && !this.gridIdOf(this._bus()) ? '<button type="button" class="btn btn-secondary" data-eg-act-empty="from-bus">Create from bus</button>' : ''}
      </div>`;
      form.querySelectorAll('[data-eg-act-empty]').forEach(b => b.addEventListener('click', () => this._railAction(b.dataset.egActEmpty)));
      this._el('eg-preview').innerHTML = '';
      return;
    }
    form.innerHTML = this._formHtml(g);
    for (const t of ['fences', 'extra_conductors', 'extra_rods']) this._renderTable(t);
    this._applyVisibility(g);
    this._schedulePreview(0);
  },

  _bus() { return this.busId ? AppState.components.get(this.busId) : null; },

  _renderRail() {
    const rail = this._el('eg-rail');
    const cur = this.current();
    const bus = this._bus();
    const items = this.list().map(g => {
      const n = this.busesUsing(g.id).length;
      return `<button type="button" class="eg-rail-item${g === cur ? ' on' : ''}" data-eg-pick="${escHtml(g.id)}">
        <span class="eg-rail-name">${escHtml(g.name)}</span>
        <span class="eg-rail-sub">${escHtml(this._shapeText(g))}${n ? ` · ${n} bus${n > 1 ? 'es' : ''}` : ''}</span></button>`;
    }).join('');
    let ctx = '';
    if (bus) {
      const busName = escHtml(bus.props.name || bus.id);
      const busGrid = this.gridIdOf(bus);
      if (!busGrid) {
        ctx = `<div class="eg-ctx"><span>Opened from <b>${busName}</b>, which uses its own grounding fields.</span>
          <button type="button" class="lr-mini" data-eg-act="from-bus" title="Make an earth grid from this bus's grid, soil, surface, conductor and rod fields — gives the same result — and use it for the bus">Create from bus</button>
          ${cur ? `<button type="button" class="lr-mini" data-eg-act="use">Use “${escHtml(cur.name)}”</button>` : ''}</div>`;
      } else if (cur && busGrid !== cur.id) {
        ctx = `<div class="eg-ctx"><span><b>${busName}</b> uses “${escHtml((this.get(busGrid) || {}).name || busGrid)}”.</span>
          <button type="button" class="lr-mini" data-eg-act="use">Use “${escHtml(cur.name)}” instead</button></div>`;
      } else {
        ctx = `<div class="eg-ctx"><span><b>${busName}</b> uses this grid.</span></div>`;
      }
    }
    // Phones get a select instead of the list (CSS picks one)
    const pick = this.list().length ? `<select class="eg-rail-select" aria-label="Earth grid">${this.list().map(g =>
      `<option value="${escHtml(g.id)}"${g === cur ? ' selected' : ''}>${escHtml(g.name)}</option>`).join('')}</select>` : '';
    rail.innerHTML = `<div class="lr-nav-h">Earth grids</div>${pick}
      <div class="eg-rail-list">${items || '<div class="eg-muted" style="padding:0 8px">None yet</div>'}</div>
      <div class="eg-rail-acts">
        <button type="button" class="lr-mini" data-eg-act="new">New</button>
        <button type="button" class="lr-mini" data-eg-act="dup"${cur ? '' : ' disabled'}>Duplicate</button>
        <button type="button" class="lr-mini lr-mini-danger" data-eg-act="del"${cur ? '' : ' disabled'}>Delete</button>
      </div>${ctx}`;
  },

  _shapeText(g) {
    const L = g.layout || {};
    if (L.type === 'none') return 'Added conductors only';
    const shape = L.type === 'l' ? 'L-shape' : 'Rectangle';
    return `${shape} ${this._n(L.length_x)} × ${this._n(L.width_y)} m`;
  },
  _n(v, d) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '—';
    return d == null ? String(parseFloat(x.toPrecision(6))) : x.toFixed(d);
  },

  // Form definition — `p` is the path in the grid object; `show(g)` hides a
  // field (visibility is re-applied on every edit, without a re-render).
  _sections() {
    const mats = (typeof GROUNDING_CONDUCTOR_MATERIALS !== 'undefined' ? GROUNDING_CONDUCTOR_MATERIALS : [])
      .map(o => [o.value, o.label]);
    const two = g => g.soil.two_layer === 'on';
    const notNone = g => g.layout.type !== 'none';
    const rodsOn = g => g.rods.rule !== 'none';
    const ieee = g => g.limits !== 'en50522';
    return [
      { id: 'general', title: 'General', fields: [
        { p: 'name', label: 'Name', type: 'text' },
      ] },
      { id: 'soil', title: 'Soil', fields: [
        { p: 'soil.rho1', label: 'Soil resistivity ρ₁', unit: 'Ω·m', min: 0.01 },
        { p: 'soil.two_layer', label: 'Two-layer soil', type: 'select', options: [['off', 'Off — uniform soil'], ['on', 'On — ρ₁ over ρ₂']] },
        { p: 'soil.rho2', label: 'Lower layer ρ₂', unit: 'Ω·m', min: 0.01, show: two },
        { p: 'soil.h1', label: 'Upper layer thickness h₁', unit: 'm', min: 0.01, show: two },
      ] },
      { id: 'surface', title: 'Surface layer', fields: [
        { p: 'surface.rho_s', label: 'Surface layer resistivity ρ_s', unit: 'Ω·m', min: 0 },
        { p: 'surface.h_s', label: 'Surface layer depth h_s (0 = none)', unit: 'm', min: 0 },
      ] },
      { id: 'conductor', title: 'Conductor', fields: [
        { p: 'conductor.material', label: 'Material', type: 'select', options: mats },
        { p: 'conductor.area_mm2', label: 'Conductor size', unit: 'mm²', min: 1, sizes: true,
          hint: 'Cross-section of the bare conductor. Also checked against the minimum size the fault current needs.' },
        { p: 'conductor.diameter_m', label: 'Outside diameter', unit: 'mm', scale: 1000, min: 1, optional: true, advanced: true, ph: 'from size',
          hint: 'Blank = the solid-equivalent diameter of the size, √(4A/π) — slightly conservative. Enter a stranded conductor\'s measured diameter to use it instead.' },
        { p: 'conductor.depth_m', label: 'Burial depth', unit: 'm', min: 0.01 },
        { p: 'conductor.joint', label: 'Joints', type: 'select', options: this.JOINTS.map(o => [o.value, o.label]) },
      ] },
      { id: 'layout', title: 'Layout', fields: [
        { p: 'layout.type', label: 'Shape', type: 'select', options: [['rect', 'Rectangle'], ['l', 'L-shape'], ['none', 'None — added conductors only']] },
        { p: 'layout.length_x', label: 'Length (x)', unit: 'm', min: 0.1, show: notNone },
        { p: 'layout.width_y', label: 'Width (y)', unit: 'm', min: 0.1, show: notNone },
        { p: 'layout.n_x', label: 'Conductors across x', min: 2, step: 1, show: g => notNone(g) && !(g.layout.x_lines && g.layout.x_lines.length) },
        { p: 'layout.n_y', label: 'Conductors along y', min: 2, step: 1, show: g => notNone(g) && !(g.layout.y_lines && g.layout.y_lines.length) },
        { p: 'layout.x_lines', label: 'Uneven spacing — x positions', type: 'lines', unit: 'm', show: notNone,
          hint: 'Comma-separated positions of the conductors running along y, e.g. 0, 3, 8, 15, 22, 27, 30. Empty = equal spacing.' },
        { p: 'layout.y_lines', label: 'Uneven spacing — y positions', type: 'lines', unit: 'm', show: notNone,
          hint: 'Positions of the conductors running along x. Empty = equal spacing.' },
        { p: 'layout.notch_x', label: 'Notch starts at x', unit: 'm', min: 0, show: g => g.layout.type === 'l',
          hint: 'The rectangle beyond both notch lines (x > notch x and y > notch y) is cut away.' },
        { p: 'layout.notch_y', label: 'Notch starts at y', unit: 'm', min: 0, show: g => g.layout.type === 'l' },
        { p: 'layout.diagonals', label: 'Diagonal conductors', type: 'select', show: notNone, options: [
          ['none', 'None'], ['corner_meshes', 'Corner meshes'], ['all_meshes', 'Every mesh'], ['full', 'Full corner-to-corner']] },
      ] },
      { id: 'rods', title: 'Rods', fields: [
        { p: 'rods.rule', label: 'Placement', type: 'select', options: [
          ['none', 'No rods'], ['perimeter_even', 'Perimeter — evenly spaced (count)'], ['perimeter_nodes', 'Every perimeter crossing'],
          ['perimeter_alternate', 'Every other perimeter crossing'], ['corners', 'Corners only'], ['all_nodes', 'Every crossing']] },
        { p: 'rods.count', label: 'Number of rods', min: 0, step: 1, show: g => g.rods.rule === 'perimeter_even',
          hint: 'Corners first, then evenly spaced round the perimeter.' },
        { p: 'rods.length_m', label: 'Rod length', unit: 'm', min: 0.1, show: rodsOn },
        { p: 'rods.diameter_m', label: 'Rod diameter', unit: 'mm', scale: 1000, min: 1, show: rodsOn },
      ] },
      { id: 'fences', title: 'Fences', table: 'fences' },
      { id: 'extra_conductors', title: 'Added conductors', table: 'extra_conductors' },
      { id: 'extra_rods', title: 'Added rods', table: 'extra_rods' },
      { id: 'calc', title: 'Calculation', fields: [
        { p: 'method', label: 'Method', type: 'select', options: [
          ['auto', 'Auto — IEEE 80 where it applies, else numerical'], ['ieee80', 'IEEE 80 simplified equations'], ['numerical', 'Numerical (method of moments)']] },
        { p: 'limits', label: 'Limit basis', type: 'select', options: [['ieee80', 'IEEE 80 (body weight)'], ['en50522', 'EN 50522 (U_Tp)']] },
        { p: 'body_weight', label: 'Body weight', type: 'select', num: true, show: ieee, options: [[50, '50 kg'], [70, '70 kg']] },
        { p: 'ieee80.footwear_ohm', label: 'Footwear resistance (per foot)', unit: 'Ω', min: 0, show: ieee,
          hint: 'Each shoe, in series with that foot: adds R/2 to the touch limit\'s body circuit and 2R to the step limit\'s, as CDEGS SESThreshold does. 0 = IEEE 80 Eq. 29–33 as written.' },
        { p: 'en50522.footwear_ohm', label: 'Footwear resistance R_F1', unit: 'Ω', min: 0, show: g => !ieee(g) },
        { p: 'en50522.hand_ohm', label: 'Hand contact resistance', unit: 'Ω', min: 0, show: g => !ieee(g) },
        { p: 'en50522.measures_m', label: 'Specified measures M applied', type: 'select', show: g => !ieee(g), options: [['no', 'No'], ['yes', 'Yes']],
          hint: 'EN 50522 Annex E measures — with them, U_E ≤ 4·U_Tp meets the touch criterion.' },
        { p: 'element_length_m', label: 'Element length', unit: 'm', min: 0.2, max: 5, advanced: true,
          hint: 'Numerical method: conductors are cut into elements no longer than this. Shorter = finer, slower.' },
      ] },
    ];
  },

  TABLES: {
    fences: {
      hint: 'Offset: + outside the grid outline, − inside. Separately earthed fences float — their touch and transfer voltages are reported. Conductor offset blank = no buried fence conductor.',
      add: 'Add fence',
      cols: [
        { k: 'name', label: 'Name', type: 'text' },
        { k: 'offset_m', label: 'Offset (m)' },
        { k: 'bonded', label: 'Earthing', type: 'bond' },
        { k: 'post_spacing_m', label: 'Post spacing (m)', min: 0.1 },
        { k: 'post_depth_m', label: 'Post depth (m)', min: 0 },
        { k: 'post_diameter_m', label: 'Post Ø (mm)', scale: 1000, min: 1 },
        { k: 'conductor_offset_m', label: 'Conductor offset (m)', optional: true, ph: 'none' },
        { k: 'conductor_depth_m', label: 'Conductor depth (m)', min: 0.01 },
      ],
    },
    extra_conductors: {
      hint: 'Straight conductors in grid coordinates (m, origin at the lower-left corner). Depth / size blank = the grid conductor.',
      add: 'Add conductor',
      cols: [
        { k: 'x1', label: 'x₁' }, { k: 'y1', label: 'y₁' }, { k: 'x2', label: 'x₂' }, { k: 'y2', label: 'y₂' },
        { k: 'depth_m', label: 'Depth (m)', optional: true, ph: 'grid', min: 0.01 },
        { k: 'area_mm2', label: 'Size (mm²)', optional: true, ph: 'grid', min: 1 },
        { k: 'bonded', label: 'Earthing', type: 'bond' },
      ],
    },
    extra_rods: {
      hint: 'Rods at any point (m). Length / Ø blank = the rod settings above.',
      add: 'Add rod',
      cols: [
        { k: 'x', label: 'x' }, { k: 'y', label: 'y' },
        { k: 'length_m', label: 'Length (m)', optional: true, ph: 'rods', min: 0.1 },
        { k: 'diameter_m', label: 'Ø (mm)', scale: 1000, optional: true, ph: 'rods', min: 1 },
        { k: 'bonded', label: 'Earthing', type: 'bond' },
      ],
    },
  },

  _get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); },
  _set(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (const k of ks.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[ks[ks.length - 1]] = val;
  },

  _formHtml(g) {
    let html = '';
    for (const sec of this._sections()) {
      const open = this._openSecs[sec.id] ? ' open' : '';
      const count = sec.table ? ` <span class="eg-count" data-eg-count="${sec.table}">${g[sec.table].length || ''}</span>` : '';
      html += `<details class="eg-sec" data-eg-sec="${sec.id}"${open}><summary>${sec.title}${count}</summary><div class="eg-sec-body">`;
      if (sec.table) {
        const T = this.TABLES[sec.table];
        html += `<div class="eg-hint">${escHtml(T.hint)}</div>
          <div class="eg-table-wrap"><table class="eg-table data-table"><thead><tr>${T.cols.map(c => `<th>${escHtml(c.label)}</th>`).join('')}<th></th></tr></thead>
          <tbody data-eg-tbody="${sec.table}"></tbody></table></div>
          <button type="button" class="lr-mini" data-eg-row-add="${sec.table}">+ ${T.add}</button>`;
      } else {
        const plain = sec.fields.filter(f => !f.advanced);
        const adv = sec.fields.filter(f => f.advanced);
        html += `<div class="eg-fields">${plain.map(f => this._fieldHtml(g, f)).join('')}</div>`;
        if (adv.length) {
          html += `<details class="eg-adv"><summary>Advanced</summary><div class="eg-fields">${adv.map(f => this._fieldHtml(g, f)).join('')}</div></details>`;
        }
      }
      html += '</div></details>';
    }
    return html;
  },

  _fieldHtml(g, f) {
    const v = this._get(g, f.p);
    const id = 'eg-f-' + f.p.replace(/\./g, '-');
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}" data-eg-p="${f.p}"${f.num ? ' data-eg-num' : ''}>${f.options.map(([val, lab]) =>
        `<option value="${escHtml(String(val))}"${String(v) === String(val) ? ' selected' : ''}>${escHtml(lab)}</option>`).join('')}</select>`;
    } else if (f.type === 'lines') {
      const txt = Array.isArray(v) ? v.join(', ') : '';
      input = `<input type="text" id="${id}" data-eg-p="${f.p}" data-eg-lines value="${escHtml(txt)}" placeholder="equal spacing" inputmode="decimal">`;
    } else if (f.type === 'text') {
      input = `<input type="text" id="${id}" data-eg-p="${f.p}" value="${escHtml(v == null ? '' : String(v))}">`;
    } else {
      const shown = v == null || v === '' ? '' : this._disp(v, f.scale);
      const list = f.sizes ? ` list="eg-sizes-list"` : '';
      const dl = f.sizes ? `<datalist id="eg-sizes-list">${this.SIZES_MM2.map(a => `<option value="${a}">`).join('')}</datalist>` : '';
      input = `<input type="number" id="${id}" data-eg-p="${f.p}" value="${escHtml(String(shown))}" step="${f.step || 'any'}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.optional ? ' data-eg-opt' : ''}${f.ph ? ` placeholder="${escHtml(f.ph)}"` : ''}${list} inputmode="decimal">${dl}`;
    }
    const unit = f.unit ? `<span class="eg-u">${escHtml(f.unit)}</span>` : '';
    const hint = f.hint ? `<div class="eg-hint">${escHtml(f.hint)}</div>` : '';
    return `<div class="eg-fld${f.type === 'lines' ? ' eg-fld-wide' : ''}" data-eg-fld="${f.p}"><label for="${id}">${escHtml(f.label)}</label>
      <div class="eg-in">${input}${unit}</div>${hint}</div>`;
  },

  // Stored value → shown value (scale: metres shown as mm); trims float noise.
  _disp(v, scale) {
    const n = +v * (scale || 1);
    return Number.isFinite(n) ? +n.toPrecision(10) : v;
  },

  _renderTable(list) {
    const g = this.current();
    const tbody = this._el('eg-form').querySelector(`[data-eg-tbody="${list}"]`);
    if (!g || !tbody) return;
    const T = this.TABLES[list];
    // data-label: the column caption, shown per cell in the phone card layout
    tbody.innerHTML = g[list].map((row, i) => `<tr>${T.cols.map(c => {
      const v = row[c.k];
      const td = `<td data-label="${escHtml(c.label)}">`;
      const attrs = `data-eg-list="${list}" data-eg-idx="${i}" data-eg-key="${c.k}" aria-label="${escHtml(c.label)} ${i + 1}"`;
      if (c.type === 'bond') {
        const bonded = v !== false && v !== 'no' && v !== 'false';
        return `${td}<select ${attrs} data-eg-bond><option value="yes"${bonded ? ' selected' : ''}>Bonded</option><option value="no"${bonded ? '' : ' selected'}>Separate</option></select></td>`;
      }
      if (c.type === 'text') return `${td}<input type="text" ${attrs} value="${escHtml(v == null ? '' : String(v))}"></td>`;
      return `${td}<input type="number" step="any" inputmode="decimal" ${attrs}${c.optional ? ' data-eg-opt' : ''} value="${v == null || v === '' ? '' : escHtml(String(this._disp(v, c.scale)))}"${c.ph ? ` placeholder="${escHtml(c.ph)}"` : ''}></td>`;
    }).join('')}<td class="eg-td-del"><button type="button" class="eg-row-del" data-eg-row-del="${list}:${i}" title="Remove row" aria-label="Remove row ${i + 1}">&times;</button></td></tr>`).join('')
      || `<tr class="eg-row-empty"><td colspan="${T.cols.length + 1}">None</td></tr>`;
    GridTable.attach(tbody, { onAddRow: () => this._addRow(g, list) });
    const cnt = this._el('eg-form').querySelector(`[data-eg-count="${list}"]`);
    if (cnt) cnt.textContent = g[list].length || '';
  },

  _addRow(g, list) {
    const arr = g[list];
    const last = arr[arr.length - 1];
    let row;
    if (list === 'fences') {
      row = Object.assign(this._clone(this.FENCE_DEFAULT), last ? this._clone(last) : {}, { name: `Fence ${arr.length + 1}` });
    } else if (list === 'extra_conductors') {
      row = last ? this._clone(last) : { x1: 0, y1: 0, x2: +g.layout.length_x || 10, y2: 0, bonded: true };
    } else {
      row = last ? this._clone(last) : { x: 0, y: 0, bonded: true };
    }
    arr.push(row);
    this._renderTable(list);
    this._changed(true);
    this._schedulePreview();
    const tbody = this._el('eg-form').querySelector(`[data-eg-tbody="${list}"]`);
    const first = tbody && tbody.rows[arr.length - 1] && tbody.rows[arr.length - 1].querySelector('input, select');
    if (first) first.focus();
  },

  // One handler for every form control: `input` = live (preview), `change` = commit.
  _onInput(e, commit) {
    const t = e.target;
    const g = this.current();
    if (!g) return;
    if (t.dataset.egList) {
      const row = g[t.dataset.egList][+t.dataset.egIdx];
      if (!row) return;
      const k = t.dataset.egKey;
      if (t.dataset.egBond != null) row[k] = t.value === 'yes';
      else if (t.type === 'number') {
        if (t.value.trim() === '') {
          if (t.dataset.egOpt != null) { if (k === 'conductor_offset_m') row[k] = null; else delete row[k]; }
          else { t.classList.toggle('input-invalid', commit); return; }
        } else {
          const n = parseFloat(t.value);
          const col = this.TABLES[t.dataset.egList].cols.find(c => c.k === k) || {};
          if (!Number.isFinite(n) || (col.min != null && n < col.min)) {
            t.classList.add('input-invalid');
            if (commit) { t.value = row[k] == null ? '' : this._disp(row[k], col.scale); t.classList.remove('input-invalid'); }
            return;
          }
          row[k] = n / (col.scale || 1);
        }
        t.classList.remove('input-invalid');
      } else row[k] = t.value;
    } else if (t.dataset.egP) {
      const p = t.dataset.egP;
      let val;
      if (t.dataset.egLines != null) {
        const parts = t.value.split(/[,;\s]+/).filter(Boolean);
        const nums = parts.map(Number);
        const L = +(p === 'layout.x_lines' ? g.layout.length_x : g.layout.width_y);
        // At least two positions, all within the grid (0 … its length)
        const bad = nums.some(n => !Number.isFinite(n) || n < -1e-9 || (L > 0 && n > L + 1e-9)) || nums.length === 1;
        if (bad) { t.classList.add('input-invalid'); t.title = `At least two positions between 0 and ${this._n(L)} m`; return; }
        t.classList.remove('input-invalid'); t.title = '';
        val = nums.length ? [...new Set(nums)].sort((x, y) => x - y) : null;
      } else if (t.type === 'number') {
        const n = parseFloat(t.value);
        const f = this._fieldDef(p) || {};
        if (f.optional && t.value.trim() === '') {
          // Optional field left blank: unset it (e.g. outside diameter → from size)
          const ks = p.split('.');
          const parent = ks.length > 1 ? this._get(g, ks.slice(0, -1).join('.')) : g;
          if (parent) delete parent[ks[ks.length - 1]];
          t.classList.remove('input-invalid');
          this._applyVisibility(g);
          this._changed(commit);
          this._schedulePreview();
          return;
        }
        // Out of range (min/max, a notch inside the grid): refuse — keep the stored value
        let max = f.max;
        if (p === 'layout.notch_x') max = +g.layout.length_x;
        if (p === 'layout.notch_y') max = +g.layout.width_y;
        const out = !Number.isFinite(n) || (f.min != null && n < f.min) || (max != null && n > max);
        if (out) {
          t.classList.add('input-invalid');
          t.title = Number.isFinite(n) ? `Allowed: ${f.min != null ? f.min : '…'} to ${max != null ? this._n(max) : '…'}` : 'Enter a number';
          if (commit) { const keep = this._get(g, p); t.value = keep == null ? '' : this._disp(keep, f.scale); t.classList.remove('input-invalid'); }
          return;
        }
        t.classList.remove('input-invalid'); t.title = '';
        if (f.step === 1) val = Math.round(n); else val = n / (f.scale || 1);
      } else if (t.dataset.egNum != null) {
        val = Number(t.value);
      } else {
        val = t.value;
      }
      if (p === 'name') {
        val = String(val);
        if (!val.trim()) { if (commit) { t.value = g.name; } return; }
        this._set(g, p, val);
        this._renderRail();
      } else {
        this._set(g, p, val);
      }
      this._applyVisibility(g);
    } else {
      return;
    }
    this._changed(commit);
    if (t.dataset.egP !== 'name') this._schedulePreview();
    if (t.dataset.egP === 'layout.type' || t.dataset.egP === 'layout.length_x' || t.dataset.egP === 'layout.width_y') this._renderRail();
  },

  _fieldDef(p) {
    for (const sec of this._sections()) for (const f of (sec.fields || [])) if (f.p === p) return f;
    return null;
  },

  _applyVisibility(g) {
    const byP = {};
    for (const sec of this._sections()) for (const f of (sec.fields || [])) byP[f.p] = f;
    this._el('eg-form').querySelectorAll('[data-eg-fld]').forEach(div => {
      const f = byP[div.dataset.egFld];
      div.hidden = !!(f && f.show && !f.show(g));
    });
  },

  // ── Live plan preview ──────────────────────────────────────────────
  _schedulePreview(delay = 300) {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => this._runPreview(), delay);
  },

  async _runPreview() {
    const g = this.current();
    const box = this._el('eg-preview');
    if (!g || !box) return;
    const seq = ++this._previewSeq;
    box.classList.add('eg-busy');
    let res = null, err = null;
    try {
      res = await API.previewEarthGrid(g);
    } catch (e) {
      err = e.message || String(e);
    }
    if (seq !== this._previewSeq || !this._isOpen()) return;
    box.classList.remove('eg-busy');
    if (err) {
      const status = box.querySelector('.eg-pv-status');
      if (this._lastPreview && this._lastPreview.gridId === g.id && status) {
        box.querySelector('.eg-pv-plan')?.classList.add('eg-stale');
        status.innerHTML = `<div class="eg-pv-err">${escHtml(err)}</div>`;
      } else {
        // Nothing drawable yet (e.g. no layout and nothing added): an empty
        // plan still takes clicks, so conductors and rods can be placed.
        this._lastPreview = { gridId: g.id, empty: true, plan: { outline: [], touch_area: [], conductors: [], rods: [], fences: [] } };
        this._snapPts = [];
        box.innerHTML = `${this._toolbarHtml()}<div class="eg-pv-plan"></div><div class="eg-pv-status"><div class="eg-pv-err">${escHtml(err)}</div></div>`;
        this._drawView();
      }
      return;
    }
    res.gridId = g.id;
    this._lastPreview = res;
    this._snapPts = this._snapPoints(res.plan);
    const lines = [];
    lines.push(`<div class="eg-pv-stats"><span><b>${res.elements}</b> elements</span>
      <span class="${res.connected ? 'eg-ok' : 'eg-warn'}">${res.connected ? 'Connected' : `Not connected — ${res.pieces} separate bonded pieces`}</span></div>`);
    lines.push(res.ieee80_applicable
      ? '<div class="eg-pv-app eg-ok">IEEE 80 simplified equations apply</div>'
      : `<div class="eg-pv-app">Numerical method — ${escHtml(res.ieee80_not_applicable_reason || 'IEEE 80 simplified equations do not apply')}</div>`);
    if (res.notes && res.notes.length) lines.push(`<ul class="eg-pv-notes">${res.notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>`);
    box.innerHTML = `${this._toolbarHtml()}<div class="eg-pv-plan"></div>
      ${this._planKeyHtml(res.plan)}
      <div class="eg-pv-status">${lines.join('')}</div>`;
    this._drawView();
  },

  // ── Preview toolbar: Plan / 3-D, click-to-add tools ────────────────
  _toolbarHtml() {
    const v = this.view, t = this.tool;
    const seg = (attr, val, label, on, title) =>
      `<button type="button" class="eg-tb-btn${on ? ' on' : ''}" ${attr}="${val}" aria-pressed="${on}"${title ? ` title="${escHtml(title)}"` : ''}>${label}</button>`;
    let tools;
    if (v === 'plan') {
      tools = `<div class="eg-tb-seg" role="group" aria-label="Plan tools">
          ${seg('data-eg-tool', 'select', 'Select', !t)}
          ${seg('data-eg-tool', 'conductor', '+ Conductor', t === 'conductor', 'Click to start, click again to end; it carries on from there')}
          ${seg('data-eg-tool', 'rod', '+ Rod', t === 'rod', 'Click to place a rod')}
        </div>`;
    } else {
      const ex = this._3d.exag;
      tools = `<div class="eg-tb-seg" role="group" aria-label="Depth scale" title="Depth scale — stretches depths so shallow conductors and rods are easy to tell apart">
          ${[1, 2, 5].map(k => seg('data-eg-exag', k, `Depth ×${k}`, ex === k)).join('')}
        </div>
        <div class="eg-tb-seg" role="group" aria-label="3-D view">
          <button type="button" class="eg-tb-btn" data-eg-3d="in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="eg-tb-btn" data-eg-3d="out" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" class="eg-tb-btn" data-eg-3d="reset" title="Reset the view">Reset</button>
        </div>`;
    }
    return `<div class="eg-tb">
        <div class="eg-tb-seg" role="group" aria-label="View">
          ${seg('data-eg-view', 'plan', 'Plan', v === 'plan')}${seg('data-eg-view', '3d', '3-D', v === '3d')}
        </div>${tools}
      </div>
      <div class="eg-tb-hint" aria-live="polite">${this._hintText()}</div>`;
  },

  _hintText() {
    if (this.view === '3d') return 'Drag to turn the grid · scroll or pinch to zoom · double-click to reset.';
    if (this.tool === 'rod') return 'Click the plan to place a rod. It snaps to crossings, conductor ends and conductors (hold Alt for a free point). Esc ends.';
    if (this.tool === 'conductor') {
      return this._pend
        ? `From (${this._n(this._pend[0])}, ${this._n(this._pend[1])}) m — click the end point. Click the same point again or press Esc to finish.`
        : 'Click the start of the conductor. It snaps to crossings, conductor ends and conductors (hold Alt for a free point).';
    }
    return 'Plan of the grid. Choose + Conductor or + Rod to place them by clicking.';
  },

  _setHint(extra) {
    const h = this._el('eg-preview').querySelector('.eg-tb-hint');
    if (h) h.innerHTML = escHtml(this._hintText()) + (extra ? ` <span class="eg-tb-xy">${extra}</span>` : '');
  },

  _setTool(tool) {
    this.tool = tool === 'select' ? null : tool;
    this._pend = null;
    this._refreshToolbar();
    this._drawEditOverlay();
  },

  _refreshToolbar() {
    const box = this._el('eg-preview');
    const tb = box.querySelector('.eg-tb');
    if (!tb) return;
    const hint = box.querySelector('.eg-tb-hint');
    const tmp = document.createElement('div');
    tmp.innerHTML = this._toolbarHtml();
    tb.replaceWith(tmp.children[0]);
    if (hint) hint.replaceWith(tmp.children[0]);
    box.querySelector('.eg-pv-plan')?.classList.toggle('eg-tool-on', this.view === 'plan' && !!this.tool);
  },

  // Draw the plan or the 3-D view from the last preview.
  _drawView() {
    const box = this._el('eg-preview');
    const host = box && box.querySelector('.eg-pv-plan');
    const res = this._lastPreview;
    const g = this.current();
    if (!host || !res || !g) return;
    host.classList.toggle('eg-tool-on', this.view === 'plan' && !!this.tool);
    host.classList.toggle('eg-pv-3d', this.view === '3d');
    if (this.view === '3d') {
      if (res.empty) { this._stop3d(); host.innerHTML = '<div class="eg-muted" style="padding:20px;text-align:center">Nothing to show in 3-D yet</div>'; return; }
      host.innerHTML = '<canvas class="eg-3d" role="img" tabindex="0"></canvas>';
      const cv = host.querySelector('canvas');
      cv.setAttribute('aria-label', `3-D view of ${g.name}: ${(res.plan.conductors || []).length} conductors, ${(res.plan.rods || []).filter(r => r[2] !== 'post').length} rods`);
      this._start3d(cv);
    } else {
      this._stop3d();
      host.innerHTML = this.planSvg(res.plan, { label: g.name, edit: true });
      this._drawEditOverlay();
    }
  },

  _bindPreview() {
    const box = this._el('eg-preview');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eg-view], [data-eg-tool], [data-eg-exag], [data-eg-3d]');
      if (!b) return;
      if (b.dataset.egView) {
        this.view = b.dataset.egView;
        this._pend = null;
        this._refreshToolbar();
        this._drawView();
      } else if (b.dataset.egTool) {
        this._setTool(b.dataset.egTool);
      } else if (b.dataset.egExag) {
        this._3d.exag = +b.dataset.egExag;
        this._refreshToolbar();
        this._render3d();
      } else {
        const a = b.dataset.eg3d;
        if (a === 'reset') this._reset3d();
        else this._3d.zoom = Math.min(8, Math.max(0.3, this._3d.zoom * (a === 'in' ? 1.25 : 0.8)));
        this._render3d();
      }
    });
    // Plan: click-to-add (pointer events — mouse, pen and touch alike)
    box.addEventListener('pointermove', (e) => {
      if (this.view !== 'plan' || !this.tool) return;
      const svg = e.target.closest && e.target.closest('svg.eg-plan');
      if (!svg) return;
      this._hover = this._snapAt(svg, e);
      this._drawEditOverlay();
    });
    box.addEventListener('pointerleave', () => { this._hover = null; this._drawEditOverlay(); });
    box.addEventListener('pointerdown', (e) => {
      if (this.view !== 'plan' || !this.tool || e.button !== 0) return;
      const svg = e.target.closest && e.target.closest('svg.eg-plan');
      if (!svg) return;
      e.preventDefault();
      const pt = this._snapAt(svg, e);
      if (!pt) return;
      this._placeAt(pt);
    });
    box.addEventListener('contextmenu', (e) => {
      // Right-click ends the conductor being drawn
      if (this.view === 'plan' && this._pend && e.target.closest('svg.eg-plan')) {
        e.preventDefault();
        this._pend = null;
        this._drawEditOverlay();
      }
    });
  },

  // ── Click-to-add ───────────────────────────────────────────────────
  // Points a click snaps to: conductor ends, conductor crossings, rods.
  _snapPoints(plan) {
    const pts = [];
    const seen = new Set();
    const add = (x, y, what) => {
      const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      if (seen.has(k)) return;
      seen.add(k);
      pts.push([x, y, what]);
    };
    const cs = (plan.conductors || []).filter(c => c[4] !== 'fence_conductor' || !+c[5]);
    for (const c of cs) { add(c[0], c[1], 'conductor end'); add(c[2], c[3], 'conductor end'); }
    if (cs.length <= 400) {
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const p = this._segX(cs[i], cs[j]);
        if (p) add(p[0], p[1], 'crossing');
      }
    }
    for (const r of plan.rods || []) if (r[2] !== 'post') add(r[0], r[1], 'rod');
    return pts;
  },
  _segX(a, b) {
    const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  },

  // Pointer → grid metres, snapped: a snap point within 10 px, else a point
  // on a conductor within 7 px, else the nearest 0.5 m (1 m on big grids).
  // Alt = no snapping (to 0.01 m).
  _snapAt(svg, e) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    const s = +svg.dataset.s, pad = +svg.dataset.pad, minX = +svg.dataset.minx, maxY = +svg.dataset.maxy;
    const x = minX + (p.x - pad) / s, y = maxY - (p.y - pad) / s;
    const mPerPx = 1 / (s * Math.abs(ctm.a || 1));
    const r2 = v => Math.round(v * 100) / 100;
    if (e.altKey) return [r2(x), r2(y), 'free'];
    let best = null, bd = 10 * mPerPx;
    for (const q of this._snapPts || []) {
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return [r2(best[0]), r2(best[1]), best[2]];
    const plan = (this._lastPreview || {}).plan || {};
    bd = 7 * mPerPx;
    for (const c of plan.conductors || []) {
      const dx = c[2] - c[0], dy = c[3] - c[1];
      const L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((x - c[0]) * dx + (y - c[1]) * dy) / L2));
      const px = c[0] + t * dx, py = c[1] + t * dy;
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = [px, py, 'on a conductor']; }
    }
    if (best) return [r2(best[0]), r2(best[1]), best[2]];
    const span = Math.max(+svg.dataset.spanx || 0, +svg.dataset.spany || 0);
    const step = span > 150 ? 1 : 0.5;
    return [r2(Math.round(x / step) * step), r2(Math.round(y / step) * step), 'grid'];
  },

  _placeAt(pt) {
    const g = this.current();
    if (!g) return;
    const [x, y] = pt;
    if (this.tool === 'rod') {
      g.extra_rods.push({ x, y, bonded: true });
      this._afterPlace('extra_rods');
      return;
    }
    if (!this._pend) { this._pend = [x, y]; this._drawEditOverlay(); return; }
    const [x0, y0] = this._pend;
    if (Math.hypot(x - x0, y - y0) < 1e-6) { this._pend = null; this._drawEditOverlay(); return; }  // same point: finish
    g.extra_conductors.push({ x1: x0, y1: y0, x2: x, y2: y, bonded: true });
    this._pend = [x, y];          // carry on from the end
    this._afterPlace('extra_conductors');
  },

  _afterPlace(list) {
    this._openSecs[list] = true;
    const sec = this._el('eg-form').querySelector(`[data-eg-sec="${list}"]`);
    if (sec) sec.open = true;
    this._renderTable(list);
    this._changed(true);
    this._drawEditOverlay();
    this._schedulePreview(150);
  },

  // Snap marker, conductor rubber band and coordinates over the plan.
  _drawEditOverlay() {
    const svg = this._el('eg-preview')?.querySelector('svg.eg-plan');
    if (svg) {
      let ov = svg.querySelector('.eg-p-edit');
      if (!ov) { ov = document.createElementNS('http://www.w3.org/2000/svg', 'g'); ov.setAttribute('class', 'eg-p-edit'); svg.appendChild(ov); }
      const s = +svg.dataset.s, pad = +svg.dataset.pad, minX = +svg.dataset.minx, maxY = +svg.dataset.maxy;
      const X = x => (pad + (x - minX) * s).toFixed(1), Y = y => (pad + (maxY - y) * s).toFixed(1);
      let h = '';
      const hv = this.view === 'plan' && this.tool ? this._hover : null;
      if (this.tool === 'conductor' && this._pend) {
        h += `<circle cx="${X(this._pend[0])}" cy="${Y(this._pend[1])}" r="3.6" class="eg-p-pend"/>`;
        if (hv) h += `<line x1="${X(this._pend[0])}" y1="${Y(this._pend[1])}" x2="${X(hv[0])}" y2="${Y(hv[1])}" class="eg-p-band"/>`;
      }
      if (hv) {
        h += this.tool === 'rod'
          ? `<circle cx="${X(hv[0])}" cy="${Y(hv[1])}" r="3.4" class="eg-p-ghost"/>`
          : `<circle cx="${X(hv[0])}" cy="${Y(hv[1])}" r="5" class="eg-p-snap${hv[2] === 'grid' || hv[2] === 'free' ? '' : ' eg-p-snap-hit'}"/>`;
      }
      ov.innerHTML = h;
    }
    const hv = this.view === 'plan' && this.tool ? this._hover : null;
    let xy = '';
    if (hv) {
      xy = `x ${this._n(hv[0])} m, y ${this._n(hv[1])} m`;
      if (this._pend && this.tool === 'conductor') xy += ` · ${this._n(Math.round(Math.hypot(hv[0] - this._pend[0], hv[1] - this._pend[1]) * 100) / 100)} m long`;
      if (hv[2] !== 'grid' && hv[2] !== 'free') xy += ` · ${hv[2]}`;
    }
    this._setHint(xy);
  },

  // ── 3-D view (canvas, own projection — no library) ─────────────────
  // World: x east, y north, z up (depth = −z). Orbit with yaw/pitch, a
  // perspective camera, depths stretched by `exag`.
  _3d: { yaw: -0.6, pitch: 0.55, zoom: 1, exag: 2, cv: null, ro: null, drag: null, pinch: null },

  _reset3d() { Object.assign(this._3d, { yaw: -0.6, pitch: 0.55, zoom: 1 }); },

  _start3d(cv) {
    this._stop3d();
    const S = this._3d;
    S.cv = cv;
    S.pts = new Map();
    const host = cv.parentElement;
    S.ro = new ResizeObserver(() => this._render3d());
    S.ro.observe(host);
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      S.pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (S.pts.size === 2) {
        const [a, b] = [...S.pts.values()];
        S.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: S.zoom };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const prev = S.pts.get(e.pointerId);
      if (!prev) return;
      S.pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (S.pts.size >= 2 && S.pinch) {
        const [a, b] = [...S.pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        S.zoom = Math.min(8, Math.max(0.3, S.pinch.zoom * d / (S.pinch.d || 1)));
      } else {
        S.yaw -= (e.clientX - prev[0]) * 0.01;
        S.pitch = Math.min(Math.PI / 2, Math.max(0.05, S.pitch + (e.clientY - prev[1]) * 0.01));
      }
      this._render3d();
    });
    const up = (e) => { S.pts.delete(e.pointerId); if (S.pts.size < 2) S.pinch = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      S.zoom = Math.min(8, Math.max(0.3, S.zoom * Math.exp(-e.deltaY * 0.0015)));
      this._render3d();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { this._reset3d(); this._render3d(); });
    cv.addEventListener('keydown', (e) => {
      const k = { ArrowLeft: [0.15, 0], ArrowRight: [-0.15, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[e.key];
      if (!k) return;
      e.preventDefault();
      S.yaw += k[0];
      S.pitch = Math.min(Math.PI / 2, Math.max(0.05, S.pitch + k[1]));
      this._render3d();
    });
    this._render3d();
  },

  _stop3d() {
    const S = this._3d;
    if (S.ro) S.ro.disconnect();
    S.ro = null;
    S.cv = null;
  },

  _render3d() {
    const S = this._3d, cv = S.cv, res = this._lastPreview, g = this.current();
    if (!cv || !cv.isConnected || !res || !res.plan || !g) return;
    const plan = res.plan;
    const host = cv.parentElement;
    const cssW = Math.max(200, host.clientWidth - 12);
    const cssH = Math.round(Math.min(Math.max(260, cssW * 0.78), window.innerHeight * 0.6));
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
      cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const css = getComputedStyle(this._el('earth-grid-modal'));
    const col = n => css.getPropertyValue(n).trim() || '#888';
    const C = {
      grid: col('--eg-cond'), diagonal: col('--eg-diag'), extra: col('--eg-extra'), fence_conductor: col('--eg-fence'),
      unb: col('--eg-unb'), rod: col('--eg-rod'), post: col('--eg-post'), fence: col('--eg-fence'),
      text: col('--text-secondary'), muted: col('--text-muted'), ground: col('--eg-ground'), groundEdge: col('--eg-ground-edge'),
    };
    const ex = S.exag;
    const dep = +g.conductor.depth_m || 0.5;
    const conductors = (plan.conductors || []).map(c => [c[0], c[1], c[6] != null ? +c[6] : dep, c[2], c[3], c[7] != null ? +c[7] : dep, c[4], +c[5]]);
    const rods = (plan.rods || []).map(r => [r[0], r[1], r[4] != null ? +r[4] : (r[2] === 'post' ? 0 : dep), r[5] != null ? +r[5] : (r[2] === 'post' ? 0.8 : +g.rods.length_m || 3), r[2], +r[3]]);
    const FENCE_H = 1.8;
    // Extent
    const xs = [], ys = [];
    const addP = (x, y) => { xs.push(x); ys.push(y); };
    (plan.outline || []).forEach(p => addP(p[0], p[1]));
    conductors.forEach(c => { addP(c[0], c[1]); addP(c[3], c[4]); });
    rods.forEach(r => addP(r[0], r[1]));
    (plan.fences || []).forEach(f => (f.line || []).forEach(p => addP(p[0], p[1])));
    if (!xs.length) return;
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    let maxD = 0;
    conductors.forEach(c => { maxD = Math.max(maxD, c[2], c[5]); });
    rods.forEach(r => { maxD = Math.max(maxD, r[2] + r[3]); });
    const two = g.soil.two_layer === 'on' && +g.soil.h1 > 0;
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const m = span * 0.12;
    const hasFence = (plan.fences || []).length > 0;
    const zTop = hasFence ? FENCE_H : 0, zBot = -Math.max(maxD, two ? +g.soil.h1 : 0) * ex;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (zTop + zBot) / 2;
    // Fit the slab drawn (ground margin included) for any turn of the view:
    // its plan radius across, plus the depth seen at this tilt down;
    // perspective enlarges the near side.
    const Rh = 0.5 * Math.hypot(maxX - minX + 2 * m, maxY - minY + 2 * m);
    const D = span * 2.6;
    const sinP = Math.sin(S.pitch), cosP = Math.cos(S.pitch);
    const nearF = D / Math.max(D - Rh * cosP, D * 0.3);
    const scale = S.zoom * Math.min(cssW / (2 * Rh * nearF), (cssH - 30) / ((2 * Rh * sinP + (zTop - zBot) * cosP) * nearF)) * 0.96;
    const cyw = Math.cos(S.yaw), syw = Math.sin(S.yaw), cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    // depth d (m, + away) and screen point of a world point (z already stretched)
    const P = (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const x1 = dx * cyw - dy * syw, y1 = dx * syw + dy * cyw;
      const u = dz * cp + y1 * sp, d = y1 * cp - dz * sp;
      const f = D / Math.max(D + d, D * 0.1);
      return [cssW / 2 + x1 * f * scale, (cssH - 16) / 2 - u * f * scale, d];
    };
    const Z = depth => -depth * ex;
    const line = (a, b, color, w, dash) => {
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.stroke();
    };
    const poly = (ring, z) => ring.map(p => P(p[0], p[1], z));
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (close) ctx.closePath();
    };
    const groundRing = [[minX - m, minY - m], [maxX + m, minY - m], [maxX + m, maxY + m], [minX - m, maxY + m]];

    // 1. Two-layer boundary (h1), when within view
    if (two && +g.soil.h1 < maxD * 3) {
      path(poly(groundRing, Z(+g.soil.h1)), true);
      ctx.strokeStyle = C.muted; ctx.lineWidth = 0.8; ctx.setLineDash([2, 4]); ctx.stroke();
      const q = P(maxX + m, minY - m, Z(+g.soil.h1));
      ctx.setLineDash([]); ctx.fillStyle = C.muted; ctx.font = '10.5px system-ui, sans-serif';
      ctx.fillText(`ρ₂ below ${this._n(+g.soil.h1)} m`, q[0] + 4, q[1]);
    }
    // 2. Buried metal, far to near
    const items = [];
    for (const c of conductors) {
      const a = P(c[0], c[1], Z(c[2])), b = P(c[3], c[4], Z(c[5]));
      items.push({ d: (a[2] + b[2]) / 2, draw: () => line(a, b, c[7] ? C.unb : (C[c[6]] || C.grid), c[6] === 'extra' ? 2.2 : 1.6, c[7] ? [5, 3] : null) });
    }
    for (const r of rods) {
      const post = r[4] === 'post';
      const a = P(r[0], r[1], Z(r[2])), b = P(r[0], r[1], Z(r[2] + r[3]));
      const color = r[5] ? C.unb : post ? C.post : r[4] === 'extra_rod' ? C.extra : C.rod;
      items.push({ d: (a[2] + b[2]) / 2, draw: () => {
        line(a, b, color, post ? 2 : 2.6);
        if (!post) { ctx.beginPath(); ctx.arc(a[0], a[1], 2.4, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill(); }
      } });
    }
    items.sort((p, q) => q.d - p.d).forEach(it => it.draw());
    // 3. Ground surface (translucent, over the buried metal), outline at z = 0
    path(poly(groundRing, 0), true);
    ctx.fillStyle = C.ground; ctx.fill();
    ctx.strokeStyle = C.groundEdge; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke();
    if ((plan.outline || []).length) {
      path(poly(plan.outline, 0), true);
      ctx.strokeStyle = C.muted; ctx.lineWidth = 0.9; ctx.setLineDash([4, 3]); ctx.stroke();
    }
    // 4. Above ground: fence posts and top rail
    for (const f of plan.fences || []) {
      if (!(f.line || []).length) continue;
      const color = f.bonded ? C.fence : C.unb;
      path(poly(f.line, FENCE_H), true);
      ctx.strokeStyle = color; ctx.lineWidth = 1.1; ctx.setLineDash([]); ctx.stroke();
    }
    for (const r of rods) {
      if (r[4] !== 'post') continue;
      line(P(r[0], r[1], 0), P(r[0], r[1], FENCE_H), r[5] ? C.unb : C.post, 1.4);
    }
    // 5. Depth ruler at the nearest-left corner + labels
    const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    const near = corners.map(p => ({ p, s: P(p[0], p[1], 0) })).sort((a, b) => a.s[2] - b.s[2]);
    const rc = near.slice(0, 2).sort((a, b) => a.s[0] - b.s[0])[0].p;
    const rx = rc[0] + (rc[0] === minX ? -m * 0.5 : m * 0.5), ry = rc[1] + (rc[1] === minY ? -m * 0.5 : m * 0.5);
    const deepest = Math.max(maxD, 0.5);
    const r0 = P(rx, ry, 0), r1 = P(rx, ry, Z(deepest));
    line(r0, r1, C.text, 1);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = C.text;
    ctx.textBaseline = 'middle';
    // Tick step: a round depth whose ticks sit at least 14 px apart
    const pxPerM = Math.abs(r1[1] - r0[1]) / deepest || 1;
    const stepM = [0.5, 1, 2, 5, 10, 20, 50].find(k => k * pxPerM >= 14) || 100;
    for (let d = 0; d <= deepest + 1e-9; d += stepM) {
      const q = P(rx, ry, Z(d));
      line([q[0] - 3, q[1]], [q[0] + 3, q[1]], C.text, 1);
      ctx.fillText(d ? `−${this._n(d)} m` : '0 m', q[0] + 6, q[1]);
    }
    const qd = P(rx, ry, Z(deepest));
    const lastTick = Math.floor(deepest / stepM + 1e-9) * stepM;
    if ((deepest - lastTick) * pxPerM >= 12) {
      line([qd[0] - 3, qd[1]], [qd[0] + 3, qd[1]], C.text, 1);
      ctx.fillText(`−${this._n(deepest)} m`, qd[0] + 6, qd[1]);
    }
    // Axis gizmo (x, y, north) bottom-left
    const gx = 34, gy = cssH - 30, gl = 18;
    const ax = (vx, vy, vz) => {
      const x1 = vx * cyw - vy * syw, y1 = vx * syw + vy * cyw;
      return [gx + x1 * gl, gy - (vz * cp + y1 * sp) * gl];
    };
    ctx.textBaseline = 'middle';
    [['x', ax(1, 0, 0)], ['y', ax(0, 1, 0)], ['z', ax(0, 0, 1)]].forEach(([lab, q]) => {
      line([gx, gy], q, C.text, 1.2);
      ctx.fillText(lab, q[0] + (q[0] >= gx ? 3 : -9), q[1]);
    });
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.muted;
    const note = ex !== 1 ? `Depths ×${ex}` : 'True scale';
    ctx.fillText(note, cssW - ctx.measureText(note).width - 8, cssH - 10);
  },

  // ── Plan drawing (editor preview and results) ──────────────────────
  // plan: {outline, touch_area, conductors[[x1,y1,x2,y2,kind,group]], rods[[x,y,kind,group]], fences[{name,bonded,line}], map?}
  // o.heat = {gpr, limit}: colour the map (touch = (1 − v)·GPR) inside the touch area.
  // o.touchAt [x,y], o.stepAt [x1,y1,x2,y2]: worst touch / step locations.
  planSvg(plan, o = {}) {
    if (!plan) return '';
    const pts = [];
    const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]); };
    (plan.outline || []).forEach(p => add(p[0], p[1]));
    (plan.conductors || []).forEach(c => { add(c[0], c[1]); add(c[2], c[3]); });
    (plan.rods || []).forEach(r => add(r[0], r[1]));
    (plan.fences || []).forEach(f => (f.line || []).forEach(p => add(p[0], p[1])));
    if (!pts.length && o.edit) { pts.push([0, 0], [20, 20]); }
    if (!pts.length) return '<div class="eg-muted" style="padding:20px;text-align:center">Nothing to draw yet</div>';
    let minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
    let minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
    if (maxX - minX < 1) { minX -= 0.5; maxX += 0.5; }
    if (maxY - minY < 1) { minY -= 0.5; maxY += 0.5; }
    const spanX = maxX - minX, spanY = maxY - minY;
    const PAD = 32, PADB = 42, WMAX = 440, HMAX = 400;
    const s = Math.min(WMAX / spanX, HMAX / spanY);
    const W = spanX * s + 2 * PAD, H = spanY * s + PAD + PADB;
    const X = x => (PAD + (x - minX) * s).toFixed(1);
    const Y = y => (PAD + (maxY - y) * s).toFixed(1);
    const poly = ring => ring.map(p => `${X(p[0])},${Y(p[1])}`).join(' ');
    let svg = '';

    // Touch-voltage heatmap (results) — map points inside the touch area only
    const map = plan.map;
    if (o.heat && map && map.v && map.nx && map.ny && o.heat.gpr > 0 && o.heat.limit > 0) {
      const rings = plan.touch_area || [];
      const maxT = o.heat.maxT != null ? o.heat.maxT : this._touchRange(map, rings, o.heat.gpr).max;
      const img = this._heatImage(map, rings, o.heat.gpr, o.heat.limit, maxT);
      if (img) {
        svg += `<image href="${img.url}" x="${X(img.x0)}" y="${Y(img.y1)}" width="${((img.x1 - img.x0) * s).toFixed(1)}" height="${((img.y1 - img.y0) * s).toFixed(1)}" preserveAspectRatio="none"/>`;
      }
      if (maxT > o.heat.limit) {
        const segs = this._limitContour(map, rings, o.heat.gpr, o.heat.limit);
        const d = segs.map(q => `M${X(q[0])} ${Y(q[1])}L${X(q[2])} ${Y(q[3])}`).join('');
        if (d) svg += `<path d="${d}" class="eg-p-limit-halo"/><path d="${d}" class="eg-p-limit"/>`;
      }
    } else {
      for (const ring of plan.touch_area || []) svg += `<polygon points="${poly(ring)}" class="eg-p-touch"/>`;
    }
    if (o.heat) for (const ring of plan.touch_area || []) svg += `<polygon points="${poly(ring)}" class="eg-p-touch-edge"/>`;
    if ((plan.outline || []).length) svg += `<polygon points="${poly(plan.outline)}" class="eg-p-outline"/>`;
    for (const f of plan.fences || []) {
      if ((f.line || []).length) svg += `<polygon points="${poly(f.line)}" class="eg-p-fence${f.bonded ? '' : ' eg-p-unb'}"><title>${escHtml(f.name || 'Fence')} — ${f.bonded ? 'bonded' : 'separately earthed'}</title></polygon>`;
    }
    for (const c of plan.conductors || []) {
      const kind = c[4] || 'grid', grp = +c[5] || 0;
      const cls = `eg-p-c eg-p-${kind}${grp ? ' eg-p-unb' : ''}`;
      svg += `<line x1="${X(c[0])}" y1="${Y(c[1])}" x2="${X(c[2])}" y2="${Y(c[3])}" class="${cls}"/>`;
    }
    for (const r of plan.rods || []) {
      const kind = r[2] || 'rod', grp = +r[3] || 0;
      if (kind === 'post') {
        svg += `<rect x="${(+X(r[0]) - 2.2).toFixed(1)}" y="${(+Y(r[1]) - 2.2).toFixed(1)}" width="4.4" height="4.4" class="eg-p-post${grp ? ' eg-p-unb' : ''}"/>`;
      } else {
        svg += `<circle cx="${X(r[0])}" cy="${Y(r[1])}" r="3.4" class="eg-p-rod${grp ? ' eg-p-unb' : ''}${kind === 'extra_rod' ? ' eg-p-xrod' : ''}"/>`;
      }
    }
    // Worst touch (✕) and step (segment) locations
    if (o.stepAt && o.stepAt.length === 4) {
      const [a, b, c, d] = o.stepAt;
      svg += `<line x1="${X(a)}" y1="${Y(b)}" x2="${X(c)}" y2="${Y(d)}" class="eg-p-step"/><circle cx="${X(a)}" cy="${Y(b)}" r="2.4" class="eg-p-stepend"/><circle cx="${X(c)}" cy="${Y(d)}" r="2.4" class="eg-p-stepend"/>`;
    }
    if (o.touchAt && o.touchAt.length === 2) {
      const cx = +X(o.touchAt[0]), cy = +Y(o.touchAt[1]), k = 6;
      svg += `<g class="eg-p-touchx"><line x1="${cx - k}" y1="${cy - k}" x2="${cx + k}" y2="${cy + k}"/><line x1="${cx - k}" y1="${cy + k}" x2="${cx + k}" y2="${cy - k}"/></g>`;
    }
    for (const fx of o.fenceTouch || []) {
      const cx = +X(fx[0]), cy = +Y(fx[1]), k = 4.5;
      svg += `<g class="eg-p-touchx eg-p-touchx-f"><line x1="${cx - k}" y1="${cy - k}" x2="${cx + k}" y2="${cy + k}"/><line x1="${cx - k}" y1="${cy + k}" x2="${cx + k}" y2="${cy - k}"/></g>`;
    }

    // Overall dimensions of the outline (or of everything drawn)
    const ol = (plan.outline && plan.outline.length) ? plan.outline : pts;
    const oMinX = Math.min(...ol.map(p => p[0])), oMaxX = Math.max(...ol.map(p => p[0]));
    const oMinY = Math.min(...ol.map(p => p[1])), oMaxY = Math.max(...ol.map(p => p[1]));
    const topY = PAD - 10;
    svg += `<text x="${((+X(oMinX) + +X(oMaxX)) / 2).toFixed(1)}" y="${topY}" class="eg-p-dim" text-anchor="middle">${this._n(oMaxX - oMinX)} m</text>`;
    const lx = PAD - 10, ly = ((+Y(oMinY) + +Y(oMaxY)) / 2).toFixed(1);
    svg += `<text x="${lx}" y="${ly}" class="eg-p-dim" text-anchor="middle" transform="rotate(-90 ${lx} ${ly})">${this._n(oMaxY - oMinY)} m</text>`;
    // Scale bar — a round length near a quarter of the drawing width
    const target = spanX / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map(k => k * mag).reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    const sbY = H - 16, sbX = PAD, sbW = nice * s;
    svg += `<g class="eg-p-scale"><line x1="${sbX}" y1="${sbY}" x2="${(sbX + sbW).toFixed(1)}" y2="${sbY}"/>
      <line x1="${sbX}" y1="${sbY - 4}" x2="${sbX}" y2="${sbY + 4}"/><line x1="${(sbX + sbW).toFixed(1)}" y1="${sbY - 4}" x2="${(sbX + sbW).toFixed(1)}" y2="${sbY + 4}"/>
      <text x="${(sbX + sbW + 6).toFixed(1)}" y="${sbY + 4}" class="eg-p-dim">${this._n(nice)} m</text></g>`;

    const label = o.label ? ` of ${escHtml(o.label)}` : '';
    // data-*: the drawing scale, so a click can be turned back into metres
    const edit = o.edit ? ` data-minx="${minX}" data-maxy="${maxY}" data-s="${s}" data-pad="${PAD}" data-spanx="${spanX}" data-spany="${spanY}"` : '';
    return `<svg class="eg-plan" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"${edit}
      aria-label="Plan${label}: ${this._n(oMaxX - oMinX)} by ${this._n(oMaxY - oMinY)} metres, ${(plan.conductors || []).length} conductors, ${(plan.rods || []).filter(r => r[2] !== 'post').length} rods">${svg}</svg>`;
  },

  // Key of what the plan shows — only the kinds actually present.
  _planKeyHtml(plan) {
    const cs = plan.conductors || [], rs = plan.rods || [];
    const has = (arr, f) => arr.some(f);
    const items = [];
    const sw = (cls, shape) => shape === 'line'
      ? `<svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" class="${cls}"/></svg>`
      : shape === 'sq' ? `<svg width="10" height="10" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5" class="${cls}"/></svg>`
        : `<svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.4" class="${cls}"/></svg>`;
    if (has(cs, c => c[4] === 'grid' && !+c[5])) items.push(`${sw('eg-p-c eg-p-grid', 'line')} Grid conductor`);
    if (has(cs, c => c[4] === 'diagonal')) items.push(`${sw('eg-p-c eg-p-diagonal', 'line')} Diagonal`);
    if (has(cs, c => c[4] === 'extra' && !+c[5])) items.push(`${sw('eg-p-c eg-p-extra', 'line')} Added conductor`);
    if (has(cs, c => c[4] === 'fence_conductor')) items.push(`${sw('eg-p-c eg-p-fence_conductor', 'line')} Fence conductor`);
    if (has(cs, c => +c[5])) items.push(`${sw('eg-p-c eg-p-extra eg-p-unb', 'line')} Not bonded`);
    if (has(rs, r => r[2] !== 'post')) items.push(`${sw('eg-p-rod', 'dot')} Rod`);
    if (has(rs, r => r[2] === 'post')) items.push(`${sw('eg-p-post', 'sq')} Fence post`);
    if ((plan.fences || []).length) items.push(`${sw('eg-p-fence', 'line')} Fence line`);
    return items.length ? `<div class="eg-key">${items.map(i => `<span>${i}</span>`).join('')}</div>` : '';
  },

  // Touch-voltage colours (same rule as the PDF report): 0 → limit runs
  // green → yellow → red; above the limit a second ramp runs red → deep
  // purple up to the map's maximum, so hot spots still show on a grid far
  // over its limit. Above-limit areas are also hatched and the limit is drawn
  // as a contour, so "within" vs "above" does not rely on hue alone.
  RAMP_IN: [[26, 152, 80], [145, 207, 96], [254, 224, 139], [252, 141, 89], [215, 48, 39]],
  RAMP_OVER: [[215, 48, 39], [165, 15, 90], [63, 0, 125]],
  _ramp(R, t) {
    const x = Math.min(Math.max(t, 0), 1) * (R.length - 1);
    const i = Math.min(Math.floor(x), R.length - 2), f = x - i;
    return R[i].map((c, k) => Math.round(c + (R[i + 1][k] - c) * f));
  },
  // touch / limit, max touch → [r, g, b]
  _touchColor(touch, limit, maxT) {
    if (touch <= limit) return this._ramp(this.RAMP_IN, touch / limit);
    return this._ramp(this.RAMP_OVER, maxT > limit ? (touch - limit) / (maxT - limit) : 1);
  },
  _gradCss(R) {
    return `linear-gradient(90deg, ${R.map((c, i) => `rgb(${c.join(',')}) ${Math.round(100 * i / (R.length - 1))}%`).join(', ')})`;
  },
  _pip(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  },
  _inTouch(x, y, rings) { return rings.some(r => this._pip(x, y, r)); },

  // Lowest / highest touch voltage among the map points inside the touch area.
  _touchRange(map, rings, gpr) {
    let lo = Infinity, hi = 0;
    for (let j = 0; j < map.ny; j++) for (let i = 0; i < map.nx; i++) {
      const v = map.v[j * map.nx + i];
      if (v == null || !this._inTouch(map.x0 + i * map.dx, map.y0 + j * map.dx, rings)) continue;
      const t = (1 - v) * gpr;
      if (t > hi) hi = t;
      if (t < lo) lo = t;
    }
    return { min: Number.isFinite(lo) ? lo : 0, max: hi };
  },

  // Heatmap image spanning the map's sample points (bilinear between them),
  // transparent outside the touch area. Returns {url, x0, y0, x1, y1} in metres.
  _heatImage(map, rings, gpr, limit, maxT) {
    try {
      const { nx, ny, dx } = map;
      if (nx < 2 || ny < 2) return null;
      const K = Math.max(1, Math.min(8, Math.round(480 / (nx - 1))));
      const W = (nx - 1) * K + 1, H = (ny - 1) * K + 1;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      const img = ctx.createImageData(W, H);
      const V = (i, j) => map.v[j * nx + i];
      for (let py = 0; py < H; py++) {
        const gy = (H - 1 - py) / K;                 // canvas rows run top-down; map rows bottom-up
        const j = Math.min(Math.floor(gy), ny - 2), fy = gy - j;
        const y = map.y0 + gy * dx;
        for (let px = 0; px < W; px++) {
          const gx = px / K;
          const i = Math.min(Math.floor(gx), nx - 2), fx = gx - i;
          const x = map.x0 + gx * dx;
          const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
          let v;
          if (a == null || b == null || c == null || d == null) {
            v = V(Math.round(gx), Math.round(gy));
            if (v == null) continue;
          } else {
            v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
          }
          if (!this._inTouch(x, y, rings)) continue;
          const t = (1 - v) * gpr;
          let col = this._touchColor(t, limit, maxT);
          if (t > limit && ((px + py) % 8) < 2) col = col.map(q => Math.round(q * 0.45));   // hatching
          const k = (py * W + px) * 4;
          img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 240;
        }
      }
      ctx.putImageData(img, 0, 0);
      return { url: cv.toDataURL('image/png'), x0: map.x0, y0: map.y0, x1: map.x0 + (nx - 1) * dx, y1: map.y0 + (ny - 1) * dx };
    } catch (_) {
      return null;
    }
  },

  // Limit contour (marching squares on the map, cells inside the touch area)
  // → segments [[x1, y1, x2, y2], …] in metres.
  _limitContour(map, rings, gpr, limit) {
    const { nx, ny, dx } = map;
    const segs = [];
    const f = (i, j) => { const v = map.v[j * nx + i]; return v == null ? null : (1 - v) * gpr - limit; };
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const c = [f(i, j), f(i + 1, j), f(i + 1, j + 1), f(i, j + 1)];
      if (c.some(q => q == null)) continue;
      const x = map.x0 + i * dx, y = map.y0 + j * dx;
      if (!this._inTouch(x + dx / 2, y + dx / 2, rings)) continue;
      const P = [[x, y], [x + dx, y], [x + dx, y + dx], [x, y + dx]];
      const cross = [];
      for (let e = 0; e < 4; e++) {
        const a = c[e], b = c[(e + 1) % 4];
        if ((a > 0) !== (b > 0)) {
          const r = a / (a - b);
          const A = P[e], B = P[(e + 1) % 4];
          cross.push([A[0] + (B[0] - A[0]) * r, A[1] + (B[1] - A[1]) * r]);
        }
      }
      if (cross.length === 2) segs.push([...cross[0], ...cross[1]]);
      else if (cross.length === 4) segs.push([...cross[0], ...cross[1]], [...cross[2], ...cross[3]]);
    }
    return segs;
  },

  // Legend: 0 → limit (green → red), the limit mark, then limit → max
  // (red → purple, hatched) when any of the touch area is over the limit.
  _legendHtml(limit, maxT, f0) {
    const over = maxT > limit;
    const wIn = over ? Math.max(25, Math.min(65, 100 * limit / maxT)) : 100;
    return `<div class="eg-leg-title">Touch voltage over the touch area</div>
      <div class="eg-leg-scale">
        <div class="eg-leg-in" style="width:${wIn.toFixed(0)}%;background:${this._gradCss(this.RAMP_IN)}"></div>
        ${over ? `<div class="eg-leg-limit" title="Tolerable touch voltage"></div><div class="eg-leg-over" style="background:repeating-linear-gradient(45deg, rgba(0,0,0,.5) 0 2px, transparent 2px 8px), ${this._gradCss(this.RAMP_OVER)}"></div>` : ''}
      </div>
      <div class="eg-leg-vals"><span>0 V</span><span class="eg-leg-limtxt" style="${over ? `left:${wIn.toFixed(0)}%` : 'right:0'}">limit ${f0(limit)} V</span>${over ? `<span class="eg-leg-maxtxt">max ${f0(maxT)} V</span>` : ''}</div>
      ${over ? '' : `<div class="eg-muted">Highest ${f0(maxT)} V — within the limit everywhere.</div>`}`;
  },

  // ── Grounding results card for a bus on an earth grid ──────────────
  resultCardHtml(b, result) {
    const f0 = (v) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(0));
    const f3 = (v) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(3));
    const statusColor = b.status === 'fail' ? '#d32f2f' : b.status === 'warning' ? '#f57c00' : '#4caf50';
    const ok = (v) => v ? '<span style="color:#4caf50">✓</span>' : '<span style="color:#d32f2f">✗</span>';
    const en = b.limit_basis === 'en50522';
    const numerical = b.method === 'numerical';
    const gridRes = (result && result.grids && result.grids[b.earth_grid_id]) || null;

    let h = `<div class="eg-card" style="border-left-color:${statusColor}">
      <div class="eg-card-head">
        <div><strong style="font-size:13px">${escHtml(b.bus_name)} (${b.voltage_kv} kV)</strong>
          <span class="eg-card-grid">on ${escHtml(b.earth_grid_name || b.earth_grid_id)}</span></div>
        <span style="color:${statusColor};font-weight:600;font-size:12px">${escHtml(String(b.status || '').toUpperCase())}</span>
      </div>
      <div class="eg-badges">
        <span class="eg-badge${numerical ? ' eg-badge-num' : ''}">${numerical ? 'Numerical (method of moments)' : 'IEEE 80 simplified'}</span>
        <span class="eg-badge">${en ? 'EN 50522 limits' : 'IEEE 80 limits'}</span>
      </div>
      <div class="eg-card-grid4">
        <div>Soil: <strong>${b.soil_resistivity} Ω·m</strong>${b.two_layer_soil_enabled ? ` <span class="eg-muted">(ρ₁; ρ₂ ${b.soil_resistivity_lower}, h₁ ${b.upper_layer_thickness_m} m)</span>` : ''}</div>
        <div>Fault: <strong>${b.fault_current_ka} kA</strong></div>
        <div>R<sub>g</sub>: <strong>${f3(b.grid_resistance_ohm)} Ω</strong></div>
        <div>${en ? 'U<sub>E</sub>' : 'GPR'}: <strong>${f0(b.gpr_v)} V</strong></div>
        <div>Conductor: ${EarthGridEditor.conductorHtml(b)}</div>
        <div>Rods: <strong>${b.num_ground_rods}</strong></div>
        <div>L<sub>total</sub>: <strong>${b.total_conductor_length_m} m</strong></div>
        <div>Area: <strong>${b.grid_area_m2} m²</strong></div>
      </div>
      <div class="eg-tv">
        <div><div><strong>Touch Voltage</strong> ${ok(b.touch_ok)}</div>
          <div>Actual: <strong>${f0(b.mesh_voltage_v)} V</strong></div>
          <div>Limit: <strong>${f0(b.tolerable_touch_v)} V</strong> <span class="eg-muted">${en ? 'U<sub>vTp</sub>' : b.footwear_ohm ? `with ${f0(b.footwear_ohm)} Ω footwear` : ''}</span></div></div>
        <div><div><strong>Step Voltage</strong> ${ok(b.step_ok)}</div>
          <div>Actual: <strong>${f0(b.step_voltage_v)} V</strong></div>
          <div>Limit: <strong>${f0(b.tolerable_step_v)} V</strong></div>
          ${en && b.en50522 ? `<div class="eg-muted">${b.en50522.step_required ? 'Checked (U<sub>E</sub> &gt; 20·U<sub>Tp</sub>)' : 'Not required (U<sub>E</sub> ≤ 20·U<sub>Tp</sub>)'}</div>` : ''}</div>
      </div>`;

    if (en && b.en50522) {
      const e = b.en50522;
      const meaning = {
        C2: 'U<sub>E</sub> ≤ 2·U<sub>Tp</sub> — touch criterion met without calculating U<sub>T</sub>',
        C3: 'U<sub>E</sub> ≤ 4·U<sub>Tp</sub> with specified measures M',
        C4: 'calculated touch voltage compared with U<sub>vTp</sub>',
      }[e.condition] || '';
      h += `<div class="eg-en">EN 50522: U<sub>E</sub> = <strong>${f0(e.U_E_v)} V</strong>, U<sub>Tp</sub> = <strong>${f0(e.U_Tp_v)} V</strong>,
        U<sub>vTp</sub> = <strong>${f0(e.U_vTp_v)} V</strong> (R<sub>F</sub> = ${f0(e.R_F_ohm)} Ω) — condition <strong>${escHtml(e.condition || '')}</strong>: ${meaning}</div>`;
    }
    if (b.numerical && b.ieee80_simplified) {
      const n = b.numerical, s = b.ieee80_simplified;
      h += `<div class="eg-cmp">Numerical: R<sub>g</sub> ${f3(n.grid_resistance_ohm)} Ω, touch ${f0(n.touch_v)} V, step ${f0(n.step_v)} V
        <span class="eg-sep">|</span> IEEE 80 simplified: R<sub>g</sub> ${f3(s.grid_resistance_ohm)} Ω, E<sub>m</sub> ${f0(s.mesh_voltage_v)} V, E<sub>s</sub> ${f0(s.step_voltage_v)} V</div>`;
    }
    if (!b.ieee80_applicable && b.ieee80_not_applicable_reason) {
      h += `<div class="eg-muted eg-line">IEEE 80 simplified equations do not apply — ${escHtml(b.ieee80_not_applicable_reason)}.</div>`;
    }
    if (b.potential_variation_pct != null) {
      const pv = +b.potential_variation_pct;
      h += `<div class="eg-line${pv > 5 ? ' eg-warn' : ' eg-muted'}">Potential variation over the grid: <strong>${pv.toFixed(1)} %</strong>${pv > 5 ? ' — above 5 %: the grid is not equipotential; the conductor impedance matters' : ''}</div>`;
    }

    const unb = (b.fences || []).filter(f => !f.bonded);
    if (unb.length) {
      h += `<div class="eg-table-wrap"><table class="data-table eg-ftable"><thead><tr><th>Separately earthed fence</th><th>Potential</th><th>Touch (1 m reach)</th><th>Grid-to-fence transfer</th></tr></thead><tbody>
        ${unb.map(f => {
          const over = +f.touch_v > +b.tolerable_touch_v;
          return `<tr><td data-label="Fence">${escHtml(f.name)}</td><td data-label="Potential">${f0(f.potential_v)} V</td><td data-label="Touch (1 m reach)" class="${over ? 'eg-over' : ''}">${f0(f.touch_v)} V${over ? ' ✗ above limit' : ''}</td><td data-label="Grid-to-fence transfer">${f0(f.transfer_v)} V</td></tr>`;
        }).join('')}</tbody></table></div>`;
    }

    // Plan with the touch-voltage heatmap
    if (gridRes && gridRes.error) {
      h += `<div class="eg-pv-err">${escHtml(gridRes.error)}</div>`;
    } else if (gridRes && gridRes.plan) {
      const limit = +b.tolerable_touch_v;
      const map = gridRes.plan.map;
      const heat = map && map.v && b.gpr_v > 0 && limit > 0 ? { gpr: +b.gpr_v, limit } : null;
      if (heat) {
        const rg = this._touchRange(map, gridRes.plan.touch_area || [], heat.gpr);
        heat.maxT = rg.max; heat.minT = rg.min;
      }
      const svg = this.planSvg(gridRes.plan, {
        heat, label: b.earth_grid_name,
        touchAt: b.touch_location_m || null,
        stepAt: b.step_location_m || null,
        fenceTouch: unb.map(f => f.touch_location_m).filter(p => p && p.length === 2),
      });
      h += `<div class="eg-res-plan">${svg}
        <div class="eg-legend">
          ${heat ? this._legendHtml(limit, heat.maxT, f0) : ''}
          <div class="eg-leg-row eg-muted">${heat && heat.maxT > limit && heat.minT < limit ? '<span><b class="eg-leg-lim"></b> limit contour</span>' : ''}${b.touch_location_m ? '<span><b class="eg-leg-x">✕</b> worst touch</span>' : ''}${b.step_location_m ? '<span><b class="eg-leg-step">—</b> worst step (1 m)</span>' : ''}${unb.some(f => f.touch_location_m) ? '<span><b class="eg-leg-xf">✕</b> fence touch</span>' : ''}</div>
          ${heat ? `<div class="eg-muted" style="font-size:10.5px">Touch voltage = (1 − surface potential / GPR) × GPR, coloured inside the touch area only${gridRes.raster_m ? ` · map ${this._n(gridRes.raster_m)} m` : ''}.</div>` : ''}
        </div>${this._planKeyHtml(gridRes.plan)}</div>`;
    }

    if (b.remote_fraction != null && (b.remote_fraction < 1 || b.current_split_factor < 1)) {
      const df = b.decrement_factor_df != null ? `D<sub>f</sub> × ` : '';
      const dfv = b.decrement_factor_df != null ? `${b.decrement_factor_df} × ` : '';
      h += `<div class="eg-muted eg-line">Grid current I<sub>G</sub> = ${df}S<sub>f</sub> × remote share × 3I₀ = ${dfv}${b.current_split_factor} × ${b.remote_fraction} × ${b.symmetrical_fault_ka} kA = <strong>${b.fault_current_ka} kA</strong></div>`;
    }
    if (b.issues && b.issues.length) h += `<div class="eg-line" style="color:#b71c1c">${b.issues.map(escHtml).join('<br>')}</div>`;
    if (b.notes && b.notes.length) h += `<div class="eg-muted eg-line">${b.notes.map(n => 'ⓘ ' + escHtml(n)).join('<br>')}</div>`;
    h += '</div>';
    return h;
  },
};
