/* ProtectionPro — study options table (studyoptions.js).
 * Run:  node frontend/tests/test_studyoptions.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = vm.runInContext(readFileSync(join(root, 'js', 'studyoptions.js'), 'utf8') + '\nStudyOptions', vm.createContext({}));
const html = readFileSync(join(root, 'index.html'), 'utf8');
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };
test('every option names a control and an Analyse item that exist', () => {
  for (const o of S.OPTIONS) {
    assert.ok(html.includes(`id="${o.id}"`), o.id);
    assert.ok(html.includes(`id="${o.for}"`), o.for);
  }
});
test('options are grouped by study, in table order', () => {
  const g = JSON.parse(JSON.stringify(S.groups()));
  assert.strictEqual(g.map(x => x.group).join('|'), 'Load flow|Short circuit|Simultaneous series + shunt fault');
  assert.strictEqual(g[0].items.length, 2);
});
test('a stored option has a field; the arrows do not (they are saved as showFlowArrows)', () => {
  for (const o of S.OPTIONS) assert.strictEqual(!!o.field, !o.id.startsWith('chk-'), o.id);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
