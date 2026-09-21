/* ProtectionPro — Rate library (prices for the Bill of quantities).
 *
 * Every item the app can count has a fixed Key (CBL-95-AL-XLPE-LV,
 * MCB-1P-20C, CIV-TRENCH-LV-SL …) generated from the cable libraries, the
 * element registry and the device ratings. The catalogue is rebuilt from
 * those sources each time, so only what the user set is stored, with the
 * project, in AppState.rateLibrary:
 *
 *   { currency, defaultWaste, updatedAt,
 *     items:  { KEY: { rate, labour, waste, supplier, rule } },
 *     custom: { KEY: { desc, unit, cat } } }        // items added by an import
 *
 * `rate` is the MATERIAL rate and `labour` the labour rate, both per unit.
 * An item is priced when either is entered; one with neither is "no rate".
 * Rates entered before labour was split out sit in `rate`, so they count as
 * material. Waste % applies to material only (boq.js).
 *
 * `rule` ("Quantity from") counts items nobody draws from what the project
 * measures (boq.js BASES): { basis, factor } → factor × that count, basis
 * 'fixed' → factor, or null for "measured only". An item without a stored
 * `rule` property takes the catalogue's default rule (starter items), so an
 * improved default reaches every project that hasn't overridden it.
 *
 * Round trip with Excel: Export (CSV / XLSX) → edit Material rate, Labour
 * rate, Waste % or Supplier code → Import. Rows match on Key only; Description / Unit in the file are
 * ignored for known keys, so a reworded cell can't corrupt the library. The
 * import shows every change before it is applied, and can be undone.
 *
 * An item without a rate is never priced at 0 — the BOQ lists it, leaves it
 * out of the total and says so (boq.js).
 */

