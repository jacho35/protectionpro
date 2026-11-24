// Tests for frontend/js/sl-layout.js (pure, no browser).
//   node testing/unit/sl-layout.test.js
const assert = require('assert');
const SL = require('../../frontend/js/sl-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);

// one street along x from 0 to 200 m; poles 6 m to its left (y = +6) every 40 m, from x = 20
const street = { id: 's1', name: 'Main', pts: [[0, 0], [200, 0]] };
const polesL = [20, 60, 100, 140, 180].map((x, i) => ({ id: 'L' + i, x, y: 6 }));

ok('a street side is a group on its pole line; the feed at its start feeds one string', () => {
  const r = SL.plan({ poles: polesL, streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }] });
  assert.strictEqual(r.groups.length, 1); assert.strictEqual(r.unassigned.length, 0);
  const g = r.groups[0]; assert.strictEqual(g.side, 1); near(g.off, 6); assert.strictEqual(g.crosses, false);
  assert.strictEqual(g.strings.length, 1);
  const st = g.strings[0];
  assert.deepStrictEqual(st.poles.map(p => p.id), ['L0', 'L1', 'L2', 'L3', 'L4']);
  near(st.feederToM[0], 4 + 20); near(st.feederToM[4], 4 + 180);          // 4 m to the corridor, then along it
  assert.deepStrictEqual(st.spanM, [0, 40, 40, 40, 40]);
  near(SL.len(g.trench), 180);                                            // from the feed's foot (x 0) to the last pole
});

ok('the section\'s LV line: the corridor at that offset, each pole a tail off it', () => {
  const r = SL.plan({ poles: polesL, streets: [Object.assign({}, street, { corr: 8 })], feeds: [{ id: 'K', x: 0, y: 10 }] });
  const g = r.groups[0]; near(g.off, 8); assert.ok(g.fromSection);
  near(g.strings[0].spanM[1], 2 + 40 + 2);                                // tail down, along, tail up
});

ok('a feed beside the middle feeds two strings, one each way', () => {
  const r = SL.plan({ poles: polesL, streets: [street], feeds: [{ id: 'K', x: 110, y: 12 }] });
  const ss = r.groups[0].strings;
  assert.deepStrictEqual(ss.map(s => s.poles.map(p => p.id)), [['L3', 'L4'], ['L2', 'L1', 'L0']]);
  near(ss[1].feederToM[0], 6 + 10);
});

ok('each side its own group; a feed across the road costs a crossing, a nearer one on the side wins', () => {
  const polesR = [30, 90].map((x, i) => ({ id: 'R' + i, x, y: -6 }));
  let r = SL.plan({ poles: polesL.concat(polesR), streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }] });
  const gr = r.groups.find(g => g.side === -1); assert.strictEqual(gr.crosses, true); assert.strictEqual(gr.feed.id, 'K');
  r = SL.plan({ poles: polesL.concat(polesR), streets: [street], feeds: [{ id: 'K', x: 0, y: 10 }, { id: 'K2', x: 100, y: -12 }] });
  assert.strictEqual(r.groups.find(g => g.side === -1).feed.id, 'K2');
  assert.strictEqual(r.groups.find(g => g.side === 1).feed.id, 'K');
});

ok('poles far from a road or a feed are reported', () => {
  const r = SL.plan({ poles: polesL.concat([{ id: 'X', x: 100, y: 90 }]), streets: [street], feeds: [{ id: 'K', x: -200, y: 10 }], o: { maxFeedM: 100 } });
  assert.strictEqual(r.unassigned.find(u => u.id === 'X').reason, 'no road within 40 m');
  assert.strictEqual(r.groups.length, 0);                                    // 4 + 220 m to the nearest pole > 100 → not reached
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
