/* ProtectionPro — Custom loads on the site plan.
 *
 * A load TYPE (pump, borehole, motor…) is defined once per project in
 * `AppState.planMarkup.loadTypes`: symbol letter, colour, rated kW, voltage,
 * phases, power factor, starting method, duty and which supplies may feed it
 * (mini-sub and/or kiosk). Each type is a palette item; a placed load is an
 * element of type `load` whose `props` carry `loadType`, `fedFrom` (the id of
 * the mini-sub or kiosk feeding it), an optional `kw` override and the supply
 * `cableType`. The supply cable is drawn from that supply to the load (a
 * direct line, layer route key `loadfeed`); it is not a separate item.
 *
 * Demand: a load fed from a linked mini-sub / kiosk adds kW ÷ pf × its type's
 * diversity to that row (`demandByRow` → `customLoadKVA`, a fixed load in the
 * ADMD engine); a type marked Motor is also checked for starting in Demand
 * (`motorsForDemand` → /analysis/retic-motor-start). The single line is untouched.
 */
const PlanLoads = {
  VOLTS: [230, 400, 525, 690],
  STARTS: ['DOL', 'Star-delta', 'Autotransformer', 'Soft starter', 'VFD'],
  DUTIES: ['Continuous', 'Intermittent', 'Standby'],
  SUPPLIES: ['minisub', 'kiosk'],
  SUPPLY_NAME: { minisub: 'Mini-sub', kiosk: 'Kiosk' },

  defaultTypes() { return JSON.parse(JSON.stringify(PLAN_DEFAULT_LOAD_TYPES)); },
  list() { const pm = AppState.planMarkup; return (pm && Array.isArray(pm.loadTypes)) ? pm.loadTypes : []; },
  get(id) { return this.list().find(t => t.id === id) || null; },
  typeOf(el) { return this.get(el && el.props && el.props.loadType); },
  color(el) { const t = this.typeOf(el); return (t && t.color) || '#0ea5e9'; },
  letter(el) { const t = this.typeOf(el); return (t && t.letter) || 'L'; },
  isLoad(el) { return !!el && el.type === 'load'; },

  // Rated power of a placed load: its own override, else its type's.
  kw(el) {
    const own = parseFloat(el.props && el.props.kw);
    if (own > 0) return own;
    const t = this.typeOf(el);
    return t ? (Number(t.kw) || 0) : 0;
  },
  amps(el) {
    const t = this.typeOf(el); if (!t) return null;
    const kw = this.kw(el);
    if (!(kw > 0) || !(t.volt > 0) || !(t.pf > 0)) return null;
    return Math.round(kw * 1000 / ((t.phases === 3 ? Math.sqrt(3) : 1) * t.volt * t.pf) * 10) / 10;
  },

  // Diversity factor of a load type (0.05–1; absent = 1, no diversity).
  diversity(t) { const d = parseFloat(t && t.diversity); return d > 0 ? Math.min(1, d) : 1; },

  // ── Demand rows ──
  // A custom load in Demand is a row on its kiosk or mini-sub:
  // `owner.loads = [{ id, name, loadType, kw ('' = the type's), cableType,
  // length (m) }]`. A drawn load is linked to its row by `reticId`.
  // Every row with its owner: [{ row, owner, kind: 'kiosk' | 'minisub' }].
  rows() {
    const R = (typeof AppState !== 'undefined') ? AppState.reticulation : null;
    const out = [];
    if (!R) return out;
    for (const m of R.minisubs || []) for (const row of m.loads || []) out.push({ row, owner: m, kind: 'minisub' });
    for (const k of R.kiosks || []) for (const row of k.loads || []) out.push({ row, owner: k, kind: 'kiosk' });
    return out;
  },
  rowKw(row) {
    const own = parseFloat(row && row.kw);
    if (own > 0) return own;
    const t = this.get(row && row.loadType);
    return t ? t.kw : 0;
  },
  // Is a Demand row a motor? Its own choice (`row.motor`: 'motor' | 'static'),
  // else its load type's setting.
  isMotor(row, t) {
    if (row && row.motor === 'motor') return true;
    if (row && row.motor === 'static') return false;
    t = t || this.get(row && row.loadType);
    return !!(t && t.motor);
  },
  // Demand of a row: kW ÷ pf × the type's diversity (kVA).
  rowKva(row) {
    const t = this.get(row && row.loadType), kw = this.rowKw(row);
    if (!t || !(kw > 0)) return 0;
    return kw / (t.pf > 0 ? t.pf : 1) * this.diversity(t);
  },
  // Demand of each kiosk / mini-sub row from its custom loads:
  // { ownerId: { kva, items: [{ id, name, type, kw, div, kva, motor }] } }.
  demandByRow() {
    const out = {};
    for (const { row, owner } of this.rows()) {
      const t = this.get(row.loadType), kva = this.rowKva(row);
      if (!t || !(kva > 0)) continue;
      const r = out[owner.id] || (out[owner.id] = { kva: 0, items: [] });
      r.kva += kva;
      r.items.push({ id: row.id, name: row.name || t.name, type: t.name, kw: this.rowKw(row), div: this.diversity(t), kva: +kva.toFixed(3), motor: this.isMotor(row, t) });
    }
    for (const r of Object.values(out)) r.kva = +r.kva.toFixed(3);
    return out;
  },
  // A drawn load edited in the Properties panel: the linked Demand row takes the
  // new value now (Demand's values win in the next sync pass). Returns whether a
  // row was changed.
  pushToRow(el, key, val) {
    const f = (typeof PlanSync !== 'undefined' && el && el.reticId) ? PlanSync._reticRow(el.reticId) : null;
    if (!f || f.kind !== 'load') return false;
    if (key === 'name') f.row.name = val;
    else if (key === 'loadType' || key === 'cableType') f.row[key] = val;
    else if (key === 'motor') f.row.motor = val === 'motor' || val === 'static' ? val : '';
    else if (key === 'kw') f.row.kw = val > 0 ? val : '';
    else if (key === 'fedFrom') {
      const sup = AppState.planAllElements().find(e => e.id === val);
      const owner = sup && sup.reticId ? [...AppState.reticulation.kiosks, ...AppState.reticulation.minisubs].find(o => o.id === sup.reticId) : null;
      if (!owner || owner === f.owner) return false;
      f.list.splice(f.index, 1);
      (owner.loads || (owner.loads = [])).push(f.row);
    } else return false;
    AppState.dirty = true;
    if (typeof Retic !== 'undefined') {
      if (Retic._snapshot) Retic._snapshot();
      if (Retic._active) { Retic.render && Retic.render(); }
      if (Retic.computeInBackground) Retic.computeInBackground();
    }
    return true;
  },

  // Motor rows (any supply), for the Demand motor starting check.
  motorsForDemand() {
    const out = [];
    for (const { row, owner } of this.rows()) {
      const t = this.get(row.loadType);
      const kw = this.rowKw(row);
      if (!t || !this.isMotor(row, t) || !(kw > 0)) continue;
      out.push({
        id: row.id, name: row.name || t.name, supplyId: owner.id, supplyName: owner.name || '',
        kw, volt: t.volt, phases: t.phases, pf: t.pf, eff: t.eff || 0.93,
        lrc: t.lrc || 6, lrtPct: t.lrtPct || 150, rpm: t.rpm || 0, method: t.start,
        cableType: row.cableType || '', lengthM: Number(row.length) || 0,
      });
    }
    return out;
  },

  // ── Supplies ──
  allowedSupplies(type) {
    return this.SUPPLIES.filter(k => type && type.supply && type.supply[k]);
  },
  supplyElements(type) {
    const ok = this.allowedSupplies(type);
    return AppState.planMarkup.elements.filter(e => ok.includes(e.type));
  },
  supplyOf(el) {
    const id = el.props && el.props.fedFrom;
    return id ? AppState.planMarkup.elements.find(e => e.id === id) || null : null;
  },
  nearestSupply(type, x, y) {
    let best = null, bd = Infinity;
    for (const s of this.supplyElements(type)) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  },
  // Loads fed from one mini-sub / kiosk.
  fedBy(supply) {
    return AppState.planMarkup.elements.filter(e => e.type === 'load' && e.props && e.props.fedFrom === supply.id);
  },
  // Supply cable as a straight run: { a, b } world points, or null when unfed.
  feedLine(el) {
    const s = this.supplyOf(el);
    return s ? { a: { x: s.x, y: s.y }, b: { x: el.x, y: el.y } } : null;
  },
  feedLengthPx(el) {
    const l = this.feedLine(el);
    return l ? Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) : 0;
  },
  feedLengthM(el) {
    const f = (typeof PlanEngine !== 'undefined') ? PlanEngine.factor() : null;
    return f ? this.feedLengthPx(el) * f : null;
  },

  // ── Placing ──
  nextName(typeId) {
    const t = this.get(typeId);
    return PlanMarkup.nextCounter('load:' + typeId, (t ? t.name : 'Load') + ' ');
  },
  // Props for a new load of a type, fed from the nearest allowed supply.
  newProps(typeId, x, y) {
    const t = this.get(typeId);
    const s = t ? this.nearestSupply(t, x, y) : null;
    return { loadType: typeId, kw: '', fedFrom: s ? s.id : '', cableType: '', motor: '' };
  },

  // ── Properties panel ──
  // Selects for the load's type and supply (the generic fields cover name, kW, cable).
  fieldsFor(item) {
    const types = this.list();
    const t = this.typeOf(item);
    const sups = t ? this.supplyElements(t) : [];
    const cur = this.supplyOf(item);
    const opts = [{ value: '', label: '— not fed —' }]
      .concat(sups.map(s => ({ value: s.id, label: `${s.name || s.id} (${this.SUPPLY_NAME[s.type]})` })));
    if (cur && !sups.includes(cur)) opts.push({ value: cur.id, label: `${cur.name || cur.id} (not allowed for this load)` });
    return [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'loadType', label: 'Load type', type: 'select', options: types.map(x => ({ value: x.id, label: x.name })) },
      { key: 'motor', label: 'Load kind', type: 'select', options: [{ value: '', label: t && t.motor ? 'Type default (motor)' : 'Type default (static)' }, { value: 'static', label: 'Static load' }, { value: 'motor', label: 'Motor' }] },
      { key: 'fedFrom', label: 'Fed from', type: 'select', options: opts },
      { key: 'kw', label: `Power${t ? ` (blank = ${t.kw})` : ''}`, type: 'number', unit: 'kW', min: 0, step: 0.1 },
      { key: 'cableType', label: 'Supply cable', type: 'cable_select', voltage: 'lv' },
    ];
  },
  // Read-only summary under the fields: a load's figures, or a supply's loads.
  summaryHtml(item) {
    if (item.type === 'load') {
      const t = this.typeOf(item);
      if (!t) return '<div class="plan-linked-note">This load\'s type no longer exists. Pick another above.</div>';
      const a = this.amps(item), m = this.feedLengthM(item), sup = this.supplyOf(item);
      const bits = [this.isMotor({ motor: item.props && item.props.motor }, t) ? 'Motor' : 'Static', `${this.kw(item)} kW`, `${t.volt} V ${t.phases}φ`, `pf ${t.pf}`, a != null ? `≈ ${a} A` : '', t.start, t.duty].filter(Boolean);
      let h = `<div class="plan-load-sum"><b>${escHtml(t.name)}</b><span>${escHtml(bits.join(' · '))}</span>`;
      if (sup) h += `<span>Fed from ${escHtml(sup.name || sup.id)}${m != null ? ` · supply run ≈ ${m.toFixed(1)} m (straight line)` : ''}</span>`;
      else h += '<span class="warn">Not fed from a mini-sub or kiosk yet.</span>';
      if (sup && !this.allowedSupplies(t).includes(sup.type)) h += `<span class="warn">${escHtml(t.name)} loads can't be fed from a ${this.SUPPLY_NAME[sup.type].toLowerCase()}.</span>`;
      return h + '</div>';
    }
    if (this.SUPPLIES.includes(item.type)) {
      const loads = this.fedBy(item);
      if (!loads.length) return '';
      const total = loads.reduce((s, e) => s + this.kw(e), 0);
      return `<div class="plan-load-sum"><b>Custom loads fed</b>${loads.map(e => `<span>${escHtml(e.name || e.id)} · ${this.kw(e)} kW</span>`).join('')}<span><b>Total ${Math.round(total * 10) / 10} kW</b></span></div>`;
    }
    return '';
  },

  // ── Load types dialog ──
  openManager() {
    const overlay = document.createElement('div');
    overlay.className = 'modal plan-loads-modal';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '3000';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Load types');
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    document.addEventListener('keydown', onKey, true);
    const open = new Set();
    const sel = (role, arr, v) => `<select data-role="${role}">${arr.map(x => `<option${String(x) === String(v) ? ' selected' : ''}>${x}</option>`).join('')}</select>`;

    const render = () => {
      const used = (id) => AppState.planMarkup.elements.filter(e => e.type === 'load' && e.props && e.props.loadType === id).length;
      const rows = this.list().map(t => {
        const isOpen = open.has(t.id);
        const sup = this.allowedSupplies(t).map(k => this.SUPPLY_NAME[k].toLowerCase()).join(' or ') || 'nothing';
        return `<div class="ply-layer${isOpen ? ' open' : ''}" data-type="${escHtml(t.id)}" style="--lc:${escHtml(t.color)}">
          <div class="ply-row">
            <input type="color" value="${escHtml(t.color)}" data-role="color" aria-label="Colour of ${escHtml(t.name)}">
            <input type="text" class="ply-name" value="${escHtml(t.name)}" data-role="name" aria-label="Load type name">
            <button type="button" class="ply-ib" data-role="open" aria-expanded="${isOpen}">${isOpen ? 'Close' : 'Edit'}</button>
          </div>
          <div class="ply-sub">${escHtml(String(t.kw))} kW · ${escHtml(String(t.volt))} V ${escHtml(String(t.phases))}φ · pf ${escHtml(String(t.pf))}${this.diversity(t) < 1 ? ' · div ' + this.diversity(t) : ''} · ${escHtml(t.start)} · ${escHtml(t.duty)} · fed from ${sup} · ${used(t.id)} placed</div>
          ${isOpen ? `<div class="ply-body ply-form">
            <label>Symbol letter<input type="text" maxlength="2" value="${escHtml(t.letter)}" data-role="letter"></label>
            <label>Rated power (kW)<input type="number" min="0.1" step="0.1" value="${escHtml(String(t.kw))}" data-role="kw"></label>
            <label>Voltage (V)${sel('volt', this.VOLTS, t.volt)}</label>
            <label>Phases${sel('phases', [1, 3], t.phases)}</label>
            <label>Power factor<input type="number" min="0.3" max="1" step="0.01" value="${escHtml(String(t.pf))}" data-role="pf"></label>
            <label>Diversity factor<input type="number" min="0.05" max="1" step="0.05" value="${this.diversity(t)}" data-role="diversity" title="Share of the load counted in Demand (1 = all of it)"></label>
            <div class="chk full"><label><input type="checkbox" data-role="motor"${t.motor ? ' checked' : ''}> Motor — check its starting in Demand</label></div>
            ${t.motor ? `<label>Efficiency<input type="number" min="0.5" max="0.99" step="0.01" value="${escHtml(String(t.eff || 0.93))}" data-role="eff"></label>
            <label>Locked-rotor current (× FLC)<input type="number" min="2" max="12" step="0.1" value="${escHtml(String(t.lrc || 6))}" data-role="lrc"></label>
            <label>Locked-rotor torque (% FLT)<input type="number" min="50" max="400" step="5" value="${escHtml(String(t.lrtPct || 150))}" data-role="lrtPct"></label>
            <label>Rated speed (rpm, 0 = typical)<input type="number" min="0" step="10" value="${escHtml(String(t.rpm || 0))}" data-role="rpm"></label>` : ''}
            <label>Starting method${sel('start', this.STARTS, t.start)}</label>
            <label class="full">Duty${sel('duty', this.DUTIES, t.duty)}</label>
            <div class="chk full"><span>Can be fed from</span>
              ${this.SUPPLIES.map(k => `<label><input type="checkbox" data-role="supply" data-k="${k}"${t.supply[k] ? ' checked' : ''}> ${this.SUPPLY_NAME[k]}</label>`).join('')}</div>
            <div class="full"><button type="button" class="ply-ib" data-role="del">Delete load type</button></div>
          </div>` : ''}
        </div>`;
      }).join('');
      overlay.innerHTML = `<div class="modal-content plan-layers-content">
        <div class="modal-header"><h3>Load types</h3></div>
        <div class="modal-body">
          <p class="ply-help">Define a load once, then place as many as you need from the <b>Loads</b> group in the parts list. Each one is fed from a mini-sub or kiosk and draws a supply cable to it. A load adds its kW ÷ pf × diversity to the mini-sub or kiosk that feeds it in Demand, and a motor type is checked for starting there.</p>
          <div class="ply-list">${rows || '<div class="ply-none">No load types yet.</div>'}</div>
          <div class="ply-foot"><button type="button" class="btn-small" data-role="add">+ New load type</button>
            <span class="ply-spacer"></span><button type="button" class="btn-primary" data-role="close">Done</button></div>
        </div></div>`;
    };
    const typeOfRow = (el) => { const r = el.closest('[data-type]'); return r && this.get(r.dataset.type); };
    const changed = (commit) => {
      if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
      PlanEngine.requestDraw({ fg: true });
      if (commit) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { close(); return; }
      const b = e.target.closest('button[data-role]'); if (!b) return;
      const role = b.dataset.role, t = typeOfRow(b), pm = AppState.planMarkup;
      if (role === 'close') { close(); return; }
      if (role === 'add') {
        const id = 'lt_' + Date.now().toString(36), n = this.list().length + 1;
        pm.loadTypes.push({ id, name: 'Load ' + n, letter: 'L', color: ['#a855f7', '#f59e0b', '#ef4444', '#22c55e', '#14b8a6'][n % 5],
          kw: 10, volt: 400, phases: 3, pf: 0.85, diversity: 1, start: 'DOL', duty: 'Continuous', supply: { minisub: true, kiosk: true } });
        const ly = pm.layers.find(l => l.id === 'loads');
        if (ly && !ly.visibleElementTypes.includes('load:' + id)) ly.visibleElementTypes.push('load:' + id);
        open.add(id);
      } else if (t && role === 'open') { open.has(t.id) ? open.delete(t.id) : open.add(t.id); render(); return; }
      else if (t && role === 'del') {
        const n = Math.max(pm.elements.filter(x => x.type === 'load' && x.props && x.props.loadType === t.id).length,
          this.rows().filter(r => r.row.loadType === t.id).length);
        if (n) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(`${n} placed ${t.name} load${n === 1 ? '' : 's'} use this type. Delete them first.`, 'warn'); return; }
        pm.loadTypes = pm.loadTypes.filter(x => x !== t);
        pm.layers.forEach(l => { l.visibleElementTypes = (l.visibleElementTypes || []).filter(k => k !== 'load:' + t.id); });
      } else return;
      changed(true); render();
    });
    overlay.addEventListener('input', (e) => {
      const t = typeOfRow(e.target); if (!t) return;
      const v = e.target.value, role = e.target.dataset.role;
      if (role === 'name') t.name = v || 'Load';
      else if (role === 'color') { t.color = v; e.target.closest('[data-type]').style.setProperty('--lc', v); }
      else if (role === 'letter') t.letter = v;
      else if (role === 'kw') t.kw = Math.max(0.1, parseFloat(v) || 0.1);
      else if (role === 'eff') t.eff = Math.min(0.99, Math.max(0.5, parseFloat(v) || 0.93));
      else if (role === 'lrc') t.lrc = Math.min(12, Math.max(2, parseFloat(v) || 6));
      else if (role === 'lrtPct') t.lrtPct = Math.min(400, Math.max(50, parseFloat(v) || 150));
      else if (role === 'rpm') t.rpm = Math.max(0, parseFloat(v) || 0);
      else if (role === 'diversity') t.diversity = Math.min(1, Math.max(0.05, parseFloat(v) || 1));
      else if (role === 'pf') t.pf = Math.min(1, Math.max(0.3, parseFloat(v) || 0.85));
      else return;
      changed(false);
    });
    overlay.addEventListener('change', (e) => {
      const t = typeOfRow(e.target); if (!t) return;
      const role = e.target.dataset.role;
      if (role === 'volt') t.volt = +e.target.value;
      else if (role === 'phases') t.phases = +e.target.value;
      else if (role === 'start') t.start = e.target.value;
      else if (role === 'duty') t.duty = e.target.value;
      else if (role === 'motor') t.motor = e.target.checked;
      else if (role === 'supply') t.supply[e.target.dataset.k] = e.target.checked;
      changed(true); render();
    });
    render();
    document.body.appendChild(overlay);
  },
};
