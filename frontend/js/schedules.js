/* ProtectionPro — Schedules workspace.
 *
 * A full-screen view of every distribution board in the project: a board rail
 * on the left, the selected board's circuit schedule filling the pane on the
 * right. The #db-modal remains for a quick look at one board from the SLD;
 * this is the surface for actually working through a set of schedules.
 *
 * It owns NO grid rendering. DBSchedule.openInline() points the same renderer
 * the modal uses at #sch-grid-host, so every grid feature (keyboard nav, TSV
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
  _commitTimer: null,
  _checkTimer: null,
  _checkRan: false,     // has the user asked for a check at least once?

  IDLE_COMMIT_MS: 1500,
  CHECK_DEBOUNCE_MS: 1200,

  init() {
    this.buildDOM();
    window.addEventListener('beforeunload', () => this._commitCurrent());
  },

  buildDOM() {
    const ws = document.getElementById('schedules-workspace');
    if (!ws || this._built) return;
    const methodOpts = (typeof IEC_INSTALLATION_METHODS !== 'undefined'
      ? IEC_INSTALLATION_METHODS : [])
      .map(m => `<option value="${m.code}"${m.code === 'B1' ? ' selected' : ''}>${escHtml(m.code)} — ${escHtml(m.description)}</option>`)
      .join('');
    const groupOpts = (typeof IEC_GROUPING_FACTORS !== 'undefined'
      ? Object.keys(IEC_GROUPING_FACTORS) : ['bunched'])
      .map(k => `<option value="${k}">${escHtml(k.replace(/_/g, ' '))}</option>`)
      .join('');

    ws.innerHTML = `
      <div class="sch-toolbar">
        <span class="sch-title">Circuit Schedules</span>
        <span class="sch-sep"></span>
        <button class="btn-small btn-primary" id="sch-run-check"
          title="Run the per-way cable check on every board — derated ampacity, Ib ≤ In ≤ Iz, voltage drop, ECC size and earth-fault loop Zs">Check circuits</button>
        <span class="sch-sep"></span>
        <label title="Ambient temperature used for the IEC 60364-5-52 derating">Ambient
          <input type="number" id="sch-ambient" value="30" min="10" max="60" step="5"> °C</label>
        <label title="IEC 60364-5-52 reference installation method">Method
          <select id="sch-method">${methodOpts}</select></label>
        <label title="Grouping arrangement and the number of circuits sharing the route">Grouping
          <select id="sch-grouping">${groupOpts}</select>
          <input type="number" id="sch-group-n" value="0" min="0" step="1"
            title="Circuits per group. 0 = use the board's own way count."></label>
        <span class="sch-status" id="sch-status"></span>
      </div>
      <div class="sch-body">
        <aside class="sch-rail">
          <div class="sch-rail-head">Boards</div>
          <ul id="sch-board-list" role="listbox" aria-label="Distribution boards" tabindex="0"></ul>
          <div class="sch-rail-foot" id="sch-rail-foot"></div>
        </aside>
        <section class="sch-grid-pane">
          <div class="sch-grid-head" id="sch-grid-head"></div>
          <div id="sch-grid-host"></div>
        </section>
      </div>`;

    ws.querySelector('#sch-run-check').addEventListener('click', () => this.runCheck(true));
    for (const id of ['sch-ambient', 'sch-method', 'sch-grouping', 'sch-group-n']) {
      ws.querySelector('#' + id).addEventListener('change', () => {
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
    const boards = this._boards();
    if (!boards.some(b => b.id === this._boardId)) {
      this._boardId = boards.length ? boards[0].id : null;
    }
    this.render();
    this._openCurrent();
  },

  deactivate() {
    this._active = false;
    this._commitCurrent();
    clearTimeout(this._commitTimer);
    clearTimeout(this._checkTimer);
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
  _boards() {
    return [...AppState.components.values()]
      .filter(c => c.type === 'distribution_board')
      .sort((a, b) => String(a.props.name || a.id)
        .localeCompare(String(b.props.name || b.id), undefined, { numeric: true }));
  },

  selectBoard(id) {
    if (id === this._boardId) return;
    this._commitCurrent();
    this._boardId = id;
    this.render();
    this._openCurrent();
  },

  _openCurrent() {
    const host = document.getElementById('sch-grid-host');
    if (!host) return;
    if (!this._boardId) {
      DBSchedule.currentId = null;
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
    return !!(t && t.closest && t.closest('#db-bulk-bar, .db-sel-cell'));
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
    return {
      ambient: document.getElementById('sch-ambient'),
      method: document.getElementById('sch-method'),
      grouping: document.getElementById('sch-grouping'),
      groupN: document.getElementById('sch-group-n'),
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
    c.grouping.value = inst.grouping || 'bunched';
    c.groupN.value = inst.circuits ?? 0;
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
    const cur = comp.props.way_install || null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    comp.props.way_install = next;
    this._onGridEdit();
  },

  // ── Circuit check ───
  runCheck(explicit) {
    if (explicit) this._checkRan = true;
    clearTimeout(this._checkTimer);
    return DBSchedule.runCheck().then(() => {
      const host = document.getElementById('sch-grid-host');
      if (host) host.classList.remove('db-res-stale');
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
        <li class="sch-board${b.id === this._boardId ? ' active' : ''}" data-id="${escHtml(b.id)}"
            role="option" aria-selected="${b.id === this._boardId}">
          <span class="sch-board-name"><span class="sch-dot st-${status}"></span>${escHtml(b.props.name || b.id)}</span>
          <span class="sch-board-meta">${escHtml(bits.join(' · '))}</span>
        </li>`;
    }).join('') || '<li class="sch-board-meta" style="padding:10px;">No boards</li>';

    list.querySelectorAll('.sch-board[data-id]').forEach(li => {
      li.addEventListener('click', () => this.selectBoard(li.dataset.id));
    });

    const totalWays = boards.reduce((n, b) => n + (b.props.circuits || []).length, 0);
    const s = (res && res.summary) || null;
    foot.textContent = `${boards.length} board${boards.length === 1 ? '' : 's'} · ${totalWays} ways`
      + (s ? ` · ${s.fail} fail, ${s.warn} warn` : '');

    const comp = AppState.components.get(this._boardId);
    head.innerHTML = comp
      ? `<strong>${escHtml(comp.props.name || comp.id)}</strong>
         <span style="color:var(--text-secondary);font-size:12px;">
           ${(comp.props.circuits || []).length} ways · ${Number(comp.props.voltage_kv || 0.4) * 1000} V
         </span>`
      : '';
  },
};
