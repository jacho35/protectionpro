/* ProtectionPro — Lighting workspace.
 *
 * Every room, outdoor area, perimeter and escape route of the project — across
 * all floors — in one list, with what each was calculated to and a verdict.
 * Three views: Plan (the Plan tab's canvas re-hosted here, with the lighting
 * tools — rooms, areas, fences, escape routes, fittings — and the room
 * lighting panel), Table (every zone on every floor) and 3D (one room,
 * rotatable, with objects, windows, doors and calculation surfaces —
 * js/light3d.js). The calculations are
 * RoomCalc / AreaCalc / EmergCalc; this runs them all (stepping through the
 * floors, then returning to the one you were on) and makes the PDF.
 *
 * In a Lighting project the workspace is two tabs (`scope`): Rooms (rooms,
 * outdoor areas, fences, escape routes, obtrusive-light checks) and Sports
 * fields (fields and obtrusive-light checks). Elsewhere it shows everything.
 *
 * Results are session-only, like the rest of the lighting calculations: after
 * opening a project, press Calculate all. A room on the floor in view whose
 * inputs changed reads Out of date; on another floor the result is shown as it
 * was calculated.
 */

const LightingWS = {
  _active: false,
  _built: false,
  filter: 'all',           // all | failing | pending | site | escape | floor:<id>
  sort: { key: 'name', dir: 1 },

  KIND: { room: 'Room', outdoor: 'Outdoor area', perimeter: 'Perimeter', sports: 'Sports field', obtrusive: 'Obtrusive light', escape: 'Escape route' },

  // 'all' (one Lighting tab) | 'rooms' | 'sports' (a Lighting project's two tabs).
  scope: 'all',
  // Does a zone of this kind belong in the scope?
  inScope(kind, scope = this.scope) {
    const k = kind || 'room';
    if (scope === 'sports') return k === 'sports' || k === 'obtrusive';
    if (scope === 'rooms') return k !== 'sports';
    return true;
  },

  // Any lighting zone (in `scope` when given) on any floor.
  hasData(scope) {
    try {
      return AppState.planFloors().some(f => ((f.data && f.data.rooms) || []).some(r => (r.lighting || r.kind)
        && (!scope || (scope === 'sports' ? (r.kind === 'sports') : (r.kind || 'room') !== 'sports'))));
    } catch (_) { return false; }
  },

  // 'plan': the floor plan with the lighting tools (the Plan tab's canvas,
  // re-hosted here); 'table': every zone on every floor with its results.
  view: 'plan',

  // `scope` 'sports' for the Sports fields tab; otherwise the Lighting tab,
  // which is Rooms in a Lighting project.
  activate(scope) {
    const want = scope === 'sports' ? 'sports'
      : (typeof Workspaces !== 'undefined' && Workspaces.type() === 'lighting' ? 'rooms' : 'all');
    if (want !== this.scope && typeof Light3D !== 'undefined' && Light3D.room && Light3D.roomId) {
      const r = (AppState.planMarkup.rooms || []).find(x => x.id === Light3D.roomId);
      if (r && !this.inScope(r.kind, want)) Light3D.roomId = null;
    }
    const changed = want !== this.scope;
    this.scope = want;
    this._active = true;
    this._mount();
    this.setView(this.view);
    // The other tab's drawing tool may be armed: drop it.
    if (changed && this.view === 'plan' && typeof PlanTools !== 'undefined') PlanTools.set('select');
  },
  deactivate() {
    this._active = false;
    if (typeof Light3D !== 'undefined') Light3D.deactivate();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && PlanMarkup.context === 'lighting') PlanMarkup.deactivate();
  },
  refresh() {
    if (!this._active) return;
    if (this.view === 'table') this.render();
    else if (this.view === '3d') { this._renderBar(); Light3D.render(); }
    else { this._renderBar(); if (typeof PlanUI !== 'undefined') PlanUI.renderPalette(); }
  },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('lighting-workspace');
    if (!host) return;
    this._built = true;
    host.innerHTML = `<div class="lw-bar" id="lw-bar"></div>
      <div class="lw-body">
        <div class="lw-plan" id="lw-plan"></div>
        <div class="lw-3d" id="lw-3d" hidden></div>
        <div class="lw-tableview" id="lw-tableview" hidden>
          <aside class="lw-rail"><div class="lw-rail-head">Show</div><div class="lw-rail-list" id="lw-rail"></div></aside>
          <section class="lw-main" id="lw-main"></section>
        </div>
      </div>`;
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => {
      if (this.view === '3d' && e.target.closest('#lw-bar') && Light3D.onBarChange(e)) { this._renderBar(); return; }
      if (e.target.id === 'lw-floor-select') {
        PlanMarkup.setActiveFloor(e.target.value);
        if (this.view === '3d') { Light3D.focusRoom(null); Light3D.roomId = null; Light3D.fit(); Light3D.render(); }
        this._renderBar();
      }
      else if (e.target.id === 'lw-show') {
        RoomCalc.enabled = e.target.value !== 'off';
        if (RoomCalc.enabled) RoomCalc.display = e.target.value;
        PlanEngine.requestDraw({ fg: true });
        this._renderBar();
      }
      else if (e.target.id === 'lw-isostep') { RoomCalc.isoStep = +e.target.value || 0; PlanEngine.requestDraw({ fg: true }); }
      else if (e.target.id === 'lw-dist') { RoomCalc.showDist = e.target.checked; PlanEngine.requestDraw({ fg: true }); }
    });
  },

  setView(view) {
    this.view = view === 'table' || view === '3d' ? view : 'plan';
    const plan = document.getElementById('lw-plan'), table = document.getElementById('lw-tableview'), v3 = document.getElementById('lw-3d');
    if (!plan || !table) return;
    plan.hidden = this.view !== 'plan';
    table.hidden = this.view !== 'table';
    if (v3) v3.hidden = this.view !== '3d';
    if (this.view !== '3d' && typeof Light3D !== 'undefined') Light3D.deactivate();
    if (this.view === 'plan') PlanMarkup.activate(plan, 'lighting');
    else {
      if (PlanMarkup._active && PlanMarkup.context === 'lighting') {
        // the 3D view opens on the room picked on the plan
        if (this.view === '3d') { const sel = (AppState.planMarkup.rooms || []).find(r => PlanMarkup.selectedIds.has(r.id)); if (sel && sel.id !== Light3D.roomId) Light3D.focusRoom(sel.id); }
        PlanMarkup.deactivate();
      }
      if (this.view === 'table') this.render();
      else Light3D.activate(v3);
    }
    this._renderBar();
  },

  // The tab a zone opens on: a Lighting project's sports field → Sports fields.
  _tabFor(id) {
    const r = (AppState.planMarkup.rooms || []).find(x => x.id === id);
    return r && r.kind === 'sports' && typeof Workspaces !== 'undefined' && Workspaces.type() === 'lighting' ? 'sports' : 'lighting';
  },
  _showTab(tab) {
    if (typeof Workspaces !== 'undefined' && !Workspaces.isVisible(tab)) {
      if (tab === 'sports') AppState.lightingKinds = Workspaces.lightingKinds().concat(['sports']);
      else AppState.extraWorkspaces = (AppState.extraWorkspaces || []).concat(['lighting']);
      if (Workspaces.refresh) Workspaces.refresh();
    }
  },

  // A room's panel on the plan → its 3D view.
  open3D(id) {
    if (typeof Light3D === 'undefined') return;
    Light3D.focusRoom(id);
    const tab = this._tabFor(id);
    this._showTab(tab);
    this.view = '3d';
    if (this._active && (tab === 'sports') === (this.scope === 'sports')) this.setView('3d');
    else switchWorkspace(tab);
  },

  _renderBar() {
    const bar = document.getElementById('lw-bar');
    if (!bar) return;
    const plan = this.view === 'plan', v3 = this.view === '3d';
    const I = (n) => PlanMarkup._icon(n);
    const pm = AppState.planMarkup;
    const floors = (pm.floors || []).slice().sort((a, b) => (b.level || 0) - (a.level || 0));
    bar.innerHTML = `
      ${plan ? `<div class="plan-tb-group plan-mobile-toggle">
        <button class="plan-tb-btn" data-lw-act="toggle-palette">☰ Tools</button>
        <button class="plan-tb-btn" data-lw-act="toggle-props">✎ Props</button></div>` : ''}
      <div class="plan-modes" role="group" aria-label="View">
        <button type="button" class="plan-mode-btn${plan ? ' active' : ''}" data-lw-view="plan" aria-pressed="${plan}">Plan</button>
        <button type="button" class="plan-mode-btn${this.view === 'table' ? ' active' : ''}" data-lw-view="table" aria-pressed="${this.view === 'table'}">Table</button>
        <button type="button" class="plan-mode-btn${v3 ? ' active' : ''}" data-lw-view="3d" aria-pressed="${v3}">3D</button>
      </div>
      ${v3 ? Light3D.barHtml() : ''}
      ${plan ? `<div class="plan-tb-group">
        <button class="plan-tool-btn${PlanTools.active && PlanTools.active.id === 'select' ? ' active' : ''}" data-tool="select" title="Select / move (V)">${I('select')} Select</button>
        <button class="plan-tb-btn plan-icon-btn" data-lw-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${I('undo')}</button>
        <button class="plan-tb-btn plan-icon-btn" data-lw-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${I('redo')}</button>
        <button class="plan-tb-btn" data-lw-act="fit" title="Zoom to fit">${I('fit')} Fit</button>
      </div>` : ''}
      <div class="plan-tb-spacer"></div>
      ${(plan || v3) && floors.length > 1 ? `<label class="plan-tb-field">Floor <select id="lw-floor-select">${floors.map(f =>
        `<option value="${escHtml(f.id)}"${f.id === pm.activeFloorId ? ' selected' : ''}>${escHtml(f.name)} (L${f.level})</option>`).join('')}</select></label>` : ''}
      ${plan ? this._showHtml() : ''}
      <button class="plan-tb-btn" data-lw="photolib">Luminaire library…</button>
      <button class="plan-tb-btn" data-lw="pdf">PDF report</button>
      ${v3 ? `<button class="btn-primary" data-l3="calc">${Light3D.calcLabel()}</button>`
        : '<button class="btn-primary" data-lw="calc">Calculate all</button>'}`;
  },

  // Plan toolbar: how results show (false colour / isolux lines / values), the line step, and
  // each fitting's light distribution.
  _showHtml() {
    const cur = RoomCalc.enabled ? RoomCalc.display : 'off';
    const opt = (v, t) => `<option value="${v}"${cur === v ? ' selected' : ''}>${t}</option>`;
    const iso = cur === 'iso' || cur === 'isoval';
    const steps = [0, 10, 25, 50, 100, 200, 500];
    return `<label class="plan-tb-field">Show <select id="lw-show" class="plan-tb-select">${opt('fc', 'False colour')}${opt('iso', 'Isolux lines')}${opt('isoval', 'Isolux lines + values')}${opt('val', 'Values')}${opt('off', 'Plan only')}</select></label>
      ${iso ? `<label class="plan-tb-field">Every <select id="lw-isostep" class="plan-tb-select">${steps.map(v => `<option value="${v}"${RoomCalc.isoStep === v ? ' selected' : ''}>${v ? v + ' lx' : 'Auto'}</option>`).join('')}</select></label>` : ''}
      <label class="plan-tb-field" title="Each fitting's light distribution seen from above — how far it throws light in every direction"><input type="checkbox" id="lw-dist"${RoomCalc.showDist ? ' checked' : ''}> Light distribution</label>`;
  },

  // From the Plan tab ("Lighting for this room…") or a table row: show the
  // zone on this tab's plan, selected.
  openOnPlan(id, floorId) {
    const tab = this._tabFor(id);
    this._showTab(tab);
    this.view = 'plan';
    switchWorkspace(tab);
    const pm = AppState.planMarkup;
    if (floorId && floorId !== pm.activeFloorId) PlanMarkup.setActiveFloor(floorId);
    const room = (AppState.planMarkup.rooms || []).find(r => r.id === id);
    if (!room) return;
    PlanMarkup.selectOnly(id);
    if (PlanEngine.zoomToPoints) PlanEngine.zoomToPoints(room.points);
    PlanUI.renderPalette();
    PlanEngine.requestDraw({ all: true });
    this._renderBar();
  },

  // The verdict shown beside a zone in the plan view's list.
  verdictOf(room) {
    const pm = AppState.planMarkup;
    const fl = (pm.floors || []).find(f => f.id === pm.activeFloorId) || {};
    try {
      const v = this._row(room, room.kind || 'room', fl, true, PlanEngine.factor()).verdict;
      return v === 'Not calculated' ? '' : v;
    } catch (_) { return ''; }
  },

  // ─── Data ───
  _items() {
    RoomCalc._sync();
    const pm = AppState.planMarkup;
    const out = [];
    for (const fl of AppState.planFloors()) {
      const active = fl.id === pm.activeFloorId;
      for (const r of ((fl.data && fl.data.rooms) || [])) {
        if (!r.points || r.points.length < 2) continue;
        const kind = r.kind || 'room';
        if (!this.inScope(kind)) continue;
        const f = fl.data && fl.data.scale && fl.data.scale.factor;
        out.push(this._row(r, kind, fl, active, f));
      }
    }
    return out;
  },

  _row(r, kind, fl, active, f) {
    const lux = RoomCalc.results[r.id] || null;
    const em = RoomCalc.results['em:' + r.id] || null;
    const res = lux && lux.res, eres = em && em.res;
    const row = { room: r, kind, id: r.id, name: r.name || this.KIND[kind], floor: fl.name || '', floorId: fl.id, active, factor: f || null,
      res, eres, task: '', em: null, uo: null, glare: null, wm2: null, leni: null, emText: '—', watts: 0, area: 0 };
    let stale = false;
    if (active) {
      if (lux) { try { stale = lux.sig !== RoomCalc.signature(r); } catch (_) { stale = false; } }
      if (em) { try { stale = stale || em.sig !== EmergCalc.signature(r); } catch (_) { /* leave */ } }
    }
    row.stale = stale;
    if (kind === 'room') {
      const L = RoomLighting.read(r);
      row.task = L.task === 'custom' ? 'Custom' : ((ROOM_TASKS[L.task] || {}).name || '');
      if (res && res.workplane) {
        row.em = { v: res.workplane.Em, t: L.em }; row.uo = res.workplane.U0;
        row.glare = res.ugr ? { label: 'UGR', v: res.ugr.max, t: L.ugr } : null;
        row.wm2 = res.power ? res.power.wm2 : null; row.watts = res.power ? res.power.watts : 0; row.area = res.area || 0;
        const en = RoomLighting.energy(r, res); row.leni = en ? en.leni : null; row.kwh = en ? en.kwh : 0;
        row.lpd = en && en.lpdPass === false ? en.lpd : null;
      }
      if (L.emerg !== 'none') row.emText = eres ? (eres.pass ? 'Pass' : 'Fail') : 'Not checked';
    } else if (kind === 'outdoor') {
      const L = AreaCalc.readArea(r);
      row.task = L.task === 'custom' ? 'Custom' : ((OUTDOOR_TASKS[L.task] || {}).name || '');
      if (res && res.workplane) {
        row.em = { v: res.workplane.Em, t: L.em }; row.uo = res.workplane.U0;
        row.glare = res.gr ? { label: 'GR', v: res.gr.max, t: L.gr } : null;
        row.wm2 = res.power ? res.power.wm2 : null; row.watts = res.power ? res.power.watts : 0; row.area = res.area || 0;
      }
    } else if (kind === 'sports') {
      const L = SportsCalc.read(r);
      row.task = `${SPORTS_FIELDS[L.sport].name}, Class ${L.cls}`;
      if (res && res.horizontal) {
        row.em = { v: res.horizontal.Eav, t: L.em }; row.uo = res.horizontal.U2;
        row.glare = res.gr ? { label: 'GR', v: res.gr.max, t: L.gr } : null;
        row.wm2 = res.power ? res.power.wm2 : null; row.watts = res.power ? res.power.watts : 0; row.area = res.area || 0;
      }
    } else if (kind === 'obtrusive') {
      const L = ObtrusiveCalc.read(r), lim = ObtrusiveCalc.limit(r);
      row.task = L.check === 'road' ? `Road, ${L.roadClass === 'none' ? 'unlit' : L.roadClass}` : `${L.zone}, ${L.curfew}-curfew`;
      if (res && res.kind === 'property') { row.em = { v: res.Evmax, t: lim.v, ev: true, max: true }; row.glare = { label: 'I', v: res.Imax, t: OBTRUSIVE_ZONES[L.zone].i[L.curfew === 'post' ? 1 : 0] }; }
      if (res && res.kind === 'road') row.glare = { label: 'TI', v: res.TImax, t: 15 };
    } else if (kind === 'perimeter') {
      const L = AreaCalc.readPerim(r);
      row.task = L.closed ? 'Ring, ' + (L.side === 'in' ? 'inward' : 'outward') : 'Open line';
      if (res && res.vertical) row.em = { v: res.vertical.Evmin, t: L.evMin, ev: true };
    } else if (kind === 'escape') {
      row.task = 'Width ' + EmergCalc.readRoute(r).width + ' m';
      if (eres && eres.centre) row.em = { v: eres.centre.Emin, t: 1, ev: true, emergency: true };
      row.emText = eres ? (eres.pass ? 'Pass' : 'Fail') : 'Not checked';
    }
    // verdict
    const parts = [];
    if (kind !== 'escape' && res && res.pass != null) parts.push(res.pass);
    if (kind !== 'escape' && res && res.pass == null && res.luminaires === 0) row.noFittings = true;
    if (r.lighting && (kind === 'room') && RoomLighting.read(r).emerg !== 'none') parts.push(eres ? !!eres.pass : null);
    if (kind === 'escape') parts.push(eres ? !!eres.pass : null);
    if (row.lpd != null) parts.push(false);
    if (!parts.length || parts.includes(null) && !parts.includes(false)) row.verdict = row.noFittings ? 'No fittings' : 'Not calculated';
    else row.verdict = parts.every(Boolean) ? 'Pass' : 'Fail';
    if (stale && row.verdict !== 'Not calculated') row.verdictNote = 'out of date';
    row.failing = this._failReasons(row);
    return row;
  },

  _failReasons(row) {
    const out = [];
    for (const src of [row.res, row.eres]) {
      if (!src || !src.checks) continue;
      for (const c of src.checks) if (c.pass === false) out.push(c.label);
    }
    if (row.lpd != null) out.push('W/m² limit');
    return out;
  },

  _visible(items) {
    const f = this.filter;
    if (f === 'failing') return items.filter(r => r.verdict === 'Fail');
    if (f === 'pending') return items.filter(r => r.verdict === 'Not calculated' || r.verdict === 'No fittings' || r.stale);
    if (f === 'site') return items.filter(r => r.kind === 'outdoor' || r.kind === 'perimeter' || r.kind === 'sports' || r.kind === 'obtrusive');
    if (f === 'escape') return items.filter(r => r.kind === 'escape');
    if (f.startsWith('floor:')) return items.filter(r => r.floorId === f.slice(6));
    return items;
  },

  _sorted(items) {
    const { key, dir } = this.sort;
    const val = (r) => ({
      name: r.name.toLowerCase(), floor: r.floor.toLowerCase(), kind: r.kind, em: r.em ? r.em.v : -1,
      uo: r.uo == null ? -1 : r.uo, wm2: r.wm2 == null ? -1 : r.wm2, verdict: r.verdict,
    }[key]);
    return items.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  },

  // ─── Render ───
  render() {
    const rail = document.getElementById('lw-rail'), main = document.getElementById('lw-main');
    if (!rail || !main) return;
    const items = this._items();
    const floors = AppState.planFloors();
    const cnt = (fn) => items.filter(fn).length;
    const rl = (id, label, n) => `<button class="lw-rail-item${this.filter === id ? ' active' : ''}" data-lw-filter="${escHtml(id)}">${escHtml(label)}<span>${n}</span></button>`;
    rail.innerHTML = rl('all', 'Everything', items.length)
      + floors.slice().sort((a, b) => (b.level || 0) - (a.level || 0)).map(f => rl('floor:' + f.id, f.name || 'Floor', cnt(r => r.floorId === f.id))).join('')
      + (this.scope === 'sports' ? '' : rl('site', `Site (areas, fences, ${this.scope === 'rooms' ? '' : 'sports, '}obtrusive)`, cnt(r => r.kind === 'outdoor' || r.kind === 'perimeter' || r.kind === 'sports' || r.kind === 'obtrusive'))
        + rl('escape', 'Escape routes', cnt(r => r.kind === 'escape')))
      + '<div class="lw-rail-sep"></div>'
      + rl('failing', 'Failing', cnt(r => r.verdict === 'Fail'))
      + rl('pending', 'Not calculated / out of date', cnt(r => r.verdict === 'Not calculated' || r.verdict === 'No fittings' || r.stale));
    const pass = cnt(r => r.verdict === 'Pass'), fail = cnt(r => r.verdict === 'Fail');
    const todo = cnt(r => r.verdict === 'Not calculated' || r.verdict === 'No fittings');
    const kw = items.reduce((s, r) => s + (r.watts || 0), 0) / 1000;
    const indoor = items.filter(r => r.kind === 'room' && r.leni != null);
    const kwh = indoor.reduce((s, r) => s + (r.kwh || 0), 0), ia = indoor.reduce((s, r) => s + (r.area || 0), 0);
    const shown = this._sorted(this._visible(items));
    const th = (key, label, cls) => `<th class="${cls || ''}"><button data-lw-sort="${escHtml(key)}">${label}${this.sort.key === key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    const num = (v, dp) => v == null ? '—' : Number(v).toFixed(dp);
    const rowHtml = (r) => {
      const em = r.em ? `${num(r.em.v, r.em.v < 10 ? 1 : 0)} <small>/ ${r.em.t}</small>` : '—';
      const glare = r.glare ? `${r.glare.label} ${num(r.glare.v, 1)} <small>/ ${r.glare.t}</small>` : '—';
      const vcls = r.verdict === 'Pass' ? 'ok' : r.verdict === 'Fail' ? 'bad' : 'muted';
      return `<tr>
        <td><b>${escHtml(r.name)}</b></td><td>${escHtml(r.floor)}</td><td>${this.KIND[r.kind]}</td><td class="lw-task">${escHtml(r.task)}</td>
        <td class="num">${em}${r.em && r.em.ev ? ` <small>lx ${r.em.max ? 'max' : 'min'}</small>` : ''}</td><td class="num">${num(r.uo, 2)}</td><td class="num">${glare}</td>
        <td class="num">${num(r.wm2, 1)}</td><td>${escHtml(r.emText)}</td>
        <td class="${vcls}"><b>${r.verdict}</b>${r.verdictNote ? ` <small>(${r.verdictNote})</small>` : ''}${r.failing.length ? `<small class="lw-why">${escHtml(r.failing.join(', '))}</small>` : ''}</td>
        <td><button class="lw-link" data-lw-locate="${escHtml(r.id)}" data-lw-floor="${escHtml(r.floorId)}">Show on plan</button></td></tr>`;
    };
    const title = { sports: 'Sports fields', rooms: 'Rooms & areas' }[this.scope] || 'Lighting';
    main.innerHTML = `<div class="lw-head"><h1>${title}</h1></div>
      <div class="lw-tiles">
        <div class="lw-tile"><span>Pass</span><b class="ok">${pass}</b></div>
        <div class="lw-tile"><span>Fail</span><b class="bad">${fail}</b></div>
        <div class="lw-tile"><span>Not calculated</span><b>${todo}</b></div>
        <div class="lw-tile"><span>Installed load</span><b>${kw.toFixed(2)} <small>kW</small></b></div>
        <div class="lw-tile"><span>LENI, rooms</span><b>${ia > 0 ? (kwh / ia).toFixed(1) : '—'} <small>kWh/m²·yr</small></b></div>
      </div>
      ${items.length ? `<div class="lw-tablewrap"><table class="lw-table"><thead><tr>
        ${th('name', 'Room / area')}${th('floor', 'Floor')}${th('kind', 'Type')}<th>Task</th>${th('em', 'Ēm / target (lx)', 'num')}${th('uo', 'U₀ / U₂', 'num')}<th class="num">UGR / GR</th>${th('wm2', 'W/m²', 'num')}<th>Emergency</th>${th('verdict', 'Verdict')}<th></th>
        </tr></thead><tbody>${shown.map(rowHtml).join('') || '<tr><td colspan="11" class="muted">Nothing matches this filter.</td></tr>'}</tbody></table></div>`
        : this.scope === 'sports'
          ? `<div class="lw-empty"><p>No sports fields yet.</p><p>In the <b>Plan</b> view, pick <b>Sports field</b> and click the centre spot. Set the sport and class, lay out the masts and calculate. Every field appears here.</p></div>`
          : `<div class="lw-empty"><p>No rooms, areas or routes yet.</p><p>In the <b>Plan</b> view, click inside a room with <b>Detect room</b> (or draw one), set its task, place or auto-layout fittings and calculate. They all appear here.</p></div>`}
      <p class="lw-note">Results belong to this session: open a project and press Calculate all. Targets follow the project's lighting standard (EN 12464-1 / EN 1838, or SANS 10114-1 / -2); outdoor areas use EN 12464-2; sports fields provisional EN 12193 classes; obtrusive light EN 12464-2 Table 4 / 5.</p>`;
  },

  _onClick(e) {
    const v = e.target.closest('[data-lw-view]');
    if (v) { this.setView(v.dataset.lwView); return; }
    if (this.view === '3d' && e.target.closest('#lw-bar')) {
      if (Light3D.onBar(e)) return;
      const ua = e.target.closest('[data-lw-act]');
      if (ua) { PlanMarkup.runAction(ua.dataset.lwAct); Light3D.render(); return; }
    }
    const t = e.target.closest('#lw-bar [data-tool]');
    if (t) { PlanTools.set(t.dataset.tool); return; }
    const la = e.target.closest('[data-lw-act]');
    if (la) { PlanMarkup.runAction(la.dataset.lwAct); return; }
    const f = e.target.closest('[data-lw-filter]');
    if (f) { this.filter = f.dataset.lwFilter; this.render(); return; }
    const s = e.target.closest('[data-lw-sort]');
    if (s) { const k = s.dataset.lwSort; this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : 1 }; this.render(); return; }
    const loc = e.target.closest('[data-lw-locate]');
    if (loc) { this.locate(loc.dataset.lwLocate, loc.dataset.lwFloor); return; }
    const a = e.target.closest('[data-lw]');
    if (!a) return;
    if (a.dataset.lw === 'calc') this.calcAll();
    else if (a.dataset.lw === 'photolib') PhotoLib.open();
    else if (a.dataset.lw === 'pdf') { if (typeof LightReport !== 'undefined') LightReport.export(); }
  },

  locate(id, floorId) { this.openOnPlan(id, floorId); },

  // Every floor in turn, then back to the one that was open.
  async calcAll() {
    if (!this._items().length) { UI.toast('Draw or detect a room first (Room / area or Detect room on the left).', 'info'); return; }
    const pm = AppState.planMarkup;
    const start = pm.activeFloorId;
    const floors = AppState.planFloors().slice();
    RoomCalc.quiet = true;
    const stats = { floors: 0, uncal: [] };
    try {
      if (UI.setBusy) UI.setBusy(true, 'Calculating every floor…');
      for (const fl of floors) {
        if (fl.id !== pm.activeFloorId) AppState.switchFloor(fl.id);
        const f = PlanEngine.factor();
        if (!f) { if ((AppState.planMarkup.rooms || []).length) stats.uncal.push(fl.name || 'Floor'); continue; }
        stats.floors++;
        const lab = document.querySelector('#busy-overlay .busy-label');
        if (lab) lab.textContent = `Calculating ${fl.name || 'floor'}…`;
        await RoomCalc.run();
        await AreaCalc.run();
        await SportsCalc.run();
        await ObtrusiveCalc.run();
        await EmergCalc.run();
      }
    } finally {
      if (pm.activeFloorId !== start) AppState.switchFloor(start);
      RoomCalc.quiet = false;
      if (UI.setBusy) UI.setBusy(false);
    }
    if (stats.uncal.length) UI.toast(`Not calibrated, so not calculated: ${stats.uncal.join(', ')}.`, 'warn', 7000);
    if (!this._active) return;   // run from the lighting Overview
    if (this.view === 'table') this.render();
    else if (this.view === '3d') Light3D.render();
    else { if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); } PlanEngine.requestDraw({ all: true }); }
    this._renderBar();
  },
};
