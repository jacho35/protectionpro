/* ProtectionPro — project type & workspace visibility.
 *
 * A project is either a Reticulation, a Building or a Network/plant project,
 * and that decides which workspace tabs it shows, in workflow order:
 *
 *   Reticulation  1 Site plan › 2 Demand › 3 Single-line
 *   Building      1 Floor plans › 2 Single-line › 3 Schedules
 *   Network       Single-line · Interlocking
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
 *   'plan' | 'retic' (shown as "Demand") | 'sld' | 'schedules' | 'interlock'
 */

const Workspaces = {
  TYPES: {
    retic: {
      label: 'Reticulation',
      desc: 'A township or site LV network: minisubs, kiosks and erven, sized by ADMD (NRS 034-1).',
      core: ['plan', 'retic', 'sld'],
      planDomain: 'retic',
    },
    building: {
      label: 'Building',
      desc: 'Floors, distribution boards and final circuits, down to each way.',
      core: ['plan', 'sld', 'schedules'],
      planDomain: 'building',
    },
    network: {
      label: 'Network / plant',
      desc: 'Substations, industrial and utility networks: single-line studies and breaker interlocking.',
      core: ['sld', 'interlock'],
      planDomain: null,
    },
  },
  // Canonical order for workspaces outside a type's core set.
  ORDER: ['plan', 'retic', 'sld', 'schedules', 'interlock'],
  TAB_IDS: {
    sld: 'btn-workspace-sld', retic: 'btn-workspace-retic', plan: 'btn-workspace-plan',
    interlock: 'btn-workspace-interlock', schedules: 'btn-workspace-schedules',
  },
  MOBILE_IDS: {
    sld: 'mobile-ws-sld', retic: 'mobile-ws-retic', plan: 'mobile-ws-plan',
    interlock: 'mobile-ws-interlock', schedules: 'mobile-ws-schedules',
  },
  DESCS: {
    plan: 'Site or floor plans with devices, routes and circuits',
    retic: 'Reticulation: kiosks, erven and ADMD demand',
    sld: 'The electrical model and every study',
    schedules: 'Distribution-board circuit schedules and checks',
    interlock: 'Breaker interlocking logic, simulated against the single-line',
  },

  // ── Type ────────────────────────────────────────────────────────────
  // The stored type, else the one the project's content implies.
  type() {
    const t = AppState.projectType;
    return this.TYPES[t] ? t : this.inferType();
  },
  isExplicit() { return !!this.TYPES[AppState.projectType]; },

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
      case 'sld': return true;
      case 'retic': return this._reticHasData();
      case 'plan': return typeof AppState._planMarkupIsEmpty === 'function' && !AppState._planMarkupIsEmpty();
      case 'interlock': return !!(AppState.interlockLogic && AppState.interlockLogic.nodes && AppState.interlockLogic.nodes.length);
      case 'schedules': return this._schedulesHaveData();
      default: return false;
    }
  },

  // ── Visible workspaces, in display order ────────────────────────────
  visible() {
    const core = this.TYPES[this.type()].core;
    const extras = Array.isArray(AppState.extraWorkspaces) ? AppState.extraWorkspaces : [];
    const out = core.slice();
    for (const ws of this.ORDER) {
      if (out.includes(ws)) continue;
      if (extras.includes(ws) || this.hasData(ws)) out.push(ws);
    }
    return out;
  },
  isVisible(ws) { return this.visible().includes(ws); },

  // Step number of a core workspace in a stepped (retic/building) project.
  step(ws) {
    const t = this.type();
    if (t === 'network') return null;
    const i = this.TYPES[t].core.indexOf(ws);
    return i >= 0 ? i + 1 : null;
  },

  label(ws) {
    if (ws === 'plan') {
      const d = AppState.planMarkup && AppState.planMarkup.settings && AppState.planMarkup.settings.domain;
      return d === 'building' ? 'Floor plans' : 'Site plan';
    }
    return { sld: 'Single-line', retic: 'Demand', schedules: 'Schedules', interlock: 'Interlocking' }[ws] || ws;
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
  // Re-order and show/hide the workspace tabs (desktop + mobile sheet), label
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
      const m = document.getElementById(this.MOBILE_IDS[ws]);
      if (m) {
        m.hidden = !show;
        // Keep the icon, replace the text label.
        const svg = m.querySelector('svg');
        m.textContent = '';
        if (svg) m.appendChild(svg);
        m.appendChild(document.createTextNode(' ' + (n ? n + ' · ' : '') + this.label(ws)));
        if (m.parentElement) m.parentElement.insertBefore(m, this._mobileAnchor(m.parentElement));
      }
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
    if (activeHidden && typeof window.switchWorkspace === 'function') window.switchWorkspace('sld');
  },
  // Mobile items are re-inserted just above the entries that close the
  // workspace group ("Search Commands…", "Project Type & Workspaces…").
  _mobileAnchor(list) {
    return list.querySelector('#mobile-menu-search') || list.querySelector('#mobile-menu-project-type')
      || list.querySelector('.mobile-menu-divider');
  },

  onProjectChanged() { this.refresh(); },

  setType(type, extras) {
    if (!this.TYPES[type]) return;
    AppState.projectType = type;
    AppState.extraWorkspaces = (extras || []).filter(ws => this.ORDER.includes(ws) && !this.TYPES[type].core.includes(ws));
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
      const flow = t.core.map((ws, i) => (id === 'network' ? '' : (i + 1) + ' ') + this._coreLabel(id, ws))
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
    if (ws === 'plan') return type === 'building' ? 'Floor plans' : 'Site plan';
    return { sld: 'Single-line', retic: 'Demand', schedules: 'Schedules', interlock: 'Interlocking' }[ws];
  },

  // New project: pick the type. Resolves to a type id, or null if cancelled.
  async chooseType() {
    const content = await this._modal('New project',
      `<p class="ws-dialog-lead">What are you designing? This decides which workspaces the project shows.</p>
       ${this._typeCardsHtml('building')}
       <p class="ws-dialog-note">You can change the type or add a workspace later from Project › Project Type &amp; Workspaces. Nothing is deleted.</p>`,
      'Create project');
    if (!content) return null;
    const card = content.querySelector('[data-ws-type][aria-pressed="true"]');
    return card ? card.dataset.wsType : 'building';
  },

  // Project › Project Type & Workspaces: change the type and the optional extras.
  async openSettings() {
    const cur = this.type();
    const extras = Array.isArray(AppState.extraWorkspaces) ? AppState.extraWorkspaces : [];
    const rows = (type) => this.ORDER.map(ws => {
      const core = this.TYPES[type].core.includes(ws);
      const data = !core && this.hasData(ws);
      const on = core || data || extras.includes(ws);
      const note = core ? `Part of ${this.TYPES[type].label} projects` : data ? 'Holds data, so it stays visible' : '';
      return `<label class="ws-row${core || data ? ' locked' : ''}">
        <input type="checkbox" data-ws="${ws}" ${on ? 'checked' : ''} ${core || data ? 'disabled' : ''}>
        <span class="ws-row-text"><span class="ws-row-name">${escHtml(this._coreLabel(type, ws) || ws)}</span>
        <span class="ws-row-desc">${escHtml(this.DESCS[ws])}</span></span>
        <span class="ws-row-note">${escHtml(note)}</span>
      </label>`;
    }).join('');
    const promise = this._modal('Project type & workspaces',
      `<div class="ws-dialog-sub">Project type${this.isExplicit() ? '' : ' <span class="ws-dialog-hint">(currently inferred from the content)</span>'}</div>
       ${this._typeCardsHtml(cur)}
       <div class="ws-dialog-sub">Workspaces</div>
       <div class="ws-rows" data-ws-rows>${rows(cur)}</div>
       <p class="ws-dialog-note">Hiding a workspace never deletes it. A workspace that holds data can't be hidden.</p>`,
      'Apply');
    // Re-render the workspace list when the type card changes, keeping any
    // optional workspace the user had ticked.
    // _modal appends its dialog synchronously, so the newest one is ours.
    const all = document.querySelectorAll('.ws-dialog');
    const content = all[all.length - 1];
    if (content) {
      content.addEventListener('ws-type-change', (e) => {
        const ticked = [...content.querySelectorAll('[data-ws]:checked:not(:disabled)')].map(i => i.dataset.ws);
        const box = content.querySelector('[data-ws-rows]');
        box.innerHTML = rows(e.detail);
        for (const ws of ticked) { const i = box.querySelector(`[data-ws="${ws}"]`); if (i && !i.disabled) i.checked = true; }
      });
    }
    const result = await promise;
    if (!result) return false;
    const card = result.querySelector('[data-ws-type][aria-pressed="true"]');
    const type = card ? card.dataset.wsType : cur;
    const picked = [...result.querySelectorAll('[data-ws]:checked:not(:disabled)')].map(i => i.dataset.ws);
    this.setType(type, picked);
    return true;
  },

  init() {
    const btn = document.getElementById('btn-project-type');
    if (btn) btn.addEventListener('click', () => this.openSettings());
    const chip = document.getElementById('project-type-chip');
    if (chip) chip.addEventListener('click', () => this.openSettings());
    const m = document.getElementById('mobile-menu-project-type');
    if (m) m.addEventListener('click', () => {
      if (typeof MobileUI !== 'undefined' && MobileUI.closeSheet) MobileUI.closeSheet();
      this.openSettings();
    });
    this.refresh();
  },
};
