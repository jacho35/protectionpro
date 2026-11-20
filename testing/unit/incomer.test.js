// Kiosk incomers in Demand: the app's own constants + Retic in a node sandbox, results given by hand (no network).
//   node testing/unit/incomer.test.js
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const JS = path.resolve(__dirname, '../../frontend/js') + '/';
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

function sandbox() {
  const el = () => new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : el(), set: () => true, apply: () => el() });
  const ctx = { console, Map, Set, Math, JSON, Number, parseFloat, isFinite, String, Array, Object, Promise, setTimeout, clearTimeout, Date,
    localStorage: { getItem: () => null, setItem() {} }, escHtml: x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    CSS: { escape: x => String(x) }, document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), body: el() }, navigator: {} };
  ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  const load = f => vm.runInContext(fs.readFileSync(JS + f, 'utf8').replace(/^const (\w+) = /gm, 'var $1 = '), ctx, { filename: f });
  let seq = 1;
  ctx.AppState = { reticulation: { settings: {}, minisubs: [{ id: 'ms1', name: 'MS1' }], kiosks: [], nextId: 1 }, reticResults: null,
    reticGenKioskId: () => 'k' + (seq++), reticGenErfId: () => 'e' + (seq++) };
  for (const f of ['constants.js', 'cablelib.js', 'retic.js']) load(f);
  return ctx;
}
const R = (ctx) => ctx.Retic;
// a head kiosk K1 (string breaker 250 A) feeding K2; K2 has three erven
function net(ctx, k2) {
  const k1 = Object.assign(R(ctx)._newKiosk('ms1'), { id: 'K1', name: 'K1', protection: 'cb:mccb_250a', incomer: '' });
  const k2o = Object.assign(R(ctx)._newKiosk('K1'), { id: 'K2', name: 'K2', fedFrom: 'K1',
    erfs: [{ id: 'e1', erfNumber: '1' }, { id: 'e2', erfNumber: '2', protection: 'cb:mcb_c63' }, { id: 'e3', erfNumber: '3' }] }, k2);
  ctx.AppState.reticulation.kiosks = [k1, k2o];
  return { k1, k2: k2o };
}
const res = (amps, ik3) => ({ kiosks: [{ kioskId: 'K2', worstPhaseA: amps, currentA: amps }], earth: ik3 ? { kiosks: [{ kioskId: 'K2', ik3A: ik3, erfs: [] }] } : null });

ok('a new kiosk is on Auto; a kiosk saved before has none and falls back to the string breaker as before', () => {
  const ctx = sandbox();
  assert.strictEqual(R(ctx)._newKiosk('ms1').incomer, 'auto');
  const { k2 } = net(ctx, { incomer: undefined });
  assert.strictEqual(R(ctx)._incomerDevice(k2, res(100)), null);
  assert.strictEqual(R(ctx)._erfDevice(k2, k2.erfs[0], res(100)).source, 'string');
  assert.strictEqual(R(ctx)._incomerChecks(k2, res(100)).length, 0);
});

ok('Auto = the smallest MCCB at or above 1.2 × the kiosk’s own current; the factor is a setting', () => {
  const ctx = sandbox();
  const { k2 } = net(ctx, { incomer: 'auto' });
  assert.strictEqual(R(ctx)._incomerDevice(k2, res(118)).name, 'MCCB 160A');     // 141.6 A
  assert.strictEqual(R(ctx)._incomerDevice(k2, res(130)).name, 'MCCB 160A');     // 156 A
  assert.strictEqual(R(ctx)._incomerDevice(k2, res(140)).name, 'MCCB 200A');     // 168 A
  ctx.AppState.reticulation.settings.incomerFactor = 1.5;
  assert.strictEqual(R(ctx)._incomerDevice(k2, res(118)).name, 'MCCB 200A');     // 177 A
  assert.strictEqual(R(ctx)._incomerDevice(k2, null), null, 'no demand yet');
});

ok('a way with no device of its own: erf → kiosk default → incomer → string breaker', () => {
  const ctx = sandbox();
  const { k2 } = net(ctx, { incomer: 'cb:mccb_160a' });
  const r = res(100);
  assert.strictEqual(R(ctx)._erfDevice(k2, k2.erfs[1], r).source, 'erf');
  assert.strictEqual(R(ctx)._erfDevice(k2, k2.erfs[0], r).source, 'incomer');
  assert.strictEqual(R(ctx)._erfDevice(k2, k2.erfs[0], r).device.name, 'MCCB 160A');
  k2.outgoingProtection = 'cb:mccb_80a';
  assert.strictEqual(R(ctx)._erfDevice(k2, k2.erfs[0], r).source, 'kiosk');
  ctx.AppState.reticResults = r;
  const p = R(ctx)._earthPayload();
  const pk = p.kiosks.find(k => k.id === 'K2');
  assert.strictEqual(pk.device, null, 'the incomer is not a string breaker: the feeders stay on the head');
  k2.outgoingProtection = '';
  const pk2 = R(ctx)._earthPayload().kiosks.find(k => k.id === 'K2');
  assert.deepStrictEqual(pk2.erfs.map(e => e.deviceSource), ['incomer', 'erf', 'incomer']);
});

ok('load check: an incomer below the kiosk’s current fails and offers the size that fits', () => {
  const ctx = sandbox();
  const { k2 } = net(ctx, { incomer: 'cb:mccb_100a' });
  const c = R(ctx)._incomerChecks(k2, res(131));
  const load = c.find(x => x.id === 'load');
  assert(load && load.sev === 'fail');
  assert.strictEqual(load.fix.protection, 'cb:mccb_160a');                        // 157 A
  assert(!R(ctx)._incomerChecks(k2, res(90)).some(x => x.id === 'load'));
});

ok('discrimination: checked only once the fault level is known; a close pair overlaps, a wide one at low current does not', () => {
  const ctx = sandbox();
  const { k2 } = net(ctx, { incomer: 'cb:mccb_200a' });
  assert(!R(ctx)._incomerChecks(k2, res(100)).some(x => x.sev === 'warn'), 'no earth result, no fault level');
  const hi = R(ctx)._incomerChecks(k2, res(100, 8000));
  const up = hi.find(x => x.id === 'up');
  assert(up && up.sev === 'warn' && up.curves === 'K1', 'MCCB 200 A under MCCB 250 A at 8 kA');
  const s = R(ctx)._selectivity(R(ctx)._protectionDevice({ protection: 'cb:mccb_250a' }), R(ctx)._protectionDevice({ protection: 'cb:mccb_200a' }), 8000);
  assert(!s.ok && s.limitA > 200 && s.limitA < 8000);
  const lo = R(ctx)._selectivity(R(ctx)._protectionDevice({ protection: 'cb:mccb_250a' }), R(ctx)._protectionDevice({ protection: 'cb:mcb_c20' }), 150);
  assert(lo.ok, 'MCB 20 A under MCCB 250 A up to 150 A');
});

console.log(`${n} passed`);
