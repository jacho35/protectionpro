/* ProtectionPro — Email (SMTP) settings form.
 * One form, two homes: the first-run Setup wizard and Settings › Email.
 * Email is optional: "off" is a first-class choice, not an error.
 */

const EmailForm = {
  _n: 0,

  PRESETS: {
    'Gmail': { host: 'smtp.gmail.com', port: 587, security: 'starttls', note: 'Gmail needs an app password (Google Account › Security › App passwords), not your normal password.' },
    'Microsoft 365': { host: 'smtp.office365.com', port: 587, security: 'starttls', note: 'SMTP AUTH must be allowed for the sending mailbox in the Microsoft 365 admin centre.' },
    'Other SMTP': { host: '', port: 587, security: 'starttls', note: 'Ask your IT team or hosting provider for the SMTP server details.' },
  },

  // The address people use to reach this server (links in emails start with it).
  defaultAppUrl() {
    return (location.origin + location.pathname.replace(/\/[^/]*$/, '')).replace(/\/$/, '');
  },

  /** Build the form inside `el`. opts: { adminEmail, showSave, onSaved } → controller. */
  create(el, opts = {}) {
    const id = `ef${++this._n}`;
    const q = (s) => el.querySelector(`[data-ef="${s}"]`);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const state = { on: true, provider: '', hasPassword: false };

    el.innerHTML = `
      <div class="ef" id="${id}">
        <div class="ef-choice" role="radiogroup" aria-label="Email setup">
          <button type="button" class="ef-card" role="radio" data-ef="card-on"><b>Set up email</b><span>Send invites and reset links straight from the app.</span></button>
          <button type="button" class="ef-card" role="radio" data-ef="card-off"><b>Don’t send email</b><span>Share invite and reset links yourself.</span></button>
        </div>
        <div class="ef-note ef-warn" data-ef="off-note" hidden>Without email, <b>Invite</b> gives you a link to copy and send, and an administrator can generate a <b>reset link</b> for anyone who forgets their password. You can connect a mail server any time in <b>Settings › Email</b>.</div>
        <div data-ef="fields">
          <div class="ef-label">Quick fill</div>
          <div class="ef-pills" data-ef="pills"></div>
          <div class="ef-hint" data-ef="provider-note">Pick your mail provider to fill in the usual settings, or enter your own.</div>
          <div class="ef-grid ef-grid-server">
            <div class="ef-field"><label for="${id}-host">SMTP server</label><input id="${id}-host" data-ef="host" type="text" autocomplete="off" placeholder="mail.yourcompany.com"></div>
            <div class="ef-field"><label for="${id}-port">Port</label><input id="${id}-port" data-ef="port" type="number" min="1" max="65535"></div>
            <div class="ef-field"><label for="${id}-sec">Security</label><select id="${id}-sec" data-ef="security"><option value="starttls">STARTTLS</option><option value="ssl">SSL / TLS</option><option value="none">None</option></select></div>
          </div>
          <div class="ef-grid">
            <div class="ef-field"><label for="${id}-user">Username</label><input id="${id}-user" data-ef="username" type="text" autocomplete="off" placeholder="login for the mail server"></div>
            <div class="ef-field"><label for="${id}-pass">Password</label><input id="${id}-pass" data-ef="password" type="password" autocomplete="new-password"></div>
          </div>
          <div class="ef-grid">
            <div class="ef-field"><label for="${id}-fname">Sender name</label><input id="${id}-fname" data-ef="from_name" type="text"></div>
            <div class="ef-field"><label for="${id}-faddr">Sender address</label><input id="${id}-faddr" data-ef="from_address" type="email" placeholder="noreply@yourcompany.com"></div>
          </div>
          <div class="ef-field"><label for="${id}-url">Address people use to reach this server</label><input id="${id}-url" data-ef="app_url" type="url" class="ef-mono"><div class="ef-hint">Invite and reset links in emails start with this address. We filled in the one you’re using now.</div></div>
          <div class="ef-testrow">
            <button type="button" class="btn-secondary" data-ef="test">Send test email</button>
            <div class="ef-status" data-ef="status" role="status"></div>
          </div>
        </div>
        ${opts.showSave ? '<div class="ef-actions"><button type="button" class="btn-primary" data-ef="save">Save</button><span class="ef-status" data-ef="saved" role="status"></span></div>' : ''}
      </div>`;

    const val = (k) => q(k).value;
    const setStatus = (msg, kind) => { const s = q('status'); s.textContent = msg || ''; s.className = 'ef-status' + (kind ? ' ef-' + kind : ''); };
    const paint = () => {
      q('card-on').setAttribute('aria-checked', String(state.on));
      q('card-off').setAttribute('aria-checked', String(!state.on));
      q('card-on').classList.toggle('active', state.on);
      q('card-off').classList.toggle('active', !state.on);
      q('fields').hidden = !state.on;
      q('off-note').hidden = state.on;
      q('pills').querySelectorAll('button').forEach(b => {
        const on = b.dataset.p === state.provider;
        b.classList.toggle('active', on);
      });
      q('provider-note').textContent = (this.PRESETS[state.provider] || {}).note ||
        'Pick your mail provider to fill in the usual settings, or enter your own.';
      q('password').placeholder = state.hasPassword ? 'Saved — leave blank to keep' : 'or app password';
    };
    q('pills').innerHTML = Object.keys(this.PRESETS).map(n => `<button type="button" class="ef-pill" data-p="${esc(n)}">${esc(n)}</button>`).join('');
    q('pills').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]'); if (!b) return;
      const p = this.PRESETS[b.dataset.p];
      state.provider = b.dataset.p;
      q('host').value = p.host; q('port').value = p.port; q('security').value = p.security;
      paint();
    });
    q('card-on').addEventListener('click', () => { state.on = true; paint(); });
    q('card-off').addEventListener('click', () => { state.on = false; setStatus(''); paint(); });

    const payload = () => ({
      enabled: state.on, host: val('host').trim(), port: parseInt(val('port'), 10) || 587,
      security: val('security'), username: val('username').trim(),
      password: val('password') === '' ? null : val('password'),
      from_name: val('from_name').trim() || 'ProtectionPro', from_address: val('from_address').trim(),
      app_url: val('app_url').trim(),
    });

    q('test').addEventListener('click', async () => {
      const btn = q('test');
      btn.disabled = true; btn.textContent = 'Testing…';
      setStatus(`Connecting to ${val('host') || 'the server'}:${val('port')}…`);
      try {
        const r = await API.testEmailSettings(payload());
        setStatus(r.message, r.ok ? 'ok' : 'err');
        btn.textContent = r.ok ? 'Send again' : 'Try again';
      } catch (e) {
        setStatus(e.message || 'Test failed', 'err'); btn.textContent = 'Try again';
      }
      btn.disabled = false;
    });

    const ctrl = {
      isOn: () => state.on,
      async load() {
        let c = {};
        try { c = await API.getEmailSettings(); } catch (_) { /* non-admin: no form */ }
        state.on = c.enabled !== undefined ? (c.enabled || !c.host) : true;   // fresh install: offer setup, skipping is one click
        state.hasPassword = !!c.has_password;
        state.provider = '';
        q('host').value = c.host || ''; q('port').value = c.port || 587; q('security').value = c.security || 'starttls';
        q('username').value = c.username || ''; q('password').value = '';
        q('from_name').value = c.from_name || 'ProtectionPro'; q('from_address').value = c.from_address || '';
        q('app_url').value = c.app_url || EmailForm.defaultAppUrl();
        if (c.host && !c.enabled) state.on = false;
        setStatus(opts.adminEmail ? `We’ll send a short message to ${opts.adminEmail} to check the settings.` : '');
        paint();
      },
      /** Save; resolves to the stored view. Throws with a readable message. */
      async save() {
        const cfg = payload();
        if (!state.on) cfg.enabled = false;
        const saved = await API.saveEmailSettings(cfg);
        state.hasPassword = saved.has_password;
        q('password').value = '';
        paint();
        if (opts.onSaved) opts.onSaved(saved);
        return saved;
      },
      summary() { return { on: state.on, host: val('host').trim(), from: val('from_address').trim() }; },
    };

    if (opts.showSave) {
      q('save').addEventListener('click', async () => {
        const s = q('saved'); s.textContent = '';
        try { await ctrl.save(); s.textContent = state.on ? 'Saved.' : 'Saved — email is off.'; s.className = 'ef-status ef-ok'; }
        catch (e) { s.textContent = e.message || 'Could not save'; s.className = 'ef-status ef-err'; }
      });
    }
    return ctrl;
  },
};
