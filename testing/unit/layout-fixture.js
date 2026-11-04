// A curved neighbourhood in metres (streets through control points, lots fanned along them) for the layout tests and the in-app check.
const L = require('../../frontend/js/plan-layout.js');
// ── a curved neighbourhood in metres: streets through control points, lots fanned along them ──
function fixture() {
  const N = { M0: [13, 223], M1: [100, 208], M2: [207, 230], M3: [303, 208], M4: [387, 230], C1: [50, 150], C2: [77, 80], C3: [167, 33], C4: [280, 30], C5: [360, 73], C6: [343, 150], I1: [130, 133], I2: [217, 117], I3: [297, 133], Z1: [217, 163] };
  const defs = [
    { id: 'S0', name: 'Main Road', nodes: ['M0', 'M1', 'M2', 'M3', 'M4'] }, { id: 'S1', name: 'Crescent Avenue', nodes: ['M1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'M3'] },
    { id: 'S2', name: 'Inner Drive', nodes: ['C1', 'I1', 'I2', 'I3', 'C6'] }, { id: 'S3', name: 'Bluegum Close', nodes: ['I2', 'Z1'] }, { id: 'S4', name: 'Orchard Lane', nodes: ['I3', 'M3'] }];
  const spline = pts => { const out = [], P = [pts[0], ...pts, pts[pts.length - 1]]; for (let i = 1; i < P.length - 2; i++) { const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]]; for (let k = 0; k < 16; k++) { const t = k / 16, t2 = t * t, t3 = t2 * t; out.push([0, 1].map(d => .5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3))); } } out.push(pts[pts.length - 1].slice()); return out; };
  const streets = defs.map(d => ({ id: d.id, name: d.name, w: 12, pts: spline(d.nodes.map(k => N[k])) }));
  // lots: regular fans on both sides of each street, then drop what overlaps
  const rnd = (() => { let s = 11; return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const st = streets.map(s => Object.assign({}, s)); const eng = L.solve({ streets, erven: [] }, {});   // only to reuse its street maths
  const S = eng.streets, junc = eng.junctions;
  const erven = []; const polys = [];
  const inter = (a, b) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a[0], a[1], b[0]) * o(a[0], a[1], b[1]) < 0 && o(b[0], b[1], a[0]) * o(b[0], b[1], a[1]) < 0; };
  const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  for (const s of ['S3', 'S4', 'S2', 'S1', 'S0']) {
    const st = S.find(x => x.id === s), stops = st.stops;
    for (let g = 0; g < stops.length - 1; g++) {
      const a = stops[g] + 11, b = stops[g + 1] - 11; if (b - a < 14) continue;
      const nl = Math.max(1, Math.round((b - a) / 16));
      for (const sg of [1, -1]) {
        let pos = a;
        for (let i = 0; i < nl; i++) {
          const e = pos + (b - a) / nl, f0 = L.ptAt(st, pos, sg * 6), f1 = L.ptAt(st, e, sg * 6), d = 21 + rnd() * 5;
          const poly = [f0.slice(0, 2), f1.slice(0, 2), L.ptAt(st, e, sg * (6 + d)).slice(0, 2), L.ptAt(st, pos, sg * (6 + d)).slice(0, 2)];
          pos = e;
          let bad = false;
          for (const o of S) for (const q of [...poly, ...poly.map((p, i) => [(p[0] + poly[(i + 1) % 4][0]) / 2, (p[1] + poly[(i + 1) % 4][1]) / 2])]) if (L.project(o, q[0], q[1]).d < 6 - .8) { bad = true; break; }
          if (!bad) for (const o of polys) { const c = [poly.reduce((s, p) => s + p[0], 0) / 4, poly.reduce((s, p) => s + p[1], 0) / 4]; if (poly.some((p, i) => pip(c[0] + (p[0] - c[0]) * .85, c[1] + (p[1] - c[1]) * .85, o)) || pip(c[0], c[1], o) || o.some((p, i) => pip(p[0], p[1], poly))) { bad = true; break; } }
          if (!bad) { polys.push(poly); erven.push({ id: 'E' + (erven.length + 1), poly }); }
        }
      }
    }
  }
  return { streets, erven };
}

module.exports = fixture;
