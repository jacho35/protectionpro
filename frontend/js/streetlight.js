/* ProtectionPro — Street lighting workspace (Reticulation).
 *
 * A street lighting circuit is a tree of poles fed from a kiosk or a minisub:
 * a 4-core 3Φ cable with each pole tapped onto the next phase in turn
 * (R → W → B, a spur carrying on from its tee pole), or a 2-core 1Φ string.
 * The backend engine (/api/analysis/street-lighting, analysis/street_lighting.py)
 * solves it with phasors — per-pole volt drop from the source, cumulative drop
 * including the supply's, earth-loop Zs against the device's disconnection
 * current, phase balance, the max-poles solver and the smallest passing cable.
 *
 * State: AppState.reticulation.streetLighting = { settings, circuits, seqs }.
 * Results are on demand (this._results, never saved). Each circuit's kVA is
 * written into its source's fixed street-lighting load (kiosk / minisub
 * `streetLightKVA`, flagged `streetLightFromCircuits`) so Demand carries it.
 */

// Luminaires (W, pf). Built in for now — a layered library kind is in BACKLOG.
const SL_LUMINAIRES = [
  { id: 'led30', name: 'LED 30 W', watts: 30, pf: 0.95 },
  { id: 'led40', name: 'LED 40 W', watts: 40, pf: 0.95 },
  { id: 'led50', name: 'LED 50 W', watts: 50, pf: 0.95 },
  { id: 'led70', name: 'LED 70 W', watts: 70, pf: 0.95 },
  { id: 'led100', name: 'LED 100 W', watts: 100, pf: 0.95 },
  { id: 'led150', name: 'LED 150 W', watts: 150, pf: 0.95 },
  { id: 'led200', name: 'LED 200 W', watts: 200, pf: 0.95 },
  { id: 'hps70', name: 'HPS 70 W', watts: 70, pf: 0.85 },
  { id: 'hps150', name: 'HPS 150 W', watts: 150, pf: 0.85 },
  { id: 'hps250', name: 'HPS 250 W', watts: 250, pf: 0.85 },
  { id: 'hps400', name: 'HPS 400 W', watts: 400, pf: 0.85 },
];

// Protective device at the source → its disconnection current Ia (A).
// MCBs: the instantaneous-trip upper limit (B 5·In, C 10·In, IEC 60898-1).
// gG fuses: approximate 5 s current (street lighting = distribution circuit,
// 5 s allowed) — check the fuse maker's curve; "Custom" takes any Ia.
const SL_PROTECTION = [
  { id: 'B6', name: 'MCB B6', ia: 30 },
  { id: 'B10', name: 'MCB B10', ia: 50 },
  { id: 'B16', name: 'MCB B16', ia: 80 },
  { id: 'B20', name: 'MCB B20', ia: 100 },
  { id: 'C10', name: 'MCB C10', ia: 100 },
  { id: 'C16', name: 'MCB C16', ia: 160 },
  { id: 'C20', name: 'MCB C20', ia: 200 },
  { id: 'gG10', name: 'Fuse 10 A gG, 5 s', ia: 47 },
  { id: 'gG16', name: 'Fuse 16 A gG, 5 s', ia: 65 },
  { id: 'gG20', name: 'Fuse 20 A gG, 5 s', ia: 85 },
  { id: 'gG25', name: 'Fuse 25 A gG, 5 s', ia: 110 },
  { id: 'gG32', name: 'Fuse 32 A gG, 5 s', ia: 150 },
  { id: 'custom', name: 'Custom Ia…', ia: null },
];

