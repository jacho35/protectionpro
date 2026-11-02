/* ProtectionPro — the save-state chip and autosave (UX plan PR 18).
 *
 * The header chip says where the work stands: "Saved · 2 min ago", "Saving…", "Unsaved changes",
 * "Not saved yet" (a project that isn't on the server), "Offline: kept on this device",
 * "Not saved: changed on the server" or "View only". Click it to save when there is something
 * to save. Ctrl+S still works.
 *
 * Autosave is on by default and works once the project is on the server: a moment after the
 * last edit (IDLE_MS, never closer than MIN_GAP_MS to the last autosave) the project is saved to
 * its own record. It never overwrites someone else's save (409 pauses it). A revision snapshot
 * is added at most every REV_GAP_MS. A project not yet on the server, or a failed save, keeps a
 * backup in this browser as before. The choice (Settings › Preferences › Save automatically) is
 * localStorage `protectionpro-auto-save`: '0' = off, anything else = on.
 */
const SaveState = {
  PREF: 'protectionpro-auto-save',
  IDLE_MS: 15000,
  MIN_GAP_MS: 30000,
  REV_GAP_MS: 10 * 60 * 1000,
  BACKUP_MS: 120000,

  status: 'idle',      // idle | saving | failed | conflict
  failedOffline: false,
  savedAt: null,       // when this project was last saved from here
  _pid: null,
  _timer: null,
  _lastAutoAt: 0,
  _lastRevAt: 0,

  // ── Pure: what the chip shows ──
  ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  },
  // s = { projectId, dirty, status, offline, readOnly, savedAt, now }
  describe(s) {
    if (s.readOnly) return { kind: 'readonly', text: 'View only', title: 'Shared with you to view. Save As keeps your own copy.' };
    if (s.status === 'saving') return { kind: 'saving', text: 'Saving…', title: 'Saving to the server' };
    if (s.status === 'conflict') return { kind: 'conflict', text: 'Not saved: changed on the server', title: 'Someone else saved this project. Click to choose what to keep.' };
    if (s.status === 'failed' || (s.offline && s.dirty)) return { kind: 'failed', text: 'Offline: kept on this device', title: 'The server could not be reached. A backup is kept in this browser; click to try again.' };
    if (!s.projectId) return { kind: 'new', text: 'Not saved yet', title: 'This project is not on the server yet. Click to save it.' };
    if (s.dirty) return { kind: 'unsaved', text: 'Unsaved changes', title: 'Click to save now (Ctrl+S)' };
    return { kind: 'saved', text: s.savedAt ? 'Saved · ' + this.ago(s.now - s.savedAt) : 'Saved', title: 'All changes are on the server' };
  },
  // Pure: should an autosave run now?
  due(s) {
    return !!(s.auto && s.projectId && s.dirty && !s.readOnly && s.status !== 'saving' && s.status !== 'conflict'
      && s.now - s.lastAutoAt >= this.MIN_GAP_MS);
  },

  // ── Preference ──
  autoOn() { try { return localStorage.getItem(this.PREF) !== '0'; } catch (_) { return true; } },
  setAuto(on) {
    try { localStorage.setItem(this.PREF, on ? '1' : '0'); } catch (_) { /* private mode */ }
    if (on) this._schedule(); else this._cancel();
    this.render();
  },

  _snapshot() {
    return {
      projectId: AppState.projectId, dirty: !!AppState.dirty, status: this.status,
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
      readOnly: !!AppState.readOnly, savedAt: this.savedAt, now: Date.now(),
      auto: this.autoOn(), lastAutoAt: this._lastAutoAt,
    };
  },

  render() {
    const chip = document.getElementById('save-chip');
    if (!chip) return;
    const d = this.describe(this._snapshot());
    chip.dataset.state = d.kind;
    chip.title = d.title;
    chip.setAttribute('aria-label', d.text);
    const t = chip.querySelector('.sc-text');
    if (t && t.textContent !== d.text) t.textContent = d.text;
  },

  // ── Events from the save paths (project.js) ──
  begin() { this.status = 'saving'; this.render(); },
  saved() {
    this.status = 'idle'; this.failedOffline = false; this.savedAt = Date.now(); this._pid = AppState.projectId;
    this.render();
  },
  failed(offline) { this.status = 'failed'; this.failedOffline = !!offline; this.render(); },
  conflict() { this.status = 'conflict'; this.render(); },
  // The user chose not to overwrite, or the save was abandoned: back to what the data says
  cancelled() { this.status = 'idle'; this.render(); },

  // AppState.dirty was set (state.js)
  onDirty(v) {
    if (v) { if (this.status === 'failed') this.status = 'failed'; this._schedule(); }
    this.render();
  },

  _cancel() { clearTimeout(this._timer); this._timer = null; },
  _schedule() {
    this._cancel();
    if (!this.autoOn()) return;
    this._timer = setTimeout(() => this._run(), this.IDLE_MS);
  },

  async _run() {
    this._timer = null;
    const s = this._snapshot();
    if (!s.auto || !s.projectId || !s.dirty || s.readOnly || s.status === 'saving' || s.status === 'conflict') return;
    // Not closer than MIN_GAP_MS to the last one: wait out the difference
    const wait = this.MIN_GAP_MS - (s.now - s.lastAutoAt);
    if (wait > 0) { this._timer = setTimeout(() => this._run(), wait); return; }
    this._lastAutoAt = Date.now();
    await Project.autoSaveNow();
    // Edits made while it saved: go round again
    if (AppState.dirty && this.status !== 'conflict') this._schedule();
  },

  // A revision snapshot with an autosave: at most one every REV_GAP_MS
  revisionDue(now = Date.now()) { return now - this._lastRevAt >= this.REV_GAP_MS; },
  revisionMade() { this._lastRevAt = Date.now(); },

  init() {
    document.getElementById('save-chip')?.addEventListener('click', () => {
      const k = document.getElementById('save-chip').dataset.state;
      if (k === 'unsaved' || k === 'new' || k === 'failed' || k === 'conflict') Project.saveProject();
    });
    window.addEventListener('online', () => { if (this.status === 'failed') this.status = 'idle'; this.render(); this._schedule(); });
    window.addEventListener('offline', () => this.render());
    // "2 min ago" moves on; a project opened or replaced resets the time
    setInterval(() => {
      if (this._pid !== AppState.projectId) { this._pid = AppState.projectId; this.savedAt = null; if (this.status !== 'saving') this.status = 'idle'; }
      this.render();
    }, 5000);
    this.render();
  },
};

if (typeof window !== 'undefined') window.SaveState = SaveState;
if (typeof module !== 'undefined') module.exports = SaveState;
