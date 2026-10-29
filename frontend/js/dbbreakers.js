/* ProtectionPro — Set manufacturer: every breaker on a board from one maker.
 *
 * A board's breaker rules (`comp.props.breaker_set`):
 *   { maker, types: { lighting|sockets|fixed|motor|other: { series, curve } },
 *     above: series for ways over 63 A, fallback: true }
 * curve 'keep' leaves the way's own curve. A way's circuit type comes from
 * its description (the load presets name themselves: "Lighting…", "Socket
 * Outlet…"); feeders to sub-boards count as "other".
 *
 * A way finds its device: its type → range + curve; that range's breaker at
 * the way's Breaker (A) and curve (an MCCB ignores the curve); not there →
 * the maker's other ranges, lowest breaking capacity first that still covers
 * the board's fault level; still none → the way is left as it is. Within a
 * range the lowest breaking capacity that covers the fault level is taken.
 *
 * The rules are saved with the board: new ways take the device for their type
 * (fillNew), and editing a way's rating or curve moves its device to the same
 * range at the new value (follow) rather than dropping it to Generic.
 */

const BreakerSet = {
  TYPES: [
    { k: 'lighting', label: 'Lighting', curve: 'B' },
    { k: 'sockets', label: 'Sockets', curve: 'C' },
    { k: 'fixed', label: 'Fixed appliances', curve: 'C' },
    { k: 'motor', label: 'Motors / pumps', curve: 'D' },
    { k: 'other', label: 'Other', curve: 'keep' },
  ],
  MCB_MAX_A: 63,
  _opts: { boards: 'this', ways: 'all', incoming: true },

  typeOf(way) {
    if (way.type === 'feeder_db') return 'other';
    const d = String(way.description || '').toLowerCase();
    if (/\b(light|lights|lighting|lamp|luminaire|downlight|floodlight)/.test(d)) return 'lighting';
    if (/\b(socket|sockets|plug|plugs|s\/o|outlet)/.test(d)) return 'sockets';
    if (/\b(motor|pump|fan|compressor|lift|hoist|gate|conveyor|chiller)/.test(d)) return 'motor';
    if (/\b(geyser|stove|oven|hob|heater|aircon|air con|a\/c|hvac|ev charger|heat pump|dishwasher|washing|dryer|kettle|urn|boiler)/.test(d)) return 'fixed';
    return 'other';
  },

  _lv() { return STANDARD_CBS.filter(x => !x.rated_voltage_kv || x.rated_voltage_kv <= 1); },

  // Makers with a series in the library (the generic entries have neither).
  makers() {
    return [...new Set(this._lv().filter(x => x.manufacturer && x.series).map(x => String(x.manufacturer).trim()))]
      .sort((a, b) => a.localeCompare(b));
  },

  // The maker's ranges: { series, type, kaMin, kaMax, aMin, aMax, curves }.
  ranges(maker) {
    const by = new Map();
    for (const x of this._lv()) {
      if (String(x.manufacturer || '').trim() !== maker || !x.series) continue;
      const r = by.get(x.series) || { series: x.series, type: x.cb_type, kaMin: Infinity, kaMax: 0, aMin: Infinity, aMax: 0, curves: new Set() };
      const ka = Number(x.breaking_ka) || 0, a = Number(x.trip_rating_a) || 0;
      r.kaMin = Math.min(r.kaMin, ka); r.kaMax = Math.max(r.kaMax, ka);
      r.aMin = Math.min(r.aMin, a); r.aMax = Math.max(r.aMax, a);
      if (x.mcb_curve) r.curves.add(x.mcb_curve);
      by.set(x.series, r);
    }
    return [...by.values()].sort((p, q) => p.kaMin - q.kaMin || p.series.localeCompare(q.series));
  },

  covers(r, ikA) { return !(ikA > 0) || r.kaMax * 1000 >= ikA; },

  rangeLabel(r, ikA) {
    const ka = r.kaMin === r.kaMax ? `${r.kaMin} kA` : `${r.kaMin}–${r.kaMax} kA`;
    const ok = ikA > 0 ? (this.covers(r, ikA) ? ' ✓' : ' ✗') : '';
    return `${r.series} · ${ka}${ok}`;
  },

  // Sensible rules for a maker at a fault level: the lowest-capacity MCB
  // range that covers it for every type, the same rule above 63 A.
  defaults(maker, ikA) {
    const rs = this.ranges(maker);
    const pick = (list) => list.find(r => this.covers(r, ikA)) || list[list.length - 1] || null;
    const mcb = pick(rs.filter(r => r.type === 'mcb' && r.aMin <= 10)) || pick(rs);
    const big = pick(rs.filter(r => r.aMax > this.MCB_MAX_A));
    const types = {};
    for (const t of this.TYPES) types[t.k] = { series: mcb ? mcb.series : '', curve: t.curve };
    return { maker, types, above: big ? big.series : (mcb ? mcb.series : ''), fallback: true };
  },

  // The breaker in one range at a rating + curve; within the range the
  // lowest breaking capacity that covers the fault level, else the highest.
  find(maker, series, a, curve, ikA) {
    const xs = this._lv().filter(x => String(x.manufacturer || '').trim() === maker && x.series === series
      && Number(x.trip_rating_a) === Number(a) && (x.cb_type !== 'mcb' || !curve || x.mcb_curve === curve));
    if (!xs.length) return null;
    xs.sort((p, q) => (Number(p.breaking_ka) || 0) - (Number(q.breaking_ka) || 0));
    return xs.find(x => !(ikA > 0) || (Number(x.breaking_ka) || 0) * 1000 >= ikA) || xs[xs.length - 1];
  },

  // → { entry, curve, type, other } or { reason, type }.
  resolve(cfg, way, ikA) {
    const a = Number(way.breaker_a) || 0;
    const type = this.typeOf(way);
    if (!(a > 0)) return { type, reason: 'No breaker rating.' };
    const rule = (cfg.types && cfg.types[type]) || {};
    const curve = !rule.curve || rule.curve === 'keep' ? String(way.curve || 'C').toUpperCase() : rule.curve;
    const series = a > this.MCB_MAX_A ? cfg.above : rule.series;
    const hit = series && this.find(cfg.maker, series, a, curve, ikA);
    if (hit) return { entry: hit, curve, type, other: false };
    if (cfg.fallback !== false) {
      for (const r of this.ranges(cfg.maker)) {
        if (r.series === series || !this.covers(r, ikA)) continue;
        const e = this.find(cfg.maker, r.series, a, curve, ikA);
        if (e) return { entry: e, curve, type, other: true };
      }
    }
    return { type, curve, reason: `No ${cfg.maker} breaker at ${a} A curve ${curve}${cfg.fallback !== false ? ' in any range' : ` in ${series || 'the range'}`}.` };
  },

  _ik(board) { return typeof DbCoord !== 'undefined' ? (DbCoord._ikOf(board) || 0) : 0; },

  _boards() { return [...AppState.components.values()].filter(c => c.type === 'distribution_board'); },

  // ── Saved rules at work ─────────────────────────────────────────────
  // A new way on a board with rules gets its device straight away.
  fillNew(comp, way) {
    const cfg = comp && comp.props.breaker_set;
    if (!cfg || !cfg.maker || way.device) return;
    const r = this.resolve(cfg, way, this._ik(comp));
    if (r.entry) DbCoord.applyToWay(way, 'cb:' + r.entry.id);
  },

  // Rating or curve edited by hand on a way with a library device: the same
  // maker + range at the new value; the board's rules next; else Generic.
  follow(comp, way) {
    const cur = way.device ? DbCoord.deviceById(way.device) : null;
    const ik = this._ik(comp);
    const curve = String(way.curve || 'C').toUpperCase();
    if (cur && cur.entry && cur.entry.manufacturer && cur.entry.series) {
      const e = this.find(String(cur.entry.manufacturer).trim(), cur.entry.series, way.breaker_a, curve, ik);
      if (e) { way.device = 'cb:' + e.id; return; }
    }
    const cfg = comp && comp.props.breaker_set;
    if (cfg && cfg.maker) {
      const r = this.resolve({ ...cfg, types: Object.fromEntries(Object.entries(cfg.types || {}).map(([k, v]) => [k, { ...v, curve }])) }, way, ik);
      if (r.entry) { way.device = 'cb:' + r.entry.id; return; }
    }
    way.device = '';
  },

  // ── Dialog ───────────────────────────────────────────────────────────
  open(comp, opts) {
    if (!comp) return;
    const o = this._opts;
    if (opts && opts.ways) o.ways = opts.ways;
    const makers = this.makers();
    const ik = this._ik(comp);
    let cfg = comp.props.breaker_set && makers.includes(comp.props.breaker_set.maker)
      ? JSON.parse(JSON.stringify(comp.props.breaker_set))
      : (makers.length ? this.defaults(makers[0], ik) : null);
    const circuits = comp.props.circuits || [];
    const selected = circuits.filter(c => DBSchedule._selected.has(c.id));
    if (o.ways === 'selected' && !selected.length) o.ways = 'all';
    const boards = this._boards();
    const generic = circuits.filter(c => !c.device).length;

    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'bks-title');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    const seg = (group, k, label, count, off) => `<button type="button" data-bks-${group}="${k}" aria-pressed="${o[group] === k}"${off ? ` disabled title="${escHtml(off)}"` : ''}>${label}${count != null ? ` <b>${count}</b>` : ''}</button>`;
    m.innerHTML = `<div class="modal-content modal-wide csz" style="max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3 id="bks-title">Use one manufacturer — ${escHtml(comp.props.name || comp.id)}</h3>
        <button class="modal-close" data-bks="cancel" aria-label="Close">&times;</button></div>
      ${makers.length ? `<div class="csz-body">
        <div class="csz-rules">
          <section><h4>Manufacturer</h4><select id="bks-maker">${makers.map(x => `<option${cfg && cfg.maker === x ? ' selected' : ''}>${escHtml(x)}</option>`).join('')}</select>
            <small class="bks-ik">${ik > 0 ? `Fault level at this board: ${DbCoord.fmtA(ik)} — ranges that cover it are marked ✓` : 'Fault level not known yet — run the circuit check to rule out ranges that are too weak.'}</small></section>
          <section><h4>Breaker per circuit type</h4><div class="bks-types" id="bks-types"></div></section>
          <section><h4>Apply to</h4>
            <div class="csz-seg" role="group" aria-label="Which boards">${seg('boards', 'this', 'This board')}${seg('boards', 'all', 'All boards', boards.length, boards.length > 1 ? '' : 'Only one board')}</div>
            <div class="csz-seg" role="group" aria-label="Which ways">${seg('ways', 'all', 'All', circuits.length)}${seg('ways', 'generic', 'Generic', generic)}${seg('ways', 'selected', 'Selected', selected.length, selected.length ? '' : 'Tick ways in the grid first')}</div>
            <label class="csz-chk"><input type="checkbox" id="bks-incoming"${o.incoming ? ' checked' : ''}><span>Also the incoming device<small>At its present rating, when one is set</small></span></label>
          </section>
          <section><h4>No exact match</h4>
            <label class="csz-chk"><input type="radio" name="bks-fb" value="1"${cfg.fallback !== false ? ' checked' : ''}><span>Try the maker's other ranges<small>Same rating and curve, lowest breaking capacity that covers the fault level</small></span></label>
            <label class="csz-chk"><input type="radio" name="bks-fb" value="0"${cfg.fallback === false ? ' checked' : ''}><span>Leave the way as it is</span></label>
          </section>
        </div>
        <div class="csz-preview"><div class="csz-sum" id="bks-sum"></div><div class="csz-table" id="bks-table"></div></div>
      </div>` : `<div class="csz-empty" style="padding:24px">No manufacturer breakers in your library yet. Import a manufacturer's library under <strong>Project ▸ Libraries…</strong> (Import JSON), then come back.</div>`}
      <div class="modal-footer csz-foot">
        <span>Each way keeps its rating. The rules are saved with the board for new ways. Ctrl+Z undoes it in one step.</span>
        <button class="btn-small" data-bks="cancel">Cancel</button>
        <button class="btn-small btn-primary" data-bks="apply" disabled>Apply</button></div></div>`;
    document.body.appendChild(m);

    let plan = [];
    const typesHtml = () => {
      const rs = this.ranges(cfg.maker);
      const opts = (cur) => rs.map(r => `<option value="${escHtml(r.series)}" title="${escHtml(`${r.aMin}–${r.aMax} A${r.curves.size ? ', curves ' + [...r.curves].sort().join(' ') : ''}`)}"${r.series === cur ? ' selected' : ''}>${escHtml(this.rangeLabel(r, ik))}</option>`).join('');
      const curves = (cur) => ['keep', 'B', 'C', 'D'].map(c => `<option value="${c}"${c === cur ? ' selected' : ''}>${c === 'keep' ? 'Keep' : c}</option>`).join('');
      return `<span class="bks-h">Type</span><span class="bks-h">Range</span><span class="bks-h">Curve</span>`
        + this.TYPES.map(t => `<span>${t.label}</span><select data-bks-series="${escHtml(t.k)}">${opts(cfg.types[t.k].series)}</select><select data-bks-curve="${escHtml(t.k)}">${curves(cfg.types[t.k].curve)}</select>`).join('')
        + `<span>Above ${this.MCB_MAX_A} A</span><select data-bks-above class="bks-wide">${opts(cfg.above)}</select>`;
    };
    const run = () => {
      if (!cfg) return;
      plan = this._plan(comp, cfg, o);
      this._renderPreview(m, plan);
    };
    if (cfg) { m.querySelector('#bks-types').innerHTML = typesHtml(); run(); }

    const finish = () => { document.removeEventListener('keydown', onKey, true); m.remove(); };
    const onKey = (ev) => { if (ev.key === 'Escape' && !document.querySelector('.ss-pop:not([hidden])')) { ev.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);
    m.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'bks-maker') { cfg = this.defaults(t.value, ik); m.querySelector('#bks-types').innerHTML = typesHtml(); }
      else if (t.dataset.bksSeries) cfg.types[t.dataset.bksSeries].series = t.value;
      else if (t.dataset.bksCurve) cfg.types[t.dataset.bksCurve].curve = t.value;
      else if (t.hasAttribute('data-bks-above')) cfg.above = t.value;
      else if (t.name === 'bks-fb') cfg.fallback = t.value === '1';
      else if (t.id === 'bks-incoming') o.incoming = t.checked;
      else if (t.matches('[data-bks-row], [data-bks-all]')) {
        if (t.hasAttribute('data-bks-all')) m.querySelectorAll('[data-bks-row]:not(:disabled)').forEach(x => { x.checked = t.checked; });
        this._syncApply(m);
        return;
      } else if (t.hasAttribute('data-bks-unchanged')) { m.querySelector('#bks-table').classList.toggle('csz-changes', !t.checked); return; }
      else return;
      run();
    });
    m.addEventListener('click', (ev) => {
      if (ev.target === m) return finish();
      const sb = ev.target.closest('[data-bks-boards], [data-bks-ways]');
      if (sb && !sb.disabled) {
        const group = sb.dataset.bksBoards ? 'boards' : 'ways';
        o[group] = sb.dataset.bksBoards || sb.dataset.bksWays;
        m.querySelectorAll(`[data-bks-${group}]`).forEach(b => b.setAttribute('aria-pressed', String(b === sb)));
        run();
        return;
      }
      const b = ev.target.closest('[data-bks]');
      if (!b) return;
      if (b.dataset.bks === 'cancel') return finish();
      if (b.dataset.bks === 'apply') {
        const on = new Set([...m.querySelectorAll('[data-bks-row]:checked')].map(x => x.dataset.bksRow));
        this._apply(comp, cfg, plan, on, o);
        finish();
      }
    });
    if (typeof SearchSelect !== 'undefined') SearchSelect.delegate(m);
  },

  // One row per way (and incoming device) on the boards in scope.
  _plan(comp, cfg, o) {
    const boards = o.boards === 'all' ? this._boards() : [comp];
    const rows = [];
    for (const b of boards) {
      const ik = this._ik(b);
      const mine = b.id === comp.id;
      for (const c of b.props.circuits || []) {
        if (o.ways === 'generic' && c.device) continue;
        if (o.ways === 'selected' && !(mine && DBSchedule._selected.has(c.id))) continue;
        const r = this.resolve(cfg, c, ik);
        const now = c.device ? DbCoord.deviceById(c.device) : null;
        const same = r.entry && c.device === 'cb:' + r.entry.id;
        rows.push({ key: b.id + '|' + c.id, board: b, way: c, r, now, same,
          curveFrom: String(c.curve || 'C').toUpperCase(), kind: r.entry ? (same ? 'same' : 'set') : 'none' });
      }
      if (o.incoming && b.props.incoming_device) {
        const cur = DbCoord.deviceById(b.props.incoming_device);
        const a = cur && Number(cur.entry.trip_rating_a);
        if (a > 0) {
          const pseudo = { breaker_a: a, curve: cur.entry.mcb_curve || 'C', description: '' };
          const r = this.resolve({ ...cfg, types: { other: { series: a > this.MCB_MAX_A ? cfg.above : cfg.types.other.series, curve: 'keep' } } }, pseudo, ik);
          const same = r.entry && b.props.incoming_device === 'cb:' + r.entry.id;
          rows.push({ key: b.id + '|incoming', board: b, incoming: true, r, now: cur, same,
            curveFrom: pseudo.curve, kind: r.entry ? (same ? 'same' : 'set') : 'none' });
        }
      }
    }
    return rows;
  },

  _renderPreview(m, plan) {
    const n = (k) => plan.filter(p => p.kind === k).length;
    const other = plan.filter(p => p.kind === 'set' && p.r.other).length;
    const multi = new Set(plan.map(p => p.board.id)).size > 1;
    m.querySelector('#bks-sum').innerHTML = `<strong>Preview</strong><span>${[
      n('set') && `<span class="csz-up">${n('set')} to change</span>`,
      other && `${other} from another range`,
      n('same') && `${n('same')} already right`,
      n('none') && `<span class="csz-bad">${n('none')} no match</span>`,
    ].filter(Boolean).join(' · ') || 'Nothing in scope.'}</span>
      <label class="csz-chk csz-chk-inline"><input type="checkbox" data-bks-unchanged><span>Show unchanged</span></label>`;
    const typeLabel = Object.fromEntries(this.TYPES.map(t => [t.k, t.label]));
    const rows = plan.map(p => {
      const w = p.way;
      const label = p.incoming ? 'Incoming' : escHtml(String(w.way ?? ''));
      const desc = p.incoming ? 'Incoming device' : escHtml(w.description || '');
      const a = p.incoming ? (p.now ? p.now.entry.trip_rating_a : '') : (w.breaker_a ?? '');
      const curveTo = p.r.entry && p.r.entry.cb_type === 'mcb' ? p.r.curve : '';
      const curve = curveTo && curveTo !== p.curveFrom ? `${escHtml(p.curveFrom)} → <b>${escHtml(curveTo)}</b>` : escHtml(curveTo || (p.incoming ? '' : p.curveFrom));
      const dev = p.r.entry
        ? `<span class="${p.kind === 'set' ? 'csz-up' : ''}">${escHtml(p.r.entry.name)}</span>${p.r.other ? ' <span class="bks-other" title="Not in the chosen range at this rating — taken from another range">other range</span>' : ''}`
        : `<span class="csz-bad">— no match</span>`;
      const msg = p.kind === 'none' ? `<tr class="csz-msg"><td></td><td colspan="8">${escHtml(p.r.reason || '')} The ${p.incoming ? 'device' : 'way'} is left as it is.</td></tr>` : '';
      return `<tr class="${p.kind === 'same' ? 'csz-same' : 'csz-chg'}">
        <td><input type="checkbox" data-bks-row="${escHtml(p.key)}" aria-label="Apply to ${escHtml(label)}"${p.kind === 'set' ? ' checked' : ' disabled'}></td>
        <td><b>${multi ? escHtml(p.board.props.name || p.board.id) + ' · ' : ''}${label}</b></td><td>${desc}</td>
        <td class="csz-muted">${p.incoming ? '' : escHtml(typeLabel[p.r.type] || '')}</td><td class="num">${escHtml(String(a))} A</td><td>${curve}</td>
        <td class="csz-muted">${p.now ? escHtml(p.now.name) : 'Generic'}</td><td>${dev}</td>
        <td class="num">${p.r.entry && p.r.entry.breaking_ka ? escHtml(String(p.r.entry.breaking_ka)) + ' kA' : ''}</td></tr>${msg}`;
    }).join('');
    const tbl = m.querySelector('#bks-table');
    tbl.classList.add('csz-changes');
    tbl.innerHTML = `<table><thead><tr><th><input type="checkbox" data-bks-all checked aria-label="Apply all"></th>
      <th>Way</th><th>Description</th><th>Type</th><th class="num">A</th><th>Curve</th><th>Now</th><th>New device</th><th class="num">Icu</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${!plan.some(p => p.kind !== 'same') ? '<div class="csz-empty">Every breaker in scope already matches.</div>' : ''}`;
    this._syncApply(m);
  },

  _syncApply(m) {
    const n = m.querySelectorAll('[data-bks-row]:checked').length;
    const b = m.querySelector('[data-bks="apply"]');
    b.disabled = n === 0;
    b.textContent = n ? `Set ${n} breaker${n === 1 ? '' : 's'}` : 'Apply';
  },

  _apply(comp, cfg, plan, on, o) {
    let set = 0, curves = 0;
    const touched = new Set();
    for (const p of plan) {
      if (p.kind !== 'set' || !on.has(p.key)) continue;
      const ref = 'cb:' + p.r.entry.id;
      if (p.incoming) p.board.props.incoming_device = ref;
      else {
        if (p.r.entry.cb_type === 'mcb' && p.r.curve !== p.curveFrom) curves++;
        DbCoord.applyToWay(p.way, ref);
      }
      touched.add(p.board.id);
      set++;
    }
    // The rules go with every board in scope, for its new ways.
    const scope = o.boards === 'all' ? this._boards() : [comp];
    for (const b of scope) b.props.breaker_set = JSON.parse(JSON.stringify(cfg));
    for (const b of scope) if (b.id !== comp.id) DBSchedule.recompute(b);
    if (!DBSchedule.commit()) {
      AppState.dirty = true;
      if (typeof Properties !== 'undefined') Properties._notifyResultsCleared();
      AppState.clearResults();
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    }
    DBSchedule.render();
    if (typeof Schedules !== 'undefined' && Schedules._active) Schedules.render();
    const none = plan.filter(p => p.kind === 'none').length;
    DBSchedule._status(`Set ${set} breaker${set === 1 ? '' : 's'} to ${cfg.maker}`
      + (curves ? ` · ${curves} curve${curves === 1 ? '' : 's'} changed` : '')
      + (none ? ` · ${none} with no match, left as they were` : '')
      + (touched.size > 1 ? ` on ${touched.size} boards` : '') + '. Run Check circuits for the new verdicts.');
  },

  // Board settings ▸ Breakers: what the board's rules are, in a line.
  summary(comp) {
    const cfg = comp.props.breaker_set;
    if (!cfg || !cfg.maker) return 'No manufacturer set';
    const series = [...new Set(this.TYPES.map(t => cfg.types[t.k] && cfg.types[t.k].series).filter(Boolean))];
    return `${cfg.maker} · ${series.join(', ')}`;
  },

  copyToAll(comp) {
    const cfg = comp.props.breaker_set;
    if (!cfg) return 0;
    const others = this._boards().filter(b => b.id !== comp.id);
    for (const b of others) b.props.breaker_set = JSON.parse(JSON.stringify(cfg));
    if (others.length) {
      AppState.dirty = true;
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    }
    return others.length;
  },
};
