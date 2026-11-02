/* ProtectionPro — Study Manager on cases: the project a case runs on, the grid cell
 * states and what "run out-of-date" picks.
 * Run:  node frontend/tests/test_caseruns.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, JSON, Date, Object, Set, Map, escHtml: (s) => String(s), document: { getElementById: () => null },
  AppState: { cases: [], _hashText: (t) => String(t.length) + ':' + [...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7), toJSON: () => ({}) } };
vm.createContext(ctx);
for (const f of ['cases.js', 'caseruns.js']) vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), ctx);
const C = vm.runInContext('Cases', ctx), R = vm.runInContext('CaseRuns', ctx);
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('a case runs as its own network, base MVA and method; the rest is the live project', () => {
  const base = { components: [{ id: 'live' }], wires: [{ id: 'wl' }], baseMVA: 100, loadFlowMethod: 'newton_raphson', frequency: 50, earthGrids: [1] };
  const p = plain(C.project(base, { components: [{ id: 'c1' }], wires: [], baseMVA: 50, loadFlowMethod: 'gauss_seidel' }));
  assert.strictEqual(JSON.stringify(p.components), '[{"id":"c1"}]');
  assert.strictEqual(p.wires.length, 0);          // the case's (empty) wires, never mixed with the live ones
  assert.strictEqual(p.baseMVA, 50); assert.strictEqual(p.loadFlowMethod, 'gauss_seidel');
  assert.strictEqual(p.frequency, 50); assert.strictEqual(p.earthGrids.length, 1);
  const q = plain(C.project(base, { components: [], wires: [] }));
  assert.strictEqual(q.components[0].id, 'live');
});
test('cell states', () => {
  assert.strictEqual(R.cell(null).state, 'none');
  assert.strictEqual(R.cell({ status: 'pass' }).text, 'All clear');
  assert.strictEqual(R.cell({ status: 'fail', fail: 2 }).text, '2 fail');
  assert.strictEqual(R.cell({ status: 'warning', warn: 1 }).text, '1 warning');
  assert.strictEqual(R.cell({ status: 'pass', stale: true }).state, 'stale');
  assert.strictEqual(R.cell({ status: 'error' }).state, 'error');
});
test('a case result goes out of date when the case changes', () => {
  const c = { id: 'case_1', name: 'A', components: [{ id: 'x', props: { v: 1 } }], wires: [] };
  ctx.AppState.cases = [c];
  R.results.case_1 = { sig: R.sigOf(c), studies: { loadflow: { status: 'pass' } } };
  assert.strictEqual(R.state('loadflow', 'case_1').text, 'All clear');
  c.components[0].props.v = 2;
  assert.strictEqual(R.state('loadflow', 'case_1').state, 'stale');
  assert.strictEqual(R.state('fault', 'case_1').state, 'none');
});
test('run out-of-date picks studies not run or stale on any ticked case', () => {
  const c = { id: 'case_1', name: 'A', components: [{ id: 'x' }], wires: [] };
  ctx.AppState.cases = [c];
  R.selected = new Set(['case_1']);
  R.results.case_1 = { sig: R.sigOf(c), studies: { loadflow: { status: 'pass' }, fault: { status: 'fail', fail: 1 } } };
  assert.strictEqual(R.needs('loadflow'), false);
  assert.strictEqual(R.needs('fault'), false);
  assert.strictEqual(R.needs('arcflash'), true);          // never run on it
  c.components.push({ id: 'y' });
  assert.strictEqual(R.needs('loadflow'), true);          // the case changed
});
test('every study has a result slot', () => {
  for (const k of R.KEYS) assert.ok(R.SLOT[k] && R.LABEL[k], k);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
