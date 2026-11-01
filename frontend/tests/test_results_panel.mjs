/* ProtectionPro — results panel on the single line (UX plan PR 12).
 *
 * Runs the real constants / state / annotations / stale-results / cablefocus /
 * resultview / resultspanel (vm sandbox, no browser) and checks the tables the
 * panel shows (ResultsPanel.model — no DOM):
 *  · a tab per study with results, in a fixed order;
 *  · each row's status and its reasons (load flow buses and branches, short
 *    circuit with the minimum study, arc flash, cable sizing, duty check);
 *  · sorting (numbers, names, blanks last), Needs attention and the filter;
 *  · the dock follows the diagram's shape until one is picked;
 *  · the tab follows the results view switch.
 *
 * Run:  node frontend/tests/test_results_panel.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const store = {};
const ctx = {
  console, Math, JSON, window: {},
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  navigator: { userAgent: '' },
  queueMicrotask, setTimeout, clearTimeout, performance, structuredClone,
  Canvas: { render() {} },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'state.js', 'annotations.js', 'stale-results.js', 'cablefocus.js', 'resultview.js', 'resultspanel.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
const A = vm.runInContext('AppState', ctx);
const RP = vm.runInContext('ResultsPanel', ctx);
const RV = vm.runInContext('ResultView', ctx);
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const row = (m, sec, id) => m.sections.find(s => s.id === sec).rows.find(r => r.id === id);

function fresh() {
  for (const s of vm.runInContext('RESULT_SLOTS', ctx)) A._results[s] = undefined, delete A._results[s];
  A.components.clear();
  RP.attention = false; RP.filter = ''; RP.sort = {}; RP.tab = null; RP.prefs = null;
  for (const k of Object.keys(store)) delete store[k];
}
const LF = {
  converged: true, iterations: 4, method: 'newton_raphson', solution_quality: 'ok', warnings: [{ message: 'Bus B4 rated 0.4 kV but sits at 0.42 kV' }],
  buses: {
    b1: { bus_id: 'b1', bus_name: 'MV', voltage_kv: 11, voltage_pu: 1.0, angle_deg: 0, p_through_mw: 1.2, q_through_mvar: 0.4 },
    b2: { bus_id: 'b2', bus_name: 'LV1', voltage_kv: 0.372, voltage_pu: 0.93, angle_deg: -2, p_through_mw: 0.5, q_through_mvar: 0.2 },
    b3: { bus_id: 'b3', bus_name: 'LV2', voltage_kv: 0.352, voltage_pu: 0.88, angle_deg: -4, p_through_mw: 0.2, q_through_mvar: 0.1 },
    b4: { bus_id: 'b4', bus_name: 'Spare', voltage_kv: 0, voltage_pu: 0, angle_deg: 0, energized: false },
  },
  branches: [
    { elementId: 'c1', element_name: 'Cable 1', from_bus: 'b1', to_bus: 'b2', p_mw: 0.5, q_mvar: 0.2, i_amps: 800, loading_pct: 104, losses_mw: 0.01 },
    { elementId: 'c2', element_name: 'Cable 2', from_bus: 'b1', to_bus: 'b3', p_mw: 0.2, q_mvar: 0.1, i_amps: 300, loading_pct: 60, losses_mw: 0.002 },
  ],
};

await ok('a tab per study that has results, in a fixed order', async () => {
  fresh();
  deq(RP.available(), []);
  A._results.cableSizingResults = { cables: [] };
  A._results.loadFlowResults = LF;
  A._results.faultResults = { buses: {} };
  deq(RP.available(), ['loadflow', 'fault', 'cable']);
});

await ok('load flow: buses and branches with their status and reasons', async () => {
  fresh();
  A._results.loadFlowResults = LF;
  const m = RP.model('loadflow');
  assert.match(m.summary, /Newton-raphson · converged in 4 iterations/);
  deq(m.notes.map(x => x.level), ['warn']);
  assert.strictEqual(row(m, 'buses', 'b1').status, 'ok');
  assert.strictEqual(row(m, 'buses', 'b2').status, 'warn');
  assert.match(row(m, 'buses', 'b2').reasons[0], /93\.0 % is outside ±5 %/);
  assert.strictEqual(row(m, 'buses', 'b3').status, 'fail');
  assert.strictEqual(row(m, 'buses', 'b4').status, 'warn');
  assert.strictEqual(row(m, 'branches', 'c1').status, 'fail');
  assert.strictEqual(row(m, 'branches', 'c1').cells.ends.t, 'MV → LV1');
  assert.strictEqual(row(m, 'branches', 'c2').status, 'ok');
  deq(RP.counts(m), { fail: 2, warn: 2, rows: 6 });
  A._results.loadFlowResults = Object.assign({}, LF, { converged: false });
  assert.strictEqual(RP.model('loadflow').notes[0].level, 'fail');
});

await ok('sorting: numbers, names, blanks last; Needs attention and the filter', async () => {
  fresh();
  A._results.loadFlowResults = LF;
  const m = RP.model('loadflow');
  const buses = m.sections[0];
  RP.sortBy('loadflow', 'buses', 'pu');                       // first click: largest first
  deq(RP.view('loadflow', buses).map(r => r.id), ['b1', 'b2', 'b3', 'b4']);
  RP.sortBy('loadflow', 'buses', 'pu');
  deq(RP.view('loadflow', buses).map(r => r.id), ['b4', 'b3', 'b2', 'b1']);
  RP.sortBy('loadflow', 'buses', 'name');
  deq(RP.view('loadflow', buses).map(r => r.name), ['LV1', 'LV2', 'MV', 'Spare']);
  RP.sortBy('loadflow', 'buses', 'status');                   // first click: worst first
  assert.strictEqual(RP.view('loadflow', buses)[0].status, 'fail');
  RP.sortBy('loadflow', 'buses', 'status');
  assert.strictEqual(RP.view('loadflow', buses)[0].id, 'b1');
  RP.attention = true;
  deq(RP.view('loadflow', buses).map(r => r.id).sort(), ['b2', 'b3', 'b4']);
  RP.filter = 'lv';
  deq(RP.view('loadflow', buses).map(r => r.id).sort(), ['b2', 'b3']);
});

await ok('short circuit: information only, with the minimum study\'s smallest current', async () => {
  fresh();
  A._results.faultResults = { method: 'IEC 60909', buses: { b1: { bus_id: 'b1', bus_name: 'MV', voltage_kv: 11, ik3: 12.5, ip: 30, ib: 12, ik1: 10, ikLL: 10.8, motor_count: 2, ik3_motor: 0.4 } } };
  A._results.faultResultsMin = { buses: { b1: { ik3: 9.1, ik1: 7.2 } } };
  const m = RP.model('fault');
  const r = row(m, 'buses', 'b1');
  assert.strictEqual(r.status, 'info');
  assert.strictEqual(r.cells.kmin.v, 7.2);
  assert.match(r.reasons[0], /2 motors add 0\.40 kA/);
  assert.match(m.summary, /every bus · maximum and minimum/);
});

await ok('arc flash: above 40 cal/cm² fails, category 3–4 warns; recommendations become reasons; energy first', async () => {
  fresh();
  A._results.arcFlashResults = { method: 'IEEE 1584-2018', buses: {
    a: { bus_id: 'a', bus_name: 'MCC', voltage_kv: 0.4, bolted_fault_ka: 38, arcing_current_ka: 17, incident_energy_cal: 132, arc_flash_boundary_mm: 8000, clearing_time_s: 2, ppe_category: -1, recommendations: ['Fit <b>maintenance</b> switch'] },
    b: { bus_id: 'b', bus_name: 'DB1', voltage_kv: 0.4, bolted_fault_ka: 10, arcing_current_ka: 6, incident_energy_cal: 9, arc_flash_boundary_mm: 1500, clearing_time_s: 0.1, ppe_category: 3 },
    c: { bus_id: 'c', bus_name: 'DB2', voltage_kv: 0.4, bolted_fault_ka: 5, arcing_current_ka: 3, incident_energy_cal: 1.2, arc_flash_boundary_mm: 400, clearing_time_s: 0.02, ppe_category: 1 },
  } };
  const m = RP.model('arcflash');
  assert.strictEqual(row(m, 'ac', 'a').status, 'fail');
  deq(row(m, 'ac', 'a').reasons, ['Above 40 cal/cm²: no PPE category applies — work only de-energised.', 'Fit maintenance switch']);
  assert.strictEqual(row(m, 'ac', 'b').status, 'warn');
  assert.strictEqual(row(m, 'ac', 'c').status, 'ok');
  deq(RP.view('arcflash', m.sections[0]).map(r => r.id), ['a', 'b', 'c']);
});

await ok('cable sizing and duty check: statuses, reasons and the cascading note', async () => {
  fresh();
  A._results.cableSizingResults = { cables: [
    { cable_id: 'k1', cable_name: 'K1', from_bus: 'MV', to_bus: 'LV', load_current_a: 380, thermal_loading_pct: 107, thermal_ok: false, voltage_drop_pct: 1.2, voltage_drop_ok: true, fault_withstand_ok: true, status: 'fail', issues: ['Thermal overload'], recommended_cable: '4c 240 mm² Cu' },
    { cable_id: 'k2', cable_name: 'K2', from_bus: 'LV', to_bus: 'M', load_current_a: 50, thermal_loading_pct: 92, thermal_ok: true, voltage_drop_pct: 4.1, voltage_drop_ok: true, fault_withstand_ok: true, status: 'warning', issues: [], warning_reasons: ['Near the volt-drop limit'] },
  ] };
  const c = RP.model('cable');
  deq(row(c, 'cables', 'k1').reasons, ['Thermal overload', 'Recommended: 4c 240 mm² Cu.']);
  assert.strictEqual(row(c, 'cables', 'k2').status, 'warn');
  deq(row(c, 'cables', 'k2').reasons, ['Near the volt-drop limit']);
  A._results.dutyCheckResults = { devices: [
    { device_id: 'cb1', device_name: 'CB1', device_type: 'cb', location_bus: 'LV', prospective_fault_ka: 38, breaking_capacity_ka: 25, utilisation_pct: 95, continuous_ok: true, status: 'warning', issues: [],
      cascade: { upstream_name: 'ACB', reinforced_ka: 40 } },
  ], transformers: [{ device_id: 't1', device_name: 'TX1', location_bus: 'MV', rated_mva: 1, load_mva: 1.2, loading_pct: 120, status: 'fail', issues: ['Overloaded'] }] };
  const d = RP.model('duty');
  deq(d.sections.map(s => s.id), ['tx', 'devices']);
  assert.match(row(d, 'devices', 'cb1').reasons[0], /Cascading with ACB upstream: reinforced to 40\.00 kA/);
  assert.strictEqual(row(d, 'devices', 'cb1').cells.rating.v, 40);
  assert.strictEqual(row(d, 'tx', 't1').status, 'fail');
});

await ok('the dock follows the diagram\'s shape until one is picked, and is remembered', async () => {
  fresh();
  assert.strictEqual(RP.autoDock([{ x: 0, y: 0 }, { x: 200, y: 900 }]), 'right');
  assert.strictEqual(RP.autoDock([{ x: 0, y: 0 }, { x: 1600, y: 500 }]), 'bottom');
  A.components.set('a', { id: 'a', x: 0, y: 0, props: {} });
  A.components.set('b', { id: 'b', x: 1600, y: 500, props: {} });
  assert.strictEqual(RP.dock(), 'bottom');
  RP.setDock('right');
  RP.prefs = null;                                           // a new session reads it back
  assert.strictEqual(RP.dock(), 'right');
});

await ok('the tab follows the results view switch', async () => {
  fresh();
  A._results.loadFlowResults = LF; A._results.faultResults = { buses: {} };
  RV.show('fault');
  assert.strictEqual(RP.tab, 'fault');
  RV.show('loadflow');
  assert.strictEqual(RP.tab, 'loadflow');
  RV.show('off');
  assert.strictEqual(RP.tab, 'loadflow');                    // Off keeps the tab
});

console.log(`\n${n} passed`);
process.exit(0);
