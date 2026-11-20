// Tests for frontend/js/plan-blocks.js and the Auto layout's routing along the erf boundaries (PlanLayout.solve, route 'blocks').
//   node testing/unit/blocks.test.js
const assert = require('assert');
const PB = require('../../frontend/js/plan-blocks.js');
const L = require('../../frontend/js/plan-layout.js');
const township = require('./blocks-fixture.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segX = (a, b, c, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
const pip = (p, poly) => PB.pip(p, poly);
const shrink = (poly, k) => { const c = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length]; return poly.map(p => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]); };
const model = (F, o) => PB.model({ erven: F.erven, lines: F.lines, classes: { p: 2, f: 1.7 } }, Object.assign({ xpen: 20, xshare: 0 }, o || {}));

const T = township(), M = model(T);
ok('township: five blocks, five junctions, splays found on every junction leg', () => {
  assert.strictEqual(M.blocks.length, 5);
  assert.strictEqual(M.junctions.filter(j => j.legs.length >= 3).length, 5);
  assert(M.cls.p.sites.filter(x => x.kind === 'leg').length >= 10, 'leg sites ' + M.cls.p.sites.filter(x => x.kind === 'leg').length);
});
ok('every ring point is kd off its block boundary (within 5 cm)', () => {
  for (const [nm, kd] of [['p', 2], ['f', 1.7]]) for (const R of M.cls[nm].rings) for (const p of R.pts) {
    const d = PB.distBlock(R.block, p)[0]; assert(Math.abs(d - kd) < 0.05, `${nm} ring point ${d.toFixed(3)} m off the boundary`);
  }
});
ok('rough street lines (1.3 m wave, off centre, overshooting ends) move no ring and no crossing', () => {
  const W = model(township({ wob: 1.3 }));
  for (const nm of ['p', 'f']) {
    const A = M.cls[nm].rings.flatMap(R => R.pts), B = W.cls[nm].rings.flatMap(R => R.pts);
    assert.strictEqual(A.length, B.length);
    for (let i = 0; i < A.length; i += 7) assert(dist(A[i], B[i]) < 1e-6, 'ring moved');
    const sa = M.cls[nm].sites.filter(x => x.kind === 'leg'), sb = W.cls[nm].sites.filter(x => x.kind === 'leg');
    assert.strictEqual(sa.length, sb.length, 'leg sites ' + sa.length + ' / ' + sb.length);
    for (const x of sa) assert(sb.some(y => (dist(x.a, y.a) < 0.3 && dist(x.b, y.b) < 0.3) || (dist(x.a, y.b) < 0.3 && dist(x.b, y.a) < 0.3)), 'a junction crossing moved with the street line');
  }
});
ok('a street drawn in pieces: its joints are not junctions and do not stop the mid-block crossings', () => {
  const P3 = model(township({ pieces: 4 }));
  assert.strictEqual(P3.junctions.filter(j => j.legs.length >= 3).length, 5);
  assert.strictEqual(P3.cls.p.sites.filter(x => x.kind === 'mid').length, M.cls.p.sites.filter(x => x.kind === 'mid').length);
});
ok('a junction crossing is past the splay end, square to the corridor, and crosses no erf', () => {
  for (const x of M.cls.p.sites) {
    for (const E of T.erven) { const sp = shrink(E.poly, 0.999); for (let i = 0; i < sp.length; i++) assert(!segX(x.a, x.b, sp[i], sp[(i + 1) % sp.length]), 'a crossing passes over ' + E.id); }
    if (x.kind !== 'leg') continue;
    assert(Math.min(dist(x.a, x.splay[0]), dist(x.a, x.splay[1])) >= 3 - 0.3, 'closer than the set-back to the splay end');
    const R = x.Ra, i = R.pts.reduce((b, p, k) => dist(p, x.a) < dist(R.pts[b], x.a) ? k : b, 0), t = [R.pts[(i + 1) % R.pts.length][0] - R.pts[i][0], R.pts[(i + 1) % R.pts.length][1] - R.pts[i][1]];
    const u = [x.b[0] - x.a[0], x.b[1] - x.a[1]], c = Math.abs(t[0] * u[0] + t[1] * u[1]) / Math.hypot(...t) / Math.hypot(...u);
    assert(c < Math.cos(80 * Math.PI / 180), 'a junction crossing is not square to the corridor');
  }
});

