/* ProtectionPro — Overview: is this project OK? (UX plan PR 14)
 *
 * The first tab of a Reticulation, Building or Network project (a Lighting
 * project has its own, lightov.js). It reads results the workspaces already
 * hold and never starts a study by itself:
 *   · a health strip: fail / warning / out-of-date counts from Issues, with
 *     Calculate all (Demand's ADMD and earth check, street lighting, the
 *     circuit check, lighting, the out-of-date single-line studies), the
 *     Issues list and the report;
 *   · a card per workspace the project uses, a row per minisub, circuit,
 *     board, room or study, worst first. A row goes to its item (Links.go,
 *     with ← Back to the Overview).
 *
 * Pure data helpers (`minisubRows`, `boardRows`, `studyRows`, …) return plain
 * rows so the cards are node-testable.
 */

const Overview = {
  _active: false,
  _built: false,
  MAX_ROWS: 8,

  activate() {
    this._active = true;
    this._mount();
    const tb = document.getElementById('toolbar');
    const ws = document.getElementById('overview-workspace');
    if (tb && ws) ws.style.top = tb.offsetHeight + 'px';
    if (typeof Issues !== 'undefined') Issues.refresh();
    this.render();
  },
  deactivate() { this._active = false; },
  refresh() { if (this._active) this.render(); },

  _mount() {
    if (this._built) return;
    const host = document.getElementById('overview-workspace');
    if (!host) return;
    this._built = true;
    host.innerHTML = '<div class="ov-scroll"><main class="ov-main" id="ov-main"></main></div>';
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-ov-go], tr[data-ov-run]')) { e.preventDefault(); this._onClick(e); }
    });
  },

  // ── Data ──────────────────────────────────────────────────────────────
  _vis(ws) { return typeof Workspaces !== 'undefined' && Workspaces.isVisible(ws); },
  _f(v, d = 1) { return v == null || !isFinite(v) ? '—' : Number(v).toFixed(d); },
  _rank: { fail: 0, warn: 1, stale: 2, none: 3, ok: 4, info: 5 },
  _worstFirst(rows) { return rows.sort((a, b) => (this._rank[a.status] ?? 9) - (this._rank[b.status] ?? 9)); },

  // The minisub a kiosk is fed from (its feeder chain, else the first minisub).
  _msOf(k) {
    const ms = new Set((Retic.minisubs || []).map(m => m.id));
    let id = k.fedFrom, guard = 0;
    while (id && guard++ < 500) {
      if (ms.has(id)) return id;
      const p = Retic.kioskById ? Retic.kioskById(id) : null;
      if (!p) break;
      id = p.fedFrom;
    }
    return Retic.minisubs && Retic.minisubs[0] ? Retic.minisubs[0].id : null;
  },

  // Reticulation: one row per minisub.
  minisubRows() {
    if (typeof Retic === 'undefined' || !AppState.reticulation) return [];
    const res = AppState.reticResults;
    const byMs = new Map(((res && res.minisubs) || []).map(m => [m.minisubId, m]));
    const byK = {};
    for (const kr of (res && res.kiosks) || []) byK[kr.kioskId] = kr;
    const lim = Retic.settings.maxFeederVD;
    const earth = res && res.earth;
    const earthByK = new Map(((earth && earth.kiosks) || []).map(k => [k.kioskId, k]));
    return this._worstFirst((Retic.minisubs || []).map(ms => {
      const m = byMs.get(ms.id);
      const demand = m && m.totalKVA > 0 ? m.totalKVA : null;
      const tx = Retic._minisubTx(ms, demand || 0);
      let vd = null, nEarth = 0, earthFail = 0;
      for (const k of Retic.kiosks || []) {
        if (this._msOf(k) !== ms.id) continue;
        const cum = byK[k.id] ? Retic._cumulativeFeederVD(k.id, byK) : null;
        if (cum != null && (vd == null || cum > vd)) vd = cum;
        const ek = earthByK.get(k.id);
        if (ek) {
          for (const item of [ek, ...(ek.erfs || [])]) {
            const st = Retic._earthStatus(item);
            if (st === 'pass' || st === 'fail') nEarth++;
            if (st === 'fail') earthFail++;
          }
        }
      }
      const why = [];
      if (tx && tx.util > 100) why.push('Transformer overloaded');
      if (vd != null && vd > lim) why.push('Feeder volt drop over the limit');
      if (earthFail) why.push(`${earthFail} earth check${earthFail === 1 ? '' : 's'} fail`);
      const status = !res ? 'none' : why.length ? 'fail' : 'ok';
      return { id: ms.id, go: 'retic:' + ms.id, name: ms.name || 'Minisub', status,
        tx: tx ? tx.kva : null, demand, util: tx && demand ? tx.util : null, kiosks: m ? m.numKiosks : null,
        vd, vdOver: vd != null && vd > lim, nEarth, earthFail,
        verdict: !res ? 'Not calculated' : why.length ? why.join(' · ') : 'OK' };
    }));
  },

  // Street lighting: one row per circuit.
  circuitRows() {
    if (typeof StreetLight === 'undefined' || !AppState.reticulation) return [];
    return this._worstFirst((StreetLight.circuits || []).map(c => {
      const r = StreetLight._results[c.id];
      const status = !c.poles.length || !r ? 'none' : r.pass ? 'ok' : 'fail';
      return { id: c.id, go: 'sl:' + c.id, name: c.name, status, poles: c.poles.length,
        kva: StreetLight.circuitKVA ? StreetLight.circuitKVA(c) : null,
        vd: r ? r.worstVdPct : null, zs: r ? (r.zsPass ? 'pass' : 'fail') : null,
        verdict: !c.poles.length ? 'No poles' : !r ? 'Not calculated'
          : r.pass ? 'OK' : 'Fails on ' + (r.fails || []).map(f => StreetLight.FAIL_TEXT[f] || f).join(' + ') };
    }));
  },

  // Building: one row per distribution board.
  boardRows() {
    const res = AppState.dbCheckResults;
    const byBoard = new Map(((res && res.boards) || []).map(b => [b.id, b]));
    const vdBy = new Map();
    for (const w of (res && res.ways) || []) {
      const v = w.vd_total_pct != null ? w.vd_total_pct : w.vd_pct;
      if (v != null && (!vdBy.has(w.board_id) || v > vdBy.get(w.board_id))) vdBy.set(w.board_id, v);
    }
    const rows = [];
    for (const c of AppState.components.values()) {
      if (c.type !== 'distribution_board') continue;
      const ways = c.props.circuits || [];
      const r = byBoard.get(c.id);
      const parent = typeof DBFeeders !== 'undefined' && DBFeeders.parentOf ? DBFeeders.parentOf(c.id) : null;
      const n = (r && r.counts) || {};
      const status = !ways.length ? 'info' : !r ? 'none' : r.worst_status === 'fail' ? 'fail' : r.worst_status === 'warn' ? 'warn' : 'ok';
      rows.push({ id: c.id, name: c.props.name || c.id, status, board: c.id,
        fed: parent ? (parent.board.props.name || parent.board.id) : '',
        ways: ways.length, kva: ways.reduce((s, w) => s + (Number(w.load_va) || 0), 0) / 1000,
        pass: n.pass || 0, warn: n.warn || 0, fail: n.fail || 0, vd: vdBy.has(c.id) ? vdBy.get(c.id) : null,
        verdict: !ways.length ? 'No ways yet' : !r ? 'Not checked yet' : n.fail ? `${n.fail} fail` : n.warn ? `${n.warn} warning${n.warn === 1 ? '' : 's'}` : 'All pass' });
    }
    return this._worstFirst(rows);
  },

  // Rooms, areas and fields with their verdict.
  roomRows() {
    if (typeof Issues === 'undefined') return [];
    return this._worstFirst(Issues.lightRows().filter(r => r.kind !== 'obtrusive').map(r => ({
      id: r.id, floorId: r.floorId, name: r.name, sub: [r.task, r.floor].filter(Boolean).join(' · '),
      status: r.verdict === 'Fail' ? 'fail' : r.verdict === 'Pass' ? (r.stale ? 'stale' : 'ok') : 'none',
      em: r.em ? r.em.v : null, verdict: r.verdict === 'Fail' && r.failing && r.failing.length ? r.failing[0] : r.stale ? 'Out of date' : r.verdict,
    })));
  },

  // Single-line studies with results: when, current or not, what they found.
  studyRows() {
    if (typeof ResultsPanel === 'undefined') return [];
    const out = [];
    for (const k of ResultsPanel.TABS) {
      if (k === 'issues' || !ResultsPanel.has(k)) continue;
      const stale = ResultsPanel.isStale(k);
      const m = ResultsPanel.model(k);
      const n = ResultsPanel.counts(m);
      const v = ResultsPanel.verdict(k);
      const at = ResultsPanel.ranAt(k);
      const session = !ResultsPanel.SLOTS[k];
      out.push({ id: k, name: ResultsPanel.LABELS[k] || k, status: stale ? 'stale' : v === 'info' ? 'ok' : v,
        at, stale, session, fail: n.fail, warn: n.warn, rows: n.rows,
        result: n.fail || n.warn ? [n.fail ? `${n.fail} fail` : '', n.warn ? `${n.warn} warning${n.warn === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
          : v === 'fail' ? 'Fails' : v === 'warn' ? 'Warnings' : n.rows ? 'All clear' : 'Done',
        sections: (m && m.sections || []).filter(s => s.rows).map(s => {
          const c = ResultsPanel.counts({ sections: [s] });
          return { title: s.title, fail: c.fail, warn: c.warn, rows: c.rows };
        }) });
    }
    return this._worstFirst(out);
  },

  // The studies most networks need, not run yet: label → its Analyse button.
  BASICS: [['loadflow', 'Load flow', 'btn-run-loadflow'], ['fault', 'Short circuit', 'btn-run-fault'],
    ['duty', 'Duty check', 'btn-duty-check'], ['arcflash', 'Arc flash', 'btn-arcflash'], ['cable', 'Cable sizing', 'btn-cable-sizing']],

  // ── Render ────────────────────────────────────────────────────────────
  render() {
    const main = document.getElementById('ov-main');
    if (!main) return;
    const type = Workspaces.type();
    const list = typeof Issues !== 'undefined' ? Issues.list() : [];
    const n = typeof Issues !== 'undefined' ? Issues.counts(list) : { fail: 0, warn: 0, stale: 0 };
    const cards = [];
    const sld = AppState.components.size > 0;
    if (type === 'retic') {
      cards.push(this._minisubCard());
      if (this._vis('streetlight') && Workspaces.roadCircuitsOn()) cards.push(this._circuitCard());
      if (this._vis('plan')) cards.push(this._planCard('retic'));
      if (sld) cards.push(this._studiesCard(false));
    } else if (type === 'building') {
      cards.push(this._boardCard());
      if (this._vis('lighting')) cards.push(this._roomCard());
      if (this._vis('plan')) cards.push(this._planCard('building'));
      if (sld) cards.push(this._studiesCard(false));
    } else {
      cards.push(this._studiesCard(true));
      cards.push(this._findingsCard());
      cards.push(this._modelCard());
      if (this._vis('schedules')) cards.push(this._boardCard());
    }
    if (this._vis('quantities')) cards.push(this._quantitiesCard());
    const pills = [
      n.fail ? `<span class="ov-pill fail">${n.fail} fail</span>` : '',
      n.warn ? `<span class="ov-pill warn">${n.warn} warning${n.warn === 1 ? '' : 's'}</span>` : '',
      n.stale ? `<span class="ov-pill stale">${n.stale} out of date</span>` : '',
      !list.length ? '<span class="ov-pill ok">Nothing needs attention</span>' : '',
    ].join('');
    main.innerHTML = `
      <section class="ov-health" aria-label="Project health">
        <div class="ov-title"><h1>${escHtml(AppState.projectName || 'Untitled Project')}</h1><span class="ov-sub">${escHtml(this._subtitle(type))}</span></div>
        <div class="ov-pills">${pills}</div>
        <div class="ov-acts">
          <button type="button" class="btn-primary" data-ov="calc" title="${escHtml(this._calcTitle(type))}">Calculate all</button>
          ${list.length ? `<button type="button" class="btn-small" data-ov="issues">Show issues</button>` : ''}
          <button type="button" class="btn-small" data-ov="report">Report</button>
        </div>
      </section>
      <div class="ov-cards">${cards.filter(Boolean).join('')}</div>
      <p class="ov-note">Read from the results each workspace already has; nothing here runs on its own. Click a row to go to it.</p>`;
  },

  _subtitle(type) {
    const bits = [Workspaces.TYPES[type] ? Workspaces.TYPES[type].label : ''];
    if (type === 'retic' && AppState.reticulation) {
      const k = Retic.kiosks || [];
      const erven = k.reduce((s, x) => s + ((x.erfs || []).length), 0);
      bits.push(`${(Retic.minisubs || []).length} minisub${(Retic.minisubs || []).length === 1 ? '' : 's'}`, `${k.length} kiosk${k.length === 1 ? '' : 's'}`, `${erven} erven`);
      const t = AppState.reticResults && AppState.reticResults.total;
      if (t && t.totalKVA != null) bits.push(`demand ${Math.round(t.totalKVA)} kVA`);
    } else if (type === 'building') {
      const boards = [...AppState.components.values()].filter(c => c.type === 'distribution_board');
      const ways = boards.reduce((s, b) => s + ((b.props.circuits || []).length), 0);
      bits.push(`${boards.length} board${boards.length === 1 ? '' : 's'}`, `${ways} ways`);
      if (AppState.planMarkup) { const f = AppState.planFloors().length; bits.push(`${f} floor${f === 1 ? '' : 's'}`); }
    } else {
      const comps = [...AppState.components.values()];
      const buses = comps.filter(c => c.type === 'bus').length;
      bits.push(`${buses} bus${buses === 1 ? '' : 'es'}`, `${comps.length} parts`);
    }
    return bits.filter(Boolean).join(' · ');
  },
  _calcTitle(type) {
    const what = type === 'retic' ? 'Demand (ADMD and the earth check), street lighting'
      : type === 'building' ? 'the circuit check and the lighting' : 'nothing on its own';
    return `Brings everything up to date: ${what}${type === 'network' ? '' : ','} and re-runs the single-line studies that are out of date.`;
  },

  _dot(status) { return `<span class="rv-dot rv-${escHtml(status === 'none' ? 'info' : status === 'stale' ? 'warn' : status)}" aria-hidden="true"></span>`; },
  _card(id, title, open, body, foot, wide) {
    return `<section class="ov-card${wide ? ' ov-wide' : ''}" aria-labelledby="ov-h-${id}">
      <div class="ov-card-head"><h2 id="ov-h-${id}">${escHtml(title)}</h2><span class="ov-spacer"></span>
        ${open ? `<button type="button" class="ov-link" data-ov-tab="${escHtml(open)}">Open ${escHtml(Workspaces.label(open))} ›</button>` : ''}</div>
      <div class="ov-card-body">${body}</div>
      ${foot ? `<div class="ov-card-foot">${foot}</div>` : ''}
    </section>`;
  },
  // A table: cols [{ label, num }], rows [{ status, go | run, cells: [html] }].
  _table(cols, rows, empty, more) {
    if (!rows.length) return `<p class="ov-empty">${escHtml(empty)}</p>`;
    const numHtml = (num) => (num ? ' class="ov-num"' : '');
    const shown = rows.slice(0, this.MAX_ROWS);
    const extra = rows.length - shown.length;
    return `<div class="ov-tscroll"><table class="ov-table"><thead><tr>${cols.map(c => `<th${numHtml(c.num)}>${escHtml(c.label)}</th>`).join('')}</tr></thead><tbody>`
      + shown.map(r => `<tr class="ov-r ov-st-${escHtml(r.status)}"${r.go ? ` data-ov-go="${escHtml(r.go)}"` : ''}${r.run ? ` data-ov-run="${escHtml(r.run)}"` : ''} tabindex="0">`
        + r.cells.map((c, i) => `<td${numHtml(cols[i] && cols[i].num)}>${c}</td>`).join('') + '</tr>').join('')
      + `</tbody></table></div>${extra > 0 && more ? `<button type="button" class="ov-link ov-more" data-ov-tab="${escHtml(more)}">+${extra} more</button>` : ''}`;
  },
  _kv(pairs) {
    return `<dl class="ov-kv">${pairs.filter(Boolean).map(([k, v, cls]) => `<dt>${escHtml(k)}</dt><dd${cls ? ` class="${escHtml(cls)}"` : ''}>${v}</dd>`).join('')}</dl>`;
  },
  _bad(text, on) { return on ? `<span class="ov-bad">${text}</span>` : text; },

  _minisubCard() {
    const rows = this.minisubRows();
    const calc = !!AppState.reticResults;
    const body = this._table([{ label: 'Minisub' }, { label: 'Transformer', num: true }, { label: 'Demand', num: true }, { label: 'Loading', num: true },
      { label: 'Kiosks', num: true }, { label: 'Worst feeder VD', num: true }, { label: 'Earth checks', num: true }, { label: 'Verdict' }],
    rows.map(r => ({ status: r.status, go: r.go, cells: [
      `${this._dot(r.status)}${escHtml(r.name)}`,
      r.tx ? `${r.tx} kVA` : '—', r.demand ? `${Math.round(r.demand)} kVA` : '—',
      this._bad(r.util != null ? `${r.util} %` : '—', r.util > 100),
      r.kiosks != null ? String(r.kiosks) : '—',
      this._bad(r.vd != null ? `${r.vd.toFixed(2)} %` : '—', r.vdOver),
      r.nEarth ? this._bad(r.earthFail ? `${r.earthFail} of ${r.nEarth} fail` : `${r.nEarth} pass`, r.earthFail > 0) : '—',
      escHtml(r.verdict)] })), 'No minisubs yet.', 'retic');
    return this._card('ms', 'Minisubs', 'retic', body, calc ? '' : '<span class="ov-hint">Demand has not been calculated yet — press Calculate all.</span>', true);
  },

  _circuitCard() {
    const rows = this.circuitRows();
    const body = this._table([{ label: 'Circuit' }, { label: 'Poles', num: true }, { label: 'kVA', num: true }, { label: 'Worst VD', num: true }, { label: 'Zs' }, { label: 'Verdict' }],
      rows.map(r => ({ status: r.status, go: r.go, cells: [
        `${this._dot(r.status)}${escHtml(r.name)}`, String(r.poles), this._f(r.kva, 2),
        this._bad(r.vd != null ? `${this._f(r.vd, 2)} %` : '—', r.status === 'fail' && r.vd != null), r.zs ? this._bad(r.zs, r.zs === 'fail') : '—', escHtml(r.verdict)] })),
      'No street-lighting circuits yet.', 'streetlight');
    return this._card('sl', Workspaces.label('streetlight'), 'streetlight', body);
  },

  _boardCard() {
    const rows = this.boardRows();
    const body = this._table([{ label: 'Board' }, { label: 'Fed from' }, { label: 'Ways', num: true }, { label: 'Load', num: true },
      { label: 'Circuit check' }, { label: 'Worst VD', num: true }],
    rows.map(r => ({ status: r.status, run: 'board:' + r.id, cells: [
      `${this._dot(r.status)}${escHtml(r.name)}`, escHtml(r.fed || '—'), String(r.ways), `${this._f(r.kva)} kVA`,
      r.status === 'none' || r.status === 'info' ? `<span class="ov-muted">${escHtml(r.verdict)}</span>`
        : `${r.pass} pass${r.warn ? ` · <span class="ov-warn">${r.warn} warn</span>` : ''}${r.fail ? ` · <span class="ov-bad">${r.fail} fail</span>` : ''}`,
      r.vd != null ? `${this._f(r.vd, 2)} %` : '—'] })), 'No distribution boards yet.', 'schedules');
    const unchecked = rows.filter(r => r.status === 'none').length;
    return this._card('boards', 'Boards', 'schedules', body, unchecked ? `<span class="ov-hint">${unchecked} board${unchecked === 1 ? ' has' : 's have'} not been checked yet — press Calculate all.</span>` : '', true);
  },

  _roomCard() {
    const rows = this.roomRows();
    const body = this._table([{ label: 'Room / area' }, { label: 'Ēm', num: true }, { label: 'Verdict' }],
      rows.map(r => ({ status: r.status, run: `room:${r.floorId}:${r.id}`, cells: [
        `${this._dot(r.status)}${escHtml(r.name)}${r.sub ? `<small>${escHtml(r.sub)}</small>` : ''}`,
        r.em != null ? `${this._f(r.em, r.em < 10 ? 1 : 0)} lx` : '—', escHtml(r.verdict || '—')] })),
      'No rooms or areas yet.', 'lighting');
    return this._card('rooms', Workspaces.label('lighting'), 'lighting', body);
  },

  _planCard(domain) {
    const floors = AppState.planMarkup ? AppState.planFloors() : [];
    const uncal = floors.filter(f => !(f.data && f.data.scale && f.data.scale.factor)).length;
    const els = AppState.planMarkup && AppState.planAllElements ? AppState.planAllElements() : [];
    const syncQ = typeof Issues !== 'undefined' ? Issues.list().filter(i => i.key.startsWith('sync:') && i.ws === 'plan').length : 0;
    // Calibration matters once something is drawn to measure.
    const pairs = [
      [domain === 'retic' ? 'Plan' : 'Floors', !els.length ? 'nothing drawn yet'
        : uncal ? this._bad(`${uncal} of ${floors.length} not calibrated`, true) : `${floors.length}, calibrated`],
    ];
    if (domain === 'retic') {
      const drawn = (t) => els.filter(e => e.type === t);
      const linked = (t) => drawn(t).filter(e => e.reticId).length;
      const kiosks = (Retic.kiosks || []).length;
      const placedK = new Set(drawn('kiosk').map(e => e.reticId).filter(Boolean));
      const notPlaced = (Retic.kiosks || []).filter(k => !placedK.has(k.id)).length;
      pairs.push(['Drawn minisubs / kiosks / erven', `${drawn('minisub').length} / ${drawn('kiosk').length} / ${drawn('erf').length}`]);
      pairs.push(['Linked to Demand', `${linked('minisub') + linked('kiosk') + linked('erf')}`]);
      pairs.push(['Kiosks in Demand not drawn', this._bad(String(notPlaced), notPlaced > 0 && kiosks > 0 && els.length > 0)]);
    } else {
      const boards = els.filter(e => e.sldId || e.type === 'db' || e.type === 'board').length;
      const devices = els.filter(e => e.props && e.props.circuitDbId).length;
      pairs.push(['Drawn items', String(els.length)], ['Boards linked to the single line', String(els.filter(e => e.sldId).length || boards)], ['Devices on a board way', String(devices)]);
    }
    pairs.push(['Sync questions', this._bad(String(syncQ), syncQ > 0)]);
    return this._card('plan', Workspaces.label('plan'), 'plan', this._kv(pairs));
  },

  _studiesCard(full) {
    const rows = this.studyRows();
    const when = (at) => at ? new Date(at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—';
    const body = this._table([{ label: 'Study' }, { label: 'Ran' }, { label: 'State' }, { label: 'Result' }],
      rows.map(r => ({ status: r.status, run: 'study:' + r.id, cells: [
        `${this._dot(r.status)}${escHtml(r.name)}`, escHtml(when(r.at)),
        r.stale ? '<span class="ov-pill stale">out of date</span>' : r.session ? '<span class="ov-pill">this session</span>' : '<span class="ov-pill ok">current</span>',
        r.status === 'fail' ? `<span class="ov-bad">${escHtml(r.result)}</span>` : r.status === 'warn' ? `<span class="ov-warn">${escHtml(r.result)}</span>` : escHtml(r.result)] })),
      'No study has been run yet.', null);
    const have = new Set(rows.map(r => r.id));
    const missing = full ? this.BASICS.filter(([k]) => !have.has(k)) : [];
    const pend = typeof StaleResults !== 'undefined' ? StaleResults.pending().auto.length : 0;
    const foot = [
      pend ? `<button type="button" class="btn-small" data-ov="rerun">Re-run ${pend} stud${pend === 1 ? 'y' : 'ies'}</button>` : '',
      missing.length ? `<span class="ov-hint">Not run yet:</span>${missing.map(([k, label, btn]) => `<button type="button" class="ov-link" data-ov-runstudy="${escHtml(btn)}">${escHtml(label)}</button>`).join('')}` : '',
    ].filter(Boolean).join('');
    return this._card('studies', full ? 'Studies' : 'Single-line studies', 'sld', body, foot, full);
  },

  _findingsCard() {
    const lines = [];
    for (const r of this.studyRows()) {
      if (r.stale) continue;
      for (const s of r.sections) {
        if (!s.fail && !s.warn) continue;
        lines.push([`${r.name} · ${s.title}`, [s.fail ? `<span class="ov-bad">${s.fail} fail</span>` : '', s.warn ? `<span class="ov-warn">${s.warn} warning${s.warn === 1 ? '' : 's'}</span>` : ''].filter(Boolean).join(' · ')]);
      }
    }
    return this._card('findings', 'Findings', null, lines.length ? this._kv(lines) : `<p class="ov-empty">${this.studyRows().length ? 'No study has a fail or warning.' : 'Run a study to see what it finds.'}</p>`);
  },

  _modelCard() {
    const comps = [...AppState.components.values()];
    let v = { errors: [], warnings: [] };
    try { if (comps.length && typeof Components !== 'undefined') v = Components.validate(); } catch (_) { /* leave empty */ }
    const pages = (AppState.pages && AppState.pages.length) || 1;
    const il = AppState.interlockLogic && AppState.interlockLogic.nodes ? AppState.interlockLogic.nodes.length : 0;
    return this._card('model', 'Network model', 'sld', this._kv([
      ['Parts on the single line', String(comps.length)],
      ['Pages', String(pages)],
      ['Pre-run checks', !comps.length ? '—' : v.errors.length || v.warnings.length
        ? [v.errors.length ? `<span class="ov-bad">${v.errors.length} error${v.errors.length === 1 ? '' : 's'}</span>` : '', v.warnings.length ? `<span class="ov-warn">${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}</span>` : ''].filter(Boolean).join(' · ')
        : 'all clear'],
      this._vis('interlock') ? ['Interlocking logic', il ? `${il} block${il === 1 ? '' : 's'}` : 'none yet'] : null,
    ]));
  },

  _quantitiesCard() {
    let res = null;
    try {
      if (typeof BOQ !== 'undefined' && Object.values(BOQ.available()).some(Boolean)) res = BOQ.compute(BOQ._defaultOpts());
    } catch (_) { res = null; }
    // Unpriced items matter once the rate library has rates in it.
    const L = AppState.rateLibrary;
    const priced = !!(L && ((L.items && Object.keys(L.items).length) || (L.custom && Object.keys(L.custom).length)));
    const money = (v) => (typeof Rates !== 'undefined' && Rates.money) ? Rates.money(v) : Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const body = res ? this._kv([
      ['Items', `${res.nItems}${priced && res.nPriced != null ? ` · ${res.nPriced} priced` : ''}`],
      priced ? ['BOQ total', escHtml(money(res.total))] : ['Rates', 'none entered yet'],
      priced ? ['Items with no rate', this._bad(String(res.missing.length), res.missing.length > 0)] : null,
    ]) : '<p class="ov-empty">Nothing to take off yet.</p>';
    return this._card('q', 'Quantities', 'quantities', body);
  },

  // ── Actions ───────────────────────────────────────────────────────────
  _onClick(e) {
    const t = e.target;
    const q = (sel) => t.closest && t.closest(sel);
    let b;
    if ((b = q('[data-ov-tab]'))) { switchWorkspace(b.dataset.ovTab); return; }
    if ((b = q('[data-ov-runstudy]'))) {
      switchWorkspace('sld');
      document.getElementById(b.dataset.ovRunstudy)?.click();
      return;
    }
    if ((b = q('[data-ov]'))) { this._act(b.dataset.ov); return; }
    if ((b = q('[data-ov-go]'))) { if (typeof Links !== 'undefined') Links.go(b.dataset.ovGo, 'tab:overview'); return; }
    if ((b = q('[data-ov-run]'))) { this._run(b.dataset.ovRun); }
  },
  _run(what) {
    const [kind, ...rest] = what.split(':');
    const back = () => { if (typeof Links !== 'undefined' && Links._showBack) Links._showBack('tab:overview'); };
    if (kind === 'board') {
      switchWorkspace('schedules');
      if (typeof Schedules !== 'undefined' && Schedules.selectBoard) Schedules.selectBoard(rest[0]);
      back();
    } else if (kind === 'room') {
      const [floorId, id] = [rest[0], rest.slice(1).join(':')];
      switchWorkspace('lighting');
      LightingWS.view = 'plan';
      LightingWS.locate(id, floorId);
      back();
    } else if (kind === 'study') {
      switchWorkspace('sld');
      ResultsPanel.open(rest[0]);
      back();
    }
  },
  async _act(a) {
    if (a === 'issues') { if (typeof Issues !== 'undefined') Issues.open(); return; }
    if (a === 'rerun') { if (typeof StaleResults !== 'undefined') await StaleResults.rerun(); this.render(); return; }
    if (a === 'report') {
      const type = Workspaces.type();
      if (type === 'retic' && typeof ReticReport !== 'undefined' && AppState.reticResults) ReticReport.export();
      else document.getElementById('btn-export-pdf')?.click();
      return;
    }
    if (a === 'calc') await this.calcAll();
  },

  // Bring every workspace's results up to date, one after another.
  async calcAll() {
    const type = Workspaces.type();
    const steps = [];
    if (this._vis('retic') && typeof Retic !== 'undefined' && (Retic.kiosks || []).length) {
      steps.push(['Demand', async () => { await Retic._doCompute(); await Retic._doEarth(); }]);
    }
    if (this._vis('streetlight') && typeof StreetLight !== 'undefined' && Workspaces.roadCircuitsOn() && (StreetLight.circuits || []).some(c => c.poles.length)) {
      steps.push(['Street lighting', () => StreetLight._doCompute()]);
    }
    if ([...AppState.components.values()].some(c => c.type === 'distribution_board' && (c.props.circuits || []).length) && typeof DBSchedule !== 'undefined') {
      steps.push(['Circuit check', () => DBSchedule.runCheck()]);
    }
    if (type !== 'retic' && this._vis('lighting') && typeof Issues !== 'undefined' && Issues.lightRows().length) {
      steps.push(['Lighting', async () => {
        const keep = LightingWS.scope; LightingWS.scope = 'all';
        try { await LightingWS.calcAll(); } finally { LightingWS.scope = keep; }
      }]);
    }
    const pend = typeof StaleResults !== 'undefined' ? StaleResults.pending().auto.length : 0;
    if (pend) steps.push(['Single-line studies', () => StaleResults.rerun()]);
    if (!steps.length) {
      UI.toast(type === 'network' ? 'Every study is up to date. Run a study from the single line’s Analyse menu.' : 'Nothing to calculate yet.', 'info');
      return;
    }
    const failed = [];
    for (const [label, fn] of steps) {
      if (UI.setBusy) UI.setBusy(true, `Calculating: ${label}…`);
      try { await fn(); } catch (e) { console.error('Calculate all:', label, e); failed.push(label); }
    }
    if (UI.setBusy) UI.setBusy(false);
    if (typeof Issues !== 'undefined') Issues.refresh();
    if (this._active) this.render();
    UI.toast(failed.length ? `Could not calculate: ${failed.join(', ')}.` : `Up to date: ${steps.map(s => s[0]).join(', ')}.`, failed.length ? 'error' : 'success');
  },
};

if (typeof window !== 'undefined') window.Overview = Overview;
if (typeof module !== 'undefined' && module.exports) module.exports = Overview;
