/**
 * DbCoord — library breakers on a board's circuit schedule and the mini TCC that
 * checks a way against the devices above it.
 *
 * A way carries an optional `device` ('cb:<library id>'); the board carries an
 * optional `incoming_device` and `ik_max_ka`. The chain for one way is its own
 * breaker, then the board's incoming breaker, then (when the board is fed by a
 * way of another board, `feedsDbId`) that feeder way's breaker, that board's
 * incoming breaker, and so on up. Curves are the same models the TCC and the
 * engines use (cbTripBand: a manufacturer's published tolerance band, else the
 * single generic curve). Fault currents come from the db-circuit-check result:
 * `ik3_max_a` per board (IEC 60909 c_max) and `ief_a` per way (minimum
 * earth-fault current at the far end). Three checks per way:
 *   - discrimination: the upstream's FASTEST trip is slower than the
 *     downstream's SLOWEST trip at every current up to the fault level;
 *   - cable protection: the breaker's slowest clearing time is inside the cable's
 *     k²S² / I² at every current up to the fault level;
 *   - breaking capacity: every rated device's Icu covers the fault level where it
 *     is installed.
 * Read-only: nothing here writes a result; `evaluate` is a pure function of the
 * project and the last circuit check.
 */
const DbCoord = {
  W: 680, H: 430, X0: 60, X1: 660, Y0: 20, Y1: 390,
  T_MIN: 0.01, T_MAX: 1000,
  COLORS: ['#1f5fbf', '#c25a0a', '#00838f', '#7b1fa2', '#5d4037', '#c2185b'],

  // ─── Devices ───
  // "cb:<id>" → { name, props, breakingKa, lib:true }, resolved at call time (the
  // library is edited in place). The props carry the trip unit as picking the
  // breaker on the diagram would (TripUnit.deviceProps).
  deviceById(ref) {
    const [kind, id] = String(ref || '').split(':');
    if (kind !== 'cb') return null;
    const e = STANDARD_CBS.find(c => c.id === id);
    if (!e) return null;
    const props = typeof TripUnit !== 'undefined' ? TripUnit.deviceProps(e) : e;
    return { name: e.name, props, breakingKa: Number(e.breaking_ka) || null, lib: true, entry: e };
  },

  // The way's breaker: the library pick, else the generic MCB its breaker_a +
  // curve describe (the model the circuit check's magnetic multiples mirror).
  wayDevice(way) {
    const lib = way.device ? this.deviceById(way.device) : null;
    if (lib) return lib;
    const r = Number(way.breaker_a) || 0;
    if (r <= 0) return null;
    const curve = String(way.curve || 'C').toUpperCase();
    return {
      name: `${curve} ${r} A (generic)`, lib: false, breakingKa: null,
      props: { cb_type: 'mcb', mcb_curve: curve, trip_rating_a: r, thermal_pickup: 1.0,
        magnetic_pickup: MCB_CURVE_MAGNETIC[curve] || 10, long_time_delay: 10 },
    };
  },

  // The device list is filtered by the way's rating and curve: a library holding
  // every manufacturer's catalogue is over a thousand breakers, and repeating
  // all of them in every row's <select> is what made a large board slow.
  // `filter` = { a, curve }; a blank a / curve doesn't narrow. Curve narrows
  // MCBs only — an MCCB or ACB has no B/C/D curve, so it is kept at its rating.
  FILTER_TIP: 'Only library breakers rated at the Breaker (A) value, with the same Curve, are listed '
    + '(in bulk edit, also of the Manufacturer and Type picked). '
    + 'Curve narrows MCBs only: MCCBs and ACBs at that rating are listed whatever the curve. '
    + 'Change Breaker (A) or Curve to see other devices. Picking a device writes its rating and curve '
    + 'to the way, and the coordination check uses its published trip curve. Generic keeps the plain rating + B/C/D curve.',

  _lvList() {
    return STANDARD_CBS.filter(x => !x.rated_voltage_kv || x.rated_voltage_kv <= 1);
  },

  // Manufacturers in the library right now, for the Manufacturer filter.
  // Entries with no maker (the shipped generic breakers, custom ones) are
  // grouped as "Generic library".
  NO_MAKER: '__none',
  makers() {
    const list = this._lvList();
    const names = [...new Set(list.map(x => String(x.manufacturer || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const out = names.map(n => ({ key: n, label: n }));
    if (list.some(x => !String(x.manufacturer || '').trim())) out.push({ key: this.NO_MAKER, label: 'Generic library' });
    return out;
  },

  matches(x, filter) {
    if (filter && filter.type && x.cb_type !== filter.type) return false;
    if (filter && filter.maker) {
      const m = String(x.manufacturer || '').trim();
      if (filter.maker === this.NO_MAKER ? m !== '' : m !== filter.maker) return false;
    }
    const a = filter ? Number(filter.a) : 0;
    const curve = filter && filter.curve ? String(filter.curve).toUpperCase() : '';
    if (a > 0 && Number(x.trip_rating_a) !== a) return false;
    if (curve && x.cb_type === 'mcb' && String(x.mcb_curve || '').toUpperCase() !== curve) return false;
    return true;
  },

  filtered(filter) { return this._lvList().filter(x => this.matches(x, filter)); },

  // "4 devices rated 20 A · curve C" — the line under a filtered picker.
  filterNote(filter) {
    const a = filter ? Number(filter.a) : 0;
    const curve = filter && filter.curve ? String(filter.curve).toUpperCase() : '';
    const type = filter && filter.type ? String(filter.type).toUpperCase() : '';
    const maker = filter && filter.maker ? (filter.maker === this.NO_MAKER ? 'generic library' : filter.maker) : '';
    if (!(a > 0) && !curve && !type && !maker) return 'All devices. Set Breaker (A) and Curve to narrow the list.';
    const n = this.filtered(filter).length;
    const what = [a > 0 ? `rated ${a} A` : '', curve ? `curve ${curve}` : '', type, maker].filter(Boolean).join(' · ');
    return n ? `${n} device${n === 1 ? '' : 's'} ${what}` : `No library device ${what}.`;
  },

  // opts.lead = options placed first (the bulk panel's "no change");
  // opts.genericValue = the Generic option's value ('' unless that is taken).
  optionsHtml(selected, blank, filter, opts) {
    const o = opts || {};
    const all = this._lvList();
    const list = filter ? all.filter(x => this.matches(x, filter)) : all;
    const cur = selected ? all.find(x => 'cb:' + x.id === selected) : null;
    // The way's own pick stays listed even when it no longer fits the filter.
    const kept = cur && !list.includes(cur)
      ? `<option value="${escHtml(selected)}" selected>${escHtml(cur.name)} (does not match)</option>` : '';
    const gone = selected && !cur
      ? `<option value="${escHtml(selected)}" selected>(removed from library)</option>` : '';
    const group = (label, type) => {
      const xs = list.filter(x => x.cb_type === type);
      return xs.length ? `<optgroup label="${escHtml(label)}">${xs.map(x =>
        `<option value="cb:${escHtml(x.id)}"${selected === 'cb:' + x.id ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('')}</optgroup>` : '';
    };
    return (o.lead || '') + `<option value="${escHtml(o.genericValue || '')}">${escHtml(blank || 'Generic (B/C/D)')}</option>${gone}${kept}`
      + group('MCB', 'mcb') + group('MCCB', 'mccb') + group('ACB', 'acb');
  },

  // Picking a library device sets the plain fields the circuit check reads.
  applyToWay(way, ref) {
    way.device = ref || '';
    const d = this.deviceById(ref);
    if (!d) return;
    way.breaker_a = Number(d.entry.trip_rating_a) || way.breaker_a;
    if (d.entry.cb_type === 'mcb' && d.entry.mcb_curve) way.curve = d.entry.mcb_curve;
  },

  // ─── Chain + checks ───
  _boards() { return [...AppState.components.values()].filter(c => c.type === 'distribution_board'); },

  _boardResult(boardId) {
    const res = AppState.dbCheckResults;
    return res && Array.isArray(res.boards) ? res.boards.find(b => b.id === boardId) : null;
  },
  _ikOf(board) {
    const r = this._boardResult(board.id);
    return r && r.ik3_max_a > 0 ? r.ik3_max_a : null;
  },
  _wayRow(boardId, wayId) {
    const res = AppState.dbCheckResults;
    return res && Array.isArray(res.ways) ? res.ways.find(w => w.board_id === boardId && w.way_id === wayId) : null;
  },

  chain(board, way) {
    const items = [];
    const wd = this.wayDevice(way);
    if (wd) items.push({ role: 'way', label: `Way ${way.way}`, dev: wd, ikA: this._ikOf(board) });
    const boards = this._boards();
    const seen = new Set();
    let cur = board;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const nm = cur.props.name || cur.id;
      const inc = this.deviceById(cur.props.incoming_device);
      if (inc) items.push({ role: 'incoming', label: `${nm} incoming`, dev: inc, ikA: this._ikOf(cur) });
      let parent = null, pw = null;
      for (const b of boards) {
        const w = (b.props.circuits || []).find(x => x.feedsDbId === cur.id);
        if (w && !seen.has(b.id)) { parent = b; pw = w; break; }
      }
      if (!parent) break;
      const fd = this.wayDevice(pw);
      if (fd) items.push({ role: 'feeder', label: `${parent.props.name || parent.id} way ${pw.way}`, dev: fd, ikA: this._ikOf(parent) });
      cur = parent;
    }
    return items;
  },

  _samples(lo, hi, n = 160) {
    const out = [];
    if (!(lo > 0) || !(hi > lo)) return out;
    for (let i = 0; i <= n; i++) out.push(lo * Math.pow(hi / lo, i / n));
    return out;
  },

  // Smallest current in [lo, hi] where `bad(I)` first holds (sampled, then
  // bisected on the last good → first bad bracket), or null.
  _firstBad(lo, hi, bad) {
    let prev = null;
    for (const I of this._samples(lo, hi)) {
      if (bad(I)) {
        if (prev == null) return I;
        let a = prev, b = I;
        for (let k = 0; k < 14; k++) { const m = Math.sqrt(a * b); if (bad(m)) b = m; else a = m; }
        return b;
      }
      prev = I;
    }
    return null;
  },

  _top(dev) {                       // the highest current this device has a step at
    const e = cbElementsA(dev.props);
    return Math.max(e.im, e.isd, e.ii, e.ir * 2);
  },

  // Discrimination of `up` over `down` up to iMax. limitA = the first current
  // where both may trip together (null = selective across the whole range).
  discrimination(down, up, iMax) {
    const lo = cbElementsA(down.dev.props).ir * 1.05;
    const hi = iMax || Math.max(this._top(down.dev), this._top(up.dev)) * 1.5;
    const limitA = this._firstBad(lo, hi, (I) => {
      const tD = cbTripBand(down.dev.props, I).tMax;
      if (!(tD < Infinity)) return false;          // downstream does not operate here
      return !(cbTripBand(up.dev.props, I).tMin > tD);
    });
    return { down, up, limitA, hiA: hi, tolerance: !!(down.dev.props.trip_tol && up.dev.props.trip_tol) };
  },

  cableProtection(dev, k, mm2, iMax) {
    // The adiabatic k²S² = I²t holds for clearing times up to 5 s (IEC 60364-4-43
    // §434.5.2); longer, the cable is protected by Ib ≤ In ≤ Iz, which the circuit
    // check already grades. So start where the cable's own limit reaches 5 s.
    const lo = Math.max(cbElementsA(dev.props).ir * 1.05, k * mm2 / Math.sqrt(5));
    const hi = iMax || this._top(dev) * 1.5;
    const allow = (I) => (k * mm2) * (k * mm2) / (I * I);
    if (!(hi > lo)) return { limitA: null, hiA: hi, tClearHi: cbTripBand(dev.props, hi).tMax, tAllowHi: allow(hi) };
    const limitA = this._firstBad(lo, hi, (I) => {
      const t = cbTripBand(dev.props, I).tMax;
      return t < Infinity && t > allow(I);
    });
    const tHi = cbTripBand(dev.props, hi).tMax;
    return { limitA, hiA: hi, tClearHi: tHi, tAllowHi: allow(hi) };
  },

  // [Cascading] Back-up cover of chain item i by a library breaker above it —
  // IEC 60947-2 Annex A, the manufacturer's tested combination (cascading.js).
  // An upstream item whose fault level is unknown cannot be shown adequate, so
  // it backs nothing up. → {up: item, reinforcedKa} or null.
  cascade(items, i, board) {
    if (typeof Cascading === 'undefined' || !Cascading.enabled()) return null;
    if (!Cascading.appliesAt(board.props.voltage_kv ?? 0.4)) return null;
    const sub = items.slice(i).map(it => ({
      ref: it.dev.lib ? Cascading.refOfEntry(it.dev.entry) : null,
      capacityKa: it.dev.breakingKa || 0,
      dutyKa: it.ikA ? it.ikA / 1000 : Infinity,
    }));
    const hit = Cascading.cover(sub);
    return hit ? { up: items[i + hit.by], reinforcedKa: hit.reinforcedKa } : null;
  },

  _worst(list) {
    for (const s of ['fail', 'warn', 'pass']) if (list.includes(s)) return s;
    return 'info';
  },

  // Everything the chip and the modal need. status: pass | warn | fail | info |
  // none (no circuit check yet).
  evaluate(board, way) {
    const row = this._wayRow(board.id, way.id);
    if (!row) return { status: 'none', note: 'Run the circuit check to get the fault levels.' };
    const items = this.chain(board, way);
    if (!items.length) return { status: 'none', note: 'This way has no breaker rating.', items, row };
    const ikMax = items[0].ikA;
    const ikMin = row.ief_a > 0 ? row.ief_a : null;
    const fmt = (v) => this.fmtA(v);

    // discrimination, pair by pair up the chain
    const pairs = [];
    for (let i = 0; i + 1 < items.length; i++) {
      const p = this.discrimination(items[i], items[i + 1], items[i].ikA);
      let st, msg;
      if (p.limitA == null) {
        st = 'pass';
        msg = `Selective to ${items[i].ikA ? fmt(items[i].ikA) + ' (the fault level)' : 'the top of the curves'}.`;
      } else if (ikMin && p.limitA <= ikMin) {
        st = 'fail';
        msg = `Not selective: both can trip from ${fmt(p.limitA)}, below the ${fmt(ikMin)} minimum earth-fault current.`;
      } else {
        st = 'warn';
        msg = `Selective up to ${fmt(p.limitA)} only` + (items[i].ikA ? `; a fault above that (up to ${fmt(items[i].ikA)}) may trip both.` : '.');
      }
      if (!p.tolerance && p.limitA == null) msg += ' Generic curves carry no tolerance — indicative.';
      pairs.push({ ...p, status: st, message: msg });
    }
    const discr = pairs.length
      ? { status: this._worst(pairs.map(p => p.status)), pairs }
      : { status: 'info', pairs, message: 'No upstream breaker set — pick the board\'s incoming device (or feed it from another board\'s way) to check discrimination.' };

    // cable protection of the way's own cable
    const mm2 = Number(row.cable_mm2) || 0, k = Number(row.cable_k) || 115;
    let cable;
    if (!mm2) cable = { status: 'info', message: 'No cable size on this way.' };
    else {
      const c = this.cableProtection(items[0].dev, k, mm2, ikMax);
      cable = c.limitA == null
        ? { status: ikMax ? 'pass' : 'warn', ...c,
          message: ikMax
            ? `Clears inside the ${mm2} mm² cable's I²t up to ${fmt(ikMax)}: ${this.fmtT(c.tClearHi)} against ${this.fmtT(c.tAllowHi)} allowed at ${fmt(ikMax)}.`
            : `Clears inside the ${mm2} mm² cable's I²t up to ${fmt(c.hiA)}; the board's fault level is unknown, so higher currents are not checked.` }
        : { status: 'fail', ...c,
          message: `From ${fmt(c.limitA)} the breaker takes longer to clear than the ${mm2} mm² cable can carry (k = ${k}, k²S²/I²).` };
    }

    // breaking capacity of every rated device where it is installed
    const rated = items.filter(it => it.dev.breakingKa);
    const bc = items.map((it, i) => {
      if (!it.dev.breakingKa) return { it, status: 'info', message: `${it.label}: ${it.dev.name} — no breaking capacity (generic).` };
      if (!it.ikA) return { it, status: 'warn', message: `${it.label}: Icu ${it.dev.breakingKa} kA — fault level unknown.` };
      if (it.dev.breakingKa * 1000 >= it.ikA) return { it, status: 'pass', message: `${it.label}: Icu ${it.dev.breakingKa} kA ≥ ${fmt(it.ikA)}.` };
      const casc = this.cascade(items, i, board);
      return casc
        ? { it, status: 'pass', cascade: casc,
          message: `${it.label}: Icu ${it.dev.breakingKa} kA is below the ${fmt(it.ikA)} fault level, but cascading with ${casc.up.label} (${casc.up.dev.name}) gives ${casc.reinforcedKa} kA (${Cascading.sourceNote()}). Not selective at these currents; replace only with the same types.` }
        : { it, status: 'fail', message: `${it.label}: Icu ${it.dev.breakingKa} kA is below the ${fmt(it.ikA)} fault level.` };
    });
    const breaking = rated.length
      ? { status: this._worst(bc.map(b => b.status).filter(s => s !== 'info')), items: bc }
      : { status: 'info', items: bc, message: 'No device with a stated breaking capacity — pick a library breaker.' };

    const status = this._worst([discr.status, cable.status, breaking.status]);
    return { status, items, row, ikMax, ikMin, k, mm2, discr, cable, breaking,
      basis: (this._boardResult(board.id) || {}).ik3_basis || null };
  },

  // ─── Formatting ───
  fmtA(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1000) { const k = v / 1000; return (k >= 10 ? k.toFixed(1) : k.toFixed(2)).replace(/\.?0+$/, '') + ' kA'; }
    return Math.round(v) + ' A';
  },
  fmtT(t) {
    if (t == null || !isFinite(t)) return 'does not clear';
    return t < 1 ? (t < 0.1 ? t.toFixed(3) : t.toFixed(2)) + ' s' : t.toFixed(t < 10 ? 1 : 0) + ' s';
  },

  // The schedule's status chip (text + class suffix + tooltip).
  chip(board, way) {
    const e = this.evaluate(board, way);
    const label = { pass: 'Coordinated', warn: 'Partial', fail: 'Check', info: 'Not checked', none: 'Not checked' }[e.status];
    const lines = [];
    if (e.status === 'none') lines.push(e.note);
    else {
      if (e.discr.pairs.length) e.discr.pairs.forEach(p => lines.push(`Discrimination (${p.down.label} → ${p.up.label}): ${p.message}`));
      else lines.push(`Discrimination: ${e.discr.message}`);
      lines.push(`Cable: ${e.cable.message}`);
      (e.breaking.items || []).filter(b => b.status !== 'info').forEach(b => lines.push(`Breaking capacity — ${b.message}`));
    }
    return { label, status: e.status, title: lines.join('\n') + '\n\nClick for the mini TCC.' };
  },

  // ─── Coordination tab ───
  // The mini TCC is a tab of the Schedules page (no modal): a way picker above
  // the plot. `open` is the door the grid's Coord chip uses.
  _host: null, _boardId: null, _wayId: null,

  open(boardId, wayId) {
    if (typeof Schedules !== 'undefined') Schedules.openCoord(boardId, wayId);
  },

  mount(boardId, host, wayId) {
    this._host = host;
    this._boardId = boardId;
    const board = AppState.components.get(boardId);
    const ways = board ? (board.props.circuits || []) : [];
    if (!ways.some(w => w.id === wayId)) wayId = (ways.find(w => w.device || Number(w.breaker_a) > 0) || ways[0] || {}).id;
    this._wayId = wayId;
    this.refresh();
  },

  unmount() { this._host = null; },

  refresh() {
    const host = this._host;
    if (!host) return;
    const board = AppState.components.get(this._boardId);
    const ways = board ? (board.props.circuits || []) : [];
    const way = ways.find(c => c.id === this._wayId);
    if (!board || !way) {
      host.innerHTML = '<div class="rtcc-empty" style="margin:16px">This board has no ways yet. Add a way on the Schedule tab.</div>';
      return;
    }
    const e = this.evaluate(board, way);
    const opts = ways.map(w => `<option value="${escHtml(w.id)}"${w.id === way.id ? ' selected' : ''}>Way ${escHtml(String(w.way))}${w.description ? ' · ' + escHtml(w.description) : ''}</option>`).join('');
    host.innerHTML = `<div class="dtcc-tab" style="overflow:auto;flex:1;min-height:0">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <label style="font-size:12px;color:var(--text-secondary)">Way
          <select id="dtcc-way" style="margin-left:4px">${opts}</select></label>
        <button class="btn-small" id="dtcc-prev" aria-label="Previous way">&larr;</button>
        <button class="btn-small" id="dtcc-next" aria-label="Next way">&rarr;</button>
      </div>
      ${e.items && e.items.length && e.row
        ? this._render(board, way, e)
        : `<div class="rtcc-empty">${escHtml(e.note || 'Nothing to plot.')}</div>`}
    </div>`;
    const go = (i) => { if (ways[i]) { this._wayId = ways[i].id; if (typeof Schedules !== 'undefined') Schedules._coordWay = this._wayId; this.refresh(); } };
    const idx = ways.findIndex(w => w.id === way.id);
    host.querySelector('#dtcc-way').addEventListener('change', (ev) => go(ways.findIndex(w => w.id === ev.target.value)));
    host.querySelector('#dtcc-prev').addEventListener('click', () => go(idx - 1));
    host.querySelector('#dtcc-next').addEventListener('click', () => go(idx + 1));
    host.querySelector('#dtcc-prev').disabled = idx <= 0;
    host.querySelector('#dtcc-next').disabled = idx >= ways.length - 1;
  },

  // ─── Plot ───
  _render(board, way, e) {
    const items = e.items;
    const f = (n) => n.toFixed(1);
    const rs = items.map(it => cbElementsA(it.dev.props).ir);
    const tops = items.map(it => this._top(it.dev));
    const ikAll = [e.ikMax, e.ikMin, ...items.map(it => it.ikA)].filter(v => v > 0);
    const lo = Math.min(...rs.map(r => r * 0.6), ...(e.ikMin ? [e.ikMin * 0.7] : []));
    const hi = Math.max(...tops.map(t => t * 1.6), ...ikAll.map(v => v * 1.6), Math.max(...rs) * 5);
    const dec0 = Math.floor(Math.log10(lo)), dec1 = Math.ceil(Math.log10(hi));
    const xmin = Math.pow(10, dec0), xmax = Math.pow(10, Math.max(dec1, dec0 + 1));
    const lx = Math.log10(xmin), span = Math.log10(xmax) - lx;
    const X = (i) => this.X0 + (this.X1 - this.X0) * (Math.log10(i) - lx) / span;
    const lt0 = Math.log10(this.T_MIN), ltSpan = Math.log10(this.T_MAX) - lt0;
    const clampT = (t) => Math.min(Math.max(t, this.T_MIN), this.T_MAX);
    const Y = (t) => this.Y0 + (this.Y1 - this.Y0) * (1 - (Math.log10(clampT(t)) - lt0) / ltSpan);
    const fmtI = (v) => v >= 1000 ? (v / 1000 % 1 === 0 ? (v / 1000) + 'k' : (v / 1000).toFixed(1) + 'k') : String(v);

    let grid = '', ticks = '';
    for (let dpow = dec0; dpow <= Math.log10(xmax) + 1e-9; dpow++) {
      const base = Math.pow(10, dpow);
      for (let m = 1; m <= 9; m++) {
        const v = base * m;
        if (v > xmax * 1.0001) break;
        grid += `<path class="${m === 1 ? 'rtcc-major' : 'rtcc-minor'}" d="M${f(X(v))} ${this.Y0}V${this.Y1}"/>`;
      }
      if (base <= xmax) ticks += `<text class="rtcc-tick" x="${f(X(base))}" y="${this.Y1 + 18}" text-anchor="middle">${fmtI(base)}</text>`;
    }
    for (let p = -2; p <= 3; p++) {
      const y = f(Y(Math.pow(10, p)));
      grid += `<path class="rtcc-major" d="M${this.X0} ${y}H${this.X1}"/>`;
      ticks += `<text class="rtcc-tick" x="${this.X0 - 6}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${Math.pow(10, p)}</text>`;
    }

    // One device: its band (tolerance) and its upper curve. Currents are
    // sampled densely plus both sides of every step.
    const N = 260;
    const draw = (it, color) => {
      const pts = [];
      for (let n = 0; n <= N; n++) pts.push(xmin * Math.pow(xmax / xmin, n / N));
      const el = cbElementsA(it.dev.props);
      [el.im, el.isd, el.ii].filter(v => v > xmin && v < xmax).forEach(s => pts.push(s * 0.9999, s));
      pts.sort((a, b) => a - b);
      const up = [], dn = [];
      let line = '', pen = false;
      for (const I of pts) {
        const b = cbTripBand(it.dev.props, I);
        const tMax = b.tMax, tMin = b.tMin;
        if (tMax < Infinity) {
          line += `${pen ? 'L' : 'M'}${f(X(I))} ${f(Y(tMax))}`; pen = true;
          up.push([X(I), Y(tMax)]);
          dn.push([X(I), Y(Math.min(tMin, tMax))]);
        } else pen = false;
      }
      const banded = !!it.dev.props.trip_tol && up.length > 1;
      const poly = banded
        ? `<path d="M${up.map(p => f(p[0]) + ' ' + f(p[1])).join('L')}L${dn.slice().reverse().map(p => f(p[0]) + ' ' + f(p[1])).join('L')}Z" fill="${escHtml(color)}" fill-opacity=".16" stroke="none"/>` : '';
      return poly + `<path class="rtcc-curve" style="stroke:${escHtml(color)}" d="${line}"><title>${escHtml(it.label + ' — ' + it.dev.name)}</title></path>`;
    };
    const curves = items.map((it, i) => draw(it, this.COLORS[i % this.COLORS.length])).join('');

    // Cable I²t
    let cableLine = '';
    if (e.mm2) {
      const kk = (e.k * e.mm2) * (e.k * e.mm2);
      let pen = false;
      for (let n = 0; n <= N; n++) {
        const I = xmin * Math.pow(xmax / xmin, n / N), t = kk / (I * I);
        if (t > this.T_MAX || t < this.T_MIN) { pen = false; continue; }
        cableLine += `${pen ? 'L' : 'M'}${f(X(I))} ${f(Y(t))}`; pen = true;
      }
    }

    // Not-selective stretch of the first pair that has a limit
    const lim = e.discr.pairs.find(p => p.limitA != null);
    const limHtml = lim && lim.limitA > xmin && lim.limitA < xmax
      ? `<rect x="${f(X(lim.limitA))}" y="${this.Y1 - 22}" width="${f(Math.max(0, this.X1 - X(lim.limitA)))}" height="22" fill="#d32f2f" fill-opacity=".18"/>`
        + `<path d="M${f(X(lim.limitA))} ${this.Y1 - 34}V${this.Y1}" stroke="#d32f2f" stroke-width="2"/>`
        + `<text class="rtcc-note" x="${f(X(lim.limitA) + 5)}" y="${this.Y1 - 26}" fill="#b71c1c">Not selective above ${escHtml(this.fmtA(lim.limitA))}</text>` : '';

    // Fault current markers + Icu ticks
    const vline = (I, label, cls, dy) => {
      if (!(I > xmin && I < xmax)) return '';
      // labels read to the right of their line unless that would run off the plot
      const left = cls === 'l' || X(I) > this.X1 - 190;
      return `<path class="rtcc-ia" d="M${f(X(I))} ${this.Y0}V${this.Y1}"/>`
        + `<text class="rtcc-note" x="${f(X(I) + (left ? -5 : 5))}" y="${this.Y0 + dy}" text-anchor="${left ? 'end' : 'start'}">${escHtml(label)}</text>`;
    };
    let marks = vline(e.ikMin, `Ik min ${this.fmtA(e.ikMin)} (earth fault, far end)`, 'l', 14)
      + vline(e.ikMax, `Ik max ${this.fmtA(e.ikMax)} (board)`, 'r', 14);
    items.forEach((it, i) => {
      const icu = it.dev.breakingKa ? it.dev.breakingKa * 1000 : 0;
      if (icu > xmin && icu < xmax) {
        const bad = it.ikA && icu < it.ikA;
        const casc = bad && e.breaking && e.breaking.items[i] ? e.breaking.items[i].cascade : null;
        const note = casc ? ` — below the fault level, cascaded with ${casc.up.label}: ${casc.reinforcedKa} kA` : bad ? ' — below the fault level' : '';
        marks += `<path d="M${f(X(icu))} ${this.Y1 - 60}V${this.Y1}" stroke="${this.COLORS[i % this.COLORS.length]}" stroke-width="3.5"><title>${escHtml(it.label)}: Icu ${it.dev.breakingKa} kA${escHtml(note)}</title></path>`;
      }
    });

    const svg = `<svg class="rtcc-plot" viewBox="0 0 ${this.W} ${this.H}" width="${this.W}" height="${this.H}" role="img"
        aria-label="Time-current curves of ${escHtml(items.map(it => it.dev.name).join(', '))} with the cable damage line and the fault currents marked">
      <rect class="rtcc-frame" x="${this.X0}" y="${this.Y0}" width="${this.X1 - this.X0}" height="${this.Y1 - this.Y0}"/>
      ${grid}${ticks}
      <text class="rtcc-axis" x="${(this.X0 + this.X1) / 2}" y="${this.H - 4}" text-anchor="middle">Current (A)</text>
      <text class="rtcc-axis" x="14" y="${(this.Y0 + this.Y1) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(this.Y0 + this.Y1) / 2})">Time (s)</text>
      ${limHtml}
      ${cableLine ? `<path d="${cableLine}" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-dasharray="7 5"><title>${e.mm2} mm² cable, k²S²/I²</title></path>` : ''}
      ${curves}
      ${marks}
    </svg>`;

    // Side panel
    const ST = { pass: ['✓', 'rtcc-ok-t'], warn: ['⚠', 'dtcc-warn-t'], fail: ['✕', 'rtcc-fail-t'], info: ['ℹ', 'dtcc-info-t'] };
    const card = (title, st, body) => `<div class="dtcc-card dtcc-${st}">
        <div class="dtcc-card-h"><b>${escHtml(title)}</b><span class="${escHtml(ST[st][1])}">${ST[st][0]} ${({ pass: 'Pass', warn: 'Partial', fail: 'Fail', info: 'Not evaluated' })[st]}</span></div>
        <div class="dtcc-card-b">${body}</div></div>`;
    const li = (arr) => `<ul>${arr.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`;
    const dev = items.map((it, i) => `<div><i class="rtcc-sw" style="background:${this.COLORS[i % this.COLORS.length]}"></i><b>${escHtml(it.label)}</b> <span>${escHtml(it.dev.name)}${it.dev.lib ? '' : ' · no library device'}${it.dev.props.trip_tol ? ' · published tolerance band' : ''}</span></div>`).join('');
    const basisNote = ({ declared: 'entered on the board', thevenin: 'from the network on the SLD', chained: 'the feeding board\'s level less the feeder cable' })[e.basis];

    return `<div class="rtcc">
      <div class="rtcc-sub">${escHtml(e.mm2 ? e.mm2 + ' mm² · ' : '')}${e.ikMax ? 'Ik max ' + escHtml(this.fmtA(e.ikMax)) + (basisNote ? ' (' + escHtml(basisNote) + ')' : '') : 'board fault level unknown — enter it on the board or wire the board to a source on the SLD'}${e.ikMin ? ' · Ik min ' + escHtml(this.fmtA(e.ikMin)) : ''}</div>
      <div class="rtcc-grid">
        <div class="rtcc-plotwrap">${svg}</div>
        <div class="rtcc-side">
          <div class="rtcc-devs">${dev}<div><i class="rtcc-sw" style="background:var(--text-secondary)"></i><b>Cable</b> <span>${e.mm2 ? e.mm2 + ' mm², k = ' + e.k : '—'} (dashed)</span></div></div>
          ${card('Breaking capacity', e.breaking.status, e.breaking.message ? escHtml(e.breaking.message) : li(e.breaking.items.map(b => b.message)))}
          ${card('Discrimination', e.discr.status, e.discr.pairs.length ? li(e.discr.pairs.map(p => `${p.down.label} → ${p.up.label}: ${p.message}`)) : escHtml(e.discr.message))}
          ${card('Cable protection', e.cable.status, escHtml(e.cable.message))}
        </div>
      </div>
      <div class="rtcc-foot">Curves are the library models (a manufacturer's breaker uses its published tolerance band; the band's slow edge is the clearing time, its fast edge the earliest trip). Ik max is the three-phase level at the board (IEC 60909, c = 1.10); Ik min is the earth-fault current at the far end of the way. An instantaneous trip is taken as 25 ms (the TCC and Cable Sizing convention); below about 0.1 s a breaker's let-through energy governs, which a time-current curve does not give — use the manufacturer's I²t data for the cable check there.</div>
    </div>`;
  },
};
