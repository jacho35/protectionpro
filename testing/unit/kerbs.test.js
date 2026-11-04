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

console.log(n + ' passed');
