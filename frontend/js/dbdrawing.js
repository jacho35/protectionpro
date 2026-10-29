/* ProtectionPro — Distribution board single-line drawing.
 *
 * A read-only DB single line generated from the board's circuit schedule: the
 * incomer, the busbar, every way with its protective device and cable, the
 * earth-leakage groupings, the board accessories (indicators, SPDs, metering,
 * utilities), the contactors that switch ways with their control circuit
 * (DBControls) and the N/PE bars.
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
  // Supply-side taps (ahead of the incomer): a tap conductor off the riser,
  // each accessory dropping from it like a busbar-accessory column.
  TAP_DY: 24,          // source terminal → tap conductor
  TAP_X0: 70,          // riser → first tap column centre
  TAP_PROT_DY: 30,     // tap conductor → protective device
  TAP_SYM_DY: 76,      // tap conductor → accessory symbol
  TAP_LBL_DY: 48,      // accessory symbol → first label baseline (as LABEL_DY)
  CT_PITCH: 28,        // riser CTs (ammeters), one under another
  DROP_W: 118,         // way column pitch
  DROP_X0: 62,         // first drop, measured from the left pad
  TABLE_HDR: 74,       // extra left margin for the row headings in table mode
  STRIP_H: 24,         // section title strip
  BAND_GAP: 20,        // between section compartments
  ACC_W: 88,           // accessory column pitch (narrower than a way)
  PROT_DY: 28,         // busbar → an accessory's protective device
  TBL_ROW: 14,         // info-table row pitch
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
  RISER_GUTTER: 18,    // left lane for the "busbar continued" riser when a busbar wraps
  LOAD_H: 62,          // PE bar → load symbol block
  SYM_SCALE: 1.3,      // device symbols are drawn this much larger than the SLD's
  CTR_OFF: 62,         // device centre → contactor pole centre
  CTR_DY: 56,          // extra drop length when a row carries contactor poles
  SEC_CTR_DY: 60,      // extra busbar → device room for a switched section (riser, contactor, sub-bus)
  SEC_CTR_Y: 28,       // busbar → a switched section's contactor
  SEC_BUS_Y: 56,       // busbar → its sub-bus, where the section's ways start
  CTL_BW: 560,         // control-circuit block width (one per control supply)
  CTL_GAP: 24,
  CTL_PAR: 68,         // pitch of parallel switching branches (operator + three label lines)

  DETAIL_DEFAULTS: {
    cable: true, load: true, phase: true, elgroups: true,
    bars: true, status: true, accessories: true, controls: true, meters: true,
    table: false,        // way info as a table under the load arrows instead of beside the device
    phaserows: false,    // a busbar row per phase: R ways, then W, then B, then three-phase
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
          ${toggle('controls', 'Controls', 'Draw the contactors on their ways and the control circuit that switches them')}
          ${toggle('meters', 'Meters', 'Draw the energy meters: on the incomer, on their ways, and a group\'s metered sub-busbar')}
          ${toggle('table', 'Info table', 'Show each way\'s information as a table below its load, instead of beside the device')}
          ${toggle('phaserows', 'Phase rows', 'Group the ways by phase, a row each: red, then white (yellow), then blue, then three-phase — how a board is usually built, though it takes more space')}
          <span class="sch-sep"></span>
          <button class="btn-small" data-dbd="svg" title="Download the drawing as a vector SVG">SVG</button>
          <button class="btn-small" data-dbd="png" title="Download the drawing as a PNG">PNG</button>
          <button class="btn-small" data-dbd="dxf" title="Download the drawing as a DXF for CAD (mm)">DXF</button>
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
      else if (a === 'dxf') this.exportDXF();
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
      if (!side.querySelector('#dbd-mtr-host')) side.innerHTML = '<div id="dbd-acc-host"></div><div id="dbd-ctl-host"></div><div id="dbd-mtr-host"></div>';
      DBAccessories.render(comp, side.querySelector('#dbd-acc-host'), () => this.render(), { mode: 'panel' });
      if (typeof DBControls !== 'undefined') DBControls.render(comp, side.querySelector('#dbd-ctl-host'), () => this.render(), { mode: 'panel' });
      if (typeof DBMeters !== 'undefined') DBMeters.render(comp, side.querySelector('#dbd-mtr-host'), () => this.render(), { mode: 'panel' });
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

  // The data a way's symbol carries as DXF attributes (identity, device,
  // cable, load + check) — shared by the single line and the GA.
  wayDxfAttrs(comp, c, verdict) {
    const vll = DBSchedule._boardVll(comp);
    const sec = (typeof DBSections !== 'undefined' && DBSections.has(comp)) ? DBSections.of(comp, c) : null;
    const elg = String(c.el_group || '').trim();
    const v = verdict === undefined ? this._verdicts(comp)[c.id] : verdict;
    return {
      BOARD: comp.props.name || comp.id, WAY: c.way ?? '', SECTION: sec ? sec.name : '',
      DESCRIPTION: c.description || '',
      RATING_A: Number(c.breaker_a) || '', CURVE: c.curve || '', POLES: c.poles || '1P',
      RCD_GROUP: elg, RCD_MA: elg ? (((comp.props.el_ratings || {})[elg]) || 30) : '',
      CABLE_MM2: c.cable_mm2 ?? '', CONDUCTOR: c.conductor || 'Cu',
      ECC_MM2: c.ecc_mm2 != null ? c.ecc_mm2 : 'min', LENGTH_M: Number(c.cable_m) || '',
      LOAD_VA: Number(c.load_va) || 0, CURRENT_A: DBSchedule._wayFlaA(c, vll).toFixed(1),
      PHASE: (c.poles === '3P' || c.phase === 'RWB') ? 'RWB' : (c.phase || 'R'),
      STATUS: v ? v.status : 'not checked',
    };
  },

  // An accessory's DXF attributes.
  accDxfAttrs(comp, acc) {
    const sec = (typeof DBSections !== 'undefined' && DBSections.has(comp)) ? DBSections.of(comp, acc) : null;
    return {
      BOARD: comp.props.name || comp.id, SECTION: sec ? sec.name : '', DESCRIPTION: acc.label || acc.kind,
      KIND: acc.kind, SPEC: this._accSpec(acc), PHASE: acc.phases || 'RWB',
      RATING_A: Number(acc.fuse_a) || '', PROTECTION: acc.fuse_type || '', TAP: acc.tap || 'busbar',
    };
  },

  // JSON for a data-dxf-attrs attribute (escaped for the SVG string).
  _dxfData(obj) { return this._esc(JSON.stringify(obj)); },

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
        const ai = this._accItem(acc, comp);
        ai.sec = (DBSections.of(comp, acc) || {}).id;
        items.push(ai);
      }
    }

    for (const c of this._sortedWays(comp)) {
      const v = verdicts[c.id] || null;
      const lines = [];
      // A feeder way: its load is the sub-board, drawn as a board with its name.
      const sub = c.type === 'feeder_db' && c.feedsDbId ? AppState.components.get(c.feedsDbId) : null;
      const wayKva = sub || c.type === 'feeder_db' ? (Number(c.downstream_kva) || 0) : (Number(c.load_va) || 0) / 1000;
      const dev = `${Number(c.breaker_a) || 0} A${c.curve ? ' ' + c.curve : ''}${c.poles && c.poles !== '1P' ? ' ' + c.poles : ''}`;
      lines.push({ text: `${/^\d/.test(String(c.way ?? '')) ? 'W' : ''}${c.way ?? ''} · ${dev}`, bold: true, tag: 'WAY_LABEL' });
      lines.push({ text: this._trunc(c.description || '—', 22), tag: 'DESC_LABEL' });
      // A spare way: nothing on it and no description. A described way with
      // no load yet ("Future geyser") keeps its description.
      const spare = !(Number(c.load_va) > 0) && !(Number(c.cable_m) > 0) && !String(c.description || '').trim() && c.type !== 'feeder_db';
      if (spare) lines[1] = { text: 'Spare', dim: true, tag: 'DESC_LABEL' };
      if (D.cable && !spare) {
        const ecc = c.ecc_mm2 != null ? `${c.ecc_mm2}` : 'min';
        lines.push({ text: `${c.cable_mm2 || '?'} mm² · ${c.cable_m || 0} m · E ${ecc}`, dim: true, tag: 'CABLE_LABEL' });
      }
      if (D.load && !spare) {
        const fla = DBSchedule._wayFlaA(c, vll);
        lines.push({ text: `${fla.toFixed(1)} A · ${wayKva.toFixed(2)} kVA`, dim: true, tag: 'LOAD_LABEL' });
      }
      const warns = DBSchedule._wayWarnings(c, !!v, vll);
      let tip = [`Way ${c.way ?? ''} — ${c.description || 'no description'}`,
        `${dev} ${c.poles || '1P'} on ${c.phase || 'R'}`,
        `${c.cable_mm2 || '?'} mm², ${c.cable_m || 0} m`,
        c.el_group ? `Earth leakage group ${c.el_group}` : 'No earth-leakage protection',
        ...(v && v.messages ? v.messages : []),
        ...warns].join('\n');

      const ctr = D.controls && typeof DBControls !== 'undefined' ? DBControls.wayContactor(comp, c) : null;
      if (ctr) tip += `\nSwitched by contactor ${ctr.tag} (${ctr.poles} ${ctr.rating_a} A ${ctr.category}) — ${DBControls.switchedBy(ctr)}`;
      // Its meter: a metered sub-bus group hangs the way from the sub-bus (as a
      // switched section does — a way already on one keeps it, its meter then
      // drawn on the drop); everything else is drawn on the way's drop.
      const mtr = D.meters && typeof DBMeters !== 'undefined' ? DBMeters.wayMeter(comp, c) : null;
      const msub = mtr && DBMeters.isSubbus(mtr) && !(ctr && ctr.arrangement === 'section') ? mtr : null;
      if (mtr) tip += `\nMetered by ${mtr.tag}${DBMeters.isGroup(mtr) ? ' (group' + (DBMeters.isVirtual(mtr) ? ', summed by the BMS)' : ', metered sub-bus)') : ''} — ${DBMeters.spec(mtr)} · ${DBMeters.comms(mtr)}`;
      const dxf = this.wayDxfAttrs(comp, c, v);
      if (ctr) dxf.CONTACTOR = ctr.tag;
      if (mtr) dxf.METER = mtr.tag;
      items.push({
        kind: 'way', w: this.DROP_W, glyph: 'mcb', ctr, mtr: msub ? null : mtr, msub,
        mtrLabel: mtr && !msub ? (DBMeters.isVirtual(mtr) ? mtr.tag + String.fromCharCode(97 + DBMeters.waysOf(comp, mtr).indexOf(c) % 26) : mtr.tag) : '',
        sec: (DBSections.of(comp, c) || {}).id, phase: (c.poles === '3P' || c.phase === 'RWB') ? 'RWB' : (c.phase || 'R'),
        poles: c.poles || '1P', spare, wayDesc: c.description || '',
        feeds: sub ? (sub.props.name || sub.id) : (c.type === 'feeder_db' ? 'Sub-board' : null),
        cells: {
          way: String(c.way ?? ''), device: dev, desc: this._trunc(c.description || (spare ? 'Spare' : '—'), 19),
          cable: spare ? '' : `${c.cable_mm2 || '?'}`, len: spare ? '' : `${c.cable_m || 0}`,
          ecc: spare ? '' : (c.ecc_mm2 != null ? `${c.ecc_mm2}` : 'min'),
          amps: spare ? '' : DBSchedule._wayFlaA(c, vll).toFixed(1),
          kva: spare ? '' : wayKva.toFixed(2),
        },
        elGroup: D.elgroups ? (c.el_group || '') : '',
        status: v ? v.status : (warns.length ? 'warn' : null),
        lines, tip, dxf,
      });
    }
    // A switched section's ways hang together off its sub-bus: they are drawn
    // side by side where the first of them falls, in schedule order.
    // (Per board section: each band draws its own part of the group.)
    const out = [];
    const done = new Set();
    // A metered sub-bus group is kept together the same way.
    const hub = (it) => (it.ctr && it.ctr.arrangement === 'section') ? it.ctr : it.msub || null;
    for (const it of items) {
      const k = hub(it);
      if (!k) { out.push(it); continue; }
      const key = k.id + '|' + (it.sec || '');
      if (done.has(key)) continue;
      done.add(key);
      out.push(...items.filter(o => hub(o) === k && o.sec === it.sec));
    }
    return out;
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
    const lines = [{ text: this._trunc(acc.label || '', 15), bold: true, tag: 'NAME_LABEL' }];
    const parts = this._accSpec(acc).replace('Control ', 'Ctl ').split(' · ');
    let cur = '';
    for (const p of parts) {
      if (cur && (cur + ' · ' + p).length > 16) { lines.push({ text: cur }); cur = p; }
      else cur = cur ? cur + ' · ' + p : p;
    }
    if (cur) lines.push({ text: this._trunc(cur, 17) });
    lines.push({ text: protText, dim: true, tag: 'PROT_LABEL' });
    const warns = DBAccessories.warnings(acc, DBAccessories.incomer(comp));
    return {
      kind: 'acc', w: this.ACC_W, glyph, accKind: acc.kind, prot, dxf: this.accDxfAttrs(comp, acc),
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

  // Contactors along one busbar row, drawn as devices in line:
  //  · 'single' / 'poles' — the pole sits on the way's drop under its breaker
  //    (drawn with the way); consecutive poles of one contactor are joined by
  //    a dashed mechanical link, the tag and size beside the last pole;
  //  · 'section' — the contactor sits on its own riser off the busbar and
  //    feeds a short sub-bus; the section's ways hang from that (_items keeps
  //    them side by side).
  // `sections`: false = the pole links (drawn under the drops), true = the
  // section risers (over them).
  // ── Meters (DBMeters) ───────────────────────────────────────────────
  _mtrDxf(comp, m) {
    return this._dxfData({ BOARD: comp.props.name || comp.id, TAG: m.tag, SCOPE: m.scope, SPEC: DBMeters.spec(m), COMMS: DBMeters.comms(m),
      CT: DBMeters.conn(m.conn).ct ? (m.ct_ratio || '') : '', POINTS: DBMeters.pointsOf(m).join(' ') });
  },
  // The meter box: "kWh" in a teal rectangle, its tag beside it.
  _gMeterBox(x, y, P, label, sub) {
    return `<rect x="${x}" y="${y - 7}" width="24" height="14" rx="2" fill="${P.surface}" stroke="${P.mtr}" stroke-width="1.4"/>`
      + `<text x="${x + 12}" y="${y + 3}" text-anchor="middle" font-size="7" font-weight="700" fill="${P.mtr}">kWh</text>`
      + `<text x="${x + 28}" y="${y + 1}" font-size="9" font-weight="700" fill="${P.mtr}" data-dxf-attr="TAG_LABEL">${this._esc(label)}</text>`
      + (sub ? `<text x="${x + 28}" y="${y + 10}" font-size="7.5" fill="${P.inkSec}" data-dxf-attr="SPEC_LABEL">${this._esc(sub)}</text>` : '');
  },
  // A meter on a way's drop: a CT on the conductor with the meter beside it,
  // or a direct meter beside the conductor joined to it.
  _gWayMeter(comp, m, label, x, y, P, ct) {
    const tip = `${m.tag} — ${DBMeters.spec(m)}\n${DBMeters.comms(m)}`;
    const sub = ct ? (m.ct_ratio || 'CT') : 'direct';
    return `<g><title>${this._esc(tip)}</title><g data-dxf-block="DB_METER" data-dxf-at="${x},${y}" data-dxf-attrs="${this._mtrDxf(comp, m)}">`
      + (ct ? `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${P.line}" stroke-width="1.3"/>` : `<circle cx="${x}" cy="${y}" r="1.8" fill="${P.mtr}"/>`)
      + `<line x1="${numAttr(x + (ct ? 5 : 0))}" y1="${y}" x2="${x + 9}" y2="${y}" stroke="${P.mtr}" stroke-width="1"/>`
      + this._gMeterBox(x + 9, y, P, label, sub) + `</g></g>`;
  },
  // The incomer meter(s): on the riser between the incomer device (or the
  // main isolator) and the busbar.
  _incomerMeter(comp, L, P, x) {
    if (!this.detail().meters || typeof DBMeters === 'undefined' || L.sec) return '';
    const ms = DBMeters.list(comp).filter(m => m.scope === 'incomer');
    let s = '';
    ms.forEach((m, j) => {
      const y = (L.isoY || L.devY) + 25 + j * 2;
      const ct = DBMeters.conn(m.conn).ct;
      s += `<g><title>${this._esc(`${m.tag} — incomer meter: ${DBMeters.spec(m)}\n${DBMeters.comms(m)}`)}</title>`
        + `<g data-dxf-block="DB_METER" data-dxf-at="${x},${y}" data-dxf-attrs="${this._mtrDxf(comp, m)}">`
        + (ct ? `<circle cx="${x}" cy="${y}" r="6" fill="${P.surface}" stroke="${P.line}" stroke-width="1.4"/>` : '')
        + `<line x1="${numAttr(x + (ct ? 6 : 0))}" y1="${y}" x2="${x + 12 + j * 70}" y2="${y}" stroke="${P.mtr}" stroke-width="1"/>`
        + this._gMeterBox(x + 12 + j * 70, y, P, m.tag, ct ? (m.ct_ratio || 'CT') : 'direct') + `</g></g>`;
    });
    return s;
  },
  // A metered sub-busbar group: a riser off the busbar through its isolator
  // and meter to a sub-bus the group's ways hang from (_items keeps them together).
  _mtrSubbus(row, xs, busY, P, comp) {
    let s = '';
    const runs = [];
    row.forEach((it, i) => {
      const m = it.msub || null;
      const cur = runs[runs.length - 1];
      if (m && cur && cur.m === m && cur.to === i - 1) cur.to = i;
      else if (m) runs.push({ m, from: i, to: i });
    });
    for (const r of runs) {
      const m = r.m;
      const mid = (xs[r.from] + xs[r.to]) / 2;
      const isoY = busY + 15, mY = busY + 38, sy = busY + this.SEC_BUS_Y;
      const ct = DBMeters.conn(m.conn).ct;
      s += `<g><title>${this._esc(`${m.tag} — group meter on a sub-busbar: ${DBMeters.spec(m)}\n${DBMeters.comms(m)}`)}</title>`
        + this._vline(mid, busY, sy, [[isoY, 9], ...(ct ? [[mY, 5]] : [])], P.line, 1.4)
        + this._gSwitch(mid, isoY, P, P.line)
        + `<text x="${mid - 12}" y="${isoY + 3}" text-anchor="end" font-size="8" fill="${P.inkSec}">${this._esc((m.iso_a || 63) + ' A')}</text>`
        + `<line x1="${xs[r.from] - 22}" y1="${sy}" x2="${numAttr(xs[r.to] + 22)}" y2="${sy}" stroke="${P.bus}" stroke-width="2.4" stroke-linecap="round"/>`
        + `<g data-dxf-block="DB_METER" data-dxf-at="${mid},${mY}" data-dxf-attrs="${this._mtrDxf(comp, m)}">`
        + (ct ? `<circle cx="${mid}" cy="${mY}" r="5" fill="none" stroke="${P.line}" stroke-width="1.3"/>` : `<circle cx="${mid}" cy="${mY}" r="1.8" fill="${P.mtr}"/>`)
        + `<line x1="${numAttr(mid + (ct ? 5 : 0))}" y1="${mY}" x2="${mid + 9}" y2="${mY}" stroke="${P.mtr}" stroke-width="1"/>`
        + this._gMeterBox(mid + 9, mY, P, m.tag, 'group · ' + (ct ? (m.ct_ratio || 'CT') : 'direct'))
        + `</g></g>`;
    }
    return s;
  },

  // A group summed by the BMS: each way carries its own meter (drawn on its
  // drop); a dashed bracket over the group's devices says they add up.
  _mtrSumBrackets(row, xs, devY, P) {
    let s = '';
    const runs = [];
    row.forEach((it, i) => {
      const m = it.mtr && DBMeters.isVirtual(it.mtr) ? it.mtr : null;
      const cur = runs[runs.length - 1];
      if (m && cur && cur.m === m && cur.to === i - 1) cur.to = i;
      else if (m) runs.push({ m, from: i, to: i });
    });
    for (const r of runs) {
      const y = devY - 30;
      const ax = xs[r.from] - 26, bx = xs[r.to] + 26;
      const label = `Σ ${r.m.tag} — summed by the BMS`;
      const tw = label.length * 5 + 12;
      const lx = (ax + bx) / 2;
      s += `<g><title>${this._esc(`${r.m.tag}: a meter on each of these ways, added into one total by the BMS`)}</title>`
        + `<path d="M${ax} ${y + 6} V${y} H${bx} V${y + 6}" fill="none" stroke="${P.mtr}" stroke-width="1.2" stroke-dasharray="4,3"/>`
        + `<rect x="${lx - tw / 2}" y="${y - 7}" width="${tw}" height="12" rx="3" fill="${P.surface}"/>`
        + `<text x="${lx}" y="${y + 2}" text-anchor="middle" font-size="8.5" font-weight="700" fill="${P.mtr}">${this._esc(label)}</text></g>`;
    }
    return s;
  },

  _ctrBrackets(row, xs, busY, ctrY, P, comp, sections) {
    let s = '';
    const runs = [];
    row.forEach((it, i) => {
      const k = it.ctr || null;
      const cur = runs[runs.length - 1];
      if (k && cur && cur.k === k && cur.to === i - 1) cur.to = i;
      else if (k) runs.push({ k, from: i, to: i });
    });
    for (const r of runs) {
      const k = r.k;
      if ((k.arrangement === 'section') !== !!sections) continue;
      const spec = `${k.poles} ${k.rating_a} A ${k.category}`;
      const by = DBControls.switchedBy(k);
      const attrs = this._dxfData({ BOARD: comp.props.name || comp.id, TAG: k.tag, DESCRIPTION: k.label || '',
        SPEC: spec, ARRANGEMENT: k.arrangement, SWITCHED_BY: by });
      const tip = `${k.tag} — contactor ${spec}${k.label ? ', ' + k.label : ''}\nSwitched by ${by}`;
      const label = (x, y) => `<text x="${x}" y="${y}" font-size="9.5" font-weight="700" fill="${P.ctl}" data-dxf-attr="TAG_LABEL">${this._esc(this._trunc(k.tag, 6))}</text>`
        + `<text x="${x}" y="${y + 10}" font-size="7.5" fill="${P.ctl}" data-dxf-attr="SPEC_LABEL">${this._esc(k.arrangement === 'section' ? spec : `${k.rating_a} A ${k.category}`)}</text>`
        + `<text x="${x}" y="${y + 19}" font-size="7.5" fill="${P.inkSec}" data-dxf-attr="SWITCHED_LABEL">${this._esc(this._trunc(by, 16))}</text>`;
      if (k.arrangement === 'section') {
        const mid = (xs[r.from] + xs[r.to]) / 2;
        const ry = busY + this.SEC_CTR_Y, sy = busY + this.SEC_BUS_Y;
        s += `<g><title>${this._esc(tip + '\nSwitched section — its ways hang from the sub-bus')}</title>`
          + this._vline(mid, busY, sy, [[ry, 12]], P.line, 1.4)
          + `<line x1="${xs[r.from] - 22}" y1="${sy}" x2="${numAttr(xs[r.to] + 22)}" y2="${sy}" stroke="${P.bus}" stroke-width="2.4" stroke-linecap="round"/>`
          + `<g data-dxf-block="DB_CONTACTOR" data-dxf-at="${mid},${ry}" data-dxf-attrs="${escHtml(attrs)}">`
          + this._gContactor(mid, ry, P, P.ctl) + label(mid + 10, ry - 4)
          + `</g></g>`;
        continue;
      }
      const lx = xs[r.to] + 10;
      s += `<g><title>${this._esc(tip)}</title>`
        + (r.to > r.from ? `<line x1="${xs[r.from] - 4.5}" y1="${ctrY}" x2="${xs[r.to] - 4.5}" y2="${ctrY}" stroke="${P.ctl}" stroke-width="1" stroke-dasharray="3,3"/>` : '')
        + `<g data-dxf-block="DB_CONTACTOR" data-dxf-at="${escHtml(xs[r.from])},${ctrY}" data-dxf-attrs="${escHtml(attrs)}">${label(lx, ctrY - 4)}</g></g>`;
    }
    return s;
  },

  // ── Control circuit ─────────────────────────────────────────────────
  // One ladder per control supply (and one for contactors with none): the
  // supply's MCB (and control transformer) on the L rail, then per contactor
  //  · the coil rung — selector Auto contact, the switching contacts in series
  //    or as parallel branches, the coil (A1–A2) to N; Hand–Off–Auto adds a
  //    Hand branch round the contacts;
  //  · a door-lamp rung through the contactor's auxiliary contact.
  // Every contact is drawn with its operator (handle, light, clock, θ …) and
  // its tag, device and setting under it. Under the ladders: the control
  // device schedule.
  _ctlDims(k) {
    const n = (k.switches || []).length;
    const auto = 52 + (k.combine === 'parallel' && n > 1 ? (n - 1) * this.CTL_PAR : 0);
    const hand = k.selector === 'hoa' ? 34 : 0;
    const lamp = k.lamp ? 50 : 0;
    return { auto, hand, lamp, h: auto + hand + lamp + 10 };
  },
  _ctlRungH(k) { return this._ctlDims(k).h; },
  _ctlHeadH(sup) { return 56 + (sup && sup.kind === 'transformer' ? 22 : 0); },

  _ctlLayout(comp, w, bottom) {
    if (typeof DBControls === 'undefined' || !DBControls.has(comp)) return null;
    const ctrs = DBControls.contactors(comp);
    const groups = [];
    for (const sup of DBControls.supplies(comp)) {
      const mine = ctrs.filter(k => k.supply === sup.id);
      if (mine.length) groups.push({ supply: sup, ctrs: mine });
    }
    const orphans = ctrs.filter(k => !DBControls.supply(comp, k.supply));
    if (orphans.length) groups.push({ supply: null, ctrs: orphans });
    const avail = w - this.PAD * 2;
    const perRow = Math.max(1, Math.floor((avail + this.CTL_GAP) / (this.CTL_BW + this.CTL_GAP)));
    const y0 = bottom - this.PAD + 34;
    let y = y0 + 14, x = 0, rowH = 0, col = 0;
    const blocks = [];
    for (const g of groups) {
      const h = this._ctlHeadH(g.supply) + 18 + g.ctrs.reduce((n, k) => n + this._ctlRungH(k), 0);
      if (col >= perRow) { y += rowH + this.CTL_GAP; x = 0; rowH = 0; col = 0; }
      blocks.push(Object.assign({ x, y, h }, g));
      x += this.CTL_BW + this.CTL_GAP; rowH = Math.max(rowH, h); col++;
    }
    const rows = DBControls.deviceSchedule(comp);
    const table = rows.length ? { y: y + rowH + 34, rows, w: Math.min(avail, 980) } : null;
    return { y0, blocks, table, y1: table ? table.y + 18 + rows.length * 15 : y + rowH };
  },

  // A control contact on a horizontal rung, centred on x: make (NO) or break
  // (NC), with its operator drawn above and joined by a dashed link.
  _ctlContact(x, y, P, op, nc) {
    const st = `fill="none" stroke="${P.line}" stroke-width="1.3"`;
    let s = `<path d="M ${x - 12} ${y} L ${x + 10} ${y - 9} M ${x + 12} ${y} V ${numAttr(y - (nc ? 12 : 5))}" ${st}/>`;
    if (!op) return s;
    const oy = y - 21;
    const box = (t) => `<rect x="${x - 8}" y="${oy - 5}" width="14" height="10" rx="1.5" fill="${P.surface}" stroke="${P.line}" stroke-width="1"/>`
      + `<text x="${x - 1}" y="${numAttr(oy + 2.5)}" text-anchor="middle" font-size="6.5" fill="${P.ink}">${t}</text>`;
    s += `<line x1="${x - 1}" y1="${y - 5}" x2="${x - 1}" y2="${oy + 5}" stroke="${P.line}" stroke-width="0.9" stroke-dasharray="2,1.5"/>`;
    if (op === 'hand') s += `<path d="M ${x - 7} ${oy + 5} H ${x + 5} M ${x - 7} ${oy + 1} V ${oy + 5}" ${st}/>`;
    else if (op === 'push') s += `<path d="M ${x - 7} ${oy + 5} H ${x + 5} M ${x - 1} ${oy + 5} V ${oy} M ${x - 5} ${oy} H ${x + 3}" ${st}/>`;
    else if (op === 'clock') s += `<circle cx="${x - 1}" cy="${oy}" r="5" fill="${P.surface}" stroke="${P.line}" stroke-width="1"/><path d="M ${x - 1} ${oy} V ${oy - 3.5} M ${x - 1} ${oy} H ${x + 2}" fill="none" stroke="${P.line}" stroke-width="0.9"/>`;
    else s += box({ light: 'lx', theta: 'θ', bms: 'B', fire: 'F' }[op] || '?');
    return s;
  },

  _ctlOp(kind) {
    return { photocell: 'light', timer: 'clock', astro: 'clock', thermostat: 'theta', bms: 'bms', pushbutton: 'push', fire: 'fire' }[kind] || null;
  },

  _ctlSvg(comp, L, P, x0) {
    const C = L.ctl;
    const esc = (v) => this._esc(v);
    const board = comp.props.name || comp.id;
    let s = `<text x="${x0}" y="${C.y0}" font-size="12" font-weight="700" fill="${P.ink}">Control circuits</text>`;
    const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${P.line}" stroke-width="1.3"/>`;
    const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="2.2" fill="${P.line}"/>`;
    // Up to three centred label lines under a contact or coil.
    const labels = (x, y, cw, ls) => ls.filter(l => l && l.t).map((l, i) =>
      `<text x="${x}" y="${y + i * 10}" text-anchor="middle" font-size="${l.b ? 8.5 : 8}" font-weight="${l.b ? 700 : 400}" fill="${l.c || (l.b ? P.ink : P.inkSec)}">${esc(this._trunc(l.t, Math.max(6, Math.floor(cw / 4.7))))}</text>`).join('');
    for (const b of C.blocks) {
      const bx = x0 + b.x, by = b.y, BW = this.CTL_BW;
      const Lx = bx + 30, Nx = bx + BW - 24;
      const sup = b.supply;
      const tx = sup && sup.kind === 'transformer';
      const head = sup
        ? (sup.kind === 'external' ? `${sup.voltage || ''} external supply` : `MCB ${sup.breaker_a || '?'} A · ${sup.phase || 'R'}${tx ? ' → control transformer' : ''} · ${sup.voltage || ''}`)
        : 'Pick a control supply for these contactors';
      s += `<rect x="${bx}" y="${by}" width="${BW}" height="${escHtml(b.h)}" rx="6" fill="${P.panel}" stroke="${P.border}"/>`
        + `<text x="${bx + 12}" y="${by + 18}" font-size="10.5" font-weight="700" fill="${sup ? P.ink : P.warn}">${esc(sup ? sup.tag : 'No control supply')}</text>`
        + `<text x="${bx + 12 + (sup ? String(sup.tag).length * 6.6 + 8 : 120)}" y="${by + 18}" font-size="9" fill="${P.inkSec}">${esc(this._trunc(head + (sup && sup.note ? ' · ' + sup.note : ''), 74))}</text>`;
      const top = by + 30, railTop = by + this._ctlHeadH(sup);
      if (sup && sup.kind !== 'external') {
        s += this._vline(Lx, top, railTop, [[top + 12, 10], ...(tx ? [[top + 36, 13]] : [])], P.line, 1.4)
          + this._sym('cb', Lx, top + 12, P, this._native('cb', P), null, 0.5, 0,
            { BOARD: board, TAG: sup.tag, DESCRIPTION: 'Control supply', RATING_A: sup.breaker_a || '', PHASE: sup.phase || '' })
          + (tx ? this._gCtlTx(Lx, top + 36, P, P.line) : '');
      } else {
        s += `<line x1="${Lx}" y1="${top}" x2="${Lx}" y2="${railTop}" stroke="${P.line}" stroke-width="1.4" stroke-dasharray="4,3"/>`;
      }
      s += `<text x="${Lx - 12}" y="${railTop + 4}" font-size="9" font-weight="700" fill="${P.muted}">L</text>`
        + `<text x="${Nx + 5}" y="${railTop + 4}" font-size="9" font-weight="700" fill="${P.muted}">N</text>`;

      let ry = railTop + 30, lastY = ry;
      for (const k of b.ctrs) {
        const dm = this._ctlDims(k);
        const sw = k.switches || [];
        const par = k.combine === 'parallel' && sw.length > 1;
        const hasSel = (k.selector || 'hoa') !== 'none';
        const coilX = Nx - 34;
        const colL = Lx + 16;
        const nCols = (hasSel ? 1 : 0) + (par ? 1 : sw.length);
        const CW = nCols ? Math.max(58, Math.min(112, (coilX - 34 - colL) / nCols)) : 0;
        const cx = (i) => colL + CW * (i + 0.5);
        const gaps = [];                 // [from, to] stretches of the rung the elements fill
        let g = '';
        let col = 0;
        const selTag = k.selector_tag || 'S';
        if (hasSel) {
          const x = cx(col++);
          gaps.push([x - 12, x + 12]);
          g += this._ctlContact(x, ry, P, 'hand', false)
            + labels(x, ry + 18, CW, [{ t: `${selTag} ${k.selector === 'hoa' ? 'H-O-A' : 'O-A'}`, b: true }, { t: 'Auto' }]);
        }
        const swAttrs = (x) => this._dxfData({ BOARD: board, TAG: x.tag || '', KIND: DBControls.switchKind(x.kind).label,
          DEVICE: DBControls.switchDevice(x), SETTING: x.setting || '', CONTACT: DBControls.switchContact(x),
          MOUNTING: DBControls.mountLabel(DBControls.switchMount(x)), CONTACTOR: k.tag });
        const swLabels = (x) => [{ t: `${x.tag || ''} ${DBControls.switchKind(x.kind).label.toLowerCase()}`, b: true },
          { t: x.device ? x.device : DBControls.switchMount(x) === 'din' ? '' : DBControls.mountLabel(DBControls.switchMount(x)).toLowerCase() },
          { t: x.setting || '' }];
        const swTip = (x) => `${x.tag}: ${DBControls.switchDevice(x)}${x.setting ? ' — ' + x.setting : ''} · ${DBControls.switchContact(x)} · ${DBControls.mountLabel(DBControls.switchMount(x))}`;
        const contact = (x, xx, yy) => `<g><title>${esc(swTip(x))}</title><g data-dxf-block="DB_CTL_CONTACT" data-dxf-at="${xx},${yy}" data-dxf-attrs="${swAttrs(x)}">`
          + this._ctlContact(xx, yy, P, this._ctlOp(x.kind), /^NC/i.test(DBControls.switchContact(x)))
          + `</g></g>` + labels(xx, yy + 18, CW, swLabels(x));
        if (par) {
          const x = cx(col++);
          const gx0 = x - CW / 2 + 5, gx1 = x + CW / 2 - 5;
          const yl = ry + (sw.length - 1) * this.CTL_PAR;
          gaps.push([x - 12, x + 12]);
          g += line(gx0, ry, gx0, yl) + line(gx1, ry, gx1, yl) + dot(gx0, ry) + dot(gx1, ry);
          sw.forEach((x2, i) => {
            const yy = ry + i * this.CTL_PAR;
            if (i) g += line(gx0, yy, x - 12, yy) + line(x + 12, yy, gx1, yy);
            g += contact(x2, x, yy);
          });
        } else {
          for (const x2 of sw) { const x = cx(col++); gaps.push([x - 12, x + 12]); g += contact(x2, x, ry); }
        }
        gaps.push([coilX - 18, coilX + 18]);
        // The rung itself, broken where each element sits.
        let cur = Lx;
        for (const [a, z] of gaps) { if (a > cur) g += line(cur, ry, a, ry); cur = z; }
        g += line(cur, ry, Nx, ry) + dot(Lx, ry) + dot(Nx, ry);
        // Hand: a branch round the Auto contact and the switching contacts.
        if (k.selector === 'hoa') {
          const hy = ry + dm.auto;
          const nL = Lx + 8, nR = colL + CW * nCols + 6, hx = cx(0);
          g += `<path d="M ${nL} ${ry} V ${hy} H ${hx - 12} M ${hx + 12} ${hy} H ${nR} V ${ry}" fill="none" stroke="${P.line}" stroke-width="1.3"/>`
            + dot(nL, ry) + dot(nR, ry)
            + this._ctlContact(hx, hy, P, null, false)
            // The selector's link, broken round the Auto contact's labels.
            + `<path d="M ${hx - 1} ${hy - 5} V ${ry + 34} M ${hx - 1} ${ry + 6} V ${ry - 5}" fill="none" stroke="${P.line}" stroke-width="0.9" stroke-dasharray="2,1.5"/>`
            + labels(hx, hy + 16, CW, [{ t: `${selTag} Hand` }]);
          lastY = hy;
        }
        // The coil.
        const ways = DBControls.waysOf(comp, k).map(c => c.way).join(', ');
        const attrs = this._dxfData({ BOARD: board, TAG: k.tag, DESCRIPTION: k.label || '',
          SPEC: `${k.poles} ${k.rating_a} A ${k.category}`, COIL: k.coil || '', SWITCHED_BY: DBControls.switchedBy(k), SUPPLY: sup ? sup.tag : '' });
        g += `<g><title>${esc(`${k.tag} coil (${k.coil || ''}) — ${k.label || 'contactor'}${ways ? ', ways ' + ways : ''}`)}</title><g data-dxf-block="DB_CONTACTOR_COIL" data-dxf-at="${coilX},${ry}" data-dxf-attrs="${escHtml(attrs)}">`
          + `<rect x="${coilX - 18}" y="${ry - 9}" width="36" height="18" fill="${P.surface}" stroke="${P.ctl}" stroke-width="1.6"/>`
          + `<text x="${coilX}" y="${numAttr(ry + 3.5)}" text-anchor="middle" font-size="9" font-weight="700" fill="${P.ctl}" data-dxf-attr="TAG_LABEL">${esc(this._trunc(k.tag, 5))}</text></g></g>`
          + `<text x="${coilX - 20}" y="${ry - 12}" text-anchor="end" font-size="7" fill="${P.muted}">A1</text><text x="${coilX + 20}" y="${ry - 12}" font-size="7" fill="${P.muted}">A2</text>`
          + labels(coilX, ry + 20, 92, [{ t: `coil ${k.coil || ''}` }, { t: ways ? `ways ${ways}` : 'no ways' }, { t: k.label || '' }]);
        // Door lamp, through the contactor's own auxiliary contact.
        if (k.lamp) {
          const ly = ry + dm.auto + dm.hand + 8;
          const sh = DBControls.lampShows(k);
          const col2 = DBControls.lampColour(k);
          const ax = colL + 30;
          const lattrs = this._dxfData({ BOARD: board, TAG: DBControls.lampTag(k), COLOUR: col2.label, SHOWS: sh.label, CONTACTOR: k.tag, CONTACT: sh.aux });
          g += line(Lx, ly, ax - 12, ly) + line(ax + 12, ly, coilX - 9, ly) + line(coilX + 9, ly, Nx, ly) + dot(Lx, ly) + dot(Nx, ly)
            + this._ctlContact(ax, ly, P, null, sh.nc)
            + labels(ax, ly + 16, 80, [{ t: `${k.tag} ${sh.aux}`, c: P.ctl }])
            + `<g><title>${esc(`${DBControls.lampTag(k)}: ${DBControls.lampSpec(k)}`)}</title><g data-dxf-block="DB_CTL_LAMP" data-dxf-at="${coilX},${ly}" data-dxf-attrs="${lattrs}">`
            + `<circle cx="${coilX}" cy="${ly}" r="9" fill="${P.surface}" stroke="${escHtml(col2.hex)}" stroke-width="1.6"/>`
            + `<path d="M ${coilX - 6.4} ${ly - 6.4} L ${numAttr(coilX + 6.4)} ${numAttr(ly + 6.4)} M ${numAttr(coilX + 6.4)} ${ly - 6.4} L ${coilX - 6.4} ${numAttr(ly + 6.4)}" stroke="${escHtml(col2.hex)}" stroke-width="1.3"/></g></g>`
            + labels(coilX, ly + 20, 110, [{ t: `${DBControls.lampTag(k)} ${col2.label.toLowerCase()} LED`, b: true }, { t: `door · lit when ${sh.nc ? 'open' : 'closed'}` }]);
          lastY = ly;
        } else lastY = Math.max(lastY, ry);
        s += g;
        ry += dm.h;
      }
      s += `<line x1="${Lx}" y1="${railTop}" x2="${Lx}" y2="${lastY}" stroke="${P.line}" stroke-width="1.6"/>`
        + `<line x1="${Nx}" y1="${railTop}" x2="${Nx}" y2="${lastY}" stroke="${P.line}" stroke-width="1.6"/>`;
    }

    // The control device schedule.
    const T = C.table;
    if (T) {
      const cols = [['tag', 'Tag', 0.08], ['device', 'Device', 0.25], ['setting', 'Setting', 0.19], ['contact', 'Contact', 0.15],
        ['mount', 'Mounting', 0.15], ['modules', 'Mod.', 0.06], ['ctrs', 'Switches', 0.12]];
      const tx0 = x0, tw = T.w, rh = 15;
      s += `<text x="${tx0}" y="${T.y - 8}" font-size="11" font-weight="700" fill="${P.ink}">Control devices</text>`
        + `<rect x="${tx0}" y="${T.y}" width="${tw}" height="${18 + T.rows.length * rh}" fill="none" stroke="${P.border}"/>`
        + `<rect x="${tx0}" y="${T.y}" width="${tw}" height="18" fill="${P.panel}" stroke="${P.border}"/>`;
      let cx = tx0;
      for (const [, h, f] of cols) {
        s += `<text x="${cx + 5}" y="${T.y + 12.5}" font-size="8.5" font-weight="700" fill="${P.inkSec}">${esc(h)}</text>`;
        cx += f * tw;
      }
      T.rows.forEach((r, i) => {
        const y = T.y + 18 + i * rh;
        if (i) s += `<line x1="${tx0}" y1="${y}" x2="${tx0 + tw}" y2="${y}" stroke="${P.border}"/>`;
        let x = tx0;
        for (const [key, , f] of cols) {
          const v = key === 'ctrs' ? r.ctrs.join(', ') : key === 'modules' ? (r.modules ? String(r.modules) : '—') : (r[key] || '—');
          s += `<text x="${x + 5}" y="${y + 10.5}" font-size="8.5" font-weight="${key === 'tag' ? 700 : 400}" fill="${P.ink}">${esc(this._trunc(v, Math.max(4, Math.floor((f * tw - 8) / 4.6))))}</text>`;
          x += f * tw;
        }
      });
    }
    return s;
  },

  _layout(comp, D) {
    this._dropX0 = this.DROP_X0 + (D.table ? this.TABLE_HDR : 0);
    const items = this._items(comp, D);
    const allSupply = D.accessories
      ? DBAccessories.list(comp).filter(a => a.tap === 'supply')
      : [];
    const boardInc = DBAccessories.incomer(comp);
    const sectioned = DBSections.has(comp);

    // One band per section (a single, section-less band for a legacy board).
    const defs = sectioned
      ? DBSections.list(comp).map(sec => ({
        sec,
        items: items.filter(it => it.sec === sec.id),
        supply: allSupply.filter(a => DBSections.of(comp, a) === sec),
        inc: this._sectionIncomer(comp, sec),
      }))
      : [{ sec: null, items, supply: allSupply, inc: boardInc }];

    const tRows = D.table ? this._tableRows(D) : [];
    const maxLines = D.table ? 0 : items.reduce((n, it) => Math.max(n, it.lines.length), 1);
    // Contactor poles sit under the way's breaker (the drop gets longer); a
    // switched section's contactor and sub-bus sit under the busbar (the
    // breakers — and the earth-leakage brackets — drop lower).
    const ctrDY = items.some(it => it.ctr && it.ctr.arrangement !== 'section') ? this.CTR_DY : 0;
    const secDY = items.some(it => (it.ctr && it.ctr.arrangement === 'section') || it.msub) ? this.SEC_CTR_DY : 0;
    const btd = (items.some(it => it.kind === 'acc') ? 92 : this.BUS_TO_DEV) + secDY;
    const rowInner = btd + this.LABEL_DY + ctrDY + maxLines * this.LINE_H
      + (D.bars ? this.BAR_GAP + this.BAR_PITCH + 8 : 8) + (D.load ? this.LOAD_H : 0)
      + (tRows.length ? tRows.length * this.TBL_ROW + 14 : 0);
    const rowH = rowInner + this.ROW_GAP;

    // A busbar that wraps onto further rows gets a lane at the left for the
    // continuation riser: busbars, N/PE bars and columns start after it, so
    // the riser never crosses a bar or the accessory bay.
    for (const d of defs) d.chunks = this._rowChunks(d.items, D);
    const gutter = defs.some(d => d.chunks.length > 1) ? this.RISER_GUTTER : 0;
    this._dropX0 += gutter;
    const e0 = this._dropX0 - this.DROP_W / 2;
    const bands = [];
    const rowDefs = [];
    let y = this.PAD + this.HEAD_H;
    let widest = 0;
    for (const d of defs) {
      const y0 = y;
      const strip = d.sec ? this.STRIP_H : 0;
      const incTop = y0 + strip + 14;
      const devY = incTop + this.SRC_TO_DEV + this._supplyBlockH(comp, d.supply);
      const isoY = d.inc.isolator ? devY + 44 : null;
      const busY = (isoY || devY) + this.DEV_TO_BUS;
      const chunks = d.chunks;
      const band = { sec: d.sec, inc: d.inc, supply: d.supply, y0, incTop, devY, isoY, busY, rows: [] };
      chunks.forEach((r, ci) => {
        // Column centres: ways keep the DROP_W pitch, accessories are narrower.
        let cur = e0; const xs = [];
        for (const it of r) { xs.push(cur + it.w / 2); cur += it.w; }
        widest = Math.max(widest, cur);
        const rd = { items: r, xs, rowW: cur, busY: busY + ci * rowH, band, phase: r.phase || null,
          prevBusY: ci > 0 ? busY + (ci - 1) * rowH : null };
        band.rows.push(rd); rowDefs.push(rd);
      });
      band.y1 = busY + chunks.length * rowH - this.ROW_GAP / 2 + (d.sec ? 6 : 0);
      bands.push(band);
      y = band.y1 + (d.sec ? this.BAND_GAP : 0);
    }
    const busW = Math.max(widest + this.DROP_W / 2, 460);
    const tapW = Math.max(0, ...defs.map(d => d.supply.length ? this.INCOMER_X + this.TAP_X0 + d.supply.length * this.ACC_W : 0));
    let w = this.PAD * 2 + Math.max(busW + 20, tapW + 20, 620);
    const last = bands[bands.length - 1];
    let h = (sectioned ? last.y1 : last.busY + last.rows.length * rowH) + this.PAD;
    if (D.controls && typeof DBControls !== 'undefined' && DBControls.has(comp)) w = Math.max(w, this.PAD * 2 + this.CTL_BW);
    const ctl = D.controls ? this._ctlLayout(comp, w, h) : null;
    if (ctl) h = ctl.y1 + this.PAD;

    return { bands, rowDefs, sectioned, btd, ctrDY, secDY, ctl, tRows, items, inc: boardInc, maxLines, rowInner, rowH, busW, w, h, gutter };
  },

  // The busbar rows of one band: WAYS_PER_ROW columns a row; with phase rows
  // the ways are grouped R, W, B, three-phase (schedule order inside each)
  // and every group starts a row of its own — accessories lead the first.
  // Each row array carries `.phase` (null without phase rows).
  _rowChunks(items, D) {
    const out = [];
    const push = (list, phase) => {
      for (let i = 0; i < list.length; i += this.WAYS_PER_ROW) {
        const r = list.slice(i, i + this.WAYS_PER_ROW);
        r.phase = phase;
        out.push(r);
      }
    };
    if (!D.phaserows) push(items, null);
    else {
      const acc = items.filter(it => it.kind === 'acc');
      const ways = items.filter(it => it.kind !== 'acc');
      const groups = ['R', 'W', 'B', 'RWB'].map(ph => ways.filter(it => (it.phase || 'R') === ph));
      groups.forEach((g, gi) => {
        const lead = gi === groups.findIndex(x => x.length) ? acc : [];
        if (g.length) push(lead.concat(g), ['R', 'W', 'B', 'RWB'][gi]);
      });
      if (!ways.length && acc.length) push(acc, null);
    }
    if (!out.length) { const r = []; r.phase = null; out.push(r); }
    return out;
  },

  // Extra riser height the supply-side tap block takes (0 without taps): tap
  // conductor, protective device, symbol, its labels and termination, plus
  // room for any ammeter CTs on the riser beside it.
  _supplyBlockH(comp, supply) {
    if (!supply.length) return 0;
    const lines = Math.max(...supply.map(a => this._accItem(a, comp).lines.length));
    const bottom = this.TAP_DY + this.TAP_SYM_DY + this.TAP_LBL_DY + lines * this.LINE_H + 16;
    const cts = supply.filter(a => a.kind === 'metering' && a.meter !== 'voltmeter').length;
    const ctBottom = this.TAP_DY + 30 + cts * this.CT_PITCH;
    return Math.max(bottom, ctBottom) + 36 - this.SRC_TO_DEV;
  },

  // An incomer description for a section, shaped like Components.boardIncomer().
  _sectionIncomer(comp, sec) {
    const kindLabel = { normal: 'Mains', essential: 'Generator', ups: 'UPS', other: 'Supply' }[sec.kind] || 'Supply';
    const own = (sec.source_label || kindLabel) + (Number(sec.source_kva) > 0 ? ` ${sec.source_kva} kVA` : '');
    const from = DBSections.get(comp, sec.feed_from);
    const src = sec.feed === 'board' ? 'Board incomer'
      : sec.feed === 'section' ? `From ${from ? from.name : 'another section'}`
        : sec.feed === 'changeover' ? `${own} ⇄ ${from ? from.name : '?'}`
          : own;
    const a = Number(sec.incomer_a) || null;
    const bits = [];
    if (Number(sec.feed_mm2) > 0) {
      bits.push(`${sec.feed_mm2} mm²${sec.feed_conductor === 'Al' ? ' Al' : ''}${Number(sec.feed_pe_mm2) > 0 ? ` + ${sec.feed_pe_mm2} PE` : ''}${Number(sec.feed_m) > 0 ? ' · ' + sec.feed_m + ' m' : ''}`);
    }
    if (sec.feed === 'changeover') bits.push('changeover');
    return {
      basis: 'section', device: { type: 'cb' }, rating_a: a,
      device_label: a ? `${a} A ${sec.incomer_poles || '4P'}${Number(sec.incomer_ka) > 0 ? ' · ' + sec.incomer_ka + ' kA' : ''}` : null,
      isolator: null, cable: null, source: { id: sec.id, name: src, type: sec.kind }, way: null,
      note: bits.join(' · ') || 'section incomer',
    };
  },

  // ── Palette ─────────────────────────────────────────────────────────
  _palette(dark) {
    return dark ? {
      surface: '#1e1e2e', panel: '#252536', ink: '#e0e0e8', inkSec: '#a0a0b0',
      muted: '#7c7c96', line: '#8a8aa4', bus: '#c9c9e0', border: '#3a3a50',
      accent: '#4a9eff', head: '#2f2f44', ctl: '#ffa94d', mtr: '#4fd1c5',
      pass: '#69db7c', warn: '#ffc078', fail: '#ff6b6b',
      phase: { R: '#f87171', W: '#cbd5e1', B: '#60a5fa', RWB: '#c084fc' },
    } : {
      surface: '#ffffff', panel: '#f5f8ff', ink: '#1a1a2e', inkSec: '#555555',
      muted: '#7a7a88', line: '#44444f', bus: '#1a1a2e', border: '#c9ced6',
      accent: '#0078d7', head: '#eef1f5', ctl: '#b85c00', mtr: '#0b6e69',
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
    return `<rect x="${x - s}" y="${y - s}" width="${s * 2}" height="${s * 2}" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x - s}" y1="${y - s}" x2="${x + s}" y2="${y + s}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x + s}" y1="${y - s}" x2="${x - s}" y2="${y + s}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`;
  },

  _gFuse(x, y, P, stroke) {
    const w = 6, h = 10;
    return `<rect x="${x - w}" y="${y - h}" width="${w * 2}" height="${h * 2}" rx="2" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x - w}" y1="${y}" x2="${x + w}" y2="${y}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`;
  },

  _gSwitch(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y + 8}" r="2.6" fill="${escHtml(stroke)}"/>`
      + `<circle cx="${x}" cy="${y - 8}" r="2.6" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x}" y1="${y + 8}" x2="${x + 9}" y2="${y - 9}" stroke="${escHtml(stroke)}" stroke-width="1.6"/>`;
  },

  _gSpd(x, y, P, stroke) {
    const w = 7, h = 10;
    return `<rect x="${x - w}" y="${y - h}" width="${w * 2}" height="${h * 2}" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<polyline points="${x - 4},${y - 5} ${x + 4},${y} ${x - 4},${y + 5}" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`;
  },

  _gLamp(x, y, P, stroke) {
    const r = 8, k = r * Math.SQRT1_2;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x - k}" y1="${y - k}" x2="${x + k}" y2="${y + k}" stroke="${escHtml(stroke)}" stroke-width="1.3"/>`
      + `<line x1="${x + k}" y1="${y - k}" x2="${x - k}" y2="${y + k}" stroke="${escHtml(stroke)}" stroke-width="1.3"/>`;
  },

  _gMeter(x, y, P, stroke, letter) {
    return `<circle cx="${x}" cy="${y}" r="9" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="${String(letter).length > 1 ? 8 : 10}" font-weight="700" fill="${escHtml(stroke)}">${letter}</text>`;
  },

  _gSocket(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y}" r="8" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x - 3}" y1="${y - 4}" x2="${x - 3}" y2="${y + 4}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x + 3}" y1="${y - 4}" x2="${x + 3}" y2="${y + 4}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`;
  },

  _gLight(x, y, P, stroke) {
    const k = 8 * Math.SQRT1_2;
    let r = '';
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      r += `<line x1="${x + dx * k}" y1="${y + dy * k}" x2="${x + dx * (k + 4)}" y2="${y + dy * (k + 4)}" stroke="${escHtml(stroke)}" stroke-width="1.2"/>`;
    }
    return this._gLamp(x, y, P, stroke) + r;
  },

  _gHour(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y}" r="9" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${escHtml(stroke)}">h</text>`;
  },

  _gCtlTx(x, y, P, stroke) {
    return `<circle cx="${x}" cy="${y - 5}" r="7" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<circle cx="${x}" cy="${y + 5}" r="7" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`;
  },

  // Contactor main pole (IEC 60617 07-13-02): an open make contact with the
  // semicircle on its fixed contact.
  _gContactor(x, y, P, stroke) {
    return `<path d="M ${x - 4.5} ${y - 11} A 4.5 4.5 0 0 0 ${x + 4.5} ${y - 11}" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<line x1="${x}" y1="${y + 12}" x2="${x - 9}" y2="${y - 8}" stroke="${escHtml(stroke)}" stroke-width="1.6"/>`;
  },

  // Protective device type for an accessory (SLD symbol key), or null.
  _protType(prot) {
    if (!prot) return null;
    return prot.type === 'mcb' ? 'cb' : 'fuse';
  },

  _gUtility(x, y, P, stroke) {
    return `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="3" fill="${P.surface}" stroke="${escHtml(stroke)}" stroke-width="1.4"/>`
      + `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${escHtml(stroke)}" stroke-width="1.3"/>`;
  },

  // The main single line's own symbol, drawn by Symbols (so it follows the
  // project's IEC / classic symbol set) with literal colours: class names are
  // stripped and the stroke set on a wrapper, because an exported SVG carries
  // no stylesheet. `stroke` overrides the symbol's native SLD colour.
  _sym(type, x, y, P, stroke, comp, scale, rot, dxf) {
    const def = (typeof COMPONENT_DEFS !== 'undefined') ? COMPONENT_DEFS[type] : null;
    const fn = (typeof Symbols !== 'undefined' && def) ? Symbols._symbolFor(type) : null;
    if (!fn) return '';
    // Circuit breakers on a board's single line are drawn open (blade lifted).
    let m = fn(def.width, def.height, comp || { type, props: type === 'cb' ? { state: 'open' } : {} });
    m = m.replace(/class="iec-solid"/g, `fill="${stroke}"`)
      .replace(/\sclass="[^"]*"/g, '')
      .replace(/var\(--[a-z-]+,\s*[^)]+\)/g, P.surface)
      .replace(/fill="white"/g, `fill="${P.surface}"`)
      .replace(/currentColor/g, stroke)
      .replace(/<text((?:(?!fill=)[^>])*)>/g, `<text stroke="none" fill="${escHtml(stroke)}"$1>`);
    return `<g transform="translate(${x},${y})${scale && scale !== 1 ? ` scale(${scale})` : ''}${rot ? ` rotate(${rot})` : ''}" stroke="${escHtml(stroke)}" stroke-width="1.5" fill="none"`
      + ` data-dxf-block="${type}"${dxf ? ` data-dxf-attrs="${this._dxfData(dxf)}"` : ''}>${m}</g>`;
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
      if (c - hh > cur) out += `<line x1="${x}" y1="${cur}" x2="${x}" y2="${c - hh}" stroke="${escHtml(stroke)}" stroke-width="${w}"/>`;
      cur = Math.max(cur, c + hh);
    }
    if (y2 > cur) out += `<line x1="${x}" y1="${cur}" x2="${x}" y2="${y2}" stroke="${escHtml(stroke)}" stroke-width="${w}"/>`;
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
    const tot = L.sectioned ? DBSections.totals(comp) : null;
    for (const b of L.bands) {
      if (b.sec) svg += this._sectionFrame(b, L, P, x0, tot.get(b.sec.id));
      svg += this._incomer(comp, b, P, x0);
    }
    L.rowDefs.forEach((rd) => {
      svg += this._busRow(rd, L, P, D, x0, comp);
    });
    if (L.ctl) svg += this._ctlSvg(comp, L, P, x0);

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
    const tapY = L.incTop + this.TAP_DY;
    // Ammeter CTs sit on the riser just below the tap point, one per meter.
    const meters = L.supply.filter(a => a.kind === 'metering' && a.meter !== 'voltmeter');
    const ctY = (j) => tapY + 30 + j * this.CT_PITCH;
    meters.forEach((_, j) => incGaps.push([ctY(j), 12]));
    let s = this._vline(x, L.incTop, L.busY, incGaps, P.line, 1.8);
    s += `<circle cx="${x}" cy="${L.incTop}" r="3.4" fill="${P.line}"/>`;
    s += `<text x="${x + 10}" y="${L.incTop + 4}" font-size="10" fill="${P.inkSec}">${this._esc(inc.source ? inc.source.name : 'supply')}</text>`;

    meters.forEach((acc, j) => {
      s += `<g><title>${this._esc(`${acc.label || 'Meter'} — current transformer ${acc.ct_ratio || ''}`)}</title>`
        + `<g data-dxf-block="ct" data-dxf-at="${x},${ctY(j)}" data-dxf-attrs="${this._dxfData({ BOARD: comp.props.name || comp.id, DESCRIPTION: `${acc.label || 'Meter'} CT`, RATIO: acc.ct_ratio || '' })}">`
        + this._sym('ct', x, ctY(j), P, this._native('ct', P), null, 0.6)
        + `<text x="${x - 10}" y="${numAttr(ctY(j) + 4)}" text-anchor="end" font-size="8" fill="${P.muted}" data-dxf-attr="RATIO_LABEL">${this._esc(acc.ct_ratio || 'CT')}</text></g></g>`;
    });

    // Supply-side taps — stay live with the board switched off. A tap
    // conductor leaves the riser above the incomer; each accessory drops from
    // it exactly like a busbar-accessory column: protective device, symbol,
    // labels, then its termination (an SPD's own earth, else N).
    if (L.supply.length) {
      const cx = (i) => x + this.TAP_X0 + i * this.ACC_W;
      const last = cx(L.supply.length - 1);
      s += `<line x1="${x}" y1="${tapY}" x2="${last}" y2="${tapY}" stroke="${P.line}" stroke-width="1.6"/>`
        + `<circle cx="${x}" cy="${tapY}" r="2.6" fill="${P.line}"/>`
        + `<text x="${x + 8}" y="${tapY - 5}" font-size="8.5" fill="${P.muted}">supply-side taps</text>`;
      L.supply.forEach((acc, i) => {
        const X = cx(i);
        const item = this._accItem(acc, comp);
        const stroke = item.status === 'warn' ? P.warn : P.line;
        const pt = this._protType(item.prot);
        const protY = tapY + this.TAP_PROT_DY, gY = tapY + this.TAP_SYM_DY;
        const lblTop = gY + this.TAP_LBL_DY;
        const lblH = item.lines.length * this.LINE_H + 2;
        const isSpd = item.glyph === 'spd';
        const endY = lblTop - 10 + lblH + 8;
        const gaps = [[gY, (isSpd ? 25 : 14) * this.SYM_SCALE], [lblTop - 10 + lblH / 2, lblH / 2 + 1]];
        if (pt) gaps.push([protY, 20 * 0.7]);
        let g = `<g><title>${this._esc('Supply-side tap — stays live with the board switched off\n' + item.tip)}</title>`;
        if (i) g += `<circle cx="${X}" cy="${tapY}" r="2.2" fill="${P.line}"/>`;
        g += this._vline(X, tapY, isSpd ? gY : endY, gaps, stroke, 1.4);
        if (pt) g += this._sym(pt, X, protY, P, this._native(pt, P), null, 0.7, 0,
          { DESCRIPTION: `${item.dxf.DESCRIPTION} protection`, RATING_A: item.prot.a, PROTECTION: item.prot.type });
        let sym = this._glyph(item.glyph, X, gY, P, stroke, item);
        item.lines.forEach((ln, li) => {
          sym += `<text x="${X}" y="${lblTop + li * this.LINE_H}" text-anchor="middle" font-size="${ln.bold ? 9.5 : 9}"
            font-weight="${ln.bold ? 700 : 400}" fill="${ln.dim ? P.muted : P.ink}" data-dxf-attr="${ln.tag || 'LABEL_' + (li + 1)}">${this._esc(ln.text)}</text>`;
        });
        g += `<g data-dxf-block="DB_${escHtml(item.glyph)}" data-dxf-at="${X},${gY}" data-dxf-attrs="${this._dxfData(item.dxf)}">${sym}</g>`;
        if (!isSpd) {
          g += `<circle cx="${X}" cy="${endY}" r="2.4" fill="${P.line}"/>`
            + `<text x="${X + 6}" y="${endY + 4}" font-size="8.5" fill="${P.muted}">N</text>`;
        }
        s += g + `</g>`;
      });
    }

    // Incomer device
    const label = inc.device_label || (inc.rating_a ? `${inc.rating_a} A` : 'incomer — rating unknown');
    const glyph = inc.device && inc.device.type === 'fuse' ? 'fuse' : 'mcb';
    const known = inc.rating_a != null;
    const incData = { BOARD: comp.props.name || comp.id, SECTION: L.sec ? L.sec.name : '', DESCRIPTION: 'Incomer',
      RATING_A: inc.rating_a != null ? inc.rating_a : '', DEVICE: label, SOURCE: inc.source ? inc.source.name : '',
      BASIS: inc.basis || '' };
    s += `<g><title>${this._esc(`Incomer: ${label}${inc.basis === 'feeder_way' ? ' (from the feeding board\'s way)' : inc.basis === 'sld' ? ' (from the SLD)' : ''}`)}</title>`
      + `<g data-dxf-block="DB_INCOMER" data-dxf-at="${x},${L.devY}" data-dxf-attrs="${this._dxfData(incData)}">`
      + this._glyph(glyph, x, L.devY, P, known ? P.line : P.warn)
      + `<text x="${x + 16}" y="${L.devY + 1}" font-size="10.5" font-weight="700" fill="${known ? P.ink : P.warn}" data-dxf-attr="DEVICE_LABEL">${this._esc(label)}</text>`
      + `<text x="${x + 16}" y="${L.devY + 12}" font-size="8.5" fill="${P.muted}" data-dxf-attr="NOTE_LABEL">${this._esc(inc.note || (inc.basis === 'sld' ? 'from the SLD' : inc.basis === 'feeder_way' ? 'from the feeding board' : 'not modelled'))}</text>`
      + `</g></g>`;

    s += this._incomerMeter(comp, L, P, x);

    if (L.isoY) {
      const isoName = inc.isolator.props.name || 'Main switch';
      s += `<g><title>Board main isolator</title>`
        + `<g data-dxf-block="DB_ISOLATOR" data-dxf-at="${x},${L.isoY}" data-dxf-attrs="${this._dxfData({ BOARD: comp.props.name || comp.id, DESCRIPTION: isoName, RATING_A: inc.isolator.props.rated_current_a || '' })}">`
        + this._gSwitch(x, L.isoY, P, P.line)
        + `<text x="${x + 16}" y="${L.isoY + 4}" font-size="10" fill="${P.inkSec}" data-dxf-attr="NAME_LABEL">${this._esc(isoName)}</text>`
        + `</g></g>`;
    }
    return s;
  },

  // Compartment outline + title strip for one section.
  _sectionFrame(b, L, P, x0, t) {
    const c = DBSections.color(b.sec);
    const w = L.w - this.PAD * 2 + 0;
    const kind = DBSections.kind(b.sec.kind).label;
    const bits = [];
    if (t) {
      bits.push(`${t.ways} ways`, `${(t.connectedVa / 1000).toFixed(1)} kVA`, `${t.demandA.toFixed(0)} A demand`);
    }
    return `<g><title>${this._esc(`${b.sec.name} — ${kind}`)}</title>`
      + `<rect x="${x0 - 8}" y="${escHtml(b.y0)}" width="${w + 16}" height="${b.y1 - b.y0}" rx="7" fill="${c}" fill-opacity="0.05" stroke="${c}" stroke-width="1.3" stroke-dasharray="7,4"/>`
      + `<rect x="${x0 - 8}" y="${escHtml(b.y0)}" width="${w + 16}" height="${this.STRIP_H - 4}" rx="7" fill="${c}" fill-opacity="0.9"/>`
      + `<text x="${x0}" y="${numAttr(b.y0 + 13)}" font-size="11" font-weight="700" fill="#fff">${this._esc(b.sec.name.toUpperCase())}</text>`
      + `<text x="${x0 + 12 + b.sec.name.length * 8}" y="${numAttr(b.y0 + 13)}" font-size="9.5" fill="#fff" fill-opacity="0.9">${this._esc(kind + (bits.length ? ' · ' + bits.join(' · ') : ''))}</text>`
      + `</g>`;
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

  _busRow(rd, L, P, D, x0, comp) {
    const row = rd.items;
    const busY = rd.busY;
    const xs = rd.xs.map(v => x0 + v);
    const busEndX = x0 + Math.max(rd.rowW + 30, 260);
    const xb = x0 + (L.gutter || 0);      // busbar / N / PE start, right of the riser lane
    let s = `<line x1="${xb}" y1="${busY}" x2="${busEndX}" y2="${busY}" stroke="${P.bus}" stroke-width="3.4" stroke-linecap="round"/>`;

    // Riser joining this busbar section to the previous one, in its own lane:
    // out of the previous busbar's left end, down, into this one.
    if (rd.prevBusY != null) {
      const prevY = rd.prevBusY, rx = x0 + 4;
      s += `<path d="M ${xb} ${prevY} H ${rx} V ${busY} H ${xb}" fill="none" stroke="${P.bus}" stroke-width="1.6" stroke-dasharray="4,3"/>`;
      s += `<text x="${xb + 6}" y="${busY - 6}" font-size="8.5" fill="${P.muted}">busbar continued</text>`;
    }
    if (rd.phase) {
      // Phase rows: the row's phase at the right-hand end of its busbar.
      const name = { R: 'Red phase (R)', W: 'White / yellow phase (W)', B: 'Blue phase (B)', RWB: 'Three-phase (RWB)' }[rd.phase];
      const pc = P.phase[rd.phase] || P.muted;
      const tw = name.length * 5.3;
      s += `<rect x="${busEndX - tw - 14}" y="${busY - 15}" width="9" height="9" rx="2" fill="${pc}"/>`
        + `<text x="${busEndX}" y="${busY - 7}" text-anchor="end" font-size="9" font-weight="600" fill="${P.inkSec}">${this._esc(name)}</text>`;
    }

    if (D.elgroups) {
      for (const br of this._elBrackets(row)) {
        const idn = ((comp.props.el_ratings || {})[br.group]) || 30;
        const txtW = `EL ${br.group} · ${idn} mA`.length * 5.8 + 16;
        const mid = (xs[br.from] + xs[br.to]) / 2;
        const half = Math.max((xs[br.to] - xs[br.from]) / 2 + 26, txtW / 2);
        const ax = mid - half, bx = mid + half;
        const y = busY + this.BUS_TO_RCD + (L.secDY || 0);
        s += `<g><title>${this._esc(`Earth-leakage group ${br.group} — IΔn ${idn} mA, shared by ${br.to - br.from + 1} way(s)`)}</title>`
          + `<rect x="${ax}" y="${y}" width="${bx - ax}" height="${this.RCD_H}" rx="4" fill="${P.panel}" stroke="${P.accent}" stroke-width="1.2"/>`
          + `<text x="${(ax + bx) / 2}" y="${y + 14}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${P.accent}">${this._esc(`EL ${br.group} · ${idn} mA`)}</text>`
          + `</g>`;
      }
    }

    const devY = busY + L.btd;
    const secName = rd.band.sec ? rd.band.sec.name : '';
    const labelTop = devY + this.LABEL_DY + (L.ctrDY || 0);
    const ctrY = devY + this.CTR_OFF;
    s += this._ctrBrackets(row, xs, busY, ctrY, P, comp, false);
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
      let sym = '';   // the device symbol + its labels: one DXF block with attributes
      // The conductor stops either side of the label block (a DXF has no
      // page-coloured patch to hide it behind the text).
      const lblH = it.lines.length * this.LINE_H + 2;
      const lblGap = D.table ? [] : [[labelTop - 10 + lblH / 2, lblH / 2 + 1]];
      if (it.kind === 'acc') {
        // Protective device, then the accessory, then its termination: PE for
        // an SPD, N for everything else — the conductor stops there.
        const protY = busY + this.PROT_DY;
        const endY = it.glyph === 'spd' ? peY : barsY;
        const gaps = [[devY, (it.glyph === 'spd' ? 25 : 14) * this.SYM_SCALE], ...lblGap];
        const pt = this._protType(it.prot);
        if (pt) gaps.push([protY, 20 * 0.7]);
        g += this._vline(x, busY, D.bars ? endY : devY + 26, gaps, stroke, 1.4);
        if (pt) g += this._sym(pt, x, protY, P, this._native(pt, P), null, 0.7, 0,
          { DESCRIPTION: `${it.dxf.DESCRIPTION} protection`, RATING_A: it.prot.a, PROTECTION: it.prot.type });
        if (D.bars) g += `<circle cx="${x}" cy="${endY}" r="2.4" fill="${P.line}"/>`;
        sym = this._glyph(it.glyph, x, devY, P, stroke, it);
      } else {
        const endY = it.spare ? devY + 30 + (L.ctrDY || 0) : (D.bars ? peY : devY + 26) + (D.load ? 14 : 0);
        const pole = it.ctr && it.ctr.arrangement !== 'section';
        const top = (it.ctr && it.ctr.arrangement === 'section') || it.msub ? busY + this.SEC_BUS_Y : busY;
        const mY = devY + 27;
        const mCt = it.mtr && DBMeters.conn(it.mtr.conn).ct;
        g += this._vline(x, top, endY, [[devY, 20 * this.SYM_SCALE], ...(pole ? [[ctrY, 12]] : []), ...(mCt ? [[mY, 5]] : []), ...lblGap], stroke, 1.4);
        sym = this._glyph(it.glyph, x, devY, P, stroke, it);
        if (pole) g += this._gContactor(x, ctrY, P, P.ctl);
        if (it.mtr) g += this._gWayMeter(comp, it.mtr, it.mtrLabel, x, mY, P, mCt);
        if (D.load && !it.spare) {
          const motor = (it.poles === '3P' || it.phase === 'RWB')
            && /pump|motor|fan|compress|aircon|a\/c|hvac|drive/i.test(it.wayDesc || '');
          const lt = it.feeds ? 'distribution_board' : motor ? 'motor_induction' : 'static_load';
          const d = it.dxf;
          const sc = it.feeds ? 0.75 : 1;
          const lh = COMPONENT_DEFS[lt].height * sc;
          g += this._sym(lt, x, endY + lh / 2, P, P.line, null, sc, 0,
            { BOARD: d.BOARD, WAY: d.WAY, DESCRIPTION: d.DESCRIPTION, LOAD_VA: d.LOAD_VA, CURRENT_A: d.CURRENT_A, PHASE: d.PHASE,
              ...(it.feeds ? { FEEDS: it.feeds } : {}) });
          if (it.feeds) {
            g += `<text x="${x}" y="${endY + lh + 10}" text-anchor="middle" font-size="9" font-weight="700" fill="${P.ink}">${this._esc(this._trunc(it.feeds, 18))}</text>`;
          }
        }
      }
      if (D.phase && !D.table) {
        // Phase chip sits left of the drop so the conductor never crosses it.
        const pc = P.phase[it.phase] || P.muted;
        const tw = String(it.phase).length * 5.6;
        g += `<rect x="${x - 10 - tw - 11}" y="${devY + this.TICK_DY - 5}" width="9" height="9" rx="2" fill="${pc}"/>`;
        sym += `<text x="${x - 8}" y="${numAttr(devY + this.TICK_DY + 3)}" text-anchor="end" font-size="9" fill="${P.inkSec}" data-dxf-attr="PHASE">${this._esc(it.phase)}</text>`;
      }
      if (!D.table) {
        // Labels sit on a page-coloured patch, so the conductor reads as passing
        // behind them rather than being struck through the text.
        const lw = it.w - 12, lh = it.lines.length * this.LINE_H + 2;
        g += `<rect x="${x - lw / 2}" y="${labelTop - 10}" width="${lw}" height="${lh}" fill="${P.surface}"/>`;
        it.lines.forEach((ln, li) => {
          sym += `<text x="${x}" y="${labelTop + li * this.LINE_H}" text-anchor="middle" font-size="${ln.bold ? 9.5 : 9}"
          font-weight="${ln.bold ? 700 : 400}" fill="${ln.dim ? P.muted : P.ink}" data-dxf-attr="${ln.tag || 'LABEL_' + (li + 1)}">${this._esc(ln.text)}</text>`;
        });
      }
      g += `<g data-dxf-block="${it.kind === 'acc' ? 'DB_' + it.glyph : 'DB_WAY'}" data-dxf-at="${x},${devY}" data-dxf-attrs="${this._dxfData(it.dxf || {})}">${sym}</g>`;
      g += `</g>`;
      s += g;
    });

    s += this._ctrBrackets(row, xs, busY, ctrY, P, comp, true);
    s += this._mtrSubbus(row, xs, busY, P, comp);
    s += this._mtrSumBrackets(row, xs, devY, P);

    if (L.tRows.length) {
      const top = peY + 14 + (D.load ? 56 : 0);
      const h = L.tRows.length * this.TBL_ROW;
      const left = xb, right = xs.length ? xs[xs.length - 1] + row[row.length - 1].w / 2 : busEndX;
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
      s += `<line x1="${xb}" y1="${barsY}" x2="${busEndX}" y2="${barsY}" stroke="${P.line}" stroke-width="1.6"/>`
        + `<text x="${busEndX}" y="${barsY - 4}" text-anchor="end" font-size="9" fill="${P.muted}">N${secName ? ' · ' + this._esc(secName) : ''}</text>`
        + `<line x1="${xb}" y1="${peY}" x2="${busEndX}" y2="${peY}" stroke="${P.line}" stroke-width="1.6" stroke-dasharray="6,3"/>`
        + `<text x="${busEndX}" y="${peY + 10}" text-anchor="end" font-size="9" fill="${P.muted}">PE${secName ? ' · ' + this._esc(secName) : ''}</text>`;
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

  // DXF (server-built, mm, 1 px = 0.25 mm) from the same SVG the screen and
  // PNG use: breakers, loads, accessories and the incomer are blocks whose
  // labels are visible attributes and whose way data are hidden attributes.
  dxfPayload(board) {
    const svg = board ? this.buildSVG({ dark: false, board }) : '';
    if (!svg) return null;
    return DxfExport.fromSvg(svg, {
      scale: 0.25, geomLayer: 'SINGLE_LINE', fileName: `${this._fileBase(board)}_single_line`,
      title: String(board.props.name || board.id),
      layers: { SINGLE_LINE: null, SYMBOLS: '#d32f2f', TEXT: null },
    });
  },

  exportDXF() {
    const board = this.board();
    const payload = this.dxfPayload(board);
    if (!payload) { UI.alert('Nothing to export — select a board first.'); return; }
    return DxfExport.download(payload);
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
