/* ProtectionPro — Solar PV design (phases 1-2 of docs/SOLAR_DESIGN_PLAN.md).
 *
 * One modal with three steps: Roof & size (location, roof from a dialog or a typed area, sizing from
 * the roof and / or the annual load, monthly yield), Strings (modules per string and strings per MPPT
 * checked against the inverter) and Rows (flat-roof row spacing). "Add to SLD" places a Solar PV
 * inverter in array mode with the chosen module / inverter / strings, plus its AC breaker.
 *
 * Modules and inverters come from PV_PANELS / PV_INVERTERS (constants.js). Every number comes from the
 * backend (/analysis/solar-size, solar-strings, solar-row-spacing); this file only gathers inputs,
 * works out the roof area from the dialog (`roofArea`, pure) and draws results.
 * The inputs are kept with the project in planMarkup.settings.solar.
 */
const Solar = {
  _tab: 'size',
  _locs: null,
  _res: null,
  _str: null,
  _rows: null,
  _busy: false,
  DEFAULTS: {
    location: 'Pretoria', module: 'pv_550_mono', inverter: 'inv_10k_2mppt',
    roofShape: 'gable', length: 10, width: 9.2, pitch: 25, setback: 0.5, area: 60, packing: 0.8,
    tilt: 15, azimuth: 0, mode: 'min', annualKwh: 18500, sharePct: 70,
    perString: 8, hour: 0,
  },

  cfg() {
    const pm = AppState.planMarkup;
    const store = pm && pm.settings ? (pm.settings.solar = pm.settings.solar || {}) : (this._mem = this._mem || {});
    return Object.assign({}, this.DEFAULTS, store);
  },
  set(key, value) {
    const pm = AppState.planMarkup;
    const store = pm && pm.settings ? (pm.settings.solar = pm.settings.solar || {}) : (this._mem = this._mem || {});
    store[key] = value;
    AppState.dirty = true;
  },

  panel(c) { return PV_PANELS.find(p => p.id === c.module) || PV_PANELS[0]; },
  inverter(c) { return PV_INVERTERS.find(i => i.id === c.inverter) || PV_INVERTERS[0]; },

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
    const c = this.cfg();
    const tabs = [['size', '1 Roof & size'], ['strings', '2 Strings'], ['rows', '3 Rows (flat roof)']];
    const bar = tabs.map(([k, l]) => `<button type="button" class="btn${this._tab === k ? ' btn-primary' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join(' ');
    const body = { size: () => this._sizeHtml(c), strings: () => this._stringsHtml(c), rows: () => this._rowsHtml(c) }[this._tab]();
    const el = document.getElementById('solar-body');
    el.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">${bar}</div>${body}`;
    el.querySelectorAll('[data-k]').forEach(i => i.addEventListener('change', () => {
      const v = i.type === 'number' ? parseFloat(i.value) : i.value;
      this.set(i.dataset.k, v);
      if (['roofShape', 'mode'].includes(i.dataset.k)) this.render();
    }));
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this._act(b.dataset.act, b.dataset.v)));
  },

  _grid(inner) {
    return `<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">${inner}</div>`;
  },

  _sizeHtml(c) {
    const loc = this._opt(this._locs, c.location, o => o.name, o => o.name);
    const mod = this._opt(PV_PANELS, c.module, o => o.id, o => o.name);
    const inv = this._opt(PV_INVERTERS, c.inverter, o => o.id, o => o.name);
    const shape = [['gable', 'Gable (north plane)'], ['flat', 'Flat with tilted racks'], ['area', 'Type a usable area']];
    const modes = [['min', 'Smaller of roof and load'], ['roof', 'Roof capacity'], ['load', 'Load target']];
    const geo = c.roofShape === 'area'
      ? this._in(c, 'area', 'Usable area (m²)') + this._in(c, 'packing', 'Packing factor') + this._in(c, 'tilt', 'Tilt (°)') + this._in(c, 'azimuth', 'Azimuth (° from north)')
      : this._in(c, 'length', 'Length (m)') + this._in(c, 'width', 'Width (m)')
        + (c.roofShape === 'gable' ? this._in(c, 'pitch', 'Pitch (°)') : this._in(c, 'tilt', 'Rack tilt (°)') + this._in(c, 'azimuth', 'Azimuth (° from north)'))
        + this._in(c, 'setback', 'Edge setback (m)');
    return this._grid(`
      <label for="sol-location">Location</label><select id="sol-location" data-k="location">${loc}</select>
      <label for="sol-module">Module</label><select id="sol-module" data-k="module">${mod}</select>
      <label for="sol-inverter">Inverter</label><select id="sol-inverter" data-k="inverter">${inv}</select>
      <label for="sol-roofShape">Roof</label><select id="sol-roofShape" data-k="roofShape">${this._opt(shape, c.roofShape, o => o[0], o => o[1])}</select>
      ${geo}
      ${this._in(c, 'annualKwh', 'Annual consumption (kWh)')}
      ${this._in(c, 'sharePct', 'Share to cover (%)')}
      <label for="sol-mode">Size set by</label><select id="sol-mode" data-k="mode">${this._opt(modes, c.mode, o => o[0], o => o[1])}</select>`)
      + `<div style="margin-top:12px;display:flex;gap:8px;align-items:center"><button class="btn btn-primary" type="button" data-act="run">Calculate</button>
         <span style="font-size:12px;color:var(--text-muted,#6d6d6d)">${escHtml(this.roofArea(c).note)}</span></div>`
      + this._sizeResult();
  },

  _sizeResult() {
    const r = this._res;
    if (!r) return '';
    const max = Math.max(...r.months.map(m => m.kwh), 1);
    const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const bars = r.months.map((m, i) => `<div style="flex:1;text-align:center;font-size:10px" title="${names[i]}: ${Math.round(m.kwh)} kWh">
      <div style="height:${Math.round(80 * m.kwh / max)}px;background:var(--accent,#d9822b);margin-top:${80 - Math.round(80 * m.kwh / max)}px"></div>${names[i]}</div>`).join('');
    const tile = (l, v) => `<div style="background:var(--bg-muted,#f3f2ee);border-radius:6px;padding:8px 10px"><div style="font-size:11px;color:var(--text-muted,#6d6d6d)">${l}</div><div style="font-weight:600;font-size:15px">${v}</div></div>`;
    const lim = { roof: 'the roof', load: 'the load target' }[r.limited_by];
    return `<div style="margin-top:14px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
        ${tile('Modules', r.modules + ' (roof ' + (r.modules_roof ?? '–') + ', load ' + (r.modules_load ?? '–') + ')')}
        ${tile('Array size', r.kwp + ' kWp')}
        ${tile('Annual yield', (r.annual_kwh / 1000).toFixed(1) + ' MWh')}
        ${tile('Specific yield', Math.round(r.specific_yield_kwh_kwp) + ' kWh/kWp')}
        ${tile('Performance ratio', r.performance_ratio)}
        ${tile('Load covered', r.load_share_pct != null ? r.load_share_pct + ' %' : '–')}
      </div>
      <div style="margin-top:8px;font-size:12px">Size is set by ${lim}${r.dc_ac_ratio ? '; DC/AC ratio ' + r.dc_ac_ratio : ''}.</div>
      <div style="display:flex;gap:3px;align-items:flex-end;height:104px;margin-top:8px" role="img" aria-label="Monthly energy, kWh">${bars}</div>
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
    return head + `<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-act="strings" ${total ? '' : 'disabled'}>Check strings</button></div>` + this._stringsResult();
  },

  // Spread whole strings over the inverter's MPPT inputs as evenly as possible.
  stringSplit(total, perString, mppts) {
    const strings = Math.floor(total / Math.max(1, perString));
    const out = [];
    for (let i = 0; i < Math.min(mppts, strings); i++) out.push(Math.floor(strings / mppts) + (i < strings % mppts ? 1 : 0));
    // more strings than the even split can carry per input: keep spreading
    return { strings, perMppt: out.length ? out : [0], left: total - strings * perString };
  },

  _stringsResult() {
    const r = this._str;
    if (!r) return '';
    const rows = r.checks.map(k => `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border,#e4e2dc)">
      <span style="min-width:44px;font-size:11px;font-weight:700;color:${k.ok ? '#1e5b2b' : '#8a2b1e'}">${k.ok ? 'PASS' : 'FAIL'}</span>
      <span style="flex:1">${escHtml(k.label)}</span><span>${k.value} / ${k.limit}</span></div>`).join('');
    return `<div style="margin-top:12px">${rows}</div>
      <div style="margin-top:8px;font-size:12px">Allowed modules per string: ${r.n_min} to ${r.n_max}. String current for fuses and cables: 1.25 × Isc = ${r.string_isc_design_a} A.
      ${r.total_modules} modules used (${r.kwp} kWp, DC/AC ${r.dc_ac_ratio})${r.left ? '; <strong>' + r.left + ' left over</strong> — change modules per string' : ''}.</div>
      <div style="margin-top:12px"><button class="btn" type="button" data-act="sld">Add to SLD</button></div>`;
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

  // ── Actions ────────────────────────────────────────────────────────
  _status(m) { document.getElementById('status-info').textContent = m; },

  async _act(act, v) {
    if (act === 'tab') { this._tab = v; this.render(); return; }
    if (this._busy) return;
    this._busy = true;
    try {
      if (act === 'run') await this.runSize();
      else if (act === 'strings') await this.runStrings();
      else if (act === 'rows') await this.runRows();
      else if (act === 'sld') this.addToSld();
    } catch (e) {
      this._status('Solar: ' + (e.message || e));
    } finally { this._busy = false; }
    this.render();
  },

  _loc(c) { return this._locs.find(l => l.name === c.location) || this._locs[0]; },

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
    if (g.flat) {
      // racks need row spacing: modules per area = ground cover ratio at the design hour
      const rs = await API.request('/analysis/solar-row-spacing', 'POST', {
        lat: this._loc(c).lat, tilt_deg: g.tilt, module_length_m: p.len, hour_angle_deg: +c.hour });
      packing = rs.ground_cover_ratio;
    }
    this._res = await API.request('/analysis/solar-size', 'POST', {
      location: c.location, module: this.moduleBody(p), inverter: this.inverterBody(inv),
      tilt_deg: g.tilt, azimuth_deg: g.azimuth, mode: c.mode, usable_area_m2: g.area, packing,
      annual_kwh: +c.annualKwh || null, share_pct: +c.sharePct });
    this._str = null;
  },

  async runStrings() {
    const c = this.cfg();
    const p = this.panel(c), inv = this.inverter(c);
    const sp = this.stringSplit(this._res.modules, +c.perString, inv.mppt_count);
    this._str = await API.request('/analysis/solar-strings', 'POST', {
      module: this.moduleBody(p), inverter: this.inverterBody(inv), modules_per_string: +c.perString,
      strings_per_mppt: sp.perMppt, t_min_c: this._loc(c).tmin_c });
    this._str.left = sp.left;
    this._str.strings = sp.strings;
  },

  // Place one Solar PV inverter in array mode and its AC breaker; the user wires it to a bus.
  addToSld() {
    const c = this.cfg(), p = this.panel(c), inv = this.inverter(c), r = this._str;
    if (!r) return;
    let x = 200, y = 160;
    for (const comp of AppState.components.values()) { x = Math.max(x, comp.x + 200); }
    const pv = AppState.addComponent('solar_pv', x, y);
    Object.assign(pv.props, {
      name: 'PV array', rated_kw: inv.ac_kw, num_inverters: 1, inverter_eff: +(inv.eff_pct / 100).toFixed(4),
      pv_array_mode: 'array', pv_panel_type: p.id, pv_panel_w: p.w, pv_voc: p.voc, pv_vmp: p.vmp, pv_isc: p.isc,
      pv_imp: p.imp, pv_beta_voc: p.beta_voc, pv_gamma_vmp: p.gamma_vmp,
      pv_panels_per_string: +c.perString, pv_strings: this._str.strings,
      mppt_min_v: inv.mppt_min_v, mppt_max_v: inv.mppt_max_v, dc_max_v: inv.dc_max_v,
      mppt_count: inv.mppt_count, mppt_max_a: inv.mppt_max_a,
      site_temp_min_c: this._loc(c).tmin_c,
    });
    const cb = AppState.addComponent('cb', x, y + 120);
    cb.props.name = 'PV AC breaker';
    AppState.addWire(pv.id, 'out', cb.id, 'top');
    if (typeof Canvas !== 'undefined') Canvas.render();
    this._status('Solar: placed ' + pv.props.name + ' (' + this._str.strings + ' × ' + c.perString + ' modules) and its AC breaker. Wire the breaker to a bus.');
    this.close();
  },
};
