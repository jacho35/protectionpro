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
    const clean = document.getElementById('btn-admin-plan-cleanup');
    if (clean) clean.addEventListener('click', () => this._cleanup());
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
      if (e.target.closest('[data-role="open-photolib"]')) { PhotoLib.open(); return; }
      const ua = e.target.closest('[data-ul-act]');
      if (ua) { this._onUnderlayAction(ua.dataset.ulAct); return; }
      if (e.target.closest('[data-role="open-lighting"]')) {
        const id = [...PlanMarkup.selectedIds][0];
        if (typeof LightingWS !== 'undefined') LightingWS.openOnPlan(id);
        return;
      }
      if (e.target.closest('[data-role="set-default-cable"]')) { this._setDefaultCable(); return; }
      if (e.target.closest('[data-role="balance-phases"]')) { this._balancePhases(); return; }
    });
  },

  // ─── Palette ───
  // kind → the tool id that draws it; disabled until that tool is registered.
  _toolFor(kind) {
    return { element: 'place', route: 'route', trench: 'trench',
      crossing: 'crossing', text: 'text', measurement: 'measurement', room: 'room', roomdetect: 'roomdetect', perimeter: 'perimeter' }[kind];
  },

  // Folded palette groups (session only); the group last used stays open.
  _folded: null,
  // The underlay picked in Underlays mode: { kind: 'dxf' | 'plan', id }.
  _underlay: null,

  renderPalette() {
    const el = this.paletteEl; if (!el) return;
    const ctx = (typeof PlanMarkup !== 'undefined' && PlanMarkup.context) || 'plan';
    const mode = (typeof PlanMarkup !== 'undefined' && PlanMarkup.mode) || 'draw';
    let html;
    if (ctx === 'lighting') { el.setAttribute('aria-label', 'Lighting tools'); html = this._lightingPanel(); }
    else if (mode === 'underlays') { el.setAttribute('aria-label', 'Underlays'); html = this._underlaysPanel(); }
    else if (mode === 'output') { el.setAttribute('aria-label', 'Sync and export'); html = this._outputPanel(); }
    else { el.setAttribute('aria-label', 'Parts'); html = this._drawPanel(); }
    el.innerHTML = html;
    this._markArmed();
  },

  // Re-highlight the armed palette item after a re-render.
  _markArmed() {
    const t = (typeof PlanTools !== 'undefined') && PlanTools.active;
    const type = t && PlanTools.opts && PlanTools.opts.type;
    if (!t || t.id === 'select' || !type) return;
    this.paletteEl.querySelectorAll('.plan-pal-item[data-type]').forEach(b => b.classList.toggle('armed', b.dataset.type === type));
  },

  _palItem(it) {
    const toolId = this._toolFor(it.kind);
    const ready = typeof PlanTools !== 'undefined' && PlanTools._tools[toolId];
    return `<button type="button" class="plan-pal-item${ready ? '' : ' disabled'}" data-kind="${it.kind}" data-type="${escHtml(it.type)}"${ready ? '' : ' disabled'}${it.desc ? ` title="${escHtml(it.desc)}"` : ''}>
      <span class="plan-pal-swatch" style="background:${it.color}"></span><span class="plan-pal-name">${escHtml(it.name)}</span>${it.desc ? `<small>${escHtml(it.desc)}</small>` : ''}</button>`;
  },

  _drawPanel() {
    const pm = AppState.planMarkup;
    const domain = pm.settings.domain || 'retic';
    const filter = (this._search || '').toLowerCase();
    const groups = PLAN_DEFS.paletteGroups(domain);
    if (!this._folded || this._foldedDomain !== domain) { this._folded = new Set(groups.slice(2).map(g => g.label)); this._foldedDomain = domain; }
    // The project type normally fixes the plan's domain (workspaces.js); the
    // selector only appears when it doesn't — a Network project with a plan,
    // or a plan whose content is the other domain's.
    const domainLocked = typeof Workspaces !== 'undefined' && Workspaces.planDomainLocked && Workspaces.planDomainLocked();
    let html = `<div class="plan-pal-header">
        ${domainLocked ? '' : `<label class="plan-domain-field">
          <span class="plan-domain-cap">Plan type</span>
          <select class="plan-domain-select" data-role="domain">
            ${PLAN_DOMAINS.map(d => `<option value="${d.id}" ${d.id === domain ? 'selected' : ''}>${escHtml(d.name)}</option>`).join('')}
          </select>
        </label>`}
        <label class="plan-domain-field plan-pal-searchfield"><span class="plan-domain-cap">Find a part</span>
        <input type="search" class="plan-pal-search" data-role="search" placeholder="Socket, DB, smoke…" value="${escHtml(this._search || '')}"></label>
      </div><div class="plan-pal-groups">`;
    for (const g of groups) {
      const items = g.items.filter(it => !filter || it.name.toLowerCase().includes(filter));
      if (!items.length) continue;
      const open = !!filter || !this._folded.has(g.label);
      html += `<div class="plan-pal-group">
        <button type="button" class="plan-pal-group-label" data-role="fold" data-group="${escHtml(g.label)}" aria-expanded="${open}">
          <span class="plan-pal-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${escHtml(g.label)}<span class="plan-pal-count">${items.length}</span></button>`;
      if (open) html += `<div class="plan-pal-grid">${items.map(it => this._palItem(it)).join('')}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
    // "From the single line": adopt SLD boards/supply that aren't on the plan yet.
    if (domain === 'building' && typeof AppState.components !== 'undefined' && PLAN_DEFS.sldLinkTypes) {
      const linkedSld = new Set(pm.elements.filter(e => e.sldId).map(e => e.sldId));
      const rows = [];
      for (const c of AppState.components.values()) {
        if (!PLAN_DEFS.sldLinkTypes[c.type] || c.type === 'bus' || linkedSld.has(c.id)) continue;
        const t = PLAN_DEFS.sldLinkTypes[c.type];
        const typeName = (typeof COMPONENT_DEFS !== 'undefined' && COMPONENT_DEFS[c.type] && COMPONENT_DEFS[c.type].name) || c.type;
        rows.push({ id: c.id, label: c.props.name || typeName, sub: typeName, color: PLAN_DEFS.elementColor(t, pm.styles) });
      }
      if (typeof PlanSync !== 'undefined' && PlanSync.sldSwitchboardGroups) {
        for (const g of PlanSync.sldSwitchboardGroups()) {
          if (g.busIds.some(id => linkedSld.has(id))) continue;   // already adopted
          rows.push({ id: g.primaryBusId, label: g.name, sub: `Switchboard${g.busIds.length > 1 ? ' · ' + g.busIds.length + ' sections' : ''}`, color: PLAN_DEFS.elementColor('bd_switchboard', pm.styles) });
        }
      }
      if (rows.length) {
        html += `<div class="plan-fromsld"><div class="plan-sec-head"><span>From the single line</span><small>${rows.length} not placed</small></div>`;
        for (const r of rows) {
          html += `<button type="button" class="plan-pal-item plan-sld-item" data-sld="${escHtml(r.id)}" title="Place ${escHtml(r.label)} from the single line">
            <span class="plan-pal-swatch" style="background:${r.color}"></span><span class="plan-pal-name">${escHtml(r.label)}</span><small>${escHtml(r.sub)}</small></button>`;
        }
        html += `</div>`;
      }
    }
    return html;
  },

  _underlaysPanel() {
    const pm = AppState.planMarkup;
    const s = pm.scale;
    const dxfs = (typeof PlanDxfImport !== 'undefined') ? PlanDxfImport.list() : [];
    const scaleSrc = s && s.factor ? (s.source === 'dxf'
      ? (() => { const d = dxfs.find(x => x.unitM); return d ? `Set from ${escHtml(d.name)}` : 'Set from a DXF'; })()
      : 'Calibrated from two points') : 'Not set — lengths, areas and cable runs need it';
    let html = `<div class="plan-ul">
      <button type="button" class="plan-primary-btn" data-act="import">${PlanMarkup._icon('upload')} Import plan or DXF…</button>
      <p class="plan-ul-hint">PDF, PNG, JPEG or DXF. You can pick the DXF's units and drawing scale before it lands.</p>
      <div class="plan-card${s && s.factor ? '' : ' warn'}">
        <div class="plan-card-head"><b>Floor scale</b><span>${s && s.factor ? `1 px = ${s.factor.toFixed(4)} m` : 'Not set'}</span></div>
        <small>${scaleSrc}</small>
        <button type="button" class="plan-btn" data-act="calibrate">Calibrate from a known length…</button>
      </div>
      <div class="plan-sec-head"><span>On this floor</span></div>`;
    if (!pm.plans.length && !dxfs.length) html += `<div class="plan-props-empty">Nothing imported yet.</div>`;
    const sel = this._underlay || {};
    for (const D of dxfs) {
      const loaded = !!PlanDxfImport.dataOf(D);
      const meta = [this._dxfUnitsText(D), `${D.count} items`, loaded ? '' : 'loading…'].filter(Boolean).join(' · ');
      html += this._ulCard('dxf', D.id, D.name, 'DXF', meta, !D.hidden, typeof D.opacity === 'number' ? D.opacity : 1, sel.kind === 'dxf' && sel.id === D.id, '');
    }
    for (const P of pm.plans) {
      const isPdf = !!P.pdfPageCount;
      const nav = (P.pdfPageCount > 1)
        ? `<span class="plan-pagenav">Page <button type="button" data-role="prev" data-plan="${escHtml(P.id)}" aria-label="Previous page">◀</button>${P.pdfPage} of ${P.pdfPageCount}<button type="button" data-role="next" data-plan="${escHtml(P.id)}" aria-label="Next page">▶</button></span>` : '';
      html += this._ulCard('plan', P.id, P.name, isPdf ? 'PDF' : 'Image', isPdf && P.pdfPageCount === 1 ? 'PDF page' : '', P.visible !== false, typeof P.opacity === 'number' ? P.opacity : 1, sel.kind === 'plan' && sel.id === P.id, nav);
    }
    return html + `</div>`;
  },

  _dxfUnitsText(D) {
    if (!D.unitM) return 'units unknown';
    const base = D.unitBase || D.unitM;
    const n = D.drawScale && D.drawScale !== 1 ? ` at 1 : ${D.drawScale}` : '';
    const name = (PlanDxfImport.UNITS.find(u => Math.abs(u[0] - base) < 1e-12) || [0, `${base} m`])[1].toLowerCase();
    return `${name}${n}${D.unitsGuessed ? ' (chosen)' : ''}`;
  },

  _ulCard(kind, id, name, badge, meta, visible, opacity, selected, extra) {
    const k = kind === 'dxf' ? 'data-dxf' : 'data-plan';
    return `<div class="plan-ul-card${selected ? ' selected' : ''}" data-ul-kind="${kind}" data-ul-id="${escHtml(id)}">
      <div class="plan-ul-row">
        <input type="checkbox" data-role="${kind === 'dxf' ? 'dxf-vis' : 'vis'}" ${k}="${escHtml(id)}" ${visible ? 'checked' : ''} aria-label="Show ${escHtml(name)}">
        <button type="button" class="plan-ul-name" data-role="ul-pick" title="${escHtml(name)} — select to move, align or remove">${escHtml(name)}</button>
        <span class="plan-badge">${badge}</span>
      </div>
      ${meta ? `<small>${meta}</small>` : ''}${extra}
      <label class="plan-ul-op">Opacity <input type="range" data-role="${kind === 'dxf' ? 'dxf-opacity' : 'opacity'}" ${k}="${escHtml(id)}" min="0.1" max="1" step="0.1" value="${opacity}"></label>
    </div>`;
  },

  _outputPanel() {
    const pm = AppState.planMarkup;
    const building = pm.settings.domain === 'building';
    let untagged = 0;
    if (building && typeof PlanCircuits !== 'undefined' && PlanCircuits.isCircuitDevice) {
      untagged = pm.elements.filter(e => PlanCircuits.isCircuitDevice(e.type) && !(e.props && e.props.circuitDbId)).length;
    }
    const act = (a, title, sub) => `<button type="button" class="plan-act" data-act="${a}"><b>${title}</b><small>${sub}</small></button>`;
    const exp = (a, ext, title, sub) => `<button type="button" class="plan-act plan-act-x" data-act="${a}"><span class="plan-ext">${ext}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
    const crop = pm.cropBox;
    return `<div class="plan-out">
      <div class="plan-sec-head"><span>Sync</span></div>
      ${building ? act('push', 'Sync with single line', 'Boards and feeder cables, both directions') : act('push', 'Push to Demand schedules', 'Kiosks, erven and feeders into Reticulation')}
      ${building ? act('circuits', 'Count circuits into boards', `Loads and routed lengths per way${untagged ? ` · ${untagged} device${untagged > 1 ? 's' : ''} not on a circuit` : ''}`) : ''}
      <div class="plan-sec-head"><span>Print area</span></div>
      <div class="plan-card">
        <div class="plan-card-head"><b>${crop ? 'Set' : 'Whole floor'}</b></div>
        <small>The part of the plan the PNG and PDF show.</small>
        <div class="plan-btn-row"><button type="button" class="plan-btn" data-act="crop">${crop ? 'Redraw' : 'Draw'} print area…</button>${crop ? '<button type="button" class="plan-btn" data-act="crop-clear">Clear</button>' : ''}</div>
      </div>
      <div class="plan-sec-head"><span>Export</span></div>
      ${exp('pdf', 'PDF', 'Drawing sheet', 'A3 sheet of the annotated plan')}
      ${exp('png', 'PNG', 'Image', 'The annotated plan as an image')}
      ${exp('dxf', 'DXF', 'AutoCAD drawing', 'Markup on named layers and blocks')}
      ${exp('csv', 'CSV', 'Schedules', 'Every device, route and room, per type')}
    </div>`;
  },

  // The Lighting tab's panel: zones to draw, fittings to place, and every
  // zone on this floor (click to select).
  _lightingPanel() {
    const pm = AppState.planMarkup;
    let html = `<div class="plan-sec-head"><span>Draw</span></div><div class="plan-pal-list">${PLAN_DEFS.lightingTools().map(it => this._palItem(it)).join('')}</div>`;
    const def = PLAN_DEFS.element('bd_light');
    if (def) {
      html += `<div class="plan-sec-head"><span>Fittings</span></div><div class="plan-pal-list">${this._palItem({ type: 'bd_light', kind: 'element', name: def.name, color: def.color, desc: 'Same fittings as on the Plan tab' })}</div>
        <button type="button" class="plan-btn" data-act="photolib">Luminaire library…</button>`;
    }
    const rooms = (pm.rooms || []).filter(r => r.points && r.points.length >= 2);
    const KIND = { room: 'Room', outdoor: 'Outdoor area', perimeter: 'Fence', escape: 'Escape route' };
    html += `<div class="plan-sec-head"><span>On this floor</span><small>${rooms.length}</small></div>`;
    if (!rooms.length) html += `<div class="plan-props-empty">Draw a room, or use Detect room and click inside one.</div>`;
    for (const r of rooms) {
      const v = (typeof LightingWS !== 'undefined' && LightingWS.verdictOf) ? LightingWS.verdictOf(r) : '';
      const cls = v === 'Pass' ? 'ok' : v === 'Fail' ? 'bad' : '';
      html += `<button type="button" class="plan-zone-row${PlanMarkup.selectedIds.has(r.id) ? ' selected' : ''}" data-plan-zone="${escHtml(r.id)}">
        <span><b>${escHtml(r.name || KIND[r.kind || 'room'])}</b><small>${KIND[r.kind || 'room']}</small></span>${v ? `<span class="plan-verdict ${cls}">${escHtml(v)}</span>` : ''}</button>`;
    }
    return html;
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
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const a = actBtn.dataset.act;
      if (a === 'photolib') { if (typeof PhotoLib !== 'undefined') PhotoLib.open(); return; }
      PlanMarkup.runAction(a); return;
    }
    const fold = e.target.closest('[data-role="fold"]');
    if (fold) {
      const g = fold.dataset.group;
      if (this._folded.has(g)) this._folded.delete(g); else this._folded.add(g);
      this.renderPalette(); return;
    }
    const zone = e.target.closest('[data-plan-zone]');
    if (zone) {
      const r = (AppState.planMarkup.rooms || []).find(x => x.id === zone.dataset.planZone);
      PlanMarkup.selectOnly(zone.dataset.planZone);
      if (r && PlanEngine.zoomToPoints) PlanEngine.zoomToPoints(r.points);
      this.renderPalette(); return;
    }
    // Underlay cards: pick one (its actions show in the properties panel).
    const pick = e.target.closest('[data-role="ul-pick"]');
    if (pick) {
      const card = pick.closest('[data-ul-kind]');
      this._underlay = { kind: card.dataset.ulKind, id: card.dataset.ulId };
      this.renderPalette(); this.renderProps();
      if (PlanMarkup._isMobile()) PlanMarkup._toggleDrawer('props');
      return;
    }
    const planCtl = e.target.closest('[data-role]');
    if (planCtl) {
      const role = planCtl.dataset.role;
      const p = planCtl.dataset.plan && this._planById(planCtl.dataset.plan);
      if ((role === 'prev' || role === 'next') && p) {
        const np = Math.min(p.pdfPageCount || 1, Math.max(1, (p.pdfPage || 1) + (role === 'next' ? 1 : -1)));
        if (np !== p.pdfPage && typeof PlanImages !== 'undefined') {
          PlanImages.renderPdfPage(p, np).then(() => this.renderPalette());
        }
        return;
      }
    }
    // Adopt an existing SLD entity ("From the single line") — link + place it.
    const sldItem = e.target.closest('[data-sld]');
    if (sldItem) {
      PlanTools.set('placeSld', { sldId: sldItem.dataset.sld });
      this.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
      sldItem.classList.add('armed');
      return;
    }
    const item = e.target.closest('.plan-pal-item');
    if (!item || item.disabled) return;
    const kind = item.dataset.kind, type = item.dataset.type;
    if (kind === 'element') {
      // Point devices: the placing bar's choice remembered for this type.
      const byMode = { single: 'place', array: 'array', path: 'devpath' };
      PlanTools.set(byMode[this.placeModeFor(type)] || 'place', { type });
    }
    else PlanTools.set(this._toolFor(kind), { type });
    this.paletteEl.querySelectorAll('.plan-pal-item.armed').forEach(b => b.classList.remove('armed'));
    item.classList.add('armed');
  },

  // Palette 'change' handling: domain select + underlay visibility.
  bindDomainChange() {
    this.paletteEl.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'domain') {
        AppState.planMarkup.settings.domain = e.target.value;
        this._folded = null;
        this.renderPalette();
        if (typeof Workspaces !== 'undefined' && Workspaces.refresh) Workspaces.refresh();
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

  // ─── Underlay properties (Underlays mode) ───
  _renderUnderlayProps(el) {
    const u = this._underlay;
    const D = u && u.kind === 'dxf' && typeof PlanDxfImport !== 'undefined' ? PlanDxfImport.byId(u.id) : null;
    const P = u && u.kind === 'plan' ? this._planById(u.id) : null;
    if (!D && !P) {
      this._underlay = null;
      el.innerHTML = `<div class="plan-props-empty">Pick an underlay on the left to move, align or remove it.</div>`;
      return;
    }
    const btn = (role, label, extra) => `<button type="button" class="plan-btn" data-ul-act="${role}"${extra || ''}>${label}</button>`;
    let html;
    if (D) {
      const data = PlanDxfImport.dataOf(D);
      const [bx0, by0, bx1, by1] = D.bbox || [0, 0, 0, 0];
      const fmt = (m) => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m >= 10 ? m.toFixed(1) + ' m' : m.toFixed(2) + ' m';
      const size = D.unitM ? `${fmt((bx1 - bx0) * D.unitM)} × ${fmt((by1 - by0) * D.unitM)}` : '—';
      html = `<div class="plan-props-kicker">DXF underlay</div><div class="plan-props-title">${escHtml(D.name)}</div>
        <dl class="plan-facts"><dt>Units</dt><dd>${escHtml(this._dxfUnitsText(D))}</dd><dt>Size</dt><dd>${size}</dd>
        <dt>Contents</dt><dd>${D.count} items${data ? ` · ${data.layers.length} layers` : ''}</dd></dl>
        ${btn('units', 'Change units or scale…', data ? '' : ' disabled')}
        <div class="plan-props-sec">Position</div>
        <div class="plan-btn-row">${btn('move', 'Move')}${btn('align', 'Align 2 points')}</div>
        <div class="plan-props-sec">Layers &amp; blocks</div>
        <small class="plan-props-note">Hide layers, or map blocks to plan devices and convert them.</small>
        ${btn('manage', 'Open layers &amp; blocks…', data ? '' : ' disabled')}
        <button type="button" class="plan-props-delete" data-ul-act="remove">Remove from floor</button>`;
    } else {
      html = `<div class="plan-props-kicker">${P.pdfPageCount ? 'PDF' : 'Image'} underlay</div><div class="plan-props-title">${escHtml(P.name)}</div>
        <div class="plan-props-sec">Position</div>
        <div class="plan-btn-row">${btn('move', 'Move')}${btn('align', 'Align 2 points')}</div>
        <small class="plan-props-note">Align matches two points on this plan to the same points on another underlay.</small>
        <button type="button" class="plan-props-delete" data-ul-act="remove">Remove from floor</button>`;
    }
    el.innerHTML = html;
  },

  _onUnderlayAction(act) {
    const u = this._underlay; if (!u) return;
    if (u.kind === 'dxf') {
      const D = PlanDxfImport.byId(u.id); if (!D) return;
      if (act === 'remove') {
        PlanDxfImport.remove(D.id); this._underlay = null;
        this.renderPalette(); this.renderProps();
        UI.toast(`DXF "${D.name}" removed — press Ctrl+Z or ↶ to undo.`, 'info');
      } else if (act === 'manage' && typeof PlanDxfManager !== 'undefined') PlanDxfManager.open(D.id);
      else if (act === 'move') PlanTools.set('nudgeplan', { dxfId: D.id });
      else if (act === 'align') PlanTools.set('align', { dxfId: D.id, keepScale: !!D.unitM });
      else if (act === 'units') PlanDxfImport.changeUnits(D);
      return;
    }
    const P = this._planById(u.id); if (!P) return;
    if (act === 'remove') {
      const pm = AppState.planMarkup;
      pm.plans = pm.plans.filter(x => x.id !== P.id); this._underlay = null;
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      this.renderPalette(); this.renderProps(); PlanEngine.requestDraw({ all: true });
      // Removal is undoable (image bytes stay server-side) — surface how (UX-13).
      UI.toast('Background plan removed — press Ctrl+Z or ↶ to undo.', 'info');
    } else if (act === 'move') PlanTools.set('nudgeplan', { planId: P.id });
    else if (act === 'align') PlanTools.set('align', { planId: P.id });
  },

  // ─── Placing bar ───
  // Shown over the canvas while a point device is armed: how to place it.
  // The choice (and its grid / spacing settings) is remembered per device
  // type in the plan's settings.
  _placeMem(type) {
    const s = AppState.planMarkup.settings;
    if (!s.placeMemory) s.placeMemory = {};
    if (!s.placeMemory[type]) s.placeMemory[type] = {};
    return s.placeMemory[type];
  },
  placeModeFor(type) {
    const m = (AppState.planMarkup.settings.placeMemory || {})[type];
    return (m && m.mode) || 'single';
  },
  placeOpts(type) {
    const m = (AppState.planMarkup.settings.placeMemory || {})[type] || {};
    return { cols: m.cols || 3, rows: m.rows || 3, by: m.by || 'spacing', spacingM: m.spacingM || 3, count: m.count || 6 };
  },

  renderPlaceBar(toolId, opts) {
    const bar = document.getElementById('plan-placebar');
    const info = document.getElementById('plan-info');
    if (!bar) return;
    const type = opts && opts.type;
    const def = type && PLAN_DEFS.element(type);
    const show = def && ['place', 'array', 'devpath'].includes(toolId);
    bar.hidden = !show;
    if (info) info.hidden = !!show;
    if (!show) { bar.innerHTML = ''; return; }
    const mode = { place: 'single', array: 'array', devpath: 'path' }[toolId];
    const o = this.placeOpts(type);
    bar.setAttribute('aria-label', `How to place ${def.name}`);
    const pic = {
      single: '<circle cx="22" cy="15" r="4.5" class="dv"/><path d="M27 20l6 6" class="ptr"/>',
      array: '<rect x="5" y="4" width="34" height="22" class="box"/><circle cx="12" cy="10" r="2.8" class="dv"/><circle cx="22" cy="10" r="2.8" class="dv"/><circle cx="32" cy="10" r="2.8" class="dv"/><circle cx="12" cy="20" r="2.8" class="dv"/><circle cx="22" cy="20" r="2.8" class="dv"/><circle cx="32" cy="20" r="2.8" class="dv"/>',
      path: '<path d="M4 24L18 10h22" class="box"/><circle cx="6" cy="22" r="2.8" class="dv"/><circle cx="14" cy="14" r="2.8" class="dv"/><circle cx="25" cy="10" r="2.8" class="dv"/><circle cx="37" cy="10" r="2.8" class="dv"/>',
    };
    const choice = (m, title, how) => `<button type="button" class="plan-place-opt${mode === m ? ' active' : ''}" data-place="${m}" aria-pressed="${mode === m}">
      <svg width="44" height="30" viewBox="0 0 44 30" aria-hidden="true">${pic[m]}</svg>
      <span><b>${title}</b><small>${how}</small></span></button>`;
    let extra = '';
    if (mode === 'array') {
      extra = `<div class="plan-place-set">
        <label>Columns<input type="number" min="1" step="1" data-place-opt="cols" value="${o.cols}"></label>
        <label>Rows<input type="number" min="1" step="1" data-place-opt="rows" value="${o.rows}"></label></div>`;
    } else if (mode === 'path') {
      const cal = !!PlanEngine.factor();
      const by = cal ? o.by : 'count';
      extra = `<div class="plan-place-set">
        <label>Place<select data-place-opt="by">${cal ? `<option value="spacing"${by === 'spacing' ? ' selected' : ''}>every</option>` : ''}<option value="count"${by === 'count' ? ' selected' : ''}>a total of</option></select></label>
        ${by === 'spacing' ? `<label class="plan-place-unit"><input type="number" min="0.1" step="0.5" data-place-opt="spacingM" value="${o.spacingM}" aria-label="Spacing in metres"> m</label>`
          : `<label class="plan-place-unit"><input type="number" min="1" step="1" data-place-opt="count" value="${o.count}" aria-label="Number of devices"> devices</label>`}</div>`;
    }
    const keys = { single: 'R rotates the selection', array: 'Drag from corner to corner', path: 'Enter finishes the line' }[mode];
    bar.innerHTML = `<div class="plan-place-what"><small>Placing</small><b><span class="plan-pal-swatch" style="background:${def.color}"></span>${escHtml(def.name)}</b></div>
      ${choice('single', 'One at a time', 'Click for each one')}
      ${choice('array', 'Fill an area', 'Drag a box → rows × columns')}
      ${choice('path', 'Along a line', 'Click points → evenly spaced')}
      ${extra}
      <div class="plan-place-end"><button type="button" class="plan-btn" data-place-stop title="${keys}. Esc stops placing.">Stop <kbd>Esc</kbd></button></div>`;
    if (!bar._bound) {
      bar._bound = true;
      bar.addEventListener('click', (e) => {
        const t = PlanTools.opts && PlanTools.opts.type;
        if (e.target.closest('[data-place-stop]')) { PlanTools.set('select'); return; }
        const b = e.target.closest('[data-place]');
        if (!b || !t) return;
        this._placeMem(t).mode = b.dataset.place;
        PlanMarkup.markDirty();
        PlanTools.set({ single: 'place', array: 'array', path: 'devpath' }[b.dataset.place], { type: t });
      });
      bar.addEventListener('change', (e) => {
        const k = e.target.dataset.placeOpt; const t = PlanTools.opts && PlanTools.opts.type;
        if (!k || !t) return;
        const mem = this._placeMem(t);
        if (k === 'by') mem.by = e.target.value;
        else { const v = parseFloat(e.target.value); if (isFinite(v) && v > 0) mem[k] = (k === 'spacingM') ? v : Math.round(v); }
        PlanMarkup.markDirty();
        if (k === 'by') this.renderPlaceBar(PlanTools.active.id, PlanTools.opts);
      });
    }
  },

  // ─── Properties ───
  renderProps() {
    const el = this.propsEl; if (!el) return;
    if (typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'roomdetect' && typeof PlanRoomDetect !== 'undefined') { PlanRoomDetect.renderOptions(el); return; }
    if (PlanMarkup.context === 'plan' && PlanMarkup.mode === 'underlays') { this._renderUnderlayProps(el); return; }
    const ids = [...PlanMarkup.selectedIds];
    if (ids.length === 0) { el.innerHTML = `<div class="plan-props-empty">Select an item to edit its properties.</div>`; return; }
    if (ids.length > 1) { this._renderBulk(el, ids); return; }
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
      title = item.kind === 'perimeter' ? 'Perimeter / fence' + (f ? ` — ${(PlanEngine._polyLen(item.points) * f).toFixed(0)} m` : '')
        : (item.kind === 'outdoor' ? 'Outdoor area' : 'Room / Area') + (area != null ? ` — ${area.toFixed(1)} m²` : '');
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
    if (kind === 'room' && typeof RoomLighting !== 'undefined') {
      // The lighting settings are edited on the Lighting tab.
      if (PlanMarkup.context === 'lighting') { RoomLighting.bind(el); html += RoomLighting.panel(item); }
      else html += `<button type="button" class="plan-btn" data-role="open-lighting">Lighting for this ${({ escape: 'route', perimeter: 'fence', outdoor: 'area' })[item.kind] || 'room'}…</button>`;
    }
    html += this._defaultCableButton(item, kind);
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
    if (typeof RoomLighting !== 'undefined') RoomLighting.tipify(el, kind === 'element' ? item.type : null);
  },

  // ─── Bulk edit (several items of one kind + type selected) ───
  // The field list and value reader for one entity, shared by the bulk panel.
  _bulkSpec(kind, item) {
    if (kind === 'element') {
      const def = PLAN_DEFS.element(item.type);
      return { title: def ? def.name : item.type,
        fields: ((def && def.fields) || []).concat([{ key: 'symScale', label: 'Symbol scale ×', type: 'number', min: 0.25, max: 10, step: 0.25 }]),
        get: (it, k) => (k === 'symScale') ? (it.scale || '') : (k === 'rotation') ? it.rotation : (it.props ? it.props[k] : undefined) };
    }
    if (kind === 'route') {
      const def = PLAN_DEFS.route(item.type);
      return { title: def ? def.name : item.type,
        fields: ((def && def.fields) || []).concat([{ key: 'curved', label: 'Curved', type: 'checkbox' }]),
        get: (it, k) => (k === 'cableType') ? it.cableType : (k === 'curved') ? !!it.curved : (it.props ? it.props[k] : undefined) };
    }
    if (kind === 'trench') {
      return { title: 'Trenches',
        fields: [{ key: 'excType', label: 'Type', type: 'select', options: Object.keys(PLAN_DEFS.trenchTypes).map(k => ({ value: k, label: PLAN_DEFS.trenchTypes[k].name })) }],
        get: (it, k) => it[k] };
    }
    if (kind === 'crossing') {
      return { title: 'Road crossings',
        fields: [{ key: 'size', label: 'Duct (mm)', type: 'select', options: PLAN_DEFS.crossings.sizes.map(x => ({ value: x, label: x })) }],
        get: (it, k) => it[k] };
    }
    if (kind === 'text') {
      return { title: 'Text labels', fields: PLAN_DEFS.annotations.text.fields.filter(f => f.key !== 'text'), get: (it, k) => it[k] };
    }
    if (kind === 'room') return { title: 'Rooms / areas', fields: [], get: () => '' };
    return { title: kind === 'measurement' ? 'Measurements' : kind, fields: [], get: () => '' };
  },

  _renderBulk(el, ids) {
    const items = ids.map(id => PlanMarkup.findEntityById(id)).filter(Boolean);
    const n = items.length;
    const kind = items[0] && items[0].kind;
    const same = items.length && items.every(f => f.kind === kind &&
      (kind === 'element' || kind === 'route' ? f.item.type === items[0].item.type : true));
    const del = `<button class="plan-props-delete" data-role="delete">Delete ${n} items</button>`;
    if (!same) {
      el.innerHTML = `<div class="plan-props-title">${n} items selected</div>
        <div class="plan-props-empty">Mixed types. Right-click one and choose <b>Select similar</b> to edit them together.</div>${del}`;
      return;
    }
    if (kind === 'route' && items.some(f => !f.item.cableType) && typeof PlanSync !== 'undefined' && PlanSync.fillEmptyCables) PlanSync.fillEmptyCables();
    const spec = this._bulkSpec(kind, items[0].item);
    let html = `<div class="plan-props-title">${n} × ${escHtml(spec.title)}</div>`;
    const mixed = [];
    for (const f of spec.fields) {
      if (f.key === 'name') continue;
      const vals = items.map(x => spec.get(x.item, f.key));
      const first = vals[0];
      const isMixed = vals.some(v => String(v == null ? '' : v) !== String(first == null ? '' : first));
      if (isMixed) mixed.push(f.key);
      html += this._field(f, isMixed ? '' : first);
    }
    if (!spec.fields.length) html += `<div class="plan-props-empty">Nothing to edit in bulk for this kind.</div>`;
    html += del;
    el.innerHTML = html;
    for (const k of mixed) {
      const c = el.querySelector(`[data-key="${k}"]`);
      if (!c) continue;
      if (c.tagName === 'SELECT') {
        const o = document.createElement('option');
        o.value = '__mixed__'; o.textContent = '— mixed —'; o.selected = true;
        c.insertBefore(o, c.firstChild);
        const cur = c.closest('.plan-field') && c.closest('.plan-field').querySelector('.plan-field-current');
        if (cur) cur.textContent = 'Mixed — values differ';
      } else if (c.type === 'checkbox') c.indeterminate = true;
      else c.placeholder = 'mixed';
    }
    this._searchifyCables(el);
  },

  // A field edited while several like items are selected: write it to all.
  _onBulkChange(e, key, ids) {
    if (key === 'name') return;
    const items = ids.map(id => PlanMarkup.findEntityById(id)).filter(Boolean);
    if (!items.length) return;
    if (e.target.tagName === 'SELECT' && e.target.value === '__mixed__') return;
    if (e.target.tagName === 'SELECT' && e.target.value === '__all__') {
      const first = items[0];
      const def = first.kind === 'route' ? PLAN_DEFS.route(first.item.type) : null;
      const field = def && (def.fields || []).find(f => f.key === key);
      CableLib.handleShowAll(e.target, first.item[key], (v) => this._cableOptions(v, field, true));
      return;
    }
    let val = e.target.value;
    if (e.target.type === 'number') val = parseFloat(val) || 0;
    if (e.target.type === 'checkbox') { val = e.target.checked; e.target.indeterminate = false; }
    const commit = (e.type === 'change');
    let circuitTouched = false;
    for (const { kind, item } of items) {
      if (kind === 'element') {
        if (key === 'rotation') item.rotation = val;
        else if (key === 'symScale') { if (val > 0 && val !== 1) item.scale = Math.min(10, val); else delete item.scale; }
        else {
          item.props = item.props || {}; item.props[key] = val;
          if (/^(circuitDbId|circuitNo|poles|load_va)$/.test(key)) {
            circuitTouched = true;
            if (key === 'circuitDbId' || key === 'circuitNo') delete item.props.circuitWid;
            if (!val && key === 'circuitDbId') delete item.props.circuitNo;
          }
        }
      } else if (kind === 'route') {
        if (key === 'cableType') {
          item.cableType = val;
          if (commit && typeof PlanSync !== 'undefined' && PlanSync.pushRouteCable) PlanSync.pushRouteCable(item);
        } else if (key === 'curved') item.curved = val;
        else { item.props = item.props || {}; item.props[key] = val; }
      if (key === 'photoId' && commit && typeof PhotoLib !== 'undefined') {
        // Taking a library luminaire: its watts replace the nameplate guess and any flux override goes.
        const ph = PhotoLib.get(val);
        if (ph) { item.props.watts = Math.round(ph.watts || item.props.watts || 0); item.props.lumens = ''; }
        this.renderProps();
      }
      } else {
        item[key] = val;
      }
    }
    if (circuitTouched && commit && typeof PlanCircuits !== 'undefined') {
      PlanCircuits.syncLoads();
      if (PlanCircuits.syncRoutedLengths) PlanCircuits.syncRoutedLengths();
      if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();
    }
    PlanEngine.requestDraw({ fg: true });
    if (commit) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.renderProps(); }
  },

  // Reticulation routes: "use this cable as the default for <route type>" —
  // stored in the Demand settings (Quick Build) so new routes and Demand rows
  // of that type start with it.
  _defaultCableButton(item, kind) {
    if (kind !== 'route' || typeof PlanSync === 'undefined' || !AppState.reticulation) return '';
    if (AppState.planMarkup.settings.domain !== 'retic' || !PlanSync._defaultKeyFor(item.type)) return '';
    const R = AppState.reticulation, key = PlanSync._defaultKeyFor(item.type);
    const def = R.settings[key] || '';
    const name = (PLAN_DEFS.route(item.type) || {}).name || item.type;
    const isDef = !!item.cableType && item.cableType === def;
    return `<div class="plan-field">
      <button class="plan-circuit-btn" data-role="set-default-cable"${item.cableType && !isDef ? '' : ' disabled'}
        title="New ${escHtml(name)} routes (and empty ones already drawn) will take this cable">★ Use as default for ${escHtml(name)} routes</button>
      <div class="plan-field-current">${def ? 'Default: <b>' + escHtml(def) + '</b>' : 'No default set'}</div></div>`;
  },

  _setDefaultCable() {
    const ids = [...PlanMarkup.selectedIds];
    const found = ids.length === 1 && PlanMarkup.findEntityById(ids[0]);
    if (!found || found.kind !== 'route') return;
    if (PlanSync.setDefaultCable(found.item)) {
      UI.toast('Default cable set for ' + ((PLAN_DEFS.route(found.item.type) || {}).name || found.item.type) + ' routes.', 'success');
      this.renderProps();
    }
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
    const notLinked = () => `<div class="plan-demand"><div class="plan-demand-title">From Demand</div><div class="plan-demand-row"><span>Not in Demand yet — Output › Push to Demand schedules.</span></div></div>`;
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
    if (f.type === 'photo_select') {
      const libs = (typeof PhotoLib !== 'undefined') ? PhotoLib.list() : [];
      const opts = ['<option value="">— none (not calculated) —</option>'].concat(libs.map(p =>
        `<option value="${escHtml(p.id)}"${p.id === v ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`)).join('');
      return `<div class="plan-field">${label}<select data-key="${f.key}">${opts}</select></div>
        <button class="plan-circuit-btn" data-role="open-photolib">💡 Luminaire library…</button>`;
    }
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
    if (ids.length > 1) { this._onBulkChange(e, key, ids); return; }
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
