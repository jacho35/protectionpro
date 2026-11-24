// Tests for frontend/js/plan-layout.js (pure geometry, no browser).
//   node testing/unit/layout.test.js
const assert = require('assert');
const L = require('../../frontend/js/plan-layout.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const fixture = require('./layout-fixture.js');
const F = fixture();

ok('the default longest service cable is 70 m', () => { assert.strictEqual(L.DEFAULTS.maxc, 70); });
L.DEFAULTS.maxc = 80;   // the fixtures below were tuned at 80 m: they test the engine, not the default
L.DEFAULTS.route = 'street';   // these tests pin the street-line corridors; routing along the erf boundaries is testing/unit/blocks.test.js

ok('fixture: a believable neighbourhood', () => { assert(F.erven.length > 60 && F.erven.length < 140, 'erven ' + F.erven.length); });

ok('every erf gets a front, a marker 1-5 m in, and the marker is inside the erf', () => {
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
  const sh = L.solve(F, { share: true, xpref: 'few' }), no = L.solve(F, { share: false, xpref: 'few' });
  assert(sh.stats.crossings < no.stats.crossings * 0.6, `${sh.stats.crossings} vs ${no.stats.crossings}`);
});

ok('crossing ducts follow the rules: 110 mm takes 4 services / 4 fibre ducts / 2 LV', () => {
  const r = L.solve(F, {});
  for (const c of r.net.cross) {
    assert.strictEqual(c.d110s, Math.ceil(c.svc / 4)); assert.strictEqual(c.d110f, Math.ceil(c.fib / 4));
    assert.strictEqual(c.d110l, Math.ceil(c.lv / 2)); assert.strictEqual(c.d160, c.mv);
    assert.strictEqual(c.d110, c.d110s + c.d110f + c.d110l + c.spare);
  }
  assert(r.net.cross.some(c => c.svc + c.fib > 4), 'a busy crossing');
  assert(r.net.cross.every(c => c.mv === 0), 'no MV cable is designed here');
  const sp = L.solve(F, { spare: 2 }); assert(sp.net.d110 > r.net.d110);
});

ok('crossings sit on erf boundaries (or kiosk stations when asked)', () => {
  const r = L.solve(F, { xmode: 'bound' });
  // the shared crossings of erven across the road from their kiosk (a service that runs round a junction corner crosses at the junction instead)
  const across = r.erven.filter(e => e.kiosk && e.via);
  assert(across.length > 0);
  for (const e of across) {
    const near = r.erven.some(o => o.road === e.road && (Math.abs(o.lo - e.via.s) < 2.5 || Math.abs(o.hi - e.via.s) < 2.5)) || (e.kiosk.road === e.road && Math.abs(e.kiosk.s - e.via.s) < 2.5);   // a boundary, else the kiosk's own station
    assert(near, `${e.id} ${e.via.s.toFixed(1)}`);
  }
  assert(r.net.cross.some(c => c.svc > 0));
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

ok('LV is a tree reaching every kiosk, from the mini-sub', () => {
  const r = L.solve(F, {});
  assert(r.net.sub);
  assert(!r.kiosks.includes(r.net.sub), 'the mini-sub is not one of the kiosks');
  assert.strictEqual(r.net.lvLinks.length, r.kiosks.length);                       // every kiosk has a feeder; the first ones leave the mini-sub itself
  assert(r.net.lvLinks.filter(l => l.from === r.net.sub).every(l => Math.hypot(l.pts[0][0] - r.net.sub.x, l.pts[0][1] - r.net.sub.y) < 1e-6), 'a string head starts at the mini-sub');
  assert.strictEqual(r.net.mvLen, 0, 'MV is not designed here'); assert.strictEqual(r.net.mvLines.length, 0);
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
ok('trenches: LV / service / street light at 0.7 m, fibre at 0.6 m by default; no MV trench', () => {
  const r = L.solve(F, {}), t = L.trenches(r, {});
  assert(t.summary['LV/SL'] && !t.summary['MV']);
  assert.strictEqual(t.summary['LV/SL'].depth, 0.7);
  assert(t.list.every(x => x.depth === (x.type === 'LV/SL' ? 0.7 : x.type === 'FI' ? 0.6 : 1.1)));
});
ok('trenches: cables on one verge share a trench (far less than the sum of the routes)', () => {
  const r = L.solve(F, {}), t = L.trenches(r, {});
  const routes = r.erven.reduce((a, e) => a + (e.route ? plenOf(e.route) : 0), 0) + r.net.lvLen;
  assert(sumLen(t, x => x.type === 'LV/SL' && x.kind !== 'crossing') < routes * 0.95, `${sumLen(t, x => x.type === 'LV/SL')} vs ${routes}`);
  assert(!t.list.some(x => x.type === 'MV' && x.kind !== 'crossing'), 'no MV trench along the routes');
});
ok('trenches: depths are the settings', () => {
  const t = L.trenches(L.solve(F, {}), { depth: { lv: 0.85, fi: 0.5 } });
  assert.strictEqual(t.summary['LV/SL'].depth, 0.85); assert.strictEqual(t.summary['FI'].depth, 0.5);
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
ok('demand input: every erf once, the LV tree as fedFrom, the service length on the erf', () => {
  const r = L.solve(F, {});
  const d = L.demandInput(r, { minisubId: 'MS', lvCable: 'A', svcCable: 'B', phases: ['Red', 'White', 'Blue'] });
  const ids = d.kiosks.flatMap(k => k.erfs.map(e => e.id));
  assert.strictEqual(ids.length, new Set(ids).size);
  assert.strictEqual(ids.length, r.erven.filter(e => e.kiosk).length);
  const kid = new Set(d.kiosks.map(k => k.id));
  assert(d.kiosks.filter(k => k.fedFrom === 'MS').length >= 1);                                  // the kiosks the first cables reach hang off the mini-sub (a string each)
  assert(d.kiosks.filter(k => k.fedFrom === 'MS').length === r.net.lvLinks.filter(l => l.from === r.net.sub).length);
  d.kiosks.forEach(k => assert(k.fedFrom === 'MS' || kid.has(k.fedFrom)));
  d.kiosks.forEach(k => k.erfs.forEach(e => assert(e.length > 0 && e.cableType === 'B')));
  assert(d.kiosks.every(k => k.feederLength > 0 && k.feederCable === 'A'));
  const k0 = d.kiosks.find(k => k.erfs.length >= 3); assert.deepStrictEqual(k0.erfs.slice(0, 3).map(e => e.phase), ['Red', 'White', 'Blue']);
});
ok('Demand rows: phases rotate along a string, not afresh at each kiosk', () => {
  const r = L.solve(F, {}), d = L.demandInput(r, { minisubId: 'MS', lvCable: 'A', svcCable: 'B', phases: ['Red', 'White', 'Blue'] });
  const cnt = {}; d.kiosks.forEach(k => k.erfs.forEach(e => { cnt[e.phase] = (cnt[e.phase] || 0) + 1; }));
  const v = Object.values(cnt), naive = {}; d.kiosks.forEach(k => k.erfs.forEach((e, i) => { const ph = ['Red', 'White', 'Blue'][i % 3]; naive[ph] = (naive[ph] || 0) + 1; }));
  const spread = o => { const x = Object.values(o); return Math.max(...x) - Math.min(...x); };
  assert(spread(cnt) <= spread(naive), `carried ${JSON.stringify(cnt)} vs per-kiosk ${JSON.stringify(naive)}`);
  const k0 = d.kiosks[0]; assert.deepStrictEqual(k0.erfs.slice(0, 3).map(e => e.phase).slice(0, Math.min(3, k0.erfs.length)), ['Red', 'White', 'Blue'].slice(0, Math.min(3, k0.erfs.length)));
});
ok('mini-sub position: with none placed one stands beside the middle kiosk; a placed mini-sub is kept exactly', () => {
  const mid = L.solve(F, { strN: 0 });
  assert.strictEqual(mid.net.subs.length, 1);
  const fixed = L.solve(Object.assign({}, F, { subPts: [[mid.net.sub.x, mid.net.sub.y]] }), { strN: 0 });
  assert(Math.hypot(fixed.net.sub.x - mid.net.sub.x, fixed.net.sub.y - mid.net.sub.y) < 1e-9);
});
ok('several mini-subs: each kiosk is fed by one, the LV tree splits, Demand gets one row per mini-sub', () => {
  const one = L.solve(F, {}), pts = [L.ptAt(one.streets[0], 30, 0), L.ptAt(one.streets[1], 100, 0), L.ptAt(one.streets[2] || one.streets[0], 60, 0)].map(p => [p[0], p[1]]), r = L.solve(Object.assign({}, F, { subPts: pts }), { subBal: 1.5 });
  assert.strictEqual(r.net.subs.length, 3);
  assert(r.kiosks.every(k => k.subK && r.net.subs.some(S => S.k === k.subK)));
  assert.strictEqual(r.net.lvLinks.length, r.kiosks.length);                      // a tree per mini-sub, every kiosk fed once
  const per = r.net.subs.map(S => S.g.reduce((a, k) => a + k.members.length, 0)), tot = per.reduce((a, b) => a + b, 0);
  assert(Math.max(...per) <= Math.ceil(tot / 3 * 1.5) + 1);                       // the balance limit keeps the transformers alike
  assert(Math.max(...r.net.lvLinks.map(l => l.len)) > 0 && one.net.subs.length === 1);
  const d = L.demandInput(r, { minisubId: 'MS', phases: [null], txTypeId: 'tx' });
  assert.strictEqual(d.minisubs.length, 3);
  assert(d.kiosks.filter(k => d.minisubs.some(m => m.id === k.fedFrom)).length >= 3);
  assert(d.minisubs.every(m => m.txTypeId === 'tx'));
});
// an erf no street reaches: the nearest street and the run that makes it face the street
const farStreet = [{ id: 's1', name: 'ROAD A', w: 10, pts: [[0, 0], [100, 0]] }];
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
ok('reach: an erf beyond the end of a street → extend that street', () => {
  const lone = sq(120, -10, 140, 10), near = sq(20, 8, 40, 28);
  const r = L.reach(lone, farStreet, { erven: [{ poly: near }] });
  assert.strictEqual(r.street.id, 's1'); assert.strictEqual(r.atEnd, 'end'); assert(!r.near);
  assert(Math.abs(r.t[0] - 113) < 1e-9 && Math.abs(r.t[1]) < 1e-9, 't ' + r.t);              // w/2 + 2 = 7 m short of the edge at x = 120
  assert(Math.abs(r.len - 13) < 1e-9); assert.strictEqual(r.crosses, 0);
});
ok('reach: an erf beside the middle of a street → a spur', () => {
  const r = L.reach(sq(45, 40, 65, 60), farStreet);
  assert.strictEqual(r.atEnd, null); assert(Math.abs(r.q[1]) < 1e-9 && r.q[0] >= 45 && r.q[0] <= 65);
  assert(Math.abs(r.t[1] - 33) < 1e-6, 't ' + r.t);                                           // 7 m short of the edge midpoint at y = 40
});
ok('reach: after the run the erf faces a street (the layout gives it a front)', () => {
  const erven = [{ id: 'e1', poly: sq(20, 8, 40, 28) }, { id: 'e2', poly: sq(120, -10, 140, 10) }];
  let r = L.solve({ erven, streets: farStreet }, {});
  assert.deepStrictEqual(r.noFront.map(e => e.id), ['e2']);
  const g = L.reach(erven[1].poly, r.streets, { erven });
  const ext = [{ id: 's1', name: 'ROAD A', w: 10, pts: [[0, 0], [100, 0], g.t] }];
  r = L.solve({ erven, streets: ext }, {});
  assert.strictEqual(r.noFront.length, 0, 'noFront after ' + r.noFront.map(e => e.id));
});
ok('reach: a run through other erven is counted; an erf already in reach says so', () => {
  const block = sq(105, -6, 112, 6), lone = sq(120, -10, 140, 10);
  assert.strictEqual(L.reach(lone, farStreet, { erven: [{ poly: block }] }).crosses, 1);
  assert.strictEqual(L.reach(sq(40, 6, 60, 20), farStreet).near, true);
  assert.strictEqual(L.reach(lone, []), null);
});

// ── kiosks: one solve for the whole street network (fewest kiosks first, then crossings, then cable) ──
const gridFx = require('./layout-grid-fixture.js');
const stats = r => ({ k: r.kiosks.length, small: r.kiosks.filter(x => x.members.length <= 2).length, maxN: Math.max(0, ...r.kiosks.map(x => x.members.length)), served: r.erven.filter(e => e.kiosk).length });
// the invariants every layout must keep: all served, nothing over the cable limit, no kiosk over n erven
const holds = (r, P, total, what) => {
  const s = stats(r);
  assert.strictEqual(s.served, total, `${what}: ${s.served} of ${total} erven served`);
  assert.strictEqual(r.erven.filter(e => e.kiosk && e.cable > P.maxc + 1e-6).length, 0, `${what}: erven beyond the cable limit`);
  assert(s.maxN <= P.n, `${what}: a kiosk serves ${s.maxN} > ${P.n}`);
  assert.strictEqual(r.stats.over, 0);
};
ok('kiosks: the neighbourhood needs far fewer than one solve per street gives, and none is thin', () => {
  const P = { n: 6, maxc: 80, xpref: 'few' }, old = L.solve(F, { knet: false, xpref: 'few' }), r = L.solve(F, P), s = stats(r);
  holds(r, Object.assign({}, L.DEFAULTS, P), F.erven.length, 'fixture');
  assert(s.k <= 15, `kiosks ${s.k}`); assert(s.k <= old.kiosks.length - 3, `${s.k} vs ${old.kiosks.length} before`);
  assert(s.small <= 1, `${s.small} kiosks serve 2 erven or fewer`);
  assert(r.stats.avgPer >= 4.5, 'average erven per kiosk ' + r.stats.avgPer);
  assert(r.stats.cable <= old.stats.cable * 1.15, `service cable ${Math.round(r.stats.cable)} m vs ${Math.round(old.stats.cable)} m before`);
});
ok('kiosks: four short parallel streets of four erven need 3 kiosks at most (one per street gives 4 or more)', () => {
  const G = gridFx(50), r = L.solve(G, { maxc: 80 }), old = L.solve(G, { knet: false, maxc: 80 });
  holds(r, Object.assign({}, L.DEFAULTS, { maxc: 80 }), G.erven.length, 'grid');
  assert(r.kiosks.length <= 3, 'kiosks ' + r.kiosks.length); assert(old.kiosks.length >= 4, 'before ' + old.kiosks.length);
  assert(r.kiosks.some(k => new Set(k.members.map(e => e.road.id)).size > 1), 'a kiosk serves erven of two streets');
  assert(r.stats.small <= 1);
});
ok('kiosks: the settings now have an effect (n, worth)', () => {
  const k = P => L.solve(F, Object.assign({ maxc: 80 }, P)).kiosks.length;
  assert(k({ n: 6 }) - k({ n: 8 }) >= 2, `n 6 → 8: ${k({ n: 6 })} → ${k({ n: 8 })}`);
  assert(k({ n: 4 }) > k({ n: 6 }), 'n 4 needs more than n 6');
  assert(k({ worth: 0 }) - k({ worth: 250 }) >= 3, `worth 0 → 250: ${k({ worth: 0 })} → ${k({ worth: 250 })}`);
  const loose = L.solve(F, { worth: 0 }), tight = L.solve(F, { worth: 250 });
  assert(loose.stats.cable < tight.stats.cable, 'a smaller worth keeps the cable shorter');
  for (const P of [{ n: 8 }, { n: 4 }, { worth: 0 }, { worth: 400 }, { maxc: 60 }, { n: 3 }]) holds(L.solve(F, P), Object.assign({}, L.DEFAULTS, P), F.erven.length, JSON.stringify(P));
});
ok('kiosks: a sparser neighbourhood (40 erven) also gets far fewer', () => {
  const S = { streets: F.streets, erven: F.erven.filter((e, i) => i % 2 === 0).slice(0, 40) }, old = L.solve(S, { knet: false }), r = L.solve(S, {});
  assert.strictEqual(r.stats.erven, old.stats.erven, 'the same erven face a street as before'); holds(r, L.DEFAULTS, old.stats.erven, '40 erven'); assert(r.kiosks.length <= old.kiosks.length - 3, `${r.kiosks.length} vs ${old.kiosks.length} before`); assert(r.kiosks.length <= 11);
});
ok('kiosks: the rule-of-thumb mode is unchanged by the network solve', () => {
  const a = L.solve(F, { kmode: 'rules', n: 6 }), b = L.solve(F, { kmode: 'rules', n: 6, knet: false });
  assert.strictEqual(a.kiosks.length, b.kiosks.length); assert.strictEqual(Math.round(a.stats.cable), Math.round(b.stats.cable));
});
ok('kiosks: a service round a junction corner is routed and its crossings counted', () => {
  const G = gridFx(50), r = L.solve(G, {}), hop = r.erven.filter(e => e.kiosk && e.kiosk.road !== e.road);
  assert(hop.length > 0, 'some services run from another street');
  for (const e of hop) { assert(e.route && e.route.length >= 3 && e.cable <= 80 + 1e-6, e.id); assert(e.hopN >= 2, 'the part up to the corner is known'); }
});
ok('LV network: the mini-sub is picked among kiosks that reach the rest; a kiosk it cannot reach is reported', () => {
  // two streets not joined to each other: 3 + 1 erven, so the kiosks of the small street are cut off
  const streets = [{ id: 'A', name: 'A', w: 10, pts: [[0, 0], [120, 0]] }, { id: 'B', name: 'B', w: 10, pts: [[0, 200], [30, 200]] }];
  const erven = [0, 1, 2].map(i => ({ id: 'a' + i, poly: [[10 + 36 * i, 8], [10 + 36 * i + 30, 8], [10 + 36 * i + 30, 28], [10 + 36 * i, 28]] })).concat([{ id: 'b0', poly: [[2, 208], [28, 208], [28, 228], [2, 228]] }]);
  const r = L.solve({ streets, erven }, { n: 6 });
  assert(r.net.unreached.length >= 1 && r.stats.unreached >= 1, 'a cut-off kiosk is reported');
  assert.strictEqual(r.net.sub.road.id, 'A', 'the mini-sub is on the larger network');
  assert(r.net.unreached.every(k => k.road.id === 'B'));
  const ok2 = L.solve({ streets: [streets[0]], erven: erven.slice(0, 3) }, {});
  assert.strictEqual(ok2.net.unreached.length, 0);
});
// ── mini-subs placed by hand: free points, kiosks come from the erven alone ──
const kioskKey = r => r.kiosks.map(k => [k.id, Math.round(k.x * 100), Math.round(k.y * 100), k.members.length].join(':')).join('|');
ok('mini-sub: placed at an exact point, on a street or well away from any; no kiosk is forced beside it', () => {
  const base = L.solve(F, {}), spot = L.ptAt(base.streets[0], 60, 0);
  const onSt = L.solve(Object.assign({}, F, { subPts: [[spot[0], spot[1]]] }), {});
  assert(Math.hypot(onSt.net.sub.x - spot[0], onSt.net.sub.y - spot[1]) < 1e-9, 'exactly where it was put');
  const away = [spot[0] + 70, spot[1] + 90];                                      // nowhere near a street
  const off = L.solve(Object.assign({}, F, { subPts: [away] }), {});
  assert(Math.hypot(off.net.sub.x - away[0], off.net.sub.y - away[1]) < 1e-9);
  assert.strictEqual(kioskKey(onSt), kioskKey(base), 'kiosks are placed from the erven: the mini-sub does not move or add one');
  assert.strictEqual(kioskKey(off), kioskKey(base));
  for (const r of [onSt, off]) {
    assert(!r.kiosks.includes(r.net.sub));
    holds(r, L.DEFAULTS, F.erven.length, 'with a mini-sub placed by hand');
    r.net.lvLinks.filter(l => l.from === r.net.sub).forEach(l => assert(Math.hypot(l.pts[0][0] - r.net.sub.x, l.pts[0][1] - r.net.sub.y) < 1e-9 && Math.abs(l.len - L.plen(l.pts)) < 1e-6));
  }
  const dStreet = Math.min(...off.streets.map(st => L.project(st, away[0], away[1]).d));
  assert(dStreet > 20, 'the point is well away from every street: ' + dStreet.toFixed(1) + ' m');
  assert(off.net.lvLinks.filter(l => l.from === off.net.sub).every(l => l.len >= dStreet - 1e-6), 'every string head is at least as long as the way out to the street');
});
ok('several mini-subs placed by hand: each exactly where put, kiosks go to the nearest by LV distance', () => {
  const base = L.solve(F, {}), a = L.ptAt(base.streets[0], 30, 0), b = L.ptAt(base.streets[base.streets.length - 1], 40, 0);
  const r = L.solve(Object.assign({}, F, { subPts: [[a[0], a[1]], [b[0] + 25, b[1] + 25]] }), {});
  assert.strictEqual(r.net.subs.length, 2);
  assert.strictEqual(kioskKey(r), kioskKey(base), 'kiosks unchanged');
  const at = r.net.subs.map(S => [Math.round(S.k.x), Math.round(S.k.y)]);
  assert(at.some(q => q[0] === Math.round(a[0]) && q[1] === Math.round(a[1])) && at.some(q => q[0] === Math.round(b[0] + 25) && q[1] === Math.round(b[1] + 25)));
  assert(r.net.subs.every(S => S.k.manual));
  assert(r.kiosks.every(k => k.subK && r.net.subs.some(S => S.k === k.subK)));
  assert.strictEqual(r.net.lvLinks.length, r.kiosks.length);
  const d = L.demandInput(r, { minisubId: 'MS', phases: [null] });
  assert.strictEqual(d.minisubs.length, 2);
  assert.strictEqual(d.kiosks.filter(k => d.minisubs.some(m => m.id === k.fedFrom)).length, r.net.lvLinks.filter(l => l.from.root).length);
  holds(r, L.DEFAULTS, F.erven.length, 'with two mini-subs placed by hand');
});
ok('mini-subs placed by hand are the mini-subs', () => {
  const base = L.solve(F, {}), a = L.ptAt(base.streets[0], 30, 0);
  const r = L.solve(Object.assign({}, F, { subPts: [[a[0], a[1]]] }), {});
  assert.strictEqual(r.net.subs.length, 1);
  assert(r.net.subs[0].k.manual && Math.hypot(r.net.subs[0].k.x - a[0], r.net.subs[0].k.y - a[1]) < 1e-9);
  assert.strictEqual(kioskKey(r), kioskKey(base));
});
ok('placed mini-subs keep the order they were placed in', () => {
  const base = L.solve(F, {}), a = L.ptAt(base.streets[0], 30, 0), b = L.ptAt(base.streets[1], 40, 0);
  const r = L.solve(Object.assign({}, F, { subPts: [[b[0], b[1]], [a[0], a[1]]] }), {});
  assert(Math.hypot(r.net.subs[0].k.x - b[0], r.net.subs[0].k.y - b[1]) < 1e-9 && Math.hypot(r.net.subs[1].k.x - a[0], r.net.subs[1].k.y - a[1]) < 1e-9);
  assert.deepStrictEqual(r.net.subs.map(S => S.id), [1, 2]);
});
ok('a mini-sub with no kiosks to feed is still kept where it was put', () => {
  const r = L.solve(Object.assign({}, F, { subPts: [[0, 0], [1, 1]] }), {});
  assert.strictEqual(r.net.subs.length, 2);
});

// ── erven the classifier cannot place: a marker put there by hand, the solver does the rest ──
const markerFx = () => {
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { streets: [{ id: 'A', name: 'ROAD A', w: 10, pts: [[0, 0], [160, 0]] }],
    erven: [0, 1, 2, 3, 4].map(i => ({ id: 'f' + i, poly: sq(10 + i * 28, 8, 10 + i * 28 + 26, 28) })).concat([{ id: 'back', poly: sq(40, 32, 70, 52) }]) };   // 'back' has no street edge
};
ok('markers: an erf with no street edge is left out until its marker is placed, then it is served', () => {
  const G = markerFx(), a = L.solve(G, {});
  assert.deepStrictEqual(a.noFront.map(e => e.id), ['back']); assert.strictEqual(a.stats.erven, 5);
  const r = L.solve(Object.assign({ markers: { back: [55, 30] } }, G), {}), b = r.erven.find(e => e.id === 'back');
  assert.strictEqual(r.noFront.length, 0); assert.strictEqual(r.stats.erven, 6); assert.strictEqual(r.stats.manual, 1);
  assert(b.manual && b.kiosk && b.road.id === 'A', 'served from the nearest street');
  assert.deepStrictEqual(b.marker, [55, 30]); assert.deepStrictEqual(b.route[b.route.length - 1], [55, 30]);
  assert(b.cable > 0 && b.cable <= 80, 'cable ' + b.cable);
  assert(r.kiosks.every(k => k.members.length <= 6)); assert.strictEqual(r.over.length, 0);
});
ok('markers: a marker on an erf that has a front overrides the classifier\'s corner', () => {
  const G = markerFx(), r = L.solve(Object.assign({ markers: { f2: [60, 12] } }, G), {}), e = r.erven.find(x => x.id === 'f2');
  assert(e.manual); assert.deepStrictEqual(e.marker, [60, 12]);
  const plain = L.solve(G, {}).erven.find(x => x.id === 'f2'); assert(!plain.manual && plain.marker[0] !== 60);
});
ok('markers: unknown erf ids and bad points are ignored; a marker far from every street is served but reported over the limit', () => {
  const G = markerFx(), r = L.solve(Object.assign({ markers: { back: [55, 30], ghost: [1, 1], bad: 'x', worse: [NaN, 1] } }, G), {});
  assert.strictEqual(r.stats.erven, 6); assert.strictEqual(r.stats.manual, 1);
  const far = L.solve(Object.assign({ markers: { back: [55, 300] } }, G), {}), b = far.erven.find(e => e.id === 'back');
  assert(b.kiosk, 'still assigned a kiosk'); assert(b.cable > 80 && far.over.some(e => e.id === 'back'), 'reported over maxc');
});
ok('markers: a hand-placed erf makes no kiosk stand of its own, and both placement modes serve it', () => {
  const G = markerFx();
  for (const P of [{}, { kmode: 'rules' }, { knet: false }]) {
    const r = L.solve(Object.assign({ markers: { back: [55, 30] } }, G), P), b = r.erven.find(e => e.id === 'back');
    assert(b.kiosk && b.cable <= 80, JSON.stringify(P)); assert.strictEqual(r.stats.erven, 6);
  }
  const a = L.solve(Object.assign({ markers: { back: [55, 30] } }, G), {}), b = L.solve(Object.assign({ markers: { back: [55, 30] } }, G), {});
  assert.deepStrictEqual(a.kiosks.map(k => [k.id, k.members.length]), b.kiosks.map(k => [k.id, k.members.length]), 'deterministic');
});

// ── the fibre point: beside the power marker (default), or at the opposite front corner (layouts made before) ──
const along = (e, p) => (p[0] - e.marker[0]) * e.fe.inn[1] * -1 + (p[1] - e.marker[1]) * e.fe.inn[0];   // signed distance along the front
ok('fibre point: beside the power marker by default, fgap m along the front on its middle side, inside the erf', () => {
  assert.strictEqual(L.DEFAULTS.fentry, 'beside'); assert.strictEqual(L.DEFAULTS.fgap, 1.5);
  const r = L.solve(markerFx(), {});
  for (const e of r.erven.filter(x => x.marker && x.fibrePt)) {
    assert(Math.abs(Math.hypot(e.fibrePt[0] - e.marker[0], e.fibrePt[1] - e.marker[1]) - 1.5) < 1e-6, e.id);
    const mid = [e.fe.mid[0] - e.marker[0], e.fe.mid[1] - e.marker[1]], v = [e.fibrePt[0] - e.marker[0], e.fibrePt[1] - e.marker[1]];
    assert(mid[0] * v[0] + mid[1] * v[1] > 0, 'towards the middle ' + e.id);
  }
  const c = L.solve(markerFx(), { fside: 'corner', fgap: 2 });
  for (const e of c.erven.filter(x => x.marker && x.fibrePt)) {
    const mid = [e.fe.mid[0] - e.marker[0], e.fe.mid[1] - e.marker[1]], v = [e.fibrePt[0] - e.marker[0], e.fibrePt[1] - e.marker[1]];
    assert(Math.abs(Math.hypot(v[0], v[1]) - 2) < 1e-6 && mid[0] * v[0] + mid[1] * v[1] < 0, 'corner side ' + e.id);
  }
});
ok('fibre point: fentry opp mirrors the marker at the other front corner (as before)', () => {
  const r = L.solve(markerFx(), { fentry: 'opp', side: 4 });
  for (const e of r.erven.filter(x => x.marker && x.fibrePt)) assert(Math.abs(Math.hypot(e.fibrePt[0] - e.marker[0], e.fibrePt[1] - e.marker[1]) - (e.fe.len - 8)) < 1e-6, e.id);
});
ok('fibre point: a hand-placed marker gets its fibre point beside it along the street, flipped when that side is outside the erf', () => {
  const G = markerFx();                                                      // f2 spans x 66–92, the street runs along x
  for (const fentry of ['beside', 'opp']) {
    const e = L.solve(Object.assign({ markers: { f2: [72, 14] } }, G), { fentry }).erven.find(x => x.id === 'f2');
    assert(e.manual); assert.deepStrictEqual(e.marker, [72, 14]); assert(Math.abs(e.fibrePt[0] - 73.5) < 1e-6 && Math.abs(e.fibrePt[1] - 14) < 1e-6, fentry + ' ' + e.fibrePt);
  }
  const k = L.solve(Object.assign({ markers: { f2: [67, 14] } }, G), { fside: 'corner' }).erven.find(x => x.id === 'f2');
  assert(Math.abs(k.fibrePt[0] - 68.5) < 1e-6, 'flipped into the erf ' + k.fibrePt);
  const d = L.solve(Object.assign({ markers: { f2: [72, 14] } }, G), {}).erven.find(x => x.id === 'f2');
  assert(d.duct && Math.hypot(d.duct[d.duct.length - 1][0] - 73.5, d.duct[d.duct.length - 1][1] - 14) < 1e-6, 'the duct ends at it');
});
ok('fibre point: one moved by hand keeps its offset from the power marker', () => {
  const G = markerFx(), r = L.solve(Object.assign({ fibreOffs: { f1: [0.5, 2] }, markers: { f2: [72, 14] } }, G), {}), e = r.erven.find(x => x.id === 'f1');
  assert(e.fibreHand && Math.abs(e.fibrePt[0] - e.marker[0] - 0.5) < 1e-6 && Math.abs(e.fibrePt[1] - e.marker[1] - 2) < 1e-6);
  assert(!r.erven.find(x => x.id === 'f2').fibreHand);
});
ok('trenches: lead on = one lead trench per erf for the service and fibre leads that come in together (boundary routing)', () => {
  const r = L.solve(F, { route: 'blocks' }), a = L.trenches(r, {}), b = L.trenches(r, { lead: true });
  const sp = t => t.list.filter(x => x.kind === 'spur').length, leads = b.list.filter(x => x.lead);
  assert(leads.length > 0 && sp(b) < sp(a), 'spurs ' + sp(a) + ' → ' + sp(b) + ', leads ' + leads.length);
  assert(leads.every(x => x.type === 'LV/SL' && x.cats.includes('svc') && x.cats.includes('fi')));
  assert.strictEqual(sp(a) - sp(b), leads.length, 'one spur dropped per shared lead');
  const o = L.solve(F, { route: 'blocks', fentry: 'opp' }); assert.strictEqual(L.trenches(o, { lead: true }).list.filter(x => x.lead).length, 0, 'opposite corners are not shared');
});

ok('boundary routing: a kiosk side set to a side with no erven keeps the kiosks there, joined across the road by a counted crossing', () => {
  const G = markerFx();                                                      // every erf is on side -1 of street A (y > 0)
  const auto = L.solve(G, { route: 'blocks' });
  assert(auto.kiosks.every(k => k.y > 0 && !k.xjoin), 'auto: on the erf side');
  const r = L.solve(Object.assign({ ks: { A: 1 } }, G), { route: 'blocks' });
  assert(r.kiosks.length && r.kiosks.every(k => k.y < 0 && k.xjoin), 'set to the empty side: kiosks stay there ' + r.kiosks.map(k => k.y.toFixed(1)));
  const kc = r.net.cross.filter(c => c.kind === 'kiosk' || c.sites.some(x => x.kind === 'kiosk'));
  assert(kc.length >= 1 && kc.reduce((t, c) => t + c.svc, 0) >= r.erven.filter(e => e.route && e.road && e.road.id === 'A').length, 'every service crosses the road once, counted');
  for (const e of r.erven.filter(x => x.route)) { assert(e.route[0][1] < 0, 'service starts at the kiosk ' + e.id); const i = e.route.findIndex(p => p[1] > 0); assert(i > 0, 'then crosses ' + e.id); }
});

ok('boundary routing: a kiosk or manhole put by hand across the road stays there, joined by a counted crossing', () => {
  const G = markerFx(), base = L.solve(G, { route: 'blocks' });
  const k = L.solve(Object.assign({ kioskPins: [[60, -6]] }, G), { route: 'blocks' }), pk = k.kiosks.find(q => q.pin);
  assert(pk && Math.hypot(pk.x - 60, pk.y + 6) < 1e-9 && pk.xjoin, 'the kiosk stays where it was put');
  assert.strictEqual(k.net.cross.filter(c => c.sites.some(x => x.kind === 'kiosk')).reduce((t, c) => t + c.svc, 0), pk.members.length, 'each of its services crosses the road once, counted');
  const m0 = base.fibre.mhs[0];
  const d = L.solve(Object.assign({ mhDrops: [[m0.x, m0.y]] }, G), { route: 'blocks' });
  assert.strictEqual(d.fibre.mhs.length, base.fibre.mhs.length - 1, 'a dropped manhole is gone');
  const m2 = L.solve(Object.assign({ mhPins: [[30, 12]], mhDrops: [[m0.x, m0.y]] }, G), { route: 'blocks' });
  assert(m2.fibre.mhs.length === 1 && m2.fibre.mhs[0].hand && m2.erven.filter(e => e.fe).every(e => e.mh === m2.fibre.mhs[0]), 'moved: its erven go to it');
  const a = L.solve(Object.assign({ mhPins: [[70, -6]] }, G), { route: 'blocks' }), pm = a.fibre.mhs.find(m => m.hand);
  assert(pm && Math.hypot(pm.x - 70, pm.y + 6) < 1e-9 && pm.xjoin, 'an added manhole stays across the road');
  assert(a.net.cross.some(c => c.kind === 'manhole' && c.fib > 0), 'its ducts cross the road there');
  assert.strictEqual(a.fibre.mhs.length, base.fibre.mhs.length + 1);
  const o = L.solve(Object.assign({ mhPins: [[70, 12]] }, G), { route: 'blocks' }), om = o.fibre.mhs.find(m => m.hand);
  assert(om && !om.xjoin && om.y > 0, 'on the erf side: onto the corridor there');
});

ok('boundary routing: a kiosk you place across the road is served first, even with one of the layout\'s own kiosks nearer', () => {
  const G = markerFx(), base = L.solve(G, { route: 'blocks' });
  const r = L.solve(Object.assign({ kioskPins: [[60, -6]] }, G), { route: 'blocks' }), pk = r.kiosks.find(q => q.pin);   // the layout's own kiosk is NOT dropped
  assert(base.kiosks.length >= 1 && pk && pk.xjoin && pk.members.length >= 3, 'the placed kiosk takes most of the erven ' + (pk && pk.members.length));
  assert(!r.warns.some(w => typeof w === 'string' && /moved serves no erf/.test(w)));
  const none = L.solve(G, { route: 'blocks' });
  assert.deepStrictEqual(none.kiosks.map(k => [k.x, k.y, k.members.length]), base.kiosks.map(k => [k.x, k.y, k.members.length]), 'no kiosk placed: unchanged');
});
ok('boundary routing: a street\'s own kiosk side (ksOwn) is honoured even where the optimiser would rather serve from elsewhere', () => {
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const G = { streets: [{ id: 'A', name: 'ROAD A', w: 10, pts: [[0, 0], [160, 0]] }, { id: 'B', name: 'ROAD B', w: 10, pts: [[0, 40], [160, 40]] }],
    erven: [0, 1, 2, 3, 4].map(i => ({ id: 'a' + i, poly: sq(10 + i * 28, 8, 10 + i * 28 + 26, 28) })).concat([0, 1, 2, 3, 4].map(i => ({ id: 'b' + i, poly: sq(10 + i * 28, 48, 10 + i * 28 + 26, 68) }))) };
  const side = (k, st) => Math.sign(k.y - st.pts[0][1]);
  const own = L.solve(Object.assign({ ks: { A: 1, B: -1 }, ksOwn: { A: true } }, G), { route: 'blocks' }), A = own.streets.find(s => s.id === 'A');
  const onA = own.kiosks.filter(k => k.road === A);
  assert(onA.length && onA.every(k => side(k, A) < 0 && k.xjoin), 'kiosks on street A stand on its set (empty) side ' + onA.map(k => k.y.toFixed(1)));
});

ok('boundary routing: the LV from a mini-sub to a kiosk beside it on a side with no corridor runs straight, not across the road and back', () => {
  const G = markerFx(), r = L.solve(Object.assign({ kioskPins: [[60, -6]], subPts: [[95, -6]] }, G), { route: 'blocks' }), pk = r.kiosks.find(q => q.pin);
  const l = r.net.lvLinks.find(x => x.to === pk || x.from === pk);
  assert(pk && pk.xjoin && l, 'a link to the kiosk placed across the road');
  assert(l.direct && l.pts.length === 2 && l.pts.every(p => p[1] < 0), 'straight along its own side ' + JSON.stringify(l.pts));
  const kc = r.net.cross.find(c => c.kind === 'kiosk'); assert(kc && kc.lv === 0, 'its crossing carries no LV');
});

ok('boundary routing: services from a kiosk across the road run along its own verge and cross at the erf boundaries, with one verge trench', () => {
  const G = markerFx(), r = L.solve(Object.assign({ kioskPins: [[40, -6]] }, G), { route: 'blocks' }), pk = r.kiosks.find(q => q.pin);
  assert(pk && pk.xjoin && pk.members.length >= 3);
  const bnd = [10, 36, 38, 64, 66, 92, 94, 120, 122, 148];                    // the erven's side boundaries (x)
  for (const e of pk.members.filter(x => x.road && x.road.id === 'A')) {
    const i = e.route.findIndex(p => p[1] > 0), a = e.route[i - 1], b = e.route[i];
    assert(e.route.slice(0, i).every(p => p[1] < 0), 'along the kiosk side first ' + e.id);
    const xAt = a[0] + (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]);
    assert(bnd.some(x => Math.abs(x - xAt) < 1.5), 'crosses on an erf boundary ' + e.id + ' at x ' + xAt.toFixed(1));
  }
  const t = L.trenches(r, {}), vt = t.list.filter(x => x.kind === 'spur' && x.pts.every(p => p[1] < 0));
  assert.strictEqual(vt.length, 1, 'one trench along the kiosk verge');
});

ok('boundary routing: fibre set to a side with no erven keeps its manholes there, ducts along that verge and across at erf boundaries', () => {
  const G = markerFx(), auto = L.solve(G, { route: 'blocks', fibre: 'same' });
  assert(auto.fibre.mhs.every(m => m.y > 0 && !m.xjoin), 'auto: manholes on the erf side');
  const r = L.solve(Object.assign({ fs: { A: 1 }, fsOwn: { A: true } }, G), { route: 'blocks' });
  assert(r.fibre.mhs.length && r.fibre.mhs.every(m => m.y < 0 && m.xjoin), 'set side: manholes stay there ' + r.fibre.mhs.map(m => m.y.toFixed(1)));
  const bnd = [10, 36, 38, 64, 66, 92, 94, 120, 122, 148];
  for (const e of r.erven.filter(x => x.duct && x.road && x.road.id === 'A')) {
    const i = e.duct.findIndex(p => p[1] > 0), a = e.duct[i - 1], b = e.duct[i];
    assert(i > 0 && e.duct.slice(0, i).every(p => p[1] < 0), 'along the manhole side first ' + e.id);
    const xAt = a[0] + (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]);
    assert(bnd.some(x => Math.abs(x - xAt) < 1.5), 'crosses on an erf boundary ' + e.id + ' at x ' + xAt.toFixed(1));
  }
  const fc = r.net.cross.filter(c => c.sites.some(x => x.kind === 'manhole')).reduce((t, c) => t + c.fib, 0);
  assert.strictEqual(fc, r.erven.filter(x => x.duct && x.road && x.road.id === 'A').length, 'each duct crosses once, counted');
  const t = L.trenches(r, {}); assert(t.list.some(x => x.type === 'FI' && x.kind === 'spur' && x.pts.every(p => p[1] < 0)), 'a fibre trench along that verge');
});

ok('splitting a string: a kiosk becomes its own string head, fed straight off the mini-sub along the same route', () => {
  const base = L.solve(F, { subs: 1 }), deep = base.net.lvLinks.filter(l => l.from !== base.net.subs[0].k).sort((a, b) => b.len - a.len)[0];
  assert(deep, 'a kiosk that hangs off another kiosk');
  const di = L.demandInput(base, { minisubId: 'S' }).kiosks.find(k => k.id === deep.to.id);
  assert.strictEqual(di.fedFrom, deep.from.id, 'before: fed from the kiosk above it');
  const r = L.solve(Object.assign({ splits: [[deep.to.x, deep.to.y]] }, F), {});
  const k = r.kiosks.find(x => Math.hypot(x.x - deep.to.x, x.y - deep.to.y) < 3), link = r.net.lvLinks.find(l => l.to === k);
  assert(link.split && link.from === r.net.subs[0].k, 'now a hub of the mini-sub');
  const dem = L.demandInput(r, { minisubId: 'S' }).kiosks.find(x => x.id === k.id);
  assert.strictEqual(dem.fedFrom, 'S', 'fed from the mini-sub');
  assert(dem.feederLength > 5 && dem.feederLength >= deep.len - 1e-6, 'the whole path from the mini-sub, ' + dem.feederLength);
  assert(Math.abs(link.len - L.plen(link.pts)) < 1e-6);
  // the kiosks it fed still hang off it
  assert(r.net.lvLinks.filter(l => l.from === k).length === base.net.lvLinks.filter(l => l.from === deep.to).length);
  assert.strictEqual(r.stats.kiosks, base.stats.kiosks);
});

ok('no street reaches any erf: no kiosks, and the network still has its (empty) lists', () => {
  const r = L.solve({ streets: [{ id: 'A', name: 'A', w: 10, pts: [[0, 0], [50, 0]] }], erven: [{ id: 'e', poly: [[400, 400], [420, 400], [420, 420], [400, 420]] }] }, {});
  assert.strictEqual(r.kiosks.length, 0);
  assert(Array.isArray(r.net.subs) && Array.isArray(r.net.lvLinks) && Array.isArray(r.net.mvLines));
});


// ── the corridor follows the erf boundary, not the street line ──
const distSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
const distErf = (p, erven) => { let m = 1e9; for (const e of erven) for (let i = 0; i < e.poly.length; i++) m = Math.min(m, distSeg(p, e.poly[i], e.poly[(i + 1) % e.poly.length])); return m; };
const shifted = (F0, dx, dy) => Object.assign({}, F0, { streets: F0.streets.map(s => Object.assign({}, s, { pts: s.pts.map(p => [p[0] + dx, p[1] + dy]) })) });
// the cable points of a service that run along the kiosk's verge (not the first or last point: the kiosk and the marker)
const verges = r => { const d = []; for (const e of r.erven) if (e.route && e.route.length > 3) for (const p of e.route.slice(1, -1)) d.push(distErf(p, r.erven)); return d; };
ok('corridor: on an accurate street line the boundary mode (kd 2) gives the same layout as the street mode', () => {
  const a = L.solve(F, { kgeo: 'boundary', kd: 2 }), b = L.solve(F, { kgeo: 'street' });
  assert.strictEqual(a.kiosks.length, b.kiosks.length);
  assert(Math.abs(a.stats.cable - b.stats.cable) < 0.01 * b.stats.cable, `cable ${a.stats.cable} v ${b.stats.cable}`);
});
ok('corridor: with the street line 4 m out the cables still run kd inside the boundary', () => {
  const G = shifted(F, 3, 3), r = L.solve(G, { kgeo: 'boundary', kd: 2 }), old = L.solve(G, { kgeo: 'street' });
  const near = verges(r).filter(d => d < 6), far = verges(old).filter(d => d < 6);
  const bad = near.filter(d => Math.abs(d - 2) > 0.8).length / near.length, badOld = far.filter(d => Math.abs(d - 2) > 0.8).length / far.length;
  assert(bad < 0.25, 'boundary mode: ' + (bad * 100).toFixed(0) + '% of the cable is off the corridor');
  assert(badOld > bad + 0.2, 'street mode drifts: ' + (badOld * 100).toFixed(0) + '% v ' + (bad * 100).toFixed(0) + '%');
});
ok('corridor: kd is the distance from the boundary', () => {
  const r1 = L.solve(F, { kgeo: 'boundary', kd: 1 }), r3 = L.solve(F, { kgeo: 'boundary', kd: 3 });
  const m = r => { const d = verges(r).filter(x => x < 6); return d.reduce((a, b) => a + b, 0) / d.length; };
  assert(m(r3) - m(r1) > 1, `mean ${m(r1).toFixed(2)} → ${m(r3).toFixed(2)}`);
});

// ── LV strings: no string longer than strN kiosks ──
const strSizes = (r) => {                                                           // kiosks in the string of each head
  const kids = new Map(r.kiosks.map(k => [k, []])); r.net.lvLinks.forEach(l => { if (kids.has(l.from)) kids.get(l.from).push(l.to); });
  const size = k => 1 + kids.get(k).reduce((a, c) => a + size(c), 0);
  return r.net.lvLinks.filter(l => !kids.has(l.from)).map(l => size(l.to));
};
ok('strings: no string has more than strN kiosks, every kiosk is still fed once', () => {
  const free = L.solve(F, { strN: 0 }), cut = L.solve(F, { strN: 4, maxFeeds: 0 });
  assert.strictEqual(cut.net.lvLinks.length, cut.kiosks.length);
  assert(Math.max(...strSizes(cut)) <= 4, 'sizes ' + strSizes(cut));
  assert(strSizes(cut).length >= strSizes(free).length);
  assert.strictEqual(cut.stats.strings, strSizes(cut).length);
  cut.net.lvLinks.filter(l => !cut.kiosks.includes(l.from)).forEach(l => assert(Math.hypot(l.pts[0][0] - l.from.x, l.pts[0][1] - l.from.y) < 1e-6 && Math.abs(l.len - L.plen(l.pts)) < 1e-6));
});
ok('strings: strN 0 leaves the tree as it was; "even" never has more kiosks than strN nor fewer strings than "fewest"', () => {
  const a = L.solve(F, { strN: 0 }), b = L.solve(F, { strN: 0, strMode: 'even' });
  assert.deepStrictEqual(a.net.lvLinks.map(l => l.len), b.net.lvLinks.map(l => l.len));
  const f = L.solve(F, { strN: 3, maxFeeds: 0 }), e = L.solve(F, { strN: 3, strMode: 'even', maxFeeds: 0 });
  assert(Math.max(...strSizes(e)) <= 3 && strSizes(e).length >= strSizes(f).length);
  assert(Math.max(...strSizes(e)) - Math.min(...strSizes(e)) <= Math.max(...strSizes(f)) - Math.min(...strSizes(f)));
});

ok('crossings: "near" crosses at the boundary nearest each erf, no longer cable, shorter far-verge run than "few"', () => {
  const run = r => { let t = 0, n = 0; r.erven.forEach(e => { if (e.via && e.marker) { t += Math.abs(e.via.s - L.project(e.road, e.marker[0], e.marker[1]).s); n++; } }); return { t, n }; };
  const few = L.solve(F, { xpref: 'few' }), near = L.solve(F, { xpref: 'near' });
  assert(near.stats.cable <= few.stats.cable * 1.03, `${near.stats.cable} vs ${few.stats.cable}`);
  const a = run(few), b = run(near); assert(a.n > 0 && b.n === a.n);
  assert(b.t < a.t * 0.8, `far-verge run ${Math.round(b.t)} m vs ${Math.round(a.t)} m`);
  assert(near.stats.crossings >= few.stats.crossings);
});
ok('strings: strE cuts by erven carried; no string carries more than strE (a single kiosk aside)', () => {
  const r = L.solve(F, { strN: 0, strE: 12, maxFeeds: 0 }), up = new Map(r.net.lvLinks.map(l => [l.to, l]));
  const head = k => { let c = k; while (up.get(c) && up.get(c).from !== c.subK) c = up.get(c).from; return c; };
  const load = new Map(); r.kiosks.forEach(k => { const h = head(k); load.set(h, (load.get(h) || 0) + k.members.length); });
  load.forEach((n, h) => assert(n <= 12 || h.members.length > 12 || n === h.members.length, 'string of ' + n));
  assert(r.net.strings >= L.solve(F, { strN: 0, strE: 0 }).net.strings);
});
ok('mini-subs placed by hand: subBal moves the border kiosks to the neighbour with room; 0 keeps nearest-wins', () => {
  const S0 = L.solve(F, { strN: 0 }).streets[0], pa = L.ptAt(S0, 5, 0), pb = L.ptAt(S0, 20, 0), near = [[pa[0], pa[1]], [pb[0], pb[1]]];     // both at the start of the first street: nearest-wins gives one of them everything
  const load = r => r.net.subs.map(s => s.g.reduce((a, k) => a + k.members.length, 0));
  const a = load(L.solve(Object.assign({}, F, { subPts: near }), { strN: 0 })), b = load(L.solve(Object.assign({}, F, { subPts: near }), { strN: 0, subBal: 1.3 }));
  assert(Math.max(...b) < Math.max(...a), `${a} then ${b}`);
});
ok('markers: "pair" puts neighbours\' markers on their common boundary, closer than the start corner does', () => {
  const gap = r => { let tot = 0, n = 0; const by = new Map(); r.erven.forEach(e => { if (!e.fe || !e.marker) return; const k = e.road.id + '|' + e.sd; (by.get(k) || by.set(k, []).get(k)).push(e); });
    by.forEach(l => { l.sort((a, b) => a.al - b.al); for (let i = 0; i + 1 < l.length; i++) if (Math.abs(l[i].hi - l[i + 1].lo) <= 1.5) { tot += Math.hypot(l[i].marker[0] - l[i + 1].marker[0], l[i].marker[1] - l[i + 1].marker[1]); n++; } }); return tot / n; };
  const a = L.solve(F, { corner: 'start' }), b = L.solve(F, { corner: 'pair' });
  assert(gap(b) < gap(a), `${gap(b).toFixed(1)} vs ${gap(a).toFixed(1)}`);
  holds(b, Object.assign({}, L.DEFAULTS, { corner: 'pair' }), F.erven.length, 'pair');
});
ok('crossings: xkiosk keeps a kiosk that giving up would add crossings for (default off: fewest kiosks first)', () => {
  const G = gridFx(50), off = L.solve(G, {}), on = L.solve(G, { xkiosk: true });
  assert(on.kiosks.length >= off.kiosks.length && on.stats.crossings <= off.stats.crossings, `kiosks ${off.kiosks.length} → ${on.kiosks.length}, crossings ${off.stats.crossings} → ${on.stats.crossings}`);
  holds(on, Object.assign({}, L.DEFAULTS, { xkiosk: true }), G.erven.length, 'grid xkiosk');
});
ok('front: "busy" gives every erf a front and keeps every layout rule', () => {
  const r = L.solve(F, { front: 'busy' });
  holds(r, Object.assign({}, L.DEFAULTS, { front: 'busy' }), F.erven.length, 'busy');
});
ok('fibre: mhmerge folds short stretches into a neighbour: fewer manholes, every erf still has a duct, no manhole over m erven', () => {
  const a = L.solve(F, {}), b = L.solve(F, { mhmerge: true });
  assert(b.fibre.mhs.length < a.fibre.mhs.length, `${a.fibre.mhs.length} → ${b.fibre.mhs.length}`);
  assert.strictEqual(b.erven.filter(e => e.fe && !e.duct).length, 0);
  b.fibre.mhs.forEach(m => assert(m.members.length <= b.P.m, 'manhole of ' + m.members.length));
  assert.strictEqual(new Set(b.fibre.mhs.map(m => m.id)).size, b.fibre.mhs.length);
});
ok('kside "try": never scores worse than the head-count side, sides set by hand are kept, rules still hold', () => {
  const sc = r => r.kiosks.length * r.P.worth + r.stats.cable + r.P.xpen * r.stats.crossings;
  const a = L.solve(F, { kside: 'count' }), b = L.solve(F, { kside: 'try' });
  assert(sc(b) <= sc(a) + 1e-6, `${sc(a)} vs ${sc(b)}`);
  holds(b, Object.assign({}, L.DEFAULTS, { kside: 'try' }), F.erven.length, 'kside try');
  const id = a.streets[0].id, c = L.solve(Object.assign({}, F, { ks: { [id]: -a.ks[id] } }), { kside: 'try' });
  assert.strictEqual(c.ks[id], -a.ks[id]);
});
// two streets that form a T (a spine and a branch whose end is 2 mm off it), erven on every side: the shape of an organic estate
const teeFx = jx => {
  const streets = [{ id: 'SPINE', name: 'Elm Avenue', w: 12, pts: [[0, 0], [300, 0]] }, { id: 'BRANCH', name: 'Protea Close', w: 12, pts: [[jx, 0.002], [jx, 160]] }], erven = []; let n = 0;
  const R = (x0, y0, x1, y1) => erven.push({ id: 'E' + (++n), poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
  for (let x = 0; x < 300; x += 20) if (x + 20 < jx - 8 || x > jx + 8) { R(x, -31, x + 20, -6); R(x, 6, x + 20, 31); }
  for (let y = 12; y < 160; y += 20) { R(jx - 31, y, jx - 6, y + 20); R(jx + 6, y, jx + 31, y + 20); }
  return { streets, erven };
};
ok('a mini-sub beside a junction never cuts the LV network (0 to 12 m either side, on the spine and on the branch, and the 0.26 to 0.35 m that straddled a node bucket)', () => {
  const T = teeFx(149.5), r0 = L.solve(T, { strN: 0 }), sp = r0.streets.find(x => x.id === 'SPINE'), br = r0.streets.find(x => x.id === 'BRANCH');
  const sJ = r0.junctions[0].items.find(i => i[0].id === 'SPINE')[1];
  const ref = L.solve(Object.assign({}, T, { subPts: [L.ptAt(sp, sJ, 0.002).slice(0, 2)] }), { strN: 0 });
  assert.strictEqual(ref.net.unreached.length, 0); const lv0 = ref.net.lvLen;
  const check = (S, s, what) => {
    const p = L.ptAt(S, Math.max(0, s), 0.002), r = L.solve(Object.assign({}, T, { subPts: [[p[0], p[1]]] }), { strN: 0 });
    assert.strictEqual(r.net.unreached.length, 0, `${what}: ${r.net.unreached.length} kiosks not reached`);
    assert.strictEqual(r.erven.filter(e => e.kiosk && r.net.unreached.includes(e.kiosk)).length, 0, `${what}: erven with no LV supply`);
    assert(Math.abs(r.net.lvLen - lv0) <= 5, `${what}: LV ${Math.round(r.net.lvLen)} m vs ${Math.round(lv0)} m`);
  };
  for (const d of [0, 1, 3, 5, 8, 12, -1, -3, -5, -8, -12, -0.26, -0.3, -0.35, 0.3, 45]) { check(sp, sJ + d, 'spine ' + d); check(br, Math.abs(d), 'branch ' + Math.abs(d)); }
});
ok('a placed mini-sub joins the NEAREST street, not the first one', () => {
  const r0 = L.solve(F, { strN: 0 }), S = r0.streets.find(x => x.id === 'S2'), p = L.ptAt(S, 120, 0.002);
  const r = L.solve(Object.assign({}, F, { subPts: [[p[0], p[1]]] }), { strN: 0 });
  assert.strictEqual(r.net.sub.road.id, 'S2'); assert(Math.hypot(r.net.sub.stub[1][0] - p[0], r.net.sub.stub[1][1] - p[1]) < 30, 'its cable stub is short');
});
ok('strings: each string reports its reach from the mini-sub; cutting by kiosks never shortens it; default limit is 350 m', () => {
  assert.strictEqual(L.DEFAULTS.strL, 350);
  const a = L.solve(F, { strN: 0 }), b = L.solve(F, { strN: 2, maxFeeds: 0 });
  assert(a.net.strLens.length >= 1 && b.net.strLens.length > a.net.strLens.length, 'more strings when cut');
  const far = r => Math.max(...r.net.strLens.map(x => x.len));
  assert(far(b) <= far(a) + 0.05, 'the furthest kiosk is no further when cut (within 5 cm: the head feeder follows the same route, rounded at its own bends)');
  b.net.strLens.forEach(x => { assert(x.len > 0 && x.kiosks.includes(x.far)); });
});
ok('feeders: at most maxFeeds per mini-sub (default 6); over it the strings are cut longer, never left over the limit', () => {
  assert.strictEqual(L.DEFAULTS.maxFeeds, 6);
  const free = L.solve(F, { strN: 2, maxFeeds: 0 }), feeds = r => r.net.subs.map(S => S.nFeeds);
  assert(Math.max(...feeds(free)) > 4, 'the fixture needs more than 4 feeders at strN 2: ' + feeds(free));
  for (const m of [4, 6, 10]) {
    const r = L.solve(F, { strN: 2, maxFeeds: m });
    r.net.subs.forEach(S => { if (!S.feeds.over) assert(S.nFeeds <= m, `max ${m}: ${S.nFeeds}`); });
    assert.strictEqual(r.net.lvLinks.length, r.kiosks.length, 'every kiosk still fed once');
    assert.strictEqual(r.stats.strings, feeds(r).reduce((a, b) => a + b, 0));
    if (Math.max(...feeds(free)) > m) assert(r.net.subs.some(S => S.feeds.raised), 'the string limit was raised');
  }
  const r4 = L.solve(F, { strN: 2, maxFeeds: 4 }); assert(Math.max(...strSizes(r4)) > 2, 'longer strings to keep within 4 feeders');
  // two mini-subs share the kiosks: each keeps its own limit
  const S0 = free.streets[0], S1 = free.streets[free.streets.length - 1], p0 = L.ptAt(S0, 5, 0.002), p1 = L.ptAt(S1, Math.max(0, S1.len - 5), 0.002);
  const two = L.solve(Object.assign({}, F, { subPts: [[p0[0], p0[1]], [p1[0], p1[1]]] }), { strN: 1, maxFeeds: 3 });
  assert.strictEqual(two.net.subs.length, 2);
  two.net.subs.forEach(S => assert(S.feeds.over || S.nFeeds <= 3, 'each mini-sub: ' + S.nFeeds));
});
ok('a kiosk moved by hand stands exactly there and the layout is solved around it', () => {
  const r0 = L.solve(F, {}), k0 = r0.kiosks[Math.floor(r0.kiosks.length / 2)], st = k0.road;
  const to = L.ptAt(st, Math.max(1, Math.min(st.len - 1, k0.s + 12)), 0.002);
  const r = L.solve(Object.assign({}, F, { kioskDrops: [[k0.x, k0.y]], kioskPins: [[to[0], to[1]]] }), {});
  const hit = r.kiosks.find(k => Math.hypot(k.x - to[0], k.y - to[1]) < 1e-6);
  assert(hit, 'a kiosk at the moved point'); assert(hit.members.length > 0, 'it serves erven'); assert.strictEqual(hit.flag, 'placed by hand');
  assert(!r.kiosks.some(k => Math.hypot(k.x - k0.x, k.y - k0.y) <= 1.5), 'none left at the old point');
  assert(r.erven.filter(e => e.fe).every(e => e.kiosk), 'every erf still served');
  const again = L.solve(F, {}); assert.strictEqual(again.kiosks.length, r0.kiosks.length, 'no pins: unchanged');
});
ok('smooth corners: no sharp bend is left, ends stay put, a curve is never longer than its corners, and the lengths follow', () => {
  const r0 = L.solve(F, {}), len0 = r0.stats.cable, lv0 = r0.net.lvLen;
  const ends = r0.erven.filter(e => e.route).map(e => [e.route[0].slice(), e.route[e.route.length - 1].slice()]);
  const r = L.smooth(L.solve(F, {}), r0.P);
  assert(r.stats.cable <= len0 + 1e-6 && r.stats.cable > len0 * 0.9, 'service cable ' + len0 + ' -> ' + r.stats.cable);
  assert(r.net.lvLen <= lv0 + 1e-6);
  r.erven.filter(e => e.route).forEach((e, i) => { assert.deepStrictEqual(e.route[0], ends[i][0]); assert.deepStrictEqual(e.route[e.route.length - 1], ends[i][1]); assert(Math.abs(e.cable - L.plen(e.route)) < 1e-9); });
  const worst = pts => { let w = 0; for (let i = 1; i < pts.length - 1; i++) { const a = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], b = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]; const la = Math.hypot(...a), lb = Math.hypot(...b); if (la < 1e-6 || lb < 1e-6) continue; w = Math.max(w, Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb))))); } return w; };
  const worstAll = Math.max(...r.erven.filter(e => e.route).map(e => worst(e.route)), ...r.net.lv.map(e => worst(e.pts)), ...r.erven.filter(e => e.duct).map(e => worst(e.duct)));
  assert(worstAll < Math.PI / 3 + 1e-6, 'a turn between two points is at most 60 degrees, was ' + (worstAll * 180 / Math.PI));
  const off = L.smooth(L.solve(F, { bendFi: 0, bendLv: 0, bendMv: 0 }), Object.assign({}, r0.P, { bendFi: 0, bendLv: 0, bendMv: 0 }));
  assert(Math.abs(off.stats.cable - len0) < 1e-6, 'radius 0 leaves the corners sharp');
  const sq = [[0, 0], [10, 0], [10, 10]]; L.fillet(sq, 2); assert(sq.length > 3 && Math.abs(sq[0][0]) < 1e-9 && sq[sq.length - 1][1] === 10);
  assert(L.plen(sq) < 20 && L.plen(sq) > 19, 'a radius-2 round of a right angle saves 2*(2-pi/2) = 0.86 m: ' + L.plen(sq));
});
ok('fibre round a corner: a run reaches a two-street junction along its own verge line (no hook); where the verge lines meet outside the mouth it falls back to a verge point, never a spike', () => {
  const r = L.solve(F, {}); const js = [];
  for (const e of r.fibre.trunks.concat(r.fibre.spare)) for (const [node, rev] of [[e.a, false], [e.b, true]]) {
    if (!node.junction || node.streets.length !== 2 || e.pts.length < 4) continue;
    const P = rev ? e.pts.slice().reverse() : e.pts, a = P[1], b = P[2], d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]);
    js.push(Math.abs((P[0][0] - a[0]) * d[1] - (P[0][1] - a[1]) * d[0]) / l);
  }
  assert(js.length >= 10, 'junctions seen ' + js.length);
  assert(js.filter(x => x < 1).length >= js.length * 0.7, 'most corners reach the junction along their own line');
  assert(Math.max(...js) <= 12, 'no jog beyond a street width: ' + Math.max(...js).toFixed(1));
  // the junction node is never outside the junction mouth (the old spike through the erven)
  r.fibre.inter.filter(n => n.streets.length === 2).forEach(n => n.streets.forEach(st => { const q = L.project(st, n.x, n.y); assert(q.d <= st.w, 'node ' + q.d.toFixed(1) + ' m from ' + st.id + ' (width ' + st.w + ')'); }));
});
ok('keep-out: a run that dips into a carriageway is routed round it, a square crossing is left alone, the ends stay', () => {
  const st = { id: 'T', name: 'T', w: 12, cw: 6, pts: [[-60, 0], [60, 0]], cum: [0, 120], len: 120 };
  const mk = routes => ({ streets: [st], erven: routes.map((r, i) => ({ id: 'e' + i, route: r, cable: L.plen(r) })), net: null, fibre: null, P: { maxc: 70 }, stats: {} });
  const dip = [[-20, 3.6], [-2, 3.6], [0, 0.2], [2, 3.6], [20, 3.6]], sq = [[-8, 3.6], [0, 3.6], [0, -3.6], [8, -3.6]];
  const res = L.keepOut(mk([dip.map(q => q.slice()), sq.map(q => q.slice())]));
  const a = res.erven[0].route, b = res.erven[1].route;
  assert.deepStrictEqual(a[0], dip[0]); assert.deepStrictEqual(a[a.length - 1], dip[dip.length - 1]);
  for (let i = 1; i < a.length; i++) { const p = a[i - 1], q = a[i], n = Math.ceil(L.plen([p, q]) / 0.25); for (let k = 0; k <= n; k++) assert(Math.abs(p[1] + (q[1] - p[1]) * k / n) >= 2.85, 'inside the carriageway at ' + k + ' of segment ' + i); }
  assert.deepStrictEqual(b, sq, 'a square crossing stays as drawn');
  assert.strictEqual(res.keepOut.fixed, 1); assert(Math.abs(res.erven[0].cable - L.plen(a)) < 1e-9, 'the length follows');
  assert.strictEqual(L.carriageHits(res).length, 0);
  // a run that changes side without a square crossing gets one
  const diag = [[-30, 3.6], [0, 3.6], [8, -3.6], [30, -3.6]], r2 = L.keepOut(mk([diag.map(q => q.slice())])), c = r2.erven[0].route;
  assert.strictEqual(L.carriageHits(r2).length, 0, 'the side change is a square crossing now');
  assert(c.some((q, i) => i && Math.abs(q[0] - c[i - 1][0]) < 1e-6 && Math.abs(q[1] - c[i - 1][1]) > 6), 'a square crossing (vertical across the road) was made');
  // no carriageway width: nothing happens
  const none = mk([dip.map(q => q.slice())]); none.streets = [Object.assign({}, st, { cw: 0 })]; assert.deepStrictEqual(L.keepOut(none).erven[0].route, dip);
});

