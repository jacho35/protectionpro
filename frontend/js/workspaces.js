/* ProtectionPro — project type & workspace visibility.
 *
 * A project is a Reticulation, Building, Network/plant or Lighting project,
 * and that decides which workspace tabs it shows, in workflow order:
 *
 *   Reticulation  1 Site plan › 2 Demand › 3 Street lighting › 4 Single-line
 *   Building      1 Floor plans › 2 Single-line › 3 Schedules › 4 Lighting › 5 Quantities
 *   Network       Single-line · Interlocking
 *   Lighting      1 Overview › 2 Plans › 3 Rooms › 4 Roads › 5 Sports fields
 *
 * A Lighting project shows only the designs it was set up for
 * (`AppState.lightingKinds`: rooms / roads / sports). Its tabs are existing
 * workspaces under other names: Rooms is the Lighting workspace scoped to
 * rooms and areas, Sports fields the same workspace scoped to fields
 * (LightingWS.scope), Roads the Street lighting workspace without its
 * Circuits view unless `AppState.roadCircuits` is on. The single line is not
 * shown until the project has components or the user adds it.
 *
 * Extra workspaces can be switched on per project (Project type & workspaces
 * dialog), and a workspace that holds data is NEVER hidden — so a project can
 * never lose sight of its own content.
 *
 * `AppState.projectType` is only stored once the user picks a type (New
 * project, or the dialog). A legacy project without one has its type INFERRED
 * live from its content, so opening an old file changes nothing in it.
 *
 * Workspace keys are the ones switchWorkspace() already uses:
 *   'plan' | 'retic' (shown as "Demand") | 'streetlight' | 'sld' | 'schedules' | 'interlock'
 */

