// Tests for frontend/js/plan-kerbs.js (pure geometry, no browser).
//   node testing/unit/kerbs.test.js
const assert = require('assert');
const K = require('../../frontend/js/plan-kerbs.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const line = (a, b) => [a, b];
// a straight kerb cut into loose 10 m LINE pieces, as a survey DXF has them
const loose = (x0, y0, x1, y1) => { const out = [], k = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 10); for (let i = 0; i < k; i++) out.push(line([x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k], [x0 + (x1 - x0) * (i + 1) / k, y0 + (y1 - y0) * (i + 1) / k])); return out; };
const arc = (cx, cy, r, a0, a1, m = 12) => Array.from({ length: m + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / m; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
const dToLine = (p, pts) => { let b = 1e9; for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], c = pts[i + 1], dx = c[0] - a[0], dy = c[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0; b = Math.min(b, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)); } return b; };

ok('joinPieces: loose pieces become one chain per kerb', () => {
  const ch = K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]);
  assert.strictEqual(ch.length, 2);
  assert(ch.every(c => Math.abs(len(c.pts) - 100) < 1e-6));
});

ok('a simple two-kerb road: 1 street, the real width, on the centreline', () => {
  const r = K.solve(K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]));
  assert.strictEqual(r.streets.length, 1);
  const s = r.streets[0];
  assert(Math.abs(s.w - 10) < 0.1, 'w ' + s.w);
  assert(len(s.pts) > 95 && len(s.pts) < 101, 'len ' + len(s.pts));
  assert(s.pts.every(p => Math.abs(p[1]) < 0.05));
  assert.strictEqual(r.unpaired.length, 0);
});

// T junction: main road 200 m x 12 m, side street 8 m wide going south from x = 100, fillets r = 5
const tee = () => {
  const north = [[0, 6], [200, 6]];
  const left = [[0, -6], [91, -6], ...arc(91, -11, 5, Math.PI / 2, 0).slice(1), [96, -80]];
  const right = [[200, -6], [109, -6], ...arc(109, -11, 5, Math.PI / 2, Math.PI).slice(1), [104, -80]];
  return [north, left, right];
};
ok('a T junction: 2 streets, the side street ends on the main centreline', () => {
  const r = K.solve(tee().map(pts => ({ pts })));
  assert.strictEqual(r.streets.length, 2, 'streets ' + r.streets.length);
  const main = r.streets.find(s => len(s.pts) > 150), side = r.streets.find(s => s !== main);
  assert(main && side);
  assert(Math.abs(main.w - 12) < 0.3 && Math.abs(side.w - 8) < 0.3, main.w + ' / ' + side.w);
  const top = side.pts.reduce((a, p) => p[1] > a[1] ? p : a);
  assert(Math.abs(top[1]) < 0.3 && Math.abs(top[0] - 100) < 0.3, 'side top ' + top);
  assert(main.pts.some(p => Math.hypot(p[0] - top[0], p[1] - top[1]) < 1e-6), 'one shared node');       // the junction is a vertex of both
  assert(len(main.pts) > 190, 'main bridged across the mouth ' + len(main.pts));
});

ok('a cul-de-sac bulb: one street that ends at the bulb centre', () => {
  const a = Math.atan2(-5, -Math.sqrt(144 - 25));
  const kerb = [[0, -5], ...arc(110, 0, 12, a, -a, 40), [0, 5]];
  const r = K.solve([{ pts: kerb }]);
  assert.strictEqual(r.streets.length, 1);
  const e = r.streets[0].pts[r.streets[0].pts.length - 1];
  assert(Math.hypot(e[0] - 110, e[1]) < 0.8, 'end ' + e);
  assert(Math.abs(r.streets[0].w - 10) < 0.2);
});

ok('a lone round kerb is joined to the street beside it', () => {
  const ring = arc(110, 0, 10, 0, Math.PI * 2, 60);
  const r = K.solve([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)].length ? [...K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]), { pts: ring, closed: true }] : []);
  assert.strictEqual(r.streets.length, 2, 'streets ' + r.streets.length);
  const b = r.streets.find(s => s.bulb);
  assert(b && Math.hypot(b.pts[1][0] - 110, b.pts[1][1]) < 0.01);
  assert(dToLine(b.pts[0], r.streets.find(s => !s.bulb).pts) < 0.01);
});

ok('chains with no partner are listed, not made into streets', () => {
  const r = K.solve([...K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]), { pts: [[0, 200], [60, 200]] }]);
  assert.strictEqual(r.streets.length, 1);
  assert.deepStrictEqual(r.unpaired, [2]);
});

