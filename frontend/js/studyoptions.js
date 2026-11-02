/* ProtectionPro — study options.
 *
 * The run options of a study (load flow method, fault type, simultaneous-fault
 * types, "show flow arrows") used to be form controls inside the Analyse menu.
 * They now live in one Options panel beside Analyse, grouped by study, and are
 * saved with the project, so a project opens with the options it was run with.
 * The controls keep their ids, so every study runs as before; `data-opt-for`
 * names the Analyse item each one belongs to (the phone's study setup reads it).
 *
 * `OPTIONS` is the table; the values live in `AppState.studyOptions` (a value
 * that is the control's first option is not stored); the arrows already live in
 * `showFlowArrows`.
 */

const StudyOptions = {
  OPTIONS: [
    { id: 'loadflow-method', for: 'btn-run-loadflow', group: 'Load flow', label: 'Method', field: 'loadflowMethod' },
    { id: 'chk-loadflow-arrows', for: 'btn-run-loadflow', group: 'Load flow', label: 'Show flow arrows' },
    { id: 'fault-type', for: 'btn-run-fault', group: 'Short circuit', label: 'Fault type', field: 'faultType' },
    { id: 'chk-fault-arrows', for: 'btn-run-fault', group: 'Short circuit', label: 'Show fault flow arrows' },
    { id: 'simultaneous-fault-series-type', for: 'btn-simultaneous-fault', group: 'Simultaneous series + shunt fault', label: 'Series fault', field: 'simSeries' },
    { id: 'simultaneous-fault-shunt-type', for: 'btn-simultaneous-fault', group: 'Simultaneous series + shunt fault', label: 'Shunt fault', field: 'simShunt' },
  ],

  // Group the table for the panel: [{ group, items: [option] }] in order.
  groups() {
    const out = [];
    for (const o of this.OPTIONS) {
      let g = out.find(x => x.group === o.group);
      if (!g) { g = { group: o.group, items: [] }; out.push(g); }
      g.items.push(o);
    }
    return out;
  },

  _store() { return AppState.studyOptions || (AppState.studyOptions = {}); },

  // Put the saved values in the controls (after a project loads or resets).
  apply() {
    const s = AppState.studyOptions || {};
    for (const o of this.OPTIONS) {
      if (!o.field) continue;
      const el = document.getElementById(o.id);
      if (!el) continue;
      const want = s[o.field];
      el.value = want != null && [...el.options].some(op => op.value === want) ? want : el.options[0].value;
    }
  },

  init() {
    const anchor = document.getElementById('menu-analyse');
    if (!anchor || document.getElementById('study-options')) return;
    const pop = document.createElement('span');
    pop.className = 'ws-pop study-options';
    pop.id = 'study-options';
    pop.innerHTML = '<button type="button" class="toolbar-menu-btn" aria-expanded="false" aria-haspopup="true" title="How the studies run: load flow method, fault type, flow arrows. Saved with the project.">Options</button>'
      + '<span class="ws-pop-panel so-panel">' + this.groups().map(g => `<span class="so-group"><span class="so-title">${escHtml(g.group)}</span>`
        + g.items.map(o => `<label class="so-row" data-so="${escHtml(o.id)}"><span>${escHtml(o.label)}</span></label>`).join('') + '</span>').join('') + '</span>';
    anchor.insertAdjacentElement('afterend', pop);
    for (const o of this.OPTIONS) {
      const el = document.getElementById(o.id);
      const row = pop.querySelector(`[data-so="${o.id}"]`);
      if (!el || !row) continue;
      const wrap = el.closest('label.dropdown-checkbox');
      row.appendChild(el);                       // the control moves; its id and handlers stay
      if (wrap) wrap.remove();
      el.dataset.optFor = o.for;
      el.dataset.optLabel = o.label;
      el.classList.remove('dropdown-inline-select');
      if (o.field) el.addEventListener('change', () => {
        const s = this._store();
        if (el.selectedIndex === 0) delete s[o.field]; else s[o.field] = el.value;
        AppState.dirty = true;
      });
    }
    this.apply();
  },
};
