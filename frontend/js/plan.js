/* ProtectionPro — Plan Markup workspace shell.
 *
 * The workspace object (mirrors Retic's lifecycle): builds the DOM, owns the
 * selection + a local JSON-snapshot undo stack (safe — planMarkup holds no
 * image bytes), routes keyboard shortcuts, and glues PlanEngine / PlanTools /
 * PlanImages / PlanUI together. All persistent data lives in
 * AppState.planMarkup (see state.js).
 */

const PlanMarkup = {
  _active: false,
  _undoStack: [],
  _undoIndex: -1,
  _maxUndo: 50,
  selectedIds: new Set(),

  init() {
    this.buildDOM();
    if (typeof PlanEngine !== 'undefined') PlanEngine.init();
    if (typeof PlanImages !== 'undefined') PlanImages.init();
    const palette = document.getElementById('plan-palette');
    const props = document.getElementById('plan-props');
    if (typeof PlanUI !== 'undefined') {
      PlanUI.init(palette, props);
      PlanUI.bindDomainChange();
      PlanUI.renderPalette();
      PlanUI.renderProps();
    }
    if (typeof PlanTools !== 'undefined') PlanTools.set('select');
    this._bindToolbar();
    this.updateScaleReadout();
    this._snapshot(); // baseline
  },

  buildDOM() {
    const ws = document.getElementById('plan-workspace');
    if (!ws) return;
    ws.innerHTML = `
      <div id="plan-toolbar" class="plan-toolbar">
        <!-- Primary row (always visible; on mobile this is the whole bar). -->
        <div class="plan-tb-group plan-mobile-toggle">
          <button class="plan-tb-btn" data-action="toggle-palette" title="Show/hide the component palette">☰ Parts</button>
          <button class="plan-tb-btn" data-action="toggle-props" title="Show/hide the properties panel">✎ Props</button>
        </div>
        <div class="plan-tb-group">
          <button class="plan-tool-btn active" data-tool="select" title="Select / move (V)">▤ Select</button>
          <button class="plan-tb-btn" data-action="undo" title="Undo (Ctrl+Z)">↶</button>
          <button class="plan-tb-btn" data-action="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        </div>
        <div class="plan-tb-group">
          <button class="plan-tb-btn" data-action="fit" title="Zoom to fit">⤢ Fit</button>
          <button class="plan-tb-btn plan-mobile-toggle" data-action="toggle-overflow" title="More tools & options">⋯ More</button>
        </div>
        <!-- Overflow: inline on desktop (display:contents), a dropdown on mobile. -->
        <div id="plan-tb-overflow">
          <div class="plan-tb-group">
            <button class="plan-tool-btn" data-tool="calibrate" title="Set scale from a known distance">📏 Calibrate</button>
            <button class="plan-tool-btn" data-tool="slpath" title="Draw a path → auto-place streetlight poles + circuits">💡 SL Path</button>
            <button class="plan-tool-btn" data-tool="crop" title="Set the export crop rectangle">⬜ Crop</button>
          </div>
          <div class="plan-tb-group" id="plan-floor-group" style="display:none">
            <label class="plan-tb-field">Floor
              <select id="plan-floor-select" title="Switch the active floor"></select>
            </label>
            <button class="plan-tb-btn" data-action="floors" title="Add / rename / reorder / delete floors">⚙</button>
          </div>
          <div class="plan-tb-group">
            <button class="plan-tb-btn" data-action="import" title="Import a site/floor plan (PNG/JPEG/PDF), a DXF reference, or a Distribution Designer .json project">⬆ Import Plan</button>
            <input type="file" id="plan-file-input" accept="image/png,image/jpeg,image/webp,application/pdf,.dxf,.json,application/json" style="display:none">
            <button class="plan-tb-btn" data-action="lux" title="Toggle the lighting (lux) heatmap">💡 Lux</button>
          </div>
          <div class="plan-tb-group">
            <label class="plan-snap-pill"><input type="checkbox" data-snap="showGrid" checked> Grid</label>
            <label class="plan-snap-pill"><input type="checkbox" data-snap="snapGrid" checked> Snap grid</label>
            <label class="plan-snap-pill"><input type="checkbox" data-snap="snapEl" checked> Snap comp</label>
            <label class="plan-snap-pill"><input type="checkbox" data-snap="snapVtx" checked> Snap vtx</label>
            <label class="plan-tb-field">Grid (m) <input type="number" id="plan-grid-size" min="0.1" step="0.1" value="0.5"></label>
          </div>
          <div class="plan-tb-group">
            <button class="plan-tb-btn" data-action="push" title="Push/sync drawn items to the matching workspace">→ Push to Schedules</button>
            <button class="plan-tb-btn" id="plan-circuits-btn" data-action="circuits" style="display:none" title="Count plan devices into distribution-board circuits (loads + routed lengths)">⚡ Sync Circuits</button>
            <button class="plan-tb-btn" data-action="csv" title="Export component schedules (CSV)">⤓ CSV</button>
            <button class="plan-tb-btn" data-action="dxf" title="Export markup as AutoCAD DXF">⤓ DXF</button>
            <button class="plan-tb-btn" data-action="png" title="Export the annotated plan as a PNG image">⤓ PNG</button>
            <button class="plan-tb-btn" data-action="pdf" title="Export the annotated plan as an A3 PDF sheet">⤓ PDF</button>
          </div>
        </div>
      </div>
      <div id="plan-main" class="plan-main">
        <aside id="plan-palette" class="plan-palette"></aside>
        <div id="plan-stage" class="plan-stage">
          <canvas id="plan-canvas-bg" class="plan-canvas"></canvas>
          <canvas id="plan-canvas-fg" class="plan-canvas" tabindex="0" role="application"
            aria-label="Plan markup canvas. Use arrow keys to move between placed items when focused; R rotates, Delete removes."></canvas>
          <div id="plan-info" class="plan-info">Import a plan, calibrate the scale, then place components and draw routes.</div>
          <div id="plan-action-chip" class="plan-action-chip" role="group" aria-label="Finish or cancel the current drawing">
            <button type="button" data-chip="done" title="Finish (Enter)">✓ Done</button>
            <button type="button" data-chip="cancel" title="Cancel (Esc)">✕ Cancel</button>
          </div>
          <div id="plan-status" class="plan-status">
            <span id="plan-scale-chip" class="plan-scale-chip" title="Plan scale" tabindex="0" role="button"></span>
            <span id="plan-status-coords"></span>
          </div>
        </div>
        <aside id="plan-props" class="plan-props"></aside>
        <div id="plan-drawer-backdrop"></div>
      </div>`;
  },

  _bindToolbar() {
    const tb = document.getElementById('plan-toolbar');
    if (!tb) return;
    tb.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) {
        PlanTools.set(toolBtn.dataset.tool);
        if (this._isMobile()) this._closeOverflow();   // picking a tool closes the ⋯ menu
        return;
      }
      const act = e.target.closest('[data-action]');
      if (!act) return;
      if (act.dataset.action === 'import') document.getElementById('plan-file-input').click();
      else if (act.dataset.action === 'toggle-palette') this._toggleDrawer('palette');
      else if (act.dataset.action === 'toggle-props') this._toggleDrawer('props');
      else if (act.dataset.action === 'toggle-overflow') { this._toggleOverflow(); return; }
      else if (act.dataset.action === 'floors') this._openFloorManager();
      else if (act.dataset.action === 'undo') { this.undo(); return; }
      else if (act.dataset.action === 'redo') { this.redo(); return; }
      else if (act.dataset.action === 'fit') PlanEngine.zoomFit();
      else if (act.dataset.action === 'lux' && typeof PlanLux !== 'undefined') PlanLux.toggle();
      else if (act.dataset.action === 'push' && typeof PlanSync !== 'undefined') {
        // Reticulation → demand schedules; Building → linked SLD boards/feeders.
        if (AppState.planMarkup.settings.domain === 'building') PlanSync.syncBuildingToSLD();
        else PlanSync.pushToSchedules();
      }
      else if (act.dataset.action === 'circuits' && typeof PlanCircuits !== 'undefined') {
        const s = PlanCircuits.syncAll();
        if (typeof PlanUI !== 'undefined') PlanUI.renderProps();
        this.markDirty(); this._snapshot();
        if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();   // UX-4: pair the SLD stack
        UI.alert(`Synced circuits from plan:\n• ${s.ways} way(s) on ${s.boards} board(s) from ${s.devices} tagged device(s)\n• ${s.lengths} way cable length(s) from routes` +
          (s.unsynced ? `\n• ${s.unsynced} board(s) not yet on the SLD (sync first)` : ''));
      }
      else if (act.dataset.action === 'csv' && typeof PlanCSV !== 'undefined') PlanCSV.exportAll();
      else if (act.dataset.action === 'dxf' && typeof PlanDXF !== 'undefined') PlanDXF.export();
      else if (act.dataset.action === 'png' && typeof PlanExport !== 'undefined') PlanExport.exportPNG();
      else if (act.dataset.action === 'pdf' && typeof PlanExport !== 'undefined') PlanExport.exportPDF();
      // Picking any overflow action closes the ⋯ dropdown (but not the drawer
      // toggles, which live on the primary bar).
      if (this._isMobile() && /^(floors|fit|lux|push|circuits|csv|dxf|png|pdf|import)$/.test(act.dataset.action)) this._closeOverflow();
    });
    tb.addEventListener('change', (e) => {
      if (e.target.dataset.snap) {
        AppState.planMarkup.settings[e.target.dataset.snap] = e.target.checked;
        PlanEngine.requestDraw({ all: true });
      } else if (e.target.id === 'plan-grid-size') {
        const v = parseFloat(e.target.value);
        if (isFinite(v) && v > 0) { AppState.planMarkup.settings.gridSize = v; PlanEngine.requestDraw({ bg: true }); }
      } else if (e.target.id === 'plan-floor-select') {
        this.setActiveFloor(e.target.value);
      }
    });
    const backdrop = document.getElementById('plan-drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => this._closeDrawers());
    // Floating Done/Cancel chip for multi-point drafts (touch completion; UX-1).
    const chip = document.getElementById('plan-action-chip');
    if (chip) chip.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]'); if (!b) return;
      if (typeof PlanTools === 'undefined') return;
      PlanTools.onKey({ key: b.dataset.chip === 'done' ? 'Enter' : 'Escape' });
      this.onDraftChanged();
    });
    // Always-visible scale chip — tap to (re)calibrate (UX-14).
    const scaleChip = document.getElementById('plan-scale-chip');
    if (scaleChip) {
      const startCal = () => { if (typeof PlanTools !== 'undefined') PlanTools.set('calibrate'); };
      scaleChip.addEventListener('click', startCal);
      scaleChip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startCal(); } });
    }
    const fileInput = document.getElementById('plan-file-input');
    if (fileInput) fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) {
        if (/\.dxf$/i.test(f.name) && typeof PlanDxfImport !== 'undefined') PlanDxfImport.importFile(f);
        else if (/\.json$/i.test(f.name) && typeof PlanDdImport !== 'undefined') PlanDdImport.importFile(f);
        else PlanImages.importFile(f);
      }
      e.target.value = '';
    });
  },

  // ─── Lifecycle (called by app.js switchWorkspace) ───
  activate() {
    this._active = true;
    // Anchor the workspace exactly below the toolbar (whose height varies with
    // width / responsive wrapping) so the workspace tabs stay visible and the
    // user can always switch back. CSS var is only a fallback.
    const tb = document.getElementById('toolbar');
    const ws = document.getElementById('plan-workspace');
    if (tb && ws) ws.style.top = tb.offsetHeight + 'px';
    if (typeof PlanEngine !== 'undefined') { PlanEngine.resize(); PlanEngine.requestDraw({ all: true }); }
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    this.updateScaleReadout();
    this.updatePushButton();
    this.refreshFloorBar();
  },

  deactivate() {
    this._active = false;
    if (typeof PlanTools !== 'undefined') PlanTools.cancel();
  },

  // New/loaded/reset project: rebaseline undo + refresh view.
  onProjectChanged() {
    this.selectedIds.clear();
    this._undoStack = [];
    this._undoIndex = -1;
    this._snapshot();
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    if (this._active) {
      if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
      this.updateScaleReadout();
      this.refreshFloorBar();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
    }
  },

  markDirty() { AppState.dirty = true; if (typeof PlanLux !== 'undefined') PlanLux.invalidate(); },

  // The push/sync button targets a different workspace per domain.
  updatePushButton() {
    const btn = document.querySelector('#plan-toolbar [data-action="push"]');
    if (!btn) return;
    const building = AppState.planMarkup.settings.domain === 'building';
    btn.textContent = building ? '→ Sync with SLD' : '→ Push to Schedules';
    btn.title = building
      ? 'Create/link distribution boards + feeder cables on the SLD (both directions)'
      : 'Push drawn kiosks/erven/feeders into the Reticulation schedules';
  },
  refreshProps() { if (typeof PlanUI !== 'undefined') PlanUI.renderProps(); },

  // ─── Mobile drawers (palette / properties slide over the canvas) ───
  _isMobile() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
  },
  _toggleDrawer(which) {
    const pal = document.getElementById('plan-palette');
    const props = document.getElementById('plan-props');
    const target = which === 'props' ? props : pal;
    const other = which === 'props' ? pal : props;
    if (!target) return;
    const opening = !target.classList.contains('mobile-open');
    if (other) other.classList.remove('mobile-open');
    document.getElementById('plan-tb-overflow')?.classList.remove('open');   // mutually exclusive
    target.classList.toggle('mobile-open', opening);
    this._syncDrawerBackdrop();
  },
  _toggleOverflow() {
    const ov = document.getElementById('plan-tb-overflow');
    if (!ov) return;
    const opening = !ov.classList.contains('open');
    // A drawer and the overflow menu shouldn't be open together.
    document.getElementById('plan-palette')?.classList.remove('mobile-open');
    document.getElementById('plan-props')?.classList.remove('mobile-open');
    ov.classList.toggle('open', opening);
    this._syncDrawerBackdrop();
  },
  _closeOverflow() {
    document.getElementById('plan-tb-overflow')?.classList.remove('open');
    this._syncDrawerBackdrop();
  },
  _closeDrawers() {
    document.getElementById('plan-palette')?.classList.remove('mobile-open');
    document.getElementById('plan-props')?.classList.remove('mobile-open');
    document.getElementById('plan-tb-overflow')?.classList.remove('open');
    this._syncDrawerBackdrop();
  },
  _syncDrawerBackdrop() {
    const bd = document.getElementById('plan-drawer-backdrop');
    if (!bd) return;
    const open = document.getElementById('plan-palette')?.classList.contains('mobile-open') ||
      document.getElementById('plan-props')?.classList.contains('mobile-open') ||
      document.getElementById('plan-tb-overflow')?.classList.contains('open');
    bd.classList.toggle('on', !!open);
  },

  // ─── Floors ───
  // The floor switcher is a building-domain concept; hidden for reticulation
  // site plans (which are a single implicit floor).
  refreshFloorBar() {
    const group = document.getElementById('plan-floor-group');
    const sel = document.getElementById('plan-floor-select');
    if (!group || !sel) return;
    const pm = AppState.planMarkup;
    const building = pm.settings.domain === 'building';
    group.style.display = building ? '' : 'none';
    const cbtn = document.getElementById('plan-circuits-btn');
    if (cbtn) cbtn.style.display = building ? '' : 'none';
    if (!building) return;
    // Highest level first, so the list reads top-of-building downward.
    const floors = (pm.floors || []).slice().sort((a, b) => (b.level || 0) - (a.level || 0));
    sel.innerHTML = floors.map(f =>
      `<option value="${f.id}"${f.id === pm.activeFloorId ? ' selected' : ''}>${this._esc(f.name)} (L${f.level})</option>`).join('');
  },

  _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },

  // Commit the working floor, switch, and refresh everything view-side.
  setActiveFloor(id) {
    if (!AppState.switchFloor(id)) return;
    this.selectedIds.clear();
    if (typeof PlanTools !== 'undefined') PlanTools.cancel && PlanTools.cancel();
    this._snapshot(); this.markDirty();
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    this.refreshFloorBar();
    this.updateScaleReadout();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); PlanEngine.requestDraw({ all: true }); }
  },

  // Add/rename/reorder/delete floors + edit level & height.
  _openFloorManager() {
    const pm = AppState.planMarkup;
    const overlay = document.createElement('div');
    overlay.className = 'modal plan-floor-modal';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '3000';
    // Dialog semantics + scoped Escape that actually removes the node (the
    // generic app.js Escape only hides `.modal`, leaking orphaned overlays; UX-16).
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Floors');
    const closeModal = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeModal(); }
    };
    document.addEventListener('keydown', onKey, true);

    const render = () => {
      const floors = pm.floors.slice().sort((a, b) => (b.level || 0) - (a.level || 0));
      const rows = floors.map(f => `
        <tr data-floor="${f.id}">
          <td><input class="plan-floor-name" data-role="name" value="${this._esc(f.name)}"></td>
          <td><input class="plan-floor-num" type="number" step="1" data-role="level" value="${f.level}"></td>
          <td><input class="plan-floor-num" type="number" step="0.1" min="0" data-role="height" value="${f.height}"></td>
          <td class="plan-floor-acts">
            <button data-role="up" title="Move up (raise level)">▲</button>
            <button data-role="down" title="Move down (lower level)">▼</button>
            <button data-role="del" title="Delete floor"${pm.floors.length <= 1 ? ' disabled' : ''}>✕</button>
          </td>
        </tr>`).join('');
      overlay.innerHTML = `
        <div class="modal-content plan-floor-content">
          <div class="modal-header"><h3>Floors</h3></div>
          <div class="modal-body">
            <div class="plan-floor-settings">
              <label>Default floor height (m)
                <input id="plan-floor-defh" type="number" step="0.1" min="0" value="${pm.settings.floorHeight}"></label>
              <label>Riser factor
                <input id="plan-floor-riser" type="number" step="0.05" min="1" value="${pm.settings.riserFactor}"
                  title="Vertical-run slack multiplier for bends/terminations"></label>
            </div>
            <table class="plan-floor-table">
              <thead><tr><th>Name</th><th>Level</th><th>Height (m)</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <button class="btn-small" data-role="add">+ Add floor</button>
            <div class="ui-dialog-actions"><button class="btn-primary" data-role="close">Done</button></div>
          </div>
        </div>`;
    };
    render();
    document.body.appendChild(overlay);
    // Move focus into the dialog (first field).
    requestAnimationFrame(() => {
      const first = overlay.querySelector('input, select, button');
      if (first) try { first.focus(); } catch (_) { /* gone */ }
    });

    const commit = (refresh) => {
      this._snapshot(); this.markDirty();
      this.refreshFloorBar();
      if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
      if (refresh) render();
    };
    const floorById = (id) => pm.floors.find(f => f.id === id);
    // Swap two floors' levels to reorder (levels drive both the switcher order
    // and the vertical-run maths).
    const reorder = (id, dir) => {
      const sorted = pm.floors.slice().sort((a, b) => (a.level || 0) - (b.level || 0));
      const i = sorted.findIndex(f => f.id === id);
      const j = dir === 'up' ? i + 1 : i - 1;
      if (j < 0 || j >= sorted.length) return;
      const a = sorted[i], b = sorted[j];
      const t = a.level; a.level = b.level; b.level = t;
      commit(true);
    };

    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role]'); if (!btn) return;
      const role = btn.dataset.role;
      const tr = e.target.closest('[data-floor]');
      const id = tr && tr.dataset.floor;
      if (role === 'close') { closeModal(); return; }
      if (role === 'add') {
        const fl = AppState.addPlanFloor();
        this.setActiveFloor(fl.id);   // switch straight to the new sheet
        commit(true); return;
      }
      if (role === 'del' && id) {
        if (pm.floors.length <= 1) return;
        UI.confirm(`Delete floor "${floorById(id).name}" and its markup?`, { danger: true, okText: 'Delete' }).then(ok => {
          if (!ok) return;
          AppState.removePlanFloor(id);
          if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
          commit(true);
        });
        return;
      }
      if ((role === 'up' || role === 'down') && id) reorder(id, role);
    });
    overlay.addEventListener('change', (e) => {
      if (e.target.id === 'plan-floor-defh') {
        const v = parseFloat(e.target.value); if (isFinite(v) && v > 0) { pm.settings.floorHeight = v; commit(false); } return;
      }
      if (e.target.id === 'plan-floor-riser') {
        const v = parseFloat(e.target.value); if (isFinite(v) && v >= 1) { pm.settings.riserFactor = v; commit(false); } return;
      }
      const tr = e.target.closest('[data-floor]'); if (!tr) return;
      const fl = floorById(tr.dataset.floor); if (!fl) return;
      const role = e.target.dataset.role;
      if (role === 'name') { fl.name = e.target.value || fl.name; commit(false); }
      else if (role === 'level') { const v = parseInt(e.target.value, 10); if (isFinite(v)) { fl.level = v; commit(true); } }
      else if (role === 'height') { const v = parseFloat(e.target.value); if (isFinite(v) && v > 0) { fl.height = v; commit(false); } }
    });
  },

  // ─── Selection ───
  selectOnly(id) {
    this.selectedIds.clear(); if (id) this.selectedIds.add(id); this.refreshProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    // NB: the mobile properties drawer is now opened on pointer-UP (a tap) by the
    // select tool — not here — so touch-to-drag no longer slides it in mid-gesture
    // (UX-6). See PlanMarkup.openPropsForTap().
  },
  clearSelection() { this.selectedIds.clear(); this.refreshProps(); },
  toggleSelect(id) {
    if (this.selectedIds.has(id)) this.selectedIds.delete(id); else this.selectedIds.add(id);
    this.refreshProps(); if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },
  setSelection(ids) {
    this.selectedIds = new Set(ids || []);
    this.refreshProps(); if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  findEntityById(id) {
    const pm = AppState.planMarkup;
    const tables = [['element', pm.elements], ['route', pm.routes], ['trench', pm.trenches],
      ['crossing', pm.crossings], ['room', pm.rooms || []], ['text', pm.texts], ['measurement', pm.measurements]];
    for (const [kind, arr] of tables) {
      const item = arr.find(x => x.id === id);
      if (item) return { kind, item };
    }
    return null;
  },

  deleteSelected() {
    if (!this.selectedIds.size) return;
    const pm = AppState.planMarkup;
    // EE-3: note whether any deleted element carried a circuit tag (or was a
    // board) so we can re-sync loads afterwards — otherwise a deleted device's
    // VA lingers on its way forever.
    let circuitTouched = false;
    if (pm.settings.domain === 'building' && typeof PlanCircuits !== 'undefined') {
      for (const e of pm.elements) {
        if (!this.selectedIds.has(e.id)) continue;
        if (e.type === 'bd_db' || (e.props && e.props.circuitDbId) || PlanCircuits.isCircuitDevice(e.type)) { circuitTouched = true; break; }
      }
    }
    const kill = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (this.selectedIds.has(arr[i].id)) arr.splice(i, 1); };
    kill(pm.elements); kill(pm.routes); kill(pm.trenches);
    kill(pm.crossings); if (pm.rooms) kill(pm.rooms); kill(pm.texts); kill(pm.measurements);
    this.selectedIds.clear();
    if (circuitTouched) {
      // Reflect the removed devices into the linked board schedules (zeroes
      // orphaned ways, updates counts) before snapshotting.
      PlanCircuits.syncLoads();
      if (PlanCircuits.syncRoutedLengths) PlanCircuits.syncRoutedLengths();
    }
    this._snapshot(); this.markDirty(); this.refreshProps();
    if (circuitTouched && typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();   // UX-4
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  // Keep route endpoints attached to their elements: for each moved element id,
  // snap any route endpoint bound to it (fromId/toId or a snappedTo vertex) to
  // the element's current position. Called live while dragging/nudging.
  reconcileRoutes(elIds) {
    const ids = elIds instanceof Set ? elIds : new Set(elIds || []);
    if (!ids.size) return;
    const pm = AppState.planMarkup;
    const elById = {};
    for (const e of pm.elements) elById[e.id] = e;
    for (const r of pm.routes) {
      if (!r.points || !r.points.length) continue;
      const a = ids.has(r.fromId) && elById[r.fromId];
      if (a) { r.points[0].x = a.x; r.points[0].y = a.y; }
      const b = ids.has(r.toId) && elById[r.toId];
      if (b) { const p = r.points[r.points.length - 1]; p.x = b.x; p.y = b.y; }
      for (const p of r.points) {
        const s = p.snappedTo && ids.has(p.snappedTo) && elById[p.snappedTo];
        if (s) { p.x = s.x; p.y = s.y; }
      }
    }
  },

  // Auto-name a freshly placed element from its type prefix.
  nextName(type) {
    const def = PLAN_DEFS.element(type);
    const prefix = (def && def.namePrefix) || 'E';
    return this.nextCounter(type, prefix);
  },

  // Generic auto-name counter (trenches, crossings, …) keyed independently.
  nextCounter(key, prefix) {
    const counters = AppState.planMarkup.nameCounters;
    counters[key] = (counters[key] || 0) + 1;
    return `${prefix}${counters[key]}`;
  },

  // ─── Keyboard (returns true when consumed; see app.js routing) ───
  onKeydown(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelected(); return true; }
    if (e.key === 'Escape') { PlanTools.set('select'); this.clearSelection(); PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Enter') { const c = PlanTools.onKey(e); this.onDraftChanged(); return c; }
    if (e.key === 'v' || e.key === 'V') { PlanTools.set('select'); return true; }
    if (e.key === 'g' || e.key === 'G') {
      const s = AppState.planMarkup.settings; s.snapGrid = !s.snapGrid;
      const cb = document.querySelector('[data-snap="snapGrid"]'); if (cb) cb.checked = s.snapGrid;
      return true;
    }
    if (e.key === 'r' || e.key === 'R') {
      let changed = false;
      for (const id of this.selectedIds) {
        const f = this.findEntityById(id);
        if (f && f.kind === 'element' && PLAN_DEFS.element(f.item.type) && PLAN_DEFS.element(f.item.type).rotatable) {
          f.item.rotation = ((f.item.rotation || 0) + 90) % 360; changed = true;
        }
      }
      if (changed) { this._snapshot(); this.markDirty(); this.refreshProps(); PlanEngine.requestDraw({ fg: true }); return true; }
    }
    if (e.key.startsWith('Arrow')) {
      // When the plan canvas holds keyboard focus (reached via Tab), arrows
      // navigate the selection between placed items (mirrors the SLD). When
      // focus is elsewhere (mouse editing), arrows keep nudging the selection.
      const fg = (typeof PlanEngine !== 'undefined') ? PlanEngine.fg : null;
      const kbNav = fg && typeof fg.matches === 'function' && fg.matches(':focus-visible');
      if (kbNav) return this._keyboardNavigate(e.key);
    }
    if (e.key.startsWith('Arrow') && this.selectedIds.size) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (dx || dy) {
        for (const id of this.selectedIds) {
          const f = this.findEntityById(id);
          if (!f) continue;
          if (f.kind === 'element') { f.item.x += dx; f.item.y += dy; }
          else if (f.item.points) for (const p of f.item.points) { p.x += dx; p.y += dy; }
        }
        this.reconcileRoutes(this.selectedIds);   // attached cables follow
        this._snapshot(); this.markDirty(); PlanEngine.requestDraw({ fg: true });
        return true;
      }
    }
    return false;
  },

  onToolChanged(id, opts) {
    const PLACERS = (id === 'place' || id === 'route' || id === 'array' || id === 'devpath');
    document.querySelectorAll('#plan-toolbar .plan-tool-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === id));
    if (!PLACERS && typeof PlanUI !== 'undefined' && PlanUI.paletteEl) {
      PlanUI.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
    }
    // Live mode/status line (UX-7): what's armed + how to finish/exit.
    this._toolMsg = this._statusFor(id, opts || {});
    this.onDraftChanged();
    // Mobile: after arming a placement tool from the palette drawer, close it
    // so the canvas is tappable.
    if (PLACERS && this._isMobile()) this._closeDrawers();
  },

  // Human-readable status line for an armed tool (UX-7).
  _statusFor(id, opts) {
    const t = opts && opts.type;
    const elName = (ty) => (PLAN_DEFS.element(ty) && PLAN_DEFS.element(ty).name) || ty;
    const rtName = (ty) => (PLAN_DEFS.route(ty) && PLAN_DEFS.route(ty).name) || ty;
    switch (id) {
      case 'select': {
        const pm = AppState.planMarkup;
        if (!pm.plans.length && !pm.elements.length) {
          return 'Import a plan, calibrate the scale, then place components and draw routes.';
        }
        return 'Select — tap to edit, drag to move. Arrow keys nudge; R rotates.';
      }
      case 'place': return `Placing: ${elName(t)} — click to place. Esc / Select to stop.`;
      case 'placeSld': return 'Placing linked board — click where it goes on the plan.';
      case 'array': return `Array: ${elName(t)} — drag a rectangle, then enter columns × rows.`;
      case 'devpath': return `Path: ${elName(t)} — click points, then ✓ Done / Enter to place. Esc cancels.`;
      case 'route': return `Drawing ${rtName(t)} — click points; ✓ Done / Enter finishes, Esc cancels.`;
      case 'slpath': return 'SL Path — click a path; ✓ Done / Enter places poles. Esc cancels.';
      case 'trench': return 'Trench — click points; ✓ Done / Enter finishes. Esc cancels.';
      case 'measurement': return 'Measure — click points; ✓ Done / Enter finishes. Esc cancels.';
      case 'room': return 'Room — click ≥3 points; ✓ Done / Enter closes it. Esc cancels.';
      case 'crossing': return 'Crossing — click two points. Esc cancels.';
      case 'calibrate': return 'Calibrate — click two points a known distance apart.';
      case 'crop': return 'Crop — drag the export rectangle (tiny drag clears it).';
      case 'text': return 'Text — click to place a label.';
      case 'nudgeplan': return 'Move plan — drag the background plan. Esc / Select to stop.';
      case 'align': return 'Align plan — click a feature, then where it belongs (×2).';
      default: return 'Import a plan, calibrate the scale, then place components and draw routes.';
    }
  },

  setInfo(msg) { const el = document.getElementById('plan-info'); if (el && msg != null) el.textContent = msg; },

  // Refresh the status line (with any live draft point count) + the Done/Cancel
  // chip. Called after every tool gesture and on tool change.
  onDraftChanged() {
    const d = (typeof PlanTools !== 'undefined' && PlanTools.draftInfo) ? PlanTools.draftInfo() : null;
    const n = d && d.n;
    this.setInfo(n ? `${this._toolMsg}  ·  ${n} point${n > 1 ? 's' : ''} placed` : this._toolMsg);
    const chip = document.getElementById('plan-action-chip');
    if (chip) chip.classList.toggle('on', !!n);
  },

  // Reveal the properties drawer on a tap (mobile) — called from the select
  // tool's pointer-UP when the gesture didn't move (UX-6).
  openPropsForTap() {
    if (!this._isMobile()) return;
    const props = document.getElementById('plan-props');
    if (props && !props.classList.contains('mobile-open')) {
      document.getElementById('plan-palette')?.classList.remove('mobile-open');
      props.classList.add('mobile-open');
      this._syncDrawerBackdrop();
    }
  },

  // Arrow-key nearest-entity selection when the canvas has keyboard focus
  // (ports the SLD's _keyboardNavigate; UX-17).
  _keyboardNavigate(key) {
    const els = AppState.planMarkup.elements;
    if (!els.length) return false;
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = dirs[key]; if (!dir) return false;
    const curId = [...this.selectedIds][0];
    const cur = curId ? els.find(e => e.id === curId) : null;
    let best = null;
    if (!cur) {
      // Entry point: item nearest the visible viewport centre.
      let bx = 0, by = 0;
      if (typeof PlanEngine !== 'undefined') {
        bx = -PlanEngine.view.panX / PlanEngine.view.zoom;
        by = -PlanEngine.view.panY / PlanEngine.view.zoom;
      }
      let bestD = Infinity;
      for (const e of els) { const d = (e.x - bx) ** 2 + (e.y - by) ** 2; if (d < bestD) { bestD = d; best = e; } }
    } else {
      let bestScore = Infinity;
      for (const e of els) {
        if (e.id === cur.id) continue;
        const dx = e.x - cur.x, dy = e.y - cur.y;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 0) continue;
        const perp = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = along + perp * 2;
        if (score < bestScore) { bestScore = score; best = e; }
      }
    }
    if (!best) return false;
    this.selectOnly(best.id);
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    return true;
  },

  updateScaleReadout() {
    const s = AppState.planMarkup.scale;
    const calibrated = !!(s && s.factor);
    const chip = document.getElementById('plan-scale-chip');
    if (chip) {
      chip.textContent = calibrated
        ? `📏 1 px = ${s.factor.toFixed(4)} m · grid ${AppState.planMarkup.settings.gridSize} m`
        : '⚠ Not calibrated — tap to set scale';
      chip.classList.toggle('warn', !calibrated);
      chip.title = calibrated ? 'Scale calibrated — tap to recalibrate' : 'Not calibrated — tap to start Calibrate';
    }
  },

  // ─── Local undo (JSON snapshots of AppState.planMarkup) ───
  _snapshot() {
    if (typeof AppState._stashActiveFloor === 'function') AppState._stashActiveFloor();
    const snap = JSON.stringify(AppState.planMarkup);
    // Drop any redo tail, push, cap.
    this._undoStack = this._undoStack.slice(0, this._undoIndex + 1);
    this._undoStack.push(snap);
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._undoIndex = this._undoStack.length - 1;
  },
  snapshot() { this._snapshot(); },

  undo() {
    if (this._undoIndex <= 0) return;
    this._undoIndex--;
    this._restore(this._undoStack[this._undoIndex]);
  },
  redo() {
    if (this._undoIndex >= this._undoStack.length - 1) return;
    this._undoIndex++;
    this._restore(this._undoStack[this._undoIndex]);
  },
  _restore(snap) {
    AppState.planMarkup = JSON.parse(snap);
    if (typeof AppState._hydrateActiveFloor === 'function') AppState._hydrateActiveFloor();
    this.selectedIds.clear();
    this.markDirty();
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    this.updateScaleReadout();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
  },
};
