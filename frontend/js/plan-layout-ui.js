/* ProtectionPro — Plan Markup › Detect group › Auto layout.
 *
 * The plan glue for plan-layout.js: reads the erf boundaries (stored by Detect erven) and the
 * street centrelines (route type "street"), runs the layout in metres, previews it on the plan
 * and, on Create, writes real plan items: kiosks, a mini-sub, manholes, the erf markers (the
 * erf points move to their corner), service / LV / MV / fibre routes and one crossing per
 * duct (so the BOQ counts sleeves). Everything it creates is tagged `auto: 'layout'` and is
 * replaced by the next Create; anything you drew yourself is left alone.
 *
 * Settings live in AppState.planMarkup.settings.layout and are saved with the project.
 */

const PlanLayoutUI = {
  result: null, f: null, stale: true, mode: 'front', hoverT: null, ms: 0, err: '',
  PAL: ['#2a7de1', '#d9480f', '#2b9348', '#9c36b5', '#b07800', '#0c8599', '#c2255c', '#5f3dc4'],
  SHOW: { front: true, mark: true, kiosk: true, fibre: true, lvmv: true, cross: true, trench: true },
  // trench settings: depth per cable class (m) and what shares a trench; kept apart from the layout rules (no re-solve)
  TREN: [['depth.mv', 'range', 0.6, 2, 0.05, 'm', 'MV cable depth'], ['depth.lv', 'range', 0.4, 1.5, 0.05, 'm', 'LV, service and street-light depth'], ['depth.fi', 'range', 0.3, 1.2, 0.05, 'm', 'Fibre depth'],
    ['combOn', 'check', 'Set a depth for the combined (MV with LV) trench; otherwise the deepest of its cables'], ['depth.comb', 'range', 0.6, 2, 0.05, 'm', 'Combined trench depth'],
    ['combine', 'select', [['separate', 'MV in its own trench, LV / service / street light in another'], ['mvlv', 'MV, LV, service and street light in one trench where they run together']], 'Sharing'],
    ['fibre', 'select', [['own', 'fibre in its own trench'], ['with', 'fibre in the LV trench where they run together'], ['off', 'no fibre trench']], 'Fibre'],
    ['crossings', 'check', 'A shared trench across the road at every crossing']],
  CTRL: [
    ['Marker', [['side', 'range', 3, 5, 0.5, 'm', 'From the side boundary'], ['depth', 'range', 3, 5, 0.5, 'm', 'In from the front'],
      ['corner', 'select', [['start', 'start of the street'], ['end', 'far end of the street'], ['kiosk', 'nearest its kiosk']], 'Front corner'],
      ['front', 'select', [['longest', 'longest street edge'], ['shortest', 'shortest street edge']], 'A corner erf fronts its']]],
    ['Kiosks', [['kmode', 'select', [['rules', 'even runs (rule of thumb)'], ['opt', 'optimiser: fewest crossings, then kiosks, then cable']], 'Placement'],
      ['n', 'range', 4, 8, 1, '', 'Max houses per kiosk'], ['maxc', 'range', 30, 150, 5, 'm', 'Max service cable'], ['worth', 'range', 50, 600, 25, 'm', 'One kiosk is worth (cable)']]],
    ['Fibre', [['m', 'range', 4, 12, 1, '', 'Erven per manhole'], ['maxmh', 'range', 40, 200, 10, 'm', 'Max distance between manholes'],
      ['fibre', 'select', [['opp', 'civil side, opposite the kiosks'], ['same', 'same side as the kiosks']], 'Manholes default to the'],
      ['topo', 'select', [['ring', 'every street, closed loops'], ['spur', 'spurs with T-offs from the entry']], 'Main duct layout']]],
    ['Crossings', [['share', 'check', 'Share road crossings between services, fibre, LV and MV'],
      ['xmode', 'select', [['bound', 'on any erf boundary'], ['kiosk', 'only at kiosk stations']], 'Crossings may be put'],
      ['junct', 'check', 'Lay ducts across every road at all junctions, even with no cables'],
      ['j110', 'range', 0, 4, 1, '', '110 mm ducts at an empty junction'], ['j160', 'range', 0, 2, 1, '', '160 mm ducts at an empty junction'],
      ['spare', 'range', 0, 3, 1, '', 'Spare 110 mm ducts per crossing']]],
  ],

  // ───────── settings (saved in the project, so never trusted) ─────────
  cfg() {
    const s = AppState.planMarkup.settings;
    const L = (s.layout && typeof s.layout === 'object') ? s.layout : (s.layout = {});
    const D = PlanLayout.DEFAULTS, p = L.params = (L.params && typeof L.params === 'object') ? L.params : {};
    for (const [, rows] of this.CTRL) for (const r of rows) {
      const k = r[0], v = p[k];
      if (r[1] === 'range') { const n = parseFloat(v); p[k] = Number.isFinite(n) ? Math.max(r[2], Math.min(r[3], n)) : D[k]; }
      else if (r[1] === 'check') p[k] = typeof v === 'boolean' ? v : D[k];
      else p[k] = r[2].some(o => o[0] === v) ? v : D[k];
    }
    const T = L.trench = (L.trench && typeof L.trench === 'object') ? L.trench : {};
    const D2 = PlanLayout.TRENCH_DEFAULTS, dd = T.depth = (T.depth && typeof T.depth === 'object') ? T.depth : {};
    for (const k of ['mv', 'lv', 'fi']) { const n = parseFloat(dd[k]); dd[k] = Number.isFinite(n) ? Math.max(0.3, Math.min(3, n)) : D2.depth[k]; }
    { const n = parseFloat(dd.comb); dd.comb = Number.isFinite(n) ? Math.max(0.3, Math.min(3, n)) : null; }
    T.combine = ['separate', 'mvlv'].includes(T.combine) ? T.combine : D2.combine;
    T.fibre = ['own', 'with', 'off'].includes(T.fibre) ? T.fibre : D2.fibre;
    T.crossings = typeof T.crossings === 'boolean' ? T.crossings : D2.crossings;
    const vd = L.vd = (L.vd && typeof L.vd === 'object') ? L.vd : {}, VD = PlanLayout.VD_DEFAULTS;
    vd.maxPct = this._num(vd.maxPct, 1, 20, VD.maxPct);
    vd.admd = this._num(vd.admd, 0.5, 30, (typeof Retic !== 'undefined' && Retic.settings && Retic.settings.admd > 0) ? Retic.settings.admd : VD.admd);
    vd.lv = typeof vd.lv === 'string' ? vd.lv.slice(0, 80) : ''; vd.svc = typeof vd.svc === 'string' ? vd.svc.slice(0, 80) : '';
    L.sides = (L.sides && typeof L.sides === 'object') ? L.sides : {};
    L.fronts = (L.fronts && typeof L.fronts === 'object') ? L.fronts : {};
    L.cuts = Array.isArray(L.cuts) ? L.cuts.filter(x => typeof x === 'string').slice(0, 500) : [];
    return L;
  },
  _num(v, lo, hi, d) { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; },

  // a street route as points (a curved one is sampled the way the plan draws it)
  _flat(r) {
    const pts = r.points.map(p => ({ x: p.x, y: p.y }));
    if (!r.curved || pts.length < 3) return pts;
    const out = [], P = [pts[0], ...pts, pts[pts.length - 1]];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      for (let k = 0; k < 12; k++) { const t = k / 12, t2 = t * t, t3 = t2 * t; out.push({ x: .5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3), y: .5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3) }); }
    }
    out.push(pts[pts.length - 1]);
    return out;
  },
  // ── voltage drop ──
  // The cables the check uses: the picked ones, else a 95 mm² LV feeder and a 16 mm² 2-core service.
  vdCables() {
    const vd = this.cfg().vd, all = (typeof CableLib !== 'undefined') ? CableLib.all() : [];
    const g = (typeof CableLib !== 'undefined') ? CableLib.reticGroups() : [];
    const feeders = all.filter(c => g[0] && g[0].test(c)), services = all.filter(c => g[1] && g[1].test(c));
    const pick = (list, id, prefer) => list.find(c => c.id === id) || list.find(prefer) || list[0] || null;
    return { feeders, services,
      lv: pick(feeders, vd.lv, c => c.id === 'al_xlpe_95_lv' || (c.size_mm2 === 95 && c.conductor === 'Al')),
      svc: pick(services, vd.svc, c => c.size_mm2 === 16 && c.conductor === 'Cu') };
  },
  _vdCableName(type) { if (type !== 'lv' && type !== 'service') return ''; const c = this.vdCables(); const x = type === 'lv' ? c.lv : c.svc; return x ? x.name : ''; },
  vdCalc() {
    const r = this.result; if (!r) return;
    const c = this.vdCables(), vd = this.cfg().vd;
    r.vd = PlanLayout.voltDrop(r, { maxPct: vd.maxPct, admd: vd.admd, lv: c.lv && { r: c.lv.r_per_km, x: c.lv.x_per_km, name: c.lv.name }, svc: c.svc && { r: c.svc.r_per_km, x: c.svc.x_per_km, name: c.svc.name } });
  },
  // a voltage-drop setting changed: only the check is worked out again
  revd() { if (!this.result) return; this.vdCalc(); this.flag = null; PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },

  // ── streets from a drawing layer ──
  // DXF layers that hold lines or polylines, as { d, layer, n, guess } (guess = looks like street centrelines).
  dxfLayers() {
    if (typeof PlanDxfImport === 'undefined') return [];
    const out = [];
    for (const d of PlanDxfImport.list()) {
      const data = d.hidden ? null : PlanDxfImport.dataOf(d); if (!data) continue;
      const n = new Map();
      for (const r of (data.entities || [])) if ((r.t === 'p' && r.g !== 'HATCH') || r.t === 'l') n.set(r.l, (n.get(r.l) || 0) + 1);
      for (const [layer, c] of n) out.push({ d, layer, n: c, guess: /street|road|centre|center|strat|pad/i.test(layer) && !/name|text|label|kerb|curb/i.test(layer) });
    }
    return out.sort((a, b) => (b.guess - a.guess) || (b.n - a.n));
  },

  // Every polyline of the layer becomes a Street centreline (the drawn vertices, so curves stay curves),
  // named from the nearest text. Returns how many were made.
  streetsFromLayer(descId, layer) {
    const d = PlanDxfImport.byId(descId), data = d && PlanDxfImport.dataOf(d), pm = AppState.planMarkup, f = PlanEngine.factor();
    if (!data || !f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return 0; }
    const lines = [], polys = [];
    const [bx0, by0, bx1, by1] = data.bbox || [0, 0, 1, 1];
    const eps = Math.max(bx1 - bx0, by1 - by0, 1e-9) * 1e-6;
    for (const r of (data.entities || [])) {
      if (r.l !== layer) continue;
      if (r.t === 'l') lines.push(r);
      else if (r.t === 'p' && r.g !== 'HATCH') { const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]); if (pts.length > 1) polys.push(pts); }
    }
    if (lines.length && typeof PlanDxfManager !== 'undefined') for (const ch of PlanDxfManager._chainLines(lines, eps)) if (ch.pts.length > 1) polys.push(ch.pts);
    if (!polys.length) { UI.toast(`Layer "${layer}" has no lines or polylines.`, 'warn', 4000); return 0; }
    const W = ([x, y]) => PlanDxfImport.worldOf(d, x, y);
    // texts that read as a name: letters, not just a number; the ones on a "name" layer first
    const texts = (data.entities || []).filter(r => r.t === 'x' && /[A-Za-z]{3,}/.test(String(r.s || '')))
      .map(r => ({ s: String(r.s).replace(/\s+/g, ' ').trim(), w: W(r.p), pri: /name|street|road/i.test(r.l) ? 0 : 1 }));
    const dist = (pt, pl) => { let best = Infinity; for (let i = 0; i + 1 < pl.length; i++) { const a = pl[i], b = pl[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2)) : 0; best = Math.min(best, Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy)); } return best; };
    const used = new Set(); let made = 0;
    PlanMarkup.snapshot();
    polys.forEach((pts, i) => {
      const wp = pts.map(W);
      let best = null, bd = 25 / f;                       // a name within 25 m of the line
      for (const t of texts) { if (used.has(t)) continue; const dd = dist(t.w, wp) + t.pri * 1e-6; if (dd < bd) { bd = dd; best = t; } }
      if (best) used.add(best);
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: wp, cableType: '', curved: false,
        props: { name: best ? best.s : 'Street ' + (pm.routes.filter(r => r.type === 'street').length + 1), width: 12 } });
      made++;
    });
    PlanMarkup.markDirty(); this.touched();
    UI.toast(`${made} street${made === 1 ? '' : 's'} taken from layer "${layer}"${used.size < made ? ` (${made - used.size} without a name nearby: check them)` : ''}. Width 12 m; change it in each street's properties.`, used.size < made ? 'warn' : 'success', 6000);
    return made;
  },

  streetsOnPlan() { return AppState.planMarkup.routes.filter(r => r.type === 'street' && r.points && r.points.length >= 2); },

  gather() {
    const pm = AppState.planMarkup, f = PlanEngine.factor(), L = this.cfg();
    if (!f) return { err: 'Calibrate the plan first: the layout works in metres.' };
    const erven = pm.elements.filter(e => e.type === 'erf' && Array.isArray(e.boundary) && e.boundary.length >= 3)
      .map(e => ({ id: e.id, poly: e.boundary.map(p => [p.x * f, p.y * f]) }));
    const sr = this.streetsOnPlan();
    if (!sr.length) return { err: 'Draw the streets first: pick Street centreline in the Routes group and click along each street.' };
    if (!erven.length) return { err: 'No erf has a boundary yet. Run Detect erven first (it keeps each erf\'s boundary).' };
    const streets = sr.map((r, i) => ({ id: r.id, name: (r.props && r.props.name) || ('Street ' + (i + 1)), w: this._num(r.props && r.props.width, 6, 40, 12), pts: this._flat(r).map(p => [p.x * f, p.y * f]) }));
    const ks = {}, fs = {}; streets.forEach(s => { const sd = L.sides[s.id] || {}; ks[s.id] = sd.k === 1 || sd.k === -1 ? sd.k : 0; fs[s.id] = sd.f === 1 || sd.f === -1 ? sd.f : null; });
    const own = e => e.auto !== 'layout';
    const ms = pm.elements.find(e => e.type === 'minisub' && own(e)), rmu = pm.elements.find(e => e.type === 'rmu' && own(e));
    const subPt = L.sub ? [L.sub.x * f, L.sub.y * f] : ms ? [ms.x * f, ms.y * f] : null;
    return { f, input: { erven, streets, ks, fs, overrides: L.fronts, cuts: L.cuts, subPt, mvPt: rmu ? [rmu.x * f, rmu.y * f] : null, entryPt: L.entry ? [L.entry.x * f, L.entry.y * f] : null }, params: L.params };
  },

  run() {
    const g = this.gather();
    if (g.err) { this.err = g.err; this.result = null; PlanMarkup.refreshProps(); UI.toast(g.err, 'warn', 6000); return; }
    this.err = '';
    const t0 = performance.now();
    this.result = PlanLayout.solve(g.input, g.params);
    this.f = g.f; this.ms = performance.now() - t0; this.stale = false; this.flag = null;
    this.result.trench = PlanLayout.trenches(this.result, this.cfg().trench);
    this.vdCalc();
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // trench depth / sharing changed: only the trenches are worked out again
  retrench() {
    if (!this.result) return;
    this.result.trench = PlanLayout.trenches(this.result, this.cfg().trench);
    PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // after a setting changes: re-run at once when that is quick, otherwise wait for Run
  touched() {
    PlanMarkup.markDirty();
    if (this.result && this.ms < 400) this.run();
    else { this.stale = true; PlanMarkup.refreshProps(); }
  },

  // ───────── create the plan items ─────────
  commit() {
    const r = this.result, f = this.f; if (!r) return;
    const pm = AppState.planMarkup, opt = this._opt;
    const removeIf = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) arr.splice(i, 1); };
    const auto = x => x.auto === 'layout';
    const ptsPx = a => a.map(p => ({ x: p[0] / f, y: p[1] / f }));
    removeIf(pm.routes, auto); removeIf(pm.crossings, auto); removeIf(pm.elements, auto); removeIf(pm.trenches, auto);
    const el = (type, x, y, extra) => { const e = Object.assign({ id: AppState.planGenId('pmel'), type, x: x / f, y: y / f, rotation: 0, name: PlanMarkup.nextName(type), reticId: null, props: PLAN_DEFS.defaults(type), auto: 'layout' }, extra || {}); pm.elements.push(e); return e; };
    const route = (type, fromId, toId, pts) => { const rt = { id: AppState.planGenId('pmrt'), type, fromId: fromId || null, toId: toId || null, points: ptsPx(pts), cableType: this._vdCableName(type) || PLAN_DEFS.defaults(type).cableType || ((typeof PlanSync !== 'undefined' && PlanSync.defaultCableFor(type, fromId, toId)) || ''), curved: false, props: {}, auto: 'layout' }; pm.routes.push(rt); return rt; };
    const made = { kiosks: 0, manholes: 0, routes: 0, crossings: 0, markers: 0, trenches: 0 };
    const erfEl = new Map(pm.elements.filter(e => e.type === 'erf').map(e => [e.id, e]));
    // erf markers: the erf point moves to its corner
    if (opt.markers) r.erven.forEach(e => { const el0 = erfEl.get(e.id); if (el0 && e.marker) { el0.x = e.marker[0] / f; el0.y = e.marker[1] / f; made.markers++; } });
    const kEl = new Map();
    if (opt.kiosks) r.kiosks.forEach(k => { kEl.set(k, el('kiosk', k.x, k.y)); made.kiosks++; });
    if (opt.kiosks) r.erven.forEach(e => { if (e.kiosk && e.route && kEl.get(e.kiosk) && erfEl.get(e.id)) { const pts = e.route.slice(); if (!opt.markers) pts.push([erfEl.get(e.id).x * f, erfEl.get(e.id).y * f]); route('service', kEl.get(e.kiosk).id, e.id, pts); made.routes++; } });
    let subEl = null;
    if (opt.lv && r.net.sub && kEl.get(r.net.sub)) {
      const existing = pm.elements.find(e => e.type === 'minisub' && !auto(e));
      const k0 = r.net.sub, st = k0.road, sp = PlanLayout.ptAt(st, k0.s + 5, (r.ks[st.id] || 1) * st.vk);
      subEl = existing || el('minisub', sp[0], sp[1]);
      route('lv', subEl.id, kEl.get(k0).id, [[subEl.x * f, subEl.y * f], [k0.x, k0.y]]); made.routes++;
      r.net.lvLinks.forEach(l => { if (kEl.get(l.from) && kEl.get(l.to)) { route('lv', kEl.get(l.from).id, kEl.get(l.to).id, l.pts); made.routes++; } });
    }
    if (opt.mv && r.net.mvLine && r.net.mvLine.length > 1 && subEl) { route('mv', null, subEl.id, r.net.mvLine); made.routes++; }
    if (opt.fibre) {
      const mEl = new Map();
      [...r.fibre.inter, ...r.fibre.mhs].forEach(m => { mEl.set(m, el('manhole', m.x, m.y)); made.manholes++; });
      r.fibre.trunks.forEach(t => { route('fibreBB', mEl.get(t.a).id, mEl.get(t.b).id, t.pts); made.routes++; });
      r.erven.forEach(e => { if (e.duct && e.mh && mEl.get(e.mh) && erfEl.get(e.id)) { const pts = e.duct.slice(); if (!opt.markers) pts.push([erfEl.get(e.id).x * f, erfEl.get(e.id).y * f]); route('fibreErf', mEl.get(e.mh).id, e.id, pts); made.routes++; } });
    }
    if (opt.cross) r.net.cross.forEach((x, xi) => {
      const uses = [], push = (n, w) => { for (let i = 0; i < n; i++) uses.push(w); };
      if (x.prov) { push(x.d110, 'junction'); } else { push(x.d110s, 'service'); push(x.d110f, 'fibre'); push(x.d110l, 'LV'); push(x.spare, 'spare'); }
      const sizes = uses.map(u => ['110', u]); for (let i = 0; i < x.d160; i++) sizes.push(['160', x.prov ? 'junction' : 'MV']);
      sizes.forEach(([size, use], i) => {
        const off = (i - (sizes.length - 1) / 2) * 0.6, a = PlanLayout.ptAt(x.st, x.s + off, x.st.w / 2), b = PlanLayout.ptAt(x.st, x.s + off, -x.st.w / 2);
        pm.crossings.push({ id: AppState.planGenId('pmcr'), name: PlanMarkup.nextCounter('_crossing', 'RC'), size, use, trench: 'X' + (xi + 1), p1: { x: a[0] / f, y: a[1] / f }, p2: { x: b[0] / f, y: b[1] / f }, auto: 'layout' }); made.crossings++;
      });
    });
    if (opt.trench && r.trench) r.trench.list.forEach(t => {
      pm.trenches.push({ id: AppState.planGenId('pmtr'), name: PlanMarkup.nextCounter('_trench', 'T'), excType: t.type, points: ptsPx(t.pts), widthOverride: null, depthOverride: t.depth, auto: 'layout' }); made.trenches++;
    });
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
    const st = AppState.planMarkup.settings;
    const crowded = made.routes > 40 && (!st.routeLabels || st.routeLabels === 'all');
    if (crowded) st.routeLabels = 'selected';
    UI.toast(`Created ${made.kiosks} kiosk(s), ${made.manholes} manhole(s), ${made.routes} route(s), ${made.crossings} crossing duct(s) and ${made.trenches} trench(es); moved ${made.markers} erf marker(s).${crowded ? ' Route length labels now show for the selected route only (Layers › Route length labels).' : ''}`, 'success', 8000);
    this.result = null; this.stale = true; PlanMarkup.refreshProps();
  },
  _opt: { markers: true, kiosks: true, lv: true, mv: true, fibre: true, cross: true, trench: true },
  clear() { this.result = null; this.stale = true; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },

  // ───────── the tool's clicks ─────────
  click(pt) {
    const r = this.result, f = this.f; if (!r) { UI.toast('Run the layout first.', 'info', 3000); return; }
    const L = this.cfg(), m = [pt.x * f, pt.y * f];
    const pip = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
    if (this.mode === 'sub') {
      let best = null, bd = 12 * f / PlanEngine.view.zoom * 1;
      for (const k of r.kiosks) { const d = Math.hypot(k.x - m[0], k.y - m[1]); if (d < bd) { bd = d; best = k; } }
      if (!best) { UI.toast('Click a kiosk to put the mini-sub beside it.', 'warn', 3000); return; }
      L.sub = { x: best.x / f, y: best.y / f }; this.touched(); return;
    }
    if (this.mode === 'trunk') {
      const h = this._pickT(m); if (!h) return;
      if (h.node) { L.entry = { x: h.node.x / f, y: h.node.y / f }; }
      else { const i = L.cuts.indexOf(h.edge.key); if (i >= 0) L.cuts.splice(i, 1); else L.cuts.push(h.edge.key); }
      this.touched(); return;
    }
    const e = r.erven.find(q => q.box[0] <= m[0] && m[0] <= q.box[2] && q.box[1] <= m[1] && m[1] <= q.box[3] && pip(m[0], m[1], q.poly));
    if (!e) return;
    let best = null, bd = 1e9;
    for (const d of e.edges) { const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1], t = Math.max(0, Math.min(1, ((m[0] - d.a[0]) * dx + (m[1] - d.a[1]) * dy) / (dx * dx + dy * dy))), dist = Math.hypot(d.a[0] + t * dx - m[0], d.a[1] + t * dy - m[1]); if (dist < bd) { bd = dist; best = d; } }
    if (!best.road) { UI.toast('That edge does not face a street.', 'warn', 3000); return; }
    const auto = e.edges.filter(d => d.road).sort((p, q) => (r.P.front === 'longest' ? q.len - p.len : p.len - q.len) || p.i - q.i)[0];
    if (L.fronts[e.id] === best.i || (auto && auto.i === best.i)) delete L.fronts[e.id]; else L.fronts[e.id] = best.i;
    this.touched();
  },
  _pickT(m) {
    const F = this.result && this.result.fibre; if (!F) return null;
    const tol = 9 * this.f / PlanEngine.view.zoom;
    let node = null, nd = tol;
    for (const n of F.nodes) { const d = Math.hypot(n.x - m[0], n.y - m[1]); if (d < nd) { nd = d; node = n; } }
    if (node) return { node };
    let edge = null, ed = tol * .8;
    for (const e of F.trunks.concat(F.spare)) for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / ((dx * dx + dy * dy) || 1)));
      const d = Math.hypot(a[0] + t * dx - m[0], a[1] + t * dy - m[1]); if (d < ed) { ed = d; edge = e; }
    }
    return edge ? { edge } : null;
  },

  // ───────── the preview on the plan ─────────
  // ── the check list after a run ──
  // → [{ sev: 'fail' | 'warn' | 'info', text, ids: [erf ids to mark] }], worst first; [] = nothing to flag.
  checks() {
    const r = this.result; if (!r) return [];
    const P = r.P, out = [], nm = (list) => list.slice(0, 6).map(e => e.name || e.id).join(', ') + (list.length > 6 ? '…' : '');
    const names = {}; AppState.planMarkup.elements.forEach(e => { if (e.type === 'erf') names[e.id] = e.name; });
    const lab = (e) => Object.assign({}, e, { name: names[e.id] || e.id });
    const over = r.erven.filter(e => e.fe && e.cable > P.maxc + 1e-6);
    if (over.length) out.push({ sev: 'fail', text: `${over.length} erven are further than ${P.maxc} m of service cable from their kiosk (longest ${Math.round(Math.max(...over.map(e => e.cable)))} m): ${nm(over.map(lab))}.`, ids: over.map(e => e.id) });
    const nf = r.erven.filter(e => !e.fe);
    if (nf.length) out.push({ sev: 'fail', text: `${nf.length} erven do not face a street and get no kiosk, service or fibre: ${nm(nf.map(lab))}. Check the streets reach them.`, ids: nf.map(e => e.id) });
    const unserved = r.erven.filter(e => e.fe && !e.kiosk);
    if (unserved.length) out.push({ sev: 'fail', text: `${unserved.length} erven have no kiosk: ${nm(unserved.map(lab))}.`, ids: unserved.map(e => e.id) });
    const crowd = r.kiosks.filter(k => k.members.length > P.n);
    if (crowd.length) out.push({ sev: 'fail', text: `${crowd.length} kiosks serve more than ${P.n} erven (${crowd.map(k => k.id + ': ' + k.members.length).join(', ')}).`, ids: crowd.flatMap(k => k.members.map(e => e.id)) });
    const noBoundary = AppState.planMarkup.elements.filter(e => e.type === 'erf' && !(Array.isArray(e.boundary) && e.boundary.length >= 3));
    if (noBoundary.length) out.push({ sev: 'warn', text: `${noBoundary.length} erven on the plan have no boundary, so the layout ignores them (${nm(noBoundary)}). Detect them with Detect erven.`, ids: noBoundary.map(e => e.id) });
    const vd = r.vd;
    if (vd && vd.err) out.push({ sev: 'info', text: 'Voltage drop not checked: ' + vd.err, ids: [] });
    else if (vd) {
      const w = vd.worst, lim = vd.V.maxPct;
      if (vd.over.length) out.push({ sev: 'fail', text: `${vd.over.length} erven are over the ${lim}% voltage drop. Worst: erf ${names[w.erf.id] || w.erf.id} at ${w.total.toFixed(1)}% (${w.lv.toFixed(1)}% along the LV feeder to ${w.kiosk.id} + ${w.svc.toFixed(1)}% on its ${Math.round(w.erf.cable)} m service). Add a kiosk or a bigger cable, or raise the limit.`, ids: vd.over.map(x => x.erf.id) });
      else if (w && w.total > 0.9 * lim) out.push({ sev: 'warn', text: `Worst voltage drop is ${w.total.toFixed(1)}% of the ${lim}% limit (erf ${names[w.erf.id] || w.erf.id}).`, ids: [w.erf.id] });
      if (vd.unreached.length) out.push({ sev: 'warn', text: `${vd.unreached.length} erven sit on a kiosk the LV network does not reach, so their voltage drop is not checked.`, ids: vd.unreached.map(e => e.id) });
    }
    const near = r.erven.filter(e => e.fe && e.kiosk && e.cable > 0.85 * P.maxc && e.cable <= P.maxc + 1e-6);
    if (near.length) out.push({ sev: 'warn', text: `${near.length} services are within 15% of the ${P.maxc} m limit: ${nm(near.map(lab))}.`, ids: near.map(e => e.id) });
    const thin = P.n >= 4 ? r.kiosks.filter(k => k.members.length <= 2) : [];
    if (thin.length) out.push({ sev: 'info', text: `${thin.length} kiosks serve 2 erven or fewer (${thin.map(k => k.id).join(', ')}). Fine on a short street; otherwise try a larger worth per kiosk.`, ids: thin.flatMap(k => k.members.map(e => e.id)) });
    const mhw = (r.fibre && r.fibre.warns) || [];
    mhw.forEach(w => out.push({ sev: 'warn', text: w, ids: [] }));
    return out;
  },

  draw(ctx, zoom) {
    const r = this.result, f = this.f; if (!r) return;
    const u = 1 / zoom, W = p => [p[0] / f, p[1] / f], line = pts => { ctx.beginPath(); pts.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke(); };
    const col = k => this.PAL[(parseInt(k.id.slice(1)) - 1) % 8], S = this.SHOW;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    if (S.trench && r.trench) {                                                                        // trench bands under everything else
      ctx.lineCap = 'round';
      for (const t of r.trench.list) { const d = PLAN_DEFS.trenchTypes[t.type] || { color: 'rgba(120,120,120,.4)', width: 0.5 }; ctx.strokeStyle = d.color; ctx.lineWidth = Math.max(d.width / f, 1.5 * u); line(t.pts); }
      ctx.lineCap = 'butt';
    }
    ctx.strokeStyle = 'rgba(71,85,105,.6)'; ctx.lineWidth = 1 * u;                                   // the erf boundaries the layout read
    r.erven.forEach(e => { ctx.beginPath(); e.poly.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.stroke(); });
    if (this.flag && this.flag.size) {                                                                 // erven picked from the check list
      ctx.save(); ctx.strokeStyle = '#dc2626'; ctx.fillStyle = 'rgba(220,38,38,.22)'; ctx.lineWidth = 3 * u;
      r.erven.forEach(e => { if (!this.flag.has(e.id)) return; ctx.beginPath(); e.poly.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill(); ctx.stroke(); });
      ctx.restore();
    }
    if (S.fibre) {
      ctx.strokeStyle = '#a21caf'; ctx.lineWidth = 1.1 * u; ctx.setLineDash([2 * u, 3 * u]);
      r.erven.forEach(e => { if (e.duct) line(e.duct); });
      ctx.setLineDash([]);
      r.fibre.spare.forEach(e => { const cut = this.cfg().cuts.includes(e.key); ctx.strokeStyle = cut ? '#dc2626' : '#94a3b8'; ctx.lineWidth = 1.4 * u; ctx.setLineDash(cut ? [3 * u, 4 * u] : [1.5 * u, 4 * u]); line(e.pts); });
      ctx.setLineDash([]); ctx.strokeStyle = '#a21caf'; ctx.lineWidth = 2.6 * u; r.fibre.trunks.forEach(e => line(e.pts));
      ctx.fillStyle = '#a21caf'; r.erven.forEach(e => { if (e.fibrePt && e.duct) { const [x, y] = W(e.fibrePt), s = 3 * u; ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill(); } });
    }
    if (S.lvmv && r.net) {
      ctx.setLineDash([6 * u, 3 * u]); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.8 * u; r.net.lv.forEach(ed => line(ed.pts));
      ctx.setLineDash([]); ctx.strokeStyle = '#c92a2a'; ctx.lineWidth = 3 * u; if (r.net.mvLine) line(r.net.mvLine);
    }
    if (S.kiosk) { ctx.lineWidth = 1.1 * u; r.erven.forEach(e => { if (!e.route) return; ctx.strokeStyle = col(e.kiosk); ctx.globalAlpha = .75; line(e.route); }); ctx.globalAlpha = 1; }
    if (S.front) r.erven.forEach(e => { if (!e.fe) return; ctx.strokeStyle = e.overridden ? '#ea580c' : '#0f8f78'; ctx.lineWidth = (e.overridden ? 3.5 : 2.6) * u; const d = e.fe; ctx.beginPath(); const a = W([d.a[0] + d.inn[0] * .6, d.a[1] + d.inn[1] * .6]), b = W([d.b[0] + d.inn[0] * .6, d.b[1] + d.inn[1] * .6]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
    if (S.mark) r.erven.forEach(e => {
      if (!e.marker) return; const [x, y] = W(e.marker), s = 3.4 * u, cc = e.kiosk ? col(e.kiosk) : '#64748b';
      ctx.lineWidth = 3 * u; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s); ctx.stroke();
      ctx.lineWidth = 1.7 * u; ctx.strokeStyle = cc; ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s); ctx.stroke();
      if (e.cable > r.P.maxc + 1e-6) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1.8 * u; ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, 7); ctx.stroke(); }
    });
    if (S.cross && r.net) {
      ctx.font = `700 ${9 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      r.net.cross.forEach(x => {
        const a = W(PlanLayout.ptAt(x.st, x.s, x.st.w / 2)), b = W(PlanLayout.ptAt(x.st, x.s, -x.st.w / 2)), t = Math.min(x.d110 + x.d160, 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = (4 + t * 1.1) * u; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.strokeStyle = '#334155'; ctx.globalAlpha = x.prov ? .45 : 1; ctx.lineWidth = (2 + t * 1.1) * u; if (x.prov) ctx.setLineDash([4 * u, 3 * u]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
        const m = W(PlanLayout.ptAt(x.st, x.s, 0)); ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.arc(m[0], m[1], 6.5 * u, 0, 7); ctx.fill(); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(String(x.d110 + x.d160), m[0], m[1] + .5 * u);
      });
    }
    if (S.fibre) {
      ctx.font = `700 ${8.5 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1.8 * u;
      r.fibre.inter.forEach(j => { const [x, y] = W([j.x, j.y]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#a21caf'; ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, 7); ctx.fill(); ctx.stroke(); });
      r.fibre.mhs.forEach(m => { const [x, y] = W([m.x, m.y]); ctx.fillStyle = '#fff'; ctx.strokeStyle = m.off ? '#dc2626' : '#a21caf'; ctx.beginPath(); ctx.arc(x, y, 6.5 * u, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#a21caf'; ctx.fillText(m.label, x, y + .5 * u); });
      if (r.fibre.entry) { const [x, y] = W([r.fibre.entry.x, r.fibre.entry.y]); ctx.fillStyle = '#a21caf'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * u; ctx.beginPath(); ctx.moveTo(x, y + 3 * u); ctx.lineTo(x + 7 * u, y + 15 * u); ctx.lineTo(x - 7 * u, y + 15 * u); ctx.closePath(); ctx.stroke(); ctx.fill(); }
    }
    if (S.kiosk) {
      ctx.font = `700 ${9 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      r.kiosks.forEach(k => { const [x, y] = W([k.x, k.y]), s = 6 * u; ctx.fillStyle = '#16a34a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * u; ctx.fillRect(x - s, y - s, 2 * s, 2 * s); ctx.strokeRect(x - s, y - s, 2 * s, 2 * s); ctx.fillStyle = '#0f172a'; ctx.fillText(k.id, x + 15 * u, y - 10 * u); });
    }
    if (S.lvmv && r.net && r.net.sub) {
      const k0 = r.net.sub, st = k0.road, m = W(PlanLayout.ptAt(st, k0.s + 5, (r.ks[st.id] || 1) * st.vk));
      ctx.fillStyle = '#c92a2a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 * u; ctx.beginPath(); ctx.moveTo(m[0], m[1] - 9 * u); ctx.lineTo(m[0] + 8 * u, m[1] + 6 * u); ctx.lineTo(m[0] - 8 * u, m[1] + 6 * u); ctx.closePath(); ctx.stroke(); ctx.fill();
    }
    if (this.hoverT && this.hoverT.edge) { ctx.strokeStyle = 'rgba(234,88,12,.5)'; ctx.lineWidth = 6 * u; line(this.hoverT.edge.pts); }
    ctx.restore();
  },

  // ───────── the panel ─────────
  renderOptions(el) {
    const L = this.cfg(), p = L.params, r = this.result, st = r && r.stats, opt = this._opt;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmt = v => Math.round(v).toLocaleString('en');
    const ctrl = ([k, kind, a, b, c, unit, label]) => {
      if (kind === 'range') return `<label style="display:block">${esc(label)} <b data-v="${k}">${p[k]}${unit ? ' ' + unit : ''}</b><input type="range" data-p="${k}" data-unit="${unit}" min="${a}" max="${b}" step="${c}" value="${p[k]}" style="width:100%"></label>`;
      if (kind === 'check') return `<label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-p="${k}"${p[k] ? ' checked' : ''}> <span>${esc(a)}</span></label>`;
      return `<label style="display:block">${esc(b)}<select data-p="${k}" style="width:100%">${a.map(o => `<option value="${o[0]}"${p[k] === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    };
    const groups = this.CTRL.map(([name, rows], gi) => `<details${gi === 0 || gi === 3 ? ' open' : ''}><summary style="cursor:pointer;font-weight:600;margin:2px 0">${name}</summary><div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">${rows.map(ctrl).join('')}</div></details>`).join('');
    const TT = L.trench, tget = k => k.startsWith('depth.') ? TT.depth[k.slice(6)] : TT[k];
    const tctrl = ([k, kind, a, b, c, unit, label]) => {
      if (k === 'depth.comb' && TT.depth.comb == null) return '';
      if (kind === 'range') return `<label style="display:block">${esc(label)} <b data-tv="${k}">${(+tget(k)).toFixed(2)} ${unit}</b><input type="range" data-t="${k}" min="${a}" max="${b}" step="${c}" value="${tget(k)}" style="width:100%"></label>`;
      if (kind === 'check') { const on = k === 'combOn' ? TT.depth.comb != null : TT[k]; return `<label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-t="${k}"${on ? ' checked' : ''}> <span>${esc(a)}</span></label>`; }
      return `<label style="display:block">${esc(b)}<select data-t="${k}" style="width:100%">${a.map(o => `<option value="${o[0]}"${TT[k] === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    };
    const trenchGroup = `<details open><summary style="cursor:pointer;font-weight:600;margin:2px 0">Trenches</summary><div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">${this.TREN.map(tctrl).join('')}</div></details>`;
    const VDc = L.vd, cb = this.vdCables(), opts = (list, cur) => list.map(c => `<option value="${esc(c.id)}"${cur && cur.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    const vdGroup = `<details open><summary style="cursor:pointer;font-weight:600;margin:2px 0">Voltage drop</summary><div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">
        <label style="display:block">Maximum drop, mini-sub to the furthest erf <b data-vv="maxPct">${VDc.maxPct} %</b><input type="range" data-vd="maxPct" min="1" max="15" step="0.5" value="${VDc.maxPct}" style="width:100%"></label>
        <label style="display:block">Load per erf (ADMD, kVA)<input type="number" data-vd="admd" min="0.5" max="30" step="0.1" value="${VDc.admd}" style="width:100%"></label>
        <label style="display:block">LV feeder cable<select data-vd="lv" style="width:100%">${opts(cb.feeders, cb.lv)}</select></label>
        <label style="display:block">Service cable<select data-vd="svc" style="width:100%">${opts(cb.services, cb.svc)}</select></label>
        <div style="color:var(--text-muted)">Each LV leg carries every erf below it; a service carries one erf. Same method as Demand (power factor 0.95).</div></div></details>`;
    const sr = this.streetsOnPlan();
    const seg = (id, key, vals) => `<span class="plan-seg" style="display:inline-flex;gap:2px">${vals.map(([v, t]) => { const cur = (L.sides[id] || {})[key]; const on = (v === 0 ? (cur == null) : cur === v); return `<button type="button" class="plan-btn" data-side="${id}" data-key="${key}" data-val="${v}" aria-pressed="${on}" style="padding:2px 7px;font-size:12px${on ? ';font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`; }).join('')}</span>`;
    const streets = sr.length ? sr.map((s, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;border-bottom:1px solid var(--border,#ddd);padding:3px 0"><span>${esc((s.props && s.props.name) || 'Street ' + (i + 1))}</span><span style="display:flex;flex-direction:column;gap:2px;align-items:flex-end"><span>Kiosks ${seg(s.id, 'k', [[0, 'Auto'], [1, 'Left'], [-1, 'Right']])}</span><span>Fibre ${seg(s.id, 'f', [[0, 'Auto'], [1, 'Left'], [-1, 'Right']])}</span></span></div>`).join('') : '<div class="plan-props-empty" style="padding:4px 0">No streets yet. Take them from a drawing layer above, or pick Street centreline (Routes) and click along each street, Enter to finish. Left and right are looking along the way you drew it.</div>';
    const lyr = this.dxfLayers();
    const fromDxf = lyr.length ? `<div style="display:flex;flex-direction:column;gap:4px;margin:4px 0"><label style="display:block">Take streets from a drawing layer<select data-stl style="width:100%">${lyr.map((x, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${esc(x.layer)} (${x.n} line${x.n === 1 ? '' : 's'})${x.guess ? ' ★' : ''}</option>`).join('')}</select></label><button type="button" class="plan-btn" data-act="dxfstreets">Use layer as streets</button></div>` : '';
    const tile = (b, s) => `<div style="border:1px solid var(--border,#ddd);border-radius:5px;padding:4px 6px"><b style="font-size:15px;display:block">${b}</b><span style="font-size:11px;color:var(--text-muted)">${s}</span></div>`;
    const tiles = st ? [[st.erven, 'erven'], [st.kiosks, `kiosks · at most ${p.n} erven each`], [fmt(st.cable) + ' m', 'service cable'], [fmt(st.cableMax) + ' m of ' + p.maxc + ' m', 'longest service · limit'], ...(r.vd && !r.vd.err ? [[r.vd.max.toFixed(1) + '% of ' + r.vd.V.maxPct + '%', 'worst voltage drop · limit']] : []), [st.crossings, 'road crossings'], [st.provisional, 'junction ducts, empty'], [st.d110 + ' + ' + st.d160, '110 mm + 160 mm ducts'], [st.manholes + ' + ' + st.junctionManholes, 'manholes + junctions'], [fmt(st.trunk) + ' m', 'trunk duct'], [fmt(st.leads) + ' m', 'duct to erven'], [fmt(st.lv) + ' m', 'LV feeder'], [fmt(st.mv) + ' m', 'MV cable'], [st.tOffs + ' / ' + st.spurEnds + ' / ' + st.loops, 'T-offs / spur ends / loops'], [st.baseline, 'crossings if unshared']].map(t => tile(...t)).join('') : '';
    const xt = r ? r.net.cross.slice().sort((a, b) => (a.prov - b.prov) || (b.d110 + b.d160) - (a.d110 + a.d160)).slice(0, 14).map((x, i) => { const parts = x.prov ? `${x.d110}×110, ${x.d160}×160, junction` : [x.d110s && `${x.d110s}×110 service`, x.d110f && `${x.d110f}×110 fibre`, x.d110l && `${x.d110l}×110 LV`, x.d160 && `${x.d160}×160 MV`, x.spare && `${x.spare}×110 spare`].filter(Boolean).join(', '); return `<tr><td>${esc(x.st.name)}</td><td>${parts}</td></tr>`; }).join('') : '';
    const trenchRows = r && r.trench ? Object.entries(r.trench.summary).map(([type, q]) => { const d = PLAN_DEFS.trenchTypes[type] || { name: type, width: 0.5 }; const vol = q.len * d.width * q.depth; return `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(d.name)}</span><span>${fmt(q.len)} m at ${q.depth.toFixed(2)} m · ${fmt(vol)} m³</span></div>`; }).join('') : '';
    const ck = r ? this.checks() : [], sevCol = { fail: '#dc2626', warn: '#b45309', info: '#64748b' }, sevTxt = { fail: 'Fix', warn: 'Check', info: 'Note' };
    this._ck = ck;
    const checkBlock = r ? `<div><b>Checks</b> <span style="color:var(--text-muted)">${ck.length ? ck.filter(c => c.sev === 'fail').length + ' to fix · ' + ck.filter(c => c.sev === 'warn').length + ' to check' : ''}</span>
        ${ck.length ? ck.map((c, i) => `<button type="button" class="plan-btn" data-ck="${i}" style="display:block;width:100%;text-align:left;margin-top:3px;white-space:normal;border-left:4px solid ${sevCol[c.sev]}"><b style="color:${sevCol[c.sev]}">${sevTxt[c.sev]}</b> ${esc(c.text)}${c.ids.length ? ' <span style="color:var(--text-muted)">· show on plan</span>' : ''}</button>`).join('')
          : '<div style="color:#15803d;margin-top:3px">✓ Every erf is served, within the service limit and the kiosk size.</div>'}</div>` : '';
    const chk = (k, t) => `<label style="display:flex;gap:6px"><input type="checkbox" data-opt="${k}"${opt[k] ? ' checked' : ''}> ${t}</label>`;
    const modeBtn = (v, t) => `<button type="button" class="plan-btn" data-mode="${v}" aria-pressed="${this.mode === v}" style="padding:3px 8px;font-size:12px${this.mode === v ? ';font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`;
    el.innerHTML = `<div class="plan-props-title">Auto layout</div>
      <div class="plan-props-body" style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="run" style="font-weight:600">${r ? (this.stale ? 'Run again' : 'Re-run') : 'Run layout'}</button>
          <button type="button" class="plan-btn" data-act="create" style="font-weight:600"${r ? '' : ' disabled'}>Create on plan</button><button type="button" class="plan-btn" data-act="clear"${r ? '' : ' disabled'}>Clear</button></div>
        ${this.err ? `<div style="color:#dc2626">${esc(this.err)}</div>` : ''}
        ${r && this.stale ? '<div style="color:#b45309">Out of date: press Run again.</div>' : ''}
        ${r ? `<div style="color:var(--text-muted)">Solved in ${Math.round(this.ms)} ms. Click an erf near the edge you want as its front.</div>` : '<div style="color:var(--text-muted)">Needs the erf boundaries (Detect erven), the streets, and a calibrated plan.</div>'}
        ${checkBlock}
        <div><b>A click edits</b><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${modeBtn('front', 'Erf fronts')}${modeBtn('sub', 'Mini-sub')}${modeBtn('trunk', 'Trunk ducts / entry')}<button type="button" class="plan-btn" data-act="reset" style="padding:3px 8px;font-size:12px">Reset edits</button></div></div>
        <div><b>Streets</b>${fromDxf}${streets}</div>
        ${groups}
        ${trenchGroup}
        ${vdGroup}
        ${r ? `<div><b>Result</b><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-top:4px">${tiles}</div>
        ${r.vd && !r.vd.err && r.vd.worst ? `<div style="margin-top:6px"><b>Voltage drop</b><div>Furthest: erf ${esc(((AppState.planMarkup.elements.find(e => e.id === r.vd.worst.erf.id) || {}).name) || r.vd.worst.erf.id)}, ${r.vd.worst.total.toFixed(1)}% = ${r.vd.worst.lv.toFixed(1)}% LV (to ${esc(r.vd.worst.kiosk.id)}) + ${r.vd.worst.svc.toFixed(1)}% service</div>${r.vd.legs.slice().sort((a, b) => b.cum - a.cum).slice(0, 5).map(l => `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(l.from.id)} → ${esc(l.to.id)} · ${Math.round(l.len)} m · ${l.erven} erven</span><span>${l.pct.toFixed(2)}% (to here ${l.cum.toFixed(1)}%)</span></div>`).join('')}</div>` : ''}
        ${r.trench ? `<div style="margin-top:6px"><b>Trenches</b>${trenchRows}</div>` : ''}
          <div style="max-height:170px;overflow:auto;margin-top:6px"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr><th style="text-align:left">Crossing</th><th style="text-align:left">Ducts</th></tr></thead><tbody>${xt}</tbody></table></div>
          <div style="margin-top:8px"><b>Create</b><div style="display:flex;flex-direction:column;gap:2px;margin-top:3px">${chk('markers', 'Move the erf markers to their corner')}${chk('kiosks', 'Kiosks and service cables')}${chk('lv', 'Mini-sub and LV feeders')}${chk('mv', 'MV cable')}${chk('fibre', 'Fibre manholes and ducts')}${chk('cross', 'Road crossings (one per duct)')}${chk('trench', 'Trenches along the routes (depth and sharing as set)')}</div><div style="color:var(--text-muted);margin-top:4px">Replaces the previous auto layout. Your own items stay.</div></div></div>` : ''}
      </div>`;
    el.onclick = (e) => {
      const b = e.target.closest('[data-act],[data-mode],[data-side],[data-ck]'); if (!b) return;
      if (b.dataset.ck != null) { const c = (this._ck || [])[+b.dataset.ck]; this.flag = new Set(c ? c.ids : []); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'dxfstreets') { const sel = el.querySelector('[data-stl]'), x = lyr[sel ? +sel.value : 0]; if (x) this.streetsFromLayer(x.d.id, x.layer); }
      else if (b.dataset.act === 'run') this.run();
      else if (b.dataset.act === 'create') this.commit();
      else if (b.dataset.act === 'clear') this.clear();
      else if (b.dataset.act === 'reset') { L.fronts = {}; L.cuts = []; delete L.entry; delete L.sub; this.touched(); }
      else if (b.dataset.mode) { this.mode = b.dataset.mode; PlanMarkup.refreshProps(); }
      else if (b.dataset.side) { const o = L.sides[b.dataset.side] = L.sides[b.dataset.side] || {}, v = +b.dataset.val; if (v === 0) delete o[b.dataset.key]; else o[b.dataset.key] = v; this.touched(); }
    };
    const setT = (k, v) => { if (k.startsWith('depth.')) TT.depth[k.slice(6)] = v; else TT[k] = v; };
    el.oninput = (e) => {
      const vk = e.target.dataset.vd;
      if (vk === 'maxPct') { VDc.maxPct = this._num(e.target.value, 1, 20, 8); const lab = el.querySelector('[data-vv="maxPct"]'); if (lab) lab.textContent = VDc.maxPct + ' %'; clearTimeout(this._tv); this._tv = setTimeout(() => this.revd(), 120); return; }
      const tk = e.target.dataset.t;
      if (tk && e.target.type === 'range') { const v = parseFloat(e.target.value); setT(tk, v); const lab = el.querySelector(`[data-tv="${tk}"]`); if (lab) lab.textContent = v.toFixed(2) + ' m'; clearTimeout(this._tt); this._tt = setTimeout(() => this.retrench(), 120); return; }
      const t = e.target, k = t.dataset.p; if (!k || t.type !== 'range') return;
      p[k] = parseFloat(t.value); const lab = el.querySelector(`[data-v="${k}"]`); if (lab) lab.textContent = p[k] + (t.dataset.unit ? ' ' + t.dataset.unit : '');
      clearTimeout(this._t); this._t = setTimeout(() => this.touched(), 150);
    };
    el.onchange = (e) => {
      const t = e.target;
      if (t.dataset.vd) {
        if (t.type === 'range') return;
        if (t.dataset.vd === 'admd') VDc.admd = this._num(t.value, 0.5, 30, VDc.admd); else VDc[t.dataset.vd] = t.value;
        this.revd(); return;
      }
      if (t.dataset.t && t.type !== 'range') {
        const k = t.dataset.t;
        if (k === 'combOn') TT.depth.comb = t.checked ? Math.max(TT.depth.mv, TT.depth.lv) : null;
        else setT(k, t.type === 'checkbox' ? t.checked : t.value);
        this.retrench(); return;
      }
      if (t.dataset.opt) { opt[t.dataset.opt] = t.checked; return; }
      const k = t.dataset.p; if (!k || t.type === 'range') return;
      p[k] = t.type === 'checkbox' ? t.checked : t.value; this.touched();
    };
  },
};

if (typeof PlanTools !== 'undefined') {
  PlanTools.register({
    id: 'layout', cursor: 'crosshair',
    onActivate() { PlanLayoutUI.mode = 'front'; if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); },
    onDeactivate() { PlanLayoutUI.hoverT = null; },
    cancel() { PlanTools.set('select'); },
    onMove(pt) {
      if (PlanLayoutUI.mode !== 'trunk' || !PlanLayoutUI.result) return;
      const h = PlanLayoutUI._pickT([pt.x * PlanLayoutUI.f, pt.y * PlanLayoutUI.f]);
      if ((h && h.edge) !== (PlanLayoutUI.hoverT && PlanLayoutUI.hoverT.edge)) { PlanLayoutUI.hoverT = h; PlanEngine.requestDraw({ fg: true }); }
    },
    onDown(pt) { PlanLayoutUI.click(pt); },
    drawOverlay(ctx, zoom) { PlanLayoutUI.draw(ctx, zoom); },
    onKey(e) { if (e.key === 'Escape') { this.cancel(); return true; } return false; },
  });
}
