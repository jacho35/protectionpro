/* ProtectionPro — Lighting workspace.
 *
 * Every room, outdoor area, perimeter and escape route of the project — across
 * all floors — in one list, with what each was calculated to and a verdict.
 * The calculations themselves are Plan's (RoomCalc / AreaCalc / EmergCalc);
 * this lists them, runs them all (stepping through the floors, then returning
 * to the one you were on), jumps to an item on its floor, and makes the PDF.
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

  KIND: { room: 'Room', outdoor: 'Outdoor area', perimeter: 'Perimeter', escape: 'Escape route' },

  hasData() {
    try {
      return AppState.planFloors().some(f => ((f.data && f.data.rooms) || []).some(r => r.lighting || r.kind));
    } catch (_) { return false; }
  },

  activate() {
    this._active = true;
    this._mount();
    this.render();
  },
  deactivate() { this._active = false; },
  refresh() { if (this._active) this.render(); },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('lighting-workspace');
    if (!host) return;
    this._built = true;
    host.innerHTML = `<aside class="lw-rail"><div class="lw-rail-head">Show</div><div class="lw-rail-list" id="lw-rail"></div></aside>
      <section class="lw-main" id="lw-main"></section>`;
    host.addEventListener('click', (e) => this._onClick(e));
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
    if (f === 'site') return items.filter(r => r.kind === 'outdoor' || r.kind === 'perimeter');
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
      + rl('site', 'Site (areas and fences)', cnt(r => r.kind === 'outdoor' || r.kind === 'perimeter'))
      + rl('escape', 'Escape routes', cnt(r => r.kind === 'escape'))
      + '<div class="lw-rail-sep"></div>'
      + rl('failing', 'Failing', cnt(r => r.verdict === 'Fail'))
      + rl('pending', 'Not calculated / out of date', cnt(r => r.verdict === 'Not calculated' || r.verdict === 'No fittings' || r.stale));
    const pass = cnt(r => r.verdict === 'Pass'), fail = cnt(r => r.verdict === 'Fail');
    const todo = cnt(r => r.verdict === 'Not calculated' || r.verdict === 'No fittings');
    const kw = items.reduce((s, r) => s + (r.watts || 0), 0) / 1000;
    const indoor = items.filter(r => r.kind === 'room' && r.leni != null);
    const kwh = indoor.reduce((s, r) => s + (r.kwh || 0), 0), ia = indoor.reduce((s, r) => s + (r.area || 0), 0);
    const shown = this._sorted(this._visible(items));
    const th = (key, label, cls) => `<th class="${cls || ''}"><button data-lw-sort="${key}">${label}${this.sort.key === key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    const num = (v, dp) => v == null ? '—' : Number(v).toFixed(dp);
    const rowHtml = (r) => {
      const em = r.em ? `${num(r.em.v, r.em.v < 10 ? 1 : 0)} <small>/ ${r.em.t}</small>` : '—';
      const glare = r.glare ? `${r.glare.label} ${num(r.glare.v, 1)} <small>/ ${r.glare.t}</small>` : '—';
      const vcls = r.verdict === 'Pass' ? 'ok' : r.verdict === 'Fail' ? 'bad' : 'muted';
      return `<tr>
        <td><b>${escHtml(r.name)}</b></td><td>${escHtml(r.floor)}</td><td>${this.KIND[r.kind]}</td><td class="lw-task">${escHtml(r.task)}</td>
        <td class="num">${em}${r.em && r.em.ev ? ' <small>lx min</small>' : ''}</td><td class="num">${num(r.uo, 2)}</td><td class="num">${glare}</td>
        <td class="num">${num(r.wm2, 1)}</td><td>${escHtml(r.emText)}</td>
        <td class="${vcls}"><b>${r.verdict}</b>${r.verdictNote ? ` <small>(${r.verdictNote})</small>` : ''}${r.failing.length ? `<small class="lw-why">${escHtml(r.failing.join(', '))}</small>` : ''}</td>
        <td><button class="lw-link" data-lw-locate="${escHtml(r.id)}" data-lw-floor="${escHtml(r.floorId)}">Locate</button></td></tr>`;
    };
    main.innerHTML = `<div class="lw-head"><h1>Lighting</h1>
        <div class="lw-actions">
          <button class="btn-small" data-lw="photolib">Photometry library</button>
          <button class="btn-small" data-lw="pdf"${items.length ? '' : ' disabled'}>PDF report</button>
          <button class="btn-primary" data-lw="calc"${items.length ? '' : ' disabled'}>Calculate all</button></div></div>
      <div class="lw-tiles">
        <div class="lw-tile"><span>Pass</span><b class="ok">${pass}</b></div>
        <div class="lw-tile"><span>Fail</span><b class="bad">${fail}</b></div>
        <div class="lw-tile"><span>Not calculated</span><b>${todo}</b></div>
        <div class="lw-tile"><span>Installed load</span><b>${kw.toFixed(2)} <small>kW</small></b></div>
        <div class="lw-tile"><span>LENI, rooms</span><b>${ia > 0 ? (kwh / ia).toFixed(1) : '—'} <small>kWh/m²·yr</small></b></div>
      </div>
      ${items.length ? `<div class="lw-tablewrap"><table class="lw-table"><thead><tr>
        ${th('name', 'Room / area')}${th('floor', 'Floor')}${th('kind', 'Type')}<th>Task</th>${th('em', 'Ēm / target (lx)', 'num')}${th('uo', 'U₀', 'num')}<th class="num">UGR / GR</th>${th('wm2', 'W/m²', 'num')}<th>Emergency</th>${th('verdict', 'Verdict')}<th></th>
        </tr></thead><tbody>${shown.map(rowHtml).join('') || '<tr><td colspan="11" class="muted">Nothing matches this filter.</td></tr>'}</tbody></table></div>`
        : `<div class="lw-empty"><p>No rooms, areas or routes yet.</p><p>In Plan, click inside a room with <b>Detect room</b> (or draw one), set its task, place or auto-layout fittings and calculate. They all appear here.</p></div>`}
      <p class="lw-note">Results belong to this session: open a project and press Calculate all. Targets follow the project's lighting standard (EN 12464-1 / EN 1838, or SANS 10114-1 / -2); outdoor areas use EN 12464-2.</p>`;
  },

  _onClick(e) {
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

  locate(id, floorId) {
    switchWorkspace('plan');
    const pm = AppState.planMarkup;
    if (floorId && floorId !== pm.activeFloorId) PlanMarkup.setActiveFloor(floorId);
    const room = (pm.rooms || []).find(r => r.id === id);
    if (!room) return;
    PlanMarkup.selectOnly(id);
    PlanMarkup.refreshProps();
    if (PlanEngine.zoomToPoints) PlanEngine.zoomToPoints(room.points);
    PlanEngine.requestDraw({ all: true });
  },

  // Every floor in turn, then back to the one that was open.
  async calcAll() {
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
        await EmergCalc.run();
      }
    } finally {
      if (pm.activeFloorId !== start) AppState.switchFloor(start);
      RoomCalc.quiet = false;
      if (UI.setBusy) UI.setBusy(false);
    }
    if (stats.uncal.length) UI.toast(`Not calibrated, so not calculated: ${stats.uncal.join(', ')}.`, 'warn', 7000);
    this.render();
  },
};
