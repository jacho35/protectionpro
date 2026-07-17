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
    // Default to the register tab on genuine first-run (an invite link, or no
    // users yet); otherwise show sign-in.
    if (this._pendingInvite) {
      this._showTab('register');
    } else {
      API.request('/health').then(h => {
        if (h && h.users === 0) this._showTab('register');
        else this._showTab('login');
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
    const login = which === 'login';
    document.getElementById('auth-login-pane').style.display = login ? '' : 'none';
    document.getElementById('auth-register-pane').style.display = login ? 'none' : '';
    document.getElementById('auth-tab-login').classList.toggle('active', login);
    document.getElementById('auth-tab-register').classList.toggle('active', !login);
    document.getElementById('auth-modal-title').textContent = login ? 'Sign in' : 'Create account';
  },

  _parseInviteLink() {
    const m = /[#&]invite=([^&]+)/.exec(location.hash || '');
    if (m) {
      this._pendingInvite = decodeURIComponent(m[1]);
      // Strip it from the URL so a reload/share doesn't leak the code.
      history.replaceState(null, '', location.pathname + location.search);
      const field = document.getElementById('auth-reg-invite');
      if (field) field.value = this._pendingInvite;
    }
  },

  _wireGate() {
    document.getElementById('auth-tab-login')?.addEventListener('click', () => this._showTab('login'));
    document.getElementById('auth-tab-register')?.addEventListener('click', () => this._showTab('register'));

    const loginSubmit = () => this._doLogin();
    document.getElementById('auth-login-submit')?.addEventListener('click', loginSubmit);
    document.getElementById('auth-login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') loginSubmit(); });

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
    const label = document.getElementById('account-email');
    if (label) label.textContent = this.user.email;
    const disp = document.getElementById('account-email-display');
    if (disp) disp.textContent = this.user.email + (this.isAdmin() ? ' (admin)' : '');
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
    document.getElementById('btn-generate-invite')?.addEventListener('click', () => this._generateInvite());
    document.getElementById('btn-copy-invite')?.addEventListener('click', () => this._copyInvite());
  },

  openAccount() {
    this._applyAuthedState();
    const m = document.getElementById('account-modal');
    if (m) m.style.display = '';
    if (this.isAdmin()) this._renderInvites();
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
    try {
      const inv = await API.createInvite(email ? { email } : {});
      const row = document.getElementById('invite-link-row');
      const input = document.getElementById('invite-link');
      input.value = this._inviteLink(inv.code);
      row.style.display = '';
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

  async _renderInvites() {
    const list = document.getElementById('invites-list');
    if (!list) return;
    try {
      const invites = await API.listInvites();
      if (!invites.length) { list.innerHTML = '<p class="auth-hint">No invites yet.</p>'; return; }
      list.innerHTML = invites.map(inv => {
        const status = inv.used_by ? 'used' : 'unused';
        const safeEmail = inv.email ? this._esc(inv.email) : 'anyone';
        return `<div class="invite-row" data-id="${inv.id}">
          <span class="invite-status invite-${status}">${status}</span>
          <span class="invite-for">${safeEmail}</span>
          <button class="btn-small invite-revoke" data-id="${inv.id}">Revoke</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.invite-revoke').forEach(btn => {
        btn.addEventListener('click', async () => {
          await API.deleteInvite(parseInt(btn.dataset.id, 10));
          this._renderInvites();
        });
      });
    } catch (e) {
      list.innerHTML = `<p class="auth-error">${this._esc(e.message || 'Failed to load invites')}</p>`;
    }
  },

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
