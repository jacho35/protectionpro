// Placed panels on a plane roof (hip / mono) are counted per plane, so Solar PV Design's size run reports the placed number.
//   node testing/unit/plansolararray.test.js
const assert = require('assert');
global.AppState = { planMarkup: { settings: {}, nameCounters: {} }, planGenId: (() => { let i = 0; return (p) => p + '_' + (++i); })() };
global.PlanMarkup = { nextCounter: (k, p) => p + '1', snapshot() {}, markDirty() {}, refreshProps() {} };
global.Roof3D = require('../../frontend/js/roof3d.js');
global.PlanRoomDetect = require('../../frontend/js/plan-roomdetect.js');
global.RoofPlanes = require('../../frontend/js/roof-planes.js');
global.PlanEngine = { view: { zoom: 1 }, factor: () => 0.05, requestDraw() {} };
global.PlanTools = { register() {}, set() {} };
const panel = { w: 450, len: 1.13, wid: 1.91 };
global.Solar = { cfg: () => ({ mode: 'roof' }), panel: () => panel };
const S = require('../../frontend/js/plan-solar.js');
global.PlanSolar = S;
const A = require('../../frontend/js/plan-solar-array.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

ok('hip roof: lay.byPlane adds up to lay.n and every panel carries its plane', () => {
  const r = S.addRoof(rect(240, 160)); r.shape = 'hip'; r.pitch = 21; r.eave = 3; r.setback = 0.2; r.azimuth = 0; r.array = true; r.use = true;
  const lay = A.layout(r);
  assert(lay.n > 0, 'panels placed');
  assert(lay.byPlane && Object.keys(lay.byPlane).length >= 1);
  assert.strictEqual(Object.values(lay.byPlane).reduce((a, b) => a + b, 0), lay.n);
  assert(lay.mods.every(m => typeof m.pl === 'string'));
});
ok('plane names match the size run array names (roof · plane)', () => {
  const r = S.roofs()[0], lay = A.layout(r);
  const names = S._planeAreas(r).map(q => q.plane.name);
  for (const pn of Object.keys(lay.byPlane)) assert(names.includes(pn), pn + ' is a plane in use');
});
ok('flat roof: no byPlane entries', () => {
  const f = S.addRoof(rect(120, 80)); f.shape = 'flat'; f.tilt = 15; f.setback = 0; f.array = true;
  A._rowPitch = A.rowPitch; A.rowPitch = () => 2;
  const lay = A.layout(f);
  assert.deepStrictEqual(lay.byPlane, {});
  A.rowPitch = A._rowPitch;
});
console.log(n + ' passed');
