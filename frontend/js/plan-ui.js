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
      const pick = e.target.closest('[data-plan-select]');
      if (pick) { PlanMarkup.selectOnly(pick.dataset.planSelect); PlanEngine.requestDraw({ fg: true }); return; }
      if (e.target.closest('[data-role="edit-schedule"]')) { this._editBoardSchedule(); return; }
      if (e.target.closest('[data-role="bulk-assign"]')) { this._bulkAssign(); return; }
      if (e.target.closest('[data-role="sync-circuits"]')) { this._syncCircuits(); return; }
      if (e.target.closest('[data-role="import-ies"]')) { this._importIes(); return; }
      if (e.target.closest('[data-role="balance-phases"]')) { this._balancePhases(); return; }
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
    // The project type normally fixes the plan's domain (workspaces.js); the
    // selector only appears when it doesn't — a Network project with a plan,
    // or a plan whose content is the other domain's.
    const domainLocked = typeof Workspaces !== 'undefined' && Workspaces.planDomainLocked && Workspaces.planDomainLocked();
    let html = `
      <div class="plan-pal-header">
        ${domainLocked ? '' : `<label class="plan-domain-field" title="Plan type — Site reticulation or Building floor plan">
          <span class="plan-domain-cap">Plan type</span>
          <select class="plan-domain-select" data-role="domain" aria-label="Plan type"
            title="Plan type — Site reticulation or Building floor plan">
            ${PLAN_DOMAINS.map(d => `<option value="${d.id}" ${d.id === domain ? 'selected' : ''}>${escHtml(d.name)}</option>`).join('')}
          </select>
        </label>`}
        <input type="search" class="plan-pal-search" data-role="search" placeholder="Filter…" value="${escHtml(this._search || '')}" aria-label="Filter parts">
      </div>`;
    // Placement mode (building only): Single drop / grid Array / along a Path.
    if (domain === 'building') {
      const mode = this._placeMode || 'single';
      const modeBtn = (m, label, title) => `<button class="plan-pal-mode-btn${mode === m ? ' active' : ''}" data-role="placemode" data-mode="${m}" title="${title}">${label}</button>`;
      html += `<div class="plan-pal-mode" role="group" aria-label="Placement mode">
        ${modeBtn('single', 'Single', 'Drop one device per click')}
        ${modeBtn('array', 'Array', 'Drag a rectangle → grid of devices')}
        ${modeBtn('path', 'Path', 'Draw a path → devices spaced along it')}
      </div>`;
    }
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
    const dxfs = (typeof PlanDxfImport !== 'undefined') ? PlanDxfImport.list() : [];
    if (!pm.plans.length && !dxfs.length) html += `<div class="plan-props-empty" style="padding:2px">No plan imported.</div>`;
    // Imported DXF drawings are background layers of this floor too.
    for (const D of dxfs) {
      const loaded = !!PlanDxfImport.dataOf(D);
      const id = escHtml(D.id);
      html += `<div class="plan-plan-row">
        <label class="plan-plan-vis"><input type="checkbox" data-role="dxf-vis" data-dxf="${id}" ${D.hidden ? '' : 'checked'}></label>
        <span class="plan-plan-name" title="${escHtml(D.name)} (DXF) — ${D.count} items${loaded ? '' : ' — loading…'}">📐 ${escHtml(D.name)}</span>
        <input type="range" class="plan-plan-op" data-role="dxf-opacity" data-dxf="${id}" min="0.1" max="1" step="0.1" value="${(typeof D.opacity === 'number' ? D.opacity : 1)}">
        <button class="plan-plan-mini" data-role="dxf-manage" data-dxf="${id}" title="Layers, blocks &amp; attributes — convert to plan items"${loaded ? '' : ' disabled'}>◫</button>
        <button class="plan-plan-mini" data-role="dxf-move" data-dxf="${id}" title="Drag to reposition this DXF">✥</button>
        <button class="plan-plan-mini" data-role="dxf-align" data-dxf="${id}" title="2-point align this DXF${D.unitM ? ' (keeps its true scale)' : ''}">⤢</button>
        <button class="plan-plan-del" data-role="remove-dxf" data-dxf="${id}" title="Remove this DXF from the floor">✕</button>
      </div>`;
    }
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
      const resp = await fetch(`${API_BASE}/plan-images/cleanup`, { method: 'POST', headers: API.authHeaders() });
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
    } else if (role === 'dxf-opacity') {
      const d = PlanDxfImport.byId(e.target.dataset.dxf);
      if (d) { d.opacity = parseFloat(e.target.value); PlanMarkup.markDirty(); PlanEngine.requestDraw({ bg: true }); }
    }
  },

  _onPaletteClick(e) {
    // Plan controls (page nav / remove / cleanup)
    const planCtl = e.target.closest('[data-role]');
    if (planCtl) {
      const role = planCtl.dataset.role;
      if (role === 'cleanup') { this._cleanup(); return; }
      const dxf = planCtl.dataset.dxf && (typeof PlanDxfImport !== 'undefined') && PlanDxfImport.byId(planCtl.dataset.dxf);
      if (role === 'remove-dxf' && dxf) {
        PlanDxfImport.remove(dxf.id);
        this.renderPalette();
        UI.toast(`DXF "${dxf.name}" removed — press Ctrl+Z or ↶ to undo.`, 'info');
        return;
      }
      if (role === 'dxf-manage' && dxf && typeof PlanDxfManager !== 'undefined') { PlanDxfManager.open(dxf.id); return; }
      if (role === 'dxf-move' && dxf) { PlanTools.set('nudgeplan', { dxfId: dxf.id }); return; }
      if (role === 'dxf-align' && dxf) { PlanTools.set('align', { dxfId: dxf.id, keepScale: !!dxf.unitM }); return; }
      const p = planCtl.dataset.plan && this._planById(planCtl.dataset.plan);
      if (role === 'remove-plan' && p) {
        const pm = AppState.planMarkup;
        pm.plans = pm.plans.filter(x => x.id !== p.id);
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
        this.renderPalette(); PlanEngine.requestDraw({ all: true });
        // Removal is undoable (image bytes stay server-side) — surface how (UX-13).
        UI.toast('Background plan removed — press Ctrl+Z or ↶ to undo.', 'info');
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
    // Placement-mode segmented control (Single / Array / Path).
    const modeBtn = e.target.closest('[data-role="placemode"]');
    if (modeBtn) {
      this._placeMode = modeBtn.dataset.mode;
      this.paletteEl.querySelectorAll('[data-role="placemode"]').forEach(b => b.classList.toggle('active', b === modeBtn));
      return;
    }
    const item = e.target.closest('.plan-pal-item');
    if (!item || item.disabled) return;
    const kind = item.dataset.kind, type = item.dataset.type;
    const toolId = this._toolFor(kind);
    if (kind === 'element') {
      // Point-device placement honours the selected mode.
      const byMode = { single: 'place', array: 'array', path: 'devpath' };
      PlanTools.set(byMode[this._placeMode || 'single'] || 'place', { type });
    }
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
        if (typeof Workspaces !== 'undefined' && Workspaces.refresh) Workspaces.refresh();
        if (typeof PlanMarkup !== 'undefined' && PlanMarkup.updatePushButton) PlanMarkup.updatePushButton();
        if (typeof PlanMarkup !== 'undefined' && PlanMarkup.refreshFloorBar) PlanMarkup.refreshFloorBar();
      } else if (role === 'vis') {
        const p = this._planById(e.target.dataset.plan);
        if (p) { p.visible = e.target.checked; PlanEngine.requestDraw({ bg: true }); }
      } else if (role === 'dxf-vis') {
        const d = typeof PlanDxfImport !== 'undefined' && PlanDxfImport.byId(e.target.dataset.dxf);
        if (d) {
          d.hidden = !e.target.checked;
          if (typeof PlanMarkup !== 'undefined') PlanMarkup.markDirty();
          PlanEngine.requestDraw({ all: true });
        }
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
      fields = fields.concat([{ key: 'symScale', label: 'Symbol scale ×', type: 'number', min: 0.25, max: 10, step: 0.25 }]);
      getVal = (k) => (k === 'symScale') ? (item.scale || '') : (k === 'name' || k === 'rotation') ? item[k] : (item.props ? item.props[k] : undefined);
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
    } else if (kind === 'measurement') {
      // UX-11: a selected measurement now gets a titled panel (length readout +
      // the standard Delete button) instead of a blank pane.
      const len = (typeof PlanEngine !== 'undefined') ? PlanEngine._polyLen(item.points) : 0;
      title = 'Measurement — ' + ((typeof PlanEngine !== 'undefined') ? PlanEngine.lenLabel(len) : `${Math.round(len)} px`);
      fields = [];
      getVal = () => '';
    } else {
      el.innerHTML = ''; return;
    }
    let html = `<div class="plan-props-title">${escHtml(title)}</div>`;
    // UX-5: name the SLD counterpart on a linked plan element.
    if (kind === 'element' && item.sldId && typeof AppState.components !== 'undefined') {
      const comp = AppState.components.get(item.sldId);
      if (comp) html += `<div class="plan-linked-note" title="This item is linked to an SLD component">🔗 Linked to SLD: ${escHtml((comp.props && comp.props.name) || comp.type)}</div>`;
    }
    if (kind === 'route' && !item.cableType && typeof PlanSync !== 'undefined' && PlanSync.fillEmptyCables) {
      PlanSync.fillEmptyCables(); getVal = (k) => (k === 'cableType') ? item.cableType : (k === 'curved') ? !!item.curved : (item.props ? item.props[k] : undefined);
    }
    for (const f of fields) html += this._field(f, getVal(f.key));
    html += this._demandBlock(item, kind);
    html += this._demandLinkField(item, kind);
    html += this._sldLinkField(item, kind);
    // Building auto-circuiting: circuit-tag editor on load devices; bulk-assign
    // on distribution boards.
    if (kind === 'element' && typeof PlanCircuits !== 'undefined' &&
        AppState.planMarkup.settings.domain === 'building') {
      if (item.type === 'bd_db') html += this._boardCircuits(item);
      else if (PlanCircuits.isCircuitDevice(item.type)) html += this._circuitTag(item);
    }
    // Delete button
    html += `<button class="plan-props-delete" data-role="delete">Delete</button>`;
    el.innerHTML = html;
    this._searchifyCables(el);
  },

  // Cable dropdowns are wildcard type-to-filter boxes ("16 cu", "25*xlpe").
  _searchifyCables(root) {
    if (typeof SearchSelect === 'undefined') return;
    root.querySelectorAll('select[data-cable-select]').forEach(sel =>
      SearchSelect.attach(sel, { placeholder: 'No cable — type to search, e.g. 16 cu, 25*xlpe' }));
  },

  // Live read-out of the Reticulation (Demand) row behind a linked site-plan
  // element: computed from the current Demand data every time the panel is
  // drawn, and redrawn whenever Demand recomputes (Retic._doCompute) or the
  // Plan workspace is shown. Read-only — edit it in Demand.
  _demandBlock(item, kind) {
    if (kind === 'route') return this._demandRouteBlock(item);
    if (typeof Retic === 'undefined' || !AppState.reticulation) return '';
    if (kind !== 'element' || !['erf', 'kiosk', 'minisub'].includes(item.type)) return '';
    const R = AppState.reticulation, res = AppState.reticResults;
    const rows = [];
    const row = (k, v, cls) => rows.push(`<div class="plan-demand-row${cls ? ' ' + cls : ''}"><span>${escHtml(k)}</span><b>${v}</b></div>`);
    const num = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toString();
    const clsLabel = (k) => { const c = Retic._kioskClass(k); return c ? escHtml(c.label) : '—'; };
    let title = 'From Demand';
    let kioskList = null;
    const notLinked = () => `<div class="plan-demand"><div class="plan-demand-title">From Demand</div><div class="plan-demand-row"><span>Not in Demand yet — use → Push to Schedules.</span></div></div>`;
    // Figures for a kiosk / minisub come from the last Demand calculation; ask
    // for one if none has run this session (it redraws this panel when done).
    if (item.type !== 'erf' && !res && Retic._doCompute && !this._demandAsked) {
      this._demandAsked = true;
      Promise.resolve(Retic._doCompute()).finally(() => { this._demandAsked = false; });
    }
    if (item.type === 'erf') {
      let k = null, e = null;
      const nm = (item.name || '').trim().toLowerCase();
      for (const kk of R.kiosks) {
        const f = kk.erfs.find(x => item.reticId ? x.id === item.reticId : (nm && (x.erfNumber || '').trim().toLowerCase() === nm));
        if (f) { k = kk; e = f; break; }
      }
      if (!e) return notLinked();
      const is3 = Retic._erfIs3ph(k, e);
      const amps = Retic._erfDesignAmps(k, e);
      const vc = Retic._vdCalc(e.cableType, amps, e.length, is3);
      const limit = Retic.settings.maxRunVD;
      row('Kiosk', escHtml(k.name));
      row('Load class', Retic._erfOverride(e) ? 'Fixed load' : clsLabel(k));
      row('Connection', is3 ? '3 phase' : '1 phase');
      row('Design current', `${num(amps)} A`);
      row('Service cable', escHtml(e.cableType || '—'));
      row('Service length', e.length ? `${num(e.length, 1)} m` : '—');
      if (vc) row('Service volt drop', `${num(vc.vd)} %`, vc.vd > limit ? 'bad' : 'ok');
    } else if (item.type === 'kiosk') {
      const k = PlanSync._resolve(R.kiosks, item);
      if (!k) return notLinked();
      const kr = res && res.kiosks && res.kiosks.find(x => x.kioskId === k.id);
      // The minisub at the head of this kiosk's chain, and the kiosk it is fed from if not directly.
      const ms = Retic._minisubOf(k);
      if (ms) row('Fed from minisub', escHtml(ms.name || 'Minisub'));
      const parent = R.kiosks.find(o => o.id === k.fedFrom);
      row('Fed directly by', escHtml(parent ? (parent.name || 'Kiosk') : ((ms && ms.name) || 'Minisub')));
      row('Load class', clsLabel(k));
      row('Erven', String(k.erfs.length));
      if (kr) { row('Demand', `${kr.totalKVA} kVA · ${kr.currentA} A`); row('ADMD', `${kr.admdKVA} kVA${kr.admdPerPhase ? '/ph' : ''}`); }
      row('Feeder cable', escHtml(k.feederCable || '—'));
      const fi = this._feederInfo(k, res);
      row('Feeder length (incoming leg)', k.feederLength ? `${num(k.feederLength, 1)} m` : '—');
      row('Cumulative length', fi.cumLen ? `${num(fi.cumLen, 1)} m` : '—');
      if (fi.legVD != null) row('Incoming leg volt drop', `${num(fi.legVD)} %`);
      if (fi.cumVD != null) row('Cumulative volt drop', `${num(fi.cumVD)} %`, fi.cumVD > Retic.settings.maxFeederVD ? 'bad' : 'ok');
    } else if (item.type === 'minisub') {
      const ms = PlanSync._resolve(R.minisubs, item);
      if (!ms) return notLinked();
      const r = res && res.minisubs && res.minisubs.find(x => x.minisubId === ms.id);
      // Everything downstream, however deep the chain — not just the kiosks wired straight to it.
      const down = R.kiosks.filter(k => Retic._minisubOf(k) === ms);
      const strings = down.filter(k => Retic._stringHead(k) === k).length;
      row('Kiosks fed (downstream)', `${down.length} in ${strings} string${strings === 1 ? '' : 's'}`);
      kioskList = down;
      if (r) row('Demand', `${r.totalKVA} kVA`);
    } else return '';
    return `<div class="plan-demand"><div class="plan-demand-title">${title}</div>${rows.join('')}</div>${kioskList ? this._kioskTable(kioskList, res) : ''}`;
  },

  // Each downstream kiosk of a selected minisub: demand, feeder length (own and
  // cumulative back to the minisub) and cumulative volt drop. Click selects it
  // on the plan.
  _kioskTable(kiosks, res) {
    if (!kiosks.length) return '';
    const num = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toString();
    const limit = Retic.settings.maxFeederVD;
    const planEl = (k) => AppState.planMarkup.elements.find(e => e.type === 'kiosk' && e.reticId === k.id);
    const body = kiosks.map(k => {
      const fi = this._feederInfo(k, res), kr = fi.kr, el = planEl(k);
      return `<tr${el ? ` data-plan-select="${escHtml(el.id)}" class="clickable"` : ''}>
        <td>${escHtml(k.name || 'Kiosk')}</td>
        <td>${kr ? num(kr.totalKVA) + ' kVA' : '—'}</td>
        <td>${k.feederLength ? num(k.feederLength) + ' m' : '—'}</td>
        <td>${fi.cumLen ? num(fi.cumLen) + ' m' : '—'}</td>
        <td class="${fi.cumVD != null ? (fi.cumVD > limit ? 'bad' : 'ok') : ''}">${fi.cumVD != null ? num(fi.cumVD, 2) + ' %' : '—'}</td></tr>`;
    }).join('');
    return `<div class="plan-demand"><div class="plan-demand-title">Kiosks downstream</div>
      <table class="plan-demand-table"><thead><tr><th>Kiosk</th><th>Demand</th><th>Feeder</th><th>Σ length</th><th>Σ VD</th></tr></thead><tbody>${body}</tbody></table></div>`;
  },

  // Feeder figures for one kiosk: its own (incoming) leg and the running total
  // back to the minisub — length and volt drop. VD needs the Demand results.
  _feederInfo(k, res) {
    const byId = {};
    if (res && res.kiosks) for (const kr of res.kiosks) byId[kr.kioskId] = kr;
    let cumLen = 0, id = k.id;
    const seen = new Set();
    while (id && id !== 'source' && !seen.has(id)) {
      seen.add(id);
      const kk = Retic.kioskById(id);
      if (!kk) break;
      cumLen += Number(kk.feederLength) || 0;
      id = kk.fedFrom || 'source';
    }
    const kr = byId[k.id];
    return {
      cumLen, kr,
      legVD: kr ? Retic._legFeederVD(k.id, byId) : null,
      cumVD: kr ? Retic._cumulativeFeederVD(k.id, byId) : null,
    };
  },

  // Demand figures for a drawn cable: a service route shows its erf's load and
  // volt drop, a kiosk feeder route the leg's load, length and cumulative drop.
  _demandRouteBlock(route) {
    if (typeof PlanSync === 'undefined' || !PlanSync._cableLink) return '';
    const R = AppState.reticulation;
    const retic = typeof Retic !== 'undefined' && R && AppState.planMarkup.settings.domain === 'retic';
    const link = retic ? PlanSync._cableLink(route, PlanSync._elById()) : null;
    const res = AppState.reticResults;
    const rows = [];
    const row = (k, v, cls) => rows.push(`<div class="plan-demand-row${cls ? ' ' + cls : ''}"><span>${escHtml(k)}</span><b>${v}</b></div>`);
    const num = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toString();
    const cable = CableLib.byName(route.cableType || (link && link.row[link.key]));
    const rating = cable && cable.rated_amps ? Number(cable.rated_amps) : null;
    const loading = (amps) => rating && amps ? ` (${Math.round(amps / rating * 100)}% of ${rating} A)` : '';
    // What is known about this drawn cable whether or not it is in Demand.
    const factor = PlanSync._factor && PlanSync._factor();
    const planLen = factor ? PlanSync._routeLenM(route, factor) : 0;
    row('Length on plan', planLen ? `${num(planLen, 1)} m` : 'plan not calibrated');
    if (cable) {
      row('Cable rating', rating ? `${rating} A` : '—');
      if (cable.r_per_km != null) row('R · X', `${cable.r_per_km} · ${cable.x_per_km} Ω/km`);
    }
    if (!link) {
      if (!retic) return `<div class="plan-demand"><div class="plan-demand-title">Cable</div>${rows.join('')}</div>`;
      const why = (!route.fromId || !route.toId) ? 'Both ends must be connected to plan elements (kiosk, erf, minisub).'
        : (route.type !== 'service' && route.type !== 'lv') ? 'Only service and LV feeder routes are tied to Demand.'
        : 'Not linked to Demand yet — use → Push to Schedules.';
      rows.push(`<div class="plan-demand-row"><span>${escHtml(why)}</span></div>`);
      return `<div class="plan-demand"><div class="plan-demand-title">Cable · Demand</div>${rows.join('')}</div>`;
    }
    if (link.key === 'cableType') {                      // service cable → erf
      const e = link.row;
      const k = Retic.kiosks.find(kk => kk.erfs.includes(e));
      if (!k) return '';
      const is3 = Retic._erfIs3ph(k, e), amps = Retic._erfDesignAmps(k, e);
      const vc = Retic._vdCalc(e.cableType, amps, e.length, is3);
      const limit = Retic.settings.maxRunVD;
      row('Erf', escHtml(e.erfNumber || '—') + ' · ' + escHtml(k.name));
      row('Connection', is3 ? '3 phase' : '1 phase');
      row('Design current', `${num(amps)} A${loading(amps)}`);
      row('Length in Demand', e.length ? `${num(e.length, 1)} m` : '—');
      if (vc) row('Volt drop', `${num(vc.vd)} % (limit ${limit} %)`, vc.vd > limit ? 'bad' : 'ok');
    } else {                                             // feeder cable → kiosk leg
      const k = link.row;
      if (!res && Retic._doCompute && !this._demandAsked) {
        this._demandAsked = true;
        Promise.resolve(Retic._doCompute()).finally(() => { this._demandAsked = false; });
      }
      const fi = this._feederInfo(k, res);
      row('Feeds', escHtml(k.name) + ` (${k.erfs.length} erven)`);
      if (fi.kr) {
        const kva = fi.kr.feederKVA != null ? fi.kr.feederKVA : fi.kr.totalKVA;
        const amps = fi.kr.feederA != null ? fi.kr.feederA : fi.kr.currentA;
        row('Leg load', `${kva} kVA · ${num(amps)} A${loading(amps)}`);
      }
      row('Leg length in Demand', k.feederLength ? `${num(k.feederLength, 1)} m` : '—');
      row('Cumulative length', fi.cumLen ? `${num(fi.cumLen, 1)} m` : '—');
      if (fi.legVD != null) row('Leg volt drop', `${num(fi.legVD)} %`);
      if (fi.cumVD != null) row('Cumulative volt drop', `${num(fi.cumVD)} % (limit ${Retic.settings.maxFeederVD} %)`, fi.cumVD > Retic.settings.maxFeederVD ? 'bad' : 'ok');
    }
    return `<div class="plan-demand"><div class="plan-demand-title">Cable · From Demand</div>${rows.join('')}</div>`;
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
    const poles = (p.poles === '3P') ? '3P' : '1P';
    const autoVa = PlanCircuits.deviceVA({ type: item.type, props: { ...p, load_va: undefined } });
    const loadVal = (p.load_va != null && p.load_va !== '') ? p.load_va : '';
    return `<div class="plan-circuit-box">
      <div class="plan-circuit-h">Circuit</div>
      <div class="plan-field"><label class="plan-field-label">Board</label>
        <select data-key="circuitDbId">${opts}</select></div>
      <div class="plan-field"><label class="plan-field-label">Way (circuit no.)</label>
        <input type="number" min="1" step="1" data-key="circuitNo" value="${escHtml(p.circuitNo != null ? p.circuitNo : '')}"></div>
      <div class="plan-field"><label class="plan-field-label" title="Single-phase or three-phase (3P+N) fixture">Poles</label>
        <select data-key="poles">
          <option value="1P"${poles === '1P' ? ' selected' : ''}>Single-phase (1P)</option>
          <option value="3P"${poles === '3P' ? ' selected' : ''}>Three-phase (3P)</option>
        </select></div>
      <div class="plan-field"><label class="plan-field-label" title="Auto VA conventions: a light contributes its watts (≈VA at unity PF); a socket 200 VA per outlet (double = 400); a fused spur a nominal 2000 VA. The board lump then applies PF 0.85 and the way demand factor. Type a value here to override the auto figure.">Load <span class="plan-field-unit">(VA)</span></label>
        <input type="text" inputmode="numeric" data-key="load_va" value="${escHtml(loadVal)}" placeholder="auto: ${autoVa}"></div>
      ${this._tapPhaseField(item, poles)}
      <div class="plan-circuit-note" title="Lights use watts (≈VA); sockets 200 VA/outlet; FCU 2000 VA. Overriding Load pins this device's VA.">Effective load: ${PlanCircuits.deviceVA(item)} VA${boards.length ? '' : ' — place a Distribution Board first'}</div>
    </div>`;
  },

  // Tap phase — only meaningful for a single-phase fixture sitting on a 3P+N
  // final circuit. A 3P device spans all three, and on a 1P way the way's own
  // phase already decides it, so the picker is replaced by a note in both cases
  // rather than offering a choice that does nothing.
  _tapPhaseField(item, poles) {
    const p = item.props || {};
    if (poles === '3P') {
      return `<div class="plan-circuit-note">Three-phase device — draws on R, W and B; no tap phase.</div>`;
    }
    const way = this._wayOf(item);
    if (!way) {
      return `<div class="plan-field"><label class="plan-field-label" title="Which phase this fixture taps on a 3P+N circuit. Assign the circuit first.">Tap phase</label>
        <select data-key="tapPhase" disabled><option>— assign a circuit first —</option></select></div>`;
    }
    if (way.poles !== '3P') {
      const ph = ['R', 'W', 'B'].includes(way.phase) ? way.phase : 'R';
      return `<div class="plan-circuit-note">Way ${escHtml(String(way.way))} is single-phase — this fixture sits on phase ${escHtml(ph)}.</div>`;
    }
    const cur = String(p.tapPhase || '').toUpperCase();
    const opt = (v, l) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
    return `<div class="plan-field"><label class="plan-field-label" title="On a 3P+N final circuit each single-phase fixture taps one phase to neutral. Balancing these across the run is what keeps the board's phase loading (and neutral current) sane.">Tap phase <span class="plan-field-unit">(3P+N)</span></label>
      <select data-key="tapPhase">
        <option value="" ${cur ? '' : 'selected'}>— unassigned —</option>
        ${opt('R', 'R (L1)')}${opt('W', 'W (L2)')}${opt('B', 'B (L3)')}
      </select></div>`;
  },

  // The schedule way a tagged device belongs to (stable id first, then number).
  _wayOf(item) {
    const p = (item && item.props) || {};
    if (!p.circuitDbId) return null;
    const board = PlanCircuits.boardEls().find(b => b.id === p.circuitDbId);
    const comp = board && board.el.sldId && AppState.components.get(board.el.sldId);
    if (!comp || !Array.isArray(comp.props.circuits)) return null;
    return (p.circuitWid && comp.props.circuits.find(c => c.id === p.circuitWid))
      || comp.props.circuits.find(c => String(c.way) === String(p.circuitNo) && c.type !== 'feeder_db')
      || null;
  },

  // Distribution-board panel: way count + one-click auto-distribute of connected
  // untagged devices, and a re-sync of loads from the plan.
  _boardCircuits(item) {
    const comp = item.sldId && AppState.components.get(item.sldId);
    const ways = (comp && Array.isArray(comp.props.circuits)) ? comp.props.circuits.length : 0;
    const linked = comp ? '' : ' <span class="plan-circuit-note">(sync with the SLD to create its schedule)</span>';
    // Per-phase loading + imbalance: the number that tells you whether the 3P+N
    // tap assignments are actually doing their job.
    let phase = '';
    const ph = comp ? PlanCircuits.boardPhaseLoad(item.id) : null;
    if (ph && ph.total > 0) {
      const warn = ph.imbalancePct > 20 ? ' plan-circuit-warn' : '';
      const un = ph.unassigned > 0
        ? `<div class="plan-circuit-note plan-circuit-warn">${Math.round(ph.unassigned)} VA on 3P+N circuits has no tap phase — balance to assign it.</div>` : '';
      phase = `<div class="plan-circuit-note${warn}" title="Per-phase connected VA across every way on this board, and the spread between the heaviest and lightest phase relative to the mean.">
          Phase load — R ${Math.round(ph.R)} · W ${Math.round(ph.W)} · B ${Math.round(ph.B)} VA · imbalance ${ph.imbalancePct}%
        </div>${un}
        <button class="plan-circuit-btn" data-role="balance-phases">⚖ Balance 3P+N tap phases</button>`;
    }
    return `<div class="plan-circuit-box">
      <div class="plan-circuit-h">Circuits</div>
      <div class="plan-circuit-note">${ways} way(s) on this board${linked}</div>
      <button class="plan-circuit-btn" data-role="edit-schedule">📋 Edit Circuit Schedule</button>
      <button class="plan-circuit-btn" data-role="bulk-assign">⚡ Auto-assign connected devices</button>
      <button class="plan-circuit-btn" data-role="sync-circuits">🔄 Sync loads from plan</button>
      ${phase}
    </div>`;
  },

  _field(f, value) {
    const v = (value == null) ? '' : value;
    const label = `<label class="plan-field-label">${escHtml(f.label)}${f.unit ? ` <span class="plan-field-unit">(${escHtml(f.unit)})</span>` : ''}</label>`;
    if (f.type === 'checkbox') {
      return `<div class="plan-field plan-field-check"><label><input type="checkbox" data-key="${f.key}" ${value ? 'checked' : ''}> ${escHtml(f.label)}</label></div>`;
    }
    if (f.type === 'cable_select') {
      // The size in use is also spelled out under the box, so it reads at a glance.
      return `<div class="plan-field">${label}<select data-key="${f.key}" data-cable-select>${this._cableOptions(v, f)}</select><div class="plan-field-current">${v ? 'Current: <b>' + escHtml(v) + '</b>' : 'No cable chosen'}</div></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${escHtml(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('');
      return `<div class="plan-field">${label}<select data-key="${f.key}">${opts}</select></div>`;
    }
    if (f.type === 'ies_select') return this._iesField(f, v, label);
    if (f.type === 'number') {
      const attrs = [f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '', f.step != null ? `step="${f.step}"` : ''].join(' ');
      return `<div class="plan-field">${label}<input type="number" data-key="${f.key}" value="${escHtml(v)}" ${attrs}></div>`;
    }
    return `<div class="plan-field">${label}<input type="text" data-key="${f.key}" value="${escHtml(v)}"></div>`;
  },

  // Balance the selected board's 3P+N tap phases. Unassigned fixtures are
  // placed first; if there are none left to place, offer to redo the existing
  // assignment rather than reporting "0 assigned" and leaving the user stuck.
  async _balancePhases() {
    const sel = [...PlanMarkup.selectedIds];
    const el = sel.length === 1 && AppState.planMarkup.elements.find(x => x.id === sel[0]);
    if (!el || el.type !== 'bd_db') return;
    let r = PlanCircuits.balancePhases(el.id, false);
    if (!r.assigned) {
      if (!r.ways) { UI.toast('No three-phase final circuits on this board — nothing to balance.', 'info'); return; }
      const redo = await UI.confirm(
        'Every fixture on this board already has a tap phase. Reassign them all to even the load out?',
        { okText: 'Reassign', cancelText: 'Leave as is' });
      if (!redo) return;
      r = PlanCircuits.balancePhases(el.id, true);
    }
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this.renderProps();
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    UI.toast(`Balanced ${r.assigned} fixture(s) across ${r.ways} three-phase circuit(s) — R ${Math.round(r.load.R)} · W ${Math.round(r.load.W)} · B ${Math.round(r.load.B)} VA, imbalance ${r.load.imbalancePct}%.`, 'success');
  },

  // Import an IES file and attach it to the selected fitting straight away —
  // picking the file then having to pick it again from the list is a pointless
  // second step when there is exactly one fitting selected.
  _importIes() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ies,.IES,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file || typeof PlanIES === 'undefined') return;
      const before = new Set(PlanIES.profiles().map(p => p.id));
      await PlanIES.importFile(file);
      const added = PlanIES.profiles().find(p => !before.has(p.id)) || PlanIES.profiles().slice(-1)[0];
      const sel = [...PlanMarkup.selectedIds];
      if (added && sel.length === 1) {
        const el = AppState.planMarkup.elements.find(x => x.id === sel[0]);
        if (el) {
          el.props = el.props || {};
          el.props.iesId = added.id;
          if (typeof PlanLux !== 'undefined') PlanLux.invalidate();
          PlanMarkup.snapshot(); PlanMarkup.markDirty();
        }
      }
      this.renderProps();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    });
    input.click();
  },

  // Photometry picker: the project's imported IES profiles plus an import
  // button. Shows the selected profile's flux/watts/peak candela so the user can
  // tell at a glance which luminaire the heatmap is actually using.
  _iesField(f, v, label) {
    const libs = (typeof PlanIES !== 'undefined') ? PlanIES.profiles() : [];
    const opts = ['<option value="">— cone approximation —</option>']
      .concat(libs.map(p => `<option value="${escHtml(p.id)}" ${p.id === v ? 'selected' : ''}>${escHtml(p.name)}</option>`))
      .join('');
    const sel = libs.find(p => p.id === v);
    const note = sel
      ? `<div class="plan-circuit-note">${Math.round(sel.lumens)} lm · ${sel.watts || '?'} W · peak ${Math.round(sel.maxCd)} cd${sel.resampled ? ' · resampled' : ''}${sel.warning ? ` · ${escHtml(sel.warning)}` : ''}</div>`
      : `<div class="plan-circuit-note">No photometry — the heatmap uses the beam-cone fallback.</div>`;
    return `<div class="plan-field">${label}<select data-key="${f.key}">${opts}</select></div>
      ${note}
      <button class="plan-circuit-btn" data-role="import-ies">📈 Import IES file…</button>`;
  },

  // Build <option>s for a cable_select field from the one cable library.
  // Reticulation routes (`voltage` 'lv' | 'mv') offer armoured distribution
  // cables, the project's standard conductor first (Demand › LV / MV
  // Conductor) with "Show all cables…" for the rest; building routes offer
  // the constructions in the field's `uses` list.
  _cableOptions(selectedName, field, showAll) {
    field = field || {};
    if (Array.isArray(field.uses)) {
      const want = new Set(field.uses);
      const filter = (c) => (want.has('armoured-lv') && c.construction === 'armoured' && !CableLib.isMV(c)) || want.has(c.construction);
      const groups = field.uses.map(u => u === 'armoured-lv'
        ? { label: 'Armoured multicore (SWA)', test: (c) => c.construction === 'armoured' }
        : { label: (CableLib.CONSTRUCTIONS.find(k => k.id === u) || {}).label || u, test: (c) => c.construction === u });
      return CableLib.options(selectedName, { filter, groups });
    }
    const v = field.voltage === 'mv' ? 'mv' : field.voltage === 'lv' ? 'lv' : '';
    return CableLib.options(selectedName, {
      filter: CableLib.reticFilter(v), groups: CableLib.reticGroups(),
      prefer: v ? CableLib.reticPrefer(v) : '', showAll: !!showAll,
    });
  },

  // "Link to SLD" picker for a drawn board/transformer/generator/utility/feeder:
  // attach it to an existing SLD component after the fact (or detach it).
  _sldLinkField(item, kind) {
    if (AppState.planMarkup.settings.domain !== 'building' || typeof PlanSync === 'undefined') return '';
    if (kind !== 'element' && kind !== 'route') return '';
    const cands = PlanSync.linkCandidates(item, kind);
    const isRoute = kind === 'route';
    if (isRoute ? item.type !== 'feeder' : !Object.values(PLAN_DEFS.sldLinkTypes || {}).includes(item.type)) return '';
    const cur = isRoute ? item.sldCableId : item.sldId;
    const live = cur && AppState.components.get(cur);
    if (cur && live && !cands.some(c => c.id === cur)) cands.push({ id: cur, label: (live.props && live.props.name) || live.type });
    let opts = `<option value=""${live ? '' : ' selected'}>— not linked —</option>`;
    for (const c of cands.sort((a, b) => a.label.localeCompare(b.label))) {
      opts += `<option value="${escHtml(c.id)}"${live && c.id === cur ? ' selected' : ''}>${escHtml(c.label)}</option>`;
    }
    return `<div class="plan-field"><label class="plan-field-label">Link to SLD</label>
      <select data-role="sld-link" title="Attach this drawn item to an existing SLD component${isRoute ? ' (cable)' : ''}">${opts}</select></div>`;
  },

  // "Linked Demand item" picker for a drawn minisub / kiosk / erf: attach it to a
  // Demand row drawn after the fact. Linked labels then follow the Demand sheet.
  _demandLinkField(item, kind) {
    if (kind !== 'element' || typeof PlanSync === 'undefined' || !AppState.reticulation) return '';
    if (!['minisub', 'kiosk', 'erf'].includes(item.type)) return '';
    const cands = PlanSync.demandLinkCandidates(item);
    const live = !!PlanSync._demandRow(item);
    let opts = `<option value=""${live ? '' : ' selected'}>— not linked —</option>`;
    for (const c of cands.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))) {
      opts += `<option value="${escHtml(c.id)}"${live && c.id === item.reticId ? ' selected' : ''}>${escHtml(c.label)}</option>`;
    }
    const note = live ? 'The name follows the Demand sheet — edit it there.' : 'Pick the Demand row this stands for, or use → Push to Schedules.';
    return `<div class="plan-field"><label class="plan-field-label">Linked Demand item</label>
      <select data-role="demand-link" title="Attach this drawn item to a Demand row">${opts}</select>
      <div class="plan-linked-note">${note}</div></div>`;
  },

  // One toast per rename so a failed sync is never silent.
  _reportRename(r, commit) {
    if (!r || r.status === 'skip' || r.status === 'unchanged' || typeof UI === 'undefined') return;
    const text = r.msg + (r.warn ? ' ' + r.warn : '');
    const now = Date.now();
    if (!(this._lastRename && this._lastRename.text === text && now - this._lastRename.at < 4000)) {
      UI.toast(text, r.status === 'ok' && !r.warn ? 'success' : 'warning');
    }
    this._lastRename = { text, at: now };
    if (commit) this.renderProps();      // never mid-typing: it would drop focus
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
  },

  _onDemandLink(e) {
    if (e.type !== 'change') return;
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found) return;
    PlanSync.linkElementToDemand(found.item, e.target.value || null);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this.renderProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  _onSldLink(e) {
    if (e.type !== 'change') return;
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found) return;
    PlanSync.linkItemToSld(found.item, found.kind, e.target.value || null);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this.renderProps();
    this.renderPalette();   // "From SLD (unplaced)" list changes
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  _onPropsChange(e) {
    if (e.target.dataset && e.target.dataset.role === 'sld-link') { this._onSldLink(e); return; }
    if (e.target.dataset && e.target.dataset.role === 'demand-link') { this._onDemandLink(e); return; }
    if (e.target.dataset && e.target.dataset.role === 'delete') return;
    const key = e.target.dataset ? e.target.dataset.key : null;
    if (!key) return;
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found) return;
    const { kind, item } = found;
    // "Show all cables…" only widens the picker; nothing is written.
    if (e.target.tagName === 'SELECT' && e.target.value === '__all__') {
      const def = kind === 'route' ? PLAN_DEFS.route(item.type) : null;
      const field = def && (def.fields || []).find(f => f.key === key);
      CableLib.handleShowAll(e.target, item[key], (v) => this._cableOptions(v, field, true));
      return;
    }
    let val = e.target.value;
    if (e.target.type === 'number') val = parseFloat(val) || 0;
    if (e.target.type === 'checkbox') val = e.target.checked;

    // UX-12: apply the value live on every `input`, but only snapshot/propagate
    // (undo push + SLD re-render + sync) on `change` — so a text field no longer
    // snapshots and re-renders the SLD per keystroke. Checkboxes fire `change`
    // only, so they snapshot once (no double-snapshot).
    const commit = (e.type === 'change');
    // Live `input` events already write item.name, so remember what it was
    // before the edit began; the commit hands that to the sync as the old name.
    if (kind === 'element' && key === 'name' && (!this._nameBefore || this._nameBefore.id !== item.id)) {
      this._nameBefore = { id: item.id, name: item.name };
    }
    const oldName = (kind === 'element' && key === 'name' && this._nameBefore && this._nameBefore.id === item.id) ? this._nameBefore.name : item.name;
    if (kind === 'element') {
      if (key === 'name' || key === 'rotation') item[key] = val;
      else if (key === 'symScale') { if (val > 0 && val !== 1) item.scale = Math.min(10, val); else delete item.scale; }
      else { item.props = item.props || {}; item.props[key] = val; }
      if (key === 'name' && typeof PlanSync !== 'undefined' && PlanSync.onElementRenamed) {
        // Typing syncs after a short pause as well as on commit: a name typed
        // and then abandoned by clicking elsewhere never fires `change`.
        clearTimeout(this._renameTimer);
        const run = () => {
          const before = (this._nameBefore && this._nameBefore.id === item.id) ? this._nameBefore.name : oldName;
          this._nameBefore = null;
          this._reportRename(PlanSync.onElementRenamed(item, before, item.name), commit);
        };
        if (commit) run(); else this._renameTimer = setTimeout(run, 1200);
      }
      // A circuit attribute (board / way / phase / load) changed → refresh the
      // board schedule on commit (not every keystroke) and re-render the panel.
      if (/^(circuitDbId|circuitNo|poles|load_va)$/.test(key) && commit &&
          typeof PlanCircuits !== 'undefined') {
        // Changing the board or the way NUMBER re-picks the target circuit, so
        // drop the resolved way id and let syncLoads re-resolve (EE-7).
        if (key === 'circuitDbId' || key === 'circuitNo') delete item.props.circuitWid;
        if (!val && key === 'circuitDbId') delete item.props.circuitNo;   // unassign clears the way
        PlanCircuits.syncLoads();
        if (PlanCircuits.syncRoutedLengths) PlanCircuits.syncRoutedLengths();
        // A tag on a board that isn't on the SLD yet has nowhere to land —
        // say so instead of silently writing nothing.
        const tagBoard = item.props.circuitDbId && PlanCircuits._boardById(item.props.circuitDbId);
        if (tagBoard && !PlanCircuits._sldComp(tagBoard)) {
          UI.toast(`${tagBoard.name || 'This board'} isn't on the SLD yet — press → Sync with SLD to create its schedule.`, 'info');
        }
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
        if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();   // UX-4: pair the SLD stack
        this.renderProps();
        return;
      }
    } else if (kind === 'route') {
      if (key === 'cableType') {
        item.cableType = val;
        const cur = e.target.closest('.plan-field') && e.target.closest('.plan-field').querySelector('.plan-field-current');
        if (cur) cur.innerHTML = val ? 'Current: <b>' + escHtml(val) + '</b>' : 'No cable chosen';
        // Retic: the linked erf / kiosk takes the same cable in Demand.
        if (commit && typeof PlanSync !== 'undefined' && PlanSync.pushRouteCable) PlanSync.pushRouteCable(item);
      }
      else if (key === 'curved') item.curved = val;
      else { item.props = item.props || {}; item.props[key] = val; }
    } else {
      item[key] = val;
    }
    PlanEngine.requestDraw({ fg: true });
    if (commit) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
  },

  // Open the SLD's own circuit-schedule editor (DBSchedule modal) for the
  // selected plan board — the same editor the SLD shows for that DB.
  _editBoardSchedule() {
    const ids = [...PlanMarkup.selectedIds]; if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found || found.kind !== 'element' || found.item.type !== 'bd_db') return;
    const comp = found.item.sldId && AppState.components.get(found.item.sldId);
    if (!comp) {
      UI.toast('Sync this board with the SLD first (→ Sync with SLD) to create its circuit schedule.', 'info');
      return;
    }
    if (typeof DBSchedule !== 'undefined') DBSchedule.open(comp.id);
  },

  // Auto-distribute the selected board's connected untagged devices into ways.
  async _bulkAssign() {
    const ids = [...PlanMarkup.selectedIds]; if (ids.length !== 1) return;
    const found = PlanMarkup.findEntityById(ids[0]);
    if (!found || found.kind !== 'element' || found.item.type !== 'bd_db') return;
    // The board needs a schedule to assign into — link it rather than refuse.
    if (!found.item.sldId || !AppState.components.get(found.item.sldId)) {
      await PlanSync.syncBuildingToSLD();
      if (!found.item.sldId || !AppState.components.get(found.item.sldId)) return;
    }
    const r = PlanCircuits.bulkAssign(found.item.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();   // UX-4
    this.renderProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    UI.toast(r.devices ? `Assigned ${r.devices} device(s) across ${r.ways} new way(s).` : 'No unassigned connected devices found.', r.devices ? 'success' : 'info');
  },

  // Re-count loads + routed lengths from the plan into every linked board.
  async _syncCircuits() {
    // Unlinked boards have no schedule yet: the SLD sync links them and ends
    // with the same circuit sync (and its own summary).
    if (PlanCircuits.hasUnlinkedBoards()) { await PlanSync.syncBuildingToSLD(); this.renderProps(); return; }
    const s = PlanCircuits.syncAll();
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();   // UX-4
    this.renderProps();
    UI.toast(`Synced ${s.ways} way(s) on ${s.boards} board(s) from ${s.devices} device(s).` +
      (s.unsynced ? ` ${s.unsynced} board(s) not yet on the SLD.` : ''), 'success');
  },
};
