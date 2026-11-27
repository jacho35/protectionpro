/* ProtectionPro — Plan drawing aids (the constraint stage behind PlanTools.snap).
 *
 * CAD-style help while drawing on the site plan and building plan:
 *   - object snaps on lines: intersection, midpoint, perpendicular (routes, trenches, room edges)
 *   - ortho (F8) / polar (F10, 15° steps) angle lock from the previous point; hold Ctrl to flip ortho for one click
 *   - alignment guides (F11): the x or y of a placed part, corner or route node pulls the point onto its line
 *   - a live length / angle tag, and typed input: digits = length (m), Tab = angle (°), Enter places the point
 * Every tool that calls PlanTools.snap gets it; a tool opts in with `aids: true` (all of it) or `'guides'`
 * (guides only, e.g. dragging a part) — set below. The "from" point is read off the tool's own draft, so no tool changed.
 * Shift and Alt are never used here: they mean add / remove a node on the plan.
 * Pure helpers (constrain, segHits, guideHits) take plain points so node tests can drive them.
 */
const PlanAids = {
  typed: null,     // {len, ang, field:'len'|'ang'} while the user types
  aid: null,       // what the last snap found, for the overlay: {from, pt, ang, len, guides, kind}
  anchor: null,    // the previous point of the draft being drawn
  ctrl: false,
  POLAR_TOL: 4 * Math.PI / 180,

  _s() { return AppState.planMarkup.settings; },
  guidesOn() { return this._s().snapGuides !== false; },
  segOn() { return this._s().snapSeg !== false; },
  polarOn() { return !!this._s().polar; },
  polarStep() { return (this._s().polarStep || 15) * Math.PI / 180; },
  // ortho: the setting, or (when never set) the default of the tool; Ctrl flips it while held
  orthoOn(def) { const s = this._s(), v = s.ortho === undefined ? !!def : !!s.ortho; return this.ctrl ? !v : v; },

  // The previous point of whatever the active tool is drawing, or null.
  anchorOf(tool) {
    if (!tool) return null;
    const last = (a) => (a && a.length ? a[a.length - 1] : null);
    if (tool._draft && tool._draft.points) return last(tool._draft.points);
    if (tool._pts && tool._pts.length) return last(tool._pts);
    if (tool._p1) return tool._p1;
    if (typeof PlanRoomDetect !== 'undefined' && PlanRoomDetect.mode === 'draw' && PlanRoomDetect.draft && PlanRoomDetect.draft.pts) return last(PlanRoomDetect.draft.pts);
    return null;
  },
  isRoomDraw() { return typeof PlanRoomDetect !== 'undefined' && PlanRoomDetect.mode === 'draw' && !!PlanRoomDetect.draft; },

  // ─── pure helpers ───
  // Lock the direction from `from` to `pt`. mode 'ortho' always locks to 90°; 'polar' only within POLAR_TOL of a step.
  // Returns {x, y, ang (screen radians)} or null when nothing is locked.
  constrain(pt, from, mode, step) {
    const dx = pt.x - from.x, dy = pt.y - from.y, d = Math.hypot(dx, dy);
    if (d < 1e-9) return null;
    const ang = Math.atan2(dy, dx);
    let a;
    if (mode === 'ortho') a = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    else {
      a = Math.round(ang / step) * step;
      if (Math.abs(ang - a) > this.POLAR_TOL) return null;
    }
    const len = d * Math.cos(ang - a);                 // the length along the locked ray
    return { x: from.x + len * Math.cos(a), y: from.y + len * Math.sin(a), ang: a, len };
  },

  _lines(ignore, fn) {
    const pm = AppState.planMarkup;
    for (const r of (pm.routes || [])) if (!ignore.has(r.id)) fn(r.points, false, r);
    for (const t of (pm.trenches || [])) if (!ignore.has(t.id) && t.points) fn(t.points, false);
    for (const rm of (pm.rooms || [])) {
      if (ignore.has(rm.id) || !rm.points) continue;
      fn(rm.points, !(rm.kind === 'perimeter' || rm.kind === 'escape' || rm.kind === 'obtrusive'));
    }
  },
  _segInter(a, b, c, d) {
    const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a.x + t * r.x, y: a.y + t * r.y };
  },
  // Intersection, midpoint and perpendicular snaps near `pt`. Returns the best {x, y, kind, d} or null.
  segHits(pt, from, tol, ignore) {
    const near = [], best = [];
    this._lines(ignore, (pts, closed) => {
      const n = pts.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if (pt.x < Math.min(a.x, b.x) - tol || pt.x > Math.max(a.x, b.x) + tol || pt.y < Math.min(a.y, b.y) - tol || pt.y > Math.max(a.y, b.y) + tol) continue;
        const dSeg = PlanEngine._distToSeg(pt, a, b);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dm = Math.hypot(pt.x - m.x, pt.y - m.y);
        if (dm <= tol) best.push({ x: m.x, y: m.y, kind: 'mid', rank: 1, d: dm });
        if (dSeg > tol * 1.6) continue;
        near.push([a, b]);
        if (from) {                                      // foot of the perpendicular from the previous point
          const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
          if (L2 > 1e-12) {
            const t = ((from.x - a.x) * vx + (from.y - a.y) * vy) / L2;
            if (t > 0.001 && t < 0.999) {
              const f = { x: a.x + t * vx, y: a.y + t * vy }, df = Math.hypot(pt.x - f.x, pt.y - f.y);
              if (df <= tol) best.push({ x: f.x, y: f.y, kind: 'perp', rank: 2, d: df });
            }
          }
        }
      }
    });
    const cap = Math.min(near.length, 40);
    for (let i = 0; i < cap; i++) for (let j = i + 1; j < cap; j++) {
      const q = this._segInter(near[i][0], near[i][1], near[j][0], near[j][1]);
      if (!q) continue;
      const dq = Math.hypot(pt.x - q.x, pt.y - q.y);
      if (dq <= tol) best.push({ x: q.x, y: q.y, kind: 'int', rank: 0, d: dq });
    }
    if (!best.length) return null;
    best.sort((p, q) => p.rank - q.rank || p.d - q.d);
    return best[0];
  },
  // which points of a line ride on a part being moved (a route end that follows its part is that part's old position)
  _riding(owner, pts, ignore) {
    return pts.map((p, i) => !!(owner && ((p.snappedTo && ignore.has(p.snappedTo)) || (i === 0 && ignore.has(owner.fromId)) || (i === pts.length - 1 && ignore.has(owner.toId)))));
  },
  // Smart guide: the point sits on the extension of a drawn line past its free end (open lines) or past either end of an edge (closed rooms).
  extHits(pt, tol, ignore) {
    const cap = 1500 / PlanEngine.view.zoom;
    let best = null;
    const consider = (a, b) => {                         // extend a→b beyond b
      const vx = b.x - a.x, vy = b.y - a.y, L = Math.hypot(vx, vy);
      if (L < tol * 2) return;
      const ux = vx / L, uy = vy / L, rx = pt.x - b.x, ry = pt.y - b.y;
      const t = rx * ux + ry * uy;
      if (t < tol || t > cap) return;
      const d = Math.abs(rx * uy - ry * ux);
      if (d > tol || (best && d >= best.d)) return;
      best = { x: b.x + t * ux, y: b.y + t * uy, d, src: { x: b.x, y: b.y } };
    };
    this._lines(ignore, (pts, closed, owner) => {
      const n = pts.length; if (n < 2) return;
      const rd = this._riding(owner, pts, ignore);
      if (closed) { for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (rd[i] || rd[j]) continue; consider(pts[i], pts[j]); consider(pts[j], pts[i]); } }
      else {
        if (!rd[0] && !rd[1]) consider(pts[1], pts[0]);
        if (!rd[n - 1] && !rd[n - 2]) consider(pts[n - 2], pts[n - 1]);
      }
    });
    return best;
  },
  // Smart guide: the direction from → pt runs parallel or square to a drawn segment near the pointer.
  parHits(pt, from, tol, ignore, orthoOn) {
    const dx = pt.x - from.x, dy = pt.y - from.y, d = Math.hypot(dx, dy);
    if (d < tol * 2) return null;
    const alpha = Math.atan2(dy, dx), R = 120 / PlanEngine.view.zoom, aTol = 3 * Math.PI / 180;
    let best = null;
    this._lines(ignore, (pts, closed, owner) => {
      const n = pts.length, rd = this._riding(owner, pts, ignore);
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const j = (i + 1) % n, a = pts[i], b = pts[j];
        if (rd[i] || rd[j] || Math.hypot(b.x - a.x, b.y - a.y) < tol * 2) continue;
        if (PlanEngine._distToSeg(pt, a, b) > R) continue;
        const th = Math.atan2(b.y - a.y, b.x - a.x);
        for (let k = 0; k < 2; k++) {
          const tgt = th + k * Math.PI / 2;
          if (orthoOn && Math.abs(Math.sin(2 * tgt)) < 0.02) continue;   // ortho already gives the axis directions
          let diff = alpha - tgt; diff = ((diff + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2;
          if (Math.abs(diff) > aTol || (best && Math.abs(diff) >= best.diff)) continue;
          best = { ang: alpha - diff, diff: Math.abs(diff), ref: [a, b], label: k ? 'perpendicular' : 'parallel' };
        }
      }
    });
    if (best) best.len = d * Math.cos(alpha - best.ang);
    return best && best.len > 0 ? best : null;
  },
  // Smart guide: along a row (axis 'x', parts sharing p.y) or column (axis 'y', sharing p.x) the pointer makes equal gaps,
  // either midway between two parts or one gap beyond the last pair.
  spaceHit(p, axis, tol, ignore) {
    const k = axis === 'x' ? 'y' : 'x', vals = [];
    for (const e of (AppState.planMarkup.elements || [])) if (!ignore.has(e.id) && Math.abs(e[k] - p[k]) <= 0.5) vals.push(e[axis]);
    vals.sort((a, b) => a - b);
    const v = vals.filter((x, i) => i === 0 || x - vals[i - 1] > 0.5);
    let best = null;
    const cand = (val, segs, d) => { const dist = Math.abs(p[axis] - val); if (dist <= tol && (!best || dist < best.dist)) best = { val, segs, d, dist }; };
    for (let i = 0; i < v.length - 1; i++) {
      const a = v[i], b = v[i + 1], d = b - a;
      if (d < tol * 2) continue;
      const m = (a + b) / 2;
      cand(m, [[a, m], [m, b]], d / 2);
      if (i === v.length - 2) cand(b + d, [[a, b], [b, b + d]], d);
      if (i === 0) cand(a - d, [[a - d, a], [a, b]], d);
    }
    return best;
  },
  // Points whose x or y lines up with `pt` within tol: {gx: {x, src}|null, gy: {y, src}|null}
  guideHits(pt, tol, ignore, from) {
    const pm = AppState.planMarkup;
    let gx = null, gy = null;
    const test = (p, label) => {
      const dx = Math.abs(p.x - pt.x), dy = Math.abs(p.y - pt.y);
      if (dx <= tol && (!gx || dx < gx.d)) gx = { x: p.x, src: p, d: dx, label };
      if (dy <= tol && (!gy || dy < gy.d)) gy = { y: p.y, src: p, d: dy, label };
    };
    for (const e of (pm.elements || [])) if (!ignore.has(e.id)) test(e, 'part');
    this._lines(ignore, (pts, closed, owner) => {
      const rd = this._riding(owner, pts, ignore), n = pts.length;
      for (let i = 0; i < n; i++) {
        // a route end that rides on a part being moved is that part's own old position: never a guide
        if (rd[i]) continue;
        test(pts[i], 'corner');
        const j = (i + 1) % n;                           // the middle of each edge lines up too (a whole wall, not just its corners)
        if ((closed || i < n - 1) && !rd[j] && n > 1) test({ x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 }, 'edge middle');
      }
    });
    if (from) test(from, 'previous point');
    return { gx, gy };
  },

  // ─── the snap pipeline (PlanTools.snap calls this) ───
  run(pt, o) {
    const T = PlanTools, tool = T.active, z = PlanEngine.view.zoom;
    if (T._force) {                                        // a typed point: exact, no snapping
      const f = T._force; T._force = null;
      return { x: f.x, y: f.y, snapped: 'typed', targetId: null };
    }
    const mode = o.aids !== undefined ? o.aids : (tool && tool.aids);
    const full = mode === true || this.isRoomDraw(), guidesOnly = mode === 'guides';
    const from = (full ? (o.from !== undefined ? o.from : this.anchorOf(tool)) : null) || null;
    this.anchor = from;
    let ignore = o.ignoreIds || new Set();
    if (guidesOnly && typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds && PlanMarkup.selectedIds.size) ignore = new Set([...ignore, ...PlanMarkup.selectedIds]);   // dragging: the picked parts move with the pointer, so never align to them
    const tol = 9 / z;
    const aid = { from, pt: null, guides: [], ang: null, len: null, kind: null };
    const done = (r) => { aid.pt = { x: r.x, y: r.y }; aid.kind = r.snapped; if (from) { aid.len = Math.hypot(r.x - from.x, r.y - from.y); aid.ang = Math.atan2(r.y - from.y, r.x - from.x); } this.aid = (from || aid.guides.length) ? aid : null; if (typeof PlanEngine !== 'undefined' && (from || aid.guides.length)) PlanEngine.requestDraw({ fg: true }); return r; };

    // 1) existing hard snaps (parts, corners, roof corners, DXF)
    const base = T._snapBase(pt, o, true);
    if (base.snapped) return done(base);
    // 2) object snaps on lines
    if ((full) && this.segOn()) {
      const h = this.segHits(pt, from, tol, ignore);
      if (h) return done({ x: h.x, y: h.y, snapped: h.kind, targetId: null });
    }
    let p = { x: pt.x, y: pt.y }, snappedKind = null;
    // 3) angle lock from the previous point: parallel / square to a nearby drawn line, else ortho / polar
    if (from) {
      const ortho = this.orthoOn(this.isRoomDraw());
      const par = this.guidesOn() ? this.parHits(p, from, tol, ignore, ortho) : null;
      const c = par || (ortho ? this.constrain(p, from, 'ortho') : (this.polarOn() ? this.constrain(p, from, 'polar', this.polarStep()) : null));
      if (c) {
        let len = c.len;
        const f = PlanEngine.factor(), s = this._s();
        if (s.snapGrid && f) { const st = s.gridSize / f; if (len > st) len = Math.round(len / st) * st; }
        p = { x: from.x + len * Math.cos(c.ang), y: from.y + len * Math.sin(c.ang) };
        snappedKind = ortho ? 'ortho' : 'polar';
        if (par) { aid.guides.push({ kind: 'par', ang: par.ang, ref: par.ref, label: par.label }); snappedKind = 'guide'; }
        // a guide that crosses the locked ray still pulls the length onto it
        else if (this.guidesOn()) this._rayGuide(p, from, c.ang, tol, ignore, aid);
        if (!par && aid.guides.length) { p = aid.guides[0].at; snappedKind = 'guide'; }
        return done({ x: p.x, y: p.y, snapped: snappedKind, targetId: null });
      }
    }
    // 4) alignment guides
    if ((full || guidesOnly) && this.guidesOn()) {
      const g = this.guideHits(p, tol, ignore, from);
      const ex = (g.gx && g.gy) ? null : this.extHits(p, tol, ignore);       // nearest guide only: an extension line beats a single, farther alignment
      if (ex && ex.d < (g.gx ? g.gx.d : g.gy ? g.gy.d : Infinity)) {
        aid.guides.push({ kind: 'ext', src: ex.src, label: 'extension' });
        return done({ x: ex.x, y: ex.y, snapped: 'guide', targetId: null });
      }
      if (g.gx || g.gy) {
        if (g.gx) p.x = g.gx.x;
        if (g.gy) p.y = g.gy.y;
        if (g.gx) aid.guides.push({ vertical: true, src: g.gx.src, label: g.gx.label });
        if (g.gy) aid.guides.push({ vertical: false, src: g.gy.src, label: g.gy.label });
        // lined up on a row or column of parts: the pointer may also make the gaps equal
        for (const axis of ['x', 'y']) {
          const al = axis === 'x' ? g.gy : g.gx, cross = axis === 'x' ? g.gx : g.gy;     // the row / column the pointer is lined up on
          const sh = al ? this.spaceHit(p, axis, tol, ignore) : null;
          if (!sh || (cross && sh.dist > cross.d)) continue;                              // equal spacing wins a tie with a single alignment
          p[axis] = sh.val;
          const gi = aid.guides.findIndex(q => q.vertical === (axis === 'x'));            // the alignment it replaced
          if (gi >= 0) aid.guides.splice(gi, 1);
          aid.guides.push({ kind: 'space', axis, fixed: axis === 'x' ? p.y : p.x, segs: sh.segs, d: sh.d, label: 'equal spacing' });
          break;
        }
        return done({ x: p.x, y: p.y, snapped: 'guide', targetId: null });
      }
    }
    // 5) grid
    const gr = T._snapBase(pt, { wantElements: false, wantRoof: false, wantDxf: false });
    if (gr.snapped === 'grid') return done(gr);
    return done({ x: pt.x, y: pt.y, snapped: null, targetId: null });
  },
  // where the locked ray crosses the x / y of another point (so ortho lines up with things too)
  _rayGuide(p, from, ang, tol, ignore, aid) {
    const cs = Math.cos(ang), sn = Math.sin(ang), pm = AppState.planMarkup;
    let bestD = tol, hit = null;
    const test = (q, label) => {
      let t = null;
      if (Math.abs(cs) > 0.99) { t = (q.x - from.x) / cs; if (Math.abs(q.x - p.x) > tol) return; }
      else if (Math.abs(sn) > 0.99) { t = (q.y - from.y) / sn; if (Math.abs(q.y - p.y) > tol) return; }
      else return;
      if (t <= 0) return;
      const at = { x: from.x + t * cs, y: from.y + t * sn }, d = Math.hypot(at.x - p.x, at.y - p.y);
      if (d < bestD) { bestD = d; hit = { at, src: q, label, vertical: Math.abs(cs) > 0.99 }; }
    };
    for (const e of (pm.elements || [])) if (!ignore.has(e.id)) test(e, 'part');
    this._lines(ignore, (pts) => { for (const q of pts) test(q, 'corner'); });
    if (hit) aid.guides.push(hit);
  },

  // ─── overlay ───
  clear() { this.aid = null; this.typed = null; if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true }); },
  _fmt(px) {
    const f = PlanEngine.factor();
    return f ? `${(px * f).toFixed(2)} m` : `${Math.round(px)} px`;
  },
  _deg(rad) { return ((-rad * 180 / Math.PI) % 360 + 360) % 360; },
  draw(ctx, zoom) {
    const a = this.aid;
    if (!a) return;
    const u = 1 / zoom;
    ctx.save();
    ctx.lineWidth = 1.2 * u;
    let li = 0;
    const tag = (t) => { ctx.fillStyle = '#a21caf'; ctx.font = `${11 * u}px sans-serif`; ctx.fillText(t, a.pt.x + 10 * u, a.pt.y - 8 * u - 13 * u * li++); };
    for (const g of a.guides) {
      ctx.strokeStyle = '#d946ef'; ctx.setLineDash([5 * u, 4 * u]);
      ctx.beginPath();
      if (g.kind === 'ext') { ctx.moveTo(g.src.x, g.src.y); ctx.lineTo(a.pt.x, a.pt.y); ctx.stroke(); tag(g.label); continue; }
      if (g.kind === 'par') {
        const L = 4000 * u, cs = Math.cos(g.ang), sn = Math.sin(g.ang);
        ctx.moveTo(a.from.x - L * cs, a.from.y - L * sn); ctx.lineTo(a.from.x + L * cs, a.from.y + L * sn); ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 3 * u; ctx.beginPath(); ctx.moveTo(g.ref[0].x, g.ref[0].y); ctx.lineTo(g.ref[1].x, g.ref[1].y); ctx.stroke(); ctx.lineWidth = 1.2 * u;
        tag(g.label); continue;
      }
      if (g.kind === 'space') {
        ctx.setLineDash([]);
        const pt = (v) => g.axis === 'x' ? { x: v, y: g.fixed } : { x: g.fixed, y: v };
        for (const [v0, v1] of g.segs) {
          const p0 = pt(v0), p1 = pt(v1);
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          for (const q of [p0, p1]) { if (g.axis === 'x') { ctx.moveTo(q.x, q.y - 5 * u); ctx.lineTo(q.x, q.y + 5 * u); } else { ctx.moveTo(q.x - 5 * u, q.y); ctx.lineTo(q.x + 5 * u, q.y); } }
          ctx.stroke();
          ctx.fillStyle = '#a21caf'; ctx.font = `${11 * u}px sans-serif`; ctx.fillText(this._fmt(g.d), (p0.x + p1.x) / 2 + 3 * u, (p0.y + p1.y) / 2 - 6 * u);
        }
        tag(g.label); continue;
      }
      if (g.vertical === undefined || g.vertical) { ctx.moveTo(g.src.x, g.src.y); ctx.lineTo(g.src.x, a.pt.y); }
      else { ctx.moveTo(g.src.x, g.src.y); ctx.lineTo(a.pt.x, g.src.y); }
      ctx.stroke();
      tag(`aligned · ${g.label}`);
    }
    ctx.setLineDash([]);
    if (a.from && a.pt) {
      // rays: the locked direction extended, faint, while an angle lock is on
      if (a.kind === 'ortho' || a.kind === 'polar') {
        ctx.strokeStyle = 'rgba(217,72,15,0.45)'; ctx.setLineDash([6 * u, 6 * u]);
        const L = 4000 * u, cs = Math.cos(a.ang), sn = Math.sin(a.ang);
        ctx.beginPath(); ctx.moveTo(a.from.x - L * cs, a.from.y - L * sn); ctx.lineTo(a.from.x + L * cs, a.from.y + L * sn); ctx.stroke();
        ctx.setLineDash([]);
      }
      let len = a.len, ang = a.ang, typedTxt = '';
      const ty = this.typed;
      if (ty && (ty.len || ty.ang)) {
        const f = PlanEngine.factor() || 1;
        if (ty.len) len = parseFloat(ty.len.replace(',', '.')) / f;
        if (ty.ang) ang = -parseFloat(ty.ang.replace(',', '.')) * Math.PI / 180;
        if (isFinite(len) && isFinite(ang)) {
          const q = { x: a.from.x + len * Math.cos(ang), y: a.from.y + len * Math.sin(ang) };
          ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.moveTo(a.from.x, a.from.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          ctx.beginPath(); ctx.arc(q.x, q.y, 6 * u, 0, Math.PI * 2); ctx.stroke();
        }
        typedTxt = `${ty.field === 'len' ? '▸' : ' '}${ty.len || '…'} m   ${ty.field === 'ang' ? '▸' : ' '}${ty.ang || '…'}°`;
      }
      const lbl = typedTxt || `${this._fmt(a.len)}  ${Math.round(this._deg(a.ang) * 10) / 10}°${a.kind === 'ortho' ? '  ORTHO' : a.kind === 'polar' ? '  POLAR' : ''}`;
      ctx.font = `600 ${12 * u}px ui-monospace, monospace`;
      const w = ctx.measureText(lbl).width + 12 * u, h = 20 * u, x = a.pt.x + 14 * u, y = a.pt.y + 14 * u;
      ctx.fillStyle = 'rgba(20,32,43,0.92)'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#fff'; ctx.fillText(lbl, x + 6 * u, y + 14 * u);
    }
    ctx.restore();
  },
  // the snap ring glyph per kind (called by PlanTools._drawSnapRing)
  glyph(ctx, x, y, kind, zoom) {
    const r = 7 / zoom;
    ctx.save(); ctx.lineWidth = 1.8 / zoom;
    if (kind === 'int') { ctx.strokeStyle = '#d9480f'; ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }
    else if (kind === 'mid') { ctx.strokeStyle = '#1d6b3a'; ctx.beginPath(); ctx.moveTo(x - r, y + r * 0.8); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x, y - r); ctx.closePath(); ctx.stroke(); }
    else if (kind === 'perp') { ctx.strokeStyle = '#2563eb'; ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y); ctx.lineTo(x, y); ctx.lineTo(x, y + r); ctx.stroke(); }
    else if (kind === 'guide') { ctx.strokeStyle = '#d946ef'; ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }
    else if (kind === 'ortho' || kind === 'polar') { ctx.strokeStyle = '#d9480f'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.restore(); return false; }
    ctx.restore(); return true;
  },

  // ─── keys (called first by PlanMarkup.onKeydown; true = consumed) ───
  _toggle(key, label) {
    const s = this._s(); let on;
    if (key === 'ortho') { on = !this.orthoOn(this.isRoomDraw()); s.ortho = on; if (on) s.polar = false; }
    else { on = key === 'polar' ? !s.polar : s[key] === false; s[key] = key === 'polar' ? on : on; if (key === 'polar' && on) s.ortho = false; }
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup._syncSnapPop && PlanMarkup._syncSnapPop(); PlanMarkup.updateScaleReadout && PlanMarkup.updateScaleReadout(); PlanMarkup.markDirty && PlanMarkup.markDirty(); }
    if (typeof UI !== 'undefined' && UI.toast) UI.toast(`${label} ${on ? 'on' : 'off'}.`, 'info', 1500);
    return true;
  },
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'F8') { e.preventDefault(); return this._toggle('ortho', 'Ortho'); }
    if (e.key === 'F10') { e.preventDefault(); return this._toggle('polar', 'Polar 15°'); }
    if (e.key === 'F11') { e.preventDefault(); return this._toggle('snapGuides', 'Alignment guides'); }
    if (e.key === 'F3') { e.preventDefault(); return this._toggle('snapSeg', 'Line snaps (intersection, midpoint, perpendicular)'); }
    if (!this.anchor || !PlanTools.active) { this.typed = null; return false; }
    const t = this.typed;
    if (/^[0-9.,]$/.test(e.key)) {
      const ty = this.typed || (this.typed = { len: '', ang: '', field: 'len' });
      const f = ty.field;
      if (e.key !== '.' && e.key !== ',' || !/[.,]/.test(ty[f])) ty[f] += e.key;
      PlanEngine.requestDraw({ fg: true }); return true;
    }
    if (!t) return false;
    if (e.key === 'Tab') { t.field = t.field === 'len' ? 'ang' : 'len'; PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Backspace') {
      if (t[t.field]) t[t.field] = t[t.field].slice(0, -1);
      else if (t.field === 'ang') t.field = 'len';
      else this.typed = null;
      PlanEngine.requestDraw({ fg: true }); return true;
    }
    if (e.key === 'Escape') { this.typed = null; PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Enter') return this.commitTyped();
    return false;
  },
  commitTyped() {
    const t = this.typed, a = this.aid;
    if (!t || !a || !a.from) { this.typed = null; return false; }
    const f = PlanEngine.factor() || 1;
    const m = parseFloat((t.len || '').replace(',', '.'));
    if (!(m > 0)) { UI.toast && UI.toast('Type a length first, then Tab for the angle.', 'info', 2000); return true; }
    const ang = t.ang ? -parseFloat(t.ang.replace(',', '.')) * Math.PI / 180 : a.ang;
    const px = m / f, q = { x: a.from.x + px * Math.cos(ang), y: a.from.y + px * Math.sin(ang) };
    this.typed = null;
    PlanTools._force = q;
    try { PlanTools.active.onDown({ x: q.x, y: q.y }, { shiftKey: false, altKey: false, ctrlKey: false, button: 0 }); }
    finally { PlanTools._force = null; }
    PlanEngine.requestDraw({ fg: true });
    if (typeof PlanTools._notifyDraft === 'function') PlanTools._notifyDraft();
    return true;
  },
  init() {
    const flip = (e) => { if (e.key === 'Control' && this.ctrl !== (e.type === 'keydown')) { this.ctrl = e.type === 'keydown'; if (this.anchor && PlanEngine.requestDraw) PlanEngine.requestDraw({ fg: true }); } };
    document.addEventListener('keydown', flip); document.addEventListener('keyup', flip);
    window.addEventListener('blur', () => { this.ctrl = false; });
    // tools that take part: everything that places or draws points
    for (const id of ['place', 'placeRetic', 'placeSld', 'route', 'crossing', 'roofkeepout', 'workarea', 'devpath', 'array']) if (PlanTools._tools[id]) PlanTools._tools[id].aids = true;
    if (PlanTools._tools.select) PlanTools._tools.select.aids = 'guides';
  },
};
if (typeof document !== 'undefined') PlanAids.init();
if (typeof module !== 'undefined') module.exports = PlanAids;
