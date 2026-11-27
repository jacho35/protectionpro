/* ProtectionPro — WiFi workspace (Building): coverage, capacity, channels, cabling / PoE and links.
 *
 * The tab hosts the floor plan (PlanMarkup context 'wifi'), so access points (bd_wap), data outlets (bd_datapoint),
 * rooms and walls are the plan's own — nothing is drawn twice. The prediction is wifi-engine.js (pure, wall-aware
 * path loss); this file reads the plan into metres, caches the result per input signature, paints the heatmap into
 * the plan's foreground (`draw`, called from PlanEngine._drawFg / renderExport) and shows the results page.
 *
 * Stored in `planMarkup.settings.wifi` (no file-format change): band / width / exponent / default wall / wall materials
 * per room edge / room use + persons / rack / links / export flag. An AP's own values are its element props.
 */
const WifiWS = {
  _active: false, _built: false, view: 'plan', _sig: '', _calc: null, _img: null, _imgSig: '', _timer: null,
  USES: ['general', 'video', 'low', 'none'],

  S() {
    const st = AppState.planMarkup.settings;
    if (!st.wifi) st.wifi = {};
    const w = st.wifi, D = WifiEngine.DEFAULTS;
    // A project file is other people's data: every stored value is coerced to what the engine expects before it reaches a template.
    for (const k of ['band', 'width', 'exponent', 'defaultWall', 'density', 'devices', 'mbps', 'concurrency', 'streams']) if (w[k] == null) w[k] = D[k];
    if (!WifiEngine.BANDS[w.band]) w.band = D.band;
    if (!WifiEngine.MATERIALS[w.defaultWall]) w.defaultWall = D.defaultWall;
    for (const k of ['width', 'exponent', 'density', 'devices', 'mbps', 'concurrency', 'streams']) { const v = Number(w[k]); w[k] = isFinite(v) && v > 0 ? v : D[k]; }
    if (!WifiEngine.BANDS[w.band].widths.includes(w.width)) w.width = w.band === '2.4' ? 20 : 80;
    if (!['rssi', 'snr', 'overlap', 'capacity'].includes(w.show)) w.show = 'rssi';
    if (!Array.isArray(w.links)) w.links = [];
    for (const l of w.links) for (const k of ['dist', 'freq', 'tx', 'gainA', 'gainB', 'obstruct']) { if (l[k] === '' || l[k] == null) continue; const v = Number(l[k]); l[k] = isFinite(v) ? v : ''; }
    if (w.persons && typeof w.persons === 'object') for (const k of Object.keys(w.persons)) { const v = Number(w.persons[k]); if (!isFinite(v)) delete w.persons[k]; else w.persons[k] = v; }
    if (!w.wallMats) w.wallMats = {};
    if (!w.uses) w.uses = {};
    if (!w.persons) w.persons = {};
    if (!w.links) w.links = [];
    if (!w.show) w.show = 'rssi';
    return w;
  },
  scale() { return (typeof PlanEngine !== 'undefined' && PlanEngine.factor && PlanEngine.factor()) || null; },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  _changed() { PlanMarkup.markDirty(); PlanMarkup.snapshot && PlanMarkup.snapshot(); this._kick(); },

  // ─── Lifecycle (app.js switchWorkspace) ───
  activate() {
    this._active = true;
    this._mount();
    this.setView(this.view);
  },
  deactivate() {
    this._active = false;
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && PlanMarkup.context === 'wifi') PlanMarkup.deactivate();
  },
  hasData() { return (AppState.planMarkup.elements || []).some(e => e.type === 'bd_wap') || !!(AppState.planMarkup.settings.wifi && AppState.planMarkup.settings.wifi.links && AppState.planMarkup.settings.wifi.links.length); },
  refresh() { if (!this._active) return; this._renderBar(); if (this.view === 'results') this.renderResults(); else if (typeof PlanUI !== 'undefined') PlanUI.renderPalette(); },
  onSelection() { if (this._active && typeof PlanUI !== 'undefined') PlanUI.renderPalette(); },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('wifi-workspace'); if (!host) return;
    this._built = true;
    host.innerHTML = `<div class="wf-bar" id="wf-bar"></div>
      <div class="wf-body"><div class="wf-plan" id="wf-plan"></div><div class="wf-results" id="wf-results" hidden></div></div>`;
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => this._onChange(e));
    // The left panel is the plan's own element: its WiFi controls are routed here.
    const pal = document.getElementById('plan-palette');
    if (pal) {
      pal.addEventListener('click', (e) => { if (PlanMarkup.context === 'wifi') this._onClick(e); });
      pal.addEventListener('change', (e) => { if (PlanMarkup.context === 'wifi') this._onChange(e); });
    }
  },

  setView(v) {
    this.view = v === 'results' ? 'results' : 'plan';
    const plan = document.getElementById('wf-plan'), res = document.getElementById('wf-results');
    if (!plan || !res) return;
    plan.hidden = this.view !== 'plan'; res.hidden = this.view !== 'results';
    if (this.view === 'plan') {
      PlanMarkup.activate(plan, 'wifi');
      if (typeof PlanEngine !== 'undefined') requestAnimationFrame(() => { PlanEngine.resize(); PlanEngine.requestDraw({ all: true }); });
    } else {
      if (PlanMarkup._active && PlanMarkup.context === 'wifi') PlanMarkup.deactivate();
      this.renderResults();
    }
    this._renderBar();
  },

  // ─── Bar ───
  _renderBar() {
    const bar = document.getElementById('wf-bar'); if (!bar) return;
    const S = this.S(), E = WifiEngine, pm = AppState.planMarkup, esc = this.esc;
    const floors = (pm.floors || []).map(f => `<option value="${esc(f.id)}"${f.id === pm.activeFloorId ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
    const opt = (v, t, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${t}</option>`;
    bar.innerHTML = `
      <div class="wf-seg" role="tablist" aria-label="WiFi view">
        <button type="button" role="tab" aria-selected="${this.view === 'plan'}" data-wf="view" data-v="plan">Plan</button>
        <button type="button" role="tab" aria-selected="${this.view === 'results'}" data-wf="view" data-v="results">Results</button>
      </div>
      ${floors ? `<label class="wf-f">Floor <select id="wf-floor">${floors}</select></label>` : ''}
      <label class="wf-f">Band <select data-wf-set="band">${Object.keys(E.BANDS).map(b => opt(b, E.BANDS[b].label, S.band)).join('')}</select></label>
      <label class="wf-f">Width <select data-wf-set="width">${E.BANDS[S.band].widths.map(w => opt(w, w + ' MHz', S.width)).join('')}</select></label>
      <label class="wf-f">Show <select data-wf-set="show">${[['rssi', 'Signal strength (RSSI)'], ['snr', 'Signal-to-noise (SNR)'], ['overlap', 'Co-channel overlap'], ['capacity', 'Capacity load']].map(x => opt(x[0], x[1], S.show)).join('')}</select></label>
      <span class="wf-sp"></span>
      <button type="button" class="wf-btn" data-wf="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button type="button" class="wf-btn" data-wf="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
      <button type="button" class="wf-btn" data-wf="fit" title="Zoom to fit">Fit</button>
      <button type="button" class="wf-btn" data-wf="scale" title="Import a plan or DXF and set the scale: the signal needs metres">Underlays &amp; scale</button>
      <button type="button" class="wf-btn" data-wf="autoplace" title="Place the fewest access points that meet every room's target. Hand-placed ones are kept.">Auto-place APs</button>
      <button type="button" class="wf-btn" data-wf="autochannel">Assign channels</button>`;
  },

  _onClick(e) {
    const b = e.target.closest('[data-wf]'); if (!b) return;
    const a = b.dataset.wf, S = this.S();
    if (a === 'view') this.setView(b.dataset.v);
    else if (a === 'autoplace') this.autoPlace();
    else if (a === 'autochannel') this.assignChannels();
    else if (a === 'runs') this.drawRuns();
    else if (a === 'rack') this.setRack();
    else if (a === 'norack') { S.rack = null; this._changed(); this.refresh(); }
    else if (a === 'ap') { const el = AppState.planMarkup.elements.find(x => x.id === b.dataset.id); if (el) { PlanMarkup.selectOnly(el.id); PlanMarkup.refreshProps(); } }
    else if (a === 'csv') this.exportCsv(b.dataset.what);
    else if (a === 'print') this.printReport();
    else if (a === 'addlink') { S.links.push({ id: 'lk' + Date.now().toString(36), name: 'Link ' + (S.links.length + 1), a: '', b: '', dist: 100, freq: 5.5, tx: 23, gainA: 23, gainB: 23, obstruct: '' }); this._changed(); this.renderResults(); }
    else if (a === 'dellink') { S.links = S.links.filter(l => l.id !== b.dataset.id); this._changed(); this.renderResults(); }
    else if (a === 'stop') { PlanTools.set('select'); }
    else if (a === 'undo' || a === 'redo') PlanMarkup.runAction(a);
    else if (a === 'fit') PlanEngine.zoomFit();
    else if (a === 'scale') { window.switchWorkspace('plan'); PlanMarkup.setMode('underlays'); }
  },

  _onChange(e) {
    const t = e.target, S = this.S();
    if (t.id === 'wf-floor') { PlanMarkup.setActiveFloor(t.value); this._renderBar(); this._kick(); return; }
    const set = t.dataset.wfSet;
    if (set) {
      const num = ['width', 'exponent', 'density', 'devices', 'mbps', 'concurrency', 'streams'].includes(set);
      let v = num ? parseFloat(t.value) : t.value;
      if (num && !(v > 0)) return;
      S[set] = v;
      if (set === 'band' && !WifiEngine.BANDS[v].widths.includes(S.width)) S.width = v === '2.4' ? 20 : 80;
      this._changed(); this._renderBar(); this.refresh(); return;
    }
    if (t.dataset.wfRoom) {                                    // a room's use / persons
      const id = t.dataset.wfRoom, f = t.dataset.f;
      if (f === 'use') S.uses[id] = t.value;
      else if (f === 'persons') { if (t.value === '') delete S.persons[id]; else S.persons[id] = Math.max(0, parseFloat(t.value) || 0); }
      this._changed(); this.refresh(); return;
    }
    if (t.dataset.wfWall) { S.wallMats[t.dataset.wfWall] = t.value; this._changed(); this.refresh(); return; }
    if (t.dataset.wfRoomWalls) {                               // every wall of one room
      const r = AppState.planMarkup.rooms.find(x => x.id === t.dataset.wfRoomWalls);
      if (r) (r.points || []).forEach((_, i) => { S.wallMats[r.id + ':' + i] = t.value; });
      this._changed(); this.refresh(); return;
    }
    if (t.dataset.wfLink) {
      const l = S.links.find(x => x.id === t.dataset.wfLink); if (!l) return;
      const f = t.dataset.f, num = !['name', 'a', 'b'].includes(f);
      l[f] = num ? (t.value === '' ? '' : parseFloat(t.value)) : t.value;
      this._changed(); this.renderResults(); return;
    }
    if (t.dataset.wfFlag) { S[t.dataset.wfFlag] = t.checked; this._changed(); if (PlanEngine) PlanEngine.requestDraw({ fg: true }); }
  },

  // ─── Model: the plan in metres ───
  model() {
    const f = this.scale(), pm = AppState.planMarkup, S = this.S();
    if (!f) return { error: 'Set the plan scale first (Underlays › calibrate from two points, or import a DXF with units): lengths and signal need metres.' };
    const rooms = (pm.rooms || []).filter(r => (!r.kind || r.kind === 'room') && (r.points || []).length >= 3)
      .map(r => ({ id: r.id, name: r.name || r.id, points: r.points.map(p => [p.x * f, p.y * f]), use: S.uses[r.id] || 'general' }));
    const aps = (pm.elements || []).filter(e => e.type === 'bd_wap').map(e => {
      const p = e.props || {}, ch = parseInt(p.channel, 10);
      return { id: e.id, name: e.name || (e.props && e.props.name) || e.id, x: e.x * f, y: e.y * f, tx: +p.tx || 17, gain: p.gain != null && p.gain !== '' ? +p.gain : 4,
        channel: ch > 0 ? ch : null, fixed: ch > 0 && !p.chAuto, watts: +p.watts || 15.4, mountH: +p.mountH || 2.7, model: p.model || '' };
    });
    const dps = (pm.elements || []).filter(e => e.type === 'bd_datapoint').map(e => ({ id: e.id, name: e.name || e.id, x: e.x * f, y: e.y * f }));
    let rack = S.rack && pm.elements.find(e => e.id === S.rack) ? S.rack : null;
    const rk = rack ? pm.elements.find(e => e.id === rack) : null;
    return { f, rooms, aps, dps, rack: rk ? { id: rk.id, name: rk.name || rk.id, x: rk.x * f, y: rk.y * f } : null };
  },

  _settings() {
    const S = this.S();
    return { band: S.band, width: S.width, exponent: S.exponent, defaultWall: S.defaultWall, wallMats: S.wallMats, density: S.density, devices: S.devices, mbps: S.mbps,
      concurrency: S.concurrency, streams: S.streams, persons: S.persons };
  },

  /** The full result for the active floor, cached on the input signature. */
  calc() {
    const m = this.model();
    if (m.error) return { error: m.error };
    const s = this._settings(), E = WifiEngine;
    const sig = JSON.stringify([m.rooms, m.aps, m.dps, m.rack, s]);
    if (this._calc && this._sig === sig) return this._calc;
    const ch = E.channels(m.aps, s, E.walls(m.rooms, s.wallMats, s.defaultWall));
    const aps = m.aps.map(a => Object.assign({}, a, { channel: a.fixed ? a.channel : (ch.channels.find(c => c.id === a.id) || {}).channel }));
    const pred = E.predict(Object.assign({ rooms: m.rooms, aps }, s));
    const rooms = E.roomStats(pred, m.rooms, s);
    const cap = E.capacity(pred, m.rooms, aps, s);
    const cov = E.coverage(pred, [-67, -60]);
    let runs = null, poe = null;
    const items = [];
    if (m.rack) {
      for (const a of m.aps) items.push({ id: a.id, name: a.name, kind: 'ap', watts: a.watts, run: E.cableRun(m.rack, a, s) });
      for (const d of m.dps) items.push({ id: d.id, name: d.name, kind: 'dp', run: E.cableRun(m.rack, d, s) });
      runs = items; poe = E.poe(items, s);
    }
    this._sig = sig;
    this._calc = { m, s, aps, ch, pred, rooms, cap, cov, runs, poe, items };
    return this._calc;
  },

  _kick() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (!this._active) return;
      this._calc = null; this._sig = '';
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
      if (this.view === 'results') this.renderResults(); else if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
    }, 120);
  },
  liveKick() { this._kick(); },

  // ─── Heatmap, drawn into the plan's foreground (world px; z = zoom or export scale) ───
  _tone(v, view, c, k) {
    const E = WifiEngine;
    if (view === 'snr') { const snr = c.pred.best[k] - E.noiseFloor(c.s.width, c.s); return snr >= 35 ? [46, 158, 91] : snr >= 25 ? [141, 190, 74] : snr >= 20 ? [227, 178, 60] : snr >= 12 ? [224, 123, 57] : [201, 74, 74]; }
    if (view === 'overlap') { const n = c.pred.heard[k]; return n <= 1 ? [46, 158, 91] : n === 2 ? [227, 178, 60] : [201, 74, 74]; }
    if (view === 'capacity') { const a = c.pred.ap[k], row = a >= 0 ? c.cap[a] : null; if (!row) return [201, 74, 74]; return row.load <= 0.6 ? [46, 158, 91] : row.load <= 1 ? [227, 178, 60] : [201, 74, 74]; }
    return E.colour(v);
  },
  _image(c) {
    const S = this.S(), key = this._sig + '|' + S.show;
    if (this._img && this._imgSig === key) return this._img;
    const p = c.pred, cv = document.createElement('canvas'); cv.width = p.nx; cv.height = p.ny;
    const g = cv.getContext('2d'), im = g.createImageData(p.nx, p.ny);
    for (let k = 0; k < p.best.length; k++) {
      if (p.room[k] < 0) continue;
      const col = this._tone(p.best[k], S.show, c, k), o = k * 4;
      im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = 150;
    }
    g.putImageData(im, 0, 0);
    this._img = cv; this._imgSig = key;
    return cv;
  },
  draw(ctx, z) {
    if (!(this._active || this.exportHeat())) return;
    const c = this.calc(); if (!c || c.error || !c.pred.nx) return;
    const f = c.m.f, p = c.pred, u = 1 / z;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._image(c), p.x0 / f, p.y0 / f, p.nx * p.step / f, p.ny * p.step / f);
    // weak spots: the worst point of every room that fails its target
    ctx.font = `${11 * u}px sans-serif`; ctx.textBaseline = 'middle';
    for (const r of c.rooms) {
      if (r.pass !== false || !r.worstAt) continue;
      const x = r.worstAt[0] / f, y = r.worstAt[1] / f;
      ctx.strokeStyle = '#991b1b'; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = '#7f1d1d'; ctx.fillText(Math.round(r.worst) + ' dBm', x + 10 * u, y);
    }
    if (c.m.rack) { const x = c.m.rack.x / f, y = c.m.rack.y / f; ctx.fillStyle = '#0b5cad'; ctx.fillRect(x - 6 * u, y - 6 * u, 12 * u, 12 * u); ctx.fillStyle = '#fff'; ctx.font = `bold ${8 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('SW', x, y); }
    ctx.restore();
  },
  exportHeat() { return !!(AppState.planMarkup.settings.wifi && AppState.planMarkup.settings.wifi.exportHeat); },

  // ─── Actions ───
  autoPlace() {
    const m = this.model(); if (m.error) { UI.toast(m.error, 'warn'); return; }
    if (!m.rooms.length) { UI.toast('Draw the rooms first: the access points are placed inside them.', 'warn'); return; }
    const pm = AppState.planMarkup, s = this._settings(), keep = m.aps.filter(a => !((pm.elements.find(e => e.id === a.id) || {}).props || {}).auto);
    const r = WifiEngine.autoPlace(Object.assign({ rooms: m.rooms, existing: keep }, s, { txDbm: 17, gainDbi: 4 }));
    pm.elements = pm.elements.filter(e => !(e.type === 'bd_wap' && e.props && e.props.auto));      // earlier proposals go; hand-placed stay
    for (const a of r.aps) {
      const props = Object.assign({}, PLAN_DEFS.defaults('bd_wap'), { auto: true });
      pm.elements.push({ id: AppState.planGenId('pmel'), type: 'bd_wap', x: a.x / m.f, y: a.y / m.f, rotation: 0, name: PlanMarkup.nextName('bd_wap'), reticId: null, props });
    }
    this._changed(); this.refresh();
    UI.toast(`${r.aps.length} access point${r.aps.length === 1 ? '' : 's'} placed${r.uncovered ? `; ${r.uncovered} sample points still below target (set a room to “Not served”, or place one by hand)` : ''}.`, r.uncovered ? 'warn' : 'success');
  },
  assignChannels() {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    const pm = AppState.planMarkup, r = WifiEngine.channels(c.m.aps, c.s, WifiEngine.walls(c.m.rooms, c.s.wallMats, c.s.defaultWall));
    for (const x of r.channels) { const el = pm.elements.find(e => e.id === x.id); if (el && !(c.m.aps.find(a => a.id === x.id) || {}).fixed) { el.props = el.props || {}; el.props.channel = x.channel; el.props.chAuto = true; } }
    this._changed(); this.refresh();
    UI.toast(r.clash.length ? `${r.clash.length} neighbouring pair${r.clash.length === 1 ? '' : 's'} still share a channel: add channels (wider bands help) or reduce Tx power.` : 'Channels assigned: no neighbours share one.', r.clash.length ? 'warn' : 'success');
  },
  setRack() {
    const pm = AppState.planMarkup, id = [...PlanMarkup.selectedIds].find(i => pm.elements.some(e => e.id === i));
    if (!id) { UI.toast('Select the comms rack, riser or board on the plan first, then press this.', 'warn'); return; }
    this.S().rack = id; this._changed(); this.refresh();
  },
  /** Data-cable routes rack → each AP and data outlet, tagged auto:'wifi' so the BOQ counts the cable. */
  drawRuns() {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    if (!c.m.rack) { UI.toast('Pick the rack first (select it on the plan, then “Use selected as rack”).', 'warn'); return; }
    const pm = AppState.planMarkup, f = c.m.f, rk = pm.elements.find(e => e.id === c.m.rack.id);
    pm.routes = pm.routes.filter(r => r.auto !== 'wifi');
    for (const it of c.items) {
      const el = pm.elements.find(e => e.id === it.id); if (!el) continue;
      const mid = { x: el.x, y: rk.y };                                // run along x then y: orthogonal like cable tray
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'data_cable', fromId: rk.id, toId: el.id, points: [{ x: rk.x, y: rk.y, snappedTo: rk.id }, mid, { x: el.x, y: el.y, snappedTo: el.id }], cableType: '', curved: false, props: {}, auto: 'wifi' });
    }
    this._changed(); this.refresh(); UI.toast(`${c.items.length} data-cable routes drawn from the rack. They count in the bill of quantities.`, 'success');
  },

  // ─── Left panel (PlanUI.renderPalette, context 'wifi') ───
  panelHtml() {
    const S = this.S(), E = WifiEngine, esc = this.esc, pm = AppState.planMarkup, c = this.calc();
    const row = (kind, type, name, desc) => PlanUI._pfRow({ kind, type, name, desc, color: kind === 'room' ? PLAN_DEFS.room.stroke : (PLAN_DEFS.element(type) || {}).color });
    const opt = (v, t, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${esc(t)}</option>`;
    let body = '';
    if (c.error) body += `<div class="wf-note wf-warn">${esc(c.error)}</div>`;
    body += `<div class="wf-h">Place</div><div class="pf-tools wf-tools">${row('element', 'bd_wap', 'Access point', 'Click to place; Tx, channel and PoE are in Properties')}${row('element', 'bd_datapoint', 'Data outlet', 'A wired point: counts in the switch ports')}${row('room', 'room', 'Room', 'Click the corners; the outline is the walls')}</div>`;
    const aps = c.error ? [] : c.aps;
    body += `<div class="wf-h">Access points <span class="pf-n">${aps.length}</span></div>`;
    body += aps.length ? `<div class="wf-list">${aps.map((a, i) => { const cp = c.cap[i]; return `<button type="button" class="wf-ap${PlanMarkup.selectedIds.has(a.id) ? ' sel' : ''}" data-wf="ap" data-id="${esc(a.id)}"><b>${esc(a.name)}</b><span>ch ${a.channel == null ? '–' : a.channel} · ${cp ? Math.round(cp.clients) + ' clients' : ''}${cp && !cp.pass ? ' · <i class="wf-bad">over</i>' : ''}</span></button>`; }).join('')}</div>`
      : `<div class="wf-note">None yet. Place one, or use <b>Auto-place APs</b> above.</div>`;
    body += `<div class="wf-h">Rooms</div>`;
    const rooms = (pm.rooms || []).filter(r => (!r.kind || r.kind === 'room') && (r.points || []).length >= 3);
    body += rooms.length ? rooms.map(r => {
      const use = S.uses[r.id] || 'general', rs = c.error ? null : c.rooms.find(x => x.id === r.id);
      const walls = (r.points || []).map((p, i) => { const q = r.points[(i + 1) % r.points.length], f = this.scale(), len = f ? Math.hypot(q.x - p.x, q.y - p.y) * f : 0, key = r.id + ':' + i, cur = S.wallMats[key] || '';
        return `<label class="wf-wall">Wall ${i + 1}${f ? ` · ${len.toFixed(1)} m` : ''}<select data-wf-wall="${esc(key)}">${opt('', 'Default (' + E.MATERIALS[S.defaultWall].name + ')', cur)}${Object.keys(E.MATERIALS).map(k => opt(k, E.MATERIALS[k].name, cur)).join('')}</select></label>`; }).join('');
      return `<details class="wf-room"><summary><span class="wf-rn">${esc(r.name || r.id)}</span>${rs && rs.pass != null ? `<span class="${rs.pass ? 'wf-ok' : 'wf-bad'}">${rs.pass ? 'Pass' : 'Fail'}</span>` : ''}</summary>
        <label class="wf-wall">Use <select data-wf-room="${esc(r.id)}" data-f="use">${this.USES.map(u => opt(u, (E.DEFAULTS.uses[u] || {}).name + ((E.DEFAULTS.uses[u] || {}).rssi != null ? ` (≥ ${E.DEFAULTS.uses[u].rssi} dBm)` : ''), use)).join('')}</select></label>
        <label class="wf-wall">People (blank = from area) <input type="number" min="0" step="1" data-wf-room="${esc(r.id)}" data-f="persons" value="${esc(S.persons[r.id] != null ? S.persons[r.id] : '')}"></label>
        <label class="wf-wall">All walls <select data-wf-room-walls="${esc(r.id)}"><option value="">Set every wall…</option>${Object.keys(E.MATERIALS).map(k => opt(k, E.MATERIALS[k].name, '')).join('')}</select></label>${walls}</details>`;
    }).join('') : `<div class="wf-note">No rooms on this floor. Draw them with the Room tool: they hold the walls the signal passes through.</div>`;
    body += `<div class="wf-h">Model</div><div class="wf-form">
      <label>Walls without a material<select data-wf-set="defaultWall">${Object.keys(E.MATERIALS).map(k => opt(k, E.MATERIALS[k].name, S.defaultWall)).join('')}</select></label>
      <label>Path-loss exponent<input type="number" step="0.1" min="2" max="6" data-wf-set="exponent" value="${esc(S.exponent)}"></label>
      <label>m² per person<input type="number" step="1" min="1" data-wf-set="density" value="${esc(S.density)}"></label>
      <label>Devices per person<input type="number" step="0.5" min="0.5" data-wf-set="devices" value="${esc(S.devices)}"></label>
      <label>Mbps per active device<input type="number" step="5" min="1" data-wf-set="mbps" value="${esc(S.mbps)}"></label>
      <label>Concurrency (0–1)<input type="number" step="0.1" min="0.1" max="1" data-wf-set="concurrency" value="${esc(S.concurrency)}"></label>
      <label>Spatial streams<input type="number" step="1" min="1" max="4" data-wf-set="streams" value="${esc(S.streams)}"></label>
      <label class="wf-chk"><input type="checkbox" data-wf-flag="exportHeat"${S.exportHeat ? ' checked' : ''}> Heatmap on sheet and PNG exports</label></div>`;
    body += `<div class="wf-h">Legend · ${S.show === 'snr' ? 'SNR' : S.show === 'overlap' ? 'APs on the same channel' : S.show === 'capacity' ? 'Load of the serving AP' : 'RSSI'}</div>${this._legend()}`;
    const foot = PlanTools.active && PlanTools.active.id !== 'select' ? `<button type="button" class="pf-btn" data-wf="stop">Stop placing</button>` : '';
    return PlanUI._frame('WiFi', { body, footer: foot });
  },
  _legend() {
    const S = this.S(), sw = (col, t) => `<div class="wf-lg"><i style="background:rgb(${col.join(',')})"></i>${t}</div>`;
    if (S.show === 'snr') return sw([46, 158, 91], '≥ 35 dB') + sw([141, 190, 74], '≥ 25 dB') + sw([227, 178, 60], '≥ 20 dB') + sw([224, 123, 57], '≥ 12 dB') + sw([201, 74, 74], 'below 12 dB');
    if (S.show === 'overlap') return sw([46, 158, 91], 'one AP') + sw([227, 178, 60], 'two on the channel') + sw([201, 74, 74], 'three or more');
    if (S.show === 'capacity') return sw([46, 158, 91], 'load ≤ 60 %') + sw([227, 178, 60], '60–100 %') + sw([201, 74, 74], 'over capacity');
    return WifiEngine.STEPS.map(([t, col, n]) => sw(col, t > -200 ? `${n} ≥ ${t} dBm` : n)).join('');
  },

  // ─── Results page ───
  renderResults() {
    const host = document.getElementById('wf-results'); if (!host) return;
    const c = this.calc(), esc = this.esc, S = this.S(), E = WifiEngine;
    if (c.error) { host.innerHTML = `<div class="wf-page"><p class="wf-note wf-warn">${esc(c.error)}</p></div>`; return; }
    const pc = v => v == null ? '–' : Math.round(v * 100) + '%', d1 = v => v == null ? '–' : v.toFixed(0), m1 = v => v == null ? '–' : v.toFixed(1);
    const verdict = ok => ok == null ? '<span class="wf-na">n/a</span>' : `<span class="${ok ? 'wf-ok' : 'wf-bad'}">${ok ? 'Pass' : 'Fail'}</span>`;
    const failRooms = c.rooms.filter(r => r.pass === false), capFail = c.cap.filter(x => !x.pass), poeFail = c.poe && !c.poe.pass;
    const nm = id => (c.aps.find(a => a.id === id) || {}).name || id;
    const stat = (l, v, bad) => `<div class="wf-stat${bad ? ' bad' : ''}"><span>${l}</span><b>${v}</b></div>`;
    let h = `<div class="wf-page"><div class="wf-head"><h1>WiFi · ${esc(E.BANDS[S.band].label)}, ${esc(S.width)} MHz</h1><div class="wf-acts">
      <button type="button" class="wf-btn" data-wf="csv" data-what="aps">AP schedule CSV</button><button type="button" class="wf-btn" data-wf="csv" data-what="rooms">Compliance CSV</button><button type="button" class="wf-btn" data-wf="print">Print / save as PDF</button></div></div>
      <div class="wf-stats">${stat('Rooms passing', `${c.rooms.filter(r => r.pass).length} of ${c.rooms.filter(r => r.pass != null).length}`, failRooms.length)}${stat('Floor ≥ −67 dBm', pc(c.cov[0].pct), c.cov[0].pct < 0.95)}${stat('Capacity', capFail.length ? capFail.length + ' AP over' : 'Pass', capFail.length)}${stat('PoE and runs', c.poe ? (c.poe.pass ? 'Pass' : 'Fail') : 'No rack set', poeFail)}</div>`;
    if (!c.aps.length) h += `<p class="wf-note">No access points on this floor yet. Place them on the Plan, or use Auto-place APs.</p>`;
    h += `<h2>Compliance by room</h2><table class="wf-t"><thead><tr><th>Room</th><th>Use</th><th>Target</th><th>Worst point</th><th>SNR</th><th>Area at target</th><th>Verdict</th></tr></thead><tbody>${c.rooms.map(r => `<tr><td>${esc(r.name)}</td><td>${esc((E.DEFAULTS.uses[r.use] || {}).name || r.use)}</td><td>${r.target == null ? '–' : r.target + ' dBm'}</td><td>${r.worst == null ? '–' : d1(r.worst) + ' dBm'}</td><td>${r.snr == null ? '–' : d1(r.snr) + ' dB'}</td><td>${pc(r.pct)}</td><td>${verdict(r.pass)}</td></tr>`).join('') || '<tr><td colspan="7">No rooms.</td></tr>'}</tbody></table>`;
    h += `<h2>Capacity per access point</h2><table class="wf-t"><thead><tr><th>AP</th><th>Area served</th><th>Clients</th><th>Demand</th><th>Median SNR</th><th>Capacity</th><th>Load</th><th>Verdict</th></tr></thead><tbody>${c.cap.map(x => `<tr><td>${esc(nm(x.id))}</td><td>${Math.round(x.area)} m²</td><td>${Math.round(x.clients)}</td><td>${Math.round(x.demand)} Mbps</td><td>${x.snrMedian == null ? '–' : d1(x.snrMedian) + ' dB'}</td><td>${Math.round(x.capacity)} Mbps</td><td>${isFinite(x.load) ? pc(x.load) : '∞'}</td><td>${verdict(x.pass)}</td></tr>`).join('') || '<tr><td colspan="8">–</td></tr>'}</tbody></table>`;
    h += `<h2>Channel plan</h2><div class="wf-chips">${c.aps.map(a => `<div class="wf-chip"><span>${esc(a.name)}</span><b>Ch ${a.channel == null ? '–' : a.channel}</b></div>`).join('') || '–'}</div>`;
    h += c.ch.clash.length ? `<p class="wf-note wf-warn">${c.ch.clash.map(p => `${esc(nm(p.a))} and ${esc(nm(p.b))} hear each other at ${d1(p.rssi)} dBm on the same channel`).join('; ')}.</p>` : `<p class="wf-note">No two access points within earshot (≥ ${E.DEFAULTS.interfere} dBm) share a channel.</p>`;
    h += `<h2>Cabling and PoE</h2>`;
    if (!c.poe) h += `<p class="wf-note">Select the comms rack (or riser / board) on the plan and press <b>Use selected as rack</b> in the Plan panel; runs, ports and PoE follow.</p><button type="button" class="wf-btn" data-wf="rack">Use selected as rack</button>`;
    else {
      h += `<div class="wf-stats">${stat('Switch ports', c.poe.ports)}${stat('24-port switches', c.poe.switches)}${stat('PoE', `${m1(c.poe.watts)} of ${c.poe.budget} W`, c.poe.watts > c.poe.budget)}${stat('Longest run', `${m1(c.poe.longest)} of ${c.poe.limit} m`, c.poe.longest > c.poe.limit)}</div>
      <table class="wf-t"><thead><tr><th>Device</th><th>Type</th><th>Run to ${esc(c.m.rack.name)}</th><th>PoE</th></tr></thead><tbody>${c.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.kind === 'ap' ? 'Access point' : 'Data outlet'}</td><td class="${i.run > c.poe.limit ? 'wf-bad' : ''}">${m1(i.run)} m</td><td>${i.kind === 'ap' ? m1(i.watts) + ' W' : '–'}</td></tr>`).join('')}</tbody></table>
      <div class="wf-acts"><button type="button" class="wf-btn" data-wf="runs">Draw the cable runs on the plan</button><button type="button" class="wf-btn" data-wf="rack">Use selected as rack</button><button type="button" class="wf-btn" data-wf="norack">Clear rack</button></div>
      <p class="wf-note">Run = across and along the plan plus ${E.DEFAULTS.drop} m of drop at each end, +${Math.round((E.DEFAULTS.slack - 1) * 100)}% slack. The 90 m limit is the permanent-link rule for a twisted-pair channel. Drawn runs are data-cable routes, so the bill of quantities counts the cable and its terminations.</p>`;
    }
    h += `<h2>Point-to-point links</h2>${this._linksHtml(c)}`;
    h += `<p class="wf-note wf-foot">A prediction from typical wall losses and a log-distance model, not a site survey. Check the result on site before sign-off.</p></div>`;
    host.innerHTML = h;
  },
  _linksHtml(c) {
    const S = this.S(), esc = this.esc, pm = AppState.planMarkup, f = c.m.f;
    const aps = pm.elements.filter(e => e.type === 'bd_wap');
    const sel = (id, cur, f2) => `<select data-wf-link="${esc(id)}" data-f="${f2}"><option value="">–</option>${aps.map(a => `<option value="${esc(a.id)}"${a.id === cur ? ' selected' : ''}>${esc(a.name || a.id)}</option>`).join('')}</select>`;
    const num = (l, k, w) => `<input type="number" step="any" data-wf-link="${esc(l.id)}" data-f="${k}" value="${esc(l[k] == null ? '' : l[k])}" style="width:${w || 72}px">`;
    const rows = S.links.map(l => {
      const A = pm.elements.find(e => e.id === l.a), B = pm.elements.find(e => e.id === l.b);
      const dist = A && B && f ? Math.hypot(A.x - B.x, A.y - B.y) * f : l.dist;
      const r = WifiEngine.link({ dist: dist || 1, freqGhz: l.freq, tx: l.tx, gainA: l.gainA, gainB: l.gainB, obstruct: l.obstruct === '' || l.obstruct == null ? undefined : l.obstruct });
      return `<tr><td><input type="text" data-wf-link="${esc(l.id)}" data-f="name" value="${esc(l.name)}" style="width:110px"></td><td>${sel(l.id, l.a, 'a')}</td><td>${sel(l.id, l.b, 'b')}</td><td>${A && B ? dist.toFixed(0) + ' m' : num(l, 'dist') + ' m'}</td><td>${num(l, 'freq', 56)}</td><td>${num(l, 'tx', 56)}</td><td>${num(l, 'gainA', 56)}/${num(l, 'gainB', 56)}</td><td>${num(l, 'obstruct', 60)}</td>
        <td>${r.rx.toFixed(0)} dBm</td><td>${r.fade.toFixed(0)} dB</td><td>${Math.round(r.clear * 100)}% of ${r.f1.toFixed(1)} m</td><td>${Math.round(r.rate)} Mbps</td><td>${r.pass ? '<span class="wf-ok">Pass</span>' : '<span class="wf-bad">Fail</span>'}</td><td><button type="button" class="wf-btn" data-wf="dellink" data-id="${esc(l.id)}" aria-label="Delete link">×</button></td></tr>`;
    }).join('');
    return `<div class="wf-scroll"><table class="wf-t"><thead><tr><th>Link</th><th>From</th><th>To</th><th>Distance</th><th>GHz</th><th>Tx dBm</th><th>Gain dBi</th><th>Obstruction m</th><th>Rx</th><th>Fade</th><th>Fresnel clear</th><th>Rate</th><th>Verdict</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="14">No links. Pick two access points on this floor, or type the distance.</td></tr>'}</tbody></table></div>
      <div class="wf-acts"><button type="button" class="wf-btn" data-wf="addlink">Add a link</button></div>
      <p class="wf-note">Free-space path loss, Fresnel zone F1 = 8.656·√(d km / f GHz). Obstruction = height of the highest obstacle above the line of sight (blank = none); a link passes with a fade margin of 15 dB or more and 60 % of F1 clear.</p>`;
  },

  // ─── Export ───
  exportCsv(what) {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    let rows;
    if (what === 'rooms') rows = [['Room', 'Use', 'Target dBm', 'Worst dBm', 'SNR dB', 'Area at target %', 'Verdict']].concat(c.rooms.map(r => [r.name, r.use, r.target, r.worst == null ? '' : r.worst.toFixed(1), r.snr == null ? '' : r.snr.toFixed(1), r.pct == null ? '' : Math.round(r.pct * 100), r.pass == null ? 'n/a' : r.pass ? 'Pass' : 'Fail']));
    else rows = [['AP', 'Model', 'x m', 'y m', 'Tx dBm', 'Gain dBi', 'Channel', 'Clients', 'Demand Mbps', 'Capacity Mbps', 'PoE W', 'Run m']].concat(c.aps.map((a, i) => { const cp = c.cap[i], it = (c.items || []).find(x => x.id === a.id); return [a.name, a.model, a.x.toFixed(2), a.y.toFixed(2), a.tx, a.gain, a.channel, Math.round(cp.clients), Math.round(cp.demand), Math.round(cp.capacity), a.watts, it ? it.run.toFixed(1) : '']; }));
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `wifi-${what === 'rooms' ? 'compliance' : 'ap-schedule'}.csv`; document.body.appendChild(a); a.click(); a.remove();
  },
  /** The heatmap as a PNG data URL: the plan (rooms, walls, devices) with the signal under it. */
  heatPng(px = 1400) {
    const r = PlanEngine.exportWorldRect(0.03); if (!r) return null;
    const w = r.maxX - r.minX, cv = document.createElement('canvas'), sc = px / w;
    cv.width = px; cv.height = Math.max(1, Math.round((r.maxY - r.minY) * sc));
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    const was = this.S().exportHeat; this.S().exportHeat = true;
    try { PlanEngine.renderExport(g, r, sc); } finally { this.S().exportHeat = was; }
    return cv.toDataURL('image/png');
  },
  printReport() {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    this.renderResults();
    const img = this.heatPng(), body = document.getElementById('wf-results').innerHTML.replace(/<div class="wf-acts">.*?<\/div>/gs, '');
    const win = window.open('', '_blank'); if (!win) { UI.toast('Allow pop-ups to print the report.', 'warn'); return; }
    const css = Array.from(document.styleSheets).map(s => { try { return Array.from(s.cssRules).filter(r => /wf-/.test(r.cssText)).map(r => r.cssText).join('\n'); } catch (e) { return ''; } }).join('\n');
    win.document.write(`<!doctype html><title>WiFi report</title><style>body{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#14181f}img{max-width:100%;border:1px solid #ccc}${css}.wf-page{padding:0;max-width:none}</style><h1>${this.esc(AppState.projectName || 'Project')} · WiFi design</h1>${img ? `<img src="${img}" alt="Signal strength on the floor plan">` : ''}${body}`);
    win.document.close(); setTimeout(() => win.print(), 400);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = WifiWS;
