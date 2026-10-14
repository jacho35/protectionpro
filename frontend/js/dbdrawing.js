/* ProtectionPro — Distribution board single-line drawing.
 *
 * A read-only DB single line generated from the board's circuit schedule: the
 * incomer, the busbar, every way with its protective device and cable, the
 * earth-leakage groupings, the board accessories (indicators, SPDs, metering,
 * utilities) and the N/PE bars.
 *
 * Everything is derived — the only state this view owns is the detail-toggle
 * set, which lives in localStorage, not the project. Ways come from
 * `props.circuits`, accessories from `props.accessories`, the incomer from the
 * SLD via Components.boardIncomer(), and the per-way verdict colouring from
 * AppState.dbCheckResults.
 *
 * Colours are literal hex from _palette(), not CSS custom properties or the
 * symbol classes in css/symbols.css: Project._rasterizeSVG only resolves
 * `var(--x, fallback)` forms and a detached export SVG carries no stylesheet,
 * so anything else rasterizes colourless into the PNG/PDF exports. The glyphs
 * below draw the main SLD symbols through Symbols._symbolFor (see _sym), falling back to
 * the old hand-drawn geometry only if Symbols is unavailable.
 */

const DBDrawing = {
  _zoom: 1,
  _size: { w: 0, h: 0 },
  _boardId: null,
  _host: null,

  // Geometry (SVG user units, which are CSS px at zoom 1)
  PAD: 26,
  HEAD_H: 78,          // "fed from" caption + summary block
  INCOMER_X: 96,       // riser centre, measured from the left pad
  SRC_TO_DEV: 52,      // source terminal → incomer device centre
  DEV_TO_BUS: 50,      // last incomer device → busbar
  SUPPLY_TAP_H: 46,    // vertical pitch of a supply-side accessory tap
  DROP_W: 118,         // way column pitch
  DROP_X0: 62,
  TABLE_HDR: 74,       // extra left margin for the row headings in table mode
  ACC_W: 88,           // accessory column pitch (narrower than a way)
  PROT_DY: 28,         // busbar → an accessory's protective device
  TBL_ROW: 14,         // info-table row pitch         // first drop, measured from the left pad
  WAYS_PER_ROW: 12,
  BUS_TO_RCD: 12,      // busbar → top of the earth-leakage bracket
  RCD_H: 20,
  BUS_TO_DEV: 68,      // busbar → device centre
  TICK_DY: 32,         // device centre → phase tick
  LABEL_DY: 48,        // device centre → first label baseline
  LINE_H: 12,
  BAR_GAP: 16,         // last label → N bar
  BAR_PITCH: 13,       // N bar → PE bar
  ROW_GAP: 30,
  LOAD_H: 62,          // PE bar → load symbol block
  SYM_SCALE: 1.3,      // device symbols are drawn this much larger than the SLD's

  DETAIL_DEFAULTS: {
    cable: true, load: true, phase: true, elgroups: true,
    bars: true, status: true, accessories: true,
    table: false,        // way info as a table under the load arrows instead of beside the device
  },

  // ── Detail toggles ──────────────────────────────────────────────────
  // Saved with the project (AppState.dbDrawingDetail holds only the switches that
  // differ from DETAIL_DEFAULTS), so everyone opening it gets the same drawing.
  detail() {
    return Object.assign({}, this.DETAIL_DEFAULTS, AppState.dbDrawingDetail || {});
  },

  setDetail(key, on) {
    if (!AppState.dbDrawingDetail) AppState.dbDrawingDetail = {};
    if (!!on === this.DETAIL_DEFAULTS[key]) delete AppState.dbDrawingDetail[key];
    else AppState.dbDrawingDetail[key] = !!on;
    AppState.dirty = true;
  },

  // ── Mounting ────────────────────────────────────────────────────────
  mount(boardId, host) {
    if (!host) return;
    this._boardId = boardId;
    this._host = host;
    const d = this.detail();
    const toggle = (k, label, title) =>
      `<label class="dbd-toggle" title="${escHtml(title)}">
         <input type="checkbox" data-dbd-detail="${k}"${d[k] ? ' checked' : ''}> ${escHtml(label)}</label>`;

    host.innerHTML = `
      <div class="dbd-wrap">
        <div class="dbd-toolbar">
          <button class="btn-small" data-dbd="zoom-out" title="Zoom out">−</button>
          <span class="dbd-zoom" id="dbd-zoom-label">100%</span>
          <button class="btn-small" data-dbd="zoom-in" title="Zoom in">+</button>
          <button class="btn-small" data-dbd="fit" title="Fit to width">Fit</button>
          <span class="sch-sep"></span>
          ${toggle('cable', 'Cable', 'Show each way\'s conductor size, length and ECC')}
          ${toggle('load', 'Load', 'Show each way\'s full-load current and connected kVA')}
          ${toggle('phase', 'Phase', 'Show the phase each way is connected to')}
          ${toggle('elgroups', 'EL groups', 'Draw a shared earth-leakage unit over the ways in each EL group')}
          ${toggle('bars', 'N + PE bars', 'Draw the neutral and protective earth bars')}
          ${toggle('status', 'Check status', 'Colour each way by its circuit-check verdict')}
          ${toggle('accessories', 'Accessories', 'Draw the board accessories on the single line')}
          ${toggle('table', 'Info table', 'Show each way\'s information as a table below its load, instead of beside the device')}
          <span class="sch-sep"></span>
          <button class="btn-small" data-dbd="svg" title="Download the drawing as a vector SVG">SVG</button>
          <button class="btn-small" data-dbd="png" title="Download the drawing as a PNG">PNG</button>
          <button class="btn-small btn-primary" data-dbd="sheet" title="Print-ready PDF sheet with a title block">Print sheet</button>
          <button class="btn-small" data-dbd="sheet-all" title="One PDF sheet per board in the project">All boards</button>
        </div>
        <div class="dbd-body">
          <div class="dbd-canvas" id="dbd-canvas"></div>
          <aside class="dbd-side" id="dbd-accessories"></aside>
        </div>
      </div>`;

    host.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dbd]');
      if (!btn) return;
      const a = btn.dataset.dbd;
      if (a === 'zoom-in') this.zoom(1.25);
      else if (a === 'zoom-out') this.zoom(1 / 1.25);
      else if (a === 'fit') this.fit();
      else if (a === 'svg') this.exportSVG();
      else if (a === 'png') this.exportPNG();
      else if (a === 'sheet') this.exportSheet(false);
      else if (a === 'sheet-all') this.exportSheet(true);
    });

    host.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-dbd-detail]');
      if (!cb) return;
      this.setDetail(cb.dataset.dbdDetail, cb.checked);
      this.render();
    });

    this.render();
    this.autoZoom();
  },

  unmount() {
    this._boardId = null;
    this._host = null;
  },

  board() {
    return this._boardId ? AppState.components.get(this._boardId) : null;
  },

  render() {
    const canvas = document.getElementById('dbd-canvas');
    const side = document.getElementById('dbd-accessories');
    const comp = this.board();
    if (side) {
      DBAccessories.render(comp, side, () => this.render(), { mode: 'panel' });
    }
    if (!canvas) return;
    if (!comp) { canvas.innerHTML = '<div class="sch-empty">No board selected.</div>'; return; }
    const dark = document.body.classList.contains('dark-mode');
    canvas.innerHTML = this.buildSVG({ dark, board: comp });
    this._applyZoom();
  },

  // ── Data gathering ──────────────────────────────────────────────────
  // Board totals WITHOUT dirtying the project. DBSchedule.recompute() is the
  // single source of truth for these figures but it writes the derived props as
  // a side effect; the drawing is a read-only view, and it can be opened on a
  // board DBSchedule never baselined, so the derived props are restored exactly
  // as they were found.
  _totals(comp) {
    const keys = (typeof DBSchedule !== 'undefined' && DBSchedule._DERIVED_KEYS)
      ? DBSchedule._DERIVED_KEYS
      : ['rated_kva', 'demand_factor', 'power_factor', 'phase_a_pct', 'phase_b_pct', 'phase_c_pct', 'phase_connection'];
    const before = {};
    for (const k of keys) before[k] = comp.props[k];
    const t = DBSchedule.recompute(comp);
    for (const k of keys) comp.props[k] = before[k];
    return t;
  },

  // Per-way verdicts for this board, keyed by the way's stable id. Built here
  // rather than through DBSchedule._resultFor so the drawing works on a board
  // whose grid has never been opened.
  _verdicts(comp) {
    const idx = {};
    const res = AppState.dbCheckResults;
    for (const w of ((res && res.ways) || [])) {
      if (w.board_id === comp.id) idx[w.way_id] = w;
    }
    return idx;
  },

  _sortedWays(comp) {
    return [...(comp.props.circuits || [])].sort((a, b) =>
      String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }));
  },

  // ── Layout ──────────────────────────────────────────────────────────
  // One "item" per column below the busbar — a way or a busbar-tapped
  // accessory. Accessories lead, so the ways keep their schedule order and a
  // reader finds the board's protection devices before its circuits.
  _items(comp, D) {
    const vll = DBSchedule._boardVll(comp);
    const verdicts = D.status ? this._verdicts(comp) : {};
    const items = [];

    if (D.accessories) {
      for (const acc of DBAccessories.list(comp)) {
        if (acc.tap === 'supply') continue;          // drawn on the incomer riser
        items.push(this._accItem(acc, comp));
      }
    }

    for (const c of this._sortedWays(comp)) {
      const v = verdicts[c.id] || null;
      const lines = [];
      const dev = `${Number(c.breaker_a) || 0} A${c.curve ? ' ' + c.curve : ''}${c.poles && c.poles !== '1P' ? ' ' + c.poles : ''}`;
      lines.push({ text: `W${c.way ?? ''} · ${dev}`, bold: true });
      lines.push({ text: this._trunc(c.description || '—', 22) });
      const spare = !(Number(c.load_va) > 0) && !(Number(c.cable_m) > 0);
      if (spare) lines[1] = { text: 'Spare', dim: true };
      if (D.cable && !spare) {
        const ecc = c.ecc_mm2 != null ? `${c.ecc_mm2}` : 'min';
        lines.push({ text: `${c.cable_mm2 || '?'} mm² · ${c.cable_m || 0} m · E ${ecc}`, dim: true });
      }
      if (D.load && !spare) {
        const fla = DBSchedule._wayFlaA(c, vll);
        const kva = (Number(c.load_va) || 0) / 1000;
        lines.push({ text: `${fla.toFixed(1)} A · ${kva.toFixed(2)} kVA`, dim: true });
      }
      const warns = DBSchedule._wayWarnings(c, !!v, vll);
      const tip = [`Way ${c.way ?? ''} — ${c.description || 'no description'}`,
        `${dev} ${c.poles || '1P'} on ${c.phase || 'R'}`,
        `${c.cable_mm2 || '?'} mm², ${c.cable_m || 0} m`,
        c.el_group ? `Earth leakage group ${c.el_group}` : 'No earth-leakage protection',
        ...(v && v.messages ? v.messages : []),
        ...warns].join('\n');

      items.push({
        kind: 'way', w: this.DROP_W, glyph: 'mcb', phase: (c.poles === '3P' || c.phase === 'RWB') ? 'RWB' : (c.phase || 'R'),
        poles: c.poles || '1P', spare, wayDesc: c.description || '',
        cells: {
          way: String(c.way ?? ''), device: dev, desc: this._trunc(c.description || (spare ? 'Spare' : '—'), 19),
          cable: spare ? '' : `${c.cable_mm2 || '?'}`, len: spare ? '' : `${c.cable_m || 0}`,
          ecc: spare ? '' : (c.ecc_mm2 != null ? `${c.ecc_mm2}` : 'min'),
          amps: spare ? '' : DBSchedule._wayFlaA(c, vll).toFixed(1),
          kva: spare ? '' : ((Number(c.load_va) || 0) / 1000).toFixed(2),
        },
        elGroup: D.elgroups ? (c.el_group || '') : '',
        status: v ? v.status : (warns.length ? 'warn' : null),
        lines, tip,
      });
    }
    return items;
  },

  // `comp` is passed explicitly rather than read from this.board(): an export
  // or report run draws a board that is not the one mounted in the view.
  _accItem(acc, comp) {
    const util = { socket: 'socket', light: 'light', hour_meter: 'hour', ctl_transformer: 'ctltx' };
    const glyph = acc.kind === 'spd' ? 'spd'
      : acc.kind === 'indicator' ? 'lamp'
        : acc.kind === 'metering' ? 'meter' : (util[acc.utility_kind] || 'utility');
    const fuseA = Number(acc.fuse_a) || 0;
    const prot = fuseA && acc.fuse_type !== 'none' ? { a: fuseA, type: acc.fuse_type } : null;
    const protText = prot ? `${prot.a} A ${prot.type === 'mcb' ? 'MCB' : prot.type}` : 'unprotected';
    // Spec wrapped onto short lines so it fits the narrow accessory column.
    const lines = [{ text: this._trunc(acc.label || '', 15), bold: true }];
    const parts = this._accSpec(acc).replace('Control ', 'Ctl ').split(' · ');
    let cur = '';
    for (const p of parts) {
      if (cur && (cur + ' · ' + p).length > 16) { lines.push({ text: cur }); cur = p; }
      else cur = cur ? cur + ' · ' + p : p;
    }
    if (cur) lines.push({ text: this._trunc(cur, 17) });
    lines.push({ text: protText, dim: true });
    const warns = DBAccessories.warnings(acc, DBAccessories.incomer(comp));
    return {
      kind: 'acc', w: this.ACC_W, glyph, accKind: acc.kind, prot,
      meterLetter: acc.meter === 'ammeter' ? 'A' : (acc.meter === 'both' ? 'VA' : 'V'),
      cells: {
        way: '—', device: protText, desc: this._trunc(acc.label || '', 13),
        cable: '', len: '', ecc: '', amps: '', kva: '',
      },
      phase: acc.phases || 'RWB', poles: (acc.phases === 'RWB') ? '3P' : '1P',
      elGroup: '',
      status: warns.some(w => w.level === 'warn') ? 'warn' : null,
      lines,
      tip: [acc.label || '', this._accSpec(acc), ...warns.map(w => w.text)].filter(Boolean).join('\n'),
    };
  },

  _accSpec(acc) {
    if (acc.kind === 'spd') {
      return `Type ${acc.spd_type ?? '?'} · ${acc.spd_mode || ''} · ${acc.in_ka ?? '?'} kA · Up ${acc.up_kv ?? '?'} kV`;
    }
    if (acc.kind === 'indicator') {
      return `${acc.phases || ''} · ${String(acc.lamp_type || '').toUpperCase()} ${acc.lamp_v ?? ''} V`;
    }
    if (acc.kind === 'metering') {
      const m = acc.meter === 'both' ? 'V + A' : (acc.meter === 'voltmeter' ? 'Voltmeter' : 'Ammeter');
      return `${m}${acc.meter !== 'voltmeter' && acc.ct_ratio ? ' · CT ' + acc.ct_ratio : ''}`;
    }
    const kinds = { socket: 'Socket outlet', light: 'Enclosure light', hour_meter: 'Hour-run meter', ctl_transformer: 'Control transformer' };
    return kinds[acc.utility_kind] || 'Utility';
  },

  // Consecutive items in one row sharing a non-empty EL group get one bracket.
  // A group split across a row break simply draws once per row — which is what
  // a drawing does anyway when the busbar wraps.
  _elBrackets(rowItems) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= rowItems.length; i++) {
      const g = i < rowItems.length ? rowItems[i].elGroup : '';
      const prev = start >= 0 ? rowItems[start].elGroup : '';
      if (start >= 0 && g !== prev) { out.push({ from: start, to: i - 1, group: prev }); start = -1; }
      if (g && start < 0) start = i;
    }
    return out;
  },

  _layout(comp, D) {
    this._dropX0 = this.DROP_X0 + (D.table ? this.TABLE_HDR : 0);
    const items = this._items(comp, D);
    const supply = D.accessories
      ? DBAccessories.list(comp).filter(a => a.tap === 'supply')
      : [];
    const inc = DBAccessories.incomer(comp);

    const rows = [];
    for (let i = 0; i < items.length; i += this.WAYS_PER_ROW) {
      rows.push(items.slice(i, i + this.WAYS_PER_ROW));
    }
    if (!rows.length) rows.push([]);

    const tRows = D.table ? this._tableRows(D) : [];
    const maxLines = D.table ? 0 : items.reduce((n, it) => Math.max(n, it.lines.length), 1);
    const btd = rows.some(r => r.some(it => it.kind === 'acc')) ? 92 : this.BUS_TO_DEV;
    const rowInner = btd + this.LABEL_DY + maxLines * this.LINE_H
      + (D.bars ? this.BAR_GAP + this.BAR_PITCH + 8 : 8) + (D.load ? this.LOAD_H : 0)
      + (tRows.length ? tRows.length * this.TBL_ROW + 14 : 0);
    const rowH = rowInner + this.ROW_GAP;

    const incTop = this.PAD + this.HEAD_H + 14;
    const devY = incTop + this.SRC_TO_DEV + supply.length * this.SUPPLY_TAP_H;
    const isoY = inc.isolator ? devY + 44 : null;
    const busY = (isoY || devY) + this.DEV_TO_BUS;

    // Column centres per row: ways keep the DROP_W pitch, accessories are narrower.
    const e0 = this._dropX0 - this.DROP_W / 2;
    const xs = [], rowW = [];
    for (const r of rows) {
      let cur = e0; const row = [];
      for (const it of r) { row.push(cur + it.w / 2); cur += it.w; }
      xs.push(row); rowW.push(cur);
    }
    const busW = Math.max(Math.max(...rowW) + this.DROP_W / 2, 460);
    const w = this.PAD * 2 + Math.max(busW + 20, 620);
    const h = busY + rows.length * rowH + this.PAD;

    return { xs, rowW, btd, tRows, items, rows, supply, inc, maxLines, rowInner, rowH, incTop, devY, isoY, busY, busW, w, h };
  },

  // ── Palette ─────────────────────────────────────────────────────────
  _palette(dark) {
    return dark ? {
      surface: '#1e1e2e', panel: '#252536', ink: '#e0e0e8', inkSec: '#a0a0b0',
      muted: '#7c7c96', line: '#8a8aa4', bus: '#c9c9e0', border: '#3a3a50',
      accent: '#4a9eff', head: '#2f2f44',
      pass: '#69db7c', warn: '#ffc078', fail: '#ff6b6b',
      phase: { R: '#f87171', W: '#cbd5e1', B: '#60a5fa', RWB: '#c084fc' },
    } : {
      surface: '#ffffff', panel: '#f5f8ff', ink: '#1a1a2e', inkSec: '#555555',
      muted: '#7a7a88', line: '#44444f', bus: '#1a1a2e', border: '#c9ced6',
      accent: '#0078d7', head: '#eef1f5',
      pass: '#2e7d32', warn: '#b26a00', fail: '#d32f2f',
      phase: { R: '#dc2626', W: '#6b7280', B: '#2563eb', RWB: '#7c3aed' },
    };
  },

  // ── Small helpers ───────────────────────────────────────────────────
  _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

  _trunc(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  },

  _statusColor(status, P) {
    if (status === 'fail') return P.fail;
    if (status === 'warn') return P.warn;
    if (status === 'pass') return P.pass;
    return P.line;
  },

  // ── Glyphs ──────────────────────────────────────────────────────────
  // Drawn centred on (x, y); each returns markup only, no terminal stubs — the
  // drop line is drawn continuously behind them.
  _gMcb(x, y, P, stroke) {
    const s = 8;
    return `<rect x="${x - s}" y="${y - s}" width="${s * 2}" height="${s * 2}" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x - s}" y1="${y - s}" x2="${x + s}" y2="${y + s}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x + s}" y1="${y - s}" x2="${x - s}" y2="${y + s}" stroke="${stroke}" stroke-width="1.4"/>`;
  },

  _gFuse(x, y, P, stroke) {
    const w = 6, h = 10;
    return `<rect x="${x - w}" y="${y - h}" width="${w * 2}" height="${h * 2}" rx="2" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x - w}" y1="${y}" x2="${x + w}" y2="${y}" stroke="${stroke}" stroke-width="1.4"/>`;
  },

  _gSwitch(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y + 8}" r="2.6" fill="${stroke}"/>`
      + `<circle cx="${x}" cy="${y - 8}" r="2.6" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x}" y1="${y + 8}" x2="${x + 9}" y2="${y - 9}" stroke="${stroke}" stroke-width="1.6"/>`;
  },

  _gSpd(x, y, P, stroke) {
    const w = 7, h = 10;
    return `<rect x="${x - w}" y="${y - h}" width="${w * 2}" height="${h * 2}" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<polyline points="${x - 4},${y - 5} ${x + 4},${y} ${x - 4},${y + 5}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`;
  },

  _gLamp(x, y, P, stroke) {
    const r = 8, k = r * Math.SQRT1_2;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x - k}" y1="${y - k}" x2="${x + k}" y2="${y + k}" stroke="${stroke}" stroke-width="1.3"/>`
      + `<line x1="${x + k}" y1="${y - k}" x2="${x - k}" y2="${y + k}" stroke="${stroke}" stroke-width="1.3"/>`;
  },

  _gMeter(x, y, P, stroke, letter) {
    return `<circle cx="${x}" cy="${y}" r="9" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="${String(letter).length > 1 ? 8 : 10}" font-weight="700" fill="${stroke}">${letter}</text>`;
  },

  _gSocket(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y}" r="8" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x - 3}" y1="${y - 4}" x2="${x - 3}" y2="${y + 4}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<line x1="${x + 3}" y1="${y - 4}" x2="${x + 3}" y2="${y + 4}" stroke="${stroke}" stroke-width="1.4"/>`;
  },

  _gLight(x, y, P, stroke) {
    const k = 8 * Math.SQRT1_2;
    let r = '';
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      r += `<line x1="${x + dx * k}" y1="${y + dy * k}" x2="${x + dx * (k + 4)}" y2="${y + dy * (k + 4)}" stroke="${stroke}" stroke-width="1.2"/>`;
    }
    return this._gLamp(x, y, P, stroke) + r;
  },

  _gHour(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y}" r="9" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${stroke}">h</text>`;
  },

  _gCtlTx(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y - 5}" r="7" fill="none" stroke="${stroke}" stroke-width="1.4"/>`
      + `<circle cx="${x}" cy="${y + 5}" r="7" fill="none" stroke="${stroke}" stroke-width="1.4"/>`;
  },

  // Protective device type for an accessory (SLD symbol key), or null.
  _protType(prot) {
    if (!prot) return null;
    return prot.type === 'mcb' ? 'cb' : 'fuse';
  },

  _gUtility(x, y, P, stroke) {
    return `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="3" fill="${P.surface}" stroke="${stroke}" stroke-width="1.4"/>`
      + `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${stroke}" stroke-width="1.3"/>`;
  },

  // The main single line's own symbol, drawn by Symbols (so it follows the
  // project's IEC / classic symbol set) with literal colours: class names are
  // stripped and the stroke set on a wrapper, because an exported SVG carries
  // no stylesheet. `stroke` overrides the symbol's native SLD colour.
  _sym(type, x, y, P, stroke, comp, scale, rot) {
    const def = (typeof COMPONENT_DEFS !== 'undefined') ? COMPONENT_DEFS[type] : null;
    const fn = (typeof Symbols !== 'undefined' && def) ? Symbols._symbolFor(type) : null;
    if (!fn) return '';
    let m = fn(def.width, def.height, comp || { type, props: {} });
    m = m.replace(/class="iec-solid"/g, `fill="${stroke}"`)
      .replace(/\sclass="[^"]*"/g, '')
      .replace(/var\(--[a-z-]+,\s*[^)]+\)/g, P.surface)
      .replace(/fill="white"/g, `fill="${P.surface}"`)
      .replace(/currentColor/g, stroke)
      .replace(/<text((?:(?!fill=)[^>])*)>/g, `<text stroke="none" fill="${stroke}"$1>`);
    return `<g transform="translate(${x},${y})${scale && scale !== 1 ? ` scale(${scale})` : ''}${rot ? ` rotate(${rot})` : ''}" stroke="${stroke}" stroke-width="1.5" fill="none">${m}</g>`;
  },

  // SLD-native stroke colour per symbol type (neutral ones follow the theme).
  _native(type, P) {
    const dark = P.surface !== '#ffffff';
    return { cb: dark ? '#ef5350' : '#d32f2f', fuse: '#e65100',
      surge_arrester: dark ? '#66bb6a' : '#2e7d32' }[type] || P.line;
  },

  // Vertical conductor y1→y2 broken around symbols (centre ± half their height),
  // so an open-contact blade is not struck through by the line behind it.
  _vline(x, y1, y2, gaps, stroke, w) {
    let out = '', cur = y1;
    for (const [c, hh] of gaps.slice().sort((a, b) => a[0] - b[0])) {
      if (c - hh > cur) out += `<line x1="${x}" y1="${cur}" x2="${x}" y2="${c - hh}" stroke="${stroke}" stroke-width="${w}"/>`;
      cur = Math.max(cur, c + hh);
    }
    if (y2 > cur) out += `<line x1="${x}" y1="${cur}" x2="${x}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`;
    return out;
  },

  _glyph(name, x, y, P, stroke, item) {
    const map = { mcb: 'cb', fuse: 'fuse', switch: 'switch', spd: 'surge_arrester', lamp: 'ctl_lamp' };
    const t = map[name];
    if (t) {
      // Verdict colouring wins; otherwise the symbol keeps its SLD colour.
      const c = (stroke && stroke !== P.line) ? stroke : this._native(t, P);
      const g = this._sym(t, x, y, P, c, null, this.SYM_SCALE);
      if (g) return g;
    }
    switch (name) {
      case 'mcb': return this._gMcb(x, y, P, stroke);
      case 'fuse': return this._gFuse(x, y, P, stroke);
      case 'switch': return this._gSwitch(x, y, P, stroke);
      case 'spd': return this._gSpd(x, y, P, stroke);
      case 'lamp': return this._gLamp(x, y, P, stroke);
      case 'meter': return this._gMeter(x, y, P, stroke, (item && item.meterLetter) || 'V');
      case 'socket': return this._gSocket(x, y, P, stroke);
      case 'light': return this._gLight(x, y, P, stroke);
      case 'hour': return this._gHour(x, y, P, stroke);
      case 'ctltx': return this._gCtlTx(x, y, P, stroke);
      default: return this._gUtility(x, y, P, stroke);
    }
  },

  // ── SVG ─────────────────────────────────────────────────────────────
  buildSVG(opts) {
    opts = opts || {};
    const comp = opts.board || this.board();
    if (!comp) return '';
    const D = Object.assign({}, this.detail(), opts.detail || {});
    const P = this._palette(!!opts.dark);
    const L = this._layout(comp, D);
    this._size = { w: L.w, h: L.h };

    const t = this._totals(comp);
    const vll = DBSchedule._boardVll(comp);
    const x0 = this.PAD;

    let svg = `<rect x="0" y="0" width="${L.w}" height="${L.h}" fill="${P.surface}"/>`;
    svg += this._header(comp, L, P, t, vll, x0);
    svg += this._incomer(comp, L, P, x0);

    L.rows.forEach((row, ri) => {
      svg += this._busRow(row, ri, L, P, D, x0, comp);
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}"
        role="img" aria-label="${this._esc(`Single line of ${comp.props.name || comp.id}: ${(comp.props.circuits || []).length} ways`)}"
        font-family="Helvetica, Arial, sans-serif">${svg}</svg>`;
  },

  _header(comp, L, P, t, vll, x0) {
    const inc = L.inc;
    const name = comp.props.name || comp.id;
    const from = inc.basis === 'unknown'
      ? 'Supply not modelled — wire this board on the SLD'
      : `Fed from ${inc.source ? inc.source.name : 'supply'}`
        + (inc.way ? ` way ${inc.way}` : '')
        + (inc.cable && inc.cable.mm2 ? ` · ${inc.cable.mm2} mm²` : '')
        + (inc.cable && inc.cable.m ? ` · ${inc.cable.m} m` : '');

    const ways = (comp.props.circuits || []).length;
    const ph = t.phaseVa;
    const phTot = ph.R + ph.W + ph.B;
    const pct = v => phTot > 0 ? Math.round(v / phTot * 100) : 33;
    const a3 = vll > 0 ? (t.demandKva * 1000) / (Math.sqrt(3) * vll) : 0;

    const chips = [
      `${t.connectedKva.toFixed(1)} kVA connected`,
      `${t.demandKva.toFixed(1)} kVA demand`,
      `${a3.toFixed(0)} A 3φ`,
      `${ways} way${ways === 1 ? '' : 's'}`,
      `R/W/B ${pct(ph.R)}/${pct(ph.W)}/${pct(ph.B)} %`,
    ];
    const boxW = 226, boxX = L.w - this.PAD - boxW;

    return `<g>
      <text x="${x0}" y="${this.PAD + 16}" font-size="15" font-weight="700" fill="${P.ink}">${this._esc(name)}</text>
      <text x="${x0}" y="${this.PAD + 34}" font-size="10.5" fill="${P.inkSec}">${this._esc(from)}</text>
      <text x="${x0}" y="${this.PAD + 50}" font-size="10.5" fill="${P.muted}">${this._esc(`${Math.round(vll)}/${Math.round(vll / Math.sqrt(3))} V 3φ + N`)}</text>
      <rect x="${boxX}" y="${this.PAD}" width="${boxW}" height="${chips.length * 12 + 12}" rx="5" fill="${P.panel}" stroke="${P.border}"/>
      ${chips.map((c, i) => `<text x="${boxX + 10}" y="${this.PAD + 16 + i * 12}" font-size="9.5" fill="${P.inkSec}">${this._esc(c)}</text>`).join('')}
    </g>`;
  },

  _incomer(comp, L, P, x0) {
    const inc = L.inc;
    const x = x0 + this.INCOMER_X;
    const incGaps = [[L.devY, 20 * this.SYM_SCALE]];
    if (L.isoY) incGaps.push([L.isoY, 20 * this.SYM_SCALE]);
    L.supply.forEach((acc, i) => {
      if (acc.kind === 'metering' && acc.meter !== 'voltmeter') {
        incGaps.push([L.incTop + this.SRC_TO_DEV / 2 + i * this.SUPPLY_TAP_H - 18, 12]);
      }
    });
    let s = this._vline(x, L.incTop, L.busY, incGaps, P.line, 1.8);
    s += `<circle cx="${x}" cy="${L.incTop}" r="3.4" fill="${P.line}"/>`;
    s += `<text x="${x + 10}" y="${L.incTop + 4}" font-size="10" fill="${P.inkSec}">${this._esc(inc.source ? inc.source.name : 'supply')}</text>`;

    // Supply-side accessory taps, above the incomer device. Drawn to the RIGHT
    // of the riser: there is only INCOMER_X of margin to its left, which a
    // right-aligned label overruns into negative x and clips out of the sheet.
    L.supply.forEach((acc, i) => {
      const y = L.incTop + this.SRC_TO_DEV / 2 + i * this.SUPPLY_TAP_H;
      const gx = x + 74;
      const item = this._accItem(acc, comp);
      const stroke = item.status === 'warn' ? P.warn : P.line;
      const pt = this._protType(item.prot);
      const fx = x + 26;
      let g = `<g><title>${this._esc('Supply-side tap — stays live with the board switched off\n' + item.tip)}</title>`;
      // Current transformer on the riser for an ammeter, just above the tap.
      if (acc.kind === 'metering' && acc.meter !== 'voltmeter') {
        g += this._sym('ct', x, y - 18, P, this._native('ct', P), null, 0.6)
          + `<text x="${x - 8}" y="${y - 14}" text-anchor="end" font-size="8" fill="${P.muted}">${this._esc(acc.ct_ratio || 'CT')}</text>`;
      }
      if (pt) {
        g += `<line x1="${x}" y1="${y}" x2="${fx - 14}" y2="${y}" stroke="${P.line}" stroke-width="1.2"/>`
          + `<line x1="${fx + 14}" y1="${y}" x2="${gx}" y2="${y}" stroke="${P.line}" stroke-width="1.2"/>`
          + this._sym(pt, fx, y, P, this._native(pt, P), null, 0.7, 90);
      } else {
        g += `<line x1="${x}" y1="${y}" x2="${gx}" y2="${y}" stroke="${P.line}" stroke-width="1.2"/>`;
      }
      g += this._glyph(item.glyph, gx, y, P, stroke, item)
        + `<text x="${gx + 16}" y="${y - 2}" font-size="9" fill="${P.ink}">${this._esc(this._trunc(acc.label || '', 20))}</text>`
        + `<text x="${gx + 16}" y="${y + 9}" font-size="8.5" fill="${P.muted}">${this._esc(this._trunc(this._accSpec(acc), 34))}</text>`
        + `<text x="${gx + 16}" y="${y + 19}" font-size="8.5" fill="${P.muted}">${this._esc(item.prot ? `${item.prot.a} A ${item.prot.type === 'mcb' ? 'MCB' : item.prot.type}` : 'unprotected')}</text>`
        + `</g>`;
      s += g;
    });

    // Incomer device
    const label = inc.device_label || (inc.rating_a ? `${inc.rating_a} A` : 'incomer — rating unknown');
    const glyph = inc.device && inc.device.type === 'fuse' ? 'fuse' : 'mcb';
    const known = inc.rating_a != null;
    s += `<g><title>${this._esc(`Incomer: ${label}${inc.basis === 'feeder_way' ? ' (from the feeding board\'s way)' : inc.basis === 'sld' ? ' (from the SLD)' : ''}`)}</title>`
      + this._glyph(glyph, x, L.devY, P, known ? P.line : P.warn)
      + `<text x="${x + 16}" y="${L.devY + 1}" font-size="10.5" font-weight="700" fill="${known ? P.ink : P.warn}">${this._esc(label)}</text>`
      + `<text x="${x + 16}" y="${L.devY + 12}" font-size="8.5" fill="${P.muted}">${this._esc(inc.basis === 'sld' ? 'from the SLD' : inc.basis === 'feeder_way' ? 'from the feeding board' : 'not modelled')}</text>`
      + `</g>`;

    if (L.isoY) {
      s += `<g><title>Board main isolator</title>`
        + this._gSwitch(x, L.isoY, P, P.line)
        + `<text x="${x + 16}" y="${L.isoY + 4}" font-size="10" fill="${P.inkSec}">${this._esc(inc.isolator.props.name || 'Main switch')}</text>`
        + `</g>`;
    }
    return s;
  },

  // Row headings of the info table, in drawing order; a row is dropped when
  // its detail group is switched off, exactly as the label lines are.
  _tableRows(D) {
    const r = [{ k: 'way', h: 'Way', bold: true }, { k: 'device', h: 'Device' }, { k: 'desc', h: 'Description' }];
    if (D.phase) r.push({ k: 'phase', h: 'Phase' });
    if (D.cable) r.push({ k: 'cable', h: 'Cable mm²' }, { k: 'len', h: 'Length m' }, { k: 'ecc', h: 'ECC mm²' });
    if (D.load) r.push({ k: 'amps', h: 'Load A' }, { k: 'kva', h: 'Load kVA' });
    return r;
  },

  _busRow(row, ri, L, P, D, x0, comp) {
    const busY = L.busY + ri * L.rowH;
    const xs = L.xs[ri].map(v => x0 + v);
    const busEndX = x0 + Math.max(L.rowW[ri] + 30, 260);
    let s = `<line x1="${x0}" y1="${busY}" x2="${busEndX}" y2="${busY}" stroke="${P.bus}" stroke-width="3.4" stroke-linecap="round"/>`;

    // Riser joining this busbar section to the previous one.
    if (ri > 0) {
      const prevY = L.busY + (ri - 1) * L.rowH;
      s += `<line x1="${x0 + 6}" y1="${prevY}" x2="${x0 + 6}" y2="${busY}" stroke="${P.bus}" stroke-width="1.6" stroke-dasharray="4,3"/>`;
      s += `<text x="${x0 + 12}" y="${busY - 6}" font-size="8.5" fill="${P.muted}">busbar continued</text>`;
    }

    if (D.elgroups) {
      for (const br of this._elBrackets(row)) {
        const idn = ((comp.props.el_ratings || {})[br.group]) || 30;
        const txtW = `EL ${br.group} · ${idn} mA`.length * 5.8 + 16;
        const mid = (xs[br.from] + xs[br.to]) / 2;
        const half = Math.max((xs[br.to] - xs[br.from]) / 2 + 26, txtW / 2);
        const ax = mid - half, bx = mid + half;
        const y = busY + this.BUS_TO_RCD;
        s += `<g><title>${this._esc(`Earth-leakage group ${br.group} — IΔn ${idn} mA, shared by ${br.to - br.from + 1} way(s)`)}</title>`
          + `<rect x="${ax}" y="${y}" width="${bx - ax}" height="${this.RCD_H}" rx="4" fill="${P.panel}" stroke="${P.accent}" stroke-width="1.2"/>`
          + `<text x="${(ax + bx) / 2}" y="${y + 14}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${P.accent}">${this._esc(`EL ${br.group} · ${idn} mA`)}</text>`
          + `</g>`;
      }
    }

    const devY = busY + L.btd;
    const labelTop = devY + this.LABEL_DY;
    const barsY = labelTop + L.maxLines * this.LINE_H + this.BAR_GAP;
    const peY = barsY + this.BAR_PITCH;

    // Accessory bay: a dashed enclosure round the leading accessory columns.
    const nAcc = row.filter(it => it.kind === 'acc').length;
    if (nAcc) {
      const bx0 = xs[0] - row[0].w / 2 + 3, bx1 = xs[nAcc - 1] + row[nAcc - 1].w / 2 - 3;
      s += `<rect x="${bx0}" y="${busY + 6}" width="${bx1 - bx0}" height="${(D.bars ? peY + 8 : devY + 60) - busY - 6}" rx="6" fill="none" stroke="${P.muted}" stroke-width="1" stroke-dasharray="5,4"/>`
        + `<text x="${bx0 + 6}" y="${busY + 17}" font-size="8.5" fill="${P.muted}">Board accessories</text>`;
    }

    row.forEach((it, i) => {
      const x = xs[i];
      const stroke = D.status ? this._statusColor(it.status, P) : P.line;
      let g = `<g><title>${this._esc(it.tip)}</title>`;
      if (it.kind === 'acc') {
        // Protective device, then the accessory, then its termination: PE for
        // an SPD, N for everything else — the conductor stops there.
        const protY = busY + this.PROT_DY;
        const endY = it.glyph === 'spd' ? peY : barsY;
        const gaps = [[devY, (it.glyph === 'spd' ? 25 : 14) * this.SYM_SCALE]];
        const pt = this._protType(it.prot);
        if (pt) gaps.push([protY, 20 * 0.7]);
        g += this._vline(x, busY, D.bars ? endY : devY + 26, gaps, stroke, 1.4);
        if (pt) g += this._sym(pt, x, protY, P, this._native(pt, P), null, 0.7);
        g += this._glyph(it.glyph, x, devY, P, stroke, it);
        if (D.bars) g += `<circle cx="${x}" cy="${endY}" r="2.4" fill="${P.line}"/>`;
      } else {
        const endY = it.spare ? devY + 30 : (D.bars ? peY : devY + 26) + (D.load ? 14 : 0);
        g += this._vline(x, busY, endY, [[devY, 20 * this.SYM_SCALE]], stroke, 1.4);
        g += this._glyph(it.glyph, x, devY, P, stroke, it);
        if (D.load && !it.spare) {
          const motor = (it.poles === '3P' || it.phase === 'RWB')
            && /pump|motor|fan|compress|aircon|a\/c|hvac|drive/i.test(it.wayDesc || '');
          const lt = motor ? 'motor_induction' : 'static_load';
          g += this._sym(lt, x, endY + COMPONENT_DEFS[lt].height / 2, P, P.line, null, 1);
        }
      }
      if (D.phase && !D.table) {
        // Phase chip sits left of the drop so the conductor never crosses it.
        const pc = P.phase[it.phase] || P.muted;
        const tw = String(it.phase).length * 5.6;
        g += `<rect x="${x - 10 - tw - 11}" y="${devY + this.TICK_DY - 5}" width="9" height="9" rx="2" fill="${pc}"/>`;
        g += `<text x="${x - 8}" y="${devY + this.TICK_DY + 3}" text-anchor="end" font-size="9" fill="${P.inkSec}">${this._esc(it.phase)}</text>`;
      }
      if (!D.table) {
        // Labels sit on a page-coloured patch, so the conductor reads as passing
        // behind them rather than being struck through the text.
        const lw = it.w - 12, lh = it.lines.length * this.LINE_H + 2;
        g += `<rect x="${x - lw / 2}" y="${labelTop - 10}" width="${lw}" height="${lh}" fill="${P.surface}"/>`;
        it.lines.forEach((ln, li) => {
          g += `<text x="${x}" y="${labelTop + li * this.LINE_H}" text-anchor="middle" font-size="${ln.bold ? 9.5 : 9}"
          font-weight="${ln.bold ? 700 : 400}" fill="${ln.dim ? P.muted : P.ink}">${this._esc(ln.text)}</text>`;
        });
      }
      g += `</g>`;
      s += g;
    });

    if (L.tRows.length) {
      const top = peY + 14 + (D.load ? 56 : 0);
      const h = L.tRows.length * this.TBL_ROW;
      const left = x0, right = xs.length ? xs[xs.length - 1] + row[row.length - 1].w / 2 : busEndX;
      s += `<rect x="${left}" y="${top}" width="${right - left}" height="${h}" fill="none" stroke="${P.border}"/>`;
      L.tRows.forEach((r, ri2) => {
        const y = top + ri2 * this.TBL_ROW;
        if (ri2 > 0) s += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${P.border}"/>`;
        s += `<text x="${left + 5}" y="${y + 10}" font-size="8.5" font-weight="600" fill="${P.muted}">${this._esc(r.h)}</text>`;
      });
      const hx = xs[0] - row[0].w / 2;
      s += `<line x1="${hx}" y1="${top}" x2="${hx}" y2="${top + h}" stroke="${P.border}"/>`;
      row.forEach((it, i) => {
        const x = xs[i];
        s += `<line x1="${x + it.w / 2}" y1="${top}" x2="${x + it.w / 2}" y2="${top + h}" stroke="${P.border}"/>`;
        L.tRows.forEach((r, ri2) => {
          const y = top + ri2 * this.TBL_ROW + 10;
          if (r.k === 'phase') {
            const pc = P.phase[it.phase] || P.muted;
            const tw = String(it.phase).length * 5.4;
            s += `<rect x="${x - tw / 2 - 7}" y="${y - 8}" width="8" height="8" rx="2" fill="${pc}"/>`
              + `<text x="${x - tw / 2 + 4}" y="${y}" font-size="9" fill="${P.ink}">${this._esc(it.phase)}</text>`;
            return;
          }
          const v = it.cells ? it.cells[r.k] : '';
          s += `<text x="${x}" y="${y}" text-anchor="middle" font-size="9" font-weight="${r.bold ? 700 : 400}" fill="${r.k === 'desc' && it.spare ? P.muted : P.ink}">${this._esc(v)}</text>`;
        });
      });
    }

    if (D.bars) {
      s += `<line x1="${x0}" y1="${barsY}" x2="${busEndX}" y2="${barsY}" stroke="${P.line}" stroke-width="1.6"/>`
        + `<text x="${x0 - 2}" y="${barsY - 4}" font-size="9" fill="${P.muted}">N</text>`
        + `<line x1="${x0}" y1="${peY}" x2="${busEndX}" y2="${peY}" stroke="${P.line}" stroke-width="1.6" stroke-dasharray="6,3"/>`
        + `<text x="${x0 - 2}" y="${peY + 10}" font-size="9" fill="${P.muted}">PE</text>`;
    }
    return s;
  },

  // ── Zoom ────────────────────────────────────────────────────────────
  _applyZoom() {
    const el = document.querySelector('#dbd-canvas svg');
    if (!el) return;
    el.setAttribute('width', Math.round(this._size.w * this._zoom));
    el.setAttribute('height', Math.round(this._size.h * this._zoom));
    const lbl = document.getElementById('dbd-zoom-label');
    if (lbl) lbl.textContent = Math.round(this._zoom * 100) + '%';
  },

  zoom(factor) {
    this._zoom = Math.min(3, Math.max(0.25, this._zoom * factor));
    this._applyZoom();
  },

  _fitZoom() {
    const host = document.getElementById('dbd-canvas');
    if (!host || !this._size.w) return 1;
    const avail = host.clientWidth - 24;
    return avail > 0 ? Math.min(1, Math.max(0.25, avail / this._size.w)) : 1;
  },

  fit() {
    this._zoom = this._fitZoom();
    this._applyZoom();
  },

  // Fitting a 12-way board into a narrow pane gives an unreadable thumbnail, so
  // the opening view keeps the labels legible and lets the user scroll; Fit is
  // still an honest fit-to-width.
  autoZoom() {
    this._zoom = Math.max(0.7, this._fitZoom());
    this._applyZoom();
  },

  // ── Export ──────────────────────────────────────────────────────────
  // Exports always use the light palette so the drawing stays legible on paper.
  _exportNode(board) {
    const svg = this.buildSVG({ dark: false, board: board || this.board() });
    if (!svg) return null;
    const wrap = document.createElement('div');
    wrap.innerHTML = svg;
    return { node: wrap.firstElementChild, w: this._size.w, h: this._size.h };
  },

  _fileBase(board) {
    const b = board || this.board();
    const proj = String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_');
    const name = String((b && (b.props.name || b.id)) || 'board').replace(/[^a-z0-9]+/gi, '_');
    return `${proj}_${name}`;
  },

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  exportSVG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export — select a board first.'); return; }
    const str = new XMLSerializer().serializeToString(ex.node);
    this._download(new Blob([str], { type: 'image/svg+xml' }), `${this._fileBase()}_single_line.svg`);
  },

  exportPNG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export — select a board first.'); return; }
    Project._rasterizeSVG(ex.node, ex.w, ex.h, 2, (canvas) => {
      canvas.toBlob((blob) => this._download(blob, `${this._fileBase()}_single_line.png`), 'image/png');
    });
  },

  // PNG data URL for a PDF. Resolves null when there is nothing to draw.
  rasterize(scale, board) {
    return new Promise((resolve) => {
      const ex = this._exportNode(board);
      if (!ex) { resolve(null); return; }
      Project._rasterizeSVG(ex.node, ex.w, ex.h, scale || 2, (canvas) => {
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: ex.w, h: ex.h });
      });
    });
  },

  // ── Print-ready sheet ───────────────────────────────────────────────
  // A3 landscape with a drawn title block; A4 when the drawing is small enough
  // to stay legible. `allBoards` emits one sheet per board in the project.
  async exportSheet(allBoards) {
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) { UI.alert('PDF library not loaded.'); return; }
    const boards = allBoards
      ? [...AppState.components.values()].filter(c => c.type === 'distribution_board')
        .sort((a, b) => String(a.props.name || a.id).localeCompare(String(b.props.name || b.id), undefined, { numeric: true }))
      : [this.board()].filter(Boolean);
    if (!boards.length) { UI.alert('No distribution boards to draw.'); return; }

    Project._statusMsg(`Building ${boards.length} single-line sheet${boards.length === 1 ? '' : 's'}…`);
    let doc = null;
    for (const b of boards) {
      const img = await this.rasterize(2, b);
      if (!img) continue;
      const landscape = img.w >= img.h;
      const fmt = img.w > 1200 ? 'a3' : 'a4';
      if (!doc) doc = new jsPDFCtor({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: fmt });
      else doc.addPage(fmt, landscape ? 'landscape' : 'portrait');
      this._sheetFrame(doc, b, img);
    }
    if (!doc) { UI.alert('Nothing to draw.'); return; }
    doc.save(`${this._fileBase(boards[0])}${allBoards ? '_boards' : ''}_single_line.pdf`);
    Project._statusMsg('Single-line sheet exported.');
  },

  _sheetFrame(doc, board, img) {
    const pw = doc.internal.pageSize.getWidth();
    const phh = doc.internal.pageSize.getHeight();
    const m = 10, tbH = 22;
    doc.setDrawColor(60);
    doc.rect(m, m, pw - m * 2, phh - m * 2);
    doc.rect(m, phh - m - tbH, pw - m * 2, tbH);

    const inc = DBAccessories.incomer(board);
    doc.setFontSize(12); doc.setFont(undefined, 'bold');
    doc.text(String(board.props.name || board.id), m + 4, phh - m - tbH + 8);
    doc.setFontSize(8.5); doc.setFont(undefined, 'normal');
    doc.text(`Project: ${AppState.projectName || 'Untitled'}`, m + 4, phh - m - tbH + 15);
    doc.text(`Incomer: ${inc.device_label || (inc.rating_a ? inc.rating_a + ' A' : 'not modelled')}`, m + 90, phh - m - tbH + 8);
    doc.text(`Ways: ${(board.props.circuits || []).length}`, m + 90, phh - m - tbH + 15);
    doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`, pw - m - 60, phh - m - tbH + 8);
    doc.text('Distribution board single line', pw - m - 60, phh - m - tbH + 15);

    // Fit the drawing into the frame above the title block, preserving aspect.
    const availW = pw - m * 2 - 8, availH = phh - m * 2 - tbH - 8;
    const scale = Math.min(availW / img.w, availH / img.h);
    const w = img.w * scale, h = img.h * scale;
    doc.addImage(img.dataUrl, 'PNG', m + 4 + (availW - w) / 2, m + 4, w, h, `dbd-${board.id}`, 'FAST');
  },
};
