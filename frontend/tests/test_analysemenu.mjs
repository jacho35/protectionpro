/* ProtectionPro — Analyse menu and Study Manager rules (UX plan PR 20).
 * Run:  node frontend/tests/test_analysemenu.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Date, JSON, document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] } };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'analysemenu.js'), 'utf8'), ctx);
const A = vm.runInContext('AnalyseMenu', ctx);
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('one-cable studies: need exactly one cable', () => {
  assert.match(A.needs('cable', []), /Select one cable/);
  assert.match(A.needs('cable', ['bus']), /Select one cable/);
  assert.match(A.needs('cable', ['cable', 'cable']), /Select one cable/);
  assert.strictEqual(A.needs('cable', ['cable']), '');
});
test('simultaneous fault: one cable and one bus or board', () => {
  assert.match(A.needs('cable+bus', ['cable']), /cable and one bus/);
  assert.strictEqual(A.needs('cable+bus', ['cable', 'bus']), '');
  assert.strictEqual(A.needs('cable+bus', ['distribution_board', 'cable']), '');
  assert.match(A.needs('cable+bus', ['cable', 'cable']), /cable and one bus/);
});
test('every needs rule is one the menu knows', () => {
  for (const k of Object.values(A.NEEDS)) assert.ok(['cable', 'cable+bus'].includes(k));
});
test('status: not run, out of date, failing, warning, clear', () => {
  const f = () => '10:00';
  assert.deepStrictEqual(plain(A.status({ has: false })), { state: 'none', text: 'Not run yet' });
  assert.deepStrictEqual(plain(A.status({ has: true, stale: true, at: 1 }, f)), { state: 'stale', text: 'Out of date · ran 10:00' });
  assert.deepStrictEqual(plain(A.status({ has: true, at: 1, fail: 2, warn: 1 }, f)), { state: 'fail', text: 'Ran 10:00 · 2 fail' });
  assert.deepStrictEqual(plain(A.status({ has: true, at: 1, fail: 0, warn: 1 }, f)), { state: 'warn', text: 'Ran 10:00 · 1 warning' });
  assert.deepStrictEqual(plain(A.status({ has: true, at: 1, fail: 0, warn: 0 }, f)), { state: 'ok', text: 'Ran 10:00 · all clear' });
  assert.strictEqual(A.status({ has: true, fail: 0, warn: 0 }, f).text, 'all clear');
});
test('every Study Manager study maps to a results tab', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-study="([a-z_]+)"/g)].map(m => m[1]);
  for (const k of keys) assert.ok(A.MANAGER[k], k + ' has no tab');
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