// the Auto layout, routed along the erf boundaries
const solve = (F, P) => { const r = L.solve({ streets: F.streets, erven: F.erven, subPts: [[150, 66]] }, Object.assign({ maxc: 80 }, P || {})); L.smooth(r, r.P); return r; };
const R = solve(T), Rs = solve(T, { route: 'street' });
ok('solve: routed along the erf boundaries by default, every erf served within the limit', () => {
  assert.strictEqual(R.route, 'blocks');
  const served = R.erven.filter(e => e.kiosk);
  assert(served.length >= 70, 'served ' + served.length);
  served.forEach(e => { assert(e.route && e.route.length >= 2, e.id + ' has no service'); assert(e.cable <= 80 + 1e-6, e.id + ' service ' + e.cable.toFixed(1)); });
});
ok('solve: a run crosses a street line only on a crossing, and passes through no other erf', () => {
  const lines = T.lines, cross = R.net.cross;
  const onCross = (a, b) => cross.some(c => { const [p, q] = c.ends || [c.a, c.b]; const d = (u, v, w) => { const L2 = (w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2, t = Math.max(0, Math.min(1, ((u[0] - v[0]) * (w[0] - v[0]) + (u[1] - v[1]) * (w[1] - v[1])) / L2)); return dist(u, [v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t]); }; return d(a, p, q) < 1 && d(b, p, q) < 1; });
  const runs = [];
  R.erven.forEach(e => { if (e.route) runs.push(['service ' + e.id, e.route, e]); if (e.duct) runs.push(['duct ' + e.id, e.duct, e]); });
  R.net.lv.forEach((l, i) => runs.push(['LV ' + i, l.pts, null])); R.fibre.trunks.forEach((t, i) => runs.push(['trunk ' + i, t.pts, null]));
  let bad = 0;
  for (const [name, pts, own] of runs) for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (lines.some(l => l.some((p, k) => k && segX(a, b, l[k - 1], p))) && !onCross(a, b)) { bad++; if (bad < 4) console.log('  off-crossing', name, a.map(Math.round), b.map(Math.round)); }
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const E of T.erven) if ((!own || E.id !== own.id) && pip(mid, shrink(E.poly, 0.98))) assert.fail(`${name} runs through ${E.id}`);
  }
  assert.strictEqual(bad, 0, bad + ' segments cross a street line away from a crossing');
});
// the optimiser's own score: kiosks × what a kiosk is worth + service cable + road crossings by services × what one counts for
const score = r => r.kiosks.length * r.P.worth + r.stats.cable + r.P.xpen * r.net.cross.filter(c => c.svc).length;
ok('solve: a better design by the optimiser\'s own score than the street-line routing, with fewer crossings, clean or rough street lines', () => {
  for (const [a, b, what] of [[R, Rs, 'clean'], [solve(township({ wob: 1.3 })), solve(township({ wob: 1.3 }), { route: 'street' }), 'rough']]) {
    assert(score(a) < score(b), `${what} lines: score ${Math.round(score(a))} vs ${Math.round(score(b))}`);
    // services stay on the kiosk's side until they cross to their erf, which costs a few more crossings than sharing one on the far verge
    assert(a.stats.crossings <= b.stats.crossings * 1.15, `${what} lines: crossings ${a.stats.crossings} vs ${b.stats.crossings}`);
    assert(a.stats.cable < b.stats.cable * 1.3, `${what} lines: cable ${Math.round(a.stats.cable)} vs ${Math.round(b.stats.cable)}`);
  }
  // a crossing counted as little cable: about the same service cable as before
  const c = solve(T, { xpen: 20 }), d = solve(T, { xpen: 20, route: 'street' });
  assert(c.stats.cable < d.stats.cable * 1.1, `xpen 20: cable ${Math.round(c.stats.cable)} vs ${Math.round(d.stats.cable)}`);
});
ok('solve: a service stays on the kiosk\'s side of the street and crosses at the boundary nearest its erf, never along the far verge to share a crossing', () => {
  const far = r => r.erven.filter(e => e.route && e.road && e.kiosk && e.kiosk.road === e.road && (e.xsites || []).every(x => x.kind !== 'leg')).map(e => e.farLen || 0);
  const now = far(R), old = far(solve(T, { svcFar: 1 }));
  assert(now.length > 20 && now.every(v => v <= 8), 'own-street services on the far corridor: ' + now.filter(v => v > 8).map(v => v.toFixed(1)).join(', '));
  assert(old.reduce((a, b) => a + b, 0) > now.reduce((a, b) => a + b, 0), 'the far-side penalty changes nothing');
});
ok('unserviced erven: no marker, kiosk, service or duct, every other erf served, and no run crosses them (left out entirely, runs do)', () => {
  const runsThru = (r, polys) => { let n = 0; const runs = []; r.erven.forEach(e => { if (e.route) runs.push(e.route); if (e.duct) runs.push(e.duct); }); r.net.lv.forEach(l => runs.push(l.pts)); r.fibre.trunks.forEach(t => runs.push(t.pts));
    for (const pts of runs) for (let i = 1; i < pts.length; i++) for (let k = 1; k < 10; k++) { const m = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / 10, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / 10]; if (polys.some(P => pip(m, shrink(P, 0.98)))) { n++; break; } }
    return n; };
  for (const ids of [['E49', 'E50', 'E51', 'E52'], ['E61', 'E62', 'E63', 'E64']]) {
    const polys = T.erven.filter(e => ids.includes(e.id)).map(e => e.poly);
    const uns = solve({ streets: T.streets, erven: T.erven.map(e => ids.includes(e.id) ? Object.assign({}, e, { unserviced: true }) : e) });
    const gone = solve({ streets: T.streets, erven: T.erven.filter(e => !ids.includes(e.id)) });
    assert(!uns.erven.some(e => ids.includes(e.id)), 'an unserviced erf was laid out');
    assert.strictEqual(uns.erven.filter(e => e.kiosk).length, T.erven.length - ids.length, 'not every other erf served');
    assert.strictEqual(runsThru(uns, polys), 0, ids + ': a run crosses an unserviced erf');
    assert(runsThru(gone, polys) > 0, ids + ': the fixture does not test it (runs go round open land too)');
  }
});
ok('solve: kiosks and manholes stand on their corridor', () => {
  R.kiosks.forEach(k => { const B = R.blocks.blocks.map(b => PB.distBlock(b, [k.x, k.y])[0]).sort((a, b) => a - b)[0]; assert(Math.abs(B - 2) < 0.1, 'kiosk ' + B.toFixed(2) + ' m off'); });
  R.fibre.mhs.forEach(m => { const B = R.blocks.blocks.map(b => PB.distBlock(b, [m.x, m.y])[0]).sort((a, b) => a - b)[0]; assert(Math.abs(B - 1.7) < 0.1, 'manhole ' + B.toFixed(2) + ' m off'); });
});
ok('trenches follow the corridors: one per crossing, runs along the rings', () => {
  const tr = L.trenches(R, {});
  assert.strictEqual(tr.list.filter(t => t.kind === 'crossing').length, R.net.cross.filter(c => c.svc || c.lv || c.fib || c.prov).length);
  assert(tr.list.some(t => t.kind === 'run' && t.type === 'LV/SL') && tr.list.some(t => t.kind === 'run' && t.type === 'FI'));
  tr.list.filter(t => t.kind === 'run').forEach(t => t.pts.forEach(p => { const d = R.blocks.blocks.map(b => PB.distBlock(b, p)[0]).sort((a, b) => a - b)[0]; assert(d > 1.5 && d < 2.1, 'a trench run ' + d.toFixed(2) + ' m off the boundary'); }));
});
ok('crossing rule: per cable class keeps fibre apart, mid-block first uses fewer junction legs', () => {
  const C = solve(T, { xrule: 'class' }), Mi = solve(T, { xrule: 'mid' });
  assert(C.net.cross.length >= R.net.cross.length, `class ${C.net.cross.length} vs leg ${R.net.cross.length}`);
  assert(!C.net.cross.some(c => c.fib && (c.svc || c.lv)), 'a crossing shared by fibre and power under the per-class rule');
  const legs = r => r.net.cross.filter(c => c.kind === 'leg' && !c.prov).length;
  assert(legs(Mi) <= legs(R), `legs ${legs(Mi)} vs ${legs(R)}`);
});
ok('the old street-line routing is still there on request', () => { assert.notStrictEqual(Rs.route, 'blocks'); assert(Rs.stats.crossings > 0); });

