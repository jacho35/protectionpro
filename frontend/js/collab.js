/* ProtectionPro — Collab: live co-editing of the open project.
 *
 * Connects to WS /api/projects/{id}/live (backend/routes/collab.py) whenever a saved
 * project is open. The server only relays: every editor keeps the whole project.
 *
 *  - Sending: AppState.dirty is wrapped in an accessor, so any of the ~110 places that
 *    mark the project changed also wake `kick()`. After a short debounce `_diff()`
 *    compares each component / wire / the page list with the last synced copy
 *    (`_base`, key → JSON) and sends the differences as ops {k, id, v} (v null = deleted).
 *  - Receiving: ops replace the entity in place, update `_base` so they are never
 *    echoed back, and redraw. The project is NOT reloaded (that would reset selection,
 *    pan/zoom and results). Study results go stale, so they are cleared.
 *  - Ids: AppState.genId is strided by the server-assigned slot (id ≡ slot mod 16) while
 *    connected, so two editors adding a bus at the same moment never mint the same id.
 *  - Saving: the server announces each save; we adopt its version so editors on the same
 *    live session don't trip each other's save-conflict check (API.saveProject).
 *
 * Not synced yet: project settings, scenarios, groups, plan/retic/lighting data.
 */

const Collab = {
  PAGES_KEY: 'pages',
  DEBOUNCE_MS: 250,
  HEARTBEAT_MS: 25000,

  ws: null,
  projectId: null,       // the project the socket is for
  clientId: null,
  slot: null,
  role: null,
  peers: new Map(),      // client_id → {client_id, user_id, name, color, role}
  _base: new Map(),      // 'c:<id>' | 'w:<id>' | 'pages' → JSON string last synced
  _timer: null,
  _hb: null,
  _retry: 0,
  _retryTimer: null,
  _wasConnected: false,
  _dirty: false,
  _origGenId: null,
  _redrawTimer: null,

  init() {
    // Wrap AppState.dirty so every existing `AppState.dirty = true` also wakes the differ.
    let value = AppState.dirty;
    Object.defineProperty(AppState, 'dirty', {
      configurable: true,
      get() { return value; },
      set(v) { value = v; if (v) Collab.kick(); },
    });
    this._origGenId = AppState.genId;
    // The open project changes through many paths (open, recent list, file manager,
    // first save, Save As): follow AppState.projectId instead of hooking each one.
    setInterval(() => this._follow(), 1000);
    window.addEventListener('beforeunload', () => this._close());
  },

  get live() { return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.clientId); },

  _follow() {
    const want = AppState.projectId ? String(AppState.projectId) : null;
    if (want === this.projectId) return;
    this._close();
    this.projectId = want;
    this._retry = 0;
    if (want && API.getToken()) this._connect();
  },

  _close() {
    clearTimeout(this._retryTimer);
    clearInterval(this._hb);
    clearTimeout(this._timer);
    this._timer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      try { ws.close(); } catch (_) { /* already closed */ }
    }
    this.clientId = null;
    this.slot = null;
    this.peers.clear();
    this._wasConnected = false;
    this._restoreGenId();
    this._renderPeers();
    this.projectId = null;
  },

  _connect() {
    const pid = this.projectId;
    if (!pid) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}${API_BASE}/projects/${pid}/live`); }
    catch (_) { return this._scheduleRetry(); }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: API.getToken() }));
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this._onMessage(msg);
    };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clientId = null;
      clearInterval(this._hb);
      this.peers.clear();
      this._restoreGenId();
      this._renderPeers();
      // 44xx = refused (auth / no access / room full): don't hammer the server.
      if (ev.code >= 4400 && ev.code < 4500) return;
      if (this._wasConnected) UI.toast('Live editing connection lost — reconnecting…', 'warning');
      this._scheduleRetry();
    };
  },

  _scheduleRetry() {
    if (!this.projectId) return;
    const wait = Math.min(15000, 1000 * 2 ** this._retry++);
    this._retryTimer = setTimeout(() => {
      if (this.projectId && !this.ws) this._connect();
    }, wait);
  },

  // ── Receiving ──

  _onMessage(msg) {
    switch (msg.type) {
      case 'welcome': return this._onWelcome(msg);
      case 'peer_join':
        this.peers.set(msg.peer.client_id, msg.peer);
        this._renderPeers();
        UI.toast(`${msg.peer.name} joined this project`, 'info');
        return;
      case 'peer_leave': {
        const p = this.peers.get(msg.client_id);
        this.peers.delete(msg.client_id);
        this._renderPeers();
        if (p) UI.toast(`${p.name} left this project`, 'info');
        return;
      }
      case 'ops': return this._applyOps(msg.ops || [], msg.from);
      case 'saved':
        // Someone saved while we are in the same live session: their file holds the
        // edits we have already received, so move our base version up to it.
        if (Number.isFinite(msg.version)) AppState.projectVersion = Math.max(AppState.projectVersion || 0, msg.version);
        return;
      case 'error':
        if (msg.message === 'view-only') UI.toast('This project is shared view-only.', 'warning');
        return;
      default: return;
    }
  },

  _onWelcome(msg) {
    const reconnect = this._wasConnected;
    this.clientId = msg.client_id;
    this.slot = msg.slot;
    this.role = msg.role;
    this._retry = 0;
    this.peers = new Map((msg.peers || []).map(p => [p.client_id, p]));
    this._installGenId();
    this._hb = setInterval(() => this._send({ type: 'ping' }), this.HEARTBEAT_MS);
    if (!reconnect) {
      this._base = this._snapshot();   // everything open now counts as already shared
    } else if (msg.version > (AppState.projectVersion || 0)) {
      // Saves landed while we were offline, and we missed the live edits that came with them.
      if (!AppState.dirty && typeof Project !== 'undefined') {
        Project.openById(this.projectId).then(() => { this._base = this._snapshot(); });
      } else {
        UI.toast('Reconnected. The project was saved by someone else while you were offline — ' +
                 'save and reload to merge.', 'warning', 6000);
      }
    }
    this._wasConnected = true;
    this._renderPeers();
    if (reconnect) this.kick();   // send whatever changed while offline
  },

  _applyOps(ops, from) {
    if (!ops.length) return;
    const who = this.peers.get(from);
    let touched = false;
    for (const op of ops) {
      if (op.k === 'comp' && typeof op.id === 'string') {
        if (op.v) AppState.components.set(op.id, op.v);
        else { AppState.components.delete(op.id); AppState.selectedIds.delete(op.id); }
        this._base.set('c:' + op.id, op.v ? JSON.stringify(op.v) : undefined);
        touched = true;
      } else if (op.k === 'wire' && typeof op.id === 'string') {
        if (op.v) AppState.wires.set(op.id, op.v);
        else { AppState.wires.delete(op.id); AppState.selectedIds.delete(op.id); }
        this._base.set('w:' + op.id, op.v ? JSON.stringify(op.v) : undefined);
        touched = true;
      } else if (op.k === 'pages' && Array.isArray(op.v)) {
        AppState.pages = op.v;
        if (!AppState.pages.some(p => p.id === AppState.activePageId) && AppState.pages[0]) {
          AppState.activePageId = AppState.pages[0].id;
        }
        this._base.set(this.PAGES_KEY, JSON.stringify(op.v));
        touched = true;
      }
    }
    if (!touched) return;
    if (!AppState.readOnly) AppState.dirty = true;   // the file on the server no longer matches
    if (typeof AppState.invalidateResults === 'function') AppState.invalidateResults();
    // Not while the local user is mid-drag: finish applying once they let go.
    if (AppState.dragState || (typeof Canvas !== 'undefined' && (Canvas.isPanning || Canvas.busResize))) {
      clearTimeout(this._redrawTimer);
      this._redrawTimer = setTimeout(() => this._redraw(), 400);
      return;
    }
    this._redraw();
    if (who) this._flash(who);
  },

  _redraw() {
    if (typeof renderPageTabs === 'function') renderPageTabs();
    Canvas.render();
    const id = typeof Properties !== 'undefined' ? Properties.currentId : null;
    if (id) {
      if (AppState.components.has(id)) Properties.show(id); else Properties.clear();
    }
  },

  _flash(peer) {
    const el = document.getElementById('collab-peers');
    const chip = el && el.querySelector(`[data-client="${peer.client_id}"]`);
    if (!chip) return;
    chip.classList.add('collab-active');
    setTimeout(() => chip.classList.remove('collab-active'), 800);
  },

  // ── Sending ──

  kick() {
    if (!this.live || this.role !== 'edit' || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._diff(); }, this.DEBOUNCE_MS);
  },

  _snapshot() {
    const m = new Map();
    for (const [id, c] of AppState.components) m.set('c:' + id, JSON.stringify(c));
    for (const [id, w] of AppState.wires) m.set('w:' + id, JSON.stringify(w));
    m.set(this.PAGES_KEY, JSON.stringify(AppState.pages));
    return m;
  },

  _diff() {
    if (!this.live || this.role !== 'edit') return;
    const ops = [];
    const seen = new Set();
    const walk = (map, prefix, kind) => {
      for (const [id, ent] of map) {
        const key = prefix + id;
        seen.add(key);
        const s = JSON.stringify(ent);
        if (this._base.get(key) !== s) { this._base.set(key, s); ops.push({ k: kind, id, v: ent }); }
      }
    };
    walk(AppState.components, 'c:', 'comp');
    walk(AppState.wires, 'w:', 'wire');
    for (const key of [...this._base.keys()]) {
      if (key === this.PAGES_KEY || seen.has(key)) continue;
      if (this._base.get(key) === undefined) { this._base.delete(key); continue; }   // already gone
      this._base.set(key, undefined);
      ops.push({ k: key[0] === 'c' ? 'comp' : 'wire', id: key.slice(2), v: null });
    }
    const pages = JSON.stringify(AppState.pages);
    if (this._base.get(this.PAGES_KEY) !== pages) {
      this._base.set(this.PAGES_KEY, pages);
      ops.push({ k: 'pages', v: AppState.pages });
    }
    if (ops.length) this._send({ type: 'ops', ops });
  },

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  },

  // ── Ids ──

  _installGenId() {
    const stride = 16, slot = this.slot;
    AppState.genId = function (prefix) {
      let n = this.nextId;
      n += (slot - (n % stride) + stride) % stride;
      this.nextId = n + stride;
      return `${prefix}_${n}`;
    };
  },

  _restoreGenId() {
    if (this._origGenId) AppState.genId = this._origGenId;
  },

  // ── Presence UI ──

  _renderPeers() {
    let el = document.getElementById('collab-peers');
    if (!el) {
      const anchor = document.getElementById('project-name-display');
      if (!anchor) return;
      el = document.createElement('span');
      el.id = 'collab-peers';
      el.className = 'collab-peers';
      anchor.insertAdjacentElement('afterend', el);
    }
    el.textContent = '';
    if (!this.live) { el.hidden = true; return; }
    el.hidden = false;
    const mk = (p, me) => {
      const chip = document.createElement('span');
      chip.className = 'collab-chip';
      chip.dataset.client = p.client_id || '';
      chip.style.background = p.color || '#4363d8';
      chip.textContent = (p.name || '?').trim().slice(0, 1).toUpperCase();
      chip.title = me ? 'You (live)' : `${p.name} — ${p.role === 'edit' ? 'editing' : 'viewing'}`;
      return chip;
    };
    el.appendChild(mk({ name: 'You', color: '#555', client_id: this.clientId }, true));
    for (const p of this.peers.values()) el.appendChild(mk(p, false));
    el.title = this.peers.size ? `${this.peers.size + 1} people live on this project`
                               : 'Live editing on — nobody else is here';
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => Collab.init());
}
