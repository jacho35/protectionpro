/* ProtectionPro — Lighting tab › 3D: one room in 3D, rotatable, with objects.
 *
 * The room is its plan outline extruded to the ceiling. What can be added:
 *   • objects — desks, shelving, partitions, columns, boxes. Stored on the
 *     room as room.scene.objects [{ id, kind, name, x, y (plan px, the centre),
 *     w, d, h, z (lifted, m), rot (°, counter-clockwise), rho, blocks, task }].
 *     A blocking object casts shadows and takes part in the interreflection
 *     (backend analysis/room_lighting.py); `task` puts a calculation surface
 *     on its top.
 *   • luminaires — the plan's own light fittings (bd_light etc.): adding one
 *     here places a fitting on the plan, moving it here moves it there.
 *   • windows and doors — room.scene.openings [{ id, kind, name, edge (index of
 *     the outline edge), off (m from its first corner), w, h, sill, rho, tau }].
 *     They take their reflectance in the interreflection (no daylight; τ is
 *     kept for a later daylight calculation).
 *   • calculation surfaces — room.scene.surfaces [{ id, name, x, y (px), w, d,
 *     z, rot, face: 'up' | 'vertical', h, target }].
 * Show: Model, False colour (the work-plane grid on the floor, the surfaces'
 * own grids) or Rendered light (every patch of the calculation drawn as bright
 * as it looks: its illuminance × reflectance). Calculate room runs RoomCalc
 * for this room; anything changed afterwards reads Out of date.
 */

const L3_KIND = {
  desk:      { label: 'Desk',      w: 1.6, d: 0.8, h: 0.03, z: 0.72, color: '#c9a27a', rho: 0.45, icon: 'M3 9h18M5 9v10M19 9v10M3 9l2-3h14l2 3' },
  shelf:     { label: 'Shelving',  w: 2.0, d: 0.4, h: 2.0,  z: 0,    color: '#8a8f98', rho: 0.4,  icon: 'M5 3h14v18H5zM5 9h14M5 15h14' },
  partition: { label: 'Partition', w: 2.0, d: 0.06, h: 1.5, z: 0,    color: '#7fa6c2', rho: 0.5,  icon: 'M10 4h4v16h-4zM6 20h12' },
  column:    { label: 'Column',    w: 0.4, d: 0.4, h: 0,    z: 0,    color: '#b8bcc4', rho: 0.6,  icon: 'M8 3h8v18H8zM6 3h12M6 21h12' },
  box:       { label: 'Box',       w: 1.0, d: 1.0, h: 1.0,  z: 0,    color: '#a3a8b0', rho: 0.5,  icon: 'M12 3l8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10' },
};
const L3_OTHER = {
  lum:    { label: 'Luminaire',    icon: 'M4 6h16v3H4zM7 9l-3 9M17 9l3 9M12 9v10' },
  window: { label: 'Window',       w: 1.8, h: 1.4, sill: 0.9, rho: 0.1, tau: 0.7, icon: 'M4 4h16v16H4zM12 4v16M4 12h16' },
  door:   { label: 'Door',         w: 0.9, h: 2.1, sill: 0,   rho: 0.4, icon: 'M6 3h12v18H6zM15 12h.01M3 21h18' },
  calc:   { label: 'Calc surface', w: 1.2, d: 0.8, icon: 'M3 8l9-4 9 4-9 4zM7 10v6M12 12v6M17 10v6' },
};

