/* ProtectionPro — RoofPlanes: the planes of a roof over a footprint, and the modules laid on them. Pure geometry.
 *
 * Frame: metres, x east, y north (`Roof3D.toMetres`), in the PLAN's frame (plan up = +y). A roof's `azimuth` is a
 * true azimuth; the caller passes `paz` (the plan bearing the roof faces, `PlanSolar.planAz`) and `north` (the
 * plan's north angle) so each plane knows both its plan bearing `az` and its true azimuth `trueAz`.
 *
 * `planes(poly, roof, paz, north)` returns `[{name, az, trueAz, pitch, poly:[[x,y]], zAt(x, y)}]`:
 *   gable  two planes either side of a ridge across the facing direction (Roof3D.gablePlanes)
 *   mono   one plane over the whole footprint, falling toward the facing direction
 *   hip    one plane per footprint edge, each at the roof pitch; a square footprint ends in an apex (a pyramid),
 *          a longer one in a ridge. Exact for convex footprints; an L / T / U should be split into wings first.
 *   pyramid one triangle per edge to an apex `roof.apex` m above the eave (a convex footprint)
 *   flat   one level deck (racks are laid by Roof3D.layoutRacks)
 *   wings  a cross-gable L / T / U (axis-aligned outline): one gable per wing, the cross wings stopping at the main
 *          wing's ridge, the planes cut where they cross (the valleys)
 * `roof.lean` = {side: 'front'|'back'|'end'|'end2', kind: 'under'|'catslide', depth, pitch, high} adds a lean-to on a
 * rectangular footprint: a separate shallow plane under the eave, or (catslide, gable) the facing plane carried on down.
 * `model()` returns `{planes, foot, junctions}`: the footprint with any lean-to, and the wall strips above a lean-to.
 * `eave` is `roof.eave` (default 3 m): the height of the lowest edge. Uses Roof3D's clip / axes / usable tests.
 */
