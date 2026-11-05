// Tests for frontend/js/plan-sections.js and its use by plan-layout.js (pure, no browser).
//   node testing/unit/sections.test.js
const assert = require('assert');
const S = require('../../frontend/js/plan-sections.js');
const L = require('../../frontend/js/plan-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const F = require('./layout-fixture.js')();

ok('a made section has every item with its default; values snap to 10 mm and clamp', () => {
  const s = S.make('a', 'Local street');
  assert.strictEqual(s.items.kiosk.off, 1.5); assert.strictEqual(s.items.mh.len, 1.2);
  const t = S.normalize({ id: 'x', items: { lv: { off: 0.9049, depth: 99 }, kiosk: { off: -3 } } });
  assert.strictEqual(t.items.lv.off, 0.9); assert.strictEqual(t.items.lv.depth, 3); assert.strictEqual(t.items.kiosk.off, 0);
  assert.strictEqual(S.snap(1.234), 1.23); assert.strictEqual(S.snap(1.235 + 1e-9), 1.24);
});
ok('state: always one section, a default that exists, lines that point at a section', () => {
  const e = S.state(null); assert.strictEqual(e.list.length, 1); assert.strictEqual(e.def, e.list[0].id);
  const r = S.state({ list: [{ id: 'a' }, { id: 'a' }], def: 'zz', lines: [{ streetId: 's1', s0: 0, s1: 10, sec: 'a' }, { streetId: 's1', s0: 0, s1: 10, sec: 'gone' }] });
  assert.notStrictEqual(r.list[0].id, r.list[1].id); assert.strictEqual(r.def, r.list[0].id); assert.strictEqual(r.lines.length, 1);
});
ok('a polyline drawn along a street gives that street the stretch it covers, even when it is rough', () => {
  const streets = [{ id: 's1', w: 12, pts: [[0, 0], [100, 0]] }, { id: 's2', w: 12, pts: [[100, 0], [100, 80]] }];
  const l = S.linesFromPolyline([[20, 2], [60, -3], [95, 1]], streets, 'a');
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].streetId, 's1'); assert(l[0].s0 <= 21 && l[0].s1 >= 94, JSON.stringify(l));
  const bend = S.linesFromPolyline([[60, 1], [100, 1], [100, 40]], streets, 'a');
  assert.deepStrictEqual(bend.map(x => x.streetId).sort(), ['s1', 's2']);
});
ok('section lookup: the last line wins, the default fills the rest; overlaps are flagged', () => {
  const st = S.state({ list: [{ id: 'a' }, { id: 'b' }], def: 'a', lines: [{ streetId: 's1', s0: 0, s1: 50, sec: 'b' }, { streetId: 's1', s0: 40, s1: 80, sec: 'a' }] });
  assert.strictEqual(S.at(st, 's1', 10).id, 'b'); assert.strictEqual(S.at(st, 's1', 45).id, 'a'); assert.strictEqual(S.at(st, 's1', 200).id, 'a'); assert.strictEqual(S.at(st, 's2', 10).id, 'a');
  assert.strictEqual(S.overlaps(st.lines).length, 1);
});
ok('checks: a gap that is too small is reported', () => {
  const s = S.make('a', 'x'); assert(S.checks(s).every(c => c.sev !== 'warn'));
  s.items.fi.off = s.items.lv.off + 0.4; assert(S.checks(s).some(c => /LV to fibre/.test(c.text)));
});

// ── the layout engine reads the sections ──
const dist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
const distErf = (p, er) => { let m = 1e9; for (const e of er) for (let i = 0; i < e.poly.length; i++) m = Math.min(m, dist(p, e.poly[i], e.poly[(i + 1) % e.poly.length])); return m; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const verges = r => { const d = []; for (const e of r.erven) if (e.route && e.route.length > 3) for (const p of e.route.slice(1, -1)) d.push(distErf(p, r.erven)); return d.filter(x => x < 6); };
const withSec = over => Object.assign({}, F, { sections: S.state({ list: [S.make('a', 'Local', over)], def: 'a' }) });

ok('engine: the LV offset in the section sets how far the corridor is from the boundary', () => {
  const near = L.solve(withSec({ items: { lv: { off: 0.8 } } }), {}), far = L.solve(withSec({ items: { lv: { off: 2.4 } } }), {});
  assert(mean(verges(far)) - mean(verges(near)) > 0.8, `${mean(verges(near)).toFixed(2)} → ${mean(verges(far)).toFixed(2)}`);
});
ok('engine: a section can use a different offset on one street only (section line)', () => {
  const sid = F.streets[0].id;
  const G = Object.assign({}, F, { sections: S.state({ list: [S.make('a', 'Local', { items: { lv: { off: 1 } } }), S.make('b', 'Wide', { items: { lv: { off: 3 } } })], def: 'a', lines: [{ streetId: sid, s0: 0, s1: 1e4, sec: 'b' }] }) });
  const r = L.solve(G, {}), onS = [], other = [];
  for (const e of r.erven) if (e.route && e.route.length > 3) for (const p of e.route.slice(1, -1)) { const d = distErf(p, r.erven); if (d < 6) (e.road.id === sid ? onS : other).push(d); }
  assert(onS.length && other.length && mean(onS) - mean(other) > 1, `${mean(onS).toFixed(2)} v ${mean(other).toFixed(2)}`);
});
ok('engine: trench depth comes from the section, per cable class', () => {
  const r = L.solve(withSec({ items: { lv: { depth: 0.9 }, svc: { depth: 0.5 }, fi: { depth: 0.45 }, mv: { depth: 1.3 } } }), {});
  const t = L.trenches(r, {});
  const by = {}; t.list.forEach(x => { (by[x.type] = by[x.type] || new Set()).add(x.depth); });
  assert([...by['LV/SL']].every(d => d === 0.9), JSON.stringify([...by['LV/SL']]));
  if (by.FI) assert([...by.FI].every(d => d === 0.45));
});
ok('engine: kiosks and manholes carry the section\'s sizes; the section is on the result', () => {
  const r = L.solve(withSec({ items: { kiosk: { len: 1.8, depth: 1.1 }, mh: { len: 1.5 } } }), {});
  assert(r.kiosks.length && r.kiosks.every(k => k.dim && k.dim.len === 1.8 && k.dim.depth === 1.1));
  assert(r.fibre.mhs.length && r.fibre.mhs.every(m => m.dim && m.dim.len === 1.5)); assert(r.sections && Array.isArray(r.secChecks));
});
ok('engine: the kiosk stands where the section says (near face + half its depth from the boundary)', () => {
  const r = L.solve(withSec({ items: { kiosk: { off: 2.5, depth: 1 } } }), {});
  const d = r.kiosks.map(k => distErf([k.x, k.y], r.erven)).filter(x => x < 6);
  assert(Math.abs(mean(d) - 3) < 0.6, 'mean ' + mean(d).toFixed(2));
});
ok('engine: no sections = the single kd as before', () => {
  const a = L.solve(F, {}), b = L.solve(Object.assign({}, F, { sections: { list: [], def: null, lines: [] } }), {});
  assert.strictEqual(a.stats.cable, b.stats.cable);
});
ok('engine: kiosks too close for their length are flagged', () => {
  const G = withSec({}); G.sections.list[0].items.kiosk.len = 70;          // a hand-made value, beyond what the editor allows
  const r = L.solve(G, {});
  assert(r.secChecks.some(c => /kiosks .* apart/.test(c.text)), JSON.stringify(r.secChecks.slice(0, 3)));
});
console.log(n + ' passed');
