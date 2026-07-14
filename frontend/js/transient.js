/* ProtectionPro — Transient Stability (classical rotor-angle) UI.
 *
 * A small disturbance-setup modal (fault / trip / load-step) and a results
 * modal with signed multi-series time charts (rotor angle δ relative to the
 * centre of inertia, machine frequency, bus voltage), a stability verdict and
 * the critical clearing time. Chart conventions match dynmotor.js (single-axis
 * panels, 2 px lines, hairline gridlines, crosshair + all-series tooltip,
 * direct end-labels, CVD-safe palette on both surfaces) but the y-axis is
 * signed so rotor angles that swing negative render correctly.
 */

const Transient = {
  _result: null,
  _last: null,   // last disturbance spec (remembered across opens)

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _palette(dark) {
    // Reuse dynmotor's validated palette; provide a series pool for N machines.
    const P = (typeof DynMotor !== 'undefined') ? DynMotor._palette(dark) : {};
    P.pool = dark
      ? ['#3987e5', '#199e70', '#c98500', '#9085e9', '#d95926', '#4bb3c4', '#c65b9a']
      : ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#eb6834', '#2f97a8', '#b83f86'];
    P.grid = P.grid || (dark ? '#34344a' : '#e4e4ea');
    P.axis = P.axis || (dark ? '#3a3a50' : '#d0d0d0');
    P.tickText = P.tickText || (dark ? '#a0a0b0' : '#6d6d6d');
    P.ink = P.ink || (dark ? '#e0e0e8' : '#1a1a2e');
    P.inkSec = P.inkSec || (dark ? '#a0a0b0' : '#555');
    return P;
  },

  // ── Component pickers ──────────────────────────────────────────────
  _list(types) {
    return [...AppState.components.values()]
      .filter(c => types.includes(c.type))
      .map(c => ({ id: c.id, name: c.props?.name || c.id }));
  },

  // ── Disturbance setup ──────────────────────────────────────────────
  openConfig(prefill) {
    const buses = this._list(['bus']);
    if (!buses.length) {
      document.getElementById('status-info').textContent =
        'Add a network with buses and a synchronous machine before running stability.';
      return;
    }
    const body = document.getElementById('stability-config-body');
    const branches = this._list(['cable', 'transformer']);
    const breakers = this._list(['cb', 'switch']);
    const gens = this._list(['generator']);
    const loads = this._list(['static_load', 'motor_induction', 'motor_synchronous']);
    const opt = arr => arr.map(o => `<option value="${this._esc(o.id)}">${this._esc(o.name)}</option>`).join('');
    const trips = [...gens.map(g => ({ ...g, name: 'Gen: ' + g.name })),
                   ...branches.map(b => ({ ...b, name: 'Branch: ' + b.name }))];
    // Element pickers for the sequence timeline, per action. Trip can act on a
    // generator, feeder/branch, breaker or load; reconnect on a feeder/breaker/
    // load (generators are trip-only); load-change on a load.
    const pfx = (arr, p) => arr.map(o => ({ id: o.id, name: p + o.name }));
    this._seqEls = {
      trip: [...pfx(gens, 'Gen: '), ...pfx(branches, 'Feeder: '),
             ...pfx(breakers, 'Breaker: '), ...pfx(loads, 'Load: ')],
      close: [...pfx(branches, 'Feeder: '), ...pfx(breakers, 'Breaker: '),
              ...pfx(loads, 'Load: ')],
      load_step: pfx(loads, ''),
    };

    body.innerHTML = this._renderCasesBlock() + `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label>Disturbance</label>
        <select id="ts-type">
          <option value="fault">Three-phase bus fault + clear</option>
          <option value="trip">Generator / branch trip</option>
          <option value="load_step">Load step</option>
          <option value="sequence">Sequenced events (timeline)</option>
        </select>

        <div class="ts-row ts-fault" style="display:contents">
          <label>Fault at bus</label><select id="ts-fault-bus">${opt(buses)}</select>
          <label>Clear time</label>
          <div><input id="ts-clear" type="number" min="0" step="0.01" value="0.15" style="width:90px"> s</div>
          <label>Trip on clear</label>
          <select id="ts-trip-branch"><option value="">— none —</option>${opt(branches)}</select>
          <label>Find CCT</label>
          <div><input id="ts-cct" type="checkbox" checked> critical clearing time (binary search)</div>
        </div>

        <div class="ts-row ts-trip" style="display:none">
          <label>Trip element</label><select id="ts-trip-el">${opt(trips)}</select>
          <label>At time</label>
          <div><input id="ts-trip-time" type="number" min="0" step="0.01" value="0.1" style="width:90px"> s</div>
        </div>

        <div class="ts-row ts-load" style="display:none">
          <label>Load</label><select id="ts-load-el">${opt(loads)}</select>
          <label>Action</label>
          <select id="ts-load-mode">
            <option value="change">Change demand by %</option>
            <option value="add">Switch in a 2nd equal block (+100%)</option>
            <option value="shed">Shed load entirely (−100%)</option>
          </select>
          <label id="ts-load-delta-lbl">Change demand by</label>
          <div><input id="ts-load-delta" type="number" step="5" value="50" style="width:90px"> % of pre-fault load</div>
          <label>At time</label>
          <div><input id="ts-load-time" type="number" min="0" step="0.01" value="0.1" style="width:90px"> s</div>
          <p style="grid-column:1/-1;font-size:11px;color:var(--text-muted,#6d6d6d);margin:2px 0 0">
            Steps the selected (already energised) load's demand at the event time, as a percentage of
            its pre-fault value: <strong>+100%</strong> doubles it (like switching in a second identical
            load), <strong>−100%</strong> sheds it entirely, <strong>−50%</strong> drops half. A load
            sitting on its source's own terminal bus is folded into that machine's mechanical power and
            can't be stepped — put it on a separate bus to switch it in or out.
          </p>
        </div>

        <div class="ts-row ts-seq" style="display:none;grid-column:1/-1">
          <div style="font-size:12px;font-weight:600;margin:2px 0 5px">Event timeline (absolute times)</div>
          <div id="ts-seq-list"></div>
          <button id="ts-seq-add" type="button" style="font-size:11px;padding:3px 10px;margin-top:4px;cursor:pointer;border:1px solid var(--border-color,#d0d0d0);border-radius:4px;background:transparent;color:inherit">+ Add step</button>
          <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:6px 0 0">
            Each step acts on one element at its time; steps run in time order (two at the same time
            are simultaneous). <strong>Trip / open</strong> a feeder, breaker or generator; <strong>reconnect</strong>
            a feeder, breaker or load switched out earlier; or <strong>change a load's</strong> demand by a %.
            Generators are trip-only. A load on its source's own terminal bus can't be stepped — put it on a separate bus.
          </p>
        </div>

        <label>Simulation time</label>
        <div><input id="ts-tend" type="number" min="0.5" step="0.5" value="5" style="width:90px"> s</div>
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-top:10px">
        Each synchronous generator is E′ behind X′d with its inertia H; utility sources are infinite buses; loads are constant admittances (or voltage-dependent / motor models if set). Inverters (PV / BESS / full-converter wind) are frozen unless their <em>Converter Model</em> is set to grid-following or grid-forming. ${gens.length ? '' : '<strong>No generators found — add a generator or a grid-forming inverter (with an inertia constant) for a meaningful swing.</strong>'}</p>`;

    body.querySelector('#ts-type').addEventListener('change', () => this._syncTypeFields());
    body.querySelector('#ts-load-mode').addEventListener('change', () => this._syncLoadMode());
    body.querySelector('#ts-seq-add').addEventListener('click', () => this._addSeqRow());
    this._applyConfig(prefill || this._last);   // populate + reveal the right fields
    this._wireCaseButtons();
    document.getElementById('stability-config-modal').style.display = '';
  },

  _syncTypeFields() {
    const body = document.getElementById('stability-config-body');
    const t = body.querySelector('#ts-type').value;
    body.querySelector('.ts-fault').style.display = t === 'fault' ? 'contents' : 'none';
    body.querySelector('.ts-trip').style.display = t === 'trip' ? 'contents' : 'none';
    body.querySelector('.ts-load').style.display = t === 'load_step' ? 'contents' : 'none';
    body.querySelector('.ts-seq').style.display = t === 'sequence' ? '' : 'none';
    // Switching to a sequence with no steps yet: seed one so the editor isn't empty.
    if (t === 'sequence' && !body.querySelector('#ts-seq-list .ts-seq-row')) this._addSeqRow();
  },

  // ── Sequence timeline editor ───────────────────────────────────────
  _seqElOpts(action, selected) {
    return (this._seqEls[action] || []).map(o =>
      `<option value="${this._esc(o.id)}"${o.id === selected ? ' selected' : ''}>${this._esc(o.name)}</option>`).join('');
  },

  _addSeqRow(step) {
    const list = document.getElementById('ts-seq-list');
    if (!list) return;
    step = step || { t: 1, action: 'trip', element: '', delta_pct: 50 };
    // Coerce the numeric fields to numbers before interpolating into markup (the
    // element options are escaped via _esc; these guard against a crafted case).
    const tVal = Number.isFinite(+step.t) ? +step.t : 1;
    const dVal = Number.isFinite(+step.delta_pct) ? +step.delta_pct : 50;
    const row = document.createElement('div');
    row.className = 'ts-seq-row';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px;font-size:12px';
    row.innerHTML = `
      <input class="ts-seq-t" type="number" min="0" step="0.1" value="${tVal}" style="width:60px" title="Time (s)"><span style="color:var(--text-muted,#6d6d6d)">s</span>
      <select class="ts-seq-action">
        <option value="trip">Trip / open</option>
        <option value="close">Reconnect</option>
        <option value="load_step">Load change</option>
      </select>
      <select class="ts-seq-el" style="flex:1;min-width:110px"></select>
      <input class="ts-seq-delta" type="number" step="5" value="${dVal}" style="width:58px;display:none" title="% change of pre-fault load"><span class="ts-seq-delta-u" style="display:none;color:var(--text-muted,#6d6d6d)">%</span>
      <button type="button" class="ts-seq-del" title="Remove step" style="cursor:pointer;border:1px solid var(--border-color,#d0d0d0);border-radius:4px;background:transparent;color:inherit;padding:0 7px">✕</button>`;
    list.appendChild(row);
    row.querySelector('.ts-seq-action').value = step.action || 'trip';
    this._syncSeqRow(row, step.element);
    row.querySelector('.ts-seq-action').addEventListener('change', () => this._syncSeqRow(row));
    row.querySelector('.ts-seq-del').addEventListener('click', () => row.remove());
  },

  // Populate a row's element picker for its action and toggle the % field.
  _syncSeqRow(row, keepId) {
    const action = row.querySelector('.ts-seq-action').value;
    const elSel = row.querySelector('.ts-seq-el');
    const want = keepId != null ? keepId : elSel.value;   // preserve selection if still valid
    elSel.innerHTML = this._seqElOpts(action, want);
    const isLoad = action === 'load_step';
    row.querySelector('.ts-seq-delta').style.display = isLoad ? '' : 'none';
    row.querySelector('.ts-seq-delta-u').style.display = isLoad ? '' : 'none';
  },

  _readSeqSteps() {
    return [...document.querySelectorAll('#ts-seq-list .ts-seq-row')].map(r => {
      const action = r.querySelector('.ts-seq-action').value;
      const step = { t: parseFloat(r.querySelector('.ts-seq-t').value) || 0, action,
                     element: r.querySelector('.ts-seq-el').value };
      if (action === 'load_step') step.delta_pct = parseFloat(r.querySelector('.ts-seq-delta').value) || 0;
      return step;
    }).filter(s => s.element);
  },

  // Reflect the chosen load-step Action in the "% of pre-fault load" field.
  // "Switch in" pins it to +100 % (a second equal block); "Shed" pins it to
  // −100 % (drop to zero); "Change" lets the user type any percentage.
  _syncLoadMode() {
    const b = document.getElementById('stability-config-body');
    const mode = b.querySelector('#ts-load-mode').value;
    const delta = b.querySelector('#ts-load-delta');
    const lbl = b.querySelector('#ts-load-delta-lbl');
    if (mode === 'change') {
      delta.disabled = false;
      lbl.style.opacity = '';
    } else {
      delta.value = mode === 'add' ? 100 : -100;
      delta.disabled = true;
      lbl.style.opacity = '0.5';
    }
  },

  // Populate the form from a disturbance spec (a saved case or the last run).
  _applyConfig(d) {
    const b = document.getElementById('stability-config-body');
    const set = (sel, v) => { const el = b.querySelector(sel); if (el && v != null) el.value = v; };
    const chk = (sel, v) => { const el = b.querySelector(sel); if (el) el.checked = !!v; };
    if (d) {
      if (d.type) set('#ts-type', d.type);
      set('#ts-tend', d.t_end_s);
      if (d.bus != null || d.type === 'fault') {
        set('#ts-fault-bus', d.bus);
        set('#ts-clear', d.clear_time_s);
        set('#ts-trip-branch', d.trip_element || '');
        chk('#ts-cct', d.find_cct !== false);
      }
      if (d.type === 'trip') { set('#ts-trip-el', d.element); set('#ts-trip-time', d.time_s); }
      if (d.type === 'sequence') {
        const list = b.querySelector('#ts-seq-list');
        if (list) {
          list.innerHTML = '';
          (d.steps || []).forEach(s => this._addSeqRow(s));
        }
      }
      if (d.type === 'load_step') {
        set('#ts-load-el', d.element); set('#ts-load-time', d.time_s);
        // Infer the Action from delta_pct so saved cases (which store only
        // delta_pct) round-trip: ±100 % map to the shed / switch-in presets.
        const dp = d.delta_pct;
        set('#ts-load-mode', dp === -100 ? 'shed' : dp === 100 ? 'add' : 'change');
        set('#ts-load-delta', dp);
      }
    }
    this._syncTypeFields();
    this._syncLoadMode();
  },

  // ── Saved study cases (persisted with the project) ─────────────────
  _cases() {
    if (!Array.isArray(AppState.stabilityCases)) AppState.stabilityCases = [];
    return AppState.stabilityCases;
  },

  _name(id) {
    const c = AppState.components.get(id);
    return c ? (c.props?.name || id) : id;
  },

  _caseSummary(d) {
    if (!d) return '';
    if (d.type === 'fault') {
      return `Fault @ ${this._name(d.bus)}, clear ${Math.round((d.clear_time_s || 0) * 1000)} ms`
        + (d.trip_element ? `, trip ${this._name(d.trip_element)}` : '')
        + (d.find_cct !== false ? ', CCT' : '');
    }
    if (d.type === 'trip') return `Trip ${this._name(d.element)} @ ${Math.round((d.time_s || 0) * 1000)} ms`;
    if (d.type === 'sequence') {
      const st = d.steps || [];
      const verb = { trip: 'trip', close: 'close', load_step: 'step' };
      const one = s => `${verb[s.action] || s.action} ${this._name(s.element)}@${s.t || 0}s`;
      return `Sequence (${st.length} step${st.length === 1 ? '' : 's'})`
        + (st.length ? ': ' + st.slice(0, 3).map(one).join(', ') + (st.length > 3 ? '…' : '') : '');
    }
    if (d.type === 'load_step') {
      const dp = d.delta_pct;
      const what = dp === -100 ? `Shed ${this._name(d.element)}`
        : dp === 100 ? `Switch in 2nd ${this._name(d.element)}`
        : `${this._name(d.element)} demand ${dp >= 0 ? '+' : ''}${dp}%`;
      return `${what} @ ${Math.round((d.time_s || 0) * 1000)} ms`;
    }
    return d.type || '';
  },

  _renderCasesBlock() {
    const cases = this._cases();
    const btn = 'font-size:11px;padding:2px 8px;cursor:pointer;border:1px solid var(--border-color,#d0d0d0);border-radius:4px;background:transparent;color:inherit';
    const rows = cases.length ? cases.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis"><strong>${this._esc(c.name)}</strong>
          <span style="color:var(--text-muted,#6d6d6d)"> — ${this._esc(this._caseSummary(c.disturbance))}</span></span>
        <button style="${btn}" class="ts-case-load" data-id="${this._esc(c.id)}">Load</button>
        <button style="${btn}" class="ts-case-del" data-id="${this._esc(c.id)}" title="Delete case">✕</button>
      </div>`).join('')
      : '<div style="font-size:12px;color:var(--text-muted,#6d6d6d)">No saved cases yet — configure a disturbance below and Save it.</div>';
    return `<div style="margin-bottom:14px;border:1px solid var(--border-color,#d0d0d0);border-radius:6px;padding:8px 10px">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">Saved study cases</div>
      <div>${rows}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <input id="ts-case-name" type="text" placeholder="Name this case…" style="flex:1;font-size:12px;padding:3px 6px">
        <button style="${btn}" id="ts-case-save">Save current</button>
      </div>
    </div>`;
  },

  _wireCaseButtons() {
    const b = document.getElementById('stability-config-body');
    const saveBtn = b.querySelector('#ts-case-save');
    if (saveBtn) saveBtn.addEventListener('click', () => this._saveCase());
    b.querySelectorAll('.ts-case-load').forEach(el =>
      el.addEventListener('click', () => this._loadCase(el.dataset.id)));
    b.querySelectorAll('.ts-case-del').forEach(el =>
      el.addEventListener('click', () => this._deleteCase(el.dataset.id)));
  },

  _saveCase() {
    const b = document.getElementById('stability-config-body');
    const cases = this._cases();
    const nameEl = b.querySelector('#ts-case-name');
    const name = (nameEl && nameEl.value || '').trim() || `Case ${cases.length + 1}`;
    const d = this._readConfig();
    const existing = cases.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.disturbance = d;
    } else {
      cases.push({ id: 'tsc_' + Date.now(), name, disturbance: d });
    }
    AppState.dirty = true;
    this._last = d;
    document.getElementById('status-info').textContent = `Saved study case “${name}”.`;
    this.openConfig(d);  // re-render (updated list), keep the current config
  },

  _loadCase(id) {
    const c = this._cases().find(x => x.id === id);
    if (!c) return;
    this._last = c.disturbance;
    this.openConfig(c.disturbance);
    const nameEl = document.getElementById('ts-case-name');
    if (nameEl) nameEl.value = c.name;   // pre-fill name so re-saving updates it
  },

  _deleteCase(id) {
    const cases = this._cases();
    const i = cases.findIndex(x => x.id === id);
    if (i < 0) return;
    const current = this._readConfig();   // preserve the in-progress form
    cases.splice(i, 1);
    AppState.dirty = true;
    this.openConfig(current);
  },

  _readConfig() {
    const b = document.getElementById('stability-config-body');
    const type = b.querySelector('#ts-type').value;
    const d = { type, t_end_s: parseFloat(b.querySelector('#ts-tend').value) || 5 };
    if (type === 'fault') {
      d.bus = b.querySelector('#ts-fault-bus').value;
      d.clear_time_s = parseFloat(b.querySelector('#ts-clear').value) || 0.15;
      d.trip_element = b.querySelector('#ts-trip-branch').value || null;
      d.find_cct = b.querySelector('#ts-cct').checked;
    } else if (type === 'trip') {
      d.element = b.querySelector('#ts-trip-el').value;
      d.time_s = parseFloat(b.querySelector('#ts-trip-time').value) || 0.1;
    } else if (type === 'sequence') {
      d.steps = this._readSeqSteps();
    } else {
      d.element = b.querySelector('#ts-load-el').value;
      const mode = b.querySelector('#ts-load-mode').value;
      // The Action presets resolve to a delta_pct; the wire format stays a bare
      // delta_pct so existing saved cases run unchanged (mode is UI-only).
      d.delta_pct = mode === 'add' ? 100
        : mode === 'shed' ? -100
        : (parseFloat(b.querySelector('#ts-load-delta').value) || 0);
      d.time_s = parseFloat(b.querySelector('#ts-load-time').value) || 0.1;
    }
    return d;
  },

  async runConfigured() {
    const d = this._readConfig();
    this._last = d;
    document.getElementById('stability-config-modal').style.display = 'none';
    const label = d.type === 'fault' && d.find_cct
      ? 'Running transient stability (searching critical clearing time)…'
      : 'Running transient stability simulation…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runTransientStability(d);
      // Remember the disturbance spec on the result so the graphs can mark the
      // event points (per-step for a sequence), surviving save/load.
      result.__spec = d;
      AppState.stabilityResults = result;
      this.show(result);
      document.getElementById('status-info').textContent =
        result.stable === false ? 'Transient stability: UNSTABLE' : 'Transient stability complete.';
    } catch (e) {
      console.error('Transient stability error:', e);
      document.getElementById('status-info').textContent = 'Transient stability failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Transient Stability — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('stability-modal');
    const body = document.getElementById('stability-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _render(body) {
    const r = this._result || {};
    const warnings = r.warnings || [];
    let html = AppState.staleBannerHTML('stabilityResults');
    if (warnings.length) {
      html += '<div class="af-warnings">' + warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!r.curves || !r.machines || !r.machines.length) {
      body.innerHTML = html + '<p>No synchronous machines to simulate. Add a generator (with an inertia constant H) and a source.</p>';
      return;
    }

    // Verdict banner. Instability is either loss of synchronism (rotor angles)
    // or a frequency collapse / run-up (island frequency runs away though the
    // machines stay in step) — name whichever applies.
    const stable = r.stable !== false;
    const col = stable ? '#2e7d32' : '#c62828';
    const label = stable ? 'STABLE' : ('UNSTABLE — ' + this._esc(r.instability || 'loss of synchronism'));
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:9px 13px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <div><span style="font-weight:700;color:${col}">${label}</span>
        <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${this._esc(r.event || '')}</span></div>
      ${r.cct_s != null ? `<div style="font-size:12px">Critical clearing time: <strong>${(r.cct_s * 1000).toFixed(0)} ms</strong></div>` : ''}
    </div>`;

    // Machine summary
    const typeLabel = t => t === 'infinite_bus' ? 'infinite bus' : t === 'gfm_inverter' ? 'GFM inverter' : 'gen';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:6px 14px;font-size:12px;margin-bottom:10px">'
      + r.machines.map(m => `<div><strong>${this._esc(m.name)}</strong> (${this._esc(typeLabel(m.type))})<br>
        <span style="color:var(--text-muted,#6d6d6d)">H=${m.h_s} s · Pm=${m.pm_pu} p.u. · δ₀=${m.delta0_deg}° · peak δ=${m.peak_angle_deg}°${
          m.type === 'gfm_inverter' && m.peak_current_pu != null ? ` · peak I=${m.peak_current_pu}×I_rated (limit ${m.imax_pu}×)` : ''}</span></div>`).join('')
      + '</div>';

    // Protection operations (UFLS / generator & motor trips) during the run
    if (Array.isArray(r.trips) && r.trips.length) {
      html += '<div style="margin-bottom:10px;padding:8px 11px;border:1px solid #b26a00;border-radius:6px;background:#fff3e0;font-size:12px">'
        + '<div style="font-weight:700;color:#8a4b00;margin-bottom:3px">⚡ Protection operations</div>'
        + r.trips.map(tr => `<div style="color:#6d4c00">${(tr.t).toFixed(2)} s — <strong>${this._esc(tr.element)}</strong>: ${this._esc(tr.reason)}</div>`).join('')
        + '</div>';
    }

    html += `<div class="ts-chart" data-chart="angle"></div>`;
    html += `<div class="ts-chart" data-chart="freq"></div>`;
    html += `<div class="ts-chart" data-chart="volt"></div>`;
    html += this._tableView(r);
    body.innerHTML = html;
    this._hydrate(body, r);
  },

  _tableView(r) {
    const c = r.curves; const t = c.t || [];
    if (!t.length) return '';
    const step = Math.max(1, Math.floor(t.length / 25));
    const heads = ['t (s)', ...c.machines.map(m => `δ ${m} (°)`)];
    let rows = '';
    for (let i = 0; i < t.length; i += step) {
      rows += `<tr><td>${t[i].toFixed(2)}</td>` +
        c.delta_deg.map(d => `<td>${d[i].toFixed(1)}</td>`).join('') + '</tr>';
    }
    return `<details style="font-size:11px;margin-top:6px"><summary style="cursor:pointer">Data table (rotor angles)</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px">
      <table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums"><thead><tr>${
        heads.map(h => `<th>${this._esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
  },

  // Vertical event lines for the time charts. Prefer the disturbance spec that
  // produced this result (attached as __spec, so it survives save/load); a
  // sequence yields one marker per timed step. Falls back to the last-run spec,
  // then to parsing the backend event string for restored/legacy results.
  _eventMarkers(r, P) {
    const spec = (r && r.__spec)
      || (AppState.stabilityResults && AppState.stabilityResults.__spec)
      || this._last || {};
    const marks = [];
    const verb = { trip: 'open', close: 'close', load_step: 'load' };

    if (spec.type === 'sequence' && Array.isArray(spec.steps) && spec.steps.length) {
      spec.steps.forEach(s => {
        if (!s || s.t == null) return;
        let label = `${verb[s.action] || s.action} ${this._name(s.element)}`;
        if (s.action === 'load_step' && s.delta_pct != null) {
          label += ` ${s.delta_pct >= 0 ? '+' : ''}${s.delta_pct}%`;
        }
        marks.push({ t: +s.t, label, color: P.inkSec, dashed: true });
      });
      return marks;
    }
    if (spec.type === 'trip' && spec.time_s != null) {
      marks.push({ t: +spec.time_s, label: 'trip ' + this._name(spec.element), color: P.inkSec, dashed: true });
      return marks;
    }
    if (spec.type === 'load_step' && spec.time_s != null) {
      marks.push({ t: +spec.time_s, label: 'load step', color: P.inkSec, dashed: true });
      return marks;
    }
    // Fault: mark the clearing time (from the event string, else the spec).
    if (r.event && /cleared at ([\d.]+)/.test(r.event)) {
      marks.push({ t: parseFloat(RegExp.$1) / 1000, label: 'clear', color: P.inkSec, dashed: true });
    } else if (spec.clear_time_s != null) {
      marks.push({ t: +spec.clear_time_s, label: 'clear', color: P.inkSec, dashed: true });
    } else if (spec.time_s != null) {
      marks.push({ t: +spec.time_s, label: 'event', color: P.inkSec, dashed: true });
    }
    // Legacy/restored sequence with no spec: recover the "… @ Ns" times from the
    // backend event string ("Sequence: open X @ 1s; shed Y @ 3s").
    if (!marks.length && r.event && r.event.indexOf('@') >= 0) {
      const re = /([^;:]+?)@\s*([\d.]+)\s*s/g;
      let m;
      while ((m = re.exec(r.event))) {
        marks.push({ t: parseFloat(m[2]), label: m[1].trim(), color: P.inkSec, dashed: true });
      }
    }
    return marks;
  },

  _hydrate(root, r) {
    const dark = document.body.classList.contains('dark-mode');
    const P = this._palette(dark);
    const c = r.curves;
    const markers = this._eventMarkers(r, P);
    const mkSeries = (valsPerMachine, fmt) => c.machines.map((name, i) => ({
      name, values: valsPerMachine[i], color: P.pool[i % P.pool.length], fmt,
    }));

    const charts = {
      angle: {
        title: 'Rotor angle δ (relative to centre of inertia) vs time',
        xLabel: 'Time (s)', yLabel: '°', xs: c.t, markers,
        series: mkSeries(c.delta_deg, v => v.toFixed(1) + '°'),
      },
      freq: {
        title: 'Machine frequency deviation vs time', xLabel: 'Time (s)', yLabel: 'Hz', xs: c.t, markers,
        series: mkSeries(c.speed_hz, v => v.toFixed(3) + ' Hz'),
      },
      volt: {
        title: 'Bus voltage vs time', xLabel: 'Time (s)', yLabel: 'p.u.', xs: c.t, markers,
        series: (c.buses || []).map((b, i) => ({
          name: b.bus, values: b.v_pu, color: P.pool[i % P.pool.length],
          fmt: v => v.toFixed(3) + ' p.u.',
        })),
      },
    };
    root.querySelectorAll('.ts-chart').forEach(el => {
      const spec = charts[el.dataset.chart];
      if (spec && spec.series.length) this._buildChart(el, spec, P);
    });
  },

  _niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    for (const mult of [1, 2, 2.5, 5, 10]) if (raw <= mult * mag) return mult * mag;
    return 10 * mag;
  },

  // Signed-axis multi-series chart (rotor angle can go negative).
  _buildChart(container, spec, P) {
    const W = 640, H = 220, padL = 50, padR = 112, padT = 26, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xs = spec.xs, n = xs.length;
    if (!n) return;
    const xMin = 0, xMax = Math.max(xs[n - 1], 1e-9);
    let yMin = Infinity, yMax = -Infinity;
    for (const s of spec.series) for (const v of s.values) {
      if (v < yMin) yMin = v; if (v > yMax) yMax = v;
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
    if (yMin > 0) yMin = 0;  // keep a zero reference visible when all-positive
    const X = v => padL + (v - xMin) / (xMax - xMin) * plotW;
    const Y = v => padT + plotH - (v - yMin) / (yMax - yMin) * plotH;

    let g = '';
    const yStep = this._niceStep(yMax - yMin, 4);
    const y0 = Math.ceil(yMin / yStep) * yStep;
    for (let v = y0; v <= yMax + 1e-9; v += yStep) {
      const y = Y(v);
      g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${P.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    const xStep = this._niceStep(xMax - xMin, 6);
    for (let v = 0; v <= xMax + 1e-9; v += xStep) {
      g += `<text x="${X(v)}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    // zero line emphasised
    if (yMin < 0 && yMax > 0) {
      g += `<line x1="${padL}" y1="${Y(0)}" x2="${W - padR}" y2="${Y(0)}" stroke="${P.axis}" stroke-width="1.2"/>`;
    }
    // Cycle caption heights so closely-spaced sequence events don't collide.
    (spec.markers || []).forEach((mk, mi) => {
      if (mk.t == null || mk.t < xMin || mk.t > xMax) return;
      const x = X(mk.t);
      g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${mk.color || P.tickText}" stroke-width="1" opacity="0.6"${mk.dashed ? ' stroke-dasharray="3 2"' : ''}/>`;
      g += `<text x="${x + 3}" y="${padT + 9 + (mi % 3) * 9}" font-size="8" fill="${mk.color || P.tickText}">${this._esc(mk.label)}</text>`;
    });
    for (const s of spec.series) {
      const pts = s.values.map((v, i) => `${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      g += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // direct end-labels, nudged apart
    const ends = spec.series.map(s => ({ y: Y(s.values[s.values.length - 1]), name: s.name, color: s.color }))
      .sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const e of ends) { e.ly = Math.max(e.y, prev + 12); prev = e.ly; }
    for (const e of ends) {
      const x0 = W - padR;
      if (Math.abs(e.ly - e.y) > 2) g += `<line x1="${x0 + 2}" y1="${e.y}" x2="${x0 + 12}" y2="${e.ly}" stroke="${e.color}" stroke-width="1" opacity="0.7"/>`;
      g += `<line x1="${x0 + 13}" y1="${e.ly}" x2="${x0 + 25}" y2="${e.ly}" stroke="${e.color}" stroke-width="2"/>`;
      g += `<text x="${x0 + 29}" y="${e.ly + 3}" font-size="9" fill="${P.inkSec}">${this._esc(e.name)}</text>`;
    }
    g += `<line class="ts-xhair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="${P.tickText}" stroke-width="1" visibility="hidden"/>`;
    const title = `<text x="${padL}" y="14" font-size="11" font-weight="600" fill="${P.ink}">${this._esc(spec.title)}</text>`;
    const yLab = `<text x="${padL}" y="${padT - 6}" font-size="9" fill="${P.tickText}">${this._esc(spec.yLabel)}</text>`;
    const xLab = `<text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="9" fill="${P.tickText}">${this._esc(spec.xLabel)}</text>`;

    container.style.position = 'relative';
    container.style.margin = '0 0 10px';
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="${this._esc(spec.title)}">${title}${yLab}${xLab}${g}</svg>
      <div class="ts-tip" style="display:none;position:absolute;pointer-events:none;background:var(--bg-primary,#fff);border:1px solid var(--border-color,#d0d0d0);border-radius:4px;padding:5px 8px;font-size:10px;box-shadow:0 2px 8px rgba(0,0,0,0.25);z-index:5;white-space:nowrap"></div>`;

    const svg = container.querySelector('svg');
    const tip = container.querySelector('.ts-tip');
    const xhair = container.querySelector('.ts-xhair');
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width * W;
      if (fx < padL || fx > W - padR) { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); return; }
      const xVal = xMin + (fx - padL) / plotW * (xMax - xMin);
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; (xs[mid] < xVal) ? lo = mid : hi = mid; }
      const idx = (Math.abs(xs[lo] - xVal) <= Math.abs(xs[hi] - xVal)) ? lo : hi;
      const sx = X(xs[idx]);
      xhair.setAttribute('x1', sx); xhair.setAttribute('x2', sx);
      xhair.setAttribute('visibility', 'visible');
      tip.textContent = '';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:3px';
      head.textContent = `t ${xs[idx].toFixed(2)} s`;
      tip.appendChild(head);
      for (const s of spec.series) {
        const row = document.createElement('div');
        const key = document.createElement('span');
        key.style.cssText = `display:inline-block;width:12px;height:2px;background:${s.color};vertical-align:middle;margin-right:5px`;
        const val = document.createElement('strong');
        val.textContent = s.fmt ? s.fmt(s.values[idx], idx) : String(s.values[idx]);
        const lab = document.createElement('span');
        lab.style.cssText = 'color:var(--text-muted,#6d6d6d);margin-left:5px';
        lab.textContent = s.name;
        row.appendChild(key); row.appendChild(val); row.appendChild(lab);
        tip.appendChild(row);
      }
      tip.style.display = '';
      const cw = container.clientWidth, px = sx / W * cw;
      tip.style.left = (px + 12 + tip.offsetWidth > cw ? px - tip.offsetWidth - 10 : px + 12) + 'px';
      tip.style.top = '30px';
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); });
  },
};
