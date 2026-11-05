/* ProtectionPro — Plan Markup one-click room detection.
 *
 * Click inside a room and get its boundary polygon. Two sources:
 *   • vector — wall segments from a DXF underlay (fromSegments). The segments
 *     become a planar graph: endpoints are merged, door gaps are bridged,
 *     crossings are split, dead ends pruned, and the face the click lands in
 *     is walked. Exact vertices, no pixel error.
 *   • raster — a rendered image or PDF plan (fromRaster). Dark pixels are
 *     walls; they are thickened by half the door gap so openings seal, the
 *     free space is flood-filled from the click, grown back to the wall face
 *     and traced to a simplified polygon.
 *
 * All geometry here is pure (arrays in, arrays out, one unit throughout) so it
 * can be tested without a browser; PlanRoomDetect.detectAt() is the plan glue.
 * Detection never guesses: a click that is not inside a closed region returns
 * { ok:false, reason } and the caller says why.
 */

const PlanRoomDetect = {
  settings: { gapM: 1.2, maxAreaM2: 5000, wallLayers: null },

  // ───────────────────────── vector (DXF walls) ─────────────────────────

  /**
   * @param segs  [[x1,y1,x2,y2], …] wall segments (one unit, y any direction)
   * @param click [x,y]
   * @param opts  { gap, maxArea, tol }  gap = door opening to bridge (units)
   * @returns { ok:true, points:[[x,y]…], area, bridged } | { ok:false, reason }
   */
  fromSegments(segs, click, opts) {
    const o = Object.assign({ gap: 1.2, maxArea: Infinity, tol: 0.01 }, opts || {});
    const g = this._buildGraph(segs, o);
    if (!g.edges.length) return { ok: false, reason: 'no-walls' };
    let removed = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const hit = this._nearestRayEdge(g, click);
      if (!hit) return { ok: false, reason: removed ? 'not-enclosed' : 'not-enclosed' };
      const he = this._halfEdgeLeftOf(g, hit.edge, click);
      const ring = this._walkFace(g, he);
      const area = this._signedArea(ring.map(i => g.verts[i]));
      const pts = ring.map(i => g.verts[i]);
      if (area > 1e-9 && this._pip(click, pts)) {
        if (area > o.maxArea) return { ok: false, reason: 'too-large', area };
        return { ok: true, points: this._dropCollinear(pts, o.tol), area, bridged: g.bridged };
      }
      // The nearest edge belongs to something around or inside the click's
      // face but not bounding it (an island, or the outside of the plan):
      // drop that connected piece and look again.
      this._removeComponent(g, hit.edge);
      removed++;
    }
    return { ok: false, reason: 'not-enclosed' };
  },

  _buildGraph(segs, o) {
    const tol = o.tol;
    // 1. split every segment at every crossing/touch with another one.
    let S = segs.map(s => [s[0], s[1], s[2], s[3]]).filter(s => Math.hypot(s[2] - s[0], s[3] - s[1]) > tol * 0.1);
    if (o.snap > tol) S = this._snapEnds(S, o.snap);
    // 2. close door gaps first, on the raw segments (needs the dangling ends).
    const bridges = this._bridgeGaps(S, o.gap, tol);
    const all = S.concat(bridges);
    const split = this._splitAtCrossings(all, tol);
    // 3. vertices + undirected edges
    const verts = [], vmap = new Map();
    const key = (x, y) => Math.round(x / tol) + ',' + Math.round(y / tol);
    const vid = (x, y) => {
      const k = key(x, y);
      let id = vmap.get(k);
      if (id === undefined) { id = verts.length; verts.push([x, y]); vmap.set(k, id); }
      return id;
    };
    const eset = new Set(), edges = [];
    for (const s of split) {
      const a = vid(s[0], s[1]), b = vid(s[2], s[3]);
      if (a === b) continue;
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (eset.has(k)) continue;
      eset.add(k); edges.push([a, b]);
    }
    const g = { verts, edges, alive: edges.map(() => true), adj: null, bridged: bridges.length };
    this._pruneDeadEnds(g);
    this._buildAdj(g);
    return g;
  },

  // Drawn "shared" edges are rarely exact: the end of one erf's side lies a few
  // mm off the neighbour's side. Merge ends within `snap` of each other, then
  // lay each end that sits within `snap` of another segment's span onto it, so
  // the two edges become one and the faces beside them close.
  _snapEnds(S, snap) {
    const cell = Math.max(snap * 4, 1e-6), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    // 1. cluster ends (union by grid neighbourhood), move each to the cluster mean
    const pts = []; S.forEach((s, i) => { pts.push([i, 0]); pts.push([i, 2]); });
    const par = pts.map((_, i) => i), find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const grid = new Map();
    pts.forEach(([i, o], k) => { const kk = key(S[i][o], S[i][o + 1]); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k); });
    pts.forEach(([i, o], k) => {
      const x = S[i][o], y = S[i][o + 1], cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let a = cx - 1; a <= cx + 1; a++) for (let b = cy - 1; b <= cy + 1; b++)
        for (const m of (grid.get(a + ',' + b) || [])) {
          if (m <= k) continue;
          const [j, q] = pts[m];
          if (Math.hypot(S[j][q] - x, S[j][q + 1] - y) <= snap) par[find(m)] = find(k);
        }
    });
    const sum = new Map();
    pts.forEach(([i, o], k) => { const r = find(k), v = sum.get(r) || [0, 0, 0]; v[0] += S[i][o]; v[1] += S[i][o + 1]; v[2]++; sum.set(r, v); });
    const T = S.map(s => s.slice());
    pts.forEach(([i, o], k) => { const v = sum.get(find(k)); if (v[2] > 1) { T[i][o] = v[0] / v[2]; T[i][o + 1] = v[1] / v[2]; } });
    // 2. ends onto the interior of a nearby segment
    let tot = 0; for (const s of T) tot += Math.hypot(s[2] - s[0], s[3] - s[1]);
    const c2 = Math.max(tot / Math.max(T.length, 1) * 2, snap * 10, 1e-6), g2 = new Map();
    T.forEach((s, i) => {
      for (let a = Math.floor(Math.min(s[0], s[2]) / c2); a <= Math.floor(Math.max(s[0], s[2]) / c2); a++)
        for (let b = Math.floor(Math.min(s[1], s[3]) / c2); b <= Math.floor(Math.max(s[1], s[3]) / c2); b++) {
          const k = a + ',' + b; if (!g2.has(k)) g2.set(k, []); g2.get(k).push(i);
        }
    });
    const out = T.map(s => s.slice());
    T.forEach((s, i) => {
      for (const o of [0, 2]) {
        const x = s[o], y = s[o + 1];
        let best = null, bd = snap;
        for (const j of (g2.get(Math.floor(x / c2) + ',' + Math.floor(y / c2)) || [])) {
          if (j === i) continue;
          const u = T[j], dx = u[2] - u[0], dy = u[3] - u[1], L2 = dx * dx + dy * dy;
          const t = ((x - u[0]) * dx + (y - u[1]) * dy) / L2;
          if (t * Math.sqrt(L2) <= snap || (1 - t) * Math.sqrt(L2) <= snap) continue;   // near an end: the cluster step owns it
          const px = u[0] + t * dx, py = u[1] + t * dy, d = Math.hypot(px - x, py - y);
          if (d < bd && d > 1e-9) { bd = d; best = [px, py]; }
        }
        if (best) { out[i][o] = best[0]; out[i][o + 1] = best[1]; }
      }
    });
    return out;
  },

  _buildAdj(g) {
    const adj = g.verts.map(() => []);
    g.edges.forEach((e, i) => {
      if (!g.alive[i]) return;
      adj[e[0]].push(e[1]); adj[e[1]].push(e[0]);
    });
    for (let v = 0; v < adj.length; v++) {
      const [vx, vy] = g.verts[v];
      adj[v].sort((p, q) => Math.atan2(g.verts[p][1] - vy, g.verts[p][0] - vx) - Math.atan2(g.verts[q][1] - vy, g.verts[q][0] - vx));
    }
    g.adj = adj;
  },

  _pruneDeadEnds(g) {
    const deg = g.verts.map(() => 0);
    g.edges.forEach((e, i) => { if (g.alive[i]) { deg[e[0]]++; deg[e[1]]++; } });
    const inc = g.verts.map(() => []);
    g.edges.forEach((e, i) => { inc[e[0]].push(i); inc[e[1]].push(i); });
    const stack = [];
    deg.forEach((d, v) => { if (d === 1) stack.push(v); });
    while (stack.length) {
      const v = stack.pop();
      if (deg[v] !== 1) continue;
      for (const i of inc[v]) {
        if (!g.alive[i]) continue;
        g.alive[i] = false;
        const e = g.edges[i], w = e[0] === v ? e[1] : e[0];
        deg[v]--; deg[w]--;
        if (deg[w] === 1) stack.push(w);
      }
    }
  },

  // Bridge each dangling endpoint to the nearest other endpoint, or the
  // nearest point on another segment, within `gap`. Door openings are wall
  // end to wall end; a wall stopping short of a perpendicular wall is the
  // second case.
  _bridgeGaps(S, gap, tol) {
    if (!(gap > 0)) return [];
    const q = (x, y) => Math.round(x / tol) + ',' + Math.round(y / tol);
    const count = new Map();
    for (const s of S) for (const k of [q(s[0], s[1]), q(s[2], s[3])]) count.set(k, (count.get(k) || 0) + 1);
    // a vertex touching the middle of another segment is not dangling
    const onSeg = (px, py, s) => {
      const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
      const t = ((px - s[0]) * dx + (py - s[1]) * dy) / L2;
      if (t <= 1e-9 || t >= 1 - 1e-9) return false;
      return Math.hypot(s[0] + t * dx - px, s[1] + t * dy - py) <= tol;
    };
    const dang = [];
    S.forEach((s, si) => {
      [[s[0], s[1]], [s[2], s[3]]].forEach(([x, y]) => {
        if (count.get(q(x, y)) !== 1) return;
        for (let j = 0; j < S.length; j++) if (j !== si && onSeg(x, y, S[j])) return;
        dang.push({ x, y, si });
      });
    });
    const cell = Math.max(gap, 1e-6);
    const grid = new Map();
    const gk = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    S.forEach((s, i) => {
      const x0 = Math.min(s[0], s[2]) - gap, x1 = Math.max(s[0], s[2]) + gap;
      const y0 = Math.min(s[1], s[3]) - gap, y1 = Math.max(s[1], s[3]) + gap;
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const k = cx + ',' + cy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
    });
    const out = [], done = new Set();
    for (const d of dang) {
      const cand = grid.get(gk(d.x, d.y)) || [];
      let best = null, bd = gap + 1e-9;
      for (const j of cand) {
        if (j === d.si) continue;
        const s = S[j];
        // nearest point on segment j
        const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
        let t = ((d.x - s[0]) * dx + (d.y - s[1]) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = s[0] + t * dx, py = s[1] + t * dy;
        const dist = Math.hypot(px - d.x, py - d.y);
        if (dist < bd && dist > tol) { bd = dist; best = [px, py]; }
      }
      if (best) {
        const k = q(d.x, d.y) + '|' + q(best[0], best[1]);
        const k2 = q(best[0], best[1]) + '|' + q(d.x, d.y);
        if (done.has(k) || done.has(k2)) continue;
        done.add(k);
        out.push([d.x, d.y, best[0], best[1]]);
      }
    }
    return out;
  },

  // Split segments wherever another passes through or crosses them.
  _splitAtCrossings(S, tol) {
    const n = S.length;
    const ts = S.map(() => [0, 1]);
    // uniform grid over segment bboxes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, tot = 0;
    for (const s of S) {
      minX = Math.min(minX, s[0], s[2]); maxX = Math.max(maxX, s[0], s[2]);
      minY = Math.min(minY, s[1], s[3]); maxY = Math.max(maxY, s[1], s[3]);
      tot += Math.hypot(s[2] - s[0], s[3] - s[1]);
    }
    const cell = Math.max(tot / Math.max(n, 1) * 2, tol * 10, 1e-6);
    const grid = new Map();
    S.forEach((s, i) => {
      for (let cx = Math.floor(Math.min(s[0], s[2]) / cell); cx <= Math.floor(Math.max(s[0], s[2]) / cell); cx++)
        for (let cy = Math.floor(Math.min(s[1], s[3]) / cell); cy <= Math.floor(Math.max(s[1], s[3]) / cell); cy++) {
          const k = cx + ',' + cy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
    });
    const seen = new Set();
    for (const list of grid.values()) {
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const i = list[a], j = list[b];
        const pk = i < j ? i * n + j : j * n + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        this._intersect(S, ts, i, j, tol);
      }
    }
    const out = [];
    S.forEach((s, i) => {
      const t = ts[i].sort((p, q) => p - q);
      const dx = s[2] - s[0], dy = s[3] - s[1], L = Math.hypot(dx, dy);
      for (let k = 0; k + 1 < t.length; k++) {
        if ((t[k + 1] - t[k]) * L <= tol * 0.5) continue;
        out.push([s[0] + dx * t[k], s[1] + dy * t[k], s[0] + dx * t[k + 1], s[1] + dy * t[k + 1]]);
      }
    });
    return out;
  },

  _intersect(S, ts, i, j, tol) {
    const a = S[i], b = S[j];
    const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1];
    const den = rx * sy - ry * sx;
    const La = Math.hypot(rx, ry), Lb = Math.hypot(sx, sy);
    if (Math.abs(den) < 1e-12 * La * Lb) {
      // parallel: split at the other's endpoints when collinear and overlapping
      const dist = Math.abs(((b[0] - a[0]) * ry - (b[1] - a[1]) * rx) / La);
      if (dist > tol) return;
      const proj = (x, y, s, L, ox, oy, dx, dy) => ((x - ox) * dx + (y - oy) * dy) / (L * L);
      for (const [x, y] of [[b[0], b[1]], [b[2], b[3]]]) {
        const t = proj(x, y, a, La, a[0], a[1], rx, ry);
        if (t > tol / La && t < 1 - tol / La) ts[i].push(t);
      }
      for (const [x, y] of [[a[0], a[1]], [a[2], a[3]]]) {
        const t = proj(x, y, b, Lb, b[0], b[1], sx, sy);
        if (t > tol / Lb && t < 1 - tol / Lb) ts[j].push(t);
      }
      return;
    }
    const qx = b[0] - a[0], qy = b[1] - a[1];
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    const ea = tol / La, eb = tol / Lb;
    if (t < -ea || t > 1 + ea || u < -eb || u > 1 + eb) return;
    if (t > ea && t < 1 - ea) ts[i].push(t);
    if (u > eb && u < 1 - eb) ts[j].push(u);
  },

  _nearestRayEdge(g, p) {
    let best = null, bx = Infinity;
    g.edges.forEach((e, i) => {
      if (!g.alive[i]) return;
      const a = g.verts[e[0]], b = g.verts[e[1]];
      if ((a[1] <= p[1]) === (b[1] <= p[1])) return;
      const x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x > p[0] && x < bx) { bx = x; best = { edge: i, x }; }
    });
    return best;
  },

  _halfEdgeLeftOf(g, ei, p) {
    const [a, b] = g.edges[ei];
    const A = g.verts[a], B = g.verts[b];
    const cr = (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    return cr > 0 ? [a, b] : [b, a];
  },

  // Walk the face on the left of half-edge [u,v].
  _walkFace(g, start) {
    const ring = [];
    let [u, v] = start;
    for (let guard = 0; guard < 100000; guard++) {
      ring.push(u);
      const out = g.adj[v];
      const ti = out.indexOf(u);
      const next = out[(ti - 1 + out.length) % out.length];
      u = v; v = next;
      if (u === start[0] && v === start[1]) break;
    }
    return ring;
  },

  _removeComponent(g, ei) {
    const seen = new Set([g.edges[ei][0], g.edges[ei][1]]);
    const stack = [g.edges[ei][0], g.edges[ei][1]];
    while (stack.length) {
      const v = stack.pop();
      for (const w of g.adj[v]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    g.edges.forEach((e, i) => { if (seen.has(e[0])) g.alive[i] = false; });
    this._buildAdj(g);
  },

  // ───────────────────────── raster (image / PDF plan) ─────────────────────────

  /**
   * @param img   { w, h, data:Uint8ClampedArray RGBA } the rendered plan window
   * @param click [px,py] in image pixels
   * @param opts  { gapPx, dark (0-255 luminance threshold), maxAreaPx }
   * @returns { ok:true, points:[[x,y]…] (pixels), areaPx } | { ok:false, reason }
   */
  fromRaster(img, click, opts) {
    const o = Object.assign({ gapPx: 6, dark: 140, maxAreaPx: Infinity, simplifyPx: 1.5 }, opts || {});
    const { w, h, data } = img;
    const wall = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const a = data[i * 4 + 3];
      const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      wall[i] = (a > 40 && lum < o.dark) ? 1 : 0;
    }
    const cx = Math.round(click[0]), cy = Math.round(click[1]);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return { ok: false, reason: 'outside' };
    if (wall[cy * w + cx]) return { ok: false, reason: 'on-wall' };
    const r = Math.max(0, Math.round(o.gapPx / 2));
    const thick = r > 0 ? this._dilate(wall, w, h, r) : wall;
    if (thick[cy * w + cx]) return { ok: false, reason: 'on-wall' };
    // flood the free space
    const fill = new Uint8Array(w * h);
    const stack = [cy * w + cx];
    fill[cy * w + cx] = 1;
    let leak = false, count = 0;
    while (stack.length) {
      const p = stack.pop(); count++;
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) leak = true;
      if (x > 0 && !fill[p - 1] && !thick[p - 1]) { fill[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !fill[p + 1] && !thick[p + 1]) { fill[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !fill[p - w] && !thick[p - w]) { fill[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !fill[p + w] && !thick[p + w]) { fill[p + w] = 1; stack.push(p + w); }
    }
    if (leak) return { ok: false, reason: 'not-enclosed' };
    // grow back to the wall face, never into a wall
    let region = r > 0 ? this._dilate(fill, w, h, r) : fill;
    for (let i = 0; i < w * h; i++) if (wall[i]) region[i] = 0;
    // keep only the piece containing the click (door-gap bridges can pinch)
    region = this._component(region, w, h, cy * w + cx);
    const ring = this._traceOuter(region, w, h);
    if (!ring || ring.length < 3) return { ok: false, reason: 'no-contour' };
    const simp = this._simplifyClosed(ring, o.simplifyPx);
    const area = Math.abs(this._signedArea(simp));
    if (area > o.maxAreaPx) return { ok: false, reason: 'too-large', area };
    return { ok: true, points: this._dropCollinear(simp, 0.5), areaPx: area };
  },

  // square-kernel dilation by r (separable)
  _dilate(src, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let last = -1e9;
      const row = y * w;
      // forward + backward distance to nearest set pixel in the row
      const dist = new Int32Array(w).fill(1e9);
      for (let x = 0; x < w; x++) { if (src[row + x]) last = x; dist[x] = x - last; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (src[row + x]) last = x; dist[x] = Math.min(dist[x], last - x); tmp[row + x] = dist[x] <= r ? 1 : 0; }
    }
    for (let x = 0; x < w; x++) {
      const dist = new Int32Array(h);
      let last = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; dist[y] = y - last; }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; dist[y] = Math.min(dist[y], last - y); out[y * w + x] = dist[y] <= r ? 1 : 0; }
    }
    return out;
  },

  _component(mask, w, h, seed) {
    const out = new Uint8Array(w * h);
    if (!mask[seed]) return out;
    const stack = [seed]; out[seed] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w;
      if (x > 0 && mask[p - 1] && !out[p - 1]) { out[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !out[p + 1]) { out[p + 1] = 1; stack.push(p + 1); }
      if (p >= w && mask[p - w] && !out[p - w]) { out[p - w] = 1; stack.push(p - w); }
      if (p < w * (h - 1) && mask[p + w] && !out[p + w]) { out[p + w] = 1; stack.push(p + w); }
    }
    return out;
  },

  // Outer boundary of the (single) region as pixel-corner vertices.
  _traceOuter(m, w, h) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && m[y * w + x]) ? 1 : 0;
    // start: top-left-most set pixel
    let sx = -1, sy = -1;
    outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { sx = x; sy = y; break outer; }
    if (sx < 0) return null;
    // Walk the boundary along pixel edges keeping the region on the right.
    // Directions: 0=E 1=S 2=W 3=N; position is a pixel-corner (x,y).
    const dx = [1, 0, -1, 0], dy = [0, 1, 0, -1];
    let x = sx, y = sy, d = 0;    // top edge of the first pixel, heading east
    const pts = [];
    const startKey = x + ',' + y + ',' + d;
    for (let guard = 0; guard < 4 * w * h + 10; guard++) {
      // pixel on the right of the heading, and the one ahead-right
      // heading E: right = (x, y), ahead-right-left... use corner rules:
      // For heading d at corner (x,y), the two pixels straddling the next step:
      let left, right;
      if (d === 0) { left = at(x, y - 1); right = at(x, y); }
      else if (d === 1) { left = at(x, y); right = at(x - 1, y); }
      else if (d === 2) { left = at(x - 1, y); right = at(x - 1, y - 1); }
      else { left = at(x - 1, y - 1); right = at(x, y - 1); }
      // region on the right of travel: right pixel set, left pixel clear -> straight
      if (right && !left) { pts.push([x, y]); x += dx[d]; y += dy[d]; }
      else if (right && left) { pts.push([x, y]); d = (d + 3) % 4; x += dx[d]; y += dy[d]; }   // turn left, hug
      else { pts.push([x, y]); d = (d + 1) % 4; }                                              // turn right
      if (x + ',' + y + ',' + d === startKey && pts.length > 2) break;
    }
    return pts;
  },

  _simplifyClosed(ring, eps) {
    // remove collinear steps first (cheap), then Douglas–Peucker around the
    // two farthest-apart anchors
    const pts = this._dropCollinear(ring, 0);
    if (pts.length < 4) return pts;
    let a = 0, b = 0, best = -1;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 64)))
      for (let j = i; j < pts.length; j += Math.max(1, Math.floor(pts.length / 64))) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > best) { best = d; a = i; b = j; }
      }
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const part1 = pts.slice(lo, hi + 1);
    const part2 = pts.slice(hi).concat(pts.slice(0, lo + 1));
    const s1 = this._dp(part1, eps), s2 = this._dp(part2, eps);
    return s1.slice(0, -1).concat(s2.slice(0, -1));
  },

  _dp(pts, eps) {
    if (pts.length < 3) return pts;
    const A = pts[0], B = pts[pts.length - 1];
    let idx = -1, md = 0;
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const d = L < 1e-12 ? Math.hypot(pts[i][0] - A[0], pts[i][1] - A[1])
        : Math.abs((B[0] - A[0]) * (A[1] - pts[i][1]) - (A[0] - pts[i][0]) * (B[1] - A[1])) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (md <= eps) return [A, B];
    const l = this._dp(pts.slice(0, idx + 1), eps), r = this._dp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  },

  // ───────────────────────── shared geometry ─────────────────────────

  _signedArea(p) {
    let a = 0;
    for (let i = 0, n = p.length; i < n; i++) { const q = p[i], r = p[(i + 1) % n]; a += q[0] * r[1] - r[0] * q[1]; }
    return a / 2;
  },

  _pip(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  },

  // Drop vertices that lie on the line between their neighbours (within tol).
  _dropCollinear(p, tol) {
    const pts = p.slice();
    for (let i = 0; i < pts.length && pts.length > 3;) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const d = L < 1e-12 ? Math.hypot(b[0] - a[0], b[1] - a[1])
        : Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L;
      if (d <= tol) { pts.splice(i, 1); i = Math.max(0, i - 1); } else i++;
    }
    return pts;
  },

  // Flatten the DXF records of a layer into segments in drawing units.
  segmentsFromDxf(data, layerOk, opts) {
    const hatches = !!(opts && opts.hatches);
    const segs = [];
    const addPoly = (pts, closed) => {
      for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
      if (closed && pts.length > 2) segs.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]]);
    };
    for (const r of (data.entities || [])) {
      if (!layerOk(r.l)) continue;
      if (r.t === 'l') segs.push([r.p[0], r.p[1], r.p[2], r.p[3]]);
      else if (r.t === 'p' && (r.g !== 'HATCH' || hatches)) {
        const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
        addPoly(pts, !!r.c || r.g === 'HATCH');
      } else if (r.t === 'a') {
        const [cx, cy, rad, a0, a1] = r.p;
        let sweep = a1 - a0; while (sweep <= 0) sweep += 360;
        const n = Math.max(2, Math.ceil(sweep / 10)), pts = [];
        for (let i = 0; i <= n; i++) { const a = (a0 + sweep * i / n) * Math.PI / 180; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
        addPoly(pts, false);
      } else if (r.t === 'c') {
        const [cx, cy, rad] = r.p, pts = [];
        for (let i = 0; i < 36; i++) { const a = i * Math.PI / 18; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
        addPoly(pts, true);
      }
    }
    return segs;
  },
};


