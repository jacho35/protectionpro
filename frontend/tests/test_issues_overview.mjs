/* ProtectionPro — Issues list and Overview data (UX plan PR 14).
 *
 * Runs the real constants / state / stale-results / resultview / resultspanel /
 * workspaces / issues / overview in a vm sandbox (no browser), with stand-ins
 * for Demand (Retic), Street lighting and the sync pass, and checks:
 *  · Issues collects every workspace's fails: single-line study rows (with
 *    the part to go to), out-of-date studies with Re-run, the circuit check's
 *    ways (way:<board>/<way>), Demand's transformer / feeder / earth checks,
 *    street-light circuits, the sync pass's questions (by workspace);
 *  · a source lists at most PER_SOURCE, then one "N more" entry;
 *  · the list is in the project's workspace order, worst first;
 *  · the results panel's Issues tab: first in TABS, shown only with issues,
 *    one section per workspace, a workspace filter, its verdict;
 *  · the Overview's rows: a row per board (check counts, worst volt drop) and
 *    per minisub (loading, worst feeder volt drop, earth checks, verdict);
 *  · the tabs: Overview first for Reticulation, Building and Network, not in
 *    a Lighting project.
 *
 * Run:  node frontend/tests/test_issues_overview.mjs   (exit code 1 on failure)
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
  queueMicrotask, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, performance, structuredClone,
  Canvas: { render() {} },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'state.js', 'annotations.js', 'stale-results.js', 'cablefocus.js', 'resultview.js', 'resultspanel.js', 'workspaces.js', 'issues.js', 'overview.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
const A = vm.runInContext('AppState', ctx);
const RP = vm.runInContext('ResultsPanel', ctx);
const I = vm.runInContext('Issues', ctx);
const OV = vm.runInContext('Overview', ctx);
const WS = vm.runInContext('Workspaces', ctx);
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

function fresh(type = 'network') {
  for (const s of vm.runInContext('RESULT_SLOTS', ctx)) delete A._results[s];
  A.components.clear();
  A.projectType = type;
  A.extraWorkspaces = [];
  RP._session = {}; RP.tab = null; RP.issueWs = '';
  ctx.Sync = { issues: [], kick() {} };
  delete ctx.Retic; delete ctx.StreetLight;
  A.reticulation = A.reticulation || {};
  A.reticulation.kiosks = []; A.reticulation.minisubs = [];
  I._list = null; I._sig = '';
}
const comp = (id, type, props = {}) => { A.components.set(id, { id, type, x: 0, y: 0, rotation: 0, props: { name: id, ...props } }); };

// A load flow with one overloaded cable and one low bus.
const LF = {
  converged: true, iterations: 4, method: 'newton_raphson', solution_quality: 'ok', warnings: [],
  buses: {
    b1: { bus_id: 'b1', bus_name: 'MV', voltage_kv: 11, voltage_pu: 1.0, angle_deg: 0 },
    b2: { bus_id: 'b2', bus_name: 'LV', voltage_kv: 0.35, voltage_pu: 0.88, angle_deg: -4 },
  },
  branches: [{ element_id: 'c1', element_name: 'Cable 1', from_bus: 'b1', to_bus: 'b2', p_mw: 0.5, q_mvar: 0.1, s_mva: 0.52, i_amps: 800, loading_pct: 124, losses_mw: 0.01 }],
};

await ok('single-line study fails become issues, with the part to select', () => {
  fresh('network');
  comp('b1', 'bus', { voltage_kv: 11 }); comp('b2', 'bus', { voltage_kv: 0.4 }); comp('c1', 'cable');
  A.loadFlowResults = LF;
  const list = I.collect();
  const study = list.filter(i => i.key.startsWith('study:loadflow:'));
  assert.ok(study.length >= 2, 'the cable and the low bus');
  assert.ok(study.some(i => i.sev === 'fail' && /Cable 1/.test(i.text)));
  assert.ok(study.every(i => i.ws === 'sld' && typeof i.run === 'function'));
});

await ok('an out-of-date study is one entry with Re-run, its fails are not listed', () => {
  fresh('network');
  comp('b1', 'bus', { voltage_kv: 11 }); comp('b2', 'bus', { voltage_kv: 0.4 }); comp('c1', 'cable', { length_km: 0.1 });
  A.loadFlowResults = LF;
  A.components.get('c1').props.length_km = 0.3;
  A.invalidateResults(); A.dirty = true;
  const list = I.collect();
  const st = list.filter(i => i.sev === 'stale');
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].key, 'stale:loadflow');
  assert.strictEqual(st[0].act, 'Re-run');
  assert.ok(!list.some(i => i.key.startsWith('study:loadflow:')));
});

await ok('the circuit check: a way per issue, fail first, capped with "N more"', () => {
  fresh('building');
  comp('db1', 'distribution_board', { circuits: [] });
  const ways = [];
  for (let i = 1; i <= 30; i++) ways.push({ board_id: 'db1', board_name: 'DB-1', way_id: 'w' + i, way: String(i), status: i % 3 ? 'warn' : 'fail', messages: ['Volt drop over the limit'] });
  ways.push({ board_id: 'db1', board_name: 'DB-1', way_id: 'ok', way: '99', status: 'pass', messages: [] });
  A.dbCheckResults = { ways, boards: [{ id: 'db1', worst_status: 'fail', counts: { pass: 1, warn: 20, fail: 10 } }] };
  const list = I.collect().filter(i => i.ws === 'schedules');
  assert.strictEqual(list.length, I.PER_SOURCE + 1);
  assert.strictEqual(list[0].sev, 'fail');
  assert.strictEqual(list[0].go, 'way:db1/w3');
  const more = list.find(i => i.key === 'way:more');
  assert.ok(more && /^5 more ways/.test(more.text));
});

await ok('Demand: overloaded transformer, feeder volt drop, earth fails', () => {
  fresh('retic');
  A.reticulation.kiosks = [{ id: 'k1', name: 'K1', fedFrom: 'ms1', erfs: [] }, { id: 'k2', name: 'K2', fedFrom: 'k1', erfs: [] }];
  A.reticulation.minisubs = [{ id: 'ms1', name: 'MS-1' }];
  A.reticResults = {
    minisubs: [{ minisubId: 'ms1', totalKVA: 340, numKiosks: 2 }],
    kiosks: [{ kioskId: 'k1', name: 'K1' }, { kioskId: 'k2', name: 'K2' }],
    earth: { kiosks: [{ kioskId: 'k1', name: 'K1', loop: { status: 'pass' }, erfs: [] }, { kioskId: 'k2', name: 'K2', loop: { status: 'fail' }, erfs: [] }] },
  };
  ctx.Retic = {
    get kiosks() { return A.reticulation.kiosks; }, get minisubs() { return A.reticulation.minisubs; },
    settings: { maxFeederVD: 5, maxRunVD: 5 },
    kioskById: (id) => A.reticulation.kiosks.find(k => k.id === id),
    _minisubTx: (ms, d) => ({ kva: 315, util: d ? Math.round(d / 315 * 100) : null }),
    _cumulativeFeederVD: (id) => (id === 'k2' ? 6.4 : 2.1),
    _earthStatus: (item) => (item.loop || {}).status || 'info',
    _vdCalc: () => null, _erfDesignCalc: () => ({ amps: 0 }), _erfIs3ph: () => false,
  };
  const list = I.collect();
  const tx = list.find(i => i.key === 'retic-tx:ms1');
  assert.ok(tx && tx.sev === 'fail' && /108 %/.test(tx.text) && tx.go === 'retic:ms1');
  assert.ok(list.some(i => i.key === 'retic-vd:k2' && /6\.40 %/.test(i.text)));
  assert.ok(!list.some(i => i.key === 'retic-vd:k1'));
  assert.ok(list.some(i => i.key === 'retic-earth:k2' && /earth loop too high/.test(i.text)));
  // The Overview's minisub row says the same.
  const [row] = OV.minisubRows();
  assert.strictEqual(row.status, 'fail');
  assert.strictEqual(row.util, 108);
  assert.strictEqual(row.vd, 6.4);
  assert.strictEqual(row.nEarth, 2);
  assert.strictEqual(row.earthFail, 1);
  assert.ok(/Transformer overloaded/.test(row.verdict) && /Feeder volt drop/.test(row.verdict));
});

await ok('street-light circuits and the sync pass questions, by workspace', () => {
  fresh('retic');
  A.reticulation.kiosks = [{ id: 'k1', name: 'K1', erfs: [] }];
  A.reticulation.streetLighting = { circuits: [{ id: 'sl1' }] };
  ctx.StreetLight = { circuits: [{ id: 'sl1', name: 'SL-1', poles: [{}] }, { id: 'sl2', name: 'SL-2', poles: [{}] }],
    _results: { sl1: { pass: false, fails: ['vd', 'zs'] }, sl2: { pass: true, fails: [] } },
    LIMIT_TEXT: { vd: 'volt drop from the source', zs: 'earth loop impedance (Zs)' } };
  ctx.Sync = { kick() {}, issues: [
    { routine: 'retic', key: 'plan-uncalibrated', text: 'Site plan not calibrated' },
    { routine: 'demand-sld', key: 'demand-tx-max:ms9', text: 'MS-9: the demand is more than the largest transformer' },
  ] };
  const list = I.collect();
  const sl = list.filter(i => i.ws === 'streetlight');
  assert.strictEqual(sl.length, 1);
  assert.ok(/volt drop from the source, earth loop/.test(sl[0].text) && sl[0].go === 'sl:sl1');
  const plan = list.find(i => i.key === 'sync:plan-uncalibrated');
  assert.strictEqual(plan.ws, 'plan');
  assert.strictEqual(list.find(i => i.key === 'sync:demand-tx-max:ms9').go, 'retic:ms9');
  // Workspace order: Site plan, Demand, Street lighting.
  const order = [...new Set(list.map(i => i.ws))];
  assert.ok(order.indexOf('plan') < order.indexOf('streetlight'));
});

await ok('the Issues tab: first, only with issues, a section per workspace, filter, verdict', () => {
  fresh('building');
  assert.strictEqual(RP.TABS[0], 'issues');
  I._list = [];
  assert.ok(!RP.has('issues'));
  assert.ok(!RP.available().includes('issues'));
  comp('db1', 'distribution_board', { circuits: [] });
  A.dbCheckResults = { ways: [{ board_id: 'db1', board_name: 'DB-1', way_id: 'w1', way: '1', status: 'fail', messages: ['Zs too high'] }], boards: [] };
  ctx.Sync = { kick() {}, issues: [{ routine: 'building', key: 'feeder-direction:x', text: 'Which board feeds the other?' }] };
  I._list = null;
  assert.ok(RP.has('issues'));
  assert.strictEqual(RP.available()[0], 'issues');
  const m = RP.model('issues');
  assert.deepStrictEqual([...m.sections.map(s => s.id)], ['ws-plan', 'ws-schedules']);
  assert.strictEqual(m.sections[1].rows[0].id, 'way:db1/w1');
  assert.strictEqual(RP.verdict('issues'), 'fail');
  RP.issueWs = 'plan';
  assert.deepStrictEqual([...RP.model('issues').sections.map(s => s.id)], ['ws-plan']);
  RP.issueWs = '';
});

await ok('the Overview: a row per board with its check, worst first', () => {
  fresh('building');
  comp('db1', 'distribution_board', { name: 'DB-1', circuits: [{ id: 'w1', load_va: 2000 }, { id: 'w2', load_va: 1500 }] });
  comp('db2', 'distribution_board', { name: 'DB-2', circuits: [{ id: 'w1', load_va: 800 }] });
  comp('db3', 'distribution_board', { name: 'DB-3', circuits: [] });
  A.dbCheckResults = {
    ways: [{ board_id: 'db1', way_id: 'w1', vd_total_pct: 3.2 }, { board_id: 'db1', way_id: 'w2', vd_pct: 5.6 }, { board_id: 'db2', way_id: 'w1', vd_total_pct: 1.1 }],
    boards: [{ id: 'db1', worst_status: 'pass', counts: { pass: 2 } }, { id: 'db2', worst_status: 'fail', counts: { pass: 0, fail: 1 } }],
  };
  const rows = OV.boardRows();
  assert.deepStrictEqual([...rows.map(r => r.name)], ['DB-2', 'DB-1', 'DB-3']);
  assert.strictEqual(rows[0].verdict, '1 fail');
  assert.strictEqual(rows[1].vd, 5.6);
  assert.strictEqual(rows[1].kva, 3.5);
  assert.strictEqual(rows[2].verdict, 'No ways yet');
});

await ok('Overview is the first tab of Reticulation, Building and Network, not of Lighting', () => {
  for (const t of ['retic', 'building', 'network']) { fresh(t); assert.strictEqual(WS.visible()[0], 'overview', t); }
  fresh('lighting');
  A.lightingKinds = ['rooms'];
  const v = WS.visible();
  assert.strictEqual(v[0], 'lightov');
  assert.ok(!v.includes('overview'));
});

console.log(`\n${n} passed`);
