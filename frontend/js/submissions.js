/* ProtectionPro — Company library submissions
 *
 * Users propose entries (cables, breakers, fuses, transformers, load classes, rate prices) for the
 * company library; admins approve, ask for changes or reject — never their own. The company
 * library changes only when an admin approves (backend/routes/library_submissions.py).
 *
 *   Submissions.open()                     full-screen queue (Project → Library Submissions…)
 *   Submissions.pickAndSubmit(libKey)      choose your own entries of one library and submit them
 *   Submissions.submit(entries, note)      the API call (Rates uses it for prices)
 *   Submissions.refreshBadge()             count on the Project menu item
 */

const Submissions = {
  STATUSES: [
    ['pending', 'Waiting for review'],
    ['changes_requested', 'Changes requested'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
  ],
  KIND_LABEL: { cables: 'Cable', transformers: 'Transformer', cbs: 'Circuit breaker', fuses: 'Fuse', loadClasses: 'Load class', rates: 'Rate' },

  view: 'pending',          // admin: a status · 'mine': the caller's own, every status
  _list: [],
  _checked: new Set(),
  _selId: null,
  _detail: null,
  _counts: { waiting: 0, changes_requested: 0 },

  _admin() { return typeof Auth !== 'undefined' && Auth.isAdmin(); },
  _me() { return typeof Auth !== 'undefined' && Auth.user ? Auth.user.id : null; },
  _companyLibrary() {
    const layers = (typeof StandardData !== 'undefined' && StandardData._sharedLayers) || [];
    return layers.find(l => l.is_company_default) || null;
  },

  // ── badge ──
  async refreshBadge() {
    try { this._counts = await API.getSubmissionCounts(); } catch (_) { return; }
    const n = (this._counts.waiting || 0) + (this._counts.changes_requested || 0);
    const b = document.getElementById('submissions-badge');
    if (b) { b.hidden = !n; b.textContent = String(n); }
    if (this._open) this._renderRail();
  },

  // ── submitting ──
  async submit(entries, note) {
    const res = await API.submitToCompany(entries, note);
    UI.toast(`Submitted ${res.length} ${res.length === 1 ? 'entry' : 'entries'} to the company library for approval.`, 'success', 6000);
    this.refreshBadge();
    return res;
  },

  // Your own entries of one library that the company library lacks or has differently.
  _candidates(key) {
    const SD = StandardData, co = this._companyLibrary();
    const have = new Map(((co && co.entries) || []).filter(e => e.kind === key).map(e => [e.id, e]));
    const out = [];
    for (const e of SD[key] || []) {
      if (e._projectOnly || SD.originOf(key, e).origin !== 'own') continue;
      const data = SD._strip(SD._plain(key, e));
      const c = have.get(e.id);
      if (c && SD._same(key, c.data, data)) continue;
      out.push({ key, id: e.id, name: SD._label(e), data, base_version: c ? c.version : undefined, isChange: !!c });
    }
    return out;
  },

  async pickAndSubmit(key) {
    if (!this._companyLibrary()) { UI.alert('There is no company library to submit to yet.'); return; }
    const cands = this._candidates(key);
    if (!cands.length) { UI.alert(`You have no ${StandardData._LIBNAME[key].toLowerCase()} entries of your own to submit — the company library already has them, or you have not added or edited any.`); return; }
    const m = document.createElement('div');
    m.className = 'modal'; m.style.display = 'flex'; m.style.zIndex = '3000';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'sub-pick-title');
    m.innerHTML = `<div class="modal-content" style="max-width:640px;width:92vw;max-height:86vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3 id="sub-pick-title">Submit ${escHtml(StandardData._LIBNAME[key].toLowerCase())} entries to the company library</h3></div>
      <div class="modal-body" style="overflow:auto">
        <p style="margin:0 0 10px">Tick the entries to propose. An admin reviews them; the company library only changes if they approve.</p>
        <div class="sub-pick">${cands.map((c, i) => `<label class="sub-pick-row"><input type="checkbox" data-i="${i}" checked><span><b>${escHtml(c.name)}</b><small>${escHtml(c.id)} · ${c.isChange ? 'a change to the company entry' : 'new'}</small></span></label>`).join('')}</div>
        <label style="display:block;margin-top:12px;font-size:13px">Note for the reviewer (optional)<textarea id="sub-pick-note" rows="3" style="width:100%;box-sizing:border-box;margin-top:4px"></textarea></label>
      </div>
      <div class="ui-dialog-actions" style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-small" data-a="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-a="ok">Submit</button></div></div>`;
    document.body.appendChild(m);
    const chosen = await new Promise(resolve => {
      const done = v => { m.remove(); resolve(v); };
      m.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      m.addEventListener('click', e => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        if (a.dataset.a === 'cancel') return done(null);
        const picked = [...m.querySelectorAll('input[data-i]:checked')].map(x => cands[+x.dataset.i]);
        if (!picked.length) { UI.toast('Tick at least one entry.', 'warning'); return; }
        done({ picked, note: m.querySelector('#sub-pick-note').value });
      });
      setTimeout(() => m.querySelector('input')?.focus(), 30);
    });
    if (!chosen) return;
    try { await this.submit(chosen.picked.map(c => ({ kind: key, data: c.data, base_version: c.base_version })), chosen.note); }
    catch (e) { UI.toast('Could not submit: ' + e.message, 'error', 8000); }
  },

  // ── screen ──
  _open: false,

  async open(opts = {}) {
    this._build();
    this.view = opts.view || (this._admin() ? 'pending' : 'mine');
    this._selId = opts.id || null;
    this._seek = !!opts.id;            // opened on one submission (a notification): find its list
    this._checked = new Set();
    this._open = true;
    const el = document.getElementById('subm-screen');
    el.hidden = false;
    document.body.classList.add('subm-open');
    await this.refreshBadge();
    await this._load();
    el.querySelector('#subm-back').focus();
  },

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('subm-screen').hidden = true;
    document.body.classList.remove('subm-open');
    this.refreshBadge();
  },

  _build() {
    if (document.getElementById('subm-screen')) return;
    const el = document.createElement('div');
    el.id = 'subm-screen';
    el.className = 'subm-screen';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Library submissions');
    el.hidden = true;
    el.innerHTML = `
      <header class="subm-head"><button type="button" id="subm-back" class="subm-back">‹ Back to project</button><h2>Library submissions</h2><span class="subm-sub" id="subm-sub"></span></header>
      <div class="subm-body">
        <nav class="subm-rail" id="subm-rail" aria-label="Submissions"></nav>
        <section class="subm-main"><div id="subm-bulk" class="subm-bulk" hidden></div><div class="subm-tablewrap" id="subm-table"></div></section>
        <aside class="subm-detail" id="subm-detail" aria-live="polite"></aside>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#subm-back').addEventListener('click', () => this.close());
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    el.addEventListener('click', e => this._onClick(e));
    el.addEventListener('change', e => this._onChange(e));
  },

  async _load() {
    try {
      this._list = await API.listSubmissions(this.view === 'mine' ? { mine: true } : { status: this.view });
    } catch (e) { this._list = []; UI.toast('Could not load submissions: ' + e.message, 'error'); }
    this._checked = new Set([...this._checked].filter(id => this._list.some(s => s.id === id)));
    if (this._seek && this._selId && !this._list.some(s => s.id === this._selId)) {
      // A notification may point at one in another list: look it up.
      try { const s = await API.getSubmission(this._selId); this.view = this._admin() && s.submitter_id !== this._me() ? s.status : 'mine'; this._list = await API.listSubmissions(this.view === 'mine' ? { mine: true } : { status: this.view }); } catch (_) { this._selId = null; }
    }
    this._seek = false;
    if (this._selId && !this._list.some(s => s.id === this._selId)) this._selId = null;
    if (!this._selId && this._list.length) this._selId = this._list[0].id;
    this._renderRail(); this._renderTable();
    await this._loadDetail();
  },

  async _loadDetail() {
    this._detail = null;
    if (this._selId) { try { this._detail = await API.getSubmission(this._selId); } catch (_) { this._selId = null; } }
    this._renderDetail();
  },

  _renderRail() {
    const rail = document.getElementById('subm-rail');
    if (!rail) return;
    const item = (v, label, n) => `<button type="button" class="subm-rail-item${this.view === v ? ' on' : ''}" data-view="${v}"${this.view === v ? ' aria-current="page"' : ''}><span>${label}</span>${n ? `<span class="subm-n">${n}</span>` : ''}</button>`;
    let h = '';
    if (this._admin()) {
      h += '<div class="subm-rail-h">Review queue</div>' + this.STATUSES.map(([v, l]) => item(v, l, v === 'pending' ? this._counts.waiting : 0)).join('');
      h += '<div class="subm-rail-h">Mine</div>';
    }
    h += item('mine', 'My submissions', this._counts.changes_requested);
    rail.innerHTML = h;
    document.getElementById('subm-sub').textContent = this._admin() ? `${this._counts.waiting} waiting for review` : (this._counts.changes_requested ? `${this._counts.changes_requested} need your changes` : '');
  },

  _ago(iso) {
    const d = Notifications._date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} days`;
  },
  _pill(status) {
    const t = { pending: ['Waiting', 'amb'], changes_requested: ['Changes requested', 'amb'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'gry'] }[status] || [status, 'gry'];
    return `<span class="subm-pill ${t[1]}">${t[0]}</span>`;
  },

  _renderTable() {
    const host = document.getElementById('subm-table');
    if (!host) return;
    const bulk = this._admin() && this.view === 'pending';
    if (!this._list.length) { host.innerHTML = `<div class="subm-empty">${this.view === 'pending' ? 'Nothing is waiting for review.' : 'Nothing here.'}</div>`; this._renderBulk(); return; }
    host.innerHTML = `<table class="subm-tbl"><thead><tr>${bulk ? '<th class="c-chk"><input type="checkbox" data-all aria-label="Select all"></th>' : ''}<th>Item</th><th>Kind</th><th>Submitted by</th><th>Type</th><th>Age</th>${this.view === 'mine' || !bulk ? '<th>Status</th>' : ''}</tr></thead><tbody>${this._list.map(s => `
      <tr data-id="${s.id}" class="${s.id === this._selId ? 'sel' : ''}">
        ${bulk ? `<td class="c-chk"><input type="checkbox" data-check="${s.id}" ${this._checked.has(s.id) && s.submitter_id !== this._me() ? 'checked' : ''} ${s.submitter_id === this._me() ? 'disabled title="You cannot decide your own submission"' : ''} aria-label="Select ${escHtml(s.label)}"></td>` : ''}
        <td><button type="button" class="subm-link" data-open="${s.id}"><b>${escHtml(s.label)}</b><small>${escHtml(s.entry_id)}</small></button></td>
        <td>${escHtml(this.KIND_LABEL[s.kind] || s.kind)}</td><td>${escHtml(s.submitter)}</td>
        <td>${s.change_type === 'change' ? `Change${s.base_version ? ' to v' + s.base_version : ''}` : 'New'}</td><td>${this._ago(s.created_at)}</td>
        ${this.view === 'mine' || !bulk ? `<td>${this._pill(s.status)}</td>` : ''}</tr>`).join('')}</tbody></table>`;
    this._renderBulk();
  },

  _renderBulk() {
    const b = document.getElementById('subm-bulk');
    if (!b) return;
    const n = this._checked.size;
    b.hidden = !(this._admin() && this.view === 'pending' && n);
    b.innerHTML = n ? `<span><b>${n}</b> selected</span><button type="button" class="btn-primary" data-bulk="approve">Approve ${n}</button><button type="button" class="btn-small" data-bulk="request_changes">Request changes…</button><button type="button" class="btn-small" data-bulk="reject">Reject…</button>` : '';
  },

  _fields(data) {
    const v = x => x === null || x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x);
    return Object.keys(data).filter(k => k !== 'id').slice(0, 60).map(k => [k, v(data[k])]);
  },

  _renderDetail() {
    const host = document.getElementById('subm-detail');
    if (!host) return;
    const s = this._detail;
    if (!s) { host.innerHTML = '<div class="subm-empty">Select a submission to see it here.</div>'; return; }
    const mine = s.submitter_id === this._me(), open = s.status === 'pending' || s.status === 'changes_requested';
    const cur = s.current && s.current.data;
    const v = x => x === null || x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x);
    let table;
    if (cur) {
      const keys = [...new Set([...Object.keys(cur), ...Object.keys(s.data)])].filter(k => k !== 'id');
      const diff = keys.filter(k => JSON.stringify(cur[k]) !== JSON.stringify(s.data[k]));
      table = `<table class="subm-kv"><thead><tr><th>Field</th><th>Company now (v${s.current.version})</th><th>Submitted</th></tr></thead><tbody>${diff.slice(0, 60).map(k => `<tr><td>${escHtml(k)}</td><td>${escHtml(v(cur[k]))}</td><td><b>${escHtml(v(s.data[k]))}</b></td></tr>`).join('') || '<tr><td colspan="3">No differences</td></tr>'}</tbody></table>`;
    } else {
      table = `<table class="subm-kv"><tbody>${this._fields(s.data).map(([k, x]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(x)}</td></tr>`).join('')}</tbody></table>`;
    }
    const stale = s.change_type === 'change' && s.current && s.base_version != null && s.current.version !== s.base_version;
    const gone = s.change_type === 'change' && !s.current;
    const clash = s.change_type === 'new' && s.current;
    let actions = '';
    if (this._admin() && open && !mine) {
      actions = `<label class="subm-note-l">Note to the submitter<textarea id="subm-note" rows="3" placeholder="${s.status === 'pending' ? 'Required to request changes' : ''}"></textarea></label>
        <button type="button" class="btn-primary" data-decide="approve" ${s.status !== 'pending' ? 'disabled' : ''}>Approve and ${s.change_type === 'change' ? 'update' : 'add to'} company</button>
        <div class="subm-two"><button type="button" class="btn-small" data-decide="request_changes" ${s.status !== 'pending' ? 'disabled' : ''}>Request changes</button><button type="button" class="btn-small danger" data-decide="reject">Reject</button></div>
        <div class="subm-hint">Any admin can decide, but not on their own submission. Every decision notifies the submitter.</div>`;
    } else if (this._admin() && open && mine) {
      actions = '<div class="subm-hint">This is your own submission, so another admin has to decide it.</div>';
    }
    if (mine && open) {
      const canRe = s.kind !== 'rates' && StandardData[s.kind] && StandardData[s.kind].some(e => e.id === s.entry_id);
      actions += `<div class="subm-two">${canRe ? '<button type="button" class="btn-small" data-resubmit>Resubmit my current entry</button>' : ''}<button type="button" class="btn-small danger" data-withdraw>Withdraw</button></div>${s.kind === 'rates' ? '<div class="subm-hint">To change a price, update it in the rate library and submit again — it replaces this one.</div>' : ''}`;
    }
    host.innerHTML = `
      <div class="subm-kind">${escHtml(this.KIND_LABEL[s.kind] || s.kind)} · ${s.change_type === 'change' ? 'change' : 'new entry'} ${this._pill(s.status)}</div>
      <h3>${escHtml(s.label)}</h3><div class="subm-id">${escHtml(s.entry_id)} · by ${escHtml(s.submitter)} · ${escHtml(Notifications._date(s.created_at).toLocaleString())}</div>
      ${s.note ? `<div class="subm-quote">“${escHtml(s.note)}”</div>` : ''}
      ${s.decision_note || s.decided_by ? `<div class="subm-decision">${s.decided_by ? escHtml(s.decided_by) + ' — ' : ''}${escHtml(s.status.replace('_', ' '))}${s.decision_note ? ': “' + escHtml(s.decision_note) + '”' : ''}</div>` : ''}
      ${clash ? '<div class="subm-warn">The company library has gained an entry with this id since it was submitted.</div>' : ''}
      ${stale ? `<div class="subm-warn">The company entry has changed since this was submitted (it was based on v${s.base_version}, it is v${s.current.version} now). Approving replaces it.</div>` : ''}
      ${gone ? '<div class="subm-warn">The company entry this changes has been deleted. Approving adds it again.</div>' : ''}
      ${table}
      <div class="subm-actions">${actions}</div>`;
  },

  // ── events ──
  _onChange(e) {
    const all = e.target.closest('[data-all]'), one = e.target.closest('[data-check]');
    if (all) {
      this._checked = new Set(all.checked ? this._list.filter(s => s.submitter_id !== this._me()).map(s => s.id) : []);
      this._renderTable();
    } else if (one) {
      const id = +one.dataset.check;
      one.checked ? this._checked.add(id) : this._checked.delete(id);
      this._renderBulk();
    }
  },

  async _onClick(e) {
    const view = e.target.closest('[data-view]');
    if (view) { this.view = view.dataset.view; this._selId = null; this._checked = new Set(); await this._load(); return; }
    const open = e.target.closest('[data-open]');
    if (open) { this._selId = +open.dataset.open; this._renderTable(); await this._loadDetail(); return; }
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) { await this._decide([...this._checked], bulk.dataset.bulk); return; }
    const dec = e.target.closest('[data-decide]');
    if (dec) { await this._decide([this._selId], dec.dataset.decide, (document.getElementById('subm-note') || {}).value); return; }
    if (e.target.closest('[data-withdraw]')) {
      if (!(await UI.confirm('Withdraw this submission?', { okText: 'Withdraw', danger: true }))) return;
      try { await API.withdrawSubmission(this._selId); this._selId = null; await this.refreshBadge(); await this._load(); } catch (err) { UI.toast(err.message, 'error'); }
      return;
    }
    if (e.target.closest('[data-resubmit]')) {
      const s = this._detail, SD = StandardData, cur = SD[s.kind].find(x => x.id === s.entry_id);
      if (!cur) return;
      try { await API.resubmitSubmission(s.id, SD._strip(SD._plain(s.kind, cur))); UI.toast('Resubmitted for review.', 'success'); await this.refreshBadge(); await this._load(); } catch (err) { UI.toast(err.message, 'error'); }
    }
  },

  async _decide(ids, action, noteArg) {
    ids = ids.filter(Boolean);
    if (!ids.length) return;
    let note = noteArg === undefined ? '' : String(noteArg || '').trim();
    if (action !== 'approve' && noteArg === undefined) {
      const t = await UI.prompt(action === 'reject' ? 'Reason for rejecting (optional):' : 'What needs changing? (required)', '', { title: action === 'reject' ? 'Reject' : 'Request changes', okText: action === 'reject' ? 'Reject' : 'Request changes' });
      if (t === null) return;
      note = String(t).trim();
    }
    if (action === 'request_changes' && !note) { UI.toast('Say what needs changing.', 'warning'); return; }
    try {
      let r = await API.decideSubmissions(ids, action, note, false);
      const conflicts = r.errors.filter(x => x.conflict);
      if (conflicts.length && await UI.confirm(`${conflicts.length} ${conflicts.length === 1 ? 'entry has' : 'entries have'} changed in the company library since being submitted. Approve anyway and replace the company's current version?`, { okText: 'Approve anyway', danger: true })) {
        const r2 = await API.decideSubmissions(conflicts.map(x => x.id), 'approve', note, true);
        r = { done: r.done.concat(r2.done), errors: r.errors.filter(x => !x.conflict).concat(r2.errors) };
      }
      const others = r.errors.filter(x => !x.conflict);
      const verb = { approve: 'Approved', request_changes: 'Asked for changes to', reject: 'Rejected' }[action];
      if (r.done.length) UI.toast(`${verb} ${r.done.length}.`, 'success');
      if (others.length) UI.toast(others.map(x => x.error).slice(0, 2).join('; '), 'warning', 7000);
      if (r.done.length && action === 'approve' && typeof StandardData !== 'undefined') StandardData.reloadShared();
    } catch (err) { UI.toast('Could not record the decision: ' + err.message, 'error', 8000); }
    this._checked = new Set();
    await this.refreshBadge();
    await this._load();
  },
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-submissions')?.addEventListener('click', () => { window.closeAllToolbarMenus?.(); Submissions.open(); });
});
