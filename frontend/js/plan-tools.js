/* ProtectionPro — Plan Markup tools + snapping.
 *
 * A tiny tool registry so retic tools (trench, crossing, SL path) and building
 * tools can share one engine: each tool is a state machine over its own
 * `_draft`, receiving world-space pointer events from PlanEngine. Phase 1
 * ships select / place / route / calibrate; later phases register more tools
 * against the same interface with no engine change.
 */

const PlanTools = {
  _tools: {},
  active: null,
  opts: {},

  register(tool) { this._tools[tool.id] = tool; },

  set(id, opts) {
    const next = this._tools[id];
    if (!next) return;
    if (this.active && this.active.onDeactivate) this.active.onDeactivate();
    this.active = next;
    this.opts = opts || {};
    if (next.onActivate) next.onActivate(this.opts);
    this.applyCursor();
    // Reflect the armed tool in the toolbar/palette.
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.onToolChanged) PlanMarkup.onToolChanged(id, this.opts);
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  applyCursor() {
    if (typeof PlanEngine === 'undefined' || !PlanEngine.fg) return;
    PlanEngine.fg.style.cursor = (this.active && this.active.cursor) || 'default';
  },

  cancel() {
    if (this.active && this.active.cancel) this.active.cancel();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  onDown(pt, e) { if (this.active && this.active.onDown) this.active.onDown(pt, e); },
  onMove(pt, e) { if (this.active && this.active.onMove) this.active.onMove(pt, e); },
  onUp(pt, e) { if (this.active && this.active.onUp) this.active.onUp(pt, e); },
  onKey(e) { return this.active && this.active.onKey ? this.active.onKey(e) : false; },
  drawOverlay(ctx, zoom) { if (this.active && this.active.drawOverlay) this.active.drawOverlay(ctx, zoom); },

  // ─── Snapping ───
  // Priority: vertex → element anchor → route projection → metric grid.
  // Each stage gated by the matching settings.snap* flag. Returns
  // {x, y, snapped: 'vtx'|'el'|'route'|'grid'|null, targetId}.
  snap(pt, o) {
    o = o || {};
    const pm = AppState.planMarkup;
    const s = pm.settings;
    const z = PlanEngine.view.zoom;
    const ignore = o.ignoreIds || new Set();

    // element anchors (centres)
    if (s.snapEl && o.wantElements !== false) {
      const el = PlanEngine.findElementAt(pt, 12);
      if (el && !ignore.has(el.id)) return { x: el.x, y: el.y, snapped: 'el', targetId: el.id };
    }
    // route vertices
    if (s.snapVtx) {
      for (const r of pm.routes) {
        if (ignore.has(r.id)) continue;
        const vi = PlanEngine.findVertexAt(r.points, pt, 8);
        if (vi >= 0) return { x: r.points[vi].x, y: r.points[vi].y, snapped: 'vtx', targetId: r.id };
      }
    }
    // grid (only when calibrated)
    if (s.snapGrid) {
      const f = PlanEngine.factor();
      if (f) {
        const step = s.gridSize / f;
        return { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step, snapped: 'grid', targetId: null };
      }
    }
    return { x: pt.x, y: pt.y, snapped: null, targetId: null };
  },

  // Draw a small ring at a snapped point (shared by tools).
  _drawSnapRing(ctx, x, y, kind, zoom) {
    if (!kind) return;
    const r = 7 / zoom;
    ctx.save();
    ctx.strokeStyle = kind === 'el' ? '#22c55e' : (kind === 'vtx' ? '#2563eb' : '#94a3b8');
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },
};

// ─────────────────────────────────────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'select', cursor: 'default',
  _drag: null,       // {kind:'element'|'vertex'|'rotate', ...}
  _marquee: null,    // {start:{x,y}, cur:{x,y}}
  _lastClick: null,  // {x, y, ids:[...], index} for tie-break cycling

  onActivate() { this._drag = null; this._marquee = null; },
  cancel() { this._drag = null; this._marquee = null; PlanEngine.requestDraw({ fg: true }); },

  onDown(pt, e) {
    const pm = AppState.planMarkup;
    const z = PlanEngine.view.zoom;

    // 0) rotate handle of a single selected rotatable element
    const rot = this._rotateHandle();
    if (rot && Math.hypot(pt.x - rot.hx, pt.y - rot.hy) <= 9 / z) {
      this._drag = { kind: 'rotate', el: rot.el, moved: false };
      return;
    }
    // 1) route vertex of an already-selected route (fine control)
    for (const r of pm.routes) {
      if (!PlanMarkup.selectedIds.has(r.id)) continue;
      const vi = PlanEngine.findVertexAt(r.points, pt, 8);
      if (vi >= 0) { this._drag = { kind: 'vertex', route: r, index: vi, moved: false }; return; }
    }
    // 2) shift+click on a route segment inserts a vertex
    const rhShift = e.shiftKey ? PlanEngine.findRouteAt(pt) : null;
    if (rhShift) {
      const snapped = PlanTools.snap(pt, { ignoreIds: new Set([rhShift.route.id]) });
      rhShift.route.points.splice(rhShift.segIndex + 1, 0, { x: snapped.x, y: snapped.y });
      PlanMarkup.selectOnly(rhShift.route.id);
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      PlanEngine.requestDraw({ fg: true });
      return;
    }
    // 3) hit stack (element > route > trench > text) with tie-break cycling
    const stack = this._hitStack(pt);
    if (stack.length) {
      const id = this._tieBreak(pt, stack);
      if (e.shiftKey) { PlanMarkup.toggleSelect(id); return; }
      if (!PlanMarkup.selectedIds.has(id)) PlanMarkup.selectOnly(id);
      // Begin drag if it's an element
      const found = PlanMarkup.findEntityById(id);
      if (found && found.kind === 'element') {
        this._drag = { kind: 'element', el: found.item, moved: false };
      }
      return;
    }
    // 4) empty space → marquee (or clear)
    this._lastClick = null;
    if (!e.shiftKey) PlanMarkup.clearSelection();
    this._marquee = { start: { x: pt.x, y: pt.y }, cur: { x: pt.x, y: pt.y }, add: e.shiftKey };
    PlanEngine.requestDraw({ fg: true });
  },

  onMove(pt) {
    if (this._marquee) { this._marquee.cur = { x: pt.x, y: pt.y }; PlanEngine.requestDraw({ fg: true }); return; }
    if (!this._drag) return;
    if (this._drag.kind === 'rotate') {
      const el = this._drag.el;
      let deg = Math.atan2(pt.x - el.x, -(pt.y - el.y)) * 180 / Math.PI; // 0 = straight up
      el.rotation = ((Math.round(deg) % 360) + 360) % 360;
      this._drag.moved = true;
      PlanEngine.requestDraw({ fg: true });
      return;
    }
    const snapped = PlanTools.snap(pt, {
      ignoreIds: this._drag.kind === 'vertex' ? new Set([this._drag.route.id]) : new Set([this._drag.el.id]),
    });
    if (this._drag.kind === 'element') {
      // Move the whole multi-selection by the same delta.
      const dx = snapped.x - this._drag.el.x, dy = snapped.y - this._drag.el.y;
      this._moveSelection(dx, dy, this._drag.el.id);
      this._drag.el.x = snapped.x; this._drag.el.y = snapped.y;
      this._drag.moved = true;
    } else if (this._drag.kind === 'vertex') {
      const p = this._drag.route.points[this._drag.index];
      p.x = snapped.x; p.y = snapped.y;
      this._drag.moved = true;
    }
    PlanEngine.requestDraw({ fg: true });
  },

  onUp() {
    if (this._marquee) {
      const r = this._rect(this._marquee.start, this._marquee.cur);
      if (r.w > 2 || r.h > 2) {
        const ids = this._entitiesInRect(r);
        if (this._marquee.add) ids.forEach(id => PlanMarkup.selectedIds.add(id));
        else PlanMarkup.setSelection(ids);
        PlanMarkup.refreshProps();
      }
      this._marquee = null;
      PlanEngine.requestDraw({ fg: true });
      return;
    }
    if (this._drag && this._drag.moved) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); }
    this._drag = null;
  },

  // Move every selected element / route / trench / text by (dx,dy) except the
  // element being directly dragged (already moved by the snap target).
  _moveSelection(dx, dy, exceptId) {
    if (!dx && !dy) return;
    for (const id of PlanMarkup.selectedIds) {
      if (id === exceptId) continue;
      const f = PlanMarkup.findEntityById(id);
      if (!f) continue;
      if (f.kind === 'element') { f.item.x += dx; f.item.y += dy; }
      else if (f.kind === 'text') { f.item.x += dx; f.item.y += dy; }
      else if (f.kind === 'crossing') { f.item.p1.x += dx; f.item.p1.y += dy; f.item.p2.x += dx; f.item.p2.y += dy; }
      else if (f.item.points) for (const p of f.item.points) { p.x += dx; p.y += dy; }
    }
  },

  _hitStack(pt) {
    const out = [];
    const el = PlanEngine.findElementAt(pt); if (el) out.push(el.id);
    const rh = PlanEngine.findRouteAt(pt); if (rh) out.push(rh.route.id);
    const th = PlanEngine.findTrenchAt(pt); if (th) out.push(th.trench.id);
    const tx = this._textAt(pt); if (tx) out.push(tx.id);
    const rm = PlanEngine.findRoomAt(pt); if (rm) out.push(rm.id);
    return out;
  },

  // Repeated clicks at the same spot cycle through overlapping entities.
  _tieBreak(pt, ids) {
    const tol = 6 / PlanEngine.view.zoom;
    const lc = this._lastClick;
    const same = lc && Math.hypot(pt.x - lc.x, pt.y - lc.y) <= tol &&
      lc.ids.length === ids.length && lc.ids.every((v, i) => v === ids[i]);
    const index = same ? (lc.index + 1) % ids.length : 0;
    this._lastClick = { x: pt.x, y: pt.y, ids, index };
    return ids[index];
  },

  _rotateHandle() {
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length !== 1) return null;
    const f = PlanMarkup.findEntityById(ids[0]);
    if (!f || f.kind !== 'element') return null;
    const def = PLAN_DEFS.element(f.item.type);
    if (!def || !def.rotatable) return null;
    const half = PlanEngine.glyphHalf(f.item.type);
    return { el: f.item, hx: f.item.x, hy: f.item.y - half - 18 / PlanEngine.view.zoom };
  },

  _rect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; },

  _ptIn(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; },

  _entitiesInRect(r) {
    const pm = AppState.planMarkup, ids = [];
    for (const el of pm.elements) if (this._ptIn(el, r)) ids.push(el.id);
    for (const rt of pm.routes) if (rt.points.some(p => this._ptIn(p, r))) ids.push(rt.id);
    for (const t of pm.trenches) if (t.points.some(p => this._ptIn(p, r))) ids.push(t.id);
    for (const c of pm.crossings) if (this._ptIn(c.p1, r) || this._ptIn(c.p2, r)) ids.push(c.id);
    for (const tx of pm.texts) if (this._ptIn(tx, r)) ids.push(tx.id);
    for (const m of pm.measurements) if (m.points.some(p => this._ptIn(p, r))) ids.push(m.id);
    for (const rm of (pm.rooms || [])) if (rm.points.some(p => this._ptIn(p, r))) ids.push(rm.id);
    return ids;
  },

  _textAt(pt) {
    const tol = 14 / PlanEngine.view.zoom;
    for (let i = AppState.planMarkup.texts.length - 1; i >= 0; i--) {
      const t = AppState.planMarkup.texts[i];
      if (pt.x >= t.x - tol && pt.x <= t.x + tol * 6 && pt.y >= t.y - tol && pt.y <= t.y + tol) return t;
    }
    return null;
  },

  drawOverlay(ctx, zoom) {
    if (this._marquee) {
      const r = this._rect(this._marquee.start, this._marquee.cur);
      ctx.save();
      ctx.strokeStyle = '#2563eb'; ctx.fillStyle = 'rgba(37,99,235,0.08)';
      ctx.lineWidth = 1 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.restore();
    }
    const rot = this._rotateHandle();
    if (rot) {
      ctx.save();
      ctx.strokeStyle = '#2563eb'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath(); ctx.moveTo(rot.el.x, rot.el.y); ctx.lineTo(rot.hx, rot.hy); ctx.stroke();
      ctx.beginPath(); ctx.arc(rot.hx, rot.hy, 5 / zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────
// PLACE (point elements)
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'place', cursor: 'crosshair',
  _ghost: null,
  onActivate(opts) { this._type = opts.type; this._ghost = null; },
  cancel() { this._ghost = null; if (typeof PlanMarkup !== 'undefined') PlanTools.set('select'); },

  onMove(pt) {
    const s = PlanTools.snap(pt, { wantElements: false });
    this._ghost = s;
    PlanEngine.requestDraw({ fg: true });
  },

  onDown(pt) {
    const s = PlanTools.snap(pt, { wantElements: false });
    const type = this._type;
    const def = PLAN_DEFS.element(type);
    if (!def) return;
    const el = {
      id: AppState.planGenId('pmel'),
      type, x: s.x, y: s.y, rotation: 0,
      name: PlanMarkup.nextName(type),
      reticId: null,
      props: PLAN_DEFS.defaults(type),
    };
    AppState.planMarkup.elements.push(el);
    PlanMarkup.selectOnly(el.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },

  onKey(e) { if (e.key === 'Escape') { this.cancel(); return true; } return false; },

  drawOverlay(ctx, zoom) {
    if (!this._ghost) return;
    const def = PLAN_DEFS.element(this._type);
    const color = def ? def.color : '#64748b';
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(this._ghost.x, this._ghost.y);
    PLAN_DEFS.drawElement(ctx, def, { sizePx: 12 / zoom, color, selected: false, strokeW: 1.5 / zoom });
    ctx.restore();
    PlanTools._drawSnapRing(ctx, this._ghost.x, this._ghost.y, this._ghost.snapped, zoom);
  },
});

// ─────────────────────────────────────────────────────────────────────────
// ROUTE (polyline; endpoints may be required to land on elements)
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'route', cursor: 'crosshair',
  _draft: null,   // {type, fromId, points:[{x,y,snappedTo}]}
  _hover: null,
  onActivate(opts) { this._type = opts.type; this._draft = null; this._hover = null; },
  cancel() { this._draft = null; this._hover = null; },

  onMove(pt) {
    this._hover = PlanTools.snap(pt);
    PlanEngine.requestDraw({ fg: true });
  },

  onDown(pt) {
    const def = PLAN_DEFS.route(this._type);
    const requiresEnds = def && def.requiresEndpoints;
    const snapped = PlanTools.snap(pt);
    if (!this._draft) {
      if (requiresEnds && snapped.snapped !== 'el') {
        UI.toast(`${def.name} must start on a component.`, 'warn');
        return;
      }
      this._draft = {
        type: this._type,
        fromId: snapped.snapped === 'el' ? snapped.targetId : null,
        points: [{ x: snapped.x, y: snapped.y, snappedTo: snapped.targetId || undefined }],
      };
      return;
    }
    // Clicking an element ends the route (for endpoint-bound routes)
    if (snapped.snapped === 'el') {
      this._draft.points.push({ x: snapped.x, y: snapped.y, snappedTo: snapped.targetId });
      this._finalize(snapped.targetId);
      return;
    }
    this._draft.points.push({ x: snapped.x, y: snapped.y });
    PlanEngine.requestDraw({ fg: true });
  },

  onKey(e) {
    if (e.key === 'Escape') { this._draft = null; PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Enter') { this._finalize(null); return true; }
    return false;
  },

  _finalize(toId) {
    const d = this._draft;
    if (!d || d.points.length < 2) { this._draft = null; PlanEngine.requestDraw({ fg: true }); return; }
    const def = PLAN_DEFS.route(d.type);
    if (def && def.requiresEndpoints && (!d.fromId || !toId)) {
      UI.toast(`${def.name} must end on a component.`, 'warn');
      return; // keep drawing
    }
    const route = {
      id: AppState.planGenId('pmrt'),
      type: d.type,
      fromId: d.fromId || null,
      toId: toId || null,
      points: d.points.map(p => ({ x: p.x, y: p.y, ...(p.snappedTo ? { snappedTo: p.snappedTo } : {}) })),
      cableType: PLAN_DEFS.defaults(d.type).cableType || '',
      curved: false,
      props: {},
    };
    AppState.planMarkup.routes.push(route);
    // T-junction: if an endpoint lands mid-way along another route, split that
    // route there (insert a shared vertex) so the network is connected.
    this._tJunction(route.points[0], route.id);
    this._tJunction(route.points[route.points.length - 1], route.id);
    this._draft = null;
    PlanMarkup.selectOnly(route.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },

  _tJunction(p, exceptId) {
    const tol = 6 / PlanEngine.view.zoom;
    for (const r of AppState.planMarkup.routes) {
      if (r.id === exceptId) continue;
      // Skip if the point already coincides with one of r's vertices.
      if (r.points.some(v => Math.hypot(v.x - p.x, v.y - p.y) <= tol)) continue;
      for (let s = 1; s < r.points.length; s++) {
        if (PlanEngine._distToSeg(p, r.points[s - 1], r.points[s]) <= tol) {
          r.points.splice(s, 0, { x: p.x, y: p.y });
          return; // one split per endpoint
        }
      }
    }
  },

  drawOverlay(ctx, zoom) {
    const def = PLAN_DEFS.route(this._type);
    const color = def ? def.color : '#3b82f6';
    if (this._draft) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = ((def && def.width) || 2) / zoom;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.beginPath();
      ctx.moveTo(this._draft.points[0].x, this._draft.points[0].y);
      for (let i = 1; i < this._draft.points.length; i++) ctx.lineTo(this._draft.points[i].x, this._draft.points[i].y);
      if (this._hover) ctx.lineTo(this._hover.x, this._hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (this._hover) PlanTools._drawSnapRing(ctx, this._hover.x, this._hover.y, this._hover.snapped, zoom);
  },
});

// ─────────────────────────────────────────────────────────────────────────
// CALIBRATE (2 clicks + real distance)
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'calibrate', cursor: 'crosshair',
  _p1: null, _hover: null, _busy: false,
  onActivate() { this._p1 = null; this._hover = null; this._busy = false; },
  cancel() { this._p1 = null; this._hover = null; },

  onMove(pt) { this._hover = pt; if (this._p1) PlanEngine.requestDraw({ fg: true }); },

  async onDown(pt) {
    if (this._busy) return;
    if (!this._p1) { this._p1 = { x: pt.x, y: pt.y }; return; }
    const p1 = this._p1, p2 = { x: pt.x, y: pt.y };
    const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (pxDist < 1) { this._p1 = null; return; }
    this._busy = true;
    const prev = AppState.planMarkup.scale ? String(AppState.planMarkup.scale.realDist) : '';
    const ans = await UI.prompt('Real-world distance between the two points (metres):', prev || '');
    this._busy = false;
    this._p1 = null;
    const realDist = parseFloat(ans);
    if (!ans || !isFinite(realDist) || realDist <= 0) { PlanEngine.requestDraw({ fg: true }); return; }
    AppState.planMarkup.scale = { p1, p2, realDist, pxDist, factor: realDist / pxDist };
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanMarkup.updateScaleReadout();
    PlanEngine.requestDraw({ all: true });
    PlanTools.set('select');
  },

  onKey(e) { if (e.key === 'Escape') { this._p1 = null; PlanEngine.requestDraw({ fg: true }); return true; } return false; },

  drawOverlay(ctx, zoom) {
    if (this._p1) {
      ctx.save();
      ctx.strokeStyle = '#e11d48'; ctx.lineWidth = 2 / zoom;
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.beginPath(); ctx.moveTo(this._p1.x, this._p1.y);
      if (this._hover) ctx.lineTo(this._hover.x, this._hover.y);
      ctx.stroke(); ctx.setLineDash([]);
      const r = 4 / zoom;
      ctx.fillStyle = '#e11d48';
      ctx.beginPath(); ctx.arc(this._p1.x, this._p1.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Shared polyline draft tool factory (TRENCH, MEASURE) — click to add points,
// Enter/double-click to finish, Esc to abort.
// ─────────────────────────────────────────────────────────────────────────
function makePolylineTool(id, color, commit) {
  return {
    id, cursor: 'crosshair', _pts: null, _hover: null,
    onActivate(opts) { this._opts = opts || {}; this._pts = null; this._hover = null; },
    cancel() { this._pts = null; this._hover = null; },
    onMove(pt) { this._hover = PlanTools.snap(pt); PlanEngine.requestDraw({ fg: true }); },
    onDown(pt) {
      const s = PlanTools.snap(pt);
      if (!this._pts) this._pts = [{ x: s.x, y: s.y }];
      else this._pts.push({ x: s.x, y: s.y });
      PlanEngine.requestDraw({ fg: true });
    },
    onKey(e) {
      if (e.key === 'Escape') { this._pts = null; PlanEngine.requestDraw({ fg: true }); return true; }
      if (e.key === 'Enter') { this._finish(); return true; }
      return false;
    },
    _finish() {
      if (this._pts && this._pts.length >= 2) commit(this._pts.slice(), this._opts);
      this._pts = null;
      PlanEngine.requestDraw({ fg: true });
    },
    drawOverlay(ctx, zoom) {
      if (this._pts) {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([6 / zoom, 4 / zoom]);
        ctx.beginPath();
        ctx.moveTo(this._pts[0].x, this._pts[0].y);
        for (let i = 1; i < this._pts.length; i++) ctx.lineTo(this._pts[i].x, this._pts[i].y);
        if (this._hover) ctx.lineTo(this._hover.x, this._hover.y);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
      }
      if (this._hover) PlanTools._drawSnapRing(ctx, this._hover.x, this._hover.y, this._hover.snapped, zoom);
    },
  };
}

// TRENCH — excavation band (opts.type = excType)
PlanTools.register(makePolylineTool('trench', '#7c3aed', (pts, opts) => {
  const excType = (opts && opts.type) || 'LV/SL';
  const t = {
    id: AppState.planGenId('pmtr'),
    name: PlanMarkup.nextCounter('_trench', 'T'),
    excType, points: pts, widthOverride: null, depthOverride: null,
  };
  AppState.planMarkup.trenches.push(t);
  PlanMarkup.selectOnly(t.id);
  PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
}));

// MEASURE — persisted dimension line/polyline
PlanTools.register(makePolylineTool('measurement', '#0ea5e9', (pts) => {
  const m = { id: AppState.planGenId('pmms'), points: pts };
  AppState.planMarkup.measurements.push(m);
  PlanMarkup.snapshot(); PlanMarkup.markDirty();
}));

// ROOM — closed-polygon zone (Enter closes; needs ≥3 points)
PlanTools.register(makePolylineTool('room', PLAN_DEFS.room.stroke, (pts) => {
  if (pts.length < 3) { UI.toast('A room needs at least 3 points.', 'warn'); return; }
  const r = { id: AppState.planGenId('pmrm'), name: PlanMarkup.nextCounter('_room', 'Room '), points: pts, color: null };
  AppState.planMarkup.rooms.push(r);
  PlanMarkup.selectOnly(r.id);
  PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
}));

// ─────────────────────────────────────────────────────────────────────────
// CROSSING — 2-click road crossing
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'crossing', cursor: 'crosshair', _p1: null, _hover: null,
  onActivate() { this._p1 = null; this._hover = null; },
  cancel() { this._p1 = null; this._hover = null; },
  onMove(pt) { this._hover = PlanTools.snap(pt); if (this._p1) PlanEngine.requestDraw({ fg: true }); },
  onDown(pt) {
    const s = PlanTools.snap(pt);
    if (!this._p1) { this._p1 = { x: s.x, y: s.y }; return; }
    const c = {
      id: AppState.planGenId('pmcr'),
      name: PlanMarkup.nextCounter('_crossing', 'RC'),
      size: PLAN_DEFS.crossings.defaultSize,
      p1: this._p1, p2: { x: s.x, y: s.y },
    };
    AppState.planMarkup.crossings.push(c);
    this._p1 = null;
    PlanMarkup.selectOnly(c.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },
  onKey(e) { if (e.key === 'Escape') { this._p1 = null; PlanEngine.requestDraw({ fg: true }); return true; } return false; },
  drawOverlay(ctx, zoom) {
    if (this._p1 && this._hover) {
      ctx.save();
      ctx.strokeStyle = PLAN_DEFS.crossings.color; ctx.lineWidth = 3 / zoom;
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.beginPath(); ctx.moveTo(this._p1.x, this._p1.y); ctx.lineTo(this._hover.x, this._hover.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (this._hover) PlanTools._drawSnapRing(ctx, this._hover.x, this._hover.y, this._hover.snapped, zoom);
  },
});

// ─────────────────────────────────────────────────────────────────────────
// TEXT — click to place, prompt for content
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'text', cursor: 'text', _busy: false,
  onActivate() { this._busy = false; },
  cancel() {},
  async onDown(pt) {
    if (this._busy) return;
    this._busy = true;
    const val = await UI.prompt('Text label:', '');
    this._busy = false;
    if (!val) return;
    const d = PLAN_DEFS.annotations.text.defaults;
    const tx = { id: AppState.planGenId('pmtx'), x: pt.x, y: pt.y, text: val, fontSize: d.fontSize, color: d.color };
    AppState.planMarkup.texts.push(tx);
    PlanMarkup.selectOnly(tx.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },
  onKey(e) { if (e.key === 'Escape') { PlanTools.set('select'); return true; } return false; },
});

// ─────────────────────────────────────────────────────────────────────────
// SL PATH — draw a path, auto-generate evenly-spaced poles + sl routes
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'slpath', cursor: 'crosshair', _pts: null, _hover: null, _busy: false,
  onActivate() { this._pts = null; this._hover = null; this._busy = false; },
  cancel() { this._pts = null; this._hover = null; },
  onMove(pt) { this._hover = PlanTools.snap(pt); PlanEngine.requestDraw({ fg: true }); },
  onDown(pt) {
    const s = PlanTools.snap(pt);
    if (!this._pts) this._pts = [{ x: s.x, y: s.y, snappedTo: s.targetId || undefined }];
    else this._pts.push({ x: s.x, y: s.y });
    PlanEngine.requestDraw({ fg: true });
  },
  onKey(e) {
    if (e.key === 'Escape') { this._pts = null; PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Enter') { this._finish(); return true; }
    return false;
  },
  async _finish() {
    if (this._busy) return;
    const pts = this._pts;
    if (!pts || pts.length < 2) { this._pts = null; PlanEngine.requestDraw({ fg: true }); return; }
    const factor = PlanEngine.factor();
    if (!factor) { UI.alert('Calibrate the plan first — pole spacing is measured in metres.'); return; }
    this._busy = true;
    const ans = await UI.prompt('Pole spacing (metres):', '40');
    this._busy = false;
    const spacingM = parseFloat(ans);
    if (!ans || !isFinite(spacingM) || spacingM <= 0) { this._pts = null; PlanEngine.requestDraw({ fg: true }); return; }
    const stepPx = spacingM / factor;

    // Source element under the first vertex (kiosk/minisub) becomes the feed.
    const sourceEl = PlanEngine.findElementAt(pts[0], 10);
    let polePts = PlanTools._interpolate(pts, stepPx);
    if (sourceEl && polePts.length && Math.hypot(polePts[0].x - sourceEl.x, polePts[0].y - sourceEl.y) < stepPx * 0.5) {
      polePts = polePts.slice(1); // first point coincides with the source
    }
    const pm = AppState.planMarkup;
    const poleIds = [];
    for (const p of polePts) {
      const el = { id: AppState.planGenId('pmel'), type: 'pole', x: p.x, y: p.y, rotation: 0, name: PlanMarkup.nextName('pole'), reticId: null, props: {} };
      pm.elements.push(el); poleIds.push(el.id);
    }
    // Chain sl routes: source→pole0→pole1→…
    const chain = [];
    if (sourceEl) chain.push(sourceEl.id);
    chain.push(...poleIds);
    for (let i = 1; i < chain.length; i++) {
      const a = pm.elements.find(e => e.id === chain[i - 1]);
      const b = pm.elements.find(e => e.id === chain[i]);
      pm.routes.push({
        id: AppState.planGenId('pmrt'), type: 'sl',
        fromId: a.id, toId: b.id,
        points: [{ x: a.x, y: a.y, snappedTo: a.id }, { x: b.x, y: b.y, snappedTo: b.id }],
        cableType: '', curved: false, props: {},
      });
    }
    this._pts = null;
    PlanMarkup.clearSelection();
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
    UI.toast(`Placed ${poleIds.length} pole(s).`, 'success');
  },
  drawOverlay(ctx, zoom) {
    if (this._pts) {
      ctx.save();
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5 / zoom;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.beginPath(); ctx.moveTo(this._pts[0].x, this._pts[0].y);
      for (let i = 1; i < this._pts.length; i++) ctx.lineTo(this._pts[i].x, this._pts[i].y);
      if (this._hover) ctx.lineTo(this._hover.x, this._hover.y);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
    }
    if (this._hover) PlanTools._drawSnapRing(ctx, this._hover.x, this._hover.y, this._hover.snapped, zoom);
  },
});

// ─────────────────────────────────────────────────────────────────────────
// NUDGE PLAN — drag a background plan to reposition it (opts.planId)
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'nudgeplan', cursor: 'move', _drag: null,
  onActivate(opts) { this._planId = opts && opts.planId; this._drag = null; },
  cancel() { this._drag = null; },
  onDown(pt) {
    const p = AppState.planMarkup.plans.find(x => x.id === this._planId);
    if (!p) return;
    this._drag = { p, from: pt, startX: p.offX || 0, startY: p.offY || 0 };
  },
  onMove(pt) {
    if (!this._drag) return;
    this._drag.p.offX = this._drag.startX + (pt.x - this._drag.from.x);
    this._drag.p.offY = this._drag.startY + (pt.y - this._drag.from.y);
    PlanEngine.requestDraw({ bg: true });
  },
  onUp() {
    if (this._drag) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    this._drag = null;
  },
  onKey(e) { if (e.key === 'Escape') { PlanTools.set('select'); return true; } return false; },
});

// ─────────────────────────────────────────────────────────────────────────
// ALIGN PLAN — 2-point registration (opts.planId). Click order:
//   1 feature on the plan  → 2 where it belongs  → 3 second feature → 4 where.
// Solves a similarity (scale+rotation+translation) so the two features land
// on the two destination points; bakes it into offX/offY/rotation/scaleAdj.
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'align', cursor: 'crosshair', _clicks: null, _hover: null,
  onActivate(opts) {
    this._planId = opts && opts.planId; this._clicks = []; this._hover = null;
    UI.toast('Align: click a plan feature, then where it belongs (×2).', 'info');
  },
  cancel() { this._clicks = []; },
  onMove(pt) { this._hover = pt; PlanEngine.requestDraw({ fg: true }); },
  onDown(pt) {
    this._clicks.push({ x: pt.x, y: pt.y });
    if (this._clicks.length === 4) this._solve();
    PlanEngine.requestDraw({ fg: true });
  },
  onKey(e) { if (e.key === 'Escape') { this._clicks = []; PlanTools.set('select'); return true; } return false; },
  _solve() {
    const p = AppState.planMarkup.plans.find(x => x.id === this._planId);
    const [src1, dst1, src2, dst2] = this._clicks;
    this._clicks = [];
    if (!p) return;
    // Source clicks are world points on the plan's current rendering → image px.
    const s1 = PlanEngine.planWorldToImage(p, src1.x, src1.y);
    const s2 = PlanEngine.planWorldToImage(p, src2.x, src2.y);
    const vsx = s2.x - s1.x, vsy = s2.y - s1.y;
    const vdx = dst2.x - dst1.x, vdy = dst2.y - dst1.y;
    const ls = Math.hypot(vsx, vsy);
    if (ls < 1e-6) { UI.toast('Pick two distinct plan features.', 'warn'); return; }
    const scale = Math.hypot(vdx, vdy) / ls;
    const theta = Math.atan2(vdy, vdx) - Math.atan2(vsy, vsx);
    const c = Math.cos(theta), sn = Math.sin(theta);
    // off = dst1 - scale·R(theta)·s1
    p.offX = dst1.x - scale * (s1.x * c - s1.y * sn);
    p.offY = dst1.y - scale * (s1.x * sn + s1.y * c);
    p.rotation = ((theta * 180 / Math.PI) % 360 + 360) % 360;
    p.scaleAdj = scale;
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ bg: true });
    UI.toast('Plan aligned.', 'success');
    PlanTools.set('select');
  },
  drawOverlay(ctx, zoom) {
    const cols = ['#22c55e', '#22c55e', '#f59e0b', '#f59e0b'];
    this._clicks.forEach((p, i) => {
      ctx.save(); ctx.fillStyle = cols[i]; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 / zoom;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5 / zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    });
    // link src→dst pairs
    ctx.save(); ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]);
    if (this._clicks.length >= 2) { ctx.beginPath(); ctx.moveTo(this._clicks[0].x, this._clicks[0].y); ctx.lineTo(this._clicks[1].x, this._clicks[1].y); ctx.stroke(); }
    if (this._clicks.length >= 4) { ctx.beginPath(); ctx.moveTo(this._clicks[2].x, this._clicks[2].y); ctx.lineTo(this._clicks[3].x, this._clicks[3].y); ctx.stroke(); }
    ctx.setLineDash([]); ctx.restore();
  },
});

