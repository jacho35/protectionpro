/* ProtectionPro — two-row header behaviours (top-menu redesign, phase C).
 *
 *  • Results menu: lists a per-study "result boxes" toggle only for studies
 *    that actually have results, instead of a fixed list of eleven.
 *  • Command search (Ctrl K, or the Search button in the app bar): finds any
 *    command, analysis, export, setting or workspace by name and runs it.
 *
 * The search index is built from the menus themselves every time it opens —
 * each enabled `.dropdown-item` in #toolbar, located by its menu and group
 * heading — so it can never drift from what the menus contain. Running an
 * entry clicks the real button (switching to the Single-line workspace first
 * when the button lives on its toolbar row).
 */

const Header = {
  // Result-box toggle → the result slots that give it something to show.
  RESULT_TOGGLES: {
    'btn-toggle-results-fault': ['faultResults'],
    'btn-toggle-results-loadflow': ['loadFlowResults'],
    'btn-toggle-results-unbalanced': ['unbalancedLoadFlowResults'],
    'btn-toggle-results-arcflash': ['arcFlashResults', 'dcArcFlashResults'],
    'btn-toggle-results-cable': ['cableSizingResults'],
    'btn-toggle-results-motor': ['motorStartingResults'],
    'btn-toggle-results-dynmotor': ['dynamicMotorResults'],
    'btn-toggle-results-duty': ['dutyCheckResults'],
    'btn-toggle-results-loaddiversity': ['loadDiversityResults'],
    'btn-toggle-results-grounding': ['groundingResults'],
  },

  // ── Results menu ───────────────────────────────────────────────────
  syncResultsMenu() {
    let any = false;
    for (const [id, slots] of Object.entries(this.RESULT_TOGGLES)) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const has = slots.some(s => AppState[s] != null);
      btn.hidden = !has;
      if (has) any = true;
    }
    const all = document.getElementById('btn-toggle-results-all');
    if (all) all.hidden = !any;
    let note = document.getElementById('results-none-note');
    if (!note && all) {
      note = document.createElement('span');
      note.id = 'results-none-note';
      note.className = 'dropdown-note';
      note.textContent = 'No study results yet. Run an analysis and its result boxes can be shown or hidden here.';
      all.parentNode.insertBefore(note, all);
    }
    if (note) note.hidden = any;
  },

  // ── Command search ─────────────────────────────────────────────────
  _index() {
    const out = [];
    const seen = new Set();
    const text = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.dropdown-shortcut, .tb-sr, .k, svg, select').forEach(n => n.remove());
      return c.textContent.replace(/\s+/g, ' ').trim();
    };
    const add = (btn, where, labelOverride) => {
      if (!btn || !btn.id || seen.has(btn.id) || btn.disabled || btn.hidden || btn.hasAttribute('data-search-skip')) return;
      const label = labelOverride || text(btn.querySelector('.q-t') || btn);   // rich items: title only
      if (!label) return;
      seen.add(btn.id);
      const sc = btn.querySelector('.dropdown-shortcut, .k');
      out.push({
        id: btn.id, label, where,
        shortcut: sc ? sc.textContent.trim() : '',
        hay: (label + ' ' + where + ' ' + (btn.title || '')).toLowerCase(),
        sld: !!btn.closest('#sld-toolbar'),
      });
    };
    // Every menu, in reading order, with its group heading.
    for (const menu of document.querySelectorAll('#toolbar .toolbar-menu')) {
      const menuName = text(menu.querySelector('.toolbar-menu-btn'));
      let group = '';
      for (const el of menu.querySelectorAll('.toolbar-menu-panel .dropdown-label, .toolbar-menu-panel .dropdown-item')) {
        if (el.classList.contains('dropdown-label')) { group = el.textContent.trim(); continue; }
        const g = group && !/^recent/i.test(group) ? ' › ' + group.charAt(0) + group.slice(1).toLowerCase() : '';
        add(el, menuName + g);
      }
    }
    // Workspaces (visible tabs only), then the loose toolbar buttons.
    for (const tab of document.querySelectorAll('#toolbar .workspace-tab')) {
      if (!tab.hidden) add(tab, 'Workspace', 'Go to ' + text(tab).replace(/^\d+\s*/, ''));
    }
    const loose = [
      ['btn-select', 'Single-line toolbar › Mode'], ['btn-wire', 'Single-line toolbar › Mode'],
      ['btn-undo', 'Single-line toolbar'], ['btn-redo', 'Single-line toolbar'],
      ['btn-study-manager', 'Single-line toolbar'], ['btn-zoom-fit', 'Single-line toolbar › Zoom'],
      ['btn-zoom-reset', 'Single-line toolbar › Zoom'], ['btn-auto-save', 'App bar'],
      ['btn-dark-mode', 'App bar'], ['btn-settings', 'App bar'], ['btn-help', 'App bar'],
      ['btn-account', 'App bar'],
    ];
    const names = { 'btn-zoom-fit': 'Zoom to fit', 'btn-zoom-reset': 'Actual size (1:1)',
      'btn-dark-mode': 'Toggle dark mode', 'btn-auto-save': 'Toggle auto-save', 'btn-help': 'Help & documentation' };
    for (const [id, where] of loose) add(document.getElementById(id), where, names[id]);
    return out;
  },

  // Placed devices, searchable by name / type / page. Only shown once the user
  // types (they would drown the command list otherwise).
  _deviceIndex() {
    const pageName = (id) => (AppState.pages.find(p => p.id === id) || {}).name || '';
    const out = [];
    for (const c of AppState.components.values()) {
      const def = COMPONENT_DEFS[c.type];
      const name = (c.props && c.props.name) || c.id;
      const typeName = def ? def.name : c.type;
      const page = pageName(c.pageId || 'page_1');
      let where = typeName + (AppState.pages.length > 1 && page ? ' · ' + page : '');
      if (c.type === 'offpage_connector' && c.props.linked_to) {
        const t = AppState.components.get(c.props.linked_to);
        if (t) where += ' → ' + ((t.props && t.props.name) || t.id) + ' on ' + pageName(t.pageId || 'page_1');
      }
      out.push({
        device: c.id, label: name, where, shortcut: '',
        hay: (name + ' ' + c.id + ' ' + typeName + ' ' + page).toLowerCase(),
      });
    }
    return out;
  },

  // Take the user to a placed device: its workspace, its page, selected + centred.
  locateComponent(id) {
    const comp = AppState.components.get(id);
    if (!comp) return;
    if (document.body.classList.contains('ws-secondary-active') && typeof window.switchWorkspace === 'function') {
      window.switchWorkspace('sld');
    }
    const page = comp.pageId || 'page_1';
    if (page !== AppState.activePageId) {
      AppState.activePageId = page;
      if (typeof window.renderPageTabs === 'function') window.renderPageTabs();
    }
    AppState.select(id);
    Canvas.render();
    Canvas.centerOnComponent(id);
    Properties.show(id);
    const st = document.getElementById('status-info');
    if (st) st.textContent = `Found ${(comp.props && comp.props.name) || comp.id}.`;
  },

  _rank(items, q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items.filter(it => !it.device).slice(0, 60);
    const scored = [];
    for (const it of items) {
      if (!words.every(w => it.hay.includes(w))) continue;
      const l = it.label.toLowerCase();
      const score = l.startsWith(words[0]) ? 0 : l.includes(words[0]) ? 1 : 2;
      scored.push([score, it]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 60).map(s => s[1]);
  },

  openSearch() {
    if (document.getElementById('cmd-search')) return;
    if (typeof window.closeAllToolbarMenus === 'function') window.closeAllToolbarMenus();
    const items = this._index().concat(this._deviceIndex());
    const prevFocus = document.activeElement;
    // A `.modal` overlay: the global shortcut handler already stands down while
    // one is open, so typing here can never edit the diagram behind it.
    const overlay = document.createElement('div');
    overlay.id = 'cmd-search';
    overlay.className = 'modal cmd-search-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="cmd-search" role="dialog" aria-modal="true" aria-label="Search commands">
        <div class="cmd-search-input-row">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
          <input type="text" class="cmd-search-input" placeholder="Search commands, analyses, exports, settings, devices…"
            aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="cmd-search-list" aria-autocomplete="list">
          <kbd class="cmd-kbd">Esc</kbd>
        </div>
        <ul class="cmd-search-list" id="cmd-search-list" role="listbox"></ul>
        <div class="cmd-search-foot"><span><kbd class="cmd-kbd">↑</kbd> <kbd class="cmd-kbd">↓</kbd> move</span><span><kbd class="cmd-kbd">↵</kbd> run / go to</span><span><kbd class="cmd-kbd">Esc</kbd> close</span></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.cmd-search-input');
    const list = overlay.querySelector('.cmd-search-list');
    let shown = [], sel = 0;

    const render = () => {
      shown = this._rank(items, input.value);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      if (!shown.length) {
        list.innerHTML = `<li class="cmd-search-empty">Nothing matches “${escHtml(input.value)}”.</li>`;
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.innerHTML = shown.map((it, i) => `
        <li id="cmd-opt-${i}" class="cmd-search-item${i === sel ? ' sel' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}">
          <span class="cmd-search-text"><span class="cmd-search-label">${escHtml(it.label)}</span>
          <span class="cmd-search-where">${escHtml(it.where)}</span></span>
          ${it.shortcut ? `<kbd class="cmd-kbd">${escHtml(it.shortcut)}</kbd>` : ''}
        </li>`).join('');
      input.setAttribute('aria-activedescendant', 'cmd-opt-' + sel);
      const cur = list.querySelector('.sel');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    };
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) { /* gone */ } }
    };
    const run = (it) => {
      if (!it) return;
      close();
      if (it.device) { this.locateComponent(it.device); return; }
      const btn = document.getElementById(it.id);
      if (!btn) return;
      // Row-2 buttons belong to the Single-line workspace.
      if (it.sld && document.body.classList.contains('ws-secondary-active') && typeof window.switchWorkspace === 'function') {
        window.switchWorkspace('sld');
      }
      btn.click();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(shown[sel]); }
    };
    document.addEventListener('keydown', onKey, true);
    input.addEventListener('input', () => { sel = 0; render(); });
    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('[data-i]');
      if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; render(); }
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('[data-i]');
      if (li) run(shown[+li.dataset.i]);
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    render();
    input.focus();
  },

  init() {
    const resultsBtn = document.querySelector('#menu-results .toolbar-menu-btn');
    if (resultsBtn) resultsBtn.addEventListener('click', () => this.syncResultsMenu());
    this.syncResultsMenu();
    document.getElementById('btn-command-search')?.addEventListener('click', () => this.openSearch());
    // Ctrl/Cmd+K anywhere, including while typing in a field.
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        this.openSearch();
      }
    }, true);
  },
};
