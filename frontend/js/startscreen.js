/* ProtectionPro — the start screen (Project › New, and the first sign-in).
 *
 * Pick the project type first; then start blank (the tabs it gives, or for
 * Lighting what you are lighting) or open that type's sample. On the right:
 * the last five projects on the server and Open project…, plus "When I sign
 * in, open my last project" (localStorage `pp-open-last`, on unless turned off).
 *
 * Samples (frontend/samples/*.json) are built in the real app by
 * testing/samples/build_samples.mjs and saved without results: a sample opens
 * unsaved, calculates with the current engines (Calculate all; the network
 * sample runs its studies) and lands on its Overview. Save makes the user's
 * own copy; the shipped file never changes.
 *
 * Sign-in (`onSignIn`, from auth.js, once per page load, only while the empty
 * start-up project is showing): no projects yet → the start screen with a
 * welcome; otherwise the last project opens, or the start screen when that
 * setting is off.
 */

const StartScreen = {
  PREF_OPEN_LAST: 'pp-open-last',
  PREF_TYPE: 'pp-start-type',
  RECENT_N: 5,

  // One sample per project type. `calc`: what runs once it is open.
  SAMPLES: {
    retic: {
      file: 'retic.json', name: 'Riverside Ext 4', calc: 'overview',
      what: 'A calibrated site plan: 2 minisubs, 8 kiosks and 160 erven, 2 street-light circuits of 12 poles, the minisubs on the single line and a priced bill of quantities.',
      find: 'One transformer is overloaded.',
    },
    building: {
      file: 'building.json', name: 'Harbour Office Block', calc: 'overview',
      what: 'Two floors with 11 rooms lit to their task, 3 boards fed up a riser from an 11 kV supply, every light and socket on a board way, and a priced bill of quantities.',
      find: 'One socket circuit fails its check.',
    },
    network: {
      file: 'network.json', name: 'Kestrel 33/11 kV Substation', calc: 'studies',
      studies: ['faultResults', 'loadFlowResults', 'dutyCheckResults'],
      what: 'A 33 kV grid supply, two 10 MVA 33/11 kV transformers and four 11 kV feeders.',
      find: 'Short circuit, load flow and the duty check run when it opens.',
    },
    lighting: {
      file: 'lighting.json', name: 'Office floor and access road', calc: 'overview',
      what: 'Four office rooms lit by the auto layout, and an access road with a bend: its cross-section design and the road on the road plan.',
      find: 'The road misses its lighting class.',
    },
  },

  _el: null,
  _type: null,
  _signedIn: false,

  // ── Settings ──────────────────────────────────────────────────────
  openLastOn() {
    try { return localStorage.getItem(this.PREF_OPEN_LAST) !== '0'; } catch (_) { return true; }
  },
  setOpenLast(on) {
    try { localStorage.setItem(this.PREF_OPEN_LAST, on ? '1' : '0'); } catch (_) { /* private window */ }
  },
  _lastType() {
    let t = null;
    try { t = localStorage.getItem(this.PREF_TYPE); } catch (_) { /* none */ }
    return Workspaces.TYPES[t] ? t : 'building';
  },

  // ── What sign-in does (pure: node-testable) ───────────────────────
  // projects: the server list (newest first); recent: Project._recentProjects.
  // → { action: 'welcome' | 'open' | 'screen', id? }
  signInAction(projects, recent, openLast) {
    const list = Array.isArray(projects) ? projects : [];
    if (!list.length) return { action: 'welcome' };
    if (!openLast) return { action: 'screen' };
    const ids = new Set(list.map(p => String(p.id)));
    const last = (recent || []).find(r => ids.has(String(r.id)));
    return { action: 'open', id: String(last ? last.id : list[0].id) };
  },
  // The right column's projects: the user's last opened first, then by date.
  recentList(projects, recent, n = this.RECENT_N) {
    const list = Array.isArray(projects) ? projects.slice() : [];
    const rank = new Map((recent || []).map((r, i) => [String(r.id), i]));
    list.sort((a, b) => {
      const ra = rank.has(String(a.id)) ? rank.get(String(a.id)) : Infinity;
      const rb = rank.has(String(b.id)) ? rank.get(String(b.id)) : Infinity;
      if (ra !== rb) return ra - rb;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    return list.slice(0, n);
  },
  when(iso, now = Date.now()) {
    const t = Date.parse(iso && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso + 'Z' : iso);
    if (!isFinite(t)) return '';
    const min = Math.round((now - t) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  },

  // ── Sign-in ───────────────────────────────────────────────────────
  // Only while the empty start-up project is showing: never over work the
  // user already has (a restored backup, a project opened from a link).
  _startupEmpty() {
    let backup = false;
    try { backup = !!localStorage.getItem('protectionpro-auto-save-backup'); } catch (_) { /* none */ }
    return !backup && !AppState.projectId && !AppState.dirty && AppState.components.size === 0;
  },
  // `settled` turns true once sign-in has done what it does (scripts that
  // drive the app headlessly wait for it, then close the screen).
  settled: false,
  async onSignIn() {
    if (this._signedIn) return;
    this._signedIn = true;
    try { await this._signIn(); } finally { this.settled = true; }
  },
  async _signIn() {
    if (!this._startupEmpty()) return;
    let projects = [];
    try { projects = await API.listProjects(); } catch (_) { projects = []; }
    if (!this._startupEmpty()) return;
    const next = this.signInAction(projects, Project._recentProjects, this.openLastOn());
    if (next.action === 'open') {
      if (await Project.openById(next.id)) return;
      return this.open({ projects });
    }
    this.open({ welcome: next.action === 'welcome', projects });
  },

  // ── The screen ────────────────────────────────────────────────────
  isOpen() { return !!(this._el && this._el.isConnected); },

  open(opts = {}) {
    this.close();
    this._type = this._lastType();
    this._prevFocus = document.activeElement;
    const el = document.createElement('div');
    el.id = 'start-screen';
    el.className = 'ss-overlay';
    el.innerHTML = `<div class="ss-panel" role="dialog" aria-modal="true" aria-labelledby="ss-title">
      <div class="ss-head">
        <div class="ss-head-text">
          <h2 id="ss-title">${opts.welcome ? 'Welcome to ProtectionPro' : 'Start a project'}</h2>
          <p class="ss-lead">${opts.welcome
            ? 'Pick what you are designing. Start blank, or open a sample to see a finished project calculated.'
            : 'What are you designing? The type decides which tabs the project shows.'}</p>
        </div>
        <button type="button" class="ss-close" data-ss="close" aria-label="Close" title="Close (Esc)">×</button>
      </div>
      <div class="ss-body">
        <div class="ss-main">
          ${Workspaces._typeCardsHtml(this._type)}
          <div class="ss-paths" data-ss-paths></div>
        </div>
        <aside class="ss-side">
          <h3>Recent projects</h3>
          <div class="ss-recent" data-ss-recent><p class="ss-muted">Loading…</p></div>
          <button type="button" class="btn-small ss-openbtn" data-ss="open">Open project…</button>
          <label class="ss-pref"><input type="checkbox" data-ss-pref${this.openLastOn() ? ' checked' : ''}>
            <span>When I sign in, open my last project</span></label>
        </aside>
      </div>
    </div>`;
    document.body.appendChild(el);
    this._el = el;
    this._renderPaths();
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-ss-pref]')) this.setOpenLast(e.target.checked);
    });
    el.addEventListener('mousedown', (e) => { if (e.target === el) this.close(); });
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.isOpen()) { e.preventDefault(); e.stopPropagation(); this.close(); }
    };
    document.addEventListener('keydown', this._onKey, true);
    setTimeout(() => { const c = el.querySelector('[data-ws-type][aria-pressed="true"]'); if (c) c.focus(); }, 0);
    this._loadRecent(opts.projects);
  },

  close() {
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    this._onKey = null;
    if (this._el) this._el.remove();
    this._el = null;
    if (this._prevFocus && this._prevFocus.isConnected && this._prevFocus.focus) { try { this._prevFocus.focus(); } catch (_) { /* gone */ } }
    this._prevFocus = null;
  },

  _renderPaths() {
    const box = this._el && this._el.querySelector('[data-ss-paths]');
    if (!box) return;
    const type = this._type;
    const s = this.SAMPLES[type];
    const blank = type === 'lighting'
      ? Workspaces._lightingHtml(Object.keys(Workspaces.KINDS), false, { electrical: true })
      : `<div class="ws-tabs-preview"><span class="ws-dialog-hint">Your tabs</span> ${Workspaces.core(type).map((ws, i) =>
          `<span class="ws-tab-chip">${type === 'network' ? '' : (i + 1) + ' '}${escHtml(Workspaces._coreLabel(type, ws))}</span>`).join('')}</div>`;
    box.innerHTML = `<section class="ss-path">
        <h3>Start blank</h3>
        ${blank}
        <div class="ss-path-acts"><button type="button" class="btn-primary" data-ss="blank" data-ws-ok>Create blank project</button></div>
      </section>
      <section class="ss-path ss-sample">
        <h3>Open the sample</h3>
        <div class="ss-sample-name">${escHtml(s.name)}</div>
        <p class="ss-sample-what">${escHtml(s.what)}</p>
        <p class="ss-sample-find">${escHtml(s.find)}</p>
        <p class="ss-muted">Opens unsaved and calculates. Save keeps your own copy.</p>
        <div class="ss-path-acts"><button type="button" class="btn-small" data-ss="sample">Open the sample</button></div>
      </section>`;
    if (type === 'lighting') Workspaces._bindLighting(box);
  },

  async _loadRecent(projects) {
    let list = projects;
    if (!Array.isArray(list)) {
      try { list = await API.listProjects(); } catch (_) { list = null; }
    }
    const box = this._el && this._el.querySelector('[data-ss-recent]');
    if (!box) return;
    if (!Array.isArray(list)) { box.innerHTML = '<p class="ss-muted">Could not reach the server.</p>'; return; }
    const rows = this.recentList(list, Project._recentProjects);
    if (!rows.length) { box.innerHTML = '<p class="ss-muted">No saved projects yet.</p>'; return; }
    box.innerHTML = rows.map(p => {
      const sub = [this.when(p.updated_at), p.access && p.access !== 'owner' ? `shared by ${p.owner_name || p.owner_email || 'someone'}` : '']
        .filter(Boolean).join(' · ');
      return `<button type="button" class="ss-recent-row" data-ss="recent" data-id="${escHtml(String(p.id))}">
        <span class="ss-recent-name">${escHtml(p.name || 'Untitled')}</span>
        <span class="ss-recent-sub">${escHtml(sub)}</span></button>`;
    }).join('');
  },

  _onClick(e) {
    const card = e.target.closest('[data-ws-type]');
    if (card && this._el.contains(card)) {
      this._type = card.dataset.wsType;
      this._el.querySelectorAll('[data-ws-type]').forEach(c => c.setAttribute('aria-pressed', String(c === card)));
      try { localStorage.setItem(this.PREF_TYPE, this._type); } catch (_) { /* private window */ }
      this._renderPaths();
      return;
    }
    const b = e.target.closest('[data-ss]');
    if (!b || b.disabled) return;
    const act = b.dataset.ss;
    if (act === 'close') this.close();
    else if (act === 'blank') this._blank();
    else if (act === 'sample') this.openSample(this._type);
    else if (act === 'open') { this.close(); Project.openProject(); }
    else if (act === 'recent') { const id = b.dataset.id; this.close(); Project.openById(id); }
  },

  async _blank() {
    const choice = Workspaces.readChoice(this._el.querySelector('.ss-main'));
    if (!(await Project._confirmDiscardUnsaved())) return;
    this.close();
    Project.createBlank(choice);
  },

  // ── Samples ───────────────────────────────────────────────────────
  async openSample(type) {
    const s = this.SAMPLES[type];
    if (!s) return false;
    if (!(await Project._confirmDiscardUnsaved())) return false;
    this.close();
    // One busy hold for the whole open (UI.setBusy counts its holds).
    if (UI.setBusy) UI.setBusy(true, 'Opening the sample…');
    let failed = null;
    try {
      const v = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '';
      const res = await fetch(`samples/${s.file}?v=${encodeURIComponent(v)}`);
      if (!res.ok) throw new Error(`the sample file did not load (${res.status})`);
      Project.openData(await res.json());
      await this._calc(s);
    } catch (e) {
      failed = e;
    } finally {
      if (UI.setBusy) UI.setBusy(false);
    }
    if (failed) { UI.alert('Could not open the sample: ' + (failed.message || failed)); return false; }
    // Calculating is not an edit: the sample stays clean until the user changes it.
    await new Promise(r => setTimeout(r, (typeof Sync !== 'undefined' ? Sync.DEBOUNCE_MS : 300) + 100));
    AppState.dirty = false;
    if (typeof Issues !== 'undefined') Issues.refresh();
    UI.toast(`${s.name} — a sample. It is not saved: Save keeps your own copy.`, 'info', 6000);
    return true;
  },

  async _calc(s) {
    const ov = Workspaces.type() === 'lighting' ? 'lightov' : 'overview';
    if (typeof window.switchWorkspace === 'function') window.switchWorkspace(ov);
    if (s.calc === 'studies') {
      for (const slot of s.studies) {
        try { await StaleResults.RUNNERS[slot]({}); } catch (e) { console.warn('Sample study failed', slot, e); }
      }
    } else if (ov === 'lightov') {
      if (typeof LightOverview !== 'undefined') await LightOverview.calcAll();
    } else if (typeof Overview !== 'undefined') {
      await Overview.calcAll();
    }
    if (typeof Overview !== 'undefined' && Overview.refresh) Overview.refresh();
    if (typeof LightOverview !== 'undefined' && LightOverview.refresh) LightOverview.refresh();
  },
};

if (typeof window !== 'undefined') window.StartScreen = StartScreen;
if (typeof module !== 'undefined' && module.exports) module.exports = StartScreen;