const Workspaces = {
  TYPES: {
    retic: {
      label: 'Reticulation',
      desc: 'A township or site LV network: minisubs, kiosks and erven, sized by ADMD (NRS 034-1).',
      core: ['plan', 'retic', 'streetlight', 'sld', 'quantities'],
      planDomain: 'retic',
    },
    building: {
      label: 'Building',
      desc: 'Floors, distribution boards and final circuits, down to each way.',
      core: ['plan', 'sld', 'schedules', 'lighting', 'quantities'],
      planDomain: 'building',
    },
    network: {
      label: 'Network / plant',
      desc: 'Substations, industrial and utility networks: single-line studies and breaker interlocking.',
      core: ['sld', 'interlock'],
      planDomain: null,
    },
    lighting: {
      label: 'Lighting',
      desc: 'Lighting design only: rooms, roads and sports fields. Lux, glare, energy and the report; circuits optional.',
      // The full set; core('lighting') keeps the ones its designs need.
      core: ['lightov', 'plan', 'lighting', 'streetlight', 'sports'],
      planDomain: 'building',
    },
  },
  // What a Lighting project designs, and the tabs each one brings.
  KINDS: {
    rooms: { label: 'Rooms & areas', desc: 'Indoor rooms, outdoor areas, fences, escape routes. Em, U₀, UGR, LENI, emergency.', ws: ['plan', 'lighting'] },
    roads: { label: 'Roads', desc: 'Cross-sections and road plans. SANS 10098 or EN 13201, junctions, TI.', ws: ['streetlight'] },
    sports: { label: 'Sports fields', desc: 'Pitches, masts and aimed floods. Eh, U₂, GR, stands, TV.', ws: ['plan', 'sports'] },
  },
  // Workspaces that exist only in a Lighting project.
  LIGHTING_ONLY: ['lightov', 'sports'],
  // Canonical order for workspaces outside a type's core set.
  ORDER: ['lightov', 'plan', 'retic', 'streetlight', 'sld', 'schedules', 'lighting', 'sports', 'interlock', 'quantities'],
  TAB_IDS: {
    sld: 'btn-workspace-sld', retic: 'btn-workspace-retic', streetlight: 'btn-workspace-streetlight', plan: 'btn-workspace-plan',
    interlock: 'btn-workspace-interlock', schedules: 'btn-workspace-schedules', quantities: 'btn-workspace-quantities', lighting: 'btn-workspace-lighting',
    lightov: 'btn-workspace-lightov', sports: 'btn-workspace-sports',
  },
  DESCS: {
    plan: 'Site or floor plans with devices, routes and circuits',
    retic: 'Reticulation: kiosks, erven and ADMD demand',
    streetlight: 'Street lighting circuits: volt drop per pole, earth loop, phase balance',
    sld: 'The electrical model and every study',
    schedules: 'Distribution-board circuit schedules and checks',
    interlock: 'Breaker interlocking logic, simulated against the single-line',
    quantities: 'Bill of quantities, cable schedules and the rate library',
    lighting: 'Rooms, outdoor areas, fences and escape routes: lux, glare, energy and emergency lighting',
    lightov: 'Every lighting design with its verdict, Calculate all and the report',
    sports: 'Sports fields: masts, aimed floods, stands and TV',
  },

  // ── Type ────────────────────────────────────────────────────────────
  // The stored type, else the one the project's content implies.
  type() {
    const t = AppState.projectType;
    return this.TYPES[t] ? t : this.inferType();
  },
  isExplicit() { return !!this.TYPES[AppState.projectType]; },

  // A Lighting project's designs (all three when never chosen).
  lightingKinds() {
    const k = Array.isArray(AppState.lightingKinds) ? AppState.lightingKinds.filter(x => this.KINDS[x]) : [];
    return k.length ? k : Object.keys(this.KINDS);
  },
  // The type's own tabs, in order.
  core(type) {
    if (type !== 'lighting') return this.TYPES[type].core;
    const want = new Set(['lightov']);
    for (const k of this.lightingKinds()) for (const ws of this.KINDS[k].ws) want.add(ws);
    return this.TYPES.lighting.core.filter(ws => want.has(ws));
  },
  // A Lighting design kind that already holds data can't be switched off.
  kindHasData(kind) {
    if (kind === 'roads') {
      const sl = AppState.reticulation && AppState.reticulation.streetLighting;
      return !!(sl && ((sl.roadDesigns && sl.roadDesigns.length) || (sl.roadPlan && sl.roadPlan.roads && sl.roadPlan.roads.length)));
    }
    return typeof LightingWS !== 'undefined' && LightingWS.hasData(kind === 'sports' ? 'sports' : 'rooms');
  },
  // Street-light circuits (the Roads tab's Circuits view).
  roadCircuitsOn() {
    if (this.type() !== 'lighting' || AppState.roadCircuits) return true;
    const sl = AppState.reticulation && AppState.reticulation.streetLighting;
    return !!(sl && sl.circuits && sl.circuits.length);
  },

  inferType() {
    const pm = AppState.planMarkup;
    const planFilled = pm && typeof AppState._planMarkupIsEmpty === 'function' && !AppState._planMarkupIsEmpty();
    const domain = pm && pm.settings && pm.settings.domain;
    const retic = this._reticHasData() || (planFilled && domain === 'retic');
    const building = (planFilled && domain === 'building') || this._schedulesHaveData();
    if (building) return 'building';   // both → building core; retic stays visible via its data
    if (retic) return 'retic';
    return 'network';
  },

  // ── Data presence (a workspace with data is never hidden) ───────────
  _reticHasData() {
    const R = AppState.reticulation;
    return !!(R && Array.isArray(R.kiosks) && R.kiosks.length);
  },
  _schedulesHaveData() {
    for (const c of AppState.components.values()) {
      if (c.type === 'distribution_board' && Array.isArray(c.props && c.props.circuits) && c.props.circuits.length) return true;
    }
    return false;
  },
  hasData(ws) {
    switch (ws) {
      case 'sld': return this.type() !== 'lighting' || AppState.components.size > 0;
      case 'retic': return this._reticHasData();
      case 'streetlight': { const sl = AppState.reticulation && AppState.reticulation.streetLighting; return !!(sl && ((sl.circuits && sl.circuits.length) || (sl.roadDesigns && sl.roadDesigns.length))); }
      case 'plan': return typeof AppState._planMarkupIsEmpty === 'function' && !AppState._planMarkupIsEmpty();
      case 'interlock': return !!(AppState.interlockLogic && AppState.interlockLogic.nodes && AppState.interlockLogic.nodes.length);
      case 'schedules': return this._schedulesHaveData();
      case 'lighting': return typeof LightingWS !== 'undefined' && LightingWS.hasData(this.type() === 'lighting' ? 'rooms' : undefined);
      case 'sports': return this.type() === 'lighting' && this.kindHasData('sports');
      // A project that already priced something keeps its Quantities tab.
      case 'quantities': { const L = AppState.rateLibrary; return !!(L && ((L.items && Object.keys(L.items).length) || (L.custom && Object.keys(L.custom).length))); }
      default: return false;
    }
  },

  // ── Visible workspaces, in display order ────────────────────────────
  visible() {
    const t = this.type();
    const core = this.core(t);
    const extras = Array.isArray(AppState.extraWorkspaces) ? AppState.extraWorkspaces : [];
    const out = core.slice();
    for (const ws of this.ORDER) {
      if (out.includes(ws) || (t !== 'lighting' && this.LIGHTING_ONLY.includes(ws))) continue;
      if (extras.includes(ws) || this.hasData(ws)) out.push(ws);
    }
    return out;
  },
  isVisible(ws) { return this.visible().includes(ws); },

  // Step number of a core workspace in a stepped (retic/building) project.
  step(ws) {
    const t = this.type();
    if (t === 'network') return null;
    const i = this.core(t).indexOf(ws);
    return i >= 0 ? i + 1 : null;
  },

  label(ws) {
    if (this.type() === 'lighting') {
      const l = this._coreLabel('lighting', ws);
      if (l) return l;
    }
    if (ws === 'plan') {
      const d = AppState.planMarkup && AppState.planMarkup.settings && AppState.planMarkup.settings.domain;
      return d === 'building' ? 'Floor plans' : 'Site plan';
    }
    return { sld: 'Single-line', retic: 'Demand', streetlight: 'Street lighting', schedules: 'Schedules', interlock: 'Interlocking', quantities: 'Quantities', lighting: 'Lighting' }[ws] || ws;
  },

  // ── Plan domain follows the type ────────────────────────────────────
  // The type sets the Plan workspace's domain when the plan is empty or already
  // in that domain. A plan holding the OTHER domain's content is left alone, and
  // its own selector stays visible (planDomainLocked() is then false).
  _applyPlanDomain() {
    const want = this.TYPES[this.type()].planDomain;
    const pm = AppState.planMarkup;
    if (!want || !pm || !pm.settings) return;
    const empty = typeof AppState._planMarkupIsEmpty === 'function' && AppState._planMarkupIsEmpty();
    if (empty && pm.settings.domain !== want) pm.settings.domain = want;
  },
  planDomainLocked() {
    const want = this.TYPES[this.type()].planDomain;
    const pm = AppState.planMarkup;
    return !!(want && pm && pm.settings && pm.settings.domain === want);
  },

  // ── Tabs ───────────────────────────────────────────────────────────
  // Re-order and show/hide the workspace tabs, label
  // them for the project type, and leave a hidden active workspace for the SLD.
  refresh() {
    this._applyPlanDomain();
    const vis = this.visible();
    const switcher = document.querySelector('#toolbar .workspace-switch');
    let activeHidden = false;
    // Visible tabs first, in display order; hidden ones after, so the
    // `.workspace-tab + .workspace-tab` divider rule stays correct.
    const ordered = vis.concat(this.ORDER.filter(ws => !vis.includes(ws)));
    for (const ws of ordered) {
      const b = document.getElementById(this.TAB_IDS[ws]);
      if (!b) continue;
      const show = vis.includes(ws);
      b.hidden = !show;
      if (!show && b.classList.contains('active')) activeHidden = true;
      const n = this.step(ws);
      b.innerHTML = (n ? `<span class="ws-step" aria-hidden="true">${n}</span>` : '') + escHtml(this.label(ws));
      if (switcher) switcher.appendChild(b);
    }
    const chip = document.getElementById('project-type-chip');
    if (chip) {
      chip.textContent = this.TYPES[this.type()].label;
      chip.title = (this.isExplicit() ? 'Project type' : 'Project type (inferred from the content)') +
        ' — click to change the type or add workspaces';
    }
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active) {
      if (typeof PlanUI !== 'undefined' && PlanUI.renderPalette) PlanUI.renderPalette();
      if (PlanMarkup.updatePushButton) PlanMarkup.updatePushButton();
      if (PlanMarkup.refreshFloorBar) PlanMarkup.refreshFloorBar();
    }
    if (activeHidden && typeof window.switchWorkspace === 'function') window.switchWorkspace(vis[0] || 'sld');
  },
  onProjectChanged() { this.refresh(); },

  // `lighting` ({kinds, circuits}) applies to a Lighting project.
  setType(type, extras, lighting) {
    if (!this.TYPES[type]) return;
    AppState.projectType = type;
    if (type === 'lighting' && lighting) {
      AppState.lightingKinds = (lighting.kinds || []).filter(k => this.KINDS[k]);
      AppState.roadCircuits = !!lighting.circuits;
    }
    AppState.extraWorkspaces = (extras || []).filter(ws => this.ORDER.includes(ws) && !this.core(type).includes(ws));
    AppState.dirty = true;
    this.refresh();
  },

  // ── Dialogs ────────────────────────────────────────────────────────
  // Shared modal shell (same look and keyboard handling as UI's dialogs).
  _modal(title, bodyHtml, okText) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal ui-dialog';
      overlay.style.zIndex = '3000';
      overlay.innerHTML = `<div class="modal-content ws-dialog" role="dialog" aria-modal="true" aria-labelledby="ws-dialog-title">
        <div class="modal-header"><h3 id="ws-dialog-title">${escHtml(title)}</h3></div>
        <div class="modal-body">${bodyHtml}
          <div class="ui-dialog-actions">
            <button type="button" class="btn-small" data-ws-cancel>Cancel</button>
            <button type="button" class="btn-primary" data-ws-ok>${escHtml(okText)}</button>
          </div>
        </div></div>`;
      document.body.appendChild(overlay);
      const content = overlay.firstElementChild;
      let done = false;
      const close = (ok) => {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        const result = ok ? content : null;
        resolve(result);
        overlay.remove();
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) { /* gone */ } }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      };
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
      content.querySelector('[data-ws-cancel]').addEventListener('click', () => close(false));
      content.querySelector('[data-ws-ok]').addEventListener('click', () => close(true));
      // Card-style radio groups: one pressed at a time.
      content.addEventListener('click', (e) => {
        const card = e.target.closest('[data-ws-type]');
        if (!card) return;
        content.querySelectorAll('[data-ws-type]').forEach(c => c.setAttribute('aria-pressed', String(c === card)));
        content.dispatchEvent(new CustomEvent('ws-type-change', { detail: card.dataset.wsType }));
      });
      setTimeout(() => {
        const first = content.querySelector('[aria-pressed="true"]') || content.querySelector('[data-ws-ok]');
        if (first) first.focus();
      }, 0);
    });
  },

  _typeCardsHtml(selected) {
    return `<div class="ws-type-cards">${Object.entries(this.TYPES).map(([id, t]) => {
      const flow = id === 'lighting' ? '1 Overview › your design tabs'
        : t.core.map((ws, i) => (id === 'network' ? '' : (i + 1) + ' ') + this._coreLabel(id, ws))
          .join(id === 'network' ? ' · ' : ' › ');
      return `<button type="button" class="ws-type-card" data-ws-type="${id}" aria-pressed="${id === selected}">
        <span class="ws-type-name">${escHtml(t.label)}</span>
        <span class="ws-type-desc">${escHtml(t.desc)}</span>
        <span class="ws-type-flow">${escHtml(flow)}</span>
      </button>`;
    }).join('')}</div>`;
  },
  // Label a core workspace as it will read in a project of `type`.
  _coreLabel(type, ws) {
    if (type === 'lighting') {
      const l = { lightov: 'Overview', plan: 'Plans', lighting: 'Rooms', streetlight: 'Roads', sports: 'Sports fields' }[ws];
      if (l) return l;
    }
    if (ws === 'plan') return type === 'building' ? 'Floor plans' : 'Site plan';
    return { sld: 'Single-line', retic: 'Demand', streetlight: 'Street lighting', schedules: 'Schedules', interlock: 'Interlocking', quantities: 'Quantities', lighting: 'Lighting' }[ws];
  },

  // A Lighting project's design picker: the three kinds, the electrical
  // option and the tabs they give. `locked` kinds hold data (always ticked).
  _lightingHtml(kinds, circuits, opts = {}) {
    const locked = opts.locked || [];
    const cards = Object.entries(this.KINDS).map(([k, d]) => {
      const on = kinds.includes(k) || locked.includes(k);
      const adds = d.ws.map(ws => this._coreLabel('lighting', ws)).join(', ');
      return `<label class="ws-kind${on ? ' on' : ''}">
        <input type="checkbox" data-ws-kind="${k}"${on ? ' checked' : ''}${locked.includes(k) ? ' disabled' : ''}>
        <span class="ws-kind-text"><span class="ws-row-name">${escHtml(d.label)}</span>
        <span class="ws-row-desc">${escHtml(d.desc)}</span>
        <span class="ws-kind-adds">${locked.includes(k) ? 'Holds data, so it stays' : 'Adds: ' + escHtml(adds)}</span></span>
      </label>`;
    }).join('');
    return `<fieldset class="ws-kinds" data-ws-lighting${opts.hidden ? ' hidden' : ''}>
      <legend>What are you lighting? <span class="ws-dialog-hint">Pick one or more</span></legend>
      <div class="ws-kind-cards">${cards}</div>
      ${opts.electrical ? `<label class="ws-kind-elec"><input type="checkbox" data-ws-electrical${circuits ? ' checked' : ''}>
        <span>Also design the electrical side <span class="ws-dialog-hint">(street-light circuits, board schedules, single line)</span></span></label>` : ''}
      <div class="ws-tabs-preview" data-ws-preview>${this._previewHtml(kinds)}</div>
    </fieldset>`;
  },
  _previewHtml(kinds) {
    const keep = AppState.lightingKinds;
    AppState.lightingKinds = kinds.length ? kinds : ['__none'];
    const tabs = kinds.length ? this.core('lighting') : ['lightov'];
    AppState.lightingKinds = keep;
    return `<span class="ws-dialog-hint">Your tabs</span> ${tabs.map((ws, i) =>
      `<span class="ws-tab-chip">${i + 1} ${escHtml(this._coreLabel('lighting', ws))}</span>`).join('')}`;
  },
  // Keep the picker's card states and tab preview in step with its boxes.
  _bindLighting(content) {
    content.addEventListener('change', (e) => {
      if (!e.target.matches('[data-ws-kind]')) return;
      const box = content.querySelector('[data-ws-lighting]');
      box.querySelectorAll('.ws-kind').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
      const kinds = [...box.querySelectorAll('[data-ws-kind]:checked')].map(i => i.dataset.wsKind);
      box.querySelector('[data-ws-preview]').innerHTML = this._previewHtml(kinds);
      const ok = content.querySelector('[data-ws-ok]');
      const lighting = !box.hidden;
      if (ok) ok.disabled = lighting && !kinds.length;
    });
  },
  _readLighting(content) {
    const box = content.querySelector('[data-ws-lighting]');
    const kinds = box ? [...box.querySelectorAll('[data-ws-kind]:checked')].map(i => i.dataset.wsKind) : [];
    return { kinds: kinds.length ? kinds : ['rooms'], circuits: !!(box && box.querySelector('[data-ws-electrical]:checked')) };
  },
  _lastDialog() {
    // _modal appends its dialog synchronously, so the newest one is ours.
    const all = document.querySelectorAll('.ws-dialog');
    return all[all.length - 1];
  },

  // New project: pick the type. Resolves to { type, lighting?, extras }, or
  // null if cancelled.
  async chooseType() {
    const promise = this._modal('New project',
      `<p class="ws-dialog-lead">What are you designing? This decides which workspaces the project shows.</p>
       ${this._typeCardsHtml('building')}
       ${this._lightingHtml(Object.keys(this.KINDS), false, { hidden: true, electrical: true })}
       <p class="ws-dialog-note">You can change the type or add a workspace later from Project › Project Type &amp; Workspaces. Nothing is deleted.</p>`,
      'Create project');
    const content = this._lastDialog();
    if (content) {
      this._bindLighting(content);
      content.addEventListener('ws-type-change', (e) => {
        const box = content.querySelector('[data-ws-lighting]');
        box.hidden = e.detail !== 'lighting';
        box.dispatchEvent(new Event('change', { bubbles: true }));
        const ok = content.querySelector('[data-ws-ok]');
        if (ok && box.hidden) ok.disabled = false;
      });
    }
    const result = await promise;
    if (!result) return null;
    const card = result.querySelector('[data-ws-type][aria-pressed="true"]');
    const type = card ? card.dataset.wsType : 'building';
    if (type !== 'lighting') return { type, extras: [] };
    const lighting = this._readLighting(result);
    // The electrical side: circuits on the Roads tab, schedules for rooms, the single line.
    const extras = [];
    if (lighting.circuits) {
      extras.push('sld');
      if (lighting.kinds.includes('rooms')) extras.push('schedules');
    }
    lighting.circuits = lighting.circuits && lighting.kinds.includes('roads');
    return { type, lighting, extras };
  },

  // Project › Project Type & Workspaces: change the type and the optional extras.
  async openSettings() {
    const cur = this.type();
    const extras = Array.isArray(AppState.extraWorkspaces) ? AppState.extraWorkspaces : [];
    const row = (type, ws, label, desc) => {
      const core = this.core(type).includes(ws);
      const data = !core && this.hasData(ws);
      const on = core || data || extras.includes(ws);
      const note = core ? `Part of ${this.TYPES[type].label} projects` : data ? 'Holds data, so it stays visible' : '';
      return `<label class="ws-row${core || data ? ' locked' : ''}">
        <input type="checkbox" data-ws="${ws}" ${on ? 'checked' : ''} ${core || data ? 'disabled' : ''}>
        <span class="ws-row-text"><span class="ws-row-name">${escHtml(label || this._coreLabel(type, ws) || ws)}</span>
        <span class="ws-row-desc">${escHtml(desc || this.DESCS[ws])}</span></span>
        <span class="ws-row-note">${escHtml(note)}</span>
      </label>`;
    };
    const rows = (type) => {
      if (type !== 'lighting') {
        return `<div class="ws-dialog-sub">Workspaces</div><div class="ws-rows">${this.ORDER.filter(ws => !this.LIGHTING_ONLY.includes(ws)).map(ws => row(type, ws)).join('')}</div>`;
      }
      const kinds = cur === 'lighting' ? this.lightingKinds() : Object.keys(this.KINDS);
      const locked = Object.keys(this.KINDS).filter(k => this.kindHasData(k));
      const sl = AppState.reticulation && AppState.reticulation.streetLighting;
      const circData = !!(sl && sl.circuits && sl.circuits.length);
      const circOn = circData || (cur === 'lighting' ? !!AppState.roadCircuits : false);
      return `${this._lightingHtml(kinds, false, { locked })}
        <div class="ws-dialog-sub">Electrical side <span class="ws-dialog-hint">optional</span></div>
        <div class="ws-rows">
          <label class="ws-row${circData ? ' locked' : ''}"><input type="checkbox" data-ws-circuits ${circOn ? 'checked' : ''} ${circData ? 'disabled' : ''}>
            <span class="ws-row-text"><span class="ws-row-name">Street-light circuits</span>
            <span class="ws-row-desc">Adds Circuits to Roads: poles to circuits, volt drop, earth loop</span></span>
            <span class="ws-row-note">${circData ? 'Holds data, so it stays visible' : ''}</span></label>
          ${row(type, 'schedules', 'Schedules', 'Board schedules for the room fittings')}
          ${row(type, 'sld', 'Single line', 'Supply, mast and pole feeders, studies')}
          ${row(type, 'quantities', 'Quantities', 'Bill of quantities from luminaires, poles and masts')}
        </div>`;
    };
    const promise = this._modal('Project type & workspaces',
      `<div class="ws-dialog-sub">Project type${this.isExplicit() ? '' : ' <span class="ws-dialog-hint">(currently inferred from the content)</span>'}</div>
       ${this._typeCardsHtml(cur)}
       <div class="ws-dialog-rows" data-ws-rows>${rows(cur)}</div>
       <p class="ws-dialog-note">Hiding a workspace never deletes it. A workspace that holds data can't be hidden.</p>`,
      'Apply');
    // Re-render the workspace list when the type card changes, keeping any
    // optional workspace the user had ticked.
    const content = this._lastDialog();
    if (content) {
      this._bindLighting(content);
      content.addEventListener('ws-type-change', (e) => {
        const ticked = [...content.querySelectorAll('[data-ws]:checked:not(:disabled)')].map(i => i.dataset.ws);
        const box = content.querySelector('[data-ws-rows]');
        box.innerHTML = rows(e.detail);
        for (const ws of ticked) { const i = box.querySelector(`[data-ws="${ws}"]`); if (i && !i.disabled) i.checked = true; }
        const ok = content.querySelector('[data-ws-ok]');
        if (ok) ok.disabled = false;
      });
    }
    const result = await promise;
    if (!result) return false;
    const card = result.querySelector('[data-ws-type][aria-pressed="true"]');
    const type = card ? card.dataset.wsType : cur;
    const picked = [...result.querySelectorAll('[data-ws]:checked:not(:disabled)')].map(i => i.dataset.ws);
    let lighting;
    if (type === 'lighting') {
      lighting = this._readLighting(result);
      lighting.circuits = !!result.querySelector('[data-ws-circuits]:checked');
    }
    this.setType(type, picked, lighting);
    return true;
  },

  init() {
    const btn = document.getElementById('btn-project-type');
    if (btn) btn.addEventListener('click', () => this.openSettings());
    const chip = document.getElementById('project-type-chip');
    if (chip) chip.addEventListener('click', () => this.openSettings());
    this.refresh();
  },
};
