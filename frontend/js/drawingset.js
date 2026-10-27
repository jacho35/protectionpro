/* ProtectionPro — DrawingSet: the single line diagram as an editable set of sheets.
 *
 * Output ▸ Drawing set. A set belongs to one diagram tab and is saved in the
 * project (AppState.drawingSets, synced by Collab). It starts as a proposal —
 * SheetPrint.plan packs the buses onto sheets — and the user then moves buses
 * between sheets (chips onto sheet cards, or click / box-select on the whole
 * diagram), renames, reorders, locks sheets so "Propose again" keeps them, and
 * adds saved views (AppState.sldViews: selected parts or a print window, from
 * sldexport.js). Set options: paper, one scale for every sheet or each fitted,
 * standard / formal title block (drawing numbers from a pattern, issue status,
 * revisions; the rest from Project details), key plan. The preview is the very
 * SVG that VectorPDF turns into the PDF.
 */

const DrawingSet = {
  _el: null,
  setId: null,
  sel: 0,            // index into the set's sheets, or 'key'
  mode: 'sheet',     // 'sheet' | 'diagram'
  tab: 'sheet',      // right panel: 'sheet' | 'set'
  _model: null, _base: null, _plan: null, _comps: null,

  PAPER_CHOICES: [['a4', true, 'A4 landscape'], ['a4', false, 'A4 portrait'], ['a3', true, 'A3 landscape'], ['a3', false, 'A3 portrait'], ['a2', true, 'A2 landscape'], ['a2', false, 'A2 portrait'], ['a1', true, 'A1 landscape'], ['a1', false, 'A1 portrait']],
  COLORS: ['#1d5fa8', '#c2570c', '#0e7c66', '#a1306b', '#6b5b00', '#3d5a80', '#9c4a1a', '#2f6f3e'],

  uid(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; },
  _esc(s) { return typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  _pageId() { return AppState.activePageId || 'page_1'; },
  setsHere() { return AppState.drawingSets.filter(s => (s.pageId || 'page_1') === this._pageId()); },
  current() { return AppState.drawingSets.find(s => s.id === this.setId) || null; },
  views() { return AppState.sldViews.filter(v => (v.pageId || 'page_1') === this._pageId()); },
  viewOf(id) { return AppState.sldViews.find(v => v.id === id) || null; },
  _dirty() { AppState.dirty = true; },

  defaultOpts() {
    let old = null;
    try { old = JSON.parse(localStorage.getItem('protectionpro-sheet-print') || 'null'); } catch (e) { /* private mode */ }
    const o = Object.assign(SheetPrint.defaults(), { numbering: '{project}-E-SLD-{nn}', status: '' });
    if (old) ['paper', 'landscape', 'minPt'].forEach(k => { if (old[k] !== undefined) o[k] = old[k]; });
    return o;
  },

  newSet(name) {
    const set = { id: this.uid('ds'), name: name || 'Drawing set', pageId: this._pageId(), opts: this.defaultOpts(), sheets: [], revisions: [] };
    AppState.drawingSets.push(set);
    this.propose(set);
    this._dirty();
    return set;
  },

  _busKey(buses) { return buses.slice().sort().join('|'); },

  // Re-run the proposal: locked sheets stay as they are, views stay at the end
  propose(set) {
    if (!this._model) { this._model = SheetPrint.buildModel(); this._comps = new Map(this._model.comps.map(c => [c.id, c])); }
    const model = this._model;
    const fixed = set.sheets.filter(s => s.kind === 'buses' && s.locked).map(s => ({ id: s.id, buses: s.buses }));
    const p = SheetPrint.plan(model, Object.assign({}, set.opts, { keyPlan: false, fixed, sheets: undefined }));
    const old = new Map(set.sheets.filter(s => s.kind === 'buses').map(s => [this._busKey(s.buses), s]));
    const byId = new Map(set.sheets.map(s => [s.id, s]));
    const seen = new Set();
    const out = [];
    for (const pg of p.pages) {
      if (seen.has(pg.id)) continue;
      seen.add(pg.id);
      if (byId.has(pg.id)) { out.push(byId.get(pg.id)); continue; }
      const prev = old.get(this._busKey(pg.buses));
      out.push(prev && !prev.locked ? prev : { id: this.uid('sh'), kind: 'buses', buses: pg.buses.slice(), title: '', dwgNo: '', locked: false });
    }
    set.sheets = out.concat(set.sheets.filter(s => s.kind === 'view'));
  },

  _sheetsForPlan(set) {
    return set.sheets.map(s => {
      if (s.kind !== 'view') return { id: s.id, kind: 'buses', buses: s.buses, title: s.title };
      const v = this.viewOf(s.viewId);
      return { id: s.id, kind: 'view', title: s.title || (v && v.name) || 'View', view: v ? { kind: v.kind, parts: v.parts, window: v.window } : { kind: 'parts', parts: [] } };
    });
  },

  planFor(set) {
    return SheetPrint.plan(this._model, Object.assign({}, set.opts, { sheets: this._sheetsForPlan(set) }));
  },

  dwgNo(set, n) {
    const pat = (set.opts.numbering || '').trim();
    if (!pat) return '';
    const d = AppState.projectDetails || {};
    return pat.replace(/\{project\}/g, d.projectNumber || 'DWG').replace(/\{nnn\}/g, String(n).padStart(3, '0')).replace(/\{nn\}/g, String(n).padStart(2, '0')).replace(/\{n\}/g, String(n));
  },

  // What the title blocks need
  info(set, plan) {
    const d = AppState.projectDetails || {};
    const revs = Array.isArray(set.revisions) ? set.revisions.filter(r => r && (r.rev || r.desc)) : [];
    const sheetOf = new Map(set.sheets.map(s => [s.id, s]));
    return {
      base: this._base,
      project: AppState.projectName || 'Untitled Project',
      details: d,
      date: d.date || new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
      rev: revs.length ? revs[revs.length - 1].rev : (d.revisionNumber || ''),
      revisions: revs,
      status: set.opts.status || '',
      total: plan.keyPages + plan.pages.length,
      setName: set.name,
      busName: (b) => (this._comps.get(b) || {}).name || b,
      bboxOf: (id) => (this._comps.get(id) || {}).bbox,
      keyDwgNo: (part) => this.dwgNo(set, part + 1),
      cellOf: (pg) => {
        const sh = sheetOf.get(pg.id) || {};
        const v = sh.kind === 'view' ? this.viewOf(sh.viewId) : null;
        let title = sh.title || (v && v.name) || pg.title;
        if (pg.part) {
          const same = plan.pages.filter(p => p.id === pg.id);
          title += ` (part ${same.indexOf(pg) + 1} of ${same.length})`;
        }
        const sub = sh.kind === 'view' ? (v && v.kind === 'window' ? 'Window on the diagram' : 'Selected parts') : pg.buses.map(b => (this._comps.get(b) || {}).name || b).join(', ');
        return { title: 'Single line diagram — ' + title, short: title, sub, no: pg.no, dwgNo: sh.dwgNo || this.dwgNo(set, pg.no) };
      },
    };
  },

  // ── open / close ──────────────────────────────────────────────
  open(opts) {
    opts = opts || {};
    this._model = SheetPrint.buildModel();
    if (!this._model.comps.some(c => c.type === 'bus') && !this.views().length) { UI.alert('This diagram has no buses to make sheets from.'); return; }
    this._comps = new Map(this._model.comps.map(c => [c.id, c]));
    this._base = SheetPrint.prepareBase();
    let set = AppState.drawingSets.find(s => s.id === (opts.setId || this.setId) && (s.pageId || 'page_1') === this._pageId()) || this.setsHere()[0];
    if (!set) set = this.newSet('Issued set');
    this.setId = set.id;
    this._sync(set);
    if (opts.selectSheet) { const i = set.sheets.findIndex(s => s.id === opts.selectSheet); if (i >= 0) this.sel = i; }
    if (this.sel !== 'key' && !(this.sel < set.sheets.length)) this.sel = set.opts.keyPlan ? 'key' : 0;
    if (!this._el) this._build();
    this._el.style.display = 'flex';
    this.render();
  },

  close() {
    if (this._el) { this._el.remove(); this._el = null; }
    this._base = null;
    this._model = null;
  },

  // Remote edits (Collab) or a diagram change while open
  refresh() {
    if (!this._el) return;
    const set = this.current();
    if (!set) { this.close(); return; }
    this._sync(set);
    this.render();
  },

  // Drop buses / views that no longer exist
  _sync(set) {
    for (const s of set.sheets) if (s.kind === 'buses') s.buses = (s.buses || []).filter(b => this._comps.has(b) && this._comps.get(b).type === 'bus');
    set.sheets = set.sheets.filter(s => s.kind !== 'view' || this.viewOf(s.viewId));
    set.opts = Object.assign(this.defaultOpts(), set.opts || {});
    // options come from the project file / Collab: hold them to their allowed values
    const o = set.opts, pick = (v, ok, d) => (ok.includes(v) ? v : d);
    o.paper = SheetPrint.PAPERS[o.paper] ? o.paper : 'a3';
    o.landscape = o.landscape !== false;
    o.minPt = Math.min(14, Math.max(4, +o.minPt || 8));
    o.maxBuses = Math.min(30, Math.max(1, Math.round(+o.maxBuses) || 6));
    o.scale = pick(o.scale, ['uniform', 'fit'], 'uniform');
    o.titleBlock = pick(o.titleBlock, ['standard', 'formal'], 'standard');
    o.oversize = pick(o.oversize, ['split', 'keep'], 'split');
    o.cut = pick(o.cut, ['tags', 'edge'], 'tags');
    o.keyPlan = o.keyPlan !== false;
    o.numbering = typeof o.numbering === 'string' ? o.numbering : '';
    o.status = typeof o.status === 'string' ? o.status : '';
    if (typeof set.name !== 'string') set.name = 'Drawing set';
    if (!Array.isArray(set.revisions)) set.revisions = [];
  },

  _build() {
    const el = document.createElement('div');
    el.id = 'ds-modal';
    el.className = 'modal ds-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Drawing set');
    document.body.appendChild(el);
    this._el = el;
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('change', (e) => this._onChange(e));
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) { e.stopPropagation(); this._closeMenus() || this.close(); } });
    el.addEventListener('dragstart', (e) => this._onDragStart(e));
    el.addEventListener('dragover', (e) => { if (e.target.closest('[data-drop]')) { e.preventDefault(); e.target.closest('[data-drop]').classList.add('ds-over'); } });
    el.addEventListener('dragleave', (e) => { const d = e.target.closest('[data-drop]'); if (d) d.classList.remove('ds-over'); });
    el.addEventListener('drop', (e) => this._onDrop(e));
    el.addEventListener('pointerdown', (e) => this._onStageDown(e));
  },

  // ── render ────────────────────────────────────────────────────
  render() {
    const set = this.current();
    if (!set || !this._el) return;
    this._plan = this.planFor(set);
    const P = this._plan;
    const e = this._esc;
    const info = this.info(set, P);
    const sheets = set.sheets;
    const sel = this.sel;
    const cur = sel === 'key' ? null : sheets[sel];
    const pagesOf = (sh) => P.pages.filter(pg => pg.id === sh.id);
    const pt = P.pages.length ? Math.min(...P.pages.filter(p => !P.oversized.some(o => o.id === p.id)).map(p => p.pt).concat([Infinity])) : 0;
    const tabName = ((AppState.pages || []).find(p => p.id === this._pageId()) || {}).name || '';
    const sum = `${P.keyPages + P.pages.length} page${P.keyPages + P.pages.length === 1 ? '' : 's'} · ${P.connectors.length} connector${P.connectors.length === 1 ? '' : 's'}`
      + (isFinite(pt) && pt ? ` · text ${pt.toFixed(1)} pt${set.opts.scale === 'uniform' ? (P.oversized.length ? ' (smaller on sheets too big)' : ' on every sheet') : ' at the smallest'}` : '');

    // rail
    const card = (i, sh) => {
      const pgs = pagesOf(sh);
      const v = sh.kind === 'view' ? this.viewOf(sh.viewId) : null;
      const title = sh.title || (v && v.name) || (pgs[0] && pgs[0].title) || (sh.buses.length ? '' : 'Empty sheet');
      const no = pgs.length ? SheetPrint.sheetNo(pgs[0].no) + (pgs.length > 1 ? `–${SheetPrint.sheetNo(pgs[pgs.length - 1].no)}` : '') : '–';
      const meta = sh.kind === 'view' ? 'Saved view' : `${sh.buses.length} bus${sh.buses.length === 1 ? '' : 'es'}${pgs.length > 1 ? ` · ${pgs.length} parts` : ''}${sh.locked ? ' · kept' : ''}`;
      const badge = sh.kind === 'view' ? `<span class="ds-badge">${v && v.kind === 'window' ? 'Window' : 'Selection'}</span>` : '';
      const lock = sh.locked ? '<svg class="ds-ic" width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="Kept when proposing again"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' : '';
      const over = P.oversized.some(o => o.id === sh.id);
      return `<button type="button" class="ds-card${i === sel ? ' ds-sel' : ''}" data-act="pick" data-i="${i}" data-drop="sheet" draggable="true" aria-current="${i === sel}">
        <span class="ds-grip" aria-hidden="true"></span>
        <span class="ds-thumb" data-thumb="${i}"></span>
        <span class="ds-cardtxt"><span class="ds-no">${no}${badge}${lock}</span><span class="ds-title">${e(title || 'Sheet')}</span><span class="ds-meta">${e(meta)}${over ? ' · <b class="ds-warnt">too big</b>' : ''}</span></span>
      </button>`;
    };
    const keyCard = set.opts.keyPlan ? `<button type="button" class="ds-card${sel === 'key' ? ' ds-sel' : ''}" data-act="pick" data-i="key"><span class="ds-grip ds-grip-off" aria-hidden="true"></span><span class="ds-thumb" data-thumb="key"></span><span class="ds-cardtxt"><span class="ds-no">${P.keyPages > 1 ? `01–${SheetPrint.sheetNo(P.keyPages)}` : '01'}</span><span class="ds-title">Key plan &amp; index</span><span class="ds-meta">Generated</span></span></button>` : '';
    const unassigned = P.unassigned.map(b => (this._comps.get(b) || {}).name || b);
    const warn = [];
    if (unassigned.length) {
      const putOn = cur && cur.kind === 'buses' ? `<button type="button" class="btn-small" data-act="assign-unassigned">Put on ${e(SheetPrint.sheetNo((pagesOf(cur)[0] || {}).no || ''))}</button>` : '';
      warn.push(`<div class="ds-warn" role="status"><b>${unassigned.length === 1 ? `${e(unassigned[0])} isn't on any sheet.` : `${unassigned.length} buses aren't on any sheet:`}</b>${unassigned.length > 1 ? ` ${e(unassigned.join(', '))}.` : ''} Wires to ${unassigned.length === 1 ? 'it' : 'them'} end in a “not on a sheet” tag.
        <span class="ds-warnbtns">${putOn}<button type="button" class="btn-small" data-act="unassigned-new">New sheet</button><button type="button" class="btn-small" data-act="propose">Propose again</button></span></div>`);
    }
    if (P.oversized.length) {
      const bigger = this._biggerPaper(set);
      warn.push(`<div class="ds-warn" role="status"><b>Too big for one ${e(String(set.opts.paper).toUpperCase())} sheet at ${Number(set.opts.minPt)} pt:</b> ${e(P.oversized.map(o => `${o.title} (${o.pt.toFixed(1)} pt${o.tall ? ', too tall' : ''})`).join('; '))}.
        <span class="ds-warnbtns">${bigger ? `<button type="button" class="btn-small" data-act="paper-up" data-paper="${e(bigger)}">Use ${e(bigger.toUpperCase())}</button>` : ''}${set.opts.landscape && P.oversized.some(o => o.tall) ? '<button type="button" class="btn-small" data-act="portrait">Portrait</button>' : ''}</span></div>`);
    }

    const views = this.views();
    const inSet = new Set(sheets.filter(s => s.kind === 'view').map(s => s.viewId));
    const nSel = [...AppState.selectedIds].filter(id => this._comps.has(id)).length;
    const addMenu = `<div class="ds-menu" id="ds-add-menu" hidden>
      <button type="button" class="dropdown-item" data-act="add-empty">Empty sheet for buses</button>
      <button type="button" class="dropdown-item" data-act="add-selection" ${nSel ? '' : 'disabled'}>From the selection on the diagram${nSel ? ` (${nSel} parts)` : ' — select parts first'}</button>
      <button type="button" class="dropdown-item" data-act="add-window">Draw a print window…</button>
      ${views.filter(v => !inSet.has(v.id)).map(v => `<button type="button" class="dropdown-item" data-act="add-view" data-view="${e(v.id)}">Saved view: ${e(v.name)}</button>`).join('')}
    </div>`;

    const rail = `<div class="ds-railhead"><span class="ds-over">SHEETS</span><button type="button" class="btn-small" data-act="propose" title="Pack the buses onto sheets again. Sheets you keep stay as they are.">Propose again</button></div>
      ${keyCard}${sheets.map((sh, i) => card(i, sh)).join('')}
      <div class="ds-addwrap"><button type="button" class="ds-add" data-act="add-menu" aria-haspopup="menu"><svg class="ds-ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add sheet</button>${addMenu}</div>
      ${warn.join('')}`;

    // toolbar
    const o = set.opts;
    const paperVal = `${o.paper}-${o.landscape ? 'l' : 'p'}`;
    const seg = (name, items, val) => `<div class="ds-seg" role="group">${items.map(([v, l]) => `<button type="button" data-act="${e(name)}" data-v="${e(v)}" aria-pressed="${v === val ? 'true' : 'false'}">${l}</button>`).join('')}</div>`;
    const bar = `${seg('mode', [['sheet', 'Sheet'], ['diagram', 'Whole diagram']], this.mode)}
      <span class="ds-vr"></span>
      <label class="ds-lab">Paper <select data-ch="paper">${this.PAPER_CHOICES.map(([p, l, t]) => `<option value="${p}-${l ? 'l' : 'p'}" ${`${p}-${l ? 'l' : 'p'}` === paperVal ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="ds-lab">Scale <select data-ch="scale"><option value="uniform" ${o.scale === 'uniform' ? 'selected' : ''}>Same on every sheet</option><option value="fit" ${o.scale === 'fit' ? 'selected' : ''}>Fit each sheet</option></select></label>
      <span class="ds-lab">Title block ${seg('tb', [['standard', 'Standard'], ['formal', 'Formal']], o.titleBlock === 'formal' ? 'formal' : 'standard')}</span>
      <label class="ds-lab ds-chk"><input type="checkbox" data-ch="keyPlan" ${o.keyPlan ? 'checked' : ''}> Key plan</label>`;

    // stage
    const pageList = [];
    for (let k = 0; k < P.keyPages; k++) pageList.push({ key: k });
    P.pages.forEach(pg => pageList.push({ pg }));
    let curPages = sel === 'key' ? pageList.filter(x => x.key !== undefined) : (cur ? pageList.filter(x => x.pg && x.pg.id === cur.id) : []);
    if (!this._pageIdx || this._pageIdx.sel !== sel) this._pageIdx = { sel, i: 0 };
    const pi = Math.min(this._pageIdx.i, Math.max(0, curPages.length - 1));
    const shown = curPages[pi];
    const total = P.keyPages + P.pages.length;
    const pager = shown ? `<button type="button" class="ds-ibtn" data-act="page-prev" aria-label="Previous page">‹</button>
      <span><b>Page ${shown.key !== undefined ? shown.key + 1 : shown.pg.no} of ${total}</b>${shown.pg ? ` · text ${shown.pg.pt.toFixed(1)} pt · ${shown.pg.tags.filter(t => t.kind !== 'grey').length} connector${shown.pg.tags.length === 1 ? '' : 's'}` : ''}${curPages.length > 1 ? ` · part ${pi + 1} of ${curPages.length}` : ''}</span>
      <button type="button" class="ds-ibtn" data-act="page-next" aria-label="Next page">›</button>` : (cur && cur.kind === 'buses' && !cur.buses.length ? '<span>This sheet is empty. Add buses from the panel on the right, or from Whole diagram.</span>' : '');

    const side = this._sideHTML(set, cur, P, info);

    const sets = this.setsHere();
    this._el.innerHTML = `<header class="ds-head">
        <div class="ds-brand"><svg class="ds-ic ds-brandic" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/></svg>
          <span><b>Drawing set</b><small>${e(AppState.projectName || 'Untitled Project')}${tabName ? ' · ' + e(tabName) : ''}</small></span></div>
        <select data-ch="set" aria-label="Drawing set">${sets.map(s => `<option value="${e(s.id)}" ${s.id === set.id ? 'selected' : ''}>${e(s.name)}</option>`).join('')}<option value="__new">New set…</option></select>
        <div class="ds-addwrap"><button type="button" class="ds-ibtn" data-act="set-menu" aria-label="Set actions" aria-haspopup="menu">⋯</button>
          <div class="ds-menu" id="ds-set-menu" hidden><button type="button" class="dropdown-item" data-act="set-rename">Rename…</button><button type="button" class="dropdown-item" data-act="set-dup">Duplicate</button><button type="button" class="dropdown-item context-danger" data-act="set-del">Delete set…</button></div></div>
        <span class="ds-grow"></span>
        <span class="ds-sum">${e(sum)}</span>
        <button type="button" class="btn" data-act="close">Close</button>
        <div class="ds-addwrap ds-exp"><button type="button" class="btn btn-primary" data-act="export">Export PDF</button><button type="button" class="btn btn-primary ds-caret" data-act="export-menu" aria-label="More export choices" aria-haspopup="menu">▾</button>
          <div class="ds-menu ds-menu-r" id="ds-exp-menu" hidden><button type="button" class="dropdown-item" data-act="export">Whole set (${total} pages)</button><button type="button" class="dropdown-item" data-act="export-one" ${shown ? '' : 'disabled'}>This page only</button></div></div>
      </header>
      <div class="ds-body">
        <aside class="ds-rail" aria-label="Sheets">${rail}</aside>
        <main class="ds-main"><div class="ds-bar">${bar}</div><div class="ds-stage" id="ds-stage"></div><div class="ds-pager">${this.mode === 'sheet' ? pager : '<span>Click a bus to put it on the selected sheet or take it off · drag a box to move several</span>'}</div></main>
        <aside class="ds-side" aria-label="Sheet and set settings">${side}</aside>
      </div>`;

    // stage content
    const stage = this._el.querySelector('#ds-stage');
    if (this.mode === 'diagram') stage.appendChild(this._diagramSVG(set, P));
    else if (shown) {
      const svg = shown.key !== undefined ? SheetPrint.keyPageSVG(P, this._base, info, shown.key) : SheetPrint.pageSVG(P, shown.pg, this._base, info, 'pv');
      svg.classList.add('ds-paper');
      svg.removeAttribute('width'); svg.removeAttribute('height');
      stage.appendChild(svg);
    }
    this._shownPage = shown;
    // thumbnails after the paint
    clearTimeout(this._thumbT);
    this._thumbT = setTimeout(() => this._thumbs(set, P, info), 30);
  },

  _thumbs(set, P, info) {
    if (!this._el) return;
    this._el.querySelectorAll('[data-thumb]').forEach(slot => {
      const k = slot.getAttribute('data-thumb');
      let svg = null;
      if (k === 'key') { if (P.keyPages) svg = SheetPrint.keyPageSVG(P, this._base, info, 0); } else {
        const sh = set.sheets[+k];
        const pg = sh && P.pages.find(p => p.id === sh.id);
        if (pg) svg = SheetPrint.pageSVG(P, pg, this._base, info, 't' + k);
      }
      if (!svg) return;
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.setAttribute('aria-hidden', 'true');
      slot.appendChild(svg);
    });
  },

  _sideHTML(set, cur, P, info) {
    const e = this._esc, o = set.opts;
    const tabs = `<div class="ds-seg ds-tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-v="sheet" aria-selected="${this.tab === 'sheet'}" aria-pressed="${this.tab === 'sheet'}">Sheet</button><button type="button" role="tab" data-act="tab" data-v="set" aria-selected="${this.tab === 'set'}" aria-pressed="${this.tab === 'set'}">Set</button></div>`;
    if (this.tab === 'set') {
      const revs = set.revisions.map((r, i) => `<tr>${['rev', 'date', 'desc', 'by', 'chk'].map(k => `<td><input type="text" data-rev="${i}" data-k="${k}" value="${e(r[k] || '')}" aria-label="${k}"></td>`).join('')}<td><button type="button" class="ds-ibtn" data-act="rev-del" data-i="${i}" aria-label="Remove revision">×</button></td></tr>`).join('');
      return `${tabs}
        <label class="ds-field">Name<input type="text" data-ch="name" value="${e(set.name)}"></label>
        <label class="ds-field">Drawing numbers<input type="text" data-ch="numbering" value="${e(o.numbering || '')}" placeholder="{project}-E-SLD-{nn}"><small>{project} is the project number in Project details, {nn} the page number. Leave empty for none.</small></label>
        <div class="ds-two">
          <label class="ds-field">Minimum text<span class="ds-unit"><input type="number" min="4" max="14" step="0.5" data-ch="minPt" value="${Number(o.minPt)}"> pt</span></label>
          <label class="ds-field">Buses per sheet<input type="number" min="1" max="30" data-ch="maxBuses" value="${Number(o.maxBuses)}"></label>
        </div>
        <label class="ds-field">A bus too wide for a sheet<select data-ch="oversize"><option value="split" ${o.oversize === 'split' ? 'selected' : ''}>Continue it on the next page</option><option value="keep" ${o.oversize !== 'split' ? 'selected' : ''}>Keep it whole, smaller text</option></select></label>
        <label class="ds-field">Wires leaving a saved view<select data-ch="cut"><option value="tags" ${o.cut !== 'edge' ? 'selected' : ''}>Grey tag naming the next part</option><option value="edge" ${o.cut === 'edge' ? 'selected' : ''}>Stop at the edge</option></select></label>
        <div class="ds-sep"></div>
        <span class="ds-over">FORMAL TITLE BLOCK</span>
        <label class="ds-field">Issue status<input type="text" data-ch="status" value="${e(o.status || '')}" placeholder="e.g. For approval"></label>
        <div class="ds-field">Revisions<table class="ds-revs"><thead><tr><th>Rev</th><th>Date</th><th>Description</th><th>By</th><th>Chk</th><th></th></tr></thead><tbody>${revs}</tbody></table>
          <button type="button" class="btn-small" data-act="rev-add">Add revision</button></div>
        <small class="ds-note">Client, project number, company, logo and drawn / checked / approved come from Project details (click an empty part of the diagram).</small>`;
    }
    if (this.sel === 'key') {
      return `${tabs}<span class="ds-over">KEY PLAN &amp; INDEX</span><p class="ds-note">Made from the sheets: the whole diagram with each sheet outlined, then the sheet index and every off-page connector. A long index continues on the next page. Turn it off with Key plan above.</p>`;
    }
    if (!cur) return tabs;
    const pgs = P.pages.filter(pg => pg.id === cur.id);
    const no = pgs[0] ? pgs[0].no : null;
    const tagRows = pgs.flatMap(pg => pg.tags.filter(t => t.kind !== 'grey')).map(t => `<b>${e(t.id)}</b><span>${t.dir === 'TO' ? 'to' : 'from'} ${t.farPage ? `${SheetPrint.sheetNo(t.farPage.no)} · ${e(t.farPage.tags.find(x => x.id === t.id && x !== t)?.zone || '')}` : 'no sheet'} · ${e(t.bus || '')}</span>`).join('');
    const head = `${tabs}<div class="ds-sidehead"><span class="ds-over">${no ? 'SHEET ' + SheetPrint.sheetNo(no) : 'SHEET'}</span><button type="button" class="ds-link" data-act="${cur.kind === 'view' ? 'view-remove' : 'sheet-remove'}">${cur.kind === 'view' ? 'Take out of the set' : 'Remove sheet'}</button></div>
      <label class="ds-field">Title<input type="text" data-ch="title" value="${e(cur.title || '')}" placeholder="${e((pgs[0] && pgs[0].title) || (cur.kind === 'view' ? (this.viewOf(cur.viewId) || {}).name || '' : ''))}"></label>
      <label class="ds-field">Drawing no.<input type="text" data-ch="dwgNo" value="${e(cur.dwgNo || '')}" placeholder="${e(no ? this.dwgNo(set, no) : '')}"><small>From the set's numbering. Type to override.</small></label>`;
    if (cur.kind === 'view') {
      const v = this.viewOf(cur.viewId) || {};
      const win = v.window || {};
      const geo = v.kind === 'window' ? `<div class="ds-field">Window<div class="ds-four">${['x', 'y', 'w', 'h'].map(k => `<label>${k.toUpperCase()}<input type="number" data-win="${k}" value="${Math.round(win[k] || 0)}"></label>`).join('')}</div></div>
        <button type="button" class="btn-small" data-act="view-redraw">Draw it again on the diagram…</button>`
        : `<p class="ds-note">${(v.parts || []).length} parts. A view keeps these parts, not a picture: parts added to the diagram later stay out until you replace them.</p>
        <button type="button" class="btn-small" data-act="view-reselect" ${[...AppState.selectedIds].length ? '' : 'disabled'}>Replace with the current selection</button>`;
      return `${head}<label class="ds-field">View name<input type="text" data-ch="viewName" value="${e(v.name || '')}"></label>
        <div class="ds-field">Shows <span class="ds-badge">${v.kind === 'window' ? 'Window' : 'Selected parts'}</span></div>${geo}
        ${tagRows ? `<div class="ds-field">Connectors<div class="ds-conns">${tagRows}</div></div>` : ''}`;
    }
    const busName = (b) => (this._comps.get(b) || {}).name || b;
    const sheetNoOf = (b) => { const s = set.sheets.find(x => x.kind === 'buses' && x.buses.includes(b)); const pg = s && P.pages.find(p => p.id === s.id); return pg ? SheetPrint.sheetNo(pg.no) : null; };
    const all = this._model.comps.filter(c => c.type === 'bus').map(c => c.id).filter(b => !cur.buses.includes(b));
    const opts = all.map(b => ({ b, on: sheetNoOf(b) })).sort((a, b2) => (a.on ? 1 : 0) - (b2.on ? 1 : 0) || busName(a.b).localeCompare(busName(b2.b)));
    const chips = cur.buses.map(b => `<span class="ds-chip" draggable="true" data-bus="${e(b)}">${e(busName(b))}<button type="button" data-act="bus-off" data-bus="${e(b)}" aria-label="Take ${e(busName(b))} off this sheet">×</button></span>`).join('');
    return `${head}
      <div class="ds-field">Buses on this sheet (${cur.buses.length})<div class="ds-chips">${chips || '<small>None yet.</small>'}</div>
        <select data-ch="addBus" aria-label="Add a bus to this sheet"><option value="">Add a bus…</option>${opts.map(x => `<option value="${e(x.b)}">${e(busName(x.b))}${x.on ? ` (on ${x.on})` : ' (not on a sheet)'}</option>`).join('')}</select>
        <small>A bus brings its loads, and its feeders from the breaker down. To move one, drag its chip onto a sheet in the list.</small></div>
      ${tagRows ? `<div class="ds-field">Connectors on this sheet<div class="ds-conns">${tagRows}</div></div>` : ''}
      <label class="ds-chkrow"><input type="checkbox" data-ch="locked" ${cur.locked ? 'checked' : ''}> Keep this sheet as it is when proposing again</label>`;
  },

  // The whole diagram with each sheet's area outlined; buses are clickable
  _diagramSVG(set, P) {
    const NS = 'http://www.w3.org/2000/svg';
    const b = this._base;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${b.minX} ${b.minY} ${b.svgW} ${b.svgH}`);
    svg.setAttribute('class', 'ds-diagram');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'The whole diagram with each sheet outlined');
    if (b.defs) svg.appendChild(b.defs.cloneNode(true));
    const layer = b.layer.cloneNode(true);
    layer.removeAttribute('id'); layer.removeAttribute('transform');
    layer.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    svg.appendChild(layer);
    const curId = this.sel !== 'key' && set.sheets[this.sel] ? set.sheets[this.sel].id : null;
    const u = b.svgW / 900;
    let s = '';
    set.sheets.forEach((sh, i) => {
      const pgs = P.pages.filter(pg => pg.id === sh.id);
      if (!pgs.length) return;
      const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      pgs.forEach(pg => {
        if (pg.window) { bb.x0 = Math.min(bb.x0, pg.window.x0); bb.y0 = Math.min(bb.y0, pg.window.y0); bb.x1 = Math.max(bb.x1, pg.window.x1); bb.y1 = Math.max(bb.y1, pg.window.y1); return; }
        pg.ids.forEach(id => { const c = this._comps.get(id); if (!c) return; bb.x0 = Math.min(bb.x0, c.bbox.x0); bb.y0 = Math.min(bb.y0, c.bbox.y0); bb.x1 = Math.max(bb.x1, c.bbox.x1); bb.y1 = Math.max(bb.y1, c.bbox.y1); });
      });
      if (!isFinite(bb.x0)) return;
      const col = sh.kind === 'view' ? '#6f42c1' : this.COLORS[i % this.COLORS.length];
      const on = sh.id === curId;
      s += `<rect x="${bb.x0 - 6 * u}" y="${bb.y0 - 6 * u}" width="${bb.x1 - bb.x0 + 12 * u}" height="${bb.y1 - bb.y0 + 12 * u}" rx="${6 * u}" fill="${col}" fill-opacity="${Number(on ? 0.12 : sh.kind === 'view' ? 0 : 0.05)}" stroke="${col}" stroke-width="${Number((on ? 2.6 : 1.4) * u)}" stroke-dasharray="${this._esc(sh.kind === 'view' ? `${2 * u} ${3 * u}` : on ? 'none' : `${6 * u} ${4 * u}`)}" pointer-events="none"/>`;
      s += `<rect x="${bb.x0 - 6 * u}" y="${bb.y0 - 6 * u}" width="${28 * u}" height="${18 * u}" rx="${4 * u}" fill="${col}" pointer-events="none"/><text x="${bb.x0 + 8 * u}" y="${bb.y0 + 7 * u}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${11 * u}" font-weight="bold" fill="#ffffff" pointer-events="none">${SheetPrint.sheetNo(pgs[0].no)}</text>`;
    });
    // bus hit areas
    const sheetOfBus = new Map();
    set.sheets.forEach(sh => { if (sh.kind === 'buses') sh.buses.forEach(bu => sheetOfBus.set(bu, sh.id)); });
    this._model.comps.filter(c => c.type === 'bus').forEach(c => {
      const mine = sheetOfBus.get(c.id) === curId && curId;
      const none = !sheetOfBus.has(c.id);
      s += `<rect class="ds-bushit${mine ? ' ds-mine' : ''}${none ? ' ds-none' : ''}" data-bus="${this._esc(c.id)}" x="${Number(c.bbox.x0)}" y="${Number(c.bbox.y0)}" width="${c.bbox.x1 - c.bbox.x0}" height="${Math.max(24 * u, c.bbox.y1 - c.bbox.y0)}" rx="${3 * u}"><title>${this._esc(c.name)}${none ? ' — not on a sheet' : ''}</title></rect>`;
    });
    const g = document.createElementNS(NS, 'g');
    g.innerHTML = s + `<rect id="ds-lasso" x="0" y="0" width="0" height="0" fill="rgba(0,120,215,0.06)" stroke="#0078d7" stroke-width="${1.5 * u}" stroke-dasharray="${5 * u} ${4 * u}" display="none"/>`;
    svg.appendChild(g);
    return svg;
  },

  // ── interaction ───────────────────────────────────────────────
  _closeMenus() {
    let any = false;
    this._el.querySelectorAll('.ds-menu:not([hidden])').forEach(m => { m.hidden = true; any = true; });
    const pop = this._el.querySelector('.ds-pop');
    if (pop) { pop.remove(); any = true; }
    return any;
  },

  _toggleMenu(id) {
    const m = this._el.querySelector('#' + id);
    const was = m && !m.hidden;
    this._closeMenus();
    if (m && !was) { m.hidden = false; const f = m.querySelector('button:not([disabled])'); if (f) f.focus(); }
  },

  _moveBuses(set, buses, toSheetId) {
    const tie = (b) => { const t = (this._plan && this._plan.ties || []).find(x => x.includes(b)); return t || [b]; };
    const all = new Set(buses.flatMap(tie));
    set.sheets.forEach(s => { if (s.kind === 'buses') s.buses = s.buses.filter(b => !all.has(b)); });
    if (toSheetId) { const t = set.sheets.find(s => s.id === toSheetId); if (t) all.forEach(b => t.buses.push(b)); }
    this._dirty();
  },

  async _onClick(e) {
    const set = this.current();
    if (!set) return;
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      if (this._dragged) return;   // the click that ends a box-select
      if (!e.target.closest('.ds-menu, .ds-pop')) this._closeMenus();
      const hit = e.target.closest('.ds-bushit');
      if (hit && !this._dragged) this._clickBus(set, hit.getAttribute('data-bus'));
      return;
    }
    const act = btn.getAttribute('data-act');
    const rerender = () => this.render();
    switch (act) {
      case 'close': this.close(); return;
      case 'pick': { const i = btn.getAttribute('data-i'); this.sel = i === 'key' ? 'key' : +i; this.tab = 'sheet'; rerender(); return; }
      case 'mode': this.mode = btn.getAttribute('data-v'); rerender(); return;
      case 'tab': this.tab = btn.getAttribute('data-v'); rerender(); return;
      case 'tb': set.opts.titleBlock = btn.getAttribute('data-v'); this._dirty(); rerender(); return;
      case 'page-prev': case 'page-next': {
        const P = this._plan;
        const n = this.sel === 'key' ? P.keyPages : P.pages.filter(pg => set.sheets[this.sel] && pg.id === set.sheets[this.sel].id).length;
        const d = act === 'page-next' ? 1 : -1;
        if (this._pageIdx.i + d >= 0 && this._pageIdx.i + d < n) this._pageIdx.i += d;
        else {   // step to the neighbouring sheet
          const order = (set.opts.keyPlan ? ['key'] : []).concat(set.sheets.map((_, i) => i));
          const at = order.indexOf(this.sel);
          const next = order[at + d];
          if (next === undefined) return;
          this.sel = next;
          const m = next === 'key' ? P.keyPages : P.pages.filter(pg => pg.id === set.sheets[next].id).length;
          this._pageIdx = { sel: next, i: d > 0 ? 0 : Math.max(0, m - 1) };
        }
        rerender(); return;
      }
      case 'add-menu': this._toggleMenu('ds-add-menu'); return;
      case 'set-menu': this._toggleMenu('ds-set-menu'); return;
      case 'export-menu': this._toggleMenu('ds-exp-menu'); return;
      case 'propose': {
        const locked = set.sheets.filter(s => s.locked).length;
        if (!(await UI.confirm(`Pack the buses onto sheets again?${locked ? ` The ${locked} sheet${locked > 1 ? 's' : ''} you keep stay as they are.` : ' Sheets you arranged by hand change — tick “Keep this sheet” first to keep one.'}`))) return;
        this.propose(set); this._dirty(); this.sel = Math.min(this.sel === 'key' ? 0 : this.sel, set.sheets.length - 1); rerender(); return;
      }
      case 'add-empty': set.sheets.push({ id: this.uid('sh'), kind: 'buses', buses: [], title: '', dwgNo: '', locked: true }); this.sel = set.sheets.length - 1; this._dirty(); rerender(); return;
      case 'add-selection': {
        const parts = [...AppState.selectedIds].filter(id => this._comps.has(id));
        const name = await UI.prompt('Name for this view', this._selectionName(parts));
        if (name === null) return;
        const v = { id: this.uid('view'), name: name || 'Selection', pageId: this._pageId(), kind: 'parts', parts };
        AppState.sldViews.push(v);
        set.sheets.push({ id: this.uid('sh'), kind: 'view', viewId: v.id, title: '', dwgNo: '' });
        this.sel = set.sheets.length - 1; this._dirty(); rerender(); return;
      }
      case 'add-window': {
        const setId = set.id;
        this.close();
        PrintWindow.start({ onSave: (v) => { const s = AppState.drawingSets.find(x => x.id === setId); if (s) { const sh = { id: this.uid('sh'), kind: 'view', viewId: v.id, title: '', dwgNo: '' }; s.sheets.push(sh); this._dirty(); this.open({ setId, selectSheet: sh.id }); } } });
        return;
      }
      case 'add-view': set.sheets.push({ id: this.uid('sh'), kind: 'view', viewId: btn.getAttribute('data-view'), title: '', dwgNo: '' }); this.sel = set.sheets.length - 1; this._dirty(); rerender(); return;
      case 'assign-unassigned': { const cur = set.sheets[this.sel]; if (cur && cur.kind === 'buses') this._moveBuses(set, this._plan.unassigned, cur.id); rerender(); return; }
      case 'unassigned-new': { const sh = { id: this.uid('sh'), kind: 'buses', buses: [], title: '', dwgNo: '', locked: false }; set.sheets.splice(set.sheets.filter(s => s.kind === 'buses').length, 0, sh); this._moveBuses(set, this._plan.unassigned, sh.id); this.sel = set.sheets.indexOf(sh); rerender(); return; }
      case 'paper-up': set.opts.paper = btn.getAttribute('data-paper'); this._dirty(); rerender(); return;
      case 'portrait': set.opts.landscape = false; this._dirty(); rerender(); return;
      case 'bus-off': { this._moveBuses(set, [btn.getAttribute('data-bus')], null); rerender(); return; }
      case 'sheet-remove': {
        const cur = set.sheets[this.sel];
        if (cur.buses.length && !(await UI.confirm(`Remove this sheet? Its ${cur.buses.length} bus${cur.buses.length > 1 ? 'es go' : ' goes'} onto no sheet until you place ${cur.buses.length > 1 ? 'them' : 'it'}.`))) return;
        set.sheets.splice(this.sel, 1); this.sel = Math.max(0, this.sel - 1); this._dirty(); rerender(); return;
      }
      case 'view-remove': set.sheets.splice(this.sel, 1); this.sel = Math.max(0, this.sel - 1); this._dirty(); rerender(); return;
      case 'view-reselect': {
        const v = this.viewOf(set.sheets[this.sel].viewId);
        if (v) { v.parts = [...AppState.selectedIds].filter(id => this._comps.has(id)); this._dirty(); }
        rerender(); return;
      }
      case 'view-redraw': {
        const v = this.viewOf(set.sheets[this.sel].viewId);
        const setId = set.id, shId = set.sheets[this.sel].id;
        this.close();
        PrintWindow.start({ view: v, onSave: () => this.open({ setId, selectSheet: shId }) });
        return;
      }
      case 'rev-add': {
        const last = set.revisions[set.revisions.length - 1];
        const next = last && /^[A-Y]$/.test(last.rev) ? String.fromCharCode(last.rev.charCodeAt(0) + 1) : last && /^\d+$/.test(last.rev) ? String(+last.rev + 1) : (last ? '' : 'A');
        set.revisions.push({ rev: next, date: new Date().toISOString().slice(0, 10), desc: '', by: '', chk: '' });
        this._dirty(); rerender(); return;
      }
      case 'rev-del': set.revisions.splice(+btn.getAttribute('data-i'), 1); this._dirty(); rerender(); return;
      case 'set-rename': {
        const n = await UI.prompt('Name of this drawing set', set.name);
        if (n) { set.name = n; this._dirty(); }
        rerender(); return;
      }
      case 'set-dup': {
        const copy = JSON.parse(JSON.stringify(set));
        copy.id = this.uid('ds'); copy.name = set.name + ' (copy)';
        copy.sheets.forEach(s => { s.id = this.uid('sh'); });
        AppState.drawingSets.push(copy); this.setId = copy.id; this._dirty(); rerender(); return;
      }
      case 'set-del': {
        if (!(await UI.confirm(`Delete the drawing set “${set.name}”? Its saved views stay in the project.`, { danger: true }))) return;
        AppState.drawingSets.splice(AppState.drawingSets.indexOf(set), 1);
        this._dirty();
        const next = this.setsHere()[0];
        if (!next) { this.close(); return; }
        this.setId = next.id; this.sel = 0; rerender(); return;
      }
      case 'export': case 'export-one': {
        this._closeMenus();
        const P = this._plan;
        if (!P.pages.length && !P.keyPages) return;
        let only = null;
        if (act === 'export-one' && this._shownPage) only = this._shownPage;
        btn.disabled = true;
        try { await this.exportPDF(set, P, only); } catch (err) { console.error(err); Project._statusMsg('Drawing set export failed: ' + err.message); }
        btn.disabled = false;
        return;
      }
      default:
    }
  },

  _selectionName(parts) {
    const buses = parts.map(id => this._comps.get(id)).filter(c => c && c.type === 'bus').map(c => c.name);
    return buses.length ? buses.slice(0, 2).join(' + ') + (buses.length > 2 ? ' …' : '') : 'Selection';
  },

  _clickBus(set, busId) {
    const cur = set.sheets[this.sel];
    if (!cur || cur.kind !== 'buses') { Project._statusMsg('Pick a sheet of buses on the left first.'); return; }
    if (cur.buses.includes(busId)) this._moveBuses(set, [busId], null);
    else this._moveBuses(set, [busId], cur.id);
    this.render();
  },

  _onChange(e) {
    const set = this.current();
    if (!set) return;
    const t = e.target;
    const ch = t.getAttribute('data-ch');
    const cur = this.sel === 'key' ? null : set.sheets[this.sel];
    if (t.hasAttribute('data-rev')) { const r = set.revisions[+t.getAttribute('data-rev')]; if (r) r[t.getAttribute('data-k')] = t.value; this._dirty(); this.render(); return; }
    if (t.hasAttribute('data-win') && cur && cur.kind === 'view') {
      const v = this.viewOf(cur.viewId);
      if (v && v.window) { v.window[t.getAttribute('data-win')] = +t.value || 0; if (v.window.w < 20) v.window.w = 20; if (v.window.h < 20) v.window.h = 20; this._dirty(); this.render(); }
      return;
    }
    switch (ch) {
      case 'set':
        if (t.value === '__new') {
          UI.prompt('Name of the new drawing set', 'Drawing set ' + (this.setsHere().length + 1)).then(n => {
            if (n) { const s = this.newSet(n); this.setId = s.id; this.sel = 0; }
            this.render();
          });
          return;
        }
        this.setId = t.value; this.sel = 0; this._sync(this.current()); break;
      case 'paper': { const [p, l] = t.value.split('-'); set.opts.paper = p; set.opts.landscape = l === 'l'; break; }
      case 'scale': set.opts.scale = t.value; break;
      case 'keyPlan': set.opts.keyPlan = t.checked; if (!t.checked && this.sel === 'key') this.sel = 0; break;
      case 'name': set.name = t.value.trim() || set.name; break;
      case 'numbering': set.opts.numbering = t.value; break;
      case 'minPt': set.opts.minPt = Math.min(14, Math.max(4, +t.value || 8)); break;
      case 'maxBuses': set.opts.maxBuses = Math.max(1, Math.round(+t.value) || 6); break;
      case 'oversize': set.opts.oversize = t.value; break;
      case 'cut': set.opts.cut = t.value; break;
      case 'status': set.opts.status = t.value; break;
      case 'title': if (cur) cur.title = t.value.trim(); break;
      case 'dwgNo': if (cur) cur.dwgNo = t.value.trim(); break;
      case 'locked': if (cur) cur.locked = t.checked; break;
      case 'viewName': { const v = cur && this.viewOf(cur.viewId); if (v) v.name = t.value.trim() || v.name; break; }
      case 'addBus': if (cur && t.value) this._moveBuses(set, [t.value], cur.id); break;
      default: return;
    }
    this._dirty();
    this.render();
  },

  _onDragStart(e) {
    const chip = e.target.closest('.ds-chip');
    if (chip) { e.dataTransfer.setData('text/x-ds-bus', chip.getAttribute('data-bus')); e.dataTransfer.effectAllowed = 'move'; return; }
    const card = e.target.closest('.ds-card[data-i]');
    if (card && card.getAttribute('data-i') !== 'key') { e.dataTransfer.setData('text/x-ds-sheet', card.getAttribute('data-i')); e.dataTransfer.effectAllowed = 'move'; }
  },

  _onDrop(e) {
    const set = this.current();
    const target = e.target.closest('[data-drop]');
    if (!set || !target) return;
    e.preventDefault();
    target.classList.remove('ds-over');
    const i = target.getAttribute('data-i');
    if (i === 'key') return;
    const to = set.sheets[+i];
    const bus = e.dataTransfer.getData('text/x-ds-bus');
    if (bus) {
      if (to.kind !== 'buses') { Project._statusMsg('Buses go on bus sheets, not on views.'); return; }
      this._moveBuses(set, [bus], to.id); this.render(); return;
    }
    const from = e.dataTransfer.getData('text/x-ds-sheet');
    if (from !== '' && from !== null && +from !== +i) {
      const curId = this.sel === 'key' ? null : set.sheets[this.sel] && set.sheets[this.sel].id;
      const [moved] = set.sheets.splice(+from, 1);
      set.sheets.splice(+i, 0, moved);
      if (curId) this.sel = set.sheets.findIndex(s => s.id === curId);
      this._dirty(); this.render();
    }
  },

  // box-select buses on the whole diagram
  _onStageDown(e) {
    const svg = e.target.closest && e.target.closest('.ds-diagram');
    this._dragged = false;
    if (!svg || e.button !== 0) return;
    const pt = (ev) => { const m = svg.getScreenCTM().inverse(); const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(m); };
    const a = pt(e);
    const lasso = svg.querySelector('#ds-lasso');
    const move = (ev) => {
      const b = pt(ev);
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 6) return;
      this._dragged = true;
      lasso.setAttribute('display', 'inline');
      lasso.setAttribute('x', Math.min(a.x, b.x)); lasso.setAttribute('y', Math.min(a.y, b.y));
      lasso.setAttribute('width', Math.abs(b.x - a.x)); lasso.setAttribute('height', Math.abs(b.y - a.y));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!this._dragged) return;
      const b = pt(ev);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const hits = this._model.comps.filter(c => c.type === 'bus' && c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1).map(c => c.id);
      if (!hits.length) { lasso.setAttribute('display', 'none'); return; }
      this._lassoMenu(hits, ev.clientX, ev.clientY);
      setTimeout(() => { this._dragged = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },

  _lassoMenu(buses, cx, cy) {
    const set = this.current();
    const P = this._plan;
    const e = this._esc;
    const opts = set.sheets.map((s, i) => ({ s, i, pg: P.pages.find(p => p.id === s.id) })).filter(x => x.s.kind === 'buses');
    const pop = document.createElement('div');
    pop.className = 'ds-pop';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `<span>Move ${buses.length} bus${buses.length > 1 ? 'es' : ''} to</span>${opts.map(x => `<button type="button" role="menuitem" data-to="${e(x.s.id)}" title="${e(x.s.title || (x.pg && x.pg.title) || '')}">${x.pg ? SheetPrint.sheetNo(x.pg.no) : '–'}</button>`).join('')}<button type="button" role="menuitem" class="ds-primary" data-to="__new">New sheet</button>`;
    const box = this._el.getBoundingClientRect();
    pop.style.left = `${Math.min(cx - box.left, box.width - 360)}px`;
    pop.style.top = `${cy - box.top + 10}px`;
    this._el.appendChild(pop);
    pop.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-to]');
      if (!b) return;
      ev.stopPropagation();
      let to = b.getAttribute('data-to');
      if (to === '__new') { const sh = { id: this.uid('sh'), kind: 'buses', buses: [], title: '', dwgNo: '', locked: true }; set.sheets.splice(set.sheets.filter(s => s.kind === 'buses').length, 0, sh); to = sh.id; this.sel = set.sheets.indexOf(sh); }
      this._moveBuses(set, buses, to);
      // a sheet arranged by hand is kept by "Propose again"
      set.sheets.forEach(s => { if (s.id === to) s.locked = true; });
      this.render();
    });
    const f = pop.querySelector('button'); if (f) f.focus();
  },

  _biggerPaper(set) {
    const i = SheetPrint.PAPER_ORDER.indexOf(set.opts.paper);
    if (i < 0 || i >= SheetPrint.PAPER_ORDER.length - 1) return null;
    return SheetPrint.fitPaper(this._model, Object.assign({}, set.opts, { sheets: this._sheetsForPlan(set), paper: SheetPrint.PAPER_ORDER[i + 1] }));
  },

  async exportPDF(set, P, only) {
    const info = this.info(set, P);
    if (only) {
      // one page, numbered as in the set
      const { jsPDF } = window.jspdf || {};
      await VectorPDF.ensure();
      const doc = new jsPDF({ orientation: P.landscape ? 'landscape' : 'portrait', unit: 'mm', format: P.paper });
      VectorPDF.registerFonts(doc);
      const svg = only.key !== undefined ? SheetPrint.keyPageSVG(P, this._base, info, only.key) : SheetPrint.pageSVG(P, only.pg, this._base, info, 'x');
      await VectorPDF.draw(doc, svg, P.layout.pw, P.layout.ph);
      const no = only.key !== undefined ? only.key + 1 : only.pg.no;
      doc.save(`${(AppState.projectName || 'diagram').replace(/[^\w-]+/g, '_')}_${set.name.replace(/[^\w-]+/g, '_')}_sheet${SheetPrint.sheetNo(no)}.pdf`);
      Project._statusMsg(`Exported sheet ${SheetPrint.sheetNo(no)} as PDF.`);
      return;
    }
    await SheetPrint.exportPDF(P, info, `${(AppState.projectName || 'diagram').replace(/[^\w-]+/g, '_')}_${set.name.replace(/[^\w-]+/g, '_')}.pdf`);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = DrawingSet;
