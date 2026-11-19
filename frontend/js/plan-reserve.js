/**
 * PlanReserve — streets from road reserves (pure geometry in metres, node-testable: testing/unit/reserve.test.js).
 *
 * A cadastral / layout drawing shows the road as a reserve (the space between the erf boundaries, or one outline per street),
 * not as a centreline. The user clicks inside the road space; this turns the picked space into streets:
 *
 *   stage         the picked space as a raster mask over the drawing's lines (walls): click = add the region under the pointer,
 *                 Alt-click = subtract the connected piece, a drawn polygon adds / subtracts by hand, a cut line closes a
 *                 passage (entrance, a part to drop). Seams between two picked reserves are closed.
 *   contours      outer boundary + every hole (the blocks) of each picked piece, simplified, in metres
 *   streets       the contours as chains for PlanKerbs (a reserve is two "kerbs" further apart; the midline must lie in the
 *                 road space) -> centrelines with the reserve width, an `inside` test keeps a line from pairing through a block
 *   split         streets cut at every intersection (crossings inserted, ends snapped); junctions with their legs
 *   profile       the reserve width along a street, [[s, w], ...]
 *   kerbLines / corners / returnArc / radiusFromDrag
 *                 the carriageway of a street (width + offset from the reserve's centre) and the kerb return (tangent arc)
 *                 at each corner of a junction, with the radius a drag on the plan sets
 *
 * Streets come back as { id, key, pts, w, ws, chains, spans } like PlanKerbs.
 */
