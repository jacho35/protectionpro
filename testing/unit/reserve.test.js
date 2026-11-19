// Tests for frontend/js/plan-reserve.js (pure geometry, no browser).
//   node testing/unit/reserve.test.js
const assert = require('assert');
const R = require('../../frontend/js/plan-reserve.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (x, y, w, h) => [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]];
const poly = pts => pts.map((p, i) => [p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]]);
const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
const wa = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// blocks of erven (outlines only, no road outline), roads 14 m wide, a working area round the estate
const blocks = (cols, rows, bw, bh, road) => {
  const segs = []; for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) segs.push(...rect(road + i * (bw + road), road + j * (bh + road), bw, bh));
  return { segs, wa: wa(0, 0, road + cols * (bw + road), road + rows * (bh + road)) };
};

ok('a 3 x 2 grid of blocks: one region with 6 holes, contours = outer + 6', () => {
  const d = blocks(3, 2, 80, 60, 14), T = R.stage(d.segs, d.wa);
  const r = T.click([7, 7], 'add'); assert(r.ok, JSON.stringify(r));
  const rings = T.contours(); assert.strictEqual(rings.length, 7, 'rings ' + rings.length);
  assert(T.inside(7, 7) && !T.inside(40, 40), 'the block interiors are not road space');
});

ok('erf boundaries only: a click inside a block is a different region, and an open drawing leaks', () => {
  const d = blocks(2, 1, 80, 60, 14), T = R.stage(d.segs, d.wa);
  const r = T.click([50, 40], 'add'); assert(r.ok); assert(T.inside(50, 40) && !T.inside(7, 7));
  const open = R.stage(d.segs, null), r2 = open.click([101, 44], 'add');
  assert(!r2.ok && r2.reason === 'not-enclosed', 'no working area: the road runs out of the drawing');
});

ok('streets of the grid: 14 m wide, none through a block, split at every intersection', () => {
  const d = blocks(3, 2, 80, 60, 14), T = R.stage(d.segs, d.wa); T.click([7, 7], 'add');
  const r = T.streets(), sp = R.split(r.streets);
  assert(r.streets.length >= 7, 'through streets ' + r.streets.length);
  assert(r.streets.every(s => Math.abs(s.w - 14) < 1), 'widths ' + r.streets.map(s => s.w));
  for (const s of r.streets) for (const p of s.pts) assert(T.inside(p[0], p[1]), 'on the road space ' + p);
  assert(sp.streets.length > r.streets.length, 'cut at the junctions');
  assert.strictEqual(sp.junctions.filter(j => j.legs.length === 4).length, 2, 'crossroads ' + JSON.stringify(sp.junctions.map(j => j.legs.length)));
  assert.strictEqual(sp.junctions.length, 12, 'every crossing of the 3 + 4 streets is a junction');
});

ok('a single outline per street, two adjacent ones: the seam between them goes', () => {
  const T = R.stage([...rect(0, 0, 100, 14), ...rect(100, 0, 100, 14)], null);
  T.click([50, 7], 'add'); const a = T.areaM2(); T.click([150, 7], 'add');
  assert(T.inside(100, 7), 'the shared outline is no wall between two picked reserves');
  assert(T.areaM2() > a * 1.9, 'both are in');
  const rings = T.contours(); assert.strictEqual(rings.length, 1, 'one outer ring, no hole at the seam');
});

ok('a T junction reserve with splays: 3 streets, one junction with 3 legs, widths 13 / 13 / 10', () => {
  // main road 13 m along x (y 0..13), a side street 10 m wide going south at x 95..105, 3 m splays
  const pts = [[0, 13], [200, 13], [200, 0], [108, 0], [105, -3], [105, -80], [95, -80], [95, -3], [92, 0], [0, 0]];
  const T = R.stage(poly(pts), null); assert(T.click([50, 6], 'add').ok);
  const sp = R.split(T.streets().streets), js = sp.junctions.filter(j => j.legs.length >= 3);
  assert.strictEqual(js.length, 1, 'junctions ' + JSON.stringify(sp.junctions.map(j => j.legs.length)));
  assert.strictEqual(sp.streets.length, 3, 'streets ' + sp.streets.length);
  const ws = sp.streets.map(s => s.w).sort(); assert(Math.abs(ws[0] - 10) < 1 && Math.abs(ws[2] - 13) < 1, ws);
});

ok('a crossroads: 4 streets, one junction, 4 corners', () => {
  const pts = [[0, 0], [95, 0], [95, -80], [105, -80], [105, 0], [200, 0], [200, 13], [105, 13], [105, 90], [95, 90], [95, 13], [0, 13]];
  const T = R.stage(poly(pts), null); assert(T.click([20, 6], 'add').ok);
  const sp = R.split(T.streets().streets), j = sp.junctions.find(j => j.legs.length === 4);
  assert(j && sp.streets.length === 4, JSON.stringify(sp.junctions.map(x => x.legs.length)) + ' ' + sp.streets.length);
  const byId = {}; sp.streets.forEach(s => byId[s.id] = s);
  assert.strictEqual(R.corners(j, byId).length, 4);
});

