// Tests for frontend/js/plan-bdgeom.js (pure geometry, no browser).
//   node testing/unit/bdgeom.test.js
// Radii here are plain numbers chosen so the answer can be worked by hand; they are not standards values.
const assert = require('assert');
const G = require('../../frontend/js/plan-bdgeom.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const turn = (P, a, c = [0, 0]) => P.map(p => { const dx = p[0] - c[0], dy = p[1] - c[1]; return [c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a)]; });
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];     // 10 x 10 with the top-right 6 x 6 cut out

ok('area / centroid / convexity', () => {
  assert.strictEqual(G.area(rect(0, 0, 6, 4)), 24);
  assert.deepStrictEqual(G.centroid(rect(0, 0, 6, 4)).map(v => +v.toFixed(9)), [3, 2]);
  assert(G.isConvex(rect(0, 0, 6, 4)));
  assert(!G.isConvex(L));
  assert.strictEqual(G.area(L), 64);
});

ok('inside counts the boundary; objects as points work', () => {
  assert(G.inside(L, [1, 9]));
  assert(!G.inside(L, [8, 8]));
  assert(G.inside(L, [10, 2]), 'on the wall');
  assert(G.inside(rect(0, 0, 2, 2), { x: 1, y: 1 }));
  assert(Math.abs(G.distToBoundary([3, 3], rect(0, 0, 6, 6))) - 3 < 1e-9);
});

ok('coverage: one detector in a 6 x 6 room — the corner decides (distance 4.243)', () => {
  const sq = rect(0, 0, 6, 6);
  const pass = G.coverage(sq, [[3, 3]], 4.3), fail = G.coverage(sq, [[3, 3]], 4.2);
  assert(pass.pass, 'R 4.3 should cover the corner');
  assert(!fail.pass && fail.fraction < 1);
  assert(Math.abs(fail.worst.d - Math.hypot(3, 3)) < 1e-9, 'worst ' + fail.worst.d);
  assert(fail.uncovered.length > 0);
});

ok('coverage: no detectors is a fail with an infinite worst distance', () => {
  const r = G.coverage(rect(0, 0, 4, 4), [], 5);
  assert(!r.pass); assert.strictEqual(r.worst.d, Infinity); assert.strictEqual(r.fraction, 0);
});

ok('visible: a detector does not see round the corner of an L-shaped room', () => {
  assert(G.visible(L, [1, 1], [9, 2]), 'down the long arm');
  assert(!G.visible(L, [9, 2], [2, 9]), 'across the missing corner');
  assert(G.visible(L, [2, 2], [2, 9]), 'up the other arm');
  assert(G.visible(L, [2, 4], [4, 4]), 'along the re-entrant wall');
});

ok('coverage: within the radius but round the corner is not covered', () => {
  // the two arm tips are 8.9 apart straight through the cut-out, so radius 9 would "reach" if walls were ignored
  const r = G.coverage(L, [[9, 2]], 11);
  assert(!r.pass, 'the far arm is hidden');
  assert(r.worst.y > 5, 'worst point is in the vertical arm: ' + JSON.stringify(r.worst));
});

ok('a partition wall blocks coverage', () => {
  const sq = rect(0, 0, 8, 4), wall = [[4, 0], [4, 3]];            // 3 m partition, 1 m gap at the top
  assert(G.coverage(sq, [[1, 2]], 9.5).pass, 'no wall: one detector sees all');
  const w = G.coverage(sq, [[1, 2]], 9.5, { walls: [wall] });
  assert(!w.pass, 'the lower right is hidden behind the wall');
  assert(w.worst.x > 4 && w.worst.y < 3);
});

ok('layout: 12 x 12 at R 5 needs exactly 4 (a 2 x 2 grid), proved', () => {
  const r = G.layout(rect(0, 0, 12, 12), { radius: 5 });
  assert.strictEqual(r.detectors.length, 4);
  assert.strictEqual(r.method, 'grid');
  assert(r.coverage.pass); assert.strictEqual(r.stuck.length, 0);
  r.detectors.forEach(d => assert(G.distToBoundary(d, rect(0, 0, 12, 12)) >= 0.5 - 1e-9));
});

ok('layout: a small room takes one detector in the middle', () => {
  const r = G.layout(rect(0, 0, 5, 4), { radius: 4 });
  assert.strictEqual(r.detectors.length, 1);
  assert(Math.hypot(r.detectors[0][0] - 2.5, r.detectors[0][1] - 2) < 0.3);
  assert(r.coverage.pass);
});

ok('layout: a long corridor 30 x 2 at R 4 is a single row', () => {
  const r = G.layout(rect(0, 0, 30, 2), { radius: 4 });
  assert(r.coverage.pass);
  // along the corridor each detector covers about 2*sqrt(16-1) = 7.75 m of it
  assert.strictEqual(r.detectors.length, 4);
  const ys = r.detectors.map(d => d[1]); assert(Math.max(...ys) - Math.min(...ys) < 0.3, 'one row');
});

ok('layout: the same room turned 30 degrees needs the same number', () => {
  const a = G.layout(rect(0, 0, 12, 12), { radius: 5 }), b = G.layout(turn(rect(0, 0, 12, 12), Math.PI / 6), { radius: 5 });
  assert.strictEqual(b.detectors.length, a.detectors.length);
  assert(b.coverage.pass);
  const c = G.layout(turn(rect(0, 0, 30, 2), 0.7), { radius: 4 });
  assert.strictEqual(c.detectors.length, 4); assert(c.coverage.pass);
});

ok('layout: an L-shaped room is covered with every detector sighted', () => {
  const r = G.layout(L, { radius: 6 });
  assert(r.coverage.pass, 'worst ' + JSON.stringify(r.coverage.worst));
  assert(r.detectors.length >= 2 && r.detectors.length <= 4, 'count ' + r.detectors.length);
  r.detectors.forEach(d => assert(G.inside(L, d)));
  // the layout is not allowed to lean on a detector seeing round the corner
  assert(G.coverage(L, r.detectors, 6).pass);
});

ok('layout: a partition makes it add a detector behind the wall', () => {
  const sq = rect(0, 0, 8, 4), wall = [[4, 0], [4, 4]];          // full-height partition
  const free = G.layout(sq, { radius: 6 }), walled = G.layout(sq, { radius: 6, walls: [wall] });
  assert(walled.coverage.pass);
  assert(walled.detectors.length > free.detectors.length, `${walled.detectors.length} vs ${free.detectors.length}`);
});

ok('layout: clearance larger than the room allows reports the points it cannot reach', () => {
  const r = G.layout(rect(0, 0, 4, 4), { radius: 2, clearance: 1.9 });
  assert(r.detectors.length >= 1);
  assert(r.stuck.length > 0 || !r.coverage.pass, 'a corner cannot be reached from the only allowed spot');
});

ok('zoneOf: smallest zone wins, outside is null', () => {
  const zones = [{ id: 'floor', points: rect(0, 0, 50, 50) }, { id: 'a', points: rect(0, 0, 10, 10) }];
  assert.strictEqual(G.zoneOf([5, 5], zones).id, 'a');
  assert.strictEqual(G.zoneOf([20, 20], zones).id, 'floor');
  assert.strictEqual(G.zoneOf([60, 60], zones), null);
});

console.log(n + ' passed');
