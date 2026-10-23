/* ProtectionPro — Street lighting › Road plan › 3D.
 *
 * The road plan in 3D, rotatable: every road's cross-section swept along it,
 * the poles with their arms and heads, and objects that can be added:
 *   • trees, buildings, walls, bus shelters, sign gantries — roadPlan.scene
 *     .objects [{ id, kind, name, x, y (m, the centre), w, d, h, z (lifted),
 *     rot (°), crownR, crownBase, opacity (trees), blocks }]. With "Shadows
 *     from objects" on they shade the road in the calculation
 *     (backend analysis/road_plan.py) — every segment check, junction and
 *     the heat map then includes them.
 *   • facade checks — scene.surfaces [{ id, name, x, y (centre), w (length),
 *     rot, z0, z1, target }]: vertical illuminance on the face to the left of
 *     its length (Rotate turns it round).
 *   • measurement points — scene.points [{ id, name, x, y, z, face, dir, target }].
 * Show: Model, False colour (the road plan's heat map on the road) or
 * Rendered light (the road as bright as it looks at night: luminance on the
 * carriageway, illuminance × reflectance elsewhere, glowing heads).
 */

const R3_KIND = {
  tree:     { label: 'Tree',        h: 8,   crownR: 3, crownBase: 3, trunk: 0.4, opacity: 0.8, icon: 'M12 3a6 6 0 0 1 6 6 5 5 0 0 1-3 9H9a5 5 0 0 1-3-9 6 6 0 0 1 6-6zM12 14v7' },
  building: { label: 'Building',    w: 12, d: 8, h: 9, z: 0, color: '#c9c2b6', icon: 'M4 21V7l8-4 8 4v14zM9 21v-5h6v5M8 10h2M14 10h2' },
  wall:     { label: 'Wall',        w: 10, d: 0.25, h: 2.1, z: 0, color: '#b3ab9e', icon: 'M3 9h18v9H3zM3 13.5h18M9 9v4.5M15 13.5V18' },
  shelter:  { label: 'Bus shelter', w: 4, d: 1.6, h: 0.15, z: 2.4, color: '#8aa0b4', icon: 'M3 7h18M5 7v13M19 7v13M5 12h14' },
  gantry:   { label: 'Sign gantry', w: 12, d: 1.0, h: 1.2, z: 5.5, color: '#7d8a99', icon: 'M3 21V5M21 21V5M3 5h18v5H3z' },
};
const R3_OTHER = {
  surface: { label: 'Facade check', icon: 'M5 3h14v18H5zM9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2' },
  point:   { label: 'Measurement point', icon: 'M12 3v12M8 19l4-4 4 4M12 7a2 2 0 1 0 0-.01' },
};
const R3_SEC = { carriageway: '#6b7079', footpath: '#c9c3b6', cycle: '#b9786a', verge: '#a9bf92', median: '#a9bf92' };