// a road inside one block: a dead-end street with erven round its end (a U-shaped block)
ok('a U-shaped block gets crossings between its two arms', () => {
  const erven = [];
  for (let i = 0; i < 5; i++) { erven.push({ id: 'N' + i, poly: [[i * 15, 0], [i * 15 + 15, 0], [i * 15 + 15, 25], [i * 15, 25]] }); erven.push({ id: 'S' + i, poly: [[i * 15, 37], [i * 15 + 15, 37], [i * 15 + 15, 62], [i * 15, 62]] }); }
  erven.push({ id: 'END', poly: [[75, 0], [100, 0], [100, 62], [75, 62]] });
  const lines = [[[-20, 31], [75, 31]], [[-20, -30], [-20, 90]]];
  const U = PB.model({ erven, lines, classes: { p: 2 } }, {});
  const blk = U.blockOf.get('N0'); assert.strictEqual(blk, U.blockOf.get('S0'), 'one block');
  assert(U.cls.p.sites.filter(x => x.kind === 'mid' && x.Ra.block === x.Rb.block).length >= 3, 'no crossing between the arms');
});

// five organic townships (curved streets, corner erven cut back by the crossing reserve with a 3 m splay): a loop with a cul-de-sac, Y
// junctions, a staggered T, a skew crossroads with a crescent and a roundabout; each also with its street lines drawn rough (3 m off
// centre, wavy), and with a junction moved and the erven laid out again round it
const O = require('./organic-fixture.js');
const MOVES = [{ A: [20, 0], C: [15, 0] }, { A: [22, 2], B: [16, -10] }, { B: [-22, 0] }, { A: [18, 4], B: [10, -25] }, { A: [12, 8] }];
const safe = (F, r, truthLines, truthJ) => {
  const lines = truthLines || F.lines, J = truthJ || r.blocks.junctions.filter(j => j.legs.length >= 3), cross = r.net.cross;
  const sdist = (u, v, w) => { const L2 = (w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2 || 1e-9, t = Math.max(0, Math.min(1, ((u[0] - v[0]) * (w[0] - v[0]) + (u[1] - v[1]) * (w[1] - v[1])) / L2)); return dist(u, [v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t]); };
  const onX = (a, b) => cross.some(c => [c.ends || [c.a, c.b], ...(c.sites || []).map(x => [x.a, x.b])].some(([p, q]) => sdist(a, p, q) < 1.2 && sdist(b, p, q) < 1.2));
  const runs = []; r.erven.forEach(e => { if (e.route) runs.push([e.route, e.id]); if (e.duct) runs.push([e.duct, e.id]); }); r.net.lv.forEach(l => runs.push([l.pts, null])); r.fibre.trunks.forEach(t => runs.push([t.pts, null]));
  let off = 0, thru = 0, mouth = 0;
  for (const [pts, own] of runs) for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (lines.some(l => l.some((p, k) => k && segX(a, b, l[k - 1], p))) && !onX(a, b)) off++;
    for (const E of F.erven) if (E.id !== own && pip(m, shrink(E.poly, 0.98))) thru++;
    for (const j of J) if (sdist(j.pt, a, b) < 3.5 && !onX(a, b)) mouth++;
  }
  return { off, thru, mouth };
};
const solveO = F => { const ev = F.erven.flatMap(e => e.poly), c = [ev.reduce((t, p) => t + p[0], 0) / ev.length, ev.reduce((t, p) => t + p[1], 0) / ev.length];
  let r = L.solve({ streets: F.streets, erven: F.erven, subPts: [c] }, { maxc: 80 }); const nd = r.blocks.cls.p.attach(c);      // the mini-sub on the corridor nearest the middle
  r = L.solve({ streets: F.streets, erven: F.erven, subPts: [r.blocks.cls.p.nodes[nd].p.slice()] }, { maxc: 80 }); L.smooth(r, r.P); return r; };
