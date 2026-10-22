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
    const S = segs.map(s => [s[0], s[1], s[2], s[3]]).filter(s => Math.hypot(s[2] - s[0], s[3] - s[1]) > tol * 0.1);
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
  segmentsFromDxf(data, layerOk) {
    const segs = [];
    const addPoly = (pts, closed) => {
      for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
      if (closed && pts.length > 2) segs.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]]);
    };
    for (const r of (data.entities || [])) {
      if (!layerOk(r.l)) continue;
      if (r.t === 'l') segs.push([r.p[0], r.p[1], r.p[2], r.p[3]]);
      else if (r.t === 'p' && r.g !== 'HATCH') {
        const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
        addPoly(pts, !!r.c);
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


// ───────────────────────── plan glue (browser) ─────────────────────────

Object.assign(PlanRoomDetect, {
  DEFAULT_LAYERS: 'wall|mur|muur|a-wall|walls',

  opts() {
    const s = AppState.planMarkup.settings;
    if (!s.roomDetect) s.roomDetect = { gapM: 1.2, layers: this.DEFAULT_LAYERS };
    return s.roomDetect;
  },

  // Returns { ok:true, points:[{x,y}] (world), source, bridged } | { ok:false, reason }
  detectAt(pt) {
    const f = PlanEngine.factor();
    const o = this.opts();
    const visibleDxf = (typeof PlanDxfImport !== 'undefined')
      ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).reverse() : [];
    const hasImages = AppState.planMarkup.plans.some(p => p.visible !== false);
    if (!visibleDxf.length && !hasImages) return { ok: false, reason: 'no-background' };
    let last = null;
    for (const d of visibleDxf) {
      const r = this._detectDxf(d, pt, f, o);
      if (r.ok) return r;
      last = r;
      if (r.reason === 'no-walls') continue;
    }
    if (hasImages) {
      if (!f) return { ok: false, reason: 'uncalibrated' };
      const r = this._detectRaster(pt, f, o);
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

  _detectDxf(desc, pt, f, o) {
    const data = PlanDxfImport.dataOf(desc);
    const lt = this._wallLayerTest(desc, data, o.layers);
    const segs = this.segmentsFromDxf(data, lt.test);
    if (!segs.length) return { ok: false, reason: 'no-walls' };
    const click = PlanDxfImport.localOf(desc, pt.x, pt.y);
    // metres per drawing unit, for the door gap and the size cap
    const mpu = f ? PlanDxfImport._pxPerUnit(desc) * f : desc.unitM;
    const gap = o.gapM / mpu;
    const r = this.fromSegments(segs, [click.x, click.y], {
      gap, maxArea: this.settings.maxAreaM2 / (mpu * mpu), tol: Math.max(0.001 / mpu, 1e-9),
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

  _detectRaster(pt, f, o) {
    const win = this._rasterWindow();
    if (!win) return { ok: false, reason: 'no-background' };
    const click = [(pt.x - win.minX) * win.sc, (pt.y - win.minY) * win.sc];
    const mPerPx = f / win.sc;
    const r = this.fromRaster({ w: win.w, h: win.h, data: win.data }, click, {
      gapPx: o.gapM / mPerPx, maxAreaPx: this.settings.maxAreaM2 / (mPerPx * mPerPx),
      simplifyPx: Math.max(1.5, 0.05 / mPerPx),
    });
    if (!r.ok) return r;
    return { ok: true, source: 'image', bridged: 0, points: r.points.map(([x, y]) => ({ x: win.minX + x / win.sc, y: win.minY + y / win.sc })) };
  },

  invalidate() { this._win = null; },

  _why(r) {
    const o = this.opts();
    switch (r.reason) {
      case 'no-background': return 'Import a DXF or a plan image first — there is nothing to detect from.';
      case 'uncalibrated': return 'Calibrate the plan first — detection needs real distances for the door gap.';
      case 'no-walls': return 'No wall lines found on the visible layers. Check the wall layer filter in the options.';
      case 'on-wall': return 'That click landed on a wall. Click inside the room.';
      case 'outside': return 'Click on the plan.';
      case 'too-large': return `That region is larger than ${this.settings.maxAreaM2} m² — probably the whole site. Close the openings, or draw the room by hand.`;
      default: return `No closed room here. Walls with openings wider than ${o.gapM} m stay open — raise the door gap in the options, or draw the room by hand.`;
    }
  },

  commit(res) {
    const pm = AppState.planMarkup;
    const room = {
      id: AppState.planGenId('pmrm'), name: PlanMarkup.nextCounter('_room', 'Room '),
      points: res.points.map(p => ({ x: p.x, y: p.y })), color: null, source: res.source,
    };
    pm.rooms.push(room);
    PlanMarkup.selectOnly(room.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    return room;
  },

  renderOptions(el) {
    const o = this.opts();
    el.innerHTML = `<div class="plan-props-title">Detect room</div>
      <div class="plan-props-body" style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <p style="margin:0;color:var(--text-muted)">Click inside a room. Esc to stop.</p>
        <label>Door gap to close (m)
          <input type="number" min="0" max="5" step="0.1" value="${o.gapM}" data-rd="gap" style="width:100%"></label>
        <label>Wall layers (DXF, regex)
          <input type="text" value="${String(o.layers).replace(/"/g, '&quot;')}" data-rd="layers" style="width:100%"></label>
        <p style="margin:0;color:var(--text-muted)">With a plan image the walls are the dark pixels. Drag a corner to reshape the result; drag a midpoint to add a corner; double-click a corner to remove it.</p>
      </div>`;
    el.querySelector('[data-rd="gap"]').addEventListener('change', (e) => { o.gapM = Math.max(0, Math.min(5, parseFloat(e.target.value) || 0)); PlanMarkup.markDirty(); });
    el.querySelector('[data-rd="layers"]').addEventListener('change', (e) => { o.layers = e.target.value || this.DEFAULT_LAYERS; PlanMarkup.markDirty(); });
  },
});

if (typeof PlanTools !== 'undefined') {
  PlanTools.register({
    id: 'roomdetect', cursor: 'copy', _hover: null,
    onActivate() { this._hover = null; if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); },
    cancel() { PlanTools.set('select'); },
    onMove(pt) { this._hover = { x: pt.x, y: pt.y }; },
    onDown(pt) {
      const res = PlanRoomDetect.detectAt(pt);
      if (!res.ok) { UI.toast(PlanRoomDetect._why(res), 'warn', 6000); return; }
      const room = PlanRoomDetect.commit(res);
      const f = PlanEngine.factor();
      const area = f ? PlanEngine._polyArea(room.points) * f * f : null;
      const bits = [`${room.name} detected${area != null ? ` — ${area.toFixed(1)} m²` : ''}, ${room.points.length} corners`];
      if (res.bridged) bits.push(`${res.bridged} opening${res.bridged === 1 ? '' : 's'} closed`);
      if (res.source === 'dxf' && res.layerMatched === false) bits.push('no wall-named layer, used all visible layers');
      UI.toast(bits.join(' · '), 'success', 4500);
      PlanEngine.requestDraw({ fg: true });
    },
    onKey(e) { if (e.key === 'Escape') { this.cancel(); return true; } return false; },
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = PlanRoomDetect;
