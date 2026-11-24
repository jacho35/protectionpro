// Organic townships for the routing tests (testing/unit/blocks.test.js). Generator: curved streets (Catmull-Rom through control points), erven fanned along both sides of every street,
// cut back by a crossing street's reserve and splayed 3 m at corners, overlaps dropped. Metres, y down.
'use strict';
const RES = 6.5;                                                    // half the road reserve (13 m)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1], len = a => Math.hypot(a[0], a[1]), nrm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
function spline(ctrl, step = 2) {
  const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]], out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]], n = Math.max(2, Math.ceil(len(sub(p2, p1)) / step));
    for (let k = 0; k < n; k++) { const t = k / n, t2 = t * t, t3 = t2 * t; out.push([0, 1].map(d => .5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3))); }
  }
  out.push(ctrl[ctrl.length - 1].slice()); return out;
}
function prep(pts) { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1]))); return { pts, cum, L: cum[cum.length - 1] }; }
function at(st, s) { s = Math.max(0, Math.min(st.L, s)); let i = 1; while (i < st.cum.length - 1 && st.cum[i] < s) i++; const a = st.pts[i - 1], b = st.pts[i], t = (s - st.cum[i - 1]) / ((st.cum[i] - st.cum[i - 1]) || 1); return { p: add(a, mul(sub(b, a), t)), t: nrm(sub(b, a)) }; }
function proj(st, p) { let best = null; for (let i = 1; i < st.pts.length; i++) { const a = st.pts[i - 1], b = st.pts[i], d = sub(b, a), L2 = dot(d, d) || 1e-9, t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)), q = add(a, mul(d, t)), dd = len(sub(p, q)); if (!best || dd < best.d) best = { d: dd, s: st.cum[i - 1] + t * Math.sqrt(L2), side: Math.sign(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) || 1, q, t: nrm(d) }; } return best; }
// clip a polygon to the half-plane f(p) >= 0 (f linear)
function clip(poly, f) { const out = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b); if (fa >= 0) out.push(a); if ((fa >= 0) !== (fb >= 0)) out.push(add(a, mul(sub(b, a), fa / (fa - fb)))); } return out; }
const area = P => { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
const pip = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const segX = (a, b, c, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
function overlaps(A0, B0) {
  const sh = P => { const c = [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length]; return P.map(p => [c[0] + (p[0] - c[0]) * 0.97, c[1] + (p[1] - c[1]) * 0.97]); }, A = sh(A0), B = sh(B0);   // touching edges are not an overlap
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segX(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
  const c = P => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
  return pip(c(A), B) || pip(c(B), A);
}
// design = { streets: [{ id, ctrl, endOn: [streetId|null, streetId|null] }], lot: { w: [min, max], d: [min, max] }, seed, ringIds }
function build(design) {
  let seed = design.seed || 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const streets = design.streets.map(s => ({ id: s.id, raw: s, ...prep(s.pts ? s.pts.map(p => p.slice()) : spline(s.ctrl)) }));
  const byId = Object.fromEntries(streets.map(s => [s.id, s]));
  // snap an end onto the street it ends on (a T)
  for (const s of streets) (s.raw.endOn || []).forEach((oid, k) => { if (!oid) return; const o = byId[oid], i = k ? s.pts.length - 1 : 0, q = proj(o, s.pts[i]); s.pts[i] = q.q.slice(); Object.assign(s, prep(s.pts)); });
  // where each street meets another: [street, station on it, other street]
  const meets = [];
  for (const A of streets) for (const B of streets) { if (A === B) continue;
    for (let i = 1; i < A.pts.length; i++) for (let j = 1; j < B.pts.length; j++) if (segX(A.pts[i - 1], A.pts[i], B.pts[j - 1], B.pts[j])) { const p = A.pts[i]; meets.push({ A, B, sA: proj(A, p).s, p }); }
    for (const e of [0, A.L]) { const p = at(A, e).p, q = proj(B, p); if (q.d < 0.5) meets.push({ A: B, B: A, sA: q.s, p: q.q }); } }
  const erven = [], W = design.lot.w, D = design.lot.d;
  const order = streets.slice().sort((a, b) => b.L - a.L);
  for (const st of order) for (const side of [1, -1]) {
    let s = 2;
    while (s < st.L - 4) {
      const w = W[0] + rnd() * (W[1] - W[0]), d = D[0] + rnd() * (D[1] - D[0]), e = Math.min(st.L, s + w);
      const a = at(st, s), b = at(st, e), na = [-a.t[1] * side, a.t[0] * side], nb = [-b.t[1] * side, b.t[0] * side];
      // y down: the normal (−ty, tx) points to the left of travel in screen terms; `side` flips it
      let poly = [add(a.p, mul(na, RES)), add(b.p, mul(nb, RES)), add(b.p, mul(nb, RES + d)), add(a.p, mul(na, RES + d))];
      // cut back by every other street's reserve the lot lies beside, and splay the corner 3 m
      for (const O of streets) {
        if (O === st) continue;
        const c = [poly.reduce((t, p) => t + p[0], 0) / 4, poly.reduce((t, p) => t + p[1], 0) / 4], q = proj(O, c);
        if (q.d > RES + d + w + 10) continue;
        if (q.s < 1 || q.s > O.L - 1) { // beyond that street's end: only its end point matters (a T stem's end lies on this street)
          continue; }
        const sd = q.side, f = p => { const r = proj(O, p); return (r.side === sd ? r.d : -r.d) - RES; };
        poly = clip(poly, f); if (poly.length < 3) break;
        const g = p => { const r1 = proj(st, p), r2 = proj(O, p); return (r1.d - RES) + ((r2.side === sd ? r2.d : -r2.d) - RES) - 3; };
        poly = clip(poly, g); if (poly.length < 3) break;
      }
      s = e;
      if (poly.length < 3 || area(poly) < 0.55 * w * d) continue;
      // never in another street's reserve, never over another erf
      if (streets.some(O => O !== st && poly.some(p => proj(O, p).d < RES - 0.3))) continue;
      if (erven.some(E => overlaps(E.poly, poly))) continue;
      erven.push({ id: 'E' + (erven.length + 1), poly: poly.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]) });
    }
  }
  return { erven, streets: streets.map(s => ({ id: s.id, name: s.id, w: 13, pts: s.pts })), lines: streets.map(s => s.pts), meets };
}
// a rough drawing of the same streets: every street line moved off centre and wavy, ends overshooting
function rough(F, amp, seed = 3) {
  let sd = seed; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const streets = F.streets.map(s => { const ph = rnd() * 6, off = (rnd() - 0.5) * amp; const P = prep(s.pts);
    const pts = s.pts.map((p, i) => { const t = at(P, P.cum[i]).t, n = [-t[1], t[0]], w = off + amp * 0.6 * Math.sin(P.cum[i] / 19 + ph); return [p[0] + n[0] * w, p[1] + n[1] * w]; });
    return { ...s, pts }; });
  return { ...F, streets, lines: streets.map(s => s.pts) };
}
// Five designs of about 50 erven: a loop with a cul-de-sac, Y junctions, a staggered T, a skew crossroads with a crescent, a roundabout.
// `mv` moves a junction ({ A: [dx, dy], … } per design, see the tests) and the erven are laid out again round it.
const circle = (c, r, n = 40) => { const p = []; for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI; p.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } return p; };
const designs = (mv = {}) => {
  const m = (id, v) => (mv[id] || [0, 0]), sh = (p, id) => [p[0] + m(id)[0], p[1] + m(id)[1]];
  return [
    { name: 'D1 Loop and cul-de-sac', lot: { w: [15, 19], d: [24, 29] }, seed: 11, streets: [
      { id: 'S0', ctrl: [[-20, 84], [80, 112], [160, 96], [262, 104]] },
      { id: 'S1', ctrl: [sh([55, 108], 'A'), [48, 45], [105, 8], [170, 20], sh([195, 100], 'B')], endOn: ['S0', 'S0'] },
      { id: 'S2', ctrl: [sh([108, 9], 'C'), [118, 40], [122, 62]], endOn: ['S1', null] } ] },
    { name: 'D2 Y junctions', lot: { w: [15, 19], d: [24, 29] }, seed: 23, streets: [
      { id: 'S0', ctrl: [[0, 0], [90, 10], [180, 42], [255, 92]] },
      { id: 'S1', ctrl: [sh([88, 10], 'A'), [150, -28], [235, -48]], endOn: ['S0', null] },
      { id: 'S2', ctrl: [sh([150, -28], 'B'), [152, -82], [125, -128]], endOn: ['S1', null] } ] },
    { name: 'D3 Staggered T', lot: { w: [15, 19], d: [24, 29] }, seed: 37, streets: [
      { id: 'S0', ctrl: [[0, 0], [110, 5], [220, -4], [300, 0]] },
      { id: 'S1', ctrl: [sh([110, 5], 'A'), [104, -60], [118, -112]], endOn: ['S0', null] },
      { id: 'S2', ctrl: [sh([138, 4], 'B'), [143, 68], [128, 118]], endOn: ['S0', null] } ] },
    { name: 'D4 Skew crossroads and crescent', lot: { w: [15, 19], d: [24, 29] }, seed: 41, streets: [
      { id: 'S0', ctrl: [[20, 2], [100, 10], [200, 40], [252, 52]] },
      { id: 'S1', ctrl: [[62, -105], sh([108, 9], 'A'), [148, 105]] },
      { id: 'S2', ctrl: [sh([75, -72], 'B'), [150, -78], [215, -30], [232, 47]], endOn: ['S1', 'S0'] } ] },
    { name: 'D5 Roundabout', lot: { w: [15, 19], d: [24, 29] }, seed: 53, streets: [
      { id: 'R', pts: circle(sh([150, 0], 'A'), 17) },
      { id: 'L1', ctrl: [[133, 0], [70, 12], [0, 6]], endOn: ['R', null] },
      { id: 'L2', ctrl: [[167, 0], [230, -14], [295, -28]], endOn: ['R', null] },
      { id: 'L3', ctrl: [[150, -17], [158, -80], [150, -140]], endOn: ['R', null] },
      { id: 'L4', ctrl: [[150, 17], [130, 70], [95, 120]], endOn: ['R', null] } ] },
  ];
};
module.exports = { build, rough, designs };
