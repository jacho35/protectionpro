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
        <div class="plan-tb-group">
          <button class="plan-tool-btn active" data-tool="select" title="Select / move (V)">▤ Select</button>
          <button class="plan-tool-btn" data-tool="calibrate" title="Set scale from a known distance">📏 Calibrate</button>
          <button class="plan-tool-btn" data-tool="crop" title="Set the export crop rectangle">⬜ Crop</button>
        </div>
        <div class="plan-tb-group">
          <button class="plan-tb-btn" data-action="import" title="Import a site/floor plan (PNG/JPEG)">⬆ Import Plan</button>
          <input type="file" id="plan-file-input" accept="image/png,image/jpeg,image/webp" style="display:none">
          <button class="plan-tb-btn" data-action="fit" title="Zoom to fit">⤢ Fit</button>
        </div>
        <div class="plan-tb-group">
          <label class="plan-snap-pill"><input type="checkbox" data-snap="showGrid" checked> Grid</label>
          <label class="plan-snap-pill"><input type="checkbox" data-snap="snapGrid" checked> Snap grid</label>
          <label class="plan-snap-pill"><input type="checkbox" data-snap="snapEl" checked> Snap comp</label>
          <label class="plan-snap-pill"><input type="checkbox" data-snap="snapVtx" checked> Snap vtx</label>
          <label class="plan-tb-field">Grid (m) <input type="number" id="plan-grid-size" min="0.1" step="0.1" value="0.5"></label>
        </div>
        <div class="plan-tb-group plan-tb-right">
          <span id="plan-scale-readout" class="plan-scale-readout">Not calibrated</span>
        </div>
      </div>
      <div id="plan-main" class="plan-main">
        <aside id="plan-palette" class="plan-palette"></aside>
        <div id="plan-stage" class="plan-stage">
          <canvas id="plan-canvas-bg" class="plan-canvas"></canvas>
          <canvas id="plan-canvas-fg" class="plan-canvas"></canvas>
          <div id="plan-info" class="plan-info">Import a plan, calibrate the scale, then place components and draw routes.</div>
          <div id="plan-status" class="plan-status"><span id="plan-status-coords"></span></div>
        </div>
        <aside id="plan-props" class="plan-props"></aside>
      </div>`;
  },

  _bindToolbar() {
    const tb = document.getElementById('plan-toolbar');
    if (!tb) return;
    tb.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) { PlanTools.set(toolBtn.dataset.tool); return; }
      const act = e.target.closest('[data-action]');
      if (!act) return;
      if (act.dataset.action === 'import') document.getElementById('plan-file-input').click();
      else if (act.dataset.action === 'fit') PlanEngine.zoomFit();
    });
    tb.addEventListener('change', (e) => {
      if (e.target.dataset.snap) {
        AppState.planMarkup.settings[e.target.dataset.snap] = e.target.checked;
        PlanEngine.requestDraw({ all: true });
      } else if (e.target.id === 'plan-grid-size') {
        const v = parseFloat(e.target.value);
        if (isFinite(v) && v > 0) { AppState.planMarkup.settings.gridSize = v; PlanEngine.requestDraw({ bg: true }); }
      }
    });
    const fileInput = document.getElementById('plan-file-input');
    if (fileInput) fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) PlanImages.importFile(f);
      e.target.value = '';
    });
  },

  // ─── Lifecycle (called by app.js switchWorkspace) ───
  activate() {
    this._active = true;
    if (typeof PlanEngine !== 'undefined') { PlanEngine.resize(); PlanEngine.requestDraw({ all: true }); }
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    this.updateScaleReadout();
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
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
    }
  },

  markDirty() { AppState.dirty = true; },
  refreshProps() { if (typeof PlanUI !== 'undefined') PlanUI.renderProps(); },

  // ─── Selection ───
  selectOnly(id) { this.selectedIds.clear(); if (id) this.selectedIds.add(id); this.refreshProps(); if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true }); },
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
      ['crossing', pm.crossings], ['text', pm.texts], ['measurement', pm.measurements]];
    for (const [kind, arr] of tables) {
      const item = arr.find(x => x.id === id);
      if (item) return { kind, item };
    }
    return null;
  },

  deleteSelected() {
    if (!this.selectedIds.size) return;
    const pm = AppState.planMarkup;
    const kill = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (this.selectedIds.has(arr[i].id)) arr.splice(i, 1); };
    kill(pm.elements); kill(pm.routes); kill(pm.trenches);
    kill(pm.crossings); kill(pm.texts); kill(pm.measurements);
    this.selectedIds.clear();
    this._snapshot(); this.markDirty(); this.refreshProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
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
    if (e.key === 'Enter') { return PlanTools.onKey(e); }
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
        this._snapshot(); this.markDirty(); PlanEngine.requestDraw({ fg: true });
        return true;
      }
    }
    return false;
  },

  onToolChanged(id) {
    document.querySelectorAll('#plan-toolbar .plan-tool-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === id));
    if (id !== 'place' && id !== 'route' && typeof PlanUI !== 'undefined' && PlanUI.paletteEl) {
      PlanUI.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
    }
  },

  updateScaleReadout() {
    const el = document.getElementById('plan-scale-readout');
    if (!el) return;
    const s = AppState.planMarkup.scale;
    el.textContent = s ? `Scale: 1 px = ${s.factor.toFixed(4)} m  ·  grid ${AppState.planMarkup.settings.gridSize} m` : 'Not calibrated';
  },

  // ─── Local undo (JSON snapshots of AppState.planMarkup) ───
  _snapshot() {
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
    this.selectedIds.clear();
    this.markDirty();
    if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    this.updateScaleReadout();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
  },
};
