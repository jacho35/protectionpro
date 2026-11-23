// Network overview (frontend/js/retic-diagram.js + fibre-diagram.js): the pure tree builders —
// LV strings from the kiosk tree, the Strings view's folded tree, street-light circuits under their
// source, verdicts, and the fibre model from plan elements and routes.
//   node testing/unit/netoverview.test.js
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../../frontend/js', f), 'utf8');
const ctx = {
  console, escHtml: s => String(s),
  AppState: { reticulation: { streetLighting: { circuits: [] } }, planMarkup: null },
  Retic: {
    minisubs: [], kiosks: [], settings: { maxFeederVD: 5 },
    _rootOf() { return 'ms1'; },
    _cumulativeFeederVD(id) { return ({ k1: 1.2, k2: 4.6, k3: 5.4 })[id] ?? null; },
  },
  CableLib: { byName: (n) => ({ '185 Al': { size_mm2: 185 }, '120 Al': { size_mm2: 120 }, '95 Al': { size_mm2: 95 } })[n] || null },
};
vm.createContext(ctx);
vm.runInContext(read('retic-diagram.js').replace(/^const ReticDiagram = /m, 'var ReticDiagram = '), ctx);
vm.runInContext(read('fibre-diagram.js').replace(/^const FibreDiagram = /m, 'var FibreDiagram = ').replace(/if \(typeof module[^\n]*\n/, ''), ctx);
const RD = ctx.ReticDiagram, FD = ctx.FibreDiagram;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

// MS-1 feeds k1 → k2 → k3 (one string, tapered 185 → 120 → 95) and k4 (its own string);
// SL-A is fed from k2, SL-B straight from the minisub.
const erf = (len) => ({ length: len });
ctx.Retic.minisubs = [{ id: 'ms1', name: 'MS-1' }];
ctx.Retic.kiosks = [
  { id: 'k1', name: 'K1', fedFrom: 'ms1', feederCable: '185 Al', erfs: [erf(10), erf(12)] },
  { id: 'k2', name: 'K2', fedFrom: 'k1', feederCable: '120 Al', erfs: [erf(10)] },
  { id: 'k3', name: 'K3', fedFrom: 'k2', feederCable: '95 Al', erfs: [erf(10), erf(0)] },
  { id: 'k4', name: 'K4', fedFrom: 'ms1', feederCable: '95 Al', erfs: [erf(8)] },
];
ctx.AppState.reticulation.streetLighting.circuits = [
  { id: 'slA', name: 'SL-A', source: { kind: 'kiosk', id: 'k2' }, poles: [{}, {}] },
  { id: 'slB', name: 'SL-B', source: { kind: 'minisub', id: 'ms1' }, poles: [{}] },
  { id: 'slX', name: 'SL-X', source: { kind: 'kiosk', id: 'gone' }, poles: [] },
];

ok('street-light circuits hang off their kiosk / minisub; a missing source is left out', () => {
  const t = RD._tree();
  assert.deepStrictEqual([...t.children.k2], ['k3', 'sl:slA']);
  assert.ok(t.children.ms1.includes('sl:slB'));
  assert.ok(!t.slById['sl:slX']);
});

ok('strings: one per kiosk fed from the minisub, its kiosks, erven (active only), street lights, taper', () => {
  const t = RD._tree(), s = RD.strings(t);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s[0])), { id: 'str:k1', ms: 'ms1', head: 'k1', n: 1, kiosks: ['k1', 'k2', 'k3'], sl: ['sl:slA'], erven: 4, tapered: true });
  assert.strictEqual(s[1].head, 'k4'); assert.strictEqual(s[1].n, 2); assert.strictEqual(s[1].tapered, false);
});

ok('a cable that steps up down the string is not "tapered"', () => {
  const t = RD._tree(), s = RD.strings(t, (nm) => ({ '185 Al': 95, '120 Al': 120, '95 Al': 185 })[nm]);
  assert.strictEqual(s[0].tapered, false);
});

ok('Strings view folds each string into one node, its street lights under it, kiosks unreachable', () => {
  const t = RD._tree(), s = RD.strings(t), st = RD._stringTree(t, s);
  assert.deepStrictEqual([...st.children.ms1], ['str:k1', 'str:k4', 'sl:slB']);
  assert.deepStrictEqual([...st.children['str:k1']], ['sl:slA']);
  const L = RD._layout(st);
  assert.ok(L.pos['str:k1'] && L.pos['sl:slA'] && !L.pos.k2);
  assert.deepStrictEqual([...t.children.ms1].slice(0, 2), ['k1', 'k4']);   // the original tree is untouched
});

ok('Kiosks view leaves room above each string head for its band header', () => {
  const t = RD._tree(), s = RD.strings(t);
  const plain = RD._layout(t);
  t.heads = new Set(s.map(x => x.head));
  const banded = RD._layout(t);
  assert.ok(banded.pos.k4.y - banded.pos.k1.y > plain.pos.k4.y - plain.pos.k1.y);
  assert.ok(banded.pos.k1.y - RD.PAD >= RD.BAND_HEAD - 1);
});

ok('kiosk verdict: over the limit fails, within 10 % warns, an earth fault that does not clear fails', () => {
  assert.strictEqual(RD._kioskVerdict('k1', {}, 5, null), 'ok');
  assert.strictEqual(RD._kioskVerdict('k2', {}, 5, null), 'warn');
  assert.strictEqual(RD._kioskVerdict('k3', {}, 5, null), 'fail');
  assert.strictEqual(RD._kioskVerdict('k1', {}, 5, { k: { k1: { status: 'fail' } } }), 'fail');
  assert.strictEqual(RD._kioskVerdict('k4', {}, 5, null), null);
  assert.strictEqual(RD._worst(['ok', null, 'warn']), 'warn');
});