const PlanReserve = (() => {
  const K = typeof PlanKerbs !== 'undefined' ? PlanKerbs : require('./plan-kerbs.js');
  const RD = typeof PlanRoomDetect !== 'undefined' ? PlanRoomDetect : require('./plan-roomdetect.js');
  const D = { step: 0.5, gapM: 0.6, wmin: 6, wmax: 40, minStreet: 15, gap: 25, minRun: 8, pairStep: 2, carriageW: 6, ret: 8, retWide: 10, wide: 16, minHoleM2: 6, maxPx: 16e6, snap: 0.5, minPiece: 3 };
  const hyp = Math.hypot, cr = (a, b) => a[0] * b[1] - a[1] * b[0], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const plen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };

  // ───────── raster ─────────
  function makeGrid(box, step, maxPx) {
    maxPx = maxPx || D.maxPx;
    const pad = 3;
    for (;;) {
      const w = Math.ceil((box[2] - box[0]) / step) + 2 * pad, h = Math.ceil((box[3] - box[1]) / step) + 2 * pad;
      if (w * h <= maxPx) return { x0: box[0] - pad * step, y0: box[1] - pad * step, w, h, step };
      step *= 1.5;
    }
  }
  const px = (g, x, y) => [Math.floor((x - g.x0) / g.step), Math.floor((y - g.y0) / g.step)];
  const wxy = (g, i, j) => [g.x0 + i * g.step, g.y0 + j * g.step];
  const inGrid = (g, i, j) => i >= 0 && j >= 0 && i < g.w && j < g.h;
  function drawSeg(g, m, ax, ay, bx, by) {                                           // 1-pixel line (DDA)
    const [x0, y0] = px(g, ax, ay), [x1, y1] = px(g, bx, by), n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) { const i = Math.round(x0 + (x1 - x0) * k / n), j = Math.round(y0 + (y1 - y0) * k / n); if (inGrid(g, i, j)) m[j * g.w + i] = 1; }
  }
  const dil = (m, w, h, r) => r > 0 ? RD._dilate(m, w, h, r) : m;
  const inv = m => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; };
  const ero = (m, w, h, r) => inv(dil(inv(m), w, h, r));
  function label(m, w, h) {                                                          // 4-connected components of the set pixels
    const L = new Int32Array(m.length); let n = 0; const st = [];
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || L[s]) continue; n++; L[s] = n; st.push(s);
      while (st.length) {
        const p = st.pop(), x = p % w;
        if (x > 0 && m[p - 1] && !L[p - 1]) { L[p - 1] = n; st.push(p - 1); }
        if (x < w - 1 && m[p + 1] && !L[p + 1]) { L[p + 1] = n; st.push(p + 1); }
        if (p >= w && m[p - w] && !L[p - w]) { L[p - w] = n; st.push(p - w); }
        if (p < w * (h - 1) && m[p + w] && !L[p + w]) { L[p + w] = n; st.push(p + w); }
      }
    }
    return { L, n };
  }

  // the free space under a click: flood fill inside the walls (thickened by the gap setting, grown back to the wall face)
  function region(g, wall, thick, r, pt) {
    const [i, j] = px(g, pt[0], pt[1]);
    if (!inGrid(g, i, j)) return { ok: false, reason: 'outside' };
    const s = j * g.w + i; if (thick[s]) return { ok: false, reason: 'on-wall' };
    const fill = new Uint8Array(g.w * g.h), st = [s]; fill[s] = 1; let leak = false;
    const w = g.w, h = g.h;
    while (st.length) {
      const p = st.pop(), x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { leak = true; break; }
      if (!fill[p - 1] && !thick[p - 1]) { fill[p - 1] = 1; st.push(p - 1); }
      if (!fill[p + 1] && !thick[p + 1]) { fill[p + 1] = 1; st.push(p + 1); }
      if (!fill[p - w] && !thick[p - w]) { fill[p - w] = 1; st.push(p - w); }
      if (!fill[p + w] && !thick[p + w]) { fill[p + w] = 1; st.push(p + w); }
    }
    if (leak) return { ok: false, reason: 'not-enclosed' };
    const reg = dil(fill, w, h, r); for (let q = 0; q < reg.length; q++) if (wall[q]) reg[q] = 0;
    return { ok: true, mask: reg };
  }

  // outer boundary + holes of every piece of the mask, as closed rings in metres (first point not repeated)
  function contours(g, mask, o) {
    o = Object.assign({}, D, o); const w = g.w, h = g.h, rings = [], eps = Math.max(g.step * 1.2, 0.3);
    const toM = ring => ring.map(p => [g.x0 + p[0] * g.step, g.y0 + p[1] * g.step]);
    const add = (m) => { const r = RD._traceOuter(m, w, h); if (r && r.length >= 3) { const s = RD._dropCollinear(RD._simplifyClosed(r, eps / g.step), 0.05); if (s.length >= 3) rings.push(toM(s)); } };
    const { L, n } = label(mask, w, h);
    for (let c = 1; c <= n; c++) { const m = new Uint8Array(w * h); let cnt = 0; for (let p = 0; p < m.length; p++) if (L[p] === c) { m[p] = 1; cnt++; } if (cnt * g.step * g.step >= o.minHoleM2) add(m); }
    // holes: non-mask pixels not connected to the border
    const free = inv(mask), lf = label(free, w, h), outside = new Set();
    for (let x = 0; x < w; x++) { outside.add(lf.L[x]); outside.add(lf.L[(h - 1) * w + x]); }
    for (let y = 0; y < h; y++) { outside.add(lf.L[y * w]); outside.add(lf.L[y * w + w - 1]); }
    const size = new Int32Array(lf.n + 1); for (let p = 0; p < free.length; p++) if (lf.L[p]) size[lf.L[p]]++;
    for (let c = 1; c <= lf.n; c++) {
      if (outside.has(c) || size[c] * g.step * g.step < o.minHoleM2) continue;
      const m = new Uint8Array(w * h); for (let p = 0; p < m.length; p++) if (lf.L[p] === c) m[p] = 1;
      add(m);
    }
    return rings;
  }

  // ───────── the picked road space ─────────
  // segs: [[x0,y0,x1,y1], ...] in metres (the walls); wa: working-area polygon [[x,y], ...] or null (its edges are walls too)
  function stage(segs, wa, opts) {
    const o = Object.assign({}, D, opts || {});
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const s of segs) { grow(s[0], s[1]); grow(s[2], s[3]); }
    for (const p of wa || []) grow(p[0], p[1]);
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
    const g = makeGrid([x0, y0, x1, y1], o.step, o.maxPx), r = Math.max(1, Math.round(o.gapM / g.step / 2)), w = g.w, h = g.h;
    const base = new Uint8Array(w * h);
    for (const s of segs) drawSeg(g, base, s[0], s[1], s[2], s[3]);
    for (let i = 0; wa && i < wa.length; i++) { const a = wa[i], b = wa[(i + 1) % wa.length]; drawSeg(g, base, a[0], a[1], b[0], b[1]); }
    const T = {
      g, o, ops: [], mask: new Uint8Array(w * h), wall: base.slice(), cuts: [], cutMask: new Uint8Array(w * h), _thick: null, rev: 0, last: null,
      _redo() {                                                           // rebuild the mask from the ops (add / subtract / draw / cut)
        T.wall = base.slice(); T.mask = new Uint8Array(w * h); T.cutMask = new Uint8Array(w * h); T.cuts = []; T._thick = null;
        for (const op of T.ops) T._apply(op);
        T.rev++;
      },
      _thickWall() { if (!T._thick) T._thick = dil(T.wall, w, h, r); return T._thick; },
      _apply(op) {
        if (op.k === 'cut') {
          const m = new Uint8Array(w * h);
          for (let i = 0; i + 1 < op.pts.length; i++) drawSeg(g, m, op.pts[i][0], op.pts[i][1], op.pts[i + 1][0], op.pts[i + 1][1]);
          const th = dil(m, w, h, 1);
          for (let p = 0; p < m.length; p++) if (th[p]) { T.wall[p] = 1; T.mask[p] = 0; T.cutMask[p] = 1; }
          T._thick = null; T.cuts.push(op.pts); return { ok: true };
        }
        if (op.k === 'poly') {
          const m = polyMask(g, op.pts);
          for (let p = 0; p < m.length; p++) if (m[p]) T.mask[p] = op.sub ? 0 : 1;
          if (!op.sub) T._close(); return { ok: true };
        }
        if (op.sub) {
          const [i, j] = px(g, op.pt[0], op.pt[1]); if (!inGrid(g, i, j) || !T.mask[j * w + i]) return { ok: false, reason: 'not-picked' };
          const c = RD._component(T.mask, w, h, j * w + i); for (let p = 0; p < c.length; p++) if (c[p]) T.mask[p] = 0; return { ok: true };
        }
        const rg = region(g, T.wall, T._thickWall(), r, op.pt); if (!rg.ok) return rg;
        let added = 0; for (let p = 0; p < rg.mask.length; p++) if (rg.mask[p] && !T.mask[p]) { T.mask[p] = 1; added++; }
        T._close(); return { ok: true, added };
      },
      _close() {                                                          // a wall pixel between two picked pixels is no wall: the seam of two adjacent reserves goes
        const c = ero(dil(T.mask, w, h, 2), w, h, 2); for (let p = 0; p < c.length; p++) if (c[p] && T.wall[p] && !T.cutPx(p)) T.mask[p] = 1;
      },
      cutPx(p) { return !!T.cutMask[p]; },
      // op: 'add' | 'sub'; returns { ok, reason? }
      click(pt, op) {
        const o2 = { k: 'click', pt, sub: op === 'sub' }, res = T._apply(o2);
        if (res.ok) { T.ops.push(o2); T.rev++; } T.last = res; return res;
      },
      polygon(pts, sub) { const o2 = { k: 'poly', pts, sub: !!sub }; T._apply(o2); T.ops.push(o2); T.rev++; return { ok: true }; },
      cut(pts) { if (pts.length < 2) return { ok: false }; const o2 = { k: 'cut', pts }; T._apply(o2); T.ops.push(o2); T.rev++; return { ok: true }; },
      undo() { if (!T.ops.length) return false; T.ops.pop(); T._redo(); return true; },
      empty() { for (let p = 0; p < T.mask.length; p++) if (T.mask[p]) return false; return true; },
      inside(x, y) { const [i, j] = px(g, x, y); return inGrid(g, i, j) && !!T.mask[j * w + i]; },
      // what a click would add (without adding it): { ok, mask } / { ok: false, reason }
      peek(pt) { return region(g, T.wall, T._thickWall(), r, pt); },
      // where a click that does not close leaks to the outside: the first wall-free pixel on the way out, for the toast
      contours() { return contours(g, T.mask, o); },
      areaM2() { let n = 0; for (let p = 0; p < T.mask.length; p++) if (T.mask[p]) n++; return n * g.step * g.step; },
      streets(o2) { const rings = T.contours(); return streets(rings, Object.assign({ inside: T.inside }, o, { step: g.step }, o2 || {})); },
    };
    return T;
  }
  function polyMask(g, poly) {                                                        // scanline fill of a polygon in metres
    const m = new Uint8Array(g.w * g.h), n = poly.length; if (n < 3) return m;
    for (let j = 0; j < g.h; j++) {
      const y = g.y0 + (j + 0.5) * g.step, xs = [];
      for (let a = 0; a < n; a++) { const p = poly[a], q = poly[(a + 1) % n]; if ((p[1] > y) !== (q[1] > y)) xs.push(p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0])); }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) { const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.step - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / g.step - 0.5)); for (let i = i0; i <= i1; i++) m[j * g.w + i] = 1; }
    }
    return m;
  }

  // ───────── contours -> streets ─────────
  function streets(rings, o) {
    o = Object.assign({}, D, o || {});
    const chains = rings.map(r => ({ pts: r.concat([r[0]]), closed: true }));
    const ko = { wmin: o.wmin, wmax: o.wmax, minStreet: o.minStreet, gap: o.gap, minRun: o.minRun, step: o.pairStep, noRings: true, inside: o.inside };
    const c = K.candidates(chains, ko), a = K.assemble(c, 'all', [], ko, new Set(), false);
    const out = a.streets.map(s => ({ pts: s.pts, w: s.w, chains: s.chains, spans: s.spans })).filter(s => plen(s.pts) >= 1.2 * s.w);   // shorter than it is wide: the two sides of a bulb or a block corner, not a road
    out.forEach(s => { s.ws = profile(s, chains, o).map(q => [q[0], +(q[1] + o.step).toFixed(1)]); s.w = +(s.w + o.step).toFixed(1); });   // the contour runs along the inner face of a one-pixel wall: add it back
    return { streets: out, chains, unpaired: c.unpaired };
  }

  // the reserve width along a street: at every 2 m the nearest contour point straight across on each side
  function profile(street, chains, o) {
    const R = K.resample(street.pts, 2), cs = chains.map(c => K.resample(c.pts, 1)), hi = (street.w || 10) * 1.6 + 2, out = [];
    for (const p of R.S) {
      let l = Infinity, r = Infinity;
      for (const c of cs) {
        const bx = c.box; if (p.x < bx[0] - hi || p.x > bx[2] + hi || p.y < bx[1] - hi || p.y > bx[3] + hi) continue;
        for (const q of c.S) {
          const dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy); if (d > hi || d < 1) continue;
          if (Math.abs(dx * p.tx + dy * p.ty) > 0.35 * d) continue;
          if (p.tx * dy - p.ty * dx > 0) { if (d < l) l = d; } else if (d < r) r = d;
        }
      }
      const w = isFinite(l) && isFinite(r) ? l + r : (isFinite(l) ? 2 * l : isFinite(r) ? 2 * r : street.w);
      out.push([+p.s.toFixed(1), +w.toFixed(1)]);
    }
    return out;
  }

  // ───────── splitting at intersections ─────────
  const rk = (p, m) => Math.round(p[0] / m) + ',' + Math.round(p[1] / m);
  function segHit(a, b, c, d) {                                                       // proper intersection of two segments: [x, y] or null
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = cr(r, s); if (Math.abs(den) < 1e-9) return null;
    const t = cr([c[0] - a[0], c[1] - a[1]], s) / den, u = cr([c[0] - a[0], c[1] - a[1]], r) / den;
    if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
    return [a[0] + r[0] * t, a[1] + r[1] * t];
  }
  function nearOn(pt, pts) {                                                          // nearest point on a polyline: { d, i, q }
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2)) : 0;
      const q = [a[0] + dx * t, a[1] + dy * t], d = hyp(pt[0] - q[0], pt[1] - q[1]); if (!best || d < best.d) best = { d, i, q };
    }
    return best;
  }
  // Split streets at every intersection. In: [{ pts, w, ... }]. Out: { streets, junctions } — one street = the stretch between two
  // junctions (or a junction and a free end); junctions = [{ key, x, y, legs: [{ id, atEnd, dir, len }] }], legs sorted by angle.
  function split(list, o) {
    o = Object.assign({}, D, o || {});
    const S = list.map(s => ({ ...s, pts: s.pts.map(p => p.slice()) }));
    // 1. crossings: a vertex in both streets
    for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
      for (let i = 0; i + 1 < S[a].pts.length; i++) for (let j = 0; j + 1 < S[b].pts.length; j++) {
        const p = segHit(S[a].pts[i], S[a].pts[i + 1], S[b].pts[j], S[b].pts[j + 1]); if (!p) continue;
        S[a].pts.splice(i + 1, 0, p.slice()); S[b].pts.splice(j + 1, 0, p.slice()); i++; break;
      }
    }
    // 2. an end within 1 m of another street is on it: a vertex there, the end snapped to it
    for (let a = 0; a < S.length; a++) for (const atEnd of [false, true]) {
      const P = S[a].pts, tip = atEnd ? P[P.length - 1] : P[0];
      for (let b = 0; b < S.length; b++) {
        if (b === a) continue; const h = nearOn(tip, S[b].pts); if (!h || h.d > 1) continue;
        const v0 = S[b].pts[h.i], v1 = S[b].pts[h.i + 1]; let q = h.q;
        if (hyp(q[0] - v0[0], q[1] - v0[1]) < o.snap) q = v0.slice(); else if (hyp(q[0] - v1[0], q[1] - v1[1]) < o.snap) q = v1.slice(); else S[b].pts.splice(h.i + 1, 0, q.slice());
        if (atEnd) P[P.length - 1] = q.slice(); else P[0] = q.slice();
        break;
      }
    }
    // 3. clusters of vertices from two or more streets are junctions
    const cell = o.snap, hash = new Map(), vs = [];
    S.forEach((s, a) => s.pts.forEach((p, i) => { vs.push({ a, i, p }); const k = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(vs.length - 1); }));
    const par = vs.map((_, i) => i), find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (const [k, ids] of hash) {
      const [cx, cy] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of hash.get((cx + dx) + ',' + (cy + dy)) || []) for (const i of ids) if (i < j && vs[i].a !== vs[j].a && hyp(vs[i].p[0] - vs[j].p[0], vs[i].p[1] - vs[j].p[1]) <= cell) par[find(i)] = find(j);
    }
    const groups = new Map(); vs.forEach((v, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
    const jpt = new Map();                                                            // vertex id -> junction centre
    for (const ids of groups.values()) {
      if (new Set(ids.map(i => vs[i].a)).size < 2) continue;
      let sx = 0, sy = 0; for (const i of ids) { sx += vs[i].p[0]; sy += vs[i].p[1]; } const c = [sx / ids.length, sy / ids.length];
      for (const i of ids) { jpt.set(i, c); S[vs[i].a].pts[vs[i].i] = c.slice(); }
    }
    const idx = new Map(); vs.forEach((v, i) => idx.set(v.a + ':' + v.i, i));
    // 4. cut every street at its interior junction vertices
    const pieces = [];
    S.forEach((s, a) => {
      let from = 0;
      for (let i = 1; i < s.pts.length; i++) {
        if (i < s.pts.length - 1 && !jpt.has(idx.get(a + ':' + i))) continue;
        const pts = s.pts.slice(from, i + 1);
        if (plen(pts) >= o.minPiece && pts.length >= 2) pieces.push({ ...s, pts, parent: a });
        from = i;
      }
    });
    // 5. junctions: the pieces' ends that sit on a junction centre
    const J = new Map();
    const jkey = p => rk(p, o.snap);
    const centres = new Map(); for (const c of jpt.values()) centres.set(jkey(c), c);
    pieces.forEach((s, k) => {
      s.id = 's' + k; s.key = streetKey(s.pts);
      for (const atEnd of [false, true]) {
        const t = atEnd ? s.pts[s.pts.length - 1] : s.pts[0], c = centres.get(jkey(t)); if (!c) continue;
        const key = jkey(c); if (!J.has(key)) J.set(key, { key, x: c[0], y: c[1], legs: [] });
        const dir = K.endDirOut ? K.endDirOut(s.pts, atEnd) : outDir(s.pts, atEnd);
        J.get(key).legs.push({ id: s.id, atEnd, dir, len: plen(s.pts), ang: Math.atan2(dir[1], dir[0]) });
        s['j' + (atEnd ? 'End' : 'Start')] = key;
      }
    });
    const junctions = [...J.values()].filter(j => j.legs.length >= 2).map(j => { j.legs.sort((a, b) => a.ang - b.ang); return j; });
    return { streets: pieces, junctions };
  }
  function outDir(pts, atEnd) {                                                       // unit direction leaving the junction along a street end, read over ~3 m
    const n = pts.length, tip = atEnd ? pts[n - 1] : pts[0]; let far = atEnd ? pts[0] : pts[n - 1];
    for (let k = 1; k < n; k++) { const q = atEnd ? pts[n - 1 - k] : pts[k]; if (hyp(tip[0] - q[0], tip[1] - q[1]) >= 3) { far = q; break; } }
    const d = hyp(far[0] - tip[0], far[1] - tip[1]) || 1; return [(far[0] - tip[0]) / d, (far[1] - tip[1]) / d];
  }
  function streetKey(pts) {                                                           // stable across a recompute: both ends and the middle on a grid, direction-free
    const a = rk(pts[0], 1), b = rk(pts[pts.length - 1], 1), m = rk(pts[pts.length >> 1], 2);
    return a <= b ? a + '~' + m + '~' + b : b + '~' + m + '~' + a;
  }

  // ───────── carriageway and kerb returns ─────────
  // The street's carriageway: `carriageW` wide, `cwOffset` m to the left of the reserve's centre (looking along the street).
  function offsetLine(pts, d) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = hyp(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L;
      if (i > 0 && i < pts.length - 1) {                                              // mitre at a bend (limited)
        const p = pts[i - 1], q = pts[i + 1], e1 = [pts[i][0] - p[0], pts[i][1] - p[1]], e2 = [q[0] - pts[i][0], q[1] - pts[i][1]], l1 = hyp(e1[0], e1[1]) || 1, l2 = hyp(e2[0], e2[1]) || 1;
        const n1 = [-e1[1] / l1, e1[0] / l1], n2 = [-e2[1] / l2, e2[0] / l2], mx = n1[0] + n2[0], my = n1[1] + n2[1], ml = hyp(mx, my) || 1, c = Math.max(0.5, (mx / ml) * n1[0] + (my / ml) * n1[1]);
        nx = mx / ml / c; ny = my / ml / c;
      }
      out.push([+(pts[i][0] + nx * d).toFixed(3), +(pts[i][1] + ny * d).toFixed(3)]);
    }
    return out;
  }
  function kerbLines(street, o) {
    o = Object.assign({}, D, o || {});
    const cw = street.carriageW != null ? street.carriageW : o.carriageW, off = street.cwOffset || 0;
    return { left: offsetLine(street.pts, off + cw / 2), right: offsetLine(street.pts, off - cw / 2) };
  }
  // The offsets (to the left of the outward direction) of a leg's left and right kerb.
  function legKerbs(st, atEnd, o) {
    const cw = st.carriageW != null ? st.carriageW : o.carriageW, off = st.cwOffset || 0;
    return atEnd ? { a: -off + cw / 2, b: -off - cw / 2 } : { a: off + cw / 2, b: off - cw / 2 };
  }
  // Every corner of a junction: between a leg and the next one counter-clockwise. Needs the split streets (by id).
  function corners(junction, byId, o) {
    o = Object.assign({}, D, o || {});
    const L = junction.legs, out = [];
    if (L.length < 2) return out;
    for (let i = 0; i < L.length; i++) {
      const j = (i + 1) % L.length; if (L.length === 2 && i === 1) break;
      const A = L[i], B = L[j], u = A.dir, v = B.dir; let th = Math.atan2(cr(u, v), dot(u, v)); if (th < 0) th += 2 * Math.PI;
      if (th < 0.26 || th > 2.97) continue;                                           // under 15° or over 170°: no corner
      const sa = byId[A.id], sb = byId[B.id]; if (!sa || !sb) continue;
      const ka = legKerbs(sa, A.atEnd, o), kb = legKerbs(sb, B.atEnd, o);
      const na = [-u[1], u[0]], nb = [-v[1], v[0]];
      const pa = [junction.x + na[0] * ka.a, junction.y + na[1] * ka.a], pb = [junction.x + nb[0] * kb.b, junction.y + nb[1] * kb.b];
      const den = cr(u, v); if (Math.abs(den) < 1e-9) continue;
      const t = cr([pb[0] - pa[0], pb[1] - pa[1]], v) / den, P = [pa[0] + u[0] * t, pa[1] + u[1] * t];
      const lim = 0.8 * Math.min(A.len, B.len), tmax = Math.max(0, lim - Math.max(Math.abs(dot([P[0] - junction.x, P[1] - junction.y], u)), Math.abs(dot([P[0] - junction.x, P[1] - junction.y], v))));
      const rmax = Math.max(0, Math.min(30, tmax * Math.tan(th / 2)));
      const wide = Math.max(sa.w || 0, sb.w || 0) > o.wide;
      out.push({ key: `${sa.key || A.id}${A.atEnd ? 'e' : 's'}|${sb.key || B.id}${B.atEnd ? 'e' : 's'}`, jkey: junction.key, a: A.id, b: B.id, P, u, v, theta: th, rmax, def: Math.min(wide ? o.retWide : o.ret, Math.max(rmax, 0)) });
    }
    return out;
  }
  const clampR = (c, R) => Math.max(Math.min(2, c.rmax), Math.min(R, c.rmax || R, 30));
  // The kerb return of one corner at radius R: tangent points, arc centre, the arc as points.
  function returnArc(c, R) {
    R = clampR(c, R); const th = c.theta, t = R / Math.tan(th / 2), s = Math.sin(th / 2);
    const bis = [c.u[0] + c.v[0], c.u[1] + c.v[1]], bl = hyp(bis[0], bis[1]) || 1, b = [bis[0] / bl, bis[1] / bl];
    const t1 = [c.P[0] + c.u[0] * t, c.P[1] + c.u[1] * t], t2 = [c.P[0] + c.v[0] * t, c.P[1] + c.v[1] * t], C = [c.P[0] + b[0] * R / s, c.P[1] + b[1] * R / s];
    const a1 = Math.atan2(t1[1] - C[1], t1[0] - C[0]); let d = Math.atan2(t2[1] - C[1], t2[0] - C[0]) - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(d) / (Math.PI / 18))), pts = [];
    for (let k = 0; k <= n; k++) { const a = a1 + d * k / n; pts.push([+(C[0] + R * Math.cos(a)).toFixed(3), +(C[1] + R * Math.sin(a)).toFixed(3)]); }
    return { R, t, t1, t2, centre: C, mid: [C[0] - b[0] * R, C[1] - b[1] * R], pts };
  }
  // the radius a pointer at `pt` asks for (the arc's midpoint follows the pointer along the corner's bisector)
  function radiusFromDrag(c, pt) {
    const bis = [c.u[0] + c.v[0], c.u[1] + c.v[1]], bl = hyp(bis[0], bis[1]) || 1, b = [bis[0] / bl, bis[1] / bl], s = Math.sin(c.theta / 2);
    const d = Math.max(0, dot([pt[0] - c.P[0], pt[1] - c.P[1]], b));
    return clampR(c, d * s / (1 - s));
  }

  return { D, makeGrid, drawSeg, region, contours, stage, polyMask, streets, profile, split, streetKey, kerbLines, offsetLine, corners, returnArc, radiusFromDrag, outDir, label };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanReserve;
