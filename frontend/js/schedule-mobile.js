/* ProtectionPro — phone layout of the circuit schedule.
 *
 * The Schedules grid is 30+ columns wide, which on a phone degrades to one
 * 1,000 px card per way. Under 768 px the workspace shows this instead:
 *   · a one-line board summary (kVA, phase split, check counts) + filter chips,
 *   · one compact card per way (title row + one summary line + the reason a
 *     way is flagged),
 *   · a bottom edit SHEET for one way, its fields in small groups, with
 *     Prev / Next / Duplicate / Delete,
 *   · a sticky action bar (+ Way, Add load, ⋯ more).
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
        <div class="smb-bar">
          <button class="btn-small btn-primary" data-smb="add-way">+ Way</button>
          <button class="btn-small" data-smb="add-load">Add load</button>
          <button class="btn-small" data-smb="more" aria-haspopup="menu">⋯</button>
        </div>
      </div>`;
    host.onclick = (e) => this._click(e);
    host.oninput = (e) => {
      if (e.target.id === 'smb-q') { this._query = e.target.value; this._renderList(); }
    };
    this.render();
  },

  unmount() {
    this.closeSheet();
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
        || pick(row.ampacity_status, row.coordination_message)
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
    if (this._sheetId) this._refreshSheetResults();
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
      chip('all', 'All') + chip('fail', 'Issues') + chip('R', 'R') + chip('W', 'W') + chip('B', 'B');
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
      cards.push(`
        <button class="smb-card st-${v.status}" data-smb-way="${this._e(c.id)}" aria-label="Edit way ${this._e(c.way)}">
          <span class="smb-no">${this._e(c.way ?? i + 1)}</span>
          <span class="smb-main">
            <span class="smb-title">${this._e(c.description || 'Unnamed way')}</span>
            <span class="smb-meta">${this._e(c.breaker_a ?? '—')} A ${this._e(c.curve || '')} · ${this._e(this._phaseLabel(c))}${cable ? ' · ' + this._e(cable) : ''} · ${kva.toFixed(2)} kVA</span>
            ${v.reason ? `<span class="smb-reason">${this._e(v.reason)}</span>` : ''}
          </span>
          <span class="smb-dot st-${v.status}" aria-hidden="true"></span>
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
    const w = DBSchedule.newWay(comp.props.circuits.length);
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
      document.getElementById('schedules-workspace').appendChild(sheet);
      sheet.addEventListener('click', (e) => this._sheetClick(e));
      sheet.addEventListener('change', (e) => this._sheetChange(e));
    }
    this._renderSheet();
    sheet.classList.add('open');
    const body = sheet.querySelector('.smb-sheet-body');
    if (body) body.scrollTop = 0;
  },

  closeSheet() {
    this._sheetId = null;
    const sheet = document.getElementById('smb-sheet');
    if (sheet) sheet.classList.remove('open');
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
        <strong>Way ${e(c.way)}</strong>
        <span class="smb-sheet-of">${idx + 1} / ${ways.length}</span>
        <button class="btn-small" data-sh="next" ${idx >= ways.length - 1 ? 'disabled' : ''} aria-label="Next way">›</button>
        <button class="btn-small btn-primary smb-done" data-sh="close">Done</button>
      </div>
      <div class="smb-sheet-body">
        <div class="smb-result" id="smb-result"></div>
        <section><h4>Circuit</h4>
          <label class="smb-f"><span>Way no.</span><input type="text" data-k="way" value="${e(c.way)}"></label>
          <label class="smb-f"><span>Description</span>
            <input type="text" data-k="description" list="smb-loads" value="${e(c.description || '')}"></label>
          <datalist id="smb-loads">${loads.map(t => `<option value="${e(t.label)}">`).join('')}</datalist>
          ${pins.length ? `<p class="smb-pin">📌 Pinned: ${e(pins.join(', '))} — protected from the plan sync.
            <button class="btn-small" data-sh="unpin">Unpin</button></p>` : ''}
        </section>
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
    const card = e.target.closest('[data-smb-way]');
    if (card) { this.openSheet(card.dataset.smbWay); return; }
    const b = e.target.closest('[data-smb]');
    if (!b) return;
    const a = b.dataset.smb;
    if (a === 'add-way') this.addWay();
    else if (a === 'add-load') this._loadMenu(b);
    else if (a === 'more') this._moreMenu(b);
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
      let n = ways.length + 1;
      while (ways.some(w => String(w.way) === String(n))) n++;
      copy.way = String(n);
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
      { label: 'Check circuits', run: () => Schedules.runCheck(true) },
      { label: 'Auto balance phases', run: () => { DBSchedule.autoBalance(comp); this._touch(); this.render(); } },
      { label: 'Fill missing ECC', run: () => { DBSchedule.fillEcc(comp); this._touch(); this.render(); } },
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
