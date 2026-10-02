/* ProtectionPro — Libraries manager
 *
 * One full-screen place for everything about libraries (Project → Libraries…): the five component
 * libraries with where each entry comes from, which of your edits are out of date, the company
 * price list, team libraries and their order, company submissions, the activity log (entry
 * history) and export. Entries are still edited in Settings' library tables ("Edit in Settings…"),
 * which keep their per-kind editors; admins retire / restore company entries here.
 *
 *   Libraries.open({ view, key, id })   view = a library key | 'rates' | 'drift' | 'teams' | 'activity' | 'export'
 *   Libraries.refreshBadge()            the count on the menu item (out of date + submissions waiting)
 */

const Libraries = {
  KEYS: ['cables', 'cbs', 'fuses', 'transformers', 'loadClasses'],
  LABELS: { cables: 'Cables', cbs: 'Circuit breakers', fuses: 'Fuses', transformers: 'Transformers', loadClasses: 'Load classes' },
  TAB: { cables: 'cables', cbs: 'cbs', fuses: 'fuses', transformers: 'transformers', loadClasses: 'load-classes' },
  ACTIONS: {
    entry_created: 'added', entry_updated: 'updated', entry_deleted: 'deleted', entry_retired: 'retired', entry_restored: 'restored',
    company_designated: 'set the company standard', company_cleared: 'cleared the company standard', currency_changed: 'changed the currency',
    member_added: 'added a member', member_role: 'changed a member’s role', member_removed: 'removed a member', member_left: 'left',
    library_created: 'created the library', library_renamed: 'renamed the library', library_deleted: 'deleted the library',
    library_owner_changed: 'handed the library over',
  },

  view: 'cables',
  mode: 'effective',      // effective | company | mine
  query: '',
  _open: false,
  _sel: null,             // selected entry id (entries views)
  _activity: [],
  _activityFilter: { library: '', action: '' },

  _admin() { return typeof Auth !== 'undefined' && Auth.isAdmin(); },
  _SD() { return StandardData; },
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
    this.mode = 'effective';
    this.query = '';
    this._open = true;
    document.getElementById('lib-screen').hidden = false;
    document.body.classList.add('subm-open');
    if (typeof Submissions !== 'undefined') await Submissions.refreshBadge();
    this._render();
    if (this.view === 'activity') this._loadActivity();
    document.getElementById('lib-back').focus();
  },

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('lib-screen').hidden = true;
    document.body.classList.remove('subm-open');
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
      if (e.key === 'Escape' && (!sub || sub.hidden)) { e.stopPropagation(); this.close(); }
    });
    el.addEventListener('click', e => this._onClick(e));
    el.addEventListener('input', e => { if (e.target.id === 'lib-q') { this.query = e.target.value.trim().toLowerCase(); this._renderEntries(); } });
    el.addEventListener('change', e => this._onChange(e));
  },

  _render() {
    this._renderRail();
    const isEntries = this.KEYS.includes(this.view);
    const detail = document.getElementById('lib-detail');
    detail.hidden = !isEntries;
    if (isEntries) this._renderEntries();
    else if (this.view === 'rates') this._renderRates();
    else if (this.view === 'drift') this._renderDrift();
    else if (this.view === 'teams') this._renderTeams();
    else if (this.view === 'activity') this._renderActivity();
    else if (this.view === 'export') this._renderExport();
  },

  _renderRail() {
    const rail = document.getElementById('lib-rail');
    if (!rail) return;
    const SD = StandardData;
    const drift = SD.driftList();
    const subm = typeof Submissions !== 'undefined' ? ((Submissions._counts.waiting || 0) + (Submissions._counts.changes_requested || 0)) : 0;
    const item = (v, label, n, extra = '') => `<button type="button" class="subm-rail-item${this.view === v ? ' on' : ''}" data-lview="${v}"${this.view === v ? ' aria-current="page"' : ''}><span>${label}</span>${n ? `<span class="subm-n">${n}</span>` : extra}</button>`;
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

  // ── entries ──
  _summary(key, e) {
    const f = {
      cables: [e.conductor, e.insulation, e.size_mm2 != null ? e.size_mm2 + ' mm²' : '', e.voltage_kv != null ? e.voltage_kv + ' kV' : ''],
      cbs: [e.cb_type ? String(e.cb_type).toUpperCase() : '', e.trip_rating_a != null ? e.trip_rating_a + ' A' : '', e.breaking_ka != null ? e.breaking_ka + ' kA' : ''],
      fuses: [e.fuse_type, e.rated_current_a != null ? e.rated_current_a + ' A' : '', e.breaking_ka != null ? e.breaking_ka + ' kA' : ''],
      transformers: [e.rated_mva != null ? e.rated_mva + ' MVA' : '', e.voltage_hv_kv != null ? e.voltage_hv_kv + '/' + e.voltage_lv_kv + ' kV' : '', e.z_percent != null ? e.z_percent + ' %' : ''],
      loadClasses: [e.description || e.group || ''],
    }[key] || [];
    return f.filter(Boolean).join(' · ');
  },

  _source(key, e) {
    const SD = StandardData, o = SD.originOf(key, e);
    if (e._projectOnly) return { t: 'This project only', cls: 'gry' };
    if (o.origin === 'company') return { t: `Company v${o.version}`, cls: 'ok' };
    if (o.origin === 'shared') return { t: `${o.name} v${o.version}`, cls: 'ok' };
    if (o.origin === 'own') return { t: (SD._baseSrc[key] || {})[e.id] ? 'Edited by me' : 'Mine', cls: '' };
    return { t: 'Shipped', cls: 'gry' };
  },

  // Entries shown in the current mode. Company-only comes from the company layer itself (retired ones included).
  _rows(key) {
    const SD = StandardData;
    if (this.mode === 'company') {
      const co = this._company();
      return ((co && co.entries) || []).filter(en => en.kind === key).map(en => ({ e: { ...en.data, _retired: !!en.retired }, company: en }));
    }
    let list = SD[key].filter(e => !e._projectOnly || true);
    if (this.mode === 'mine') list = list.filter(e => SD.originOf(key, e).origin === 'own');
    return list.map(e => ({ e }));
  },

  _renderEntries() {
    const key = this.view, SD = StandardData, main = document.getElementById('lib-main');
    const rows = this._rows(key).filter(r => !this.query || (SD._label(r.e) + ' ' + r.e.id + ' ' + this._summary(key, r.e)).toLowerCase().includes(this.query));
    const mode = (m, l) => `<button type="button" class="lib-mode${this.mode === m ? ' on' : ''}" data-mode="${m}" aria-pressed="${this.mode === m}">${l}</button>`;
    main.innerHTML = `
      <div class="lib-bar"><div class="lib-modes">${mode('effective', 'Effective')}${mode('company', 'Company only')}${mode('mine', 'My overrides')}</div>
        <label class="lib-field">Search <input id="lib-q" type="search" value="${escHtml(this.query)}" placeholder="name or id"></label>
        <span class="lib-count">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span></div>
      <div class="subm-tablewrap">${rows.length ? `<table class="subm-tbl"><thead><tr><th>Entry</th><th>Details</th><th>Source</th><th>Status</th></tr></thead><tbody>${rows.slice(0, 600).map(r => {
        const e = r.e, s = this._source(key, e), d = r.company ? null : SD.driftOf(key, e);
        const st = e._retired ? '<span class="subm-pill gry">Retired</span>' : d ? '<span class="subm-pill amb">Out of date</span>' : '<span class="subm-pill ok">Current</span>';
        return `<tr data-eid="${escHtml(e.id)}" class="${e.id === this._sel ? 'sel' : ''}"><td><button type="button" class="subm-link" data-pick="${escHtml(e.id)}"><b>${escHtml(SD._label(e))}</b><small>${escHtml(e.id)}</small></button></td><td>${escHtml(this._summary(key, e))}</td><td><span class="subm-pill ${s.cls}">${escHtml(s.t)}</span></td><td>${st}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="subm-empty">Nothing here.</div>'}</div>
      ${rows.length > 600 ? '<div class="subm-hint">Showing the first 600 — narrow it with the search.</div>' : ''}`;
    this._renderEntryDetail(rows);
  },

  _find(key, id) {
    const hit = this._rows(key).find(r => r.e.id === id);
    return hit || null;
  },

  async _renderEntryDetail(rows) {
    const key = this.view, SD = StandardData, host = document.getElementById('lib-detail');
    if (this._sel && !rows.some(r => r.e.id === this._sel)) this._sel = null;
    if (!this._sel) { host.innerHTML = '<div class="subm-empty">Select an entry to see where it comes from and what you can do with it.</div>'; return; }
    const r = rows.find(x => x.e.id === this._sel), e = r.e;
    const s = this._source(key, e), d = r.company ? null : SD.driftOf(key, e);
    const src = (SD._baseSrc[key] || {})[e.id];
    const co = this._company();
    const companyEntry = co && co.entries.find(x => x.kind === key && x.id === e.id);
    const kv = Object.keys(SD._plain(key, e)).filter(k => k !== 'id').slice(0, 40).map(k => {
      const v = e[k]; return `<tr><td>${escHtml(k)}</td><td>${escHtml(v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`;
    }).join('');
    const acts = [];
    if (d) acts.push(`<button type="button" class="btn-primary" data-act="review">Review changes…</button>`);
    if (companyEntry && this._canEditCompany()) {
      acts.push(`<button type="button" class="btn-small" data-act="edit-company">Edit in Settings…</button>`);
      acts.push(`<button type="button" class="btn-small ${companyEntry.retired ? '' : 'danger'}" data-act="${companyEntry.retired ? 'restore' : 'retire'}">${companyEntry.retired ? 'Restore' : 'Retire'}</button>`);
    } else if (!r.company) {
      acts.push(`<button type="button" class="btn-small" data-act="edit-mine">Edit in Settings…</button>`);
      if (s.t === 'Mine' || s.t === 'Edited by me') {
        if (co && !this._canEditCompany()) acts.push(`<button type="button" class="btn-small" data-act="submit">Submit to company…</button>`);
        else if (co) acts.push(`<button type="button" class="btn-small" data-act="publish">Add to company library</button>`);
      }
    }
    host.innerHTML = `
      <div class="subm-kind">${escHtml(this.LABELS[key])} <span class="subm-pill ${s.cls}">${escHtml(s.t)}</span>${e._retired ? ' <span class="subm-pill gry">Retired</span>' : ''}</div>
      <h3>${escHtml(SD._label(e))}</h3><div class="subm-id">${escHtml(e.id)}</div>
      ${d ? `<div class="subm-warn">Your edit was made against ${d.kind === 'shipped' ? 'an older shipped value' : d.kind === 'removed' ? 'an entry that has been removed' : `v${d.since} of ${d.company ? 'the company standard' : '“' + escHtml(d.name) + '”'}, now v${d.now}`}.</div>` : ''}
      ${e._retired ? '<div class="subm-hint">Retired: hidden from pickers; projects that already use it are unaffected.</div>' : ''}
      <div class="subm-actions">${acts.join('')}</div>
      <table class="subm-kv"><tbody>${kv}</tbody></table>
      <div class="lib-hist"><div class="subm-rail-h" style="padding:8px 0 4px">History</div><div id="lib-hist-body" class="subm-hint">${src && src.libraryId || companyEntry ? 'Loading…' : 'Shipped and personal entries keep no history.'}</div></div>`;
    const libId = (src && src.libraryId) || (companyEntry && co.id);
    if (libId) this._loadHistory(libId, key, e.id);
  },

  async _loadHistory(libId, key, id) {
    const body = document.getElementById('lib-hist-body');
    try {
      const rows = await API.getLibraryActivity({ libraryId: libId, kind: key, entryId: id, limit: 50 });
      if (!document.getElementById('lib-hist-body') || this._sel !== id) return;
      if (!rows.length) { document.getElementById('lib-hist-body').textContent = 'No recorded changes.'; return; }
      const chron = [...rows].reverse();
      let prev = null; const lines = [];
      for (const r of chron) {
        let diff = '';
        if (r.data && prev) diff = Object.keys({ ...prev, ...r.data }).filter(k => JSON.stringify(prev[k]) !== JSON.stringify(r.data[k])).slice(0, 3).map(k => `${k} ${prev[k] === undefined ? '—' : prev[k]} → ${r.data[k] === undefined ? '—' : r.data[k]}`).join('; ');
        if (r.data) prev = r.data;
        lines.push({ r, diff });
      }
      document.getElementById('lib-hist-body').innerHTML = lines.reverse().map(({ r, diff }) => `<div class="lib-hist-row"><b>${r.version ? 'v' + r.version + ' ' : ''}${escHtml(this.ACTIONS[r.action] || r.action)}</b> by ${escHtml(r.by || '—')} · ${escHtml(Notifications._date(r.created_at).toLocaleDateString())}${r.detail ? ` <span class="subm-hint">(${escHtml(r.detail)})</span>` : ''}${diff ? `<div class="subm-hint">${escHtml(diff)}</div>` : ''}</div>`).join('');
    } catch (_) { if (body) body.textContent = 'Could not load the history.'; }
  },

  // ── rates ──
  _renderRates() {
    const main = document.getElementById('lib-main'), co = typeof Rates !== 'undefined' ? Rates.companyLayer() : null;
    const drift = Rates.driftRows(), locked = Rates._locked();
    const L = AppState.rateLibrary, own = L && L.items ? Object.keys(L.items).length : 0;
    main.innerHTML = `<div class="lib-card"><h3>Rates &amp; prices</h3>
      ${co ? `<p><b>${co.entries.size}</b> prices in the company price list “${escHtml(co.name)}”${co.currency ? ' (' + escHtml(co.currency) + ')' : ''}.</p>` : '<p>There is no company price list yet.</p>'}
      <p>This project has <b>${own}</b> price${own === 1 ? '' : 's'} set${drift.length ? `, <b>${drift.length}</b> of them changed in the company list since the project took them` : ''}.</p>
      ${locked ? `<div class="subm-warn">${escHtml(Quote.describe())} — prices are locked.</div>` : ''}
      <div class="subm-two" style="max-width:520px;margin-top:10px"><button type="button" class="btn-primary" data-act="open-rates">Open the rate library</button>
        ${co && co.entries.size && !locked ? '<button type="button" class="btn-small" data-act="rates-refresh">Refresh from company</button>' : ''}
        ${co && !locked ? (Rates._canPublish() ? '<button type="button" class="btn-small" data-act="rates-publish">Publish to company…</button>' : '<button type="button" class="btn-small" data-act="rates-submit">Submit prices to company…</button>') : ''}</div>
      <p class="subm-hint" style="margin-top:14px">Prices are kept with each project. Quoting a project (Project → Mark as Quoted…) locks them.</p></div>`;
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

  // ── team libraries + order + clashes ──
  _renderTeams() {
    const SD = StandardData, main = document.getElementById('lib-main');
    const layers = SD._sharedLayers || [];
    const co = layers.find(l => l.is_company_default);
    const others = layers.filter(l => !l.is_company_default);
    const rank = id => { const i = SD._layerOrder.indexOf(id); return i < 0 ? Infinity : i; };
    others.sort((a, b) => rank(a.id) - rank(b.id) || String(a.name).localeCompare(String(b.name)));
    const n = l => l.entries.length;
    const row = (l, i) => `<tr><td><b>${escHtml(l.name)}</b>${l.is_company_default ? ' <span class="subm-pill ok">Company standard</span>' : ''}</td><td>${escHtml(l.role)}</td><td>${n(l)}</td><td>${escHtml(l.owner_email || '')}</td>
      <td>${l.is_company_default ? 'always first' : `<button type="button" class="btn-small" data-move="${l.id}|-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escHtml(l.name)} earlier">↑</button> <button type="button" class="btn-small" data-move="${l.id}|1" ${i === others.length - 1 ? 'disabled' : ''} aria-label="Move ${escHtml(l.name)} later">↓</button>`}</td></tr>`;
    const clashes = SD._clashes || [];
    main.innerHTML = `<div class="lib-card"><h3>Team libraries</h3>
      <p>Layers, first to last: shipped defaults → company standard → your team libraries in the order below → your own edits. When two layers hold the same entry the later one wins.</p>
      <table class="subm-tbl"><thead><tr><th>Library</th><th>Your role</th><th>Entries</th><th>Owner</th><th>Order</th></tr></thead><tbody>${[...(co ? [co] : []), ...others].map((l, i) => row(l, l.is_company_default ? 0 : others.indexOf(l))).join('') || '<tr><td colspan="5">No shared libraries yet.</td></tr>'}</tbody></table>
      <div class="subm-two" style="max-width:520px;margin-top:10px"><button type="button" class="btn-small" data-act="open-settings-shared">Manage members &amp; create libraries in Settings…</button>${this._admin() && co ? '<button type="button" class="btn-small" data-act="handover">Hand the company standard to another owner…</button>' : ''}</div>
      <h3 style="margin-top:22px">Clashes</h3>
      ${clashes.length ? `<p>Entries that two layers both provide — the library on the right wins.</p><table class="subm-tbl"><thead><tr><th>Library</th><th>Entry</th><th>Wins</th><th>Overridden</th></tr></thead><tbody>${clashes.slice(0, 200).map(c => `<tr><td>${escHtml(this.LABELS[c.key] || c.key)}</td><td><b>${escHtml(c.label)}</b><small style="display:block;color:var(--text-muted)">${escHtml(c.id)}</small></td><td>${escHtml(c.winner)}${c.winnerCompany ? ' (company)' : ''}</td><td>${escHtml(c.loser)}</td></tr>`).join('')}</tbody></table>` : '<p class="subm-hint">No entry is provided by more than one layer.</p>'}</div>`;
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
    main.innerHTML = `<div class="lib-bar"><label class="lib-field">Library <select id="lib-af-lib"><option value="">All</option>${libs}</select></label>
      <label class="lib-field">Action <select id="lib-af-act"><option value="">All</option>${acts}</select></label><span class="lib-count">${this._activity.length} shown</span></div>
      <div class="subm-tablewrap">${this._activity.length ? `<table class="subm-tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Library</th><th>Entry</th></tr></thead><tbody>${this._activity.map(a => `<tr><td>${escHtml(Notifications._date(a.created_at).toLocaleString())}</td><td>${escHtml(a.by || '—')}</td><td>${escHtml(this.ACTIONS[a.action] || a.action)}${a.version ? ' (v' + a.version + ')' : ''}${a.detail ? `<small style="display:block;color:var(--text-muted)">${escHtml(a.detail)}</small>` : ''}</td><td>${escHtml(a.library_name || '—')}</td><td>${a.entry_id ? escHtml((this.LABELS[a.kind] || a.kind || '') + ' · ' + a.entry_id) : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="subm-empty">Nothing recorded yet.</div>'}</div>`;
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
      <p class="subm-hint" style="margin-top:14px">To bring entries in, add them in Settings, or publish a set of your own to a shared library from Settings → Shared Libraries.</p></div>`;
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

  _openSettings(tab) {
    this.close();
    StandardData.open();
    document.querySelector(`.settings-tab[data-tab="${tab}"]`)?.click();
  },

  async _onClick(e) {
    const SD = StandardData;
    const lv = e.target.closest('[data-lview]');
    if (lv) {
      if (lv.dataset.lview === 'submissions') { Submissions.open(); return; }
      this.view = lv.dataset.lview; this._sel = null; this.mode = 'effective'; this.query = '';
      this._render(); if (this.view === 'activity') this._loadActivity();
      return;
    }
    const mode = e.target.closest('[data-mode]');
    if (mode) { this.mode = mode.dataset.mode; this._renderEntries(); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) { this._sel = pick.dataset.pick; this._renderEntries(); return; }
    const gp = e.target.closest('[data-gopick]');
    if (gp) { const [k, id] = gp.dataset.gopick.split('|'); this.view = k; this._sel = id; this.mode = 'effective'; this._render(); return; }
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
    else if (a === 'edit-mine') { this._openSettings(this.TAB[key]); }
    else if (a === 'edit-company') { await SD.setEditTarget(this._company().id); this._openSettings(this.TAB[key]); }
    else if (a === 'retire' || a === 'restore') {
      const co = this._company();
      try { await API.setEntryRetired(co.id, key, id, a === 'retire'); await SD.reloadShared(); UI.toast(a === 'retire' ? 'Retired — it no longer appears in pickers; projects that use it are unaffected.' : 'Restored.', 'success'); }
      catch (err) { UI.toast(err.message, 'error'); }
      this._render(); this.refreshBadge();
    } else if (a === 'submit') { await Submissions.pickAndSubmit(key); }
    else if (a === 'publish') {
      const co = this._company(), ent = SD[key].find(x => x.id === id);
      try { await API.importSharedEntries(co.id, [{ kind: key, data: SD._strip(SD._plain(key, ent)) }]); await SD.reloadShared(); UI.toast('Added to the company library.', 'success'); }
      catch (err) { UI.toast(err.message, 'error'); }
      this._render();
    }
    else if (a === 'open-rates') { this.close(); Rates.open(); }
    else if (a === 'rates-refresh') { this.close(); Rates.open(); Rates.refreshFromCompany(); }
    else if (a === 'rates-publish') { this.close(); Rates.open(); Rates.publishToCompany(); }
    else if (a === 'rates-submit') { this.close(); Rates.open(); Rates.submitToCompany(); }
    else if (a === 'open-settings-shared') { this._openSettings('shared-libs'); }
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