// ───────────────────── every closed region at once (pure) ─────────────────────

Object.assign(PlanRoomDetect, {
  /**
   * All bounded faces of the wall graph: one polygon per room / erf.
   * Slivers (the band between the two lines of a thick wall) and the outer
   * face are dropped; a face that wraps other candidates (a building outline
   * drawn apart from its partitions) is dropped in favour of them.
   * @param segs [[x1,y1,x2,y2], …]  @param opts { gap, minArea, maxArea, tol, minWidth }
   * @returns [{ points:[[x,y]…], area, seed:[x,y] }] (reading order)
   */
  allFromSegments(segs, opts) {
    const o = Object.assign({ gap: 1.2, minArea: 0, maxArea: Infinity, tol: 0.01, minWidth: 0 }, opts || {});
    const g = this._buildGraph(segs, o);
    if (!g.edges.length) return [];
    const done = new Set(), out = [];
    g.edges.forEach((e, i) => {
      if (!g.alive[i]) return;
      for (const he of [[e[0], e[1]], [e[1], e[0]]]) {
        if (done.has(he[0] + '>' + he[1])) continue;
        const ring = this._walkFace(g, he);
        for (let k = 0; k < ring.length; k++) done.add(ring[k] + '>' + ring[(k + 1) % ring.length]);
        const pts = this._dropCollinear(ring.map(v => g.verts[v]), o.tol);
        const area = this._signedArea(pts);
        if (!(area > 1e-9) || area < o.minArea || area > o.maxArea) continue;
        if (o.minWidth > 0 && 4 * area / this._perimeter(pts) < o.minWidth) continue;
        out.push({ points: pts, area, seed: this._interior(pts), bridged: g.bridged });
      }
    });
    return this._leaves(out).sort((a, b) => a.seed[1] - b.seed[1] || a.seed[0] - b.seed[0]);
  },

  /**
   * Same for a rendered plan: every free-space region that does not touch the
   * image edge (that one is the outside), grown back to the wall face.
   * @param img { w, h, data } @param opts { gapPx, dark, minAreaPx, maxAreaPx, simplifyPx }
   * @returns [{ points:[[x,y]…] (pixels), area, seed }]
   */
  allFromRaster(img, opts) {
    const o = Object.assign({ gapPx: 6, dark: 140, minAreaPx: 0, maxAreaPx: Infinity, simplifyPx: 1.5, minWidthPx: 0 }, opts || {});
    const { w, h, data } = img, N = w * h;
    const wall = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      wall[i] = (data[i * 4 + 3] > 40 && lum < o.dark) ? 1 : 0;
    }
    const r = Math.max(0, Math.round(o.gapPx / 2));
    const thick = r > 0 ? this._dilate(wall, w, h, r) : wall;
    const lab = new Int32Array(N), border = [false], stack = new Int32Array(N);
    let n = 0;
    for (let s = 0; s < N; s++) {
      if (thick[s] || lab[s]) continue;
      n++; let sp = 0, bd = false; stack[sp++] = s; lab[s] = n;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) bd = true;
        let q;
        if (x > 0 && !thick[q = p - 1] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        if (x < w - 1 && !thick[q = p + 1] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        if (y > 0 && !thick[q = p - w] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        if (y < h - 1 && !thick[q = p + w] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
      }
      border.push(bd);
    }
    // grow every region back to the wall face; first to arrive keeps the pixel
    let front = [];
    for (let i = 0; i < N; i++) {
      if (!lab[i]) continue;
      const x = i % w, y = (i - x) / w;
      if ((x > 0 && !lab[i - 1] && !wall[i - 1]) || (x < w - 1 && !lab[i + 1] && !wall[i + 1]) ||
          (y > 0 && !lab[i - w] && !wall[i - w]) || (y < h - 1 && !lab[i + w] && !wall[i + w])) front.push(i);
    }
    for (let step = 0; step < r && front.length; step++) {
      const next = [];
      for (const i of front) {
        const x = i % w, y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!lab[j] && !wall[j]) { lab[j] = lab[i]; next.push(j); }
        }
      }
      front = next;
    }
    // bounding boxes of the regions that are not the outside
    const bb = [];
    for (let i = 0; i < N; i++) {
      const l = lab[i]; if (!l || border[l]) continue;
      const x = i % w, y = (i - x) / w, b = bb[l] || (bb[l] = [x, y, x, y, 0]);
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; b[4]++;
    }
    const out = [];
    bb.forEach((b, l) => {
      if (!b || b[4] < Math.max(4, o.minAreaPx) || b[4] > o.maxAreaPx) return;
      const cw = b[2] - b[0] + 1, ch = b[3] - b[1] + 1, m = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (lab[(b[1] + y) * w + b[0] + x] === l) m[y * cw + x] = 1;
      const ring = this._traceOuter(m, cw, ch);
      if (!ring || ring.length < 3) return;
      const simp = this._simplifyClosed(ring, o.simplifyPx).map(([x, y]) => [x + b[0], y + b[1]]);
      const pts = this._dropCollinear(simp, 0.5), area = Math.abs(this._signedArea(pts));
      if (pts.length < 3 || area < o.minAreaPx || area > o.maxAreaPx) return;
      if (o.minWidthPx > 0 && 4 * area / this._perimeter(pts) < o.minWidthPx) return;
      out.push({ points: pts, area, seed: this._interior(pts) });
    });
    return this._leaves(out).sort((a, b) => a.seed[1] - b.seed[1] || a.seed[0] - b.seed[0]);
  },

  /**
   * Why a click is not enclosed: the smallest gap that would close it and the
   * openings that gap bridges (the leak). Vector walls.
   * @returns { ok:true, gap, bridges:[[x1,y1,x2,y2]…] } | { ok:false, reason }
   */
  leakFromSegments(segs, click, opts) {
    const o = Object.assign({ gap: 1.2, maxGap: 5, tol: 0.01, maxArea: Infinity }, opts || {});
    const S = segs.map(s => [s[0], s[1], s[2], s[3]]).filter(s => Math.hypot(s[2] - s[0], s[3] - s[1]) > o.tol * 0.1);
    const key = (b) => [b[0], b[1], b[2], b[3]].map(v => Math.round(v / o.tol)).join(',');
    const have = new Set(this._bridgeGaps(S, o.gap, o.tol).map(key));
    const all = this._bridgeGaps(S, o.maxGap, o.tol);
    const lens = [...new Set(all.map(b => Math.round(Math.hypot(b[2] - b[0], b[3] - b[1]) / o.tol) * o.tol))]
      .filter(l => l > o.gap).sort((a, b) => a - b);
    const tryGap = (g) => this.fromSegments(S, click, { gap: g, tol: o.tol, maxArea: o.maxArea });
    let lo = 0, hi = lens.length - 1;
    if (hi < 0 || !tryGap(lens[hi] + o.tol).ok) return { ok: false, reason: 'no-closing-gap' };
    while (lo < hi) { const m = (lo + hi) >> 1; if (tryGap(lens[m] + o.tol).ok) hi = m; else lo = m + 1; }
    const gap = lens[lo] + o.tol, face = tryGap(gap);
    const ring = face.points, near = (x, y) => {
      let d = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        d = Math.min(d, Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y));
      }
      return d;
    };
    const bridges = this._bridgeGaps(S, gap, o.tol).filter(b => !have.has(key(b)) && near(b[0], b[1]) <= o.tol * 5 && near(b[2], b[3]) <= o.tol * 5);
    return { ok: true, gap, bridges };
  },

  /** Same for a rendered plan: the opening is where the escape path squeezes through. */
  leakFromRaster(img, click, opts) {
    const o = Object.assign({ gapPx: 6, maxGapPx: 60, dark: 140 }, opts || {});
    const { w, h, data } = img, N = w * h;
    const wall = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      wall[i] = (data[i * 4 + 3] > 40 && lum < o.dark) ? 1 : 0;
    }
    const cx = Math.round(click[0]), cy = Math.round(click[1]);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h || wall[cy * w + cx]) return { ok: false, reason: 'on-wall' };
    const start = cy * w + cx, parent = new Int32Array(N), queue = new Int32Array(N);
    const escape = (thick) => {      // path click → image edge through free space, or null
      if (thick[start]) return undefined;
      parent.fill(-1); let qh = 0, qt = 0; queue[qt++] = start; parent[start] = start;
      while (qh < qt) {
        const p = queue[qh++], x = p % w, y = (p - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          const path = []; for (let c = p; c !== start; c = parent[c]) path.push(c); path.push(start); return path.reverse();
        }
        let q;
        if (!thick[q = p - 1] && parent[q] < 0) { parent[q] = p; queue[qt++] = q; }
        if (!thick[q = p + 1] && parent[q] < 0) { parent[q] = p; queue[qt++] = q; }
        if (!thick[q = p - w] && parent[q] < 0) { parent[q] = p; queue[qt++] = q; }
        if (!thick[q = p + w] && parent[q] < 0) { parent[q] = p; queue[qt++] = q; }
      }
      return null;
    };
    const dil = (r) => r > 0 ? this._dilate(wall, w, h, r) : wall;
    let rlo = Math.max(0, Math.round(o.gapPx / 2)), rhi = Math.round(o.maxGapPx / 2);
    const thLo = dil(rlo);
    const pathLo = escape(thLo);
    if (pathLo === undefined) return { ok: false, reason: 'on-wall' };
    if (pathLo === null) return { ok: false, reason: 'enclosed' };
    const closes = (r) => escape(dil(r)) === null;
    if (!closes(rhi)) return { ok: false, reason: 'no-closing-gap' };
    while (rhi - rlo > 1) { const m = (rlo + rhi) >> 1; if (closes(m)) rhi = m; else rlo = m; }
    const thHi = dil(rhi), path = escape(dil(rlo)) || pathLo;
    let run = [], hit = false;
    for (const c of path) {
      if (thHi[c]) { hit = true; run.push(c); } else if (hit) break;
    }
    if (!run.length) run = [path[path.length >> 1]];
    let sx = 0, sy = 0; for (const c of run) { sx += c % w; sy += (c / w) | 0; }
    return { ok: true, gapPx: 2 * rhi, point: [sx / run.length, sy / run.length] };
  },

  /**
   * Move every edge of a polygon `d` towards its inside (d > 0, wall finish) or
   * outside (d < 0), corners mitred (bevelled past `miter` × |d|).
   * Returns null when the result would fold over itself or lose a part of the
   * shape (a thin arm narrower than 2·d): never a wrong polygon.
   * @param poly [[x,y]…]  @returns [[x,y]…] | null
   */
  insetPolygon(poly, d, opts) {
    const o = Object.assign({ miter: 4 }, opts || {});
    if (!d) return poly.map(q => q.slice());
    let p = this._dropCollinear(poly.map(q => q.slice()), 1e-9);
    if (p.length < 3) return null;
    const a0 = this._signedArea(p);
    if (Math.abs(a0) < 1e-12) return null;
    if (a0 < 0) p.reverse();                         // interior on the left of every edge
    const n = p.length, nrm = [];
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-12) return null;
      nrm.push([-(b[1] - a[1]) / L, (b[0] - a[0]) / L]);
    }
    const out = [];
    for (let j = 0; j < n; j++) {
      const n1 = nrm[(j - 1 + n) % n], n2 = nrm[j], dot = n1[0] * n2[0] + n1[1] * n2[1];
      const k = 1 + dot;
      const miterLen = k > 1e-9 ? Math.abs(d) * Math.sqrt(2 / k) : Infinity;
      if (miterLen > o.miter * Math.abs(d)) {
        out.push([p[j][0] + n1[0] * d, p[j][1] + n1[1] * d], [p[j][0] + n2[0] * d, p[j][1] + n2[1] * d]);
      } else out.push([p[j][0] + (n1[0] + n2[0]) * d / k, p[j][1] + (n1[1] + n2[1]) * d / k]);
    }
    // validation: simple, same winding, and every corner the right side of, and
    // at least |d| from, the original outline
    const A = this._signedArea(out);
    if (!(A > 1e-12) || (d > 0 ? A >= Math.abs(a0) : A <= Math.abs(a0))) return null;
    const m = out.length;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      if (j === i + 1 || (i === 0 && j === m - 1)) continue;
      if (this._segCross(out[i], out[(i + 1) % m], out[j], out[(j + 1) % m])) return null;
    }
    const lim = Math.abs(d) * (1 - 1e-6);
    for (const q of out) {
      if (this._pip(q, p) !== (d > 0)) return null;
      let dist = Infinity;
      for (let i = 0; i < n; i++) dist = Math.min(dist, this._distSeg(q, p[i], p[(i + 1) % n]));
      if (dist < lim) return null;
    }
    return out;
  },
  _distSeg(q, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-18;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
    return Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]);
  },
  _segCross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
    return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
  },

  _perimeter(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; },

  // A point inside the polygon: the middle of the widest span on the scanline
  // through the centroid (the centroid itself can fall outside an L or U).
  _interior(p) {
    let cx = 0, cy = 0; for (const q of p) { cx += q[0]; cy += q[1]; } cx /= p.length; cy /= p.length;
    let best = null;
    for (const y of [cy, cy + 0.25 * (this._bbox(p)[3] - this._bbox(p)[1]), cy - 0.25 * (this._bbox(p)[3] - this._bbox(p)[1])]) {
      const xs = [];
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i], b = p[j];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const wd = xs[k + 1] - xs[k];
        if (!best || wd > best.w) best = { w: wd, x: (xs[k] + xs[k + 1]) / 2, y };
      }
      if (best && y === cy) break;
    }
    return best ? [best.x, best.y] : [cx, cy];
  },
  _bbox(p) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const q of p) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } return [a, b, c, d]; },

  // Keep only candidates that do not wrap another candidate.
  _leaves(c) {
    const bb = c.map(x => this._bbox(x.points));
    return c.filter((a, i) => !c.some((b, j) => j !== i && b.area < a.area &&
      b.seed[0] >= bb[i][0] && b.seed[0] <= bb[i][2] && b.seed[1] >= bb[i][1] && b.seed[1] <= bb[i][3] && this._pip(b.seed, a.points)));
  },
});


