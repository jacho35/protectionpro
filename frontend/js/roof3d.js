/* ProtectionPro — Roof3D: the plan's solar roofs in 3D (View3D), with the modules laid out on them.
 *
 * The 3D half of the Plan tab's roof editor (roof-editor.js; opened from Plan › Solar › Roof editor or Solar PV Design).
 * The roofs are edited here and on the plan alike; the older notes below about a read-only view are out of date. Formerly: the
 * modal. Every roof from `PlanSolar` becomes a prism (walls to the eave) with a gable roof — two planes
 * either side of a ridge across the facing direction — or a flat roof with parapet and tilted racks. The
 * modules are the count the last size calculation chose for that roof, laid out as whole modules inside
 * the edge setback; a flat roof's rows are spaced at the pitch the engine returned. The obstruction typed
 * on the Shading & grid step is drawn as a box so the shading source can be seen.
 *
 * Frame: x east, y north, z up, metres (plan y runs down, so y_m = -y × factor). Azimuth is from north.
 * Shadows: the sun position at the chosen hour on the winter solstice comes from `/analysis/solar-sun`; the
 * obstruction's shadow (ground, a gable's north plane, a flat roof's deck) and each rack row's shadow on the deck
 * are drawn, and a module is counted as shaded when the ray from its centre toward the sun hits the obstruction or
 * another module. This is a picture of one moment; the annual shading loss still comes from the engine.
 * The geometry (`toMetres`, `clip`, `gablePlanes`, `layoutModules`, `layoutRacks`) is pure and node-testable.
 */
