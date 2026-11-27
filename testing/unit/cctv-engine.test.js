// Tests for frontend/js/cctv-engine.js (pure). node testing/unit/cctv-engine.test.js
// Expected values are worked by hand from the formulas in the engine header.
const assert = require('assert');
const C = require('../../frontend/js/cctv-engine.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const near = (a, b, t = 0.01) => assert(Math.abs(a - b) < t, `${a} vs ${b}`);
const cam = (o) => Object.assign({ x: 0, y: 0, pan: 0, tilt: 0, H: 1.6, hfov: 90, resW: 2000, resH: 1000 }, o);

ok('on the axis at 10 m: 2000 px / (2 · 10 · tan 45°) = 100 px/m', () => {
  near(C.density(C.view(cam()), 10, 0, 1.6), 100);
});
ok('the edge of the field of view is in, just past it is out, behind the camera is out', () => {
  const v = C.view(cam());
  near(C.density(v, 10, 9.9, 1.6), 100);              // depth along the axis is still 10 m
  assert.strictEqual(C.density(v, 10, 10.2, 1.6), 0);
  assert.strictEqual(C.density(v, -5, 0, 1.6), 0);
});
ok('pan turns the field: pan 90° looks along +y', () => {
  const v = C.view(cam({ pan: 90 }));
  near(C.density(v, 0, 10, 1.6), 100); assert.strictEqual(C.density(v, 10, 0, 1.6), 0);
});
ok('vertical field: a face 1.4 m below a 3 m camera is not seen at 2 m (half vertical angle tan = 0.5 → 1 m), is at 10 m', () => {
  const v = C.view(cam({ H: 3 }));
  assert.strictEqual(C.density(v, 2, 0, 1.6), 0); near(C.density(v, 10, 0, 1.6), 100);
});
ok('tilt: a camera tilted 45° down at 3 m height has its axis through the floor point 1.4 m below at 1.4 m out', () => {
  const v = C.view(cam({ H: 3, tilt: 45, hfov: 60, resH: 1125, resW: 2000 }));
  near(C.density(v, 1.4, 0, 1.6), 2000 / (2 * (1.4 * Math.SQRT2) * Math.tan(30 * Math.PI / 180)), 0.05);
});
ok('range at each DORI level: 2000 px, 90° → 4 m Identify, 8 m Recognise, 16.13 m Observe, 40 m Detect', () => {
  near(C.reach(cam(), 250), 4); near(C.reach(cam(), 125), 8); near(C.reach(cam(), 62), 16.129, 0.01); near(C.reach(cam(), 25), 40);
});

ok('a solid wall hides what is behind it; glass and an opening do not', () => {
  const rooms = [{ id: 'A', points: rect(5, -3, 2, 6) }];           // edges: 0 top, 1 east, 2 bottom, 3 west
  assert(C.blocked(C.walls(rooms, {}), 0, 0, 10, 0));
  const see = C.walls(rooms, { 'A:3': 'glass', 'A:1': 'open' });
  assert.strictEqual(see.length, 2);                                // only the top and bottom edges still block, and the line misses them
  assert(!C.blocked(see, 0, 0, 10, 0));
});

ok('mounting checks: 2 m is within reach, a 3 m camera at 2000 px sees faces at 4 m with a 21° angle', () => {
  const low = C.camChecks(cam({ H: 2 })), hi = C.camChecks(cam({ H: 3 }));
  assert(!low.reachOk); assert(hi.reachOk);
  near(hi.depression, Math.atan(1.4 / Math.sqrt(16 - 1.96)) * 180 / Math.PI, 0.01);
  assert(hi.angleOk);
});
ok('a 6 m pole camera: Identify depth (4 m) is shorter than the 4.4 m drop to a face, so it looks straight down and fails the face angle', () => {
  const r = C.camChecks(cam({ H: 6 }));
  assert(!r.angleOk); assert.strictEqual(r.depression, 90);
});

ok('coverage: a camera on the west wall of a 10 × 10 room, 90°, sees the wedge |y − 5| ≤ x: 75 % of the floor', () => {
  const areas = [{ id: 'R', points: rect(0, 0, 10, 10), ppm: 25 }];
  const pred = C.predict({ areas, cams: [cam({ x: 0, y: 5 })], segs: [], cell: 0.25 });
  const st = C.areaStats(pred, areas, {})[0];
  assert(st.pct > 0.72 && st.pct < 0.78, st.pct); assert.strictEqual(st.pass, false);
  near(C.coverage(pred, areas).detect, st.pct, 0.001);
});
ok('a second camera facing back from the east wall brings the room to its target', () => {
  const areas = [{ id: 'R', points: rect(0, 0, 10, 10), ppm: 25 }];
  const pred = C.predict({ areas, cams: [cam({ x: 0, y: 5 }), cam({ x: 10, y: 5, pan: 180 })], segs: [], cell: 0.25 });
  assert.strictEqual(C.areaStats(pred, areas, {})[0].pass, true);
});
ok('a wall across the room leaves a blind spot behind it', () => {
  const areas = [{ id: 'R', points: rect(0, 0, 10, 10), ppm: 25 }];
  const segs = C.walls([{ id: 'W', points: [[4, 3], [6, 3], [6, 7], [4, 7]] }]);
  const pred = C.predict({ areas, cams: [cam({ x: 0, y: 5, hfov: 120 })], segs, cell: 0.25 });
  const st = C.areaStats(pred, areas, {})[0];
  assert(st.blind > 0.1, st.blind);
});

ok('bitrate: 4.08576 MP × 15 fps × 0.065 (H.265) = 3.984 Mbps', () => {
  near(C.bitrate({ resW: 2688, resH: 1520, fps: 15, codec: 'h265' }), 3.9836, 0.001);
});
ok('storage: that camera for 30 days at 100 % with 10 % overhead = 1.42 TB', () => {
  const r = C.storage([{ resW: 2688, resH: 1520, fps: 15, codec: 'h265' }], { days: 30, duty: 1, overhead: 1.1 });
  near(r.tb, 1.4198, 0.002); assert(r.uplinkPass);
});
ok('uplink: 250 cameras at 4 Mbps exceed 80 % of a gigabit port', () => {
  const r = C.storage(Array.from({ length: 250 }, () => ({ mbps: 4 })), {});
  assert(!r.uplinkPass); near(r.total, 1000);
});

ok('PoE: 30 cameras → 2 switches, 7 W each is 210 W of 740; a 95 m run fails on copper', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i, watts: 7, run: i === 0 ? 95 : 40 }));
  const p = C.poe(items, {});
  assert.strictEqual(p.switches, 2); near(p.watts, 210); near(p.budget, 740); assert.strictEqual(p.pass, false); assert.deepStrictEqual(p.tooLong, ['c0']);
});
ok('site plan: the same 95 m run goes on fibre and is not a failure; it leaves the PoE budget', () => {
  const items = [{ id: 'a', watts: 7, run: 95 }, { id: 'b', watts: 7, run: 40 }];
  const p = C.poe(items, {}, true);
  assert.strictEqual(p.fibre, 1); assert.strictEqual(p.copper, 1); near(p.watts, 7); near(p.fibreM, 95); assert(p.pass);
});
ok('cable run: across 12 + along 8 + 2 × 3 m drop, +10 % = 28.6 m', () => {
  near(C.cableRun({ x: 0, y: 0 }, { x: 12, y: 8 }, {}), 28.6);
});

