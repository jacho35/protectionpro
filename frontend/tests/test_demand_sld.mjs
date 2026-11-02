/* ProtectionPro — Demand → single line kept in sync (UX plan PR 9).
 *
 * Runs the real constants / state / sync / cablelib / retic (vm sandbox, no
 * browser; the ADMD server call is stubbed: 10 kVA per erf).
 *
 *  · nothing happens until the first stack is on the single line ("Add to
 *    the single line"); after that each minisub's load follows ADMD, which
 *    runs in the background when Demand's inputs change;
 *  · on Auto the transformer follows the demand; a size picked in Demand is
 *    applied once and stays; a library transformer picked on the single line
 *    becomes Demand's pick;
 *  · a load typed on the single line is kept as an override; Reset follows
 *    Demand again;
 *  · a new minisub with demand gets its stack;
 *  · a minisub deleted in Demand takes its stack; undo in Demand puts it back;
 *  · a stack deleted on the single line leaves the minisub, marked off the
 *    single line; Add back / undo there puts it on again;
 *  · renaming a stack part on the single line renames the minisub;
 *  · a stack pushed before the sync keeps its transformer and typed load on
 *    open (adopt);
 *  · an unwired transformer primary is an Issues entry.
 *
 * Run:  node frontend/tests/test_demand_sld.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const notices = [];
let admdCalls = 0;
const ctx = {
  console, Math, JSON, window: {},
  document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { userAgent: '' },
  queueMicrotask, setTimeout, clearTimeout, performance, structuredClone,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
  UI: { toast: (t) => notices.push(t), alert: async () => {}, confirm: async () => true },
  API: {
    async runAdmd(payload, kiosks, minisubs) {
      admdCalls++;
      const root = (k) => { let cur = k, n = 0; while (cur && n++ < 50) { const p = kiosks.find(x => x.id === cur.fedFrom); if (!p) return cur.fedFrom; cur = p; } return null; };
      return {
        kiosks: [],
        minisubs: minisubs.map(m => {
          const ks = kiosks.filter(k => root(k) === m.id);
          const conns = ks.reduce((a, k) => a + k.erfs.length, 0);
          return { minisubId: m.id, name: m.name, conns, numKiosks: ks.length, totalKVA: conns * 10, currentA: conns * 14 };
        }),
      };
    },
  },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'cases.js', 'state.js', 'sync.js', 'cablelib.js', 'retic.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
const A = vm.runInContext('AppState', ctx);
const Sync = vm.runInContext('Sync', ctx);
const Retic = vm.runInContext('Retic', ctx);
Retic._snapshot = () => {};
Retic.deactivate = () => {};
Sync.DEBOUNCE_MS = 5;
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const tick = (ms = 700) => new Promise(r => setTimeout(r, ms));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

function fresh() {
  A.components.clear(); A.wires.clear();
  A.reticulation = JSON.parse(JSON.stringify(vm.runInContext('AppState.reticulation', ctx)));
  const R = A.reticulation;
  R.minisubs = [{ id: 'source', name: 'MS1', mvFedFrom: '', mvCable: '', mvLength: 0 }];
  R.kiosks = [];
  A.reticResults = null;
  A.syncOverrides = {};
  A.keepInSync = true;
  Retic._resSig = null; Retic._bgSig = null; Retic._stackPairs = []; Retic._stackSeen = new Set();
  addKiosk('source', 4);                                  // 40 kVA
}
function addKiosk(ms, erven) {
  const k = Retic._newKiosk(ms);
  for (let i = 0; i < erven; i++) k.erfs.push(Retic._newErf(k, i + 1));
  A.reticulation.kiosks.push(k);
  return k;
}
// Run the pass, let the background ADMD land, run again (as Sync.kick would).
async function settle() { Sync.run(); await tick(); Sync.run(); }
const stack = (msId = 'source') => Retic._stacks()[msId] || {};

await ok('nothing happens until the first stack is on the single line', async () => {
  fresh(); admdCalls = 0;
  await settle();
  assert.strictEqual(A.components.size, 0);
  assert.strictEqual(admdCalls, 0);                       // no background ADMD without a single line
  await Retic.addToSLD();
  const st = stack();
  assert.ok(st.tx && st.bus && st.load);
  assert.strictEqual(st.load.props.rated_kva, 40);
  assert.strictEqual(st.tx.props.standard_type, 'xfmr_50kva');   // Auto: smallest unit ≥ 40 kVA
});

await ok('more erven: ADMD runs in the background and the load and the Auto transformer follow', async () => {
  fresh(); await Retic.addToSLD();
  addKiosk('source', 3);                                   // 70 kVA
  admdCalls = 0;
  await settle();
  assert.strictEqual(admdCalls, 1);
  assert.strictEqual(stack().load.props.rated_kva, 70);
  assert.strictEqual(stack().tx.props.standard_type, Retic._minisubTx(null, 70).entry.id);
  const again = Sync.run();
  deq(again.changed, []);
});

await ok('a size picked in Demand is applied once and stays; one picked on the single line becomes Demand\'s pick', async () => {
  fresh(); await Retic.addToSLD();
  A.reticulation.minisubs[0].txTypeId = 'xfmr_100kva';
  await settle();
  assert.strictEqual(stack().tx.props.standard_type, 'xfmr_100kva');
  stack().tx.props.z_percent = 5.5;                        // a tweak on the single line
  addKiosk('source', 10);                                  // 140 kVA: Demand's pick still 100
  await settle();
  assert.strictEqual(stack().tx.props.z_percent, 5.5);
  stack().tx.props.standard_type = 'xfmr_200kva';          // a library pick on the single line
  await settle();
  assert.strictEqual(A.reticulation.minisubs[0].txTypeId, 'xfmr_200kva');
});

await ok('a load typed on the single line is kept; Reset follows Demand again', async () => {
  fresh(); await Retic.addToSLD();
  const load = stack().load;
  Sync.onFieldEdited(load, 'rated_kva', 40, 55); load.props.rated_kva = 55;
  addKiosk('source', 1);                                   // 50 kVA
  await settle();
  assert.strictEqual(load.props.rated_kva, 55);
  deq(Sync.override('kva:source'), { v: 55, src: 50 });
  assert.match(Sync.fieldFlagHtml(load, 'rated_kva'), /typed · Demand 50 kVA/);
  Sync.resetOverride('kva:source'); Sync.run();
  assert.strictEqual(load.props.rated_kva, 50);
});

await ok('a new minisub with demand gets its own stack', async () => {
  fresh(); await Retic.addToSLD();
  A.reticulation.minisubs.push({ id: 'ms2', name: 'MS2', mvFedFrom: '', mvCable: '', mvLength: 0 });
  addKiosk('ms2', 2);
  await settle();
  assert.strictEqual(stack('ms2').load.props.rated_kva, 20);
  assert.strictEqual(stack('ms2').load.props.name, 'Retic: MS2');
});

await ok('a minisub deleted in Demand takes its stack; undo in Demand puts it back', async () => {
  fresh(); await Retic.addToSLD();
  A.reticulation.minisubs.push({ id: 'ms2', name: 'MS2', mvFedFrom: '', mvCable: '', mvLength: 0 });
  addKiosk('ms2', 2);
  await settle();
  const ids = Object.values(stack('ms2')).map(c => c.id).sort();
  const before = JSON.stringify(A.reticulation);
  A.reticulation.minisubs = A.reticulation.minisubs.filter(m => m.id !== 'ms2');
  A.reticulation.kiosks = A.reticulation.kiosks.filter(k => k.fedFrom !== 'ms2');
  notices.length = 0;
  await settle();
  deq(stack('ms2'), {});
  assert.match(notices.join(' '), /Retic: MS2 removed from the single line too/);
  A.reticulation = JSON.parse(before);
  await settle();
  deq(Object.values(stack('ms2')).map(c => c.id).sort(), ids);
});

await ok('a stack deleted on the single line leaves the minisub off it; Add back puts it on again', async () => {
  fresh(); await Retic.addToSLD();
  A.reticulation.minisubs.push({ id: 'ms2', name: 'MS2', mvFedFrom: '', mvCable: '', mvLength: 0 });
  addKiosk('ms2', 2);
  await settle();
  A.removeComponent(stack('ms2').tx.id);                   // the user deletes the transformer
  await settle();
  deq(stack('ms2'), {});                                   // its bus and load go with it
  assert.strictEqual(A.reticulation.minisubs.find(m => m.id === 'ms2').sldOff, true);
  assert.ok(stack('source').tx);                           // the other stack stays
  await settle();
  deq(stack('ms2'), {});                                   // not made again
  await Retic.addToSLD('ms2');
  assert.ok(stack('ms2').tx);
  assert.strictEqual(A.reticulation.minisubs.find(m => m.id === 'ms2').sldOff, false);
});

await ok('renaming a stack part on the single line renames the minisub', async () => {
  fresh(); await Retic.addToSLD();
  stack().tx.props.name = 'Retic: North TX';
  await settle();
  assert.strictEqual(A.reticulation.minisubs[0].name, 'North');
  assert.strictEqual(stack().load.props.name, 'Retic: North');
  assert.strictEqual(stack().bus.props.name, 'Retic: North LV');
});

await ok('a stack pushed before the sync keeps its transformer and typed load on open', async () => {
  fresh();
  await Retic._doCompute();
  await Retic.pushToSLD();                                 // the old button
  const st = stack();
  delete st.tx.reticTx;                                    // as saved by an older version
  st.tx.props.standard_type = 'xfmr_100kva';               // changed on the single line back then
  st.load.props.rated_kva = 48;                            // typed back then
  A.syncOverrides = {};
  Retic._resSig = null;                                    // just opened: no result for these inputs yet
  Sync.run({ adopt: true });
  await tick(); Sync.run();
  assert.strictEqual(stack().tx.props.standard_type, 'xfmr_100kva');
  assert.strictEqual(A.reticulation.minisubs[0].txTypeId, 'xfmr_100kva');
  assert.strictEqual(stack().load.props.rated_kva, 48);
  deq(Sync.override('kva:source'), { v: 48, src: 40 });
});

await ok('an unwired transformer primary is an Issues entry', async () => {
  fresh(); await Retic.addToSLD();
  await settle();
  assert.ok(Sync.issues.some(i => i.key === 'demand-tx-unwired'));
  const mv = A.addComponent('bus', 0, 0);
  A.addWire(mv.id, 'at_0', stack().tx.id, 'primary', true);
  Sync.run();
  assert.ok(!Sync.issues.some(i => i.key === 'demand-tx-unwired'));
});

await tick(50);
console.log(`\n${n} passed`);
process.exit(0);
