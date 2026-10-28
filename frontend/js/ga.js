/* ProtectionPro — Distribution board general arrangement (GA) layout.
 *
 * Turns a board's circuit schedule (comp.props.circuits + accessories + the
 * incomer from the SLD) into a physical front-view layout: every device sized
 * from a generic library (DIN modules, MCCB frames), packed onto DIN-rail rows
 * and, when the enclosure is "Auto", fitted into the smallest standard
 * enclosure that holds the devices, a spare allowance and the heat they shed.
 *
 * The layout is DERIVED — only the user's choices are stored, in
 * comp.props.ga:
 *   { mounting: 'any'|'wall'|'floor', enclosure: 'auto'|<GA_ENCLOSURES key>|'custom',
 *     custom: {w,h,d}, spare_pct, delta_t, incomer_a,
 *     order: [item keys], over: { <item key>: { kind, rowbreak } },
 *     extras: [{ id, kind, label, modules, heat_w }] }
 * Absent ⇒ defaults, so boards never visited stay byte-identical.
 *
 * Item keys: 'inc' · 'acc:<id>' · 'way:<id>' · 'rcd:<el group>' · 'x:<id>'.
 *
 * Sizes are GENERIC (17.5 mm DIN module, typical MCCB frames and enclosure
 * sizes) and the heat check is the indicative surface-area method — confirm
 * against the manufacturer's catalogue before ordering.
 */

const GA_MODULE_MM = 17.5;     // one DIN pole
const GA_ROW_PITCH = 125;      // rail-to-rail incl. wiring trunking
const GA_DEV_H = 90;           // standard DIN device height
const GA_SIDE_MM = 50;         // side trunking / clearance each side
const GA_TOP_MM = 60;          // top trunking
const GA_BOTTOM_MM = 110;      // N/PE bars + gland clearance
const GA_STRIP_BOTTOM_MM = 30; // a section's upper strip (no bars of its own) — wiring clearance only
const GA_MCCB_GAP = 30;        // vertical gap between stacked frames
const GA_STD_AMPS = [40, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600];

// Indicative wall / floor-standing enclosures (mm). Sorted by volume at use.
const GA_ENCLOSURES = [
  { key: 'w300x400',  label: '300 × 400 × 150 wall',   w: 300,  h: 400,  d: 150, type: 'wall' },
  { key: 'w400x500',  label: '400 × 500 × 200 wall',   w: 400,  h: 500,  d: 200, type: 'wall' },
  { key: 'w500x600',  label: '500 × 600 × 200 wall',   w: 500,  h: 600,  d: 200, type: 'wall' },
  { key: 'w600x800',  label: '600 × 800 × 250 wall',   w: 600,  h: 800,  d: 250, type: 'wall' },
  { key: 'w600x1000', label: '600 × 1000 × 250 wall',  w: 600,  h: 1000, d: 250, type: 'wall' },
  { key: 'w800x1000', label: '800 × 1000 × 300 wall',  w: 800,  h: 1000, d: 300, type: 'wall' },
  { key: 'w800x1200', label: '800 × 1200 × 300 wall',  w: 800,  h: 1200, d: 300, type: 'wall' },
  { key: 'w1000x1200', label: '1000 × 1200 × 300 wall', w: 1000, h: 1200, d: 300, type: 'wall' },
  { key: 'f800x1600', label: '800 × 1600 × 400 floor', w: 800,  h: 1600, d: 400, type: 'floor' },
  { key: 'f800x2000', label: '800 × 2000 × 400 floor', w: 800,  h: 2000, d: 400, type: 'floor' },
  { key: 'f1000x2000', label: '1000 × 2000 × 500 floor', w: 1000, h: 2000, d: 500, type: 'floor' },
  { key: 'f1200x2000', label: '1200 × 2000 × 600 floor', w: 1200, h: 2000, d: 600, type: 'floor' },
];

// Moulded-case / power frames: max rating, 3-pole width, height, W per pole at In.
const GA_MCCB_FRAMES = [
  { max_a: 125,  w: 76,  h: 130, loss: 8 },
  { max_a: 250,  w: 105, h: 165, loss: 15 },
  { max_a: 400,  w: 140, h: 257, loss: 25 },
  { max_a: 630,  w: 210, h: 280, loss: 40 },
  { max_a: 1250, w: 320, h: 400, loss: 70 },
  { max_a: 1600, w: 420, h: 440, loss: 100 },
];

// Items an installer adds that are not ways. modules = DIN width.
const GA_EXTRA_KINDS = [
  { key: 'spare',    label: 'Spare space',        modules: 2, heat_w: 0 },
  { key: 'contactor', label: 'Contactor',         modules: 3, heat_w: 3 },
  { key: 'timer',    label: 'Time switch / timer', modules: 2, heat_w: 1 },
  { key: 'meter',    label: 'Energy meter',       modules: 6, heat_w: 2 },
  { key: 'psu',      label: 'Control PSU / transformer', modules: 4, heat_w: 6 },
  { key: 'terminal', label: 'Terminal block',     modules: 4, heat_w: 0 },
  { key: 'custom',   label: 'Other device',       modules: 2, heat_w: 2 },
];

// Internal separation between compartments (IEC 61439-2 forms): partition
// thickness + terminal clearance each side, mm. Indicative.
// Interactive compartment sizing: snap step and smallest cell (mm), and the
// margin round the enclosure in the SVG (its viewBox units are mm).
const GA_DRAG_SNAP_MM = 10;
const GA_MIN_CELL_MM = 100;
const GA_SVG_MARGIN = 70;

const GA_PARTITION_MM = { '1': 0, '2a': 20, '2b': 20, '3a': 40, '3b': 40, '4a': 60, '4b': 60 };

const GA_KIND_FILL = {
  incomer: '#c0392b', mccb: '#8e44ad', mcb: '#2e75b6', rcbo: '#17a2b8', rcd: '#e08a00',
  acc: '#2e8b57', extra: '#7f8c8d', spare: 'none',
};

