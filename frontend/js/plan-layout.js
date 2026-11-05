/* ProtectionPro — Plan Markup auto layout of a reticulation.
 *
 * From the erf boundaries and the street centrelines it works out, in this order:
 *   1. the front of every erf (the edge that faces a street; a corner erf takes its
 *      longest or shortest street edge; a click overrides it);
 *   2. where each erf's service marker goes (a front corner, `side` m from the side
 *      boundary and `depth` m in from the front);
 *   3. kiosks (rule of thumb: even runs of at most `n` houses along each street; or the
 *      optimiser, one solve over the whole street network: stands on every street and
 *      beside every junction, an erf takes any kiosk within `maxc` m of service cable —
 *      along its street or round a junction corner — fewest kiosks first (one is given up
 *      while the extra cable stays within `worth` m), then fewest road crossings, then
 *      shortest cable, at most `n` erven per kiosk);
 *   4. fibre: manholes on the civil side (one per `m` erven and never further apart
 *      than `maxmh` m), a trunk duct as a ring or as spurs with T-offs from an entry,
 *      and a duct from a manhole to every erf;
 *   5. a mini-sub, the LV feeders (a radial tree) and the MV cable;
 *   6. every road crossing, shared: services, fibre, LV and MV that cross at one place
 *      share one trench — 110 mm ducts take 4 service cables, 4 fibre erf ducts or 2 LV
 *      cables, each MV cable its own 160 mm duct. Crossings go on erf boundaries.
 *      Optionally a duct is laid across every leg of every junction.
 *
 * Pure geometry in metres (x right, y down); arrays in, arrays out, no DOM, so it is
 * node-testable. The plan glue (plan-layout-ui.js) converts plan pixels to metres.
 * Left / right of a street is looking along its points; side +1 = left, -1 = right.
 */

