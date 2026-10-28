/* ProtectionPro — Schedules workspace.
 *
 * A full-screen view of every distribution board in the project: a board rail
 * on the left, the selected board's circuit schedule filling the pane on the
 * right. This is the ONE circuit-schedule surface: every entry point (the
 * board's properties button, right-click, double-click, the plan editor, the
 * phone) goes through openBoard(), and a "back" button returns to wherever
 * the user came from.
 *
 * It owns NO grid rendering. DBSchedule.openInline() points the same renderer
 * at #sch-grid-host, so every grid feature (keyboard nav, TSV
 * paste, bulk edit, presets, XLSX, EL panel, phase bars, result columns) is
 * shared rather than reimplemented.
 *
 * Commit model: DBSchedule.commit() is diff-aware and idempotent, so calling
 * it costs nothing when nothing changed. The workspace therefore commits at
 * every natural boundary — board switch, workspace exit, page unload, and
 * after an idle pause — rather than needing a modal's close event.
 */

const Schedules = {
  _active: false,
  _built: false,
  _boardId: null,
  _tab: 'grid',         // 'grid' | 'drawing' | 'ga'
  _installOpen: false,  // installation-conditions editor expanded under the board title
  _coordWay: null,      // way id shown on the Coordination tab
  _returnTo: null,      // workspace key to go back to after openBoard() from elsewhere
  _commitTimer: null,
  _checkTimer: null,
  _checkRan: false,     // has the user asked for a check at least once?

  IDLE_COMMIT_MS: 1500,
  CHECK_DEBOUNCE_MS: 1200,

  init() {
    this.buildDOM();
    window.addEventListener('beforeunload', () => this._commitCurrent());
    // Rotating a phone / resizing across 768 px swaps the grid for the card list.
    const mq = window.matchMedia('(max-width: 768px)');
    const swap = () => {
      if (this._active && this._tab === 'grid' && this._boardId) { this._commitCurrent(); this._openCurrent(); }
    };
    if (mq.addEventListener) mq.addEventListener('change', swap); else if (mq.addListener) mq.addListener(swap);
  },

  buildDOM() {
    const ws = document.getElementById('schedules-workspace');
    if (!ws || this._built) return;
    const methodOpts = IEC_INSTALLATION_METHODS
      .map(m => `<option value="${escHtml(m.code)}"${m.code === 'B1' ? ' selected' : ''}>${escHtml(m.code)} — ${escHtml(m.description)}</option>`)
      .join('');
    const groupOpts = IecAmpacity.groupingOptions('B1')
      .map(([k, l]) => `<option value="${k}">${escHtml(l)}</option>`)
      .join('');

    // One header row: back, the board rail toggle, the board + its view tabs
    // (#sch-grid-head, rendered by render()), the status line and the check.
    // Everything the board itself needs (bulk edit, protection, sections, EL,
    // accessories) is DBSchedule's side panel, so the grid gets the window.
    ws.innerHTML = `
      <div class="sch-toolbar">
        <button class="btn-small" id="sch-back" style="display:none"
          title="Return to where you opened this schedule from"></button>
        <button class="btn-small sch-icon-btn" id="sch-rail-toggle" aria-expanded="true"
          title="Show or hide the board list" aria-label="Show or hide the board list">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path></svg></button>
        <div class="sch-grid-head" id="sch-grid-head"></div>
        <span class="sch-status" id="sch-status"></span>
        <button class="btn-small btn-primary" id="sch-run-check"
          title="Run the per-way cable check on every board — derated ampacity, Ib ≤ In ≤ Iz, voltage drop, ECC size and earth-fault loop Zs">Check circuits</button>
        <button class="btn-small sch-icon-btn" id="sch-side-toggle" aria-expanded="false"
          title="Board settings: incoming protection, common circuits, sections, earth leakage and accessories. Ticking ways opens it as bulk edit.">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path></svg>
          Board settings</button>
        <div class="sch-install" id="sch-install" role="dialog" aria-label="Installation conditions">
          <div class="sch-install-title">Installation conditions
            <span>Used for the cable derating, voltage-drop limits and grouping of every way on this board</span></div>
          <label title="Ambient temperature used for the IEC 60364-5-52 derating">Ambient (°C)
            <input type="number" id="sch-ambient" value="30" min="10" max="60" step="5"></label>
          <label title="IEC 60364-5-52 reference installation method">Method
            <select id="sch-method">${methodOpts}</select></label>
          <label title="IEC 60364-5-52 Table G.52.1 voltage-drop limits from the origin: public LV supply 3 % lighting / 5 % other; private supply (own transformer or generator) 6 % / 8 %">Supply
            <select id="sch-supply"><option value="public">Public LV (3/5 %)</option><option value="private">Private (6/8 %)</option></select></label>
          <div class="sch-install-row">
            <label title="Grouping arrangement">Grouping
              <select id="sch-grouping">${groupOpts}</select></label>
            <label title="Circuits per group. 0 = use the board's own way count.">Circuits
              <input type="number" id="sch-group-n" value="0" min="0" step="1"></label>
          </div>
          <div class="sch-install-foot"><button class="btn-small btn-primary" id="sch-install-done">Done</button></div>
        </div>
      </div>
      <div class="sch-body">
        <aside class="sch-rail">
          <div class="sch-rail-head" id="sch-rail-head" role="button" tabindex="0">Boards</div>
          <ul id="sch-board-list" role="listbox" aria-label="Distribution boards" tabindex="0"></ul>
          <div class="sch-rail-foot" id="sch-rail-foot"></div>
        </aside>
        <section class="sch-grid-pane">
          <div id="sch-grid-host"></div>
        </section>
      </div>`;
    this._installEl = ws.querySelector('#sch-install');
    // Every dropdown on the page searches with wildcards (one shared popup).
    if (typeof SearchSelect !== 'undefined') SearchSelect.delegate(ws);

    // Phone: the rail head folds the board list away (CSS shows it as a
    // drop-down); on a desktop the header button collapses the rail.
    const railHead = ws.querySelector('#sch-rail-head');
    const toggleRail = () => ws.querySelector('.sch-rail').classList.toggle('open');
    railHead.addEventListener('click', toggleRail);
    railHead.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRail(); } });
    ws.querySelector('#sch-rail-toggle').addEventListener('click', (e) => {
      const hidden = ws.classList.toggle('sch-rail-hidden');
      e.currentTarget.setAttribute('aria-expanded', String(!hidden));
    });
    ws.querySelector('#sch-side-toggle').addEventListener('click', () => this.setSidePanel(ws.classList.contains('sch-side-hidden')));
    this._sidePinned = false;
    try { this._sidePinned = localStorage.getItem('protectionpro-sch-side') === '1'; } catch (e) { /* storage blocked */ }
    this._syncSide(false);
    ws.querySelector('#sch-install-done').addEventListener('click', () => this._toggleInstall(false));
    document.addEventListener('pointerdown', (e) => {
      if (!this._installOpen || !this._installEl) return;
      // .ss-pop: a dropdown's search popup lives on <body>, not in the panel.
      if (this._installEl.contains(e.target) || (e.target.closest && e.target.closest('#sch-install-edit, .ss-pop'))) return;
      this._toggleInstall(false);
    });
    this._installEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this._toggleInstall(false); } });

    ws.querySelector('#sch-run-check').addEventListener('click', () => this.runCheck(true));
    ws.querySelector('#sch-back').addEventListener('click', () => this.goBack());
    for (const id of ['sch-ambient', 'sch-method', 'sch-grouping', 'sch-group-n', 'sch-supply']) {
      ws.querySelector('#' + id).addEventListener('change', () => {
        if (id === 'sch-method') {
          const c = this._installControls();
          this._fillGrouping(c.method.value, c.grouping.value);
        }
        this._writeInstallToBoard();
        this._scheduleCheck();
      });
    }

    // Delegated on the PANE, not inside the rendered grid — DBSchedule.render()
    // replaces its own innerHTML wholesale, which would drop a listener bound
    // any deeper.
    const host = ws.querySelector('#sch-grid-host');
    host.addEventListener('change', (e) => { if (!this._isUiOnly(e)) this._onGridEdit(); });
    host.addEventListener('input', (e) => { if (!this._isUiOnly(e)) this._markStale(); });

    ws.querySelector('#sch-board-list').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const boards = this._boards();
      const i = boards.findIndex(b => b.id === this._boardId);
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
      if (next >= 0 && next < boards.length) this.selectBoard(boards[next].id);
    });

    this._built = true;
  },

  // ── Lifecycle (called by app.js switchWorkspace) ───
  activate() {
    this._active = true;
    // Anchor below the toolbar, whose height varies with responsive wrapping —
    // the CSS var is only a fallback. Same approach as Plan/Retic.
    const tb = document.getElementById('toolbar');
    const ws = document.getElementById('schedules-workspace');
    if (tb && ws) ws.style.top = tb.offsetHeight + 'px';
    // Sub-board feeders drawn on the SLD since the last visit.
    if (typeof DBFeeders !== 'undefined') DBFeeders.syncAll();
    const boards = this._boards();
    if (!boards.some(b => b.id === this._boardId)) {
      this._boardId = boards.length ? boards[0].id : null;
    }
    const box = document.getElementById('sch-install');
    if (box) box.classList.toggle('open', this._installOpen);
    this.render();
    this._openCurrent();
    this._syncBack();
  },

  deactivate() {
    this._active = false;
    this._commitCurrent();
    DBDrawing.unmount();
    GA.unmount();
    SchMobile.unmount();
    clearTimeout(this._commitTimer);
    clearTimeout(this._checkTimer);
    this._returnTo = null;
    // Opened from the Plan workspace: its board panel shows the way count.
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && PlanMarkup.refreshProps) PlanMarkup.refreshProps();
  },

  // The Coordination tab for one way (the grid's Coord chip is the door).
  openCoord(boardId, wayId) {
    const from = window.activeWorkspace || 'sld';
    if (from !== 'schedules') this._returnTo = from;
    this._coordWay = wayId;
    this._boardId = boardId;
    this._tab = 'coord';
    if (window.activeWorkspace === 'schedules') {
      this._commitCurrent(); this.render(); this._openCurrent();
    } else if (typeof switchWorkspace === 'function') switchWorkspace('schedules');
    this._syncBack();
  },

  // The one door to a board's schedule. From another workspace it remembers
  // where it came from so goBack() can return there with the board selected.
  openBoard(id) {
    const comp = AppState.components.get(id);
    if (!comp || comp.type !== 'distribution_board') return;
    const from = window.activeWorkspace || 'sld';
    if (from && from !== 'schedules') this._returnTo = from;
    this._boardId = id;
    this._tab = 'grid';
    if (typeof switchWorkspace === 'function') switchWorkspace('schedules');
    this._syncBack();
  },

  // " · Fed from DB-MH, way 61" — the board feeding this one, as a link.
  _fedFromHtml(comp) {
    const p = typeof DBFeeders !== 'undefined' ? DBFeeders.parentOf(comp.id) : null;
    if (!p) return '';
    return ` · <button type="button" class="sch-fed-from" data-fed-from="${escHtml(p.board.id)}" title="Open the board that feeds this one">Fed from ${escHtml(p.board.props.name || p.board.id)}, way ${escHtml(String(p.way.way ?? ''))}</button>`;
  },

  _BACK_LABELS: { sld: 'Single line', plan: 'Plan', retic: 'Demand', streetlight: 'Street lighting',
    interlock: 'Interlocking', quantities: 'Quantities', lighting: 'Lighting', sports: 'Sports fields', lightov: 'Overview' },

  _syncBack() {
    const b = document.getElementById('sch-back');
    if (!b) return;
    b.style.display = this._returnTo ? '' : 'none';
    if (this._returnTo) b.textContent = '← ' + (this._BACK_LABELS[this._returnTo] || 'Back');
  },

  goBack() {
    const to = this._returnTo;
    if (!to) return;
    const id = this._boardId;
    this._commitCurrent();
    switchWorkspace(to);
    if (to === 'sld' && id && AppState.components.has(id)) {
      AppState.select(id);
      if (typeof Canvas !== 'undefined') Canvas.render();
      if (typeof Properties !== 'undefined') Properties.show(id);
    }
  },

  // New / loaded / undone project: the board set may have changed entirely.
  onProjectChanged() {
    const boards = this._boards();
    if (!boards.some(b => b.id === this._boardId)) {
      this._boardId = boards.length ? boards[0].id : null;
    }
    if (this._active) { this.render(); this._openCurrent(); }
  },

  _status(msg) {
    const el = document.getElementById('sch-status');
    if (el) el.textContent = msg;
  },

  // ── Boards ───
  // Boards in supply order: each board followed by the sub-boards it feeds
  // (a feeder way's feedsDbId), by name at every level. `_depth` = nesting.
  _boards() {
    const byName = (a, b) => String(a.props.name || a.id)
      .localeCompare(String(b.props.name || b.id), undefined, { numeric: true });
    const all = [...AppState.components.values()].filter(c => c.type === 'distribution_board').sort(byName);
    const ids = new Set(all.map(b => b.id));
    const kids = new Map();
    const fed = new Set();
    for (const b of all) {
      for (const w of b.props.circuits || []) {
        if (w.type !== 'feeder_db' || !ids.has(w.feedsDbId) || w.feedsDbId === b.id || fed.has(w.feedsDbId)) continue;
        fed.add(w.feedsDbId);
        if (!kids.has(b.id)) kids.set(b.id, []);
        kids.get(b.id).push(AppState.components.get(w.feedsDbId));
      }
    }
    const out = [];
    this._depth = new Map();
    const walk = (b, d) => {
      if (this._depth.has(b.id)) return;
      this._depth.set(b.id, d); out.push(b);
      for (const k of (kids.get(b.id) || []).sort(byName)) walk(k, d + 1);
    };
    for (const b of all) if (!fed.has(b.id)) walk(b, 0);
    for (const b of all) walk(b, 0);           // a loop of feeders: still listed
    return out;
  },

  selectBoard(id) {
    if (id === this._boardId) return;
    this._commitCurrent();
    this._boardId = id;
    this.render();
    this._openCurrent();
  },

  // Switching tab commits first, so the drawing is always generated from
  // committed data rather than a half-typed cell.
  selectTab(tab) {
    if (tab === this._tab) return;
    this._commitCurrent();
    this._tab = tab;
    this.render();
    this._openCurrent();
  },

  _openCurrent() {
    const host = document.getElementById('sch-grid-host');
    if (!host) return;
    if (!this._boardId) {
      DBSchedule.currentId = null;
      DBDrawing.unmount();
      GA.unmount();
      SchMobile.unmount();
      host.innerHTML = `
        <div class="sch-empty">
          <p><strong>No distribution boards in this project.</strong></p>
          <p>Add a Distribution Board from the SLD palette, then come back here
             to build out its circuit schedule.</p>
          <p><button class="btn-small" id="sch-goto-sld">Go to the SLD</button></p>
        </div>`;
      const btn = host.querySelector('#sch-goto-sld');
      if (btn) btn.addEventListener('click', () => switchWorkspace('sld'));
      return;
    }
    if (this._tab === 'grid' && SchMobile.isPhone()) {
      // Phone: the card list + edit sheet replace the 30-column grid. The edit
      // session stays open (so commit / undo / result columns behave exactly as
      // for the grid) with the grid pointed at a detached node.
      DBDrawing.unmount();
      GA.unmount();
      DBSchedule._beginEdit(this._boardId);
      DBSchedule._setHost(document.createElement('div'));
      SchMobile.mount(this._boardId, host);
      this._readInstallFromBoard();
      return;
    }
    SchMobile.unmount();
    if (this._tab === 'coord') {
      // Same detached-grid arrangement as the other tabs: the edit session
      // stays open so a schedule edit made elsewhere still commits.
      DBDrawing.unmount();
      GA.unmount();
      DBSchedule._beginEdit(this._boardId);
      DBSchedule._setHost(document.createElement('div'));
      DbCoord.mount(this._boardId, host, this._coordWay);
      this._coordWay = DbCoord._wayId;
      this._readInstallFromBoard();
      return;
    }
    DbCoord.unmount();
    if (this._tab === 'ga') {
      // Same detached-grid arrangement as the single-line tab: the edit
      // session stays open so a schedule edit made elsewhere still commits.
      DBDrawing.unmount();
      DBSchedule._beginEdit(this._boardId);
      DBSchedule._setHost(document.createElement('div'));
      GA.mount(this._boardId, host);
      this._readInstallFromBoard();
      return;
    }
    GA.unmount();
    if (this._tab === 'drawing') {
      // The edit session stays open even though the grid isn't rendered: an
      // accessory edited on the drawing has to commit through the same
      // diff/undo path, and commit() is a no-op without currentId. The grid is
      // pointed at a detached node so its in-place painters (result columns,
      // totals strip) find nothing to paint instead of touching the drawing.
      DBSchedule._beginEdit(this._boardId);
      DBSchedule._setHost(document.createElement('div'));
      DBDrawing.mount(this._boardId, host);
      this._readInstallFromBoard();
      return;
    }
    DBDrawing.unmount();
    DBSchedule.openInline(this._boardId, host);
    this._readInstallFromBoard();
  },

  _commitCurrent() {
    clearTimeout(this._commitTimer);
    if (!this._active && !DBSchedule.currentId) return;
    const changed = DBSchedule.commit();
    if (changed) {
      this.render();
      // commit() runs AppState.clearResults(), which drops the check results
      // the columns are bound to. Re-run so the grid doesn't sit blank after
      // every edit burst — but only once the user has asked for a check.
      if (this._checkRan) this._scheduleCheck();
    }
    return changed;
  },

  // The grid-host listeners are delegated on the whole pane, so they also catch
  // the row-selection checkboxes and the bulk-edit panel's own controls. Those
  // change no model data — treating them as edits would dim the verdict columns
  // and start a commit timer for nothing. The bulk panel's *Apply* does mutate,
  // and calls DBSchedule._notifyEdited() explicitly.
  _isUiOnly(e) {
    const t = e && e.target;
    return !!(t && t.closest && t.closest('#db-bulk-bar, .db-sel-cell, .dbd-toolbar'));
  },

  _onGridEdit() {
    this._markStale();
    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => this._commitCurrent(), this.IDLE_COMMIT_MS);
  },

  // Dim the result columns the moment an edit invalidates them, so a stale
  // number is never mistaken for a current verdict.
  _markStale() {
    if (!this._checkRan) return;
    const host = document.getElementById('sch-grid-host');
    if (host) host.classList.add('db-res-stale');
  },

  // ── Installation conditions ───
  _installControls() {
    const q = (id) => (this._installEl ? this._installEl.querySelector('#' + id) : null);
    return {
      ambient: q('sch-ambient'),
      method: q('sch-method'),
      grouping: q('sch-grouping'),
      groupN: q('sch-group-n'),
      supply: q('sch-supply'),
    };
  },

  _readInstallFromBoard() {
    const comp = AppState.components.get(this._boardId);
    const c = this._installControls();
    if (!comp || !c.ambient) return;
    const inst = (comp.props.way_install && typeof comp.props.way_install === 'object')
      ? comp.props.way_install : {};
    c.ambient.value = inst.ambient_c ?? 30;
    c.method.value = inst.method || 'B1';
    this._fillGrouping(c.method.value, inst.grouping || 'bunched');
    c.groupN.value = inst.circuits ?? 0;
    if (c.supply) c.supply.value = inst.supply === 'private' ? 'private' : 'public';
    this._renderInstallSummary();
  },

  // Grouping rows for the method's family (air B.52.17, ducts B.52.19, direct
  // burial B.52.18); a saved legacy / other-family name maps onto its IEC row.
  _fillGrouping(method, wanted) {
    const sel = this._installControls().grouping;
    if (!sel) return;
    const keep = IecAmpacity.resolveGrouping(wanted || 'bunched', method).name;
    sel.innerHTML = IecAmpacity.groupingOptions(method)
      .map(([k, l]) => `<option value="${k}"${k === keep ? ' selected' : ''}>${escHtml(l)}</option>`).join('');
  },

  // The conditions open as a small panel under the header chip.
  _toggleInstall(open) {
    this._installOpen = open == null ? !this._installOpen : !!open;
    if (this._installEl) this._installEl.classList.toggle('open', this._installOpen);
    const chip = document.getElementById('sch-install-edit');
    if (chip) chip.setAttribute('aria-expanded', String(this._installOpen));
    if (this._installOpen) {
      const first = this._installControls().ambient;
      if (first) first.focus();
    }
  },

  // The right-hand side panel (DBSchedule's .db-side). Closed by default:
  // with it open beside the board rail, the grid's frozen columns on both
  // edges leave almost nothing for the middle ones. The header button opens it
  // for the board settings (remembered per browser); ticking ways opens it as
  // bulk edit until the selection is cleared.
  _sidePinned: false,
  setSidePanel(show) {
    this._sidePinned = !!show;
    try { localStorage.setItem('protectionpro-sch-side', show ? '1' : '0'); } catch (e) { /* storage blocked */ }
    this._syncSide(typeof DBSchedule !== 'undefined' && DBSchedule._selected && DBSchedule._selected.size > 0 && show);
  },

  _syncSide(hasSelection) {
    const ws = document.getElementById('schedules-workspace');
    if (!ws) return;
    const show = this._sidePinned || !!hasSelection;
    ws.classList.toggle('sch-side-hidden', !show);
    const b = document.getElementById('sch-side-toggle');
    if (b) b.setAttribute('aria-expanded', String(show));
  },

  // One quiet line: the conditions in force, in words.
  _renderInstallSummary() {
    const el = document.getElementById('sch-install-sum');
    const comp = AppState.components.get(this._boardId);
    if (!el || !comp) return;
    const inst = (comp.props.way_install && typeof comp.props.way_install === 'object') ? comp.props.way_install : {};
    const method = inst.method || 'B1';
    const m = (typeof IEC_INSTALLATION_METHODS !== 'undefined' ? IEC_INSTALLATION_METHODS : []).find(x => x.code === method);
    const gName = IecAmpacity.resolveGrouping(inst.grouping || 'bunched', method).name;
    const g = (IecAmpacity.groupingOptions(method).find(([k]) => k === gName) || [])[1] || gName;
    el.textContent = `${method} · ${inst.ambient_c ?? 30} °C · ${inst.supply === 'private' ? 'Private 6/8 %' : 'Public 3/5 %'}`
      + (inst.circuits ? ` · ${inst.circuits} grouped` : '');
    const chip = el.closest('button');
    if (chip) chip.title = `Installation conditions: ambient ${inst.ambient_c ?? 30} °C · method ${method}${m ? ' ' + m.description : ''} · `
      + `${inst.supply === 'private' ? 'private supply (6/8 %)' : 'public LV (3/5 %)'} · grouping ${g}`
      + (inst.circuits ? ` (${inst.circuits} circuits)` : '') + '. Click to edit.';
  },

  // Writes only when something actually differs, so merely visiting a board
  // never dirties it (DBSchedule.commit() diffs way_install).
  _writeInstallToBoard() {
    const comp = AppState.components.get(this._boardId);
    const c = this._installControls();
    if (!comp || !c.ambient) return;
    const next = {
      ambient_c: parseFloat(c.ambient.value) || 30,
      method: c.method.value || 'B1',
      grouping: c.grouping.value || 'bunched',
      circuits: parseInt(c.groupN.value, 10) || 0,
    };
    // Only stored when non-default, so boards saved before this field stay
    // byte-identical when merely visited.
    if (c.supply && c.supply.value === 'private') next.supply = 'private';
    const cur = comp.props.way_install || null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    comp.props.way_install = next;
    this._renderInstallSummary();
    this._onGridEdit();
  },

  // ── Circuit check ───
  runCheck(explicit) {
    if (explicit) this._checkRan = true;
    clearTimeout(this._checkTimer);
    return DBSchedule.runCheck().then(() => {
      const host = document.getElementById('sch-grid-host');
      if (host) host.classList.remove('db-res-stale');
      // The drawing colours its way drops by the same verdicts.
      if (this._tab === 'drawing') DBDrawing.render();
      if (this._tab === 'coord') DbCoord.refresh();
    });
  },

  // Debounced refresh. Deliberately inert until the first explicit run: an
  // unprompted backend call (load flow + Thevenin solve) on project load would
  // be surprising and is not free.
  _scheduleCheck() {
    if (!this._checkRan) return;
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => this.runCheck(false), this.CHECK_DEBOUNCE_MS);
  },

  // ── Rail + header ───
  render() {
    if (!this._built) return;
    const list = document.getElementById('sch-board-list');
    const foot = document.getElementById('sch-rail-foot');
    const head = document.getElementById('sch-grid-head');
    if (!list) return;

    const res = AppState.dbCheckResults;
    const byBoard = new Map(((res && res.boards) || []).map(b => [b.id, b]));
    const boards = this._boards();

    list.innerHTML = boards.map(b => {
      const r = byBoard.get(b.id);
      const circuits = b.props.circuits || [];
      const ways = circuits.length;
      // Summed from the ways directly, not from the derived rated_kva prop —
      // that is only written on commit, so a board browsed but not yet edited
      // would otherwise read 0.0 kVA.
      const kva = circuits.reduce((n, c) => n + (Number(c.load_va) || 0), 0) / 1000;
      const status = r ? r.worst_status : 'none';
      const bits = [`${ways} way${ways === 1 ? '' : 's'}`, `${kva.toFixed(1)} kVA`];
      if (r && r.counts.fail) bits.push(`${r.counts.fail} fail`);
      else if (r && r.counts.warn) bits.push(`${r.counts.warn} warn`);
      return `
        <li class="sch-board${b.id === this._boardId ? ' active' : ''}${(this._depth.get(b.id) || 0) ? ' sch-board-child' : ''}" data-id="${escHtml(b.id)}"
            role="option" aria-selected="${b.id === this._boardId}"
            style="${(this._depth.get(b.id) || 0) ? `padding-left:${10 + Math.min(4, this._depth.get(b.id)) * 14}px` : ''}">
          <span class="sch-board-name"><span class="sch-dot st-${status}"></span>${escHtml(b.props.name || b.id)}</span>
          <span class="sch-board-meta">${escHtml(bits.join(' · '))}</span>
        </li>`;
    }).join('') || '<li class="sch-board-meta" style="padding:10px;">No boards</li>';

    list.querySelectorAll('.sch-board[data-id]').forEach(li => {
      li.addEventListener('click', () => {
        const rail = document.querySelector('#schedules-workspace .sch-rail');
        if (rail) rail.classList.remove('open');
        this.selectBoard(li.dataset.id);
      });
    });

    list.querySelectorAll('.sch-board[data-id]').forEach(li => {
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = li.dataset.id;
        if (typeof ContextMenu === 'undefined') return;
        ContextMenu.open([
          { label: 'Open schedule', action: () => this.selectBoard(id) },
          { label: 'Properties…', action: () => {
            if (typeof PropWindow !== 'undefined') PropWindow.open(id);
            else Properties.show(id);
          } },
          '---',
          { label: 'Check circuits', action: () => { this.selectBoard(id); this.runCheck(true); } },
        ], e.clientX, e.clientY);
      });
    });

    const totalWays = boards.reduce((n, b) => n + (b.props.circuits || []).length, 0);
    const s = (res && res.summary) || null;
    foot.textContent = `${boards.length} board${boards.length === 1 ? '' : 's'} · ${totalWays} ways`
      + (s ? ` · ${s.fail} fail, ${s.warn} warn` : '');

    if (SchMobile._host) SchMobile.render();
    const comp = AppState.components.get(this._boardId);
    const railHead = document.getElementById('sch-rail-head');
    if (railHead) {
      railHead.textContent = comp
        ? `Board: ${comp.props.name || comp.id} (${boards.length})` : 'Boards';
    }
    const tab = (id, label, title) => `<button class="sch-tab${this._tab === id ? ' active' : ''}" data-sch-tab="${id}"
             role="tab" aria-selected="${this._tab === id}"${title ? ` title="${escHtml(title)}"` : ''}>${label}</button>`;
    head.innerHTML = comp
      ? `<span class="sch-board-title"><strong>${escHtml(comp.props.name || comp.id)}</strong>
           <span class="sch-board-sub">${(comp.props.circuits || []).length} ways · ${Number(comp.props.voltage_kv || 0.4) * 1000} V${this._fedFromHtml(comp)}</span></span>
         <span class="sch-tabs" role="tablist">
           ${tab('grid', 'Schedule')}
           ${tab('coord', 'Coordination', 'Mini TCC: a way against the breakers above it — discrimination, cable protection, breaking capacity')}
           ${tab('drawing', 'Single Line', 'Single-line drawing generated from this schedule')}
           ${tab('ga', 'Layout (GA)', 'General arrangement: physical front view and enclosure size')}
         </span>
         <button class="sch-chip" id="sch-install-edit" aria-expanded="${this._installOpen}" aria-haspopup="dialog">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path></svg>
           <span class="sch-install-sum" id="sch-install-sum"></span></button>`
      : '';
    const ed = head.querySelector('#sch-install-edit');
    if (ed) ed.addEventListener('click', () => this._toggleInstall());
    if (!comp && this._installOpen) this._toggleInstall(false);
    this._renderInstallSummary();
    head.querySelectorAll('[data-fed-from]').forEach(btn => {
      btn.addEventListener('click', () => this.selectBoard(btn.dataset.fedFrom));
    });
    head.querySelectorAll('[data-sch-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.selectTab(btn.dataset.schTab));
    });
  },
};
