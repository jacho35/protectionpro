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
  TABS: ['loadflow', 'fault', 'arcflash', 'cable', 'duty'],
  LABELS: { loadflow: 'Load flow', fault: 'Short circuit', arcflash: 'Arc flash', cable: 'Cable sizing', duty: 'Duty check' },
  SLOTS: { loadflow: ['loadFlowResults'], fault: ['faultResults'], arcflash: ['arcFlashResults', 'dcArcFlashResults'],
    cable: ['cableSizingResults'], duty: ['dutyCheckResults'] },
  GUIDES: { loadflow: 'study-loadflow', fault: 'study-fault', arcflash: 'study-arcflash', cable: 'study-cable', duty: 'study-duty' },

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

  has(key) { return (this.SLOTS[key] || []).some(s => AppState[s] != null); },
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

  // Fail / warning counts of a model.
  counts(m) {
    const n = { fail: 0, warn: 0, rows: 0 };
    for (const s of (m && m.sections) || []) for (const r of s.rows) { n.rows++; if (r.status === 'fail') n.fail++; else if (r.status === 'warn') n.warn++; }
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
        const slot = key ? this.SLOTS[key].find(s => AppState[s] != null) : null;
        if (slot) MobileUI._resultSlot = slot;
        MobileUI.renderResults(); MobileUI.openSheet?.('mobile-sheet-results');
      }
      return;
    }
    if (key) this.tab = key;
    if (opts.section) this._scrollTo = opts.section;
    const p = this._loadPrefs();
    if (!this._win) { p.open = true; this._savePrefs(); }
    if (key && typeof ResultView !== 'undefined' && !ResultView.isOn(key)) {
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
    const slots = this.SLOTS[tab];
    const stale = typeof StaleResults !== 'undefined' && slots.some(s => AppState[s] != null && StaleResults.isStale(s));
    const focus = typeof CableFocus !== 'undefined' ? `${CableFocus.active}:${CableFocus.busId}` : '';
    const sig = [tab, avail.join(','), slots.map(s => this._idOf(AppState[s])).join(','), stale, this.attention, this.filter,
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
    const meta = AppState.resultsMeta && AppState.resultsMeta[slots.find(s => AppState[s] != null)];
    const when = meta && meta.at ? new Date(meta.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    const verdict = typeof ResultView !== 'undefined' ? ResultView.verdict(tab) : 'info';

    const tabsHtml = avail.map(k => {
      const v = typeof ResultView !== 'undefined' ? ResultView.verdict(k) : 'info';
      return `<button type="button" class="rp-tab" role="tab" data-rp-tab="${escHtml(k)}" aria-selected="${k === tab}"><span class="rv-dot rv-${v}" aria-hidden="true"></span>${escHtml(this.LABELS[k])}</button>`;
    }).join('');
    const outcome = n.fail || n.warn
      ? `${n.fail ? `<b class="rp-fail">${n.fail} fail</b>` : '0 fail'} · ${n.warn ? `<b class="rp-warn">${n.warn} warning${n.warn === 1 ? '' : 's'}</b>` : '0 warnings'}`
      : (verdict === 'info' ? `${n.rows} row${n.rows === 1 ? '' : 's'}` : '<b class="rp-ok">all clear</b>');
    const busy = typeof StaleResults !== 'undefined' && StaleResults._busy;
    const staleHtml = stale ? `<div class="rp-stale" role="status"><span class="stale-chip-dot" aria-hidden="true"></span>Out of date after an edit — the numbers are from before it.`
      + `<button type="button" class="rp-btn rp-primary" data-rp-rerun${busy ? ' disabled' : ''}>${busy ? 'Re-running…' : 'Re-run'}</button></div>` : '';
    const notesHtml = m.notes.length ? `<div class="rp-notes">${m.notes.map(x => `<div class="rp-note rp-note-${escHtml(x.level)}">${x.level === 'fail' ? '✗' : '⚠'} ${escHtml(x.text)}</div>`).join('')}</div>` : '';
    const attn = n.fail + n.warn;

    let body = '';
    for (const sec of m.sections) body += this._sectionHtml(tab, sec);
    if (!m.sections.length) body = '<p class="rp-empty">Nothing to show for this study.</p>';

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
      <div class="rp-bar">
        <button type="button" class="rp-btn" data-rp-attn aria-pressed="${this.attention ? 'true' : 'false'}"${attn || this.attention ? '' : ' disabled'} title="Show only rows that fail or warn">Needs attention · ${attn}</button>
        <input type="search" class="rp-filter" data-rp-filter placeholder="Filter by name" value="${escHtml(this.filter)}" aria-label="Filter by name">
      </div>
      <div class="rp-body${stale ? ' rp-is-stale' : ''}">${notesHtml}${body}</div>`;
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
    this.syncSelection();
  },

  // The diagram's size changed (panel docked / undocked): redraw it once.
  _redrawSoon() {
    if (typeof Canvas === 'undefined' || !Canvas.render) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => Canvas.render());
    else setTimeout(() => Canvas.render(), 0);
  },

  _sectionHtml(tab, sec) {
    const rows = this.view(tab, sec);
    const s = this.sort[`${tab}/${sec.id}`] || sec.defaultSort || {};
    const th = (key, label, num, title) => {
      const on = s.col === key;
      return `<th class="${num ? 'rp-num' : ''}" data-rp-sort="${escHtml(key)}" aria-sort="${escHtml(on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none')}"${title ? ` title="${escHtml(title)}"` : ''}>${escHtml(label)}${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    };
    const ncol = sec.cols.length + 2;
    let html = `<section class="rp-sec" data-rp-sec="${escHtml(sec.id)}">
      <div class="rp-sec-head"><span class="rp-sec-title">${escHtml(sec.title)}</span><span class="rp-sec-n">${rows.length === sec.rows.length ? rows.length : `${rows.length} of ${sec.rows.length}`}</span>
      ${(sec.tools || []).map(t => `<button type="button" class="rp-btn rp-small" data-rp-tool="${escHtml(sec.id)}:${escHtml(t.id)}" aria-pressed="${!!t.active}"${t.title ? ` title="${escHtml(t.title)}"` : ''}>${escHtml(t.label)}</button>`).join('')}</div>`;
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
          + (r.reasons.length ? `<ul class="rp-reasons">${r.reasons.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : `<div class="rp-noreason">${r.status === 'info' ? 'Information only.' : 'Passes every check.'}</div>`)
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
      if (typeof ResultView !== 'undefined') { this._quiet = true; ResultView.show(this.tab); this._quiet = false; }
      this.render(true); return;
    }
    if (q('[data-rp-close]')) { this.close(); return; }
    if (q('[data-rp-pop]')) { this.popOut(); return; }
    if (q('[data-rp-dockback]')) { this._redock(); const p = this._loadPrefs(); p.open = true; this._savePrefs(); this.render(true); return; }
    if ((b = q('[data-rp-dock]'))) { this.setDock(b.dataset.rpDock); return; }
    if (q('[data-rp-guide]')) { HelpGuides.open(this.GUIDES[this.tab]); return; }
    if (q('[data-rp-rerun]')) { if (typeof StaleResults !== 'undefined') StaleResults.rerun(); return; }
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
