/*
 * SLLayout — the pure planner behind the site plan's Street lighting layout (node-testable: testing/unit/sl-layout.test.js),
 * in metres. It never sizes anything: the splitting into circuits, the cable and the breaker are the street-light engine's
 * (POST /analysis/street-lighting/split, backend/analysis/street_lighting.py `split_strings`).
 *
 *   plan({ poles: [{ id, x, y }], streets: [{ id, name, pts: [[x, y]], corr }], feeds: [{ id, x, y, name }], o })
 *
 * - Each pole goes to the nearest street within `o.snapM` (40 m) and to its side of it (+1 left / −1 right, looking along the
 *   street's points). A street side is a GROUP: its own string(s), never crossing the road.
 * - The cable of a group runs on a CORRIDOR: the street line offset to that side by `corr` (m from the centre line: the road
 *   section's LV line when the trench is shared), else by the poles' own median distance (the pole line). Each pole is reached by
 *   a short tail from its foot on the corridor.
 * - Each group takes the feed with the least cable to reach it: straight to the corridor, then along it to the nearest pole, a
 *   leg that crosses a street line costing `o.crossPenM` (60 m) more. Over `o.maxFeedM` (500 m) of cable: not reached.
 * - A feed beside the middle of a group feeds two strings, one each way; else one, from its nearer end.
 * - A string carries what the engine needs: per pole the cable from the previous one (`spanM`, its route `spanPts`) and from the
 *   feed (`feederToM`); `pathTo(g, st, k)` is the feeder route to pole k (a later circuit of the same string starts there).
 * - Per group the trench run (`trench`: the corridor from the first to the last pole, the feed's foot included) and the feed's leg
 *   (`leg`, a road crossing when `crosses`).
 */
