/* ProtectionPro — Standard Data Library Manager & Settings */

const StandardData = {
  // Working copies of libraries (editable by user)
  cables: [],
  transformers: [],
  cbs: [],
  fuses: [],
  loadClasses: [],

  // localStorage key for persisted library customizations
  _STORAGE_KEY: 'protectionpro-custom-libraries',
  // Bump when shipped default library DATA changes (e.g. corrected cable
  // resistances). A persisted payload with an older version still loads the
  // user's customizations, but we warn that newer defaults are available.
  _DATA_VERSION: 2,

  init() {
    // Capture pristine defaults BEFORE any sync mutates the global arrays —
    // "Reset to Defaults" must restore these, not the edited working copies.
    this._defaults = {
      cables: JSON.parse(JSON.stringify(STANDARD_CABLES)),
      transformers: JSON.parse(JSON.stringify(STANDARD_TRANSFORMERS)),
      cbs: JSON.parse(JSON.stringify(STANDARD_CBS)),
      fuses: JSON.parse(JSON.stringify(STANDARD_FUSES)),
      loadClasses: JSON.parse(JSON.stringify(STANDARD_LOAD_CLASSES)),
    };

    // Clone defaults into working copies
    this.cables = JSON.parse(JSON.stringify(STANDARD_CABLES));
    this.transformers = JSON.parse(JSON.stringify(STANDARD_TRANSFORMERS));
    this.cbs = JSON.parse(JSON.stringify(STANDARD_CBS));
    this.fuses = JSON.parse(JSON.stringify(STANDARD_FUSES));
    this.loadClasses = JSON.parse(JSON.stringify(STANDARD_LOAD_CLASSES));

    // Working copies start as the shipped defaults; the user's own libraries are
    // loaded from their account once signed in (loadFromServer).
    this._buildBase();
    this.syncCableLibrary();
    this.syncTransformerLibrary();
    this.syncCBLibrary();
    this.syncFuseLibrary();
    this.syncLoadClassLibrary();

    this.bindTabs();
    this.bindCableTable();
    this.bindTransformerTable();
    this.bindCBTable();
    this.bindFuseTable();
    this.bindLoadClassTable();
    this.bindIECStandards();
    this._initLibraryUI();
    this._initCompact();

    // Persist only edits made after init
    this._initialized = true;
  },

  // ─── Library persistence: the user's account (server), not this browser ───
  // The libraries are the user's own (one JSON document per user, /api/user-libraries).
  // Nothing is saved until the user's libraries have been LOADED — otherwise the shipped
  // defaults would overwrite them. The pre-server localStorage copy is only read once,
  // to move it into the account (see loadFromServer).

  _serverReady: false,      // this user's libraries are loaded; edits are saved
  _loadedFor: null,         // user id the working copies belong to
  ready: Promise.resolve(), // settles when the user's libraries are loaded (or failed)

  // ─── Layers ───
  // The effective library of each kind is built in layers, later ones winning by entry id:
  //   shipped defaults → company standard (admin-designated) → shared libraries you belong to
  //   → YOUR OWN overrides (entries you added or changed, and shipped/shared ids you deleted).
  // The Settings tables edit the effective list (this[key]); on save only the difference to
  // the layers underneath is stored (`_ownOverrides`), so corrections to the shipped defaults
  // and edits made by teammates in shared libraries reach you without you re-copying anything.
  _sharedLayers: [],        // [{ id, name, role, is_company_default, entries: [{kind, id, data, version}] }]
  _base: {},                // key → entries below your overrides (defaults + company + shared)
  _baseSrc: {},             // key → id → { origin: 'shipped'|'company'|'shared', name, libraryId }

  _strip(e) { const o = {}; for (const k of Object.keys(e)) if (k[0] !== '_') o[k] = this._clone(e[k]); return o; },

  _buildBase() {
    this._base = {}; this._baseSrc = {};
    // company standard first, then the rest by name
    const layers = [...this._sharedLayers].sort((a, b) =>
      (b.is_company_default ? 1 : 0) - (a.is_company_default ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
    for (const key of this._LIBKEYS) {
      const list = this._defaults[key].map(e => this._clone(e));
      const src = {};
      for (const e of list) src[e.id] = { origin: 'shipped' };
      for (const L of layers) {
        for (const en of L.entries) {
          if (en.kind !== key || !en.data || !en.data.id) continue;
          const at = list.findIndex(x => x.id === en.data.id);
          const e = this._clone(en.data);
          if (at >= 0) list[at] = e; else list.push(e);
          src[e.id] = { origin: L.is_company_default ? 'company' : 'shared', name: L.name, libraryId: L.id };
        }
      }
      this._base[key] = list; this._baseSrc[key] = src;
    }
  },

  // Where an entry in the effective library comes from now: your own edit, or the layer below.
  originOf(key, entry) {
    const b = (this._base[key] || []).find(x => x.id === entry.id);
    if (!b || !this._same(key, b, entry)) return { origin: 'own' };
    return (this._baseSrc[key] || {})[entry.id] || { origin: 'shipped' };
  },

  // Working copies = base + own overrides.
  _applyOverrides(key, ov) {
    const removed = new Set((ov && Array.isArray(ov.removed)) ? ov.removed : []);
    const set = new Map(((ov && Array.isArray(ov.set)) ? ov.set : []).filter(e => e && e.id).map(e => [e.id, e]));
    const next = this._base[key].filter(e => !removed.has(e.id)).map(e => set.has(e.id) ? this._clone(set.get(e.id)) : this._clone(e));
    const have = new Set(next.map(e => e.id));
    for (const [id, e] of set) if (!have.has(id) && !removed.has(id)) next.push(this._clone(e));
    this[key] = next;
  },

  // The difference between the effective library and the layers below it.
  _ownOverrides(key) {
    const eff = this._persistable(key);          // project-only stand-ins are not yours
    const base = new Map(this._base[key].map(e => [e.id, e]));
    const set = [];
    for (const e of eff) { const b = base.get(e.id); if (!b || !this._same(key, b, e)) set.push(this._strip(e)); }
    const have = new Set(eff.map(e => e.id));
    const removed = [...base.keys()].filter(id => !have.has(id));
    return { set, removed };
  },

  _payload() {
    const doc = { version: this._DATA_VERSION, format: 'overrides' };
    for (const key of this._LIBKEYS) doc[key] = this._ownOverrides(key);
    return doc;
  },

  // A pre-layering document stored FULL copies of each library. Convert it to overrides with
  // the rules the old loader effectively had: cables — shipped cables missing from the copy
  // were appended, so they are not deletions; the other libraries — a missing shipped id
  // was a deletion.
  _overridesFromFull(key, list) {
    const base = new Map(this._base[key].map(e => [e.id, e]));
    const ids = new Set(list.map(e => e && e.id));
    const set = list.filter(e => e && e.id && (!base.has(e.id) || !this._same(key, base.get(e.id), e))).map(e => this._strip(e));
    const removed = key === 'cables' ? [] : this._defaults[key].map(e => e.id).filter(id => !ids.has(id));
    return { set, removed };
  },
  _applyStored(doc) {
    if (!doc || typeof doc !== 'object') {          // nothing saved yet: the layers as they are
      for (const key of this._LIBKEYS) this._applyOverrides(key, null);
      return false;
    }
    const overrides = doc.format === 'overrides';
    for (const key of this._LIBKEYS) {
      if (overrides) this._applyOverrides(key, doc[key]);
      else if (Array.isArray(doc[key])) this._applyOverrides(key, this._overridesFromFull(key, doc[key]));
      else this._applyOverrides(key, null);
    }
    // Keep the user's customizations, but if the shipped defaults have been
    // revised since they were saved, let them know they can adopt the update.
    if ((doc.version || 1) < this._DATA_VERSION) {
      const msg = 'Component libraries: the shipped defaults have been updated '
        + '(e.g. corrected cable resistances) since your customisations were saved. '
        + 'Use "Reset to Defaults" in Settings to adopt them.';
      setTimeout(() => {
        const el = document.getElementById('status-info');
        if (el) el.textContent = msg;
      }, 1500);
    }
    return !overrides;   // true = came from the old format and should be re-saved as overrides
  },

  // Old browser-only copy (before libraries lived in the account), if any.
  _readLegacyLocal() {
    try { const raw = localStorage.getItem(this._STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },

  // "Reset to Defaults": drop YOUR overrides for one library; the shipped/company/shared layers stay.
  _resetLibrary(key) {
    this[key] = this._base[key].map(e => this._clone(e));
  },

  // Signed in: load THIS user's libraries and the shared ones they can read. A user with none
  // on the server yet gets this browser's old copy moved into their account (once); an old-format
  // document is converted to overrides and saved once. Same user again (e.g. after a session
  // expiry) keeps the working copies as they are.
  loadFromServer(userId) {
    if (!this._defaults) return this.ready;
    if (this._serverReady && this._loadedFor === userId) return this.ready;
    this.ready = this._loadFromServer(userId);
    return this.ready;
  },
  async _loadFromServer(userId) {
    this._serverReady = false;
    try {
      // Both must load: saving overrides against an incomplete base would lose deletions.
      const [res, shared] = await Promise.all([API.getUserLibraries(), API.getSharedLibraries()]);
      this._sharedLayers = Array.isArray(shared) ? shared : [];
      this._buildBase();
      let resave = false, migrate = false;
      if (res && res.data) {
        resave = this._applyStored(res.data);
      } else {
        const legacy = this._readLegacyLocal();
        if (legacy) { this._applyStored(legacy); resave = migrate = true; }
        else this._applyStored(null);
      }
      this._loadedFor = userId;
      this._serverReady = true;
      this._syncAllQuiet();
      if (resave) {
        try {
          await API.saveUserLibraries(this._payload());
          if (migrate) {
            try { localStorage.removeItem(this._STORAGE_KEY); } catch (e) { /* private mode */ }
            if (typeof UI !== 'undefined') UI.toast('Your component libraries were moved from this browser into your account.', 'info', 6000);
          }
        } catch (e) {
          // Keep any browser copy; the next library edit saves the account copy.
          if (typeof UI !== 'undefined') UI.toast('Could not save your libraries to your account yet: ' + e.message, 'warning', 8000);
        }
      }
    } catch (e) {
      this._serverReady = false;
      console.error('Could not load user libraries:', e);
      if (typeof UI !== 'undefined') UI.toast('Could not load your component libraries from the server — showing the shipped defaults; library edits will not be saved until you reload.', 'error', 8000);
    }
  },
  // Rebuild the global arrays + Settings tables without treating it as an edit.
  _syncAllQuiet() {
    const was = this._initialized; this._initialized = false;
    try { this._syncAll(); } finally { this._initialized = was; }
  },

  // An edit was made: save this user's libraries (debounced).
  _persist() {
    if (!this._initialized || !this._serverReady) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveNow(), 800);
  },
  async _saveNow() {
    try {
      await API.saveUserLibraries(this._payload());
      this._saveFailed = false;
    } catch (e) {
      console.error('Failed to save libraries:', e);
      if (!this._saveFailed && typeof UI !== 'undefined') UI.toast('Could not save your component libraries: ' + e.message, 'error', 8000);
      this._saveFailed = true;
    }
  },

  // ═══════════════════════════════════════════════════════
  // ─── Project ↔ library: what a project needs from your libraries ───
  // ═══════════════════════════════════════════════════════
  // The libraries belong to the USER (the Settings modal), never to a project. A
  // project records the library entries it uses that are not the shipped ones
  // (`libraryItems`), and on open they are compared with YOUR libraries: entries
  // you lack, or that differ, are listed and you decide. Nothing overwrites your
  // library without asking. "This project only" entries live in the working copy
  // flagged `_projectOnly` (or `_orig` = yours, when it stands in for one of
  // yours) and are never persisted; they go when the next project opens.

  _LIBKEYS: ['cables', 'transformers', 'cbs', 'fuses', 'loadClasses'],
  _LIBNAME: { cables: 'Cable', transformers: 'Transformer', cbs: 'Circuit breaker', fuses: 'Fuse', loadClasses: 'Load class' },

  _clone(e) { return JSON.parse(JSON.stringify(e)); },
  _label(e) { return e.name || e.label || e.id; },
  // Entry as a plain comparable record (no internal flags; cables completed the way
  // CableLib.normalize does to the working copies).
  _plain(key, e) {
    const o = {};
    for (const k of Object.keys(e)) if (k[0] !== '_') o[k] = e[k];
    if (key === 'cables' && typeof CableLib !== 'undefined') CableLib.normalize(o);
    return o;
  },
  _same(key, a, b) {
    const x = this._plain(key, a), y = this._plain(key, b);
    const ks = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of ks) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false;
    return true;
  },
  // What is saved to this browser: your library, without project-only entries.
  _persistable(key) {
    return this[key].map(e => e._orig ? e._orig : e).filter(e => !e._projectOnly);
  },

  // Library entries this project uses that differ from the shipped defaults
  // (custom or edited), saved with the project. Undefined when there are none.
  usedLibraryItems() {
    if (!this._defaults || typeof AppState === 'undefined') return undefined;
    const ids = { cables: new Set(), transformers: new Set(), cbs: new Set(), fuses: new Set(), loadClasses: new Set() };
    const typeKey = { transformer: 'transformers', cb: 'cbs', fuse: 'fuses' };
    for (const c of AppState.components.values()) {
      const k = typeKey[c.type];
      if (k && c.props && c.props.standard_type) ids[k].add(c.props.standard_type);
    }
    if (typeof CableLib !== 'undefined') for (const c of CableLib._usedEntries()) ids.cables.add(c.id);
    const R = AppState.reticulation;
    if (R) {
      if (R.settings && R.settings.loadClass) ids.loadClasses.add(R.settings.loadClass);
      for (const k of R.kiosks || []) {
        if (k.loadClass) ids.loadClasses.add(k.loadClass);
        for (const e of k.erfs || []) if (e.classId) ids.loadClasses.add(e.classId);
      }
      for (const id of [...ids.loadClasses]) ids.loadClasses.add(id + '_3ph');   // 3-phase twin is read alongside
    }
    const out = {};
    for (const key of this._LIBKEYS) {
      const shipped = new Map(this._defaults[key].map(e => [e.id, e]));
      const list = [];
      for (const id of ids[key]) {
        const src = this[key].find(e => e.id === id);            // the entry in effect (yours, or this project's own)
        if (!src) continue;
        const ship = shipped.get(id);
        // Shipped as-is: everyone has it — except load classes, which calculations read LIVE, so a
        // later correction to a shipped class would silently change this project's results.
        if (ship && key !== 'loadClasses' && this._same(key, ship, src)) continue;
        list.push(this._plain(key, this._clone(src)));
      }
      if (list.length) out[key] = list;
    }
    return Object.keys(out).length ? out : undefined;
  },

  // A different project is opening (or a new one): drop the previous project's
  // project-only entries and put back the entries of yours they stood in for.
  clearProjectOnly() {
    if (!this._defaults) return;
    if (!this._LIBKEYS.some(k => this[k].some(e => e._projectOnly || e._orig))) return;
    for (const k of this._LIBKEYS) this[k] = this._persistable(k).map(e => this._clone(e));
    this._syncAll();
  },
  _syncAll() {
    this.syncCableLibrary(); this.syncTransformerLibrary(); this.syncCBLibrary();
    this.syncFuseLibrary(); this.syncLoadClassLibrary();
    for (const [bodyId, cfg] of Object.entries(this._LIB)) if (document.getElementById(bodyId)) this[cfg.render]();
  },

  // Compare a just-opened project's entries with this user's libraries. Silent when
  // everything is there and identical; otherwise ask, item by item.
  async reviewProjectLibraries(items) {
    if (!this._defaults || !items || typeof items !== 'object') return;
    await this.ready;                      // compare with the user's libraries, not the defaults they replace
    const rows = [];
    for (const key of this._LIBKEYS) {
      for (const e of Array.isArray(items[key]) ? items[key] : []) {
        if (!e || !e.id) continue;
        const mine = this[key].find(x => x.id === e.id);
        if (!mine) { rows.push({ key, e, kind: 'missing' }); continue; }
        if (mine._projectOnly) continue;                          // already brought in this session
        if (this._same(key, mine, e)) continue;
        const a = this._plain(key, mine), b = this._plain(key, e);
        const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          .map(k => ({ k, mine: a[k], proj: b[k] }));
        // Why it differs: the layer your value comes from says whether it is your own edit, a
        // teammate's/company's, or the shipped default having been corrected since this was built.
        const o = this.originOf(key, mine);
        const why = o.origin === 'shipped' ? 'the shipped value has changed since this project was built'
          : o.origin === 'company' ? `differs from the company standard (${o.name})`
          : o.origin === 'shared' ? `differs from shared library "${o.name}"`
          : 'differs from your own edit';
        rows.push({ key, e, kind: 'differs', diffs, why, origin: o.origin });
      }
    }
    if (!rows.length) return;
    const choices = await this._reviewDialog(rows);
    if (!choices) return;
    let added = 0, only = 0, swapped = 0;
    rows.forEach((r, i) => {
      const c = choices[i];
      const arr = this[r.key];
      if (r.kind === 'missing') {
        if (c === 'add') { arr.push(this._clone(r.e)); added++; }
        else if (c === 'project') { arr.push({ ...this._clone(r.e), _projectOnly: true }); only++; }
      } else if (c === 'project') {
        const at = arr.findIndex(x => x.id === r.e.id);
        if (at >= 0) { arr[at] = { ...this._clone(r.e), _projectOnly: true, _orig: this._clone(arr[at]) }; swapped++; }
      }
    });
    if (added || only || swapped) this._syncAll();
    if ((added || only || swapped) && typeof UI !== 'undefined') {
      const bits = [];
      if (added) bits.push(`${added} added to your library`);
      if (only) bits.push(`${only} used in this project only`);
      if (swapped) bits.push(`${swapped} of your entries replaced by the project's for this project only`);
      UI.toast('Libraries: ' + bits.join(', ') + '.', 'info', 6000);
    }
  },

  _fmt(v) { return v === undefined ? '—' : String(v); },
  _reviewDialog(rows) {
    return new Promise(resolve => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.id = 'lib-review-modal';
      m.style.display = 'flex'; m.style.zIndex = '3000';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      const missing = rows.filter(r => r.kind === 'missing').length;
      const differs = rows.length - missing;
      // A shipped load class that was corrected changes ADMD results, so reproduce the project by default.
      const reproduce = r => r.kind === 'differs' && r.key === 'loadClasses' && r.origin === 'shipped';
      const opts = r => r.kind === 'missing'
        ? '<option value="add">Add to my library</option><option value="project">Use in this project only</option><option value="skip">Skip</option>'
        : `<option value="keep"${reproduce(r) ? '' : ' selected'}>Keep mine</option><option value="project"${reproduce(r) ? ' selected' : ''}>Use the project's (this project only)</option>`;
      const body = rows.map((r, i) => {
        const what = r.kind === 'missing'
          ? '<span style="color:var(--warning,#b45309)">not in your library</span>'
          : `<span style="color:var(--warning,#b45309)">${escHtml(r.why)}</span>` + '<div style="font-size:12px;opacity:.8">' + r.diffs.slice(0, 4).map(d => `${escHtml(d.k)}: yours ${escHtml(this._fmt(d.mine))} · project ${escHtml(this._fmt(d.proj))}`).join('<br>') + (r.diffs.length > 4 ? `<br>+${r.diffs.length - 4} more` : '') + '</div>';
        return `<tr><td>${this._LIBNAME[r.key]}</td><td><b>${escHtml(this._label(r.e))}</b><div style="font-size:12px;opacity:.7">${escHtml(r.e.id)}</div></td><td>${what}</td><td><select data-i="${i}">${opts(r)}</select></td></tr>`;
      }).join('');
      m.innerHTML = `<div class="modal-content" style="max-width:820px;width:92vw;max-height:86vh;display:flex;flex-direction:column">
        <div class="modal-header"><h3>This project uses library items you don't have as-is</h3></div>
        <div class="modal-body" style="overflow:auto">
          <p style="margin:0 0 12px">${missing ? `${missing} not in your library` : ''}${missing && differs ? ', ' : ''}${differs ? `${differs} differ from yours` : ''}. Your libraries are never changed unless you choose to. Values already placed on the diagram are unaffected; this decides what the pickers and library-driven calculations (e.g. ADMD load classes) use.</p>
          <table class="props-table" style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Library</th><th align="left">Item</th><th align="left">Status</th><th align="left">What to do</th></tr></thead><tbody>${body}</tbody></table>
        </div>
        <div class="ui-dialog-actions" style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn-small" data-a="skip">Leave everything as it is</button>
          <button type="button" class="btn-primary" data-a="ok">Apply choices</button>
        </div></div>`;
      document.body.appendChild(m);
      const done = (v) => { m.remove(); resolve(v); };
      m.addEventListener('click', ev => {
        const a = ev.target.closest('[data-a]');
        if (!a) return;
        if (a.dataset.a === 'skip') return done(null);
        done([...m.querySelectorAll('select[data-i]')].map(s => s.value));
      });
      m.addEventListener('keydown', ev => { if (ev.key === 'Escape') done(null); });
      const first = m.querySelector('[data-a="ok"]'); if (first) first.focus();
    });
  },

  // ═══════════════════════════════════════════════════════
  // ─── Library rows: search, cards, duplicate ───
  // ═══════════════════════════════════════════════════════
  // The libraries are editable tables. On a phone each row becomes a card (name + one-line
  // summary) that expands into a labelled form; the same inputs stay in the DOM, so the
  // existing change handlers keep working. Search and filter chips work at every width.

  _LIB: {
    'cable-library-body': { tab: 'cables', arr: 'cables', render: 'renderCableTable', sync: 'syncCableLibrary', prefix: 'custom_cable_', nameKey: 'name',
      sum: g => [g('conductor'), g('insulation'), g('size_mm2') + ' mm²', g('voltage_kv') + ' kV', g('rated_amps') + ' A'] },
    'xfmr-library-body': { tab: 'transformers', arr: 'transformers', render: 'renderTransformerTable', sync: 'syncTransformerLibrary', prefix: 'custom_xfmr_', nameKey: 'name',
      sum: g => [g('rated_mva') + ' MVA', g('voltage_hv_kv') + '/' + g('voltage_lv_kv') + ' kV', g('z_percent') + ' %', g('vector_group')] },
    'cb-library-body': { tab: 'cbs', arr: 'cbs', render: 'renderCBTable', sync: 'syncCBLibrary', prefix: 'custom_cb_', nameKey: 'name',
      sum: g => [String(g('cb_type')).toUpperCase(), g('trip_rating_a') + ' A', g('rated_voltage_kv') + ' kV', g('breaking_ka') + ' kA'] },
    'fuse-library-body': { tab: 'fuses', arr: 'fuses', render: 'renderFuseTable', sync: 'syncFuseLibrary', prefix: 'custom_fuse_', nameKey: 'name',
      sum: g => [g('fuse_type'), g('rated_current_a') + ' A', g('rated_voltage_kv') + ' kV', g('breaking_ka') + ' kA'] },
    'loadclass-library-body': { tab: 'load-classes', arr: 'loadClasses', render: 'renderLoadClassTable', sync: 'syncLoadClassLibrary', prefix: 'custom_class_', nameKey: 'label',
      sum: g => [g('lsm') ? 'LSM ' + g('lsm') : '', 'ADMD ' + g('admd'), String(g('phase')).replace(/Φ/, '') + 'Φ'] },
  },
  _libOpen: {},      // tbody id → index of the expanded card
  _libFilter: {},    // tbody id → { q, kv, cond }

  _initLibraryUI() {
    // Every render*Table rebuilds its tbody: decorate the rows again afterwards
    for (const [bodyId, cfg] of Object.entries(this._LIB)) {
      const orig = this[cfg.render];
      this[cfg.render] = function (...args) {
        const r = orig.apply(this, args);
        this._decorateLibrary(bodyId);
        return r;
      };
    }
    // Search box (and cable filter chips) above each library table
    for (const [bodyId, cfg] of Object.entries(this._LIB)) {
      const wrap = document.getElementById(bodyId)?.closest('.library-table-wrap');
      if (!wrap) continue;
      const bar = document.createElement('div');
      bar.className = 'lib-searchbar';
      bar.innerHTML = `<input type="search" class="lib-search" data-lib="${bodyId}" placeholder="Search" aria-label="Search this library"><div class="lib-chips" data-lib="${bodyId}"></div>`;
      wrap.parentNode.insertBefore(bar, wrap);
      bar.querySelector('.lib-search').addEventListener('input', (e) => {
        (this._libFilter[bodyId] = this._libFilter[bodyId] || {}).q = e.target.value.trim().toLowerCase();
        this._applyLibraryFilter(bodyId);
      });
    }
  },

  _rowGetter(tr) {
    return (key) => {
      const el = tr.querySelector(`[data-key="${key}"]`);
      if (!el) return '';
      if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text || el.value;
      return el.value;
    };
  },

  _rowSummary(bodyId, tr) {
    const cfg = this._LIB[bodyId];
    return cfg.sum(this._rowGetter(tr)).filter(x => x && !/^\s*(undefined|null)/.test(x)).join(' · ');
  },

  // Turn each table row into a card: labelled cells, a head with name + summary, Duplicate
  _decorateLibrary(bodyId) {
    const tbody = document.getElementById(bodyId);
    const cfg = this._LIB[bodyId];
    if (!tbody || !cfg) return;
    const heads = [...tbody.closest('table').querySelectorAll('thead th')].map(th => th.textContent.trim());
    tbody.querySelectorAll('tr').forEach(tr => {
      const cells = [...tr.children];
      cells.forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; else td.classList.add('lib-del'); });
      const nameInput = tr.querySelector(`[data-key="${cfg.nameKey}"]`);
      const head = document.createElement('td');
      head.className = 'lib-head';
      head.innerHTML = `<button type="button" class="lib-toggle" aria-expanded="false"><span class="lib-title"></span><span class="lib-sum"></span><span class="lib-chev" aria-hidden="true">›</span></button>`;
      tr.insertBefore(head, tr.firstChild);
      const refresh = () => {
        head.querySelector('.lib-title').textContent = nameInput ? nameInput.value : '';
        head.querySelector('.lib-sum').textContent = this._rowSummary(bodyId, tr);
      };
      refresh();
      tr.addEventListener('change', refresh);
      head.querySelector('.lib-toggle').addEventListener('click', () => this._toggleLibraryRow(bodyId, tr));
      // Duplicate sits beside Delete in the expanded card
      const del = tr.querySelector('.lib-del');
      if (del) {
        const dup = document.createElement('button');
        dup.type = 'button'; dup.className = 'btn-dup-row'; dup.textContent = 'Duplicate';
        dup.addEventListener('click', () => this._duplicateLibraryRow(bodyId, parseInt(tr.dataset.index)));
        del.insertBefore(dup, del.firstChild);
        const delBtn = del.querySelector('.btn-delete-row');
        if (delBtn) delBtn.setAttribute('aria-label', 'Delete');
      }
    });
    const open = this._libOpen[bodyId];
    if (open != null) {
      const tr = tbody.querySelector(`tr[data-index="${open}"]`);
      if (tr) this._toggleLibraryRow(bodyId, tr, true);
    }
    this._renderLibraryChips(bodyId);
    this._applyLibraryFilter(bodyId);
  },

  _toggleLibraryRow(bodyId, tr, forceOpen) {
    const tbody = document.getElementById(bodyId);
    const willOpen = forceOpen || !tr.classList.contains('lib-open');
    tbody.querySelectorAll('tr.lib-open').forEach(r => { r.classList.remove('lib-open'); r.querySelector('.lib-toggle')?.setAttribute('aria-expanded', 'false'); });
    this._libOpen[bodyId] = willOpen ? parseInt(tr.dataset.index) : null;
    if (willOpen) {
      tr.classList.add('lib-open');
      tr.querySelector('.lib-toggle')?.setAttribute('aria-expanded', 'true');
      if (this._compactOn && !forceOpen) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  },

  _duplicateLibraryRow(bodyId, idx) {
    const cfg = this._LIB[bodyId];
    const src = this[cfg.arr][idx];
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = cfg.prefix + Date.now();
    copy[cfg.nameKey] = `${src[cfg.nameKey]} copy`;
    this[cfg.arr].splice(idx + 1, 0, copy);
    this._libOpen[bodyId] = idx + 1;
    this[cfg.render]();
    this[cfg.sync]();
    document.getElementById(bodyId).querySelector(`tr[data-index="${idx + 1}"]`)?.scrollIntoView({ block: 'nearest' });
  },

  // A row added with "+ Add" opens straight away so it can be filled in
  _openLastRow(bodyId) {
    const cfg = this._LIB[bodyId];
    this._libOpen[bodyId] = this[cfg.arr].length - 1;
  },

  _renderLibraryChips(bodyId) {
    const box = document.querySelector(`.lib-chips[data-lib="${bodyId}"]`);
    if (!box || bodyId !== 'cable-library-body') return;
    const f = this._libFilter[bodyId] = this._libFilter[bodyId] || {};
    const kvs = [...new Set(this.cables.map(c => c.voltage_kv))].sort((a, b) => a - b);
    const conds = [...new Set(this.cables.map(c => c.conductor))];
    const chip = (grp, val, text, on) => `<button type="button" class="lib-chip${on ? ' active' : ''}" data-grp="${grp}" data-val="${val}" aria-pressed="${on}">${text}</button>`;
    box.innerHTML = chip('kv', '', 'All voltages', f.kv == null) + kvs.map(v => chip('kv', v, v + ' kV', String(f.kv) === String(v))).join('') +
      conds.map(c => chip('cond', c, c, f.cond === c)).join('');
    box.querySelectorAll('.lib-chip').forEach(b => b.addEventListener('click', () => {
      const grp = b.dataset.grp, val = b.dataset.val;
      if (grp === 'kv') f.kv = val === '' ? null : val;
      else f.cond = (f.cond === val) ? null : val;
      this._renderLibraryChips(bodyId);
      this._applyLibraryFilter(bodyId);
    }));
  },

  _applyLibraryFilter(bodyId) {
    const tbody = document.getElementById(bodyId);
    if (!tbody) return;
    const f = this._libFilter[bodyId] || {};
    const q = f.q || '';
    let shown = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      const g = this._rowGetter(tr);
      let ok = true;
      if (q) ok = (g('name') + ' ' + g('label') + ' ' + this._rowSummary(bodyId, tr)).toLowerCase().includes(q);
      if (ok && f.kv != null) ok = String(parseFloat(g('voltage_kv'))) === String(parseFloat(f.kv));
      if (ok && f.cond != null) ok = g('conductor') === f.cond;
      tr.hidden = !ok;
      if (ok) shown++;
    });
    let none = tbody.parentNode.querySelector('.lib-none');
    if (!shown) {
      if (!none) { none = document.createElement('div'); none.className = 'lib-none'; tbody.closest('.library-table-wrap').appendChild(none); }
      none.textContent = 'Nothing matches.';
    } else if (none) none.remove();
  },

  // ═══════════════════════════════════════════════════════
  // ─── Phone layout: section list + one screen per section ───
  // ═══════════════════════════════════════════════════════

  _compactOn: false,
  _screen: 'home',

  _SECTIONS: [
    { group: 'General', tab: 'system', sub: () => `${AppState.baseMVA} MVA · ${AppState.frequency} Hz · c = ${(AppState.voltageFactor ?? DEFAULT_VOLTAGE_FACTOR).toFixed(2)}` },
    { group: 'Libraries', tab: 'cables', sub: () => 'Sizes, resistance, ratings', count: s => s.cables.length },
    { group: 'Libraries', tab: 'transformers', sub: () => 'Ratings, vector groups, impedance', count: s => s.transformers.length },
    { group: 'Libraries', tab: 'cbs', sub: () => 'Frames, trip units, ratings', count: s => s.cbs.length },
    { group: 'Libraries', tab: 'fuses', sub: () => 'Ratings and breaking capacity', count: s => s.fuses.length },
    { group: 'Reference', tab: 'load-classes', sub: () => 'Demand parameters (NRS 034-1)', count: s => s.loadClasses.length },
    { group: 'Reference', tab: 'iec-standards', sub: () => 'Ampacity, sizing and derating tables' },
  ],

  _initCompact() {
    this._compactMQ = window.matchMedia('(max-width: 768px)');
    this._compactMQ.addEventListener('change', () => this._applyCompact());
    document.getElementById('btn-settings-back')?.addEventListener('click', () => this._showScreen('home'));
    document.getElementById('btn-settings-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = document.getElementById('settings-more-menu');
      m.hidden = !m.hidden;
    });
    document.getElementById('settings-more-menu')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-more]');
      if (!b) return;
      document.getElementById('settings-more-menu').hidden = true;
      if (b.dataset.more === 'reset') {
        const map = { cables: 'btn-reset-cables', transformers: 'btn-reset-xfmrs', cbs: 'btn-reset-cbs', fuses: 'btn-reset-fuses', 'load-classes': 'btn-reset-loadclasses' };
        document.getElementById(map[this._screen])?.click(); // keeps the existing confirmation
      }
    });
    document.addEventListener('click', () => { const m = document.getElementById('settings-more-menu'); if (m) m.hidden = true; });
    this._applyCompact();
  },

  _applyCompact() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    const on = this._compactMQ.matches;
    modal.classList.toggle('settings-compact', on);
    this._compactOn = on;
    if (on) {
      this._showScreen(this._screen === 'home' ? 'home' : this._screen);
    } else {
      modal.removeAttribute('data-screen');
      document.getElementById('settings-home').hidden = true;
      document.getElementById('btn-settings-back').hidden = true;
      document.getElementById('btn-settings-more').hidden = true;
      document.getElementById('settings-title').textContent = 'Settings';
    }
  },

  _buildHome() {
    const home = document.getElementById('settings-home');
    let html = '', last = '';
    for (const sec of this._SECTIONS) {
      const tab = document.querySelector(`.settings-tab[data-tab="${sec.tab}"]`);
      if (!tab) continue;
      if (sec.group !== last) { html += `<div class="settings-home-group">${sec.group}</div>`; last = sec.group; }
      const n = sec.count ? sec.count(this) : null;
      html += `<button type="button" class="settings-home-row" data-go="${sec.tab}"><span class="settings-home-text"><span class="settings-home-title">${escHtml(tab.textContent.trim())}</span><span class="settings-home-sub">${escHtml(sec.sub())}</span></span>${n != null ? `<span class="settings-home-count">${n}</span>` : ''}<span class="settings-home-chev" aria-hidden="true">›</span></button>`;
    }
    home.innerHTML = html;
    home.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => this._showScreen(b.dataset.go)));
  },

  _showScreen(name) {
    if (!this._compactOn) return;
    const modal = document.getElementById('settings-modal');
    const home = document.getElementById('settings-home');
    this._screen = name;
    modal.setAttribute('data-screen', name === 'home' ? 'home' : 'section');
    document.getElementById('settings-more-menu').hidden = true;
    if (name === 'home') {
      this._buildHome();
      home.hidden = false;
      document.getElementById('btn-settings-back').hidden = true;
      document.getElementById('btn-settings-more').hidden = true;
      document.getElementById('settings-title').textContent = 'Settings';
      return;
    }
    home.hidden = true;
    const tab = document.querySelector(`.settings-tab[data-tab="${name}"]`);
    if (tab) tab.click(); // activates the pane and renders its table
    document.getElementById('btn-settings-back').hidden = false;
    document.getElementById('settings-title').textContent = tab ? tab.textContent.trim() : 'Settings';
    document.getElementById('btn-settings-more').hidden = !['cables', 'transformers', 'cbs', 'fuses', 'load-classes'].includes(name);
    document.querySelector('#settings-modal .modal-body')?.scrollTo(0, 0);
  },

  // ─── Tab Switching ───
  bindTabs() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`settings-tab-${tab.dataset.tab}`).classList.add('active');
        // Render table when tab becomes active
        if (tab.dataset.tab === 'cables') this.renderCableTable();
        if (tab.dataset.tab === 'transformers') this.renderTransformerTable();
        if (tab.dataset.tab === 'cbs') this.renderCBTable();
        if (tab.dataset.tab === 'fuses') this.renderFuseTable();
        if (tab.dataset.tab === 'load-classes') this.renderLoadClassTable();
        if (tab.dataset.tab === 'iec-standards') this.renderIECActiveSection();
      });
    });
  },

  // ─── Cable Library Table ───
  bindCableTable() {
    document.getElementById('btn-add-cable').addEventListener('click', () => {
      const id = 'custom_cable_' + Date.now();
      this.cables.push({
        id, name: 'New Cable', conductor: 'Cu', insulation: 'XLPE',
        size_mm2: 0, voltage_kv: 11, r_per_km: 0, x_per_km: 0,
        r0_per_km: 0, x0_per_km: 0, rated_amps: 0, cores: 3, construction: 'armoured',
      });
      this._openLastRow('cable-library-body');
      this.renderCableTable();
      this.syncCableLibrary();
    });

    document.getElementById('btn-reset-cables').addEventListener('click', async () => {
      if (!(await UI.confirm('Reset the cable library?\nYour own cables and edits are discarded; the shipped (and any company or shared) entries stay.', { danger: true }))) return;
      this._resetLibrary('cables');
      this.renderCableTable();
      this.syncCableLibrary();
    });
  },

  renderCableTable() {
    const tbody = document.getElementById('cable-library-body');
    tbody.innerHTML = this.cables.map((c, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${escHtml(c.name)}" data-key="name"></td>
        <td><select data-key="conductor">
          <option value="Cu" ${c.conductor === 'Cu' ? 'selected' : ''}>Cu</option>
          <option value="Al" ${c.conductor === 'Al' ? 'selected' : ''}>Al</option>
        </select></td>
        <td><select data-key="insulation">
          <option value="XLPE" ${c.insulation === 'XLPE' ? 'selected' : ''}>XLPE</option>
          <option value="PVC" ${c.insulation === 'PVC' ? 'selected' : ''}>PVC</option>
          <option value="EPR" ${c.insulation === 'EPR' ? 'selected' : ''}>EPR</option>
        </select></td>
        <td><select data-key="construction">${CableLib.CONSTRUCTIONS.map(k => `<option value="${k.id}" ${(c.construction || 'armoured') === k.id ? 'selected' : ''}>${escHtml(k.label)}</option>`).join('')}</select></td>
        <td><input type="number" value="${c.cores || ''}" data-key="cores" step="1" min="1"></td>
        <td><input type="number" value="${c.size_mm2}" data-key="size_mm2" step="any"></td>
        <td><input type="number" value="${c.voltage_kv}" data-key="voltage_kv" step="any"></td>
        <td><input type="number" value="${c.r_per_km}" data-key="r_per_km" step="any"></td>
        <td><input type="number" value="${c.x_per_km}" data-key="x_per_km" step="any"></td>
        <td><input type="number" value="${c.r0_per_km || 0}" data-key="r0_per_km" step="any"></td>
        <td><input type="number" value="${c.x0_per_km || 0}" data-key="x0_per_km" step="any"></td>
        <td><input type="number" value="${c.rated_amps}" data-key="rated_amps" step="any"></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    // Bind events
    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        const old = this.cables[idx][key];
        this.cables[idx][key] = val;
        this.syncCableLibrary();
        // A renamed cable keeps its references (and its rates, which key off the id).
        if (key === 'name' && typeof CableLib !== 'undefined') {
          const n = CableLib.renameInProject(old, val);
          if (n && typeof UI !== 'undefined') UI.toast(`Renamed in this project too (${n} reference${n === 1 ? '' : 's'}).`, 'info');
        }
      });
    });

    if (typeof GridTable !== 'undefined') GridTable.attach(tbody);   // Excel-style editing
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.cables.splice(idx, 1);
        this.renderCableTable();
        this.syncCableLibrary();
      });
    });
  },

  syncCableLibrary() {
    // Update the global STANDARD_CABLES array in-place
    STANDARD_CABLES.length = 0;
    for (const c of this.cables) STANDARD_CABLES.push(typeof CableLib !== 'undefined' ? CableLib.normalize(c) : c);
    this._persist();
  },

  // ─── Load-Class Library Table (NRS 034-1 / CTEF100 ADMD) ───
  bindLoadClassTable() {
    document.getElementById('btn-add-loadclass').addEventListener('click', () => {
      const id = 'custom_class_' + Date.now();
      this.loadClasses.push({
        id, label: 'New Class', lsm: '', a: 1.0, b: 3.0, c: 60,
        admd: 4.0, mu: 17.4, sigma: 12.0, phase: 1,
      });
      this._openLastRow('loadclass-library-body');
      this.renderLoadClassTable();
      this.syncLoadClassLibrary();
    });

    document.getElementById('btn-reset-loadclasses').addEventListener('click', async () => {
      if (!(await UI.confirm('Reset the load-class library?\nYour own classes and edits are discarded; the shipped (and any company or shared) entries stay.', { danger: true }))) return;
      this._resetLibrary('loadClasses');
      this.renderLoadClassTable();
      this.syncLoadClassLibrary();
    });
  },

  renderLoadClassTable() {
    const tbody = document.getElementById('loadclass-library-body');
    if (!tbody) return;
    tbody.innerHTML = this.loadClasses.map((c, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${escHtml(c.label)}" data-key="label"></td>
        <td><input type="text" value="${escHtml(c.lsm || '')}" data-key="lsm" style="width:48px"></td>
        <td><input type="number" value="${c.a}" data-key="a" step="any" style="width:64px"></td>
        <td><input type="number" value="${c.b}" data-key="b" step="any" style="width:64px"></td>
        <td><input type="number" value="${c.c}" data-key="c" step="any" style="width:64px"></td>
        <td><input type="number" value="${c.admd}" data-key="admd" step="any" style="width:72px"></td>
        <td><input type="number" value="${c.mu}" data-key="mu" step="any" style="width:64px"></td>
        <td><input type="number" value="${c.sigma}" data-key="sigma" step="any" style="width:64px"></td>
        <td><select data-key="phase">
          <option value="1" ${Number(c.phase) === 1 ? 'selected' : ''}>1Φ</option>
          <option value="3" ${Number(c.phase) === 3 ? 'selected' : ''}>3Φ</option>
        </select></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.closest('tr').dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number' || key === 'phase') val = parseFloat(val) || 0;
        this.loadClasses[idx][key] = val;
        this.syncLoadClassLibrary();
      });
    });

    if (typeof GridTable !== 'undefined') GridTable.attach(tbody);   // Excel-style editing
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.loadClasses.splice(parseInt(e.target.dataset.index), 1);
        this.renderLoadClassTable();
        this.syncLoadClassLibrary();
      });
    });
  },

  syncLoadClassLibrary() {
    // Update the global STANDARD_LOAD_CLASSES array in-place
    STANDARD_LOAD_CLASSES.length = 0;
    for (const c of this.loadClasses) STANDARD_LOAD_CLASSES.push(c);
    this._persist();
  },

  // ─── Transformer Library Table ───
  bindTransformerTable() {
    document.getElementById('btn-add-xfmr').addEventListener('click', () => {
      const id = 'custom_xfmr_' + Date.now();
      this.transformers.push({
        id, name: 'New Transformer', rated_mva: 0, voltage_hv_kv: 11,
        voltage_lv_kv: 0.42, z_percent: 5, x_r_ratio: 10, vector_group: 'Dyn11',
      });
      this._openLastRow('xfmr-library-body');
      this.renderTransformerTable();
      this.syncTransformerLibrary();
    });

    document.getElementById('btn-reset-xfmrs').addEventListener('click', async () => {
      if (!(await UI.confirm('Reset the transformer library?\nYour own transformers and edits are discarded; the shipped (and any company or shared) entries stay.', { danger: true }))) return;
      this._resetLibrary('transformers');
      this.renderTransformerTable();
      this.syncTransformerLibrary();
    });
  },

  renderTransformerTable() {
    const tbody = document.getElementById('xfmr-library-body');
    const vectors = ['Dyn11', 'Dyn1', 'YNd11', 'YNd1', 'Yyn0', 'Dd0'];
    tbody.innerHTML = this.transformers.map((t, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${escHtml(t.name)}" data-key="name"></td>
        <td><input type="number" value="${t.rated_mva}" data-key="rated_mva" step="any"></td>
        <td><input type="number" value="${t.voltage_hv_kv}" data-key="voltage_hv_kv" step="any"></td>
        <td><input type="number" value="${t.voltage_lv_kv}" data-key="voltage_lv_kv" step="any"></td>
        <td><input type="number" value="${t.z_percent}" data-key="z_percent" step="any"></td>
        <td><input type="number" value="${t.x_r_ratio}" data-key="x_r_ratio" step="any"></td>
        <td><select data-key="vector_group">
          ${vectors.map(v => `<option value="${v}" ${t.vector_group === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    // Bind events
    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        this.transformers[idx][key] = val;
        this.syncTransformerLibrary();
      });
    });

    if (typeof GridTable !== 'undefined') GridTable.attach(tbody);   // Excel-style editing
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.transformers.splice(idx, 1);
        this.renderTransformerTable();
        this.syncTransformerLibrary();
      });
    });
  },

  syncTransformerLibrary() {
    STANDARD_TRANSFORMERS.length = 0;
    for (const t of this.transformers) STANDARD_TRANSFORMERS.push(t);
    this._persist();
  },

  // ─── Circuit Breaker Library Table ───
  bindCBTable() {
    document.getElementById('btn-add-cb').addEventListener('click', () => {
      const id = 'custom_cb_' + Date.now();
      this.cbs.push({
        id, name: 'New CB', cb_type: 'mccb', trip_rating_a: 100, frame_a: 100,
        rated_voltage_kv: 0.4, breaking_ka: 25, thermal_pickup: 1.0,
        magnetic_pickup: 10, long_time_delay: 10,
      });
      this._openLastRow('cb-library-body');
      this.renderCBTable();
      this.syncCBLibrary();
    });

    document.getElementById('btn-reset-cbs').addEventListener('click', async () => {
      if (!(await UI.confirm('Reset the circuit breaker library?\nYour own breakers and edits are discarded; the shipped (and any company or shared) entries stay.', { danger: true }))) return;
      this._resetLibrary('cbs');
      this.renderCBTable();
      this.syncCBLibrary();
    });
  },

  renderCBTable() {
    const tbody = document.getElementById('cb-library-body');
    tbody.innerHTML = this.cbs.map((c, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${escHtml(c.name)}" data-key="name"></td>
        <td><select data-key="cb_type">
          <option value="mcb" ${c.cb_type === 'mcb' ? 'selected' : ''}>MCB</option>
          <option value="mccb" ${c.cb_type === 'mccb' ? 'selected' : ''}>MCCB</option>
          <option value="acb" ${c.cb_type === 'acb' ? 'selected' : ''}>ACB</option>
        </select></td>
        <td><input type="number" value="${c.trip_rating_a}" data-key="trip_rating_a" step="any"></td>
        <td><input type="number" value="${c.rated_voltage_kv}" data-key="rated_voltage_kv" step="any"></td>
        <td><input type="number" value="${c.breaking_ka}" data-key="breaking_ka" step="any"></td>
        <td><input type="number" value="${c.magnetic_pickup}" data-key="magnetic_pickup" step="any"></td>
        <td><input type="number" value="${c.long_time_delay}" data-key="long_time_delay" step="any"></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        this.cbs[idx][key] = val;
        this.syncCBLibrary();
      });
    });

    if (typeof GridTable !== 'undefined') GridTable.attach(tbody);   // Excel-style editing
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.cbs.splice(idx, 1);
        this.renderCBTable();
        this.syncCBLibrary();
      });
    });
  },

  syncCBLibrary() {
    STANDARD_CBS.length = 0;
    for (const c of this.cbs) STANDARD_CBS.push(c);
    this._persist();
  },

  // ─── Fuse Library Table ───
  bindFuseTable() {
    document.getElementById('btn-add-fuse').addEventListener('click', () => {
      const id = 'custom_fuse_' + Date.now();
      this.fuses.push({
        id, name: 'New Fuse', fuse_type: 'gG', rated_current_a: 100,
        rated_voltage_kv: 0.4, breaking_ka: 80,
      });
      this._openLastRow('fuse-library-body');
      this.renderFuseTable();
      this.syncFuseLibrary();
    });

    document.getElementById('btn-reset-fuses').addEventListener('click', async () => {
      if (!(await UI.confirm('Reset the fuse library?\nYour own fuses and edits are discarded; the shipped (and any company or shared) entries stay.', { danger: true }))) return;
      this._resetLibrary('fuses');
      this.renderFuseTable();
      this.syncFuseLibrary();
    });
  },

  renderFuseTable() {
    const tbody = document.getElementById('fuse-library-body');
    tbody.innerHTML = this.fuses.map((f, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${escHtml(f.name)}" data-key="name"></td>
        <td><select data-key="fuse_type">
          <option value="gG" ${f.fuse_type === 'gG' ? 'selected' : ''}>gG</option>
          <option value="aM" ${f.fuse_type === 'aM' ? 'selected' : ''}>aM</option>
        </select></td>
        <td><input type="number" value="${f.rated_current_a}" data-key="rated_current_a" step="any"></td>
        <td><input type="number" value="${f.rated_voltage_kv}" data-key="rated_voltage_kv" step="any"></td>
        <td><input type="number" value="${f.breaking_ka}" data-key="breaking_ka" step="any"></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        this.fuses[idx][key] = val;
        this.syncFuseLibrary();
      });
    });

    if (typeof GridTable !== 'undefined') GridTable.attach(tbody);   // Excel-style editing
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.fuses.splice(idx, 1);
        this.renderFuseTable();
        this.syncFuseLibrary();
      });
    });
  },

  syncFuseLibrary() {
    STANDARD_FUSES.length = 0;
    for (const f of this.fuses) STANDARD_FUSES.push(f);
    this._persist();
  },

  // Open settings modal
  open() {
    document.getElementById('base-mva').value = AppState.baseMVA;
    document.getElementById('base-freq').value = AppState.frequency;
    document.getElementById('voltage-factor').value = AppState.voltageFactor ?? DEFAULT_VOLTAGE_FACTOR;
    document.getElementById('default-length-unit').value = AppState.defaultLengthUnit || 'm';
    document.getElementById('use-iec-symbols').checked = AppState.symbolSet === 'iec';
    document.getElementById('settings-modal').style.display = '';
    // Render the currently active tab's table
    const activeTab = document.querySelector('.settings-tab.active');
    if (activeTab.dataset.tab === 'cables') this.renderCableTable();
    else if (activeTab.dataset.tab === 'transformers') this.renderTransformerTable();
    else if (activeTab.dataset.tab === 'cbs') this.renderCBTable();
    else if (activeTab.dataset.tab === 'fuses') this.renderFuseTable();
    else if (activeTab.dataset.tab === 'iec-standards') this.renderIECActiveSection();
    if (this._compactOn) this._showScreen('home');
  },

  // ═══════════════════════════════════════════════════════
  // ─── IEC Standards Database ───
  // ═══════════════════════════════════════════════════════

  bindIECStandards() {
    // Sub-tab switching
    document.querySelectorAll('.iec-subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.iec-subtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.iec-section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`iec-section-${tab.dataset.iec}`).classList.add('active');
        this.renderIECActiveSection();
      });
    });

    // Ampacity filter changes
    document.getElementById('iec-amp-conductor').addEventListener('change', () => this.renderAmpacityTable());
    document.getElementById('iec-amp-insulation').addEventListener('change', () => this.renderAmpacityTable());

    // Derating environment filter
    document.getElementById('iec-derating-env').addEventListener('change', () => this.renderTempTable());

    // Populate installation method dropdown for calculator
    const methodSelect = document.getElementById('iec-calc-method');
    for (const m of IEC_INSTALLATION_METHODS) {
      const opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = `${m.code} — ${m.description}`;
      methodSelect.appendChild(opt);
    }

    // Show/hide soil & depth fields based on method
    methodSelect.addEventListener('change', () => this._updateBuriedFields());

    // Calculator button
    document.getElementById('btn-iec-calculate').addEventListener('click', () => this.calculateCableSize());
  },

  _updateBuriedFields() {
    const method = document.getElementById('iec-calc-method').value;
    const isBuried = method.startsWith('D');
    document.getElementById('iec-soil-group').style.display = isBuried ? '' : 'none';
    document.getElementById('iec-depth-group').style.display = isBuried ? '' : 'none';
  },

  renderIECActiveSection() {
    const active = document.querySelector('.iec-subtab.active');
    if (!active) return;
    const section = active.dataset.iec;
    if (section === 'ampacity') this.renderAmpacityTable();
    else if (section === 'derating') { this.renderTempTable(); this.renderGroupTable(); this.renderSoilTable(); this.renderDepthTable(); }
    else if (section === 'voltage-factors') this.renderVoltageFactors();
  },

  // ─── Ampacity Reference Table ───
  renderAmpacityTable() {
    const conductor = document.getElementById('iec-amp-conductor').value;  // cu | al
    const insulation = document.getElementById('iec-amp-insulation').value; // xlpe | pvc
    const key = `${insulation}_${conductor}`;  // e.g. 'xlpe_cu'

    // Determine which methods have data for this combo
    const allMethods = ['A1', 'B1', 'C', 'D1', 'D2', 'E', 'F'];
    const methods = allMethods.filter(m => {
      // Check if any size has data for this method+key combo
      return Object.values(IEC_AMPACITY_TABLE).some(row => row[m] && row[m][key] != null);
    });

    // Header
    const thead = document.getElementById('iec-ampacity-head');
    thead.innerHTML = `<tr><th>Size (mm&sup2;)</th>${methods.map(m => `<th>${m}</th>`).join('')}</tr>`;

    // Body
    const tbody = document.getElementById('iec-ampacity-body');
    const rows = [];
    for (const size of IEC_STANDARD_SIZES) {
      const sizeData = IEC_AMPACITY_TABLE[size];
      if (!sizeData) continue;
      const cells = methods.map(m => {
        const val = sizeData[m] ? sizeData[m][key] : null;
        return `<td class="num-cell">${val != null ? val : '—'}</td>`;
      });
      rows.push(`<tr><td class="num-cell"><strong>${size}</strong></td>${cells.join('')}</tr>`);
    }
    tbody.innerHTML = rows.join('');
  },

  // ─── Temperature Correction Table ───
  renderTempTable() {
    const env = document.getElementById('iec-derating-env').value; // air | ground
    const data = IEC_TEMP_CORRECTION[env];

    const thead = document.getElementById('iec-temp-head');
    thead.innerHTML = `<tr><th>Ambient Temp (&deg;C)</th><th>PVC</th><th>XLPE</th></tr>`;

    const tbody = document.getElementById('iec-temp-body');
    // Collect all temperatures from both insulation types
    const temps = new Set();
    for (const t of Object.keys(data.pvc)) temps.add(Number(t));
    for (const t of Object.keys(data.xlpe)) temps.add(Number(t));
    const sorted = Array.from(temps).sort((a, b) => a - b);

    tbody.innerHTML = sorted.map(t => {
      const pvc = data.pvc[t];
      const xlpe = data.xlpe[t];
      const refClass = (env === 'air' && t === 30) || (env === 'ground' && t === 20) ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}>
        <td class="num-cell">${t}</td>
        <td class="num-cell">${pvc != null ? pvc.toFixed(2) : '—'}</td>
        <td class="num-cell">${xlpe != null ? xlpe.toFixed(2) : '—'}</td>
      </tr>`;
    }).join('');
  },

  // ─── Grouping Factor Table ───
  renderGroupTable() {
    const arrangements = Object.keys(IEC_GROUPING_FACTORS);
    const labels = {
      bunched: 'Bunched / conduit',
      single_layer_wall: 'Single layer on wall',
      single_layer_floor: 'Single layer on floor',
      single_layer_tray_touching: 'Single layer tray (touching)',
      single_layer_tray_spaced: 'Single layer tray (spaced)',
      trefoil_tray_touching: 'Trefoil tray (touching)',
    };

    // Collect all circuit counts
    const counts = new Set();
    for (const arr of arrangements) {
      for (const n of Object.keys(IEC_GROUPING_FACTORS[arr])) counts.add(Number(n));
    }
    const sorted = Array.from(counts).sort((a, b) => a - b);

    const thead = document.getElementById('iec-group-head');
    thead.innerHTML = `<tr><th>Circuits</th>${arrangements.map(a => `<th>${labels[a] || a}</th>`).join('')}</tr>`;

    const tbody = document.getElementById('iec-group-body');
    tbody.innerHTML = sorted.map(n => {
      const cells = arrangements.map(a => {
        const val = IEC_GROUPING_FACTORS[a][n];
        return `<td class="num-cell">${val != null ? val.toFixed(2) : '—'}</td>`;
      });
      return `<tr><td class="num-cell">${n}</td>${cells.join('')}</tr>`;
    }).join('');
  },

  // ─── Soil Resistivity Table ───
  renderSoilTable() {
    const tbody = document.getElementById('iec-soil-body');
    tbody.innerHTML = Object.entries(IEC_SOIL_RESISTIVITY_FACTORS).map(([r, f]) => {
      const refClass = Number(r) === 2.5 ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}><td class="num-cell">${r}</td><td class="num-cell">${f.toFixed(2)}</td></tr>`;
    }).join('');
  },

  // ─── Depth of Laying Table ───
  renderDepthTable() {
    const tbody = document.getElementById('iec-depth-body');
    tbody.innerHTML = Object.entries(IEC_DEPTH_FACTORS).map(([d, f]) => {
      const refClass = Number(d) === 0.7 ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}><td class="num-cell">${d}</td><td class="num-cell">${f.toFixed(2)}</td></tr>`;
    }).join('');
  },

  // ─── IEC 60909 Voltage Factors ───
  renderVoltageFactors() {
    const tbody = document.getElementById('iec-vf-body');
    tbody.innerHTML = Object.entries(IEC_60909_VOLTAGE_FACTORS).map(([level, d]) => {
      const label = level === 'lv' ? 'Low Voltage' : level === 'mv' ? 'Medium Voltage' : 'High Voltage';
      return `<tr>
        <td><strong>${label}</strong></td>
        <td>${d.description}</td>
        <td class="num-cell">${d.cmax}</td>
        <td class="num-cell">${d.cmin}</td>
      </tr>`;
    }).join('');
  },

  // ═══════════════════════════════════════════════════════
  // ─── Cable Sizing Calculator ───
  // ═══════════════════════════════════════════════════════

  calculateCableSize() {
    const Ib = parseFloat(document.getElementById('iec-calc-current').value) || 0;
    const conductor = document.getElementById('iec-calc-conductor').value;
    const insulation = document.getElementById('iec-calc-insulation').value;
    const method = document.getElementById('iec-calc-method').value;
    const ambientTemp = parseFloat(document.getElementById('iec-calc-temp').value) || 30;
    const numCircuits = parseInt(document.getElementById('iec-calc-circuits').value) || 1;
    const groupArrangement = document.getElementById('iec-calc-grouping').value;
    const isBuried = method.startsWith('D');
    const soilRes = isBuried ? parseFloat(document.getElementById('iec-calc-soil').value) : 2.5;
    const depth = isBuried ? parseFloat(document.getElementById('iec-calc-depth').value) : 0.7;

    const key = `${insulation}_${conductor}`;

    // ── Calculate derating factors ──

    // 1. Temperature correction
    const env = isBuried ? 'ground' : 'air';
    const tempData = IEC_TEMP_CORRECTION[env][insulation];
    const tempFactor = this._interpolateFactor(tempData, ambientTemp);

    // 2. Grouping correction
    const groupData = IEC_GROUPING_FACTORS[groupArrangement] || IEC_GROUPING_FACTORS.bunched;
    const groupFactor = this._interpolateFactor(groupData, numCircuits);

    // 3. Soil resistivity correction (buried only)
    const soilFactor = isBuried ? this._interpolateFactor(IEC_SOIL_RESISTIVITY_FACTORS, soilRes) : 1.0;

    // 4. Depth correction (buried only)
    const depthFactor = isBuried ? this._interpolateFactor(IEC_DEPTH_FACTORS, depth) : 1.0;

    // Combined derating
    const totalDerating = tempFactor * groupFactor * soilFactor * depthFactor;

    // Required base ampacity: Iz = Ib / (k1 × k2 × k3 × k4)
    const requiredIz = Ib / totalDerating;

    // ── Find suitable cable size ──
    const results = [];
    let selectedSize = null;
    let selectedIz = null;

    for (const size of IEC_STANDARD_SIZES) {
      const sizeData = IEC_AMPACITY_TABLE[size];
      if (!sizeData || !sizeData[method]) continue;
      const baseAmpacity = sizeData[method][key];
      if (baseAmpacity == null) continue;

      const deratedAmpacity = baseAmpacity * totalDerating;
      const adequate = deratedAmpacity >= Ib;

      results.push({ size, baseAmpacity, deratedAmpacity, adequate });

      if (adequate && !selectedSize) {
        selectedSize = size;
        selectedIz = baseAmpacity;
      }
    }

    // ── Render results ──
    const resultsDiv = document.getElementById('iec-calc-results');
    resultsDiv.style.display = '';

    if (results.length === 0) {
      resultsDiv.innerHTML = `<div class="iec-calc-error">No ampacity data available for method <strong>${method}</strong> with <strong>${insulation.toUpperCase()} ${conductor === 'cu' ? 'Copper' : 'Aluminium'}</strong>. Try a different installation method.</div>`;
      return;
    }

    const factorRows = [
      ['Temperature', `${ambientTemp}°C ${env}`, tempFactor.toFixed(3)],
      ['Grouping', `${numCircuits} circuit(s), ${groupArrangement.replace(/_/g, ' ')}`, groupFactor.toFixed(3)],
    ];
    if (isBuried) {
      factorRows.push(['Soil resistivity', `${soilRes} K·m/W`, soilFactor.toFixed(3)]);
      factorRows.push(['Depth of laying', `${depth} m`, depthFactor.toFixed(3)]);
    }

    let html = `
      <h4>Derating Factors Applied</h4>
      <table class="library-table iec-ref-table iec-compact">
        <thead><tr><th>Factor</th><th>Condition</th><th>Value</th></tr></thead>
        <tbody>
          ${factorRows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num-cell">${r[2]}</td></tr>`).join('')}
          <tr class="iec-total-row"><td><strong>Combined</strong></td><td></td><td class="num-cell"><strong>${totalDerating.toFixed(3)}</strong></td></tr>
        </tbody>
      </table>

      <div class="iec-calc-required">
        Required base ampacity: I<sub>z</sub> = ${Ib} A &divide; ${totalDerating.toFixed(3)} = <strong>${requiredIz.toFixed(1)} A</strong>
      </div>
    `;

    if (selectedSize) {
      html += `
        <div class="iec-calc-recommendation">
          Recommended cable: <strong>${selectedSize} mm&sup2; ${conductor === 'cu' ? 'Copper' : 'Aluminium'} ${insulation.toUpperCase()}</strong><br>
          Base ampacity: ${selectedIz} A &nbsp;|&nbsp; Derated: ${(selectedIz * totalDerating).toFixed(1)} A &nbsp;|&nbsp;
          Margin: ${(((selectedIz * totalDerating) / Ib - 1) * 100).toFixed(1)}%
        </div>
      `;
    } else {
      html += `<div class="iec-calc-error">No standard cable size is adequate for ${Ib} A with these conditions.<br>Consider reducing derating factors, using a different installation method, or running parallel cables.</div>`;
    }

    html += `
      <h4>All Cable Sizes — Method ${method}</h4>
      <table class="library-table iec-ref-table iec-compact">
        <thead><tr><th>Size (mm&sup2;)</th><th>Base I<sub>z</sub> (A)</th><th>Derated I<sub>z</sub> (A)</th><th>Status</th></tr></thead>
        <tbody>
          ${results.map(r => {
            const cls = r.adequate ? (r.size === selectedSize ? 'iec-selected-row' : 'iec-ok-row') : 'iec-fail-row';
            const status = r.adequate ? (r.size === selectedSize ? 'SELECTED' : 'OK') : 'Too small';
            return `<tr class="${cls}">
              <td class="num-cell">${r.size}</td>
              <td class="num-cell">${r.baseAmpacity}</td>
              <td class="num-cell">${r.deratedAmpacity.toFixed(1)}</td>
              <td>${status}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    resultsDiv.innerHTML = html;
  },

  // Linear interpolation/nearest-value lookup for factor tables
  _interpolateFactor(table, value) {
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    if (keys.length === 0) return 1.0;

    // Exact match
    if (table[value] != null) return table[value];

    // Below range
    if (value <= keys[0]) return table[keys[0]];
    // Above range
    if (value >= keys[keys.length - 1]) return table[keys[keys.length - 1]];

    // Interpolate between two nearest points
    let lo = keys[0], hi = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i] <= value && keys[i + 1] >= value) {
        lo = keys[i];
        hi = keys[i + 1];
        break;
      }
    }
    const frac = (value - lo) / (hi - lo);
    return table[lo] + frac * (table[hi] - table[lo]);
  },
};
