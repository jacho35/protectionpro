// The plan's DXF layers and layout sheets (PLAN_DXF_LAYERS in plan-defs.js, PlanDXF in plan-dxf.js): every plan type has a
// layer row, names and sheet ids are valid, the sheets a plan gets, and whether it fits the paper at a scale.
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const js = f => fs.readFileSync(path.join(__dirname, '../../frontend/js', f), 'utf8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(js('plan-defs.js') + '\n' + js('plan-dxf.js')
  + '\n;globalThis.P = PLAN_DEFS; globalThis.L = PLAN_DXF_LAYERS; globalThis.S = PLAN_DXF_SHEETS; globalThis.D = PlanDXF;', ctx);
const { P, L, S, D } = ctx;
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);   // vm arrays are another realm's
const ids = new Set(S.map(s => s.id));

// every element / route type has its own row (no palette-group fallback), and no row is for a type that is gone
for (const t of Object.keys(P.elements)) assert(L.elements[t], 'no DXF layer for element ' + t);
for (const t of Object.keys(P.routes)) assert(L.routes[t], 'no DXF layer for route ' + t);
for (const t of Object.keys(L.elements)) assert(P.elements[t], 'stale element row ' + t);
for (const t of Object.keys(L.routes)) assert(P.routes[t], 'stale route row ' + t);
for (const g of ['elements', 'routes', 'fixed']) {
  for (const [t, [name, sh]] of Object.entries(L[g])) {
    assert(/^EL_[A-Z0-9_]+$/.test(name), `${t}: layer ${name}`);
    assert(sh === 'all' || (Array.isArray(sh) && sh.length && sh.every(x => ids.has(x))), `${t}: sheets ${sh}`);
  }
}
// a type with no row still gets a layer, on every sheet
same(L.of('element', 'nope', { group: 'Small Power' }), ['EL_SMALL_POWER', 'all']);
same(L.of('route', 'nope'), ['RT_NOPE', 'all']);

// sheets: only the ones something is on, in the table's order; streets / rooms / text alone give one 'Plan' sheet
const pm = (o) => Object.assign({ elements: [], routes: [], trenches: [], rooms: [], measurements: [], crossings: [], texts: [] }, o);
const names = (m) => D._sheets(m).map(s => s.id);
same(names(pm({ elements: [{ type: 'kiosk', x: 0, y: 0 }], routes: [{ type: 'fibreBB', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] })), ['MV', 'LV', 'FIBRE']);
same(names(pm({ elements: [{ type: 'pole', x: 0, y: 0 }] })), ['SL']);
same(names(pm({ routes: [{ type: 'street', points: [{ x: 0, y: 0 }, { x: 9, y: 0 }] }] })), ['PLAN']);
same(names(pm({ trenches: [{ points: [] }] })), ['MV', 'LV', 'SL', 'FIBRE']);
same(names(pm({ elements: [{ type: 'bd_socket', x: 0, y: 0 }, { type: 'bd_smoke', x: 0, y: 0 }, { type: 'bd_light', x: 0, y: 0 }] })),
  ['LIGHTING', 'POWER', 'FIRE']);

// extents in export metres (y flipped) and the fit on paper: A1 less 10 mm margins = 821 × 574 mm
const ext = D._extents(pm({ elements: [{ type: 'kiosk', x: 0, y: 0 }, { type: 'kiosk', x: 8000, y: 2000 }] }), 0.05);
same(ext, [0, -100, 400, 0]);
assert.strictEqual(D._extents(pm({}), 0.05), null);
let f = D._fit(ext, 'A1', 500);              // 400 m at 1:500 = 800 mm ≤ 821; 100 m = 200 mm
assert(f.ok && f.need === 500);
f = D._fit(ext, 'A3', 500);                  // A3: 400 mm usable → needs 1:1000 (400 mm)
assert(!f.ok && f.need === 1000);
assert(D._fit(null, 'A3', 100).ok);

console.log('plandxf: ok');
