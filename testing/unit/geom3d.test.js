// Pure helpers of the 3D views (no browser).   node testing/unit/geom3d.test.js
const assert = require('assert');
const G = require('../../frontend/js/geom3d.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const close = (a, b, e = 1e-6) => assert(Math.abs(a - b) < e, `${a} vs ${b}`);

// View3D's projection (view3d.js _cam / project), repeated here so the test pins the contract
function project(p, t, W, H, yaw, pitch, radius, zoom, pan) {
  const y = yaw * Math.PI / 180, q = pitch * Math.PI / 180, cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(q), sp = Math.sin(q);
  const S = Math.min(W, H) / (2.2 * radius) * zoom;
  const dx = p[0] - t[0], dy = p[1] - t[1], dz = p[2] - t[2], u = dx * cy - dy * sy, v = dx * sy + dy * cy;
  return [W / 2 + pan[0] + u * S, H / 2 + pan[1] - (dz * cp + v * sp) * S];
}

ok('fitCamera puts all 8 corners inside the viewport at every angle and aspect, using most of it', () => {
  const min = [-3, -2, 0], max = [14, 9, 6];
  const t = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  for (const [W, H] of [[540, 740], [1200, 500], [800, 800], [300, 900]]) {
    for (const yaw of [0, 33, 150, 230, 301]) {
      for (const pitch of [12, 32, 60, 89]) {
        const f = G.fitCamera(min, max, W, H, yaw, pitch, 0.06);
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
          const s = project([x, y, z], t, W, H, yaw, pitch, f.radius, f.zoom, f.pan);
          x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]);
        }
        assert(x0 >= W * 0.06 - 0.5 && x1 <= W * 0.94 + 0.5 && y0 >= H * 0.06 - 0.5 && y1 <= H * 0.94 + 0.5, `${W}x${H} yaw ${yaw} pitch ${pitch}: ${[x0, x1, y0, y1].map(Math.round)}`);
        assert(Math.abs((x0 + x1) / 2 - W / 2) < 1 && Math.abs((y0 + y1) / 2 - H / 2) < 1, 'centred');
        assert((x1 - x0) > W * 0.87 || (y1 - y0) > H * 0.87, 'fills the limiting side');
      }
    }
  }
});
ok('faceNormal: floor up, wall sideways, tilted plane', () => {
  assert.deepStrictEqual(G.faceNormal([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]).map(x => Math.abs(x) < 1e-9 ? 0 : x), [0, 0, 1]);
  const w = G.faceNormal([[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]]); close(Math.abs(w[0]), 1);
  const t = G.faceNormal([[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1]]); close(Math.hypot(...t), 1); close(t[1], -t[2]);
});
ok('lightFactor: a face toward the light is brighter than one turned away, never black', () => {
  const L = G.LIGHT, d = Math.hypot(...L.dir), toward = L.dir.map(x => x / d), away = toward.map(x => -x);
  assert(G.lightFactor(toward) > G.lightFactor(away));
  assert(G.lightFactor(away) >= 0.18);
  assert(G.lightFactor([0, 0, 1]) > G.lightFactor([0, 0, -1]));
});
ok('shadeColor handles hex, rgb and rgba and leaves others alone', () => {
  assert.strictEqual(G.shadeColor('#808080', 0.5), 'rgb(64,64,64)');
  assert.strictEqual(G.shadeColor('rgb(100, 200, 50)', 2), 'rgb(200,255,100)');
  assert.strictEqual(G.shadeColor('rgba(100,100,100,0.4)', 0.5), 'rgba(50,50,50,0.4)');
  assert.strictEqual(G.shadeColor('red', 0.5), 'red');
  assert.deepStrictEqual(G.parseColor('#ff0000'), [1, 0, 0, 1]);
  assert.deepStrictEqual(G.parseColor('rgba(0,255,0,0.5)'), [0, 1, 0, 0.5]);
});
const area2 = (pts, tris) => tris.reduce((a, t) => { const [p, q, r] = t.map(i => pts[i]); const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
  return a + Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2; }, 0);
ok('triangulate: convex quad, concave L, tilted plane and a 25-point wall keep their area', () => {
  const quad = [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]];
  close(area2(quad, G.triangulate(quad)), 12);
  const L = [[0, 0, 0], [6, 0, 0], [6, 2, 0], [2, 2, 0], [2, 5, 0], [0, 5, 0]];   // area 12 + 6 = 18 - concave
  const tl = G.triangulate(L); assert.strictEqual(tl.length, 4); close(area2(L, tl), 6 * 2 + 2 * 3);
  const tilt = [[0, 0, 0], [4, 0, 0], [4, 3, 1.5], [0, 3, 1.5]];
  close(area2(tilt, G.triangulate(tilt)), 4 * Math.hypot(3, 1.5));
  const wall = [[0, 0, 0], [10, 0, 0]]; for (let k = 24; k >= 0; k--) wall.push([k * 10 / 24, 0, 3 + Math.min(k, 24 - k) * 0.1]);
  const tw = G.triangulate(wall); assert.strictEqual(tw.length, wall.length - 2);
  const rev = L.slice().reverse(); close(area2(rev, G.triangulate(rev)), 18);
});
ok('triangulate: every triangle of the L stays inside it (no triangle across the notch)', () => {
  const L = [[0, 0, 0], [6, 0, 0], [6, 2, 0], [2, 2, 0], [2, 5, 0], [0, 5, 0]];
  const inside = (x, y) => (x >= 0 && x <= 6 && y >= 0 && y <= 2) || (x >= 0 && x <= 2 && y >= 0 && y <= 5);
  for (const t of G.triangulate(L)) { const c = t.map(i => L[i]).reduce((a, p) => [a[0] + p[0] / 3, a[1] + p[1] / 3], [0, 0]); assert(inside(c[0], c[1]), JSON.stringify(c)); }
});
ok('layoutLabels: nothing overlaps, the high priority label keeps its spot, a hopeless pile drops the lowest', () => {
  const mk = (x, y, prio) => ({ x, y, w: 120, h: 14, prio });
  const L = [mk(300, 200, 1), mk(300, 200, 5), mk(305, 203, 3), mk(500, 100, 0)];
  const r = G.layoutLabels(L, 800, 600);
  assert(r[1].shown && r[1].x === 300 && r[1].y === 200 && !r[1].leader);
  const shown = r.map((p, i) => ({ p, l: L[i] })).filter(o => o.p.shown);
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i], b = shown[j];
    const ox = Math.abs(a.p.x - b.p.x) < (a.l.w + b.l.w) / 2 && Math.abs((a.p.y - a.l.h / 2) - (b.p.y - b.l.h / 2)) < (a.l.h + b.l.h) / 2;
    assert(!ox, `labels ${i} and ${j} overlap`);
  }
  assert(r[3].shown && !r[3].leader);
  assert(r[0].leader || !r[0].shown);
  const pile = Array.from({ length: 40 }, (_, i) => mk(300, 200, 40 - i));
  const rp = G.layoutLabels(pile, 800, 600); assert(rp[0].shown && rp.filter(p => p.shown).length < 40);
});
ok('lerpAngle takes the short way round and ease is smooth', () => {
  close(G.lerpAngle(350, 10, 0.5), 360); close(G.lerpAngle(10, 350, 0.5), 0); close(G.lerpAngle(0, 90, 1), 90); close(G.lerpAngle(30, 30, 0.7), 30);
  close(G.ease(0), 0); close(G.ease(1), 1); close(G.ease(0.5), 0.5); assert(G.ease(0.25) < 0.25 && G.ease(0.75) > 0.75);
});
console.log(n + ' passed');
