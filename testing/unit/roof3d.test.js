// Pure geometry for frontend/js/roof3d.js (no browser).   node testing/unit/roof3d.test.js
const assert = require('assert');
const R = require('../../frontend/js/roof3d.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const close = (a, b, e = 1e-6) => assert(Math.abs(a - b) < e, `${a} vs ${b}`);
const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };

ok('plan points to metres, y flipped so north is up', () => {
  assert.deepStrictEqual(R.toMetres([{ x: 10, y: 20 }], 0.5), [[5, -10]]);
});
ok('axes: facing north is +y, facing east is +x', () => {
  const n0 = R.axes(0), e = R.axes(90);
  close(n0.u[0], 0); close(n0.u[1], 1); close(e.u[0], 1); close(e.u[1], 0, 1e-9);
});
ok('clip halves a rectangle exactly', () => {
  const h = R.clip(rect(10, 6), p => p[1] - 3);
  close(area(h), 30);
});
ok('gable planes: heights at eave and ridge, areas and rise', () => {
  const g = R.gablePlanes(rect(10, 6), 0, 30, 3);                  // north-facing: eave on the y = 6 side
  close(g.rise, Math.tan(30 * Math.PI / 180) * 3);
  close(area(g.front) + area(g.back), 60);
  for (const p of g.front) close(p[2], p[1] === 6 ? 3 : 3 + g.rise);   // eave at the north edge, ridge in the middle
  for (const p of g.back) close(p[2], p[1] === 0 ? 3 : 3 + g.rise);
});
ok('modules: whole modules, inside the setback, on the plane, capped by max', () => {
  const mod = { len: 2, wid: 1 }, g = R.gablePlanes(rect(10, 6), 0, 30, 3);
  const all = R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 1e9, g);
  // slope run = 2 cos30 = 1.732; plane runs 3 m; after the setback 2.5 m -> 1 row; width 9 m -> 9 modules
  assert.strictEqual(all.length, 9);
  for (const m of all) for (const p of m) { assert(p[0] >= 0.5 - 1e-6 && p[0] <= 9.5 + 1e-6 && p[1] <= 5.5 + 1e-6); }
  const t = Math.tan(30 * Math.PI / 180);
  for (const p of all[0]) close(p[2], 3 + t * (6 - p[1]) + 0.04, 1e-6);
  assert.strictEqual(R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 4, g).length, 4);
});
ok('modules never leave an L-shaped outline', () => {
  const L = [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]];
  const g = R.gablePlanes(L, 0, 25, 3);
  const mods = R.layoutModules(L, 0, 25, 0.3, { len: 1.7, wid: 1.1 }, 1e9, g);
  assert(mods.length > 0);
  for (const m of mods) for (const p of m) assert(R._inside([p[0], p[1]], L));
});
ok('racks: rows step by the pitch from the north edge, high edge toward the south', () => {
  const mod = { len: 2, wid: 1 };
  const racks = R.layoutRacks(rect(10, 12), 0, 15, 0.5, mod, 1e9, 3, 3.4);
  const rows = new Set(racks.map(m => Math.round(m[0][1] * 100) / 100));
  assert.deepStrictEqual([...rows], [11.5, 8.5, 5.5, 2.5]);
  const m = racks[0];
  close(m[2][2] - m[0][2], 2 * Math.sin(15 * Math.PI / 180));     // back edge higher by L sin(tilt)
  assert(m[2][1] < m[0][1]);
});
console.log(n + ' passed');

