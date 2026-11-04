// Pure-geometry tests for frontend/js/plan-roomdetect.js (no browser).
//   node testing/unit/roomdetect.test.js
const assert = require('assert');
const D = require('../../frontend/js/plan-roomdetect.js');
const area = (p) => Math.abs(D._signedArea(p));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const rect = (x0, y0, x1, y1) => [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];

ok('simple rectangle', () => {
  const r = D.fromSegments(rect(0, 0, 6, 4), [3, 2], { gap: 0 });
  assert(r.ok); assert.strictEqual(r.points.length, 4); assert(Math.abs(r.area - 24) < 1e-6);
});
ok('click outside → not enclosed', () => {
  const r = D.fromSegments(rect(0, 0, 6, 4), [10, 2], { gap: 0 });
  assert(!r.ok && r.reason === 'not-enclosed');
});
ok('L-shape keeps 6 vertices, exact area', () => {
  const L = [[0,0,10,0],[10,0,10,4],[10,4,4,4],[4,4,4,8],[4,8,0,8],[0,8,0,0]];
  const r = D.fromSegments(L, [2, 2], { gap: 0 });
  assert(r.ok); assert.strictEqual(r.points.length, 6); assert(Math.abs(r.area - 56) < 1e-6);
});
ok('two rooms sharing a wall (T junction splits)', () => {
  const s = rect(0, 0, 10, 4).concat([[5, 0, 5, 4]]);
  const a = D.fromSegments(s, [2, 2], { gap: 0 }), b = D.fromSegments(s, [8, 2], { gap: 0 });
  assert(a.ok && b.ok); assert(Math.abs(a.area - 20) < 1e-6 && Math.abs(b.area - 20) < 1e-6);
});
ok('crossing segments are split', () => {
  const s = [[0,0,10,0],[10,0,10,10],[10,10,0,10],[0,10,0,0],[-2,5,12,5]];   // wall overshoots both sides
  const r = D.fromSegments(s, [5, 2], { gap: 0 });
  assert(r.ok && Math.abs(r.area - 50) < 1e-6);
});
ok('door gap bridged, closed by wall ends', () => {
  // right wall has a 1.0 opening
  const s = [[0,0,6,0],[6,0,6,1.5],[6,2.5,6,4],[6,4,0,4],[0,4,0,0]];
  assert(!D.fromSegments(s, [3, 2], { gap: 0 }).ok);
  const r = D.fromSegments(s, [3, 2], { gap: 1.2 });
  assert(r.ok && Math.abs(r.area - 24) < 1e-6 && r.bridged === 1);
});
ok('gap larger than the setting stays open', () => {
  const s = [[0,0,6,0],[6,0,6,1.0],[6,3.0,6,4],[6,4,0,4],[0,4,0,0]];
  assert(!D.fromSegments(s, [3, 2], { gap: 1.2 }).ok);
});
ok('wall stopping short of a perpendicular wall is bridged', () => {
  const s = [[0,0,6,0],[6,0,6,4],[6,4,0,4],[0,4,0,0],[3,0,3,1.5]];   // spur, not an enclosure
  const r = D.fromSegments(s, [1, 2], { gap: 1.0 });
  assert(r.ok);
});
ok('island column inside the room is ignored', () => {
  const s = rect(0, 0, 10, 10).concat(rect(4, 4, 5, 5));
  const r = D.fromSegments(s, [1, 1], { gap: 0 });
  assert(r.ok && Math.abs(r.area - 100) < 1e-6);
});
ok('click inside the island column returns the column', () => {
  const s = rect(0, 0, 10, 10).concat(rect(4, 4, 6, 6));
  const r = D.fromSegments(s, [5, 5], { gap: 0 });
  assert(r.ok && Math.abs(r.area - 4) < 1e-6);
});
ok('dangling stubs in the room do not poison the face', () => {
  const s = rect(0, 0, 10, 10).concat([[5, 0, 5, 3]]);
  const r = D.fromSegments(s, [2, 5], { gap: 0 });
  assert(r.ok && Math.abs(r.area - 100) < 1e-6 && r.points.length === 4);
});
ok('too large is refused', () => {
  const r = D.fromSegments(rect(0, 0, 100, 100), [50, 50], { gap: 0, maxArea: 5000 });
  assert(!r.ok && r.reason === 'too-large');
});
ok('polyline room with arc corner uses flattened segments', () => {
  const data = { entities: [
    { t: 'p', l: 'A-WALL', c: true, p: [0,0, 8,0, 8,6, 0,6] },
    { t: 'l', l: 'A-DOOR', p: [3, 0, 3, 6] },
  ] };
  const segs = D.segmentsFromDxf(data, l => l === 'A-WALL');
  assert.strictEqual(segs.length, 4);
  assert(D.fromSegments(segs, [4, 3], { gap: 0 }).ok);
  const withDoor = D.segmentsFromDxf(data, () => true);
  assert(Math.abs(D.fromSegments(withDoor, [1, 3], { gap: 0 }).area - 18) < 1e-6);
});