const Road3D = {
  mode: 'model',             // model | colour | render
  expo: 30,
  sel: null,                 // 'o:<id>' · 's:<id>' · 'q:<id>' (point) · 'p:<road>:<pole>'
  view: null,
  _fitted: false,

  get rp() { return RoadPlan.rp; },
  scene() {
    const rp = this.rp;
    const s = rp.scene && typeof rp.scene === 'object' ? rp.scene : (rp.scene = {});
    if (!Array.isArray(s.objects)) s.objects = [];
    if (!Array.isArray(s.surfaces)) s.surfaces = [];
    if (!Array.isArray(s.points)) s.points = [];
    return s;
  },
  shadows() { return this.rp.settings.shadows !== false; },
  _num(v, d, lo = -Infinity, hi = Infinity) { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; },

  // ─── Engine request parts (RoadPlan.payload) ───────────────────────────
  requestParts() {
    const s = this.rp.scene;
    if (!s) return {};
    const out = {};
    if (this.shadows()) {
      const obs = (s.objects || []).filter(o => o.blocks !== false).map(o => o.kind === 'tree'
        ? { id: o.id, kind: 'tree', cx: +o.x, cy: +o.y, h: +o.h, crownR: +o.crownR, crownBase: +o.crownBase, trunk: +o.trunk || 0.4, opacity: +o.opacity }
        : { id: o.id, kind: o.kind, cx: +o.x, cy: +o.y, w: +o.w, d: +o.d, rot: +o.rot || 0, z0: +o.z || 0, h: +o.h });
      if (obs.length) out.obstacles = obs;
    }
    const surfs = (s.surfaces || []).map(o => { const [a, b] = this._ends(o); return { id: o.id, name: o.name, a, b, z0: +o.z0 || 0, z1: +o.z1, target: +o.target || undefined }; });
    if (surfs.length) out.surfaces = surfs;
    const pts = (s.points || []).map(o => ({ id: o.id, name: o.name, x: +o.x, y: +o.y, z: +o.z || 0, face: o.face === 'vertical' ? 'vertical' : 'up', dir: +o.dir || 0, target: +o.target || undefined }));
    if (pts.length) out.points = pts;
    return out;
  },
  // A facade line's ends; its checked face is on the left of a → b.
  _ends(o) {
    const a = (+o.rot || 0) * Math.PI / 180, dx = Math.cos(a) * o.w / 2, dy = Math.sin(a) * o.w / 2;
    return [[+(o.x - dx).toFixed(3), +(o.y - dy).toFixed(3)], [+(o.x + dx).toFixed(3), +(o.y + dy).toFixed(3)]];
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  mount(host) {
    if (this.view || !host) return;
    host.innerHTML = `<div class="l3-view r3-view" id="r3-view" aria-label="Road plan 3D view">
        <div class="l3-cam" role="group" aria-label="Camera">
          <button type="button" data-r3-cam="left" aria-label="Turn left 45°" title="Turn left 45°">⟲</button>
          <button type="button" data-r3-cam="top">Top</button>
          <button type="button" data-r3-cam="right" aria-label="Turn right 45°" title="Turn right 45°">⟳</button>
          <button type="button" data-r3-cam="driver" title="Low, along the road">Driver</button>
          <button type="button" data-r3-cam="iso">3D</button>
          <button type="button" data-r3-cam="fit">Fit</button>
          <button type="button" data-r3-cam="out" aria-label="Zoom out">−</button>
          <button type="button" data-r3-cam="sel" title="Zoom to the selection">Sel</button>
          <button type="button" data-r3-cam="in" aria-label="Zoom in">+</button>
        </div>
        <div class="l3-legend" id="r3-legend" hidden></div>
        <div class="l3-hint">Drag empty space to orbit · right-drag or Shift-drag to pan · scroll to zoom · drag an object to move it</div>
        <div class="l3-empty" id="r3-empty" hidden></div>
      </div>
      <div class="l3-res" id="r3-res"></div>`;
    this.view = new View3D(host.querySelector('#r3-view'), { label: 'Rotatable 3D view of the road plan. Drag empty space to orbit, drag an object to move it.', yaw: -30, pitch: 30 });
    this.view.onDraw = (v) => this._draw(v);
    this.view.onPick = (id, e) => this._pick(id, e);
    this.view.onClick = (id) => { if (id == null) { this.sel = null; RoadPlan.renderPanel(); this.view.redraw(); } };
    this.view.canvas.addEventListener('keydown', (e) => this._key(e));
    host.addEventListener('click', (e) => this._onCam(e));
    host.addEventListener('input', (e) => { if (e.target.dataset.r3 === 'expo') { this.expo = this._num(e.target.value, 20, 2, 120); this.view.redraw(); } });
  },
  render() {
    if (!this.view) return;
    if (!this._fitted) { this._fitted = true; this.fit(); }
    this._renderRes(); this._renderLegend();
    this.view.redraw();
  },
  _bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = 3;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const r of RoadPlan.roads) {
      const g = RoadPlan.geom(r);
      if (!g.al.ok) continue;
      for (const p of g.al.pts) add(p[0], p[1]);
      for (const p of r.poles || []) { const pg = RoadPlan.poleGeom(r, p); if (pg) { add(pg.bx, pg.by); z1 = Math.max(z1, pg.height); } }
    }
    for (const o of this.scene().objects) { add(o.x, o.y); z1 = Math.max(z1, (+o.z || 0) + (+o.h || 0)); }
    if (!isFinite(x0)) return null;
    return [[x0 - 5, y0 - 5, 0], [x1 + 5, y1 + 5, z1]];
  },
  fit() {
    const b = this._bbox();
    if (b && this.view) this.view.fit(b[0], b[1]);
  },

  // ─── Drawing ───────────────────────────────────────────────────────────
  _res() { return RoadPlan._res && RoadPlan._res.roads ? RoadPlan._res : null; },

  _draw(v) {
    const empty = document.getElementById('r3-empty');
    const roads = RoadPlan.roads.filter(r => RoadPlan.geom(r).al.ok);
    if (empty) { empty.hidden = !!roads.length; empty.textContent = 'Draw a road first (Plan view, step 1).'; }
    if (!roads.length) { v.bg = null; return; }
    const res = this._res();
    const stale = RoadPlan._resStale;
    const rendered = this.mode === 'render' && res;
    const colour = this.mode === 'colour' && res;
    v.bg = rendered ? '#0b0d10' : null;
    // labels: light on a dark halo at night
    const label = (o) => v.label(rendered ? Object.assign(o, { halo: 'rgba(11,13,16,.85)', color: o.color === '#a61b1b' ? '#ff9b8f' : (o.color === '#005fa3' ? '#8cc4ff' : '#eef2f6') }) : o);
    const lx = (x) => RoadPlan._fmt(x, x != null && Math.abs(x) < 1 ? 2 : 1);
    const b = this._bbox();
    const m = 20;
    v.face({ pts: [[b[0][0] - m, b[0][1] - m, -0.01], [b[1][0] + m, b[0][1] - m, -0.01], [b[1][0] + m, b[1][1] + m, -0.01], [b[0][0] - m, b[1][1] + m, -0.01]],
      fill: rendered ? '#101215' : '#e3e8dc', layer: 0, bias: -1e8 });
    // road strips
    for (const r of roads) {
      const g = RoadPlan.geom(r), L = g.al.length;
      const n = Math.max(2, Math.min(600, Math.ceil(L / 2)));
      for (const sec of g.xs.lay.secs) {
        if (!(sec.width > 0)) continue;
        const fill = rendered ? '#16181c' : R3_SEC[sec.type] || R3_SEC.verge;
        for (let k = 0; k < n; k++) {
          const s0 = L * k / n, s1 = L * (k + 1) / n;
          const a0 = g.al.at(s0, g.xs.off(s0, sec.y0)), b0 = g.al.at(s0, g.xs.off(s0, sec.y1));
          const a1 = g.al.at(s1, g.xs.off(s1, sec.y0)), b1 = g.al.at(s1, g.xs.off(s1, sec.y1));
          v.face({ pts: [[a0.x, a0.y, 0], [b0.x, b0.y, 0], [b1.x, b1.y, 0], [a1.x, a1.y, 0]], fill, layer: 0, bias: -1e7 });
        }
      }
      if (!rendered && !colour) {
        for (const y of [g.xs.kl, g.xs.kr]) {
          const pts = [];
          for (let k = 0; k <= n; k++) { const s = L * k / n; const p = g.al.at(s, g.xs.off(s, y)); pts.push([p.x, p.y, 0.02]); }
          v.line({ pts, stroke: '#3f444b', lw: 1, layer: 0.2 });
        }
      }
    }
    if ((colour || rendered) && res) this._grids(v, res, rendered, stale);
    // poles
    const names = new Map();
    for (const r of roads) for (const [id, nm] of RoadPlan._poleNames(r)) names.set(id, nm);
    for (const r of roads) {
      for (const p of r.poles || []) {
        const pg = RoadPlan.poleGeom(r, p);
        if (!pg) continue;
        const id = `p:${r.id}:${p.id}`, on = this.sel === id;
        const h = pg.height;
        const col = on ? '#0078d7' : (rendered ? '#2b2f36' : '#5a5f66');
        v.line({ pts: [[pg.bx, pg.by, 0], [pg.bx, pg.by, h]], stroke: col, lw: on ? 4 : 3, layer: 1, pick: id });
        if (pg.overhang > 0.05) v.line({ pts: [[pg.bx, pg.by, h], [pg.hx, pg.hy, h]], stroke: col, lw: 2.5, layer: 1, pick: id });
        const rot = Math.atan2(pg.ay, pg.ax) * 180 / Math.PI;
        V3D.box(v, [pg.hx + pg.ax * 0.3, pg.hy + pg.ay * 0.3], 0.7, 0.3, h - 0.15, 0.15, rot, {
          color: rendered ? '#fffbea' : '#d0d4da', under: rendered ? '#fffdf4' : '#fff1bf', stroke: on ? '#0078d7' : 'rgba(26,26,46,.4)', lw: on ? 2 : 0.6, pick: id, noCull: true });
        if (rendered) {
          v.glow({ at: [pg.hx + pg.ax * 0.3, pg.hy + pg.ay * 0.3, h - 0.2], r: 3.2, color: 'rgba(255,244,214,.45)' });
          v.glow({ at: [pg.hx + pg.ax * 0.3, pg.hy + pg.ay * 0.3, h - 0.2], r: 1.0, color: 'rgba(255,253,240,.95)' });
        }
        if (on || (!rendered && v.scale() > 6)) label({ at: [pg.bx, pg.by, h + 0.6], text: names.get(p.id) || 'Pole', size: 11, color: on ? '#005fa3' : '#1a1a2e' });
      }
    }
    // objects
    const sc = this.scene();
    for (const o of sc.objects) this._object(v, o, rendered);
    // facade checks
    const sres = res && res.surfaces ? res.surfaces : [];
    for (const o of sc.surfaces) {
      const [a, bb] = this._ends(o), on = this.sel === 's:' + o.id;
      const z0 = +o.z0 || 0, z1 = +o.z1;
      const q = [[a[0], a[1], z0], [bb[0], bb[1], z0], [bb[0], bb[1], z1], [a[0], a[1], z1]];
      const r = sres.find(x => x.id === o.id);
      if ((colour || rendered) && r && r.values) this._surfGrid(v, o, a, bb, r, stale, rendered);
      else v.face({ pts: q, fill: 'rgba(0,120,215,.22)', layer: 1, pick: 's:' + o.id });
      v.line({ pts: q.concat([q[0]]), stroke: on ? '#0078d7' : (rendered ? '#7fb2e6' : '#1a1a2e'), lw: on ? 2.5 : 1.2, dash: [5, 3], layer: 2, pick: 's:' + o.id });
      // arrow showing the checked side
      const ang = (+o.rot || 0) * Math.PI / 180, nx = -Math.sin(ang), ny = Math.cos(ang), mz = (z0 + z1) / 2;
      v.line({ pts: [[o.x, o.y, mz], [o.x + nx * 1.5, o.y + ny * 1.5, mz]], stroke: '#0078d7', lw: 2, layer: 2 });
      if (r) label({ at: [o.x, o.y, z1 + 0.4], text: `${o.name}: Ev min ${lx(r.Evmin)} lx${r.target ? ` / ${r.target}` : ''}${stale ? ' (old)' : ''}`, size: 11, bold: true, color: r.pass === false ? '#a61b1b' : '#1a1a2e' });
    }
    // measurement points
    const pres = res && res.points ? res.points : [];
    for (const o of sc.points) {
      const on = this.sel === 'q:' + o.id, z = +o.z || 0;
      v.line({ pts: [[o.x, o.y, 0], [o.x, o.y, Math.max(z, 0.05)]], stroke: on ? '#0078d7' : '#d1453b', lw: 2, layer: 2, pick: 'q:' + o.id });
      const d = 0.35;
      v.face({ pts: [[o.x - d, o.y, z], [o.x, o.y - d, z], [o.x + d, o.y, z], [o.x, o.y + d, z]], fill: on ? '#0078d7' : '#d1453b', layer: 2, pick: 'q:' + o.id });
      const r = pres.find(x => x.id === o.id);
      label({ at: [o.x, o.y, z + 0.5], text: r ? `${o.name}: ${lx(r.E)} lx${stale ? ' (old)' : ''}` : o.name, size: 11, bold: !!r, color: r && r.pass === false ? '#a61b1b' : '#1a1a2e' });
    }
    const sel = this._selected();
    if (sel && sel.type === 'o') {
      const o = sel.item;
      label({ at: [o.x, o.y, (+o.z || 0) + (+o.h || 0) + 1], text: `${o.name}`, color: '#005fa3', size: 12 });
    }
  },

  _object(v, o, rendered) {
    const on = this.sel === 'o:' + o.id, id = 'o:' + o.id;
    const ghost = o.blocks === false;
    const stroke = on ? '#0078d7' : 'rgba(26,26,46,.35)', lw = on ? 2 : 0.6;
    if (o.kind === 'tree') {
      const h = +o.h || 8, base = Math.min(+o.crownBase || 3, h - 0.1), R = +o.crownR || 3, tw = +o.trunk || 0.4;
      V3D.box(v, [o.x, o.y], tw, tw, 0, base + 0.2, 0, { color: rendered ? '#1c1712' : '#7a5b3e', stroke, lw, pick: id, alpha: ghost ? 0.45 : 1 });
      this._ellipsoid(v, [o.x, o.y, (base + h) / 2], R, (h - base) / 2, rendered ? '#14261a' : '#5f9a52', { stroke: on ? '#0078d7' : null, pick: id, alpha: ghost ? 0.4 : (rendered ? 0.95 : 0.9) });
      return;
    }
    const k = R3_KIND[o.kind] || R3_KIND.building;
    const col = rendered ? '#22252b' : k.color;
    V3D.box(v, [o.x, o.y], +o.w, +o.d, +o.z || 0, +o.h, +o.rot || 0, { color: col, stroke, lw, pick: id, alpha: ghost ? 0.45 : 1, dash: ghost ? [4, 3] : null });
    // posts for what stands on legs
    if ((o.kind === 'shelter' || o.kind === 'gantry') && (+o.z || 0) > 0.3) {
      const a = (+o.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hw = o.w / 2 - 0.1, hd = o.d / 2 - 0.1;
      const legs = o.kind === 'gantry' ? [[-hw, 0], [hw, 0]] : [[-hw, hd], [hw, hd], [-hw, -hd], [hw, -hd]];
      for (const [u, w2] of legs) {
        const x = o.x + u * ca - w2 * sa, y = o.y + u * sa + w2 * ca;
        v.line({ pts: [[x, y, 0], [x, y, +o.z]], stroke: rendered ? '#2b2f36' : '#5a5f66', lw: o.kind === 'gantry' ? 4 : 2, layer: 1, pick: id });
      }
    }
  },
  _ellipsoid(v, c, R, Rz, color, o) {
    const nu = 10, nv = 6;
    const L = [-0.35, -0.45, 0.82];        // light from above, for the model view's shading
    const P = (i, j) => {
      const th = i / nu * Math.PI * 2, ph = -Math.PI / 2 + j / nv * Math.PI;
      return [c[0] + R * Math.cos(ph) * Math.cos(th), c[1] + R * Math.cos(ph) * Math.sin(th), c[2] + Rz * Math.sin(ph)];
    };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      const mx = q.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
      const n = [(mx[0] - c[0]) / R, (mx[1] - c[1]) / R, (mx[2] - c[2]) / Rz];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const k = 0.62 + 0.38 * Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl);
      v.face({ pts: q, fill: V3D.shade(color, k), stroke: o.stroke || null, lw: 1, alpha: o.alpha, pick: o.pick, cull: [n[0] / nl, n[1] / nl, n[2] / nl], layer: 1 });
    }
  },
  _grids(v, res, rendered, stale) {
    const qty = RoadPlan._qty;
    let vmax = 0;
    for (const r of res.roads) { const g = r.display; if (!g) continue; for (const row of g[qty] || []) for (const x of row || []) if (x != null && x > vmax) vmax = x; }
    vmax = vmax || 1;
    for (const r of res.roads) {
      const g = r.display;
      if (!g) continue;
      const road = RoadPlan.road(r.id);
      const xs = road ? RoadPlan.geom(road).xs : null;
      const secAt = (y) => xs ? (xs.lay.secs.find(s => y >= s.y0 - 1e-6 && y <= s.y1 + 1e-6) || {}).type : null;
      for (let i = 0; i + 1 < g.x.length; i++) for (let j = 0; j + 1 < g.x[i].length; j++) {
        const q = [[g.x[i][j], g.y[i][j]], [g.x[i + 1][j], g.y[i + 1][j]], [g.x[i + 1][j + 1], g.y[i + 1][j + 1]], [g.x[i][j + 1], g.y[i][j + 1]]];
        const pts = q.map(p => [p[0], p[1], 0.02]);
        const avg = (A) => { if (!A) return null; const vs = [A[i][j], A[i + 1][j], A[i + 1][j + 1], A[i][j + 1]].filter(x => x != null); return vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : null; };
        let fill;
        if (rendered) {
          const type = secAt((g.yc[j] + g.yc[j + 1]) / 2);
          const Lum = type === 'carriageway' ? avg(g.L) : null;
          const lum = Lum != null ? Lum : (avg(g.E) || 0) * (type === 'verge' || type === 'median' ? 0.1 : 0.2) / Math.PI;
          const base = type === 'carriageway' ? '#cfcac0' : type === 'verge' || type === 'median' ? '#9fb08a' : '#ddd6c8';
          const k = 0.03 + 0.97 * (1 - Math.exp(-lum * this.expo / 45));
          fill = 'rgb(' + V3D.rgb(base).map(x => Math.round(Math.min(255, x * k * 1.08))).join(',') + ')';
        } else {
          const val = avg(g[qty]);
          if (val == null) continue;
          fill = RoadPlan._colour(val / vmax);
        }
        v.face({ pts, fill, alpha: stale ? 0.5 : 1, layer: 0, bias: -5e6 });
      }
    }
  },
  _surfGrid(v, o, a, b, r, stale, rendered) {
    const z0 = +o.z0 || 0, z1 = +o.z1;
    const top = Math.max(r.Evmax || 0, 1);
    const ex = [(b[0] - a[0]) / r.nu, (b[1] - a[1]) / r.nu], dz = (z1 - z0) / r.nv;
    for (let j = 0; j < r.nv; j++) for (let i = 0; i < r.nu; i++) {
      const val = r.values[j * r.nu + i];
      if (val == null) continue;
      const P = (ii, jj) => [a[0] + ex[0] * ii, a[1] + ex[1] * ii, z0 + dz * jj];
      const fill = rendered ? V3D.tone(val, 0.4, '#d9d2c4', this.expo) : RoadPlan._colour(val / top);
      v.face({ pts: [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)], fill, alpha: stale ? 0.5 : 0.95, layer: 1, pick: 's:' + o.id });
    }
  },

  // ─── Selection / editing ───────────────────────────────────────────────
  _selected() {
    if (!this.sel) return null;
    const t = this.sel[0], id = this.sel.slice(2);
    const sc = this.scene();
    if (t === 'p') {
      const [rid, pid] = id.split(':');
      const road = RoadPlan.road(rid), pole = road && (road.poles || []).find(p => p.id === pid);
      return pole ? { type: 'p', item: pole, road } : null;
    }
    const list = t === 'o' ? sc.objects : t === 's' ? sc.surfaces : t === 'q' ? sc.points : [];
    const item = list.find(x => x.id === id);
    return item ? { type: t, item } : null;
  },

  _commit() {
    RoadPlan._commit();
    RoadPlan.renderPanel();
    this.render();
  },

  _pick(id, e) {
    this.sel = id;
    RoadPlan.renderPanel();
    this.view.redraw();
    const s = this._selected();
    if (!s || s.type === 'p') return null;
    const v = this.view;
    const [sx, sy] = v._pos(e);
    const z = s.type === 'o' ? (+s.item.z || 0) : s.type === 'q' ? (+s.item.z || 0) : (+s.item.z0 || 0);
    const start = v.planeAt(sx, sy, z);
    const x0 = +s.item.x, y0 = +s.item.y;
    const snap = (x) => Math.round(x * 10) / 10;
    return {
      move: (ev) => {
        const [x, y] = v._pos(ev);
        const p = v.planeAt(x, y, z);
        s.item.x = snap(x0 + p[0] - start[0]); s.item.y = snap(y0 + p[1] - start[1]);
        this.view.redraw();
      },
      up: (ev, moved) => { if (moved) this._commit(); },
    };
  },

  _key(e) {
    const s = this._selected();
    if (e.key === 'Escape') { this.sel = null; RoadPlan.renderPanel(); this.view.redraw(); e.stopPropagation(); return; }
    if (!s || s.type === 'p') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.remove(); }
    else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) { e.stopPropagation(); this.rotate90(); }
  },

  add(kind) {
    const sc = this.scene();
    if (!RoadPlan.roads.some(r => RoadPlan.geom(r).al.ok)) { UI.toast('Draw a road first.', 'info'); return; }
    // drop it where the camera looks, on the ground
    const c = this.view.canvas, p = this.view.planeAt(c.clientWidth / 2, c.clientHeight / 2, 0);
    const at = { x: +p[0].toFixed(1), y: +p[1].toFixed(1) };
    const n = (list, k) => list.filter(x => !k || x.kind === k).length + 1;
    const id = RoadPlan._genId(kind === 'surface' ? 'rps' : kind === 'point' ? 'rpq' : 'rpo');
    if (R3_KIND[kind]) {
      const k = R3_KIND[kind];
      const o = kind === 'tree'
        ? { id, kind, name: `Tree ${n(sc.objects, 'tree')}`, ...at, h: k.h, crownR: k.crownR, crownBase: k.crownBase, trunk: k.trunk, opacity: k.opacity, blocks: true }
        : { id, kind, name: `${k.label} ${n(sc.objects, kind)}`, ...at, w: k.w, d: k.d, h: k.h, z: k.z, rot: 0, blocks: true };
      // line it up with the nearest road
      const r = this._nearestRoad(at.x, at.y);
      if (r && kind !== 'tree') o.rot = +(Math.atan2(r.ty, r.tx) * 180 / Math.PI).toFixed(1);
      sc.objects.push(o); this.sel = 'o:' + id;
    } else if (kind === 'surface') {
      const r = this._nearestRoad(at.x, at.y);
      const o = { id, name: `Facade ${n(sc.surfaces)}`, ...at, w: 12, rot: r ? +(Math.atan2(r.ty, r.tx) * 180 / Math.PI).toFixed(1) : 0, z0: 0, z1: 3, target: 0 };
      sc.surfaces.push(o); this.sel = 's:' + id;
    } else if (kind === 'point') {
      const o = { id, name: `Point ${n(sc.points)}`, ...at, z: 0, face: 'up', dir: 0, target: 0 };
      sc.points.push(o); this.sel = 'q:' + id;
    }
    this._commit();
  },
  _nearestRoad(x, y) {
    let best = null;
    for (const r of RoadPlan.roads) {
      const g = RoadPlan.geom(r);
      if (!g.al.ok) continue;
      const pr = g.al.project(x, y);
      if (!best || pr.dist < best.dist) { const a = g.al.at(pr.s); best = { dist: pr.dist, tx: a.tx, ty: a.ty }; }
    }
    return best;
  },
  remove() {
    const s = this._selected();
    if (!s || s.type === 'p') return;
    const sc = this.scene();
    if (s.type === 'o') sc.objects = sc.objects.filter(x => x !== s.item);
    else if (s.type === 's') sc.surfaces = sc.surfaces.filter(x => x !== s.item);
    else if (s.type === 'q') sc.points = sc.points.filter(x => x !== s.item);
    this.sel = null;
    this._commit();
  },
  rotate90() {
    const s = this._selected();
    if (!s || s.type === 'p' || s.type === 'q' || s.item.kind === 'tree') return;
    s.item.rot = ((+s.item.rot || 0) + 90) % 360;
    this._commit();
  },

  // ─── Toolbar, panel, results ───────────────────────────────────────────
  toolbarHtml() {
    const seg = (val, label) => `<button class="${this.mode === val ? 'active' : ''}" data-r3-mode="${escHtml(val)}" aria-pressed="${this.mode === val}">${label}</button>`;
    return `<span class="sl-view-toggle" role="group" aria-label="Show">${seg('model', 'Model')}${seg('colour', 'False colour')}${seg('render', 'Rendered light')}</span>
      ${this.mode === 'colour' ? `<span class="sl-view-toggle" role="group" aria-label="Quantity"><button class="${RoadPlan._qty === 'E' ? 'active' : ''}" data-rp-qty="E">Illuminance</button><button class="${RoadPlan._qty === 'L' ? 'active' : ''}" data-rp-qty="L">Luminance</button></span>` : ''}
      <label class="rl-inline" title="Trees, buildings, shelters and gantries shade the road in the calculation"><input type="checkbox" data-r3="shadows"${this.shadows() ? ' checked' : ''}> Shadows from objects</label>
      <button class="btn-small btn-primary" data-rp="calc">${RoadPlan._busy ? 'Calculating…' : 'Calculate'}</button>`;
  },

  panelHtml() {
    const sc = this.scene();
    const btn = (k, D) => `<button type="button" class="l3-pal-btn" data-r3-add="${k}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${D.icon}"/></svg><span>${D.label}</span></button>`;
    const row = (id, name, kind, dot) => `<button type="button" class="l3-row${this.sel === id ? ' active' : ''}" data-r3-sel="${escHtml(id)}"><i style="background:${dot}"></i><span>${escHtml(name || '')}</span><small>${kind}</small></button>`;
    const list = sc.objects.map(o => row('o:' + o.id, o.name, (R3_KIND[o.kind] || R3_KIND.building).label, o.kind === 'tree' ? '#5f9a52' : (R3_KIND[o.kind] || R3_KIND.building).color)).join('')
      + sc.surfaces.map(o => row('s:' + o.id, o.name, 'Facade check', '#0078d7')).join('')
      + sc.points.map(o => row('q:' + o.id, o.name, 'Point', '#d1453b')).join('');
    return `<div class="rp-pane r3-pane">
      <div class="rp-block"><div class="rp-block-h"><b>Add to the scene</b></div>
        <div class="l3-pal-grid r3-pal">${Object.entries(R3_KIND).map(([k, D]) => btn(k, D)).join('')}${Object.entries(R3_OTHER).map(([k, D]) => btn(k, D)).join('')}</div>
        <div class="sl-hint">It drops where the view is looking; drag it into place.</div></div>
      ${this._propsHtml()}
      <div class="rp-block"><div class="rp-block-h"><b>In the scene</b><span class="sl-hint">${sc.objects.length + sc.surfaces.length + sc.points.length}</span></div>
        <div class="l3-list">${list || '<div class="sl-hint">Nothing yet.</div>'}</div></div>
      ${this._resultsHtml()}
    </div>`;
  },

  _propsHtml() {
    const s = this._selected();
    if (!s) return '';
    const num = (k, label, val, step, extra = '') => `<label class="rp-field">${label}<input type="number" step="${step}" data-r3f="${k}" value="${escHtml(val)}" ${extra}></label>`;
    const f2 = (x) => (+x || 0).toFixed(2);
    const it = s.item;
    const head = (title, kind) => `<div class="rp-block-h"><b>${escHtml(title || '')}</b><span class="sl-hint">${kind}</span></div>`;
    const actions = `<div class="rp-actions">${s.type !== 'q' && it.kind !== 'tree' ? '<button class="btn-small" data-r3="rot90">Rotate 90° (R)</button>' : ''}<button class="btn-small" data-r3="del">Delete</button></div>`;
    if (s.type === 'p') {
      const names = RoadPlan._poleNames(s.road), pg = RoadPlan.poleGeom(s.road, it);
      return `<div class="rp-block">${head(names.get(it.id), 'Pole on ' + escHtml(s.road.name))}
        <div class="sl-hint">${pg ? `Height ${RoadPlan._fmt(pg.height, 1)} m · overhang ${RoadPlan._fmt(pg.overhang, 1)} m · tilt ${RoadPlan._fmt(pg.tilt, 0)}° · chainage ${RoadPlan._fmt(it.s, 1)} m` : ''}</div>
        <div class="rp-actions"><button class="btn-small" data-r3="edit-poles">Edit poles on the plan (step 2)</button></div></div>`;
    }
    if (s.type === 'o') {
      const tree = it.kind === 'tree';
      return `<div class="rp-block">${head(it.name, (R3_KIND[it.kind] || R3_KIND.building).label)}
        <label class="rp-field">Name<input data-r3f="name" value="${escHtml(it.name || '')}"></label>
        <div class="rp-grid2">${num('x', 'X m', f2(it.x), 0.1)}${num('y', 'Y m', f2(it.y), 0.1)}
        ${tree ? `${num('h', 'Height m', f2(it.h), 0.5, 'min="0.5"')}${num('crownR', 'Crown radius m', f2(it.crownR), 0.25, 'min="0.1"')}
          ${num('crownBase', 'Crown from m', f2(it.crownBase), 0.25, 'min="0"')}${num('opacity', 'Crown opacity', f2(it.opacity), 0.05, 'min="0" max="1"')}`
        : `${num('w', 'Length m', f2(it.w), 0.1, 'min="0.05"')}${num('d', 'Depth m', f2(it.d), 0.1, 'min="0.05"')}
          ${num('h', 'Height m', f2(it.h), 0.1, 'min="0.05"')}${num('z', 'Lifted m', f2(it.z), 0.1, 'min="0"')}
          ${num('rot', 'Rotation °', Math.round(+it.rot || 0), 5)}`}</div>
        <label class="rp-check"><input type="checkbox" data-r3f="blocks"${it.blocks !== false ? ' checked' : ''}> Blocks light (casts shadows)</label>
        ${tree ? '<div class="sl-hint">The crown lets 1 − opacity of the light through (a dense crown ≈ 0.8, bare branches ≈ 0.3).</div>' : ''}
        ${actions}</div>`;
    }
    if (s.type === 's') {
      return `<div class="rp-block">${head(it.name, 'Facade check')}
        <label class="rp-field">Name<input data-r3f="name" value="${escHtml(it.name || '')}"></label>
        <div class="rp-grid2">${num('x', 'X m', f2(it.x), 0.1)}${num('y', 'Y m', f2(it.y), 0.1)}
          ${num('w', 'Length m', f2(it.w), 0.5, 'min="0.5"')}${num('rot', 'Rotation °', Math.round(+it.rot || 0), 5)}
          ${num('z0', 'From m', f2(it.z0), 0.1, 'min="0"')}${num('z1', 'To m', f2(it.z1), 0.1, 'min="0.1"')}
          ${num('target', 'Ev min target lx', +it.target || 0, 0.5, 'min="0"')}</div>
        <div class="sl-hint">Vertical illuminance on the side the arrow points to (Rotate 90° twice turns it round). 0 = no target. E.g. EN 12464-2 / obtrusive-light limits on a facade.</div>
        ${actions}</div>`;
    }
    return `<div class="rp-block">${head(it.name, 'Measurement point')}
      <label class="rp-field">Name<input data-r3f="name" value="${escHtml(it.name || '')}"></label>
      <div class="rp-grid2">${num('x', 'X m', f2(it.x), 0.1)}${num('y', 'Y m', f2(it.y), 0.1)}${num('z', 'Height m', f2(it.z), 0.1, 'min="0"')}
        <label class="rp-field">Measures<select data-r3f="face"><option value="up"${it.face === 'vertical' ? '' : ' selected'}>Horizontal E</option><option value="vertical"${it.face === 'vertical' ? ' selected' : ''}>Vertical E</option></select></label>
        ${it.face === 'vertical' ? num('dir', 'Facing °', Math.round(+it.dir || 0), 15) : ''}${num('target', 'Target lx', +it.target || 0, 0.5, 'min="0"')}</div>
      ${actions}</div>`;
  },

  _resultsHtml() {
    const res = this._res();
    if (!res) return '';
    const sc = this.scene();
    const stale = RoadPlan._resStale ? ' <span class="rp-tag edit">out of date</span>' : '';
    const rows = [];
    for (const s of res.surfaces || []) { const o = sc.surfaces.find(x => x.id === s.id); if (o) rows.push(`<tr class="${s.pass === false ? 'bad' : ''}"><td>${escHtml(s.name)}</td><td class="sl-mono">Ev ${RoadPlan._fmt(s.Ev, s.Ev < 1 ? 2 : 1)} · min ${RoadPlan._fmt(s.Evmin, s.Evmin < 1 ? 2 : 1)} lx</td><td>${s.pass == null ? '' : s.pass ? '<span class="rl-ok">✓</span>' : '<span class="rl-bad">✗</span>'}</td></tr>`); }
    for (const p of res.points || []) { const o = sc.points.find(x => x.id === p.id); if (o) rows.push(`<tr class="${p.pass === false ? 'bad' : ''}"><td>${escHtml(p.name)}</td><td class="sl-mono">E ${RoadPlan._fmt(p.E, p.E < 1 ? 2 : 1)} lx</td><td>${p.pass == null ? '' : p.pass ? '<span class="rl-ok">✓</span>' : '<span class="rl-bad">✗</span>'}</td></tr>`); }
    if (!rows.length) return '';
    return `<div class="rp-block"><div class="rp-block-h"><b>Facades and points</b>${stale}</div><table class="rl-table rp-res"><tbody>${rows.join('')}</tbody></table></div>`;
  },

  _renderRes() {
    const el = document.getElementById('r3-res');
    if (!el) return;
    const res = RoadPlan._res;
    const chip = (t, cls) => `<span class="l3-chip${cls ? ' ' + cls : ''}">${t}</span>`;
    if (!res || !res.roads) { el.innerHTML = `<b>Roads</b>${chip(res && res.problems ? escHtml(res.problems[0]) : res && res.error ? escHtml(res.error) : 'Not calculated — press Calculate')}`; return; }
    const segs = res.roads.reduce((n, r) => n + r.segments.length, 0), bad = res.roads.reduce((n, r) => n + r.segments.filter(s => !s.pass).length, 0);
    const jBad = res.conflictAreas.filter(c => c.pass === false).length;
    el.innerHTML = `<b>Roads</b>${chip(`${segs - bad} of ${segs} segments pass`, bad ? 'bad' : 'ok')}${res.conflictAreas.length ? chip(`${res.conflictAreas.length - jBad} of ${res.conflictAreas.length} junctions pass`, jBad ? 'bad' : 'ok') : ''}
      ${chip(res.shadows ? 'With shadows from objects' : 'Unobstructed (no shadows)')}<span class="l3-spacer"></span>
      ${RoadPlan._resStale ? chip('Out of date — the plan or its objects changed', 'warn') : chip('Up to date', 'ok')}`;
  },

  _renderLegend() {
    const el = document.getElementById('r3-legend');
    if (!el) return;
    const res = this._res();
    if (this.mode === 'model') { el.hidden = true; return; }
    el.hidden = false;
    if (!res) { el.innerHTML = `<b>${this.mode === 'render' ? 'Rendered light' : 'False colour'}</b><span>Calculate to see it.</span>`; return; }
    if (this.mode === 'colour') {
      let vmax = 0;
      for (const r of res.roads) { const g = r.display; if (!g) continue; for (const row of g[RoadPlan._qty] || []) for (const x of row || []) if (x != null && x > vmax) vmax = x; }
      const unit = RoadPlan._qty === 'L' ? 'cd/m²' : 'lx';
      el.innerHTML = `<b>${RoadPlan._qty === 'L' ? 'Luminance' : 'Illuminance'}, ${unit}</b><div class="plan-legend-bar r3-ramp" aria-hidden="true"></div>
        <div class="plan-legend-scale"><span>0</span><span>${RoadPlan._fmt(vmax / 2, 1)}</span><span>${RoadPlan._fmt(vmax, 1)}</span></div>
        <span>${res.shadows ? 'With shadows from objects.' : 'Unobstructed.'}${RoadPlan._resStale ? ' Out of date.' : ''}</span>`;
    } else {
      el.innerHTML = `<b>Rendered light</b><span>The road as bright as it looks at night: luminance on the carriageway, illuminance × reflectance on footways and verges${res.shadows ? ', with the shadows of objects' : ''}.${RoadPlan._resStale ? ' <b>Out of date.</b>' : ''}</span>
        <label class="l3-expo">Exposure <input type="range" min="2" max="120" step="1" value="${escHtml(this.expo)}" data-r3="expo"></label>`;
    }
  },

  _onCam(e) {
    const cam = e.target.closest('[data-r3-cam]');
    if (!cam) return;
    const v = this.view, k = cam.dataset.r3Cam;
    if (k === 'left') v.rotate(-45); else if (k === 'right') v.rotate(45);
    else if (k === 'top') v.setView(0, 89.5); else if (k === 'iso') v.setView(-30, 30);
    else if (k === 'in') v.zoomBy(1.25); else if (k === 'out') v.zoomBy(0.8); else if (k === 'fit') this.fit();
    else if (k === 'driver') {
      const r = RoadPlan.selRoad || RoadPlan.roads[0];
      const g = r && RoadPlan.geom(r);
      if (g && g.al.ok) {
        const a = g.al.at(g.al.length / 2);
        // look along the road: the view's yaw puts +y up the screen at yaw 0
        v.target = [a.x, a.y, 1.5];
        v.pan = [0, 0]; v.zoom = 2.2;
        v.setView(Math.atan2(a.tx, a.ty) * 180 / Math.PI, 8);
      }
    } else if (k === 'sel') {
      const s = this._selected();
      if (s && s.item.x != null) { v.target = [+s.item.x, +s.item.y, 1]; v.pan = [0, 0]; v.zoom = Math.max(v.zoom, 3); v.redraw(); }
    }
  },

  // RoadPlan's panel and toolbar events while the 3D view is shown.
  onClick(e) {
    const t = e.target;
    const m = t.closest('[data-r3-mode]');
    if (m) {
      this.mode = m.dataset.r3Mode;
      if (this.mode !== 'model' && !this._res() && !RoadPlan._busy) RoadPlan.recompute(0);
      RoadPlan.renderToolbar(); this.render();
      return true;
    }
    const add = t.closest('[data-r3-add]');
    if (add) { this.add(add.dataset.r3Add); return true; }
    const sel = t.closest('[data-r3-sel]');
    if (sel) { this.sel = sel.dataset.r3Sel; RoadPlan.renderPanel(); this.view.redraw(); return true; }
    const a = t.closest('[data-r3]');
    if (!a || a.tagName === 'INPUT') return false;
    if (a.dataset.r3 === 'del') { this.remove(); return true; }
    if (a.dataset.r3 === 'rot90') { this.rotate90(); return true; }
    if (a.dataset.r3 === 'edit-poles') {
      const s = this._selected();
      if (s && s.type === 'p') { RoadPlan._selRoad = s.road.id; RoadPlan._selPole = s.item.id; }
      RoadPlan.setView3d(false); RoadPlan.setStep(2);
      return true;
    }
    return false;
  },
  onChange(e) {
    const t = e.target;
    if (t.dataset.r3 === 'shadows') { this.rp.settings.shadows = t.checked; this._commit(); RoadPlan.recompute(0); return true; }
    const k = t.dataset.r3f;
    if (!k) return false;
    const s = this._selected();
    if (!s) return true;
    const it = s.item;
    if (k === 'name') it.name = t.value || it.name;
    else if (k === 'blocks') it.blocks = t.checked;
    else if (k === 'face') it.face = t.value === 'vertical' ? 'vertical' : 'up';
    else {
      const lim = { w: [0.05, 2000], d: [0.05, 2000], h: [0.05, 300], z: [0, 300], z0: [0, 300], z1: [0.1, 300], crownR: [0.1, 40], crownBase: [0, 100], opacity: [0, 1], target: [0, 1e5] }[k] || [-1e7, 1e7];
      it[k] = this._num(t.value, it[k] || 0, lim[0], lim[1]);
      if (k === 'z0' || k === 'z1') { if (it.z1 <= it.z0) it.z1 = it.z0 + 0.1; }
      if (it.kind === 'tree') it.crownBase = Math.min(it.crownBase, it.h - 0.1);
    }
    this._commit();
    return true;
  },
};