const StreetLight = {
  _active: false,
  _built: false,
  _selId: null,
  _results: {},          // circuit id → engine result (not saved)
  _timer: null,
  _req: 0,
  _qc: null,             // quick-calc inputs
  _qcRes: null,
  _qcTimer: null,

  PH_COLOR: { R: '#c62828', W: '#6b7280', B: '#1565c0' },
  FAIL_TEXT: { vd: 'VD', cumVd: 'Cum VD', zs: 'Zs', rating: 'Rating', cable: 'No cable' },
  LIMIT_TEXT: {
    vd: 'volt drop from the source', cumVd: 'cumulative volt drop (supply + circuit)',
    zs: 'earth loop impedance (Zs)', rating: 'cable current rating', cable: 'no cable picked',
  },

  // ─── Data ────────────────────────────────────────────────────────────
  get data() {
    const R = AppState.reticulation;
    if (!R.streetLighting) R.streetLighting = AppState._defaultStreetLighting();
    return R.streetLighting;
  },
  get defaults() { return this.data.settings; },
  get circuits() { return this.data.circuits; },
  circuit(id) { return this.circuits.find(c => c.id === id) || null; },
  get selected() { return this.circuit(this._selId); },

  _lum(id) { return SL_LUMINAIRES.find(l => l.id === id) || SL_LUMINAIRES.find(l => l.id === this.defaults.luminaireId) || SL_LUMINAIRES[3]; },
  _prot(id) { return SL_PROTECTION.find(p => p.id === id) || SL_PROTECTION[1]; },
  _num(v, d) { const x = parseFloat(v); return isFinite(x) ? x : d; },
  _blank(v) { return v === null || v === undefined || v === ''; },

  _genCircuitId() { return 'slc_' + (this.data._circSeq++); },
  _genPoleId() { return 'slp_' + (this.data._poleSeq++); },

  _sourceKey(src) { return src ? `${src.kind}:${src.id}` : ''; },
  _sourceName(src) {
    if (!src) return '—';
    const R = AppState.reticulation;
    const row = src.kind === 'minisub' ? R.minisubs.find(m => m.id === src.id) : R.kiosks.find(k => k.id === src.id);
    return row ? row.name : '(missing source)';
  },
  _sources() {
    const R = AppState.reticulation;
    return [
      ...R.minisubs.map(m => ({ kind: 'minisub', id: m.id, name: m.name })),
      ...R.kiosks.map(k => ({ kind: 'kiosk', id: k.id, name: k.name })),
    ];
  },
  _defaultSource() {
    const R = AppState.reticulation;
    return R.kiosks.length ? { kind: 'kiosk', id: R.kiosks[0].id } : { kind: 'minisub', id: R.minisubs[0].id };
  },

  _markDirty() { AppState.dirty = true; },

  // ─── Workspace ──────────────────────────────────────────────────────
  init() {
    this.buildDOM();
  },

  buildDOM() {
    const ws = document.getElementById('streetlight-workspace');
    if (!ws || this._built) return;
    this._built = true;
    ws.innerHTML = `
      <div class="sl-toolbar">
        <span class="sl-title">Street lighting</span>
        <span class="sl-sep"></span>
        <button class="btn-small btn-primary" data-sl="new">+ New circuit</button>
        <button class="btn-small" data-sl="quick" title="Size a uniform string before drawing it — save it as a circuit when it works">Quick calc</button>
        <button class="btn-small" data-sl="sync" title="Create / update circuits from the Plan's street-lighting routes (poles, spans and spurs)">Sync from plan</button>
        <span class="sl-sep"></span>
        <label title="Volt-drop limit measured from the source kiosk or minisub">VD from source
          <input type="number" step="0.5" data-df="vdLimitPct"> %</label>
        <label title="Limit on the supply's drop at the source (from Demand) plus the circuit's own drop">Cumulative
          <input type="number" step="0.5" data-df="cumVdLimitPct"> %</label>
        <label title="Added to every span for snaking in the trench">Snaking
          <input type="number" step="0.5" data-df="snakingPct"> %</label>
        <label title="Extra cable per pole to loop into the pole base and back">Loop-in
          <input type="number" step="0.5" data-df="loopInM"> m</label>
        <span class="sl-status" id="sl-status"></span>
      </div>
      <div class="sl-body">
        <aside class="sl-rail">
          <div class="sl-rail-head">Circuits</div>
          <div id="sl-rail-list" class="sl-rail-list"></div>
          <div class="sl-rail-foot">Each circuit's load goes to its kiosk or minisub as fixed street-lighting kVA in Demand.</div>
        </aside>
        <section class="sl-main" id="sl-main"></section>
        <aside class="sl-results" id="sl-results"></aside>
      </div>`;
    ws.addEventListener('click', (e) => this._onClick(e));
    ws.addEventListener('change', (e) => this._onChange(e));
  },

  activate() {
    this._active = true;
    this.buildDOM();
    const tb = document.getElementById('toolbar');
    const ws = document.getElementById('streetlight-workspace');
    if (tb && ws) ws.style.top = tb.offsetHeight + 'px';
    if (!this.selected) this._selId = this.circuits.length ? this.circuits[0].id : null;
    this.render();
    this.recompute(0);
  },

  deactivate() {
    this._active = false;
    clearTimeout(this._timer);
  },

  // Called when the project is replaced (AppState.reset / fromJSON).
  onProjectChanged() {
    this._results = {};
    this._selId = null;
    if (this._active) { this._selId = this.circuits.length ? this.circuits[0].id : null; this.render(); this.recompute(0); }
  },

  // ─── Mutations ──────────────────────────────────────────────────────
  // A starting cable when none is set: the project default, else a common
  // street-lighting size where the library has it.
  _defaultCable(system) {
    const cab = CableLib.byName(this.defaults.cable);
    if (cab && (system === '1ph' || Number(CableLib.normalize(cab).cores) >= 4)) return cab.name;
    const names = system === '1ph' ? ['10mm² 2c Cu PVC LV', '16mm² 2c Cu XLPE LV'] : ['16mm² Cu PVC LV', '16mm² Cu XLPE LV'];
    for (const n of names) if (CableLib.byName(n)) return n;
    return '';
  },

  _newCircuit(src, init = {}) {
    const d = this.defaults;
    const n = this.circuits.filter(c => this._sourceKey(c.source) === this._sourceKey(src)).length + 1;
    const base = this._sourceName(src).replace(/\s+/g, '');
    return Object.assign({
      id: this._genCircuitId(),
      name: `SL-${base}-${String(n).padStart(2, '0')}`,
      source: src,
      system: d.system || '3ph',
      phaseStart: 'R',
      singlePhase: 'R',
      cable: this._defaultCable(init.system || d.system || '3ph'),
      luminaireId: d.luminaireId,
      protection: d.protection,
      iaCustom: null,
      spacingM: d.spacingM,
      zeOhm: null,          // null = estimated from the transformer + feeders
      supplyVdPct: null,    // null = the Demand feeder VD at the source
      poles: [],
    }, init);
  },

  _addPoles(c, count, parentId) {
    let parent = parentId !== undefined ? parentId : (c.poles.length ? c.poles[c.poles.length - 1].id : null);
    for (let i = 0; i < count; i++) {
      const p = { id: this._genPoleId(), name: this._nextPoleName(c), parent, spacingM: null, luminaireId: null, phase: null };
      c.poles.push(p);
      parent = p.id;
    }
  },
  _nextPoleName(c) {
    let max = 0;
    for (const p of c.poles) { const m = /^P(\d+)$/.exec(p.name || ''); if (m) max = Math.max(max, +m[1]); }
    return 'P' + String(max + 1).padStart(2, '0');
  },
  _deletePole(c, pid) {
    const i = c.poles.findIndex(p => p.id === pid);
    if (i < 0) return;
    const parent = c.poles[i].parent || null;
    c.poles.splice(i, 1);
    for (const p of c.poles) if (p.parent === pid) p.parent = parent;
  },

  newCircuit() {
    const c = this._newCircuit(this._defaultSource());
    this._addPoles(c, 10, null);
    this.circuits.push(c);
    this._selId = c.id;
    this._afterMutate(true);
  },

  async deleteCircuit(id) {
    const c = this.circuit(id);
    if (!c) return;
    const ok = await UI.confirm(`Delete circuit ${c.name}?`);
    if (!ok) return;
    this.circuits.splice(this.circuits.indexOf(c), 1);
    delete this._results[id];
    if (this._selId === id) this._selId = this.circuits.length ? this.circuits[0].id : null;
    this._afterMutate(true);
  },

  duplicateCircuit(id) {
    const c = this.circuit(id);
    if (!c) return;
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = this._genCircuitId();
    copy.name = c.name + ' (copy)';
    delete copy.planKey;
    const map = {};
    for (const p of copy.poles) { map[p.id] = this._genPoleId(); delete p.planId; }
    for (const p of copy.poles) { p.id = map[p.id]; if (p.parent) p.parent = map[p.parent] || null; }
    this.circuits.push(copy);
    this._selId = copy.id;
    this._afterMutate(true);
  },

  _afterMutate(rerender) {
    this._markDirty();
    this._syncSourceLoads();
    if (rerender) this.render();
    else this.renderRail();
    this.recompute();
  },

  // Each source's fixed street-lighting load = Σ its circuits' kVA. Written to
  // the kiosk / minisub (flagged so Demand shows it as derived and Plan sync
  // leaves it alone); a source that loses its last circuit goes back to 0.
  _syncSourceLoads() {
    const R = AppState.reticulation;
    const tot = {};
    for (const c of this.circuits) {
      const k = this._sourceKey(c.source);
      tot[k] = (tot[k] || 0) + this.circuitKVA(c);
    }
    const apply = (row, key) => {
      if (tot[key] != null) {
        row.streetLightKVA = +tot[key].toFixed(3);
        row.streetLightFromCircuits = true;
      } else if (row.streetLightFromCircuits) {
        row.streetLightKVA = 0;
        delete row.streetLightFromCircuits;
      }
    };
    for (const k of R.kiosks) apply(k, 'kiosk:' + k.id);
    for (const m of R.minisubs) apply(m, 'minisub:' + m.id);
  },

  circuitKVA(c) {
    let kva = 0;
    for (const p of c.poles) { const l = this._lum(p.luminaireId || c.luminaireId); kva += l.watts / l.pf / 1000; }
    return kva;
  },

  // ─── Source data: Ze and supply VD ──────────────────────────────────
  // Ze at the source, estimated as the transformer's own impedance (per phase,
  // Dyn: Z0 ≈ Z1 so the earth-fault loop ≈ Z1) plus the phase + neutral loop
  // of every feeder leg from the minisub down to the kiosk. Needs the
  // minisub's transformer (picked or auto-sized in Demand).
  _zeEstimate(src) {
    if (!src || typeof Retic === 'undefined') return null;
    const R = AppState.reticulation;
    const legs = [];
    let msId = null;
    if (src.kind === 'minisub') msId = src.id;
    else {
      const seen = new Set();
      let id = src.id;
      while (id && !seen.has(id)) {
        seen.add(id);
        const k = R.kiosks.find(x => x.id === id);
        if (!k) { msId = id; break; }
        legs.push(k);
        id = k.fedFrom || 'source';
      }
      if (!R.minisubs.some(m => m.id === msId)) msId = R.minisubs[0].id;
    }
    const ms = R.minisubs.find(m => m.id === msId);
    const res = AppState.reticResults;
    const msRes = res && res.minisubs && res.minisubs.find(x => x.minisubId === msId);
    const tx = ms && Retic._minisubTx(ms, msRes ? msRes.totalKVA : 0);
    if (!tx) return null;
    const e = tx.entry;
    let z = (e.z_percent / 100) * (400 * 400) / (e.rated_mva * 1e6);
    let missing = 0;
    for (const k of legs) {
      const cab = CableLib.byName(k.feederCable);
      if (cab && k.feederLength) z += 2 * Math.hypot(cab.r_per_km, cab.x_per_km) * k.feederLength / 1000;
      else missing++;
    }
    return { value: z, basis: `${e.name}${legs.length ? ` + ${legs.length} feeder leg(s)` : ''}${missing ? ` (${missing} without cable/length)` : ''}` };
  },
  _ze(c) {
    if (!this._blank(c.zeOhm)) return { value: this._num(c.zeOhm, 0), auto: false, basis: 'entered' };
    const est = this._zeEstimate(c.source);
    return est ? { value: est.value, auto: true, basis: est.basis } : { value: 0, auto: true, basis: 'no transformer in Demand — enter Ze' };
  },
  _supplyVd(c) {
    if (!this._blank(c.supplyVdPct)) return { value: this._num(c.supplyVdPct, 0), auto: false, basis: 'entered' };
    if (!c.source || c.source.kind === 'minisub') return { value: 0, auto: true, basis: 'minisub LV board' };
    const res = AppState.reticResults;
    if (!res || !res.kiosks || typeof Retic === 'undefined') return { value: 0, auto: true, basis: 'open Demand to calculate' };
    const byId = {};
    for (const kr of res.kiosks) byId[kr.kioskId] = kr;
    const vd = Retic._cumulativeFeederVD(c.source.id, byId);
    return vd == null ? { value: 0, auto: true, basis: 'no feeder cable/length in Demand' } : { value: vd, auto: true, basis: 'Demand feeder VD' };
  },
  _ia(c) {
    const p = this._prot(c.protection);
    return p.id === 'custom' ? this._num(c.iaCustom, 0) : p.ia;
  },

  _cablePayload(name) {
    const cab = CableLib.byName(name);
    if (!cab) return { name: name || '', r: 0, x: 0, ratedA: 0, cores: 0 };
    return { name: cab.name, r: cab.r_per_km, x: cab.x_per_km, ratedA: cab.rated_amps || 0, cores: Number(CableLib.normalize(cab).cores) || 0 };
  },

  _payload(c) {
    const d = this.defaults;
    const lum = this._lum(c.luminaireId);
    return {
      id: c.id, name: c.name,
      system: c.system, phaseStart: c.phaseStart, singlePhase: c.singlePhase,
      cable: this._cablePayload(c.cable),
      luminaire: { name: lum.name, watts: lum.watts, pf: lum.pf },
      spacingM: this._num(c.spacingM, d.spacingM),
      snakingPct: this._num(d.snakingPct, 0), loopInM: this._num(d.loopInM, 0),
      zeOhm: this._ze(c).value, supplyVdPct: this._supplyVd(c).value,
      vdLimitPct: this._num(d.vdLimitPct, 5), cumVdLimitPct: this._num(d.cumVdLimitPct, 10),
      protection: { iaA: this._ia(c) },
      poles: c.poles.map(p => {
        const o = { id: p.id, name: p.name, parent: p.parent || null, phase: p.phase || null,
          spacingM: this._blank(p.spacingM) ? null : this._num(p.spacingM, null) };
        if (p.luminaireId) { const l = this._lum(p.luminaireId); o.watts = l.watts; o.pf = l.pf; }
        return o;
      }),
    };
  },

  _candidateCables() {
    return CableLib.all().map(c => CableLib.normalize(c))
      .filter(c => CableLib.isDistribution(c) && !CableLib.isMV(c) && c.r_per_km > 0)
      .map(c => ({ name: c.name, r: c.r_per_km, x: c.x_per_km, ratedA: c.rated_amps || 0, cores: Number(c.cores) || 0 }));
  },

  // ─── Compute ────────────────────────────────────────────────────────
  recompute(delay = 300) {
    if (!this._active) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._doCompute(), delay);
  },

  async _doCompute() {
    const circuits = this.circuits.filter(c => c.poles.length);
    if (!circuits.length) { this._results = {}; this.renderRail(); this.renderResults(); return; }
    const token = ++this._req;
    this._status('Calculating…');
    try {
      const res = await API.runStreetLighting({ circuits: circuits.map(c => this._payload(c)), candidateCables: this._candidateCables() });
      if (token !== this._req) return;
      this._results = {};
      for (const r of res.circuits || []) this._results[r.id] = r;
      this._status('');
      this.renderRail();
      this._paintPoleResults();
      this.renderResults();
      if (typeof SLDiagram !== 'undefined') SLDiagram.refresh();
    } catch (err) {
      if (token !== this._req) return;
      console.error('Street lighting calc failed:', err);
      this._status('Calculation failed — ' + (err.message || err));
    }
  },

  _status(t) { const el = document.getElementById('sl-status'); if (el) el.textContent = t; },

  // ─── Rendering ──────────────────────────────────────────────────────
  render() {
    if (!this._built) return;
    const ws = document.getElementById('streetlight-workspace');
    for (const el of ws.querySelectorAll('[data-df]')) el.value = this.defaults[el.dataset.df];
    this.renderRail();
    this.renderMain();
    this.renderResults();
  },

  _badge(c) {
    const r = this._results[c.id];
    if (!c.poles.length) return '<span class="sl-badge">no poles</span>';
    if (!r) return '<span class="sl-badge">…</span>';
    if (r.pass) return '<span class="sl-badge ok">OK</span>';
    return `<span class="sl-badge bad">${escHtml(r.fails.map(f => this.FAIL_TEXT[f] || f).join(' + '))}</span>`;
  },

  renderRail() {
    const host = document.getElementById('sl-rail-list');
    if (!host) return;
    const groups = new Map();
    for (const s of this._sources()) groups.set(this._sourceKey(s), { src: s, items: [] });
    const orphans = [];
    for (const c of this.circuits) {
      const g = groups.get(this._sourceKey(c.source));
      (g ? g.items : orphans).push(c);
    }
    const item = (c) => {
      const r = this._results[c.id];
      const meta = `${c.system === '1ph' ? '1Φ string' : '3Φ R-W-B'} · ${c.poles.length} poles · ${escHtml(this._lum(c.luminaireId).name)}${r ? ` · VD ${r.worstVdPct.toFixed(1)} %` : ''}`;
      return `<button class="sl-rail-item${c.id === this._selId ? ' active' : ''}" data-sl="select" data-id="${c.id}">
        <span class="sl-rail-row"><span class="sl-rail-name">${escHtml(c.name)}</span>${this._badge(c)}</span>
        <span class="sl-rail-meta">${meta}</span></button>`;
    };
    let html = '';
    for (const g of groups.values()) {
      if (!g.items.length) continue;
      html += `<div class="sl-rail-group">${escHtml(g.src.name)} <span>${g.src.kind === 'minisub' ? 'minisub' : 'kiosk'} · ${this.circuitKVAText(g.items)}</span></div>` + g.items.map(item).join('');
    }
    if (orphans.length) html += `<div class="sl-rail-group">Source missing</div>` + orphans.map(item).join('');
    if (!this.circuits.length) {
      html = `<div class="sl-empty">No circuits yet. Add one, size a string with <b>Quick calc</b>, or pull the poles in from the Plan with <b>Sync from plan</b>.</div>`;
    }
    host.innerHTML = html;
  },
  circuitKVAText(list) {
    return list.reduce((s, c) => s + this.circuitKVA(c), 0).toFixed(2) + ' kVA';
  },

  renderMain() {
    const host = document.getElementById('sl-main');
    if (!host) return;
    const c = this.selected;
    if (!c) {
      host.innerHTML = `<div class="sl-empty sl-empty-main">Select a circuit, or add one with <b>+ New circuit</b>.</div>`;
      return;
    }
    const srcOpts = this._sources().map(s =>
      `<option value="${s.kind}:${escHtml(s.id)}"${this._sourceKey(s) === this._sourceKey(c.source) ? ' selected' : ''}>${escHtml(s.name)} (${s.kind})</option>`).join('');
    const lumOpts = (sel, withDefault) => (withDefault ? `<option value="">Circuit default</option>` : '') +
      SL_LUMINAIRES.map(l => `<option value="${l.id}"${l.id === sel ? ' selected' : ''}>${escHtml(l.name)} · pf ${l.pf}</option>`).join('');
    const protOpts = SL_PROTECTION.map(p => `<option value="${p.id}"${p.id === c.protection ? ' selected' : ''}>${escHtml(p.name)}${p.ia ? ` (Ia ${p.ia} A)` : ''}</option>`).join('');
    const phOpts = (sel) => ['R', 'W', 'B'].map(p => `<option value="${p}"${p === sel ? ' selected' : ''}>${p}</option>`).join('');
    const ze = this._ze(c), svd = this._supplyVd(c);
    const cableOpts = CableLib.options(c.cable, {
      filter: (x) => CableLib.isDistribution(x) && !CableLib.isMV(x) && (c.system === '1ph' || Number(x.cores) >= 4),
      groups: CableLib.reticGroups(), prefer: CableLib.reticPrefer('lv'), showAll: this._showAllCables,
    });
    host.innerHTML = `
      <div class="sl-head">
        <input class="sl-name" data-cf="name" value="${escHtml(c.name)}" aria-label="Circuit name">
        <div class="sl-head-actions">
          <button class="btn-small" data-sl="diagram" title="Schematic of this circuit — poles, phases, spans, volt drop and Zs; PNG / SVG export">Diagram</button>
          <button class="btn-small" data-sl="dup">Duplicate</button>
          <button class="btn-small" data-sl="del">Delete</button>
        </div>
      </div>
      <div class="sl-form">
        <label>Fed from<select data-cf="source">${srcOpts}</select></label>
        <label>System<select data-cf="system">
          <option value="3ph"${c.system !== '1ph' ? ' selected' : ''}>3Φ alternating R-W-B (4-core)</option>
          <option value="1ph"${c.system === '1ph' ? ' selected' : ''}>1Φ string (2-core)</option></select></label>
        ${c.system === '1ph'
          ? `<label>Phase<select data-cf="singlePhase">${phOpts(c.singlePhase)}</select></label>`
          : `<label title="Phase of the first pole; each next pole (and every spur) carries on the rotation">First pole on<select data-cf="phaseStart">${phOpts(c.phaseStart)}</select></label>`}
        <label class="sl-wide">Cable<select data-cf="cable">${cableOpts}</select></label>
        <label>Luminaire<select data-cf="luminaireId">${lumOpts(c.luminaireId, false)}</select></label>
        <label>Pole spacing<span class="sl-unit"><input type="number" step="1" data-cf="spacingM" value="${escHtml(c.spacingM)}"> m</span></label>
        <label>Protection<select data-cf="protection">${protOpts}</select></label>
        ${c.protection === 'custom' ? `<label>Ia<span class="sl-unit"><input type="number" step="1" data-cf="iaCustom" value="${escHtml(c.iaCustom ?? '')}"> A</span></label>` : ''}
        <label title="Earth loop impedance at the source. Blank = estimated: ${escHtml(ze.basis)}">Ze at source
          <span class="sl-unit"><input type="number" step="0.01" data-cf="zeOhm" value="${this._blank(c.zeOhm) ? '' : escHtml(c.zeOhm)}" placeholder="${ze.value.toFixed(3)}"> Ω</span>
          <span class="sl-hint">${ze.auto ? 'auto: ' + escHtml(ze.basis) : 'entered'}</span></label>
        <label title="Volt drop already present at the source. Blank = the Demand feeder VD (0 at a minisub)">Supply VD at source
          <span class="sl-unit"><input type="number" step="0.1" data-cf="supplyVdPct" value="${this._blank(c.supplyVdPct) ? '' : escHtml(c.supplyVdPct)}" placeholder="${svd.value.toFixed(2)}"> %</span>
          <span class="sl-hint">${svd.auto ? 'auto: ' + escHtml(svd.basis) : 'entered'}</span></label>
      </div>
      <div class="sl-poles">
        <div class="sl-poles-head">
          <b>Poles</b>
          <span class="sl-hint">Span = spacing × (1 + snaking) + loop-in. Set <i>Fed from</i> to another pole to make a spur — it carries on the phase rotation.</span>
          <span class="sl-grow"></span>
          <label>Add <input type="number" min="1" step="1" value="1" id="sl-add-n" class="sl-add-n"></label>
          <button class="btn-small" data-sl="add-poles">+ Poles</button>
        </div>
        <div class="sl-table-wrap">
          <table class="sl-table">
            <thead><tr>
              <th>Pole</th><th>Fed from</th><th title="Blank = circuit spacing">Spacing m</th><th>Luminaire</th><th title="Auto = rotation">Phase</th>
              <th class="num">Dist m</th><th class="num">I span A</th><th class="num">VD %</th><th class="num">Cum %</th><th class="num">Zs Ω</th><th class="num">Ik1 A</th><th>Check</th><th></th>
            </tr></thead>
            <tbody id="sl-pole-body">${this._poleRows(c, lumOpts)}</tbody>
          </table>
        </div>
      </div>`;
    this._attachGrid();
    this._paintPoleResults();
  },

  _poleRows(c, lumOpts) {
    const names = c.poles.map(p => ({ id: p.id, name: p.name || p.id }));
    return c.poles.map(p => {
      const par = `<option value="">Source</option>` + names.filter(n => n.id !== p.id)
        .map(n => `<option value="${n.id}"${n.id === p.parent ? ' selected' : ''}>${escHtml(n.name)}</option>`).join('');
      const ph = ['', 'R', 'W', 'B'].map(x => `<option value="${x}"${(p.phase || '') === x ? ' selected' : ''}>${x || 'Auto'}</option>`).join('');
      return `<tr data-pole="${p.id}">
        <td><input data-pf="name" data-pole="${p.id}" value="${escHtml(p.name || '')}" class="sl-in-name"><span class="sl-mini" data-res="mini"></span></td>
        <td><select data-pf="parent" data-pole="${p.id}">${par}</select></td>
        <td><input type="number" step="0.1" data-pf="spacingM" data-pole="${p.id}" value="${this._blank(p.spacingM) ? '' : escHtml(p.spacingM)}" placeholder="${escHtml(c.spacingM)}" class="sl-in-num"></td>
        <td><select data-pf="luminaireId" data-pole="${p.id}">${lumOpts(p.luminaireId || '', true)}</select></td>
        <td><select data-pf="phase" data-pole="${p.id}" class="sl-in-ph">${ph}</select><span class="sl-ph" data-res="phase"></span></td>
        <td class="num" data-res="distM"></td><td class="num" data-res="iSpanA"></td>
        <td class="num" data-res="vdPct"></td><td class="num" data-res="cumVdPct"></td>
        <td class="num" data-res="zsOhm"></td><td class="num" data-res="ik1A"></td>
        <td data-res="check"></td>
        <td><button class="sl-x" data-sl="del-pole" data-pole="${p.id}" aria-label="Delete pole ${escHtml(p.name || '')}" title="Delete pole (its spur poles move to its feeding pole)">×</button></td>
      </tr>`;
    }).join('');
  },

  _attachGrid() {
    const tb = document.getElementById('sl-pole-body');
    if (!tb || typeof GridTable === 'undefined') return;
    GridTable.attach(tb, {
      cells: '[data-pf]',
      onAddRow: (cell) => {
        const c = this.selected;
        if (!c) return;
        this._addPoles(c, 1);
        this._afterMutate(true);
        const last = c.poles[c.poles.length - 1];
        const el = document.querySelector(`#sl-pole-body [data-pf="${cell.dataset.pf}"][data-pole="${last.id}"]`);
        if (el) { el.focus(); if (el.select) el.select(); }
      },
    });
  },

  _paintPoleResults() {
    const c = this.selected;
    const r = c && this._results[c.id];
    const byId = {};
    if (r) for (const p of r.poles) byId[p.id] = p;
    document.querySelectorAll('#sl-pole-body tr[data-pole]').forEach(tr => {
      const p = byId[tr.dataset.pole];
      const set = (k, v, cls) => { const td = tr.querySelector(`[data-res="${k}"]`); if (td) { td.textContent = v; td.className = (td.classList.contains('num') ? 'num ' : '') + (cls || ''); } };
      if (!p) { for (const k of ['distM', 'iSpanA', 'vdPct', 'cumVdPct', 'zsOhm', 'ik1A', 'check', 'phase', 'mini']) set(k, ''); return; }
      const phEl = tr.querySelector('[data-res="phase"]');
      if (phEl) { phEl.textContent = p.phase; phEl.className = 'sl-ph sl-ph-' + p.phase; }
      set('distM', p.distM.toFixed(0));
      set('iSpanA', p.iSpanA.toFixed(2), p.ampOk ? '' : 'sl-bad');
      set('vdPct', p.vdPct.toFixed(2), p.vdOk ? '' : 'sl-bad');
      set('cumVdPct', p.cumVdPct.toFixed(2), p.cumOk ? '' : 'sl-bad');
      set('zsOhm', p.zsOhm.toFixed(2), p.zsOk ? '' : 'sl-bad');
      set('ik1A', p.ik1A == null ? '—' : p.ik1A.toFixed(0), p.zsOk ? '' : 'sl-bad');
      const why = [];
      if (!p.vdOk) why.push('VD'); if (!p.cumOk) why.push('Cum'); if (!p.zsOk) why.push('Zs'); if (!p.ampOk) why.push('A');
      set('check', why.length ? why.join('+') : 'OK', why.length ? 'sl-bad sl-check' : 'sl-ok sl-check');
      // Phone: the result columns scroll off to the right, so the pinned name
      // cell carries a one-line summary.
      set('mini', `${p.phase} · ${p.vdPct.toFixed(2)} % · ${why.length ? why.join('+') : 'OK'}`, 'sl-mini' + (why.length ? ' sl-bad' : ''));
    });
  },

  renderResults() {
    const host = document.getElementById('sl-results');
    if (!host) return;
    const c = this.selected;
    const r = c && this._results[c.id];
    if (!c) { host.innerHTML = ''; return; }
    if (!c.poles.length) { host.innerHTML = `<div class="sl-card"><div class="sl-empty">Add poles to calculate.</div></div>`; return; }
    if (!r) { host.innerHTML = `<div class="sl-card"><div class="sl-empty">Calculating…</div></div>`; return; }
    host.innerHTML = this._resultsHtml(r, { kva: this.circuitKVA(c), sourceName: this._sourceName(c.source), cable: c.cable });
  },

  // Shared by the workspace panel and the quick-calc modal.
  _resultsHtml(r, { kva, sourceName, cable, quick }) {
    const f = (x, d = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(d));
    const worst = r.poles.find(p => p.id === r.worstVdPole);
    const zsP = r.poles.find(p => p.id === r.maxZsPole);
    const verdict = r.pass
      ? `<span class="sl-verdict ok">PASS</span>`
      : `<span class="sl-verdict bad">FAIL</span>`;
    const failList = r.fails.length ? `<div class="sl-fails">Fails on ${r.fails.map(x => escHtml(this.LIMIT_TEXT[x] || x)).join(', ')}.</div>` : '';
    const phases = r.system === '1ph' ? ['R', 'W', 'B'].filter(p => r.phaseCount[p]) : ['R', 'W', 'B'];
    const maxA = Math.max(0.001, ...phases.map(p => r.phaseA[p]));
    const bars = phases.map(p => `
      <div class="sl-bal"><span class="sl-ph sl-ph-${p}">${p}</span>
        <span class="sl-bar"><span style="width:${(r.phaseA[p] / maxA * 100).toFixed(0)}%"></span></span>
        <span class="sl-mono">${f(r.phaseA[p])} A · ${r.phaseCount[p]}</span></div>`).join('');
    const s = r.solver || {};
    const warn = (r.warnings || []).map(w => `<div class="sl-warn">${escHtml(w)}</div>`).join('');
    const smallest = r.smallestCable
      ? (r.smallestCable === cable ? 'this cable' : escHtml(r.smallestCable))
      : 'none in the library — split the circuit';
    return `
      <div class="sl-card">
        <div class="sl-card-head"><span>Circuit verdict</span>${verdict}</div>
        ${failList}
        <div class="sl-stats">
          <div><span class="sl-k">Worst VD from source</span><span class="sl-v">${f(r.worstVdPct)} %</span>
            <span class="sl-k">${worst ? escHtml(worst.name || worst.id) + ', phase ' + worst.phase : ''} · limit ${r.vdLimitPct} %</span></div>
          <div><span class="sl-k">Cumulative VD</span><span class="sl-v${r.cumVdPass ? '' : ' sl-bad'}">${f(r.worstCumVdPct)} %</span>
            <span class="sl-k">supply ${f(r.supplyVdPct)} % + circuit · limit ${r.cumVdLimitPct} %</span></div>
          <div><span class="sl-k">Zs at far pole</span><span class="sl-v${r.zsPass ? '' : ' sl-bad'}">${f(r.maxZsOhm)} Ω</span>
            <span class="sl-k">${r.iaA ? `max ${f(r.zsMaxAllowedOhm)} Ω · Ik1 ${f(r.minIk1A, 0)} A vs Ia ${f(r.iaA, 0)} A` : 'no protective device Ia set'}${zsP ? ' · ' + escHtml(zsP.name || zsP.id) : ''}</span></div>
          <div><span class="sl-k">Load to ${escHtml(sourceName)}</span><span class="sl-v">${f(kva)} kVA</span>
            <span class="sl-k">${f(r.totalW, 0)} W · ${f(r.cableLengthM, 0)} m of cable</span></div>
        </div>
        ${warn}
      </div>
      <div class="sl-card">
        <div class="sl-card-head"><span>Volt drop at each pole</span><span class="sl-k">phasor, incl. neutral</span></div>
        ${this._chart(r)}
      </div>
      <div class="sl-card">
        <div class="sl-card-head"><span>Phase balance at source</span></div>
        ${bars}
        <div class="sl-bal sl-bal-n"><span class="sl-ph">N</span><span class="sl-k">neutral, first span</span><span class="sl-mono">${f(r.neutralA)} A</span></div>
      </div>
      <div class="sl-card">
        <div class="sl-card-head"><span>Limits for this build-up</span></div>
        <div class="sl-row"><span>Max poles as one string${quick ? '' : ' at the circuit spacing'}</span><b class="sl-mono">${s.maxPoles ?? '—'}${s.capped ? '+' : ''}</b></div>
        <div class="sl-row"><span>Max cable route</span><b class="sl-mono">${f(s.maxLengthM, 0)} m</b></div>
        <div class="sl-row sl-k"><span>Limited by</span><span>${s.limitedBy ? escHtml(this.LIMIT_TEXT[s.limitedBy] || s.limitedBy) : '—'}</span></div>
        <div class="sl-row sl-k"><span>Smallest cable that passes</span><span>${smallest}</span></div>
      </div>`;
  },

  // Volt drop per pole against distance, one dot per pole in its phase colour.
  _chart(r) {
    const W = 300, H = 150, L = 34, B = 18, T = 8;
    const pts = r.poles;
    const maxD = Math.max(1, ...pts.map(p => p.distM));
    const yMax = Math.max(r.vdLimitPct * 1.25, ...pts.map(p => p.vdPct * 1.08));
    const X = d => L + d / maxD * (W - L - 6), Y = v => T + (1 - v / yMax) * (H - T - B);
    const dots = pts.map(p => `<circle cx="${X(p.distM).toFixed(1)}" cy="${Y(p.vdPct).toFixed(1)}" r="2.6" fill="${this.PH_COLOR[p.phase]}"><title>${escHtml(p.name || p.id)} ${p.phase}: ${p.vdPct.toFixed(2)} %</title></circle>`).join('');
    const yl = Y(r.vdLimitPct).toFixed(1);
    return `<svg class="sl-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Volt drop against distance from the source">
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="sl-axis"/><line x1="${L}" y1="${H - B}" x2="${W - 6}" y2="${H - B}" class="sl-axis"/>
      <line x1="${L}" y1="${yl}" x2="${W - 6}" y2="${yl}" stroke="#b3261e" stroke-dasharray="4 4"/>
      <text x="${W - 6}" y="${(+yl - 4).toFixed(1)}" text-anchor="end" class="sl-lim">limit ${r.vdLimitPct} %</text>
      <text x="${L - 4}" y="${T + 8}" text-anchor="end" class="sl-tick">${yMax.toFixed(1)}</text>
      <text x="${L - 4}" y="${H - B + 3}" text-anchor="end" class="sl-tick">0</text>
      <text x="${W - 6}" y="${H - 4}" text-anchor="end" class="sl-tick">${maxD.toFixed(0)} m</text>
      ${dots}</svg>`;
  },

  // ─── Events ─────────────────────────────────────────────────────────
  _onClick(e) {
    const b = e.target.closest('[data-sl]');
    if (!b) return;
    const act = b.dataset.sl;
    const c = this.selected;
    if (act === 'new') this.newCircuit();
    else if (act === 'quick') this.openQuickCalc();
    else if (act === 'sync') this.syncFromPlan();
    else if (act === 'select') { this._selId = b.dataset.id; this.renderRail(); this.renderMain(); this.renderResults(); }
    else if (act === 'diagram' && c) SLDiagram.open(c.id);
    else if (act === 'dup' && c) this.duplicateCircuit(c.id);
    else if (act === 'del' && c) this.deleteCircuit(c.id);
    else if (act === 'add-poles' && c) {
      const n = Math.max(1, Math.min(200, Math.round(this._num(document.getElementById('sl-add-n')?.value, 1))));
      this._addPoles(c, n);
      this._afterMutate(true);
    } else if (act === 'del-pole' && c) { this._deletePole(c, b.dataset.pole); this._afterMutate(true); }
  },

  _onChange(e) {
    const t = e.target;
    if (t.dataset.df) {
      const v = this._num(t.value, null);
      if (v == null) { t.value = this.defaults[t.dataset.df]; return; }
      this.defaults[t.dataset.df] = v;
      this._markDirty();
      this.recompute();
      return;
    }
    const c = this.selected;
    if (!c) return;
    if (t.dataset.cf) {
      const k = t.dataset.cf;
      if (k === 'cable' && CableLib.handleShowAll(t, c.cable, (cur) => { this._showAllCables = true; return CableLib.options(cur, { filter: (x) => CableLib.isDistribution(x) && !CableLib.isMV(x), groups: CableLib.reticGroups(), showAll: true }); })) return;
      if (k === 'source') { const [kind, ...id] = t.value.split(':'); c.source = { kind, id: id.join(':') }; }
      else if (['spacingM', 'zeOhm', 'supplyVdPct', 'iaCustom'].includes(k)) c[k] = t.value === '' ? (k === 'spacingM' ? this.defaults.spacingM : null) : this._num(t.value, null);
      else c[k] = t.value;
      if (k === 'system' && c.system === '3ph') {
        const cab = CableLib.byName(c.cable);
        if (cab && Number(CableLib.normalize(cab).cores) < 4) { const sib = CableLib.sibling(cab, 4); c.cable = sib ? sib.name : ''; }
      }
      // Fields that change the form itself re-render it; the rest only recompute.
      const structural = ['source', 'system', 'protection', 'zeOhm', 'supplyVdPct', 'luminaireId'].includes(k);
      this._afterMutate(false);
      if (structural) { this.renderMain(); }
      return;
    }
    if (t.dataset.pf) {
      const p = c.poles.find(x => x.id === t.dataset.pole);
      if (!p) return;
      const k = t.dataset.pf;
      if (k === 'spacingM') p.spacingM = t.value === '' ? null : this._num(t.value, null);
      else if (k === 'parent') {
        const v = t.value || null;
        // Refuse a loop (a pole fed from its own spur).
        let cur = v; const seen = new Set();
        while (cur && !seen.has(cur)) { if (cur === p.id) { UI.toast('That would feed the pole from its own spur.', 'error'); t.value = p.parent || ''; return; } seen.add(cur); cur = (c.poles.find(x => x.id === cur) || {}).parent; }
        p.parent = v;
      } else p[k] = t.value || (k === 'name' ? '' : null);
      this._afterMutate(false);
      if (k === 'name') {
        // Keep the "Fed from" lists in step with the new name.
        document.querySelectorAll(`#sl-pole-body option[value="${p.id}"]`).forEach(o => { o.textContent = p.name || p.id; });
      }
    }
  },

  // ─── Plan sync ──────────────────────────────────────────────────────
  // Each connected set of Plan street-lighting routes with a kiosk or minisub
  // (pushed to Demand, so it has a reticId) becomes a circuit: poles in
  // walk order, each fed from the element before it (so a branch is a spur),
  // span = the feeding route's length. Re-syncing updates spans, names and the
  // tree but keeps each pole's luminaire / phase overrides and the circuit's
  // own settings.
  syncFromPlan() {
    if (typeof PlanSync === 'undefined' || !AppState.planMarkup) { UI.alert('There is no plan to sync from.'); return; }
    const pm = AppState.planMarkup;
    const factor = PlanSync._factor();
    if (!factor) { UI.alert('Calibrate the plan first — spans are measured in metres.'); return; }
    const elById = PlanSync._elById();
    const adj = {};
    const add = (u, v, r) => { (adj[u] = adj[u] || []).push({ other: v, route: r }); };
    const routes = typeof AppState.planAllRoutes === 'function' ? AppState.planAllRoutes() : (pm.routes || []);
    for (const r of routes) {
      if (PlanSync._effectiveType(r, elById) !== 'sl' || !r.fromId || !r.toId) continue;
      add(r.fromId, r.toId, r); add(r.toId, r.fromId, r);
    }
    const R = AppState.reticulation;
    const srcOf = (el) => {
      if (!el || !el.reticId) return null;
      if (el.type === 'kiosk' && R.kiosks.some(k => k.id === el.reticId)) return { kind: 'kiosk', id: el.reticId };
      if (el.type === 'minisub' && R.minisubs.some(m => m.id === el.reticId)) return { kind: 'minisub', id: el.reticId };
      return null;
    };
    let made = 0, updated = 0, skipped = 0;
    const claimed = new Set();
    for (const startId of Object.keys(adj)) {
      const el = elById[startId];
      const src = srcOf(el);
      if (!src) continue;
      // Walk from the source; each branch leaving the source is a circuit.
      for (const first of adj[startId]) {
        const firstEl = elById[first.other];
        if (!firstEl || firstEl.type !== 'pole' || claimed.has(firstEl.id)) continue;
        const poles = [];
        const q = [{ id: firstEl.id, parentPlan: null, route: first.route }];
        const seen = new Set([startId, firstEl.id]);
        while (q.length) {
          const { id, parentPlan, route } = q.shift();
          const pe = elById[id];
          poles.push({ planId: id, name: pe.name || '', parentPlan, spacingM: +(PlanSync._routeLenM(route, factor) || 0).toFixed(2) });
          claimed.add(id);
          for (const e of adj[id] || []) {
            const o = elById[e.other];
            if (seen.has(e.other) || !o || o.type !== 'pole') continue;
            seen.add(e.other);
            q.push({ id: e.other, parentPlan: id, route: e.route });
          }
        }
        const planKey = `${startId}>${firstEl.id}`;
        let c = this.circuits.find(x => x.planKey === planKey)
          || this.circuits.find(x => x.poles.some(p => p.planId === firstEl.id));
        if (!c) {
          const rc = (first.route && first.route.cableType) || '';
          c = this._newCircuit(src, CableLib.byName(rc) ? { planKey, cable: rc } : { planKey });
          this.circuits.push(c);
          made++;
        } else { updated++; c.planKey = planKey; c.source = src; }
        const old = {};
        for (const p of c.poles) if (p.planId) old[p.planId] = p;
        const idOf = {};
        const next = poles.map(sp => {
          const prev = old[sp.planId];
          const p = prev || { id: this._genPoleId(), luminaireId: null, phase: null };
          p.planId = sp.planId; p.name = sp.name || p.name || this._nextPoleName(c);
          p.spacingM = sp.spacingM;
          idOf[sp.planId] = p.id;
          return { p, sp };
        });
        for (const { p, sp } of next) p.parent = sp.parentPlan ? idOf[sp.parentPlan] || null : null;
        // Poles added by hand (no planId) stay, fed from where they were.
        const manual = c.poles.filter(p => !p.planId);
        c.poles = next.map(x => x.p).concat(manual);
      }
    }
    for (const id of Object.keys(adj)) {
      const el = elById[id];
      if (el && el.type === 'pole' && !claimed.has(id)) skipped++;
    }
    if (!made && !updated) {
      UI.alert('No street-lighting routes from a kiosk or minisub were found. Draw them with the Plan\'s SL Path tool from a kiosk or minisub, and Push to Reticulation first so the source exists in Demand.');
      return;
    }
    if (!this.selected) this._selId = this.circuits[0].id;
    this._afterMutate(true);
    UI.toast(`Street lighting: ${made} new, ${updated} updated circuit(s)${skipped ? `, ${skipped} pole(s) not connected to a source` : ''}.`, 'success');
  },

  // ─── Quick calc ─────────────────────────────────────────────────────
  openQuickCalc() {
    const d = this.defaults;
    if (!this._qc) {
      this._qc = { system: d.system || '3ph', luminaireId: d.luminaireId, cable: this._defaultCable(d.system || '3ph'), n: 20, spacingM: d.spacingM,
        protection: d.protection, iaCustom: null, zeOhm: 0.35, supplyVdPct: 0 };
    }
    let m = document.getElementById('sl-quick-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'sl-quick-modal';
      m.className = 'modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.setAttribute('aria-label', 'Street light quick calc');
      document.body.appendChild(m);
      m.addEventListener('change', (e) => this._qcChange(e));
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-qc="close"]')) this.closeQuickCalc();
        else if (e.target.closest('[data-qc="save"]')) this._qcSave();
      });
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeQuickCalc(); });
    }
    m.style.display = 'flex';
    this._qcRender();
    this._qcCompute(0);
  },
  closeQuickCalc() { const m = document.getElementById('sl-quick-modal'); if (m) m.style.display = 'none'; },

  _qcCircuit() {
    const q = this._qc;
    const c = this._newCircuit(this._defaultSource(), {
      id: 'quick', name: 'Quick calc', system: q.system, cable: q.cable, luminaireId: q.luminaireId,
      spacingM: q.spacingM, protection: q.protection, iaCustom: q.iaCustom, zeOhm: q.zeOhm ?? 0, supplyVdPct: q.supplyVdPct ?? 0, poles: [],
    });
    this.data._circSeq--;   // the throwaway circuit must not consume an id
    const n = Math.max(1, Math.min(300, Math.round(this._num(q.n, 1))));
    let parent = null;
    for (let i = 0; i < n; i++) { const id = 'q' + i; c.poles.push({ id, name: 'P' + String(i + 1).padStart(2, '0'), parent, spacingM: null, luminaireId: null, phase: null }); parent = id; }
    return c;
  },

  _qcRender() {
    const m = document.getElementById('sl-quick-modal');
    const q = this._qc, d = this.defaults;
    const opt = (list, sel, lab) => list.map(x => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${escHtml(lab(x))}</option>`).join('');
    const cableOpts = CableLib.options(q.cable, {
      filter: (x) => CableLib.isDistribution(x) && !CableLib.isMV(x) && (q.system === '1ph' || Number(x.cores) >= 4),
      groups: CableLib.reticGroups(), prefer: CableLib.reticPrefer('lv'), showAll: true,
    });
    const srcOpts = this._sources().map(s => `<option value="${s.kind}:${escHtml(s.id)}">${escHtml(s.name)} (${s.kind})</option>`).join('');
    const num = (k, step, unit, label, title) => `<label${title ? ` title="${escHtml(title)}"` : ''}>${label}<span class="sl-unit"><input type="number" step="${step}" data-q="${k}" value="${escHtml(q[k] ?? '')}"> ${unit}</span></label>`;
    m.innerHTML = `
      <div class="modal-content sl-qc">
        <div class="modal-header"><h3>Street light quick calc</h3>
          <span class="sl-k">uniform string · 230 V · limits ${d.vdLimitPct} % from source, ${d.cumVdLimitPct} % cumulative · snaking ${d.snakingPct} %, loop-in ${d.loopInM} m</span>
          <button class="modal-close" data-qc="close" aria-label="Close">&times;</button></div>
        <div class="sl-qc-body">
          <form class="sl-qc-form" onsubmit="return false">
            <label>System<select data-q="system">
              <option value="3ph"${q.system !== '1ph' ? ' selected' : ''}>3Φ alternating R-W-B</option>
              <option value="1ph"${q.system === '1ph' ? ' selected' : ''}>1Φ string</option></select></label>
            <label>Luminaire<select data-q="luminaireId">${opt(SL_LUMINAIRES, q.luminaireId, l => `${l.name} · pf ${l.pf}`)}</select></label>
            <label>Cable<select data-q="cable">${cableOpts}</select></label>
            <div class="sl-qc-grid">
              ${num('n', 1, '', 'Poles')}
              ${num('spacingM', 1, 'm', 'Spacing')}
              ${num('zeOhm', 0.01, 'Ω', 'Ze at source', 'Earth loop impedance at the kiosk or minisub')}
              ${num('supplyVdPct', 0.1, '%', 'Supply VD', 'Volt drop already at the source, for the cumulative check')}
            </div>
            <label>Protection<select data-q="protection">${opt(SL_PROTECTION, q.protection, p => p.name + (p.ia ? ` (Ia ${p.ia} A)` : ''))}</select></label>
            ${q.protection === 'custom' ? num('iaCustom', 1, 'A', 'Ia') : ''}
          </form>
          <div class="sl-qc-res" id="sl-qc-res"><div class="sl-empty">Calculating…</div></div>
        </div>
        <div class="sl-qc-foot">
          <label>Save to<select id="sl-qc-src">${srcOpts}</select></label>
          <button class="btn-small btn-primary" data-qc="save">Save as circuit</button>
        </div>
      </div>`;
    this._qcPaint();
  },

  _qcChange(e) {
    const t = e.target;
    const k = t.dataset.q;
    if (!k) return;
    const q = this._qc;
    if (k === 'cable' && CableLib.handleShowAll(t, q.cable, (cur) => CableLib.options(cur, { groups: CableLib.reticGroups(), showAll: true }))) return;
    q[k] = ['n', 'spacingM', 'zeOhm', 'supplyVdPct', 'iaCustom'].includes(k) ? this._num(t.value, null) : t.value;
    if (k === 'system' && q.system === '3ph') {
      const cab = CableLib.byName(q.cable);
      if (cab && Number(CableLib.normalize(cab).cores) < 4) { const sib = CableLib.sibling(cab, 4); q.cable = sib ? sib.name : ''; }
    }
    if (['system', 'protection'].includes(k)) this._qcRender();
    this._qcCompute();
  },

  _qcCompute(delay = 250) {
    clearTimeout(this._qcTimer);
    this._qcTimer = setTimeout(async () => {
      const c = this._qcCircuit();
      try {
        const res = await API.runStreetLighting({ circuits: [this._payload(c)], candidateCables: this._candidateCables() });
        this._qcRes = { r: res.circuits[0], kva: this.circuitKVA(c) };
      } catch (err) {
        this._qcRes = { error: err.message || String(err) };
      }
      this._qcPaint();
    }, delay);
  },

  _qcPaint() {
    const host = document.getElementById('sl-qc-res');
    if (!host || !this._qcRes) return;
    if (this._qcRes.error) { host.innerHTML = `<div class="sl-warn">Calculation failed — ${escHtml(this._qcRes.error)}</div>`; return; }
    host.innerHTML = this._resultsHtml(this._qcRes.r, { kva: this._qcRes.kva, sourceName: 'source', cable: this._qc.cable, quick: true });
  },

  _qcSave() {
    const sel = document.getElementById('sl-qc-src');
    if (!sel || !sel.value) { UI.alert('Add a kiosk or minisub in Demand first.'); return; }
    const [kind, ...id] = sel.value.split(':');
    const q = this._qc;
    const c = this._newCircuit({ kind, id: id.join(':') }, {
      system: q.system, cable: q.cable, luminaireId: q.luminaireId, spacingM: q.spacingM,
      protection: q.protection, iaCustom: q.iaCustom,
    });
    this._addPoles(c, Math.max(1, Math.min(300, Math.round(this._num(q.n, 1)))), null);
    this.circuits.push(c);
    this._selId = c.id;
    this.closeQuickCalc();
    if (!this._active && typeof window.switchWorkspace === 'function') window.switchWorkspace('streetlight');
    this._afterMutate(true);
    UI.toast(`Saved ${c.name} (${c.poles.length} poles). Ze and supply VD now come from ${this._sourceName(c.source)}.`, 'success');
  },
};
