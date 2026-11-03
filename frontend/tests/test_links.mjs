/* ProtectionPro — Links: one table of every link between workspaces (UX plan PR 10).
 *
 * Runs the real constants / state / plan-sync / links (vm sandbox, no
 * browser) on a project that holds one of every kind of link:
 *  · every kind in Links.KINDS lists its link, from the field it is stored in;
 *  · of() finds a link from either end; find() picks one workspace;
 *  · name() reads a short name from each workspace;
 *  · a link mark goes to the owner and carries where to come back to, escaped;
 *  · a link that is gone is not listed (the index is rebuilt after each task).
 *
 * Run:  node frontend/tests/test_links.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const ctx = {
  console, Math, JSON, window: {},
  document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
  localStorage: { getItem: () => null, setItem() {} },
  queueMicrotask, setTimeout, clearTimeout, performance, structuredClone,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'cases.js', 'state.js', 'plan-defs.js', 'plan-sync.js', 'links.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
}
const A = vm.runInContext('AppState', ctx);
const L = vm.runInContext('Links', ctx);
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const tick = () => new Promise(r => setTimeout(r, 0));

// One of every link.
A.components.clear(); A.wires.clear();
const comp = (id, type, extra, props) => { const c = Object.assign({ id, type, x: 0, y: 0, rotation: 0, props: Object.assign({ name: id.toUpperCase() }, props || {}) }, extra || {}); A.components.set(id, c); return c; };
A.planMarkup = A._defaultPlanMarkup();
const pm = A.planMarkup;
const el = (id, type, extra) => { const e = Object.assign({ id, type, x: 0, y: 0, rotation: 0, name: id.toUpperCase(), props: {} }, extra || {}); pm.elements.push(e); return e; };
A.reticulation.minisubs = [{ id: 'ms1', name: 'MS1' }];
A.reticulation.kiosks = [{ id: 'k1', name: 'K1', fedFrom: 'ms1', erfs: [{ id: 'e1', erfNumber: '12' }] }];
comp('db1', 'distribution_board', { planLink: 'pdb1' }, { circuits: [{ id: 'w1', way: '1', type: 'feeder_db', sld: { device: 'cb1', cable: 'cab1' }, feedsDbId: 'db2' }] });
comp('db2', 'distribution_board');
comp('cb1', 'cb');
comp('cab1', 'cable', { planLink: 'rt1' });
comp('cab2', 'cable', { riserLink: 'rt2' });
comp('sec1', 'bus', { swLink: 'psw1' });
comp('tx1', 'transformer', { reticMinisubId: 'ms1', reticRole: 'tx' });
comp('ld1', 'static_load', { reticLoadId: 'rl1' });
comp('op1', 'offpage_connector', null, { linked_to: 'op2' });
comp('op2', 'offpage_connector');
el('pk1', 'kiosk', { reticId: 'k1' });
el('pdb1', 'bd_db', { sldId: 'db1' });
el('psw1', 'bd_switchboard', { sldMembers: ['sec1'] });
el('dev1', 'bd_light', { props: { circuitDbId: 'pdb1', circuitWid: 'w1' } });
el('pp1', 'pole');
pm.routes.push({ id: 'rt1', type: 'feeder', fromId: 'pdb1', toId: 'pdb1', points: [], sldCableId: 'cab1' });
pm.routes.push({ id: 'rt2', type: 'feeder', fromId: 'pdb1', toId: 'pdb1', points: [], sldRiserCableId: 'cab2' });
A.reticulation.streetLighting = { circuits: [
  { id: 'slc1', name: 'SL-K1-01', source: { kind: 'kiosk', id: 'k1' }, planKey: 'pk1>pp1', poles: [{ id: 'slp1', name: 'P01', planId: 'pp1' }] },
  { id: 'slc2', name: 'SL-K1-02', source: { kind: 'kiosk', id: 'k1' }, roadKey: 'rd1', poles: [] },
] };

await ok('every kind of link is listed from the field it is stored in', () => {
  const kinds = new Set(L.all().map(l => l.kind));
  deq([...L.KINDS.map(k => k.id)].filter(k => !kinds.has(k)), []);
  const has = (a, b) => L.all().some(l => l.a === a && l.b === b);
  assert.ok(has('plan:pk1', 'retic:k1'));
  assert.ok(has('sld:tx1', 'retic:ms1'));
  assert.ok(has('plan:dev1', 'way:db1/w1'));          // a device tagged to the plan board → the single-line board's way
  assert.ok(has('way:db1/w1', 'sld:cab1'));
  assert.ok(has('sl:slp1', 'plan:pp1'));
  assert.ok(has('sl:slc2', 'rp:rd1'));
});

await ok('of() finds a link from either end; find() picks one workspace', () => {
  deq(L.of('retic:k1').map(l => l.to).sort(), ['plan:pk1', 'sl:slc1', 'sl:slc2']);
  assert.strictEqual(L.find('retic:k1', 'plan'), 'plan:pk1');
  assert.strictEqual(L.find('sld:db1', 'plan', 'sld-plan'), 'plan:pdb1');
  assert.strictEqual(L.find('retic:k1', 'sld'), null);
});

await ok('name() reads a short name from each workspace', () => {
  assert.strictEqual(L.name('sld:tx1'), 'TX1');
  assert.strictEqual(L.name('plan:pk1'), 'PK1');
  assert.strictEqual(L.name('retic:k1'), 'K1');
  assert.strictEqual(L.name('retic:e1'), 'Erf 12');
  assert.strictEqual(L.name('sl:slp1'), 'SL-K1-01 · P01');
  assert.strictEqual(L.name('way:db1/w1'), 'DB1 way 1');
});

await ok('a link mark goes to the owner, carries where to come back to, and is escaped', () => {
  A.reticulation.kiosks[0].name = 'K<1>';
  const h = L.markHtml('retic:k1', 'plan:pk1', 'from "Demand"', 'x');
  assert.match(h, /data-link-go="retic:k1"/);
  assert.match(h, /data-link-back="plan:pk1"/);
  assert.match(h, /from &quot;Demand&quot;/);
  assert.ok(!/K<1>/.test(h));
  assert.strictEqual(L.markHtml('nonsense', null, 'x'), '');
  A.reticulation.kiosks[0].name = 'K1';
});

await ok('a link that is gone is not listed once the task ends', async () => {
  await tick();
  assert.strictEqual(L.find('plan:pk1', 'retic'), 'retic:k1');
  pm.elements.find(e => e.id === 'pk1').reticId = null;
  await tick();
  assert.strictEqual(L.find('plan:pk1', 'retic'), null);
});

console.log(`\n${n} passed`);
