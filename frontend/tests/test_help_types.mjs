/* ProtectionPro — Help per project type (UX plan PR 16).
 * Every guide listed for a project type exists, each type has a list that starts with
 * the "start a project" guide, and no list repeats a guide.
 * Run:  node frontend/tests/test_help_types.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, window: {}, document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] } };
vm.createContext(ctx);
const src = readFileSync(join(root, 'js', 'help-guides.js'), 'utf8') + '\n;globalThis.__t = { HELP_GUIDES, HELP_GUIDES_FOR_TYPE };';
vm.runInContext(src, ctx, { filename: 'help-guides.js' });
const { HELP_GUIDES, HELP_GUIDES_FOR_TYPE } = ctx.__t;
const ids = new Set(HELP_GUIDES.map(g => g.id));
let failed = 0;
const test = (n, fn) => { try { fn(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('one guide list per project type', () => {
  assert.deepStrictEqual(Object.keys(HELP_GUIDES_FOR_TYPE).sort(), ['building', 'lighting', 'network', 'retic']);
});
for (const [type, list] of Object.entries(HELP_GUIDES_FOR_TYPE)) {
  test(`${type}: every guide exists, none twice, starts with project-types`, () => {
    for (const id of list) assert.ok(ids.has(id), `unknown guide ${id}`);
    assert.strictEqual(new Set(list).size, list.length);
    assert.strictEqual(list[0], 'project-types');
  });
}
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
