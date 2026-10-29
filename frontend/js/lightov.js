/* ProtectionPro — Lighting project › Overview.
 *
 * The first tab of a Lighting project: one card per design it was set up for
 * (rooms & areas, roads, sports fields) listing every item with its result
 * and verdict, then obtrusive light, energy and the luminaire library, and
 * the electrical side (off until added). Calculate all runs every room, area,
 * field and obtrusive check on every floor (LightingWS.calcAll) and every road
 * cross-section (RoadLight.computeAll). Results are session-only, like the
 * calculations themselves. A road on the Road plan shows the result the Road
 * plan last calculated.
 */

const LightOverview = {
  _active: false,
  _built: false,
  MAX_ROWS: 6,

  activate() {
    this._active = true;
    // Report and Calculate all here cover every kind, not one tab's.
    if (typeof LightingWS !== 'undefined') LightingWS.scope = 'all';
    this._mount();
    const tb = document.getElementById('toolbar');
    const ws = document.getElementById('lightov-workspace');
    if (tb && ws) ws.style.top = tb.offsetHeight + 'px';
    this.render();
  },
  deactivate() { this._active = false; },
  refresh() { if (this._active) this.render(); },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('lightov-workspace');
    if (!host) return;
    this._built = true;
    host.innerHTML = '<div class="lo-scroll"><main class="lo-main" id="lo-main"></main></div>';
    host.addEventListener('click', (e) => this._onClick(e));
  },

  // ─── Data ───
  _kinds() { return Workspaces.lightingKinds(); },

  _zoneRows() {
    try { return LightingWS._items(); } catch (_) { return []; }
  },

  _roadRows() {
    const out = [];
    const sl = AppState.reticulation && AppState.reticulation.streetLighting;
    for (const d of (sl && sl.roadDesigns) || []) {
      const r = RoadLight._results[d.id];
      const cls = [...new Set((d.sections || []).map(s => s.cls).filter(Boolean))].join(' · ');
      out.push({ id: d.id, kind: 'design', name: d.name, sub: cls || 'Cross-section',
        value: r && r.energy && isFinite(r.energy.wPerKm) ? `${Math.round(r.energy.wPerKm)} W/km` : '',
        verdict: !r || r.error ? 'Not calculated' : r.pass ? 'Pass' : 'Fail' });
    }
    const rp = sl && sl.roadPlan;
    const res = typeof RoadPlan !== 'undefined' && RoadPlan._res && !RoadPlan._resStale && RoadPlan._res.roads ? RoadPlan._res.roads : [];
    for (const road of (rp && rp.roads) || []) {
      const rr = res.find(x => x.id === road.id);
      out.push({ id: road.id, kind: 'road', name: road.name, sub: `Road plan · ${(road.poles || []).length} poles`, value: '',
        verdict: !rr || rr.pass == null ? 'Not calculated' : rr.pass ? 'Pass' : 'Fail' });
    }
    return out;
  },

  // ─── Render ───
  render() {
    const main = document.getElementById('lo-main');
    if (!main) return;
    const kinds = this._kinds();
    const zones = this._zoneRows();
    const rooms = zones.filter(r => r.kind !== 'sports' && r.kind !== 'obtrusive');
    const sports = zones.filter(r => r.kind === 'sports');
    const obtr = zones.filter(r => r.kind === 'obtrusive');
    const roads = kinds.includes('roads') || this._roadRows().length ? this._roadRows() : [];
    const shown = [].concat(kinds.includes('rooms') || rooms.length ? rooms : [], roads, kinds.includes('sports') || sports.length ? sports : [], obtr);
    const n = (v) => shown.filter(r => r.verdict === v).length;
    const todo = shown.length - n('Pass') - n('Fail');
    const cards = [];
    if (kinds.includes('rooms') || rooms.length) cards.push(this._card('rooms', 'Rooms & areas', rooms.map(r => this._zoneItem(r)),
      `<button class="btn-small" data-lo-add="room">+ Room</button><button class="btn-small" data-lo-add="roomshape">+ Room from a shape</button><button class="btn-small" data-lo-add="outdoor">+ Outdoor area</button>`,
      'No rooms or areas yet.'));
    if (kinds.includes('roads') || roads.length) cards.push(this._card('roads', 'Roads', roads.map(r => this._roadItem(r)),
      `<button class="btn-small" data-lo-add="design">+ Cross-section</button><button class="btn-small" data-lo-add="road">+ Road on plan</button>`,
      'No road designs yet.'));
    if (kinds.includes('sports') || sports.length) cards.push(this._card('sports', 'Sports fields', sports.map(r => this._zoneItem(r)),
      `<button class="btn-small" data-lo-add="sportsfield">+ Sports field</button>`,
      'No sports fields yet.'));

    const kw = zones.reduce((s, r) => s + (r.watts || 0), 0) / 1000;
    const roadKw = roads.filter(r => r.kind === 'design').length;
    const lib = (AppState.reticulation && AppState.reticulation.streetLighting && AppState.reticulation.streetLighting.photometry) || {};
    const nLib = Object.keys(lib).length;
    const obFail = obtr.filter(r => r.verdict === 'Fail').length;
    const circ = Workspaces.roadCircuitsOn(), sched = Workspaces.isVisible('schedules'), sld = Workspaces.isVisible('sld');
    const elec = [];
    if (kinds.includes('roads') && !circ) elec.push('<button class="btn-small" data-lo="circuits">Add street-light circuits</button>');
    if (kinds.includes('rooms') && !sched) elec.push('<button class="btn-small" data-lo="schedules">Add board schedules</button>');
    if (!sld) elec.push('<button class="btn-small" data-lo="sld">Add the single line</button>');
    const on = [circ && kinds.includes('roads') ? 'street-light circuits' : '', sched ? 'board schedules' : '', sld ? 'single line' : ''].filter(Boolean);

    main.innerHTML = `
      <div class="lo-head">
        <h1>Overview</h1>
        <span class="lo-sum">${shown.length} item${shown.length === 1 ? '' : 's'} · <b class="ok">${n('Pass')} pass</b> · <b class="bad">${n('Fail')} fail</b> · ${todo} not calculated</span>
        <span class="lo-spacer"></span>
        <button class="btn-small" data-lo="photolib">Luminaire library…</button>
        <button class="btn-small" data-lo="calc">Calculate all</button>
        <button class="btn-primary" data-lo="pdf">Lighting report (PDF)</button>
      </div>
      <div class="lo-cards">${cards.join('')}</div>
      <div class="lo-tiles">
        <section class="lo-tile"><h2>Obtrusive light</h2>
          <b>${obtr.length ? `${obtr.length} check${obtr.length === 1 ? '' : 's'}${obFail ? ` · <span class="bad">${obFail} fail</span>` : ''}` : 'No checks yet'}</b>
          <span>Property lines and roads, against every outdoor luminaire: area lights, road poles and sports floods.</span>
          ${obtr.length ? obtr.slice(0, 3).map(r => this._zoneItem(r)).join('') : `<button class="lo-link" data-lo-add="obtrusive">+ Obtrusive light check</button>`}</section>
        <section class="lo-tile"><h2>Energy</h2>
          <b>${kw > 0 ? kw.toFixed(2) + ' kW' : '—'}</b>
          <span>Installed load of the calculated rooms, areas and fields${roadKw ? '; roads in W/km on their cards' : ''}.</span></section>
        <section class="lo-tile"><h2>Luminaires</h2>
          <b>${nLib} type${nLib === 1 ? '' : 's'}</b>
          <span>One library for rooms, roads and floods: IES / LDT files and generic optics.</span></section>
      </div>
      <div class="lo-elec">
        <b>Electrical side</b>
        <span>${on.length ? 'On: ' + escHtml(on.join(', ')) + '.' : 'Not part of this project.'}</span>
        <span class="lo-spacer"></span>
        ${elec.join('')}
        <button class="btn-small" data-lo="type">Project type &amp; workspaces…</button>
      </div>
      <p class="lw-note">Results belong to this session: open a project and press Calculate all. A road on the Road plan shows the Road plan's last result.</p>`;
  },

  _card(id, title, items, adds, empty) {
    const more = items.length - this.MAX_ROWS;
    return `<section class="lo-card" aria-labelledby="lo-h-${id}">
      <div class="lo-card-head"><h2 id="lo-h-${id}">${title}</h2><span>${items.length}</span><span class="lo-spacer"></span>
        <button class="lo-link" data-lo-tab="${id}">Open tab</button></div>
      <div class="lo-rows">${items.slice(0, this.MAX_ROWS).join('') || `<div class="lo-empty">${empty}</div>`}
        ${more > 0 ? `<button class="lo-link lo-more" data-lo-tab="${id}">+${more} more</button>` : ''}</div>
      <div class="lo-card-foot">${adds}</div>
    </section>`;
  },

  _chip(verdict, note) {
    const cls = verdict === 'Pass' ? 'ok' : verdict === 'Fail' ? 'bad' : '';
    return `<span class="lo-chip ${escHtml(cls)}">${escHtml(verdict)}${note ? ` · ${escHtml(note)}` : ''}</span>`;
  },

  _zoneItem(r) {
    const v = r.em ? `${Number(r.em.v).toFixed(r.em.v < 10 ? 1 : 0)} lx` : r.glare ? `${r.glare.label} ${Number(r.glare.v).toFixed(1)}` : '';
    return `<button class="lo-row" data-lo-zone="${escHtml(r.id)}" data-lo-floor="${escHtml(r.floorId)}">
      <span class="lo-row-name"><b>${escHtml(r.name)}</b><small>${escHtml(r.task || LightingWS.KIND[r.kind])}${r.floor ? ' · ' + escHtml(r.floor) : ''}</small></span>
      <span class="lo-row-val">${v}</span>${this._chip(r.verdict, r.verdict === 'Fail' && r.failing.length ? r.failing[0] : r.stale ? 'out of date' : '')}</button>`;
  },

  _roadItem(r) {
    return `<button class="lo-row" data-lo-${escHtml(r.kind)}="${escHtml(r.id)}">
      <span class="lo-row-name"><b>${escHtml(r.name)}</b><small>${escHtml(r.sub)}</small></span>
      <span class="lo-row-val">${escHtml(r.value)}</span>${this._chip(r.verdict)}</button>`;
  },

  // ─── Actions ───
  _onClick(e) {
    const z = e.target.closest('[data-lo-zone]');
    if (z) { LightingWS.view = 'plan'; LightingWS.locate(z.dataset.loZone, z.dataset.loFloor); return; }
    const d = e.target.closest('[data-lo-design]');
    if (d) { RoadLight._selId = d.dataset.loDesign; this._roads('design'); return; }
    const rd = e.target.closest('[data-lo-road]');
    if (rd) { if (typeof RoadPlan !== 'undefined') RoadPlan._selRoad = rd.dataset.loRoad; this._roads('plan'); return; }
    const t = e.target.closest('[data-lo-tab]');
    if (t) {
      const tab = t.dataset.loTab;
      if (tab === 'roads') this._roads();
      else switchWorkspace(tab === 'sports' ? 'sports' : 'lighting');
      return;
    }
    const add = e.target.closest('[data-lo-add]');
    if (add) { this._add(add.dataset.loAdd); return; }
    const a = e.target.closest('[data-lo]');
    if (!a) return;
    const act = a.dataset.lo;
    if (act === 'calc') this.calcAll();
    else if (act === 'pdf') { if (typeof LightReport !== 'undefined') LightReport.export(); }
    else if (act === 'photolib') PhotoLib.open();
    else if (act === 'type') Workspaces.openSettings().then(ok => { if (ok) this.refresh(); });
    else if (act === 'circuits') {
      AppState.roadCircuits = true; AppState.dirty = true;
      Workspaces.refresh();
      StreetLight._view = 'circuits';
      switchWorkspace('streetlight');
    } else if (act === 'schedules' || act === 'sld') {
      AppState.extraWorkspaces = (AppState.extraWorkspaces || []).concat([act]); AppState.dirty = true;
      Workspaces.refresh();
      switchWorkspace(act);
    }
  },

  // The Roads tab, on the cross-section or road-plan view.
  _roads(view) {
    if (view) StreetLight._view = view;
    switchWorkspace('streetlight');
  },

  // Open the tab that draws it, with the tool armed.
  _add(what) {
    if (what === 'design') { this._roads('design'); RoadLight.newDesign(); return; }
    if (what === 'road') { this._roads('plan'); return; }
    const tab = what === 'sportsfield' || (what === 'obtrusive' && !this._kinds().includes('rooms')) ? 'sports' : 'lighting';
    if (!Workspaces.isVisible(tab)) LightingWS._showTab(tab);
    LightingWS.view = 'plan';
    LightingWS._steps[tab === 'sports' ? 'sports' : 'rooms'] = 'space';   // the drawing tools live in the Space / Field step
    switchWorkspace(tab);
    const btn = document.querySelector(`#lighting-workspace .plan-pal-item[data-type="${what}"]`);
    if (btn) btn.click();
  },

  async calcAll() {
    const zones = this._zoneRows();
    const designs = (AppState.reticulation && AppState.reticulation.streetLighting && AppState.reticulation.streetLighting.roadDesigns) || [];
    if (!zones.length && !designs.length) { UI.toast('Add a room, road or sports field first.', 'info'); return; }
    if (zones.length) await LightingWS.calcAll();
    if (designs.length) {
      if (UI.setBusy) UI.setBusy(true, 'Calculating the roads…');
      try { await RoadLight.computeAll(); } finally { if (UI.setBusy) UI.setBusy(false); }
    }
    this.render();
  },
};
