/**
 * SolarBar — the Solar toolbar across the top of the Plan (Plan mode "Solar"), the Roofs list on its left and the hint strip.
 *
 * Row 1, the tools: Roofs (Select, Detect roof, Draw, Keep-out) · Panels (Place array, Aisles ▾: Row / Column / Remove) ·
 * View (2D | Split | 3D, Fit) · on the right the system totals (panels, kWp, roofs in) and Design & report (opens Solar PV Design).
 * The buttons arm the plan tools (`PlanTools.set`); the three aisle tools are one tool, `solaraisle`, with `opts.mode`
 * row | col | remove (plan-solar-array.js), and in 3D `Roof3D.setTool('aisle', mode)`. Split = the Roof editor (the plan beside a
 * live 3D view), 3D = the same with the plan hidden (`re-only3d` on #plan-main), 2D = the plan alone.
 *
 * Row 2, the selection bar: what you tune on the roofs in scope (the picked roofs, else every roof): In calculation (include /
 * leave out), shape, pitch (tilt on a flat roof), azimuth, eave, setback, gap, max panels and the align chip (a 3 × 3 picker
 * that opens under it). A field shows blank ("mixed") when the roofs in scope differ. Edits go through
 * `RoofEditor._applyScope`, the one path the 3D panel and the plan share. "More in panel" jumps to the inspector's Detail tab.
 *
 * Left panel: the Roofs list (`mountList`), every roof with its in / out switch, its panels and its aisles; a click picks it,
 * Shift-click adds. Include / leave out is one field, `roof.use`, set from here, from the chip on the roof (plan-solar.js
 * `setUse`) and from the bar, so they never disagree.
 *
 * Pure DOM + the globals PlanTools / PlanSolar / PlanSolarArray / RoofEditor / Roof3D; node-testable bits: `key`, `hint`, `alignLabel`.
 */