ok('a width outside 4-20 m is not a road', () => {
  assert.strictEqual(K.solve([{ pts: [[0, 1], [100, 1]] }, { pts: [[0, -1], [100, -1]] }]).streets.length, 0);   // kerb face and back
  assert.strictEqual(K.solve([{ pts: [[0, 30], [100, 30]] }, { pts: [[0, -30], [100, -30]] }]).streets.length, 0);
});

ok('a crossroads: the street across is one street through the main road', () => {
  const E = [[0, 6], [91, 6], ...arc(91, 11, 5, -Math.PI / 2, 0).slice(1), [96, 80]];
  const F = [[200, 6], [109, 6], ...arc(109, 11, 5, -Math.PI / 2, -Math.PI).slice(1), [104, 80]];
  const G = [[0, -6], [91, -6], ...arc(91, -11, 5, Math.PI / 2, 0).slice(1), [96, -80]];
  const H = [[200, -6], [109, -6], ...arc(109, -11, 5, Math.PI / 2, Math.PI).slice(1), [104, -80]];
  const r = K.solve([E, F, G, H].map(pts => ({ pts })));
  assert.strictEqual(r.streets.length, 2, 'streets ' + r.streets.length);
  assert(r.streets.some(s => len(s.pts) > 150 && Math.abs(s.pts[0][0] - 100) < 0.5 && Math.abs(s.pts[s.pts.length - 1][0] - 100) < 0.5), 'one street across');
});

ok('pairedShare tells kerbs from centrelines', () => {
  assert(K.pairedShare(K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)])) > 0.8);
  assert(K.pairedShare([{ pts: [[0, 0], [100, 0]] }, { pts: [[50, 0], [50, 80]] }]) < 0.1);
});

ok('pairManual / attach: a street added by hand', () => {
  const ch = [{ pts: [[0, 5], [60, 5]] }, { pts: [[0, -5], [60, -5]] }];
  const s = K.pairManual(ch, 0, 1);
  assert(s && Math.abs(s.w - 10) < 0.1);
  const main = { pts: [[0, 0], [100, 0]], w: 10, chains: [] }, side = { pts: [[40, -60], [40, -3]], w: 8, chains: [] }, all = [main, side];
  K.attach(all, 1);
  assert.deepStrictEqual(side.pts[side.pts.length - 1], [40, 0]);
  assert(main.pts.some(p => p[0] === 40 && p[1] === 0));
});

ok('a narrow street whose end stops short and skews still reaches the street (reach = bridge gap, not the road width)', () => {
  const main = { pts: [[0, 0], [100, 0]], w: 5, chains: [] }, side = { pts: [[0, -60], [22, -17.7], [40, -9]], w: 5, chains: [] }, all = [main, side];
  K.attach(all, 1);
  const e = side.pts[side.pts.length - 1];
  assert(Math.abs(e[1]) < 1e-6, 'ends on the main street ' + e);
  assert.strictEqual(K.components(all).length, 1);
});

ok('components: separate networks are found, and connect joins them within the gap only', () => {
  const a = { pts: [[0, 0], [100, 0]], w: 5 }, b = { pts: [[50, 0], [50, 60]], w: 5 }, c = { pts: [[200, 0], [260, 0]], w: 5 }, d = { pts: [[110, 5], [110, 40]], w: 5 };
  const all = [a, b, c, d];
  const g = K.components(all); assert.strictEqual(g.length, 3); assert.deepStrictEqual(g[0], [0, 1]);
  assert.strictEqual(K.connect(all, 8), 0);                                    // d is 11 m from a's end: too far for 8
  assert.strictEqual(K.connect(all, 12), 1);                                   // joined at 12
  assert.strictEqual(K.components(all).length, 2);
  assert.strictEqual(K.connect(all, 50), 0);                                   // c is 100 m away: left alone, the review says so
});

ok('sides: a street read back into its two kerbs keeps the width profile', () => {
  const ch = K.joinPieces([[[0, 5], [50, 5], [100, 8]], [[0, -5], [50, -5], [100, -8]]].map(p => p));
  const r = K.solve(ch), st = r.streets[0], sd = K.sides(st, ch);
  assert(sd.a.length >= 2 && sd.b.length >= 2);
  assert(sd.a.every(p => p[1] > 0) && sd.b.every(p => p[1] < 0), 'left above, right below');
  assert(Math.abs(sd.a[0][1] - 5) < 0.3 && Math.abs(sd.b[sd.b.length - 1][1] + 8) < 0.5, 'follows the kerbs ' + JSON.stringify([sd.a[0], sd.b[sd.b.length - 1]]));
});

ok('sides: a stub run on to another street (no kerbs there) is set half the width out', () => {
  const st = { pts: [[0, 0], [30, 0]], w: 8 }, sd = K.sides(st, []);
  assert(Math.abs(sd.a[0][1] - 4) < 1e-6 && Math.abs(sd.b[0][1] + 4) < 1e-6);
});

