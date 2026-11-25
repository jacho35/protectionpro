/* ProtectionPro — PlanSolar: the roofs a solar array may use, drawn or detected on the plan.
 *
 * A roof is `{id, name, points:[{x,y}] (world), shape:'gable'|'flat', pitch, tilt, azimuth, setback, use, source}`,
 * kept in `planMarkup.settings.solar.roofs` (saved with the project, in the undo snapshot).
 * They are made with the Detect roof tool (plan-roomdetect.js, target 'roof': Detect, or its Draw mode) or
 * by hand in the Solar PV Design modal, and listed there with their shape, pitch / tilt, azimuth and use flag.
 *
 * `arrays(roofs, ...)` turns the roofs into the engine's array list: the north plane of a gable (half the
 * footprint ÷ cos pitch after the setback) or the whole flat roof (packed at the ground cover ratio the
 * caller supplies). Pure geometry apart from `PlanEngine.factor()` (metres per world unit); node-testable.
 *
 * North: a roof's `azimuth` is a TRUE azimuth (° clockwise from true north) and goes to the engine as is. The plan is
 * drawn with north up unless `settings.solar.northAngle` says otherwise (° that true north lies clockwise of the
 * top of the plan), so geometry in the plan's frame uses `planAz(roof)` = azimuth + northAngle. `drawNorth` is the
 * north arrow on the plan; `draw` puts a slope arrow (down the facing plane, labelled with its true azimuth) on each roof.
 */
