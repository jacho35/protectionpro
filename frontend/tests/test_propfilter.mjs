/* ProtectionPro — property panel label rules and section filter (UX plan PR 21).
 * Pulls splitLabelRule / the section tables out of properties.js and checks them.
 * Run:  node frontend/tests/test_propfilter.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'properties.js'), 'utf8');
const grab = (re) => { const m = re.exec(src); assert.ok(m, 'not found: ' + re); return m[0]; };
const code = [grab(/const SECTION_LABELS = \{[\s\S]*?\n\};/), grab(/const SECTION_USED_BY = \{[\s\S]*?\n\};/),
  grab(/const SECTION_FILTERS = .*;/), grab(/function splitLabelRule[\s\S]*?\n\}/)].join('\n') + '\n;({ SECTION_LABELS, SECTION_USED_BY, SECTION_FILTERS, splitLabelRule })';
const M = vm.runInContext(code, vm.createContext({}));
const plain = (o) => JSON.parse(JSON.stringify(o));
let failed = 0;
const test = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('the rule moves out of the label', () => {
  assert.deepStrictEqual(plain(M.splitLabelRule('Enclosure Width (0 = auto, 2018 only)')), { label: 'Enclosure Width', rule: '0 = auto, 2018 only' });
  assert.deepStrictEqual(plain(M.splitLabelRule('Supply Capacity (0 = unlimited)')), { label: 'Supply Capacity', rule: '0 = unlimited' });
});
test('other labels are left alone', () => {
  assert.deepStrictEqual(plain(M.splitLabelRule('Thermal Pickup (630 A)')), { label: 'Thermal Pickup (630 A)', rule: '' });
  assert.deepStrictEqual(plain(M.splitLabelRule('Name')), { label: 'Name', rule: '' });
});
test('every filter chip is a real section with a "used by" line', () => {
  for (const [k] of M.SECTION_FILTERS) { assert.ok(M.SECTION_LABELS[k], k); assert.ok(M.SECTION_USED_BY[k], k); }
});
test('every non-General section has a "used by" line', () => {
  for (const k of Object.keys(M.SECTION_LABELS)) if (k !== 'General' && !k.startsWith('co_breaker')) assert.ok(M.SECTION_USED_BY[k], k);
});
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
