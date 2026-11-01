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
 *  · the tab follows the results view switch;
 *  · the remaining studies (UX plan PR 13): unbalanced load flow, motor
 *    starting, DC load flow / short circuit, ANSI duty, load diversity,
 *    grounding and harmonics as tables; studies kept for the session go out
 *    of date after an edit and are cleared with the project; their dot comes
 *    from their result.
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
  RP.attention = false; RP.filter = ''; RP.sort = {}; RP.tab = null; RP.prefs = null; RP._session = {};
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

await ok('unbalanced load flow: VUF against the limit for the voltage, phase voltages, branch loading', async () => {
  fresh();
  const bus = (id, kv, vuf, va = 1, vb = 1, vc = 1) => ({ bus_id: id, bus_name: id.toUpperCase(), voltage_kv: kv, va_pu: va, vb_pu: vb, vc_pu: vc, v1_pu: 1, v2_pu: vuf / 100, v0_pu: 0, vuf_pct: vuf });
  A._results.unbalancedLoadFlowResults = { converged: true, iterations: 5, method: 'Sequence Component (Unbalanced)', warnings: [{ message: 'PV bus Q not split by phase' }],
    buses: { a: bus('a', 0.4, 0.5), b: bus('b', 0.4, 1.5), c: bus('c', 11, 1.9), d: bus('d', 0.4, 0.2, 0.93, 1, 1) },
    branches: [{ elementId: 'l1', element_name: 'L1', from_bus: 'a', to_bus: 'b', ia_amps: 100, ib_amps: 80, ic_amps: 60, in_amps: 35, loading_pct: 95 }] };
  const m = RP.model('unbalancedLF');
  assert.strictEqual(row(m, 'buses', 'a').status, 'ok');
  assert.strictEqual(row(m, 'buses', 'b').status, 'warn');            // above 1 %, below the 2 % LV limit
  assert.strictEqual(row(m, 'buses', 'c').status, 'fail');            // 11 kV: limit 1.8 %
  assert.match(row(m, 'buses', 'c').reasons[0], /1\.8 % limit/);
  assert.strictEqual(row(m, 'buses', 'd').status, 'warn');            // a phase 7 % low
  assert.strictEqual(row(m, 'branches', 'l1').status, 'warn');
  assert.strictEqual(m.notes[0].text, 'PV bus Q not split by phase');
  assert.ok(RP.available().includes('unbalancedLF'));
});

await ok('motor starting: a row per motor with its status, reasons and worst bus dips', async () => {
  fresh();
  A._results.motorStartingResults = { warnings: [], motors: [
    { motor_id: 'm1', motor_name: 'M1', status: 'pass', rated_kw: 90, start_current_a: 1200, motor_terminal_voltage_pu: 0.91, motor_will_start: true, max_system_dip_pct: 6, max_dip_bus: 'MCC', bus_dips: { MCC: 6, LV: 3, MV: 0.5, A: 0.1, B: 0.05, C: 0.01 }, issues: [] },
    { motor_id: 'm2', motor_name: 'M2', status: 'fail', rated_kw: 400, start_current_a: 5200, motor_terminal_voltage_pu: 0.62, motor_will_start: false, max_system_dip_pct: 31, max_dip_bus: 'MCC', bus_dips: { MCC: 31 }, issues: ['Dip above 15 %'] },
  ] };
  const m = RP.model('motor');
  assert.strictEqual(row(m, 'motors', 'm2').status, 'fail');
  assert.match(row(m, 'motors', 'm2').reasons[0], /will not start/);
  assert.strictEqual((row(m, 'motors', 'm1').detail.match(/<tr><td>/g) || []).length, 5);   // the five worst dips
  deq(RP.view('motor', m.sections[0]).map(r => r.id), ['m2', 'm1']);                // worst first
  assert.strictEqual(RP.verdict('motor'), 'fail');
});

await ok('DC load flow and DC short circuit: de-energised buses, current-limited sources, no source', async () => {
  fresh();
  A._results.dcLoadFlowResults = { converged: true, iterations: 3, method: 'DC Nodal', warnings: [],
    buses: { d1: { bus_id: 'd1', bus_name: 'DC1', voltage_v: 110, nominal_v: 110, voltage_pu: 1, drop_pct: 0, load_kw: 2 },
      d2: { bus_id: 'd2', bus_name: 'DC2', voltage_v: 0, nominal_v: 110, voltage_pu: 0, drop_pct: 100, load_kw: 0, energized: false } },
    sources: [{ source_id: 'r1', source_name: 'R1', source_type: 'rectifier', bus_id: 'd1', voltage_v: 110, current_a: 50, power_kw: 5.5, loading_pct: 100, current_limited: true }],
    branches: [{ elementId: 'c1', element_name: 'C1', from_bus: 'd1', to_bus: 'd2', current_a: 0, voltage_drop_v: 0, loss_kw: 0, resistance_ohm: 0.01, loading_pct: 0 }] };
  const m = RP.model('dcLoadflow');
  assert.strictEqual(row(m, 'buses', 'd2').status, 'warn');
  assert.strictEqual(row(m, 'sources', 'r1').status, 'warn');
  assert.strictEqual(RP.verdict('dcLoadflow'), 'warn');                // the chip agrees with the table
  A._results.dcShortCircuitResults = { standard: 'IEC 61660-1', warnings: [], buses: {
    d1: { bus_id: 'd1', bus_name: 'DC1', nominal_v: 110, ik_ka: 2, ip_ka: 2.4, tp_ms: 5, time_constant_ms: 2, contributions: [{ source_id: 'b', source_name: 'Batt', source_type: 'dc_battery', ik_ka: 2, ip_ka: 2.4, tp_ms: 5, r_mohm: 20 }] },
    d2: { bus_id: 'd2', bus_name: 'DC2', nominal_v: 110, ik_ka: 0, ip_ka: 0, tp_ms: 0, time_constant_ms: 0, contributions: [] } } };
  const s = RP.model('dcShortCircuit');
  assert.strictEqual(row(s, 'buses', 'd1').status, 'info');
  assert.match(row(s, 'buses', 'd1').detail, /Batt/);
  assert.strictEqual(row(s, 'buses', 'd2').status, 'warn');
});

