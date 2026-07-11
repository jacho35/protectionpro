/* ProtectionPro — Reticulation Workspace (LV distribution / NRS 034-1 ADMD)
 *
 * A workspace parallel to the SLD canvas. Kiosks feed groups of erven (stands);
 * After-Diversity Maximum Demand is estimated by the backend /api/analysis/admd
 * engine (Empirical or Herman-Beta) and used to size feeders and check volt-drop.
 * All state lives in AppState.reticulation (see state.js); results in
 * AppState.reticResults.
 */

const Retic = {
  _active: false,
  _computeTimer: null,
  _undoStack: [],
  _undoIndex: -1,

  PHASES: [
    { id: 'Red', color: '#dc2626' },
    { id: 'White', color: '#6b7280' },
    { id: 'Blue', color: '#2563eb' },
    { id: '3 Phase', color: '#7c3aed' },
  ],

  init() {
    // Workspace-tab clicks are bound centrally by app.js switchWorkspace()
    // (three-way SLD / Reticulation / Plan switch); activate()/deactivate()
    // below are invoked by that coordinator.
    const ws = document.getElementById('retic-workspace');
    if (ws) {
      // Delegated change handler for every field in the workspace
      ws.addEventListener('change', (e) => this._onChange(e));
      ws.addEventListener('click', (e) => this._onClick(e));
    }
    this._snapshot(); // baseline
  },

  // ─── Workspace show/hide ───
  activate() {
    this._active = true;
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('retic-workspace').style.display = 'flex';
    document.getElementById('btn-workspace-retic').classList.add('active');
    document.getElementById('btn-workspace-retic').setAttribute('aria-selected', 'true');
    document.getElementById('btn-workspace-sld').classList.remove('active');
    document.getElementById('btn-workspace-sld').setAttribute('aria-selected', 'false');
    this.render();
    this.recompute();
  },

  deactivate() {
    this._active = false;
    document.getElementById('retic-workspace').style.display = 'none';
    document.getElementById('app-container').style.display = '';
    document.getElementById('btn-workspace-sld').classList.add('active');
    document.getElementById('btn-workspace-sld').setAttribute('aria-selected', 'true');
    document.getElementById('btn-workspace-retic').classList.remove('active');
    document.getElementById('btn-workspace-retic').setAttribute('aria-selected', 'false');
    if (typeof Canvas !== 'undefined') Canvas.render();
  },

  // ─── Data accessors ───
  get state() { return AppState.reticulation; },
  get settings() { return AppState.reticulation.settings; },
  get kiosks() { return AppState.reticulation.kiosks; },
  get minisubs() { return AppState.reticulation.minisubs; },
  kioskById(id) { return this.kiosks.find(k => k.id === id); },

  // The minisub at the root of a kiosk's fedFrom chain (cycle-guarded);
  // unknown/legacy roots resolve to the first minisub.
  _rootOf(kioskId) {
    const byId = {};
    for (const k of this.kiosks) byId[k.id] = k;
    const msIds = new Set(this.minisubs.map(m => m.id));
    let cur = kioskId;
    const seen = new Set();
    while (byId[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = byId[cur].fedFrom || '';
    }
    return msIds.has(cur) ? cur : this.minisubs[0].id;
  },

  _markDirty() { AppState.dirty = true; },

  // ─── CRUD ───
  // Bare kiosk object seeded with the Quick Build feeder defaults.
  _newKiosk(fedFrom) {
    const s = this.settings;
    return {
      id: AppState.reticGenKioskId(),
      name: 'Kiosk ' + (this.kiosks.length + 1),
      fedFrom: fedFrom || 'source',
      loadClass: '',            // '' = use project default
      admdOverride: 0,
      streetLightKVA: 0,        // fixed, undiversified street-lighting load
      feederCable: s.quickFeederCable || '',
      feederLength: s.quickFeederLen || 0,
      collapsed: false,
      erfs: [],
    };
  },

  // Bare erf seeded with the Quick Build service defaults (worst-case length).
  _newErf(k, num) {
    const s = this.settings;
    return {
      id: AppState.reticGenErfId(),
      erfNumber: String(num),
      length: s.quickServiceLen || 30,
      phase: this.PHASES[k.erfs.length % 3].id, // round-robin R/W/B
      cableType: s.quickServiceCable || '',
      ampsOverride: 0,
    };
  },

  addKiosk() {
    this.kiosks.push(this._newKiosk(this.minisubs[0].id));
    this._afterMutate();
  },

  // Quick Build: append N kiosks × M erven using the quick defaults, either
  // daisy-chained (each fed from the previous; the first new kiosk continues
  // from the selected minisub's last kiosk) or star-fed from the minisub.
  // One undo step.
  quickBuild() {
    const s = this.settings;
    const nK = Math.max(1, Math.round(s.quickKiosks || 1));
    const nE = Math.max(0, Math.round(s.quickErven || 0));
    const root = this.minisubs.some(m => m.id === s.quickFeedFrom)
      ? s.quickFeedFrom : this.minisubs[0].id;
    let prev = null;
    if (s.quickChain) {
      for (let i = this.kiosks.length - 1; i >= 0; i--) {
        if (this._rootOf(this.kiosks[i].id) === root) { prev = this.kiosks[i]; break; }
      }
    }
    for (let i = 0; i < nK; i++) {
      const k = this._newKiosk(s.quickChain && prev ? prev.id : root);
      k.collapsed = true;       // keep the bulk-added list compact
      for (let j = 0; j < nE; j++) k.erfs.push(this._newErf(k, j + 1));
      this.kiosks.push(k);
      prev = k;
    }
    this._afterMutate();
  },

  deleteKiosk(id) {
    const i = this.kiosks.findIndex(k => k.id === id);
    if (i < 0) return;
    const parent = this.kiosks[i].fedFrom || this.minisubs[0].id;
    this.kiosks.splice(i, 1);
    // Kiosks fed from the deleted one inherit its parent (chain closes up)
    for (const k of this.kiosks) if (k.fedFrom === id) k.fedFrom = parent;
    this._afterMutate();
  },

  addMinisub() {
    const n = this.minisubs.length + 1;
    this.minisubs.push({ id: AppState.reticGenMinisubId(), name: 'Minisub ' + n });
    this._afterMutate();
  },

  async deleteMinisub(id) {
    if (this.minisubs.length <= 1) {
      UI.alert('At least one minisub is required.');
      return;
    }
    const i = this.minisubs.findIndex(m => m.id === id);
    if (i < 0) return;
    this.minisubs.splice(i, 1);
    // Kiosks fed from the deleted minisub move to the first remaining one
    const fallback = this.minisubs[0].id;
    for (const k of this.kiosks) if (k.fedFrom === id) k.fedFrom = fallback;
    if (this.settings.quickFeedFrom === id) this.settings.quickFeedFrom = fallback;
    this._afterMutate();
  },

  addErf(kioskId, count) {
    const k = this.kioskById(kioskId);
    if (!k) return;
    const start = k.erfs.length + 1;
    for (let i = 0; i < (count || 1); i++) {
      k.erfs.push(this._newErf(k, start + i));
    }
    this._afterMutate();
  },

  deleteErf(kioskId, erfId) {
    const k = this.kioskById(kioskId);
    if (!k) return;
    const i = k.erfs.findIndex(e => e.id === erfId);
    if (i >= 0) k.erfs.splice(i, 1);
    this._afterMutate();
  },

  // Common post-mutation path: record the new state on the undo stack
  // (snapshot-after pattern, matching UndoManager), then refresh.
  _afterMutate() {
    this._snapshot();
    this._markDirty();
    this.render();
    this.recompute();
  },

  // ─── Event handling ───
  _onChange(e) {
    const t = e.target;
    const action = t.dataset.action;
    if (!action) return;

    if (action === 'setting') {
      const key = t.dataset.field;
      let v = t.value;
      if (t.type === 'number') v = parseFloat(v) || 0;
      if (t.type === 'checkbox') v = t.checked;
      this.settings[key] = v;
      this._snapshot();
      this._markDirty();
      // Re-render on method switch (toggles correction/ADMD/riskZ enable) and
      // on riskZ edit (refreshes the risk-% hint).
      if (key === 'estimationMethod' || key === 'riskZ') this.renderSettingsBar();
      if (key.startsWith('quick')) {
        // Quick Build defaults only affect future adds — no recompute needed;
        // quickErven also drives the per-kiosk "+ N Erven" button labels.
        if (key === 'quickErven') this.renderKiosks();
        return;
      }
      this.recompute();
      return;
    }

    if (action === 'kiosk-field') {
      const k = this.kioskById(t.dataset.kiosk);
      if (!k) return;
      const key = t.dataset.field;
      let v = t.value;
      if (t.type === 'number') v = parseFloat(v) || 0;
      k[key] = v;
      this._snapshot();
      this._markDirty();
      this.recompute();
      return;
    }

    if (action === 'erf-field') {
      const k = this.kioskById(t.dataset.kiosk);
      if (!k) return;
      const erf = k.erfs.find(x => x.id === t.dataset.erf);
      if (!erf) return;
      const key = t.dataset.field;
      let v = t.value;
      if (t.type === 'number') v = parseFloat(v) || 0;
      erf[key] = v;
      this._snapshot();
      this._markDirty();
      this.recompute();
      return;
    }

    if (action === 'minisub-field') {
      const ms = this.minisubs.find(m => m.id === t.dataset.ms);
      if (!ms) return;
      ms[t.dataset.field] = t.value;
      this._snapshot();
      this._markDirty();
      this.renderKiosks();      // Fed From dropdowns show minisub names
      this.recompute();         // summary re-renders with the new name
      return;
    }
  },

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add-kiosk') this.addKiosk();
    else if (action === 'quick-build') this.quickBuild();
    else if (action === 'add-minisub') this.addMinisub();
    else if (action === 'del-minisub') this.deleteMinisub(btn.dataset.ms);
    else if (action === 'del-kiosk') { e.stopPropagation(); this.deleteKiosk(btn.dataset.kiosk); }
    else if (action === 'add-erf') this.addErf(btn.dataset.kiosk, 1);
    else if (action === 'add-erf-n') this.addErf(btn.dataset.kiosk, Math.max(1, Math.round(this.settings.quickErven || 5)));
    else if (action === 'del-erf') this.deleteErf(btn.dataset.kiosk, btn.dataset.erf);
    else if (action === 'toggle-kiosk') {
      const k = this.kioskById(btn.dataset.kiosk);
      if (k) { k.collapsed = !k.collapsed; this.render(); }
    }
    else if (action === 'undo') this.undo();
    else if (action === 'redo') this.redo();
    else if (action === 'report') this.exportReport();
    else if (action === 'push-sld') this.pushToSLD();
  },

  // ─── SLD bridge: add the diversified feeder demand as an equivalent load ───
  // Lets the existing analyses (fault, load flow, cable sizing, duty check,
  // load diversity, transformer loading) include the reticulation demand.
  async pushToSLD() {
    const res = AppState.reticResults;
    const entries = ((res && res.minisubs) || []).filter(m => m.totalKVA > 0);
    if (!entries.length) {
      UI.alert('No diversified demand yet — add kiosks and erven first.');
      return;
    }
    // One equivalent load per minisub (each transformer carries its own
    // group's diversified demand). Existing bridge loads are updated in
    // place so repeated pushes track the latest demand.
    const msgs = [];
    let firstId = null;
    entries.forEach((m, i) => {
      const name = `Retic: ${m.name || m.minisubId}`;
      let comp = [...AppState.components.values()]
        .find(c => c.type === 'static_load' && c.props.name === name);
      const updated = !!comp;
      if (!comp) {
        comp = AppState.addComponent('static_load', 420 + (i % 4) * 100, 320 + Math.floor(i / 4) * 100);
        if (!comp) return;
        comp.props.name = name;
      }
      comp.props.rated_kva = m.totalKVA;
      comp.props.power_factor = 0.95;
      comp.props.demand_factor = 1.0;     // demand is already after-diversity
      comp.props.voltage_kv = 0.4;
      msgs.push(`${updated ? 'Updated' : 'Added'} "${name}" — ${m.totalKVA} kVA`);
      if (!firstId) firstId = comp.id;
    });
    AppState.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    await UI.alert(msgs.join('\n')
      + '\nWire each load to its supply bus to include the reticulation demand in your SLD studies.');
    this.deactivate();
    if (firstId && typeof Canvas !== 'undefined') {
      AppState.selectedIds = new Set([firstId]);
      Canvas.render();
    }
  },

  // ─── Rendering ───
  render() {
    if (!this._active) return;
    this.renderSettingsBar();
    this.renderKiosks();
    this.renderSummary();
  },

  renderSettingsBar() {
    const bar = document.getElementById('retic-settings-bar');
    if (!bar) return;
    const s = this.settings;
    const isHB = s.estimationMethod === 'Herman Beta';
    const classOpts = STANDARD_LOAD_CLASSES.map(c =>
      `<option value="${c.id}" ${s.loadClass === c.id ? 'selected' : ''}>${escHtml(c.label)}</option>`).join('');
    const methodOpts = ESTIMATION_METHODS.map(m =>
      `<option value="${m}" ${s.estimationMethod === m ? 'selected' : ''}>${m}</option>`).join('');
    const corrOpts = LOAD_CLASS_CORRECTIONS.map(m =>
      `<option value="${m}" ${s.correctionMethod === m ? 'selected' : ''}>${m}</option>`).join('');

    bar.innerHTML = `
      <div class="retic-field">
        <label>Estimation Method</label>
        <select data-action="setting" data-field="estimationMethod">${methodOpts}</select>
      </div>
      <div class="retic-field">
        <label>Correction (Empirical)</label>
        <select data-action="setting" data-field="correctionMethod" ${isHB ? 'disabled' : ''}>${corrOpts}</select>
      </div>
      <div class="retic-field">
        <label>Default Load Class</label>
        <select data-action="setting" data-field="loadClass">${classOpts}</select>
      </div>
      <div class="retic-field">
        <label>Default ADMD (kVA)</label>
        <input type="number" step="0.01" data-action="setting" data-field="admd" value="${s.admd}" ${isHB ? 'disabled' : ''} title="${isHB ? 'ADMD is derived from the load class in Herman-Beta' : 'Empirical per-consumer ADMD'}">
      </div>
      <div class="retic-field">
        <label>Risk z (Herman-Beta)</label>
        <input type="number" step="0.01" min="0.5" max="4" data-action="setting" data-field="riskZ" value="${s.riskZ}" ${isHB ? '' : 'disabled'}
          title="Design risk factor: the standard-normal z in I = Nµ + z√Nσ — the probability that actual maximum demand exceeds the design value.\nz = 1.28 → 10% risk (NRS 034-1 convention)\nz = 1.64 → 5% risk\nz = 2.33 → 1% risk\nHigher z = more conservative design. Herman-Beta only — the Empirical method carries its margin in the ADMD and correction factors.">
        <span class="retic-hint">${this._riskHint(s.riskZ)}</span>
      </div>
      <div class="retic-field">
        <label>Max Feeder VD (%)</label>
        <input type="number" step="0.5" data-action="setting" data-field="maxFeederVD" value="${s.maxFeederVD}">
      </div>
      <div class="retic-field">
        <label>Max Service VD (%)</label>
        <input type="number" step="0.5" data-action="setting" data-field="maxRunVD" value="${s.maxRunVD}">
      </div>
      <div class="retic-totals">
        <div class="retic-chip"><span class="val" id="retic-total-kva">—</span><span class="lbl">Total kVA</span></div>
        <div class="retic-chip"><span class="val" id="retic-total-a">—</span><span class="lbl">Current A</span></div>
        <div class="retic-chip"><span class="val" id="retic-total-conns">—</span><span class="lbl">Conns</span></div>
      </div>`;
  },

  // Human-readable meaning of the Herman-Beta risk factor: the standard-normal
  // exceedance probability for z (Abramowitz–Stegun 26.2.17 approximation).
  _riskHint(z) {
    if (!(z > 0)) return '';
    const t = 1 / (1 + 0.2316419 * z);
    const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937
      + t * (-1.821255978 + t * 1.330274429))));
    const riskPct = p * 100;
    if (riskPct < 0.1) return '≈ <0.1% risk of exceedance (>99.9% confidence)';
    const dp = riskPct < 10 ? 1 : 0;
    return `≈ ${riskPct.toFixed(dp)}% risk of exceedance (${(100 - riskPct).toFixed(dp)}% confidence)`;
  },

  // Reticulation is 230/400 V, so list LV cables first; MV kept selectable
  // below for the odd mixed library, but they're rarely what's wanted here.
  _cableOptions(selected) {
    const opt = (c) =>
      `<option value="${escHtml(c.name)}" ${selected === c.name ? 'selected' : ''}>${escHtml(c.name)}</option>`;
    const lv = STANDARD_CABLES.filter(c => !(c.voltage_kv > 1)).map(opt).join('');
    const mv = STANDARD_CABLES.filter(c => c.voltage_kv > 1).map(opt).join('');
    return '<option value="">— select —</option>'
      + (lv ? `<optgroup label="LV (≤1 kV)">${lv}</optgroup>` : '')
      + (mv ? `<optgroup label="MV">${mv}</optgroup>` : '');
  },

  // Quick Build panel: one click builds N kiosks × M erven with the chosen
  // service/feeder cables and the worst-case service length — the typical
  // "rough out the network fast" workflow.
  _quickBuildBar() {
    const s = this.settings;
    return `
      <div class="retic-quickbuild">
        <span class="qb-title" title="Bulk-build the network: adds the kiosks and erven below in one step (one undo). The same cable/length defaults are used by + Erf and + N Erven.">⚡ Quick Build</span>
        <div class="retic-field"><label>Kiosks</label>
          <input type="number" step="1" min="1" data-action="setting" data-field="quickKiosks" value="${Number(s.quickKiosks) || 1}"></div>
        <div class="retic-field"><label>Erven / Kiosk</label>
          <input type="number" step="1" min="0" data-action="setting" data-field="quickErven" value="${Number(s.quickErven) || 0}"></div>
        <div class="retic-field"><label>Service Cable</label>
          <select data-action="setting" data-field="quickServiceCable">${this._cableOptions(s.quickServiceCable)}</select></div>
        <div class="retic-field"><label>Service Len (m)</label>
          <input type="number" step="1" min="1" data-action="setting" data-field="quickServiceLen" value="${Number(s.quickServiceLen) || 0}" title="Worst-case (longest) service run — applied to every erf so the VD check covers the worst stand"></div>
        <div class="retic-field"><label>Feeder Cable</label>
          <select data-action="setting" data-field="quickFeederCable">${this._cableOptions(s.quickFeederCable)}</select></div>
        <div class="retic-field"><label>Feeder Len (m)</label>
          <input type="number" step="1" min="0" data-action="setting" data-field="quickFeederLen" value="${Number(s.quickFeederLen) || 0}"></div>
        <div class="retic-field"><label>Feed From</label>
          <select data-action="setting" data-field="quickFeedFrom" title="Minisub the new kiosks feed from — ADMD diversity is applied per minisub across its downstream loads">${
            this.minisubs.map(m => `<option value="${m.id}" ${s.quickFeedFrom === m.id ? 'selected' : ''}>${escHtml(m.name)}</option>`).join('')
          }</select></div>
        <label class="qb-chain" title="Checked: each kiosk is fed from the previous one (chain continues from the selected minisub's last kiosk). Unchecked: every kiosk is fed directly from the minisub.">
          <input type="checkbox" data-action="setting" data-field="quickChain" ${s.quickChain ? 'checked' : ''}> Daisy-chain</label>
        <button class="retic-btn primary" data-action="quick-build">Build →</button>
      </div>`;
  },

  renderKiosks() {
    const host = document.getElementById('retic-kiosks');
    if (!host) return;
    const toolbar = `
      <div class="retic-toolbar">
        <button class="retic-btn primary" data-action="add-kiosk">+ Add Kiosk</button>
        <button class="retic-btn" data-action="undo" title="Undo (reticulation)">↶ Undo</button>
        <button class="retic-btn" data-action="redo" title="Redo (reticulation)">Redo ↷</button>
        <button class="retic-btn" data-action="report" title="Export demand + cable schedule">Export Report</button>
      </div>` + this._quickBuildBar();

    if (this.kiosks.length === 0) {
      host.innerHTML = toolbar + `<div class="retic-empty">No kiosks yet. Use ⚡ Quick Build to rough out the whole network in one click, or add a kiosk and its erven (stands) manually.</div>`;
      return;
    }

    const s = this.settings;
    const classOptsFor = (sel) => {
      const def = `<option value="" ${!sel ? 'selected' : ''}>Default (${escHtml(this._classLabel(s.loadClass))})</option>`;
      return def + STANDARD_LOAD_CLASSES.map(c =>
        `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${escHtml(c.label)}</option>`).join('');
    };
    const fedFromOptsFor = (k) => {
      // Legacy/unknown parents resolve to the first minisub (matches backend)
      const known = this.minisubs.some(m => m.id === k.fedFrom)
        || this.kiosks.some(o => o.id === k.fedFrom && o.id !== k.id);
      const sel = known ? k.fedFrom : this.minisubs[0].id;
      const ms = this.minisubs.map(m =>
        `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${escHtml(m.name)}</option>`).join('');
      const kk = this.kiosks.filter(o => o.id !== k.id).map(o =>
        `<option value="${o.id}" ${sel === o.id ? 'selected' : ''}>${escHtml(o.name)}</option>`).join('');
      return `<optgroup label="Minisubs">${ms}</optgroup>`
        + (kk ? `<optgroup label="Kiosks">${kk}</optgroup>` : '');
    };

    host.innerHTML = toolbar + this.kiosks.map(k => {
      const erfRows = k.erfs.map(e => this._erfRow(k, e)).join('');
      return `
      <div class="kiosk-card" data-kiosk="${k.id}">
        <div class="kiosk-head" data-action="toggle-kiosk" data-kiosk="${k.id}">
          <span class="toggle">${k.collapsed ? '▸' : '▾'}</span>
          <input class="kiosk-name" data-action="kiosk-field" data-kiosk="${k.id}" data-field="name" value="${escHtml(k.name)}" onclick="event.stopPropagation()">
          <span class="kiosk-demand-badge" data-kiosk="${k.id}">— kVA</span>
          <button class="btn-icon-del" data-action="del-kiosk" data-kiosk="${k.id}" title="Delete kiosk">&times;</button>
        </div>
        ${k.collapsed ? '' : `
        <div class="kiosk-body">
          <div class="kiosk-meta">
            <div class="retic-field"><label>Fed From</label>
              <select data-action="kiosk-field" data-kiosk="${k.id}" data-field="fedFrom">${fedFromOptsFor(k)}</select></div>
            <div class="retic-field"><label>Load Class</label>
              <select data-action="kiosk-field" data-kiosk="${k.id}" data-field="loadClass">${classOptsFor(k.loadClass)}</select></div>
            <div class="retic-field"><label>ADMD Override (kVA)</label>
              <input type="number" step="0.01" data-action="kiosk-field" data-kiosk="${k.id}" data-field="admdOverride" value="${k.admdOverride || ''}" placeholder="${s.admd}"></div>
            <div class="retic-field"><label>Street Lighting (kVA)</label>
              <input type="number" step="0.1" data-action="kiosk-field" data-kiosk="${k.id}" data-field="streetLightKVA" value="${k.streetLightKVA || ''}" placeholder="0" title="Fixed, undiversified street-lighting load"></div>
            <div class="retic-field"><label>Feeder Cable</label>
              <select data-action="kiosk-field" data-kiosk="${k.id}" data-field="feederCable">${this._cableOptions(k.feederCable)}</select></div>
            <div class="retic-field"><label>Feeder Length (m)</label>
              <input type="number" step="1" data-action="kiosk-field" data-kiosk="${k.id}" data-field="feederLength" value="${k.feederLength || ''}"></div>
          </div>
          <table class="erf-table">
            <thead><tr><th>Erf #</th><th>Length (m)</th><th>Phase</th><th>Service Cable</th><th>Amps Override</th><th>Service VD</th><th></th></tr></thead>
            <tbody>${erfRows}</tbody>
          </table>
          <div class="retic-toolbar" style="margin-top:8px">
            <button class="retic-btn" data-action="add-erf" data-kiosk="${k.id}">+ Erf</button>
            <button class="retic-btn" data-action="add-erf-n" data-kiosk="${k.id}" title="Batch size follows the Quick Build 'Erven / Kiosk' setting">+ ${Math.max(1, Math.round(Number(s.quickErven) || 5))} Erven</button>
          </div>
        </div>`}
      </div>`;
    }).join('');

    this.updateBadges();
  },

  _erfRow(k, e) {
    const phaseOpts = this.PHASES.map(p =>
      `<option value="${p.id}" ${e.phase === p.id ? 'selected' : ''}>${p.id}</option>`).join('');
    return `
      <tr data-erf="${e.id}">
        <td><input type="text" data-action="erf-field" data-kiosk="${k.id}" data-erf="${e.id}" data-field="erfNumber" value="${escHtml(e.erfNumber || '')}"></td>
        <td><input type="number" step="1" data-action="erf-field" data-kiosk="${k.id}" data-erf="${e.id}" data-field="length" value="${e.length || ''}"></td>
        <td><select data-action="erf-field" data-kiosk="${k.id}" data-erf="${e.id}" data-field="phase">${phaseOpts}</select></td>
        <td><select data-action="erf-field" data-kiosk="${k.id}" data-erf="${e.id}" data-field="cableType">${this._cableOptions(e.cableType)}</select></td>
        <td><input type="number" step="1" data-action="erf-field" data-kiosk="${k.id}" data-erf="${e.id}" data-field="ampsOverride" value="${e.ampsOverride || ''}" placeholder="0"></td>
        <td class="vd-cell" data-erf-vd="${e.id}">—</td>
        <td><button class="btn-icon-del" data-action="del-erf" data-kiosk="${k.id}" data-erf="${e.id}" title="Delete erf">&times;</button></td>
      </tr>`;
  },

  _classLabel(id) {
    const c = STANDARD_LOAD_CLASSES.find(x => x.id === id);
    return c ? c.label : id;
  },

  // ─── Demand computation (backend) ───
  recompute() {
    if (!this._active) return;
    clearTimeout(this._computeTimer);
    this._computeTimer = setTimeout(() => this._doCompute(), 250);
  },

  async _doCompute() {
    const s = this.settings;
    const payload = {
      estimationMethod: s.estimationMethod,
      correctionMethod: s.correctionMethod,
      loadClass: s.loadClass,
      admd: s.admd,
      riskZ: s.riskZ,
      networkDiversity: s.networkDiversity,
      loadClassLib: STANDARD_LOAD_CLASSES,
    };
    try {
      const res = await API.runAdmd(payload, this.kiosks, this.minisubs);
      AppState.reticResults = res;
      this.updateBadges();
      this.updateVD();
      this.renderSummary();
    } catch (err) {
      console.error('ADMD compute failed:', err);
    }
  },

  updateBadges() {
    const res = AppState.reticResults;
    if (!res) return;
    const byId = {};
    for (const kr of res.kiosks) byId[kr.kioskId] = kr;
    document.querySelectorAll('.kiosk-demand-badge[data-kiosk]').forEach(el => {
      const kr = byId[el.dataset.kiosk];
      if (!kr) { el.textContent = '— kVA'; return; }
      el.innerHTML = `${kr.totalKVA} kVA <span class="sep">|</span> ${kr.currentA} A <span class="sep">|</span> ${kr.conns} conns <span class="sep">|</span> ADMD ${kr.admdKVA}`;
    });
    const tk = document.getElementById('retic-total-kva');
    const ta = document.getElementById('retic-total-a');
    const tc = document.getElementById('retic-total-conns');
    if (tk) tk.textContent = res.total.totalKVA;
    if (ta) ta.textContent = res.total.currentA;
    if (tc) tc.textContent = res.total.conns;
  },

  // ─── Voltage drop (client-side, per erf service cable) ───
  _cableRX(name) {
    const c = STANDARD_CABLES.find(x => x.name === name);
    return c ? { r: c.r_per_km, x: c.x_per_km, rating: c.rated_amps } : null;
  },

  // Per-consumer design current (A) from ADMD/class for a single erf.
  // Mirrors the backend engine (and the source app's getErfVD): the single-
  // consumer design kVA divided by the service voltage of the erf's phase.
  _erfDesignAmps(k, e) {
    if (e.ampsOverride && e.ampsOverride > 0) return e.ampsOverride;
    const s = this.settings;
    const is3ph = e.phase === '3 Phase';
    const clsId = k.loadClass || s.loadClass;
    if (s.estimationMethod === 'Herman Beta') {
      const cls = STANDARD_LOAD_CLASSES.find(c => c.id === clsId)
        || STANDARD_LOAD_CLASSES[2] || STANDARD_LOAD_CLASSES[0];
      const z = s.riskZ || 1.28;
      let designI;
      if (cls.a > 0 && cls.b > 0 && cls.c > 0) {
        // Beta(α,β)·c → µ,σ,γ₁ with Cornish-Fisher-corrected z at N=1
        // (same formulae as backend beta_params/herman_beta_demand).
        const ab = cls.a + cls.b;
        const mean = cls.a / ab * cls.c;
        const sigma = cls.c * Math.sqrt(cls.a * cls.b / (ab * ab * (ab + 1)));
        const skew = 2 * (cls.b - cls.a) * Math.sqrt(ab + 1) / ((ab + 2) * Math.sqrt(cls.a * cls.b));
        const zcf = z + (z * z - 1) / 6 * skew;
        designI = mean + zcf * sigma;
      } else {
        // Custom class without valid Beta params: Normal approximation.
        designI = (cls.mu || 0) + z * (cls.sigma || 0);
      }
      const kva = designI * 230 * (Number(cls.phase) === 3 ? 3 : 1) / 1000;
      return kva * 1000 / (is3ph ? Math.sqrt(3) * 400 : 230);
    }
    const admd = (k.admdOverride && k.admdOverride > 0) ? k.admdOverride : s.admd;
    return admd * 1000 / (is3ph ? Math.sqrt(3) * 400 : 230);
  },

  // Volt drop % for a cable run at a given current and length.
  // Deliberate deviations from the source app's simpler VD: this uses the
  // full R·cosφ + X·sinφ impedance drop (pf 0.95) instead of R-only, and no
  // snaking/additional-length allowances are added — enter total run length.
  _vdPercent(cableName, amps, lengthM, is3ph) {
    const rx = this._cableRX(cableName);
    if (!rx || !lengthM || !amps) return null;
    const pf = 0.95, sinphi = Math.sqrt(1 - pf * pf);
    const Lkm = lengthM / 1000;
    const v = is3ph ? 400 : 230;
    const drop = (is3ph ? Math.sqrt(3) : 2) * amps * Lkm * (rx.r * pf + rx.x * sinphi);
    return drop / v * 100;
  },

  updateVD() {
    const limit = this.settings.maxRunVD;
    for (const k of this.kiosks) {
      for (const e of k.erfs) {
        const cell = document.querySelector(`.vd-cell[data-erf-vd="${e.id}"]`);
        if (!cell) continue;
        const is3ph = e.phase === '3 Phase';
        const amps = this._erfDesignAmps(k, e);
        const vd = this._vdPercent(e.cableType, amps, e.length, is3ph);
        if (vd == null) { cell.textContent = '—'; cell.className = 'vd-cell'; continue; }
        cell.textContent = vd.toFixed(2) + '%';
        cell.className = 'vd-cell ' + (vd > limit ? 'vd-fail' : 'vd-ok');
      }
    }
  },

  // ─── Summary panel (per-minisub demand + TX sizing, network total, VD) ───
  // ADMD diversity is applied per minisub across its downstream kiosks; the
  // network total is Σ minisub demands × the network diversity factor.
  renderSummary() {
    const host = document.getElementById('retic-summary');
    if (!host) return;
    const s = this.settings;
    const res = AppState.reticResults;

    // Per-minisub blocks (editable name, demand, suggested transformer).
    // Rendered even with no kiosks so minisubs can be set up before building.
    const msById = {};
    if (res && res.minisubs) for (const m of res.minisubs) msById[m.minisubId] = m;
    const msBlocks = this.minisubs.map(ms => {
      const r = msById[ms.id];
      const has = r && r.totalKVA > 0;
      const xfmr = has ? this._suggestTransformer(r.totalKVA) : null;
      return `
      <div class="summary-block minisub-block">
        <div class="ms-head">
          <input class="ms-name" data-action="minisub-field" data-ms="${ms.id}" data-field="name" value="${escHtml(ms.name)}" title="Minisub / transformer name">
          ${this.minisubs.length > 1 ? `<button class="btn-icon-del" data-action="del-minisub" data-ms="${ms.id}" title="Delete minisub (its kiosks move to the first minisub)">&times;</button>` : ''}
        </div>
        <div class="summary-row"><span class="k">Diversified demand</span><span class="v">${has ? r.totalKVA + ' kVA' : '—'}</span></div>
        <div class="summary-row"><span class="k">Current / Conns / Kiosks</span><span class="v">${has ? `${r.currentA} A / ${r.conns} / ${r.numKiosks}` : (r ? `— / ${r.conns} / ${r.numKiosks}` : '—')}</span></div>
        <div class="summary-row"><span class="k">Suggested TX</span><span class="v">${xfmr ? `${xfmr.label} (${xfmr.util}%)` : '—'}</span></div>
      </div>`;
    }).join('');

    // Network block: Σ minisubs × network diversity factor.
    const t = res && res.total;
    const multiMs = this.minisubs.length > 1;
    const networkBlock = `
      <div class="summary-block">
        <h3>Network Total</h3>
        ${multiMs ? `<div class="summary-row"><span class="k">Σ minisub demands</span><span class="v">${t ? (t.sumKVA != null ? t.sumKVA : t.totalKVA) + ' kVA' : '—'}</span></div>` : ''}
        <div class="summary-row"><span class="k">Network diversity ×</span><span class="v">
          <input type="number" class="ndf-input" step="0.01" min="0.1" data-action="setting" data-field="networkDiversity" value="${Number(s.networkDiversity) || 1}"
            title="Applied to the sum of the per-minisub diversified demands to estimate the combined network maximum demand (NMD / MV feeder). 1.0 = no additional network-level diversity."></span></div>
        <div class="summary-row big"><span class="k">Total after diversity</span><span class="v">${t ? t.totalKVA + ' kVA' : '—'}</span></div>
        <div class="summary-row"><span class="k">Design current</span><span class="v">${t ? t.currentA + ' A' : '—'}</span></div>
        <div class="summary-row"><span class="k">Connections</span><span class="v">${t ? t.conns : '—'}</span></div>
        <div class="summary-row"><span class="k">Method</span><span class="v">${res ? res.settings.estimationMethod : s.estimationMethod}</span></div>
      </div>`;

    // Per-kiosk feeder VD uses the subtree (downstream) current the segment
    // carries; cumulative VD sums segments from the minisub down to the kiosk.
    let feederBlock = '';
    if (res && this.kiosks.length) {
      const byId = {};
      for (const kr of res.kiosks) byId[kr.kioskId] = kr;
      const feederRows = res.kiosks.map(kr => {
        const cum = this._cumulativeFeederVD(kr.kioskId, byId);
        const cls = cum == null ? '' : (cum > this.settings.maxFeederVD ? 'fail' : 'pass');
        const vdTxt = cum == null ? '—' : cum.toFixed(2) + '%';
        const feederKva = kr.feederKVA != null ? kr.feederKVA : kr.totalKVA;
        return `<div class="summary-row"><span class="k">${escHtml(kr.name || 'Kiosk')} <span style="color:var(--text-muted)">(${feederKva} kVA feed)</span></span>
          <span class="v">${cum == null ? '—' : `<span class="status-pill ${cls}">${vdTxt}</span>`}</span></div>`;
      }).join('');
      feederBlock = `
      <div class="summary-block">
        <h3>Per-Kiosk Feeder VD (cumulative from minisub)</h3>
        ${feederRows || '<div class="retic-empty">—</div>'}
      </div>`;
    }

    host.innerHTML = `
      <div class="ms-toolbar">
        <h3>Minisubs</h3>
        <button class="retic-btn" data-action="add-minisub" title="Add a minisub / transformer source. ADMD diversity is applied per minisub across its downstream kiosks.">+ Minisub</button>
      </div>
      ${msBlocks}
      ${networkBlock}
      ${feederBlock}
      <div class="retic-toolbar">
        <button class="retic-btn primary" data-action="push-sld" title="Add each minisub's diversified demand to the SLD as an equivalent static load">Push demand to SLD →</button>
      </div>`;
  },

  // Cumulative feeder VD (%) from the source down to a kiosk: sum each segment
  // on the path, each carrying its own subtree current (feederA). Cycle-guarded.
  // Note: feederA is the diversified subtree current WITHOUT the UCF unbalance
  // factor — matching the source app, whose chain VD also uses the plain
  // diversified current (its UCF/feederCurrentA is display-only).
  _cumulativeFeederVD(kioskId, resById) {
    let total = 0, any = false, id = kioskId;
    const seen = new Set();
    while (id && id !== 'source' && !seen.has(id)) {
      seen.add(id);
      const k = this.kioskById(id);
      const kr = resById[id];
      if (k && kr) {
        const amps = kr.feederA != null ? kr.feederA : kr.currentA;
        const vd = this._vdPercent(k.feederCable, amps, k.feederLength, true);
        if (vd != null) { total += vd; any = true; }
        id = k.fedFrom || 'source';
      } else break;
    }
    return any ? total : null;
  },

  _suggestTransformer(demandKVA) {
    if (!demandKVA) return null;
    // Distribution transformers only (LV secondary)
    const sizes = STANDARD_TRANSFORMERS
      .filter(x => x.voltage_lv_kv <= 1)
      .map(x => ({ kva: x.rated_mva * 1000, label: x.name }))
      .sort((a, b) => a.kva - b.kva);
    const pick = sizes.find(s => s.kva >= demandKVA) || sizes[sizes.length - 1];
    if (!pick) return null;
    return { label: pick.label, util: Math.round(demandKVA / pick.kva * 100) };
  },

  // Called by AppState.reset()/fromJSON() whenever the project (and with it
  // AppState.reticulation) is replaced: drop the local undo history so Undo
  // can't restore a previous project's reticulation, and refresh the view.
  onProjectChanged() {
    this._undoStack = [];
    this._undoIndex = -1;
    this._snapshot(); // new baseline
    if (this._active) {
      this.render();
      this.recompute();
    }
  },

  // ─── Local undo/redo (reticulation only) ───
  _snapshot() {
    const snap = JSON.stringify(this.state);
    if (this._undoStack[this._undoIndex] === snap) return; // no actual change
    if (this._undoIndex < this._undoStack.length - 1) {
      this._undoStack.splice(this._undoIndex + 1);
    }
    this._undoStack.push(snap);
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._undoIndex = this._undoStack.length - 1;
  },

  undo() {
    if (this._undoIndex <= 0) return;
    this._undoIndex--;
    this._restore(this._undoStack[this._undoIndex]);
  },

  redo() {
    if (this._undoIndex >= this._undoStack.length - 1) return;
    this._undoIndex++;
    this._restore(this._undoStack[this._undoIndex]);
  },

  _restore(json) {
    AppState.reticulation = JSON.parse(json);
    this._markDirty();
    this.render();
    this.recompute();
  },

  // ─── Report export (delegates to ReticReport if present) ───
  exportReport() {
    if (typeof ReticReport !== 'undefined' && ReticReport.export) {
      ReticReport.export();
    } else {
      UI.alert('Report export is not available.');
    }
  },
};
