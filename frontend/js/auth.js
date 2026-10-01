/* ProtectionPro — Authentication (login gate, account, admin invites) */

const Auth = {
  user: null,
  _pendingInvite: null,

  isAdmin() { return !!(this.user && this.user.is_admin); },
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
    document.getElementById('btn-change-password')?.addEventListener('click', () => this._changePassword());
    document.getElementById('btn-generate-invite')?.addEventListener('click', () => this._generateInvite());
    document.getElementById('btn-copy-invite')?.addEventListener('click', () => this._copyInvite());
    document.getElementById('btn-copy-reset')?.addEventListener('click', () => this._copy(document.getElementById('reset-link').value, 'Reset link copied'));
  },

  openAccount() {
    this._applyAuthedState();
    const m = document.getElementById('account-modal');
    if (m) m.style.display = '';
    if (this.isAdmin()) { this._refreshMode().then(() => { this._renderInvites(); this._renderUsers(); }); }
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

  _copy(text, done) {
    navigator.clipboard?.writeText(text).then(() => UI.toast && UI.toast(done, 'success')).catch(() => {});
  },

  async _renderInvites() {
    const list = document.getElementById('invites-list');
    if (!list) return;
    try {
      const invites = (await API.listInvites()).filter(i => !i.used_by);
      if (!invites.length) { list.innerHTML = '<p class="auth-hint">No pending invitations.</p>'; return; }
      list.innerHTML = invites.map(inv => {
        const exp = inv.expires_at ? ` · expires ${new Date(inv.expires_at.endsWith('Z') || /[+-]\d\d:/.test(inv.expires_at) ? inv.expires_at : inv.expires_at + 'Z').toLocaleDateString()}` : '';
        return `<div class="invite-row" data-id="${inv.id}">
          <span class="invite-for">${inv.email ? this._esc(inv.email) : 'Anyone with the link'}<small style="color:var(--text-muted)">${exp}</small></span>
          ${this._emailOn && inv.email ? `<button class="btn-small invite-resend" data-id="${inv.id}">Resend</button>` : ''}
          <button class="btn-small invite-copy" data-code="${this._esc(inv.code)}">Copy link</button>
          <button class="btn-small invite-revoke" data-id="${inv.id}">Revoke</button>
        </div>`;
      }).join('');
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

  async _renderUsers() {
    const list = document.getElementById('users-list');
    if (!list) return;
    try {
      const users = await API.listUsers();
      list.innerHTML = users.map(u => `<div class="user-row">
        <span class="invite-for">${this._esc(u.name || u.email)}<small>${u.name ? this._esc(u.email) : ''}${u.is_admin ? ' · admin' : ''}</small></span>
        ${this._emailOn ? `<button class="btn-small user-welcome" data-id="${u.id}">Send welcome</button>` : ''}
        <button class="btn-small user-reset" data-id="${u.id}">${this._emailOn ? 'Email reset link' : 'Copy reset link'}</button>
      </div>`).join('');
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