const SLLayout = (() => {
  'use strict';
  const D = { snapM: 40, maxFeedM: 500, crossPenM: 60 };
  const r2 = v => Math.round(v * 100) / 100;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };

  // nearest point of a polyline: { s (station), d, side (+1 left of its direction, −1 right), q }
  function project(p, pts) {
    let best = null, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
      const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
      const q = [a[0] + dx * t, a[1] + dy * t], d = dist(p, q);
      if (!best || d < best.d - 1e-9) best = { s: acc + L * t, d, q, side: (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) >= 0 ? 1 : -1 };
      acc += L;
    }
    return best;
  }
  // the polyline offset by d to its left (negative = right); mitred corners, limited to 4 × d
  function offset(pts, d) {
    const n = pts.length, out = [];
    const nrm = i => { const a = pts[i], b = pts[i + 1], L = dist(a, b) || 1; return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; };
    for (let i = 0; i < n; i++) {
      let m;
      if (i === 0) m = nrm(0); else if (i === n - 1) m = nrm(n - 2);
      else { const a = nrm(i - 1), b = nrm(i), s = [a[0] + b[0], a[1] + b[1]], L = Math.hypot(s[0], s[1]);
        if (L < 1e-6) m = a; else { const c = Math.max(0.25, (s[0] * a[0] + s[1] * a[1]) / L); m = [s[0] / L / c, s[1] / L / c]; } }
      out.push([pts[i][0] + m[0] * d, pts[i][1] + m[1] * d]);
    }
    return out;
  }
  // the point at station s of a polyline
  function at(pts, s) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      if (acc + L >= s || i === pts.length - 1) { const t = L ? Math.max(0, Math.min(1, (s - acc) / L)) : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
      acc += L;
    }
    return pts[0].slice();
  }
  // the polyline from station s0 to s1 (either way), its vertices between included
  function along(pts, s0, s1) {
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1), out = [at(pts, lo)];
    let acc = 0;
    for (let i = 1; i < pts.length - 1; i++) { acc += dist(pts[i - 1], pts[i]); if (acc > lo + 1e-6 && acc < hi - 1e-6) out.push(pts[i].slice()); }
    out.push(at(pts, hi));
    return s0 <= s1 ? out : out.reverse();
  }
  // do two segments cross?
  function crossSeg(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0;
  }
  const crossesAny = (a, b, streets) => streets.some(s => s.pts.some((q, i) => i > 0 && crossSeg(a, b, s.pts[i - 1], q)));
  const median = xs => { const v = xs.slice().sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const dedupe = pts => pts.filter((p, i) => !i || dist(p, pts[i - 1]) > 1e-6);

  function plan(input) {
    const o = Object.assign({}, D, input.o || {});
    const streets = (input.streets || []).filter(s => s.pts && s.pts.length >= 2);
    const feeds = input.feeds || [];
    const unassigned = [], byKey = new Map();
    for (const p of input.poles || []) {
      let best = null;
      for (const s of streets) { const pr = project([p.x, p.y], s.pts); if (pr && pr.d <= o.snapM && (!best || pr.d < best.pr.d)) best = { s, pr }; }
      if (!best) { unassigned.push({ id: p.id, reason: `no road within ${o.snapM} m` }); continue; }
      const key = best.s.id + '|' + best.pr.side;
      if (!byKey.has(key)) byKey.set(key, { key, street: best.s, side: best.pr.side, poles: [] });
      byKey.get(key).poles.push({ id: p.id, x: p.x, y: p.y, d: best.pr.d });
    }
    const groups = [];
    for (const g of byKey.values()) {
      const c = g.street.corr, own = c && typeof c === 'object' ? c[g.side > 0 ? 'L' : 'R'] : c;
      g.off = +own > 0 ? +own : median(g.poles.map(p => p.d));
      g.fromSection = +own > 0;
      g.corr = offset(g.street.pts, g.side * g.off);
      for (const p of g.poles) { const pr = project([p.x, p.y], g.corr); p.t = pr.s; p.foot = pr.q; }
      g.poles.sort((a, b) => a.t - b.t);
      const t0 = g.poles[0].t, t1 = g.poles[g.poles.length - 1].t;
      // the feed: least cable to the nearest pole of the group
      let best = null;
      for (const f of feeds) {
        const pr = project([f.x, f.y], g.corr), crosses = crossesAny([f.x, f.y], pr.q, streets);
        const alongM = pr.s < t0 ? t0 - pr.s : pr.s > t1 ? pr.s - t1 : 0;
        const cost = pr.d + alongM + (crosses ? o.crossPenM : 0);
        if (!best || cost < best.cost) best = { f, pr, crosses, cost, m: pr.d + alongM };
      }
      if (!best || best.m > o.maxFeedM) {
        for (const p of g.poles) unassigned.push({ id: p.id, reason: best ? `the nearest feed (${best.f.name || best.f.id}) is ${Math.round(best.m)} m of cable away (limit ${o.maxFeedM} m)` : 'no feed ticked' });
        continue;
      }
      g.feed = best.f; g.crosses = best.crosses; g.tf = best.pr.s; g.ff = best.pr.q;
      g.leg = [[best.f.x, best.f.y], best.pr.q];
      const ups = g.poles.filter(p => p.t >= g.tf), downs = g.poles.filter(p => p.t < g.tf).reverse();
      g.strings = [ups, downs].filter(a => a.length).map((ps, i) => mkString(g, ps, i));
      const lo = Math.min(t0, g.tf), hi = Math.max(t1, g.tf);
      g.trench = hi - lo > 0.5 ? dedupe(along(g.corr, lo, hi)) : null;
      groups.push(g);
    }
    return { groups, unassigned };
  }
  function mkString(g, ps, i) {
    const st = { id: `${g.key}|${i}`, poles: ps.map(p => ({ id: p.id, x: p.x, y: p.y, t: p.t, foot: p.foot })), spanM: [], spanPts: [], feederToM: [] };
    ps.forEach((p, k) => {
      const path = pathTo(g, st, k);
      st.feederToM.push(r2(len(path)));
      if (k) { const q = ps[k - 1], sp = dedupe([[q.x, q.y]].concat(along(g.corr, q.t, p.t), [[p.x, p.y]])); st.spanPts.push(sp); st.spanM.push(r2(len(sp))); }
      else { st.spanPts.push(null); st.spanM.push(0); }
    });
    return st;
  }
  // the feeder route from the group's feed to pole k of the string: straight to the corridor, along it, then the pole's tail
  function pathTo(g, st, k) {
    const p = st.poles[k];
    return dedupe([[g.feed.x, g.feed.y]].concat(along(g.corr, g.tf, p.t), [[p.x, p.y]]));
  }

  // the pieces of a run (points in m) not within `tol` of any of `lines` (m), each at least `minM` long
  function uncovered(run, lines, tol = 1, minM = 2) {
    const L = len(run); if (L < 1e-6) return [];
    const near = pt => lines.some(l => { const pr = project(pt, l); return pr && pr.d <= tol; });
    const step = 1, n = Math.max(1, Math.ceil(L / step)), out = [];
    let s0 = null;
    for (let i = 0; i <= n; i++) {
      const s = Math.min(L, i * step), c = near(at(run, s));
      if (!c && s0 == null) s0 = s;
      if ((c || i === n) && s0 != null) { const e = c ? Math.max(s0, s - step / 2) : s; if (e - s0 >= minM) out.push(dedupe(along(run, s0, e))); s0 = null; }
    }
    return out;
  }

  // Poles along a street (m): exactly every `spacing` m at `off` m from its centre line, as many as keep each end's gap within
  // `endM` (default half the spacing), the slack shared at both ends; `arr` 'A' / 'B' (one side: A = left of the street's direction), 'both' (opposite
  // pairs) or 'stagger' (sides in turn, half the spacing apart). A pole within `clearM` (3) of another street's line (a junction
  // mouth) or of a pole in `keep` is left out. Returns [{ x, y, side, s }].
  function polesAlong(street, o, others, keep) {
    const pts = street.pts, L = len(pts), sp = Math.max(5, +o.spacing || 35), off = Math.max(0.5, +o.off || 5), clr = o.clearM != null ? +o.clearM : 3;
    const arr = o.arr || 'A', stag = arr === 'stagger', step = stag ? sp / 2 : sp, end = o.endM != null ? Math.max(0, +o.endM) : Math.min(sp / 2, L / 2);
    if (L < 1) return [];
    let n = Math.max(1, Math.ceil((L - 2 * end) / step - 1e-9) + 1); while (n > 1 && (n - 1) * step > L) n--;
    const s0 = (L - (n - 1) * step) / 2;
    const lines = { 1: offset(pts, off), [-1]: offset(pts, -off) }, out = [];
    const blocked = q => (others || []).some(t => t !== street && t.pts && project(q, t.pts).d < clr) || (keep || []).some(k => dist(q, k) < clr);
    for (let i = 0; i < n; i++) {
      const s = s0 + i * step, sides = arr === 'both' ? [1, -1] : arr === 'B' ? [-1] : stag ? [i % 2 ? -1 : 1] : [1];
      for (const sd of sides) { const q = at(lines[sd], s); if (!blocked(q)) out.push({ x: q[0], y: q[1], side: sd, s: r2(s) }); }
    }
    return out;
  }

  return { D, plan, pathTo, project, offset, along, at, len, uncovered, crossSeg, polesAlong };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SLLayout;
