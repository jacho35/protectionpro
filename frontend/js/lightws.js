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
  // re-hosted here); 'section': the plan with the selected room's section
  // docked below it; '3d'; 'table': every zone on every floor with its results.
  view: 'plan',

  // The plan's workflow, one step at a time: the space (rooms, sizes, the
  // drawing) → the luminaires → the results. The left panel, the room panel's
  // block above its tabs, and whether results show on the plan follow it. A
  // sports field's steps are Field → Masts & aiming → Results.
  STEPS: {
    rooms: [['space', 'Space', 'Rooms, sizes, drawing'], ['fit', 'Luminaires', 'Pick, suggest, place'], ['results', 'Results', 'Plan, section, 3D']],
    sports: [['space', 'Field', 'Sport, class, size'], ['fit', 'Masts & aiming', 'Layout, pattern, aim'], ['results', 'Results', 'Pitch, seats, glare']],
  },
  _steps: {},
  _scopeKey() { return this.scope === 'sports' ? 'sports' : 'rooms'; },
  get step() { return this._steps[this._scopeKey()] || 'space'; },
  stepList() { return this.STEPS[this._scopeKey()]; },
  resultsVisible() { return !this._active || this.step === 'results' || this.view === '3d'; },
  setStep(s) {
    if (!this.STEPS.rooms.some(x => x[0] === s)) s = 'space';
    this._steps[this._scopeKey()] = s;
    if (typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id !== 'select') PlanTools.set('select');
    if (s !== 'space' && typeof PlanUI !== 'undefined') PlanUI._underlay = null;
    if (s !== 'fit' && typeof SportsCalc !== 'undefined') SportsCalc.focus = null;
    if (this.view === 'table' || this.view === '3d') { this.setView('plan'); return; }
    this._renderBar();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    PlanEngine.requestDraw({ fg: true });
    if (s === 'results') this.liveKick(0);
  },

  // The luminaire picked in the Luminaires step: new fittings take it, the auto layout offers it first.
  lum: null,
  pickedLum() {
    if (this.lum && PhotoLib.get(this.lum)) return this.lum;
    const sel = [...PlanMarkup.selectedIds].map(id => (AppState.planMarkup.elements || []).find(e => e.id === id)).find(e => e && e.props && PhotoLib.get(e.props.photoId));
    if (sel) return sel.props.photoId;
    const first = PhotoLib.list().find(p => p.group !== 'road');
    return first ? first.id : null;
  },
  placeDefaults(props) {
    if (!this._active || PlanMarkup.context !== 'lighting') return;
    const id = this.pickedLum(), p = id && PhotoLib.get(id);
    if (!p) return;
    props.photoId = id;
    if (p.watts) props.watts = Math.round(p.watts);
  },

  // ─── Live results ───
  // The item being worked on is recalculated a moment after each edit, quietly.
  live: (() => { try { return localStorage.getItem('protectionpro-lighting-live') !== '0'; } catch (_) { return true; } })(),
  _liveTimer: null,
  _liveBusy: false,
  setLive(on) {
    this.live = !!on;
    try { localStorage.setItem('protectionpro-lighting-live', on ? '1' : '0'); } catch (_) { /* private mode */ }
    if (on) this.liveKick(0);
  },
  // The zone the selection belongs to: a selected zone, or the room a selected fitting is in.
  focusZone() {
    const pm = AppState.planMarkup, ids = [...PlanMarkup.selectedIds];
    if (typeof SportsCalc !== 'undefined' && SportsCalc.focus) {
      const r = (pm.rooms || []).find(x => x.id === SportsCalc.focus.roomId);
      if (r) return r;
    }
    const z = (pm.rooms || []).find(r => ids.includes(r.id));
    if (z) return z;
    const el = (pm.elements || []).find(e => ids.includes(e.id));
    if (!el) return null;
    return (pm.rooms || []).find(r => (r.kind || 'room') === 'room' && r.points && r.points.length >= 3 && PlanEngine._pointInPoly({ x: el.x, y: el.y }, r.points)) || null;
  },
  _resultKey(room) { return room.kind === 'escape' ? 'em:' + room.id : room.id; },
  _sigOf(room) {
    try { return room.kind === 'escape' ? EmergCalc.signature(room) : RoomCalc.signature(room); } catch (_) { return null; }
  },
  isStale(room) {
    const r = RoomCalc.results[this._resultKey(room)];
    return !r || r.sig !== this._sigOf(room);
  },
  liveKick(delay = 700) {
    clearTimeout(this._liveTimer);
    if (!this.live || !this._active || PlanMarkup.context !== 'lighting') return;
    this._liveTimer = setTimeout(() => this._liveRun(), delay);
  },
  async _liveRun() {
    const room = this.focusZone();
    if (!room || !PlanEngine.factor() || !room.points || room.points.length < 2) return;
    if (this._liveBusy || RoomCalc._busy) { this.liveKick(); return; }
    if (!this.isStale(room)) return;
    if ((room.kind || 'room') === 'room' && !RoomCalc._fittingsIn(room).length) return;   // nothing to calculate yet
    // Once per state of the inputs: a calculation that failed is not retried until something changes.
    const tried = room.id + '|' + this._sigOf(room);
    if (tried === this._liveTried) return;
    this._liveTried = tried;
    const quiet = RoomCalc.quiet;
    this._liveBusy = true; RoomCalc.live = true; RoomCalc.quiet = true;
    this._renderStripState('Calculating…');
    try { await this.calcZone(room); } finally {
      this._liveBusy = false; RoomCalc.live = false; RoomCalc.quiet = quiet;
    }
    if (!this._active) return;
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    if (this.view === 'section' && typeof LightSection !== 'undefined') this._renderSection();
  },
  // One zone, whatever its kind.
  async calcZone(room) {
    const k = room.kind || 'room';
    if (k === 'room') { await RoomCalc.run([room]); if (RoomLighting.read(room).emerg !== 'none') await EmergCalc.run([room]); }
    else if (k === 'outdoor' || k === 'perimeter') await AreaCalc.run([room]);
    else if (k === 'sports') await SportsCalc.run([room]);
    else if (k === 'obtrusive') await ObtrusiveCalc.run([room]);
    else if (k === 'escape') await EmergCalc.run([room]);
  },

  // ─── Verdict strip ───
  // The zone's result against its targets, pinned at the top of its panel.
  SHORT: { em: 'Ēm', uo: 'U₀', ugr: 'UGR', wallE: 'Walls', ceilE: 'Ceiling', ez: 'Ēz', u2: 'U₂', u1: 'U₁', gr: 'GR', tilt: 'Tilt', evMin: 'Ev min', evRatio: 'Ev ratio', band: 'Band', ratio: 'Ratio' },
  stripHtml(room) {
    const r = RoomCalc.results[this._resultKey(room)];
    const k = room.kind || 'room';
    const stale = this.isStale(room);
    let cells = '', verdict = '';
    if (r && r.res) {
      const checks = (r.res.checks || []).filter(c => c.pass != null && c.value != null);
      const short = (c) => (k === 'sports' && c.key === 'em') ? 'Ēh' : (this.SHORT[c.key] || c.label);
      const fmt = (c) => c.unit === 'lx' ? (c.value < 10 ? c.value.toFixed(1) : Math.round(c.value)) : c.unit === '°' ? c.value.toFixed(0) + '°' : (Math.abs(c.value) < 10 ? c.value.toFixed(2) : c.value.toFixed(1));
      const cell = (c) => `<div class="lw-strip-cell"><span>${escHtml(short(c))} ${c.op === '>=' ? '≥' : '≤'} ${escHtml(String(c.req))}</span><b class="${c.pass ? 'ok' : 'bad'}">${escHtml(String(fmt(c)))}</b></div>`;
      const shown = checks.slice(0, 3);
      cells = shown.map(cell).join('');
      if (r.res.power && r.res.power.wm2 != null) cells += `<div class="lw-strip-cell"><span>W/m²</span><b>${Number(r.res.power.wm2).toFixed(1)}</b></div>`;
      else if (checks[3]) cells += cell(checks[3]);
      const pass = r.res.pass;
      verdict = pass === true ? '<span class="lw-chip ok">Pass</span>' : pass === false ? '<span class="lw-chip bad">Fail</span>' : '';
    }
    const none = (k === 'room' && !RoomCalc._fittingsIn(room).length) ? 'No luminaires in this room yet' : 'Not calculated yet';
    const state = !r ? none : stale ? (this.live ? 'Out of date — recalculating after your edit' : 'Out of date') : 'Up to date';
    return `<div class="lw-strip${r && stale ? ' stale' : ''}" data-lw-strip>
      <div class="lw-strip-head"><b>${escHtml(room.name || this.KIND[k])}</b>${verdict}</div>
      ${cells ? `<div class="lw-strip-cells">${cells}</div>` : ''}
      <div class="lw-strip-state"><span data-lw-strip-state>${escHtml(state)}</span>${!r && k === 'room' && !RoomCalc._fittingsIn(room).length
        ? (this.step === 'fit' ? '' : '<button type="button" class="btn-small" data-lw-step="fit">Add luminaires ›</button>')
        : !r || stale ? '<button type="button" class="btn-small" data-lw-calcone>Calculate</button>' : ''}</div></div>`;
  },
  _renderStripState(text) {
    document.querySelectorAll('[data-lw-strip-state]').forEach(el => { el.textContent = text; });
  },

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
    if (changed && (this.view === 'plan' || this.view === 'section') && typeof PlanTools !== 'undefined') PlanTools.set('select');
  },
  // The plan's selection changed: the section, the phone sheet and the live result follow it.
  onSelection() {
    if (!this._active) return;
    if (typeof SportsCalc !== 'undefined' && SportsCalc.focus && !PlanMarkup.selectedIds.has(SportsCalc.focus.roomId)) {
      SportsCalc.focus = null;
      PlanUI.renderProps(); PlanEngine.requestDraw({ fg: true });
    }
    if (this.view === 'section') this._renderSection();
    this._renderSheet();
    this.liveKick(300);
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
    else { this._renderBar(); if (typeof PlanUI !== 'undefined') PlanUI.renderPalette(); this._renderSection(); this._renderSheet(); }
  },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('lighting-workspace');
    if (!host) return;
    this._built = true;
    host.innerHTML = `<div class="lw-bar" id="lw-bar"></div>
      <div class="lw-body">
        <div class="lw-plan" id="lw-plan">
          <section class="lw-section" id="lw-section" aria-label="Section" hidden></section>
          <div class="lw-sheethead" id="lw-sheethead"></div>
          <nav class="lw-steps lw-steps-bottom" id="lw-steps-bottom" aria-label="Steps"></nav>
        </div>
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
      else if (e.target.id === 'lw-show' || e.target.name === 'lw-show') {
        RoomCalc.enabled = e.target.value !== 'off';
        if (RoomCalc.enabled) RoomCalc.display = e.target.value;
        PlanEngine.requestDraw({ fg: true });
        if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
      }
      else if (e.target.id === 'lw-isostep') { RoomCalc.isoStep = +e.target.value || 0; PlanEngine.requestDraw({ fg: true }); }
      else if (e.target.id === 'lw-dist') { RoomCalc.showDist = e.target.checked; PlanEngine.requestDraw({ fg: true }); }
      else if (e.target.id === 'lw-live') { this.setLive(e.target.checked); this._renderBar(); PlanMarkup.refreshProps(); }
      else if (e.target.dataset && e.target.dataset.ls && typeof LightSection !== 'undefined') this._onSectionInput(e);
    });
    host.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.ls === 'pos') this._onSectionInput(e); });
    // Keep the Drawing box open or shut across re-renders of the panel.
    host.addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('[data-lw-drawing]')) this._drawingOpen = e.target.open; }, true);
    window.addEventListener('resize', () => { if (this._active) this._renderSheet(); });
  },

  setView(view) {
    this.view = ['table', '3d', 'section'].includes(view) ? view : 'plan';
    if (this.view === 'section' && this.scope === 'sports') this.view = 'plan';
    const plan = document.getElementById('lw-plan'), table = document.getElementById('lw-tableview'), v3 = document.getElementById('lw-3d');
    if (!plan || !table) return;
    const planish = this.view === 'plan' || this.view === 'section';
    plan.hidden = !planish;
    table.hidden = this.view !== 'table';
    if (v3) v3.hidden = this.view !== '3d';
    if (this.view !== '3d' && typeof Light3D !== 'undefined') Light3D.deactivate();
    if (planish) {
      PlanMarkup.activate(plan, 'lighting');
      this._renderSection();
      this._renderSheet();
      // the section takes room from the plan: fit the plan to the cut room again
      const sr = this.view === 'section' && this._sectionRoom();
      if (sr && PlanEngine.zoomToPoints) requestAnimationFrame(() => { PlanEngine.resize(); PlanEngine.zoomToPoints(sr.points); });
    } else {
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
    const planish = this.view === 'plan' || this.view === 'section', v3 = this.view === '3d';
    const I = (n) => PlanMarkup._icon(n);
    const pm = AppState.planMarkup;
    const floors = (pm.floors || []).slice().sort((a, b) => (b.level || 0) - (a.level || 0));
    const vb = (v, label) => `<button type="button" class="plan-mode-btn${this.view === v ? ' active' : ''}" data-lw-view="${v}" aria-pressed="${this.view === v}">${label}</button>`;
    bar.innerHTML = `
      ${planish ? `<nav class="lw-steps lw-steps-top" aria-label="Steps">${this._stepsHtml()}</nav>` : ''}
      <div class="plan-modes" role="group" aria-label="View">
        ${vb('plan', 'Plan')}${this.scope === 'sports' ? '' : vb('section', 'Section')}${vb('3d', '3D')}${vb('table', 'Table')}
      </div>
      ${v3 ? Light3D.barHtml() : ''}
      ${planish ? `<div class="plan-tb-group lw-edit-tools">
        <button class="plan-tool-btn${PlanTools.active && PlanTools.active.id === 'select' ? ' active' : ''}" data-tool="select" title="Select / move (V)" aria-label="Select">${I('select')} <span class="lw-sel-label">Select</span></button>
        <button class="plan-tb-btn plan-icon-btn" data-lw-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${I('undo')}</button>
        <button class="plan-tb-btn plan-icon-btn" data-lw-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${I('redo')}</button>
        <button class="plan-tb-btn" data-lw-act="fit" title="Zoom to fit" aria-label="Zoom to fit">${I('fit')} <span class="lw-fit-label">Fit</span></button>
      </div>` : ''}
      <div class="plan-tb-spacer"></div>
      ${(planish || v3) && floors.length > 1 ? `<label class="plan-tb-field">Floor <select id="lw-floor-select">${floors.map(f =>
        `<option value="${escHtml(f.id)}"${f.id === pm.activeFloorId ? ' selected' : ''}>${escHtml(f.name)} (L${f.level})</option>`).join('')}</select></label>` : ''}
      ${planish ? `<label class="plan-tb-field lw-live" title="Recalculate the room, area or field you are working on a moment after each change"><input type="checkbox" id="lw-live"${this.live ? ' checked' : ''}> Live results</label>` : ''}
      <button class="plan-tb-btn lw-bar-extra" data-lw="photolib">Luminaire library…</button>
      <button class="plan-tb-btn lw-bar-extra" data-lw="pdf">PDF report</button>
      ${v3 ? `<button class="btn-primary" data-l3="calc">${Light3D.calcLabel()}</button>`
        : '<button class="btn-primary" data-lw="calc">Calculate all</button>'}`;
    const bottom = document.getElementById('lw-steps-bottom');
    if (bottom) bottom.innerHTML = planish ? this._stepsHtml() : '';
  },

  // The three step buttons (the bar on a desktop, the bottom of the screen on a phone).
  _stepsHtml() {
    const cur = this.step, list = this.stepList();
    const at = list.findIndex(x => x[0] === cur);
    return list.map(([k, label, sub], i) => `<button type="button" class="lw-step${k === cur ? ' on' : ''}${i < at ? ' done' : ''}" data-lw-step="${k}"${k === cur ? ' aria-current="step"' : ''} title="${escHtml(sub)}">
        <span class="lw-step-n" aria-hidden="true">${i < at ? '✓' : i + 1}</span><span class="lw-step-t"><b>${escHtml(label)}</b><small>${escHtml(sub)}</small></span></button>`).join('');
  },

  // ─── The left panel, per step ───
  _zoneList(rooms, empty) {
    const KIND = { room: 'Room', outdoor: 'Outdoor area', perimeter: 'Fence', sports: 'Sports field', obtrusive: 'Obtrusive light', escape: 'Escape route' };
    let html = `<div class="plan-sec-head"><span>On this floor</span><small>${rooms.length}</small></div>`;
    if (!rooms.length) return html + `<div class="plan-props-empty">${empty}</div>`;
    for (const r of rooms) {
      const v = this.verdictOf(r);
      const cls = v === 'Pass' ? 'ok' : v === 'Fail' ? 'bad' : '';
      html += `<button type="button" class="plan-zone-row${PlanMarkup.selectedIds.has(r.id) ? ' selected' : ''}" data-plan-zone="${escHtml(r.id)}">
        <span><b>${escHtml(r.name || KIND[r.kind || 'room'])}</b><small>${KIND[r.kind || 'room']}</small></span>${v ? `<span class="plan-verdict ${escHtml(cls)}">${escHtml(v)}</span>` : ''}</button>`;
    }
    return html;
  },

  paletteHtml() {
    const pm = AppState.planMarkup;
    const scope = this.scope, sports = scope === 'sports', step = this.step;
    const rooms = (pm.rooms || []).filter(r => r.points && r.points.length >= 2 && this.inScope(r.kind));
    const tools = PLAN_DEFS.lightingTools().filter(it => sports ? (it.type === 'sportsfield' || it.type === 'obtrusive')
      : scope === 'rooms' ? it.type !== 'sportsfield' : true);
    const item = (it) => PlanUI._palItem(it);
    const empty = sports ? 'Pick Sports field and click the centre spot — no drawing needed.' : 'Start with Room from a shape (no drawing needed), or import the drawing below and detect or draw the rooms.';
    if (step === 'space') {
      const floors = AppState.planFloors().length;
      const s = pm.scale, plans = (pm.plans || []).length + ((typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.list() : []).length);
      const sum = plans ? `${plans} on this floor · ${s && s.factor ? 'scale set' : 'scale not set'}` : (s && s.factor ? 'none · blank floor to scale' : 'none');
      return `<div class="plan-sec-head"><span>${sports ? 'Add' : 'Add a room or area'}</span></div>
        <div class="plan-pal-list">${tools.map(item).join('')}</div>
        ${this._zoneList(rooms, empty)}
        <div class="plan-sec-head"><span>Floors</span><small>${floors}</small></div>
        <button type="button" class="plan-btn" data-act="floors">Add, rename or reorder floors…</button>
        <details class="lw-drawing" data-lw-drawing${this._drawingOpen ? ' open' : ''}>
          <summary><b>${sports ? 'Site drawing' : 'Drawing'}</b><small>${escHtml(sum)}</small></summary>
          <p class="lw-drawing-note">Optional. Import a plan, PDF or DXF to trace on, and set its scale.${sports ? '' : ' A room from a shape needs none.'}</p>
          ${PlanUI._underlaysPanel()}
        </details>`;
    }
    if (step === 'fit') {
      if (sports) {
        return `<div class="plan-sec-head"><span>Masts &amp; aiming</span></div>
          <p class="lw-hint">Select a field, then click a mast on the plan: its aim points can be dragged across the pitch. Set out the masts, the pattern and the optimiser in the field's panel.</p>
          ${this._zoneList(rooms, empty)}
          <button type="button" class="plan-btn" data-act="photolib">Floodlight library…</button>`;
      }
      const def = PLAN_DEFS.element('bd_light');
      const libs = PhotoLib.list().filter(p => p.group !== 'road');
      const cur = this.pickedLum();
      const lumRows = libs.map(p => `<button type="button" class="lw-lum${p.id === cur ? ' on' : ''}" data-lwp-lum="${escHtml(p.id)}" aria-pressed="${p.id === cur}">
          ${typeof PhotoView !== 'undefined' ? PhotoView.thumbSvg(p, 36) : ''}<span><b>${escHtml(p.name)}</b><small>${Math.round(p.lumens)} lm · ${Math.round(p.watts || 0)} W${p.generic ? ' · generic' : ''}</small></span></button>`).join('');
      const fittings = (pm.elements || []).filter(e => RoomCalc._isCalcLight(e));
      const bare = fittings.filter(e => !(e.props && PhotoLib.get(e.props.photoId))).length;
      return `<div class="plan-sec-head"><span>Luminaire</span><small>new fittings use it</small></div>
        <div class="lw-lums">${lumRows || '<div class="plan-props-empty">The library is empty — add a luminaire.</div>'}</div>
        <div class="plan-btn-row"><button type="button" class="plan-btn" data-act="photolib">Library…</button>${cur ? `<button type="button" class="plan-btn" data-lwp-data="${escHtml(cur)}">Data sheet</button>` : ''}</div>
        <div class="plan-sec-head"><span>Place</span></div>
        <div class="plan-pal-list">${def ? item({ type: 'bd_light', kind: 'element', name: def.name, color: def.color, desc: 'One at a time, in a row or an array' }) : ''}</div>
        <p class="lw-hint">Or select a room: its panel suggests layouts that meet the targets.</p>
        <label class="plan-field-check"><input type="checkbox" id="lw-dist"${RoomCalc.showDist ? ' checked' : ''}> Light distribution of each fitting</label>
        <div class="lw-hint">${fittings.length} fitting${fittings.length === 1 ? '' : 's'} on this floor${bare ? ` · <b>${bare} without a luminaire</b>` : ''}</div>
        ${this._zoneList(rooms, empty)}`;
    }
    // results
    return `<div class="plan-sec-head"><span>Show on the plan</span></div>
      <div class="lw-show">${this._showHtml()}</div>
      ${this._zoneList(rooms, empty)}
      <div class="plan-btn-row"><button type="button" class="plan-btn" data-lwp-calc>Calculate all</button><button type="button" class="plan-btn" data-lwp-pdf>PDF report</button></div>`;
  },

  // The palette's own controls (luminaire pick, data sheet, calculate, PDF).
  onPaletteClick(e) {
    const lum = e.target.closest('[data-lwp-lum]');
    if (lum) { this.lum = lum.dataset.lwpLum; PlanUI.renderPalette(); if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); return true; }
    const data = e.target.closest('[data-lwp-data]');
    if (data) { PhotoLib.open(data.dataset.lwpData); return true; }
    if (e.target.closest('[data-lwp-calc]')) { this.calcAll(); return true; }
    if (e.target.closest('[data-lwp-pdf]')) { if (typeof LightReport !== 'undefined') LightReport.export(); return true; }
    return false;
  },

  // ─── Section view: the selected room's section docked under the plan ───
  _sectionRoom() {
    const z = this.focusZone();
    return z && (z.kind || 'room') === 'room' && z.points && z.points.length >= 3 ? z : null;
  },
  _renderSection() {
    const host = document.getElementById('lw-section');
    if (!host || typeof LightSection === 'undefined') return;
    const on = this._active && this.view === 'section';
    host.hidden = !on;
    if (!on) { if (LightSection.cut) { LightSection.cut = null; PlanEngine.requestDraw({ fg: true }); } return; }
    const room = this._sectionRoom();
    if (!room) {
      host.innerHTML = '<p class="lw-hint lw-section-empty">Select a room on the plan to see its section: the fittings\' polar curves in the cut plane and the lux along the cut.</p>';
      LightSection.cut = null; PlanEngine.requestDraw({ fg: true });
      return;
    }
    LightSection.mountIn(host, room);
    if (typeof PlanEngine !== 'undefined' && PlanEngine.resize) PlanEngine.resize();
  },
  _onSectionInput(e) {
    const k = e.target.dataset.ls, host = document.getElementById('lw-section');
    if (!host || !host.contains(e.target)) return;
    LightSection.onInput(k, e.target.value);
    LightSection.render(host);
  },

  // ─── Phone: the panels as one bottom sheet ───
  sheet: 'peek',          // peek | tools | item
  _isPhone() { return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches; },
  setSheet(s) { this.sheet = s; this._renderSheet(); },
  _renderSheet() {
    const head = document.getElementById('lw-sheethead');
    const planEl = document.getElementById('lw-plan');
    if (!head || !planEl) return;
    const phone = this._isPhone() && this._active && (this.view === 'plan' || this.view === 'section');
    planEl.classList.toggle('lw-phone', phone);
    planEl.dataset.sheet = this.sheet;
    if (!phone) { head.innerHTML = ''; return; }
    const z = this.focusZone();
    const stepName = (this.stepList().find(x => x[0] === this.step) || [])[1] || 'Tools';
    const tab = (k, label) => `<button type="button" class="lw-sheet-tab${this.sheet === k ? ' on' : ''}" data-lw-sheet="${k}" aria-pressed="${this.sheet === k}">${escHtml(label)}</button>`;
    const grip = this.sheet === 'peek' ? (z ? 'item' : 'tools') : 'peek';
    head.innerHTML = `<button type="button" class="lw-sheet-grip" data-lw-sheet="${escHtml(grip)}" aria-label="${this.sheet === 'peek' ? 'Open the panel' : 'Close the panel'}"><span></span></button>
      ${z ? this.stripHtml(z) : `<p class="lw-hint lw-sheet-empty">${this.scope === 'sports' ? 'Tap a field to see its result.' : 'Tap a room to see its result.'}</p>`}
      <div class="lw-sheet-tabs" role="group" aria-label="Panel">${tab('tools', stepName + ' tools')}${tab('item', z ? (z.name || this.KIND[z.kind || 'room']) : 'Selected')}</div>`;
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
  // `step` picks the workflow step; by default an empty room opens on Luminaires
  // and a calculated one on Results.
  openOnPlan(id, floorId, step) {
    const tab = this._tabFor(id);
    this._showTab(tab);
    if (this.view !== 'section') this.view = 'plan';
    const room0 = (AppState.planMarkup.rooms || []).find(r => r.id === id);
    const want = step || (room0 && (RoomCalc.results[id] ? 'results'
      : ((room0.kind || 'room') === 'room' && !RoomCalc._fittingsIn(room0).length) || (room0.kind === 'sports' && !SportsCalc.read(room0).masts.length) ? 'fit' : null));
    if (want) this._steps[tab === 'sports' ? 'sports' : 'rooms'] = want;
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
    const st = e.target.closest('[data-lw-step]');
    if (st) { this.setStep(st.dataset.lwStep); return; }
    const sh = e.target.closest('[data-lw-sheet]');
    if (sh) { const k = sh.dataset.lwSheet; this.setSheet(this.sheet === k && k !== 'peek' ? 'peek' : k); return; }
    if (e.target.closest('[data-lw-calcone]')) {
      const z = this.focusZone();
      if (z) this.calcZone(z).then(() => { PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); });
      return;
    }
    const go = e.target.closest('[data-lw-goview]');
    if (go) { this.setView(go.dataset.lwGoview); return; }
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
