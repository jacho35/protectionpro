/* ProtectionPro — Plan layers.
 *
 * A layer is a named set of item types (devices, routes, trench types) with a
 * colour. Choosing one in the Show picker ISOLATES it: the other layers are
 * ghosted (or hidden, by project setting) and cannot be clicked, box-selected
 * or snapped to. Independently of the picker a layer can be hidden or locked
 * (visible but not selectable), renamed, recoloured, and its contents edited
 * in Layers… (new layers are saved with the project like the built-in ones).
 *
 * Pure rules live in `state` / `alpha` / `pickable`; the engine asks them for
 * every item it draws or hit-tests. Custom load types appear as items
 * `load:<typeId>` (plan-loads.js).
 */
const PlanLayers = {
  ghostAlpha: 0.25,

  // The layers of the plan's domain — the same set the Show picker lists.
  forDomain(pm) {
    pm = pm || AppState.planMarkup;
    const building = !!(pm.settings && pm.settings.domain === 'building');
    return (pm.layers || []).filter(L => building ? L.discipline === 'building' : L.discipline !== 'building');
  },
  active(pm) {
    pm = pm || AppState.planMarkup;
    return this.forDomain(pm).find(L => L.id === pm.activeLayerId) || null;
  },
  others(pm) {
    pm = pm || AppState.planMarkup;
    return (pm.settings && pm.settings.layerOthers) === 'hide' ? 'hide' : 'ghost';
  },

  // The keys an element answers to in a layer's visibleElementTypes: its type,
  // and for a custom load also its load type ('load:pump'). A layer that lists
  // plain 'load' holds every custom load (the LV layer, so a cable can end on one).
  elementKeys(el) {
    const k = [el.type];
    if (el.type === 'load' && el.props && el.props.loadType) k.unshift('load:' + el.props.loadType);
    return k;
  },

  _has(L, listKey, keys) {
    const list = L[listKey] || [];
    return keys.some(k => list.includes(k));
  },

  // → { mode: 'full' | 'ghost' | 'hidden', locked }. `listKey` is one of
  // visibleElementTypes | routeTypes | trenchTypes; `keys` the item's type keys.
  state(listKey, keys) {
    const pm = AppState.planMarkup;
    if (!pm) return { mode: 'full', locked: false };
    const layers = this.forDomain(pm);
    const a = layers.find(L => L.id === pm.activeLayerId);
    if (a) {
      if (this._has(a, listKey, keys)) return { mode: 'full', locked: !!a.locked };
      return { mode: this.others(pm) === 'hide' ? 'hidden' : 'ghost', locked: true };
    }
    const own = layers.filter(L => this._has(L, listKey, keys));
    if (!own.length) return { mode: 'full', locked: false };       // not on any layer
    const shown = own.filter(L => L.visible !== false);
    if (!shown.length) return { mode: 'hidden', locked: true };
    return { mode: 'full', locked: shown.every(L => L.locked) };
  },
  alpha(listKey, keys) {
    const s = this.state(listKey, keys);
    return s.mode === 'full' ? 1 : s.mode === 'ghost' ? this.ghostAlpha : 0;
  },
  pickable(listKey, keys) {
    const s = this.state(listKey, keys);
    return s.mode === 'full' && !s.locked;
  },
  pickableEl(el) { return this.pickable('visibleElementTypes', this.elementKeys(el)); },
  pickableRoute(r) { return this.pickable('routeTypes', [r.type]); },
  pickableTrench(t) { return this.pickable('trenchTypes', [t.excType]); },

  // Drop anything the layer rules now make unselectable.
  pruneSelection() {
    if (typeof PlanMarkup === 'undefined') return;
    let changed = false;
    for (const id of [...PlanMarkup.selectedIds]) {
      const f = PlanMarkup.findEntityById(id);
      if (!f) continue;
      const ok = f.kind === 'element' ? this.pickableEl(f.item)
        : f.kind === 'route' ? this.pickableRoute(f.item)
        : f.kind === 'trench' ? this.pickableTrench(f.item) : true;
      if (!ok) { PlanMarkup.selectedIds.delete(id); changed = true; }
    }
    if (changed && PlanMarkup.refreshProps) PlanMarkup.refreshProps();
  },

  setActive(id) {
    AppState.planMarkup.activeLayerId = id || null;
    this.afterChange(false);
  },

  // Redraw, refresh pickers and (when `commit`) record an undo step.
  afterChange(commit) {
    this.pruneSelection();
    if (typeof PlanMarkup !== 'undefined') {
      if (PlanMarkup._refreshLayerPicker) PlanMarkup._refreshLayerPicker();
      if (commit) { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    }
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  // ── Choices a layer can hold ──
  elementChoices(domain) {
    const out = [];
    for (const [type, def] of Object.entries(PLAN_DEFS.elements)) {
      if (def.domain !== domain || def.adoptOnly || type === 'load') continue;
      out.push({ key: type, name: def.name });
    }
    if (domain === 'retic' && typeof PlanLoads !== 'undefined') {
      out.push({ key: 'load', name: 'All custom loads' });
      for (const t of PlanLoads.list()) out.push({ key: 'load:' + t.id, name: t.name + ' (load)' });
    }
    return out;
  },
  routeChoices(domain) {
    const out = [];
    for (const [type, def] of Object.entries(PLAN_DEFS.routes)) {
      if (def.domain === domain) out.push({ key: type, name: def.name });
    }
    if (domain === 'retic') out.push({ key: 'loadfeed', name: 'Load supply cable' });
    return out;
  },
  trenchChoices() {
    return Object.entries(PLAN_DEFS.trenchTypes).map(([key, d]) => ({ key, name: d.name }));
  },

  // Default layers of a domain, with the load layer holding every load type.
  defaultsFor(domain) {
    const building = domain === 'building';
    const out = PLAN_DEFAULT_LAYERS.filter(L => building ? L.discipline === 'building' : L.discipline !== 'building')
      .map(L => JSON.parse(JSON.stringify(L)));
    const loads = out.find(L => L.id === 'loads');
    if (loads && typeof PlanLoads !== 'undefined') {
      loads.visibleElementTypes = ['minisub', 'kiosk', 'erf', 'load'].concat(PlanLoads.list().map(t => 'load:' + t.id));
    }
    return out;
  },

  // ── Manager dialog ──
  openManager() {
    const overlay = document.createElement('div');
    overlay.className = 'modal plan-layers-modal';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '3000';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Layers');
    const open = new Set();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    document.addEventListener('keydown', onKey, true);

    const chips = (L, listKey, choices) => choices.length
      ? `<div class="ply-chips">${choices.map(c => {
          const on = (L[listKey] || []).includes(c.key);
          return `<button type="button" class="ply-chip${on ? ' on' : ''}" style="--lc:${escHtml(L.color)}" data-role="chip" data-list="${listKey}" data-key="${escHtml(c.key)}" aria-pressed="${on}">${escHtml(c.name)}</button>`;
        }).join('')}</div>`
      : '<div class="ply-none">None for this plan type.</div>';

    const render = () => {
      const pm = AppState.planMarkup;
      const domain = (pm.settings.domain === 'building') ? 'building' : 'retic';
      const layers = this.forDomain(pm);
      const rows = layers.map(L => {
        const isOpen = open.has(L.id), isActive = pm.activeLayerId === L.id;
        return `<div class="ply-layer${isActive ? ' active' : ''}${isOpen ? ' open' : ''}" data-layer="${escHtml(L.id)}" style="--lc:${escHtml(L.color)}">
          <div class="ply-row">
            <input type="color" value="${escHtml(L.color)}" data-role="color" aria-label="Colour of ${escHtml(L.name)}">
            <input type="text" class="ply-name" value="${escHtml(L.name)}" data-role="name" aria-label="Layer name">
            <button type="button" class="ply-ib${isActive ? ' on' : ''}" data-role="only" title="Show only this layer" aria-pressed="${isActive}">Only</button>
            <button type="button" class="ply-ib${L.visible === false ? '' : ' on'}" data-role="vis" title="${L.visible === false ? 'Hidden — click to show' : 'Visible — click to hide'}" aria-pressed="${L.visible !== false}">${L.visible === false ? 'Hidden' : 'Shown'}</button>
            <button type="button" class="ply-ib${L.locked ? ' on' : ''}" data-role="lock" title="Locked layers stay visible but can't be selected" aria-pressed="${!!L.locked}">${L.locked ? 'Locked' : 'Unlocked'}</button>
            <button type="button" class="ply-ib" data-role="open" aria-expanded="${isOpen}" title="Choose what is on this layer">${isOpen ? 'Close' : 'Contents'}</button>
          </div>
          ${isOpen ? `<div class="ply-body">
            <h4>Devices</h4>${chips(L, 'visibleElementTypes', this.elementChoices(domain))}
            <h4>Routes</h4>${chips(L, 'routeTypes', this.routeChoices(domain))}
            <h4>Trenches</h4>${chips(L, 'trenchTypes', this.trenchChoices())}
            <div class="ply-row"><button type="button" class="ply-ib" data-role="del">Delete layer</button></div>
          </div>` : ''}
        </div>`;
      }).join('');
      overlay.innerHTML = `<div class="modal-content plan-layers-content">
        <div class="modal-header"><h3>Layers</h3></div>
        <div class="modal-body">
          <p class="ply-help">Pick a layer in <b>Show</b> to work on it alone. Hide a layer to take it off the drawing, or lock it so it stays visible but can't be moved or deleted by accident. A device that sits on several layers stays editable until every layer it is on is hidden or locked.</p>
          <label class="ply-others">While one layer is shown, the other layers are
            <select data-role="others"><option value="ghost"${this.others(pm) === 'ghost' ? ' selected' : ''}>faded (and locked)</option><option value="hide"${this.others(pm) === 'hide' ? ' selected' : ''}>hidden</option></select></label>
          <label class="ply-others">Route length labels on the plan
            <select data-role="rlabels">${[['all', 'every route'], ['selected', 'the selected route only'], ['none', 'none']].map(([v, t]) => `<option value="${v}"${((pm.settings || {}).routeLabels || 'all') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
          <div class="ply-list">${rows || '<div class="ply-none">No layers.</div>'}</div>
          <div class="ply-foot">
            <button type="button" class="btn-small" data-role="add">+ New layer</button>
            <button type="button" class="btn-small" data-role="showall">Show all layers</button>
            <button type="button" class="btn-small" data-role="reset">Reset to defaults</button>
            <span class="ply-spacer"></span>
            <button type="button" class="btn-primary" data-role="close">Done</button>
          </div>
        </div></div>`;
    };

    const layerOf = (el) => {
      const row = el.closest('[data-layer]');
      return row && this.forDomain().find(L => L.id === row.dataset.layer);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { close(); return; }
      const b = e.target.closest('button[data-role]'); if (!b) return;
      const pm = AppState.planMarkup, role = b.dataset.role, L = layerOf(b);
      const domain = (pm.settings.domain === 'building') ? 'building' : 'retic';
      if (role === 'close') { close(); return; }
      if (role === 'add') {
        const id = 'lyr_' + Date.now().toString(36);
        const n = this.forDomain(pm).length + 1;
        pm.layers.push({ id, name: 'Layer ' + n, discipline: domain === 'building' ? 'building' : 'custom',
          color: ['#a855f7', '#0ea5e9', '#db2777', '#14b8a6', '#f59e0b'][n % 5],
          visibleElementTypes: [], routeTypes: [], trenchTypes: [], showCrossings: false, drawingNo: '', revision: '' });
        open.add(id);
      } else if (role === 'showall') {
        pm.layers.forEach(l => { l.visible = true; }); pm.activeLayerId = null;
      } else if (role === 'reset') {
        const keep = pm.layers.filter(l => !this.forDomain(pm).includes(l));
        pm.layers = keep.concat(this.defaultsFor(domain));
        pm.activeLayerId = null; open.clear();
      } else if (L) {
        if (role === 'only') pm.activeLayerId = (pm.activeLayerId === L.id) ? null : L.id;
        else if (role === 'vis') L.visible = (L.visible === false);
        else if (role === 'lock') L.locked = !L.locked;
        else if (role === 'open') { open.has(L.id) ? open.delete(L.id) : open.add(L.id); render(); return; }
        else if (role === 'del') {
          pm.layers = pm.layers.filter(l => l !== L);
          if (pm.activeLayerId === L.id) pm.activeLayerId = null;
        } else if (role === 'chip') {
          const list = (L[b.dataset.list] = L[b.dataset.list] || []);
          const i = list.indexOf(b.dataset.key);
          i < 0 ? list.push(b.dataset.key) : list.splice(i, 1);
        }
      } else return;
      this.afterChange(true); render();
    });
    // Typing: apply live, no re-render (keeps focus); snapshot when committed.
    overlay.addEventListener('input', (e) => {
      const L = layerOf(e.target); if (!L) return;
      if (e.target.dataset.role === 'name') L.name = e.target.value || 'Layer';
      else if (e.target.dataset.role === 'color') { L.color = e.target.value; e.target.closest('[data-layer]').style.setProperty('--lc', L.color); }
      else return;
      if (PlanMarkup._refreshLayerPicker) PlanMarkup._refreshLayerPicker();
      PlanEngine.requestDraw({ fg: true });
    });
    overlay.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      if (role === 'rlabels') { AppState.planMarkup.settings.routeLabels = e.target.value; PlanMarkup.markDirty(); PlanEngine.requestDraw({ all: true }); return; }
      if (role === 'others') { AppState.planMarkup.settings.layerOthers = e.target.value; this.afterChange(true); return; }
      if (role === 'name' || role === 'color') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    });
    render();
    document.body.appendChild(overlay);
  },
};
