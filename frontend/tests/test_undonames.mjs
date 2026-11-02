/* ProtectionPro — undo names for the plan, Demand and the road plan.
 * Run:  node frontend/tests/test_undonames.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = vm.runInContext(readFileSync(join(root, 'js', 'undonames.js'), 'utf8') + '\nUndoNames', vm.createContext({ JSON, Set, Map }));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const J = JSON.stringify;

test('plan: add, delete, move, edit a prop', () => {
  const el = (id, x, props = {}) => ({ id, type: 'db', name: id.toUpperCase(), x, y: 0, props });
  const a = J({ elements: [el('a', 0)], routes: [] });
  assert.strictEqual(N.plan(a, J({ elements: [el('a', 0), el('b', 5)], routes: [] })), 'Add B');
  assert.strictEqual(N.plan(J({ elements: [el('a', 0), el('b', 5), el('c', 9)], routes: [] }), a), 'Delete 2 items');
  assert.strictEqual(N.plan(a, J({ elements: [el('a', 30)], routes: [] })), 'Move A');
  assert.strictEqual(N.plan(a, J({ elements: [el('a', 0, { rating: 63 })], routes: [] })), 'Edit A: rating');
  assert.strictEqual(N.plan(a, J({ elements: [el('a', 0)], routes: [{ id: 'r1', name: 'Feeder 1' }] })), 'Add Feeder 1');
});
test('demand: minisub, kiosk, erven', () => {
  const k = (id, erfs = [], extra = {}) => ({ id, name: id.toUpperCase(), erfs, ...extra });
  const e = (id, n, extra = {}) => ({ id, erfNumber: n, ...extra });
  const a = J({ minisubs: [{ id: 'm1', name: 'MS1' }], kiosks: [k('k1', [e('e1', '10')])] });
  assert.strictEqual(N.demand(a, J({ minisubs: [{ id: 'm1', name: 'MS1' }], kiosks: [k('k1', [e('e1', '10'), e('e2', '11')])] })), 'Add Erf 11');
  assert.strictEqual(N.demand(a, J({ minisubs: [{ id: 'm1', name: 'MS1' }], kiosks: [k('k1', [e('e1', '10'), e('e2', '11'), e('e3', '12')]), k('k2')] })), 'Add K2');
  assert.strictEqual(N.demand(a, J({ minisubs: [{ id: 'm1', name: 'MS1' }], kiosks: [k('k1', [e('e1', '10', { admd: 2 })])] })), 'Edit Erf 10: admd');
  assert.strictEqual(N.demand(a, J({ minisubs: [{ id: 'm1', name: 'MS1' }], kiosks: [k('k1', [e('e1', '10')], { cable: 'x' })] })), 'Edit K1: cable');
  assert.strictEqual(N.demand(a, J({ minisubs: [], kiosks: [k('k1', [e('e1', '10')])] })), 'Delete MS1');
});
test('road plan', () => {
  const a = J({ roads: [{ id: 'r', name: 'Main St', points: [1] }], junctionCls: {}, settings: {} });
  assert.strictEqual(N.road(a, J({ roads: [{ id: 'r', name: 'Main St', points: [2] }], junctionCls: {}, settings: {} })), 'Move Main St');
  assert.strictEqual(N.road(a, J({ roads: [{ id: 'r', name: 'Main St', points: [1] }], junctionCls: { j: 'C1' }, settings: {} })), 'Junction class');
});
test('no change names nothing; bad input is safe', () => {
  const a = J({ minisubs: [], kiosks: [] });
  assert.strictEqual(N.demand(a, a), 'Edit Demand');
  assert.strictEqual(N.plan('not json', a), '');
});
test('titles', () => {
  assert.strictEqual(N.title('Undo', 'Move K1', 'Ctrl+Z'), 'Undo: Move K1 (Ctrl+Z)');
  assert.strictEqual(N.title('Redo', '', 'Ctrl+Y'), 'Redo (Ctrl+Y)');
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