// ── shadows ──
const approx = (a, b, e = 1e-6) => assert(Math.abs(a - b) < e, `${a} vs ${b}`);
ok('sun vector: due north at 45 degrees', () => {
  const s = R.sunVec(0, 45);
  approx(s[0], 0); approx(s[1], Math.SQRT1_2); approx(s[2], Math.SQRT1_2);
});
ok('shadow point of a pole top on the ground is its height / tan(elevation) away from the sun', () => {
  const s = R.sunVec(0, 30);                                   // sun in the north: shadow falls south (-y)
  const p = R.shadowPoint([2, 5, 3], s, [0, 0, 0], [0, 0, 1]);
  approx(p[2], 0); approx(p[0], 2); approx(p[1], 5 - 3 / Math.tan(30 * Math.PI / 180), 1e-9);
  assert.strictEqual(R.shadowPoint([2, 5, 3], R.sunVec(0, -5), [0, 0, 0], [0, 0, 1]), null);   // sun below the plane
});
ok('hull and convex clip', () => {
  const h = R.hull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2]]);
  assert.strictEqual(h.length, 4);
  const c = R.clipConvex([[-2, -2], [6, -2], [6, 6], [-2, 6]], [[0, 0], [4, 0], [4, 4], [0, 4]]);
  approx(area(c), 16);
  assert.strictEqual(R.clipConvex([[10, 10], [12, 10], [12, 12]], [[0, 0], [4, 0], [4, 4], [0, 4]]).length, 0);
});
ok('ray hits a quad only in front of it and inside it', () => {
  const quad = [[0, 0, 2], [2, 0, 2], [2, 2, 2], [0, 2, 2]];     // a horizontal 2 x 2 plate at z = 2
  const up = [0, 0, 1];
  assert(R.rayHitsQuad([1, 1, 0], up, quad));
  assert(!R.rayHitsQuad([3, 1, 0], up, quad));                    // beside it
  assert(!R.rayHitsQuad([1, 1, 3], up, quad));                    // already above it
});
ok('a wall in the north shades a module behind it only when the sun is low enough', () => {
  const wall = R.boxFaces([[0, 10], [10, 10], [10, 10.5], [0, 10.5]], 4);       // 4 m high wall, north of the module
  const mod = [[4, 0, 0.5], [5, 0, 0.5], [5, 1, 0.5], [4, 1, 0.5]];
  // wall is 9.5 m north of the module centre, 3.5 m above it: shades when the sun elevation < atan(3.5 / 9.5) = 20.2 deg
  assert.deepStrictEqual(R.shadedModules([[mod]], R.sunVec(0, 15), wall), [true]);
  assert.deepStrictEqual(R.shadedModules([[mod]], R.sunVec(0, 30), wall), [false]);
  assert.deepStrictEqual(R.shadedModules([[mod]], R.sunVec(180, 15), wall), [false]);   // sun in the south
});
ok('a rack row shades the row behind it at low sun, not at high sun', () => {
  const mod = { len: 2, wid: 1 };
  const racks = R.layoutRacks(rect(2, 12), 0, 15, 0.5, mod, 1e9, 2.5, 3.4);       // rows of one module, pitch 2.5 m (tight)
  const rows = new Map(); for (const m of racks) { const k = Math.round(m[0][1] * 10); (rows.get(k) || rows.set(k, []).get(k)).push(m); }
  const groups = [...rows.values()];
  const low = R.shadedModules(groups, R.sunVec(0, 8), []), high = R.shadedModules(groups, R.sunVec(0, 60), []);
  assert(low.filter(Boolean).length >= 1 && high.filter(Boolean).length === 0);
  assert(!low[0], 'the front (north) row is never shaded by the rows behind it');
});
ok('a turned plan: the roof faces the plan bearing azimuth + north angle', () => {
  const sc = { north: 90, items: [{ roof: { pitch: 20, azimuth: 0 }, planes: R.gablePlanes(rect(10, 6), 90, 20, R.EAVE_M), mods: [], poly: rect(10, 6) }], obs: null };
  const polys = R.shadows(sc, R.sunVec(90, 40));
  assert(Array.isArray(polys));
  const u = R.axes(0 + sc.north).u; close(u[0], 1); close(u[1], 0, 1e-9);   // true north is plan east
});
ok('module placement: packed to a corner or centred, same count', () => {
  const mod = { len: 2, wid: 1.4 }, g = R.gablePlanes(rect(10, 6), 0, 30, 3), at = (al) => R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 1e9, g, al);
  const xs = (ms) => ms.flatMap(m => m.map(p => p[0])), ys = (ms) => ms.flatMap(m => m.map(p => p[1]));
  const def = at(), br = at('bottom-right'), tl = at('top-left'), cc = at('center-center');
  assert.strictEqual(def.length, 6); assert.strictEqual(tl.length, 6); assert.strictEqual(cc.length, 6);
  assert.deepStrictEqual(def, br, 'no setting = bottom-right, the layout before this option existed');
  close(Math.min(...xs(br)), 0.5); close(Math.max(...xs(tl)), 9.5); close(Math.min(...xs(cc)), 0.8);
  close(Math.max(...ys(br)), 5.5); close(Math.min(...ys(tl)), 3);                       // eave side / ridge side
  const run = 2 * Math.cos(30 * Math.PI / 180); close(Math.max(...ys(cc)), 5.5 - (2.5 - run) / 2, 1e-6);
  const racks = (al) => R.layoutRacks(rect(10, 6), 0, 20, 0.5, { len: 2, wid: 1.4 }, 1e9, 3, 0, al);
  assert.strictEqual(racks('top-left').length, racks('bottom-right').length);
  assert(Math.max(...ys(racks('top-left'))) < Math.max(...ys(racks('bottom-right'))), 'top-aligned rows sit up the roof');
});
ok('keep-out: no module touches the area, and the rest still fit', () => {
  const mod = { len: 2, wid: 1 }, g = R.gablePlanes(rect(10, 6), 0, 30, 3), ex = [[[2.2, 3.2], [4.8, 3.2], [4.8, 5.4], [2.2, 5.4]]];
  const free = R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 1e9, g), kept = R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 1e9, g, null, ex);
  assert(kept.length < free.length && kept.length > 0, free.length + ' vs ' + kept.length);
  assert(kept.every(m => !R.hitsKeepout(m, ex)), 'no module overlaps');
  assert(free.some(m => R.hitsKeepout(m, ex)), 'the area really was in the way');
  assert(R.hitsKeepout([[0, 0], [10, 0], [10, 10], [0, 10]], [[[4, 4], [5, 4], [5, 5], [4, 5]]]), 'a keep-out wholly inside a module');
  assert(R.hitsKeepout([[0, 0], [2, 0], [2, 1], [0, 1]], [[[1, -1], [1.5, -1], [1.5, 2], [1, 2]]]), 'edges crossing with no corner inside');
  assert(!R.hitsKeepout([[0, 0], [1, 0], [1, 1], [0, 1]], [[[2, 2], [3, 2], [3, 3], [2, 3]]]));
  const racks = (e) => R.layoutRacks(rect(10, 6), 0, 20, 0.5, mod, 1e9, 3, 0, null, e);
  assert(racks(ex).length < racks().length, 'racks avoid it too');
});
ok('occlusion: a point behind a wall or the ridge is hidden, one in the open or on the viewer side is not', () => {
  const sc = { items: [{ roof: { shape: 'flat' }, poly: [[0, 0], [10, 0], [10, 6], [0, 6]], eave: 3, pls: [], mods: [] }] };
  const occ = R.occluders(sc);
  assert(occ.length === 5, 'four walls and the deck');
  const toViewerUp = [0, 0, 1];
  assert(R.hidden([5, 3, 1], toViewerUp, occ), 'inside the box, under the deck');
  assert(!R.hidden([5, 3, 3.6], toViewerUp, occ), 'on top of the deck, looking down');
  assert(!R.hidden([20, 3, 1], toViewerUp, occ), 'beside the building');
  assert(R.hidden([5, 3, 3.6], [0, 0, -1], occ), 'seen from below the deck is in the way');
  const sideOn = [-1, 0, 0];
  assert(R.hidden([5, 3, 1], sideOn, occ), 'behind the west wall');
});
ok('panel gap: fewer modules, neighbours exactly `gap` apart, zero gap unchanged', () => {
  const mod = { len: 2, wid: 1 }, g = R.gablePlanes(rect(10, 6), 0, 30, 3);
  const base = R.layoutModules(rect(10, 6), 0, 30, 0.5, mod, 1e9, g);
  assert.strictEqual(R.layoutModules(rect(10, 6), 0, 30, 0.5, Object.assign({ gap: 0 }, mod), 1e9, g).length, base.length);
  const gapped = R.layoutModules(rect(10, 6), 0, 30, 0.5, Object.assign({ gap: 0.1 }, mod), 1e9, g);
  // 9 m of width: n modules need n + 0.1 (n - 1) <= 9 -> 8 modules (8.7 m); a row is 8 modules
  assert.strictEqual(gapped.length, 8);
  const xs = gapped.map(m => Math.min(...m.map(p => p[0]))).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) close(xs[i] - xs[i - 1], 1.1, 1e-6);
  const racks = (gap) => R.layoutRacks(rect(10, 12), 0, 15, 0.5, { len: 2, wid: 1, gap }, 1e9, 3, 3.4);
  assert(racks(0.1).length < racks(0).length, 'racks lose a module per row');
  assert.strictEqual(R.slack(9, 1, 0), 0);
  close(R.slack(9, 1, 0.1), 0.3, 1e-9);
  assert.strictEqual(R.slack(0.5, 1, 0.1), 0);
});
ok('maintenance aisles: a column aisle opens exactly its width, indexes follow, rows too', () => {
  const mod = { len: 2, wid: 1 }, g = R.gablePlanes(rect(10, 6), 0, 30, 3);
  const withCol = R.layoutModules(rect(10, 6), 0, 30, 0.5, Object.assign({ cuts: { col: [{ after: 4, w: 0.8 }] } }, mod), 1e9, g);
  assert.strictEqual(withCol.length, 8, '9 m of width: 8 modules and the 0.8 m aisle');
  const xs = (ci) => withCol.filter(m => m.ci === ci).map(m => Math.min(...m.map(p => p[0])))[0];
  close(xs(4) - xs(3), 1.8, 1e-6);                                  // module width + 0.8 aisle
  close(xs(3) - xs(2), 1, 1e-6);
  const bd = R.boundaries(withCol, 0);
  const col = bd.cols.find(c => c.after === 4);
  assert(col && Math.abs(col.clear - 0.8) < 1e-6, 'the boundary reports its clear width');
  const at = (v, sx) => [bd.w[0] * v + bd.u[0] * sx, bd.w[1] * v + bd.u[1] * sx], hit = R.boundaryAt(bd, at(col.at, (bd.s[0] + bd.s[1]) / 2), 0.1);
  assert(hit && hit.axis === 'col' && hit.after === 4, 'a point in the aisle finds it');
  const far = R.boundaryAt(bd, at(col.at + 0.7, (bd.s[0] + bd.s[1]) / 2), 0.05);
  assert(!far || far.after !== 4, 'a point inside a panel is not the aisle');
  const racks = (cuts) => R.layoutRacks(rect(10, 12), 0, 15, 0.5, Object.assign({ cuts }, { len: 2, wid: 1 }), 1e9, 3, 3.4);
  const rowsOf = (l) => new Set(l.map(m => m.ri)).size;
  assert(rowsOf(racks({ row: [{ after: 2, w: 2 }] })) < rowsOf(racks({})), 'a row aisle takes room from the rows');
  const b = racks({ row: [{ after: 2, w: 2 }] });
  const sOf = (l, ri) => Math.max(...l.filter(m => m.ri === ri).flatMap(m => m.map(p => p[1])));
  close(sOf(b, 1) - sOf(b, 2), 3 + (2 - (3 - 2 * Math.cos(15 * Math.PI / 180))), 1e-6);
});
console.log('shadow tests done');

