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
  const D = { snapM: 40, maxFeedM: 500, crossPenM: 60, endTolM: 12 };
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

  // ── the verge network ──
  // One corridor per side of every street (its offset line: `corr`, else the median distance of that side's poles, else the other
  // side's, else 6 m), clipped where a street ends on another (at its corridor's crossing with that street's corridor). Corridors of
  // different streets meet where their lines cross (a block corner, or the mouth of a side street). Edges: `run` along a corridor
  // (`inRoad` when its middle lies inside another street's corridors — it crosses that street's mouth), `cross` square across a
  // street at its ends, its junctions and opposite each feed, `tail` from a pole to its foot, `leg` from a feed to its corridor.
  function network(streets, poles, feeds, o) {
    const nodes = [], edges = [], adj = [];
    const node = (pt, extra) => { nodes.push(Object.assign({ id: nodes.length, pt }, extra || {})); adj.push([]); return nodes.length - 1; };
    const edge = (a, b, len, kind, pts, extra) => { const e = Object.assign({ id: edges.length, a, b, len, kind, pts }, extra || {}); edges.push(e); adj[a].push(e.id); adj[b].push(e.id); return e; };
    const bySide = new Map();
    for (const p of poles) { const k = p.street + '|' + p.side; if (!bySide.has(k)) bySide.set(k, []); bySide.get(k).push(p.d); }
    const corrs = [];
    for (const st of streets) for (const side of [1, -1]) {
      const c = st.corr, own = c && typeof c === 'object' ? c[side > 0 ? 'L' : 'R'] : c, mine = bySide.get(st.id + '|' + side), other = bySide.get(st.id + '|' + -side);
      const off = +own > 0 ? +own : mine ? median(mine) : other ? median(other) : 6;
      const pts = offset(st.pts, side * off);
      corrs.push({ key: st.id + '|' + side, st, side, off, pts, L: len(pts), lo: 0, hi: len(pts), stops: [] });
    }
    const cOf = new Map(corrs.map(c => [c.key, c]));
    // where corridors of different streets cross
    const hits = [];
    for (let i = 0; i < corrs.length; i++) for (let j = i + 1; j < corrs.length; j++) {
      const A = corrs[i], B = corrs[j]; if (A.st === B.st) continue;
      let sa = 0;
      for (let u = 1; u < A.pts.length; u++) {
        const a0 = A.pts[u - 1], a1 = A.pts[u], la = dist(a0, a1); let sb = 0;
        for (let v = 1; v < B.pts.length; v++) {
          const b0 = B.pts[v - 1], b1 = B.pts[v], lb = dist(b0, b1), X = segX(a0, a1, b0, b1);
          if (X) hits.push({ A, B, sA: sa + la * X.t, sB: sb + lb * X.u, pt: X.p });
          sb += lb;
        }
        sa += la;
      }
    }
    // a street that ends on another stops at the first crossing of its corridor with that street's corridors
    for (const c of corrs) for (const end of ['lo', 'hi']) {
      const E = end === 'lo' ? c.st.pts[0] : c.st.pts[c.st.pts.length - 1];
      const onto = streets.filter(t => t !== c.st && project(E, t.pts).d <= o.endTolM);
      if (!onto.length) continue;
      const near = hits.filter(h => (h.A === c && onto.includes(h.B.st)) || (h.B === c && onto.includes(h.A.st))).map(h => (h.A === c ? h.sA : h.sB));
      if (!near.length) continue;
      // the crossing nearest the body of the street (a line that overshoots crosses the far corridor first)
      if (end === 'lo') { const a = near.filter(s => s <= c.L / 2); if (a.length) c.lo = Math.max(...a); }
      else { const a = near.filter(s => s > c.L / 2); if (a.length) c.hi = Math.min(...a); }
    }
    const stop = (c, s, nid) => { c.stops.push({ s, n: nid }); return nid; };
    for (const h of hits) {
      if (h.sA < h.A.lo - 1e-6 || h.sA > h.A.hi + 1e-6 || h.sB < h.B.lo - 1e-6 || h.sB > h.B.hi + 1e-6) continue;
      const n = node(h.pt, { kind: 'corner' }); stop(h.A, h.sA, n); stop(h.B, h.sB, n);
    }
    for (const c of corrs) { stop(c, c.lo, node(at(c.pts, c.lo), { kind: 'end' })); stop(c, c.hi, node(at(c.pts, c.hi), { kind: 'end' })); }
    // a point on a corridor, clamped to its clipped range
    const onCorr = (c, q) => { const pr = project(q, c.pts), s = Math.max(c.lo, Math.min(c.hi, pr.s)); return { s, q: at(c.pts, s) }; };
    // crossings: at each street's ends and junctions, and opposite each feed
    const crossAt = (st, q, why) => {
      const P = cOf.get(st.id + '|1'), M = cOf.get(st.id + '|-1'), a = onCorr(P, q), b = onCorr(M, q);
      const na = stop(P, a.s, node(a.q, { kind: 'x' })), nb = stop(M, b.s, node(b.q, { kind: 'x' }));
      edge(na, nb, dist(a.q, b.q), 'cross', [a.q, b.q], { st: st.id, why });
    };
    for (const st of streets) {
      const P = cOf.get(st.id + '|1');
      crossAt(st, at(P.pts, P.lo), 'end'); crossAt(st, at(P.pts, P.hi), 'end');
      for (const h of hits) if (h.A.st === st || h.B.st === st) { const q = project(h.pt, st.pts).q; crossAt(st, q, 'junction'); }
    }
    // poles: a node off their own side's corridor, a tail to its foot
    const poleNode = new Map(), footOf = new Map();
    for (const p of poles) {
      const c = cOf.get(p.street + '|' + p.side), f = onCorr(c, [p.x, p.y]);
      const nf = stop(c, f.s, node(f.q, { kind: 'foot', pole: p.id })), np = node([p.x, p.y], { kind: 'pole', pole: p.id });
      edge(np, nf, dist([p.x, p.y], f.q), 'tail', [[p.x, p.y], f.q]);
      poleNode.set(p.id, np); footOf.set(p.id, nf);
    }
    // feeds: a leg to the nearest corridor, and a crossing opposite it
    const feedNode = new Map();
    for (const f of feeds) {
      let best = null;
      for (const c of corrs) { const g = onCorr(c, [f.x, f.y]), d = dist([f.x, f.y], g.q); if (!best || d < best.d) best = { c, g, d }; }
      if (!best) continue;
      const nf = stop(best.c, best.g.s, node(best.g.q, { kind: 'feedfoot' })), n = node([f.x, f.y], { kind: 'feed', feed: f.id });
      edge(n, nf, best.d, 'leg', [[f.x, f.y], best.g.q], { crosses: crossesAny([f.x, f.y], best.g.q, streets) });
      crossAt(best.c.st, best.g.q, 'feed');
      feedNode.set(f.id, n);
    }
    // runs along each corridor between its stops
    for (const c of corrs) {
      c.stops.sort((a, b) => a.s - b.s);
      for (let i = 1; i < c.stops.length; i++) {
        const A = c.stops[i - 1], B = c.stops[i]; if (B.s < c.lo - 1e-6 || A.s > c.hi + 1e-6) continue;
        const pts = dedupe(along(c.pts, A.s, B.s)), mid = at(c.pts, (A.s + B.s) / 2);
        const inRoad = streets.some(t => t !== c.st && project(mid, t.pts).d < Math.min(cOf.get(t.id + '|1').off, cOf.get(t.id + '|-1').off) - 0.25);
        edge(A.n, B.n, B.s - A.s, 'run', pts.length > 1 ? pts : [nodes[A.n].pt, nodes[B.n].pt], { corr: c.key, s1: A.s, s2: B.s, inRoad });
      }
    }
    return { nodes, edges, adj, corrs, poleNode, footOf, feedNode };
  }
  // segment crossing a0→a1 with b0→b1: { t, u, p } or null
  function segX(a0, a1, b0, b1) {
    const rx = a1[0] - a0[0], ry = a1[1] - a0[1], sx = b1[0] - b0[0], sy = b1[1] - b0[1], den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const qx = b0[0] - a0[0], qy = b0[1] - a0[1], t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, p: [a0[0] + rx * t, a0[1] + ry * t] } : null;
  }
  const crossing = e => e.kind === 'cross' || (e.kind === 'run' && e.inRoad) || (e.kind === 'leg' && e.crosses);
  // shortest paths from a node: cost = length, + crossPen per crossing; `ok(e)` = the edges that may be used
  function dijkstra(G, src, ok, pen) {
    const n = G.nodes.length, D = new Float64Array(n).fill(Infinity), Lm = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const H = [], push = (d, u) => { H.push([d, u]); let i = H.length - 1; while (i) { const j = (i - 1) >> 1; if (H[j][0] <= H[i][0]) break; [H[i], H[j]] = [H[j], H[i]]; i = j; } };
    const pop = () => { const top = H[0], last = H.pop(); if (H.length) { H[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < H.length && H[l][0] < H[m][0]) m = l; if (r < H.length && H[r][0] < H[m][0]) m = r; if (m === i) break; [H[i], H[m]] = [H[m], H[i]]; i = m; } } return top; };
    const heap = H; push(0, src);
    D[src] = 0; Lm[src] = 0;
    while (heap.length) {
      const [d, u] = pop();
      if (d > D[u]) continue;
      for (const eid of G.adj[u]) {
        const e = G.edges[eid]; if (ok && !ok(e)) continue;
        const v = e.a === u ? e.b : e.a, w = e.len + (crossing(e) ? pen : 0);
        if (D[u] + w < D[v] - 1e-9) { D[v] = D[u] + w; Lm[v] = Lm[u] + e.len; prev[v] = eid; push(D[v], v); }
      }
    }
    return { D, Lm, prev };
  }
  // the edges from src to v (in order), and their points
  function pathEdges(G, R, v) { const out = []; while (R.prev[v] >= 0) { const e = G.edges[R.prev[v]]; out.push({ e, to: v }); v = e.a === v ? e.b : e.a; } return out.reverse(); }
  function pathPts(G, steps) {
    const out = [];
    for (const { e, to } of steps) { const pts = e.b === to ? e.pts : e.pts.slice().reverse(); for (const q of pts) if (!out.length || dist(out[out.length - 1], q) > 1e-6) out.push(q); }
    return out;
  }

  // ── the plan ──
  // Poles go to the nearest street (within `snapM`) and its side. A COMPONENT is the poles a circuit may join without crossing a
  // road: along a corridor and round block corners (o.joinSides, or a feed in o.joinFor: also across a street at its ends). Each
  // component takes the feed with the least cable along the network (a crossing costs `crossPenM` more; over `maxFeedM` = not
  // reached; o.ban: component key → feeds it may not take). Its poles form a TREE from the pole the feeder reaches (`entry`): each
  // pole's parent is the pole before it on its shortest path, so a string runs both ways and on round corners. Returns
  // { comps: [{ key, feed, poles [{ id, x, y }] in order from the entry, parent [index | null], spanM, spanPts, feederPts, feederM,
  // feederToM, edges (ids used), crossings }], unassigned, G }.
  function plan(input) {
    const o = Object.assign({}, D, input.o || {});
    const streets = (input.streets || []).filter(s => s.pts && s.pts.length >= 2), feeds = input.feeds || [], unassigned = [], poles = [];
    for (const p of input.poles || []) {
      let best = null;
      for (const s of streets) { const pr = project([p.x, p.y], s.pts); if (pr && pr.d <= o.snapM && (!best || pr.d < best.pr.d)) best = { s, pr }; }
      if (!best) { unassigned.push({ id: p.id, reason: `no road within ${o.snapM} m` }); continue; }
      poles.push({ id: p.id, x: p.x, y: p.y, street: best.s.id, side: best.pr.side, d: best.pr.d });
    }
    if (!streets.length || !poles.length) return { comps: [], unassigned, G: null };
    const G = network(streets, poles, feeds, o), byId = new Map(poles.map(p => [p.id, p]));
    // components: union over the edges a circuit may use (no crossing)
    const par = G.nodes.map((_, i) => i), find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (const e of G.edges) if (e.kind === 'tail' || (e.kind === 'run' && !e.inRoad)) union(e.a, e.b);
    const groupOf = () => { const m = new Map(); for (const p of poles) { const r = find(G.poleNode.get(p.id)); if (!m.has(r)) m.set(r, []); m.get(r).push(p); } return m; };
    // each feed's shortest paths (every edge, crossings costed)
    const FR = new Map(); for (const f of feeds) if (G.feedNode.has(f.id)) FR.set(f.id, dijkstra(G, G.feedNode.get(f.id), null, o.crossPenM));
    const assign = groups => {
      const out = [];
      for (const [root, ps] of groups) {
        const key = ps.map(p => p.id).sort()[0], ban = (o.ban && o.ban[key]) || [];
        let best = null;
        for (const f of feeds) {
          const R = FR.get(f.id); if (!R || ban.includes(f.id)) continue;
          for (const p of ps) { const n = G.poleNode.get(p.id); if (R.D[n] < (best ? best.cost : Infinity)) best = { f, R, p, cost: R.D[n], m: R.Lm[n] }; }
        }
        out.push({ root, ps, key, best });
      }
      return out;
    };
    let A = assign(groupOf());
    // both sides of a road in one circuit: components of one feed that meet across a street end are joined
    const joinFor = o.joinSides ? null : new Set(o.joinFor || []);
    const joined = new Set();
    if (o.joinSides || joinFor.size) {
      const feedOfRoot = new Map(A.filter(x => x.best).map(x => [x.root, x.best.f.id])), before = G.nodes.map((_, i) => find(i));
      for (const e of G.edges) {
        if (e.kind !== 'cross' || e.why !== 'end') continue;
        const fa = feedOfRoot.get(before[e.a]), fb = feedOfRoot.get(before[e.b]);
        if (!fa || fa !== fb || (joinFor && !joinFor.has(fa)) || find(e.a) === find(e.b)) continue;
        union(e.a, e.b); joined.add(e.id);
      }
      if (joined.size) A = assign(groupOf());
    }
    const comps = [];
    for (const { ps, key, best } of A) {
      if (!best || best.m > o.maxFeedM) {
        for (const p of ps) unassigned.push({ id: p.id, reason: best ? `the nearest feed (${best.f.name || best.f.id}) is ${Math.round(best.m)} m of cable away (limit ${o.maxFeedM} m)` : feeds.length ? 'no road joins them to a ticked feed (draw the road between, or tick a kiosk on theirs)' : 'no feed ticked' });
        continue;
      }
      const entry = best.p, inComp = new Set(ps.map(p => p.id));
      const T = dijkstra(G, G.poleNode.get(entry.id), e => e.kind === 'tail' || (e.kind === 'run' && !e.inRoad) || joined.has(e.id), o.crossPenM);
      // each pole's parent: the first other pole whose foot lies on its path back to the entry
      const footPole = new Map(); for (const p of ps) footPole.set(G.footOf.get(p.id), p.id);
      const info = new Map();
      for (const p of ps) {
        const pn = G.poleNode.get(p.id); if (!(T.D[pn] < Infinity)) continue;
        if (p === entry) { info.set(p.id, { parent: null, steps: [] }); continue; }
        const steps = pathEdges(G, T, pn); let k = steps.length - 1, q = null;
        // walk back from the pole: its tail, then the corridor, to the nearest other pole's foot
        for (; k >= 0; k--) { const at0 = steps[k].e.a === steps[k].to ? steps[k].e.b : steps[k].e.a, fp = footPole.get(at0); if (fp && fp !== p.id && inComp.has(fp)) { q = fp; break; } }
        if (q == null) { info.set(p.id, { parent: entry.id, steps }); continue; }
        const qTail = G.edges.find(e => e.kind === 'tail' && (e.a === G.poleNode.get(q) || e.b === G.poleNode.get(q)));
        info.set(p.id, { parent: q, steps: [{ e: qTail, to: G.footOf.get(q) }].concat(steps.slice(k)) });
      }
      // order: by the length of cable from the entry, parents first
      const order = [], seen = new Set(), kids = new Map();
      for (const [id, x] of info) if (x.parent) { if (!kids.has(x.parent)) kids.set(x.parent, []); kids.get(x.parent).push(id); }
      const Lof = id => T.Lm[G.poleNode.get(id)];
      const queue = [entry.id];
      while (queue.length) { queue.sort((a, b) => Lof(a) - Lof(b)); const id = queue.shift(); if (seen.has(id)) continue; seen.add(id); order.push(id); for (const c of kids.get(id) || []) queue.push(c); }
      for (const p of ps) if (!seen.has(p.id)) unassigned.push({ id: p.id, reason: 'cannot be reached along the verge from the rest of its road side' });
      const idx = new Map(order.map((id, i) => [id, i])), feedSteps = pathEdges(G, best.R, G.poleNode.get(entry.id));
      const comp = { key, feed: best.f, poles: order.map(id => ({ id, x: byId.get(id).x, y: byId.get(id).y })), parent: [], spanM: [], spanPts: [], feederToM: [],
        feederPts: pathPts(G, feedSteps), feederM: r2(feedSteps.reduce((s, x) => s + x.e.len, 0)), edges: new Set(feedSteps.map(x => x.e.id)), joined: false };
      order.forEach((id, i) => {
        const x = info.get(id);
        if (!x.parent) { comp.parent.push(null); comp.spanM.push(0); comp.spanPts.push(null); comp.feederToM.push(comp.feederM); return; }
        const pts = pathPts(G, x.steps), m = r2(x.steps.reduce((s, y) => s + y.e.len, 0));
        comp.parent.push(idx.get(x.parent)); comp.spanM.push(m); comp.spanPts.push(pts);
        comp.feederToM.push(r2(comp.feederToM[idx.get(x.parent)] + m));
        for (const y of x.steps) { comp.edges.add(y.e.id); if (joined.has(y.e.id)) comp.joined = true; }
      });
      comps.push(comp);
    }
    return { comps, unassigned, G };
  }
  // the feeder route from the component's feed to pole i: to the entry, then along the tree
  function pathTo(comp, i) {
    const chain = []; for (let k = i; k != null && comp.parent[k] != null; k = comp.parent[k]) chain.push(k);
    const out = comp.feederPts.slice();
    for (const k of chain.reverse()) for (const q of comp.spanPts[k]) if (dist(out[out.length - 1], q) > 1e-6) out.push(q);
    return out;
  }
  // what a set of components digs: trench runs along the corridors (merged per corridor), the feed legs that do not cross, and the
  // crossings ([[a, b]]: square crossings and corridor stretches through another road's mouth)
  function usage(P, comps) {
    const G = P.G; if (!G) return { trench: [], crossings: [] };
    const ids = new Set(); for (const c of comps) for (const id of c.edges) ids.add(id);
    const runs = new Map(), trench = [], crossings = [];
    for (const id of ids) {
      const e = G.edges[id];
      if (crossing(e)) { crossings.push([e.pts[0], e.pts[e.pts.length - 1]]); continue; }
      if (e.kind === 'run') { if (!runs.has(e.corr)) runs.set(e.corr, []); runs.get(e.corr).push([Math.min(e.s1, e.s2), Math.max(e.s1, e.s2)]); }
      else if (e.kind === 'leg' && e.len >= 1) trench.push(e.pts);
    }
    for (const [key, iv] of runs) {
      const c = G.corrs.find(x => x.key === key); iv.sort((a, b) => a[0] - b[0]);
      let cur = null; const flush = () => { if (cur && cur[1] - cur[0] >= 1) trench.push(dedupe(along(c.pts, cur[0], cur[1]))); };
      for (const v of iv) { if (cur && v[0] <= cur[1] + 0.05) cur[1] = Math.max(cur[1], v[1]); else { flush(); cur = v.slice(); } }
      flush();
    }
    return { trench, crossings };
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

  return { D, plan, pathTo, usage, project, offset, along, at, len, uncovered, crossSeg, polesAlong };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SLLayout;
