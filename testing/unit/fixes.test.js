// Fixes (frontend/js/fixes.js): the pure parts — which issues go to the server, how a checked fix is written
// back, and that a hand-typed cable stays hand-typed until its fix is applied.
//   node testing/unit/fixes.test.js
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/fixes.js'), 'utf8').replace(/^const Fixes = /m, 'var Fixes = ').replace(/if \(typeof module[^\n]*\n/, '');
const ctx = { escHtml: s => String(s), AppState: { components: new Map() }, console };
vm.createContext(ctx); vm.runInContext(src, ctx);
const F = ctx.Fixes;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const board = () => ({ id: 'db-1', props: { name: 'DB-1', circuits: [
  { id: 'w1', cable_mm2: 2.5, cable_by: 'min' }, { id: 'w2', cable_mm2: 2.5, cable_locked: true }] } });
const fix = (way, to, extra = {}) => ({ issue_key: 'way:db-1/' + way, kind: 'db_way', board_id: 'db-1', way_id: way, governed_by: 'iz',
  changes: [{ target: { kind: 'db_way', board_id: 'db-1', way_id: way }, field: 'cable_mm2', from: 2.5, to }], ...extra });

ok('only failing ways with a fix go to the server', () => {
  const list = [
    { key: 'way:db-1/w1', sev: 'fail', fix: { kind: 'db_way', board_id: 'db-1', way_id: 'w1' } },
    { key: 'way:db-1/w2', sev: 'warn', fix: { kind: 'db_way', board_id: 'db-1', way_id: 'w2' } },
    { key: 'sl:1', sev: 'fail' }];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.payload(list))), [{ key: 'way:db-1/w1', kind: 'db_way', board_id: 'db-1', way_id: 'w1' }]);
});

ok('apply writes the cable and what set it', () => {
  const comps = new Map([['db-1', board()]]);
  assert.strictEqual(F.apply([fix('w1', 10)], comps), 1);
  const w = comps.get('db-1').props.circuits[0];
  assert.strictEqual(w.cable_mm2, 10); assert.strictEqual(w.cable_by, 'iz');
});

ok('an approved hand-typed cable loses its lock only when applied', () => {
  const comps = new Map([['db-1', board()]]);
  const w2 = comps.get('db-1').props.circuits[1];
  assert.strictEqual(w2.cable_locked, true);
  F.apply([fix('w1', 10)], comps);
  assert.strictEqual(w2.cable_locked, true, 'untouched way stays locked');
  F.apply([fix('w2', 10)], comps);
  assert.strictEqual(w2.cable_mm2, 10); assert.strictEqual(w2.cable_locked, undefined);
});

ok('an unknown board or way changes nothing', () => {
  const comps = new Map([['db-1', board()]]);
  assert.strictEqual(F.apply([fix('nope', 10), { ...fix('w1', 10), changes: [{ target: { kind: 'db_way', board_id: 'x', way_id: 'w1' }, field: 'cable_mm2', to: 10 }] }], comps), 0);
});

ok('fixes are grouped by board', () => {
  const g = F.groupByBoard([fix('w1', 4), fix('w2', 4), { ...fix('w1', 4), board_id: 'db-2' }], id => id.toUpperCase());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.map(x => [x.name, x.fixes.length]))), [['DB-1', 2], ['DB-2', 1]]);
});

console.log(`${n} passed`);
