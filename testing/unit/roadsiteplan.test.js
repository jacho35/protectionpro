// Tests for Road plan › roads from the site plan (frontend/js/roadplan-siteplan.js): plan streets → one road each.
//   node testing/unit/roadsiteplan.test.js
const assert = require('assert');
const { RoadSitePlan: S } = require('../../frontend/js/roadplan-siteplan.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const st = (id, pts, o = {}) => Object.assign({ id, name: '', pts, carriageW: 0, cwOffset: 0 }, o);

ok('separate streets stay separate roads (a T: the side street ends on the through street)', () => {
  const r = S.runs([st('a', [[0, 0], [100, 0]]), st('b', [[50, 0], [50, 60]])]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(x => x.ids), [['a'], ['b']]);
});

ok('a street the reserve tool cut at a crossing is joined back straight through', () => {
  // four stretches meeting at (50, 0): a+c run east-west, b+d north-south
  const r = S.runs([st('a', [[0, 0], [50, 0]]), st('b', [[50, 0], [50, 40]]), st('c', [[50, 0], [100, 0]]), st('d', [[50, -40], [50, 0]])]);
  assert.strictEqual(r.length, 2);
  const ew = r.find(x => x.ids.includes('a')), ns = r.find(x => x.ids.includes('b'));
  assert.deepStrictEqual(ew.ids.slice().sort(), ['a', 'c']);
  assert.deepStrictEqual(ns.ids.slice().sort(), ['b', 'd']);
  assert.strictEqual(ew.pts.length, 3);
  assert.deepStrictEqual([ew.pts[0], ew.pts[2]].map(p => p[0]).sort((x, y) => x - y), [0, 100]);
});

ok('centrelines meeting at a sharp corner are not joined, nor a carriageway and a centreline', () => {
  assert.strictEqual(S.runs([st('a', [[0, 0], [50, 0]]), st('b', [[50, 0], [50, 40]])]).length, 2);
  assert.strictEqual(S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6 }), st('b', [[50, 0], [100, 0]])]).length, 2);
});

ok('carriageways of another width are joined; the kerbs taper evenly across the joint', () => {
  global.PlanReserve = require('../../frontend/js/plan-reserve.js');
  const r = S.runs([st('a', [[0, 0], [100, 0]], { carriageW: 9 }), st('b', [[100, 0], [200, 0]], { carriageW: 6 })]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].prof.map(x => [x.w, x.o]), [[9, 0], [6, 0]]);
  // each kerb moves 1.5 m: a taper of 20 × 1.5 = 30 m, centred on the joint, S-shaped
  const pr = S.profile(r[0], r[0].pts);
  assert.deepStrictEqual(pr.zones, [[85, 115]]);
  assert.strictEqual(pr.at(80).w, 9); assert.strictEqual(pr.at(120).w, 6); assert.strictEqual(pr.at(100).w, 7.5);
  assert.ok(Math.abs(pr.at(86).w - 9) < 0.02 && Math.abs(pr.at(114).w - 6) < 0.02);       // leaves and meets the straight kerbs tangentially
  const k = S.taperKerbs(r[0], r[0].pts), half = x => { const L = k.left.find(p => Math.abs(p[0] - x) < 1e-6); return L && L[1]; };
  assert.strictEqual(half(85), 4.5); assert.strictEqual(half(100), 3.75); assert.strictEqual(half(115), 3);
  for (let i = 1; i < k.left.length; i++) assert.ok(k.left[i][1] <= k.left[i - 1][1] + 1e-9, 'the kerb narrows steadily');
  // a short road: the taper keeps to the road
  const s2 = S.runs([st('a', [[0, 0], [8, 0]], { carriageW: 12 }), st('b', [[8, 0], [100, 0]], { carriageW: 6 })])[0];
  assert.ok(S.profile(s2, s2.pts).zones[0][0] >= 0);
  delete global.PlanReserve;
});

ok('an offset is read along the run: a piece turned round has it on the other side', () => {
  const r = S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6, cwOffset: 1 }), st('b', [[100, 0], [50, 0]], { carriageW: 6, cwOffset: -1 })]);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].prof, undefined);
  assert.strictEqual(r[0].cwOffset, 1);
  const q = S.runs([st('b', [[100, 0], [50, 0]], { carriageW: 6, cwOffset: 1 }), st('a', [[50, 0], [0, 0]], { carriageW: 6, cwOffset: 1 })])[0];
  assert.strictEqual(q.prof, undefined); assert.strictEqual(Math.abs(q.cwOffset), 1);
});

ok('two carriageways meeting only each other at a corner are one road (the plan draws it as one street turning)', () => {
  const r = S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6 }), st('b', [[50, 0], [50, 40]], { carriageW: 6 })]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].pts, [[0, 0], [50, 0], [50, 40]]);
  // a third street at that point makes it a junction: the 90° pieces stay separate
  assert.strictEqual(S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6 }), st('b', [[50, 0], [50, 40]], { carriageW: 6 }), st('c', [[50, 0], [50, -40]], { carriageW: 6 })]).length, 2);
});

