/* ProtectionPro — one project history (UX plan item 13).
 *
 * The single line, the plan, Demand and the road plan each keep their own
 * undo stack. ProjectHistory sits over them: every snapshot they take is
 * recorded here as a named step, so
 *   • a hand-off that writes into several workspaces (Add to the single line,
 *     Push to Demand schedules, Sync with single line …) is ONE step — Undo in
 *     either workspace takes it back everywhere, Redo puts it back;
 *   • Project › Undo history… lists every step in order, whichever workspace
 *     made it, and "Go back to here" steps each workspace to where it was.
 *
 * An entry = { id, t, label, parts: [{ ws, from, to }] }: workspace `ws` went
 * from stack position `from` to `to` (a stack position is the workspace's
 * undo index). The stacks stay where they are; nothing is copied.
 * `step` / `targets` / `done` are pure given the positions (node-testable).
 */

const ProjectHistory = {
  MAX: 200,
  log: [],
  _open: null,     // a hand-off in progress: the parts it has recorded
  _busy: false,    // we are driving a workspace's own undo / redo
  _seq: 0,

  // Where each workspace's undo stack is now, and how to step it.
  ADAPTERS: {
    sld: { label: 'Single line', pos: () => typeof UndoManager !== 'undefined' ? UndoManager._index : 0, undo: () => UndoManager.undo(), redo: () => UndoManager.redo() },
    plan: { label: 'Plan', pos: () => typeof PlanMarkup !== 'undefined' ? PlanMarkup._undoIndex : 0, undo: () => PlanMarkup.undo(), redo: () => PlanMarkup.redo() },
    retic: { label: 'Demand', pos: () => typeof Retic !== 'undefined' ? Retic._undoIndex : 0, undo: () => Retic.undo(), redo: () => Retic.redo() },
    road: { label: 'Road plan', pos: () => typeof RoadPlan !== 'undefined' ? RoadPlan._undo.length : 0, undo: () => RoadPlan.undo(), redo: () => RoadPlan.redo() },
  },
  pos(ws) { const a = this.ADAPTERS[ws]; try { return a ? a.pos() : 0; } catch (e) { return 0; } },

  // A workspace took a snapshot: its stack is now at `idx`.
  record(ws, idx, label) {
    if (this._busy) return;
    if (!(idx > 0)) { this.reset(ws); return; }
    // A new action drops that workspace's redo tail.
    for (const e of this.log) e.parts = e.parts.filter(p => p.ws !== ws || p.to < idx);
    this.log = this.log.filter(e => e.parts.length);
    if (this._open) {
      const p = this._open.parts.find(x => x.ws === ws);
      if (p) p.to = idx; else this._open.parts.push({ ws, from: idx - 1, to: idx });
      if (label && !this._open.label) this._open.label = label;
      return;
    }
    this._push({ label: label || '', parts: [{ ws, from: idx - 1, to: idx }] });
  },
  _push(e) {
    e.id = ++this._seq; e.t = Date.now();
    this.log.push(e);
    if (this.log.length > this.MAX) this.log.shift();
  },
  // A workspace's stack was cleared (a project opened, a baseline taken).
  reset(ws) {
    for (const e of this.log) e.parts = e.parts.filter(p => p.ws !== ws);
    this.log = this.log.filter(e => e.parts.length);
  },
  // A workspace dropped its oldest `n` snapshots (the cap): positions move down.
  shift(ws, n = 1) {
    for (const e of this.log) {
      for (const p of e.parts) if (p.ws === ws) { p.from -= n; p.to -= n; }
      e.parts = e.parts.filter(p => p.ws !== ws || p.to > 0);
      for (const p of e.parts) if (p.ws === ws && p.from < 0) p.from = 0;
    }
    this.log = this.log.filter(e => e.parts.length);
  },

  // Run `fn` (sync or async) as one step named `label`: whatever workspaces
  // snapshot meanwhile become a single entry.
  group(label, fn) {
    if (this._open) return fn();
    this._open = { label, parts: [] };
    const close = () => {
      const g = this._open; this._open = null;
      if (!g || !g.parts.length) return;
      this._push({ label: g.label, parts: g.parts });
    };
    let r;
    try { r = fn(); } catch (e) { close(); throw e; }
    if (r && typeof r.then === 'function') return r.then(v => { close(); return v; }, e => { close(); throw e; });
    close();
    return r;
  },

  // ── Pure rules ──
  // Is the entry applied, given the stack positions `at` = { ws: pos }?
  done(e, at) { return e.parts.every(p => (at[p.ws] || 0) >= p.to); },
  // The entry Undo / Redo of `ws` would act on, as a multi-part step, or null
  // (→ the workspace just does its own single step).
  step(log, kind, ws, at) {
    if (kind === 'undo') {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i], mine = e.parts.find(p => p.ws === ws);
        if (!mine || (at[ws] || 0) !== mine.to) continue;
        return this._multi(e) && e.parts.every(p => (at[p.ws] || 0) === p.to) ? e : null;
      }
    } else {
      for (const e of log) {
        const mine = e.parts.find(p => p.ws === ws);
        if (!mine || (at[ws] || 0) !== mine.from) continue;
        return this._multi(e) && e.parts.every(p => (at[p.ws] || 0) === p.from) ? e : null;
      }
    }
    return null;
  },
  _multi(e) { return e.parts.length > 1 || e.parts[0].to - e.parts[0].from > 1; },
  // Positions every workspace should have just after entry `id`.
  targets(log, id) {
    const t = {};
    for (const e of log) {
      for (const p of e.parts) t[p.ws] = p.to;
      if (e.id === id) break;
    }
    // A workspace with no step up to there is back at its start.
    for (const e of log) for (const p of e.parts) if (!(p.ws in t)) t[p.ws] = 0;
    return t;
  },
  _at() { const at = {}; for (const ws of Object.keys(this.ADAPTERS)) at[ws] = this.pos(ws); return at; },

  // Called first thing by a workspace's undo() / redo(). True = handled as a
  // multi-workspace step (the caller returns); false = do its own single step.
  intercept(kind, ws) {
    if (this._busy) return false;
    const e = this.step(this.log, kind, ws, this._at());
    if (!e) return false;
    this._busy = true;
    try {
      for (const p of e.parts) {
        const a = this.ADAPTERS[p.ws];
        for (let i = 0; i < p.to - p.from; i++) kind === 'undo' ? a.undo() : a.redo();
      }
    } finally { this._busy = false; }
    const el = typeof document !== 'undefined' ? document.getElementById('status-info') : null;
    if (el) el.textContent = (kind === 'undo' ? 'Undid: ' : 'Redid: ') + (e.label || 'step') + ' (' + e.parts.map(p => this.ADAPTERS[p.ws].label).join(' + ') + ')';
    this._refresh();
    return true;
  },

  // Go back (or forward) to just after entry `id`.
  goTo(id) {
    const want = this.targets(this.log, id);
    this._busy = true;
    try {
      for (const [ws, t] of Object.entries(want)) {
        const a = this.ADAPTERS[ws];
        for (let guard = 0; guard < 400; guard++) {
          const cur = this.pos(ws);
          if (cur === t) break;
          const before = cur;
          cur > t ? a.undo() : a.redo();
          if (this.pos(ws) === before) break;
        }
      }
    } finally { this._busy = false; }
    this._refresh();
  },

  // ── The Undo history dialog ──
  label(e) { return e.label || 'Edit'; },
  time(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); },
  html() {
    const at = this._at();
    if (!this.log.length) return '<p class="ph-empty">Nothing to undo yet. Every change you make is listed here, whichever workspace it is in.</p>';
    return '<ol class="ph-list">' + [...this.log].reverse().map(e => {
      const d = this.done(e, at);
      const chips = e.parts.map(p => `<span class="ph-ws ph-${escHtml(p.ws)}">${escHtml(this.ADAPTERS[p.ws].label)}</span>`).join('');
      return `<li class="ph-item${d ? '' : ' ph-undone'}"><span class="ph-t">${escHtml(this.time(e.t))}</span>${chips}<span class="ph-l">${escHtml(this.label(e))}</span>`
        + `<button type="button" class="btn-small" data-ph-go="${e.id}">${d ? 'Go back to here' : 'Redo to here'}</button></li>`;
    }).join('') + '</ol>';
  },
  open() {
    let m = document.getElementById('ph-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'ph-modal';
      m.className = 'modal';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Undo history');
      m.innerHTML = '<div class="modal-content"><div class="modal-header"><h3>Undo history</h3><button class="modal-close" data-ph-close aria-label="Close">&times;</button></div>'
        + '<div class="modal-body"><p class="ph-note">Every change, newest first, whichever workspace made it. A step that touched several workspaces (a hand-off) is one line and is undone everywhere at once.</p><div id="ph-body"></div></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-ph-close]')) { m.style.display = 'none'; return; }
        const b = e.target.closest('[data-ph-go]');
        if (b) { this.goTo(+b.dataset.phGo); this._body(); }
      });
    }
    this._body();
    m.style.display = 'flex';
  },
  _body() { const b = document.getElementById('ph-body'); if (b) b.innerHTML = this.html(); },
  _refresh() {
    this._body();
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
  },

  init() {
    document.getElementById('btn-history')?.addEventListener('click', () => this.open());
    document.addEventListener('keydown', (e) => {
      const m = document.getElementById('ph-modal');
      if (e.key === 'Escape' && m && m.style.display !== 'none') { m.style.display = 'none'; }
    });
  },
};