const GA = {
  _zoom: 1,
  _brush: null,       // painting grid cells: a section id or 'spare' (null = not painting)
  _boardId: null,
  _host: null,
  _last: null,        // last computed layout, for export

  // ── Stored choices ────────────────────────────────────────────────
  cfg(comp) {
    const g = (comp && comp.props.ga && typeof comp.props.ga === 'object') ? comp.props.ga : {};
    return {
      mounting: g.mounting || 'any',
      enclosure: g.enclosure || 'auto',
      // Typed values are clamped to sane ranges: a stray 1e9 % spare or a 0 K
      // rise would otherwise stall the packer or divide the heat check by zero.
      custom: (() => { const cu = (g.custom && typeof g.custom === 'object') ? g.custom : {};
        const dim = (v, dflt, lo) => { const n = Number(v); return n > 0 ? Math.min(5000, Math.max(lo, n)) : dflt; };
        return { w: dim(cu.w, 600, 100), h: dim(cu.h, 800, 100), d: dim(cu.d, 250, 50) }; })(),
      spare_pct: g.spare_pct != null && isFinite(Number(g.spare_pct)) ? Math.min(200, Math.max(0, Number(g.spare_pct))) : 20,
      delta_t: g.delta_t != null && Number(g.delta_t) > 0 ? Math.min(60, Number(g.delta_t)) : 20,
      incomer_a: g.incomer_a != null && g.incomer_a !== '' ? Number(g.incomer_a) : null,
      order: Array.isArray(g.order) ? g.order.slice() : [],
      over: (g.over && typeof g.over === 'object') ? g.over : {},
      extras: Array.isArray(g.extras) ? g.extras : [],
      section_layout: g.section_layout === 'stack' ? 'stack' : g.section_layout === 'grid' ? 'grid' : 'side',
      grid_cols: Number(g.grid_cols) > 0 ? Math.min(8, Math.floor(Number(g.grid_cols))) : null,
      grid_rows: Number(g.grid_rows) > 0 ? Math.min(8, Math.floor(Number(g.grid_rows))) : null,
      section_dims: (g.section_dims && typeof g.section_dims === 'object') ? g.section_dims : {},
      // Grid column widths / row heights as proportions (dragged on screen);
      // absent or the wrong length ⇒ equal cells.
      grid_col_f: this._fracs(g.grid_col_f),
      grid_row_f: this._fracs(g.grid_row_f),
      // Painted grid: one entry per cell, row by row — a section id or 'spare'.
      // Absent (or the wrong length for the grid) ⇒ sections in schedule order.
      grid_cells: Array.isArray(g.grid_cells) ? g.grid_cells.map(v => String(v == null ? 'spare' : v)) : null,
    };
  },

  _fracs(a) {
    return Array.isArray(a) && a.length && a.every(v => Number(v) > 0 && isFinite(Number(v))) ? a.map(Number) : null;
  },

  _write(comp, patch) {
    const cur = (comp.props.ga && typeof comp.props.ga === 'object') ? comp.props.ga : {};
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();
    comp.props.ga = Object.assign({}, cur, patch);
    AppState.dirty = true;
  },

  // ── Library lookups ───────────────────────────────────────────────
  _frame(a) {
    return GA_MCCB_FRAMES.find(f => a <= f.max_a) || GA_MCCB_FRAMES[GA_MCCB_FRAMES.length - 1];
  },

  _mcbLoss(a) {      // W per pole at rated current
    const t = [[6, 1.0], [10, 1.5], [16, 2.0], [20, 2.2], [25, 2.5], [32, 3.0], [40, 3.5], [50, 4.5], [63, 5.0]];
    for (const [max, w] of t) if (a <= max) return w;
    return 5.0;
  },

  _stdAmps(a) {
    return GA_STD_AMPS.find(s => s >= a) || GA_STD_AMPS[GA_STD_AMPS.length - 1];
  },

  // ── Items from the schedule ───────────────────────────────────────
  _vll(comp) { return (Number(comp.props.voltage_kv) || 0.4) * 1000; },

  _wayIb(c, vll) {
    if (typeof DBSchedule !== 'undefined' && DBSchedule._wayCurrentA) return DBSchedule._wayCurrentA(c, vll);
    const va = (Number(c.load_va) || 0) * demandFactorOr1(c.demand_factor);
    const is3 = c.poles === '3P' || c.phase === 'RWB';
    const v = is3 ? vll : vll / Math.sqrt(3);
    return v > 0 ? va / v : 0;
  },

  // Device for a protective rating: DIN MCB up to 63 A, a frame above.
  _breaker(a, poles, kind, ib) {
    const n = poles === 3 ? 3 : 1;
    const loadRatio = a > 0 ? Math.min(1.5, (ib || 0) / a) : 0;
    if (a > 63 || kind === 'mccb') {
      const f = this._frame(a);
      const w = f.w * (n === 1 ? 0.34 : 1);
      return { form: 'frame', kind: 'mccb', w, h: f.h, heat: f.loss * n * loadRatio * loadRatio, poles: n };
    }
    const rcbo = kind === 'rcbo';
    const mods = (n === 3 ? 3 : 1) + (rcbo ? 1 : 0);
    const loss = this._mcbLoss(a) * n * loadRatio * loadRatio + (rcbo ? 1 : 0);
    return { form: 'din', kind: rcbo ? 'rcbo' : 'mcb', modules: mods, heat: loss, poles: n };
  },

  items(comp) {
    const vll = this._vll(comp);
    const cfg = this.cfg(comp);
    const ways = Array.isArray(comp.props.circuits) ? comp.props.circuits : [];
    const out = [];
    const ov = (key) => cfg.over[key] || {};

    const sectioned = (typeof DBSections !== 'undefined') && DBSections.has(comp);
    const secOf = (o) => sectioned ? (DBSections.of(comp, o) || {}).id : undefined;
    const demandOf = (list) => list.reduce((n, c) => n + this._wayIb(c, vll), 0) * (Number(comp.props.board_diversity) || 1);

    if (!sectioned) {
      // Incomer: SLD device rating, else the user's number, else estimated from demand.
      let incA = cfg.incomer_a, basis = 'entered';
      if (incA == null) {
        const inc = (typeof DBAccessories !== 'undefined') ? DBAccessories.incomer(comp) : { rating_a: null };
        if (inc && inc.rating_a) { incA = Number(inc.rating_a); basis = 'SLD'; }
      }
      if (incA == null) {
        incA = this._stdAmps(Math.max(40, demandOf(ways) * 1.25)); basis = 'estimated';
      }
      const incDev = incA > 63
        ? Object.assign(this._breaker(incA, 3, 'mccb', incA * 0.7), { w: this._frame(incA).w * 1.33 })
        : { form: 'din', kind: 'mcb', modules: 4, heat: this._mcbLoss(incA) * 3 * 0.5, poles: 4 };
      out.push(Object.assign(incDev, { key: 'inc', label: 'Incomer', sub: `${incA} A 4P`, role: 'incomer', basis }));
    } else {
      // One incomer per section: its declared rating, else estimated from its own demand.
      for (const sec of DBSections.list(comp)) {
        const mine = ways.filter(c => secOf(c) === sec.id);
        let incA = Number(sec.incomer_a) > 0 ? Number(sec.incomer_a) : null, basis = 'section';
        if (incA == null) { incA = this._stdAmps(Math.max(40, demandOf(mine) * 1.25)); basis = 'estimated'; }
        const poles = sec.incomer_poles === '3P' ? '3P' : '4P';
        const incDev = incA > 63
          ? Object.assign(this._breaker(incA, 3, 'mccb', incA * 0.7), { w: this._frame(incA).w * 1.33 })
          : { form: 'din', kind: 'mcb', modules: poles === '3P' ? 3 : 4, heat: this._mcbLoss(incA) * 3 * 0.5, poles: poles === '3P' ? 3 : 4 };
        out.push(Object.assign(incDev, { key: 'inc:' + sec.id, label: 'Incomer', sub: `${incA} A ${poles}`, role: 'incomer', basis, sec: sec.id }));
      }
    }

    // Board accessories (SPDs, indicators, metering, utilities)
    if (typeof DBAccessories !== 'undefined') {
      for (const a of DBAccessories.list(comp)) {
        const kind = DBAccessories._kind ? DBAccessories._kind(a.kind) : null;
        let mods = 2, heat = 1;
        if (a.kind === 'indicator') { mods = (a.phases === 'RWB' || !a.phases) ? 3 : 1; heat = 0.5; }
        else if (a.kind === 'spd') { mods = 4; heat = 0; }
        else if (a.kind === 'metering') { mods = 6; heat = 2; }
        out.push({ key: 'acc:' + a.id, form: 'din', kind: 'acc', modules: mods, heat,
          label: (kind && kind.label) || a.label || a.kind, sub: '', role: 'accessory', sec: secOf(a) });
      }
    }

    // Earth-leakage groups → one shared RCD each, ahead of its first way
    const gk = (c) => String(c.el_group || '').trim() + (sectioned ? '|' + secOf(c) : '');
    const groups = new Map();
    for (const c of ways) {
      const g = String(c.el_group || '').trim();
      if (g && !groups.has(gk(c))) groups.set(gk(c), []);
      if (g) groups.get(gk(c)).push(c);
    }
    const seen = new Set();
    for (const c of ways) {
      const g = String(c.el_group || '').trim();
      if (g && !seen.has(gk(c))) {
        seen.add(gk(c));
        const members = groups.get(gk(c));
        const three = DBSchedule.elPoles(comp, g) === '3P' || members.some(m => m.poles === '3P' || m.phase === 'RWB');
        const rated = Math.max(40, ...members.map(m => Number(m.breaker_a) || 0));
        const rating = this._stdAmps(Math.min(100, rated));
        out.push({ key: 'rcd:' + g + (sectioned ? ':' + secOf(c) : ''), form: 'din', kind: 'rcd', modules: three ? 4 : 2,
          heat: three ? 4 : 2, label: 'RCD ' + g,
          sub: `${rating} A ${(comp.props.el_ratings && comp.props.el_ratings[g]) || 30} mA`, role: 'rcd', sec: secOf(c) });
      }
      const key = 'way:' + (c.id || c.way);
      const a = Number(c.breaker_a) || 0;
      const is3 = c.poles === '3P' || c.phase === 'RWB';
      const dev = this._breaker(a, is3 ? 3 : 1, ov(key).kind, this._wayIb(c, vll));
      out.push(Object.assign(dev, {
        key, label: String(c.way), sub: `${a} A ${c.curve || ''}${is3 ? ' 3P' : ''}`.trim(),
        title: `Way ${c.way}: ${c.description || ''}`, role: 'way', way: c, sec: secOf(c),
      }));
    }

    for (const x of cfg.extras) {
      const kd = GA_EXTRA_KINDS.find(k => k.key === x.kind) || GA_EXTRA_KINDS[GA_EXTRA_KINDS.length - 1];
      out.push({ key: 'x:' + x.id, form: 'din', kind: x.kind === 'spare' ? 'spare' : 'extra',
        modules: Math.min(72, Math.max(1, Math.round(Number(x.modules) || kd.modules))),
        heat: Number(x.heat_w) || 0, label: x.label || kd.label, sub: '', role: 'extra', extra: x, sec: secOf(x) });
    }

    for (const it of out) it.rowbreak = !!ov(it.key).rowbreak;
    return this._ordered(out, cfg.order);
  },

  _ordered(items, order) {
    if (!order.length) return items;
    const idx = new Map(order.map((k, i) => [k, i]));
    const known = items.filter(i => idx.has(i.key)).sort((a, b) => idx.get(a.key) - idx.get(b.key));
    const rest = items.filter(i => !idx.has(i.key));
    return known.concat(rest);
  },

  // ── Packing ───────────────────────────────────────────────────────
  // Frames stack in a left column; DIN devices fill rail rows, never split.
  // `opt.noBars`: a box with no N/PE bars of its own (an upper strip of a
  // painted section) — only wiring clearance at the bottom.
  pack(items, enc, sparePct, opt) {
    const W = enc.w, H = enc.h;
    const bottom = opt && opt.noBars ? GA_STRIP_BOTTOM_MM : GA_BOTTOM_MM;
    const frames = items.filter(i => i.form === 'frame');
    const din = items.filter(i => i.form === 'din');
    const colW = frames.length ? Math.max(...frames.map(f => f.w)) + 20 : 0;
    const usable = W - 2 * GA_SIDE_MM - colW;
    const perRow = Math.max(0, Math.floor(usable / GA_MODULE_MM));
    const rowsAvail = Math.max(0, Math.floor((H - GA_TOP_MM - bottom) / GA_ROW_PITCH));
    const warnings = [];
    const placed = [];

    // frame column
    let fy = GA_TOP_MM;
    for (const f of frames) {
      placed.push({ item: f, x: GA_SIDE_MM, y: fy, w: f.w, h: f.h });
      fy += f.h + GA_MCCB_GAP;
    }
    const colUsed = frames.length ? fy - GA_MCCB_GAP - GA_TOP_MM : 0;
    const colOK = colUsed <= H - GA_TOP_MM - bottom;

    // rows
    const used = din.reduce((n, d) => n + d.modules, 0);
    const spareMods = Math.ceil(used * (sparePct / 100));
    const seq = din.map(d => ({ item: d, modules: d.modules }));
    let row = 0, col = 0, wide = false;
    for (const s of seq) {
      if (s.modules > perRow) { wide = true; }
      if (s.item.rowbreak && col > 0) { row++; col = 0; }
      if (col + s.modules > perRow && col > 0) { row++; col = 0; }
      placed.push({ item: s.item, row, col, modules: s.modules,
        x: GA_SIDE_MM + colW + col * GA_MODULE_MM,
        y: GA_TOP_MM + row * GA_ROW_PITCH + (GA_ROW_PITCH - GA_DEV_H) / 2 - 10,
        w: s.modules * GA_MODULE_MM, h: GA_DEV_H });
      col += s.modules;
    }
    // spare allowance fills the rest of the last row, then further rows
    let left = spareMods;
    const spares = [];
    while (left > 0 && perRow > 0) {
      const room = perRow - col;
      if (room <= 0) { row++; col = 0; continue; }
      const take = Math.min(room, left);
      const p = { item: { key: 'spare-' + spares.length, form: 'din', kind: 'spare', label: 'Spare', sub: '', heat: 0, modules: take, role: 'allowance' },
        row, col, modules: take, x: GA_SIDE_MM + colW + col * GA_MODULE_MM,
        y: GA_TOP_MM + row * GA_ROW_PITCH + (GA_ROW_PITCH - GA_DEV_H) / 2 - 10, w: take * GA_MODULE_MM, h: GA_DEV_H };
      placed.push(p); spares.push(p);
      col += take; left -= take;
    }
    const rowsNeeded = din.length || spareMods ? row + 1 : 0;
    const fits = colOK && !wide && rowsNeeded <= rowsAvail && (din.length === 0 || perRow > 0);
    if (wide) warnings.push('A device is wider than the rail — pick a wider enclosure.');
    if (!colOK) warnings.push('The moulded-case devices do not fit the height of this enclosure.');
    return { placed, perRow, rowsAvail, rowsNeeded, colW, colUsed, usedModules: used, spareModules: spareMods, fits, warnings,
      noBars: !!(opt && opt.noBars), totalModules: perRow * rowsAvail };
  },

  // IEC 60890-style effective cooling surface (m²) for a free / wall box
  _surface(enc) {
    const w = enc.w / 1000, h = enc.h / 1000, d = enc.d / 1000;
    return enc.type === 'floor'
      ? 1.8 * h * (w + d) + 1.4 * w * d
      : 1.4 * w * (h + d) + 1.8 * d * h;
  },
  _capacity(enc, dT) { return 5.5 * this._surface(enc) * dT; },

  // ── Layout for a board ────────────────────────────────────────────
  // `ov` (drag preview only): { cfg: patch, enc: the enclosure to keep }.
  layout(comp, ov) {
    const cfg = Object.assign(this.cfg(comp), ov && ov.cfg);
    if (ov && ov.enc) { cfg._encFixed = ov.enc; cfg._encAuto = !!ov.auto; }
    const items = this.items(comp);
    if (typeof DBSections !== 'undefined' && DBSections.has(comp)) return this._layoutSections(comp, cfg, items);
    const heat = items.reduce((n, i) => n + (i.heat || 0), 0) * 1.1;   // +10 % busbars / wiring
    const sorted = GA_ENCLOSURES.slice().sort((a, b) => a.w * a.h * a.d - b.w * b.h * b.d);
    const pool = sorted.filter(e => cfg.mounting === 'any' || e.type === cfg.mounting);
    let enc = null, res = null, auto = false, note = null;

    if (cfg.enclosure === 'custom') {
      enc = { key: 'custom', label: `${cfg.custom.w} × ${cfg.custom.h} × ${cfg.custom.d} custom`,
        w: +cfg.custom.w || 600, h: +cfg.custom.h || 800, d: +cfg.custom.d || 250, type: (+cfg.custom.h || 0) >= 1400 ? 'floor' : 'wall' };
    } else if (cfg.enclosure !== 'auto') {
      enc = GA_ENCLOSURES.find(e => e.key === cfg.enclosure) || null;
    }
    if (!enc) {
      auto = true;
      for (const e of pool) {
        const r = this.pack(items, e, cfg.spare_pct);
        if (r.fits && heat <= this._capacity(e, cfg.delta_t)) { enc = e; res = r; break; }
      }
      if (!enc) {       // heat-limited: smallest that fits on space, flagged
        for (const e of pool) {
          const r = this.pack(items, e, cfg.spare_pct);
          if (r.fits) { enc = e; res = r; note = 'No listed enclosure also clears the heat limit — ventilate/cool it or split the board.'; break; }
        }
      }
      if (!enc) {
        enc = pool[pool.length - 1] || sorted[sorted.length - 1];
        res = this.pack(items, enc, cfg.spare_pct);
        note = 'Larger than the biggest listed enclosure — split into several sections or use a custom size.';
      }
    }
    if (!res) res = this.pack(items, enc, cfg.spare_pct);

    const cap = this._capacity(enc, cfg.delta_t);
    const warnings = res.warnings.slice();
    if (note) warnings.push(note);
    if (!res.fits && !auto) warnings.push(`Does not fit: needs ${res.rowsNeeded} rail rows, ${res.rowsAvail} available${res.perRow ? '' : ' (no rail width)'}.`);
    if (heat > cap) warnings.push(`Heat ${heat.toFixed(0)} W exceeds the ${cap.toFixed(0)} W the enclosure sheds at a ${cfg.delta_t} K rise.`);
    const total = res.perRow * res.rowsAvail;
    return { comp, cfg, items, enc, auto, ...res, heat, capacity: cap,
      utilisation: total ? Math.min(100, (res.usedModules / total) * 100) : 0,
      totalModules: total, warnings };
  },

  // ── Sectioned boards: one compartment per section ──────────────────
  // Compartments sit side by side (full height, widths fitted to their
  // devices) or stacked (full width, heights fitted), separated by a partition
  // whose thickness follows the form of separation. A manual width/height per
  // section (ga.section_dims) overrides the fitted size.
  _layoutSections(comp, cfg, items) {
    const secs = DBSections.list(comp);
    const grid = cfg.section_layout === 'grid';
    const side = cfg.section_layout === 'side';
    // Columns/rows: either or both may be set; blank = automatic (near-square).
    // Sections fill row by row in schedule order; a grid too small grows rows.
    const nsec = secs.length || 1;
    let gcols = cfg.grid_cols || 0, grows = cfg.grid_rows || 0;
    if (!gcols && !grows) gcols = Math.ceil(Math.sqrt(nsec));
    if (!gcols) gcols = Math.ceil(nsec / grows);
    if (!grows || gcols * grows < nsec) grows = Math.ceil(nsec / gcols);
    const gridGrew = !!(cfg.grid_cols && cfg.grid_rows && cfg.grid_cols * cfg.grid_rows < nsec);
    const form = comp.props.segregation || '2b';
    const part = GA_PARTITION_MM[form] != null ? GA_PARTITION_MM[form] : 20;
    const heat = items.reduce((n, i) => n + (i.heat || 0), 0) * 1.1;
    const by = new Map(secs.map(sec => [sec.id, items.filter(i => i.sec === sec.id)]));
    const step = 50;

    const fit = (enc) => {
      const comps = [];
      let ok = true;
      if (grid) {
        // Columns × rows across the enclosure, partitions between; column
        // widths / row heights follow the dragged proportions, else equal.
        // Each cell belongs to a section (painted, else schedule order) or is
        // spare; a section's cells — any shape, an L included — are split into
        // rectangles its devices flow through, top to bottom.
        const cws = this._split(enc.w - part * (gcols - 1), gcols, cfg.grid_col_f);
        const chs = this._split(enc.h - part * (grows - 1), grows, cfg.grid_row_f);
        const owner = this._cellOwners(cfg, secs, gcols * grows);
        const G = { gcols, grows, cws, chs, part };
        secs.forEach((sec) => {
          const its = by.get(sec.id) || [];
          const heat = its.reduce((n, it) => n + (it.heat || 0), 0) * 1.1;
          const strips = this._strips(owner, sec.id, G);
          if (!strips.length) {
            ok = false;
            comps.push({ sec, items: its, strips: [], parts: [], missing: true, x: 0, y: 0, w: 0, h: 0, heat,
              res: { fits: false, warnings: ['has no cells — paint at least one cell for it.'], usedModules: 0, spareModules: 0,
                perRow: 0, rowsAvail: 0, rowsNeeded: 0, totalModules: 0 } });
            return;
          }
          const parts = this._packStrips(its, strips, cfg.spare_pct);
          const fits = parts.every(pt => pt.res.fits);
          if (!fits) ok = false;
          const bb = this._bbox(strips);
          comps.push({ sec, items: its, strips, parts, shape: strips.length > 1 ? 'L' : 'rect',
            cells: owner.filter(o => o === sec.id).length, size: bb.w, manual: true, ...bb, heat,
            res: {
              fits, warnings: [].concat(...parts.map(pt => pt.res.warnings)),
              usedModules: parts.reduce((n, pt) => n + pt.res.usedModules, 0),
              spareModules: parts.reduce((n, pt) => n + pt.res.spareModules, 0),
              totalModules: parts.reduce((n, pt) => n + pt.res.totalModules, 0),
              perRow: parts[0].res.perRow, rowsAvail: parts[0].res.rowsAvail,
              rowsNeeded: Math.max(...parts.map(pt => pt.res.rowsNeeded)),
            } });
        });
        const spares = this._strips(owner, 'spare', G);
        return { ok, comps, used: enc.w, cws, chs, owner, spares };
      }
      for (const sec of secs) {
        const its = by.get(sec.id) || [];
        const man = Number((cfg.section_dims[sec.id] || {})[side ? 'w' : 'h']) || 0;
        const lim = side ? enc.w : enc.h;
        let size = man || 0, res = null;
        if (!size) {
          for (let v = 200; v <= lim; v += step) {
            const r = this.pack(its, side ? { w: v, h: enc.h } : { w: enc.w, h: v }, cfg.spare_pct);
            if (r.fits) { size = v; res = r; break; }
          }
        }
        if (!size) { size = lim; ok = false; }
        comps.push({ sec, items: its, size, res, manual: !!man });
      }
      const used = comps.reduce((n, c) => n + c.size, 0) + part * (comps.length - 1);
      const lim = side ? enc.w : enc.h;
      if (used > lim) ok = false;
      const extra = Math.max(0, lim - used) / comps.length;
      let pos = 0;
      for (const c of comps) {
        c.size = Math.round(c.size + extra);
        c.x = side ? pos : 0; c.y = side ? 0 : pos;
        c.w = side ? c.size : enc.w; c.h = side ? enc.h : c.size;
        c.res = this.pack(c.items, { w: c.w, h: c.h }, cfg.spare_pct);
        if (!c.res.fits) ok = false;
        c.heat = c.items.reduce((n, i) => n + (i.heat || 0), 0) * 1.1;
        pos += c.size + part;
      }
      return { ok, comps, used };
    };

    const sorted = GA_ENCLOSURES.slice().sort((a, b) => a.w * a.h * a.d - b.w * b.h * b.d);
    const pool = sorted.filter(e => cfg.mounting === 'any' || e.type === cfg.mounting);
    let enc = null, r = null, auto = false, note = null;
    if (cfg._encFixed) {
      enc = cfg._encFixed; auto = !!cfg._encAuto;
    } else if (cfg.enclosure === 'custom') {
      enc = { key: 'custom', label: `${cfg.custom.w} × ${cfg.custom.h} × ${cfg.custom.d} custom`,
        w: +cfg.custom.w || 600, h: +cfg.custom.h || 800, d: +cfg.custom.d || 250, type: (+cfg.custom.h || 0) >= 1400 ? 'floor' : 'wall' };
    } else if (cfg.enclosure !== 'auto') {
      enc = GA_ENCLOSURES.find(e => e.key === cfg.enclosure) || null;
    }
    if (!enc) {
      auto = true;
      for (const e of pool) {
        const t = fit(e);
        if (t.ok && heat <= this._capacity(e, cfg.delta_t)) { enc = e; r = t; break; }
      }
      if (!enc) {
        for (const e of pool) {
          const t = fit(e);
          if (t.ok) { enc = e; r = t; note = 'No listed enclosure also clears the heat limit — ventilate/cool it or split the board.'; break; }
        }
      }
      if (!enc) {
        enc = pool[pool.length - 1] || sorted[sorted.length - 1];
        r = fit(enc);
        note = 'Larger than the biggest listed enclosure — use a custom size or separate enclosures per section.';
      }
    }
    if (!r) r = fit(enc);

    const cap = this._capacity(enc, cfg.delta_t);
    const warnings = [];
    if (note) warnings.push(note);
    if (grid && gridGrew) warnings.push(`${cfg.grid_cols} × ${cfg.grid_rows} cells cannot hold ${secs.length} sections — grown to ${gcols} × ${grows}.`);
    for (const c of r.comps) {
      for (const w of c.res.warnings) warnings.push(`${c.sec.name}: ${w}`);
      if (!c.res.fits && !c.res.warnings.length) warnings.push(`${c.sec.name}: does not fit its compartment (${c.w} × ${c.h} mm).`);
    }
    if (!grid && r.used > (side ? enc.w : enc.h)) warnings.push(`Compartments need ${r.used} mm ${side ? 'width' : 'height'} incl. partitions; the enclosure has ${side ? enc.w : enc.h} mm.`);
    if (heat > cap) warnings.push(`Heat ${heat.toFixed(0)} W exceeds the ${cap.toFixed(0)} W the enclosure sheds at a ${cfg.delta_t} K rise.`);
    const totalMods = r.comps.reduce((n, c) => n + (c.res.totalModules != null ? c.res.totalModules : c.res.perRow * c.res.rowsAvail), 0);
    const usedMods = r.comps.reduce((n, c) => n + c.res.usedModules, 0);
    const first = (r.comps.find(c => !c.missing) || r.comps[0]).res;
    return { comp, cfg, items, enc, auto, comps: r.comps, part, form, side, grid, gcols, grows, cws: r.cws, chs: r.chs,
      owner: r.owner, spares: r.spares || [], heat, capacity: cap,
      placed: [], perRow: first.perRow, rowsAvail: first.rowsAvail,
      rowsNeeded: Math.max(...r.comps.map(c => c.res.rowsNeeded)), colW: 0,
      usedModules: usedMods, spareModules: r.comps.reduce((n, c) => n + c.res.spareModules, 0),
      fits: r.ok, utilisation: totalMods ? Math.min(100, usedMods / totalMods * 100) : 0,
      totalModules: totalMods, warnings };
  },

  // Start (mm) of the partition before cell k.
  _edge(sizes, k, part) { return sizes.slice(0, k).reduce((n, v) => n + v, 0) + part * (k - 1); },

  // Owner of each grid cell (row by row): the painted section id, else the
  // sections in schedule order; anything else is 'spare'.
  _cellOwners(cfg, secs, n) {
    const ids = new Set(secs.map(x => x.id));
    if (cfg.grid_cells && cfg.grid_cells.length === n) return cfg.grid_cells.map(v => ids.has(v) ? v : 'spare');
    return Array.from({ length: n }, (_, i) => (i < secs.length ? secs[i].id : 'spare'));
  },

  // The cells owned by `id` as rectangles (mm): runs along each row, merged
  // down where the next row's run spans the same columns. Top to bottom.
  _strips(owner, id, G) {
    const { gcols, grows, cws, chs, part } = G;
    const at = (sizes, i) => sizes.slice(0, i).reduce((n, v) => n + v, 0) + part * i;
    const span = (sizes, a, b) => sizes.slice(a, b + 1).reduce((n, v) => n + v, 0) + part * (b - a);
    const runs = [];
    for (let r = 0; r < grows; r++) {
      for (let c = 0; c < gcols; c++) {
        if (owner[r * gcols + c] !== id) continue;
        let c2 = c;
        while (c2 + 1 < gcols && owner[r * gcols + c2 + 1] === id) c2++;
        const up = runs.find(u => u.c0 === c && u.c1 === c2 && u.r1 === r - 1);
        if (up) up.r1 = r; else runs.push({ r0: r, r1: r, c0: c, c1: c2 });
        c = c2;
      }
    }
    return runs.map(u => ({ ...u, x: at(cws, u.c0), y: at(chs, u.r0), w: span(cws, u.c0, u.c1), h: span(chs, u.r0, u.r1) }));
  },

  _bbox(rects) {
    const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
    return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
  },

  // Devices flow through a section's strips in order: each upper strip takes
  // as many as fit (no N/PE bars of its own), the last takes the rest plus
  // the spare allowance and carries the section's N/PE bars.
  _packStrips(items, strips, sparePct) {
    let rest = items.slice();
    return strips.map((st, j) => {
      const box = { w: st.w, h: st.h };
      if (j === strips.length - 1) return { ...st, res: this.pack(rest, box, sparePct) };
      let lo = 0, hi = rest.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (this.pack(rest.slice(0, mid), box, 0, { noBars: true }).fits) lo = mid; else hi = mid - 1;
      }
      const res = this.pack(rest.slice(0, lo), box, 0, { noBars: true });
      rest = rest.slice(lo);
      return { ...st, res };
    });
  },

  // `total` mm shared by n cells in proportion to `fr` (equal without it).
  _split(total, n, fr) {
    const f = fr && fr.length === n ? fr : Array(n).fill(1);
    const sum = f.reduce((a, v) => a + v, 0) || 1;
    const out = f.map(v => Math.floor(total * v / sum));
    out[n - 1] += total - out.reduce((a, v) => a + v, 0);    // rounding to the last cell
    return out;
  },

  // ── Drawing primitives (one list feeds SVG, PDF and DXF) ───────────
  shapes(L) {
    const s = [];
    const { enc } = L;
    s.push({ t: 'rect', x: 0, y: 0, w: enc.w, h: enc.h, layer: 'ENCLOSURE' });
    if (!L.comps) {
      this._boxShapes(s, { w: enc.w, h: enc.h }, L, 0, 0, true, null, L.comp);
      return s;
    }
    // Partitions first, then each compartment's own rails, bars and devices.
    L.comps.forEach((c, i) => {
      if (L.grid) return;
      if (i && L.part > 0) {
        const px = L.side ? c.x - L.part : 0, py = L.side ? 0 : c.y - L.part;
        s.push({ t: 'rect', x: px, y: py, w: L.side ? L.part : enc.w, h: L.side ? enc.h : L.part, layer: 'PARTITION', kind: 'part',
          title: `Partition — form ${L.form}` });
      }
    });
    if (L.grid) {
      this._gridShapes(s, L);
      return s;
    }
    for (const c of L.comps) {
      const col = DBSections.color(c.sec);
      s.push({ t: 'rect', x: c.x + 4, y: c.y + 4, w: c.w - 8, h: c.h - 8, layer: 'COMPARTMENT', thin: true, color: col,
        title: `${c.sec.name} — ${c.w} × ${c.h} mm` });
      s.push({ t: 'text', x: c.x + 10, y: c.y + 14, s: `${c.sec.name.toUpperCase()}  ${c.w} × ${c.h}`, size: 9, layer: 'TEXT', color: col, bold: true });
      this._boxShapes(s, { w: c.w, h: c.h }, c.res, c.x, c.y, false, c.sec, L.comp);
    }
    return s;
  },

  // Painted grid: section regions tinted (an L-shaped one reads as one
  // compartment), partitions only where two different owners meet, spare
  // cells labelled, then each section's devices strip by strip — its N/PE
  // bars in the bottom strip only.
  _gridShapes(s, L) {
    const { gcols, grows, cws, chs, part, owner } = L;
    const at = (sizes, i) => sizes.slice(0, i).reduce((n, v) => n + v, 0) + part * i;
    const own = (r, c) => owner[r * gcols + c];
    const colOf = (id) => id === 'spare' ? '#9e9e9e' : DBSections.color(L.comps.find(c => c.sec.id === id)?.sec);
    const title = `Partition — form ${L.form}`;
    // tints: each cell, the gap to a same-owner neighbour right / below, and
    // the crossing square when all four cells round it share the owner
    const tint = (x, y, w, h, id) => s.push({ t: 'rect', x, y, w, h, kind: 'tint', color: colOf(id), layer: 'COMPARTMENT' });
    for (let r = 0; r < grows; r++) for (let c = 0; c < gcols; c++) {
      const id = own(r, c), x = at(cws, c), y = at(chs, r);
      const right = c + 1 < gcols && own(r, c + 1) === id, below = r + 1 < grows && own(r + 1, c) === id;
      tint(x, y, cws[c], chs[r], id);
      if (part > 0 && right) tint(x + cws[c], y, part, chs[r], id);
      if (part > 0 && below) tint(x, y + chs[r], cws[c], part, id);
      if (part > 0 && right && below && own(r + 1, c + 1) === id) tint(x + cws[c], y + chs[r], part, part, id);
    }
    if (part > 0) {
      // vertical partition segments between columns c-1 | c, row by row
      for (let c = 1; c < gcols; c++) for (let r = 0; r < grows; r++) {
        if (own(r, c - 1) !== own(r, c)) s.push({ t: 'rect', x: at(cws, c) - part, y: at(chs, r), w: part, h: chs[r], layer: 'PARTITION', kind: 'part', title });
      }
      // horizontal segments between rows r-1 / r, column by column
      for (let r = 1; r < grows; r++) for (let c = 0; c < gcols; c++) {
        if (own(r - 1, c) !== own(r, c)) s.push({ t: 'rect', x: at(cws, c), y: at(chs, r) - part, w: cws[c], h: part, layer: 'PARTITION', kind: 'part', title });
      }
      // crossings: partition unless all four cells share an owner
      for (let r = 1; r < grows; r++) for (let c = 1; c < gcols; c++) {
        const a = own(r - 1, c - 1);
        if (!(a === own(r - 1, c) && a === own(r, c - 1) && a === own(r, c))) {
          s.push({ t: 'rect', x: at(cws, c) - part, y: at(chs, r) - part, w: part, h: part, layer: 'PARTITION', kind: 'part', title });
        }
      }
    }
    for (const st of L.spares || []) {
      s.push({ t: 'text', x: st.x + st.w / 2, y: st.y + st.h / 2, s: 'SPARE', size: 28, anchor: 'middle', layer: 'TEXT', color: '#9e9e9e', bold: true });
    }
    for (const c of L.comps) {
      if (c.missing) continue;
      const col = DBSections.color(c.sec);
      const first = c.parts[0];
      const dims = c.parts.length === 1 ? `  ${first.w} × ${first.h}` : '';
      s.push({ t: 'text', x: first.x + 10, y: first.y + 14, s: `${c.sec.name.toUpperCase()}${dims}`, size: 9, layer: 'TEXT', color: col, bold: true });
      for (const pt of c.parts) this._boxShapes(s, { w: pt.w, h: pt.h }, pt.res, pt.x, pt.y, false, c.sec, L.comp);
    }
  },

  // Rails, N/PE bars and devices of one box (the whole enclosure, or a compartment).
  // Each device's rect + labels share a `grp` (its item key): the SVG wraps
  // them in one group that the DXF export turns into a block with attributes.
  _boxShapes(s, box, res, ox, oy, inset, sec, comp) {
    if (inset) s.push({ t: 'rect', x: 12, y: 12, w: box.w - 24, h: box.h - 24, layer: 'ENCLOSURE', thin: true });
    for (let r = 0; r < res.rowsAvail; r++) {
      const y = GA_TOP_MM + r * GA_ROW_PITCH + GA_ROW_PITCH / 2 - 10;
      s.push({ t: 'rect', x: ox + GA_SIDE_MM + res.colW, y: oy + y - 17.5, w: res.perRow * GA_MODULE_MM, h: 35, layer: 'RAIL', thin: true });
    }
    const barY = box.h - GA_BOTTOM_MM + 28;
    for (const [i, n] of (res.noBars ? [] : ['N', 'PE']).entries()) {
      s.push({ t: 'rect', x: ox + GA_SIDE_MM, y: oy + barY + i * 30, w: box.w - 2 * GA_SIDE_MM, h: 14, layer: 'BARS', kind: 'bar' });
      s.push({ t: 'text', x: ox + GA_SIDE_MM + 4, y: oy + barY + i * 30 + 10.5, s: n + ' bar' + (sec ? ' · ' + sec.name : ''), size: 8, layer: 'TEXT' });
    }
    for (const p of res.placed) {
      const it = p.item;
      const kind = it.role === 'incomer' ? 'incomer' : it.kind;
      const x = ox + p.x, y = oy + p.y;
      const grp = { key: it.key, block: 'GA_' + (kind === 'spare' ? 'SPARE' : kind), at: [x + p.w / 2, y + p.h / 2],
        attrs: comp ? this._dxfAttrs(comp, it, p) : null };
      s.push({ t: 'rect', x, y, w: p.w, h: p.h, layer: 'DEVICES', kind, dash: kind === 'spare', grp, title: it.title || `${it.label} ${it.sub || ''}`.trim() });
      if (kind === 'spare') continue;
      const narrow = p.w < 30;
      if (it.role === 'way' || it.role === 'incomer') {
        s.push({ t: 'text', x: x + p.w / 2, y: y + 14, s: String(it.role === 'incomer' ? 'INC' : it.label), size: narrow ? 6 : 8, anchor: 'middle', layer: 'TEXT', light: true, grp, attr: 'LABEL' });
        s.push({ t: 'text', x: x + p.w / 2, y: y + p.h - 8, s: String(it.sub || '').split(' ')[0] + (it.sub ? 'A' : ''), size: narrow ? 5.5 : 7, anchor: 'middle', layer: 'TEXT', light: true, grp, attr: 'RATING' });
      } else {
        const lab = narrow ? String(it.label).slice(0, 4) : String(it.label).slice(0, Math.floor(p.w / 5.5));
        s.push({ t: 'text', x: x + p.w / 2, y: y + p.h / 2, s: lab, size: 6.5, anchor: 'middle', layer: 'TEXT', light: true, grp, attr: 'LABEL' });
      }
    }
  },

  // ── SVG ───────────────────────────────────────────────────────────
  _esc(v) { return typeof escHtml === 'function' ? escHtml(String(v)) : String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },

  // `opt.interactive`: add the on-screen partition drag handles (never in an
  // export); `opt.drag`: the live readout while one is dragged.
  svg(L, opt) {
    const M = GA_SVG_MARGIN, enc = L.enc;
    const W = enc.w + M * 2, H = enc.h + M * 2;
    let open = null;
    const bodies = this.shapes(L).map(sh => {
      // Wrap a device's rect + labels in one group (a DXF block + attributes).
      let pre = '';
      if (open && (!sh.grp || sh.grp !== open)) { pre += '</g>'; open = null; }
      if (sh.grp && sh.grp !== open) {
        open = sh.grp;
        pre += `<g data-dxf-block="${this._esc(sh.grp.block)}" data-dxf-at="${sh.grp.at[0] + M},${sh.grp.at[1] + M}"`
          + `${sh.grp.attrs ? ` data-dxf-attrs="${this._esc(JSON.stringify(sh.grp.attrs))}"` : ''} data-dxf-layer="DEVICES">`;
      }
      return pre + body(sh);
    }).join('') + (open ? '</g>' : '');
    function body(sh) { return GA._shapeSvg(sh, M); }
    const dim = (x1, y1, x2, y2, label, rot) => `<g stroke="#555" stroke-width="1" fill="#222" font-size="16" font-family="Arial,sans-serif" data-dxf-layer="DIMENSIONS">
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" stroke="none"${rot ? ` transform="rotate(-90 ${(x1 + x2) / 2} ${(y1 + y2) / 2})"` : ''}>${label}</text></g>`;
    const dims = dim(M, M - 24, M + enc.w, M - 24, `${enc.w} mm`, false)
      + dim(M - 24, M, M - 24, M + enc.h, `${enc.h} mm`, true);
    const handles = opt && opt.interactive
      ? (this._brush && L.grid ? this._cellsSvg(L, M) : '') + this._handlesSvg(L, M, opt.drag) : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#fff"/>${dims}${bodies}${handles}</svg>`;
  },

  // ── Interactive compartment sizing ───────────────────────────────
  // The boundaries a user can drag: grid column / row partitions, or the
  // partitions between side-by-side / stacked compartments.
  // Each: { id 'col:k'|'row:k'|'side:k'|'stack:k', axis 'x'|'y', pos (mm, partition centre), sizes, k }.
  _boundaries(L) {
    const out = [];
    if (!L.comps || L.comps.length < 2) return out;
    const p = L.part;
    if (L.grid) {
      // A grid line with the same owner on both sides all along it has no
      // partition to drag (it runs inside one merged compartment).
      const own = (r, c) => (L.owner || [])[r * L.gcols + c];
      const colSplits = (k) => Array.from({ length: L.grows }, (_, r) => r).some(r => own(r, k - 1) !== own(r, k));
      const rowSplits = (k) => Array.from({ length: L.gcols }, (_, c) => c).some(c => own(k - 1, c) !== own(k, c));
      for (let k = 1; k < L.gcols; k++) if (colSplits(k)) out.push({ id: 'col:' + k, axis: 'x', k, sizes: L.cws, pos: this._edge(L.cws, k, p) + p / 2 });
      for (let k = 1; k < L.grows; k++) if (rowSplits(k)) out.push({ id: 'row:' + k, axis: 'y', k, sizes: L.chs, pos: this._edge(L.chs, k, p) + p / 2 });
    } else {
      const sizes = L.comps.map(c => L.side ? c.w : c.h);
      for (let k = 1; k < L.comps.length; k++) {
        out.push({ id: (L.side ? 'side:' : 'stack:') + k, axis: L.side ? 'x' : 'y', k, sizes, pos: this._edge(sizes, k, p) + p / 2 });
      }
    }
    return out;
  },

  _handlesSvg(L, M, drag) {
    const { enc } = L;
    const u = 1 / Math.max(0.1, this._zoom || 1);     // one screen pixel, in drawing units
    // Grips sit mid-way along the first cell's edge — never where a column and
    // a row partition cross — and are drawn above every hit band.
    // On a painted grid the grip goes on a drawn partition segment (two
    // different owners either side), else the first cell's edge.
    const mid = (sizes, i) => sizes.slice(0, i).reduce((n, v) => n + v, 0) + L.part * i + sizes[i] / 2;
    const gripAt = (b) => {
      if (!L.grid || !L.cws) return b.axis === 'x' ? { x: M + b.pos, y: M + enc.h / 2 } : { x: M + enc.w / 2, y: M + b.pos };
      const own = (r, c) => (L.owner || [])[r * L.gcols + c];
      if (b.axis === 'x') {
        let r = 0;
        while (r < L.grows && own(r, b.k - 1) === own(r, b.k)) r++;
        return { x: M + b.pos, y: M + mid(L.chs, r < L.grows ? r : 0) };
      }
      let c = 0;
      while (c < L.gcols && own(b.k - 1, c) === own(b.k, c)) c++;
      return { x: M + mid(L.cws, c < L.gcols ? c : 0), y: M + b.pos };
    };
    const all = this._boundaries(L);
    const head = (b, inner, cls) => {
      const vert = b.axis === 'x', what = vert ? 'width' : 'height';
      const active = drag && drag.id === b.id;
      return `<g class="ga-handle${cls || ''}${active ? ' dragging' : ''}" data-ga-handle="${b.id}" data-dxf-skip${cls ? '' : ` tabindex="0" role="separator"
        aria-orientation="${vert ? 'vertical' : 'horizontal'}" aria-label="Drag to change the compartment ${what}s (arrow keys: 10 mm, Shift: 50 mm)"`}
        style="cursor:${vert ? 'col-resize' : 'row-resize'};touch-action:none"><title>Drag to resize — ${b.sizes[b.k - 1]} | ${b.sizes[b.k]} mm</title>${inner}</g>`;
    };
    const bands = all.map(b => {
      const vert = b.axis === 'x';
      const x = M + b.pos, y = M + b.pos;
      const inner = vert
        ? `<rect x="${x - 9 * u}" y="${M}" width="${18 * u}" height="${numAttr(enc.h)}" fill="transparent"/><line class="ga-handle-line" vector-effect="non-scaling-stroke" x1="${x}" y1="${M}" x2="${x}" y2="${M + enc.h}"/>`
        : `<rect x="${M}" y="${y - 9 * u}" width="${numAttr(enc.w)}" height="${18 * u}" fill="transparent"/><line class="ga-handle-line" vector-effect="non-scaling-stroke" x1="${M}" y1="${y}" x2="${M + enc.w}" y2="${y}"/>`;
      return head(b, inner);
    }).join('');
    const grips = all.map(b => {
      const vert = b.axis === 'x';
      const g = gripAt(b);
      let inner = vert
        ? `<rect class="ga-grip" x="${g.x - 5 * u}" y="${g.y - 22 * u}" width="${10 * u}" height="${44 * u}" rx="${5 * u}"/>`
        : `<rect class="ga-grip" x="${g.x - 22 * u}" y="${g.y - 5 * u}" width="${44 * u}" height="${10 * u}" rx="${5 * u}"/>`;
      if (drag && drag.id === b.id) {
        const txt = `${b.sizes[b.k - 1]} mm  |  ${b.sizes[b.k]} mm`;
        const ly = vert ? g.y - 56 * u : g.y - 38 * u;
        inner += `<g class="ga-drag-label"><rect x="${g.x - 80 * u}" y="${ly}" width="${160 * u}" height="${24 * u}" rx="${4 * u}"/>`
          + `<text x="${numAttr(g.x)}" y="${ly + 17 * u}" text-anchor="middle" font-size="${13 * u}">${txt}</text></g>`;
      }
      return head(b, inner, ' ga-handle-grip');
    }).join('');
    return bands + grips;
  },

  // ── Painting grid cells ───────────────────────────────────────────
  _brushColor(L, id) {
    if (id === 'spare') return '#9e9e9e';
    const c = (L.comps || []).find(x => x.sec.id === id);
    return c ? DBSections.color(c.sec) : '#555';
  },

  _ownerName(L, id) {
    if (id === 'spare') return 'Spare';
    const c = (L.comps || []).find(x => x.sec.id === id);
    return c ? c.sec.name : 'Spare';
  },

  // One overlay per cell while a brush is picked: click / drag to paint.
  _cellsSvg(L, M) {
    const { gcols, grows, cws, chs, part, owner } = L;
    const at = (sizes, i) => sizes.slice(0, i).reduce((n, v) => n + v, 0) + part * i;
    const brush = this._brush, bc = this._brushColor(L, brush), bn = this._ownerName(L, brush);
    let out = '';
    for (let r = 0; r < grows; r++) for (let c = 0; c < gcols; c++) {
      const i = r * gcols + c, mine = owner[i] === brush;
      out += `<rect class="ga-cell${mine ? ' mine' : ''}" data-ga-cell="${i}" data-dxf-skip tabindex="0" role="button"
        aria-label="Cell row ${r + 1}, column ${c + 1}: ${this._esc(this._ownerName(L, owner[i]))}. Enter paints it ${this._esc(bn)}"
        x="${at(cws, c) + M}" y="${at(chs, r) + M}" width="${escHtml(cws[c])}" height="${escHtml(chs[r])}" style="--brush:${bc};touch-action:none"><title>${this._esc(this._ownerName(L, owner[i]))} — click or drag to paint ${this._esc(bn)}</title></rect>`;
    }
    return out;
  },

  // Grid cell (index) under a point in mm, or null.
  _cellAt(L, pt) {
    const { gcols, grows, cws, chs, part } = L;
    const find = (sizes, v) => {
      let a = 0;
      for (let i = 0; i < sizes.length; i++) {
        if (v >= a - part / 2 && v <= a + sizes[i] + part / 2) return i;
        a += sizes[i] + part;
      }
      return null;
    };
    const c = find(cws, pt.x), r = find(chs, pt.y);
    return c == null || r == null || c >= gcols || r >= grows ? null : r * gcols + c;
  },

  // Press on a cell with a brush: paint it and every cell dragged over;
  // live preview, one write (one undo step) on release.
  _paintDown(e, cellEl) {
    const comp = this.board(), L0 = this._last, brush = this._brush;
    if (!comp || !L0 || !L0.grid || !brush) return;
    e.preventDefault();
    const cells = L0.owner.slice();
    let changed = false, raf = 0;
    const preview = () => {
      raf = 0;
      const canvas = document.getElementById('ga-canvas');
      if (!canvas) return;
      const L = this.layout(comp, { cfg: { grid_cells: cells }, enc: L0.enc, auto: L0.auto });
      canvas.innerHTML = this.svg(L, { interactive: true });
      this._applyZoom();
    };
    const paint = (i) => {
      if (i == null || cells[i] === brush) return;
      cells[i] = brush; changed = true;
      if (!raf) raf = requestAnimationFrame(preview);
    };
    paint(Number(cellEl.dataset.gaCell));
    const move = (ev) => { const pt = this._svgPoint(ev); if (pt) paint(this._cellAt(L0, pt)); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      if (changed) this._write(comp, { grid_cells: cells });
      this.render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  },

  // New sizes with boundary k moved to `pos` (mm), snapped and clamped so
  // neither neighbour drops under the minimum.
  _resized(b, pos, part) {
    const sizes = b.sizes.slice();
    const pair = sizes[b.k - 1] + sizes[b.k];
    const start = sizes.slice(0, b.k - 1).reduce((n, v) => n + v, 0) + part * (b.k - 1);   // cell k−1 starts here
    let a = Math.round((pos - part / 2 - start) / GA_DRAG_SNAP_MM) * GA_DRAG_SNAP_MM;
    a = Math.max(GA_MIN_CELL_MM, Math.min(pair - GA_MIN_CELL_MM, a));
    if (pair < 2 * GA_MIN_CELL_MM) a = Math.round(pair / 2);
    sizes[b.k - 1] = a; sizes[b.k] = pair - a;
    return sizes;
  },

  // The stored choice for a set of sizes along boundary b's axis.
  _sizesPatch(L, b, sizes) {
    if (b.id.startsWith('col:')) return { grid_col_f: sizes.slice() };
    if (b.id.startsWith('row:')) return { grid_row_f: sizes.slice() };
    const dims = JSON.parse(JSON.stringify(L.cfg.section_dims || {}));
    const key = b.axis === 'x' ? 'w' : 'h';
    L.comps.forEach((c, i) => { dims[c.sec.id] = Object.assign(dims[c.sec.id] || {}, { [key]: sizes[i] }); });
    return { section_dims: dims };
  },

  _svgPoint(ev) {
    const svg = document.querySelector('#ga-canvas svg');
    if (!svg || !svg.getScreenCTM()) return null;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: q.x - GA_SVG_MARGIN, y: q.y - GA_SVG_MARGIN };
  },

  // Pointer drag on a partition handle: live preview with the enclosure held
  // where it is, one write (one undo step) on release.
  _pointerDown(e) {
    const h = e.target.closest && e.target.closest('[data-ga-handle]');
    const comp = this.board();
    if (!h) {
      const cell = e.target.closest && e.target.closest('[data-ga-cell]');
      if (cell && (e.button == null || e.button === 0)) this._paintDown(e, cell);
      return;
    }
    if (!comp || !this._last || (e.button != null && e.button !== 0)) return;
    const L0 = this._last;
    const b = this._boundaries(L0).find(x => x.id === h.dataset.gaHandle);
    if (!b) return;
    e.preventDefault();
    const drag = { id: b.id, b, L0, patch: null, raf: 0 };
    this._drag = drag;
    const move = (ev) => {
      const pt = this._svgPoint(ev);
      if (!pt) return;
      const sizes = this._resized(b, b.axis === 'x' ? pt.x : pt.y, L0.part);
      drag.patch = this._sizesPatch(L0, b, sizes);
      if (!drag.raf) drag.raf = requestAnimationFrame(() => { drag.raf = 0; this._preview(comp, drag); });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag.raf) cancelAnimationFrame(drag.raf);
      this._drag = null;
      if (drag.patch) this._write(comp, drag.patch);
      this.render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this._preview(comp, drag);
  },

  _preview(comp, drag) {
    const canvas = document.getElementById('ga-canvas');
    if (!canvas) return;
    const L = this.layout(comp, { cfg: drag.patch || {}, enc: drag.L0.enc, auto: drag.L0.auto });
    const b = this._boundaries(L).find(x => x.id === drag.id);
    canvas.innerHTML = this.svg(L, { interactive: true, drag: b ? { id: b.id } : null });
    this._applyZoom();
  },

  // Arrow keys on a focused handle: 10 mm steps (Shift: 50 mm).
  _keyDown(e) {
    const comp = this.board();
    if (this._brush && e.key === 'Escape') { e.preventDefault(); this._brush = null; this.render(); return; }
    const cell = e.target.closest && e.target.closest('[data-ga-cell]');
    if (cell && comp && this._last && this._brush && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const cells = this._last.owner.slice();
      const i = Number(cell.dataset.gaCell);
      if (cells[i] !== this._brush) { cells[i] = this._brush; this._write(comp, { grid_cells: cells }); this.render(); }
      const again = document.querySelector(`#ga-canvas [data-ga-cell="${i}"]`);
      if (again) again.focus();
      return;
    }
    const h = e.target.closest && e.target.closest('[data-ga-handle]');
    if (!h || !comp || !this._last) return;
    const b = this._boundaries(this._last).find(x => x.id === h.dataset.gaHandle);
    if (!b) return;
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const sizes = this._resized(b, b.pos + dir * (e.shiftKey ? 50 : GA_DRAG_SNAP_MM), this._last.part);
    this._write(comp, this._sizesPatch(this._last, b, sizes));
    this.render();
    const again = document.querySelector(`#ga-canvas [data-ga-handle="${b.id}"]`);
    if (again) again.focus();
  },

  // One shape → SVG. Labels inside a device group carry their attribute tag.
  _shapeSvg(sh, M) {
    if (sh.t === 'rect' && sh.kind === 'tint') {
      return `<rect x="${sh.x + M}" y="${sh.y + M}" width="${numAttr(sh.w)}" height="${numAttr(sh.h)}" fill="${escHtml(sh.color)}" fill-opacity="0.09" stroke="none"/>`;
    }
    if (sh.t === 'rect') {
      const fill = sh.layer === 'ENCLOSURE' || sh.layer === 'COMPARTMENT' ? 'none' : sh.kind === 'part' ? '#8a8a8a' : sh.kind === 'bar' ? '#b8b8b8' : sh.layer === 'RAIL' ? '#d6d6d6' : (GA_KIND_FILL[sh.kind] || '#999');
      const stroke = sh.color || (sh.layer === 'ENCLOSURE' ? '#222' : '#333');
      return `<rect x="${sh.x + M}" y="${sh.y + M}" width="${numAttr(sh.w)}" height="${numAttr(sh.h)}" fill="${escHtml(fill)}"
        stroke="${escHtml(stroke)}" stroke-width="${sh.thin ? 1 : 2}"${sh.dash ? ' stroke-dasharray="6 4" fill-opacity="0"' : ''} data-dxf-layer="${escHtml(sh.layer)}"
        ${sh.title ? `><title>${this._esc(sh.title)}</title></rect>` : '/>'}`;
    }
    return `<text x="${sh.x + M}" y="${sh.y + M}" font-size="${escHtml(sh.size)}" font-family="Arial,sans-serif"
      text-anchor="${escHtml(sh.anchor || 'start')}" dominant-baseline="middle"${sh.bold ? ' font-weight="700"' : ''} fill="${escHtml(sh.color) || (sh.light ? '#fff' : '#222')}"${sh.attr ? ` data-dxf-attr="${escHtml(sh.attr)}"` : ''}>${this._esc(sh.s)}</text>`;
  },

  // DXF attributes of one placed GA item.
  _dxfAttrs(comp, it, p) {
    const size = it.form === 'frame' ? `${Math.round(it.w)}x${Math.round(it.h)} mm` : `${it.modules} modules`;
    const sec = it.sec && typeof DBSections !== 'undefined' ? (DBSections.get(comp, it.sec) || {}).name : '';
    const base = { BOARD: comp.props.name || comp.id, SECTION: sec || '', KIND: it.kind, SIZE: size,
      WIDTH_MM: Math.round(p.w), HEIGHT_MM: Math.round(p.h), HEAT_W: (it.heat || 0).toFixed(1) };
    if (it.role === 'way' && it.way) return Object.assign(DBDrawing.wayDxfAttrs(comp, it.way), base);
    return Object.assign(base, { DESCRIPTION: it.label || '', SPEC: it.sub || '', ROLE: it.role || '' });
  },

  // ── DXF (server-built, mm, y up): devices are blocks with attributes ──
  dxfPayload(L) {
    return DxfExport.fromSvg(this.svg(L), {
      scale: 1, geomLayer: 'ENCLOSURE', fileName: `${this._fileBase(L.comp)}_GA`,
      title: String(L.comp.props.name || L.comp.id),
      layers: { ENCLOSURE: '#222222', COMPARTMENT: '#1976d2', PARTITION: '#8a8a8a', RAIL: '#9e9e9e',
        BARS: '#8a8a8a', DEVICES: '#c0392b', TEXT: null, DIMENSIONS: '#555555' },
    });
  },

  // ── Mounting ──────────────────────────────────────────────────────
  mount(boardId, host) {
    if (!host) return;
    if (this._boardId !== boardId) this._brush = null;
    this._boardId = boardId;
    this._host = host;
    host.innerHTML = `
      <div class="dbd-wrap ga-wrap">
        <div class="dbd-toolbar">
          <button class="btn-small" data-ga="zoom-out" title="Zoom out">−</button>
          <span class="dbd-zoom" id="ga-zoom-label">100%</span>
          <button class="btn-small" data-ga="zoom-in" title="Zoom in">+</button>
          <button class="btn-small" data-ga="fit" title="Fit to the pane">Fit</button>
          <span class="sch-sep"></span>
          <button class="btn-small" data-ga="svg" title="Download the front view as SVG">SVG</button>
          <button class="btn-small" data-ga="dxf" title="Download the front view as a DXF for CAD (mm)">DXF</button>
          <button class="btn-small btn-primary" data-ga="pdf" title="Print-ready PDF sheet with a title block and parts list">Print sheet</button>
          <button class="btn-small" data-ga="pdf-all" title="One PDF sheet per board">All boards</button>
        </div>
        <div class="dbd-body">
          <div class="dbd-canvas" id="ga-canvas"></div>
          <aside class="dbd-side ga-side" id="ga-side"></aside>
        </div>
      </div>`;
    host.onclick = (e) => this._click(e);
    host.onchange = (e) => this._change(e);
    host.onpointerdown = (e) => this._pointerDown(e);
    host.onkeydown = (e) => this._keyDown(e);
    this.render();
    this.fit();
  },

  unmount() { this._boardId = null; this._host = null; this._last = null; this._brush = null; },

  board() { return this._boardId ? AppState.components.get(this._boardId) : null; },

  render() {
    const comp = this.board();
    const canvas = document.getElementById('ga-canvas');
    const side = document.getElementById('ga-side');
    if (!comp || !canvas || !side) return;
    const L = this.layout(comp);
    this._last = L;
    canvas.innerHTML = this.svg(L, { interactive: true });
    this._applyZoom();
    side.innerHTML = this._sideHTML(L);
  },

  _sideHTML(L) {
    const cfg = L.cfg, e = this._esc;
    const comp0 = (LL) => LL.comp;
    const encOpts = [`<option value="auto"${cfg.enclosure === 'auto' ? ' selected' : ''}>Auto — smallest that fits</option>`]
      .concat(GA_ENCLOSURES.map(x => `<option value="${escHtml(x.key)}"${cfg.enclosure === x.key ? ' selected' : ''}>${e(x.label)}</option>`))
      .concat([`<option value="custom"${cfg.enclosure === 'custom' ? ' selected' : ''}>Custom size…</option>`]).join('');
    const num = (k, v, min, step, w) => `<input type="number" data-ga-set="${k}" value="${v == null ? '' : e(v)}" min="${min}" step="${step}" style="width:${w || 64}px">`;
    const status = L.warnings.length ? 'fail' : 'pass';
    const heatPct = L.capacity ? Math.min(100, L.heat / L.capacity * 100) : 0;

    const rows = L.items.map((it, i) => {
      const size = it.form === 'frame' ? `${Math.round(it.w)}×${Math.round(it.h)} mm` : `${it.modules} mod`;
      const kindSel = it.role === 'way'
        ? `<select data-ga-kind="${e(it.key)}" title="Device type">${[['', 'auto'], ['mcb', 'MCB'], ['rcbo', 'RCBO'], ['mccb', 'MCCB']]
          .map(([v, l]) => `<option value="${v}"${((cfg.over[it.key] || {}).kind || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` : '';
      const del = it.role === 'extra' ? `<button class="btn-small" data-ga-del="${e(it.extra.id)}" title="Remove">×</button>` : '';
      return `<tr><td>${i ? `<button class="btn-small" data-ga-move="${e(it.key)}:-1" title="Move earlier">↑</button>` : ''}
        <button class="btn-small" data-ga-move="${e(it.key)}:1" title="Move later">↓</button></td>
        <td title="${e(it.title || '')}">${e(it.role === 'way' ? 'Way ' + it.label : it.label)}<br><span class="ga-sub">${e(it.sub || '')}${it.sec && L.comps ? ' · ' + e((DBSections.get(L.comp, it.sec) || {}).name || '') : ''}</span></td>
        <td>${size}</td><td>${kindSel}</td>
        <td><input type="checkbox" data-ga-break="${e(it.key)}"${it.rowbreak ? ' checked' : ''} title="Start a new rail row here"${it.form === 'frame' ? ' disabled' : ''}></td>
        <td>${del}</td></tr>`;
    }).join('');

    return `
      <div class="ga-summary st-${status}">
        <div class="ga-big">${L.enc.w} × ${L.enc.h} × ${L.enc.d} mm</div>
        <div>${e(L.enc.type === 'floor' ? 'Floor-standing' : 'Wall-mounted')}${L.auto ? ' · auto-selected' : ''}</div>
        ${L.comps ? '' : `<div>${L.rowsNeeded} of ${L.rowsAvail} rail rows · ${L.perRow} modules/row</div>`}
        <div>Space used ${L.utilisation.toFixed(0)} % · ${L.spareModules} spare modules (${cfg.spare_pct} %)</div>
        <div class="ga-heat"><span style="width:${heatPct}%"></span></div>
        <div>Heat ${L.heat.toFixed(0)} W of ${L.capacity.toFixed(0)} W (${cfg.delta_t} K rise)</div>
        ${L.warnings.map(w => `<div class="ga-warn">⚠ ${e(w)}</div>`).join('')}
      </div>
      ${L.comps ? this._sectionsSideHTML(L) : ''}
      <h4>Enclosure</h4>
      <label>Mounting <select data-ga-set="mounting">
        ${[['any', 'Any'], ['wall', 'Wall-mounted'], ['floor', 'Floor-standing']].map(([v, l]) => `<option value="${v}"${cfg.mounting === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Size <select data-ga-set="enclosure">${encOpts}</select></label>
      ${cfg.enclosure === 'custom' ? `<label>W × H × D mm
        ${num('custom.w', cfg.custom.w, 100, 50)} ${num('custom.h', cfg.custom.h, 100, 50)} ${num('custom.d', cfg.custom.d, 50, 10)}</label>` : ''}
      <label title="Free modules left for future ways">Spare % ${num('spare_pct', cfg.spare_pct, 0, 5, 56)}</label>
      <label title="Allowed temperature rise inside the enclosure">Rise K ${num('delta_t', cfg.delta_t, 5, 5, 56)}</label>
      ${L.comps ? '' : `<label title="Blank = rating of the incoming device on the SLD (else estimated from demand)">Incomer A ${num('incomer_a', cfg.incomer_a, 0, 10, 72)}</label>`}
      <h4>Devices</h4>
      <table class="ga-items"><tbody>${rows}</tbody></table>
      <div class="ga-add"><select id="ga-add-kind">${GA_EXTRA_KINDS.map(k => `<option value="${escHtml(k.key)}">${e(k.label)}</option>`).join('')}</select>
        ${(typeof DBSections !== 'undefined' && DBSections.has(comp0(L))) ? `<select id="ga-add-sec" title="Compartment">${DBSections.list(comp0(L)).map(sc => `<option value="${e(sc.id)}">${e(sc.name)}</option>`).join('')}</select>` : ''}
        <button class="btn-small" data-ga="add">Add item</button></div>
      <p class="ga-note">Generic sizes (17.5 mm DIN pole, typical MCCB frames and enclosures) with an indicative heat check — confirm against the manufacturer's catalogue before ordering.</p>`;
  },

  // Brush chips for painting grid cells: each section, plus Spare.
  _paintHTML(L) {
    const e = this._esc, brush = this._brush;
    const chip = (id, name, color) => `<button type="button" class="btn-small ga-brush${brush === id ? ' active' : ''}" data-ga-brush="${e(id)}"
      style="--dbs-c:${escHtml(color)}" aria-pressed="${brush === id}" title="Paint cells as ${e(name)}"><span class="dbs-dot"></span>${e(name)}</button>`;
    const chips = L.comps.map(c => chip(c.sec.id, c.sec.name, DBSections.color(c.sec))).join('') + chip('spare', 'Spare', '#9e9e9e');
    return `<div class="ga-paint"><span class="ga-sub">Paint cells:</span>${chips}
      ${brush ? '<button type="button" class="btn-small btn-primary" data-ga="paint-done">Done</button>' : ''}
      ${L.cfg.grid_cells ? '<button type="button" class="btn-small" data-ga="cells-reset" title="Back to one cell per section in schedule order">Reset cells</button>' : ''}</div>
      <div class="ga-sub">${brush ? `Painting <b>${e(this._ownerName(L, brush))}</b> — click or drag across cells on the drawing; Esc or Done to finish.`
        : 'Pick a section, then click or drag over grid cells to give them to it — a section can take several cells, an L-shape included.'}</div>`;
  },

  // Compartment controls: arrangement, partition and per-section size.
  _sectionsSideHTML(L) {
    const e = this._esc, cfg = L.cfg;
    const dim = L.side ? 'w' : 'h';
    const rows = L.comps.map(c => {
      const m = (cfg.section_dims[c.sec.id] || {})[dim];
      return `<tr style="--dbs-c:${DBSections.color(c.sec)}">
        <td><span class="dbs-dot"></span>${e(c.sec.name)}</td>
        <td>${c.missing ? '—' : c.shape === 'L' ? 'L-shape' : `${c.w} × ${c.h}`}</td>
        <td>${L.grid ? `<span class="ga-sub">${c.missing ? 'no cells' : `${c.cells} cell${c.cells === 1 ? '' : 's'}`}</span>` : `<input type="number" data-ga-dim="${e(c.sec.id)}" value="${m ? e(m) : ''}" placeholder="auto" min="100" step="50" style="width:62px" title="Fix this compartment's ${L.side ? 'width' : 'height'} (mm); blank = fitted to its devices">`}</td>
        <td class="ga-sub">${c.res.usedModules} mod · ${c.heat.toFixed(0)} W${c.res.fits ? '' : ' ⚠'}</td></tr>`;
    }).join('');
    return `
      <h4>Compartments</h4>
      <label>Arrangement <select data-ga-set="section_layout">
        <option value="side"${L.side ? ' selected' : ''}>Side by side</option>
        <option value="stack"${!L.side && !L.grid ? ' selected' : ''}>Stacked</option>
        <option value="grid"${L.grid ? ' selected' : ''}>Grid</option></select></label>
      ${L.grid ? `<label>Columns <input type="number" data-ga-set="grid_cols" min="1" max="8" step="1" value="${escHtml(cfg.grid_cols || '')}" placeholder="auto" style="width:56px"></label>
      <label>Rows <input type="number" data-ga-set="grid_rows" min="1" max="8" step="1" value="${escHtml(cfg.grid_rows || '')}" placeholder="auto" style="width:56px"></label>
      <div class="ga-sub">${L.gcols} × ${L.grows} grid · sections fill left→right, top→bottom in schedule order</div>` : ''}
      <div class="ga-sub">Form ${e(L.form)} separation · ${L.part} mm partitions (set on the schedule's Sections panel)</div>
      ${L.comps.length > 1 ? `<div class="ga-sub ga-drag-hint">Drag a partition on the drawing to resize the compartments either side of it (or focus it and use the arrow keys).</div>` : ''}
      ${L.grid ? this._paintHTML(L) : ''}
      ${L.grid && (cfg.grid_col_f || cfg.grid_row_f) ? '<button class="btn-small" data-ga="grid-equal" title="Back to equal columns and rows">Equal sizes</button>' : ''}
      ${!L.grid && Object.keys(cfg.section_dims || {}).length ? '<button class="btn-small" data-ga="dims-fit" title="Clear the fixed sizes — each compartment fitted to its devices again">Fit to devices</button>' : ''}
      <table class="ga-items"><thead><tr><th>Section</th><th>mm</th><th>${L.grid ? 'Cells' : L.side ? 'Width' : 'Height'}</th><th>Load</th></tr></thead><tbody>${rows}</tbody></table>`;
  },

  // ── Events ────────────────────────────────────────────────────────
  _click(e) {
    const comp = this.board();
    if (!comp) return;
    const br = e.target.closest('[data-ga-brush]');
    if (br) {
      this._brush = this._brush === br.dataset.gaBrush ? null : br.dataset.gaBrush;
      this.render();
      return;
    }
    const mv = e.target.closest('[data-ga-move]');
    if (mv) {
      const [key, d] = mv.dataset.gaMove.split(/:(?=-?1$)/);
      const keys = this._last.items.map(i => i.key);
      const i = keys.indexOf(key), j = i + Number(d);
      if (i >= 0 && j >= 0 && j < keys.length) { [keys[i], keys[j]] = [keys[j], keys[i]]; this._write(comp, { order: keys }); this.render(); }
      return;
    }
    const del = e.target.closest('[data-ga-del]');
    if (del) {
      const cfg = this.cfg(comp);
      this._write(comp, { extras: cfg.extras.filter(x => x.id !== del.dataset.gaDel) });
      this.render();
      return;
    }
    const b = e.target.closest('[data-ga]');
    if (!b) return;
    const a = b.dataset.ga;
    if (a === 'zoom-in') this.zoom(1.25);
    else if (a === 'zoom-out') this.zoom(1 / 1.25);
    else if (a === 'fit') this.fit();
    else if (a === 'grid-equal') { this._write(comp, { grid_col_f: null, grid_row_f: null }); this.render(); }
    else if (a === 'paint-done') { this._brush = null; this.render(); }
    else if (a === 'cells-reset') { this._write(comp, { grid_cells: null }); this.render(); }
    else if (a === 'dims-fit') { this._write(comp, { section_dims: {} }); this.render(); }
    else if (a === 'svg') this.exportSVG();
    else if (a === 'dxf') this.exportDXF();
    else if (a === 'pdf') this.exportSheet(false);
    else if (a === 'pdf-all') this.exportSheet(true);
    else if (a === 'add') {
      const kind = document.getElementById('ga-add-kind').value;
      const kd = GA_EXTRA_KINDS.find(k => k.key === kind);
      const cfg = this.cfg(comp);
      const x = { id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), kind, label: kd.label, modules: kd.modules, heat_w: kd.heat_w };
      const sel = document.getElementById('ga-add-sec');
      if (sel && sel.value) x.section = sel.value;
      this._write(comp, { extras: cfg.extras.concat([x]) });
      this.render();
    }
  },

  _change(e) {
    const comp = this.board();
    if (!comp) return;
    const t = e.target;
    const cfg = this.cfg(comp);
    if (t.dataset.gaKind !== undefined) {
      const over = JSON.parse(JSON.stringify(cfg.over));
      over[t.dataset.gaKind] = Object.assign(over[t.dataset.gaKind] || {}, { kind: t.value || undefined });
      this._write(comp, { over });
    } else if (t.dataset.gaBreak !== undefined) {
      const over = JSON.parse(JSON.stringify(cfg.over));
      over[t.dataset.gaBreak] = Object.assign(over[t.dataset.gaBreak] || {}, { rowbreak: t.checked || undefined });
      this._write(comp, { over });
    } else if (t.dataset.gaDim !== undefined) {
      const dims = JSON.parse(JSON.stringify(cfg.section_dims));
      const key = cfg.section_layout === 'stack' ? 'h' : 'w';
      const v = Number(t.value);
      dims[t.dataset.gaDim] = Object.assign(dims[t.dataset.gaDim] || {}, { [key]: v > 0 ? v : undefined });
      this._write(comp, { section_dims: dims });
    } else if (t.dataset.gaSet) {
      const k = t.dataset.gaSet;
      if (k.startsWith('custom.')) {
        this._write(comp, { custom: Object.assign({}, cfg.custom, { [k.slice(7)]: Number(t.value) }) });
      } else {
        const numeric = ['spare_pct', 'delta_t', 'incomer_a', 'grid_cols', 'grid_rows'].includes(k);
        this._write(comp, { [k]: numeric ? (t.value === '' ? null : Number(t.value)) : t.value });
      }
    } else return;
    this.render();
  },

  // ── Zoom ──────────────────────────────────────────────────────────
  _applyZoom() {
    const c = document.getElementById('ga-canvas');
    const svg = c && c.querySelector('svg');
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    svg.setAttribute('width', vb.width * this._zoom);
    svg.setAttribute('height', vb.height * this._zoom);
    const lab = document.getElementById('ga-zoom-label');
    if (lab) lab.textContent = Math.round(this._zoom * 100) + '%';
  },
  zoom(f) { this._zoom = Math.min(4, Math.max(0.1, this._zoom * f)); this._redrawCanvas(); },

  // Redraw the drawing at the current zoom — the drag handles are sized in
  // screen pixels, so they follow the zoom.
  _redrawCanvas() {
    const canvas = document.getElementById('ga-canvas');
    if (canvas && this._last) canvas.innerHTML = this.svg(this._last, { interactive: true });
    this._applyZoom();
  },
  fit() {
    const c = document.getElementById('ga-canvas');
    const svg = c && c.querySelector('svg');
    if (!c || !svg) return;
    const vb = svg.viewBox.baseVal;
    const z = Math.min((c.clientWidth - 24) / vb.width, (c.clientHeight - 24) / vb.height);
    this._zoom = z > 0 && isFinite(z) ? Math.min(1.5, z) : 0.5;
    this._redrawCanvas();
  },

  // ── Exports ───────────────────────────────────────────────────────
  _fileBase(b) { return DBDrawing._fileBase(b); },
  _download(blob, name) { DBDrawing._download(blob, name); },

  exportSVG() {
    const comp = this.board(); if (!comp) return;
    this._download(new Blob([this.svg(this.layout(comp))], { type: 'image/svg+xml' }), `${this._fileBase(comp)}_GA.svg`);
  },

  exportDXF() {
    const comp = this.board(); if (!comp) return;
    return DxfExport.download(this.dxfPayload(this.layout(comp)));
  },

  exportSheet(all) {
    const Ctor = window.jspdf && window.jspdf.jsPDF;
    if (!Ctor) { UI.alert('PDF library not loaded.'); return; }
    const boards = all
      ? [...AppState.components.values()].filter(c => c.type === 'distribution_board')
      : [this.board()].filter(Boolean);
    if (!boards.length) { UI.alert('No distribution boards to export.'); return; }
    const doc = new Ctor({ orientation: 'landscape', unit: 'mm', format: 'a3' });
    boards.forEach((comp, n) => {
      if (n) doc.addPage('a3', 'landscape');
      this._sheetPage(doc, comp);
    });
    doc.save(all ? `${String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_')}_GA_all.pdf`
      : `${this._fileBase(boards[0])}_GA.pdf`);
  },

  _sheetPage(doc, comp) {
    const L = this.layout(comp);
    const pw = 420, ph = 297, m = 8, tb = 22, listW = 92;
    doc.setLineWidth(0.4); doc.rect(m, m, pw - 2 * m, ph - 2 * m);
    doc.rect(m, ph - m - tb, pw - 2 * m, tb);
    // drawing area
    const aw = pw - 2 * m - listW - 12, ah = ph - 2 * m - tb - 24;
    const sc = Math.min(aw / L.enc.w, ah / L.enc.h);
    const ox = m + 6 + (aw - L.enc.w * sc) / 2, oy = m + 14;
    const rgb = (c) => DxfExport.parseColor(c) || [0, 0, 0];
    for (const sh of this.shapes(L)) {
      if (sh.t === 'rect' && sh.kind === 'tint') {
        // a pale wash of the section colour (9 % over white)
        const c = rgb(sh.color).map(v => Math.round(v * 0.09 + 255 * 0.91));
        doc.setFillColor(c[0], c[1], c[2]);
        doc.rect(ox + sh.x * sc, oy + sh.y * sc, sh.w * sc, sh.h * sc, 'F');
        continue;
      }
      if (sh.t === 'rect') {
        doc.setLineWidth(sh.thin ? 0.15 : 0.3);
        if (sh.color) { const c = rgb(sh.color); doc.setDrawColor(c[0], c[1], c[2]); } else doc.setDrawColor(0, 0, 0);
        const fill = sh.layer === 'DEVICES' && GA_KIND_FILL[sh.kind] && GA_KIND_FILL[sh.kind] !== 'none' ? GA_KIND_FILL[sh.kind]
          : sh.kind === 'bar' ? '#b8b8b8' : sh.kind === 'part' ? '#8a8a8a' : null;
        if (fill) { doc.setFillColor(...rgb(fill)); doc.rect(ox + sh.x * sc, oy + sh.y * sc, sh.w * sc, sh.h * sc, 'FD'); }
        else doc.rect(ox + sh.x * sc, oy + sh.y * sc, sh.w * sc, sh.h * sc);
      } else {
        doc.setFontSize(Math.max(3.5, sh.size * sc * 2.4));
        doc.setTextColor(...(sh.color ? rgb(sh.color) : sh.light ? [255, 255, 255] : [30, 30, 30]));
        doc.text(String(sh.s), ox + sh.x * sc, oy + sh.y * sc, { align: sh.anchor === 'middle' ? 'center' : 'left', baseline: 'middle' });
      }
    }
    doc.setTextColor(30, 30, 30); doc.setFontSize(9);
    doc.text(`${L.enc.w} mm`, ox + L.enc.w * sc / 2, oy - 4, { align: 'center' });
    doc.text(`${L.enc.h} mm`, ox - 3, oy + L.enc.h * sc / 2, { angle: 90, align: 'center' });
    // parts list
    const lx = pw - m - listW;
    doc.setFontSize(10); doc.text('Parts list', lx, m + 8);
    doc.setFontSize(7);
    // Lines that do not fit beside the drawing continue on following sheets,
    // in columns, so a large board never loses parts silently.
    const lines = [];
    let lastSec = null;
    for (const it of L.items) {
      if (L.comps && it.sec !== lastSec) {
        lastSec = it.sec;
        lines.push({ head: ((DBSections.get(comp, it.sec) || {}).name || 'Section').toUpperCase() });
      }
      lines.push({ text: `${it.role === 'way' ? 'Way ' : ''}${it.label}  ${it.sub || ''}`.slice(0, 44),
        size: it.form === 'frame' ? `${Math.round(it.w)}x${Math.round(it.h)}` : `${it.modules}M` });
    }
    const put = (ln, x, yy) => {
      if (ln.head) {
        doc.setFontSize(7.5); doc.setFont(undefined, 'bold'); doc.text(ln.head, x, yy);
        doc.setFont(undefined, 'normal'); doc.setFontSize(7);
        return 4.6;
      }
      doc.text(ln.text, x, yy);
      doc.text(ln.size, x + listW - 2, yy, { align: 'right' });
      return 4.2;
    };
    let y = m + 14, i = 0;
    const yMax = ph - m - tb - 6;
    for (; i < lines.length && y <= yMax; i++) y += put(lines[i], lx, y);
    if (i < lines.length) {
      doc.setFontSize(7); doc.setTextColor(150, 30, 30);
      doc.text(`… ${lines.length - i} more — continued on the next sheet`, lx, Math.min(y, yMax + 4));
      doc.setTextColor(30, 30, 30);
    }
    const tbY = ph - m - tb;
    doc.setFontSize(12); doc.text(String(comp.props.name || comp.id), m + 4, tbY + 8);
    doc.setFontSize(8);
    doc.text(`Project: ${AppState.projectName || 'Untitled'}`, m + 4, tbY + 15);
    doc.text(`Enclosure: ${L.enc.w} x ${L.enc.h} x ${L.enc.d} mm (${L.enc.type === 'floor' ? 'floor' : 'wall'})`, m + 100, tbY + 8);
    if (L.comps) doc.text(`Compartments (${L.grid ? `grid ${L.gcols} x ${L.grows}` : L.side ? 'side by side' : 'stacked'}): ${L.comps.map(c => `${c.sec.name} ${c.w}x${c.h}`).join(' | ')} · form ${L.form}`, m + 100, tbY + 20);
    doc.text(`Rows ${L.rowsNeeded}/${L.rowsAvail} · space ${L.utilisation.toFixed(0)} % · heat ${L.heat.toFixed(0)}/${L.capacity.toFixed(0)} W`, m + 100, tbY + 15);
    doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`, pw - m - 70, tbY + 8);
    doc.text('Distribution board general arrangement (indicative sizes)', pw - m - 70, tbY + 15);

    while (i < lines.length) {
      doc.addPage('a3', 'landscape');
      doc.setLineWidth(0.4); doc.rect(m, m, pw - 2 * m, ph - 2 * m);
      doc.setTextColor(30, 30, 30); doc.setFontSize(10);
      doc.text(`${String(comp.props.name || comp.id)} — parts list (continued)`, m + 6, m + 8);
      doc.setFontSize(7);
      for (let col = 0; col * (listW + 10) + listW <= pw - 2 * m - 12 && i < lines.length; col++) {
        const x = m + 6 + col * (listW + 10);
        let yy = m + 16;
        for (; i < lines.length && yy <= ph - m - 6; i++) yy += put(lines[i], x, yy);
      }
    }
  },
};