ok('joinPieces: parts = the drawn pieces of a chain (a reversed piece too)', () => {
  const ch = K.joinPieces([[[0, 0], [10, 0]], [[20, 0], [10, 0]], [[20, 0], [35, 0]]]);
  assert.strictEqual(ch.length, 1);
  const p = ch[0].parts; assert.strictEqual(p.length, 3);
  assert(Math.abs(p[0].s1 - p[1].s0) < 1e-9 && Math.abs(p[1].s1 - p[2].s0) < 1e-9 && Math.abs(p[2].s1 - 35) < 1e-9 && Math.abs(p[1].s1 - p[1].s0 - 10) < 1e-9);
});

ok('candidates + assemble(all) give exactly what solve gives', () => {
  const ch = K.joinPieces(tee().map(pts => pts));
  const a = K.solve(ch), c = K.candidates(ch), b = K.assemble(c, 'all', [], {}, 'all');
  assert.deepStrictEqual(b.streets.map(s => [s.pts, s.w, s.chains]), a.streets.map(s => [s.pts, s.w, s.chains]));
});

// an L-shaped block: its kerb is ONE chain (L), with a straight kerb across each arm (road 10 m wide)
const lShape = () => ({
  L: K.joinPieces([[[0, 5], [100, 5], [100, 105]]]),                       // arm 1 along x, arm 2 up y
  a: K.joinPieces([[[0, -5], [95, -5]]]),                                  // across arm 1
  b: K.joinPieces([[[110, 20], [110, 105]]]),                              // across arm 2
});
const mk = () => { const x = lShape(); return { Lc: x.L[0], layers: { A: [x.L[0], x.a[0], x.b[0]] } }; };

ok('click adds every street of a kerb line; Shift-click one piece adds one and does not run on to the street not chosen', () => {
  let { layers } = mk(), T = K.stage(layers);
  assert.strictEqual(T.streets.length, 0);
  const r = T.addChain('A', 0, null); assert.strictEqual(T.streets.length, 2, JSON.stringify(r)); assert.strictEqual(r.added, 2);
  const T2 = K.stage(mk().layers); T2.addChain('A', 0, [0, 100]);                      // arm 1 only
  assert.strictEqual(T2.streets.length, 1);
  const s = T2.streets[0]; assert(Math.abs(s.w - 10) < 0.2);
  const end = s.pts[s.pts.length - 1]; assert(end[0] < 112 && Math.abs(end[1]) < 1, 'stops where the kerbs stop ' + end);
});

ok('subtract mirrors add; re-picks do nothing', () => {
  const T = K.stage(mk().layers); T.addChain('A', 0, null);
  assert(T.addChain('A', 0, null).noop, 'adding again is a no-op'); assert.strictEqual(T.picks.length, 1);
  const r = T.addChain('A', 0, [0, 100], 'sub'); assert.strictEqual(T.streets.length, 1, JSON.stringify(r));
  T.mode = 'sub'; T.addChain('A', 0, null); assert.strictEqual(T.streets.length, 0);
  assert(T.addChain('A', 0, null).noop, 'nothing left to remove');
});

ok('a kerb with no partner is lonely; pairWith a kerb 23 m away makes a street; undo, options replay', () => {
  const ch = [...K.joinPieces([[[0, 0], [100, 0]]]), ...K.joinPieces([[[0, 23], [100, 23]]])];
  const T = K.stage({ A: ch });
  T.addChain('A', 0, null); assert.strictEqual(T.streets.length, 0); assert.strictEqual(T.lonely.length, 1);
  T.armPair('A', 0); assert.strictEqual(T.pairWith('A', 1), 'added'); assert.strictEqual(T.streets.length, 1); assert.strictEqual(T.lonely.length, 0);
  assert(T.undo()); assert.strictEqual(T.streets.length, 0); assert.strictEqual(T.lonely.length, 1);
  // options replay: a road 10 m wide with wmax 8 goes lonely, back at 20 comes back
  const U = K.stage({ A: K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]) });
  U.addChain('A', 0, null); assert.strictEqual(U.streets.length, 1);
  U.setOpt({ wmax: 8 }); assert.strictEqual(U.streets.length, 0); assert.strictEqual(U.lonely.length, 1);
  U.setOpt({ wmax: 20 }); assert.strictEqual(U.streets.length, 1); assert.strictEqual(U.lonely.length, 0);
});

ok('undo: three picks, two undos = the state after the first', () => {
  const x = lShape(), road = K.joinPieces([...loose(300, 5, 400, 5), ...loose(300, -5, 400, -5)]);
  const T = K.stage({ A: [x.L[0], x.a[0], x.b[0], ...road] });
  T.addChain('A', 0, [0, 100]); const one = JSON.stringify(T.streets);
  T.addChain('A', 0, [100, 200]); T.addChain('A', 3, null); assert(T.streets.length >= 3);
  T.undo(); T.undo(); assert.strictEqual(JSON.stringify(T.streets), one);
});

