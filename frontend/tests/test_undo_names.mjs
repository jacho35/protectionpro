/* ProtectionPro — Undo / Redo name their action (UX plan PR 22).
 * Run:  node frontend/tests/test_undo_names.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const els = {};
const mk = (id) => (els[id] = { id, disabled: false, title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
['btn-undo', 'btn-redo', 'status-info'].forEach(mk);
const AppState = {
  components: new Map(), wires: new Map(), selectedIds: new Set(), nextId: 1, pages: [{ id: 'p1' }], activePageId: 'p1',
  groups: new Map(), earthGrids: [], sldShapes: [], invalidateResults() {}, dirty: false,
};
const ctx = {
  console, JSON, Map, Set, document: { getElementById: (id) => els[id] || null },
  AppState, Canvas: { render() {} }, Properties: { clear() {} },
  COMPONENT_DEFS: { bus: { name: 'Bus', fields: [{ key: 'voltage_kv', label: 'Voltage' }, { key: 'enclosure_size_mm', label: 'Enclosure Width (0 = auto)' }] }, cable: { name: 'Cable', fields: [] } },
};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'undo.js'), 'utf8'), ctx);
const U = vm.runInContext('UndoManager', ctx);
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

const bus = (id, x, y, props = {}, rotation = 0) => ({ id, type: 'bus', x, y, rotation, props: { name: id.toUpperCase(), voltage_kv: 11, ...props } });
const st = (comps, wires = []) => ({ components: comps, wires, pages: [{ id: 'p1' }], groups: [], earthGrids: [], sldShapes: [] });

test('add, delete, move, rotate', () => {
  const a = st([bus('k1', 0, 0)]);
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0), bus('k2', 5, 5)])), 'Add K2');
  assert.strictEqual(U.describe(st([bus('k1', 0, 0), bus('k2', 5, 5), bus('k3', 9, 9)]), a), 'Delete 2 parts');
  assert.strictEqual(U.describe(a, st([bus('k1', 20, 0)])), 'Move K1');
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0, {}, 90)])), 'Rotate K1');
  assert.strictEqual(U.describe(st([bus('a', 0, 0), bus('b', 0, 0)]), st([bus('a', 1, 0), bus('b', 1, 0)])), 'Move 2 parts');
});
test('an edit names the part and the field', () => {
  const a = st([bus('k1', 0, 0)]);
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0, { voltage_kv: 33 })])), 'Edit K1: Voltage');
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0, { enclosure_size_mm: 500 })])), 'Edit K1: Enclosure Width');
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0, { voltage_kv: 33, name: 'X' })])), 'Edit X');
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0, { zz_unknown: 1 })])), 'Edit K1: zz unknown');
});
test('wires', () => {
  const a = st([bus('k1', 0, 0)]);
  const w = (id, x = 0) => ({ id, fromComponent: 'k1', toComponent: 'k1', x });
  assert.strictEqual(U.describe(a, st([bus('k1', 0, 0)], [w('w1')])), 'Add wire');
  assert.strictEqual(U.describe(st([bus('k1', 0, 0)], [w('w1')]), a), 'Delete wire');
  assert.strictEqual(U.describe(st([bus('k1', 0, 0)], [w('w1')]), st([bus('k1', 0, 0)], [w('w1', 3)])), 'Re-route wire');
});
test('no change names nothing', () => {
  const a = st([bus('k1', 0, 0)]);
  assert.strictEqual(U.describe(a, plain(a)), '');
});
test('the buttons say what they will do', () => {
  U.clear();
  AppState.components.set('k1', bus('k1', 0, 0));
  U.snapshot();                                  // Add K1
  AppState.components.get('k1').x = 40;
  U.snapshot();                                  // Move K1
  assert.strictEqual(U.undoLabel(), 'Move K1');
  assert.match(els['btn-undo'].title, /^Undo: Move K1 \(Ctrl\+Z\)$/);
  assert.strictEqual(els['btn-undo'].attrs['aria-label'], 'Undo: Move K1');
  U.undo();
  assert.strictEqual(els['status-info'].textContent, 'Undid: Move K1');
  assert.strictEqual(U.redoLabel(), 'Move K1');
  assert.match(els['btn-redo'].title, /^Redo: Move K1/);
  assert.strictEqual(U.undoLabel(), 'Add K1');
  U.redo();
  assert.strictEqual(els['status-info'].textContent, 'Redid: Move K1');
});
test('an explicit label wins; a new action drops the redo names', () => {
  U.undo();
  AppState.components.get('k1').y = 10;
  U.snapshot('Nudge up');
  assert.strictEqual(U.undoLabel(), 'Nudge up');
  assert.strictEqual(U.redoLabel(), '');
  assert.strictEqual(U._labels.length, U._stack.length);
});
test('after an undo, an in-place edit is still named', () => {
  U.clear();
  AppState.components.set('k1', bus('k1', 0, 0)); U.snapshot();
  AppState.components.get('k1').x = 40; U.snapshot();
  U.undo();
  AppState.components.get('k1').props.voltage_kv = 33;     // the panel edits the live part
  U.snapshot();
  assert.strictEqual(U.undoLabel(), 'Edit K1: Voltage');
});
test('first state: nothing to undo, no label', () => {
  U.clear();
  assert.strictEqual(U.undoLabel(), '');
  assert.strictEqual(els['btn-undo'].disabled, true);
  assert.strictEqual(els['btn-undo'].title, 'Undo (Ctrl+Z)');
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
