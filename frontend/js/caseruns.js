/* ProtectionPro — the Study Manager on cases.
 *
 * Tick studies (the Study Manager's list) and cases (here); Run runs each study
 * on each case. The live network is the case "Current": its results are the
 * project's own, shown on the diagram and in the Results panel as ever. A saved
 * case's results are kept for the session in `results[caseId]`, stamped with the
 * case's network so an edit to the case marks them out of date. The grid shows
 * every study on every ticked case; a cell opens that result.
 *
 * `status` and `cell` are pure given a result summary (node-testable).
 */

const CaseRuns = {
  CURRENT: '__current__',
  selected: new Set(['__current__']),
  results: {},          // caseId → { sig, at, studies: { key: { status, summary, store, error } } }

  // Study Manager key → [AppState slot, field of the study's result] for the result stores.
  SLOT: {
    fault: 'faultResults', loadflow: 'loadFlowResults', arcflash: 'arcFlashResults', dc_arcflash: 'dcArcFlashResults',
    cable_sizing: 'cableSizingResults', motor_starting: 'motorStartingResults', dynamic_motor_starting: 'dynamicMotorResults',
    transient_stability: 'stabilityResults', duty_check: 'dutyCheckResults', load_diversity: 'loadDiversityResults', grounding: 'groundingResults',
  },
  KEYS: ['loadflow', 'fault', 'arcflash', 'cable_sizing', 'motor_starting', 'dynamic_motor_starting', 'transient_stability', 'duty_check', 'load_diversity', 'grounding'],
  LABEL: { loadflow: 'Load flow', fault: 'Short circuit', arcflash: 'Arc flash', cable_sizing: 'Cable sizing', motor_starting: 'Motor starting',
    dynamic_motor_starting: 'Dynamic motor starting', transient_stability: 'Transient stability', duty_check: 'Duty check', load_diversity: 'Load diversity', grounding: 'Grounding' },

  // ── Pure ──
  // One cell's state from a study's server status: { state: none | ok | warn | fail | error | stale, text }.
  cell(s) {
    if (!s) return { state: 'none', text: 'Not run' };
    if (s.stale) return { state: 'stale', text: 'Out of date' };
    if (s.status === 'error') return { state: 'error', text: 'Error' };
    if (s.status === 'fail') return { state: 'fail', text: s.fail ? `${s.fail} fail` : 'Fails' };
    if (s.status === 'warning' || s.status === 'warn') return { state: 'warn', text: s.warn ? `${s.warn} warning${s.warn === 1 ? '' : 's'}` : 'Warnings' };
    return { state: 'ok', text: 'All clear' };
  },

  // Line up the rows of one study across cases. `models` = [{ id, name, model }]
  // (a Results panel model each, or null where the study has no result there).
  // Returns [{ key, section, name, cells: [{status, text} | null], differs }] — a row
  // differs when any case's status or values differ, or it is missing from one.
  compareRows(models) {
    const order = [], seen = new Map();
    models.forEach((m, i) => {
      for (const sec of (m.model && m.model.sections) || []) {
        for (const r of sec.rows || []) {
          const key = (sec.id || sec.title || '') + '|' + r.id;
          if (!seen.has(key)) { seen.set(key, { key, section: sec.title || '', name: r.name, cells: models.map(() => null) }); order.push(key); }
          const cols = sec.cols || [];
          const text = cols.slice(0, 4).map(c => { const v = r.cells && r.cells[c.key]; return v ? (v.t != null ? v.t : v.v) : ''; }).filter(x => x !== '' && x != null).join(' · ');
          seen.get(key).cells[i] = { status: r.status || '', text: String(text) };
        }
      }
    });
    return order.map(k => {
      const row = seen.get(k);
      // only cases that have a result for the study count (one not run yet does not make every row differ)
      const have = row.cells.filter((c, i) => models[i].model).map(c => (c ? JSON.stringify(c) : null));
      row.differs = have.some(x => x !== have[0]);
      return row;
    });
  },

  // ── Cases ──
  currentOn() { return this.selected.has(this.CURRENT); },
  selectedCases() { return AppState.cases.filter(c => this.selected.has(c.id)); },
  sigOf(c) { return AppState._hashText ? AppState._hashText(JSON.stringify([c.components, c.wires, c.baseMVA, c.loadFlowMethod])) : ''; },
  entry(c) { const r = this.results[c.id]; return r ? r : null; },
  isStale(c) { const r = this.entry(c); return !!(r && r.sig !== this.sigOf(c)); },

  // What the grid shows for a study on a case.
  state(key, id) {
    if (id === this.CURRENT) {
      const rp = typeof AnalyseMenu !== 'undefined' ? AnalyseMenu.MANAGER[key] : null;
      const st = typeof AnalyseMenu !== 'undefined' && rp ? AnalyseMenu.status(AnalyseMenu._read(rp)) : { state: 'none', text: 'Not run' };
      const t = st.text.replace(/^Ran .* · /, '');
      return { state: st.state, text: t.charAt(0).toUpperCase() + t.slice(1) };
    }
    const c = AppState.cases.find(x => x.id === id);
    const e = c && this.entry(c);
    const s = e && e.studies[key];
    return this.cell(s ? { ...s, stale: this.isStale(c) } : null);
  },

  // Does a study need running on any ticked case (not run, or out of date)?
  needs(key) {
    const ids = [...this.selected].filter(id => id === this.CURRENT || AppState.cases.some(c => c.id === id));
    return ids.some(id => { const st = this.state(key, id).state; return st === 'none' || st === 'stale' || st === 'error'; });
  },

  // ── Running ──
  async runCases(cases, enabled, statusEl) {
    const base = AppState.toJSON();
    let i = 0;
    for (const c of cases) {
      i++;
      if (statusEl) statusEl.textContent = `Running ${enabled.length} studies on “${c.name}” (${i} of ${cases.length})…`;
      const sig = this.sigOf(c);
      let res;
      try { res = await API.runStudyManager(enabled, Cases.project(base, c)); }
      catch (e) { res = { studies: Object.fromEntries(enabled.map(k => [k, { status: 'error', error: e.message }])) }; }
      const prev = (this.results[c.id] && this.results[c.id].sig === sig) ? this.results[c.id].studies : {};
      const studies = { ...prev };
      for (const [k, s] of Object.entries(res.studies || {})) {
        const store = s.result ? { [this.SLOT[k]]: s.result } : {};
        studies[k] = { status: s.status, error: s.error, store, ...this._counts(k, store) };
      }
      this.results[c.id] = { sig, at: Date.now(), studies };
    }
  },
  _counts(key, store) {
    const rp = typeof AnalyseMenu !== 'undefined' ? AnalyseMenu.MANAGER[key] : null;
    if (!rp || typeof ResultsPanel === 'undefined' || !Object.keys(store).length) return { fail: 0, warn: 0 };
    try { const n = ResultsPanel.counts(this.modelFor(key, store)); return { fail: n.fail || 0, warn: n.warn || 0 }; } catch (e) { return { fail: 0, warn: 0 }; }
  },

  // The Results panel's model of a study, for a result that is not the live one:
  // swap the result store for the duration (bypassing the setters), then put it back.
  modelFor(key, store) {
    const rp = AnalyseMenu.MANAGER[key];
    const keep = AppState._results;
    AppState._results = { ...store };
    try { return ResultsPanel.model(rp); } finally { AppState._results = keep; }
  },

  // ── The Study Manager's case picker and grid ──
  render() {
    const host = document.getElementById('sm-cases');
    if (!host) return;
    const cases = AppState.cases;
    const alive = new Set([this.CURRENT, ...cases.map(c => c.id)]);
    for (const id of [...this.selected]) if (!alive.has(id)) this.selected.delete(id);
    if (!this.selected.size) this.selected.add(this.CURRENT);
    const box = (id, name) => `<label class="sm-case"><input type="checkbox" data-sm-case="${escHtml(id)}"${this.selected.has(id) ? ' checked' : ''}> ${escHtml(name)}</label>`;
    host.innerHTML = `<div class="sm-cases-head">Run on</div><div class="sm-cases-list">${box(this.CURRENT, 'Current network')}${cases.map(c => box(c.id, c.name)).join('')}</div>`
      + (cases.length ? '' : '<div class="sm-cases-none">Save a case (Cases menu) to run studies on other versions of the network.</div>');
    this._grid();
  },

  _grid() {
    const host = document.getElementById('sm-grid');
    if (!host) return;
    const ids = [this.CURRENT, ...AppState.cases.map(c => c.id)].filter(id => this.selected.has(id));
    if (ids.length < 2) { host.innerHTML = ''; return; }
    const name = (id) => id === this.CURRENT ? 'Current' : (AppState.cases.find(c => c.id === id) || {}).name;
    host.innerHTML = `<table class="sm-grid"><thead><tr><th>Study</th>${ids.map(id => `<th>${escHtml(name(id))}</th>`).join('')}</tr></thead><tbody>`
      + this.KEYS.map(k => `<tr><td>${escHtml(this.LABEL[k])} <button type="button" class="sm-cmp" data-sm-cmp="${escHtml(k)}" title="Line up this study's rows across the cases">Compare</button></td>${ids.map(id => {
        const st = this.state(k, id);
        const open = st.state !== 'none';
        return `<td class="sm-cell sm-${escHtml(st.state)}">${open ? `<button type="button" data-sm-open="${escHtml(k)}" data-sm-id="${escHtml(id)}">${escHtml(st.text)}</button>` : escHtml(st.text)}</td>`;
      }).join('')}</tr>`).join('') + '</tbody></table>';
  },

  // One study side by side on every ticked case that has a result for it.
  compare(key, onlyDiff = true) {
    const ids = [this.CURRENT, ...AppState.cases.map(c => c.id)].filter(id => this.selected.has(id));
    const models = [];
    for (const id of ids) {
      if (id === this.CURRENT) { const rp = AnalyseMenu.MANAGER[key]; models.push({ id, name: 'Current', model: ResultsPanel.has(rp) ? ResultsPanel.model(rp) : null }); continue; }
      const c = AppState.cases.find(x => x.id === id), e = this.results[id] && this.results[id].studies[key];
      models.push({ id, name: c.name + (this.isStale(c) ? ' (out of date)' : ''), model: e ? this.modelFor(key, e.store) : null });
    }
    const rows = this.compareRows(models);
    const shown = onlyDiff ? rows.filter(r => r.differs) : rows;
    const dot = { fail: '#c62828', warn: '#b26a00', ok: '#2e7d32' };
    const body = `<label style="font-size:12px"><input type="checkbox" id="sm-cmp-only"${onlyDiff ? ' checked' : ''}> Only rows that differ</label>
      <p style="font-size:12px;margin:6px 0">${rows.filter(r => r.differs).length} of ${rows.length} rows differ.</p>
      <div class="cm-scroll"><table class="cm-diff"><thead><tr><th>Item</th><th>Section</th>${models.map(m => `<th>${escHtml(m.name)}${m.model ? '' : ' — not run'}</th>`).join('')}</tr></thead><tbody>`
      + (shown.slice(0, 500).map(r => `<tr${r.differs ? ' style="background:var(--accent-soft,#eef4ff)"' : ''}><td>${escHtml(r.name)}</td><td>${escHtml(r.section)}</td>${r.cells.map(c => c
        ? `<td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${dot[c.status] || '#999'}"></span>${escHtml(c.text)}</td>` : '<td>—</td>').join('')}</tr>`).join('')
        || `<tr><td colspan="${models.length + 2}">${rows.length ? 'No row differs.' : 'No rows.'}</td></tr>`)
      + '</tbody></table></div>';
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = `${this.LABEL[key]} on ${models.length} cases`;
    modal.querySelector('#calc-modal-body').innerHTML = body;
    modal.style.zIndex = 2000;   // over the Study Manager it was opened from
    modal.style.display = '';
    document.getElementById('sm-cmp-only').addEventListener('change', (e) => this.compare(key, e.target.checked));
  },

  // A case's result for one study, read only.
  _show(key, id) {
    if (id === this.CURRENT) {
      const m = document.getElementById('study-manager-modal'); if (m) m.style.display = 'none';
      if (typeof ResultsPanel !== 'undefined') ResultsPanel.open(AnalyseMenu.MANAGER[key]);
      return;
    }
    const e = this.results[id] && this.results[id].studies[key];
    if (!e) return;
    const m = this.modelFor(key, e.store);
    const c = AppState.cases.find(x => x.id === id);
    const body = (m && m.sections ? m.sections : []).filter(s => s.rows && s.rows.length).map(s => {
      const cols = s.cols || [];
      return `<h4 style="margin:12px 0 4px">${escHtml(s.title || '')}</h4><div class="cm-scroll"><table class="cm-diff"><thead><tr><th>${escHtml(s.nameLabel || 'Item')}</th>${cols.map(k => `<th>${escHtml(k.label)}</th>`).join('')}<th>Status</th></tr></thead><tbody>`
        + s.rows.slice(0, 300).map(r => `<tr><td>${escHtml(r.name)}</td>${cols.map(k => `<td>${escHtml(r.cells && r.cells[k.key] ? (r.cells[k.key].t != null ? r.cells[k.key].t : r.cells[k.key].v) : '')}</td>`).join('')}<td>${escHtml(r.status || '')}</td></tr>`).join('')
        + '</tbody></table></div>';
    }).join('') || '<p>No rows.</p>';
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = `${this.LABEL[key]} — ${c ? c.name : ''}${this.isStale(c) ? ' (out of date)' : ''}`;
    modal.querySelector('#calc-modal-body').innerHTML = body;
    modal.style.zIndex = 2000;
    modal.style.display = '';
  },

  init() {
    const host = document.getElementById('study-manager-config');
    if (!host || document.getElementById('sm-cases')) return;
    const checks = document.getElementById('study-manager-checks');
    const cases = document.createElement('div'); cases.id = 'sm-cases'; cases.className = 'sm-cases';
    checks.insertAdjacentElement('afterend', cases);
    const grid = document.createElement('div'); grid.id = 'sm-grid'; grid.className = 'sm-grid-wrap';
    host.appendChild(grid);
    host.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-sm-case]');
      if (!cb) return;
      if (cb.checked) this.selected.add(cb.dataset.smCase); else this.selected.delete(cb.dataset.smCase);
      if (!this.selected.size) this.selected.add(this.CURRENT);
      this.render();
      if (typeof AnalyseMenu !== 'undefined') AnalyseMenu.syncManager();
    });
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sm-open]');
      if (b) this._show(b.dataset.smOpen, b.dataset.smId);
      const c = e.target.closest('[data-sm-cmp]');
      if (c) this.compare(c.dataset.smCmp);
    });
    document.getElementById('btn-study-manager')?.addEventListener('click', () => { this.render(); if (typeof AnalyseMenu !== 'undefined') AnalyseMenu.syncManager(); });
  },
};
