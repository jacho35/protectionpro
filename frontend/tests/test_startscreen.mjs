/* ProtectionPro — the start screen (UX plan PR 15).
 *
 * Runs the real workspaces.js and startscreen.js in a vm sandbox and checks:
 *  · what sign-in does: no projects → the welcome screen; otherwise the last
 *    opened project that is still on the server (else the newest), or the
 *    start screen when "open my last project" is off;
 *  · the setting reads on unless turned off, and is stored;
 *  · the recent list: last opened first, then newest saved, five at most;
 *  · saved-when text;
 *  · one sample per project type, each a file that exists, is a project of
 *    that type, opens on its Overview and carries no results.
 *
 * Run:  node frontend/tests/test_startscreen.mjs   (exit code 1 on failure)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = {};
const ctx = {
  console, Math, JSON, Date, window: {},
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
  AppState: { components: new Map() },
};
vm.createContext(ctx);
for (const f of ['workspaces.js', 'startscreen.js']) vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), ctx, { filename: f });
const S = vm.runInContext('StartScreen', ctx);
const W = vm.runInContext('Workspaces', ctx);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
};
const plain = (o) => JSON.parse(JSON.stringify(o));

const P = (id, updated, extra = {}) => ({ id, name: 'P' + id, updated_at: updated, access: 'owner', ...extra });
const server = [P(3, '2026-10-30T10:00:00'), P(1, '2026-10-20T10:00:00'), P(2, '2026-10-10T10:00:00')];

test('sign-in, no projects: the welcome screen', () => {
  assert.deepStrictEqual(plain(S.signInAction([], [], true)), { action: 'welcome' });
  assert.deepStrictEqual(plain(S.signInAction(null, [], false)), { action: 'welcome' });
});
test('sign-in: the last opened project that is still on the server', () => {
  const recent = [{ id: '9' }, { id: '2' }, { id: '1' }];   // 9 was deleted
  assert.deepStrictEqual(plain(S.signInAction(server, recent, true)), { action: 'open', id: '2' });
});
test('sign-in, nothing opened here yet: the newest saved project', () => {
  assert.deepStrictEqual(plain(S.signInAction(server, [], true)), { action: 'open', id: '3' });
});
test('sign-in, setting off: the start screen', () => {
  assert.deepStrictEqual(plain(S.signInAction(server, [{ id: '2' }], false)), { action: 'screen' });
});
test('open-last setting: on unless turned off, stored', () => {
  assert.strictEqual(S.openLastOn(), true);
  S.setOpenLast(false);
  assert.strictEqual(store['pp-open-last'], '0');
  assert.strictEqual(S.openLastOn(), false);
  S.setOpenLast(true);
  assert.strictEqual(S.openLastOn(), true);
});
test('recent list: last opened first, then newest, five at most', () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map(i => P(i, `2026-10-0${i}T10:00:00`));
  const ids = S.recentList(many, [{ id: '2' }, { id: '5' }]).map(p => p.id);
  assert.deepStrictEqual(ids, [2, 5, 7, 6, 4]);
});
test('saved-when text', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.strictEqual(S.when('2026-11-02T11:59:40', now), 'just now');
  assert.strictEqual(S.when('2026-11-02T11:15:00', now), '45 min ago');
  assert.strictEqual(S.when('2026-11-02T07:00:00Z', now), '5 h ago');
  assert.strictEqual(S.when('2026-11-01T10:00:00', now), 'yesterday');
  assert.strictEqual(S.when('2026-10-29T10:00:00', now), '4 days ago');
  assert.strictEqual(S.when('', now), '');
});
test('one sample per project type', () => {
  assert.deepStrictEqual(Object.keys(S.SAMPLES).sort(), Object.keys(W.TYPES).sort());
});
test('each sample: a project of its type, on its Overview, no results', () => {
  const slots = ['faultResults', 'loadFlowResults', 'dutyCheckResults', 'arcFlashResults', 'reticResults', 'dbCheckResults', 'resultsMeta'];
  for (const [type, s] of Object.entries(S.SAMPLES)) {
    const file = join(root, 'samples', s.file);
    assert.ok(existsSync(file), `${s.file} missing`);
    const d = JSON.parse(readFileSync(file, 'utf8'));
    assert.strictEqual(d.projectType, type, `${s.file}: type`);
    assert.strictEqual(d.projectName, s.name, `${s.file}: name`);
    assert.strictEqual(d.lastView && d.lastView.workspace, type === 'lighting' ? 'lightov' : 'overview', `${s.file}: opens on its Overview`);
    for (const k of slots) assert.ok(!d[k], `${s.file}: carries ${k}`);
    if (s.calc === 'studies') assert.ok(s.studies.length > 0);
  }
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
