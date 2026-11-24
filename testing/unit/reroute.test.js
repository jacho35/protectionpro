// Tests for the fixed solve behind Plan › Re-route from here (frontend/js/plan-reroute.js → plan-layout.js `fixedKiosks` / `fixedMhs`).
//   node testing/unit/reroute.test.js
const assert = require('assert');
const L = require('../../frontend/js/plan-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const F = require('./layout-fixture.js')();
const P = { route: 'blocks', kmode: 'opt', knet: true };

const r0 = L.solve(F, P);
// what Create puts on the plan: a kiosk / manhole at each one (junction nodes too), erf points at the markers
const kiosks = r0.kiosks, mhs = [...r0.fibre.inter, ...r0.fibre.mhs];
const fixed = () => {
  const fixAssign = {}, mhAssign = {}, markers = {};
  r0.erven.forEach(e => { if (e.kiosk) fixAssign[e.id] = kiosks.indexOf(e.kiosk); if (e.mh) mhAssign[e.id] = mhs.indexOf(e.mh); if (e.marker) markers[e.id] = e.marker.slice(); });
  return Object.assign({}, F, { fixedKiosks: true, kioskPins: kiosks.map(k => [k.x, k.y]), fixAssign, fixedMhs: true, mhPins: mhs.map(m => [m.x, m.y]), mhAssign, markers });
};

ok('fixed kiosks: the same kiosks, no new one, every erf on the kiosk it was on', () => {
  const r1 = L.solve(fixed(), P);
  assert.strictEqual(r1.kiosks.length, kiosks.filter(k => k.members.length).length);
  const near = k => kiosks.findIndex(q => Math.hypot(q.x - k.x, q.y - k.y) < 3);
  r1.kiosks.forEach(k => assert(near(k) >= 0, 'a kiosk that was not on the plan'));
  r1.erven.forEach(e => { const was = r0.erven.find(x => x.id === e.id); if (was.kiosk) assert.strictEqual(near(e.kiosk), kiosks.indexOf(was.kiosk), 'erf ' + e.id + ' moved kiosk'); });
});

ok('fixed manholes: every erf keeps its manhole and no manhole is added', () => {
  const r1 = L.solve(fixed(), P), all = [...r1.fibre.inter, ...r1.fibre.mhs];
  const near = m => mhs.findIndex(q => Math.hypot(q.x - m.x, q.y - m.y) < 3);
  r1.fibre.mhs.forEach(m => assert(near(m) >= 0, 'a manhole that was not on the plan'));
  assert(r1.fibre.mhs.length <= r0.fibre.mhs.length + 0, 'more manholes than before');
  r1.erven.forEach(e => { const was = r0.erven.find(x => x.id === e.id); if (was.mh) assert.strictEqual(e.mh && e.mh.pidx, mhs.indexOf(was.mh), 'erf ' + e.id + ' moved manhole'); });
  assert(all.length >= r1.fibre.mhs.length);
});

ok('a re-route lays services from each kiosk and ducts from each manhole', () => {
  const r1 = L.solve(fixed(), P);
  const served = r1.erven.filter(e => e.kiosk);
  assert(served.length && served.every(e => Array.isArray(e.route) && e.route.length >= 2));
  assert(r1.erven.filter(e => e.mh).every(e => Array.isArray(e.duct) && e.duct.length >= 2));
});

ok('without the flags nothing changes', () => {
  const a = L.solve(F, P), b = L.solve(Object.assign({}, F, { fixAssign: { x: 0 }, mhAssign: { x: 0 } }), P);
  assert.strictEqual(a.kiosks.length, b.kiosks.length); assert.strictEqual(a.fibre.mhs.length, b.fibre.mhs.length);
});
console.log(n + ' passed');
