/* ProtectionPro — Plan Markup DXF export (AutoCAD R12 / AC1009).
 *
 * A faithful, dependency-free R12 writer (HEADER + TABLES/LAYER + ENTITIES;
 * POLYLINE/VERTEX/SEQEND, LINE, CIRCLE, TEXT — no LWPOLYLINE, no BLOCKS).
 * All geometry is emitted in METRES via the calibration factor, with the
 * image-pixel Y axis flipped (DXF Y is up). Export is refused when the plan
 * is not calibrated — a pixel-unit DXF would be worse than none.
 */

const PlanDXF = {
  // discipline/entity → DXF layer name + colour (mapped to nearest ACI).
  LAYER_COLORS: {
    MV_RETICULATION: '#ef4444', LV_RETICULATION: '#3b82f6', SERVICE_CABLES: '#22c55e',
    STREET_LIGHTING: '#f59e0b', FIBRE: '#a855f7', CABLE_LABELS: '#94a3b8',
    ELEMENTS: '#111827', ELEMENT_LABELS: '#334155', TRENCHING: '#7c3aed',
    CROSSINGS: '#f97316', TEXT: '#111827', DIMENSIONS: '#0ea5e9', NOTES: '#64748b',
    // building domain
    POWER: '#ef4444', FINAL_CIRCUITS: '#3b82f6', LIGHTING: '#eab308',
    CONTAINMENT: '#475569', DATA: '#0891b2', FIRE: '#dc2626', CONTROL: '#db2777',
  },
  _ACI: [ // aci, r, g, b
    [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255],
    [5, 0, 0, 255], [6, 255, 0, 255], [7, 255, 255, 255], [8, 128, 128, 128],
    [9, 192, 192, 192], [30, 255, 128, 0], [40, 128, 0, 255], [250, 51, 51, 51],
  ],

  _hexToAci(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 7;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    let best = 7, bd = Infinity;
    for (const [aci, cr, cg, cb] of this._ACI) {
      const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
      if (d < bd) { bd = d; best = aci; }
    }
    return best;
  },

  _bbox() {
    const pm = AppState.planMarkup;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; any = true; };
    for (const el of pm.elements) acc(el.x, el.y);
    for (const r of pm.routes) for (const p of r.points) acc(p.x, p.y);
    for (const t of pm.trenches) for (const p of t.points) acc(p.x, p.y);
    for (const c of pm.crossings) { acc(c.p1.x, c.p1.y); acc(c.p2.x, c.p2.y); }
    for (const t of pm.texts) acc(t.x, t.y);
    for (const m of pm.measurements) for (const p of m.points) acc(p.x, p.y);
    return any ? { minX, minY, maxX, maxY } : null;
  },

  export() {
    const pm = AppState.planMarkup;
    const factor = (pm.scale && pm.scale.factor) ? pm.scale.factor : null;
    if (!factor) { UI.alert('Plan is not calibrated — use the Calibrate tool before exporting DXF.'); return; }
    const box = this._bbox();
    if (!box) { UI.alert('Nothing to export.'); return; }
    const elById = {}; for (const e of pm.elements) elById[e.id] = e;

    // image-pixel → metres, Y flipped
    const t = (x, y) => ({ x: (x - box.minX) * factor, y: (box.maxY - y) * factor });

    const g = [];
    const p = (code, val) => { g.push(String(code)); g.push(String(val)); };
    const layers = Object.keys(this.LAYER_COLORS);

    // HEADER
    p(0, 'SECTION'); p(2, 'HEADER');
    p(9, '$ACADVER'); p(1, 'AC1009');
    p(9, '$INSUNITS'); p(70, 6); // metres
    const ext = t(box.minX, box.maxY), ext2 = t(box.maxX, box.minY);
    p(9, '$EXTMIN'); p(10, ext.x); p(20, ext.y); p(30, 0);
    p(9, '$EXTMAX'); p(10, ext2.x); p(20, ext2.y); p(30, 0);
    p(0, 'ENDSEC');

    // TABLES → LAYER
    p(0, 'SECTION'); p(2, 'TABLES'); p(0, 'TABLE'); p(2, 'LAYER'); p(70, layers.length + 1);
    p(0, 'LAYER'); p(2, '0'); p(70, 0); p(62, 7); p(6, 'CONTINUOUS');
    for (const name of layers) {
      p(0, 'LAYER'); p(2, name); p(70, 0); p(62, this._hexToAci(this.LAYER_COLORS[name])); p(6, 'CONTINUOUS');
    }
    p(0, 'ENDTAB'); p(0, 'ENDSEC');

    // ENTITIES
    p(0, 'SECTION'); p(2, 'ENTITIES');

    const line = (a, b, layer) => { p(0, 'LINE'); p(8, layer); p(10, a.x); p(20, a.y); p(30, 0); p(11, b.x); p(21, b.y); p(31, 0); };
    const circle = (c, r, layer) => { p(0, 'CIRCLE'); p(8, layer); p(10, c.x); p(20, c.y); p(30, 0); p(40, r); };
    const text = (c, h, s, layer) => { p(0, 'TEXT'); p(8, layer); p(10, c.x); p(20, c.y); p(30, 0); p(40, h); p(1, String(s)); };
    const poly = (pts, closed, layer) => {
      p(0, 'POLYLINE'); p(8, layer); p(66, 1); p(70, closed ? 1 : 0);
      for (const pt of pts) { p(0, 'VERTEX'); p(8, layer); p(10, pt.x); p(20, pt.y); p(30, 0); }
      p(0, 'SEQEND'); p(8, layer);
    };

    const effType = (r) => {
      const a = r.fromId && elById[r.fromId], b = r.toId && elById[r.toId];
      const tt = [a && a.type, b && b.type];
      if (tt.includes('kiosk') && tt.includes('erf')) return 'service';
      if (tt.includes('manhole') && tt.includes('erf')) return 'fibreErf';
      if (tt.includes('pole')) return 'sl';
      return r.type;
    };
    const routeLayer = (et) => (PLAN_DEFS.route(et) && PLAN_DEFS.route(et).dxfLayer) || 'MV_RETICULATION';

    // Routes → POLYLINE + midpoint label
    for (const r of pm.routes) {
      if (r.points.length < 2) continue;
      const et = effType(r);
      const layer = routeLayer(et);
      poly(r.points.map(pt => t(pt.x, pt.y)), false, layer);
      // length label
      let px = 0; for (let i = 1; i < r.points.length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
      const lenM = (px * factor).toFixed(2);
      const mid = r.points[Math.floor(r.points.length / 2)];
      text(t(mid.x, mid.y), 1.0, `${r.cableType ? r.cableType + ' ' : ''}${lenM} m`, 'CABLE_LABELS');
    }

    // Elements → CIRCLE / rotated square POLYLINE / X-lines + name label
    for (const el of pm.elements) {
      const def = PLAN_DEFS.element(el.type) || {};
      const shape = def.dxf ? def.dxf.shape : 'circle';
      const sizeM = def.dxf ? def.dxf.sizeM : 1;
      const c = t(el.x, el.y);
      if (shape === 'circle') {
        circle(c, sizeM / 2, 'ELEMENTS');
      } else if (shape === 'square') {
        const h = sizeM / 2;
        const rot = (el.rotation || 0) * Math.PI / 180;
        const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([dx, dy]) => {
          const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
          const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
          // world px offset = metres / factor; transform the world point
          return t(el.x + rx / factor, el.y + ry / factor);
        });
        poly(corners, true, 'ELEMENTS');
      } else { // 'x' → two crossing lines
        const h = sizeM / 2;
        line(t(el.x - h / factor, el.y - h / factor), t(el.x + h / factor, el.y + h / factor), 'ELEMENTS');
        line(t(el.x - h / factor, el.y + h / factor), t(el.x + h / factor, el.y - h / factor), 'ELEMENTS');
      }
      if (el.name) text(t(el.x + (sizeM * 0.7) / factor, el.y), 1.2, el.name, 'ELEMENT_LABELS');
    }

    // Trenches → centerline POLYLINE + label
    for (const tr of pm.trenches) {
      if (tr.points.length < 2) continue;
      poly(tr.points.map(pt => t(pt.x, pt.y)), false, 'TRENCHING');
      const def = PLAN_DEFS.trenchTypes[tr.excType] || {};
      const w = tr.widthOverride || def.width || 0, d = tr.depthOverride || def.depth || 0;
      const mid = tr.points[Math.floor(tr.points.length / 2)];
      text(t(mid.x, mid.y), 1.0, `${tr.name || ''} ${tr.excType} ${w}x${d}`, 'TRENCHING');
    }

    // Crossings → LINE + label
    for (const c of pm.crossings) {
      line(t(c.p1.x, c.p1.y), t(c.p2.x, c.p2.y), 'CROSSINGS');
      const mid = { x: (c.p1.x + c.p2.x) / 2, y: (c.p1.y + c.p2.y) / 2 };
      text(t(mid.x, mid.y), 1.0, `${c.name || ''} ${c.size}mm duct`, 'CROSSINGS');
    }

    // Text annotations
    for (const tx of pm.texts) {
      const h = Math.max(0.3, (tx.fontSize || 14) * factor);
      text(t(tx.x, tx.y), h, tx.text || '', 'TEXT');
    }

    // Measurements → POLYLINE + length label
    for (const m of pm.measurements) {
      if (m.points.length < 2) continue;
      poly(m.points.map(pt => t(pt.x, pt.y)), false, 'DIMENSIONS');
      let px = 0; for (let i = 1; i < m.points.length; i++) px += Math.hypot(m.points[i].x - m.points[i - 1].x, m.points[i].y - m.points[i - 1].y);
      const mid = m.points[m.points.length - 1];
      text(t(mid.x, mid.y), 1.0, `${(px * factor).toFixed(2)} m`, 'DIMENSIONS');
    }

    // Note: the background raster is not embedded.
    const noteY = (box.maxY - box.minY) * factor + 2;
    text({ x: 0, y: noteY }, 1.5, 'Background plan image not included - overlay on original. 1 unit = 1 m.', 'NOTES');

    p(0, 'ENDSEC'); p(0, 'EOF');

    this._downloadDxf(g.join('\r\n') + '\r\n');
  },

  _downloadDxf(content) {
    const base = (AppState.projectName || 'plan').replace(/[^\w-]+/g, '_');
    const blob = new Blob([content], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${base}_plan_markup.dxf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
