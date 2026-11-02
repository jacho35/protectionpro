/* ProtectionPro — out-of-date study results (UX plan PR 4).
 *
 * Runs the real constants.js / state.js (vm sandbox, no browser):
 *  · a stored result is stamped with the network signature; an edit makes it
 *    out of date ('edited'), undoing the edit makes it current again;
 *  · position, rotation, name and wire routes are not part of the signature;
 *    props, wires, components and the study settings are;
 *  · the live circuit check is cleared by an edit, Demand's ADMD never goes
 *    out of date from a single-line edit;
 *  · an edit that only sets AppState.dirty still invalidates the cached
 *    signature;
 *  · save → open keeps current results current (even when a load-time
 *    migration touches props before the first check) and edited ones edited;
 *  · a result from another app version is out of date ('version');
 *  · freshResult hides out-of-date results.
 *
 * Run:  node frontend/tests/test_stale_results.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const ctx = {
  console, Math, window: {},
  document: { addEventListener() {}, getElementById: () => null },
  localStorage: { getItem: () => null, setItem() {} },
  queueMicrotask, setTimeout, clearTimeout,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
};
vm.createContext(ctx);
for (const f of ['constants.js', 'cases.js', 'state.js']) vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
const A = vm.runInContext('AppState', ctx);
const tick = () => new Promise(r => setTimeout(r, 0));

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

function network() {
  A.components.clear(); A.wires.clear();
  const c = (id, type, props, x = 0) => A.components.set(id, { id, type, x, y: 0, rotation: 0, props });
  c('u', 'utility', { name: 'Grid', voltage_kv: 11, fault_mva: 250 });
  c('b1', 'bus', { name: 'MV', voltage_kv: 11 }, 100);
  c('t', 'transformer', { name: 'T1', rated_mva: 1, z_percent: 6 }, 200);
  c('b2', 'bus', { name: 'LV', voltage_kv: 0.4 }, 300);
  const w = (id, a, b) => A.wires.set(id, { id, fromComponent: a, fromPort: 'out', toComponent: b, toPort: 'in', points: [] });
  w('w1', 'u', 'b1'); w('w2', 'b1', 't'); w('w3', 't', 'b2');
  A.invalidateResults();
}
const fault = { buses: { b1: { ik3: 13 }, b2: { ik3: 24 } } };

await ok('a stored result is current; an edit makes it out of date; undoing makes it current again', () => {
  network();
  A.faultResults = fault;
  assert.strictEqual(A.staleReason('faultResults'), null);
  const t = A.components.get('t');
  t.props.z_percent = 5; A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
  assert.strictEqual(A.isResultStale('faultResults'), true);
  assert.strictEqual(A.faultResults, fault);                       // kept, not cleared
  t.props.z_percent = 6; A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), null);
});

await ok('position, rotation, name and wire route do not count', () => {
  network(); A.faultResults = fault;
  const b = A.components.get('b2');
  b.x += 40; b.rotation = 90; b.props.name = 'LV main';
  A.wires.get('w3').points = [{ x: 1, y: 2 }];
  A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), null);
});

await ok('a new wire, a removed component and a study setting do count', () => {
  network(); A.faultResults = fault;
  A.wires.set('w4', { id: 'w4', fromComponent: 'b2', fromPort: 'x', toComponent: 'b1', toPort: 'y' });
  A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
  network(); A.faultResults = fault;
  A.components.delete('b2'); A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
  network(); A.faultResults = fault;
  A.voltageFactor = 1.05; A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
  A.voltageFactor = 1.1; A.invalidateResults();
});

await ok('the circuit check is cleared by an edit; Demand ADMD is not judged by the single line', () => {
  network();
  A.dbCheckResults = { boards: {} };
  A.reticResults = { kiosks: [] };
  A.components.get('t').props.z_percent = 7; A.invalidateResults();
  assert.strictEqual(A.dbCheckResults, null);
  assert.strictEqual(A.staleReason('reticResults'), null);
  A.components.get('t').props.z_percent = 6; A.invalidateResults();
});

await ok('an edit that only sets dirty is still noticed', () => {
  network(); A.faultResults = fault;
  assert.strictEqual(A.staleReason('faultResults'), null);           // signature cached
  A.components.get('b2').props.voltage_kv = 0.42;
  A.dirty = true;
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
});

await ok('freshResult hides an out-of-date result', () => {
  network(); A.loadFlowResults = { buses: {} };
  assert.ok(A.freshResult('loadFlowResults'));
  A.components.get('b1').props.voltage_kv = 33; A.invalidateResults();
  assert.strictEqual(A.freshResult('loadFlowResults'), null);
  assert.ok(A.loadFlowResults);
});

await ok('save → open: current stays current (a load-time prop migration included), edited stays edited', async () => {
  network();
  A.faultResults = fault;                                            // current
  A.loadFlowResults = { buses: {} };
  A.components.get('b1').props.voltage_kv = 11.5;                   // the edit that makes the load flow …
  A.invalidateResults();
  A.faultResults = fault;                                            // … out of date, while the fault is re-run
  assert.strictEqual(A.staleReason('loadFlowResults'), 'edited');
  const saved = JSON.parse(JSON.stringify(A.toJSON()));
  assert.ok(!('sig' in saved.resultsMeta.faultResults), 'no signature is saved');
  assert.strictEqual(saved.resultsMeta.loadFlowResults.edited, true);
  A.fromJSON(saved);
  // a migration run by the open path straight after fromJSON
  for (const c of A.components.values()) c.props.migrated_field = 1;
  await tick();
  assert.strictEqual(A.staleReason('faultResults'), null);
  assert.strictEqual(A.staleReason('loadFlowResults'), 'edited');
  // and an edit after opening is noticed
  A.components.get('t').props.z_percent = 9; A.invalidateResults();
  assert.strictEqual(A.staleReason('faultResults'), 'edited');
});

await ok('a result from another app version is out of date for that reason', () => {
  network(); A.faultResults = fault;
  A.resultsMeta.faultResults.v = '1.0b';
  assert.strictEqual(A.staleReason('faultResults'), 'version');
  delete A.resultsMeta.faultResults;
  assert.strictEqual(A.staleReason('faultResults'), 'version');     // no provenance at all
});

await ok('the banner names the reason', () => {
  network(); A.faultResults = fault;
  assert.strictEqual(A.staleBannerHTML('faultResults'), '');
  A.components.get('t').props.z_percent = 8; A.invalidateResults();
  assert.match(A.staleBannerHTML('faultResults'), /network has changed/);
  A.resultsMeta.faultResults.v = '1.0b';
  assert.match(A.staleBannerHTML('faultResults'), /computed on 1\.0b/);
});

console.log(`\n${n} passed`);
