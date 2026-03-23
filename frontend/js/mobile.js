/* ProtectionPro — Mobile Interface Controller */

const MobileUI = {
  isMobile: false,
  activeSheet: null,
  toastTimer: null,

  // Touch state for canvas pan/pinch
  touch: {
    pointers: new Map(),
    lastPinchDist: null,
    lastPanX: 0,
    lastPanY: 0,
  },

  init() {
    this.isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!this.isMobile) return;

    this.buildComponentPalette();
    this.bindNavEvents();
    this.bindSheetEvents();
    this.bindFabEvents();
    this.bindCanvasTouchEvents();
    this.bindSelectionBarEvents();
    this.syncDarkMode();
    this.updateModeButtons();

    // Sync selection bar when selection changes
    document.addEventListener('selectionchange-mobile', () => this.updateSelectionBar());
  },

  // ─── Build mobile component palette ───────────────────────────────────────

  buildComponentPalette() {
    const container = document.getElementById('mobile-palette-container');
    if (!container) return;

    let html = '';
    for (const cat of COMPONENT_CATEGORIES) {
      const iconSvg = `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
      html += `
        <div class="mobile-category-header" data-cat="${cat.id}">
          <span>${cat.name}</span>
          ${iconSvg}
        </div>
        <div class="mobile-component-grid" data-cat="${cat.id}">
          ${cat.items.map(type => this._renderMobileItem(type)).join('')}
        </div>`;
    }
    container.innerHTML = html;

    // Category collapse
    container.addEventListener('click', (e) => {
      const header = e.target.closest('.mobile-category-header');
      if (header) {
        const cat = header.dataset.cat;
        const grid = container.querySelector(`.mobile-component-grid[data-cat="${cat}"]`);
        if (grid) {
          grid.classList.toggle('hidden');
          header.classList.toggle('collapsed');
        }
        return;
      }

      // Tap-to-place component
      const item = e.target.closest('.mobile-component-item');
      if (item) {
        const type = item.dataset.type;
        this.placeComponentAtCenter(type);
        this.closeSheet();
        const def = COMPONENT_DEFS[type];
        this.showToast(`${def ? def.name : type} added`);
      }
    });
  },

  _renderMobileItem(type) {
    if (!COMPONENT_DEFS[type]) return '';
    const def = COMPONENT_DEFS[type];
    const iconSvg = Symbols.renderPaletteIcon(type);
    return `
      <div class="mobile-component-item" data-type="${type}">
        ${iconSvg}
        <span class="mobile-component-label">${def.name}</span>
      </div>`;
  },

  // Place a component at the visible canvas center
  placeComponentAtCenter(type) {
    const rect = document.getElementById('sld-canvas').getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    Canvas.placeComponent(type, cx, cy);
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  // ─── Bottom navigation ─────────────────────────────────────────────────────

  bindNavEvents() {
    const nav = document.getElementById('mobile-nav');
    if (!nav) return;

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-nav-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;

      if (tab === 'canvas') {
        this.closeSheet();
      } else if (tab === 'components') {
        this.toggleSheet('mobile-sheet-components');
      } else if (tab === 'analysis') {
        this.toggleSheet('mobile-sheet-analysis');
      } else if (tab === 'menu') {
        this.toggleSheet('mobile-sheet-menu');
      }

      // Update nav active state
      nav.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
      if (tab !== 'canvas') btn.classList.add('active');
    });

    // Mobile header buttons
    document.getElementById('mobile-btn-save')?.addEventListener('click', () => {
      if (typeof Project !== 'undefined') Project.save();
      this.showToast('Project saved');
    });

    document.getElementById('mobile-btn-dark')?.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
      localStorage.setItem('protectionpro-dark-mode', document.body.classList.contains('dark-mode') ? '1' : '0');
      this.syncDarkMode();
    });
  },

  // ─── Sheet management ──────────────────────────────────────────────────────

  bindSheetEvents() {
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.closeSheet());
    }

    // Close buttons on sheets
    document.querySelectorAll('.mobile-sheet-close').forEach(btn => {
      btn.addEventListener('click', () => this.closeSheet());
    });

    // Mobile component search
    const mobileSearch = document.getElementById('mobile-component-search');
    if (mobileSearch) {
      mobileSearch.addEventListener('input', (e) => {
        this.filterMobileComponents(e.target.value);
      });
    }

    // Properties sheet: auto-open when component selected
    // (triggered by Properties.show via mobile hook)
  },

  toggleSheet(sheetId) {
    if (this.activeSheet === sheetId) {
      this.closeSheet();
      return;
    }
    this.openSheet(sheetId);
  },

  openSheet(sheetId) {
    if (this.activeSheet) {
      const prev = document.getElementById(this.activeSheet);
      if (prev) prev.classList.remove('open');
    }
    this.activeSheet = sheetId;
    const sheet = document.getElementById(sheetId);
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (sheet) {
      sheet.style.display = 'flex';
      requestAnimationFrame(() => sheet.classList.add('open'));
    }
    if (backdrop) backdrop.classList.add('visible');
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
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (backdrop) backdrop.classList.remove('visible');

    // Reset nav active state
    document.querySelectorAll('#mobile-nav .mobile-nav-btn').forEach(b => b.classList.remove('active'));
  },

  filterMobileComponents(query) {
    const lower = query.toLowerCase();
    document.querySelectorAll('.mobile-component-item').forEach(item => {
      const type = item.dataset.type;
      const def = COMPONENT_DEFS[type];
      const match = !lower || (def && def.name.toLowerCase().includes(lower));
      item.style.display = match ? '' : 'none';
    });
    // Show/hide category headers based on visible items
    document.querySelectorAll('.mobile-component-grid').forEach(grid => {
      const visible = [...grid.querySelectorAll('.mobile-component-item')].some(i => i.style.display !== 'none');
      grid.classList.toggle('hidden', !visible);
      const catId = grid.dataset.cat;
      const header = document.querySelector(`.mobile-category-header[data-cat="${catId}"]`);
      if (header) header.style.display = visible ? '' : 'none';
    });
  },

  // ─── FAB buttons ───────────────────────────────────────────────────────────

  bindFabEvents() {
    document.getElementById('fab-mode-select')?.addEventListener('click', () => {
      // Trigger the desktop select button to set mode + apply CSS class
      document.getElementById('btn-select')?.click();
      this.updateModeButtons();
    });

    document.getElementById('fab-mode-wire')?.addEventListener('click', () => {
      // Trigger the desktop wire button to set mode + apply CSS class
      document.getElementById('btn-wire')?.click();
      this.updateModeButtons();
      this.showToast('Tap a port to start wiring');
    });

    document.getElementById('fab-zoom-fit')?.addEventListener('click', () => {
      if (typeof Canvas !== 'undefined') Canvas.zoomToFit();
    });
  },

  updateModeButtons() {
    const selBtn = document.getElementById('fab-mode-select');
    const wireBtn = document.getElementById('fab-mode-wire');
    if (!selBtn || !wireBtn) return;

    // Read current mode from AppState (set by desktop button click or keyboard shortcut)
    const isWire = typeof AppState !== 'undefined' && AppState.mode === 'WIRE';
    selBtn.classList.toggle('fab-active', !isWire);
    wireBtn.classList.toggle('fab-active', isWire);
  },

  // ─── Canvas touch events ───────────────────────────────────────────────────

  bindCanvasTouchEvents() {
    const svg = document.getElementById('sld-canvas');
    if (!svg) return;

    svg.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    svg.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    svg.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    svg.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });

    // Update selection bar after any pointer-up on the canvas
    svg.addEventListener('mouseup', () => setTimeout(() => this.updateSelectionBar(), 50));
    svg.addEventListener('touchend', () => setTimeout(() => this.updateSelectionBar(), 50), { passive: true });
  },

  onTouchStart(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      this.touch.pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }

    if (e.touches.length === 1) {
      this.touch.lastPanX = e.touches[0].clientX;
      this.touch.lastPanY = e.touches[0].clientY;
      this.touch.lastPinchDist = null;

      // Single tap: pass through to canvas for component selection
      // (handled by mousedown/click via touch events)
    } else if (e.touches.length === 2) {
      this.touch.lastPinchDist = this._pinchDist(e.touches[0], e.touches[1]);
    }
  },

  onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      this.touch.pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }

    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - this.touch.lastPanX;
      const dy = e.touches[0].clientY - this.touch.lastPanY;
      this.touch.lastPanX = e.touches[0].clientX;
      this.touch.lastPanY = e.touches[0].clientY;

      // Only pan if not in component-drag mode
      if (AppState.mode === 'SELECT' && !AppState.dragState) {
        AppState.panX += dx;
        AppState.panY += dy;
        Canvas.updateTransform();
      }
    } else if (e.touches.length === 2) {
      const dist = this._pinchDist(e.touches[0], e.touches[1]);
      if (this.touch.lastPinchDist !== null && dist > 0) {
        const ratio = dist / this.touch.lastPinchDist;
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        this._zoomAt(ratio, midX, midY);
      }
      this.touch.lastPinchDist = dist;

      // Pan with two fingers
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (this._lastTwoFingerCenter) {
        AppState.panX += cx - this._lastTwoFingerCenter.x;
        AppState.panY += cy - this._lastTwoFingerCenter.y;
        Canvas.updateTransform();
      }
      this._lastTwoFingerCenter = { x: cx, y: cy };
    }
  },

  onTouchEnd(e) {
    for (const t of e.changedTouches) {
      this.touch.pointers.delete(t.identifier);
    }
    if (e.touches.length < 2) {
      this.touch.lastPinchDist = null;
      this._lastTwoFingerCenter = null;
    }
    if (e.touches.length === 1) {
      this.touch.lastPanX = e.touches[0].clientX;
      this.touch.lastPanY = e.touches[0].clientY;
    }
  },

  _pinchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  },

  _zoomAt(ratio, screenX, screenY) {
    const oldZoom = AppState.zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * ratio));
    if (newZoom === oldZoom) return;

    const rect = document.getElementById('sld-canvas').getBoundingClientRect();
    const wx = (screenX - rect.left - AppState.panX) / oldZoom;
    const wy = (screenY - rect.top - AppState.panY) / oldZoom;

    AppState.zoom = newZoom;
    AppState.panX = screenX - rect.left - wx * newZoom;
    AppState.panY = screenY - rect.top - wy * newZoom;

    Canvas.updateTransform();
    const zoomDisplay = document.getElementById('zoom-display');
    if (zoomDisplay) zoomDisplay.textContent = Math.round(newZoom * 100) + '%';
  },

  // ─── Selection bar ─────────────────────────────────────────────────────────

  bindSelectionBarEvents() {
    document.getElementById('mobile-sel-delete')?.addEventListener('click', () => {
      if (typeof AppState !== 'undefined') {
        AppState.selectedIds.forEach(id => {
          AppState.components.delete(id);
          AppState.wires.delete(id);
        });
        AppState.selectedIds.clear();
        if (typeof Canvas !== 'undefined') Canvas.render();
        if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
        this.updateSelectionBar();
      }
    });

    document.getElementById('mobile-sel-deselect')?.addEventListener('click', () => {
      if (typeof AppState !== 'undefined') {
        AppState.selectedIds.clear();
        if (typeof Canvas !== 'undefined') Canvas.render();
        this.updateSelectionBar();
      }
    });

    document.getElementById('mobile-sel-properties')?.addEventListener('click', () => {
      const ids = [...AppState.selectedIds];
      if (ids.length === 1) {
        this.showPropertiesSheet(ids[0]);
      }
    });
  },

  updateSelectionBar() {
    if (!this.isMobile) return;
    const bar = document.getElementById('mobile-selection-bar');
    const canvasContainer = document.getElementById('canvas-container');
    if (!bar) return;

    const count = AppState.selectedIds ? AppState.selectedIds.size : 0;
    if (count > 0) {
      bar.classList.add('visible');
      canvasContainer?.classList.add('has-selection-bar');
      const label = bar.querySelector('.sel-count');
      if (label) label.textContent = `${count} selected`;

      // Show properties button only for single selection
      const propBtn = document.getElementById('mobile-sel-properties');
      if (propBtn) propBtn.style.display = count === 1 ? '' : 'none';
    } else {
      bar.classList.remove('visible');
      canvasContainer?.classList.remove('has-selection-bar');
    }
  },

  // ─── Properties sheet ──────────────────────────────────────────────────────

  showPropertiesSheet(compId) {
    const mobileContent = document.getElementById('mobile-properties-content');
    const desktopContent = document.getElementById('properties-content');

    // Mirror the desktop properties content into the mobile sheet
    if (mobileContent && desktopContent) {
      // Trigger desktop properties render
      if (typeof Properties !== 'undefined') Properties.show(compId);

      // Copy rendered HTML to mobile sheet
      setTimeout(() => {
        mobileContent.innerHTML = desktopContent.innerHTML;
        // Re-bind input events: sync changes back to desktop inputs
        mobileContent.querySelectorAll('input, select, textarea').forEach((input, i) => {
          const desktopInputs = desktopContent.querySelectorAll('input, select, textarea');
          input.addEventListener('change', () => {
            if (desktopInputs[i]) {
              desktopInputs[i].value = input.value;
              desktopInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
              desktopInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            }
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
      }, 10);
    }

    this.openSheet('mobile-sheet-properties');

    // Update nav button
    const propBtn = document.querySelector('[data-tab="properties"]');
    if (propBtn) {
      document.querySelectorAll('#mobile-nav .mobile-nav-btn').forEach(b => b.classList.remove('active'));
    }
  },

  // ─── Analysis sheet ────────────────────────────────────────────────────────

  bindAnalysisSheetEvents() {
    // Map of mobile analysis button IDs to existing desktop button IDs
    const mappings = [
      ['mobile-analysis-fault',         'btn-run-fault'],
      ['mobile-analysis-loadflow',      'btn-run-loadflow'],
      ['mobile-analysis-arcflash',      'btn-arcflash'],
      ['mobile-analysis-cable',         'btn-cable-sizing'],
      ['mobile-analysis-motor',         'btn-motor-starting'],
      ['mobile-analysis-duty',          'btn-duty-check'],
      ['mobile-analysis-grounding',     'btn-grounding'],
      ['mobile-analysis-tcc',           'btn-tcc'],
      ['mobile-analysis-compliance',    'btn-compliance'],
    ];

    mappings.forEach(([mobileId, desktopId]) => {
      const mobileBtn = document.getElementById(mobileId);
      const desktopBtn = document.getElementById(desktopId);
      if (mobileBtn && desktopBtn) {
        mobileBtn.addEventListener('click', () => {
          this.closeSheet();
          desktopBtn.click();
        });
      }
    });
  },

  // ─── Menu sheet ────────────────────────────────────────────────────────────

  bindMenuSheetEvents() {
    const mappings = [
      ['mobile-menu-new',        'btn-new'],
      ['mobile-menu-open',       'btn-open'],
      ['mobile-menu-save',       'btn-save'],
      ['mobile-menu-templates',  'btn-templates'],
      ['mobile-menu-settings',   'btn-settings'],
      ['mobile-menu-help',       'btn-help'],
    ];

    mappings.forEach(([mobileId, desktopId]) => {
      const mobileEl = document.getElementById(mobileId);
      const desktopEl = document.getElementById(desktopId);
      if (mobileEl && desktopEl) {
        mobileEl.addEventListener('click', () => {
          this.closeSheet();
          desktopEl.click();
        });
      }
    });
  },

  // ─── Dark mode sync ────────────────────────────────────────────────────────

  syncDarkMode() {
    const isDark = document.body.classList.contains('dark-mode');
    const darkBtn = document.getElementById('mobile-btn-dark');
    if (darkBtn) {
      darkBtn.title = isDark ? 'Light mode' : 'Dark mode';
    }
  },

  // ─── Toast notifications ───────────────────────────────────────────────────

  showToast(message, duration = 2000) {
    if (!this.isMobile) return;
    const toast = document.getElementById('mobile-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  },
};

// ─── Hook into app initialization ─────────────────────────────────────────────

// Patch Properties.show to also update selection bar and auto-open properties
// sheet on mobile when a component is selected
(function patchPropertiesForMobile() {
  const originalShow = typeof Properties !== 'undefined' ? Properties.show.bind(Properties) : null;
  if (!originalShow) {
    // Wait for Properties to be available
    document.addEventListener('DOMContentLoaded', () => {
      if (typeof Properties !== 'undefined' && Properties.show) {
        _patchProperties();
      }
    });
    return;
  }
  _patchProperties();

  function _patchProperties() {
    const orig = Properties.show.bind(Properties);
    Properties.show = function(id) {
      orig(id);
      if (MobileUI.isMobile) {
        MobileUI.updateSelectionBar();
      }
    };
  }
})();

// Initialize mobile UI after all other modules load
document.addEventListener('DOMContentLoaded', () => {
  // Run after other module inits complete
  setTimeout(() => {
    MobileUI.init();
    if (MobileUI.isMobile) {
      MobileUI.bindAnalysisSheetEvents();
      MobileUI.bindMenuSheetEvents();
    }
  }, 100);
});
