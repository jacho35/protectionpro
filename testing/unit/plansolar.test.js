// Pure-geometry tests for frontend/js/plan-solar.js (no browser).   node testing/unit/plansolar.test.js
const assert = require('assert');
const Detect = require('../../frontend/js/plan-roomdetect.js');
global.AppState = { planMarkup: { settings: {}, nameCounters: {} }, planGenId: (() => { let i = 0; return (p) => p + '_' + (++i); })() };
global.PlanMarkup = { nextCounter: (k, p) => p + '1', snapshot() {}, markDirty() {} };
global.PlanRoomDetect = Detect;
const poly = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };
global.PlanEngine = { factor: () => AppState.planMarkup.scale && AppState.planMarkup.scale.factor, _polyArea: poly };
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
console.log(n + ' passed');
