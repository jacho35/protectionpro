/* ProtectionPro — phone layout of the circuit schedule.
 *
 * The Schedules grid is 30+ columns wide, which on a phone degrades to one
 * 1,000 px card per way. Under 768 px the workspace shows this instead:
 *   · a one-line board summary (kVA, phase split, check counts) + filter chips,
 *   · one compact card per way (title row + one summary line + the reason a
 *     way is flagged),
 *   · a bottom edit SHEET for one way, its fields in small groups, with
 *     Prev / Next / Duplicate / Delete,
 *   · a sticky action bar (+ Way, Add load, Select, ⋯ more),
 *   · contactors (DBControls): a tag on each switched way's card, a Control
 *     group in the way sheet, Select mode to put ticked ways on a contactor,
 *     and a Controls sheet (contactors + control supplies).
 *
 * It owns NO model logic. Field writes go through DBSchedule._setWayField (the
 * same path as the grid's change handler: coercion, plan pins, poles/phase
 * rules, load-type fill-in), adding ways through DBSchedule.newWay /
 * addLoad, and the edit session / commit / undo path is DBSchedule's own —
 * Schedules mounts this the way it mounts the single-line drawing.
 */

const SchMobile = {
  _boardId: null,
  _host: null,
  _sheetId: null,        // way id open in the sheet
  _filter: 'all',        // all | fail | R | W | B
  _query: '',
  _mq: null,
  _selecting: false,     // Select mode: cards are tick boxes for a contactor
  _sel: new Set(),

  // Same breakpoint as the stylesheet's phone rules.
  isPhone() {
    if (!this._mq) this._mq = window.matchMedia('(max-width: 768px)');
    return this._mq.matches;
  },

  comp() { return this._boardId ? AppState.components.get(this._boardId) : null; },

  _e(v) { return escHtml(String(v == null ? '' : v)); },

  // ── Mount ─────────────────────────────────────────────────────────
  mount(boardId, host) {
    this._boardId = boardId;
    this._host = host;
    this._sheetId = null;
    host.innerHTML = `
      <div class="smb-wrap">
        <div class="smb-summary" id="smb-summary"></div>
        <div class="smb-filters" id="smb-filters"></div>
        <div class="smb-list" id="smb-list"></div>
        <div class="smb-bar" id="smb-bar"></div>
      </div>`;
    this._selecting = false;
    this._sel.clear();
    host.onclick = (e) => this._click(e);
    host.oninput = (e) => {
      if (e.target.id === 'smb-q') { this._query = e.target.value; this._renderList(); }
    };
    this.render();
  },

  unmount() {
    this.closeSheet();
    const cs = document.getElementById('smb-ctl-sheet');
    if (cs) cs.classList.remove('open');
    this._closeMenu();
    if (this._host) { this._host.onclick = null; this._host.oninput = null; }
    this._boardId = null;
    this._host = null;
  },

  // ── Data ──────────────────────────────────────────────────────────
  _vll(comp) { return DBSchedule._boardVll ? DBSchedule._boardVll(comp) : 400; },

  // Status + the one line that explains it. The backend verdict is the
  // authority once a check has run; before that, the local warnings stand in.
  _verdict(c, vll) {
    const row = DBSchedule._resultFor(c);
    const local = DBSchedule._wayWarnings(c, !!row, vll);
    if (!row) return { status: local.length ? 'fail' : 'none', reason: local[0] || '', row: null };
    const status = DBSchedule._worstStatus(row.ampacity_status, row.coordination_status,
      row.vd_status, row.ecc_status, local.length ? 'fail' : null);
    let reason = '';
    if (status === 'fail' || status === 'warn') {
      const pick = (st, msg) => (st === status && msg) ? msg : '';
      reason = pick(row.coordination_status, row.coordination_message)
        || pick(row.ampacity_status, row.ampacity_message)
        || pick(row.vd_status, row.vd_message)
        || pick(row.ecc_status, row.ecc_message)
        || local[0] || ((row.messages || [])[0]) || '';
    }
    return { status, reason, row };
  },

  _phaseLabel(c) {
    return (c.poles === '3P' || c.phase === 'RWB') ? '3P' : `1P ${c.phase || 'R'}`;
  },

  _passes(c, st) {
    const q = this._query.trim().toLowerCase();
    if (q && !`${c.way} ${c.description || ''} ${c.el_group || ''}`.toLowerCase().includes(q)) return false;
    if (this._filter.startsWith('sec:')) return (DBSections.of(this.comp(), c) || {}).id === this._filter.slice(4);
    if (this._filter === 'fail') return st === 'fail' || st === 'warn';
    if (this._filter === 'R' || this._filter === 'W' || this._filter === 'B') {
      return c.poles === '3P' ? false : (c.phase || 'R') === this._filter;
    }
    return true;
  },

  // ── Render ────────────────────────────────────────────────────────
  render() {
    if (!this._host || !this.comp()) return;
    DBSchedule.syncResults();
    this._renderSummary();
    this._renderFilters();
    this._renderList();
    this._renderBar();
    if (this._sheetId) this._refreshSheetResults();
  },

  // After an edit made elsewhere (the contactor editor): the list, an open
  // way sheet and an open Controls sheet.
  refresh() {
    if (!this._host || !this.comp()) return;
    this.render();
    if (this._sheetId) this._renderSheet();
    const cs = document.getElementById('smb-ctl-sheet');
    if (cs && cs.classList.contains('open')) this._paintControls();
  },

  _renderBar() {
    const bar = this._host.querySelector('#smb-bar');
    if (!bar) return;
    if (!this._selecting) {
      bar.className = 'smb-bar';
      bar.innerHTML = `
        <button class="btn-small btn-primary" data-smb="add-way">+ Way</button>
        <button class="btn-small" data-smb="add-load">Add load</button>
        <button class="btn-small" data-smb="select">Select</button>
        <button class="btn-small" data-smb="more" aria-haspopup="menu" aria-label="More">⋯</button>`;
      return;
    }
    const n = this._sel.size;
    const has = DBControls.has(this.comp());
    bar.className = 'smb-bar smb-selbar';
    bar.innerHTML = `
      <div class="smb-selbar-row"><span class="smb-selcount" role="status">${n} way${n === 1 ? '' : 's'} selected</span>
        <button class="btn-small" data-smb="sel-cancel">Cancel</button></div>
      <div class="smb-selbar-row"><button class="btn-small" data-smb="sel-new"${n ? '' : ' disabled'}>Switch with a new contactor…</button></div>
      <div class="smb-selbar-row">
        ${has ? `<button class="btn-small" data-smb="sel-add" aria-haspopup="menu"${n ? '' : ' disabled'}>Add to contactor…</button>` : ''}
        <button class="btn-small" data-smb="sel-off"${n ? '' : ' disabled'}>Take off contactor</button></div>`;
  },

  _renderSummary() {
    const comp = this.comp();
    const t = DBSchedule.recompute(comp);   // derived props are restored by commit() if nothing else changed
    const tot = t.phaseVa.R + t.phaseVa.W + t.phaseVa.B;
    const pct = (k) => tot > 0 ? Math.round(t.phaseVa[k] / tot * 100) : 0;
    const vll = this._vll(comp);
    let pass = 0, warn = 0, fail = 0;
    for (const c of comp.props.circuits || []) {
      const s = this._verdict(c, vll).status;
      if (s === 'fail') fail++; else if (s === 'warn') warn++; else if (s === 'pass') pass++;
    }
    const el = this._host.querySelector('#smb-summary');
    el.innerHTML = `
      <div class="smb-sum-top">${(comp.props.circuits || []).length} ways · ${t.connectedKva.toFixed(1)} kVA connected · demand ${t.demandKva.toFixed(1)} kVA</div>
      <div class="smb-sum-row">
        <span class="smb-ph smb-ph-R">R ${pct('R')}%</span>
        <span class="smb-ph smb-ph-W">W ${pct('W')}%</span>
        <span class="smb-ph smb-ph-B">B ${pct('B')}%</span>
        <span class="smb-chk">${pass ? `<b class="st-pass">✓ ${pass}</b>` : ''}${warn ? ` <b class="st-warn">! ${warn}</b>` : ''}${fail ? ` <b class="st-fail">✗ ${fail}</b>` : ''}${(pass + warn + fail) ? '' : '<i>not checked</i>'}</span>
      </div>`;
  },

  _renderFilters() {
    const f = this._filter;
    const chip = (k, l) => `<button class="smb-chip${f === k ? ' on' : ''}" data-smb-filter="${k}">${l}</button>`;
    const el = this._host.querySelector('#smb-filters');
    // The search box keeps focus across renders — it is only built once.
    if (!el.querySelector('#smb-q')) {
      el.innerHTML = `<input id="smb-q" type="search" placeholder="Search ways" value="${this._e(this._query)}" aria-label="Search ways">
        <div class="smb-chips" id="smb-chips"></div>`;
    }
    el.querySelector('#smb-chips').innerHTML =
      chip('all', 'All') + chip('fail', 'Issues')
      + (() => {
        const n = DBControls.contactors(this.comp()).length;
        return `<button class="smb-chip${n ? ' smb-chip-ctl' : ''}" data-smb="controls">${n ? `Controls · ${n} K` : '+ Controls'}</button>`;
      })()
      + chip('R', 'R') + chip('W', 'W') + chip('B', 'B')
      + (DBSections.has(this.comp()) ? DBSections.list(this.comp()).map(s => chip('sec:' + s.id, this._e(s.name))).join('') : '')
      + `<button class="smb-chip" data-smb="sections">${DBSections.has(this.comp()) ? '⚙ Sections' : '+ Sections'}</button>`;
  },

  // Add / edit / remove board sections (Normal, Essential, UPS …) — the same
  // panel the desktop grid shows, in a full-height sheet.
  openSections() {
    const comp = this.comp(); if (!comp) return;
    let sh = document.getElementById('smb-sec-sheet');
    if (!sh) {
      sh = document.createElement('div');
      sh.id = 'smb-sec-sheet';
      sh.className = 'smb-sheet';
      sh.setAttribute('role', 'dialog');
      sh.setAttribute('aria-modal', 'true');
      document.getElementById('schedules-workspace').appendChild(sh);
      sh.addEventListener('click', (e) => {
        if (e.target.closest('[data-sec-close]')) { sh.classList.remove('open'); this.render(); }
      });
    }
    const paint = () => {
      const c = this.comp();
      sh.innerHTML = `
        <div class="smb-sheet-head"><strong>Board sections</strong><span style="flex:1"></span>
          <button class="btn-small" data-sec-close>Done</button></div>
        <div class="smb-sheet-body">${DBSections.panelHTML(c).replace('<details class="dbs-panel" id="dbs-panel"', '<details class="dbs-panel" id="dbs-panel" open')}</div>`;
      DBSections.bind(sh, c, (rerender) => { this._touch(); if (rerender) paint(); }, null);
    };
    paint();
    sh.classList.add('open');
  },

  _renderList() {
    const comp = this.comp();
    const list = this._host.querySelector('#smb-list');
    const vll = this._vll(comp);
    const ways = comp.props.circuits || [];
    const cards = [];
    ways.forEach((c, i) => {
      const v = this._verdict(c, vll);
      if (!this._passes(c, v.status)) return;
      const kva = (Number(c.load_va) || 0) / 1000;
      const cable = [c.cable_mm2 ? `${c.cable_mm2} mm²` : '', Number(c.cable_m) > 0 ? `${c.cable_m} m` : ''].filter(Boolean).join(' · ');
      const k = DBControls.wayContactor(comp, c);
      const pole = k ? DBControls.poleLabel(comp, k, c) : '';
      const ctlLine = k ? `${k.tag}${pole ? ' pole ' + pole : ''} · ${DBControls.switchedBy(k)}${!DBControls.isDirect(k) && k.selector !== 'none' ? ' · ' + (k.selector === 'hoa' ? 'H-O-A' : 'O-A') : ''}` : '';
      const sel = this._selecting;
      const on = sel && this._sel.has(c.id);
      cards.push(`
        <button class="smb-card st-${escHtml(v.status)}${sel ? ' smb-sel' : ''}${on ? ' on' : ''}" ${sel
          ? `data-smb-pick="${this._e(c.id)}" aria-pressed="${on}" aria-label="Select way ${this._e(c.way)}"`
          : `data-smb-way="${this._e(c.id)}" aria-label="Edit way ${this._e(c.way)}"`}>
          ${sel ? `<input type="checkbox" tabindex="-1" aria-hidden="true"${on ? ' checked' : ''}>` : ''}
          <span class="smb-no"${DBSections.has(comp) ? ` style="border-left:4px solid ${DBSections.color(DBSections.of(comp, c))}" title="${this._e(DBSections.of(comp, c).name)}"` : ''}>${this._e(c.way ?? i + 1)}</span>
          <span class="smb-main">
            <span class="smb-title">${this._e(c.description || 'Unnamed way')}</span>
            <span class="smb-meta">${this._e(c.breaker_a ?? '—')} A ${this._e(c.curve || '')} · ${this._e(this._phaseLabel(c))}${cable ? ' · ' + this._e(cable) : ''} · ${kva.toFixed(2)} kVA</span>
            ${ctlLine ? `<span class="smb-ctl">${this._e(ctlLine)}</span>` : ''}
            ${v.reason ? `<span class="smb-reason">${this._e(v.reason)}</span>` : ''}
          </span>
          ${k ? `<span class="dbc-tag">${this._e(k.tag)}</span>` : ''}
          <span class="smb-dot st-${escHtml(v.status)}" aria-hidden="true"></span>
        </button>`);
    });
    list.innerHTML = cards.join('') || `<div class="smb-empty">${ways.length
      ? 'No ways match this filter.'
      : 'No ways yet. Use <b>+ Way</b> or <b>Add load</b> below.'}</div>`;
  },

  // ── Edits (all through the grid's own write path) ─────────────────
  _touch() {
    // Edits invalidate the verdicts exactly as a grid edit does.
    DBSchedule._notifyEdited();
    if (typeof Schedules !== 'undefined') Schedules._markStale && Schedules._markStale();
  },

  _way(id) { const c = this.comp(); return c ? (c.props.circuits || []).find(w => w.id === id) : null; },

  addWay() {
    const comp = this.comp(); if (!comp) return;
    const w = DBSchedule.newWay(comp.props.circuits.length, DBSchedule._sectionOverrides(comp));
    BreakerSet.fillNew(comp, w);
    comp.props.circuits.push(w);
    this._touch();
    this.render();
    this.openSheet(w.id);
  },

  // ── Sheet ─────────────────────────────────────────────────────────
  openSheet(id) {
    if (!this._way(id)) return;
    this._sheetId = id;
    let sheet = document.getElementById('smb-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'smb-sheet';
      sheet.className = 'smb-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-labelledby', 'smb-sheet-title');
      sheet.tabIndex = -1;
      document.getElementById('schedules-workspace').appendChild(sheet);
      sheet.addEventListener('click', (e) => this._sheetClick(e));
      sheet.addEventListener('change', (e) => this._sheetChange(e));
      sheet.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeSheet(); this.render(); }
      });
    }
    const wasOpen = sheet.classList.contains('open');
    this._renderSheet();
    sheet.classList.add('open');
    const body = sheet.querySelector('.smb-sheet-body');
    if (body) body.scrollTop = 0;
    if (!wasOpen) {
      this._returnFocus = document.activeElement;
      sheet.focus({ preventScroll: true });
      // The phone's back button closes the sheet instead of leaving the page.
      try { history.pushState({ smbSheet: true }, ''); this._histPushed = true; } catch (e) { this._histPushed = false; }
      if (!this._onPop) {
        this._onPop = () => { if (this._sheetId) { this._histPushed = false; this.closeSheet(); this.render(); } };
        window.addEventListener('popstate', this._onPop);
      }
    }
  },

  closeSheet() {
    this._sheetId = null;
    const sheet = document.getElementById('smb-sheet');
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    if (this._histPushed) {
      this._histPushed = false;
      if (history.state && history.state.smbSheet) history.back();
    }
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
  },

  _renderSheet() {
    const sheet = document.getElementById('smb-sheet');
    const comp = this.comp();
    const c = this._way(this._sheetId);
    if (!sheet || !comp || !c) return;
    const ways = comp.props.circuits;
    const idx = ways.indexOf(c);
    const e = this._e;
    const is3 = c.poles === '3P';
    const opt = (v, cur, l) => `<option value="${e(v)}"${String(v) === String(cur) ? ' selected' : ''}>${e(l ?? v)}</option>`;
    const num = (k, label, extra = '') => `
      <label class="smb-f"><span>${label}</span>
        <input type="number" inputmode="decimal" data-k="${k}" value="${e(c[k] ?? '')}" ${extra}></label>`;
    const sizes = (typeof IEC_STANDARD_SIZES !== 'undefined')
      ? IEC_STANDARD_SIZES : [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400];
    const sizeSel = (k, blank) => `<select data-k="${k}">${blank ? opt('', c[k] == null ? '' : c[k], blank) : ''}
      ${sizes.map(s => opt(s, c[k])).join('')}${(c[k] != null && c[k] !== '' && !sizes.includes(Number(c[k]))) ? opt(c[k], c[k]) : ''}</select>`;
    const loads = (typeof DB_LOAD_TYPES !== 'undefined' ? DB_LOAD_TYPES : []).filter(t => t.va);
    const conType = (Conduit.type(c.conduit_type) || {}).id || '';
    const pins = DBSchedule._wayPins(c);

    sheet.innerHTML = `
      <div class="smb-sheet-head">
        <button class="btn-small" data-sh="prev" ${idx <= 0 ? 'disabled' : ''} aria-label="Previous way">‹</button>
        <strong id="smb-sheet-title">Way ${e(c.way)}</strong>
        <span class="smb-sheet-of">${idx + 1} / ${ways.length}</span>
        <button class="btn-small" data-sh="next" ${idx >= ways.length - 1 ? 'disabled' : ''} aria-label="Next way">›</button>
        <button class="btn-small btn-primary smb-done" data-sh="close">Done</button>
      </div>
      <div class="smb-sheet-body">
        <div class="smb-result" id="smb-result"></div>
        <section><h4>Circuit</h4>
          <label class="smb-f"><span>Way no.</span><input type="text" data-k="way" value="${e(c.way)}"></label>
          ${DBSections.has(comp) ? `<label class="smb-f"><span>Section</span><select data-k="section">${DBSections.list(comp).map(s => opt(s.id, DBSections.of(comp, c).id, s.name)).join('')}</select></label>` : ''}
          <label class="smb-f"><span>Description</span>
            <input type="text" data-k="description" list="smb-loads" value="${e(c.description || '')}"></label>
          <datalist id="smb-loads">${loads.map(t => `<option value="${e(t.label)}">`).join('')}</datalist>
          ${pins.length ? `<p class="smb-pin">📌 Pinned: ${e(pins.join(', '))} — protected from the plan sync.
            <button class="btn-small" data-sh="unpin">Unpin</button></p>` : ''}
        </section>
        ${this._ctlSectionHTML(comp, c)}
        ${this._mtrSectionHTML(comp, c)}
        <section><h4>Device</h4>
          ${num('breaker_a', 'Breaker (A)', 'min="1" step="1"')}
          <label class="smb-f"><span>Curve</span><select data-k="curve">${['B', 'C', 'D'].map(v => opt(v, c.curve || 'C')).join('')}</select></label>
          <label class="smb-f"><span>Poles</span><select data-k="poles">${opt('1P', c.poles || '1P')}${opt('3P', c.poles || '1P')}</select></label>
          <label class="smb-f"><span>Phase</span><select data-k="phase" ${is3 ? 'disabled' : ''}>
            ${is3 ? opt('RWB', 'RWB') : ['R', 'W', 'B'].map(v => opt(v, c.phase || 'R')).join('')}</select></label>
        </section>
        <section><h4>Load</h4>
          ${num('load_va', 'Load (VA)', 'min="0" step="50"')}
          ${num('demand_factor', 'Demand factor', 'min="0" max="1" step="0.05"')}
          ${num('power_factor', 'Power factor', 'min="0.05" max="1" step="0.01"')}
        </section>
        <section><h4>Cable</h4>
          <label class="smb-f"><span>Live (mm²)</span>${sizeSel('cable_mm2')}</label>
          <label class="smb-f"><span>ECC (mm²)</span>${sizeSel('ecc_mm2', 'Auto (Table 54.7)')}</label>
          ${num('cable_m', 'Length (m)', 'min="0" step="1"')}
        </section>
        <section><h4>Earth leakage</h4>
          <label class="smb-f"><span>EL group</span><input type="text" data-k="el_group" value="${e(c.el_group || '')}" placeholder="—"></label>
          ${num('leakage_ma', 'Leakage (mA)', 'min="0" step="0.1"')}
        </section>
        <section><h4>Conduit</h4>
          <label class="smb-f"><span>Tag</span><input type="text" data-k="conduit_tag" value="${e(c.conduit_tag || '')}" placeholder="own conduit"></label>
          <label class="smb-f"><span>Type</span><select data-k="conduit_type"><option value="">—</option>
            ${Conduit.TYPES.map(t => opt(t.id, conType, t.label)).join('')}</select></label>
          <label class="smb-f"><span>Size</span><select data-k="conduit_size" ${conType ? '' : 'disabled'}><option value="">Auto</option>
            ${Conduit.sizes(conType).map(sz => opt(sz, c.conduit_size || '')).join('')}</select></label>
          <p class="smb-conduit" id="smb-conduit"></p>
        </section>
        <div class="smb-sheet-actions">
          <button class="btn-small" data-sh="dup">Duplicate</button>
          <button class="btn-small smb-danger" data-sh="del">Delete way</button>
        </div>
      </div>`;
    this._refreshSheetResults();
  },

  // The way's contactor: pick one (or a new one), a summary of it, Edit / Take off.
  _ctlSectionHTML(comp, c) {
    const e = this._e;
    const k = DBControls.wayContactor(comp, c);
    const list = DBControls.contactors(comp);
    const opt = (v, l) => `<option value="${e(v)}"${k ? (v === k.id ? ' selected' : '') : (v === '' ? ' selected' : '')}>${e(l)}</option>`;
    let sum = '';
    if (k) {
      const others = DBControls.waysOf(comp, k).filter(w => w !== c).map(w => w.way);
      const pole = DBControls.poleLabel(comp, k, c);
      const sup = DBControls.supply(comp, k.supply);
      const sel = k.selector === 'none' ? '' : `${k.selector === 'hoa' ? 'Hand–Off–Auto' : 'Off–Auto'} ${k.selector_tag || ''}`;
      const sw = (k.switches || []).map(s => `${DBControls.switchKind(s.kind).label.toLowerCase()} ${s.tag}`);
      const by = sw.length ? sw.join(k.combine === 'parallel' ? ' or ' : ' and ') + (sw.length > 1 ? (k.combine === 'parallel' ? ' in parallel' : ' in series') : '') : 'no switching device';
      const bad = DBControls.warnings(comp, k).filter(w => w.level === 'warn');
      sum = `<div class="smb-ctlsum">
          <div class="smb-ctlsum-head"><span class="dbc-tag">${e(k.tag)}</span><strong>${e(DBControls.specText(k))}</strong>
            ${pole ? `<span class="dbc-dim">pole ${e(pole)} of ${e(String(DBControls._polesN(k)))}</span>` : ''}</div>
          <div>${e(by.charAt(0).toUpperCase() + by.slice(1))}${sel ? ' · ' + e(sel) : ''}${sup ? ' · supply ' + e(sup.tag) : ''}${k.lamp ? ' · door lamp ' + e(DBControls.lampTag(k)) : ''}</div>
          ${others.length ? `<div class="dbc-dim">Also switches way${others.length === 1 ? '' : 's'} ${e(others.join(', '))}</div>` : ''}
          ${bad.length ? `<div class="dbc-bad">⚠ ${e(bad[0].text)}</div>` : ''}
        </div>
        <div class="smb-ctlbtns">
          <button class="btn-small smb-ctl-edit" data-sh="ctl-edit">Edit ${e(k.tag)}</button>
          <button class="btn-small" data-sh="ctl-off">Take off ${e(k.tag)}</button>
        </div>`;
    }
    return `<section class="smb-ctlsec"><h4>Control</h4>
        <label class="smb-f"><span>Switched by</span><select data-k="contactor">
          ${opt('', '— not switched')}${list.map(x => opt(x.id, `${x.tag}${x.label ? ' · ' + x.label : ''}`)).join('')}
          <option value="__new">New contactor…</option></select></label>
        ${sum}</section>`;
  },

  // The way's meter (DBMeters): pick one (or a new one), a summary, Edit.
  _mtrSectionHTML(comp, c) {
    const e = this._e;
    const m = DBMeters.wayMeter(comp, c);
    const inc = DBMeters.list(comp).find(x => x.scope === 'incomer');
    const list = DBMeters.list(comp).filter(x => x.scope !== 'incomer' && (x === m || x.scope === 'group' || !DBMeters.waysOf(comp, x).length));
    const opt = (v, l) => `<option value="${e(v)}"${(m ? m.id : '') === v ? ' selected' : ''}>${e(l)}</option>`;
    let sum = '';
    if (m) {
      const bad = DBMeters.warnings(comp, m).filter(w => w.level === 'warn');
      sum = `<div class="smb-ctlsum">
          <div class="smb-ctlsum-head"><span class="dbm-tag${DBMeters.isGroup(m) ? ' grp' : ''}">${e(m.tag)}</span><strong>${e(DBMeters.type(m.type).short)}${m.cls ? ' · cl ' + e(m.cls) : ''}</strong></div>
          <div>${e(DBMeters.measuresText(comp, m))}</div>
          <div class="dbc-dim">${e(DBMeters.spec(m))}</div>
          <div class="dbc-dim">${e(DBMeters.comms(m))}</div>
          ${bad.length ? `<div class="dbc-bad">⚠ ${e(bad[0].text)}</div>` : ''}
        </div>
        <div class="smb-ctlbtns"><button class="btn-small smb-ctl-edit" data-sh="mtr-edit">Edit ${e(m.tag)}</button></div>`;
    }
    return `<section class="smb-ctlsec dbm-scope"><h4>Metering</h4>
        <label class="smb-f"><span>Metered by</span><select data-k="meter">
          ${opt('', inc ? `— via ${inc.tag} (incomer)` : '— not metered')}${list.map(x => opt(x.id, `${x.tag}${x.scope === 'group' ? ' · group' : ''}${x.label ? ' · ' + x.label : ''}`)).join('')}
          <option value="__new">New meter…</option></select></label>
        ${sum}</section>`;
  },

  // ── Controls sheet (contactors + control supplies) ────────────────
  openControls() {
    if (!this.comp()) return;
    let sh = document.getElementById('smb-ctl-sheet');
    if (!sh) {
      sh = document.createElement('div');
      sh.id = 'smb-ctl-sheet';
      sh.className = 'smb-sheet smb-ctlsheet';
      sh.setAttribute('role', 'dialog');
      sh.setAttribute('aria-modal', 'true');
      sh.setAttribute('aria-label', 'Controls');
      document.getElementById('schedules-workspace').appendChild(sh);
      sh.addEventListener('click', (e) => {
        if (e.target.closest('[data-ctl-close]')) { sh.classList.remove('open'); this.render(); }
      });
    }
    this._paintControls();
    sh.classList.add('open');
  },

  _paintControls() {
    const sh = document.getElementById('smb-ctl-sheet');
    const c = this.comp();
    if (!sh || !c) return;
    sh.innerHTML = `
      <div class="smb-sheet-head"><strong>Controls · ${this._e(c.props.name || c.id)}</strong><span style="flex:1"></span>
        <button class="btn-small btn-primary" data-ctl-close>Done</button></div>
      <div class="smb-sheet-body" id="smb-ctl-body"></div>`;
    DBControls.render(c, sh.querySelector('#smb-ctl-body'), () => { this._touch(); this.render(); }, { mode: 'panel' });
  },

  // ── Select mode → contactor ───────────────────────────────────────
  _selWays() { const c = this.comp(); return c ? (c.props.circuits || []).filter(w => this._sel.has(w.id)) : []; },

  _endSelect() {
    this._selecting = false;
    this._sel.clear();
    this._renderList();
    this._renderBar();
  },

  // Check verdicts + conduit fill — repainted without rebuilding the form, so
  // a focused field keeps its cursor while a check lands.
  _refreshSheetResults() {
    const c = this._way(this._sheetId);
    const comp = this.comp();
    const out = document.getElementById('smb-result');
    if (!c || !comp || !out) return;
    const vll = this._vll(comp);
    const v = this._verdict(c, vll);
    const row = v.row;
    const fla = DBSchedule._wayFlaA(c, vll);
    const fmt = (x, d = 1) => (x == null || isNaN(x)) ? '—' : Number(x).toFixed(d);
    const vd = row ? (row.vd_total_pct != null ? row.vd_total_pct : row.vd_pct) : null;
    const cell = (label, val, st) => `<div class="smb-rc st-${st || 'none'}"><small>${label}</small><b>${val}</b></div>`;
    out.className = 'smb-result st-' + v.status;
    out.innerHTML = `
      <div class="smb-rgrid">
        ${cell('FLA', fla > 0 ? fmt(fla) + ' A' : '—')}
        ${cell('Iz', row && row.iz_derated_a != null ? fmt(row.iz_derated_a) + ' A' : '—',
          row ? DBSchedule._worstStatus(row.ampacity_status, row.coordination_status) : 'none')}
        ${cell('Volt drop', vd != null ? fmt(vd, 2) + ' %' : '—', row ? row.vd_status : 'none')}
        ${cell('ECC', row ? ((row.ecc_assumed_mm2 ?? row.ecc_required_mm2) != null ? (c.ecc_mm2 > 0 ? c.ecc_mm2 : (row.ecc_assumed_mm2 ?? row.ecc_required_mm2) + ' min') + ' mm²' : '—') : '—', row ? row.ecc_status : 'none')}
      </div>
      <p class="smb-why">${row
        ? (v.reason ? this._e(v.reason) : (v.status === 'pass' ? 'This way passes every check.' : ''))
        : 'Not checked yet — run <b>⋯ › Check circuits</b>.'}</p>
      ${row ? '<button class="btn-small" data-sh="calc">How was this calculated?</button>' : ''}`;
    const cs = document.getElementById('smb-conduit');
    if (cs) {
      Conduit.syncGroups(comp.props.circuits);
      const r = Conduit.evaluate(comp.props.circuits).get(c.id);
      cs.textContent = (r && r.status !== 'none')
        ? `${r.n} cable${r.n === 1 ? '' : 's'} · fill ${r.fillPct.toFixed(1)} % — ${Conduit.statusLabel(r)}`
        : '';
    }
  },

  // ── Events ────────────────────────────────────────────────────────
  _click(e) {
    const f = e.target.closest('[data-smb-filter]');
    if (f) { this._filter = f.dataset.smbFilter; this._renderFilters(); this._renderList(); return; }
    const pick = e.target.closest('[data-smb-pick]');
    if (pick) {
      const id = pick.dataset.smbPick;
      if (this._sel.has(id)) this._sel.delete(id); else this._sel.add(id);
      this._renderList(); this._renderBar();
      return;
    }
    const card = e.target.closest('[data-smb-way]');
    if (card) { this.openSheet(card.dataset.smbWay); return; }
    const b = e.target.closest('[data-smb]');
    if (!b) return;
    const a = b.dataset.smb;
    if (a === 'add-way') this.addWay();
    else if (a === 'add-load') this._loadMenu(b);
    else if (a === 'more') this._moreMenu(b);
    else if (a === 'sections') this.openSections();
    else if (a === 'controls') this.openControls();
    else if (a === 'select') { this._selecting = true; this._sel.clear(); this._renderList(); this._renderBar(); }
    else if (a === 'sel-cancel') this._endSelect();
    else if (a === 'sel-new') {
      const comp = this.comp();
      const ways = this._selWays();
      if (!ways.length) return;
      const k = DBControls.newContactor(comp, ways);
      this._endSelect();
      DBControls.edit(comp, k, { isNew: true, ways: ways.map(w => w.id) });
    } else if (a === 'sel-add') {
      const comp = this.comp();
      this._menu(b, DBControls.contactors(comp).map(k => ({
        label: `${k.tag}${k.label ? ' · ' + k.label : ''}`,
        sub: `${k.poles} ${k.rating_a} A · ${DBControls.waysOf(comp, k).length} way(s)`,
        run: () => { DBControls.assign(comp, k, this._selWays()); this._touch(); this._endSelect(); this.render(); },
      })));
    } else if (a === 'sel-off') {
      DBControls.unassign(this._selWays());
      this._touch();
      this._endSelect();
      this.render();
    }
  },

  _sheetClick(e) {
    const b = e.target.closest('[data-sh]');
    if (!b) return;
    const comp = this.comp();
    const ways = comp ? comp.props.circuits : [];
    const c = this._way(this._sheetId);
    const a = b.dataset.sh;
    if (a === 'close') { this.closeSheet(); this.render(); return; }
    if (!c) return;
    const i = ways.indexOf(c);
    if (a === 'prev' && i > 0) { this._sheetId = ways[i - 1].id; this._renderSheet(); }
    else if (a === 'next' && i < ways.length - 1) { this._sheetId = ways[i + 1].id; this._renderSheet(); }
    else if (a === 'dup') {
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = DBSchedule._wayId();
      // Plan-sync bookkeeping belongs to the original way, not the copy.
      ['plan_qty', '_manualLoadOverride', '_cableManual', '_nameOverride', '_polesManual', '_orphaned']
        .forEach(k => delete copy[k]);
      if (DBSections.has(comp)) {
        copy.way = DBSections.nextWayNumber(comp, DBSections.of(comp, c));
      } else {
        let n = ways.length + 1;
        while (ways.some(w => String(w.way) === String(n))) n++;
        copy.way = String(n);
      }
      ways.splice(i + 1, 0, copy);
      this._touch();
      this._sheetId = copy.id;
      this.render();
      this._renderSheet();
    } else if (a === 'del') {
      if (typeof UI !== 'undefined' && UI.confirm) {
        UI.confirm(`Delete way ${c.way}${c.description ? ' — ' + c.description : ''}?`).then((ok) => { if (ok) this._deleteWay(c); });
      } else if (window.confirm(`Delete way ${c.way}?`)) this._deleteWay(c);
    } else if (a === 'unpin') {
      DBSchedule._unpinWay(comp, c);
      this._touch();
      this.render();
      this._renderSheet();
    } else if (a === 'calc') {
      DBSchedule.showCalc(c.id);
    } else if (a === 'ctl-edit') {
      const k = DBControls.wayContactor(comp, c);
      if (k) DBControls.edit(comp, k, {});
    } else if (a === 'mtr-edit') {
      const m = DBMeters.wayMeter(comp, c);
      if (m) DBMeters.edit(comp, m, {});
    } else if (a === 'ctl-off') {
      DBSchedule._setWayField(comp, c, 'contactor', '');
      this._touch();
      this.render();
      this._renderSheet();
    }
  },

  _deleteWay(c) {
    const comp = this.comp(); if (!comp) return;
    const ways = comp.props.circuits;
    const i = ways.indexOf(c);
    if (i < 0) return;
    ways.splice(i, 1);
    this._touch();
    this.closeSheet();
    this.render();
  },

  _sheetChange(e) {
    const t = e.target;
    const k = t.dataset && t.dataset.k;
    const comp = this.comp();
    const c = this._way(this._sheetId);
    if (!k || !comp || !c) return;
    const typed = t.value;
    const out = DBSchedule._setWayField(comp, c, k, typed);
    if (out === 'duplicate') {
      t.value = c.way;
      if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Way ${String(typed).trim()} already exists on this board.`, 'warning');
      return;
    }
    this._touch();
    this.render();
    // Poles flips the phase select, a load type fills several fields, and a
    // conduit edit can change the whole group — rebuild the form for those.
    if (out === 'render' || out === 'conduit' || k === 'description') this._renderSheet();
    else this._refreshSheetResults();
  },

  // ── Menus ─────────────────────────────────────────────────────────
  _closeMenu() {
    const m = document.getElementById('smb-menu');
    if (m) m.remove();
  },

  _menu(anchor, items) {
    this._closeMenu();
    const m = document.createElement('div');
    m.id = 'smb-menu';
    m.className = 'smb-menu';
    m.innerHTML = items.map((it, i) => it.label
      ? `<button data-i="${i}" class="smb-menu-item">${this._e(it.label)}${it.sub ? `<small>${this._e(it.sub)}</small>` : ''}</button>`
      : '<hr>').join('');
    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b) return;
      this._closeMenu();
      items[Number(b.dataset.i)].run();
    });
    document.getElementById('schedules-workspace').appendChild(m);
    // Dismiss on any outside tap.
    setTimeout(() => {
      const off = (ev) => { if (!m.contains(ev.target)) { this._closeMenu(); document.removeEventListener('pointerdown', off, true); } };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  },

  _loadMenu(anchor) {
    const types = (typeof DB_LOAD_TYPES !== 'undefined' ? DB_LOAD_TYPES : []);
    this._menu(anchor, types.map(t => ({
      label: t.label,
      sub: t.va ? `${t.va} VA/${t.unit} · ${t.breaker_a} A ${t.curve}` : '',
      run: () => {
        const n = t.per_circuit || 1;
        DBSchedule.addLoad(t.key, n, 1);
        this.render();
      },
    })));
  },

  _moreMenu(anchor) {
    const comp = this.comp();
    this._menu(anchor, [
      { label: 'Board sections (Normal / Essential / UPS)…', run: () => this.openSections() },
      { label: 'Controls (contactors, supplies)…', run: () => this.openControls() },
      {},
      { label: 'Check circuits', run: () => Schedules.runCheck(true) },
      { label: 'Auto balance phases', run: () => { DBSchedule.autoBalance(comp); this._touch(); this.render(); } },
      { label: 'Fill missing ECC', run: () => { DBSchedule.fillEcc(comp); this._touch(); this.render(); } },
      { label: 'Size cables…', run: () => CableSize.open(comp) },
      { label: 'Set manufacturer…', run: () => BreakerSet.open(comp) },
      {},
      { label: 'Export Excel', run: () => DBSchedule.exportXlsx(comp) },
      { label: 'Import Excel…', run: () => this._importPick(comp) },
    ]);
  },

  _importPick(comp) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx,.xls,.csv';
    inp.onchange = () => {
      if (!inp.files[0]) return;
      DBSchedule.importXlsx(comp, inp.files[0]);
      // The import is async and re-renders the (detached) grid; refresh ours after.
      setTimeout(() => this.render(), 800);
    };
    inp.click();
  },
};
