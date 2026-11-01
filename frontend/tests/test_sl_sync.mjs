/* ProtectionPro — Street lighting kept in sync (UX plan PR 8).
 *
 * Runs the real constants / state / sync / plan-defs / plan-sync / cablelib /
 * streetlight / roadlight / roadplan / roadplan-circuits (vm sandbox, no
 * browser). The road plan's geometry is replaced by plain roads
 * (RoadPlan._circuitInput), so only the circuit side is tested here — the
 * planner itself has testing/unit/roadcircuits.test.js.
 *
 *  · poles drawn on the site plan from a kiosk become a circuit (spans
 *    measured, a branch is a spur) and its load goes to Demand; a second pass
 *    changes nothing;
 *  · a span typed in Street lighting is kept while the plan moves on; Reset
 *    follows the plan;
 *  · a pole deleted on the plan leaves its circuit; undo brings it back with
 *    its luminaire;
 *  · a circuit whose drawn poles are all deleted is removed, with a notice;
 *    undo brings it back under the same id with its settings;
 *  · deleting a site-plan circuit in Street lighting deletes its poles on the
 *    plan; putting them back brings the circuit back;
 *  · poles added by hand to a drawn circuit stay when the drawing goes;
 *  · an uncalibrated plan makes no circuits and says so on the Issues list;
 *  · a road with a feed point is a circuit with the road plan's settings;
 *    removing the feed point removes it, putting it back restores it; deleting
 *    a road circuit in Street lighting removes the feed point;
 *  · a side road no pole can reach goes on the Issues list.
 *
 * Run:  node frontend/tests/test_sl_sync.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const notices = [];
const ctx = {
  console, Math, JSON, window: {},
  document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ getContext: () => null, style: {} }) },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { userAgent: '' },
  queueMicrotask, setTimeout, clearTimeout, performance,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
  UI: { toast: (t) => notices.push(t), confirm: async () => true, alert: async () => {} },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'state.js', 'sync.js', 'plan-defs.js', 'plan-sync.js', 'cablelib.js', 'streetlight.js', 'roadlight.js', 'roadplan.js', 'roadplan-circuits.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext(`
  var Retic = {
    get settings() { return AppState.reticulation.settings; },
    get kiosks() { return AppState.reticulation.kiosks; },
    _newKiosk(fedFrom) {
      return { id: AppState.reticGenKioskId(), name: 'Kiosk', fedFrom: fedFrom || 'source', loadClass: '',
        admdOverride: 0, streetLightKVA: 0, feederCable: '', feederLength: 25, collapsed: false, erfs: [] };
    },
  };`, ctx);
const A = vm.runInContext('AppState', ctx);
const Sync = vm.runInContext('Sync', ctx);
const SL = vm.runInContext('StreetLight', ctx);
const RP = vm.runInContext('RoadPlan', ctx);
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// Site plan at 1 px = 1 m: TX1 → K1; K1 → P1 (20) → P2 (30) → P3 (30), P2 → P4 (25) spur.
let pm, roadsIn = [];
RP._circuitInput = () => roadsIn;
function fresh() {
  A.reticulation = JSON.parse(JSON.stringify(vm.runInContext('AppState.reticulation', ctx)));
  A.reticulation.minisubs = [{ id: 'source', name: 'Minisub 1', mvFedFrom: '', mvCable: '', mvLength: 0 }];
  A.reticulation.kiosks = [];
  delete A.reticulation.streetLighting;
  A.planMarkup = A._defaultPlanMarkup();
  pm = A.planMarkup;
  pm.scale = { factor: 1 };
  A.syncOverrides = {};
  A.keepInSync = true;
  roadsIn = [];
  SL._memo = { circuits: new Map(), poles: new Map() };
  const PS = vm.runInContext('PlanSync', ctx);
  PS._reticLinks = new Map(); PS._reticAuto = new Set(); PS._reticPairs = [];
  Sync.takeDeleted('plan'); Sync.takeDeleted('retic');
  const el = (type, x, y, name) => { const e = { id: A.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: {} }; pm.elements.push(e); return e; };
  const rt = (type, a, b) => { const r = { id: A.planGenId('pmrt'), type, fromId: a.id, toId: b.id, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], cableType: '', props: {} }; pm.routes.push(r); return r; };
  const ms = el('minisub', 0, 0, 'TX1'), k1 = el('kiosk', 40, 0, 'K1');
  rt('lv', ms, k1);
  const p1 = el('pole', 60, 0, 'P1'), p2 = el('pole', 90, 0, 'P2'), p3 = el('pole', 120, 0, 'P3'), p4 = el('pole', 90, 25, 'P4');
  const r1 = rt('sl', k1, p1), r2 = rt('sl', p1, p2), r3 = rt('sl', p2, p3), r4 = rt('sl', p2, p4);
  return { ms, k1, p1, p2, p3, p4, r1, r2, r3, r4, el, rt };
}
const pass = () => Sync.run();
const circ = () => SL.circuits;
const pole = (name) => { for (const c of circ()) { const p = c.poles.find(x => x.name === name); if (p) return { c, p }; } return null; };
const snap = () => JSON.stringify({ els: pm.elements, rts: pm.routes });
const restore = (s) => { const o = JSON.parse(s); pm.elements.splice(0, pm.elements.length, ...o.els); pm.routes.splice(0, pm.routes.length, ...o.rts); };

await ok('drawn poles become a circuit with measured spans and a spur; its load goes to Demand; a second pass changes nothing', () => {
  fresh();
  deq(pass().changed, ['retic', 'streetlight']);
  assert.strictEqual(circ().length, 1);
  const c = circ()[0];
  deq(c.poles.map(p => [p.name, p.spacingM]), [['P1', 20], ['P2', 30], ['P3', 30], ['P4', 25]]);
  assert.strictEqual(pole('P4').p.parent, pole('P2').p.id);
  const k = A.reticulation.kiosks[0];
  assert.ok(k.streetLightFromCircuits && k.streetLightKVA > 0);
  deq(pass().changed, []);
});

await ok('a span typed in Street lighting is kept while the plan moves on; Reset follows the plan', () => {
  const d = fresh(); pass();
  const p3 = pole('P3').p, key = 'span:' + p3.id;
  p3.spacingM = 35; Sync.setOverride(key, 35, SL._spanSrc[p3.id]);   // as the pole grid records it
  d.p3.x = 130; d.r3.points[1].x = 130;                               // the pole moves: 40 m
  pass();
  assert.strictEqual(p3.spacingM, 35);
  deq(Sync.override(key), { v: 35, src: 40 });
  Sync.resetOverride(key); pass();
  assert.strictEqual(p3.spacingM, 40);
});

await ok('a pole deleted on the plan leaves its circuit; undo brings it back with its luminaire', () => {
  const d = fresh(); pass();
  const id = pole('P3').p.id;
  pole('P3').p.luminaireId = 'led-70';
  const before = snap();
  pm.elements.splice(pm.elements.indexOf(d.p3), 1);
  pm.routes.splice(pm.routes.indexOf(d.r3), 1);
  pass();
  assert.strictEqual(pole('P3'), null);
  assert.strictEqual(circ()[0].poles.length, 3);
  restore(before); pass();
  assert.strictEqual(pole('P3').p.id, id);
  assert.strictEqual(pole('P3').p.luminaireId, 'led-70');
});

await ok('a circuit whose drawn poles are all deleted is removed with a notice; undo brings it back with its settings', () => {
  const d = fresh(); pass();
  const c = circ()[0], id = c.id;
  c.cable = 'my-cable'; c.protection = 'custom';
  const before = snap();
  for (const e of [d.p1, d.p2, d.p3, d.p4]) pm.elements.splice(pm.elements.indexOf(e), 1);
  notices.length = 0;
  pass();
  assert.strictEqual(circ().length, 0);
  assert.ok(!A.reticulation.kiosks[0].streetLightFromCircuits);          // the kiosk's SL load goes back
  assert.match(notices.join(' '), /removed from Street lighting/);
  restore(before); pass();
  assert.strictEqual(circ().length, 1);
  assert.strictEqual(circ()[0].id, id);
  assert.strictEqual(circ()[0].cable, 'my-cable');
  assert.strictEqual(circ()[0].protection, 'custom');
});

await ok('deleting a site-plan circuit in Street lighting deletes its poles on the plan; putting them back restores it', async () => {
  fresh(); pass();
  const before = snap();
  const id = circ()[0].id;
  await SL.deleteCircuit(id);
  assert.strictEqual(circ().length, 0);
  assert.ok(!pm.elements.some(e => e.type === 'pole'));
  assert.ok(!pm.routes.some(r => r.type === 'sl'));
  pass();
  assert.strictEqual(circ().length, 0);                                  // the pass does not make it again
  restore(before); pass();                                               // undo on the plan
  assert.strictEqual(circ()[0].id, id);
});

await ok('poles added by hand to a drawn circuit stay when the drawing goes', () => {
  const d = fresh(); pass();
  SL._addPoles(circ()[0], 1, pole('P3').p.id);
  for (const e of [d.p1, d.p2, d.p3, d.p4]) pm.elements.splice(pm.elements.indexOf(e), 1);
  pass();
  assert.strictEqual(circ().length, 1);
  assert.strictEqual(circ()[0].poles.length, 1);
  assert.strictEqual(circ()[0].poles[0].parent, null);
});

await ok('an uncalibrated plan makes no circuits and says so on the Issues list', () => {
  fresh(); pm.scale = null;
  pass();
  assert.strictEqual(circ().length, 0);
  assert.ok(Sync.issues.some(i => i.key === 'sl-plan-uncalibrated'));
});

// Road plan: plain roads in, circuits out.
function roads(kioskId) {
  RP.rp.roads = [
    { id: 'rd1', name: 'Main Rd', feed: { source: { kind: 'kiosk', id: kioskId }, x: 0, y: -10, route: [] }, poles: [] },
    { id: 'rd2', name: 'Side St', poles: [] },
    { id: 'rd3', name: 'Far Lane', poles: [] },
  ];
  const line = (pre, x0, y0, dx, dy, k) => Array.from({ length: k }, (_, i) => ({ id: `${pre}${i + 1}`, x: x0 + i * dx, y: y0 + i * dy, ph: null }));
  roadsIn = [
    { id: 'rd1', name: 'Main Rd', poles: line('a', 0, 0, 30, 0, 4), feed: { x: 0, y: -10, route: [] }, parents: [] },
    { id: 'rd2', name: 'Side St', poles: line('b', 60, 20, 0, 30, 3), feed: null, parents: [{ main: 'rd1', end: 'start' }] },
    { id: 'rd3', name: 'Far Lane', poles: line('c', 300, 200, 30, 0, 2), feed: null, parents: [{ main: 'rd1', end: 'start' }] },
  ];
}
const syncRoads = (kid) => { roads(kid); A.dirty = false; return pass(); };

await ok('a road with a feed point is a circuit with the road plan\'s settings; a side road joins as a spur', () => {
  fresh(); pass();
  const kid = A.reticulation.kiosks[0].id;
  RP.rp.settings.circuitSystem = '1ph';
  syncRoads(kid);
  const c = circ().find(x => x.roadKey === 'rd1');
  assert.ok(c);
  assert.strictEqual(c.system, '1ph');
  assert.strictEqual(c.poles.length, 7);                                 // 4 on Main Rd + 3 on Side St
  assert.ok(Sync.issues.some(i => i.key === 'rp-spur:rd3'));             // Far Lane is out of reach
  assert.strictEqual(RP.road('rd2').circuitId, c.id);
  deq(pass().changed, []);
});

await ok('removing the feed point removes the road circuit; putting it back restores it; deleting it in Street lighting removes the feed point', async () => {
  fresh(); pass();
  const kid = A.reticulation.kiosks[0].id;
  syncRoads(kid);
  const c = circ().find(x => x.roadKey === 'rd1');
  c.poles[0].luminaireId = 'led-70';
  const feed = RP.road('rd1').feed;
  delete RP.road('rd1').feed; roadsIn[0].feed = null;
  pass();
  assert.ok(!circ().some(x => x.roadKey === 'rd1'));
  RP.road('rd1').feed = feed; roadsIn[0].feed = { x: 0, y: -10, route: [] };
  pass();
  const back = circ().find(x => x.roadKey === 'rd1');
  assert.strictEqual(back.id, c.id);
  assert.strictEqual(back.poles[0].luminaireId, 'led-70');
  RP._commit = () => {};
  await SL.deleteCircuit(back.id);
  assert.ok(!RP.road('rd1').feed);
});

console.log(`\n${n} passed`);