ok('a cul-de-sac with a bulb: the street ends near the bulb centre', () => {
  const th0 = Math.PI - Math.asin(7 / 15), ring = [[0, 14]]; for (let k = 0; k <= 40; k++) { const a = th0 - 2 * th0 * k / 40; ring.push([100 + 15 * Math.cos(a), 7 + 15 * Math.sin(a)]); } ring.push([0, 0]);
  const T = R.stage(poly(ring), null); assert(T.click([30, 7], 'add').ok);
  const r = T.streets().streets; assert.strictEqual(r.length, 1, 'streets ' + r.length);
  const s = r[0], end = s.pts[s.pts.length - 1].concat(s.pts[0]);
  assert(Math.abs(s.w - 14) < 1.5, 'w ' + s.w);
  assert(Math.max(s.pts[0][0], s.pts[s.pts.length - 1][0]) > 80, 'runs on towards the bulb ' + JSON.stringify(s.pts));
});

ok('cut line: a cut across a reserve splits the pick; subtracting one half leaves one street', () => {
  const T = R.stage(rect(0, 0, 200, 14), null); T.click([20, 7], 'add');
  T.cut([[100, -2], [100, 16]]);
  assert(!T.inside(100, 7), 'the cut is not road space'); assert(T.inside(50, 7) && T.inside(150, 7));
  assert(T.click([150, 7], 'sub').ok); assert(!T.inside(150, 7) && T.inside(50, 7));
  const s = T.streets().streets; assert.strictEqual(s.length, 1); assert(len(s[0].pts) < 110);
});

ok('undo replays the picks', () => {
  const T = R.stage(rect(0, 0, 200, 14), null); T.click([20, 7], 'add'); T.cut([[100, -2], [100, 16]]); assert(T.undo()); assert(T.inside(100, 7));
  assert(T.undo()); assert(T.empty()); assert(!T.undo());
});

ok('drawn polygon adds, Alt subtracts', () => {
  const T = R.stage(rect(0, 0, 200, 14), null); T.polygon([[0, 0], [100, 0], [100, 14], [0, 14]], false); assert(T.inside(50, 7) && !T.inside(150, 7));
  T.polygon([[40, 0], [60, 0], [60, 14], [40, 14]], true); assert(!T.inside(50, 7));
});

ok('kerb return: 90° corner, R = 8 -> tangent length 8, arc midpoint on the bisector; the drag inverts it; clamped on a short leg', () => {
  const j = { key: 'j', x: 0, y: 0, legs: [{ id: 'a', atEnd: false, dir: [1, 0], len: 100, ang: 0 }, { id: 'b', atEnd: false, dir: [0, 1], len: 100, ang: Math.PI / 2 }] };
  const byId = { a: { id: 'a', w: 12, carriageW: 6 }, b: { id: 'b', w: 12, carriageW: 6 } };
  const [c] = R.corners(j, byId); assert(c, 'corner'); assert(Math.abs(c.P[0] - 3) < 1e-9 && Math.abs(c.P[1] - 3) < 1e-9, 'kerbs meet at (3,3) ' + c.P);
  const a = R.returnArc(c, 8); assert(Math.abs(a.t - 8) < 1e-9);
  assert(Math.abs(a.centre[0] - 11) < 1e-9 && Math.abs(a.centre[1] - 11) < 1e-9, 'centre ' + a.centre);
  assert(Math.abs(a.mid[0] - (11 - 8 / Math.SQRT2)) < 1e-9);
  assert(Math.abs(R.radiusFromDrag(c, a.mid) - 8) < 0.01, 'round trip ' + R.radiusFromDrag(c, a.mid));
  j.legs[0].len = 6; const [c2] = R.corners(j, byId); assert(R.returnArc(c2, 30).R < 30, 'clamped by the short leg');
});

ok('carriageway: width and offset from the centre', () => {
  const k = R.kerbLines({ pts: [[0, 0], [100, 0]], carriageW: 6, cwOffset: 1 });
  assert(Math.abs(k.left[0][1] - 4) < 1e-9 && Math.abs(k.right[0][1] + 2) < 1e-9, JSON.stringify(k));
});

