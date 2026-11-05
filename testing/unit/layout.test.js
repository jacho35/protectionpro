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
ok('mini-sub position: "opt" never has a worse worst kiosk than the middle; a placed mini-sub is kept', () => {
  const mom = (r) => { const up = new Map(r.net.lvLinks.map(l => [l.to, l])), cnt = new Map(); const c = k => { if (cnt.has(k)) return cnt.get(k); let x = k.members.length; r.net.lvLinks.filter(l => l.from === k).forEach(l => { x += c(l.to); }); cnt.set(k, x); return x; };
    let worst = 0; r.kiosks.forEach(k => { let m = 0, v = k; while (up.has(v)) { const l = up.get(v); m += c(l.to) * l.len; v = l.from; } worst = Math.max(worst, m); }); return worst; };
  const mid = L.solve(F, { subMode: 'mid', strN: 0 }), opt = L.solve(F, { subMode: 'opt', strN: 0 });
  assert(mom(opt) <= mom(mid) + 1e-6);
  const fixed = L.solve(Object.assign({}, F, { subPts: [[mid.net.sub.x, mid.net.sub.y]] }), { subMode: 'opt', strN: 0 });
  assert(Math.hypot(fixed.net.sub.x - mid.net.sub.x, fixed.net.sub.y - mid.net.sub.y) < 1e-9);
});
ok('several mini-subs: each kiosk is fed by one, the LV tree splits, Demand gets one row per mini-sub', () => {
  const one = L.solve(F, {}), r = L.solve(F, { subs: 3 });
  assert.strictEqual(r.net.subs.length, 3);
  assert(r.kiosks.every(k => k.subK && r.net.subs.some(S => S.k === k.subK)));
  assert.strictEqual(r.net.lvLinks.length, r.kiosks.length);                      // a tree per mini-sub, every kiosk fed once
  const per = r.net.subs.map(S => S.g.reduce((a, k) => a + k.members.length, 0)), tot = per.reduce((a, b) => a + b, 0);
  assert(Math.max(...per) <= Math.ceil(tot / 3 * 1.2));                           // the transformers carry similar loads
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
  const P = { n: 6, maxc: 80 }, old = L.solve(F, { knet: false }), r = L.solve(F, P), s = stats(r);
  holds(r, Object.assign({}, L.DEFAULTS, P), F.erven.length, 'fixture');
  assert(s.k <= 15, `kiosks ${s.k}`); assert(s.k <= old.kiosks.length - 3, `${s.k} vs ${old.kiosks.length} before`);
  assert(s.small <= 1, `${s.small} kiosks serve 2 erven or fewer`);
  assert(r.stats.avgPer >= 4.5, 'average erven per kiosk ' + r.stats.avgPer);
  assert(r.stats.cable <= old.stats.cable * 1.15, `service cable ${Math.round(r.stats.cable)} m vs ${Math.round(old.stats.cable)} m before`);
});
ok('kiosks: four short parallel streets of four erven need 3 kiosks at most (one per street gives 4 or more)', () => {
  const G = gridFx(50), r = L.solve(G, {}), old = L.solve(G, { knet: false });
  holds(r, Object.assign({}, L.DEFAULTS), G.erven.length, 'grid');
  assert(r.kiosks.length <= 3, 'kiosks ' + r.kiosks.length); assert(old.kiosks.length >= 4, 'before ' + old.kiosks.length);
  assert(r.kiosks.some(k => new Set(k.members.map(e => e.road.id)).size > 1), 'a kiosk serves erven of two streets');
  assert(r.stats.small <= 1);
});
ok('kiosks: the settings now have an effect (n, worth)', () => {
  const k = P => L.solve(F, P).kiosks.length;
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
ok('mini-subs placed by hand are the mini-subs: the count setting no longer adds automatic ones', () => {
  const base = L.solve(F, {}), a = L.ptAt(base.streets[0], 30, 0);
  const r = L.solve(Object.assign({}, F, { subPts: [[a[0], a[1]]] }), { subs: 3 });
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

ok('splitting a string: a kiosk becomes its own string head, fed straight off the mini-sub along the same route', () => {
  const base = L.solve(F, { subs: 1 }), deep = base.net.lvLinks.filter(l => l.from !== base.net.subs[0].k).sort((a, b) => b.len - a.len)[0];
  assert(deep, 'a kiosk that hangs off another kiosk');
  const di = L.demandInput(base, { minisubId: 'S' }).kiosks.find(k => k.id === deep.to.id);
  assert.strictEqual(di.fedFrom, deep.from.id, 'before: fed from the kiosk above it');
  const r = L.solve(Object.assign({ splits: [[deep.to.x, deep.to.y]] }, F), { subs: 1 });
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
console.log(n + ' passed');

// ── LV strings: no string longer than strN kiosks ──
const strSizes = (r) => {                                                           // kiosks in the string of each head
  const kids = new Map(r.kiosks.map(k => [k, []])); r.net.lvLinks.forEach(l => { if (kids.has(l.from)) kids.get(l.from).push(l.to); });
  const size = k => 1 + kids.get(k).reduce((a, c) => a + size(c), 0);
  return r.net.lvLinks.filter(l => !kids.has(l.from)).map(l => size(l.to));
};
ok('strings: no string has more than strN kiosks, every kiosk is still fed once', () => {
  const free = L.solve(F, { strN: 0 }), cut = L.solve(F, { strN: 4 });
  assert.strictEqual(cut.net.lvLinks.length, cut.kiosks.length);
  assert(Math.max(...strSizes(cut)) <= 4, 'sizes ' + strSizes(cut));
  assert(strSizes(cut).length >= strSizes(free).length);
  assert.strictEqual(cut.stats.strings, strSizes(cut).length);
  cut.net.lvLinks.filter(l => !cut.kiosks.includes(l.from)).forEach(l => assert(Math.hypot(l.pts[0][0] - l.from.x, l.pts[0][1] - l.from.y) < 1e-6 && Math.abs(l.len - L.plen(l.pts)) < 1e-6));
});
ok('strings: strN 0 leaves the tree as it was; "even" never has more kiosks than strN nor fewer strings than "fewest"', () => {
  const a = L.solve(F, { strN: 0 }), b = L.solve(F, { strN: 0, strMode: 'even' });
  assert.deepStrictEqual(a.net.lvLinks.map(l => l.len), b.net.lvLinks.map(l => l.len));
  const f = L.solve(F, { strN: 3 }), e = L.solve(F, { strN: 3, strMode: 'even' });
  assert(Math.max(...strSizes(e)) <= 3 && strSizes(e).length >= strSizes(f).length);
  assert(Math.max(...strSizes(e)) - Math.min(...strSizes(e)) <= Math.max(...strSizes(f)) - Math.min(...strSizes(f)));
});


