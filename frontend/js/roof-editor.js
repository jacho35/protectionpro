/* ProtectionPro — RoofEditor: the Plan tab's roof editor. The plan and a live 3D view sit side by side; both edit the
 * same roofs (`planMarkup.settings.solar.roofs`, see plan-solar.js).
 *
 * Layout (a dock inside #plan-main while `on`): a vertical tool palette (Select, Footprint, Push/pull, Ridge, Planes,
 * Transform, Objects) · the plan · the 3D view (named views, shade preview, Use in Solar PV Design) · the properties
 * column, and a status bar under the plan: the typed value (Enter applies it to what the tool is doing), the X / Y / Z
 * axis lock and the snap. Opened from Plan › Solar › Roof editor or Solar PV Design › View in 3D.
 *
 * The tools: Select is the plan's own (corners drag, Shift-click adds one, Alt-click or double-click removes one);
 * Footprint is the plan's roof Draw mode, in the plan or on the ground in 3D, a typed length places the next corner, Enter
 * closes it and the new roof goes straight to Push/pull; Push/pull, Ridge, Planes, Transform and Objects are `Roof3D` tools
 * (handles, a gizmo, picks) with the plan's `roofedit` tool picking roofs and placing objects there.
 * The 3D scene, picks, gizmo and typed values live in roof3d.js; the geometry in roof-planes.js. Changes come back
 * through PlanSolar, and a change made anywhere (the plan, undo, the Solar modal) is noticed on the next plan redraw.
 */
