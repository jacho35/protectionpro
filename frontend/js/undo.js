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

  init() {
    // Take an initial snapshot
    this.snapshot();
  },

  // Record the current state as a snapshot
  snapshot() {
    if (this._paused) return;

    // Discard any redo states beyond current index
    if (this._index < this._stack.length - 1) {
      this._stack.splice(this._index + 1);
    }

    // Capture minimal state (components, wires, nextId)
    const state = {
      components: JSON.parse(JSON.stringify([...AppState.components.values()])),
      wires: JSON.parse(JSON.stringify([...AppState.wires.values()])),
      nextId: AppState.nextId,
    };
    this._stack.push(JSON.stringify(state));
    this._index = this._stack.length - 1;

    // Trim old entries if exceeding max size
    if (this._stack.length > this._maxSize) {
      const excess = this._stack.length - this._maxSize;
      this._stack.splice(0, excess);
      this._index -= excess;
    }

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
    this._index--;
    this._applySnapshot(this._stack[this._index]);
    this._updateUI();
  },

  redo() {
    if (!this.canRedo()) return;
    this._index++;
    this._applySnapshot(this._stack[this._index]);
    this._updateUI();
  },

  _applySnapshot(json) {
    this._paused = true;
    const state = JSON.parse(json);
    AppState.components.clear();
    AppState.wires.clear();
    AppState.selectedIds.clear();
    AppState.faultResults = null;
    AppState.loadFlowResults = null;
    for (const c of state.components) {
      AppState.components.set(c.id, c);
    }
    for (const w of state.wires) {
      AppState.wires.set(w.id, w);
    }
    AppState.nextId = state.nextId;
    AppState.dirty = true;
    Canvas.render();
    Properties.clear();
    this._paused = false;
  },

  _updateUI() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = !this.canUndo();
    if (redoBtn) redoBtn.disabled = !this.canRedo();
    // Status
    const info = document.getElementById('status-info');
    if (info && (this.canUndo() || this.canRedo())) {
      info.textContent = `Undo ${this._index}/${this._stack.length - 1}`;
    }
  },

  // Clear history (e.g. on project load)
  clear() {
    this._stack = [];
    this._index = -1;
    this.snapshot();
  },
};