const PlanSolar = {
  SHAPES: ['gable', 'hip', 'mono', 'pyramid', 'wings', 'flat'],
  OBJECT_TYPES: {                                   // things standing on a roof: size in metres (h above the plane); they shade the modules
    vent: { label: 'Vent pipe', w: 0.11, d: 0.11, h: 0.9 },
    chimney: { label: 'Chimney', w: 0.6, d: 0.6, h: 1.2 },
    skylight: { label: 'Skylight', w: 1.0, d: 1.2, h: 0.15 },
    parapet: { label: 'Parapet', w: 3.0, d: 0.2, h: 0.5 },
    aircon: { label: 'Air-con unit', w: 1.0, d: 0.5, h: 0.8 },
  },

  _store() {
    const s = AppState.planMarkup && AppState.planMarkup.settings;
    if (!s) return null;
    if (!s.solar || typeof s.solar !== 'object') s.solar = {};
    if (!Array.isArray(s.solar.roofs)) s.solar.roofs = [];
    return s.solar;
  },
  roofs() { const st = this._store(); return st ? st.roofs : []; },

  // Angle of true north clockwise from the top of the plan, 0 ≤ a < 360 (0 = the plan is drawn north up).
  northAngle() {
    const st = this._store();
    const a = st ? +st.northAngle : 0;
    return Number.isFinite(a) ? ((a % 360) + 360) % 360 : 0;
  },
  setNorthAngle(a) {
    const st = this._store(); if (!st) return;
    st.northAngle = Number.isFinite(+a) ? ((Math.round(+a * 10) / 10 % 360) + 360) % 360 : 0;
    this._changed();
  },
  // The roof's facing direction as a bearing on the plan (° clockwise from the top of the plan), 0 ≤ a < 360.
  planAz(roof) { return ((((+roof.azimuth || 0) + this.northAngle()) % 360) + 360) % 360; },

  addRoof(points, source) {
    const st = this._store();
    const pts = points.map(p => ({ x: p.x, y: p.y }));
    const roof = { id: AppState.planGenId('pmrf'), name: PlanMarkup.nextCounter('_roof', 'Roof '), points: pts,
      shape: 'gable', pitch: 25, tilt: 15, azimuth: 0, setback: 0.5, eave: 3, apex: 1.8, overhang: 0, lean: null, objects: [], use: true, source: source || 'drawn' };
    st.roofs.push(roof);
    return roof;
  },
  removeRoof(id) {
    const st = this._store(); if (!st) return;
    st.roofs = st.roofs.filter(r => r.id !== id);
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },
  update(id, patch) {
    const r = this.roofs().find(x => x.id === id); if (!r) return;
    Object.assign(r, patch);
    if (typeof PlanMarkup !== 'undefined') PlanMarkup.markDirty();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  // The planes of a roof in metres (plan frame, see roof-planes.js), their use flags and the roof outline in metres.
  // null until the plan is calibrated.
  // Does the roof's area come from its planes (hip, mono, pyramid, cross-gable, or a gable with a lean-to)?
  usesPlanes(roof) { return ['hip', 'mono', 'pyramid', 'wings'].includes(roof.shape) || (roof.shape !== 'flat' && ((!!roof.lean && +roof.lean.depth > 0) || +roof.overhang > 0)); },
  planesOf(roof) {
    const f = PlanEngine.factor();
    if (!f || !roof.points || roof.points.length < 3) return null;
    const roofPoly = Roof3D.toMetres(roof.points, f);
    const m = RoofPlanes.model(roofPoly, roof, this.planAz(roof), this.northAngle());
    return { f, roofPoly, poly: m.foot, planes: m.planes, junctions: m.junctions, use: RoofPlanes.used(m.planes, roof) };
  },
  // Plan world point <-> the roof's metres (y flipped).
  toWorld(m, f) { return { x: m[0] / f, y: -m[1] / f }; },

  addObject(roof, type, at) {
    const t = this.OBJECT_TYPES[type]; if (!t) return null;
    const o = { id: AppState.planGenId('pmob'), type, x: at.x, y: at.y, w: t.w, d: t.d, h: t.h, rot: 0 };
    (roof.objects = roof.objects || []).push(o);
    this._changed();
    return o;
  },
  removeObject(roof, id) { roof.objects = (roof.objects || []).filter(o => o.id !== id); this._changed(); },
  updateObject(roof, id, patch) { const o = (roof.objects || []).find(x => x.id === id); if (o) { Object.assign(o, patch); this._changed(); } },
  // The objects as obstructions for the engine: height above the roof, distance and true bearing from the roof's middle.
  obstructions(roof) {
    const f = PlanEngine.factor(); if (!f || !(roof.objects || []).length) return [];
    const c = roof.points.reduce((a, p) => ({ x: a.x + p.x / roof.points.length, y: a.y + p.y / roof.points.length }), { x: 0, y: 0 });
    return roof.objects.map(o => {
      const dx = (o.x - c.x) * f, dy = -(o.y - c.y) * f;                       // metres east / north
      return { height_m: +o.h, distance_m: Math.max(0.5, Math.hypot(dx, dy)), bearing_deg: ((Math.atan2(dx, dy) * 180 / Math.PI - this.northAngle()) % 360 + 360) % 360, width_m: Math.max(+o.w, +o.d) };
    });
  },

  // Corners closer than this count as one line when a roof is cut into wings (0.2 % of the roof's size).
  _wingTol(roof) {
    const xs = roof.points.map(p => p.x), ys = roof.points.map(p => p.y);
    return Math.max(1e-6, 0.002 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  },
  // Cut an L / T / U (straight, axis-aligned edges) into its rectangular wings, each its own gable with the ridge along
  // the wing's long side; the roof is replaced by them and the objects go to the wing they stand in. Returns the wing
  // count, or 0 when the outline is not rectilinear or is already one rectangle.
  splitIntoWings(roof) {
    const st = this._store(); if (!st || !roof || !roof.points) return 0;
    const rects = RoofPlanes.splitRectilinear(roof.points.map(p => [p.x, p.y]), this._wingTol(roof));
    if (!rects || rects.length < 2) return 0;
    const north = this.northAngle(), wings = rects.map((r, i) => {
      const w = r[2] - r[0], h = r[3] - r[1], bearing = w >= h ? 0 : 90;       // facing across the ridge, which runs along the long side
      return Object.assign({}, roof, { id: AppState.planGenId('pmrf'), name: roof.name + ' · wing ' + (i + 1), array: roof.array,
        points: [{ x: r[0], y: r[1] }, { x: r[2], y: r[1] }, { x: r[2], y: r[3] }, { x: r[0], y: r[3] }],
        azimuth: ((bearing - north) % 360 + 360) % 360, planeUse: undefined, objects: [], source: roof.source });
    });
    for (const o of (roof.objects || [])) {
      const k = rects.findIndex(r => o.x >= r[0] && o.x <= r[2] && o.y >= r[1] && o.y <= r[3]);
      wings[k >= 0 ? k : 0].objects.push(o);
    }
    const at = st.roofs.indexOf(roof);
    st.roofs.splice(at, 1, ...wings);
    this._changed();
    return wings.length;
  },

  // Footprint and the part of it inside the edge setback, in m² (null until the plan is calibrated).
  footprintM2(roof) {
    const f = PlanEngine.factor();
    return f ? PlanEngine._polyArea(roof.points) * f * f : null;
  },
  usableFootprintM2(roof) {
    const f = PlanEngine.factor();
    if (!f) return null;
    const full = PlanEngine._polyArea(roof.points) * f * f;
    const sb = Math.max(0, +roof.setback || 0);
    if (!sb || typeof PlanRoomDetect === 'undefined') return full;
    const ins = PlanRoomDetect.insetPolygon(roof.points.map(p => [p.x, p.y]), sb / f);
    if (!ins || ins.length < 3) return 0;
    return PlanEngine._polyArea(ins.map(([x, y]) => ({ x, y }))) * f * f;
  },
  // Usable module area of a roof (m²): half the footprint over cos(pitch) for a gable's north plane, else the footprint.
  usableAreaM2(roof) {
    const a = this.usableFootprintM2(roof);
    if (a == null) return null;
    if (this.usesPlanes(roof)) return this._planeAreas(roof).reduce((n, q) => n + q.area, 0);
    return roof.shape === 'gable' ? a / 2 / Math.cos((+roof.pitch || 0) * Math.PI / 180) : a;
  },
  // The planes in use with their module area (m² along the slope) after the setback, a plane's pieces added: [{plane, area}].
  _planeAreas(roof) {
    const g = this.planesOf(roof); if (!g) return [];
    const sb = Math.max(0, +roof.setback || 0), out = [];
    for (const gr of RoofPlanes.groups(g.planes)) {
      if (!g.use[gr.idx[0]]) continue;
      const area = gr.idx.reduce((n, i) => n + RoofPlanes.usableArea(g.planes[i], g.poly, sb), 0);
      if (area > 0) out.push({ plane: g.planes[gr.idx[0]], area });
    }
    return out;
  },

  // The engine's array list for the roofs in use. `gcr` is the ground cover ratio for flat roofs.
  arrays(roofs, gcr, packing) {
    const out = [];
    for (const r of roofs) {
      if (r.use === false) continue;
      if (this.usesPlanes(r)) {                                           // one array per plane in use, each at its own pitch and azimuth
        for (const q of this._planeAreas(r)) out.push({ name: r.name + ' · ' + q.plane.name, area_m2: q.area, packing, tilt_deg: q.plane.pitch, azimuth_deg: q.plane.trueAz });
        continue;
      }
      const area = this.usableAreaM2(r);
      if (!area) continue;
      out.push(r.shape === 'gable'
        ? { name: r.name, area_m2: area, packing, tilt_deg: +r.pitch, azimuth_deg: +r.azimuth }
        : { name: r.name, area_m2: area, packing: gcr, tilt_deg: +r.tilt, azimuth_deg: +r.azimuth });
    }
    return out;
  },

  // ── Corner editing (the one gesture set of CLAUDE.md: drag a node, Shift-click an edge adds one,
  // Alt-click or double-click a node removes it (a roof keeps three corners), double-click an edge adds one,
  // drag a midpoint to add and move a corner). Always live with the Select tool; no selection needed. ──
  nodeAt(pt, zoom, px) {
    const tol = (px || 8) / zoom;
    for (const r of this.roofs()) for (let i = 0; i < (r.points || []).length; i++) if (Math.hypot(pt.x - r.points[i].x, pt.y - r.points[i].y) <= tol) return { roof: r, i };
    return null;
  },
  midAt(pt, zoom) {
    const tol = 7 / zoom;
    for (const r of this.roofs()) {
      const n = (r.points || []).length;
      for (let i = 0; i < n && n >= 3; i++) {
        const a = r.points[i], b = r.points[(i + 1) % n];
        if (Math.hypot(pt.x - (a.x + b.x) / 2, pt.y - (a.y + b.y) / 2) <= tol) return { roof: r, i, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      }
    }
    return null;
  },
  edgeAt(pt, zoom) {
    const tol = 8 / zoom;
    for (const r of this.roofs()) {
      const n = (r.points || []).length;
      for (let i = 0; i < n && n >= 3; i++) if (PlanEngine._distToSeg(pt, r.points[i], r.points[(i + 1) % n]) <= tol) return { roof: r, i };
    }
    return null;
  },
  insertNode(roof, i, p) {
    roof.points.splice(i + 1, 0, { x: p.x, y: p.y });
    this._changed();
  },
  removeNodeAt(pt, zoom) {
    const h = this.nodeAt(pt, zoom, 9);
    if (!h || h.roof.points.length <= 3) return false;
    h.roof.points.splice(h.i, 1);
    this._changed();
    return true;
  },
  addNodeAtEdge(pt, zoom) {
    const h = this.edgeAt(pt, zoom);
    if (!h) return false;
    this.insertNode(h.roof, h.i, pt);
    return true;
  },
  _changed() {
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },
  _handles(ctx, r, u) {
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c2410c'; ctx.lineWidth = 1.4 * u;
    const n = r.points.length;
    for (let i = 0; i < n; i++) {
      const p = r.points[i], q = r.points[(i + 1) % n];
      ctx.beginPath(); ctx.rect(p.x - 4 * u, p.y - 4 * u, 8 * u, 8 * u); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc((p.x + q.x) / 2, (p.y + q.y) / 2, 3 * u, 0, 6.2832); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },

  // An arrow down the facing plane (a gable: one on each plane) with the plane's true azimuth beside it.
  _slopeArrows(ctx, r, u) {
    const g = r.shape === 'flat' ? null : this.planesOf(r);
    if (g) return this._planeArrows(ctx, r, g, u);
    const b = this.planAz(r) * Math.PI / 180, d = { x: Math.sin(b), y: -Math.cos(b) };   // plan y runs down
    const pts = r.points, n = pts.length;
    const c = pts.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
    const ss = pts.map(p => (p.x - c.x) * d.x + (p.y - c.y) * d.y), q = (Math.max(...ss) - Math.min(...ss)) / 4;
    const list = r.shape === 'gable'
      ? [{ at: { x: c.x + d.x * q, y: c.y + d.y * q }, dir: d, az: +r.azimuth || 0 }, { at: { x: c.x - d.x * q, y: c.y - d.y * q }, dir: { x: -d.x, y: -d.y }, az: ((+r.azimuth || 0) + 180) % 360 }]
      : [{ at: c, dir: d, az: +r.azimuth || 0 }];
    const L = 26 * u;
    ctx.save();
    ctx.strokeStyle = '#1d4ed8'; ctx.fillStyle = '#1d4ed8'; ctx.lineWidth = 2 * u; ctx.lineCap = 'round';
    ctx.font = `600 ${11 * u}px sans-serif`; ctx.textAlign = 'center';
    for (const a of list) {
      const x0 = a.at.x - a.dir.x * L / 2, y0 = a.at.y - a.dir.y * L / 2, x1 = a.at.x + a.dir.x * L / 2, y1 = a.at.y + a.dir.y * L / 2;
      const nx = -a.dir.y, ny = a.dir.x, h = 6 * u;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1 + a.dir.x * 2 * u, y1 + a.dir.y * 2 * u);
      ctx.lineTo(x1 - a.dir.x * h + nx * h * 0.6, y1 - a.dir.y * h + ny * h * 0.6);
      ctx.lineTo(x1 - a.dir.x * h - nx * h * 0.6, y1 - a.dir.y * h - ny * h * 0.6); ctx.closePath(); ctx.fill();
      ctx.fillText(Math.round(a.az) + '°', a.at.x + nx * 14 * u, a.at.y + ny * 14 * u + 4 * u);
    }
    ctx.restore();
  },

  // Planes from RoofPlanes: each plane's outline (ridges, hips and valleys show as the lines between them), an arrow down it
  // (blue when it carries modules, grey when not) and its true azimuth; then the objects standing on the roof.
  _planeArrows(ctx, r, g, u) {
    const f = g.f, L = 24 * u;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const arrowed = new Set();
    g.planes.forEach((pl, i) => {
      ctx.beginPath();
      pl.poly.forEach((m, k) => { const w = this.toWorld(m, f); k ? ctx.lineTo(w.x, w.y) : ctx.moveTo(w.x, w.y); });
      ctx.closePath(); ctx.strokeStyle = 'rgba(194,65,12,0.75)'; ctx.lineWidth = 1 * u; ctx.stroke();
      if (arrowed.has(pl.name)) return;                                       // one arrow per plane, on its largest piece
      arrowed.add(pl.name);
      const big = g.planes.filter(q => q.name === pl.name).sort((a, b) => Math.abs(RoofPlanes._area(b.poly)) - Math.abs(RoofPlanes._area(a.poly)))[0];
      const cm = big.poly.reduce((a, q) => [a[0] + q[0] / big.poly.length, a[1] + q[1] / big.poly.length], [0, 0]);
      const c = this.toWorld(cm, f), b = pl.az * Math.PI / 180, d = { x: Math.sin(b), y: -Math.cos(b) };
      const col = g.use[i] ? '#1d4ed8' : '#9ca3af';
      const x0 = c.x - d.x * L / 2, y0 = c.y - d.y * L / 2, x1 = c.x + d.x * L / 2, y1 = c.y + d.y * L / 2, nx = -d.y, ny = d.x, h = 6 * u;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1 + d.x * 2 * u, y1 + d.y * 2 * u); ctx.lineTo(x1 - d.x * h + nx * h * 0.6, y1 - d.y * h + ny * h * 0.6); ctx.lineTo(x1 - d.x * h - nx * h * 0.6, y1 - d.y * h - ny * h * 0.6); ctx.closePath(); ctx.fill();
      ctx.font = `600 ${11 * u}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(Math.round(pl.trueAz) + '°', c.x + nx * 14 * u, c.y + ny * 14 * u + 4 * u);
    });
    for (const o of (r.objects || [])) {
      const a = (+o.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hw = o.w / 2 / f, hd = o.d / 2 / f;
      ctx.beginPath();
      [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].forEach(([x, y], k) => { const px = o.x + x * ca - y * sa, py = o.y + x * sa + y * ca; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath(); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.5 * u; ctx.stroke();
    }
    ctx.restore();
  },

  // The north arrow, in screen pixels (call after the world transform is restored): top-right of the plan,
  // pointing to true north, with the angle when the plan is not drawn north up. Drawn once a roof exists.
  drawNorth(ctx, cssW) {
    if (!this.roofs().length && !this.northAngle()) return;
    const a = this.northAngle(), r = a * Math.PI / 180, cx = cssW - 44, cy = 52;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.2832); ctx.fill(); ctx.stroke();
    ctx.rotate(r);
    ctx.fillStyle = '#111827';
    ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill();
    ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', 0, -20);
    ctx.restore();
    if (a) { ctx.save(); ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#374151'; ctx.fillText('N +' + a + '°', cx, cy + 40); ctx.restore(); }
  },

  // Canvas overlay: each roof as an amber outline with its name, shape and usable area.
  draw(ctx, zoom) {
    const roofs = this.roofs();
    if (!roofs.length) return;
    const u = 1 / zoom;
    for (const r of roofs) {
      if (!r.points || r.points.length < 3) continue;
      ctx.save();
      ctx.beginPath();
      r.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = r.use === false ? 'rgba(107,114,128,0.10)' : 'rgba(217,130,43,0.16)';
      ctx.fill();
      ctx.strokeStyle = r.use === false ? '#6b7280' : '#c2410c';
      ctx.lineWidth = 1.6 * u;
      ctx.setLineDash([7 * u, 4 * u]);
      ctx.stroke();
      ctx.setLineDash([]);
      const c = r.points.reduce((a, p) => ({ x: a.x + p.x / r.points.length, y: a.y + p.y / r.points.length }), { x: 0, y: 0 });
      const a = this.usableAreaM2(r);
      ctx.fillStyle = '#7c2d12';
      ctx.font = `${12 * u}px sans-serif`;
      ctx.textAlign = 'center';
      if (typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'select') this._handles(ctx, r, u);
      this._slopeArrows(ctx, r, u);
      ctx.fillStyle = '#7c2d12'; ctx.textAlign = 'center'; ctx.font = `${12 * u}px sans-serif`;
      ctx.fillText(`${r.name} · ${r.shape === 'flat' ? 'flat, ' + r.tilt + '° racks' : r.shape + ' ' + r.pitch + '°'}${a != null ? ' · ' + a.toFixed(0) + ' m²' : ''}`, c.x, c.y);
      ctx.restore();
    }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSolar;