ok('outer radius: a corner of two streets gets an outer arc on the same centre, radius = inner + carriageway width; kerbs end at the arcs', () => {
  const d = R.kerbDrawing([{ pts: [[0, 0], [60, 0]], carriageW: 7, w: 16 }, { pts: [[60, 0], [60, 60]], carriageW: 7, w: 16 }], {});
  assert.strictEqual(d.corners.length, 1); const inner = d.arcs.find(a => !a.outer), outer = d.arcs.find(a => a.outer);
  assert(inner && outer, 'both arcs'); assert(Math.abs(inner.R - 8) < 1e-9 && Math.abs(outer.R - 15) < 1e-9, inner.R + ' / ' + outer.R);
  const a = R.returnArc(d.corners[0], 8); assert(Math.hypot(a.centre[0] - a.outer.centre[0], a.centre[1] - a.outer.centre[1]) < 1e-9, 'concentric');
  assert.strictEqual(d.kerbs.length, 4);
  const ends = d.kerbs.map(k => [k[0], k[k.length - 1]]).flat(), arcEnds = d.arcs.flatMap(x => [x.pts[0], x.pts[x.pts.length - 1]]);
  for (const q of arcEnds) assert(ends.some(e => Math.hypot(e[0] - q[0], e[1] - q[1]) < 1e-6), 'a kerb ends at every arc end ' + q);
  for (const k of d.kerbs) for (const p of k) assert(!(p[0] > 48.5 + 1e-6 && p[1] < 11.5 - 1e-6), 'no kerb inside the corner ' + p);
  // the arcs are smooth: every chord within 3 cm of the circle
  for (const x of [a, a.outer]) for (let i = 1; i < x.pts.length; i++) { const m = [(x.pts[i][0] + x.pts[i - 1][0]) / 2, (x.pts[i][1] + x.pts[i - 1][1]) / 2]; assert(x.R - Math.hypot(m[0] - x.centre[0], m[1] - x.centre[1]) < 0.031); }
  // the drag sets the inner radius; the outer follows
  assert(Math.abs(R.returnArc(d.corners[0], 12).outer.R - 19) < 1e-9);
});
ok('outer radius: the legs in either order give the inner corner (the outside used to be the only one tried)', () => {
  for (const flip of [false, true]) {
    const legs = [{ id: 'a', atEnd: false, dir: [1, 0], len: 100, ang: 0 }, { id: 'b', atEnd: false, dir: [0, -1], len: 100, ang: -Math.PI / 2 }];
    const j = { key: 'j', x: 0, y: 0, legs: flip ? legs.reverse() : legs.sort((p, q) => p.ang - q.ang) }, byId = { a: { id: 'a', w: 12, carriageW: 6 }, b: { id: 'b', w: 12, carriageW: 6 } };
    const cs = R.corners(j, byId); assert.strictEqual(cs.length, 1, 'one corner'); assert(Math.abs(cs[0].theta - Math.PI / 2) < 1e-9 && cs[0].outer, 'the 90° one, with an outer radius');
  }
});
ok('bends: one street turning 90° is a corner like two streets; a turn under 30° is not; a T has no outer radius', () => {
  const b = R.kerbDrawing([{ pts: [[0, 0], [60, 0], [60, 60]], carriageW: 7, w: 16 }], {});
  assert.strictEqual(b.corners.length, 1); assert.deepStrictEqual(b.arcs.map(a => a.outer).sort(), [false, true]);
  const g = R.kerbDrawing([{ pts: [[0, 0], [60, 0], [60 + 60 * Math.cos(0.35), 60 * Math.sin(0.35)]], carriageW: 7, w: 16 }], {});
  assert.strictEqual(g.corners.length, 0, 'a 20° bend stays a bend of the kerb line');
  const t = R.kerbDrawing([{ pts: [[0, 0], [90, 0]], carriageW: 7, w: 16 }, { pts: [[45, 0], [45, 60]], carriageW: 7, w: 16 }], {});
  assert.strictEqual(t.corners.length, 2); assert(t.arcs.every(a => !a.outer));
  const near = t.kerbs.filter(k => k.every(p => Math.abs(p[1] - 3.5) < 1e-6)); assert.strictEqual(near.length, 2, 'the through kerb is broken at the mouth');
  assert(near.every(k => k.every(p => p[0] <= 33.5 + 1e-6 || p[0] >= 56.5 - 1e-6)), 'nothing across the mouth');
});
ok('bends: the road reserve of an L (its centre line cuts the corner with a chamfer) gives one corner at the meeting point of the two centre lines', () => {
  const T = R.stage(poly([[0, 0], [116, 0], [116, 100], [100, 100], [100, 16], [0, 16]]), null); assert(T.click([50, 8], 'add').ok);
  const st = R.split(T.streets().streets).streets.map(x => Object.assign(x, { carriageW: 7, cwOffset: 0 })), d = R.kerbDrawing(st, {});
  assert.strictEqual(d.junctions.length, 1, 'junctions ' + d.junctions.length); const j = d.junctions[0];
  assert(Math.abs(j.x - 108) < 1 && Math.abs(j.y - 8) < 1, 'at the corner ' + j.x + ',' + j.y);
  assert(Math.abs(d.corners[0].theta - Math.PI / 2) < 0.05, 'a 90° corner'); assert(d.arcs.some(a => a.outer));
});
console.log(n + ' passed');