const PlanLayout = (() => {
  'use strict';

  const DEFAULTS = {
    side: 4, depth: 4, corner: 'start', front: 'longest',      // marker: m from the side boundary and the front; which corner; corner erf's front
    kgeo: 'boundary', kd: 2,                                       // cables + kiosks run kd m inside the erf boundary ('street' = the old street-line offset)
    kmode: 'opt', n: 6, maxc: 80, worth: 170, knet: true,   // kiosks (n = the most erven one kiosk serves; knet = one solve over the whole street network)
    subMode: 'opt', subs: 1,                                          // mini-sub: 'opt' = where the LV network drops least, 'mid' = nearest the middle
    m: 8, maxmh: 120, fibre: 'opp', topo: 'ring',              // fibre
    share: true, xmode: 'bound', junct: false, j110: 2, j160: 1, spare: 0,   // crossings
  };

  // ───────────── small geometry ─────────────
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const plen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  function segInter(a, b, c, d) {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (!(((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))) return null;
    const t = o3 / (o3 - o4); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // ───────────── streets: a centreline with stations ─────────────
  function prepStreet(s) {
    const pts = s.pts.map(p => [p[0], p[1]]), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const w = s.w || 12;
    return { id: s.id, name: s.name || s.id, pts, cum, len: cum[cum.length - 1], w, vk: Math.max(1.5, w / 2 - 2), tr: Math.max(1.5, w / 2 - 1.7), nodeSt: {}, jids: [] };
  }
  function ptAt(st, s, off) {
    s = clamp(s, 0, st.len);
    let lo = 0, hi = st.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st.cum[m] <= s) lo = m; else hi = m; }
    const a = st.pts[lo], b = st.pts[hi], L = (st.cum[hi] - st.cum[lo]) || 1, t = (s - st.cum[lo]) / L;
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    return [a[0] + (b[0] - a[0]) * t + ty * off, a[1] + (b[1] - a[1]) * t - tx * off, tx, ty];     // left of travel is (ty, -tx), y down
  }
  function project(st, x, y) {
    let best = null;
    for (let i = 1; i < st.pts.length; i++) {
      const a = st.pts[i - 1], b = st.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / L2, 0, 1), px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, s: st.cum[i - 1] + t * Math.sqrt(L2), side: ((x - px) * dy - (y - py) * dx) >= 0 ? 1 : -1, px, py };
    }
    return best;
  }
  const STEP = 2.5;
  function verge(st, s0, s1, off) {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / STEP)), out = [];
    for (let i = 0; i <= n; i++) out.push(ptAt(st, s0 + (s1 - s0) * i / n, off).slice(0, 2));
    return out;
  }

  // where streets cross or meet: a junction is every proper crossing, and every street end within 3 m of another street
  function findJunctions(streets) {
    const raw = [];
    for (let i = 0; i < streets.length; i++) for (let j = i + 1; j < streets.length; j++) {
      const A = streets[i], B = streets[j];
      for (let p = 1; p < A.pts.length; p++) for (let q = 1; q < B.pts.length; q++) {
        const x = segInter(A.pts[p - 1], A.pts[p], B.pts[q - 1], B.pts[q]); if (x) raw.push({ pt: x, items: [[A, project(A, x[0], x[1]).s], [B, project(B, x[0], x[1]).s]] });
      }
      for (const [E, T] of [[A, B], [B, A]]) for (const s0 of [0, E.len]) {
        const e = ptAt(E, s0, 0), pr = project(T, e[0], e[1]);
        if (pr.d <= 3 && !raw.some(r => Math.hypot(r.pt[0] - e[0], r.pt[1] - e[1]) < 8)) raw.push({ pt: [pr.px, pr.py], items: [[E, s0], [T, pr.s]] });
      }
    }
    const cl = [];
    for (const r of raw) {
      const hit = cl.find(c => Math.hypot(c.pt[0] - r.pt[0], c.pt[1] - r.pt[1]) < 8);
      if (hit) { r.items.forEach(([st, s0]) => { if (!hit.items.some(it => it[0] === st)) hit.items.push([st, s0]); }); }
      else cl.push({ pt: r.pt, items: r.items.slice() });
    }
    const use = {};
    cl.forEach((c, i) => { const id = 'J' + (i + 1); c.id = id; use[id] = c.items.map(it => it[0]); c.items.forEach(([st, s0]) => { st.nodeSt[id] = s0; st.jids.push(id); }); });
    streets.forEach(st => { st.stops = [...new Set([0, st.len, ...st.jids.map(id => st.nodeSt[id])].map(v => Math.round(v * 10) / 10))].sort((a, b) => a - b); });
    return { list: cl, use };
  }

  // ───────────── the solver ─────────────
  function solve(input, Pin) {
    const P = Object.assign({}, DEFAULTS, Pin || {});
    const t0 = Date.now();
    const streets = (input.streets || []).filter(s => s.pts && s.pts.length >= 2).map(prepStreet);
    const { list: junctions, use } = findJunctions(streets);
    const isJ = id => use[id] && use[id].length >= 2;
    const byId = Object.fromEntries(streets.map(s => [s.id, s]));
    const erven = (input.erven || []).filter(e => e.poly && e.poly.length >= 3).map(e => {
      const c = [e.poly.reduce((s, q) => s + q[0], 0) / e.poly.length, e.poly.reduce((s, q) => s + q[1], 0) / e.poly.length];
      return { id: e.id, poly: e.poly.map(p => [p[0], p[1]]), cx: c[0], cy: c[1],
        box: [Math.min(...e.poly.map(q => q[0])), Math.min(...e.poly.map(q => q[1])), Math.max(...e.poly.map(q => q[0])), Math.max(...e.poly.map(q => q[1]))] };
    });
    const ks = {}, fs = {}, overrides = input.overrides || {}, cuts = new Set(input.cuts || []);
    streets.forEach(st => { ks[st.id] = (input.ks && input.ks[st.id]) || 0; fs[st.id] = (input.fs && input.fs[st.id]) || null; });
    const warns = [];

    // ── 0. the corridor: where a cable runs across the road, measured from the erf boundary ──
    // frontage(st, side) = samples [station, distance from the street line to the boundary] taken from the fronts of the erven on that side.
    // fd = that distance at a station (linear between samples; the drawn half-width where nothing fronts that side). mag = the corridor's
    // distance from the street line: kd inside the boundary, so a street line that is out moves nothing. 'street' mode keeps the old constants.
    const byBoundary = P.kgeo !== 'street', KD = byBoundary ? Math.max(0, +P.kd || 0) : 2;
    function frontage(st, side) {
      const key = 'fr' + side; if (st[key] !== undefined) return st[key];
      const smp = [];
      for (const e of erven) if (e.road === st && e.sd === side && e.fe && !e.manual && e.fe.i >= 0)
        for (const [pt, q] of [[e.fe.a, e.sa], [e.fe.b, e.sb]]) { const pr = project(st, pt[0], pt[1]); smp.push([q, pr.side * side * pr.d]); }     // signed: negative if the street line has strayed past the boundary
      smp.sort((p, q) => p[0] - q[0]);
      return (st[key] = smp.length ? smp : null);
    }
    function fd(st, side, s) {
      const smp = frontage(st, side); if (!smp) return st.w / 2;
      if (s <= smp[0][0]) return smp[0][1];
      for (let i = 1; i < smp.length; i++) if (s <= smp[i][0]) { const a = smp[i - 1], b = smp[i], t = (s - a[0]) / ((b[0] - a[0]) || 1); return a[1] + (b[1] - a[1]) * t; }
      return smp[smp.length - 1][1];
    }
    const mag = (st, side, s, kind) => !byBoundary ? (kind === 't' ? st.tr : st.vk) : Math.max(0.5, fd(st, side, s) - KD + (kind === 't' ? 0.3 : 0));
    const kp = (st, side, s, kind) => ptAt(st, s, side * mag(st, side, s, kind));                      // a point on the corridor (x, y, tx, ty)
    function kv(st, side, s0, s1, kind) {                                                             // the corridor between two stations
      const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / STEP)), out = [];
      for (let i = 0; i <= n; i++) out.push(kp(st, side, s0 + (s1 - s0) * i / n, kind).slice(0, 2));
      return out;
    }
    streets.forEach(st => { st.fd = (side, s) => fd(st, side, s); st.kd = KD; st.byBoundary = byBoundary; });

    // ── 1. fronts ──
    const inErf = (x, y, except) => erven.some(o => o !== except && x >= o.box[0] && x <= o.box[2] && y >= o.box[1] && y <= o.box[3] && pip(x, y, o.poly));
    function roadHit(x, y) {
      let best = null;
      for (const st of streets) { const dd = project(st, x, y).d - st.w / 2; if (dd <= 4 && (!best || dd < best.dd)) best = { st, dd }; }
      return best;
    }
    function edgesOf(e) {
      const out = [], p = e.poly;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
        const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        let n = [-dy, dx]; if (pip(mx + n[0] * .5, my + n[1] * .5, p)) n = [dy, -dx];
        const q = [mx + n[0] * 1, my + n[1] * 1], hit = inErf(q[0], q[1], e) ? null : roadHit(q[0], q[1]);
        out.push({ i, a, b, len, mid: [mx, my], out: n, inn: [-n[0], -n[1]], road: hit ? hit.st : null });
      }
      return out;
    }
    const hand = {};                                                                  // erf id → the marker point put there by hand
    for (const [id, m] of Object.entries(input.markers || {})) if (Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1]) && erven.some(e => e.id === id)) hand[id] = [m[0], m[1]];
    // a front made from a marker: no edge, the nearest street's centreline point as its station, `out` = towards that street
    function manualFront(m) {
      let bs = null;
      for (const st of streets) { const pr = project(st, m[0], m[1]); if (!bs || pr.d < bs.pr.d) bs = { st, pr }; }
      if (!bs) return null;
      const dx = bs.pr.px - m[0], dy = bs.pr.py - m[1], L = Math.hypot(dx, dy) || 1, out = [dx / L, dy / L];
      return { i: -1, a: m.slice(), b: m.slice(), len: 0, mid: m.slice(), out, inn: [-out[0], -out[1]], road: bs.st, manual: true, s: bs.pr.s, side: bs.pr.side };
    }
    function detectFronts() {
      for (const e of erven) {
        if (!e.edges) e.edges = edgesOf(e);
        const re = e.edges.filter(d => d.road);
        e.corner = re.length > 1;
        let pick = re.slice().sort((p, q) => (P.front === 'longest' ? q.len - p.len : p.len - q.len) || p.i - q.i)[0] || null;
        e.overridden = false; e.manual = false;
        const ov = overrides[e.id];
        if (ov != null && e.edges[ov] && e.edges[ov].road) { pick = e.edges[ov]; e.overridden = true; }
        // an erf the classifier cannot place (no street edge, or the wrong one): the marker the user put there is its service point, on the nearest street
        const mk = hand[e.id];
        if (mk) { const mf = manualFront(mk); if (mf) { pick = mf; e.manual = true; e.overridden = false; } }
        e.fe = pick; e.kiosk = null; e.mh = null; e.via = null; e.road = null;
        if (!pick) continue;
        if (e.manual) {
          const st = pick.road; e.road = st; e.sa = e.sb = e.lo = e.hi = e.al = pick.s; e.sd = pick.side;
          let seg = 0; for (let i = 0; i < st.stops.length - 1; i++) if (e.al >= st.stops[i]) seg = i;
          e.seg = seg; e.corner = false; continue;
        }
        const st = pick.road; e.road = st;
        const pa = project(st, pick.a[0], pick.a[1]), pb = project(st, pick.b[0], pick.b[1]), pm = project(st, pick.mid[0], pick.mid[1]);
        e.sa = pa.s; e.sb = pb.s; e.lo = Math.min(pa.s, pb.s); e.hi = Math.max(pa.s, pb.s); e.al = pm.s;
        e.sd = project(st, e.cx, e.cy).side;
        let seg = 0; for (let i = 0; i < st.stops.length - 1; i++) if (e.al >= st.stops[i]) seg = i;
        e.seg = seg;
      }
    }

    // ── 2. markers, kiosks, service cables ──
    function markerCands(e) {
      const fe = e.fe, aa = e.sa, ab = e.sb;
      if (e.manual) return [{ end: 'a', c: fe.a, o: fe.a, t: [1, 0], pt: fe.a, fpt: fe.a }];            // the point the user placed, as is
      const ends = P.corner === 'start' ? [aa <= ab ? 'a' : 'b'] : P.corner === 'end' ? [aa >= ab ? 'a' : 'b'] : ['a', 'b'];
      return ends.map(end => {
        const c = end === 'a' ? fe.a : fe.b, o = end === 'a' ? fe.b : fe.a, t = [(o[0] - c[0]) / fe.len, (o[1] - c[1]) / fe.len];
        return { end, c, o, t,
          pt: [c[0] + t[0] * P.side + fe.inn[0] * P.depth, c[1] + t[1] * P.side + fe.inn[1] * P.depth],
          fpt: [o[0] - t[0] * P.side + fe.inn[0] * P.depth, o[1] - t[1] * P.side + fe.inn[1] * P.depth] };
      });
    }
    function routeFor(e, k, mc) {
      const st = e.road, sM = project(st, mc.pt[0], mc.pt[1]).s;
      const pts = [[k.x, k.y], ...kv(st, ks[st.id], k.s, sM)];
      if (e.sd !== ks[st.id]) pts.push(kp(st, e.sd, sM).slice(0, 2));
      pts.push(mc.pt);
      return pts;
    }
    function routeVia(e, k, mc, x) {
      const st = e.road, sM = project(st, mc.pt[0], mc.pt[1]).s;
      return [[k.x, k.y], ...kv(st, ks[st.id], k.s, x.s), kp(st, e.sd, x.s).slice(0, 2), ...kv(st, e.sd, x.s, sM).slice(1), mc.pt];
    }
    // a service from a kiosk on ANOTHER street: along the kiosk's verge to a junction both streets share, round the corner onto the erf's
    // street (its kiosk-side verge), then as routeFor. `pre` is the part up to the corner (its road crossings are counted separately).
    function routeHop(e, k, mc, id) {
      const A = e.road, B = k.road, nB = B.nodeSt[id], nA = A.nodeSt[id];
      const pre = [[k.x, k.y], ...kv(B, ks[B.id], k.s, nB), kp(A, ks[A.id], nA).slice(0, 2)];
      const sM = project(A, mc.pt[0], mc.pt[1]).s, pts = [...pre, ...kv(A, ks[A.id], nA, sM).slice(1)];
      if (e.sd !== ks[A.id]) pts.push(kp(A, e.sd, sM).slice(0, 2));
      pts.push(mc.pt);
      return { pts, pre };
    }
    function routeAny(e, k, mc) {
      if (k.road === e.road) return routeFor(e, k, mc);
      let best = null;
      for (const id of k.road.jids) { if (e.road.nodeSt[id] === undefined) continue; const r = routeHop(e, k, mc, id), L = plen(r.pts); if (!best || L < best.L) best = { L, r }; }
      if (!best) { const pts = [[k.x, k.y], mc.pt]; pts.hopN = 0; return pts; }
      best.r.pts.hopN = best.r.pre.length; return best.r.pts;
    }
    let LC = new Map();
    const routeM = (e, k) => { const key = 'd|' + e.id + '|' + Math.round(k.s * 3); let v = LC.get(key); if (v == null) { v = Math.min(...e.mcs.map(mc => plen(routeFor(e, k, mc)))); LC.set(key, v); } return v; };
    const viaLen = (e, k, mc, x) => { const key = 'v|' + e.id + '|' + Math.round(k.s * 3) + '|' + Math.round(x.s * 3) + '|' + mc.end; let v = LC.get(key); if (v == null) { v = plen(routeVia(e, k, mc, x)); LC.set(key, v); } return v; };

    function groupBoundaries(list) {
      const out = [];
      for (const sd of [1, -1]) {
        const arr = list.filter(e => e.sd === sd).sort((p, q) => p.al - q.al);
        for (let i = 0; i < arr.length - 1; i++) if (Math.abs(arr[i].hi - arr[i + 1].lo) <= 1.5) { const a = arr[i].hi; if (!out.some(o => Math.abs(o.s - a) <= 1.5)) out.push({ s: a }); }
      }
      return out.sort((p, q) => p.s - q.s);
    }
    function stageB(list, chosen) {
      const st = list[0].road, side = ks[st.id];
      chosen.forEach((c, j) => c.members.forEach(e => { e._k = j; }));
      const opp = list.filter(e => e.sd !== side && e._k != null), same = list.filter(e => e.sd === side && e._k != null);
      let total = same.reduce((a, e) => a + routeM(e, chosen[e._k].cand), 0);
      const picks = new Map();
      if (!opp.length) return { nx: 0, total, picks, xs: [] };
      if (!P.share) { total += opp.reduce((a, e) => a + routeM(e, chosen[e._k].cand), 0); return { nx: opp.length, total, picks, xs: [] }; }
      const bd = P.xmode === 'bound' ? groupBoundaries(list) : [];
      const evalXs = xs => {
        const L = opp.map(e => xs.map(x => { let b = 1e9, mc = null; for (const m of e.mcs) { const l = viaLen(e, chosen[e._k].cand, m, x); if (l < b) { b = l; mc = m; } } return { l: b, mc }; }));
        const m = xs.length, feas = opp.map((e, i) => xs.map((x, j) => L[i][j].l <= P.maxc));
        const noF = opp.map((e, i) => i).filter(i => !feas[i].some(Boolean));
        const unc = new Set(opp.map((e, i) => i).filter(i => !noF.includes(i))), pick = [];
        while (unc.size) {
          let bj = -1, bc = 0, bt = 1e9;
          for (let j = 0; j < m; j++) { if (pick.includes(j)) continue; let c = 0, t = 0; for (const i of unc) if (feas[i][j]) { c++; t += L[i][j].l; } if (c > bc || (c === bc && c > 0 && t < bt)) { bc = c; bt = t; bj = j; } }
          if (bj < 0) break; pick.push(bj); for (const i of [...unc]) if (feas[i][bj]) unc.delete(i);
        }
        noF.forEach(i => { let bj = 0; for (let j = 1; j < m; j++) if (L[i][j].l < L[i][bj].l) bj = j; if (!pick.includes(bj)) pick.push(bj); });
        const covered = set => opp.every((e, i) => noF.includes(i) || set.some(j => feas[i][j]));
        for (let a = pick.length - 1; a >= 0; a--) { const t = pick.filter((_, k) => k !== a); if (t.length && covered(t)) pick.splice(a, 1); }
        const tot = set => opp.reduce((acc, e, i) => acc + Math.min(...set.map(j => L[i][j].l)), 0);
        for (let pass = 0; pass < 2; pass++) for (let a = 0; a < pick.length; a++) {
          for (let j = 0; j < m; j++) { if (pick.includes(j)) continue; const t = pick.slice(); t[a] = j; if (covered(t) && tot(t) < tot(pick) - 1e-6) pick[a] = j; }
        }
        const picks = new Map(), used = new Set(); let total = 0;
        opp.forEach((e, i) => { let bj = pick[0]; for (const j of pick) if (L[i][j].l < L[i][bj].l) bj = j; picks.set(e, { x: xs[bj], mc: L[i][bj].mc, l: L[i][bj].l }); used.add(bj); total += L[i][bj].l; });
        return { nx: used.size, total, picks, xs, nf: noF.length };
      };
      let xs = bd.length ? bd : chosen.map(c => ({ s: c.cand.s })), res = evalXs(xs);
      if (res.nf && bd.length) {                                      // some erf has no boundary in reach: allow its own side boundaries and the kiosk stations
        const soft = bd.slice();
        const add = a => { if (!soft.some(o => Math.abs(o.s - a) <= 1.5)) soft.push({ s: a, soft: true }); };
        opp.forEach(e => { add(e.lo); add(e.hi); }); chosen.forEach(c => add(c.cand.s));
        soft.sort((p, q) => p.s - q.s);
        const r2 = evalXs(soft); if (r2.nf < res.nf || (r2.nf === res.nf && r2.nx < res.nx)) res = r2;
      }
      return { nx: res.nx, total: total + res.total, picks: res.picks, xs: res.xs };
    }

    // small min-cost flow: erven → kiosks within the cable limit, each kiosk takes at most N
    function assignOpt(sel, Lm, n, N, maxL) {
      const k = sel.length, V = n + k + 2, S0 = n + k, T = n + k + 1;
      const to = [], cap = [], cost = [], nxt = [], head = new Array(V).fill(-1);
      const add = (u, v, c, w) => { to.push(v); cap.push(c); cost.push(w); nxt.push(head[u]); head[u] = to.length - 1; to.push(u); cap.push(0); cost.push(-w); nxt.push(head[v]); head[v] = to.length - 1; };
      for (let i = 0; i < n; i++) add(S0, i, 1, 0);
      for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) { const L = Lm[sel[j]][i]; if (L <= maxL) add(i, n + j, 1, Math.round(L * 10)); }
      for (let j = 0; j < k; j++) add(n + j, T, N, 0);
      let flow = 0, total = 0;
      const dist = new Array(V), prev = new Array(V), inq = new Array(V);
      for (;;) {
        dist.fill(1e15); prev.fill(-1); inq.fill(false); dist[S0] = 0;
        const q = [S0]; inq[S0] = true;
        for (let qi = 0; qi < q.length; qi++) {
          const u = q[qi]; inq[u] = false;
          for (let e = head[u]; e >= 0; e = nxt[e]) if (cap[e] > 0 && dist[u] + cost[e] < dist[to[e]]) { dist[to[e]] = dist[u] + cost[e]; prev[to[e]] = e; if (!inq[to[e]]) { inq[to[e]] = true; q.push(to[e]); } }
        }
        if (dist[T] >= 1e15) break;
        for (let v = T; v !== S0;) { const e = prev[v]; cap[e] -= 1; cap[e ^ 1] += 1; v = to[e ^ 1]; }
        flow++; total += dist[T];
      }
      const asg = new Array(n).fill(-1);
      for (let i = 0; i < n; i++) for (let e = head[i]; e >= 0; e = nxt[e]) if ((e & 1) === 0 && to[e] >= n && to[e] < n + k && cap[e] === 0) asg[i] = to[e] - n;
      return { flow, total: total / 10, asg };
    }
    function optimise(n, C, Lm, N, maxL, worth, finish) {
      const lb = Math.max(1, Math.ceil(n / N)); let best = null;
      const score = (r, k) => (n - r.flow) * 1e6 + worth * k + r.total;
      const full = (r, k, sel) => { const f = finish(sel, r); return (n - r.flow) * 1e9 + f.nx * 1e5 + worth * k + f.total; };
      for (let k = lb; k <= Math.min(C, lb + 2); k++) {
        let sel = [...new Set(Array.from({ length: k }, (_, i) => Math.min(C - 1, Math.floor((i + .5) * C / k))))];
        for (let c = 0; sel.length < k && c < C; c++) if (!sel.includes(c)) sel.push(c);
        let cur = assignOpt(sel, Lm, n, N, maxL), cs = score(cur, k), evals = 1;
        for (let improved = true; improved && evals < 120;) {
          improved = false;
          for (let a = 0; a < k && evals < 120; a++) for (let c = 0; c < C && evals < 120; c++) {
            if (sel.includes(c)) continue;
            const t = sel.slice(); t[a] = c; const r = assignOpt(t, Lm, n, N, maxL); evals++; const sc = score(r, k);
            if (sc < cs - 1e-6) { sel = t; cur = r; cs = sc; improved = true; }
          }
        }
        let fs0 = full(cur, k, sel);
        for (let improved = true, ev = 0; improved && ev < 60;) {
          improved = false;
          for (let a = 0; a < k && ev < 60; a++) for (let c = 0; c < C && ev < 60; c++) {
            if (sel.includes(c)) continue;
            const t = sel.slice(); t[a] = c; const r = assignOpt(t, Lm, n, N, maxL); ev++;
            if (r.flow < cur.flow) continue;
            const sc = full(r, k, t); if (sc < fs0 - 1e-6) { sel = t; cur = r; fs0 = sc; improved = true; }
          }
        }
        const cand = { k, sel, r: cur, score: fs0, ok: cur.flow === n };
        if (!best || cand.score < best.score) best = cand;
      }
      return best;
    }

    let XS = {}, groups = null;
    function placeKiosks() {
      groups = new Map();
      for (const e of erven) if (e.fe) { const k = e.road.id + '|' + e.seg; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
      const kiosks = []; let kn = 0; XS = {}; LC = new Map();
      for (const [gkey, list] of groups) {
        const st = list[0].road, side = ks[st.id];
        list.forEach(e => { e.gkey = gkey; e.via = null; });
        list.sort((a, b) => a.al - b.al || a.id - b.id);
        list.forEach(e => { e.mcs = markerCands(e); });
        const n = list.length, K = list.filter(e => e.sd === side);
        const cands = [];
        for (const e of K) {
          if (e.manual) continue;
          const fe = e.fe, lo = e.sa <= e.sb ? fe.a : fe.b, hi = e.sa <= e.sb ? fe.b : fe.a;
          for (const [a, v] of [[e.lo, lo], [e.hi, hi]]) {
            const hit = cands.find(c => Math.abs(c.a - a) <= 1.5);
            if (hit) { hit.shared = true; continue; }
            const x = v[0] + fe.out[0] * KD, y = v[1] + fe.out[1] * KD;
            cands.push({ a, x, y, s: project(st, x, y).s, shared: false });
          }
        }
        // a kiosk may also stand in the kiosk-side verge opposite a boundary between erven across the road
        for (const e of list.filter(q => q.sd !== side && !q.manual)) for (const a of [e.lo, e.hi]) {
          if (cands.some(c => Math.abs(c.a - a) <= 1.5)) continue;
          const pos = kp(st, side, a);
          cands.push({ a, x: pos[0], y: pos[1], s: a, shared: false, across: true });
        }
        if (!cands.length) { warns.push(`${st.name}: no place for a kiosk in one run. Flip the side.`); continue; }
        cands.sort((p, q) => p.a - q.a);
        let chosen = [];
        if (P.kmode === 'opt') {
          const Lm = cands.map(c => list.map(e => routeM(e, c)));
          const build = (sel, r) => {
            const byK = sel.map(() => []);
            list.forEach((e, i) => { let j = r.asg[i]; if (j < 0) { let m = 1e9; sel.forEach((c, jj) => { if (Lm[c][i] < m) { m = Lm[c][i]; j = jj; } }); } byK[j].push(e); });
            return sel.map((c, j) => ({ cand: cands[c], members: byK[j] })).filter(c => c.members.length);
          };
          const best = optimise(n, cands.length, Lm, P.n, P.maxc, P.worth, (sel, r) => stageB(list, build(sel, r)));
          chosen = build(best.sel, best.r);
        } else {
          const nK = Math.ceil(n / P.n), base = Math.floor(n / nK), extra = n % nK, used = new Set();
          let from = 0;
          for (let g = 0; g < nK; g++) {
            const cnt = base + (g < extra ? 1 : 0), members = list.slice(from, from + cnt); from += cnt;
            const target = members.reduce((s, e) => s + e.al, 0) / members.length;
            const pool = cands.filter(c => !used.has(c)), pickFrom = pool.some(c => c.shared) ? pool.filter(c => c.shared) : (pool.length ? pool : cands);
            const c = pickFrom.slice().sort((p, q) => Math.abs(p.a - target) - Math.abs(q.a - target))[0];
            used.add(c); chosen.push({ cand: c, members });
          }
        }
        const sb = stageB(list, chosen);
        sb.picks.forEach((pk, e) => { e.via = pk.x; });
        XS[gkey] = sb.xs.filter(x => [...sb.picks.values()].some(pk => pk.x === x)).map(x => x.s);
        for (const { cand, members } of chosen) {
          const k = { id: 'K' + (++kn), x: cand.x, y: cand.y, road: st, s: cand.s, members, flag: cand.shared ? '' : 'on a corner' };
          members.forEach(e => { e.kiosk = k; });
          kiosks.push(k);
        }
      }
      return kiosks;
    }

    // ── 2b. kiosks for the whole street network ──
    const XPEN = 300;                            // m of cable one road crossing counts for in the assignment
    function placeKiosksNet() {
      groups = new Map();
      for (const e of erven) if (e.fe) { const k = e.road.id + '|' + e.seg; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
      XS = {}; LC = new Map();
      const list = erven.filter(e => e.fe), n = list.length, kiosks = [];
      list.forEach(e => { e.gkey = e.road.id + '|' + e.seg; e.via = null; e.mcs = markerCands(e); e._k = null; e.hopN = 0; });
      if (!n) return kiosks;
      const maxc = P.maxc, N = Math.max(1, Math.round(P.n));
      // candidate stands: every street's kiosk-side verge at the erf boundaries, across the road from a boundary, and beside each junction
      const cands = [];
      for (const st of streets) {
        const side = ks[st.id], mine = [], L1 = list.filter(e => e.road === st), K = L1.filter(e => e.sd === side);
        for (const e of K) {
          if (e.manual) continue;
          const fe = e.fe, lo = e.sa <= e.sb ? fe.a : fe.b, hi = e.sa <= e.sb ? fe.b : fe.a;
          for (const [a, v] of [[e.lo, lo], [e.hi, hi]]) {
            const hit = mine.find(c => Math.abs(c.a - a) <= 1.5);
            if (hit) { hit.shared = true; continue; }
            const x = v[0] + fe.out[0] * KD, y = v[1] + fe.out[1] * KD;
            mine.push({ road: st, a, x, y, s: project(st, x, y).s, shared: false });
          }
        }
        for (const e of L1.filter(q => q.sd !== side && !q.manual)) for (const a of [e.lo, e.hi]) {
          if (mine.some(c => Math.abs(c.a - a) <= 1.5)) continue;
          const pos = kp(st, side, a); mine.push({ road: st, a, x: pos[0], y: pos[1], s: a, shared: false, across: true });
        }
        for (const id of st.jids) for (const Y of use[id] || []) {                      // beside a junction: clear of the crossing road's mouth
          if (Y === st) continue;
          for (const dir of [-1, 1]) {
            const s0 = st.nodeSt[id] + dir * (Y.w / 2 + 2.5); if (s0 < 0 || s0 > st.len || mine.some(c => Math.abs(c.s - s0) <= 1.5)) continue;
            const pos = kp(st, side, s0); mine.push({ road: st, a: s0, x: pos[0], y: pos[1], s: s0, shared: false, junction: true });
          }
        }
        cands.push(...mine);
      }
      const forced = -1;                                                       // kiosks are placed from the erven alone: a mini-sub never forces one
      const C = cands.length;
      if (!C) { warns.push('No place for a kiosk on any street.'); return kiosks; }
      // service length / road crossings from every stand to every erf (Infinity = out of reach)
      const Lm = cands.map(() => new Float64Array(n).fill(Infinity)), Xm = cands.map(() => new Uint8Array(n));
      const xcount = (pts, excl) => pathCrossings(pts, excl).length;
      for (let ci = 0; ci < C; ci++) {
        const c = cands[ci];
        for (let i = 0; i < n; i++) {
          const e = list[i];
          if (e.mcs.every(m => Math.hypot(m.pt[0] - c.x, m.pt[1] - c.y) > maxc)) continue;           // the cable cannot be shorter than the straight line
          if (c.road === e.road) {
            const L = routeM(e, c); if (L > maxc) continue;
            let X = e.sd !== ks[e.road.id] ? 1 : 0;
            const sMs = e.mcs.map(m => project(e.road, m.pt[0], m.pt[1]).s), lo = Math.min(c.s, ...sMs), hi = Math.max(c.s, ...sMs);
            if (e.road.stops.some(v => v > lo + 1 && v < hi - 1)) {                                    // the service runs on past a junction: side streets it crosses
              let bm = e.mcs[0], bl = Infinity; for (const m of e.mcs) { const l = plen(routeFor(e, c, m)); if (l < bl) { bl = l; bm = m; } }
              X += xcount(routeFor(e, c, bm), e.road);
            }
            Lm[ci][i] = L; Xm[ci][i] = Math.min(X, 9);
          } else {
            const ids = c.road.jids.filter(id => e.road.nodeSt[id] !== undefined); if (!ids.length) continue;
            let best = null;
            for (const id of ids) for (const m of e.mcs) { const r = routeHop(e, c, m, id), L = plen(r.pts); if (L <= maxc && (!best || L < best.L)) best = { L, r }; }
            if (!best) continue;
            Lm[ci][i] = best.L; Xm[ci][i] = Math.min((e.sd !== ks[e.road.id] ? 1 : 0) + xcount(best.r.pre, null), 9);
          }
        }
      }
      const wt = (ci, i) => Lm[ci][i] + XPEN * Xm[ci][i];
      const cover = cands.map((c, ci) => { const a = []; for (let i = 0; i < n; i++) if (Lm[ci][i] <= maxc) a.push(i); return a; });
      const servable = list.map((e, i) => cover.some(a => a.includes(i)));
      const nServ = servable.filter(Boolean).length;
      // erven → the chosen stands, each taking at most N: a small min-cost flow
      function assignG(sel) {
        const k = sel.length, V = n + k + 2, S0 = n + k, T = n + k + 1;
        const to = [], cap = [], cost = [], nxt = [], head = new Array(V).fill(-1);
        const add = (u, v, c, w) => { to.push(v); cap.push(c); cost.push(w); nxt.push(head[u]); head[u] = to.length - 1; to.push(u); cap.push(0); cost.push(-w); nxt.push(head[v]); head[v] = to.length - 1; };
        for (let i = 0; i < n; i++) add(S0, i, 1, 0);
        for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) if (Lm[sel[j]][i] <= maxc) add(i, n + j, 1, Math.round(wt(sel[j], i) * 10));
        for (let j = 0; j < k; j++) { add(n + j, T, N, 0); }
        let flow = 0, total = 0;
        const dist = new Array(V), prev = new Array(V), inq = new Array(V);
        for (;;) {
          dist.fill(1e15); prev.fill(-1); inq.fill(false); dist[S0] = 0;
          const q = [S0]; inq[S0] = true;
          for (let qi = 0; qi < q.length; qi++) {
            const u = q[qi]; inq[u] = false;
            for (let e = head[u]; e >= 0; e = nxt[e]) if (cap[e] > 0 && dist[u] + cost[e] < dist[to[e]]) { dist[to[e]] = dist[u] + cost[e]; prev[to[e]] = e; if (!inq[to[e]]) { inq[to[e]] = true; q.push(to[e]); } }
          }
          if (dist[T] >= 1e15) break;
          for (let v = T; v !== S0;) { const e = prev[v]; cap[e] -= 1; cap[e ^ 1] += 1; v = to[e ^ 1]; }
          flow++; total += dist[T];
        }
        const asg = new Array(n).fill(-1); let cable = 0;
        for (let i = 0; i < n; i++) for (let e = head[i]; e >= 0; e = nxt[e]) if ((e & 1) === 0 && to[e] >= n && to[e] < n + k && cap[e] === 0) { asg[i] = to[e] - n; cable += Lm[sel[asg[i]]][i]; }
        return { flow, cost: total / 10, cable, asg };
      }
      // 1. construction: the stand that takes the most still-unserved erven (at most N, the nearest), until every reachable erf is served
      let sel = [];
      const left = new Set(list.map((e, i) => i).filter(i => servable[i]));
      const take = (ci) => {
        const inc = cover[ci].filter(i => left.has(i)).sort((a, b) => wt(ci, a) - wt(ci, b)).slice(0, N);
        inc.forEach(i => left.delete(i)); return inc;
      };
      if (forced >= 0 && cover[forced].length) { sel.push(forced); take(forced); }
      while (left.size) {
        let best = null;
        for (let ci = 0; ci < C; ci++) {
          if (sel.includes(ci)) continue;
          const inc = cover[ci].filter(i => left.has(i)).sort((a, b) => wt(ci, a) - wt(ci, b)).slice(0, N);
          if (!inc.length) continue;
          const per = inc.reduce((a, i) => a + wt(ci, i), 0) / inc.length;
          if (!best || inc.length > best.g || (inc.length === best.g && per < best.per - 1e-9)) best = { ci, g: inc.length, per };
        }
        if (!best) break;
        sel.push(best.ci); take(best.ci);
      }
      let cur = assignG(sel), budget = 500 + 8 * n;
      const members = (r, j) => r.asg.reduce((a, v) => a + (v === j ? 1 : 0), 0);
      // 2. give kiosks up (the smallest first) while every erf stays served and the extra cable stays within `worth`; 3. swap a stand for a nearby one that cuts cable
      for (let round = 0; round < 6; round++) {
        let changed = false;
        for (let again = true; again && budget > 0;) {
          again = false;
          const order = sel.map((c, j) => j).sort((a, b) => members(cur, a) - members(cur, b));
          for (const j of order) {
            if (sel[j] === forced && members(cur, j)) continue;
            const t = sel.filter((c, q) => q !== j), r = assignG(t); budget--;
            if (r.flow >= cur.flow && r.flow === nServ && r.cable - cur.cable <= P.worth) { sel = t; cur = r; again = true; changed = true; break; }
            if (budget <= 0) break;
          }
        }
        for (let j = 0; j < sel.length && budget > 0; j++) {
          if (sel[j] === forced) continue;
          const a = cands[sel[j]]; let bestC = null;
          for (let ci = 0; ci < C && budget > 0; ci++) {
            if (sel.includes(ci) || Math.hypot(cands[ci].x - a.x, cands[ci].y - a.y) > 60) continue;
            const t = sel.slice(); t[j] = ci; const r = assignG(t); budget--;
            if (r.flow >= cur.flow && r.cost < (bestC ? bestC.r.cost : cur.cost) - 1e-6) bestC = { ci, r };
          }
          if (bestC) { sel[j] = bestC.ci; cur = bestC.r; changed = true; }
        }
        if (!changed) break;
      }
      // 4. a kiosk is added only where it saves more cable than one is worth
      for (let add = 0; add < 3 && budget > 0; add++) {
        let bestA = null;
        for (let ci = 0; ci < C && budget > 0; ci++) {
          if (sel.includes(ci)) continue;
          const r = assignG(sel.concat([ci])); budget--;
          const gain = cur.cable - r.cable; if (r.flow >= cur.flow && gain > P.worth && (!bestA || gain > bestA.gain)) bestA = { ci, r, gain };
        }
        if (!bestA) break; sel.push(bestA.ci); cur = bestA.r;
      }
      // the kiosks: each erf to its stand (an erf nothing reaches goes to the nearest one and is reported as over the limit)
      const chosen = sel.map(ci => ({ cand: cands[ci], members: [] }));
      list.forEach((e, i) => {
        let j = cur.asg[i];
        if (j < 0) { let m = Infinity; chosen.forEach((c, q) => { const d = Math.hypot(c.cand.x - e.mcs[0].pt[0], c.cand.y - e.mcs[0].pt[1]); if (d < m) { m = d; j = q; } }); }
        chosen[j].members.push(e);
      });
      const ord = new Map(streets.map((s, i) => [s, i]));
      const live = chosen.filter(c => c.members.length).sort((p, q) => ord.get(p.cand.road) - ord.get(q.cand.road) || p.cand.s - q.cand.s);
      // crossings are shared per street: the erven a street's own kiosks serve across the road cross at the shared boundaries (stageB)
      for (const st of streets) {
        const own = live.filter(c => c.cand.road === st); if (!own.length) continue;
        const sub = own.map(c => ({ cand: c.cand, members: c.members.filter(e => e.road === st) })).filter(c => c.members.length);
        const L1 = list.filter(e => e.road === st);
        if (!sub.length) continue;
        L1.forEach(e => { e._k = null; });
        const sb = stageB(L1.slice().sort((a, b) => a.al - b.al), sub);
        sb.picks.forEach((pk, e) => { e.via = pk.x; });
        const used = sb.xs.filter(x => [...sb.picks.values()].some(pk => pk.x === x)).map(x => x.s);
        for (const gk of groups.keys()) if (gk.startsWith(st.id + '|')) XS[gk] = used;
      }
      for (const { cand, members: ms } of live) {
        const k = { id: 'K' + (kiosks.length + 1), x: cand.x, y: cand.y, road: cand.road, s: cand.s, members: ms, flag: cand.hand ? 'placed by hand' : cand.junction ? 'at a junction' : cand.shared ? '' : 'on a corner' };
        ms.forEach(e => { e.kiosk = k; });
        kiosks.push(k);
      }
      return kiosks;
    }
    function placeMarkers() {
      for (const e of erven) {
        e.marker = null; e.route = null; e.cable = 0; e.fibrePt = null;
        if (!e.fe) continue;
        const mcs = e.mcs || markerCands(e);
        let mc = mcs[0], route = null;
        if (e.kiosk) {
          let bl = 1e9;
          for (const m of mcs) { const r = e.via ? routeVia(e, e.kiosk, m, e.via) : routeAny(e, e.kiosk, m), L = plen(r); if (L < bl) { bl = L; mc = m; route = r; } }
        }
        e.marker = mc.pt; e.corner_pt = mc.c; e.fibrePt = mc.fpt;
        if (route) { e.route = route; e.cable = plen(route); e.hopN = route.hopN || 0; }
      }
    }

    // ── 3. fibre ──
    const fibreSign = st => fs[st.id] != null ? fs[st.id] : (P.fibre === 'opp' ? -ks[st.id] : ks[st.id]);
    function placeFibre() {
      const mhs = [], fwarn = []; let n = 0;
      const maxA = P.maxmh;
      for (const [gkey, list] of groups) {
        const st = list[0].road, sg = fibreSign(st), seg = list[0].seg;
        list.sort((a, b) => a.al - b.al || a.id - b.id);
        const cnt = list.length, nM = Math.ceil(cnt / P.m), base = Math.floor(cnt / nM), extra = cnt % nM;
        const K = list.filter(e => e.sd === sg);
        const bounds = [];
        for (let i = 0; i < K.length - 1; i++) if (Math.abs(K[i].hi - K[i + 1].lo) <= 1.5) bounds.push({ a: K[i].hi, used: false });
        (XS[gkey] || []).forEach(x0 => { const b = bounds.find(q => Math.abs(q.a - x0) <= 1.5); if (b) b.cross = true; else bounds.push({ a: x0, used: false, cross: true }); });
        const pickB = tg => bounds.filter(b => !b.used).sort((p, q) => (Math.abs(p.a - tg) - (p.cross ? 8 : 0)) - (Math.abs(q.a - tg) - (q.cross ? 8 : 0)))[0];
        const mk = a => { const pos = kp(st, sg, a, 't'), m = { id: 'M' + (++n), x: pos[0], y: pos[1], a, road: st, members: [], junction: false, label: String(n), sg }; mhs.push(m); return m; };
        const here = []; let from = 0;
        for (let g = 0; g < nM; g++) {
          const c = base + (g < extra ? 1 : 0), members = list.slice(from, from + c); from += c;
          const target = members.reduce((s, e) => s + e.al, 0) / members.length;
          const free = pickB(target);
          let a = target; if (free) { free.used = true; a = free.a; }
          here.push(mk(a));
        }
        const stops = st.stops, nodeAt = s0 => st.jids.find(id => Math.abs(st.nodeSt[id] - s0) < .3);
        const ends = [stops[seg], stops[seg + 1]].filter(s0 => nodeAt(s0));
        const marks = [...ends, ...here.map(m => m.a)].sort((p, q) => p - q);
        for (let i = 1; i < marks.length; i++) {
          const gap = marks[i] - marks[i - 1], extraN = Math.ceil(gap / maxA) - 1;
          for (let j = 1; j <= extraN; j++) {
            let a = marks[i - 1] + gap * j / (extraN + 1);
            const near = pickB(a);
            if (near && Math.abs(near.a - a) < 4.5) { near.used = true; a = near.a; }
            here.push(mk(a));
          }
        }
        here.forEach(m => { m.members = []; });
        list.forEach(e => { let best = null; for (const m of here) if (!best || Math.abs(m.a - e.al) < Math.abs(best.a - e.al)) best = m; best.members.push(e); e.mh = best; });
      }
      const inter = junctions.map(j => {
        const ps = use[j.id].map(st => kp(st, fibreSign(st), st.nodeSt[j.id], 't'));
        return { id: j.id, x: ps.reduce((s, p) => s + p[0], 0) / ps.length, y: ps.reduce((s, p) => s + p[1], 0) / ps.length, junction: true, label: '', streets: use[j.id] };
      });
      const nodes = [...inter, ...mhs], edges = [];
      const stat = (nd, st) => nd.junction ? st.nodeSt[nd.id] : nd.a;
      streets.forEach(st => {
        const on = nodes.filter(nd => nd.junction ? nd.streets.includes(st) : nd.road === st).sort((p, q) => stat(p, st) - stat(q, st));
        for (let i = 1; i < on.length; i++) {
          const A = on[i - 1], B = on[i], sa = stat(A, st), sb = stat(B, st), sg = fibreSign(st);
          const pts = [[A.x, A.y]]; if (sb - sa > 5) pts.push(...kv(st, sg, sa + 2.5, sb - 2.5, 't')); pts.push([B.x, B.y]);
          edges.push({ a: A, b: B, st, pts, len: plen(pts), key: st.id + '|' + Math.round((sa + sb) / 6) * 3 });
        }
      });
      const usable = edges.filter(e => !cuts.has(e.key));
      let ep = input.entryPt;
      if (!ep && inter.length) ep = [inter[0].x, inter[0].y];
      if (!ep && mhs.length) ep = [mhs[0].x, mhs[0].y];
      const entry = nodes.length ? nodes.slice().sort((p, q) => Math.hypot(p.x - ep[0], p.y - ep[1]) - Math.hypot(q.x - ep[0], q.y - ep[1]))[0] : null;
      let active = [];
      if (entry) {
        if (P.topo === 'ring') active = usable.slice();
        else {
          const dist = new Map(nodes.map(nd => [nd, Infinity])), via = new Map(), done = new Set();
          dist.set(entry, 0);
          for (;;) {
            let u = null; for (const nd of nodes) if (!done.has(nd) && dist.get(nd) < Infinity && (!u || dist.get(nd) < dist.get(u))) u = nd;
            if (!u) break; done.add(u);
            for (const e of usable) { const v = e.a === u ? e.b : e.b === u ? e.a : null; if (v && dist.get(u) + e.len < dist.get(v) - 1e-9) { dist.set(v, dist.get(u) + e.len); via.set(v, e); } }
          }
          active = [...new Set(via.values())];
          for (let again = true; again;) {
            again = false;
            const dg = new Map(); active.forEach(e => { dg.set(e.a, (dg.get(e.a) || 0) + 1); dg.set(e.b, (dg.get(e.b) || 0) + 1); });
            for (const e of active.slice()) for (const nd of [e.a, e.b]) if (nd.junction && nd !== entry && dg.get(nd) === 1) { active.splice(active.indexOf(e), 1); again = true; break; }
          }
        }
      }
      const deg = new Map(); active.forEach(e => { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); });
      const reach = new Set(entry ? [entry] : []);
      for (let ch = true; ch;) { ch = false; for (const e of active) if (reach.has(e.a) !== reach.has(e.b)) { reach.add(e.a); reach.add(e.b); ch = true; } }
      mhs.forEach(m => { m.off = !reach.has(m); });
      const off = mhs.filter(m => m.off);
      if (off.length) fwarn.push(`${off.length} manhole${off.length === 1 ? ' is' : 's are'} not connected to the fibre entry. Put a trunk section back.`);
      const tOffs = [...deg.values()].filter(d => d >= 3).length, ends = [...deg.entries()].filter(([nd, d]) => d === 1 && nd !== entry).length;
      const loops = Math.max(0, active.length - deg.size + 1);
      let trunkLen = 0; active.forEach(e => { trunkLen += e.len; });
      let leadLen = 0, leadMax = 0;
      for (const e of erven) {
        e.duct = null; e.fibX = null;
        if (!e.mh || !e.fibrePt) continue;
        const st = e.road, m = e.mh, sF = project(st, e.fibrePt[0], e.fibrePt[1]).s;
        let pts, xsel = null;
        if (e.sd === m.sg) pts = [[m.x, m.y], ...kv(st, m.sg, m.a, sF, 't'), e.fibrePt];
        else {
          let bd = Infinity;
          for (const s0 of (XS[e.gkey] || [])) { const d = Math.abs(m.a - s0) + Math.abs(s0 - sF); if (d < bd) { bd = d; xsel = s0; } }
          if (xsel == null || (bd - Math.abs(m.a - sF)) > 50) xsel = m.a;
          pts = [[m.x, m.y], ...kv(st, m.sg, m.a, xsel, 't'), kp(st, e.sd, xsel, 't').slice(0, 2), ...kv(st, e.sd, xsel, sF, 't').slice(1), e.fibrePt];
        }
        e.fibX = xsel; e.duct = pts; e.ductLen = plen(pts); leadLen += e.ductLen; leadMax = Math.max(leadMax, e.ductLen);
      }
      return { mhs, inter, trunks: active, spare: edges.filter(e => !active.includes(e)), nodes, entry, tOffs, ends, loops, trunkLen, leadLen, leadMax, maxGap: Math.max(0, ...edges.map(e => e.len)), warns: fwarn };
    }

    // ── 4. LV, MV and the shared crossings ──
    function pathCrossings(pts, excl) {
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
        for (const X of streets) {
          if (X === excl) continue;
          for (let j = 1; j < X.pts.length; j++) {
            const c = X.pts[j - 1], d = X.pts[j];
            if (Math.max(c[0], d[0]) < x0 - .3 || Math.min(c[0], d[0]) > x1 + .3 || Math.max(c[1], d[1]) < y0 - .3 || Math.min(c[1], d[1]) > y1 + .3) continue;
            const q = segInter(a, b, c, d); if (q) out.push({ st: X, s: project(X, q[0], q[1]).s });
          }
        }
      }
      return out;
    }
    function placeNetworks(kiosks) {
      const events = [];
      for (const e of erven) {
        if (e.kiosk && e.sd !== ks[e.road.id]) events.push({ st: e.road, s: e.via ? e.via.s : project(e.road, e.marker[0], e.marker[1]).s, t: 'svc' });
        if (e.kiosk && e.route) {                                                      // a service that runs round a junction crosses the roads on the way
          const hn = e.hopN || 0;
          if (hn) pathCrossings(e.route.slice(0, hn), null).forEach(x => events.push({ st: x.st, s: x.s, t: 'svc' }));
          pathCrossings(e.route.slice(Math.max(0, hn - 1)), e.road).forEach(x => events.push({ st: x.st, s: x.s, t: 'svc' }));
        }
        if (e.duct && e.fibX != null) events.push({ st: e.road, s: e.fibX, t: 'fib' });
      }
      if (P.junct) junctions.forEach(j => use[j.id].forEach(X => {
        const s0 = X.nodeSt[j.id];
        if (s0 > 2) events.push({ st: X, s: s0 - 5, t: 'jn' });
        if (s0 < X.len - 2) events.push({ st: X, s: s0 + 5, t: 'jn' });
      }));
      const net = { lv: [], mv: [], sub: null, subs: [], mvLines: [], mvLine: [], lvLen: 0, mvLen: 0, lvLinks: [], mvPts: null, unreached: [] };
      if (kiosks.length) {
        const nodes = [], map = new Map();
        const node = (st, s0) => { const key = st.id + '|' + Math.round(s0 / 1.5); let n = map.get(key); if (!n) { n = { id: nodes.length, st, s: s0, adj: [] }; map.set(key, n); nodes.push(n); } return n; };
        kiosks.forEach(k => { k.node = node(k.road, k.s); });
        // mini-subs placed by hand: a free point anywhere. It joins the verge network at the nearest street (its node is made here so
        // the graph links it), and its own cables run from the point to that verge and along it.
        const manualRoots = [];
        (input.subPts || []).forEach((pt, i) => {
          let bs = null; for (const st of streets) { const pr = project(st, pt[0], pt[1]); if (!bs || pr.d < bs.d) bs = { st, s: pr.s }; }
          if (!bs) return;
          const nd = node(bs.st, bs.s), V = kp(bs.st, ks[bs.st.id] || 1, nd.s).slice(0, 2);
          manualRoots.push({ id: 'SUBPT' + (i + 1), x: pt[0], y: pt[1], root: true, manual: true, members: [], road: bs.st, s: nd.s, node: nd, stub: [[pt[0], pt[1]], V] });
        });
        streets.forEach(st => { node(st, 0); node(st, st.len); st.jids.forEach(id => node(st, st.nodeSt[id])); });
        const edges = [];
        const link = (A, B, pts, excl) => { const xs = pathCrossings(pts, excl), len = plen(pts), ed = { a: A, b: B, pts, len, xs, w: len + xs.length * 300 }; edges.push(ed); A.adj.push(ed); B.adj.push(ed); };
        streets.forEach(st => {
          const on = nodes.filter(n => n.st === st).sort((p, q) => p.s - q.s);
          for (let i = 1; i < on.length; i++) if (on[i].s - on[i - 1].s > .4) link(on[i - 1], on[i], kv(st, ks[st.id] || 1, on[i - 1].s, on[i].s), st);
        });
        for (const j of junctions) {
          const ss = use[j.id];
          for (let i = 0; i < ss.length; i++) for (let k = i + 1; k < ss.length; k++) {
            const A = ss[i], B = ss[k], nA = node(A, A.nodeSt[j.id]), nB = node(B, B.nodeSt[j.id]);
            link(nA, nB, [kp(A, ks[A.id] || 1, nA.s).slice(0, 2), kp(B, ks[B.id] || 1, nB.s).slice(0, 2)], null);
          }
        }
        // shortest-path tree of the kiosk-side verge graph from one kiosk (crossings carry a penalty in the weights)
        const treeFrom = (sk) => {
          const dist = new Map(nodes.map(n => [n, Infinity])), prev = new Map(), done = new Set();
          dist.set(sk.node, 0);
          for (;;) {
            let u = null; for (const n of nodes) if (!done.has(n) && dist.get(n) < Infinity && (!u || dist.get(n) < dist.get(u))) u = n;
            if (!u) break; done.add(u);
            for (const ed of u.adj) { const v = ed.a === u ? ed.b : ed.a; if (dist.get(u) + ed.w < dist.get(v) - 1e-9) { dist.set(v, dist.get(u) + ed.w); prev.set(v, ed); } }
          }
          return { dist, prev };
        };
        const trees = new Map();
        const T = k => { let t = trees.get(k); if (!t) { t = treeFrom(k); trees.set(k, t); } return t; };
        const dd = (a, b) => T(a).dist.get(b.node);
        // the mini-sub of a group of kiosks: the one placed by hand (nearest kiosk to it), the middle of the kiosks, or — the default —
        // where the LV network drops least. That is a search guide (the real volt drop is worked out by Demand afterwards): for each
        // candidate kiosk, the worst "erven below × length" summed along a kiosk's path, then the shortest LV network.
        const pickSub = (grp, sp) => {
          if (sp || P.subMode !== 'opt' || grp.length < 3) {
            if (!sp) sp = [grp.reduce((a, k) => a + k.x, 0) / grp.length, grp.reduce((a, k) => a + k.y, 0) / grp.length];
            return grp.slice().sort((p, q) => Math.hypot(p.x - sp[0], p.y - sp[1]) - Math.hypot(q.x - sp[0], q.y - sp[1]))[0];
          }
          // only a kiosk the LV network can leave: the ones that reach the most of the group (all of it, on a connected network)
          const reaches = c => grp.filter(k => T(c).dist.get(k.node) < Infinity).length, top = Math.max(...grp.map(reaches));
          const pool = grp.filter(c => reaches(c) === top);
          let best = null;
          for (const cand of pool) {
            const t = T(cand), load = new Map(), used = new Set();
            for (const k of grp) for (let v = k.node; v !== cand.node && t.prev.get(v);) { const ed = t.prev.get(v); load.set(ed, (load.get(ed) || 0) + k.members.length); used.add(ed); v = ed.a === v ? ed.b : ed.a; }
            let worst = 0;
            for (const k of grp) { let m = 0; for (let v = k.node; v !== cand.node && t.prev.get(v);) { const ed = t.prev.get(v); m += load.get(ed) * ed.len; v = ed.a === v ? ed.b : ed.a; } if (m > worst) worst = m; }
            let tot = 0; used.forEach(ed => { tot += ed.len; });
            if (!best || worst < best.worst - 1e-6 || (Math.abs(worst - best.worst) <= 1e-6 && tot < best.tot)) best = { cand, worst, tot };
          }
          return best.cand;
        };
        // an automatic mini-sub stands 5 m along the street from the kiosk it is built beside (that kiosk is one the erven need anyway)
        const asRoot = k => {
          const st = k.road, s2 = k.s + 5 <= st.len ? k.s + 5 : Math.max(0, k.s - 5), p = kp(st, ks[st.id] || 1, s2).slice(0, 2);
          return { id: 'SUBAUTO', x: p[0], y: p[1], root: true, members: [], road: st, s: s2, node: k.node, stub: [p, [k.x, k.y]] };
        };
        // the mini-subs are the ones placed by hand, where you put them (with none placed — only the tests — `subs` of them are chosen).
        // The kiosks are split by LV distance; each group gets its own tree.
        const nFix = manualRoots.length, nSub = nFix || Math.min(Math.round(P.subs) || 1, kiosks.length);
        let subs;
        if (nSub === 1) subs = [{ k: nFix ? manualRoots[0] : asRoot(pickSub(kiosks, null)), g: kiosks }];
        else {
          const cost = (c, g) => g.reduce((a, k) => a + dd(c, k) * k.members.length, 0);
          const med = manualRoots.slice();
          if (!med.length) med.push(kiosks.slice().sort((p, q) => cost(p, kiosks) - cost(q, kiosks))[0]);
          while (med.length < nSub) {
            let far = null, fd = -1;
            for (const k of kiosks) { if (med.includes(k)) continue; const d = Math.min(...med.map(m => dd(m, k))); if (d > fd) { fd = d; far = k; } }
            if (!far) break; med.push(far);
          }
          // each kiosk goes to its nearest mini-sub. With none placed by hand, a mini-sub takes at most ~20 % more than an even share of the
          // erven (the kiosks with most to lose first), so the transformers carry similar loads; mini-subs you placed take what is nearest.
          const total = kiosks.reduce((a, k) => a + k.members.length, 0), cap = nFix ? Infinity : Math.ceil(total / nSub * 1.2);
          const assign = () => {
            const g = med.map(() => []), used = med.map(() => 0);
            const ds = new Map(kiosks.map(k => [k, med.map(m => dd(m, k))]));
            const regret = k => { const d = ds.get(k).slice().sort((p, q) => p - q); return (d[1] === undefined ? 0 : d[1]) - d[0]; };
            kiosks.slice().sort((p, q) => regret(q) - regret(p)).forEach(k => {
              const d = ds.get(k), order = d.map((v, i) => i).sort((p, q) => d[p] - d[q]);
              const bi = order.find(i => used[i] + k.members.length <= cap) ?? order[0];
              g[bi].push(k); used[bi] += k.members.length;
            });
            return g;
          };
          let groups = assign();
          for (let it = 0; it < 10; it++) {
            let moved = false;
            groups.forEach((g, i) => { if (i < nFix) return; let bk = med[i], bc = cost(med[i], g); g.forEach(c => { const cc = cost(c, g); if (cc < bc - 1e-6) { bc = cc; bk = c; } }); if (bk !== med[i]) { med[i] = bk; moved = true; } });
            if (!moved) break;
            groups = assign();
          }
          subs = med.map((m, i) => ({ k: i < nFix ? m : asRoot(m), g: groups[i] })).filter(x => x.g.length || x.k.manual);
        }
        // placed mini-subs keep the order you placed them in (S1, S2, …); chosen ones start from the first street
        if (!nFix) { const sup = streets[0] ? ptAt(streets[0], 0, 0) : [0, 0]; subs.sort((p, q) => Math.hypot(p.k.x - sup[0], p.k.y - sup[1]) - Math.hypot(q.k.x - sup[0], q.k.y - sup[1])); }
        subs.forEach((s, i) => { s.id = i + 1; s.g.forEach(k => { k.subK = s.k; }); });
        net.subs = subs; net.sub = subs[0].k;
        const lvSet = new Set();
        const cat = (pts, seg) => { seg.forEach(p => { if (!pts.length || Math.hypot(pts[pts.length - 1][0] - p[0], pts[pts.length - 1][1] - p[1]) > .01) pts.push(p); }); return pts; };
        for (const S of subs) {
          const sk = S.k, prev = T(sk).prev, kioskNode = new Map(S.g.map(k => [k.node, k]));
          for (const k of S.g) {
            for (let v = k.node; v !== sk.node && prev.get(v);) { const ed = prev.get(v); lvSet.add(ed); v = ed.a === v ? ed.b : ed.a; }
            // the link from the nearest kiosk (or the mini-sub itself) up the tree to this one
            const path = []; let v = k.node, parent = null;
            if (v === sk.node) parent = sk;
            else while (prev.get(v)) {
              const ed = prev.get(v); path.push({ ed, from: ed.a === v ? ed.b : ed.a, to: v }); v = ed.a === v ? ed.b : ed.a;
              if (v === sk.node) { parent = sk; break; }
              if (kioskNode.has(v)) { parent = kioskNode.get(v); break; }
            }
            if (!parent) continue;
            const pts = parent === sk ? sk.stub.map(q => q.slice()) : [];                 // a string head leaves the mini-sub itself: its cable starts at the mini-sub
            path.slice().reverse().forEach(st => cat(pts, st.ed.a === st.from ? st.ed.pts : st.ed.pts.slice().reverse()));
            if (parent === sk) cat(pts, [[k.x, k.y]]);
            if (pts.length < 2) continue;
            net.lvLinks.push({ from: parent, to: k, pts, len: plen(pts) });
            if (parent === sk) pathCrossings(sk.stub, null).forEach(x => events.push({ st: x.st, s: x.s, t: 'lv' }));   // each string has its own cable over the stub
          }
        }
        net.unreached = [];                                                          // kiosks the LV network does not reach (streets not joined up): their erven have no LV supply
        for (const S of subs) for (const k of S.g) if (k !== S.k && !(T(S.k).dist.get(k.node) < Infinity)) net.unreached.push(k);
        // a split string: a kiosk made its own string head (a feeder of its own straight off the mini-sub, along the same route)
        if (input.splits && input.splits.length) {
          const orig = new Map(net.lvLinks.map(l => [l.to, l]));
          for (const l of net.lvLinks.slice()) {
            const S = subs.find(x => x.g.includes(l.to));
            if (!S || l.from === S.k || !input.splits.some(q => Math.hypot(q[0] - l.to.x, q[1] - l.to.y) <= 3)) continue;
            const chain = []; for (let cur = orig.get(l.to); cur; cur = cur.from === S.k ? null : orig.get(cur.from)) chain.unshift(cur);
            const pts = []; chain.forEach(c => c.pts.forEach(q => { if (!pts.length || Math.hypot(pts[pts.length - 1][0] - q[0], pts[pts.length - 1][1] - q[1]) > .01) pts.push(q); }));
            l.from = S.k; l.pts = pts; l.len = plen(pts); l.split = true;
          }
        }
        net.lv = [...lvSet]; net.lvLen = net.lv.reduce((a, ed) => a + ed.len, 0);
        net.lv.forEach(ed => ed.xs.forEach(x => events.push({ st: x.st, s: x.s, t: 'lv' })));
        // MV is not designed here: the mini-subs are fed from outside the layout
        net.mv = []; net.mvLen = 0; net.mvLines = []; net.mvLine = []; net.mvPts = null;
      }
      events.sort((p, q) => p.st.id.localeCompare(q.st.id) || p.s - q.s);
      const cross = [];
      for (const ev of events) {
        const last = cross[cross.length - 1];
        if (last && last.st === ev.st && ev.s - last.s0 <= 2.7) {
          last[ev.t]++;
          if (ev.t !== 'jn') { last.n++; last.sum += ev.s; last.s = last.sum / last.n; }
        } else cross.push({ st: ev.st, s0: ev.s, s: ev.s, sum: ev.t === 'jn' ? 0 : ev.s, n: ev.t === 'jn' ? 0 : 1, svc: 0, fib: 0, lv: 0, mv: 0, jn: 0, [ev.t]: 1 });
      }
      cross.forEach(c => {
        c.prov = c.n === 0;
        if (c.prov) { c.d110s = c.d110f = c.d110l = 0; c.d110 = P.j110; c.d160 = P.j160; c.spare = 0; }
        else { c.d110s = Math.ceil(c.svc / 4); c.d110f = Math.ceil(c.fib / 4); c.d110l = Math.ceil(c.lv / 2); c.d160 = c.mv; c.spare = P.spare; c.d110 = c.d110s + c.d110f + c.d110l + P.spare; }
      });
      net.cross = cross; net.baseline = events.filter(ev => ev.t !== 'jn').length; net.prov = cross.filter(c => c.prov).length;
      net.d110 = cross.reduce((a, c) => a + c.d110, 0); net.d160 = cross.reduce((a, c) => a + c.d160, 0);
      return net;
    }

    // ── run ──
    detectFronts();
    streets.forEach(st => {
      if (!ks[st.id]) { const c = erven.filter(e => e.road === st); ks[st.id] = c.filter(e => e.sd === 1).length >= c.filter(e => e.sd === -1).length ? 1 : -1; }
    });
    const kiosks = P.kmode === 'opt' && P.knet !== false ? placeKiosksNet() : placeKiosks();
    placeMarkers();
    const over = erven.filter(e => e.cable > P.maxc + 1e-6);
    if (over.length) warns.push(`${over.length} erven are more than ${P.maxc} m of service cable from their kiosk.`);
    const noFront = erven.filter(e => !e.fe);
    if (noFront.length) warns.push(`${noFront.length} erven do not face a street and were left out.`);
    const fibre = placeFibre();
    const net = placeNetworks(kiosks);
    const cab = erven.filter(e => e.cable).map(e => e.cable);
    return {
      P, streets, junctions, erven, kiosks, fibre, net, over, noFront, ks, fs,
      warns: warns.concat(fibre.warns),
      stats: {
        erven: erven.filter(e => e.fe).length, kiosks: kiosks.length, small: kiosks.filter(k => k.members.length <= 2).length, avgPer: kiosks.length ? erven.filter(e => e.kiosk).length / kiosks.length : 0, unreached: net.unreached.length, manual: erven.filter(e => e.manual).length, corner: erven.filter(e => e.corner).length, overridden: Object.keys(overrides).length,
        cable: cab.reduce((a, b) => a + b, 0), cableMax: Math.max(0, ...cab), over: over.length,
        manholes: fibre.mhs.length, junctionManholes: fibre.inter.length, trunk: fibre.trunkLen, leads: fibre.leadLen, tOffs: fibre.tOffs, spurEnds: fibre.ends, loops: fibre.loops,
        crossings: net.cross.length, provisional: net.prov, baseline: net.baseline, d110: net.d110, d160: net.d160, lv: net.lvLen, mv: net.mvLen, ms: Date.now() - t0,
      },
    };
  }

  // ───────────── trenches along the created routes ─────────────
  // Cables that run along the same verge share one trench: the routes are cut into runs on the kiosk-side
  // and civil-side verge lines, overlapping runs are merged, and what is left (the short legs into an erf,
  // the bridges round a junction) become small trenches of their own. Road crossings get one shared
  // trench each. Depths (m) and what shares a trench are settings.
  const TRENCH_DEFAULTS = {
    depth: { mv: 1.1, lv: 0.7, fi: 0.6, comb: null },     // MV; LV + service + street light; fibre; combined (null = the deepest of its cables)
    combine: 'separate',                                   // 'separate' | 'mvlv': MV in the same trench as LV / service / street light
    fibre: 'own',                                          // 'own' | 'with' (in the LV trench where they run together) | 'off'
    crossings: true,                                       // a shared trench across the road at every crossing
  };
  function trenches(res, Tin) {
    const T = { depth: Object.assign({}, TRENCH_DEFAULTS.depth, (Tin && Tin.depth) || {}), combine: (Tin && Tin.combine) || TRENCH_DEFAULTS.combine, fibre: (Tin && Tin.fibre) || TRENCH_DEFAULTS.fibre, crossings: !(Tin && Tin.crossings === false) };
    const streets = res.streets, lines = [], spurs = new Map(), out = [];
    const lineFor = (st, sign, off) => { let l = lines.find(q => q.st === st && q.sign === sign && Math.abs(q.off - off) <= 0.75); if (!l) { l = { st, sign, off, offN: 0, ivs: [] }; lines.push(l); } l.off = (l.off * l.offN + off) / (l.offN + 1); l.offN++; return l; };
    const rnd = p => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4);
    const flush = (chain, cat) => { if (chain.length < 2) return; const a = rnd(chain[0]), b = rnd(chain[chain.length - 1]), key = a < b ? a + '|' + b : b + '|' + a; let sp = spurs.get(key); if (!sp) { sp = { pts: chain.slice(), cats: new Set() }; spurs.set(key, sp); } sp.cats.add(cat); };
    const add = (pts, cat) => {
      let chain = [];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05) continue;
        let best = null; for (const st of streets) { const pr = project(st, mid[0], mid[1]); if (!best || pr.d < best.pr.d) best = { st, pr }; }
        const st = best.st, pp = project(st, p[0], p[1]), pq = project(st, q[0], q[1]), op = pp.side * pp.d, oq = pq.side * pq.d;
        if (Math.abs(op - oq) > 3) { flush(chain, cat); chain = []; continue; }              // across a road: the crossing trench covers it
        const m = (Math.abs(op) + Math.abs(oq)) / 2, sg = Math.sign(op + oq) || 1, sMid = (pp.s + pq.s) / 2;
        // on the boundary corridor a line is told apart by how far it sits from the corridor itself (0 = kd inside the boundary)
        const bnd = st.byBoundary && typeof st.fd === 'function', rel = bnd ? m - (st.fd(sg, sMid) - st.kd) : m;
        if (Math.abs(op - oq) <= 0.6 && Math.abs(pq.s - pp.s) > 0.05 && (bnd ? rel >= -1.5 && rel <= st.kd + 0.5 : m >= st.vk - 1.5 && m <= st.w / 2 + 0.5)) {
          flush(chain, cat); chain = [];
          lineFor(st, sg, rel).ivs.push({ s0: Math.min(pp.s, pq.s), s1: Math.max(pp.s, pq.s), cat });
        } else { if (!chain.length) chain.push(p); chain.push(q); }
      }
      flush(chain, cat);
    };
    res.erven.forEach(e => { if (e.route) add(e.route, 'svc'); if (T.fibre !== 'off' && e.duct) add(e.duct, 'fi'); });
    if (res.net) { res.net.lv.forEach(ed => add(ed.pts, 'lv')); res.net.mv.forEach(ed => add(ed.pts, 'mv')); }
    if (T.fibre !== 'off' && res.fibre) res.fibre.trunks.forEach(ed => add(ed.pts, 'fi'));
    const dep = type => type === 'MV' ? T.depth.mv : type === 'FI' ? T.depth.fi : type === 'LV/SL' ? T.depth.lv : (T.depth.comb != null ? T.depth.comb : Math.max(T.depth.mv, T.depth.lv));
    // what a set of cables becomes: [{ type, shift }] (shift moves a separate MV trench in from the verge line)
    const kinds = cats => {
      const mv = cats.has('mv'), pw = cats.has('lv') || cats.has('svc'), fi = cats.has('fi');
      const r = [];
      if (mv && pw && T.combine === 'mvlv') r.push({ type: 'MV/LV/SL', shift: 0 });
      else { if (mv) r.push({ type: 'MV', shift: pw ? 0.7 : 0 }); if (pw) r.push({ type: 'LV/SL', shift: 0 }); }
      if (fi && !(T.fibre === 'with' && pw) && T.fibre !== 'off') r.push({ type: 'FI', shift: 0 });
      return r;
    };
    const emit = (type, pts, cats, kind) => { if (pts.length >= 2 && plen(pts) > 0.3) out.push({ type, pts, depth: dep(type), len: plen(pts), cats: [...cats], kind }); };
    // a run on the boundary corridor: kd inside the boundary wherever the boundary goes, plus the line's own offset
    const relVerge = (st, sign, s0, s1, rel) => {
      const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / STEP)), pts = [];
      for (let i = 0; i <= n; i++) { const q = s0 + (s1 - s0) * i / n; pts.push(ptAt(st, q, sign * Math.max(0.5, st.fd(sign, q) - st.kd + rel)).slice(0, 2)); }
      return pts;
    };
    for (const l of lines) {                                   // runs along a verge line: merge what overlaps
      const bp = [...new Set(l.ivs.flatMap(v => [v.s0, v.s1]).map(v => Math.round(v * 20) / 20))].sort((a, b) => a - b);
      const runs = [];
      for (let i = 1; i < bp.length; i++) {
        const a = bp[i - 1], b = bp[i], mid = (a + b) / 2;
        const cats = new Set(l.ivs.filter(v => v.s0 <= mid && v.s1 >= mid).map(v => v.cat)); if (!cats.size) continue;
        const key = [...cats].sort().join('+'), last = runs[runs.length - 1];
        if (last && last.key === key && a - last.b < 0.6) last.b = b; else runs.push({ key, cats, a, b });
      }
      for (const r of runs) for (const k of kinds(r.cats)) emit(k.type, l.st.byBoundary && typeof l.st.fd === 'function' ? relVerge(l.st, l.sign, r.a, r.b, l.off - k.shift) : verge(l.st, r.a, r.b, l.sign * (l.off - k.shift)), r.cats, 'run');
    }
    for (const sp of spurs.values()) for (const k of kinds(sp.cats)) emit(k.type, sp.pts, sp.cats, 'spur');
    if (T.crossings && res.net) res.net.cross.forEach(x => {
      const mv = x.d160 > 0, pw = x.svc > 0 || x.lv > 0 || (x.prov && x.d110 > 0), fi = x.fib > 0 && T.fibre !== 'off';
      const type = mv && (pw || fi) ? 'MV/LV/SL' : mv ? 'MV' : pw ? 'LV/SL' : fi ? 'FI' : null;
      if (!type) return;
      const bnd = x.st.byBoundary && typeof x.st.fd === 'function', hA = bnd ? x.st.fd(1, x.s) : x.st.w / 2, hB = bnd ? x.st.fd(-1, x.s) : x.st.w / 2;
      const a = ptAt(x.st, x.s, hA), b = ptAt(x.st, x.s, -hB);
      out.push({ type, pts: [[a[0], a[1]], [b[0], b[1]]], depth: dep(type), len: hA + hB, cats: [mv && 'mv', pw && 'lv', fi && 'fi'].filter(Boolean), kind: 'crossing' });
    });
    const sum = {};
    out.forEach(t => { const q = sum[t.type] || (sum[t.type] = { len: 0, n: 0, depth: t.depth }); q.len += t.len; q.n++; });
    return { list: out, summary: sum, T };
  }

  // ── the proposed network as Demand rows ──
  // The kiosks (fedFrom = the kiosk up the LV tree, the mini-sub for a string head), their erven with the service length, and the
  // mini-subs, in the shape Demand's own demand and volt-drop engine takes — so the layout never re-implements either.
  // o = { minisubId, lvCable, svcCable (names), phases: [id, id, id] }
  function demandInput(res, o) {
    const net = res.net, subs = net && net.subs;
    if (!subs || !subs.length) return null;
    const up = new Map(net.lvLinks.map(l => [l.to, l]));
    const phases = (o.phases && o.phases.length) ? o.phases : [null];
    const sidOf = S => (o.minisubId || 'LAYOUT_SUB') + (subs.length > 1 ? '_' + S.id : ''), sid = k => sidOf(subs.find(S => S.k === k.subK));
    const kiosks = res.kiosks.map(k => {
      const l = up.get(k);
      // the kiosks next to the mini-sub's own are fed by their own feeder from the mini-sub (its own breaker, a string each), not through that kiosk
      const hub = !!l && l.from === k.subK;
      return { id: k.id, name: k.id, fedFrom: l && !hub ? l.from.id : sid(k), loadClass: '', admdOverride: 0, streetLightKVA: 0,
        feederCable: (o.cableOf && o.cableOf[k.id]) || o.lvCable || '', outgoingProtection: o.outgoing || '', feederLength: l ? l.len : 0,
        erfs: k.members.map((e, i) => ({ id: e.id, erfNumber: String((o.names && o.names[e.id]) || e.id), length: Math.max(e.cable || 0, 0.1), phase: phases[i % phases.length], cableType: o.svcCable || '', ampsOverride: 0 })) };
    });
    return { minisubs: subs.map(S => ({ id: sidOf(S), name: 'Auto layout mini-sub' + (subs.length > 1 ? ' ' + S.id : ''), ...(o.txTypeId ? { txTypeId: o.txTypeId } : {}) })), kiosks };
  }


  // ───────────── an erf no street reaches: where the nearest street should run on to ─────────────
  // An erf faces a street when the midpoint of one of its edges, 1 m out, is within half the street's width + 4 m of its
  // centreline (roadHit). For an erf that does not: the nearest street (centreline to the erf outline), the erf edge that
  // is closest to it, and the straight run from the street's nearest point to `w/2 + slack` m short of that edge's
  // midpoint. `atEnd` ('start' | 'end') = the nearest point is an end of that street, so the street itself can be
  // extended; null = a spur from the middle of it. `near` = already within reach (the edge is blocked or not facing out).
  // `crosses` = how many of `o.erven` (polygons) the run passes through. streets: prepared streets or { id, name, w, pts }.
  function segNear(a, b, c, d) {
    if (segInter(a, b, c, d)) { const t = orient(c, d, a) / (orient(c, d, a) - orient(c, d, b)); const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; return { d: 0, p, q: p.slice() }; }
    const on = (pt, u, v) => { const dx = v[0] - u[0], dy = v[1] - u[1], L2 = dx * dx + dy * dy, t = L2 ? clamp(((pt[0] - u[0]) * dx + (pt[1] - u[1]) * dy) / L2, 0, 1) : 0; return [u[0] + dx * t, u[1] + dy * t]; };
    let best = null;
    for (const [pt, from, to, swap] of [[a, c, d, false], [b, c, d, false], [c, a, b, true], [d, a, b, true]]) {
      const q = on(pt, from, to), dd = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (!best || dd < best.d) best = swap ? { d: dd, p: q, q: pt } : { d: dd, p: pt, q };
    }
    return best;
  }
  function reach(poly, streets, o) {
    o = o || {};
    const slack = o.slack == null ? 2 : o.slack, n = poly.length; let best = null;
    for (const st of streets) {
      if (!st.pts || st.pts.length < 2) continue;
      for (let i = 0; i + 1 < st.pts.length; i++) for (let k = 0; k < n; k++) {
        const r = segNear(st.pts[i], st.pts[i + 1], poly[k], poly[(k + 1) % n]);
        if (!best || r.d < best.d) best = { d: r.d, st, q: r.p, k };
      }
    }
    if (!best) return null;
    const a = poly[best.k], b = poly[(best.k + 1) % n], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w = best.st.w || 12, need = w / 2 + slack;
    { let bd = Infinity;                                                           // the street point nearest that edge's midpoint (the run leaves from there)
      for (let i = 0; i + 1 < best.st.pts.length; i++) { const u = best.st.pts[i], v = best.st.pts[i + 1], dx = v[0] - u[0], dy = v[1] - u[1], L2 = dx * dx + dy * dy, t = L2 ? clamp(((m[0] - u[0]) * dx + (m[1] - u[1]) * dy) / L2, 0, 1) : 0, q = [u[0] + dx * t, u[1] + dy * t], dd = Math.hypot(q[0] - m[0], q[1] - m[1]); if (dd < bd) { bd = dd; best.q = q; } } }
    const dx = best.q[0] - m[0], dy = best.q[1] - m[1], L = Math.hypot(dx, dy) || 1e-9, st = best.st;
    const out = { street: { id: st.id, name: st.name || st.id, w }, d: best.d, q: best.q, m, edge: best.k,
      atEnd: Math.hypot(best.q[0] - st.pts[0][0], best.q[1] - st.pts[0][1]) < 1.5 ? 'start' : Math.hypot(best.q[0] - st.pts[st.pts.length - 1][0], best.q[1] - st.pts[st.pts.length - 1][1]) < 1.5 ? 'end' : null };
    if (L <= need + 0.5) return Object.assign(out, { near: true, t: best.q.slice(), len: 0, crosses: 0 });
    out.t = [m[0] + dx / L * need, m[1] + dy / L * need]; out.len = L - need; out.near = false;
    let crosses = 0;
    for (const e of o.erven || []) {
      if (e.poly === poly) continue;
      const steps = Math.max(2, Math.ceil(out.len)); let hit = false;
      for (let i = 0; i <= steps && !hit; i++) { const t = i / steps; hit = pip(best.q[0] + (out.t[0] - best.q[0]) * t, best.q[1] + (out.t[1] - best.q[1]) * t, e.poly); }
      if (hit) crosses++;
    }
    out.crosses = crosses;
    return out;
  }

  return { reach, solve, trenches, demandInput, TRENCH_DEFAULTS, DEFAULTS, ptAt, project, verge, plen };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanLayout;
