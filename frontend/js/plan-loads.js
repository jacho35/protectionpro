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
 * Markup only: nothing here changes Demand, the single line or any study.
 */
const PlanLoads = {
  VOLTS: [230, 400, 525, 690],
  STARTS: ['DOL', 'Star-delta', 'Soft starter', 'VFD'],
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
    return t ? t.kw : 0;
  },
  amps(el) {
    const t = this.typeOf(el); if (!t) return null;
    const kw = this.kw(el);
    if (!(kw > 0) || !(t.volt > 0) || !(t.pf > 0)) return null;
    return Math.round(kw * 1000 / ((t.phases === 3 ? Math.sqrt(3) : 1) * t.volt * t.pf) * 10) / 10;
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
    return { loadType: typeId, kw: '', fedFrom: s ? s.id : '', cableType: '' };
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
      const bits = [`${this.kw(item)} kW`, `${t.volt} V ${t.phases}φ`, `pf ${t.pf}`, a != null ? `≈ ${a} A` : '', t.start, t.duty].filter(Boolean);
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
          <div class="ply-sub">${t.kw} kW · ${t.volt} V ${t.phases}φ · pf ${t.pf} · ${escHtml(t.start)} · ${escHtml(t.duty)} · fed from ${sup} · ${used(t.id)} placed</div>
          ${isOpen ? `<div class="ply-body ply-form">
            <label>Symbol letter<input type="text" maxlength="2" value="${escHtml(t.letter)}" data-role="letter"></label>
            <label>Rated power (kW)<input type="number" min="0.1" step="0.1" value="${t.kw}" data-role="kw"></label>
            <label>Voltage (V)${sel('volt', this.VOLTS, t.volt)}</label>
            <label>Phases${sel('phases', [1, 3], t.phases)}</label>
            <label>Power factor<input type="number" min="0.3" max="1" step="0.01" value="${t.pf}" data-role="pf"></label>
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
          <p class="ply-help">Define a load once, then place as many as you need from the <b>Loads</b> group in the parts list. Each one is fed from a mini-sub or kiosk and draws a supply cable to it. Loads are markup on the plan; they don't change Demand.</p>
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
          kw: 10, volt: 400, phases: 3, pf: 0.85, start: 'DOL', duty: 'Continuous', supply: { minisub: true, kiosk: true } });
        const ly = pm.layers.find(l => l.id === 'loads');
        if (ly && !ly.visibleElementTypes.includes('load:' + id)) ly.visibleElementTypes.push('load:' + id);
        open.add(id);
      } else if (t && role === 'open') { open.has(t.id) ? open.delete(t.id) : open.add(t.id); render(); return; }
      else if (t && role === 'del') {
        const n = pm.elements.filter(x => x.type === 'load' && x.props && x.props.loadType === t.id).length;
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
      else if (role === 'supply') t.supply[e.target.dataset.k] = e.target.checked;
      changed(true); render();
    });
    render();
    document.body.appendChild(overlay);
  },
};
