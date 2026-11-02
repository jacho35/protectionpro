/* ProtectionPro — one project history (history.js).
 * Run:  node frontend/tests/test_history.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Four fake stacks that behave like the real ones: a position, undo / redo.
const pos = { sld: 0, plan: 0, retic: 0, road: 0 };
const ctx = { console, JSON, Date, Object, Math, escHtml: (s) => String(s), document: { getElementById: () => null } };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'history.js'), 'utf8') + '\nthis.PH = ProjectHistory;', ctx);
const H = ctx.PH;
for (const ws of Object.keys(pos)) {
  H.ADAPTERS[ws].pos = () => pos[ws];
  H.ADAPTERS[ws].undo = () => { if (H.intercept('undo', ws)) return; pos[ws]--; };
  H.ADAPTERS[ws].redo = () => { if (H.intercept('redo', ws)) return; pos[ws]++; };
}
const act = (ws, label) => { pos[ws]++; H.record(ws, pos[ws], label); };   // a workspace takes a snapshot
const reset = () => { for (const k of Object.keys(pos)) pos[k] = 0; H.log = []; H._open = null; H._seq = 0; };
let failed = 0;
const test = (n, f) => { reset(); try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('single steps are one entry each and undo as before', () => {
  act('sld', 'Move K1'); act('retic', 'Add Kiosk 2');
  assert.strictEqual(H.log.length, 2);
  H.ADAPTERS.sld.undo();
  assert.strictEqual(pos.sld, 0); assert.strictEqual(pos.retic, 1);   // only its own step
});
test('a hand-off is one entry; undo in either workspace takes it back everywhere', () => {
  act('sld', 'Move K1');
  H.group('Add to the single line', () => { act('retic', 'x'); act('sld', 'y'); });
  assert.strictEqual(H.log.length, 2);
  assert.strictEqual(H.log[1].parts.length, 2);
  H.ADAPTERS.retic.undo();
  assert.deepStrictEqual([pos.retic, pos.sld], [0, 1]);
  H.ADAPTERS.sld.redo();                                              // redo from the other side
  assert.deepStrictEqual([pos.retic, pos.sld], [1, 2]);
  H.ADAPTERS.sld.undo();
  assert.deepStrictEqual([pos.retic, pos.sld], [0, 1]);
});
test('several snapshots of one workspace in a hand-off step back together', () => {
  H.group('Push to Demand schedules', () => { act('plan', 'a'); act('plan', 'b'); act('retic', 'c'); });
  assert.strictEqual(JSON.stringify(H.log[0].parts.map(p => [p.ws, p.from, p.to])), JSON.stringify([['plan', 0, 2], ['retic', 0, 1]]));
  H.ADAPTERS.plan.undo();
  assert.deepStrictEqual([pos.plan, pos.retic], [0, 0]);
});
test('a later action in a workspace keeps the hand-off from undoing over it', () => {
  H.group('Hand-off', () => { act('retic', 'x'); act('sld', 'y'); });
  act('sld', 'Move K9');                                              // after the hand-off
  H.ADAPTERS.retic.undo();                                            // sld is no longer at the hand-off's step
  assert.deepStrictEqual([pos.retic, pos.sld], [0, 2]);
});
test('a new action drops that workspace\'s redo tail from the log', () => {
  act('sld', 'a'); act('sld', 'b');
  H.ADAPTERS.sld.undo();
  act('sld', 'c');
  assert.strictEqual(JSON.stringify(H.log.map(e => e.label)), JSON.stringify(['a', 'c']));
});
test('go back to a step, then forward again', () => {
  act('sld', 'one'); act('retic', 'two'); act('plan', 'three'); act('sld', 'four');
  const two = H.log[1].id;
  H.goTo(two);
  assert.deepStrictEqual([pos.sld, pos.retic, pos.plan], [1, 1, 0]);
  const four = H.log[3].id;
  H.goTo(four);
  assert.deepStrictEqual([pos.sld, pos.retic, pos.plan], [2, 1, 1]);
});
test('entries are marked done or undone by the stacks', () => {
  act('sld', 'one'); act('sld', 'two');
  H.ADAPTERS.sld.undo();
  const at = H._at();
  assert.strictEqual(JSON.stringify(H.log.map(e => H.done(e, at))), JSON.stringify([true, false]));
});
test('a baseline (position 0) or a cleared stack empties that workspace', () => {
  act('sld', 'one'); act('plan', 'p');
  H.record('sld', 0, '');
  assert.strictEqual(JSON.stringify(H.log.map(e => e.label)), JSON.stringify(['p']));
  H.reset('plan');
  assert.strictEqual(H.log.length, 0);
});
test('the cap shifts positions down', () => {
  act('sld', 'one'); act('sld', 'two'); act('sld', 'three');
  pos.sld = 2;                       // the real stack dropped its oldest
  H.shift('sld', 1);
  assert.strictEqual(JSON.stringify(H.log.map(e => e.parts[0].to)), JSON.stringify([1, 2]));
  assert.strictEqual(H.log.length, 2);
});
test('an async hand-off closes after it settles', async () => {
  let done;
  const p = H.group('Async', async () => { act('sld', 'a'); await null; act('retic', 'b'); });
  assert.strictEqual(H.log.length, 0);
  await p;
  assert.strictEqual(H.log.length, 1);
  assert.strictEqual(H.log[0].parts.length, 2);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
