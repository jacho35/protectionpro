/* ProtectionPro — Notifications center
 *
 * A bell in the app bar with an unread badge, and a side panel listing what
 * changed: libraries (entries, the company standard, library sharing) and
 * projects (shared with you, access changed, edits on shared projects).
 * The server writes the notifications (backend/notifications.py); this module
 * polls the unread count, lists them, marks them read and follows their link.
 * Auth._applyAuthedState() calls Notifications.start() once a user is signed in.
 */

const Notifications = {
  POLL_MS: 45000,
  PAGE: 30,
  TABS: [
    { id: '', label: 'All' },
    { id: 'libraries', label: 'Libraries' },
    { id: 'projects', label: 'Projects' },
    { id: 'approvals', label: 'Approvals' },
  ],
  CATEGORY_LABEL: { libraries: 'Library', projects: 'Project', approvals: 'Approval' },

  _started: false,
  _open: false,
  _tab: '',
  _items: [],
  _hasMore: false,
  _unread: { total: 0, by_category: {} },
  _timer: null,
  _seeded: false,   // first count fetched — only later increases raise a toast

  start() {
    if (this._started) return;
    this._started = true;
    this._build();
    document.getElementById('btn-notifications')?.addEventListener('click', () => this.toggle());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refreshCount(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this._open) this.close(); });
    document.addEventListener('pointerdown', e => {
      if (!this._open) return;
      if (e.target.closest('#notif-panel, #btn-notifications')) return;
      this.close();
    });
    this.refreshCount();
    this._timer = setInterval(() => { if (!document.hidden) this.refreshCount(); }, this.POLL_MS);
  },

  // ── data ──

  async refreshCount() {
    try {
      const c = await API.getUnreadCount();
      const grew = this._seeded && c.total > this._unread.total;
      this._setUnread(c);
      this._seeded = true;
      if (typeof Submissions !== 'undefined') Submissions.refreshBadge();
      if (this._open) await this.load();
      else if (grew) UI.toast(`You have ${c.total} unread notification${c.total === 1 ? '' : 's'}.`, 'info');
    } catch (_) { /* offline or signed out — try again next tick */ }
  },

  async load(more = false) {
    try {
      const res = await API.getNotifications({
        category: this._tab || undefined,
        beforeId: more && this._items.length ? this._items[this._items.length - 1].id : undefined,
        limit: this.PAGE,
      });
      this._items = more ? this._items.concat(res.items) : res.items;
      this._hasMore = res.has_more;
      this._setUnread(res.unread);
      this._renderList();
    } catch (e) {
      const list = document.getElementById('notif-list');
      if (list) list.innerHTML = `<div class="notif-empty">Could not load notifications.</div>`;
    }
  },

  _setUnread(c) {
    this._unread = c;
    const badge = document.getElementById('notif-badge');
    if (badge) {
      badge.hidden = !c.total;
      badge.textContent = c.total > 99 ? '99+' : String(c.total);
    }
    const bell = document.getElementById('btn-notifications');
    if (bell) bell.setAttribute('aria-label', c.total ? `Notifications, ${c.total} unread` : 'Notifications');
    this._renderTabs();
  },

  // ── panel ──

  _build() {
    if (document.getElementById('notif-panel')) return;
    const el = document.createElement('aside');
    el.id = 'notif-panel';
    el.className = 'notif-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Notifications');
    el.hidden = true;
    el.innerHTML = `
      <div class="notif-head">
        <h2>Notifications</h2>
        <button type="button" class="notif-link-btn" id="notif-mark-all">Mark all read</button>
        <button type="button" class="notif-close" id="notif-close" aria-label="Close notifications">&times;</button>
      </div>
      <div class="notif-tabs" id="notif-tabs" role="tablist"></div>
      <div class="notif-list" id="notif-list" aria-live="polite"></div>`;
    document.body.appendChild(el);
    el.querySelector('#notif-close').addEventListener('click', () => this.close());
    el.querySelector('#notif-mark-all').addEventListener('click', () => this.markAllRead());
    el.querySelector('#notif-tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (b) { this._tab = b.dataset.tab; this._renderTabs(); this.load(); }
    });
    el.querySelector('#notif-list').addEventListener('click', e => this._onListClick(e));
    this._renderTabs();
  },

  toggle() { this._open ? this.close() : this.open(); },

  open() {
    this._open = true;
    const el = document.getElementById('notif-panel');
    el.hidden = false;
    document.getElementById('btn-notifications')?.setAttribute('aria-expanded', 'true');
    document.getElementById('notif-list').innerHTML = '<div class="notif-empty">Loading…</div>';
    this.load();
    el.querySelector('#notif-close').focus();
  },

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('notif-panel').hidden = true;
    const bell = document.getElementById('btn-notifications');
    bell?.setAttribute('aria-expanded', 'false');
    bell?.focus();
  },

  _renderTabs() {
    const host = document.getElementById('notif-tabs');
    if (!host) return;
    host.innerHTML = this.TABS.map(t => {
      const n = t.id ? (this._unread.by_category[t.id] || 0) : this._unread.total;
      return `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === this._tab}"
        class="notif-tab${t.id === this._tab ? ' active' : ''}">${t.label}${n ? ` <span class="notif-tab-n">${n}</span>` : ''}</button>`;
    }).join('');
  },

  _renderList() {
    const host = document.getElementById('notif-list');
    if (!host) return;
    if (!this._items.length) {
      host.innerHTML = `<div class="notif-empty">${this._tab ? 'Nothing here yet.' : 'You are all caught up.'}</div>`;
      return;
    }
    let html = '', lastDay = null;
    for (const n of this._items) {
      const day = this._dayLabel(n.created_at);
      if (day !== lastDay) { html += `<div class="notif-day">${this._esc(day)}</div>`; lastDay = day; }
      const action = this._actionLabel(n);
      html += `<div class="notif-item${n.read ? '' : ' unread'}" data-id="${n.id}">
        <button type="button" class="notif-main" data-open="${n.id}">
          <span class="notif-meta"><span class="notif-cat cat-${this._esc(n.category)}">${this._esc(this.CATEGORY_LABEL[n.category] || n.category)}</span>
            <span class="notif-time">${this._esc(this._timeLabel(n.created_at))}</span></span>
          <span class="notif-msg">${this._esc(n.message)}</span>
          ${action ? `<span class="notif-action">${this._esc(action)}</span>` : ''}
        </button>
        <button type="button" class="notif-del" data-del="${n.id}" aria-label="Dismiss notification">&times;</button>
      </div>`;
    }
    if (this._hasMore) html += `<button type="button" class="notif-more" id="notif-more">Show older</button>`;
    host.innerHTML = html;
  },

  async _onListClick(e) {
    if (e.target.closest('#notif-more')) { this.load(true); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      try { await API.deleteNotification(del.dataset.del); } catch (_) {}
      this._items = this._items.filter(n => String(n.id) !== del.dataset.del);
      this._renderList();
      this.refreshCount();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (!open) return;
    const n = this._items.find(x => String(x.id) === open.dataset.open);
    if (!n) return;
    if (!n.read) {
      n.read = true;
      try { this._setUnread(await API.markNotificationsRead({ ids: [n.id] })); } catch (_) {}
      this._renderList();
    }
    this._follow(n);
  },

  async markAllRead() {
    try {
      this._setUnread(await API.markNotificationsRead({ category: this._tab || undefined }));
    } catch (_) { return; }
    this._items.forEach(n => { if (!this._tab || n.category === this._tab) n.read = true; });
    this._renderList();
  },

  // "Your edit is out of date" notifications stop meaning anything once nothing is out of date
  // (reviewed here, or in another browser): mark them read.
  async clearDriftIfResolved() {
    if (typeof StandardData === 'undefined' || StandardData.driftList().length) return;
    try {
      const res = await API.getNotifications({ category: 'libraries', unreadOnly: true, limit: 100 });
      const ids = res.items.filter(i => i.kind === 'override_out_of_date').map(i => i.id);
      if (ids.length) { await API.markNotificationsRead({ ids }); this.refreshCount(); }
    } catch (_) { /* not signed in yet — nothing to clear */ }
  },

  // ── links ──

  _actionLabel(n) {
    const t = n.link && n.link.type;
    if (t === 'project') return 'Open project';
    if (t === 'library') return n.link.drift ? 'Review my edits' : 'View libraries';
    if (t === 'submissions') return 'Open submissions';
    return '';
  },

  async _follow(n) {
    const l = n.link;
    if (!l) return;
    if (l.type === 'project') {
      if (await Project.openById(l.id)) this.close();
    } else if (l.type === 'submissions') {
      this.close();
      Submissions.open({ id: l.id });
    } else if (l.type === 'library' && l.drift) {
      this.close();
      StandardData.reviewDrift();
    } else if (l.type === 'library') {
      this.close();
      StandardData.open();
      document.querySelector('.settings-tab[data-tab="shared-libs"]')?.click();
    }
  },

  // ── formatting ──

  // The server sends UTC timestamps without a zone marker; read them as UTC.
  _date(iso) {
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  },

  _timeLabel(iso) {
    const d = this._date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  },

  _dayLabel(iso) {
    const d = this._date(iso), today = new Date();
    const key = x => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    if (key(d) === key(today)) return 'Today';
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (key(d) === key(y)) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  },

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
