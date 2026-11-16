/* ProtectionPro — Fixes: a proposed fix on an issue, and Fix all with review.
 *
 * The server (backend/analysis/fixes.py) works the fixes out and proves them by re-running the checks on a
 * copy; nothing here changes the project until Apply. A value typed by hand (a way's `cable_locked`) is never
 * in the automatic set: Fix all lists it under "Needs your approval", unticked, and it changes only when ticked.
 *
 *   Fixes.openOne(key)   — one issue: the change, before / after, Apply (one undo step)
 *   Fixes.openAll()      — every fixable issue, grouped by board, review, Apply the ticked changes
 *   Fixes.payload(list)  — the issues the server understands (pure, node-testable)
 *   Fixes.apply(fixes)   — write the changes of already-checked fixes (pure over a components Map)
 */

const Fixes = {
  FIELD_LABEL: { cable_mm2: 'Cable', ecc_mm2: 'Earth conductor' },

  // ── Pure ──────────────────────────────────────────────────────────────
  // The issues the server can fix: a circuit-check way that fails.
  fixable(list) { return (list || []).filter(i => i.fix && i.sev === 'fail'); },
  payload(list) {
    return this.fixable(list).map(i => ({ key: i.key, kind: i.fix.kind, board_id: i.fix.board_id, way_id: i.fix.way_id }));
  },
  count() { return typeof Issues === 'undefined' ? 0 : this.fixable(Issues.list()).length; },

  // Write the changes of fixes the server has checked. Returns how many values changed.
  apply(fixes, components = AppState.components) {
    let n = 0;
    for (const f of fixes || []) {
      for (const ch of f.changes || []) {
        const t = ch.target || {};
        if (t.kind !== 'db_way') continue;
        const comp = components.get(t.board_id);
        const way = comp && (comp.props.circuits || []).find(w => w.id === t.way_id);
        if (!way) continue;
        way[ch.field] = ch.to;
        n++;
        if (ch.field === 'cable_mm2') {
          if (f.governed_by) way.cable_by = f.governed_by;
          delete way.cable_locked;       // only reached for a hand-typed value the user approved
        }
      }
    }
    return n;
  },

  groupByBoard(fixes, nameOf = (id) => id) {
    const g = new Map();
    for (const f of fixes) {
      const k = f.board_id || 'other';
      if (!g.has(k)) g.set(k, { id: k, name: nameOf(k), fixes: [] });
      g.get(k).fixes.push(f);
    }
    return [...g.values()];
  },

  // ── Server ────────────────────────────────────────────────────────────
  _list() { return typeof Issues === 'undefined' ? [] : Issues.list(); },
  async _propose(keys) {
    const list = this.fixable(this._list()).filter(i => !keys || keys.includes(i.key));
    return API.proposeFixes(this.payload(list));
  },

  // ── Dialogs ───────────────────────────────────────────────────────────
  _modal(title, html) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', title);
    m.style.display = 'flex'; m.style.zIndex = '3000';
    m.innerHTML = `<div class="modal-content modal-wide fx" style="max-height:90vh;display:flex;flex-direction:column">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-fx="cancel"]')) m.remove(); });
    m.addEventListener('keydown', e => { if (e.key === 'Escape') m.remove(); });
    return m;
  },
  _after(label) {
    AppState.dirty = true;
    if (typeof AppState.invalidateResults === 'function') AppState.invalidateResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot(label);
    if (typeof DBSchedule !== 'undefined' && DBSchedule.body) DBSchedule.render();
    if (typeof Schedules !== 'undefined' && Schedules.runCheck) Schedules.runCheck(true);
    if (typeof Issues !== 'undefined') Issues.kick();
  },
  _val(ch) {
    const u = ch.field === 'cable_mm2' || ch.field === 'ecc_mm2' ? ' mm²' : '';
    return `${ch.from == null ? '—' : escHtml(String(ch.from) + u)} → <b>${escHtml(String(ch.to) + u)}</b>`;
  },
  _status(s) {
    const bad = (s && s.failing || []).map(k => ({ coordination_status: 'Iz', vd_status: 'volt drop', ecc_status: 'ECC', zs_status: 'Zs', ampacity_status: 'Iz' }[k] || k));
    return bad.length ? `<span class="fx-bad">fails ${escHtml(bad.join(', '))}</span>` : '<span class="fx-ok">passes</span>';
  },

  async openOne(key) {
    const m = this._modal('Proposed fix', `<div class="modal-header"><h3>Proposed fix</h3>
      <button class="modal-close" data-fx="cancel" aria-label="Close">&times;</button></div>
      <div class="fx-body" id="fx-body">Working it out…</div>`);
    let res;
    try { res = await this._propose([key]); } catch (e) { m.querySelector('#fx-body').textContent = `Could not work out a fix: ${e.message}`; return; }
    const f = (res.fixes || [])[0];
    const body = m.querySelector('#fx-body');
    if (!f || !f.fix) {
      body.innerHTML = `<p>${escHtml((f && f.reason) || 'No fix is available for this issue.')}</p>
        <div class="fx-foot"><button class="btn-small" data-fx="cancel">Close</button></div>`;
      return;
    }
    const rows = f.changes.map(ch => `<tr><td>${escHtml(ch.label || this.FIELD_LABEL[ch.field] || ch.field)}</td><td>${this._val(ch)}</td></tr>`).join('');
    body.innerHTML = `
      <table class="fx-table"><tbody>${rows}</tbody></table>
      <div class="fx-ba"><div><small>Now</small>${this._status(f.before)}</div><div><small>After the fix</small>${this._status(f.after)}</div></div>
      ${f.manual ? '<p class="fx-manual">This changes a cable you typed by hand. It only changes if you press the button below.</p>'
        : '<p class="fx-auto">Automatic value: the cable was sized by Size cables, not typed.</p>'}
      <div class="fx-foot"><span>One undo step.</span>
        <button class="btn-small" data-fx="cancel">Cancel</button>
        <button class="btn-small btn-primary" data-fx="apply">${f.manual ? 'Change my value' : 'Apply'}</button></div>`;
    body.querySelector('[data-fx="apply"]').addEventListener('click', () => {
      this.apply([f]);
      this._after('Apply fix');
      m.remove();
    });
  },

  async openAll(approved = []) {
    const m = this._modal('Fix all', `<div class="modal-header"><h3>Fix all · review the changes</h3>
      <button class="modal-close" data-fx="cancel" aria-label="Close">&times;</button></div>
      <div class="fx-body" id="fx-body">Working it out…</div>`);
    const body = m.querySelector('#fx-body');
    const run = async (appr) => {
      let r;
      try {
        const list = this.fixable(this._list());
        r = await API.fixAll(this.payload(list), appr);
      } catch (e) { body.textContent = `Could not work out the fixes: ${e.message}`; return; }
      this._renderAll(m, r, appr, run);
    };
    run(approved);
  },

  _renderAll(m, r, approved, rerun) {
    const body = m.querySelector('#fx-body');
    const s = r.summary || {};
    const nameOf = (id) => { const c = AppState.components.get(id); return (c && c.props && c.props.name) || id; };
    const row = (f, manual) => f.changes.map(ch => `<label class="fx-row"><input type="checkbox" data-fx-key="${escHtml(f.issue_key)}"${manual ? (approved.includes(f.issue_key) ? ' checked' : '') : ' checked'}>
      <span>${escHtml(ch.label || ch.field)} <small>${this._val(ch)}</small></span>
      <em>${f.clears ? 'clears the check' : ''}</em></label>`).join('');
    const section = (title, fixes, manual) => fixes.length ? `<section class="fx-sec${manual ? ' fx-sec-manual' : ''}"><h4>${title}</h4>
      ${this.groupByBoard(fixes, nameOf).map(g => `<div class="fx-grp"><b>${escHtml(g.name)}</b>${g.fixes.map(f => row(f, manual)).join('')}</div>`).join('')}</section>` : '';
    body.innerHTML = `
      <div class="fx-tiles">
        <div><b>${s.cleared || 0} of ${s.issues || 0} issues clear</b><small>with the ticked changes</small></div>
        <div><b>${(s.automatic || 0) + (s.needs_approval || 0)} changes</b><small>${s.automatic || 0} automatic · ${s.needs_approval || 0} need your approval</small></div>
        <div><b>${s.new_failures ? s.new_failures + ' new failures' : 'No new failures'}</b><small>checked together on a copy first</small></div>
      </div>
      ${section('Automatic values', r.automatic, false)}
      ${section('Needs your approval · values you entered by hand', r.needs_approval, true)}
      ${r.not_fixed.length ? `<section class="fx-sec"><h4>Not fixed</h4>${r.not_fixed.map(n => `<div class="fx-row"><span>${escHtml(n.issue_key)}</span><em>${escHtml(n.reason)}</em></div>`).join('')}</section>` : ''}
      ${!r.automatic.length && !r.needs_approval.length ? '<p>No fixes are available.</p>' : ''}
      <div class="fx-foot"><span>One undo step. The circuit check re-runs afterwards.</span>
        <button class="btn-small" data-fx="cancel">Cancel</button>
        <button class="btn-small btn-primary" data-fx="apply" disabled>Apply</button></div>`;
    const apply = body.querySelector('[data-fx="apply"]');
    const picked = () => new Set([...body.querySelectorAll('[data-fx-key]:checked')].map(x => x.dataset.fxKey));
    const sync = () => {
      const n = picked().size;
      apply.disabled = !n;
      apply.textContent = n ? `Apply ${n} fix${n === 1 ? '' : 'es'}` : 'Apply';
    };
    body.querySelectorAll('[data-fx-key]').forEach(cb => cb.addEventListener('change', () => {
      // a hand-entered value was ticked: ask the server to prove the set with it included
      const manualKeys = new Set(r.needs_approval.map(f => f.issue_key).concat(approved));
      const next = [...picked()].filter(k => manualKeys.has(k));
      if (cb.closest('.fx-sec-manual') || approved.includes(cb.dataset.fxKey)) { rerun(next); return; }
      sync();
    }));
    apply.addEventListener('click', () => {
      const keys = picked();
      const all = r.automatic.concat(r.needs_approval.filter(f => approved.includes(f.issue_key)));
      const n = this.apply(all.filter(f => keys.has(f.issue_key)));
      this._after('Fix all');
      m.remove();
      if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Changed ${n} value${n === 1 ? '' : 's'}.`, 'info');
    });
    sync();
  },
};

if (typeof module !== 'undefined') module.exports = Fixes;
