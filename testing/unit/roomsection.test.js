// Ceiling sections (frontend/js/roomsection.js, no browser).
//   node testing/unit/roomsection.test.js
const assert = require('assert');
const RS = require('../../frontend/js/roomsection.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const RECT = [[0, 0], [8, 0], [8, 6], [0, 6]];          // engine frame: 8 m along x, 6 m along y

ok('gable: eaves at both ends, apex where asked', () => {
  const p = RS.profile({ type: 'gable', eaves: 3, apex: 5, apexAt: 0.25 }, 8);
  assert.deepStrictEqual(p, [[0, 3], [2, 5], [8, 3]]);
});
ok('mono: low to high, or the other way round', () => {
  assert.deepStrictEqual(RS.profile({ type: 'mono', low: 2.6, high: 4.2 }, 6), [[0, 2.6], [6, 4.2]]);
  assert.deepStrictEqual(RS.profile({ type: 'mono', low: 2.6, high: 4.2, flip: true }, 6), [[0, 4.2], [6, 2.6]]);
});
ok('barrel: a circular segment through the springing and the crown', () => {
  const p = RS.profile({ type: 'barrel', eaves: 3, crown: 5 }, 8);
  near(p[0][1], 3); near(p[p.length - 1][1], 3); near(p[12][0], 4); near(p[12][1], 5);
  const R = (16 + 4) / 4, cz = 5 - R;                       // centre below the crown
  for (const [s, z] of p) near(Math.hypot(s - 4, z - cz), R, 1e-9);
});
ok('a drawn section stretches with the room', () => {
  const p = RS.profile({ type: 'poly', points: [[0, 3], [2, 3], [2, 4.5], [4, 4.5]], width: 4 }, 8);
  assert.deepStrictEqual(p, [[0, 3], [4, 3], [4, 4.5], [8, 4.5]]);
});
ok('ridge along a wall: the section runs square to it, across the whole room', () => {
  const a0 = RS.axis({ type: 'gable', wall: 0 }, RECT);        // ridge along x
  near(Math.abs(a0.uy), 1); near(a0.W, 6);
  const a1 = RS.axis({ type: 'gable', wall: 1 }, RECT);        // ridge along y
  near(Math.abs(a1.ux), 1); near(a1.W, 8);
  const a = RS.axis({ type: 'gable', wall: -1, angle: 90 }, RECT);
  near(Math.abs(a.ux), 1); near(a.W, 8);
  assert.strictEqual(RS.longestWall(RECT), 0);
});
ok('request: angle, start and points the engine needs; flat sends nothing', () => {
  const room = { section: { type: 'gable', wall: 0, eaves: 3, apex: 5, apexAt: 0.5 } };
  const c = RS.request(room, RECT);
  near(Math.abs(c.angle), 90); assert.strictEqual(c.points.length, 3);
  near(c.points[2][0], 6); near(c.points[1][1], 5);
  const s = RECT.map(p => p[0] * Math.cos(c.angle * Math.PI / 180) + p[1] * Math.sin(c.angle * Math.PI / 180) - c.s0);
  near(Math.min(...s), 0); near(Math.max(...s), 6);
  assert.strictEqual(RS.request({}, RECT), undefined);
  assert.strictEqual(RS.request({ section: { type: 'flat' } }, RECT), undefined);
});
ok('problems: overhangs and too-low ceilings are refused', () => {
  assert.strictEqual(RS.problem({ type: 'gable', eaves: 3, apex: 5 }, 8), '');
  assert.match(RS.problem({ type: 'poly', points: [[0, 3], [5, 4], [3, 4], [8, 3]], width: 8 }, 8), /one way/);
  assert.match(RS.problem({ type: 'mono', low: 0.5, high: 3 }, 8), /at least 1 m/);
  assert.deepStrictEqual(RS.heights({ section: { type: 'mono', low: 2.5, high: 4 } }, RECT), { min: 2.5, max: 4 });
});
console.log(`${n} passed`);
