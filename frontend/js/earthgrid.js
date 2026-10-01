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
 * plan from POST /analysis/earth-grid/preview) and the grounding results
 * card for a bus on an earth grid (plan with the touch-voltage heatmap).
 * Geometry and every number come from the backend — nothing is recomputed
 * here except which map points fall inside the touch area.
 */

const EarthGridEditor = {
  activeId: null,     // grid shown in the editor
  busId: null,        // bus the editor was opened from (Create from bus / Use for bus)
  _bound: false,
  _previewTimer: null,
  _previewSeq: 0,
  _undoTimer: null,
  _lastPreview: null,

  // Defaults for a new grid — the same values as a new bus's grounding fields
  // (COMPONENT_DEFS.bus.defaults), so "Create from bus" and "New" agree.
  DEFAULT: {
    soil: { rho1: 100, two_layer: 'off', rho2: 100, h1: 3.0 },
    surface: { rho_s: 2500, h_s: 0.15 },
    conductor: { material: 'copper_hard', diameter_m: 0.01167, depth_m: 0.5, joint: 'exothermic' },
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
  list() {
    if (!Array.isArray(AppState.earthGrids)) AppState.earthGrids = [];
    return AppState.earthGrids;
  },
  get(id) { return this.list().find(g => g.id === id) || null; },
  current() { return this.get(this.activeId) || this.list()[0] || null; },
  busesUsing(id) {
    return [...AppState.components.values()].filter(c => c.type === 'bus' && c.props && c.props.earth_grid_id === id);
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
    for (const k of ['soil', 'surface', 'conductor', 'layout', 'rods', 'en50522']) {
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
      conductor: { material: s('conductor_material', 'copper_hard'), diameter_m: v('conductor_diameter', 0.01167),
        depth_m: v('grid_depth', 0.5), joint: s('grid_joint_type', 'exothermic') },
      layout: { type: 'rect', length_x: v('grid_length', 30), width_y: v('grid_width', 30),
        n_x: Math.round(v('num_conductors_x', 6)), n_y: Math.round(v('num_conductors_y', 6)),
        x_lines: null, y_lines: null, notch_x: v('grid_length', 30) / 2, notch_y: v('grid_width', 30) / 2, diagonals: 'none' },
      rods: { rule: 'perimeter_even', count: Math.round(v('num_ground_rods', 20)), length_m: v('ground_rod_length', 3.0), diameter_m: 0.016 },
      fences: [], extra_conductors: [], extra_rods: [],
      method: 'auto', limits: 'ieee80', body_weight: v('body_weight', 70) === 50 ? 50 : 70,
      en50522: { footwear_ohm: 0, hand_ohm: 0, measures_m: 'no' },
      element_length_m: 1.0,
    };
  },

  // Mark the project changed. commit = a finished edit: drop the (now stale)
  // grounding result and record one undo step (debounced so a burst of
  // pasted cells is one step).
  _changed(commit) {
    AppState.dirty = true;
    if (!commit) return;
    if (AppState.groundingResults) AppState.groundingResults = null;
    clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => {
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    }, 150);
  },

  // Undo/redo replaced AppState.earthGrids — show what is there now.
  onStateRestored() {
    if (!this._isOpen()) return;
    if (!this.get(this.activeId)) this.activeId = (this.list()[0] || {}).id || null;
    this.render();
  },

  // ── Modal ──────────────────────────────────────────────────────────
  _el(id) { return document.getElementById(id); },
  _isOpen() { const m = this._el('earth-grid-modal'); return !!m && m.style.display !== 'none'; },

  open(opts = {}) {
    this._bind();
    this.busId = opts.busId || null;
    const bus = this.busId ? AppState.components.get(this.busId) : null;
    if (bus && bus.props.earth_grid_id && this.get(bus.props.earth_grid_id)) this.activeId = bus.props.earth_grid_id;
    if (!this.get(this.activeId)) this.activeId = (this.list()[0] || {}).id || null;
    this.list().forEach(g => this._normalize(g));
    this._el('earth-grid-modal').style.display = '';
    this.render();
  },

  close() {
    this._el('earth-grid-modal').style.display = 'none';
    clearTimeout(this._previewTimer);
    // The bus panel lists the grids by name — refresh it.
    if (typeof Properties !== 'undefined' && Properties.currentId && AppState.components.has(Properties.currentId)) {
      Properties.show(Properties.currentId);
    }
  },

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const m = this._el('earth-grid-modal');
    this._el('btn-close-earth-grid').addEventListener('click', () => this.close());
    m.addEventListener('click', (e) => { if (e.target === m) this.close(); });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('.gt-grid')) this.close(); });

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
      AppState.earthGrids = this.list().filter(x => x !== g);
      for (const b of users) delete b.props.earth_grid_id;
      this.activeId = (this.list()[0] || {}).id || null;
      this._changed(true);
      this.render();
    } else if (act === 'from-bus') {
      const bus = AppState.components.get(this.busId);
      if (!bus) return;
      const g2 = this.create(`${bus.props.name || bus.id} grid`, this.fromBus(bus));
      bus.props.earth_grid_id = g2.id;
      this._changed(true);
      this.render();
    } else if (act === 'use' && g) {
      const bus = AppState.components.get(this.busId);
      if (!bus) return;
      bus.props.earth_grid_id = g.id;
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
        ${this._bus() && !this._bus().props.earth_grid_id ? '<button type="button" class="btn btn-secondary" data-eg-act-empty="from-bus">Create from bus</button>' : ''}
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
      if (!bus.props.earth_grid_id) {
        ctx = `<div class="eg-ctx"><span>Opened from <b>${busName}</b>, which uses its own grounding fields.</span>
          <button type="button" class="lr-mini" data-eg-act="from-bus" title="Make an earth grid from this bus's grid, soil, surface, conductor and rod fields — gives the same result — and use it for the bus">Create from bus</button>
          ${cur ? `<button type="button" class="lr-mini" data-eg-act="use">Use “${escHtml(cur.name)}”</button>` : ''}</div>`;
      } else if (cur && bus.props.earth_grid_id !== cur.id) {
        ctx = `<div class="eg-ctx"><span><b>${busName}</b> uses “${escHtml((this.get(bus.props.earth_grid_id) || {}).name || bus.props.earth_grid_id)}”.</span>
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
        { p: 'conductor.diameter_m', label: 'Diameter', unit: 'm', min: 0.001 },
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
        { p: 'rods.diameter_m', label: 'Rod diameter', unit: 'm', min: 0.001, show: rodsOn },
      ] },
      { id: 'fences', title: 'Fences', table: 'fences' },
      { id: 'extra_conductors', title: 'Added conductors', table: 'extra_conductors' },
      { id: 'extra_rods', title: 'Added rods', table: 'extra_rods' },
      { id: 'calc', title: 'Calculation', fields: [
        { p: 'method', label: 'Method', type: 'select', options: [
          ['auto', 'Auto — IEEE 80 where it applies, else numerical'], ['ieee80', 'IEEE 80 simplified equations'], ['numerical', 'Numerical (method of moments)']] },
        { p: 'limits', label: 'Limit basis', type: 'select', options: [['ieee80', 'IEEE 80 (body weight)'], ['en50522', 'EN 50522 (U_Tp)']] },
        { p: 'body_weight', label: 'Body weight', type: 'select', num: true, show: ieee, options: [[50, '50 kg'], [70, '70 kg']] },
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
        { k: 'post_diameter_m', label: 'Post Ø (m)', min: 0.001 },
        { k: 'conductor_offset_m', label: 'Conductor offset (m)', optional: true, ph: 'none' },
        { k: 'conductor_depth_m', label: 'Conductor depth (m)', min: 0.01 },
      ],
    },
    extra_conductors: {
      hint: 'Straight conductors in grid coordinates (m, origin at the lower-left corner). Depth / Ø blank = the grid conductor.',
      add: 'Add conductor',
      cols: [
        { k: 'x1', label: 'x₁' }, { k: 'y1', label: 'y₁' }, { k: 'x2', label: 'x₂' }, { k: 'y2', label: 'y₂' },
        { k: 'depth_m', label: 'Depth (m)', optional: true, ph: 'grid', min: 0.01 },
        { k: 'diameter_m', label: 'Ø (m)', optional: true, ph: 'grid', min: 0.001 },
        { k: 'bonded', label: 'Earthing', type: 'bond' },
      ],
    },
    extra_rods: {
      hint: 'Rods at any point (m). Length / Ø blank = the rod settings above.',
      add: 'Add rod',
      cols: [
        { k: 'x', label: 'x' }, { k: 'y', label: 'y' },
        { k: 'length_m', label: 'Length (m)', optional: true, ph: 'rods', min: 0.1 },
        { k: 'diameter_m', label: 'Ø (m)', optional: true, ph: 'rods', min: 0.001 },
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
      input = `<input type="number" id="${id}" data-eg-p="${f.p}" value="${v == null ? '' : escHtml(String(v))}" step="${f.step || 'any'}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
    }
    const unit = f.unit ? `<span class="eg-u">${escHtml(f.unit)}</span>` : '';
    const hint = f.hint ? `<div class="eg-hint">${escHtml(f.hint)}</div>` : '';
    return `<div class="eg-fld${f.type === 'lines' ? ' eg-fld-wide' : ''}" data-eg-fld="${f.p}"><label for="${id}">${escHtml(f.label)}</label>
      <div class="eg-in">${input}${unit}</div>${hint}</div>`;
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
      return `${td}<input type="number" step="any" ${attrs}${c.optional ? ' data-eg-opt' : ''} value="${v == null || v === '' ? '' : escHtml(String(v))}"${c.ph ? ` placeholder="${escHtml(c.ph)}"` : ''}></td>`;
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
            if (commit) { t.value = row[k] == null ? '' : row[k]; t.classList.remove('input-invalid'); }
            return;
          }
          row[k] = n;
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
        // Out of range (min/max, a notch inside the grid): refuse — keep the stored value
        let max = f.max;
        if (p === 'layout.notch_x') max = +g.layout.length_x;
        if (p === 'layout.notch_y') max = +g.layout.width_y;
        const out = !Number.isFinite(n) || (f.min != null && n < f.min) || (max != null && n > max);
        if (out) {
          t.classList.add('input-invalid');
          t.title = Number.isFinite(n) ? `Allowed: ${f.min != null ? f.min : '…'} to ${max != null ? this._n(max) : '…'}` : 'Enter a number';
          if (commit) { const keep = this._get(g, p); t.value = keep == null ? '' : keep; t.classList.remove('input-invalid'); }
          return;
        }
        t.classList.remove('input-invalid'); t.title = '';
        if (f.step === 1) val = Math.round(n); else val = n;
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
      if (this._lastPreview && status) {
        box.querySelector('.eg-pv-plan')?.classList.add('eg-stale');
        status.innerHTML = `<div class="eg-pv-err">${escHtml(err)}</div>`;
      } else {
        box.innerHTML = `<div class="eg-pv-plan"></div><div class="eg-pv-status"><div class="eg-pv-err">${escHtml(err)}</div></div>`;
      }
      return;
    }
    this._lastPreview = res;
    const lines = [];
    lines.push(`<div class="eg-pv-stats"><span><b>${res.elements}</b> elements</span>
      <span class="${res.connected ? 'eg-ok' : 'eg-warn'}">${res.connected ? 'Connected' : `Not connected — ${res.pieces} separate bonded pieces`}</span></div>`);
    lines.push(res.ieee80_applicable
      ? '<div class="eg-pv-app eg-ok">IEEE 80 simplified equations apply</div>'
      : `<div class="eg-pv-app">Numerical method — ${escHtml(res.ieee80_not_applicable_reason || 'IEEE 80 simplified equations do not apply')}</div>`);
    if (res.notes && res.notes.length) lines.push(`<ul class="eg-pv-notes">${res.notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>`);
    box.innerHTML = `<div class="eg-pv-plan">${this.planSvg(res.plan, { label: g.name })}</div>
      ${this._planKeyHtml(res.plan)}
      <div class="eg-pv-status">${lines.join('')}</div>`;
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
    return `<svg class="eg-plan" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"
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
        <div>Conductor: <strong>${b.recommended_conductor_mm2} mm²</strong>${b.min_conductor_mm2 != null ? ` <span class="eg-muted">(min ${(+b.min_conductor_mm2).toFixed(1)})</span>` : ''}</div>
        <div>Rods: <strong>${b.num_ground_rods}</strong></div>
        <div>L<sub>total</sub>: <strong>${b.total_conductor_length_m} m</strong></div>
        <div>Area: <strong>${b.grid_area_m2} m²</strong></div>
      </div>
      <div class="eg-tv">
        <div><div><strong>Touch Voltage</strong> ${ok(b.touch_ok)}</div>
          <div>Actual: <strong>${f0(b.mesh_voltage_v)} V</strong></div>
          <div>Limit: <strong>${f0(b.tolerable_touch_v)} V</strong> <span class="eg-muted">${en ? 'U<sub>vTp</sub>' : ''}</span></div></div>
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
