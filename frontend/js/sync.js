/* ProtectionPro — the sync pass: every workspace kept current without buttons.
 *
 * One pass runs a moment after each finished edit (UX workflow review, item 2):
 * AppState.dirty = true wakes it (the same hook Collab uses), it waits until
 * the edit has finished — about 0.3 s after the last change, and never while a
 * pointer is held down (a drag) — then runs the registered routines in a fixed
 * order. Each routine matches by id and updates in place, so a second pass
 * changes nothing.
 *
 * Rules (see reviews/ux-workflow-review):
 *   · takes no undo snapshots — everything it writes is worked out from the
 *     sources, so undoing the edit and re-running puts everything back;
 *   · redraws only the workspace on screen;
 *   · never asks: a question a routine used to ask becomes an Issues entry
 *     (ctx.issue) or a notice (ctx.notice);
 *   · only the person who made the edit runs it — remote co-editing changes
 *     do not start a pass, and its own writes go out as ordinary changes;
 *   · behind the project setting "Keep workspaces in sync"
 *     (AppState.keepInSync): on for new projects, and switched on for an old
 *     project when it opens, with every value that differs from its source
 *     kept as an override (an `adopt` pass), so no number changes on open.
 *
 * Overrides: a value typed where another workspace owns it is kept and shown
 * as an override with Reset. A routine reads every owned value through
 * ctx.value(key, source, current): with no override it returns the source;
 * with one, the typed value. In an adopt pass a value that differs from its
 * source becomes an override instead of being overwritten.
 *
 * A routine: { id, order, label, run(ctx) } registered with Sync.register.
 * run() returns whether it changed anything; ctx.touch(group) names what to
 * redraw ('sld' | 'plan' | 'retic' | 'sl' | 'rp' | 'schedules').
 */

