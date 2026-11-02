/* ProtectionPro — Reticulation kept in sync: site plan → Demand (UX plan PR 7).
 *
 * Runs the real constants.js / state.js / sync.js / plan-defs.js / plan-sync.js
 * (vm sandbox, no browser; Retic stubbed to its two row factories):
 *  · drawn minisub, kiosks and erven become Demand rows, with Fed from and the
 *    measured feeder / service / MV lengths; a second pass changes nothing;
 *  · a length typed in Demand is kept as an override ("typed · plan …") while
 *    the plan moves on, and Reset follows the plan again;
 *  · an old project's differing lengths become overrides on open (adopt);
 *  · a kiosk deleted on the plan leaves Demand; plan undo puts the row back
 *    with what was typed on it, redo removes it again;
 *  · a kiosk deleted in Demand leaves the plan with its cables; Demand undo
 *    puts them back; the stands drawn for its erven stay;
 *  · an undo that takes a drawn element away (not a delete) keeps a row that
 *    was there before, and drops one the pass had created;
 *  · a row an undo in Demand took away comes back under the same id;
 *  · an erf whose service cable moves to another kiosk moves with its data;
 *  · a name match never takes a row another drawn element stands for;
 *  · duplicate minisub / kiosk names and erf numbers under one kiosk are Issues;
 *  · rows added in Demand are listed as not placed, and placing one links it.
 *
 * Run:  node frontend/tests/test_retic_sync.mjs   (exit code 1 on failure)
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
  document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
  localStorage: { getItem: () => null, setItem() {} },
  queueMicrotask, setTimeout, clearTimeout, performance,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
  UI: { toast: (t) => notices.push(t) },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'cases.js', 'state.js', 'sync.js', 'plan-defs.js', 'plan-sync.js']) {
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
const PS = vm.runInContext('PlanSync', ctx);
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// A site plan at 1 px = 1 m: TX1 → K1 (40 m) → K2 (30 m); E1, E2 on K1, E3 on K2.
let pm;
function fresh() {
  A.reticulation = JSON.parse(JSON.stringify(vm.runInContext('AppState.reticulation', ctx)));
  A.reticulation.minisubs = [{ id: 'source', name: 'Minisub 1', mvFedFrom: '', mvCable: '', mvLength: 0 }];
  A.reticulation.kiosks = [];
  A.planMarkup = A._defaultPlanMarkup();
  pm = A.planMarkup;
  pm.scale = { factor: 1 };
  A.syncOverrides = {};
  A.keepInSync = true;
  PS._reticLinks = new Map(); PS._reticAuto = new Set(); PS._reticPairs = [];
  Sync.takeDeleted('plan'); Sync.takeDeleted('retic');
  const el = (type, x, y, name) => { const e = { id: A.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: {} }; pm.elements.push(e); return e; };
  const rt = (type, a, b) => { const r = { id: A.planGenId('pmrt'), type, fromId: a.id, toId: b.id, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], cableType: '', props: {} }; pm.routes.push(r); return r; };
  const ms = el('minisub', 0, 0, 'TX1');
  const k1 = el('kiosk', 40, 0, 'K1'), k2 = el('kiosk', 70, 0, 'K2');
  const lv1 = rt('lv', ms, k1), lv2 = rt('lv', k1, k2);
  const e1 = el('erf', 40, 12, 'E1'), e2 = el('erf', 40, -20, 'E2'), e3 = el('erf', 70, 15, 'E3');
  const s1 = rt('service', k1, e1), s2 = rt('service', k1, e2), s3 = rt('service', k2, e3);
  return { ms, k1, k2, lv1, lv2, e1, e2, e3, s1, s2, s3, el, rt };
}
const pass = (opts) => Sync.run(opts);
const R = () => A.reticulation;
const kiosk = (name) => R().kiosks.find(k => k.name === name);
const erf = (num) => { for (const k of R().kiosks) { const e = k.erfs.find(x => x.erfNumber === num); if (e) return { k, e }; } return null; };
// The plan's own undo: a snapshot of the drawing, put back wholesale.
const snap = () => JSON.stringify({ els: pm.elements, rts: pm.routes });
const restore = (s) => { const o = JSON.parse(s); pm.elements.splice(0, pm.elements.length, ...o.els); pm.routes.splice(0, pm.routes.length, ...o.rts); };

await ok('drawn items become Demand rows with Fed from and measured lengths; a second pass changes nothing', () => {
  const d = fresh();
  deq(pass().changed, ['retic']);
  assert.strictEqual(R().minisubs.length, 1);
  assert.strictEqual(R().minisubs[0].name, 'TX1');                 // the untouched default minisub is adopted
  deq(R().kiosks.map(k => k.name), ['K1', 'K2']);
  assert.strictEqual(kiosk('K1').fedFrom, 'source');
  assert.strictEqual(kiosk('K2').fedFrom, kiosk('K1').id);
  assert.strictEqual(kiosk('K1').feederLength, 40);
  assert.strictEqual(kiosk('K2').feederLength, 30);
  assert.strictEqual(erf('E1').e.length, 12);
  assert.strictEqual(erf('E3').k.name, 'K2');
  assert.strictEqual(d.k2.reticId, kiosk('K2').id);
  assert.strictEqual(PS._reticFed[kiosk('K2').id], d.lv2.id);        // Fed from is the plan's
  deq(pass().changed, []);
});

await ok('a length typed in Demand is kept while the plan moves on; Reset follows the plan', () => {
  const d = fresh(); pass();
  const k2 = kiosk('K2');
  const key = 'len:feeder:' + k2.id;
  k2.feederLength = 45;                                                 // typed in Demand …
  Sync.setOverride(key, 45, PS._reticSrc[key]);                        // … as Retic._typedLength records it
  d.k2.x = 90; d.lv2.points[1].x = 90;                                 // the kiosk moves on the plan: 50 m
  pass();
  assert.strictEqual(k2.feederLength, 45);
  deq(Sync.override(key), { v: 45, src: 50 });                         // "typed · plan 50 m"
  Sync.resetOverride(key); pass();
  assert.strictEqual(k2.feederLength, 50);
  assert.strictEqual(Sync.override(key), null);
});

await ok('an old project: differing lengths become overrides on open, nothing else changes', () => {
  fresh(); pass();
  const k1 = kiosk('K1'), e1 = erf('E1').e;
  k1.feederLength = 44; e1.length = 15;                                 // typed before sync existed
  A.syncOverrides = {};
  A.dirty = false;
  pass({ adopt: true });
  assert.strictEqual(k1.feederLength, 44);
  assert.strictEqual(e1.length, 15);
  deq(A.syncOverrides['len:feeder:' + k1.id], { v: 44, src: 40 });
  deq(A.syncOverrides['len:service:' + e1.id], { v: 15, src: 12 });
  assert.strictEqual(A.dirty, false);
});

await ok('a kiosk deleted on the plan leaves Demand; plan undo puts it back with its data; redo removes it again', () => {
  const d = fresh(); pass();
  const id = kiosk('K2').id;
  kiosk('K2').admdOverride = 3.5;                                       // typed in Demand
  const before = snap();
  Sync.markDeleted('plan', d.k2.id);                                    // PlanMarkup.deleteSelected
  pm.elements.splice(pm.elements.indexOf(d.k2), 1);
  const after = snap();
  notices.length = 0;
  pass();
  assert.strictEqual(kiosk('K2'), undefined);
  assert.match(notices[0], /K2 removed from Demand too/);
  restore(before); pass();                                              // plan undo
  assert.strictEqual(kiosk('K2').id, id);
  assert.strictEqual(kiosk('K2').admdOverride, 3.5);
  assert.strictEqual(kiosk('K2').erfs.length, 1);
  restore(after); pass();                                               // plan redo
  assert.strictEqual(kiosk('K2'), undefined);
});

await ok('a kiosk deleted in Demand leaves the plan with its cables; Demand undo puts them back; its stands stay', () => {
  const d = fresh(); pass();
  const before = JSON.stringify(R());
  const k2 = kiosk('K2');
  Sync.markDeleted('retic', k2.id);                                     // Retic.deleteKiosk
  R().kiosks.splice(R().kiosks.indexOf(k2), 1);
  notices.length = 0;
  pass();
  assert.ok(!pm.elements.some(e => e.id === d.k2.id));
  assert.ok(!pm.routes.some(r => r.id === d.lv2.id || r.id === d.s3.id));
  assert.ok(pm.elements.some(e => e.id === d.e3.id));                  // the stand stays
  assert.match(notices[0], /K2 removed from the site plan too/);
  A.reticulation = JSON.parse(before); pass();                          // Demand undo
  assert.ok(pm.elements.some(e => e.id === d.k2.id));
  assert.ok(pm.routes.some(r => r.id === d.lv2.id) && pm.routes.some(r => r.id === d.s3.id));
  assert.strictEqual(kiosk('K2').erfs.length, 1);
});

await ok('an undo that takes a drawn kiosk away keeps a row that was there before and drops one the pass created', () => {
  const d = fresh(); pass();
  // A kiosk added in Demand, then placed on the plan, then the placement undone.
  const row = Retic_newKiosk('K9');
  const before = snap();
  const el = PS.placeFromDemand(row.id, 100, 0);
  assert.strictEqual(el.reticId, row.id);
  pass();
  restore(before); pass();
  assert.ok(kiosk('K9'));                                               // it stays, not placed yet
  assert.ok(PS.reticUnplaced().kiosks.some(k => k.id === row.id));
  // A kiosk drawn on the plan (the pass made its row), then the drawing undone.
  const before2 = snap();
  d.el('kiosk', 120, 0, 'K10');
  pass();
  assert.ok(kiosk('K10'));
  restore(before2); pass();
  assert.strictEqual(kiosk('K10'), undefined);
});
function Retic_newKiosk(name) {
  const k = vm.runInContext('Retic', ctx)._newKiosk('source');
  k.name = name; R().kiosks.push(k); return k;
}

await ok('a row an undo in Demand took away comes back under the same id', () => {
  fresh(); pass();
  const id = kiosk('K2').id, eid = erf('E3').e.id;
  R().kiosks = R().kiosks.filter(k => k.id !== id);                     // no delete mark: an undo
  pass();
  assert.strictEqual(kiosk('K2').id, id);
  assert.strictEqual(erf('E3').e.id, eid);
});

await ok('an erf whose service cable moves to another kiosk moves with what was typed on it', () => {
  const d = fresh(); pass();
  const e1 = erf('E1').e; e1.ampsOverride = 60;
  d.s1.fromId = d.k2.id;                                                // reconnected to K2
  pass();
  assert.strictEqual(erf('E1').k.name, 'K2');
  assert.strictEqual(erf('E1').e.ampsOverride, 60);
  assert.strictEqual(kiosk('K1').erfs.length, 1);
  deq(pass().changed, []);
});

await ok('a name match never takes a row another drawn element stands for', () => {
  const d = fresh(); pass();
  d.el('kiosk', 200, 0, 'K1');                                          // a second "K1"
  pass();
  assert.strictEqual(R().kiosks.filter(k => k.name === 'K1').length, 2);
  assert.strictEqual(new Set(pm.elements.filter(e => e.type === 'kiosk').map(e => e.reticId)).size, 3);
});

await ok('duplicate names go on the Issues list, and come off once renamed', () => {
  const d = fresh(); pass();
  deq(Sync.issues.filter(i => i.key.startsWith('retic-dup')), []);
  d.el('kiosk', 200, 0, 'k1 ');                                         // same name, other case / spaces
  erf('E2').e.erfNumber = 'E1';                                         // two erven numbered E1 under K1
  erf('E3').e.erfNumber = 'E1';                                         // … and one under K2: not a clash
  pass();
  const dup = Sync.issues.filter(i => i.key.startsWith('retic-dup'));
  deq(dup.map(i => i.key).sort(), ['retic-dup:erf:' + kiosk('K1').id + ':e1', 'retic-dup:kiosk:k1']);
  assert.match(dup.find(i => i.key.startsWith('retic-dup:kiosk')).text, /2 kiosks are called "K1"/);
  assert.match(dup.find(i => i.key.startsWith('retic-dup:erf')).text, /2 erven under K1 are numbered E1/);
  assert.strictEqual(dup.find(i => i.key.startsWith('retic-dup:kiosk')).action.ids.length, 2);
  R().kiosks.find(k => k.name === 'k1 ').name = 'K4';
  erf('E1').k.erfs.find(e => e.erfNumber === 'E1' && e !== erf('E1').e).erfNumber = 'E2';
  pass();
  deq(Sync.issues.filter(i => i.key.startsWith('retic-dup')), []);
});

await ok('rows added in Demand are not placed yet; placing one links it', () => {
  fresh(); pass();
  const row = Retic_newKiosk('K5');
  const e = { id: 'erf_x', erfNumber: '77', length: 20, phase: 'Red', cableType: '', ampsOverride: 0 };
  row.erfs.push(e);
  const u = PS.reticUnplaced();
  deq(u.kiosks.map(k => k.name), ['K5']);
  deq(u.erven.map(g => g.erfs.map(x => x.erfNumber)), [['77']]);
  const el = PS.placeFromDemand(e.id, 10, 10);
  assert.strictEqual(el.type, 'erf');
  assert.strictEqual(el.name, '77');
  assert.strictEqual(PS.reticUnplaced().erven.length, 0);
  assert.strictEqual(PS.placeFromDemand(e.id, 0, 0), null);           // only once
});

await ok('an uncalibrated plan keeps Demand\'s lengths and says so on the Issues list', () => {
  fresh(); pm.scale = null;
  pass();
  assert.strictEqual(kiosk('K1').feederLength, 25);
  assert.ok(Sync.issues.some(i => i.key === 'plan-uncalibrated'));
});

await ok('a plan with no minisubs, kiosks or erven starts no Reticulation sync', () => {
  fresh();
  pm.elements.length = 0; pm.routes.length = 0;
  A.planMarkup.settings.domain = 'retic';
  deq(pass().changed, []);
});

console.log(`\n${n} passed`);
