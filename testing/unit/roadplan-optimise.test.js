// Tests for Road plan › Lay out for the checks (frontend/js/roadplan-optimise.js): the pure parts.
//   node testing/unit/roadplan-optimise.test.js
const assert = require('assert');
const { RoadPlanOpt: O } = require('../../frontend/js/roadplan-optimise.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const RC3 = [{ key: 'Eav', req: 15 }, { key: 'Uo', req: 0.4 }];

ok('score: Ē, Emin, Uo and the worst margin against the class', () => {
  const s = O.score([10, 20, 30], RC3);
  assert.strictEqual(s.v.Eav, 20); assert.strictEqual(s.v.Emin, 10); assert.strictEqual(s.v.Uo, 0.5);
  assert.strictEqual(s.pass, true); assert.ok(Math.abs(s.margin - 1.25) < 1e-9);       // Uo 0.5 / 0.4
  const f = O.score([2, 20, 20], RC3);                                                   // Uo 0.14
  assert.strictEqual(f.pass, false); assert.ok(f.margin < 1);
});

ok('bestSet: the fewest candidates that pass, the best margin among equals', () => {
  // four points; candidate 0 lights the left half, 1 the right half, 2 everything a little, 3 a hot spot
  const area = { checks: RC3, base: [0, 0, 0, 0], cand: { 0: [30, 30, 0, 0], 1: [0, 0, 30, 30], 2: [16, 16, 16, 16], 3: [100, 0, 0, 0] } };
  const one = O.bestSet(area, [0, 1, 2, 3], 4);
  assert.deepStrictEqual(one.set, [2]);                                                  // one even pole beats two halves
  const noEven = O.bestSet(area, [0, 1, 3], 4);
  assert.deepStrictEqual(noEven.set, [0, 1]); assert.strictEqual(noEven.pass, true);
  // what is already there counts: the base alone may pass (no pole needed)
  assert.deepStrictEqual(O.bestSet({ ...area, base: [20, 20, 20, 20] }, [0, 1, 2, 3], 4).set, []);
  // nothing passes: the best margin, flagged
  const none = O.bestSet({ ...area, cand: { 3: [100, 0, 0, 0] } }, [3], 4);
  assert.strictEqual(none.pass, false); assert.deepStrictEqual(none.set, [3]);
  // maxN limits the size
  assert.strictEqual(O.bestSet(area, [0, 1, 3], 1).pass, false);
});

ok('fillStations: free ends get a pole `start` in, gaps between poles split evenly at ≤ S', () => {
  const st = O.fillStations([], 100, 30, false, false, 3);
  assert.deepStrictEqual(st.map(x => +x.toFixed(2)), [3, 26.5, 50, 73.5, 97]);         // 94 m in 4 gaps of 23.5
  const st2 = O.fillStations([50], 100, 30, false, false, 3);
  assert.ok(st2.includes(50));
  for (let i = 1; i < st2.length; i++) assert.ok(st2[i] - st2[i - 1] <= 30 + 1e-9);
});

ok('fillStations: an end in a junction needs no pole there, the last one within S/2 of it', () => {
  // junction poles at 0-end handled by the junction: the open end at s = 0, a fixed junction pole at 80
  const st = O.fillStations([80], 100, 30, true, false, 3);
  assert.ok(st.includes(80) && st.includes(97));
  assert.ok(st[0] <= 15 + 1e-9, 'first pole within S/2 of the open end: ' + st[0]);
  for (let i = 1; i < st.length; i++) assert.ok(st[i] - st[i - 1] <= 30 + 1e-9);
  // a short stretch to an open end needs nothing more
  assert.deepStrictEqual(O.fillStations([10], 20, 30, true, true, 3), [10]);
  // a road between two junctions with no junction pole on it: poles in the middle of equal parts
  assert.deepStrictEqual(O.fillStations([], 60, 30, true, true).map(x => +x.toFixed(1)), [15, 45]);
});

ok('fillStations: a staggered row sits between, never on the fixed points', () => {
  const st = O.fillStations([], 100, 30, false, false, 3, 0.5);
  assert.ok(st.length >= 3 && !st.some(s => Math.abs(s - 3) < 0.5 || Math.abs(s - 97) < 0.5));
});

ok('fillStations: an end at a junction that has its own poles counts as lit — the street poles start a full spacing out', () => {
  const lit = O.fillStations([], 100, 30, 'lit', false, 3), open = O.fillStations([], 100, 30, true, false, 3);
  assert.ok(lit[0] > 15 + 1e-9 && lit[0] <= 30 + 1e-9, 'first pole ' + lit[0]);
  assert.ok(open[0] <= 15 + 1e-9);
  assert.ok(!lit.includes(0), 'no pole put at the lit end');
});

console.log(`${n} passed`);
