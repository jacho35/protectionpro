/* ProtectionPro — Standard Data Library Manager & Settings */

const StandardData = {
  // Working copies of libraries (editable by user)
  cables: [],
  transformers: [],
  cbs: [],
  fuses: [],
  loadClasses: [],

  // Libraries belong to the PROJECT (state.js toJSON `libraries`): only the
  // differences from the shipped defaults are saved, so anyone opening the
  // project gets the same libraries. The old localStorage copy is read once as
  // a seed for projects saved before this (no `libraries` field) and never
  // written again.
  _LIBKEYS: ['cables', 'transformers', 'cbs', 'fuses', 'loadClasses'],
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

    // Restore persisted customizations, if any
    this._loadPersisted();
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

  // ─── Library Persistence (localStorage) ───
  _loadPersisted() {
    try {
      const raw = localStorage.getItem(this._STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.cables)) {
        // One cable library: a saved copy keeps the user's edits, and any
        // shipped entry it doesn't have yet (matched by id — e.g. the building
        // wiring and 2-core service cables merged in 2026-09) is appended.
        const have = new Set(data.cables.map(c => c && c.id));
        this.cables = data.cables.concat(this._defaults.cables.filter(c => !have.has(c.id)).map(c => JSON.parse(JSON.stringify(c))));
      }
      if (Array.isArray(data.transformers)) this.transformers = data.transformers;
      if (Array.isArray(data.cbs)) this.cbs = data.cbs;
      if (Array.isArray(data.fuses)) this.fuses = data.fuses;
      if (Array.isArray(data.loadClasses)) this.loadClasses = data.loadClasses;
      // Keep the user's customizations, but if the shipped defaults have been
      // revised since they were saved, let them know they can adopt the update.
      if ((data.version || 1) < this._DATA_VERSION) {
        const msg = 'Component libraries: the shipped defaults have been updated '
          + '(e.g. corrected cable resistances) since your customisations were saved. '
          + 'Use "Reset to Defaults" in Settings to adopt them.';
        setTimeout(() => {
          const el = document.getElementById('status-info');
          if (el) el.textContent = msg;
        }, 1500);
      }
    } catch (e) {
      console.error('Failed to load custom libraries from localStorage:', e);
    }
  },

  // A library was edited: the change is part of the project now, so mark it
  // unsaved (nothing is written to this browser).
  _persist() {
    if (!this._initialized || this._applying) return;
    if (typeof AppState !== 'undefined') AppState.dirty = true;
  },

  // The project's library overrides: per library, the entries that are new or
  // differ from the shipped default (matched by id) and the shipped ids that
  // were deleted. undefined when every library is still the shipped default.
  projectLibraries() {
    if (!this._defaults) return undefined;
    const out = {};
    for (const key of this._LIBKEYS) {
      // Working cables were completed by CableLib.normalize (construction, cores);
      // complete the shipped ones the same way before comparing.
      const norm = e => (key === 'cables' && typeof CableLib !== 'undefined') ? CableLib.normalize(JSON.parse(JSON.stringify(e))) : e;
      const def = new Map(this._defaults[key].map(e => [e.id, JSON.stringify(norm(e))]));
      const have = new Set();
      const set = [];
      for (const e of this[key]) {
        have.add(e.id);
        if (def.get(e.id) !== JSON.stringify(e)) set.push(JSON.parse(JSON.stringify(e)));
      }
      const removed = [...def.keys()].filter(id => !have.has(id));
      if (set.length || removed.length) out[key] = { set, removed };
    }
    return Object.keys(out).length ? out : undefined;
  },

  // Make the working libraries what the project says: shipped defaults with the
  // project's overrides on top. A project without `libraries` (saved before they
  // travelled with it) gets the defaults plus this browser's old localStorage
  // copy, read-only, so nothing it relied on disappears.
  applyProjectLibraries(libs) {
    if (!this._defaults) return;
    this._applying = true;
    try {
      for (const key of this._LIBKEYS) this[key] = JSON.parse(JSON.stringify(this._defaults[key]));
      if (libs && typeof libs === 'object') {
        for (const key of this._LIBKEYS) {
          const o = libs[key];
          if (!o) continue;
          const removed = new Set(Array.isArray(o.removed) ? o.removed : []);
          const set = new Map((Array.isArray(o.set) ? o.set : []).filter(e => e && e.id).map(e => [e.id, e]));
          const next = this[key].filter(e => !removed.has(e.id)).map(e => set.has(e.id) ? JSON.parse(JSON.stringify(set.get(e.id))) : e);
          const have = new Set(next.map(e => e.id));
          for (const [id, e] of set) if (!have.has(id) && !removed.has(id)) next.push(JSON.parse(JSON.stringify(e)));
          this[key] = next;
        }
      } else {
        this._loadPersisted();
      }
      this.syncCableLibrary();
      this.syncTransformerLibrary();
      this.syncCBLibrary();
      this.syncFuseLibrary();
      this.syncLoadClassLibrary();
      // Settings tables show the new content next time they are drawn; redraw
      // now if they already exist.
      for (const [bodyId, cfg] of Object.entries(this._LIB)) {
        if (document.getElementById(bodyId)) this[cfg.render]();
      }
    } finally { this._applying = false; }
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
      if (!(await UI.confirm('Reset the cable library to defaults?\nAll your custom cables and edits will be permanently discarded.', { danger: true }))) return;
      this.cables = JSON.parse(JSON.stringify(this._defaults.cables));
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
      if (!(await UI.confirm('Reset the load-class library to defaults?\nAll your custom classes and edits will be permanently discarded.', { danger: true }))) return;
      this.loadClasses = JSON.parse(JSON.stringify(this._defaults.loadClasses));
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
      if (!(await UI.confirm('Reset the transformer library to defaults?\nAll your custom transformers and edits will be permanently discarded.', { danger: true }))) return;
      this.transformers = JSON.parse(JSON.stringify(this._defaults.transformers));
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
      if (!(await UI.confirm('Reset the circuit breaker library to defaults?\nAll your custom breakers and edits will be permanently discarded.', { danger: true }))) return;
      this.cbs = JSON.parse(JSON.stringify(this._defaults.cbs));
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
      if (!(await UI.confirm('Reset the fuse library to defaults?\nAll your custom fuses and edits will be permanently discarded.', { danger: true }))) return;
      this.fuses = JSON.parse(JSON.stringify(this._defaults.fuses));
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
