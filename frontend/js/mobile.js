/* ProtectionPro — Mobile Interface Controller
 *
 * The phone UI (≤768px): header (workspace switcher, undo/redo/save), canvas
 * mode toggle + view buttons, a selection card, bottom nav and its sheets —
 * Parts, Studies, Results, More — plus full-screen Properties, a workspace
 * switcher and a Sheets (diagram pages) list.
 *
 * Studies and More are built from the desktop menus each time they open
 * (the same way Header's command search indexes them), so every analysis,
 * export and setting the desktop has is reachable here and can't drift.
 * Running an entry clicks the real desktop control.
 */

const MOBILE_ICONS = {
  right: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h0"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5M5 14v6h14v-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
function mIcon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MOBILE_ICONS[name] || ''}</svg>`;
}

const MobileUI = {
  isMobile: false,
  activeSheet: null,
  toastTimer: null,
  _studyGroup: '',        // '' = all groups
  _resultSlot: null,      // result slot shown in the Results sheet
  _studyItem: null,       // study open in the setup sheet
  _menuEls: [],           // elements behind the More sheet's rows
  _syncQueued: false,

  // Analysis button → the result slot it fills (status tick in Studies).
  STUDY_SLOTS: {
    'btn-run-loadflow': 'loadFlowResults', 'btn-run-unbalanced-loadflow': 'unbalancedLoadFlowResults',
    'btn-dc-loadflow': 'dcLoadFlowResults', 'btn-run-fault': 'faultResults',
    'btn-fault-ansi': 'ansiFaultResults', 'btn-dc-shortcircuit': 'dcShortCircuitResults',
    'btn-arcflash': 'arcFlashResults', 'btn-dc-arcflash': 'dcArcFlashResults',
    'btn-duty-check': 'dutyCheckResults', 'btn-motor-starting': 'motorStartingResults',
    'btn-dynamic-motor': 'dynamicMotorResults', 'btn-transient-stability': 'stabilityResults',
    'btn-cable-sizing': 'cableSizingResults', 'btn-load-diversity': 'loadDiversityResults',
    'btn-grounding': 'groundingResults', 'btn-study-manager': 'studyManagerResults',
  },
  // Result slot → [desktop result-box toggle, AppState.showResultBoxes key].
  SLOT_TOGGLES: {
    faultResults: ['btn-toggle-results-fault', 'fault'],
    loadFlowResults: ['btn-toggle-results-loadflow', 'loadflow'],
    unbalancedLoadFlowResults: ['btn-toggle-results-unbalanced', 'unbalancedLF'],
    arcFlashResults: ['btn-toggle-results-arcflash', 'arcflash'],
    dcArcFlashResults: ['btn-toggle-results-arcflash', 'arcflash'],
    cableSizingResults: ['btn-toggle-results-cable', 'cable'],
    motorStartingResults: ['btn-toggle-results-motor', 'motor'],
    dynamicMotorResults: ['btn-toggle-results-dynmotor', 'dynMotor'],
    dutyCheckResults: ['btn-toggle-results-duty', 'duty'],
    loadDiversityResults: ['btn-toggle-results-loaddiversity', 'loadDiversity'],
    groundingResults: ['btn-toggle-results-grounding', 'grounding'],
  },
  // Desktop-only controls left out of More.
  // Also left out because the header (Save) and the selection bar (copy, duplicate, rotate, delete) already have them.
  MENU_SKIP: new Set(['btn-toggle-ribbon', 'btn-boq', 'btn-cable-schedules', 'btn-rates',
    'btn-save', 'btn-edit-copy', 'btn-edit-duplicate', 'btn-edit-rotate', 'btn-delete']),

  init() {
    this.isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!this.isMobile) return;

    this.buildComponentPalette();
    this.bindNavEvents();
    this.bindHeaderEvents();
    this.bindSheetEvents();
    this.bindFabEvents();
    this.bindSelectionBarEvents();
    this.bindStudyEvents();
    this.updateModeButtons();

    // Refresh the selection card after any canvas gesture ends (Canvas holds
    // pointer capture on the svg, so touch pointerups always fire here)
    const svg = document.getElementById('sld-canvas');
    if (svg) {
      svg.addEventListener('pointerup', () => setTimeout(() => this.updateSelectionBar(), 50));
      svg.addEventListener('pointercancel', () => setTimeout(() => this.updateSelectionBar(), 50));
    }
    document.addEventListener('selectionchange-mobile', () => this.updateSelectionBar());

    // Every diagram change goes through Canvas.render — undo/redo, a study's
    // results arriving, a page switch — so it's the one hook that keeps the
    // header, selection card and Results dot current.
    if (typeof Canvas !== 'undefined' && Canvas.render) {
      const orig = Canvas.render.bind(Canvas);
      Canvas.render = (...args) => { const r = orig(...args); this._queueSync(); return r; };
    }
    // Track workspace switches made from anywhere (desktop tabs, search).
    if (typeof window.switchWorkspace === 'function') {
      const origSwitch = window.switchWorkspace;
      window.switchWorkspace = (name, ...rest) => { const r = origSwitch(name, ...rest); this._queueSync(); return r; };
    }
    // The project name is kept in the desktop header; follow it.
    const nameEl = document.getElementById('project-name-display');
    if (nameEl) new MutationObserver(() => this._queueSync()).observe(nameEl, { childList: true, characterData: true, subtree: true });

    this._sync();
  },

  _queueSync() {
    if (this._syncQueued) return;
    this._syncQueued = true;
    requestAnimationFrame(() => { this._syncQueued = false; this._sync(); });
  },

  _sync() {
    this.refreshHeader();
    this.updateSelectionBar();
    this.updateModeButtons();
    const dot = document.getElementById('mobile-results-dot');
    if (dot) dot.hidden = !this._slotsWithResults().length;
    const n = (AppState.pages || []).length;
    const badge = document.getElementById('fab-pages-count');
    if (badge) { badge.hidden = n < 2; badge.textContent = String(n); }
  },

  // The workspace on screen (secondary workspaces are shown with display:flex).
  currentWorkspace() {
    for (const ws of ['retic', 'plan', 'interlock', 'schedules']) {
      const el = document.getElementById(ws + '-workspace');
      if (el && el.style.display === 'flex') return ws;
    }
    return 'sld';
  },

  _wsLabel(ws) {
    return (typeof Workspaces !== 'undefined' && Workspaces.label) ? Workspaces.label(ws) : ws;
  },

  // Plain text of a desktop control, without its icon, shortcut or badges.
  _text(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('svg, select, .dropdown-shortcut, .tb-sr, .k, .q-badge, .q-d').forEach(n => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  },

  _store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key) || '[]');
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* storage unavailable — recents are a convenience only */ }
    return [];
  },
  _pushRecent(key, value, max) {
    const list = this._store(key).filter(v => v !== value);
    list.unshift(value);
    this._store(key, list.slice(0, max));
  },

  // ─── Header ────────────────────────────────────────────────────────────────

  bindHeaderEvents() {
    document.getElementById('mobile-ws-switch')?.addEventListener('click', () => {
      this.renderWorkspaces();
      this.toggleSheet('mobile-sheet-workspaces');
    });
    document.getElementById('mobile-btn-undo')?.addEventListener('click', () => {
      if (typeof UndoManager !== 'undefined') UndoManager.undo();
    });
    document.getElementById('mobile-btn-redo')?.addEventListener('click', () => {
      if (typeof UndoManager !== 'undefined') UndoManager.redo();
    });
    document.getElementById('mobile-btn-save')?.addEventListener('click', () => {
      // saveProject() toasts success/failure itself
      if (typeof Project !== 'undefined') Project.saveProject();
    });
  },

  refreshHeader() {
    const ws = this.currentWorkspace();
    const label = document.getElementById('mobile-ws-label');
    if (label) label.textContent = this._wsLabel(ws);
    const sub = document.getElementById('mobile-ws-sub');
    if (sub) sub.textContent = AppState.projectName || 'Untitled Project';
    const mainTab = document.querySelector('#mobile-nav [data-tab="canvas"]');
    if (mainTab && mainTab.lastChild) mainTab.lastChild.textContent = ws === 'sld' ? ' Diagram ' : ' ' + this._wsLabel(ws) + ' ';
    if (typeof UndoManager !== 'undefined') {
      const u = document.getElementById('mobile-btn-undo');
      const r = document.getElementById('mobile-btn-redo');
      if (u) u.disabled = !UndoManager.canUndo();
      if (r) r.disabled = !UndoManager.canRedo();
    }
  },

  renderWorkspaces() {
    const list = document.getElementById('mobile-ws-list');
    if (!list || typeof Workspaces === 'undefined') return;
    const cur = this.currentWorkspace();
    const typeEl = document.getElementById('mobile-ws-type');
    if (typeEl) typeEl.textContent = Workspaces.TYPES[Workspaces.type()].label + ' project';
    list.innerHTML = Workspaces.visible().map(ws => {
      const n = Workspaces.step(ws);
      return `<button class="mws-item${ws === cur ? ' active' : ''}" data-ws="${ws}"${ws === cur ? ' aria-current="true"' : ''}>
        <span class="mws-step">${n || ''}</span>
        <span class="mm-text"><span class="mm-label">${escHtml(this._wsLabel(ws))}</span>
        <span class="mm-sub">${escHtml(Workspaces.DESCS[ws] || '')}</span></span>
        ${ws === cur ? mIcon('check') : ''}
      </button>`;
    }).join('') + `<button class="mm-item mws-settings" data-ws-settings>
        <span class="mm-text"><span class="mm-label">Project type &amp; workspaces…</span></span>${mIcon('right')}</button>`;
    list.onclick = (e) => {
      const b = e.target.closest('[data-ws]');
      if (b) {
        this.closeSheet();
        if (typeof window.switchWorkspace === 'function') window.switchWorkspace(b.dataset.ws);
        return;
      }
      if (e.target.closest('[data-ws-settings]')) {
        this.closeSheet();
        Workspaces.openSettings();
      }
    };
  },

  // ─── Parts (component palette) ─────────────────────────────────────────────

  buildComponentPalette() {
    const container = document.getElementById('mobile-palette-container');
    if (!container) return;

    let html = '';
    for (const cat of COMPONENT_CATEGORIES) {
      html += this._renderCategory(cat.id, cat.name, cat.items);
    }
    container.innerHTML = html;
    this.renderRecentParts();

    const sheetBody = container.closest('.mobile-sheet-body');
    sheetBody.addEventListener('click', (e) => {
      const header = e.target.closest('.mobile-category-header');
      if (header) {
        const grid = sheetBody.querySelector(`.mobile-component-grid[data-cat="${header.dataset.cat}"]`);
        if (grid) {
          grid.classList.toggle('hidden');
          header.classList.toggle('collapsed');
          header.setAttribute('aria-expanded', String(!grid.classList.contains('hidden')));
        }
        return;
      }

      // Tap-to-place component
      const item = e.target.closest('.mobile-component-item');
      if (item) {
        const type = item.dataset.type;
        if (this.currentWorkspace() !== 'sld' && typeof window.switchWorkspace === 'function') window.switchWorkspace('sld');
        this.placeComponentAtCenter(type);
        this._pushRecent('protectionpro-mobile-recent-parts', type, 4);
        this.renderRecentParts();
        this.closeSheet();
        const def = COMPONENT_DEFS[type];
        this.showToast(`${def ? def.name : type} added`);
      }
    });
  },

  _renderCategory(id, name, items) {
    const chev = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
    return `
      <button class="mobile-category-header" data-cat="${id}" aria-expanded="true">
        <span>${escHtml(name)}</span>${chev}
      </button>
      <div class="mobile-component-grid" data-cat="${id}">
        ${items.map(type => this._renderMobileItem(type)).join('')}
      </div>`;
  },

  renderRecentParts() {
    const box = document.getElementById('mobile-palette-recent');
    if (!box) return;
    const recent = this._store('protectionpro-mobile-recent-parts').filter(t => COMPONENT_DEFS[t]);
    box.innerHTML = recent.length ? this._renderCategory('recent', 'Recent', recent) : '';
  },

  _renderMobileItem(type) {
    if (!COMPONENT_DEFS[type]) return '';
    const def = COMPONENT_DEFS[type];
    const iconSvg = Symbols.renderPaletteIcon(type);
    return `
      <button class="mobile-component-item" data-type="${type}">
        ${iconSvg}
        <span class="mobile-component-label">${escHtml(def.name)}</span>
      </button>`;
  },

  // Place a component at the visible canvas center
  placeComponentAtCenter(type) {
    const rect = document.getElementById('sld-canvas').getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    Canvas.placeComponent(type, cx, cy);
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  filterMobileComponents(query) {
    const lower = query.toLowerCase().trim();
    document.querySelectorAll('.mobile-component-item').forEach(item => {
      const def = COMPONENT_DEFS[item.dataset.type];
      const match = !lower || (def && def.name.toLowerCase().includes(lower));
      item.style.display = match ? '' : 'none';
    });
    // Show/hide category headers based on visible items; the Recent group
    // steps aside while searching so matches aren't listed twice.
    document.querySelectorAll('.mobile-component-grid').forEach(grid => {
      const visible = (!lower || grid.dataset.cat !== 'recent') &&
        [...grid.querySelectorAll('.mobile-component-item')].some(i => i.style.display !== 'none');
      grid.classList.toggle('hidden', !visible);
      const header = grid.previousElementSibling;
      if (header && header.classList.contains('mobile-category-header')) {
        header.style.display = visible ? '' : 'none';
        header.classList.toggle('collapsed', !visible);
      }
    });
  },

  // ─── Bottom navigation ─────────────────────────────────────────────────────

  bindNavEvents() {
    const nav = document.getElementById('mobile-nav');
    if (!nav) return;
    const sheets = {
      components: 'mobile-sheet-components', studies: 'mobile-sheet-studies',
      results: 'mobile-sheet-results', menu: 'mobile-sheet-menu',
    };
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-nav-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === 'canvas') { this.closeSheet(); return; }
      if (tab === 'studies') this.renderStudies();
      if (tab === 'results') this.renderResults();
      if (tab === 'menu') { this._menuPage = 'home'; this._menuQuery = ''; this.renderMenu(); }
      this.toggleSheet(sheets[tab]);
    });
  },

  _setNavActive(sheetId) {
    const tabFor = {
      'mobile-sheet-components': 'components', 'mobile-sheet-studies': 'studies',
      'mobile-sheet-study': 'studies', 'mobile-sheet-results': 'results', 'mobile-sheet-menu': 'menu',
    };
    const tab = tabFor[sheetId] || 'canvas';
    document.querySelectorAll('#mobile-nav .mobile-nav-btn').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  },

  // ─── Sheet management ──────────────────────────────────────────────────────

  bindSheetEvents() {
    document.getElementById('mobile-sheet-backdrop')?.addEventListener('click', () => this.closeSheet());
    document.querySelectorAll('.mobile-sheet-close').forEach(btn => {
      btn.addEventListener('click', () => this.closeSheet());
    });
    document.getElementById('mobile-prop-prev')?.addEventListener('click', () => this._stepProperties(-1));
    document.getElementById('mobile-prop-next')?.addEventListener('click', () => this._stepProperties(1));
    document.getElementById('mobile-component-search')?.addEventListener('input', (e) => {
      this.filterMobileComponents(e.target.value);
    });
  },

  toggleSheet(sheetId) {
    if (this.activeSheet === sheetId) {
      this.closeSheet();
      return;
    }
    this.openSheet(sheetId);
  },

  openSheet(sheetId) {
    if (this.activeSheet && this.activeSheet !== sheetId) {
      const prev = document.getElementById(this.activeSheet);
      if (prev) {
        prev.classList.remove('open');
        setTimeout(() => { if (!prev.classList.contains('open')) prev.style.display = ''; }, 300);
      }
    }
    this.activeSheet = sheetId;
    const sheet = document.getElementById(sheetId);
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (sheet) {
      sheet.style.display = 'flex';
      requestAnimationFrame(() => sheet.classList.add('open'));
    }
    if (backdrop) backdrop.classList.add('visible');
    this._setNavActive(sheetId);
  },

  closeSheet() {
    if (this.activeSheet) {
      const sheet = document.getElementById(this.activeSheet);
      if (sheet) {
        sheet.classList.remove('open');
        setTimeout(() => { if (!sheet.classList.contains('open')) sheet.style.display = ''; }, 300);
      }
      this.activeSheet = null;
    }
    document.getElementById('mobile-sheet-backdrop')?.classList.remove('visible');
    this._setNavActive(null);
  },

  // ─── Canvas mode + view buttons ────────────────────────────────────────────

  bindFabEvents() {
    document.getElementById('fab-mode-select')?.addEventListener('click', () => {
      // Trigger the desktop select button to set mode + apply CSS class
      document.getElementById('btn-select')?.click();
      this.updateModeButtons();
    });
    document.getElementById('fab-mode-wire')?.addEventListener('click', () => {
      document.getElementById('btn-wire')?.click();
      this.updateModeButtons();
      this.showToast('Tap a port to start wiring');
    });
    document.getElementById('fab-zoom-fit')?.addEventListener('click', () => {
      if (typeof Canvas !== 'undefined') Canvas.zoomToFit();
    });
    document.getElementById('fab-pages')?.addEventListener('click', () => {
      this.renderPages();
      this.toggleSheet('mobile-sheet-pages');
    });
  },

  updateModeButtons() {
    const selBtn = document.getElementById('fab-mode-select');
    const wireBtn = document.getElementById('fab-mode-wire');
    if (!selBtn || !wireBtn) return;
    const isWire = typeof AppState !== 'undefined' && AppState.mode === MODE.WIRE;
    selBtn.classList.toggle('fab-active', !isWire);
    wireBtn.classList.toggle('fab-active', isWire);
    selBtn.setAttribute('aria-pressed', String(!isWire));
    wireBtn.setAttribute('aria-pressed', String(isWire));
  },

  // ─── Sheets (diagram pages) ────────────────────────────────────────────────

  renderPages() {
    const list = document.getElementById('mobile-pages-list');
    if (!list) return;
    const pages = AppState.pages || [];
    list.innerHTML = pages.map(p => {
      const on = p.id === AppState.activePageId;
      return `<div class="mm-row">
        <button class="mm-item${on ? ' active' : ''}" data-page="${escHtml(p.id)}"${on ? ' aria-current="true"' : ''}>
          <span class="mm-text"><span class="mm-label">${escHtml(p.name)}</span></span>${on ? mIcon('check') : ''}
        </button>
        <button class="mm-icon-btn" data-rename="${escHtml(p.id)}" aria-label="Rename ${escHtml(p.name)}">${mIcon('edit')}</button>
      </div>`;
    }).join('') + `<button class="mm-item" data-add-page>${mIcon('plus')}<span class="mm-text"><span class="mm-label">Add sheet</span></span></button>`;
    list.onclick = async (e) => {
      const pageBtn = e.target.closest('[data-page]');
      const renameBtn = e.target.closest('[data-rename]');
      if (pageBtn) {
        this.switchPage(pageBtn.dataset.page);
        this.closeSheet();
      } else if (renameBtn) {
        const page = pages.find(p => p.id === renameBtn.dataset.rename);
        const name = page && await UI.prompt('Rename sheet:', page.name);
        if (name && name.trim()) {
          AppState.renamePage(page.id, name.trim());
          if (typeof window.renderPageTabs === 'function') window.renderPageTabs();
          this.renderPages();
        }
      } else if (e.target.closest('[data-add-page]')) {
        document.getElementById('btn-add-page')?.click();
        this.closeSheet();
        Canvas.zoomToFit();
      }
    };
  },

  switchPage(pageId) {
    if (pageId === AppState.activePageId) return;
    AppState.activePageId = pageId;
    AppState.clearSelection();
    if (typeof window.renderPageTabs === 'function') window.renderPageTabs();
    Canvas.render();
    Properties.clear();
  },

  // ─── Selection card ────────────────────────────────────────────────────────

  bindSelectionBarEvents() {
    // Edit actions replay the desktop Edit menu (same undo + guards).
    const edit = { 'mobile-sel-rotate': 'btn-edit-rotate', 'mobile-sel-duplicate': 'btn-edit-duplicate', 'mobile-sel-copy': 'btn-edit-copy' };
    for (const [mid, did] of Object.entries(edit)) {
      document.getElementById(mid)?.addEventListener('click', () => {
        document.getElementById(did)?.click();
        if (mid === 'mobile-sel-copy') this.showToast('Copied — paste from More › Edit');
        this._queueSync();
      });
    }
    document.getElementById('mobile-sel-delete')?.addEventListener('click', () => {
      AppState.deleteSelected();   // removes connected wires and snapshots undo
      Canvas.render();
      Properties.clear();
      this.updateSelectionBar();
    });
    document.getElementById('mobile-sel-deselect')?.addEventListener('click', () => {
      AppState.clearSelection();
      Canvas.render();
      Properties.clear();
      this.updateSelectionBar();
    });
    document.getElementById('mobile-sel-properties')?.addEventListener('click', () => {
      const ids = [...AppState.selectedIds];
      if (ids.length === 1 && AppState.components.has(ids[0])) this.showPropertiesSheet(ids[0]);
    });
  },

  _compName(comp) {
    const def = COMPONENT_DEFS[comp.type];
    return (comp.props && comp.props.name) || (def ? def.name : comp.type);
  },

  updateSelectionBar() {
    if (!this.isMobile) return;
    const bar = document.getElementById('mobile-selection-bar');
    if (!bar) return;
    const ids = [...(AppState.selectedIds || [])];
    if (!ids.length || this.currentWorkspace() !== 'sld') {
      bar.classList.remove('visible');
      document.body.classList.remove('mobile-has-selection');
      return;
    }
    bar.classList.add('visible');
    document.body.classList.add('mobile-has-selection');
    const title = document.getElementById('mobile-sel-title');
    const sub = document.getElementById('mobile-sel-sub');
    const comp = ids.length === 1 ? AppState.components.get(ids[0]) : null;
    if (comp) {
      const def = COMPONENT_DEFS[comp.type];
      title.textContent = this._compName(comp);
      sub.textContent = def ? def.name : comp.type;
    } else if (ids.length === 1) {
      title.textContent = 'Wire';
      sub.textContent = '';
    } else {
      title.textContent = `${ids.length} selected`;
      sub.textContent = '';
    }
    // Edit needs one component; rotate/duplicate/copy need components.
    const hasComp = ids.some(id => AppState.components.has(id));
    document.getElementById('mobile-sel-properties').disabled = !comp;
    for (const id of ['mobile-sel-rotate', 'mobile-sel-duplicate', 'mobile-sel-copy']) {
      document.getElementById(id).disabled = !hasComp;
    }
  },

  // ─── Properties sheet ──────────────────────────────────────────────────────

  showPropertiesSheet(compId) {
    // Render the desktop panel, then mirror it into the mobile sheet.
    if (typeof Properties !== 'undefined') Properties.show(compId);
    setTimeout(() => this._mirrorPropertiesToSheet(compId), 10);
    this._propId = compId;
    this._updatePropertiesHeader();
    this.openSheet('mobile-sheet-properties');
  },

  // Components on the current sheet in reading order (top-to-bottom, then
  // left-to-right) — what previous / next step through.
  _pageComponents() {
    return [...AppState.components.values()]
      .filter(c => !c.pageId || c.pageId === AppState.activePageId)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  },

  _updatePropertiesHeader() {
    const comp = AppState.components.get(this._propId);
    if (!comp) return;
    const list = this._pageComponents();
    const i = list.findIndex(c => c.id === comp.id);
    const def = COMPONENT_DEFS[comp.type];
    document.getElementById('mobile-prop-title').textContent = this._compName(comp);
    document.getElementById('mobile-prop-sub').textContent =
      (def ? def.name : comp.type) + (i >= 0 ? ` · ${i + 1} of ${list.length}` : '');
    document.getElementById('mobile-prop-prev').disabled = i <= 0;
    document.getElementById('mobile-prop-next').disabled = i < 0 || i >= list.length - 1;
  },

  _stepProperties(delta) {
    const list = this._pageComponents();
    const i = list.findIndex(c => c.id === this._propId);
    const next = list[i + delta];
    if (!next) return;
    AppState.select(next.id);
    Canvas.render();
    Canvas.centerOnComponent(next.id, { onlyIfOffscreen: true });
    this.showPropertiesSheet(next.id);
  },

  // Clone the freshly-rendered desktop properties panel into the mobile sheet
  // and re-bind the listeners the innerHTML copy drops. Called on open, and
  // again whenever a change re-renders the desktop panel (e.g. picking a
  // standard device auto-fills and locks fields) so the sheet reflects the
  // new values live instead of only after a close/reopen.
  _mirrorPropertiesToSheet(compId) {
    const mobileContent = document.getElementById('mobile-properties-content');
    const desktopContent = document.getElementById('properties-content');
    if (!mobileContent || !desktopContent) return;

    mobileContent.innerHTML = desktopContent.innerHTML;

    // Re-bind input events: sync changes back to the matching desktop input.
    const desktopInputs = desktopContent.querySelectorAll('input, select, textarea');
    mobileContent.querySelectorAll('input, select, textarea').forEach((input, i) => {
      // The searchable cable selector is driven by its own widget logic
      // (re-initialised below), not value-mirroring. Still iterate so index
      // alignment with desktopInputs is preserved.
      if (input.closest('.searchable-select')) return;
      input.addEventListener('change', () => {
        const dInput = desktopInputs[i];
        if (!dInput) return;
        dInput.value = input.value;
        dInput.dispatchEvent(new Event('change', { bubbles: true }));
        dInput.dispatchEvent(new Event('input', { bubbles: true }));
        // A standard-device / unit select re-renders the desktop panel, which
        // detaches this node. Re-mirror so the sheet shows the fresh (and now
        // locked) values immediately rather than only after a close/reopen.
        if (!dInput.isConnected) this._mirrorPropertiesToSheet(compId);
      });
    });

    // Re-bind the searchable cable selector: the innerHTML copy drops its
    // open/filter/select listeners, so on mobile the cable-type search box
    // was inert (couldn't open, type-to-filter, or pick a size).
    if (typeof Properties !== 'undefined' && Properties._initSearchableSelects
        && typeof AppState !== 'undefined') {
      const comp = AppState.components.get(compId);
      if (comp) Properties._initSearchableSelects(comp, mobileContent);
    }
    // Re-bind ⓘ info buttons — the innerHTML copy loses their listeners
    mobileContent.querySelectorAll('.prop-info-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = (typeof FIELD_INFO !== 'undefined') && FIELD_INFO[btn.dataset.infoKey];
        if (text && typeof Properties !== 'undefined') Properties._showInfoPopup(btn, text);
      });
    });
    // Re-bind collapsible section headers
    mobileContent.querySelectorAll('.prop-section-header').forEach(header => {
      header.addEventListener('click', () => {
        const secKey = header.dataset.section;
        const isNowCollapsed = !header.classList.contains('collapsed');
        if (typeof Properties !== 'undefined') Properties.collapsedSections[secKey] = isNowCollapsed;
        header.classList.toggle('collapsed', isNowCollapsed);
        const body = header.nextElementSibling;
        if (body) body.classList.toggle('collapsed', isNowCollapsed);
      });
    });
    // Re-bind action buttons — the innerHTML copy drops their listeners, so
    // on mobile "Edit Circuit Schedule", "TCC Grading" and the cable-reset
    // buttons did nothing when tapped.
    mobileContent.querySelector('#btn-edit-db')?.addEventListener('click', () => {
      if (typeof DBSchedule !== 'undefined') DBSchedule.open(compId);
    });
    mobileContent.querySelector('#btn-view-tcc')?.addEventListener('click', () => {
      if (typeof TCC !== 'undefined') TCC.openForDevice(compId);
    });
    mobileContent.querySelector('#btn-fault-terminal')?.addEventListener('click', () => {
      if (typeof Properties !== 'undefined') Properties.faultAtTerminal(compId);
    });
    const dReset = [...desktopContent.querySelectorAll('.prop-reset-btn')];
    mobileContent.querySelectorAll('.prop-reset-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => dReset[i] && dReset[i].click());
    });
    // Re-bind the per-cable IEC ampacity calculator launch button (its click
    // listener is dropped by the innerHTML copy, so it was inert on mobile).
    const dAmp = [...desktopContent.querySelectorAll('.prop-ampacity-btn')];
    mobileContent.querySelectorAll('.prop-ampacity-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => dAmp[i] && dAmp[i].click());
    });

    // Mirror the "View Calculations" button. It lives in #calc-info, a SIBLING
    // of #properties-content (not inside it), so the innerHTML copy above never
    // picks it up — the button was simply absent on mobile. Clone it into the
    // sheet, respecting its current display state (Properties.show toggles it
    // per component type), and re-bind the click since the clone drops it.
    mobileContent.querySelector('#mobile-calc-info')?.remove();
    const desktopCalcInfo = document.getElementById('calc-info');
    if (desktopCalcInfo && desktopCalcInfo.style.display !== 'none') {
      const clone = desktopCalcInfo.cloneNode(true);
      clone.id = 'mobile-calc-info';           // avoid a duplicate #calc-info id
      clone.style.display = '';
      const btn = clone.querySelector('#btn-show-calc');
      if (btn) {
        btn.removeAttribute('id');             // avoid a duplicate #btn-show-calc id
        btn.addEventListener('click', () => {
          if (typeof Properties !== 'undefined') Properties.showCalcModal();
        });
      }
      mobileContent.appendChild(clone);
    }
  },

  // ─── Studies ───────────────────────────────────────────────────────────────

  // Every analysis in the desktop Analyse menu, with its group heading and
  // the inline options that sit beside it there (method / fault-type selects,
  // "show arrows" checkboxes).
  _studyIndex() {
    const menu = document.getElementById('menu-analyse');
    const out = [];
    if (!menu) return out;
    let group = '';
    for (const el of menu.querySelectorAll('.dropdown-label, .dropdown-item')) {
      if (el.classList.contains('dropdown-label')) { group = el.textContent.trim(); continue; }
      if (!el.id || el.hidden || el.disabled) continue;
      const compound = el.parentElement.classList.contains('dropdown-compound') ? el.parentElement : null;
      const opts = [];
      if (compound) compound.querySelectorAll('select').forEach(s => opts.push({ kind: 'select', el: s, label: s.title || 'Option' }));
      const next = (compound || el).nextElementSibling;
      if (next && next.classList.contains('dropdown-checkbox')) {
        const input = next.querySelector('input[type="checkbox"]');
        if (input) opts.push({ kind: 'check', el: input, label: next.textContent.trim() });
      }
      const title = el.title || '';
      const dash = title.indexOf(' — ');
      out.push({ id: el.id, el, label: this._text(el), group, opts, desc: dash >= 0 ? title.charAt(dash + 3).toUpperCase() + title.slice(dash + 4) : '' });
    }
    const all = document.getElementById('btn-study-manager');
    if (all) out.unshift({ id: all.id, el: all, label: 'Run all studies', group: '', opts: [], desc: 'Batch-run the enabled analyses' });
    return out;
  },

  _groupShort(g) { return g.split(' & ')[0]; },

  bindStudyEvents() {
    document.getElementById('mobile-study-search')?.addEventListener('input', () => this.renderStudyList());
    document.getElementById('mobile-study-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-group]');
      if (!chip) return;
      this._studyGroup = chip.dataset.group;
      this.renderStudies();
    });
    document.getElementById('mobile-study-list')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-study]');
      if (!row) return;
      const item = this._studyIndex().find(s => s.id === row.dataset.study);
      if (!item) return;
      if (item.opts.length) this.openStudySetup(item);
      else this.runStudy(item);
    });
    document.getElementById('mobile-study-run')?.addEventListener('click', () => {
      if (this._studyItem) this.runStudy(this._studyItem);
    });
  },

  renderStudies() {
    const items = this._studyIndex();
    const groups = [...new Set(items.map(s => s.group).filter(Boolean))];
    const chips = document.getElementById('mobile-study-chips');
    if (chips) {
      const n = items.filter(s => s.group).length;
      chips.innerHTML = [['', `All ${n}`], ...groups.map(g => [g, this._groupShort(g)])].map(([g, l]) =>
        `<button class="mobile-chip${g === this._studyGroup ? ' active' : ''}" data-group="${escHtml(g)}" aria-pressed="${g === this._studyGroup}">${escHtml(l)}</button>`).join('');
    }
    this.renderStudyList(items);
  },

  _studyRow(s) {
    const slot = this.STUDY_SLOTS[s.id];
    const has = slot && AppState[slot] != null;
    return `<button class="mm-item mstudy" data-study="${s.id}">
      <span class="mm-text"><span class="mm-label">${escHtml(s.label)}</span>
      ${s.desc ? `<span class="mm-sub">${escHtml(s.desc)}</span>` : ''}</span>
      ${has ? `<span class="mstudy-done">${mIcon('check', 15)}Run</span>` : ''}
      ${s.opts.length ? '<span class="mstudy-opts">Options</span>' : ''}
      ${mIcon('right')}
    </button>`;
  },

  renderStudyList(items) {
    items = items || this._studyIndex();
    const list = document.getElementById('mobile-study-list');
    if (!list) return;
    const q = (document.getElementById('mobile-study-search')?.value || '').toLowerCase().trim();
    const words = q.split(/\s+/).filter(Boolean);
    const match = (s) => words.every(w => (s.label + ' ' + s.group + ' ' + s.desc).toLowerCase().includes(w));
    let html = '';
    if (!q && !this._studyGroup) {
      const recent = this._store('protectionpro-mobile-recent-studies')
        .map(id => items.find(s => s.id === id)).filter(Boolean);
      if (recent.length) html += `<h3 class="mm-head">${mIcon('clock', 13)} Recent</h3>` + recent.map(s => this._studyRow(s)).join('');
    }
    let group = null, count = 0;
    for (const s of items) {
      if (this._studyGroup && s.group !== this._studyGroup) continue;
      if (!match(s)) continue;
      if (s.group !== group) {
        group = s.group;
        if (group) html += `<h3 class="mm-head">${escHtml(group)}</h3>`;
      }
      html += this._studyRow(s);
      count++;
    }
    if (!count) html += `<p class="mobile-empty">No study matches “${escHtml(q)}”.</p>`;
    list.innerHTML = html;
  },

  openStudySetup(item) {
    this._studyItem = item;
    document.getElementById('mobile-study-title').textContent = item.label;
    document.getElementById('mobile-study-sub').textContent = item.desc || item.group;
    const box = document.getElementById('mobile-study-options');
    box.innerHTML = item.opts.map((o, i) => {
      if (o.kind === 'select') {
        const opts = [...o.el.options].map(op =>
          `<option value="${escHtml(op.value)}"${op.value === o.el.value ? ' selected' : ''}>${escHtml(op.textContent.trim())}</option>`).join('');
        return `<label class="mopt"><span class="mopt-label">${escHtml(o.label)}</span>
          <select class="mopt-select" data-opt="${i}">${opts}</select></label>`;
      }
      return `<label class="mopt mopt-switch"><span class="mopt-label">${escHtml(o.label)}</span>
        <input type="checkbox" class="mobile-switch" data-opt="${i}"${o.el.checked ? ' checked' : ''}></label>`;
    }).join('');
    box.onchange = (e) => {
      const o = item.opts[+e.target.dataset.opt];
      if (!o) return;
      if (o.kind === 'select') o.el.value = e.target.value;
      else o.el.checked = e.target.checked;
      o.el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    document.getElementById('mobile-study-run').innerHTML = `${mIcon('bolt', 20)} Run ${escHtml(item.label)}`;
    this.openSheet('mobile-sheet-study');
  },

  runStudy(item) {
    this._pushRecent('protectionpro-mobile-recent-studies', item.id, 3);
    this.closeSheet();
    if (this.currentWorkspace() !== 'sld' && typeof window.switchWorkspace === 'function') window.switchWorkspace('sld');
    item.el.click();
  },

  // ─── Results ───────────────────────────────────────────────────────────────

  _slotsWithResults() {
    return (typeof RESULT_SLOTS !== 'undefined' ? RESULT_SLOTS : []).filter(s => AppState[s] != null);
  },

  _fmt(v, d = 2) {
    return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
  },

  renderResults() {
    const head = document.getElementById('mobile-results-head');
    const body = document.getElementById('mobile-results-content');
    if (!head || !body) return;
    const slots = this._slotsWithResults();
    if (!slots.length) {
      head.innerHTML = '';
      body.innerHTML = `<div class="mobile-empty">
        <p>No study results yet.</p>
        <button class="mobile-primary-btn" data-go-studies>${mIcon('bolt', 20)} Choose a study</button></div>`;
      body.onclick = (e) => {
        if (e.target.closest('[data-go-studies]')) { this.renderStudies(); this.openSheet('mobile-sheet-studies'); }
      };
      return;
    }
    if (!slots.includes(this._resultSlot)) this._resultSlot = slots[0];
    const slot = this._resultSlot;
    const tog = this.SLOT_TOGGLES[slot];
    const on = tog && AppState.showResultBoxes && AppState.showResultBoxes[tog[1]];
    head.innerHTML = `<div class="mobile-chips" role="group" aria-label="Studies with results">${slots.map(s =>
      `<button class="mobile-chip${s === slot ? ' active' : ''}" data-slot="${s}" aria-pressed="${s === slot}">${escHtml(RESULT_SLOT_LABELS[s] || s)}</button>`).join('')}</div>
      ${tog ? `<label class="mopt mopt-switch mresults-toggle"><span class="mopt-label">Show on diagram</span>
        <input type="checkbox" class="mobile-switch" data-show-boxes${on ? ' checked' : ''}></label>` : ''}`;
    head.onclick = (e) => {
      const chip = e.target.closest('[data-slot]');
      if (chip) { this._resultSlot = chip.dataset.slot; this.renderResults(); }
    };
    head.onchange = (e) => {
      if (e.target.matches('[data-show-boxes]')) document.getElementById(tog[0])?.click();
    };

    const r = AppState[slot];
    let html = '';
    if (slot === 'faultResults' || slot === 'faultResultsMin') html = this._faultCards(r);
    else if (slot === 'loadFlowResults') html = this._loadFlowCards(r);
    else if (slot === 'arcFlashResults') html = this._arcFlashCards(r);
    else html = this._genericResult(slot);
    html += `<div class="mresults-actions">
        <button class="mobile-secondary-btn" data-click="btn-export-pdf">${mIcon('export')} PDF report</button>
        <button class="mobile-secondary-btn" data-click="btn-export-csv">${mIcon('export')} CSV</button>
      </div>
      <div class="mresults-more">
        <button class="mm-link" data-click="btn-reset-annotation-positions">Reset result box positions</button>
      </div>`;
    body.innerHTML = html;
    body.onclick = (e) => {
      const loc = e.target.closest('[data-locate]');
      if (loc) { this.locate(loc.dataset.locate); return; }
      const run = e.target.closest('[data-run]');
      if (run) {
        const item = this._studyIndex().find(s => s.id === run.dataset.run);
        if (item) item.opts.length ? this.openStudySetup(item) : this.runStudy(item);
        return;
      }
      const c = e.target.closest('[data-click]');
      if (c) { this.closeSheet(); document.getElementById(c.dataset.click)?.click(); }
    };
  },

  _card(id, title, sub, cells, flag) {
    const canLocate = id && AppState.components.has(id);
    return `<article class="mres-card${flag ? ' flagged' : ''}">
      <div class="mres-head">
        <div class="mm-text"><span class="mres-title">${escHtml(title)}</span><span class="mm-sub">${escHtml(sub)}</span></div>
        ${canLocate ? `<button class="mm-link" data-locate="${escHtml(id)}">${mIcon('target', 16)} Locate</button>` : ''}
      </div>
      <div class="mres-cells">${cells.map(([k, v]) => `<div><span class="mres-k">${escHtml(k)}</span><span class="mres-v">${escHtml(v)}</span></div>`).join('')}</div>
      ${flag ? `<div class="mres-flag">${mIcon('warn', 15)} ${escHtml(flag)}</div>` : ''}
    </article>`;
  },

  _faultCards(r) {
    const buses = Object.values(r.buses || {}).sort((a, b) => (b.ik3 || 0) - (a.ik3 || 0));
    return `<p class="mres-note">${buses.length} buses · ${escHtml(r.method || 'IEC 60909')} · highest fault level first · kA</p>` +
      buses.map(b => this._card(b.bus_id, b.bus_name, `${this._fmt(b.voltage_kv, 3)} kV`, [
        ['Ik″ 3Φ', this._fmt(b.ik3)], ['ip', this._fmt(b.ip)], ['Ik1', this._fmt(b.ik1)],
      ])).join('');
  },

  _loadFlowCards(r) {
    const buses = Object.values(r.buses || {})
      .sort((a, b) => (a.energized === false) - (b.energized === false) || Math.abs(b.voltage_pu - 1) - Math.abs(a.voltage_pu - 1));
    const over = (r.branches || []).filter(b => b.loading_pct > 100).sort((a, b) => b.loading_pct - a.loading_pct);
    let html = `<p class="mres-note">${r.converged ? `Converged in ${r.iterations} iterations` : 'Did not converge'} · ${escHtml({ newton_raphson: 'Newton-Raphson', gauss_seidel: 'Gauss-Seidel' }[r.method] || r.method || '')} · largest deviation first</p>`;
    for (const w of (r.warnings || [])) html += `<div class="mres-flag mres-banner">${mIcon('warn', 15)} ${escHtml(w.message)}</div>`;
    if (over.length) {
      html += '<h3 class="mm-head">Overloaded branches</h3>' + over.map(b => this._card(b.elementId, b.element_name || b.elementId,
        `${this._fmt(b.p_mw, 3)} MW · ${this._fmt(b.q_mvar, 3)} Mvar`,
        [['Loading', this._fmt(b.loading_pct, 0) + ' %'], ['Current', this._fmt(b.i_amps, 0) + ' A'], ['Losses', this._fmt(b.losses_mw * 1000, 1) + ' kW']],
        `Loaded to ${this._fmt(b.loading_pct, 0)} %`)).join('');
      html += '<h3 class="mm-head">Buses</h3>';
    }
    html += buses.map(b => {
      let flag = '';
      if (b.energized === false) flag = 'De-energised';
      else if (b.voltage_pu < 0.95) flag = 'Below 0.95 pu';
      else if (b.voltage_pu > 1.05) flag = 'Above 1.05 pu';
      return this._card(b.bus_id, b.bus_name, `${this._fmt(b.voltage_kv, 3)} kV`, [
        ['Voltage', this._fmt(b.voltage_pu, 3) + ' pu'], ['Angle', this._fmt(b.angle_deg, 1) + '°'], ['Through', this._fmt(b.p_through_mw, 3) + ' MW'],
      ], flag);
    }).join('');
    return html;
  },

  _arcFlashCards(r) {
    const buses = Object.values(r.buses || {}).sort((a, b) => (b.incident_energy_cal || 0) - (a.incident_energy_cal || 0));
    let html = `<p class="mres-note">${buses.length} buses · ${escHtml(r.method || '')} · highest incident energy first</p>`;
    for (const w of (r.warnings || [])) html += `<div class="mres-flag mres-banner">${mIcon('warn', 15)} ${escHtml(w)}</div>`;
    return html + buses.map(b => this._card(b.bus_id, b.bus_name, `${this._fmt(b.voltage_kv, 3)} kV · cleared in ${this._fmt(b.clearing_time_s, 3)} s`, [
      ['Energy', this._fmt(b.incident_energy_cal, 1) + ' cal/cm²'], ['PPE', b.ppe_category != null ? 'Cat ' + b.ppe_category : '—'],
      ['Boundary', this._fmt(b.arc_flash_boundary_mm, 0) + ' mm'],
    ])).join('');
  },

  _genericResult(slot) {
    const label = RESULT_SLOT_LABELS[slot] || slot;
    const run = Object.keys(this.STUDY_SLOTS).find(id => this.STUDY_SLOTS[id] === slot);
    return `<div class="mobile-empty">
      <p>${escHtml(label)} results are drawn on the diagram as result boxes. Run the study again to open its full results window.</p>
      ${run ? `<button class="mobile-primary-btn" data-run="${run}">${mIcon('bolt', 20)} Run ${escHtml(label)}</button>` : ''}
    </div>`;
  },

  // Close the sheet and bring a component into view on the diagram.
  locate(id) {
    const comp = AppState.components.get(id);
    if (!comp) { this.showToast('Not on the diagram'); return; }
    this.closeSheet();
    if (this.currentWorkspace() !== 'sld' && typeof window.switchWorkspace === 'function') window.switchWorkspace('sld');
    if (comp.pageId && comp.pageId !== AppState.activePageId) this.switchPage(comp.pageId);
    AppState.select(id);
    Canvas.render();
    Canvas.centerOnComponent(id);
    this.updateSelectionBar();
  },

  // ─── More (built from the desktop menus) ───────────────────────────────────
  //
  // A short home (search, project tiles, four drill-in pages, app switches) instead of one flat
  // list of every desktop menu item. Rows are still made from the desktop menus, so ids and click
  // handling are unchanged; each page just chooses which menus it shows.

  _menuPage: 'home',      // 'home' | 'export' | 'display' | 'quantities' | 'edit'
  _menuQuery: '',
  MENU_PAGES: {
    export:     { title: 'Export & reports',       sub: 'PDF, CSV, JSON, diagram images', menus: ['menu-export'] },
    display:    { title: 'Diagram display',        sub: 'Labels, flags, wire routing',    menus: ['menu-view'], route: true },
    quantities: { title: 'Quantities & scenarios', sub: 'BOQ, cable schedules, cases',    menus: ['menu-quantities', 'menu-scenario'] },
    edit:       { title: 'Edit',                   sub: 'Paste, select all, group',       menus: ['menu-edit'] },
  },
  MENU_TILES: [
    ['btn-new', 'New', '<path d="M12 5v14M5 12h14"/>'],
    ['btn-open', 'Open', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'],
    ['btn-templates', 'Templates', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>'],
    ['btn-save-as', 'Save as', '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'],
    ['btn-share', 'Share', '<path d="M12 16V4M7 9l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>'],
    ['btn-project-type', 'Type', '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'],
  ],
  MENU_GROUP_NAMES: { Drawing: 'Diagram' },

  // Every usable item of one desktop menu: { el, label, sub, group, toggle }
  _menuItems(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return [];
    const out = [];
    let group = '';
    for (const el of menu.querySelectorAll('.dropdown-label, .dropdown-item')) {
      if (el.closest('.toolbar-menu') !== menu) continue;   // nested menus list themselves
      if (el.classList.contains('dropdown-label')) { group = el.textContent.trim(); continue; }
      if (el.hidden || el.disabled || el.classList.contains('disabled') || this.MENU_SKIP.has(el.id)) continue;
      if (!el.id && !el.classList.contains('recent-project-item')) continue;
      const label = this._text(el.querySelector('.q-t') || el);
      if (!label) continue;
      const d = el.querySelector('.q-d');
      out.push({ el, label, sub: d ? d.textContent.trim() : '', group: this.MENU_GROUP_NAMES[group] || group,
        toggle: /^btn-toggle-/.test(el.id) ? el.classList.contains('active') : undefined,
        recent: el.classList.contains('recent-project-item') });
    }
    return out;
  },

  _pageItems(page) {
    const def = this.MENU_PAGES[page];
    return def.menus.flatMap(m => this._menuItems(m));
  },

  // The app rows at the bottom of the home, as { el|run, label, toggle?, page } (also feeds search)
  _appItems() {
    const byId = (id) => document.getElementById(id);
    const out = [];
    if (byId('btn-auto-save')) out.push({ el: byId('btn-auto-save'), label: 'Auto save', toggle: byId('btn-auto-save').classList.contains('active') });
    if (byId('btn-dark-mode')) out.push({ el: byId('btn-dark-mode'), label: 'Dark mode', toggle: document.body.classList.contains('dark-mode') });
    for (const [id, label, sub] of [['btn-settings', 'Settings', 'Base MVA, libraries, symbols'], ['btn-help', 'Help', 'Calculations & tools'], ['btn-account', 'Account', 'Sign in, sync, sharing']]) {
      if (byId(id) && !byId(id).hidden) out.push({ el: byId(id), label, sub, nav: true });
    }
    return out;
  },

  renderMenu() {
    const box = document.getElementById('mobile-menu-content');
    if (!box) return;
    box.innerHTML = `<div class="mm-searchbar"><input type="search" class="mm-search" placeholder="Search commands" aria-label="Search commands" autocomplete="off" value="${escHtml(this._menuQuery || '')}"></div><div id="mm-body"></div>`;
    box.querySelector('.mm-search').addEventListener('input', (e) => { this._menuQuery = e.target.value; this._renderMenuBody(); });
    const back = document.getElementById('mobile-menu-back');
    if (back && !back._bound) { back._bound = true; back.addEventListener('click', () => { this._menuPage = 'home'; this._menuQuery = ''; this.renderMenu(); }); }

    box.onclick = (e) => {
      const go = e.target.closest('[data-page]');
      if (go) { this._menuPage = go.dataset.page; this._menuQuery = ''; this.renderMenu(); return; }
      const ws = e.target.closest('[data-ws]');
      if (ws) {
        this.closeSheet();
        if (typeof window.switchWorkspace === 'function') window.switchWorkspace(ws.dataset.ws);
        return;
      }
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const el = this._menuEls[+b.dataset.k];
      if (!el) return;
      if (el.run) { this.closeSheet(); el.run(); return; }
      // Switches flip in place and keep the sheet open.
      if (b.getAttribute('role') === 'switch') {
        el.click();
        this._renderMenuBody();
        return;
      }
      this.closeSheet();
      // Single-line toolbar controls (Edit etc.) act on the diagram.
      if (el.closest('#sld-toolbar') && this.currentWorkspace() !== 'sld' && typeof window.switchWorkspace === 'function') {
        window.switchWorkspace('sld');
      }
      el.click();
    };
    box.onchange = (e) => {
      const route = document.getElementById('wire-route-mode');
      if (e.target.matches('[data-route]') && route) {
        route.value = e.target.value;
        route.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    this._renderMenuBody();
    // Search keeps focus when the body re-renders; on open it is left alone so the keyboard stays closed
  },

  _renderMenuBody() {
    const body = document.getElementById('mm-body');
    if (!body) return;
    const els = [];
    const row = (el, label, opts = {}) => {
      const i = els.push(el) - 1;
      const sub = opts.sub ? `<span class="mm-sub">${escHtml(opts.sub)}</span>` : '';
      const trail = opts.toggle !== undefined
        ? `<span class="mobile-switch-ui${opts.toggle ? ' on' : ''}" aria-hidden="true"></span>`
        : (opts.chev ? '<span class="mm-chev" aria-hidden="true">›</span>' : '');
      const role = opts.toggle !== undefined ? ` role="switch" aria-checked="${!!opts.toggle}"` : '';
      return `<button class="mm-item" data-k="${i}"${role}><span class="mm-text"><span class="mm-label">${escHtml(label)}</span>${sub}</span>${trail}</button>`;
    };
    const page = this._menuPage;
    const q = (this._menuQuery || '').trim().toLowerCase();

    // Page title and back arrow in the sheet header
    const title = document.querySelector('#mobile-sheet-menu .mobile-sheet-title');
    const back = document.getElementById('mobile-menu-back');
    const inPage = !q && page !== 'home';
    if (title) title.textContent = inPage ? this.MENU_PAGES[page].title : 'More';
    if (back) back.hidden = !inPage;

    let html = '';
    if (q) {
      // Search: every command in More, with where it lives
      const hits = [];
      const add = (items, where) => items.forEach(it => {
        const hay = `${it.label} ${it.sub || ''} ${where} ${it.group || ''}`.toLowerCase();
        if (hay.includes(q)) hits.push({ it, where });
      });
      add(this._menuItems('menu-file').filter(i => !i.recent), 'Project');
      for (const def of Object.values(this.MENU_PAGES)) add(def.menus.flatMap(m => this._menuItems(m)), def.title);
      add(this._appItems(), 'App');
      html += `<div class="mm-count">${hits.length ? hits.length + (hits.length === 1 ? ' command' : ' commands') : 'Nothing matches'}</div>`;
      html += hits.map(({ it, where }) => row(it.el, it.label, { sub: it.group && it.group !== where ? `${where} › ${it.group}` : where, toggle: it.toggle })).join('');
      html += `<div class="mm-foot">Not here? <button class="mm-link-btn" data-k="${els.push({ run: () => Header.openSearch() }) - 1}">Search every command</button> (the same list as Ctrl K on desktop).</div>`;
    } else if (page === 'home') {
      // Project tiles
      const tiles = this.MENU_TILES.filter(([id]) => { const e = document.getElementById(id); return e && !e.hidden && !e.disabled; })
        .map(([id, label, path]) => {
          const i = els.push(document.getElementById(id)) - 1;
          return `<button class="mm-tile" data-k="${i}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg><span>${label}</span></button>`;
        });
      html += `<h3 class="mm-head">Project</h3><div class="mm-tiles">${tiles.join('')}</div>`;
      const recents = this._menuItems('menu-file').filter(i => i.recent).slice(0, 3);
      if (recents.length) {
        html += `<h3 class="mm-head">Recent</h3>` + recents.map(r => row(r.el, r.label, { chev: true })).join('');
      }
      // Drill-in pages
      html += '<h3 class="mm-head">Tools</h3><div class="mm-card">';
      for (const [key, def] of Object.entries(this.MENU_PAGES)) {
        const n = this._pageItems(key).length + (def.route && document.getElementById('wire-route-mode') ? 1 : 0);
        if (!n) continue;
        html += `<button class="mm-item mm-nav" data-page="${key}"><span class="mm-text"><span class="mm-label">${escHtml(def.title)}</span><span class="mm-sub">${escHtml(def.sub)}</span></span><span class="mm-count-badge">${n}</span><span class="mm-chev" aria-hidden="true">›</span></button>`;
      }
      html += '</div>';
      // App
      const app = this._appItems();
      html += '<h3 class="mm-head">App</h3><div class="mm-card">' +
        app.map(a => row(a.el, a.label, { sub: a.nav ? a.sub : '', toggle: a.toggle, chev: !!a.nav })).join('') + '</div>';
      const ver = typeof APP_VERSION !== 'undefined' ? String(APP_VERSION) : '';
      const titleBlock = document.getElementById('app-title-block');
      html += `<div class="mm-footer"><span class="mm-version">${escHtml(ver)}</span>${titleBlock ? `<button class="mm-link-btn" data-k="${els.push(titleBlock) - 1}">Reload app</button>` : ''}</div>`;
    } else {
      // A drill-in page: the desktop menu's own groups become sub-headings
      const def = this.MENU_PAGES[page];
      const items = this._pageItems(page);
      let last = null;
      const multi = new Set(items.map(i => i.group)).size > 1;
      for (const it of items) {
        if (multi && it.group !== last) { html += `<h4 class="mm-subhead">${escHtml(it.group || 'Other')}</h4>`; last = it.group; }
        html += row(it.el, it.label, { sub: it.sub, toggle: it.toggle });
      }
      const route = document.getElementById('wire-route-mode');
      if (def.route && route) {
        html += `<label class="mopt mm-select-row"><span class="mopt-label">Wire routing</span>
          <select class="mopt-select" data-route>${[...route.options].map(o =>
            `<option value="${escHtml(o.value)}"${o.value === route.value ? ' selected' : ''}>${escHtml(o.textContent.trim())}</option>`).join('')}</select></label>`;
      }
    }
    body.innerHTML = html;
    this._menuEls = els;
  },

  // ─── Toast notifications ───────────────────────────────────────────────────

  showToast(message, duration = 2000) {
    // Delegate to the shared toast system (single implementation for both
    // desktop and mobile). Falls back to the legacy element if UI is absent.
    if (typeof UI !== 'undefined' && UI.toast) {
      UI.toast(message, 'info', duration);
      return;
    }
    const toast = document.getElementById('mobile-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  },
};

// ─── Hook into app initialization ─────────────────────────────────────────────

// Patch Properties.show to also update the selection card on mobile
(function patchPropertiesForMobile() {
  const patch = () => {
    const orig = Properties.show.bind(Properties);
    Properties.show = function(id) {
      orig(id);
      if (MobileUI.isMobile) MobileUI.updateSelectionBar();
    };
  };
  if (typeof Properties !== 'undefined' && Properties.show) patch();
  else document.addEventListener('DOMContentLoaded', () => {
    if (typeof Properties !== 'undefined' && Properties.show) patch();
  });
})();

// Initialize mobile UI after all other modules load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => MobileUI.init(), 100);
});
