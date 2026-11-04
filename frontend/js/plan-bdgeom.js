/**
 * PlanBdGeom — room geometry and detector coverage for the Building auto design
 * (pure, in metres, node-testable: testing/unit/bdgeom.test.js). No DOM, no standards
 * values: the radius a detector covers is an input, chosen by the caller from the
 * design basis (plan-bdrules.js), so this file only answers "is every point of the
 * room seen by a detector, and where do detectors go to make it so".
 *
 * Points are [x, y] (a {x, y} object is accepted wherever a point goes in and is
 * returned as [x, y]). A room is a closed polygon (the last point is not repeated).
 *
 *   inside / distToBoundary / isConvex / area / centroid / bbox   basic polygon helpers
 *   visible    straight line between two points stays inside the room and crosses no
 *              extra wall (`walls`: [[a, b], …] partitions, shelving runs, …) — a detector
 *              does not cover round a corner or through a wall
 *   coverage   fine sample of the room (interior grid + every edge + every corner) against
 *              the detectors: the distance to the nearest detector that sees each sample,
 *              pass / fail against `radius`, the worst point and every uncovered sample
 *   layout     the fewest detectors that pass: regular grids turned to the longest wall
 *              (fewest first, repaired where the room is not rectangular), else a greedy
 *              set cover, then redundant detectors are pruned; always re-proved at half
 *              the sample step
 *   zoneOf     the (smallest) fire-zone polygon a point is in
 *
 * `radius` is the horizontal distance a detector covers on the plan (the caller applies
 * any ceiling-height or slope reduction first). `clearance` keeps detectors that far from
 * every wall (the room outline and any extra wall); the coverage proof still includes the walls and corners themselves.
 */
