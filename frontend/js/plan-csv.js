/* ProtectionPro — Plan Markup CSV exports.
 *
 * Element / route / trench / crossing / street-light schedules with measured
 * lengths in metres (via the calibration factor). Reuses the shared csvCell()
 * (formula-injection guard + quoting) and prepends a UTF-8 BOM so the °/×/m
 * glyphs survive in Excel. Section banners follow the exportResultsCSV style.
 */

const PlanCSV = {
  _factor() { const s = AppState.planMarkup.scale; return (s && s.factor) ? s.factor : null; },

  _elById() { const m = {}; for (const e of AppState.planMarkup.elements) m[e.id] = e; return m; },

  _fname(what) {
    const base = (AppState.projectName || 'plan').replace(/[^\w-]+/g, '_');
    return `${base}_plan_${what}.csv`;
  },

  _download(rows, what) {
    const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = this._fname(what);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Layer names whose type-lists include this entity type.
  _layersFor(listKey, type) {
    return AppState.planMarkup.layers
      .filter(L => (L[listKey] || []).includes(type))
      .map(L => L.name).join('; ');
  },

  _routeLenM(r, f) {
    let px = 0;
    for (let i = 1; i < r.points.length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
    return f ? +(px * f).toFixed(2) : 0;
  },

  _effectiveType(r, elById) {
    const a = r.fromId && elById[r.fromId], b = r.toId && elById[r.toId];
    const t = [a && a.type, b && b.type];
    if (t.includes('kiosk') && t.includes('erf')) return 'service';
    if (t.includes('manhole') && t.includes('erf')) return 'fibreErf';
    if (t.includes('pole')) return 'sl';
    return r.type;
  },

  // ─── Individual schedules ───
  exportElements() {
    const pm = AppState.planMarkup, f = this._factor();
    const rows = [['Type', 'Name', 'Domain', 'Layer(s)', 'X (m)', 'Y (m)']];
    const counts = {};
    for (const el of pm.elements) {
      const def = PLAN_DEFS.element(el.type) || {};
      counts[el.type] = (counts[el.type] || 0) + 1;
      rows.push([
        def.name || el.type, el.name || '', def.domain || '',
        this._layersFor('visibleElementTypes', el.type),
        f ? (el.x * f).toFixed(2) : '', f ? (el.y * f).toFixed(2) : '',
      ]);
    }
    rows.push([], ['=== SUMMARY ===']);
    rows.push(['Type', 'Count']);
    for (const [t, n] of Object.entries(counts)) rows.push([(PLAN_DEFS.element(t) || {}).name || t, n]);
    this._download(rows, 'elements');
  },

  exportRoutes() {
    const pm = AppState.planMarkup, f = this._factor(), elById = this._elById();
    const rows = [['Route Type', 'From', 'To', 'Cable Type', 'Measured Length (m)', 'Layer(s)']];
    const totals = {};
    for (const r of pm.routes) {
      const et = this._effectiveType(r, elById);
      const def = PLAN_DEFS.route(et) || PLAN_DEFS.route(r.type) || {};
      const len = this._routeLenM(r, f);
      totals[et] = +((totals[et] || 0) + len).toFixed(2);
      const from = (elById[r.fromId] && elById[r.fromId].name) || '';
      const to = (elById[r.toId] && elById[r.toId].name) || '';
      rows.push([def.name || et, from, to, r.cableType || '', f ? len.toFixed(2) : '', this._layersFor('routeTypes', et)]);
    }
    rows.push([], ['=== TOTALS (m) ===']);
    for (const [t, v] of Object.entries(totals)) rows.push([(PLAN_DEFS.route(t) || {}).name || t, v]);
    this._download(rows, 'routes');
  },

  exportTrenches() {
    const pm = AppState.planMarkup, f = this._factor();
    const rows = [['Name', 'Excavation Type', 'Width (m)', 'Depth (m)', 'Length (m)', 'Volume (m³)']];
    const totLen = {}, totVol = {};
    for (const t of pm.trenches) {
      const def = PLAN_DEFS.trenchTypes[t.excType] || {};
      const w = t.widthOverride || def.width || 0;
      const d = t.depthOverride || def.depth || 0;
      let px = 0;
      for (let i = 1; i < t.points.length; i++) px += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y);
      const len = f ? +(px * f).toFixed(2) : 0;
      const vol = +(w * d * len).toFixed(2);
      totLen[t.excType] = +((totLen[t.excType] || 0) + len).toFixed(2);
      totVol[t.excType] = +((totVol[t.excType] || 0) + vol).toFixed(2);
      rows.push([t.name || '', t.excType, w, d, f ? len.toFixed(2) : '', f ? vol.toFixed(2) : '']);
    }
    rows.push([], ['=== TOTALS ==='], ['Excavation Type', 'Length (m)', 'Volume (m³)']);
    for (const k of Object.keys(totLen)) rows.push([k, totLen[k], totVol[k]]);
    this._download(rows, 'trenches');
  },

  exportCrossings() {
    const pm = AppState.planMarkup, f = this._factor();
    const rows = [['Name', 'Duct Size (mm)', 'Length (m)']];
    const totBySize = {};
    for (const c of pm.crossings) {
      const px = Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y);
      const len = f ? +(px * f).toFixed(2) : 0;
      totBySize[c.size] = +((totBySize[c.size] || 0) + len).toFixed(2);
      rows.push([c.name || '', c.size, f ? len.toFixed(2) : '']);
    }
    rows.push([], ['=== TOTALS BY SIZE (m) ===']);
    for (const [s, v] of Object.entries(totBySize)) rows.push([`${s} mm`, v]);
    this._download(rows, 'crossings');
  },

  exportStreetlights() {
    const f = this._factor();
    const circuits = (typeof PlanSync !== 'undefined') ? PlanSync.buildSLCircuits(f) : [];
    const rows = [['Circuit', 'Source', 'Pole #', 'Pole Name', 'Phase', 'Spacing (m)', 'Cumulative (m)', 'Cable']];
    circuits.forEach((c, ci) => {
      c.poles.forEach((p, pi) => {
        rows.push([`SL${ci + 1}`, c.source, pi + 1, p.name, p.phase,
          f ? p.spacing.toFixed(2) : '', f ? p.cumulative.toFixed(2) : '', p.cable || '']);
      });
    });
    this._download(rows, 'streetlights');
  },

  exportRooms() {
    const pm = AppState.planMarkup, f = this._factor();
    const rows = [['Name', 'Area (m²)', 'Perimeter (m)', 'Vertices']];
    let totArea = 0;
    for (const rm of (pm.rooms || [])) {
      const area = f ? +(PlanEngine._polyArea(rm.points) * f * f).toFixed(2) : 0;
      let per = 0;
      for (let i = 0; i < rm.points.length; i++) {
        const a = rm.points[i], b = rm.points[(i + 1) % rm.points.length];
        per += Math.hypot(b.x - a.x, b.y - a.y);
      }
      totArea += area;
      rows.push([rm.name || '', f ? area.toFixed(2) : '', f ? (per * f).toFixed(2) : '', rm.points.length]);
    }
    rows.push([], ['TOTAL', f ? totArea.toFixed(2) : '']);
    this._download(rows, 'rooms');
  },

  // Bill of Quantities: cable lengths (× waste), element counts, trench
  // lengths — each with Qty/Unit/Rate/Subtotal from settings.rates.
  exportBOQ() {
    const pm = AppState.planMarkup, f = this._factor(), elById = this._elById();
    const rates = (pm.settings && pm.settings.rates) || {};
    const cableRate = rates.cablePerM || 0, equipRate = rates.equipUnit || 0;
    const trenchRate = rates.trenchPerM || 0, waste = 1 + (rates.wasteFactorPct || 0) / 100;
    const rows = [['Item', 'Category', 'Description', 'Qty', 'Unit', 'Rate', 'Subtotal']];
    let item = 0, grand = 0;
    const add = (cat, desc, qty, unit, rate) => {
      const sub = +(qty * rate).toFixed(2); grand += sub;
      rows.push([++item, cat, desc, qty, unit, rate, sub.toFixed(2)]);
    };
    // Cables by (effective) route type
    const cableLen = {};
    for (const r of pm.routes) {
      const et = this._effectiveType(r, elById);
      cableLen[et] = +((cableLen[et] || 0) + this._routeLenM(r, f)).toFixed(2);
    }
    for (const [et, len] of Object.entries(cableLen)) {
      const qty = +(len * waste).toFixed(2);
      add('Cable', `${(PLAN_DEFS.route(et) || {}).name || et} (incl. ${rates.wasteFactorPct || 0}% waste)`, qty, 'm', cableRate);
    }
    // Equipment by element type
    const counts = {};
    for (const el of pm.elements) counts[el.type] = (counts[el.type] || 0) + 1;
    for (const [t, n] of Object.entries(counts)) {
      add('Equipment', (PLAN_DEFS.element(t) || {}).name || t, n, 'ea', equipRate);
    }
    // Excavation by trench type
    const trLen = {};
    for (const tr of pm.trenches) {
      let px = 0; for (let i = 1; i < tr.points.length; i++) px += Math.hypot(tr.points[i].x - tr.points[i - 1].x, tr.points[i].y - tr.points[i - 1].y);
      trLen[tr.excType] = +((trLen[tr.excType] || 0) + (f ? px * f : 0)).toFixed(2);
    }
    for (const [k, len] of Object.entries(trLen)) add('Excavation', `${k} trench`, len, 'm', trenchRate);
    rows.push([], ['', '', 'TOTAL', '', '', '', grand.toFixed(2)]);
    this._download(rows, 'boq');
  },

  // Fire every non-empty schedule (menu "Export all schedules").
  exportAll() {
    const pm = AppState.planMarkup;
    if (pm.elements.length) this.exportElements();
    if (pm.routes.length) this.exportRoutes();
    if (pm.trenches.length) this.exportTrenches();
    if (pm.crossings.length) this.exportCrossings();
    if (pm.rooms && pm.rooms.length) this.exportRooms();
    if (typeof PlanSync !== 'undefined' && PlanSync.buildSLCircuits(this._factor()).length) this.exportStreetlights();
    if (pm.routes.length || pm.elements.length || pm.trenches.length) this.exportBOQ();
    if (!pm.elements.length && !pm.routes.length && !pm.trenches.length && !pm.crossings.length) {
      UI.toast('Nothing to export yet.', 'info');
    }
  },
};
