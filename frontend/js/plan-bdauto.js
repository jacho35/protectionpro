/* ProtectionPro — Building auto circuits (Plan › Sync › Auto circuits…).
 *
 * The Building plan's circuiting tool, the client of POST /api/analysis/building-circuits
 * (backend/analysis/building_circuits.py): for the active floor it
 *   · assigns each room to one of the boards ALREADY PLACED (never adds one),
 *   · groups the devices into circuits under the project's rules,
 *   · routes every circuit to its board in one of three modes — follow drawn containment,
 *     along the walls, or straight through the ceiling —
 * and shows the proposal (preview coloured by circuit + Checks) before anything is written.
 * Create tags the devices (`circuitDbId` / `circuitNo` / `circuitAuto`), draws the routes (`auto: 'power'`),
 * lets PlanCircuits.syncAll() make the ways, and sets each way's phase and earth-leakage group.
 * The next Create replaces only what this tool made; devices tagged by hand and ways made by hand are never touched.
 *
 * Settings live in `planMarkup.settings.circuiting`. `buildRequest` / `previewSvg` are pure (node-testable).
 */

const PlanBdAuto = {
  CONTAINMENT: ['conduit', 'cable_tray', 'power_skirting'],
  COLORS: ['#1f5fd1', '#0f8a7e', '#7a3fc4', '#c2570c', '#b4232c', '#2b7a0b', '#a1306f', '#5a6b7a'],
  MODES: [
    { id: 'containment', name: 'Follow containment', sub: 'Along drawn tray, trunking and conduit' },
    { id: 'walls', name: 'Along walls', sub: 'Round room outlines, through shared walls' },
    { id: 'ceiling', name: 'Direct in ceiling', sub: 'Straight lines in the ceiling void, with drops' },
  ],
  DEFAULTS: {
    mode: 'walls', ways_per_board: 0, overrides: {},
    rules: { max_points: { light: 10, socket: 6, other: 6 }, dedicated_va: 2000, spare_ways: 3, el_group_size: 4, slack_pct: 10 },
  },

  // ── Settings ──────────────────────────────────────────────────────────
  settings(pm = AppState.planMarkup) {
    const st = pm.settings = pm.settings || {};
    const c = st.circuiting = st.circuiting || {};
    const d = this.DEFAULTS;
    if (!['containment', 'walls', 'ceiling'].includes(c.mode)) c.mode = d.mode;
    if (c.ways_per_board == null) c.ways_per_board = d.ways_per_board;
    c.overrides = c.overrides || {};
    c.rules = c.rules || {};
    c.rules.max_points = { ...d.rules.max_points, ...(c.rules.max_points || {}) };
    for (const k of ['dedicated_va', 'spare_ways', 'el_group_size', 'slack_pct']) if (c.rules[k] == null) c.rules[k] = d.rules[k];
    return c;
  },

  // ── Pure: the request ─────────────────────────────────────────────────
  _inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  },

  // model: { pm: {elements, rooms, routes, scale}, boards: [{el, comp}], settings }
  // → { req, error, handTagged }.  Lengths in metres (px × the floor's scale factor).
  buildRequest(model) {
    const pm = model.pm, st = model.settings;
    const f = pm.scale && pm.scale.factor;
    if (!(f > 0)) return { error: 'Set the plan scale first (Calibrate from a known length).' };
    const m = (v) => +(v * f).toFixed(4);
    const rooms = (pm.rooms || []).filter(r => (!r.kind || r.kind === 'room') && (r.points || []).length >= 3);
    const devices = [];
    let handTagged = 0;
    for (const e of pm.elements || []) {
      if (!PlanCircuits.isCircuitDevice(e.type) || !PlanCircuits.carriesLoad(e)) continue;
      const p = e.props || {};
      if (p.circuitDbId && !p.circuitAuto) { handTagged++; continue; }
      const room = rooms.find(r => this._inPoly(e.x, e.y, r.points));
      devices.push({ id: e.id, type: e.type, room_id: room ? room.id : null, x: m(e.x), y: m(e.y),
        va: PlanCircuits.deviceVA(e), poles: PlanCircuits.devicePoles(e) });
    }
    const boards = (model.boards || []).map(b => {
      const own = ((b.comp && b.comp.props.circuits) || []).filter(c => c.auto !== 'power');
      const used = own.reduce((n, c) => Math.max(n, parseInt(c.way, 10) || 0), 0);
      return { id: b.el.id, name: b.el.name || 'DB', x: m(b.el.x), y: m(b.el.y), floor: 1, ways_used: used,
        ...(Number(st.ways_per_board) > 0 ? { ways_total: Number(st.ways_per_board) } : {}) };
    });
    const containment = (pm.routes || []).filter(r => this.CONTAINMENT.includes(r.type) && (r.points || []).length >= 2)
      .map(r => r.points.map(p => [m(p.x), m(p.y)]));
    const req = {
      mode: st.mode, mode_overrides: st.overrides || {}, boards,
      rooms: rooms.map(r => ({ id: r.id, name: r.name, floor: 1, polygon: r.points.map(p => [m(p.x), m(p.y)]),
        ...(Number(r.lighting && r.lighting.ceilH) > 0 ? { ceil_h: Number(r.lighting.ceilH) } : {}) })),
      devices, containment, rules: st.rules,
    };
    if (!boards.length) return { error: 'Place a distribution board on this floor first.', req };
    if (!devices.length) return { req, handTagged, error: handTagged
      ? `Every load on this floor (${handTagged}) is already on a circuit you set. Auto circuits leaves those alone: clear their circuit tags to include them.`
      : 'No lights, sockets or other loads to circuit on this floor.' };
    return { req, handTagged };
  },

  // ── Pure: the preview ─────────────────────────────────────────────────
  previewSvg(pm, result, boards) {
    const f = pm.scale.factor;
    const pts = [];
    for (const r of pm.rooms || []) for (const p of r.points || []) pts.push([p.x * f, p.y * f]);
    for (const b of boards || []) pts.push([b.el.x * f, b.el.y * f]);
    for (const e of pm.elements || []) pts.push([e.x * f, e.y * f]);
    if (!pts.length) return '';
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const pad = 1.5, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
    const circ = result ? result.circuits : [];
    const colorOf = new Map(); circ.forEach((c, i) => colorOf.set(c.id, this.COLORS[i % this.COLORS.length]));
    const devColor = new Map();
    for (const c of circ) for (const id of c.device_ids) devColor.set(id, c.status === 'ok' ? colorOf.get(c.id) : '#b4232c');
    const sw = Math.max(w, h) / 400;
    const rooms = (pm.rooms || []).filter(r => (r.points || []).length >= 3 && (!r.kind || r.kind === 'room'))
      .map(r => `<polygon points="${r.points.map(p => (p.x * f).toFixed(2) + ',' + (p.y * f).toFixed(2)).join(' ')}" fill="none" stroke="#1c2330" stroke-width="${(sw * 1.6).toFixed(3)}"/>`).join('');
    const routes = circ.filter(c => c.route).map(c => `<polyline points="${c.route.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ')}" fill="none" stroke="${colorOf.get(c.id)}" stroke-width="${(sw * 1.3).toFixed(3)}" stroke-dasharray="${(sw * 5).toFixed(2)} ${(sw * 3).toFixed(2)}"/>`).join('');
    const devs = (pm.elements || []).filter(e => devColor.has(e.id))
      .map(e => `<circle cx="${(e.x * f).toFixed(2)}" cy="${(e.y * f).toFixed(2)}" r="${(sw * 3).toFixed(3)}" fill="${devColor.get(e.id)}" stroke="#fff" stroke-width="${(sw * 0.6).toFixed(3)}"/>`).join('');
    const bds = (boards || []).map(b => `<rect x="${(b.el.x * f - sw * 4).toFixed(2)}" y="${(b.el.y * f - sw * 4).toFixed(2)}" width="${(sw * 8).toFixed(2)}" height="${(sw * 8).toFixed(2)}" fill="#1c2330"/>`
      + `<text x="${(b.el.x * f + sw * 6).toFixed(2)}" y="${(b.el.y * f + sw * 2).toFixed(2)}" font-size="${(sw * 9).toFixed(2)}" font-weight="600" fill="#1c2330">${escHtml(b.el.name || 'DB')}</text>`).join('');
    return `<svg viewBox="${x0.toFixed(2)} ${y0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Floor preview with the proposed circuits coloured and routed to their boards">${rooms}${routes}${devs}${bds}</svg>`;
  },

  // ── Model from the live plan ──────────────────────────────────────────
  _model() {
    const pm = AppState.planMarkup;
    const boards = (pm.elements || []).filter(e => e.type === 'bd_db')
      .map(el => ({ el, comp: el.sldId ? AppState.components.get(el.sldId) : null }));
    return { pm, boards, settings: this.settings(pm) };
  },

  // ── Create ────────────────────────────────────────────────────────────
  // Remove what an earlier Create made on this floor: device tags, routes, ways.
  _clearAuto(model) {
    const { pm } = model;
    for (const e of pm.elements || []) {
      const p = e.props;
      if (p && p.circuitAuto) { delete p.circuitDbId; delete p.circuitNo; delete p.circuitWid; delete p.circuitAuto; }
    }
    pm.routes = (pm.routes || []).filter(r => r.auto !== 'power');
    for (const b of model.boards) {
      if (b.comp && Array.isArray(b.comp.props.circuits)) b.comp.props.circuits = b.comp.props.circuits.filter(c => c.auto !== 'power');
    }
  },

  async create(model, result) {
    const { pm } = model;
    const used = new Set(result.circuits.map(c => c.board_id));
    const unlinked = model.boards.filter(b => used.has(b.el.id) && !b.comp);
    if (unlinked.length && typeof PlanSync !== 'undefined') {
      await PlanSync.syncBuildingToSLD();
      for (const b of model.boards) b.comp = b.el.sldId ? AppState.components.get(b.el.sldId) : null;
    }
    this._clearAuto(model);
    const f = pm.scale.factor;
    const els = new Map((pm.elements || []).map(e => [e.id, e]));
    const boardById = new Map(model.boards.map(b => [b.el.id, b]));
    let routes = 0;
    for (const c of result.circuits) {
      const b = boardById.get(c.board_id);
      if (!b) continue;
      for (const id of c.device_ids) {
        const e = els.get(id);
        if (!e) continue;
        e.props = e.props || {};
        e.props.circuitDbId = b.el.id; e.props.circuitNo = String(c.way); e.props.circuitAuto = true;
      }
      if (c.route && c.route.length >= 2) {
        const at = new Map(c.device_ids.map(id => [id, els.get(id)]).filter(x => x[1]).map(([id, e]) => [id, { x: e.x * f, y: e.y * f }]));
        const points = c.route.map((p, i) => {
          const pt = { x: p[0] / f, y: p[1] / f };
          if (i === 0) pt.snappedTo = b.el.id;
          else for (const [id, q] of at) if (Math.abs(q.x - p[0]) < 1e-3 && Math.abs(q.y - p[1]) < 1e-3) { pt.snappedTo = id; break; }
          return pt;
        });
        pm.routes.push({ id: AppState.planGenId('pmrt'), type: c.group === 'light' ? 'lighting_ckt' : 'circuit',
          fromId: b.el.id, toId: c.device_ids[c.device_ids.length - 1], points, cableType: '', curved: false, props: {}, auto: 'power' });
        routes++;
      }
    }
    PlanCircuits.syncAll();
    // each way: what made it, its phase and earth-leakage group
    let ways = 0;
    for (const c of result.circuits) {
      const b = boardById.get(c.board_id);
      const e = els.get(c.device_ids[0]);
      if (!b || !b.comp || !e) continue;
      const wid = e.props && e.props.circuitWid;
      const way = (b.comp.props.circuits || []).find(w => (wid && w.id === wid) || String(w.way) === String(c.way));
      if (!way) continue;
      way.auto = 'power';
      if (!way._polesManual) { way.poles = c.poles; way.phase = c.phase; }
      if (c.el_group && !way.el_group) { way.el_group = c.el_group; if (!Number(way.leakage_ma)) way.leakage_ma = 30; }
      ways++;
      if (typeof DBSchedule !== 'undefined' && DBSchedule.recompute) DBSchedule.recompute(b.comp);
    }
    PlanMarkup.markDirty(); PlanMarkup._snapshot();
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot('Auto circuits');
    if (typeof PlanUI !== 'undefined') { PlanUI.renderProps(); PlanUI.renderPalette(); }
    PlanEngine.requestDraw({ fg: true });
    return { ways, routes };
  },

  // ── Dialog ────────────────────────────────────────────────────────────
  _seq: 0,
  open() {
    if (this._m) this._m.remove();
    const model = this._model();
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Auto circuits');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    m.innerHTML = `<div class="modal-content pba" style="display:flex;flex-direction:column;max-height:92vh">
      <div class="modal-header"><h3>Auto circuits</h3><button class="modal-close" data-pba="close" aria-label="Close">&times;</button></div>
      <div class="pba-body"><div class="pba-view" id="pba-view"></div><div class="pba-panel" id="pba-panel"></div></div></div>`;
    document.body.appendChild(m);
    this._m = m;
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-pba="close"]')) this.close(); });
    m.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    m.addEventListener('change', e => this._onChange(e, m));
    m.addEventListener('click', e => this._onClick(e, m));
    this._result = null;
    this._renderPanel(m, model);
    this.run();
  },
  close() { if (this._m) { this._m.remove(); this._m = null; } },

  _onChange(e, m) {
    const t = e.target, st = this.settings();
    if (t.matches('[name="pba-mode"]')) { st.mode = t.value; }
    else if (t.dataset.pbaRule) {
      const [k, sub] = t.dataset.pbaRule.split('.');
      const v = Number(t.value);
      if (!(v >= 0)) return;
      if (sub) st.rules[k][sub] = v; else if (k === 'ways_per_board') st.ways_per_board = v; else st.rules[k] = v;
    } else return;
    AppState.dirty = true;
    this.run();
  },
  _onClick(e, m) {
    const b = e.target.closest('[data-pba-fix]');
    if (b) {
      const ov = JSON.parse(b.dataset.pbaFix);
      Object.assign(this.settings().overrides, ov);
      AppState.dirty = true;
      this.run();
      return;
    }
    if (e.target.closest('[data-pba="reset-overrides"]')) { this.settings().overrides = {}; this.run(); return; }
    if (e.target.closest('[data-pba="create"]')) this._create(m);
  },

  async run() {
    const m = this._m;
    if (!m) return;
    const my = ++this._seq;
    const model = this._model();
    const built = this.buildRequest(model);
    const out = m.querySelector('#pba-result');
    this._result = null;
    if (built.error) {
      m.querySelector('#pba-view').innerHTML = '';
      out.innerHTML = `<div class="pba-empty">${escHtml(built.error)}</div>`;
      this._syncCreate(m);
      return;
    }
    out.innerHTML = '<div class="pba-empty">Working it out…</div>';
    try {
      const res = await API.buildingCircuits(built.req);
      if (my !== this._seq || !this._m) return;
      this._result = res; this._model_ = model; this._hand = built.handTagged;
      m.querySelector('#pba-view').innerHTML = this.previewSvg(model.pm, res, model.boards);
      this._renderResult(m, res, built.handTagged);
    } catch (e) {
      if (my !== this._seq) return;
      out.innerHTML = `<div class="pba-empty">Could not work it out: ${escHtml(e.message)}</div>`;
    }
    this._syncCreate(m);
  },

  _renderPanel(m, model) {
    const st = model.settings, r = st.rules;
    const num = (key, label, val, step = 1) => `<label class="pba-num">${label}<input type="number" min="0" step="${step}" value="${escHtml(val)}" data-pba-rule="${escHtml(key)}"></label>`;
    m.querySelector('#pba-panel').innerHTML = `
      <section><h4>Route mode</h4>
        ${this.MODES.map(o => `<label class="pba-mode${st.mode === o.id ? ' on' : ''}"><input type="radio" name="pba-mode" value="${o.id}"${st.mode === o.id ? ' checked' : ''}><span><b>${o.name}</b><small>${o.sub}</small></span></label>`).join('')}
        <small class="pba-note" id="pba-ovr"></small>
      </section>
      <details class="pba-rules"><summary>Rules</summary>
        <div class="pba-grid">
          ${num('max_points.light', 'Lights per circuit', r.max_points.light)}
          ${num('max_points.socket', 'Sockets per circuit', r.max_points.socket)}
          ${num('max_points.other', 'Other points per circuit', r.max_points.other)}
          ${num('dedicated_va', 'Own circuit from (VA)', r.dedicated_va, 100)}
          ${num('spare_ways', 'Spare ways on a board', r.spare_ways)}
          ${num('ways_per_board', 'Ways per board (0 = no limit)', st.ways_per_board)}
          ${num('el_group_size', 'Ways per earth-leakage unit', r.el_group_size)}
          ${num('slack_pct', 'Cable allowance (%)', r.slack_pct)}
        </div>
      </details>
      <div id="pba-result"></div>
      <div class="pba-foot"><button class="btn-small btn-primary" data-pba="create" disabled>Create</button>
        <small>Replaces what Auto circuits made before. Devices you tagged by hand and ways you made by hand are not touched. One undo step.</small></div>`;
  },

  _renderResult(m, res, hand) {
    const t = res.totals, out = m.querySelector('#pba-result');
    const ovr = Object.keys(this.settings().overrides).length;
    m.querySelector('#pba-ovr').innerHTML = ovr ? `${ovr} circuit${ovr === 1 ? ' is' : 's are'} set to direct in ceiling · <button type="button" class="pba-link" data-pba="reset-overrides">reset</button>` : '';
    const sev = { fail: 'Fail', warn: 'Warn', pass: 'Pass' };
    const checks = res.checks.map(c => `<div class="pba-chk pba-${escHtml(c.severity)}"><b>${sev[c.severity] || c.severity}</b><span>${escHtml(c.text)}</span>${c.fix && c.fix.mode_override ? `<button type="button" class="btn-small" data-pba-fix='${escHtml(JSON.stringify(c.fix.mode_override))}'>Use direct</button>` : ''}</div>`).join('');
    out.innerHTML = `<div class="pba-tiles"><div><b>${t.circuits}</b><small>circuits</small></div><div><b>${t.devices}</b><small>devices</small></div><div><b>${t.cable_m} m</b><small>cable</small></div></div>
      ${hand ? `<small class="pba-note">${hand} device${hand === 1 ? '' : 's'} tagged by hand ${hand === 1 ? 'is' : 'are'} left as ${hand === 1 ? 'it is' : 'they are'}.</small>` : ''}
      <section><h4>Checks</h4>${checks}</section>`;
  },
  _syncCreate(m) {
    const b = m.querySelector('[data-pba="create"]');
    const r = this._result;
    b.disabled = !r || !r.circuits.length;
    b.textContent = r && r.circuits.length ? `Create ${r.circuits.length} circuits and routes` : 'Create';
  },

  async _create(m) {
    const res = this._result, model = this._model_;
    if (!res || !model) return;
    try {
      const o = await this.create(this._model(), res);
      this.close();
      if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Made ${o.ways} way${o.ways === 1 ? '' : 's'} and ${o.routes} route${o.routes === 1 ? '' : 's'}.`, 'info');
    } catch (e) {
      if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Could not create the circuits: ${e.message}`, 'warn');
    }
  },
};

if (typeof module !== 'undefined') module.exports = PlanBdAuto;
