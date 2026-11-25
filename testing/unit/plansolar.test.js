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
ok('align to edge: the roof faces out of the clicked edge, less the north angle', () => {
  S.setNorthAngle(0);
  const r = S.addRoof([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]);
  assert.strictEqual(S.alignToEdge(r, 0), 0, 'top edge faces plan-up');
  assert.strictEqual(S.alignToEdge(r, 1), 90, 'right edge');
  assert.strictEqual(S.alignToEdge(r, 2), 180, 'bottom edge');
  assert.strictEqual(S.alignToEdge(r, 3), 270, 'left edge');
  assert.strictEqual(r.azimuth, 270);
  S.setNorthAngle(30); assert.strictEqual(S.alignToEdge(r, 2), 150, 'true azimuth = plan bearing - north angle');
  assert.strictEqual(S.planAz(r), 180, 'the plan bearing is still square to the edge');
  S.setNorthAngle(0);
});
ok('other roofs as obstructions: a higher neighbour to the north shades, a lower or overlapping one does not', () => {
  S.setNorthAngle(0);
  global.Roof3D = { PARAPET_M: 0.4, toMetres: (pts, f) => pts.map(p => [p.x * f, -p.y * f]) };
  global.RoofPlanes = { eave: (r) => (r.eave != null ? r.eave : 3), model: (base, r) => ({ planes: [{ poly: base, zAt: () => (r.eave != null ? r.eave : 3) + (r.rise || 0) }] }) };
  global.PlanEngine.factor = () => 1;
  const st = S._store(); st.roofs = [];
  const a = S.addRoof([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]); a.shape = 'flat'; a.eave = 3; a.rise = 0;
  const tall = S.addRoof([{ x: -5, y: -26 }, { x: 15, y: -26 }, { x: 15, y: -16 }, { x: -5, y: -16 }]); tall.shape = 'flat'; tall.eave = 9; tall.rise = 0; tall.use = false;   // stands north of A (plan up)
  const low = S.addRoof([{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }]); low.shape = 'flat'; low.eave = 3; low.rise = 0;
  const ob = S.neighbourObstructions(a);
  assert.strictEqual(ob.length, 1, 'only the higher roof counts, used or not');
  assert.strictEqual(ob[0].name, tall.name);
  assert(Math.abs(ob[0].bearing_deg - 0) < 1 || Math.abs(ob[0].bearing_deg - 360) < 1, 'due north: ' + ob[0].bearing_deg);
  assert(ob[0].height_m > 5 && ob[0].distance_m > 10 && ob[0].width_m > 15, JSON.stringify(ob[0]));
  S.setNorthAngle(90);
  assert(Math.abs(S.neighbourObstructions(a)[0].bearing_deg - 270) < 1, 'plan bearing 0 with north 90 is true bearing 270');
  S.setNorthAngle(0);
});
ok('picked roofs move as they are, with their objects; delete removes the picked ones', () => {
  const st = S._store(); st.roofs = [];
  const a = S.addRoof(rect(240, 160)), b = S.addRoof(rect(100, 100)), c = S.addRoof(rect(50, 50));
  S.addObject(a, 'vent', { x: 20, y: 30 });
  const before = JSON.stringify([a.points, b.points, c.points]);
  S.selectRoofs([a.id]); S.selectRoofs([b.id], true);
  S.moveSelected(10, -5);
  assert.deepStrictEqual(a.points[2], { x: 250, y: 155 }); assert.deepStrictEqual(b.points[0], { x: 10, y: -5 });
  assert.deepStrictEqual(c.points, rect(50, 50), 'an unpicked roof stays');
  assert.deepStrictEqual([a.objects[0].x, a.objects[0].y], [30, 25], 'its objects go with it');
  S.moveSelected(-10, 5);
  assert.strictEqual(JSON.stringify([a.points, b.points, c.points]), before, 'moving back restores every corner');
  S.selectRoofs([c.id]); assert(S.deleteSelected()); assert.strictEqual(S.roofs().length, 2); assert(!S.deleteSelected());
  S.selectRoofs([a.id]); S.removeRoof(a.id); assert.strictEqual(S.sel.size, 0, 'a removed roof leaves the selection');
});
ok('maximum panels: blank is no limit, a whole number caps, and it rides on the engine arrays as the roof group', () => {
  const st = S._store(); st.roofs = [];
  const r = S.addRoof(rect(240, 160)); r.shape = 'gable'; r.use = true; r.setback = 0;
  assert.strictEqual(S.maxModules(r), Infinity);
  r.maxModules = 12.9; assert.strictEqual(S.maxModules(r), 12);
  const a = S.arrays([r], 0.8, 0.8); assert(a.length >= 1 && a.every(x => x.max_modules === 12 && x.group === r.name), JSON.stringify(a));
  r.maxModules = null; assert.strictEqual(S.maxModules(r), Infinity);
  assert(S.arrays([r], 0.8, 0.8).every(x => x.max_modules === undefined), 'no limit sent when blank');
  r.maxModules = 0; assert.strictEqual(S.maxModules(r), Infinity);
});
ok('shade for a roof: its own objects and the neighbours, never another roof\'s objects', () => {
  S.setNorthAngle(0); const st = S._store(); st.roofs = [];
  global.Roof3D = { PARAPET_M: 0.4, toMetres: (pts, f) => pts.map(p => [p.x * f, -p.y * f]) };
  global.RoofPlanes = { eave: () => 3, model: (base) => ({ planes: [{ poly: base, zAt: () => 3 }] }) };
  global.PlanEngine.factor = () => 1;
  const a = S.addRoof(rect(10, 10)), b = S.addRoof([{ x: 40, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 40, y: 10 }]);
  a.shape = b.shape = 'flat';
  S.addObject(a, 'vent', { x: 5, y: 5 }); S.addObject(b, 'vent', { x: 45, y: 5 });
  assert.strictEqual(S.shadeFor(a).length, 1, 'one vent: its own'); assert.strictEqual(S.shadeFor(b).length, 1);
  assert.strictEqual(S.shadeFor(a)[0].distance_m, 0.5, 'a vent in the middle of its roof is at the minimum distance, not 40 m away');
});
ok('keep-out areas: stored on the roof, edited like roof corners, moved with the roof, taken off the usable area', () => {
  S.setNorthAngle(0); const st = S._store(); st.roofs = [];
  global.PlanEngine.factor = () => 0.1;
  global.Roof3D = { PARAPET_M: 0.4, toMetres: (pts, f) => pts.map(p => [p.x * f, -p.y * f]), _inside: (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; } };
  const r = S.addRoof(rect(200, 100)); r.shape = 'flat'; r.setback = 0;
  const full = S.usableAreaM2(r);
  const k = S.addKeepout(r, [{ x: 20, y: 20 }, { x: 70, y: 20 }, { x: 70, y: 60 }, { x: 20, y: 60 }]);
  assert(k && k.keepout && r.keepouts.length === 1 && !S.addKeepout(r, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), 'three corners at least');
  const lost = 1 - S.usableAreaM2(r) / full;
  assert(Math.abs(lost - (50 * 40) / (200 * 100)) < 0.02, 'a tenth of the roof is kept out, got ' + lost);
  assert.strictEqual(S.nodeAt({ x: 20, y: 20 }, 1).roof, k, 'its corner is picked, not the roof under it');
  assert.strictEqual(S.nodeAt({ x: 0, y: 0 }, 1).roof, r, 'the roof corner still is');
  S.insertNode(k, 0, { x: 45, y: 20 }); assert.strictEqual(k.points.length, 5);
  S.selectRoofs([r.id]); S.moveSelected(10, 5); assert.deepStrictEqual(k.points[0], { x: 30, y: 25 });
  S.removeKeepout(r, k.id); assert.strictEqual(r.keepouts.length, 0); assert(Math.abs(S.usableAreaM2(r) - full) < 1e-9);
});
console.log(n + ' passed');
