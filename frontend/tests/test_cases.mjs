/* ProtectionPro — the one Cases list (cases.js): old Scenarios and Load Flow
 * cases join into one list, ids stay unique, defaults are filled in.
 * Run:  node frontend/tests/test_cases.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = vm.runInContext(readFileSync(join(root, 'js', 'cases.js'), 'utf8') + '\nCases', vm.createContext({}));
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('an old scenario keeps its ticks; one saved before ticks existed applies all of it', () => {
  const a = C.normalize({ id: 'scenario_1', name: 'Winter', components: [], wires: [], applies: { switching: true, settings: false, layout: false } }, 'scenario');
  assert.strictEqual(JSON.stringify(plain(a.applies)), JSON.stringify({ switching: true, settings: false, layout: false }));
  const b = C.normalize({ id: 'scenario_2', name: 'Old', components: [], wires: [] }, 'scenario');
  assert.strictEqual(b.applies.layout, true);
});
test('a load flow case applies switching and settings, never layout', () => {
  const c = C.normalize({ id: 'lfc_1', name: 'Case 1', baseMVA: 100, components: [{}], wires: [] }, 'lf');
  assert.strictEqual(JSON.stringify(plain(c.applies)), JSON.stringify({ switching: true, settings: true, layout: false }));
  assert.strictEqual(c.baseMVA, 100);
  assert.strictEqual(c.timestamp, '');
});
test('an older file: both lists join into one, scenarios first', () => {
  const list = C.fromProject({
    scenarios: [{ id: 'scenario_1', name: 'A', components: [], wires: [] }],
    loadFlowCases: [{ id: 'lfc_9', name: 'B', components: [], wires: [] }],
  });
  assert.strictEqual(JSON.stringify(list.map(c => [c.id, c.name])), JSON.stringify([['scenario_1', 'A'], ['lfc_9', 'B']]));
});
test('an id used twice keeps the first, the second gets a new one', () => {
  const list = C.fromProject({ scenarios: [{ id: 'case_1', name: 'A' }], loadFlowCases: [{ id: 'case_1', name: 'B' }] });
  assert.strictEqual(list.length, 2);
  assert.notStrictEqual(list[0].id, list[1].id);
  assert.strictEqual(list[0].id, 'case_1');
});
test('a new file: the cases field is used as it is', () => {
  const list = C.fromProject({ cases: [{ id: 'case_3', name: 'X', components: [], wires: [] }], scenarios: [{ id: 's', name: 'ignored' }] });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'case_3');
});
test('no cases at all', () => {
  assert.strictEqual(C.fromProject({}).length, 0);
  assert.strictEqual(C.fromProject({ scenarios: null, loadFlowCases: 'x' }).length, 0);
});
test('the next number follows case_ and scenario_ ids', () => {
  assert.strictEqual(C.nextNumber([]), 1);
  assert.strictEqual(C.nextNumber([{ id: 'scenario_4' }, { id: 'case_2' }, { id: 'lfc_99' }]), 5);
});
test('diff: added, removed and changed values; names and positions ignored', () => {
  const comp = (id, props) => ({ id, type: 'bus', x: 0, y: 0, props });
  const A = { components: [comp('b1', { name: 'B1', voltage_kv: 11, load_mw: 2 }), comp('b2', { name: 'B2' })] };
  const B = { components: [comp('b1', { name: 'Renamed', voltage_kv: 11, load_mw: 3 }), comp('b3', { name: 'B3' })] };
  const rows = plain(C.diff(A, B));
  const byWhat = Object.fromEntries(rows.map(r => [r.name + ':' + r.what, r]));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(byWhat['B1:load mw'].delta, '+1.0000');
  assert.ok(byWhat['B2:Removed in B'] && byWhat['B3:Added in B']);
});
test('diff: equal cases give nothing; a non-numeric change reads A → B', () => {
  const comp = (p) => ({ id: 'c', type: 'cb', props: p });
  assert.strictEqual(C.diff({ components: [comp({ state: 'closed' })] }, { components: [comp({ state: 'closed' })] }).length, 0);
  assert.strictEqual(plain(C.diff({ components: [comp({ state: 'closed' })] }, { components: [comp({ state: 'open' })] }))[0].delta, 'closed \u2192 open');
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
