/**
 * PlanKerbs — streets from kerb lines (pure geometry in metres, node-testable: testing/unit/kerbs.test.js).
 *
 * A survey DXF usually shows two kerb lines per road, not a centreline. This turns them into the one
 * centreline per street that Auto layout (plan-layout.js) needs, with the real carriageway width:
 *
 *   joinPieces  loose LINE / polyline pieces whose ends meet (5 cm) -> kerb chains
 *   solve       sample every chain each `step` m; a sample pairs with the nearest point of another chain
 *               when that point is `wmin`..`wmax` away, runs parallel and sits straight across (a chain
 *               also pairs with itself: the two arms of a cul-de-sac). A pair of chains is a road when
 *               they run side by side over `cover` of the shorter one (or over one stretch >= `minStreet`);
 *               the midline of each stretch is a centreline piece, the distances are its width.
 *               Pieces that continue across a junction mouth are bridged (collinear ends closer than
 *               `gap` + the road width); an end that stops short of another street is run on to its
 *               centreline (T / cross junction: the hit point becomes a vertex of both streets, so the LV
 *               and fibre networks are continuous); a cul-de-sac end runs on to the bulb centre
 *               (circle fitted to the kerb arc); a lone round kerb is joined to the nearest street.
 *   pairManual  the review step's Shift-click: two chosen chains -> one street.
 *   extend      run the ends of one street on to the others (used for a street added by hand).
 *
 * Chains are { pts:[[x,y],...], closed? }. Streets come back as { pts, w, chains:[i,...] }.
 */
