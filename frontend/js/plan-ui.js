/* ProtectionPro — Plan Markup palette + properties panel.
 *
 * Both are driven entirely by PLAN_DEFS: the palette lists the entity types
 * for the active domain (click-to-arm, touch-friendly — a deliberate departure
 * from the SLD sidebar's drag-drop), and the properties panel renders each
 * selected entity's declarative `fields[]` the way properties.js does for SLD
 * components.
 */

const PlanUI = {
  paletteEl: null, propsEl: null,

  init(paletteEl, propsEl) {
    this.paletteEl = paletteEl;
    this.propsEl = propsEl;
    paletteEl.addEventListener('click', (e) => this._onPaletteClick(e));
    paletteEl.addEventListener('input', (e) => this._onPaletteInput(e));
    propsEl.addEventListener('change', (e) => this._onPropsChange(e));
    propsEl.addEventListener('input', (e) => this._onPropsChange(e));
    propsEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="delete"]')) PlanMarkup.deleteSelected();
    });
  },

  // ─── Palette ───
  // kind → the tool id that draws it; disabled until that tool is registered.
  _toolFor(kind) {
    return { element: 'place', route: 'route', trench: 'trench',
      crossing: 'crossing', text: 'text', measurement: 'measurement' }[kind];
  },

  renderPalette() {
    const el = this.paletteEl; if (!el) return;
    const pm = AppState.planMarkup;
    const domain = pm.settings.domain || 'retic';
    const filter = (this._search || '').toLowerCase();
    const groups = PLAN_DEFS.paletteGroups(domain);
    let html = `
      <div class="plan-pal-header">
        <select class="plan-domain-select" data-role="domain">
          ${PLAN_DOMAINS.map(d => `<option value="${d.id}" ${d.id === domain ? 'selected' : ''}>${escHtml(d.name)}</option>`).join('')}
        </select>
        <input type="search" class="plan-pal-search" data-role="search" placeholder="Filter…" value="${escHtml(this._search || '')}">
      </div>`;
    for (const g of groups) {
      const items = g.items.filter(it => !filter || it.name.toLowerCase().includes(filter));
      if (!items.length) continue;
      html += `<div class="plan-pal-group"><div class="plan-pal-group-label">${escHtml(g.label)}</div>`;
      for (const it of items) {
        const toolId = this._toolFor(it.kind);
        const ready = typeof PlanTools !== 'undefined' && PlanTools._tools[toolId];
        html += `<button class="plan-pal-item${ready ? '' : ' disabled'}" data-kind="${it.kind}" data-type="${escHtml(it.type)}"${ready ? '' : ' title="Coming in a later phase" disabled'}>
          <span class="plan-pal-swatch" style="background:${it.color}"></span>${escHtml(it.name)}</button>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  },

  _onPaletteInput(e) {
    const role = e.target.dataset.role;
    if (role === 'search') {
      this._search = e.target.value;
      this.renderPalette();
      // Re-render replaced the input — restore focus + caret to end.
      const box = this.paletteEl.querySelector('[data-role="search"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
  },

  _onPaletteClick(e) {
    const domainSel = e.target.closest('[data-role="domain"]');
    if (domainSel) return; // handled on change below via input? use change:
    const item = e.target.closest('.plan-pal-item');
    if (!item || item.disabled) return;
    const kind = item.dataset.kind, type = item.dataset.type;
    const toolId = this._toolFor(kind);
    if (kind === 'element') PlanTools.set('place', { type });
    else if (kind === 'route') PlanTools.set('route', { type });
    else if (kind === 'trench') PlanTools.set('trench', { type });
    else PlanTools.set(toolId, { type });
    // Highlight the armed item
    this.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
    item.classList.add('armed');
  },

  // domain change (select fires 'change', bubbles to palette 'input' too;
  // handle explicitly here)
  bindDomainChange() {
    this.paletteEl.addEventListener('change', (e) => {
      if (e.target.dataset.role === 'domain') {
        AppState.planMarkup.settings.domain = e.target.value;
        this.renderPalette();
      }
    });
  },

  // ─── Properties ───
  renderProps() {
    const el = this.propsEl; if (!el) return;
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length === 0) { el.innerHTML = `<div class="plan-props-empty">Select an item to edit its properties.</div>`; return; }
    if (ids.length > 1) { el.innerHTML = `<div class="plan-props-empty">${ids.length} items selected.</div>`; return; }
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found) { el.innerHTML = ''; return; }
    const { kind, item } = found;
    let fields = [], title = '', getVal;
    if (kind === 'element') {
      const def = PLAN_DEFS.element(item.type);
      title = def ? def.name : item.type;
      fields = (def && def.fields) || [];
      getVal = (k) => (k === 'name' || k === 'rotation') ? item[k] : (item.props ? item.props[k] : undefined);
    } else if (kind === 'route') {
      const def = PLAN_DEFS.route(item.type);
      title = def ? def.name : item.type;
      fields = (def && def.fields) || [];
      getVal = (k) => (k === 'cableType') ? item.cableType : (item.props ? item.props[k] : undefined);
    } else if (kind === 'trench') {
      title = (PLAN_DEFS.trenchTypes[item.excType] || {}).name || 'Trench';
      fields = [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'excType', label: 'Type', type: 'select', options: Object.keys(PLAN_DEFS.trenchTypes).map(k => ({ value: k, label: PLAN_DEFS.trenchTypes[k].name })) },
      ];
      getVal = (k) => item[k];
    } else if (kind === 'crossing') {
      title = 'Road Crossing';
      fields = [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'size', label: 'Duct (mm)', type: 'select', options: PLAN_DEFS.crossings.sizes.map(s => ({ value: s, label: s })) },
      ];
      getVal = (k) => item[k];
    } else if (kind === 'text') {
      title = 'Text';
      fields = PLAN_DEFS.annotations.text.fields;
      getVal = (k) => item[k === 'fontSize' ? 'fontSize' : k];
    } else {
      el.innerHTML = ''; return;
    }
    let html = `<div class="plan-props-title">${escHtml(title)}</div>`;
    for (const f of fields) html += this._field(f, getVal(f.key));
    // Delete button
    html += `<button class="plan-props-delete" data-role="delete">Delete</button>`;
    el.innerHTML = html;
  },

  _field(f, value) {
    const v = (value == null) ? '' : value;
    const label = `<label class="plan-field-label">${escHtml(f.label)}${f.unit ? ` <span class="plan-field-unit">(${escHtml(f.unit)})</span>` : ''}</label>`;
    if (f.type === 'cable_select') {
      return `<div class="plan-field">${label}<select data-key="${f.key}">${this._cableOptions(v, f.voltage)}</select></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${escHtml(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('');
      return `<div class="plan-field">${label}<select data-key="${f.key}">${opts}</select></div>`;
    }
    if (f.type === 'number') {
      const attrs = [f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '', f.step != null ? `step="${f.step}"` : ''].join(' ');
      return `<div class="plan-field">${label}<input type="number" data-key="${f.key}" value="${escHtml(v)}" ${attrs}></div>`;
    }
    return `<div class="plan-field">${label}<input type="text" data-key="${f.key}" value="${escHtml(v)}"></div>`;
  },

  _cableOptions(selectedName, voltage) {
    const opt = (c) => `<option value="${escHtml(c.name)}" ${selectedName === c.name ? 'selected' : ''}>${escHtml(c.name)}</option>`;
    let list = STANDARD_CABLES;
    if (voltage === 'lv') list = STANDARD_CABLES.filter(c => !(c.voltage_kv > 1));
    else if (voltage === 'mv') list = STANDARD_CABLES.filter(c => c.voltage_kv > 1);
    const lv = list.filter(c => !(c.voltage_kv > 1)).map(opt).join('');
    const mv = list.filter(c => c.voltage_kv > 1).map(opt).join('');
    return '<option value="">— select —</option>'
      + (lv ? `<optgroup label="LV (≤1 kV)">${lv}</optgroup>` : '')
      + (mv ? `<optgroup label="MV">${mv}</optgroup>` : '');
  },

  _onPropsChange(e) {
    if (e.target.dataset && e.target.dataset.role === 'delete') return;
    const key = e.target.dataset ? e.target.dataset.key : null;
    if (!key) return;
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found) return;
    const { kind, item } = found;
    let val = e.target.value;
    if (e.target.type === 'number') val = parseFloat(val) || 0;

    const oldName = item.name;
    if (kind === 'element') {
      if (key === 'name' || key === 'rotation') item[key] = val;
      else { item.props = item.props || {}; item.props[key] = val; }
      if (key === 'name' && typeof PlanSync !== 'undefined' && PlanSync.onElementRenamed) {
        PlanSync.onElementRenamed(item, oldName, val);
      }
    } else if (kind === 'route') {
      if (key === 'cableType') item.cableType = val;
      else { item.props = item.props || {}; item.props[key] = val; }
    } else {
      item[key] = val;
    }
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
  },
};
