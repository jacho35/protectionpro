// Pure-geometry tests for frontend/js/plan-solar.js (no browser).   node testing/unit/plansolar.test.js
const assert = require('assert');
const Detect = require('../../frontend/js/plan-roomdetect.js');
global.AppState = { planMarkup: { settings: {}, nameCounters: {} }, planGenId: (() => { let i = 0; return (p) => p + '_' + (++i); })() };
global.PlanMarkup = { nextCounter: (k, p) => p + '1', snapshot() {}, markDirty() {} };
global.PlanRoomDetect = Detect;
const poly = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };
global.PlanEngine = { view: { zoom: 1 }, _distToSeg: (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }, requestDraw() {}, factor: () => AppState.planMarkup.scale && AppState.planMarkup.scale.factor, _polyArea: poly };
const S = require('../../frontend/js/plan-solar.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

ok('uncalibrated plan gives no area', () => {
  const r = S.addRoof(rect(240, 160));
  assert.strictEqual(S.footprintM2(r), null); assert.strictEqual(S.usableAreaM2(r), null);
  assert.deepStrictEqual(S.arrays([r], 0.8, 0.8), []);
});
ok('footprint, setback and gable plane areas', () => {
  AppState.planMarkup.scale = { factor: 0.05 };          // 240 x 160 units = 12 x 8 m
  const r = S.roofs()[0];
  assert(Math.abs(S.footprintM2(r) - 96) < 1e-6);
  r.setback = 0;
  assert(Math.abs(S.usableFootprintM2(r) - 96) < 1e-6);
  r.setback = 0.5;                                        // 11 x 7 = 77 m2
  assert(Math.abs(S.usableFootprintM2(r) - 77) < 0.5);
  r.shape = 'gable'; r.pitch = 25;
  assert(Math.abs(S.usableAreaM2(r) - 77 / 2 / Math.cos(25 * Math.PI / 180)) < 0.3);
  r.shape = 'flat';
  assert(Math.abs(S.usableAreaM2(r) - 77) < 0.5);
});
ok('arrays: gable uses pitch and packing, flat uses tilt and the ground cover ratio, unused roofs are skipped', () => {
  const g = S.roofs()[0]; g.shape = 'gable'; g.pitch = 25; g.azimuth = 10;
  const f = S.addRoof(rect(120, 80)); f.shape = 'flat'; f.tilt = 15; f.setback = 0;
  const off = S.addRoof(rect(100, 100)); off.use = false;
  const a = S.arrays(S.roofs(), 0.79, 0.8);
  assert.strictEqual(a.length, 2);
  assert.deepStrictEqual([a[0].tilt_deg, a[0].azimuth_deg, a[0].packing], [25, 10, 0.8]);
  assert.deepStrictEqual([a[1].tilt_deg, a[1].packing], [15, 0.79]);
  assert(Math.abs(a[1].area_m2 - 24) < 1e-6);            // 6 x 4 m
});
ok('removeRoof keeps the others', () => {
  const before = S.roofs().length; global.PlanEngine.requestDraw = () => {};
  S.removeRoof(S.roofs()[0].id); assert.strictEqual(S.roofs().length, before - 1);
});
ok('corner editing: find a node / midpoint / edge, add, move, remove (keeping three)', () => {
  AppState.planMarkup.settings.solar.roofs = [];
  const r = S.addRoof(rect(100, 60));
  const z = 1;
  assert.strictEqual(S.nodeAt({ x: 101, y: 1 }, z).i, 1);                  // near the (100, 0) corner
  assert.strictEqual(S.nodeAt({ x: 50, y: 30 }, z), null);
  const m = S.midAt({ x: 50, y: 1 }, z);                                    // midpoint of edge 0
  assert.deepStrictEqual([m.i, m.mid.x, m.mid.y], [0, 50, 0]);
  assert.strictEqual(S.edgeAt({ x: 30, y: 3 }, z).i, 0);
  assert.strictEqual(S.edgeAt({ x: 50, y: 30 }, z), null);
  assert(S.addNodeAtEdge({ x: 30, y: 2 }, z));                              // double-click / Shift-click on an edge
  assert.strictEqual(r.points.length, 5);
  assert(S.removeNodeAt({ x: 100, y: 0 }, z));                              // Alt-click / double-click on a corner
  assert.strictEqual(r.points.length, 4);
  assert(S.removeNodeAt({ x: 100, y: 60 }, z)); assert.strictEqual(r.points.length, 3);
  assert(!S.removeNodeAt(r.points[0], z), 'a roof keeps three corners'); assert.strictEqual(r.points.length, 3);
});
ok('north angle: stored, wrapped, and added to a roof azimuth for plan geometry', () => {
  assert.strictEqual(S.northAngle(), 0);
  const r = S.addRoof(rect(240, 160)); r.azimuth = 10; r.shape = 'gable'; r.setback = 0; r.use = true;
  assert.strictEqual(S.planAz(r), 10);
  S.setNorthAngle(30); assert.strictEqual(S.northAngle(), 30); assert.strictEqual(S.planAz(r), 40);
  S.setNorthAngle(-20); assert.strictEqual(S.northAngle(), 340); assert.strictEqual(S.planAz(r), 350);
  S.setNorthAngle(370); assert.strictEqual(S.northAngle(), 10);
  S.setNorthAngle('x'); assert.strictEqual(S.northAngle(), 0);
  assert.deepStrictEqual(S.arrays([r], 0.8, 0.8).map(a => a.azimuth_deg), [10], 'the engine still gets the true azimuth');
});
console.log(n + ' passed');
