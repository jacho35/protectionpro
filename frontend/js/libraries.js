/* ProtectionPro — Libraries manager
 *
 * One full-screen place for everything about libraries (Project → Libraries…). The component
 * libraries (cables, circuit breakers, fuses, transformers, load classes) are EDITED here: the
 * editable tables that used to live in Settings are docked into the manager (their per-kind
 * editors, search, source chips, Add / Reset all work as before), with a detail pane beside them
 * for the selected entry — where it comes from, drift, history (restore a version), retire /
 * restore, submit to the company. Rates & prices docks the rate library; Team libraries docks the
 * shared-libraries panel under your layer order and the clash report; Out of date, Submissions,
 * Activity log and Import / export complete it. Settings no longer has library tabs; their panes live in #lib-panes and are docked here.
 *
 *   Libraries.open({ view, id })   view = a library key | 'rates' | 'drift' | 'teams' | 'activity' | 'export'
 *   Libraries.refreshBadge()       the count on the menu item (out of date + submissions waiting)
 */

const Libraries = {
  KEYS: ['cables', 'cbs', 'fuses', 'transformers', 'loadClasses'],
  LABELS: { cables: 'Cables', cbs: 'Circuit breakers', fuses: 'Fuses', transformers: 'Transformers', loadClasses: 'Load classes' },
  // Pane (#lib-pane-<tab>) that holds each library's editable table (docked here)
  TAB: { cables: 'cables', cbs: 'cbs', fuses: 'fuses', transformers: 'transformers', loadClasses: 'load-classes' },
  RENDER: { cables: 'renderCableTable', cbs: 'renderCBTable', fuses: 'renderFuseTable', transformers: 'renderTransformerTable', loadClasses: 'renderLoadClassTable' },
  ACTIONS: {
    entry_created: 'added', entry_updated: 'updated', entry_deleted: 'deleted', entry_retired: 'retired', entry_restored: 'restored',
    company_designated: 'set the company standard', company_cleared: 'cleared the company standard', currency_changed: 'changed the currency',
    member_added: 'added a member', member_role: 'changed a member’s role', member_removed: 'removed a member', member_left: 'left',
    library_created: 'created the library', library_renamed: 'renamed the library', library_deleted: 'deleted the library',
    library_owner_changed: 'handed the library over',
  },

  view: 'cables',
  _open: false,
  _sel: null,             // selected entry id (library views)
  _activity: [],
  _activityFilter: { library: '', action: '' },
  _pane: null, _ph: null, // a Settings pane docked here, and the comment marking where it lives
  _ratesIn: false,

  _admin() { return typeof Auth !== 'undefined' && Auth.isAdmin(); },
  _company() { return (StandardData._sharedLayers || []).find(l => l.is_company_default) || null; },
  _canEditCompany() { const c = this._company(); return !!c && (c.role === 'edit' || c.role === 'owner'); },

  // ── badge on the Project menu item ──
  refreshBadge() {
    const drift = typeof StandardData !== 'undefined' && StandardData._defaults ? StandardData.driftList().length : 0;
    const subm = typeof Submissions !== 'undefined' ? ((Submissions._counts.waiting || 0) + (Submissions._counts.changes_requested || 0)) : 0;
    const n = drift + subm;
    const b = document.getElementById('libraries-badge');
    if (b) { b.hidden = !n; b.textContent = String(n); }
    if (this._open) this._renderRail();
  },

  // ── screen ──
  async open(opts = {}) {
    this._build();
    if (opts.view) this.view = opts.view;
    if (opts.key) this.view = opts.key;
    this._sel = opts.id || null;
    document.getElementById('settings-modal').style.display = 'none';   // opened from a Settings tab link
    this._open = true;
    document.getElementById('lib-screen').hidden = false;
    document.body.classList.add('subm-open');
    if (typeof Submissions !== 'undefined') await Submissions.refreshBadge();
    this._render();
    document.getElementById('lib-back').focus();
  },

  async close() {
    if (!this._open) return;
    this._open = false;
    this._undock();
    document.getElementById('lib-screen').hidden = true;
    document.body.classList.remove('subm-open');
    // Never leave a shared library as the place edits go to.
    if (StandardData._editTarget) await StandardData.setEditTarget(null);
  },

  _build() {
    if (document.getElementById('lib-screen')) return;
    const el = document.createElement('div');
    el.id = 'lib-screen';
    el.className = 'subm-screen lib-screen';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Libraries');
    el.style.zIndex = '1900';
    el.hidden = true;
    el.innerHTML = `
      <header class="subm-head"><button type="button" id="lib-back" class="subm-back">‹ Back to project</button><h2>Libraries</h2><span class="subm-sub" id="lib-sub"></span></header>
      <div class="subm-body">
        <nav class="subm-rail" id="lib-rail" aria-label="Libraries"></nav>
        <section class="subm-main" id="lib-main"></section>
        <aside class="subm-detail" id="lib-detail" aria-live="polite"></aside>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#lib-back').addEventListener('click', () => this.close());
    el.addEventListener('keydown', e => {
      const sub = document.getElementById('subm-screen');
      if (e.key === 'Escape' && (!sub || sub.hidden) && !e.target.closest('input, select, textarea')) { e.stopPropagation(); this.close(); }
    });
    el.addEventListener('click', e => this._onClick(e));
    el.addEventListener('change', e => this._onChange(e));
  },

  // ── docking: the real editors live here now ──
  // A Settings pane is moved into the screen (a comment keeps its place) and put back on leaving.
  _dockPane(tab) {
    const el = document.getElementById(`lib-pane-${tab}`);
    if (!el) return null;
    const ph = document.createComment('lib-dock');
    el.parentNode.insertBefore(ph, el);
    this._ph = ph; this._pane = el;
    el.classList.add('lib-docked');
    document.getElementById('lib-dock').appendChild(el);
    return el;
  },

  _dockRates() {
    Rates.open({});
    const m = document.getElementById('rates-modal'), dock = document.getElementById('lib-dock');
    if (!m || !dock) return;
    m.classList.add('q-docked');
    dock.appendChild(m);
    m.style.display = 'flex';
    this._ratesIn = true;
  },

  _undock() {
    if (this._pane && this._ph && this._ph.parentNode) {
      this._pane.classList.remove('lib-docked', 'active');
      this._ph.parentNode.replaceChild(this._pane, this._ph);
    }
    this._pane = null; this._ph = null;
    if (this._ratesIn) {
      const m = document.getElementById('rates-modal');
      this._ratesIn = false;
      if (m) {
        m.classList.remove('q-docked'); m.style.display = 'none'; document.body.appendChild(m);
        // The Quantities workspace may be showing the rate library behind this screen: give it back.
        if (typeof Quantities !== 'undefined' && Quantities._active && Quantities.view === 'rates') Quantities.show('rates');
      }
    }
  },

  _render() {
    this._undock();
    this._renderRail();
    const isLib = this.KEYS.includes(this.view);
    document.getElementById('lib-detail').hidden = !isLib;
    if (isLib) this._renderLibrary();
    else if (this.view === 'rates') this._renderRates();
    else if (this.view === 'drift') this._renderDrift();
    else if (this.view === 'teams') this._renderTeams();
    else if (this.view === 'activity') { this._renderActivity(); this._loadActivity(); }
    else if (this.view === 'export') this._renderExport();
  },

  _renderRail() {
    const rail = document.getElementById('lib-rail');
    if (!rail) return;
    const SD = StandardData, drift = SD.driftList();
    const subm = typeof Submissions !== 'undefined' ? ((Submissions._counts.waiting || 0) + (Submissions._counts.changes_requested || 0)) : 0;
    const item = (v, label, n) => `<button type="button" class="subm-rail-item${this.view === v ? ' on' : ''}" data-lview="${v}"${this.view === v ? ' aria-current="page"' : ''}><span>${label}</span>${n ? `<span class="subm-n">${n}</span>` : ''}</button>`;
    rail.innerHTML = '<div class="subm-rail-h">Libraries</div>'
      + this.KEYS.map(k => item(k, this.LABELS[k], drift.filter(d => d.key === k).length)).join('')
      + item('rates', 'Rates &amp; prices', typeof Rates !== 'undefined' ? Rates.driftRows().length : 0)
      + '<div class="subm-rail-h">Manage</div>'
      + item('drift', 'Out of date', drift.length)
      + item('teams', 'Team libraries', 0)
      + item('submissions', 'Submissions', subm)
      + item('activity', 'Activity log', 0)
      + item('export', 'Import / export', 0);
    const co = this._company();
    document.getElementById('lib-sub').textContent = co ? `Company standard: ${co.name}${co.currency ? ' · ' + co.currency : ''}` : 'No company standard set';
  },

  // ── a component library: the editable table, docked ──
  _renderLibrary() {
    const key = this.view, SD = StandardData, main = document.getElementById('lib-main');
    main.innerHTML = '<div id="lib-dock" class="lib-dock"></div>';
    this._dockPane(this.TAB[key]);
    SD[this.RENDER[key]]();
    SD._renderEditBanners();
    SD._driftBadge();
    // Pick an entry by clicking its row (editing a cell does not need a click on the row).
    const dock = document.getElementById('lib-dock');
    dock.onclick = e => {
      const tr = e.target.closest('tr[data-index]');
      if (!tr) return;
      const ent = SD[key][+tr.dataset.index];
      if (ent && this._sel !== ent.id) { this._sel = ent.id; this._markRow(); this._renderEntryDetail(); }
    };
    this._markRow();
    this._renderEntryDetail();
  },

  _markRow() {
    const key = this.view, SD = StandardData;
    document.querySelectorAll('#lib-dock tr[data-index]').forEach(tr => {
      const ent = SD[key][+tr.dataset.index];
      tr.classList.toggle('lib-row-sel', !!ent && ent.id === this._sel);
    });
  },

  _source(key, e) {
    const SD = StandardData, o = SD.originOf(key, e);
    if (e._projectOnly) return { t: 'This project only', cls: 'gry' };
    if (o.origin === 'company') return { t: `Company v${o.version}`, cls: 'ok' };
    if (o.origin === 'shared') return { t: `${o.name} v${o.version}`, cls: 'ok' };
    if (o.origin === 'own') return { t: (SD._baseSrc[key] || {})[e.id] ? 'Edited by me' : 'Mine', cls: '' };
    return { t: 'Shipped', cls: 'gry' };
  },

  _renderEntryDetail() {
    const key = this.view, SD = StandardData, host = document.getElementById('lib-detail');
    const e = this._sel ? SD[key].find(x => x.id === this._sel) : null;
    if (!e) { host.innerHTML = '<div class="subm-empty">Click an entry to see where it comes from, its history and what you can do with it. Edit values directly in the table.</div>'; return; }
    const s = this._source(key, e), d = SD.driftOf(key, e), src = (SD._baseSrc[key] || {})[e.id];
    const co = this._company();
    const companyEntry = co && co.entries.find(x => x.kind === key && x.id === e.id);
    const mineOnly = s.t === 'Mine' || s.t === 'Edited by me';
    const acts = [];
    if (d) acts.push('<button type="button" class="btn-primary" data-act="review">Review changes…</button>');
    if (companyEntry && this._canEditCompany()) {
      const editing = SD._editTarget && SD._editTarget.id === co.id;
      acts.push(`<button type="button" class="btn-small" data-act="${editing ? 'edit-mine' : 'edit-company'}">${editing ? 'Back to my library' : 'Edit the company entry'}</button>`);
      acts.push(`<button type="button" class="btn-small ${companyEntry.retired ? '' : 'danger'}" data-act="${companyEntry.retired ? 'restore' : 'retire'}">${companyEntry.retired ? 'Restore (show in pickers)' : 'Retire'}</button>`);
    }
    if (mineOnly && co) acts.push(this._canEditCompany() ? '<button type="button" class="btn-small" data-act="publish">Add to company library</button>' : '<button type="button" class="btn-small" data-act="submit">Submit to company…</button>');
    const kv = Object.keys(SD._plain(key, e)).filter(k => k !== 'id').slice(0, 40).map(k => {
      const v = e[k]; return `<tr><td>${escHtml(k)}</td><td>${escHtml(v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`;
    }).join('');
    host.innerHTML = `
      <div class="subm-kind">${escHtml(this.LABELS[key])} <span class="subm-pill ${s.cls}">${escHtml(s.t)}</span>${e._retired ? ' <span class="subm-pill gry">Retired</span>' : ''}</div>
      <h3>${escHtml(SD._label(e))}</h3><div class="subm-id">${escHtml(e.id)}</div>
      ${d ? `<div class="subm-warn">Your edit was made against ${d.kind === 'shipped' ? 'an older shipped value' : d.kind === 'removed' ? 'an entry that has been removed' : `v${d.since} of ${d.company ? 'the company standard' : '“' + escHtml(d.name) + '”'}, now v${d.now}`}.</div>` : ''}
      ${e._retired ? '<div class="subm-hint">Retired: hidden from pickers; projects that already use it are unaffected.</div>' : ''}
      <div class="subm-actions">${acts.join('')}</div>
      <table class="subm-kv"><tbody>${kv}</tbody></table>
      <div class="lib-hist"><div class="subm-rail-h" style="padding:8px 0 4px">History</div><div id="lib-hist-body" class="subm-hint">${(src && src.libraryId) || companyEntry ? 'Loading…' : 'Shipped and personal entries keep no history.'}</div></div>`;
    const libId = (src && src.libraryId) || (companyEntry && co.id);
    if (libId) this._loadHistory(libId, key, e.id);
  },

  async _loadHistory(libId, key, id) {
    try {
      const rows = await API.getLibraryActivity({ libraryId: libId, kind: key, entryId: id, limit: 50 });
      const body = document.getElementById('lib-hist-body');
      if (!body || this._sel !== id) return;
      if (!rows.length) { body.textContent = 'No recorded changes.'; return; }
      const lib = (StandardData._sharedLayers || []).find(l => l.id === libId);
      const canEdit = !!lib && (lib.role === 'edit' || lib.role === 'owner');
      const cur = lib && lib.entries.find(x => x.kind === key && x.id === id);
      const chron = [...rows].reverse();
      let prev = null; const lines = [];
      for (const r of chron) {
        let diff = '';
        if (r.data && prev) diff = Object.keys({ ...prev, ...r.data }).filter(k => JSON.stringify(prev[k]) !== JSON.stringify(r.data[k])).slice(0, 3).map(k => `${k} ${prev[k] === undefined ? '—' : prev[k]} → ${r.data[k] === undefined ? '—' : r.data[k]}`).join('; ');
        if (r.data) prev = r.data;
        lines.push({ r, diff });
      }
      // Restoring writes that version's values as a new version of the entry (nothing is lost).
      this._histRows = lines.map(x => x.r);
      body.innerHTML = lines.reverse().map(({ r, diff }) => {
        const restorable = canEdit && cur && r.data && r.version && r.version !== cur.version && (r.action === 'entry_created' || r.action === 'entry_updated');
        return `<div class="lib-hist-row"><b>${r.version ? 'v' + r.version + ' ' : ''}${escHtml(this.ACTIONS[r.action] || r.action)}</b> by ${escHtml(r.by || '—')} · ${escHtml(Notifications._date(r.created_at).toLocaleDateString())}${r.detail ? ` <span class="subm-hint">(${escHtml(r.detail)})</span>` : ''}${diff ? `<div class="subm-hint">${escHtml(diff)}</div>` : ''}${restorable ? ` <button type="button" class="btn-small" data-restore="${r.id}">Restore this version</button>` : ''}</div>`;
      }).join('');
    } catch (_) { const b = document.getElementById('lib-hist-body'); if (b) b.textContent = 'Could not load the history.'; }
  },

  // Write a historical version back as the entry's newest version.
  async _restore(historyId) {
    const r = (this._histRows || []).find(x => x.id === historyId);
    if (!r) return;
    const lib = (StandardData._sharedLayers || []).find(l => l.id === r.library_id) || this._company();
    const cur = lib.entries.find(x => x.kind === r.kind && x.id === r.entry_id);
    if (!(await UI.confirm(`Restore “${r.entry_id}” to its values from v${r.version}? This is saved as a new version; the current values stay in the history.`, { okText: 'Restore' }))) return;
    try {
      await API.request(`/shared-libraries/${lib.id}/entries/${r.kind}/${encodeURIComponent(r.entry_id)}`, 'PUT', { data: r.data, base_version: cur ? cur.version : null, restored_from: r.version });
      await StandardData.reloadShared();
      UI.toast(`Restored v${r.version}.`, 'success');
    } catch (err) { UI.toast(err.status === 409 ? 'Someone changed it first — reload and try again.' : err.message, 'error'); }
    this._renderLibrary();
  },

  // ── rates: the rate library, docked ──
  _renderRates() {
    document.getElementById('lib-main').innerHTML = '<div id="lib-dock" class="lib-dock"></div>';
    this._dockRates();
  },

  // ── out of date ──
  _renderDrift() {
    const main = document.getElementById('lib-main'), list = StandardData.driftList();
    const what = d => d.kind === 'removed' ? 'its base entry was removed' : d.kind === 'shipped' ? 'the shipped value was corrected' : `v${d.since} → v${d.now} of ${d.company ? 'the company standard' : '“' + escHtml(d.name) + '”'}`;
    main.innerHTML = `<div class="lib-card"><h3>Edited entries that are out of date</h3>
      ${list.length ? `<p>You edited these, and the entry underneath has changed or been removed since. Your edit stays in effect until you decide.</p>
        <table class="subm-tbl"><thead><tr><th>Library</th><th>Entry</th><th>What changed</th></tr></thead><tbody>${list.map(x => `<tr><td>${escHtml(this.LABELS[x.key])}</td><td><button type="button" class="subm-link" data-gopick="${x.key}|${escHtml(x.e.id)}"><b>${escHtml(StandardData._label(x.e))}</b><small>${escHtml(x.e.id)}</small></button></td><td>${what(x.d)}</td></tr>`).join('')}</tbody></table>
        <div style="margin-top:12px"><button type="button" class="btn-primary" data-act="review-all">Review all…</button></div>` : '<p>Nothing is out of date.</p>'}</div>`;
  },

  // ── team libraries: your order, clashes, and the shared-libraries panel ──
  _renderTeams() {
    const SD = StandardData, main = document.getElementById('lib-main');
    const layers = SD._sharedLayers || [];
    const co = layers.find(l => l.is_company_default);
    const others = layers.filter(l => !l.is_company_default);
    const rank = id => { const i = SD._layerOrder.indexOf(id); return i < 0 ? Infinity : i; };
    others.sort((a, b) => rank(a.id) - rank(b.id) || String(a.name).localeCompare(String(b.name)));
    const row = l => `<tr><td><b>${escHtml(l.name)}</b>${l.is_company_default ? ' <span class="subm-pill ok">Company standard</span>' : ''}</td><td>${escHtml(l.role)}</td><td>${l.entries.length}</td><td>${escHtml(l.owner_email || '')}</td>
      <td>${l.is_company_default ? 'always first' : `<button type="button" class="btn-small" data-move="${l.id}|-1" ${others.indexOf(l) === 0 ? 'disabled' : ''} aria-label="Move ${escHtml(l.name)} earlier">↑</button> <button type="button" class="btn-small" data-move="${l.id}|1" ${others.indexOf(l) === others.length - 1 ? 'disabled' : ''} aria-label="Move ${escHtml(l.name)} later">↓</button>`}</td></tr>`;
    const clashes = SD._clashes || [];
    main.innerHTML = `<div class="lib-card"><h3>Layer order</h3>
      <p>Layers, first to last: shipped defaults → company standard → your team libraries in the order below → your own edits. When two layers hold the same entry the later one wins.</p>
      <table class="subm-tbl"><thead><tr><th>Library</th><th>Your role</th><th>Entries</th><th>Owner</th><th>Order</th></tr></thead><tbody>${[...(co ? [co] : []), ...others].map(row).join('') || '<tr><td colspan="5">No shared libraries yet.</td></tr>'}</tbody></table>
      ${this._admin() && co ? '<div style="margin-top:10px"><button type="button" class="btn-small" data-act="handover">Hand the company standard to another owner…</button></div>' : ''}
      <h3 style="margin-top:18px">Clashes</h3>
      ${clashes.length ? `<p>Entries that two layers both provide — the library on the right wins.</p><table class="subm-tbl"><thead><tr><th>Library</th><th>Entry</th><th>Wins</th><th>Overridden</th></tr></thead><tbody>${clashes.slice(0, 200).map(c => `<tr><td>${escHtml(this.LABELS[c.key] || c.key)}</td><td><b>${escHtml(c.label)}</b><small style="display:block;color:var(--text-muted)">${escHtml(c.id)}</small></td><td>${escHtml(c.winner)}${c.winnerCompany ? ' (company)' : ''}</td><td>${escHtml(c.loser)}</td></tr>`).join('')}</tbody></table>` : '<p class="subm-hint">No entry is provided by more than one layer.</p>'}</div>
      <h3 style="margin:18px 0 8px;font-size:17px">Shared libraries</h3><div id="lib-dock" class="lib-dock lib-dock-flow"></div>`;
    this._dockPane('shared-libs');
    if (typeof SharedLibs !== 'undefined') SharedLibs.render();
  },

  // ── activity ──
  async _loadActivity() {
    try {
      const f = this._activityFilter;
      this._activity = await API.getLibraryActivity({ libraryId: f.library ? +f.library : undefined, action: f.action || undefined, limit: 300 });
    } catch (e) { this._activity = []; UI.toast('Could not load the activity log: ' + e.message, 'error'); }
    if (this.view === 'activity') this._renderActivity();
  },

  _renderActivity() {
    const main = document.getElementById('lib-main'), f = this._activityFilter;
    const libs = (StandardData._sharedLayers || []).map(l => `<option value="${l.id}" ${String(f.library) === String(l.id) ? 'selected' : ''}>${escHtml(l.name)}</option>`).join('');
    const acts = Object.entries(this.ACTIONS).map(([k, v]) => `<option value="${k}" ${f.action === k ? 'selected' : ''}>${escHtml(v)}</option>`).join('');
    const canUndelete = a => a.action === 'entry_deleted' && a.data && (StandardData._sharedLayers || []).some(l => l.id === a.library_id && (l.role === 'edit' || l.role === 'owner')) && !this._exists(a);
    main.innerHTML = `<div class="lib-bar"><label class="lib-field">Library <select id="lib-af-lib"><option value="">All</option>${libs}</select></label>
      <label class="lib-field">Action <select id="lib-af-act"><option value="">All</option>${acts}</select></label><span class="lib-count">${this._activity.length} shown</span></div>
      <div class="subm-tablewrap">${this._activity.length ? `<table class="subm-tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Library</th><th>Entry</th></tr></thead><tbody>${this._activity.map(a => `<tr><td>${escHtml(Notifications._date(a.created_at).toLocaleString())}</td><td>${escHtml(a.by || '—')}</td><td>${escHtml(this.ACTIONS[a.action] || a.action)}${a.version ? ' (v' + a.version + ')' : ''}${a.detail ? `<small style="display:block;color:var(--text-muted)">${escHtml(a.detail)}</small>` : ''}</td><td>${escHtml(a.library_name || '—')}</td><td>${a.entry_id ? escHtml((this.LABELS[a.kind] || a.kind || '') + ' · ' + a.entry_id) : ''}${canUndelete(a) ? ` <button type="button" class="btn-small" data-undelete="${a.id}">Restore</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="subm-empty">Nothing recorded yet.</div>'}</div>`;
  },

  _exists(a) {
    const lib = (StandardData._sharedLayers || []).find(l => l.id === a.library_id);
    return !!(lib && lib.entries.some(x => x.kind === a.kind && x.id === a.entry_id));
  },

  async _undelete(activityId) {
    const a = this._activity.find(x => x.id === activityId);
    if (!a || !a.data) return;
    if (!(await UI.confirm(`Bring back “${a.entry_id}” in ${a.library_name}, with the values it had when it was deleted?`, { okText: 'Restore' }))) return;
    try {
      await API.request(`/shared-libraries/${a.library_id}/entries/${a.kind}/${encodeURIComponent(a.entry_id)}`, 'PUT', { data: a.data, base_version: null, restored_from: a.version });
      await StandardData.reloadShared();
      UI.toast('Restored.', 'success');
    } catch (err) { UI.toast(err.status === 409 ? 'It already exists again.' : err.message, 'error'); }
    this._loadActivity();
  },

  // ── export ──
  _renderExport() {
    const co = this._company();
    document.getElementById('lib-main').innerHTML = `<div class="lib-card"><h3>Import / export</h3>
      <p>Download your libraries as JSON, for backup or to inspect.</p>
      <div class="subm-actions" style="max-width:420px">
        <button type="button" class="btn-small" data-act="export-mine">Export my overrides (JSON)</button>
        ${co ? '<button type="button" class="btn-small" data-act="export-company">Export the company library (JSON)</button>' : ''}
      </div>
      <p class="subm-hint" style="margin-top:14px">To bring entries in, add them in a library’s table, or publish a set of your own to a shared library from Team libraries.</p></div>`;
  },

  _download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // ── events ──
  _onChange(e) {
    if (e.target.id === 'lib-af-lib') { this._activityFilter.library = e.target.value; this._loadActivity(); }
    if (e.target.id === 'lib-af-act') { this._activityFilter.action = e.target.value; this._loadActivity(); }
  },

  async _onClick(e) {
    const SD = StandardData;
    const lv = e.target.closest('[data-lview]');
    if (lv) {
      if (lv.dataset.lview === 'submissions') { Submissions.open(); return; }
      this.view = lv.dataset.lview; this._sel = null;
      this._render();
      return;
    }
    const gp = e.target.closest('[data-gopick]');
    if (gp) { const [k, id] = gp.dataset.gopick.split('|'); this.view = k; this._sel = id; this._render(); return; }
    const restore = e.target.closest('[data-restore]');
    if (restore) { await this._restore(+restore.dataset.restore); return; }
    const undel = e.target.closest('[data-undelete]');
    if (undel) { await this._undelete(+undel.dataset.undelete); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const [id, dir] = mv.dataset.move.split('|').map(Number);
      const others = (SD._sharedLayers || []).filter(l => !l.is_company_default);
      const rank = i => { const j = SD._layerOrder.indexOf(i); return j < 0 ? Infinity : j; };
      others.sort((a, b) => rank(a.id) - rank(b.id) || String(a.name).localeCompare(String(b.name)));
      const ids = others.map(l => l.id), at = ids.indexOf(id), to = at + dir;
      if (at < 0 || to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to], ids[at]];
      await SD.setLayerOrder(ids);
      this._render();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act, key = this.view, id = this._sel;
    if (a === 'review' || a === 'review-all') { await SD.reviewDrift(); this._render(); this.refreshBadge(); }
    else if (a === 'edit-company') { await SD.setEditTarget(this._company().id); this._renderLibrary(); }
    else if (a === 'edit-mine') { await SD.setEditTarget(null); this._renderLibrary(); }
    else if (a === 'retire' || a === 'restore') {
      const co = this._company();
      try { await API.setEntryRetired(co.id, key, id, a === 'retire'); await SD.reloadShared(); UI.toast(a === 'retire' ? 'Retired — it no longer appears in pickers; projects that use it are unaffected.' : 'Restored.', 'success'); }
      catch (err) { UI.toast(err.message, 'error'); }
      this._renderLibrary(); this.refreshBadge();
    } else if (a === 'submit') { await Submissions.pickAndSubmit(key); }
    else if (a === 'publish') {
      const co = this._company(), ent = SD[key].find(x => x.id === id);
      try { await API.importSharedEntries(co.id, [{ kind: key, data: SD._strip(SD._plain(key, ent)) }]); await SD.reloadShared(); UI.toast('Added to the company library.', 'success'); }
      catch (err) { UI.toast(err.message, 'error'); }
      this._renderLibrary();
    }
    else if (a === 'export-mine') { this._download('my-libraries.json', SD._payload()); }
    else if (a === 'export-company') { const co = this._company(); this._download('company-library.json', { name: co.name, currency: co.currency, entries: co.entries.map(x => ({ kind: x.kind, id: x.id, version: x.version, retired: !!x.retired, data: x.data })) }); }
    else if (a === 'handover') await this._handover();
  },

  async _handover() {
    const co = this._company();
    let users;
    try { users = await API.listUsers(); } catch (err) { UI.toast(err.message, 'error'); return; }
    const email = await UI.prompt('Hand the company standard library to which user? Enter their email address:', '', { title: 'Hand over the company standard', okText: 'Hand over' });
    if (!email) return;
    const u = users.find(x => String(x.email).toLowerCase() === String(email).trim().toLowerCase() && x.is_active !== false);
    if (!u) { UI.toast('No active user has that email address.', 'warning'); return; }
    try { await API.changeLibraryOwner(co.id, u.id); await StandardData.reloadShared(); UI.toast(`The company standard now belongs to ${u.email}.`, 'success'); }
    catch (err) { UI.toast(err.message, 'error'); }
    this._render();
  },
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-libraries')?.addEventListener('click', () => { window.closeAllToolbarMenus?.(); Libraries.open(); });
});
