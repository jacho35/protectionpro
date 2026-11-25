/* ProtectionPro — Roof3D: the plan's solar roofs in 3D (View3D), with the modules laid out on them.
 *
 * Opened from the Solar PV Design modal (View in 3D). Read-only: roofs are edited on the plan or in the
 * modal. Every roof from `PlanSolar` becomes a prism (walls to the eave) with a gable roof — two planes
 * either side of a ridge across the facing direction — or a flat roof with parapet and tilted racks. The
 * modules are the count the last size calculation chose for that roof, laid out as whole modules inside
 * the edge setback; a flat roof's rows are spaced at the pitch the engine returned. The obstruction typed
 * on the Shading & grid step is drawn as a box so the shading source can be seen.
 *
 * Frame: x east, y north, z up, metres (plan y runs down, so y_m = -y × factor). Azimuth is from north.
 * The geometry (`toMetres`, `clip`, `gablePlanes`, `layoutModules`, `layoutRacks`) is pure and node-testable.
 */
const Roof3D = {
  EAVE_M: 3,
  PARAPET_M: 0.4,
  view: null,
  scene: null,

  // ── Pure geometry ──────────────────────────────────────────────────
  toMetres(points, f) { return points.map(p => [p.x * f, -p.y * f]); },

  // Unit vectors for a roof that faces azimuth az (degrees from north): u down the facing slope, w along the ridge.
  axes(az) {
    const a = az * Math.PI / 180;
    return { u: [Math.sin(a), Math.cos(a)], w: [Math.cos(a), -Math.sin(a)] };
  },

  // Sutherland-Hodgman: the part of a polygon where keep(p) >= 0, `d(p)` the signed distance.
  clip(poly, d) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = d(a), db = d(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
  },

  // A gable over a polygon: the plane facing +u (the north plane when az = 0) and the one facing -u,
  // as 3D polygons. The ridge is across the middle of the polygon's extent along u.
  gablePlanes(poly, az, pitchDeg, eave) {
    const { u } = this.axes(az), t = Math.tan(pitchDeg * Math.PI / 180);
    const s = (p) => p[0] * u[0] + p[1] * u[1];
    const ss = poly.map(s), smin = Math.min(...ss), smax = Math.max(...ss), ridge = (smin + smax) / 2;
    const front = this.clip(poly, p => s(p) - ridge).map(p => [p[0], p[1], eave + t * (smax - s(p))]);     // faces +u, falls toward +u
    const back = this.clip(poly, p => ridge - s(p)).map(p => [p[0], p[1], eave + t * (s(p) - smin)]);
    return { front, back, ridge, smin, smax, rise: t * (smax - smin) / 2 };
  },

  _inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  },
  _edgeDist(p, poly) {
    let m = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      m = Math.min(m, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    return m;
  },
  // A point is usable when it is inside the outline and at least `setback` m from every edge.
  _usable(p, poly, setback) { return this._inside(p, poly) && this._edgeDist(p, poly) >= setback - 1e-9; },

  // Whole modules on the plane facing +u (portrait: the long side down the slope), from the eave toward the
  // ridge. `g` is `gablePlanes`. Returns up to `max` rectangles of four [x, y, z] corners.
  layoutModules(poly, az, pitchDeg, setback, mod, max, g) {
    const { u, w } = this.axes(az), t = Math.tan(pitchDeg * Math.PI / 180);
    const run = mod.len * Math.cos(pitchDeg * Math.PI / 180), wid = mod.wid, out = [];
    const vs = poly.map(p => p[0] * w[0] + p[1] * w[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    const z = (s) => this.EAVE_M + t * (g.smax - s) + 0.04;
    for (let k = 0; k < 400; k++) {
      const s0 = g.smax - setback - k * run, s1 = s0 - run;      // eave side, ridge side
      if (s1 < g.ridge - 1e-9) break;
      for (let v = vmin + setback; v + wid <= vmax - setback + 1e-9; v += wid) {
        const cs = [at(v, s0), at(v + wid, s0), at(v + wid, s1), at(v, s1)];
        if (!cs.every(p => this._usable(p, poly, setback - 1e-6))) continue;
        out.push(cs.map(p => [p[0], p[1], z(p[0] * u[0] + p[1] * u[1])]));
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  // Tilted rows on a flat roof: from the +u edge, one row every `pitch` m toward -u. Each row is a run of
  // modules side by side; returns {rect: four corners, ...} per module with the high edge toward -u.
  layoutRacks(poly, az, tiltDeg, setback, mod, max, pitch, zBase) {
    const { u, w } = this.axes(az), b = tiltDeg * Math.PI / 180;
    const ss = poly.map(p => p[0] * u[0] + p[1] * u[1]), smax = Math.max(...ss), smin = Math.min(...ss);
    const vs = poly.map(p => p[0] * w[0] + p[1] * w[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    const run = mod.len * Math.cos(b), rise = mod.len * Math.sin(b), out = [];
    for (let s0 = smax - setback; s0 - run >= smin + setback - 1e-9; s0 -= pitch) {
      for (let v = vmin + setback; v + mod.wid <= vmax - setback + 1e-9; v += mod.wid) {
        const lo = [at(v, s0), at(v + mod.wid, s0)], hi = [at(v, s0 - run), at(v + mod.wid, s0 - run)];
        if (![...lo, ...hi].every(p => this._usable(p, poly, setback - 1e-6))) continue;
        out.push([[lo[0][0], lo[0][1], zBase + 0.1], [lo[1][0], lo[1][1], zBase + 0.1],
          [hi[1][0], hi[1][1], zBase + 0.1 + rise], [hi[0][0], hi[0][1], zBase + 0.1 + rise]]);
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  // ── Scene ──────────────────────────────────────────────────────────
  // Build the roofs as drawable data. `chosen` = modules per roof name from the last size calculation (or null).
  async build() {
    const f = PlanEngine.factor();
    if (!f) throw new Error('Calibrate the plan scale first so the roofs have a size.');
    const roofs = PlanSolar.roofs().filter(r => r.use !== false && r.points && r.points.length >= 3);
    if (!roofs.length) throw new Error('No roofs in use. Draw a roof on the plan first.');
    const c = Solar.cfg(), p = Solar.panel(c), res = Solar._res, chosen = {};
    if (res && res.arrays) for (const a of res.arrays) chosen[a.name] = a.modules;
    const out = [];
    for (const r of roofs) {
      const poly = this.toMetres(r.points, f);
      const item = { roof: r, poly, mods: [], planes: null };
      const max = chosen[r.name] != null ? chosen[r.name] : 1e9;
      const setback = Math.max(0, +r.setback || 0);
      if (r.shape === 'gable') {
        const g = this.gablePlanes(poly, +r.azimuth, +r.pitch, this.EAVE_M);
        item.planes = g;
        item.mods = this.layoutModules(poly, +r.azimuth, +r.pitch, setback, p, max, g);
      } else {
        const rs = await API.request('/analysis/solar-row-spacing', 'POST', {
          lat: Solar._loc(c).lat, tilt_deg: +r.tilt, module_length_m: p.len, hour_angle_deg: +c.hour });
        item.rowPitch = rs.pitch_m;
        item.mods = this.layoutRacks(poly, +r.azimuth, +r.tilt, setback, p, max, rs.pitch_m, this.EAVE_M + this.PARAPET_M);
      }
      out.push(item);
    }
    // the obstruction typed on the Shading & grid step, drawn from the middle of the first roof
    let obs = null;
    if (+c.obsH > 0 && out.length) {
      const m = out[0].poly.reduce((a, q) => [a[0] + q[0] / out[0].poly.length, a[1] + q[1] / out[0].poly.length], [0, 0]);
      const a = +c.obsB * Math.PI / 180;
      obs = { x: m[0] + Math.sin(a) * +c.obsD, y: m[1] + Math.cos(a) * +c.obsD, w: +c.obsW, h: this.EAVE_M + +c.obsH, bearing: +c.obsB };
    }
    return { items: out, obs, total: out.reduce((n, i) => n + i.mods.length, 0) };
  },

  async open() {
    const modal = document.getElementById('roof3d-modal');
    const host = document.getElementById('roof3d-host');
    const msg = document.getElementById('roof3d-msg');
    modal.style.display = '';
    msg.textContent = 'Building the roofs…';
    try {
      this.scene = await this.build();
    } catch (e) {
      msg.textContent = e.message || String(e);
      return;
    }
    const sc = this.scene;
    msg.textContent = sc.total + ' modules shown on ' + sc.items.length + ' roof' + (sc.items.length === 1 ? '' : 's')
      + (Solar._res && Solar._res.arrays ? ' (the count from your last calculation).' : ' (all that fit; calculate on the Roof & size step to show the chosen count).');
    if (this.view) { this.view.destroy(); this.view = null; }
    this.view = new View3D(host, { label: 'Rotatable 3D view of the solar roofs. Drag to orbit, right-drag to pan, wheel to zoom.', yaw: 150, pitch: 32, bg: '#eef0f3' });
    const xs = [], ys = [];
    for (const it of sc.items) for (const q of it.poly) { xs.push(q[0]); ys.push(q[1]); }
    if (sc.obs) { xs.push(sc.obs.x); ys.push(sc.obs.y); }
    const pad = 4;
    this.view.fit([Math.min(...xs) - pad, Math.min(...ys) - pad, 0], [Math.max(...xs) + pad, Math.max(...ys) + pad, this.EAVE_M + 4]);
    this.view.zoom = 1.7;
    this.view.onDraw = (v) => this.draw(v);
    this.view.redraw();
  },

  close() {
    document.getElementById('roof3d-modal').style.display = 'none';
    if (this.view) { this.view.destroy(); this.view = null; }
  },

  draw(v) {
    const sc = this.scene; if (!sc) return;
    for (const it of sc.items) {
      const r = it.roof, P = it.poly, z = this.EAVE_M;
      for (let i = 0; i < P.length; i++) {                                    // walls
        const a = P[i], b = P[(i + 1) % P.length];
        v.face({ pts: [[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], z], [a[0], a[1], z]], fill: '#d9d4c7', stroke: '#9a9486', lw: 1, layer: 1 });
      }
      if (it.planes) {                                                         // gable planes
        v.face({ pts: it.planes.front, fill: '#b7653a', stroke: '#6b3a1f', lw: 1, layer: 1 });
        v.face({ pts: it.planes.back, fill: '#9c5430', stroke: '#6b3a1f', lw: 1, layer: 1 });
      } else {                                                                 // flat roof and parapet
        v.face({ pts: P.map(q => [q[0], q[1], z + this.PARAPET_M]), fill: '#c9ccd1', stroke: '#6b7280', lw: 1, layer: 1 });
      }
      for (const m of it.mods) v.face({ pts: m, fill: '#27506b', stroke: '#9fc4dd', lw: 0.8, layer: 2 });
      const c = P.reduce((a, q) => [a[0] + q[0] / P.length, a[1] + q[1] / P.length], [0, 0]);
      v.label({ at: [c[0], c[1], z + (it.planes ? it.planes.rise : this.PARAPET_M) + 1.2], text: `${r.name} · ${it.mods.length} modules`, color: '#1f2937', size: 12, bold: true });
    }
    if (sc.obs) {
      const o = sc.obs, a = o.bearing * Math.PI / 180, hx = Math.cos(a) * o.w / 2, hy = -Math.sin(a) * o.w / 2, d = 0.25;
      const ox = Math.sin(a) * d, oy = Math.cos(a) * d;
      const q = (sx, sy, z) => [o.x + sx, o.y + sy, z];
      const base = [q(-hx - ox, -hy - oy, 0), q(hx - ox, hy - oy, 0), q(hx + ox, hy + oy, 0), q(-hx + ox, -hy + oy, 0)];
      const top = base.map(p => [p[0], p[1], o.h]);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; v.face({ pts: [base[i], base[j], top[j], top[i]], fill: '#8a8f98', stroke: '#4b5563', lw: 1, layer: 1 }); }
      v.face({ pts: top, fill: '#a3a8b0', stroke: '#4b5563', lw: 1, layer: 1 });
      v.label({ at: [o.x, o.y, o.h + 0.8], text: 'Obstruction', color: '#374151', size: 11 });
    }
    v.label({ at: [v.target[0], v.target[1] + v.radius * 0.9, 0], text: 'N ↑', color: '#374151', size: 12, bold: true });
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Roof3D;
