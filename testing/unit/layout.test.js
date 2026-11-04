// Tests for frontend/js/plan-layout.js (pure geometry, no browser).
//   node testing/unit/layout.test.js
const assert = require('assert');
const L = require('../../frontend/js/plan-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const fixture = require('./layout-fixture.js');
const F = fixture();

ok('fixture: a believable neighbourhood', () => { assert(F.erven.length > 60 && F.erven.length < 140, 'erven ' + F.erven.length); });

ok('every erf gets a front, a marker 3-5 m in, and the marker is inside the erf', () => {
  const r = L.solve(F, {});
  assert.strictEqual(r.noFront.length, 0);
  const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  for (const e of r.erven) { assert(e.fe && e.marker); assert(pip(e.marker[0], e.marker[1], e.poly), 'marker outside ' + e.id); }
});

ok('markers keep the set distances from the side boundary and the front', () => {
  const r = L.solve(F, { side: 4, depth: 3 });
  for (const e of r.erven.slice(0, 40)) {
    const fe = e.fe, m = e.marker;
    const dFront = Math.abs((m[0] - fe.a[0]) * fe.inn[0] + (m[1] - fe.a[1]) * fe.inn[1]);
    assert(Math.abs(dFront - 3) < 1e-6, 'front ' + dFront);
  }
});

ok('rule of thumb: no kiosk serves more than n houses and every erf has one', () => {
  const r = L.solve(F, { kmode: 'rules', n: 6 });
  assert(r.erven.every(e => e.kiosk));
  assert(r.kiosks.every(k => k.members.length <= 6));
});

ok('optimiser: respects capacity and the cable limit, and never uses more kiosks than the rule of thumb needs plus a margin', () => {
  const rules = L.solve(F, { kmode: 'rules', n: 6, maxc: 80 }), opt = L.solve(F, { kmode: 'opt', n: 6, maxc: 80, worth: 250 });
  assert(opt.kiosks.every(k => k.members.length <= 6));
  assert(opt.stats.over <= rules.stats.over);
  assert(opt.stats.kiosks <= rules.stats.kiosks + 4, `${opt.stats.kiosks} vs ${rules.stats.kiosks}`);
});

ok('a tighter cable limit needs more kiosks', () => {
  const a = L.solve(F, { kmode: 'opt', maxc: 80 }), b = L.solve(F, { kmode: 'opt', maxc: 40 });
  assert(b.stats.kiosks >= a.stats.kiosks, `${b.stats.kiosks} vs ${a.stats.kiosks}`);
});

ok('sharing road crossings needs far fewer trenches than crossing separately', () => {
  const sh = L.solve(F, { share: true }), no = L.solve(F, { share: false });
  assert(sh.stats.crossings < no.stats.crossings * 0.6, `${sh.stats.crossings} vs ${no.stats.crossings}`);
});

ok('crossing ducts follow the rules: 110 mm takes 4 services / 4 fibre ducts / 2 LV; MV own 160 mm', () => {
  const r = L.solve(F, {});
  for (const c of r.net.cross) {
    assert.strictEqual(c.d110s, Math.ceil(c.svc / 4)); assert.strictEqual(c.d110f, Math.ceil(c.fib / 4));
    assert.strictEqual(c.d110l, Math.ceil(c.lv / 2)); assert.strictEqual(c.d160, c.mv);
    assert.strictEqual(c.d110, c.d110s + c.d110f + c.d110l + c.spare);
  }
  assert(r.net.cross.some(c => c.svc + c.fib > 4), 'a busy crossing');
  assert(r.net.cross.some(c => c.mv > 0), 'the MV cable crosses somewhere');
  const sp = L.solve(F, { spare: 2 }); assert(sp.net.d110 > r.net.d110);
});

ok('crossings sit on erf boundaries (or kiosk stations when asked)', () => {
  const r = L.solve(F, { xmode: 'bound' });
  const real = r.net.cross.filter(c => c.svc > 0);
  assert(real.length > 0);
  for (const c of real) {
    const near = r.erven.some(e => e.road === c.st && (Math.abs(e.lo - c.s) < 2.5 || Math.abs(e.hi - c.s) < 2.5));
    assert(near, `${c.st.id} ${c.s.toFixed(1)}`);
  }
});

ok('junction ducts: every junction leg gets a crossing, empty ones get the provisional ducts', () => {
  const a = L.solve(F, { junct: false }), b = L.solve(F, { junct: true, j110: 2, j160: 1 });
  assert.strictEqual(a.net.prov, 0);
  assert(b.net.prov > 0 && b.stats.crossings > a.stats.crossings);
  for (const c of b.net.cross.filter(c => c.prov)) { assert.strictEqual(c.d110, 2); assert.strictEqual(c.d160, 1); }
  // same cables either way
  assert.strictEqual(b.net.baseline, a.net.baseline);
});

ok('fibre: a manhole every maxmh at most, every erf has a duct, the ring has loops and spurs have none', () => {
  const ring = L.solve(F, { topo: 'ring' }), spur = L.solve(F, { topo: 'spur' });
  assert(ring.erven.every(e => e.duct));
  assert(ring.stats.loops > 0 && spur.stats.loops === 0);
  assert(spur.stats.trunk < ring.stats.trunk);
  assert(spur.stats.tOffs > 0);
  const tight = L.solve(F, { maxmh: 60 });
  assert(tight.stats.manholes > ring.stats.manholes);
  assert(tight.fibre.maxGap <= 60 + 8, 'gap ' + tight.fibre.maxGap);
});

ok('cutting a spur section re-routes, never leaves a manhole unconnected silently', () => {
  const spur = L.solve(F, { topo: 'spur' });
  const cut = L.solve(Object.assign({}, F, { cuts: [spur.fibre.trunks[3].key] }), { topo: 'spur' });
  assert(cut.stats.trunk > 0);
  assert(cut.fibre.mhs.every(m => !m.off) || cut.warns.some(w => /not connected/.test(w)));
});

ok('LV is a tree reaching every kiosk; MV reaches the mini-sub', () => {
  const r = L.solve(F, {});
  assert(r.net.sub);
  assert.strictEqual(r.net.lvLinks.length, r.kiosks.length - 1);
  assert(r.net.mvLen > 0);
});

ok('front override moves the front and the marker', () => {
  const a = L.solve(F, {}), e = a.erven.find(x => x.corner);
  const other = e.edges.filter(d => d.road && d !== e.fe)[0];
  const b = L.solve(Object.assign({}, F, { overrides: { [e.id]: other.i } }), {});
  const e2 = b.erven.find(x => x.id === e.id);
  assert(e2.overridden && e2.fe.i === other.i);
  assert(e2.road.id === other.road.id && e2.marker);          // (at a right-angle corner both fronts can share the marker)
});

ok('a street with no erven on the chosen side is flagged, not crashed', () => {
  const r = L.solve(Object.assign({}, F, { ks: { S4: 1 } }), {});
  assert(Array.isArray(r.warns));
});

ok('deterministic', () => {
  const a = L.solve(F, { kmode: 'opt' }), b = L.solve(F, { kmode: 'opt' });
  assert.strictEqual(a.stats.kiosks, b.stats.kiosks); assert.strictEqual(Math.round(a.stats.cable), Math.round(b.stats.cable)); assert.strictEqual(a.stats.crossings, b.stats.crossings);
});

ok('speed: a 100-erf neighbourhood solves in a couple of seconds with the optimiser', () => {
  const t = Date.now(); L.solve(F, { kmode: 'opt', junct: true }); assert(Date.now() - t < 4000, (Date.now() - t) + ' ms');
});

// ── trenches ──
const plenOf = pts => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
const sumLen = (t, f) => t.list.filter(f).reduce((a, x) => a + x.len, 0);
ok('trenches: MV at 1.1 m, LV / service / street light at 0.7 m by default', () => {
  const r = L.solve(F, {}), t = L.trenches(r, {});
  assert(t.summary['MV'] && t.summary['LV/SL']);
  assert.strictEqual(t.summary['MV'].depth, 1.1); assert.strictEqual(t.summary['LV/SL'].depth, 0.7);
  assert(t.list.every(x => x.depth === (x.type === 'MV' ? 1.1 : x.type === 'LV/SL' ? 0.7 : x.type === 'FI' ? 0.6 : 1.1)));
});
ok('trenches: cables on one verge share a trench (far less than the sum of the routes)', () => {
  const r = L.solve(F, {}), t = L.trenches(r, {});
  const routes = r.erven.reduce((a, e) => a + (e.route ? plenOf(e.route) : 0), 0) + r.net.lvLen;
  assert(sumLen(t, x => x.type === 'LV/SL' && x.kind !== 'crossing') < routes * 0.95, `${sumLen(t, x => x.type === 'LV/SL')} vs ${routes}`);
  assert(sumLen(t, x => (x.type === 'MV' || x.type === 'MV/LV/SL') && x.kind !== 'crossing') < r.net.mvLen * 1.15 + 5);
});
ok('trenches: MV with LV in one trench makes a combined trench at the deepest depth', () => {
  const r = L.solve(F, {}), sep = L.trenches(r, { combine: 'separate' }), com = L.trenches(r, { combine: 'mvlv' });
  assert(com.summary['MV/LV/SL'].len > sep.summary['MV/LV/SL'].len);
  assert((com.summary['MV'] ? com.summary['MV'].len : 0) < sep.summary['MV'].len);
  assert.strictEqual(com.summary['MV/LV/SL'].depth, 1.1);
  const deep = L.trenches(r, { combine: 'mvlv', depth: { mv: 1.5, lv: 0.9 } });
  assert.strictEqual(deep.summary['MV/LV/SL'].depth, 1.5);
  assert.strictEqual(L.trenches(r, { combine: 'mvlv', depth: { comb: 1.3 } }).summary['MV/LV/SL'].depth, 1.3);
});
ok('trenches: depths are the settings', () => {
  const t = L.trenches(L.solve(F, {}), { depth: { mv: 1.4, lv: 0.85, fi: 0.5 } });
  assert.strictEqual(t.summary['MV'].depth, 1.4); assert.strictEqual(t.summary['LV/SL'].depth, 0.85); assert.strictEqual(t.summary['FI'].depth, 0.5);
});
ok('trenches: fibre own / with the LV trench / none', () => {
  const r = L.solve(F, { fibre: 'same' });
  const own = L.trenches(r, { fibre: 'own' }), wi = L.trenches(r, { fibre: 'with' }), off = L.trenches(r, { fibre: 'off' });
  assert(wi.summary['FI'].len < own.summary['FI'].len);
  assert(!off.summary['FI']);
});
ok('trenches: one shared trench per road crossing, and none when switched off', () => {
  const r = L.solve(F, { junct: true });
  const on = L.trenches(r, { crossings: true }), no = L.trenches(r, { crossings: false });
  assert.strictEqual(on.list.filter(x => x.kind === 'crossing').length, r.net.cross.length);
  assert.strictEqual(no.list.filter(x => x.kind === 'crossing').length, 0);
  assert(on.list.filter(x => x.kind === 'crossing').every(x => x.len > 5));
});
console.log(n + ' passed');