const SolarBar = {
  _icons: {
    select: '<path d="M6 3 L6 18 L10 14.5 L13 21 L15.5 20 L12.5 13.5 L18 13.5 Z"/>',
    roof: '<path d="M3 11 L12 4 L21 11 M5.5 9.5 V20 H18.5 V9.5"/>',
    draw: '<path d="M4 18 L8 6 L16 9 L20 18 Z"/>',
    keepout: '<path d="M4 5 H20 V19 H4 Z M4 19 L20 5 M4 12 L12 5 M12 19 L20 12"/>',
    place: '<path d="M3 5 H11 V11 H3 Z M13 5 H21 V11 H13 Z M3 13 H11 V19 H3 Z M13 13 H21 V19 H13 Z"/>',
    aisles: '<path d="M3 4 H21 V9 H3 Z M3 15 H21 V20 H3 Z"/>',
    row: '<path d="M3 4 H21 V9 H3 Z M3 15 H21 V20 H3 Z M7 12 H17 M7 12 l2 -1.5 M7 12 l2 1.5"/>',
    col: '<path d="M4 3 V21 H9 V3 Z M15 3 V21 H20 V3 Z M12 7 V17 M12 7 l-1.5 2 M12 7 l1.5 2"/>',
    remove: '<path d="M5 7 H19 M9 7 V4.5 H15 V7 M7 7 L8 20 H16 L17 7 M10.5 11 V16 M13.5 11 V16"/>',
    fit: '<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15"/>',
    caret: '<path d="M6 9 L12 15 L18 9"/>',
  },
  _hints: {
    select: ['Select', 'Click a roof to pick it. Click a grey roof\'s chip to include it. Shift-click picks several.'],
    roof: ['Detect roof', 'Click inside a building to detect its roof. Shift-click adds, Alt-click subtracts.'],
    draw: ['Draw', 'Click the corners of the roof. Enter closes it, Backspace takes a corner back.'],
    editor: ['Roof editor', 'Click a roof to select it. The roof tools are on the left of the 3D view.'],
    keepout: ['Keep-out', 'Click the corners of an area the panels must avoid. Enter closes it, Backspace takes a corner back.'],
    place: ['Place array', 'Click a roof and its panels are laid out on it. Gap and aisles are set in this toolbar.'],
    row: ['Row aisle', 'Click the dashed line between two rows of panels to open an aisle there. Alt-click an aisle to remove it.'],
    col: ['Column aisle', 'Click the dashed line between two columns of panels to open an aisle there. Alt-click an aisle to remove it.'],
    remove: ['Remove aisle', 'Click an aisle to remove it.'],
    object: ['Add object', 'Click a roof to put the object there; it shows on the plan and in 3D. Drag an object with Select to move it. Esc to stop.'],
  },
  hint(key) { return this._hints[key] || this._hints.select; },

  // Which button is armed, from the active plan tool.
  key() {
    const t = typeof PlanTools !== 'undefined' && PlanTools.active, id = t && t.id;
    if (id === 'solaraisle') return (PlanTools.opts && PlanTools.opts.mode) || 'row';
    if (id === 'select' && this.is3d() && typeof Roof3D !== 'undefined' && Roof3D.tool === 'aisle') return Roof3D.aisleMode || 'row';
    if (id === 'roofdetect') return typeof PlanRoomDetect !== 'undefined' && PlanRoomDetect.mode === 'draw' ? 'draw' : 'roof';
    return { roofedit: 'editor', roofkeepout: 'keepout', solararray: 'place', roofobject: 'object' }[id] || 'select';
  },
  is3d() { return typeof RoofEditor !== 'undefined' && !!RoofEditor.on; },
  // 2d (the plan alone) | split (the plan beside the 3D view) | 3d (the 3D view alone).
  layout() { return !this.is3d() ? '2d' : (document.getElementById('plan-main') || {}).classList && document.getElementById('plan-main').classList.contains('re-only3d') ? '3d' : 'split'; },
  _aisle(k) { return k === 'row' || k === 'col' || k === 'remove'; },

  // The roofs aisle width etc. act on (kept for the inspector and the plan's array tool).
  targets() {
    const all = PlanSolar.roofs().filter(r => r.array);
    const picked = all.filter(r => PlanSolar.sel.has(r.id));
    if (picked.length) return picked;
    const one = typeof PlanSolarArray !== 'undefined' ? all.find(r => r.id === PlanSolarArray.sel) : null;
    return one ? [one] : all;
  },

  el() { return document.getElementById('plan-solar-bar'); },
  hintEl() { return document.getElementById('plan-solar-hint'); },
  shown() { return typeof PlanMarkup !== 'undefined' && PlanMarkup.mode === 'solar' && PlanMarkup.context === 'plan'; },
  _esc(x) { return String(x).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); },

  // The align chip's words: 'bottom-right' → "Bottom right", 'center-center' → "Centre".
  alignLabel(v) {
    const [a, b] = String(v || 'bottom-right').split('-');
    const x = [a === 'center' ? '' : a === 'top' ? 'Top' : 'Bottom', b === 'center' ? '' : b === 'left' ? 'left' : 'right'].filter(Boolean).join(' ');
    return x || 'Centre';
  },

  init() {
    const el = this.el(); if (!el || el._sbBound) return;
    el._sbBound = true;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sb]');
      if (!b) { if (!e.target.closest('.sb-pop')) this._closePops(); return; }
      this._do(b.dataset.sb);
    });
    el.addEventListener('change', (e) => { const f = e.target.closest('[data-sf]'); if (f) this._field(f); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (this._menu || this._alignOpen)) { this._closePops(); e.stopPropagation(); } });
    document.addEventListener('click', (e) => { if ((this._menu || this._alignOpen) && !e.target.closest('#plan-solar-bar')) this._closePops(); });
  },
  _closePops() { if (this._menu || this._alignOpen) { this._menu = false; this._alignOpen = false; this.render(); } },

  // Show / hide with the Solar mode, and draw the current state.
  sync() { this.render(); },
  render() {                                                                // coalesced: a burst of edits draws once, after any focus move
    clearTimeout(this._rt); this._rt = setTimeout(() => this._render(), 0);
  },
  _scope() {
    return typeof RoofEditor !== 'undefined' ? RoofEditor._scope() : { roofs: PlanSolar.roofs(), picked: false };
  },
  _render() {
    const el = this.el(); if (!el) return;
    const show = this.shown();
    el.hidden = !show;
    const he = this.hintEl(); if (he) he.hidden = !show;
    if (!show) return;
    const act = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
    const keep = act ? (act.dataset.sb ? ['sb', act.dataset.sb] : act.dataset.sf ? ['sf', act.dataset.sf] : null) : null;
    el.innerHTML = this._row1() + this._row2();
    if (keep) { const n = el.querySelector(keep[0] === 'sb' ? `[data-sb="${keep[1]}"]` : `[data-sf="${keep[1]}"]`); if (n) n.focus(); }
    if (he) { const [ht, hb] = this.hint(this.key()); he.innerHTML = `<strong>${ht}</strong><span title="${this._esc(hb)}">${hb}</span><small>Esc to stop</small>`; }
    this._renderList();
  },
  _svg(k, cls) { return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${this._icons[k]}</svg>`; },

  // ── Row 1: the tools ──
  _row1() {
    const key = this.key(), lay = this.layout();
    const tb = (k, label, tip) => `<button type="button" class="sb-btn${key === k ? ' on' : ''}" data-sb="${k}" aria-pressed="${key === k}" title="${this._esc(tip)}">${this._svg(k)}<span>${label}</span></button>`;
    const grp = (name, inner) => `<div class="sb-grp" role="group" aria-label="${name}"><span class="sb-glab">${name}</span><div class="sb-row">${inner}</div></div>`;
    const aisleOn = this._aisle(key);
    const aisleLbl = key === 'col' ? 'Column aisle' : key === 'remove' ? 'Remove aisle' : key === 'row' ? 'Row aisle' : 'Aisles';
    const menu = this._menu ? `<div class="sb-menu" role="menu" aria-label="Maintenance aisles">${['row', 'col', 'remove'].map(k => `<button type="button" role="menuitem" class="sb-mi${key === k ? ' on' : ''}" data-sb="${k}">${this._svg(k)}<span>${{ row: 'Row aisle', col: 'Column aisle', remove: 'Remove aisle' }[k]}</span></button>`).join('')}</div>` : '';
    const aisles = `<div class="sb-pop"><button type="button" class="sb-btn${aisleOn ? ' on' : ''}" data-sb="aisles" aria-haspopup="menu" aria-expanded="${!!this._menu}" title="Open an aisle between rows or columns of panels, or remove one">${this._svg(aisleOn ? key : 'aisles')}<span>${aisleLbl}</span>${this._svg('caret', 'caret')}</button>${menu}</div>`;
    const seg = (k, label) => `<button type="button" data-sb="${k}" class="${lay === ({ v2: '2d', vs: 'split', v3: '3d' })[k] ? 'on' : ''}" aria-pressed="${lay === ({ v2: '2d', vs: 'split', v3: '3d' })[k]}">${label}</button>`;
    const roofs = PlanSolar.roofs().filter(r => r.points && r.points.length >= 3), inN = roofs.filter(r => r.use !== false).length;
    const tot = typeof PlanSolarArray !== 'undefined' ? PlanSolarArray.totals() : { n: 0, kwp: 0 };
    return `<div class="sb-bar" role="toolbar" aria-label="Solar tools for the plan and the 3D view">
      ${grp('Roofs', tb('select', 'Select', 'Select roofs and panels (V)') + tb('roof', 'Detect roof', 'Click inside a building to detect its roof') + tb('draw', 'Draw', 'Draw the roof outline corner by corner') + tb('keepout', 'Keep-out', 'Draw an area of a roof the panels must avoid'))}
      <div class="sb-sep"></div>
      ${grp('Panels', tb('place', 'Place array', 'Click a roof: the panels are laid out on it') + aisles)}
      <div class="sb-sep"></div>
      <div class="sb-grp" role="group" aria-label="View"><span class="sb-glab">View</span><div class="sb-row sb-center">
        <div class="sb-seg" role="group" aria-label="2D, split or 3D">${seg('v2', '2D')}${seg('vs', 'Split')}${seg('v3', '3D')}</div>
        <button type="button" class="sb-ibtn" data-sb="fit" aria-label="Zoom to fit" title="Zoom to fit">${this._svg('fit')}</button>
      </div></div>
      <div class="sb-fill"></div>
      <div class="sb-grp sb-right" role="group" aria-label="System"><span class="sb-glab">System</span><div class="sb-row sb-center sb-tot">
        <span><strong>${tot.n.toLocaleString()}</strong> panels</span><span class="sb-bar-sep" aria-hidden="true">|</span>
        <span><strong>${(+tot.kwp || 0).toFixed(1)}</strong> kWp</span><span class="sb-bar-sep" aria-hidden="true">|</span>
        <span>${inN} of ${roofs.length} roofs in</span>
        <button type="button" class="sb-go" data-sb="design" title="Solar PV Design: module, inverter, strings, protection, results and the PDF report">Design &amp; report</button>
      </div></div>
    </div>`;
  },

  // ── Row 2: the selection bar ──
  _fields: [['pitch', 'Pitch °', 0.1, r => r.shape !== 'flat', 56], ['tilt', 'Tilt °', 1, r => r.shape === 'flat', 56], ['azimuth', 'Azimuth °', 1, r => !['wings', 'pyramid'].includes(r.shape), 60],
    ['eave', 'Eave m', 0.05, () => true, 60], ['setback', 'Setback m', 0.05, () => true, 60], ['panelGap', 'Gap mm', 5, () => true, 52], ['maxModules', 'Max panels', 1, () => true, 64]],
  _row2() {
    const sc = this._scope(), roofs = sc.roofs, esc = this._esc;
    if (!roofs.length) return `<div class="sb-sel"><span class="sb-seltxt">No roofs yet. Use <b>Detect roof</b> or <b>Draw</b> to add one.</span></div>`;
    const title = sc.picked ? (roofs.length === 1 ? roofs[0].name : roofs.length + ' roofs') : 'All roofs';
    const sub = sc.picked ? roofs.length + (roofs.length === 1 ? ' roof picked' : ' roofs picked') : roofs.length + ' roofs · none picked';
    const nIn = roofs.filter(r => r.use !== false).length, allIn = nIn === roofs.length, none = nIn === 0;
    const pill = `<button type="button" class="sb-pill ${allIn ? 'in' : none ? 'out' : 'mix'}" data-sb="use" aria-pressed="${allIn}" title="${allIn ? 'Leave these roofs out of the solar calculation' : 'Put these roofs in the solar calculation'}"><span class="sb-tick" aria-hidden="true">${allIn ? '✓' : none ? '–' : '~'}</span>${allIn ? 'In calculation' : none ? 'Left out' : 'Mixed · ' + nIn + ' in'}</button>`;
    const same = new Set(roofs.map(r => r.shape)), cur = same.size === 1 ? [...same][0] : '';
    const shapes = `<div class="sb-seg" role="group" aria-label="Roof type">${['gable', 'hip', 'mono', 'flat'].map(x => `<button type="button" data-sb="shape:${x}" class="${cur === x ? 'on' : ''}" aria-pressed="${cur === x}">${{ gable: 'Gable', hip: 'Hip', mono: 'Mono', flat: 'Flat' }[x]}</button>`).join('')}</div>`;
    const fld = ([k, label, step, ok, w]) => {
      const rs = roofs.filter(ok); if (!rs.length) return '';
      const val = (r) => k === 'panelGap' ? PlanSolar.gapMm(r) : k === 'eave' ? RoofPlanes.eave(r) : k === 'maxModules' ? (PlanSolar.maxModules(r) === Infinity ? 0 : PlanSolar.maxModules(r)) : +r[k] || 0;
      const vals = new Set(rs.map(r => Math.round(val(r) * 1000) / 1000)), one = vals.size === 1 ? [...vals][0] : '';
      return `<label class="sb-f">${label}<input type="number" step="${step}" value="${esc(k === 'maxModules' && one === 0 ? '' : one)}" placeholder="${vals.size > 1 ? 'mixed' : k === 'maxModules' ? 'none' : ''}" data-sf="${k}" style="width:${w}px"></label>`;
    };
    const als = new Set(roofs.map(r => r.modAlign || 'bottom-right')), ca = als.size === 1 ? [...als][0] : '';
    const [av, ah] = ca ? ca.split('-') : ['', ''];
    const dot = ca ? `<circle cx="${ah === 'left' ? 4.5 : ah === 'right' ? 11.5 : 8}" cy="${av === 'top' ? 4.5 : av === 'bottom' ? 11.5 : 8}" r="2.2" fill="currentColor"/>` : '';
    const names = (v, h) => v === 'center' && h === 'center' ? 'Centre' : [v === 'top' ? 'Top (ridge)' : v === 'bottom' ? 'Bottom (eave)' : '', h === 'center' ? '' : h].filter(Boolean).join(', ');
    const grid = ['top', 'center', 'bottom'].map(v => ['left', 'center', 'right'].map(h => `<button type="button" class="sb-al${ca === v + '-' + h ? ' on' : ''}" data-sb="al:${v}-${h}" aria-pressed="${ca === v + '-' + h}" aria-label="${names(v, h)}" title="${names(v, h)}">${ca === v + '-' + h ? '<span aria-hidden="true"></span>' : ''}</button>`).join('')).join('');
    const one = roofs.length === 1 && sc.picked;
    const pop = this._alignOpen ? `<div class="sb-alpop" role="dialog" aria-label="Where the modules sit on the roof"><div class="sb-alcap">Ridge (top)</div><div class="sb-algrid">${grid}</div><div class="sb-alcap">Eave (bottom)</div>${one ? '<button type="button" class="sb-aledge" data-sb="aledge">Align to an edge…</button>' : ''}</div>` : '';
    const align = `<div class="sb-f sb-pop">Align<button type="button" class="sb-alchip" data-sb="align" aria-haspopup="dialog" aria-expanded="${!!this._alignOpen}" aria-label="Align modules: ${ca ? this.alignLabel(ca) : 'mixed'}. Opens a picker"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="currentColor" opacity=".5"/>${dot}</svg>${ca ? this.alignLabel(ca) : 'Mixed'}</button>${pop}</div>`;
    return `<div class="sb-sel" role="group" aria-label="Selected roofs">
      <div class="sb-selname"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
      ${pill}${shapes}${this._fields.map(fld).join('')}${align}
      <div class="sb-fill"></div>
      <button type="button" class="sb-more" data-sb="more">More in panel ›</button>
    </div>`;
  },
  // A field of the selection bar was committed: it goes to every roof in scope it applies to.
  _field(f) {
    const k = f.dataset.sf, def = this._fields.find(x => x[0] === k); if (!def) return;
    const raw = f.value.trim(), n = parseFloat(raw);
    let v;
    if (k === 'maxModules') v = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    else { if (!Number.isFinite(n)) return; v = k === 'azimuth' ? ((n % 360) + 360) % 360 : Math.max(0, k === 'panelGap' ? Math.min(200, n) : n); }
    this._apply({ [k]: v }, def[3]);
  },
  _apply(patch, ok) {
    const sc = this._scope(), had = sc.roofs.some(r => r.array && (!ok || ok(r)));
    RoofEditor._applyScope(patch, ok);
    if (had && typeof PlanSolarArray !== 'undefined') PlanSolarArray._queue();            // the single line follows the layout
    this.render();
  },

  // ── The Roofs list (left panel) ──
  _listEl: null,
  mountList(host) { this._listEl = host; this._renderList(); },
  _renderList() {
    const el = this._listEl; if (!el || !el.isConnected || !this.shown()) return;
    const esc = this._esc, roofs = PlanSolar.roofs().filter(r => r.points && r.points.length >= 3);
    const sw = (r) => { const on = r.use !== false; return `<button type="button" class="pf-sw" role="switch" aria-checked="${on}" data-sr-use="${esc(r.id)}" aria-label="${esc(r.name)} ${on ? 'in the calculation' : 'left out'}"><span></span></button>`; };
    const row = (r) => {
      const lay = r.array && typeof PlanSolarArray !== 'undefined' ? PlanSolarArray.layout(r) : null;
      const aisles = (r.aisles || []).length, parts = [RoofPlanes.LABELS[r.shape] || r.shape];
      if (r.shape !== 'flat') parts.push(Math.round(+r.azimuth || 0) + '°');
      parts.push(r.array ? (lay && !lay.pending ? lay.n + ' panels' : 'array') : 'no array');
      if (aisles) parts.push(aisles + (aisles === 1 ? ' aisle' : ' aisles'));
      if ((r.keepouts || []).length) parts.push('keep-out');
      const picked = PlanSolar.sel.has(r.id);
      return `<div class="pf-rowx${picked ? ' sel' : ''}${r.use === false ? ' out' : ''}"><button type="button" class="pf-rowmain" data-sr-pick="${esc(r.id)}" aria-pressed="${picked}"><svg class="pf-glyph" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="2.5" fill="#d9822b" fill-opacity=".25" stroke="#d9822b" stroke-width="1.6"/></svg><span class="pf-two"><span class="pf-rname">${esc(r.name)}</span><span>${esc(parts.join(' · '))}</span></span></button>${sw(r)}</div>`;
    };
    const top = el.querySelector('.pf-body') ? el.querySelector('.pf-body').scrollTop : 0;
    const tot = typeof PlanSolarArray !== 'undefined' ? PlanSolarArray.totals() : { n: 0 }, inN = roofs.filter(r => r.use !== false).length;
    const body = `<div class="pf-btnrow" style="margin-bottom:8px"><button type="button" class="pf-btn pf-sm" data-sr="all">Include all</button><button type="button" class="pf-btn pf-sm" data-sr="arrays">With arrays only</button></div>`
      + (roofs.length ? roofs.map(row).join('') : '<div class="pf-empty">No roofs yet. Use <b>Detect roof</b> or <b>Draw</b> in the toolbar.</div>');
    el.innerHTML = PlanUI._frame('Roofs', { count: roofs.length, right: '<span class="pf-aux">In calc</span>', tight: true, body,
      footer: `<div class="pf-aux">${tot.n.toLocaleString()} panels · ${inN} of ${roofs.length} roofs in</div><button type="button" class="pf-btn pf-amber" data-sb-design="1">Design &amp; report</button>` });
    const bd = el.querySelector('.pf-body'); if (bd) bd.scrollTop = top;
    if (!el._srBound) {
      el._srBound = true;
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-sb-design]')) { if (typeof Solar !== 'undefined') Solar.open(); return; }
        const sw = e.target.closest('[data-sr-use]'), pk = e.target.closest('[data-sr-pick]'), bt = e.target.closest('[data-sr]');
        const all = PlanSolar.roofs().filter(r => r.points && r.points.length >= 3);
        if (sw) { const r = all.find(x => x.id === sw.dataset.srUse); if (r) PlanSolar.setUse([r.id], r.use === false); return; }
        if (pk) { if (e.shiftKey) PlanSolar.toggleSelect(pk.dataset.srPick); else PlanSolar.selectRoofs([pk.dataset.srPick]); return; }
        if (bt && bt.dataset.sr === 'all') PlanSolar.setUse(all.map(r => r.id), true);
        else if (bt && bt.dataset.sr === 'arrays') { PlanSolar.setUse(all.filter(r => !r.array).map(r => r.id), false); PlanSolar.setUse(all.filter(r => r.array).map(r => r.id), true); }
      });
    }
  },

  _toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m, 'info', 3000); },

  _do(k) {
    if (k === 'v2') return this.view('2d');
    if (k === 'vs') return this.view('split');
    if (k === 'v3') return this.view('3d');
    if (k === 'fit') { if (typeof PlanEngine !== 'undefined') PlanEngine.zoomFit(); return; }
    if (k === 'aisles') { this._menu = !this._menu; this._alignOpen = false; this.render(); return; }
    if (k === 'align') { this._alignOpen = !this._alignOpen; this._menu = false; this.render(); return; }
    if (k === 'design') { if (typeof Solar !== 'undefined') Solar.open(); return; }
    if (k === 'more') { RoofEditor.tab = 'detail'; RoofEditor.renderPanel(); const h = RoofEditor._host(); if (h) { h.scrollTop = 0; const f = h.querySelector('summary, button, input'); if (f) f.focus(); } return; }
    if (k === 'use') { const sc = this._scope(), ids = sc.roofs.map(r => r.id); PlanSolar.setUse(ids, !sc.roofs.every(r => r.use !== false)); return; }
    if (k.startsWith('shape:')) { this._apply({ shape: k.slice(6) }); return; }
    if (k.startsWith('al:')) { this._alignOpen = false; this._apply({ modAlign: k.slice(3) }); return; }
    if (k === 'aledge') { this._alignOpen = false; RoofEditor.aligning = true; PlanTools.set('roofedit'); this.render(); if (RoofEditor.renderPanel) RoofEditor.renderPanel(); return; }
    this._menu = false;
    this.pick(k);
  },

  pick(key) {
    const set = (id, opts) => PlanTools.set(id, Object.assign({ type: id }, opts || {}));
    const d3 = this.is3d();
    if (key === 'select') { if (d3) RoofEditor.setTool('select'); else PlanTools.set('select'); }
    else if (key === 'roof') set('roofdetect');
    else if (key === 'draw') { set('roofdetect'); if (typeof PlanRoomDetect !== 'undefined') { PlanRoomDetect.mode = 'draw'; PlanRoomDetect.draft = null; if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); } }
    else if (key === 'keepout') set('roofkeepout');
    else if (key === 'place') set('solararray');
    else if (key === 'editor') set('roofedit');
    else if (this._aisle(key)) set('solaraisle', { mode: key });
    if (d3 && typeof Roof3D !== 'undefined' && key !== 'editor') Roof3D.setTool(this._aisle(key) ? 'aisle' : 'select', this._aisle(key) ? key : undefined);   // the 3D view follows the toolbar
    this.render();
  },

  // 2D = the plan alone, Split = the Roof editor (the plan beside a live 3D view), 3D = that with the plan hidden. The armed tool carries over.
  async view(v) {
    const k = this.key(), main = document.getElementById('plan-main');
    if (v === '2d') { if (this.is3d()) RoofEditor.close(); }
    else {
      if (!this.is3d()) await RoofEditor.open();
      if (main) main.classList.toggle('re-only3d', v === '3d');
      if (typeof PlanEngine !== 'undefined' && PlanEngine.resize) setTimeout(() => PlanEngine.resize(), 0);
      if (typeof Roof3D !== 'undefined' && Roof3D.view && Roof3D.view.resize) setTimeout(() => Roof3D.view.resize(), 0);
    }
    if (this._aisle(k)) this.pick(k);
    this.render();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SolarBar;
