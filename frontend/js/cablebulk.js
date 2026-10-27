/**
 * CableBulk — apply one cable (type + size + installation) or one breaker type
 * to several SLD elements at once.
 *
 *   • selection bar   — floats over the canvas when two or more cables or
 *                       breakers are selected (Canvas.render → updateBar)
 *   • openCables(id)  — copy a cable's library entry and/or its IEC 60364-5-52
 *                       installation conditions onto other underground cables,
 *                       each row showing the installed rating before and after
 *   • openBreakers(ids) — pick a library breaker (wildcard filter) for the
 *                       selected breakers; duty-check fault level shown when run
 *
 * The per-cable maths is Properties' (`_ampCompute` / `_writeAmpacity`); nothing
 * here duplicates it.
 */

const CableBulk = {
  _el: null,
  _bar: null,
  _onKey: null,

  // ── helpers ──────────────────────────────────────────────────────────────
  _comp(id) { return AppState.components.get(id) || null; },
  _isCable(c) { return !!c && c.type === 'cable' && c.props.construction !== 'overhead'; },
  _isCb(c) { return !!c && c.type === 'cb'; },
  _name(c) { return (c.props && c.props.name) || c.id; },
  _entry(c) { return c && c.props.standard_type ? CableLib.byId(c.props.standard_type) : null; },
  _isMV(c) { const e = this._entry(c); return e ? CableLib.isMV(e) : Number(c.props.voltage_kv) > 1; },

  // Space-separated words must all match; * stands for any text
  match(text, q) {
    const hay = String(text).toLowerCase();
    return String(q).toLowerCase().split(/\s+/).filter(Boolean).every(w => {
      const re = new RegExp(w.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
      return re.test(hay);
    });
  },

  selected() {
    const comps = [...AppState.selectedIds].map(id => this._comp(id)).filter(Boolean);
    return { cables: comps.filter(c => this._isCable(c)), cbs: comps.filter(c => this._isCb(c)) };
  },

  // ── selection bar ────────────────────────────────────────────────────────
  updateBar() {
    const { cables, cbs } = this.selected();
    const show = cables.length >= 2 || cbs.length >= 2;
    if (!show) {
      if (this._bar) this._bar.style.display = 'none';
      return;
    }
    if (!this._bar) {
      this._bar = document.createElement('div');
      this._bar.id = 'cbk-bar';
      this._bar.className = 'cbk-bar';
      this._bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const sel = this.selected();
        if (b.dataset.act === 'cable') {
          const src = sel.cables.find(c => c.id === Properties.currentId) || sel.cables[0];
          this.openCables(src.id, sel.cables.filter(c => c !== src).map(c => c.id));
        } else if (b.dataset.act === 'cb') {
          this.openBreakers(sel.cbs.map(c => c.id));
        } else if (b.dataset.act === 'clear') {
          AppState.clearSelection();
          Canvas.render();
          Properties.clear();
        }
      });
      document.body.appendChild(this._bar);
    }
    const parts = [];
    if (cables.length) parts.push(`${cables.length} cable${cables.length === 1 ? '' : 's'}`);
    if (cbs.length) parts.push(`${cbs.length} breaker${cbs.length === 1 ? '' : 's'}`);
    const src = cables.find(c => c.id === Properties.currentId) || cables[0];
    this._bar.innerHTML =
      `<strong>${parts.join(' and ')} selected</strong>` +
      (cables.length >= 2 ? `<button type="button" data-act="cable" title="Copy ${escHtml(this._name(src))}'s cable and installation onto the other selected cables">Apply ${escHtml(this._name(src))} to ${cables.length - 1} other${cables.length === 2 ? '' : 's'}…</button>` : '') +
      (cbs.length >= 2 ? `<button type="button" data-act="cb">Set breaker type…</button>` : '') +
      `<button type="button" data-act="clear" class="cbk-bar-clear">Clear</button>`;
    this._bar.style.display = '';
  },

  // ── dialog shell ─────────────────────────────────────────────────────────
  _open(title, subtitle, bodyHtml, footerHtml) {
    this.close();
    const el = document.createElement('div');
    el.className = 'modal cbk-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title);
    el.innerHTML = `
      <div class="modal-content cbk-dialog">
        <div class="modal-header"><h3>${escHtml(title)}</h3><button class="modal-close" type="button" aria-label="Close">&times;</button></div>
        <div class="cbk-sub">${subtitle}</div>
        <div class="modal-body cbk-body">${bodyHtml}</div>
        <div class="cbk-foot">${footerHtml}</div>
      </div>`;
    el.addEventListener('mousedown', (e) => { if (e.target === el) this.close(); });
    el.querySelector('.modal-close').addEventListener('click', () => this.close());
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._onKey);
    document.body.appendChild(el);
    this._el = el;
    return el;
  },

  close() {
    if (this._el) { this._el.remove(); this._el = null; }
    if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
  },

  _finish(msg) {
    AppState.dirty = true;
    Properties._notifyResultsCleared();
    AppState.clearResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    Canvas.render();
    if (Properties.currentId) Properties.show(Properties.currentId);
    const st = document.getElementById('status-info');
    if (st && msg) st.textContent = msg;
    this.close();
  },

  // ── cables ───────────────────────────────────────────────────────────────
  // What `target` would become: its library entry, installation block, Iz.
  _plan(src, target, copyCable, copyInst) {
    const entry = copyCable ? this._entry(src) : this._entry(target);
    const basics = Properties._resolveCableBasics(target);
    if (entry) {
      basics.conductor = String(entry.conductor || 'Cu').toLowerCase() === 'al' ? 'al' : 'cu';
      basics.insulation = String(entry.insulation || 'XLPE').toUpperCase() === 'PVC' ? 'pvc' : 'xlpe';
      if (entry.size_mm2) basics.size = entry.size_mm2;
      basics.loaded = Number(entry.cores) === 2 ? 2 : 3;
    }
    const sa = src.props.ampacity && src.props.ampacity.applied ? src.props.ampacity : null;
    const ta = target.props.ampacity && target.props.ampacity.applied ? target.props.ampacity : null;
    const condFrom = copyInst && sa ? sa : ta;
    let s = null;
    if (condFrom) {
      s = Properties._ampCompute({
        conductor: basics.conductor, insulation: basics.insulation, size: basics.size,
        loaded: basics.loaded,
        method: condFrom.method, ambient: condFrom.ambient_c, circuits: condFrom.circuits,
        grouping: IecAmpacity.LEGACY[condFrom.grouping] || condFrom.grouping || 'bunched',
        soil: condFrom.soil_kmw != null ? condFrom.soil_kmw : 2.5,
        current: target.props.ampacity && target.props.ampacity.design_current_a != null
          ? target.props.ampacity.design_current_a : (parseFloat(target.props.standalone_current_a) || null),
      });
    }
    const iz = s && s.baseA != null ? s.baseA * s.derating : (entry ? entry.rated_amps : Number(target.props.rated_amps));
    return { entry, s, iz };
  },

  openCables(srcId, preselect = []) {
    const src = this._comp(srcId);
    if (!this._isCable(src)) return;
    const srcEntry = this._entry(src);
    const srcAmp = src.props.ampacity && src.props.ampacity.applied ? src.props.ampacity : null;
    const mv = this._isMV(src);
    const targets = [...AppState.components.values()]
      .filter(c => this._isCable(c) && c.id !== src.id && this._isMV(c) === mv);
    const pre = new Set(preselect);
    const state = { copyCable: !!srcEntry, copyInst: !!srcAmp, sel: new Set(preselect.filter(id => targets.some(t => t.id === id))) };

    const sub = `Source: <strong>${escHtml(this._name(src))}</strong> · ${srcEntry ? escHtml(CableLib.label(srcEntry)) : 'custom cable'}` +
      (srcAmp ? ` · method ${escHtml(srcAmp.method)} · ${escHtml(String(srcAmp.ambient_c))} °C · ${escHtml(String(srcAmp.circuits))} circuit${Number(srcAmp.circuits) === 1 ? '' : 's'} · factor ${Number(srcAmp.derating).toFixed(2)}` : ' · no installation derating set');
    const el = this._open('Apply cable to other cables', sub, `
      <div class="cbk-row">
        <strong>Copy</strong>
        <label class="cbk-check"><input type="checkbox" id="bk-cable" ${state.copyCable ? 'checked' : 'disabled'}> Cable type and size${srcEntry ? '' : ' (source is a custom cable)'}</label>
        <label class="cbk-check"><input type="checkbox" id="bk-inst" ${state.copyInst ? 'checked' : 'disabled'}> Installation conditions${srcAmp ? '' : ' (source has none)'}</label>
      </div>
      <div class="cbk-row">
        <strong>Cables</strong>
        <button type="button" class="btn btn-small" data-pick="all">All</button>
        <button type="button" class="btn btn-small" data-pick="none">None</button>
        <button type="button" class="btn btn-small" data-pick="same">Same size as source</button>
        <input type="search" id="bk-filter" class="cbk-filter" placeholder="Filter, e.g. pump* or *70" autocomplete="off" aria-label="Filter cables">
      </div>
      <div class="cbk-table-wrap"><table class="cbk-table"><thead><tr><th></th><th>Cable</th><th>Route</th><th>Now</th><th>After</th></tr></thead><tbody id="bk-rows"></tbody></table></div>
      ${targets.length ? '' : `<p class="cbk-empty">There are no other ${mv ? 'MV' : 'LV'} underground cables in the project.</p>`}`,
      `<span id="bk-warn" class="cbk-warn"></span><span class="cbk-foot-btns"><button type="button" class="btn" id="bk-cancel">Cancel</button><button type="button" class="btn btn-primary" id="bk-apply">Apply</button></span>`);

    const routeOf = (c) => {
      const { fromBus, toBus } = Components.cableEndpointBuses(c.id);
      const n = b => b ? this._name(b) : '—';
      return `${n(fromBus)} → ${n(toBus)}`;
    };
    const rowsEl = el.querySelector('#bk-rows');
    const warnEl = el.querySelector('#bk-warn');
    const applyBtn = el.querySelector('#bk-apply');
    const sizeOf = (c) => { const e = this._entry(c); return e ? e.size_mm2 : null; };

    const render = () => {
      const q = el.querySelector('#bk-filter').value;
      let n = 0, bad = 0;
      const list = targets.filter(t => !q || state.sel.has(t.id) || this.match(`${this._name(t)} ${routeOf(t)}`, q));
      rowsEl.innerHTML = list.map(t => {
        const on = state.sel.has(t.id);
        const now = this._entry(t);
        let after = 'unchanged', cls = '';
        if (on) {
          n++;
          const p = this._plan(src, t, state.copyCable, state.copyInst);
          const ib = (t.props.ampacity && t.props.ampacity.design_current_a != null ? t.props.ampacity.design_current_a : parseFloat(t.props.standalone_current_a)) || 0;
          const low = ib > 0 && p.iz < ib;
          if (low) { bad++; cls = ' class="cbk-bad"'; }
          const cab = p.entry ? CableLib.label(p.entry) : (now ? CableLib.label(now) : 'custom');
          after = `${escHtml(cab)}<br>Iz ${Math.round(p.iz)} A${ib > 0 ? ` (design ${Math.round(ib)} A) ${low ? '✕ too small' : '✓'}` : ''}`;
        }
        return `<tr${on ? (cls || ' class="cbk-on"') : ''}><td><input type="checkbox" data-id="${escHtml(t.id)}" aria-label="Select ${escHtml(this._name(t))}" ${on ? 'checked' : ''}></td>` +
          `<td>${escHtml(this._name(t))}</td><td>${escHtml(routeOf(t))}</td>` +
          `<td>${escHtml(now ? CableLib.label(now) : 'custom')}<br>Iz ${Math.round(Number(t.props.rated_amps) || 0)} A</td><td>${after}</td></tr>`;
      }).join('');
      applyBtn.textContent = n ? `Apply to ${n} cable${n === 1 ? '' : 's'}` : 'Apply';
      applyBtn.disabled = !n || (!state.copyCable && !state.copyInst);
      warnEl.textContent = !n ? 'Select at least one cable.' : bad ? `${bad} cable${bad === 1 ? '' : 's'} would be below design current. You can still apply.` : '';
      warnEl.className = 'cbk-warn' + (bad ? ' cbk-warn-on' : '');
    };

    el.addEventListener('change', (e) => {
      if (e.target.id === 'bk-cable') state.copyCable = e.target.checked;
      else if (e.target.id === 'bk-inst') state.copyInst = e.target.checked;
      else if (e.target.dataset.id) { e.target.checked ? state.sel.add(e.target.dataset.id) : state.sel.delete(e.target.dataset.id); }
      render();
    });
    el.addEventListener('input', (e) => { if (e.target.id === 'bk-filter') render(); });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      if (b.dataset.pick === 'all') targets.forEach(t => state.sel.add(t.id));
      else if (b.dataset.pick === 'none') state.sel.clear();
      else { state.sel.clear(); targets.filter(t => sizeOf(t) === sizeOf(src)).forEach(t => state.sel.add(t.id)); }
      render();
    });
    el.querySelector('#bk-cancel').addEventListener('click', () => this.close());
    applyBtn.addEventListener('click', () => {
      const ids = [...state.sel];
      for (const id of ids) {
        const t = this._comp(id);
        if (!t) continue;
        if (state.copyCable && srcEntry) {
          t.props.standard_type = srcEntry.id;
          Properties.applyStandardType(t, 'cable', srcEntry.id);
        }
        const p = this._plan(src, t, state.copyCable, state.copyInst);
        if (p.s && p.s.baseA != null) Properties._writeAmpacity(t, p.s);
      }
      this._finish(`Applied ${this._name(src)}'s ${[state.copyCable && 'cable', state.copyInst && 'installation'].filter(Boolean).join(' and ')} to ${ids.length} cable${ids.length === 1 ? '' : 's'}.`);
    });
    render();
  },

  // ── breakers ─────────────────────────────────────────────────────────────
  openBreakers(ids) {
    const cbs = ids.map(id => this._comp(id)).filter(c => this._isCb(c));
    if (!cbs.length) return;
    const duty = {};
    const dr = AppState.dutyCheckResults;
    if (dr && Array.isArray(dr.devices)) dr.devices.forEach(d => { duty[d.device_id] = d; });
    const label = (e) => `${e.name}${e.manufacturer ? ' · ' + e.manufacturer : ''} · ${e.trip_rating_a} A · ${e.breaking_ka} kA`;
    const state = { pick: null, q: '' };

    const el = this._open(`Set breaker type for ${cbs.length} breaker${cbs.length === 1 ? '' : 's'}`,
      cbs.map(c => escHtml(this._name(c))).join(', ') + (Object.keys(duty).length ? '' : ' · run the Duty Check to see each breaker’s required fault level'), `
      <div class="cbk-row">
        <label for="bk-q"><strong>Breaker type</strong></label>
        <span class="info-tip" tabindex="0" role="note" aria-label="How the breaker filter works" data-tip="Type to filter. * matches any text and words narrow together, for example 250*elec or *36 kA. The table shows what each pick does to the selected breakers.">i</span>
      </div>
      <input type="search" id="bk-q" class="cbk-filter cbk-filter-wide" placeholder="Type to filter, e.g. 160*elec or *36 kA" autocomplete="off">
      <div class="cbk-count" id="bk-count"></div>
      <div class="cbk-list" id="bk-list" role="listbox" aria-label="Breaker types"></div>
      <div class="cbk-table-wrap"><table class="cbk-table"><thead><tr><th>Breaker</th><th>Now</th><th>Needs</th><th>After</th></tr></thead><tbody id="bk-rows"></tbody></table></div>`,
      `<span id="bk-warn" class="cbk-warn"></span><span class="cbk-foot-btns"><button type="button" class="btn" id="bk-cancel">Cancel</button><button type="button" class="btn btn-primary" id="bk-apply" disabled>Apply</button></span>`);

    const lib = STANDARD_CBS;
    const listEl = el.querySelector('#bk-list');
    const rowsEl = el.querySelector('#bk-rows');
    const warnEl = el.querySelector('#bk-warn');
    const applyBtn = el.querySelector('#bk-apply');
    const MAX = 150;

    const renderList = () => {
      const found = lib.filter(e => this.match(label(e), state.q));
      el.querySelector('#bk-count').textContent = found.length === lib.length ? `${lib.length} breaker types` : `${found.length} of ${lib.length} breaker types`;
      listEl.innerHTML = found.slice(0, MAX).map(e =>
        `<button type="button" role="option" aria-selected="${e.id === state.pick}" class="cbk-opt${e.id === state.pick ? ' on' : ''}" data-cb="${escHtml(e.id)}">${escHtml(label(e))}</button>`).join('') +
        (found.length > MAX ? `<div class="cbk-more">${found.length - MAX} more — keep typing to narrow the list.</div>` : '') +
        (found.length ? '' : `<div class="cbk-more">No breaker matches “${escHtml(state.q)}”.</div>`);
    };
    const renderRows = () => {
      const pick = lib.find(e => e.id === state.pick) || null;
      let bad = 0;
      rowsEl.innerHTML = cbs.map(c => {
        const d = duty[c.id];
        const need = d ? Number(d.prospective_fault_ka) : null;
        const cur = c.props.standard_type ? lib.find(e => e.id === c.props.standard_type) : null;
        const now = cur ? cur.name : `${c.props.trip_rating_a || c.props.rated_current_a || '?'} A · ${c.props.breaking_capacity_ka || '?'} kA`;
        let after = pick ? `${pick.trip_rating_a} A · ${pick.breaking_ka} kA` : '—';
        let cls = '';
        if (pick && need != null && pick.breaking_ka < need) { bad++; cls = ' class="cbk-bad"'; after += ' ✕ Icu too low'; }
        else if (pick && need != null) after += ' ✓';
        return `<tr${cls}><td>${escHtml(this._name(c))}</td><td>${escHtml(now)}</td><td>${need != null ? '≥ ' + need.toFixed(1) + ' kA' : '—'}</td><td>${escHtml(after)}</td></tr>`;
      }).join('');
      applyBtn.disabled = !pick;
      applyBtn.textContent = pick ? `Apply to ${cbs.length} breaker${cbs.length === 1 ? '' : 's'}` : 'Apply';
      warnEl.textContent = !pick ? 'Pick a breaker type.' : bad ? `${bad} breaker${bad === 1 ? '' : 's'} would not meet the fault level. You can still apply.` : '';
      warnEl.className = 'cbk-warn' + (bad ? ' cbk-warn-on' : '');
    };

    el.querySelector('#bk-q').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cb]');
      if (!b) return;
      state.pick = b.dataset.cb;
      renderList(); renderRows();
    });
    el.querySelector('#bk-cancel').addEventListener('click', () => this.close());
    applyBtn.addEventListener('click', async () => {
      const id = state.pick;
      if (!id) return;
      applyBtn.disabled = true;
      let done = 0;
      for (const c of cbs) {
        const swap = (typeof TripUnit !== 'undefined') ? await TripUnit.confirmSwap(c, id) : null;
        if (!swap) continue;   // cancelled for this breaker
        c.props.standard_type = id;
        Properties.applyStandardType(c, 'cb', id);
        if (typeof TripUnit !== 'undefined') TripUnit.afterLibraryPick(c, swap);
        done++;
      }
      this._finish(`Set the breaker type on ${done} breaker${done === 1 ? '' : 's'}.`);
    });
    renderList(); renderRows();
  },
};
