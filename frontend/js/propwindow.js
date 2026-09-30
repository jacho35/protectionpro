/* ProtectionPro — Properties window
 *
 * An optional roomy modal for the selected component's properties: section
 * list on the left, fields in two spaced columns, computed values and device
 * actions on the right, and a hover/focus tooltip on every ⓘ.
 *
 * It renders the SAME fields as the sidebar — Properties._visibleFields /
 * _groupSections / renderField — and binds them with Properties._bindContent,
 * so edits go through onFieldChange exactly as in the sidebar. Whenever the
 * sidebar re-renders (Properties.show) an open window re-renders with it.
 * Opened from the sidebar header button, a component's double-click, or its
 * right-click menu.
 */

// One line under each section heading in the window
const PROP_SECTION_BLURBS = {
  General: 'Identity, nameplate rating and connection. These feed every study.',
  pv: 'PV array and DC string layout, checked against the inverter\'s MPPT and DC limits.',
  battery: 'Storage energy, depth of discharge and charge/discharge limits.',
  fault: 'Impedance and fault-contribution data for IEC 60909 short-circuit, arc flash and duty checks.',
  loadflow: 'Operating point and control settings for load flow and the studies built on it.',
  harmonics: 'Harmonic source spectrum and frequency-dependent model.',
  dynamic: 'Machine and load data for the time-domain motor starting simulation.',
  stability: 'Machine, governor and exciter data for transient stability.',
  arcflash: 'Equipment geometry and working distance for the arc flash calculation.',
  grounding: 'Neutral earthing, earthing system and earth-electrode data.',
  cable_sizing: 'Installation conditions and limits for cable sizing.',
  protection: 'Pickup and time settings plotted on the TCC and used for clearing times.',
  co_breaker_1: 'Trip unit of the input I breaker. Plotted on the TCC; studies use it while input I is selected.',
  co_breaker_2: 'Trip unit of the input II breaker. Plotted on the TCC; studies use it while input II is selected.',
  __position: 'Where the symbol sits on the diagram.',
};

