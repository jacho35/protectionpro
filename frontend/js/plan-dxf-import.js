/* ProtectionPro — Plan Markup DXF import (reference underlay).
 *
 * Parses a DXF ENTITIES section (LINE / LWPOLYLINE / POLYLINE+VERTEX / CIRCLE /
 * ARC / TEXT) and renders it as a light grey vector backdrop to trace over.
 * The overlay is placed into world-pixel space (Y-flipped, fit to a sensible
 * size) and is SESSION-ONLY — it is not written into the project JSON (vector
 * data can be huge; persisting a background belongs in the backend image
 * store, a later enhancement). Re-import to replace; it clears on reload.
 */

const PlanDxfImport = {
  _overlay: null,   // {entities, offX, offY, scale, name}

  // Parse group-code pairs → entity list + DXF-space bbox.
  parse(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      pairs.push([lines[i].trim(), lines[i + 1]]);
    }
    const entities = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const acc = (x, y) => { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; };

    // Find ENTITIES section
    let i = 0;
    for (; i < pairs.length; i++) if (pairs[i][0] === '2' && (pairs[i][1] || '').trim() === 'ENTITIES') break;
    let cur = null, poly = null;
    const flush = () => {
      if (cur) { entities.push(cur); cur = null; }
    };
    for (; i < pairs.length; i++) {
      const [code, valRaw] = pairs[i];
      const val = (valRaw != null ? String(valRaw).trim() : '');
      if (code === '0') {
        // finalize polyline accumulation
        if (poly && val !== 'VERTEX') {
          if (poly.pts.length) { entities.push(poly); poly.pts.forEach(p => acc(p.x, p.y)); }
          poly = null;
        }
        flush();
        if (val === 'ENDSEC') break;
        if (val === 'LINE') cur = { type: 'LINE' };
        else if (val === 'CIRCLE') cur = { type: 'CIRCLE' };
        else if (val === 'ARC') cur = { type: 'ARC' };
        else if (val === 'TEXT' || val === 'MTEXT') cur = { type: 'TEXT' };
        else if (val === 'LWPOLYLINE') cur = { type: 'LWPOLYLINE', pts: [], _px: null };
        else if (val === 'POLYLINE') poly = { type: 'POLYLINE', pts: [] };
        else if (val === 'VERTEX') cur = { type: 'VERTEX' };
        else cur = null;
        continue;
      }
      if (!cur && !poly) continue;
      const num = parseFloat(val);
      if (cur && cur.type === 'LINE') {
        if (code === '10') cur.x1 = num; else if (code === '20') cur.y1 = num;
        else if (code === '11') cur.x2 = num; else if (code === '21') cur.y2 = num;
      } else if (cur && cur.type === 'CIRCLE') {
        if (code === '10') cur.cx = num; else if (code === '20') cur.cy = num; else if (code === '40') cur.r = num;
      } else if (cur && cur.type === 'ARC') {
        if (code === '10') cur.cx = num; else if (code === '20') cur.cy = num; else if (code === '40') cur.r = num;
        else if (code === '50') cur.a0 = num; else if (code === '51') cur.a1 = num;
      } else if (cur && cur.type === 'TEXT') {
        if (code === '10') cur.x = num; else if (code === '20') cur.y = num;
        else if (code === '40') cur.h = num; else if (code === '1') cur.text = valRaw;
      } else if (cur && cur.type === 'LWPOLYLINE') {
        if (code === '10') cur._px = num;
        else if (code === '20' && cur._px != null) { cur.pts.push({ x: cur._px, y: num }); cur._px = null; }
        else if (code === '70') cur.closed = (parseInt(val) & 1) === 1;
      } else if (cur && cur.type === 'VERTEX' && poly) {
        if (code === '10') cur.x = num; else if (code === '20') { cur.y = num; poly.pts.push({ x: cur.x, y: cur.y }); }
      }
      // finalize simple entities as their next '0' arrives (handled at top)
      if (cur && (cur.type === 'LINE') && cur.x2 != null && cur.y2 != null) { /* wait for next 0 */ }
    }
    flush();
    // bbox over LINE/CIRCLE/TEXT/LWPOLYLINE
    for (const e of entities) {
      if (e.type === 'LINE') { acc(e.x1, e.y1); acc(e.x2, e.y2); }
      else if (e.type === 'CIRCLE' || e.type === 'ARC') { acc(e.cx - e.r, e.cy - e.r); acc(e.cx + e.r, e.cy + e.r); }
      else if (e.type === 'TEXT') acc(e.x, e.y);
      else if (e.type === 'LWPOLYLINE') e.pts.forEach(p => acc(p.x, p.y));
    }
    if (bx0 === Infinity) return null;
    return { entities, bbox: { minX: bx0, minY: by0, maxX: bx1, maxY: by1 } };
  },

  async importFile(file) {
    try {
      const text = await file.text();
      const parsed = this.parse(text);
      if (!parsed || !parsed.entities.length) { UI.alert('No supported entities found in that DXF.'); return; }
      // Fit the DXF bbox to ~1000 world px, place near origin, Y-flip on draw.
      const b = parsed.bbox;
      const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
      const scale = 1000 / Math.max(w, h);
      this._overlay = {
        entities: parsed.entities, bbox: b, scale,
        offX: 0, offY: 0, name: file.name || 'DXF',
      };
      if (typeof PlanEngine !== 'undefined') { PlanEngine.requestDraw({ bg: true }); PlanEngine.zoomFit(); }
      UI.toast(`Imported ${parsed.entities.length} DXF entities (session reference).`, 'success');
    } catch (e) {
      UI.alert('DXF import failed: ' + (e && e.message ? e.message : e));
    }
  },

  clear() { this._overlay = null; if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true }); },

  // DXF (x,y) → world px: origin-shifted, scaled, Y-flipped.
  _tx(o, x, y) { return { x: o.offX + (x - o.bbox.minX) * o.scale, y: o.offY + (o.bbox.maxY - y) * o.scale }; },

  extentWorld() {
    const o = this._overlay; if (!o) return null;
    const a = this._tx(o, o.bbox.minX, o.bbox.maxY), b = this._tx(o, o.bbox.maxX, o.bbox.minY);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  },

  draw(ctx, zoom) {
    const o = this._overlay; if (!o) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(100,116,139,0.7)';
    ctx.fillStyle = 'rgba(100,116,139,0.7)';
    ctx.lineWidth = 0.8 / zoom;
    for (const e of o.entities) {
      if (e.type === 'LINE') {
        const a = this._tx(o, e.x1, e.y1), b = this._tx(o, e.x2, e.y2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (e.type === 'CIRCLE') {
        const c = this._tx(o, e.cx, e.cy);
        ctx.beginPath(); ctx.arc(c.x, c.y, e.r * o.scale, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'ARC') {
        const c = this._tx(o, e.cx, e.cy);
        // Y is flipped, so sweep reverses.
        const a0 = -(e.a1 || 0) * Math.PI / 180, a1 = -(e.a0 || 0) * Math.PI / 180;
        ctx.beginPath(); ctx.arc(c.x, c.y, e.r * o.scale, a0, a1); ctx.stroke();
      } else if (e.type === 'LWPOLYLINE' && e.pts.length) {
        ctx.beginPath();
        e.pts.forEach((p, i) => { const q = this._tx(o, p.x, p.y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        if (e.closed) ctx.closePath();
        ctx.stroke();
      } else if (e.type === 'POLYLINE' && e.pts.length) {
        ctx.beginPath();
        e.pts.forEach((p, i) => { const q = this._tx(o, p.x, p.y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.stroke();
      } else if (e.type === 'TEXT' && e.text) {
        const p = this._tx(o, e.x, e.y);
        const fpx = Math.max(6, (e.h || 2) * o.scale);
        ctx.font = `${fpx}px system-ui, sans-serif`;
        ctx.fillText(String(e.text), p.x, p.y);
      }
    }
    ctx.restore();
  },
};
