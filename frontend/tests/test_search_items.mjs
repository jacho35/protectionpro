/* ProtectionPro — Ctrl K finds items inside the workspaces (UX plan PR 19).
 * Runs the real header.js in a vm sandbox with a small project and checks that
 * kiosks, erven, minisubs, street-light circuits, boards, ways and rooms are
 * found by name, only for the workspaces the project shows, only once the user
 * types, and that picking one goes to it.
 * Run:  node frontend/tests/test_search_items.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const went = [];
const hidden = new Set();
const ctx = {
  console, Math, JSON, Date, RegExp, Set, Map,
  document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
  escHtml: (s) => String(s),
  switchWorkspace: (w) => went.push('ws:' + w),
  Workspaces: { isVisible: (w) => !hidden.has(w), label: (w) => ({ retic: 'Demand', streetlight: 'Street lighting', lighting: 'Rooms' }[w] || w) },
  Links: { go: (a) => went.push('go:' + a) },
  Schedules: { selectBoard: (b) => went.push('board:' + b) },
  LightingWS: { view: '', locate: (id, fl) => went.push(`room:${fl}:${id}`) },
  Issues: { lightRows: () => [{ id: 'r1', floorId: 'f1', name: 'Boardroom', task: 'Office', floor: 'Level 1' }, { id: 'o1', floorId: 'f1', name: 'Fence', kind: 'obtrusive' }] },
  AppState: {
    reticulation: {
      minisubs: [{ id: 'ms1', name: 'Minisub North' }],
      kiosks: [{ id: 'k1', name: 'Kiosk 7', erfs: [{ id: 'e1', erfNumber: '1204' }, { id: 'e2', erfNumber: '1205' }] }],
      streetLighting: { circuits: [{ id: 'c1', name: 'Main Road lights' }] },
    },
    components: new Map([
      ['b1', { id: 'b1', type: 'distribution_board', props: { name: 'DB-Kitchen', circuits: [{ id: 'w1', way: '3', description: 'Oven' }] } }],
      ['x', { id: 'x', type: 'bus', props: {} }],
    ]),
  },
};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'header.js'), 'utf8'), ctx, { filename: 'header.js' });
const H = vm.runInContext('Header', ctx);

let failed = 0;
const test = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); } };
const plain = (o) => JSON.parse(JSON.stringify(o));
const find = (q) => plain(H._rank(H._itemIndex(), q).map(i => i.item));

test('every kind of item is indexed once', () => {
  const ids = plain(H._itemIndex().map(i => i.item)).sort();
  assert.deepStrictEqual(ids, ['board:b1', 'retic:e1', 'retic:e2', 'retic:k1', 'retic:ms1', 'room:f1:r1', 'sl:c1', 'way:b1/w1']);
});
test('found by name or number', () => {
  assert.deepStrictEqual(find('1204'), ['retic:e1']);
  assert.strictEqual(find('kiosk 7')[0], 'retic:k1');   // its erven follow
  assert.deepStrictEqual(find('main road'), ['sl:c1']);
  assert.deepStrictEqual(find('oven'), ['way:b1/w1']);
  assert.deepStrictEqual(find('boardroom'), ['room:f1:r1']);
});
test('a way is found by its board', () => {
  assert.ok(find('db-kitchen').includes('way:b1/w1') && find('db-kitchen').includes('board:b1'));
});
test('workspaces the project does not show add nothing', () => {
  hidden.add('retic'); hidden.add('lighting');
  assert.deepStrictEqual(plain(H._itemIndex().map(i => i.item)).sort(), ['board:b1', 'sl:c1', 'way:b1/w1']);
  hidden.clear();
});
test('the empty search lists no items', () => {
  assert.strictEqual(H._rank(H._itemIndex(), '').length, 0);
});
test('picking an item goes to it', () => {
  went.length = 0;
  H.goItem('retic:e1'); H.goItem('board:b1'); H.goItem('room:f1:r1');
  assert.deepStrictEqual(went, ['go:retic:e1', 'ws:schedules', 'board:b1', 'ws:lighting', 'room:f1:r1']);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
