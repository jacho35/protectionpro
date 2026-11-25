// Pure geometry for frontend/js/roof-planes.js (no browser).   node testing/unit/roofplanes.test.js
const assert = require('assert');
global.Roof3D = require('../../frontend/js/roof3d.js');
global.PlanRoomDetect = require('../../frontend/js/plan-roomdetect.js');
const RP = require('../../frontend/js/roof-planes.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const close = (a, b, e = 1e-6) => assert(Math.abs(a - b) < e, `${a} vs ${b}`);
const area = (p) => Math.abs(RP._area(p));

ok('hip over a 12 x 8 rectangle: four planes covering the footprint, ridge 4 m long at pitch height', () => {
  const pl = RP.planes(rect(12, 8), { shape: 'hip', pitch: 30, eave: 3 }, 0, 0);
  assert.strictEqual(pl.length, 4);
  close(pl.reduce((a, p) => a + area(p.poly), 0), 96);
  const t = Math.tan(30 * Math.PI / 180);
  close(pl[0].zAt(6, 4), 3 + 4 * t); close(pl[0].zAt(0, 0), 3);
  assert.deepStrictEqual(pl.map(p => Math.round(p.az)).sort((a, b) => a - b), [0, 90, 180, 270]);
  const north = pl.find(p => Math.round(p.az) === 0);
  close(area(north.poly), (12 + 4) / 2 * 4);              // trapezoid: ridge 4, eave 12, depth 4
});
ok('hip over a square is a pyramid: four triangles meeting at one apex', () => {
  const pl = RP.planes(rect(8, 8), { shape: 'hip', pitch: 25, eave: 3 }, 0, 0);
  assert.strictEqual(pl.length, 4);
  for (const p of pl) close(area(p.poly), 16);
  const t = Math.tan(25 * Math.PI / 180);
  for (const p of pl) close(p.zAt(4, 4), 3 + 4 * t);
});
ok('hip tolerates a clockwise outline and a collinear vertex', () => {
  const pl = RP.planes([[0, 0], [0, 8], [12, 8], [6, 0], [12, 0]].slice(0, 3).concat([[12, 0], [6, 0]]), { shape: 'hip', pitch: 20 }, 0, 0);
  assert.strictEqual(pl.length, 4);
});
ok('mono: one plane over everything, low edge at the eave, rising away from the facing direction', () => {
  const pl = RP.planes(rect(10, 8), { shape: 'mono', pitch: 10, eave: 3 }, 0, 0);
  assert.strictEqual(pl.length, 1);
  close(pl[0].zAt(5, 8), 3); close(pl[0].zAt(5, 0), 3 + 8 * Math.tan(10 * Math.PI / 180));
});
ok('gable through planes() matches Roof3D.gablePlanes; names follow the true azimuth', () => {
  const pl = RP.planes(rect(10, 6), { shape: 'gable', pitch: 30 }, 90, 90);   // faces plan east, plan turned 90°: true north
  assert.strictEqual(pl.length, 2);
  assert.strictEqual(pl[0].name, 'North plane'); assert.strictEqual(pl[1].name, 'South plane');
  close(pl[0].trueAz, 0); close(pl[1].trueAz, 180);
  close(area(pl[0].poly) + area(pl[1].poly), 60);
});
ok('default use: planes facing within 70° of north, a mono always, a flat deck never; planeUse overrides', () => {
  const pl = RP.planes(rect(12, 8), { shape: 'hip', pitch: 25 }, 0, 0);
  assert.deepStrictEqual(RP.used(pl, { shape: 'hip' }).filter(Boolean).length, 1);
  assert.deepStrictEqual(RP.used(pl, { shape: 'hip', planeUse: Object.fromEntries(pl.map(p => [p.name, true])) }), [true, true, true, true]);
  assert.deepStrictEqual(RP.used(RP.planes(rect(5, 5), { shape: 'mono', pitch: 5 }, 180, 0), { shape: 'mono' }), [true]);
  assert.deepStrictEqual(RP.used(RP.planes(rect(5, 5), { shape: 'flat' }, 0, 0), { shape: 'flat' }), [false]);
});
ok('modules on a hip plane stay inside its outline and the setback, on the plane, capped by max', () => {
  const foot = rect(12, 8), pl = RP.planes(foot, { shape: 'hip', pitch: 25, eave: 3 }, 0, 0).find(p => Math.round(p.az) === 0);
  const mods = RP.layoutPlane(pl, foot, 0.5, { len: 1.7, wid: 1.1 }, 1e9);
  assert(mods.length > 0);
  for (const m of mods) for (const p of m) { assert(R_inside(p, pl.poly) && p[1] <= 7.5 + 1e-6 && p[0] >= 0.5 - 1e-6 && p[0] <= 11.5 + 1e-6); close(p[2], pl.zAt(p[0], p[1]) + 0.04); }
  assert.strictEqual(RP.layoutPlane(pl, foot, 0.5, { len: 1.7, wid: 1.1 }, 3).length, 3);
  function R_inside(p, poly) { return Roof3D._inside([p[0], p[1]], poly) || Roof3D._edgeDist([p[0], p[1]], poly) < 1e-6; }
});
ok('a mono layout fills the footprint like a gable plane over the same area (same modules per row)', () => {
  const foot = rect(10, 6), mono = RP.planes(foot, { shape: 'mono', pitch: 20, eave: 3 }, 0, 0)[0];
  const a = RP.layoutPlane(mono, foot, 0.5, { len: 2, wid: 1 }, 1e9);
  const g = RP.planes(foot, { shape: 'gable', pitch: 20, eave: 3 }, 0, 0)[0];
  const b = RP.layoutPlane(g, foot, 0.5, { len: 2, wid: 1 }, 1e9);
  const old = Roof3D.layoutModules(foot, 0, 20, 0.5, { len: 2, wid: 1 }, 1e9, Roof3D.gablePlanes(foot, 0, 20, 3));
  assert.strictEqual(b.length, old.length, 'the generic layout agrees with the gable layout');
  assert(a.length > b.length, 'the mono plane is twice as deep');
});
ok('usable area: plane outline inside the setback over cos pitch', () => {
  const foot = rect(12, 8), mono = RP.planes(foot, { shape: 'mono', pitch: 0 }, 0, 0)[0];
  close(RP.usableArea(mono, foot, 0), 96); close(RP.usableArea(mono, foot, 0.5), 77, 0.5);
});
ok('wings: an L is two rectangles, a T two, a U three; a slanted outline is refused', () => {
  const L = [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]];
  const w = RP.splitRectilinear(L); assert.strictEqual(w.length, 2);
  close(w.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0), 10 * 3 + 4 * 5);
  const T = [[0, 5], [14, 5], [14, 11], [0, 11]].slice(0, 0).concat([[0, 7], [4, 7], [4, 0], [10, 0], [10, 7], [14, 7], [14, 13], [0, 13]]);
  assert.strictEqual(RP.splitRectilinear(T).length, 3);
  const U = [[0, 0], [16, 0], [16, 12], [11, 12], [11, 5], [5, 5], [5, 12], [0, 12]];
  const wu = RP.splitRectilinear(U); assert.strictEqual(wu.length, 3);
  close(wu.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0), 16 * 12 - 6 * 7);
  assert.strictEqual(RP.splitRectilinear([[0, 0], [5, 1], [5, 5]]), null);
});
ok('pyramid: four triangles to one apex at the given height', () => {
  const pl = RP.planes(rect(8, 8), { shape: 'pyramid', apex: 2, eave: 3 }, 0, 0);
  assert.strictEqual(pl.length, 4);
  for (const p of pl) { close(area(p.poly), 16); close(p.zAt(4, 4), 5); close(p.zAt(0, 0) > 0 ? p.zAt(p.poly[0][0], p.poly[0][1]) : 3, 3); close(p.pitch, Math.atan(2 / 4) * 180 / Math.PI); }
});
ok('cross-gable L: planes cover the outline once, valleys where the wings meet, the leg stops at the main ridge', () => {
  const L = [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]];
  const pl = RP.planes(L, { shape: 'wings', pitch: 30, eave: 3 }, 0, 0);
  close(pl.reduce((a, p) => a + area(p.poly), 0), 50, 1e-6);                  // each point of the roof is on exactly one plane
  const t = Math.tan(30 * Math.PI / 180);
  const top = (x, y) => { const c = pl.filter(p => Roof3D._inside([x, y], p.poly)); assert.strictEqual(c.length, 1, `one plane at ${x},${y}`); return c[0].zAt(x, y); };
  close(top(5, 1.5), 3 + 1.5 * t);                                           // the main ridge (main wing 10 x 3)
  close(top(2, 6), 3 + 2 * t);                                               // the leg ridge (leg 4 wide)
  close(top(2, 1.6), 3 + 2 * t, 0.01);                                       // the leg ridge runs on to the main ridge
  assert(top(0.2, 0.3) < 3 + 1.5 * t + 1e-9 && top(0.2, 0.3) >= 3);          // the far corner stays at the main wing's roof, not the leg's
  assert.strictEqual(RP.maximalRects(L).length, 2);
});
ok('cross-gable T and U: each valley is where two wings meet; the area adds up', () => {
  const T = [[0, 7], [4, 7], [4, 0], [10, 0], [10, 7], [14, 7], [14, 13], [0, 13]];
  const pt = RP.planes(T, { shape: 'wings', pitch: 25, eave: 3 }, 0, 0);
  close(pt.reduce((a, p) => a + area(p.poly), 0), 14 * 6 + 6 * 7, 1e-6);
  const U = [[0, 0], [16, 0], [16, 12], [11, 12], [11, 5], [5, 5], [5, 12], [0, 12]];
  const pu = RP.planes(U, { shape: 'wings', pitch: 25, eave: 3 }, 0, 0);
  close(pu.reduce((a, p) => a + area(p.poly), 0), 16 * 12 - 6 * 7, 1e-6);
});
ok('lean-to: a plane under the eave, the footprint grows; a catslide carries the plane on', () => {
  const foot = rect(12, 8);
  const m = RP.model(foot, { shape: 'gable', pitch: 24, eave: 3, lean: { side: 'front', kind: 'under', depth: 3, pitch: 8 } }, 0, 0);
  assert.strictEqual(m.planes.length, 3);
  const ln = m.planes[2]; assert(ln.lean); close(ln.az, 0);
  close(area(m.foot), 12 * 11); close(area(ln.poly), 36);
  close(ln.zAt(5, 8), 2.8); close(ln.zAt(5, 11), 2.8 - 3 * Math.tan(8 * Math.PI / 180));
  assert.strictEqual(m.junctions.length, 1);
  const c = RP.model(foot, { shape: 'gable', pitch: 24, eave: 3, lean: { side: 'front', kind: 'catslide', depth: 3 } }, 0, 0);
  assert.strictEqual(c.planes.length, 2); close(area(c.foot), 12 * 11);
  const north = c.planes[0]; close(area(north.poly), 12 * (4 + 3)); close(north.zAt(5, 11), 3 - 3 * Math.tan(24 * Math.PI / 180));
  const e = RP.model(foot, { shape: 'gable', pitch: 24, eave: 3, lean: { side: 'end', kind: 'under', depth: 3, pitch: 11 } }, 0, 0);
  close(area(e.foot), 15 * 8); close(Math.round(e.planes[2].az), 90);
  assert.strictEqual(RP.model([[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]], { shape: 'gable', lean: { side: 'front', depth: 3 } }, 0, 0).planes.length, 2, 'a lean-to needs a rectangle');
});
ok('overhang: planes reach out past the walls and still meet them at the eave height', () => {
  const foot = rect(12, 8), m = RP.model(foot, { shape: 'gable', pitch: 30, eave: 3, overhang: 0.5 }, 0, 0);
  close(area(m.foot), 96);
  const north = m.planes.find(p => Math.round(p.az) === 0);
  close(north.zAt(6, 8), 3); close(north.zAt(6, 8.5), 3 - 0.5 * Math.tan(30 * Math.PI / 180));
  close(m.planes.reduce((a, p) => a + area(p.poly), 0), 13 * 9);
});
console.log(n + ' passed');
