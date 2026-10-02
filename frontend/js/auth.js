/* ProtectionPro — Authentication (login gate, account, admin invites) */

const Auth = {
  user: null,
  _pendingInvite: null,

  isAdmin() { return !!(this.user && this.user.is_admin); },
  // May review company-library submissions: an administrator or a library approver.
  isApprover() { return !!(this.user && (this.user.is_admin || this.user.is_approver)); },
  currentUserId() { return this.user ? this.user.id : null; },
  currentEmail() { return this.user ? this.user.email : null; },

  init() {
    this._wireGate();
    this._wireAccount();
    this._parseInviteLink();
    // An invite/reset link opened in a tab that already has the app loaded.
    window.addEventListener('hashchange', () => {
      if (/[#&](invite|reset)=/.test(location.hash)) { this._parseInviteLink(); this.showGate(); }
    });

    // Start gated: the #auth-modal blocks all interaction with the app behind
    // it. Unlock only once a valid session is confirmed.
    this.showGate();
    const token = API.getToken();
    if (token) {
      API.me()
        .then(u => { this.user = u; this._applyAuthedState(); this.hideGate(); })
        .catch(() => { /* invalid/expired — stay on the gate */ });
    }
  },

  // ── The login gate (non-dismissable) ──

  showGate() {
    const m = document.getElementById('auth-modal');
    if (m) m.style.display = '';
    // A reset link or an invite link wins; otherwise a server with no users
    // gets the first-run setup wizard instead of the sign-in dialog.
    if (this._pendingReset) {
      this._showTab('reset');
    } else if (this._pendingInvite) {
      this._showTab('register');
    } else {
      API.request('/health').then(h => {
        if (h && h.users === 0 && typeof Setup !== 'undefined') {
          if (m) m.style.display = 'none';
          Setup.open();
        } else this._showTab('login');
      }).catch(() => this._showTab('login'));
    }
    setTimeout(() => document.getElementById('auth-login-email')?.focus(), 50);
  },

  hideGate() {
    const m = document.getElementById('auth-modal');
    if (m) m.style.display = 'none';
  },

  // Mid-session token expiry: re-show the gate over the LIVE app without
  // resetting AppState, so unsaved work is preserved.
  onUnauthorized() {
    if (this.user) {
      this.user = null;
      UI.toast && UI.toast('Your session expired — please sign in again.', 'warning');
    }
    this.showGate();
  },

  _showTab(which) {
    const panes = { login: 'auth-login-pane', register: 'auth-register-pane', forgot: 'auth-forgot-pane', reset: 'auth-reset-pane' };
    for (const [k, id] of Object.entries(panes)) {
      const el = document.getElementById(id);
      if (el) el.style.display = k === which ? '' : 'none';
    }
    const tabs = document.querySelector('#auth-modal .auth-tabs');
    if (tabs) tabs.style.display = (which === 'login' || which === 'register') && !this._pendingInvite ? '' : 'none';
    document.getElementById('auth-tab-login').classList.toggle('active', which === 'login');
    document.getElementById('auth-tab-register').classList.toggle('active', which === 'register');
    document.getElementById('auth-modal-title').textContent =
      { login: 'Sign in', register: this._pendingInvite ? 'Join your team' : 'Create account', forgot: 'Reset your password', reset: 'Choose a new password' }[which];
  },

  _parseInviteLink() {
    const m = /[#&]invite=([^&]+)/.exec(location.hash || '');
    const r = /[#&]reset=([^&]+)/.exec(location.hash || '');
    if (r) this._pendingReset = decodeURIComponent(r[1]);
    if (m) {
      this._pendingInvite = decodeURIComponent(m[1]);
      const field = document.getElementById('auth-reg-invite');
      if (field) field.value = this._pendingInvite;
      // Show who invited you and lock the email the invite was sent to.
      API.inviteCheck(this._pendingInvite).then(c => {
        const hint = document.getElementById('auth-reg-hint');
        if (!c.valid) { if (hint) hint.textContent = 'This invitation has expired or was already used. Ask for a new one.'; return; }
        if (c.email) { const e = document.getElementById('auth-reg-email'); e.value = c.email; e.readOnly = true; }
        if (hint) hint.textContent = `${c.inviter} invited you to ProtectionPro. Choose a password to create your account.`;
        const row = document.getElementById('auth-reg-invite')?.closest('.form-group');
        if (row) row.style.display = 'none';
      }).catch(() => {});
    }
    // Strip secrets from the URL so a reload/share doesn't leak them.
    if (m || r) history.replaceState(null, '', location.pathname + location.search);
  },

  _wireGate() {
    document.getElementById('auth-tab-login')?.addEventListener('click', () => this._showTab('login'));
    document.getElementById('auth-tab-register')?.addEventListener('click', () => this._showTab('register'));

    const loginSubmit = () => this._doLogin();
    document.getElementById('auth-login-submit')?.addEventListener('click', loginSubmit);
    document.getElementById('auth-login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') loginSubmit(); });

    document.getElementById('auth-forgot-link')?.addEventListener('click', () => {
      document.getElementById('auth-forgot-email').value = document.getElementById('auth-login-email').value;
      document.getElementById('auth-forgot-msg').textContent = '';
      this._showTab('forgot');
    });
    document.getElementById('auth-forgot-back')?.addEventListener('click', () => this._showTab('login'));
    document.getElementById('auth-forgot-submit')?.addEventListener('click', () => this._doForgot());
    document.getElementById('auth-forgot-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') this._doForgot(); });
    document.getElementById('auth-reset-submit')?.addEventListener('click', () => this._doReset());
    document.getElementById('auth-reset-confirm')?.addEventListener('keydown', e => { if (e.key === 'Enter') this._doReset(); });

    const regSubmit = () => this._doRegister();
    document.getElementById('auth-register-submit')?.addEventListener('click', regSubmit);
    document.getElementById('auth-reg-invite')?.addEventListener('keydown', e => { if (e.key === 'Enter') regSubmit(); });
  },

  async _doLogin() {
    const email = document.getElementById('auth-login-email').value.trim();
    const password = document.getElementById('auth-login-password').value;
    const errEl = document.getElementById('auth-login-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
    try {
      const res = await API.login(email, password);
      this._onAuthSuccess(res);
    } catch (e) {
      errEl.textContent = e.message || 'Sign-in failed.';
    }
  },

  async _doForgot() {
    const email = document.getElementById('auth-forgot-email').value.trim();
    const msg = document.getElementById('auth-forgot-msg');
    msg.className = 'auth-error';
    if (!email) { msg.textContent = 'Enter your email address.'; return; }
    try {
      const r = await API.forgotPassword(email);
      if (!r.email_enabled) {
        msg.textContent = 'This server can’t send email. Ask your administrator for a password-reset link, then open it in your browser.';
      } else {
        msg.className = 'auth-hint';
        msg.textContent = 'If an account exists for that address, a reset link is on its way. It works for 1 hour. Check spam too.';
      }
    } catch (e) { msg.textContent = e.message || 'Could not send the reset link.'; }
  },

  async _doReset() {
    const pw = document.getElementById('auth-reset-password').value;
    const cf = document.getElementById('auth-reset-confirm').value;
    const err = document.getElementById('auth-reset-error');
    err.textContent = '';
    if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    if (pw !== cf) { err.textContent = 'The two passwords don’t match.'; return; }
    try {
      const res = await API.resetPassword(this._pendingReset, pw);
      this._pendingReset = null;
      this._onAuthSuccess(res);
    } catch (e) { err.textContent = e.message || 'Could not reset the password.'; }
  },

  async _doRegister() {
    const name = document.getElementById('auth-reg-name').value.trim();
    const email = document.getElementById('auth-reg-email').value.trim();
    const password = document.getElementById('auth-reg-password').value;
    const invite = document.getElementById('auth-reg-invite').value.trim();
    const errEl = document.getElementById('auth-register-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Enter an email and password.'; return; }
    if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
    try {
      const res = await API.register({ email, password, name, invite_code: invite || null });
      this._onAuthSuccess(res);
    } catch (e) {
      errEl.textContent = e.message || 'Registration failed.';
    }
  },

  _onAuthSuccess(res) {
    API.setToken(res.access_token);
    this.user = res.user;
    this._applyAuthedState();
    this.hideGate();
    // Refresh any project-browsing view the user may have open.
    if (typeof Project !== 'undefined' && Project.refreshProjectViewIfOpen) {
      Project.refreshProjectViewIfOpen();
    }
    UI.toast && UI.toast(`Signed in as ${this.user.email}`, 'success');
  },

  _applyAuthedState() {
    if (!this.user) return;
    // Component libraries are per user: load this user's (never the previous user's).
    if (typeof StandardData !== 'undefined') StandardData.loadFromServer(this.user.id);
    if (typeof Rates !== 'undefined') Rates.loadDefaultFromServer(this.user.id);
    if (typeof Notifications !== 'undefined') Notifications.start();
    const label = document.getElementById('account-email');
    if (label) label.textContent = this.user.email;
    const disp = document.getElementById('account-email-display');
    if (disp) disp.textContent = this.user.email + (this.isAdmin() ? ' (admin)' : '');
    const emailTab = document.getElementById('settings-tab-btn-email');
    if (emailTab) emailTab.hidden = !this.isAdmin();
    const invitesSection = document.getElementById('account-invites-section');
    if (invitesSection) invitesSection.style.display = this.isAdmin() ? '' : 'none';
  },

  // ── Account modal + admin invites ──

  _wireAccount() {
    document.getElementById('btn-account')?.addEventListener('click', () => this.openAccount());
    document.getElementById('btn-close-account')?.addEventListener('click', () => this._hideAccount());
    document.getElementById('account-modal')?.addEventListener('click', e => {
      if (e.target.id === 'account-modal') this._hideAccount();
    });
    document.getElementById('btn-logout')?.addEventListener('click', () => this.logout());
    document.getElementById('btn-open-admin')?.addEventListener('click', () => { this._hideAccount(); this.openAdmin(); });
    document.getElementById('btn-close-admin')?.addEventListener('click', () => this._hideAdmin());
    document.getElementById('admin-modal')?.addEventListener('click', e => { if (e.target.id === 'admin-modal') this._hideAdmin(); });
    document.querySelectorAll('.admin-nav-btn').forEach(b => b.addEventListener('click', () => this._adminTab(b.dataset.adminTab)));
    ['btn-admin-invite', 'btn-admin-invite2'].forEach(id => document.getElementById(id)?.addEventListener('click', () => this._openInvite()));
    document.getElementById('btn-close-invite')?.addEventListener('click', () => { document.getElementById('invite-modal').style.display = 'none'; });
    document.getElementById('admin-users-search')?.addEventListener('input', () => this._renderUsers(true));
    document.getElementById('admin-projects-search')?.addEventListener('input', () => this._renderAdminProjects(this._users, true));
    document.getElementById('btn-change-password')?.addEventListener('click', () => this._changePassword());
    document.getElementById('btn-generate-invite')?.addEventListener('click', () => this._generateInvite());
    document.getElementById('btn-copy-invite')?.addEventListener('click', () => this._copyInvite());
    document.getElementById('btn-copy-reset')?.addEventListener('click', () => this._copy(document.getElementById('reset-link').value, 'Reset link copied'));
  },

  openAccount() {
    this._applyAuthedState();
    const m = document.getElementById('account-modal');
    if (m) m.style.display = '';
  },

  // Admin console: users, projects and invitations (separate from My account).
  openAdmin() {
    if (!this.isAdmin()) return;
    const m = document.getElementById('admin-modal');
    if (m) m.style.display = '';
    this._adminTab(this._adminCurrent || 'users');
    this._refreshMode().then(() => { this._renderInvites(); this._renderUsers(); });
  },

  _hideAdmin() {
    const m = document.getElementById('admin-modal');
    if (m) m.style.display = 'none';
  },

  _adminTab(tab) {
    this._adminCurrent = tab;
    document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.adminTab === tab));
    ['users', 'projects', 'invites'].forEach(t => { const p = document.getElementById('admin-pane-' + t); if (p) p.hidden = t !== tab; });
  },

  _openInvite() {
    document.getElementById('invite-result').textContent = '';
    document.getElementById('invite-link-row').style.display = 'none';
    document.getElementById('invite-modal').style.display = '';
  },

  _fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso.endsWith('Z') || /[+-]\d\d:/.test(iso) ? iso : iso + 'Z').toLocaleDateString();
  },

  // Is email configured? Decides "Send invitation" vs "Create invite link".
  async _refreshMode() {
    try { this._emailOn = !!(await API.request('/health')).email_configured; } catch (_) { this._emailOn = false; }
    const btn = document.getElementById('btn-generate-invite');
    const email = document.getElementById('invite-email');
    const hint = document.getElementById('invite-mode-hint');
    document.getElementById('invite-note-row').style.display = this._emailOn ? '' : 'none';
    if (btn) btn.textContent = this._emailOn ? 'Send invitation' : 'Create invite link';
    if (email) email.placeholder = this._emailOn ? 'name@company.com' : 'Optional — who is this for?';
    if (hint) hint.innerHTML = this._emailOn
      ? 'The person gets an email with a link to join. Each invite works once.'
      : 'Email isn’t set up, so you’ll get a link to send yourself. Each invite works once. Set up email in <b>Settings › Email</b>.';
  },

  _base() { return location.origin + location.pathname.replace(/\/[^/]*$/, ''); },

  async _changePassword() {
    const cur = document.getElementById('pw-current'), nw = document.getElementById('pw-new'), cf = document.getElementById('pw-confirm');
    const msg = document.getElementById('pw-msg');
    msg.className = 'auth-error';
    if (!cur.value) { msg.textContent = 'Enter your current password.'; return; }
    if (nw.value.length < 8) { msg.textContent = 'The new password must be at least 8 characters.'; return; }
    if (nw.value !== cf.value) { msg.textContent = 'The two new passwords don’t match.'; return; }
    try {
      await API.changePassword(cur.value, nw.value);
      cur.value = nw.value = cf.value = '';
      msg.className = 'auth-hint';
      msg.textContent = 'Password changed.';
    } catch (e) { msg.textContent = e.message || 'Could not change the password.'; }
  },

  _hideAccount() {
    const m = document.getElementById('account-modal');
    if (m) m.style.display = 'none';
  },

  async logout() {
    if (AppState.dirty) {
      const ok = await UI.confirm('You have unsaved changes. Log out anyway?', { danger: true, okText: 'Log out' });
      if (!ok) return;
    }
    try { await API.logout(); } catch (_) { /* best effort */ }
    API.clearToken();
    this.user = null;
    // Full reload is the cleanest reset of all in-memory module state.
    location.reload();
  },

  _inviteLink(code) {
    return `${location.origin}${location.pathname}#invite=${encodeURIComponent(code)}`;
  },

  async _generateInvite() {
    const email = document.getElementById('invite-email').value.trim();
    const res = document.getElementById('invite-result');
    res.textContent = '';
    if (this._emailOn && !email) { res.textContent = 'Enter the email address to send the invitation to.'; return; }
    try {
      const inv = await API.createInvite({
        email: email || undefined, send_email: this._emailOn && !!email,
        expires_days: parseInt(document.getElementById('invite-days').value, 10),
        note: document.getElementById('invite-note').value.trim() || undefined, base_url: this._base(),
      });
      const row = document.getElementById('invite-link-row');
      const input = document.getElementById('invite-link');
      input.value = inv.link;
      // Always show the link: it is the fallback if the email doesn't arrive.
      row.style.display = '';
      res.textContent = inv.emailed ? `Invitation sent to ${email}. The link is below in case you need it.`
        : (inv.email_error ? `Couldn’t send the email: ${inv.email_error} Copy the link below instead.` : 'Link created — copy it and send it to the person.');
      document.getElementById('invite-email').value = '';
      document.getElementById('invite-role').value = 'user';
      this._renderInvites();
    } catch (e) {
      UI.toast && UI.toast(e.message || 'Could not create invite', 'error');
    }
  },

  _copyInvite() {
    const input = document.getElementById('invite-link');
    if (!input || !input.value) return;
    navigator.clipboard?.writeText(input.value)
      .then(() => UI.toast && UI.toast('Invite link copied', 'success'))
      .catch(() => { input.select(); document.execCommand && document.execCommand('copy'); });
  },

  // Ask which active user should receive something. Resolves {id, keep} or null.
  _pickUser(users, { title, text, label, okText, showKeep }) {
    return new Promise(resolve => {
      const m = document.getElementById('heir-modal');
      document.getElementById('heir-title').textContent = title;
      document.getElementById('heir-text').textContent = text;
      document.getElementById('heir-label').textContent = label;
      document.getElementById('heir-ok').textContent = okText;
      document.getElementById('heir-keep-row').style.display = showKeep ? '' : 'none';
      document.getElementById('heir-keep').checked = true;
      const sel = document.getElementById('heir-select');
      sel.innerHTML = users.map(u => `<option value="${u.id}"${u.id === this.user.id ? ' selected' : ''}>${this._esc(u.name || u.email)}${u.name ? ' — ' + this._esc(u.email) : ''}${u.id === this.user.id ? ' (you)' : ''}</option>`).join('');
      const done = (v) => { m.style.display = 'none'; ['heir-ok', 'heir-cancel', 'heir-close'].forEach(i => { const b = document.getElementById(i); b.replaceWith(b.cloneNode(true)); }); resolve(v); };
      m.style.display = '';
      document.getElementById('heir-ok').addEventListener('click', () => done({ id: parseInt(sel.value, 10), keep: document.getElementById('heir-keep').checked }));
      document.getElementById('heir-cancel').addEventListener('click', () => done(null));
      document.getElementById('heir-close').addEventListener('click', () => done(null));
    });
  },

  async _renderAdminProjects(users, filterOnly) {
    const list = document.getElementById('admin-projects-list');
    if (!list) return;
    try {
      if (!filterOnly || !this._projRows) this._projRows = await API.adminProjects();
      const all = this._projRows;
      const cnt = document.getElementById('admin-count-projects'); if (cnt) cnt.textContent = all.length;
      const q = (document.getElementById('admin-projects-search')?.value || '').trim().toLowerCase();
      const rows = q ? all.filter(p => (p.name + ' ' + p.owner_name).toLowerCase().includes(q)) : all;
      if (!rows.length) { list.innerHTML = `<div class="empty">${all.length ? 'No projects match.' : 'No projects yet.'}</div>`; return; }
      list.innerHTML = rows.map(p => `<div class="admin-row admin-cols-projects">
        <div class="admin-cell-main">${this._esc(p.name)}</div>
        <div>${this._esc(p.owner_name)}${p.owner_active ? '' : ' <span class="admin-pill off">Deactivated</span>'}</div>
        <div>${this._fmtDate(p.updated_at)}</div>
        <div class="admin-actions">
          <button class="btn-small proj-take" data-id="${p.id}" ${p.owner_id === this.user.id ? 'disabled' : ''}>Take ownership</button>
          <button class="btn-small proj-transfer" data-id="${p.id}" data-name="${this._esc(p.name)}">Transfer…</button>
        </div></div>`).join('');
      const doTransfer = async (id, to, keep, msg) => {
        try { await API.transferProject(id, to, keep); UI.toast && UI.toast(msg, 'success'); this._projRows = null; this._renderAdminProjects(users);
          if (typeof Project !== 'undefined' && Project.refreshProjectViewIfOpen) Project.refreshProjectViewIfOpen();
        } catch (e) { UI.toast && UI.toast(e.message || 'Could not transfer', 'error'); }
      };
      list.querySelectorAll('.proj-take').forEach(b => b.addEventListener('click', async () => {
        if (await UI.confirm('Take ownership of this project? It will appear in your own projects, and the previous owner keeps edit access.', { okText: 'Take ownership' }))
          doTransfer(parseInt(b.dataset.id, 10), this.user.id, true, 'You now own the project');
      }));
      list.querySelectorAll('.proj-transfer').forEach(b => b.addEventListener('click', async () => {
        const pick = await this._pickUser((users || []).filter(u => u.is_active), { title: 'Transfer project', text: `Move “${b.dataset.name}” to another user. It leaves the previous owner’s folders.`, label: 'New owner', okText: 'Transfer', showKeep: true });
        if (pick) doTransfer(parseInt(b.dataset.id, 10), pick.id, pick.keep, 'Project transferred');
      }));
    } catch (e) { list.innerHTML = `<p class="auth-error">${this._esc(e.message || 'Failed to load projects')}</p>`; }
  },

  _copy(text, done) {
    navigator.clipboard?.writeText(text).then(() => UI.toast && UI.toast(done, 'success')).catch(() => {});
  },

  async _renderInvites() {
    const list = document.getElementById('invites-list');
    if (!list) return;
    try {
      const invites = (await API.listInvites()).filter(i => !i.used_by);
      const cnt = document.getElementById('admin-count-invites'); if (cnt) cnt.textContent = invites.length || '';
      if (!invites.length) { list.innerHTML = '<div class="empty">No pending invitations.</div>'; return; }
      list.innerHTML = invites.map(inv => `<div class="admin-row admin-cols-invites" data-id="${inv.id}">
          <div class="admin-cell-main">${inv.email ? this._esc(inv.email) : 'Anyone with the link'}${inv.is_admin ? '<small>Administrator</small>' : ''}</div>
          <div>${inv.expires_at ? this._fmtDate(inv.expires_at) : 'No expiry'}</div>
          <div class="admin-actions">
          ${this._emailOn && inv.email ? `<button class="btn-small invite-resend" data-id="${inv.id}">Resend</button>` : ''}
          <button class="btn-small invite-copy" data-code="${this._esc(inv.code)}">Copy link</button>
          <button class="btn-small invite-revoke danger" data-id="${inv.id}">Revoke</button>
          </div></div>`).join('');
      list.querySelectorAll('.invite-revoke').forEach(btn => btn.addEventListener('click', async () => {
        await API.deleteInvite(parseInt(btn.dataset.id, 10));
        this._renderInvites();
      }));
      list.querySelectorAll('.invite-copy').forEach(btn => btn.addEventListener('click',
        () => this._copy(`${this._base()}/#invite=${encodeURIComponent(btn.dataset.code)}`, 'Invite link copied')));
      list.querySelectorAll('.invite-resend').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const r = await API.resendInvite(parseInt(btn.dataset.id, 10), this._base());
          UI.toast && UI.toast(r.emailed ? 'Invitation sent again' : (r.email_error || 'Not sent'), r.emailed ? 'success' : 'error');
        } catch (e) { UI.toast && UI.toast(e.message, 'error'); }
      }));
    } catch (e) {
      list.innerHTML = `<p class="auth-error">${this._esc(e.message || 'Failed to load invites')}</p>`;
    }
  },

  async _renderUsers(filterOnly) {
    const list = document.getElementById('users-list');
    if (!list) return;
    try {
      const users = (filterOnly && this._users) || await API.listUsers();
      this._users = users;
      if (!filterOnly) { this._projRows = null; this._renderAdminProjects(users); }
      const q = (document.getElementById('admin-users-search')?.value || '').trim().toLowerCase();
      const shown = q ? users.filter(u => ((u.name || '') + ' ' + u.email).toLowerCase().includes(q)) : users;
      const cnt = document.getElementById('admin-count-users'); if (cnt) cnt.textContent = users.length;
      const sub = document.getElementById('admin-users-sub'); if (sub) sub.textContent = `${users.length} users · ${users.filter(u => u.is_active).length} active`;
      list.innerHTML = !shown.length ? '<div class="empty">No users match.</div>' : shown.map(u => `<div class="admin-row admin-cols-users">
        <div class="admin-cell-main" data-name="${this._esc(u.name || u.email)}">${this._esc(u.name || u.email)}${u.name ? `<small>${this._esc(u.email)}</small>` : ''}</div>
        <div>${u.is_admin ? '<span class="admin-pill admin">Admin</span>' : u.is_approver ? '<span class="admin-pill ok">Approver</span>' : 'User'}</div>
        <div><span class="admin-pill ${u.is_active ? 'ok' : 'off'}">${u.is_active ? 'Active' : 'Deactivated'}</span></div>
        <div class="admin-actions">
        ${u.id === this.user.id ? '<small style="color:var(--text-muted)">This is you</small>' : ''}
        ${u.id !== this.user.id ? `<button class="btn-small user-active" data-id="${u.id}" data-active="${u.is_active ? 1 : 0}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button><button class="btn-small user-delete danger" data-id="${u.id}">Delete</button>` : ''}
        ${u.id !== this.user.id && u.is_active ? `<button class="btn-small user-role" data-id="${u.id}" data-admin="${u.is_admin ? 1 : 0}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
        ${!u.is_admin && u.is_active ? `<button class="btn-small user-approver" data-id="${u.id}" data-approver="${u.is_approver ? 1 : 0}" title="An approver reviews submissions to the company library without being an administrator">${u.is_approver ? 'Remove approver' : 'Make approver'}</button>` : ''}
        ${this._emailOn && u.is_active ? `<button class="btn-small user-welcome" data-id="${u.id}">Send welcome</button>` : ''}
        ${u.is_active ? `<button class="btn-small user-reset" data-id="${u.id}">${this._emailOn ? 'Email reset link' : 'Copy reset link'}</button>` : ''}
        </div></div>`).join('');
      const nameOf = (btn) => btn.closest('.admin-row').querySelector('.admin-cell-main').dataset.name;
      list.querySelectorAll('.user-active').forEach(btn => btn.addEventListener('click', async () => {
        const off = btn.dataset.active === '1';
        if (off && !(await UI.confirm(`Deactivate ${nameOf(btn)}? They won’t be able to sign in, but their projects stay as they are. You can reactivate them later.`, { okText: 'Deactivate', danger: true }))) return;
        try { await API.setActive(parseInt(btn.dataset.id, 10), !off); this._renderUsers(); }
        catch (e) { UI.toast && UI.toast(e.message || 'Could not change the account', 'error'); }
      }));
      list.querySelectorAll('.user-delete').forEach(btn => btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id, 10);
        const pick = await this._pickUser(users.filter(u => u.is_active && u.id !== id), {
          title: `Delete ${nameOf(btn)}`,
          text: 'Their projects, folders and team libraries are kept and handed to the user you choose. Their sharing and personal libraries are removed. This can’t be undone — to just stop them signing in, use Deactivate instead.',
          label: 'Give their projects to', okText: 'Delete user', showKeep: false });
        if (!pick) return;
        try {
          const r = await API.deleteUser(id, pick.id);
          UI.toast && UI.toast(`User deleted${r.projects_moved ? ` — ${r.projects_moved} project(s) handed over` : ''}`, 'success');
          this._renderUsers();
        } catch (e) { UI.toast && UI.toast(e.message || 'Could not delete the user', 'error'); }
      }));
      list.querySelectorAll('.user-role').forEach(btn => btn.addEventListener('click', async () => {
        const makeAdmin = btn.dataset.admin !== '1';
        const name = btn.closest('.admin-row').querySelector('.admin-cell-main').dataset.name;
        const ok = await UI.confirm(makeAdmin
          ? `Make ${name} an administrator? They will be able to manage users, invites and email settings.`
          : `Remove administrator access from ${name}?`, { okText: makeAdmin ? 'Make admin' : 'Remove admin', danger: !makeAdmin });
        if (!ok) return;
        try { await API.setAdmin(parseInt(btn.dataset.id, 10), makeAdmin); this._renderUsers(); }
        catch (e) { UI.toast && UI.toast(e.message || 'Could not change the role', 'error'); }
      }));
      list.querySelectorAll('.user-approver').forEach(btn => btn.addEventListener('click', async () => {
        try { await API.setApprover(parseInt(btn.dataset.id, 10), btn.dataset.approver !== '1'); this._renderUsers(); }
        catch (e) { UI.toast && UI.toast(e.message || 'Could not change the role', 'error'); }
      }));
      list.querySelectorAll('.user-welcome').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const r = await API.sendWelcome(parseInt(btn.dataset.id, 10));
          UI.toast && UI.toast(r.emailed ? 'Welcome email sent' : (r.email_error || 'Not sent'), r.emailed ? 'success' : 'error');
        } catch (e) { UI.toast && UI.toast(e.message, 'error'); }
      }));
      list.querySelectorAll('.user-reset').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const r = await API.userResetLink(parseInt(btn.dataset.id, 10), this._emailOn, this._base());
          const row = document.getElementById('reset-link-row');
          document.getElementById('reset-link').value = r.link;
          row.style.display = '';
          if (r.emailed) UI.toast && UI.toast('Reset link emailed', 'success');
          else if (this._emailOn && r.email_error) UI.toast && UI.toast(`${r.email_error} Copy the link below instead.`, 'error');
          else { this._copy(r.link, 'Reset link copied — send it to the user'); }
        } catch (e) { UI.toast && UI.toast(e.message, 'error'); }
      }));
    } catch (e) {
      list.innerHTML = `<p class="auth-error">${this._esc(e.message || 'Failed to load users')}</p>`;
    }
  },

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