const PlanBdGeom = (() => {
  const TOL = 1e-7;
  const hyp = Math.hypot;
  const pt = p => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
  const norm = poly => {
    const P = poly.map(pt);
    if (P.length > 1 && hyp(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < TOL) P.pop();
    return P;
  };
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;

  function signedArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function area(poly) { return Math.abs(signedArea(norm(poly))); }
  function centroid(poly) {
    const P = norm(poly), A = signedArea(P);
    if (Math.abs(A) < TOL) { const n = P.length || 1; return [P.reduce((s, p) => s + p[0], 0) / n, P.reduce((s, p) => s + p[1], 0) / n]; }
    let cx = 0, cy = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], c = p[0] * q[1] - q[0] * p[1]; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; }
    return [cx / (6 * A), cy / (6 * A)];
  }
  function bbox(poly) {
    const P = norm(poly); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  function isConvex(poly) {
    const P = norm(poly); let sign = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], c = P[(i + 2) % P.length];
      const k = cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
      if (Math.abs(k) < TOL) continue;
      if (!sign) sign = Math.sign(k); else if (Math.sign(k) !== sign) return false;
    }
    return true;
  }
  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return hyp(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  }
  function distToBoundary(p, poly) {
    const P = norm(poly), q = pt(p); let d = Infinity;
    for (let i = 0; i < P.length; i++) d = Math.min(d, distToSeg(q, P[i], P[(i + 1) % P.length]));
    return d;
  }
  // Boundary counts as inside.
  function insideP(P, p) {
    for (let i = 0; i < P.length; i++) if (distToSeg(p, P[i], P[(i + 1) % P.length]) < TOL) return true;
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function inside(poly, p) { return insideP(norm(poly), pt(p)); }

  // Proper intersection of segments a-b and c-d: { t, u } along each, or null when parallel / apart.
  function segHit(a, b, c, d) {
    const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
    const den = cross(rx, ry, sx, sy);
    if (Math.abs(den) < 1e-12) return null;
    const qx = c[0] - a[0], qy = c[1] - a[1];
    return { t: cross(qx, qy, sx, sy) / den, u: cross(qx, qy, rx, ry) / den };
  }

  // A room made ready for repeated visibility tests.
  function context(poly, walls) {
    const P = norm(poly);
    return {
      P, edges: P.map((a, i) => [a, P[(i + 1) % P.length]]),
      walls: (walls || []).map(w => [pt(w[0]), pt(w[1])]),
      convex: isConvex(P),
    };
  }
  function seen(C, a, b) {
    for (const w of C.walls) {
      const h = segHit(a, b, w[0], w[1]);
      if (h && h.t > 1e-6 && h.t < 1 - 1e-6 && h.u > 1e-6 && h.u < 1 - 1e-6) return false;
    }
    if (C.convex) return true;
    const ts = [0, 1];
    for (const e of C.edges) {
      const h = segHit(a, b, e[0], e[1]);
      if (h && h.t > 1e-6 && h.t < 1 - 1e-6 && h.u > -1e-6 && h.u < 1 + 1e-6) ts.push(h.t);
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < ts.length; i++) {
      if (ts[i + 1] - ts[i] < 1e-9) continue;
      const m = (ts[i] + ts[i + 1]) / 2;
      if (!insideP(C.P, [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m])) return false;
    }
    return true;
  }
  function visible(poly, a, b, walls) { return seen(context(poly, walls), pt(a), pt(b)); }

  // Sample points of the room: interior grid, every edge, every corner. `step` grows until
  // there are at most `maxN` points.
  function samples(C, step, maxN) {
    const bb = bbox(C.P);
    let s = Math.max(step, 0.01);
    for (let guard = 0; guard < 30; guard++) {
      const perim = C.edges.reduce((L, e) => L + hyp(e[1][0] - e[0][0], e[1][1] - e[0][1]), 0);
      if ((bb.w / s + 1) * (bb.h / s + 1) + perim / s <= maxN) break;
      s *= 1.15;
    }
    const out = [];
    for (let x = bb.x0 + s / 2; x < bb.x1; x += s) for (let y = bb.y0 + s / 2; y < bb.y1; y += s) { const p = [x, y]; if (insideP(C.P, p)) out.push(p); }
    for (const e of C.edges) {
      const L = hyp(e[1][0] - e[0][0], e[1][1] - e[0][1]), k = Math.max(1, Math.ceil(L / s));
      for (let i = 0; i <= k; i++) out.push([e[0][0] + (e[1][0] - e[0][0]) * i / k, e[0][1] + (e[1][1] - e[0][1]) * i / k]);
    }
    return { pts: out, step: s };
  }

  function nearestSeen(C, S, dets) {
    return S.map(p => {
      let d = Infinity;
      for (const q of dets) { const h = hyp(p[0] - q[0], p[1] - q[1]); if (h < d && seen(C, q, p)) d = h; }
      return d;
    });
  }

  // Does every point of the room lie within `radius` of a detector that sees it?
  function coverage(poly, detectors, radius, o) {
    o = o || {};
    const C = context(poly, o.walls), dets = (detectors || []).map(pt);
    const S = samples(C, o.step || 0.25, o.maxSamples || 8000);
    const nd = nearestSeen(C, S.pts, dets), R = radius + 1e-9;
    let worst = null, wd = -1, ok = 0; const uncovered = [];
    nd.forEach((d, i) => {
      if (d <= R) ok++; else if (uncovered.length < 500) uncovered.push(S.pts[i]);
      if (d > wd) { wd = d; worst = S.pts[i]; }
    });
    return {
      pass: S.pts.length > 0 && ok === S.pts.length, fraction: S.pts.length ? ok / S.pts.length : 0,
      worst: worst ? { x: worst[0], y: worst[1], d: wd } : null, uncovered, samples: S.pts.length, step: S.step,
    };
  }

  // Distance from a point to the room outline and to every extra wall.
  function clearOf(C, p) {
    let d = distToBoundary(p, C.P);
    for (const w of C.walls) d = Math.min(d, distToSeg(p, w[0], w[1]));
    return d;
  }

  function candidates(C, step, clearance, maxN) {
    const bb = bbox(C.P);
    let s = Math.max(step, 0.05);
    while ((bb.w / s + 1) * (bb.h / s + 1) > maxN) s *= 1.15;
    const out = []; let best = null, bd = -1;
    for (let x = bb.x0 + s / 2; x < bb.x1; x += s) for (let y = bb.y0 + s / 2; y < bb.y1; y += s) {
      const p = [x, y]; if (!insideP(C.P, p)) continue;
      const d = clearOf(C, p);
      if (d > bd) { bd = d; best = p; }
      if (d >= clearance - 1e-9) out.push(p);
    }
    if (!out.length && best) out.push(best);   // a room narrower than 2 x clearance: its widest point
    return out;
  }

  // Add detectors from `cands` until every sample is within R (greedy set cover on what is still uncovered).
  function repair(C, dets, S, cands, R) {
    const nd = nearestSeen(C, S, dets), left = new Set();
    nd.forEach((d, i) => { if (d > R + 1e-9) left.add(i); });
    if (!left.size) return { dets, stuck: [] };
    const lists = cands.map(c => {
      const l = [];
      for (const i of left) { const p = S[i]; if (hyp(p[0] - c[0], p[1] - c[1]) <= R + 1e-9 && seen(C, c, p)) l.push(i); }
      return l;
    });
    const out = dets.slice(), used = new Set();
    while (left.size) {
      let bi = -1, bg = 0;
      lists.forEach((l, k) => { if (used.has(k)) return; let g = 0; for (const i of l) if (left.has(i)) g++; if (g > bg) { bg = g; bi = k; } });
      if (bi < 0) break;
      used.add(bi); out.push(cands[bi]); for (const i of lists[bi]) left.delete(i);
    }
    return { dets: out, stuck: [...left].map(i => S[i]) };
  }

  // Drop detectors the others make redundant (least unique coverage first).
  function prune(C, dets, S, R) {
    let out = dets.slice(), changed = true;
    while (changed && out.length > 1) {
      changed = false;
      const order = out.map((q, k) => k);
      for (const k of order) {
        const rest = out.filter((_, j) => j !== k);
        if (nearestSeen(C, S, rest).every(d => d <= R + 1e-9)) { out = rest; changed = true; break; }
      }
    }
    return out;
  }

  const rot = (p, c, s, o) => [p[0] * c - p[1] * s * o, p[0] * s * o + p[1] * c];

  /**
   * The fewest detectors that cover the room. o: { radius (required), clearance (0.5), step (0.25),
   * walls, candStep (0.5), maxDetectors (150) }. Returns { detectors: [[x, y]…], method: 'grid' | 'free',
   * grid: { nx, ny, angle } | null, coverage, stuck: [[x, y]…] (points no allowed position can cover) }.
   */
  function layout(poly, o) {
    o = o || {};
    const R = o.radius, clearance = o.clearance == null ? 0.5 : o.clearance, maxD = o.maxDetectors || 150;
    if (!(R > 0)) throw new Error('layout needs a positive radius');
    const C = context(poly, o.walls);
    if (C.P.length < 3 || area(C.P) < TOL) return { detectors: [], method: 'free', grid: null, coverage: coverage(C.P, [], R, o), stuck: [] };
    const S = samples(C, o.step || 0.25, 3000), cands = candidates(C, o.candStep || 0.5, clearance, 600);
    const ok = p => insideP(C.P, p) && clearOf(C, p) >= clearance - 1e-9;

    // longest wall sets the grid direction
    let ang = 0, LL = -1;
    for (const e of C.edges) { const L = hyp(e[1][0] - e[0][0], e[1][1] - e[0][1]); if (L > LL) { LL = L; ang = Math.atan2(e[1][1] - e[0][1], e[1][0] - e[0][0]); } }
    const c = Math.cos(ang), s = Math.sin(ang);
    const Q = C.P.map(p => rot(p, c, s, -1));                      // room turned so that wall is horizontal
    const q = bbox(Q);

    let best = null;                                                // { dets, grid, stuck }
    const pairs = [];
    const nmax = Math.min(40, Math.ceil(Math.max(q.w, q.h) / Math.max(R * 0.5, 0.5)) + 1);
    for (let nx = 1; nx <= nmax; nx++) for (let ny = 1; ny <= nmax; ny++) if (nx * ny <= maxD) pairs.push([nx, ny]);
    pairs.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] / a[1] - q.w / q.h) - Math.abs(b[0] / b[1] - q.w / q.h));
    const lower = Math.ceil(area(C.P) / (2 * R * R) - 1e-9);
    for (const [nx, ny] of pairs) {
      if (nx * ny < lower) continue;
      if (best && nx * ny > best.dets.length) break;
      const g = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const p = rot([q.x0 + (i + 0.5) * q.w / nx, q.y0 + (j + 0.5) * q.h / ny], c, s, 1);
        if (ok(p)) g.push(p);
      }
      const r = repair(C, g, S.pts, cands, R);
      const added = r.dets.length - g.length;                         // detectors the grid needed on top of itself
      if (!best || r.dets.length < best.dets.length || (r.dets.length === best.dets.length && (r.stuck.length < best.stuck.length || (r.stuck.length === best.stuck.length && added < best.added)))) best = { dets: r.dets, stuck: r.stuck, added, grid: { nx, ny, angle: ang } };
      if (!r.stuck.length && !added) break;                           // a pure grid that passes: the fewest by construction
    }
    // free (greedy) layout; keep whichever has fewer detectors
    const fr = repair(C, [], S.pts, cands, R), free = { dets: prune(C, fr.dets, S.pts, R), stuck: fr.stuck, grid: null };
    if (!best || free.dets.length < best.dets.length || (free.dets.length === best.dets.length && free.stuck.length < best.stuck.length)) best = free;

    let dets = prune(C, best.dets, S.pts, R), stuck = best.stuck;
    // proof at half the step; one repair pass if it finds a gap the first sample missed
    let cov = coverage(C.P, dets, R, { walls: o.walls, step: (o.step || 0.25) / 2 });
    if (!cov.pass && !stuck.length) {
      const S2 = samples(C, (o.step || 0.25) / 2, 8000), r = repair(C, dets, S2.pts, cands, R);
      dets = r.dets; stuck = r.stuck; cov = coverage(C.P, dets, R, { walls: o.walls, step: (o.step || 0.25) / 2 });
    }
    return { detectors: dets, method: best.grid ? 'grid' : 'free', grid: best.grid, coverage: cov, stuck };
  }

  // The smallest fire-zone polygon ({ id, name, points }) that holds the point, or null.
  function zoneOf(p, zones) {
    const q = pt(p); let best = null, ba = Infinity;
    for (const z of zones || []) {
      const P = norm(z.points || []); if (P.length < 3 || !insideP(P, q)) continue;
      const a = Math.abs(signedArea(P)); if (a < ba) { ba = a; best = z; }
    }
    return best;
  }

  return { area, centroid, bbox, isConvex, inside, distToBoundary, visible, coverage, layout, zoneOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanBdGeom;
