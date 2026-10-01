/* ProtectionPro — First-run setup wizard.
 * Shown instead of sign-in when the server has no users yet:
 *   Welcome → Administrator (registers the first user = admin) → Email (optional) → Finish.
 * Email can be skipped; it lives on in Settings › Email.
 */

const Setup = {
  _step: 1,
  _email: null,       // EmailForm controller
  _admin: null,

  LABELS: ['Welcome', 'Administrator', 'Email', 'Finish'],
  SUBS: ['What we’ll set up', 'Your account', 'Optional', 'Review'],

  open() {
    this._step = 1;
    document.getElementById('setup-modal').style.display = '';
    if (!this._wired) {
      this._wired = true;
      document.getElementById('setup-next').addEventListener('click', () => this._next());
      document.getElementById('setup-back').addEventListener('click', () => this._go(this._step - 1));
      document.getElementById('setup-pass').addEventListener('input', () => this._meter());
      ['setup-name', 'setup-email', 'setup-pass'].forEach(id =>
        document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') this._next(); }));
    }
    this._go(1);
  },

  close() {
    document.getElementById('setup-modal').style.display = 'none';
  },

  _go(n) {
    this._step = n;
    for (let i = 1; i <= 4; i++) document.getElementById(`setup-pane-${i}`).hidden = i !== n;
    document.getElementById('setup-steps').innerHTML = this.LABELS.map((l, i) => {
      const k = i + 1, cls = k < n ? 'done' : k === n ? 'cur' : '';
      return `<li class="${cls}"><span class="dot">${k < n ? '✓' : k}</span><span>${l}<br><small style="font-weight:400;color:#9fb3c2">${this.SUBS[i]}</small></span></li>`;
    }).join('');
    // The admin account exists from step 3 on, so there is no going back to it.
    document.getElementById('setup-back').hidden = n !== 2;
    this._label();
    if (n === 3) this._mountEmail();
    if (n === 4) this._summary();
    const first = document.querySelector(`#setup-pane-${n} input:not([type=hidden])`);
    if (first) setTimeout(() => first.focus(), 30);
  },

  _label() {
    const n = this._step;
    const b = document.getElementById('setup-next');
    if (n === 1) b.textContent = 'Get started';
    else if (n === 2) b.textContent = 'Continue';
    else if (n === 3) b.textContent = this._email && !this._email.isOn() ? 'Skip email and continue' : 'Save and continue';
    else b.textContent = 'Open ProtectionPro';
    b.disabled = false;
  },

  _meter() {
    const v = document.getElementById('setup-pass').value, n = v.length;
    const lv = n === 0 ? 0 : n < 8 ? 1 : n < 10 ? 2 : n < 14 ? 3 : 4;
    const [w, c, t] = [['0%', '#e1e8ed', ''], ['25%', '#d32f2f', 'Too short'], ['50%', '#f57c00', 'Weak'], ['75%', '#2a7f8f', 'Good'], ['100%', '#2e7d32', 'Strong']][lv];
    const bar = document.getElementById('setup-meter-bar');
    bar.style.width = w; bar.style.background = c;
    document.getElementById('setup-meter-label').textContent = t;
  },

  async _next() {
    const n = this._step;
    if (n === 1) return this._go(2);
    if (n === 2) return this._createAdmin();
    if (n === 3) return this._saveEmail();
    return this._finish();
  },

  async _createAdmin() {
    const err = document.getElementById('setup-admin-error');
    err.textContent = '';
    const name = document.getElementById('setup-name').value.trim();
    const email = document.getElementById('setup-email').value.trim();
    const password = document.getElementById('setup-pass').value;
    if (!name) { err.textContent = 'Enter your name.'; return; }
    if (!email.includes('@')) { err.textContent = 'Enter a valid email address.'; return; }
    if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    const btn = document.getElementById('setup-next');
    btn.disabled = true;
    try {
      const res = await API.register({ email, password, name });
      API.setToken(res.access_token);
      Auth.user = res.user;
      Auth._applyAuthedState();
      this._admin = res.user;
      this._go(3);
    } catch (e) {
      err.textContent = e.message || 'Could not create the account.';
      btn.disabled = false;
    }
  },

  async _mountEmail() {
    const host = document.getElementById('setup-email-form');
    if (!this._email) {
      this._email = EmailForm.create(host, { adminEmail: this._admin && this._admin.email });
      await this._email.load();
      host.addEventListener('click', () => this._label());
    }
    this._label();
  },

  async _saveEmail() {
    const err = document.getElementById('setup-email-error');
    err.textContent = '';
    try {
      await this._email.save();
      this._go(4);
    } catch (e) {
      err.textContent = e.message || 'Could not save the email settings.';
    }
  },

  _summary() {
    const s = this._email ? this._email.summary() : { on: false };
    document.getElementById('setup-done-admin').textContent = `${this._admin.name || 'Administrator'} · ${this._admin.email}`;
    document.getElementById('setup-done-email').textContent = s.on ? `Connected via ${s.host}` : 'Not set up — that’s fine';
    document.getElementById('setup-done-note').textContent = s.on
      ? `Invites and password resets will be emailed from ${s.from}.`
      : 'Invites and password resets will give you a link to copy and send. Add a mail server any time in Settings › Email.';
  },

  _finish() {
    this.close();
    Auth.hideGate();
    if (typeof Project !== 'undefined' && Project.refreshProjectViewIfOpen) Project.refreshProjectViewIfOpen();
    UI.toast && UI.toast(`Welcome, ${this._admin.name || this._admin.email}`, 'success');
  },
};
