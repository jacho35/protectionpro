/* ProtectionPro — the Analyse menu that guides, and the Study Manager that
 * knows what is out of date (UX plan PR 20).
 *
 *  • A "Common" row on top of the Analyse menu: the studies most projects run
 *    (load flow, short circuit, arc flash, cable sizing, duty check, TCC), each
 *    with a dot for its last result. A button there clicks the real menu item.
 *  • Items that need a selection (open conductor, two conductors open,
 *    simultaneous fault) say so in the menu — "Select one cable first" — and
 *    are dimmed until it is made. They stay clickable, so the existing message
 *    still shows.
 *  • Study Manager: each study shows when it last ran and whether it is out of
 *    date, failing or not run; "Run out-of-date studies" is the main button.
 *
 * `needs` and `status` are pure (node-testable).
 */

const AnalyseMenu = {
  COMMON: [
    ['btn-run-loadflow', 'Load flow', 'loadflow'], ['btn-run-fault', 'Short circuit', 'fault'],
    ['btn-arcflash', 'Arc flash', 'arcflash'], ['btn-cable-sizing', 'Cable sizing', 'cable'],
    ['btn-duty-check', 'Duty check', 'duty'], ['btn-tcc', 'Time-current curves', null],
  ],

  // Items that need a selection: id → what they need.
  NEEDS: {
    'btn-open-conductor': 'cable',
    'btn-two-conductor-open': 'cable',
    'btn-simultaneous-fault': 'cable+bus',
  },

  // Why an item can't run yet ('' = it can). `types` = the types of what is selected.
  needs(kind, types) {
    const cables = types.filter(t => t === 'cable').length;
    const buses = types.filter(t => t === 'bus' || t === 'distribution_board').length;
    if (kind === 'cable') return types.length === 1 && cables === 1 ? '' : 'Select one cable first';
    if (kind === 'cable+bus') return types.length === 2 && cables === 1 && buses === 1 ? '' : 'Select one cable and one bus first';
    return '';
  },

  // Study Manager key → results-panel key.
  MANAGER: {
    loadflow: 'loadflow', fault: 'fault', arcflash: 'arcflash', cable_sizing: 'cable', motor_starting: 'motor',
    dynamic_motor_starting: 'dynMotor', transient_stability: 'stability', duty_check: 'duty',
    load_diversity: 'loadDiversity', grounding: 'grounding',
  },

  // One study's line: { state: none | stale | ok | warn | fail, text }.
  // `s` = { has, stale, at, fail, warn }.
  status(s, fmt) {
    if (!s || !s.has) return { state: 'none', text: 'Not run yet' };
    const when = s.at ? (fmt || ((a) => new Date(a).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })))(s.at) : '';
    const found = s.fail ? `${s.fail} fail` : s.warn ? `${s.warn} warning${s.warn === 1 ? '' : 's'}` : 'all clear';
    if (s.stale) return { state: 'stale', text: `Out of date${when ? ' · ran ' + when : ''}` };
    return { state: s.fail ? 'fail' : s.warn ? 'warn' : 'ok', text: `${when ? 'Ran ' + when + ' · ' : ''}${found}` };
  },

  _read(rpKey) {
    if (typeof ResultsPanel === 'undefined') return { has: false };
    const has = ResultsPanel.has(rpKey);
    if (!has) return { has: false };
    let n = { fail: 0, warn: 0 };
    try { n = ResultsPanel.counts(ResultsPanel.model(rpKey)) || n; } catch (e) { /* keep zero */ }
    return { has: true, stale: ResultsPanel.isStale(rpKey), at: ResultsPanel.ranAt(rpKey), fail: n.fail, warn: n.warn };
  },

  // ── Analyse menu ──
  syncMenu() {
    const panel = document.querySelector('#menu-analyse .toolbar-menu-panel');
    if (!panel) return;
    let row = document.getElementById('am-common');
    if (!row) {
      row = document.createElement('div');
      row.id = 'am-common';
      row.className = 'am-common';
      panel.insertBefore(row, panel.firstChild);
      row.addEventListener('click', (e) => {
        const b = e.target.closest('[data-am]');
        if (!b) return;
        if (typeof window.closeAllToolbarMenus === 'function') window.closeAllToolbarMenus();
        document.getElementById(b.dataset.am)?.click();
      });
    }
    row.innerHTML = '<span class="am-label">Common</span>' + this.COMMON.map(([id, label, rp]) => {
      if (!document.getElementById(id)) return '';
      const st = rp ? this.status(this._read(rp)) : null;
      return `<button type="button" class="am-btn" data-am="${escHtml(id)}"${st ? ` title="${escHtml(st.text)}"` : ''}>`
        + (st ? `<span class="rv-dot am-dot am-${escHtml(st.state)}" aria-hidden="true"></span>` : '') + escHtml(label) + '</button>';
    }).join('');
    const types = [...AppState.selectedIds].map(id => (AppState.components.get(id) || {}).type).filter(Boolean);
    for (const [id, kind] of Object.entries(this.NEEDS)) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const why = this.needs(kind, types);
      btn.classList.toggle('am-needs', !!why);
      let tag = btn.querySelector('.am-why');
      if (why && !tag) { tag = document.createElement('small'); tag.className = 'am-why'; btn.appendChild(tag); }
      if (tag) { tag.textContent = why; tag.hidden = !why; }
    }
  },

  // ── Study Manager ──
  syncManager() {
    const checks = [...document.querySelectorAll('#study-manager-checks input[data-study]')];
    let stale = 0, none = 0;
    for (const cb of checks) {
      const lab = cb.closest('label');
      if (!lab) continue;
      const rp = this.MANAGER[cb.dataset.study];
      const st = this.status(rp ? this._read(rp) : null);
      if (st.state === 'stale') stale++;
      if (st.state === 'none') none++;
      let tag = lab.querySelector('.sm-status');
      if (!tag) { tag = document.createElement('small'); tag.className = 'sm-status'; lab.appendChild(tag); }
      tag.className = 'sm-status sm-' + st.state;
      tag.textContent = st.text;
      cb.dataset.smState = st.state;
    }
    const btn = document.getElementById('btn-study-outdated');
    if (btn) {
      const n = stale + none;
      btn.disabled = !n;
      btn.textContent = n ? `Run out-of-date studies (${n})` : 'Everything is up to date';
    }
    const all = document.getElementById('btn-study-run');
    if (all) { all.classList.remove('btn-primary'); all.textContent = 'Run all selected'; }
    const hint = document.getElementById('study-manager-hint');
    if (hint) hint.textContent = 'Tick the studies to run, or run only what is out of date or not run yet.';
  },

  _mountManager() {
    if (document.getElementById('btn-study-outdated')) return;
    const all = document.getElementById('btn-study-run');
    if (!all) return;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'btn-study-outdated'; b.className = 'btn-small btn-primary';
    b.style.cssText = 'padding:6px 20px;font-size:13px';
    all.parentNode.insertBefore(b, all);
    b.addEventListener('click', () => {
      for (const cb of document.querySelectorAll('#study-manager-checks input[data-study]')) {
        cb.checked = cb.dataset.smState === 'stale' || cb.dataset.smState === 'none';
      }
      all.click();
    });
    const p = document.querySelector('#study-manager-config > p');
    if (p) p.id = 'study-manager-hint';
  },

  init() {
    document.querySelector('#menu-analyse .toolbar-menu-btn')?.addEventListener('click', () => this.syncMenu());
    this._mountManager();
    document.getElementById('btn-study-manager')?.addEventListener('click', () => this.syncManager());
    // After a batch run the statuses change.
    document.getElementById('btn-study-run')?.addEventListener('click', () => setTimeout(() => this.syncManager(), 1500));
  },
};