// ── raster ──
function image(w, h, draw) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const px = (x, y) => { const i = (y * w + x) * 4; data[i] = data[i+1] = data[i+2] = 0; };
  draw(px); return { w, h, data };
}
const thickRect = (px, x0, y0, x1, y1, t) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
    if (x < x0 + t || x > x1 - t || y < y0 + t || y > y1 - t) px(x, y);
};
ok('raster rectangle (wall 4px) traced to its inner face', () => {
  const img = image(200, 150, px => thickRect(px, 20, 20, 180, 130, 4));
  const r = D.fromRaster(img, [100, 70], { gapPx: 0 });
  assert(r.ok, r.reason);
  assert.strictEqual(r.points.length, 4);
  const expect = (180 - 20 - 7) * (130 - 20 - 7);
  assert(Math.abs(r.areaPx - expect) / expect < 0.03, `${r.areaPx} vs ${expect}`);
});
ok('raster with a 20px door opening, gapPx 24 seals it', () => {
  const img = image(200, 150, px => {
    thickRect(px, 20, 20, 180, 130, 4);
  });
  // knock a door out of the right wall (white it out)
  for (let y = 60; y < 80; y++) for (let x = 176; x < 181; x++) { const i = (y * 200 + x) * 4; img.data[i] = img.data[i+1] = img.data[i+2] = 255; }
  assert(!D.fromRaster(img, [100, 70], { gapPx: 0 }).ok);
  const r = D.fromRaster(img, [100, 70], { gapPx: 24 });
  assert(r.ok, r.reason);
  const expect = 153 * 103;
  assert(Math.abs(r.areaPx - expect) / expect < 0.05, `${r.areaPx} vs ${expect}`);
});
ok('raster L-shape has 6 corners', () => {
  const img = image(220, 200, px => {
    const t = 4;
    const L = [[20,20,200,20],[200,20,200,100],[200,100,100,100],[100,100,100,180],[100,180,20,180],[20,180,20,20]];
    for (const [a,b,c,d] of L) for (let y = Math.min(b,d)-2; y <= Math.max(b,d)+2; y++) for (let x = Math.min(a,c)-2; x <= Math.max(a,c)+2; x++) px(x, y);
  });
  const r = D.fromRaster(img, [50, 50], { gapPx: 0 });
  assert(r.ok, r.reason); assert.strictEqual(r.points.length, 6);
});
ok('raster click on wall / outside plan', () => {
  const img = image(100, 100, px => thickRect(px, 10, 10, 90, 90, 4));
  assert(D.fromRaster(img, [11, 50], { gapPx: 0 }).reason === 'on-wall');
  assert(!D.fromRaster(img, [3, 3], { gapPx: 0 }).ok);
});

// ── every closed region at once ──
ok('all: a plan of 3 rooms gives 3 polygons, outside left out', () => {
  const s = rect(0, 0, 12, 4).concat([[4, 0, 4, 4], [8, 0, 8, 4]]);
  const r = D.allFromSegments(s, { gap: 0 });
  assert.strictEqual(r.length, 3);
  assert(r.every(x => Math.abs(x.area - 16) < 1e-6 && D._pip(x.seed, x.points)));
});
ok('all: door gaps decide how many rooms', () => {
  const s = [[0,0,12,0],[12,0,12,4],[12,4,0,4],[0,4,0,0],[4,0,4,1.5],[4,2.5,4,4]];   // 1.0 opening in the divider
  assert.strictEqual(D.allFromSegments(s, { gap: 0 }).length, 1);
  assert.strictEqual(D.allFromSegments(s, { gap: 1.2 }).length, 2);
});
ok('all: L-shape seed is inside; thick-wall slivers dropped by minWidth', () => {
  const L = [[0,0,10,0],[10,0,10,4],[10,4,4,4],[4,4,4,8],[4,8,0,8],[0,8,0,0]];
  const r = D.allFromSegments(L, { gap: 0 });
  assert.strictEqual(r.length, 1); assert(D._pip(r[0].seed, r[0].points));
  const dbl = rect(0, 0, 10, 6).concat(rect(0.2, 0.2, 9.8, 5.8));   // double-line wall
  assert.strictEqual(D.allFromSegments(dbl, { gap: 0, minWidth: 0.6 }).length, 1);
});
ok('all: outline drawn apart from its partitions yields the rooms only', () => {
  const s = rect(0, 0, 10, 4).concat(rect(1, 1, 4, 3), rect(5, 1, 9, 3));   // floating rooms inside an outline
  assert.strictEqual(D.allFromSegments(s, { gap: 0 }).length, 2);
});
ok('all (raster): three rooms, outside excluded, door gap closes', () => {
  const img = image(260, 120, px => { thickRect(px, 10, 10, 250, 110, 4); thickRect(px, 10, 10, 90, 110, 4); thickRect(px, 90, 10, 170, 110, 4); });
  for (let y = 50; y < 70; y++) for (let x = 86; x < 95; x++) { const i = (y * 260 + x) * 4; img.data[i] = img.data[i+1] = img.data[i+2] = 255; }
  assert.strictEqual(D.allFromRaster(img, { gapPx: 0 }).length, 2);          // 2 + 1 merged
  const r = D.allFromRaster(img, { gapPx: 26 });
  assert.strictEqual(r.length, 3);
  assert(r.every(x => D._pip(x.seed, x.points)));
});
console.log(n + ' passed');