const Sync = {
  DEBOUNCE_MS: 300,
  SLOW_MS: 100,          // a pass slower than this is reported in Sync.lastRun
  routines: [],
  issues: [],            // [{ routine, key, text, action? }] from the last pass
  lastRun: null,         // { ms, changed: [routine ids], at, adopt }
  _timer: null,
  _running: false,
  _pointerDown: false,
  _quiet: 0,             // > 0 while edits must not start a pass (remote apply)

  init() {
    // A drag is a held pointer: never run in the middle of one.
    const down = () => { this._pointerDown = true; };
    const up = () => {
      this._pointerDown = false;
      if (this._waiting) { this._waiting = false; this._schedule(); }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
  },

  register(routine) {
    this.routines = this.routines.filter(r => r.id !== routine.id).concat([routine])
      .sort((a, b) => a.order - b.order);
  },

  enabled() { return AppState.keepInSync !== false && !AppState.readOnly; },

  // Changes that must not start a pass (a remote co-editor's edit arriving).
  quietly(fn) {
    this._quiet++;
    try { return fn(); } finally { this._quiet--; }
  },

  // Called from the AppState.dirty accessor on every edit.
  kick() {
    // The pass's own writes (it runs synchronously, so nothing else can edit
    // meanwhile) and remote edits do not start another pass.
    if (this._quiet || this._running || !this.enabled()) return;
    this._schedule();
  },

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._pointerDown) { this._waiting = true; return; }
      this.run();
    }, this.DEBOUNCE_MS);
  },

  // Run every routine once. opts.adopt: record differing values as overrides
  // instead of overwriting them (first pass on an old project).
  run(opts = {}) {
    if (this._running || !this.routines.length) return null;
    if (!opts.adopt && !this.enabled()) return null;
    this._running = true;
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const wasDirty = AppState.dirty;
    const touched = new Set();
    const changed = [];
    const issues = [];
    const pause = this._pauseUndo();
    try {
      for (const r of this.routines) {
        const ctx = this._ctx(r, opts, touched, issues);
        let did = false;
        try { did = !!r.run(ctx); }
        catch (e) { console.error(`Sync: ${r.id} failed`, e); issues.push({ routine: r.id, key: r.id + ':error', text: `${r.label || r.id} could not update: ${e.message || e}` }); }
        if (did) changed.push(r.id);
      }
    } finally {
      pause();
    }
    this.issues = issues;
    // An adopt pass only records what was already there: opening a project
    // must not mark it as changed.
    if (opts.adopt) AppState.dirty = wasDirty;
    else if (changed.length) AppState.dirty = true;
    if (changed.length && typeof AppState.invalidateResults === 'function') AppState.invalidateResults();
    this._redraw(touched);
    this._running = false;
    const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    this.lastRun = { ms: +ms.toFixed(1), changed, at: Date.now(), adopt: !!opts.adopt };
    if (ms > this.SLOW_MS) console.warn(`Sync pass took ${ms.toFixed(0)} ms`, changed);
    return this.lastRun;
  },

  _ctx(routine, opts, touched, issues) {
    const adopt = !!opts.adopt;
    const ov = () => (AppState.syncOverrides || (AppState.syncOverrides = {}));
    return {
      adopt,
      touch(group) { touched.add(group); },
      issue(key, text, action) { issues.push({ routine: routine.id, key, text, action: action || null }); },
      notice(text, kind = 'info') { if (!adopt && typeof UI !== 'undefined' && UI.toast) UI.toast(text, kind, 5000); },
      // The value for a field owned elsewhere. `source` is the owner's value,
      // `current` what the field holds now. Returns what the field should hold.
      value(key, source, current) {
        const o = ov()[key];
        if (o) {
          // Keep the owner's figure current for the "typed · plan 38 m" note.
          if (!Sync.same(o.src, source)) o.src = source;
          return o.v;
        }
        if (adopt && current != null && current !== '' && current !== 0 && !Sync.same(current, source)) {
          ov()[key] = { v: current, src: source };
          return current;
        }
        return source;
      },
      override(key) { return ov()[key] || null; },
    };
  },

  same(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    return JSON.stringify(a) === JSON.stringify(b);
  },

  // After a project opens: an old project (saved before the setting) gets an
  // adopt pass; a current one with sync on gets an ordinary pass, so it is
  // current from the start.
  adoptOnOpen() {
    if (AppState._syncAdoptPending) {
      AppState._syncAdoptPending = false;
      return this.run({ adopt: true });
    }
    if (!this.enabled()) return null;
    const wasDirty = AppState.dirty;
    const r = this.run();
    // Bringing derived values up to date on open is not an edit of the file.
    AppState.dirty = wasDirty;
    return r;
  },

  // ── Deletions made by the user (not by the pass, not by an undo) ──
  // AppState.removeComponent, PlanMarkup.deleteSelected and Demand's deletes
  // mark what the user deleted; the Building and Reticulation syncs read the
  // marks to tell a deletion (carried to the other view) from an undo.
  // side: 'sld' | 'plan' | 'retic'. takeDeleted(side, keep) takes only the
  // ids `keep` accepts (the rest stay for another routine), or all of them.
  _deleted: { sld: new Set(), plan: new Set(), retic: new Set() },
  markDeleted(side, id) { if (!this._running && id) this._deleted[side].add(id); },
  takeDeleted(side, keep) {
    const s = this._deleted[side];
    if (!keep) { this._deleted[side] = new Set(); return s; }
    const out = new Set();
    for (const id of s) if (keep(id)) { out.add(id); s.delete(id); }
    return out;
  },

  // ── Fields owned by another workspace ──
  // A field listed here, edited by hand, becomes an override (kept by the
  // pass) and shows a note with Reset in the properties panel.
  OWNED: [
    {
      // An SLD feeder cable measured on a floor plan (plan feeder or riser legs).
      match: (comp, key) => comp.type === 'cable' && key === 'length_km' && (comp.planLink || comp.riserLink),
      key: (comp) => 'len:' + comp.id,
      label: 'plan',
      show: (v) => (v == null || v === '' ? '—' : `${(+v * 1000).toFixed(1).replace(/\.0$/, '')} m`),
    },
  ],
  _owned(comp, key) { return (comp && this.OWNED.find(o => o.match(comp, key))) || null; },

  // The properties panel calls this whenever it writes a field (live or on
  // commit), before the next pass can run.
  onFieldEdited(comp, key, before, value) {
    const o = this._owned(comp, key);
    if (!o || this._running) return;
    const k = o.key(comp);
    const cur = this.override(k);
    this.setOverride(k, value, cur ? cur.src : before);
  },

  // A note beside an owned field: "from plan", or "typed · plan 38 m" + Reset.
  fieldFlagHtml(comp, key) {
    const o = this._owned(comp, key);
    if (!o || AppState.keepInSync === false) return '';
    const ov = this.override(o.key(comp));
    if (!ov) return `<span class="prop-sync-flag" title="Measured on the ${escHtml(o.label)}: it follows the drawing. Type a value to keep your own.">from ${escHtml(o.label)}</span>`;
    return `<span class="prop-sync-flag prop-sync-flag--typed" title="Typed here — the ${escHtml(o.label)} measures ${escHtml(o.show(ov.src))}. Reset to follow the ${escHtml(o.label)} again.">typed · ${escHtml(o.label)} ${escHtml(o.show(ov.src))}</span>`
      + `<button type="button" class="prop-sync-reset" data-sync-reset="${escHtml(o.key(comp))}" title="Follow the ${escHtml(o.label)} again">Reset</button>`;
  },

  // ── Overrides (a value typed where another workspace owns it) ──
  override(key) { return (AppState.syncOverrides || {})[key] || null; },
  setOverride(key, value, source) {
    if (!AppState.syncOverrides) AppState.syncOverrides = {};
    if (this.same(value, source)) delete AppState.syncOverrides[key];
    else AppState.syncOverrides[key] = { v: value, src: source };
  },
  // Reset: the field follows its owner again on the next pass.
  resetOverride(key) {
    if (AppState.syncOverrides && AppState.syncOverrides[key]) {
      delete AppState.syncOverrides[key];
      AppState.dirty = true;
    }
  },

  // No undo snapshots while the pass writes (both undo stacks).
  _pauseUndo() {
    const um = typeof UndoManager !== 'undefined' ? UndoManager : null;
    const pm = typeof PlanMarkup !== 'undefined' ? PlanMarkup : null;
    const was = um ? um._paused : false;
    if (um) um._paused = true;
    const snap = pm && pm.snapshot;
    if (pm && snap) pm.snapshot = () => {};
    return () => { if (um) um._paused = was; if (pm && snap) pm.snapshot = snap; };
  },

  // Redraw only what is on screen.
  _redraw(touched) {
    if (!touched.size) return;
    const ws = typeof window !== 'undefined' ? window.activeWorkspace : null;
    if (touched.has('sld') && (!ws || ws === 'sld') && typeof Canvas !== 'undefined') Canvas.render();
    if (touched.has('schedules') && ws === 'schedules' && typeof Schedules !== 'undefined' && Schedules.render) Schedules.render();
    if (typeof CollabData !== 'undefined' && CollabData.refresh) CollabData.refresh(touched);
  },
};

