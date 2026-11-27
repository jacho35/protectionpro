/* ProtectionPro — CCTV workspace (Building and Reticulation): DORI coverage, blind spots, storage, cabling / PoE / fibre.
 *
 * The tab hosts the plan (PlanMarkup context 'cctv'): cameras (`bd_cctv` on a floor plan, `cam` on a site plan), the NVR /
 * control room, rooms and outdoor areas are the plan's own — nothing is drawn twice. The prediction is cctv-engine.js (pure);
 * this file reads the plan into metres, caches the result per input signature, paints the coverage into the plan's foreground
 * (`draw`, called from PlanEngine._drawFg / renderExport) and shows the results page.
 *
 * Which shapes are what:  floor plan  — rooms are both the targets (a room must reach its DORI level) and the walls that hide things;
 *                         site plan   — outdoor areas are the targets, rooms (buildings) are the obstacles.
 * Stored in `planMarkup.settings.cctv` (no file-format change). A camera's own values are its element props.
 */
const CctvWS = {
  _active: false, _built: false, view: 'plan', _sig: '', _calc: null, _img: null, _imgSig: '', _timer: null,
  LEVELS: [['identify', [11, 92, 173]], ['recognise', [62, 139, 208]], ['observe', [140, 185, 227]], ['detect', [211, 228, 245]]],

  domain() { return (AppState.planMarkup.settings && AppState.planMarkup.settings.domain) === 'retic' ? 'retic' : 'building'; },
  camType() { return this.domain() === 'retic' ? 'cam' : 'bd_cctv'; },
  hubType() { return this.domain() === 'retic' ? 'camhub' : 'bd_nvr'; },

  S() {
    const st = AppState.planMarkup.settings;
    if (!st.cctv) st.cctv = {};
    const w = st.cctv, D = CctvEngine.DEFAULTS;
    for (const k of ['targetH', 'passPct', 'fps', 'duty', 'days', 'overhead']) { const v = Number(w[k]); w[k] = isFinite(v) && v > 0 ? v : D[k]; }
    if (w.passPct > 1) w.passPct = 1;
    if (w.duty > 1) w.duty = 1;
    if (!CctvEngine.CODECS[w.codec]) w.codec = D.codec;
    if (!CctvEngine.WALLS[w.defaultWall]) w.defaultWall = D.defaultWall;
    if (!['dori', 'target', 'blind'].includes(w.show)) w.show = 'dori';
    if (w.camModel && !(typeof VENDOR_CAMERAS !== 'undefined' && VENDOR_CAMERAS.some(c => c.id === w.camModel))) w.camModel = '';
    if (!w.uses || typeof w.uses !== 'object') w.uses = {};
    if (!w.wallMats || typeof w.wallMats !== 'object') w.wallMats = {};
    if (!w.lux || typeof w.lux !== 'object') w.lux = {};
    for (const k of Object.keys(w.lux)) { const v = Number(w.lux[k]); if (!isFinite(v) || v < 0) delete w.lux[k]; else w.lux[k] = v; }
    for (const k of Object.keys(w.uses)) if (!CctvEngine.USES[w.uses[k]]) delete w.uses[k];
    if (w.wedges == null) w.wedges = true;
    return w;
  },
  /** A camera's values: its own override, else its manufacturer model's, else the generic camera. */
  camSpec(props, dom) {
    const p = props || {}, G = CctvEngine.DEFAULTS.generic, D = CctvEngine.DEFAULTS, num = v => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
    const retic = (dom || this.domain()) === 'retic';
    const lib = p.libId && typeof VENDOR_CAMERAS !== 'undefined' ? VENDOR_CAMERAS.find(c => c.id === p.libId) : null;
    let resW = lib ? lib.resW : G.resW, resH = lib ? lib.resH : G.resH;
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(String(p.res || '')); if (m) { resW = +m[1]; resH = +m[2]; }
    const hOv = num(p.hfov), hfov = hOv != null ? hOv : (lib ? lib.hfov : G.hfov);
    const kind = lib ? lib.kind : (CctvEngine.KINDS[p.kind] ? p.kind : 'dome');
    const watts = num(p.watts) != null ? num(p.watts) : (lib && lib.watts != null ? lib.watts : (kind === 'ptz' ? 25 : G.watts));
    return { lib, kind, resW, resH, hfov, vfov: hOv == null && !m && lib && lib.vfov ? lib.vfov : null,
      H: num(p.mountH) != null ? num(p.mountH) : (retic ? D.mountRetic : D.mountBuilding), tilt: num(p.tilt) != null ? num(p.tilt) : (retic ? D.tiltRetic : D.tiltBuilding),
      watts, fps: num(p.fps), codec: p.codec && CctvEngine.CODECS[p.codec] ? p.codec : null, minLux: lib && lib.minLuxColour != null ? lib.minLuxColour : null,
      label: lib ? `${lib.vendor} ${lib.model}` : 'Generic 4 MP' };
  },
  scale() { return (typeof PlanEngine !== 'undefined' && PlanEngine.factor && PlanEngine.factor()) || null; },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  _changed() { PlanMarkup.markDirty(); PlanMarkup.snapshot && PlanMarkup.snapshot(); this._kick(); },

  // ─── Lifecycle (app.js switchWorkspace) ───
  activate() { this._active = true; this._mount(); this.setView(this.view); },
  deactivate() {
    this._active = false;
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && PlanMarkup.context === 'cctv') PlanMarkup.deactivate();
  },
  hasData() { return (AppState.planMarkup.elements || []).some(e => e.type === 'bd_cctv' || e.type === 'cam'); },
  refresh() { if (!this._active) return; this._renderBar(); if (this.view === 'results') this.renderResults(); else if (typeof PlanUI !== 'undefined') PlanUI.renderPalette(); },
  onSelection() { if (this._active && typeof PlanUI !== 'undefined') PlanUI.renderPalette(); },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('cctv-workspace'); if (!host) return;
    this._built = true;
    host.innerHTML = `<div class="wf-bar" id="ct-bar"></div>
      <div class="wf-body"><div class="wf-plan" id="ct-plan"></div><div class="wf-results" id="ct-results" hidden></div></div>`;
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => this._onChange(e));
    const pal = document.getElementById('plan-palette');
    if (pal) {
      pal.addEventListener('click', (e) => { if (PlanMarkup.context === 'cctv') this._onClick(e); });
      pal.addEventListener('change', (e) => { if (PlanMarkup.context === 'cctv') this._onChange(e); });
    }
  },
  setView(v) {
    this.view = v === 'results' ? 'results' : 'plan';
    const plan = document.getElementById('ct-plan'), res = document.getElementById('ct-results');
    if (!plan || !res) return;
    plan.hidden = this.view !== 'plan'; res.hidden = this.view !== 'results';
    if (this.view === 'plan') {
      PlanMarkup.activate(plan, 'cctv');
      if (typeof PlanEngine !== 'undefined') requestAnimationFrame(() => { PlanEngine.resize(); PlanEngine.requestDraw({ all: true }); });
    } else {
      if (PlanMarkup._active && PlanMarkup.context === 'cctv') PlanMarkup.deactivate();
      this.renderResults();
    }
    this._renderBar();
  },

  // ─── Bar ───
  _renderBar() {
    const bar = document.getElementById('ct-bar'); if (!bar) return;
    const S = this.S(), pm = AppState.planMarkup, esc = this.esc;
    const floors = this.domain() === 'building' ? (pm.floors || []).map(f => `<option value="${esc(f.id)}"${f.id === pm.activeFloorId ? ' selected' : ''}>${esc(f.name)}</option>`).join('') : '';
    const opt = (v, t, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${t}</option>`;
    bar.innerHTML = `
      <div class="wf-seg" role="tablist" aria-label="CCTV view">
        <button type="button" role="tab" aria-selected="${this.view === 'plan'}" data-ct="view" data-v="plan">Plan</button>
        <button type="button" role="tab" aria-selected="${this.view === 'results'}" data-ct="view" data-v="results">Results</button>
      </div>
      ${floors ? `<label class="wf-f">Floor <select id="ct-floor">${floors}</select></label>` : ''}
      <label class="wf-f">Show <select data-ct-set="show">${[['dori', 'DORI levels (px/m)'], ['target', 'Meets the area target'], ['blind', 'Blind spots only']].map(x => opt(x[0], x[1], S.show)).join('')}</select></label>
      <span class="wf-sp"></span>
      <button type="button" class="wf-btn" data-ct="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button type="button" class="wf-btn" data-ct="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
      <button type="button" class="wf-btn" data-ct="fit" title="Zoom to fit">Fit</button>
      <button type="button" class="wf-btn" data-ct="scale" title="Import a plan or DXF and set the scale: coverage needs metres">Underlays &amp; scale</button>
      <button type="button" class="wf-btn" data-ct="autoplace" title="Place the fewest cameras that bring every area to its target. Hand-placed ones are kept.">Auto-place cameras</button>`;
  },

  _onClick(e) {
    const b = e.target.closest('[data-ct]'); if (!b) return;
    const a = b.dataset.ct, S = this.S();
    if (a === 'view') this.setView(b.dataset.v);
    else if (a === 'autoplace') this.autoPlace();
    else if (a === 'runs') this.drawRuns();
    else if (a === 'rack') this.setRack();
    else if (a === 'norack') { S.rack = null; this._changed(); this.refresh(); }
    else if (a === 'cam') { const el = AppState.planMarkup.elements.find(x => x.id === b.dataset.id); if (el) { PlanMarkup.selectOnly(el.id); PlanMarkup.refreshProps(); } }
    else if (a === 'csv') this.exportCsv(b.dataset.what);
    else if (a === 'pdf') CctvReport.export();
    else if (a === 'stop') PlanTools.set('select');
    else if (a === 'undo' || a === 'redo') PlanMarkup.runAction(a);
    else if (a === 'fit') PlanEngine.zoomFit();
    else if (a === 'scale') { window.switchWorkspace('plan'); PlanMarkup.setMode('underlays'); }
  },
  _onChange(e) {
    const t = e.target, S = this.S();
    if (t.id === 'ct-floor') { PlanMarkup.setActiveFloor(t.value); this._renderBar(); this._kick(); return; }
    const set = t.dataset.ctSet;
    if (set) {
      const num = ['targetH', 'passPct', 'fps', 'duty', 'days', 'overhead'].includes(set);
      let v = num ? parseFloat(t.value) : t.value;
      if (num && !(v > 0)) return;
      if (set === 'passPct' || set === 'duty') v = Math.min(1, v > 1 ? v / 100 : v);
      S[set] = v; this._changed(); this._renderBar(); this.refresh(); return;
    }
    if (t.dataset.ctArea) {
      const id = t.dataset.ctArea, f = t.dataset.f;
      if (f === 'use') S.uses[id] = t.value; else if (f === 'lux') { if (t.value === '') delete S.lux[id]; else S.lux[id] = Math.max(0, parseFloat(t.value) || 0); }
      this._changed(); this.refresh(); return;
    }
    if (t.dataset.ctWall) { S.wallMats[t.dataset.ctWall] = t.value; this._changed(); this.refresh(); return; }
    if (t.dataset.ctRoomWalls) {
      const r = AppState.planMarkup.rooms.find(x => x.id === t.dataset.ctRoomWalls);
      if (r) (r.points || []).forEach((_, i) => { S.wallMats[r.id + ':' + i] = t.value; });
      this._changed(); this.refresh(); return;
    }
    if (t.dataset.ctFlag) { S[t.dataset.ctFlag] = t.checked; this._changed(); if (PlanEngine) PlanEngine.requestDraw({ fg: true }); }
  },

  // ─── Model: the plan in metres ───
  _isArea(r) { return this.domain() === 'retic' ? r.kind === 'outdoor' : (!r.kind || r.kind === 'room' || r.kind === 'outdoor'); },
  _isObstacle(r) { return !r.kind || r.kind === 'room'; },
  defaultUse() { return 'observe'; },
  model() {
    const f = this.scale(), pm = AppState.planMarkup, S = this.S(), dom = this.domain();
    if (!f) return { error: 'Set the plan scale first (Underlays › calibrate from two points, or import a DXF with units): coverage needs metres.' };
    const shape = r => (r.points || []).map(p => [p.x * f, p.y * f]);
    const all = (pm.rooms || []).filter(r => (r.points || []).length >= 3);
    const areas = all.filter(r => this._isArea(r)).map(r => ({ id: r.id, name: r.name || r.id, points: shape(r), kind: r.kind === 'outdoor' ? 'outdoor' : 'room', use: S.uses[r.id] || this.defaultUse(r), ppm: CctvEngine.USES[S.uses[r.id] || this.defaultUse(r)].ppm }));
    const obstacles = all.filter(r => this._isObstacle(r)).map(r => ({ id: r.id, name: r.name || r.id, points: shape(r) }));
    const cams = (pm.elements || []).filter(e => e.type === this.camType()).map(e => {
      const sp = this.camSpec(e.props, dom);
      return { id: e.id, name: e.name || (e.props && e.props.name) || e.id, x: e.x * f, y: e.y * f, pan: +e.rotation || 0, tilt: sp.tilt, H: sp.H, hfov: sp.hfov, vfov: sp.vfov,
        resW: sp.resW, resH: sp.resH, kind: sp.kind, watts: sp.watts, fps: sp.fps || S.fps, codec: sp.codec || S.codec, minLux: sp.minLux, model: sp.label + (e.props && e.props.model ? ' ' + e.props.model : ''), lib: sp.lib };
    });
    const rk = S.rack ? pm.elements.find(e => e.id === S.rack) : null;
    return { f, dom, areas, obstacles, cams, rack: rk ? { id: rk.id, name: rk.name || rk.id, x: rk.x * f, y: rk.y * f } : null };
  },
  _settings() { const S = this.S(); return { targetH: S.targetH, passPct: S.passPct, fps: S.fps, codec: S.codec, duty: S.duty, days: S.days, overhead: S.overhead }; },
  /** Scene light of an area, lux (lowest): the project's own figure, else the Lighting module's Em × U0. */
  sceneLux(id) {
    const S = this.S(); if (S.lux[id] != null) return { lux: S.lux[id], from: 'entered' };
    try { const r = typeof RoomCalc !== 'undefined' && RoomCalc.results && RoomCalc.results[id]; const w = r && r.res && r.res.workplane;
      if (w && isFinite(w.Em)) return { lux: w.Em * (isFinite(w.U0) && w.U0 > 0 ? w.U0 : 1), from: 'lighting' }; } catch (_) { /* no lighting result */ }
    return { lux: null, from: '' };
  },

  calc() {
    const m = this.model();
    if (m.error) return { error: m.error };
    const s = this._settings(), E = CctvEngine, S = this.S();
    const sig = JSON.stringify([m.areas, m.obstacles, m.cams.map(c => [c.id, c.x, c.y, c.pan, c.tilt, c.H, c.hfov, c.vfov, c.resW, c.resH, c.fps, c.codec, c.watts]), m.rack, s, S.wallMats, S.defaultWall, S.lux]);
    if (this._calc && this._sig === sig) return this._calc;
    const segs = E.walls(m.obstacles, S.wallMats, S.defaultWall);
    const pred = E.predict(Object.assign({ areas: m.areas, cams: m.cams, segs }, s));
    const stats = E.areaStats(pred, m.areas, s).map((st, i) => {
      const a = m.areas[i], ls = this.sceneLux(a.id);
      const serving = new Set(); for (let k = 0; k < pred.room.length; k++) if (pred.room[k] === i && pred.cam[k] >= 0) serving.add(pred.cam[k]);
      const mins = [...serving].map(ix => m.cams[ix].minLux).filter(v => v != null), minLux = mins.length ? Math.max(...mins) : null;   // the least sensitive camera that serves it decides
      const light = E.lightCheck(ls.lux, minLux);
      return Object.assign(st, { use: a.use, lux: ls.lux, luxFrom: ls.from, minLux, light, serving: serving.size, verdict: st.pass == null ? null : (st.pass && light !== false) });
    });
    const cov = E.coverage(pred, m.areas);
    const checks = m.cams.map(c => Object.assign({ id: c.id }, E.camChecks(c, s)));
    const stor = E.storage(m.cams, s);
    let runs = null, poe = null; const items = [];
    if (m.rack) {
      for (const c of m.cams) items.push({ id: c.id, name: c.name, watts: c.watts, run: E.cableRun(m.rack, c, s) });
      runs = items; poe = E.poe(items, s, m.dom === 'retic');
    }
    this._sig = sig;
    this._calc = { m, s, segs, pred, stats, cov, checks, stor, runs, poe, items };
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

  // ─── Coverage, drawn into the plan's foreground (world px; z = zoom or export scale) ───
  _image(c) {
    const S = this.S(), key = this._sig + '|' + S.show;
    if (this._img && this._imgSig === key) return this._img;
    const p = c.pred, cv = document.createElement('canvas'); cv.width = p.nx; cv.height = p.ny;
    const g = cv.getContext('2d'), im = g.createImageData(p.nx, p.ny);
    for (let k = 0; k < p.best.length; k++) {
      const ai = p.room[k]; if (ai < 0) continue;
      const v = p.best[k], tg = c.m.areas[ai].ppm; let col = null, a = 150;
      if (S.show === 'target') { if (tg == null) col = [150, 156, 166]; else col = v >= tg ? [46, 158, 91] : [201, 74, 74]; }
      else if (S.show === 'blind') { if (v < 25) col = [201, 110, 40]; }
      else { const lv = this.LEVELS.find(L => v >= CctvEngine.DORI.find(d => d[0] === L[0])[2]); col = lv ? lv[1] : [201, 110, 40]; if (!lv) a = 110; }
      if (!col) continue;
      const o = k * 4; im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = a;
    }
    g.putImageData(im, 0, 0);
    this._img = cv; this._imgSig = key;
    return cv;
  },
  draw(ctx, z) {
    if (!(this._active || this.exportHeat())) return;
    const c = this.calc(); if (!c || c.error || !c.pred.nx) return;
    const f = c.m.f, p = c.pred, u = 1 / z, S = this.S();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._image(c), p.x0 / f, p.y0 / f, p.nx * p.step / f, p.ny * p.step / f);
    ctx.imageSmoothingEnabled = true;
    if (S.wedges) {                                                 // each camera's field of view out to its Observe range (capped at 40 m)
      ctx.lineWidth = 1.2 * u; ctx.strokeStyle = 'rgba(91,33,182,.85)'; ctx.setLineDash([5 * u, 4 * u]);
      for (const cm of c.m.cams) {
        const R = Math.min(40, CctvEngine.reach(cm, 62)) / f, cx = cm.x / f, cy = cm.y / f, a0 = (cm.pan - cm.hfov / 2) * Math.PI / 180, a1 = (cm.pan + cm.hfov / 2) * Math.PI / 180;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R); ctx.arc(cx, cy, R, a0, a1); ctx.lineTo(cx, cy); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.font = `${11 * u}px sans-serif`; ctx.textBaseline = 'middle';
    for (const r of c.stats) {                                      // the worst point of every area that fails its target
      if (r.verdict !== false || !r.worstAt) continue;
      const x = r.worstAt[0] / f, y = r.worstAt[1] / f;
      ctx.strokeStyle = '#991b1b'; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = '#7f1d1d'; ctx.fillText(Math.round(r.worst) + ' px/m', x + 10 * u, y);
    }
    if (c.m.rack) { const x = c.m.rack.x / f, y = c.m.rack.y / f; ctx.fillStyle = '#6d28d9'; ctx.fillRect(x - 6 * u, y - 6 * u, 12 * u, 12 * u); ctx.fillStyle = '#fff'; ctx.font = `bold ${7 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('NVR', x, y); }
    ctx.restore();
  },
  /** DORI zone outlines for the plan DXF: [{pts (plan px), closed, color, label}]. [] with no camera, no scale or the switch off. */
  dxfZones() {
    const pm = AppState.planMarkup, S = pm.settings && pm.settings.cctv;
    if (S && S.dxfZones === false) return [];
    if (!(pm.elements || []).some(e => e.type === 'bd_cctv' || e.type === 'cam')) return [];
    const c = this.calc(); if (c.error || !c.m.cams.length || !c.pred.nx) return [];
    const hex = col => '#' + col.map(v => v.toString(16).padStart(2, '0')).join(''), out = [];
    for (const [id, name, ppm] of CctvEngine.DORI) {
      const col = this.LEVELS.find(L => L[0] === id)[1];
      for (const l of WifiEngine.contours(c.pred, ppm)) out.push({ pts: l.pts.map(q => [q[0] / c.m.f, q[1] / c.m.f]), closed: l.closed, color: hex(col), label: `${name} ${ppm} px/m` });
    }
    return out;
  },
  exportHeat() { return !!(AppState.planMarkup.settings.cctv && AppState.planMarkup.settings.cctv.exportHeat); },

  // ─── Actions ───
  autoPlace() {
    const m = this.model(); if (m.error) { UI.toast(m.error, 'warn'); return; }
    if (!m.areas.some(a => a.ppm != null)) { UI.toast(m.dom === 'retic' ? 'Draw an outdoor area first (Room tool, Outdoor area): cameras are placed to cover it.' : 'Draw the rooms first: cameras are placed to cover them.', 'warn'); return; }
    const pm = AppState.planMarkup, S = this.S(), isAuto = id => ((pm.elements.find(e => e.id === id) || {}).props || {}).auto;
    const sp = this.camSpec({ libId: S.camModel }, m.dom), retic = m.dom === 'retic';
    const poles = retic ? pm.elements.filter(e => e.type === 'pole').map(e => ({ x: e.x * m.f, y: e.y * m.f })) : [];
    const spec = { resW: sp.resW, resH: sp.resH, hfov: sp.hfov, vfov: sp.vfov, H: sp.H, tilt: sp.tilt };
    const r = CctvEngine.autoPlace(Object.assign({ areas: m.areas, segs: CctvEngine.walls(m.obstacles, S.wallMats, S.defaultWall), existing: m.cams.filter(c => !isAuto(c.id)).map(c => Object.assign({}, c)), spec,
      candidates: poles.length ? poles : null, inset: retic ? 0 : 0.4, spacing: retic ? 8 : 3 }, this._settings()));
    pm.elements = pm.elements.filter(e => !(e.type === this.camType() && e.props && e.props.auto));
    for (const a of r.cams) {
      const props = Object.assign({}, PLAN_DEFS.defaults(this.camType()), { auto: true, libId: S.camModel || '', kind: sp.kind });
      pm.elements.push({ id: AppState.planGenId('pmel'), type: this.camType(), x: a.x / m.f, y: a.y / m.f, rotation: a.pan, name: PlanMarkup.nextName(this.camType()), reticId: null, props });
    }
    this._changed(); this.refresh();
    UI.toast(`${r.cams.length} camera${r.cams.length === 1 ? '' : 's'} placed${r.uncovered ? `; ${r.uncovered} of ${r.samples} sample points still below target (set an area to “Not covered”, place one by hand, or use a camera with more pixels)` : ''}.`, r.uncovered ? 'warn' : 'success');
  },
  setRack() {
    const pm = AppState.planMarkup, id = [...PlanMarkup.selectedIds].find(i => pm.elements.some(e => e.id === i));
    if (!id) { UI.toast('Select the NVR, control room or comms rack on the plan first, then press this.', 'warn'); return; }
    this.S().rack = id; this._changed(); this.refresh();
  },
  /** Cable routes recorder → each camera, tagged auto:'cctv' so the BOQ counts the cable. Site plan: a run over the copper limit is a fibre drop. */
  drawRuns() {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    if (!c.m.rack) { UI.toast('Pick the NVR / control room first (select it on the plan, then “Use selected as recorder”).', 'warn'); return; }
    const pm = AppState.planMarkup, rk = pm.elements.find(e => e.id === c.m.rack.id), fibre = new Set(c.poe ? c.poe.fibreIds : []);
    pm.routes = pm.routes.filter(r => r.auto !== 'cctv');
    for (const it of c.items) {
      const el = pm.elements.find(e => e.id === it.id); if (!el) continue;
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: fibre.has(it.id) ? 'fibreErf' : 'data_cable', fromId: rk.id, toId: el.id,
        points: [{ x: rk.x, y: rk.y, snappedTo: rk.id }, { x: el.x, y: rk.y }, { x: el.x, y: el.y, snappedTo: el.id }], cableType: '', curved: false, props: {}, auto: 'cctv' });
    }
    this._changed(); this.refresh(); UI.toast(`${c.items.length} camera cable runs drawn from the recorder. They count in the bill of quantities.`, 'success');
  },
  /** Bill-of-quantities lines for cameras on every floor. cams = camera plan elements, runs = camera runs drawn on the plan. */
  boqLines(cams, runs) {
    const S = this.S(), E = CctvEngine, dom = this.domain(), n = cams.length, out = [];
    let fibre = 0;
    if (dom === 'retic') { try { const c = this.calc(); fibre = c && c.poe ? c.poe.fibre : 0; } catch (_) { fibre = 0; } }
    const copper = Math.max(0, n - fibre);
    if (copper) out.push({ key: 'EQ-CCTV-POE-SW', desc: 'PoE switch, 24 port, for CCTV cameras', unit: 'ea', qty: Math.ceil(copper / E.DEFAULTS.switchPorts) });
    const st = E.storage(cams.map(e => { const sp = this.camSpec(e.props, dom); return { resW: sp.resW, resH: sp.resH, fps: sp.fps || S.fps, codec: sp.codec || S.codec }; }), this._settings());
    if (st.tb > 0) out.push({ key: 'EQ-CCTV-STORAGE', desc: `NVR storage, ${S.days} days`, unit: 'TB', qty: Math.round(st.tb * 100) / 100 });
    if (fibre) out.push({ key: 'EQ-CCTV-FIBRE-MC', desc: 'Fibre media converter pair with local power, pole camera', unit: 'ea', qty: fibre });
    if (runs) out.push({ key: 'EQ-CCTV-TERM', desc: 'Data cable termination, CCTV camera run (2 per run)', unit: 'ea', qty: 2 * runs });
    return out;
  },

  // ─── Left panel (PlanUI.renderPalette, context 'cctv') ───
  panelHtml() {
    const S = this.S(), E = CctvEngine, esc = this.esc, pm = AppState.planMarkup, c = this.calc(), dom = this.domain();
    const row = (kind, type, name, desc) => PlanUI._pfRow({ kind, type, name, desc, color: kind === 'room' ? PLAN_DEFS.room.stroke : (PLAN_DEFS.element(type) || {}).color });
    const opt = (v, t, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(t)}</option>`;
    let body = '';
    if (c.error) body += `<div class="wf-note wf-warn">${esc(c.error)}</div>`;
    const place = row('element', this.camType(), 'Camera', 'Click to place, rotate to aim; lens, height and tilt are in Properties') + row('element', this.hubType(), dom === 'retic' ? 'Control room / NVR' : 'NVR', 'Where the camera cables end')
      + (dom === 'retic' ? row('room', 'room', 'Building', 'Click the corners: it blocks the view') + row('room', 'outdoor', 'Outdoor area to watch', 'Street, gate, car park: needs a DORI target') : row('room', 'room', 'Room', 'Click the corners; the outline is the walls'));
    body += `<div class="wf-h">Place</div><div class="pf-tools wf-tools">${place}</div>`;
    const cams = c.error ? [] : c.m.cams;
    body += `<div class="wf-h">Cameras <span class="pf-n">${cams.length}</span></div>`;
    body += cams.length ? `<div class="wf-list">${cams.map((a, i) => { const ck = c.checks[i]; return `<button type="button" class="wf-ap${PlanMarkup.selectedIds.has(a.id) ? ' sel' : ''}" data-ct="cam" data-id="${esc(a.id)}"><b>${esc(a.name)}</b><span>${esc(E.KINDS[a.kind] || a.kind)} · ${a.H.toFixed(1)} m · ${Math.round(a.pan)}°${ck && !ck.pass ? ' · <i class="wf-bad">check</i>' : ''}</span></button>`; }).join('')}</div>`
      : `<div class="wf-note">None yet. Place one, or use <b>Auto-place cameras</b> above.</div>`;
    body += `<div class="wf-h">${dom === 'retic' ? 'Areas to watch' : 'Rooms'}</div>`;
    const areas = (pm.rooms || []).filter(r => this._isArea(r) && (r.points || []).length >= 3);
    const wallRow = r => (r.points || []).map((p, i) => { const q = r.points[(i + 1) % r.points.length], f = this.scale(), len = f ? Math.hypot(q.x - p.x, q.y - p.y) * f : 0, key = r.id + ':' + i, cur = S.wallMats[key] || '';
      return `<label class="wf-wall">Wall ${i + 1}${f ? ` · ${len.toFixed(1)} m` : ''}<select data-ct-wall="${esc(key)}">${opt('', 'Default (' + E.WALLS[S.defaultWall].name + ')', cur)}${Object.keys(E.WALLS).map(k => opt(k, E.WALLS[k].name, cur)).join('')}</select></label>`; }).join('');
    const wallsBlock = r => `<label class="wf-wall">All walls <select data-ct-room-walls="${esc(r.id)}"><option value="">Set every wall…</option>${Object.keys(E.WALLS).map(k => opt(k, E.WALLS[k].name, '')).join('')}</select></label>${wallRow(r)}`;
    body += areas.length ? areas.map(r => {
      const use = S.uses[r.id] || this.defaultUse(r), rs = c.error ? null : c.stats.find(x => x.id === r.id), ls = this.sceneLux(r.id);
      return `<details class="wf-room"><summary><span class="wf-rn">${esc(r.name || r.id)}</span>${rs && rs.verdict != null ? `<span class="${rs.verdict ? 'wf-ok' : 'wf-bad'}">${rs.verdict ? 'Pass' : 'Fail'}</span>` : ''}</summary>
        <label class="wf-wall">Target <select data-ct-area="${esc(r.id)}" data-f="use">${Object.keys(E.USES).map(u => opt(u, E.USES[u].name, use)).join('')}</select></label>
        <label class="wf-wall">Scene light, lowest lux ${ls.from === 'lighting' ? '(from Lighting)' : ''}<input type="number" min="0" step="1" data-ct-area="${esc(r.id)}" data-f="lux" value="${esc(S.lux[r.id] != null ? S.lux[r.id] : (ls.lux != null ? ls.lux.toFixed(1) : ''))}" placeholder="unknown"></label>
        ${dom === 'building' ? wallsBlock(r) : ''}</details>`;
    }).join('') : `<div class="wf-note">${dom === 'retic' ? 'No outdoor areas yet. Draw them with the Room tool set to Outdoor area.' : 'No rooms on this floor. Draw them with the Room tool: they are what the cameras must cover and what hides the view.'}</div>`;
    if (dom === 'retic') {
      const bl = (pm.rooms || []).filter(r => this._isObstacle(r) && (r.points || []).length >= 3);
      body += `<div class="wf-h">Buildings that block the view <span class="pf-n">${bl.length}</span></div>` + (bl.length ? bl.map(r => `<details class="wf-room"><summary><span class="wf-rn">${esc(r.name || r.id)}</span></summary>${wallsBlock(r)}</details>`).join('') : `<div class="wf-note">None drawn. Draw each building or wall that hides the view with the Room tool.</div>`);
    }
    const lib = (typeof VENDOR_CAMERAS !== 'undefined' ? VENDOR_CAMERAS : []);
    body += `<div class="wf-h">Model</div><div class="wf-form">
      <label>New cameras use<select data-ct-set="camModel">${opt('', 'Generic (4 MP, 100°)', S.camModel || '')}${lib.map(a => opt(a.id, `${a.vendor} ${a.model} · ${a.resW}×${a.resH}`, S.camModel || '')).join('')}</select></label>
      <label>Face height, m<input type="number" step="0.1" min="0.5" max="2.2" data-ct-set="targetH" value="${esc(S.targetH)}"></label>
      <label>Share of an area that must reach its target (0–1)<input type="number" step="0.05" min="0.5" max="1" data-ct-set="passPct" value="${esc(S.passPct)}"></label>
      <label>Walls without a type<select data-ct-set="defaultWall">${Object.keys(E.WALLS).map(k => opt(k, E.WALLS[k].name, S.defaultWall)).join('')}</select></label>
      <label>Frame rate<input type="number" step="1" min="1" max="60" data-ct-set="fps" value="${esc(S.fps)}"></label>
      <label>Codec<select data-ct-set="codec">${Object.keys(E.CODECS).map(k => opt(k, E.CODECS[k].name, S.codec)).join('')}</select></label>
      <label>Recording share (0–1)<input type="number" step="0.1" min="0.1" max="1" data-ct-set="duty" value="${esc(S.duty)}"></label>
      <label>Retention, days<input type="number" step="1" min="1" data-ct-set="days" value="${esc(S.days)}"></label>
      <label class="wf-chk"><input type="checkbox" data-ct-flag="wedges"${S.wedges ? ' checked' : ''}> Field-of-view lines on the plan</label>
      <label class="wf-chk"><input type="checkbox" data-ct-flag="dxfZones"${S.dxfZones === false ? '' : ' checked'}> DORI zones in the DXF export</label>
      <label class="wf-chk"><input type="checkbox" data-ct-flag="exportHeat"${S.exportHeat ? ' checked' : ''}> Coverage on sheet and PNG exports</label></div>`;
    body += `<div class="wf-h">Legend · ${S.show === 'target' ? 'Area target' : S.show === 'blind' ? 'Blind spots' : 'Pixels per metre'}</div>${this._legend()}`;
    const foot = PlanTools.active && PlanTools.active.id !== 'select' ? `<button type="button" class="pf-btn" data-ct="stop">Stop placing</button>` : '';
    return PlanUI._frame('CCTV', { body, footer: foot });
  },
  _legend() {
    const S = this.S(), sw = (col, t) => `<div class="wf-lg"><i style="background:rgb(${col.join(',')})"></i>${t}</div>`;
    if (S.show === 'target') return sw([46, 158, 91], 'meets the target') + sw([201, 74, 74], 'below the target') + sw([150, 156, 166], 'area has no target');
    if (S.show === 'blind') return sw([201, 110, 40], 'below Detect (25 px/m) or hidden');
    return this.LEVELS.map(([id, col]) => { const d = CctvEngine.DORI.find(x => x[0] === id); return sw(col, `${d[1]} ≥ ${d[2]}`); }).join('') + sw([201, 110, 40], 'below Detect or hidden');
  },

  // ─── Results page ───
  renderResults() {
    const host = document.getElementById('ct-results'); if (!host) return;
    const c = this.calc(), esc = this.esc, S = this.S(), E = CctvEngine;
    if (c.error) { host.innerHTML = `<div class="wf-page"><p class="wf-note wf-warn">${esc(c.error)}</p></div>`; return; }
    const pc = v => v == null ? '–' : Math.round(v * 100) + '%', d0 = v => v == null ? '–' : Math.round(v), m1 = v => v == null ? '–' : v.toFixed(1);
    const verdict = ok => ok == null ? '<span class="wf-na">n/a</span>' : `<span class="${ok ? 'wf-ok' : 'wf-bad'}">${ok ? 'Pass' : 'Fail'}</span>`;
    const fails = c.stats.filter(r => r.verdict === false), chFail = c.checks.filter(x => !x.pass), retic = c.m.dom === 'retic';
    const stat = (l, v, bad) => `<div class="wf-stat${bad ? ' bad' : ''}"><span>${l}</span><b>${v}</b></div>`;
    let h = `<div class="wf-page"><div class="wf-head"><h1>CCTV · ${esc(retic ? 'site plan' : 'floor plan')}</h1><div class="wf-acts">
      <button type="button" class="wf-btn" data-ct="csv" data-what="cams">Camera schedule CSV</button><button type="button" class="wf-btn" data-ct="csv" data-what="areas">Compliance CSV</button><button type="button" class="wf-btn wf-primary" data-ct="pdf">PDF report</button></div></div>
      <div class="wf-stats">${stat('Areas passing', `${c.stats.filter(r => r.verdict).length} of ${c.stats.filter(r => r.verdict != null).length}`, fails.length)}${stat('Detect or better', pc(c.cov.detect), c.cov.detect != null && c.cov.detect < 0.9)}${stat('Cameras to check', chFail.length || 'None', chFail.length)}${stat(`Storage, ${S.days} days`, c.stor.tb.toFixed(2) + ' TB')}${stat('Recorder link', Math.round(c.stor.total) + ' of ' + Math.round(c.stor.uplinkLimit) + ' Mbps', !c.stor.uplinkPass)}</div>`;
    if (!c.m.cams.length) h += `<p class="wf-note">No cameras on this plan yet. Place them on the Plan, or use Auto-place cameras.</p>`;
    h += `<h2>Compliance by ${retic ? 'area' : 'room'}</h2><table class="wf-t"><thead><tr><th>${retic ? 'Area' : 'Room'}</th><th>Target</th><th>Level reached</th><th>Worst point</th><th>Area at target</th><th>Blind</th><th>Scene light</th><th>Verdict</th></tr></thead><tbody>${c.stats.map(r => `<tr><td>${esc(r.name)}</td><td>${r.target == null ? 'Not covered' : esc(E.USES[r.use].name)}</td><td>${r.level ? esc(r.level) : 'None'}</td><td>${r.worst == null ? '–' : d0(r.worst) + ' px/m'}</td><td>${pc(r.pct)}</td><td>${pc(r.blind)}</td><td>${r.lux == null ? 'unknown' : m1(r.lux) + ' lx'}${r.minLux != null ? ` / camera ${r.minLux} lx` : ''}${r.light === false ? ' <span class="wf-bad">too dark</span>' : ''}</td><td>${verdict(r.verdict)}</td></tr>`).join('') || `<tr><td colspan="8">No ${retic ? 'outdoor areas' : 'rooms'}.</td></tr>`}</tbody></table>`;
    h += `<h2>Camera schedule</h2><table class="wf-t"><thead><tr><th>Camera</th><th>Model</th><th>Type</th><th>Resolution</th><th>FOV</th><th>Mount / tilt</th><th>Identify / Recognise / Observe</th><th>Bitrate</th><th>PoE</th></tr></thead><tbody>${c.m.cams.map((a, i) => `<tr><td>${esc(a.name)}</td><td>${esc(a.model)}</td><td>${esc(E.KINDS[a.kind] || a.kind)}</td><td>${a.resW}×${a.resH}</td><td>${m1(a.hfov)}°</td><td>${m1(a.H)} m / ${d0(a.tilt)}°</td><td>${m1(c.checks[i].ranges.identify)} / ${m1(c.checks[i].ranges.recognise)} / ${m1(c.checks[i].ranges.observe)} m</td><td>${m1(c.stor.per[i])} Mbps</td><td>${m1(a.watts)} W</td></tr>`).join('') || '<tr><td colspan="9">–</td></tr>'}</tbody></table>`;
    const notes = c.checks.map((ck, i) => ck.notes.map(n => `<li><b>${esc(c.m.cams[i].name)}</b>: ${esc(n)}</li>`).join('')).join('');
    h += `<h2>Mounting height and tilt</h2>${notes ? `<ul class="wf-notes wf-warn">${notes}</ul>` : `<p class="wf-note">Every camera is out of reach (≥ ${E.DEFAULTS.reachH} m) and looks down no steeper than ${E.DEFAULTS.maxDepression}° at its Identify range.</p>`}`;
    h += `<h2>Storage and bandwidth</h2><div class="wf-stats">${stat('Cameras', c.m.cams.length)}${stat('Total bitrate', c.stor.total.toFixed(1) + ' Mbps')}${stat(`Storage, ${S.days} days`, c.stor.tb.toFixed(2) + ' TB')}${stat('Per day', c.stor.gbDay.reduce((a, b) => a + b, 0).toFixed(0) + ' GB')}</div>
      <p class="wf-note">Bitrate = megapixels × frame rate × ${esc(E.CODECS[S.codec].name)} factor (${E.CODECS[S.codec].f} Mbps per megapixel per frame per second); recording ${Math.round(S.duty * 100)} % of the time, plus ${Math.round((S.overhead - 1) * 100)} % for overhead and RAID. Planning figures: use the camera's own bitrate where it is known.</p>`;
    h += `<h2>Cabling, PoE${retic ? ' and fibre' : ''}</h2>`;
    if (!c.poe) h += `<p class="wf-note">Select the ${retic ? 'control room' : 'NVR or comms rack'} on the plan and press <b>Use selected as recorder</b>; runs, ports and PoE follow.</p><button type="button" class="wf-btn" data-ct="rack">Use selected as recorder</button>`;
    else {
      h += `<div class="wf-stats">${stat('Switch ports', c.poe.ports)}${stat('24-port PoE switches', c.poe.switches)}${stat('PoE', `${m1(c.poe.watts)} of ${c.poe.budget} W`, c.poe.watts > c.poe.budget)}${stat('Longest copper run', `${m1(c.poe.longest)} of ${c.poe.limit} m`, c.poe.longest > c.poe.limit)}${retic ? stat('Fibre drops', `${c.poe.fibre} · ${Math.round(c.poe.fibreM)} m`) : ''}</div>
      <table class="wf-t"><thead><tr><th>Camera</th><th>Run to ${esc(c.m.rack.name)}</th><th>Medium</th><th>PoE</th></tr></thead><tbody>${c.items.map(i => { const fb = c.poe.fibreIds.includes(i.id); return `<tr><td>${esc(i.name)}</td><td class="${!fb && i.run > c.poe.limit ? 'wf-bad' : ''}">${m1(i.run)} m</td><td>${fb ? 'Fibre + local power' : 'Cat6A, PoE'}</td><td>${fb ? '–' : m1(i.watts) + ' W'}</td></tr>`; }).join('')}</tbody></table>
      <div class="wf-acts"><button type="button" class="wf-btn" data-ct="runs">Draw the cable runs on the plan</button><button type="button" class="wf-btn" data-ct="rack">Use selected as recorder</button><button type="button" class="wf-btn" data-ct="norack">Clear recorder</button></div>
      <p class="wf-note">Run = across and along the plan plus ${E.DEFAULTS.drop} m of drop at each end, +${Math.round((E.DEFAULTS.slack - 1) * 100)}% slack. The ${E.DEFAULTS.runLimit} m limit is the permanent-link rule for a twisted-pair channel${retic ? '; a longer run goes on fibre with a media converter and power at the pole' : ', so a longer run fails: add a switch nearer to it'}.</p>`;
    }
    let boq = []; try { boq = this.boqLines((AppState.planMarkup.elements || []).filter(e => e.type === this.camType()), (AppState.planMarkup.routes || []).filter(r => r.auto === 'cctv').length); } catch (_) { boq = []; }
    h += `<h2>Bill of quantities</h2><p class="wf-note">These lines go into the bill of quantities with the plan: each camera by type, the cable runs you drew, and</p><table class="wf-t"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th></tr></thead><tbody>${boq.map(l => `<tr><td>${esc(l.desc)}</td><td>${l.qty}</td><td>${esc(l.unit)}</td></tr>`).join('') || '<tr><td colspan="3">No cameras.</td></tr>'}</tbody></table>`;
    h += `<p class="wf-note wf-foot">A prediction from the lens, sensor and mounting data and the walls drawn on the plan, not a site test. Check it with test images on site before sign-off.</p></div>`;
    host.innerHTML = h;
  },

  // ─── Export ───
  exportCsv(what) {
    const c = this.calc(); if (c.error) { UI.toast(c.error, 'warn'); return; }
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    let rows;
    if (what === 'areas') rows = [['Area', 'Target px/m', 'Level reached', 'Worst px/m', 'Area at target %', 'Blind %', 'Scene light lx', 'Verdict']].concat(c.stats.map(r => [r.name, r.target == null ? '' : r.target, r.level || '', r.worst == null ? '' : Math.round(r.worst), r.pct == null ? '' : Math.round(r.pct * 100), r.blind == null ? '' : Math.round(r.blind * 100), r.lux == null ? '' : r.lux.toFixed(1), r.verdict == null ? 'n/a' : r.verdict ? 'Pass' : 'Fail']));
    else rows = [['Camera', 'Model', 'Type', 'x m', 'y m', 'Pan deg', 'Mount m', 'Tilt deg', 'HFOV deg', 'Width px', 'Height px', 'Identify m', 'Recognise m', 'Observe m', 'Mbps', 'PoE W', 'Run m']].concat(c.m.cams.map((a, i) => { const it = (c.items || []).find(x => x.id === a.id), r = c.checks[i].ranges; return [a.name, a.model, a.kind, a.x.toFixed(2), a.y.toFixed(2), Math.round(a.pan), a.H, a.tilt, a.hfov, a.resW, a.resH, r.identify.toFixed(1), r.recognise.toFixed(1), r.observe.toFixed(1), c.stor.per[i].toFixed(2), a.watts, it ? it.run.toFixed(1) : '']; }));
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cctv-${what === 'areas' ? 'compliance' : 'camera-schedule'}.csv`; document.body.appendChild(a); a.click(); a.remove();
  },
  /** The coverage as an image data URL: the plan with the DORI zones under it. */
  heatPng(px = 1400, jpeg) {
    const r = PlanEngine.exportWorldRect(0.03); if (!r) return null;
    const w = r.maxX - r.minX, cv = document.createElement('canvas'), sc = px / w;
    cv.width = px; cv.height = Math.max(1, Math.round((r.maxY - r.minY) * sc));
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    const was = this.S().exportHeat; this.S().exportHeat = true;
    try { PlanEngine.renderExport(g, r, sc); } finally { this.S().exportHeat = was; }
    return jpeg ? cv.toDataURL('image/jpeg', 0.85) : cv.toDataURL('image/png');
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CctvWS;
