// Per-wall lux rows (RoomCalc.wallRows) and the true-size linear body (PlanSymbols.linearBody), no browser.
//   node testing/unit/lightwalls.test.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const lib = {};
const ctx = { console, PhotoLib: { get: (id) => lib[id] || null } };
vm.createContext(ctx);
const js = (f) => fs.readFileSync(__dirname + '/../../frontend/js/' + f, 'utf8');
// PlanSymbols alone: its object literal is a top-level const
vm.runInContext(js('plan-symbols.js') + '\nthis.PS = PlanSymbols;', ctx);
const PS = ctx.PS;
// RoomCalc.wallRows is a one-liner: pull the method text out so the whole file need not load
const m = /wallRows\(res\) \{ return [^}]*\},/.exec(js('roomcalc.js'));
assert.ok(m, 'wallRows not found');
vm.runInContext('this.RC = {' + m[0] + '};', ctx);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('wallRows returns perEdge or an empty list', () => {
  assert.strictEqual(JSON.stringify(ctx.RC.wallRows(null)), "[]");
  assert.strictEqual(JSON.stringify(ctx.RC.wallRows({ walls: { Em: 1 } })), "[]");
  const rows = [{ edge: 1, Em: 300 }];
  assert.strictEqual(ctx.RC.wallRows({ walls: { Em: 300, perEdge: rows } }), rows);
});
ok('linearBody: a 1165 x 92 mm file gives a true-size body', () => {
  lib.v = { sizeM: { length: 1.165, width: 0.092, height: 0.083 } };
  assert.strictEqual(JSON.stringify(PS.linearBody({ type: 'bd_light', props: { photoId: 'v' } })), JSON.stringify({ length: 1.165, width: 0.092 }));
});
ok('linearBody: not for a square fitting, other types, missing size, or trueSize off', () => {
  lib.sq = { sizeM: { length: 0.6, width: 0.6, height: 0.1 } };
  assert.strictEqual(PS.linearBody({ type: 'bd_light', props: { photoId: 'sq' } }), null);
  assert.strictEqual(PS.linearBody({ type: 'bd_socket', props: { photoId: 'v' } }), null);
  assert.strictEqual(PS.linearBody({ type: 'bd_light', props: { photoId: 'none' } }), null);
  assert.strictEqual(PS.linearBody({ type: 'bd_light', props: { photoId: 'v', trueSize: false } }), null);
});
console.log(n + ' passed');
