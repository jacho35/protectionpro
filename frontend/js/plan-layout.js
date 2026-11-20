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
    fentry: 'beside', fgap: 1.5, fside: 'mid',                     // fibre point: beside the power marker (fgap m along the front, on its middle / corner side) or 'opp' = mirrored at the other front corner. fgap is PROVISIONAL
    cwDef: 5,                                                      // read by the UI: the carriageway width of a street that has none (one drawn as a centreline)
    kgeo: 'boundary', kd: 2,                                       // cables + kiosks run kd m inside the erf boundary ('street' = the old street-line offset)
    kmode: 'opt', xpen: 300, xkiosk: false, n: 6, maxc: 70, worth: 170, knet: true,   // kiosks (n = the most erven one kiosk serves; knet = one solve over the whole street network)
    strN: 4, strE: 0, strL: 350, strMode: 'fewest',                                     // LV strings: most kiosks on one string off the mini-sub (0 = no limit); 'fewest' = fewest strings, 'even' = strings of similar size
    kside: 'count', subBal: 0,                                                                    // kiosk side of each street; the mini-sub balance (0 = off)
    m: 8, mhmerge: false, maxmh: 120, fibre: 'opp', topo: 'ring',              // fibre
    share: true, xmode: 'bound', xpref: 'near', junct: false, j110: 2, j160: 1, spare: 0,   // crossings
    route: 'blocks', xrule: 'leg', setback: 3, xroute: 20, gapTol: 4, gapFace: 40,       // routing: 'blocks' = along the erf boundaries, roads as topology only (PlanBlocks); 'street' = the street-line corridors
    bendFi: 1, bendLv: 1.5, bendMv: 2,                                                 // smooth bends: radius (m) of fibre, LV / service and MV runs round a corner; 0 = sharp. PROVISIONAL: set to the cable / duct maker's minimum bend radius
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
    return { id: s.id, name: s.name || s.id, pts, cum, len: cum[cum.length - 1], w, cw: Math.max(0, Math.min(w, +s.cw || 0)), co: Math.max(-w / 2, Math.min(w / 2, -(+s.cwOffset || 0))), vk: Math.max(1.5, w / 2 - 2), tr: Math.max(1.5, w / 2 - 1.7), nodeSt: {}, jids: [] };
  }
  function ptAt(st, s, off) {
    s = clamp(s, 0, st.len);
    let lo = 0, hi = st.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st.cum[m] <= s) lo = m; else hi = m; }
    const a = st.pts[lo], b = st.pts[hi], L = (st.cum[hi] - st.cum[lo]) || 1, t = (s - st.cum[lo]) / L;
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    return [a[0] + (b[0] - a[0]) * t + ty * off, a[1] + (b[1] - a[1]) * t - tx * off, tx, ty];     // left of travel is (ty, -tx), y down
  }
  // the carriageway's centre line, `co` m to the left of the street line (the road-reserve tool's offset is + to the right in this frame, so
  // prepStreet stores its negative): every vertex moved along the mean of its two segment normals, mitre-limited
  function offsetPts(pts, d) {
    if (!d) return pts.map(p => p.slice());
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const n = (u, v) => { const L = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1; return [(v[1] - u[1]) / L, -(v[0] - u[0]) / L]; };
      let nx, ny;
      if (i > 0 && i < pts.length - 1) { const n1 = n(pts[i - 1], p), n2 = n(p, pts[i + 1]), mx = n1[0] + n2[0], my = n1[1] + n2[1], ml = Math.hypot(mx, my) || 1, c = Math.max(0.5, (mx / ml) * n1[0] + (my / ml) * n1[1]); nx = mx / ml / c; ny = my / ml / c; }
      else [nx, ny] = n(a, b);
      return [p[0] + nx * d, p[1] + ny * d];
    });
  }
  // how deep a point is inside a street's carriageway (m, negative = outside it), from the carriageway's own centre (`co` off the street line)
  function cwDepth(st, x, y) { const pr = project(st, x, y); return st.cw / 2 - Math.abs(pr.side * pr.d - (st.co || 0)); }
  function project(st, x, y) {
    let best = null;
    for (let i = 1; i < st.pts.length; i++) {
      const a = st.pts[i - 1], b = st.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / L2, 0, 1), px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, s: st.cum[i - 1] + t * Math.sqrt(L2), side: ((x - px) * dy - (y - py) * dx) >= 0 ? 1 : -1, px, py };
    }
    return best;
  }
  // the corridor node a kiosk stand joins (route 'blocks'): the nearest node on the stand's own side of its street, never across a street
  // line, a frontage node first. `strict`: within 8 m or none — none means that side has no erf frontage there (no corridor), and the
  // kiosk is then joined to the nearest corridor across the road by a crossing (`kioskJoin`); otherwise within 40 m, else the nearest node
  function standNode(M, G, c, strict) {
    const any = G.attach([c.x, c.y]), st = c.road; if (!st) return any;
    const side = project(st, c.x, c.y).side, onSide = p => project(st, p[0], p[1]).side === side;
    const ok = p => onSide(p) && !(M.streetSI && M.streetSI.crosses([c.x, c.y], p, true)), R2 = strict ? 64 : 1600;
    if (any != null && ok(G.nodes[any].p) && (!strict || Math.hypot(G.nodes[any].p[0] - c.x, G.nodes[any].p[1] - c.y) <= 8)) return any;
    let best = null;
    for (let i = 0; i < G.nodes.length; i++) {
      const nd = G.nodes[i], p = nd.p, dx = p[0] - c.x, dy = p[1] - c.y; if (dx * dx + dy * dy > R2) continue;
      const d = Math.hypot(dx, dy), fr = nd.R && nd.R.front ? !!nd.R.front[nd.i] : false;
      if (best && (best.fr && !fr || best.fr === fr && best.d <= d)) continue;
      if (!ok(p)) continue;
      best = { i, d, fr };
    }
    return best ? best.i : strict ? null : any;
  }
  // how a kiosk stand joins the power corridor: { nd, d, x } — x = 1 when it stands where its side has no corridor and joins the nearest one
  // across the road (a road crossing from the kiosk). `hard` = the side was set by the user (the street's kiosk side, or a kiosk placed by
  // hand); otherwise the stand goes onto the nearest corridor, whichever side it is on (as before)
  function kioskJoin(M, G, c, hard) {
    if (!hard) { const nd = standNode(M, G, c, false); return nd == null ? null : { nd, d: Math.hypot(G.nodes[nd].p[0] - c.x, G.nodes[nd].p[1] - c.y), x: 0 }; }
    const own = standNode(M, G, c, true); if (own != null) return { nd: own, d: Math.hypot(G.nodes[own].p[0] - c.x, G.nodes[own].p[1] - c.y), x: 0 };
    const nd = G.attach([c.x, c.y]); if (nd == null) return null;
    const p = G.nodes[nd].p; return { nd, d: Math.hypot(p[0] - c.x, p[1] - c.y), x: c.road && project(c.road, p[0], p[1]).side !== project(c.road, c.x, c.y).side ? 1 : 0 };
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
        if (pr.d > 3) continue;
        // an end at a place that is already a junction (a third street ending where two cross or meet) joins that junction: it used to be skipped,
        // so the street never knew it met the others, its corridor was not pulled back and its cables ran on into their carriageway
        const near = raw.find(r => Math.hypot(r.pt[0] - e[0], r.pt[1] - e[1]) < 8);
        if (near) { if (!near.items.some(it => it[0] === E)) near.items.push([E, s0]); if (!near.items.some(it => it[0] === T)) near.items.push([T, pr.s]); }
        else raw.push({ pt: [pr.px, pr.py], items: [[E, s0], [T, pr.s]] });
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
  function solveOnce(input, Pin) {
    const P = Object.assign({}, DEFAULTS, Pin || {});
    const t0 = Date.now();
    const streets = (input.streets || []).filter(s => s.pts && s.pts.length >= 2).map(s => { const st = prepStreet(s); st.cwAuto = !!s.cwAuto; return st; });
    streets.rets = kerbFills(input.kerbReturns);                                       // the kerb returns at the street corners (from the plan)
    const { list: junctions, use } = findJunctions(streets);
    const isJ = id => use[id] && use[id].length >= 2;
    // a street that ENDS on another street: its corridor stops short of the other street's carriageway (kerb + 0.4 m), so no verge point, kiosk stand or graph node of it lies in the road it meets
    // (none at a straight joint: the street runs on into the other one, whose carriageway is this one's)
    const jointEnd = (st, id, others) => { if (others.length !== 1) return false; const o = others[0], s0 = st.nodeSt[id], s1 = o.nodeSt[id];
      if (!((s0 < 0.5 || s0 > st.len - 0.5) && (s1 < 0.5 || s1 > o.len - 0.5))) return false; const ta = ptAt(st, s0, 0), tb = ptAt(o, s1, 0); return Math.abs(ta[2] * tb[2] + ta[3] * tb[3]) > 0.966; };
    streets.forEach(st => { st.pullLo = 0; st.pullHi = 0; for (const id of st.jids) { const others = (use[id] || []).filter(o => o !== st); if (jointEnd(st, id, others)) continue; const pull = Math.max(0, ...others.map(o => (o.cw > 0 ? o.cw / 2 + Math.abs(o.co || 0) + 0.4 : 0))); if (st.nodeSt[id] < 0.5) st.pullLo = Math.max(st.pullLo, pull); if (st.nodeSt[id] > st.len - 0.5) st.pullHi = Math.max(st.pullHi, pull); } });
    const byId = Object.fromEntries(streets.map(s => [s.id, s]));
    const erven = (input.erven || []).filter(e => e.poly && e.poly.length >= 3).map(e => {
      const c = [e.poly.reduce((s, q) => s + q[0], 0) / e.poly.length, e.poly.reduce((s, q) => s + q[1], 0) / e.poly.length];
      return { id: e.id, poly: e.poly.map(p => [p[0], p[1]]), cx: c[0], cy: c[1],
        box: [Math.min(...e.poly.map(q => q[0])), Math.min(...e.poly.map(q => q[1])), Math.max(...e.poly.map(q => q[0])), Math.max(...e.poly.map(q => q[1]))] };
    });
    const BM = P.route !== 'street' ? blocksModel(input, P, erven, streets) : null;       // the corridor model (route 'blocks'): kiosks are chosen by the real route
    const ks = {}, fs = {}, overrides = input.overrides || {}, cuts = new Set(input.cuts || []);
    streets.forEach(st => { ks[st.id] = (input.ks && input.ks[st.id]) || 0; fs[st.id] = (input.fs && input.fs[st.id]) || null; });
    const warns = [];

    // ── 0. the corridor: where a cable runs across the road, measured from the erf boundary ──
    // frontage(st, side) = samples [station, distance from the street line to the boundary] taken from the fronts of the erven on that side.
    // fd = that distance at a station (linear between samples; the drawn half-width where nothing fronts that side). mag = the corridor's
    // distance from the street line: kd inside the boundary, so a street line that is out moves nothing. 'street' mode keeps the old constants.
    const byBoundary = P.kgeo !== 'street', KD = byBoundary ? Math.max(0, +P.kd || 0) : 2;
    function frontage(st, side) {
      const key = 'fr' + side; if (st[key] !== undefined) return st[key]; st[key] = null;                // (null while it is worked out: two empty sides joined end to end)
      const smp = [];
      for (const e of erven) if (e.road === st && e.sd === side && e.fe && !e.manual && e.fe.i >= 0)
        for (const [pt, q] of [[e.fe.a, e.sa], [e.fe.b, e.sb]]) { const pr = project(st, pt[0], pt[1]); smp.push([q, pr.side * side * pr.d]); }     // signed: negative if the street line has strayed past the boundary
      // a side no erf fronts (a short piece of street between two junctions, beside a corner erf that faces the other street): the line is
      // read from the erf boundaries that run alongside it, the nearest at each metre, so the corridor is not put out at the reserve's half-width
      if (!smp.length) {
        const best = new Map(), lim = st.w / 2 + 3;                                       // metre bucket → nearest boundary
        for (const e of erven) for (let i = 0; i < e.poly.length; i++) {
          const a = e.poly[i], b = e.poly[(i + 1) % e.poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
          const n = Math.ceil(L / 0.5);
          for (let k = 0; k <= n; k++) {
            const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], pr = project(st, p[0], p[1]);
            if (pr.side !== side || pr.d > lim || pr.s < 0.01 || pr.s > st.len - 0.01) continue;          // beside the street, not past its ends
            const t = ptAt(st, pr.s, 0); if (Math.abs(((b[0] - a[0]) * t[2] + (b[1] - a[1]) * t[3]) / L) < 0.9) break;   // a side boundary, not one across
            const q = Math.round(pr.s); if (!best.has(q) || pr.d < best.get(q)[1]) best.set(q, [pr.s, pr.d]);
          }
        }
        for (const v of best.values()) smp.push(v);
        // nothing alongside either: at an end where the street runs straight on into another, it carries that street's line on
        if (!smp.length) for (const id of st.jids) {
          const J = junctions.find(q => q.id === id), s0 = st.nodeSt[id]; if (!J || J.items.length !== 2 || !(s0 < 0.5 || s0 > st.len - 0.5)) continue;
          const [W, sW] = J.items.find(it => it[0] !== st) || []; if (!W || !(sW < 0.5 || sW > W.len - 0.5)) continue;
          const tw = ptAt(W, sW, 0), ts = ptAt(st, s0, 0), same = tw[2] * ts[2] + tw[3] * ts[3]; if (Math.abs(same) < 0.966) continue;
          const sideW = same > 0 ? side : -side, sm = frontage(W, sideW); if (!sm) continue;
          smp.push([s0, (sW < 0.5 ? sm[0] : sm[sm.length - 1])[1]]);
        }
      }
      smp.sort((p, q) => p[0] - q[0]);
      return (st[key] = smp.length ? smp : null);
    }
    function fd(st, side, s) {
      const smp = frontage(st, side); if (!smp) return st.w / 2;
      if (s <= smp[0][0]) return smp[0][1];
      for (let i = 1; i < smp.length; i++) if (s <= smp[i][0]) { const a = smp[i - 1], b = smp[i], t = (s - a[0]) / ((b[0] - a[0]) || 1); return a[1] + (b[1] - a[1]) * t; }
      return smp[smp.length - 1][1];
    }
    // sections (plan-sections.js): the cross-section that applies at a station = the last section line drawn over it, else the default one.
    // With none, every offset is the single kd as before. A section sets the offset of each cable class and the kiosk from the boundary.
    const SEC = input.sections && Array.isArray(input.sections.list) && input.sections.list.length ? input.sections : null;
    const secById = id => SEC && SEC.list.find(x => x.id === id);
    const secDef = SEC ? (secById(SEC.def) || SEC.list[0]) : null;
    function secAt(st, q) {
      if (!SEC) return null;
      const ln = (SEC.lines || []).filter(l => l.streetId === st.id);
      for (let i = ln.length - 1; i >= 0; i--) { const l = ln[i]; if (q >= Math.min(l.s0, l.s1) - 0.01 && q <= Math.max(l.s0, l.s1) + 0.01) { const x = secById(l.sec); if (x) return x; } }
      return secDef;
    }
    const itemOff = (sec, kind) => !sec ? null : kind === 't' ? sec.items.fi.off : kind === 'm' ? sec.items.mv.off : kind === 'h' ? sec.items.mh.off : sec.items.lv.off;
    const standOff = (st, q) => { const sc = secAt(st, q); return sc ? sc.items.kiosk.off + sc.items.kiosk.depth / 2 : KD; };
    // a street with a carriageway width keeps every corridor line (and kiosk stand) clear of it: never closer to the street line than the kerb + 0.4 m
    // (`side`: the carriageway may be offset from the street line, so its kerb is nearer on one side than the other)
    const corridorFloor = (st, side) => st.cw > 0 ? Math.max(0.5, st.cw / 2 + side * (st.co || 0) + 0.4) : 0.5;
    // ── kerb returns: the corners of the corridor ──
    // A kerb return rounds a block's corner; the area between the arc and the square kerb corner is road. Every run that turns that corner
    // follows the return instead: the corridor of each street stops where the return starts (its tangent point) and the two are joined by an
    // arc on the return's centre, as far from the kerb as the corridor is. Without returns (no carriageway known) nothing here applies.
    const RT = streets.rets, jPt = id => { const J = junctions.find(q => q.id === id); return J ? J.pt : null; };
    const fillHit = p => RT.some(F => fillDepth(F, p) > -0.35);
    const kerbLat = (st, side) => (st.co || 0) + side * st.cw / 2;                    // the signed offset of a street's kerb on one side
    // a junction of just two streets that run straight on into each other (a bend in one street drawn as two)
    const isJoint = id => { const J = junctions.find(q => q.id === id); if (!J || J.items.length !== 2) return false;
      const [[A, sa], [B, sb]] = J.items; if (!((sa < 0.5 || sa > A.len - 0.5) && (sb < 0.5 || sb > B.len - 0.5))) return false;
      const ta = ptAt(A, sa, 0), tb = ptAt(B, sb, 0); return Math.abs(ta[2] * tb[2] + ta[3] * tb[3]) > 0.966; };
    // the return at junction `id` on street X's side sx, on X's leg leaving the junction towards dX (+1 = increasing station): { F, s, T, other }
    // (a tangent point is on the leg only where it is beside the street, not past its end)
    function legTangent(id, X, sx, dX) {
      if (!RT.length || !(X.cw > 0)) return null; const sJ = X.nodeSt[id], jp = jPt(id); if (sJ == null || !jp) return null;
      // only up to halfway to the next junction along that leg: a return there belongs to that junction
      // (a straight joint of two streets is not a junction: the block corner runs on past it, so a return beyond it is still this one's)
      let lim = 40; for (const o of X.jids) { if (o === id || isJoint(o)) continue; const d = (X.nodeSt[o] - sJ) * dX; if (d > 0.5) lim = Math.min(lim, d / 2); }
      let best = null;
      for (const F of RT) {
        if (Math.hypot(F.P[0] - jp[0], F.P[1] - jp[1]) > 30) continue;
        for (const [T, O] of [[F.t1, F.t2], [F.t2, F.t1]]) {
          const pr = project(X, T[0], T[1]), lat = pr.side * pr.d, ds = (pr.s - sJ) * dX;
          if (Math.abs(lat - kerbLat(X, sx)) > 2.5 || ds < 0.3 || ds > lim || pr.s < 0.05 || pr.s > X.len - 0.05) continue;          // (the plan's kerb lines of a curved street can be a metre or two off this one)
          if (!best || ds < best.ds) best = { F, s: pr.s, T, other: O, ds };
        }
      }
      return best;
    }
    // X's leg from junction id towards dX, carried on through a straight joint at its end into the street beyond (W): where point T lies beside W
    // on that leg, { st: W, side, dir, s, sJ } (sJ = the junction's station on W, as if W ran on to it), else null
    function legThru(id, X, sx, dX, T) {
      const sJ = X.nodeSt[id]; if (sJ == null) return null;
      for (const o of X.jids) {
        if (o === id || !isJoint(o)) continue; const sO = X.nodeSt[o], base = (sO - sJ) * dX; if (!(base > 0.5) || !(sO < 0.5 || sO > X.len - 0.5)) continue;
        const J = junctions.find(q => q.id === o), it = J.items.find(q => q[0] !== X); if (!it) continue; const [W, sW] = it; if (!(W.cw > 0)) continue;
        const tx = ptAt(X, sO, 0), tw = ptAt(W, sW, 0), side = tx[2] * tw[2] + tx[3] * tw[3] > 0 ? sx : -sx, dir = sW < 0.5 ? 1 : -1;
        const pr = project(W, T[0], T[1]), ds = (pr.s - sW) * dir;
        if (Math.abs(pr.side * pr.d - kerbLat(W, side)) > 2.5 || ds < 0.05 || base + ds > 40 || pr.s < 0.05 || pr.s > W.len - 0.05) continue;
        return { st: W, side, dir, s: pr.s, sJ: sW - dir * base };
      }
      return null;
    }
    const legDirs = (X, id) => { const s0 = X.nodeSt[id]; return s0 < 0.5 ? [1] : s0 > X.len - 0.5 ? [-1] : [1, -1]; };
    // the corner block between X (side sx) and Y (side sy) at junction id: its return and the tangent stations on both streets.
    // cn.X / cn.Y are the streets the corner is on: X and Y, or with `thru` the street beyond a straight joint (a short piece of street between
    // a joint and the junction lies wholly in the corner); cn.sx / cn.sy, cn.dX / cn.dY are the sides and leg directions on those.
    function corner(id, X, sx, Y, sy, dX0, dY0, kind, thru) {                         // kind: the cable class whose corridor turns the corner
      if (!RT.length || !(X.cw > 0) || !(Y.cw > 0)) return null; const jp = jPt(id); if (!jp) return null;
      const sJY = Y.nodeSt[id]; if (sJY == null) return null;
      const limY = d => { let m = 40; for (const o of Y.jids) { if (o === id || isJoint(o)) continue; const q = (Y.nodeSt[o] - sJY) * d; if (q > 0.5) m = Math.min(m, q / 2); } return m; };
      const onY = T => {                                                             // the other tangent point on a leg Y really has here (never past its end)
        const pr = project(Y, T[0], T[1]);
        if (Math.abs(pr.side * pr.d - kerbLat(Y, sy)) <= 2.5 && pr.s > 0.05 && pr.s < Y.len - 0.05) {
          const dY = (dY0 ? [dY0] : legDirs(Y, id)).find(d => (pr.s - sJY) * d > 0.3 && (pr.s - sJY) * d <= limY(d)); if (dY) return { st: Y, side: sy, dir: dY, s: pr.s, sJ: sJY };
        }
        if (thru) for (const d of dY0 ? [dY0] : legDirs(Y, id)) { const L = legThru(id, Y, sy, d, T); if (L) return L; }
        return null;
      };
      for (const dX of dX0 ? [dX0] : legDirs(X, id)) {
        const cands = [];
        const lt = legTangent(id, X, sx, dX); if (lt) cands.push([lt.F, lt.other, { st: X, side: sx, dir: dX, s: lt.s, sJ: X.nodeSt[id] }]);
        if (thru && !lt) for (const F of RT) { if (Math.hypot(F.P[0] - jp[0], F.P[1] - jp[1]) > 30) continue;
          for (const [T, O] of [[F.t1, F.t2], [F.t2, F.t1]]) { const L = legThru(id, X, sx, dX, T); if (L) cands.push([F, O, L]); } }
        for (const [F, O, LX] of cands) {
          const LY = onY(O); if (!LY || LY.st === LX.st) continue;
          // the two legs must make a corner: a return near a straight joint of two streets belongs to another junction
          { const qx = ptAt(LX.st, LX.s, 0), qy = ptAt(LY.st, LY.s, 0), c = Math.abs(qx[2] * LX.dir * qy[2] * LY.dir + qx[3] * LX.dir * qy[3] * LY.dir); if (c > 0.966) continue; }
          const cn = { F, X: LX.st, sx: LX.side, dX: LX.dir, sX: LX.s, Y: LY.st, sy: LY.side, dY: LY.dir, sY: LY.s };
          // where the corridors are far from the kerb (a wide verge) they meet before the return starts: the corner curve, and so the corridor's end
          // and the node, is at the fillet's own tangent points, not out at the kerb return's (which would run past the corner and back)
          const g = filletGeom(cn, kpRaw(cn.X, cn.sx, cn.sX, kind), kpRaw(cn.Y, cn.sy, cn.sY, kind));
          if (g) { const s1 = project(cn.X, g.T1[0], g.T1[1]).s, s2 = project(cn.Y, g.T2[0], g.T2[1]).s;
            if ((s1 - LX.sJ) * cn.dX > 0.3 && (s1 - LX.sJ) * cn.dX < (LX.s - LX.sJ) * cn.dX) cn.sX = s1;
            if ((s2 - LY.sJ) * cn.dY > 0.3 && (s2 - LY.sJ) * cn.dY < (LY.s - LY.sJ) * cn.dY) cn.sY = s2; }
          return cn;
        }
      }
      return null;
    }
    // the corridor round a corner: the fillet between the two corridor lines (a on X's, b on Y's, each heading away from the junction), with the
    // return's radius less the nearer corridor's distance from its kerb, so the curve keeps clear of the rounded-off road; where the corridors
    // meet well clear of it (a wide verge) the fillet is small. a and b included; the radius is held to what the two legs leave room for.
    const kpRaw = (st, side, s, kind) => ptAt(st, s, side * mag(st, side, s, kind));          // a corridor point without the pull at a street end
    // the fillet between the corridor line through a (on X, heading away from the junction) and through b (on Y): Q, its tangent points, centre, radius
    function filletGeom(cn, a, b) {
      const ua = (() => { const q = ptAt(cn.X, cn.sX, 0); return [q[2] * cn.dX, q[3] * cn.dX]; })(), ub = (() => { const q = ptAt(cn.Y, cn.sY, 0); return [q[2] * cn.dY, q[3] * cn.dY]; })();
      const den = ua[0] * ub[1] - ua[1] * ub[0]; if (Math.abs(den) < 1e-6) return null;
      const tq = ((b[0] - a[0]) * ub[1] - (b[1] - a[1]) * ub[0]) / den, Q = [a[0] + ua[0] * tq, a[1] + ua[1] * tq];          // where the two corridor lines meet
      const la = Math.hypot(a[0] - Q[0], a[1] - Q[1]), lb = Math.hypot(b[0] - Q[0], b[1] - Q[1]);
      const latOf = (st, p) => { const pr = project(st, p[0], p[1]); return pr.side * pr.d; };
      const dA = Math.abs(latOf(cn.X, a) - kerbLat(cn.X, cn.sx)), dB = Math.abs(latOf(cn.Y, b) - kerbLat(cn.Y, cn.sy));
      const cosT = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])), th = Math.acos(cosT); if (th < 0.05 || th > Math.PI - 0.05) return null;
      // the smallest curve that keeps out of every return's rounded-off corner: from the radius the farther corridor needs (a wide verge: small)
      // up to the one the nearer corridor needs (both near the kerb: about the return's own), in 0.5 m steps; held to what the legs leave room for
      const tmax = Math.min(la, lb), bl = Math.hypot(ua[0] + ub[0], ua[1] + ub[1]) || 1, hi = Math.max(1.5, cn.F.R - Math.min(dA, dB));
      const geom = r0 => { let r = r0; if (r / Math.tan(th / 2) > tmax) r = tmax * Math.tan(th / 2); const t = r / Math.tan(th / 2);
        const T1 = [Q[0] + ua[0] * t, Q[1] + ua[1] * t], T2 = [Q[0] + ub[0] * t, Q[1] + ub[1] * t], C = [Q[0] + (ua[0] + ub[0]) / bl * r / Math.sin(th / 2), Q[1] + (ua[1] + ub[1]) / bl * r / Math.sin(th / 2)]; return { Q, T1, T2, C, r }; };
      const clear = g => { const a1 = Math.atan2(g.T1[1] - g.C[1], g.T1[0] - g.C[0]); let dl = Math.atan2(g.T2[1] - g.C[1], g.T2[0] - g.C[0]) - a1; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI;
        for (let k = 0; k <= 8; k++) { const an = a1 + dl * k / 8, q = [g.C[0] + g.r * Math.cos(an), g.C[1] + g.r * Math.sin(an)]; if (RT.some(F => fillDepth(F, q) > 0)) return false; } return true; };
      for (let r = Math.max(1.5, cn.F.R - Math.max(dA, dB)); r < hi; r += 0.5) { const g = geom(r); if (clear(g)) return g; }
      return geom(hi);
    }
    function cornerPath(cn, a, b) {
      const g = filletGeom(cn, a, b); if (!g) return [a.slice(0, 2), b.slice(0, 2)];
      const { T1, T2, C, r } = g;
      const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]); let dl = Math.atan2(T2[1] - C[1], T2[0] - C[0]) - a1; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(dl) / (Math.PI / 18))), out = [a.slice(0, 2)];
      if (Math.hypot(T1[0] - a[0], T1[1] - a[1]) > 0.05) out.push(T1);
      for (let k = 1; k < n; k++) { const an = a1 + dl * k / n; out.push([C[0] + r * Math.cos(an), C[1] + r * Math.sin(an)]); }
      if (Math.hypot(T2[0] - b[0], T2[1] - b[1]) > 0.05) out.push(T2);
      out.push(b.slice(0, 2)); return out;
    }
    // a link at junction id from X's corridor (side sx) to Y's (side sy), round the kerb return: both corridors face one corner block → the
    // corner curve; they face different blocks → round the corner X faces, then cross Y square at its tangent station (or cross X square first,
    // then round). { pts, sX, sY } (the stations the link leaves X and joins Y at), or null (no return there: as before)
    // a square crossing of a street near its end: at a station where the corridors on both sides have started (each side's corridor is
    // pulled back to its own corner, so one station is not the same place on both sides)
    const sqSt = (st, s, kind) => Math.min(Math.max(s, pullAt(st, 1, kind, false), pullAt(st, -1, kind, false)), st.len - Math.max(pullAt(st, 1, kind, true), pullAt(st, -1, kind, true)));
    // a link round corner cn: { pts, X, sX, Y, sY, sideX, sideY } = the streets, stations and sides it leaves and joins (the corner's own streets)
    const plainLink = (cn, kind) => ({ pts: cornerPath(cn, kp(cn.X, cn.sx, cn.sX, kind), kp(cn.Y, cn.sy, cn.sY, kind)), X: cn.X, sX: cn.sX, sideX: cn.sx, Y: cn.Y, sY: cn.sY, sideY: cn.sy });
    // round the corner onto the far side of its Y, then across that street square
    function acrossY(cn, kind) {
      const q = sqSt(cn.Y, cn.sY, kind);
      return { pts: cornerPath(cn, kp(cn.X, cn.sx, cn.sX, kind), kp(cn.Y, cn.sy, cn.sY, kind)).concat(kv(cn.Y, cn.sy, cn.sY, q, kind).map(p => p.slice(0, 2)), [kp(cn.Y, -cn.sy, q, kind).slice(0, 2)]), X: cn.X, sX: cn.sX, sideX: cn.sx, Y: cn.Y, sY: q, sideY: -cn.sy };
    }
    // across the corner's X square from its far side, then round the corner
    function acrossX(cn, kind) {
      const q = sqSt(cn.X, cn.sX, kind);
      return { pts: [kp(cn.X, -cn.sx, q, kind).slice(0, 2)].concat(kv(cn.X, cn.sx, q, cn.sX, kind).map(p => p.slice(0, 2)), cornerPath(cn, kp(cn.X, cn.sx, cn.sX, kind), kp(cn.Y, cn.sy, cn.sY, kind))), X: cn.X, sX: q, sideX: -cn.sx, Y: cn.Y, sY: cn.sY, sideY: cn.sy };
    }
    function linkPaths(id, X, sx, Y, sy, kind) {                                       // every variant, each leg of a through street: for the LV graph to choose from
      const out = [];
      for (const dX of legDirs(X, id)) for (const dY of legDirs(Y, id)) {
        let cn = corner(id, X, sx, Y, sy, dX, dY, kind, true); if (cn) out.push(plainLink(cn, kind));
        cn = corner(id, X, sx, Y, -sy, dX, dY, kind, true); if (cn) out.push(acrossY(cn, kind));
        cn = corner(id, X, -sx, Y, sy, dX, dY, kind, true); if (cn) out.push(acrossX(cn, kind));
      }
      return out;
    }
    function linkPath(id, X, sx, Y, sy, kind, dX, dY) {
      let cn = corner(id, X, sx, Y, sy, dX, dY, kind); if (cn) return plainLink(cn, kind);
      cn = corner(id, X, sx, Y, -sy, dX, dY, kind); if (cn) return acrossY(cn, kind);
      cn = corner(id, X, -sx, Y, sy, dX, dY, kind); if (cn) return acrossX(cn, kind);
      return null;
    }
    // along X's corridor (side sx) from station s0 to s1 past a street Y that joins on that side: the corridor's straight line would run through
    // Y's mouth and both its kerb returns, so the run turns the first corner onto Y's corridor, crosses Y square and turns the second corner back
    // onto X. null where nothing joins on that side between s0 and s1, or the returns are not known (as before).
    function mouthPath(X, sx, s0, s1, kind) {
      if (!RT.length || !(X.cw > 0)) return null; const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      for (const id of X.jids) {
        const sJ = X.nodeSt[id]; if (!(sJ > lo + 0.3 && sJ < hi - 0.3)) continue;
        const J = junctions.find(q => q.id === id); if (!J) continue;
        for (const [Y] of J.items) {
          if (Y === X || !(Y.cw > 0) || !(Y.nodeSt[id] < 0.5 || Y.nodeSt[id] > Y.len - 0.5)) continue;     // a street that ends here
          const dY = Y.nodeSt[id] < 0.5 ? 1 : -1, far = ptAt(Y, Y.nodeSt[id] + dY * 5, 0), pf = project(X, far[0], far[1]); if (pf.side !== sx) continue;
          let cA = null, cB = null;
          for (const q of [1, -1]) { const a = corner(id, X, sx, Y, q, -1, dY, kind, true), b = corner(id, X, sx, Y, -q, 1, dY, kind, true); if (a && b && a.Y === b.Y) { cA = a; cB = b; break; } }
          if (!cA) continue;
          // a corner beyond a straight joint: only where the run starts (ends) at that joint, or within 3 m of it (then from the joint)
          const pA = kp(X, sx, lo, kind), pB = kp(X, sx, hi, kind), jA = kp(X, sx, 0, kind), jB = kp(X, sx, X.len, kind);
          if (cA.X === X ? cA.sX < lo - 0.05 : lo > 3) continue;
          if (cB.X === X ? cB.sX > hi + 0.05 : hi < X.len - 3) continue;
          const sA = cA.X === X ? lo : project(cA.X, jA[0], jA[1]).s, sB = cB.X === X ? hi : project(cB.X, jB[0], jB[1]).s;
          if (cA.X !== X && Math.hypot(...[0, 1].map(k => kp(cA.X, cA.sx, sA, kind)[k] - jA[k])) > 1) continue;
          if (cB.X !== X && Math.hypot(...[0, 1].map(k => kp(cB.X, cB.sx, sB, kind)[k] - jB[k])) > 1) continue;
          const Ys = cA.Y, sc = sqSt(Ys, cA.dY > 0 ? Math.max(cA.sY, cB.sY) : Math.min(cA.sY, cB.sY), kind);   // the crossing: square, at the tangent station farther from X
          const first = cornerPath(cA, kp(cA.X, cA.sx, cA.sX, kind), kp(Ys, cA.sy, cA.sY, kind)), second = cornerPath(cB, kp(cB.X, cB.sx, cB.sX, kind), kp(Ys, cB.sy, cB.sY, kind)).reverse();
          const pts = [cA.X === X ? pA : jA].concat(kv(cA.X, cA.sx, sA, cA.sX, kind), first, kv(Ys, cA.sy, cA.sY, sc, kind), kv(Ys, cB.sy, sc, cB.sY, kind), second, kv(cB.X, cB.sx, cB.sX, sB, kind), [cB.X === X ? pB : jB]).map(p => p.slice(0, 2));
          const out = [pts[0]]; for (const p of pts) if (Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.02) out.push(p);
          return s0 <= s1 ? out : out.reverse();
        }
      }
      return null;
    }
    // the arc from a to b round a return's centre, a and b included
    function arcPts(F, a, b) {
      const c = F.c, ra = Math.hypot(a[0] - c[0], a[1] - c[1]), rb = Math.hypot(b[0] - c[0], b[1] - c[1]);
      const a1 = Math.atan2(a[1] - c[1], a[0] - c[0]); let dl = Math.atan2(b[1] - c[1], b[0] - c[0]) - a1; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(dl) / (Math.PI / 18))), out = [];
      for (let k = 0; k <= n; k++) { const t = k / n, r = ra + (rb - ra) * t, an = a1 + dl * t; out.push([c[0] + r * Math.cos(an), c[1] + r * Math.sin(an)]); }
      out[0] = a.slice(0, 2); out[n] = b.slice(0, 2); return out;
    }
    // a point (kiosk stand, manhole) that still falls in a carriageway — on the inside of a bend of a drawn street line, or in another street
    // near a junction — goes out square to the nearer kerb + 0.4 m of each street it is in
    const outOfRoad = q => {
      for (let pass = 0; pass < 3; pass++) for (const st of streets) {
        if (!(st.cw > 0) || cwDepth(st, q[0], q[1]) <= -0.35) continue;
        const pr = project(st, q[0], q[1]), co = st.co || 0, lat = pr.side * pr.d, to = co + (lat >= co ? 1 : -1) * (st.cw / 2 + 0.4);
        const nx = pr.d > 1e-6 ? pr.side * (q[0] - pr.px) / pr.d : 0, ny = pr.d > 1e-6 ? pr.side * (q[1] - pr.py) / pr.d : 1; q = [pr.px + nx * to, pr.py + ny * to];
      }
      return q;
    };
    const clearStand = (c, st) => { const q = outOfRoad([c.x, c.y]); if (q[0] !== c.x || q[1] !== c.y) { c.x = q[0]; c.y = q[1]; c.s = project(st || c.road, q[0], q[1]).s; } return c; };
    const capOff = (st, so, v) => { if (!(st.cw > 0)) return so; const pr = project(st, v[0], v[1]); return Math.min(so, Math.max(0, pr.d - corridorFloor(st, pr.side))); };     // a stand `so` m in from boundary point v, never inside the floor
    const mag = (st, side, s, kind) => {
      // an assumed carriageway (a street drawn as a centreline) never pushes the corridor over the erf boundary: the drawn line can run close to one side
      const floor = st.cwAuto && frontage(st, side) ? Math.min(corridorFloor(st, side), Math.max(0.5, fd(st, side, s) - 0.5)) : corridorFloor(st, side);
      if (!byBoundary) return Math.max(floor, kind === 't' ? st.tr : st.vk);          // (the old street-line offset, still clear of a carriageway)
      const io = itemOff(secAt(st, s), kind), off = io != null ? io : (kind === 't' || kind === 'h' ? KD - 0.3 : KD);
      return Math.max(floor, fd(st, side, s) - off);
    };
    // how far in from an end that meets another street the corridor starts, per side and cable class: at least pullLo / pullHi (the other street's
    // kerb + 0.4 m along this street), and further where the street meets the other at a slant, so the corridor on the acute side (which
    // runs along the other street for a while) is not left in its carriageway. Worked out on first use, after the fronts are known.
    const pullAt = (st, side, kind, hi) => {
      const key = (hi ? 'h' : 'l') + side + (kind || ''), memo = st._pm || (st._pm = {}); if (memo[key] != null) return memo[key];
      let base = hi ? st.pullHi : st.pullLo;
      const jid = base > 0 ? st.jids.find(id => hi ? st.nodeSt[id] > st.len - 0.5 : st.nodeSt[id] < 0.5) : null;
      if (jid != null) {                                                                // to where its corner curve starts (the return's tangent, or the fillet's on a wide verge)
        const dEnd = hi ? -1 : 1; let sc = null;
        for (const Y of use[jid] || []) { if (Y === st) continue; for (const sy of [1, -1]) { const cn = corner(jid, st, side, Y, sy, dEnd, null, kind); if (cn) { sc = sc == null ? cn.sX : (dEnd > 0 ? Math.min(sc, cn.sX) : Math.max(sc, cn.sX)); } } }
        if (sc == null) { const lt = legTangent(jid, st, side, dEnd); if (lt) sc = lt.s; }
        if (sc != null) base = Math.max(base, hi ? st.len - sc : sc);
      }
      let s = base;
      const others = jid != null ? (use[jid] || []).filter(o => o !== st && o.cw > 0) : [];
      if (others.length) for (let k = 0; k < 160 && s < st.len / 2; k++, s += 0.25) {
        const q = hi ? st.len - s : s, p = ptAt(st, q, side * mag(st, side, q, kind));
        if (others.every(o => cwDepth(o, p[0], p[1]) <= -0.35)) break;
      }
      return (memo[key] = Math.min(s, st.len / 2));
    };
    const kp = (st, side, s, kind) => ptAt(st, Math.min(Math.max(s, pullAt(st, side, kind, false)), st.len - pullAt(st, side, kind, true)), side * mag(st, side, s, kind));                      // a point on the corridor (x, y, tx, ty)
    function kv(st, side, s0, s1, kind) {                                                             // the corridor between two stations
      const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / STEP)), out = [];
      for (let i = 0; i <= n; i++) out.push(kp(st, side, s0 + (s1 - s0) * i / n, kind).slice(0, 2));
      return out;
    }
    streets.forEach(st => { st.fd = (side, s) => fd(st, side, s); st.kd = KD; st.byBoundary = byBoundary; st.sec = q => secAt(st, q); });

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
      // front 'busy': a corner erf faces the street more erven face (by their own longest street edge), where a kiosk is likelier and shared
      const load = new Map();
      if (P.front === 'busy') for (const e of erven) {
        if (!e.edges) e.edges = edgesOf(e);
        const re = e.edges.filter(d => d.road); if (re.length !== 1) continue;
        load.set(re[0].road, (load.get(re[0].road) || 0) + 1);
      }
      for (const e of erven) {
        if (!e.edges) e.edges = edgesOf(e);
        const re = e.edges.filter(d => d.road);
        e.corner = re.length > 1;
        let pick = re.slice().sort((p, q) => (P.front === 'busy' ? (load.get(q.road) || 0) - (load.get(p.road) || 0) || q.len - p.len : P.front === 'longest' ? q.len - p.len : p.len - q.len) || p.i - q.i)[0] || null;
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
    streets.forEach(st => { st._pm = {}; });                                                    // the corridor pulls (pullAt) follow the fronts found in step 1
    function markerCands(e) {
      const fe = e.fe, aa = e.sa, ab = e.sb;
      if (e.manual) {                                                                                  // the point the user placed, as is; the fibre point beside it, along the street
        let t = [-fe.out[1], fe.out[0]]; if ((e.cx - fe.a[0]) * t[0] + (e.cy - fe.a[1]) * t[1] < 0) t = [-t[0], -t[1]];   // t points to the middle of the erf
        return [{ end: 'a', c: fe.a, o: fe.a, t, pt: fe.a, fpt: fibreBeside(e, fe.a, t) }];
      }
      const lowEnd = aa <= ab ? 'a' : 'b', highEnd = aa <= ab ? 'b' : 'a';
      const ends = P.corner === 'pair' ? (e.pairEnd === 'hi' ? [highEnd] : [lowEnd]) : P.corner === 'start' ? [lowEnd] : P.corner === 'end' ? [highEnd] : ['a', 'b'];
      return ends.map(end => {
        const c = end === 'a' ? fe.a : fe.b, o = end === 'a' ? fe.b : fe.a, t = [(o[0] - c[0]) / fe.len, (o[1] - c[1]) / fe.len];
        return { end, c, o, t,
          pt: [c[0] + t[0] * P.side + fe.inn[0] * P.depth, c[1] + t[1] * P.side + fe.inn[1] * P.depth],
          fpt: null };
      }).map(m => Object.assign(m, { fpt: P.fentry === 'opp' ? [m.o[0] - m.t[0] * P.side + fe.inn[0] * P.depth, m.o[1] - m.t[1] * P.side + fe.inn[1] * P.depth] : fibreBeside(e, m.pt, m.t) }));
    }
    // the fibre point fgap m from the power marker along the front: on its middle side (t, towards the other corner) or its corner side; the
    // other way round when that point is not in the erf, the marker itself when neither is
    function fibreBeside(e, pt, t) {
      const g = Math.max(0, +P.fgap || 0), s = P.fside === 'corner' ? -1 : 1;
      for (const k of [s, -s]) { const q = [pt[0] + t[0] * g * k, pt[1] + t[1] * g * k]; if (pip(q[0], q[1], e.poly)) return q; }
      return pt.slice();
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
      const A = e.road, B = k.road, nB = B.nodeSt[id], nA = A.nodeSt[id], sM = project(A, mc.pt[0], mc.pt[1]).s;
      // round the kerb return when the two verges meet at a block corner that has one
      const lp = linkPath(id, B, ks[B.id], A, ks[A.id], undefined, Math.sign(k.s - nB) || 1, Math.sign(sM - nA) || 1);
      let pre, pts;
      if (lp) { pre = [[k.x, k.y], ...kv(B, ks[B.id], k.s, lp.sX), ...lp.pts.slice(1)]; pts = [...pre, ...kv(A, ks[A.id], lp.sY, sM).slice(1)]; }
      else { pre = [[k.x, k.y], ...kv(B, ks[B.id], k.s, nB), kp(A, ks[A.id], nA).slice(0, 2)]; pts = [...pre, ...kv(A, ks[A.id], nA, sM).slice(1)]; }
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
    const routeM = (e, k) => { const key = 'd|' + e.id + '|' + Math.round(k.s * 3) + (k.pin ? '|p' + Math.round(k.x * 10) + ',' + Math.round(k.y * 10) : ''); let v = LC.get(key); if (v == null) { v = Math.min(...e.mcs.map(mc => plen(routeFor(e, k, mc)))); LC.set(key, v); } return v; };
    const viaLen = (e, k, mc, x) => { const key = 'v|' + e.id + '|' + Math.round(k.s * 3) + '|' + Math.round(x.s * 3) + '|' + mc.end + (k.pin ? '|p' + Math.round(k.x * 10) + ',' + Math.round(k.y * 10) : ''); let v = LC.get(key); if (v == null) { v = plen(routeVia(e, k, mc, x)); LC.set(key, v); } return v; };

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
      // xpref 'near': each service crosses at the boundary nearest its own marker, so the cable stays on the kiosk's side as long as it can and
      // the far verge only carries the last stretch; services whose nearest boundary is the same share that crossing. 'few': fewest crossings.
      const evalNear = xs => {
        const picks = new Map(), used = new Set(); let total = 0, nf = 0;
        opp.forEach(e => {
          const cs = xs.map((x, j) => {
            let l = 1e9, mc = null; for (const m of e.mcs) { const q = viaLen(e, chosen[e._k].cand, m, x); if (q < l) { l = q; mc = m; } }
            return { j, l, mc, far: Math.abs(x.s - project(e.road, mc.pt[0], mc.pt[1]).s) };
          });
          const ok = cs.filter(c => c.l <= P.maxc), lmin = Math.min(...ok.map(c => c.l));          // no detour past the marker: only crossings that keep the cable at its shortest (+2 m)
          let pick;
          if (ok.length) pick = ok.filter(c => c.l <= lmin + 2).sort((p, q) => p.far - q.far || p.l - q.l)[0];
          else { nf++; pick = cs.slice().sort((p, q) => p.l - q.l)[0]; }
          picks.set(e, { x: xs[pick.j], mc: pick.mc, l: pick.l }); used.add(pick.j); total += pick.l;
        });
        return { nx: used.size, total, picks, xs, nf };
      };
      const evalPick = P.xpref === 'few' ? evalXs : evalNear;
      let xs = bd.length ? bd : chosen.map(c => ({ s: c.cand.s })), res = evalPick(xs);
      if (res.nf && bd.length) {                                      // some erf has no boundary in reach: allow its own side boundaries and the kiosk stations
        const soft = bd.slice();
        const add = a => { if (!soft.some(o => Math.abs(o.s - a) <= 1.5)) soft.push({ s: a, soft: true }); };
        opp.forEach(e => { add(e.lo); add(e.hi); }); chosen.forEach(c => add(c.cand.s));
        soft.sort((p, q) => p.s - q.s);
        const r2 = evalPick(soft); if (r2.nf < res.nf || (r2.nf === res.nf && r2.nx < res.nx)) res = r2;
      }
      return { nx: res.nx, total: total + res.total, picks: res.picks, xs: res.xs };
    }

    // min-cost assignment of n erven to k stands, each stand taking at most N: `arc(j, i)` = the cost of erf i on stand j (null = out of reach).
    // Returns { flow, total (cost / 10), asg } — asg[i] = the stand index, or -1. Both kiosk solvers use it.
    function flowAssign(n, k, N, arc) {
      const V = n + k + 2, S0 = n + k, T = n + k + 1;
      const to = [], cap = [], cost = [], nxt = [], head = new Array(V).fill(-1);
      const add = (u, v, c, w) => { to.push(v); cap.push(c); cost.push(w); nxt.push(head[u]); head[u] = to.length - 1; to.push(u); cap.push(0); cost.push(-w); nxt.push(head[v]); head[v] = to.length - 1; };
      for (let i = 0; i < n; i++) add(S0, i, 1, 0);
      for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) { const w = arc(j, i); if (w != null) add(i, n + j, 1, Math.round(w * 10)); }
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
    // small min-cost flow: erven → kiosks within the cable limit, each kiosk takes at most N
    function assignOpt(sel, Lm, n, N, maxL) {
      const r = flowAssign(n, sel.length, N, (j, i) => { const L = Lm[sel[j]][i]; return L <= maxL ? L : null; });
      return { flow: r.flow, total: r.total, asg: r.asg };
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
            const so = capOff(st, standOff(st, a), v), x = v[0] + fe.out[0] * so, y = v[1] + fe.out[1] * so;
            cands.push(clearStand({ a, x, y, s: project(st, x, y).s, shared: false }, st));
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
    const XPEN = Math.max(0, +P.xpen >= 0 ? +P.xpen : 300);                            // m of cable one road crossing counts for in the assignment
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
            const so = capOff(st, standOff(st, a), v), x = v[0] + fe.out[0] * so, y = v[1] + fe.out[1] * so;
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
            const lt = legTangent(id, st, side, dir), s0 = st.nodeSt[id] + dir * Math.max(Y.w / 2 + 2.5, lt ? lt.ds + 1 : 0); if (s0 < 0 || s0 > st.len || mine.some(c => Math.abs(c.s - s0) <= 1.5)) continue;
            const pos = kp(st, side, s0); mine.push({ road: st, a: s0, x: pos[0], y: pos[1], s: s0, shared: false, junction: true });
          }
        }
        cands.push(...mine.map(c => clearStand(c)));
      }
      // kiosks moved or put by hand: a stand dropped where the solver would have put one (`kioskDrops`) and a stand that is always used (`kioskPins`)
      const pinIdx = new Set();
      for (const q of (input.kioskDrops || [])) if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) for (let i = cands.length - 1; i >= 0; i--) if (Math.hypot(cands[i].x - q[0], cands[i].y - q[1]) <= 1.5) cands.splice(i, 1);
      for (const q of (input.kioskPins || [])) {
        if (!Array.isArray(q) || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
        let bp = null; for (const st of streets) { const h = project(st, q[0], q[1]); if (!bp || h.d < bp.h.d) bp = { st, h }; }
        if (!bp) continue;
        cands.push({ road: bp.st, a: bp.h.s, x: q[0], y: q[1], s: bp.h.s, shared: false, hand: true, pin: true }); pinIdx.add(cands.length - 1);
      }
      const forced = -1;                                                       // kiosks are placed from the erven alone: a mini-sub never forces one
      const C = cands.length;
      if (!C) { warns.push('No place for a kiosk on any street.'); return kiosks; }
      // service length / road crossings from every stand to every erf (Infinity = out of reach)
      const Lm = cands.map(() => new Float64Array(n).fill(Infinity)), Xm = cands.map(() => new Uint8Array(n));
      const xcount = (pts, excl) => pathCrossings(pts, excl).length;
      if (BM) {                                                                        // along the erf boundaries: one search from each erf marker
        // a stand joins the corridor on its own side of the street; where that side has no erf frontage it joins the one across the road,
        // and every service from it pays that crossing
        // (a kiosk placed by hand, or on a street whose own kiosk side was set — `input.ksOwn`, not the All streets side — is used as asked:
        // its join crossing is not charged here, only counted with the crossings; else the optimiser would serve those erven from another street)
        const G = BM.cls.p, cn = cands.map(c => { const q = kioskJoin(BM, G, c, !!(c.pin || (c.road && input.ks && input.ks[c.road.id]))); if (q && (c.pin || (c.road && input.ksOwn && input.ksOwn[c.road.id]))) q.x = 0; return q; });
        for (let i = 0; i < n; i++) {
          const e = list[i], B = BM.blockOf.get(e.id);
          for (const m of e.mcs) {
            const nd = G.attachInto(m.pt, B, e.id); if (nd == null) continue;
            const stub = Math.hypot(G.nodes[nd].p[0] - m.pt[0], G.nodes[nd].p[1] - m.pt[1]), R = G.reach(nd, maxc + 9 * (+P.xroute || 0));
            for (let ci = 0; ci < C; ci++) { const q = cn[ci]; if (!q) continue; const v = R.get(q.nd); if (!v) continue; const L = v[1] + stub + q.d, X = v[2] + q.x;
              if (L <= maxc && L + XPEN * X < Lm[ci][i] + XPEN * Xm[ci][i]) { Lm[ci][i] = L; Xm[ci][i] = Math.min(X, 9); } }
          }
        }
      }
      for (let ci = 0; ci < C && !BM; ci++) {
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
      // a kiosk you placed (`kioskPins`) is served first: every other stand's link costs one crossing + the service limit more, so a placed kiosk
      // takes the erven within reach (up to N) and is never left with none because one of the layout's own stands is a little nearer.
      // No kiosk placed by hand: no offset, exactly as before.
      const pinB = pinIdx.size ? XPEN + maxc : 0;
      function assignG(sel) {
        const r = flowAssign(n, sel.length, N, (j, i) => Lm[sel[j]][i] <= maxc ? wt(sel[j], i) + (pinB && !pinIdx.has(sel[j]) ? pinB : 0) : null);
        let cable = 0, xings = 0;
        r.asg.forEach((j, i) => { if (j >= 0) { cable += Lm[sel[j]][i]; xings += Xm[sel[j]][i]; } });
        return { flow: r.flow, cost: r.total, cable, xings, eff: cable + XPEN * xings, asg: r.asg };
      }
      // 1. construction: the stand that takes the most still-unserved erven (at most N, the nearest), until every reachable erf is served
      let sel = [];
      const left = new Set(list.map((e, i) => i).filter(i => servable[i]));
      const take = (ci) => {
        const inc = cover[ci].filter(i => left.has(i)).sort((a, b) => wt(ci, a) - wt(ci, b)).slice(0, N);
        inc.forEach(i => left.delete(i)); return inc;
      };
      if (forced >= 0 && cover[forced].length) { sel.push(forced); take(forced); }
      for (const ci of pinIdx) { sel.push(ci); take(ci); }                          // a kiosk you placed always stands
      const isPin = j => sel[j] === forced || pinIdx.has(sel[j]);
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
            if (isPin(j)) continue;
            const t = sel.filter((c, q) => q !== j), r = assignG(t); budget--;
            if (r.flow >= cur.flow && r.flow === nServ && (P.xkiosk ? r.eff - cur.eff : r.cable - cur.cable) <= P.worth) { sel = t; cur = r; again = true; changed = true; break; }
            if (budget <= 0) break;
          }
        }
        for (let j = 0; j < sel.length && budget > 0; j++) {
          if (isPin(j)) continue;
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
          const gain = P.xkiosk ? cur.eff - r.eff : cur.cable - r.cable; if (r.flow >= cur.flow && gain > P.worth && (!bestA || gain > bestA.gain)) bestA = { ci, r, gain };
        }
        if (!bestA) break; sel.push(bestA.ci); cur = bestA.r;
      }
      if (budget <= 0) warns.push('The kiosk search ran out of its step budget on this site, so the kiosk layout may not be the best found. Re-run, or raise Houses per kiosk / Worth if it matters.');
      // the kiosks: each erf to its stand (an erf nothing reaches goes to the nearest one and is reported as over the limit)
      const chosen = sel.map(ci => ({ cand: cands[ci], members: [] }));
      list.forEach((e, i) => {
        let j = cur.asg[i];
        if (j < 0) { let m = Infinity; chosen.forEach((c, q) => { const d = Math.hypot(c.cand.x - e.mcs[0].pt[0], c.cand.y - e.mcs[0].pt[1]); if (d < m) { m = d; j = q; } }); }
        chosen[j].members.push(e);
      });
      const ord = new Map(streets.map((s, i) => [s, i]));
      chosen.filter(c => c.cand.pin && !c.members.length).forEach(() => warns.push('A kiosk you moved serves no erf there (none is within the service limit), so it was left out.'));
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
        const k = { id: 'K' + (kiosks.length + 1), x: cand.x, y: cand.y, road: cand.road, s: cand.s, members: ms, pin: !!cand.pin, flag: cand.hand ? 'placed by hand' : cand.junction ? 'at a junction' : cand.shared ? '' : 'on a corner' };
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
        e.marker = mc.pt; e.corner_pt = mc.c; e.fibrePt = mc.fpt; e.fibreHand = false;
        const fh = input.fibreOffs && input.fibreOffs[e.id];                   // a fibre point the user moved: that offset from the power marker, so it follows the marker
        if (fh && Number.isFinite(+fh[0]) && Number.isFinite(+fh[1])) { e.fibrePt = [e.marker[0] + +fh[0], e.marker[1] + +fh[1]]; e.fibreHand = true; }
        if (route) { e.route = route; e.cable = plen(route); e.hopN = route.hopN || 0; }
      }
    }

    // ── 3. fibre ──
    const fibreSign = st => fs[st.id] != null ? fs[st.id] : (P.fibre === 'opp' ? -ks[st.id] : ks[st.id]);
    function placeFibre() {
      const mhs = [], fwarn = []; let n = 0;
      const maxA = P.maxmh;
      // manholes moved or put by hand: a manhole the solver would put at a drop point (same street, within 3 m along it) is left out (`mhDrops`), and each pin is a
      // manhole at that exact point (`mhPins`) — on the nearest street, at its station, on whichever side of the street it stands
      const okPt = q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]);
      const nearestSt = q => { let b = null; for (const st of streets) { const h = project(st, q[0], q[1]); if (!b || h.d < b.h.d) b = { st, h }; } return b; };
      const mhDrops = (input.mhDrops || []).filter(okPt).map(nearestSt).filter(Boolean), pinBy = new Map();
      for (const q of (input.mhPins || []).filter(okPt)) {
        const b = nearestSt(q); if (!b) continue;
        const stops = b.st.stops || [0, b.st.len]; let seg = 0; while (seg < stops.length - 2 && b.h.s > stops[seg + 1]) seg++;
        const k = b.st.id + '|' + seg; if (!pinBy.has(k)) pinBy.set(k, []); pinBy.get(k).push({ x: q[0], y: q[1], st: b.st, s: b.h.s, side: b.h.side });
      }
      const pinMh = pn => { const m = { id: 'M' + (++n), x: pn.x, y: pn.y, a: pn.s, road: pn.st, members: [], junction: false, label: String(n), sg: pn.side, hand: true }; mhs.push(m); return m; };
      for (const [gkey, list] of groups) {
        const st = list[0].road, sg = fibreSign(st), seg = list[0].seg;
        list.sort((a, b) => a.al - b.al || a.id - b.id);
        const cnt = list.length, nM = Math.ceil(cnt / P.m), base = Math.floor(cnt / nM), extra = cnt % nM;
        const K = list.filter(e => e.sd === sg);
        const bounds = [];
        for (let i = 0; i < K.length - 1; i++) if (Math.abs(K[i].hi - K[i + 1].lo) <= 1.5) bounds.push({ a: K[i].hi, used: false });
        (XS[gkey] || []).forEach(x0 => { const b = bounds.find(q => Math.abs(q.a - x0) <= 1.5); if (b) b.cross = true; else bounds.push({ a: x0, used: false, cross: true }); });
        const pickB = tg => bounds.filter(b => !b.used).sort((p, q) => (Math.abs(p.a - tg) - (p.cross ? 8 : 0)) - (Math.abs(q.a - tg) - (q.cross ? 8 : 0)))[0];
        const mk = a => { const pos = outOfRoad(kp(st, sg, a, 'h')), m = { id: 'M' + (++n), x: pos[0], y: pos[1], a, road: st, members: [], junction: false, label: String(n), sg }; mhs.push(m); return m; };
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
        // a drop is matched by street and station (within 3 m): the manhole was shown on the corridor, which can be across the road from here
        for (let i = here.length - 1; i >= 0; i--) if (mhDrops.some(q => q.st === here[i].road && Math.abs(q.h.s - here[i].a) <= 3)) { mhs.splice(mhs.indexOf(here[i]), 1); here.splice(i, 1); }
        (pinBy.get(gkey) || []).forEach(pn => here.push(pinMh(pn))); pinBy.delete(gkey);
        here.forEach(m => { m.members = []; });
        if (!here.length) continue;                                                     // every manhole of this stretch taken out by hand: its erven go to the nearest one (below)
        // each erf to its nearest manhole that still has room (at most m erven): the spacing manholes added above can otherwise draw more than m to one
        list.forEach(e => { const by = here.slice().sort((p, q) => Math.abs(p.a - e.al) - Math.abs(q.a - e.al)), best = by.find(m => m.members.length < P.m) || by[0]; best.members.push(e); e.mh = best; });
      }
      for (const list of pinBy.values()) list.forEach(pinMh);                           // a manhole put by hand where no erf faces the street: a trunk node with no erven of its own
      const orphan = [...groups.values()].flat().filter(e => !e.mh || !mhs.includes(e.mh));
      if (orphan.length && mhs.length) orphan.forEach(e => { const best = mhs.slice().sort((p, q) => Math.hypot(p.x - e.cx, p.y - e.cy) - Math.hypot(q.x - e.cx, q.y - e.cy))[0]; best.members.push(e); e.mh = best; });
      // mhmerge: a stretch between junctions is solved alone, so a short one gets a manhole of its own. A manhole carrying at most half the
      // usual erven folds into another on the same street when the two together stay within `m` erven and the farthest erf is within `maxmh`.
      if (P.mhmerge) {
        const small = mhs.filter(x => !x.hand && x.members.length <= Math.floor(P.m / 2)).sort((p, q) => p.members.length - q.members.length);
        for (const A of small) {
          if (!mhs.includes(A)) continue;
          let best = null;
          for (const B of mhs) {
            if (B === A || B.road !== A.road || B.sg !== A.sg || A.members.length + B.members.length > P.m) continue;
            const far = Math.max(...A.members.map(e => Math.abs(e.al - B.a)), ...B.members.map(e => Math.abs(e.al - B.a)));
            if (far <= P.maxmh && (!best || Math.abs(A.a - B.a) < Math.abs(A.a - best.a))) best = B;
          }
          if (!best) continue;
          A.members.forEach(e => { e.mh = best; best.members.push(e); });
          mhs.splice(mhs.indexOf(A), 1);
        }
        mhs.forEach((x, i) => { x.id = 'M' + (i + 1); x.label = String(i + 1); });
      }
      // a junction of exactly two streets is the point where their two fibre verge lines meet, so each run reaches it along its own line and
      // turns once. (The mean of the two verge points sat off both lines: each run then jogged back onto its line, a hook at the corner.)
      const vergeCorner = (j, mean) => {
        const [A, B] = use[j.id], line = st => { const sg = fibreSign(st), s = st.nodeSt[j.id], p = kp(st, sg, s, 't'), p1 = kp(st, sg, Math.max(0, s - 2), 't'), p2 = kp(st, sg, Math.min(st.len, s + 2), 't'), L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]); return L > 1e-6 ? { p, d: [(p2[0] - p1[0]) / L, (p2[1] - p1[1]) / L], st, s } : null; };
        const a = line(A), b = line(B); if (!a || !b) return null;
        const det = a.d[0] * b.d[1] - a.d[1] * b.d[0]; if (Math.abs(det) < 0.26) return null;                      // streets within ~15 degrees of parallel: no corner
        const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / det, X = [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
        // the corner must lie in the junction mouth: within half the OTHER street's width (+ a little) along each street, else the two verge lines meet far out on the
        // wrong side (a spike through the erven) and the node falls back to a verge point of the wider street
        const near = (st, o) => Math.abs(project(st, X[0], X[1]).s - st.nodeSt[j.id]) <= o.w / 2 + 1.5;
        return near(A, B) && near(B, A) ? X : null;
      };
      const widerVerge = j => { const st = use[j.id].slice().sort((p, q) => q.w - p.w)[0]; return kp(st, fibreSign(st), st.nodeSt[j.id], 't').slice(0, 2); };
      const inter = junctions.map(j => {
        const ps = use[j.id].map(st => kp(st, fibreSign(st), st.nodeSt[j.id], 't'));
        const mean = [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
        let ci = null;                                                                   // two streets whose fibre verges face one corner with a return: the node is the middle of its arc
        if (use[j.id].length === 2) { const [A, B] = use[j.id], cn = corner(j.id, A, fibreSign(A), B, fibreSign(B), null, null, 't'); if (cn) { const path = cornerPath(cn, kp(A, fibreSign(A), cn.sX, 't'), kp(B, fibreSign(B), cn.sY, 't')), m = path.length >> 1; ci = { F: cn.F, at: { [A.id]: cn.sX, [B.id]: cn.sY }, mid: path[m], legs: { [A.id]: path.slice(0, m + 1).reverse(), [B.id]: path.slice(m) } }; } }
        const X = ci ? ci.mid : use[j.id].length === 2 ? (vergeCorner(j, mean) || widerVerge(j)) : null;
        let q = X ? X.slice() : mean.slice();
        for (let pass = 0; pass < 3; pass++) for (const st of use[j.id]) {                  // a junction manhole / node never stands in a carriageway: pushed out to the kerb + 0.4 m
          if (!(st.cw > 0) || cwDepth(st, q[0], q[1]) <= -0.35) continue;
          // out to the nearer kerb of the carriageway (which may be offset from the street line) + 0.4 m, square to the street
          const pr = project(st, q[0], q[1]), co = st.co || 0, lat = pr.side * pr.d, to = co + (lat >= co ? 1 : -1) * (st.cw / 2 + 0.4);
          const nx = pr.d > 1e-6 ? pr.side * (q[0] - pr.px) / pr.d : 0, ny = pr.d > 1e-6 ? pr.side * (q[1] - pr.py) / pr.d : 1; q = [pr.px + nx * to, pr.py + ny * to];
        }
        if (!ci && fillHit(q)) {                                                        // three or more streets: a node in a return's rounded-off corner moves onto that corner's verge
          const F = RT.find(G => fillDepth(G, q) > -0.35), d0 = F && Math.hypot(q[0] - F.c[0], q[1] - F.c[1]);
          if (F && d0 > 1e-6) { const p = [F.c[0] + (q[0] - F.c[0]) / d0 * (F.R - 0.4), F.c[1] + (q[1] - F.c[1]) / d0 * (F.R - 0.4)]; if (streets.every(o => !(o.cw > 0) || cwDepth(o, p[0], p[1]) <= -0.35)) q = p; }
        }
        return { id: j.id, x: q[0], y: q[1], junction: true, label: '', streets: use[j.id], ci };
      });
      const nodes = [...inter, ...mhs], edges = [];
      const stat = (nd, st) => nd.junction ? st.nodeSt[nd.id] : nd.a;
      streets.forEach(st => {
        const on = nodes.filter(nd => nd.junction ? nd.streets.includes(st) : nd.road === st).sort((p, q) => stat(p, st) - stat(q, st));
        for (let i = 1; i < on.length; i++) {
          const A = on[i - 1], B = on[i], sa = stat(A, st), sb = stat(B, st), sg = fibreSign(st);
          // the verge points between start 2.5 m past where the nodes actually stand: a junction node pushed out of a carriageway (or set on the
          // corner of two verge lines) can be a few metres along from the junction's station, and points behind it made the trunk double back
          // a corner node's tangent on this street applies only to the edge on that leg (a through street has two)
          let cA = A.junction && A.ci && A.ci.at[st.id] != null && A.ci.at[st.id] > sa - 0.1 ? A.ci.at[st.id] : null, cB = B.junction && B.ci && B.ci.at[st.id] != null && B.ci.at[st.id] < sb + 0.1 ? B.ci.at[st.id] : null;
          // a corner node on the far side of a street that joins this one on its fibre side (the node stands on the corner beyond that street's
          // mouth): the trunk goes round the near corner, across that street square and round the far corner to the node (mouthPath)
          let mid = null;
          if (cB == null && B.junction && B.ci && B.ci.at[st.id] != null && B.ci.at[st.id] >= sb + 0.1) {
            const m = mouthPath(st, sg, cA != null ? cA : sa + 2.5, B.ci.at[st.id], 't'); if (m) { mid = m; cB = B.ci.at[st.id]; } }
          if (!mid && cA == null && A.junction && A.ci && A.ci.at[st.id] != null && A.ci.at[st.id] <= sa - 0.1) {
            const m = mouthPath(st, sg, A.ci.at[st.id], cB != null ? cB : sb - 2.5, 't'); if (m) { mid = m; cA = A.ci.at[st.id]; } }
          const qa = cA != null ? cA : A.junction ? Math.max(sa, project(st, A.x, A.y).s) : sa, qb = cB != null ? cB : B.junction ? Math.min(sb, project(st, B.x, B.y).s) : sb;
          let pts = [[A.x, A.y]];
          if (cA != null) pts = A.ci.legs[st.id].map(q => q.slice());                           // from the node on the corner curve round to the tangent point
          if (mid) pts.push(...mid.slice(cA != null ? 1 : 0));
          else if (qb - qa > 5) pts.push(...kv(st, sg, qa + (cA != null ? 0 : 2.5), qb - (cB != null ? 0 : 2.5), 't').slice(cA != null ? 1 : 0));
          if (cB != null) pts.push(...B.ci.legs[st.id].slice().reverse().map(q => q.slice()).slice(mid || qb - qa > 5 ? 1 : 0)); else pts.push([B.x, B.y]);
          // a junction node on the far side of this street (its fibre verge is the other one): the trunk crosses the street square, clear of the
          // junction (where its verge starts), instead of running diagonally through the corner to the node
          const across = (N, sq, atStart) => {
            if (!N.junction || !(st.cw > 0) || (atStart ? cA != null : cB != null)) return;
            const pn = project(st, N.x, N.y), sn = pn.side >= 0 ? 1 : -1; if (sn === sg || pn.d < st.cw / 2) return;
            const c0 = kp(st, sn, sq, 't').slice(0, 2), c1 = kp(st, sg, sq, 't').slice(0, 2);
            if (atStart) pts.splice(0, 1, [N.x, N.y], c0, c1); else pts.splice(pts.length - 1, 1, c1, c0, [N.x, N.y]);
          };
          if (pts.length >= 3) { across(A, qa + (cA != null ? 0 : 2.5), true); across(B, qb - (cB != null ? 0 : 2.5), false); }
          // a piece from a junction node that would cross ANOTHER street on the way to this street's verge (a crossroads: the node stands in one
          // corner) crosses that street square: along its verge on the node's side to the station of the verge point, across, then on
          const viaX = (N, atStart) => {
            if (!N.junction || pts.length < 2) return;
            const K = atStart ? pts[1] : pts[pts.length - 2], P0 = [N.x, N.y];
            let X = null; for (const o of streets) { if (o === st || !(o.cw > 0)) continue; for (let i = 1; i < o.pts.length && !X; i++) if (segInter(P0, K, o.pts[i - 1], o.pts[i])) X = o; if (X) break; }
            if (!X) return;
            const pn = project(X, P0[0], P0[1]), pk = project(X, K[0], K[1]), sN = pn.side >= 0 ? 1 : -1, sK = pk.side >= 0 ? 1 : -1; if (sN === sK) return;
            const ca = kp(X, sN, pk.s, 't').slice(0, 2), cb = kp(X, sK, pk.s, 't').slice(0, 2);
            if (atStart) pts.splice(1, 0, ca, cb); else pts.splice(pts.length - 1, 0, cb, ca);
          };
          viaX(A, true); viaX(B, false);
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
        // Nodes of the kiosk-side verge graph. One node per place on a street: a new one is made only if no node of that street is within
        // MERGE m, so nodes on a street are always more than MERGE m apart and every consecutive pair is joined below. (They used to be
        // keyed by a 1.5 m bucket while consecutive nodes were joined only if > 0.4 m apart: two nodes 0.3 m apart across a bucket edge
        // were never joined, and a mini-sub or kiosk beside a junction cut the street in two.) Street ends and junctions are made first, so
        // anything placed beside one joins that node and the junction keeps its own station.
        const MERGE = 0.4, nodes = [], byStreet = new Map();
        const node = (st, s0) => {
          let arr = byStreet.get(st); if (!arr) byStreet.set(st, arr = []);
          let n = null; for (const q of arr) if (Math.abs(q.s - s0) <= MERGE && (!n || Math.abs(q.s - s0) < Math.abs(n.s - s0))) n = q;
          if (!n) { n = { id: nodes.length, st, s: s0, adj: [] }; arr.push(n); nodes.push(n); }
          return n;
        };
        // a node at a junction's station on a street that runs through it is only made where that verge point is clear of every other carriageway: on
        // a through street at a T it is in the side street's mouth, where it only split the verge cable (a crossing of the side street) into two
        // runs that end in the road, so a moved crossing dragged that end with it. The junction links start at a clear point anyway (clearSt).
        const clearPt = (st, s0) => { const p = kp(st, ks[st.id] || 1, s0); return !fillHit(p) && streets.every(o => o === st || !(o.cw > 0) || cwDepth(o, p[0], p[1]) <= -0.35); };
        streets.forEach(st => { node(st, 0); node(st, st.len); st.jids.forEach(id => { const s0 = st.nodeSt[id]; if (s0 < 0.5 || s0 > st.len - 0.5 || clearPt(st, s0)) node(st, s0); }); });
        kiosks.forEach(k => { k.node = node(k.road, k.s); });
        // mini-subs placed by hand: a free point anywhere. It joins the verge network at the nearest street (its node is made here so
        // the graph links it), and its own cables run from the point to that verge and along it.
        const manualRoots = [];
        (input.subPts || []).forEach((pt, i) => {
          let bs = null; for (const st of streets) { const pr = project(st, pt[0], pt[1]); if (!bs || pr.d < bs.d) bs = { st, s: pr.s, d: pr.d }; }
          if (!bs) return;
          const nd = node(bs.st, bs.s), V = kp(bs.st, ks[bs.st.id] || 1, nd.s).slice(0, 2);
          manualRoots.push({ id: 'SUBPT' + (i + 1), x: pt[0], y: pt[1], root: true, manual: true, members: [], road: bs.st, s: nd.s, node: nd, stub: [[pt[0], pt[1]], V] });
        });
        // the two ends of each junction link: the verge point of each street at the junction, or the nearest one along that verge (≤ 15 m) that is clear
        // of every other carriageway. The through street's verge point at a T can be in the side street's mouth, and a link from there runs
        // inside the side street. Made before the streets are linked so a moved end is a node on its street like any other.
        const clearSt = (st, s0) => {
          const side = ks[st.id] || 1, ok = q => { const p = kp(st, side, q); return !fillHit(p) && streets.every(o => o === st || !(o.cw > 0) || cwDepth(o, p[0], p[1]) <= -0.35); };
          if (ok(s0)) return s0;
          for (let d = 0.25; d <= 15; d += 0.25) for (const q of [s0 - d, s0 + d]) if (q >= 0 && q <= st.len && ok(q)) return q;
          return s0;
        };
        const jLinks = [];
        for (const j of junctions) {
          const ss = use[j.id];
          for (let i = 0; i < ss.length; i++) for (let k = i + 1; k < ss.length; k++) {
            const A = ss[i], B = ss[k], lps = linkPaths(j.id, A, ks[A.id] || 1, B, ks[B.id] || 1);   // round the kerb return (and across, square) where there is one: every variant
            // (a link round a corner beyond a straight joint starts on the street beyond it: only where that is its LV side too)
            const fit = lps.filter(lp => (lp.X === A || lp.sideX === (ks[lp.X.id] || 1)) && (lp.Y === B || lp.sideY === (ks[lp.Y.id] || 1)));
            if (fit.length) for (const lp of fit) jLinks.push([lp.X, node(lp.X, lp.sX), lp.Y, node(lp.Y, lp.sY), lp]);
            else jLinks.push([A, node(A, clearSt(A, A.nodeSt[j.id])), B, node(B, clearSt(B, B.nodeSt[j.id]))]);
          }
        }
        const edges = [];
        const link = (A, B, pts, excl) => { const xs = pathCrossings(pts, excl), len = plen(pts), ed = { a: A, b: B, pts, len, xs, w: len + xs.length * 300 }; edges.push(ed); A.adj.push(ed); B.adj.push(ed); };
        streets.forEach(st => {
          const on = nodes.filter(n => n.st === st).sort((p, q) => p.s - q.s);
          for (let i = 1; i < on.length; i++) if (on[i].s - on[i - 1].s > 1e-6) { const side = ks[st.id] || 1, mp = mouthPath(st, side, on[i - 1].s, on[i].s);
            link(on[i - 1], on[i], mp || kv(st, side, on[i - 1].s, on[i].s), mp ? null : st); }
        });
        for (const [A, nA, B, nB, cn] of jLinks) { const a = kp(A, ks[A.id] || 1, nA.s).slice(0, 2), b = kp(B, ks[B.id] || 1, nB.s).slice(0, 2); link(nA, nB, cn ? cn.pts : [a, b], null); }
        // shortest-path tree of the kiosk-side verge graph from one kiosk (crossings carry a penalty in the weights)
        const treeFrom = (sk) => {
          const dist = new Map(nodes.map(n => [n, Infinity])), prev = new Map(), done = new Set();
          dist.set(sk.node, 0);
          const hp = [[0, sk.node]];                                                  // binary min-heap of [distance, node]
          const push = it => { hp.push(it); let i = hp.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (hp[q][0] <= hp[i][0]) break; [hp[q], hp[i]] = [hp[i], hp[q]]; i = q; } };
          const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === i) break; [hp[m], hp[i]] = [hp[i], hp[m]]; i = m; } } return top; };
          while (hp.length) {
            const [du, u] = pop(); if (done.has(u) || du > dist.get(u) + 1e-9) continue; done.add(u);
            for (const ed of u.adj) { const v = ed.a === u ? ed.b : ed.a; if (dist.get(u) + ed.w < dist.get(v) - 1e-9) { dist.set(v, dist.get(u) + ed.w); prev.set(v, ed); push([dist.get(v), v]); } }
          }
          return { dist, prev };
        };
        const trees = new Map();
        const T = k => { let t = trees.get(k); if (!t) { t = treeFrom(k); trees.set(k, t); } return t; };
        const dd = (a, b) => T(a).dist.get(b.node);
        // with no mini-sub placed (the app never allows that; only the tests) one stands beside the kiosk nearest the middle of the kiosks
        const pickSub = (grp) => { const sp = [grp.reduce((a, k) => a + k.x, 0) / grp.length, grp.reduce((a, k) => a + k.y, 0) / grp.length]; return grp.slice().sort((p, q) => Math.hypot(p.x - sp[0], p.y - sp[1]) - Math.hypot(q.x - sp[0], q.y - sp[1]))[0]; };
        // an automatic mini-sub stands 5 m along the street from the kiosk it is built beside (that kiosk is one the erven need anyway)
        const asRoot = k => {
          const st = k.road, s2 = k.s + 5 <= st.len ? k.s + 5 : Math.max(0, k.s - 5), p = kp(st, ks[st.id] || 1, s2).slice(0, 2);
          return { id: 'SUBAUTO', x: p[0], y: p[1], root: true, members: [], road: st, s: s2, node: k.node, stub: [p, [k.x, k.y]] };
        };
        // the mini-subs are the ones placed by hand, where you put them. The kiosks are split by LV distance; each group gets its own tree.
        const nFix = manualRoots.length, nSub = nFix || 1;
        let subs;
        if (nSub === 1) subs = [{ k: nFix ? manualRoots[0] : asRoot(pickSub(kiosks)), g: kiosks }];
        else {
          const cost = (c, g) => g.reduce((a, k) => a + dd(c, k) * k.members.length, 0);
          const med = manualRoots.slice();
          if (!med.length) med.push(kiosks.slice().sort((p, q) => cost(p, kiosks) - cost(q, kiosks))[0]);
          while (med.length < nSub) {
            let far = null, fd = -1;
            for (const k of kiosks) { if (med.includes(k)) continue; const d = Math.min(...med.map(m => dd(m, k))); if (d > fd) { fd = d; far = k; } }
            if (!far) break; med.push(far);
          }
          // each kiosk goes to its nearest mini-sub; with a balance limit set, none takes more than that multiple of an even share of the erven
          const total = kiosks.reduce((a, k) => a + k.members.length, 0), cap = P.subBal > 1 ? Math.ceil(total / nSub * P.subBal) : Infinity;
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
        { const seen = new Set(); let parts = 0;                                      // separate street networks in the verge graph (1 = every street is joined)
          for (const n0 of nodes) { if (seen.has(n0)) continue; parts++; const q = [n0]; seen.add(n0); while (q.length) { const u = q.pop(); for (const ed of u.adj) { const v = ed.a === u ? ed.b : ed.a; if (!seen.has(v)) { seen.add(v); q.push(v); } } } }
          net.parts = parts; }
        net.unreached = [];                                                          // kiosks the LV network does not reach (streets not joined up): their erven have no LV supply
        for (const S of subs) for (const k of S.g) if (k !== S.k && !(T(S.k).dist.get(k.node) < Infinity)) net.unreached.push(k);
        // strings: the tree is cut so no string has more than strN kiosks. A cut kiosk becomes a string head of its own: a feeder
        // straight off the mini-sub along the same route (the same thing a manual split does).
        const orig = new Map(net.lvLinks.map(l => [l.to, l]));
        const autoHeads = new Set();
        if (P.strN >= 1 || P.strE >= 1) {
          const byE = P.strE >= 1, wt0 = k => byE ? k.members.length : 1;       // strE: a string carries at most that many erven (0 = count kiosks, strN)
          for (const S of subs) {
            const kids = new Map(); S.g.forEach(k => kids.set(k, []));
            net.lvLinks.forEach(l => { if (l.from !== S.k && kids.has(l.from) && kids.has(l.to)) kids.get(l.from).push(l.to); });
            // size of the group hanging off each hub kiosk (a string head of the original tree)
            const total = k => wt0(k) + kids.get(k).reduce((a, c) => a + total(c), 0);
            const cutTree = (hub, limit) => {                                          // bottom-up: the fewest strings of at most `limit` kiosks
              const up = k => {
                const open = kids.get(k).map(c => ({ c, n: up(c) }));
                let sum = wt0(k) + open.reduce((a, o) => a + o.n, 0);
                open.sort((a, b) => b.n - a.n);
                for (const o of open) { if (sum <= limit) break; autoHeads.add(o.c); sum -= o.n; }
                return sum;
              };
              up(hub);
            };
            for (const l of net.lvLinks) {
              if (l.from !== S.k || !kids.has(l.to)) continue;
              let limit = byE ? Math.floor(P.strE) : Math.floor(P.strN);
              if (P.strMode === 'even') { const M = total(l.to), strs = Math.ceil(M / limit); limit = Math.ceil(M / strs); }
              cutTree(l.to, limit);
            }
          }
        }
        // a split string: a kiosk made its own string head (a feeder of its own straight off the mini-sub, along the same route)
        if (autoHeads.size || (input.splits && input.splits.length)) {
          for (const l of net.lvLinks.slice()) {
            const S = subs.find(x => x.g.includes(l.to));
            const auto = autoHeads.has(l.to);
            if (!S || l.from === S.k || !(auto || (input.splits || []).some(q => Math.hypot(q[0] - l.to.x, q[1] - l.to.y) <= 3))) continue;
            const chain = []; for (let cur = orig.get(l.to); cur; cur = cur.from === S.k ? null : orig.get(cur.from)) chain.unshift(cur);
            const pts = []; chain.forEach(c => c.pts.forEach(q => { if (!pts.length || Math.hypot(pts[pts.length - 1][0] - q[0], pts[pts.length - 1][1] - q[1]) > .01) pts.push(q); }));
            l.from = S.k; l.pts = pts; l.len = plen(pts); l.split = true;
            if (auto) pathCrossings(pts, null).forEach(x => events.push({ st: x.st, s: x.s, t: 'lv' }));   // its own cable over every crossing on the way
          }
        }
        net.strings = net.lvLinks.filter(l => subs.some(S => S.k === l.from)).length;
        { // each string's reach: the cable run from the mini-sub to its furthest kiosk (a cut string still has its own feeder along the same route, so cutting never shortens it)
          const into = new Map(net.lvLinks.map(l => [l.to, l])), kidsOf = new Map(), dist = new Map();
          net.lvLinks.forEach(l => { if (!subs.some(S => S.k === l.from)) (kidsOf.get(l.from) || kidsOf.set(l.from, []).get(l.from)).push(l.to); });
          const dOf = k => { if (dist.has(k)) return dist.get(k); const l = into.get(k), v = l ? l.len + (subs.some(S => S.k === l.from) ? 0 : dOf(l.from)) : 0; dist.set(k, v); return v; };
          const mem = (k, a = []) => { a.push(k); (kidsOf.get(k) || []).forEach(c => mem(c, a)); return a; };
          net.strLens = net.lvLinks.filter(l => subs.some(S => S.k === l.from)).map(l => { const ks = mem(l.to); let far = l.to; ks.forEach(k => { if (dOf(k) > dOf(far)) far = k; }); return { sub: subs.find(S => S.k === l.from), head: l.to, far, kiosks: ks, len: dOf(far) }; });
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
          last[ev.t]++; last.ss.push(ev.s);
          if (ev.t !== 'jn') { last.n++; last.sum += ev.s; last.s = last.sum / last.n; }
        } else cross.push({ st: ev.st, s0: ev.s, s: ev.s, ss: [ev.s], sum: ev.t === 'jn' ? 0 : ev.s, n: ev.t === 'jn' ? 0 : 1, svc: 0, fib: 0, lv: 0, mv: 0, jn: 0, [ev.t]: 1 });
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
    // corner 'pair': neighbours on one side of a street whose fronts meet take the two corners on their common boundary, so their services
    // share one trench into the boundary (and one crossing across the road). An erf with no neighbour keeps the start corner.
    erven.forEach(e => { e.pairEnd = null; });
    if (P.corner === 'pair') {
      const sides = new Map();
      for (const e of erven) if (e.fe && !e.manual) { const k = e.road.id + '|' + e.sd; if (!sides.has(k)) sides.set(k, []); sides.get(k).push(e); }
      for (const list of sides.values()) {
        list.sort((p, q) => p.al - q.al);
        for (let i = 0; i + 1 < list.length; i++) {
          const a = list[i], b = list[i + 1];
          if (a.pairEnd || b.pairEnd || Math.abs(a.hi - b.lo) > 1.5) continue;
          a.pairEnd = 'hi'; b.pairEnd = 'lo'; i++;
        }
      }
    }
    const kiosks = P.kmode === 'opt' && P.knet !== false ? placeKiosksNet() : placeKiosks();
    placeMarkers();
    const over = erven.filter(e => e.cable > P.maxc + 1e-6);
    if (over.length) warns.push(`${over.length} erven are more than ${P.maxc} m of service cable from their kiosk.`);
    const noFront = erven.filter(e => !e.fe);
    if (noFront.length) warns.push(`${noFront.length} erven do not face a street and were left out.`);
    const fibre = placeFibre();
    const net = placeNetworks(kiosks);
    const cab = erven.filter(e => e.cable).map(e => e.cable);
    // what the cross-section says about what was laid out: sizes onto the parts, and checks measured from the erf boundary
    const secChecks = [];
    if (SEC) {
      kiosks.forEach(k => { const sc = secAt(k.road, k.s); if (sc) { k.section = sc.id; k.dim = Object.assign({}, sc.items.kiosk); } });
      (fibre.mhs || []).forEach(m => { const sc = secAt(m.road, m.a); if (sc) { m.section = sc.id; m.dim = Object.assign({}, sc.items.mh); } });
      for (const st of streets) {
        const sc = secAt(st, st.len / 2);
        if (sc && frontage(st, 1) && frontage(st, -1)) {
          const W = sc.strips.a + sc.strips.road + sc.strips.b, M = fd(st, 1, st.len / 2) + fd(st, -1, st.len / 2);
          if (Math.abs(W - M) > 0.5) secChecks.push({ sev: 'warn', street: st.id, text: `${st.name}: section "${sc.name}" is ${W.toFixed(2)} m wide, but the erf boundaries are ${M.toFixed(2)} m apart.` });
        }
        const ks2 = kiosks.filter(k => k.road === st).sort((p, q) => p.s - q.s);
        for (let i = 1; i < ks2.length; i++) {
          const d = ks2[i].dim, need = d ? d.len + 2 * d.end : 0, gap = ks2[i].s - ks2[i - 1].s;
          if (d && gap < need) secChecks.push({ sev: 'warn', street: st.id, text: `${st.name}: two kiosks ${gap.toFixed(1)} m apart, but a kiosk needs ${need.toFixed(2)} m (length and clear space each end).` });
        }
      }
      for (const sc of SEC.list) {
        const d = sc.items, kf = d.kiosk.off + d.kiosk.depth;
        if (d.lv.off + d.lv.w / 2 > d.kiosk.off && d.lv.off - d.lv.w / 2 < kf) secChecks.push({ sev: 'info', street: null, text: `Section "${sc.name}": the LV trench runs under the kiosk footprint.` });
        if (d.pole.off - kf < 1) secChecks.push({ sev: 'warn', street: null, text: `Section "${sc.name}": pole ${(d.pole.off - kf).toFixed(2)} m from the kiosk (1.00 m wanted).` });
      }
    }
    return {
      sections: SEC, secChecks,
      P, streets, junctions, erven, kiosks, fibre, net, over, noFront, ks, fs, _bm: BM,
      warns: warns.concat(fibre.warns),
      stats: {
        erven: erven.filter(e => e.fe).length, kiosks: kiosks.length, strings: net.strings || 0, small: kiosks.filter(k => k.members.length <= 2).length, avgPer: kiosks.length ? erven.filter(e => e.kiosk).length / kiosks.length : 0, unreached: net.unreached.length, manual: erven.filter(e => e.manual).length, corner: erven.filter(e => e.corner).length, overridden: Object.keys(overrides).length,
        cable: cab.reduce((a, b) => a + b, 0), cableMax: Math.max(0, ...cab), over: over.length,
        manholes: fibre.mhs.length, junctionManholes: fibre.inter.length, trunk: fibre.trunkLen, leads: fibre.leadLen, tOffs: fibre.tOffs, spurEnds: fibre.ends, loops: fibre.loops,
        crossings: net.cross.length, provisional: net.prov, baseline: net.baseline, d110: net.d110, d160: net.d160, lv: net.lvLen, mv: net.mvLen, ms: Date.now() - t0,
      },
    };
  }

  // ───────────── boundary-first routing (route 'blocks', the default) ─────────────
  // The solve above chooses the design: kiosks and which erven each serves, erf markers, manholes and the fibre topology, the LV tree. Here
  // every cable is laid again on PlanBlocks: along each block's corridor ring (kd off the erf boundary, road side) and across a road only at
  // a crossing site (one square crossing per junction leg past the corner splay, or at an erf boundary mid-block). The street lines are only
  // topology for it, so nothing here is measured from them. Kiosks, manholes and mini-sub stubs move onto the rings; a service that comes
  // out longer than the limit is given to another kiosk with room that reaches it; the crossings are the sites the cables use.
  const blocksLib = () => typeof PlanBlocks !== 'undefined' ? PlanBlocks : (typeof require === 'function' ? (() => { try { return require('./plan-blocks.js'); } catch (e) { return null; } })() : null);
  // the corridor model of an input (built once: the side trials of kside 'try' solve the same erven and streets again)
  const BM_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function blocksModel(input, P, erven, streets) {
    const PB = blocksLib(); if (!PB || !erven.length || !streets.length) return null;
    const sec = input.sections && input.sections.on !== false && Array.isArray(input.sections.list) && input.sections.list.length ? (input.sections.list.find(x => x.id === input.sections.def) || input.sections.list[0]) : null;
    const KD = Math.max(0.3, P.kd != null ? +P.kd : 2), kdP = sec ? Math.max(0.3, +sec.items.lv.off) : KD, kdF = sec ? Math.max(0.3, +sec.items.fi.off) : Math.max(0.3, KD - 0.3);
    const opt = { gap: +P.gapTol, gapFace: +P.gapFace, setback: +P.setback, rule: P.xrule, xpen: +P.xroute, xshare: 0 };
    const sig = JSON.stringify([kdP, kdF, opt, streets.map(s => s.pts.length + ':' + s.pts[0] + ':' + s.pts[s.pts.length - 1])]);
    const key = input.erven, hit = BM_CACHE && key && BM_CACHE.get(key);
    if (hit && hit.sig === sig) { Object.values(hit.M.cls).forEach(g => g.resetUse()); return hit.M; }
    const M = PB.model({ erven: erven.map(e => ({ id: e.id, poly: e.poly })), lines: streets.map(s => s.pts), classes: { p: kdP, f: kdF } }, opt);
    if (BM_CACHE && key) BM_CACHE.set(key, { sig, M });
    return M;
  }
  function reroute(r, input, P) {
    const PB = blocksLib(); if (!PB || !r.erven.length || !r.streets.length) return false;
    const M = r._bm || blocksModel(input, P, r.erven, r.streets); if (!M) return false;
    Object.values(M.cls).forEach(g => g.resetUse()); delete r._bm;
    const G = M.cls.p, GF = M.cls.f, maxc = +P.maxc, simp = pts => PB.rdp(pts, 0.03), blk = e => M.blockOf.get(e.id);
    r.route = 'blocks'; r.blocks = M; r.keepOut = { fixed: 0, failed: 0 };
    const onto = (g, o) => { const nd = g.attach([o.x, o.y]); if (nd == null) return; const p = g.nodes[nd].p; o.x = p[0]; o.y = p[1]; o.bnode = nd; };
    // an erf marker or fibre point the solve put outside its own erf (an odd corner erf whose front is only a short splay edge) is pulled
    // 0.5 m inside it at the nearest point, so its service or duct never ends in the neighbour
    const inside = (e, q) => {
      if (!q || pip(q[0], q[1], e.poly)) return q;
      let best = null; const P = e.poly;
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, t = clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2, 0, 1), p = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (!best || d < best.d) best = { d, p }; }
      const c = [e.cx, e.cy], v = [c[0] - best.p[0], c[1] - best.p[1]], l = Math.hypot(v[0], v[1]) || 1, out = [best.p[0] + v[0] / l * 0.5, best.p[1] + v[1] / l * 0.5];
      return pip(out[0], out[1], e.poly) ? out : c.slice();
    };
    r.erven.forEach(e => { if (e.marker) { const m = inside(e, e.marker); e.marker[0] = m[0]; e.marker[1] = m[1]; } if (e.fibrePt) { const m = inside(e, e.fibrePt); e.fibrePt[0] = m[0]; e.fibrePt[1] = m[1]; } });
    // kiosks
    // a kiosk goes onto the corridor on its own side of its street; where that side has no corridor (no erf faces it there) it stays where it
    // was put and joins the corridor across the road by a crossing of its own (`k.xjoin`, counted with the crossings below)
    const kx = [];
    r.kiosks.forEach(k => { const j = kioskJoin(M, G, k, !!(k.pin || (k.road && input.ks && input.ks[k.road.id]))); if (!j) return; const p = G.nodes[j.nd].p; k.bnode = j.nd;
      if (j.x) { k.xjoin = { cls: 'p', kind: 'kiosk', a: [k.x, k.y], b: p.slice(), used: [] }; kx.push(k.xjoin); } else { k.x = p[0]; k.y = p[1]; } });
    // services, kiosk by kiosk
    const svc = (e, k, ov) => { const rt = k.bnode == null ? null : G.route(k.bnode, G.attachInto(e.marker, blk(e), e.id), ov); if (!rt) return null; rt.full = [[k.x, k.y], ...rt.pts.slice(k.xjoin ? 0 : 1), e.marker.slice()]; rt.len = plen(rt.full); return rt; };
    let moved = 0, kept = 0, keptRuns = 0, slid = 0;
    // a kiosk with a service over the limit (the solve put it on a junction corner, its erf diagonally across) first slides along its own
    // corridor, up to 40 m each way, to the stand where the fewest of its erven are over the limit, then the least service cable
    for (const k of r.kiosks) {
      if (k.bnode == null || k.pin || k.xjoin) continue;
      const lens = () => k.members.filter(e => e.marker).map(e => { const rt = svc(e, k); return rt ? rt.len : Infinity; });
      const score = ls => [ls.filter(v => v > maxc).length, ls.reduce((t, v) => t + Math.min(v, 1e4), 0)];
      const cur = score(lens()); if (!cur[0]) continue;
      const nd0 = G.nodes[k.bnode], R = nd0.R, N = R.pts.length, home = [k.x, k.y]; let best = { sc: cur, nd: k.bnode };
      for (let d = -80; d <= 80; d += 4) {                                             // ring nodes are 0.5 m apart: 2 m steps, ±40 m
        const i = ((nd0.i + d) % N + N) % N; if (!R.front[i] || !d) continue;
        const nd = R.node[i]; k.bnode = nd; k.x = R.pts[i][0]; k.y = R.pts[i][1];
        const sc = score(lens()); if (sc[0] < best.sc[0] || (sc[0] === best.sc[0] && sc[1] < best.sc[1] - 1e-6)) best = { sc, nd };
      }
      k.bnode = best.nd; const p = G.nodes[best.nd].p; k.x = p[0]; k.y = p[1];
      if (best.nd !== nd0.R.node[nd0.i]) slid++; else { k.x = home[0]; k.y = home[1]; }
    }
    for (const k of r.kiosks.slice()) for (const e of k.members.slice()) {
      if (!e.marker) continue;
      let rt = svc(e, k); if (rt && rt.len > maxc) { const r2 = svc(e, k, { xpen: 0 }); if (r2 && r2.len < rt.len) rt = r2; }
      if (!rt || rt.len > maxc) {                                                    // another kiosk with room that reaches it within the limit
        const alt = r.kiosks.filter(q => q !== k && q.members.length < P.n && Math.hypot(q.x - e.marker[0], q.y - e.marker[1]) <= maxc)
          .map(q => ({ q, rt: svc(e, q) })).filter(x => x.rt && x.rt.len <= maxc).sort((a, b) => a.rt.len - b.rt.len)[0];
        if (alt) { k.members.splice(k.members.indexOf(e), 1); alt.q.members.push(e); e.kiosk = alt.q; rt = alt.rt; moved++; }
      }
      if (!rt) { kept++; continue; }                                                // no path on the rings: the solve's own route stays
      rt.commit('svc'); if (e.kiosk && e.kiosk.xjoin) e.kiosk.xjoin.used.push('svc'); e.route = simp(rt.full); e.cable = plen(e.route); e.hopN = 0; e.xsites = rt.sites;
    }
    // fibre: manholes onto the fibre ring, every trunk section and erf duct laid again between its own two ends
    const F = r.fibre;
    if (F) {
      // a manhole put by hand stays on its side of the street: onto that side's fibre corridor, or, where there is none, where it was put and
      // joined to the corridor across the road by a crossing of its own (as a kiosk)
      [...(F.mhs || []), ...(F.inter || [])].forEach(m => { if (!m.hand) return onto(GF, m); const j = kioskJoin(M, GF, m, true); if (!j) return; const p = GF.nodes[j.nd].p; m.bnode = j.nd;
        if (j.x) { m.xjoin = { cls: 'f', kind: 'manhole', a: [m.x, m.y], b: p.slice(), used: [] }; kx.push(m.xjoin); } else { m.x = p[0]; m.y = p[1]; } });
      const active = new Set(F.trunks || []);
      for (const ed of (F.trunks || []).concat(F.spare || [])) {
        if (ed.a.bnode == null || ed.b.bnode == null) continue;
        const rt = GF.route(ed.a.bnode, ed.b.bnode); if (!rt) { if (active.has(ed)) keptRuns++; continue; }
        if (active.has(ed)) { rt.commit('fib'); for (const q of [ed.a, ed.b]) if (q.xjoin) q.xjoin.used.push('fib'); }
        ed.pts = simp([[ed.a.x, ed.a.y], ...rt.pts, [ed.b.x, ed.b.y]]); ed.len = plen(ed.pts);
      }
      for (const e of r.erven) {
        if (!e.mh || !e.fibrePt || e.mh.bnode == null) continue;
        const rt = GF.route(e.mh.bnode, GF.attachInto(e.fibrePt, blk(e), e.id)); if (!rt) { keptRuns++; continue; }
        rt.commit('fib'); if (e.mh.xjoin) e.mh.xjoin.used.push('fib'); e.duct = simp([[e.mh.x, e.mh.y], ...rt.pts.slice(e.mh.xjoin ? 0 : 1), e.fibrePt.slice()]); e.ductLen = plen(e.duct); e.fibX = null;
      }
    }
    // LV: every link of the tree laid again between its two ends (a string head from its mini-sub's stub)
    const net = r.net;
    if (net && net.subs && net.subs.length) {
      net.subs.forEach(S => { const k = S.k, nd = G.attach([k.x, k.y]); if (nd == null) return; k.bnode = nd; if (k.stub) k.stub = [[k.x, k.y], G.nodes[nd].p.slice()]; });
      // an LV link to a kiosk standing off the corridors (its side has none there, so it is joined across the road): where the straight line
      // between its two ends crosses no street line and no erf (the mini-sub or kiosk beside it on the same verge) it runs straight, rather
      // than across to the far corridor and back over the kiosk's own crossing
      const straight = (A, B) => (A.xjoin || B.xjoin) && M.streetSI && M.crossesBlock && !M.streetSI.crosses([A.x, A.y], [B.x, B.y], true) && !M.crossesBlock([A.x, A.y], [B.x, B.y]);
      for (const l of net.lvLinks) {
        const A = l.from, B = l.to;
        if (straight(A, B)) { l.pts = [[A.x, A.y], [B.x, B.y]]; l.len = plen(l.pts); l.direct = true; continue; }
        if (A.bnode == null || B.bnode == null) { keptRuns++; continue; }
        const rt = G.route(A.bnode, B.bnode); if (!rt) { keptRuns++; continue; }
        rt.commit('lv'); for (const k of [A, B]) if (k.xjoin) k.xjoin.used.push('lv'); l.pts = simp([[A.x, A.y], ...rt.pts, [B.x, B.y]]); l.len = plen(l.pts);
      }
      net.lv = net.lvLinks.filter(l => !l.split).map(l => ({ a: l.from, b: l.to, pts: l.pts, len: l.len, xs: [] }));
      net.lvLen = net.lv.reduce((t, ed) => t + ed.len, 0);
      if (net.strLens) {                                                             // each string's reach, mini-sub to its furthest kiosk
        const into = new Map(net.lvLinks.map(l => [l.to, l])), isSub = k => net.subs.some(S => S.k === k), memo = new Map();
        const dOf = k => { if (memo.has(k)) return memo.get(k); const l = into.get(k), v = l ? l.len + (isSub(l.from) ? 0 : dOf(l.from)) : 0; memo.set(k, v); return v; };
        net.strLens.forEach(s => { let far = s.head; s.kiosks.forEach(k => { if (dOf(k) > dOf(far)) far = k; }); s.far = far; s.len = dOf(far); });
      }
    }
    // the crossings: the sites the cables use (power and fibre at the same place share one unless the rule is a crossing per cable class)
    const nearSt = p => { let b = null; for (const st of r.streets) { const pr = project(st, p[0], p[1]); if (!b || pr.d < b.pr.d) b = { st, pr }; } return b; };
    const cross = [], shareAll = P.xrule !== 'class' && P.share !== false;
    for (const x of [...G.sites, ...GF.sites, ...kx]) {
      const prov = !x.used.length; if (prov && (x.kind === 'kiosk' || x.kind === 'manhole')) continue; if (prov && !(P.junct && x.kind === 'leg' && x.cls === 'p')) continue;
      const mid = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2], ns = nearSt(mid), s = ns.pr.s;
      const cnt = t => x.used.filter(u => u === t).length;
      let g = shareAll && !prov ? cross.find(c => !c.prov && c.st === ns.st && Math.abs(c.s - s) <= 3 && Math.hypot(c.mid[0] - mid[0], c.mid[1] - mid[1]) <= 4) : null;
      if (!g) { g = { st: ns.st, s, s0: s, ss: [], sum: 0, n: 0, svc: 0, fib: 0, lv: 0, mv: 0, jn: 0, prov, a: x.a.slice(), b: x.b.slice(), mid, kind: x.kind, sites: [] }; cross.push(g); }
      g.sites.push(x); g.ss.push(s);
      g.svc += cnt('svc'); g.fib += cnt('fib'); g.lv += cnt('lv'); if (prov) g.jn++;
      if (!prov) { g.n += x.used.length; if (x.cls === 'p') { g.a = x.a.slice(); g.b = x.b.slice(); } }
    }
    cross.forEach(c => {
      if (c.prov) { c.d110s = c.d110f = c.d110l = 0; c.d110 = P.j110; c.d160 = P.j160; c.spare = 0; }
      else { c.d110s = Math.ceil(c.svc / 4); c.d110f = Math.ceil(c.fib / 4); c.d110l = Math.ceil(c.lv / 2); c.d160 = c.mv; c.spare = P.spare; c.d110 = c.d110s + c.d110f + c.d110l + P.spare; }
    });
    if (net) { net.cross = cross; net.baseline = cross.reduce((t, c) => t + c.n, 0); net.prov = cross.filter(c => c.prov).length; net.d110 = cross.reduce((t, c) => t + c.d110, 0); net.d160 = cross.reduce((t, c) => t + c.d160, 0); }
    relength(r);
    if (r.stats) Object.assign(r.stats, { crossings: cross.length, provisional: net ? net.prov : 0, baseline: net ? net.baseline : 0, d110: net ? net.d110 : 0, d160: net ? net.d160 : 0, blocks: M.blocks.length, reassigned: moved, slid });
    // warnings: the service-length one follows the new routes; what the crossing sites could not do is said once per junction
    r.warns = r.warns.filter(w => !/of service cable from their kiosk/.test(w));
    if (r.over.length) r.warns.push(`${r.over.length} erven are more than ${P.maxc} m of service cable from their kiosk.`);
    if (kept) r.warns.push(`${kept} service${kept === 1 ? '' : 's'} could not be laid along the erf boundaries (no path on the corridors) and kept the street-line route.`);
    if (keptRuns) r.warns.push(`${keptRuns} LV or fibre run${keptRuns === 1 ? '' : 's'} could not be laid along the erf boundaries (no path on the corridors) and kept the street-line route.`);
    const links = [...G.sites, ...GF.sites].filter(x => x.kind === 'link' && x.used.length).length;
    if (links) r.warns.push(`${links} road crossing${links === 1 ? '' : 's'} could not be put on a junction leg (the mouth is open or blocked) and ${links === 1 ? 'is a straight link' : 'are straight links'} between the corridors: check ${links === 1 ? 'it' : 'them'} on the plan.`);
    const jw = new Map(); G.warns.forEach(w => { if (w.j && !jw.has(w.j)) jw.set(w.j, w.text); });
    const jBad = [...jw.entries()].filter(([, t]) => !/one side only/.test(t));
    if (jBad.length) r.warns.push(`${jBad.length} junction leg${jBad.length === 1 ? '' : 's'} got no road crossing (${jBad.slice(0, 3).map(([, t]) => t).join('; ')}): cables there go round to the next crossing.`);
    return true;
  }

  // trenches along the corridors (route 'blocks'): what runs on each ring edge shares a trench along it; the pieces off the rings (into an
  // erf, to a kiosk or manhole, or moved by hand) are trenches of their own; every crossing is one trench from ring to ring
  function trenchesBlocks(res, T, dep, kinds) {
    const M = res.blocks, out = [], H = 0.5;
    const grid = {}; for (const [nm, G] of Object.entries(M.cls)) { const m = new Map(); G.nodes.forEach((nd, i) => { const k = Math.round(nd.p[0] / H) + ',' + Math.round(nd.p[1] / H); if (!m.has(k)) m.set(k, []); m.get(k).push(i); }); grid[nm] = m; }
    const near = (nm, p, tol) => { const G = M.cls[nm], m = grid[nm], i0 = Math.round(p[0] / H), j0 = Math.round(p[1] / H); let best = -1, bd = tol;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const i of m.get((i0 + di) + ',' + (j0 + dj)) || []) { const d = Math.hypot(G.nodes[i].p[0] - p[0], G.nodes[i].p[1] - p[1]); if (d < bd) { bd = d; best = i; } } return best; };
    const use = { p: new Map(), f: new Map() }, spurs = new Map();
    const ekey = (a, b) => a < b ? a + '-' + b : b + '-' + a;
    const rnd = p => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4);
    const flush = (chain, cat) => { if (chain.length < 2 || plen(chain) < 0.3) return; for (let i = 1; i < chain.length; i++) if (M.streetSI.crosses(chain[i - 1], chain[i], true)) return;    // across a road: the crossing trench covers it
      const a = rnd(chain[0]), b = rnd(chain[chain.length - 1]), key = a < b ? a + '|' + b : b + '|' + a; let sp = spurs.get(key); if (!sp) { sp = { pts: chain.slice(), cats: new Set() }; spurs.set(key, sp); } sp.cats.add(cat); };
    const add = (pts, cat, nm) => {
      if (!Array.isArray(pts) || pts.length < 2) return; const G = M.cls[nm];
      const smp = []; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25)); for (let k = i === 1 ? 0 : 1; k <= n; k++) smp.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
      let chain = [], prev = -1;
      for (const q of smp) {
        const nd = near(nm, q, 0.3);
        if (nd >= 0) {
          if (chain.length) { chain.push(G.nodes[nd].p); flush(chain, cat); chain = []; }
          if (prev >= 0 && prev !== nd && G.nodes[prev].R === G.nodes[nd].R) { const L = G.nodes[nd].R.pts.length, d = Math.abs(G.nodes[prev].i - G.nodes[nd].i); if (d === 1 || d === L - 1) { const k = ekey(prev, nd); if (!use[nm].has(k)) use[nm].set(k, new Set()); use[nm].get(k).add(cat); } }
          prev = nd;
        } else { if (!chain.length) chain.push(prev >= 0 ? G.nodes[prev].p : q); chain.push(q); prev = -1; }
      }
      flush(chain, cat);
    };
    res.erven.forEach(e => { if (e.route) add(e.route, 'svc', 'p'); if (T.fibre !== 'off' && e.duct) add(e.duct, 'fi', 'f'); });
    if (res.net) (res.net.lv || []).forEach(ed => add(ed.pts, 'lv', 'p'));
    if (T.fibre !== 'off' && res.fibre) (res.fibre.trunks || []).forEach(ed => add(ed.pts, 'fi', 'f'));
    const pwNear = p => { const nd = near('p', p, 0.8); if (nd < 0) return false; const G = M.cls.p, R = G.nodes[nd].R, i = G.nodes[nd].i, L = R.pts.length;
      for (const j of [(i + 1) % L, (i + L - 1) % L]) { const c = use.p.get(ekey(nd, R.node[j])); if (c && (c.has('svc') || c.has('lv'))) return true; } return false; };
    for (const [nm, G] of Object.entries(M.cls)) for (const R of G.rings) {
      const L = R.pts.length, catOf = k => use[nm].get(ekey(R.node[k], R.node[(k + 1) % L])), keyOf = k => { const c = catOf(k); return c && c.size ? [...c].sort().join('+') : ''; };
      let start = 0; for (let k = 0; k < L; k++) if (keyOf(k) !== keyOf((k + L - 1) % L)) { start = k; break; }
      let run = null; const emitRun = () => { if (!run) return; let cats = new Set(run.key.split('+'));
        if (nm === 'f' && T.fibre === 'with' && pwNear(run.pts[Math.floor(run.pts.length / 2)])) cats = new Set();
        for (const kd of kinds(cats, null)) if (run.pts.length >= 2 && plen(run.pts) > 0.3) out.push({ type: kd.type, pts: run.pts, depth: dep(kd.type, null), len: plen(run.pts), cats: [...cats], kind: 'run', section: null }); run = null; };
      for (let s = 0; s < L; s++) { const k = (start + s) % L, key = keyOf(k);
        if (!key) { emitRun(); continue; }
        if (run && run.key !== key) emitRun();
        if (!run) run = { key, pts: [R.pts[k]] }; run.pts.push(R.pts[(k + 1) % L]); }
      emitRun();
    }
    for (const sp of spurs.values()) for (const kd of kinds(sp.cats, null)) out.push({ type: kd.type, pts: sp.pts, depth: dep(kd.type, null), len: plen(sp.pts), cats: [...sp.cats], kind: 'spur', section: null });
    if (T.crossings && res.net) res.net.cross.forEach(x => {
      const mv = x.d160 > 0, pw = x.svc > 0 || x.lv > 0 || (x.prov && x.d110 > 0), fi = x.fib > 0 && T.fibre !== 'off';
      const type = mv && (pw || fi) ? 'MV/LV/SL' : mv ? 'MV' : pw ? 'LV/SL' : fi ? 'FI' : null; if (!type) return;
      const [a, b] = x.ends || [x.a, x.b];
      out.push({ type, pts: [[a[0], a[1]], [b[0], b[1]]], depth: dep(type, null), section: null, len: Math.hypot(b[0] - a[0], b[1] - a[1]), cats: [mv && 'mv', pw && 'lv', fi && 'fi'].filter(Boolean), kind: 'crossing' });
    });
    if (T.lead) shareLeads(res, out);
    const sum = {}; out.forEach(t => { const q = sum[t.type] || (sum[t.type] = { len: 0, n: 0, depth: t.depth }); q.len += t.len; q.n++; });
    return { list: out, summary: sum, T };
  }
  // one lead trench into each erf (T.lead): where an erf's fibre point is within 3 m of its power marker, the service lead and the fibre
  // lead share a trench — the longer of the two spurs is kept, as the power trench (type and depth of the service spur), carrying both
  function shareLeads(res, out) {
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.35, endAt = (t, q) => near(t.pts[0], q) || near(t.pts[t.pts.length - 1], q);
    const drop = new Set();
    for (const e of res.erven) {
      if (!e.marker || !e.fibrePt || !e.route || !e.duct || Math.hypot(e.marker[0] - e.fibrePt[0], e.marker[1] - e.fibrePt[1]) > 3) continue;
      const spur = (cat, q, not) => out.find(t => t.kind === 'spur' && t !== not && !drop.has(t) && t.cats.includes(cat) && endAt(t, q));
      const pw = spur('svc', e.marker, null); if (!pw) continue;
      const fi = spur('fi', e.fibrePt, pw), keep = fi && fi.len > pw.len ? fi : pw;
      if (fi) drop.add(keep === pw ? fi : pw);
      keep.type = pw.type; keep.depth = pw.depth; if (pw.section !== undefined) keep.section = pw.section;
      keep.cats = [...new Set([...pw.cats, 'fi'])]; keep.lead = true;
    }
    if (drop.size) { const rest = out.filter(t => !drop.has(t)); out.length = 0; out.push(...rest); }
  }

  // kside 'try': the kiosk side of each street is first the one with more erven; here each street the user has not set is tried the other way
  // round (the whole layout solved again) and kept when kiosks x worth + service cable + crossings x xpen is lower. Streets are tried in order,
  // each against the best so far, so this costs one extra solve per street.
  function solve(input, Pin) { const r = solveSides(input, Pin); if (r.P.route === 'street' || !reroute(r, input, r.P)) keepOut(r); return r; }
  function solveSides(input, Pin) {
    const base = solveOnce(input, Pin), P = base.P;
    if (P.kside !== 'try' || !base.streets.length) return base;
    const score = r => r.kiosks.length * P.worth + r.stats.cable + Math.max(0, +P.xpen) * r.stats.crossings;
    let best = base, bestKs = Object.assign({}, base.ks);
    for (const st of base.streets) {
      if (input.ks && input.ks[st.id]) continue;                              // set by hand: leave it
      const ks = Object.assign({}, bestKs, { [st.id]: -bestKs[st.id] });
      const r = solveOnce(Object.assign({}, input, { ks }), Pin);
      if (score(r) < score(best) - 1e-6) { best = r; bestKs = Object.assign({}, r.ks); }
    }
    best.stats.ksTried = base.streets.length;
    return best;
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
    lead: false,                                           // one lead trench into the erf for its service cable and fibre duct (when the two enter within 3 m)
  };
  function trenches(res, Tin) {
    const T = { depth: Object.assign({}, TRENCH_DEFAULTS.depth, (Tin && Tin.depth) || {}), combine: (Tin && Tin.combine) || TRENCH_DEFAULTS.combine, fibre: (Tin && Tin.fibre) || TRENCH_DEFAULTS.fibre, crossings: !(Tin && Tin.crossings === false), lead: !!(Tin && Tin.lead) };
    const streets = res.streets, lines = [], spurs = new Map(), out = [];
    const lineFor = (st, sign, off) => { let l = lines.find(q => q.st === st && q.sign === sign && Math.abs(q.off - off) <= 0.75); if (!l) { l = { st, sign, off, offN: 0, ivs: [] }; lines.push(l); } l.off = (l.off * l.offN + off) / (l.offN + 1); l.offN++; return l; };
    const rnd = p => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4);
    const flush = (chain, cat) => { if (chain.length < 2) return; const a = rnd(chain[0]), b = rnd(chain[chain.length - 1]), key = a < b ? a + '|' + b : b + '|' + a; let sp = spurs.get(key); if (!sp) { sp = { pts: chain.slice(), cats: new Set() }; spurs.set(key, sp); } sp.cats.add(cat); };
    const add = (pts, cat) => {
      // a piece that turns off the street's direction (more than 15 degrees), a run turning a junction corner on the kerb-return curve, is a
      // trench of its own along that curve instead of being squared off onto the two streets' verge lines; a service leaving the verge stays as before
      const segs = [];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 0.05) continue;
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        let best = null; for (const st of streets) { const pr = project(st, mid[0], mid[1]); if (!best || pr.d < best.pr.d) best = { st, pr }; }
        const st = best.st, pp = project(st, p[0], p[1]), pq = project(st, q[0], q[1]);
        segs.push({ p, q, L, st, pp, pq, turn: Math.abs(pq.s - pp.s) / L < 0.966 });
      }
      // a curve is its own trench only between runs along two DIFFERENT streets (a junction corner); 3 m or more of it
      for (let i = 0; i < segs.length;) { if (!segs[i].turn) { i++; continue; } let j = i, len = 0; while (j < segs.length && segs[j].turn) len += segs[j++].L;
        const before = i > 0 ? segs[i - 1].st : null, after = j < segs.length ? segs[j].st : null;
        if (len < 3 || !before || !after || before === after) for (let k = i; k < j; k++) segs[k].turn = false; i = j; }
      let chain = [];
      for (const g of segs) {
        const { p, q, st, pp, pq } = g, op = pp.side * pp.d, oq = pq.side * pq.d;
        if (Math.abs(op - oq) > 3) { flush(chain, cat); chain = []; continue; }              // across a road: the crossing trench covers it
        const m = (Math.abs(op) + Math.abs(oq)) / 2, sg = Math.sign(op + oq) || 1, sMid = (pp.s + pq.s) / 2;
        // on the boundary corridor a line is told apart by how far it sits from the corridor itself (0 = kd inside the boundary)
        const bnd = st.byBoundary && typeof st.fd === 'function', rel = bnd ? m - (st.fd(sg, sMid) - st.kd) : m;
        if (!g.turn && Math.abs(op - oq) <= 0.6 && Math.abs(pq.s - pp.s) > 0.05 && (bnd ? rel >= -1.5 && rel <= st.kd + 0.5 : m >= st.vk - 1.5 && m <= st.w / 2 + 0.5)) {
          flush(chain, cat); chain = [];
          lineFor(st, sg, rel).ivs.push({ s0: Math.min(pp.s, pq.s), s1: Math.max(pp.s, pq.s), cat });
        } else { if (!chain.length) chain.push(p); chain.push(q); }
      }
      flush(chain, cat);
    };
    // depth of a trench: the section's own depth for its cable class where a section applies, else the Trenches setting
    const secDepth = (sec, type) => {
      const d = sec.items, mv = d.mv.depth, lv = Math.max(d.lv.depth, d.svc.depth), fi = d.fi.depth;
      return type === 'MV' ? mv : type === 'FI' ? fi : type === 'LV/SL' ? lv : Math.max(mv, lv);
    };
    const nearStreet = (x, y) => { let b = null; for (const st of streets) { const pr = project(st, x, y); if (!b || pr.d < b.pr.d) b = { st, pr }; } return b; };
    const secOf = (st, q) => (st && typeof st.sec === 'function') ? st.sec(q) : null;
    const dep = (type, sec) => sec && sec.items ? secDepth(sec, type) : type === 'MV' ? T.depth.mv : type === 'FI' ? T.depth.fi : type === 'LV/SL' ? T.depth.lv : (T.depth.comb != null ? T.depth.comb : Math.max(T.depth.mv, T.depth.lv));
    // what a set of cables becomes: [{ type, shift }] (shift moves a separate MV trench in from the verge line)
    const kinds = (cats, sec) => {
      const mv = cats.has('mv'), pw = cats.has('lv') || cats.has('svc'), fi = cats.has('fi');
      const r = [];
      if (mv && pw && T.combine === 'mvlv') r.push({ type: 'MV/LV/SL', shift: 0 });
      else { if (mv) r.push({ type: 'MV', shift: pw ? (sec && sec.items ? Math.max(0, sec.items.mv.off - sec.items.lv.off) : 0.7) : 0 }); if (pw) r.push({ type: 'LV/SL', shift: 0 }); }
      if (fi && !(T.fibre === 'with' && pw) && T.fibre !== 'off') r.push({ type: 'FI', shift: 0 });
      return r;
    };
    if (res.route === 'blocks' && res.blocks) return trenchesBlocks(res, T, dep, kinds);
    res.erven.forEach(e => { if (e.route) add(e.route, 'svc'); if (T.fibre !== 'off' && e.duct) add(e.duct, 'fi'); });
    if (res.net) { res.net.lv.forEach(ed => add(ed.pts, 'lv')); res.net.mv.forEach(ed => add(ed.pts, 'mv')); }
    if (T.fibre !== 'off' && res.fibre) res.fibre.trunks.forEach(ed => add(ed.pts, 'fi'));
    const emit = (type, pts, cats, kind, sec) => { if (pts.length >= 2 && plen(pts) > 0.3) out.push({ type, pts, depth: dep(type, sec), len: plen(pts), cats: [...cats], kind, section: sec ? sec.id : null }); };
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
      for (const r of runs) for (const k of kinds(r.cats, secOf(l.st, (r.a + r.b) / 2))) emit(k.type, l.st.byBoundary && typeof l.st.fd === 'function' ? relVerge(l.st, l.sign, r.a, r.b, l.off - k.shift) : verge(l.st, r.a, r.b, l.sign * (l.off - k.shift)), r.cats, 'run', secOf(l.st, (r.a + r.b) / 2));
    }
    for (const sp of spurs.values()) { const m0 = sp.pts[Math.floor(sp.pts.length / 2)], nb = nearStreet(m0[0], m0[1]), sec = nb ? secOf(nb.st, nb.pr.s) : null; for (const k of kinds(sp.cats, sec)) emit(k.type, sp.pts, sp.cats, 'spur', sec); }
    if (T.crossings && res.net) res.net.cross.forEach(x => {
      const mv = x.d160 > 0, pw = x.svc > 0 || x.lv > 0 || (x.prov && x.d110 > 0), fi = x.fib > 0 && T.fibre !== 'off';
      const type = mv && (pw || fi) ? 'MV/LV/SL' : mv ? 'MV' : pw ? 'LV/SL' : fi ? 'FI' : null;
      if (!type) return;
      const bnd = x.st.byBoundary && typeof x.st.fd === 'function', hA = bnd ? x.st.fd(1, x.s) : x.st.w / 2, hB = bnd ? x.st.fd(-1, x.s) : x.st.w / 2;
      const a = x.ends ? x.ends[0] : ptAt(x.st, x.s, hA), b = x.ends ? x.ends[1] : ptAt(x.st, x.s, -hB);              // `ends`: a crossing whose start / end were moved by hand
      const xsec = secOf(x.st, x.s);
      out.push({ type, pts: [[a[0], a[1]], [b[0], b[1]]], depth: dep(type, xsec), section: xsec ? xsec.id : null, len: x.ends ? Math.hypot(b[0] - a[0], b[1] - a[1]) : hA + hB, cats: [mv && 'mv', pw && 'lv', fi && 'fi'].filter(Boolean), kind: 'crossing' });
    });
    if (T.lead) shareLeads(res, out);
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
    // phases rotate along the whole string (R W B R W B …), not afresh at each kiosk, so a string of kiosks with 4 erven stays balanced
    const headOf = k => { let c = k, guard = 0; for (let l = up.get(c); l && l.from !== c.subK && guard++ < 200; l = up.get(c)) c = l.from; return c; };
    const phaseN = new Map();
    const kiosks = res.kiosks.map(k => {
      const l = up.get(k), hd = headOf(k);
      if (!phaseN.has(hd)) phaseN.set(hd, 0);
      // the kiosks next to the mini-sub's own are fed by their own feeder from the mini-sub (its own breaker, a string each), not through that kiosk
      const hub = !!l && l.from === k.subK;
      const base = phaseN.get(hd); phaseN.set(hd, base + k.members.length);
      return { id: k.id, name: k.id, fedFrom: l && !hub ? l.from.id : sid(k), loadClass: '', admdOverride: 0, streetLightKVA: 0,
        feederCable: (o.cableOf && o.cableOf[k.id]) || o.lvCable || '', outgoingProtection: o.outgoing || '', feederLength: l ? l.len : 0,
        erfs: k.members.map((e, i) => ({ id: e.id, erfNumber: String((o.names && o.names[e.id]) || e.id), length: Math.max(e.cable || 0, 0.1), phase: phases[(i + base) % phases.length], cableType: o.svcCable || '', ampsOverride: 0 })) };
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


  // ── keep-out: no run inside a carriageway ──
  // A street with a carriageway width (`cw`, from the reserve tool) keeps every generated cable, duct and trench point outside it, except where a run crosses the road
  // square (a crossing, at least 55 degrees to the street). A stretch that is inside is routed round the carriageway edge (0.5 m clear) by a small grid search.
  const SQ_DEG = 55, KEEP_CLEAR = 0.5;
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0; return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]); }
  function segHit(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]], den = r[0] * q[1] - r[1] * q[0]; if (Math.abs(den) < 1e-12) return null;
    const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den; if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { ang: Math.acos(Math.min(1, Math.abs(r[0] * q[0] + r[1] * q[1]) / (Math.hypot(r[0], r[1]) * Math.hypot(q[0], q[1]) || 1))) * 180 / Math.PI };
  }
  // distance to a street line whose ends are square: past the first or last point it is no distance at all (Infinity). A carriageway stops at the
  // end of its street, which at a T is the other street's centre line; a round cap there reached over to the far verge of the through street.
  function segDistFlat(p, a, b, first, last) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; if (!L2) return Infinity;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    if ((first && t < 0) || (last && t > 1)) return Infinity;
    t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  }
  // A kerb return's rounded-off corner (road): the triangle t1–P–t2 outside the circle (c, R). fillDepth(F, p) = how far p is inside it (≤ 0 = outside).
  function kerbFills(list) {
    return (Array.isArray(list) ? list : []).filter(k => k && k.P && k.c && k.t1 && k.t2 && k.R > 0).map(k => ({ P: k.P.slice(), c: k.c.slice(), R: +k.R, t1: k.t1.slice(), t2: k.t2.slice(), fill: true }));
  }
  function fillDepth(F, p) {
    const tri = [F.t1, F.P, F.t2]; let inTri = Infinity;
    for (let i = 0; i < 3; i++) { const a = tri[i], b = tri[(i + 1) % 3], o = tri[(i + 2) % 3], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1, sd = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / L, so = ((o[0] - a[0]) * ey - (o[1] - a[1]) * ex) / L; inTri = Math.min(inTri, so >= 0 ? sd : -sd); }
    return Math.min(inTri, Math.hypot(p[0] - F.c[0], p[1] - F.c[1]) - F.R);
  }
  function carriage(streets, withFills) {
    // a street whose carriageway is offset is tested on the carriageway's own centre line (same stations, width cw), so everything below is unchanged
    const S = (streets || []).filter(st => st.cw > 0).map(st => { if (!st.co) return st; const pts = offsetPts(st.pts, st.co), cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return Object.assign({}, st, { pts, cum, len: cum[cum.length - 1], co: 0, base: st }); });
    const FL = (withFills && streets && streets.rets) || [];                           // the returns' corners count in the Checks list only
    if (!S.length) return null;
    const dist = (st, p) => { let m = Infinity; const n = st.pts.length; for (let i = 1; i < n; i++) m = Math.min(m, segDistFlat(p, st.pts[i - 1], st.pts[i], i === 1, i === n - 1)); return m; };
    // a piece that crosses a street line at all: the part of it in a kerb return's rounded-off corner is under the road anyway (a crossing,
    // in a sleeve), e.g. along a through street's verge across a side street's mouth at a skewed junction
    const crossesAny = (a, b) => S.some(st => { for (let i = 1; i < st.pts.length; i++) if (segHit(a, b, st.pts[i - 1], st.pts[i])) return true; return false; });
    const squareOn = (a, b, st) => { for (let i = 1; i < st.pts.length; i++) { const h = segHit(a, b, st.pts[i - 1], st.pts[i]); if (h && h.ang >= SQ_DEG) return true; } return false; };
    // the street whose carriageway holds p deeper than `clear` metres, not counting a street the given segments cross square
    const insideAny = (p, segs, clear) => {
      for (const st of S) { if (segs.some(sg => sg && squareOn(sg[0], sg[1], st))) continue; if (dist(st, p) < st.cw / 2 - clear) return st; }
      for (const F of FL) if (fillDepth(F, p) > clear && !segs.some(sg => sg && crossesAny(sg[0], sg[1]))) return F;              // (a run across a street in its mouth is the crossing)
      return null;
    };
    return { S, FL, dist, squareOn, crossesAny, insideAny };
  }
  // a path from E to X that keeps clear of every carriageway: A* on a grid over the two points (+ 10 m); null when there is none
  function routeAround(E, X, C) {
    const pad = 10, x0 = Math.min(E[0], X[0]) - pad, y0 = Math.min(E[1], X[1]) - pad, x1 = Math.max(E[0], X[0]) + pad, y1 = Math.max(E[1], X[1]) + pad;
    let cs = 0.25; if (((x1 - x0) / cs) * ((y1 - y0) / cs) > 360000) cs = Math.sqrt((x1 - x0) * (y1 - y0) / 360000);
    const W = Math.ceil((x1 - x0) / cs) + 1, H = Math.ceil((y1 - y0) / cs) + 1, blocked = new Uint8Array(W * H), cx = i => x0 + i * cs, cy = j => y0 + j * cs;
    for (const st of C.S) {
      const r = st.cw / 2 + KEEP_CLEAR;
      for (let i = 1; i < st.pts.length; i++) {
        const a = st.pts[i - 1], b = st.pts[i], bx0 = Math.min(a[0], b[0]) - r, bx1 = Math.max(a[0], b[0]) + r, by0 = Math.min(a[1], b[1]) - r, by1 = Math.max(a[1], b[1]) + r;
        if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
        for (let gj = Math.max(0, Math.floor((by0 - y0) / cs)); gj <= Math.min(H - 1, Math.ceil((by1 - y0) / cs)); gj++) for (let gi = Math.max(0, Math.floor((bx0 - x0) / cs)); gi <= Math.min(W - 1, Math.ceil((bx1 - x0) / cs)); gi++) { if (!blocked[gj * W + gi] && segDistFlat([cx(gi), cy(gj)], a, b, i === 1, i === st.pts.length - 1) < r) blocked[gj * W + gi] = 1; }
      }
    }
    const trulyInside = q => C.S.some(st => C.dist(st, q) < st.cw / 2 - 0.1);
    for (const P of [E, X]) { const gi0 = Math.round((P[0] - x0) / cs), gj0 = Math.round((P[1] - y0) / cs), n = Math.ceil(0.8 / cs); for (let gj = gj0 - n; gj <= gj0 + n; gj++) for (let gi = gi0 - n; gi <= gi0 + n; gi++) if (gi >= 0 && gj >= 0 && gi < W && gj < H && blocked[gj * W + gi] && !trulyInside([cx(gi), cy(gj)])) blocked[gj * W + gi] = 0; }
    const sI = Math.round((E[0] - x0) / cs), sJ = Math.round((E[1] - y0) / cs), tI = Math.round((X[0] - x0) / cs), tJ = Math.round((X[1] - y0) / cs), N = W * H, start = sJ * W + sI, goal = tJ * W + tI;
    if (sI < 0 || sJ < 0 || sI >= W || sJ >= H || tI < 0 || tJ < 0 || tI >= W || tJ >= H) return null;
    blocked[start] = 0; blocked[goal] = 0;
    const g = new Float32Array(N).fill(Infinity), par = new Int32Array(N).fill(-1), heap = [], h = k => Math.hypot((k % W) - tI, Math.floor(k / W) - tJ) * cs;
    const push = (k, f) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let l = 2 * c + 1, r2 = l + 1, m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r2 < heap.length && heap[r2][0] < heap[m][0]) m = r2; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    g[start] = 0; push(start, h(start)); let found = false, guard = 0;
    while (heap.length && guard++ < 2e6) {
      const [, k] = pop(); if (k === goal) { found = true; break; }
      const ki = k % W, kj = (k - ki) / W;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const ni = ki + di, nj = kj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (blocked[nk]) continue;
        if (di && dj && (blocked[kj * W + ni] || blocked[nj * W + ki])) continue;
        const ng = g[k] + (di && dj ? 1.41421356 : 1) * cs; if (ng < g[nk]) { g[nk] = ng; par[nk] = k; push(nk, ng + h(nk)); }
      }
    }
    if (!found) return null;
    const cells = []; for (let k = goal; k !== -1; k = par[k]) cells.push([cx(k % W), cy(Math.floor(k / W))]); cells.reverse(); cells[0] = E.slice(); cells[cells.length - 1] = X.slice();
    const free = (a, b) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cs / 2))); for (let t = 0; t <= n; t++) { const q = [a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n], gi = Math.round((q[0] - x0) / cs), gj = Math.round((q[1] - y0) / cs); if (gi < 0 || gj < 0 || gi >= W || gj >= H || (blocked[gj * W + gi] && trulyInside(q))) return false; } return true; };
    const keepIdx = new Set([0, cells.length - 1]);
    const rdp = (i, j) => { if (j <= i + 1) return; let md = -1, mi = -1; for (let m = i + 1; m < j; m++) { const d = segDist(cells[m], cells[i], cells[j]); if (d > md) { md = d; mi = m; } } if (md <= 0.2 && free(cells[i], cells[j])) return; keepIdx.add(mi); rdp(i, mi); rdp(mi, j); };
    rdp(0, cells.length - 1);
    return [...keepIdx].sort((a, b) => a - b).map(i => cells[i]);
  }
  const PL_project = (st, p) => project(st, p[0], p[1]).side;
  // one run: every stretch inside a carriageway (deeper than 10 cm, not a square crossing) is replaced by a path round it; ends that are themselves inside are left
  function repairLine(pts, C, thr = 0.1) {
    const dense = [];
    for (let i = 0; i < pts.length; i++) {
      const sgs = [i > 0 ? [pts[i - 1], pts[i]] : null, i + 1 < pts.length ? [pts[i], pts[i + 1]] : null].filter(Boolean);        // a vertex belongs to both of its segments
      dense.push({ p: pts[i], v: i, sgs });
      if (i + 1 < pts.length) { const a = pts[i], b = pts[i + 1], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25); for (let k = 1; k < n; k++) dense.push({ p: [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], v: -1, sgs: [[a, b]] }); }
    }
    const bad = dense.map(d => !!C.insideAny(d.p, d.sgs, thr)); if (!bad.some(Boolean)) return { out: null, fixed: 0, failed: 0 };
    const inAny = dense.map(d => !!C.insideAny(d.p, [], thr));                         // inside a carriageway, crossing or not
    const runs = [];
    for (let j = 0; j < dense.length; j++) if (bad[j] && (j === 0 || !bad[j - 1])) {
      let a = j, e = j; while (e + 1 < dense.length && bad[e + 1]) e++;
      while (a - 1 >= 0 && inAny[a - 1]) a--; while (e + 1 < dense.length && inAny[e + 1]) e++;     // a run starts and ends clear of the road
      const last = runs[runs.length - 1]; if (last && a <= last.j1 + 1) last.j1 = Math.max(last.j1, e); else runs.push({ j0: a, j1: e, bj: j });
      j = e;
    }
    let fixed = 0, failed = 0;
    for (let ri = 0; ri < runs.length; ri++) {
      const r = runs[ri], lo = ri ? runs[ri - 1].j1 + 1 : 0, hi = ri + 1 < runs.length ? runs[ri + 1].j0 - 1 : dense.length - 1;   // a stretch never reaches into its neighbours
      if (r.j0 === 0 || r.j1 === dense.length - 1) { failed++; continue; }
      let E = dense[r.j0 - 1].p, X = dense[r.j1 + 1].p;
      // the street the run crosses: of every street the stretch is inside, the one it changes side of (at a junction the stretch is often inside the
      // side street too, which it does not cross; testing only the first street found sent the repair looking for a detour that stays on one side
      // of a road the run has to cross, and it gave up)
      const inside = new Set(); for (let j = r.j0; j <= r.j1; j++) for (const s2 of C.S) if (C.dist(s2, dense[j].p) < s2.cw / 2 - thr) inside.add(s2);
      const first = C.insideAny(dense[r.bj].p, dense[r.bj].sgs, thr), st = [...inside].find(s2 => Math.sign(PL_project(s2, E)) !== Math.sign(PL_project(s2, X))) || first;
      let path = null;
      if (st && !st.fill && Math.sign(PL_project(st, E)) !== Math.sign(PL_project(st, X))) {            // the run changes side of this street: a square crossing, clear of the junction, then on to X
        // the crossing goes at E's station, or the nearest station (up to 25 m either way) where it is clear of every other carriageway: at a junction
        // E's station is often in the mouth of the side street, and a crossing there, square to this street, runs along inside the other one
        const off = st.cw / 2 + 0.4, s0 = project(st, E[0], E[1]).s, sg = PL_project(st, E) >= 0 ? 1 : -1;
        const clear = sq => { const a = ptAt(st, sq, sg * off).slice(0, 2), b = ptAt(st, sq, -sg * off).slice(0, 2), n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25); for (let k = 0; k <= n; k++) if (C.insideAny([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], [[a, b]], thr)) return false; return true; };
        // of the clear stations, the one that makes the run shortest (E to the near end, across, the far end to X)
        let sE = s0;
        if (!clear(s0)) {
          const cost = sq => { const a = ptAt(st, sq, sg * off), b = ptAt(st, sq, -sg * off); return Math.hypot(a[0] - E[0], a[1] - E[1]) + Math.hypot(X[0] - b[0], X[1] - b[1]); };
          let best = null; for (let d = -25; d <= 25; d += 0.5) { const q = s0 + d; if (q < 0 || q > st.len || !clear(q)) continue; const c = cost(q); if (!best || c < best.c) best = { q, c }; }
          if (best) sE = best.q;
        }
        const near = ptAt(st, sE, sg * off).slice(0, 2), far = ptAt(st, sE, -sg * off).slice(0, 2);
        // into and out of the crossing: straight from the run's own vertex before (and to the one after) when that line is clear, so the run
        // does not step to the kerb and back (the detour search keeps 0.5 m off the kerb and left a hook there once the corners were rounded)
        const clearSeg = (p, q) => { const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.25)); for (let k = 0; k <= n; k++) if (C.insideAny([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n], [[p, q]], thr)) return false; return true; };
        let jv = r.j0 - 1; while (jv > lo && dense[jv].v < 0) jv--;
        if (jv < r.j0 - 1 && dense[jv].v >= 0 && clearSeg(dense[jv].p, near)) { r.j0 = jv + 1; E = dense[jv].p; }
        let kv = r.j1 + 1; while (kv < hi && dense[kv].v < 0) kv++;
        if (kv > r.j1 + 1 && dense[kv].v >= 0 && clearSeg(far, dense[kv].p)) { r.j1 = kv - 1; X = dense[kv].p; }
        const straight = (p, q) => clearSeg(p, q) ? [p.slice(), q.slice()] : routeAround(p, q, C);
        const a = straight(E, near), b = straight(far, X);
        if (a && b) path = a.slice(1).concat(b.slice(0, -1)); else if (!a && !b) path = [near, far]; else path = (a ? a.slice(1) : [near]).concat(b ? b.slice(0, -1) : [far]);
        path = path.filter(q => q !== X); r.cross = true;
      } else path = (routeAround(E, X, C) || [null, null]);
      if (path && path.length && path[0] !== null) { r.path = r.cross ? path : path.slice(1, -1); fixed++; } else failed++;
    }
    if (!fixed) return { out: null, fixed, failed };
    const out = [], skip = new Set(), eAt = new Map(), xAt = new Set();
    runs.forEach(r => { if (r.path) { for (let j = r.j0; j <= r.j1; j++) skip.add(j); eAt.set(r.j0 - 1, r); xAt.add(r.j1 + 1); } });
    for (let j = 0; j < dense.length; j++) {
      if (skip.has(j)) continue;
      if (dense[j].v >= 0 || eAt.has(j) || xAt.has(j)) out.push(dense[j].p);
      if (eAt.has(j)) eAt.get(j).path.forEach(q => out.push(q));
    }
    return { out, fixed, failed };
  }
  function keepOut(res) {
    if (res && res.route === 'blocks') { res.keepOut = { fixed: 0, failed: 0 }; return res; }       // routed along the erf boundaries: nothing is in a road but the crossings
    const C = carriage(res && res.streets); if (!C) return res;
    const seen = new Set(); let fixed = 0, failed = 0;
    const go = pts => { if (!Array.isArray(pts) || pts.length < 2 || seen.has(pts)) return; seen.add(pts); const r = repairLine(pts, C); fixed += r.fixed; failed += r.failed; if (r.out) pts.splice(0, pts.length, ...r.out); };
    res.erven.forEach(e => { go(e.route); go(e.duct); });
    if (res.net) { (res.net.lv || []).forEach(ed => go(ed.pts)); (res.net.lvLinks || []).forEach(l => go(l.pts)); (res.net.mv || []).forEach(ed => go(ed.pts)); }
    if (res.fibre) (res.fibre.trunks || []).concat(res.fibre.spare || []).forEach(e => go(e.pts));
    res.keepOut = { fixed, failed }; if (fixed) relength(res);
    return res;
  }
  // the stretches of a run that still lie inside a carriageway (outside a square crossing), each a list of points 0.25 m apart. Detection only,
  // no routing: cheap enough for the Checks list, and what its Show draws
  function stretches(pts, C, thr) {
    const out = []; let cur = null;
    const at = (q, sgs) => { if (C.insideAny(q, sgs, thr)) { if (!cur) out.push(cur = []); cur.push(q); } else cur = null; };
    for (let i = 0; i < pts.length; i++) {
      at(pts[i], [i > 0 ? [pts[i - 1], pts[i]] : null, i + 1 < pts.length ? [pts[i], pts[i + 1]] : null].filter(Boolean));
      if (i + 1 < pts.length) { const a = pts[i], b = pts[i + 1], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25); for (let k = 1; k < n; k++) at([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], [[a, b]]); }
    }
    return out;
  }
  // every run still inside a carriageway: { kind, id, bad: [stretch, …] }
  function carriageHits(res, depth) {
    if (res && res.route === 'blocks') return [];                                    // the carriageway is only known from the street line, which this routing does not trust
    const C = carriage(res && res.streets, true); if (!C) return [];
    const thr = depth == null ? 0.8 : depth, out = [], one = (kind, id, pts) => { if (!Array.isArray(pts) || pts.length < 2) return; const bad = stretches(pts, C, thr); if (bad.length) out.push({ kind, id, bad }); };
    res.erven.forEach(e => { one('service', e.id, e.route); one('fibre duct', e.id, e.duct); });
    if (res.net) (res.net.lv || []).forEach((ed, i) => one('LV cable', i, ed.pts)); if (res.fibre) (res.fibre.trunks || []).concat(res.fibre.spare || []).forEach((e, i) => one('fibre trunk', i, e.pts));
    return out;
  }

  // ── smooth corners ──
  // fillet(pts, R): every interior corner is replaced by a circular arc of radius R tangent to both legs (the arc is cut back so it never
  // takes more than half of either leg: a corner too tight for R gets the largest arc that fits). The ends stay where they are; the points
  // are replaced in place so the array keeps its identity. A turn under ~2 degrees is left alone.
  function fillet(pts, R0, bad) {
    if (!(R0 > 0) || !Array.isArray(pts) || pts.length < 3) return pts;
    const P = [pts[0]]; for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - P[P.length - 1][0], pts[i][1] - P[P.length - 1][1]) > 1e-6) P.push(pts[i]);
    if (P.length < 3) return pts;
    const out = [P[0]];
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1];
      const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const u1 = [(a[0] - b[0]) / l1, (a[1] - b[1]) / l1], u2 = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
      const cosPhi = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])), phi = Math.acos(cosPhi), theta = Math.PI - phi;
      if (theta < 0.035 || phi < 0.02) { out.push(b); continue; }
      const half = Math.tan(phi / 2);
      let arc = null;
      for (let R = R0, tries = 0; tries < 4 && !arc; tries++, R /= 2) {                  // a curve that would dip into a carriageway is made tighter, then left sharp
        let t = R / half; t = Math.min(t, (i === 1 ? l1 : l1 / 2), (i === P.length - 2 ? l2 : l2 / 2));
        const Re = t * half, T1 = [b[0] + u1[0] * t, b[1] + u1[1] * t], T2 = [b[0] + u2[0] * t, b[1] + u2[1] * t];
        const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = Math.hypot(bx, by) || 1, d = Re / Math.sin(phi / 2), C = [b[0] + bx / bl * d, b[1] + by / bl * d];
        const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]); let dl = Math.atan2(T2[1] - C[1], T2[0] - C[0]) - a1; while (dl > Math.PI) dl -= 2 * Math.PI; while (dl < -Math.PI) dl += 2 * Math.PI;
        const n = Math.max(2, Math.ceil(Math.abs(dl) / (Math.PI / 12))), cand = [];
        for (let k = 0; k <= n; k++) { const an = a1 + dl * k / n; cand.push([C[0] + Re * Math.cos(an), C[1] + Re * Math.sin(an)]); }
        // tested against the arc's own chords: the corner's legs may be a square crossing, which the arc no longer is where it cuts the corner
        const pts2 = [a, ...cand, c];
        if (!bad || !cand.some((q, k) => bad(q, [pts2[k], q], [q, pts2[k + 2]]))) arc = cand;
      }
      if (arc) out.push(...arc); else out.push(b);
    }
    out.push(P[P.length - 1]);
    pts.splice(0, pts.length, ...out);
    return pts;
  }
  // every length that follows from the lines (after a node was moved, or the corners were rounded)
  function relength(r) {
    if (!r) return;
    r.erven.forEach(e => { if (e.route) e.cable = plen(e.route); if (e.duct) e.ductLen = plen(e.duct); });
    if (r.net) { (r.net.lvLinks || []).forEach(l => { l.len = plen(l.pts); }); (r.net.lv || []).forEach(ed => { ed.len = plen(ed.pts); }); r.net.lvLen = (r.net.lv || []).reduce((t, ed) => t + ed.len, 0); (r.net.mv || []).forEach(ed => { ed.len = plen(ed.pts); }); r.net.mvLen = (r.net.mv || []).reduce((t, ed) => t + (ed.len || 0), 0); }
    const F = r.fibre;
    if (F) {
      const edges = (F.trunks || []).concat(F.spare || []); edges.forEach(e => { e.len = plen(e.pts); });
      F.trunkLen = (F.trunks || []).reduce((t, e) => t + e.len, 0); F.maxGap = Math.max(0, ...edges.map(e => e.len));
      const ds = r.erven.filter(e => e.duct).map(e => e.ductLen); F.leadLen = ds.reduce((t, x) => t + x, 0); F.leadMax = Math.max(0, ...ds);
    }
    const cab = r.erven.filter(e => e.cable).map(e => e.cable);
    r.over = r.erven.filter(e => e.cable > r.P.maxc + 1e-6);
    if (r.stats) {
      r.stats.cable = cab.reduce((t, c) => t + c, 0); r.stats.cableMax = Math.max(0, ...cab); r.stats.over = r.over.length;
      if (r.net) { r.stats.lv = r.net.lvLen; r.stats.mv = r.net.mvLen; } if (F) { r.stats.trunk = F.trunkLen; r.stats.leads = F.leadLen; }
    }
  }
  // round the corners of every run in a result: fibre by `bendFi`, LV and service by `bendLv`, MV by `bendMv` (metres, 0 = sharp), then the lengths follow
  function smooth(r, P) {
    if (!r) return r; const q = Object.assign({}, DEFAULTS, P || r.P || {}), seen = new Set(), C = r.route === 'blocks' ? null : carriage(r.streets || []), bad = C ? (pt, s1, s2) => !!C.insideAny(pt, [s1, s2], 0.1) : null, go = (pts, R) => { if (Array.isArray(pts) && !seen.has(pts)) { seen.add(pts); fillet(pts, R, bad); } };
    r.erven.forEach(e => { go(e.route, q.bendLv); go(e.duct, q.bendFi); });
    if (r.net) { (r.net.lv || []).forEach(ed => go(ed.pts, q.bendLv)); (r.net.lvLinks || []).forEach(l => go(l.pts, q.bendLv)); (r.net.mv || []).forEach(ed => go(ed.pts, q.bendMv)); }
    if (r.fibre) (r.fibre.trunks || []).concat(r.fibre.spare || []).forEach(e => go(e.pts, q.bendFi));
    relength(r); return r;
  }

  // the two ends of a shared crossing as the trench draws them (kerb side to kerb side, or boundary to boundary)
  function crossEnds(x) {
    if (x.a && x.b) { const pa = project(x.st, x.a[0], x.a[1]), pb = project(x.st, x.b[0], x.b[1]); return { a: x.a.slice(0, 2), b: x.b.slice(0, 2), hA: pa.d, hB: pb.d }; }   // a crossing site: ring to ring
    const bnd = x.st.byBoundary && typeof x.st.fd === 'function', hA = bnd ? x.st.fd(1, x.s) : x.st.w / 2, hB = bnd ? x.st.fd(-1, x.s) : x.st.w / 2;
    return { a: ptAt(x.st, x.s, hA).slice(0, 2), b: ptAt(x.st, x.s, -hB).slice(0, 2), hA, hB };
  }
  return { reach, solve, trenches, demandInput, TRENCH_DEFAULTS, DEFAULTS, fillDepth, kerbFills, ptAt, project, verge, plen, fillet, relength, smooth, crossEnds, keepOut, carriage, carriageHits, routeAround };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanLayout;
