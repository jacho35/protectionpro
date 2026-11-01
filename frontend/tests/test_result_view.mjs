/* ProtectionPro — results view switch on the single line (UX plan PR 11).
 *
 * Runs the real constants / state / annotations / stale-results / resultview
 * (vm sandbox, no browser):
 *  · only studies with results get a chip, in a fixed order;
 *  · a chip shows its study alone, Shift-click adds / takes away, Off hides
 *    all, H goes back to the last view;
 *  · the dot rules per study (fail / warn / ok / info);
 *  · a study that finishes running becomes the view; several in one task show
 *    the last; a re-run of out-of-date studies leaves the view alone;
 *  · a saved project opens with what it showed (all ticked → every chip on);
 *  · Values ▾ writes resultBoxFields and the flow-arrow setting.
 *
 * Run:  node frontend/tests/test_result_view.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
let renders = 0;
const ctx = {
  console, Math, JSON, window: {},
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { userAgent: '' },
  queueMicrotask, setTimeout, clearTimeout, performance, structuredClone,
  Canvas: { render() { renders++; } },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'state.js', 'annotations.js', 'stale-results.js', 'resultview.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
const A = vm.runInContext('AppState', ctx);
const RV = vm.runInContext('ResultView', ctx);
const SR = vm.runInContext('StaleResults', ctx);
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const tick = () => new Promise(r => setTimeout(r, 5));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const LF = (over = {}) => Object.assign({ converged: true, solution_quality: 'ok', warnings: [],
  buses: { b1: { voltage_pu: 1.0, energized: true }, b2: { voltage_pu: 0.98, energized: true } },
  branches: [{ loading_pct: 60 }] }, over);
const FAULT = { buses: { b1: { ik3: 10 } } };
function fresh() {
  for (const s of vm.runInContext('RESULT_SLOTS', ctx)) A[s] = null;
  A.components.clear();
  for (const k of Object.keys(A.showResultBoxes)) A.showResultBoxes[k] = true;   // a new project
  A.resultBoxFields = {};
  RV._last = null; RV._arrived = [];
}

await ok('only studies with results get a chip, in a fixed order', async () => {
  fresh();
  deq(RV.available().map(s => s.key), []);
  A._results.faultResults = FAULT;                 // as a project load writes it (no switch)
  A._results.cableSizingResults = { cables: [] };
  A._results.loadFlowResults = LF();
  deq(RV.available().map(s => s.key), ['loadflow', 'fault', 'cable']);
  deq(RV.current(), ['loadflow', 'fault', 'cable']);   // an older project: everything was ticked
});

await ok('a chip shows its study alone; Shift-click adds and takes away; Off; H brings the last view back', async () => {
  fresh();
  A._results.faultResults = FAULT; A._results.loadFlowResults = LF(); A._results.arcFlashResults = { buses: {} };
  RV.show('fault');
  deq(RV.current(), ['fault']);
  assert.strictEqual(A.showResultBoxes.loadflow, false);
  RV.show('loadflow', true);
  deq(RV.current(), ['loadflow', 'fault']);
  RV.show('fault', true);
  deq(RV.current(), ['loadflow']);
  RV.show('off');
  deq(RV.current(), []);
  assert.strictEqual(RV.toggleAll(), true);
  deq(RV.current(), ['loadflow']);
  assert.strictEqual(RV.toggleAll(), false);
  deq(RV.current(), []);
});

await ok('the dot rules', async () => {
  fresh();
  const v = (key, slot, r) => { A._results[slot] = r; RV._vcache = new WeakMap(); return RV.verdict(key); };
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF()), 'ok');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ buses: { b: { voltage_pu: 0.93 } } })), 'warn');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ buses: { b: { voltage_pu: 0.88 } } })), 'fail');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ branches: [{ loading_pct: 104 }] })), 'fail');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ branches: [{ loading_pct: 95 }] })), 'warn');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ converged: false })), 'fail');
  assert.strictEqual(v('loadflow', 'loadFlowResults', LF({ warnings: [{ message: 'x' }] })), 'warn');
  assert.strictEqual(v('fault', 'faultResults', FAULT), 'info');
  assert.strictEqual(v('arcflash', 'arcFlashResults', { buses: { a: { ppe_category: 2 } } }), 'ok');
  assert.strictEqual(v('arcflash', 'arcFlashResults', { buses: { a: { ppe_category: 3 } } }), 'warn');
  assert.strictEqual(v('arcflash', 'arcFlashResults', { buses: { a: { ppe_category: -1 } } }), 'fail');
  assert.strictEqual(v('cable', 'cableSizingResults', { cables: [{ status: 'pass' }, { status: 'warning' }] }), 'warn');
  assert.strictEqual(v('cable', 'cableSizingResults', { cables: [{ status: 'pass' }, { status: 'fail' }] }), 'fail');
  assert.strictEqual(v('duty', 'dutyCheckResults', { devices: [{ status: 'pass' }] }), 'ok');
  assert.strictEqual(v('motor', 'motorStartingResults', { motors: [{ status: 'fail' }] }), 'fail');
  assert.strictEqual(v('loadDiversity', 'loadDiversityResults', { buses: {} }), 'info');
  // DC arc flash shares the chip: the worse of the two counts
  A._results.arcFlashResults = { buses: { a: { ppe_category: 1 } } };
  A._results.dcArcFlashResults = { buses: { d: { ppe_category: -1 } } };
  RV._vcache = new WeakMap();
  assert.strictEqual(RV.verdict('arcflash'), 'fail');
});

await ok('a study that finishes running becomes the view; several at once show the last', async () => {
  fresh();
  A._results.faultResults = FAULT;
  RV.show('fault');
  A.loadFlowResults = LF();                        // a run stores its result
  await tick();
  deq(RV.current(), ['loadflow']);
  A.faultResults = FAULT; A.cableSizingResults = { cables: [] };   // Run all: one task
  await tick();
  deq(RV.current(), ['cable']);
  A.faultResultsMin = FAULT;                       // no chip of its own: no change
  await tick();
  deq(RV.current(), ['cable']);
});

await ok('a re-run of out-of-date studies leaves the view as it is', async () => {
  fresh();
  A._results.faultResults = FAULT; A._results.loadFlowResults = LF();
  RV.show('fault');
  SR._busy = true;
  A.loadFlowResults = LF();
  SR._busy = false;
  await tick();
  deq(RV.current(), ['fault']);
});

await ok('a saved project opens showing what it showed', async () => {
  fresh();
  A._results.loadFlowResults = LF(); A._results.faultResults = FAULT;
  RV.show('fault');
  const saved = JSON.parse(JSON.stringify(A.toJSON()));
  for (const k of Object.keys(A.showResultBoxes)) A.showResultBoxes[k] = true;
  A.fromJSON(saved);
  await tick();
  deq(RV.current(), ['fault']);
});

await ok('Values ▾ writes the value lines and the flow arrows', async () => {
  fresh();
  A._results.loadFlowResults = LF();
  RV.show('loadflow');
  const ev = (attrs, checked) => ({ target: { checked, dataset: attrs.dataset, matches: (sel) => sel === attrs.sel } });
  RV._onValueChange(ev({ sel: '[data-rv-field]', dataset: { rvField: 'loadflow', rvName: 'angle' } }, false));
  assert.strictEqual(vm.runInContext("Annotations.fieldVisible('loadflow', 'angle')", ctx), false);
  RV._onValueChange(ev({ sel: '[data-rv-field]', dataset: { rvField: 'loadflow', rvName: 'angle' } }, true));
  deq(A.resultBoxFields.loadflow, {});
  RV._onValueChange(ev({ sel: '[data-rv-arrows]', dataset: { rvArrows: 'loadflow' } }, true));
  assert.strictEqual(A.showFlowArrows.loadflow, true);
});

console.log(`\n${n} passed`);
process.exit(0);
