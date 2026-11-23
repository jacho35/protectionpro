// Tests for crossings already on the plan in the Auto layout (plan-blocks.js user sites, plan-layout.js `input.crossings`).
//   node testing/unit/crossings-first.test.js
const assert = require('assert');
const L = require('../../frontend/js/plan-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const F = require('./layout-fixture.js')();
const P = { route: 'blocks', kmode: 'opt', knet: true };

const r0 = L.solve(F, P);
const busy = r0.net.cross.filter(x => !x.prov && x.ends || (!x.prov && x.a && x.b)).sort((a, b) => b.n - a.n)[0];
assert(busy, 'the fixture has a crossing');
const [A, B] = busy.ends || [busy.a, busy.b];
// a crossing drawn 5 m along the street from the layout's own
const d = [B[0] - A[0], B[1] - A[1]], l = Math.hypot(d[0], d[1]), t = [-d[1] / l * 5, d[0] / l * 5];
const mine = { a: [A[0] + t[0], A[1] + t[1]], b: [B[0] + t[0], B[1] + t[1]], hand: true, n110: 1 };
const mid = x => { const [a, b] = x.ends || [x.a, x.b]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };

ok('a drawn crossing is used and the layout puts none of its own beside it', () => {
  const r = L.solve(Object.assign({}, F, { crossings: [mine] }), P);
  const u = r.net.cross.find(x => x.user === 0);
  assert(u, 'the drawn crossing was not used');
  assert(u.hand && u.n > 0);
  const m = mid({ ends: [mine.a, mine.b] });
  r.net.cross.filter(x => x.user == null && !x.prov).forEach(x => assert(Math.hypot(mid(x)[0] - m[0], mid(x)[1] - m[1]) >= 8, 'an own crossing beside the drawn one'));
  assert.deepStrictEqual(u.a, mine.a);
  assert.strictEqual(r.stats.existing, 1);
});

ok('a drawn crossing short of ducts says so; spare ducts are not added to it', () => {
  const r = L.solve(Object.assign({}, F, { crossings: [Object.assign({}, mine, { n110: 0 })] }), P);
  const u = r.net.cross.find(x => x.user === 0);
  assert.strictEqual(u.spare, 0); assert.strictEqual(u.have, 0); assert.strictEqual(u.short, u.d110); assert(u.short > 0);
  const r2 = L.solve(Object.assign({}, F, { crossings: [Object.assign({}, mine, { n110: 20 })] }), P);
  assert.strictEqual(r2.net.cross.find(x => x.user === 0).short, 0);
});

ok('a crossing that is not across a road is reported and not used', () => {
  const far = { a: [-5000, -5000], b: [-4990, -5000], hand: true, n110: 2 };
  const r = L.solve(Object.assign({}, F, { crossings: [far] }), P);
  assert(!r.net.cross.some(x => x.user === 0)); assert.deepStrictEqual(r.xUnused, [0]);
});

ok('without crossings nothing changes', () => {
  const r = L.solve(Object.assign({}, F, { crossings: [] }), P);
  assert.strictEqual(r.net.cross.length, r0.net.cross.length); assert.strictEqual(r.stats.cable, r0.stats.cable);
});
console.log(n + ' passed');
