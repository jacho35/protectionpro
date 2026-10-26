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
 * - Reconnect: the server keeps the last 500 edit batches; we send the last `seq` we saw and
 *   it replays what we missed (our own edits are skipped via `session`), or says `resync`
 *   when it can't — then a clean copy is reloaded, a dirty one is told to save and reload.
 * - Selection: each editor's selection is relayed as presence and outlined in their colour;
 *   picking something a colleague has selected shows a heads-up (a soft lock — never blocks).
 * - Project-level data (settings, project details, scenarios, groups, earth grids) travels as
 *   whole-value `misc` ops, last writer wins per key.
 *
 * - Per-element data (collab-data.js lists the collections): Demand minisubs / kiosks,
 *   street-lighting circuits, road designs, the road plan and its scene. Each entity is
 *   compared by id and sent alone (`ent` ops, `order` when a list is re-sequenced, `val`
 *   for whole values such as settings); remote changes are spliced into the live arrays
 *   in place and only the visible screen is redrawn, after the user stops typing.
 *
 * Not synced yet: the plan-markup workspace (floors, elements, routes, rooms, …).
 */

const Collab = {
  PAGES_KEY: 'pages',
  // Project-level values synced whole (key → AppState field of the same name; groups are Maps).
  MISC_KEYS: ['projectDetails', 'baseMVA', 'frequency', 'voltageFactor', 'defaultLengthUnit',
              'voltageDisplayUnit', 'symbolSet', 'wireRouteMode', 'earthGrids', 'scenarios', 'groups'],
  DEBOUNCE_MS: 250,
  HEARTBEAT_MS: 25000,

  ws: null,
  projectId: null,       // the project the socket is for
  clientId: null,
  slot: null,
  role: null,
  peers: new Map(),      // client_id → {client_id, user_id, name, color, role}
  _base: new Map(),      // 'c:<id>' | 'w:<id>' | 'pages' → JSON string last synced
  _cb: new Map(),        // collection key → {ents: Map(id → JSON), order, val} last synced
  _strCache: new WeakMap(),   // immutable entity → its JSON
  _pendingGroups: new Set(),
  _refreshTimer: null,
  _timer: null,
  _hb: null,
  _retry: 0,
  _retryTimer: null,
  _wasConnected: false,
  _origGenId: null,
  _redrawTimer: null,
  _session: Math.random().toString(36).slice(2) + Date.now().toString(36),  // survives reconnects
  _seq: 0,               // last server op-batch number seen
  _remoteSel: new Map(), // client_id → [ids that person has selected]
  _lastSel: '',
  _warned: new Map(),    // id → time of the last "also working on" heads-up

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
    setInterval(() => this._selTick(), 300);
    // Remote selection outlines live on the rendered SVG, so repaint them after each render.
    const render = Canvas.render;
    Canvas.render = function () { const r = render.apply(this, arguments); Collab._paintRemote(); return r; };
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
    this._remoteSel.clear();
    this._wasConnected = false;
    this._seq = 0;
    this._lastSel = '';
    this._restoreGenId();
    this._renderPeers();
    this._paintRemote();
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
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'hello', token: API.getToken(), session: this._session,
      since: this._wasConnected ? this._seq : undefined,   // a reconnect asks for what it missed
    }));
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
      this._remoteSel.clear();
      this._restoreGenId();
      this._renderPeers();
      this._paintRemote();
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
        this._sendSel(true);   // show them what we have selected
        return;
      case 'peer_leave': {
        const p = this.peers.get(msg.client_id);
        this.peers.delete(msg.client_id);
        this._remoteSel.delete(msg.client_id);
        this._renderPeers();
        this._paintRemote();
        if (p) UI.toast(`${p.name} left this project`, 'info');
        return;
      }
      case 'ops':
        if (Number.isFinite(msg.seq)) this._seq = Math.max(this._seq, msg.seq);
        return this._applyOps(msg.ops || [], msg.from);
      case 'replay':
        for (const b of msg.batches || []) {
          if (Number.isFinite(b.seq)) this._seq = Math.max(this._seq, b.seq);
          this._applyOps(b.ops || [], b.from);
        }
        return;
      case 'presence':
        if (Array.isArray(msg.sel)) {
          this._remoteSel.set(msg.from, msg.sel.filter(x => typeof x === 'string').slice(0, 300));
          this._paintRemote();
        }
        return;
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
    this._seq = msg.seq || 0;   // a replay (if any) follows and covers up to here
    if (!reconnect) {
      this._resetBase();   // everything open now counts as already shared
    } else if (msg.resync) {
      // The server can't say what we missed (restarted, or too long offline).
      if (!AppState.dirty && typeof Project !== 'undefined') {
        Project.openById(this.projectId).then(() => this._resetBase());
      } else {
        UI.toast('Reconnected, but edits made by others while you were offline could not be ' +
                 'replayed. Save your work and reload the project to merge.', 'warning', 8000);
      }
    }
    this._wasConnected = true;
    this._renderPeers();
    this._lastSel = '';           // let _selTick announce our selection
    if (reconnect) this.kick();   // send whatever changed while offline
  },

  _applyOps(ops, from) {
    if (!ops.length) return;
    const who = this.peers.get(from);
    let touched = false;
    const groups = new Set();
    let descs = null;
    for (const op of ops) {
      if (op.k === 'ent' || op.k === 'order' || op.k === 'val') {
        descs = descs || new Map(CollabData.collections().map(d => [d.key, d]));
        const d = descs.get(op.c);
        if (d && this._cApply(d, op)) {
          groups.add(d.group);
          if (d.structural) descs = null;   // new floors bring new collections
        }
        continue;
      }
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
      } else if (op.k === 'misc' && this.MISC_KEYS.includes(op.key) && this._setMisc(op.key, op.v)) {
        this._base.set('m:' + op.key, JSON.stringify(op.v));
        touched = true;
      }
    }
    if (!touched && !groups.size) return;
    if (!AppState.readOnly) AppState.dirty = true;   // the file on the server no longer matches
    if (typeof AppState.invalidateResults === 'function') AppState.invalidateResults();
    if (groups.size) { CollabData.afterApply(groups); this._refreshData(groups); }
    if (!touched) return;
    // Not while the local user is mid-drag: finish applying once they let go.
    if (AppState.dragState || (typeof Canvas !== 'undefined' && (Canvas.isPanning || Canvas.busResize))) {
      clearTimeout(this._redrawTimer);
      this._redrawTimer = setTimeout(() => this._redraw(), 400);
      return;
    }
    this._redraw();
    if (who) this._flash(who);
  },

  // ── Per-element collections (descriptors in collab-data.js) ──

  _cstate(key) {
    let st = this._cb.get(key);
    if (!st) this._cb.set(key, st = { ents: new Map(), order: '', val: undefined });
    return st;
  },

  _ser(d, e) {
    if (e && typeof e === 'object' && d.exclude) e = this._strip(d, e);
    if (!d.immutable || !e || typeof e !== 'object') return JSON.stringify(e);
    let str = this._strCache.get(e);
    if (str === undefined) this._strCache.set(e, str = JSON.stringify(e));
    return str;
  },

  // The entity as synced: without the keys that have collections of their own.
  _strip(d, e) {
    const out = {};
    for (const k of Object.keys(e)) if (!d.exclude.includes(k)) out[k] = e[k];
    return out;
  },

  _cGet(d) { try { return d.get(); } catch (_) { return undefined; } },

  // [id, entity] pairs of a list / map collection
  _cEntries(d) {
    const col = this._cGet(d);
    if (d.kind === 'list') return Array.isArray(col) ? col.filter(e => e && typeof e.id === 'string').map(e => [e.id, e]) : [];
    return col && typeof col === 'object' ? Object.entries(col) : [];
  },

  _resetBase() {
    this._base = this._snapshot();
    this._cb = new Map();
    for (const d of CollabData.collections()) {
      const st = this._cstate(d.key);
      if (d.kind === 'value') { st.val = this._ser(d, this._cGet(d)); continue; }
      const ents = this._cEntries(d);
      for (const [id, e] of ents) st.ents.set(id, this._ser(d, e));
      st.order = d.kind === 'list' ? ents.map(x => x[0]).join('|') : '';
    }
  },

  _cDiff(ops) {
    for (const d of CollabData.collections()) {
      const st = this._cstate(d.key);
      if (d.kind === 'value') {
        const v = this._cGet(d), str = this._ser(d, v);
        if (str !== st.val) { st.val = str; ops.push({ k: 'val', c: d.key, v: v === undefined ? null : v }); }
        continue;
      }
      const ents = this._cEntries(d), seen = new Set();
      for (const [id, e] of ents) {
        seen.add(id);
        const str = this._ser(d, e);
        if (st.ents.get(id) !== str) {
          st.ents.set(id, str);
          ops.push({ k: 'ent', c: d.key, id, v: d.exclude ? this._strip(d, e) : e });
        }
      }
      const prev = st.order ? st.order.split('|') : [];
      for (const id of [...st.ents.keys()]) {
        if (!seen.has(id)) { st.ents.delete(id); ops.push({ k: 'ent', c: d.key, id, v: null }); }
      }
      if (d.kind === 'list') {
        const ids = ents.map(x => x[0]);
        // What a peer ends up with from the ent ops alone: kept ids in old order, new ones appended.
        const had = new Set(prev);
        const expected = prev.filter(id => seen.has(id)).concat(ids.filter(id => !had.has(id)));
        if (expected.join('|') !== ids.join('|')) ops.push({ k: 'order', c: d.key, ids });
        st.order = ids.join('|');
      }
    }
  },

  // Apply one received collection op in place; true when something changed.
  _cApply(d, op) {
    const st = this._cstate(d.key);
    const okId = id => typeof id === 'string' && id.length < 128 && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
    if (op.k === 'val') {
      if (!d.set) return false;
      d.set(op.v === undefined ? null : op.v);
      st.val = this._ser(d, this._cGet(d));
      return true;
    }
    let col = this._cGet(d);
    if (!col && d.ensure) col = d.ensure();
    if (!col || d.kind === 'value') return false;
    if (op.k === 'order') {
      if (d.kind !== 'list' || !Array.isArray(op.ids)) return false;
      const byId = new Map(col.map(e => [e.id, e]));
      const next = op.ids.map(id => byId.get(id)).filter(Boolean);
      const used = new Set(next);
      for (const e of col) if (!used.has(e)) next.push(e);
      col.splice(0, col.length, ...next);
      st.order = col.map(e => e.id).join('|');
      return true;
    }
    if (!okId(op.id)) return false;
    if (d.kind === 'list') {
      const i = col.findIndex(e => e && e.id === op.id);
      if (op.v) {
        if (typeof op.v !== 'object' || op.v.id !== op.id) return false;
        if (d.exclude) {
          // keep the excluded keys (a floor's drawing) of the entity we already have
          if (i >= 0) {
            for (const k of Object.keys(col[i])) if (!d.exclude.includes(k)) delete col[i][k];
            Object.assign(col[i], op.v);
          } else col.push(Object.assign({}, d.fresh ? d.fresh(op.v) : {}, op.v));
        } else if (i >= 0) col.splice(i, 1, op.v); else col.push(op.v);
        st.ents.set(op.id, this._ser(d, op.v));
      } else {
        if (i >= 0) col.splice(i, 1);
        st.ents.delete(op.id);
      }
      st.order = col.map(e => e && e.id).join('|');
    } else {
      if (op.v) { col[op.id] = op.v; st.ents.set(op.id, this._ser(d, op.v)); }
      else { delete col[op.id]; st.ents.delete(op.id); }
    }
    return true;
  },

  // Redraw the workspaces a remote change touched, not while someone is typing in one.
  _refreshData(groups) {
    for (const g of groups) this._pendingGroups.add(g);
    const busy = () => {
      const a = document.activeElement;
      return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) &&
        a.closest('#retic-workspace, #streetlight-workspace, #plan-workspace, #lighting-workspace');
    };
    const attempt = n => {
      if (busy() && n < 40) { this._refreshTimer = setTimeout(() => attempt(n + 1), 500); return; }
      const gs = this._pendingGroups;
      this._pendingGroups = new Set();
      CollabData.refresh(gs);
    };
    clearTimeout(this._refreshTimer);
    attempt(0);
  },

  // Apply a received project-level value; false when it fails validation.
  _setMisc(key, v) {
    const num = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
    const obj = x => x && typeof x === 'object' && !Array.isArray(x);
    switch (key) {
      case 'baseMVA': case 'frequency': case 'voltageFactor':
        if (!num(v)) return false; AppState[key] = v; return true;
      case 'defaultLengthUnit': case 'wireRouteMode':
        if (typeof v !== 'string') return false; AppState[key] = v; return true;
      case 'voltageDisplayUnit':
        if (v !== 'V' && v !== 'kV') return false; AppState[key] = v; return true;
      case 'symbolSet':
        if (v !== 'iec' && v !== 'classic') return false;
        AppState.symbolSet = v;
        if (typeof Sidebar !== 'undefined') Sidebar.syncSymbolSet();
        return true;
      case 'projectDetails':
        if (!obj(v)) return false; AppState.projectDetails = v; return true;
      case 'earthGrids':
        if (!Array.isArray(v)) return false; AppState.earthGrids = v; return true;
      case 'scenarios':
        if (!Array.isArray(v)) return false;
        AppState.scenarios = v;
        AppState._scenarioNextId = v.length
          ? Math.max(...v.map(x => parseInt(String(x.id).replace('scenario_', '')) || 0)) + 1 : 1;
        return true;
      case 'groups':
        if (!Array.isArray(v)) return false;
        AppState.groups.clear();
        for (const g of v) if (g && g.id) AppState.groups.set(g.id, { ...g, memberIds: new Set(g.memberIds || []) });
        AppState._groupNextId = v.length
          ? Math.max(...v.map(g => parseInt(String(g.id).replace('group_', '')) || 0)) + 1 : 1;
        return true;
      default: return false;
    }
  },

  _miscValue(key) {
    return key === 'groups'
      ? [...AppState.groups.values()].map(g => ({ ...g, memberIds: [...g.memberIds] }))
      : AppState[key];
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
    for (const k of this.MISC_KEYS) m.set('m:' + k, JSON.stringify(this._miscValue(k)));
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
      if (key === this.PAGES_KEY || key.startsWith('m:') || seen.has(key)) continue;
      if (this._base.get(key) === undefined) { this._base.delete(key); continue; }   // already gone
      this._base.set(key, undefined);
      ops.push({ k: key[0] === 'c' ? 'comp' : 'wire', id: key.slice(2), v: null });
    }
    const pages = JSON.stringify(AppState.pages);
    if (this._base.get(this.PAGES_KEY) !== pages) {
      this._base.set(this.PAGES_KEY, pages);
      ops.push({ k: 'pages', v: AppState.pages });
    }
    if (!AppState.dragState) {   // whole-value compares can be large; not while dragging
      for (const k of this.MISC_KEYS) {
        const v = this._miscValue(k), str = JSON.stringify(v);
        if (this._base.get('m:' + k) !== str) { this._base.set('m:' + k, str); ops.push({ k: 'misc', key: k, v }); }
      }
    }
    CollabData.installCounters(this.slot);   // a load / undo may have replaced the holders
    this._cDiff(ops);
    this._sendOps(ops);
  },

  // Keep each message well under the server's size limit.
  _sendOps(ops) {
    let batch = [], size = 0;
    for (const op of ops) {
      const n = JSON.stringify(op).length;
      if (batch.length && size + n > 400000) { this._send({ type: 'ops', ops: batch }); batch = []; size = 0; }
      batch.push(op); size += n;
    }
    if (batch.length) this._send({ type: 'ops', ops: batch });
  },

  // ── Selection presence ──

  _selIds() { return [...AppState.selectedIds].sort(); },

  _selTick() {
    if (!this.live) return;
    const ids = this._selIds(), key = ids.join(',');
    if (key === this._lastSel) return;
    const prev = new Set(this._lastSel ? this._lastSel.split(',') : []);
    this._lastSel = key;
    this._sendSel();
    // Soft lock: say so when you pick something a colleague already has selected.
    const now = Date.now();
    for (const id of ids) {
      if (prev.has(id) || ids.length > 3) continue;
      for (const [cid, sel] of this._remoteSel) {
        const peer = this.peers.get(cid);
        if (!peer || !sel.includes(id) || now - (this._warned.get(id) || 0) < 10000) continue;
        this._warned.set(id, now);
        const comp = AppState.components.get(id);
        UI.toast(`${peer.name} also has ${comp && comp.props && comp.props.name || id} selected`, 'warning');
      }
    }
  },

  _sendSel(force) {
    if (!this.live) return;
    if (force && !this._lastSel) return;   // nothing selected: nothing to announce
    this._send({ type: 'presence', sel: this._selIds() });
  },

  // Outline what each colleague has selected, in their colour.
  _paintRemote() {
    for (const el of document.querySelectorAll('[data-collab-sel]')) {
      el.style.filter = '';
      el.removeAttribute('data-collab-sel');
    }
    if (!this._remoteSel.size) return;
    const colour = new Map();
    for (const [cid, sel] of this._remoteSel) {
      const peer = this.peers.get(cid);
      if (peer) for (const id of sel) if (!colour.has(id)) colour.set(id, peer.color);
    }
    if (!colour.size) return;
    for (const el of document.querySelectorAll('#sld-canvas [data-id]')) {
      const c = colour.get(el.getAttribute('data-id'));
      if (!c) continue;
      el.style.filter = `drop-shadow(0 0 3px ${c}) drop-shadow(0 0 2px ${c})`;
      el.setAttribute('data-collab-sel', '1');
    }
  },

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  },

  // ── Ids ──

  _installGenId() {
    const stride = 16, slot = this.slot;
    CollabData.installCounters(slot);
    AppState.genId = function (prefix) {
      let n = this.nextId;
      n += (slot - (n % stride) + stride) % stride;
      this.nextId = n + stride;
      return `${prefix}_${n}`;
    };
  },

  _restoreGenId() {
    CollabData.removeCounters();
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
