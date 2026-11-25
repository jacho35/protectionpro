/* ProtectionPro — Solar PV design (phases 1-2 of docs/SOLAR_DESIGN_PLAN.md).
 *
 * One modal: Roof & size (location, roof from the plan, a dialog or a typed area, sizing from the roof
 * and / or the annual load, monthly yield), Strings (modules per string; the PV array goes on the SLD and
 * the app's EXISTING IEC 62548 string checks are shown), Rows (flat-roof row spacing), Protection (string
 * fuse, DC isolator, DC cable — the only electrical sizing done here, nothing else in the app does it),
 * Shading & studies (an obstruction, the bus to connect to, and buttons that run the app's own Fault
 * Analysis, Load Flow, Hosting Capacity and Compliance on the placed PV array; an optional hybrid battery
 * that the existing Battery Sizing, Backup Autonomy and Time-series studies work on) and the project Library.
 * The PV array is a normal Solar PV component in array mode, so every existing engine sees it: fault
 * contribution, load flow, hosting capacity, cable sizing. Nothing electrical is recalculated here.
 *
 * Modules and inverters come from PV_PANELS / PV_INVERTERS (constants.js). Every number comes from the
 * backend (/analysis/solar-size, solar-row-spacing, solar-protection); this file only gathers inputs,
 * works out the roof area from the dialog (`roofArea`, pure) and draws results.
 * The inputs are kept with the project in planMarkup.settings.solar.
 */