O.designs().forEach((d, i) => ok(`organic ${d.name}: every erf served within 80 m; no run crosses a road off a crossing, enters a junction mouth or passes through another erf (as drawn, rough lines, junction moved)`, () => {
  const F = O.build(d), r = solveO(F), Fr = O.rough(F, 3, 5 + i), rr = solveO(Fr), Fm = O.build(O.designs(MOVES[i])[i]), rm = solveO(Fm);
  const cases = [['as drawn', F, r, safe(F, r)], ['rough lines', Fr, rr, safe(Fr, rr, F.lines, r.blocks.junctions.filter(j => j.legs.length >= 3))], ['junction moved', Fm, rm, safe(Fm, rm)]];
  for (const [what, G2, rx, s] of cases) {
    assert(G2.erven.length >= 44, `${what}: ${G2.erven.length} erven`);
    assert.strictEqual(rx.erven.filter(e => e.kiosk).length, G2.erven.length, `${what}: not every erf served`);
    assert.strictEqual(rx.stats.over, 0, `${what}: ${rx.stats.over} services over 80 m`);
    assert.deepStrictEqual(s, { off: 0, thru: 0, mouth: 0 }, `${what}: ${JSON.stringify(s)}`);
    assert.strictEqual(rx.net.cross.filter(c => c.kind === 'link').length, 0, `${what}: a straight link across a road`);
  }
  // every leg of every junction has its crossing where erven line both sides of it (a roundabout's ring has the island on one side)
  const want = [[2, 2, 3], [3, 3], [3, 2], [4, 3, 3], [1, 1, 1, 1]][i], got = r.blocks.junctions.filter(j => j.legs.length >= 3).map(j => r.blocks.cls.p.sites.filter(x => x.kind === 'leg' && x.j === j.id).length);
  assert.deepStrictEqual(got.slice().sort(), want.slice().sort(), 'junction crossings ' + JSON.stringify(got));
}));
ok('organic: rough street lines (±1 m) move a junction crossing by no more than 0.3 m in the curved designs', () => {
  for (const i of [1, 2, 4]) { const F = O.build(O.designs()[i]), m = X => PB.model({ erven: X.erven, lines: X.lines, classes: { p: 2 } }, {});
    const A = m(F).cls.p.sites.filter(x => x.kind === 'leg'), B = m(O.rough(F, 1, 5 + i)).cls.p.sites.filter(x => x.kind === 'leg');
    assert.strictEqual(A.length, B.length);
    for (const x of A) assert(B.some(y => Math.max(dist(x.a, y.a), dist(x.b, y.b)) < 0.3 || Math.max(dist(x.a, y.b), dist(x.b, y.a)) < 0.3), O.designs()[i].name + ': a junction crossing moved'); }
});
console.log(n + ' passed');