// ── annual shading ──
ok('rack rows: the 3D shade flags match the closed-form profile shading at every sun elevation', () => {
  const mod = { len: 2, wid: 1 }, tilt = 15, pitch = 3, b = tilt * Math.PI / 180;
  const racks = R.layoutRacks(rect(2, 14), 0, tilt, 0.5, mod, 1e9, pitch, 0);       // one column, rows from the north edge
  assert(racks.length >= 4);
  // profile (y, z) of each module: low edge = the corner at the larger y, high edge the other
  const prof = racks.map(m => { const ys = m.map(p => p[1]); const lo = m.find(p => p[1] === Math.max(...ys)), hi = m.find(p => p[1] === Math.min(...ys)); return { lo: [lo[1], lo[2]], hi: [hi[1], hi[2]], ri: m.ri }; });
  const centre = (q) => [(q.lo[0] + q.hi[0]) / 2, (q.lo[1] + q.hi[1]) / 2];
  const hitsSeg = (P, d, a, c) => {                                                  // ray P + t d (t > 0) meets segment a-c
    const e = [c[0] - a[0], c[1] - a[1]], den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) return false;
    const w = [a[0] - P[0], a[1] - P[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den;
    return t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9;
  };
  let sawShade = false, sawLight = false;
  for (const el of [6, 10, 15, 20, 30, 45, 60, 80]) {
    const flags = R.shadedModules([racks], R.sunVec(0, el), []);                    // sun due north, in the plane of the profile
    const d = [Math.cos(el * Math.PI / 180), Math.sin(el * Math.PI / 180)];
    prof.forEach((q, i) => {
      const expect = prof.some((o, j) => j !== i && hitsSeg(centre(q), d, o.lo, o.hi));
      assert.strictEqual(flags[i], expect, `elevation ${el}, row ${q.ri}`);
      sawShade = sawShade || expect; sawLight = sawLight || !expect;
    });
  }
  assert(sawShade && sawLight);
  const rise = mod.len * Math.sin(b), run = mod.len * Math.cos(b), alpha = Math.atan(rise / (pitch - run));     // the design elevation that just clears
  assert(R.shadedModules([racks], R.sunVec(0, alpha * 180 / Math.PI + 2), []).filter(Boolean).length <= 1);
});
ok('annualFlags: one flag character per sun position, grouped by engine array, wall shades the morning only', () => {
  const mod = { len: 2, wid: 1 };
  const m1 = R.layoutModules(rect(6, 6), 0, 20, 0.3, mod, 4, R.gablePlanes(rect(6, 6), 0, 20, 3));
  m1.forEach(m => { m.arr = 'Roof A'; });
  const wall = { foot: [[-4, 7], [10, 7], [10, 7.5], [-4, 7.5]], h: 30 };             // a high wall north of the roof
  const sc = { items: [{ roof: { name: 'Roof A' }, mods: m1, planes: R.gablePlanes(rect(6, 6), 0, 20, 3), poly: rect(6, 6), roofShape: 'gable' }], obs: wall, objs: [], north: 0 };
  const samples = [{ azimuth_deg: 0, elevation_deg: 40 }, { azimuth_deg: 180, elevation_deg: 40 }, { azimuth_deg: 0, elevation_deg: 89 }];
  const out = R.annualFlags(sc, samples);
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].arr, 'Roof A');
  assert.strictEqual(out[0].shade.length, m1.length);
  assert(out[0].shade.every(r => r.length === 3));
  assert(out[0].shade.every(r => r === '100'));                                        // sun low in the north: behind the wall; sun in the south or nearly overhead: clear
});
console.log(n + ' passed (with annual shading)');

