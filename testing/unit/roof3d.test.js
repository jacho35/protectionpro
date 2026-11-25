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
console.log('shadow tests done');