ok('clicks go to the Demand row / street-light circuit / plan RMU', () => {
  const t = RD._tree();
  assert.strictEqual(RD._goOf('k2', t), 'retic:k2');
  assert.strictEqual(RD._goOf('str:k1', t), 'retic:k1');
  assert.strictEqual(RD._goOf('sl:slA', t), 'sl:slA');
  assert.strictEqual(RD._goOf('rmu:pm7', t), 'plan:pm7');
});

// ── Fibre ──
// MH1 (entry) → MH2 → MH3, MH2 → MH4 (a T-off), MH3 ↔ MH4 closes a ring; MH5 has no trunk.
// Scale 1 m / px; a street runs north–south at x = 150 (crossed by the MH2 → MH3 trunk and one duct).
const P = (x, y) => ({ x, y });
const els = [
  { id: 'm1', type: 'manhole', name: 'MH1', x: 0, y: 0 }, { id: 'm2', type: 'manhole', name: 'MH2', x: 100, y: 0 },
  { id: 'm3', type: 'manhole', name: 'MH3', x: 200, y: 0 }, { id: 'm4', type: 'manhole', name: 'MH4', x: 100, y: 100 },
  { id: 'm5', type: 'manhole', name: 'MH5', x: 500, y: 500 },
  { id: 'e1', type: 'erf', props: {} }, { id: 'e2', type: 'erf', props: {} }, { id: 'e3', type: 'erf', props: {} },
  { id: 'e4', type: 'erf', props: { unserviced: true } },
];
const routes = [
  { id: 't1', type: 'fibreBB', fromId: 'm1', toId: 'm2', points: [P(0, 0), P(100, 0)] },
  { id: 't2', type: 'fibreBB', fromId: 'm2', toId: 'm3', points: [P(100, 0), P(200, 0)] },
  { id: 't3', type: 'fibreBB', fromId: 'm2', toId: 'm4', points: [P(100, 0), P(100, 100)] },
  { id: 't4', type: 'fibreBB', fromId: 'm3', toId: 'm4', points: [P(200, 0), P(200, 100), P(100, 100)] },
  { id: 'd1', type: 'fibreErf', fromId: 'm2', toId: 'e1', points: [P(100, 0), P(100, -20)] },
  { id: 'd2', type: 'fibreErf', fromId: 'm2', toId: 'e2', points: [P(100, 0), P(160, -10)] },
  { id: 'd3', type: 'fibreErf', fromId: 'e3', toId: 'm3', points: [P(200, 0), P(220, 0)] },
  { id: 's1', type: 'street', points: [P(150, -50), P(150, 50)] },
];

ok('fibre model: entry, tree, ring tie, ducts, crossings, totals', () => {
  const M = FD.model({ elements: els, routes, factor: 1, entry: null, maxmh: 0 });
  assert.strictEqual(M.entryId, 'm1');
  assert.deepStrictEqual([...M.children.m1], ['m2']);
  assert.deepStrictEqual([...M.children.m2].sort(), ['m3', 'm4']);
  assert.strictEqual(M.ring.length, 1);
  assert.strictEqual(M.mh.m2.ducts, 2); assert.strictEqual(M.mh.m3.ducts, 1);
  assert.strictEqual(Math.round(M.mh.m2.ductM), 20 + Math.round(Math.hypot(60, 10)));
  assert.strictEqual(M.mh.m2.xings, 1);   // its duct d2 crosses the street
  assert.strictEqual(M.mh.m3.xings, 1);   // the trunk into it crosses the street
  assert.strictEqual(M.totals.crossings, 2);
  assert.strictEqual(M.totals.trunkM, 500);
  assert.strictEqual(M.totals.served, 3); assert.strictEqual(M.totals.erven, 3);   // the unserviced erf is not counted
  assert.ok(M.mh.m5.unreached && M.roots.includes('m5'));
  assert.strictEqual(M.totals.unreached, 1);
});

ok('fibre entry: the manhole nearest the Auto layout entry point; maxmh flags long trunks', () => {
  const M = FD.model({ elements: els, routes, factor: 1, entry: { x: 190, y: 10 }, maxmh: 150 });
  assert.strictEqual(M.entryId, 'm3');
  assert.strictEqual(M.totals.over, 1);   // the 200 m ring section
  const M2 = FD.model({ elements: els, routes, factor: 1, entry: null, maxmh: 90 });
  assert.ok(M2.mh.m2.over && M2.mh.m3.over && M2.mh.m4.over);
});

ok('no manholes → nothing to draw; no trunks → every manhole its own root, none flagged', () => {
  assert.strictEqual(FD.model({ elements: [{ id: 'e', type: 'erf' }], routes: [] }), null);
  const M = FD.model({ elements: els.filter(e => e.type === 'manhole'), routes: [], factor: 1 });
  assert.strictEqual(M.roots.length, 5);
  assert.ok(Object.values(M.mh).every(m => !m.unreached));
});

ok('segment crossing ignores touching ends and parallel lines', () => {
  assert.strictEqual(FD._segX(P(0, 0), P(10, 0), P(5, -5), P(5, 5)), true);
  assert.strictEqual(FD._segX(P(0, 0), P(10, 0), P(10, 0), P(10, 5)), false);
  assert.strictEqual(FD._segX(P(0, 0), P(10, 0), P(0, 1), P(10, 1)), false);
});

console.log(`\n${n} passed`);
