/* ProtectionPro — Plan Markup canvas engine.
 *
 * Dual stacked <canvas> layers (Distribution Designer model):
 *   #plan-canvas-bg  — background plan image(s), crop mask, metric grid,
 *                      calibration line. pointer-events:none, redrawn only
 *                      when background state changes.
 *   #plan-canvas-fg  — entities, selection chrome, tool ghosts. Owns all
 *                      pointer events, redrawn per interaction frame.
 *
 * World coordinates are base-plan image PIXELS (metres derived via the
 * calibration factor). The view transform is centre-origin: world (0,0) sits
 * at the canvas centre. Pan is stored in screen pixels; zoom is a scalar.
 * Drawing is rAF-coalesced; all on-screen chrome is divided by zoom so its
 * apparent size is constant. Input is native Pointer Events only (mouse /
 * touch / pen share one path), with two-finger pinch-zoom + pan.
 */

const PlanEngine = {
  bg: null, fg: null, bgCtx: null, fgCtx: null, stage: null,
  view: { zoom: 0.5, panX: 0, panY: 0 },
  dpr: 1,
  cssW: 0, cssH: 0,
  _dirty: { bg: false, fg: false },
  _rafId: null,
  _bound: false,

  // Interaction bookkeeping
  touchPointers: new Map(),
  _pinch: null,
  spaceDown: false,
  isPanning: false,
  panStart: null,
  mouseWorld: { x: 0, y: 0 },

  init() {
    this.stage = document.getElementById('plan-stage');
    this.bg = document.getElementById('plan-canvas-bg');
    this.fg = document.getElementById('plan-canvas-fg');
    if (!this.stage || !this.bg || !this.fg) return;
    this.bgCtx = this.bg.getContext('2d');
    this.fgCtx = this.fg.getContext('2d');
    if (!this._bound) { this._bindEvents(); this._bound = true; }
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.stage);
    }
    this.resize();
  },

  // ─── Sizing (devicePixelRatio-aware) ───
  resize() {
    if (!this.stage) return;
    const rect = this.stage.getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(rect.width));
    this.cssH = Math.max(1, Math.round(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.bg, this.fg]) {
      c.style.width = this.cssW + 'px';
      c.style.height = this.cssH + 'px';
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
    }
    this.requestDraw({ all: true });
  },

  // ─── Coordinate transforms (centre-origin, pan in screen px) ───
  screenToWorld(clientX, clientY) {
    const rect = this.fg.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    return {
      x: (cx - this.cssW / 2 - this.view.panX) / this.view.zoom,
      y: (cy - this.cssH / 2 - this.view.panY) / this.view.zoom,
    };
  },
  worldToScreen(wx, wy) {
    return {
      x: this.cssW / 2 + this.view.panX + wx * this.view.zoom,
      y: this.cssH / 2 + this.view.panY + wy * this.view.zoom,
    };
  },

  // Apply the view transform to a context already reset to dpr scale.
  _applyView(ctx) {
    ctx.translate(this.cssW / 2 + this.view.panX, this.cssH / 2 + this.view.panY);
    ctx.scale(this.view.zoom, this.view.zoom);
  },

  // ─── Zoom / fit ───
  zoomAt(factor, mx, my) {
    const z = this.view.zoom;
    const nz = Math.max(0.02, Math.min(20, z * factor));
    const scale = nz / z;
    // Keep the world point under (mx,my) fixed.
    this.view.panX = mx - this.cssW / 2 - scale * (mx - this.cssW / 2 - this.view.panX);
    this.view.panY = my - this.cssH / 2 - scale * (my - this.cssH / 2 - this.view.panY);
    this.view.zoom = nz;
    this.requestDraw({ all: true });
  },

  // Fit the union of visible plan extents, else the geometry bbox, else reset.
  zoomFit() {
    const box = this._contentBBox();
    if (!box) { this.view = { zoom: 0.5, panX: 0, panY: 0 }; this.requestDraw({ all: true }); return; }
    const pad = 40;
    const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY);
    const z = Math.max(0.02, Math.min(20, Math.min(
      (this.cssW - pad * 2) / w, (this.cssH - pad * 2) / h)));
    const midX = (box.minX + box.maxX) / 2, midY = (box.minY + box.maxY) / 2;
    // World midpoint should land at canvas centre → panX + midX*z = 0.
    this.view.zoom = z;
    this.view.panX = -midX * z;
    this.view.panY = -midY * z;
    this.requestDraw({ all: true });
  },

  _contentBBox() {
    const pm = AppState.planMarkup;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; any = true; };
    for (const p of pm.plans) {
      if (p.visible === false) continue;
      const img = (typeof PlanImages !== 'undefined') ? PlanImages.getElementImage(p.imageId) : null;
      const w = p.imgW || (img && img.naturalWidth) || 0;
      const h = p.imgH || (img && img.naturalHeight) || 0;
      if (w && h) { acc(p.offX || 0, p.offY || 0); acc((p.offX || 0) + w, (p.offY || 0) + h); }
    }
    if (!any) {
      for (const el of pm.elements) acc(el.x, el.y);
      for (const r of pm.routes) for (const pt of r.points) acc(pt.x, pt.y);
      for (const t of pm.trenches) for (const pt of t.points) acc(pt.x, pt.y);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  },

  // Metres per pixel, or null when the plan is not calibrated.
  factor() {
    const s = AppState.planMarkup.scale;
    return (s && s.factor) ? s.factor : null;
  },
  // World-pixel length → display string in metres (or px when uncalibrated).
  lenLabel(px) {
    const f = this.factor();
    return f ? `${(px * f).toFixed(2)} m` : `${Math.round(px)} px`;
  },

  // ─── Draw scheduling ───
  requestDraw(flags) {
    flags = flags || {};
    if (flags.all || flags.bg) this._dirty.bg = true;
    if (flags.all || flags.fg) this._dirty.fg = true;
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      const d = this._dirty;
      this._dirty = { bg: false, fg: false };
      if (d.bg) this._drawBg();
      if (d.fg) this._drawFg();
    });
  },

  _cssVar(name, fallback) {
    try {
      const v = getComputedStyle(this.stage).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  },

  // ─── Background layer ───
  _drawBg() {
    const ctx = this.bgCtx; if (!ctx) return;
    const pm = AppState.planMarkup;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = this._cssVar('--plan-stage-bg', '#f1f5f9');
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    ctx.save();
    this._applyView(ctx);

    // Plan images
    for (const p of pm.plans) {
      if (p.visible === false) continue;
      const img = (typeof PlanImages !== 'undefined') ? PlanImages.getElementImage(p.imageId) : null;
      if (!img) continue;
      ctx.save();
      ctx.globalAlpha = (typeof p.opacity === 'number') ? p.opacity : 1;
      const filters = [];
      if (pm.settings.greyBg) filters.push('grayscale(1)');
      if (pm.settings.invertBg) filters.push('invert(1)');
      if (filters.length) ctx.filter = filters.join(' ');
      try { ctx.drawImage(img, p.offX || 0, p.offY || 0); } catch (e) { /* not decoded yet */ }
      ctx.restore();
    }

    // Crop box: dim everything outside the export rectangle.
    if (pm.cropBox) {
      const cb = pm.cropBox;
      const vr = this._visibleWorldRect();
      ctx.save();
      ctx.fillStyle = 'rgba(15,23,42,0.45)';
      ctx.beginPath();
      ctx.rect(vr.minX, vr.minY, vr.maxX - vr.minX, vr.maxY - vr.minY);
      ctx.rect(cb.x, cb.y, cb.w, cb.h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#0ea5e9';
      ctx.lineWidth = 1.5 / this.view.zoom;
      ctx.strokeRect(cb.x, cb.y, cb.w, cb.h);
      ctx.restore();
    }

    // Metric grid (only meaningful when calibrated)
    if (pm.settings.showGrid) this._drawGrid(ctx);

    // Calibration line
    if (pm.scale && pm.scale.p1 && pm.scale.p2) {
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2 / this.view.zoom;
      ctx.beginPath();
      ctx.moveTo(pm.scale.p1.x, pm.scale.p1.y);
      ctx.lineTo(pm.scale.p2.x, pm.scale.p2.y);
      ctx.stroke();
      const r = 4 / this.view.zoom;
      ctx.fillStyle = '#e11d48';
      for (const p of [pm.scale.p1, pm.scale.p2]) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  },

  _drawGrid(ctx) {
    const pm = AppState.planMarkup;
    const f = this.factor();
    if (!f) return; // grid is defined in metres — needs calibration
    const stepPx = pm.settings.gridSize / f;          // world-px per grid line
    if (stepPx * this.view.zoom < 6) return;           // too dense to be useful
    const box = this._visibleWorldRect();
    ctx.strokeStyle = this._cssVar('--plan-grid', 'rgba(100,116,139,0.25)');
    ctx.lineWidth = 1 / this.view.zoom;
    ctx.beginPath();
    const x0 = Math.floor(box.minX / stepPx) * stepPx;
    for (let x = x0; x <= box.maxX; x += stepPx) { ctx.moveTo(x, box.minY); ctx.lineTo(x, box.maxY); }
    const y0 = Math.floor(box.minY / stepPx) * stepPx;
    for (let y = y0; y <= box.maxY; y += stepPx) { ctx.moveTo(box.minX, y); ctx.lineTo(box.maxX, y); }
    ctx.stroke();
  },

  _visibleWorldRect() {
    const tl = this.screenToWorld(this.fg.getBoundingClientRect().left, this.fg.getBoundingClientRect().top);
    const rect = this.fg.getBoundingClientRect();
    const br = this.screenToWorld(rect.left + this.cssW, rect.top + this.cssH);
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  },

  // ─── Foreground layer ───
  _drawFg() {
    const ctx = this.fgCtx; if (!ctx) return;
    const pm = AppState.planMarkup;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    this._applyView(ctx);
    const z = this.view.zoom;
    const sel = (typeof PlanMarkup !== 'undefined') ? PlanMarkup.selectedIds : new Set();

    // z-order: trenches → crossings → routes → elements → texts → measures
    for (const t of pm.trenches) this._drawTrench(ctx, t, sel.has(t.id));
    for (const c of pm.crossings) this._drawCrossing(ctx, c, sel.has(c.id));
    for (const r of pm.routes) this._drawRoute(ctx, r, sel.has(r.id));
    for (const el of pm.elements) this._drawElementEntity(ctx, el, sel.has(el.id));
    for (const tx of pm.texts) this._drawText(ctx, tx, sel.has(tx.id));
    for (const m of pm.measurements) this._drawMeasurement(ctx, m, sel.has(m.id));

    // Tool overlay (ghosts, rubber-bands, snap ring)
    if (typeof PlanTools !== 'undefined' && PlanTools.drawOverlay) PlanTools.drawOverlay(ctx, z);
    ctx.restore();
  },

  _emphasis(entityTypeKey, type) {
    // Dim entities not primary on the active discipline layer (source-app feel).
    const pm = AppState.planMarkup;
    const layer = pm.layers.find(l => l.id === pm.activeLayerId);
    if (!layer) return 1;
    const list = layer[entityTypeKey] || [];
    return list.includes(type) ? 1 : 0.25;
  },

  _drawElementEntity(ctx, el, selected) {
    const def = PLAN_DEFS.element(el.type);
    const color = PLAN_DEFS.elementColor(el.type, AppState.planMarkup.styles);
    const f = this.factor();
    const scale = (def && def.scale) || 1;
    // Element half-size: real metres when calibrated, else a fixed screen size.
    const sizePx = f ? ((def && def.dxf ? def.dxf.sizeM : 1) / 2 / f) * scale
                     : (12 / this.view.zoom);
    ctx.save();
    ctx.globalAlpha = this._emphasis('visibleElementTypes', el.type);
    ctx.translate(el.x, el.y);
    if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
    PLAN_DEFS.drawElement(ctx, def, {
      sizePx, color, selected,
      strokeW: (selected ? 2.5 : 1.5) / this.view.zoom,
    });
    ctx.restore();
    // Label + selection ring in unrotated space
    ctx.save();
    ctx.globalAlpha = this._emphasis('visibleElementTypes', el.type);
    if (selected) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5 / this.view.zoom;
      ctx.setLineDash([4 / this.view.zoom, 3 / this.view.zoom]);
      ctx.strokeRect(el.x - sizePx - 3 / this.view.zoom, el.y - sizePx - 3 / this.view.zoom,
        (sizePx + 3 / this.view.zoom) * 2, (sizePx + 3 / this.view.zoom) * 2);
      ctx.setLineDash([]);
    }
    if (el.name) {
      const fpx = 12 / this.view.zoom;
      ctx.font = `${fpx}px system-ui, sans-serif`;
      ctx.fillStyle = this._cssVar('--plan-label', '#334155');
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(el.name, el.x + sizePx + 3 / this.view.zoom, el.y);
    }
    ctx.restore();
  },

  _routeColor(r) { return PLAN_DEFS.routeColor(r.type, AppState.planMarkup.styles); },

  _drawRoute(ctx, r, selected) {
    if (!r.points || r.points.length < 1) return;
    const def = PLAN_DEFS.route(r.type);
    ctx.save();
    ctx.globalAlpha = this._emphasis('routeTypes', r.type);
    ctx.strokeStyle = this._routeColor(r);
    ctx.lineWidth = ((def && def.width) || 2) * (selected ? 2 : 1) / this.view.zoom;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const dashed = def && def.lineStyle === 'dashed';
    ctx.setLineDash(dashed ? [8 / this.view.zoom, 5 / this.view.zoom] : []);
    this._pathPoly(ctx, r.points, r.curved);
    ctx.stroke();
    ctx.setLineDash([]);
    // Vertices when selected
    if (selected) {
      const rr = 3 / this.view.zoom;
      ctx.fillStyle = '#2563eb';
      for (const p of r.points) { ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill(); }
    }
    // Midpoint label: cable type + length
    if (r.points.length >= 2) {
      const mid = r.points[Math.floor(r.points.length / 2) - (r.points.length % 2 === 0 ? 1 : 0)];
      const len = this._polyLen(r.points);
      const label = (r.cableType ? r.cableType + '  ' : '') + this.lenLabel(len);
      const fpx = 11 / this.view.zoom;
      ctx.font = `${fpx}px system-ui, sans-serif`;
      ctx.fillStyle = this._routeColor(r);
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(label, mid.x, mid.y - 3 / this.view.zoom);
    }
    ctx.restore();
  },

  _drawTrench(ctx, t, selected) {
    if (!t.points || t.points.length < 1) return;
    const def = PLAN_DEFS.trenchTypes[t.excType] || { color: 'rgba(120,120,120,0.4)', width: 0.5 };
    const f = this.factor();
    const wPx = f ? ((t.widthOverride || def.width) / f) : (10 / this.view.zoom);
    ctx.save();
    ctx.globalAlpha = this._emphasis('trenchTypes', t.excType);
    ctx.strokeStyle = def.color;
    ctx.lineWidth = wPx;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(t.points[0].x, t.points[0].y);
    for (let i = 1; i < t.points.length; i++) ctx.lineTo(t.points[i].x, t.points[i].y);
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5 / this.view.zoom;
      ctx.stroke();
    }
    ctx.restore();
  },

  _drawCrossing(ctx, c, selected) {
    if (!c.p1 || !c.p2) return;
    ctx.save();
    ctx.strokeStyle = PLAN_DEFS.crossings.color;
    ctx.lineWidth = (selected ? 4 : 3) / this.view.zoom;
    ctx.beginPath(); ctx.moveTo(c.p1.x, c.p1.y); ctx.lineTo(c.p2.x, c.p2.y); ctx.stroke();
    ctx.restore();
  },

  _drawText(ctx, tx, selected) {
    ctx.save();
    const fpx = (tx.fontSize || 14) / this.view.zoom;
    ctx.font = `${fpx}px system-ui, sans-serif`;
    ctx.fillStyle = tx.color || this._cssVar('--plan-label', '#111827');
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(tx.text || '', tx.x, tx.y);
    if (selected) {
      const w = ctx.measureText(tx.text || '').width;
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.strokeRect(tx.x - 2 / this.view.zoom, tx.y - 2 / this.view.zoom, w + 4 / this.view.zoom, fpx + 4 / this.view.zoom);
    }
    ctx.restore();
  },

  _drawMeasurement(ctx, m, selected) {
    if (!m.points || m.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = PLAN_DEFS.annotations.measurement.color;
    ctx.lineWidth = (selected ? 2 : 1.5) / this.view.zoom;
    ctx.setLineDash([6 / this.view.zoom, 4 / this.view.zoom]);
    ctx.beginPath();
    ctx.moveTo(m.points[0].x, m.points[0].y);
    for (let i = 1; i < m.points.length; i++) ctx.lineTo(m.points[i].x, m.points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    const len = this._polyLen(m.points);
    const mid = m.points[m.points.length - 1];
    const fpx = 11 / this.view.zoom;
    ctx.font = `${fpx}px system-ui, sans-serif`;
    ctx.fillStyle = PLAN_DEFS.annotations.measurement.color;
    ctx.fillText(this.lenLabel(len), mid.x + 4 / this.view.zoom, mid.y);
    ctx.restore();
  },

  _polyLen(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  },

  // Trace a polyline, or a Catmull-Rom spline through the points when curved.
  _pathPoly(ctx, pts, curved) {
    ctx.beginPath();
    if (!curved || pts.length < 3) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      return;
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i], p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  },

  // ─── Hit testing (thresholds in screen px, converted to world via /zoom) ───
  _distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  },

  findElementAt(pt, tolPx) {
    const pm = AppState.planMarkup;
    const f = this.factor();
    for (let i = pm.elements.length - 1; i >= 0; i--) {
      const el = pm.elements[i];
      const def = PLAN_DEFS.element(el.type);
      const sizePx = f ? ((def && def.dxf ? def.dxf.sizeM : 1) / 2 / f) : (12 / this.view.zoom);
      const tol = (tolPx || 6) / this.view.zoom;
      if (Math.abs(pt.x - el.x) <= sizePx + tol && Math.abs(pt.y - el.y) <= sizePx + tol) return el;
    }
    return null;
  },

  findRouteAt(pt, tolPx) {
    const pm = AppState.planMarkup;
    const tol = (tolPx || 8) / this.view.zoom;
    for (let i = pm.routes.length - 1; i >= 0; i--) {
      const r = pm.routes[i];
      for (let s = 1; s < r.points.length; s++) {
        if (this._distToSeg(pt, r.points[s - 1], r.points[s]) <= tol) return { route: r, segIndex: s - 1 };
      }
    }
    return null;
  },

  findTrenchAt(pt, tolPx) {
    const pm = AppState.planMarkup;
    const tol = (tolPx || 8) / this.view.zoom;
    for (let i = pm.trenches.length - 1; i >= 0; i--) {
      const t = pm.trenches[i];
      for (let s = 1; s < t.points.length; s++) {
        if (this._distToSeg(pt, t.points[s - 1], t.points[s]) <= tol) return { trench: t, segIndex: s - 1 };
      }
    }
    return null;
  },

  findVertexAt(pts, pt, tolPx) {
    const tol = (tolPx || 8) / this.view.zoom;
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(pt.x - pts[i].x, pt.y - pts[i].y) <= tol) return i;
    }
    return -1;
  },

  // Ordered list of everything under the cursor (for tie-break cycling later).
  hitStack(pt) {
    const out = [];
    const el = this.findElementAt(pt); if (el) out.push({ kind: 'element', item: el });
    const r = this.findRouteAt(pt); if (r) out.push({ kind: 'route', item: r.route });
    const t = this.findTrenchAt(pt); if (t) out.push({ kind: 'trench', item: t.trench });
    return out;
  },

  // ─── Pointer pipeline (Pointer Events only) ───
  _bindEvents() {
    this.fg.addEventListener('pointerdown', (e) => this._onDown(e));
    // move/up on document so drags never stick if the pointer leaves the canvas
    document.addEventListener('pointermove', (e) => this._onMove(e));
    document.addEventListener('pointerup', (e) => this._onUp(e));
    document.addEventListener('pointercancel', (e) => this._onUp(e));
    this.fg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.fg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof PlanTools !== 'undefined' && PlanTools.cancel) PlanTools.cancel();
    });
    // Space-hold pan (guarded to the active workspace)
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || this.spaceDown) return;
      if (!(typeof PlanMarkup !== 'undefined' && PlanMarkup._active)) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      this.spaceDown = true;
      this.fg.style.cursor = 'grab';
      if (e.target === document.body) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; this._restoreCursor(); }
    });
    window.addEventListener('blur', () => { this.spaceDown = false; this._restoreCursor(); });
  },

  _restoreCursor() {
    if (typeof PlanTools !== 'undefined' && PlanTools.applyCursor) PlanTools.applyCursor();
    else this.fg.style.cursor = 'default';
  },

  _isActive() { return typeof PlanMarkup !== 'undefined' && PlanMarkup._active; },

  _onDown(e) {
    if (!this._isActive()) return;
    this.fg.setPointerCapture && this.fg.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchPointers.size === 2) {
        // Entering pinch — abort any in-progress tool gesture first.
        if (typeof PlanTools !== 'undefined' && PlanTools.cancel) PlanTools.cancel();
        this._pinch = this._pinchFrom();
        return;
      }
    }
    // Pan: space-hold, or middle button
    if (this.spaceDown || e.button === 1) {
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.view.panX, y: e.clientY - this.view.panY };
      this.fg.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== undefined && e.button !== 0) return;
    const pt = this.screenToWorld(e.clientX, e.clientY);
    this.mouseWorld = pt;
    if (typeof PlanTools !== 'undefined' && PlanTools.onDown) PlanTools.onDown(pt, e);
  },

  _onMove(e) {
    if (!this._isActive()) return;
    if (e.pointerType === 'touch' && this.touchPointers.has(e.pointerId)) {
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchPointers.size >= 2) { this._pinchMove(); return; }
    }
    if (this.isPanning && this.panStart) {
      this.view.panX = e.clientX - this.panStart.x;
      this.view.panY = e.clientY - this.panStart.y;
      this.requestDraw({ all: true });
      return;
    }
    const pt = this.screenToWorld(e.clientX, e.clientY);
    this.mouseWorld = pt;
    this._updateStatusCoords(pt);
    if (typeof PlanTools !== 'undefined' && PlanTools.onMove) PlanTools.onMove(pt, e);
  },

  _onUp(e) {
    if (e.pointerType === 'touch') {
      this.touchPointers.delete(e.pointerId);
      if (this.touchPointers.size < 2) this._pinch = null;
    }
    if (this.isPanning) { this.isPanning = false; this.panStart = null; this._restoreCursor(); return; }
    if (!this._isActive()) return;
    const pt = this.screenToWorld(e.clientX, e.clientY);
    if (typeof PlanTools !== 'undefined' && PlanTools.onUp) PlanTools.onUp(pt, e);
  },

  _onWheel(e) {
    if (!this._isActive()) return;
    e.preventDefault();
    const rect = this.fg.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  },

  _pinchFrom() {
    const [a, b] = [...this.touchPointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  },
  _pinchMove() {
    if (this.touchPointers.size < 2 || !this._pinch) return;
    const p = this._pinchFrom();
    const rect = this.fg.getBoundingClientRect();
    if (this._pinch.d > 0 && p.d > 0) this.zoomAt(p.d / this._pinch.d, p.cx - rect.left, p.cy - rect.top);
    this.view.panX += p.cx - this._pinch.cx;
    this.view.panY += p.cy - this._pinch.cy;
    this._pinch = p;
    this.requestDraw({ all: true });
  },

  _updateStatusCoords(pt) {
    const el = document.getElementById('plan-status-coords');
    if (!el) return;
    const f = this.factor();
    el.textContent = f
      ? `X: ${(pt.x * f).toFixed(1)} m  Y: ${(pt.y * f).toFixed(1)} m`
      : `X: ${Math.round(pt.x)} px  Y: ${Math.round(pt.y)} px`;
  },
};
