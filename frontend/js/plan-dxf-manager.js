/* ProtectionPro — DXF manager (Site plan + Floor plans).
 *
 * One dialog per imported DXF (◫ in Background Plans):
 *   • Drawing — name, units, colours, opacity, move/align, what was read.
 *   • Layers  — per source layer: show/hide, colour override, and "convert
 *               to" a plan route type / trench / rooms / erf boundaries.
 *   • Blocks  — every block used in the drawing with its count, a preview
 *               and its attribute tags; map a block to a plan device type and
 *               each attribute tag to a device field (name, circuit, board,
 *               load, …).
 * Convert turns every mapped block reference into an editable plan device —
 * at its insertion point and rotation, with the mapped attribute values —
 * and every entity on a mapped layer into routes / trenches / rooms / erven.
 * Converted DXF items are hidden from the drawing so nothing shows twice, and
 * the whole conversion is one undo step. Mappings are remembered in the
 * project (settings.dxfBlockMap / dxfLayerMap), so the next issue of the same
 * drawing converts in one click.
 */

const PlanDxfManager = {
  _id: null,
  _tab: 'blocks',
  _filter: '',
  _ov: null,

  // ─── Suggestions ───
  // Block name → [type, fixed props] by domain. Order matters (first match).
  _BLOCK_RULES: {
    building: [
      [/EXIT/, 'bd_light', { kind: 'exit' }],
      [/EMERG|\bEM\b|_EM\b/, 'bd_light', { kind: 'emergency' }],
      [/\bDB\b|^DB|DIST.*B(OA)?RD|PANEL ?BOARD|\bDIST\b/, 'bd_db'],
      [/DOWN ?LIGHT|DWNLT|DNLT|\bDL\b|^DL/, 'bd_light', { kind: 'downlight' }],
      [/FLOOD/, 'bd_light', { kind: 'floodlight' }],
      [/HIGH ?BAY|\bHB\b/, 'bd_light', { kind: 'highbay' }],
      [/BATTEN|LINEAR|FLUOR|\bT5\b|\bT8\b|STRIP/, 'bd_light', { kind: 'batten' }],
      [/BULKHEAD|WALL ?LIGHT|WALL ?LT/, 'bd_light', { kind: 'wall' }],
      [/LIGHT|LUM|LAMP|LTG|FITTING|\bLED\b|PANEL|CEIL/, 'bd_light', { kind: 'ceiling' }],
      [/USB/, 'bd_socket', { outlets: 'double_usb' }],
      [/(DOUBLE|DSSO|TWIN|2G|2 ?GANG).*(SOCK|SSO|S\/?O|PLUG|OUTLET)|(SOCK|SSO|PLUG|OUTLET).*(DOUBLE|TWIN|2G)|DSSO/, 'bd_socket', { outlets: 'double' }],
      [/SOCKET|\bSSO\b|PLUG|\bGPO\b|OUTLET|\bS\/?O\b/, 'bd_socket', { outlets: 'single' }],
      [/ISOL/, 'bd_isolator'],
      [/FCU|FUSED|SPUR/, 'bd_fcu'],
      [/SWITCH|\bSW\b|^SW/, 'bd_switch'],
      [/SMOKE|\bSD\b/, 'bd_smoke'],
      [/HEAT/, 'bd_heat'],
      [/CALL ?POINT|\bMCP\b|\bBGU\b/, 'bd_call'],
      [/CCTV|CAMERA|\bCAM\b/, 'bd_cctv'],
      [/WIFI|\bWAP\b|ACCESS ?POINT/, 'bd_wap'],
      [/DATA|RJ45|NETWORK|CAT ?6|CAT ?5/, 'bd_datapoint'],
      [/PIR|OCCUP|SENSOR|MOTION/, 'bd_sensor'],
      [/DALI/, 'bd_dali'],
      [/RISER/, 'bd_riser'],
      [/JUNCTION|\bJB\b/, 'bd_jb'],
      [/GENERATOR|\bGEN\b/, 'bd_generator'],
      [/TRANSF|\bTX\b|XFMR/, 'bd_transformer'],
    ],
    retic: [
      [/MINI ?SUB|\bMSS\b|\bMS\b|TRANSF|\bTX\b|XFMR/, 'minisub'],
      [/KIOSK|\bMK\b|\bLVK\b|\bMV?K\b/, 'kiosk'],
      [/\bRMU\b|RING ?MAIN/, 'rmu'],
      [/POLE|STREET ?LIGHT|\bSL\b|LUMINAIRE|LIGHT|LAMP/, 'pole'],
      [/MAN ?HOLE|\bMH\b|HAND ?HOLE|\bPIT\b|CHAMBER/, 'manhole'],
      [/ERF|STAND|PLOT|\bSTN\b|CONNECTION|METER/, 'erf'],
    ],
  },
  // Attribute tag → field key. `_dboard` is the board name (relinked to the
  // board's id), `load_va` the device load override.
  _TAG_RULES: [
    [/^(NAME|TAG|REF|ID|NO|NUM|NUMBER|LABEL|DESIG|DESIGNATION|DEVICE_?ID|ERF|ERF_?NO|ERF_?NUM(BER)?|STAND|STAND_?NO|PLOT|PLOT_?NO|POLE_?NO|KIOSK|KIOSK_?NO)$/, 'name'],
    [/^(CCT|CIRCUIT|CIRC|CCT_?NO|CIRCUIT_?NO|CIRCUIT_?NUM(BER)?|WAY|WAY_?NO)$/, 'circuitNo'],
    [/^(DB|DBOARD|D_?BOARD|BOARD|PANEL|FED_?FROM|SOURCE|SUPPLY)$/, '_dboard'],
    [/^(W|WATT|WATTS|WATTAGE|POWER|LAMP_?W)$/, 'watts'],
    [/^(VA|LOAD|LOAD_?VA|KVA)$/, 'load_va'],
    [/^(LM|LUMEN|LUMENS|FLUX)$/, 'lumens'],
    [/^(CABLE|CABLE_?TYPE|CABLE_?SIZE)$/, 'cableType'],
  ],

  _domain() { return AppState.planMarkup.settings.domain === 'building' ? 'building' : 'retic'; },

  _blockMap() { const s = AppState.planMarkup.settings; if (!s.dxfBlockMap) s.dxfBlockMap = {}; return s.dxfBlockMap; },
  _layerMap() { const s = AppState.planMarkup.settings; if (!s.dxfLayerMap) s.dxfLayerMap = {}; return s.dxfLayerMap; },

  suggestBlock(name, domain) {
    const n = String(name || '').toUpperCase().replace(/[_\-.]+/g, ' ');
    for (const [re, type, props] of (this._BLOCK_RULES[domain] || [])) {
      if (re.test(n) && PLAN_DEFS.element(type)) return { type, props: { ...(props || {}) } };
    }
    return null;
  },
  suggestTag(tag, type) {
    const t = String(tag || '').toUpperCase().trim();
    for (const [re, key] of this._TAG_RULES) {
      if (!re.test(t)) continue;
      if (this._fieldTargets(type).some(f => f.key === key)) return key;
      if (key === 'watts' && this._fieldTargets(type).some(f => f.key === 'load_va')) return 'load_va';
    }
    return '';
  },

  // Fields an attribute can fill for a device type.
  _fieldTargets(type) {
    const def = PLAN_DEFS.element(type);
    if (!def) return [];
    const out = [{ key: 'name', label: (def.fields || []).find(f => f.key === 'name') ? (def.fields.find(f => f.key === 'name').label) : 'Name', kind: 'text' }];
    for (const f of (def.fields || [])) {
      if (f.key === 'name' || f.key === 'rotation') continue;
      if (f.type === 'text' || f.type === 'number' || f.type === 'select' || f.type === 'checkbox') out.push({ key: f.key, label: f.label, kind: f.type, options: f.options });
    }
    const circuit = typeof PlanCircuits !== 'undefined' && PlanCircuits.isCircuitDevice && PlanCircuits.isCircuitDevice(type);
    if (circuit) {
      out.push({ key: 'circuitNo', label: 'Circuit no.', kind: 'text' });
      out.push({ key: '_dboard', label: 'Board (by name)', kind: 'text' });
      out.push({ key: 'load_va', label: 'Load (VA)', kind: 'number' });
      out.push({ key: 'cableType', label: 'Cable', kind: 'text' });
    }
    return out;
  },
  // Select fields shown as a fixed per-block "variant" (light type, outlets…).
  _variantFields(type) {
    const def = PLAN_DEFS.element(type);
    return ((def && def.fields) || []).filter(f => f.type === 'select' && f.options && f.options.length);
  },

  // Effective mapping for a block name (saved, else suggested).
  mappingFor(name, blk, domain) {
    const saved = this._blockMap()[name];
    if (saved && saved.domain === domain) return { ...saved, saved: true };
    const sug = this.suggestBlock(name, domain);
    if (!sug) return { type: '', attrs: {}, props: {}, saved: false };
    const attrs = {};
    for (const tag of this._tagsOf(blk)) { const k = this.suggestTag(tag, sug.type); if (k) attrs[tag] = k; }
    return { type: sug.type, attrs, props: sug.props, saved: false, suggested: true };
  },
  _tagsOf(blk) { return (blk && blk.tags) || []; },

  // ─── Data views ───
  // Block references grouped by effective block name (a dynamic block's
  // anonymous *U copies all group under the name the user knows).
  _blockGroups(desc, data) {
    const conv = new Set(desc.converted || []);
    const groups = new Map();
    for (const ins of data.inserts) {
      const blk = data.blocks[ins.b];
      if (!blk) continue;
      const name = blk.n || ins.b;
      let g = groups.get(name);
      if (!g) { g = { name, blockNames: new Set(), total: 0, open: 0, tags: new Set(), sample: blk, values: new Map() }; groups.set(name, g); }
      g.blockNames.add(ins.b); g.total++;
      if (!conv.has(ins.h)) g.open++;
      for (const t of (blk.tags || [])) g.tags.add(t);
      for (const [t, v] of Object.entries(ins.a || {})) {
        g.tags.add(t);
        if (!g.values.has(t)) g.values.set(t, []);
        const arr = g.values.get(t);
        if (arr.length < 3 && v !== '' && !arr.includes(v)) arr.push(v);
      }
    }
    return [...groups.values()].map(g => ({ ...g, tags: [...g.tags] })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  },

  _layerRows(desc, data) {
    const conv = new Set([...(desc.converted || []), ...(desc.used || [])]);
    const counts = new Map();
    for (const r of data.entities) {
      const c = counts.get(r.l) || { n: 0, curves: 0, closed: 0, text: 0 };
      if (!(r.h && conv.has(r.h))) {
        c.n++;
        if (r.t === 'l' || r.t === 'a' || (r.t === 'p' && r.g !== 'HATCH')) c.curves++;
        if (r.t === 'p' && r.c && r.g !== 'HATCH') c.closed++;
        if (r.t === 'x') c.text++;
      }
      counts.set(r.l, c);
    }
    for (const ins of data.inserts) {
      const c = counts.get(ins.l) || { n: 0, curves: 0, closed: 0, text: 0 };
      if (!conv.has(ins.h)) c.n++;
      c.blocks = (c.blocks || 0) + 1;
      counts.set(ins.l, c);
    }
    return data.layers.map(ly => ({ ...ly, ...(counts.get(ly.name) || { n: 0, curves: 0, closed: 0, text: 0 }) }))
      .sort((a, b) => (b.n > 0) - (a.n > 0) || a.name.localeCompare(b.name));
  },

  _layerTargets(domain) {
    const out = [['', '—']];
    for (const [k, d] of Object.entries(PLAN_DEFS.routes)) if (d.domain === domain) out.push(['route:' + k, 'Route: ' + d.name]);
    if (domain === 'retic') {
      for (const [k, d] of Object.entries(PLAN_DEFS.trenchTypes || {})) out.push(['trench:' + k, 'Trench: ' + d.name]);
      out.push(['erf', 'Erf boundaries → Erven (numbered from text inside)']);
    }
    out.push(['room', domain === 'retic' ? 'Areas (rooms)' : 'Rooms (named from text inside)']);
    return out;
  },

  // ─── Block preview (small SVG from the block's own geometry) ───
  _preview(data, name) {
    const blk = data.blocks[name];
    if (!blk || !blk.bb) return '<span class="dxfm-nopreview">—</span>';
    const [x0, y0, x1, y1] = blk.bb;
    const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
    let n = 0;
    const f = (v) => +v.toFixed(4);
    const paths = (b, depth) => {
      let d = '';
      for (const r of b.e) {
        if (++n > 600) break;
        const p = r.p;
        if (r.t === 'l') d += `M${f(p[0])} ${f(p[1])}L${f(p[2])} ${f(p[3])}`;
        else if (r.t === 'p') { d += `M${f(p[0])} ${f(p[1])}`; for (let i = 2; i < p.length; i += 2) d += `L${f(p[i])} ${f(p[i + 1])}`; if (r.c) d += 'Z'; }
        else if (r.t === 'c') d += `M${f(p[0] - p[2])} ${f(p[1])}a${f(p[2])} ${f(p[2])} 0 1 0 ${f(2 * p[2])} 0a${f(p[2])} ${f(p[2])} 0 1 0 ${f(-2 * p[2])} 0`;
        else if (r.t === 'a') {
          const a0 = p[3] * Math.PI / 180, a1 = p[4] * Math.PI / 180;
          let sweep = a1 - a0; while (sweep <= 0) sweep += Math.PI * 2;
          d += `M${f(p[0] + p[2] * Math.cos(a0))} ${f(p[1] + p[2] * Math.sin(a0))}A${f(p[2])} ${f(p[2])} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(p[0] + p[2] * Math.cos(a1))} ${f(p[1] + p[2] * Math.sin(a1))}`;
        }
      }
      return d;
    };
    let body = `<path d="${paths(blk, 0)}"/>`;
    for (const r of blk.e) {
      if (r.t !== 'i' || n > 600) continue;
      const nb = data.blocks[r.b]; if (!nb) continue;
      body += `<g transform="translate(${f(r.p[0])} ${f(r.p[1])}) rotate(${f(r.r || 0)}) scale(${f(r.sx || 1)} ${f(r.sy || 1)}) translate(${f(-nb.bp[0])} ${f(-nb.bp[1])})"><path d="${paths(nb, 1)}"/></g>`;
    }
    const pad = Math.max(w, h) * 0.08;
    return `<svg class="dxfm-preview" viewBox="${f(x0 - pad)} ${f(-y1 - pad)} ${f(w + 2 * pad)} ${f(h + 2 * pad)}" preserveAspectRatio="xMidYMid meet">
      <g transform="scale(1,-1)" fill="none" stroke="currentColor">${body}</g></svg>`;
  },

  // ─── Dialog ───
  open(id, tab) {
    const desc = PlanDxfImport.byId(id);
    const data = desc && PlanDxfImport.dataOf(desc);
    if (!data) { UI.toast('That DXF is still loading.', 'info'); return; }
    this._id = id;
    this._tab = tab || (data.inserts.length ? 'blocks' : 'layers');
    this._filter = '';
    this._edits = new Map();   // block name → pending mapping edits (not yet saved)
    this._layerEdits = new Map();
    if (this._ov) this.close();
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal dxfm-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'DXF drawing');
    this._ov = ov;
    this._onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
    document.addEventListener('keydown', this._onKey, true);
    ov.addEventListener('click', (e) => this._onClick(e));
    ov.addEventListener('change', (e) => this._onChange(e));
    ov.addEventListener('input', (e) => this._onInput(e));
    document.body.appendChild(ov);
    this.render();
  },

  close() {
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    if (this._ov) this._ov.remove();
    this._ov = null;
    if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
  },

  _desc() { return PlanDxfImport.byId(this._id); },

  render() {
    const desc = this._desc(), data = desc && PlanDxfImport.dataOf(desc);
    if (!this._ov || !data) { this.close(); return; }
    const tabs = [['blocks', `Blocks (${new Set(data.inserts.map(i => (data.blocks[i.b] || {}).n || i.b)).size})`], ['layers', `Layers (${data.layers.length})`], ['drawing', 'Drawing']];
    const body = this._tab === 'blocks' ? this._renderBlocks(desc, data)
      : this._tab === 'layers' ? this._renderLayers(desc, data) : this._renderDrawing(desc, data);
    const plan = this._planCounts(desc, data);
    const scrollY = this._ov.querySelector('.dxfm-body') ? this._ov.querySelector('.dxfm-body').scrollTop : 0;
    this._ov.innerHTML = `
      <div class="modal-content dxfm-content">
        <div class="modal-header dxfm-head"><h3>📐 ${escHtml(desc.name)}</h3>
          <div class="dxfm-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === this._tab}" class="dxfm-tab${k === this._tab ? ' active' : ''}" data-role="tab" data-tab="${k}">${escHtml(l)}</button>`).join('')}</div>
        </div>
        <div class="modal-body dxfm-body">${body}</div>
        <div class="dxfm-foot">
          <span class="dxfm-summary">${plan.text}</span>
          <button class="btn-small" data-role="close">Close</button>
          <button class="btn-primary" data-role="convert"${plan.n ? '' : ' disabled'} title="Create plan items from the mapped blocks and layers (one undo step)">Convert ${plan.n || ''}</button>
        </div>
      </div>`;
    const b = this._ov.querySelector('.dxfm-body'); if (b) b.scrollTop = scrollY;
    const fi = this._ov.querySelector('[data-role="filter"]');
    if (fi && this._refocusFilter) { fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); this._refocusFilter = false; }
  },

  // What Convert would create now.
  _planCounts(desc, data) {
    const domain = this._domain();
    let blocks = 0, layers = 0;
    for (const g of this._blockGroups(desc, data)) {
      const m = this._currentBlockMapping(g, domain);
      if (m.type && PLAN_DEFS.element(m.type)) blocks += g.open;
    }
    for (const L of this._layerRows(desc, data)) {
      const tgt = this._currentLayerTarget(L.name, domain);
      if (!tgt) continue;
      layers += tgt === 'erf' || tgt === 'room' ? L.closed : L.curves;
    }
    const parts = [];
    if (blocks) parts.push(`${blocks} block reference${blocks === 1 ? '' : 's'} → devices`);
    if (layers) parts.push(`~${layers} layer item${layers === 1 ? '' : 's'} → routes / areas`);
    return { n: blocks + layers, text: parts.length ? 'Ready: ' + parts.join(', ') : 'Map blocks or layers to plan items, then Convert.' };
  },

  _currentBlockMapping(g, domain) {
    const e = this._edits.get(g.name);
    if (e) return e;
    return this.mappingFor(g.name, g.sample, domain);
  },
  _currentLayerTarget(name, domain) {
    if (this._layerEdits.has(name)) return this._layerEdits.get(name);
    const saved = this._layerMap()[name];
    return saved && saved.domain === domain ? saved.target : '';
  },

  _renderBlocks(desc, data) {
    const domain = this._domain();
    const groups = this._blockGroups(desc, data);
    if (!groups.length) return `<p class="dxfm-empty">This drawing has no block references.</p>`;
    const types = Object.entries(PLAN_DEFS.elements).filter(([, d]) => d.domain === domain && !d.adoptOnly);
    const q = this._filter.trim().toLowerCase();
    let html = `<div class="dxfm-toolbar"><input type="search" class="dxfm-filter" data-role="filter" placeholder="Filter blocks…" value="${escHtml(this._filter)}">
      <span class="dxfm-hint">Map a block to a ${domain === 'retic' ? 'site-plan' : 'floor-plan'} device; its attributes fill the device's fields.</span></div>
      <table class="dxfm-table"><thead><tr><th></th><th>Block</th><th>Refs</th><th>Plan device</th><th>Attributes → fields</th></tr></thead><tbody>`;
    for (const g of groups) {
      if (q && !g.name.toLowerCase().includes(q) && !g.tags.some(t => t.toLowerCase().includes(q))) continue;
      const m = this._currentBlockMapping(g, domain);
      const key = escHtml(g.name);
      const typeSel = `<select data-role="btype" data-block="${key}"><option value="">— keep as drawing</option>${types.map(([k, d]) => `<option value="${k}"${m.type === k ? ' selected' : ''}>${escHtml(d.name)}</option>`).join('')}</select>`;
      const variants = m.type ? this._variantFields(m.type).map(f =>
        `<label class="dxfm-variant">${escHtml(f.label)} <select data-role="bprop" data-block="${key}" data-key="${escHtml(f.key)}"><option value="">(default)</option>${f.options.map(o => `<option value="${escHtml(o.value)}"${String((m.props || {})[f.key]) === String(o.value) ? ' selected' : ''}>${escHtml(o.label)}</option>`).join('')}</select></label>`).join('') : '';
      let attrs = '';
      if (g.tags.length) {
        const tgts = m.type ? this._fieldTargets(m.type) : [];
        attrs = g.tags.map(t => {
          const vals = (g.values.get(t) || []).map(v => escHtml(v)).join(', ');
          const sel = m.type ? `<select data-role="battr" data-block="${key}" data-tag="${escHtml(t)}"><option value="">ignore</option>${tgts.map(f => `<option value="${f.key}"${(m.attrs || {})[t] === f.key ? ' selected' : ''}>${escHtml(f.label)}</option>`).join('')}</select>` : '';
          return `<div class="dxfm-attr"><code>${escHtml(t)}</code>${vals ? `<span class="dxfm-vals" title="${vals}">${vals}</span>` : ''}${sel}</div>`;
        }).join('');
      } else attrs = '<span class="dxfm-muted">no attributes</span>';
      const status = g.open < g.total ? `<div class="dxfm-muted">${g.total - g.open} converted</div>` : '';
      const tag = m.suggested && !this._edits.has(g.name) ? '<span class="dxfm-sug" title="Suggested from the block name — change it if wrong">suggested</span>' : '';
      html += `<tr class="${m.type ? 'dxfm-mapped' : ''}">
        <td class="dxfm-prev">${this._preview(data, [...g.blockNames][0])}</td>
        <td><div class="dxfm-bname">${escHtml(g.name)}</div>${g.blockNames.size > 1 ? `<div class="dxfm-muted">${g.blockNames.size} dynamic variants</div>` : ''}</td>
        <td class="dxfm-num">${g.open}${status}</td>
        <td>${typeSel}${tag}${variants}</td>
        <td>${attrs}</td></tr>`;
    }
    return html + '</tbody></table>';
  },

  _renderLayers(desc, data) {
    const domain = this._domain();
    const rows = this._layerRows(desc, data);
    const targets = this._layerTargets(domain);
    const q = this._filter.trim().toLowerCase();
    let html = `<div class="dxfm-toolbar"><input type="search" class="dxfm-filter" data-role="filter" placeholder="Filter layers…" value="${escHtml(this._filter)}">
      <button class="btn-small" data-role="layers-all">Show all</button><button class="btn-small" data-role="layers-none">Hide all</button>
      <button class="btn-small" data-role="layers-empty" title="Hide layers with nothing on them">Hide empty</button></div>
      <table class="dxfm-table"><thead><tr><th>Show</th><th>Colour</th><th>Layer</th><th>Items</th><th>Convert to</th></tr></thead><tbody>`;
    for (const L of rows) {
      if (q && !L.name.toLowerCase().includes(q)) continue;
      const st = (desc.layers || {})[L.name] || {};
      const col = st.color || (L.aci7 ? '#808080' : L.color);
      const tgt = this._currentLayerTarget(L.name, domain);
      const key = escHtml(L.name);
      const flags = [!L.on ? 'off in CAD' : '', L.frozen ? 'frozen in CAD' : ''].filter(Boolean).join(', ');
      const conv = L.curves || L.closed
        ? `<select data-role="ltarget" data-layer="${key}">${targets.map(([v, l]) => `<option value="${v}"${tgt === v ? ' selected' : ''}>${escHtml(l)}</option>`).join('')}</select>`
        : '<span class="dxfm-muted">—</span>';
      html += `<tr class="${tgt ? 'dxfm-mapped' : ''}">
        <td><input type="checkbox" data-role="lvis" data-layer="${key}"${st.hidden ? '' : ' checked'}></td>
        <td><input type="color" data-role="lcol" data-layer="${key}" value="${escHtml(col)}" title="${st.color ? 'Custom colour' : 'Colour from the DXF'}">${st.color ? `<button class="dxfm-link" data-role="lcol-reset" data-layer="${key}" title="Back to the DXF colour">↺</button>` : ''}</td>
        <td><span class="dxfm-lname">${key}</span>${flags ? `<div class="dxfm-muted">${flags}</div>` : ''}</td>
        <td class="dxfm-num">${L.n}${L.blocks ? `<div class="dxfm-muted">${L.blocks} block${L.blocks === 1 ? '' : 's'}</div>` : ''}</td>
        <td>${conv}</td></tr>`;
    }
    return html + '</tbody></table>';
  },

  _renderDrawing(desc, data) {
    const units = [['0.001', 'Millimetres'], ['0.01', 'Centimetres'], ['1', 'Metres'], ['1000', 'Kilometres'], ['0.0254', 'Inches'], ['0.3048', 'Feet']];
    const known = units.some(([v]) => Math.abs(+v - (desc.unitM || 0)) < 1e-12);
    const f = PlanEngine.factor();
    const [bx0, by0, bx1, by1] = desc.bbox || [0, 0, 0, 0];
    const size = desc.unitM ? `${((bx1 - bx0) * desc.unitM).toFixed(1)} × ${((by1 - by0) * desc.unitM).toFixed(1)} m` : '—';
    const trueScale = desc.unitM && f ? Math.abs(PlanDxfImport._pxPerUnit(desc) * f / desc.unitM - 1) < 1e-3 : false;
    const sk = data.skipped && Object.keys(data.skipped).length ? Object.entries(data.skipped).map(([k, v]) => `${k} ×${v}`).join(', ') : '';
    const nb = Object.keys(data.blocks).length;
    const xrefs = Object.values(data.blocks).filter(b => b.xref).map(b => b.name);
    return `<div class="dxfm-form">
      <label>Name <input data-role="dname" value="${escHtml(desc.name)}"></label>
      <label>Drawing unit <select data-role="dunits">${known ? '' : `<option value="${desc.unitM || ''}" selected>${desc.unitM ? desc.unitM + ' m' : 'unknown'}</option>`}${units.map(([v, l]) => `<option value="${v}"${Math.abs(+v - (desc.unitM || 0)) < 1e-12 ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Colours <select data-role="dcolor"><option value="file"${desc.colorMode !== 'mono' ? ' selected' : ''}>From the DXF (by layer / entity)</option><option value="mono"${desc.colorMode === 'mono' ? ' selected' : ''}>Grey trace-over</option></select></label>
      <label>Opacity <input type="range" min="0.1" max="1" step="0.05" data-role="dopacity" value="${typeof desc.opacity === 'number' ? desc.opacity : 1}"></label>
    </div>
    <div class="dxfm-actions">
      <button class="btn-small" data-role="move">✥ Move</button>
      <button class="btn-small" data-role="align-keep" ${desc.unitM ? '' : 'disabled'} title="2-point align: rotate + move, keep the DXF's true scale">⤢ Align (keep scale)</button>
      <button class="btn-small" data-role="align-free" title="2-point align: rotate, move and scale to fit">⤢ Align + scale</button>
      <button class="btn-small" data-role="reset-rot" title="Undo any rotation/scale from aligning">Reset rotation/scale</button>
    </div>
    <dl class="dxfm-facts">
      <dt>Size</dt><dd>${size}${desc.unitsGuessed ? ' (units chosen on import)' : ''}</dd>
      <dt>Placement</dt><dd>${trueScale ? 'True scale' : (desc.unitM ? 'Scaled to fit (not true scale)' : 'Unknown units')}${desc.rotation ? `, rotated ${(+desc.rotation).toFixed(1)}°` : ''}</dd>
      <dt>Contents</dt><dd>${data.entities.length} entities, ${data.inserts.length} block references (${nb} block definitions), ${data.layers.length} layers</dd>
      ${desc.converted && desc.converted.length ? `<dt>Converted</dt><dd>${desc.converted.length} DXF items are now plan items (hidden here) <button class="dxfm-link" data-role="unhide-converted" title="Show converted DXF items again (does not delete the plan items)">show again</button></dd>` : ''}
      ${sk ? `<dt>Not drawn</dt><dd>${escHtml(sk)}</dd>` : ''}
      ${xrefs.length ? `<dt>External refs</dt><dd>${escHtml(xrefs.join(', '))} — not included in this file; import them separately.</dd>` : ''}
      ${data.truncated ? '<dt>Note</dt><dd>The file was very large; only part of it was read.</dd>' : ''}
      ${data.legacy ? '<dt>Note</dt><dd>Imported by an older version — re-import the DXF to get its layers, blocks and attributes.</dd>' : ''}
    </dl>
    <div class="dxfm-actions"><button class="btn-small dxfm-danger" data-role="remove">Remove this DXF</button></div>`;
  },

  // ─── Events ───
  _onClick(e) {
    if (e.target === this._ov) { this.close(); return; }
    const el = e.target.closest('[data-role]'); if (!el) return;
    const role = el.dataset.role, desc = this._desc();
    if (!desc) return;
    switch (role) {
      case 'tab': this._tab = el.dataset.tab; this._filter = ''; this.render(); break;
      case 'close': this.close(); break;
      case 'convert': this.convert(); break;
      case 'layers-all': case 'layers-none': case 'layers-empty': {
        const data = PlanDxfImport.dataOf(desc);
        desc.layers = desc.layers || {};
        const rows = this._layerRows(desc, data);
        for (const L of rows) {
          const st = desc.layers[L.name] || (desc.layers[L.name] = {});
          st.hidden = role === 'layers-none' ? true : role === 'layers-all' ? false : (L.n === 0 ? true : !!st.hidden);
        }
        this._changed(desc, false); this.render(); break;
      }
      case 'lcol-reset': { const st = (desc.layers || {})[el.dataset.layer]; if (st) delete st.color; this._changed(desc, false); this.render(); break; }
      case 'move': this.close(); PlanTools.set('nudgeplan', { dxfId: desc.id }); break;
      case 'align-keep': this.close(); PlanTools.set('align', { dxfId: desc.id, keepScale: true }); break;
      case 'align-free': this.close(); PlanTools.set('align', { dxfId: desc.id, keepScale: false }); break;
      case 'reset-rot': {
        const [bx0, by0, bx1, by1] = desc.bbox;
        const c = PlanDxfImport.worldOf(desc, (bx0 + bx1) / 2, (by0 + by1) / 2);
        desc.rotation = 0; desc.scaleAdj = 1;
        const c2 = PlanDxfImport.worldOf(desc, (bx0 + bx1) / 2, (by0 + by1) / 2);
        desc.offX += c.x - c2.x; desc.offY += c.y - c2.y;
        this._changed(desc, true); this.render(); break;
      }
      case 'unhide-converted': desc.converted = []; desc.used = []; PlanDxfImport.invalidate(desc); this._changed(desc, true); this.render(); break;
      case 'remove':
        UI.confirm(`Remove "${desc.name}" from this floor? Plan items already converted from it stay.`, { danger: true, okText: 'Remove' }).then(ok => {
          if (!ok) return;
          this.close(); PlanDxfImport.remove(desc.id);
          if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
        });
        break;
      default: break;
    }
  },

  _onChange(e) {
    const el = e.target, role = el.dataset.role, desc = this._desc();
    if (!role || !desc) return;
    const domain = this._domain();
    const data = PlanDxfImport.dataOf(desc);
    const group = el.dataset.block ? this._blockGroups(desc, data).find(g => g.name === el.dataset.block) : null;
    const editOf = (g) => {
      if (!this._edits.has(g.name)) {
        const m = this.mappingFor(g.name, g.sample, domain);
        this._edits.set(g.name, { type: m.type, attrs: { ...(m.attrs || {}) }, props: { ...(m.props || {}) } });
      }
      return this._edits.get(g.name);
    };
    if (role === 'btype' && group) {
      const m = editOf(group);
      m.type = el.value;
      // Re-suggest fields for the new type; keep explicit picks that still fit.
      const fits = new Set(this._fieldTargets(m.type).map(f => f.key));
      const attrs = {};
      for (const t of group.tags) {
        const cur = m.attrs[t];
        attrs[t] = cur && fits.has(cur) ? cur : this.suggestTag(t, m.type);
        if (!attrs[t]) delete attrs[t];
      }
      m.attrs = attrs;
      const sug = this.suggestBlock(group.name, domain);
      m.props = sug && sug.type === m.type ? { ...sug.props } : {};
      this.render();
    } else if (role === 'battr' && group) {
      const m = editOf(group);
      if (el.value) m.attrs[el.dataset.tag] = el.value; else delete m.attrs[el.dataset.tag];
      this.render();
    } else if (role === 'bprop' && group) {
      const m = editOf(group);
      if (el.value) m.props[el.dataset.key] = el.value; else delete m.props[el.dataset.key];
    } else if (role === 'ltarget') {
      this._layerEdits.set(el.dataset.layer, el.value);
      this.render();
    } else if (role === 'lvis') {
      desc.layers = desc.layers || {};
      const st = desc.layers[el.dataset.layer] || (desc.layers[el.dataset.layer] = {});
      st.hidden = !el.checked;
      this._changed(desc, false);
    } else if (role === 'lcol') {
      desc.layers = desc.layers || {};
      const st = desc.layers[el.dataset.layer] || (desc.layers[el.dataset.layer] = {});
      st.color = el.value;
      this._changed(desc, false); this.render();
    } else if (role === 'dname') {
      desc.name = el.value.trim() || desc.name;
      this._changed(desc, false); this.render();
    } else if (role === 'dunits') {
      const u = parseFloat(el.value);
      if (u > 0) { PlanDxfImport.setUnits(desc, u); this._changed(desc, true); if (typeof PlanEngine !== 'undefined') PlanEngine.zoomFit(); this.render(); }
    } else if (role === 'dcolor') {
      desc.colorMode = el.value; this._changed(desc, false);
    }
  },

  _onInput(e) {
    const el = e.target, role = el.dataset.role, desc = this._desc();
    if (role === 'filter') { this._filter = el.value; this._refocusFilter = true; this.render(); }
    else if (role === 'dopacity' && desc) { desc.opacity = parseFloat(el.value); PlanEngine.requestDraw({ bg: true }); PlanMarkup.markDirty(); }
  },

  // Display-only changes (visibility, colour, name) mark dirty; geometry
  // changes (units, placement) also take an undo snapshot.
  _changed(desc, snapshot) {
    if (typeof PlanMarkup !== 'undefined') { if (snapshot) PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    PlanEngine.requestDraw({ all: true });
  },

  // ─── Conversion ───
  convert() {
    const desc = this._desc(), data = desc && PlanDxfImport.dataOf(desc);
    if (!data) return;
    const domain = this._domain();
    const pm = AppState.planMarkup;
    // Persist the mappings in use (edits + accepted suggestions).
    const bmap = this._blockMap(), lmap = this._layerMap();
    const groups = this._blockGroups(desc, data);
    for (const g of groups) {
      const m = this._currentBlockMapping(g, domain);
      if (m.type) bmap[g.name] = { domain, type: m.type, attrs: { ...(m.attrs || {}) }, props: { ...(m.props || {}) } };
      else if (this._edits.has(g.name)) delete bmap[g.name];
    }
    for (const [name, tgt] of this._layerEdits) {
      if (tgt) lmap[name] = { domain, target: tgt }; else delete lmap[name];
    }
    const res = this._convertBlocks(desc, data, domain, bmap);
    const res2 = this._convertLayers(desc, data, domain, lmap);
    const total = res.n + res2.routes + res2.trenches + res2.rooms + res2.erven;
    if (!total) { UI.toast('Nothing to convert — map a block or a layer first.', 'info'); return; }
    PlanDxfImport.invalidate(desc);
    PlanDxfImport._afterEntitiesChanged();
    PlanEngine.requestDraw({ all: true });
    this._edits.clear(); this._layerEdits.clear();
    const parts = [];
    if (res.n) parts.push(`${res.n} device${res.n === 1 ? '' : 's'}`);
    if (res2.routes) parts.push(`${res2.routes} route${res2.routes === 1 ? '' : 's'}`);
    if (res2.trenches) parts.push(`${res2.trenches} trench${res2.trenches === 1 ? '' : 'es'}`);
    if (res2.rooms) parts.push(`${res2.rooms} ${domain === 'retic' ? 'area' : 'room'}${res2.rooms === 1 ? '' : 's'}`);
    if (res2.erven) parts.push(`${res2.erven} erf${res2.erven === 1 ? '' : 'ven'}`);
    let msg = `Converted ${parts.join(', ')} from "${desc.name}". Press Ctrl+Z to undo.`;
    if (res.relinked) msg += ` ${res.relinked} device${res.relinked === 1 ? '' : 's'} linked to ${res.relinked === 1 ? 'its board' : 'their boards'}.`;
    if (res.unlinked) msg += ` ${res.unlinked} board name${res.unlinked === 1 ? '' : 's'} didn't match any board on the plan.`;
    if (domain === 'retic' && (res.n || res2.erven)) msg += ' Use → Push to Schedules to send them to Demand.';
    UI.toast(msg, 'success', 7000);
    this.render();
  },

  _coerce(field, raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (v === '') return undefined;
    if (field.kind === 'number') { const n = parseFloat(v.replace(',', '.').replace(/[^0-9.eE+\-]/g, '')); return Number.isFinite(n) ? n : undefined; }
    if (field.kind === 'checkbox') return /^(1|y|yes|true|x|wp)$/i.test(v);
    if (field.kind === 'select') {
      const o = (field.options || []).find(o => String(o.value).toLowerCase() === v.toLowerCase() || String(o.label).toLowerCase() === v.toLowerCase());
      return o ? o.value : undefined;
    }
    return v;
  },

  _convertBlocks(desc, data, domain, bmap) {
    const pm = AppState.planMarkup;
    const conv = new Set(desc.converted || []);
    const created = [];
    let n = 0, relinked = 0;
    const unlinkedNames = new Set();
    const pending = [];   // [el, boardName]
    for (const ins of data.inserts) {
      if (conv.has(ins.h)) continue;
      const blk = data.blocks[ins.b]; if (!blk) continue;
      const m = bmap[blk.n || ins.b];
      if (!m || m.domain !== domain || !PLAN_DEFS.element(m.type)) continue;
      const def = PLAN_DEFS.element(m.type);
      const w = PlanDxfImport.worldOf(desc, ins.p[0], ins.p[1]);
      const rot = def.rotatable ? +((((desc.rotation || 0) - (ins.r || 0)) % 360 + 360) % 360).toFixed(1) : 0;
      const el = { id: AppState.planGenId('pmel'), type: m.type, x: w.x, y: w.y, rotation: rot, name: '', reticId: null,
        props: { ...PLAN_DEFS.defaults(m.type), ...(m.props || {}) } };
      const targets = this._fieldTargets(m.type);
      let board = '';
      for (const [tag, key] of Object.entries(m.attrs || {})) {
        const raw = (ins.a || {})[tag];
        const f = targets.find(t => t.key === key); if (!f) continue;
        const val = this._coerce(f, raw); if (val === undefined) continue;
        if (key === 'name') el.name = String(val);
        else if (key === '_dboard') board = String(val);
        else el.props[key] = val;
      }
      if (!el.name) el.name = PlanMarkup.nextName(m.type);
      pm.elements.push(el); created.push(el); n++;
      conv.add(ins.h);
      if (board) pending.push([el, board]);
    }
    // Relink circuit devices to their board by name (boards on this floor,
    // including ones just converted).
    if (pending.length) {
      const boards = {};
      for (const e of pm.elements) if (e.type === 'bd_db' && e.name) boards[e.name.trim().toLowerCase()] = e.id;
      for (const [el, name] of pending) {
        const id = boards[name.trim().toLowerCase()];
        if (id) { el.props.circuitDbId = id; relinked++; } else unlinkedNames.add(name);
      }
    }
    desc.converted = [...conv];
    return { n, created, relinked, unlinked: unlinkedNames.size };
  },

  // Layer geometry → routes / trenches / rooms / erven. Lines on a layer are
  // chained end-to-end first (CAD cable runs are often exploded into lines).
  _convertLayers(desc, data, domain, lmap) {
    const pm = AppState.planMarkup;
    const conv = new Set(desc.converted || []);
    // Erf boundaries become point devices, but the boundary is still the
    // drawing people want to see: record those as used (not re-converted)
    // without hiding them.
    const used = new Set(desc.used || []);
    const out = { routes: 0, trenches: 0, rooms: 0, erven: 0 };
    const byLayer = new Map();
    for (const r of data.entities) {
      if (!r.h || conv.has(r.h) || used.has(r.h)) continue;
      const m = lmap[r.l];
      if (!m || m.domain !== domain || !m.target) continue;
      if (!byLayer.has(r.l)) byLayer.set(r.l, []);
      byLayer.get(r.l).push(r);
    }
    if (!byLayer.size) return out;
    const [bx0, by0, bx1, by1] = data.bbox;
    const eps = Math.max(bx1 - bx0, by1 - by0, 1e-9) * 1e-6;
    const texts = data.entities.filter(r => r.t === 'x' && !this._isHiddenLayer(desc, r.l));
    const W = (x, y) => PlanDxfImport.worldOf(desc, x, y);
    const snapR = 10 / Math.max(PlanEngine.view.zoom, 1e-6);   // ~10 screen px
    const snapEl = (pt) => {
      let best = null, bd = snapR;
      for (const e of pm.elements) { const d = Math.hypot(e.x - pt.x, e.y - pt.y); if (d <= bd) { bd = d; best = e; } }
      return best;
    };
    const textInside = (poly) => {
      const hits = texts.filter(t => this._pip(t.p[0], t.p[1], poly));
      if (!hits.length) return '';
      // Prefer a number (erf / room no.), then the largest text.
      hits.sort((a, b) => (/\d/.test(b.s) - /\d/.test(a.s)) || (b.h - a.h));
      return String(hits[0].s).replace(/\s+/g, ' ').trim();
    };

    for (const [layer, recs] of byLayer) {
      const tgt = lmap[layer].target;
      const closedOnly = tgt === 'room' || tgt === 'erf';
      const polys = [];   // {pts:[[x,y]...], closed, curved, fit, handles:[]}
      const lines = [];
      for (const r of recs) {
        if (r.t === 'l') { lines.push(r); continue; }
        if (r.t === 'p' && r.g !== 'HATCH') {
          const pts = []; for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
          const first = pts[0], last = pts[pts.length - 1];
          const closed = !!r.c || (pts.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) <= eps);
          const fit = r.g === 'SPLINE' && r.f && r.f.length >= 6 ? r.f : null;
          polys.push({ pts, closed, curved: !!fit, fit, handles: [r.h] });
        } else if (r.t === 'a') {
          const [cx, cy, rad, a0, a1] = r.p;
          let sweep = a1 - a0; while (sweep <= 0) sweep += 360;
          const n = Math.max(2, Math.ceil(sweep / 10));
          const pts = [];
          for (let i = 0; i <= n; i++) { const a = (a0 + sweep * i / n) * Math.PI / 180; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
          polys.push({ pts, closed: false, curved: false, handles: [r.h] });
        } else if (r.t === 'c' && closedOnly) {
          const [cx, cy, rad] = r.p; const pts = [];
          for (let i = 0; i < 36; i++) { const a = i * Math.PI / 18; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
          polys.push({ pts, closed: true, curved: false, handles: [r.h] });
        }
      }
      for (const ch of this._chainLines(lines, eps)) polys.push(ch);

      for (const P of polys) {
        if (closedOnly && !P.closed) continue;
        if (P.pts.length < 2) continue;
        if (tgt === 'room' || tgt === 'erf') {
          let ring = P.pts;
          const f0 = ring[0], fl = ring[ring.length - 1];
          if (Math.hypot(f0[0] - fl[0], f0[1] - fl[1]) <= eps) ring = ring.slice(0, -1);
          if (ring.length < 3) continue;
          const label = textInside(ring);
          if (tgt === 'room') {
            pm.rooms.push({ id: AppState.planGenId('pmrm'), name: label || `Room ${pm.rooms.length + 1}`, points: ring.map(([x, y]) => W(x, y)), color: null });
            out.rooms++;
          } else {
            const c = this._centroid(ring);
            const w = W(c[0], c[1]);
            pm.elements.push({ id: AppState.planGenId('pmel'), type: 'erf', x: w.x, y: w.y, rotation: 0,
              name: label || PlanMarkup.nextName('erf'), reticId: null, props: PLAN_DEFS.defaults('erf') });
            out.erven++;
          }
        } else if (tgt.startsWith('trench:')) {
          const exc = tgt.slice(7);
          pm.trenches.push({ id: AppState.planGenId('pmtr'), name: '', excType: exc, points: P.pts.map(([x, y]) => W(x, y)) });
          out.trenches++;
        } else if (tgt.startsWith('route:')) {
          const type = tgt.slice(6);
          if (!PLAN_DEFS.route(type)) continue;
          const src = P.fit ? (() => { const a = []; for (let i = 0; i < P.fit.length; i += 2) a.push([P.fit[i], P.fit[i + 1]]); return a; })() : P.pts;
          const pts = src.map(([x, y]) => W(x, y));
          if (P.closed && !P.curved) pts.push({ ...pts[0] });
          const a = snapEl(pts[0]), b = snapEl(pts[pts.length - 1]);
          if (a) { pts[0] = { x: a.x, y: a.y, snappedTo: a.id }; }
          if (b) { pts[pts.length - 1] = { x: b.x, y: b.y, snappedTo: b.id }; }
          const defaults = PLAN_DEFS.defaults(type);
          pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a ? a.id : null, toId: b ? b.id : null,
            points: pts, cableType: defaults.cableType || '', curved: !!P.curved, props: {} });
          out.routes++;
        } else continue;
        for (const h of P.handles) (tgt === 'erf' ? used : conv).add(h);
      }
    }
    desc.converted = [...conv];
    desc.used = [...used];
    return out;
  },

  _isHiddenLayer(desc, name) { return PlanDxfImport.layerHidden(desc, name); },

  // Join LINE records sharing end points into polylines (greedy, both ends).
  _chainLines(lines, eps) {
    const key = (x, y) => Math.round(x / (eps * 10)) + ',' + Math.round(y / (eps * 10));
    const ends = new Map();
    const push = (k, i) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
    lines.forEach((r, i) => { push(key(r.p[0], r.p[1]), i); push(key(r.p[2], r.p[3]), i); });
    const used = new Array(lines.length).fill(false);
    const out = [];
    const next = (pt) => {
      const a = ends.get(key(pt[0], pt[1])) || [];
      for (const i of a) if (!used[i]) return i;
      return -1;
    };
    for (let i = 0; i < lines.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const r = lines[i];
      const pts = [[r.p[0], r.p[1]], [r.p[2], r.p[3]]];
      const handles = [r.h];
      for (let dir = 0; dir < 2; dir++) {
        for (;;) {
          const tip = dir === 0 ? pts[pts.length - 1] : pts[0];
          const j = next(tip);
          if (j < 0) break;
          used[j] = true; handles.push(lines[j].h);
          const q = lines[j].p;
          const same = key(q[0], q[1]) === key(tip[0], tip[1]);
          const far = same ? [q[2], q[3]] : [q[0], q[1]];
          if (dir === 0) pts.push(far); else pts.unshift(far);
        }
      }
      const f = pts[0], l = pts[pts.length - 1];
      out.push({ pts, closed: pts.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) <= eps * 10, curved: false, handles });
    }
    return out;
  },

  _pip(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  },

  _centroid(ring) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) < 1e-12) {
      const n = ring.length; return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
    }
    return [cx / (3 * a), cy / (3 * a)];
  },
};
