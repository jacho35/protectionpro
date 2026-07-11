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
      if (e.target.closest('[data-role="delete"]')) { PlanMarkup.deleteSelected(); return; }
      if (e.target.closest('[data-role="bulk-assign"]')) { this._bulkAssign(); return; }
      if (e.target.closest('[data-role="sync-circuits"]')) { this._syncCircuits(); return; }
    });
  },

  // ─── Palette ───
  // kind → the tool id that draws it; disabled until that tool is registered.
  _toolFor(kind) {
    return { element: 'place', route: 'route', trench: 'trench',
      crossing: 'crossing', text: 'text', measurement: 'measurement', room: 'room' }[kind];
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
    // "From SLD": adopt existing SLD boards/supply that aren't on the plan yet.
    if (domain === 'building' && typeof AppState.components !== 'undefined' && PLAN_DEFS.sldLinkTypes) {
      const linkedSld = new Set(pm.elements.filter(e => e.sldId).map(e => e.sldId));
      // Non-bus linkable comps (DB, transformer, generator, utility) individually.
      const rows = [];
      for (const c of AppState.components.values()) {
        if (!PLAN_DEFS.sldLinkTypes[c.type] || c.type === 'bus' || linkedSld.has(c.id)) continue;
        const t = PLAN_DEFS.sldLinkTypes[c.type];
        const typeName = (typeof COMPONENT_DEFS !== 'undefined' && COMPONENT_DEFS[c.type] && COMPONENT_DEFS[c.type].name) || c.type;
        rows.push({ id: c.id, label: c.props.name || typeName, sub: typeName, color: PLAN_DEFS.elementColor(t, pm.styles) });
      }
      // Buses grouped into switchboards — one row per group.
      if (typeof PlanSync !== 'undefined' && PlanSync.sldSwitchboardGroups) {
        for (const g of PlanSync.sldSwitchboardGroups()) {
          if (g.busIds.some(id => linkedSld.has(id))) continue;   // already adopted
          rows.push({ id: g.primaryBusId, label: g.name, sub: `Switchboard${g.busIds.length > 1 ? ' · ' + g.busIds.length + ' sections' : ''}`, color: PLAN_DEFS.elementColor('bd_switchboard', pm.styles) });
        }
      }
      html += `<div class="plan-fromsld"><div class="plan-layers-title">From SLD (unplaced)</div>`;
      if (!rows.length) {
        html += `<div class="plan-props-empty" style="padding:2px 2px 6px">No unplaced SLD boards.</div>`;
      } else {
        for (const r of rows) {
          html += `<button class="plan-pal-item" data-sld="${escHtml(r.id)}" title="Place ${escHtml(r.label)} from the SLD">
            <span class="plan-pal-swatch" style="background:${r.color}"></span>${escHtml(r.label)}
            <span style="color:var(--text-muted);font-size:10px;margin-left:auto">${escHtml(r.sub)}</span></button>`;
        }
      }
      html += `</div>`;
    }

    // Discipline layers: click a name to emphasize that layer (dim the rest);
    // "Show all" clears the active layer.
    // Show only the layers relevant to the active domain.
    const domLayers = pm.layers.filter(L => domain === 'building'
      ? L.discipline === 'building' : L.discipline !== 'building');
    html += `<div class="plan-layers"><div class="plan-layers-title">Discipline Layers</div>`;
    html += `<div class="plan-layer-row${pm.activeLayerId ? '' : ' active'}"><span class="swatch" style="background:#94a3b8"></span><span class="plan-layer-name" data-layer="">Show all</span></div>`;
    for (const L of domLayers) {
      html += `<div class="plan-layer-row${pm.activeLayerId === L.id ? ' active' : ''}">
        <span class="swatch" style="background:${L.color}"></span>
        <span class="plan-layer-name" data-layer="${escHtml(L.id)}">${escHtml(L.name)}</span></div>`;
    }
    html += `</div>`;
    // Background plans: visibility, opacity, PDF page-nav, remove.
    html += `<div class="plan-plans"><div class="plan-layers-title">Background Plans
      <button class="plan-cleanup-btn" data-role="cleanup" title="Delete unclaimed/orphaned plan images on the server">Clean</button></div>`;
    if (!pm.plans.length) html += `<div class="plan-props-empty" style="padding:2px">No plan imported.</div>`;
    for (const P of pm.plans) {
      const nav = (P.pdfPageCount > 1)
        ? `<span class="plan-pagenav"><button data-role="prev" data-plan="${escHtml(P.id)}">◀</button>${P.pdfPage}/${P.pdfPageCount}<button data-role="next" data-plan="${escHtml(P.id)}">▶</button></span>` : '';
      html += `<div class="plan-plan-row">
        <label class="plan-plan-vis"><input type="checkbox" data-role="vis" data-plan="${escHtml(P.id)}" ${P.visible === false ? '' : 'checked'}></label>
        <span class="plan-plan-name" title="${escHtml(P.name)}">${escHtml(P.name)}</span>
        ${nav}
        <input type="range" class="plan-plan-op" data-role="opacity" data-plan="${escHtml(P.id)}" min="0.1" max="1" step="0.1" value="${(typeof P.opacity === 'number' ? P.opacity : 1)}">
        <button class="plan-plan-mini" data-role="move-plan" data-plan="${escHtml(P.id)}" title="Drag to reposition this plan">✥</button>
        <button class="plan-plan-mini" data-role="align-plan" data-plan="${escHtml(P.id)}" title="2-point align this plan to the others">⤢</button>
        <button class="plan-plan-del" data-role="remove-plan" data-plan="${escHtml(P.id)}" title="Remove from project">✕</button>
      </div>`;
    }
    html += `</div>`;
    el.innerHTML = html;
  },

  _planById(id) { return AppState.planMarkup.plans.find(p => p.id === id); },

  async _cleanup() {
    try {
      const resp = await fetch(`${API_BASE}/plan-images/cleanup`, { method: 'POST' });
      const j = await resp.json();
      UI.toast(`Cleaned ${j.deleted != null ? j.deleted : 0} orphaned plan image(s).`, 'success');
    } catch (e) {
      UI.toast('Cleanup failed: ' + (e && e.message ? e.message : e), 'error');
    }
  },

  _onPaletteInput(e) {
    const role = e.target.dataset.role;
    if (role === 'search') {
      this._search = e.target.value;
      this.renderPalette();
      // Re-render replaced the input — restore focus + caret to end.
      const box = this.paletteEl.querySelector('[data-role="search"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    } else if (role === 'opacity') {
      const p = this._planById(e.target.dataset.plan);
      if (p) { p.opacity = parseFloat(e.target.value); PlanEngine.requestDraw({ bg: true }); }
    }
  },

  _onPaletteClick(e) {
    // Plan controls (page nav / remove / cleanup)
    const planCtl = e.target.closest('[data-role]');
    if (planCtl) {
      const role = planCtl.dataset.role;
      if (role === 'cleanup') { this._cleanup(); return; }
      const p = planCtl.dataset.plan && this._planById(planCtl.dataset.plan);
      if (role === 'remove-plan' && p) {
        const pm = AppState.planMarkup;
        pm.plans = pm.plans.filter(x => x.id !== p.id);
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
        this.renderPalette(); PlanEngine.requestDraw({ all: true });
        return;
      }
      if (role === 'move-plan' && p) { PlanTools.set('nudgeplan', { planId: p.id }); return; }
      if (role === 'align-plan' && p) { PlanTools.set('align', { planId: p.id }); return; }
      if ((role === 'prev' || role === 'next') && p) {
        const np = Math.min(p.pdfPageCount || 1, Math.max(1, (p.pdfPage || 1) + (role === 'next' ? 1 : -1)));
        if (np !== p.pdfPage && typeof PlanImages !== 'undefined') {
          PlanImages.renderPdfPage(p, np).then(() => this.renderPalette());
        }
        return;
      }
    }
    const layerName = e.target.closest('.plan-layer-name');
    if (layerName) {
      AppState.planMarkup.activeLayerId = layerName.dataset.layer || null;
      this.renderPalette();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
      return;
    }
    // Adopt an existing SLD entity ("From SLD" list) — link + place it.
    const sldItem = e.target.closest('[data-sld]');
    if (sldItem) {
      PlanTools.set('placeSld', { sldId: sldItem.dataset.sld });
      this.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
      sldItem.classList.add('armed');
      return;
    }
    const domainSel = e.target.closest('[data-role="domain"]');
    if (domainSel) return; // domain change handled by the 'change' listener
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

  // Palette 'change' handling: domain select + per-plan visibility checkbox.
  bindDomainChange() {
    this.paletteEl.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'domain') {
        AppState.planMarkup.settings.domain = e.target.value;
        this.renderPalette();
        if (typeof PlanMarkup !== 'undefined' && PlanMarkup.updatePushButton) PlanMarkup.updatePushButton();
        if (typeof PlanMarkup !== 'undefined' && PlanMarkup.refreshFloorBar) PlanMarkup.refreshFloorBar();
      } else if (role === 'vis') {
        const p = this._planById(e.target.dataset.plan);
        if (p) { p.visible = e.target.checked; PlanEngine.requestDraw({ bg: true }); }
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
      fields = ((def && def.fields) || []).concat([{ key: 'curved', label: 'Curved', type: 'checkbox' }]);
      getVal = (k) => (k === 'cableType') ? item.cableType : (k === 'curved') ? !!item.curved : (item.props ? item.props[k] : undefined);
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
    } else if (kind === 'room') {
      const f = PlanEngine.factor();
      const area = f ? (PlanEngine._polyArea(item.points) * f * f) : null;
      title = 'Room / Area' + (area != null ? ` — ${area.toFixed(1)} m²` : '');
      fields = PLAN_DEFS.room.fields;
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
    // Building auto-circuiting: circuit-tag editor on load devices; bulk-assign
    // on distribution boards.
    if (kind === 'element' && typeof PlanCircuits !== 'undefined' &&
        AppState.planMarkup.settings.domain === 'building') {
      if (PlanCircuits.isLoadDevice(item.type)) html += this._circuitTag(item);
      else if (item.type === 'bd_db') html += this._boardCircuits(item);
    }
    // Delete button
    html += `<button class="plan-props-delete" data-role="delete">Delete</button>`;
    el.innerHTML = html;
  },

  // Circuit-tag editor for a load device: pick a board + way number. The board
  // <select> and way write to props.circuitDbId / props.circuitNo (persisted +
  // read by PlanCircuits.syncLoads).
  _circuitTag(item) {
    const boards = PlanCircuits.boardEls();
    const p = item.props || {};
    const cur = p.circuitDbId || '';
    const opts = ['<option value="">— unassigned —</option>']
      .concat(boards.map(b => `<option value="${escHtml(b.id)}" ${b.id === cur ? 'selected' : ''}>${escHtml(b.name)}</option>`))
      .join('');
    const va = PlanCircuits.deviceVA(item);
    return `<div class="plan-circuit-box">
      <div class="plan-circuit-h">Circuit</div>
      <div class="plan-field"><label class="plan-field-label">Board</label>
        <select data-key="circuitDbId">${opts}</select></div>
      <div class="plan-field"><label class="plan-field-label">Way (circuit no.)</label>
        <input type="number" min="1" step="1" data-key="circuitNo" value="${escHtml(p.circuitNo != null ? p.circuitNo : '')}"></div>
      <div class="plan-circuit-note">Load: ${va} VA${boards.length ? '' : ' — place a Distribution Board first'}</div>
    </div>`;
  },

  // Distribution-board panel: way count + one-click auto-distribute of connected
  // untagged devices, and a re-sync of loads from the plan.
  _boardCircuits(item) {
    const comp = item.sldId && AppState.components.get(item.sldId);
    const ways = (comp && Array.isArray(comp.props.circuits)) ? comp.props.circuits.length : 0;
    const linked = comp ? '' : ' <span class="plan-circuit-note">(sync with the SLD to create its schedule)</span>';
    return `<div class="plan-circuit-box">
      <div class="plan-circuit-h">Circuits</div>
      <div class="plan-circuit-note">${ways} way(s) on this board${linked}</div>
      <button class="plan-circuit-btn" data-role="bulk-assign">⚡ Auto-assign connected devices</button>
      <button class="plan-circuit-btn" data-role="sync-circuits">🔄 Sync loads from plan</button>
    </div>`;
  },

  _field(f, value) {
    const v = (value == null) ? '' : value;
    const label = `<label class="plan-field-label">${escHtml(f.label)}${f.unit ? ` <span class="plan-field-unit">(${escHtml(f.unit)})</span>` : ''}</label>`;
    if (f.type === 'checkbox') {
      return `<div class="plan-field plan-field-check"><label><input type="checkbox" data-key="${f.key}" ${value ? 'checked' : ''}> ${escHtml(f.label)}</label></div>`;
    }
    if (f.type === 'cable_select') {
      return `<div class="plan-field">${label}<select data-key="${f.key}">${this._cableOptions(v, f)}</select></div>`;
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

  // Build <option>s for a cable_select field. Building routes draw from the
  // specialised BUILDING_CABLES library (grouped by category, filtered by the
  // field's `category` list); reticulation routes use the central
  // STANDARD_CABLES library grouped LV/MV by voltage.
  _cableOptions(selectedName, field) {
    field = field || {};
    const opt = (name) => `<option value="${escHtml(name)}" ${selectedName === name ? 'selected' : ''}>${escHtml(name)}</option>`;
    let html = '<option value="">— select —</option>';
    if (field.library === 'building' && typeof BUILDING_CABLES !== 'undefined') {
      const cats = field.category || null;
      const groups = {};
      for (const c of BUILDING_CABLES) {
        if (cats && !cats.includes(c.category)) continue;
        (groups[c.category] = groups[c.category] || []).push(c.name);
      }
      // Preserve the field's category order, then any extras.
      const order = cats || Object.keys(groups);
      for (const cat of order) {
        if (!groups[cat]) continue;
        html += `<optgroup label="${escHtml(cat)}">${groups[cat].map(opt).join('')}</optgroup>`;
      }
      return html;
    }
    // Reticulation (STANDARD_CABLES) — LV/MV by voltage.
    const voltage = field.voltage;
    let list = STANDARD_CABLES;
    if (voltage === 'lv') list = STANDARD_CABLES.filter(c => !(c.voltage_kv > 1));
    else if (voltage === 'mv') list = STANDARD_CABLES.filter(c => c.voltage_kv > 1);
    const lv = list.filter(c => !(c.voltage_kv > 1)).map(c => opt(c.name)).join('');
    const mv = list.filter(c => c.voltage_kv > 1).map(c => opt(c.name)).join('');
    return html
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
    if (e.target.type === 'checkbox') val = e.target.checked;

    const oldName = item.name;
    if (kind === 'element') {
      if (key === 'name' || key === 'rotation') item[key] = val;
      else { item.props = item.props || {}; item.props[key] = val; }
      if (key === 'name' && typeof PlanSync !== 'undefined' && PlanSync.onElementRenamed) {
        PlanSync.onElementRenamed(item, oldName, val);
      }
      // Circuit tag changed → refresh the board schedule (on commit, not every
      // keystroke) and re-render the panel's load readout.
      if ((key === 'circuitDbId' || key === 'circuitNo') && e.type === 'change' &&
          typeof PlanCircuits !== 'undefined') {
        if (!val) { if (key === 'circuitDbId') { delete item.props.circuitNo; } }
        PlanCircuits.syncLoads();
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
        this.renderProps();
        return;
      }
    } else if (kind === 'route') {
      if (key === 'cableType') item.cableType = val;
      else if (key === 'curved') item.curved = val;
      else { item.props = item.props || {}; item.props[key] = val; }
    } else {
      item[key] = val;
    }
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
  },

  // Auto-distribute the selected board's connected untagged devices into ways.
  _bulkAssign() {
    const ids = [...PlanMarkup.selectedIds]; if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found || found.kind !== 'element' || found.item.type !== 'bd_db') return;
    if (!found.item.sldId || !AppState.components.get(found.item.sldId)) {
      UI.toast('Sync this board with the SLD first (it needs a circuit schedule).', 'info'); return;
    }
    const r = PlanCircuits.bulkAssign(found.item.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this.renderProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    UI.toast(r.devices ? `Assigned ${r.devices} device(s) across ${r.ways} new way(s).` : 'No unassigned connected devices found.', r.devices ? 'success' : 'info');
  },

  // Re-count loads + routed lengths from the plan into every linked board.
  _syncCircuits() {
    const s = PlanCircuits.syncAll();
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this.renderProps();
    UI.toast(`Synced ${s.ways} way(s) on ${s.boards} board(s) from ${s.devices} device(s).` +
      (s.unsynced ? ` ${s.unsynced} board(s) not yet on the SLD.` : ''), 'success');
  },
};