// ── Routine: site plan → Demand (Reticulation) ──
// Minisubs, kiosks and erven drawn on the site plan, which kiosk feeds which,
// and the measured feeder, service and MV lengths go to Demand; a deletion on
// either side is carried to the other. Replaces Output › Push to Demand
// schedules while the setting is on.
Sync.register({
  id: 'retic',
  order: 30,
  label: 'Site plan → Demand',
  run(ctx) {
    if (typeof PlanSync === 'undefined' || !PlanSync.reticInUse()) return false;
    const changed = PlanSync.syncRetic({ issue: ctx.issue, notice: ctx.notice, value: ctx.value });
    if (changed) { ctx.touch('retic'); ctx.touch('plan'); }
    return changed;
  },
});

// ── Routine: site plan and road plan → street-lighting circuits ──
// Poles drawn on the site plan from a kiosk or minisub, and roads with a feed
// point in the road plan, are Street lighting circuits (spans measured, kept
// as overrides where typed); their load goes to Demand. Runs after the
// Reticulation routine, which gives the drawn sources their Demand rows.
// Replaces "Sync from site plan" and "Import from road plan".
Sync.register({
  id: 'streetlight',
  order: 40,
  label: 'Site plan and road plan → street lighting',
  run(ctx) {
    if (typeof StreetLight === 'undefined' || !AppState.reticulation || !StreetLight.syncInUse()) return false;
    const changed = StreetLight.syncAll({ issue: ctx.issue, notice: ctx.notice, value: ctx.value });
    if (changed) { ctx.touch('sl'); ctx.touch('rp'); ctx.touch('retic'); }
    return changed;
  },
});

// ── Routine: floor plans ⇄ single line, then devices → schedule ways ──
// Boards, feeders and riser feeders both ways (plan-sync.js), then the tagged
// devices' loads, points and routed lengths into each way (plan-circuits.js,
// called at the end of the same sync). Replaces the "Sync with single line"
// and "Count circuits into boards" buttons while the setting is on.
Sync.register({
  id: 'building',
  order: 50,
  label: 'Floor plans ⇄ single line',
  run(ctx) {
    if (typeof PlanSync === 'undefined' || !PlanSync.buildingInUse()) return false;
    const before = PlanSync.buildingFingerprint();
    if (typeof PlanCircuits !== 'undefined') PlanCircuits._adopt = ctx.adopt;
    try {
      PlanSync.syncBuildingToSLD({ interactive: false, issue: ctx.issue, notice: ctx.notice, value: ctx.value });
    } finally {
      if (typeof PlanCircuits !== 'undefined') PlanCircuits._adopt = false;
    }
    const changed = PlanSync.buildingFingerprint() !== before;
    if (changed) { ctx.touch('sld'); ctx.touch('plan'); ctx.touch('schedules'); }
    return changed;
  },
});

// ── Routine: single-line sub-board feeders → schedule ways (dbfeeders.js) ──
// Until now this ran only when a schedule or the bill of quantities opened.
Sync.register({
  id: 'sld-feeder-ways',
  order: 70,
  label: 'Single-line feeders → schedule ways',
  run(ctx) {
    if (typeof DBFeeders === 'undefined') return false;
    const changed = Sync.quietly(() => DBFeeders.syncAll());
    if (changed) { ctx.touch('schedules'); ctx.touch('sld'); }
    return changed;
  },
});

if (typeof window !== 'undefined') window.Sync = Sync;
if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