const PropWindow = {
  el: null,
  _section: 'General',   // last section viewed — kept across opens
  _q: '',
  _tipBtn: null,
  _tipPinned: false,
  _raf: 0,

  init() {
    this.el = document.getElementById('prop-window');
    if (!this.el) return;
    this.mainEl = document.getElementById('pw-main');
    this.navEl = document.getElementById('pw-nav');
    this.asideEl = document.getElementById('pw-aside');
    this.bodyEl = document.getElementById('pw-body');
    this.tipEl = document.getElementById('pw-tip');
    this.searchEl = document.getElementById('pw-q');

    document.getElementById('pw-close').addEventListener('click', () => this.close());
    document.getElementById('pw-done').addEventListener('click', () => this.close());
    document.getElementById('pw-dock').addEventListener('click', () => {
      this.close();
      if (document.body.classList.contains('properties-collapsed')) {
        document.getElementById('properties-expand-tab')?.click();
      }
    });
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.close(); });

    this.searchEl.addEventListener('input', () => {
      this._q = this.searchEl.value;
      this._hideTip(true);
      this._applyView();
    });

    this.navEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sec]');
      if (!b) return;
      this._section = b.dataset.sec;
      this._q = '';
      this.searchEl.value = '';
      this._hideTip(true);
      this._applyView();
      this.mainEl.scrollTop = 0;
    });

    // A committed edit re-renders the sidebar and, through it, this window —
    // refreshing the computed values and any fields a showWhen rule gates.
    // Coalesced so a handler that already re-rendered isn't repeated.
    this.bodyEl.addEventListener('change', (e) => {
      if (e.target.closest('.pw-nav')) return;
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => {
        if (this.isOpen() && Properties.currentId) Properties.show(Properties.currentId);
      });
    });

    // ⓘ tooltips: hover or keyboard focus previews, click pins
    this.mainEl.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.prop-info-btn');
      if (b && !this._tipPinned) this._showTip(b);
    });
    this.mainEl.addEventListener('mouseout', (e) => {
      const b = e.target.closest('.prop-info-btn');
      if (b && !b.contains(e.relatedTarget) && !this._tipPinned) this._hideTip();
    });
    this.mainEl.addEventListener('focusin', (e) => {
      const b = e.target.closest('.prop-info-btn');
      if (b) { this._tipPinned = false; this._showTip(b); }
    });
    this.mainEl.addEventListener('focusout', (e) => {
      if (e.target.closest('.prop-info-btn') && !this._tipPinned) this._hideTip();
    });
    this.mainEl.addEventListener('click', (e) => {
      const b = e.target.closest('.prop-info-btn');
      if (!b) return;
      e.stopPropagation();
      if (this._tipPinned && this._tipBtn === b) { this._hideTip(true); return; }
      this._showTip(b);
      this._tipPinned = true;
    });
    this.mainEl.addEventListener('scroll', () => this._hideTip(true));
    this.el.addEventListener('mousedown', (e) => {
      if (this._tipPinned && !e.target.closest('.prop-info-btn') && !this.tipEl.contains(e.target)) this._hideTip(true);
    });
    // Escape: an open tooltip first, then the window — also from inside a
    // field, where app.js ignores keys. An open cable picker keeps its own
    // Escape (it closes the dropdown).
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.target.closest('.searchable-select.open')) return;
      e.stopPropagation();
      if (!this.tipEl.hidden) this._hideTip(true);
      else this.close();
    });
  },

  isOpen() {
    return !!this.el && this.el.style.display !== 'none';
  },

  open(id) {
    if (!this.el) return;
    const compId = id || Properties.currentId;
    const comp = compId && AppState.components.get(compId);
    if (!comp) return;
    this.el.style.display = '';
    this._q = '';
    this.searchEl.value = '';
    Properties.show(comp.id);   // renders the sidebar, then this window
    if (!this.el.contains(document.activeElement)) this.searchEl.focus();
  },

  close() {
    if (!this.isOpen()) return;
    this._hideTip(true);
    this.el.style.display = 'none';
    this.mainEl.innerHTML = '';
    this.asideEl.innerHTML = '';
  },

  render() {
    if (!this.isOpen()) return;
    const comp = AppState.components.get(Properties.currentId);
    if (!comp) { this.close(); return; }
    const def = COMPONENT_DEFS[comp.type];

    // Keep the caret and scroll through the re-render
    const act = document.activeElement;
    const focusKey = act && this.bodyEl.contains(act)
      ? (act.dataset.field || (act.dataset.unitFor && 'unit:' + act.dataset.unitFor) || (act.dataset.infoKey && 'info:' + act.dataset.infoKey))
      : null;
    const caret = focusKey && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
    const scroll = this.mainEl.scrollTop;
    this._hideTip(true);

    // Header
    document.getElementById('pw-icon').innerHTML = Symbols.renderPaletteIcon(comp.type);
    document.getElementById('pw-title').textContent = comp.props.name || def.name;
    document.getElementById('pw-sub').textContent = `${def.name} · ${comp.id}`
      + (comp.planLink || comp.swLink ? ' · linked to the distribution plan' : '');

    // Sections: the sidebar's own grouping, plus Position
    const visible = Properties._visibleFields(comp);
    const { sectionGroups, sectionKeys } = Properties._groupSections(visible);
    const multi = sectionKeys.length > 1;
    const sections = sectionKeys.map(k => ({
      key: k,
      label: multi ? (SECTION_LABELS[k] || k) : 'Parameters',
      fields: sectionGroups[k],
      hidden: def.fields.filter(f => (f.section || 'General') === k && !visible.includes(f)),
    }));
    // Breaker trip unit, right after General (its own markup, not a field grid)
    const tuHtml = typeof TripUnit !== 'undefined' ? TripUnit.panelHtml(comp) : '';
    if (tuHtml) sections.splice(1, 0, { key: '__tripunit', label: 'Trip unit', fields: [], hidden: [], html: tuHtml });
    sections.push({ key: '__position', label: 'Position', fields: [], hidden: [] });
    if (!sections.some(s => s.key === this._section)) this._section = sections[0].key;

    this.navEl.innerHTML = `<div class="pw-nav-title">Sections</div>` + sections.map(s =>
      `<button type="button" class="pw-nav-item" data-sec="${s.key}">
        <span class="pw-nav-label">${escHtml(s.label)}</span>
        <span class="pw-nav-count">${s.key.startsWith('__') ? '' : s.fields.length}</span>
      </button>`).join('');

    this.mainEl.innerHTML = sections.map(s => {
      if (s.html) {
        return `<section class="pw-section" data-sec="${s.key}">
        <h3 class="pw-section-title">${escHtml(s.label)}</h3>
        <div class="pw-field pw-field--wide" data-search="trip unit ir tr im isd tsd ii long time short time instantaneous magnetic thermal pickup">${s.html}</div></section>`;
      }
      const blurb = PROP_SECTION_BLURBS[multi ? s.key : '__single'] || '';
      const body = s.key === '__position' ? this._positionHtml(comp)
        : s.fields.map(f => this._fieldHtml(comp, def, f)).join('');
      return `<section class="pw-section" data-sec="${s.key}">
        <h3 class="pw-section-title">${escHtml(s.label)}</h3>
        ${blurb ? `<p class="pw-blurb">${escHtml(blurb)}</p>` : ''}
        <div class="pw-grid">${body}</div>
        ${this._legTripUnitHtml(comp, s.key)}
        ${this._hiddenNote(def, s.hidden)}
      </section>`;
    }).join('') + `<div class="pw-empty" hidden>No property matches that search.</div>`;

    // Label + ⓘ + flags on their own line above the input
    this.mainEl.querySelectorAll('.pw-field > .prop-row').forEach(row => {
      const label = row.querySelector(':scope > label');
      if (!label) return;
      const head = document.createElement('div');
      head.className = 'pw-field-head';
      head.appendChild(label);
      row.querySelectorAll(':scope > .prop-info-btn, :scope > .prop-default-flag, :scope > .prop-reset-btn, :scope > .prop-clear-btn')
        .forEach(n => head.appendChild(n));
      row.prepend(head);
      const input = row.querySelector('[data-field]');
      if (input && input.id === '' && input.matches('input, select')) {
        input.id = 'pw-f-' + input.dataset.field;
        label.htmlFor = input.id;
      }
      if (row.querySelector('.searchable-select')) row.parentElement.classList.add('pw-field--wide');
    });
    this.mainEl.querySelectorAll('.pw-field > .prop-row--ampacity, .pw-field > .prop-row--direction')
      .forEach(r => r.parentElement.classList.add('pw-field--wide'));

    // Right column: computed values, calculation details, device actions
    const pu = Properties.computePerUnit(comp);
    const hasCalc = ['utility', 'generator', 'transformer', 'cable',
      'motor_induction', 'motor_synchronous', 'bus', 'static_load', 'capacitor_bank'].includes(comp.type);
    const calcTitle = ['static_load', 'solar_pv', 'wind_turbine', 'generator', 'distribution_board'].includes(comp.type)
      ? 'Calculated' : `Per-unit (base ${AppState.baseMVA} MVA)`;
    this.asideEl.innerHTML =
      (pu ? `<div class="pw-aside-title">${escHtml(calcTitle)}</div><div class="pw-computed">${pu}</div>` : '')
      + (hasCalc ? `<button type="button" class="pw-btn pw-calc-btn" id="pw-calc">View calculations</button>` : '')
      + Properties._actionsHtml(comp);
    if (!this.asideEl.innerHTML.trim()) {
      this.asideEl.innerHTML = `<div class="pw-aside-empty">No computed values for this component.</div>`;
    }
    document.getElementById('pw-calc')?.addEventListener('click', () => Properties.showCalcModal());

    Properties._bindContent(this.bodyEl, comp, { infoPopups: false });
    this._applyView();

    // Restore focus / caret / scroll
    this.mainEl.scrollTop = scroll;
    if (focusKey) {
      const sel = focusKey.startsWith('unit:') ? `[data-unit-for="${focusKey.slice(5)}"]`
        : focusKey.startsWith('info:') ? `.prop-info-btn[data-info-key="${focusKey.slice(5)}"]`
        : `[data-field="${focusKey}"]`;
      const el = this.bodyEl.querySelector(sel);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && el.setSelectionRange && el.type === 'text') {
          try { el.setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text input */ }
        }
      }
    }
  },

  // Trip unit of a breaker-pair changeover's breaker, under its section
  _legTripUnitHtml(comp, secKey) {
    const m = /^co_breaker_([12])$/.exec(secKey);
    if (!m || typeof TripUnit === 'undefined' || !Components.isBreakerPair(comp)) return '';
    const html = TripUnit.panelHtml(TripUnit.leg(comp, +m[1]));
    return html ? `<div class="pw-field pw-field--wide" data-search="trip unit ir tr im isd tsd ii long time short time instantaneous magnetic thermal pickup">${html}</div>` : '';
  },

  _fieldHtml(comp, def, field) {
    const val = comp.props[field.key] ?? '';
    const helpKey = [`${comp.type}.${field.key}`, field.key].find(k => Properties.fieldHelp(k));
    const search = `${field.label} ${helpKey ? Properties.fieldHelp(helpKey) : ''}`.toLowerCase();
    return `<div class="pw-field" data-key="${escHtml(field.key)}" data-search="${escHtml(search)}">
      ${Properties.renderField(field, val, comp.id)}
      ${this._defaultLine(def, field, val)}
    </div>`;
  },

  // "Default: 8 %" under a field whose value differs from the type default
  _defaultLine(def, field, val) {
    const d = (def.defaults || {})[field.key];
    if (d === undefined || d === '' || d === null || typeof d === 'object' || field.key === 'name') return '';
    if (!['number', 'select'].includes(field.type)) return '';
    const same = field.type === 'number'
      ? Math.abs(parseFloat(val) - parseFloat(d)) < 1e-9
      : String(val) === String(d);
    if (same || val === '') return '';
    let text;
    if (field.type === 'select') {
      const o = (field.options || []).find(o => String(typeof o === 'object' ? o.value : o) === String(d));
      text = o ? (typeof o === 'object' ? o.label : o) : d;
    } else {
      const unit = field.unitOptions ? (field.unitOptions.find(u => u.mult === 1) || {}).label : field.unit;
      text = `${d}${unit ? ' ' + unit : ''}`;
    }
    return `<div class="pw-default">Default: ${escHtml(String(text))}</div>`;
  },

  // Say which fields are hidden and which setting reveals them
  _hiddenNote(def, hidden) {
    if (!hidden.length) return '';
    const deps = [...new Set(hidden.map(f => f.showWhen && f.showWhen.field))]
      .filter(Boolean)
      .map(k => (def.fields.find(f => f.key === k) || {}).label || k);
    const n = hidden.length;
    return `<div class="pw-hidden-note">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>
      <span>${n} more field${n === 1 ? '' : 's'} appear${n === 1 ? 's' : ''} depending on ${escHtml(deps.join(', ') || 'other settings')}.</span>
    </div>`;
  },

  _positionHtml(comp) {
    const rot = [0, 90, 180, 270].map(r =>
      `<option value="${r}" ${comp.rotation === r ? 'selected' : ''}>${r}°</option>`).join('');
    return `
      <div class="pw-field"><div class="prop-row"><label>X</label><input type="number" data-field="__x" value="${comp.x}" step="${SNAP_SIZE}"></div></div>
      <div class="pw-field"><div class="prop-row"><label>Y</label><input type="number" data-field="__y" value="${comp.y}" step="${SNAP_SIZE}"></div></div>
      <div class="pw-field"><div class="prop-row"><label>Rotation</label><select data-field="__rotation">${rot}</select></div></div>`;
  },

  // Show the active section, or every match for the search text
  _applyView() {
    const q = this._q.trim().toLowerCase();
    let any = false;
    this.mainEl.querySelectorAll('.pw-section').forEach(sec => {
      let hits = 0;
      sec.querySelectorAll('.pw-field').forEach(f => {
        const hit = !q || (f.dataset.search || f.textContent.toLowerCase()).includes(q);
        f.hidden = !hit;
        if (hit) hits++;
      });
      const show = q ? hits > 0 : sec.dataset.sec === this._section;
      sec.hidden = !show;
      sec.classList.toggle('pw-section--search', !!q);
      if (show) any = true;
      const nav = this.navEl.querySelector(`[data-sec="${sec.dataset.sec}"]`);
      if (nav) {
        const cur = !q && sec.dataset.sec === this._section;
        nav.classList.toggle('active', cur);
        if (cur) nav.setAttribute('aria-current', 'true'); else nav.removeAttribute('aria-current');
        nav.classList.toggle('pw-nav-item--dim', !!q && hits === 0);
      }
    });
    const empty = this.mainEl.querySelector('.pw-empty');
    if (empty) empty.hidden = any;
  },

  // ── Tooltip ──
  _showTip(btn) {
    const text = Properties.fieldHelp(btn.dataset.infoKey);
    if (!text) return;
    const field = btn.closest('.pw-field');
    const label = field?.querySelector('label')?.textContent || '';
    this.tipEl.innerHTML = this._tipHtml(label, text);
    this.tipEl.hidden = false;
    this._tipBtn = btn;
    this._tipPinned = false;
    btn.setAttribute('aria-describedby', 'pw-tip');

    // Below the ⓘ, flipped above when it would run off the bottom; clamped
    // to the viewport horizontally
    const r = btn.getBoundingClientRect();
    const t = this.tipEl;
    t.style.left = '0px'; t.style.top = '0px';
    const w = t.offsetWidth, h = t.offsetHeight;
    const left = Math.max(12, Math.min(r.left - 12, window.innerWidth - w - 12));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  },

  _hideTip(force) {
    if (!this.tipEl || (this._tipPinned && !force)) return;
    this.tipEl.hidden = true;
    this._tipBtn?.removeAttribute('aria-describedby');
    this._tipBtn = null;
    this._tipPinned = false;
  },

  // FIELD_INFO / FIELD_HELP text → title, paragraphs, source lines, study chips
  _tipHtml(label, text) {
    const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
    let used = [];
    const body = [], refs = [];
    for (const line of lines) {
      const u = line.match(/^Used by:\s*(.+?)\.?$/i);
      if (u) { used = u[1].split(/,\s*/).filter(Boolean); continue; }
      if (/^Sources?:/i.test(line)) { refs.push(line); continue; }
      body.push(line);
    }
    return `<div class="pw-tip-title">${escHtml(label)}</div>`
      + body.map(p => `<p>${escHtml(p)}</p>`).join('')
      + (refs.length ? refs.map(r => `<p class="pw-tip-ref">${escHtml(r)}</p>`).join('') : '')
      + (used.length ? `<div class="pw-tip-used">${used.map(u => `<span>${escHtml(u)}</span>`).join('')}</div>` : '');
  },
};