ok('two layers: a line on another layer is not a partner unless "any layer" is on', () => {
  const kerbs = K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]), erf = K.joinPieces([[[0, 20], [100, 20]]]);
  const T = K.stage({ kerb: kerbs, erf });
  T.addChain('erf', 0, null); assert.strictEqual(T.streets.length, 0); assert.strictEqual(T.lonely.length, 1);
  T.addChain('kerb', 0, null); assert.strictEqual(T.streets.length, 1); assert.strictEqual(T.streets[0].layer, 'kerb');
  const U = K.stage({ kerb: kerbs, erf }); U.setAnyLayer(true); U.addChain('erf', 0, null);
  assert.strictEqual(U.streets.length, 1, 'with any layer the erf line pairs with the nearest kerb');
});

ok('pairAll(layer) = solve(chains) on that layer; subtract a street by clicking it', () => {
  const ch = K.joinPieces(tee().map(pts => pts)), T = K.stage({ A: ch }), r = K.solve(ch);
  T.pairAll('A'); assert.deepStrictEqual(T.streets.map(s => [s.pts, s.w, s.chains]), r.streets.map(s => [s.pts, s.w, s.chains]));
  T.subStreet(T.streetAt([100, -60], 3)); assert.strictEqual(T.streets.length, r.streets.length - 1);
});

ok('hitAt: whole chain and the drawn piece under the click, across layers', () => {
  const ch = K.joinPieces([[[0, 0], [10, 0]], [[10, 0], [30, 0]]]), T = K.stage({ A: ch, B: K.joinPieces([[[0, 50], [10, 50]]]) });
  const h = T.hitAt([20, 0.5], 2); assert.strictEqual(h.layer, 'A'); assert.deepStrictEqual(h.part, [10, 30]);
  assert.strictEqual(T.hitAt([5, 50], 2).layer, 'B'); assert.strictEqual(T.hitAt([5, 20], 2), null);
});

ok('stage: a road beside a lone kerb, hand-made streets join up', () => {
  const ch = [...K.joinPieces([...loose(0, 5, 100, 5), ...loose(0, -5, 100, -5)]), { pts: [[0, 60], [60, 60]] }];
  const T = K.stage({ A: ch }); T.pairAll('A');
  assert.strictEqual(T.streets.length, 1); assert.strictEqual(T.lonely.length, 1);
  T.arm('A', 2); assert(T.place([30, 50]));
  assert.strictEqual(T.streets.length, 2); assert(Math.abs(T.streets[1].pts[0][1] - 57) < 1e-6 && T.streets[1].w === 6);
  assert.strictEqual(T.networks().length, 2); assert(T.join(60) >= 1); assert.strictEqual(T.networks().length, 1);
  T.subStreet(T.streetAt([50, 57], 3)); assert.strictEqual(T.streets.length, 1);
});

// A dead-end road drawn as ONE kerb line: both kerbs and the end cap in a single chain (open U, or a closed outline)
const deadEnd = (L, w, kind) => {
  const h = w / 2;
  if (kind === 'open') return { pts: [[0, h], [L, h], [L + 1.5, h / 2], [L + 1.5, -h / 2], [L, -h], [0, -h]] };
  if (kind === 'ring') return { pts: [[0, h], [L, h], [L, -h], [0, -h], [0, h]], closed: true };
  return { pts: [[0, h + 1], [L, h], [L, -h], [0, -h - 1]] };                                   // taper: arms 1 m further apart at the mouth
};
for (const kind of ['open', 'ring', 'taper']) {
  ok(`a dead-end road drawn as one kerb line (${kind}): one street, the real width, on the centreline, 12–60 m long`, () => {
    for (const L of [12, 20, 35, 60]) for (const w of [4.5, 6]) {
      const r = K.solve([deadEnd(L, w, kind)]);
      assert.strictEqual(r.streets.length, 1, `${kind} L${L} w${w}: ${r.streets.length} streets`);
      const s = r.streets[0];
      assert(Math.abs(s.w - (kind === 'taper' ? w + 1.1 : w)) < 0.7, `${kind} L${L} w${w}: width ${s.w}`);
      assert(s.pts.every(q => Math.abs(q[1]) < 0.7), `${kind} L${L} w${w}: stays on the centreline ${JSON.stringify(s.pts)}`);
      assert(len(s.pts) > L * 0.7, `${kind} L${L} w${w}: length ${len(s.pts)}`);
      assert.deepStrictEqual(r.unpaired, []);
    }
  });
}

console.log(n + ' passed');