const Light3D = {
  _built: false,
  _active: false,
  roomId: null,
  mode: 'model',          // model | colour | render
  walls: 'cut',           // cut | all | none
  cones: false,
  expo: 1.5,
  sel: null,              // 'o:<id>' object · 'w:<id>' opening · 's:<id>' surface · 'l:<element id>' luminaire
  view: null,
  _seq: 1,

  // ─── Geometry ──────────────────────────────────────────────────────────
  f() { return PlanEngine.factor(); },
  rooms() {
    return (AppState.planMarkup.rooms || []).filter(r => r.points && r.points.length >= 3 && (!r.kind || r.kind === 'room'));
  },
  room() {
    const list = this.rooms();
    let r = list.find(x => x.id === this.roomId);
    if (!r) {
      r = list.find(x => PlanMarkup.selectedIds && PlanMarkup.selectedIds.has(x.id)) || list[0] || null;
      this.roomId = r ? r.id : null;
    }
    return r;
  },
  // Plan px ↔ metres (y up).
  M(p, f) { return [p.x * f, -p.y * f]; },
  px(x, y, f) { return { x: x / f, y: -y / f }; },

  geo(room) {
    const f = this.f();
    const L = RoomLighting.read(room);
    const P = room.points.map(p => this.M(p, f));
    let a = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
    const ccw = a > 0;
    const edges = P.map((p, i) => {
      const q = P[(i + 1) % P.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1e-9;
      const dir = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      const nIn = ccw ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
      return { i, a: p, b: q, len, dir, nIn };
    });
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    return { f, L, P, edges, H: L.ceilH, wp: L.workH, xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys), area: Math.abs(a) / 2 };
  },
  _inside(G, x, y) {
    let ins = false;
    const P = G.P;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if (((P[i][1] > y) !== (P[j][1] > y)) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) ins = !ins;
    }
    return ins;
  },
  // A point well inside the outline (an L-shaped room's centroid may not be).
  _interior(G) {
    let best = null, bd = -1;
    for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
      const x = G.xmin + (G.xmax - G.xmin) * i / 12, y = G.ymin + (G.ymax - G.ymin) * j / 12;
      if (!this._inside(G, x, y)) continue;
      let d = Infinity;
      for (const e of G.edges) {
        const t = Math.max(0, Math.min(e.len, (x - e.a[0]) * e.dir[0] + (y - e.a[1]) * e.dir[1]));
        d = Math.min(d, Math.hypot(x - e.a[0] - e.dir[0] * t, y - e.a[1] - e.dir[1] * t));
      }
      if (d > bd) { bd = d; best = [x, y]; }
    }
    return best || [(G.xmin + G.xmax) / 2, (G.ymin + G.ymax) / 2];
  },

  scene(room) {
    const s = room.scene && typeof room.scene === 'object' ? room.scene : (room.scene = {});
    if (!Array.isArray(s.objects)) s.objects = [];
    if (!Array.isArray(s.openings)) s.openings = [];
    if (!Array.isArray(s.surfaces)) s.surfaces = [];
    return s;
  },
  _num(v, d, lo = -Infinity, hi = Infinity) { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; },
  _gen(prefix) { return prefix + '_' + Date.now().toString(36) + (this._seq++); },

  // Object height: a column with no height of its own runs to the ceiling.
  _objH(o, G) { return o.kind === 'column' && !(o.h > 0) ? Math.max(0.05, G.H - (o.z || 0)) : Math.max(0.01, +o.h || 0.01); },

  // Light fittings of the room (the plan's own elements).
  lums(room) {
    const pm = AppState.planMarkup;
    return (pm.elements || []).filter(el => {
      const def = PLAN_DEFS.element(el.type);
      return def && def.group === 'Lighting' && PlanEngine._pointInPoly({ x: el.x, y: el.y }, room.points);
    });
  },
  _lumZ(el, G) {
    const pr = el.props || {};
    return pr.mount === 'suspended' ? Math.max(0.3, G.H - (Number(pr.drop) || 0)) : G.H;
  },
  _lumSize(el) {
    const ph = PhotoLib.get(el.props && el.props.photoId);
    const a = ph && +ph.luminousM2;
    const s = a > 0 ? Math.sqrt(a) : 0.6;
    return Math.max(0.15, Math.min(1.2, s));
  },

  // ─── Request parts (RoomCalc.buildRoom) ────────────────────────────────
  requestParts(room, f) {
    const s = room.scene;
    if (!s) return null;
    const G = this.geo(room);
    const out = {};
    const obs = (s.objects || []).filter(o => o.blocks !== false).map(o => {
      const c = this.M(o, f);
      return { id: o.id, cx: +c[0].toFixed(3), cy: +c[1].toFixed(3), w: +o.w, d: +o.d, rot: +o.rot || 0, z0: +o.z || 0, h: +this._objH(o, G).toFixed(3), rho: +o.rho };
    });
    if (obs.length) out.obstacles = obs;
    const ops = (s.openings || []).map(o => {
      const e = G.edges[o.edge];
      if (!e) return null;
      const off = Math.max(0, Math.min(e.len - o.w, +o.off || 0));
      const a = [e.a[0] + e.dir[0] * off, e.a[1] + e.dir[1] * off], b = [a[0] + e.dir[0] * o.w, a[1] + e.dir[1] * o.w];
      return { id: o.id, kind: o.kind, a: a.map(v => +v.toFixed(3)), b: b.map(v => +v.toFixed(3)), sill: +o.sill || 0, h: +o.h, rho: +o.rho };
    }).filter(Boolean);
    if (ops.length) out.openings = ops;
    const surfs = this._surfaces(room, G).map(x => ({ id: x.id, name: x.name, cx: +x.c[0].toFixed(3), cy: +x.c[1].toFixed(3), w: x.w, d: x.d, rot: x.rot, z: +x.z.toFixed(3), h: x.h, face: x.face, target: x.target || undefined }));
    if (surfs.length) out.surfaces = surfs;
    return Object.keys(out).length ? out : null;
  },
  // Calculation surfaces, the drawn ones and those on top of objects.
  _surfaces(room, G) {
    const s = this.scene(room), f = G.f;
    const out = s.surfaces.map(o => ({ id: o.id, name: o.name, c: this.M(o, f), w: +o.w, d: +o.d, rot: +o.rot || 0, z: +o.z, h: +o.h || 0, face: o.face === 'vertical' ? 'vertical' : 'up', target: +o.target || 0, src: o }));
    for (const o of s.objects) {
      if (!o.task) continue;
      out.push({ id: 'top:' + o.id, name: (o.name || 'Object') + ' top', c: this.M(o, f), w: Math.max(0.05, o.w - 0.04), d: Math.max(0.05, o.d - 0.04), rot: +o.rot || 0,
        z: (+o.z || 0) + this._objH(o, G) + 0.005, h: 0, face: 'up', target: +o.target || G.L.em, src: o, onTop: true });
    }
    return out;
  },

  // ─── Mount / lifecycle ─────────────────────────────────────────────────
  mount(host) {
    if (this._built || !host) return;
    this._built = true;
    host.innerHTML = `<div class="l3-wrap">
        <aside class="l3-pal" id="l3-pal" aria-label="Add to the room"></aside>
        <section class="l3-view" id="l3-view" aria-label="3D view">
          <div class="l3-title" id="l3-title"></div>
          <div class="l3-cam" role="group" aria-label="Camera">
            <button type="button" data-l3-cam="left" aria-label="Turn left 45°" title="Turn left 45°">⟲</button>
            <button type="button" data-l3-cam="top">Top</button>
            <button type="button" data-l3-cam="right" aria-label="Turn right 45°" title="Turn right 45°">⟳</button>
            <button type="button" data-l3-cam="front">Front</button>
            <button type="button" data-l3-cam="iso">3D</button>
            <button type="button" data-l3-cam="side">Side</button>
            <button type="button" data-l3-cam="out" aria-label="Zoom out">−</button>
            <button type="button" data-l3-cam="fit" title="Fit the room">Fit</button>
            <button type="button" data-l3-cam="in" aria-label="Zoom in">+</button>
            <label class="l3-cam-wide">Walls <select data-l3="walls"><option value="cut">Cutaway</option><option value="all">All</option><option value="none">Off</option></select></label>
            <label class="l3-cam-wide l3-cam-check"><input type="checkbox" data-l3="cones"> Light cones</label>
          </div>
          <div class="l3-legend" id="l3-legend" hidden></div>
          <div class="l3-hint">Drag empty space to orbit · right-drag or Shift-drag to pan · scroll to zoom · drag an object to move it</div>
          <div class="l3-empty" id="l3-empty" hidden></div>
        </section>
        <aside class="l3-props" id="l3-props" aria-label="Selected object"></aside>
      </div>
      <div class="l3-res" id="l3-res"></div>`;
    const view = host.querySelector('#l3-view');
    this.view = new View3D(view, { label: 'Rotatable 3D view of the room. Drag empty space to orbit, drag an object to move it.' });
    this.view.onDraw = (v) => this._draw(v);
    this.view.onPick = (id, e) => this._pick(id, e);
    this.view.onClick = (id) => { if (id == null) { this.sel = null; this.renderSide(); this.view.redraw(); } };
    this.view.canvas.addEventListener('keydown', (e) => this._key(e));
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => this._onChange(e));
    host.addEventListener('input', (e) => {
      if (e.target.dataset.l3 === 'expo') { this.expo = this._num(e.target.value, 1, 0.2, 4); this.view.redraw(); }
    });
  },

  activate(host) {
    this.mount(host);
    this._active = true;
    const r = this.room();
    if (r && r.id !== this._fitted) this.fit();
    this.render();
  },
  deactivate() { this._active = false; },

  // Room picked on the plan → the same room here.
  focusRoom(id) {
    if (id) this.roomId = id;
    this.sel = null;
    this._fitted = null;
  },

  fit() {
    const r = this.room();
    if (!r || !this.f() || !this.view) return;
    const G = this.geo(r);
    this.view.fit([G.xmin, G.ymin, 0], [G.xmax, G.ymax, G.H]);
    this._fitted = r.id;
  },

  render() {
    if (!this._built) return;
    this.renderSide();
    if (this.view) this.view.redraw();
  },
  renderSide() {
    this._renderPalette(); this._renderProps(); this._renderRes(); this._renderTitle(); this._renderLegend();
    const w = document.querySelector('#l3-view [data-l3="walls"]'), c = document.querySelector('#l3-view [data-l3="cones"]');
    if (w) w.value = this.walls;
    if (c) c.checked = this.cones;
  },

  // The Lighting tab's bar in the 3D view.
  barHtml() {
    const rooms = this.rooms(), cur = this.room();
    const seg = (key, val, label) => `<button type="button" class="plan-mode-btn${this[key] === val ? ' active' : ''}" data-l3-set="${key}:${val}" aria-pressed="${this[key] === val}">${label}</button>`;
    return `<label class="plan-tb-field">Room <select data-l3="room" class="plan-tb-select">${rooms.length ? rooms.map(r =>
        `<option value="${escHtml(r.id)}"${cur && r.id === cur.id ? ' selected' : ''}>${escHtml(r.name || 'Room')}</option>`).join('') : '<option value="">No rooms on this floor</option>'}</select></label>
      <div class="plan-tb-field">Show <div class="plan-modes" role="group" aria-label="Show">${seg('mode', 'model', 'Model')}${seg('mode', 'colour', 'False colour')}${seg('mode', 'render', 'Rendered light')}</div></div>
      <button class="plan-tb-btn plan-icon-btn" data-lw-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${PlanMarkup._icon('undo')}</button>
      <button class="plan-tb-btn plan-icon-btn" data-lw-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${PlanMarkup._icon('redo')}</button>`;
  },

  // ─── Results ───────────────────────────────────────────────────────────
  _result(room) {
    RoomCalc._sync();
    const r = RoomCalc.results[room.id];
    if (!r) return { r: null, fresh: false };
    let fresh = false;
    try { fresh = r.sig === RoomCalc.signature(room); } catch (_) { fresh = false; }
    return { r, fresh };
  },

  async calc() {
    const room = this.room();
    if (!room) { UI.toast('Pick a room first.', 'info'); return; }
    this._wantPatches = true;
    try { await RoomCalc.run([room]); } finally { this._wantPatches = false; }
    this.render();
    if (typeof LightingWS !== 'undefined') LightingWS._renderBar();
  },

  // ─── Drawing ───────────────────────────────────────────────────────────
  _draw(v) {
    const room = this.room();
    const empty = document.getElementById('l3-empty');
    const f = this.f();
    let msg = '';
    if (!f) msg = 'Calibrate the plan first (Plan tab › Scale) — the 3D view needs real distances.';
    else if (!room) msg = 'No room on this floor yet. In the Plan view, use Detect room or draw a room, then come back.';
    if (empty) { empty.hidden = !msg; empty.textContent = msg; }
    if (msg) { v.bg = null; return; }
    const G = this.geo(room), sc = this.scene(room);
    const { r: rr, fresh } = this._result(room);
    const res = rr ? rr.res : null;
    const rendered = this.mode === 'render' && res && res.patches;
    const colour = this.mode === 'colour' && res;
    v.bg = rendered ? '#15171c' : null;
    const selStroke = '#0078d7';
    const expo = this.expo;

    // floor (rendered: the patches over a base in the floor's mean tone, which shows
    // where a patch under an object dropped out)
    if (rendered) {
      v.face({ pts: G.P.map(p => [p[0], p[1], 0]), fill: V3D.tone(res.floor ? res.floor.Em : 0, G.L.rhoF, '#d6c7ab', expo), layer: 0, bias: -2e6 });
      this._patches(v, res.patches, 0, rr, G);
    } else {
      v.face({ pts: G.P.map(p => [p[0], p[1], 0]), fill: '#dfe2e6', stroke: '#9aa1ab', lw: 1, layer: 0, bias: -1e6 });
      if (colour && res.grid) this._floorGrid(v, G, res, fresh);
    }
    // walls + openings
    for (const e of G.edges) {
      const n = [e.nIn[0], e.nIn[1], 0];
      const show = this.walls !== 'none' && v.facing(n);
      const quad = [[e.a[0], e.a[1], 0], [e.b[0], e.b[1], 0], [e.b[0], e.b[1], G.H], [e.a[0], e.a[1], G.H]];
      if (show && !rendered) v.face({ pts: quad, fill: V3D.shade('#eef0f3', 0.86 + 0.12 * Math.abs(e.dir[0])), stroke: '#b9bec6', lw: 1, layer: 0.5 });
      if (show && rendered) v.face({ pts: quad, fill: V3D.tone(res.walls ? res.walls.Em : 0, G.L.rhoW, '#f4f0e8', expo), layer: 0.5, bias: -1e5 });
      if (!show && this.walls === 'all') v.face({ pts: quad, fill: 'rgba(238,240,243,.22)', stroke: '#9aa1ab', lw: 1, layer: 2.5 });
      for (const o of sc.openings.filter(x => x.edge === e.i)) {
        const q = this._openQuad(o, e, 0.01);
        if (!q) continue;
        const on = this.sel === 'w:' + o.id;
        if (show) {
          const fill = o.kind === 'window' ? (rendered ? '#22344a' : 'rgba(140,200,240,.8)') : (rendered ? V3D.tone(res.walls ? res.walls.Em : 0, o.rho, '#b08a60', expo) : '#b08a60');
          v.face({ pts: q, fill, stroke: on ? selStroke : '#6b7280', lw: on ? 2.5 : 1, layer: 0.7, pick: 'w:' + o.id });
          if (o.kind === 'window') {
            const mid = (q[0][0] + q[1][0]) / 2, midy = (q[0][1] + q[1][1]) / 2;
            v.line({ pts: [[mid, midy, q[0][2]], [mid, midy, q[2][2]]], stroke: rendered ? '#4a6584' : '#ffffff', lw: 1.5, layer: 0.8 });
          }
        } else {
          v.line({ pts: q.concat([q[0]]), stroke: on ? selStroke : (o.kind === 'window' ? '#2f7fc1' : '#8a5a2b'), lw: on ? 2.5 : 1.5, dash: [4, 3], layer: 2, pick: 'w:' + o.id });
        }
      }
    }
    if (rendered) this._patches(v, res.patches, 2, rr, G);
    // room edges
    v.line({ pts: G.P.concat([G.P[0]]).map(p => [p[0], p[1], 0]), stroke: rendered ? '#3a3f48' : '#6b7280', lw: 1.2, layer: 0.6 });
    if (!rendered) v.line({ pts: G.P.concat([G.P[0]]).map(p => [p[0], p[1], G.H]), stroke: '#8a919b', lw: 1, dash: [5, 4], layer: 2 });

    // objects
    if (rendered) this._patches(v, res.patches, 3, rr, G);
    for (const o of sc.objects) {
      const on = this.sel === 'o:' + o.id;
      const ghost = o.blocks === false;
      if (rendered && !ghost && !on) continue;
      const k = L3_KIND[o.kind] || L3_KIND.box;
      const c = this.M(o, f), h = this._objH(o, G), z0 = +o.z || 0;
      V3D.box(v, c, o.w, o.d, z0, h, o.rot || 0, {
        color: k.color, pick: 'o:' + o.id, stroke: on ? selStroke : 'rgba(26,26,46,.35)', lw: on ? 2 : 0.8,
        alpha: ghost ? 0.45 : (rendered ? 0 : 1), dash: ghost ? [4, 3] : null, outline: rendered && on,
      });
      if (o.kind === 'desk' && z0 > 0.2 && !rendered) this._legs(v, c, o, z0);
    }
    // luminaires
    for (const el of this.lums(room)) {
      const c = this.M(el, f), z = this._lumZ(el, G), s = this._lumSize(el), on = this.sel === 'l:' + el.id;
      const k = el.props && el.props.kind;
      const emerg = k === 'emergency' || k === 'exit';
      V3D.box(v, c, s, s, z - 0.05, 0.05, -(el.rotation || 0), {
        color: rendered ? '#fffdf4' : (emerg ? '#d6f5d6' : '#e4e6ea'), under: rendered ? '#fffdf4' : (emerg ? '#a8e6a8' : '#fff6cf'), pick: 'l:' + el.id,
        stroke: on ? selStroke : 'rgba(26,26,46,.45)', lw: on ? 2 : 0.8, noCull: true,
      });
      if (z < G.H - 0.01 && !rendered) v.line({ pts: [[c[0], c[1], z], [c[0], c[1], G.H]], stroke: '#8a919b', lw: 1, layer: 1 });
      if (rendered) {
        v.glow({ at: [c[0], c[1], z - 0.06], r: s * 1.6, color: 'rgba(255,248,226,.55)' });
        v.glow({ at: [c[0], c[1], z - 0.06], r: s * 0.8, color: 'rgba(255,253,240,.9)' });
      }
      if (this.cones) this._cone(v, el, c, z, G);
    }
    // calculation surfaces
    for (const s of this._surfaces(room, G)) {
      const on = this.sel === 's:' + s.id || (s.onTop && this.sel === 'o:' + s.src.id);
      const sr = res && res.surfaces ? res.surfaces.find(x => x.id === s.id) : null;
      const q = this._surfQuad(s);
      if (colour && sr && sr.values) this._surfGrid(v, s, sr, fresh);
      else if (!rendered) v.face({ pts: q, fill: 'rgba(0,120,215,.28)', layer: 1, bias: 0.3, pick: s.onTop ? 'o:' + s.src.id : 's:' + s.id });
      v.line({ pts: q.concat([q[0]]), stroke: on ? selStroke : (rendered ? '#9fc6ee' : '#1a1a2e'), lw: on ? 2.5 : 1.2, dash: [5, 3], layer: 2, pick: s.onTop ? 'o:' + s.src.id : 's:' + s.id });
      if (sr && (colour || rendered || on)) {
        const top = Math.max(...q.map(p => p[2]));
        v.label({ at: [s.c[0], s.c[1], top], text: `${Math.round(sr.Em)} lx${fresh ? '' : ' (old)'}`, color: sr.pass === false ? '#a61b1b' : '#1a1a2e', size: 11, bold: true, dy: -2 });
      }
    }
    // selection label
    const sl = this._selLabel(room, G);
    if (sl) v.label(Object.assign({ color: '#005fa3', size: 12, dy: -10 }, sl));
  },

  _legs(v, c, o, z0) {
    const a = (o.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const hw = o.w / 2 - 0.05, hd = o.d / 2 - 0.05;
    for (const [u, w2] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
      const x = c[0] + u * ca - w2 * sa, y = c[1] + u * sa + w2 * ca;
      v.line({ pts: [[x, y, 0], [x, y, z0]], stroke: '#7b6550', lw: 2, layer: 1, alpha: o.blocks === false ? 0.45 : 1 });
    }
  },
  _openQuad(o, e, inset) {
    if (!e) return null;
    const w = Math.min(+o.w || 0, e.len), off = Math.max(0, Math.min(e.len - w, +o.off || 0));
    const ox = e.a[0] + e.nIn[0] * inset, oy = e.a[1] + e.nIn[1] * inset;
    const z0 = +o.sill || 0, z1 = z0 + (+o.h || 0);
    const A = [ox + e.dir[0] * off, oy + e.dir[1] * off], B = [ox + e.dir[0] * (off + w), oy + e.dir[1] * (off + w)];
    return [[A[0], A[1], z0], [B[0], B[1], z0], [B[0], B[1], z1], [A[0], A[1], z1]];
  },
  _surfQuad(s) {
    const a = s.rot * Math.PI / 180, ex = [Math.cos(a), Math.sin(a)];
    if (s.face === 'vertical') {
      const A = [s.c[0] - ex[0] * s.w / 2, s.c[1] - ex[1] * s.w / 2], B = [s.c[0] + ex[0] * s.w / 2, s.c[1] + ex[1] * s.w / 2];
      return [[A[0], A[1], s.z], [B[0], B[1], s.z], [B[0], B[1], s.z + s.h], [A[0], A[1], s.z + s.h]];
    }
    const ey = [-ex[1], ex[0]];
    const P = (u, w2) => [s.c[0] + ex[0] * u + ey[0] * w2, s.c[1] + ex[1] * u + ey[1] * w2, s.z];
    return [P(-s.w / 2, -s.d / 2), P(s.w / 2, -s.d / 2), P(s.w / 2, s.d / 2), P(-s.w / 2, s.d / 2)];
  },
  _surfGrid(v, s, sr, fresh) {
    const a = s.rot * Math.PI / 180, ex = [Math.cos(a), Math.sin(a), 0];
    const vert = s.face === 'vertical';
    const ev = vert ? [0, 0, 1] : [-ex[1], ex[0], 0];
    const lu = s.w, lv = vert ? s.h : s.d;
    const org = vert ? [s.c[0] - ex[0] * lu / 2, s.c[1] - ex[1] * lu / 2, s.z] : [s.c[0] - ex[0] * lu / 2 - ev[0] * lv / 2, s.c[1] - ex[1] * lu / 2 - ev[1] * lv / 2, s.z];
    const top = Math.max(sr.Emax || 0, 1);
    const du = lu / sr.nu, dv = lv / sr.nv;
    for (let j = 0; j < sr.nv; j++) for (let i = 0; i < sr.nu; i++) {
      const val = sr.values[j * sr.nu + i];
      if (val == null) continue;
      const P = (uu, vv) => [org[0] + ex[0] * uu + ev[0] * vv, org[1] + ex[1] * uu + ev[1] * vv, org[2] + ex[2] * uu + ev[2] * vv];
      v.face({ pts: [P(i * du, j * dv), P((i + 1) * du, j * dv), P((i + 1) * du, (j + 1) * dv), P(i * du, (j + 1) * dv)],
        fill: RoomCalc._color(val / top), alpha: fresh ? 0.95 : 0.45, layer: 1, bias: 0.3, pick: s.onTop ? 'o:' + s.src.id : 's:' + s.id });
    }
  },
  _floorGrid(v, G, res, fresh) {
    const g = res.grid, top = Math.max((res.workplane || {}).Emax || 0, 1);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const val = g.values[j * g.nx + i];
      if (val == null) continue;
      const x0 = g.x0 + i * g.dx, y0 = g.y0 + j * g.dy;
      v.face({ pts: [[x0, y0, 0.002], [x0 + g.dx, y0, 0.002], [x0 + g.dx, y0 + g.dy, 0.002], [x0, y0 + g.dy, 0.002]],
        fill: RoomCalc._color(val / top), alpha: fresh ? 0.92 : 0.4, layer: 0, bias: -1e5 });
    }
  },
  // Rendered light: patches of one kind (0 floor, 2 walls, 3 objects).
  _patches(v, P, kind, rr, G) {
    const sc = this.scene(this.room());
    const ids = rr.obsIds || [];
    const byIdx = ids.map(id => sc.objects.find(x => x.id === id) || null);
    const base = { 0: '#d6c7ab', 2: '#f4f0e8' };
    if (kind === 2 && this.walls === 'none') return;
    for (let i = 0; i < P.E.length; i++) {
      if (P.kind[i] !== kind) continue;
      const c = P.c[i], u = P.u[i], w = P.v[i];
      let n = null, col = base[kind];
      if (kind === 2 || kind === 3) {
        const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const L = Math.hypot(x[0], x[1], x[2]) || 1;
        n = [x[0] / L, x[1] / L, x[2] / L];
        // u × v can point either way: walls face into the room, object faces away from their object
        let flip;
        if (kind === 2) flip = !this._inside(G, c[0] + n[0] * 0.05, c[1] + n[1] * 0.05);
        else {
          const o = byIdx[P.src[i]];
          if (o) {
            col = (L3_KIND[o.kind] || L3_KIND.box).color;
            const oc = this.M(o, G.f), oz = (+o.z || 0) + this._objH(o, G) / 2;
            flip = (c[0] - oc[0]) * n[0] + (c[1] - oc[1]) * n[1] + (c[2] - oz) * n[2] < 0;
          } else { col = '#a3a8b0'; flip = false; }
        }
        if (flip) n = [-n[0], -n[1], -n[2]];
      }
      const fill = V3D.tone(P.E[i], P.rho[i], col, this.expo);
      v.face({ pts: [[c[0] - u[0] - w[0], c[1] - u[1] - w[1], c[2] - u[2] - w[2]], [c[0] + u[0] - w[0], c[1] + u[1] - w[1], c[2] + u[2] - w[2]],
        [c[0] + u[0] + w[0], c[1] + u[1] + w[1], c[2] + u[2] + w[2]], [c[0] - u[0] + w[0], c[1] - u[1] + w[1], c[2] - u[2] + w[2]]],
        fill, cull: n, layer: kind === 0 ? 0 : (kind === 2 ? 0.5 : 1), bias: kind === 0 ? -1e6 : 0 });
    }
  },
  _cone(v, el, c, z, G) {
    const ph = PhotoLib.get(el.props && el.props.photoId);
    let half = 40;
    try {
      const row = ph.cd[0], gs = ph.g, mx = Math.max(...row);
      for (let i = 0; i < gs.length; i++) if (row[i] < 0.5 * mx) { half = gs[i]; break; }
    } catch (_) { /* no web: 40° */ }
    const r = Math.max(0.05, (z - G.wp) * Math.tan(Math.min(80, half) * Math.PI / 180));
    const ring = [];
    for (let a = 0; a < 24; a++) ring.push([c[0] + r * Math.cos(a * Math.PI / 12), c[1] + r * Math.sin(a * Math.PI / 12), G.wp]);
    v.face({ pts: ring, fill: 'rgba(255,214,90,.16)', stroke: 'rgba(214,150,20,.55)', lw: 1, layer: 2 });
    for (const a of [0, 6, 12, 18]) v.line({ pts: [[c[0], c[1], z], ring[a]], stroke: 'rgba(214,150,20,.45)', lw: 1, layer: 2 });
  },
  _selLabel(room, G) {
    const s = this._selected(room);
    if (!s) return null;
    const f = G.f;
    if (s.type === 'o') {
      const o = s.item, c = this.M(o, f), h = this._objH(o, G);
      return { at: [c[0], c[1], (+o.z || 0) + h + 0.3], text: `${o.name} · ${(+o.w).toFixed(2)} × ${(+o.d).toFixed(2)} × ${h.toFixed(2)} m` };
    }
    if (s.type === 'l') { const c = this.M(s.item, f); return { at: [c[0], c[1], this._lumZ(s.item, G) + 0.2], text: s.item.name || 'Luminaire' }; }
    if (s.type === 's') { const q = this._surfQuad(this._surfaces(room, G).find(x => x.id === s.item.id)); return { at: [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, Math.max(...q.map(p => p[2])) + 0.3], text: s.item.name }; }
    if (s.type === 'w') { const q = this._openQuad(s.item, G.edges[s.item.edge], 0.01); return q ? { at: [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2, q[2][2] + 0.2], text: s.item.name } : null; }
    return null;
  },

  // ─── Selection / editing ───────────────────────────────────────────────
  _selected(room) {
    if (!this.sel || !room) return null;
    const [t, id] = [this.sel.slice(0, 1), this.sel.slice(2)];
    const sc = this.scene(room);
    const item = t === 'o' ? sc.objects.find(x => x.id === id) : t === 'w' ? sc.openings.find(x => x.id === id)
      : t === 's' ? sc.surfaces.find(x => x.id === id) : t === 'l' ? (AppState.planMarkup.elements || []).find(x => x.id === id) : null;
    return item ? { type: t, item } : null;
  },

  _commit(opts = {}) {
    PlanMarkup.markDirty();
    PlanMarkup.snapshot();
    if (opts.plan) PlanEngine.requestDraw({ all: true });
    this.renderSide();
    this.view.redraw();
  },

  _pick(id, e) {
    const room = this.room();
    if (!room) return null;
    this.sel = id;
    const s = this._selected(room);
    this.renderSide();
    this.view.redraw();
    if (!s) return null;
    const G = this.geo(room), f = G.f, v = this.view;
    const [sx, sy] = v._pos(e);
    const snap = (x) => Math.round(x * 20) / 20;
    if (s.type === 'w') {
      const e0 = G.edges[s.item.edge], off0 = +s.item.off || 0;
      if (!e0) return null;
      return {
        move: (ev, x, y, dx, dy) => {
          const d = v.slideAlong(dx, dy, e0.dir);
          s.item.off = Math.max(0, Math.min(e0.len - s.item.w, snap(off0 + d)));
          this.view.redraw();
        },
        up: (ev, moved) => { if (moved) this._commit(); },
      };
    }
    const z = s.type === 'o' ? (+s.item.z || 0) : s.type === 'l' ? this._lumZ(s.item, G) : (+s.item.z || 0);
    const start = v.planeAt(sx, sy, z);
    const c0 = this.M(s.item, f);
    return {
      move: (ev) => {
        const [x, y] = v._pos(ev);
        const p = v.planeAt(x, y, z);
        const nx = snap(c0[0] + p[0] - start[0]), ny = snap(c0[1] + p[1] - start[1]);
        if (!this._inside(G, nx, ny)) return;
        const q = this.px(nx, ny, f);
        s.item.x = q.x; s.item.y = q.y;
        if (s.type === 'l') PlanEngine.requestDraw({ fg: true });
        this.view.redraw();
      },
      up: (ev, moved) => { if (moved) this._commit({ plan: true }); },
    };
  },

  _key(e) {
    const room = this.room();
    const s = this._selected(room);
    if (e.key === 'Escape') { this.sel = null; this.renderSide(); this.view.redraw(); e.stopPropagation(); return; }
    if (!s) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.remove(); }
    else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) { e.stopPropagation(); this.rotate90(); }
    else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); this.duplicate(); }
  },

  add(kind) {
    const room = this.room();
    const f = this.f();
    if (!room || !f) { UI.toast(f ? 'Pick a room first.' : 'Calibrate the plan first.', 'info'); return; }
    const G = this.geo(room), sc = this.scene(room);
    const [cx, cy] = this._interior(G);
    const at = this.px(cx, cy, f);
    const count = (list, k) => list.filter(x => x.kind === k).length + 1;
    if (L3_KIND[kind]) {
      const k = L3_KIND[kind];
      const o = { id: this._gen('obj'), kind, name: `${k.label} ${count(sc.objects, kind)}`, x: at.x, y: at.y, w: k.w, d: k.d,
        h: kind === 'column' ? 0 : k.h, z: k.z, rot: 0, rho: k.rho, blocks: true, task: false };
      sc.objects.push(o); this.sel = 'o:' + o.id;
    } else if (kind === 'window' || kind === 'door') {
      const D = L3_OTHER[kind];
      const v = this.view, cand = G.edges.filter(e => e.len >= 0.5 && v.facing([e.nIn[0], e.nIn[1], 0]));
      const e = (cand.length ? cand : G.edges).slice().sort((a, b) => b.len - a.len)[0];
      const w = Math.min(D.w, e.len - 0.1);
      const o = { id: this._gen('open'), kind, name: `${D.label} ${count(sc.openings, kind)}`, edge: e.i, off: +((e.len - w) / 2).toFixed(2), w: +w.toFixed(2),
        h: Math.min(D.h, G.H - D.sill - 0.05), sill: D.sill, rho: D.rho };
      if (kind === 'window') o.tau = D.tau;
      sc.openings.push(o); this.sel = 'w:' + o.id;
    } else if (kind === 'calc') {
      const D = L3_OTHER.calc;
      const o = { id: this._gen('surf'), name: `Calc surface ${sc.surfaces.length + 1}`, x: at.x, y: at.y, w: D.w, d: D.d, z: G.wp, rot: 0, face: 'up', h: 1.0, target: G.L.em };
      sc.surfaces.push(o); this.sel = 's:' + o.id;
    } else if (kind === 'lum') {
      const libs = PhotoLib.list();
      if (!libs.length) { UI.toast('Add a luminaire to the Luminaire library first (button in the bar).', 'info', 6000); return; }
      const last = this.lums(room).map(el => el.props && el.props.photoId).filter(id => PhotoLib.get(id)).pop();
      const ph = PhotoLib.get(last) || libs[0];
      const base = PLAN_DEFS.defaults('bd_light');
      const el = { id: AppState.planGenId('pmel'), type: 'bd_light', x: at.x, y: at.y, rotation: 0, name: PlanMarkup.nextName('bd_light'), reticId: null,
        props: Object.assign({}, base, { photoId: ph.id, watts: Math.round(ph.watts || base.watts || 0), lumens: '', mount: 'recessed', fluxPct: 100 }) };
      AppState.planMarkup.elements.push(el);
      this.sel = 'l:' + el.id;
    }
    this._commit({ plan: true });
  },

  remove() {
    const room = this.room(), s = this._selected(room);
    if (!s) return;
    const sc = this.scene(room);
    if (s.type === 'o') sc.objects = sc.objects.filter(x => x !== s.item);
    else if (s.type === 'w') sc.openings = sc.openings.filter(x => x !== s.item);
    else if (s.type === 's') sc.surfaces = sc.surfaces.filter(x => x !== s.item);
    else if (s.type === 'l') { PlanMarkup.selectedIds.clear(); PlanMarkup.selectedIds.add(s.item.id); PlanMarkup.deleteSelected(); }
    this.sel = null;
    this._commit({ plan: true });
  },
  duplicate() {
    const room = this.room(), s = this._selected(room);
    if (!s || s.type === 'l') return;
    const sc = this.scene(room), f = this.f();
    const c = JSON.parse(JSON.stringify(s.item));
    c.id = this._gen(s.type === 'o' ? 'obj' : s.type === 'w' ? 'open' : 'surf');
    c.name = (s.item.name || '') + ' copy';
    if (s.type === 'w') c.off = (+c.off || 0) + (+c.w || 0) + 0.2;
    else {
      const G = this.geo(room), m = this.M(c, f);
      const step = Math.max(+c.d || 0.5, 0.3) + 0.2;
      const a = (+c.rot || 0) * Math.PI / 180;
      const nx = m[0] - Math.sin(a) * step, ny = m[1] + Math.cos(a) * step;
      if (this._inside(G, nx, ny)) Object.assign(c, this.px(nx, ny, f));
    }
    (s.type === 'o' ? sc.objects : s.type === 'w' ? sc.openings : sc.surfaces).push(c);
    this.sel = s.type + ':' + c.id;
    this._commit();
  },
  rotate90() {
    const room = this.room(), s = this._selected(room);
    if (!s || s.type === 'w') return;
    if (s.type === 'l') s.item.rotation = ((s.item.rotation || 0) + 90) % 360;
    else s.item.rot = (((+s.item.rot || 0) + 90) % 360);
    this._commit({ plan: s.type === 'l' });
  },

  // ─── Panels ────────────────────────────────────────────────────────────
  _renderTitle() {
    const el = document.getElementById('l3-title');
    if (!el) return;
    const room = this.room();
    if (!room || !this.f()) { el.hidden = true; return; }
    const G = this.geo(room);
    el.hidden = false;
    el.innerHTML = `<b>${escHtml(room.name || 'Room')}</b><span>${(G.xmax - G.xmin).toFixed(2)} × ${(G.ymax - G.ymin).toFixed(2)} m · ${G.area.toFixed(1)} m² · ceiling ${G.H.toFixed(2)} m · work plane ${G.wp.toFixed(2)} m</span>`;
  },

  _renderPalette() {
    const el = document.getElementById('l3-pal');
    if (!el) return;
    const room = this.room();
    const btn = (k, D) => `<button type="button" class="l3-pal-btn" data-l3-add="${k}"${room && this.f() ? '' : ' disabled'}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${D.icon}"/></svg><span>${D.label}</span></button>`;
    let list = '';
    if (room && this.f()) {
      const sc = this.scene(room);
      const row = (id, name, kind, dot) => `<button type="button" class="l3-row${this.sel === id ? ' active' : ''}" data-l3-sel="${escHtml(id)}"><i style="background:${dot}"></i><span>${escHtml(name || '')}</span><small>${kind}</small></button>`;
      list = sc.objects.map(o => row('o:' + o.id, o.name, (L3_KIND[o.kind] || L3_KIND.box).label, (L3_KIND[o.kind] || L3_KIND.box).color)).join('')
        + this.lums(room).map(e => row('l:' + e.id, e.name || 'Luminaire', 'Luminaire', '#f5d76e')).join('')
        + sc.openings.map(o => row('w:' + o.id, o.name, o.kind === 'window' ? 'Window' : 'Door', o.kind === 'window' ? '#8cc8f0' : '#b08a60')).join('')
        + sc.surfaces.map(o => row('s:' + o.id, o.name, 'Calc surface', '#0078d7')).join('');
    }
    el.innerHTML = `<div class="l3-pal-head">Add to the room</div>
      <div class="l3-pal-note">Click to drop it in the room, then drag it into place.</div>
      <div class="l3-pal-sub">Objects</div>
      <div class="l3-pal-grid">${Object.entries(L3_KIND).map(([k, D]) => btn(k, D)).join('')}</div>
      <div class="l3-pal-sub">Light, openings, results</div>
      <div class="l3-pal-grid">${Object.entries(L3_OTHER).map(([k, D]) => btn(k, D)).join('')}</div>
      <div class="l3-pal-head l3-pal-list-head">In this room</div>
      <div class="l3-list">${list || '<div class="l3-pal-note">Nothing yet.</div>'}</div>`;
  },

  _renderProps() {
    const el = document.getElementById('l3-props');
    if (!el) return;
    const room = this.room();
    if (!room || !this.f()) { el.innerHTML = ''; return; }
    const G = this.geo(room), f = G.f, L = G.L;
    const s = this._selected(room);
    const num = (key, label, val, step, extra = '') => `<label class="l3-field"><span>${label}</span><input type="number" data-l3f="${key}" value="${val}" step="${step}" ${extra}></label>`;
    const fx = (v) => (+v).toFixed(2);
    const counts = (() => {
      const sc = this.scene(room);
      return `${sc.objects.filter(o => o.blocks !== false).length} block light · ${sc.openings.length} openings · ${this._surfaces(room, G).length} calc surfaces`;
    })();
    const foot = `<div class="l3-props-foot"><span>Objects in the calculation</span><b>${counts}</b></div>`;
    if (!s) {
      const T = L.task === 'custom' ? 'Custom targets' : ((ROOM_TASKS[L.task] || {}).name || '');
      el.innerHTML = `<div class="l3-props-body">
        <div class="l3-props-title">${escHtml(room.name || 'Room')}</div>
        <p class="l3-muted">Nothing selected. Click an object in the view or the list to edit it.</p>
        <p class="l3-muted">${escHtml(T)} · ${L.em} lx · U₀ ≥ ${L.uo.toFixed(2)} · UGR ≤ ${L.ugr}</p>
        <div class="l3-grid2">
          <label class="l3-field"><span>Ceiling, m</span><input type="number" data-l3r="ceilH" value="${L.ceilH}" step="0.1" min="1.5"></label>
          <label class="l3-field"><span>Work plane, m</span><input type="number" data-l3r="workH" value="${L.workH}" step="0.05" min="0"></label>
          <label class="l3-field"><span>ρ walls</span><input type="number" data-l3r="rhoW" value="${L.rhoW}" step="0.05" min="0" max="1"></label>
          <label class="l3-field"><span>ρ floor</span><input type="number" data-l3r="rhoF" value="${L.rhoF}" step="0.05" min="0" max="1"></label>
        </div>
        <p class="l3-muted">The task, targets and the rest of the room's lighting settings are in its properties on the Plan view.</p>
      </div>${foot}`;
      return;
    }
    const head = (name, kind, dot, canDup) => `<div class="l3-props-head"><i style="background:${dot}"></i><div><b>${escHtml(name || '')}</b><small>${kind}</small></div>
      ${canDup ? '<button type="button" class="l3-icon" data-l3="dup" aria-label="Duplicate" title="Duplicate (Ctrl+D)">⧉</button>' : ''}
      <button type="button" class="l3-icon l3-del" data-l3="del" aria-label="Delete" title="Delete">✕</button></div>`;
    const it = s.item;
    let body = '';
    if (s.type === 'o') {
      const k = L3_KIND[it.kind] || L3_KIND.box;
      const c = this.M(it, f);
      body = head(it.name, k.label, k.color, true) + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Name</span><input type="text" data-l3f="name" value="${escHtml(it.name || '')}"></label>
        <div class="l3-grid2">
          ${num('x', 'X, m', fx(c[0] - G.xmin), 0.05)}${num('y', 'Y, m', fx(c[1] - G.ymin), 0.05)}
          ${num('w', 'Width, m', fx(it.w), 0.05, 'min="0.02"')}${num('d', 'Depth, m', fx(it.d), 0.05, 'min="0.02"')}
          ${num('h', 'Height, m', it.kind === 'column' && !(it.h > 0) ? '' : fx(it.h), 0.05, `min="0.01"${it.kind === 'column' ? ' placeholder="to ceiling"' : ''}`)}${num('z', 'Lifted, m', fx(it.z || 0), 0.05, 'min="0"')}
          ${num('rot', 'Rotation, °', Math.round(it.rot || 0), 15)}${num('rho', 'Reflectance ρ', (+it.rho).toFixed(2), 0.05, 'min="0" max="0.95"')}
        </div>
        <label class="l3-check"><input type="checkbox" data-l3f="blocks"${it.blocks !== false ? ' checked' : ''}> Blocks light (shadows and interreflection)</label>
        <label class="l3-check"><input type="checkbox" data-l3f="task"${it.task ? ' checked' : ''}> Calculation surface on its top</label>
        ${it.task ? num('target', 'Target on top, lx', +it.target || L.em, 50, 'min="0"') : ''}
        <button type="button" class="plan-tb-btn" data-l3="rot90">Rotate 90° (R)</button>
      </div>`;
    } else if (s.type === 'l') {
      const pr = it.props || {}, c = this.M(it, f);
      const libs = PhotoLib.list();
      body = head(it.name || 'Luminaire', 'Luminaire', '#f5d76e', false) + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Luminaire</span><select data-l3l="photoId">${libs.map(p => `<option value="${escHtml(p.id)}"${p.id === pr.photoId ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`).join('') || '<option value="">Add one in the Luminaire library</option>'}${pr.photoId && !PhotoLib.get(pr.photoId) ? '<option selected value="">(none picked)</option>' : ''}</select></label>
        <div class="l3-grid2">
          ${num('x', 'X, m', fx(c[0] - G.xmin), 0.05)}${num('y', 'Y, m', fx(c[1] - G.ymin), 0.05)}
          <label class="l3-field"><span>Mount</span><select data-l3l="mount">${['recessed', 'surface', 'suspended'].map(m => `<option value="${m}"${(pr.mount || 'recessed') === m ? ' selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></label>
          ${pr.mount === 'suspended' ? `<label class="l3-field"><span>Drop, m</span><input type="number" data-l3l="drop" value="${Number(pr.drop) || 0}" step="0.05" min="0"></label>` : '<span></span>'}
          <label class="l3-field"><span>Rotation, °</span><input type="number" data-l3l="rotation" value="${Math.round(it.rotation || 0)}" step="15"></label>
          <label class="l3-field"><span>Output, %</span><input type="number" data-l3l="fluxPct" value="${pr.fluxPct !== '' && Number.isFinite(+pr.fluxPct) ? +pr.fluxPct : 100}" step="5" min="0" max="200"></label>
        </div>
        <label class="l3-check"><input type="checkbox" data-l3="cones"${this.cones ? ' checked' : ''}> Show light cones</label>
        <p class="l3-muted">This is the plan's own fitting: moving it here moves it on the plan.</p>
      </div>`;
    } else if (s.type === 'w') {
      const e = G.edges[it.edge];
      const side = (ed) => { const o = [-ed.nIn[0], -ed.nIn[1]]; return Math.abs(o[0]) > Math.abs(o[1]) ? (o[0] > 0 ? 'east' : 'west') : (o[1] > 0 ? 'north' : 'south'); };
      body = head(it.name, it.kind === 'window' ? 'Window' : 'Door', it.kind === 'window' ? '#8cc8f0' : '#b08a60', true) + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Name</span><input type="text" data-l3f="name" value="${escHtml(it.name || '')}"></label>
        <label class="l3-field l3-wide"><span>Wall</span><select data-l3f="edge">${G.edges.map(ed => `<option value="${ed.i}"${ed.i === it.edge ? ' selected' : ''}>Wall ${ed.i + 1} · ${ed.len.toFixed(2)} m · ${side(ed)} side</option>`).join('')}</select></label>
        <div class="l3-grid2">
          ${num('off', 'From corner, m', fx(it.off || 0), 0.05, 'min="0"')}${num('w', 'Width, m', fx(it.w), 0.05, 'min="0.2"')}
          ${num('h', 'Height, m', fx(it.h), 0.05, 'min="0.2"')}${num('sill', 'Sill, m', fx(it.sill || 0), 0.05, 'min="0"')}
          ${num('rho', it.kind === 'window' ? 'Reflectance ρ (night)' : 'Reflectance ρ', (+it.rho).toFixed(2), 0.05, 'min="0" max="0.95"')}
          ${it.kind === 'window' ? num('tau', 'Light transmittance τ', (+it.tau || 0.7).toFixed(2), 0.05, 'min="0" max="1"') : ''}
        </div>
        <p class="l3-muted">An opening replaces that piece of wall in the interreflection with its own reflectance. There is no daylight in the calculation; τ is kept for when there is.${e ? '' : ' <b>This wall no longer exists — pick another.</b>'}</p>
      </div>`;
    } else if (s.type === 's') {
      const c = this.M(it, f);
      const { r: rr, fresh } = this._result(room);
      const sr = rr && rr.res.surfaces ? rr.res.surfaces.find(x => x.id === it.id) : null;
      const vert = it.face === 'vertical';
      body = head(it.name, 'Calc surface', '#0078d7', true) + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Name</span><input type="text" data-l3f="name" value="${escHtml(it.name || '')}"></label>
        <div class="l3-grid2">
          ${num('x', 'X, m', fx(c[0] - G.xmin), 0.05)}${num('y', 'Y, m', fx(c[1] - G.ymin), 0.05)}
          ${num('w', 'Width, m', fx(it.w), 0.05, 'min="0.1"')}${vert ? num('h', 'Height, m', fx(it.h || 1), 0.05, 'min="0.1"') : num('d', 'Depth, m', fx(it.d), 0.05, 'min="0.1"')}
          ${num('z', vert ? 'From, m' : 'Height, m', fx(it.z), 0.05, 'min="0"')}${num('rot', 'Rotation, °', Math.round(it.rot || 0), 15)}
          <label class="l3-field"><span>Faces</span><select data-l3f="face"><option value="up"${vert ? '' : ' selected'}>Up (horizontal)</option><option value="vertical"${vert ? ' selected' : ''}>Sideways (vertical)</option></select></label>
          ${num('target', 'Target, lx', +it.target || 0, 50, 'min="0"')}
        </div>
        ${sr ? `<div class="l3-chips"><span>Ē ${Math.round(sr.Em)} lx</span><span>Emin ${Math.round(sr.Emin)} lx</span><span>U₀ ${(+sr.U0).toFixed(2)}</span>${sr.pass != null ? `<span class="${sr.pass ? 'ok' : 'bad'}">${sr.pass ? 'Pass' : 'Fail'}</span>` : ''}${fresh ? '' : '<span class="warn">out of date</span>'}</div>` : '<p class="l3-muted">Calculate the room to get its result.</p>'}
        ${vert ? '<p class="l3-muted">A vertical surface faces the left of its width (rotate it to turn it round).</p>' : ''}
      </div>`;
    }
    el.innerHTML = body + foot;
  },

  _renderRes() {
    const el = document.getElementById('l3-res');
    if (!el) return;
    const room = this.room();
    if (!room || !this.f()) { el.innerHTML = ''; return; }
    const L = RoomLighting.read(room);
    const { r: rr, fresh } = this._result(room);
    const chip = (t, cls) => `<span class="l3-chip${cls ? ' ' + cls : ''}">${t}</span>`;
    if (!rr) { el.innerHTML = `<b>Work plane</b>${chip('Not calculated — press Calculate room')}`; return; }
    const res = rr.res, wp = res.workplane || {};
    const verdict = res.pass === true ? chip('Pass', 'ok') : res.pass === false ? chip('Fail', 'bad') : chip(res.luminaires ? '—' : 'No fittings');
    el.innerHTML = `<b>Work plane</b>${chip(`Ē ${Math.round(wp.Em || 0)} lx <small>/ ${L.em}</small>`)}${chip(`Emin ${Math.round(wp.Emin || 0)} lx`)}${chip(`U₀ ${(+wp.U0 || 0).toFixed(2)} <small>/ ${L.uo.toFixed(2)}</small>`)}
      ${res.ugr ? chip(`UGR ${(+res.ugr.max).toFixed(1)} <small>/ ${L.ugr}</small>`) : ''}${verdict}
      <span class="l3-spacer"></span>
      ${fresh ? chip('Calculated with every object in the room', 'ok') : chip('Out of date — the room, its objects or fittings changed since the last calculation', 'warn')}`;
  },

  _renderLegend() {
    const el = document.getElementById('l3-legend');
    if (!el) return;
    const room = this.room();
    const { r: rr, fresh } = room ? this._result(room) : {};
    if (!room || !this.f() || this.mode === 'model') { el.hidden = true; return; }
    el.hidden = false;
    if (!rr) { el.innerHTML = `<b>${this.mode === 'render' ? 'Rendered light' : 'False colour'}</b><span>Calculate the room to see it.</span>`; return; }
    if (this.mode === 'colour') {
      const top = Math.max((rr.res.workplane || {}).Emax || 0, 1);
      const fmt = (v) => v >= 100 ? Math.round(v) : v.toFixed(1);
      el.innerHTML = `<b>Work plane illuminance, lx</b><div class="plan-legend-bar" aria-hidden="true"></div>
        <div class="plan-legend-scale"><span>0</span><span>${fmt(top / 2)}</span><span>${fmt(top)}</span></div>
        <span>Drawn on the floor; calculation surfaces on their own scale.${fresh ? '' : ' Out of date.'}</span>`;
    } else if (!rr.res.patches) {
      el.innerHTML = '<b>Rendered light</b><span>Calculate the room in this view to render it.</span>';
    } else {
      el.innerHTML = `<b>Rendered light</b><span>Every surface as bright as it looks — its illuminance × reflectance from the calculation, with the shadows of objects that block light. No daylight: windows are dark.${fresh ? '' : ' <b>Out of date</b> — showing the last calculation.'}</span>
        <label class="l3-expo">Exposure <input type="range" min="0.2" max="4" step="0.1" value="${this.expo}" data-l3="expo"></label>`;
    }
  },

  // ─── Events ────────────────────────────────────────────────────────────
  _onClick(e) {
    const t = e.target;
    const add = t.closest('[data-l3-add]');
    if (add) { this.add(add.dataset.l3Add); return; }
    const sel = t.closest('[data-l3-sel]');
    if (sel) { this.sel = sel.dataset.l3Sel; this.renderSide(); this.view.redraw(); return; }
    const cam = t.closest('[data-l3-cam]');
    if (cam) {
      const v = this.view, k = cam.dataset.l3Cam;
      if (k === 'left') v.rotate(-45); else if (k === 'right') v.rotate(45);
      else if (k === 'top') v.setView(0, 89.5); else if (k === 'front') v.setView(0, 12);
      else if (k === 'side') v.setView(-90, 12); else if (k === 'iso') v.setView(-32, 36);
      else if (k === 'in') v.zoomBy(1.25); else if (k === 'out') v.zoomBy(0.8); else if (k === 'fit') this.fit();
      return;
    }
    const a = t.closest('[data-l3]');
    if (!a || a.tagName === 'SELECT' || a.tagName === 'INPUT' && a.type !== 'checkbox') return;
    const act = a.dataset.l3;
    if (act === 'dup') this.duplicate();
    else if (act === 'del') this.remove();
    else if (act === 'rot90') this.rotate90();

  },

  // The bar (LightingWS) passes its clicks and changes here too.
  onBar(e) {
    const s = e.target.closest('[data-l3-set]');
    if (s) {
      const [k, v] = s.dataset.l3Set.split(':');
      this[k] = v;
      if (k === 'mode' && v === 'render') {
        const room = this.room(), { r } = room ? this._result(room) : {};
        if (room && (!r || !r.res.patches)) UI.toast('Calculate room to render the light in it.', 'info');
      }
      this.render(); LightingWS._renderBar();
      return true;
    }
    const calc = e.target.closest('[data-l3="calc"]');
    if (calc) { this.calc(); return true; }
    return false;
  },
  onBarChange(e) {
    if (e.target.dataset.l3 === 'room') { this.roomId = e.target.value; this.sel = null; this.fit(); this.render(); return true; }
    return false;
  },

  _onChange(e) {
    const t = e.target;
    const room = this.room();
    if (!room) return;
    if (t.dataset.l3 === 'cones') { this.cones = t.checked; this.render(); return; }
    if (t.dataset.l3 === 'walls') { this.walls = t.value; this.view.redraw(); return; }
    if (t.dataset.l3r) { RoomLighting.set(room, t.dataset.l3r, t.value); this._commit(); return; }
    const s = this._selected(room);
    if (!s) return;
    const G = this.geo(room), f = G.f, it = s.item;
    if (t.dataset.l3l) {
      const k = t.dataset.l3l;
      it.props = it.props || {};
      if (k === 'rotation') it.rotation = this._num(t.value, 0);
      else if (k === 'photoId') {
        it.props.photoId = t.value;
        const ph = PhotoLib.get(t.value);
        if (ph) it.props.watts = Math.round(ph.watts || it.props.watts || 0);
      } else if (k === 'mount') it.props.mount = t.value;
      else if (k === 'drop') it.props.drop = this._num(t.value, 0, 0, G.H - 0.3);
      else if (k === 'fluxPct') it.props.fluxPct = this._num(t.value, 100, 0, 200);
      this._commit({ plan: true });
      return;
    }
    const k = t.dataset.l3f;
    if (!k) return;
    if (k === 'name') it.name = t.value;
    else if (k === 'blocks') it.blocks = t.checked;
    else if (k === 'task') { it.task = t.checked; if (it.task && !(+it.target > 0)) it.target = G.L.em; }
    else if (k === 'face') it.face = t.value === 'vertical' ? 'vertical' : 'up';
    else if (k === 'edge') { it.edge = +t.value; const e2 = G.edges[it.edge]; if (e2) { it.w = Math.min(it.w, e2.len); it.off = Math.max(0, Math.min(e2.len - it.w, it.off || 0)); } }
    else if (k === 'x' || k === 'y') {
      const c = this.M(it, f);
      const nx = k === 'x' ? this._num(t.value, c[0] - G.xmin) + G.xmin : c[0];
      const ny = k === 'y' ? this._num(t.value, c[1] - G.ymin) + G.ymin : c[1];
      if (!this._inside(G, nx, ny)) { UI.toast('That is outside the room.', 'warn'); this._renderProps(); return; }
      Object.assign(it, this.px(nx, ny, f));
    } else {
      const lim = { w: [0.02, 100], d: [0.02, 100], h: [0, 40], z: [0, 40], rot: [-360, 360], rho: [0, 0.95], tau: [0, 1], off: [0, 1000], sill: [0, 40], target: [0, 100000] }[k] || [-1e9, 1e9];
      if (k === 'h' && it.kind === 'column' && t.value === '') it.h = 0;
      else it[k] = this._num(t.value, it[k] || 0, lim[0], lim[1]);
      if (s.type === 'w') {
        const e2 = G.edges[it.edge];
        if (e2) { it.w = Math.min(Math.max(0.2, it.w), e2.len); it.off = Math.max(0, Math.min(e2.len - it.w, it.off)); }
        it.sill = Math.min(it.sill, G.H - 0.2); it.h = Math.max(0.2, Math.min(G.H - it.sill, it.h));
      }
    }
    this._commit();
  },

  // ─── The 2D plan (Lighting tab): object footprints, openings, surfaces ──
  drawPlan(ctx, zoom) {
    const f = this.f();
    if (!f) return;
    ctx.save();
    ctx.lineWidth = 1.2 / zoom;
    for (const room of this.rooms()) {
      if (!room.scene) continue;
      const sc = this.scene(room);
      const G = this.geo(room);
      const toPx = (p) => [p[0] / f, -p[1] / f];
      const poly = (pts, stroke, fill, dash) => {
        ctx.beginPath(); pts.forEach((p, i) => { const q = toPx(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        ctx.setLineDash(dash ? dash.map(d => d / zoom) : []); ctx.strokeStyle = stroke; ctx.stroke();
      };
      for (const o of sc.objects) {
        const c = this.M(o, f), a = (+o.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hw = o.w / 2, hd = o.d / 2;
        const P = (u, v) => [c[0] + u * ca - v * sa, c[1] + u * sa + v * ca];
        poly([P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)], 'rgba(60,64,72,.85)', 'rgba(140,146,156,.22)', o.blocks === false ? [4, 3] : null);
      }
      for (const s of this._surfaces(room, G)) if (s.face === 'up') poly(this._surfQuad(s), 'rgba(0,120,215,.9)', null, [5, 3]);
      ctx.setLineDash([]);
      for (const o of sc.openings) {
        const q = this._openQuad(o, G.edges[o.edge], 0);
        if (!q) continue;
        const a = toPx(q[0]), b = toPx(q[1]);
        ctx.lineWidth = 4 / zoom; ctx.strokeStyle = o.kind === 'window' ? '#2f7fc1' : '#8a5a2b';
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.lineWidth = 1.2 / zoom;
      }
    }
    ctx.restore();
  },
};