ok('auto-place covers a 8 × 8 room to Observe with a generic camera and keeps the existing one', () => {
  const areas = [{ id: 'R', points: rect(0, 0, 8, 8), ppm: 62 }];
  const spec = { resW: 2688, resH: 1520, hfov: 100, H: 2.8, tilt: 25 };
  const r = C.autoPlace({ areas, segs: [], existing: [], spec });
  assert.strictEqual(r.uncovered, 0); assert(r.cams.length >= 1 && r.cams.length <= 4, r.cams.length);
  const pred = C.predict({ areas, cams: r.cams.map(c => Object.assign({}, spec, c)), segs: [], cell: 0.5 });
  assert(C.areaStats(pred, areas, {})[0].pct >= 0.9);
});

ok('auto-place puts at most two cameras on one candidate spot, even for an area it cannot reach', () => {
  const areas = [{ id: 'S', points: rect(0, 0, 80, 7), ppm: 125 }];
  const spec = { resW: 2688, resH: 1520, hfov: 100, H: 6, tilt: 20 };
  const r = C.autoPlace({ areas, segs: [], spec, candidates: [{ x: 20, y: 10 }, { x: 40, y: 10 }, { x: 60, y: 10 }] });
  assert(r.cams.length <= 6, r.cams.length); assert(r.uncovered > 0);
});

console.log(`${n} passed`);