const Roof3D = {
  EAVE_M: 3,
  PARAPET_M: 0.4,
  view: null,
  scene: null,
  hourAngle: 0,        // design hour on the winter solstice: degrees, 0 = noon, negative = morning

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
    return { front, back, ridge, smin, smax, eave, rise: t * (smax - smin) / 2 };
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
  // Where the whole modules sit in the free space: `al` = 'bottom-right' (the default: eave side, the low-w edge) … 'top-left',
  // 'center-center'. Seen from outside the plane, ridge up: top = ridge side, bottom = eave side, left = +w, right = -w.
  // `slack(al)` → [along-the-slope share, across share] of the leftover space to leave on the eave / low-w side (0 .. 1).
  alignShare(al) {
    const [v, h] = String(al || 'bottom-right').split('-');
    return { v: v === 'top' ? 1 : v === 'center' ? 0.5 : 0, h: h === 'left' ? 1 : h === 'center' ? 0.5 : 0 };
  },
  // Does a module's plan quad touch a keep-out polygon (both [x, y] lists in metres)? `ex` = a list of polygons.
  hitsKeepout(quad, ex) {
    if (!ex || !ex.length) return false;
    const seg = (a, b, c, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
    const q = quad.map(p => [p[0], p[1]]);
    return ex.some(poly => {
      if (q.some(p => this._inside(p, poly)) || poly.some(p => this._inside(p, q))) return true;
      for (let i = 0; i < 4; i++) for (let j = 0; j < poly.length; j++) if (seg(q[i], q[(i + 1) % 4], poly[j], poly[(j + 1) % poly.length])) return true;
      return false;
    });
  },
  // Space left over when `n` modules of size `size` are laid in a row of length `space` with `gap` between neighbours (0 when none fit).
  slack(space, size, gap) {
    const n = Math.floor((space + gap) / (size + gap) + 1e-9);
    return n > 0 ? space - (n * size + (n - 1) * gap) : 0;
  },
  layoutModules(poly, az, pitchDeg, setback, mod, max, g, al, ex) {
    const { u, w } = this.axes(az), t = Math.tan(pitchDeg * Math.PI / 180);
    const run = mod.len * Math.cos(pitchDeg * Math.PI / 180), wid = mod.wid, gap = Math.max(0, +mod.gap || 0), out = [];
    const vs = poly.map(p => p[0] * w[0] + p[1] * w[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    const z = (s) => (g.eave != null ? g.eave : this.EAVE_M) + t * (g.smax - s) + 0.04;
    const sh = this.alignShare(al), rowSpace = g.smax - setback - g.ridge, colSpace = vmax - vmin - 2 * setback;
    const sOff = sh.v * this.slack(rowSpace, run, gap), vOff = sh.h * this.slack(colSpace, wid, gap);
    for (let k = 0; k < 400; k++) {
      const s0 = g.smax - setback - sOff - k * (run + gap), s1 = s0 - run;      // eave side, ridge side
      if (s1 < g.ridge - 1e-9) break;
      for (let v = vmin + setback + vOff; v + wid <= vmax - setback + 1e-9; v += wid + gap) {
        const cs = [at(v, s0), at(v + wid, s0), at(v + wid, s1), at(v, s1)];
        if (!cs.every(p => this._usable(p, poly, setback - 1e-6)) || this.hitsKeepout(cs, ex)) continue;
        out.push(cs.map(p => [p[0], p[1], z(p[0] * u[0] + p[1] * u[1])]));
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  // Tilted rows on a flat roof: from the +u edge, one row every `pitch` m toward -u. Each row is a run of
  // modules side by side; returns {rect: four corners, ...} per module with the high edge toward -u.
  layoutRacks(poly, az, tiltDeg, setback, mod, max, pitch, zBase, al, ex) {
    const { u, w } = this.axes(az), b = tiltDeg * Math.PI / 180;
    const ss = poly.map(p => p[0] * u[0] + p[1] * u[1]), smax = Math.max(...ss), smin = Math.min(...ss);
    const vs = poly.map(p => p[0] * w[0] + p[1] * w[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    const run = mod.len * Math.cos(b), rise = mod.len * Math.sin(b), gap = Math.max(0, +mod.gap || 0), out = [];   // the gap is along a row; the row pitch already holds the space between rows
    const sh = this.alignShare(al), rowSpace = smax - smin - 2 * setback, colSpace = vmax - vmin - 2 * setback;
    const nRows = rowSpace >= run - 1e-9 ? Math.floor((rowSpace - run) / pitch + 1e-9) + 1 : 0;
    const sOff = nRows ? sh.v * (rowSpace - ((nRows - 1) * pitch + run)) : 0, vOff = sh.h * this.slack(colSpace, mod.wid, gap);
    for (let s0 = smax - setback - sOff; s0 - run >= smin + setback - 1e-9; s0 -= pitch) {
      for (let v = vmin + setback + vOff; v + mod.wid <= vmax - setback + 1e-9; v += mod.wid + gap) {
        const lo = [at(v, s0), at(v + mod.wid, s0)], hi = [at(v, s0 - run), at(v + mod.wid, s0 - run)];
        if (![...lo, ...hi].every(p => this._usable(p, poly, setback - 1e-6)) || this.hitsKeepout([lo[0], lo[1], hi[1], hi[0]], ex)) continue;
        out.push([[lo[0][0], lo[0][1], zBase + 0.1], [lo[1][0], lo[1][1], zBase + 0.1],
          [hi[1][0], hi[1][1], zBase + 0.1 + rise], [hi[0][0], hi[0][1], zBase + 0.1 + rise]]);
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  // ── Shadows (pure) ─────────────────────────────────────────────────
  // Unit vector toward the sun: x east, y north, z up (azimuth from north, elevation above the horizon).
  sunVec(azDeg, elevDeg) {
    const a = azDeg * Math.PI / 180, e = elevDeg * Math.PI / 180;
    return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  },
  _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  _sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },

  // Where the point P lands when it is carried along the sunlight onto the plane through Q with normal n
  // (null when the sun is behind the plane or the point is already below it).
  shadowPoint(P, s, Q, n) {
    const ns = this._dot(n, s);
    if (ns <= 1e-9) return null;
    const lam = this._dot(n, this._sub(P, Q)) / ns;
    if (lam < -1e-9) return null;
    return [P[0] - lam * s[0], P[1] - lam * s[1], P[2] - lam * s[2]];
  },

  // Convex hull (Andrew) of 2D-keyed points; keeps the third coordinate when there is one.
  hull(pts) {
    const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P.length < 3) return P;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  },

  // Clip a polygon by a CONVEX polygon (counter-clockwise or clockwise). Both 2D.
  clipConvex(subject, clip) {
    const area = clip.reduce((a, p, i) => { const q = clip[(i + 1) % clip.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
    const sg = area >= 0 ? 1 : -1;
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      out = this.clip(out, p => sg * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])));
    }
    return out;
  },

  // Does the ray from P toward the sun (direction s) pass through the planar convex quad?
  rayHitsQuad(P, s, quad) {
    const e1 = this._sub(quad[1], quad[0]), e2 = this._sub(quad[3], quad[0]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ds = this._dot(n, s);
    if (Math.abs(ds) < 1e-9) return false;
    const lam = this._dot(n, this._sub(quad[0], P)) / ds;
    if (lam < 1e-6) return false;
    const X = [P[0] + lam * s[0], P[1] + lam * s[1], P[2] + lam * s[2]];
    const d = this._sub(X, quad[0]), a = this._dot(d, e1) / this._dot(e1, e1), b = this._dot(d, e2) / this._dot(e2, e2);
    return a >= -1e-9 && a <= 1 + 1e-9 && b >= -1e-9 && b <= 1 + 1e-9;
  },

  // An upright box on a footprint quad ([x, y] corners) from z 0 to `top`, as its five outer faces.
  boxFaces(foot, top) {
    const b = foot.map(p => [p[0], p[1], 0]), t = foot.map(p => [p[0], p[1], top]);
    const f = [t];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; f.push([b[i], b[j], t[j], t[i]]); }
    return f;
  },

  // Which modules are in shade at this sun position: a module is shaded when the ray from its centre toward
  // the sun hits the obstruction box or any other module / rack. `groups` = arrays of module quads.
  shadedModules(groups, s, obstacleFaces) {
    const all = groups.flat(), out = [];
    for (const g of groups) {
      for (const m of g) {
        const c = m.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
        let hit = obstacleFaces.some(f => this.rayHitsQuad(c, s, f));
        if (!hit) hit = all.some(o => o !== m && this.rayHitsQuad(c, s, o));
        out.push(hit);
      }
    }
    return out;
  },

  // The obstruction's footprint quad ([x, y] corners): width across the bearing, 0.5 m deep.
  obstructionFoot(o) {
    const a = o.bearing * Math.PI / 180, hx = Math.cos(a) * o.w / 2, hy = -Math.sin(a) * o.w / 2, ox = Math.sin(a) * 0.25, oy = Math.cos(a) * 0.25;
    return [[o.x - hx - ox, o.y - hy - oy], [o.x + hx - ox, o.y + hy - oy], [o.x + hx + ox, o.y + hy + oy], [o.x - hx + ox, o.y - hy + oy]];
  },

  // Shadow polygons (3D, lying on their plane) and the shaded flag of every module for a sun vector `s`.
  // The obstructions are the typed one (`scene.obs`) and the objects on the roofs (`scene.objs`): footprint quad + top height.
  // A surface is what modules sit on: a gable's front plane, each plane of a hip / mono in use, or a flat roof's deck.
  _surfaces(it) {
    const t = (d) => Math.tan(+d * Math.PI / 180);
    if (it.pls && it.pls.length && !it.pls[0].flat) {
      const ps = it.roof.shape === 'gable' ? [it.pls[0]] : it.pls.filter((p, i) => !it.use || it.use[i]);
      return ps.map(pl => { const tt = t(pl.pitch), { u } = this.axes(pl.az), c = pl.poly[0];
        return { zAt: pl.zAt, Q: [c[0], c[1], pl.zAt(c[0], c[1])], n: [tt * u[0], tt * u[1], 1], clip: pl.poly, racks: false }; });
    }
    if (it.planes) {                                                           // a scene built without plane objects
      const tt = t(it.roof.pitch), { u } = this.axes(+it.roof.azimuth), g = it.planes, e = g.eave != null ? g.eave : this.EAVE_M;
      return [{ zAt: (x, y) => e + tt * (g.smax - (x * u[0] + y * u[1])), Q: [0, 0, e + tt * g.smax], n: [tt * u[0], tt * u[1], 1], clip: g.front.map(p => [p[0], p[1]]), racks: false }];
    }
    const z = (it.eave != null ? it.eave : this.EAVE_M) + this.PARAPET_M;
    return [{ zAt: () => z, Q: [0, 0, z], n: [0, 0, 1], clip: it.poly, racks: true }];
  },
  shadows(scene, s) {
    const polys = [];
    const obs = scene.obs, obsList = (obs ? [obs] : []).concat(scene.objs || []);
    const faces = obsList.flatMap(o => this.boxFaces(o.foot, o.h));
    if (obs && s[2] > 0.02) {                                                 // the typed obstruction on the ground
      const pts = obs.foot.map(p => [p[0], p[1], 0]).concat(obs.foot.map(p => this.shadowPoint([p[0], p[1], obs.h], s, [0, 0, 0], [0, 0, 1])).filter(Boolean));
      if (pts.length >= 3) polys.push({ kind: 'ground', pts: this.hull(pts).map(p => [p[0], p[1], 0.01]) });
    }
    for (const it of scene.items) {
      for (const sf of this._surfaces(it)) {
        const { zAt, Q, n } = sf, clipPoly = sf.clip;
        const convex = this.hull(clipPoly).length === clipPoly.length;
        const put = (pts3, kind) => {
          let h = this.hull(pts3).map(p => [p[0], p[1]]);
          if (convex && h.length >= 3) h = this.clipConvex(h, clipPoly);
          if (h.length >= 3) polys.push({ kind, pts: h.map(p => [p[0], p[1], zAt(p[0], p[1]) + 0.02]) });
        };
        for (const o of obsList) {                                             // an obstruction onto this plane
          if (!(o.h > Math.max(...o.foot.map(p => zAt(p[0], p[1]))))) continue;
          const base = o.foot.map(p => [p[0], p[1], zAt(p[0], p[1])]);
          const tops = o.foot.map(p => this.shadowPoint([p[0], p[1], o.h], s, Q, n)).filter(Boolean);
          if (tops.length === 4) put(base.concat(tops), 'obstruction');
        }
        if (sf.racks) for (const m of it.mods) {                              // each rack's shadow on the deck
          const pr = m.map(p => this.shadowPoint(p, s, Q, n)).filter(Boolean);
          if (pr.length === 4) put(pr, 'rack');
        }
      }
    }
    const groups = scene.items.map(it => it.mods);
    const flags = this.shadedModules(groups, s, faces);
    let k = 0;
    scene.items.forEach(it => { it.shaded = it.mods.map(() => flags[k++]); });
    return polys;
  },

  // An upright rectangle's footprint: centre, width along its own x turned `ang`° (counter-clockwise), depth across.
  rectFoot(cx, cy, w, d, ang) {
    const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
  },
  // Height of the roof surface at a point (the plane that contains it; the eave when none does).
  deckZ(it, x, y) {
    for (const pl of (it.pls || [])) if (this._inside([x, y], pl.poly) || this._edgeDist([x, y], pl.poly) < 1e-6) return pl.zAt(x, y);
    return it.eave != null ? it.eave : this.EAVE_M;
  },

  // ── Scene ──────────────────────────────────────────────────────────
  // Build the roofs as drawable data. `chosen` = modules per roof name from the last size calculation (or null).
  async build() {
    const f = PlanEngine.factor();
    const roofs = PlanSolar.roofs().filter(r => r.points && r.points.length >= 3);
    if (!f || !roofs.length) return { items: [], obs: null, objs: [], north: PlanSolar.northAngle(), total: 0, empty: true, uncalibrated: !f };
    await Solar._locations();                                              // the irradiance locations (latitude for the row pitch and the sun) load on first use
    const c = Solar.cfg(), p = Solar.panel(c), res = Solar._res, chosen = {};
    if (res && res.arrays) for (const a of res.arrays) chosen[a.name] = a.modules;
    const out = [], objs = [], north = PlanSolar.northAngle();
    for (const r of roofs) {
      const base = this.toMetres(r.points, f), paz = PlanSolar.planAz(r), eave = RoofPlanes.eave(r);
      const m = RoofPlanes.model(base, r, paz, north), pls = m.planes, use = RoofPlanes.used(pls, r), poly = m.foot;
      const item = { roof: r, poly, base, mods: [], planes: null, pls, use, eave, junctions: m.junctions, unused: r.use === false };   // a roof not in the calculation is still drawn, just without modules
      const ex = PlanSolar.keepoutsM(r), cap = PlanSolar.maxModules(r), max = Math.min(cap, chosen[r.name] != null ? chosen[r.name] : 1e9);   // the roof's own maximum panels caps every layout
      const setback = Math.max(0, +r.setback || 0), mp = PlanSolar.modFor(r, p);
      if (item.unused) {
        if (r.shape === 'gable') item.planes = this.gablePlanes(poly, paz, +r.pitch, eave);
      } else if (PlanSolar.usesPlanes(r)) {
        let left = cap;                                                     // what the roof's maximum still allows over all its planes
        for (const gr of RoofPlanes.groups(pls)) {                          // a plane's pieces share the count the calculation chose for it
          if (!use[gr.idx[0]]) continue;
          let rem = chosen[r.name + ' · ' + gr.name] != null ? chosen[r.name + ' · ' + gr.name] : 1e9;
          for (const i of gr.idx) { rem = Math.min(rem, left); if (rem <= 0) break; const ms = RoofPlanes.layoutPlane(pls[i], poly, setback, mp, rem, r.modAlign, ex); item.mods.push(...ms); rem -= ms.length; left -= ms.length; }
        }
      } else if (r.shape === 'gable') {
        const g = this.gablePlanes(poly, paz, +r.pitch, eave);
        item.planes = g;
        item.mods = this.layoutModules(poly, paz, +r.pitch, setback, mp, max, g, r.modAlign, ex);
      } else {
        const rs = await API.request('/analysis/solar-row-spacing', 'POST', {
          lat: Solar._loc(c).lat, tilt_deg: +r.tilt, module_length_m: p.len, hour_angle_deg: +c.hour });
        item.rowPitch = rs.pitch_m;
        item.mods = this.layoutRacks(poly, paz, +r.tilt, setback, mp, max, rs.pitch_m, eave + this.PARAPET_M, r.modAlign, ex);
      }
      for (const o of (r.objects || [])) {                                  // vents, chimneys...: boxes standing on the roof
        const cx = o.x * f, cy = -o.y * f, z0 = this.deckZ(item, cx, cy);
        objs.push({ id: o.id, roofId: r.id, type: o.type, c: [cx, cy], w: +o.w, d: +o.d, rot: +o.rot || 0, z0, hh: +o.h, h: z0 + +o.h, foot: this.rectFoot(cx, cy, +o.w, +o.d, -(+o.rot || 0)) });
      }
      out.push(item);
    }
    // the obstruction typed on the Shading & grid step, drawn from the middle of the first roof
    let obs = null;
    if (+c.obsH > 0 && out.length) {
      const m = out[0].poly.reduce((a, q) => [a[0] + q[0] / out[0].poly.length, a[1] + q[1] / out[0].poly.length], [0, 0]);
      const a = (+c.obsB + north) * Math.PI / 180;      // the bearing is from true north; the plan may be turned
      obs = { x: m[0] + Math.sin(a) * +c.obsD, y: m[1] + Math.cos(a) * +c.obsD, w: +c.obsW, h: out[0].eave + +c.obsH, bearing: +c.obsB + north };
      obs.foot = this.obstructionFoot(obs);
    }
    return { items: out, obs, objs, north, total: out.reduce((n, i) => n + i.mods.length, 0) };
  },

  // ── The editor core ────────────────────────────────────────────────
  // The 3D view of the Plan tab's roof editor (roof-editor.js owns the dock, the tool palette and the panel). The view
  // edits the same roofs as the plan: the handles set eave height and pitch, the gizmo moves / turns / scales a roof or
  // an object (X / Y lock, typed values in the status bar), objects drop onto a plane, the Footprint tool draws on the
  // ground. Every change goes through PlanSolar (so the plan, Place array and the sizing see it) and rebuilds the scene.
  tool: 'select',       // select | footprint | pushpull | ridge | planes | transform | object
  gizmo: 'move',        // move | rotate | scale
  sel: null,            // { roof: id, plane: index } | { roof, obj: id }
  addType: 'vent',
  axis: '',             // '' | 'x' | 'y' | 'z'
  SNAP: 0.05,
  shadePreview: true,
  hooks: {},

  _roof(id) { return PlanSolar.roofs().find(r => r.id === id) || null; },
  _item(id) { return this.scene ? this.scene.items.find(i => i.roof.id === id) || null : null; },
  _selRoofId() { return this.sel ? this.sel.roof : (this.scene && this.scene.items[0] ? this.scene.items[0].roof.id : null); },
  _fire(k, ...a) { if (this.hooks && this.hooks[k]) this.hooks[k](...a); },

  // Rebuild the scene after an edit (one at a time; the last request wins), keeping the camera and the sun.
  async _rebuild(redrawPanel = true) {
    if (this._busy) { this._again = true; return; }
    this._busy = true;
    try {
      do {
        this._again = false;
        const old = this.scene, sc = await this.build();
        sc.sun = old && old.sun;
        sc.shadowPolys = this.shadePreview && sc.sun && sc.sun.elevation_deg > 0.5 ? this.shadows(sc, this.sunVec(sc.sun.azimuth_deg + sc.north, sc.sun.elevation_deg)) : [];
        this.scene = sc;
        if (this.sel && !sc.items.some(i => i.roof.id === this.sel.roof)) this.sel = null;
      } while (this._again);
      this._message();
      if (this.view) this.view.redraw();
    } catch (e) { this._fire('onMessage', e.message || String(e)); }
    this._busy = false;
    this._fire('onBuilt');
    if (redrawPanel) this._fire('onPanel');
  },
  _live() {                                      // an edit in progress: redraw the plan and this view without an undo step
    if (typeof PlanMarkup !== 'undefined') PlanMarkup.markDirty();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    this._rebuild(false);
  },
  _commit() { PlanSolar._changed(); this._rebuild(); },
  refresh() { return this._rebuild(); },
  _message() {
    const sc = this.scene; if (!sc) return;
    if (sc.error) { this._fire('onMessage', 'The 3D view could not be built: ' + sc.error); return; }
    if (sc.empty) { this._fire('onMessage', sc.uncalibrated ? 'Calibrate the plan scale first so the roofs have a size.' : 'No roofs yet. Pick Footprint and click the corners of the building, on the plan or on the ground here.'); return; }
    let txt = sc.total + ' modules on ' + sc.items.filter(i => !i.unused).length + ' roof' + (sc.items.filter(i => !i.unused).length === 1 ? '' : 's')
      + (Solar._res && Solar._res.arrays ? ' (the count from your last calculation).' : ' (all that fit).');
    if (sc.sun && this.shadePreview) {
      const shaded = sc.items.reduce((n, it) => n + (it.shaded || []).filter(Boolean).length, 0);
      txt += ' At ' + this.hourLabel() + ' on the winter solstice (sun ' + sc.sun.elevation_deg + '° up, from ' + sc.sun.azimuth_deg + '°) ' + shaded + ' of ' + sc.total + ' modules are in shade.';
    }
    this._fire('onMessage', txt);
  },
  // Hour angle (15° per hour, 0 = solar noon) as a clock time, and back.
  hourText(ha) { const m = Math.round((12 + (+ha || 0) / 15) * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); },
  hourLabel() { return this.hourText(this.hourAngle); },

  // Show the roofs in `host`. `hooks`: onPanel(), onMessage(text), onTool().
  async mount(host, hooks) {
    this.hooks = hooks || {};
    if (this.view) { this.view.destroy(); this.view = null; }
    this.host = host;
    try { this.scene = await this.build(); } catch (e) { this.scene = { items: [], objs: [], north: 0, total: 0, empty: true, error: e.message || String(e) }; }
    this.view = new View3D(host, { label: 'Rotatable 3D view of the roofs. Drag empty space to orbit, right-drag to pan, wheel to zoom; with a tool picked, drag a handle, the gizmo or an object.', yaw: 150, pitch: 32, bg: '#eef0f3' });
    this.view.onDraw = (v) => this.draw(v);
    this.view.onPick = (id, e) => this._pick(id, e);
    this.view.onClick = (id, e) => this._click(id, e);
    this.fit();
    this._message();
    this.setHour(this.hourAngle, true).catch(() => {}).then(() => { if (this.view) this.view.redraw(); });
    this.view.redraw();
  },
  unmount() { if (this.view) { this.view.destroy(); this.view = null; } this.host = null; },
  fit() {
    const sc = this.scene, v = this.view; if (!v) return;
    const xs = [], ys = [];
    for (const it of (sc ? sc.items : [])) for (const q of it.poly) { xs.push(q[0]); ys.push(q[1]); }
    if (sc && sc.obs) { xs.push(sc.obs.x); ys.push(sc.obs.y); }
    if (!xs.length) { xs.push(-8, 8); ys.push(-8, 8); }
    const pad = 4;
    v.fit([Math.min(...xs) - pad, Math.min(...ys) - pad, 0], [Math.max(...xs) + pad, Math.max(...ys) + pad, (sc && sc.items[0] ? sc.items[0].eave : 3) + 4]);
    v.zoom = 1.7;
  },
  // Named views: top, north (looking from the north), east, south, west, iso.
  setView(name) {
    const v = this.view; if (!v) return;
    const n = (this.scene && this.scene.north) || 0;
    const m = { top: [0, 89], north: [180, 25], south: [0, 25], east: [-90, 25], west: [90, 25], iso: [150, 32] }[name]; if (!m) return;
    v.setView(m[0] + (name === 'top' || name === 'iso' ? 0 : n), m[1]);
    this.viewName = name;
  },
  viewName: 'iso',

  // Sun at the chosen hour on the winter solstice (the engine's position), then the shadows for it.
  async setHour(h, noRedraw) {
    this.hourAngle = +h;
    const sc = this.scene; if (!sc || sc.empty) return;
    await Solar._locations();
    const c = Solar.cfg();
    const sun = await API.request('/analysis/solar-sun', 'POST', { lat: Solar._loc(c).lat, hour_angle_deg: this.hourAngle });
    sc.sun = sun;
    sc.shadowPolys = this.shadePreview && sun.elevation_deg > 0.5 ? this.shadows(sc, this.sunVec(sun.azimuth_deg + (sc.north || 0), sun.elevation_deg)) : [];
    this._message();
    if (this.view && !noRedraw) this.view.redraw();
  },
  setShade(on) {
    this.shadePreview = !!on;
    const sc = this.scene; if (!sc) return;
    sc.shadowPolys = on && sc.sun && sc.sun.elevation_deg > 0.5 ? this.shadows(sc, this.sunVec(sc.sun.azimuth_deg + sc.north, sc.sun.elevation_deg)) : [];
    if (!on) sc.items.forEach(it => { it.shaded = it.mods.map(() => false); });
    this._message(); if (this.view) this.view.redraw();
  },

  setTool(t) { this.tool = t; this._fire('onTool', t); this._fire('onPanel'); if (this.view) this.view.redraw(); },

  // Ground point under the pointer for a plane: the plane's height is found by iterating, as the view looks down at an angle.
  _pointOnPlane(pl, sx, sy) {
    const c = pl.poly.reduce((a, q) => [a[0] + q[0] / pl.poly.length, a[1] + q[1] / pl.poly.length], [0, 0]);
    let z = pl.zAt(c[0], c[1]), p = this.view.planeAt(sx, sy, z);
    for (let i = 0; i < 3; i++) { z = pl.zAt(p[0], p[1]); p = this.view.planeAt(sx, sy, z); }
    return p;
  },
  _snap(v) { return Math.round(v / this.SNAP) * this.SNAP; },

  // What the gizmo is on: the selected object, else the selected roof (a plane or the first roof).
  _target() {
    const rid = this.sel ? this.sel.roof : null, roof = rid && this._roof(rid), it = roof && this._item(rid);
    if (!roof || !it) return null;
    if (this.sel.obj) { const o = (roof.objects || []).find(x => x.id === this.sel.obj), ob = this.scene.objs.find(x => x.id === this.sel.obj); if (o && ob) return { kind: 'obj', roof, o, ob, it }; }
    return { kind: 'roof', roof, it };
  },
  _gizmoOrigin(t) {
    if (t.kind === 'obj') return [t.ob.c[0], t.ob.c[1], t.ob.z0 + t.ob.hh];
    const c = t.it.poly.reduce((a, q) => [a[0] + q[0] / t.it.poly.length, a[1] + q[1] / t.it.poly.length], [0, 0]);
    return [c[0], c[1], t.it.eave];
  },
  // Move the target by (dx, dy) metres from the state captured at the start of a drag.
  _moveBy(t, base, dx, dy) {
    const f = PlanEngine.factor(), wx = dx / f, wy = -dy / f;
    if (t.kind === 'obj') { t.o.x = base.x + wx; t.o.y = base.y + wy; return; }
    t.roof.points.forEach((q, i) => { q.x = base.pts[i].x + wx; q.y = base.pts[i].y + wy; });
    (t.roof.objects || []).forEach((o, i) => { o.x = base.obj[i].x + wx; o.y = base.obj[i].y + wy; });
  },
  _capture(t) { return t.kind === 'obj' ? { x: t.o.x, y: t.o.y, h: t.o.h, w: t.o.w, d: t.o.d, rot: t.o.rot || 0 } : { pts: t.roof.points.map(q => ({ x: q.x, y: q.y })), obj: (t.roof.objects || []).map(o => ({ x: o.x, y: o.y, w: o.w, d: o.d, h: o.h, rot: o.rot || 0 })), az: +t.roof.azimuth || 0, eave: RoofPlanes.eave(t.roof) }; },

  // A drag that moves, lifts, turns or scales the target. `kind`: 'g' gizmo, 's' scale handle.
  _gizmoDrag(kind, axis, e) {
    const t = this._target(), v = this.view, f = PlanEngine.factor(); if (!t || !f) return null;
    const o0 = this._gizmoOrigin(t), base = this._capture(t), start = v.planeAt(...v._pos(e), o0[2]);
    const dzOf = (dy) => -dy / (v.scale() * Math.cos(v.pitch * Math.PI / 180));
    const ang = (p) => Math.atan2(p[0] - o0[0], p[1] - o0[1]) * 180 / Math.PI;       // bearing from the gizmo
    const up = (ev, moved) => { if (moved) this._commit(); };
    if (kind === 'g' && (axis === 'x' || axis === 'y')) {
      const dir = axis === 'x' ? [1, 0] : [0, 1];
      return { move: (ev, x, y) => { const p = v.planeAt(x, y, o0[2]), d = this._snap((p[0] - start[0]) * dir[0] + (p[1] - start[1]) * dir[1]); this._moveBy(t, base, dir[0] * d, dir[1] * d); this._live(); }, up };
    }
    if (kind === 'g' && axis === 'z') {                                       // up / down: an object's height, a roof's eave
      return { move: (ev, x, y, dx, dy) => { const d = dzOf(dy);
        if (t.kind === 'obj') t.o.h = Math.max(0.02, this._snap(base.h + d)); else t.roof.eave = Math.max(2, Math.min(15, this._snap(base.eave + d)));
        this._live(); }, up };
    }
    if (kind === 'g' && axis === 'r') {                                        // turn about the vertical axis
      const a0 = ang(start);
      return { move: (ev, x, y) => { const p = v.planeAt(x, y, o0[2]); let da = Math.round((ang(p) - a0) / 5) * 5;
        if (t.kind === 'obj') t.o.rot = ((base.rot - da) % 360 + 360) % 360;       // plan rotation is clockwise-positive
        else this._rotateRoof(t, base, o0, da);
        this._live(); }, up };
    }
    if (kind === 's') {                                                        // scale: a handle on an axis of the gizmo
      const dir = axis === 'x' ? [1, 0] : axis === 'y' ? [0, 1] : null;
      return { move: (ev, x, y, dx, dy) => {
        let k = 1;
        if (dir) { const p = v.planeAt(x, y, o0[2]); const L0 = Math.max(0.1, (start[0] - o0[0]) * dir[0] + (start[1] - o0[1]) * dir[1]); k = Math.max(0.1, ((p[0] - o0[0]) * dir[0] + (p[1] - o0[1]) * dir[1]) / L0); }
        else k = Math.max(0.1, 1 + dzOf(dy) / Math.max(0.5, t.kind === 'obj' ? base.h : base.eave));
        k = Math.round(k * 20) / 20;
        if (t.kind === 'obj') { const a = (+base.rot) * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
          if (axis === 'z') t.o.h = Math.max(0.02, base.h * k);
          else { const alongW = dir ? Math.abs(dir[0] * ux + dir[1] * (-uy)) >= 0.5 : true; if (alongW) t.o.w = Math.max(0.02, base.w * k); else t.o.d = Math.max(0.02, base.d * k); } }
        else this._scaleRoof(t, base, o0, axis === 'z' ? 1 : dir && dir[0] ? k : 1, axis === 'z' ? 1 : dir && dir[1] ? k : 1, axis === 'z' ? k : 1);
        this._live(); }, up };
    }
    return null;
  },
  _rotateRoof(t, base, o0, da) {
    const f = PlanEngine.factor(), c = { x: o0[0] / f, y: -o0[1] / f }, r = da * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const rot = (p) => { const x = p.x - c.x, y = p.y - c.y; return { x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs }; };     // plan y is down: positive = clockwise on screen
    t.roof.points.forEach((q, i) => { const n = rot(base.pts[i]); q.x = n.x; q.y = n.y; });
    (t.roof.objects || []).forEach((o, i) => { const n = rot(base.obj[i]); o.x = n.x; o.y = n.y; o.rot = ((base.obj[i].rot + da) % 360 + 360) % 360; });
    t.roof.azimuth = ((base.az + da) % 360 + 360) % 360;
  },
  _scaleRoof(t, base, o0, kx, ky, kz) {
    const f = PlanEngine.factor(), c = { x: o0[0] / f, y: -o0[1] / f };
    t.roof.points.forEach((q, i) => { q.x = c.x + (base.pts[i].x - c.x) * kx; q.y = c.y + (base.pts[i].y - c.y) * ky; });
    (t.roof.objects || []).forEach((o, i) => { o.x = c.x + (base.obj[i].x - c.x) * kx; o.y = c.y + (base.obj[i].y - c.y) * ky; });
    if (kz !== 1) t.roof.eave = Math.max(2, Math.min(15, base.eave * kz));
  },

  _pick(id, e) {
    const [kind, a, b] = String(id).split(':');
    const v = this.view, f = PlanEngine.factor();
    if (kind === 'h' && (a === 'eave' || a === 'ridge')) {                  // a handle: drag vertically
      const roof = this._roof(b), it = this._item(b); if (!roof || !it) return null;
      const e0 = RoofPlanes.eave(roof), p0 = +roof.pitch || 0, rise0 = Math.max(0.05, this._ridgeZ(it) - it.eave), ap0 = +roof.apex || 1.8;
      const dz = (dy) => -dy / (v.scale() * Math.cos(v.pitch * Math.PI / 180));
      return {
        move: (ev, x, y, dx, dy) => {
          if (a === 'eave') roof.eave = Math.max(2, Math.min(15, this._snap(e0 + dz(dy))));
          else if (roof.shape === 'pyramid') roof.apex = Math.max(0.1, Math.min(12, this._snap(ap0 + dz(dy))));
          else roof.pitch = Math.max(0, Math.min(60, Math.round(Math.atan(Math.tan(p0 * Math.PI / 180) * Math.max(0, rise0 + dz(dy)) / rise0) * 1800 / Math.PI) / 10));
          this._live();
        },
        up: (ev, moved) => { if (moved) this._commit(); },
      };
    }
    if ((kind === 'g' || kind === 's') && this.tool === 'transform') return this._gizmoDrag(kind, a, e);
    if (this.tool !== 'transform' || !f) return null;
    if (kind === 'o') {                                                     // an object: select it and slide it over the roof
      const roof = PlanSolar.roofs().find(r => (r.objects || []).some(o => o.id === a)); if (!roof) return null;
      this.sel = { roof: roof.id, obj: a }; this._fire('onPanel');
      return this._freeDrag(e);
    }
    if (kind === 'p') {                                                     // a roof: select it and slide it
      const roof = this._roof(a), it = this._item(a); if (!roof || !it) return null;
      this.sel = { roof: a, plane: +b }; this._fire('onPanel');
      return this._freeDrag(e);
    }
    return null;
  },
  // A drag of the selected target over the ground, free or locked to X / Y.
  _freeDrag(e) {
    const t = this._target(), v = this.view; if (!t) return null;
    const o0 = this._gizmoOrigin(t), base = this._capture(t), start = v.planeAt(...v._pos(e), o0[2]);
    return {
      move: (ev, x, y) => {
        const p = v.planeAt(x, y, o0[2]); let dx = p[0] - start[0], dy = p[1] - start[1];
        if (this.axis === 'x') dy = 0; if (this.axis === 'y') dx = 0;
        this._moveBy(t, base, this._snap(dx), this._snap(dy)); this._live();
      },
      up: (ev, moved) => { if (moved) this._commit(); else this._fire('onPanel'); },
    };
  },

  _click(id, e) {
    const f = PlanEngine.factor();
    if (!id) {
      if (this.tool === 'footprint' && f && typeof PlanRoomDetect !== 'undefined') {       // draw on the ground in 3D
        const [sx, sy] = this.view._pos(e), p = this.view.planeAt(sx, sy, 0);
        PlanRoomDetect.drawClick({ x: this._snap(p[0]) / f, y: -this._snap(p[1]) / f }, 'roof');
        if (this.view) this.view.redraw(); this._fire('onPanel'); return;
      }
      this.sel = null; this._fire('onPanel'); if (this.view) this.view.redraw(); return;
    }
    const [kind, a, b] = String(id).split(':');
    if (kind === 'p') {
      if (this.tool === 'object' && f) {
        const it = this._item(a), pl = it && it.pls[+b], roof = this._roof(a);
        if (pl) {
          const [sx, sy] = this.view._pos(e), p = this._pointOnPlane(pl, sx, sy);
          const o = PlanSolar.addObject(roof, this.addType, { x: this._snap(p[0]) / f, y: -this._snap(p[1]) / f });
          this.sel = { roof: a, obj: o.id };
          this._rebuild();
          return;
        }
      }
      this.sel = { roof: a, plane: +b };
    } else if (kind === 'o') {
      const roof = PlanSolar.roofs().find(r => (r.objects || []).some(o => o.id === a));
      this.sel = roof ? { roof: roof.id, obj: a } : null;
    }
    this._fire('onPanel'); if (this.view) this.view.redraw();
  },

  // A typed value from the status bar, applied to what the current tool is doing (Enter).
  applyTyped(val) {
    const n = parseFloat(val); if (!Number.isFinite(n)) return false;
    const f = PlanEngine.factor(), t = this._target();
    if (this.tool === 'footprint') {                                         // the next edge, this long, toward the pointer
      const D = typeof PlanRoomDetect !== 'undefined' ? PlanRoomDetect.draft : null;
      if (!D || !D.pts || !D.pts.length || !f || !(n > 0)) return false;
      const last = D.pts[D.pts.length - 1], h = D.hover || { x: last.x + 1, y: last.y };
      let dx = h.x - last.x, dy = h.y - last.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      if (this.axis === 'x') { dx = Math.sign(dx) || 1; dy = 0; } else if (this.axis === 'y') { dx = 0; dy = Math.sign(dy) || 1; }
      PlanRoomDetect.drawClick({ x: last.x + dx * n / f, y: last.y + dy * n / f }, 'roof');
      return true;
    }
    const roof = t ? t.roof : this._roof(this._selRoofId()); if (!roof) return false;
    if (this.tool === 'pushpull') PlanSolar.update(roof.id, { eave: Math.max(2, Math.min(15, n)) });
    else if (this.tool === 'ridge') PlanSolar.update(roof.id, roof.shape === 'pyramid' ? { apex: Math.max(0.1, n) } : { pitch: Math.max(0, Math.min(60, n)) });
    else if (this.tool === 'transform' && t && f) {                          // a distance along the locked axis (X when none), a turn, or a scale factor
      const base = this._capture(t);
      if (this.gizmo === 'move') { const ax = this.axis === 'y' ? [0, 1] : [1, 0]; this._moveBy(t, base, ax[0] * n, ax[1] * n); }
      else if (this.gizmo === 'rotate') { if (t.kind === 'obj') t.o.rot = ((base.rot - n) % 360 + 360) % 360; else this._rotateRoof(t, base, this._gizmoOrigin(t), n); }
      else if (n > 0) { if (t.kind === 'obj') { t.o.w = base.w * n; t.o.d = base.d * n; t.o.h = base.h * n; } else this._scaleRoof(t, base, this._gizmoOrigin(t), n, n, 1); }
    } else if (this.tool === 'object' && t && t.kind === 'obj') t.o.h = Math.max(0.02, n);
    else return false;
    this._commit();
    return true;
  },

  _ridgeZ(it) { let m = it.eave; for (const pl of it.pls) for (const q of pl.poly) m = Math.max(m, pl.zAt(q[0], q[1])); return m; },
  _ridgePoint(it) { let best = null, m = -1; for (const pl of it.pls) for (const q of pl.poly) { const z = pl.zAt(q[0], q[1]); if (z > m + 1e-9) { m = z; best = [q[0], q[1], z]; } } return best; },

  // The height of the roof along a wall (the wall's top follows the roof): the highest plane that has the point on it.
  _roofZ(it, x, y) {
    let best = Infinity, z = it.eave;
    for (const pl of it.pls) {
      const d = this._inside([x, y], pl.poly) ? 0 : this._edgeDist([x, y], pl.poly);
      if (d < best - 1e-9) { best = d; z = pl.zAt(x, y); } else if (Math.abs(d - best) <= 1e-9) z = Math.max(z, pl.zAt(x, y));
    }
    return z;
  },

  // Things standing or lying on a roof are painted in a layer above the roof's own faces, so one hidden behind the ridge, a wall or
  // the roof it sits under would show through. `occluders(sc)` lists the solid faces (walls, planes, decks) as polygons with a normal;
  // `hidden(p, w, occ)` says whether the ray from p toward the viewer (direction w, the view is parallel) is stopped by one of them.
  occluders(sc) {
    const out = [], add = (pts) => {
      let n = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
      const m = Math.hypot(n[0], n[1], n[2]); if (m < 1e-9) return;
      n = n.map(x => x / m);
      const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2), u = ax === 0 ? 1 : 0, w = ax === 2 ? 1 : 2;
      out.push({ pts, n, ax, u, w, d: n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2] });
    };
    for (const it of sc.items) {
      const P = it.poly, e = it.eave, flat = it.roof.shape === 'flat';
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], top = [];
        if (flat) top.push([b[0], b[1], e], [a[0], a[1], e]);
        else for (let k = 8; k >= 0; k--) { const x = a[0] + (b[0] - a[0]) * k / 8, y = a[1] + (b[1] - a[1]) * k / 8; top.push([x, y, this._roofZ(it, x, y)]); }
        add([[a[0], a[1], 0], [b[0], b[1], 0]].concat(top));
      }
      if (flat) add(P.map(q => [q[0], q[1], e + this.PARAPET_M]));
      else for (const pl of it.pls) add(pl.poly.map(q => [q[0], q[1], pl.zAt(q[0], q[1])]));
    }
    return out;
  },
  hidden(p, w, occ) {
    const o = [p[0] + w[0] * 0.03, p[1] + w[1] * 0.03, p[2] + w[2] * 0.03];
    for (const f of occ) {
      const dn = f.n[0] * w[0] + f.n[1] * w[1] + f.n[2] * w[2]; if (Math.abs(dn) < 1e-9) continue;
      const t = (f.d - (f.n[0] * o[0] + f.n[1] * o[1] + f.n[2] * o[2])) / dn; if (t < 1e-6) continue;
      const x = [o[0] + w[0] * t, o[1] + w[1] * t, o[2] + w[2] * t], px = x[f.u], py = x[f.w];
      let inside = false;
      for (let i = 0, j = f.pts.length - 1; i < f.pts.length; j = i++) {
        const a = f.pts[i], b = f.pts[j];
        if ((a[f.w] > py) !== (b[f.w] > py) && px < (b[f.u] - a[f.u]) * (py - a[f.w]) / (b[f.w] - a[f.w]) + a[f.u]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  },
  draw(v) {
    const sc = this.scene; if (!sc) return;
    const occ = this.occluders(sc), vw = v.viewDir ? v.viewDir() : [0, 0, 1], mid = (q) => q.reduce((a, p) => [a[0] + p[0] / q.length, a[1] + p[1] / q.length, a[2] + p[2] / q.length], [0, 0, 0]);
    for (const it of sc.items) {
      const r = it.roof, P = it.poly, e = it.eave, flat = r.shape === 'flat';
      for (let i = 0; i < P.length; i++) {                                    // walls, their tops following the roof
        const a = P[i], b = P[(i + 1) % P.length];
        const top = [];
        if (flat) top.push([b[0], b[1], e], [a[0], a[1], e]);
        else for (let k = 24; k >= 0; k--) { const x = a[0] + (b[0] - a[0]) * k / 24, y = a[1] + (b[1] - a[1]) * k / 24; top.push([x, y, this._roofZ(it, x, y)]); }
        v.face({ pts: [[a[0], a[1], 0], [b[0], b[1], 0]].concat(top), fill: '#d9d4c7', stroke: '#9a9486', lw: 1, layer: 1 });
      }
      for (const j of (it.junctions || [])) v.face({ pts: [[j.a[0], j.a[1], j.z0], [j.b[0], j.b[1], j.z0], [j.b[0], j.b[1], e], [j.a[0], j.a[1], e]], fill: '#cfc9bb', stroke: '#9a9486', lw: 1, layer: 1 });
      if (flat) {                                                              // flat roof and parapet
        v.face({ pts: P.map(q => [q[0], q[1], e + this.PARAPET_M]), fill: '#c9ccd1', stroke: '#6b7280', lw: 1, layer: 1, pick: 'p:' + r.id + ':0' });
      } else {
        it.pls.forEach((pl, i) => {
          const on = this.sel && this.sel.roof === r.id && this.sel.plane === i;
          v.face({ pts: pl.poly.map(q => [q[0], q[1], pl.zAt(q[0], q[1])]), fill: pl.lean ? '#c98a55' : it.use[i] ? '#b7653a' : '#9c5430', stroke: on ? '#1d4ed8' : '#6b3a1f', lw: on ? 2.5 : 1, layer: 1, pick: 'p:' + r.id + ':' + i });
        });
      }
      it.mods.forEach((m, i) => { if (!this.hidden(mid(m), vw, occ)) v.face({ pts: m, fill: it.shaded && it.shaded[i] ? '#7b8794' : '#27506b', stroke: '#9fc4dd', lw: 0.8, layer: 2 }); });
      const c = P.reduce((a, q) => [a[0] + q[0] / P.length, a[1] + q[1] / P.length], [0, 0]);
      v.label({ at: [c[0], c[1], this._ridgeZ(it) + 1.2], text: `${r.name} · ${it.mods.length} modules`, color: '#1f2937', size: 12, bold: true });
      const hs = Math.max(0.12, v.radius * 0.025);                              // handles for the Push / pull and Ridge tools
      const handle = (at, id, color) => V3D.box(v, [at[0], at[1]], hs * 2, hs * 2, at[2] - hs, hs * 2, 0, { color, stroke: '#ffffff', lw: 1.5, pick: id, layer: 3 });
      if (this.tool === 'pushpull') { const q = P[0]; handle([q[0], q[1], e], 'h:eave:' + r.id, '#1d4ed8'); v.line({ pts: [[q[0], q[1], 0], [q[0], q[1], e]], stroke: '#1d4ed8', lw: 1.5, dash: [4, 3], layer: 3 }); v.label({ at: [q[0], q[1], e + hs * 3], text: 'eave ' + e.toFixed(2) + ' m', color: '#1d4ed8', size: 12, bold: true }); }
      if (this.tool === 'ridge' && !flat) { const q = this._ridgePoint(it); if (q) { handle(q, 'h:ridge:' + r.id, '#1d4ed8'); v.label({ at: [q[0], q[1], q[2] + hs * 3], text: (r.shape === 'pyramid' ? 'apex ' + (+r.apex || 1.8).toFixed(2) + ' m' : (+r.pitch).toFixed(1) + '°') + ' · ridge ' + q[2].toFixed(2) + ' m', color: '#1d4ed8', size: 12, bold: true }); } }
    }
    for (const sp of (sc.shadowPolys || [])) if (!this.hidden(mid(sp.pts), vw, occ)) v.face({ pts: sp.pts, fill: 'rgba(30,41,59,0.38)', stroke: null, lw: 0, layer: sp.kind === 'ground' ? 0.5 : 1.5 });
    for (const o of (sc.objs || [])) {                                         // objects standing on the roofs
      const on = this.sel && this.sel.obj === o.id;
      if (!on && this.hidden([o.c[0], o.c[1], o.z0 + o.hh / 2], vw, occ)) continue;                     // behind the roof or a wall
      V3D.box(v, o.c, o.w, o.d, o.z0, o.hh, -o.rot, { color: on ? '#bfdbfe' : '#f3f4f6', stroke: on ? '#1d4ed8' : '#111827', lw: on ? 2 : 1, pick: 'o:' + o.id, layer: 2.5 });
      v.label({ at: [o.c[0], o.c[1], o.z0 + o.hh + 0.1], text: (PlanSolar.OBJECT_TYPES[o.type] || { label: o.type }).label, color: '#111827', size: 11 });
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
    this._drawGizmo(v);
    this._drawDraft(v);
    // true north: an arrow on the ground beside the roofs, turned by the plan's north angle
    const na = (sc.north || 0) * Math.PI / 180, dx = Math.sin(na), dy = Math.cos(na), R = v.radius;
    const bx = v.target[0] + R * 0.75 * Math.sin(na + 1.2), by = v.target[1] + R * 0.75 * Math.cos(na + 1.2), L = R * 0.25;
    const tail = [bx - dx * L / 2, by - dy * L / 2, 0.05], tip = [bx + dx * L / 2, by + dy * L / 2, 0.05];
    v.line({ pts: [tail, tip], stroke: '#111827', lw: 3 });
    v.line({ pts: [[tip[0] - dx * L * 0.25 + dy * L * 0.12, tip[1] - dy * L * 0.25 - dx * L * 0.12, 0.05], tip, [tip[0] - dx * L * 0.25 - dy * L * 0.12, tip[1] - dy * L * 0.25 + dx * L * 0.12, 0.05]], stroke: '#111827', lw: 3 });
    v.label({ at: [tip[0] + dx * L * 0.3, tip[1] + dy * L * 0.3, 0.05], text: 'N', color: '#111827', size: 13, bold: true });
  },

  // The Transform tool's gizmo on the selected roof or object: arrows (X red, Y green, Z blue), a turn ring or scale handles.
  _drawGizmo(v) {
    if (this.tool !== 'transform') return;
    const t = this._target(); if (!t) return;
    const o = this._gizmoOrigin(t), L = Math.max(0.6, v.radius * 0.22), hd = L * 0.16;
    const col = { x: '#c2362b', y: '#1e7a46', z: '#1d4ed8' }, dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const at = (k, s) => [o[0] + dir[k][0] * s, o[1] + dir[k][1] * s, o[2] + dir[k][2] * s];
    if (this.gizmo === 'rotate') {
      const pts = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; pts.push([o[0] + Math.sin(a) * L, o[1] + Math.cos(a) * L, o[2]]); }
      v.line({ pts, stroke: '#1d4ed8', lw: 4, pick: 'g:r', layer: 3 });
      v.label({ at: [o[0], o[1] + L, o[2]], text: 'turn', color: '#1d4ed8', size: 11, bold: true });
      return;
    }
    for (const k of ['x', 'y', 'z']) {
      const tip = at(k, L), perp = k === 'z' ? [1, 0, 0] : [0, 0, 1], perp2 = k === 'z' ? [0, 1, 0] : (k === 'x' ? [0, 1, 0] : [1, 0, 0]);
      if (this.gizmo === 'scale') {
        v.line({ pts: [o, tip], stroke: col[k], lw: 2.5, layer: 3 });
        V3D.box(v, [tip[0], tip[1]], hd * 1.6, hd * 1.6, tip[2] - hd * 0.8, hd * 1.6, 0, { color: col[k], stroke: '#ffffff', lw: 1, pick: 's:' + k, layer: 3 });
      } else {
        const b = at(k, L - hd * 2), p1 = [b[0] + perp[0] * hd, b[1] + perp[1] * hd, b[2] + perp[2] * hd], p2 = [b[0] - perp[0] * hd, b[1] - perp[1] * hd, b[2] - perp[2] * hd];
        const p3 = [b[0] + perp2[0] * hd, b[1] + perp2[1] * hd, b[2] + perp2[2] * hd], p4 = [b[0] - perp2[0] * hd, b[1] - perp2[1] * hd, b[2] - perp2[2] * hd];
        v.line({ pts: [o, tip], stroke: col[k], lw: 3.5, pick: 'g:' + k, layer: 3 });
        v.face({ pts: [p1, tip, p2], fill: col[k], stroke: col[k], lw: 1, pick: 'g:' + k, layer: 3 });
        v.face({ pts: [p3, tip, p4], fill: col[k], stroke: col[k], lw: 1, pick: 'g:' + k, layer: 3 });
      }
      v.label({ at: at(k, L + hd * 2), text: k.toUpperCase(), color: col[k], size: 12, bold: true });
    }
  },
  // The footprint being drawn (the plan tool's draft), on the ground.
  _drawDraft(v) {
    if (this.tool !== 'footprint' || typeof PlanRoomDetect === 'undefined') return;
    const D = PlanRoomDetect.draft, f = PlanEngine.factor(); if (!D || !D.pts || !D.pts.length || !f) return;
    const m = (p) => [p.x * f, -p.y * f, 0.05], pts = D.pts.map(m);
    if (D.hover) pts.push(m(D.hover));
    v.line({ pts, stroke: '#1d4ed8', lw: 2.5, dash: [6, 4], layer: 3 });
    for (const q of D.pts.map(m)) v.glow({ at: q, r: Math.max(0.15, v.radius * 0.02), color: 'rgba(29,78,216,.8)' });
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Roof3D;
