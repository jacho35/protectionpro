/* ProtectionPro — Project › Project settings… (UX plan PR 17).
 *
 * The project's own values in one page, in sections (a list on the left, one screen each on a
 * phone): Project info (name, number, client, people, revision, logo — the title block),
 * Type & workspaces, Electrical base & standards (base MVA, frequency, voltage factor c, cable
 * length unit, symbols, cascading, keep in sync), and Display. A change applies as it is made —
 * there is no Apply. Values are stored where they always were (AppState, saved with the project),
 * so old projects open with theirs. The gear (Settings) keeps only personal preferences.
 *
 * The electrical values show in a Network project, or once the single line holds components;
 * "Show all settings" lifts that (the same rule the gear used before).
 */
const ProjectSettings = {
  SECTIONS: [
    { id: 'info', label: 'Project info', sub: 'Name, client, people, revision, logo' },
    { id: 'type', label: 'Type & workspaces', sub: 'Which tabs the project shows' },
    { id: 'electrical', label: 'Electrical base & standards', sub: 'Base MVA, frequency, symbols, cascading' },
    { id: 'display', label: 'Display', sub: 'Voltage unit' },
  ],
  _sec: 'info',
  _showAll: false,
  _phoneScreen: null,   // on a phone: null = the list, else the section shown

  // The single-line study values apply to a Network project, or once the single line is in use.
  electricalApplies() {
    const type = typeof Workspaces !== 'undefined' ? Workspaces.type() : 'network';
    return type === 'network' || !!(AppState.components && AppState.components.size > 0);
  },

  // Pure: the value each field holds after an edit (so the rules are testable without a page).
  parse(field, raw) {
    switch (field) {
      case 'baseMVA': return parseFloat(raw) > 0 ? parseFloat(raw) : DEFAULT_BASE_MVA;
      case 'frequency': return parseInt(raw, 10) === 60 ? 60 : 50;
      case 'voltageFactor': { const v = parseFloat(raw); return v >= 0.9 && v <= 1.2 ? v : DEFAULT_VOLTAGE_FACTOR; }
      case 'defaultLengthUnit': return raw === 'km' ? 'km' : 'm';
      default: return raw;
    }
  },

  _esc(v) { return typeof Properties !== 'undefined' ? Properties._esc(v) : String(v == null ? '' : v); },

  _isPhone() { return window.matchMedia && window.matchMedia('(max-width: 768px)').matches; },

  _el() {
    let m = document.getElementById('ps-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'ps-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'Project settings');
    m.style.display = 'none';
    m.innerHTML = `<div class="modal-content modal-wide ps-content">
      <div class="modal-header">
        <button class="settings-back" id="ps-back" aria-label="Back to Project settings" hidden>&lsaquo;</button>
        <h3 id="ps-title">Project settings</h3>
        <button class="modal-close" id="ps-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-body"><nav class="ps-nav" id="ps-nav" aria-label="Sections"></nav><div class="ps-pane" id="ps-pane"></div></div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) this.close(); });
    m.querySelector('#ps-close').addEventListener('click', () => this.close());
    m.querySelector('#ps-back').addEventListener('click', () => { this._phoneScreen = null; this.render(); });
    m.querySelector('#ps-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ps-sec]');
      if (!b) return;
      this._sec = b.dataset.psSec;
      this._phoneScreen = this._sec;
      this.render();
    });
    m.querySelector('#ps-pane').addEventListener('click', (e) => this._onClick(e));
    window.matchMedia('(max-width: 768px)').addEventListener?.('change', () => { if (this.isOpen()) this.render(); });
    return m;
  },

  isOpen() { const m = document.getElementById('ps-modal'); return !!m && m.style.display !== 'none'; },

  open(section) {
    const m = this._el();
    if (section && this.SECTIONS.some(s => s.id === section)) { this._sec = section; this._phoneScreen = section; }
    else this._phoneScreen = null;
    this._showAll = false;
    m.style.display = '';
    this.render();
  },

  close() {
    const m = document.getElementById('ps-modal');
    if (m) m.style.display = 'none';
  },

  render() {
    const m = this._el();
    const phone = this._isPhone();
    m.classList.toggle('ps-phone', phone);
    const showList = phone && !this._phoneScreen;
    m.dataset.screen = phone ? (showList ? 'list' : 'section') : 'wide';
    const nav = m.querySelector('#ps-nav');
    nav.innerHTML = this.SECTIONS.map(s =>
      `<button type="button" class="ps-nav-item${s.id === this._sec && !showList ? ' on' : ''}" data-ps-sec="${s.id}"><span class="ps-nav-t">${s.label}</span><span class="ps-nav-s">${this._esc(s.sub)}</span></button>`).join('');
    const cur = this.SECTIONS.find(s => s.id === this._sec);
    m.querySelector('#ps-title').textContent = phone && !showList && cur ? cur.label : 'Project settings';
    m.querySelector('#ps-back').hidden = !(phone && !showList);
    const pane = m.querySelector('#ps-pane');
    if (showList) { pane.innerHTML = ''; return; }
    pane.innerHTML = this['_' + this._sec]();
    this._bind(pane);
  },

  // ── Project info ──
  _info() {
    const d = AppState.projectDetails || {};
    const f = (label, field, val, type = 'text') =>
      `<div class="prop-row"><label>${label}</label><input type="${escHtml(type)}" data-ps-info="${field}" value="${this._esc(val || '')}"></div>`;
    const logo = typeof Properties !== 'undefined' ? Properties._safeLogo(d.companyLogo) : '';
    return `<h4 class="ps-h">Project info</h4><p class="ps-hint">Printed in the title block of every drawing and report.</p>
      <div class="ps-grid">
        <div class="ps-card"><div class="ps-card-t">Project</div>
          ${f('Project name', 'projectName', AppState.projectName)}${f('Project number', 'projectNumber', d.projectNumber)}${f('Client', 'client', d.client)}${f('Company', 'company', d.company)}
          <div class="prop-row"><label>Description</label><textarea data-ps-info="description" rows="3">${this._esc(d.description || '')}</textarea></div></div>
        <div class="ps-card"><div class="ps-card-t">People</div>
          ${f('Engineer', 'engineerName', d.engineerName)}${f('Checked by', 'checkedBy', d.checkedBy)}${f('Approved by', 'approvedBy', d.approvedBy)}</div>
        <div class="ps-card"><div class="ps-card-t">Revision</div>
          ${f('Revision no.', 'revisionNumber', d.revisionNumber)}${f('Date', 'date', d.date, 'date')}</div>
        <div class="ps-card"><div class="ps-card-t">Company logo</div>
          <div class="logo-upload-area">${logo
            ? `<div class="logo-preview"><img src="${this._esc(logo)}" alt="Company logo"><button type="button" class="btn-remove-logo" data-ps-logo-remove title="Remove logo">&times;</button></div>`
            : '<div class="logo-placeholder">No logo uploaded</div>'}
            <label class="btn btn-small btn-secondary logo-upload-btn">${logo ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-ps-logo hidden></label></div></div>
      </div>`;
  },

  // ── Type & workspaces ──
  _type() {
    const t = Workspaces.type();
    const def = Workspaces.TYPES[t];
    const tabs = Workspaces.core(t).map(ws => {
      const b = document.getElementById(Workspaces.TAB_IDS[ws]);
      return `<li><b>${this._esc(b ? b.textContent.trim() : ws)}</b> — ${this._esc(Workspaces.DESCS[ws] || '')}</li>`;
    }).join('');
    return `<h4 class="ps-h">Type &amp; workspaces</h4>
      <div class="ps-card"><div class="ps-card-t">${this._esc(def.label)}${Workspaces.isExplicit() ? '' : ' <span class="ps-dim">(taken from the content)</span>'}</div>
        <p class="ps-hint">${this._esc(def.desc)}</p><p class="ps-hint">Its tabs, in the order you work:</p><ul class="ps-tabs">${tabs}</ul>
        <button type="button" class="btn-primary" data-ps-type>Change type &amp; workspaces…</button>
        <p class="ps-hint">Hiding a workspace never deletes it; a workspace that holds data can't be hidden.</p></div>`;
  },

  // ── Electrical base & standards ──
  _electrical() {
    const applies = this.electricalApplies();
    const all = this._showAll || applies;
    const type = Workspaces.TYPES[Workspaces.type()].label;
    const note = !applies
      ? `<div class="settings-type-note">A ${this._esc(type)} project without a single line doesn't use the study values. <button type="button" class="btn-link" data-ps-all>${this._showAll ? 'Hide them' : 'Show all settings'}</button></div>` : '';
    const cv = AppState.voltageFactor ?? DEFAULT_VOLTAGE_FACTOR;
    const sel = (id, opts, val) => `<select id="${id}" data-ps-el>${opts.map(([v, l]) => `<option value="${v}"${String(val) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const study = !all ? '' : `
      <div class="form-group"><label for="base-mva">Base MVA</label><input type="number" id="base-mva" data-ps-el value="${AppState.baseMVA}" min="1" step="1"><span class="unit">MVA</span></div>
      <div class="form-group"><label for="voltage-factor">Voltage factor c (IEC 60909)</label><input type="number" id="voltage-factor" data-ps-el value="${Number(cv).toFixed(2)}" min="0.9" max="1.2" step="0.01"><span class="unit" title="IEC 60909-0 Table 1 voltage factor for short-circuit currents. 1.10 = c_max (default). Use 1.00 for bolted-fault / V=1.0 studies.">c</span></div>
      <div class="form-group"><label for="use-iec-symbols">Diagram symbols</label><label class="checkbox-inline" title="Draw switching and protection devices with IEC 60617 symbols: contacts with a function qualifier, shown open or closed by blade position."><input type="checkbox" id="use-iec-symbols" data-ps-el${AppState.symbolSet === 'iec' ? ' checked' : ''}> Use IEC symbols (IEC 60617)</label></div>
      <div class="form-group"><label for="allow-cascading">Breaking capacity</label><label class="checkbox-inline" title="Cascading (back-up protection, IEC 60947-2 Annex A): a breaker whose own breaking capacity is below the fault level passes when the manufacturer has tested it with the breaker above it."><input type="checkbox" id="allow-cascading" data-ps-el${AppState.cascading !== false ? ' checked' : ''}> Allow cascading (back-up protection)</label></div>
      <div class="form-group"><label for="default-length-unit">Default cable length unit</label>${sel('default-length-unit', [['m', 'Meters (m)'], ['km', 'Kilometers (km)']], AppState.defaultLengthUnit || 'm')}</div>`;
    return `<h4 class="ps-h">Electrical base &amp; standards</h4>${note}
      <div class="ps-card ps-form">
        <div class="form-group"><label for="base-freq">System frequency</label>${sel('base-freq', [['50', '50 Hz'], ['60', '60 Hz']], AppState.frequency)}</div>
        ${study}
        <div class="form-group"><label for="keep-in-sync">Workspaces</label><label class="checkbox-inline" title="After each edit the app brings the other workspaces up to date by itself — for example a sub-board feeder drawn on the single line shows in its board's schedule straight away."><input type="checkbox" id="keep-in-sync" data-ps-el${AppState.keepInSync !== false ? ' checked' : ''}> Keep workspaces in sync</label></div>
      </div><p class="ps-hint">Saved with the project; a change applies at once.</p>`;
  },

  // ── Display ──
  _display() {
    const unit = AppState.voltageDisplayUnit === 'V' ? 'V' : 'kV';
    return `<h4 class="ps-h">Display</h4><div class="ps-card ps-form">
      <div class="form-group"><label for="ps-voltage-unit">Voltage unit</label><select id="ps-voltage-unit" data-ps-display><option value="kV"${unit === 'kV' ? ' selected' : ''}>kV</option><option value="V"${unit === 'V' ? ' selected' : ''}>V</option></select></div>
      <p class="ps-hint">Which result boxes show, and the values in them, are picked over the diagram (the strip of study chips and Values ▾).</p></div>`;
  },

  _bind(pane) {
    pane.querySelectorAll('[data-ps-info]').forEach(el => el.addEventListener('input', () => {
      const field = el.dataset.psInfo;
      if (field === 'projectName') {
        AppState.projectName = el.value;
        const disp = document.getElementById('project-name-display');
        if (disp) disp.textContent = el.value || 'Untitled Project';
      } else AppState.projectDetails[field] = el.value;
      AppState.dirty = true;
    }));
    pane.querySelector('[data-ps-logo]')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { UI.toast('Logo file must be under 2 MB.', 'error'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (!Properties._safeLogo(reader.result)) { UI.toast('The logo must be a PNG, JPEG, GIF or WebP image.', 'error'); return; }
        AppState.projectDetails.companyLogo = reader.result;
        AppState.dirty = true;
        this.render();
      };
      reader.readAsDataURL(file);
    });
    pane.querySelector('[data-ps-logo-remove]')?.addEventListener('click', () => {
      AppState.projectDetails.companyLogo = null;
      AppState.dirty = true;
      this.render();
    });
    pane.querySelectorAll('[data-ps-el]').forEach(el => el.addEventListener('change', () => this._applyElectrical(el)));
    pane.querySelector('[data-ps-display]')?.addEventListener('change', (e) => {
      AppState.voltageDisplayUnit = e.target.value === 'V' ? 'V' : 'kV';
      AppState.dirty = true;
      Canvas.render();
    });
  },

  _onClick(e) {
    if (e.target.closest('[data-ps-all]')) { this._showAll = !this._showAll; this.render(); return; }
    if (e.target.closest('[data-ps-type]')) {
      Workspaces.openSettings().then(() => { if (this.isOpen()) this.render(); });
    }
  },

  _applyElectrical(el) {
    const id = el.id;
    let results = true;   // does the change make results out of date?
    if (id === 'base-mva') { AppState.baseMVA = this.parse('baseMVA', el.value); el.value = AppState.baseMVA; }
    else if (id === 'base-freq') AppState.frequency = this.parse('frequency', el.value);
    else if (id === 'voltage-factor') { AppState.voltageFactor = this.parse('voltageFactor', el.value); el.value = AppState.voltageFactor.toFixed(2); }
    else if (id === 'default-length-unit') AppState.defaultLengthUnit = this.parse('defaultLengthUnit', el.value);
    else if (id === 'allow-cascading') AppState.cascading = el.checked;
    else if (id === 'use-iec-symbols') {
      // Display-only: leaves results alone
      results = false;
      AppState.symbolSet = el.checked ? 'iec' : 'classic';
      if (typeof Sidebar !== 'undefined') Sidebar.syncSymbolSet();
    } else if (id === 'keep-in-sync') {
      // A change is saved with the project; switching it on, the dirty mark also starts a sync pass
      results = false;
      AppState.keepInSync = el.checked;
    }
    AppState.dirty = true;
    if (results) AppState.invalidateResults();
    Canvas.render();
    if (Properties.currentId) Properties.show(Properties.currentId);
  },

  init() {
    document.getElementById('btn-project-settings')?.addEventListener('click', () => this.open());
  },
};

if (typeof window !== 'undefined') window.ProjectSettings = ProjectSettings;
if (typeof module !== 'undefined') module.exports = ProjectSettings;
