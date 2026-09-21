/* ProtectionPro — Shared (team) libraries panel (Settings › Shared Libraries)
 *
 * Lists the shared libraries the signed-in user can read (owned, member of, or the admin-designated
 * company standard) and manages them: create, rename, delete, members and roles, leave, the admin's
 * company-standard switch, "edit this library" (StandardData.setEditTarget) and Publish (copy your own
 * entries into a library). The layering and per-entry saves live in standard-data.js.
 */

const SharedLibs = {
  _bound: false,
  _open: {},        // library id → members section expanded
  _members: {},     // library id → [{user_id, email, name, role}] (owner only)

  _ROLE: { owner: 'Owner', edit: 'Can edit', view: 'View only' },

  _counts(L) {
    const n = {};
    for (const e of L.entries) n[e.kind] = (n[e.kind] || 0) + 1;
    const parts = StandardData._LIBKEYS.filter(k => n[k]).map(k => `${n[k]} ${StandardData._LIBNAME[k].toLowerCase()}${n[k] === 1 ? '' : 's'}`);
    return parts.length ? parts.join(' · ') : 'no entries yet';
  },

  render() {
    const box = document.getElementById('shared-libs-panel');
    if (!box) return;
    if (!this._bound) { this._bind(box); this._bound = true; }
    const SD = StandardData;
    if (!SD._serverReady) { box.innerHTML = '<p class="sl-note">Sign in to see the libraries shared with you.</p>'; return; }
    const layers = [...SD._sharedLayers].sort((a, b) => (b.is_company_default ? 1 : 0) - (a.is_company_default ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
    const T = SD._editTarget;
    const me = Auth.currentUserId();
    const admin = Auth.isAdmin();
    let html = `<div class="sl-bar"><button type="button" class="btn-small" data-act="new">+ New shared library</button><button type="button" class="btn-small" data-act="reload" title="Fetch the latest changes made by your team">Reload</button></div>`;
    if (!layers.length) html += '<p class="sl-note">You have no shared libraries yet. Create one to share cables, transformers, breakers, fuses and load classes with your team.</p>';
    for (const L of layers) {
      const canEdit = L.role === 'owner' || L.role === 'edit';
      const editing = T && T.id === L.id;
      const isOwner = L.owner_id === me;
      html += `<div class="sl-card${editing ? ' sl-editing' : ''}" data-id="${L.id}">
        <div class="sl-head"><b>${escHtml(L.name)}</b>
          ${L.is_company_default ? '<span class="lib-badge company">Company standard</span>' : ''}
          <span class="sl-role">${escHtml(this._ROLE[L.role] || L.role)}</span></div>
        <div class="sl-sub">${isOwner ? 'Owned by you' : 'Owner: ' + escHtml(L.owner_email)} · ${escHtml(this._counts(L))}</div>
        <div class="sl-actions">
          ${canEdit ? `<button type="button" class="btn-small${editing ? ' btn-primary' : ''}" data-act="edit">${editing ? 'Editing this library ✓ (stop)' : 'Edit its entries'}</button>
                       <button type="button" class="btn-small" data-act="publish">Publish my entries…</button>
                       <button type="button" class="btn-small" data-act="seed" title="Copy the shipped cables, transformers, breakers, fuses and load classes into this library so they can be edited here">Add default entries</button>` : ''}
          ${isOwner ? '<button type="button" class="btn-small" data-act="rename">Rename</button><button type="button" class="btn-small" data-act="members">Members</button><button type="button" class="btn-small btn-danger-text" data-act="delete">Delete</button>'
                    : (L.is_company_default ? '' : '<button type="button" class="btn-small" data-act="leave">Leave</button>')}
          ${admin ? `<label class="sl-company"><input type="checkbox" data-act="company" ${L.is_company_default ? 'checked' : ''}> Company standard</label>` : ''}
        </div>
        ${isOwner && this._open[L.id] ? this._membersHtml(L) : ''}
      </div>`;
    }
    box.innerHTML = html;
  },

  _membersHtml(L) {
    const ms = this._members[L.id] || [];
    const rows = ms.length ? ms.map(m => `<div class="sl-member" data-uid="${m.user_id}"><span>${escHtml(m.email)}${m.name ? ' <small>' + escHtml(m.name) + '</small>' : ''}</span>
        <select data-act="member-role" aria-label="Role of ${escHtml(m.email)}"><option value="view"${m.role === 'view' ? ' selected' : ''}>View only</option><option value="edit"${m.role === 'edit' ? ' selected' : ''}>Can edit</option></select>
        <button type="button" class="btn-small" data-act="member-remove">Remove</button></div>`).join('')
      : '<div class="sl-note">Only you so far.</div>';
    return `<div class="sl-members">${rows}
      <div class="sl-add"><input type="email" placeholder="Their email (they must already have an account)" data-f="email" aria-label="Email to add">
        <select data-f="role" aria-label="Role"><option value="view">View only</option><option value="edit">Can edit</option></select>
        <button type="button" class="btn-small" data-act="member-add">Add</button></div></div>`;
  },

  _bind(box) {
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && b.tagName !== 'SELECT' && b.type !== 'checkbox') this._act(b, e); });
    box.addEventListener('change', (e) => { const b = e.target.closest('[data-act]'); if (b && (b.tagName === 'SELECT' || b.type === 'checkbox')) this._act(b, e); });
  },

  async _act(el, ev) {
    const card = el.closest('.sl-card');
    const id = card ? parseInt(card.dataset.id) : null;
    const L = id != null ? StandardData._sharedLayers.find(x => x.id === id) : null;
    const act = el.dataset.act;
    const done = async () => { await StandardData.reloadShared(); };
    try {
      if (act === 'new') {
        const r = await this._newDialog();
        if (r) {
          const lib = await API.createSharedLibrary(r.name);
          if (r.seed) await this._seedDefaults(lib.id);
          await done();
        }
      } else if (act === 'reload') { await done(); UI.toast('Shared libraries reloaded.', 'info', 2500); }
      else if (act === 'edit') { await StandardData.setEditTarget(StandardData._editTarget && StandardData._editTarget.id === id ? null : id); }
      else if (act === 'publish') await this._publish(L);
      else if (act === 'seed') {
        if (await UI.confirm(`Add the shipped default entries to “${L.name}”?\nEntries that already exist there are left as they are. Copies override the shipped ones for everyone who uses this library, so later corrections to the shipped values will not reach them.`, { okText: 'Add defaults' })) {
          const n = await this._seedDefaults(L.id); await done();
          UI.toast(`Added ${n} default entries.`, 'success', 4000);
        }
      }
      else if (act === 'rename') {
        const name = await UI.prompt('Rename shared library', L.name);
        if (name && name.trim() && name.trim() !== L.name) { await API.renameSharedLibrary(id, name.trim()); await done(); }
      } else if (act === 'delete') {
        if (await UI.confirm(`Delete the shared library “${L.name}”?\nIts entries disappear for everyone who uses it. Projects that use them keep a copy and will ask what to do when opened.`, { danger: true, okText: 'Delete' })) { await API.deleteSharedLibrary(id); await done(); }
      } else if (act === 'leave') {
        if (await UI.confirm(`Leave “${L.name}”?\nYou will stop seeing its entries.`, { okText: 'Leave' })) { await API.removeLibraryMember(id, Auth.currentUserId()); await done(); }
      } else if (act === 'company') {
        await API.setCompanyLibrary(id, el.checked); await done();
      } else if (act === 'members') {
        this._open[id] = !this._open[id];
        if (this._open[id]) this._members[id] = await API.getLibraryMembers(id);
        this.render();
      } else if (act === 'member-add') {
        const email = card.querySelector('[data-f="email"]').value.trim();
        if (!email) return;
        this._members[id] = await API.addLibraryMember(id, email, card.querySelector('[data-f="role"]').value);
        this.render();
      } else if (act === 'member-role') {
        const uid = parseInt(el.closest('.sl-member').dataset.uid);
        this._members[id] = await API.setLibraryMemberRole(id, uid, el.value);
        this.render();
      } else if (act === 'member-remove') {
        const uid = parseInt(el.closest('.sl-member').dataset.uid);
        await API.removeLibraryMember(id, uid);
        this._members[id] = await API.getLibraryMembers(id);
        this.render();
      }
    } catch (e) {
      UI.toast(e.message || String(e), 'error', 6000);
      StandardData.reloadShared().catch(() => {});      // show what the server really holds
    }
  },

  // Name + "start with the shipped defaults" (on by default).
  _newDialog() {
    return new Promise(resolve => {
      const SD = StandardData;
      const n = SD._LIBKEYS.reduce((a, k) => a + SD._defaults[k].length, 0);
      const m = document.createElement('div');
      m.className = 'modal'; m.id = 'sl-new-modal'; m.style.display = 'flex'; m.style.zIndex = '3000';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      m.innerHTML = `<div class="modal-content" style="max-width:520px;width:92vw">
        <div class="modal-header"><h3>New shared library</h3></div>
        <div class="modal-body">
          <label class="sl-field">Name<input type="text" data-f="name" placeholder="e.g. Company standard" maxlength="255"></label>
          <label class="sl-pick"><input type="checkbox" data-f="seed" checked> <span style="min-width:0">Start with the ${n} shipped default entries (cables, transformers, breakers, fuses, load classes)</span></label>
          <p class="sl-note" style="margin:6px 0 0">Copies can be edited by the team here. They override the shipped ones for everyone who uses this library, so later corrections to the shipped values will not reach them. Untick to start empty and add only your own entries.</p>
        </div>
        <div class="ui-dialog-actions" style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn-small" data-a="cancel">Cancel</button><button type="button" class="btn-primary" data-a="ok">Create</button></div></div>`;
      document.body.appendChild(m);
      const end = v => { m.remove(); resolve(v); };
      const ok = () => { const name = m.querySelector('[data-f="name"]').value.trim(); if (name) end({ name, seed: m.querySelector('[data-f="seed"]').checked }); else m.querySelector('[data-f="name"]').focus(); };
      m.addEventListener('click', ev => { const a = ev.target.closest('[data-a]'); if (!a) return; if (a.dataset.a === 'cancel') end(null); else ok(); });
      m.addEventListener('keydown', ev => { if (ev.key === 'Escape') end(null); else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type === 'text') ok(); });
      m.querySelector('[data-f="name"]').focus();
    });
  },

  // Copy the shipped entries into a library (create-only: ids already there are skipped).
  async _seedDefaults(libraryId) {
    const SD = StandardData;
    const entries = [];
    for (const key of SD._LIBKEYS) for (const e of SD._defaults[key]) entries.push({ kind: key, data: SD._strip(SD._plain(key, e)) });
    const r = await API.importSharedEntries(libraryId, entries);
    return r.created.length;
  },

  // Copy your own new entries into a library you can edit (create-only: existing ids are skipped).
  async _publish(L) {
    const SD = StandardData;
    const mine = [];
    for (const key of SD._LIBKEYS) {
      for (const e of SD._persistable(key)) {
        if (SD.originOf(key, e).origin === 'own' && !SD._base[key].some(b => b.id === e.id)) mine.push({ key, e });
      }
    }
    if (!mine.length) { UI.alert('You have no entries of your own to publish. Add entries in one of the library tabs first (with “My library” as the edit target).'); return; }
    const choice = await new Promise(resolve => {
      const m = document.createElement('div');
      m.className = 'modal'; m.id = 'sl-publish-modal'; m.style.display = 'flex'; m.style.zIndex = '3000';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      m.innerHTML = `<div class="modal-content" style="max-width:640px;width:92vw;max-height:86vh;display:flex;flex-direction:column">
        <div class="modal-header"><h3>Publish to “${escHtml(L.name)}”</h3></div>
        <div class="modal-body" style="overflow:auto"><p style="margin:0 0 10px">These are your own entries. Publishing copies them into the shared library for everyone who uses it; entries with an id that already exists there are skipped.</p>
          ${mine.map((x, i) => `<label class="sl-pick"><input type="checkbox" data-i="${i}" checked> <span>${SD._LIBNAME[x.key]}</span> <b>${escHtml(SD._label(x.e))}</b></label>`).join('')}</div>
        <div class="ui-dialog-actions" style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn-small" data-a="cancel">Cancel</button><button type="button" class="btn-primary" data-a="ok">Publish selected</button></div></div>`;
      document.body.appendChild(m);
      const end = v => { m.remove(); resolve(v); };
      m.addEventListener('click', ev => {
        const a = ev.target.closest('[data-a]'); if (!a) return;
        if (a.dataset.a === 'cancel') return end(null);
        end([...m.querySelectorAll('input[data-i]:checked')].map(c => mine[parseInt(c.dataset.i)]));
      });
      m.addEventListener('keydown', ev => { if (ev.key === 'Escape') end(null); });
      m.querySelector('[data-a="ok"]').focus();
    });
    if (!choice || !choice.length) return;
    const r = await API.importSharedEntries(L.id, choice.map(x => ({ kind: x.key, data: SD._strip(x.e) })));
    UI.toast(`Published ${r.created.length}${r.skipped.length ? `, skipped ${r.skipped.length} that already exist` : ''}.`, 'success', 5000);
    await StandardData.reloadShared();
  },
};
