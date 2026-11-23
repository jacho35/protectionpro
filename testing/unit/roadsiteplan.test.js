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

ok('two pieces meeting at a sharp corner are not joined, nor two of different carriageway', () => {
  assert.strictEqual(S.runs([st('a', [[0, 0], [50, 0]]), st('b', [[50, 0], [50, 40]])]).length, 2);
  assert.strictEqual(S.runs([st('a', [[0, 0], [50, 0]], { carriageW: 6 }), st('b', [[50, 0], [100, 0]], { carriageW: 7.4 })]).length, 2);
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