ok('a corner is rounded so the kerbs are the plan\'s inner and outer arcs (inner R, outer R + carriageway)', () => {
  global.PlanReserve = require('../../frontend/js/plan-reserve.js');
  const circ = (a, b, c) => { const D = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])), q = p => p[0] * p[0] + p[1] * p[1];
    const ux = (q(a) * (b[1] - c[1]) + q(b) * (c[1] - a[1]) + q(c) * (a[1] - b[1])) / D, uy = (q(a) * (c[0] - b[0]) + q(b) * (a[0] - c[0]) + q(c) * (b[0] - a[0])) / D; return Math.hypot(a[0] - ux, a[1] - uy); };
  for (const [off, end, R] of [[0, [50, 40], 8], [0, [50, -40], 12], [1, [50, 40], 8], [1, [50, -40], 8]]) {
    const run = S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6, cwOffset: off }), st('b', [[50, 0], end], { carriageW: 6, cwOffset: off })])[0];
    const r = S.rounded(run, [{ x: 50, y: 0, R }]);
    assert.deepStrictEqual(r.radii, [R]);
    const k = PlanReserve.kerbLines({ pts: r.pts, carriageW: 6, cwOffset: off }), i = Math.floor(r.pts.length / 2);
    const radii = [k.left, k.right].map(L => circ(L[i - 5], L[i], L[i + 5])).sort((x, y) => x - y);
    assert.ok(Math.abs(radii[0] - R) < 0.05 && Math.abs(radii[1] - (R + 6)) < 0.05, `${off} ${end}: ${radii}`);
  }
  // a corner where the width changes: the inner kerb has the plan's radius at the joint, the taper runs round it
  {
    const run = S.runs([st('a', [[0, 0], [60, 0]], { carriageW: 9 }), st('b', [[60, 0], [60, 60]], { carriageW: 6 })])[0];
    const r = S.rounded(run, [{ x: 60, y: 0, R: 8 }]);
    const k = S.taperKerbs(run, r.pts);
    // the arc's middle (the joint, width 7.5): the inner (left, the turn is anticlockwise) kerb 8 m from the arc centre
    // the arc centre: on the bisector from the corner (60, 0), Rc = 8 + 7.5 / 2 from the centreline's arc; the inner kerb point
    // on the bisector is 8 m from it, the outer one 8 + 7.5 m (the plan's inner radius, outer = inner + the width there)
    const Rc = 8 + 3.75, C = [60 - Rc, Rc], dir = Math.atan2(0 - C[1], 60 - C[0]);
    const onBis = L => L.reduce((b, p) => Math.abs(Math.atan2(p[1] - C[1], p[0] - C[0]) - dir) < Math.abs(Math.atan2(b[1] - C[1], b[0] - C[0]) - dir) ? p : b);
    const dist = p => Math.hypot(p[0] - C[0], p[1] - C[1]);
    assert.ok(Math.abs(dist(onBis(k.left)) - 8) < 0.05, `inner ${dist(onBis(k.left))}`);
    assert.ok(Math.abs(dist(onBis(k.right)) - 15.5) < 0.05, `outer ${dist(onBis(k.right))}`);
    const w0 = Math.hypot(k.left[0][0] - k.right[0][0], k.left[0][1] - k.right[0][1]), w1 = Math.hypot(k.left.at(-1)[0] - k.right.at(-1)[0], k.left.at(-1)[1] - k.right.at(-1)[1]);
    assert.ok(Math.abs(w0 - 9) < 1e-6 && Math.abs(w1 - 6) < 1e-6);
  }
  // no sharp turn: nothing to round
  assert.strictEqual(S.rounded(S.runs([st('a', [[0, 0], [50, 0], [100, 5]], { carriageW: 6 })])[0], []), null);
  delete global.PlanReserve;
});

ok('a reversed piece is turned round to continue the run', () => {
  const r = S.runs([st('a', [[0, 0], [50, 0]]), st('b', [[100, 0], [50, 0]])]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].pts, [[0, 0], [50, 0], [100, 0]]);
});

ok('name and signature: the longest piece names the road; the signature follows the geometry', () => {
  const a = S.runs([st('a', [[0, 0], [80, 0]], { name: 'Main Road' }), st('b', [[80, 0], [100, 0]], { name: 'Street 7' })])[0];
  assert.strictEqual(a.name, 'Main Road');
  const b = S.runs([st('a', [[0, 0], [80, 0.5]], { name: 'Main Road' }), st('b', [[80, 0.5], [100, 0]])])[0];
  assert.notStrictEqual(a.sig, b.sig);
});

ok('the plan frame (y down) turns into the Road plan frame (y north)', () => {
  assert.deepStrictEqual(S.flipPts([[1, 2], [3, -4]]), [[1, -2], [3, 4]]);
});

ok('a closed ring of pieces is one road, each piece once', () => {
  const r = S.runs([st('a', [[0, 0], [50, 0]]), st('b', [[50, 0], [100, 0]]), st('c', [[100, 0], [0, 0.0001]])]);
  const all = r.flatMap(x => x.ids).sort();
  assert.deepStrictEqual(all, ['a', 'b', 'c']);
});

console.log(`${n} passed`);
