/* ProtectionPro — the save-state chip and autosave rules (UX plan PR 18).
 * Runs the real savestate.js in a vm sandbox: what the chip says for each situation,
 * when an autosave is due, the "2 min ago" text, and the preference.
 * Run:  node frontend/tests/test_savestate.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = {};
const ctx = { console, window: {}, document: { getElementById: () => null }, setTimeout: (f, ms) => setTimeout(f, ms).unref(), clearTimeout, setInterval() {}, AppState: {},
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } } };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'savestate.js'), 'utf8') + '\n;globalThis.__S = SaveState;', ctx, { filename: 'savestate.js' });
const S = ctx.__S;
let failed = 0;
const test = (n, fn) => { try { fn(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

const now = 1_000_000_000;
const base = { projectId: 7, dirty: false, status: 'idle', offline: false, readOnly: false, savedAt: null, now, auto: true, lastAutoAt: 0 };
const d = (o) => S.describe({ ...base, ...o });

test('saved, with and without a time', () => {
  assert.strictEqual(d({}).text, 'Saved');
  assert.strictEqual(d({ savedAt: now - 5 * 60000 }).text, 'Saved · 5 min ago');
  assert.strictEqual(d({ savedAt: now - 10000 }).text, 'Saved · just now');
  assert.strictEqual(d({}).kind, 'saved');
});
test('unsaved changes on a project on the server', () => {
  assert.deepStrictEqual([d({ dirty: true }).kind, d({ dirty: true }).text], ['unsaved', 'Unsaved changes']);
});
test('a project not on the server yet', () => {
  assert.strictEqual(d({ projectId: null }).text, 'Not saved yet');
  assert.strictEqual(d({ projectId: null, dirty: true }).kind, 'new');
});
test('saving', () => { assert.strictEqual(d({ status: 'saving', dirty: true }).text, 'Saving…'); });
test('failed or offline with changes: kept on this device', () => {
  assert.strictEqual(d({ status: 'failed', dirty: true }).text, 'Offline: kept on this device');
  assert.strictEqual(d({ offline: true, dirty: true }).kind, 'failed');
  assert.strictEqual(d({ offline: true, dirty: false }).kind, 'saved');
});
test('conflict', () => { assert.strictEqual(d({ status: 'conflict', dirty: true }).kind, 'conflict'); });
test('view only wins', () => { assert.strictEqual(d({ readOnly: true, dirty: true, status: 'saving' }).text, 'View only'); });
test('time text', () => {
  assert.strictEqual(S.ago(20000), 'just now');
  assert.strictEqual(S.ago(120000), '2 min ago');
  assert.strictEqual(S.ago(3 * 3600000), '3 h ago');
  assert.strictEqual(S.ago(2 * 86400000), '2 d ago');
});
test('autosave is due: on the server, changed, on, not too soon', () => {
  const s = { ...base, dirty: true, lastAutoAt: now - 31000 };
  assert.strictEqual(S.due(s), true);
  assert.strictEqual(S.due({ ...s, lastAutoAt: now - 5000 }), false);
  assert.strictEqual(S.due({ ...s, projectId: null }), false);
  assert.strictEqual(S.due({ ...s, auto: false }), false);
  assert.strictEqual(S.due({ ...s, dirty: false }), false);
  assert.strictEqual(S.due({ ...s, readOnly: true }), false);
  assert.strictEqual(S.due({ ...s, status: 'conflict' }), false);
  assert.strictEqual(S.due({ ...s, status: 'saving' }), false);
});
test('the preference is on unless turned off', () => {
  assert.strictEqual(S.autoOn(), true);
  S.setAuto(false);
  assert.strictEqual(store['protectionpro-auto-save'], '0');
  assert.strictEqual(S.autoOn(), false);
  S.setAuto(true);
  assert.strictEqual(S.autoOn(), true);
});
test('a timeline snapshot at most every ten minutes', () => {
  assert.strictEqual(S.revisionDue(1e12), true);
  S._lastRevAt = 1e12;
  assert.strictEqual(S.revisionDue(1e12 + 5 * 60000), false);
  assert.strictEqual(S.revisionDue(1e12 + 11 * 60000), true);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