const Rates = {
  CATS: [
    { id: 'cable', label: 'Cables' },
    { id: 'term', label: 'Terminations' },
    { id: 'equip', label: 'Equipment' },
    { id: 'prot', label: 'Protective devices' },
    { id: 'civil', label: 'Civils & labour' },
    { id: 'allow', label: 'Preliminaries & allowances' },
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
  // A cable's key comes from its permanent library id, so renaming a cable
  // in Settings can't disconnect its rates. A name the library doesn't know
  // (typed elsewhere) still gets a stable key from the name.
  cableKey(name) {
    const c = typeof CableLib !== 'undefined' ? CableLib.byName(name) : null;
    return c ? this.cableKeyOf(c) : 'CBL-' + this.slug(name);
  },
  cableKeyOf(c) { return 'CBL-' + this.slug(c.id || c.name); },
  cableDesc(name) {
    const c = typeof CableLib !== 'undefined' ? CableLib.byName(name) : null;
    return c ? CableLib.label(c) : name;
  },
  mcbKey(poles, a, curve) { return `MCB-${poles}-${a}${curve || 'C'}`; },
  elKey(poles, ma) { return `ELU-${poles}-${ma}MA`; },
  boardSize(modules) { return this.DB_SIZES.find(n => n >= modules) || this.DB_SIZES[this.DB_SIZES.length - 1]; },
  dbKey(modules) { return `EQ-DB-${this.boardSize(modules)}W`; },
  trenchKey(t) { return 'CIV-TRENCH-' + this.slug(t); },
  crossingKey(size) { return 'CIV-XING-' + this.slug(size || '110'); },
  routeKey(type) { return (['conduit', 'cable_tray'].includes(type) ? 'CNT-' : 'CBL-ROUTE-') + this.slug(type); },
  accKey(kind) { return 'ACC-' + this.slug(kind); },

  // Terminations are priced per cable size and type: one TRM- item per cable,
  // for one cable end: material = gland, lugs, shroud; labour = making off.
  termItem(cable) {
    const name = cable.desc || '';
    const lc = typeof CableLib !== 'undefined' ? CableLib.all().find(c => this.cableKeyOf(c) === cable.key) : null;
    const mv = !!lc && CableLib.isMV(lc);
    return { key: 'TRM-' + String(cable.key).replace(/^CBL-/, ''), desc: `Termination, ${name}${mv ? ' (MV)' : ''}`, unit: 'ea', cat: 'term' };
  },

  // Final-circuit cable of a DB way: the library's T+E (1P/2P) or 4-core Cu
  // PVC armoured cable (3P/4P) of that size, else a generic Cu item.
  fcCable(size, poles) {
    const s = Number(size);
    const three = /^[34]P$/.test(String(poles || ''));
    const lib = typeof CableLib !== 'undefined' ? CableLib.all().map(c => CableLib.normalize(c)) : [];
    const hit = lib.find(c => Number(c.size_mm2) === s && (three
      ? c.construction === 'armoured' && c.conductor === 'Cu' && c.insulation === 'PVC' && !CableLib.isMV(c) && Number(c.cores) === 4
      : c.construction === 'te'));
    if (hit) return { key: this.cableKeyOf(hit), desc: CableLib.label(hit) };
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
    const add = (key, desc, unit, cat, extra) => { if (!seen.has(key)) { seen.add(key); out.push(Object.assign({ key, desc, unit, cat }, extra)); } };
    // Cables
    const cables = typeof CableLib !== 'undefined' ? CableLib.all() : [];
    for (const c of cables) add(this.cableKeyOf(c), CableLib.label(c), 'm', 'cable');
    for (const c of cables) {
      const t = this.termItem({ key: this.cableKeyOf(c), desc: CableLib.label(c) });
      add(t.key, t.desc, 'ea', 'term');
    }
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
    add('LAB-JB-SPLICE', 'Junction-box splice (per core joined)', 'ea', 'civil');
    add('LAB-JB-TERM', 'Junction-box cable termination', 'ea', 'civil');
    // Starter items nobody draws: counted by their default rule, no rates.
    for (const s of this.STARTER) add(s.key, s.desc, s.unit, s.cat, { rule: s.rule });
    return out;
  },

  // Which column a single price belongs in (the import of a one-rate sheet):
  // labour items (LAB-) are priced as labour, everything else as material.
  priceIn(key) {
    const L = AppState.rateLibrary, c = L && L.custom && L.custom[key];
    if (c && c.priceIn) return c.priceIn;
    return /^LAB-/.test(String(key || '')) ? 'labour' : 'material';
  },

  STARTER: [
    { key: 'EQ-METER-BOX', desc: 'Meter box / service connection box, per erf', unit: 'ea', cat: 'equip', rule: { basis: 'erven', factor: 1 } },
    { key: 'CIV-WARNING-TAPE', desc: 'Cable warning tape', unit: 'm', cat: 'civil', rule: { basis: 'trench_m', factor: 1 } },
    { key: 'CIV-CABLE-MARKER', desc: 'Cable route marker (1 per 50 m)', unit: 'ea', cat: 'civil', rule: { basis: 'trench_m', factor: 0.02 } },
    { key: 'EQ-EARTH-ELECTRODE', desc: 'Earth electrode, per kiosk', unit: 'ea', cat: 'equip', rule: { basis: 'kiosks', factor: 2 } },
    { key: 'EQ-EARTH-MINISUB', desc: 'Minisub earthing installation', unit: 'ea', cat: 'equip', rule: { basis: 'minisubs', factor: 1 } },
    { key: 'LAB-TEST-COMMISSION', desc: 'Testing & commissioning', unit: 'sum', cat: 'civil', rule: { basis: 'fixed', factor: 1 } },
    { key: 'LAB-COC', desc: 'Certificate of compliance, per DB', unit: 'ea', cat: 'civil', rule: { basis: 'boards', factor: 1 } },
    // Percentage lines: off until a percent is entered.
    { key: 'PCT-PG', desc: 'Preliminaries & general', unit: '%', cat: 'allow', rule: { basis: 'pct', factor: null, of: ['total'], part: 'all' } },
    { key: 'PCT-CONTINGENCY', desc: 'Contingency', unit: '%', cat: 'allow', rule: { basis: 'pct', factor: null, of: ['total'], part: 'all' } },
  ],
  // One word per section, for "5 % of cables, civils" (display and the sheet).
  CAT_WORD: { cable: 'cables', term: 'terminations', equip: 'equipment', prot: 'protection', civil: 'civils' },
  _num(v) { return String(+Number(v).toFixed(6)); },
  _pctOf(rule) {
    const of = (rule.of && rule.of.length && !rule.of.includes('total')) ? rule.of.map(id => this.CAT_WORD[id] || id).join(', ') : 'total';
    const part = rule.part === 'material' || rule.part === 'labour' ? rule.part + ' in ' : '';
    return `of ${part}${of}`;
  },
  // "8 % of total", "5 % of cables, civils", "3 % of labour in total".
  pctOfText(rule) { return `${rule.factor == null ? '—' : this._num(rule.factor)} % ${this._pctOf(rule)}`; },

  // ── "Quantity from" as text (the sheet's column). One pair, so an
  // exported sheet always reads back to the same rule. ──
  //   measured · fixed 1 · 1 x Erven · 0.02 x LV cable, m · 8% of total ·
  //   5% of cables, civils · 3% of labour in total · % of total (percent off)
  ruleText(rule) {
    if (!rule) return 'measured';
    if (rule.basis === 'fixed') return `fixed ${rule.factor == null ? '' : this._num(rule.factor)}`.trim();
    if (rule.basis === 'pct') return `${rule.factor == null ? '' : this._num(rule.factor)}% ${this._pctOf(rule)}`;
    const b = typeof BOQ !== 'undefined' ? BOQ.basis(rule.basis) : null;
    return `${rule.factor == null ? '' : this._num(rule.factor)} x ${b ? b.label : rule.basis}`;
  },
  // → { rule } (null = measured), { reset: true } ("default"), { none: true }
  // (blank: no change) or { error }.
  parseRule(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { none: true };
    if (/^measured$/i.test(t)) return { rule: null };
    if (/^default$/i.test(t)) return { reset: true };
    const num = (x) => { const n = GridTable.cleanNumber(x); return isNaN(n) || n < 0 ? NaN : n; };
    let m = t.match(/^fixed\s*([\d.,\s]+)$/i);
    if (m) { const f = num(m[1]); return isNaN(f) ? { error: `“${m[1].trim()}” is not a number` } : { rule: { basis: 'fixed', factor: f } }; }
    m = t.match(/^([\d.,\s]*)%\s*of\s+(?:(material|labour|labor)\s+in\s+)?(.+)$/i);
    if (m) {
      const f = m[1].trim() === '' ? null : num(m[1]);
      if (Number.isNaN(f)) return { error: `“${m[1].trim()}” is not a percentage` };
      const words = m[3].split(/\s*(?:,|\band\b)\s*/i).map(w => w.trim().toLowerCase()).filter(Boolean);
      const of = [];
      for (const w of words) {
        if (w === 'total' || w === 'all') { of.length = 0; of.push('total'); break; }
        const c = this.CATS.find(x => x.id !== 'allow' && (x.id === w || this.CAT_WORD[x.id] === w || x.label.toLowerCase() === w
          || x.label.toLowerCase().startsWith(w + ' ') || w.replace(/s$/, '') === this.CAT_WORD[x.id].replace(/s$/, '')));
        if (!c) return { error: `“${w}” is not a section (use total, ${Object.values(this.CAT_WORD).join(', ')})` };
        if (!of.includes(c.id)) of.push(c.id);
      }
      const part = m[2] ? (/^labo/i.test(m[2]) ? 'labour' : 'material') : 'all';
      return { rule: { basis: 'pct', factor: f, of: of.length ? of : ['total'], part } };
    }
    m = t.match(/^([\d.,\s]+?)\s*[x×*]\s*(.+)$/i);
    if (m) {
      const f = num(m[1]);
      if (isNaN(f)) return { error: `“${m[1].trim()}” is not a number` };
      const norm = (x) => String(x).toLowerCase().replace(/[_,():]/g, ' ').replace(/\s+/g, ' ').trim();
      const want = norm(m[2]);
      const b = (typeof BOQ !== 'undefined' ? BOQ.BASES : []).find(x => norm(x.id) === want || norm(x.label) === want);
      if (!b) return { error: `“${m[2].trim()}” is not a quantity this app counts` };
      return { rule: b.id === 'fixed' ? { basis: 'fixed', factor: f } : { basis: b.id, factor: f } };
    }
    return { error: 'not a rule — write e.g. “1 x erven”, “fixed 1”, “8% of total” or “measured”' };
  },
  _sameRule(a, b) { return this.ruleText(a) === this.ruleText(b); },

  guessCat(key) {
    const k = String(key || '');
    if (/^(CBL|OHL)-/.test(k)) return 'cable';
    if (/^TRM-/.test(k)) return 'term';
    if (/^(MCB|ELU|CB|FUSE|ACC|SW)-/.test(k)) return 'prot';
    if (/^(CIV|LAB|CNT)-/.test(k)) return 'civil';
    if (/^PCT-/.test(k)) return 'allow';
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
    this._migrateKeys(L);
    return L;
  },

  // Keys used before cable keys came from library ids (name-based keys, and
  // the former building library's "x4C Cu PVC/SWA" names) → today's key.
  // Used to move saved rates once and to match an older exported sheet.
  legacyKeyMap() {
    const map = {};
    if (typeof CableLib === 'undefined') return map;
    const put = (oldName, c) => {
      const nw = this.cableKeyOf(c).slice(4), old = this.slug(oldName);
      if (old === nw) return;
      map['CBL-' + old] = 'CBL-' + nw;
      map['TRM-' + old] = 'TRM-' + nw;
    };
    for (const c of CableLib.all()) put(c.name, c);
    for (const [alias, name] of Object.entries(CableLib.ALIASES)) { const c = CableLib.byName(name); if (c) put(alias, c); }
    return map;
  },
  // Move saved rates to today's keys once. A rate already on the new key is
  // never overwritten.
  _migrateKeys(L) {
    if (!L || L.keysV === 2 || typeof CableLib === 'undefined') return;
    const items = L.items || {};
    for (const [from, to] of Object.entries(this.legacyKeyMap())) {
      if (!items[from]) continue;
      if (!items[to]) items[to] = items[from];
      delete items[from];
    }
    L.keysV = 2;
  },
  currency() { return (AppState.rateLibrary && AppState.rateLibrary.currency) || 'R'; },
  defaultWaste(cat) { return cat === 'cable' ? Number(this.lib().defaultWaste) || 0 : 0; },

  // { rate: number|null (material), labour: number|null, waste: number, supplier: string }
  get(key, cat) {
    const L = AppState.rateLibrary;
    if (L && L.keysV !== 2) this._migrateKeys(L);
    const it = (L && L.items && L.items[key]) || {};
    const c = cat || (L && L.custom && L.custom[key] && L.custom[key].cat) || this.guessCat(key);
    const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
    const waste = (it.waste === null || it.waste === undefined || it.waste === '') ? this.defaultWaste(c) : Number(it.waste) || 0;
    return { rate: num(it.rate), labour: num(it.labour), waste, supplier: it.supplier || '' };
  },
  // Priced = a material or a labour rate is entered.
  priced(v) { return !!v && (v.rate != null || v.labour != null); },

  // Effective "Quantity from" rule: the project's own (null = measured only),
  // else the catalogue default. Returns { basis, factor, of?, part? } or null.
  getRule(key) {
    const L = AppState.rateLibrary, it = L && L.items && L.items[key];
    let r;
    r = it && Object.prototype.hasOwnProperty.call(it, 'rule') ? it.rule : this._defaultRule(key);
    if (!r || typeof r !== 'object' || !r.basis) return null;
    const f = r.factor === null || r.factor === undefined || r.factor === '' ? NaN : Number(r.factor);
    return Object.assign({}, r, { factor: isFinite(f) ? f : null });
  },
  // rule: an object, null (= measured only, overriding a default), or
  // undefined (= back to the catalogue default).
  setRule(key, rule) {
    const L = this.lib();
    const it = L.items[key] || (L.items[key] = {});
    if (rule === undefined) delete it.rule; else it.rule = rule ? Object.assign({}, rule) : null;
    this._prune(key);
    this._touch();
  },

  _touch() {
    const L = this.lib();
    L.updatedAt = new Date().toISOString();
    AppState.dirty = true;
  },
  _prune(key) {
    const L = this.lib(), it = L.items[key];
    if (it && (it.rate == null) && (it.labour == null) && (it.waste == null) && !it.supplier && !('rule' in it)) delete L.items[key];
  },
  // field: 'rate' (material) | 'labour' | 'waste' | 'supplier'; value already cleaned (number|null|string)
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
  // Also keeps the default bill (this._bill) for rule / percentage status.
  usedLines() {
    this._bill = null;
    if (typeof BOQ === 'undefined' || !BOQ.compute) return [];
    // Default take-off (not the BOQ dialog's current ticks), so "In this project" is stable.
    try { this._bill = BOQ.compute(BOQ._defaultOpts()); return this._bill.sections.flatMap(s => s.lines); }
    catch (e) { console.warn('BOQ take-off failed', e); return []; }
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
    this._closeOf();
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
    const I_PLUS = this._icon('<path d="M8 3v10M3 8h10"/>', 14);
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
          <button type="button" class="rt-btn" data-rt="add">${I_PLUS}Add item</button>
          <button type="button" class="rt-btn" data-rt="csv">${I_DOWN}Export CSV</button>
          <button type="button" class="rt-btn" data-rt="xlsx">${I_DOWN}Export Excel</button>
          <button type="button" class="rt-btn primary" data-rt="import">${I_UP}Import CSV / Excel…</button>
          <input type="file" id="rt-file" accept=".csv,.xlsx,.xls" hidden>
        </div>
        <div class="rt-tablewrap">
          <table class="rt-tbl" aria-label="Rates"><thead id="rt-thead"></thead>
            <tbody id="rt-rows"></tbody></table>
          <div class="rt-empty" id="rt-empty" hidden></div>
        </div>
        <div class="rt-stat" id="rt-stat"></div>
        <div class="rt-note" id="rt-term-note" hidden><b>One termination item per cable.</b> Every cable in the libraries has a matching <b>TRM-</b> key, so a cable added in Settings gets its termination item too. Each rate is for one cable end: <b>material</b> is the gland, lugs and shroud; <b>labour</b> is making off the end. Final-circuit wiring is only counted when the Bill of quantities option is ticked.</div>
        <div class="rt-note" id="rt-rule-note"><b>Quantity from</b> counts items nobody draws: a factor × a project count, or a fixed lump sum. <b>Measured</b> items are counted from the Demand, plans, single-line diagram and DB schedules. <b>Not counted</b>: the item has a rate, but no rule and nothing in the project measures it.</div>
        <div class="rt-note" id="rt-pct-note" hidden><b>Percentage lines</b> go last in the bill, after <b>Total before allowances</b>, each a percentage of the priced sections — never of another allowance. A line with no % entered is off.</div>
        <div class="rt-note"><b>Editing in Excel:</b> Export, change <b>Material rate</b>, <b>Labour rate</b>, <b>Waste %</b> or <b>Supplier code</b>, and import the file back. Rows are matched on <b>Key</b>, which never changes, so keep that column as it is. New keys with a description become new items. You see every change before it is applied.</div>
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
      else if (a === 'labour-ok') { this.lib().labourNoteSeen = true; AppState.dirty = true; this._renderBanner(); }
      else if (a === 'tab') { this.tab = b.dataset.v; this._closeOf(); this.render(); }
      else if (a === 'add') this.openAdd();
      else if (a === 'of') this._openOf(b);
      else if (a === 'filter') { this.filter = b.dataset.v; this.render(); }
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('rt-of-pop')) { e.stopPropagation(); this._closeOf(); return; }
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
    if (f === 'basis') { this._setBasis(key, el.value); this._afterRuleChange(); return; }
    if (f === 'factor' || f === 'pct') {
      const cur = this.getRule(key);
      const n = raw === '' ? null : GridTable.cleanNumber(raw);
      // A basis rule needs a factor > 0; a percentage may be blank (= off).
      if ((n === null && f === 'factor') || (n !== null && (isNaN(n) || n <= 0))) {
        el.value = cur && cur.factor != null ? this._num(cur.factor) : '';
        GridTable._flagBad(el, raw === '' ? 'A rule needs a factor. Choose “Measured” to remove the rule.' : `“${raw}” is not a number above 0. The previous value was kept.`);
        return;
      }
      if (f === 'factor') { if (cur && cur.basis !== 'pct') this._storeRule(key, Object.assign({}, cur, { factor: n })); }
      else this._storeRule(key, Object.assign({ of: ['total'], part: 'all' }, cur && cur.basis === 'pct' ? cur : {}, { basis: 'pct', factor: n }));
      el.value = n == null ? '' : this._num(n);
      this._afterRuleChange();
      return;
    }
    if (raw === '') { this.set(key, f, null); }
    else {
      const n = GridTable.cleanNumber(raw);
      if (isNaN(n) || n < 0) {
        const cur = this.get(key, tr.dataset.cat);
        el.value = f === 'rate' || f === 'labour' ? this._rateText(cur[f]) : String(cur.waste);
        GridTable._flagBad(el, `“${raw}” is not a number. The previous value was kept.`);
        return;
      }
      this.set(key, f, n);
      el.value = f === 'rate' || f === 'labour' ? this._rateText(n) : String(n);
    }
    if (f === 'rate' || f === 'labour') {
      const row = (this._rows || []).find(x => x.key === key);
      const nr = !this.priced(this.get(key)) && !!(row && row.used);
      tr.querySelectorAll('td[data-td="rate"], td[data-td="labour"]').forEach(td => td.classList.toggle('rt-nr', nr));
      if (row) tr.querySelector('td[data-td="st"]').innerHTML = this._pill(row);
      this._renderCounts();
      this._renderBanner();
    }
    this._renderHeadTags();
  },

  // Store a rule, keeping the library clean: a rule equal to the catalogue
  // default is stored as "no override", and "measured" on an item with no
  // default stores nothing.
  _defaultRule(key) {
    if (!this._defRules) this._defRules = new Map(this.catalogue().filter(c => c.rule).map(c => [c.key, c.rule]));
    return this._defRules.get(key) || null;
  },
  _storeRule(key, rule) {
    const def = this._defaultRule(key);
    if (this._sameRule(rule, def)) this.setRule(key, undefined);
    else this.setRule(key, rule);
  },
  _setBasis(key, basis) {
    const cur = this.getRule(key);
    if (!basis) { this._storeRule(key, null); return; }
    const factor = cur && cur.basis !== 'pct' && cur.factor > 0 ? cur.factor : 1;
    this._storeRule(key, { basis, factor });
  },
  // A rule changed: the bill's rule lines, the status pills and the counts move with it.
  _afterRuleChange() {
    this._used = this.usedLines();
    const usedSet = new Set(this._used.map(l => l.key));
    for (const r of this._rows || []) r.used = usedSet.has(r.key);
    const tbody = document.getElementById('rt-rows');
    if (tbody) for (const tr of tbody.querySelectorAll('tr[data-key]')) {
      const row = (this._rows || []).find(x => x.key === tr.dataset.key);
      if (!row) continue;
      const st = tr.querySelector('td[data-td="st"]'); if (st) st.innerHTML = this._pill(row);
      const fac = tr.querySelector('[data-f="factor"]');
      if (fac) {
        const rule = this.getRule(row.key), on = !!rule && rule.basis !== 'pct';
        fac.disabled = !on;
        fac.closest('td').classList.toggle('rt-dis', !on);
        if (!on) fac.value = '';
        else if (fac.value === '') fac.value = this._num(rule.factor);
      }
      const amt = tr.querySelector('td[data-td="inbill"]'); if (amt) amt.innerHTML = this._inBill(row.key);
      const of = tr.querySelector('[data-rt="of"]'); if (of) of.querySelector('span').textContent = this._ofLabel(this.getRule(row.key));
    }
    this._renderCounts();
  },

  // What the bill makes of an item now: its line (rule or measured) and whether it is counted.
  _billLine(key) { return (this._used || []).find(l => l.key === key) || null; },
  _notCounted(r) { return !r.orphan && r.cat !== 'allow' && !r.used && !this.getRule(r.key) && this.priced(this.get(r.key, r.cat)); },
  _isPctRow(r) { return r.cat === 'allow'; },

  _visible(rows) {
    const q = this.query.trim().toLowerCase();
    // Items this project uses first, then the catalogue order.
    return rows.filter(r => r.cat === this.tab).sort((a, b) => (b.used ? 1 : 0) - (a.used ? 1 : 0))
      // "No rate" = what the BOQ would miss: items this project uses without a rate.
      .filter(r => this.filter === 'all' || (this.filter === 'used' && r.used)
        || (this.filter === 'norate' && r.used && !this._isPctRow(r) && !this.priced(this.get(r.key, r.cat)))
        || (this.filter === 'notcounted' && this._notCounted(r)))
      .filter(r => !q || r.key.toLowerCase().includes(q) || String(r.desc).toLowerCase().includes(q));
  },

  render() {
    const m = document.getElementById('rates-modal');
    if (!m) return;
    this._rows = this.rows(this._used);
    const L = this.lib();
    if (this.tab === 'allow' && (this.filter === 'norate' || this.filter === 'notcounted')) this.filter = 'all';
    m.querySelector('#rt-cur').value = L.currency;
    m.querySelector('#rt-dwaste').value = L.defaultWaste;
    m.querySelector('#rt-q').value = this.query;
    m.querySelector('#rt-tabs').innerHTML = this.CATS.map(c => {
      const n = this._rows.filter(r => r.cat === c.id).length;
      const on = c.id === this.tab;
      return `<button type="button" class="rt-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-rt="tab" data-v="${c.id}">${escHtml(c.label)} <span class="rt-n">${n}</span></button>`;
    }).join('');
    this._renderHeadTags();
    this._renderCounts();
    this._renderBanner();
    m.querySelector('#rt-term-note').hidden = this.tab !== 'term';
    m.querySelector('#rt-rule-note').hidden = this.tab === 'allow';
    m.querySelector('#rt-pct-note').hidden = this.tab !== 'allow';
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
    const seg = [['all', 'All', ''], ['used', 'In this project', ` <span class="rt-n">${usedN}</span>`]];
    if (this.tab !== 'allow') {
      // "No rate" counts what the BOQ will miss: used items without a rate.
      const noRate = inTab.filter(r => r.used && !this.priced(this.get(r.key, r.cat))).length;
      const notCounted = inTab.filter(r => this._notCounted(r)).length;
      seg.push(['norate', 'No rate', noRate ? ` <span class="rt-amb">(${noRate})</span>` : ''],
        ['notcounted', 'Not counted', notCounted ? ` <span class="rt-amb">(${notCounted})</span>` : '']);
    }
    const tip = { norate: 'Items this project uses with neither a material nor a labour rate', notcounted: 'Items with a rate that no rule counts and nothing in this project measures' };
    m.querySelector('#rt-seg').innerHTML = seg.map(([v, l, x]) =>
      `<button type="button" class="rt-sg${this.filter === v ? ' on' : ''}" aria-pressed="${this.filter === v}" data-rt="filter" data-v="${v}" ${tip[v] ? `title="${tip[v]}"` : ''}>${l}${x}</button>`).join('');
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
    } else if (!L.labourNoteSeen && this._hasOldRates(L)) {
      b.hidden = false;
      b.className = 'rt-banner';
      b.innerHTML = `<span>Rates entered before labour was split out count as material. Move the labour part into the Labour column.</span><button type="button" class="rt-lk" data-rt="labour-ok">Got it</button>`;
    } else b.hidden = true;
  },

  // Material rates entered, but no labour anywhere yet: a library from before the split.
  _hasOldRates(L) {
    const its = Object.values(L.items || {});
    return its.some(it => it.rate != null) && !its.some(it => it.labour != null);
  },

  // Status pill: what the bill does with the item in this project.
  _pill(r) {
    if (r.orphan) return '<span class="rt-pill gry" title="Stored with the project, but no library item has this key any more">Not in library</span>';
    if (this._isPctRow(r)) {
      const rule = this.getRule(r.key);
      return rule && rule.factor > 0 ? (r.used ? '<span class="rt-pill ok">On</span>' : '<span class="rt-pill gry" title="The sections it is a percentage of have nothing priced in this bill">On · nothing to add</span>')
        : '<span class="rt-pill gry">Off — no % entered</span>';
    }
    const l = this._billLine(r.key);
    if (l && l.srcs && l.srcs.has('rule')) {
      const q = l.unit === 'm' ? Rates._group(String(Math.round(l.qty))) : Rates._group(String(l.qty));
      return `<span class="rt-pill blue" title="${escHtml(l.from.join(' · '))}">Rule · ${q} ${escHtml(l.unit)}</span>`;
    }
    const rule = this.getRule(r.key);
    if (r.used) return '<span class="rt-pill ok">In this project</span>';
    if (rule) {
      const b = BOQ.basis(rule.basis);
      return `<span class="rt-pill gry" title="The rule counts ${escHtml(b ? b.label.toLowerCase() : rule.basis)}, which this project has none of">Rule · none here</span>`;
    }
    if (this._notCounted(r)) return '<span class="rt-pill amb" title="Has a rate, but no rule, and nothing in this project measures it">Not counted</span>';
    return r.custom ? '<span class="rt-pill blue" title="Added to this project">Added</span>' : '<span class="rt-pill gry">Not used</span>';
  },
  _basisOptions(sel) {
    const groups = [];
    for (const b of BOQ.BASES) {
      let g = groups.find(x => x.name === b.group);
      if (!g) groups.push(g = { name: b.group, items: [] });
      g.items.push(b);
    }
    return `<option value=""${sel ? '' : ' selected'}>Measured</option>` + groups.map(g => `<optgroup label="${escHtml(g.name)}">${g.items.map(b =>
      `<option value="${escHtml(b.id)}"${b.id === sel ? ' selected' : ''}>${escHtml(b.label)}</option>`).join('')}</optgroup>`).join('');
  },
  _ofLabel(rule) {
    if (!rule || rule.basis !== 'pct') return 'Total';
    const of = rule.of && rule.of.length && !rule.of.includes('total') ? rule.of.map(id => this.CAT_WORD[id] || id).join(', ') : null;
    const part = rule.part === 'material' ? 'Material' : rule.part === 'labour' ? 'Labour' : '';
    return part ? `${part} in: ${of || 'total'}` : (of ? of.charAt(0).toUpperCase() + of.slice(1) : 'Total');
  },
  _inBill(key) {
    const l = this._billLine(key);
    return l && l.pct ? this.num2(l.amount) : '<span class="rt-muted">—</span>';
  },

  renderRows() {
    const m = document.getElementById('rates-modal');
    if (!m) return;
    const L = this.lib();
    const cur = escHtml(L.currency);
    const tbody = m.querySelector('#rt-rows');
    const vis = this._visible(this._rows || []);
    const pct = this.tab === 'allow';
    m.querySelector('#rt-thead').innerHTML = pct
      ? `<tr><th class="rt-c-key">Key</th><th>Description</th><th class="rt-c-unit">Unit</th><th class="rt-c-of">Percentage of</th><th class="rt-c-fac rt-num">%</th><th class="rt-c-bill rt-num">In this bill (${cur})</th><th class="rt-c-st">Status</th></tr>`
      : `<tr><th class="rt-c-key">Key</th><th>Description</th><th class="rt-c-unit">Unit</th><th class="rt-c-qf">Quantity from</th><th class="rt-c-fac rt-num">Factor</th>
         <th class="rt-c-rate rt-num">Material (${cur})</th><th class="rt-c-rate rt-num">Labour (${cur})</th><th class="rt-c-waste rt-num">Waste %</th>
         <th class="rt-c-sup">Supplier code</th><th class="rt-c-st">Status</th></tr>`;
    tbody.innerHTML = vis.map(r => {
      const d = escHtml(r.desc);
      const head = `<td class="rt-ro rt-code" title="${escHtml(r.key)}">${escHtml(r.key)}</td><td class="rt-ro" title="${d}">${d}</td><td class="rt-ro">${escHtml(r.unit || '')}</td>`;
      const rule = this.getRule(r.key);
      if (pct) {
        const f = rule && rule.basis === 'pct' && rule.factor != null ? this._num(rule.factor) : '';
        return `<tr data-key="${escHtml(r.key)}" data-cat="${r.cat}">${head}
          <td class="rt-ofc"><button type="button" class="rt-of" data-rt="of" data-key="${escHtml(r.key)}" aria-haspopup="dialog" aria-label="Percentage of, for ${d}"><span>${escHtml(this._ofLabel(rule))}</span>${this._icon('<path d="m4 6 4 4 4-4"/>', 10)}</button></td>
          <td><input class="rt-gc rt-num" data-f="pct" inputmode="decimal" value="${f}" placeholder="Off" aria-label="Percent for ${d}"></td>
          <td class="rt-ro rt-num" data-td="inbill">${this._inBill(r.key)}</td>
          <td class="rt-ro" data-td="st">${this._pill(r)}</td></tr>`;
      }
      const v = this.get(r.key, r.cat);
      const nr = !this.priced(v) && r.used ? 'rt-nr' : '';
      // An item priced in one column shows "—" in the other; with neither, the column it's normally priced in says "No rate".
      const lab = this.priceIn(r.key) === 'labour';
      const ph = (isLab) => this.priced(v) ? '—' : (isLab === lab ? 'No rate' : '—');
      const on = !!rule && rule.basis !== 'pct';
      return `<tr data-key="${escHtml(r.key)}" data-cat="${r.cat}">${head}
        <td class="rt-qf"><select class="rt-gc rt-sel${on ? ' rt-rule' : ''}" data-f="basis" aria-label="Quantity from, for ${d}">${this._basisOptions(on ? rule.basis : '')}</select></td>
        <td class="${on ? '' : 'rt-dis'}"><input class="rt-gc rt-num" data-f="factor" inputmode="decimal" value="${on ? this._num(rule.factor) : ''}" ${on ? '' : 'disabled'} aria-label="Factor for ${d}"></td>
        <td data-td="rate" class="${nr}"><input class="rt-gc rt-num" data-f="rate" inputmode="decimal" value="${this._rateText(v.rate)}" placeholder="${ph(false)}" aria-label="Material rate for ${d}"></td>
        <td data-td="labour" class="${nr}"><input class="rt-gc rt-num" data-f="labour" inputmode="decimal" value="${this._rateText(v.labour)}" placeholder="${ph(true)}" aria-label="Labour rate for ${d}"></td>
        ${r.cat === 'term' ? '<td class="rt-ro rt-num" title="Terminations are counted per cable end; no waste allowance">—</td>'
          : `<td><input class="rt-gc rt-num" data-f="waste" inputmode="decimal" value="${v.waste}" aria-label="Waste % for ${d}"></td>`}
        <td><input class="rt-gc" data-f="supplier" value="${escHtml(v.supplier)}" aria-label="Supplier code for ${d}"></td>
        <td class="rt-ro" data-td="st">${this._pill(r)}</td></tr>`;
    }).join('');
    const empty = m.querySelector('#rt-empty');
    empty.hidden = vis.length > 0;
    if (!vis.length) {
      empty.textContent = this.filter === 'norate' ? 'Every item this project uses in this category has a rate.'
        : this.filter === 'notcounted' ? 'Every item with a rate in this category is counted.'
        : this.filter === 'used' ? 'This project uses nothing in this category yet.' : 'No items match the filter.';
    }
    GridTable.attach(tbody, { cells: '[data-f]', onSelect: (info) => this._renderStat(info) });
    this._renderStat(null);
  },

  // ── "Percentage of" picker (Preliminaries & allowances tab) ─────────
  _closeOf() { const p = document.getElementById('rt-of-pop'); if (p) p.remove(); document.removeEventListener('mousedown', this._ofOutside, true); },
  _openOf(btn) {
    const key = btn.dataset.key;
    const wasOpen = document.getElementById('rt-of-pop');
    this._closeOf();
    if (wasOpen && wasOpen.dataset.key === key) return;
    const pop = document.createElement('div');
    pop.id = 'rt-of-pop';
    pop.className = 'rt-of-pop';
    pop.dataset.key = key;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Percentage of');
    // Redrawing replaces the controls: keep keyboard focus on the same one,
    // so Escape and Tab still land in the picker.
    const draw = () => {
      const a = document.activeElement;
      const sel = a && pop.contains(a) ? ['part', 'sec', 'of'].map(k => a.dataset[k] ? `[data-${k}="${a.dataset[k]}"]` : '').find(Boolean) : null;
      paint();
      if (sel) { const f = pop.querySelector(sel); if (f) f.focus(); }
    };
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this._closeOf(); const b = document.querySelector(`[data-rt="of"][data-key="${CSS.escape(key)}"]`); if (b) b.focus(); } });
    const paint = () => {
      const rule = this.getRule(key) || { basis: 'pct', factor: null, of: ['total'], part: 'all' };
      const total = !rule.of || !rule.of.length || rule.of.includes('total');
      const secs = this.CATS.filter(c => c.id !== 'allow');
      const bill = this._bill;
      const pk = rule.part === 'material' ? 'mat' : rule.part === 'labour' ? 'lab' : 'subtotal';
      const base = bill ? bill.sections.filter(s => s.cat !== 'allow' && (total || rule.of.includes(s.cat))).reduce((a, s) => a + s[pk], 0) : 0;
      pop.innerHTML = `
        <div class="bq-sh">Percentage of</div>
        <label class="rt-chk"><input type="radio" name="rt-of" data-of="total" ${total ? 'checked' : ''}><span>Total of every section</span></label>
        <label class="rt-chk"><input type="radio" name="rt-of" data-of="some" ${total ? '' : 'checked'}><span>These sections</span></label>
        <div class="rt-of-secs">${secs.map(c => `<label class="rt-chk"><input type="checkbox" data-sec="${c.id}" ${!total && rule.of.includes(c.id) ? 'checked' : ''}><span>${escHtml(c.label)}</span></label>`).join('')}</div>
        <div class="bq-sh" style="margin-top:6px">Of their</div>
        <div class="rt-seg rt-of-part">${[['all', 'Material + labour'], ['material', 'Material'], ['labour', 'Labour']].map(([v, l]) =>
          `<button type="button" class="rt-sg${(rule.part || 'all') === v ? ' on' : ''}" aria-pressed="${(rule.part || 'all') === v}" data-part="${v}">${l}</button>`).join('')}</div>
        <div class="rt-note-i">Base in this bill: <b>${this.money(base)}</b>. Never includes another allowance, so percentages don’t compound.</div>`;
    };
    const save = (patch) => {
      const cur = this.getRule(key) || { basis: 'pct', factor: null, of: ['total'], part: 'all' };
      this._storeRule(key, Object.assign({}, cur, { basis: 'pct' }, patch));
      this._afterRuleChange();
      draw();
    };
    pop.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.of === 'total') save({ of: ['total'] });
      else if (t.dataset.of === 'some' || t.dataset.sec) {
        const ids = [...pop.querySelectorAll('[data-sec]:checked')].map(x => x.dataset.sec);
        if (t.dataset.of === 'some' && !ids.length) { const c = pop.querySelector('[data-sec]'); c.checked = true; ids.push(c.dataset.sec); }
        save({ of: ids.length ? ids : ['total'] });
      }
    });
    pop.addEventListener('click', (e) => { const b = e.target.closest('[data-part]'); if (b) save({ part: b.dataset.part }); });
    draw();
    const dlg = btn.closest('.rt-dialog');
    dlg.appendChild(pop);
    const rb = btn.getBoundingClientRect(), db = dlg.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rb.left - db.left, db.width - 310)) + 'px';
    pop.style.top = (rb.bottom - db.top + 4) + 'px';
    this._ofOutside = (e) => { if (!pop.contains(e.target) && !e.target.closest('[data-rt="of"]')) this._closeOf(); };
    document.addEventListener('mousedown', this._ofOutside, true);
    const first = pop.querySelector('input:checked'); if (first) first.focus();
  },

  // ── Add item ───────────────────────────────────────────────────────
  UNITS: ['ea', 'm', 'm²', 'm³', 'sum', 'set', 'lot', 'hr', 'day', 'kg', '%'],
  PREFIX: { cable: 'CBL-', term: 'TRM-', equip: 'EQ-', prot: 'ACC-', civil: 'CIV-', allow: 'PCT-' },
  _allKeys() {
    const L = this.lib();
    return new Set([...this.catalogue().map(c => c.key), ...Object.keys(L.custom), ...Object.keys(L.items), ...(this._used || []).map(l => l.key)]);
  },
  openAdd() {
    let m = document.getElementById('rates-add-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'rates-add-modal';
      m.className = 'modal rt-imp-modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.setAttribute('aria-labelledby', 'rt-add-title');
      document.body.appendChild(m);
    }
    const cat0 = this.tab;
    const st = { cat: cat0, unit: cat0 === 'allow' ? '%' : cat0 === 'cable' ? 'm' : 'ea', desc: '', key: '', keyEdited: false, basis: '', factor: '1' };
    const cur = escHtml(this.currency());
    const suggest = () => (this.PREFIX[st.cat] || 'EQ-') + this.slug(st.desc).slice(0, 40).replace(/-$/, '');
    const unitOpts = () => this.UNITS.map(u => `<option${u === st.unit ? ' selected' : ''}>${escHtml(u)}</option>`).join('');
    m.innerHTML = `
      <div class="modal-content rt-dialog rt-add">
        <header class="rt-head">
          <span class="rt-mark bq-mark">${this._icon('<path d="M8 3v10M3 8h10"/>', 18)}</span>
          <div class="rt-head-text"><h3 id="rt-add-title">Add item</h3><div class="rt-head-sub">A rate item that isn’t drawn, e.g. a site sign or a meter kiosk</div></div>
          <button class="modal-close" data-ra="cancel" aria-label="Close">&times;</button>
        </header>
        <main class="rt-main rt-add-main">
          <div class="rt-add-row"><label class="rt-fld">Category<select id="ra-cat">${this.CATS.map(c => `<option value="${c.id}"${c.id === st.cat ? ' selected' : ''}>${escHtml(c.label)}</option>`).join('')}</select></label>
            <label class="rt-fld">Unit<select id="ra-unit">${unitOpts()}</select></label></div>
          <label class="rt-fld">Description<input type="text" id="ra-desc" placeholder="e.g. Site sign board, 2.4 × 1.2 m" autocomplete="off"></label>
          <label class="rt-fld">Key<input type="text" id="ra-key" class="rt-code" autocomplete="off" spellcheck="false"><small id="ra-key-hint">Suggested from the category and description. It never changes once created — the Excel round trip matches on it.</small></label>
          <div class="rt-add-sep"></div>
          <div class="rt-add-row rt-add-rule"><label class="rt-fld" id="ra-basis-f">Quantity from<select id="ra-basis">${this._basisOptions('')}</select></label>
            <label class="rt-fld rt-add-fac"><span id="ra-fac-l">Factor</span><input type="text" inputmode="decimal" id="ra-factor" value="1"></label></div>
          <div class="rt-add-prev" id="ra-prev"></div>
          <div class="rt-add-row" id="ra-rates"><label class="rt-fld"><span>Material rate (${cur}) <small class="rt-inl">optional</small></span><input type="text" inputmode="decimal" id="ra-mat" class="rt-num"></label>
            <label class="rt-fld"><span>Labour rate (${cur}) <small class="rt-inl">optional</small></span><input type="text" inputmode="decimal" id="ra-lab" class="rt-num"></label></div>
        </main>
        <footer class="rt-foot"><span class="rt-note-i">Saved with this project’s rate library</span><span class="rt-grow"></span>
          <button type="button" class="rt-btn" data-ra="cancel">Cancel</button>
          <button type="button" class="rt-btn primary" data-ra="add" id="ra-add">Add item</button></footer>
      </div>`;
    const $ = (id) => m.querySelector('#' + id);
    const keys = this._allKeys();
    const refresh = () => {
      const pct = st.cat === 'allow';
      if (!st.keyEdited) $('ra-key').value = st.desc.trim() ? suggest() : '';
      st.key = $('ra-key').value.trim().toUpperCase();
      $('ra-basis-f').hidden = pct;
      $('ra-rates').hidden = pct;
      $('ra-fac-l').textContent = pct ? 'Percent (%)' : 'Factor';
      $('ra-factor').disabled = !pct && !st.basis;
      $('ra-factor').closest('.rt-fld').classList.toggle('dis', !pct && !st.basis);
      const hint = $('ra-key-hint');
      let err = '';
      if (!st.desc.trim()) err = 'Enter a description.';
      else if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(st.key)) err = 'Use letters, digits, dots and dashes only.';
      else if (keys.has(st.key)) err = `${st.key} already exists — pick another key.`;
      hint.textContent = err && st.desc.trim() ? err : 'Suggested from the category and description. It never changes once created — the Excel round trip matches on it.';
      hint.classList.toggle('rt-bad', !!err && !!st.desc.trim());
      const f = GridTable.cleanNumber(st.factor);
      const fOk = pct ? (st.factor.trim() === '' || f > 0) : (!st.basis || f > 0);
      $('ra-factor').closest('.rt-fld').classList.toggle('bad', !fOk);
      // What the new rule would count in this project now.
      const bases = (this._bill && this._bill.bases) || {};
      let prev = '';
      if (pct) prev = st.factor.trim() === '' ? 'Off until a percent is entered.' : fOk ? `<span>In this bill:</span> <b>${this._num(f)} % of the total</b> <span class="rt-note-i">· change what it is a percentage of in the list</span>` : '';
      else if (!st.basis) prev = 'Measured: counted only where the drawings or schedules carry this key.';
      else if (fOk) {
        const b = BOQ.basis(st.basis) || { label: st.basis };
        const v = st.basis === 'fixed' ? 1 : (bases[st.basis] || 0);
        const q = st.unit === 'm' ? Math.round(f * v * 10) / 10 : Math.ceil(f * v - 1e-9);
        prev = `<span>In this project:</span> <b>${this._group(String(q))} ${escHtml(st.unit)}</b> <span class="rt-note-i">· ${st.basis === 'fixed' ? `Rule: fixed ${this._num(f)}` : `Rule: ${this._num(f)} × ${escHtml(b.label)} (${this._group(String(Math.round(v * 10) / 10))})`}</span>`;
      }
      $('ra-prev').innerHTML = prev;
      $('ra-add').disabled = !!err || !fOk;
    };
    const commit = () => {
      refresh();
      if ($('ra-add').disabled) return;
      const L = this.lib();
      const pct = st.cat === 'allow';
      const f = GridTable.cleanNumber(st.factor);
      L.custom[st.key] = { desc: st.desc.trim(), unit: st.unit, cat: st.cat };
      if (pct) this.setRule(st.key, { basis: 'pct', factor: f > 0 ? f : null, of: ['total'], part: 'all' });
      else if (st.basis) this.setRule(st.key, { basis: st.basis, factor: f });
      if (!pct) for (const [id, fld] of [['ra-mat', 'rate'], ['ra-lab', 'labour']]) {
        const n = GridTable.cleanNumber($(id).value);
        if (n >= 0) this.set(st.key, fld, n);
      }
      this._touch();
      m.style.display = 'none';
      this.tab = st.cat; this.filter = 'all'; this.query = '';
      this._used = this.usedLines();
      this.render();
      const tr = document.querySelector(`#rt-rows tr[data-key="${CSS.escape(st.key)}"]`);
      if (tr) { tr.scrollIntoView({ block: 'center' }); tr.classList.add('rt-flash'); setTimeout(() => tr.classList.remove('rt-flash'), 1600); }
      UI.toast(`Added ${st.key}.`, 'success');
    };
    m.oninput = (e) => {
      const t = e.target;
      if (t.id === 'ra-desc') st.desc = t.value;
      else if (t.id === 'ra-key') { st.keyEdited = t.value.trim() !== ''; }
      else if (t.id === 'ra-factor') st.factor = t.value;
      else return;
      refresh();
    };
    m.onchange = (e) => {
      const t = e.target;
      if (t.id === 'ra-cat') {
        st.cat = t.value;
        if (st.cat === 'allow') { st.unit = '%'; st.factor = ''; }
        else if (st.unit === '%') { st.unit = st.cat === 'cable' ? 'm' : 'ea'; st.factor = '1'; }
        $('ra-unit').innerHTML = unitOpts(); $('ra-factor').value = st.factor;
        st.basis = $('ra-basis').value;
      } else if (t.id === 'ra-unit') st.unit = t.value;
      else if (t.id === 'ra-basis') st.basis = t.value;
      else return;
      refresh();
    };
    m.onclick = (e) => {
      const b = e.target.closest('[data-ra]');
      if (!b) { if (e.target === m) m.style.display = 'none'; return; }
      if (b.dataset.ra === 'cancel') m.style.display = 'none';
      else if (b.dataset.ra === 'add') commit();
    };
    m.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); m.style.display = 'none'; }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); commit(); }
    };
    if (st.cat === 'allow') st.factor = '';
    $('ra-factor').value = st.factor;
    refresh();
    m.style.display = 'flex';
    setTimeout(() => $('ra-desc').focus(), 30);
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
  HEAD: ['Key', 'Category', 'Description', 'Unit', 'Material rate', 'Labour rate', 'Waste %', 'Supplier code', 'Quantity from', 'In this project'],
  _exportRows() {
    const rows = (this._rows || this.rows(this.usedLines())).filter(r => !r.orphan);
    const order = this.CATS.map(c => c.id);
    rows.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
    const cat = id => (this.CATS.find(c => c.id === id) || {}).label || id;
    return rows.map(r => {
      const v = this.get(r.key, r.cat);
      return [r.key, cat(r.cat), r.desc, r.unit, v.rate == null ? '' : v.rate, v.labour == null ? '' : v.labour, v.waste, v.supplier, this.ruleText(this.getRule(r.key)), r.used ? 'Yes' : ''];
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
      ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 44 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 18 }, { wch: 24 }, { wch: 14 }];
      ws['!autofilter'] = { ref: `A1:J${rows.length + 1}` };
      const about = XLSX.utils.aoa_to_sheet([
        ['ProtectionPro rate library'],
        [`Project: ${AppState.projectName || ''}`],
        [`Currency: ${this.currency()}`],
        [''],
        ['Change Material rate, Labour rate, Waste % or Supplier code on the Rates sheet, then import the file back.'],
        ['Rows are matched on Key. Do not change the Key column.'],
        ['Description and Unit are for reading only; they are not imported for existing keys.'],
        ['A new row with a new Key and a Description is added as a new item.'],
        ['Material and labour are per unit. Waste % adds to material only; labour is paid on the measured quantity.'],
        ['An item with both rates blank has "no rate": it is left out of the BOQ total and flagged.'],
        ['Quantity from: "measured" (counted from the drawings and schedules), "fixed 1" (a lump sum),'],
        ['  "1 x erven" / "0.02 x LV cable, m" (a factor times a project count), "8% of total" or'],
        ['  "5% of cables, civils" / "3% of labour in total" (percentage lines), "default", or blank for no change.'],
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
      key: col(/^key$/), mat: col(/^material\b/), lab: col(/^labou?r\b/), rate: col(/^rate\b/),
      waste: col(/^waste/), supplier: col(/^supplier/), desc: col(/^desc/), unit: col(/^unit$/), cat: col(/^cat/),
      rule: col(/^quantity from/),
    };
    // A sheet with a single "Rate" column (older exports, hand-made sheets):
    // that price goes to material, or to labour for labour items.
    const single = C.mat < 0 && C.lab < 0 && C.rate >= 0;
    if (C.mat < 0 && C.lab < 0 && C.rate < 0 && C.waste < 0 && C.supplier < 0 && C.rule < 0) return { error: 'The sheet has a Key column but no Material rate, Labour rate, Waste % or Supplier code column to import.' };
    const known = new Map(this.rows(this._used || []).filter(r => !r.orphan).map(r => [r.key, r]));
    const legacy = this.legacyKeyMap();
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
      let key = String(cell(r, C.key) ?? '').trim().toUpperCase();
      if (!key) continue;
      if (!known.has(key) && legacy[key]) key = legacy[key];   // a sheet exported before keys came from library ids
      plan.rows++;
      if (plan.seen.has(key)) { plan.ignored.push({ key, desc: '', why: 'key repeated in the file; first row used' }); continue; }
      plan.seen.add(key);
      const item = known.get(key);
      const toLab = single && this.priceIn(key) === 'labour';
      const matCol = single ? (toLab ? -1 : C.rate) : C.mat;
      const labCol = single ? (toLab ? C.rate : -1) : C.lab;
      const rate = matCol >= 0 ? numOrNull(cell(r, matCol)) : null;
      const labour = labCol >= 0 ? numOrNull(cell(r, labCol)) : null;
      const waste = C.waste >= 0 ? numOrNull(cell(r, C.waste)) : null;
      const supplier = C.supplier >= 0 ? String(cell(r, C.supplier) ?? '').trim() : null;
      const rule = C.rule >= 0 ? this.parseRule(cell(r, C.rule)) : { none: true };
      if (!item) {
        const desc = String(cell(r, C.desc) ?? '').trim();
        if (!desc) { plan.ignored.push({ key, desc: '—', why: 'no such item and no description; ignored' }); continue; }
        if (rate && rate.bad) { plan.errors.push({ key, desc, field: 'Material rate', from: '', to: String(cell(r, matCol)), why: 'not a number; row skipped' }); continue; }
        if (labour && labour.bad) { plan.errors.push({ key, desc, field: 'Labour rate', from: '', to: String(cell(r, labCol)), why: 'not a number; row skipped' }); continue; }
        plan.newItems.push({
          key, desc, unit: String(cell(r, C.unit) ?? '').trim() || 'ea',
          cat: catId(cell(r, C.cat)) || this.guessCat(key),
          rate: rate ? rate.v : null, labour: labour ? labour.v : null,
          waste: waste && !waste.bad ? waste.v : null, supplier: supplier || '',
          rule: rule.rule !== undefined ? rule.rule : undefined,
        });
        if (rule.error) plan.errors.push({ key, desc, field: 'Quantity from', from: '', to: String(cell(r, C.rule)), why: rule.error + '; rule not applied' });
        continue;
      }
      const cur = this.get(key, item.cat);
      const stored = (this.lib().items[key]) || {};
      let changed = false;
      const push = (field, from, to, kind) => { plan.changes.push({ key, desc: item.desc, field, from, to, kind }); changed = true; };
      for (const [f, got, ci, name] of [['rate', rate, matCol, 'Material rate'], ['labour', labour, labCol, 'Labour rate']]) {
        if (!got) continue;
        if (got.bad) plan.errors.push({ key, desc: item.desc, field: name, from: this._rateText(cur[f]), to: String(cell(r, ci)), why: 'not a number; skipped' });
        else if (got.v == null && cur[f] != null) push(f, cur[f], null, 'cleared');
        else if (got.v != null && cur[f] == null) push(f, null, got.v, 'filled');
        else if (got.v != null && Math.abs(got.v - cur[f]) > 1e-9) push(f, cur[f], got.v, 'changed');
      }
      if (waste) {
        if (waste.bad) plan.errors.push({ key, desc: item.desc, field: 'Waste %', from: String(cur.waste), to: String(cell(r, C.waste)), why: 'not a number; skipped' });
        else if (waste.v != null && Math.abs(waste.v - cur.waste) > 1e-9) push('waste', cur.waste, waste.v, 'changed');
        else if (waste.v == null && stored.waste != null) push('waste', cur.waste, null, 'changed');
      }
      if (supplier !== null && supplier !== (cur.supplier || '')) push('supplier', cur.supplier || '', supplier, 'changed');
      // A bad rule is reported and skipped; the row's other fields still apply.
      if (rule.error) plan.errors.push({ key, desc: item.desc, field: 'Quantity from', from: this.ruleText(this.getRule(key)), to: String(cell(r, C.rule)), why: rule.error + '; rule not applied' });
      else if (!rule.none) {
        const was = this.getRule(key);
        if (rule.reset) { if ('rule' in stored) { plan.changes.push({ key, desc: item.desc, field: 'rule', from: this.ruleText(was), to: 'default', value: undefined, kind: 'changed' }); changed = true; } }
        else if (!this._sameRule(was, rule.rule)) { plan.changes.push({ key, desc: item.desc, field: 'rule', from: this.ruleText(was), to: this.ruleText(rule.rule), value: rule.rule, kind: 'changed' }); changed = true; }
      }
      if (!changed) plan.unchanged++;
    }
    // Library items with a rate that the file doesn't mention (for "Clear missing").
    for (const [k, it] of Object.entries(this.lib().items)) {
      if ((it.rate != null || it.labour != null) && !plan.seen.has(k) && known.has(k)) plan.clearable.push({ key: k, desc: known.get(k).desc, from: it.rate, fromLab: it.labour });
    }
    return plan;
  },

  applyImport(plan, { addNew = true, clearMissing = false } = {}) {
    const before = JSON.parse(JSON.stringify(this.lib()));
    let n = 0;
    for (const c of plan.changes) { if (c.field === 'rule') this.setRule(c.key, c.value); else this.set(c.key, c.field, c.to); n++; }
    if (addNew) {
      const L = this.lib();
      for (const it of plan.newItems) {
        L.custom[it.key] = { desc: it.desc, unit: it.unit, cat: it.cat };
        if (it.rate != null) this.set(it.key, 'rate', it.rate);
        if (it.labour != null) this.set(it.key, 'labour', it.labour);
        if (it.waste != null) this.set(it.key, 'waste', it.waste);
        if (it.supplier) this.set(it.key, 'supplier', it.supplier);
        if (it.rule !== undefined) this.setRule(it.key, it.rule);
        n++;
      }
    }
    if (clearMissing) for (const c of plan.clearable) { this.set(c.key, 'rate', null); this.set(c.key, 'labour', null); n++; }
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
    const money = f => f === 'rate' || f === 'labour';
    const fmt = (field, v) => v == null || v === '' ? '—' : money(field) ? this.num2(Number(v)) : escHtml(String(v));
    const label = { rate: 'Material rate', labour: 'Labour rate', waste: 'Waste %', supplier: 'Supplier code', rule: 'Quantity from' };
    const both = (m, l) => (m == null && l == null) ? '—' : `${m == null ? '—' : this.num2(Number(m))} / ${l == null ? '—' : this.num2(Number(l))}`;
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
          : `<span class="rt-pill amb">Changed</span> <span class="rt-note-i">${money(c.field) ? pct(c.from, c.to) : ''}</span>`;
        out.push(`<tr><td class="rt-code">${escHtml(c.key)}</td><td>${escHtml(c.desc)}</td><td>${label[c.field]}</td><td class="rt-num">${fmt(c.field, c.from)}</td><td class="rt-num"><b>${fmt(c.field, c.to)}</b></td><td>${pillHtml}</td></tr>`);
      }
      for (const it of plan.newItems) out.push(`<tr${state.addNew ? '' : ' class="rt-off"'}><td class="rt-code">${escHtml(it.key)}</td><td>${escHtml(it.desc)}</td><td>New item <span class="rt-note-i">material / labour</span></td><td class="rt-num"></td><td class="rt-num"><b>${both(it.rate, it.labour)}</b></td><td><span class="rt-pill ok">New item</span> <span class="rt-note-i">${state.addNew ? 'not in the library' : 'will not be added'}</span></td></tr>`);
      if (state.clearMissing) for (const c of plan.clearable) out.push(`<tr><td class="rt-code">${escHtml(c.key)}</td><td>${escHtml(c.desc)}</td><td>Material / labour</td><td class="rt-num">${both(c.from, c.fromLab)}</td><td class="rt-num"><b>—</b></td><td><span class="rt-pill amb">Cleared</span> <span class="rt-note-i">missing from the file</span></td></tr>`);
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

  // ── My default rates (saved in the user's account) ─────────────────
  // The banner reads the default synchronously, so it is cached here once the user's
  // copy has been fetched after sign-in (Auth → loadDefaultFromServer).
  _default: null,
  _defaultFor: null,
  _readDefault() { return this._default; },
  async loadDefaultFromServer(userId) {
    if (this._defaultFor === userId) return;
    this._default = null;                    // never show the previous user's
    try {
      const res = await API.getUserDefaultRates();
      let d = res && res.data ? res.data : null;
      if (!d) {
        // Moved once from this browser's old copy into the account.
        let legacy = null;
        try { const raw = localStorage.getItem(this.DEFAULT_KEY); legacy = raw ? JSON.parse(raw) : null; } catch (e) { legacy = null; }
        if (legacy) {
          try {
            await API.saveUserDefaultRates(legacy);
            try { localStorage.removeItem(this.DEFAULT_KEY); } catch (e) { /* private mode */ }
            d = legacy;
            if (typeof UI !== 'undefined') UI.toast('Your default rates were moved from this browser into your account.', 'info', 6000);
          } catch (e) { d = legacy; }   // keep the browser copy; usable now, retried next sign-in
        }
      }
      this._default = d;
      this._defaultFor = userId;
      if (document.getElementById('rt-banner')) this._renderBanner();
    } catch (e) {
      console.error('Could not load default rates:', e);
    }
  },
  async saveDefault() {
    const L = this.lib();
    const doc = { currency: L.currency, defaultWaste: L.defaultWaste, items: L.items, custom: L.custom, savedAt: new Date().toISOString() };
    try {
      await API.saveUserDefaultRates(doc);
    } catch (e) { UI.toast('Could not save your default rates: ' + e.message, 'error'); return; }
    this._default = doc;
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
