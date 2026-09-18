/* ProtectionPro — Rate library (prices for the Bill of quantities).
 *
 * Every item the app can count has a fixed Key (CBL-95-AL-XLPE-LV,
 * MCB-1P-20C, CIV-TRENCH-LV-SL …) generated from the cable libraries, the
 * element registry and the device ratings. The catalogue is rebuilt from
 * those sources each time, so only what the user set is stored, with the
 * project, in AppState.rateLibrary:
 *
 *   { currency, defaultWaste, updatedAt,
 *     items:  { KEY: { rate, waste, supplier } },   // rate null/absent = no rate
 *     custom: { KEY: { desc, unit, cat } } }        // items added by an import
 *
 * Round trip with Excel: Export (CSV / XLSX) → edit Rate, Waste % or Supplier
 * code → Import. Rows match on Key only; Description / Unit in the file are
 * ignored for known keys, so a reworded cell can't corrupt the library. The
 * import shows every change before it is applied, and can be undone.
 *
 * An item without a rate is never priced at 0 — the BOQ lists it, leaves it
 * out of the total and says so (boq.js).
 */

const Rates = {
  CATS: [
    { id: 'cable', label: 'Cables' },
    { id: 'equip', label: 'Equipment' },
    { id: 'prot', label: 'Protective devices' },
    { id: 'civil', label: 'Civils & labour' },
  ],
  MCB_POLES: ['1P', '2P', '3P', '4P'],
  MCB_RATINGS: [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125],
  MCB_CURVES: ['B', 'C', 'D'],
  // Board enclosures by single-pole module count (a 3P breaker takes 3).
  DB_SIZES: [4, 6, 8, 12, 16, 18, 24, 36, 48, 72, 96],
  DEFAULT_KEY: 'protectionpro-default-rates',

  tab: 'cable',
  filter: 'all',
  query: '',
  _undo: null,          // { lib, label } — one step, for an import or a load

  // ── Keys ────────────────────────────────────────────────────────────
  slug(s) {
    return String(s == null ? '' : s).toUpperCase()
      .replace(/MM²|MM2/g, '').replace(/²/g, '').replace(/\+/g, '')
      .replace(/[^A-Z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  },
  cableKey(name) { return 'CBL-' + this.slug(name); },
  mcbKey(poles, a, curve) { return `MCB-${poles}-${a}${curve || 'C'}`; },
  elKey(poles, ma) { return `ELU-${poles}-${ma}MA`; },
  boardSize(modules) { return this.DB_SIZES.find(n => n >= modules) || this.DB_SIZES[this.DB_SIZES.length - 1]; },
  dbKey(modules) { return `EQ-DB-${this.boardSize(modules)}W`; },
  trenchKey(t) { return 'CIV-TRENCH-' + this.slug(t); },
  crossingKey(size) { return 'CIV-XING-' + this.slug(size || '110'); },
  routeKey(type) { return (['conduit', 'cable_tray'].includes(type) ? 'CNT-' : 'CBL-ROUTE-') + this.slug(type); },
  accKey(kind) { return 'ACC-' + this.slug(kind); },

  // Final-circuit cable of a DB way: the building library's T+E (1P/2P) or
  // 4-core SWA (3P/4P) of that size, else a generic Cu final-circuit item.
  fcCable(size, poles) {
    const s = Number(size);
    const three = /^[34]P$/.test(String(poles || ''));
    const lib = (typeof BUILDING_CABLES !== 'undefined') ? BUILDING_CABLES : [];
    const hit = lib.find(c => Number(c.size) === s && (three ? /x4C .*SWA/.test(c.name) : /T\+E/.test(c.name)));
    if (hit) return { key: this.cableKey(hit.name), desc: hit.name };
    const cores = three ? '4c' : '2c';
    return { key: `CBL-FC-${this.slug(String(s))}-${cores.toUpperCase()}`, desc: `${s}mm² ${cores}+E Cu final-circuit cable` };
  },

  // Protective devices on the single-line diagram.
  cbItem(p) {
    const std = (typeof STANDARD_CBS !== 'undefined') && p.standard_type && STANDARD_CBS.find(c => c.id === p.standard_type);
    if (std) return { key: 'CB-' + this.slug(std.id), desc: std.name };
    const t = String(p.cb_type || 'cb').toUpperCase(), a = Number(p.trip_rating_a || p.rated_current_a) || 0;
    return { key: `CB-${this.slug(t)}-${a}A`, desc: `${t} circuit breaker ${a} A` };
  },
  fuseItem(p) {
    const std = (typeof STANDARD_FUSES !== 'undefined') && p.standard_type && STANDARD_FUSES.find(c => c.id === p.standard_type);
    if (std) return { key: 'FUSE-' + this.slug(std.id), desc: std.name + ' fuse' };
    const t = p.fuse_type || 'gG', a = Number(p.rated_current_a) || 0;
    return { key: `FUSE-${this.slug(t)}-${a}A`, desc: `${t} fuse ${a} A` };
  },
  txItem(p) {
    const std = (typeof STANDARD_TRANSFORMERS !== 'undefined') && p.standard_type && STANDARD_TRANSFORMERS.find(c => c.id === p.standard_type);
    if (std) return { key: 'TX-' + this.slug(std.name), desc: 'Transformer ' + std.name };
    const kva = Math.round((Number(p.rated_mva) || 0) * 1000);
    return { key: `TX-${kva}KVA`, desc: `Transformer ${kva} kVA` };
  },

  // A plan element → its rate item (null = not a priced item: erven, and
  // plant the single-line diagram already counts).
  PLAN_SKIP: ['erf', 'bd_utility', 'bd_transformer', 'bd_generator', 'bd_db', 'bd_switchboard', 'minisub', 'kiosk'],
  planElementItem(el) {
    if (!el || this.PLAN_SKIP.includes(el.type)) return null;
    const def = (typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.element(el.type)) || null;
    const base = el.type.replace(/^bd_/, '');
    const name = def ? def.name : el.type;
    const opt = (key, v) => {
      const f = def && (def.fields || []).find(x => x.key === key);
      const o = f && (f.options || []).find(x => (x.value ?? x) === v);
      return o ? (o.label ?? o) : v;
    };
    if (el.type === 'bd_light') {
      const k = el.kind || 'ceiling';
      return { key: 'EQ-LIGHT-' + this.slug(k), desc: `Light fitting — ${opt('kind', k)}` };
    }
    if (el.type === 'bd_socket') {
      const k = el.outlets || 'double';
      return { key: 'EQ-SOCKET-' + this.slug(k) + (el.weatherproof ? '-WP' : ''), desc: `Socket outlet — ${opt('outlets', k)}${el.weatherproof ? ', weatherproof' : ''}` };
    }
    if (el.type === 'bd_switch') {
      const g = el.gangs || '1', k = el.kind || 'standard';
      return { key: `EQ-SWITCH-${g}G-${this.slug(k)}`, desc: `Switch ${g} gang — ${opt('kind', k)}` };
    }
    return { key: 'EQ-' + this.slug(base), desc: name };
  },

  // ── Catalogue: every item the app knows ────────────────────────────
  catalogue() {
    const out = [], seen = new Set();
    const add = (key, desc, unit, cat) => { if (!seen.has(key)) { seen.add(key); out.push({ key, desc, unit, cat }); } };
    // Cables
    for (const c of (typeof STANDARD_CABLES !== 'undefined' ? STANDARD_CABLES : [])) add(this.cableKey(c.name), c.name, 'm', 'cable');
    for (const c of (typeof BUILDING_CABLES !== 'undefined' ? BUILDING_CABLES : [])) add(this.cableKey(c.name), c.name, 'm', 'cable');
    for (const c of (typeof STANDARD_OVERHEAD_LINES !== 'undefined' ? STANDARD_OVERHEAD_LINES : [])) add('OHL-' + this.slug(c.name), c.name + ' overhead conductor', 'm', 'cable');
    if (typeof PLAN_DEFS !== 'undefined') {
      for (const [t, d] of Object.entries(PLAN_DEFS.routes || {})) {
        const k = this.routeKey(t);
        add(k, d.name + (k.startsWith('CNT-') ? '' : (d.fields || []).some(f => f.key === 'cableType') ? ' — cable type not set' : ''), 'm', k.startsWith('CNT-') ? 'civil' : 'cable');
      }
    }
    add('CBL-ROUTE-RISER', 'Riser cable — vertical run (cable type not set)', 'm', 'cable');
    add('CBL-UNTYPED', 'Single-line cable with no library type', 'm', 'cable');
    // Equipment
    add('EQ-MINISUB', 'Miniature substation', 'ea', 'equip');
    add('EQ-KIOSK', 'LV distribution kiosk', 'ea', 'equip');
    for (const t of (typeof STANDARD_TRANSFORMERS !== 'undefined' ? STANDARD_TRANSFORMERS : [])) add('TX-' + this.slug(t.name), 'Transformer ' + t.name, 'ea', 'equip');
    for (const n of this.DB_SIZES) add(`EQ-DB-${n}W`, `Distribution board enclosure, ${n} ways`, 'ea', 'equip');
    add('EQ-DB', 'Distribution board (size not scheduled)', 'ea', 'equip');
    add('EQ-SWITCHBOARD', 'Switchboard', 'ea', 'equip');
    add('EQ-CAPACITOR-BANK', 'Capacitor bank', 'ea', 'equip');
    add('EQ-SURGE-ARRESTER', 'Surge arrester', 'ea', 'equip');
    add('EQ-CT', 'Current transformer', 'ea', 'equip');
    add('EQ-VT', 'Voltage transformer', 'ea', 'equip');
    add('EQ-RELAY', 'Protection relay', 'ea', 'equip');
    if (typeof PLAN_DEFS !== 'undefined') {
      for (const [t, d] of Object.entries(PLAN_DEFS.elements || {})) {
        if (this.PLAN_SKIP.includes(t)) continue;
        const f = k => (d.fields || []).find(x => x.key === k);
        const vals = k => (f(k) ? f(k).options.map(o => o.value ?? o) : []);
        if (t === 'bd_light') vals('kind').forEach(k => { const it = this.planElementItem({ type: t, kind: k }); add(it.key, it.desc, 'ea', 'equip'); });
        else if (t === 'bd_socket') vals('outlets').forEach(k => [false, true].forEach(wp => { const it = this.planElementItem({ type: t, outlets: k, weatherproof: wp }); add(it.key, it.desc, 'ea', 'equip'); }));
        else if (t === 'bd_switch') vals('gangs').forEach(g => vals('kind').forEach(k => { const it = this.planElementItem({ type: t, gangs: g, kind: k }); add(it.key, it.desc, 'ea', 'equip'); }));
        else { const it = this.planElementItem({ type: t }); add(it.key, it.desc, 'ea', 'equip'); }
      }
    }
    // Protective devices
    for (const p of this.MCB_POLES) for (const a of this.MCB_RATINGS) for (const c of this.MCB_CURVES) {
      add(this.mcbKey(p, a, c), `MCB ${p} ${a} A curve ${c}`, 'ea', 'prot');
    }
    for (const p of ['2P', '4P']) for (const ma of (typeof DB_EL_RATINGS_MA !== 'undefined' ? DB_EL_RATINGS_MA : [30])) {
      add(this.elKey(p, ma), `Earth leakage unit ${p}, ${ma} mA`, 'ea', 'prot');
    }
    for (const c of (typeof STANDARD_CBS !== 'undefined' ? STANDARD_CBS : [])) add('CB-' + this.slug(c.id), c.name, 'ea', 'prot');
    for (const f of (typeof STANDARD_FUSES !== 'undefined' ? STANDARD_FUSES : [])) add('FUSE-' + this.slug(f.id), f.name + ' fuse', 'ea', 'prot');
    for (const k of (typeof DB_ACCESSORY_KINDS !== 'undefined' ? DB_ACCESSORY_KINDS : [])) add(this.accKey(k.key), k.label, 'ea', 'prot');
    // Civils & labour
    if (typeof PLAN_DEFS !== 'undefined') {
      for (const [t, d] of Object.entries(PLAN_DEFS.trenchTypes || {})) add(this.trenchKey(t), `${d.name} (${d.width} m wide × ${d.depth} m deep)`, 'm', 'civil');
      for (const s of ((PLAN_DEFS.crossings || {}).sizes || [])) add(this.crossingKey(s), `Road crossing, ${s} mm sleeve`, 'ea', 'civil');
    }
    add('LAB-TERM-LV', 'LV cable termination (per cable end)', 'ea', 'civil');
    add('LAB-TERM-MV', 'MV cable termination (per cable end)', 'ea', 'civil');
    add('LAB-JB-SPLICE', 'Junction-box splice (per core joined)', 'ea', 'civil');
    add('LAB-JB-TERM', 'Junction-box cable termination', 'ea', 'civil');
    return out;
  },

  guessCat(key) {
    const k = String(key || '');
    if (/^(CBL|OHL)-/.test(k)) return 'cable';
    if (/^(MCB|ELU|CB|FUSE|ACC|SW)-/.test(k)) return 'prot';
    if (/^(CIV|LAB|CNT)-/.test(k)) return 'civil';
    return 'equip';
  },

  // ── Store ──────────────────────────────────────────────────────────
  lib() {
    let L = AppState.rateLibrary;
    if (!L || typeof L !== 'object') L = AppState.rateLibrary = {};
    if (!L.items || typeof L.items !== 'object') L.items = {};
    if (!L.custom || typeof L.custom !== 'object') L.custom = {};
    if (L.currency == null) L.currency = 'R';
    if (!(Number(L.defaultWaste) >= 0)) L.defaultWaste = 5;
    return L;
  },
  currency() { return (AppState.rateLibrary && AppState.rateLibrary.currency) || 'R'; },
  defaultWaste(cat) { return cat === 'cable' ? Number(this.lib().defaultWaste) || 0 : 0; },

  // { rate: number|null, waste: number, supplier: string }
  get(key, cat) {
    const L = AppState.rateLibrary;
    const it = (L && L.items && L.items[key]) || {};
    const c = cat || (L && L.custom && L.custom[key] && L.custom[key].cat) || this.guessCat(key);
    const rate = (it.rate === null || it.rate === undefined || it.rate === '' || isNaN(Number(it.rate))) ? null : Number(it.rate);
    const waste = (it.waste === null || it.waste === undefined || it.waste === '') ? this.defaultWaste(c) : Number(it.waste) || 0;
    return { rate, waste, supplier: it.supplier || '' };
  },

  _touch() {
    const L = this.lib();
    L.updatedAt = new Date().toISOString();
    AppState.dirty = true;
  },
  _prune(key) {
    const L = this.lib(), it = L.items[key];
    if (it && (it.rate == null) && (it.waste == null) && !it.supplier) delete L.items[key];
  },
  // field: 'rate' | 'waste' | 'supplier'; value already cleaned (number|null|string)
  set(key, field, value) {
    const L = this.lib();
    const it = L.items[key] || (L.items[key] = {});
    if (field === 'supplier') { if (value) it.supplier = String(value); else delete it.supplier; }
    else if (value === null || value === undefined || value === '') delete it[field];
    else it[field] = Number(value);
    this._prune(key);
    this._touch();
  },

  // Keys the current project uses (from the BOQ's quantity take-off).
  usedLines() {
    if (typeof BOQ === 'undefined' || !BOQ.collect) return [];
    try { return BOQ.collect().lines; } catch (e) { console.warn('BOQ take-off failed', e); return []; }
  },

  // Catalogue ∪ imported items ∪ items the project uses ∪ stored orphans.
  rows(used) {
    const L = this.lib();
    const map = new Map();
    for (const c of this.catalogue()) map.set(c.key, c);
    for (const [k, c] of Object.entries(L.custom)) if (!map.has(k)) map.set(k, { key: k, desc: c.desc || k, unit: c.unit || 'ea', cat: c.cat || this.guessCat(k), custom: true });
    for (const l of used || []) if (!map.has(l.key)) map.set(l.key, { key: l.key, desc: l.desc, unit: l.unit, cat: l.cat || this.guessCat(l.key) });
    for (const k of Object.keys(L.items)) if (!map.has(k)) map.set(k, { key: k, desc: 'Not in the library any more', unit: '', cat: this.guessCat(k), orphan: true });
    const usedSet = new Set((used || []).map(l => l.key));
    return [...map.values()].map(r => Object.assign(r, { used: usedSet.has(r.key) }));
  },

  // ── Formatting ─────────────────────────────────────────────────────
  _group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); },
  num2(v) {
    if (v == null || isNaN(v)) return '';
    const [i, d] = Math.abs(v).toFixed(2).split('.');
    return (v < 0 ? '-' : '') + this._group(i) + '.' + d;
  },
  money(v) { return v == null || isNaN(v) ? '—' : `${this.currency()} ${this.num2(v)}`; },
  _rateText(v) { return v == null ? '' : Number(v).toFixed(2); },

  // ── Dialog ─────────────────────────────────────────────────────────
  open(opts = {}) {
    if (opts.tab) this.tab = opts.tab;
    if (opts.filter) this.filter = opts.filter;
    this._onDone = opts.onDone || null;
    this._ensureDom();
    this._used = this.usedLines();
    this.lib();
    this.render();
    const m = document.getElementById('rates-modal');
    m.style.display = 'flex';
    setTimeout(() => { const f = m.querySelector('#rt-rows [data-f="rate"]'); if (f) f.focus(); }, 30);
  },
  close() {
    const m = document.getElementById('rates-modal');
    if (m) m.style.display = 'none';
    const cb = this._onDone; this._onDone = null;
    if (cb) cb();
  },

  _icon(p, s = 16) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  },

  _ensureDom() {
    if (document.getElementById('rates-modal')) return;
    const I_RATE = this._icon('<path d="M8 2v12M11 4.5c0-1.2-1.3-2-3-2s-3 .8-3 2 1.3 1.8 3 2.2 3 1 3 2.3-1.3 2-3 2-3-.8-3-2"/>', 18);
    const I_DOWN = this._icon('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"/>', 14);
    const I_UP = this._icon('<path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M3 13h10"/>', 14);
    const I_SEARCH = this._icon('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>', 14);
    const m = document.createElement('div');
    m.id = 'rates-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'rt-title');
    m.style.display = 'none';
    m.innerHTML = `
    <div class="modal-content rt-dialog">
      <header class="rt-head">
        <span class="rt-mark">${I_RATE}</span>
        <div class="rt-head-text"><h3 id="rt-title">Rate library</h3><div class="rt-head-sub">Rates used by the Bill of quantities · stored with this project</div></div>
        <span class="rt-tag" id="rt-tag-cur"></span><span class="rt-tag" id="rt-tag-date"></span>
        <button class="modal-close" data-rt="close" aria-label="Close">&times;</button>
      </header>
      <main class="rt-main">
        <div class="rt-banner" id="rt-banner" hidden></div>
        <div class="rt-bar"><div class="rt-tabs" role="tablist" aria-label="Rate categories" id="rt-tabs"></div></div>
        <div class="rt-bar">
          <label class="rt-search">${I_SEARCH}<input type="text" id="rt-q" placeholder="Filter by name or key…" aria-label="Filter rates"></label>
          <div class="rt-seg" role="group" aria-label="Show" id="rt-seg"></div>
          <span class="rt-grow"></span>
          <button type="button" class="rt-btn" data-rt="csv">${I_DOWN}Export CSV</button>
          <button type="button" class="rt-btn" data-rt="xlsx">${I_DOWN}Export Excel</button>
          <button type="button" class="rt-btn primary" data-rt="import">${I_UP}Import CSV / Excel…</button>
          <input type="file" id="rt-file" accept=".csv,.xlsx,.xls" hidden>
        </div>
        <div class="rt-tablewrap">
          <table class="rt-tbl" aria-label="Rates"><thead><tr>
            <th class="rt-c-key">Key</th><th>Description</th><th class="rt-c-unit">Unit</th>
            <th class="rt-c-rate rt-num" id="rt-th-rate">Rate</th><th class="rt-c-waste rt-num">Waste %</th>
            <th class="rt-c-sup">Supplier code</th><th class="rt-c-st">Status</th></tr></thead>
            <tbody id="rt-rows"></tbody></table>
          <div class="rt-empty" id="rt-empty" hidden></div>
        </div>
        <div class="rt-stat" id="rt-stat"></div>
        <div class="rt-note"><b>Editing in Excel:</b> Export, change <b>Rate</b>, <b>Waste %</b> or <b>Supplier code</b>, and import the file back. Rows are matched on <b>Key</b>, which never changes, so keep that column as it is. New keys with a description become new items. You see every change before it is applied.</div>
      </main>
      <footer class="rt-foot">
        <button type="button" class="rt-btn" data-rt="load-default">Load my default rates</button>
        <button type="button" class="rt-btn" data-rt="save-default">Save as my default</button>
        <label class="rt-foot-f">Currency <input type="text" id="rt-cur" maxlength="6" aria-label="Currency symbol"></label>
        <label class="rt-foot-f">Default waste % for cables <input type="text" inputmode="decimal" id="rt-dwaste" aria-label="Default waste percent for cable items"></label>
        <span class="rt-grow"></span>
        <button type="button" class="rt-btn primary" data-rt="close">Done</button>
      </footer>
    </div>`;
    document.body.appendChild(m);

    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rt]');
      if (!b) { if (e.target === m) this.close(); return; }
      const a = b.dataset.rt;
      if (a === 'close') this.close();
      else if (a === 'csv') this.exportFile('csv');
      else if (a === 'xlsx') this.exportFile('xlsx');
      else if (a === 'import') m.querySelector('#rt-file').click();
      else if (a === 'save-default') this.saveDefault();
      else if (a === 'load-default') this.loadDefault();
      else if (a === 'undo') this.undo();
      else if (a === 'tab') { this.tab = b.dataset.v; this.render(); }
      else if (a === 'filter') { this.filter = b.dataset.v; this.render(); }
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.closest('#rt-rows')) { e.stopPropagation(); this.close(); }
    });
    m.querySelector('#rt-q').addEventListener('input', (e) => { this.query = e.target.value; this.renderRows(); });
    m.querySelector('#rt-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.importFile(f);
    });
    m.querySelector('#rt-cur').addEventListener('change', (e) => {
      this.lib().currency = e.target.value.trim() || 'R';
      this._touch(); this.render();
    });
    m.querySelector('#rt-dwaste').addEventListener('change', (e) => {
      const n = GridTable.cleanNumber(e.target.value);
      if (isNaN(n) || n < 0) { e.target.value = this.lib().defaultWaste; UI.toast('Enter the default waste as a number, e.g. 5.', 'warning'); return; }
      this.lib().defaultWaste = n;
      this._touch(); this.render();
    });
    // Cell edits (typed, pasted, filled) arrive as 'change' from the grid.
    m.querySelector('#rt-rows').addEventListener('change', (e) => this._onCellChange(e));
  },

  _onCellChange(e) {
    const el = e.target;
    const tr = el.closest('tr[data-key]');
    if (!tr) return;
    const key = tr.dataset.key, f = el.dataset.f;
    const raw = el.value.trim();
    if (f === 'supplier') { this.set(key, 'supplier', raw); return; }
    if (raw === '') { this.set(key, f, null); }
    else {
      const n = GridTable.cleanNumber(raw);
      if (isNaN(n) || n < 0) {
        const cur = this.get(key, tr.dataset.cat);
        el.value = f === 'rate' ? this._rateText(cur.rate) : String(cur.waste);
        GridTable._flagBad(el, `“${raw}” is not a number. The previous value was kept.`);
        return;
      }
      this.set(key, f, n);
      el.value = f === 'rate' ? this._rateText(n) : String(n);
    }
    if (f === 'rate') {
      const row = (this._rows || []).find(x => x.key === key);
      tr.querySelector('td[data-td="rate"]').classList.toggle('rt-nr', this.get(key).rate == null && !!(row && row.used));
      this._renderCounts();
    }
    this._renderHeadTags();
  },

  _visible(rows) {
    const q = this.query.trim().toLowerCase();
    // Items this project uses first, then the catalogue order.
    return rows.filter(r => r.cat === this.tab).sort((a, b) => (b.used ? 1 : 0) - (a.used ? 1 : 0))
      // "No rate" = what the BOQ would miss: items this project uses without a rate.
      .filter(r => this.filter === 'all' || (this.filter === 'used' && r.used)
        || (this.filter === 'norate' && r.used && this.get(r.key, r.cat).rate == null))
      .filter(r => !q || r.key.toLowerCase().includes(q) || String(r.desc).toLowerCase().includes(q));
  },

  render() {
    const m = document.getElementById('rates-modal');
    if (!m) return;
    this._rows = this.rows(this._used);
    const L = this.lib();
    m.querySelector('#rt-cur').value = L.currency;
    m.querySelector('#rt-dwaste').value = L.defaultWaste;
    m.querySelector('#rt-q').value = this.query;
    m.querySelector('#rt-th-rate').textContent = `Rate (${L.currency})`;
    m.querySelector('#rt-tabs').innerHTML = this.CATS.map(c => {
      const n = this._rows.filter(r => r.cat === c.id).length;
      const on = c.id === this.tab;
      return `<button type="button" class="rt-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-rt="tab" data-v="${c.id}">${escHtml(c.label)} <span class="rt-n">${n}</span></button>`;
    }).join('');
    this._renderHeadTags();
    this._renderCounts();
    this._renderBanner();
    this.renderRows();
  },

  _renderHeadTags() {
    const m = document.getElementById('rates-modal');
    if (!m) return;
    const L = this.lib();
    m.querySelector('#rt-tag-cur').textContent = `Currency: ${L.currency}`;
    const d = L.updatedAt ? new Date(L.updatedAt) : null;
    m.querySelector('#rt-tag-date').textContent = d ? `Rates as at ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No rates entered yet';
  },

  _renderCounts() {
    const m = document.getElementById('rates-modal');
    if (!m || !this._rows) return;
    const inTab = this._rows.filter(r => r.cat === this.tab);
    const usedN = inTab.filter(r => r.used).length;
    // "No rate" counts what the BOQ will miss: used items without a rate.
    const noRate = inTab.filter(r => r.used && this.get(r.key, r.cat).rate == null).length;
    const seg = [
      ['all', 'All', ''],
      ['used', 'In this project', ` <span class="rt-n">${usedN}</span>`],
      ['norate', 'No rate', noRate ? ` <span class="rt-amb">(${noRate})</span>` : ''],
    ];
    m.querySelector('#rt-seg').innerHTML = seg.map(([v, l, x]) =>
      `<button type="button" class="rt-sg${this.filter === v ? ' on' : ''}" aria-pressed="${this.filter === v}" data-rt="filter" data-v="${v}" ${v === 'norate' ? 'title="Items this project uses that have no rate"' : ''}>${l}${x}</button>`).join('');
  },

  _renderBanner() {
    const b = document.getElementById('rt-banner');
    if (!b) return;
    const L = this.lib();
    if (this._undo) {
      b.hidden = false;
      b.className = 'rt-banner ok';
      b.innerHTML = `<span>${escHtml(this._undo.label)}</span><button type="button" class="rt-lk" data-rt="undo">Undo</button>`;
    } else if (!Object.keys(L.items).length && this._readDefault()) {
      b.hidden = false;
      b.className = 'rt-banner';
      b.innerHTML = `<span>This project has no rates yet. You have saved default rates.</span><button type="button" class="rt-lk" data-rt="load-default">Load my default rates</button>`;
    } else b.hidden = true;
  },

  renderRows() {
    const m = document.getElementById('rates-modal');
    if (!m) return;
    const tbody = m.querySelector('#rt-rows');
    const vis = this._visible(this._rows || []);
    const pill = (r) => r.orphan ? '<span class="rt-pill gry" title="Stored with the project, but no library item has this key any more">Not in library</span>'
      : r.used ? '<span class="rt-pill ok">In this project</span>'
      : r.custom ? '<span class="rt-pill blue" title="Added by an import">Added</span>'
      : '<span class="rt-pill gry">Not used</span>';
    tbody.innerHTML = vis.map(r => {
      const v = this.get(r.key, r.cat);
      const d = escHtml(r.desc);
      return `<tr data-key="${escHtml(r.key)}" data-cat="${r.cat}">
        <td class="rt-ro rt-code">${escHtml(r.key)}</td><td class="rt-ro">${d}</td><td class="rt-ro">${escHtml(r.unit || '')}</td>
        <td data-td="rate" class="${v.rate == null && r.used ? 'rt-nr' : ''}"><input class="rt-gc rt-num" data-f="rate" inputmode="decimal" value="${this._rateText(v.rate)}" placeholder="No rate" aria-label="Rate for ${d}"></td>
        <td><input class="rt-gc rt-num" data-f="waste" inputmode="decimal" value="${v.waste}" aria-label="Waste % for ${d}"></td>
        <td><input class="rt-gc" data-f="supplier" value="${escHtml(v.supplier)}" aria-label="Supplier code for ${d}"></td>
        <td class="rt-ro">${pill(r)}</td></tr>`;
    }).join('');
    const empty = m.querySelector('#rt-empty');
    empty.hidden = vis.length > 0;
    if (!vis.length) {
      empty.textContent = this.filter === 'norate' ? 'Every item this project uses in this category has a rate.'
        : this.filter === 'used' ? 'This project uses nothing in this category yet.' : 'No items match the filter.';
    }
    GridTable.attach(tbody, { cells: '[data-f]', onSelect: (info) => this._renderStat(info) });
    this._renderStat(null);
  },

  _renderStat(info) {
    const el = document.getElementById('rt-stat');
    if (!el) return;
    const keys = '<span class="rt-kb">Ctrl V</span> pastes from Excel · <span class="rt-kb">Ctrl D</span> fills down · type to replace';
    if (!info || info.count < 2) { el.innerHTML = `<span class="rt-grow"></span><span>${keys}</span>`; return; }
    const parts = [`<span>${info.count} cells selected</span>`];
    if (info.numeric) parts.push(`<span>Sum <b>${this.num2(info.sum)}</b></span>`, `<span>Average <b>${this.num2(info.avg)}</b></span>`);
    el.innerHTML = parts.join('') + `<span class="rt-grow"></span><span>${keys}</span>`;
  },

  // ── Export ─────────────────────────────────────────────────────────
  HEAD: ['Key', 'Category', 'Description', 'Unit', 'Rate', 'Waste %', 'Supplier code', 'In this project'],
  _exportRows() {
    const rows = (this._rows || this.rows(this.usedLines())).filter(r => !r.orphan);
    const order = this.CATS.map(c => c.id);
    rows.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
    const cat = id => (this.CATS.find(c => c.id === id) || {}).label || id;
    return rows.map(r => {
      const v = this.get(r.key, r.cat);
      return [r.key, cat(r.cat), r.desc, r.unit, v.rate == null ? '' : v.rate, v.waste, v.supplier, r.used ? 'Yes' : ''];
    });
  },
  _fname(ext) {
    const base = (AppState.projectName || 'project').replace(/[^\w-]+/g, '_');
    return `${base}_rates_${new Date().toISOString().slice(0, 10)}.${ext}`;
  },
  exportFile(kind) {
    const rows = this._exportRows();
    if (kind === 'csv') {
      const csv = '﻿' + [this.HEAD, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = this._fname('csv');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      if (typeof XLSX === 'undefined') { UI.toast('The Excel library did not load. Export CSV instead.', 'error'); return; }
      const ws = XLSX.utils.aoa_to_sheet([this.HEAD, ...rows]);
      ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 44 }, { wch: 6 }, { wch: 12 }, { wch: 9 }, { wch: 18 }, { wch: 14 }];
      ws['!autofilter'] = { ref: `A1:H${rows.length + 1}` };
      const about = XLSX.utils.aoa_to_sheet([
        ['ProtectionPro rate library'],
        [`Project: ${AppState.projectName || ''}`],
        [`Currency: ${this.currency()}`],
        [''],
        ['Change Rate, Waste % or Supplier code on the Rates sheet, then import the file back.'],
        ['Rows are matched on Key. Do not change the Key column.'],
        ['Description and Unit are for reading only; they are not imported for existing keys.'],
        ['A new row with a new Key and a Description is added as a new item.'],
        ['A blank Rate means "no rate": the item is left out of the BOQ total and flagged.'],
      ]);
      about['!cols'] = [{ wch: 90 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Rates');
      XLSX.utils.book_append_sheet(wb, about, 'Read me');
      XLSX.writeFile(wb, this._fname('xlsx'));
    }
    UI.toast(`Exported ${rows.length} items.`, 'success');
  },

  // ── Import ─────────────────────────────────────────────────────────
  importFile(file) {
    if (typeof XLSX === 'undefined') { UI.toast('The spreadsheet library did not load, so the file cannot be read.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const isCsv = /\.csv$/i.test(file.name);
        const wb = isCsv
          ? XLSX.read(new TextDecoder('utf-8').decode(ev.target.result).replace(/^﻿/, ''), { type: 'string', raw: true })
          : XLSX.read(ev.target.result, { type: 'array' });
        const sheetName = wb.SheetNames.find(n => /^rates$/i.test(n)) || wb.SheetNames[0];
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
        const plan = this.planImport(aoa);
        if (plan.error) { UI.alert(plan.error); return; }
        plan.fileName = file.name;
        plan.sheet = isCsv ? null : sheetName;
        this.showImport(plan);
      } catch (err) {
        console.error(err);
        UI.alert('The file could not be read as a spreadsheet: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  },

  // Work out every change a sheet (array of rows) would make. Pure — nothing
  // is written until applyImport().
  planImport(aoa) {
    let h = -1;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      if ((aoa[i] || []).some(c => /^\s*key\s*$/i.test(String(c)))) { h = i; break; }
    }
    if (h < 0) return { error: 'No "Key" column was found in the first rows of the sheet. Export the rate library to see the expected layout.' };
    const head = aoa[h].map(c => String(c).trim().toLowerCase());
    const col = (re) => head.findIndex(c => re.test(c));
    const C = {
      key: col(/^key$/), rate: col(/^rate\b/), waste: col(/^waste/), supplier: col(/^supplier/),
      desc: col(/^desc/), unit: col(/^unit$/), cat: col(/^cat/),
    };
    if (C.rate < 0 && C.waste < 0 && C.supplier < 0) return { error: 'The sheet has a Key column but no Rate, Waste % or Supplier code column to import.' };
    const known = new Map(this.rows(this._used || []).filter(r => !r.orphan).map(r => [r.key, r]));
    const catId = (s) => {
      const t = String(s || '').trim().toLowerCase();
      const c = this.CATS.find(x => x.label.toLowerCase() === t || x.id === t);
      return c ? c.id : null;
    };
    const plan = { rows: 0, unchanged: 0, changes: [], newItems: [], ignored: [], errors: [], seen: new Set(), clearable: [] };
    const cell = (r, i) => (i >= 0 ? r[i] : undefined);
    const numOrNull = (v) => {
      if (v === '' || v == null) return { v: null };
      if (typeof v === 'number') return { v };
      const n = GridTable.cleanNumber(v);
      return isNaN(n) || n < 0 ? { bad: true } : { v: n };
    };
    for (let i = h + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const key = String(cell(r, C.key) ?? '').trim().toUpperCase();
      if (!key) continue;
      plan.rows++;
      if (plan.seen.has(key)) { plan.ignored.push({ key, desc: '', why: 'key repeated in the file; first row used' }); continue; }
      plan.seen.add(key);
      const item = known.get(key);
      const rate = C.rate >= 0 ? numOrNull(cell(r, C.rate)) : null;
      const waste = C.waste >= 0 ? numOrNull(cell(r, C.waste)) : null;
      const supplier = C.supplier >= 0 ? String(cell(r, C.supplier) ?? '').trim() : null;
      if (!item) {
        const desc = String(cell(r, C.desc) ?? '').trim();
        if (!desc) { plan.ignored.push({ key, desc: '—', why: 'no such item and no description; ignored' }); continue; }
        if (rate && rate.bad) { plan.errors.push({ key, desc, field: 'Rate', from: '', to: String(cell(r, C.rate)), why: 'not a number; row skipped' }); continue; }
        plan.newItems.push({
          key, desc, unit: String(cell(r, C.unit) ?? '').trim() || 'ea',
          cat: catId(cell(r, C.cat)) || this.guessCat(key),
          rate: rate ? rate.v : null, waste: waste && !waste.bad ? waste.v : null, supplier: supplier || '',
        });
        continue;
      }
      const cur = this.get(key, item.cat);
      const stored = (this.lib().items[key]) || {};
      let changed = false;
      const push = (field, from, to, kind) => { plan.changes.push({ key, desc: item.desc, field, from, to, kind }); changed = true; };
      if (rate) {
        if (rate.bad) plan.errors.push({ key, desc: item.desc, field: 'Rate', from: this._rateText(cur.rate), to: String(cell(r, C.rate)), why: 'not a number; skipped' });
        else if (rate.v == null && cur.rate != null) push('rate', cur.rate, null, 'cleared');
        else if (rate.v != null && cur.rate == null) push('rate', null, rate.v, 'filled');
        else if (rate.v != null && Math.abs(rate.v - cur.rate) > 1e-9) push('rate', cur.rate, rate.v, 'changed');
      }
      if (waste) {
        if (waste.bad) plan.errors.push({ key, desc: item.desc, field: 'Waste %', from: String(cur.waste), to: String(cell(r, C.waste)), why: 'not a number; skipped' });
        else if (waste.v != null && Math.abs(waste.v - cur.waste) > 1e-9) push('waste', cur.waste, waste.v, 'changed');
        else if (waste.v == null && stored.waste != null) push('waste', cur.waste, null, 'changed');
      }
      if (supplier !== null && supplier !== (cur.supplier || '')) push('supplier', cur.supplier || '', supplier, 'changed');
      if (!changed) plan.unchanged++;
    }
    // Library items with a rate that the file doesn't mention (for "Clear missing").
    for (const [k, it] of Object.entries(this.lib().items)) {
      if (it.rate != null && !plan.seen.has(k) && known.has(k)) plan.clearable.push({ key: k, desc: known.get(k).desc, from: it.rate });
    }
    return plan;
  },

  applyImport(plan, { addNew = true, clearMissing = false } = {}) {
    const before = JSON.parse(JSON.stringify(this.lib()));
    let n = 0;
    for (const c of plan.changes) { this.set(c.key, c.field, c.to); n++; }
    if (addNew) {
      const L = this.lib();
      for (const it of plan.newItems) {
        L.custom[it.key] = { desc: it.desc, unit: it.unit, cat: it.cat };
        if (it.rate != null) this.set(it.key, 'rate', it.rate);
        if (it.waste != null) this.set(it.key, 'waste', it.waste);
        if (it.supplier) this.set(it.key, 'supplier', it.supplier);
        n++;
      }
    }
    if (clearMissing) for (const c of plan.clearable) { this.set(c.key, 'rate', null); n++; }
    this._touch();
    this._undo = { lib: before, label: `Imported ${n} change${n === 1 ? '' : 's'} from ${plan.fileName || 'the file'}.` };
    return n;
  },

  undo() {
    if (!this._undo) return;
    AppState.rateLibrary = this._undo.lib;
    this._undo = null;
    AppState.dirty = true;
    this._used = this.usedLines();
    this.render();
    UI.toast('Rates restored to how they were before.', 'info');
  },

  showImport(plan) {
    let m = document.getElementById('rates-import-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'rates-import-modal';
      m.className = 'modal rt-imp-modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.setAttribute('aria-labelledby', 'rt-imp-title');
      document.body.appendChild(m);
    }
    const cur = this.currency();
    const fmt = (field, v) => v == null || v === '' ? '—' : field === 'rate' ? this.num2(Number(v)) : escHtml(String(v));
    const label = { rate: 'Rate', waste: 'Waste %', supplier: 'Supplier code' };
    const pct = (a, b) => (a && b != null && a !== 0) ? ` ${b > a ? '+' : ''}${((b - a) / a * 100).toFixed(1)}%` : '';
    let showAll = false;
    const state = { addNew: true, clearMissing: false };
    const count = () => plan.changes.length + (state.addNew ? plan.newItems.length : 0) + (state.clearMissing ? plan.clearable.length : 0);
    const filled = plan.changes.filter(c => c.kind === 'filled').length;
    const changedKeys = new Set(plan.changes.filter(c => c.kind !== 'filled').map(c => c.key));
    const rowsHtml = () => {
      const out = [];
      for (const c of plan.changes) {
        const pillHtml = c.kind === 'filled' ? '<span class="rt-pill ok">Filled</span> <span class="rt-note-i">was empty</span>'
          : c.kind === 'cleared' ? '<span class="rt-pill amb">Cleared</span> <span class="rt-note-i">blank in the file</span>'
          : `<span class="rt-pill amb">Changed</span> <span class="rt-note-i">${c.field === 'rate' ? pct(c.from, c.to) : ''}</span>`;
        out.push(`<tr><td class="rt-code">${escHtml(c.key)}</td><td>${escHtml(c.desc)}</td><td>${label[c.field]}</td><td class="rt-num">${fmt(c.field, c.from)}</td><td class="rt-num"><b>${fmt(c.field, c.to)}</b></td><td>${pillHtml}</td></tr>`);
      }
      for (const it of plan.newItems) out.push(`<tr${state.addNew ? '' : ' class="rt-off"'}><td class="rt-code">${escHtml(it.key)}</td><td>${escHtml(it.desc)}</td><td>New item</td><td class="rt-num"></td><td class="rt-num"><b>${fmt('rate', it.rate)}</b></td><td><span class="rt-pill ok">New item</span> <span class="rt-note-i">${state.addNew ? 'not in the library' : 'will not be added'}</span></td></tr>`);
      if (state.clearMissing) for (const c of plan.clearable) out.push(`<tr><td class="rt-code">${escHtml(c.key)}</td><td>${escHtml(c.desc)}</td><td>Rate</td><td class="rt-num">${fmt('rate', c.from)}</td><td class="rt-num"><b>—</b></td><td><span class="rt-pill amb">Cleared</span> <span class="rt-note-i">missing from the file</span></td></tr>`);
      for (const x of plan.ignored) out.push(`<tr><td class="rt-code">${escHtml(x.key)}</td><td>${escHtml(x.desc || '—')}</td><td>Unknown key</td><td></td><td></td><td><span class="rt-pill gry">Ignored</span> <span class="rt-note-i">${escHtml(x.why)}</span></td></tr>`);
      for (const x of plan.errors) out.push(`<tr><td class="rt-code">${escHtml(x.key)}</td><td>${escHtml(x.desc)}</td><td>${x.field}</td><td class="rt-num">${escHtml(x.from || '—')}</td><td class="rt-num"><b>${escHtml(x.to)}</b></td><td><span class="rt-pill bad">Error</span> <span class="rt-note-i">${escHtml(x.why)}</span></td></tr>`);
      if (showAll) {
        const touched = new Set([...plan.changes, ...plan.newItems, ...plan.ignored, ...plan.errors].map(x => x.key));
        for (const k of plan.seen) if (!touched.has(k)) {
          const r = (this._rows || []).find(x => x.key === k);
          out.push(`<tr class="rt-off"><td class="rt-code">${escHtml(k)}</td><td>${escHtml(r ? r.desc : '')}</td><td></td><td></td><td></td><td><span class="rt-note-i">No change</span></td></tr>`);
        }
      }
      return out.join('') || '<tr><td colspan="6" class="rt-empty-row">The file matches the library — nothing to change.</td></tr>';
    };
    const nChanges = () => plan.changes.length + plan.newItems.length + plan.ignored.length + plan.errors.length + (state.clearMissing ? plan.clearable.length : 0);
    const draw = () => {
      const n = count();
      m.innerHTML = `
      <div class="modal-content rt-dialog rt-imp">
        <header class="rt-head">
          <span class="rt-mark">${this._icon('<path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M3 13h10"/>', 18)}</span>
          <div class="rt-head-text"><h3 id="rt-imp-title">Import rates</h3><div class="rt-head-sub">Check the changes before they are applied</div></div>
          <button class="modal-close" data-ri="cancel" aria-label="Close">&times;</button>
        </header>
        <main class="rt-main">
          <div class="rt-bar"><span class="rt-file"><b>${escHtml(plan.fileName || '')}</b></span><span class="rt-note-i">${plan.sheet ? `Sheet “${escHtml(plan.sheet)}” · ` : ''}${plan.rows} rows read · matched on Key · currency ${escHtml(cur)}</span></div>
          <div class="rt-chips">
            <div class="rt-chip"><b>${plan.unchanged}</b><span>Matched, unchanged</span></div>
            <div class="rt-chip"><b class="rt-amb">${changedKeys.size}</b><span>Changed</span></div>
            <div class="rt-chip"><b class="rt-ok">${filled}</b><span>Rates filled in</span></div>
            <div class="rt-chip"><b class="rt-ok">${plan.newItems.length}</b><span>New items</span></div>
            <div class="rt-chip"><b class="rt-bad">${plan.ignored.length + plan.errors.length}</b><span>Ignored / errors</span></div>
          </div>
          <div class="rt-bar"><div class="rt-seg" role="group" aria-label="Show">
            <button type="button" class="rt-sg${showAll ? '' : ' on'}" aria-pressed="${!showAll}" data-ri="changes">Changes only (${nChanges()})</button>
            <button type="button" class="rt-sg${showAll ? ' on' : ''}" aria-pressed="${showAll}" data-ri="all">All rows (${plan.rows})</button></div></div>
          <div class="rt-tablewrap"><table class="rt-tbl rt-ro-tbl"><thead><tr><th class="rt-c-key">Key</th><th>Item</th><th style="width:110px">Field</th><th class="rt-num" style="width:100px">Current</th><th class="rt-num" style="width:110px">From file</th><th style="width:240px">Result</th></tr></thead><tbody>${rowsHtml()}</tbody></table></div>
          <div class="rt-bar rt-opts">
            <label class="rt-chk"><input type="checkbox" data-ri="addNew" ${state.addNew ? 'checked' : ''}${plan.newItems.length ? '' : ' disabled'}><span>Add new items from the file</span></label>
            <label class="rt-chk"><input type="checkbox" data-ri="clearMissing" ${state.clearMissing ? 'checked' : ''}${plan.clearable.length ? '' : ' disabled'}><span>Clear rates for library items missing from the file${plan.clearable.length ? ` (${plan.clearable.length})` : ''}</span></label>
          </div>
        </main>
        <footer class="rt-foot"><span class="rt-note-i">Nothing changes until you apply. Undo is available afterwards.</span><span class="rt-grow"></span>
          <button type="button" class="rt-btn" data-ri="cancel">Cancel</button>
          <button type="button" class="rt-btn primary" data-ri="apply" ${n ? '' : 'disabled'}>Apply ${n} change${n === 1 ? '' : 's'}</button></footer>
      </div>`;
    };
    draw();
    m.onclick = (e) => {
      const b = e.target.closest('[data-ri]');
      if (!b) { if (e.target === m) m.style.display = 'none'; return; }
      const a = b.dataset.ri;
      if (a === 'cancel') m.style.display = 'none';
      else if (a === 'changes' || a === 'all') { showAll = a === 'all'; draw(); }
      else if (a === 'apply') {
        const n = this.applyImport(plan, state);
        m.style.display = 'none';
        this._used = this.usedLines();
        this.render();
        UI.toast(`Applied ${n} change${n === 1 ? '' : 's'}.`, 'success');
      }
    };
    m.onchange = (e) => {
      const b = e.target.closest('[data-ri]');
      if (b && (b.dataset.ri === 'addNew' || b.dataset.ri === 'clearMissing')) { state[b.dataset.ri] = b.checked; draw(); }
    };
    m.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); m.style.display = 'none'; } };
    m.style.display = 'flex';
    setTimeout(() => { const f = m.querySelector('[data-ri="apply"]:not([disabled])') || m.querySelector('[data-ri="cancel"]'); if (f) f.focus(); }, 30);
  },

  // ── My default rates (this browser) ────────────────────────────────
  _readDefault() {
    try { const raw = localStorage.getItem(this.DEFAULT_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },
  saveDefault() {
    const L = this.lib();
    try {
      localStorage.setItem(this.DEFAULT_KEY, JSON.stringify({
        currency: L.currency, defaultWaste: L.defaultWaste, items: L.items, custom: L.custom, savedAt: new Date().toISOString(),
      }));
    } catch (e) { UI.toast('Could not save your default rates: ' + e.message, 'error'); return; }
    UI.toast(`Saved ${Object.keys(L.items).length} rates as your default. New projects can load them.`, 'success');
    this._renderBanner();
  },
  async loadDefault() {
    const d = this._readDefault();
    if (!d) { UI.alert('You have no saved default rates yet. Enter rates, then click "Save as my default".'); return; }
    const L = this.lib();
    if (Object.keys(L.items).length && !(await UI.confirm(`Replace this project's ${Object.keys(L.items).length} rates with your default rates?`, { okText: 'Replace' }))) return;
    const before = JSON.parse(JSON.stringify(L));
    AppState.rateLibrary = { currency: d.currency || 'R', defaultWaste: d.defaultWaste ?? 5, items: d.items || {}, custom: d.custom || {}, updatedAt: d.savedAt || new Date().toISOString() };
    AppState.dirty = true;
    this._undo = { lib: before, label: `Loaded ${Object.keys(d.items || {}).length} default rates.` };
    this.render();
  },
};
