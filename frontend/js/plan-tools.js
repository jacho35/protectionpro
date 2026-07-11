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
  _drag: null,   // {kind:'element'|'vertex', ...}
  onActivate() { this._drag = null; },
  cancel() { this._drag = null; },

  onDown(pt, e) {
    const pm = AppState.planMarkup;
    // 1) route vertex of an already-selected route (fine control)
    for (const r of pm.routes) {
      if (!PlanMarkup.selectedIds.has(r.id)) continue;
      const vi = PlanEngine.findVertexAt(r.points, pt, 8);
      if (vi >= 0) { this._drag = { kind: 'vertex', route: r, index: vi, moved: false }; return; }
    }
    // 2) element
    const el = PlanEngine.findElementAt(pt);
    if (el) {
      if (!PlanMarkup.selectedIds.has(el.id)) PlanMarkup.selectOnly(el.id);
      this._drag = { kind: 'element', el, start: { x: el.x, y: el.y }, from: pt, moved: false };
      return;
    }
    // 3) route (shift+click on a segment inserts a vertex)
    const rh = PlanEngine.findRouteAt(pt);
    if (rh) {
      if (e.shiftKey) {
        const snapped = PlanTools.snap(pt, { ignoreIds: new Set([rh.route.id]) });
        rh.route.points.splice(rh.segIndex + 1, 0, { x: snapped.x, y: snapped.y });
        PlanMarkup.selectOnly(rh.route.id);
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
      } else {
        PlanMarkup.selectOnly(rh.route.id);
      }
      PlanEngine.requestDraw({ fg: true });
      return;
    }
    // 4) trench / text
    const th = PlanEngine.findTrenchAt(pt);
    if (th) { PlanMarkup.selectOnly(th.trench.id); PlanEngine.requestDraw({ fg: true }); return; }
    const tx = this._textAt(pt);
    if (tx) { PlanMarkup.selectOnly(tx.id); PlanEngine.requestDraw({ fg: true }); return; }
    // empty → clear
    PlanMarkup.clearSelection();
    PlanEngine.requestDraw({ fg: true });
  },

  onMove(pt, e) {
    if (!this._drag) return;
    const snapped = PlanTools.snap(pt, {
      ignoreIds: this._drag.kind === 'vertex' ? new Set([this._drag.route.id]) : new Set([this._drag.el.id]),
    });
    if (this._drag.kind === 'element') {
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
    if (this._drag && this._drag.moved) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); }
    this._drag = null;
  },

  _textAt(pt) {
    // Rough: text anchor within ~14px box
    const tol = 14 / PlanEngine.view.zoom;
    for (let i = AppState.planMarkup.texts.length - 1; i >= 0; i--) {
      const t = AppState.planMarkup.texts[i];
      if (pt.x >= t.x - tol && pt.x <= t.x + tol * 6 && pt.y >= t.y - tol && pt.y <= t.y + tol) return t;
    }
    return null;
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
    this._draft = null;
    PlanMarkup.selectOnly(route.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
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
