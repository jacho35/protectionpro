// Room outlines from a shape (frontend/js/roomshape.js, no browser).
//   node testing/unit/roomshape.test.js
const assert = require('assert');
const RS = require('../../frontend/js/roomshape.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const box = (p) => [Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))];

ok('rectangle: four corners, w × d', () => {
  const p = RS.outline('rect', { w: 6, d: 4 });
  assert.deepStrictEqual(p, [[0, 0], [6, 0], [6, 4], [0, 4]]);
  assert.strictEqual(RS.area(p), 24);
});
ok('L: six corners, area = w·d − a·b', () => {
  const p = RS.outline('L', { w: 8, d: 6, a: 4, b: 3 });
  assert.strictEqual(p.length, 6);
  assert.strictEqual(RS.area(p), 8 * 6 - 4 * 3);
});
ok('T: eight corners, area = w·b + a·(d − b), stem centred', () => {
  const p = RS.outline('T', { w: 10, d: 8, a: 4, b: 3 });
  assert.strictEqual(p.length, 8);
  assert.strictEqual(RS.area(p), 10 * 3 + 4 * 5);
  assert.ok(p.some(q => q[0] === 3 && q[1] === 8) && p.some(q => q[0] === 7 && q[1] === 8));
});
ok('U: eight corners, area = w·d − a·b', () => {
  const p = RS.outline('U', { w: 10, d: 8, a: 4, b: 4 });
  assert.strictEqual(p.length, 8);
  assert.strictEqual(RS.area(p), 80 - 16);
});
ok('turning keeps the area, swaps the box at 90° / 270°, starts at the origin', () => {
  for (const shape of ['rect', 'L', 'T', 'U']) {
    const d = RS.SHAPES[shape].dims, a0 = RS.area(RS.outline(shape, d, 0));
    for (const t of RS.TURNS) {
      const p = RS.outline(shape, d, t);
      assert.ok(Math.abs(RS.area(p) - a0) < 1e-9, `${shape} ${t}`);
      assert.strictEqual(Math.min(...p.map(q => q[0])), 0);
      assert.strictEqual(Math.min(...p.map(q => q[1])), 0);
      assert.deepStrictEqual(box(p), t % 180 ? [d.d, d.w] : [d.w, d.d]);
    }
  }
});
ok('L turned 90° moves the cut-out to the bottom right', () => {
  const p = RS.outline('L', { w: 8, d: 6, a: 4, b: 3 }, 90);   // box 6 × 8
  const inside = (x, y) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  assert.ok(!inside(5.5, 7.5) && inside(0.5, 0.5) && inside(5.5, 0.5));
});
ok('impossible sizes are refused with a reason', () => {
  assert.strictEqual(RS.problem('rect', { w: 6, d: 4 }), '');
  assert.match(RS.problem('rect', { w: 0, d: 4 }), /Width/);
  assert.match(RS.problem('L', { w: 8, d: 6, a: 8, b: 3 }), /less than the width/);
  assert.match(RS.problem('U', { w: 10, d: 8, a: 4, b: 9 }), /less than the depth/);
});
ok('any shape: the corners as drawn, moved to the origin, any number of them', () => {
  const pts = [[2, 1], [9, 1], [11, 4], [11, 7], [2, 7]];
  const p = RS.outline('poly', { pts });
  assert.deepStrictEqual(p, [[0, 0], [7, 0], [9, 3], [9, 6], [0, 6]]);
  assert.strictEqual(RS.area(p), 7 * 6 + (2 * 3) / 2 + 2 * 3);
  assert.strictEqual(RS.problem('poly', { pts }), '');
});
ok('any shape: crossing walls, too few or doubled corners are refused', () => {
  assert.match(RS.problem('poly', { pts: [[0, 0], [4, 4], [4, 0], [0, 4]] }), /cross/);
  assert.match(RS.problem('poly', { pts: [[0, 0], [4, 0]] }), /at least 3/);
  assert.match(RS.problem('poly', { pts: [[0, 0], [4, 0], [4, 0.01], [0, 3]] }), /on top of each other/);
  assert.match(RS.problem('poly', { pts: [[0, 0], [4, 0], [8, 0.0001]] }), /no area/);
});
ok('a wall length moves the corners after it along that wall; square corners stay square', () => {
  const L = [[0, 0], [4, 0], [4, 3], [8, 3], [8, 6], [0, 6]];
  const p = RS.setWallLength(L, 0, 5);                   // first wall 4 → 5 m
  assert.deepStrictEqual(p, [[0, 0], [5, 0], [5, 3], [9, 3], [9, 6], [1, 6]]);
  assert.deepStrictEqual(RS.setWallLength(L, 5, 3), L);  // the closing wall can't be set
  const q = RS.setWallLength(L, 1, 2);                   // the 3 m wall down → 2 m
  assert.deepStrictEqual(q.slice(2), [[4, 2], [8, 2], [8, 5], [0, 5]]);
});
console.log(`${n} passed`);
