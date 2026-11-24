// Tests for frontend/js/sl-layout.js (pure, no browser).
//   node testing/unit/sl-layout.test.js
const assert = require('assert');
const SL = require('../../frontend/js/sl-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);

// one street along x from 0 to 200 m; poles 6 m to its left (y = +6) every 40 m, from x = 20
const street = { id: 's1', name: 'Main', pts: [[0, 0], [200, 0]] };
const polesL = [20, 60, 100, 140, 180].map((x, i) => ({ id: 'L' + i, x, y: 6 }));

ok('a road side is one component; the feed at its start feeds a row', () => {
  const r = SL.plan({ poles: polesL, streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }] });
  assert.strictEqual(r.comps.length, 1); assert.strictEqual(r.unassigned.length, 0);
  const c = r.comps[0];
  assert.deepStrictEqual(c.poles.map(p => p.id), ['L0', 'L1', 'L2', 'L3', 'L4']);
  assert.deepStrictEqual(c.parent, [null, 0, 1, 2, 3]);
  near(c.feederM, 4 + 20, 0.01); near(c.feederToM[4], 4 + 180, 0.01);           // 4 m onto the pole line, then along it
  assert.deepStrictEqual(c.spanM, [0, 40, 40, 40, 40]);
});

ok('a feed beside the middle: one tree, both ways from the pole nearest it', () => {
  const r = SL.plan({ poles: polesL, streets: [street], feeds: [{ id: 'K', x: 110, y: 12 }] });
  assert.strictEqual(r.comps.length, 1);
  const c = r.comps[0], id = i => c.poles[i].id;
  assert.strictEqual(id(0), 'L2');                                               // x 100: the nearest pole
  const kidsOfRoot = c.parent.map((q, i) => q === 0 ? id(i) : null).filter(Boolean).sort();
  assert.deepStrictEqual(kidsOfRoot, ['L1', 'L3']);
});

ok('each side of a road its own component; joined across the road end when asked', () => {
  const polesR = [30, 90].map((x, i) => ({ id: 'R' + i, x, y: -6 }));
  let r = SL.plan({ poles: polesL.concat(polesR), streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }] });
  assert.strictEqual(r.comps.length, 2);
  const right = r.comps.find(c => c.poles[0].id.startsWith('R'));
  assert.ok(SL.usage(r, [right]).crossings.length >= 1);                         // its feeder crosses the road
  r = SL.plan({ poles: polesL.concat(polesR), streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }], o: { joinSides: true } });
  assert.strictEqual(r.comps.length, 1); assert.strictEqual(r.comps[0].poles.length, 7);
});

ok('round the corner: the inside of an L is one component, no crossing', () => {
  const A = { id: 'A', pts: [[0, 0], [100, 0]] }, B = { id: 'B', pts: [[100, 0], [100, -100]] };
  // the block inside the L lies at y < 0, x < 100: A's right side (−1), B's right side (−1)
  const ps = [{ id: 'a1', x: 30, y: -6 }, { id: 'a2', x: 70, y: -6 }, { id: 'b1', x: 94, y: -40 }, { id: 'b2', x: 94, y: -80 }];
  const r = SL.plan({ poles: ps, streets: [A, B], feeds: [{ id: 'K', x: 10, y: -10 }] });
  assert.strictEqual(r.comps.length, 1);
  assert.deepStrictEqual(r.comps[0].poles.map(p => p.id), ['a1', 'a2', 'b1', 'b2']);
  assert.strictEqual(SL.usage(r, r.comps).crossings.length, 0);
});

ok('a feeder follows the verges round the corner, not a straight line across the block', () => {
  // two parallel streets joined by a cross street; the feed is on the top one, the poles on the bottom one
  const top = { id: 'T', pts: [[0, 100], [200, 100]] }, bot = { id: 'Bo', pts: [[0, 0], [200, 0]] }, cross = { id: 'X', pts: [[200, 0], [200, 100]] };
  const ps = [40, 80, 120].map((x, i) => ({ id: 'p' + i, x, y: 6 }));          // the block side of the bottom street
  const r = SL.plan({ poles: ps, streets: [top, bot, cross], feeds: [{ id: 'K', x: 60, y: 94 }] });
  const c = r.comps[0], f = c.feederPts;
  assert.ok(c.feederM > 200, 'routed round the block: ' + c.feederM);             // along y≈94, down x≈194, back along y≈6
  for (let i = 1; i < f.length; i++) { const m = [(f[i - 1][0] + f[i][0]) / 2, (f[i - 1][1] + f[i][1]) / 2];
    assert.ok([top, bot, cross].some(s => SL.project(m, s.pts).d <= 12), 'off the verges at ' + m); }
  assert.strictEqual(SL.usage(r, r.comps).crossings.length, 0);                  // the inside of the block: no road to cross
});

ok('poles far from a road or a feed are reported', () => {
  const r = SL.plan({ poles: polesL.concat([{ id: 'X', x: 100, y: 90 }]), streets: [street], feeds: [{ id: 'K', x: -200, y: 10 }], o: { maxFeedM: 100 } });
  assert.strictEqual(r.unassigned.find(u => u.id === 'X').reason, 'no road within 40 m');
  assert.strictEqual(r.comps.length, 0);
  assert.strictEqual(r.unassigned.filter(u => u.id.startsWith('L')).length, 5);
});

ok('uncovered: the pieces of a run away from the lines given', () => {
  const run = [[0, 0], [100, 0]], lines = [[[20, 0.5], [60, 0.5]]];
  const u = SL.uncovered(run, lines);
  assert.strictEqual(u.length, 2); near(u[0][1][0], 19.5, 1.01); near(u[1][0][0], 61, 1.01);
});

ok('offset: a mitred corner keeps the distance', () => {
  const o = SL.offset([[0, 0], [10, 0], [10, 10]], 1);
  assert.deepStrictEqual(o.map(p => p.map(v => Math.round(v * 1000) / 1000)), [[0, 1], [9, 1], [9, 10]]);
});

ok('poles along a street: spacing, the slack at both ends, one side / both / staggered', () => {
  const st = { id: 's', pts: [[0, 0], [200, 0]] };
  let ps = SL.polesAlong(st, { spacing: 35, off: 6, arr: 'A' });
  assert.deepStrictEqual(ps.map(p => p.s), [12.5, 47.5, 82.5, 117.5, 152.5, 187.5]);    // 6 poles, 12.5 m from each end
  assert.ok(ps.every(p => p.y === 6 && p.side === 1));
  ps = SL.polesAlong(st, { spacing: 35, off: 6, arr: 'both' }); assert.strictEqual(ps.length, 12);
  ps = SL.polesAlong(st, { spacing: 40, off: 6, arr: 'stagger' });
  assert.deepStrictEqual(ps.slice(0, 3).map(p => [p.s, p.y]), [[20, 6], [40, -6], [60, 6]]);
  // a side street joining at x = 100 takes out the pole in its mouth; so does a pole already there
  const side = { id: 't', pts: [[100, 0], [100, 80]] };
  ps = SL.polesAlong(st, { spacing: 20, off: 6, arr: 'A', endM: 0 }, [st, side], [[20, 6]]);
  assert.ok(!ps.some(p => Math.abs(p.x - 100) < 3)); assert.ok(!ps.some(p => Math.abs(p.x - 20) < 3));
});

console.log(n + ' passed');