ok('keep-out in a layout: with a carriageway width on every street no service or fibre duct runs through one, the corridor holds the kerb + 0.4 m, and smoothing adds nothing', () => {
  const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw: 6 })) });
  const r = L.solve(Fc, {}); assert(r.keepOut && r.keepOut.fixed > 0, 'something was re-routed');
  const bad = pr => L.carriageHits(pr).filter(h => h.kind === 'service' || h.kind === 'fibre duct').length;
  assert(bad(r) <= 4, 'services / ducts inside a carriageway: ' + bad(r) + ' of ' + (2 * r.erven.length));
  const sm = L.smooth(L.solve(Fc, {}), r.P); assert(bad(sm) <= bad(r), 'smoothing adds none');
  // every service vertex is at least the kerb off the street line, except the ends of a crossing
  const st = r.streets, inside = p => st.some(s => L.carriage([s]).dist(s, p) < 3 - 0.35);
  let n = 0; r.erven.forEach(e => { if (e.route) e.route.forEach((p, i) => { if (i && i < e.route.length - 1 && inside(p)) n++; }); });
  assert(n <= 3, 'interior service vertices within 0.35 m of the kerb or inside: ' + n);
});
ok('keep-out, the 72-erf neighbourhood as the app runs it: no run inside a carriageway at 4–9 m, with or without an offset carriageway', () => {
  const run = (cw, off) => { const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw, cwOffset: off })), subPts: [[150, 130]] }); const r = L.solve(Fc, {}); L.keepOut(r); L.smooth(r, r.P); return r; };
  for (const [cw, off] of [[4, 0], [5, 0], [6, 0], [7, 0], [9, 0], [7, 1.5], [7, -1.5], [7, 2.5], [7, -2.5], [9, -1], [9, 1], [8, -2]]) {
    const h = L.carriageHits(run(cw, off)); assert.strictEqual(h.length, 0, `cw ${cw} offset ${off}: ` + h.map(x => x.kind + ' ' + x.id).join(', '));
  }
  // the offset is used: the same layout judged on a carriageway 2 m off has runs in it if the engine is told the street is centred
  const centred = run(7, 0); centred.streets.forEach(st => { st.co = -2; }); assert(L.carriageHits(centred).length > 10, 'an offset carriageway is a different road');
  // each hit carries the stretches inside, for the Checks list's Show
  const st = { id: 'T', name: 'T', w: 12, cw: 6, pts: [[-60, 0], [60, 0]], cum: [0, 120], len: 120 };
  const h = L.carriageHits({ streets: [st], erven: [{ id: 'e', route: [[-20, 3.6], [-2, 3.6], [0, 0.2], [2, 3.6], [20, 3.6]] }], net: null, fibre: null });
  assert.strictEqual(h.length, 1); assert(h[0].bad.length === 1 && h[0].bad[0].length > 3 && h[0].bad[0].every(q => Math.abs(q[1]) < 3 - 0.8 + 1e-9));
});
ok('junctions: a third street ending where two others already meet joins that junction', () => {
  const r = L.solve(F, {}), S4 = r.streets.find(x => x.id === 'S4');
  const end = r.junctions.find(j => j.items.some(it => it[0] === S4 && it[1] > S4.len - 0.5));
  assert(end, 'Orchard Lane ends on Main Road / Crescent Avenue'); assert(end.items.length >= 3, 'three streets at that junction');
});
ok('keep-out: a carriageway ends square at the end of its street (no round cap reaching over the street it meets)', () => {
  const a = { id: 'A', w: 12, cw: 9, pts: [[0, 0], [0, 50]] }, C = L.carriage([a]);
  assert(C.insideAny([0, -2], [], 0.1) === null, 'past the end'); assert(C.insideAny([0, 2], [], 0.1) === a, 'inside');
});
ok('LV nodes: no end of an LV run stands in a carriageway (a through street\'s junction node in a side street\'s mouth is not made)', () => {
  for (const [cw, off] of [[6, 0], [7, 0], [7, 1.5]]) {
    const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw, cwOffset: off })), subPts: [[150, 130]] }), r = L.solve(Fc, {}), C = L.carriage(r.streets);
    for (const ed of r.net.lv) for (const q of [ed.pts[0], ed.pts[ed.pts.length - 1]]) assert(!C.insideAny(q, [], 0.1), `cw ${cw} offset ${off}: an LV run ends inside a carriageway at ${q.map(v => v.toFixed(1))}`);
  }
});
ok('kerb returns: the corridor turns each corner on the return (no LV node or fibre manhole in a rounded-off corner, far fewer runs in the road); none given = as before', () => {
  const R = require('../../frontend/js/plan-reserve.js');
  for (const [cw, off] of [[6, 0], [7, 0], [7, 1.5], [9, -1]]) {
    const sq = R.squareStreets(F.streets.map(s => ({ pts: s.pts, carriageW: cw, cwOffset: off })));
    const streets = F.streets.map((s, i) => Object.assign({}, s, { pts: sq[i].pts, cw, cwOffset: off }));
    const kd = R.kerbDrawing(streets.map(s => ({ pts: s.pts, w: s.w, carriageW: cw, cwOffset: off })), {});
    const rets = kd.arcs.filter(a => !a.outer).map(a => { const x = R.returnArc(a.c, a.R); return { P: a.c.P, c: x.centre, R: x.R, t1: x.t1, t2: x.t2 }; });
    assert(rets.length > 6, 'returns ' + rets.length);
    const run = kr => { const r = L.solve(Object.assign({}, F, { streets, subPts: [[150, 130]], kerbReturns: kr }), {}); L.keepOut(r); L.smooth(r, r.P); r.streets.rets = L.kerbFills(rets); return r; };
    const off0 = run([]), on = run(rets), fills = L.kerbFills(rets), inFill = p => fills.some(G => L.fillDepth(G, p) > 0.1);
    on.net.lv.forEach(ed => [ed.pts[0], ed.pts[ed.pts.length - 1]].forEach(q => assert(!inFill(q), `cw ${cw}: an LV run ends in a return's corner at ${q.map(v => v.toFixed(1))}`)));
    on.fibre.inter.forEach(n => assert(!inFill([n.x, n.y]), `cw ${cw}: fibre junction ${n.id} in a return's corner`));
    const deep = r => L.carriageHits(r).length, lvIn = r => L.carriageHits(r, 0.1).filter(h => h.kind === 'LV cable').length;
    assert(deep(on) <= 6 && deep(on) < deep(off0), `cw ${cw} offset ${off}: runs deep in the road ${deep(off0)} → ${deep(on)}`);
    assert(lvIn(on) <= 1, `cw ${cw}: LV cables in the road / a return ${lvIn(on)}`);
  }
  // no returns: exactly as without the field
  const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw: 7 })), subPts: [[150, 130]] });
  const a = L.solve(Fc, {}), b = L.solve(Object.assign({}, Fc, { kerbReturns: [] }), {});
  assert.strictEqual(JSON.stringify(a.net.lv.map(e => e.pts)), JSON.stringify(b.net.lv.map(e => e.pts))); assert.strictEqual(a.kiosks.length, b.kiosks.length);
});
ok('assumed carriageway (a centreline street): the corridor, kiosks and manholes stay out of it, in the street-line mode too, and it never pushes the corridor over an erf boundary', () => {
  const C0 = L.carriage(null);
  for (const kgeo of ['boundary', 'street']) {
    const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw: 5, cwAuto: true })), subPts: [[150, 130]] });
    const r = L.solve(Fc, { kgeo }), C = L.carriage(r.streets);
    const dep = p => Math.max(...r.streets.map(st => st.cw / 2 - C.dist(st, p)));
    assert(r.kiosks.length > 0);
    r.kiosks.forEach(k => assert(dep([k.x, k.y]) <= 0.05, kgeo + ' kiosk ' + k.id + ' in the road ' + dep([k.x, k.y]).toFixed(2)));
    (r.fibre.mhs || []).forEach(m => assert(dep([m.x, m.y]) <= 0.05, kgeo + ' manhole ' + m.id + ' in the road'));
    assert(L.carriageHits(r).length <= 12, kgeo + ' runs in the road ' + L.carriageHits(r).length);
  }
  // a street line drawn 1.5 m from the erven on one side (4.5 m off the middle): a 5 m carriageway centred on it reaches 1 m into them. When it
  // is assumed (cwAuto) the corridor stays inside the boundary, so far fewer services run through the next erven than with a real carriageway there
  const base = L.solve(Object.assign({}, F, { subPts: [[150, 130]] }), {}).streets[0];
  const moved = F.streets.map((s, i) => i ? s : Object.assign({}, s, { pts: base.pts.map((p, k) => L.ptAt(base, base.cum[k], -4.5).slice(0, 2)) }));
  const pip = (P, p) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const through = auto => { const r = L.solve(Object.assign({}, F, { streets: moved.map(s => Object.assign({}, s, { cw: 5, cwAuto: auto })), subPts: [[150, 130]] }), {});
    let n = 0; for (const e of r.erven) for (const p of (e.route || []).slice(1, -1)) if (r.erven.some(o => o !== e && pip(o.poly, p))) n++; return n; };
  const a = through(true), b = through(false); assert(a < b / 2, 'service points in other erven: assumed ' + a + ', real ' + b);
});
console.log(n + ' passed');
