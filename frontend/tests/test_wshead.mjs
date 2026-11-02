/* ProtectionPro — the shared workspace header cluster (wshead.js).
 * Run:  node frontend/tests/test_wshead.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = vm.runInContext(readFileSync(join(root, 'js', 'wshead.js'), 'utf8') + '\nWsHead', vm.createContext({ document: {} }));
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };
test('the cluster reads settings, primary, guide', () => {
  assert.deepStrictEqual(plain(W.order({ guide: 1, primary: 1, settings: 1 })), ['settings', 'primary', 'guide']);
  assert.deepStrictEqual(plain(W.order({ guide: 1 })), ['guide']);
  assert.deepStrictEqual(plain(W.order({ primary: 1, guide: 1 })), ['primary', 'guide']);
});
test('every host in the table is a toolbar the app has', () => {
  const src = ['index.html', 'js/schedules.js', 'js/streetlight.js', 'js/plan.js', 'js/overview.js'].map(f => readFileSync(join(root, f), 'utf8')).join('\n');
  for (const s of W.SPECS) {
    const key = s.host.replace(/^[#.]/, '').split(/[ .#]/).pop();
    assert.ok(src.includes(key), s.host);
  }
});
test('the help links look inside the cluster for a moved guide', () => {
  assert.ok(readFileSync(join(root, 'js', 'help-guides.js'), 'utf8').includes('.ws-tail'));
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
