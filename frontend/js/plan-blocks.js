// PlanBlocks — boundary-first routing for the Auto layout (pure, node-testable: testing/unit/blocks.test.js).
// Every position comes from the erf boundaries. The street lines are used only as topology: "these erven face the same road from the
// same side", "a road runs between these two blocks", "a junction is here, with these legs". Their exact position is never measured from,
// so a street line that is rough, off centre or drawn in pieces moves nothing.
//   1. blocks   : erven that touch, are within `gap` m with no street line between, or face the same street line from the same side within
//                 `gapFace` m with no junction between them, joined into one block (bridge polygons fill the gaps)
//   2. rings    : per cable class, the line `kd` m off each block's boundary on the road side (exact distance field on a 0.25 m grid,
//                 contoured by marching squares), resampled to graph nodes every 0.5 m
//   3. frontage : ring points that face a road (a street line within reach that can be seen without crossing a block)
//   4. sites    : the only places a cable crosses a road. A junction leg (a point where 3+ street lines meet) gets one site, square across
//                 the leg, `setback` m past the end of the corner splay on each block (read from the ring, so from the boundary); every erf
//                 boundary on a frontage gets a mid-block site square across to the facing block's ring
//   5. route    : one Dijkstra over ring edges + site edges; a site costs `xpen` m the first time it is used and `xshare` after, a junction
//                 leg `legExtra` more (rule B, mid-block first)
const PlanBlocks = (() => {
  'use strict';
  const DEFAULTS = { gap: 4, gapFace: 40, cell: 0.25, step: 0.5, setback: 3, maxRes: 40, maxLink: 80, reach: 25, turn: 3, midNearJ: 18, jtol: 4, jmerge: 10, stub: 6 };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1], nrm = a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const plen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };
  function segDist(p, a, b) { const d = sub(b, a), L2 = dot(d, d) || 1e-12; const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)); const q = add(a, mul(d, t)); return [dist(p, q), q]; }
  function pip(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  function nearOnPoly(p, poly) { let best = [Infinity, null]; for (let i = 0; i < poly.length; i++) { const r = segDist(p, poly[i], poly[(i + 1) % poly.length]); if (r[0] < best[0]) best = r; } return best; }
  function segX(a, b, c, d) {                                                     // proper crossing of two segments: t along a–b, or null
    const r = sub(b, a), s = sub(d, c), den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
    const q = sub(c, a), t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? t : null;
  }
  function segXi(a, b, c, d) {                                                    // a ray a→b against c–d, the ends of c–d included
    const r = sub(b, a), s = sub(d, c), den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
    const q = sub(c, a), t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
    return t > 1e-9 && t <= 1 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
  }
  const bbox = pts => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; } return b; };
  const boxGap = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
  function hull(P) {
    const pts = P.map(p => p.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (pts.length < 3) return pts;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function polyPolyDist(A, B) {
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segX(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]) != null) return 0;
    let m = Infinity; for (const v of A) m = Math.min(m, pip(v, B) ? 0 : nearOnPoly(v, B)[0]); for (const v of B) m = Math.min(m, pip(v, A) ? 0 : nearOnPoly(v, A)[0]); return m;
  }
  function rdp(pts, tol) {
    if (pts.length < 3) return pts.map(p => p.slice()); const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]]; while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; for (let i = a + 1; i < b; i++) { const d = segDist(pts[i], pts[a], pts[b])[0]; if (d > md) { md = d; mi = i; } } if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
    return pts.filter((_, i) => keep[i]).map(p => p.slice());
  }
  function resample(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], L = dist(a, b), n = Math.max(1, Math.ceil(L / step)); for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
    return out;
  }

  // a uniform grid of segments, for "does this segment cross any of them" and "nearest of them" queries
  function segIndex(segs, cs) {
    const map = new Map(), key = (i, j) => i + ',' + j;
    segs.forEach((s, k) => { const b = bbox(s); for (let i = Math.floor(b[0] / cs); i <= Math.floor(b[2] / cs); i++) for (let j = Math.floor(b[1] / cs); j <= Math.floor(b[3] / cs); j++) { const q = key(i, j); if (!map.has(q)) map.set(q, []); map.get(q).push(k); } });
    const near = b => { const out = new Set(); for (let i = Math.floor(b[0] / cs); i <= Math.floor(b[2] / cs); i++) for (let j = Math.floor(b[1] / cs); j <= Math.floor(b[3] / cs); j++) { const l = map.get(key(i, j)); if (l) l.forEach(k => out.add(k)); } return out; };
    return {
      crosses(a, b, incl) { for (const k of near(bbox([a, b]))) { const s = segs[k]; if ((incl ? segXi : segX)(a, b, s[0], s[1]) != null) return true; } return false; },
      nearest(p, r) { const out = []; for (const k of near([p[0] - r, p[1] - r, p[0] + r, p[1] + r])) { const s = segs[k], q = segDist(p, s[0], s[1]); if (q[0] <= r) out.push({ d: q[0], q: q[1], k }); } return out.sort((x, y) => x.d - y.d); },
    };
  }

  // ── street lines → junctions (topology only: a point and the directions of its legs) ──
  function junctions(lines, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const S = lines.map((pts, k) => { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i])); return { k, pts, cum, L: cum[cum.length - 1] }; });
    const at = (st, s) => { s = Math.max(0, Math.min(st.L, s)); let i = 1; while (i < st.cum.length - 1 && st.cum[i] < s) i++; const a = st.pts[i - 1], b = st.pts[i], t = (s - st.cum[i - 1]) / ((st.cum[i] - st.cum[i - 1]) || 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
    const proj = (st, p) => { let best = null; for (let i = 1; i < st.pts.length; i++) { const r = segDist(p, st.pts[i - 1], st.pts[i]); if (!best || r[0] < best.d) best = { d: r[0], q: r[1], s: st.cum[i - 1] + dist(st.pts[i - 1], r[1]) }; } return best; };
    const raw = [];
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
      const A = S[i], B = S[j]; if (boxGap(bbox(A.pts), bbox(B.pts)) > o.jtol) continue;
      for (let p = 1; p < A.pts.length; p++) for (let q = 1; q < B.pts.length; q++) { const t = segX(A.pts[p - 1], A.pts[p], B.pts[q - 1], B.pts[q]); if (t != null) { const x = add(A.pts[p - 1], mul(sub(A.pts[p], A.pts[p - 1]), t)); raw.push({ pt: x, items: [[A, proj(A, x).s], [B, proj(B, x).s]] }); } }
      for (const [E, T] of [[A, B], [B, A]]) for (const s0 of [0, E.L]) { const e = at(E, s0), pr = proj(T, e); if (pr.d <= o.jtol) raw.push({ pt: pr.q, items: [[E, s0], [T, pr.s]] }); }
    }
    const cl = [];
    for (const r of raw) { const h = cl.find(c => dist(c.pt, r.pt) < o.jmerge); if (h) r.items.forEach(it => { if (!h.items.some(x => x[0] === it[0])) h.items.push(it); }); else cl.push({ pt: r.pt, items: r.items.slice() }); }
    return cl.map((c, n) => ({ id: 'J' + (n + 1), pt: c.pt, legs: c.items.flatMap(([st, s]) =>
      // a leg shorter than `stub` is a drawing overshoot past the other street, not a leg
      [1, -1].filter(d => (d > 0 ? st.L - s : s) >= o.stub).map(d => {
        const far = Math.min(st.L, Math.max(0, s + d * 12)), far2 = Math.min(st.L, Math.max(0, s + d * 25));
        return { street: st.k, s, u: nrm(sub(at(st, far), c.pt)), u2: nrm(sub(at(st, far2), c.pt)), reach: Math.abs(far - s) };
      })) }));
  }

  // ── 1. blocks ──
  function makeBlocks(erven, lines, J, o) {
    const n = erven.length, par = erven.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
    const SS = []; lines.forEach(pts => { for (let i = 1; i < pts.length; i++) SS.push([pts[i - 1], pts[i]]); });
    const SI = segIndex(SS, 10), boxes = erven.map(e => bbox(e.poly)), bridges = [];
    // which street line each erf faces, from which side and at what station
    const cums = lines.map(pts => { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i])); return c; });
    const face = erven.map(e => {
      const c = [e.poly.reduce((a, p) => a + p[0], 0) / e.poly.length, e.poly.reduce((a, p) => a + p[1], 0) / e.poly.length]; let best = null;
      lines.forEach((pts, k) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], r = segDist(c, a, b);
        if (!best || r[0] < best.d) best = { d: r[0], k, sd: Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])), s: cums[k][i - 1] + dist(a, r[1]) }; } });
      return best;
    });
    const jBetween = (k, s1, s2) => J.some(j => j.legs.length >= 3 && j.legs.some(l => l.street === k && l.s > Math.min(s1, s2) + 1 && l.s < Math.max(s1, s2) - 1));
    const cand = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const fi = face[i], fj = face[j], same = fi && fj && fi.k === fj.k && fi.sd === fj.sd && !jBetween(fi.k, fi.s, fj.s), lim = same ? Math.max(o.gap, o.gapFace) : o.gap;
      if (boxGap(boxes[i], boxes[j]) > lim) continue;
      const d = polyPolyDist(erven[i].poly, erven[j].poly); if (d <= lim) cand.push({ i, j, d, lim });
    }
    cand.sort((a, b) => a.d - b.d);                                                // nearest first: a bridge only where the two are not joined yet
    for (const { i, j, d, lim } of cand) {
      if (find(i) === find(j)) continue;
      if (d < 0.05) { par[find(i)] = find(j); continue; }
      const A = erven[i].poly, B = erven[j].poly, pts = [];
      for (const v of A) { const r = nearOnPoly(v, B); if (r[0] <= lim) pts.push(v, r[1]); }
      for (const v of B) { const r = nearOnPoly(v, A); if (r[0] <= lim) pts.push(v, r[1]); }
      const h = hull(pts); if (h.length < 3) continue;
      let cut = false; for (let k = 0; k < h.length && !cut; k++) cut = SI.crosses(h[k], h[(k + 1) % h.length], true);
      if (!cut) cut = SS.some(([c]) => pip(c, h));
      if (cut) continue;                                                            // a street line between them: two blocks
      bridges.push({ i, j, poly: h }); par[find(i)] = find(j);
    }
    const by = new Map(); erven.forEach((e, i) => { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(i); });
    const blocks = [...by.values()].map((idx, b) => ({ id: 'B' + (b + 1), erven: idx, polys: idx.map(i => erven[i].poly).concat(bridges.filter(x => find(x.i) === find(idx[0])).map(x => x.poly)) }));
    blocks.forEach(B => { B.boxes = B.polys.map(bbox); B.box = bbox(B.polys.flat()); });
    const blockOf = new Map(); blocks.forEach(B => B.erven.forEach(i => blockOf.set(erven[i].id, B)));
    return { blocks, bridges, blockOf, SS, SI };
  }
  function distBlock(B, p) {                                                       // exact distance to a block (0 inside) and the nearest point
    let best = [Infinity, null];
    for (let k = 0; k < B.polys.length; k++) {
      const bx = B.boxes[k]; if (Math.max(0, bx[0] - p[0], p[0] - bx[2], bx[1] - p[1], p[1] - bx[3]) >= best[0]) continue;
      if (pip(p, B.polys[k])) return [0, p];
      const r = nearOnPoly(p, B.polys[k]); if (r[0] < best[0]) best = r;
    }
    return best;
  }

  // ── 2. rings: a narrow-band distance field per block, contoured at each kd ──
  function field(B, band, cell) {
    const m = band + 2 * cell, x0 = B.box[0] - m, y0 = B.box[1] - m, nx = Math.ceil((B.box[2] - B.box[0] + 2 * m) / cell) + 1, ny = Math.ceil((B.box[3] - B.box[1] + 2 * m) / cell) + 1;
    const v = new Float32Array(nx * ny).fill(1e9), r = band + cell;
    for (const poly of B.polys) {
      for (let e = 0; e < poly.length; e++) {                                      // exact distance in a band round every edge
        const a = poly[e], b = poly[(e + 1) % poly.length];
        const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + r - x0) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + r - y0) / cell));
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = x0 + i * cell - a[0], py = y0 + j * cell - a[1], t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2)), d = Math.hypot(px - dx * t, py - dy * t);
          if (d < v[j * nx + i]) v[j * nx + i] = d;
        }
      }
      const pb = bbox(poly);                                                         // inside the polygon: 0
      const j0 = Math.max(0, Math.ceil((pb[1] - y0) / cell)), j1 = Math.min(ny - 1, Math.floor((pb[3] - y0) / cell));
      for (let j = j0; j <= j1; j++) {
        const y = y0 + j * cell, xs = [];
        for (let k = 0, l = poly.length - 1; k < poly.length; l = k++) { const a = poly[k], b = poly[l]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); }
        xs.sort((p, q) => p - q);
        for (let q = 0; q + 1 < xs.length; q += 2) for (let i = Math.max(0, Math.ceil((xs[q] - x0) / cell)); i <= Math.min(nx - 1, Math.floor((xs[q + 1] - x0) / cell)); i++) v[j * nx + i] = 0;
      }
    }
    return { v, x0, y0, nx, ny, cell };
  }
  function contour(F, kd) {
    const { v, x0, y0, nx, ny, cell } = F, V = (i, j) => v[j * nx + i] - kd, P = (i, j) => [x0 + i * cell, y0 + j * cell];
    const lerp = (i1, j1, i2, j2) => { const a = V(i1, j1), b = V(i2, j2), t = a / (a - b), p = P(i1, j1), q = P(i2, j2); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
    const segs = [], pt = new Map();
    const E = (i, j, e) => { const key = e === 'T' ? 'h' + i + ',' + j : e === 'B' ? 'h' + i + ',' + (j + 1) : e === 'L' ? 'v' + i + ',' + j : 'v' + (i + 1) + ',' + j;
      if (!pt.has(key)) pt.set(key, e === 'T' ? lerp(i, j, i + 1, j) : e === 'B' ? lerp(i, j + 1, i + 1, j + 1) : e === 'L' ? lerp(i, j, i, j + 1) : lerp(i + 1, j, i + 1, j + 1)); return key; };
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = V(i, j) < 0, b = V(i + 1, j) < 0, c = V(i + 1, j + 1) < 0, d = V(i, j + 1) < 0, idx = a | b << 1 | c << 2 | d << 3; if (idx === 0 || idx === 15) continue;
      const ctr = (Math.min(V(i, j), 1) + Math.min(V(i + 1, j), 1) + Math.min(V(i + 1, j + 1), 1) + Math.min(V(i, j + 1), 1)) / 4 < 0;
      const T = idx === 1 ? [['L', 'T']] : idx === 2 ? [['T', 'R']] : idx === 3 ? [['L', 'R']] : idx === 4 ? [['R', 'B']] : idx === 5 ? (ctr ? [['T', 'R'], ['B', 'L']] : [['L', 'T'], ['R', 'B']])
        : idx === 6 ? [['T', 'B']] : idx === 7 ? [['L', 'B']] : idx === 8 ? [['B', 'L']] : idx === 9 ? [['T', 'B']] : idx === 10 ? (ctr ? [['L', 'T'], ['R', 'B']] : [['T', 'R'], ['B', 'L']])
        : idx === 11 ? [['R', 'B']] : idx === 12 ? [['L', 'R']] : idx === 13 ? [['T', 'R']] : [['L', 'T']];
      for (const [e1, e2] of T) segs.push([E(i, j, e1), E(i, j, e2)]);
    }
    const at = new Map(); segs.forEach((s, k) => s.forEach(key => { if (!at.has(key)) at.set(key, []); at.get(key).push(k); }));
    const used = new Uint8Array(segs.length), loops = [];
    for (let k = 0; k < segs.length; k++) {
      if (used[k]) continue; used[k] = 1; const keys = [segs[k][0], segs[k][1]];
      for (;;) { const last = keys[keys.length - 1], nx2 = (at.get(last) || []).find(q => !used[q]); if (nx2 == null) break; used[nx2] = 1; keys.push(segs[nx2][0] === last ? segs[nx2][1] : segs[nx2][0]); }
      if (keys[0] === keys[keys.length - 1]) keys.pop();
      if (keys.length >= 8) loops.push(keys.map(q => pt.get(q)));
    }
    return loops;
  }

  // ── the model: blocks once, then one routing graph per cable class (its own ring offset) ──
  // input = { erven: [{ id, poly }], lines: [[x, y]…] per street, classes: { p: kd, f: kd, … } }
  function model(input, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const t0 = Date.now(), lines = (input.lines || []).filter(l => l && l.length >= 2), erven = (input.erven || []).filter(e => e.poly && e.poly.length >= 3);
    const J = junctions(lines, o), real = J.filter(j => j.legs.length >= 3);       // two legs = a joint or a bend in one street, not a junction
    const { blocks, bridges, blockOf, SS, SI } = makeBlocks(erven, lines, J, o);
    const PE = []; blocks.forEach(B => B.polys.forEach(poly => { for (let i = 0; i < poly.length; i++) PE.push([poly[i], poly[(i + 1) % poly.length]]); }));
    const PI = segIndex(PE, 8), crossesBlock = (a, b) => PI.crosses(a, b, false);
    const kds = Object.values(input.classes || { p: 2 }), band = Math.max(...kds) + 1;
    blocks.forEach(B => { B.F = field(B, band, o.cell); });
    const cls = {};
    for (const [name, kd] of Object.entries(input.classes || { p: 2 })) cls[name] = graph(name, kd);
    blocks.forEach(B => { delete B.F; });
    function graph(name, kd) {
      const rings = [];
      for (const B of blocks) for (const loop of contour(B.F, kd)) {
        const pts = resample(rdp(loop.concat([loop[0]]), 0.02), o.step); pts.pop();       // closed: the last point joins the first
        const R = { block: B, pts, n: [], front: [], cum: [0] };
        for (let i = 1; i <= pts.length; i++) R.cum.push(R.cum[i - 1] + dist(pts[i - 1], pts[i % pts.length]));
        R.L = R.cum[pts.length];
        for (const p of pts) {
          const q = distBlock(B, p)[1]; R.n.push(q ? nrm(sub(p, q)) : [0, 0]);
          let ok = false; for (const c of SI.nearest(p, o.reach).slice(0, 4)) if (!crossesBlock(p, c.q)) { ok = true; break; }
          R.front.push(ok);
        }
        rings.push(R); (B.rings || (B.rings = {}))[name] = (B.rings[name] || []).concat([R]);
      }
      const ringAt = (R, s) => { s = ((s % R.L) + R.L) % R.L; let lo = 0, hi = R.pts.length; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cum[m] <= s) lo = m; else hi = m; } const a = R.pts[lo], b = R.pts[hi % R.pts.length], t = (s - R.cum[lo]) / ((R.cum[hi] - R.cum[lo]) || 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
      const tanAt = (R, s, dir) => nrm(mul(sub(ringAt(R, s + 0.75), ringAt(R, s - 0.75)), dir));
      const nearestOnRing = (R, p) => { let b = 0, bd = Infinity; for (let i = 0; i < R.pts.length; i++) { const d = dist(p, R.pts[i]); if (d < bd) { bd = d; b = i; } } return { i: b, s: R.cum[b], d: bd }; };
      const ringNear = (B, p, frontOnly) => { let best = null; for (const R of (B.rings && B.rings[name]) || []) for (let i = 0; i < R.pts.length; i++) { if (frontOnly && !R.front[i]) continue; const d = dist(p, R.pts[i]); if (!best || d < best.d) best = { R, i, s: R.cum[i], d }; } return best; };
      const sites = [], warns = [];
      // junction legs
      for (const Jn of real) for (const leg of Jn.legs) {
        const u = leg.u, nL = [u[1], -u[0]], Q = add(Jn.pt, mul(u, Math.min(15, leg.reach || 15)));
        const al = t => Math.max(dot(t, u), leg.u2 ? dot(t, leg.u2) : -1);
        const hit = sgn => { let best = null; const e = add(Q, mul(nL, sgn * o.maxRes));
          for (const B of blocks) { if (boxGap(B.box, bbox([Q, e])) > 0) continue; for (const poly of B.polys) for (let i = 0; i < poly.length; i++) { const t = segXi(Q, e, poly[i], poly[(i + 1) % poly.length]); if (t != null && (!best || t < best.t)) best = { t, B, H: add(Q, mul(nL, sgn * o.maxRes * t)) }; } }
          return best; };
        const hA = hit(1), hB = hit(-1);
        if (!hA || !hB || (hA.B === hB.B && dist(hA.H, hB.H) < 3)) { warns.push({ j: Jn.id, text: 'a junction leg with erven on one side only' }); continue; }
        const sb = o.setback + (name !== 'p' && o.rule === 'class' ? 4 : 0);           // rule C: a class of its own, its crossing 4 m further along
        const ends = [hA, hB].map(({ B, H }) => {
          // from where the probe ray met the block, back along its ring towards the junction while the ring still runs along the leg: where
          // it stops is the end of the corner splay (local to this leg, whatever else of the block lies near the junction)
          const rn = ringNear(B, H); if (!rn) return null; const R = rn.R, s0 = rn.s;
          const dir = dot(sub(ringAt(R, s0 + 2), Jn.pt), u) > dot(sub(ringAt(R, s0 - 2), Jn.pt), u) ? 1 : -1;
          const t0 = tanAt(R, s0, dir); if (al(t0) < Math.cos(35 * Math.PI / 180)) return null;       // (the street line only says roughly which way the leg runs)
          // the turn is measured against the ring's own direction where the probe met it, so the street line's angle moves nothing
          let sE = 0;
          for (let s = 0.25; s < 60; s += 0.25) { const q = s0 - dir * s; if (dot(tanAt(R, q, dir), t0) < Math.cos(30 * Math.PI / 180) || dot(sub(ringAt(R, q), Jn.pt), u) <= 0) break; sE = s; }
          const sEnd = s0 - dir * sE;
          return { R, dir, sE: sEnd, E: ringAt(R, sEnd), S: ringAt(R, sEnd + dir * sb), t: tanAt(R, sEnd + dir * sb, dir) };
        });
        if (!ends[0] || !ends[1]) { warns.push({ j: Jn.id, text: 'no frontage along a junction leg' }); continue; }
        const m = nrm(add(ends[0].t, ends[1].t)), sig = Math.max(dot(sub(ends[0].S, Jn.pt), m), dot(sub(ends[1].S, Jn.pt), m));
        const cut = en => { for (let s = 0; s < 80; s += 0.1) { const p = ringAt(en.R, en.sE + en.dir * s); if (dot(sub(p, Jn.pt), m) >= sig) return p; } return null; };
        const a = cut(ends[0]), b = cut(ends[1]); if (!a || !b) { warns.push({ j: Jn.id, text: 'a junction crossing could not be placed' }); continue; }
        { const d = nrm(sub(b, a)); if (dist(a, b) > o.maxRes || crossesBlock(add(a, mul(d, 0.05)), sub(b, mul(d, 0.05)))) { warns.push({ j: Jn.id, text: 'a junction crossing would pass over an erf' }); continue; } }
        if (sites.some(x => x.kind === 'leg' && ((dist(x.a, a) < 2 && dist(x.b, b) < 2) || (dist(x.a, b) < 2 && dist(x.b, a) < 2)))) continue;
        sites.push({ id: name + (sites.length + 1), cls: name, kind: 'leg', j: Jn.id, a, b, Ra: ends[0].R, Rb: ends[1].R, splay: [ends[0].E, ends[1].E] });
      }
      // mid-block sites at erf boundaries: square across to the facing ring (another block, or the other arm of a U-shaped one)
      const nearJ = p => real.some(Jn => dist(p, Jn.pt) < o.midNearJ);
      const ringSegs = []; rings.forEach(R => R.pts.forEach((p, i) => ringSegs.push([p, R.pts[(i + 1) % R.pts.length], R])));
      const RI = segIndex(ringSegs.map(s => [s[0], s[1]]), 8);
      for (const R of rings) for (const ei of R.block.erven) for (const v of erven[ei].poly) {
        const q = nearestOnRing(R, v); if (q.d > kd + 0.3 || !R.front[q.i]) continue;
        let straight = true; for (const k of [-2, -1, 1, 2]) straight = straight && dot(tanAt(R, q.s + k, 1), tanAt(R, q.s, 1)) > Math.cos(o.turn * Math.abs(k) * Math.PI / 180);
        if (!straight) continue;
        const p = R.pts[q.i], n = R.n[q.i], e = add(p, mul(n, o.maxRes));
        let best = null;
        for (const c of RI.nearest(add(p, mul(n, o.maxRes / 2)), o.maxRes / 2 + 1)) { const sg = ringSegs[c.k], t = segXi(p, e, sg[0], sg[1]); if (t != null && t * o.maxRes > 0.5 && (!best || t < best.t)) best = { t, R2: sg[2] }; }
        if (!best) continue;
        const qq = add(p, mul(n, best.t * o.maxRes));
        if (!SI.crosses(p, qq, true) || crossesBlock(add(p, mul(n, 0.05)), add(qq, mul(n, -0.05))) || nearJ(p) || nearJ(qq)) continue;
        if (sites.some(x => (dist(x.a, p) < 1.5 && dist(x.b, qq) < 1.5) || (dist(x.a, qq) < 1.5 && dist(x.b, p) < 1.5))) continue;
        sites.push({ id: name + (sites.length + 1), cls: name, kind: 'mid', a: p, b: qq, Ra: R, Rb: best.R2 });
      }
      // the graph
      const nodes = [], adj = [];
      rings.forEach(R => { R.node = R.pts.map((p, i) => { nodes.push({ p, R, i }); adj.push([]); return nodes.length - 1; }); });
      const link = (a, b, w, site) => { adj[a].push({ to: b, w, site }); adj[b].push({ to: a, w, site }); };
      rings.forEach(R => { const N = R.pts.length; for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (R.front[i] && R.front[j]) link(R.node[i], R.node[j], dist(R.pts[i], R.pts[j]), null); } });
      sites.forEach(x => { const ia = nearestOnRing(x.Ra, x.a).i, ib = nearestOnRing(x.Rb, x.b).i; x.na = x.Ra.node[ia]; x.nb = x.Rb.node[ib]; x.len = dist(x.a, x.b); x.used = []; link(x.na, x.nb, x.len, x); });
      // corridors still apart (a junction whose mouth is wide open or blocked, so no leg crossing could be made): joined by the shortest
      // straight link between them that crosses no erf, nearest first, like the street network the old routing had at every junction
      {
        const par = nodes.map((_, i) => i), find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
        adj.forEach((es, a) => es.forEach(e => { const x = find(a), y = find(e.to); if (x !== y) par[x] = y; }));
        const front = []; for (let i = 0; i < nodes.length; i += 4) { const nd = nodes[i]; if (nd.R.front[nd.i]) front.push(i); }
        const byComp = new Map(); front.forEach(i => { const c = find(i); if (!byComp.has(c)) byComp.set(c, []); byComp.get(c).push(i); });
        const comps = [...byComp.keys()];
        if (comps.length > 1) {
          const cand = [];
          for (let a = 0; a < comps.length; a++) for (let b = a + 1; b < comps.length; b++) {
            const pairs = [];
            for (const i of byComp.get(comps[a])) for (const j of byComp.get(comps[b])) { const d = dist(nodes[i].p, nodes[j].p); if (d <= o.maxLink) pairs.push([d, i, j]); }
            pairs.sort((p, q) => p[0] - q[0]);
            for (const [d, i, j] of pairs.slice(0, 40)) if (!crossesBlock(nodes[i].p, nodes[j].p)) { cand.push({ d, i, j }); break; }
          }
          cand.sort((p, q) => p.d - q.d);
          for (const c of cand) {
            if (find(c.i) === find(c.j)) continue;
            const x = { id: name + (sites.length + 1), cls: name, kind: 'link', a: nodes[c.i].p.slice(), b: nodes[c.j].p.slice(), Ra: nodes[c.i].R, Rb: nodes[c.j].R, na: c.i, nb: c.j, len: c.d, used: [] };
            sites.push(x); link(c.i, c.j, c.d, x); par[find(c.i)] = find(c.j);
            warns.push({ j: null, link: true, text: 'corridors joined by a straight link where no junction crossing could be made' });
          }
        }
      }
      // the nearest frontage node to a point (on block B when given, else on the block nearest the point)
      function attach(p, B) {
        if (!B) { let bd = Infinity; for (const b of blocks) { if (boxGap(b.box, [p[0], p[1], p[0], p[1]]) > bd) continue; const d = distBlock(b, p)[0]; if (d < bd) { bd = d; B = b; } } }
        const rn = B && (ringNear(B, p, true) || ringNear(B, p, false)); return rn ? rn.R.node[rn.i] : null;
      }
      function route(from, to, ov) {
        ov = ov || {}; const xpen = ov.xpen != null ? ov.xpen : o.xpen, xshare = ov.xshare != null ? ov.xshare : o.xshare, legExtra = o.rule === 'mid' ? 40 : 0;
        if (from == null || to == null) return null;
        const N = nodes.length, D = new Float64Array(N).fill(Infinity), via = new Int32Array(N).fill(-1), vsite = new Array(N), done = new Uint8Array(N); D[from] = 0;
        const hp = [[0, from]], push = (d, v) => { hp.push([d, v]); let c = hp.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (hp[p][0] <= hp[c][0]) break; [hp[p], hp[c]] = [hp[c], hp[p]]; c = p; } };
        const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === c) break; [hp[m], hp[c]] = [hp[c], hp[m]]; c = m; } } return top; };
        while (hp.length) { const [d, u] = pop(); if (done[u]) continue; done[u] = 1; if (u === to) break;
          for (const e of adj[u]) { let w = e.w; if (e.site) w += (e.site.used.length ? xshare : xpen) + (e.site.kind === 'leg' ? legExtra : 0); if (d + w < D[e.to]) { D[e.to] = d + w; via[e.to] = u; vsite[e.to] = e.site; push(D[e.to], e.to); } } }
        if (!isFinite(D[to])) return null;
        const path = [], used = []; for (let v = to; v !== -1; v = via[v]) { path.push(nodes[v].p); if (vsite[v]) used.push(vsite[v]); if (v === from) break; }
        path.reverse(); used.reverse();
        return { pts: path, sites: used, commit(tag) { used.forEach(x => x.used.push(tag)); } };
      }
      // every node within `maxCost` of a node: Map(node → [cost, length, crossings]) along the cheapest path (for the kiosk optimiser:
      // the service length and road crossings from one erf marker to every stand at once)
      function reach(from, maxCost, ov) {
        ov = ov || {}; const xpen = ov.xpen != null ? ov.xpen : o.xpen, legExtra = o.rule === 'mid' ? 40 : 0, out = new Map();
        if (from == null) return out;
        const hp = [[0, from, 0, 0]], push = q => { hp.push(q); let c = hp.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (hp[p][0] <= hp[c][0]) break; [hp[p], hp[c]] = [hp[c], hp[p]]; c = p; } };
        const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === c) break; [hp[m], hp[c]] = [hp[c], hp[m]]; c = m; } } return top; };
        while (hp.length) { const [d, u, len, xs] = pop(); if (out.has(u)) continue; out.set(u, [d, len, xs]);
          for (const e of adj[u]) { if (out.has(e.to)) continue; const w = e.w + (e.site ? xpen + (e.site.kind === 'leg' ? legExtra : 0) : 0); if (d + w <= maxCost) push([d + w, e.to, len + e.w, xs + (e.site ? 1 : 0)]); } }
        return out;
      }
      const resetUse = () => sites.forEach(x => { x.used = []; });
      return { name, kd, rings, sites, warns, nodes, attach, route, reach, ringNear, resetUse };
    }
    return { o, junctions: J, blocks, bridges, blockOf, cls, ms: Date.now() - t0, crossesBlock, streetSI: SI, distBlock };
  }

  return { DEFAULTS, model, junctions, makeBlocks, rdp, plen, hull, distBlock, pip };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanBlocks;