const PlanKerbs = (() => {
  const D = { wmin: 4, wmax: 20, cover: 0.6, minStreet: 20, minRun: 6, gap: 15, step: 1, tol: 0.05, par: 0.35, oneW: 6, join: 40 };
  const opt = o => Object.assign({}, D, o || {});
  const hyp = Math.hypot, dot = (a, b) => a[0] * b[0] + a[1] * b[1], cr = (a, b) => a[0] * b[1] - a[1] * b[0];
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  const plen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };

  // unit direction leaving the chain at its start / end, read over ~3 m
  function endDir(pts, atEnd) {
    const n = pts.length, tip = atEnd ? pts[n - 1] : pts[0];
    let far = atEnd ? pts[0] : pts[n - 1];
    for (let k = 1; k < n; k++) { const q = atEnd ? pts[n - 1 - k] : pts[k]; if (hyp(tip[0] - q[0], tip[1] - q[1]) >= 3) { far = q; break; } }
    const d = hyp(tip[0] - far[0], tip[1] - far[1]) || 1;
    return [(tip[0] - far[0]) / d, (tip[1] - far[1]) / d];
  }
  // direction a piece continues in from the end that is being joined (end 0 = its first point)
  function dirIn(pts, e) {
    const n = pts.length, tip = e ? pts[n - 1] : pts[0];
    let far = e ? pts[0] : pts[n - 1];
    for (let k = 1; k < n; k++) { const q = e ? pts[n - 1 - k] : pts[k]; if (hyp(tip[0] - q[0], tip[1] - q[1]) >= 0.5) { far = q; break; } }
    const d = hyp(far[0] - tip[0], far[1] - tip[1]) || 1;
    return [(far[0] - tip[0]) / d, (far[1] - tip[1]) / d];
  }

  // ───────── 1. loose pieces -> kerb chains ─────────
  function joinPieces(pieces, tol) {
    tol = tol || D.tol;
    const P = pieces.filter(p => p && p.length > 1).map(p => p.slice());
    const used = new Array(P.length).fill(false), cell = Math.max(tol * 2, 1e-9);
    const key = (cx, cy) => cx + ',' + cy, ends = new Map();
    P.forEach((p, i) => { for (const e of [0, 1]) { const q = e ? p[p.length - 1] : p[0], k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell)); if (!ends.has(k)) ends.set(k, []); ends.get(k).push([i, e]); } });
    const near = pt => {
      const out = [], cx = Math.floor(pt[0] / cell), cy = Math.floor(pt[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [i, e] of ends.get(key(cx + dx, cy + dy)) || []) {
        if (used[i]) continue; const q = e ? P[i][P[i].length - 1] : P[i][0];
        if (hyp(q[0] - pt[0], q[1] - pt[1]) <= tol) out.push([i, e]);
      }
      return out;
    };
    const out = [];
    for (let s = 0; s < P.length; s++) {
      if (used[s]) continue; used[s] = true;
      let pts = P[s].slice(), bounds = [0, pts.length - 1];                                                              // vertex indices where one drawn piece ends and the next begins
      for (let side = 0; side < 2; side++) {
        for (;;) {
          const tip = side === 0 ? pts[pts.length - 1] : pts[0], dout = endDir(pts, side === 0);
          let best = null, bs = -2;
          for (const [i, e] of near(tip)) { const sc = dot(dout, dirIn(P[i], e)); if (sc > bs) { bs = sc; best = [i, e]; } }   // straightest way on at a junction
          if (!best) break;
          used[best[0]] = true;
          const seg = P[best[0]].slice(); if (best[1] === 1) seg.reverse();                                                   // starts at the joined end
          if (side === 0) { pts = pts.concat(seg.slice(1)); bounds.push(pts.length - 1); }
          else { const add = seg.length - 1; pts = seg.reverse().slice(0, -1).concat(pts); bounds = [0].concat(bounds.map(b => b + add)); }
        }
      }
      const f = pts[0], l = pts[pts.length - 1], cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const parts = []; for (let b = 0; b + 1 < bounds.length; b++) parts.push({ s0: cum[bounds[b]], s1: cum[bounds[b + 1]] });
      out.push({ pts, closed: pts.length > 3 && hyp(f[0] - l[0], f[1] - l[1]) <= tol * 2, parts });
    }
    return out;
  }

  // ───────── geometry helpers ─────────
  function resample(pts, step) {
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum[cum.length - 1], n = Math.max(1, Math.round(len / step)), S = [];
    let j = 0;
    for (let k = 0; k <= n; k++) {
      const s = len * k / n; while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const seg = (cum[j + 1] - cum[j]) || 1e-12, t = Math.max(0, Math.min(1, (s - cum[j]) / seg));
      S.push({ x: pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, y: pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t, tx: (pts[j + 1][0] - pts[j][0]) / seg, ty: (pts[j + 1][1] - pts[j][1]) / seg, s });
    }
    return { S, len, box: bbox(pts) };
  }
  function bbox(pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; } return [a, b, c, d]; }
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1;
      const dx = pts[b][0] - pts[a][0], dy = pts[b][1] - pts[a][1], L = hyp(dx, dy) || 1e-12;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - pts[a][0]) * dy - (pts[i][1] - pts[a][1]) * dx) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = true; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function fitCircle(pts) {                                                  // algebraic (Kåsa) least squares
    if (pts.length < 5) return null;
    let sx = 0, sy = 0; for (const p of pts) { sx += p[0]; sy += p[1]; } sx /= pts.length; sy /= pts.length;
    let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const p of pts) { const u = p[0] - sx, v = p[1] - sy; suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
    const det = suu * svv - suv * suv; if (Math.abs(det) < 1e-9) return null;
    const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2, uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
    const cx = sx + uc, cy = sy + vc; let r = 0; for (const p of pts) r += hyp(p[0] - cx, p[1] - cy); r /= pts.length;
    let e = 0; for (const p of pts) e += (hyp(p[0] - cx, p[1] - cy) - r) ** 2;
    return { cx, cy, r, rmse: Math.sqrt(e / pts.length) };
  }

  // ───────── 2. which sample pairs with what ─────────
  // For every sample of every chain: the nearest point on another chain (or its own other arm) that is a road-width
  // away, parallel and straight across.
  function assign(R, C, o) {
    const out = R.map(() => []);
    R.forEach((ri, i) => {
      const ci = C[i], ring = !!ci.closed;
      ri.S.forEach((p, k) => {
        let best = null;
        for (let j = 0; j < R.length; j++) {
          const rj = R[j], bx = rj.box; if (C[j].skip || ci.skip) continue;
          if (p.x < bx[0] - o.wmax || p.x > bx[2] + o.wmax || p.y < bx[1] - o.wmax || p.y > bx[3] + o.wmax) continue;
          // the nearest sample of this chain that is a road-width away, parallel and straight across (not just the nearest
          // sample: near the end of a road that is the end cap, closer than any road is wide)
          let m = -1, md = Infinity;
          for (let q = 0; q < rj.S.length; q++) {
            const Q = rj.S[q], d = hyp(Q.x - p.x, Q.y - p.y);
            if (d >= md || d < o.wmin || d > o.wmax || (best && d >= best.d)) continue;
            if (j === i) { let ds = Math.abs(Q.s - p.s); if (ring) ds = Math.min(ds, ri.len - ds); if (ds <= 1.3 * d) continue; if (!(Q.s > p.s)) continue; }   // a chain with itself: the first arm only
            const u = [(Q.x - p.x) / d, (Q.y - p.y) / d];
            if (Math.abs(p.tx * Q.ty - p.ty * Q.tx) > o.par || Math.abs(u[0] * p.tx + u[1] * p.ty) > o.par) continue;
            md = d; m = q;
          }
          if (m < 0) continue;
          const Q = rj.S[m];
          best = { j, m, d: md, qx: Q.x, qy: Q.y, qs: Q.s };
        }
        out[i][k] = best;
      });
    });
    return out;
  }

  // stretches of consecutive samples of chain i that pair with chain j
  function runs(R, A, i, j, o) {
    const S = R[i].S, list = [];
    for (let k = 0; k < S.length; k++) if (A[i][k] && A[i][k].j === j) list.push(k);
    const out = []; let cur = null;
    for (const k of list) {
      const a = A[i][k];
      if (cur && k - cur.k1 <= 3 && Math.abs(a.qs - cur.qs) <= 8 + 3 * (k - cur.k1) && Math.abs(a.d - cur.d) <= 0.6 * (k - cur.k1)) { cur.k1 = k; cur.qs = a.qs; cur.d = a.d; cur.ks.push(k); }   // a width that jumps is another road (the end cap's sides)
      else { if (cur) out.push(cur); cur = { i, j, k0: k, k1: k, qs: a.qs, d: a.d, ks: [k] }; }
    }
    if (cur) out.push(cur);
    const res = [];
    for (const r of out) {
      // a fillet bends the kerb away: take off the ends where the width is changing fast (a taper changes it slowly and stays)
      const dd = k => A[i][k].d, steep = (k, k2) => Math.abs(dd(k) - dd(k2)) > 0.25 * Math.abs(k2 - k);
      while (r.ks.length > 2 && steep(r.ks[0], r.ks[1])) r.ks.shift();
      while (r.ks.length > 2 && steep(r.ks[r.ks.length - 1], r.ks[r.ks.length - 2])) r.ks.pop();
      r.k0 = r.ks[0]; r.k1 = r.ks[r.ks.length - 1];
      const len = S[r.k1].s - S[r.k0].s; if (len < o.minRun) continue;
      const mids = [], ws = [];
      for (const k of r.ks) { const p = S[k], a = A[i][k]; mids.push([(p.x + a.qx) / 2, (p.y + a.qy) / 2]); ws.push(a.d); }
      const qss = r.ks.map(k => A[i][k].qs);
      res.push({ i, j, k0: r.k0, k1: r.k1, len, mids, ws, last: A[i][r.k1], s0: S[r.k0].s, s1: S[r.k1].s, q0: Math.min(...qss), q1: Math.max(...qss) });
    }
    return res;
  }

  // ───────── 3. pieces: bridge, snap, bulbs ─────────
  function minDistToPieces(pieces, skip, pt) {
    let best = Infinity;
    pieces.forEach((B, b) => { if (b === skip) return; for (let i = 0; i + 1 < B.pts.length; i++) best = Math.min(best, segDist(pt, B.pts[i], B.pts[i + 1])); });
    return best;
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return hyp(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  }
  const wOf = P => P.w || median(P.ws) || 12;
  function mergeSpans(a, b) { const m = {}; for (const x of [a, b]) for (const k in x || {}) m[k] = (m[k] || []).concat(x[k]); return m; }

  // pieces that run on from each other across a junction mouth become one street
  function bridge(pieces, o) {
    for (;;) {
      let best = null;
      for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++) for (const ea of [0, 1]) for (const eb of [0, 1]) {
        const A = pieces[a], B = pieces[b], pa = ea ? A.pts[A.pts.length - 1] : A.pts[0], pb = eb ? B.pts[B.pts.length - 1] : B.pts[0];
        const d = hyp(pb[0] - pa[0], pb[1] - pa[1]), wa = wOf(A), wb = wOf(B);
        if (d > o.gap + Math.max(wa, wb) || (best && d >= best.d)) continue;
        const da = endDir(A.pts, ea === 1), db = endDir(B.pts, eb === 1);
        if (dot(da, db) > -0.9) continue;
        if (d > 1) { const u = [(pb[0] - pa[0]) / d, (pb[1] - pa[1]) / d]; if (dot(u, da) < 0.85 || dot(u, db) > -0.85) continue; }
        if (wa / wb < 0.6 || wa / wb > 1.67) continue;
        best = { a, b, ea, eb, d };
      }
      if (!best) return;
      const A = pieces[best.a], B = pieces[best.b];
      const pa = best.ea ? A.pts : A.pts.slice().reverse(), pb = best.eb ? B.pts.slice().reverse() : B.pts;
      const m = { pts: pa.concat(pb), ws: A.ws.concat(B.ws), chains: [...new Set(A.chains.concat(B.chains))], bulbs: (A.bulbs || []).concat(B.bulbs || []), spans: mergeSpans(A.spans, B.spans) };
      pieces.splice(best.b, 1); pieces[best.a] = m;
    }
  }

  // an end that stops short of another street runs on to its centreline (the hit becomes a vertex of both)
  function extend(pieces, idxs, o) {
    for (const a of idxs) {
      const A = pieces[a]; if (!A) continue;
      for (const atEnd of [false, true]) {
        const tip = atEnd ? A.pts[A.pts.length - 1] : A.pts[0];
        if ((A.bulbs || []).some(b => hyp(b[0] - tip[0], b[1] - tip[1]) < 0.05)) continue;      // the bulb centre is where it ends
        if (minDistToPieces(pieces, a, tip) <= 1.5) continue;                                     // already on a street
        const dir = endDir(A.pts, atEnd);
        let hit = null;
        pieces.forEach((B, b) => {
          if (b === a) return; const lim = o.gap + wOf(B) / 2;
          for (let i = 0; i + 1 < B.pts.length; i++) {
            const q0 = B.pts[i], q1 = B.pts[i + 1], e = [q1[0] - q0[0], q1[1] - q0[1]], den = cr(dir, e); if (Math.abs(den) < 1e-9) continue;
            const w = [q0[0] - tip[0], q0[1] - tip[1]], t = cr(w, e) / den, u = cr(w, dir) / den, el = hyp(e[0], e[1]) || 1;
            if (t < 0 || t > lim || u < 0 || u > 1 || Math.abs(den) / el < 0.5) continue;
            if (!hit || t < hit.t) hit = { t, b, i, pt: [tip[0] + dir[0] * t, tip[1] + dir[1] * t] };
          }
        });
        if (!hit) {                                                                              // no clean crossing: the nearest street ahead within the bridge gap (not just the road width)
          let bd = Math.max(o.gap, wOf(A));
          pieces.forEach((B, b) => {
            if (b === a) return;
            for (let i = 0; i + 1 < B.pts.length; i++) {
              const q0 = B.pts[i], q1 = B.pts[i + 1], dx = q1[0] - q0[0], dy = q1[1] - q0[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((tip[0] - q0[0]) * dx + (tip[1] - q0[1]) * dy) / L2)) : 0;
              const x = q0[0] + dx * t, y = q0[1] + dy * t, d = hyp(x - tip[0], y - tip[1]);
              if (d >= bd) continue;
              if (d > 1 && ((x - tip[0]) * dir[0] + (y - tip[1]) * dir[1]) / d < 0.3) continue;   // behind or beside the end: not where this street was going
              bd = d; hit = { t: d, b, i, pt: [x, y] };
            }
          });
        }
        if (!hit) continue;
        const B = pieces[hit.b]; let pt = hit.pt;
        const v0 = B.pts[hit.i], v1 = B.pts[hit.i + 1];
        if (hyp(pt[0] - v0[0], pt[1] - v0[1]) < 0.3) pt = v0.slice(); else if (hyp(pt[0] - v1[0], pt[1] - v1[1]) < 0.3) pt = v1.slice(); else B.pts.splice(hit.i + 1, 0, pt);
        if (atEnd) A.pts.push(pt); else A.pts.unshift(pt);
      }
    }
  }

  // ───────── solve = candidates + assemble ─────────
  // candidates: every street the chains can make, before any junction work (the part a click choice does not change).
  // Each piece carries `spans` = {chain: [[s0, s1], ...]}, the stretches of each kerb chain it was made from.
  function candidates(chains, o) {
    o = opt(o);
    const C = chains.map(c => ({ pts: c.pts, closed: !!c.closed }));
    const R = C.map(c => resample(c.pts, o.step));
    const bulbRings = [];
    C.forEach((c, i) => {                                                  // a lone round kerb (cul-de-sac bulb, island) is not a road side
      if (!c.closed) return; const f = fitCircle(R[i].S.map(s => [s.x, s.y]));
      if (f && f.r >= 3 && f.r <= 25 && f.rmse <= 0.08 * f.r && Math.abs(R[i].len - 2 * Math.PI * f.r) <= 0.15 * R[i].len) { c.skip = true; bulbRings.push({ i, c: [f.cx, f.cy], r: f.r }); }
    });
    const A = assign(R, C, o), paired = new Set(), pieces = [];
    for (let i = 0; i < C.length; i++) {
      if (C[i].skip) continue;
      const js = new Set(); A[i].forEach(a => { if (a) js.add(a.j); });
      for (const j of js) {
        if (j === i) {                                                      // the two arms of one chain (cul-de-sac): the arm 1 stretch
          const rs = runs(R, A, i, i, o), cov = rs.reduce((t, r) => t + r.len, 0), cap = median(rs.flatMap(r => r.ws)), arm = Math.max(R[i].len / 2 - cap, o.minRun);   // one arm = half the chain less the end cap
          if (!rs.length || !(cov >= o.cover * arm || Math.max(...rs.map(r => r.len)) >= o.minStreet)) continue;
          paired.add(i);
          for (const r of rs) {
            const piece = { pts: simplify(r.mids, 0.15), ws: r.ws, chains: [i], bulbs: [], spans: { [i]: [[r.s0, r.s1], [r.q0, r.q1]] } };
            // the end near the bulb: fit the kerb arc between the last pair
            const a = r.last, S = R[i].S, arc = []; for (let k = 0; k < S.length; k++) if (S[k].s >= S[r.k1].s && S[k].s <= a.qs) arc.push([S[k].x, S[k].y]);
            const f = fitCircle(arc);
            if (f && f.r >= o.wmin / 2 && f.r <= 25 && f.rmse <= 0.15 * f.r) { piece.pts.push([f.cx, f.cy]); piece.bulbs.push([f.cx, f.cy]); }
            pieces.push(piece);
          }
          continue;
        }
        if (!shorter(R, i, j) && A[j].some(a => a && a.j === i)) continue;                   // taken from the shorter chain's side
        const rs = runs(R, A, i, j, o), cov = rs.reduce((t, r) => t + r.len, 0), L = Math.min(R[i].len, R[j].len);
        if (!rs.length || !(cov >= o.cover * L || Math.max(...rs.map(r => r.len)) >= o.minStreet)) continue;
        paired.add(i); paired.add(j);
        for (const r of rs) pieces.push({ pts: simplify(r.mids, 0.15), ws: r.ws, chains: [i, j], bulbs: [], spans: { [i]: [[r.s0, r.s1]], [j]: [[r.q0, r.q1]] } });
      }
    }
    bridge(pieces, o);
    const unpaired = []; C.forEach((c, i) => { if (!paired.has(i) && R[i].len >= 3) unpaired.push(i); });
    return { pieces, rings: bulbRings, paired, unpaired, chains: C };
  }

  // assemble: the streets for the chosen pieces (`ids` = 'all' or a set of piece indices) plus hand-made ones (`extras`):
  // ends run on to the chosen streets only, round kerbs (`rings` = 'all' or a set of chain indices) are joined to the nearest one.
  function assemble(cands, ids, extras, o, rings, noConnect) {
    o = opt(o);
    const sel = ids === 'all' ? cands.pieces.map((_, k) => k) : [...ids].sort((a, b) => a - b);
    const pieces = sel.map(k => { const P = cands.pieces[k]; return { pts: P.pts.map(p => p.slice()), ws: P.ws, w: P.w, chains: P.chains, bulbs: P.bulbs || [], spans: P.spans }; });
    const n = pieces.length;
    extend(pieces, pieces.map((_, k) => k), o);
    const ex = (extras || []).map(x => ({ pts: x.pts.map(p => p.slice()), ws: [x.w], w: x.w, chains: x.chains || [], bulbs: [], extra: x }));
    ex.forEach(e => pieces.push(e));
    if (ex.length) extend(pieces, ex.map((_, k) => n + k), o);
    const streets = [];
    for (const P of pieces) if (P.extra || plen(P.pts) >= 5 || (P.bulbs && P.bulbs.length)) {
      const st = { pts: P.pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]), w: +wOf(P).toFixed(1), chains: P.chains, spans: P.spans || {} };
      if (P.extra) { st.src = 'extra'; if (P.extra.one) st.one = true; }
      streets.push(st);
    }
    // round kerbs: centre joined to the nearest street
    const live = streets.map(s => ({ pts: s.pts, w: s.w, ws: [s.w], chains: s.chains, bulbs: [] }));
    for (const b of cands.rings) {
      if (rings !== 'all' && !(rings && rings.has(b.i))) continue;
      let bd = b.r + o.gap + 5, hit = null;
      live.forEach((B, k) => { for (let i = 0; i + 1 < B.pts.length; i++) { const d = segDist(b.c, B.pts[i], B.pts[i + 1]); if (d < bd) { bd = d; hit = { k, i }; } } });
      if (!hit) continue;
      const B = live[hit.k], q0 = B.pts[hit.i], q1 = B.pts[hit.i + 1], dx = q1[0] - q0[0], dy = q1[1] - q0[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((b.c[0] - q0[0]) * dx + (b.c[1] - q0[1]) * dy) / L2)) : 0;
      let pt = [q0[0] + dx * t, q0[1] + dy * t];
      if (hyp(pt[0] - q0[0], pt[1] - q0[1]) < 0.3) pt = q0.slice(); else if (hyp(pt[0] - q1[0], pt[1] - q1[1]) < 0.3) pt = q1.slice(); else B.pts.splice(hit.i + 1, 0, pt);
      streets.push({ pts: [pt.map(v => +v.toFixed(3)), b.c.map(v => +v.toFixed(3))], w: B.w, chains: [b.i], spans: { [b.i]: [[0, Infinity]] }, bulb: true });
    }
    // re-read the vertex inserted into a street by a later snap
    streets.forEach((s, k) => { if (live[k]) s.pts = live[k].pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]); });
    if (!noConnect) connect(streets, o.gap);                              // separate networks within the bridge gap become one
    return { streets };
  }

  function solve(chains, o) {
    const c = candidates(chains, o), r = assemble(c, 'all', [], o, 'all');
    return { streets: r.streets, unpaired: c.unpaired, chains: c.chains };
  }
  const shorter = (R, i, j) => R[i].len < R[j].len || (R[i].len === R[j].len && i < j);

  // the share of kerb length that has a road-width, parallel partner (a layer of kerbs, not centrelines)
  function pairedShare(chains, o) {
    o = opt(Object.assign({ step: 3 }, o));
    const C = chains.map(c => ({ pts: c.pts, closed: !!c.closed })), R = C.map(c => resample(c.pts, o.step));
    if (!R.length) return 0;
    const A = assign(R, C, o); let n = 0, m = 0;
    A.forEach(a => a.forEach(x => { n++; if (x) m++; }));
    return n ? m / n : 0;
  }

  // the review step's Shift-click: two chosen chains -> one street (no cover rule: the user said so)
  function pairManual(chains, i, j, o) {
    o = opt(o); o.wmax *= 1.5;
    const C = [chains[i], chains[j]].map(c => ({ pts: c.pts, closed: !!c.closed })), R = C.map(c => resample(c.pts, o.step));
    const A = assign(R, C, o), s = shorter(R, 0, 1) ? 0 : 1;
    const rs = runs(R, A, s, 1 - s, { minRun: 3 });
    if (!rs.length) return null;
    rs.sort((a, b) => b.len - a.len);
    const P = { pts: simplify(rs[0].mids, 0.15), ws: rs[0].ws, chains: [i, j], bulbs: [] };
    return { pts: P.pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]), w: +wOf(P).toFixed(1), chains: [i, j] };
  }

  // run the ends of streets[idx] on to the other streets (a street added by hand); streets are changed in place
  function attach(streets, idx, o) {
    o = opt(o);
    const pieces = streets.map(s => ({ pts: s.pts.map(p => p.slice()), ws: [s.w], w: s.w, chains: s.chains || [], bulbs: [] }));
    extend(pieces, [idx], o);
    pieces.forEach((P, k) => { streets[k].pts = P.pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]); });
  }


  // ───────── one network ─────────
  const segSegDist = (a, b, c, d) => {
    const o1 = cr([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]), o2 = cr([b[0] - a[0], b[1] - a[1]], [d[0] - a[0], d[1] - a[1]]);
    const o3 = cr([d[0] - c[0], d[1] - c[1]], [a[0] - c[0], a[1] - c[1]]), o4 = cr([d[0] - c[0], d[1] - c[1]], [b[0] - c[0], b[1] - c[1]]);
    if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
    return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
  };
  function polyDist(A, B) {
    let m = Infinity;
    for (let i = 0; i + 1 < A.length; i++) for (let j = 0; j + 1 < B.length; j++) { const d = segSegDist(A[i], A[i + 1], B[j], B[j + 1]); if (d < m) m = d; if (!m) return 0; }
    return m;
  }
  // Groups of streets that touch or cross (an end within `tol` m of another street, as Auto layout reads a junction).
  // Returns arrays of street indices, the largest group first.
  function components(streets, tol) {
    tol = tol == null ? 3 : tol;
    const n = streets.length, par = streets.map((_, i) => i), bb = streets.map(s => bbox(s.pts));
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const a = bb[i], b = bb[j]; if (a[0] > b[2] + tol || b[0] > a[2] + tol || a[1] > b[3] + tol || b[1] > a[3] + tol) continue;
      if (polyDist(streets[i].pts, streets[j].pts) <= tol) par[find(i)] = find(j);
    }
    const g = new Map(); for (let i = 0; i < n; i++) { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); }
    return [...g.values()].sort((x, y) => y.length - x.length);
  }
  // Join separate networks: the closest street end to another network's street, while that is within `maxGap` m.
  // Streets change in place; returns the number of joins made.
  function connect(streets, maxGap) {
    let made = 0;
    for (let guard = 0; guard < 200; guard++) {
      const comps = components(streets); if (comps.length < 2) break;
      const of = new Map(); comps.forEach((c, k) => c.forEach(i => of.set(i, k)));
      let best = null;
      streets.forEach((A, a) => {
        for (const atEnd of [false, true]) {
          const tip = atEnd ? A.pts[A.pts.length - 1] : A.pts[0];
          streets.forEach((B, b) => {
            if (of.get(a) === of.get(b)) return;
            for (let i = 0; i + 1 < B.pts.length; i++) {
              const d = segDist(tip, B.pts[i], B.pts[i + 1]);
              if (d <= maxGap && (!best || d < best.d)) best = { d, a, atEnd, b, i };
            }
          });
        }
      });
      if (!best) break;
      const A = streets[best.a], B = streets[best.b], tip = best.atEnd ? A.pts[A.pts.length - 1] : A.pts[0], q0 = B.pts[best.i], q1 = B.pts[best.i + 1];
      const dx = q1[0] - q0[0], dy = q1[1] - q0[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((tip[0] - q0[0]) * dx + (tip[1] - q0[1]) * dy) / L2)) : 0;
      let pt = [q0[0] + dx * t, q0[1] + dy * t];
      if (hyp(pt[0] - q0[0], pt[1] - q0[1]) < 3) pt = q0.slice(); else if (hyp(pt[0] - q1[0], pt[1] - q1[1]) < 3) pt = q1.slice(); else B.pts.splice(best.i + 1, 0, pt);
      pt = [+pt[0].toFixed(3), +pt[1].toFixed(3)];
      if (best.atEnd) A.pts.push(pt); else A.pts.unshift(pt);
      made++;
    }
    return made;
  }

  // A road with a kerb on one side only: its centreline half a width in from that kerb, on the side of `side` (a point).
  function offsetOne(chain, side, w, o) {
    o = opt(o); const R = resample(chain.pts, o.step);
    let bi = 0, bd = Infinity; R.S.forEach((p, k) => { const d = hyp(p.x - side[0], p.y - side[1]); if (d < bd) { bd = d; bi = k; } });
    const t = R.S[bi], sg = cr([t.tx, t.ty], [side[0] - t.x, side[1] - t.y]) >= 0 ? 1 : -1;
    const pts = R.S.map(p => [p.x - sg * p.ty * w / 2, p.y + sg * p.tx * w / 2]);
    return { pts: simplify(pts, 0.15).map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]), w: +w.toFixed(1), chains: [], one: true };
  }

  // The two kerb lines of a street, read back from the drawn kerbs: at every 2 m of the centreline the nearest kerb point
  // straight across on each side (left, then right, looking along the street). A side with no kerb there (a junction mouth,
  // a stub run on to another street) is mirrored from the other side, or set half the street's width out. Road plan roads
  // keep the kerb width profile through these two lines.
  function sides(street, chains, o) {
    o = opt(o);
    const R = resample(street.pts, 2), cs = chains.map(c => resample(c.pts, 1)), half = (street.w || 10) / 2, lo = 0.4 * half, hi = 1.6 * half + 1;
    const A = [], B = [];
    for (const p of R.S) {
      let l = null, r = null;
      for (const c of cs) {
        const bx = c.box; if (p.x < bx[0] - hi || p.x > bx[2] + hi || p.y < bx[1] - hi || p.y > bx[3] + hi) continue;
        for (const q of c.S) {
          const dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy); if (d > hi || d < lo) continue;
          if (Math.abs(dx * p.tx + dy * p.ty) > 0.35 * d) continue;                      // straight across only
          if (p.tx * dy - p.ty * dx > 0) { if (!l || d < l.d) l = { d, x: q.x, y: q.y }; } else if (!r || d < r.d) r = { d, x: q.x, y: q.y };
        }
      }
      const nl = [p.x - p.ty * half, p.y + p.tx * half], nr = [p.x + p.ty * half, p.y - p.tx * half];
      const L = l ? [l.x, l.y] : r ? [2 * p.x - r.x, 2 * p.y - r.y] : nl, Rr = r ? [r.x, r.y] : l ? [2 * p.x - l.x, 2 * p.y - l.y] : nr;
      A.push(L); B.push(Rr);
    }
    const fix = a => simplify(a, 0.1).map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]);
    return { a: fix(A), b: fix(B) };
  }

  // ───────── the review step, without a screen: streets chosen by clicking kerb lines ─────────
  // The state both review UIs (Auto layout, Road plan) drive. `layers` = { key: chains } (chains from joinPieces, with `parts`).
  // The streets are a fold over a list of picks, so Backspace is `undo()` and a changed option replays the same picks:
  //   { op: 'add' | 'sub', items: [{ layer, chain, span: [s0, s1] | null }], onlyExtras? }   a kerb line (or one drawn piece of it)
  //   { op: 'all', layer }                          every street of a layer (Pair all)
  //   { op: 'pair', layer, a, b }                   two kerbs by hand
  //   { op: 'one', layer, chain, side: [x, y] }     a street beside a lone kerb
  // A kerb clicked that no street can be made from is `lonely` (no partner).
  const overlapOK = (ivs, span) => {
    if (!span) return true;
    let ov = 0; for (const [a, b] of ivs || []) ov += Math.max(0, Math.min(b, span[1]) - Math.max(a, span[0]));
    return ov >= Math.min(5, 0.5 * (span[1] - span[0])) - 1e-9;
  };
  function stage(layers, o) {
    const T = {
      o: opt(o), layers, mode: 'add', picks: [], streets: [], lonely: [], one: null, pairFrom: null, anyLayer: false, sig: '',
      _cache: new Map(), _join: 0, _pools: new Map(), _bb: new Map(),
      keys() { return Object.keys(T.layers); },
      _pool(layer) {                                                        // the chains a click looks for partners in: its own layer, or all
        if (!T.anyLayer) return { key: layer, chains: T.layers[layer] || [], off: 0, layers: [layer] };
        const off = {}, chains = []; let n = 0;
        for (const k of T.keys()) { off[k] = n; n += T.layers[k].length; chains.push(...T.layers[k]); }
        return { key: '*', chains, off: 0, offs: off, layers: T.keys() };
      },
      _g(P, layer, chain) { return P.offs ? P.offs[layer] + chain : chain; },
      _back(P, g) { if (!P.offs) return { layer: P.key, chain: g }; let best = null; for (const k of P.layers) if (P.offs[k] <= g && (!best || P.offs[k] >= P.offs[best])) best = k; return { layer: best, chain: g - P.offs[best] }; },
      _cand(P) {
        const key = P.key + '|' + P.chains.length;
        if (!T._cache.has(key)) T._cache.set(key, candidates(P.chains, T.o));
        return T._cache.get(key);
      },
      fold() {
        const per = new Map(), lonely = new Map(), S = k => { if (!per.has(k)) per.set(k, { chosen: new Set(), extras: [], rings: new Set() }); return per.get(k); };
        const pools = new Map(), lk = (l, c) => l + '\u0000' + c;
        for (const p of T.picks) {
          if (p.op === 'all') {
            const P = T._pool(p.layer); pools.set(P.key, P); const c = T._cand(P), st = S(P.key), lo = P.offs ? P.offs[p.layer] : 0, hi = lo + T.layers[p.layer].length;
            c.pieces.forEach((pc, k) => { if (pc.chains.every(g => g >= lo && g < hi)) st.chosen.add(k); });
            c.rings.forEach(r => { if (r.i >= lo && r.i < hi) st.rings.add(r.i); });
            for (const g of c.unpaired) if (g >= lo && g < hi) lonely.set(lk(p.layer, g - lo), { layer: p.layer, chain: g - lo });
          } else if (p.op === 'add' || p.op === 'sub') {
            for (const it of p.items) {
              const P = T._pool(it.layer); if (!T.layers[it.layer] || !T.layers[it.layer][it.chain]) continue;
              pools.set(P.key, P); const c = T._cand(P), st = S(P.key), g = T._g(P, it.layer, it.chain), key = lk(it.layer, it.chain);
              const m = p.onlyExtras ? [] : c.pieces.map((pc, k) => (pc.chains.includes(g) && overlapOK(pc.spans[g], it.span)) ? k : -1).filter(k => k >= 0);
              const ring = c.rings.some(r => r.i === g);
              if (p.op === 'add') {
                if (ring) st.rings.add(g);
                if (m.length) { m.forEach(k => st.chosen.add(k)); lonely.delete(key); }
                else if (!ring && !st.extras.some(e => e.chains.includes(g))) lonely.set(key, { layer: it.layer, chain: it.chain });
              } else {
                m.forEach(k => st.chosen.delete(k)); if (!it.span || p.onlyExtras) { st.rings.delete(g); st.extras = st.extras.filter(e => !e.chains.includes(g)); }
                if (!it.span) lonely.delete(key);
              }
            }
          } else if (p.op === 'pair') {
            const P = T._pool(p.layer), g1 = T._g(P, p.layer, p.a), g2 = T._g(P, p.layer2 || p.layer, p.b), st = pairManual(P.chains, g1, g2, T.o);
            if (!st) continue; pools.set(P.key, P); S(P.key).extras.push(st); lonely.delete(lk(p.layer, p.a)); lonely.delete(lk(p.layer2 || p.layer, p.b));
          } else if (p.op === 'one') {
            const P = T._pool(p.layer), g = T._g(P, p.layer, p.chain); pools.set(P.key, P);
            const st = offsetOne(P.chains[g], p.side, T.o.oneW); st.chains = [g]; S(P.key).extras.push(st); lonely.delete(lk(p.layer, p.chain));
          }
        }
        const streets = [], sig = [];
        for (const [key, st] of per) {
          const P = pools.get(key), c = T._cand(P), r = assemble(c, st.chosen, st.extras, T.o, st.rings, true);
          r.streets.forEach(x => { x.layer = key; streets.push(x); });
          sig.push(key, [...st.chosen].sort((a, b) => a - b).join(','), [...st.rings].sort().join(','), st.extras.length);
        }
        connect(streets, T.o.gap); if (T._join) T._join_made = connect(streets, T._join);
        T.used = new Set(); for (const x of streets) { const P = pools.get(x.layer); for (const g of x.chains || []) { const b = T._back(P, g); T.used.add(b.layer + '\u0000' + b.chain); } }
        T.streets = streets; T.lonely = [...lonely.values()]; T.sig = sig.join('|') + '#' + [...lonely.keys()].sort().join(',');
        T._pools = pools; return T;
      },
      _push(pick) {
        const sig0 = T.sig, n0 = T.streets.length, l0 = T.lonely.length;
        T.picks.push(pick); T.fold();
        if (T.sig === sig0) { T.picks.pop(); return { noop: true, added: 0, removed: 0, lonely: 0 }; }
        return { noop: false, added: Math.max(0, T.streets.length - n0), removed: Math.max(0, n0 - T.streets.length), lonely: T.lonely.length - l0 };
      },
      // a click on a kerb line (span null = the whole joined line, [s0, s1] = one drawn piece); op defaults to the mode
      addChain(layer, chain, span, op) { T.one = null; T.pairFrom = null; return T._push({ op: op || T.mode, items: [{ layer, chain, span: span || null }] }); },
      pairAll(layer) { T.one = null; T.pairFrom = null; return T._push({ op: 'all', layer }); },
      // subtract by clicking a street rather than a kerb: take out every stretch of kerb it was made from
      subStreet(i) {
        const st = T.streets[i]; if (!st) return null; const P = T._pools.get(st.layer); if (!P) return null;
        if (st.src === 'extra') return T._push({ op: 'sub', onlyExtras: true, items: st.chains.map(g => Object.assign(T._back(P, g), { span: null })) });
        const items = []; for (const g of st.chains) { const b = T._back(P, g), iv = (st.spans || {})[g] || []; if (iv.some(x => x[1] === Infinity)) items.push({ ...b, span: null }); else for (const x of iv) items.push({ ...b, span: x }); }
        return T._push({ op: 'sub', items });
      },
      // two kerbs by hand: armPair(layer, chain) then pairWith(layer, chain) ('added' | 'noroad' | 'cancel' | 'layer')
      armPair(layer, chain) { T.pairFrom = { layer, chain }; T.one = null; },
      pairWith(layer, chain) {
        const f = T.pairFrom; T.pairFrom = null; if (!f) return 'cancel';
        if (f.layer === layer && f.chain === chain) return 'cancel';
        if (f.layer !== layer && !T.anyLayer) return 'layer';
        const P = T._pool(f.layer); if (!pairManual(P.chains, T._g(P, f.layer, f.chain), T._g(P, layer, chain), T.o)) return 'noroad';
        T.picks.push({ op: 'pair', layer: f.layer, a: f.chain, b: chain, layer2: layer }); T.fold(); return 'added';
      },
      arm(layer, chain) { T.one = { layer, chain }; T.pairFrom = null; },
      place(pt) {                                                           // the click after arm(): its side of the lone kerb is where the road goes
        if (!T.one) return false; const f = T.one; T.one = null;
        T.picks.push({ op: 'one', layer: f.layer, chain: f.chain, side: pt }); T.fold(); return true;
      },
      undo() { if (!T.picks.length) return false; T.picks.pop(); T.one = null; T.pairFrom = null; T.fold(); return true; },
      removePick(i) { if (i < 0 || i >= T.picks.length) return false; T.picks.splice(i, 1); T.fold(); return true; },
      setOpt(o2) { T.o = Object.assign({}, T.o, o2 || {}); T._cache.clear(); return T.fold(); },
      setAnyLayer(v) { T.anyLayer = !!v; T._cache.clear(); return T.fold(); },
      // the layers changed (hidden, working area, scale): replace them and keep the picks whose chain still exists; returns how many were dropped
      setLayers(layers2) {
        T.layers = layers2; T._cache.clear(); T._bb.clear();
        const has = (l, c) => !!(T.layers[l] && T.layers[l][c]), n0 = T.picks.length;
        T.picks = T.picks.filter(p => {
          if (p.op === 'all') return !!T.layers[p.layer];
          if (p.items) { p.items = p.items.filter(it => has(it.layer, it.chain)); return p.items.length > 0; }
          if (p.op === 'pair') return has(p.layer, p.a) && has(p.layer2 || p.layer, p.b);
          return has(p.layer, p.chain);
        });
        T.dropped = n0 - T.picks.length; T.one = T.pairFrom = null; return T.fold();
      },
      join(maxGap) { T._join = maxGap == null ? T.o.join : maxGap; T._join_made = 0; T.fold(); return T._join_made; },
      networks() { return components(T.streets); },
      _near(pts, pt) { let b = Infinity; for (let i = 0; i + 1 < pts.length; i++) b = Math.min(b, segDist(pt, pts[i], pts[i + 1])); return b; },
      streetAt(pt, tol) { let bi = -1, bd = tol; T.streets.forEach((x, i) => { const d = T._near(x.pts, pt); if (d < bd) { bd = d; bi = i; } }); return bi; },
      // the kerb line under a point, over every layer: { layer, chain, s (arc length at the point), part: [s0, s1] of the drawn piece | null, d }
      hitAt(pt, tol) {
        let best = null;
        for (const layer of T.keys()) T.layers[layer].forEach((c, i) => {
          const id = layer + '\u0000' + i; let bb = T._bb.get(id); if (!bb) { bb = bbox(c.pts); T._bb.set(id, bb); }
          if (pt[0] < bb[0] - tol || pt[0] > bb[2] + tol || pt[1] < bb[1] - tol || pt[1] > bb[3] + tol) return;
          let acc = 0;
          for (let k = 0; k + 1 < c.pts.length; k++) {
            const a = c.pts[k], b = c.pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2)) : 0;
            const d = hyp(pt[0] - a[0] - dx * t, pt[1] - a[1] - dy * t), len = Math.sqrt(L2);
            if (d < tol && (!best || d < best.d)) best = { layer, chain: i, d, s: acc + len * t };
            acc += len;
          }
        });
        if (best) { const c = T.layers[best.layer][best.chain]; best.part = null; for (const p of c.parts || []) if (best.s >= p.s0 - 1e-6 && best.s <= p.s1 + 1e-6) { best.part = [p.s0, p.s1]; break; } }
        return best;
      },
      chainsOf(street) { const P = T._pools.get(street.layer); return P ? P.chains : []; },
      info(layer, i) { const c = T.layers[layer][i], mid = c.pts[Math.floor(c.pts.length / 2)]; return { layer, i, len: plen(c.pts), at: [mid[0], mid[1]] }; },
    };
    return T.fold();
  }

  return { D, sides, stage, joinPieces, solve, candidates, assemble, pairedShare, pairManual, attach, fitCircle, resample, components, connect, offsetOne };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanKerbs;
