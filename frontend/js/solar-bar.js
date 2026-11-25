/**
 * SolarBar — the Solar toolbar across the top of the Plan (Plan mode "Solar"), and the hint bar under it.
 *
 * Everything that acts on the plan or on the 3D view of the solar roofs is one button here, in groups:
 *   Roof (Select, Roof, Roof editor, Keep-out) · Array (Place array, Gap between panels) ·
 *   Maintenance aisles (Row aisle, Column aisle, Remove aisle, Aisle width) · View (2D | 3D, Fit).
 * The buttons arm the same plan tools the palette used to (`PlanTools.set`); the three aisle tools are one tool,
 * `solaraisle`, with `opts.mode` row | col | remove (plan-solar-array.js), and in 3D `Roof3D.setTool('aisle', mode)`.
 * 2D | 3D opens / closes the Roof editor (the plan beside a live 3D view); the bar stays, so the same tools work in both.
 * The left panel of this mode is Solar's "Design parameters" dock (solar.js `mountDock`).
 *
 * Gap and Aisle width act on the picked roofs, else the roof whose array is selected, else every roof with an array.
 * Pure DOM + the globals PlanTools / PlanSolar / PlanSolarArray / RoofEditor / Roof3D; node-testable bits: `key`, `hint`.
 */
const SolarBar = {
  _icons: {
    select: '<path d="M6 3 L6 18 L10 14.5 L13 21 L15.5 20 L12.5 13.5 L18 13.5 Z"/>',
    roof: '<path d="M3 11 L12 4 L21 11 M5.5 9.5 V20 H18.5 V9.5"/>',
    editor: '<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 V21"/>',
    keepout: '<path d="M4 5 H20 V19 H4 Z M4 19 L20 5 M4 12 L12 5 M12 19 L20 12"/>',
    place: '<path d="M3 5 H11 V11 H3 Z M13 5 H21 V11 H13 Z M3 13 H11 V19 H3 Z M13 13 H21 V19 H13 Z"/>',
    row: '<path d="M3 4 H21 V9 H3 Z M3 15 H21 V20 H3 Z M7 12 H17 M7 12 l2 -1.5 M7 12 l2 1.5"/>',
    col: '<path d="M4 3 V21 H9 V3 Z M15 3 V21 H20 V3 Z M12 7 V17 M12 7 l-1.5 2 M12 7 l1.5 2"/>',
    remove: '<path d="M5 7 H19 M9 7 V4.5 H15 V7 M7 7 L8 20 H16 L17 7 M10.5 11 V16 M13.5 11 V16"/>',
    fit: '<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15"/>',
  },
  _hints: {
    select: ['Select', 'Click a roof or a panel to edit it. Pick an aisle tool to add or remove maintenance aisles.'],
    roof: ['Roof', 'Click inside a building to detect its roof, or Draw its outline. Shift-click adds, Alt-click subtracts.'],
    editor: ['Roof editor', 'Click a roof to select it. The roof tools are on the left of the 3D view.'],
    keepout: ['Keep-out', 'Click the corners of an area the panels must avoid. Enter closes it, Backspace takes a corner back.'],
    place: ['Place array', 'Click a roof and its panels are laid out on it. Gap and aisles are set in this toolbar.'],
    row: ['Row aisle', 'Click the dashed line between two rows of panels to open an aisle there. Alt-click an aisle to remove it.'],
    col: ['Column aisle', 'Click the dashed line between two columns of panels to open an aisle there. Alt-click an aisle to remove it.'],
    remove: ['Remove aisle', 'Click an aisle to remove it.'],
  },
  hint(key) { return this._hints[key] || this._hints.select; },

  // Which button is armed, from the active plan tool.
  key() {
    const t = typeof PlanTools !== 'undefined' && PlanTools.active, id = t && t.id;
    if (id === 'solaraisle') return (PlanTools.opts && PlanTools.opts.mode) || 'row';
    if (id === 'select' && this.is3d() && typeof Roof3D !== 'undefined' && Roof3D.tool === 'aisle') return Roof3D.aisleMode || 'row';
    return { roofdetect: 'roof', roofedit: 'editor', roofkeepout: 'keepout', solararray: 'place' }[id] || 'select';
  },
  is3d() { return typeof RoofEditor !== 'undefined' && !!RoofEditor.on; },
  _aisle(k) { return k === 'row' || k === 'col' || k === 'remove'; },

  // The roofs Gap / Aisle width act on.
  targets() {
    const all = PlanSolar.roofs().filter(r => r.array);
    const picked = all.filter(r => PlanSolar.sel.has(r.id));
    if (picked.length) return picked;
    const one = typeof PlanSolarArray !== 'undefined' ? all.find(r => r.id === PlanSolarArray.sel) : null;
    return one ? [one] : all;
  },

  el() { return document.getElementById('plan-solar-bar'); },
  shown() { return typeof PlanMarkup !== 'undefined' && PlanMarkup.mode === 'solar' && PlanMarkup.context === 'plan'; },

  init() {
    const el = this.el(); if (!el || el._sbBound) return;
    el._sbBound = true;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sb]'); if (!b) return;
      this._do(b.dataset.sb);
    });
  },

  // Show / hide with the Solar mode, and draw the current state.
  sync() { this.render(); },
  render() {
    const el = this.el(); if (!el) return;
    const show = this.shown();
    el.hidden = !show;
    if (!show) return;
    const key = this.key(), ts = this.targets(), gap = ts.length ? PlanSolar.gapMm(ts[0]) : 0, width = ts.length ? PlanSolar.aisleWidth(ts[0]) : 0.8, d3 = this.is3d();
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.sb : null;
    const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${this._icons[k]}</svg>`;
    const btn = (k, label, tip) => `<button type="button" class="sb-btn${key === k ? ' on' : ''}" data-sb="${k}" aria-pressed="${key === k}" title="${tip}">${svg(k)}<span>${label}</span></button>`;
    const step = (k, label, value, minus, plus) => `<div class="sb-step"><div class="sb-v"><button type="button" data-sb="${k}-" aria-label="${minus}">−</button><output>${value}</output><button type="button" data-sb="${k}+" aria-label="${plus}">+</button></div><small>${label}</small></div>`;
    const grp = (name, inner) => `<div class="sb-grp" role="group" aria-label="${name}"><span class="sb-glab">${name}</span><div class="sb-row">${inner}</div></div>`;
    const [ht, hb] = this.hint(key);
    el.innerHTML = `<div class="sb-bar" role="toolbar" aria-label="Solar tools for the plan and the 3D view">
        ${grp('Roof', btn('select', 'Select', 'Select roofs and panels (V)') + btn('roof', 'Roof', 'Detect a building roof, or draw its outline') + btn('editor', 'Roof editor', 'The plan and a live 3D view side by side') + btn('keepout', 'Keep-out', 'An area of a roof the panels must avoid'))}
        <div class="sb-sep"></div>
        ${grp('Array', btn('place', 'Place array', 'Click a roof: the panels are laid out on it') + step('gap', 'Gap between panels', gap + ' mm', 'Smaller gap between panels', 'Bigger gap between panels'))}
        <div class="sb-sep"></div>
        ${grp('Maintenance aisles', btn('row', 'Row aisle', 'Open an aisle between two rows of panels') + btn('col', 'Column aisle', 'Open an aisle between two columns of panels') + btn('remove', 'Remove aisle', 'Click an aisle to remove it') + step('w', 'Aisle width', width.toFixed(1) + ' m', 'Narrower aisle', 'Wider aisle'))}
        <div class="sb-sep"></div>
        <div class="sb-grp" role="group" aria-label="View"><span class="sb-glab">View</span><div class="sb-row sb-center">
          <div class="sb-seg" role="group" aria-label="2D or 3D"><button type="button" data-sb="v2" class="${d3 ? '' : 'on'}" aria-pressed="${!d3}">2D</button><button type="button" data-sb="v3" class="${d3 ? 'on' : ''}" aria-pressed="${d3}">3D</button></div>
          <button type="button" class="sb-btn" data-sb="fit" title="Zoom to fit">${svg('fit')}<span>Fit</span></button>
        </div></div>
      </div>
      <div class="sb-hint"><strong>${ht}</strong><span title="${hb}">${hb}</span><small>Esc to stop</small></div>`;
    if (keep) { const b = el.querySelector(`[data-sb="${keep}"]`); if (b) b.focus(); }
  },

  _toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m, 'info', 3000); },

  _do(k) {
    if (k === 'v2') return this.view('2d');
    if (k === 'v3') return this.view('3d');
    if (k === 'fit') { if (typeof PlanEngine !== 'undefined') PlanEngine.zoomFit(); return; }
    if (k === 'gap-' || k === 'gap+' || k === 'w-' || k === 'w+') return this.step(k[0] === 'g' ? 'gap' : 'w', k.endsWith('+') ? 1 : -1);
    this.pick(k);
  },

  pick(key) {
    const set = (id, opts) => PlanTools.set(id, Object.assign({ type: id }, opts || {}));
    const d3 = this.is3d();
    if (key === 'select') { if (d3) RoofEditor.setTool('select'); else PlanTools.set('select'); }
    else if (key === 'roof') set('roofdetect');
    else if (key === 'keepout') set('roofkeepout');
    else if (key === 'place') set('solararray');
    else if (key === 'editor') set('roofedit');
    else if (this._aisle(key)) set('solaraisle', { mode: key });
    if (d3 && typeof Roof3D !== 'undefined' && key !== 'editor') Roof3D.setTool(this._aisle(key) ? 'aisle' : 'select', this._aisle(key) ? key : undefined);   // the 3D view follows the toolbar
    this.render();
  },

  // 2D = the plan alone, 3D = the Roof editor (the plan beside a live 3D view). The armed tool carries over.
  async view(v) {
    const k = this.key();
    if (v === '3d' && !this.is3d()) { await RoofEditor.open(); if (this._aisle(k)) this.pick(k); }
    else if (v === '2d' && this.is3d()) { RoofEditor.close(); if (this._aisle(k)) this.pick(k); }
    this.render();
  },

  step(kind, dir) {
    const ts = this.targets();
    if (!ts.length) { this._toast('Place an array on a roof first (Array › Place array).'); return; }
    for (const r of ts) {
      if (kind === 'gap') PlanSolarArray.edit(r, { panelGap: Math.max(0, Math.min(100, PlanSolar.gapMm(r) + 5 * dir)) });
      else PlanSolarArray.edit(r, { aisleWidth: +Math.max(0.3, Math.min(3, PlanSolar.aisleWidth(r) + 0.1 * dir)).toFixed(1) });
    }
    if (this.is3d() && typeof Roof3D !== 'undefined') Roof3D.refresh();
    this.render();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.refreshProps) PlanMarkup.refreshProps();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SolarBar;
