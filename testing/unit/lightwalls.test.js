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

// Reference rows (RoomCalc.refRows / attachReference): pull the methods out of roomcalc.js
{
  const src = require("fs").readFileSync(__dirname + "/../../frontend/js/roomcalc.js", "utf8");
  const a = src.indexOf("  refRows(room, res) {"), b = src.indexOf("  importRelux() {");
  assert.ok(a > 0 && b > a, "reference methods not found");
  const c2 = { JSON };
  require("vm").createContext(c2);
  require("vm").runInContext("this.RC = {" + src.slice(a, b) + "};", c2);
  const RC = c2.RC;
  ok("refRows: percent and absolute differences, fittings flagged", () => {
    const room = { reference: { em: 1000, emin: 800, uo: 0.8, luminaires: 25, wallEm: [700, 600] } };
    const res = { workplane: { Em: 1100, Emin: 700, U0: 0.64 }, walls: { Em: 650 }, luminaires: 30 };
    const rows = RC.refRows(room, res), by = (l) => rows.find(r => r.label === l);
    assert.ok(Math.abs(by("Ēm work plane").diff - 10) < 1e-9);
    assert.ok(Math.abs(by("U₀").diff - (-0.16)) < 1e-9);
    assert.strictEqual(by("Ēm walls (mean)").ref, 650);
    assert.strictEqual(by("Fittings").diff, 5);
    assert.strictEqual(rows.length, 5);                  // rows with no reference value are left out
    assert.strictEqual(RC.refRows({}, res).length, 0);
  });
  ok("attachReference matches by name, ignoring a [note] suffix", () => {
    const rooms = [{ name: "Plant Area 2 - Left [layout differs]" }, { name: "Office" }, { name: "Nowhere" }];
    const out = RC.attachReference(rooms, { date: "d", rooms: { "Plant Area 2 - Left": { em: 990 }, Office: { em: 530 }, "MCC Room": { em: 1 } } }, "x.pdf");
    assert.strictEqual(out.hit, 2);
    assert.strictEqual(rooms[0].reference.em, 990);
    assert.strictEqual(out.missed.join(), "Nowhere");
    assert.strictEqual(out.unused.join(), "MCC Room");
  });
}
console.log("reference tests done");