const RoofPlanes = {
  SHAPES: ['gable', 'hip', 'mono', 'pyramid', 'wings', 'flat'],
  LABELS: { gable: 'Gable', hip: 'Hip', mono: 'Mono-pitch', pyramid: 'Pyramid', wings: 'Cross-gable (L / T / U)', flat: 'Flat' },
  DEFAULT_EAVE: 3,

  eave(roof) { const e = +roof.eave; return e > 0 ? e : this.DEFAULT_EAVE; },
  _norm(a) { return ((a % 360) + 360) % 360; },
  compass(az) { return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(this._norm(az) / 45) % 8]; },
  _area(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; },

  // Drop vertices that sit on the line between their neighbours (and repeated points).
  simplify(poly) {
    let P = poly.map(p => [p[0], p[1]]), again = true;
    while (again && P.length > 3) {
      again = false;
      for (let i = 0; i < P.length; i++) {
        const a = P[(i + P.length - 1) % P.length], b = P[i], c = P[(i + 1) % P.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < 1e-9 || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) { P.splice(i, 1); again = true; break; }
      }
    }
    return P;
  },

  _mk(name, az, north, pitch, poly, zAt) {
    return { name: name + ' plane', az: this._norm(az), trueAz: this._norm(az - north), pitch, poly, zAt };
  },

  // A hip over a convex polygon: each point belongs to the edge it is nearest, and rises at the pitch from it.
  hipPlanes(poly, pitch, eave, north) {
    let P = this.simplify(poly);
    if (this._area(P) < 0) P = P.slice().reverse();                         // counter-clockwise: the outward normal is on the right
    const t = Math.tan(pitch * Math.PI / 180), n = P.length;
    const E = P.map((a, i) => {
      const b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return { a, nx: dy / l, ny: -dx / l };
    });
    const dist = (e, x, y) => -((x - e.a[0]) * e.nx + (y - e.a[1]) * e.ny);   // inward distance to the edge's line
    const out = [];
    E.forEach((ei, i) => {
      let region = P;
      E.forEach((ej, j) => { if (j !== i && region.length >= 3) region = Roof3D.clip(region, p => dist(ej, p[0], p[1]) - dist(ei, p[0], p[1])); });
      if (region.length < 3 || Math.abs(this._area(region)) < 1e-6) return;
      const az = Math.atan2(ei.nx, ei.ny) * 180 / Math.PI;
      const pl = this._mk(this.compass(az - north)[0].toUpperCase() + this.compass(az - north).slice(1), az, north, pitch, region, (x, y) => eave + t * dist(ei, x, y));
      out.push(pl);
    });
    return out;
  },

  // ── Lean-to ──
  _frame(poly, paz) {
    const { u, w } = Roof3D.axes(paz), ss = poly.map(p => p[0] * u[0] + p[1] * u[1]), vs = poly.map(p => p[0] * w[0] + p[1] * w[1]);
    const fr = { u, w, smin: Math.min(...ss), smax: Math.max(...ss), vmin: Math.min(...vs), vmax: Math.max(...vs) };
    fr.at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    return fr;
  },
  _isRect(poly, fr) { return Math.abs(Math.abs(this._area(poly)) - (fr.smax - fr.smin) * (fr.vmax - fr.vmin)) < 1e-6 * Math.max(1, (fr.smax - fr.smin) * (fr.vmax - fr.vmin)) + 1e-9; },
  _bearing(d) { return this._norm(Math.atan2(d[0], d[1]) * 180 / Math.PI); },
  // The lean-to on a rectangular footprint: {foot, strip, d, c0, depth} or null (no lean-to, or the footprint is not a rectangle).
  lean(poly, roof, paz) {
    const L = roof.lean; if (!L || !(+L.depth > 0) || roof.shape === 'flat' || roof.shape === 'wings') return null;
    const fr = this._frame(poly, paz); if (!this._isRect(poly, fr)) return null;
    const dep = +L.depth, side = L.side || 'front';
    let d, c0, strip, foot;
    if (side === 'front') { d = fr.u; c0 = fr.smax; strip = [fr.at(fr.vmin, fr.smax), fr.at(fr.vmax, fr.smax), fr.at(fr.vmax, fr.smax + dep), fr.at(fr.vmin, fr.smax + dep)]; foot = [fr.at(fr.vmin, fr.smin), fr.at(fr.vmax, fr.smin), fr.at(fr.vmax, fr.smax + dep), fr.at(fr.vmin, fr.smax + dep)]; }
    else if (side === 'back') { d = [-fr.u[0], -fr.u[1]]; c0 = -fr.smin; strip = [fr.at(fr.vmax, fr.smin), fr.at(fr.vmin, fr.smin), fr.at(fr.vmin, fr.smin - dep), fr.at(fr.vmax, fr.smin - dep)]; foot = [fr.at(fr.vmin, fr.smin - dep), fr.at(fr.vmax, fr.smin - dep), fr.at(fr.vmax, fr.smax), fr.at(fr.vmin, fr.smax)]; }
    else if (side === 'end') { d = fr.w; c0 = fr.vmax; strip = [fr.at(fr.vmax, fr.smax), fr.at(fr.vmax, fr.smin), fr.at(fr.vmax + dep, fr.smin), fr.at(fr.vmax + dep, fr.smax)]; foot = [fr.at(fr.vmin, fr.smin), fr.at(fr.vmax + dep, fr.smin), fr.at(fr.vmax + dep, fr.smax), fr.at(fr.vmin, fr.smax)]; }
    else { d = [-fr.w[0], -fr.w[1]]; c0 = -fr.vmin; strip = [fr.at(fr.vmin, fr.smin), fr.at(fr.vmin, fr.smax), fr.at(fr.vmin - dep, fr.smax), fr.at(fr.vmin - dep, fr.smin)]; foot = [fr.at(fr.vmin - dep, fr.smin), fr.at(fr.vmax, fr.smin), fr.at(fr.vmax, fr.smax), fr.at(fr.vmin - dep, fr.smax)]; }
    return { foot, strip, d, c0, depth: dep, kind: L.kind === 'catslide' && roof.shape === 'gable' && (side === 'front' || side === 'back') ? 'catslide' : 'under' };
  },

  // The planes, the footprint (with a lean-to) and the wall strips above a lean-to.
  model(poly, roof, paz, north) {
    const ln = this.lean(poly, roof, paz), eave = this.eave(roof);
    let planes, foot = poly, junctions = [];
    const ov = +roof.overhang > 0 && !ln && ['gable', 'hip', 'mono'].includes(roof.shape) && typeof PlanRoomDetect !== 'undefined' ? +roof.overhang : 0;
    const big = ov ? PlanRoomDetect.insetPolygon(poly, -ov) : null;
    if (big && big.length >= 3) {                                               // eaves reach out `ov`: planes over the bigger outline, meeting the wall at the eave height
      const e2 = Object.assign({}, roof, { eave: eave - Math.tan((+roof.pitch || 0) * Math.PI / 180) * ov });
      planes = this.planes(big, e2, paz, north, null);
    } else planes = this.planes(poly, roof, paz, north, ln);
    if (ln) {
      foot = ln.foot;
      if (ln.kind === 'under') {
        const pitch = +roof.lean.pitch >= 0 ? +roof.lean.pitch : 8, t = Math.tan(pitch * Math.PI / 180), high = +roof.lean.high > 0 ? +roof.lean.high : eave - 0.2, d = ln.d, c0 = ln.c0;
        planes = planes.concat([this._mk(this.compass(this._bearing(d) - north)[0].toUpperCase() + this.compass(this._bearing(d) - north).slice(1) + ' lean-to', this._bearing(d), north, pitch, ln.strip, (x, y) => high - t * (x * d[0] + y * d[1] - c0))].map(p => Object.assign(p, { lean: true })));
        junctions = [{ a: ln.strip[0], b: ln.strip[1], z0: high }];
      }
    }
    return { planes, foot, junctions };
  },

  // A pyramid over a convex polygon: a triangle per edge up to the apex over the middle, `apex` m above the eave.
  pyramidPlanes(poly, apex, eave, north) {
    let P = this.simplify(poly);
    if (this._area(P) < 0) P = P.slice().reverse();
    const n = P.length, cx = P.reduce((a, p) => a + p[0] / n, 0), cy = P.reduce((a, p) => a + p[1] / n, 0), out = [];
    P.forEach((a, i) => {
      const b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = dy / l, ny = -dx / l;
      const dc = -((cx - a[0]) * nx + (cy - a[1]) * ny);
      if (!(dc > 1e-9)) return;
      const az = Math.atan2(nx, ny) * 180 / Math.PI, nm = this.compass(az - north);
      out.push(this._mk(nm[0].toUpperCase() + nm.slice(1), az, north, Math.atan(apex / dc) * 180 / Math.PI, [a, b, [cx, cy]], (x, y) => eave + apex * (-((x - a[0]) * nx + (y - a[1]) * ny)) / dc));
    });
    return out;
  },

  // The rectangles that make up a rectilinear outline, maximal ones only (each may overlap the others): [[x0, y0, x1, y1]].
  maximalRects(poly, tol = 1e-6) {
    const a = this.splitRectilinear(poly, tol); if (!a) return null;
    const b = (this.splitRectilinear(poly.map(p => [p[1], p[0]]), tol) || []).map(r => [r[1], r[0], r[3], r[2]]);
    const all = a.concat(b), inside = (r, q) => r[0] >= q[0] - tol && r[1] >= q[1] - tol && r[2] <= q[2] + tol && r[3] <= q[3] + tol;
    const keep = all.filter((r, i) => !all.some((q, j) => j !== i && inside(r, q) && (!inside(q, r) || j < i)));
    return keep;
  },

  // A cross-gable over an L / T / U: the longest wing is the main one; the others run to its ridge and stop there.
  wingPlanes(poly, pitch, eave, north) {
    const rs = this.maximalRects(poly); if (!rs || !rs.length) return [];
    const t = Math.tan(pitch * Math.PI / 180), long = (r) => Math.max(r[2] - r[0], r[3] - r[1]);
    let mi = 0; rs.forEach((r, i) => { if (long(r) > long(rs[mi]) + 1e-9) mi = i; });
    const main = rs[mi], alongX = (r) => (r[2] - r[0]) >= (r[3] - r[1]) - 1e-9;
    const wings = rs.map((r, i) => {
      let q = r.slice();
      if (i !== mi && alongX(main) !== alongX(r)) {                              // a cross wing: cut at the main wing's ridge
        if (alongX(main)) { const m = (main[1] + main[3]) / 2; q = (r[1] + r[3]) / 2 >= m ? [r[0], Math.max(r[1], m), r[2], r[3]] : [r[0], r[1], r[2], Math.min(r[3], m)]; }
        else { const m = (main[0] + main[2]) / 2; q = (r[0] + r[2]) / 2 >= m ? [Math.max(r[0], m), r[1], r[2], r[3]] : [r[0], r[1], Math.min(r[2], m), r[3]]; }
      }
      const poly2 = [[q[0], q[1]], [q[2], q[1]], [q[2], q[3]], [q[0], q[3]]], az = alongX(r) ? 0 : 90;
      const g = Roof3D.gablePlanes(poly2, az, pitch, eave), { u } = Roof3D.axes(az), sOf = (x, y) => x * u[0] + y * u[1];
      const planes = [
        { az, poly: g.front.map(p => [p[0], p[1]]), zAt: (x, y) => eave + t * (g.smax - sOf(x, y)) },
        { az: az + 180, poly: g.back.map(p => [p[0], p[1]]), zAt: (x, y) => eave + t * (sOf(x, y) - g.smin) },
      ];
      return { rect: q, planes };
    });
    const outside = (piece, q) => {                                            // the parts of a convex piece outside a rectangle
      const out = [], tol = 1e-9, c = (poly, f) => { const r = Roof3D.clip(poly, f); if (r.length >= 3 && Math.abs(this._area(r)) > 1e-9) out.push(r); };
      c(piece, p => q[0] - p[0] - tol); c(piece, p => p[0] - q[2] - tol);
      const band = Roof3D.clip(Roof3D.clip(piece, p => p[0] - q[0]), p => q[2] - p[0]);
      if (band.length >= 3) { c(band, p => q[1] - p[1] - tol); c(band, p => p[1] - q[3] - tol); }
      return out;
    };
    const out = [];
    wings.forEach((W, wi) => W.planes.forEach(P => {
      let pieces = [P.poly];
      wings.forEach((X, xi) => {
        if (xi === wi) return;
        const next = [];
        for (const pc of pieces) {
          next.push(...outside(pc, X.rect));
          for (const XP of X.planes) {
            const inter = Roof3D.clipConvex(pc, XP.poly);
            if (inter.length < 3) continue;
            const bias = wi < xi ? 1e-9 : -1e-9, cut = Roof3D.clip(inter, p => P.zAt(p[0], p[1]) - XP.zAt(p[0], p[1]) + bias);
            if (cut.length >= 3) next.push(cut);
          }
        }
        pieces = next;
      });
      const nm = this.compass(P.az - north), base = nm[0].toUpperCase() + nm.slice(1) + ' plane' + (wings.length > 1 ? ' (wing ' + (wi + 1) + ')' : '');
      for (const pc of pieces) {
        if (Math.abs(this._area(pc)) < 1e-6) continue;
        out.push({ name: base, az: this._norm(P.az), trueAz: this._norm(P.az - north), pitch, poly: pc, zAt: P.zAt, wing: wi });
      }
    }));
    return out;
  },

  planes(poly, roof, paz, north, ln) {
    const eave = this.eave(roof), pitch = roof.shape === 'flat' ? 0 : +roof.pitch || 0, t = Math.tan(pitch * Math.PI / 180);
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const nm = (az) => cap(this.compass(az - north));
    if (roof.shape === 'hip') return this.hipPlanes(poly, pitch, eave, north);
    if (roof.shape === 'pyramid') return this.pyramidPlanes(poly, +roof.apex > 0 ? +roof.apex : 1.8, eave, north);
    if (roof.shape === 'wings') return this.wingPlanes(poly, pitch, eave, north);
    const { u } = Roof3D.axes(paz);
    const sOf = (x, y) => x * u[0] + y * u[1];
    if (roof.shape === 'mono') {
      const smax = Math.max(...poly.map(p => sOf(p[0], p[1])));
      return [this._mk(nm(paz), paz, north, pitch, poly, (x, y) => eave + t * (smax - sOf(x, y)))];
    }
    if (roof.shape === 'flat') {
      const z = eave + (Roof3D.PARAPET_M || 0.4);
      return [this._mk('Flat deck', paz, north, 0, poly, () => z)].map(p => Object.assign(p, { name: 'Flat deck', flat: true }));
    }
    const g = Roof3D.gablePlanes(poly, paz, pitch, eave);                      // gable
    let front = g.front.map(p => [p[0], p[1]]), back = g.back.map(p => [p[0], p[1]]);
    if (ln && ln.kind === 'catslide') {                                         // the facing plane carried on down over the lean-to
      const dir = ln.d, ext = (pl) => pl.map(p => (p[0] * dir[0] + p[1] * dir[1] >= ln.c0 - 1e-6) ? [p[0] + dir[0] * ln.depth, p[1] + dir[1] * ln.depth] : p);
      if (Math.abs(dir[0] - u[0]) + Math.abs(dir[1] - u[1]) < 1e-9) front = ext(front); else back = ext(back);
    }
    return [
      this._mk(nm(paz), paz, north, pitch, front, (x, y) => eave + t * (g.smax - sOf(x, y))),
      this._mk(nm(paz + 180), paz + 180, north, pitch, back, (x, y) => eave + t * (sOf(x, y) - g.smin)),
    ];
  },

  // Which planes carry modules: `roof.planeUse[name]` when set, else a plane facing within ~70° of north (a mono-pitch always).
  // A plane cut into pieces (a cross-gable) is one plane: its pieces share the name and the flag.
  used(planes, roof) {
    const pu = roof.planeUse || {};
    return planes.map(p => pu[p.name] != null ? !!pu[p.name] : (p.flat || p.lean) ? false : (roof.shape === 'mono' || Math.cos(p.trueAz * Math.PI / 180) > 0.34));
  },
  // The planes by name: [{name, idx:[indices of its pieces]}], in order.
  groups(planes) {
    const m = new Map();
    planes.forEach((p, i) => { if (!m.has(p.name)) m.set(p.name, []); m.get(p.name).push(i); });
    return [...m].map(([name, idx]) => ({ name, idx }));
  },

  // Whole modules on one plane (portrait, the long side down the slope), from its low edge up, inside the footprint
  // setback and the plane's own outline. Returns up to `max` quads of four [x, y, z] corners.
  layoutPlane(pl, foot, setback, mod, max, al, ex) {
    const { u, w } = Roof3D.axes(pl.az), cs = Math.cos(pl.pitch * Math.PI / 180);
    const run = mod.len * cs, wid = mod.wid, gap = Math.max(0, +mod.gap || 0), out = [];
    const ss = pl.poly.map(p => p[0] * u[0] + p[1] * u[1]), smax = Math.max(...ss), smin = Math.min(...ss);
    const vs = pl.poly.map(p => p[0] * w[0] + p[1] * w[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const at = (v, s) => [w[0] * v + u[0] * s, w[1] * v + u[1] * s];
    const ok = (p) => Roof3D._usable(p, foot, setback - 1e-6) && (Roof3D._inside(p, pl.poly) || Roof3D._edgeDist(p, pl.poly) < 1e-6);
    const sh = Roof3D.alignShare(al), rowSpace = smax - setback - smin, colSpace = vmax - vmin - 2 * setback;
    const sOff = sh.v * Roof3D.slack(rowSpace, run, gap), vOff = sh.h * Roof3D.slack(colSpace, wid, gap);
    for (let k = 0; k < 400; k++) {
      const s0 = smax - setback - sOff - k * (run + gap), s1 = s0 - run;
      if (s1 < smin - 1e-9) break;
      for (let v = vmin + setback + vOff; v + wid <= vmax - setback + 1e-9; v += wid + gap) {
        const q = [at(v, s0), at(v + wid, s0), at(v + wid, s1), at(v, s1)];
        if (!q.every(ok) || Roof3D.hitsKeepout(q, ex)) continue;
        out.push(q.map(p => [p[0], p[1], pl.zAt(p[0], p[1]) + 0.04]));
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  // Usable module area of a plane (m², along the slope): the plane's outline inside the footprint's setback ÷ cos(pitch).
  usableArea(pl, foot, setback) {
    let region = pl.poly;
    const sb = Math.max(0, +setback || 0);
    if (sb > 0 && typeof PlanRoomDetect !== 'undefined') {
      const ins = PlanRoomDetect.insetPolygon(foot, sb);
      if (!ins || ins.length < 3) return 0;
      region = this.hull(ins).length === ins.length ? Roof3D.clipConvex(region, ins) : region;
    }
    return region.length < 3 ? 0 : Math.abs(this._area(region)) / Math.cos(pl.pitch * Math.PI / 180);
  },
  hull(p) { return Roof3D.hull(p); },

  // ── Wings: a rectilinear L / T / U cut into rectangles, each of which becomes a gable of its own ──
  // `poly` [[x, y]] in the plan frame with axis-aligned edges (tolerance `tol`). Returns rectangles [[x0, y0, x1, y1]]
  // (slabs between the distinct x values, neighbours with the same span merged), or null when an edge is not axis-aligned.
  splitRectilinear(poly, tol = 1e-6) {
    const P = this.simplify(poly), n = P.length;
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; if (Math.abs(a[0] - b[0]) > tol && Math.abs(a[1] - b[1]) > tol) return null; }
    const xs = [...new Set(P.map(p => Math.round(p[0] / tol) * tol))].sort((a, b) => a - b);
    const slabs = [];
    for (let k = 0; k + 1 < xs.length; k++) {
      const xm = (xs[k] + xs[k + 1]) / 2, ys = [];
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        if (Math.abs(a[1] - b[1]) < tol && Math.min(a[0], b[0]) < xm && xm < Math.max(a[0], b[0])) ys.push(a[1]);   // horizontal edges the slab centre crosses
      }
      ys.sort((p, q) => p - q);
      for (let j = 0; j + 1 < ys.length; j += 2) slabs.push([xs[k], ys[j], xs[k + 1], ys[j + 1]]);
    }
    const out = [];
    for (const s of slabs) {
      const m = out.find(r => Math.abs(r[2] - s[0]) < tol && Math.abs(r[1] - s[1]) < tol && Math.abs(r[3] - s[3]) < tol);
      if (m) m[2] = s[2]; else out.push(s.slice());
    }
    return out;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = RoofPlanes;