const RoofEditor = {
  on: false,
  TOOLS: [
    ['select', 'Select', 'V', 'M5 3 L5 18 L9.5 14 L13 21 L15.5 20 L12 13 L18 13 Z',
      'Click a roof, plane, edge or object. Shift-click an edge adds a corner, Alt-click a corner removes it, double-click does either. Drag a corner to move it.', 'Length'],
    ['footprint', 'Footprint', 'D', 'M4 18 L4 7 L12 4 L20 9 L18 19 Z',
      'Click corners on the plan or on the ground in 3D. Type a length and press Enter to place the next corner exactly. Enter closes the footprint, Backspace takes a corner back.', 'Length'],
    ['pushpull', 'Push/pull', 'P', 'M4 16 L12 20 L20 16 L12 12 Z M12 12 V3 M9 6 L12 3 L15 6',
      'Drag the blue handle up to set the eave height. Type 3.2 and Enter to set it exactly. The walls grow with it.', 'Height'],
    ['ridge', 'Ridge', 'H', 'M3 17 L12 8 L21 17 M12 8 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0',
      'Drag the ridge handle up to change the pitch (a pyramid: the apex height). Type a pitch and Enter to set it exactly.', 'Pitch'],
    ['planes', 'Planes', 'F', 'M4 18 L10 5 L20 9 L16 20 Z M10 5 L16 20',
      'Click a face to select it. Pick the roof type below (gable, hip, mono-pitch, pyramid, cross-gable, flat), a lean-to, and which planes carry modules.', 'Pitch'],
    ['transform', 'Transform', 'G', 'M12 3 V21 M3 12 H21 M9 6 L12 3 L15 6 M9 18 L12 21 L15 18 M6 9 L3 12 L6 15 M18 9 L21 12 L18 15',
      'Move, turn or scale the selected roof or object. Drag an arrow to lock to that axis, or type a value and press Enter.', 'Distance'],
    ['object', 'Objects', 'O', 'M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 V21',
      'Pick an object below, then click a roof plane. It sits on the plane, snaps to the grid and shades the modules around it.', 'Height'],
  ],
  LEANS: [['none', 'None', null], ['A', 'Shallow, north', { side: 'front', kind: 'under', depth: 3, pitch: 8 }],
    ['B', 'Catslide', { side: 'front', kind: 'catslide', depth: 3 }], ['C', 'East end', { side: 'end', kind: 'under', depth: 3, pitch: 11 }],
    ['D', 'Steeper, north', { side: 'front', kind: 'under', depth: 3, pitch: 20 }]],

  _esc(x) { return String(x).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); },
  _def(id) { return this.TOOLS.find(t => t[0] === id) || this.TOOLS[0]; },

  // ── Open / close ──
  _build() {
    if (document.getElementById('re-dock')) return;
    const main = document.getElementById('plan-main'), col = main && main.querySelector('.plan-stage-col');
    if (!main || !col) return;
    const tools = document.createElement('div');
    tools.id = 're-tools'; tools.className = 're-tools'; tools.hidden = true; tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', 'Roof editor tools');
    tools.innerHTML = this.TOOLS.map(t => `<button type="button" class="re-tool" data-re-tool="${t[0]}" aria-label="${t[1]}, ${t[2]}" title="${t[1]} (${t[2]})"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${t[3]}"/></svg><span>${t[1]}</span></button>`).join('');
    main.insertBefore(tools, col);
    const dock = document.createElement('section');
    dock.id = 're-dock'; dock.className = 're-dock'; dock.hidden = true; dock.setAttribute('aria-label', 'Roof 3D view and properties');
    dock.innerHTML = `<div class="re-head">
        <div class="re-title"><b id="re-name">3D</b><span>orbit: drag · pan: right-drag · zoom: wheel</span></div>
        <div class="re-views" role="group" aria-label="Named views">${[['top', 'Top'], ['north', 'From north'], ['east', 'From east'], ['iso', 'Iso']].map(v => `<button type="button" class="re-btn" data-re-view="${v[0]}">${v[1]}</button>`).join('')}</div>
        <label class="re-field">Sun <select id="re-hour"><option value="-45">09:00</option><option value="-30">10:00</option><option value="0" selected>Noon</option><option value="30">14:00</option><option value="45">15:00</option></select></label>
        <button type="button" class="re-btn" id="re-shade" aria-pressed="true">Shade preview</button>
        <button type="button" class="re-btn re-primary" id="re-use">Use in Solar PV Design</button>
        <button type="button" class="re-btn" id="re-close" aria-label="Close the roof editor" title="Close the roof editor">✕</button>
      </div>
      <div class="re-body"><div id="re-view" class="re-view"></div><aside id="re-panel" class="re-panel" aria-label="Roof properties"></aside></div>
      <div id="re-msg" class="re-msg" role="status"></div>`;
    main.insertBefore(dock, col.nextSibling);
    const status = document.createElement('div');
    status.id = 're-status'; status.className = 're-status'; status.hidden = true;
    status.innerHTML = `<label for="re-vcb" id="re-vcb-l">Length</label><input id="re-vcb" type="text" inputmode="decimal" autocomplete="off" aria-describedby="re-vcb-h"><span id="re-vcb-h" class="re-hint">Type a value, Enter to apply</span>
      <span class="re-sp"></span><span class="re-hint">Lock axis</span>
      ${['x', 'y', 'z'].map(a => `<button type="button" class="re-btn re-axis" data-re-axis="${a}" aria-pressed="false" aria-label="Lock to the ${a.toUpperCase()} axis">${a.toUpperCase()}</button>`).join('')}
      <span class="re-hint">Snap: 5 cm · corners · edges · roof planes</span>`;
    col.appendChild(status);
    tools.addEventListener('click', (e) => { const b = e.target.closest('[data-re-tool]'); if (b) this.setTool(b.dataset.reTool); });
    dock.addEventListener('click', (e) => this._onClick(e));
    dock.addEventListener('change', (e) => this._onChange(e));
    status.addEventListener('click', (e) => { const b = e.target.closest('[data-re-axis]'); if (b) this.setAxis(b.dataset.reAxis); });
    status.querySelector('#re-vcb').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = e.target.value; if (Roof3D.applyTyped(v)) { e.target.value = ''; } e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
      e.stopPropagation();
    });
    for (const el of [tools, dock]) el.addEventListener('keydown', (e) => this._onKey(e));
  },

  async open() {
    if (typeof window.switchWorkspace === 'function') window.switchWorkspace('plan');
    this._build();
    const main = document.getElementById('plan-main'); if (!main) return;
    this.on = true;
    main.classList.add('re-on');
    for (const id of ['re-tools', 're-dock', 're-status']) { const el = document.getElementById(id); if (el) el.hidden = false; }
    if (typeof PlanEngine !== 'undefined' && PlanEngine.resize) setTimeout(() => PlanEngine.resize(), 0);
    this._lastIds = new Set(PlanSolar.roofs().map(r => r.id));
    Roof3D.sel = null; Roof3D.axis = ''; Roof3D.gizmo = 'move';
    await Roof3D.mount(document.getElementById('re-view'), {
      onPanel: () => this.renderPanel(), onMessage: (t) => { const m = document.getElementById('re-msg'); if (m) m.textContent = t; },
      onTool: () => this._syncTools(), onBuilt: () => { this._lastSig = this._sig(); },
    });
    this._lastSig = this._sig();
    this.setTool(PlanSolar.roofs().length ? 'select' : 'footprint');
    Roof3D.setView('iso');
    this._syncViews();
  },
  close() {
    this.on = false;
    const main = document.getElementById('plan-main'); if (main) main.classList.remove('re-on');
    for (const id of ['re-tools', 're-dock', 're-status']) { const el = document.getElementById(id); if (el) el.hidden = true; }
    Roof3D.unmount();
    if (typeof PlanTools !== 'undefined') PlanTools.set('select');
    if (typeof PlanEngine !== 'undefined' && PlanEngine.resize) setTimeout(() => PlanEngine.resize(), 0);
  },

  // ── Tools ──
  setTool(id) {
    const def = this._def(id);
    Roof3D.setTool(id);
    if (id === 'select') PlanTools.set('select');
    else if (id === 'footprint') { PlanTools.set('roofdetect'); if (typeof PlanRoomDetect !== 'undefined') { PlanRoomDetect.mode = 'draw'; PlanRoomDetect.draft = null; } }
    else PlanTools.set('roofedit');
    const l = document.getElementById('re-vcb-l'); if (l) l.textContent = id === 'transform' ? ({ move: 'Distance', rotate: 'Turn °', scale: 'Scale ×' })[Roof3D.gizmo] : (id === 'ridge' && this._selRoof() && this._selRoof().shape === 'pyramid' ? 'Apex' : def[5]);
    this._syncTools();
    this.renderPanel();
  },
  _syncTools() {
    document.querySelectorAll('#re-tools [data-re-tool]').forEach(b => { const on = b.dataset.reTool === Roof3D.tool; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    document.querySelectorAll('#re-status [data-re-axis]').forEach(b => { const on = Roof3D.axis === b.dataset.reAxis; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  },
  _syncViews() { document.querySelectorAll('#re-dock [data-re-view]').forEach(b => b.classList.toggle('active', b.dataset.reView === Roof3D.viewName)); },
  setAxis(a) { Roof3D.axis = Roof3D.axis === a ? '' : a; this._syncTools(); },
  _selRoof() { const id = Roof3D._selRoofId(); return id ? Roof3D._roof(id) : null; },

  _onKey(e) {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), t = this.TOOLS.find(x => x[2].toLowerCase() === k);
    if (t) { this.setTool(t[0]); e.preventDefault(); return; }
    if (k === 'x' || k === 'y' || k === 'z') { this.setAxis(k); e.preventDefault(); }
    else if (e.key === 'Escape') { Roof3D.sel = null; this.renderPanel(); if (Roof3D.view) Roof3D.view.redraw(); }
    else if (e.key === 'Delete' && Roof3D.sel && Roof3D.sel.obj) { const r = this._selRoof(); PlanSolar.removeObject(r, Roof3D.sel.obj); Roof3D.sel = { roof: r.id }; Roof3D.refresh(); }
  },
  _onClick(e) {
    const t = e.target;
    const v = t.closest('[data-re-view]'); if (v) { Roof3D.setView(v.dataset.reView); this._syncViews(); return; }
    if (t.closest('#re-close')) { this.close(); return; }
    if (t.closest('#re-use')) { if (typeof Solar !== 'undefined') Solar.open(); return; }
    if (t.closest('#re-shade')) { const b = document.getElementById('re-shade'), on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('active', on); Roof3D.setShade(on); return; }
    const roof = this._selRoof();
    const g = t.closest('[data-re-gizmo]'); if (g) { Roof3D.gizmo = g.dataset.reGizmo; this.setTool('transform'); return; }
    const add = t.closest('[data-re-add]'); if (add) { Roof3D.addType = add.dataset.reAdd; this.setTool('object'); return; }
    const del = t.closest('[data-re-delobj]'); if (del && roof) { PlanSolar.removeObject(roof, del.dataset.reDelobj); Roof3D.sel = { roof: roof.id }; Roof3D.refresh(); return; }
    const sh = t.closest('[data-re-shape]'); if (sh && roof) { this._edit(roof, { shape: sh.dataset.reShape }); return; }
    const ln = t.closest('[data-re-lean]'); if (ln && roof) { const L = this.LEANS.find(x => x[0] === ln.dataset.reLean); this._edit(roof, { lean: L && L[2] ? Object.assign({}, L[2]) : null }); return; }
    const rs = t.closest('[data-re-roof]'); if (rs) { Roof3D.sel = { roof: rs.dataset.reRoof }; this.renderPanel(); if (Roof3D.view) Roof3D.view.redraw(); return; }
    const dr = t.closest('[data-re-delroof]'); if (dr) { PlanSolar.removeRoof(dr.dataset.reDelroof); Roof3D.sel = null; Roof3D.refresh(); return; }
  },
  _onChange(e) {
    const el = e.target;
    if (el.id === 're-hour') { Roof3D.setHour(el.value).catch(() => {}); return; }
    const k = el.dataset.reF; if (!k) return;
    const roof = this._selRoof(); if (!roof && k !== 'north') return;
    const n = parseFloat(el.value);
    if (k === 'north') { PlanSolar.setNorthAngle(n); Roof3D.refresh(); return; }
    if (k === 'use') { const pu = Object.assign({}, roof.planeUse || {}); pu[el.dataset.reI] = el.checked; this._edit(roof, { planeUse: pu }); return; }
    if (k === 'high') { const it = Roof3D._item(roof.id), pl = it && it.pls[0]; if (pl) { const { u } = Roof3D.axes(PlanSolar.planAz(roof)), ss = it.base.map(q => q[0] * u[0] + q[1] * u[1]), run = Math.max(...ss) - Math.min(...ss); this._edit(roof, { pitch: Math.round(Math.atan(Math.max(0, n - RoofPlanes.eave(roof)) / Math.max(0.1, run)) * 1800 / Math.PI) / 10 }); } return; }
    if (k.startsWith('lean.')) { const L = Object.assign({ side: 'front', kind: 'under', depth: 3, pitch: 8 }, roof.lean || {}); L[k.slice(5)] = el.type === 'number' ? n : el.value; this._edit(roof, { lean: L }); return; }
    if (k.startsWith('obj.')) { const o = (roof.objects || []).find(x => x.id === el.dataset.reI); if (o) { o[k.slice(4)] = n; PlanSolar._changed(); Roof3D.refresh(); } return; }
    if (k === 'name') { this._edit(roof, { name: el.value }); return; }
    this._edit(roof, { [k]: n });
  },
  _edit(roof, patch) { PlanSolar.update(roof.id, patch); PlanSolar._changed(); Roof3D.refresh(); },

  // ── Plan side ──
  _sig() {
    return JSON.stringify([PlanSolar.northAngle(), PlanSolar.roofs().map(r => [r.id, r.name, r.shape, r.points, r.pitch, r.tilt, r.azimuth, r.setback, r.eave, r.apex, r.overhang, r.lean, r.planeUse, r.use, r.objects])]);
  },
  // Called from every plan redraw: a roof changed on the plan (a corner dragged, undo, a new one drawn) updates the 3D view.
  syncFromPlan() {
    if (!this.on) return;
    const sig = this._sig(); if (sig === this._lastSig) return;
    this._lastSig = sig;
    const ids = new Set(PlanSolar.roofs().map(r => r.id)), fresh = [...ids].filter(i => !this._lastIds.has(i));
    this._lastIds = ids;
    if (fresh.length) {                                                       // a roof just drawn: select it, on to Push/pull
      Roof3D.sel = { roof: fresh[0] };
      if (Roof3D.tool === 'footprint') setTimeout(() => this.setTool('pushpull'), 0);
    }
    Roof3D.refresh();
  },
  // The selected roof's width and depth on the plan, as dimension lines.
  drawPlan(ctx, zoom) {
    if (!this.on) return;
    this.syncFromPlan();
    const r = this._selRoof(), f = PlanEngine.factor(); if (!r || !f || !r.points || r.points.length < 3) return;
    const xs = r.points.map(p => p.x), ys = r.points.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), u = 1 / zoom, off = 18 * u, t = 5 * u;
    ctx.save();
    ctx.strokeStyle = '#111827'; ctx.fillStyle = '#111827'; ctx.lineWidth = 1 * u; ctx.font = `600 ${12 * u}px sans-serif`; ctx.textAlign = 'center';
    ctx.beginPath(); ctx.moveTo(x0, y1 + off); ctx.lineTo(x1, y1 + off); ctx.moveTo(x0, y1 + off - t); ctx.lineTo(x0, y1 + off + t); ctx.moveTo(x1, y1 + off - t); ctx.lineTo(x1, y1 + off + t); ctx.stroke();
    ctx.fillText(((x1 - x0) * f).toFixed(2) + ' m', (x0 + x1) / 2, y1 + off + 16 * u);
    ctx.beginPath(); ctx.moveTo(x0 - off, y0); ctx.lineTo(x0 - off, y1); ctx.moveTo(x0 - off - t, y0); ctx.lineTo(x0 - off + t, y0); ctx.moveTo(x0 - off - t, y1); ctx.lineTo(x0 - off + t, y1); ctx.stroke();
    ctx.save(); ctx.translate(x0 - off - 6 * u, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(((y1 - y0) * f).toFixed(2) + ' m', 0, 0); ctx.restore();
    ctx.restore();
  },
  // A click on the plan with a 3D tool: pick the roof (or object) under it, or drop the chosen object on it.
  planDown(pt) {
    const f = PlanEngine.factor(); if (!f) return;
    const zoom = PlanEngine.view ? PlanEngine.view.zoom : 1, tol = 8 / zoom;
    for (const r of PlanSolar.roofs()) for (const o of (r.objects || [])) {
      if (Math.hypot(pt.x - o.x, pt.y - o.y) <= Math.max(tol, Math.max(o.w, o.d) / 2 / f)) { Roof3D.sel = { roof: r.id, obj: o.id }; this.renderPanel(); Roof3D.view && Roof3D.view.redraw(); PlanEngine.requestDraw({ fg: true }); return; }
    }
    const roof = typeof PlanSolarArray !== 'undefined' ? PlanSolarArray.roofAt(pt) : null;
    if (!roof) { Roof3D.sel = null; this.renderPanel(); Roof3D.view && Roof3D.view.redraw(); return; }
    if (Roof3D.tool === 'object') {
      const q = (typeof PlanTools.snap === 'function' ? PlanTools.snap(pt) : pt) || pt;
      const o = PlanSolar.addObject(roof, Roof3D.addType, { x: q.x, y: q.y });
      Roof3D.sel = { roof: roof.id, obj: o.id }; Roof3D.refresh(); return;
    }
    Roof3D.sel = { roof: roof.id }; this.renderPanel(); Roof3D.view && Roof3D.view.redraw(); PlanEngine.requestDraw({ fg: true });
  },

  // ── Properties column ──
  renderPanel() {
    const host = document.getElementById('re-panel'); if (!host || !this.on) return;
    const esc = this._esc, def = this._def(Roof3D.tool), roof = this._selRoof(), it = roof && Roof3D._item(roof.id), sc = Roof3D.scene;
    const nm = document.getElementById('re-name'); if (nm) nm.textContent = roof ? roof.name : '3D';
    const btn = (on, attr, label, cls = '') => `<button type="button" class="re-btn ${cls}${on ? ' active' : ''}" ${attr} aria-pressed="${on}">${label}</button>`;
    const num = (k, label, v, step, extra = '') => `<label class="re-row"><span>${label}</span><input type="number" step="${step || 'any'}" value="${esc(Math.round(v * 1000) / 1000)}" data-re-f="${k}" ${extra}></label>`;
    const txt = (k, label, v) => `<label class="re-row"><span>${label}</span><input type="text" value="${esc(v)}" data-re-f="${k}"></label>`;
    let h = `<div class="re-card"><b>${esc(def[1])}</b><div>${esc(def[4])}</div></div>`;
    if (Roof3D.tool === 'transform') h += `<div class="re-sec"><div class="re-lab">Gizmo mode</div><div class="re-seg">${[['move', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']].map(g => btn(Roof3D.gizmo === g[0], `data-re-gizmo="${g[0]}"`, g[1])).join('')}</div></div>`;
    const types = Object.entries(PlanSolar.OBJECT_TYPES);
    if (Roof3D.tool === 'object') h += `<div class="re-sec"><div class="re-lab">Pick, then click a roof plane</div><div class="re-chips" role="group" aria-label="Object to place">${types.map(([k, t]) => btn(Roof3D.addType === k, `data-re-add="${k}"`, esc(t.label))).join('')}</div></div>`;
    h += `<div class="re-sec"><div class="re-lab">Site orientation</div>${num('north', 'True north, clockwise from plan up (°)', PlanSolar.northAngle(), 1)}<div class="re-note">Plane azimuths and the solar calculation use true north, so set this when the site plan is drawn at an angle.</div></div>`;
    if (sc && sc.items.length > 1) h += `<div class="re-sec"><div class="re-lab">Roofs</div><div class="re-chips">${sc.items.map(i => btn(roof && i.roof.id === roof.id, `data-re-roof="${esc(i.roof.id)}"`, esc(i.roof.name))).join('')}</div></div>`;
    if (!roof || !it) {
      h += `<div class="re-note">${sc && sc.empty ? 'No roofs yet. Pick <b>Footprint</b> and click the corners of the building.' : 'Click a roof on the plan or in 3D.'}</div>`;
      host.innerHTML = h; return;
    }
    const shapeBtns = ['gable', 'hip', 'mono', 'flat'].map(s => btn(roof.shape === s, `data-re-shape="${s}"`, RoofPlanes.LABELS[s])).join('');
    const moreShapes = ['pyramid', 'wings'].map(s => btn(roof.shape === s, `data-re-shape="${s}"`, RoofPlanes.LABELS[s])).join('');
    const eave = RoofPlanes.eave(roof), isFlat = roof.shape === 'flat';
    const monoHigh = roof.shape === 'mono' ? (() => { const { u } = Roof3D.axes(PlanSolar.planAz(roof)), ss = it.base.map(q => q[0] * u[0] + q[1] * u[1]); return eave + Math.tan((+roof.pitch || 0) * Math.PI / 180) * (Math.max(...ss) - Math.min(...ss)); })() : 0;
    h += `<div class="re-sec"><div class="re-lab">Roof planes</div><div class="re-list">${it.pls.length && !isFlat ? RoofPlanes.groups(it.pls).map(gr => { const pl = it.pls[gr.idx[0]], sel = Roof3D.sel && gr.idx.includes(Roof3D.sel.plane);
        return `<label class="re-li${sel ? ' sel' : ''}"><span><input type="checkbox" data-re-f="use" data-re-i="${esc(pl.name)}" ${it.use[gr.idx[0]] ? 'checked' : ''} aria-label="Modules on ${esc(pl.name)}"> ${esc(pl.name)}</span><span>${pl.pitch.toFixed(1)}° · az ${Math.round(pl.trueAz)}°</span></label>`; }).join('') : '<div class="re-li"><span>Flat deck</span><span>racks at ' + (+roof.tilt) + '°</span></div>'}</div></div>`;
    h += `<div class="re-sec"><div class="re-lab">${esc(roof.name)}</div>${txt('name', 'Name', roof.name)}
      <div class="re-seg" role="group" aria-label="Roof type">${shapeBtns}</div><div class="re-seg" role="group" aria-label="More roof types">${moreShapes}</div>
      ${num('eave', 'Eave height (m)', eave, 0.05)}
      ${isFlat ? num('tilt', 'Rack tilt (°)', +roof.tilt, 1) : roof.shape === 'pyramid' ? num('apex', 'Apex height above eave (m)', +roof.apex || 1.8, 0.05) : roof.shape === 'wings' ? num('pitch', 'Pitch (°)', +roof.pitch, 0.1) : num('pitch', 'Pitch (°)', +roof.pitch, 0.1)}
      ${roof.shape === 'mono' ? num('high', 'High eave (m)', monoHigh, 0.05) : ''}
      ${roof.shape === 'wings' || roof.shape === 'pyramid' ? '' : num('azimuth', 'Azimuth, true (°)', +roof.azimuth, 1)}
      ${['gable', 'hip', 'mono'].includes(roof.shape) ? num('overhang', 'Overhang (m)', +roof.overhang || 0, 0.05) : ''}
      ${num('setback', 'Edge setback (m)', +roof.setback, 0.05)}
      ${roof.shape === 'wings' ? '<div class="re-note">A cross-gable needs an L, T or U outline with straight, axis-aligned edges. The longest wing is the main one; the others stop at its ridge.</div>' : ''}</div>`;
    if (!isFlat && roof.shape !== 'wings') {
      const L = roof.lean && +roof.lean.depth > 0 ? roof.lean : null, cur = !L ? 'none' : (this.LEANS.find(x => x[2] && x[2].side === L.side && x[2].kind === L.kind && Math.abs((+x[2].pitch || 0) - (+L.pitch || 0)) < 0.5) || ['none'])[0];
      h += `<div class="re-sec"><div class="re-lab">Lean-to</div><div class="re-chips" role="group" aria-label="Lean-to option">${this.LEANS.map(x => btn(cur === x[0], `data-re-lean="${x[0]}"`, (x[0] === 'none' ? '' : x[0] + ' · ') + esc(x[1]))).join('')}</div>
        ${L ? `${num('lean.depth', 'Depth (m)', +L.depth, 0.1)}${L.kind === 'catslide' ? '' : num('lean.pitch', 'Lean-to pitch (°)', +L.pitch >= 0 ? +L.pitch : 8, 0.5)}
        <label class="re-row"><span>Side</span><select data-re-f="lean.side">${[['front', 'Facing side'], ['back', 'Back'], ['end', 'End (+)'], ['end2', 'End (−)']].map(o => `<option value="${o[0]}"${L.side === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>` : ''}
        <div class="re-note">${L ? '' : 'Needs a rectangular footprint.'}</div></div>`;
    }
    const mods = it.mods.length, mw = (typeof Solar !== 'undefined' && Solar.panel) ? Solar.panel(Solar.cfg()).w : 0;
    h += `<div class="re-sec"><div class="re-lab">Array</div><div class="re-note">${mods} modules${mw ? ' · ' + (mods * mw / 1000).toFixed(1) + ' kWp' : ''} (from the last size calculation, or all that fit).</div></div>`;
    h += `<div class="re-sec"><div class="re-lab">Objects on this roof</div>${(roof.objects || []).map(o => `<div class="re-obj${Roof3D.sel && Roof3D.sel.obj === o.id ? ' sel' : ''}"><div class="re-objh"><span>${esc((PlanSolar.OBJECT_TYPES[o.type] || { label: o.type }).label)}</span><button type="button" class="re-btn" data-re-delobj="${esc(o.id)}" aria-label="Delete ${esc(o.type)}">×</button></div>
        ${['w', 'd', 'h', 'rot'].map(k => `<label class="re-row"><span>${{ w: 'Width (m)', d: 'Depth (m)', h: 'Height (m)', rot: 'Turn (°)' }[k]}</span><input type="number" step="any" value="${esc(Math.round(+o[k] * 1000) / 1000)}" data-re-f="obj.${k}" data-re-i="${esc(o.id)}"></label>`).join('')}</div>`).join('') || '<div class="re-note">None. Pick <b>Objects</b>, choose one and click a plane.</div>'}
      <div class="re-note">Objects feed the shading, so a vent beside the array changes the result.</div></div>
      <div class="re-sec"><button type="button" class="re-btn" data-re-delroof="${esc(roof.id)}">Delete this roof</button></div>`;
    host.innerHTML = h;
  },
};

if (typeof PlanTools !== 'undefined') PlanTools.register({
  id: 'roofedit', cursor: 'crosshair',
  onActivate() { if (!RoofEditor.on) RoofEditor.open(); },
  cancel() { PlanTools.set('select'); },
  onDown(pt) { RoofEditor.planDown(pt); },
  onKey(e) { if (e.key === 'Escape') { Roof3D.sel = null; RoofEditor.renderPanel(); PlanEngine.requestDraw({ fg: true }); return true; } return false; },
});

if (typeof module !== 'undefined' && module.exports) module.exports = RoofEditor;
