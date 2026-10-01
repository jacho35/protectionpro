/* ProtectionPro — Project Sharing (owner grants view/edit by email) */

const Sharing = {
  _projectId: null,

  init() {
    document.getElementById('btn-close-share')?.addEventListener('click', () => this.close());
    document.getElementById('share-modal')?.addEventListener('click', e => {
      if (e.target.id === 'share-modal') this.close();
    });
    document.getElementById('share-add-btn')?.addEventListener('click', () => this._add());
    const input = document.getElementById('share-email');
    input?.addEventListener('input', () => this._suggest());
    input?.addEventListener('keydown', e => {
      const items = [...document.querySelectorAll('#share-suggest li[data-email]')];
      const cur = items.findIndex(li => li.classList.contains('active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        const n = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('active', i === n));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (cur >= 0) this._pick(items[cur].dataset.email); else this._add();
      } else if (e.key === 'Escape') {
        this._hideSuggest();
      }
    });
    input?.addEventListener('blur', () => setTimeout(() => this._hideSuggest(), 150));
  },

  _hideSuggest() {
    const ul = document.getElementById('share-suggest');
    if (ul) ul.style.display = 'none';
    document.getElementById('share-email')?.setAttribute('aria-expanded', 'false');
  },

  _pick(email) {
    document.getElementById('share-email').value = email;
    this._hideSuggest();
    document.getElementById('share-role')?.focus();
  },

  _suggest() {
    clearTimeout(this._t);
    const q = document.getElementById('share-email').value.trim();
    if (!q) { this._hideSuggest(); return; }
    this._t = setTimeout(async () => {
      try {
        const users = await API.searchUsers(q);
        if (document.getElementById('share-email').value.trim() !== q) return;
        const ul = document.getElementById('share-suggest');
        ul.innerHTML = users.length
          ? users.map(u => `<li role="option" data-email="${this._esc(u.email)}"><span>${this._esc(u.name || u.email)}</span>${u.name ? `<small>${this._esc(u.email)}</small>` : ''}</li>`).join('')
          : '<li class="empty">No registered user matches. They need an account first.</li>';
        ul.querySelectorAll('li[data-email]').forEach(li =>
          li.addEventListener('mousedown', e => { e.preventDefault(); this._pick(li.dataset.email); }));
        ul.style.display = '';
        document.getElementById('share-email').setAttribute('aria-expanded', 'true');
      } catch (e) { this._hideSuggest(); }
    }, 150);
  },

  async open(projectId, projectName) {
    this._projectId = projectId;
    const title = document.getElementById('share-modal-title');
    if (title) title.textContent = `Share "${projectName || 'Project'}"`;
    document.getElementById('share-error').textContent = '';
    document.getElementById('share-email').value = '';
    document.getElementById('share-modal').style.display = '';
    await this._render();
  },

  close() {
    const m = document.getElementById('share-modal');
    if (m) m.style.display = 'none';
    this._projectId = null;
  },

  async _render(shares) {
    const list = document.getElementById('share-list');
    if (!list) return;
    try {
      const rows = shares || await API.listShares(this._projectId);
      if (!rows.length) {
        list.innerHTML = '<p class="auth-hint">Not shared with anyone yet.</p>';
        return;
      }
      list.innerHTML = rows.map(s => `
        <div class="share-row" data-uid="${s.user_id}">
          <span class="share-user">${this._esc(s.name || s.email)}<small>${this._esc(s.email)}</small></span>
          <select class="share-role-select" data-uid="${s.user_id}">
            <option value="view"${s.role === 'view' ? ' selected' : ''}>View</option>
            <option value="edit"${s.role === 'edit' ? ' selected' : ''}>Edit</option>
          </select>
          <button class="btn-small share-remove" data-uid="${s.user_id}">Remove</button>
        </div>`).join('');
      list.querySelectorAll('.share-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          try {
            const updated = await API.updateShare(this._projectId, parseInt(sel.dataset.uid, 10), sel.value);
            UI.toast && UI.toast('Access updated', 'success');
            this._render(updated);
          } catch (e) { this._err(e); }
        });
      });
      list.querySelectorAll('.share-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const updated = await API.unshareProject(this._projectId, parseInt(btn.dataset.uid, 10));
            this._render(updated);
          } catch (e) { this._err(e); }
        });
      });
    } catch (e) {
      this._err(e);
    }
  },

  async _add() {
    const emailEl = document.getElementById('share-email');
    const roleEl = document.getElementById('share-role');
    const email = emailEl.value.trim();
    document.getElementById('share-error').textContent = '';
    if (!email) { this._err({ message: 'Enter a collaborator email.' }); return; }
    try {
      const updated = await API.shareProject(this._projectId, email, roleEl.value);
      emailEl.value = '';
      this._render(updated);
      UI.toast && UI.toast(`Shared with ${email}`, 'success');
    } catch (e) {
      this._err(e);
    }
  },

  _err(e) {
    const el = document.getElementById('share-error');
    if (el) el.textContent = (e && e.message) || 'Something went wrong';
  },

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
