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

  // The export's choices: drawing scale, paper size of the layout sheets, paper text height (the text size when plotted), and
  // the background drawings. Kept per project in planMarkup.settings.dxfExport.
  SCALES: [100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000],
  HEIGHTS: [1.8, 2.5, 3.5, 5],
  PAPERS: { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] },   // mm, landscape; must match backend PAPERS
  MARGIN_MM: 10,
  LEGEND_COL_MM: 98,       // without a template the legend takes a column this wide right of the viewport
  STATUSES: ['PRELIMINARY', 'FOR COMMENT', 'FOR APPROVAL', 'FOR TENDER', 'FOR CONSTRUCTION', 'AS BUILT'],
  LABEL_STYLES: { circle: 'Leader with a circle on the cable', arrow: 'Leader with an arrow onto the cable', along: 'Text along the cable' },
  // route types drawn by the dozen (one per erf): no label unless the cable differs from the most common one, which is a
  // note in the legend instead
  TYPICAL: { service: 'Service cables', fibreErf: 'Fibre drops' },
  CHAIN: ['sl'],           // route types drawn span by span and looped through: one label per run (an LV cable kiosk to kiosk is its own cable)
  SHEET_TITLES: { MV: 'MV RETICULATION', LV: 'LV RETICULATION', SL: 'STREET LIGHTING', FIBRE: 'FIBRE NETWORK', DUCTS: 'ROAD CROSSING DUCTS',
    LIGHTING: 'LIGHTING LAYOUT', POWER: 'POWER LAYOUT', FIRE: 'FIRE DETECTION', ELV: 'ELECTRONIC SERVICES', PLAN: 'LAYOUT' },
  ISO_LW: [13, 18, 25, 35, 50, 70, 100],
  // a line the plan draws px screen pixels wide → its DXF line weight (hundredths of a mm): px × 0.175 mm, the nearest ISO pen
  lineweight(px) { const want = Math.max(0, +px || 0) * 17.5; return this.ISO_LW.reduce((b, w) => Math.abs(w - want) < Math.abs(b - want) ? w : b, this.ISO_LW[0]); },
  // 'rgba(r,g,b,a)' → a (1 for any other colour)
  _alpha(c) { const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(String(c || '').trim()); return m ? +m[1] : 1; },
  // the server's title-block template: { available, papers: { A1: { viewport: [w, h] } }, name }
  async _template() {
    if (this._tpl) return this._tpl;
    try {
      const r = await fetch(`${API_BASE}/plan/dxf-template`, { headers: API.authHeaders({}) });
      this._tpl = r.ok ? await r.json() : { available: false, papers: {} };
    } catch (_) { this._tpl = { available: false, papers: {} }; }
    return this._tpl;
  },
  // the viewport of a sheet of `paper` (mm): inside the template's frame left of its title panel, else within the margin
  _viewport(paper) {
    const t = this._tpl, v = t && t.available && t.papers && t.papers[paper] && t.papers[paper].viewport;
    if (v) return v;
    const [pw, ph] = this.PAPERS[paper] || this.PAPERS.A1;
    return [pw - 2 * this.MARGIN_MM - this.LEGEND_COL_MM - 3, ph - 2 * this.MARGIN_MM];
  },

  // The plan's extents in the export's metres ([xmin, ymin, xmax, ymax], DXF y up), from every plan item; null when there is none.
  _extents(pm, f) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (p) => { if (!p || !isFinite(p.x) || !isFinite(p.y)) return; const X = p.x * f, Y = -p.y * f;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; };
    for (const e of pm.elements || []) add(e);
    for (const list of [pm.routes, pm.trenches, pm.rooms, pm.measurements]) for (const r of list || []) for (const p of r.points || []) add(p);
    for (const c of pm.crossings || []) { add(c.p1); add(c.p2); }
    for (const t of pm.texts || []) add(t);
    return isFinite(x0) ? [x0, y0, x1, y1] : null;
  },
  // Does the plan fit the paper's viewport at 1 : scale? And the smallest listed scale that fits.
  _fit(ext, paper, scale) {
    const [uw, uh] = this._viewport(paper);
    if (!ext) return { ok: true, need: null, w: 0, h: 0 };
    const w = ext[2] - ext[0], h = ext[3] - ext[1];
    const fits = sc => w * 1000 / sc <= uw + 1e-6 && h * 1000 / sc <= uh + 1e-6;
    return { ok: fits(scale), need: this.SCALES.find(fits) || null, w, h };
  },
  // The layout sheets this plan has: a sheet is written when an item on it is not shown on every sheet; in PLAN_DXF_SHEETS order.
  // No such item → one sheet, 'Plan', with everything on it.
  _sheets(pm) {
    const used = new Set();
    const take = (row) => { if (Array.isArray(row[1])) row[1].forEach(id => used.add(id)); };
    for (const e of pm.elements || []) take(PLAN_DXF_LAYERS.of('element', e.type, PLAN_DEFS.element(e.type)));
    for (const r of pm.routes || []) if (r.points && r.points.length >= 2) take(PLAN_DXF_LAYERS.of('route', r.type, PLAN_DEFS.route(r.type)));
    if ((pm.trenches || []).length) take(PLAN_DXF_LAYERS.of('fixed', 'trench'));
    if ((pm.crossings || []).length) take(PLAN_DXF_LAYERS.of('fixed', 'crossing'));
    const out = PLAN_DXF_SHEETS.filter(s => used.has(s.id));
    return out.length ? out : [{ id: 'PLAN', name: 'Plan' }];
  },

  async _options() {
    const pm = AppState.planMarkup, st = pm.settings.dxfExport = Object.assign({ scale: 500, paperMm: 2.5, bg: true, paper: 'A1',
      labels: 'circle', status: 'PRELIMINARY', numberPattern: '{project}-EL-{nn}', revisions: [], notes: '', lengths: true }, pm.settings.dxfExport || {});
    const tpl = await this._template();
    const papers = Object.keys(this.PAPERS).filter(p => p !== 'A4' || (tpl.available && tpl.papers && tpl.papers.A4));
    const ext = this._extents(pm, this._factor()), sheets = this._sheets(pm);
    const bgs = typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)) : [];
    const orig = bgs.filter(d => d.srcId != null).length;
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'modal ui-dialog'; ov.style.zIndex = '3000';
      const sel = (id, vals, cur, fmt) => `<select id="${id}" style="width:100%">${vals.map(v => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${fmt(v)}</option>`).join('')}</select>`;
      ov.innerHTML = `<div class="modal-content ui-dialog-content" role="dialog" aria-modal="true" aria-labelledby="pdx-t" style="max-width:440px">
        <div class="modal-header"><h3 id="pdx-t">Export DXF</h3></div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
          <label>Drawing scale ${sel('pdx-scale', this.SCALES, st.scale, v => '1 : ' + v)}</label>
          <label>Paper size of the layout sheets ${sel('pdx-paper', papers, st.paper, v => v + ' landscape')}</label>
          <div style="font-size:12px" id="pdx-fit" aria-live="polite"></div>
          <div style="font-size:12px;color:var(--text-muted)">Layout sheets (${sheets.length}): ${sheets.map(s => escHtml(s.name)).join(', ')}. Each shows only its own layers, with a legend of what is on it.
            <span id="pdx-tpl"></span></div>
          <div id="pdx-tpl-admin" style="display:none;gap:6px;align-items:center;flex-wrap:wrap"><button type="button" class="btn-small" data-tpl="up"></button><button type="button" class="btn-small" data-tpl="del">Remove template</button><input type="file" id="pdx-tpl-file" accept=".dxf" hidden></div>
          <label>Text height on paper ${sel('pdx-h', this.HEIGHTS, st.paperMm, v => v + ' mm')}</label>
          <div style="font-size:12px;color:var(--text-muted)" id="pdx-hint"></div>
          <label>Cable labels ${sel('pdx-lab', Object.keys(this.LABEL_STYLES), st.labels, v => this.LABEL_STYLES[v])}</label>
          <div style="font-size:12px;color:var(--text-muted)">Service cables and fibre drops of the most common cable get no label of their own: a note in the legend says what they are.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <label>Status ${sel('pdx-status', this.STATUSES, st.status, v => v)}</label>
            <label>Drawing number <input id="pdx-no" type="text" value="${escHtml(st.numberPattern)}" style="width:100%" title="{project} = the project number, {nn} = the sheet number (01, 02 …), {sheet} = the sheet's name"></label>
          </div>
          <details${(st.revisions || []).length ? ' open' : ''}><summary>Revisions (${(st.revisions || []).length})</summary>
            <div id="pdx-revs" style="display:flex;flex-direction:column;gap:4px;margin-top:6px"></div>
            <button type="button" class="btn-small" data-rev-add style="margin-top:6px">+ Add revision</button></details>
          <label>Drawing notes (one per line, on every sheet's legend)<textarea id="pdx-notes" rows="3" style="width:100%">${escHtml(st.notes || '')}</textarea></label>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pdx-len"${st.lengths ? ' checked' : ''}> Cable lengths in the legend</label>
          ${bgs.length ? `<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="pdx-bg"${st.bg ? ' checked' : ''}> <span>Include the background drawing${bgs.length === 1 ? '' : 's'} (${bgs.length}): what the plan shows, on BG- layers.${orig < bgs.length ? ` ${bgs.length - orig === bgs.length ? (bgs.length === 1 ? 'It was' : 'They were') : (bgs.length - orig) + ' of them were'} imported before the original was kept, so ${bgs.length - orig === 1 ? 'it is' : 'they are'} rebuilt from the plan's copy (no linetypes or hatch fills); import again to get the original exactly.` : ''}</span></label>` : ''}
          <div class="ui-dialog-actions"><button type="button" class="btn-small" data-x="cancel">Cancel</button><button type="button" class="btn-primary" data-x="ok">Export</button></div>
        </div></div>`;
      document.body.appendChild(ov);
      const revs = (st.revisions || []).map(r => Object.assign({}, r));
      const drawRevs = () => {
        ov.querySelector('#pdx-revs').innerHTML = revs.map((r, i) => `<div style="display:grid;grid-template-columns:44px 1fr 96px 56px 24px;gap:4px">
          <input aria-label="Revision" data-rev="${i}" data-k="rev" value="${escHtml(r.rev || '')}" placeholder="A">
          <input aria-label="Description" data-rev="${i}" data-k="desc" value="${escHtml(r.desc || '')}" placeholder="Description">
          <input aria-label="Date" data-rev="${i}" data-k="date" type="date" value="${escHtml(r.date || '')}">
          <input aria-label="By" data-rev="${i}" data-k="by" value="${escHtml(r.by || '')}" placeholder="By">
          <button type="button" class="btn-small" data-rev-del="${i}" aria-label="Remove revision">×</button></div>`).join('');
      };
      drawRevs();
      const showTpl = () => {
        const t = this._tpl || tpl, admin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
        ov.querySelector('#pdx-tpl').textContent = t.available ? `Title block: the ${t.name || 'company'} template, filled in from Project settings.` : 'No title-block template on this server, so the sheets get a plain frame.' + (admin ? '' : ' An admin can upload one here.');
        const ad = ov.querySelector('#pdx-tpl-admin'); ad.style.display = admin ? 'flex' : 'none';
        ad.querySelector('[data-tpl="up"]').textContent = t.available ? 'Replace template…' : 'Upload title-block template…';
        ad.querySelector('[data-tpl="del"]').style.display = t.available ? '' : 'none';
      };
      showTpl();
      const tplCall = async (method, file) => {
        const fd = file ? new FormData() : null; if (fd) fd.append('file', file);
        try {
          const r = await fetch(`${API_BASE}/plan/dxf-template`, { method, body: fd, headers: API.authHeaders() });
          if (!r.ok) { let d = `HTTP ${r.status}`; try { const j = await r.json(); if (j.detail) d = j.detail; } catch (_) {} throw new Error(d); }
          this._tpl = await r.json(); showTpl();
          if (typeof UI !== 'undefined' && UI.toast) UI.toast(method === 'DELETE' ? 'Title-block template removed.' : 'Title-block template saved. Reopen Export DXF to see its paper sizes.', 'info', 3500);
        } catch (e) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Template: ' + e.message, 'error', 5000); }
      };
      ov.querySelector('#pdx-tpl-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) tplCall('POST', f); });
      ov.addEventListener('input', e => { const i = e.target.dataset.rev; if (i != null) revs[+i][e.target.dataset.k] = e.target.value; });
      const hint = () => {
        const sc = +ov.querySelector('#pdx-scale').value, mm = +ov.querySelector('#pdx-h').value, paper = ov.querySelector('#pdx-paper').value;
        ov.querySelector('#pdx-hint').textContent = `Text is ${(mm * sc / 1000).toFixed(2)} m high in the drawing (${mm} mm when plotted at 1 : ${sc}); dashed cables plot with 5 mm dashes.`;
        const f = this._fit(ext, paper, sc), box = ov.querySelector('#pdx-fit');
        const size = ext ? `The plan is ${f.w.toFixed(0)} × ${f.h.toFixed(0)} m. ` : '';
        if (f.ok) { box.style.color = 'var(--text-muted)'; box.textContent = `${size}It fits ${paper} at 1 : ${sc}.`; }
        else {
          box.style.color = 'var(--warning, #b45309)';
          box.innerHTML = `${escHtml(size)}It does not fit ${paper} at 1 : ${sc}; the sheets show its middle.`
            + (f.need ? ` <button type="button" class="btn-small" data-fit="${f.need}">Use 1 : ${f.need}</button>` : ' Pick a larger paper size.');
        }
      };
      ov.addEventListener('change', hint); hint();
      const done = ok => { const r = ok ? { scale: +ov.querySelector('#pdx-scale').value, paperMm: +ov.querySelector('#pdx-h').value, paper: ov.querySelector('#pdx-paper').value, bg: !!(ov.querySelector('#pdx-bg') && ov.querySelector('#pdx-bg').checked),
          labels: ov.querySelector('#pdx-lab').value, status: ov.querySelector('#pdx-status').value, numberPattern: ov.querySelector('#pdx-no').value,
          revisions: revs.filter(x => x.rev || x.desc), notes: ov.querySelector('#pdx-notes').value, lengths: ov.querySelector('#pdx-len').checked } : null;
        document.removeEventListener('keydown', key, true); ov.remove(); if (r) { Object.assign(st, r); PlanMarkup.markDirty(); } resolve(r); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') { e.preventDefault(); done(true); } };
      document.addEventListener('keydown', key, true);
      ov.addEventListener('click', e => {
        const tb = e.target.closest('[data-tpl]'); if (tb) { if (tb.dataset.tpl === 'up') ov.querySelector('#pdx-tpl-file').click(); else tplCall('DELETE'); return; }
        const fb = e.target.closest('[data-fit]'); if (fb) { ov.querySelector('#pdx-scale').value = fb.dataset.fit; hint(); return; }
        if (e.target.closest('[data-rev-add]')) { revs.push({ rev: '', desc: '', date: new Date().toISOString().slice(0, 10), by: '' }); drawRevs(); return; }
        const rd = e.target.closest('[data-rev-del]'); if (rd) { revs.splice(+rd.dataset.revDel, 1); drawRevs(); return; }
        const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x === 'ok'); else if (e.target === ov) done(false); });
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

  // A run drawn as many routes end to end (a street-light circuit, pole to pole) is labelled once: routes of one type and cable that meet only each other at a point form a chain; its longest route carries the
  // label, with the chain's total length.
  _chainLabels(routes) {
    const key = r => r.type + '|' + (r.cable || ''), pk = p => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
    const at = new Map();
    routes.forEach((r, i) => { if (!r.labelLines || !this.CHAIN.includes(r.type)) return;
      for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) { const k = key(r) + '@' + pk(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
    const up = routes.map((_, i) => i), find = i => (up[i] === i ? i : (up[i] = find(up[i])));
    for (const ids of at.values()) if (ids.length === 2) up[find(ids[0])] = find(ids[1]);
    const groups = new Map();
    routes.forEach((r, i) => { if (!r.labelLines) return; const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const total = ids.reduce((t, i) => t + (routes[i]._lenM || 0), 0);
      const best = ids.reduce((b, i) => ((routes[i]._lenM || 0) > (routes[b]._lenM || 0) ? i : b), ids[0]);
      for (const i of ids) if (i !== best) routes[i].labelLines = null;
      routes[best].labelLines = [routes[best].labelLines[0], `${total.toFixed(1)} m`];
    }
    for (const r of routes) delete r._lenM;
  },

  // The legend of every sheet (the server keeps, per sheet, the rows whose layer it shows): the symbols placed, each route
  // type with its cables by size and total length, the trench types and duct sizes, the "… U.N.O." notes, the drawing notes.
  _legend(pm, { elements, legRoutes, trenches, crossings, typical, FX, opt }) {
    const entries = [], seen = new Set();
    for (const e of elements) {
      if (seen.has(e.type)) continue; seen.add(e.type);
      const def = PLAN_DEFS.element(e.type) || {};
      entries.push({ group: 'equipment', kind: 'symbol', block: e.block, layer: e.layer, label: def.name || e.type, color: e.color });
    }
    for (const g of legRoutes.values()) {
      const items = Object.entries(g.len).filter(([k]) => k || Object.keys(g.len).length > 1)
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([k, m]) => ({ text: k || 'Cable not set', lenM: m }));
      entries.push({ group: 'cables', kind: 'line', layer: g.layer, label: g.label, color: g.color, lw: g.lw, linetype: g.linetype,
        items: g.noTakeoff ? [] : items });
    }
    const exc = new Map();
    for (const t of trenches) if (!exc.has(t.excType)) exc.set(t.excType, t);
    for (const [k, t] of exc) entries.push({ group: 'ducts', kind: 'band', layer: FX.trench, label: (PLAN_DEFS.trenchTypes[k] || {}).name || 'Trench', color: t.color, alpha: t.alpha });
    const sizes = new Map();
    for (const c of crossings) if (!sizes.has(c.size)) sizes.set(c.size, c);
    for (const [k, c] of sizes) entries.push({ group: 'ducts', kind: 'crossing', layer: FX.crossing, label: `Road crossing, ${k ? k + ' mm ' : ''}duct`, color: c.color, lw: c.lw });
    const notes = [];
    for (const [t, cable] of Object.entries(typical)) {
      const rdef = PLAN_DEFS.route(t) || {};
      notes.push({ layer: PLAN_DXF_LAYERS.of('route', t, rdef)[0], text: `${this.TYPICAL[t]}: ${cable} unless noted otherwise.` });
    }
    for (const line of String(opt.notes || '').split('\n')) if (line.trim()) notes.push({ text: line.trim() });
    return { entries, notes, lengths: opt.lengths !== false };
  },

  // The title block's attributes by tag (the template's tags; one it lacks is ignored, one not sent keeps its default).
  _titleBlock(sheets, opt, af) {
    const d = AppState.projectDetails || {}, up = s => String(s || '').toUpperCase();
    const name = up(AppState.projectName);           // the server wraps it over PROJECT_NAME / PROJECT_NAME2 to fit the box
    const revs = (opt.revisions || []).slice(-8);
    const cur = revs.length ? revs[revs.length - 1].rev : (d.revisionNumber || '');
    const common = {
      PROJECT_NO: d.projectNumber || '', PROJECT_NAME: name, PROJECT_NAME2: '', CLIENT: up(d.client),
      SCALE: `1:${opt.scale}`, STATUS: opt.status || '', CURRENT_REV: cur || '',
      DRAWN_DATE: d.date || new Date().toISOString().slice(0, 10), DRAWN: d.engineerName || '', DESIGNED: d.engineerName || '', CHECKED: d.checkedBy || '',
      PANEL_TITLE: 'LEGEND / SLEUTEL',
    };
    revs.forEach((r, i) => Object.assign(common, { [`REV${i + 1}_NO`]: r.rev || '', [`REV${i + 1}_DESC`]: up(r.desc), [`REV${i + 1}_DATE`]: r.date || '', [`REV${i + 1}_BY`]: r.by || '' }));
    const per = {}, N = sheets.length;
    sheets.forEach((sh, i) => {
      const nn = String(i + 1).padStart(2, '0');
      per[sh.id] = {
        DRAWING_TITLE1: this.SHEET_TITLES[sh.id] || up(sh.name), DRAWING_TITLE2: af && af.name ? up(af.name) : '',
        DRAWING_NO: String(opt.numberPattern || '{project}-EL-{nn}').replace(/\{project\}/g, d.projectNumber || 'XXXX').replace(/\{nn\}/g, nn).replace(/\{sheet\}/g, up(sh.name)),
        SHEET: `${i + 1} of ${N}`,
      };
    });
    return { common, sheets: per };
  },

  async export() {
    const pm = AppState.planMarkup;
    const factor = this._factor();
    if (!factor) { UI.alert('Plan is not calibrated — use the Calibrate tool before exporting DXF.'); return; }
    const opt = await this._options(); if (!opt) return;
    const H = opt.paperMm * opt.scale / 1000;                    // text height in the drawing, m
    const elById = {}; for (const e of pm.elements) elById[e.id] = e;
    const boardName = (id) => { const b = elById[id]; return b ? (b.name || '') : ''; };
    // layers: the plan's colour of the first thing on each (true colour); a layer of dashed cables gets the DASHED linetype;
    // a layer's sheets = the union of its items' (PLAN_DXF_LAYERS), 'all' when any of them shows on every sheet
    const layers = {}, ltypes = {}, layerSheets = {};
    const layer = (row, color, lt) => {
      const [name, sh] = row;
      if (name && !layers[name]) { layers[name] = this._hex(color) || '#333333'; if (lt) ltypes[name] = lt; }
      const cur = layerSheets[name];
      if (sh === 'all' || cur === 'all') layerSheets[name] = 'all';
      else layerSheets[name] = Array.from(new Set([...(cur || []), ...sh]));
      return name;
    };
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
      const lname = layer(PLAN_DXF_LAYERS.of('element', el.type, def), ecol || def.color);
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

    // Routes (curved flag preserved) + cable/length label, line weight as the plan draws them.
    const drawn = pm.routes.filter(r => r.points && r.points.length >= 2);
    const typical = {};          // route type → its most common cable (those get no label of their own)
    for (const t of Object.keys(this.TYPICAL)) {
      const n = {};
      for (const r of drawn) if (r.type === t && r.cableType) n[r.cableType] = (n[r.cableType] || 0) + 1;
      const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
      if (best) typical[t] = best[0];
    }
    const routes = [], legRoutes = new Map();
    for (const r of drawn) {
      const rdef = PLAN_DEFS.route(r.type) || {};
      const rcol = this._hex(PLAN_DEFS.routeColor(r.type, styles)) || '#3b82f6', lt = rdef.lineStyle === 'dashed' ? 'DASHED' : null;
      const lname = layer(PLAN_DXF_LAYERS.of('route', r.type, rdef), rcol, lt);
      const lenM = this._routeLenM(r, factor), lw = this.lineweight(rdef.width || 2);
      const quiet = rdef.noTakeoff || (r.type in this.TYPICAL && (!r.cableType || r.cableType === typical[r.type]));
      // type/cable/end names travel as XDATA so a re-import rebuilds the
      // route exactly (the layer alone can't carry a mixed-case type key).
      routes.push({
        layer: lname, labelLayer: lname + '_LABELS', type: r.type, curved: !!r.curved, cable: r.cableType || '',
        fromName: r.fromId ? boardName(r.fromId) : '', toName: r.toId ? boardName(r.toId) : '',
        label: `${r.cableType ? r.cableType + ' ' : ''}${lenM.toFixed(2)} m`,
        labelLines: quiet ? null : [r.cableType || rdef.name || r.type, `${lenM.toFixed(1)} m`],
        pts: r.points.map(p => [p.x, p.y]), color: rcol, linetype: lt || 'CONTINUOUS', lw,
      });
      routes[routes.length - 1]._lenM = lenM;
      // the legend: one row per route type, its cables by size with their total length
      let g = legRoutes.get(r.type);
      if (!g) legRoutes.set(r.type, g = { group: 'cables', kind: 'line', layer: lname, label: rdef.name || r.type, color: rcol, lw, linetype: lt, len: {}, noTakeoff: !!rdef.noTakeoff });
      const k = r.cableType || '';
      g.len[k] = (g.len[k] || 0) + lenM;
    }

    this._chainLabels(routes);
    const trenches = (pm.trenches || []).filter(t => t.points && t.points.length >= 2)
      .map(t => {
        const def = PLAN_DEFS.trenchTypes[t.excType] || {};
        const widthM = typeof RoadSections !== 'undefined' && RoadSections.trenchSize ? RoadSections.trenchSize(t).w : (t.widthOverride || def.width || 0.5);
        return { pts: t.points.map(p => [p.x, p.y]), excType: t.excType || '', name: t.name || '', color: this._hex(def.color) || '#787878',
          alpha: this._alpha(def.color), widthM };   // drawn at its real width, see-through like the plan
      });
    const roomStroke = this._hex(PLAN_DEFS.room.stroke) || '#0ea5e9';
    const rooms = (pm.rooms || []).filter(rm => rm.points && rm.points.length >= 3)
      .map(rm => ({ label: rm.name || '', pts: rm.points.map(p => [p.x, p.y]), color: this._hex(rm.color) || roomStroke, lw: this.lineweight(1.2) }));
    const dimCol = this._hex(PLAN_DEFS.annotations && PLAN_DEFS.annotations.measurement && PLAN_DEFS.annotations.measurement.color) || '#0f766e';
    const measurements = (pm.measurements || []).filter(m => m.points && m.points.length >= 2)
      .map(m => ({ pts: m.points.map(p => [p.x, p.y]), color: dimCol }));
    const xst = (PLAN_DEFS.crossings && PLAN_DEFS.crossings.style) || {};
    const crossings = (pm.crossings || []).filter(c => c.p1 && c.p2)
      .map(c => ({ p1: [c.p1.x, c.p1.y], p2: [c.p2.x, c.p2.y], size: c.size || '', name: c.name || '', color: this._hex((xst[c.size] || {}).color || (PLAN_DEFS.crossings && PLAN_DEFS.crossings.color)),
        lw: this.lineweight((xst[c.size] || {}).width || 2.5) }));
    // a plan text is its size relative to the normal 14 (so a 28 is twice the drawing's text height), in its own colour
    const texts = (pm.texts || []).map(t => ({ x: t.x, y: t.y, h: t.fontSize || 14, rel: (t.fontSize || 14) / 14, text: t.text || '', color: this._hex(t.color) || '#111827' }));
    const backgrounds = opt.bg && typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.list().filter(d => !d.hidden && PlanDxfImport.dataOf(d)).map(d => this._background(d, factor)) : [];

    // the layers of the rest of the plan, on their sheets
    const FX = {};
    for (const k of Object.keys(PLAN_DXF_LAYERS.fixed)) { const row = PLAN_DXF_LAYERS.of('fixed', k); FX[k] = row[0]; layerSheets[row[0]] = row[1]; }
    const af = (typeof AppState.planActiveFloor === 'function') && AppState.planActiveFloor();
    const sheets = this._sheets(pm);
    const legend = this._legend(pm, { elements, legRoutes, trenches, crossings, typical, FX, opt });
    const titleBlock = this._titleBlock(sheets, opt, af);
    const payload = {
      factor, floorName: (af && af.name) || '', domain: pm.settings.domain || '',
      fileName: ((AppState.projectName || 'plan').replace(/[^\w-]+/g, '_')) + (af && af.name ? '_' + af.name.replace(/[^\w-]+/g, '_') : ''),
      layers: Object.entries(layers).map(([name, color]) => ({ name, color, linetype: ltypes[name] || null })),
      extraLayers: { [FX.trench]: '#787878', [FX.crossing]: this._hex((PLAN_DEFS.crossings || {}).color) || '#f97316', [FX.room]: roomStroke, [FX.text]: '#111827', [FX.measurement]: dimCol },
      fixedLayers: FX, layerSheets, sheets, legend, titleBlock, labels: { style: opt.labels || 'circle' },
      layout: { paper: opt.paper || 'A1', margin: this.MARGIN_MM, scale: opt.scale, extents: this._extents(pm, factor) },
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
      UI.toast(`DXF exported at 1 : ${opt.scale}, text ${opt.paperMm} mm, ${payload.sheets.length} layout sheet${payload.sheets.length === 1 ? '' : 's'} on ${payload.layout.paper}.${notes ? ' Background: ' + notes.split(' | ').join('; ') + '.' : ''}`, notes && /left out|rebuilt/.test(notes) ? 'warn' : 'success', 7000);
    } catch (e) {
      UI.alert('DXF export failed: ' + (e && e.message ? e.message : e));
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
      if (btn) btn.disabled = false;
    }
  },
};