// ───────────────────────── plan glue (browser) ─────────────────────────

Object.assign(PlanRoomDetect, {
  DEFAULT_LAYERS: 'wall|mur|muur|a-wall|walls',
  ERF_LAYERS: 'erf|erven|stand|cadastr|parcel|boundary|property|lot|cadastre',
  // Per target: what a region may be (m²) and how thin before it is a wall band.
  LIMITS: {
    room: { maxAreaM2: 5000, minAreaM2: 1, minWidthM: 0.6, noun: 'room', nouns: 'rooms', Noun: 'Room' },
    erf: { maxAreaM2: 20000, minAreaM2: 20, minWidthM: 2, noun: 'erf', nouns: 'erven', Noun: 'Erf' },
  },
  mode: 'create',       // plain click: 'create' now · 'add' to the staged set · 'subtract' from it
  staged: { target: 'room', items: [] },

  // target 'room' (Lighting) or 'erf' (Plan, reticulation)
  opts(target) {
    const s = AppState.planMarkup.settings, erf = target === 'erf';
    // Saved in the project file, so never trust what comes back from it.
    const key = erf ? 'erfDetect' : 'roomDetect';
    const rd = (s[key] && typeof s[key] === 'object') ? s[key] : (s[key] = {});
    const gap = parseFloat(rd.gapM);
    rd.gapM = Number.isFinite(gap) ? Math.max(0, Math.min(5, gap)) : (erf ? 0.5 : 1.2);
    const def = erf ? this.ERF_LAYERS : this.DEFAULT_LAYERS;
    rd.layers = (typeof rd.layers === 'string' && rd.layers.trim()) ? rd.layers.slice(0, 200) : def;
    rd.hatch = rd.hatch !== false;        // outlines of hatched / solid walls on the wall layers count as walls
    rd.hover = rd.hover !== false;        // preview the region under the pointer
    const ins = parseFloat(rd.insetM);
    rd.insetM = (!erf && Number.isFinite(ins)) ? Math.max(-2, Math.min(2, ins)) : 0;   // wall finish: + shrinks, − grows (rooms only; an erf is a point)
    return rd;
  },

  // Returns { ok:true, points:[{x,y}] (world), source, bridged } | { ok:false, reason }
  detectAt(pt, target) {
    target = target || 'room';
    const f = PlanEngine.factor();
    const o = this.opts(target), lim = this.LIMITS[target];
    const visibleDxf = (typeof PlanDxfImport !== 'undefined')
      ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).reverse() : [];
    const hasImages = AppState.planMarkup.plans.some(p => p.visible !== false);
    if (!visibleDxf.length && !hasImages) return { ok: false, reason: 'no-background' };
    let last = null;
    for (const d of visibleDxf) {
      const r = this._detectDxf(d, pt, f, o, lim);
      if (r.ok) return r;
      last = r;
      if (r.reason === 'no-walls') continue;
    }
    if (hasImages) {
      if (!f) return { ok: false, reason: 'uncalibrated' };
      const r = this._detectRaster(pt, f, o, lim);
      if (r.ok || !last || last.reason === 'no-walls') return r;
    }
    return last || { ok: false, reason: 'no-background' };
  },

  _wallLayerTest(desc, data, pattern) {
    let re = null;
    try { re = new RegExp(pattern || this.DEFAULT_LAYERS, 'i'); } catch (_) { re = new RegExp(this.DEFAULT_LAYERS, 'i'); }
    const visible = (n) => !(desc.layers && desc.layers[n] && desc.layers[n].hidden);
    const names = (data.layers || []).map(l => l.name).filter(visible);
    const matched = names.filter(n => re.test(n));
    const use = new Set(matched.length ? matched : names);
    return { test: (n) => use.has(n), names: [...use], matched: matched.length > 0 };
  },

  _detectDxf(desc, pt, f, o, lim) {
    const data = PlanDxfImport.dataOf(desc);
    const lt = this._wallLayerTest(desc, data, o.layers);
    const segs = this.segmentsFromDxf(data, lt.test, { hatches: o.hatch && lt.matched });
    if (!segs.length) return { ok: false, reason: 'no-walls' };
    const click = PlanDxfImport.localOf(desc, pt.x, pt.y);
    // metres per drawing unit, for the door gap and the size cap
    const mpu = f ? PlanDxfImport._pxPerUnit(desc) * f : desc.unitM;
    const gap = o.gapM / mpu;
    const r = this.fromSegments(segs, [click.x, click.y], {
      gap, maxArea: lim.maxAreaM2 / (mpu * mpu), tol: Math.max(0.001 / mpu, 1e-9), snap: Math.max(0.03 / mpu, 1e-9),
    });
    if (!r.ok) return Object.assign(r, { layers: lt.names });
    return {
      ok: true, source: 'dxf', bridged: r.bridged, layers: lt.names, layerMatched: lt.matched,
      points: r.points.map(([x, y]) => PlanDxfImport.worldOf(desc, x, y)),
    };
  },

  // Render the visible background images once (cached) and flood-fill it.
  _rasterWindow() {
    const pm = AppState.planMarkup;
    const plans = pm.plans.filter(p => p.visible !== false);
    const imgs = plans.map(p => ({ p, img: (typeof PlanImages !== 'undefined') ? PlanImages.getElementImage(p.imageId) : null })).filter(x => x.img);
    if (!imgs.length) return null;
    const sig = imgs.map(x => [x.p.id, x.p.imageId, JSON.stringify([x.p.offX, x.p.offY, x.p.rotation, x.p.scaleAdj, x.p.k, x.p.scale, x.p.x, x.p.y]), x.img.width].join(':')).join('|');
    if (this._win && this._win.sig === sig) return this._win;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { p, img } of imgs) {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      for (const [ix, iy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
        const q = PlanEngine.planImageToWorld(p, ix, iy);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      }
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const sc = Math.min(2, 3200 / span);
    const cw = Math.max(1, Math.ceil((maxX - minX) * sc)), ch = Math.max(1, Math.ceil((maxY - minY) * sc));
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(sc, 0, 0, sc, -minX * sc, -minY * sc);
    for (const { p, img } of imgs) {
      ctx.save();
      ctx.globalAlpha = 1;
      PlanEngine._applyPlanTransform(ctx, p);
      try { ctx.drawImage(img, 0, 0); } catch (_) { /* not decoded */ }
      ctx.restore();
    }
    this._win = { sig, minX, minY, sc, w: cw, h: ch, data: ctx.getImageData(0, 0, cw, ch).data };
    return this._win;
  },

  _detectRaster(pt, f, o, lim) {
    const win = this._rasterWindow();
    if (!win) return { ok: false, reason: 'no-background' };
    const click = [(pt.x - win.minX) * win.sc, (pt.y - win.minY) * win.sc];
    const mPerPx = f / win.sc;
    const r = this.fromRaster({ w: win.w, h: win.h, data: win.data }, click, {
      gapPx: o.gapM / mPerPx, maxAreaPx: lim.maxAreaM2 / (mPerPx * mPerPx),
      simplifyPx: Math.max(1.5, 0.05 / mPerPx),
    });
    if (!r.ok) return r;
    return { ok: true, source: 'image', bridged: 0, points: r.points.map(([x, y]) => ({ x: win.minX + x / win.sc, y: win.minY + y / win.sc })) };
  },

  invalidate() { this._win = null; },

  _why(r, target) {
    target = target || 'room';
    const o = this.opts(target), lim = this.LIMITS[target];
    switch (r.reason) {
      case 'no-background': return 'Import a DXF or a plan image first — there is nothing to detect from.';
      case 'uncalibrated': return 'Calibrate the plan first — detection needs real distances for the gap.';
      case 'no-walls': return `No ${target === 'erf' ? 'boundary' : 'wall'} lines found on the visible layers. Check the layer filter in the options.`;
      case 'on-wall': return `That click landed on a ${target === 'erf' ? 'boundary' : 'wall'}. Click inside the ${lim.noun}.`;
      case 'outside': return 'Click on the plan.';
      case 'too-large': return `That region is larger than ${lim.maxAreaM2} m² — probably the whole site. Close the openings, or draw the ${lim.noun} by hand.`;
      default: return `No closed ${lim.noun} here. Lines with openings wider than ${o.gapM} m stay open — raise the gap in the options, or draw the ${lim.noun} by hand.`;
    }
  },

  // ───────── every region at once ─────────

  // → { ok:true, items:[{points:[{x,y}], seed:{x,y}}], source } | { ok:false, reason }
  allCandidates(target) {
    const sig = this._sig(target);
    if (!this._cands || this._cands.sig !== sig) {
      const t0 = performance.now(), r = this._computeCands(target);
      this._cands = { sig, r, ms: performance.now() - t0 };
    }
    const r = this._cands.r;
    return r.ok ? Object.assign({}, r, { items: r.items.slice() }) : r;
  },

  // Everything the result depends on, so a cached result is never stale.
  _sig(target) {
    const pm = AppState.planMarkup, o = this.opts(target);
    const dxf = (typeof PlanDxfImport !== 'undefined') ? PlanDxfImport.list().map(d => [d.id, d.hidden, d.k, d.offX, d.offY, d.rotation, d.scaleAdj, d.unitM, d.layers]) : [];
    const img = pm.plans.map(p => [p.id, p.imageId, p.visible, p.offX, p.offY, p.rotation, p.scaleAdj, p.k, p.scale, p.x, p.y]);
    return JSON.stringify([target, o.gapM, o.layers, o.hatch, PlanEngine.factor(), dxf, img]);
  },

  _computeCands(target) {
    const f = PlanEngine.factor(), o = this.opts(target), lim = this.LIMITS[target];
    const visibleDxf = (typeof PlanDxfImport !== 'undefined')
      ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).reverse() : [];
    const hasImages = AppState.planMarkup.plans.some(p => p.visible !== false);
    if (!visibleDxf.length && !hasImages) return { ok: false, reason: 'no-background' };
    let items = [], source = null, noWalls = true; const orphans = [];
    for (const d of visibleDxf) {
      const data = PlanDxfImport.dataOf(d), lt = this._wallLayerTest(d, data, o.layers);
      const segs = this.segmentsFromDxf(data, lt.test, { hatches: o.hatch && lt.matched });
      if (!segs.length) continue;
      noWalls = false;
      const mpu = f ? PlanDxfImport._pxPerUnit(d) * f : d.unitM;
      const found = this.allFromSegments(segs, {
        gap: o.gapM / mpu, tol: Math.max(0.001 / mpu, 1e-9), snap: Math.max(0.03 / mpu, 1e-9),
        minArea: lim.minAreaM2 / (mpu * mpu), maxArea: lim.maxAreaM2 / (mpu * mpu), minWidth: lim.minWidthM / mpu,
      });
      // The text inside a region names it (a stand number, a room number), as the DXF manager does.
      const texts = target === 'erf' ? (data.entities || []).filter(r => r.t === 'x' && r.s != null && String(r.s).trim()) : [];
      const used = new Set();
      for (const c of found) {
        const hits = texts.filter(t => this._pip(t.p, c.points));
        hits.sort((a, b) => (/\d/.test(b.s) - /\d/.test(a.s)) || (b.h - a.h));
        const label = hits.length ? String(hits[0].s).replace(/\s+/g, ' ').trim().slice(0, 40) : '';
        hits.forEach(t => used.add(t));
        items.push({
          points: c.points.map(([x, y]) => PlanDxfImport.worldOf(d, x, y)),
          seed: (([x, y]) => PlanDxfImport.worldOf(d, x, y))(c.seed),
          label,
        });
      }
      // A stand number that sits in no detected region is a stand that was missed.
      for (const t of texts) if (!used.has(t) && /^[A-Za-z]{0,4}[ -]?\d+[A-Za-z]?$/.test(String(t.s).trim())) orphans.push(String(t.s).trim());
      if (items.length) source = 'dxf';
    }
    if (!items.length && hasImages) {
      if (!f) return { ok: false, reason: 'uncalibrated' };
      const win = this._rasterWindow();
      if (win) {
        const mPerPx = f / win.sc, W = ([x, y]) => ({ x: win.minX + x / win.sc, y: win.minY + y / win.sc });
        const found = this.allFromRaster({ w: win.w, h: win.h, data: win.data }, {
          gapPx: o.gapM / mPerPx, simplifyPx: Math.max(1.5, 0.05 / mPerPx),
          minAreaPx: lim.minAreaM2 / (mPerPx * mPerPx), maxAreaPx: lim.maxAreaM2 / (mPerPx * mPerPx), minWidthPx: lim.minWidthM / mPerPx,
        });
        items = found.map(c => ({ points: c.points.map(W), seed: W(c.seed) }));
        if (items.length) source = 'image';
        noWalls = false;
      }
    }
    if (!items.length) return { ok: false, reason: noWalls ? 'no-walls' : 'not-enclosed' };
    return { ok: true, items, source, orphans };
  },

  // ───────── why a click did not close, and what it would pick ─────────

  // → { gapM, points:[{x,y}] } | null. Run only after a click failed to enclose.
  leakAt(pt, target) {
    const f = PlanEngine.factor(), o = this.opts(target), lim = this.LIMITS[target];
    const maxGapM = 5;
    const dxfs = (typeof PlanDxfImport !== 'undefined')
      ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).reverse() : [];
    for (const d of dxfs) {
      const data = PlanDxfImport.dataOf(d), lt = this._wallLayerTest(d, data, o.layers);
      const segs = this.segmentsFromDxf(data, lt.test, { hatches: o.hatch && lt.matched });
      if (!segs.length) continue;
      const mpu = f ? PlanDxfImport._pxPerUnit(d) * f : d.unitM, c = PlanDxfImport.localOf(d, pt.x, pt.y);
      const r = this.leakFromSegments(segs, [c.x, c.y], { gap: o.gapM / mpu, maxGap: maxGapM / mpu, tol: Math.max(0.001 / mpu, 1e-9), snap: Math.max(0.03 / mpu, 1e-9), maxArea: lim.maxAreaM2 / (mpu * mpu) });
      if (r.ok) return { gapM: r.gap * mpu, points: r.bridges.map(b => PlanDxfImport.worldOf(d, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) };
    }
    if (AppState.planMarkup.plans.some(p => p.visible !== false) && f) {
      const win = this._rasterWindow();
      if (win) {
        const mPerPx = f / win.sc;
        const r = this.leakFromRaster({ w: win.w, h: win.h, data: win.data }, [(pt.x - win.minX) * win.sc, (pt.y - win.minY) * win.sc], { gapPx: o.gapM / mPerPx, maxGapPx: maxGapM / mPerPx });
        if (r.ok) return { gapM: r.gapPx * mPerPx, points: [{ x: win.minX + r.point[0] / win.sc, y: win.minY + r.point[1] / win.sc }] };
      }
    }
    return null;
  },

  // Smallest detected region under the pointer (from the cached Detect-all
  // result, so moving the mouse never rebuilds the wall graph).
  hoverAt(pt, target) {
    const o = this.opts(target);
    if (!o.hover || this._hoverOff) { this._setHover(null); return; }
    const r = this.allCandidates(target);
    if (this._cands && this._cands.ms > 1500) { this._hoverOff = true; this._setHover(null); this._changed(); return; }
    let best = null, ba = Infinity;
    if (r.ok) for (const c of r.items) {
      const xs = c.points.map(p => p.x), ys = c.points.map(p => p.y);
      if (pt.x < Math.min(...xs) || pt.x > Math.max(...xs) || pt.y < Math.min(...ys) || pt.y > Math.max(...ys)) continue;
      if (!this._pip([pt.x, pt.y], c.points.map(p => [p.x, p.y]))) continue;
      const a = Math.abs(this._signedArea(c.points.map(p => [p.x, p.y])));
      if (a < ba) { ba = a; best = c; }
    }
    this._setHover(best);
  },
  _setHover(c) {
    const was = this.hover;
    if ((was && was.points) === (c && c.points)) return;
    this.hover = c; PlanEngine.requestDraw({ fg: true });
  },

  // The boundary with the wall finish applied (rooms only). null when the
  // inset does not fit (a part would vanish): the caller keeps the raw one.
  _inset(points, target) {
    const o = this.opts(target), f = PlanEngine.factor();
    if (target !== 'room' || !o.insetM || !f) return points;
    const r = this.insetPolygon(points.map(p => [p.x, p.y]), o.insetM / f);
    return r ? r.map(([x, y]) => ({ x, y })) : null;
  },

  // A polygon (or an erf) already on the plan inside this candidate.
  _alreadyThere(target, c) {
    const pm = AppState.planMarkup, poly = c.points.map(p => [p.x, p.y]);
    if (target === 'erf') return pm.elements.some(e => e.type === 'erf' && this._pip([e.x, e.y], poly));
    return (pm.rooms || []).some(r => (!r.kind || r.kind === 'room' || r.kind === 'outdoor') && r.points && r.points.length >= 3 &&
      this._pip(this._interior(r.points.map(p => [p.x, p.y])), poly));
  },

  stage(target, items, replace) {
    if (this.staged.target !== target) this.staged = { target, items: [] };
    if (replace) this.staged.items = [];
    let bad = 0;
    for (const it of items) {
      const ins = this._inset(it.points, target);
      if (!ins) bad++;
      const pts = ins || it.points;
      this.staged.items.push({ id: 's' + (this._sid = (this._sid || 0) + 1), raw: it.points, points: pts, seed: ins ? this._seedOf(pts) : it.seed, source: it.source, label: it.label || '' });
    }
    if (bad) UI.toast(`${bad} ${bad === 1 ? 'region is' : 'regions are'} too narrow for a ${this.opts(target).insetM} m inset and ${bad === 1 ? 'keeps' : 'keep'} the wall line.`, 'warn', 5000);
    this._changed();
  },
  clearStaged() { this.staged = { target: this.staged.target, items: [] }; this._changed(); },
  _changed() {
    if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },
  _inside(item, pt) { return this._pip([pt.x, pt.y], item.points.map(p => [p.x, p.y])); },

  detectAll(target) {
    const r = this.allCandidates(target), lim = this.LIMITS[target];
    if (!r.ok) { UI.toast(this._why(r, target), 'warn', 6000); return; }
    const fresh = r.items.filter(c => !this._alreadyThere(target, c));
    if (!fresh.length) { UI.toast(`Found ${r.items.length} ${lim.nouns}, all already on the plan.`, 'info', 5000); return; }
    this.stage(target, fresh.map(c => Object.assign(c, { source: r.source })), true);
    const skipped = r.items.length - fresh.length, orph = r.orphans || [];
    UI.toast(`Found ${fresh.length} ${lim.nouns}${skipped ? ` (${skipped} already on the plan)` : ''}. Review them, then create. Shift-click adds, Alt-click subtracts.` +
      (orph.length ? ` ${orph.length} stand number${orph.length === 1 ? '' : 's'} in the drawing sit${orph.length === 1 ? 's' : ''} in no detected region (${orph.slice(0, 8).join(', ')}${orph.length > 8 ? '…' : ''}): check those ${lim.nouns}.` : ''),
      orph.length ? 'warn' : 'success', orph.length ? 12000 : 6000);
  },

  // The number text of the detected region under the point (erven only).
  _labelAt(pt, target) {
    if (target !== 'erf') return '';
    const r = this.allCandidates(target);
    let best = null, ba = Infinity;
    if (r.ok) for (const c of r.items) {
      if (!c.label || !this._pip([pt.x, pt.y], c.points.map(p => [p.x, p.y]))) continue;
      const a = Math.abs(this._signedArea(c.points.map(p => [p.x, p.y])));
      if (a < ba) { ba = a; best = c; }
    }
    return best ? best.label : '';
  },

  // ── a shape drawn by hand, for what the detection gets wrong ──
  // Click the corners (they snap like everything else on the plan, so DXF corners and ends are caught); click the first
  // corner, click the last one again, or press Enter to close; Backspace takes the last corner back; Esc drops it.
  draft: null,                                                  // { target, pts: [{x, y}], hover }
  _crosses(pts) {                                                // does the outline cross itself?
    const n = pts.length, o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
    }
    return false;
  },
  drawClick(pt, target) {
    const lim = this.LIMITS[target], z = PlanEngine.view.zoom, tol = 9 / z;
    if (!this.draft || this.draft.target !== target) this.draft = { target, pts: [], hover: null };
    const D = this.draft, q = (typeof PlanTools.snap === 'function' ? PlanTools.snap(pt) : pt) || pt, p = { x: q.x, y: q.y };
    if (D.pts.length >= 3 && (Math.hypot(p.x - D.pts[0].x, p.y - D.pts[0].y) <= tol || Math.hypot(p.x - D.pts[D.pts.length - 1].x, p.y - D.pts[D.pts.length - 1].y) <= tol)) { this.drawClose(); return; }
    if (D.pts.length && Math.hypot(p.x - D.pts[D.pts.length - 1].x, p.y - D.pts[D.pts.length - 1].y) <= tol / 3) return;      // the same spot twice
    D.pts.push(p); this._changed();
  },
  drawBack() { const D = this.draft; if (!D) return false; D.pts.pop(); if (!D.pts.length) this.draft = null; this._changed(); return true; },
  drawCancel() { if (!this.draft) return false; this.draft = null; this._changed(); return true; },
  drawClose() {
    const D = this.draft; if (!D) return false;
    const lim = this.LIMITS[D.target], f = PlanEngine.factor();
    if (D.pts.length < 3) { UI.toast(`A ${lim.noun} needs at least three corners.`, 'warn', 3000); return true; }
    if (this._crosses(D.pts)) { UI.toast('The outline crosses itself. Backspace takes the last corner back.', 'warn', 4000); return true; }
    const pts = D.pts.map(q => ({ x: q.x, y: q.y })), area = f ? PlanEngine._polyArea(pts) * f * f : null;
    this.draft = null;
    const made = this.commitMany(D.target, [{ points: pts, label: '', source: 'drawn' }]);
    UI.toast(`${made[0].name} drawn${area != null ? ` — ${area.toFixed(1)} m²` : ''}.`, 'success', 3500);
    this._changed(); return true;
  },
  drawDraft(ctx, zoom, target) {
    const D = this.draft; if (!D || D.target !== target || !D.pts.length) return;
    const pts = D.pts, h = D.hover, u = 1 / zoom;
    ctx.save();
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); if (h) ctx.lineTo(h.x, h.y);
    if (pts.length >= 2) { ctx.save(); ctx.closePath(); ctx.fillStyle = 'rgba(22,163,74,0.14)'; ctx.fill(); ctx.restore(); }
    ctx.lineWidth = 2 * u; ctx.strokeStyle = '#16a34a'; ctx.setLineDash([6 * u, 4 * u]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    pts.forEach((q, i) => { ctx.beginPath(); ctx.arc(q.x, q.y, (i === 0 && pts.length >= 3 ? 6 : 4) * u, 0, 6.2832); ctx.fill(); ctx.stroke(); });
    ctx.restore();
  },

  // The tool's click: create now, stage (add) or unstage (subtract).
  click(pt, target, e) {
    const lim = this.LIMITS[target];
    const m = (e && e.shiftKey) ? 'add' : (e && (e.altKey || e.ctrlKey || e.metaKey)) ? 'subtract' : this.mode;
    if (this.staged.target !== target) this.staged = { target, items: [] };
    if (m === 'subtract') {
      const hit = this.staged.items.filter(it => this._inside(it, pt));
      if (!hit.length) { UI.toast(`Nothing to subtract — that ${lim.noun} is not in the set.`, 'warn', 3500); return; }
      this.staged.items = this.staged.items.filter(it => !hit.includes(it));
      this._changed(); return;
    }
    const res = this.detectAt(pt, target);
    if (!res.ok) {
      this.leak = null;
      if (res.reason === 'not-enclosed') {
        const lk = this.leakAt(pt, target);
        if (lk) {
          this.leak = Object.assign(lk, { target });
          const n = lk.points.length;
          UI.toast(`No closed ${lim.noun} here. ${n === 1 ? 'The opening is' : 'The openings are'} marked in red — about ${lk.gapM.toFixed(1)} m wide. Raise the gap to ${(Math.ceil(lk.gapM * 10) / 10).toFixed(1)} m, or draw it by hand.`, 'warn', 8000);
          this._changed(); return;
        }
      }
      UI.toast(this._why(res, target), 'warn', 6000); this._changed(); return;
    }
    this.leak = null;
    if (m === 'add') {
      if (this.staged.items.some(it => this._inside(it, pt))) { UI.toast(`That ${lim.noun} is already in the set.`, 'info', 3000); return; }
      this.stage(target, [{ points: res.points, seed: this._seedOf(res.points), source: res.source, label: this._labelAt(pt, target) }], false);
      return;
    }
    // create now; a staged candidate for the same region is replaced by it
    this.staged.items = this.staged.items.filter(it => !this._inside(it, pt));
    const ins = this._inset(res.points, target);
    if (!ins) UI.toast(`Too narrow for a ${this.opts(target).insetM} m inset — created on the wall line.`, 'warn', 5000);
    const made = this.commitMany(target, [Object.assign({}, res, { points: ins || res.points, label: this._labelAt(pt, target) })]);
    const f = PlanEngine.factor(), first = made[0];
    const area = f && first.points ? PlanEngine._polyArea(first.points) * f * f : null;
    const bits = [`${first.name} detected${area != null ? ` — ${area.toFixed(1)} m²` : ''}`];
    if (res.bridged) bits.push(`${res.bridged} opening${res.bridged === 1 ? '' : 's'} closed`);
    if (res.source === 'dxf' && res.layerMatched === false) bits.push('no matching layer, used all visible layers');
    UI.toast(bits.join(' · '), 'success', 4500);
    this._changed();
  },
  _seedOf(pts) { const s = this._interior(pts.map(p => [p.x, p.y])); return { x: s[0], y: s[1] }; },

  createStaged() {
    const target = this.staged.target, items = this.staged.items;
    if (!items.length) return;
    const made = this.commitMany(target, items);
    this.staged.items = [];
    UI.toast(`Created ${made.length} ${made.length === 1 ? this.LIMITS[target].noun : this.LIMITS[target].nouns}.`, 'success', 4000);
    this._changed();
  },

  // The number written in the drawing, unless an erf already has it.
  _erfName(label) {
    const taken = new Set(AppState.planMarkup.elements.filter(e => e.type === 'erf').map(e => String(e.name)));
    return (label && !taken.has(label)) ? label : PlanMarkup.nextName('erf');
  },

  // Rooms become plan rooms; erven become Erf points at the region's interior
  // (the same element a DXF import makes), so Demand picks them up as usual.
  commitMany(target, items) {
    const pm = AppState.planMarkup, made = [], ids = [];
    for (const it of items) {
      if (target === 'erf') {
        const seed = it.seed || this._seedOf(it.points);
        const el = { id: AppState.planGenId('pmel'), type: 'erf', x: seed.x, y: seed.y, rotation: 0,
          name: this._erfName(it.label), reticId: null, props: PLAN_DEFS.defaults('erf'),
          boundary: it.points.map(p => ({ x: p.x, y: p.y })) };      // kept so Auto layout can find the erf's front
        pm.elements.push(el); made.push(Object.assign({ points: it.points }, { name: el.name })); ids.push(el.id);
      } else {
        const room = { id: AppState.planGenId('pmrm'), name: PlanMarkup.nextCounter('_room', 'Room '),
          points: it.points.map(p => ({ x: p.x, y: p.y })), color: null, source: it.source };
        pm.rooms.push(room); made.push(room); ids.push(room.id);
      }
    }
    PlanMarkup.setSelection(ids);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
    return made;
  },

  commit(res) { return this.commitMany('room', [res])[0]; },

  drawHover(ctx, zoom, target, e) {
    const sub = !!(e && (e.altKey || e.ctrlKey || e.metaKey));
    let c = this.hover, red = false;
    if (sub && this.hoverPt && this.staged.target === target) {
      const hit = this.staged.items.find(it => this._inside(it, this.hoverPt));
      if (hit) { c = hit; red = true; }
    }
    if (c && c.points && c.points.length > 2 && this.opts(target).hover) {
      const pts = red ? c.points : (this._inset(c.points, target) || c.points);
      ctx.save();
      ctx.beginPath(); pts.forEach((p, k) => k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = red ? 'rgba(220,38,38,0.30)' : 'rgba(37,99,235,0.18)'; ctx.fill();
      ctx.lineWidth = 2 / zoom; ctx.strokeStyle = red ? '#dc2626' : '#2563eb'; ctx.stroke();
      ctx.restore();
    }
    const lk = this.leak;
    if (lk && lk.target === target) {
      ctx.save(); ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2.5 / zoom; ctx.setLineDash([5 / zoom, 3 / zoom]);
      for (const p of lk.points) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 14 / zoom, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(p.x - 6 / zoom, p.y - 6 / zoom); ctx.lineTo(p.x + 6 / zoom, p.y + 6 / zoom);
        ctx.moveTo(p.x - 6 / zoom, p.y + 6 / zoom); ctx.lineTo(p.x + 6 / zoom, p.y - 6 / zoom); ctx.stroke();
        ctx.setLineDash([5 / zoom, 3 / zoom]);
      }
      ctx.restore();
    }
  },

  drawStaged(ctx, zoom, target) {
    if (this.staged.target !== target || !this.staged.items.length) return;
    const f = PlanEngine.factor();
    ctx.save();
    ctx.lineWidth = 1.5 / zoom; ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.font = `600 ${12 / zoom}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    this.staged.items.forEach((it, i) => {
      ctx.beginPath(); it.points.forEach((p, k) => k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = 'rgba(217,119,6,0.28)'; ctx.fill(); ctx.strokeStyle = '#d97706'; ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = '#7c2d12'; ctx.fillText(String(it.label || (i + 1)), it.seed.x, it.seed.y); ctx.setLineDash([6 / zoom, 4 / zoom]);
    });
    ctx.restore();
  },

  renderOptions(el, target) {
    target = target || 'room';
    const o = this.opts(target), lim = this.LIMITS[target], f = PlanEngine.factor();
    if (this.staged.target !== target) this.staged = { target, items: [] };
    const items = this.staged.items;
    const areaOf = (it) => f ? (PlanEngine._polyArea(it.points) * f * f) : null;
    const total = items.reduce((s, it) => s + (areaOf(it) || 0), 0);
    const rows = items.map((it, i) => { const a = areaOf(it); return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid var(--border,#ddd);padding:3px 0">
        <span><b>${String(it.label || (i + 1)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</b> ${lim.Noun}${a != null ? ` · ${a.toFixed(1)} m²` : ''}</span><button type="button" class="plan-btn" data-rd-del="${i}" aria-label="Remove ${lim.noun} ${i + 1}">✕</button></div>`; }).join('');
    const lk = (this.leak && this.leak.target === target) ? this.leak : null;
    const need = lk ? Math.min(5, Math.ceil(lk.gapM * 10) / 10) : 0;
    const leakBox = lk ? `<div style="border:1px solid #dc2626;border-radius:4px;padding:8px;display:flex;flex-direction:column;gap:6px">
        <span><b style="color:#dc2626">Not closed.</b> ${lk.points.length === 1 ? 'The opening' : lk.points.length + ' openings'} marked in red close${lk.points.length === 1 ? 's' : ''} at ${need.toFixed(1)} m.</span>
        <button type="button" class="plan-btn" data-rd-fixgap="${need}">Set gap to ${need.toFixed(1)} m</button></div>` : '';
    const modeBtn = (v, t) => `<button type="button" class="plan-btn" data-rd-mode="${v}" aria-pressed="${this.mode === v}" style="${this.mode === v ? 'font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`;
    el.innerHTML = `<div class="plan-props-title">Detect ${lim.noun === 'erf' ? 'erven' : 'rooms'}</div>
      <div class="plan-props-body" style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <button type="button" class="plan-btn" data-rd-all style="font-weight:600">Detect all ${lim.nouns}</button>
        <p style="margin:0;color:var(--text-muted)">Or click inside one. A plain click ${target === 'erf' ? 'places an erf' : 'creates the room'} now.
          Shift-click adds it to the set below, Alt-click takes it out. Esc to stop.</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap" role="group" aria-label="Click action">${modeBtn('create', 'Create')}${modeBtn('add', 'Add to set')}${modeBtn('subtract', 'Subtract')}${modeBtn('draw', 'Draw')}</div>
        ${this.mode === 'draw' ? `<p style="margin:0;color:var(--text-muted)"><b>Draw</b> for a ${lim.noun} the detection gets wrong: click its corners (they snap to the drawing's corners and ends), then click the first corner, click the last one again, or press Enter to close it. Backspace takes the last corner back, Esc drops the outline. It is created as a real ${lim.noun}${target === 'erf' ? ' with its boundary, so Auto layout can use it' : ''}. Alt-click still takes a set member out.</p>` : ''}
        <div><b>Set to review</b> <span style="color:var(--text-muted)">${items.length ? `${items.length} ${items.length === 1 ? lim.noun : lim.nouns}${f ? ` · ${total.toFixed(0)} m²` : ''}` : 'empty'}</span></div>
        <div style="max-height:200px;overflow:auto">${rows}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="plan-btn" data-rd-create style="font-weight:600"${items.length ? '' : ' disabled'}>Create${items.length ? ' ' + items.length : ''} ${items.length === 1 ? lim.noun : lim.nouns}</button>
          <button type="button" class="plan-btn" data-rd-clear${items.length ? '' : ' disabled'}>Clear set</button></div>
        ${leakBox}
        ${target === 'room' ? `<label>Wall finish: inset boundary by (m)
          <input type="number" min="-2" max="2" step="0.01" data-rd="inset" style="width:100%"></label>
        <p style="margin:-4px 0 0;color:var(--text-muted)">${f ? 'Positive pulls the boundary in from the wall face (plaster, skirting); negative pushes it out, e.g. to the wall centre.' : 'Calibrate the plan to use an inset.'}</p>` : ''}
        <label>Gap to close (m)
          <input type="number" min="0" max="5" step="0.1" data-rd="gap" style="width:100%"></label>
        <label>${target === 'erf' ? 'Boundary' : 'Wall'} layers (DXF, regex)
          <input type="text" data-rd="layers" style="width:100%"></label>
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-rd="hatch"> <span>Hatched and solid ${target === 'erf' ? 'boundaries' : 'walls'} on those layers count as ${target === 'erf' ? 'boundaries' : 'walls'} (their outline is the face)</span></label>
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-rd="hover"> <span>Preview the ${lim.noun} under the pointer${this._hoverOff ? ' (switched off: this drawing is too slow for it)' : ''}</span></label>
        <p style="margin:0;color:var(--text-muted)">With a plan image the lines are the dark pixels. ${target === 'erf' ? 'Detected erven are placed as Erf points and appear in Demand.' : 'Drag a corner to reshape a room; drag a midpoint to add a corner; double-click a corner to remove it.'}</p>
      </div>`;
    el.querySelector('[data-rd="gap"]').value = o.gapM;
    el.querySelector('[data-rd="layers"]').value = o.layers;
    const insEl = el.querySelector('[data-rd="inset"]');
    if (insEl) {
      insEl.value = o.insetM; insEl.disabled = !f;
      insEl.addEventListener('change', (e) => {
        o.insetM = Math.max(-2, Math.min(2, parseFloat(e.target.value) || 0)); PlanMarkup.markDirty();
        // re-derive what is already staged from its raw outline
        for (const it of this.staged.items) { const r = this._inset(it.raw || it.points, 'room'); it.points = r || it.raw || it.points; if (r) it.seed = this._seedOf(r); }
        this._changed();
      });
    }
    el.querySelector('[data-rd="gap"]').addEventListener('change', (e) => { o.gapM = Math.max(0, Math.min(5, parseFloat(e.target.value) || 0)); PlanMarkup.markDirty(); this.leak = null; PlanEngine.requestDraw({ fg: true }); });
    el.querySelector('[data-rd="layers"]').addEventListener('change', (e) => { o.layers = e.target.value || (target === 'erf' ? this.ERF_LAYERS : this.DEFAULT_LAYERS); PlanMarkup.markDirty(); });
    const hb = el.querySelector('[data-rd="hatch"]'), hv = el.querySelector('[data-rd="hover"]');
    hb.checked = o.hatch; hv.checked = o.hover && !this._hoverOff; hv.disabled = !!this._hoverOff;
    hb.addEventListener('change', (e) => { o.hatch = e.target.checked; PlanMarkup.markDirty(); this.leak = null; this._changed(); });
    hv.addEventListener('change', (e) => { o.hover = e.target.checked; PlanMarkup.markDirty(); this._setHover(null); });
    const fx = el.querySelector('[data-rd-fixgap]');
    if (fx) fx.addEventListener('click', () => { o.gapM = parseFloat(fx.dataset.rdFixgap); PlanMarkup.markDirty(); this.leak = null; UI.toast(`Gap set to ${o.gapM.toFixed(1)} m. Click inside again.`, 'info', 4000); this._changed(); });
    el.querySelector('[data-rd-all]').addEventListener('click', () => this.detectAll(target));
    el.querySelector('[data-rd-create]').addEventListener('click', () => this.createStaged());
    el.querySelector('[data-rd-clear]').addEventListener('click', () => this.clearStaged());
    el.querySelectorAll('[data-rd-mode]').forEach(b => b.addEventListener('click', () => { this.mode = b.dataset.rdMode; if (this.mode !== 'draw') this.draft = null; this._changed(); }));
    el.querySelectorAll('[data-rd-del]').forEach(b => b.addEventListener('click', () => { this.staged.items.splice(+b.dataset.rdDel, 1); this._changed(); }));
  },
});

if (typeof PlanTools !== 'undefined') {
  const makeDetectTool = (id, target) => ({
    id, cursor: 'copy',
    onActivate() { PlanRoomDetect.mode = 'create'; if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); },
    onDeactivate() { PlanRoomDetect.staged = { target, items: [] }; PlanRoomDetect.hover = null; PlanRoomDetect.leak = null; PlanRoomDetect.draft = null; },
    onMove(pt, e) {
      if (PlanRoomDetect.mode === 'draw') {                                    // drawing by hand: the rubber band follows the pointer, no detection preview
        const D = PlanRoomDetect.draft;
        if (D && D.target === target) { const q = (typeof PlanTools.snap === 'function' ? PlanTools.snap(pt) : pt) || pt; D.hover = { x: q.x, y: q.y }; PlanEngine.requestDraw({ fg: true }); }
        return;
      }
      this._e = e; PlanRoomDetect.hoverPt = { x: pt.x, y: pt.y };
      clearTimeout(this._t); this._t = setTimeout(() => PlanRoomDetect.hoverAt(pt, target), 60);
      PlanEngine.requestDraw({ fg: true });
    },
    cancel() { PlanTools.set('select'); },
    onDown(pt, e) { if (PlanRoomDetect.mode === 'draw' && !(e && (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey))) PlanRoomDetect.drawClick(pt, target); else PlanRoomDetect.click(pt, target, e); },
    drawOverlay(ctx, zoom) { PlanRoomDetect.drawStaged(ctx, zoom, target); if (PlanRoomDetect.mode === 'draw') PlanRoomDetect.drawDraft(ctx, zoom, target); else PlanRoomDetect.drawHover(ctx, zoom, target, this._e); },
    keyFirst(e) {                                                              // a shape being drawn: Enter closes it, Backspace takes a corner back, Esc drops it
      const D = PlanRoomDetect.draft; if (!D || D.target !== target) return false;
      if (e.key === 'Enter') return PlanRoomDetect.drawClose();
      if (e.key === 'Backspace') return PlanRoomDetect.drawBack();
      if (e.key === 'Escape') return PlanRoomDetect.drawCancel();
      return false;
    },
    get _draft() { const D = PlanRoomDetect.draft; return D && D.target === target ? { points: D.pts } : null; },    // lets the Done / Cancel chip show while a shape is being drawn
    onKey(e) {
      if (this.keyFirst(e)) return true;
      if (e.key === 'Enter' && PlanRoomDetect.staged.items.length) { PlanRoomDetect.createStaged(); return true; }
      if (e.key === 'Escape') {
        if (PlanRoomDetect.staged.items.length) { PlanRoomDetect.clearStaged(); return true; }
        this.cancel(); return true;
      }
      return false;
    },
  });
  PlanTools.register(makeDetectTool('roomdetect', 'room'));
  PlanTools.register(makeDetectTool('erfdetect', 'erf'));
}

if (typeof module !== 'undefined' && module.exports) module.exports = PlanRoomDetect;
