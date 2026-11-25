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
 */
const PlanSolar = {
  SHAPES: ['gable', 'flat'],

  _store() {
    const s = AppState.planMarkup && AppState.planMarkup.settings;
    if (!s) return null;
    if (!s.solar || typeof s.solar !== 'object') s.solar = {};
    if (!Array.isArray(s.solar.roofs)) s.solar.roofs = [];
    return s.solar;
  },
  roofs() { const st = this._store(); return st ? st.roofs : []; },

  addRoof(points, source) {
    const st = this._store();
    const pts = points.map(p => ({ x: p.x, y: p.y }));
    const roof = { id: AppState.planGenId('pmrf'), name: PlanMarkup.nextCounter('_roof', 'Roof '), points: pts,
      shape: 'gable', pitch: 25, tilt: 15, azimuth: 0, setback: 0.5, use: true, source: source || 'drawn' };
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
    return roof.shape === 'gable' ? a / 2 / Math.cos((+roof.pitch || 0) * Math.PI / 180) : a;
  },

  // The engine's array list for the roofs in use. `gcr` is the ground cover ratio for flat roofs.
  arrays(roofs, gcr, packing) {
    const out = [];
    for (const r of roofs) {
      if (r.use === false) continue;
      const area = this.usableAreaM2(r);
      if (!area) continue;
      out.push(r.shape === 'gable'
        ? { name: r.name, area_m2: area, packing, tilt_deg: +r.pitch, azimuth_deg: +r.azimuth }
        : { name: r.name, area_m2: area, packing: gcr, tilt_deg: +r.tilt, azimuth_deg: +r.azimuth });
    }
    return out;
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
      ctx.fillText(`${r.name} · ${r.shape === 'gable' ? 'gable ' + r.pitch + '°' : 'flat, ' + r.tilt + '° racks'}${a != null ? ' · ' + a.toFixed(0) + ' m²' : ''}`, c.x, c.y);
      ctx.restore();
    }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSolar;
