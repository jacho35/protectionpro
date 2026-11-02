/* ProtectionPro — Project settings page (UX plan PR 17).
 * Runs the real projectsettings.js in a vm sandbox: the value rules each field applies,
 * which sections there are, and when the electrical values apply to a project.
 * Run:  node frontend/tests/test_projectsettings.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {
  console, window: {}, document: {},
  DEFAULT_BASE_MVA: 100, DEFAULT_VOLTAGE_FACTOR: 1.1,
  AppState: { components: new Map() },
  Workspaces: { type: () => ctx._type },
};
ctx._type = 'building';
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'js', 'projectsettings.js'), 'utf8') + '\n;globalThis.__P = ProjectSettings;', ctx, { filename: 'projectsettings.js' });
const P = ctx.__P;
let failed = 0;
const test = (n, fn) => { try { fn(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); } };

test('four sections, info first', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(P.SECTIONS.map(s => s.id))), ['info', 'type', 'electrical', 'display']);
});
test('base MVA: a positive number, else the default', () => {
  assert.strictEqual(P.parse('baseMVA', '250'), 250);
  assert.strictEqual(P.parse('baseMVA', '-5'), 100);
  assert.strictEqual(P.parse('baseMVA', ''), 100);
});
test('frequency: 60 or 50', () => {
  assert.strictEqual(P.parse('frequency', '60'), 60);
  assert.strictEqual(P.parse('frequency', '55'), 50);
});
test('voltage factor: 0.9–1.2, else the default', () => {
  assert.strictEqual(P.parse('voltageFactor', '1.05'), 1.05);
  assert.strictEqual(P.parse('voltageFactor', '2'), 1.1);
  assert.strictEqual(P.parse('voltageFactor', 'x'), 1.1);
});
test('length unit: km or m', () => {
  assert.strictEqual(P.parse('defaultLengthUnit', 'km'), 'km');
  assert.strictEqual(P.parse('defaultLengthUnit', 'furlong'), 'm');
});
test('electrical values apply to Network, or once the single line has components', () => {
  ctx._type = 'network'; assert.strictEqual(P.electricalApplies(), true);
  ctx._type = 'lighting'; assert.strictEqual(P.electricalApplies(), false);
  ctx.AppState.components.set('bus_1', {}); assert.strictEqual(P.electricalApplies(), true);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
