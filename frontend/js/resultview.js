/* ProtectionPro — Results view switch on the single line (UX plan PR 11).
 *
 * One strip of chips over the diagram picks which study's result boxes are
 * drawn: Off · Load flow · Short circuit · Arc flash · … · Values ▾.
 *  · only studies that have results get a chip;
 *  · a chip shows that study alone; Shift-click (or Ctrl / ⌘) adds or takes
 *    away a study, so two can be read together;
 *  · each chip has a dot worked out from the result: red something fails,
 *    amber warnings, green all clear, grey information only; an out-of-date
 *    result's chip is dimmed;
 *  · a study that finishes running becomes the view (not a re-run of an
 *    out-of-date study, and not a project being opened);
 *  · Values ▾ picks the value lines in the boxes of the studies on screen
 *    (RESULT_TYPE_DEFS), plus that study's display options (flow arrows,
 *    cables at the selected bus), Restore hidden boxes and Reset positions;
 *  · H switches between Off and the last view.
 *
 * What is shown is AppState.showResultBoxes and AppState.resultBoxFields —
 * the fields the Results-menu toggles and Project details used, so a saved
 * project opens showing what it showed before. This replaces both.
 */

const ResultView = {
  // Chip order. `key` = the showResultBoxes / RESULT_TYPE_DEFS key; `slots` =
  // the result slots that give it boxes; `has()` overrides for boxes drawn
  // from something else (Demand's info on its minisub stacks).
  STUDIES: [
    { key: 'loadflow', label: 'Load flow', slots: ['loadFlowResults'] },
    { key: 'unbalancedLF', label: 'Unbalanced LF', slots: ['unbalancedLoadFlowResults'] },
    { key: 'fault', label: 'Short circuit', slots: ['faultResults'] },
    { key: 'arcflash', label: 'Arc flash', slots: ['arcFlashResults', 'dcArcFlashResults'] },
    { key: 'cable', label: 'Cable sizing', slots: ['cableSizingResults'] },
    { key: 'duty', label: 'Duty check', slots: ['dutyCheckResults'] },
    { key: 'motor', label: 'Motor starting', slots: ['motorStartingResults'] },
    { key: 'dynMotor', label: 'Dynamic motor', slots: ['dynamicMotorResults'] },
    { key: 'loadDiversity', label: 'Load diversity', slots: ['loadDiversityResults'] },
    { key: 'grounding', label: 'Grounding', slots: ['groundingResults'] },
    { key: 'dcLoadflow', label: 'DC load flow', slots: ['dcLoadFlowResults'] },
    { key: 'dcShortCircuit', label: 'DC short circuit', slots: ['dcShortCircuitResults'] },
    { key: 'retic', label: 'Demand', slots: [],
      has: () => { for (const c of AppState.components.values()) if (c.reticRole === 'tx' && c.reticInfo) return true; return false; } },
  ],

  study(key) { return this.STUDIES.find(s => s.key === key) || null; },
  studyForSlot(slot) { return this.STUDIES.find(s => s.slots.includes(slot)) || null; },

  has(s) { return s.has ? s.has() : s.slots.some(sl => AppState[sl] != null); },
  // Studies with something to show, in chip order.
  available() { return this.STUDIES.filter(s => this.has(s)); },
  isOn(key) { return !!(AppState.showResultBoxes && AppState.showResultBoxes[key]); },
  // The studies on screen (with results).
  current() { return this.available().filter(s => this.isOn(s.key)).map(s => s.key); },

  // ── Verdicts ─────────────────────────────────────────────────────────
  // 'fail' | 'warn' | 'ok' | 'info' for one study, from its results.
  // Cached per result object (a result is replaced, never edited in place).
  _vcache: new WeakMap(),
  verdict(key) {
    const s = this.study(key);
    if (!s) return 'info';
    if (s.has) return this._judge(key, null);
    const rank = { fail: 3, warn: 2, ok: 1, info: 0 };
    let best = null;
    for (const slot of s.slots) {
      const r = AppState[slot];
      if (r == null) continue;
      let v = (typeof r === 'object') ? this._vcache.get(r) : undefined;
      if (!v) {
        try { v = this._judge(key, r, slot); } catch (e) { v = 'info'; }
        if (typeof r === 'object') this._vcache.set(r, v);
      }
      if (!best || rank[v] > rank[best]) best = v;
    }
    return best || 'info';
  },

  _worst(list, fn) {
    let w = 'ok';
    for (const x of list || []) {
      const v = fn(x);
      if (v === 'fail') return 'fail';
      if (v === 'warn') w = 'warn';
    }
    return w;
  },
  _status(x) { return x && x.status === 'fail' ? 'fail' : (x && (x.status === 'warning' || x.status === 'warn') ? 'warn' : 'ok'); },

  _judge(key, r, slot) {
    switch (key) {
      case 'loadflow': {
        if (r.converged === false || (r.solution_quality && r.solution_quality !== 'ok')) return 'fail';
        let v = 'ok';
        for (const b of Object.values(r.buses || {})) {
          if (b.energized === false) { v = 'warn'; continue; }
          const d = Math.abs((b.voltage_pu ?? 1) - 1);
          if (d > 0.10) return 'fail';
          if (d > 0.05) v = 'warn';
        }
        for (const br of r.branches || []) {
          if ((br.loading_pct || 0) > 100) return 'fail';
          if ((br.loading_pct || 0) > 90) v = 'warn';
        }
        if ((r.warnings || []).length) v = 'warn';
        return v;
      }
      case 'unbalancedLF': {
        let v = 'ok';
        for (const b of Object.values(r.buses || {})) {
          const lim = typeof vufLimitPct === 'function' ? vufLimitPct(b.voltage_kv) : 2;
          if (b.vuf_pct > lim) return 'fail';
          if (b.vuf_pct > 1) v = 'warn';
        }
        if (r.converged === false) return 'fail';
        if ((r.warnings || []).length) v = 'warn';
        return v;
      }
      case 'fault':
      case 'dcShortCircuit':
        return 'info';
      case 'arcflash':
        // Above 40 cal/cm² no PPE category applies; Cat 3–4 is heavy PPE.
        return this._worst(Object.values(r.buses || {}), b =>
          b.ppe_category === -1 ? 'fail' : (b.ppe_category >= 3 ? 'warn' : 'ok'));
      case 'cable':
        return this._worst(r.cables, c => c.status === 'fail' ? 'fail' : (c.status === 'warning' || c.status === 'unknown' ? 'warn' : 'ok'));
      case 'duty':
        return this._worst(r.devices, d => this._status(d));
      case 'motor':
      case 'dynMotor':
        return this._worst((r.motors || []).filter(m => m.status !== 'not_simulated'), m => this._status(m));
      case 'grounding':
        return this._worst(Object.values(r.buses || {}), b => this._status(b));
      case 'loadDiversity':
        return 'info';
      case 'dcLoadflow': {
        if (r.converged === false) return 'fail';
        return this._worst(r.branches, b => (b.loading_pct || 0) > 100 ? 'fail' : ((b.loading_pct || 0) > 90 ? 'warn' : 'ok'));
      }
      case 'retic': {
        let v = 'ok';
        for (const c of AppState.components.values()) {
          const i = c.reticRole === 'tx' && c.reticInfo;
          if (i && i.worstVD != null && i.vdLimit != null && i.worstVD > i.vdLimit) v = 'warn';
        }
        return v;
      }
    }
    return 'info';
  },

  isStale(key) {
    const s = this.study(key);
    return !!s && typeof StaleResults !== 'undefined' && s.slots.some(sl => AppState[sl] != null && StaleResults.isStale(sl));
  },

  // ── Changing the view ────────────────────────────────────────────────
  _last: null,       // the view before Off, for H
  _set(keys) {
    const want = new Set(keys);
    for (const s of this.STUDIES) AppState.showResultBoxes[s.key] = want.has(s.key);
    if (keys.length) this._last = [...keys];
    if (typeof ResultsPanel !== 'undefined') ResultsPanel.follow(keys);
    if (!want.has('cable') && typeof CableFocus !== 'undefined' && CableFocus.active) CableFocus.disable();
    this._redraw();
  },
  // Show one study alone; with `add`, add it to / take it from the view.
  show(key, add) {
    if (key === 'off' || !key) { this.off(); return; }
    if (!add) { this._set([key]); return; }
    const cur = this.current();
    this._set(cur.includes(key) ? cur.filter(k => k !== key) : cur.concat(key));
  },
  toggle(key) { this.show(key, true); },
  off() {
    const cur = this.current();
    if (cur.length) this._last = cur;
    for (const s of this.STUDIES) AppState.showResultBoxes[s.key] = false;
    this._closeValues();
    this._redraw();
  },
  // H: Off ⇄ the last view (or every study when there is none).
  toggleAll() {
    if (this.current().length) { this.off(); return false; }
    const avail = this.available().map(s => s.key);
    const last = (this._last || []).filter(k => avail.includes(k));
    this._set(last.length ? last : avail);
    return true;
  },

  // A study finished: show it. Results set together in one task (Run all,
  // Study Manager) show the last of them; a re-run of out-of-date studies and
  // results loaded with a project leave the view as it is.
  _arrived: [],
  onResult(slot) {
    if (typeof StaleResults !== 'undefined' && StaleResults._busy) return;
    const s = this.studyForSlot(slot);
    if (!s) return;
    this._arrived.push(s.key);
    if (this._arrived.length > 1) return;
    setTimeout(() => {
      const k = this._arrived[this._arrived.length - 1];
      this._arrived = [];
      if (k && AppState.showResultBoxes) this._set([k]);
    }, 0);
  },

  _redraw() {
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    else this.render();
  },

  // ── The strip ────────────────────────────────────────────────────────
  _html: '',
  _el: null,
  render() {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('canvas-container');
    if (!host) return;
    const avail = this.available();
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.id = 'result-view';
      this._el.className = 'rv-strip';
      this._el.setAttribute('role', 'toolbar');
      this._el.setAttribute('aria-label', 'Results on the diagram');
      host.appendChild(this._el);
      this._el.addEventListener('click', (e) => this._onClick(e));
    }
    host.classList.toggle('has-rv', avail.length > 0);
    if (!avail.length) {
      this._el.hidden = true;
      this._closeValues();
      if (typeof Header !== 'undefined' && Header.syncResultsMenu) Header.syncResultsMenu();
      if (typeof ResultsPanel !== 'undefined') ResultsPanel.onCanvasRender();
      return;
    }
    const cur = new Set(this.current());
    const words = { fail: 'something fails', warn: 'warnings', ok: 'all clear', info: 'information only' };
    const chip = (s) => {
      const v = this.verdict(s.key);
      const stale = this.isStale(s.key);
      const tip = `${s.label}: ${words[v]}${stale ? ' — out of date after an edit' : ''}. Click to show it alone; Shift-click to add it.`;
      return `<button type="button" class="rv-chip${stale ? ' rv-stale' : ''}" data-rv="${escHtml(s.key)}" aria-pressed="${cur.has(s.key)}" title="${escHtml(tip)}">`
        + `<span class="rv-dot rv-${v}" aria-hidden="true"></span>${escHtml(s.label)}</button>`;
    };
    const html = `<button type="button" class="rv-chip rv-off" data-rv="off" aria-pressed="${cur.size === 0}" title="Plain diagram, no result boxes (H)">Off</button>`
      + avail.map(chip).join('')
      + `<span class="rv-sep" aria-hidden="true"></span><button type="button" class="rv-chip rv-values" data-rv-values aria-haspopup="dialog" aria-expanded="${!!this._pop}"${cur.size ? '' : ' disabled'} title="Which values the boxes show">Values ▾</button>`
      + (typeof ResultsPanel !== 'undefined' && ResultsPanel.available().length
        ? `<button type="button" class="rv-chip rv-table" data-rv-table aria-pressed="${ResultsPanel.isOpen()}" title="The results in tables, beside the diagram">▤ Table</button>` : '');
    this._el.hidden = false;
    if (html !== this._html) { this._el.innerHTML = html; this._html = html; }
    if (this._pop) {
      if (!cur.size) this._closeValues();
      else this._renderValues();
    }
    if (typeof Header !== 'undefined' && Header.syncResultsMenu) Header.syncResultsMenu();
    if (typeof ResultsPanel !== 'undefined') ResultsPanel.onCanvasRender();
  },

  _onClick(e) {
    if (e.target.closest('[data-rv-values]')) { this._pop ? this._closeValues() : this._openValues(); return; }
    if (e.target.closest('[data-rv-table]')) { ResultsPanel.toggle(); this._html = ''; this.render(); return; }
    const b = e.target.closest('[data-rv]');
    if (!b) return;
    this.show(b.dataset.rv, e.shiftKey || e.ctrlKey || e.metaKey);
  },

  // ── Values popover ───────────────────────────────────────────────────
  _pop: null,
  _openValues() {
    if (!this.current().length) return;
    const host = document.getElementById('canvas-container');
    this._pop = document.createElement('div');
    this._pop.id = 'result-values';
    this._pop.className = 'rv-pop';
    this._pop.setAttribute('role', 'dialog');
    this._pop.setAttribute('aria-label', 'Values in the result boxes');
    host.appendChild(this._pop);
    this._pop.addEventListener('change', (e) => this._onValueChange(e));
    this._pop.addEventListener('click', (e) => this._onValueClick(e));
    this._outside = (e) => {
      if (this._pop && !this._pop.contains(e.target) && !e.target.closest('#result-view')) this._closeValues();
    };
    this._esc = (e) => { if (e.key === 'Escape') this._closeValues(); };
    setTimeout(() => {
      document.addEventListener('pointerdown', this._outside, true);
      document.addEventListener('keydown', this._esc, true);
    }, 0);
    this._html = '';   // aria-expanded
    this.render();
  },
  _closeValues() {
    if (!this._pop) return;
    this._pop.remove();
    this._pop = null;
    document.removeEventListener('pointerdown', this._outside, true);
    document.removeEventListener('keydown', this._esc, true);
    this._html = '';
    this.render();
  },

  _renderValues() {
    const cur = this.current();
    const defs = typeof RESULT_TYPE_DEFS !== 'undefined' ? RESULT_TYPE_DEFS : [];
    const parts = [];
    for (const key of cur) {
      const s = this.study(key);
      const t = defs.find(d => d.key === key);
      const rows = [];
      if (t && t.fields.length >= 2) {
        for (const f of t.fields) {
          rows.push(`<label class="rv-opt"><input type="checkbox" data-rv-field="${escHtml(key)}" data-rv-name="${escHtml(f.key)}"${Annotations.fieldVisible(key, f.key) ? ' checked' : ''}> ${escHtml(f.label)}</label>`);
        }
      }
      if (key === 'loadflow') rows.push(`<label class="rv-opt"><input type="checkbox" data-rv-arrows="loadflow"${AppState.showFlowArrows?.loadflow ? ' checked' : ''}> Flow arrows on wires</label>`);
      if (key === 'fault') rows.push(`<label class="rv-opt"><input type="checkbox" data-rv-arrows="fault"${AppState.showFlowArrows?.fault ? ' checked' : ''}> Fault current arrows on wires</label>`);
      if (key === 'cable') {
        const on = typeof CableFocus !== 'undefined' && CableFocus.active;
        rows.push(`<label class="rv-opt" title="Show only the cables into and out of the selected bus (Esc shows all again)"><input type="checkbox" data-rv-focus${on ? ' checked' : ''}> Only cables at the selected bus</label>`);
      }
      if (!rows.length) rows.push('<div class="rv-none">One value per box.</div>');
      parts.push(`<div class="rv-group"><div class="rv-h">Values in the ${escHtml(s.label.toLowerCase())} boxes</div>${rows.join('')}</div>`);
    }
    const hidden = Annotations.hiddenResultBoxes.size;
    parts.push(`<div class="rv-foot">`
      + `<button type="button" class="rv-link" data-rv-restore${hidden ? '' : ' disabled'}>${hidden ? `Restore ${hidden} hidden box${hidden === 1 ? '' : 'es'}` : 'No hidden boxes'}</button>`
      + `<button type="button" class="rv-link" data-rv-reset>Reset box positions</button></div>`);
    const html = parts.join('');
    if (html !== this._popHtml || !this._pop.innerHTML) { this._pop.innerHTML = html; this._popHtml = html; }
    // Under the Values button, kept inside the canvas.
    const btn = this._el && this._el.querySelector('[data-rv-values]');
    const host = this._pop.parentElement;
    if (btn && host) {
      const b = btn.getBoundingClientRect(), h = host.getBoundingClientRect();
      const w = this._pop.offsetWidth || 260;
      this._pop.style.left = Math.max(8, Math.min(h.width - w - 8, b.right - h.left - w)) + 'px';
      this._pop.style.top = (b.bottom - h.top + 6) + 'px';
    }
  },

  _onValueChange(e) {
    const t = e.target;
    if (t.matches('[data-rv-field]')) {
      const type = t.dataset.rvField, field = t.dataset.rvName;
      if (!AppState.resultBoxFields[type]) AppState.resultBoxFields[type] = {};
      if (t.checked) delete AppState.resultBoxFields[type][field];
      else AppState.resultBoxFields[type][field] = false;
      AppState.dirty = true;
      this._redraw();
    } else if (t.matches('[data-rv-arrows]')) {
      const k = t.dataset.rvArrows;
      AppState.showFlowArrows[k] = t.checked;
      const menu = document.getElementById(k === 'fault' ? 'chk-fault-arrows' : 'chk-loadflow-arrows');
      if (menu) menu.checked = t.checked;
      AppState.dirty = true;
      this._redraw();
    } else if (t.matches('[data-rv-focus]')) {
      if (typeof CableFocus !== 'undefined' && CableFocus.active !== t.checked) { if (t.checked) CableFocus.enable(); else CableFocus.disable(); }
      if (t.checked && typeof CableFocus !== 'undefined' && !CableFocus.busId) {
        const st = document.getElementById('status-info');
        if (st) st.textContent = 'Cable focus on — select a bus to show only its cables.';
      }
      this.render();
    }
  },
  _onValueClick(e) {
    if (e.target.closest('[data-rv-restore]')) {
      const n = Annotations.hiddenResultBoxes.size;
      Annotations.restoreAllResultBoxes();
      if (typeof UI !== 'undefined' && UI.toast && n > 0) UI.toast(`Restored ${n} result box${n === 1 ? '' : 'es'}`, 'success');
      this.render();
    } else if (e.target.closest('[data-rv-reset]')) {
      Annotations.offsets.clear();
      AppState.dirty = true;
      this._redraw();
    }
  },
};

if (typeof window !== 'undefined') window.ResultView = ResultView;