const Solar = {
  _tab: 'size',
  _locs: null,
  _res: null,
  _str: null,
  _rows: null,
  _prot: null,
  _busy: false,
  DEFAULTS: {
    location: 'Pretoria', lat: '', lon: '', irrSrc: 'pvgis', module: 'pv_550_mono', inverter: 'inv_10k_2mppt',
    roofShape: 'gable', length: 10, width: 9.2, pitch: 25, setback: 0.5, area: 60, packing: 0.8,
    tilt: 15, azimuth: 0, mode: 'kwp', targetKwp: 10, annualKwh: '', sharePct: 70,
    perString: 8, hour: 0, cableM: 30, vdPct: 1, acV: 400, exportKw: '', busId: '', pvId: '',
    hybrid: false, battKwh: 20, battKw: 10, battDod: 90,
    obsH: 0, obsD: 6, obsB: 0, obsW: 8,
  },

  cfg() {
    const pm = AppState.planMarkup;
    const store = pm && pm.settings ? (pm.settings.solar = pm.settings.solar || {}) : (this._mem = this._mem || {});
    const o = Object.assign({}, this.DEFAULTS, store);
    if (o.mode === 'min' || o.mode === 'load') {         // projects sized by the load: the array size is now a kWp target set in the design
      o.mode = 'kwp';
      if (!(+store.targetKwp > 0)) o.targetKwp = this._res && this._res.kwp > 0 ? +this._res.kwp : this.DEFAULTS.targetKwp;
    }
    return o;
  },
  set(key, value) {
    const pm = AppState.planMarkup;
    const store = pm && pm.settings ? (pm.settings.solar = pm.settings.solar || {}) : (this._mem = this._mem || {});
    store[key] = value;
    AppState.dirty = true;
    if (['mode', 'targetKwp', 'module'].includes(key) && typeof PlanSolarArray !== 'undefined') { PlanSolarArray._redraw(); PlanSolarArray._queue(); }   // the placed arrays follow the design
  },

  // Library = the shipped lists (constants.js) + the entries added here, kept with the project (settings.solar).
  customPanels() { return Array.isArray(this.cfg().customPanels) ? this.cfg().customPanels : []; },
  customInverters() { return Array.isArray(this.cfg().customInverters) ? this.cfg().customInverters : []; },
  panels() { return PV_PANELS.concat(this.customPanels()); },
  inverters() { return PV_INVERTERS.concat(this.customInverters()); },
  panel(c) { const l = this.panels(); return l.find(p => p.id === c.module) || l[0]; },
  inverter(c) { const l = this.inverters(); return l.find(i => i.id === c.inverter) || l[0]; },

  PANEL_FIELDS: [['name', 'Name', 'text'], ['w', 'Pmax (W)'], ['voc', 'Voc (V)'], ['vmp', 'Vmp (V)'], ['isc', 'Isc (A)'], ['imp', 'Imp (A)'],
    ['beta_voc', 'Voc coeff (%/°C)'], ['gamma_vmp', 'Vmp coeff (%/°C)'], ['k_pmax', 'Power coeff (%/°C)'], ['len', 'Length (m)'], ['wid', 'Width (m)'], ['noct', 'NOCT (°C)'], ['sysv', 'Max system V']],
  INVERTER_FIELDS: [['name', 'Name', 'text'], ['ac_kw', 'AC power (kW)'], ['phases', 'Phases'], ['dc_max_v', 'Max DC V'], ['mppt_min_v', 'MPPT min V'], ['mppt_max_v', 'MPPT max V'],
    ['mppt_count', 'MPPT inputs'], ['mppt_max_a', 'Max A per MPPT'], ['eff_pct', 'Efficiency (%)'], ['fault_x', 'Fault current (× rated)']],

  // Returns '' when the entry is sound, else what is wrong. Pure.
  validatePanel(p) {
    if (!p.name) return 'Give the module a name.';
    for (const k of ['w', 'voc', 'vmp', 'isc', 'imp', 'len', 'wid', 'noct', 'sysv']) if (!(p[k] > 0)) return `${k} must be a positive number.`;
    if (p.vmp >= p.voc) return 'Vmp must be below Voc.';
    if (p.imp > p.isc) return 'Imp cannot be above Isc.';
    if (p.beta_voc > 0 || p.gamma_vmp > 0 || p.k_pmax > 0) return 'Temperature coefficients are negative (the module loses voltage and power when hot).';
    return '';
  },
  validateInverter(i) {
    if (!i.name) return 'Give the inverter a name.';
    for (const k of ['ac_kw', 'dc_max_v', 'mppt_min_v', 'mppt_max_v', 'mppt_count', 'mppt_max_a', 'eff_pct']) if (!(i[k] > 0)) return `${k} must be a positive number.`;
    if (!(i.mppt_min_v < i.mppt_max_v && i.mppt_max_v <= i.dc_max_v)) return 'Need MPPT min < MPPT max <= max DC voltage.';
    if (i.eff_pct > 100) return 'Efficiency cannot be above 100 %.';
    if (![1, 3].includes(i.phases)) return 'Phases must be 1 or 3.';
    if (!(i.fault_x > 0)) return 'Fault current multiple must be positive.';
    return '';
  },

  // The module as the engine wants it (values come from the library entry; nothing is hard-coded here).
  moduleBody(p) {
    return { pmax_w: p.w, voc_v: p.voc, vmp_v: p.vmp, isc_a: p.isc, imp_a: p.imp, k_voc_pct: p.beta_voc,
      k_vmp_pct: p.gamma_vmp, k_pmax_pct: p.k_pmax, length_m: p.len, width_m: p.wid, noct_c: p.noct,
      max_system_v: p.sysv };
  },
  inverterBody(i) {
    return { ac_kw: i.ac_kw, phases: i.phases, max_dc_v: i.dc_max_v, mppt_min_v: i.mppt_min_v,
      mppt_max_v: i.mppt_max_v, mppt_count: i.mppt_count, max_a_per_mppt: i.mppt_max_a,
      max_isc_a_per_mppt: i.mppt_max_a * 1.25, efficiency_pct: i.eff_pct, fault_x_rated: i.fault_x };
  },

  // Roof geometry from the dialog. Pure: returns the tilt, the footprint area the modules may use (m2)
  // and whether the area is a tilted plane (gable / typed) or a flat roof that needs row spacing.
  roofArea(c) {
    const s = Math.max(0, +c.setback || 0);
    if (c.roofShape === 'plan') {
      const n = PlanSolar.roofs().filter(r => r.use !== false).length;
      return { tilt: 0, azimuth: 0, area: 0, flat: false, plan: true, note: n + ' roof' + (n === 1 ? '' : 's') + ' in use from the plan' };
    }
    if (c.roofShape === 'gable') {
      const slope = (c.width / 2) / Math.cos(c.pitch * Math.PI / 180);
      const area = Math.max(0, (c.length - 2 * s) * (slope - 2 * s));
      return { tilt: +c.pitch, azimuth: 0, area, flat: false, note: 'North plane only: ' + area.toFixed(1) + ' m² after setback' };
    }
    if (c.roofShape === 'flat') {
      const area = Math.max(0, (c.length - 2 * s) * (c.width - 2 * s));
      return { tilt: +c.tilt, azimuth: +c.azimuth, area, flat: true, note: 'Flat roof ' + area.toFixed(1) + ' m² after setback, racks at ' + c.tilt + '°' };
    }
    return { tilt: +c.tilt, azimuth: +c.azimuth, area: +c.area, flat: false, note: 'Typed usable area' };
  },

  async _locations() {
    if (this._locs) return this._locs;
    const lib = await API.request('/analysis/solar-library');
    this._locs = lib.locations;
    return this._locs;
  },

  // ── Modal ──────────────────────────────────────────────────────────
  async open() {
    try { await this._locations(); } catch (e) {
      document.getElementById('status-info').textContent = 'Solar: ' + (e.message || e);
      return;
    }
    document.getElementById('solar-modal').style.display = '';
    this.render();
  },
  close() { document.getElementById('solar-modal').style.display = 'none'; },

  _opt(list, sel, val, label) {
    return list.map(o => `<option value="${escHtml(val(o))}"${val(o) === sel ? ' selected' : ''}>${escHtml(label(o))}</option>`).join('');
  },
  _in(c, key, label, extra = '') {
    return `<label for="sol-${key}">${label}</label><input id="sol-${key}" data-k="${key}" type="number" step="any" style="max-width:140px" value="${escHtml(c[key])}" ${extra}>`;
  },

  render() {
    const m = document.getElementById('solar-modal');
    if (m && m.style.display !== 'none') this._renderModal();
    this._renderDock();
  },
  _renderModal() {
    const c = this.cfg();
    const tabs = [['size', '1 Roof & size'], ['strings', '2 Strings'], ['rows', '3 Rows (flat roof)'], ['protect', '4 Protection'], ['grid', '5 Shading & studies'], ['library', 'Library']];
    const bar = tabs.map(([k, l]) => `<button type="button" class="btn${this._tab === k ? ' btn-primary' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join(' ');
    const body = { size: () => this._sizeHtml(c), strings: () => this._stringsHtml(c), rows: () => this._rowsHtml(c), protect: () => this._protectHtml(c), grid: () => this._gridHtml(c), library: () => this._libraryHtml() }[this._tab]();
    const el = document.getElementById('solar-body');
    el.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">${bar}</div>${body}`;
    this._bind(el);
  },
  // The field / button handlers of a rendered Solar PV Design body (the dialog's or the dock's).
  _bind(el) {
    el.querySelectorAll('[data-k]').forEach(i => i.addEventListener('change', () => {
      const v = i.type === 'checkbox' ? i.checked : i.type === 'number' ? parseFloat(i.value) : i.value;
      this.set(i.dataset.k, v);
      if (['roofShape', 'mode', 'hybrid'].includes(i.dataset.k)) this.render();
    }));
    el.querySelectorAll('[data-roof]').forEach(i => i.addEventListener('change', () => {
      const k = i.dataset.rk;
      PlanSolar.update(i.dataset.roof, { [k]: k === 'use' ? i.checked : k === 'shape' ? i.value : parseFloat(i.value) });
      this.render();
    }));
    el.querySelectorAll('[data-north]').forEach(i => i.addEventListener('change', () => { PlanSolar.setNorthAngle(parseFloat(i.value)); this.render(); }));
    el.querySelectorAll('[data-solimport]').forEach(i => i.addEventListener('change', () => this._importFiles(i.files)));
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this._act(b.dataset.act, b.dataset.v)));
  },

  // ── Design parameters: the same steps docked on the left of the Plan's Solar mode, so the plan stays in view ──
  _dockEl: null, _dockOpen: true, _dtab: 'size',
  async mountDock(host) {
    this._dockEl = host;
    try { await this._locations(); } catch (e) { host.textContent = 'Solar: ' + (e.message || e); return; }
    this._renderDock();
  },
  _renderDock() {
    const el = this._dockEl;
    if (!el || !el.isConnected || !this._locs) return;
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.mode !== 'solar') return;
    const c = this.cfg(), open = this._dockOpen !== false;
    const head = `<span class="sd-glab">Design</span><button type="button" class="sd-btn${open ? ' open' : ''}" data-act="dock" aria-expanded="${open}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7 H20 M4 12 H20 M4 17 H20 M9 5 V9 M15 10 V14 M8 15 V19"/></svg><span class="sd-grow">Design parameters</span><span aria-hidden="true">${open ? '‹' : '›'}</span></button>`;
    let body = '<div class="sd-note">Module, inverter, location, kWp target and strings.</div>';
    if (open) {
      const tabs = [['size', '1 Size'], ['strings', '2 Strings'], ['protect', '3 Protection'], ['results', '4 Results']];
      const tab = tabs.some(t => t[0] === this._dtab) ? this._dtab : 'size';
      const bar = `<div class="sd-tabs" role="tablist" aria-label="Design steps">${tabs.map(([k, l]) => `<button type="button" role="tab" class="sd-tab${tab === k ? ' on' : ''}" aria-selected="${tab === k}" data-act="dtab" data-v="${k}">${l}</button>`).join('')}</div>`;
      const inner = { size: () => this._sizeHtml(c, true), strings: () => this._stringsHtml(c), protect: () => this._protectHtml(c),
        results: () => this._sizeResult() || '<div class="sd-note">Press Calculate on the Size step.</div>' }[tab]();
      body = bar + `<div class="sd-body">${inner}<button type="button" class="sd-more" data-act="more">Rows, shading and library…</button></div>`;
    }
    el.innerHTML = `<nav class="sd-nav" aria-label="Solar design">${head}${body}</nav>`.replace(/id="sol-/g, 'id="sd-').replace(/for="sol-/g, 'for="sd-');
    this._bind(el);
  },

  _grid(inner) {
    return `<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">${inner}</div>`;
  },

  _sizeHtml(c, dock) {
    const loc = this._opt(this._locs, c.location, o => o.name, o => o.name);
    const mod = this._opt(this.panels(), c.module, o => o.id, o => o.name);
    const inv = this._opt(this.inverters(), c.inverter, o => o.id, o => o.name);
    const shape = [['plan', 'Roofs drawn on the plan'], ['gable', 'Gable (north plane)'], ['flat', 'Flat with tilted racks'], ['area', 'Type a usable area']];
    const modes = [['kwp', 'A kWp target I set'], ['roof', 'Fill the roof']];
    const geo = c.roofShape === 'plan' ? (dock ? '' : this._roofsNote())
      : c.roofShape === 'area'
      ? this._in(c, 'area', 'Usable area (m²)') + this._in(c, 'packing', 'Packing factor') + this._in(c, 'tilt', 'Tilt (°)') + this._in(c, 'azimuth', 'Azimuth (° from north)')
      : this._in(c, 'length', 'Length (m)') + this._in(c, 'width', 'Width (m)')
        + (c.roofShape === 'gable' ? this._in(c, 'pitch', 'Pitch (°)') : this._in(c, 'tilt', 'Rack tilt (°)') + this._in(c, 'azimuth', 'Azimuth (° from north)'))
        + this._in(c, 'setback', 'Edge setback (m)');
    return this._grid(`
      <label for="sol-location">Location</label><select id="sol-location" data-k="location">${loc}</select>
      <label for="sol-lat">Site latitude (°, blank = the city)</label><input id="sol-lat" data-k="lat" type="text" inputmode="decimal" style="max-width:140px" value="${escHtml(c.lat)}" placeholder="e.g. -33.92">
      <label for="sol-lon">Site longitude (°)</label><input id="sol-lon" data-k="lon" type="text" inputmode="decimal" style="max-width:140px" value="${escHtml(c.lon)}" placeholder="e.g. 18.42">
      <label for="sol-irrSrc">Irradiance data</label><select id="sol-irrSrc" data-k="irrSrc">${this._opt([['pvgis', 'PVGIS typical year (hourly)'], ['table', 'Bundled monthly table (screening)']], c.irrSrc, o => o[0], o => o[1])}</select>
      <label for="sol-module">Module</label><select id="sol-module" data-k="module">${mod}</select>
      <label for="sol-inverter">Inverter</label><select id="sol-inverter" data-k="inverter">${inv}</select>
      <label for="sol-roofShape">Roof</label><select id="sol-roofShape" data-k="roofShape">${this._opt(shape, c.roofShape, o => o[0], o => o[1])}</select>
      ${geo}
      <label for="sol-mode">Array size</label><select id="sol-mode" data-k="mode">${this._opt(modes, c.mode, o => o[0], o => o[1])}</select>
      ${c.mode === 'kwp' ? this._in(c, 'targetKwp', 'Target array size (kWp)') : ''}
      ${this._in(c, 'annualKwh', 'Annual consumption (kWh, optional)')}`)
      + `<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn btn-primary" type="button" data-act="run">Calculate</button>
         ${c.roofShape === 'plan' && !dock ? '<button class="btn" type="button" data-act="view3d">Edit roofs in 3D</button>' : ''}
         <span style="font-size:12px;color:var(--text-muted,#6d6d6d)">${escHtml(this.roofArea(c).note)}</span></div>`
      + (dock ? this._placedLine(c) : '')
      + `<div style="margin-top:6px;font-size:11px;color:var(--text-muted,#6d6d6d)">The size is the kWp you set, limited by what the roof holds. Consumption does not size the array; it only gives the share of the load the yield covers. Roofs with an array placed on the plan keep the panels as laid out there.</div>`
      + (dock ? '' : this._sizeResult());
  },
  // "Placed on the plan: N panels · X kWp" (Design parameters).
  _placedLine(c) {
    if (c.roofShape !== 'plan' || typeof PlanSolarArray === 'undefined') return '';
    const t = PlanSolarArray.totals();
    return `<div style="margin-top:10px;display:flex;justify-content:space-between;font-size:13px"><span style="color:var(--text-muted,#6d6d6d)">Placed on the plan</span><strong>${t.n ? t.n + ' panels · ' + t.kwp.toFixed(1) + ' kWp' : 'nothing yet'}</strong></div>`;
  },

  // The roofs are drawn and edited on the Plan (Solar toolbar, Roof editor); the dialog only lists them.
  _roofsNote() {
    const roofs = PlanSolar.roofs();
    const list = roofs.length ? roofs.map(r => `${escHtml(r.name)}${r.use === false ? ' (not used)' : ''}`).join(', ') : 'none yet';
    return `<span style="grid-column:1/-1;font-size:12px">Roofs on the plan: ${list}. Draw and edit them with the Solar toolbar on the Plan tab (Roof, Roof editor); sizes here use every roof in use.</span>`;
  },

  _sizeResult() {
    const r = this._res;
    if (!r) return '';
    const max = Math.max(...r.months.map(m => m.kwh), 1);
    const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const bars = r.months.map((m, i) => `<div style="flex:1;text-align:center;font-size:10px" title="${names[i]}: ${Math.round(m.kwh)} kWh">
      <div style="height:${Math.round(80 * m.kwh / max)}px;background:var(--accent,#d9822b);margin-top:${80 - Math.round(80 * m.kwh / max)}px"></div>${names[i]}</div>`).join('');
    const tile = (l, v) => `<div style="background:var(--bg-muted,#f3f2ee);border-radius:6px;padding:8px 10px"><div style="font-size:11px;color:var(--text-muted,#6d6d6d)">${l}</div><div style="font-weight:600;font-size:15px">${v}</div></div>`;
    const lim = { roof: 'what the roof holds', load: 'the load target', target: 'the kWp target' }[r.limited_by];
    const short = r.mode === 'kwp' && r.limited_by === 'roof' && r.modules_target > r.modules;
    return `<div style="margin-top:14px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
        ${tile('Modules', r.mode === 'kwp' ? r.modules + ' (target ' + r.modules_target + ')' : r.modules + ' (roof ' + (r.modules_roof ?? '–') + ')')}
        ${tile('Array size', r.kwp + ' kWp')}
        ${tile('Annual yield', (r.annual_kwh / 1000).toFixed(1) + ' MWh')}
        ${tile('Specific yield', Math.round(r.specific_yield_kwh_kwp) + ' kWh/kWp')}
        ${tile('Performance ratio', r.performance_ratio ?? '–')}
        ${tile('Load covered', r.load_share_pct != null ? r.load_share_pct + ' %' : '–')}
      </div>
      <div style="margin-top:8px;font-size:12px">Size is set by ${lim}${short ? ': the roof holds ' + r.kwp + ' kWp of the ' + r.target_kwp + ' kWp target' : ''}${r.dc_ac_ratio ? '; DC/AC ratio ' + r.dc_ac_ratio : ''}.</div>
      ${r.arrays ? '<div style="margin-top:8px;font-size:12px">' + r.arrays.map(a => escHtml(a.name || 'Roof') + ': ' + a.modules + (a.laid_out ? ' modules as laid out, ' : ' of ' + a.modules_roof + ' modules, ') + a.kwp + ' kWp, ' + Math.round(a.annual_kwh) + ' kWh').join('<br>') + '</div>' : ''}
      <div style="display:flex;gap:3px;align-items:flex-end;height:104px;margin-top:8px" role="img" aria-label="Monthly energy, kWh">${bars}</div>
      ${r.shading_loss_pct != null ? '<div style="margin-top:6px;font-size:12px">Shading loss ' + r.shading_loss_pct + ' %</div>' : ''}
      ${r.clipping_loss_pct != null ? '<div style="margin-top:6px;font-size:12px">Inverter clipping ' + r.clipping_loss_pct + ' % of the DC energy' + (r.lifetime ? '; year 1 ' + Math.round(r.lifetime[0].kwh).toLocaleString() + ' kWh after first-year degradation, year 25 ' + Math.round(r.lifetime[24].kwh).toLocaleString() + ' kWh' : '') + '.</div>' : ''}
      <div style="margin-top:6px;font-size:11px;color:var(--text-muted,#6d6d6d)">${escHtml(r.data_note)}</div>`;
  },

  _stringsHtml(c) {
    const p = this.panel(c), inv = this.inverter(c);
    const total = this._res ? this._res.modules : 0;
    const head = this._grid(`
      <span>Module</span><span>${escHtml(p.name)}</span>
      <span>Inverter</span><span>${escHtml(inv.name)}</span>
      <span>Modules in the array</span><span>${total || '— calculate on step 1 first'}</span>
      ${this._in(c, 'perString', 'Modules per string', 'min="1"')}`);
    return head + `<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-act="strings" ${total ? '' : 'disabled'}>Place on the SLD and check strings</button></div>
      <div style="margin-top:6px;font-size:11px;color:var(--text-muted,#6d6d6d)">The checks are the app's own IEC 62548 string checks (also in the Properties panel and the Compliance report).</div>` + this._stringsResult();
  },

  // Spread whole strings over the inverter's MPPT inputs as evenly as possible.
  stringSplit(total, perString, mppts) {
    const strings = Math.floor(total / Math.max(1, perString));
    const out = [];
    for (let i = 0; i < Math.min(mppts, strings); i++) out.push(Math.floor(strings / mppts) + (i < strings % mppts ? 1 : 0));
    return { strings, perMppt: out.length ? out : [0], left: total - strings * perString };
  },

  _stringsResult() {
    const r = this._str;
    if (!r) return '';
    const mark = { pass: ['PASS', '#1e5b2b'], fail: ['FAIL', '#8a2b1e'], warn: ['WARN', '#8a5a00'], info: ['INFO', '#4b5563'] };
    const rows = r.items.map(k => { const m = mark[k.status] || mark.info; return `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border,#e4e2dc)">
      <span style="min-width:44px;font-size:11px;font-weight:700;color:${m[1]}">${m[0]}</span><span style="flex:1">${escHtml(k.message)}</span></div>`; }).join('');
    return `<div style="margin-top:12px">${rows}</div>
      <div style="margin-top:8px;font-size:12px">${r.strings} string${r.strings === 1 ? '' : 's'} × ${escHtml(this.cfg().perString)} modules placed on the SLD as <strong>${escHtml(r.name)}</strong>${r.left ? '; <strong>' + r.left + ' module' + (r.left === 1 ? '' : 's') + ' left over</strong> — change modules per string' : ''}.</div>`;
  },

  _rowsHtml(c) {
    const hours = [[0, 'Noon'], [30, '10:00 / 14:00'], [45, '09:00 / 15:00']];
    const body = this._grid(`
      ${this._in(c, 'tilt', 'Rack tilt (°)')}
      <label for="sol-hour">Design hour (winter solstice)</label><select id="sol-hour" data-k="hour">${this._opt(hours, String(c.hour), o => String(o[0]), o => o[1])}</select>
      ${this._in(c, 'width', 'Roof depth (m)')}`);
    const r = this._rows;
    const out = r ? `<div style="margin-top:12px;font-size:13px">Sun elevation ${r.sun_elevation_deg}° → row pitch <strong>${r.pitch_m} m</strong>,
      ground cover ratio ${r.ground_cover_ratio}${r.rows != null ? ', ' + r.rows + ' rows fit' : ''}.</div>` : '';
    return body + `<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-act="rows">Calculate rows</button></div>` + out;
  },

  _protectHtml(c) {
    const ok = !!this._str;
    const head = this._grid(`
      ${this._in(c, 'cableM', 'String cable length, one way (m)')}
      ${this._in(c, 'vdPct', 'DC voltage-drop limit (%)')}
      <label for="sol-exportKw">Export limit at the connection point (kW, blank = none)</label>
      <input id="sol-exportKw" data-k="exportKw" type="text" inputmode="decimal" style="max-width:140px" value="${escHtml(c.exportKw)}">`);
    const r = this._prot;
    const rows = r ? r.items.map(k => `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border,#e4e2dc)">
      <span style="min-width:44px;font-size:11px;font-weight:700;color:${k.ok ? '#1e5b2b' : '#8a2b1e'}">${k.ok ? 'OK' : 'FAIL'}</span><span>${escHtml(k.label)}</span></div>`).join('') : '';
    const exp = r && r.export_note ? `<div style="margin-top:8px;font-size:12px;font-weight:600;color:${r.export_limited ? '#8a2b1e' : 'inherit'}">${escHtml(r.export_note)}</div>` : '';
    return head + `<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-act="protect" ${ok ? '' : 'disabled'}>Size protection</button>
      ${ok ? '' : '<span style="font-size:12px"> check the strings on step 2 first</span>'}</div><div style="margin-top:12px">${rows}</div>${exp}`;
  },

  _libraryHtml() {
    const form = (kind, fields, title) => `<fieldset style="margin-top:12px;border:1px solid var(--border,#e4e2dc);border-radius:6px;padding:10px"><legend style="font-weight:600">${title}</legend>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;font-size:13px">${fields.map(([k, l, t]) =>
        `<label for="sol-lib-${kind}-${k}">${l}</label><input id="sol-lib-${kind}-${k}" data-lib="${kind}" data-lk="${k}" type="${t || 'number'}" step="any" style="max-width:200px"${k === 'phases' ? ' value="3"' : ''}>`).join('')}</div>
      <button class="btn" type="button" data-act="add${kind}" style="margin-top:8px">Add ${kind === 'panel' ? 'module' : 'inverter'}</button></fieldset>`;
    const mine = (list, kind) => list.length ? list.map(e => `<div style="display:flex;gap:8px;padding:4px 0"><span style="flex:1">${escHtml(e.name)}</span>
      <button class="btn" type="button" data-act="del${kind}" data-v="${escHtml(e.id)}" aria-label="Delete ${escHtml(e.name)}">×</button></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted,#6d6d6d)">None yet.</div>';
    const imp = `<fieldset style="margin-top:12px;border:1px solid var(--border,#e4e2dc);border-radius:6px;padding:10px"><legend style="font-weight:600">Import from PVsyst or CSV</legend>
      <label for="sol-lib-import" style="font-size:13px">Module (.PAN), inverter (.OND) or a CSV table with a header row</label>
      <input id="sol-lib-import" type="file" accept=".pan,.ond,.csv" multiple data-solimport style="display:block;margin-top:6px">
      ${this._impMsg ? `<div role="status" style="margin-top:8px;font-size:12px;white-space:pre-wrap">${escHtml(this._impMsg)}</div>` : ''}</fieldset>`;
    return `<div style="font-size:12px;color:var(--text-muted,#6d6d6d)">The shipped modules and inverters are fixed. Entries you add here are kept with this project.</div>${imp}
      <div style="margin-top:10px;font-weight:600">Your modules</div>${mine(this.customPanels(), 'panel')}${form('panel', this.PANEL_FIELDS, 'New module')}
      <div style="margin-top:14px;font-weight:600">Your inverters</div>${mine(this.customInverters(), 'inv')}${form('inv', this.INVERTER_FIELDS, 'New inverter')}
      ${this._libErr ? `<div role="alert" style="margin-top:8px;color:#8a2b1e;font-size:13px">${escHtml(this._libErr)}</div>` : ''}`;
  },

  _addEntry(kind) {
    const fields = kind === 'panel' ? this.PANEL_FIELDS : this.INVERTER_FIELDS;
    const e = {};
    for (const [k, , t] of fields) {
      const v = document.getElementById(`sol-lib-${kind}-${k}`).value;
      e[k] = t === 'text' ? v.trim() : parseFloat(v);
    }
    const err = kind === 'panel' ? this.validatePanel(e) : this.validateInverter(e);
    this._libErr = err;
    if (err) return;
    const key = kind === 'panel' ? 'customPanels' : 'customInverters';
    const list = (kind === 'panel' ? this.customPanels() : this.customInverters()).slice();
    e.id = 'custom_pv_' + (kind === 'panel' ? 'm' : 'i') + '_' + Date.now().toString(36);
    list.push(e);
    this.set(key, list);
  },
  // Import .PAN / .OND / .CSV files into THIS PROJECT's library (never an account or shared library). Each entry is validated
  // like a typed one; rejects and duplicates are listed, nothing is overwritten.
  async _importFiles(files) {
    const msgs = [];
    for (const f of Array.from(files || [])) {
      const text = await f.text();
      const ext = f.name.toLowerCase().split('.').pop();
      const kind = ext === 'pan' ? 'panel' : ext === 'ond' ? 'inv' : '';
      const have = (k) => (k === 'panel' ? this.customPanels() : this.customInverters()).map(e => e.name);
      const r = SolarImport.fromFile(f.name, text, (k, e) => (k === 'panel' ? this.validatePanel(e) : this.validateInverter(e)), kind ? have(kind) : have('panel').concat(have('inv')));
      if (r.entries.length) {
        const key = r.kind === 'panel' ? 'customPanels' : 'customInverters';
        const list = (r.kind === 'panel' ? this.customPanels() : this.customInverters()).slice();
        r.entries.forEach((e, i) => { e.id = 'custom_pv_' + (r.kind === 'panel' ? 'm' : 'i') + '_' + Date.now().toString(36) + i; list.push(e); });
        this.set(key, list);
        const d = Array.from(new Set(r.entries.flatMap(e => e.derived || [])));
        msgs.push(`${f.name}: added ${r.entries.length} ${r.kind === 'panel' ? 'module' : 'inverter'}${r.entries.length > 1 ? 's' : ''}` + (d.length ? ` (${d.join(', ')} not in the file: estimated, check them)` : '.'));
      }
      r.skipped.forEach(x => msgs.push(x));
    }
    this._impMsg = msgs.join('\n') || 'No file chosen.';
    this.render();
  },
  _delEntry(kind, id) {
    const key = kind === 'panel' ? 'customPanels' : 'customInverters';
    this.set(key, (kind === 'panel' ? this.customPanels() : this.customInverters()).filter(e => e.id !== id));
    const c = this.cfg();
    if (kind === 'panel' && c.module === id) this.set('module', this.DEFAULTS.module);
    if (kind === 'inv' && c.inverter === id) this.set('inverter', this.DEFAULTS.inverter);
  },

  _gridHtml(c) {
    const buses = [...AppState.components.values()].filter(x => x.type === 'bus');
    const busOpt = '<option value="">None — I will wire it myself</option>' + buses.map(b =>
      `<option value="${escHtml(b.id)}"${b.id === c.busId ? ' selected' : ''}>${escHtml((b.props && b.props.name) || b.id)}</option>`).join('');
    const head = this._grid(`
      <span style="grid-column:1/-1;font-weight:600">Obstruction above the array (applied on step 1, height 0 = none)</span>
      ${this._in(c, 'obsH', 'Height above the array (m)')}
      ${this._in(c, 'obsD', 'Distance from the array (m)')}
      ${this._in(c, 'obsB', 'Bearing from the array (° from north)')}
      ${this._in(c, 'obsW', 'Width (m)')}
      <span style="grid-column:1/-1;font-weight:600;margin-top:8px">Connection and the app's studies</span>
      <label for="sol-busId">Connect to bus</label><select id="sol-busId" data-k="busId">${busOpt}</select>
      ${this._in(c, 'acV', 'AC voltage (V)')}
      <span style="grid-column:1/-1;font-weight:600;margin-top:8px">Storage (hybrid inverter)</span>
      <label for="sol-hybrid">Add a DC-coupled battery</label><input id="sol-hybrid" data-k="hybrid" data-bool="1" type="checkbox" ${c.hybrid ? 'checked' : ''}>
      ${c.hybrid ? this._in(c, 'battKwh', 'Battery capacity (kWh)') + this._in(c, 'battKw', 'Max charge / discharge (kW)') + this._in(c, 'battDod', 'Usable depth of discharge (%)') : ''}`);
    const shade = this._res && this._res.shading_loss_pct != null ? `<div style="margin-top:8px;font-size:13px">Shading loss from the obstruction: <strong>${this._res.shading_loss_pct} %</strong> of the annual yield.</div>` : '';
    const can = this._res && this._res.arrays && c.roofShape === 'plan';
    const sh = this._shade;
    const annual = `<div style="margin-top:12px;font-weight:600">Annual shading from the 3D roofs</div>
      <div style="font-size:12px;color:var(--text-muted,#6d6d6d)">Checks every module against the roof objects, the obstruction above and the racks in front of it, for the middle day of each month at every solar hour. Strings are ${+c.perString || 'one'} modules, filled in layout order.</div>
      <div style="margin-top:6px"><button class="btn" type="button" data-act="shade" ${can ? '' : 'disabled'}>Run annual shading</button>${can ? '' : '<span style="font-size:12px"> needs roofs drawn on the plan and a calculation on step 1</span>'}</div>`
      + (sh ? `<div style="margin-top:8px;font-size:13px">Shading loss <strong>${sh.loss_pct} %</strong> of the annual yield (${Math.round(sh.unshaded_kwh).toLocaleString()} to ${Math.round(sh.shaded_kwh).toLocaleString()} kWh).</div>
        <div style="display:flex;gap:3px;align-items:flex-end;height:60px;margin-top:6px" role="img" aria-label="Shading loss by month, %">${sh.months.map(m => `<div title="${m.month}: ${m.loss_pct} %" style="flex:1;background:#b8860b;height:${Math.max(2, Math.min(60, m.loss_pct * 6))}px"></div>`).join('')}</div>
        <table style="margin-top:8px;font-size:12px;border-collapse:collapse"><tr><th align="left" style="padding:0 12px 0 0">Roof</th><th style="padding:0 12px">String</th><th style="padding:0 12px">Modules</th><th style="padding:0 12px">Loss %</th></tr>${sh.strings.map(r => `<tr><td style="padding:0 12px 0 0">${escHtml(r.array || '')}</td><td align="center">${r.string}</td><td align="center">${r.modules}</td><td align="center">${r.loss_pct}</td></tr>`).join('')}</table>
        <div style="margin-top:6px;font-size:11px;color:var(--text-muted,#6d6d6d)">${escHtml(sh.note)} ${escHtml(sh.attribution || '')}</div>` : '');
    const placed = this._pvComp();
    const run = (act, label, tip) => `<button class="btn" type="button" data-act="${act}" title="${escHtml(tip)}" ${placed ? '' : 'disabled'}>${label}</button>`;
    return head + shade + annual + `<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-act="place" ${this._res ? '' : 'disabled'}>Place / update on the SLD</button>
      ${this._res ? '<button class="btn" type="button" data-act="report" style="margin-left:6px">Solar PV report (PDF)</button>' : '<span style="font-size:12px"> calculate on step 1 first</span>'}</div>
      <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
        ${run('study:fault', 'Fault analysis', 'The inverter adds fault current from its Fault current (p.u.) setting')}
        ${run('study:loadflow', 'Load flow', 'Voltage rise and loading with the PV running at its irradiance setting')}
        ${run('study:hosting', 'Hosting capacity', 'How much PV the connection can take before voltage or thermal limits')}
        ${run('study:compliance', 'Compliance report', 'Includes the IEC 62548 string checks')}
        ${c.hybrid ? run('study:battery', 'Battery sizing', 'Duty-cycle sizing and discharge simulation of the hybrid battery') + run('study:backup', 'Backup autonomy', 'Grid-outage adequacy and battery autonomy') + run('study:timeseries', 'Time-series load flow', 'Day profile with the PV and battery') : ''}
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--text-muted,#6d6d6d)">These run the app's own studies on the whole network, so connect the array to a bus first. The results open in the usual place.</div>`;
  },

  // ── Actions ────────────────────────────────────────────────────────
  _status(m) { document.getElementById('status-info').textContent = m; },

  async _act(act, v) {
    if (act === 'tab') { this._tab = v; this.render(); return; }
    if (act === 'dtab') { this._dtab = v; this.render(); return; }
    if (act === 'dock') { this._dockOpen = !this._dockOpen; this.render(); return; }
    if (act === 'more') { this.open(); return; }
    if (act === 'view3d') { this.close(); RoofEditor.open(); return; }
    if (act === 'delroof') { PlanSolar.removeRoof(v); this.render(); return; }
    if (['addpanel', 'addinv'].includes(act)) { this._addEntry(act.slice(3)); this.render(); return; }
    if (['delpanel', 'delinv'].includes(act)) { this._delEntry(act.slice(3), v); this.render(); return; }
    if (this._busy) return;
    this._busy = true;
    try {
      if (act === 'run') await this.runSize();
      else if (act === 'strings') await this.runStrings();
      else if (act === 'rows') await this.runRows();
      else if (act === 'protect') await this.runProtection();
      else if (act === 'shade') await this.runShading();
      else if (act === 'report') await this.exportReport();
      else if (act === 'place') this.placePv();
      else if (act.startsWith('study:')) this.runStudy(act.slice(6));
    } catch (e) {
      this._status('Solar: ' + (e.message || e));
    } finally { this._busy = false; }
    this.render();
  },

  // The site: the chosen city, with its coordinates replaced by the typed ones when both are valid (the city still gives the
  // bundled-table climate and the minimum temperature; PVGIS data and the sun use the coordinates).
  _loc(c) {
    const base = this._locs.find(l => l.name === c.location) || this._locs[0], co = this.coords(c);
    return co ? Object.assign({}, base, co) : base;
  },
  // {lat, lon} when the typed site coordinates are both numbers in range, else null. Pure.
  coords(c) {
    const la = parseFloat(c.lat), lo = parseFloat(c.lon);
    return c.lat !== '' && c.lon !== '' && isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? { lat: la, lon: lo } : null;
  },
  // location + coordinates as the engine routes take them
  _site(c) { const co = this.coords(c); return co ? { location: c.location, lat: co.lat, lon: co.lon } : { location: c.location }; },

  async runProtection() {
    const c = this.cfg();
    const p = this.panel(c), inv = this.inverter(c);
    const sp = this.stringSplit(this._res.modules, +c.perString, inv.mppt_count);
    const body = { module: this.moduleBody(p), inverter: this.inverterBody(inv), modules_per_string: +c.perString,
      strings_per_mppt: sp.perMppt, string_cable_m: +c.cableM, vd_limit_pct: +c.vdPct,
      t_min_c: this._loc(c).tmin_c };
    if (String(c.exportKw).trim() !== '') body.export_limit_kw = parseFloat(c.exportKw);
    this._prot = await API.request('/analysis/solar-protection', 'POST', body);
  },

  async runRows() {
    const c = this.cfg();
    this._rows = await API.request('/analysis/solar-row-spacing', 'POST', {
      lat: this._loc(c).lat, tilt_deg: +c.tilt, module_length_m: this.panel(c).len,
      hour_angle_deg: +c.hour, roof_depth_m: +c.width });
  },

  async runSize() {
    const c = this.cfg();
    const g = this.roofArea(c), p = this.panel(c), inv = this.inverter(c);
    let packing = +c.packing;
    if (g.plan) {
      const used = PlanSolar.roofs().filter(r => r.use !== false);
      if (!used.length) throw new Error('No roofs in use. Tick a roof, or draw one on the plan.');
      const arrays = [];
      for (const r of used) {
        let gcr = packing;
        if (r.shape === 'flat') {
          const rs = await API.request('/analysis/solar-row-spacing', 'POST', {
            lat: this._loc(c).lat, tilt_deg: +r.tilt, module_length_m: p.len, hour_angle_deg: +c.hour });
          gcr = rs.ground_cover_ratio;
        }
        const first = arrays.length, nb = PlanSolar.shadeFor(r);      // this roof's own objects + the other roofs (used or not): each array sees only its own roof's
        arrays.push(...PlanSolar.arrays([r], gcr, packing));
        if (r.array && typeof PlanSolarArray !== 'undefined') {       // an array placed on the roof: the panels as laid out are the design
          const lay = PlanSolarArray.layout(r), planes = PlanSolar.usesPlanes(r);
          if (!lay.pending) for (const a of arrays.slice(first)) {
            if (!planes) { if (a.name === r.name) a.modules = lay.n; }
            else {                                                // a plane roof: one array per plane, named 'roof · plane'
              const pn = a.name.slice(r.name.length + 3);
              a.modules = (lay.byPlane && lay.byPlane[pn]) || 0;
            }
          }
        }
        if (nb.length) for (const a of arrays.slice(first)) a.obstructions = nb;
      }
      if (!arrays.length) throw new Error('The roofs have no usable area. Calibrate the plan scale and check the setback.');
      this._res = await API.request('/analysis/solar-size', 'POST', {
        ...this._site(c), irradiance_source: c.irrSrc, module: this.moduleBody(p), inverter: this.inverterBody(inv), mode: c.mode, arrays,
        annual_kwh: +c.annualKwh || null, share_pct: +c.sharePct, target_kwp: +c.targetKwp || null,
        obstructions: +c.obsH > 0 ? [{ height_m: +c.obsH, distance_m: +c.obsD, bearing_deg: +c.obsB, width_m: +c.obsW }] : [] });   // the typed one applies to every roof; objects and neighbours ride on each roof's arrays
      this._str = null; this._prot = null; this._shade = null;
      return;
    }
    if (g.flat) {
      // racks need row spacing: modules per area = ground cover ratio at the design hour
      const rs = await API.request('/analysis/solar-row-spacing', 'POST', {
        lat: this._loc(c).lat, tilt_deg: g.tilt, module_length_m: p.len, hour_angle_deg: +c.hour });
      packing = rs.ground_cover_ratio;
    }
    this._res = await API.request('/analysis/solar-size', 'POST', {
      ...this._site(c), irradiance_source: c.irrSrc, module: this.moduleBody(p), inverter: this.inverterBody(inv),
      tilt_deg: g.tilt, azimuth_deg: g.azimuth, mode: c.mode, usable_area_m2: g.area, packing,
      annual_kwh: +c.annualKwh || null, share_pct: +c.sharePct, target_kwp: +c.targetKwp || null,
      obstructions: +c.obsH > 0 ? [{ height_m: +c.obsH, distance_m: +c.obsD, bearing_deg: +c.obsB, width_m: +c.obsW }] : [] });
    this._str = null;
    this._prot = null;
    this._shade = null;
  },

  // Place / update the PV array on the SLD, then read the app's own string checks for it.
  async runStrings() {
    const c = this.cfg(), inv = this.inverter(c);
    const sp = this.stringSplit(this._res.modules, +c.perString, inv.mppt_count);
    if (!sp.strings) throw new Error('Fewer modules than one string. Lower the modules per string.');
    const comp = this.placePv(true);
    const items = Compliance._checkPVStrings().items.filter(i => i.component === (comp.props.name || comp.id));
    this._str = { items, strings: sp.strings, left: sp.left, name: comp.props.name || comp.id };
  },

  _pvComp() { const id = this.cfg().pvId; return id ? AppState.components.get(id) || null : null; },

  // Create or update the one Solar PV array (and its AC breaker) this tool owns. It is an ordinary
  // Solar PV component in array mode, so the fault, load flow, hosting capacity and compliance engines see it.
  placePv(quiet) {
    const c = this.cfg(), p = this.panel(c), inv = this.inverter(c);
    const sp = this.stringSplit(this._res.modules, +c.perString, inv.mppt_count);
    let pv = this._pvComp(), cb = null;
    const bus = c.busId ? AppState.components.get(c.busId) : null;
    if (!pv) {
      let x = bus ? bus.x : 200, y = bus ? bus.y - 200 : 160;
      if (!bus) for (const comp of AppState.components.values()) x = Math.max(x, comp.x + 200);
      pv = AppState.addComponent('solar_pv', x, y);
      pv.props.name = 'PV array';
      this.set('pvId', pv.id);
      cb = AppState.addComponent('cb', pv.x, pv.y + 110);
      cb.props.name = 'PV AC breaker';
      AppState.addWire(pv.id, 'out', cb.id, 'top');
    } else {
      cb = [...AppState.wires.values()].filter(w => w.fromComponent === pv.id && w.fromPort === 'out')
        .map(w => AppState.components.get(w.toComponent)).find(x => x && x.type === 'cb') || null;
    }
    Object.assign(pv.props, {
      rated_kw: inv.ac_kw, num_inverters: 1, voltage_kv: +(+c.acV / 1000).toFixed(4), inverter_eff: +(inv.eff_pct / 100).toFixed(4),
      fault_contribution_pu: inv.fault_x,
      pv_array_mode: 'array', pv_panel_type: p.id, pv_panel_w: p.w, pv_voc: p.voc, pv_vmp: p.vmp, pv_isc: p.isc,
      pv_imp: p.imp, pv_beta_voc: p.beta_voc, pv_gamma_vmp: p.gamma_vmp,
      pv_panels_per_string: +c.perString, pv_strings: sp.strings,
      mppt_min_v: inv.mppt_min_v, mppt_max_v: inv.mppt_max_v, dc_max_v: inv.dc_max_v,
      mppt_count: inv.mppt_count, mppt_max_a: inv.mppt_max_a, site_temp_min_c: this._loc(c).tmin_c,
      inverter_type: c.hybrid ? 'hybrid' : 'grid_tied',
    });
    // the hybrid battery uses the Solar PV component's own battery fields (the existing storage studies read them)
    if (c.hybrid) Object.assign(pv.props, { battery_kwh: +c.battKwh, battery_dod_pct: +c.battDod, battery_max_charge_kw: +c.battKw, battery_max_discharge_kw: +c.battKw });
    // connect the breaker to the chosen bus once (a wire already there is left alone)
    if (bus && cb && ![...AppState.wires.values()].some(w => (w.fromComponent === cb.id || w.toComponent === cb.id) && (w.fromComponent === bus.id || w.toComponent === bus.id))) {
      AppState.addWire(cb.id, 'bottom', bus.id, 'at_0');
    }
    AppState.dirty = true;
    if (typeof Canvas !== 'undefined') Canvas.render();
    if (!quiet) this._status('Solar: ' + (pv.props.name) + ' placed / updated (' + sp.strings + ' × ' + c.perString + ' modules).');
    return pv;
  },

  // Run one of the app's own studies on the placed array, by pressing its normal menu button.
  // The Solar PV report: the results already on screen go to the server to be typeset (nothing is recalculated there).
  async exportReport() {
    const c = this.cfg();
    if (!this._res) throw new Error('Calculate the array on step 1 first.');
    const blob = await API.generateSolarReport({
      inputs: { location: c.location + (this.coords(c) ? ` (${this.coords(c).lat}, ${this.coords(c).lon})` : ''), module: this.panel(c).name, inverter: this.inverter(c).name, perString: c.perString },
      result: this._res, strings: this._str || null, protection: this._prot || null, shading: this._shade || null });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${AppState.projectName || 'Untitled'}_solar_pv.pdf`; a.click();
    URL.revokeObjectURL(url);
    this._status('Exported the Solar PV report as PDF.');
  },

  // Annual shading: the 3D scene's module shade flags at the sun grid, then the engine's hourly model per string.
  async runShading() {
    const c = this.cfg(), res = this._res;
    if (c.roofShape !== 'plan' || !res || !res.arrays) throw new Error('Calculate the size for roofs drawn on the plan first.');
    this._status('Checking every module against the sun over the year…');
    const sc = await Roof3D.build();
    if (sc.empty) throw new Error('No roofs to check.');
    const grid = await API.request('/analysis/solar-sun-grid', 'POST', this._site(c));
    const flags = Roof3D.annualFlags(sc, grid.samples);
    const arrays = res.arrays.map(a => {
      const f = flags.find(x => x.arr === a.name);
      return f ? { name: a.name, tilt_deg: a.tilt_deg, azimuth_deg: a.azimuth_deg, modules: f.shade.length, per_string: +c.perString || f.shade.length, shade: f.shade } : null;
    }).filter(Boolean);
    if (!arrays.length) throw new Error('No modules are laid out on the roofs yet.');
    const p = this.panel(c), inv = this.inverter(c);
    this._shade = await API.request('/analysis/solar-shading', 'POST', {
      ...this._site(c), module: this.moduleBody(p), inverter: this.inverterBody(inv), arrays });
    this._status('');
  },

  runStudy(which) {
    const id = { fault: 'btn-run-fault', loadflow: 'btn-run-loadflow', hosting: 'btn-hosting-capacity', compliance: 'btn-compliance',
      battery: 'btn-battery-sizing', backup: 'btn-backup-study', timeseries: 'btn-timeseries' }[which];
    const b = document.getElementById(id);
    if (!b) return;
    if (!this._pvComp()) throw new Error('Place the PV array on the SLD first.');
    this.close();
    b.click();
  },
};

if (typeof module !== "undefined" && module.exports) module.exports = Solar;
