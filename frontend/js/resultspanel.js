/* ProtectionPro — Results panel on the single line (UX plan PR 12).
 *
 * One panel holds the results of the studies on the single line, docked to
 * the right of the diagram or under it, or popped out into its own window
 * (a second monitor). It replaces the load flow dispatch pop-up and the arc
 * flash, cable sizing and duty check result dialogs.
 *  · a tab per study that has results (load flow, short circuit, arc flash,
 *    cable sizing, duty check); the tab follows the results view switch
 *    (resultview.js) and picking a tab shows that study on the diagram;
 *  · each tab says how the study ran (method, when) and how it came out
 *    (fail / warning counts); an out-of-date result says so with Re-run;
 *  · sortable tables (click a heading), a name filter and Needs attention
 *    (only rows that fail or warn);
 *  · a row and its part are linked: click a row → the part is selected and
 *    brought into view; select a part → its row is picked and opened. An open
 *    row lists the reasons and what to do next (properties, TCC, …);
 *  · dock right / bottom, size and open state are remembered per browser;
 *    with nothing remembered the dock follows the diagram's shape (a tall one
 *    gets the panel on the right, a wide one at the bottom).
 *
 * The tables are built by `model(key)` (no DOM), so they are node-testable.
 */

const ResultsPanel = {
  // Tab order. Studies saved with the project have result SLOTS on AppState;
  // the rest are kept for the session (SESSION, put by their run through
  // `show(key, result)`). A tab's content is its model `_m_<key>`.
  TABS: ['loadflow', 'unbalancedLF', 'fault', 'ansi', 'arcflash', 'cable', 'duty', 'motor', 'dynMotor', 'stability',
    'loadDiversity', 'grounding', 'harmonics', 'dcLoadflow', 'dcShortCircuit', 'sequence', 'contingency', 'vstab', 'tsl',
    'opf', 'hc', 'cpl', 'rel', 'fscan', 'flt', 'flk', 'bsz', 'backup', 'openConductor', 'twoConductorOpen', 'simultaneousFault'],
  LABELS: { loadflow: 'Load flow', unbalancedLF: 'Unbalanced LF', fault: 'Short circuit', ansi: 'Fault duty (ANSI)',
    arcflash: 'Arc flash', cable: 'Cable sizing', duty: 'Duty check', motor: 'Motor starting', dynMotor: 'Dynamic motor',
    stability: 'Transient stability', loadDiversity: 'Load diversity', grounding: 'Grounding', harmonics: 'Harmonics',
    dcLoadflow: 'DC load flow', dcShortCircuit: 'DC short circuit', sequence: 'Sequence of operation',
    contingency: 'Contingency', vstab: 'Voltage stability', tsl: 'Time series', opf: 'Optimal power flow',
    hc: 'Hosting capacity', cpl: 'Capacitor placement', rel: 'Reliability', fscan: 'Frequency scan',
    flt: 'Filter sizing', flk: 'Flicker', bsz: 'Battery sizing', backup: 'Backup autonomy',
    openConductor: 'Open conductor', twoConductorOpen: 'Two conductors open', simultaneousFault: 'Simultaneous fault' },
  SLOTS: { loadflow: ['loadFlowResults'], unbalancedLF: ['unbalancedLoadFlowResults'], fault: ['faultResults'],
    ansi: ['ansiFaultResults'], arcflash: ['arcFlashResults', 'dcArcFlashResults'], cable: ['cableSizingResults'],
    duty: ['dutyCheckResults'], motor: ['motorStartingResults'], dynMotor: ['dynamicMotorResults'],
    stability: ['stabilityResults'], loadDiversity: ['loadDiversityResults'], grounding: ['groundingResults'],
    dcLoadflow: ['dcLoadFlowResults'], dcShortCircuit: ['dcShortCircuitResults'] },
  GUIDES: { loadflow: 'study-loadflow', fault: 'study-fault', arcflash: 'study-arcflash', cable: 'study-cable', duty: 'study-duty',
    motor: 'study-motor', grounding: 'study-grounding', dcLoadflow: 'study-powerflow', tsl: 'study-powerflow', opf: 'study-powerflow',
    ansi: 'study-shortcircuit-variants', dcShortCircuit: 'study-shortcircuit-variants', dynMotor: 'study-stability',
    stability: 'study-stability', vstab: 'study-stability', harmonics: 'study-powerquality', fscan: 'study-powerquality',
    flt: 'study-powerquality', flk: 'study-powerquality', contingency: 'study-planning', hc: 'study-planning',
    cpl: 'study-planning', rel: 'study-planning', loadDiversity: 'study-sizing', bsz: 'study-sizing' },
  // How to run a study again from the panel: its setup (or the run itself
  // when it has none). Studies the out-of-date chip re-runs use that instead.
  SETUP: {
    dynMotor: () => DynMotor.openConfig(), stability: () => Transient.openConfig(),
    sequence: () => SOO.openConfig(), contingency: () => Contingency.openConfig(),
    vstab: () => VoltageStability.openConfig(), tsl: () => TimeSeries.openConfig(), opf: () => OPF.openConfig(),
    hc: () => HostingCapacity.openConfig(), cpl: () => CapPlacement.openConfig(), rel: () => Reliability.run(),
    fscan: () => FrequencyScan.openConfig(), flt: () => FilterSizing.openConfig(), flk: () => Flicker.openConfig(),
    bsz: () => BatterySizing.openConfig(),
    harmonics: () => document.getElementById('btn-harmonics')?.click(),
    backup: () => document.getElementById('btn-backup-study')?.click(),
    openConductor: () => document.getElementById('btn-open-conductor')?.click(),
    twoConductorOpen: () => document.getElementById('btn-two-conductor-open')?.click(),
    simultaneousFault: () => document.getElementById('btn-simultaneous-fault')?.click(),
  },
  // Drawers of the studies whose own view (charts, cases) is shown as it is:
  // key → (element, result, meta). Studies in app.js register theirs.
  VIEWS: {},

  // ── Preferences (per browser) ─────────────────────────────────────────
  PREF_KEY: 'pp-results-panel',
  prefs: null,
  _loadPrefs() {
    if (this.prefs) return this.prefs;
    let p = {};
    try { p = JSON.parse(localStorage.getItem(this.PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
    this.prefs = { open: !!p.open, dock: p.dock === 'right' || p.dock === 'bottom' ? p.dock : null,
      right: +p.right || 460, bottom: +p.bottom || 270 };
    return this.prefs;
  },
  _savePrefs() {
    try { localStorage.setItem(this.PREF_KEY, JSON.stringify(this.prefs)); } catch (e) { /* private mode */ }
  },

  // The dock in use: the one picked, else from the diagram's shape.
  dock() {
    const p = this._loadPrefs();
    return p.dock || this.autoDock();
  },
  autoDock(comps) {
    const list = comps || (typeof AppState !== 'undefined' && AppState.getActivePageComponents
      ? [...AppState.getActivePageComponents().values()] : []);
    if (!list.length) return 'right';
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of list) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
    return (y1 - y0) > (x1 - x0) ? 'right' : 'bottom';
  },

  // ── State ─────────────────────────────────────────────────────────────
  tab: null,
  attention: false,
  filter: '',
  sort: {},          // 'tab/section' → { col, dir }
  openRow: null,     // 'section:id' of the opened row
  _win: null,        // the pop-out window

  // ── Results kept for the session (not saved with the project) ─────────
  _session: {},
  // A study's run hands its result here: kept with the network signature it
  // was computed on (so an edit shows it out of date) and the panel opens on it.
  show(key, result, meta) {
    if (result == null) { delete this._session[key]; this.render(true); return; }
    this._session[key] = { r: result, meta: meta || {}, at: Date.now(),
      sig: typeof AppState !== 'undefined' && AppState.networkSignature ? AppState.networkSignature() : null };
    this.open(key);
  },
  clearSession() { this._session = {}; this.openRow = null; },
  result(key) {
    const slots = this.SLOTS[key];
    if (slots) { const s = slots.find(x => AppState[x] != null); return s ? AppState[s] : null; }
    return this._session[key] ? this._session[key].r : null;
  },
  isStale(key) {
    const slots = this.SLOTS[key];
    if (slots) return typeof StaleResults !== 'undefined' && slots.some(s => AppState[s] != null && StaleResults.isStale(s));
    const e = this._session[key];
    return !!(e && e.sig && AppState.networkSignature && e.sig !== AppState.networkSignature());
  },
  // When the shown result was computed.
  ranAt(key) {
    const slots = this.SLOTS[key];
    if (!slots) return this._session[key] ? this._session[key].at : null;
    const m = AppState.resultsMeta && AppState.resultsMeta[slots.find(s => AppState[s] != null)];
    return m && m.at ? m.at : null;
  },
  // fail / warn / ok / info for a tab's dot: the chip's verdict where the
  // study has one, else from the model.
  _verdicts: new WeakMap(),
  verdict(key) {
    if (typeof ResultView !== 'undefined' && ResultView.study(key)) return ResultView.verdict(key);
    const r = this.result(key);
    if (r == null) return 'info';
    if (typeof r === 'object' && this._verdicts.has(r)) return this._verdicts.get(r);
    const m = this.model(key);
    let v = (m && m.verdict) || null;
    if (!v) {
      const n = this.counts(m);
      v = n.fail ? 'fail' : n.warn ? 'warn' : (m && m.sections.some(s => s.rows && s.rows.some(x => x.status === 'ok')) ? 'ok' : 'info');
    }
    if (typeof r === 'object') this._verdicts.set(r, v);
    return v;
  },

  has(key) { return this.result(key) != null; },
  available() { return this.TABS.filter(k => this.has(k)); },
  isOpen() { return !!(this._win || this._loadPrefs().open); },

  // ── Formatting ────────────────────────────────────────────────────────
  _n(v, d = 2) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d); },
  _pw(mw) { return mw == null ? '—' : (Math.abs(mw) >= 1 ? `${mw.toFixed(2)} MW` : `${(mw * 1000).toFixed(1)} kW`); },
  _pq(mvar) { return mvar == null ? '—' : (Math.abs(mvar) >= 1 ? `${mvar.toFixed(2)} Mvar` : `${(mvar * 1000).toFixed(1)} kvar`); },
  _ps(mva) { return mva == null ? '—' : (Math.abs(mva) >= 1 ? `${mva.toFixed(2)} MVA` : `${(mva * 1000).toFixed(0)} kVA`); },
  _name(id) {
    const c = typeof AppState !== 'undefined' && AppState.components.get(id);
    return c ? (c.props?.name || c.id) : id;
  },
  _cell(v, t) { return { v, t: t == null ? (v == null ? '—' : String(v)) : t }; },

  // ── Models: what each tab shows ───────────────────────────────────────
  // { summary, notes: [{level, text}], sections: [{ id, title, cols: [{ key, label, num, title }],
  //   rows: [{ id, name, status, cells: { key: { v, t } }, reasons: [], actions: [] }] }] }
  model(key) {
    try { return this['_m_' + key]() || null; } catch (e) { console.error('Results panel:', key, e); return null; }
  },

  _m_loadflow() {
    const r = AppState.loadFlowResults;
    if (!r) return null;
    const notes = [];
    if (r.converged === false) notes.push({ level: 'fail', text: 'Load flow did not converge — the results are not reliable.' });
    else if (r.solution_quality === 'low_voltage_root') notes.push({ level: 'fail', text: 'Load flow converged to an implausibly low-voltage solution — likely the collapse root or an infeasible operating point, not a valid result.' });
    for (const w of r.warnings || []) notes.push({ level: 'warn', text: w.message });
    const busName = (id) => (r.buses && r.buses[id] && r.buses[id].bus_name) || this._name(id);

    const buses = Object.entries(r.buses || {}).map(([id, b]) => {
      const reasons = [];
      let status = 'ok';
      const d = (b.voltage_pu ?? 1) - 1;
      if (b.energized === false) { status = 'warn'; reasons.push('De-energised: no source reaches this bus.'); }
      else if (Math.abs(d) > 0.10) { status = 'fail'; reasons.push(`Voltage ${(b.voltage_pu * 100).toFixed(1)} % is outside ±10 % of nominal.`); }
      else if (Math.abs(d) > 0.05) { status = 'warn'; reasons.push(`Voltage ${(b.voltage_pu * 100).toFixed(1)} % is outside ±5 % of nominal.`); }
      const p = b.p_through_mw ?? b.p_mw, q = b.q_through_mvar ?? b.q_mvar;
      return { id: b.bus_id || id, name: b.bus_name || id, status, reasons,
        cells: {
          v: this._cell(b.voltage_kv, this._n(b.voltage_kv, 3)),
          pu: this._cell(b.voltage_pu, this._n(b.voltage_pu, 4)),
          ang: this._cell(b.angle_deg, this._n(b.angle_deg, 2)),
          p: this._cell(p, this._pw(p)),
          q: this._cell(q, this._pq(q)),
        },
        actions: ['props'] };
    });
    const branches = (r.branches || []).map(br => {
      const reasons = [];
      let status = 'ok';
      const L = br.loading_pct || 0;
      if (L > 100) { status = 'fail'; reasons.push(`Loaded to ${L.toFixed(0)} % of its rating.`); }
      else if (L > 90) { status = 'warn'; reasons.push(`Loaded to ${L.toFixed(0)} % of its rating — little margin.`); }
      return { id: br.elementId, name: br.element_name || this._name(br.elementId), status, reasons,
        cells: {
          ends: this._cell(`${busName(br.from_bus)} → ${busName(br.to_bus)}`),
          p: this._cell(br.p_mw, this._pw(br.p_mw)),
          q: this._cell(br.q_mvar, this._pq(br.q_mvar)),
          i: this._cell(br.i_amps, this._n(br.i_amps, 1)),
          load: this._cell(L, `${L.toFixed(1)} %`),
          loss: this._cell(br.losses_mw, this._pw(br.losses_mw)),
        },
        actions: ['props'] };
    });
    const kw = AppState.dispatchUnits === 'kw';
    const val = (mw, mvar) => kw ? this._pw(mw) : this._ps(mw < 0 ? -Math.hypot(mw || 0, mvar || 0) : Math.hypot(mw || 0, mvar || 0));
    const role = { balancer: 'Balancer (slack)', dispatched: 'Dispatched', curtailed: 'Curtailed', offline: 'Disconnected',
      standby: 'Standby (idle)', off: 'Off (sequence)', idle: 'Idle (no load)' };
    const dispatch = (r.dispatch || []).map(d => {
      const reasons = [];
      let status = 'info';
      if (d.curtailed_mw > 0) { status = 'warn'; reasons.push(`Curtailed by ${val(d.curtailed_mw, d.curtailed_mvar)}: the island cannot take its full output.`); }
      if (d.role === 'offline') { status = 'warn'; reasons.push('Disconnected: not on an energised island.'); }
      const idle = ['offline', 'standby', 'off', 'idle'].includes(d.role);
      return { id: d.source_id, name: d.source_name || d.source_id, status, reasons,
        cells: {
          island: this._cell(d.island, d.island > 0 ? String(d.island) : '—'),
          role: this._cell(role[d.role] || d.role),
          avail: this._cell(d.available_mw, d.source_type === 'utility' && d.available_mw === 0 ? '∞' : val(d.available_mw, d.available_mvar)),
          disp: this._cell(idle ? null : d.dispatched_mw, idle ? '—' : val(d.dispatched_mw, d.dispatched_mvar)),
          curt: this._cell(d.curtailed_mw || 0, d.curtailed_mw > 0 ? val(d.curtailed_mw, d.curtailed_mvar) : '—'),
        },
        actions: ['props'] };
    });
    const sections = [
      { id: 'buses', title: 'Buses', cols: [{ key: 'v', label: 'V (kV)', num: true }, { key: 'pu', label: 'V (pu)', num: true },
        { key: 'ang', label: 'Angle (°)', num: true }, { key: 'p', label: 'P', num: true, title: 'Real power the bus carries' },
        { key: 'q', label: 'Q', num: true }], rows: buses },
      { id: 'branches', title: 'Cables, lines and transformers', cols: [{ key: 'ends', label: 'From → To' },
        { key: 'p', label: 'P', num: true }, { key: 'q', label: 'Q', num: true }, { key: 'i', label: 'I (A)', num: true },
        { key: 'load', label: 'Loading', num: true }, { key: 'loss', label: 'Losses', num: true }], rows: branches },
    ];
    if (dispatch.length) {
      sections.push({ id: 'dispatch', title: 'Generation dispatch', tools: [
        { id: 'units-kva', label: 'kVA', active: !kw, title: 'Apparent power S = √(P² + Q²)', run: () => { AppState.dispatchUnits = 'kva'; AppState.dirty = true; this.render(true); } },
        { id: 'units-kw', label: 'kW', active: kw, title: 'Real power P', run: () => { AppState.dispatchUnits = 'kw'; AppState.dirty = true; this.render(true); } },
      ], cols: [{ key: 'island', label: 'Island', num: true }, { key: 'role', label: 'Role' },
        { key: 'avail', label: 'Available', num: true }, { key: 'disp', label: 'Dispatched', num: true },
        { key: 'curt', label: 'Curtailed', num: true }], rows: dispatch });
    }
    if ((r.svc || []).length) {
      sections.push({ id: 'svc', title: 'SVC / STATCOM', cols: [{ key: 'type', label: 'Type' }, { key: 'v', label: 'Bus V (pu)', num: true },
        { key: 'q', label: 'Q output', num: true }, { key: 'range', label: 'Q range' }],
      rows: r.svc.map(s => ({ id: s.id, name: s.name || s.id, status: s.at_limit ? 'warn' : 'ok',
        reasons: s.at_limit ? ['At its reactive limit: it cannot hold the set voltage.'] : [],
        cells: { type: this._cell(s.device === 'svc' ? 'SVC' : 'STATCOM'), v: this._cell(s.v_pu, String(s.v_pu)),
          q: this._cell(s.q_mvar, `${s.q_mvar >= 0 ? '+' : ''}${s.q_mvar} Mvar`), range: this._cell(`${s.q_min_mvar} … ${s.q_max_mvar} Mvar`) },
        actions: ['props'] })) });
    }
    const how = `${(r.method || 'newton_raphson').replace(/_/g, '-').replace(/^./, c => c.toUpperCase())}`
      + (r.converged === false ? ' · did not converge' : (r.iterations != null ? ` · converged in ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` : ''));
    return { summary: how, notes, sections };
  },

  _m_fault() {
    const r = AppState.faultResults;
    if (!r) return null;
    const min = AppState.faultResultsMin;
    const notes = [];
    const topo = new Set();
    for (const b of Object.values(r.buses || {})) for (const w of b.topology_warnings || []) topo.add(w);
    for (const w of topo) notes.push({ level: 'warn', text: w });
    const rows = Object.entries(r.buses || {}).map(([id, b]) => {
      const m = min && min.buses && min.buses[id];
      const kmin = m ? Math.min(...[m.ik3, m.ik1].filter(x => x != null && isFinite(x))) : null;
      const reasons = [];
      if (b.motor_count) reasons.push(`${b.motor_count} motor${b.motor_count === 1 ? '' : 's'} add ${this._n(b.ik3_motor)} kA.`);
      if (b.z0_source_count === 0) reasons.push('No earthed source path: the earth-fault current is close to zero.');
      return { id: b.bus_id || id, name: b.bus_name || id, status: 'info', reasons,
        cells: {
          kv: this._cell(b.voltage_kv, this._n(b.voltage_kv, 3)),
          ik3: this._cell(b.ik3, this._n(b.ik3)),
          ip: this._cell(b.ip, this._n(b.ip)),
          ib: this._cell(b.ib, this._n(b.ib)),
          ik1: this._cell(b.ik1, this._n(b.ik1)),
          ikll: this._cell(b.ikLL, this._n(b.ikLL)),
          kmin: this._cell(isFinite(kmin) ? kmin : null, isFinite(kmin) ? this._n(kmin) : '—'),
        },
        actions: ['props', 'fault-here'] };
    });
    const scope = AppState.faultedBusId ? `fault at ${this._name(AppState.faultedBusId)}` : 'every bus';
    return { summary: `${r.method || 'IEC 60909'} · ${scope}${min ? ' · maximum and minimum' : ''}`, notes, sections: [
      { id: 'buses', title: 'Fault currents (kA)', cols: [{ key: 'kv', label: 'kV', num: true },
        { key: 'ik3', label: 'Ik″ 3Φ', num: true, title: 'Initial symmetrical three-phase current' },
        { key: 'ip', label: 'ip', num: true, title: 'Peak current' }, { key: 'ib', label: 'Ib', num: true, title: 'Symmetrical breaking current' },
        { key: 'ik1', label: 'Ik1', num: true, title: 'Single line to earth' }, { key: 'ikll', label: 'IkLL', num: true, title: 'Line to line' },
        { key: 'kmin', label: 'Ik min', num: true, title: 'Smallest fault current of the minimum study (c min, motors left out) — what protection must still see' }],
      rows },
    ] };
  },

  _afRow(b, dc) {
    const reasons = [];
    let status = 'ok';
    if (b.ppe_category === -1) { status = 'fail'; reasons.push('Above 40 cal/cm²: no PPE category applies — work only de-energised.'); }
    else if (b.ppe_category >= 3) { status = 'warn'; reasons.push(`PPE category ${b.ppe_category}: heavy arc-rated clothing needed.`); }
    if (b.warning) reasons.push(b.warning);
    for (const rec of b.recommendations || []) reasons.push(String(rec).replace(/<[^>]*>/g, ''));
    const cells = dc ? {
      kv: this._cell(b.system_voltage_v, `${this._n(b.system_voltage_v, 0)} V`),
      ibf: this._cell(b.bolted_fault_ka, this._n(b.bolted_fault_ka)),
      iarc: this._cell(b.dc_arcing_current_a, `${this._n(b.dc_arcing_current_a, 1)} A`),
    } : {
      kv: this._cell(b.voltage_kv, `${this._n(b.voltage_kv, 3)} kV`),
      ibf: this._cell(b.bolted_fault_ka, this._n(b.bolted_fault_ka)),
      iarc: this._cell(b.arcing_current_ka, `${this._n(b.arcing_current_ka)} kA`),
    };
    Object.assign(cells, {
      e: this._cell(b.incident_energy_cal, `<strong>${this._n(b.incident_energy_cal)}</strong>`),
      afb: this._cell(b.arc_flash_boundary_mm, this._n((b.arc_flash_boundary_mm || 0) / 1000)),
      t: this._cell(b.clearing_time_s, this._n((b.clearing_time_s || 0) * 1000, 0)),
      ppe: this._cell(b.ppe_category === -1 ? 99 : b.ppe_category, b.ppe_category === -1 ? 'DANGER' : String(b.ppe_category)),
    });
    return { id: b.bus_id, name: b.bus_name || b.bus_id, status, reasons, cells, actions: ['props'] };
  },
  _m_arcflash() {
    const r = AppState.arcFlashResults, d = AppState.dcArcFlashResults;
    if (!r && !d) return null;
    const notes = [];
    for (const w of [...(r?.warnings || []), ...(d?.warnings || [])]) notes.push({ level: 'warn', text: w });
    const cols = (dc) => [{ key: 'kv', label: dc ? 'DC voltage' : 'Voltage', num: true }, { key: 'ibf', label: 'Bolted (kA)', num: true },
      { key: 'iarc', label: 'Arcing', num: true }, { key: 'e', label: 'Energy (cal/cm²)', num: true },
      { key: 'afb', label: 'AFB (m)', num: true, title: 'Arc flash boundary' }, { key: 't', label: 'Clearing (ms)', num: true },
      { key: 'ppe', label: 'PPE', num: true }];
    const sections = [];
    if (r) sections.push({ id: 'ac', title: 'Buses', cols: cols(false), rows: Object.values(r.buses || {}).map(b => this._afRow(b, false)),
      defaultSort: { col: 'e', dir: -1 } });
    if (d) sections.push({ id: 'dc', title: 'DC buses', cols: cols(true), rows: Object.values(d.buses || {}).map(b => this._afRow(b, true)),
      defaultSort: { col: 'e', dir: -1 } });
    return { summary: r ? (r.method || 'IEEE 1584') : 'DC arc flash', notes, sections };
  },

  _m_cable() {
    const r = AppState.cableSizingResults;
    if (!r) return null;
    const notes = (r.warnings || []).map(w => ({ level: 'warn', text: w }));
    const focus = typeof CableFocus !== 'undefined' && CableFocus.filtering && CableFocus.filtering() ? CableFocus.busId : null;
    const at = focus ? CableFocus.cablesAt(focus, r) : null;
    const list = at ? at.map(e => ({ c: e.cable, dir: e.dir, other: e.otherId })) : (r.cables || []).map(c => ({ c }));
    const rows = list.map(({ c, dir, other }) => {
      const status = c.status === 'fail' ? 'fail' : (c.status === 'warning' || c.status === 'unknown') ? 'warn' : 'ok';
      const reasons = [...(c.issues || []), ...((c.status === 'warning' || c.status === 'unknown') ? (c.warning_reasons || []) : [])];
      if (c.recommended_cable && c.status === 'fail') reasons.push(`Recommended: ${c.recommended_cable}.`);
      if (c.overload_protection_note && c.overload_protection_ok === false) reasons.push(c.overload_protection_note);
      const cum = c.cumulative_voltage_drop_pct;
      return { id: c.cable_id, name: c.cable_name || c.cable_id, status, reasons,
        cells: {
          ends: this._cell(dir ? `${dir === 'in' ? 'in from' : 'out to'} ${other ? this._name(other) : '—'}` : `${c.from_bus} → ${c.to_bus}`),
          i: this._cell(c.load_current_a, this._n(c.load_current_a, 1)),
          th: this._cell(c.thermal_loading_pct, `${c.thermal_ok === false ? '✗' : '✓'} ${this._n(c.thermal_loading_pct, 0)} %`),
          vd: this._cell(cum != null ? cum : c.voltage_drop_pct, `${c.voltage_drop_ok === false ? '✗' : '✓'} ${this._n(c.voltage_drop_pct)} %${cum != null ? ` <span class="rp-sub" title="From ${escHtml(c.voltage_drop_origin || 'the origin')}">Σ ${this._n(cum)} %</span>` : ''}`),
          prot: this._cell(c.overload_protection_ok == null ? null : (c.overload_protection_ok ? 1 : 0), c.overload_protection_ok == null ? '—' : (c.overload_protection_ok ? '✓' : '✗')),
          ws: this._cell(c.fault_withstand_ok ? 1 : 0, c.fault_withstand_ok ? '✓' : '✗'),
          rec: this._cell(c.recommended_cable || '', escHtml(c.recommended_cable || '—')),
        },
        actions: ['props', 'cable-focus'] };
    });
    const sec = { id: 'cables', title: focus ? `Cables at ${this._name(focus)}` : 'Cables', cols: [
      { key: 'ends', label: focus ? 'Direction' : 'From → To' }, { key: 'i', label: 'Load (A)', num: true },
      { key: 'th', label: 'Thermal', num: true }, { key: 'vd', label: 'Volt drop', num: true, title: 'Across this cable; Σ = from the origin of the installation, which the limit applies to' },
      { key: 'prot', label: 'Protection', num: true, title: 'Overload protection, IEC 60364-4-43 §433.1' },
      { key: 'ws', label: 'Withstand', num: true }, { key: 'rec', label: 'Recommended' }], rows };
    sec.tools = [{ id: 'focus', label: focus ? `Showing cables at ${this._name(focus)} · show all` : 'Only cables at the selected bus', active: !!focus,
      title: 'Also filters the cable boxes on the diagram (Esc shows all again)',
      run: () => { if (CableFocus.active) CableFocus.disable(); else CableFocus.enable(); } }];
    return { summary: 'IEC 60364 · thermal, volt drop, protection, fault withstand', notes, sections: [sec] };
  },

  _m_duty() {
    const r = AppState.dutyCheckResults;
    if (!r) return null;
    const notes = (r.warnings || []).map(w => ({ level: 'warn', text: w }));
    const st = (x) => x.status === 'fail' ? 'fail' : x.status === 'warning' ? 'warn' : 'ok';
    const sections = [];
    if ((r.transformers || []).length) sections.push({ id: 'tx', title: 'Transformer loading', cols: [
      { key: 'bus', label: 'Bus' }, { key: 'rated', label: 'Rated (MVA)', num: true }, { key: 'load', label: 'Load (MVA)', num: true },
      { key: 'pct', label: 'Loading', num: true }],
    rows: r.transformers.map(t => ({ id: t.device_id, name: t.device_name, status: st(t), reasons: t.issues || [],
      cells: { bus: this._cell(t.location_bus), rated: this._cell(t.rated_mva, this._n(t.rated_mva, 3)),
        load: this._cell(t.load_mva, this._n(t.load_mva, 3)), pct: this._cell(t.loading_pct, `${this._n(t.loading_pct, 1)} %`) },
      actions: ['props'] })) });
    if ((r.devices || []).length) sections.push({ id: 'devices', title: 'Protective device duty', cols: [
      { key: 'type', label: 'Type' }, { key: 'bus', label: 'Bus' }, { key: 'ik', label: 'Fault (kA)', num: true },
      { key: 'rating', label: 'Rating (kA)', num: true }, { key: 'util', label: 'Utilisation', num: true }, { key: 'cont', label: 'Continuous', num: true }],
    rows: r.devices.map(d => {
      const reasons = [...(d.issues || [])];
      if (d.cascade) reasons.push(`Cascading with ${d.cascade.upstream_name} upstream: reinforced to ${this._n(d.cascade.reinforced_ka)} kA (own ${this._n(d.breaking_capacity_ka)} kA, IEC 60947-2 Annex A).`);
      const rating = d.cascade ? d.cascade.reinforced_ka : d.breaking_capacity_ka;
      return { id: d.device_id, name: d.device_name, status: st(d), reasons,
        cells: { type: this._cell(String(d.device_type || '').toUpperCase()), bus: this._cell(d.location_bus),
          ik: this._cell(d.prospective_fault_ka, this._n(d.prospective_fault_ka)),
          rating: this._cell(rating, `${this._n(rating)}${d.cascade ? ' <span class="rp-sub" title="Cascading">casc.</span>' : ''}`),
          util: this._cell(d.utilisation_pct, `${this._n(d.utilisation_pct, 0)} %`),
          cont: this._cell(d.continuous_ok ? 1 : 0, d.continuous_ok ? '✓' : '✗') },
        actions: ['props', 'tcc'] };
    }) });
    if ((r.ct_checks || []).length) sections.push({ id: 'ct', title: 'CT saturation', cols: [
      { key: 'bus', label: 'Bus' }, { key: 'ratio', label: 'Ratio' }, { key: 'ik', label: 'Fault (kA)', num: true },
      { key: 'alf', label: 'ALF′', num: true }, { key: 'head', label: 'Headroom', num: true },
      { key: 'tsat', label: 't sat (ms)', num: true, title: 'Time for a fully offset fault to saturate the core; 0 = saturates symmetrically' }],
    rows: r.ct_checks.map(c => ({ id: c.device_id, name: c.device_name, status: st(c), reasons: c.issues || [],
      cells: { bus: this._cell(c.location_bus), ratio: this._cell(String(c.ratio)),
        ik: this._cell(c.prospective_fault_ka, `${this._n(c.prospective_fault_ka)}${c.fault_basis === 'Ik1' ? ' (Ik1)' : ''}`),
        alf: this._cell(c.alf_effective, this._n(c.alf_effective, 1)), head: this._cell(c.headroom_pct, c.headroom_pct != null ? `${this._n(c.headroom_pct, 0)} %` : '—'),
        tsat: this._cell(c.time_to_saturation_ms, this._n(c.time_to_saturation_ms, 1)) },
      actions: ['props'] })) });
    if ((r.pt_checks || []).length) sections.push({ id: 'pt', title: 'VT adequacy', cols: [
      { key: 'bus', label: 'Bus' }, { key: 'ratio', label: 'Ratio' }, { key: 'cls', label: 'Class' },
      { key: 'load', label: 'Burden', num: true }, { key: 'vr', label: 'V / Vr', num: true }, { key: 'vf', label: 'Vf req / rated' }],
    rows: r.pt_checks.map(c => ({ id: c.device_id, name: c.device_name, status: st(c), reasons: c.issues || [],
      cells: { bus: this._cell(c.location_bus), ratio: this._cell(String(c.ratio)), cls: this._cell(String(c.accuracy_class)),
        load: this._cell(c.loading_pct, c.loading_pct != null ? `${this._n(c.loading_pct, 0)} %` : '—'),
        vr: this._cell(c.service_voltage_pct, c.service_voltage_pct != null ? `${this._n(c.service_voltage_pct, 0)} %` : '—'),
        vf: this._cell(`${c.required_voltage_factor != null ? this._n(c.required_voltage_factor) : '—'} / ${c.voltage_factor || '—'}`) },
      actions: ['props'] })) });
    return { summary: 'IEC 60947-2 / IEC 60269 / IEC 62271-100 · breaking duty, loading, CTs and VTs', notes, sections };
  },

  // ── Studies on the single line saved with the project ───────────────
  _warnNotes(list) { return (list || []).map(w => ({ level: 'warn', text: typeof w === 'string' ? w : (w && w.message) || String(w) })); },
  _st(x) { return x === 'fail' ? 'fail' : (x === 'warning' || x === 'warn') ? 'warn' : 'ok'; },
  _pct(v, d = 1) { return v == null || !isFinite(v) ? '—' : `${Number(v).toFixed(d)} %`; },

  _m_unbalancedLF() {
    const r = AppState.unbalancedLoadFlowResults;
    if (!r) return null;
    const notes = [];
    if (r.converged === false) notes.push({ level: 'fail', text: 'Unbalanced load flow did not converge — the results are not reliable.' });
    notes.push(...this._warnNotes(r.warnings));
    const lim = (kv) => typeof vufLimitPct === 'function' ? vufLimitPct(kv) : 2;
    const busName = (id) => (r.buses && r.buses[id] && r.buses[id].bus_name) || this._name(id);
    const buses = Object.entries(r.buses || {}).map(([id, b]) => {
      const reasons = [];
      let status = 'ok';
      const L = lim(b.voltage_kv);
      if (b.vuf_pct > L) { status = 'fail'; reasons.push(`Voltage unbalance ${this._n(b.vuf_pct)} % is above the ${L} % limit for ${this._n(b.voltage_kv, 2)} kV.`); }
      else if (b.vuf_pct > 1) { status = 'warn'; reasons.push(`Voltage unbalance ${this._n(b.vuf_pct)} % is above 1 %.`); }
      const dev = Math.max(...[b.va_pu, b.vb_pu, b.vc_pu].map(v => Math.abs((v ?? 1) - 1)));
      if (dev > 0.10) { status = 'fail'; reasons.push('A phase voltage is outside ±10 % of nominal.'); }
      else if (dev > 0.05) { if (status === 'ok') status = 'warn'; reasons.push('A phase voltage is outside ±5 % of nominal.'); }
      return { id: b.bus_id || id, name: b.bus_name || id, status, reasons,
        cells: {
          kv: this._cell(b.voltage_kv, this._n(b.voltage_kv, 3)),
          va: this._cell(b.va_pu, this._n(b.va_pu, 4)), vb: this._cell(b.vb_pu, this._n(b.vb_pu, 4)), vc: this._cell(b.vc_pu, this._n(b.vc_pu, 4)),
          v2: this._cell(b.v2_pu, this._n(b.v2_pu, 4)), v0: this._cell(b.v0_pu, this._n(b.v0_pu, 4)),
          vuf: this._cell(b.vuf_pct, this._pct(b.vuf_pct, 2)),
        },
        actions: ['props'] };
    });
    const branches = (r.branches || []).map(br => {
      const L = br.loading_pct || 0;
      const status = L > 100 ? 'fail' : L > 90 ? 'warn' : 'ok';
      return { id: br.elementId, name: br.element_name || this._name(br.elementId), status,
        reasons: L > 100 ? [`Loaded to ${L.toFixed(0)} % of its rating (worst phase).`] : L > 90 ? [`Loaded to ${L.toFixed(0)} % of its rating — little margin.`] : [],
        cells: {
          ends: this._cell(`${busName(br.from_bus)} → ${busName(br.to_bus)}`),
          ia: this._cell(br.ia_amps, this._n(br.ia_amps, 1)), ib: this._cell(br.ib_amps, this._n(br.ib_amps, 1)),
          ic: this._cell(br.ic_amps, this._n(br.ic_amps, 1)), in: this._cell(br.in_amps, this._n(br.in_amps, 1)),
          load: this._cell(L, this._pct(L)),
        },
        actions: ['props'] };
    });
    return { summary: `${r.method || 'Sequence components'}${r.converged === false ? ' · did not converge' : (r.iterations != null ? ` · converged in ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` : '')}`,
      notes, sections: [
        { id: 'buses', title: 'Buses (phase voltages in pu of nominal)', cols: [{ key: 'kv', label: 'kV', num: true },
          { key: 'va', label: 'Va', num: true }, { key: 'vb', label: 'Vb', num: true }, { key: 'vc', label: 'Vc', num: true },
          { key: 'v2', label: 'V2', num: true, title: 'Negative sequence' }, { key: 'v0', label: 'V0', num: true, title: 'Zero sequence' },
          { key: 'vuf', label: 'VUF', num: true, title: 'Voltage unbalance factor |V2| / |V1| (IEC 61000-3-13)' }], rows: buses },
        { id: 'branches', title: 'Cables, lines and transformers (A)', cols: [{ key: 'ends', label: 'From → To' },
          { key: 'ia', label: 'Ia', num: true }, { key: 'ib', label: 'Ib', num: true }, { key: 'ic', label: 'Ic', num: true },
          { key: 'in', label: 'In', num: true, title: 'Neutral current' }, { key: 'load', label: 'Loading', num: true }], rows: branches },
      ] };
  },

  _m_ansi() {
    const r = AppState.ansiFaultResults;
    if (!r) return null;
    const notes = this._warnNotes(r.warnings);
    const f = (v, d = 2) => this._n(v, d);
    const buses = Object.values(r.buses || {}).map(b => ({ id: b.bus_id, name: b.bus_name || b.bus_id,
      status: b.warning ? 'warn' : 'info', reasons: b.warning ? [b.warning] : [],
      cells: {
        kv: this._cell(b.voltage_kv, f(b.voltage_kv)),
        mom: this._cell(b.i_sym_momentary_ka, f(b.i_sym_momentary_ka)),
        asym: this._cell(b.i_asym_momentary_ka, f(b.i_asym_momentary_ka)),
        int: this._cell(b.i_sym_interrupting_ka, f(b.i_sym_interrupting_ka)),
        xr: this._cell(b.x_r_interrupting, f(b.x_r_interrupting, 1)),
        lv: this._cell(b.i_sym_lv_first_cycle_ka, b.i_sym_lv_first_cycle_ka != null ? `${f(b.i_sym_lv_first_cycle_ka)} <span class="rp-sub">X/R ${f(b.x_r_lv_first_cycle, 1)}</span>` : '—'),
      },
      actions: ['props', 'fault-here'] }));
    const devices = (r.devices || []).map(d => {
      const passI = d.status_interrupting === 'PASS';
      const passL = d.status_closing_latching === 'PASS' || d.status_closing_latching === 'N/A';
      const status = (!passI && !d.requires_detailed_method) || !passL ? 'fail' : d.requires_detailed_method ? 'warn' : 'ok';
      const reasons = [];
      if (!passI && !d.requires_detailed_method) reasons.push(`Interrupting duty ${f(d.duty_interrupting_ka)} kA is above its capability ${f(d.capability_interrupting_ka)} kA.`);
      if (d.requires_detailed_method) reasons.push(String(d.status_interrupting));
      if (!passL) reasons.push(`Closing and latching duty ${f(d.duty_closing_latching_ka)} kA is above its capability ${f(d.capability_closing_latching_ka)} kA.`);
      if (d.method) reasons.push(`Method: ${d.method}.`);
      return { id: d.device_id, name: d.device_name || d.device_id, status, reasons,
        cells: {
          bus: this._cell(this._name(d.bus_id)),
          rated: this._cell(d.rated_interrupting_ka, `${f(d.rated_interrupting_ka, 1)} @ ${f(d.rated_max_kv, 1)} kV <span class="rp-sub">K ${f(d.k_factor)}</span>`),
          int: this._cell(d.capability_interrupting_ka ? d.duty_interrupting_ka / d.capability_interrupting_ka : null, `${f(d.duty_interrupting_ka)} / ${f(d.capability_interrupting_ka)}`),
          mf: this._cell(d.multiplying_factor, f(d.multiplying_factor, 3)),
          cl: this._cell(d.capability_closing_latching_ka ? d.duty_closing_latching_ka / d.capability_closing_latching_ka : null,
            d.status_closing_latching === 'N/A' ? 'N/A (LV)' : `${f(d.duty_closing_latching_ka)} / ${f(d.capability_closing_latching_ka)}`),
        },
        actions: ['props', 'tcc'] };
    });
    const sections = [{ id: 'buses', title: 'Bus fault duty, E/X method, three-phase (kA)', cols: [{ key: 'kv', label: 'kV', num: true },
      { key: 'mom', label: 'Sym. momentary', num: true }, { key: 'asym', label: 'Asym. momentary / C&L', num: true },
      { key: 'int', label: 'Sym. interrupting', num: true }, { key: 'xr', label: 'X/R int.', num: true },
      { key: 'lv', label: 'LV first cycle', num: true }], rows: buses }];
    sections.push({ id: 'devices', title: 'Breaker duty (C37.010 above 1 kV; LV first cycle at or below)', cols: [{ key: 'bus', label: 'Bus' },
      { key: 'rated', label: 'Rated (kA)', num: true }, { key: 'int', label: 'Interrupting duty / capability', num: true },
      { key: 'mf', label: 'MF', num: true, title: 'Multiplying factor' }, { key: 'cl', label: 'Closing & latching duty / capability', num: true }],
    rows: devices, defaultSort: { col: 'status', dir: 1 } });
    return { summary: 'ANSI / IEEE C37.010 · momentary, interrupting and closing-latching duty', notes, sections };
  },

  _m_motor() {
    const r = AppState.motorStartingResults;
    if (!r) return null;
    const rows = (r.motors || []).map(m => {
      const dips = m.collapse ? [] : Object.entries(m.bus_dips || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const reasons = [...(m.issues || [])];
      if (!m.motor_will_start) reasons.unshift('The motor will not start: its torque at this voltage is below the load torque.');
      const detail = dips.length ? `<table class="rp-mini"><thead><tr><th>Worst bus dips</th><th class="rp-num">Dip</th></tr></thead><tbody>${dips.map(([bus, d]) =>
        `<tr><td>${escHtml(bus)}</td><td class="rp-num${d > 15 ? ' rp-fail' : d > 10 ? ' rp-warn' : ''}">${this._n(d)} %</td></tr>`).join('')}</tbody></table>` : '';
      return { id: m.motor_id, name: m.motor_name || m.motor_id, status: this._st(m.status), reasons, detail,
        cells: {
          kw: this._cell(m.rated_kw, `${this._n(m.rated_kw, 1)}${m.motor_type ? ` <span class="rp-sub">${escHtml(m.motor_type)}</span>` : ''}`),
          start: this._cell(m.starting_method || ''),
          ist: this._cell(m.start_current_a, this._n(m.start_current_a, 0)),
          vt: this._cell(m.collapse ? 0 : m.motor_terminal_voltage_pu, m.collapse ? 'collapse' : `${m.estimate ? '≈ ' : ''}${this._n(m.motor_terminal_voltage_pu, 3)}`),
          go: this._cell(m.motor_will_start ? 1 : 0, m.motor_will_start ? '✓' : '✗'),
          dip: this._cell(m.collapse ? null : m.max_system_dip_pct, m.collapse ? '—' : `${this._n(m.max_system_dip_pct, 1)} % <span class="rp-sub">${escHtml(m.max_dip_bus || '')}</span>`),
        },
        actions: ['props'] };
    });
    return { summary: 'Locked-rotor voltage dip at start', notes: this._warnNotes(r.warnings), sections: [
      { id: 'motors', title: 'Motors', cols: [{ key: 'kw', label: 'kW', num: true }, { key: 'start', label: 'Starter' },
        { key: 'ist', label: 'Start I (A)', num: true }, { key: 'vt', label: 'Terminal V (pu)', num: true },
        { key: 'go', label: 'Starts', num: true }, { key: 'dip', label: 'Largest dip', num: true }], rows,
      defaultSort: { col: 'status', dir: 1 } }] };
  },

  _m_dcLoadflow() {
    const r = AppState.dcLoadFlowResults;
    if (!r) return null;
    const notes = [];
    if (r.converged === false) notes.push({ level: 'fail', text: 'DC load flow did not converge — the results are not reliable.' });
    notes.push(...this._warnNotes(r.warnings));
    const busName = (id) => (r.buses && r.buses[id] && r.buses[id].bus_name) || this._name(id);
    const buses = Object.values(r.buses || {}).map(b => {
      const de = b.energized === false;
      const status = de || Math.abs(b.drop_pct || 0) > 5 ? 'warn' : 'ok';
      return { id: b.bus_id, name: b.bus_name || b.bus_id, status,
        reasons: de ? ['De-energised: no DC source reaches this bus.'] : Math.abs(b.drop_pct || 0) > 5 ? [`${this._n(b.drop_pct)} % from nominal.`] : [],
        cells: {
          v: this._cell(de ? null : b.voltage_v, de ? '—' : this._n(b.voltage_v, 1)),
          nom: this._cell(b.nominal_v, this._n(b.nominal_v, 0)),
          pct: this._cell(de ? null : b.voltage_pu, de ? '—' : this._pct(b.voltage_pu * 100)),
          drop: this._cell(de ? null : b.drop_pct, de ? '—' : this._pct(b.drop_pct, 2)),
          kw: this._cell(b.load_kw, this._n(b.load_kw)),
        },
        actions: ['props'] };
    });
    const sources = (r.sources || []).map(x => ({ id: x.source_id, name: x.source_name || x.source_id,
      status: x.current_limited ? 'warn' : 'ok', reasons: x.current_limited ? ['Held at its rated current: it cannot supply the load in full.'] : [],
      cells: {
        type: this._cell(x.source_type), bus: this._cell(busName(x.bus_id)),
        v: this._cell(x.voltage_v, this._n(x.voltage_v, 1)), i: this._cell(x.current_a, this._n(x.current_a, 1)),
        kw: this._cell(x.power_kw, this._n(x.power_kw)), load: this._cell(x.loading_pct, this._pct(x.loading_pct, 0)),
      },
      actions: ['props'] }));
    const branches = (r.branches || []).map(br => {
      const L = br.loading_pct || 0;
      return { id: br.elementId, name: br.element_name || br.elementId, status: L > 100 ? 'fail' : L > 90 ? 'warn' : 'ok',
        reasons: L > 100 ? [`Loaded to ${L.toFixed(0)} % of its rating.`] : L > 90 ? [`Loaded to ${L.toFixed(0)} % of its rating — little margin.`] : [],
        cells: {
          ends: this._cell(`${busName(br.from_bus)} → ${busName(br.to_bus)}`),
          i: this._cell(br.current_a, this._n(br.current_a, 1)), vd: this._cell(br.voltage_drop_v, this._n(br.voltage_drop_v)),
          r: this._cell(br.resistance_ohm, this._n(br.resistance_ohm, 4)), loss: this._cell(br.loss_kw, this._n(br.loss_kw, 3)),
          load: this._cell(L, this._pct(L, 0)),
        },
        actions: ['props'] };
    });
    const sections = [{ id: 'buses', title: 'DC buses', cols: [{ key: 'v', label: 'V', num: true }, { key: 'nom', label: 'Nominal (V)', num: true },
      { key: 'pct', label: '% nominal', num: true }, { key: 'drop', label: 'Drop', num: true }, { key: 'kw', label: 'Load (kW)', num: true }], rows: buses }];
    if (sources.length) sections.push({ id: 'sources', title: 'Sources', cols: [{ key: 'type', label: 'Type' }, { key: 'bus', label: 'Bus' },
      { key: 'v', label: 'V', num: true }, { key: 'i', label: 'I (A)', num: true }, { key: 'kw', label: 'kW', num: true },
      { key: 'load', label: 'Loading', num: true }], rows: sources });
    if (branches.length) sections.push({ id: 'branches', title: 'Cables', cols: [{ key: 'ends', label: 'From → To' },
      { key: 'i', label: 'I (A)', num: true }, { key: 'vd', label: 'Drop (V)', num: true }, { key: 'r', label: 'R loop (Ω)', num: true },
      { key: 'loss', label: 'Loss (kW)', num: true }, { key: 'load', label: 'Loading', num: true }], rows: branches });
    return { summary: `${r.method || 'DC nodal'}${r.iterations ? ` · ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` : ''}`, notes, sections,
      empty: Object.keys(r.buses || {}).length ? null : 'No DC buses. Set a bus’s System to DC to model a DC network.' };
  },

  _m_dcShortCircuit() {
    const r = AppState.dcShortCircuitResults;
    if (!r) return null;
    const rows = Object.values(r.buses || {}).map(b => {
      const c = b.contributions || [];
      const detail = c.length ? `<table class="rp-mini"><thead><tr><th>Source</th><th>Type</th><th class="rp-num">Ik (kA)</th><th class="rp-num">ip (kA)</th><th class="rp-num">tp (ms)</th><th class="rp-num">R (mΩ)</th></tr></thead><tbody>${c.map(x =>
        `<tr><td>${escHtml(x.source_name || x.source_id)}</td><td>${escHtml(x.source_type)}</td><td class="rp-num">${this._n(x.ik_ka, 3)}</td><td class="rp-num">${this._n(x.ip_ka, 3)}</td><td class="rp-num">${this._n(x.tp_ms, 1)}</td><td class="rp-num">${this._n(x.r_mohm, 1)}</td></tr>`).join('')}</tbody></table>` : '';
      return { id: b.bus_id, name: b.bus_name || b.bus_id, status: c.length ? 'info' : 'warn',
        reasons: c.length ? (b.note ? [b.note] : []) : ['No DC source reaches this bus.'], detail,
        cells: {
          nom: this._cell(b.nominal_v, this._n(b.nominal_v, 0)), ik: this._cell(b.ik_ka, this._n(b.ik_ka)),
          ip: this._cell(b.ip_ka, this._n(b.ip_ka)), tp: this._cell(b.tp_ms, this._n(b.tp_ms, 1)),
          tau: this._cell(b.time_constant_ms, this._n(b.time_constant_ms, 1)), n: this._cell(c.length, String(c.length)),
        },
        actions: ['props'] };
    });
    return { summary: `${r.standard || 'IEC 61660-1'} · maximum, conductors at 20 °C`, notes: this._warnNotes(r.warnings),
      empty: rows.length ? null : 'No DC buses. Set a bus’s System to DC to model a DC network.',
      foot: 'Battery: ip = EB / RBBr, Ik = 0.95·EB / (RBBr + 0.1·RB). Diode / thyristor rectifiers and chargers: the IEC rectifier procedure from their AC supply; switch-mode converters: current-limited. Contributions are superposition shares of a nodal solve and sum to the total. Capacitor and DC-motor sources are not modelled.',
      sections: [{ id: 'buses', title: 'DC buses', cols: [{ key: 'nom', label: 'Nominal (V)', num: true },
        { key: 'ik', label: 'Ik (kA)', num: true, title: 'Quasi steady-state current' }, { key: 'ip', label: 'ip (kA)', num: true, title: 'Peak current' },
        { key: 'tp', label: 'tp (ms)', num: true, title: 'Time to peak' }, { key: 'tau', label: 'τ1 (ms)', num: true, title: 'Rise time constant' },
        { key: 'n', label: 'Sources', num: true }], rows }] };
  },

  _m_loadDiversity() {
    const r = AppState.loadDiversityResults;
    if (!r) return null;
    const s = r.summary || {};
    const notes = this._warnNotes(r.warnings);
    const tx = (r.transformers || []).map(t => ({ id: t.transformer_id, name: t.transformer_name || t.transformer_id,
      status: this._st(t.status), reasons: t.issues || [],
      cells: {
        kva: this._cell(t.rated_kva, this._n(t.rated_kva, 0)), feeds: this._cell((t.fed_buses || []).join(', ') || '—'),
        inst: this._cell(t.installed_kva, this._n(t.installed_kva, 0)), dem: this._cell(t.demand_kva, this._n(t.demand_kva, 0)),
        ipct: this._cell(t.installed_loading_pct, this._pct(t.installed_loading_pct)),
        dpct: this._cell(t.demand_loading_pct, `<strong>${this._pct(t.demand_loading_pct)}</strong>`),
      },
      actions: ['props'] }));
    const kind = { load: 'Load', feeder: 'Feeder', schedule: 'DB schedule' };
    const boards = (r.buses || []).map(b => {
      const c = b.circuits || [];
      const detail = c.length ? `<table class="rp-mini"><thead><tr><th>Circuit</th><th>Type</th><th class="rp-num">Installed kVA</th><th class="rp-num">Demand kVA</th><th class="rp-num">Demand kW</th></tr></thead><tbody>${c.map(x =>
        `<tr><td>${escHtml(x.name)}</td><td>${escHtml(kind[x.kind] || x.kind)}</td><td class="rp-num">${this._n(x.installed_kva, 1)}</td><td class="rp-num">${this._n(x.demand_kva, 1)}</td><td class="rp-num">${this._n(x.demand_kw, 1)}</td></tr>`).join('')}</tbody></table>` : '';
      return { id: b.bus_id, name: b.bus_name || b.bus_id, status: 'info',
        reasons: b.capacitor_kvar > 0 ? [`Less ${this._n(b.capacitor_kvar, 0)} kvar of capacitor banks on this board.`] : [], detail,
        cells: {
          from: this._cell((b.fed_from || []).join(', ') || '—'), n: this._cell(b.num_circuits ?? b.num_loads, String(b.num_circuits ?? b.num_loads ?? '—')),
          inst: this._cell(b.installed_kva, this._n(b.installed_kva, 0)), sum: this._cell(b.demand_kva, this._n(b.demand_kva, 0)),
          ks: this._cell(b.diversity_factor, this._n(b.diversity_factor)),
          md: this._cell(b.diversified_demand_kva, `<strong>${this._n(b.diversified_demand_kva, 0)}</strong>`),
          i: this._cell(b.demand_current_a, this._n(b.demand_current_a, 1)),
        },
        actions: ['props'] };
    });
    const sections = [];
    if (tx.length) sections.push({ id: 'tx', title: 'Transformer loading (kVA)', cols: [{ key: 'kva', label: 'Rating', num: true },
      { key: 'feeds', label: 'Feeds' }, { key: 'inst', label: 'Installed', num: true }, { key: 'dem', label: 'Demand', num: true },
      { key: 'ipct', label: 'Installed %', num: true }, { key: 'dpct', label: 'Demand %', num: true }], rows: tx });
    sections.push({ id: 'boards', title: 'Board maximum demand (kVA)', cols: [{ key: 'from', label: 'Fed from' }, { key: 'n', label: 'Circuits', num: true },
      { key: 'inst', label: 'Installed', num: true }, { key: 'sum', label: 'Σ demand', num: true }, { key: 'ks', label: 'Ks', num: true, title: 'IEC 61439 rated diversity factor' },
      { key: 'md', label: 'Max demand', num: true }, { key: 'i', label: 'Current (A)', num: true }], rows: boards });
    const ks = r.ks_table || [];
    const ref = Object.values(r.reference_demand_factors || {});
    if (ks.length || ref.length) {
      sections.push({ id: 'factors', title: 'Factors used', html:
        (ks.length ? `<p class="rp-text"><b>Coincidence factor Ks</b> (IEC 61439 rated diversity factor): ${ks.map(k => `${escHtml(k.circuits)} circuit${k.circuits === '1' ? '' : 's'} ${this._n(k.ks, 1)}`).join(' · ')}</p>` : '')
        + (ref.length ? `<p class="rp-text"><b>Typical demand factors</b> (set per load): ${ref.map(i => `${this._n(i.factor)} ${escHtml(i.description)} <span class="rp-sub">${escHtml(i.source)}</span>`).join(' · ')}</p>` : '') });
    }
    const df = s.overall_demand_factor || 1;
    return { summary: `Overall demand factor ${this._n(df, 3)} · installed ${this._n(s.total_installed_kva, 0)} kVA · maximum demand ${this._n(s.total_demand_kva, 0)} kVA${df < 1 ? ` · diversity saves ${((1 - df) * 100).toFixed(0)} %` : ''}`,
      notes, sections, foot: 'Max demand = Ks × the phasor sum of the circuits’ demand (kW, kvar), less any capacitor kvar. Each board includes everything it feeds; Ks applies to LV boards only.' };
  },

  // A grounding grid in plan (mesh + rods), from the result's geometry.
  _gridSvg(b) {
    const Lx = Number(b.grid_length_m), Ly = Number(b.grid_width_m);
    const nx = Math.max(2, parseInt(b.num_conductors_x, 10) || 2), ny = Math.max(2, parseInt(b.num_conductors_y, 10) || 2);
    const nR = Math.max(0, parseInt(b.num_ground_rods, 10) || 0);
    if (!(Lx > 0) || !(Ly > 0)) return '';
    const VW = 240, VH = 150, pad = 22;
    const s = Math.min((VW - 2 * pad) / Lx, (VH - 2 * pad) / Ly);
    const gw = Lx * s, gh = Ly * s, ox = (VW - gw) / 2, oy = (VH - gh) / 2;
    const col = b.status === 'fail' ? '#d32f2f' : b.status === 'warning' ? '#f57c00' : '#2e7d32';
    let mesh = '';
    for (let i = 0; i < nx; i++) { const x = ox + (gw * i) / (nx - 1); mesh += `<line x1="${x.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(oy + gh).toFixed(1)}"/>`; }
    for (let j = 0; j < ny; j++) { const y = oy + (gh * j) / (ny - 1); mesh += `<line x1="${ox.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(ox + gw).toFixed(1)}" y2="${y.toFixed(1)}"/>`; }
    let rods = '';
    const perim = 2 * (gw + gh);
    for (let k = 0; k < nR; k++) {
      const d = (perim * k) / nR;
      let px, py;
      if (d < gw) { px = ox + d; py = oy; } else if (d < gw + gh) { px = ox + gw; py = oy + (d - gw); }
      else if (d < 2 * gw + gh) { px = ox + gw - (d - gw - gh); py = oy + gh; } else { px = ox; py = oy + gh - (d - 2 * gw - gh); }
      rods += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${col}" stroke="#fff" stroke-width="0.8"/>`;
    }
    return `<svg viewBox="0 0 ${VW} ${VH}" width="240" class="rp-grid-svg" role="img" aria-label="Earthing grid plan: ${Lx} by ${Ly} metres, ${nx} by ${ny} mesh, ${nR} rods">
      <g stroke="${col}" stroke-width="1" opacity="0.85">${mesh}</g>${rods}
      <text x="${(ox + gw / 2).toFixed(1)}" y="${(oy - 7).toFixed(1)}" text-anchor="middle" font-size="9" fill="currentColor">${Lx} m — ${nx}×${ny} mesh${nR ? ` · ${nR} rod${nR > 1 ? 's' : ''}` : ''}</text>
      <text x="${(ox - 7).toFixed(1)}" y="${(oy + gh / 2).toFixed(1)}" text-anchor="middle" font-size="9" fill="currentColor" transform="rotate(-90 ${(ox - 7).toFixed(1)} ${(oy + gh / 2).toFixed(1)})">${Ly} m</text></svg>`;
  },
  _groundDetail(b, result) {
    if (b.method && typeof EarthGridEditor !== 'undefined' && EarthGridEditor.resultCardHtml) return EarthGridEditor.resultCardHtml(b, result);
    const cond = typeof EarthGridEditor !== 'undefined' && EarthGridEditor.conductorHtml ? EarthGridEditor.conductorHtml(b) : escHtml(String(b.conductor_size_mm2 ?? ''));
    let h = `<div class="rp-kv"><span>Grid <b>${escHtml(b.grid_dimensions)}</b></span><span>Soil <b>${escHtml(b.soil_resistivity)} Ω·m</b></span>
      <span>Rods <b>${escHtml(b.num_ground_rods)}</b></span><span>L total <b>${escHtml(b.total_conductor_length_m)} m</b></span><span>Conductor ${cond}</span></div>`;
    if (b.two_layer_soil_enabled) h += `<p class="rp-text">Two-layer soil: ρ1 ${escHtml(b.soil_resistivity)} Ω·m, ρ2 ${escHtml(b.soil_resistivity_lower)} Ω·m, h1 ${escHtml(b.upper_layer_thickness_m)} m → K ${escHtml(b.two_layer_reflection_factor_K)}; against uniform ρ1: R ×${escHtml(b.two_layer_ratio_R)}, touch ×${escHtml(b.two_layer_ratio_Em)}, step ×${escHtml(b.two_layer_ratio_Es)} (ρeq ${escHtml(b.equivalent_resistivity_ohm_m)} Ω·m).</p>`;
    if (b.remote_fraction != null && (b.remote_fraction < 1 || b.current_split_factor < 1)) h += `<p class="rp-text">Grid current IG = Df × Sf × remote share × 3I0 = ${escHtml(b.decrement_factor_df)} × ${escHtml(b.current_split_factor)} × ${escHtml(b.remote_fraction)} × ${escHtml(b.symmetrical_fault_ka)} kA = <b>${escHtml(b.fault_current_ka)} kA</b>; conductor sized for ${escHtml(b.conductor_current_ka)} kA.</p>`;
    h += this._gridSvg(b);
    for (const n of b.notes || []) h += `<p class="rp-text rp-sub">ⓘ ${escHtml(n)}</p>`;
    return h;
  },
  _m_grounding() {
    const r = AppState.groundingResults;
    if (!r) return null;
    const notes = this._warnNotes(r.warnings);
    if (r.scope && Array.isArray(r.scope.bus_ids)) notes.push({ level: 'info', text: `Selected bus${r.scope.bus_ids.length === 1 ? '' : 'es'} only — run with nothing selected for every bus.` });
    const rows = (r.buses || []).map(b => ({ id: b.bus_id, name: `${b.bus_name || b.bus_id}`, status: this._st(b.status),
      reasons: b.issues || [], detail: this._groundDetail(b, r),
      cells: {
        kv: this._cell(b.voltage_kv, this._n(b.voltage_kv, 2)),
        ik: this._cell(b.fault_current_ka, this._n(b.fault_current_ka)),
        rg: this._cell(b.grid_resistance_ohm, this._n(b.grid_resistance_ohm, 3)),
        gpr: this._cell(b.gpr_v, this._n(b.gpr_v, 0)),
        touch: this._cell(b.tolerable_touch_v ? b.mesh_voltage_v / b.tolerable_touch_v : null, `${b.touch_ok ? '✓' : '✗'} ${this._n(b.mesh_voltage_v, 0)} / ${this._n(b.tolerable_touch_v, 0)}`),
        step: this._cell(b.tolerable_step_v ? b.step_voltage_v / b.tolerable_step_v : null, `${b.step_ok ? '✓' : '✗'} ${this._n(b.step_voltage_v, 0)} / ${this._n(b.tolerable_step_v, 0)}`),
      },
      actions: ['props'] }));
    const numerical = (r.buses || []).some(b => b.method);
    return { summary: numerical ? 'IEEE 80 and earth-grid method of moments' : 'IEEE 80', notes,
      empty: rows.length ? null : 'No buses with fault data for the grounding study.',
      sections: [{ id: 'buses', title: 'Buses', cols: [{ key: 'kv', label: 'kV', num: true }, { key: 'ik', label: 'IG (kA)', num: true, title: 'Grid current' },
        { key: 'rg', label: 'R grid (Ω)', num: true }, { key: 'gpr', label: 'GPR (V)', num: true },
        { key: 'touch', label: 'Touch (V) actual / limit', num: true }, { key: 'step', label: 'Step (V) actual / limit', num: true }], rows,
      defaultSort: { col: 'status', dir: 1 } }] };
  },

  _m_harmonics() {
    const r = this.result('harmonics');
    if (!r) return null;
    const std = r.limits_standard === 'iec' ? 'iec' : 'ieee519';
    const stdName = std === 'iec' ? 'IEC 61000-3-6 / 61000-2-4' : 'IEEE 519-2014';
    const notes = this._warnNotes(r.warnings);
    const limits = { id: 'limits', title: 'Limits', tools: [
      { id: 'ieee', label: 'IEEE 519-2014', active: std === 'ieee519', title: 'Voltage + PCC current limits', run: () => this._harmLimits(null) },
      { id: 'iec', label: 'IEC 61000', active: std === 'iec', title: 'IEC 61000-3-6 planning levels (MV/HV) · IEC 61000-2-4 Class 2 (LV)', run: () => this._harmLimits('iec') }],
    html: `<p class="rp-text rp-sub">Changing the limits re-runs the study and is saved with the project.</p>` };
    if (r.note) return { summary: stdName, notes: [...notes, { level: 'info', text: r.note }], sections: [limits] };
    const sections = [limits];
    const pcc = r.pcc;
    if (pcc) {
      const graded = pcc.compliant != null;
      const lims = pcc.harmonic_limits || {};
      const over = new Set((pcc.exceeding_orders || []).map(String));
      sections.push({ id: 'pcc', title: `Point of common coupling — ${pcc.name} (${pcc.voltage_kv} kV)`, html:
        `<div class="rp-kv"><span>ISC / IL <b>${escHtml(pcc.isc_il)}</b></span><span>Current TDD <b>${escHtml(pcc.i_tdd_pct)} %</b></span>`
        + (graded ? `<span>TDD limit <b>${escHtml(pcc.tdd_limit_pct)} %</b></span><span class="${pcc.compliant ? 'rp-ok' : 'rp-fail'}"><b>${pcc.compliant ? '✓ passes' : '✗ over its limit'}</b></span>` : '<span class="rp-sub">Not graded (IEC: emission allocation needs planning data)</span>')
        + `</div><p class="rp-text rp-sub">Ih % of IL${graded ? ' / IEEE 519 individual limit' : ''}: ${Object.entries(pcc.harmonics || {}).map(([h, v]) =>
          `<span class="${over.has(h) ? 'rp-fail' : ''}">h${escHtml(h)} ${escHtml(v)} %${lims[h] != null ? ` / ${escHtml(lims[h])} %` : ''}</span>`).join(' · ')}</p>` });
    }
    const vfdBus = {};
    for (const v of r.vfd_sources || []) vfdBus[v.bus_id] = true;
    sections.push({ id: 'buses', title: 'Bus voltage distortion', cols: [{ key: 'kv', label: 'kV', num: true },
      { key: 'thd', label: 'THDV %', num: true }, { key: 'lim', label: 'Limit %', num: true }, { key: 'crit', label: 'Critical order', num: true, title: 'The order nearest its own limit' },
      { key: 'ihd', label: 'IHD %', num: true }, { key: 'ihdl', label: 'IHD limit %', num: true }, { key: 'basis', label: 'Basis' }],
    rows: (r.buses || []).map(b => ({ id: b.id, name: b.name || b.id, status: b.compliant ? 'ok' : 'fail',
      reasons: b.compliant ? [] : [`THDV ${b.thd_v_pct} % or an individual order is above its limit (${b.thd_limit_pct} % THD, ${b.ihd_limit_pct} % IHD).`],
      cells: {
        kv: this._cell(b.voltage_kv, String(b.voltage_kv)), thd: this._cell(b.thd_v_pct, `<strong>${escHtml(b.thd_v_pct)}</strong>`),
        lim: this._cell(b.thd_limit_pct, String(b.thd_limit_pct)), crit: this._cell(b.critical_order, b.critical_order != null ? String(b.critical_order) : '—'),
        ihd: this._cell(b.critical_order != null ? b.critical_ihd_pct : b.max_ihd_pct, String(b.critical_order != null ? b.critical_ihd_pct : b.max_ihd_pct)),
        ihdl: this._cell(b.ihd_limit_pct, String(b.ihd_limit_pct)), basis: this._cell(b.limit_basis || ''),
      },
      actions: ['props'] })), defaultSort: { col: 'thd', dir: -1 } });
    if ((r.vfd_sources || []).length) sections.push({ id: 'vfd', title: 'Harmonic sources (drives)', cols: [{ key: 'front', label: 'Front end' },
      { key: 'p', label: 'MW', num: true }, { key: 'thd', label: 'Current THD %', num: true }],
    rows: r.vfd_sources.map(v => ({ id: v.id, name: v.name || v.id, status: 'info',
      reasons: [`Ih / I1: ${Object.entries(v.spectrum || {}).map(([h, x]) => `h${h} ${(x * 100).toFixed(1)} %`).join(' · ')}`],
      cells: { front: this._cell(`${v.pulse_number}-pulse ${v.front_end}`), p: this._cell(v.p_mw, String(v.p_mw)), thd: this._cell(v.current_thd_pct, String(v.current_thd_pct)) },
      actions: ['props'] })) });
    return { summary: `${stdName} · worst THDV ${r.worst_thd_pct} % at ${r.worst_bus_name || '—'} · orders ${(r.orders || []).join(', ')}`,
      verdict: r.compliant ? 'ok' : 'fail', notes, sections,
      foot: `${r.method || ''}. ${std === 'iec' ? 'IEC 61000-3-6 planning levels are indicative network-operator targets; the LV basis is the IEC 61000-2-4 Class 2 compatibility level.' : 'IEEE 519 limits apply at the PCC; internal buses are screened against the same table.'} Sources of the same order are summed in phase (conservative). Transformer and line tap ratios and phase shifts are not applied at harmonic frequencies.` };
  },
  _harmLimits(v) {
    if ((AppState.harmonicsLimits || null) === v) return;
    AppState.harmonicsLimits = v;
    AppState.dirty = true;
    this.SETUP.harmonics();
  },

  // ── Studies shown with their own view (charts, cases) ──────────────────
  // A tab whose content is the study's own renderer, drawn into the panel.
  _view(key, summary, verdict, extra = {}) {
    const r = this.result(key);
    if (r == null) return null;
    const notes = [];
    if (r.converged === false) notes.push({ level: 'warn', text: `The study did not run${r.note ? `: ${r.note}` : '.'}` });
    return Object.assign({ summary, verdict: r.converged === false ? 'warn' : verdict, notes, outcome: extra.outcome,
      sections: [{ id: 'view', view: (el) => this._drawView(key, el, r) }] }, extra);
  },
  _drawView(key, el, r) {
    const meta = this._session[key] ? this._session[key].meta : {};
    const draw = this.VIEWS[key] || {
      dynMotor: (e, x) => { if (DynMotor._result !== x) { DynMotor._result = x; DynMotor._activeIdx = 0; } DynMotor._render(e); },
      stability: (e, x) => { Transient._result = x; Transient._render(e); },
      contingency: (e, x) => { Contingency._result = x; Contingency._render(e); },
      vstab: (e, x) => { VoltageStability._result = x; VoltageStability._render(e); },
      tsl: (e, x) => { TimeSeries._result = x; TimeSeries._render(e); },
      opf: (e, x) => { OPF._result = x; OPF._render(e); },
      hc: (e, x) => { HostingCapacity._result = x; HostingCapacity._render(e); },
      cpl: (e, x) => { CapPlacement._result = x; CapPlacement._render(e); },
      rel: (e, x) => { Reliability._result = x; Reliability._render(e); },
      fscan: (e, x) => { FrequencyScan._result = x; FrequencyScan._render(e); },
      flt: (e, x) => { FilterSizing._result = x; FilterSizing._render(e); },
      flk: (e, x) => { Flicker._result = x; Flicker._render(e); },
      bsz: (e, x) => { BatterySizing._result = x; BatterySizing._render(e); },
      sequence: (e, x, m) => {
        e.innerHTML = SOO._render(x, m || {});
        e.addEventListener('click', (ev) => { if (ev.target.id === 'soo-copy-btn') SOO._copyReport(); });
      },
    }[key];
    if (!draw) { el.innerHTML = '<p class="rp-empty">This study has no view here.</p>'; return; }
    try { draw(el, r, meta); } catch (e) { console.error('Results panel view:', key, e); el.innerHTML = '<p class="rp-empty">Could not draw this study’s results.</p>'; }
  },

  _m_dynMotor() { return this._view('dynMotor', 'Time-domain acceleration (swing equation)', null); },
  _m_stability() {
    const r = this.result('stability');
    return r && this._view('stability', 'Rotor-angle and frequency, time domain', r.stable === false ? 'fail' : 'ok',
      { outcome: r.stable === false ? '<b class="rp-fail">unstable</b>' : '<b class="rp-ok">stable</b>' });
  },
  _m_contingency() {
    const r = this.result('contingency');
    return r && this._view('contingency', `${r.mode || 'N-1'} screening · ${r.analyzed || 0} outages`, r.n_minus_1_secure ? 'ok' : 'fail',
      { outcome: r.n_minus_1_secure ? '<b class="rp-ok">N-1 secure</b>' : '<b class="rp-fail">N-1 insecure</b>' });
  },
  _m_vstab() { return this._view('vstab', 'P-V loadability and Q-V reactive margin', 'info'); },
  _m_tsl() {
    const r = this.result('tsl');
    const bad = r && ((r.violation_step_count || 0) > 0 || (r.non_converged_steps || []).length > 0);
    return r && this._view('tsl', `Quasi-dynamic load flow · ${r.horizon_hours ?? '—'} h in ${r.step_minutes ?? '—'} min steps`, bad ? 'warn' : 'ok',
      { outcome: bad ? `<b class="rp-warn">${r.violation_step_count || 0} step${r.violation_step_count === 1 ? '' : 's'} with a violation</b>` : '<b class="rp-ok">no violations</b>' });
  },
  _m_opf() { return this._view('opf', 'Merit-order dispatch and Volt/VAR', 'info'); },
  _m_hc() { return this._view('hc', 'Voltage- and thermal-limited DER injection per bus', 'info'); },
  _m_cpl() { return this._view('cpl', 'Greedy loss-sensitivity placement', 'info'); },
  _m_rel() { return this._view('rel', 'IEEE 1366 indices · analytical FMEA', 'info'); },
  _m_fscan() { return this._view('fscan', 'Driving-point impedance against frequency', 'info'); },
  _m_flt() {
    const r = this.result('flt');
    return r && this._view('flt', 'Single-tuned branches to IEEE 519', r.design && r.meets_ieee519 === false ? 'warn' : 'ok');
  },
  _m_flk() {
    const r = this.result('flk');
    return r && this._view('flk', 'IEC 61000-3-3 planning screen (Pst / Plt)', r.compliant === false ? 'fail' : 'ok');
  },
  _m_bsz() {
    const r = this.result('bsz');
    return r && this._view('bsz', 'Duty-cycle sizing and discharge', r.sized_ok === false ? 'fail' : 'ok',
      { outcome: r.sized_ok === false ? '<b class="rp-fail">undersized</b>' : '<b class="rp-ok">sized</b>' });
  },
  _m_sequence() {
    const r = this.result('sequence');
    if (!r) return null;
    const viol = (r.buses || []).reduce((n, b) => n + (b.violations || []).length, 0);
    return this._view('sequence', 'Protective devices in the order they operate', r.error ? 'info' : (viol ? 'fail' : 'ok'),
      { outcome: viol ? `<b class="rp-fail">${viol} coordination issue${viol === 1 ? '' : 's'}</b>` : '' });
  },
  _m_backup() {
    const r = this.result('backup');
    if (!r) return null;
    const bad = (r.islands || []).some(i => !i.backed_up || i.inverter_ok === false || i.power_ok_night === false);
    return this._view('backup', 'Grid outage: islands, inverters, energy', bad ? 'fail' : 'ok');
  },
  _m_openConductor() { return this._view('openConductor', 'One conductor open · sequence networks', 'info'); },
  _m_twoConductorOpen() { return this._view('twoConductorOpen', 'Two conductors open · sequence networks', 'info'); },
  _m_simultaneousFault() { return this._view('simultaneousFault', 'Series and shunt fault together', 'info'); },

  // Fail / warning counts of a model.
  counts(m) {
    const n = { fail: 0, warn: 0, rows: 0 };
    for (const s of (m && m.sections) || []) for (const r of s.rows || []) { n.rows++; if (r.status === 'fail') n.fail++; else if (r.status === 'warn') n.warn++; }
    return n;
  },

  // Rows of a section as shown: Needs attention, name filter, sort.
  view(tab, sec) {
    let rows = sec.rows;
    if (this.attention) rows = rows.filter(r => r.status === 'fail' || r.status === 'warn');
    const f = this.filter.trim().toLowerCase();
    if (f) rows = rows.filter(r => String(r.name).toLowerCase().includes(f) || String(r.id).toLowerCase().includes(f));
    const s = this.sort[`${tab}/${sec.id}`] || sec.defaultSort;
    if (s) {
      const rank = { fail: 0, warn: 1, ok: 2, info: 3 };
      const val = (r) => s.col === 'name' ? String(r.name) : s.col === 'status' ? rank[r.status] : r.cells[s.col]?.v;
      rows = [...rows].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;          // blanks last either way
        if (y == null) return -1;
        const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return c * s.dir;
      });
    }
    return rows;
  },
  sortBy(tab, secId, col) {
    const k = `${tab}/${secId}`;
    const cur = this.sort[k];
    this.sort[k] = cur && cur.col === col ? { col, dir: -cur.dir } : { col, dir: col === 'name' || col === 'status' ? 1 : -1 };   // worst / A first
  },

  // ── Opening / docking ─────────────────────────────────────────────────
  _phone() { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches; },

  // Open on a study (or the study on screen). On a phone the Results sheet
  // is the panel.
  open(key, opts = {}) {
    if (key && !this.TABS.includes(key)) key = null;
    if (this._phone()) {
      if (typeof MobileUI !== 'undefined' && MobileUI.renderResults) {
        if (key && this.has(key)) MobileUI._resultKey = key;
        MobileUI.renderResults(); MobileUI.openSheet?.('mobile-sheet-results');
      }
      return;
    }
    if (key) this.tab = key;
    if (opts.section) this._scrollTo = opts.section;
    const p = this._loadPrefs();
    if (!this._win) { p.open = true; this._savePrefs(); }
    if (key && typeof ResultView !== 'undefined' && ResultView.study(key) && !ResultView.isOn(key)) {
      this._quiet = true; ResultView.show(key); this._quiet = false;
    }
    this.render(true);
    if (this._win) { try { this._win.focus(); } catch (e) { /* closed */ } }
  },
  close() {
    this._redock();
    const p = this._loadPrefs();
    p.open = false; this._savePrefs();
    this.render(true);
  },
  toggle() { this.isOpen() ? this.close() : this.open(this.tab); },
  setDock(d) {
    const p = this._loadPrefs();
    p.dock = d; this._savePrefs();
    if (this._win) this._redock();
    this.render(true);
  },

  // The view switch changed: the tab follows the first study shown.
  follow(keys) {
    if (this._quiet) return;
    const k = (keys || []).find(x => this.TABS.includes(x) && this.has(x));
    if (k && k !== this.tab) { this.tab = k; this.openRow = null; this._selShown = null; this.render(true); }
  },

  // ── Pop-out ───────────────────────────────────────────────────────────
  popOut() {
    if (this._win) { this._win.focus(); return; }
    const w = window.open('', 'pp-results', 'width=1000,height=640');
    if (!w) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('The browser blocked the new window. Allow pop-ups for this site.', 'error'); return; }
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => `<link rel="stylesheet" href="${escHtml(l.href)}">`).join('');
    const dark = document.body.classList.contains('dark-mode') ? ' dark-mode' : '';
    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Results — ${escHtml(AppState.projectName || 'ProtectionPro')}</title>${links}</head>`
      + `<body class="rp-popped${dark}"><div id="results-panel" class="rp rp-pop"></div></body></html>`);
    w.document.close();
    this._win = w;
    // Closing the window puts the panel back in the app (polled: a closed
    // window does not always get to run its unload handlers).
    const back = () => { if (this._win === w) { this._win = null; clearInterval(this._winPoll); this.render(true); } };
    w.addEventListener('pagehide', () => setTimeout(back, 0));
    clearInterval(this._winPoll);
    this._winPoll = setInterval(() => { if (w.closed) back(); }, 500);
    this.render(true);
  },
  _redock() {
    if (!this._win) return;
    const w = this._win; this._win = null;
    clearInterval(this._winPoll);
    try { w.close(); } catch (e) { /* gone */ }
  },

  ICONS: {
    right: '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="11" fill="currentColor" opacity=".55"/></svg>',
    bottom: '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8" width="13" height="4.5" fill="currentColor" opacity=".55"/></svg>',
    pop: '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="3.5" width="10" height="9.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1h7v7M15 1L8.5 7.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  },

  // ── Rendering ─────────────────────────────────────────────────────────
  _host() {
    if (this._win) {
      const el = this._win.document.getElementById('results-panel');
      if (!el) return null;
      if (!el._rpBound) { this._bind(el); el._rpBound = true; }
      return el;
    }
    const container = document.getElementById('canvas-container');
    if (!container) return null;
    let el = document.getElementById('results-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'results-panel';
      el.className = 'rp';
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Study results');
      container.appendChild(el);
      this._bind(el);
      el._rpBound = true;
    }
    return el;
  },

  _layout(open) {
    const container = typeof document !== 'undefined' && document.getElementById('canvas-container');
    if (!container) return;
    const p = this._loadPrefs();
    const docked = open && !this._win;
    const d = this.dock();
    const maxW = Math.max(320, container.clientWidth * 0.7), maxH = Math.max(160, container.clientHeight * 0.7);
    const w = Math.min(Math.max(300, p.right), maxW), h = Math.min(Math.max(140, p.bottom), maxH);
    container.style.setProperty('--rp-right', docked && d === 'right' ? `${w}px` : '0px');
    container.style.setProperty('--rp-bottom', docked && d === 'bottom' ? `${h}px` : '0px');
    container.classList.toggle('rp-docked-right', docked && d === 'right');
    container.classList.toggle('rp-docked-bottom', docked && d === 'bottom');
  },

  _sig: '',
  _rid: new WeakMap(), _ridN: 0,
  _idOf(o) { if (!o || typeof o !== 'object') return 0; let i = this._rid.get(o); if (!i) { i = ++this._ridN; this._rid.set(o, i); } return i; },
  // Called after every diagram redraw: re-render only when what is shown
  // changed, and follow the selection.
  onCanvasRender() {
    if (!this.isOpen()) { if (this._wasOpen) this.render(true); return; }
    this.render(false);
    this.syncSelection();
  },

  render(force) {
    if (typeof document === 'undefined') return;
    const open = this.isOpen() && !this._phone();
    const avail = this.available();
    const showing = open && avail.length > 0;
    this._wasOpen = showing;
    const host = showing ? this._host() : document.getElementById('results-panel');
    if (this._win) { const dockEl = document.getElementById('results-panel'); if (dockEl) dockEl.hidden = true; }
    this._layout(showing);
    if (typeof ResultView !== 'undefined' && ResultView._el) {
      const b = ResultView._el.querySelector('[data-rv-table]');
      if (b) b.setAttribute('aria-pressed', String(this.isOpen()));
    }
    if (!showing) {
      if (host && !this._win) host.hidden = true;
      if (this._lastLayout !== 'none') { this._lastLayout = 'none'; this._redrawSoon(); }
      return;
    }
    if (!avail.includes(this.tab)) this.tab = (typeof ResultView !== 'undefined' && ResultView.current().find(k => avail.includes(k))) || avail[0];
    const tab = this.tab;
    const slots = this.SLOTS[tab] || [];
    const stale = this.isStale(tab);
    const focus = typeof CableFocus !== 'undefined' ? `${CableFocus.active}:${CableFocus.busId}` : '';
    const sig = [tab, avail.join(','), slots.map(s => this._idOf(AppState[s])).join(','), this._idOf(this._session[tab]), stale, this.attention, this.filter,
      JSON.stringify(this.sort), this.openRow, focus, this.dock(), !!this._win, AppState.dispatchUnits,
      typeof StaleResults !== 'undefined' && StaleResults._busy].join('|');
    const layoutKey = `${this.dock()}:${!!this._win}`;
    if (this._lastLayout !== layoutKey) { this._lastLayout = layoutKey; this._redrawSoon(); }
    if (!force && sig === this._sig && !host.hidden) return;
    this._sig = sig;
    host.hidden = false;
    host.classList.toggle('rp-right', !this._win && this.dock() === 'right');
    host.classList.toggle('rp-bottom', !this._win && this.dock() === 'bottom');

    const m = this.model(tab) || { summary: '', notes: [], sections: [] };
    const n = this.counts(m);
    const at = this.ranAt(tab);
    const when = at ? new Date(at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    const verdict = this.verdict(tab);
    const tables = m.sections.some(x => x.rows);

    const tabsHtml = avail.map(k => {
      const v = this.verdict(k);
      return `<button type="button" class="rp-tab" role="tab" data-rp-tab="${escHtml(k)}" aria-selected="${k === tab}"><span class="rv-dot rv-${v}" aria-hidden="true"></span>${escHtml(this.LABELS[k])}</button>`;
    }).join('');
    const outcome = m.outcome != null && !tables ? m.outcome : n.fail || n.warn
      ? `${n.fail ? `<b class="rp-fail">${n.fail} fail</b>` : '0 fail'} · ${n.warn ? `<b class="rp-warn">${n.warn} warning${n.warn === 1 ? '' : 's'}</b>` : '0 warnings'}`
      : (!tables ? ({ fail: '<b class="rp-fail">fails</b>', warn: '<b class="rp-warn">warnings</b>', ok: '<b class="rp-ok">all clear</b>' }[verdict] || '')
        : verdict === 'info' ? `${n.rows} row${n.rows === 1 ? '' : 's'}` : '<b class="rp-ok">all clear</b>');
    const busy = typeof StaleResults !== 'undefined' && StaleResults._busy;
    // The out-of-date chip re-runs studies with no setup; the rest run again
    // from their own setup.
    const auto = slots.length && typeof StaleResults !== 'undefined' && slots.every(s => AppState[s] == null || StaleResults.RUNNERS[s]);
    const staleHtml = !stale ? '' : `<div class="rp-stale" role="status"><span class="stale-chip-dot" aria-hidden="true"></span>Out of date after an edit — the numbers are from before it.`
      + (auto ? `<button type="button" class="rp-btn rp-primary" data-rp-rerun${busy ? ' disabled' : ''}>${busy ? 'Re-running…' : 'Re-run'}</button>`
        : this.SETUP[tab] ? '<button type="button" class="rp-btn rp-primary" data-rp-setup>Run again…</button>' : '') + '</div>';
    const icon = { fail: '✗', warn: '⚠', info: 'ⓘ' };
    const notesHtml = m.notes.length ? `<div class="rp-notes">${m.notes.map(x => `<div class="rp-note rp-note-${escHtml(x.level)}">${icon[x.level] || '⚠'} ${escHtml(x.text)}</div>`).join('')}</div>` : '';
    const attn = n.fail + n.warn;

    let body = '';
    if (m.empty) body = `<p class="rp-empty">${escHtml(m.empty)}</p>`;
    else for (const sec of m.sections) body += this._sectionHtml(tab, sec);
    if (!m.sections.length && !m.empty) body = '<p class="rp-empty">Nothing to show for this study.</p>';
    if (m.foot) body += `<p class="rp-foot">${escHtml(m.foot)}</p>`;

    host.innerHTML = `
      ${this._win ? '' : '<div class="rp-resize" data-rp-resize title="Drag to resize"></div>'}
      <div class="rp-head">
        <div class="rp-tabs" role="tablist" aria-label="Studies">${tabsHtml}</div>
        <div class="rp-head-tools">
          ${this.GUIDES[tab] && typeof HelpGuides !== 'undefined' ? `<button type="button" class="rp-icon" data-rp-guide title="Guide to this study">?</button>` : ''}
          ${this._win ? '<button type="button" class="rp-icon" data-rp-dockback title="Put the panel back in the app">⇲</button>' : `
          <button type="button" class="rp-icon" data-rp-dock="right" aria-pressed="${this.dock() === 'right'}" title="Dock on the right">${this.ICONS.right}</button>
          <button type="button" class="rp-icon" data-rp-dock="bottom" aria-pressed="${this.dock() === 'bottom'}" title="Dock at the bottom">${this.ICONS.bottom}</button>
          <button type="button" class="rp-icon" data-rp-pop title="Pop out into its own window (a second monitor)">${this.ICONS.pop}</button>`}
          <button type="button" class="rp-icon" data-rp-close title="Close the results panel">×</button>
        </div>
      </div>
      <div class="rp-sum">
        <span class="rp-how">${escHtml(m.summary)}${when ? ` · ran ${escHtml(when)}` : ''}</span>
        <span class="rp-outcome">${outcome}</span>
      </div>
      ${staleHtml}
      ${tables ? `<div class="rp-bar">
        <button type="button" class="rp-btn" data-rp-attn aria-pressed="${this.attention ? 'true' : 'false'}"${attn || this.attention ? '' : ' disabled'} title="Show only rows that fail or warn">Needs attention · ${attn}</button>
        <input type="search" class="rp-filter" data-rp-filter placeholder="Filter by name" value="${escHtml(this.filter)}" aria-label="Filter by name">
      </div>` : ''}
      <div class="rp-body${stale ? ' rp-is-stale' : ''}">${notesHtml}${body}</div>`;
    // Studies shown with their own view draw into their placeholder.
    for (const sec of m.sections) {
      if (!sec.view) continue;
      const el = host.querySelector(`[data-rp-view="${sec.id}"]`);
      if (el) sec.view(el);
    }
    if (typeof Header !== 'undefined' && Header.syncResultsMenu) Header.syncResultsMenu();
    if (this._focusFilter) {
      const f = host.querySelector('[data-rp-filter]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
      this._focusFilter = false;
    }
    if (this._scrollTo) {
      const s = host.querySelector(`[data-rp-sec="${this._scrollTo}"]`);
      if (s) s.scrollIntoView({ block: 'start' });
      this._scrollTo = null;
    }
    host.style.setProperty('--rp-w', `${host.clientWidth}px`);
    // With many studies the tabs scroll: keep the one on show in view.
    const on = host.querySelector('.rp-tab[aria-selected="true"]');
    const strip = on && on.parentElement;
    if (strip && (on.offsetLeft < strip.scrollLeft || on.offsetLeft + on.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = Math.max(0, on.offsetLeft - 8);
    }
    this.syncSelection();
  },

  // The diagram's size changed (panel docked / undocked): redraw it once.
  _redrawSoon() {
    if (typeof Canvas === 'undefined' || !Canvas.render) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => Canvas.render());
    else setTimeout(() => Canvas.render(), 0);
  },

  _sectionHtml(tab, sec) {
    const tools = (sec.tools || []).map(t => `<button type="button" class="rp-btn rp-small" data-rp-tool="${escHtml(sec.id)}:${escHtml(t.id)}" aria-pressed="${!!t.active}"${t.title ? ` title="${escHtml(t.title)}"` : ''}>${escHtml(t.label)}</button>`).join('');
    if (sec.view) return `<section class="rp-sec rp-sec-view" data-rp-sec="${escHtml(sec.id)}"><div class="rp-view" data-rp-view="${escHtml(sec.id)}"></div></section>`;
    if (!sec.rows) {
      return `<section class="rp-sec" data-rp-sec="${escHtml(sec.id)}"><div class="rp-sec-head"><span class="rp-sec-title">${escHtml(sec.title || '')}</span>${tools}</div>`
        + `<div class="rp-html">${sec.html || ''}</div></section>`;
    }
    const rows = this.view(tab, sec);
    const s = this.sort[`${tab}/${sec.id}`] || sec.defaultSort || {};
    const th = (key, label, num, title) => {
      const on = s.col === key;
      return `<th class="${num ? 'rp-num' : ''}" data-rp-sort="${escHtml(key)}" aria-sort="${escHtml(on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none')}"${title ? ` title="${escHtml(title)}"` : ''}>${escHtml(label)}${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    };
    const ncol = sec.cols.length + 2;
    let html = `<section class="rp-sec" data-rp-sec="${escHtml(sec.id)}">
      <div class="rp-sec-head"><span class="rp-sec-title">${escHtml(sec.title)}</span><span class="rp-sec-n">${rows.length === sec.rows.length ? rows.length : `${rows.length} of ${sec.rows.length}`}</span>
      ${tools}</div>`;
    if (!rows.length) return html + `<p class="rp-empty">${sec.rows.length ? 'No rows match.' : 'None.'}</p></section>`;
    html += `<div class="rp-scroll"><table class="rp-table"><thead><tr>${th('status', '', false, 'Status')}${th('name', 'Name')}${sec.cols.map(c => th(c.key, c.label, c.num, c.title)).join('')}</tr></thead><tbody>`;
    for (const r of rows) {
      const rk = `${sec.id}:${r.id}`;
      const open = this.openRow === rk;
      html += `<tr class="rp-row rp-st-${escHtml(r.status)}${open ? ' rp-open' : ''}" data-rp-row="${escHtml(rk)}" data-rp-id="${escHtml(r.id)}" tabindex="0" aria-expanded="${open}">`
        + `<td class="rp-stc"><span class="rv-dot rv-${escHtml(r.status)}" aria-label="${escHtml(r.status)}"></span></td><td class="rp-name">${escHtml(r.name)}</td>`
        + sec.cols.map(c => `<td class="${c.num ? 'rp-num' : ''}">${r.cells[c.key] ? r.cells[c.key].t : '—'}</td>`).join('') + '</tr>';
      if (open) {
        const acts = this._actions(tab, r);
        html += `<tr class="rp-detail"><td colspan="${ncol}"><div class="rp-detail-in">`
          + (r.reasons.length ? `<ul class="rp-reasons">${r.reasons.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`
            : r.detail ? '' : `<div class="rp-noreason">${r.status === 'info' ? 'Information only.' : 'Passes every check.'}</div>`)
          + (r.detail ? `<div class="rp-more">${r.detail}</div>` : '')
          + (acts.length ? `<div class="rp-acts">${acts.map(a => `<button type="button" class="rp-btn rp-small" data-rp-act="${escHtml(a.id)}" data-rp-for="${escHtml(r.id)}">${escHtml(a.label)}</button>`).join('')}</div>` : '')
          + '</div></td></tr>';
      }
    }
    return html + '</tbody></table></div></section>';
  },

  _actions(tab, r) {
    const comp = AppState.components.get(r.id);
    if (!comp) return [];
    const out = [];
    for (const a of r.actions || []) {
      if (a === 'props') out.push({ id: 'props', label: tab === 'cable' && r.status !== 'ok' ? 'Change the cable…' : 'Open its properties' });
      if (a === 'tcc' && ['cb', 'fuse', 'relay'].includes(comp.type) && typeof TCC !== 'undefined') out.push({ id: 'tcc', label: 'Open the TCC' });
      if (a === 'fault-here' && comp.type === 'bus') out.push({ id: 'fault-here', label: 'Fault at this bus only' });
      if (a === 'cable-focus' && typeof CableFocus !== 'undefined') out.push({ id: 'cable-focus', label: 'Only the cables at its buses' });
    }
    return out;
  },

  // A tab's content drawn into another element: the phone's Results sheet.
  renderInto(el, key) {
    const m = this.model(key) || { summary: '', notes: [], sections: [] };
    const icon = { fail: '✗', warn: '⚠', info: 'ⓘ' };
    let html = `<p class="mres-note">${escHtml(m.summary || '')}</p>`;
    if (this.isStale(key)) html += '<div class="rp-stale" role="status"><span class="stale-chip-dot" aria-hidden="true"></span>Out of date after an edit — run it again.</div>';
    html += m.notes.map(x => `<div class="rp-note rp-note-${escHtml(x.level)}">${icon[x.level] || '⚠'} ${escHtml(x.text)}</div>`).join('');
    if (m.empty) html += `<p class="rp-empty">${escHtml(m.empty)}</p>`;
    else for (const sec of m.sections) html += this._sectionHtml(key, sec);
    if (m.foot) html += `<p class="rp-foot">${escHtml(m.foot)}</p>`;
    el.innerHTML = `<div class="rp rp-sheet">${html}</div>`;
    el.style.setProperty('--rp-w', `${el.clientWidth || 340}px`);
    for (const sec of m.sections) {
      const v = sec.view && el.querySelector(`[data-rp-view="${sec.id}"]`);
      if (v) sec.view(v);
    }
  },
  // A click in the sheet: sort, open a row, a section tool or a row's action.
  // True when the sheet should be drawn again.
  onSheetClick(e, key) {
    const q = (sel) => e.target.closest && e.target.closest(sel);
    let b;
    if ((b = q('[data-rp-act]'))) {
      if (b.dataset.rpAct === 'props' && typeof MobileUI !== 'undefined') MobileUI.locate(b.dataset.rpFor);
      else this._act(b.dataset.rpAct, b.dataset.rpFor);
      return false;
    }
    if ((b = q('[data-rp-sort]'))) { this.sortBy(key, b.closest('[data-rp-sec]').dataset.rpSec, b.dataset.rpSort); return true; }
    if ((b = q('[data-rp-tool]'))) {
      const [sec, id] = b.dataset.rpTool.split(':');
      const tool = this.model(key)?.sections.find(x => x.id === sec)?.tools?.find(x => x.id === id);
      if (tool) tool.run();
      return true;
    }
    if ((b = q('[data-rp-row]'))) { this.openRow = this.openRow === b.dataset.rpRow ? null : b.dataset.rpRow; return true; }
    return false;
  },

  // ── Events ────────────────────────────────────────────────────────────
  _bind(el) {
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('[data-rp-row]');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this._pickRow(row.dataset.rpRow, row.dataset.rpId); }
    });
    el.addEventListener('input', (e) => {
      if (e.target.matches('[data-rp-filter]')) { this.filter = e.target.value; this._focusFilter = true; this.render(true); }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-rp-resize]')) this._startResize(e);
    });
  },
  _onClick(e) {
    const t = e.target;
    const q = (sel) => t.closest && t.closest(sel);
    let b;
    if ((b = q('[data-rp-tab]'))) {
      this.tab = b.dataset.rpTab; this.openRow = null; this._selShown = null;
      if (typeof ResultView !== 'undefined' && ResultView.study(this.tab)) { this._quiet = true; ResultView.show(this.tab); this._quiet = false; }
      this.render(true); return;
    }
    if (q('[data-rp-close]')) { this.close(); return; }
    if (q('[data-rp-pop]')) { this.popOut(); return; }
    if (q('[data-rp-dockback]')) { this._redock(); const p = this._loadPrefs(); p.open = true; this._savePrefs(); this.render(true); return; }
    if ((b = q('[data-rp-dock]'))) { this.setDock(b.dataset.rpDock); return; }
    if (q('[data-rp-guide]')) { HelpGuides.open(this.GUIDES[this.tab]); return; }
    if (q('[data-rp-rerun]')) { if (typeof StaleResults !== 'undefined') StaleResults.rerun(); return; }
    if (q('[data-rp-setup]')) { if (this._win) window.focus(); this.SETUP[this.tab]?.(); return; }
    if (q('[data-rp-attn]')) { this.attention = !this.attention; this.render(true); return; }
    if ((b = q('[data-rp-sort]'))) {
      const sec = b.closest('[data-rp-sec]').dataset.rpSec;
      this.sortBy(this.tab, sec, b.dataset.rpSort); this.render(true); return;
    }
    if ((b = q('[data-rp-tool]'))) {
      const [sec, id] = b.dataset.rpTool.split(':');
      const m = this.model(this.tab);
      const tool = m && m.sections.find(s => s.id === sec)?.tools?.find(x => x.id === id);
      if (tool) tool.run();
      this.render(true); return;
    }
    if ((b = q('[data-rp-act]'))) { this._act(b.dataset.rpAct, b.dataset.rpFor); return; }
    if ((b = q('[data-rp-row]'))) { this._pickRow(b.dataset.rpRow, b.dataset.rpId); }
  },

  // A row was clicked: open / close it and select its part on the diagram.
  _pickRow(rk, id) {
    this.openRow = this.openRow === rk ? null : rk;
    this._selecting = id;
    this.selectPart(id);
    this._selecting = null;
    this.render(true);
    this._selShown = AppState.components.has(id) ? id : this._selShown;
  },
  selectPart(id) {
    const comp = AppState.components.get(id);
    if (!comp) return false;
    const page = comp.pageId || 'page_1';
    if (page !== AppState.activePageId) {
      AppState.activePageId = page;
      if (typeof window.renderPageTabs === 'function') window.renderPageTabs();
    }
    AppState.selectedIds = new Set([id]);
    this._selShown = id;
    if (typeof Canvas !== 'undefined') { Canvas.render(); Canvas.centerOnComponent?.(id, { onlyIfOffscreen: true }); }
    if (typeof Properties !== 'undefined' && Properties.show) Properties.show(id);
    return true;
  },
  _act(a, id) {
    if (a === 'props') {
      this.selectPart(id);
      if (this._win) window.focus();
      document.getElementById('properties-panel')?.scrollIntoView?.({ block: 'nearest' });
    } else if (a === 'tcc') TCC.openForDevice(id);
    else if (a === 'fault-here') window.AppActions?.runFaultAtBus?.(id);
    else if (a === 'cable-focus') {
      const r = AppState.cableSizingResults;
      const c = r && (r.cables || []).find(x => x.cable_id === id);
      const ends = c && CableFocus.cableEnds ? CableFocus.cableEnds(c) : {};
      const bus = ends.fromId || ends.toId;
      if (bus) CableFocus.enable(bus);
    }
  },

  // The part selected on the diagram → its row picked and opened.
  _selShown: null,
  syncSelection() {
    if (!this.isOpen() || this._selecting) return;
    const sel = AppState.selectedIds && AppState.selectedIds.size === 1 ? [...AppState.selectedIds][0] : null;
    if (sel === this._selShown) return;
    this._selShown = sel;
    const host = this._win ? this._win.document.getElementById('results-panel') : document.getElementById('results-panel');
    if (!host || !sel) return;
    const row = [...host.querySelectorAll('[data-rp-id]')].find(r => r.dataset.rpId === sel);
    if (!row) return;
    const rk = row.dataset.rpRow;
    if (this.openRow !== rk) {
      this.openRow = rk;
      this.render(true);
      this._selShown = sel;
    }
    const again = [...host.querySelectorAll('[data-rp-id]')].find(r => r.dataset.rpId === sel);
    if (again) again.scrollIntoView({ block: 'nearest' });
  },

  // Drag the inner edge to resize the dock.
  _startResize(e) {
    e.preventDefault();
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    const d = this.dock();
    const p = this._loadPrefs();
    const move = (ev) => {
      if (d === 'right') p.right = Math.round(rect.right - ev.clientX);
      else p.bottom = Math.round(rect.bottom - 56 - ev.clientY);
      this._layout(true);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this._savePrefs();
      if (typeof Canvas !== 'undefined') Canvas.render();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  },
};

if (typeof window !== 'undefined') window.ResultsPanel = ResultsPanel;
