/* ProtectionPro — Quantities workspace.
 *
 * Bill of quantities, Cable schedules and the Rate library as a workspace tab
 * of their own (the last step of a Reticulation / Building project), with a
 * rail on the left and the selected view filling the pane.
 *
 * It owns no rendering. Each view is the existing dialog's content — BOQ,
 * CableSchedules and Rates build their own `.modal` element — which is DOCKED
 * here: moved into the pane and given `.q-docked` (quantities.css turns the
 * overlay into a plain full-size panel). Every feature of the three views, and
 * every export, is therefore shared rather than reimplemented. A docked view
 * has no close: its `close()` is a no-op, leaving is done with the tabs.
 */

const Quantities = {
  _active: false,
  _built: false,
  view: 'boq',

  VIEWS: [
    { id: 'boq', label: 'Bill of quantities', modal: 'boq-modal', mod: () => BOQ,
      desc: 'Priced take-off from Demand, plans, single-line and DB schedules' },
    { id: 'cables', label: 'Cable schedules', modal: 'cables-modal', mod: () => CableSchedules,
      desc: 'Every feeder and service with current, loading and volt drop' },
    { id: 'rates', label: 'Rate library', modal: 'rates-modal', mod: () => Rates,
      desc: 'Rates, waste % and supplier codes · round trip with Excel' },
  ],

  init() { this.buildDOM(); },

  buildDOM() {
    const ws = document.getElementById('quantities-workspace');
    if (!ws || this._built) return;
    const I = (p) => Rates._icon(p, 16);
    const icons = {
      boq: I('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>'),
      cables: I('<path d="M2 5h5a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h3"/><circle cx="2.5" cy="5" r="1"/><circle cx="13.5" cy="11" r="1"/>'),
      rates: I('<path d="M8 2v12M11 4.5c0-1.2-1.3-2-3-2s-3 .8-3 2 1.3 1.8 3 2.2 3 1 3 2.3-1.3 2-3 2-3-.8-3-2"/>'),
    };
    ws.innerHTML = `
      <aside class="q-rail" aria-label="Quantities">
        <div class="q-rail-head">Quantities</div>
        <div role="tablist" aria-orientation="vertical" class="q-rail-list">
          ${this.VIEWS.map(v => `<button type="button" class="q-rail-item" role="tab" data-q-view="${v.id}" aria-selected="false">
            <span class="q-rail-ic">${icons[v.id]}</span>
            <span class="q-rail-txt"><span class="q-rail-t">${escHtml(v.label)}</span><span class="q-rail-d">${escHtml(v.desc)}</span></span>
            <span class="q-badge" id="q-rail-badge-${v.id}" hidden></span>
          </button>`).join('')}
        </div>
        <div class="q-rail-foot">Taken off from Demand, plans, single-line and DB schedules. Also in <kbd>Ctrl K</kbd></div>
      </aside>
      <section class="q-pane" id="q-pane"></section>`;
    ws.querySelector('.q-rail-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-q-view]');
      if (b) this.show(b.dataset.qView);
    });
    this._built = true;
  },

  // Header menu / Output menu / Ctrl K entry point: go to the workspace on a view.
  open(view, opts) {
    if (view) this.view = view;
    this._pending = opts || null;
    if (typeof window.switchWorkspace === 'function') window.switchWorkspace('quantities');
    else this.activate();
  },

  activate() {
    this._active = true;
    this.buildDOM();
    const o = this._pending; this._pending = null;
    this.show(this.view, o);
  },

  deactivate() {
    this._active = false;
    for (const v of this.VIEWS) this._undock(v);
  },

  show(view, opts) {
    if (!this._built) this.buildDOM();
    const v = this.VIEWS.find(x => x.id === view) || this.VIEWS[0];
    this.view = v.id;
    const pane = document.getElementById('q-pane');
    // Stand the other views down first, so only one is ever docked.
    for (const o of this.VIEWS) if (o !== v) this._undock(o);
    const mod = v.mod();
    if (v.id === 'rates') mod.open(opts || {});
    else mod.open();
    const m = document.getElementById(v.modal);
    if (m && pane) {
      m.classList.add('q-docked');
      pane.appendChild(m);
      m.style.display = 'flex';
    }
    document.querySelectorAll('#quantities-workspace [data-q-view]').forEach(b => {
      const on = b.dataset.qView === v.id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    this.refreshBadges();
  },

  _undock(v) {
    const m = document.getElementById(v.modal);
    if (!m || !m.classList.contains('q-docked')) return;
    m.classList.remove('q-docked');
    m.style.display = 'none';
    document.body.appendChild(m);
  },

  // Is this dialog element currently docked in the workspace? (Its close() is then a no-op.)
  isDocked(id) {
    const m = document.getElementById(id);
    return !!(m && m.classList.contains('q-docked'));
  },

  refreshBadges() {
    const set = (id, n, cls, text) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.hidden = !n;
      b.className = 'q-badge ' + cls;
      b.textContent = n ? text : '';
    };
    try {
      const av = BOQ.available();
      const res = Object.values(av).some(Boolean) ? BOQ.compute(BOQ._defaultOpts()) : null;
      const n = res ? res.missing.length : 0;
      set('q-rail-badge-rates', n, 'amb', `${n} no rate`);
    } catch (e) { set('q-rail-badge-rates', 0, 'amb', ''); }
    try {
      const rows = [...((CableSchedules.reticRows() || {}).rows || []), ...((CableSchedules.buildingRows() || {}).rows || [])];
      const n = rows.filter(r => r.status && r.status.kind === 'bad').length;
      set('q-rail-badge-cables', n, 'bad', `${n} ${n === 1 ? 'problem' : 'problems'}`);
    } catch (e) { set('q-rail-badge-cables', 0, 'bad', ''); }
  },

  onProjectChanged() {
    if (this._active) this.show(this.view);
  },
};
