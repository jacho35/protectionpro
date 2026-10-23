// Photometry pictures (frontend/js/photoview.js, no browser).
//   node testing/unit/photoview.test.js
const assert = require('assert');
global.escHtml = (s) => String(s);
const PV = require('../../frontend/js/photoview.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, e) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const D = Math.PI / 180;

// A Type C web from I(C, γ): C 0…360 every 5°, γ 0…180 every 1°.
const web = (fn, lumens = 3000) => {
  const c = [], g = [];
  for (let C = 0; C <= 360; C += 5) c.push(C);
  for (let G = 0; G <= 180; G += 1) g.push(G);
  return { name: 'test', lumens, watts: 30, c, g, cd: c.map(C => g.map(G => fn(C, G))) };
};
const N = 2.4, I0 = 1000;
const down = web((C, g) => (g < 90 ? I0 * Math.pow(Math.cos(g * D), N) : 0));
// stronger across (C90) than along: a linear fitting
const lin = web((C, g) => (g < 90 ? 800 * Math.pow(Math.cos(g * D), 1.1 + 1.6 * Math.cos(C * D) ** 2) : 0));

ok('intensity lookup is the web between its samples', () => {
  near(PV.cd(down, 0, 0), I0, 1e-9);
  near(PV.cd(down, 37.5, 30.5), I0 * Math.pow(Math.cos(30.5 * D), N), 2);
  assert.strictEqual(PV.cd(down, 0, 120), 0);
});
ok('a web with one C plane is the same all round', () => {
  const one = { lumens: 1000, c: [0], g: [0, 45, 90], cd: [[100, 50, 0]] };
  near(PV.cd(one, 123, 45), 50, 1e-9);
});
ok('beam and field angle of cos^n: 2·acos(frac^(1/n))', () => {
  const b = PV.beam(down, 0, 180, 0.5), f = PV.beam(down, 0, 180, 0.1);
  near(b.angle, 2 * Math.acos(Math.pow(0.5, 1 / N)) / D, 1.01);
  near(f.angle, 2 * Math.acos(Math.pow(0.1, 1 / N)) / D, 1.01);
  near(b.peak, 0, 1e-9);
});
ok('linear fitting: narrower along C0 than across', () => {
  assert.ok(PV.beam(lin, 0, 180, 0.5).angle < PV.beam(lin, 90, 270, 0.5).angle - 10);
  assert.ok(!PV.symmetric(lin) && PV.symmetric(down));
});
ok('downward share: all for a downlight', () => { near(PV.table(down).down, 1, 1e-9); });
ok('floor illuminance = I·cos³γ / h²', () => {
  const h = 2.5, x = 1.2, y = -0.7, r = Math.hypot(x, y), g = Math.atan2(r, h);
  near(PV.floorE(down, x, y, h), I0 * Math.pow(Math.cos(g), N) * Math.cos(g) ** 3 / (h * h), 0.5);
  near(PV.floorE(down, 0, 0, 2), I0 / 4, 1e-9);
});
ok('cone diagram: Ø = 2h·tan(β/2), Emax = I0/h²', () => {
  const c = PV.cone(down);
  const b = c.angle;
  near(c.rows[1].d, 4 * Math.tan(b / 2 * D), 1e-9);
  near(c.rows[1].e, I0 / 4, 1e-9);
  near(b, 2 * Math.acos(Math.pow(0.5, 1 / N)) / D, 1.01);
});
ok('top-view outline: a downlight is a circle, a linear fitting reaches further across', () => {
  const F = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const o = PV.outline(down, F), r = o.map(([x, y]) => Math.hypot(x, y));
  near(Math.min(...r), Math.max(...r), 1e-6);
  // max of I·sinγ for cos^n: at tanγ = 1/√n
  const gm = Math.atan(1 / Math.sqrt(N));
  near(r[0], I0 * Math.pow(Math.cos(gm), N) * Math.sin(gm), 0.02 * I0);
  const L = PV.outline(lin, F).map(([x, y]) => Math.hypot(x, y));
  assert.ok(L[18] > L[0] * 1.2);                          // C90 beyond C0
});
ok('outline turns with the fitting', () => {
  const a = 30 * D, F = [[Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const p = PV.outline(lin, F)[18], q = PV.outline(lin, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])[18];
  near(Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]), a, 1e-6);
});
ok('section curve in the C0 plane is the polar curve', () => {
  const F = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const s = PV.sectionCurve(lin, F, 1, 0);                // θ = −180…180 step 2, index 90 = nadir
  near(s[90][1], -PV.cd(lin, 0, 0), 1e-6);
  const k = 90 + 15;                                       // θ = 30° toward +x = C0
  near(Math.hypot(...s[k]), PV.cd(lin, 0, 30), 1e-6);
  const kk = 90 - 15;                                      // θ = −30° = C180
  near(Math.hypot(...s[kk]), PV.cd(lin, 180, 30), 1e-6);
  const t = PV.sectionCurve(lin, F, 0, 1)[105];            // across: C90
  near(Math.hypot(...t), PV.cd(lin, 90, 30), 1e-6);
});
ok('wall fitting aimed across: the curve swings into the room', () => {
  // facing +y, aim 90° (C0 of the web points across the room horizontally)
  const nIn = [0, 1], th = 90 * D, ey0 = [0, 1, 0];
  const F = [[nIn[1], -nIn[0], 0], [ey0[0] * Math.cos(th), ey0[1] * Math.cos(th), Math.sin(th)], [-ey0[0] * Math.sin(th), -ey0[1] * Math.sin(th), Math.cos(th)]];
  const s = PV.sectionCurve(down, F, 0, 1);
  const k = 90 + 45;                                       // θ = 90°: horizontal into the room = the web's nadir
  near(s[k][0], I0, 1e-6);
});
ok('SVGs render', () => {
  assert.ok(/<svg/.test(PV.polarSvg(down)) && /pv-beam/.test(PV.polarSvg(down)));
  const iso = PV.isoluxSvg(down, 2.5);
  assert.ok(!iso.none && /pv-iso/.test(iso.svg) && iso.Emax > 0);
  assert.ok(/<svg/.test(PV.coneSvg(PV.cone(down))));
  const up = web((C, g) => (g > 90 ? 500 : 0));
  assert.ok(PV.isoluxSvg(up, 2.5).none);
  assert.ok(/<circle class="pv-ring"/.test(PV.polarSvg(up)));   // full circles once light goes up
});
ok('marching squares: a square level set', () => {
  const V = [0, 0, 0, 0, 1, 0, 0, 0, 0];
  const s = PV.contour(V, 3, 3, 0.5);
  assert.strictEqual(s.length, 4);
});
console.log(`${n} passed`);