// ── parapet ──
ok('parapet: inset outline is the footprint shrunk by the wall thickness, inner faces are planar quads facing in', () => {
  const it = { poly: rect(10, 6), eave: 3 };
  const pp = R.parapet(it);
  close(pp.deck, 3 + R.PARAPET_M); close(pp.top, pp.deck + R.PARAPET_H);
  close(area(pp.Q), (10 - 2 * R.PARAPET_T) * (6 - 2 * R.PARAPET_T), 1e-9);
  assert.strictEqual(pp.inner.length, 4);
  for (const q of pp.inner) { close(q[0][2], pp.top); close(q[2][2], pp.deck); }
  const rev = R.inset(rect(10, 6).slice().reverse(), 0.15); close(area(rev), area(pp.Q), 1e-9);       // either winding
});
ok('annualFlags: the parapet shades a rack right behind it in low sun and not in high sun', () => {
  const mod = { len: 2, wid: 1 }, it0 = { roof: { name: 'F', shape: 'flat' }, poly: rect(10, 6), eave: 3, mods: [] };
  const pp = R.parapet(it0), z = pp.deck + 0.1;
  // one module 0.1 m north of the south parapet's inner face (y = 0.15): its centre is shaded by that wall when the sun is low in the south
  const m = [[4, 0.35, z], [5, 0.35, z], [5, 0.75, z + 0.1], [4, 0.75, z + 0.1]];
  m.ri = 0; m.arr = 'F'; it0.mods = [m];
  const out = R.annualFlags({ items: [it0], obs: null, objs: [], north: 0 }, [{ azimuth_deg: 180, elevation_deg: 8 }, { azimuth_deg: 180, elevation_deg: 60 }, { azimuth_deg: 0, elevation_deg: 8 }]);
  assert.strictEqual(out[0].shade[0], '100');
});
console.log(n + ' passed (with parapet)');
