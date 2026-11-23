/* ProtectionPro — Plan Markup DXF export (client).
 *
 * The DXF itself is built on the backend with ezdxf (AC1015 / R2000) so it is
 * guaranteed spec-valid — real BLOCK/INSERT with ATTRIB attributes, true
 * SPLINE curves and LWPOLYLINE straights. This module just gathers the active
 * floor into a payload — the symbol geometry comes straight from the on-screen
 * PLAN_SYMBOLS recipes so the exported blocks match the drawing exactly — POSTs
 * it, and downloads the returned file.
 */

// Core ATTRIB/XDATA tags carried on every device blockref — the AutoCAD LISP
// toolkit's own vocabulary (REF/TYPE/DBFED/CIRCUIT/PHASE/CABLE all match its
// block attribute names directly; LOAD_VA is ours — the LISP side keys its
// equivalent per block as WATTS/LOAD_W/LOAD_KW/LOAD_EST, so there's no single
// tag name to adopt). Must match backend `ATTR_TAGS` (plan_dxf.py) exactly.
const PLAN_DXF_CORE_ATTRS = ['REF', 'TYPE', 'DBFED', 'CIRCUIT', 'PHASE', 'LOAD_VA', 'CABLE'];

const PlanDXF = {
  _factor() { const s = AppState.planMarkup.scale; return (s && s.factor) ? s.factor : null; },

  // Stable block name per symbol variant (parametric families differ by props).
  _variantKey(el) {
    const p = el.props || {};
    switch (el.type) {
      case 'bd_light': return p.kind || 'ceiling';
      case 'bd_socket': return (p.outlets || 'single') + (p.weatherproof ? 'wp' : '');
      case 'bd_switch': return (p.kind || 'standard') + 'g' + (p.gangs || '1');
      case 'bd_switchboard': return 's' + (p.sections || (p.props && p.props.sections) || 1);
      default: return '';
    }
  },
  // A type with a `dxfBlock` uses the LISP toolkit's own fixed block name
  // (one shared symbol for every variant, matching how the LISP toolkit
  // itself has no visual permutation for e.g. LUMINAIRE) — the variant
  // (kind/outlets/gangs) instead round-trips via the PP_VARIANT tag. A type
  // with no LISP counterpart keeps the old PP_<type>_<variant> scheme, one
  // block definition per variant, so its glyph stays variant-accurate.
  _blockName(el) {
    const def = PLAN_DEFS.element(el.type) || {};
    if (def.dxfBlock) return def.dxfBlock;
    const v = this._variantKey(el);
    return 'PP_' + el.type + (v ? '_' + v : '');
  },
  // Extra ATTRIB tags a block needs beyond the core set: LISP-named tags for
  // any declared field with a PLAN_DXF_FIELD_TAGS entry, plus PP_VARIANT for
  // the parametric families (own round-trip fidelity only).
  _extraAttrTags(type) {
    const def = PLAN_DEFS.element(type);
    if (!def || !def.dxfBlock) return [];
    const tags = [];
    for (const f of (def.fields || [])) {
      const t = PLAN_DXF_FIELD_TAGS[f.key];
      if (t && !tags.includes(t)) tags.push(t);
    }
    if (['bd_light', 'bd_socket', 'bd_switch', 'bd_switchboard'].includes(type)) tags.push('PP_VARIANT');
    return tags;
  },

  _routeLenM(r, f) {
    let px = 0;
    for (let i = 1; i < r.points.length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
    return f ? px * f : 0;
  },

  // Any CSS colour the plan uses ('#rgb', '#rrggbb', 'rgb()' / 'rgba()') → '#rrggbb' (alpha dropped), or '' when it is not one.
  _hex(c) {
    if (!c || typeof c !== 'string') return '';
    const t = c.trim();
    let m = /^#([0-9a-f]{3})$/i.exec(t); if (m) return '#' + m[1].split('').map(x => x + x).join('').toLowerCase();
    m = /^#([0-9a-f]{6})/i.exec(t); if (m) return '#' + m[1].toLowerCase();
    m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(t);
    if (m) return '#' + [m[1], m[2], m[3]].map(v => Math.max(0, Math.min(255, +v)).toString(16).padStart(2, '0')).join('');
    return '';
  },

  // The export's choices: drawing scale and paper text height (the text size when plotted), and the background drawings.
  // Kept per project in planMarkup.settings.dxfExport.
  SCALES: [100, 200, 250, 500, 1000, 1250, 2000, 2500],
  HEIGHTS: [1.8, 2.5, 3.5, 5],
  _options() {
    const pm = AppState.planMarkup, st = pm.settings.dxfExport = Object.assign({ scale: 500, paperMm: 2.5, bg: true }, pm.settings.dxfExport || {});
    const bgs = typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)) : [];
    const orig = bgs.filter(d => d.srcId != null).length;
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'modal ui-dialog'; ov.style.zIndex = '3000';
      const sel = (id, vals, cur, fmt) => `<select id="${id}" style="width:100%">${vals.map(v => `<option value="${v}"${+v === +cur ? ' selected' : ''}>${fmt(v)}</option>`).join('')}</select>`;
      ov.innerHTML = `<div class="modal-content ui-dialog-content" role="dialog" aria-modal="true" aria-labelledby="pdx-t" style="max-width:440px">
        <div class="modal-header"><h3 id="pdx-t">Export DXF</h3></div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
          <label>Drawing scale ${sel('pdx-scale', this.SCALES, st.scale, v => '1 : ' + v)}</label>
          <label>Text height on paper ${sel('pdx-h', this.HEIGHTS, st.paperMm, v => v + ' mm')}</label>
          <div style="font-size:12px;color:var(--text-muted)" id="pdx-hint"></div>
          ${bgs.length ? `<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="pdx-bg"${st.bg ? ' checked' : ''}> <span>Include the background drawing${bgs.length === 1 ? '' : 's'} (${bgs.length}): what the plan shows, on BG- layers.${orig < bgs.length ? ` ${bgs.length - orig === bgs.length ? (bgs.length === 1 ? 'It was' : 'They were') : (bgs.length - orig) + ' of them were'} imported before the original was kept, so ${bgs.length - orig === 1 ? 'it is' : 'they are'} rebuilt from the plan's copy (no linetypes or hatch fills); import again to get the original exactly.` : ''}</span></label>` : ''}
          <div class="ui-dialog-actions"><button type="button" class="btn-small" data-x="cancel">Cancel</button><button type="button" class="btn-primary" data-x="ok">Export</button></div>
        </div></div>`;
      document.body.appendChild(ov);
      const hint = () => { const sc = +ov.querySelector('#pdx-scale').value, mm = +ov.querySelector('#pdx-h').value; ov.querySelector('#pdx-hint').textContent = `Text is ${(mm * sc / 1000).toFixed(2)} m high in the drawing (${mm} mm when plotted at 1 : ${sc}); dashed cables plot with 5 mm dashes.`; };
      ov.addEventListener('change', hint); hint();
      const done = ok => { const r = ok ? { scale: +ov.querySelector('#pdx-scale').value, paperMm: +ov.querySelector('#pdx-h').value, bg: !!(ov.querySelector('#pdx-bg') && ov.querySelector('#pdx-bg').checked) } : null;
        document.removeEventListener('keydown', key, true); ov.remove(); if (r) { Object.assign(st, r); PlanMarkup.markDirty(); } resolve(r); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); done(true); } };
      document.addEventListener('keydown', key, true);
      ov.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x === 'ok'); else if (e.target === ov) done(false); });
      ov.querySelector('[data-x="ok"]').focus();
    });
  },

  // A background drawing as the export takes it: where the plan puts it (`m`: the parsed copy's coordinates → the export's metres),
  // its layers hidden on the plan, the entities already turned into plan items, the working area, colours set on the plan; the
  // original file when it was kept (`srcId`), else the stored parsed copy (`imageId`), else the copy itself (not yet stored).
  _background(desc, factor) {
    const W = (x, y) => { const q = PlanDxfImport.worldOf(desc, x, y); return [q.x * factor, -q.y * factor]; };
    const o = W(0, 0), ux = W(1, 0), uy = W(0, 1);
    const data = PlanDxfImport.dataOf(desc);
    const hidden = [], colors = {};
    for (const [name, stl] of Object.entries(desc.layers || {})) { if (stl && stl.hidden) hidden.push(name); if (stl && stl.color) colors[name] = this._hex(stl.color); }
    // the working area, else the DXF's own area to import (its parts outside are kept in the file, hidden)
    const area = (typeof PlanWorkArea !== 'undefined' && PlanWorkArea.localPoly ? PlanWorkArea.localPoly(desc) : null)
      || (desc.clip && desc.clip.pts && desc.clip.pts.length >= 3 ? desc.clip.pts.map(q => [q[0], q[1]]) : null);
    return { name: desc.name || 'drawing', srcId: desc.srcId != null ? desc.srcId : null, imageId: desc.imageId != null ? desc.imageId : null,
      data: desc.imageId == null ? data : undefined, origin: (data && data.origin) || desc.origin || [0, 0],
      m: [ux[0] - o[0], uy[0] - o[0], o[0], ux[1] - o[1], uy[1] - o[1], o[1]],
      hidden, converted: desc.converted || [], colors, area: area || null };
  },

  async export() {
    const pm = AppState.planMarkup;
    const factor = this._factor();
    if (!factor) { UI.alert('Plan is not calibrated — use the Calibrate tool before exporting DXF.'); return; }
    const opt = await this._options(); if (!opt) return;
    const H = opt.paperMm * opt.scale / 1000;                    // text height in the drawing, m
    const elById = {}; for (const e of pm.elements) elById[e.id] = e;
    const boardName = (id) => { const b = elById[id]; return b ? (b.name || '') : ''; };
    // layers: the plan's colour of the first thing on each (true colour); a layer of dashed cables gets the DASHED linetype
    const layers = {}, ltypes = {};
    const layer = (name, color, lt) => { if (name && !layers[name]) { layers[name] = this._hex(color) || '#333333'; if (lt) ltypes[name] = lt; } return name; };
    const styles = pm.styles;

    // Symbol blocks (one per variant, or one per type when it has a fixed
    // LISP block name) + device instances with attributes.
    const blocks = {}, elements = [];
    for (const el of pm.elements) {
      const def = PLAN_DEFS.element(el.type) || {};
      const name = this._blockName(el);
      if (!blocks[name]) {
        // A LISP-named block is one shared symbol for every variant — glyph
        // from the type's OWN defaults, not whichever instance is placed
        // first, so the block definition is deterministic.
        const glyphProps = def.dxfBlock ? PLAN_DEFS.defaults(el.type) : el.props;
        let prims = (typeof PlanSymbols !== 'undefined' && PlanSymbols.prims) ? PlanSymbols.prims(el.type, glyphProps) : null;
        if (!prims || !prims.length) prims = [{ k: 'r', x: 8, y: 8, w: 24, h: 24, s: 'col' }];
        const sizeWorld = (typeof PlanSymbols !== 'undefined' && PlanSymbols.size) ? PlanSymbols.size(el.type, glyphProps) : (def.dxf ? def.dxf.sizeM * 20 : 24);
        const attrTags = PLAN_DXF_CORE_ATTRS.concat(this._extraAttrTags(el.type));
        blocks[name] = { sizeWorld, prims, attrTags };
      }
      const ecol = this._hex(el.type === 'load' && typeof PlanLoads !== 'undefined' ? PlanLoads.color(el) : PLAN_DEFS.elementColor(el.type, styles));
      const lname = layer(def.dxfLayer || ('EL_' + (def.group || 'MISC').toUpperCase().replace(/[^A-Z0-9]+/g, '_')), ecol || def.color);
      const isCircuit = typeof PlanCircuits !== 'undefined' && PlanCircuits.isCircuitDevice && PlanCircuits.isCircuitDevice(el.type);
      const load = isCircuit ? PlanCircuits.deviceVA(el) : '';
      const p = el.props || {};
      const attrs = {
        REF: el.name || '', TYPE: el.type,
        DBFED: p.circuitDbId ? boardName(p.circuitDbId) : '',
        CIRCUIT: (p.circuitNo != null ? p.circuitNo : ''),
        PHASE: isCircuit ? (p.poles === '3P' ? '3P' : '1P') : '',
        LOAD_VA: load === '' ? '' : String(load),
        CABLE: p.cableType || '',
      };
      for (const f of (def.fields || [])) {
        const tag = PLAN_DXF_FIELD_TAGS[f.key];
        if (tag && p[f.key] != null && p[f.key] !== '') attrs[tag] = String(p[f.key]);
      }
      if (def.dxfBlock && ['bd_light', 'bd_socket', 'bd_switch', 'bd_switchboard'].includes(el.type)) {
        attrs.PP_VARIANT = this._variantKey(el);
      }
      elements.push({ block: name, type: el.type, x: el.x, y: el.y, rotation: el.rotation || 0, layer: lname, attrs, color: ecol });
    }

    // Routes (curved flag preserved) + cable/length label.
    const routes = [];
    for (const r of pm.routes) {
      if (!r.points || r.points.length < 2) continue;
      const rdef = PLAN_DEFS.route(r.type) || {};
      const rcol = this._hex(PLAN_DEFS.routeColor(r.type, styles)) || '#3b82f6', lt = rdef.lineStyle === 'dashed' ? 'DASHED' : null;
      const lname = layer(rdef.dxfLayer || ('RT_' + String(r.type).toUpperCase()), rcol, lt);
      const lenM = this._routeLenM(r, factor);
      // type/cable/end names travel as XDATA so a re-import rebuilds the
      // route exactly (the layer alone can't carry a mixed-case type key).
      routes.push({
        layer: lname, type: r.type, curved: !!r.curved, cable: r.cableType || '',
        fromName: r.fromId ? boardName(r.fromId) : '', toName: r.toId ? boardName(r.toId) : '',
        label: `${r.cableType ? r.cableType + ' ' : ''}${lenM.toFixed(2)} m`,
        pts: r.points.map(p => [p.x, p.y]), color: rcol, linetype: lt || 'CONTINUOUS',
      });
    }

    const trenches = (pm.trenches || []).filter(t => t.points && t.points.length >= 2)
      .map(t => ({ pts: t.points.map(p => [p.x, p.y]), excType: t.excType || '', name: t.name || '', color: this._hex((PLAN_DEFS.trenchTypes[t.excType] || {}).color) || '#787878' }));
    const roomStroke = this._hex(PLAN_DEFS.room.stroke) || '#0ea5e9';
    const rooms = (pm.rooms || []).filter(rm => rm.points && rm.points.length >= 3)
      .map(rm => ({ label: rm.name || '', pts: rm.points.map(p => [p.x, p.y]), color: this._hex(rm.color) || roomStroke }));
    const dimCol = this._hex(PLAN_DEFS.annotations && PLAN_DEFS.annotations.measurement && PLAN_DEFS.annotations.measurement.color) || '#0f766e';
    const measurements = (pm.measurements || []).filter(m => m.points && m.points.length >= 2)
      .map(m => ({ pts: m.points.map(p => [p.x, p.y]), color: dimCol }));
    const xst = (PLAN_DEFS.crossings && PLAN_DEFS.crossings.style) || {};
    const crossings = (pm.crossings || []).filter(c => c.p1 && c.p2)
      .map(c => ({ p1: [c.p1.x, c.p1.y], p2: [c.p2.x, c.p2.y], size: c.size || '', name: c.name || '', color: this._hex((xst[c.size] || {}).color || (PLAN_DEFS.crossings && PLAN_DEFS.crossings.color)) }));
    // a plan text is its size relative to the normal 14 (so a 28 is twice the drawing's text height), in its own colour
    const texts = (pm.texts || []).map(t => ({ x: t.x, y: t.y, h: t.fontSize || 14, rel: (t.fontSize || 14) / 14, text: t.text || '', color: this._hex(t.color) || '#111827' }));
    const backgrounds = opt.bg && typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).map(d => this._background(d, factor)) : [];

    const af = (typeof AppState.planActiveFloor === 'function') && AppState.planActiveFloor();
    const payload = {
      factor, floorName: (af && af.name) || '', domain: pm.settings.domain || '',
      fileName: ((AppState.projectName || 'plan').replace(/[^\w-]+/g, '_')) + (af && af.name ? '_' + af.name.replace(/[^\w-]+/g, '_') : ''),
      layers: Object.entries(layers).map(([name, color]) => ({ name, color, linetype: ltypes[name] || null })),
      extraLayers: { PP_TRENCH: '#787878', PP_ROOMS: roomStroke, PP_TEXT: '#111827', PP_DIM: dimCol, PP_LABELS: '#334155' },
      textH: H, ltscale: opt.scale / 100, scale: opt.scale,
      blocks, elements, routes, trenches, rooms, measurements, crossings, texts, backgrounds,
    };

    // UX-10: disable the trigger + show a busy overlay for the backend round-trip.
    const btn = document.querySelector('#plan-toolbar [data-action="dxf"]');
    if (btn) btn.disabled = true;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, 'Exporting DXF…');
    try {
      const resp = await fetch(`${API_BASE}/plan/dxf-export`, {
        method: 'POST', headers: API.authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      const notes = decodeURIComponent(resp.headers.get('X-PP-Notes') || '');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = payload.fileName + '.dxf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      UI.toast(`DXF exported at 1 : ${opt.scale}, text ${opt.paperMm} mm.${notes ? ' Background: ' + notes.split(' | ').join('; ') + '.' : ''}`, notes && /left out|rebuilt/.test(notes) ? 'warn' : 'success', 7000);
    } catch (e) {
      UI.alert('DXF export failed: ' + (e && e.message ? e.message : e));
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
      if (btn) btn.disabled = false;
    }
  },
};
