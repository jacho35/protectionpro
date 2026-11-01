/* ProtectionPro — the speed fixes ahead of the automatic sync (UX plan PR 3).
 *
 * Runs the real plan-circuits.js / streetlight.js (vm sandbox, no browser):
 *  · PlanCircuits.withBoardIndex: board lookups and device groups inside it
 *    are the same as the full scans outside it, nested calls share one
 *    index, and it is dropped afterwards (also after a throw);
 *  · the single line is redrawn by syncLoads only while it is on screen;
 *  · StreetLight._doCompute sends only the circuits whose request changed,
 *    keeps the others' results, drops results of removed circuits, and
 *    re-sends everything when the candidate cables change.
 * Timings are in testing/perf/sync_bench.mjs (needs the full stack).
 *
 * Run:  node frontend/tests/test_sync_speed.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// ── PlanCircuits ──────────────────────────────────────────────────────
const floors = [{ data: { elements: [] } }, { data: { elements: [] } }];
const all = () => floors.flatMap(f => f.data.elements);
const comps = new Map();
let renders = 0, scans = 0;
const pc = {
  console, Math, Map, Set, window: { activeWorkspace: 'plan' },
  AppState: {
    components: comps,
    planFloors: () => floors,
    planAllElements: () => { scans++; return all(); },
    planAllRoutes: () => [],
  },
  Canvas: { render: () => { renders++; } },
  DBSchedule: { recompute() {}, _n: 0, newWay(i, o) { return Object.assign({ id: 'w' + (++this._n), way: String(i + 1) }, o); } },
};
vm.createContext(pc);
vm.runInContext(readFileSync(join(js, 'plan-circuits.js'), 'utf8') + '\n;globalThis.PC = PlanCircuits;', pc, { filename: 'plan-circuits.js' });
const PC = pc.PC;

const el = (fl, id, type, props = {}) => { const e = { id, type, x: 0, y: 0, props }; floors[fl].data.elements.push(e); return e; };
el(0, 'db1', 'bd_db', {}).sldId = 'sld1';
el(1, 'db2', 'bd_db', {}).sldId = 'sld2';
el(0, 'l1', 'bd_light', { circuitDbId: 'db1', circuitNo: '1', load_va: 60 });
el(0, 'l2', 'bd_light', { circuitDbId: 'db1', circuitNo: '1', load_va: 60 });
el(1, 's1', 'bd_socket', { circuitDbId: 'db2', circuitNo: '2', load_va: 200 });
el(1, 's2', 'bd_socket', { circuitDbId: 'db1', circuitNo: '3', load_va: 200 });
el(0, 'x1', 'bd_light', { circuitDbId: 'gone', circuitNo: '1' });
comps.set('sld1', { id: 'sld1', type: 'distribution_board', props: { circuits: [] } });
comps.set('sld2', { id: 'sld2', type: 'distribution_board', props: { circuits: [] } });

const groups = (m) => JSON.stringify([...m].map(([k, v]) => [k, v.map(e => e.id)]));

await ok('board lookups and device groups match the full scans', () => {
  const out = ['db1', 'db2', 'l1', 'gone'].map(id => PC._boardById(id));
  const outDev = ['db1', 'db2', 'gone'].map(id => groups(PC.devicesByWay(id)));
  PC.withBoardIndex(() => {
    assert.deepStrictEqual(['db1', 'db2', 'l1', 'gone'].map(id => PC._boardById(id)), out);
    assert.deepStrictEqual(['db1', 'db2', 'gone'].map(id => groups(PC.devicesByWay(id))), outDev);
  });
  assert.strictEqual(out[0].id, 'db1'); assert.strictEqual(out[2], null);
  assert.deepStrictEqual(JSON.parse(outDev[0]), [['n:1', ['l1', 'l2']], ['n:3', ['s2']]]);
});

await ok('inside the index, lookups do not rescan; nested calls share it', () => {
  PC.withBoardIndex(() => {
    const before = scans;
    for (let i = 0; i < 100; i++) PC._boardById('db2');
    PC.devicesByWay('db1'); PC.devicesByWay('db2');
    PC.withBoardIndex(() => PC._boardById('db1'));
    assert.ok(scans - before <= 1, `scans: ${scans - before}`);   // one, for the device groups
  });
});

await ok('the index is dropped afterwards, also after a throw', () => {
  assert.throws(() => PC.withBoardIndex(() => { throw new Error('x'); }));
  assert.strictEqual(PC._boardIdx, null);
  el(1, 'db3', 'bd_db', {});                     // added after: found by the scan
  assert.strictEqual(PC._boardById('db3').id, 'db3');
});

await ok('syncLoads redraws the single line only while it is on screen', () => {
  pc.window.activeWorkspace = 'plan'; renders = 0;
  PC.syncLoads();
  assert.strictEqual(renders, 0);
  // the ways now exist; a load change touches them again
  floors[0].data.elements.find(e => e.id === 'l1').props.load_va = 75;
  pc.window.activeWorkspace = 'sld';
  PC.syncLoads();
  assert.ok(renders > 0);
  const w = comps.get('sld1').props.circuits.find(c => String(c.way) === '1');
  assert.strictEqual(Number(w.load_va), 135);
});

// ── StreetLight ───────────────────────────────────────────────────────
const sent = [];
let cables = [{ name: 'A', r: 1 }];
const sl = {
  console, Math, JSON, Object, Map, Set, Promise, window: {},
  setTimeout, clearTimeout,
  AppState: { reticulation: { streetLighting: { settings: {}, circuits: [] } } },
  API: {
    runStreetLighting: async (req) => {
      sent.push(req.circuits.map(c => c.id));
      return { circuits: req.circuits.map(c => ({ id: c.id, from: c.v })) };
    },
  },
  document: { getElementById: () => null },
};
vm.createContext(sl);
vm.runInContext(readFileSync(join(js, 'streetlight.js'), 'utf8') + '\n;globalThis.SL = StreetLight;', sl, { filename: 'streetlight.js' });
const SL = sl.SL;
Object.assign(SL, {
  _payload: (c) => ({ id: c.id, v: c.v }),       // the request is all the engine sees
  _candidateCables: () => cables,
  renderRail() {}, renderResults() {}, _paintPoleResults() {},
});
const circuits = sl.AppState.reticulation.streetLighting.circuits;
for (const id of ['c1', 'c2', 'c3']) circuits.push({ id, v: 1, poles: [{}] });
const from = () => Object.fromEntries(Object.entries(SL._results).map(([k, r]) => [k, r.from]));

await ok('first run sends every circuit', async () => {
  await SL._doCompute();
  assert.deepStrictEqual(sent.pop(), ['c1', 'c2', 'c3']);
  assert.deepStrictEqual(from(), { c1: 1, c2: 1, c3: 1 });
});
await ok('nothing changed: nothing sent, results kept', async () => {
  await SL._doCompute();
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(from(), { c1: 1, c2: 1, c3: 1 });
});
await ok('one circuit edited: only it is sent, the others keep their results', async () => {
  circuits[1].v = 2;
  await SL._doCompute();
  assert.deepStrictEqual(sent.pop(), ['c2']);
  assert.deepStrictEqual(from(), { c1: 1, c2: 2, c3: 1 });
});
await ok('a circuit removed or emptied: its result goes, nothing re-sent', async () => {
  circuits.splice(2, 1);
  circuits[0].poles = [];
  await SL._doCompute();
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(from(), { c2: 2 });
  circuits[0].poles = [{}];
  await SL._doCompute();
  assert.deepStrictEqual(sent.pop(), ['c1']);
});
await ok('a different cable list re-sends every circuit', async () => {
  cables = [{ name: 'A', r: 1 }, { name: 'B', r: 2 }];
  await SL._doCompute();
  assert.deepStrictEqual(sent.pop(), ['c1', 'c2']);
});
await ok('a failed request is retried on the next run', async () => {
  circuits[0].v = 3;
  const real = sl.API.runStreetLighting;
  sl.API.runStreetLighting = async () => { throw new Error('offline'); };
  const err = console.error; console.error = () => {};
  await SL._doCompute();
  console.error = err;
  sl.API.runStreetLighting = real;
  await SL._doCompute();
  assert.deepStrictEqual(sent.pop(), ['c1']);
  assert.strictEqual(from().c1, 3);
});

console.log(`\n${n} passed`);
