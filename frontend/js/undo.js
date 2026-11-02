/* ProtectionPro — Undo/Redo Manager
 *
 * Snapshot-based undo: stores serialized state on every mutation.
 * Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo.
 */

const UndoManager = {
  _stack: [],    // Array of JSON state snapshots
  _index: -1,    // Current position in the stack
  _maxSize: 50,  // Maximum snapshots to keep
  _paused: false, // Temporarily disable recording (e.g. during undo/redo apply)
  _labels: [],   // What produced each snapshot ("Move K2"); [0] is the starting state
  _last: null,   // The state object of the newest snapshot, to name the next change against

  init() {
    // Take an initial snapshot
    this.snapshot();
  },

  // Record the current state as a snapshot
  // `label` names the action; left out, it is worked out from what changed.
  snapshot(label) {
    if (this._paused) return;

    // Discard any redo states beyond current index
    if (this._index < this._stack.length - 1) {
      this._stack.splice(this._index + 1);
    }

    // Capture state (components, wires, pages, groups, counters).
    // Plan↔SLD link fields (planLink, swLink, busOwner, outBusId) live directly
    // on the component objects, so this deep clone preserves them across SLD
    // undo/redo (UX-4/SD-1) — do NOT switch to a field allow-list that would
    // drop them, or a sync after undo would re-orphan the plan boards.
    const state = {
      components: JSON.parse(JSON.stringify([...AppState.components.values()])),
      wires: JSON.parse(JSON.stringify([...AppState.wires.values()])),
      nextId: AppState.nextId,
      pages: JSON.parse(JSON.stringify(AppState.pages)),
      activePageId: AppState.activePageId,
      pageNextId: AppState._pageNextId,
      groups: [...AppState.groups.values()].map(g => ({ ...g, memberIds: [...g.memberIds] })),
      groupNextId: AppState._groupNextId,
      // Project-level earth grids (a bus's earth_grid_id points into them)
      earthGrids: JSON.parse(JSON.stringify(AppState.earthGrids || [])),
      sldShapes: JSON.parse(JSON.stringify(AppState.sldShapes || [])),
    };
    this._labels.splice(this._index + 1);
    this._stack.push(JSON.stringify(state));
    const name = label || (this._last ? this.describe(this._last, state) : '');
    this._labels.push(name);
    this._last = state;
    this._index = this._stack.length - 1;

    // Trim old entries if exceeding max size
    if (this._stack.length > this._maxSize) {
      const excess = this._stack.length - this._maxSize;
      this._stack.splice(0, excess);
      this._labels.splice(0, excess);
      this._index -= excess;
      if (typeof ProjectHistory !== 'undefined') ProjectHistory.shift('sld', excess);
    }
    if (typeof ProjectHistory !== 'undefined') ProjectHistory.record('sld', this._index, name);

    this._updateUI();
  },

  canUndo() {
    return this._index > 0;
  },

  canRedo() {
    return this._index < this._stack.length - 1;
  },

  undo() {
    if (!this.canUndo()) return;
    if (typeof ProjectHistory !== 'undefined' && ProjectHistory.intercept('undo', 'sld')) return;
    const what = this.undoLabel();
    this._index--;
    this._applySnapshot(this._stack[this._index]);
    this._updateUI(what ? 'Undid: ' + what : '');
  },

  redo() {
    if (!this.canRedo()) return;
    if (typeof ProjectHistory !== 'undefined' && ProjectHistory.intercept('redo', 'sld')) return;
    this._index++;
    this._applySnapshot(this._stack[this._index]);
    this._updateUI(this._labels[this._index] ? 'Redid: ' + this._labels[this._index] : '');
  },

  // What Undo / Redo would do now ('' when nothing, or the action is unnamed).
  undoLabel() { return this.canUndo() ? (this._labels[this._index] || '') : ''; },
  redoLabel() { return this.canRedo() ? (this._labels[this._index + 1] || '') : ''; },

  // Name the change from `a` to `b` (two snapshot states): "Move K2",
  // "Add Transformer", "Delete 3 parts", "Edit Bus 1: Voltage" …
  describe(a, b) {
    const byId = (list) => new Map((list || []).map(c => [c.id, c]));
    const A = byId(a.components), B = byId(b.components);
    const nameOf = (c) => {
      const def = typeof COMPONENT_DEFS !== 'undefined' ? COMPONENT_DEFS[c.type] : null;
      return (c.props && c.props.name) || (def && def.name) || c.type || c.id;
    };
    const many = (list, verb) => list.length === 1 ? `${verb} ${nameOf(list[0])}` : `${verb} ${list.length} parts`;
    const added = [...B.values()].filter(c => !A.has(c.id));
    const removed = [...A.values()].filter(c => !B.has(c.id));
    if (added.length && !removed.length) return many(added, 'Add');
    if (removed.length && !added.length) return many(removed, 'Delete');
    if (added.length || removed.length) return 'Edit diagram';
    const moved = [], rotated = [], edited = [];
    for (const [id, c] of B) {
      const o = A.get(id);
      if (!o) continue;
      if (c.rotation !== o.rotation) rotated.push(c);
      else if (c.x !== o.x || c.y !== o.y) moved.push(c);
      if (JSON.stringify(c.props) !== JSON.stringify(o.props)) edited.push([c, o]);
    }
    if (edited.length === 1 && !moved.length && !rotated.length) {
      const [c, o] = edited[0];
      const keys = new Set([...Object.keys(c.props || {}), ...Object.keys(o.props || {})]);
      const changed = [...keys].filter(k => JSON.stringify((c.props || {})[k]) !== JSON.stringify((o.props || {})[k]));
      const def = typeof COMPONENT_DEFS !== 'undefined' ? COMPONENT_DEFS[c.type] : null;
      const field = k => { const f = def && (def.fields || []).find(x => x.key === k); return f ? String(f.label).replace(/\s*\(.*$/, '') : k.replace(/_/g, ' '); };
      return changed.length === 1 ? `Edit ${nameOf(c)}: ${field(changed[0])}` : `Edit ${nameOf(c)}`;
    }
    if (rotated.length && !moved.length && !edited.length) return many(rotated, 'Rotate');
    if (moved.length && !rotated.length && !edited.length) return many(moved, 'Move');
    if (edited.length > 1 && !moved.length && !rotated.length) return `Edit ${edited.length} parts`;
    if (moved.length || rotated.length || edited.length) return 'Edit diagram';
    const wa = byId(a.wires), wb = byId(b.wires);
    const wAdd = [...wb.keys()].filter(i => !wa.has(i)).length, wDel = [...wa.keys()].filter(i => !wb.has(i)).length;
    if (wAdd && !wDel) return wAdd === 1 ? 'Add wire' : `Add ${wAdd} wires`;
    if (wDel && !wAdd) return wDel === 1 ? 'Delete wire' : `Delete ${wDel} wires`;
    if (wAdd || wDel) return 'Edit wires';
    if (JSON.stringify(a.wires) !== JSON.stringify(b.wires)) return 'Re-route wire';
    if (JSON.stringify(a.pages) !== JSON.stringify(b.pages)) return 'Edit sheets';
    if (JSON.stringify(a.groups) !== JSON.stringify(b.groups)) return 'Edit groups';
    if (JSON.stringify(a.earthGrids) !== JSON.stringify(b.earthGrids)) return 'Edit earth grid';
    if (JSON.stringify(a.sldShapes) !== JSON.stringify(b.sldShapes)) return 'Edit annotation';
    return '';
  },

  _applySnapshot(json) {
    this._paused = true;
    const state = JSON.parse(json);
    this._last = JSON.parse(json);   // its own copy: the live parts below are edited in place
    AppState.components.clear();
    AppState.wires.clear();
    AppState.selectedIds.clear();
    for (const c of state.components) {
      AppState.components.set(c.id, c);
    }
    for (const w of state.wires) {
      AppState.wires.set(w.id, w);
    }
    AppState.nextId = state.nextId;
    // Restore pages, active sheet and groups (older snapshots may lack them)
    if (state.pages && state.pages.length > 0) {
      AppState.pages = state.pages;
      AppState.activePageId = state.pages.some(p => p.id === state.activePageId)
        ? state.activePageId
        : state.pages[0].id;
      if (state.pageNextId) AppState._pageNextId = state.pageNextId;
    }
    AppState.groups.clear();
    if (state.groups) {
      for (const g of state.groups) {
        AppState.groups.set(g.id, { ...g, memberIds: new Set(g.memberIds) });
      }
      if (state.groupNextId) AppState._groupNextId = state.groupNextId;
    }
    if (Array.isArray(state.earthGrids)) AppState.earthGrids = state.earthGrids;
    if (Array.isArray(state.sldShapes)) AppState.sldShapes = state.sldShapes;
    // The network is now the snapshot's: results are judged against it (out of
    // date, or current again when the undo returns to the network they were
    // computed on). Called after the restore so the signature is of the
    // restored network.
    AppState.invalidateResults();
    AppState.dirty = true;
    if (typeof EarthGridEditor !== 'undefined') EarthGridEditor.onStateRestored();
    if (typeof window !== 'undefined' && typeof window.renderPageTabs === 'function') {
      window.renderPageTabs();
    }
    Canvas.render();
    Properties.clear();
    this._paused = false;
  },

  _updateUI(said) {
    const u = this.undoLabel(), r = this.redoLabel();
    const undoTitle = 'Undo' + (u ? ': ' + u : '') + ' (Ctrl+Z)';
    const redoTitle = 'Redo' + (r ? ': ' + r : '') + ' (Ctrl+Shift+Z)';
    for (const [id, off, t, l] of [['btn-undo', !this.canUndo(), undoTitle, 'Undo' + (u ? ': ' + u : '')],
      ['btn-redo', !this.canRedo(), redoTitle, 'Redo' + (r ? ': ' + r : '')],
      ['mobile-btn-undo', !this.canUndo(), undoTitle, 'Undo' + (u ? ': ' + u : '')],
      ['mobile-btn-redo', !this.canRedo(), redoTitle, 'Redo' + (r ? ': ' + r : '')]]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = off;
      el.title = t;
      el.setAttribute('aria-label', l);
    }
    // Status
    const info = document.getElementById('status-info');
    if (info && said) info.textContent = said;
    else if (info && (this.canUndo() || this.canRedo())) {
      info.textContent = `Undo available (${this._index} of ${this._stack.length - 1})`;
    }
  },

  // Clear history (e.g. on project load)
  clear() {
    this._stack = [];
    this._labels = [];
    this._last = null;
    this._index = -1;
    this.snapshot();
  },
};