await ok('ANSI duty, load diversity and grounding as tables', async () => {
  fresh();
  A._results.ansiFaultResults = { warnings: [], buses: { b: { bus_id: 'b', bus_name: 'B', voltage_kv: 13.8, i_sym_momentary_ka: 20, i_asym_momentary_ka: 32, i_sym_interrupting_ka: 18, x_r_interrupting: 15 } },
    devices: [{ device_id: 'cb1', device_name: 'CB1', bus_id: 'b', rated_interrupting_ka: 25, rated_max_kv: 15, k_factor: 1, duty_interrupting_ka: 30, capability_interrupting_ka: 25, multiplying_factor: 1.1, status_interrupting: 'FAIL', duty_closing_latching_ka: 40, capability_closing_latching_ka: 65, status_closing_latching: 'PASS' }] };
  const a = RP.model('ansi');
  assert.strictEqual(row(a, 'devices', 'cb1').status, 'fail');
  assert.match(row(a, 'devices', 'cb1').reasons[0], /above its capability/);
  A._results.loadDiversityResults = { warnings: [], summary: { overall_demand_factor: 0.7, total_installed_kva: 1000, total_demand_kva: 700 },
    transformers: [{ transformer_id: 't1', transformer_name: 'T1', rated_kva: 500, fed_buses: ['LV'], installed_kva: 1000, demand_kva: 700, installed_loading_pct: 200, demand_loading_pct: 140, status: 'fail', issues: ['Overloaded'] }],
    buses: [{ bus_id: 'lv', bus_name: 'LV', fed_from: ['T1'], num_circuits: 2, installed_kva: 1000, demand_kva: 800, diversity_factor: 0.9, diversified_demand_kva: 700, effective_demand_factor: 0.7, demand_current_a: 1010, circuits: [{ name: 'M1', kind: 'load', installed_kva: 500, demand_kva: 400, demand_kw: 360 }] }],
    ks_table: [{ circuits: '2-3', ks: 0.9 }] };
  const d = RP.model('loadDiversity');
  assert.strictEqual(row(d, 'tx', 't1').status, 'fail');
  assert.match(row(d, 'boards', 'lv').detail, /M1/);
  assert.match(d.summary, /saves 30 %/);
  assert.strictEqual(RP.verdict('loadDiversity'), 'fail');
  A._results.groundingResults = { warnings: [], summary: {}, buses: [{ bus_id: 'g', bus_name: 'G', status: 'warning', voltage_kv: 11, fault_current_ka: 2,
    grid_resistance_ohm: 0.5, gpr_v: 1000, mesh_voltage_v: 400, tolerable_touch_v: 500, touch_ok: true, step_voltage_v: 300, tolerable_step_v: 1500, step_ok: true,
    grid_length_m: 20, grid_width_m: 10, num_conductors_x: 3, num_conductors_y: 3, num_ground_rods: 4, issues: ['GPR above the touch limit'] }] };
  const g = RP.model('grounding');
  assert.strictEqual(row(g, 'buses', 'g').status, 'warn');
  assert.match(row(g, 'buses', 'g').detail, /<svg/);
});

await ok('studies kept for the session: shown, out of date after an edit, cleared with the project', async () => {
  fresh();
  RP.open = () => {};                                       // no DOM
  const r = { converged: true, n_minus_1_secure: false, mode: 'N-1', analyzed: 3, contingencies: [] };
  RP.show('contingency', r);
  assert.ok(RP.has('contingency'));
  assert.strictEqual(RP.result('contingency'), r);
  assert.strictEqual(RP.isStale('contingency'), false);
  assert.strictEqual(RP.verdict('contingency'), 'fail');
  A.components.set('x', { id: 'x', type: 'bus', props: { voltage_kv: 11 } });
  A.dirty = true;                                           // an edit
  assert.strictEqual(RP.isStale('contingency'), true);
  RP.show('harmonics', { compliant: true, limits_standard: 'ieee519', buses: [{ id: 'x', name: 'X', compliant: false, thd_v_pct: 9, thd_limit_pct: 8, ihd_limit_pct: 5 }], orders: [5] });
  const h = RP.model('harmonics');
  assert.strictEqual(row(h, 'buses', 'x').status, 'fail');
  assert.strictEqual(RP.verdict('harmonics'), 'ok');          // the study's own verdict (PCC)
  deq(RP.available().filter(k => !RP.SLOTS[k]), ['harmonics', 'contingency']);   // tab order
  A.clearResults();
  assert.ok(!RP.has('contingency') && !RP.has('harmonics'));
});

console.log(`\n${n} passed`);
process.exit(0);
