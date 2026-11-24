const assert = require('assert');
const A = require('../../frontend/js/plan-dxf-area.js');
const sq = [[0, 0], [10, 0], [10, 10], [0, 10]], bb = A.bbox(sq);
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

// a line through the square is cut at both edges; one inside is kept as it is; one outside goes
assert(near(A.clipPolyline([-5, 5, 15, 5], false, sq, bb)[0], [0, 5, 10, 5]));
assert.strictEqual(A.clipPolyline([2, 2, 8, 8], false, sq, bb), null);
assert.deepStrictEqual(A.clipPolyline([20, 20, 30, 30], false, sq, bb), []);
// a polyline leaving and coming back: two pieces
const zig = A.clipPolyline([2, 5, 15, 5, 15, 8, 2, 8], false, sq, bb);
assert.strictEqual(zig.length, 2);
assert(near(zig[0], [2, 5, 10, 5]) && near(zig[1], [10, 8, 2, 8]));
// a closed outline crossing the edge: the piece over its start is one piece
const ring = A.clipPolyline([5, 2, 15, 2, 15, 8, 5, 8], true, sq, bb);
assert.strictEqual(ring.length, 1);
assert(near(ring[0], [10, 8, 5, 8, 5, 2, 10, 2]));
// a concave outline (U): a line across it gives two pieces
const U = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]];
assert.strictEqual(A.clipPolyline([-1, 6, 11, 6], false, U, A.bbox(U)).length, 2);

// clipData: cut vs whole; blocks by insertion point; extents of what is left
const data = {
  bbox: [0, 0, 100, 100], layers: [], blocks: {},
  entities: [
    { t: 'l', l: '0', p: [-5, 5, 15, 5] },
    { t: 'l', l: '0', p: [50, 50, 60, 60] },
    { t: 'c', l: '0', p: [11, 5, 2] },
    { t: 'p', l: '0', g: 'HATCH', c: true, p: [8, 8, 12, 8, 12, 12, 8, 12] },
    { t: 'x', l: '0', p: [3, 3], s: 'A', h: 1 },
  ],
  inserts: [{ b: 'X', l: '0', p: [5, 5] }, { b: 'X', l: '0', p: [80, 80] }],
};
const cut = A.clipData(data, { pts: sq, edge: 'cut' });
assert.strictEqual(cut.entities.length, 4);                // the far line goes
assert(near(cut.entities[0].p, [0, 5, 10, 5]));            // cut at the edge
assert.strictEqual(cut.entities[2].g, 'HATCH');             // a hatch is never cut
assert.strictEqual(cut.inserts.length, 1);
assert(near(cut.bbox, [0, 3, 10, 10]));
const whole = A.clipData(data, { pts: sq, edge: 'whole' });
assert(near(whole.entities[0].p, [-5, 5, 15, 5]));         // kept complete
assert.strictEqual(whole.count, 5);
assert.strictEqual(data.entities.length, 5);               // the stored drawing is untouched
assert.deepStrictEqual(A.stats(data, sq), { kept: 5, total: 7 });

// strays: the backend's bbox leaves out isolated far items; they are counted
const grid = []; for (let i = 0; i <= 10; i++) grid.push({ t: 'l', p: [i, 0, i, 10] }, { t: 'l', p: [0, i, 10, i] });
const far = { bbox: [0, 0, 10, 10], entities: grid.concat([{ t: 'o', p: [5000, 5000] }]), inserts: [] };
const st = A.strays(far);
assert.strictEqual(st.n, 1);
assert(near(st.full, [0, 0, 5000, 5000]));
assert.strictEqual(A.strays({ bbox: [0, 0, 10, 10], entities: [{ t: 'l', p: [0, 0, 10, 10] }], inserts: [] }).n, 0);
console.log('dxfarea ok');
// two strays, one further in than the other on one axis: both trimmed
const ents2 = [];
for (let i = 0; i < 60; i++) ents2.push({ t: 'l', p: [i, 0, i, 50] });
ents2.push({ t: 'o', p: [50000, 40000] }, { t: 'l', p: [-30000, 9000, -29990, 9000] });
const two = A.strays({ bbox: [0, 0, 59, 9000], entities: ents2, inserts: [] });
assert.strictEqual(two.n, 2);
assert(near(two.main, [0, 0, 59, 50]));
console.log('dxfarea strays ok');
