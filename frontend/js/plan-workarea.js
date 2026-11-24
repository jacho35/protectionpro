/* ProtectionPro — Plan working area (clip).
 *
 * A DXF often carries far more than the development: other sites, title
 * blocks, survey detail. The working area is ONE polygon per floor
 * (`planMarkup.workArea = {points:[{x,y}…]}`, world / plan-pixel coordinates;
 * a rectangle is just four points). Nothing is deleted from the drawing:
 * outside the polygon the drawing is faded and the detection tools (rooms,
 * erven, leak check, streets / kerbs from a layer, the DXF manager's convert)
 * behave as if it were not there. Edit or clear it any time.
 *
 * Pure geometry (`inPoly`, `segHits`, `filterSegs`) is node-testable.
 */
const PlanWorkArea = {
  // ─── state ───
  get() {
    const w = AppState.planMarkup && AppState.planMarkup.workArea;
    return w && Array.isArray(w.points) && w.points.length >= 3 ? w : null;
  },
  active() { return !!this.get(); },
  set(points) {
    const pm = AppState.planMarkup;
    pm.workArea = points && points.length >= 3 ? { points: points.map(p => ({ x: p.x, y: p.y })) } : null;
    this._changed();
  },
  clear() { this.set(null); },
  _changed() {
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    if (typeof PlanRoomDetect !== 'undefined' && PlanRoomDetect._cands) PlanRoomDetect._cands = null;
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); }
  },
  rect(a, b) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  },
  // Part of the cache key of anything computed from the drawing.
  sig() { const w = this.get(); return w ? w.points.map(p => Math.round(p.x * 10) + ',' + Math.round(p.y * 10)).join(';') : ''; },

  // ─── pure geometry; poly = [[x,y]…] ───
  bbox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  },
  inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  },
  _cross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy, den = d1x * d2y - d1y * d2x;
    if (!den) return false;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den, u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  },
  // A segment belongs to the area when an end is inside or it crosses the outline.
  segHits(s, poly, bb) {
    const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
    if (Math.max(x1, x2) < bb[0] || Math.min(x1, x2) > bb[2] || Math.max(y1, y2) < bb[1] || Math.min(y1, y2) > bb[3]) return false;
    if (this.inPoly(x1, y1, poly) || this.inPoly(x2, y2, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (this._cross(x1, y1, x2, y2, poly[j][0], poly[j][1], poly[i][0], poly[i][1])) return true;
    }
    return false;
  },
  filterSegs(segs, poly) {
    if (!poly) return segs;
    const bb = this.bbox(poly);
    return segs.filter(s => this.segHits(s, poly, bb));
  },

  // ─── in a DXF's own drawing units (the transform is affine, so the polygon stays a polygon) ───
  localPoly(desc) {
    const w = this.get(); if (!w) return null;
    return w.points.map(p => { const q = PlanDxfImport.localOf(desc, p.x, p.y); return [q.x, q.y]; });
  },
  worldPoly() { const w = this.get(); return w ? w.points.map(p => [p.x, p.y]) : null; },
  // True when a point in the DXF's drawing units is inside (or there is no area).
  keepLocal(desc) {
    const poly = this.localPoly(desc); if (!poly) return null;
    return (x, y) => this.inPoly(x, y, poly);
  },
  // Keeper for DXF entity records (lines / polylines / arcs…) of one drawing: null when there is no area.
  recKeeper(desc) {
    const poly = this.localPoly(desc); if (!poly) return null;
    const bb = this.bbox(poly);
    return (r) => {
      const p = r.p || [];
      if (r.t === 'l') return this.segHits([p[0], p[1], p[2], p[3]], poly, bb);
      if (r.t === 'p') {
        if (p.length < 4) return false;
        for (let i = 0; i + 3 < p.length; i += 2) if (this.segHits([p[i], p[i + 1], p[i + 2], p[i + 3]], poly, bb)) return true;
        return !!r.c && this.segHits([p[p.length - 2], p[p.length - 1], p[0], p[1]], poly, bb);
      }
      if (p.length >= 2) return this.inPoly(p[0], p[1], poly);
      return true;
    };
  },
  inWorld(x, y) { const p = this.worldPoly(); return !p || this.inPoly(x, y, p); },

  // ─── drawing: fade the world outside the polygon, outline it ───
  draw(ctx, zoom, vr) {
    const w = this.get(); if (!w) return;
    const pts = w.points;
    ctx.save();
    ctx.fillStyle = 'rgba(241,245,249,0.72)';
    try { const bg = PlanEngine._cssVar('--plan-stage-bg', ''); if (bg) ctx.fillStyle = this._alpha(bg, 0.72); } catch (_) {}
    ctx.beginPath();
    ctx.rect(vr.minX, vr.minY, vr.maxX - vr.minX, vr.maxY - vr.minY);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 1.5 / zoom; ctx.setLineDash([8 / zoom, 5 / zoom]);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  },
  _alpha(css, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(css).trim());
    if (!m) return css;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  },
};
if (typeof module !== 'undefined') module.exports = PlanWorkArea;