// Evenly-spaced points along a polyline, starting at the first vertex.
PlanTools._interpolate = function (pts, step) {
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;
    const ux = dx / segLen, uy = dy / segLen;
    let d = step - carry;
    while (d <= segLen + 1e-6) { out.push({ x: a.x + ux * d, y: a.y + uy * d }); d += step; }
    carry = segLen - (d - step);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────
// CROP — drag a rectangle to set the export crop box
// ─────────────────────────────────────────────────────────────────────────
PlanTools.register({
  id: 'crop', cursor: 'crosshair', _start: null, _draft: null,
  onActivate() { this._start = null; this._draft = null; },
  cancel() { this._start = null; this._draft = null; },
  onDown(pt) { this._start = { x: pt.x, y: pt.y }; this._draft = null; },
  onMove(pt) {
    if (!this._start) return;
    this._draft = this._rect(this._start, pt);
    PlanEngine.requestDraw({ fg: true });
  },
  onUp(pt) {
    if (!this._start) return;
    const r = this._rect(this._start, pt);
    this._start = null; this._draft = null;
    if (r.w < 2 || r.h < 2) { AppState.planMarkup.cropBox = null; } // tiny drag clears crop
    else AppState.planMarkup.cropBox = r;
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ all: true });
  },
  onKey(e) { if (e.key === 'Escape') { this._start = null; this._draft = null; PlanTools.set('select'); return true; } return false; },
  _rect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; },
  drawOverlay(ctx, zoom) {
    const r = this._draft;
    if (!r) return;
    ctx.save();
    ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    ctx.restore();
  },
});
