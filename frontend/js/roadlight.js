/* ProtectionPro — Road lighting design (Street lighting › Lighting design).
 *
 * Ulysse-style photometric design of a straight road: a cross-section of strips
 * (carriageways with lanes, footpaths, cycle tracks, verges, medians) lit by one
 * or more rows of luminaires at a common spacing. The backend engine
 * (/api/analysis/road-lighting, analysis/road_lighting.py) runs the EN 13201-3
 * calculation — illuminance, luminance on the CIE r-table road surface, TI,
 * REI, Uo/Ul — against the EN 13201-2 / SANS 10098-1 classes, and solves the
 * max spacing or a height × tilt × overhang × luminaire × dimming optimisation.
 *
 * State (saved with the project), inside AppState.reticulation.streetLighting:
 *   photometry   { id → canonical Type C web (IES / LDT / generic) + rotate }
 *   roadDesigns  [ { id, name, sections[], rows[], spacing, mf, hours, … } ]
 * Results are on demand (this._results, never saved).
 *
 * Row geometry is kept the way a designer thinks of it — side, pole setback
 * behind the kerb, arm overhang towards the road — and turned into absolute
 * cross-section positions only for the engine (_rowsPayload).
 */

const RL_SECTION_TYPES = [
  { id: 'carriageway', name: 'Carriageway' },
  { id: 'footpath', name: 'Footpath' },
  { id: 'cycle', name: 'Cycle track' },
  { id: 'verge', name: 'Verge' },
  { id: 'median', name: 'Median' },
];
const RL_SURFACES = ['R1', 'R2', 'R3', 'R4', 'C1', 'C2'];
// CIE road-surface classes (CIE 30-2 / CIE 66 / CIE 144): what each r-table
// represents. Q0 = average luminance coefficient (brightness), S1 = specular
// factor (how mirror-like, i.e. how much the far luminaires' glare-spot counts).
const RL_SURFACE_INFO = {
  R1: { short: 'Diffuse — concrete, light surfaces', q0: 0.10, s1: 0.25,
    desc: 'Mostly diffuse. Cement concrete, or asphalt with at least 15 % artificial brightener or 80 % very light aggregate.' },
  R2: { short: 'Mixed — coarse or new asphalt', q0: 0.07, s1: 0.58,
    desc: 'Mixed diffuse and specular. Coarse-textured asphalt with more than 60 % gravel over 10 mm, asphalt with 10–15 % brightener, or new asphalt.' },
  R3: { short: 'Slightly specular — typical asphalt (default)', q0: 0.07, s1: 1.11,
    desc: 'Slightly specular. Dense asphalt with rough-textured aggregate over 10 mm, after a few months of traffic. The usual choice for an asphalt road.' },
  R4: { short: 'Specular — smooth or polished asphalt', q0: 0.08, s1: 1.55,
    desc: 'Mostly specular. Mastic asphalt or very smooth surfaces after several months of use; polished, glossy roads.' },
  C1: { short: 'Diffuse — C system (concrete, light asphalt)', q0: 0.10, s1: 0.24,
    desc: 'The two-class C system. Diffuse surfaces: concrete and asphalt with light aggregate.' },
  C2: { short: 'Specular — C system (most asphalt)', q0: 0.07, s1: 0.97,
    desc: 'The two-class C system. Most asphalt surfaces; also the CIE 140 example table.' },
};
// Lighting-class standards (values as backend road_lighting.py). A design
// picks one (`standard`); a design saved before SANS support has none and is EN.
// EN 13201-2:2015 — M / C / P classes.
const RL_CLASS_REQ = {
  M1: 'L̄ ≥ 2.00 cd/m², Uo ≥ 0.40, Ul ≥ 0.70, TI ≤ 10 %, REI ≥ 0.35', M2: 'L̄ ≥ 1.50 cd/m², Uo ≥ 0.40, Ul ≥ 0.70, TI ≤ 10 %, REI ≥ 0.35',
  M3: 'L̄ ≥ 1.00 cd/m², Uo ≥ 0.40, Ul ≥ 0.60, TI ≤ 15 %, REI ≥ 0.30', M4: 'L̄ ≥ 0.75 cd/m², Uo ≥ 0.40, Ul ≥ 0.60, TI ≤ 15 %, REI ≥ 0.30',
  M5: 'L̄ ≥ 0.50 cd/m², Uo ≥ 0.35, Ul ≥ 0.40, TI ≤ 15 %, REI ≥ 0.30', M6: 'L̄ ≥ 0.30 cd/m², Uo ≥ 0.35, Ul ≥ 0.40, TI ≤ 20 %, REI ≥ 0.30',
  C0: 'Ē ≥ 50 lx, Uo ≥ 0.40', C1: 'Ē ≥ 30 lx, Uo ≥ 0.40', C2: 'Ē ≥ 20 lx, Uo ≥ 0.40', C3: 'Ē ≥ 15 lx, Uo ≥ 0.40', C4: 'Ē ≥ 10 lx, Uo ≥ 0.40', C5: 'Ē ≥ 7.5 lx, Uo ≥ 0.40',
  P1: 'Ē ≥ 15 lx, Emin ≥ 3.0 lx', P2: 'Ē ≥ 10 lx, Emin ≥ 2.0 lx', P3: 'Ē ≥ 7.5 lx, Emin ≥ 1.5 lx', P4: 'Ē ≥ 5.0 lx, Emin ≥ 1.0 lx', P5: 'Ē ≥ 3.0 lx, Emin ≥ 0.6 lx', P6: 'Ē ≥ 2.0 lx, Emin ≥ 0.4 lx',
};
const RL_CLASS_FAMILY = {
  M: 'Traffic routes (motorised traffic at moderate to high speed) — rated on road-surface luminance. M1 is the most demanding, M6 the least.',
  C: 'Conflict areas — junctions, roundabouts, crossings, shopping streets — where drivers look at short range, so illuminance is used instead of luminance.',
  P: 'Pedestrians, cyclists and low-speed residential streets, footpaths and cycle tracks — rated on horizontal illuminance.',
};
const RL_CLASS_GROUPS = [
  { label: 'Luminance (traffic routes)', list: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'] },
  { label: 'Conflict areas', list: ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'] },
  { label: 'Pedestrian / low speed', list: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] },
];
// SANS 10098-1:2007 Table 1 (group A: Ln cd/m², Uo, UL, TI %) by cross-section
// and traffic-volume column (0 = heaviest), Table 2 (groups B, C), and the
// SANS 10098-2:2005 roadway-complex (Table 1) and cycle/pedestrian (Table 3) classes.
const RL_SANS_A = {
  A1: { noMedian: [[2, 0.4, 0.7, 15], [1.5, 0.4, 0.7, 20], [1, 0.4, 0.6, 20]], median: [[2, 0.4, 0.7, 15], [1.5, 0.4, 0.7, 20], [1, 0.4, 0.6, 20]] },
  A2: { noMedian: [[1.5, 0.4, 0.7, 20], [1, 0.4, 0.6, 20], [0.8, 0.4, 0.5, 20]], median: [[1.5, 0.4, 0.7, 20], [1, 0.4, 0.6, 20], [0.8, 0.4, 0.5, 20]] },
  A3: { noMedian: [[1, 0.4, 0.6, 20], [0.6, 0.4, 0.5, 20], [0.5, 0.4, 0.5, 20]], median: [[1, 0.4, 0.6, 20], [0.8, 0.4, 0.5, 20], [0.5, 0.4, 0.5, 20]] },
  A4: { noMedian: [[0.75, 0.4, 0.5, 20], [0.5, 0.4, 0.5, 20], [0.3, 0.3, 0.5, 25]], median: [[0.75, 0.4, 0.5, 20], [0.5, 0.4, 0.5, 20], [0.3, 0.3, 0.5, 25]] },
};
const RL_SANS_BANDS = {
  noMedian: ['> 600 veh/h/lane', '≤ 300 veh/h/lane', '≤ 100 veh/h/lane'],
  median: ['> 900 veh/h/lane', '≤ 600 veh/h/lane', '≤ 200 veh/h/lane'],
};
const RL_SANS_CLASS_REQ = {
  B1: 'Ē ≥ 5 lx, Emin ≥ 1 lx (Esc,min 2 lx supplementary)', B2: 'Ē ≥ 3 lx, Emin ≥ 0.6 lx (Esc,min 1 lx supplementary)', B3: 'Ē ≥ 2 lx, Emin ≥ 0.4 lx (Esc,min 0.6 lx supplementary)',
  C1: 'Ē ≥ 10 lx, Emin ≥ 3 lx (Esc,min 7.5 lx supplementary)', C2: 'Ē ≥ 7.5 lx, Emin ≥ 1.5 lx (Esc,min 3 lx supplementary)',
  RC0: 'Ē ≥ 50 lx, Uo ≥ 0.40', RC1: 'Ē ≥ 30 lx, Uo ≥ 0.40', RC2: 'Ē ≥ 20 lx, Uo ≥ 0.40', RC3: 'Ē ≥ 15 lx, Uo ≥ 0.40', RC4: 'Ē ≥ 10 lx, Uo ≥ 0.40', RC5: 'Ē ≥ 7.5 lx, Uo ≥ 0.40',
  CP1: 'Ē ≥ 15 lx, Emin ≥ 5 lx', CP2: 'Ē ≥ 10 lx, Emin ≥ 3 lx', CP3: 'Ē ≥ 7.5 lx, Emin ≥ 1.5 lx', CP4: 'Ē ≥ 5 lx, Emin ≥ 1 lx', CP5: 'Ē ≥ 3 lx, Emin ≥ 0.6 lx', CP6: 'Ē ≥ 2 lx, Emin ≥ 0.6 lx',
};
const RL_SANS_NAMES = {
  A1: 'Freeway / expressway with median, free of level crossings, > 90 km/h', A2: 'Major road, ≤ 90 km/h', A3: 'Important urban traffic route, ≤ 60 km/h',
  A4: 'Connecting road, local distributor, residential major road',
  B1: 'Residential street, medium to high traffic', B2: 'Residential street, medium traffic', B3: 'Residential street, low traffic',
  C1: 'Wholly pedestrian, city centre', C2: 'Wholly pedestrian, local shopping mall',
  RC0: 'Roadway complex class 0', RC1: 'Roadway complex class 1', RC2: 'Roadway complex class 2', RC3: 'Roadway complex class 3', RC4: 'Roadway complex class 4', RC5: 'Roadway complex class 5',
  CP1: 'Cycle / pedestrian way class 1', CP2: 'Cycle / pedestrian way class 2', CP3: 'Cycle / pedestrian way class 3', CP4: 'Cycle / pedestrian way class 4', CP5: 'Cycle / pedestrian way class 5', CP6: 'Cycle / pedestrian way class 6',
};
const RL_SANS_GROUPS = [
  { label: 'Group A — important routes (luminance)', list: ['A1', 'A2', 'A3', 'A4'] },
  { label: 'Group B — residential streets', list: ['B1', 'B2', 'B3'] },
  { label: 'Group C — pedestrian areas', list: ['C1', 'C2'] },
  { label: 'Roadway complexes (SANS 10098-2)', list: ['RC0', 'RC1', 'RC2', 'RC3', 'RC4', 'RC5'] },
  { label: 'Cycle / pedestrian ways (SANS 10098-2)', list: ['CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6'] },
];
const RL_SANS_FAMILY = {
  A: 'Group A — important routes, designed on road-surface luminance (SANS 10098-1 Table 1). The values depend on the night-time traffic volume per lane and on whether the road has a median. L̄ and Uo are taken from one observer a quarter of the carriageway width in from the left; Ul from an observer in each lane.',
  B: 'Group B — residential streets, designed on horizontal illuminance over the carriageway and the footways up to 2 m from its edge (Table 2). Semi-cylindrical illuminance is a supplementary criterion for higher-security areas.',
  C: 'Group C — wholly pedestrian areas (Table 2).',
  RC: 'Roadway complexes — interchanges, junctions (SANS 10098-2 Table 1); pick the class with SANS 10098-2 Table 2 (crime risk, facial recognition, navigation, pedestrians, ambient brightness). Where the feeder roads are lit, use the next higher road class instead if it is higher (4.2.2.3).',
  CP: 'Cycle and pedestrian ways (SANS 10098-2 Table 3), selected with its Table 4.',
};
const RL_STANDARDS = [
  { id: 'SANS', name: 'SANS 10098-1 (South Africa)' },
  { id: 'EN', name: 'EN 13201-2 (M / C / P)' },
];
// Switching a design's standard maps each strip's class to the nearest
// equivalent (the user reviews them — the families are not identical).
const RL_EN_TO_SANS = { M1: 'A1', M2: 'A2', M3: 'A3', M4: 'A4', M5: 'A4', M6: 'A4', C0: 'RC0', C1: 'RC1', C2: 'RC2', C3: 'RC3', C4: 'RC4', C5: 'RC5' };
const RL_SANS_TO_EN = { A1: 'M1', A2: 'M2', A3: 'M3', A4: 'M4', B1: 'P4', B2: 'P5', B3: 'P6', C1: 'P2', C2: 'P3', RC0: 'C0', RC1: 'C1', RC2: 'C2', RC3: 'C3', RC4: 'C4', RC5: 'C5', CP1: 'P1', CP2: 'P2', CP3: 'P3', CP4: 'P4', CP5: 'P5', CP6: 'P6' };
const RL_SIDES = [
  { id: 'left', name: 'Left verge' },
  { id: 'right', name: 'Right verge' },
  { id: 'medianL', name: 'Median → left' },
  { id: 'medianR', name: 'Median → right' },
];
const RL_ARRANGEMENTS = [
  { id: 'single-left', name: 'Single-sided (left)' },
  { id: 'single-right', name: 'Single-sided (right)' },
  { id: 'opposite', name: 'Opposite' },
  { id: 'staggered', name: 'Staggered' },
  { id: 'twin-central', name: 'Twin central' },
  { id: 'custom', name: 'Custom rows' },
];
// `cls` is the EN class, `sans` the SANS 10098-1 category for the same strip.
const RL_TEMPLATES = [
  { id: 'two-lane', name: 'Two-lane 7.4 m + footpaths', sections: [
    { type: 'footpath', width: 2, cls: 'P4', sans: '' },
    { type: 'carriageway', width: 7.4, lanes: 2, cls: 'M4', sans: 'A4', surface: 'R3' },
    { type: 'footpath', width: 2, cls: 'P4', sans: '' }] },
  { id: 'residential', name: 'Residential 6 m', sections: [
    { type: 'verge', width: 2, cls: '', sans: '' },
    { type: 'carriageway', width: 6, lanes: 2, cls: 'P3', sans: 'B2', surface: 'R3' },
    { type: 'verge', width: 2, cls: '', sans: '' }] },
  { id: 'four-lane', name: 'Four-lane 14 m + footpaths', sections: [
    { type: 'footpath', width: 2.5, cls: 'P3', sans: '' },
    { type: 'carriageway', width: 14, lanes: 4, cls: 'M3', sans: 'A3', surface: 'R3' },
    { type: 'footpath', width: 2.5, cls: 'P3', sans: '' }] },
  { id: 'dual', name: 'Dual carriageway 2 × 7.4 m, 4 m median', sections: [
    { type: 'footpath', width: 2, cls: 'P4', sans: '' },
    { type: 'carriageway', width: 7.4, lanes: 2, cls: 'M3', sans: 'A2', surface: 'R3', direction: 'forward' },
    { type: 'median', width: 4, cls: '', sans: '' },
    { type: 'carriageway', width: 7.4, lanes: 2, cls: 'M3', sans: 'A2', surface: 'R3', direction: 'reverse' },
    { type: 'footpath', width: 2, cls: 'P4', sans: '' }] },
];

const RoadLight = {
  _active: false,
  _built: false,
  _selId: null,
  _results: {},       // design id → verify result
  _sweeps: {},        // design id → max-spacing result
  _opt: {},           // design id → optimise result
  _req: 0,
  _timer: null,
  _busy: '',

  // ─── Data ────────────────────────────────────────────────────────────
  get sl() {
    const d = StreetLight.data;
    if (!Array.isArray(d.roadDesigns)) d.roadDesigns = [];
    if (!d.photometry || typeof d.photometry !== 'object') d.photometry = {};
    if (!d._rdSeq) d._rdSeq = 1;
    if (!d._phSeq) d._phSeq = 1;
    return d;
  },
  get designs() { return this.sl.roadDesigns; },
  get library() { return this.sl.photometry; },
  design(id) { return this.designs.find(d => d.id === id) || null; },
  get selected() { return this.design(this._selId); },
  _num(v, d) { const x = parseFloat(v); return isFinite(x) ? x : d; },
  _fmt(v, dp = 2) { return v === null || v === undefined || !isFinite(v) ? '—' : (+v).toFixed(dp); },
  _markDirty() { AppState.dirty = true; },
  _genSecId(des) { des._secSeq = (des._secSeq || 1) + 1; return 'sec_' + des._secSeq; },
  _genRowId(des) { des._rowSeq = (des._rowSeq || 1) + 1; return 'row_' + des._rowSeq; },

  // ─── Mount / lifecycle (called by StreetLight's view switch) ─────────
  mount(host) {
    if (this._built || !host) return;
    this._built = true;
    host.innerHTML = `
      <aside class="sl-rail rl-rail">
        <div class="sl-rail-head">Lighting designs</div>
        <div id="rl-rail-list" class="sl-rail-list rl-rail-designs"></div>
        <div class="sl-rail-head rl-lib-head"><span>Luminaires</span>
          <span class="rl-lib-actions">
            <button class="btn-small" data-rl="import" title="Import IES (LM-63) or EULUMDAT (.ldt) files from the manufacturer">Import IES / LDT</button>
            <button class="btn-small" data-rl="generic" title="A generic road optic for feasibility, before a product is chosen">+ Generic</button>
          </span></div>
        <div id="rl-lib-list" class="sl-rail-list rl-lib-list"></div>
        <input type="file" id="rl-file" accept=".ies,.IES,.ldt,.LDT,.eul" multiple hidden>
      </aside>
      <section class="sl-main" id="rl-main"></section>
      <aside class="sl-results rl-results" id="rl-results"></aside>`;
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => this._onChange(e));
    host.querySelector('#rl-file').addEventListener('change', (e) => this._importFiles(e.target.files));
  },

  activate(host) {
    this.mount(host);
    this._active = true;
    if (!this.selected) this._selId = this.designs.length ? this.designs[0].id : null;
    this.render();
    if (this.selected && !this._results[this._selId]) this.recompute(0);
  },
  deactivate() { this._active = false; clearTimeout(this._timer); },
  onProjectChanged() {
    this._results = {}; this._sweeps = {}; this._opt = {};
    this._selId = this.designs.length ? this.designs[0].id : null;
    if (this._active) { this.render(); this.recompute(0); }
  },

  // ─── Library ─────────────────────────────────────────────────────────
  _libList() { return Object.values(this.library).sort((a, b) => String(a.name).localeCompare(String(b.name))); },
  _lumLabel(p) { return p ? `${p.name} · ${Math.round(p.lumens)} lm · ${this._fmt(p.watts, 0)} W` : '(missing luminaire)'; },

  async _addGeneric(kind = 'generic_medium', lumens = 10000, watts = 80) {
    const prof = await API.request('/analysis/road-lighting/generic', 'POST', { kind, lumens, watts });
    const id = 'ph_' + (this.sl._phSeq++);
    this.library[id] = Object.assign(prof, { id, rotate: 0 });
    this._markDirty();
    return id;
  },

  async _importFiles(files) {
    const list = Array.from(files || []);
    const input = document.getElementById('rl-file');
    if (input) input.value = '';
    const added = [], failed = [];
    for (const f of list) {
      try {
        const text = await f.text();
        const prof = await API.request('/analysis/road-lighting/photometry', 'POST', { text, filename: f.name });
        const id = 'ph_' + (this.sl._phSeq++);
        this.library[id] = Object.assign(prof, { id, rotate: 0, fileName: f.name });
        added.push(prof.name || f.name);
      } catch (e) {
        failed.push(`${f.name}: ${e && e.message ? e.message : e}`);
      }
    }
    if (added.length) this._markDirty();
    this.render();
    if (failed.length) await UI.alert('Some files could not be read:\n\n' + failed.join('\n'));
  },

  async _genericDialog() {
    const kinds = [['generic_narrow', 'Narrow — 1–2 lanes'], ['generic_medium', 'Medium — 2–3 lanes'], ['generic_wide', 'Wide — 3–4 lanes']];
    const m = this._modal('rl-generic-modal', 'Add a generic road optic', `
      <p class="rl-lead">A smooth, representative road distribution for early feasibility — <b>not a real product</b>. Import the manufacturer's IES / LDT for a compliance design.</p>
      <div class="rl-form">
        <label>Optic<select data-g="kind">${kinds.map(([k, n]) => `<option value="${k}"${k === 'generic_medium' ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Luminaire flux<span class="sl-unit"><input type="number" step="100" data-g="lumens" value="10000"> lm</span></label>
        <label>System power<span class="sl-unit"><input type="number" step="1" data-g="watts" value="80"> W</span></label>
      </div>`, `<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Add</button>`);
    const ok = await this._modalResult(m);
    if (!ok) return;
    const g = (k) => m.querySelector(`[data-g="${k}"]`).value;
    try {
      await this._addGeneric(g('kind'), this._num(g('lumens'), 10000), this._num(g('watts'), 80));
    } catch (e) { await UI.alert('Could not add the optic: ' + (e.message || e)); }
    this.render();
  },

  // ─── Designs ─────────────────────────────────────────────────────────
  async newDesign() {
    let pid = this._libList()[0] && this._libList()[0].id;
    if (!pid) {
      try { pid = await this._addGeneric(); } catch (e) { await UI.alert('Could not create a starting luminaire: ' + (e.message || e)); return; }
    }
    const des = {
      id: 'rd_' + (this.sl._rdSeq++),
      name: `Road ${this.designs.length + 1}`,
      template: 'two-lane', arrangement: 'single-left', standard: 'SANS',
      sections: [], rows: [], spacing: 35, mf: 0.8, hours: 4100,
      sweep: { min: 15, max: 60, step: 1 },
      optimise: { heights: '8, 10, 12', tilts: '0, 5, 10', overhangs: '0, 1, 2', fluxPcts: '100', photometryIds: [], rank: 'wPerKm' },
      _secSeq: 1, _rowSeq: 1,
    };
    this._applyTemplate(des, 'two-lane');
    des.rows = [this._row(des, 'left', { photometryId: pid })];
    this.designs.push(des);
    this._selId = des.id;
    this._afterMutate();
  },

  _row(des, side, base = {}) {
    return Object.assign({
      id: this._genRowId(des), side, setback: 1.0, height: 10, overhang: 1.5, tilt: 0,
      xOffset: 0, photometryId: (this._libList()[0] || {}).id || null, fluxPct: 100, rotate: 0,
    }, base, { id: this._genRowId(des), side });
  },

  _applyTemplate(des, tid) {
    const t = RL_TEMPLATES.find(x => x.id === tid);
    if (!t) return;
    des.template = tid;
    const sans = this._std(des) === 'SANS';
    des.sections = t.sections.map(s => {
      const o = Object.assign({ id: this._genSecId(des), name: '', lanes: 2, surface: 'R3', direction: 'forward', cls: '', volume: 0 }, s);
      o.cls = sans ? (s.sans || '') : (s.cls || '');
      delete o.sans;
      return o;
    });
  },

  // ─── Standard (SANS 10098-1 / EN 13201-2) ────────────────────────────
  _std(des) { return des && des.standard === 'SANS' ? 'SANS' : 'EN'; },
  _hasMedian(des) { return des.sections.some(s => s.type === 'median' && this._num(s.width, 0) > 0); },
  _classGroups(des) { return this._std(des) === 'SANS' ? RL_SANS_GROUPS : RL_CLASS_GROUPS; },
  _isLumClass(des, cls) { return this._std(des) === 'SANS' ? /^A[1-4]$/.test(cls || '') : /^M[1-6]$/.test(cls || ''); },
  // Requirement text for a strip's class — SANS group A depends on the
  // strip's traffic band and the cross-section (median or not).
  _clsReq(des, cls, s) {
    if (!cls) return '';
    if (this._std(des) !== 'SANS') return RL_CLASS_REQ[cls] || '';
    if (RL_SANS_A[cls]) {
      const set = this._hasMedian(des) ? 'median' : 'noMedian';
      const v = Math.min(2, Math.max(0, Math.round(this._num(s && s.volume, 0))));
      const [ln, uo, ul, ti] = RL_SANS_A[cls][set][v];
      return `L̄ ≥ ${ln} cd/m², Uo ≥ ${uo}, Ul ≥ ${ul}, TI ≤ ${ti} % (${RL_SANS_BANDS[set][v]}, ${set === 'median' ? 'with' : 'without'} median)`;
    }
    return RL_SANS_CLASS_REQ[cls] || '';
  },
  _clsName(des, cls) { return this._std(des) === 'SANS' ? (RL_SANS_NAMES[cls] || cls) : cls; },
  _setStandard(des, std) {
    const to = std === 'SANS' ? 'SANS' : 'EN';
    if (this._std(des) === to) return;
    const map = to === 'SANS' ? RL_EN_TO_SANS : RL_SANS_TO_EN;
    for (const s of des.sections) {
      if (!s.cls) continue;
      if (to === 'SANS' && /^P[1-6]$/.test(s.cls)) s.cls = s.type === 'carriageway' ? ({ P5: 'B2', P6: 'B3' }[s.cls] || 'B1') : 'CP' + s.cls.slice(1);
      else s.cls = map[s.cls] || '';
    }
    des.standard = to;
    UI.toast && UI.toast(`Classes mapped to ${to === 'SANS' ? 'SANS 10098-1' : 'EN 13201-2'} — check each strip's class.`);
  },

  _applyArrangement(des, arr) {
    des.arrangement = arr;
    if (arr === 'custom') return;
    const base = Object.assign({}, des.rows[0] || {});
    delete base.id; delete base.side; delete base.xOffset;
    const mk = (side, extra = {}) => this._row(des, side, Object.assign({}, base, extra));
    const hasMedian = des.sections.some(s => s.type === 'median');
    switch (arr) {
      case 'single-left': des.rows = [mk('left')]; break;
      case 'single-right': des.rows = [mk('right')]; break;
      case 'opposite': des.rows = [mk('left'), mk('right')]; break;
      case 'staggered': des.rows = [mk('left'), mk('right', { xOffset: 0.5 })]; break;
      case 'twin-central':
        des.rows = [mk('medianL', { setback: 0 }), mk('medianR', { setback: 0 })];
        if (!hasMedian) UI.alert('Twin central needs a median strip in the cross-section — add one (the poles stand at its centre).');
        break;
    }
  },

  async deleteDesign(id) {
    const d = this.design(id);
    if (!d || !(await UI.confirm(`Delete lighting design "${d.name}"?`, { danger: true, okText: 'Delete' }))) return;
    this.sl.roadDesigns = this.designs.filter(x => x.id !== id);
    delete this._results[id]; delete this._sweeps[id]; delete this._opt[id];
    this._selId = this.designs.length ? this.designs[0].id : null;
    this._afterMutate();
  },

  duplicateDesign(id) {
    const d = this.design(id);
    if (!d) return;
    const c = JSON.parse(JSON.stringify(d));
    c.id = 'rd_' + (this.sl._rdSeq++);
    c.name = d.name + ' (copy)';
    this.designs.push(c);
    this._selId = c.id;
    this._afterMutate();
  },

  _afterMutate(rerender = true) {
    this._markDirty();
    if (rerender) this.render();
    this.recompute();
  },

  // ─── Geometry → engine payload ───────────────────────────────────────
  _layout(des) {
    let y = 0;
    const secs = des.sections.map(s => {
      const w = Math.max(0, this._num(s.width, 0));
      const o = { ...s, y0: y, y1: y + w, width: w };
      y += w;
      return o;
    });
    const cws = secs.filter(s => s.type === 'carriageway' && s.width > 0);
    const leftKerb = cws.length ? cws[0].y0 : 0;
    const rightKerb = cws.length ? cws[cws.length - 1].y1 : y;
    const med = secs.find(s => s.type === 'median' && s.width > 0);
    const medY = med ? (med.y0 + med.y1) / 2 : y / 2;
    return { secs, width: y, leftKerb, rightKerb, medY };
  },

  _rowGeom(row, lay) {
    const sb = this._num(row.setback, 0);
    switch (row.side) {
      case 'right': return { poleY: lay.rightKerb + sb, facing: 'left', pole: 'right' };
      case 'medianL': return { poleY: lay.medY + sb, facing: 'left', pole: 'median' };
      case 'medianR': return { poleY: lay.medY + sb, facing: 'right', pole: 'median' };
      default: return { poleY: lay.leftKerb - sb, facing: 'right', pole: 'left' };
    }
  },

  _rowsPayload(des, lay) {
    return des.rows.map((r, i) => {
      const g = this._rowGeom(r, lay);
      const ph = this.library[r.photometryId];
      return {
        name: `Row ${i + 1}`, y: g.poleY, facing: g.facing, pole: g.pole,
        overhang: this._num(r.overhang, 0), height: this._num(r.height, 10), tilt: this._num(r.tilt, 0),
        rotate: this._num(r.rotate, 0) + (ph ? this._num(ph.rotate, 0) : 0),
        xOffset: this._num(r.xOffset, 0), photometryId: r.photometryId, fluxPct: this._num(r.fluxPct, 100),
      };
    });
  },

  _payload(des, extra = {}) {
    const lay = this._layout(des);
    const used = new Set(des.rows.map(r => r.photometryId));
    for (const id of (extra.extraPhotometry || [])) used.add(id);
    const photometry = {};
    for (const id of used) if (this.library[id]) photometry[id] = this.library[id];
    const out = {
      standard: this._std(des),
      sections: lay.secs.map(s => ({ type: s.type, name: s.name || this._secName(s, des), width: s.width, lanes: s.lanes, cls: s.cls, surface: s.surface, direction: s.direction, volume: this._num(s.volume, 0) })),
      rows: this._rowsPayload(des, lay),
      spacing: this._num(des.spacing, 30), mf: this._num(des.mf, 0.8), hoursPerYear: this._num(des.hours, 4100),
      photometry, mode: 'verify',
    };
    delete extra.extraPhotometry;
    return Object.assign(out, extra);
  },

  _secName(s, des) {
    const same = des.sections.filter(x => x.type === s.type);
    const t = (RL_SECTION_TYPES.find(x => x.id === s.type) || { name: s.type }).name;
    return same.length > 1 ? `${t} ${same.indexOf(des.sections.find(x => x.id === s.id)) + 1}` : t;
  },

  _problems(des) {
    const p = [];
    if (!des.sections.some(s => this._num(s.width, 0) > 0)) p.push('Add at least one strip to the cross-section.');
    if (!des.rows.length) p.push('Add a luminaire row.');
    for (const r of des.rows) if (!this.library[r.photometryId]) { p.push('Pick a luminaire for every row (import an IES / LDT file or add a generic optic).'); break; }
    if (!(this._num(des.spacing, 0) > 0)) p.push('Set a spacing.');
    return p;
  },

  // ─── Compute ─────────────────────────────────────────────────────────
  recompute(delay = 300) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._doCompute(), delay);
  },

  async _doCompute() {
    const des = this.selected;
    if (!des || this._problems(des).length) { this.renderResults(); return; }
    const req = ++this._req;
    this._status('Calculating…');
    try {
      const r = await API.request('/analysis/road-lighting', 'POST', this._payload(des));
      if (req !== this._req) return;
      this._results[des.id] = r.result;
      this._status('');
    } catch (e) {
      if (req !== this._req) return;
      this._results[des.id] = { error: e.message || String(e) };
      this._status('');
    }
    this.renderResults();
    this.renderRail();
    this._paintSection();
  },

  async runMaxSpacing() {
    const des = this.selected;
    if (!des) return;
    const pr = this._problems(des);
    if (pr.length) { await UI.alert(pr.join('\n')); return; }
    const sw = des.sweep || { min: 15, max: 60, step: 1 };
    this._busy = 'sweep'; this.renderResults();
    try {
      const r = await API.request('/analysis/road-lighting', 'POST', this._payload(des, { mode: 'maxSpacing', spacingSweep: sw }));
      this._sweeps[des.id] = r;
    } catch (e) {
      this._sweeps[des.id] = { error: e.message || String(e) };
    }
    this._busy = '';
    this.renderResults();
  },

  useSpacing(S) {
    const des = this.selected;
    if (!des || !(S > 0)) return;
    des.spacing = S;
    this._afterMutate();
  },

  // ─── Render ──────────────────────────────────────────────────────────
  _status(t) { const el = document.getElementById('sl-status'); if (el) el.textContent = t; },

  render() {
    if (!this._built) return;
    this.renderRail();
    this.renderMain();
    this.renderResults();
  },

  _badge(des) {
    const r = this._results[des.id];
    if (!r || r.error) return '<span class="sl-badge">—</span>';
    return r.pass ? '<span class="sl-badge ok">✓ Pass</span>' : '<span class="sl-badge bad">✗ Fail</span>';
  },

  renderRail() {
    const el = document.getElementById('rl-rail-list');
    if (!el) return;
    if (!this.designs.length) {
      el.innerHTML = `<div class="sl-empty">No lighting designs yet.<br><br><button class="btn-small btn-primary" data-rl="new">+ New design</button></div>`;
    } else {
      el.innerHTML = this.designs.map(d => {
        const r = this._results[d.id];
        const cls = [...new Set(d.sections.map(s => s.cls).filter(Boolean))].join(' · ');
        return `<button class="sl-rail-item${d.id === this._selId ? ' active' : ''}" data-rl-sel="${d.id}">
          <span class="sl-rail-row"><span class="sl-rail-name">${escHtml(d.name)}</span>${this._badge(d)}</span>
          <span class="sl-rail-meta">${escHtml((RL_ARRANGEMENTS.find(a => a.id === d.arrangement) || {}).name || '')} · S ${this._fmt(d.spacing, 1)} m${cls ? ' · ' + escHtml(cls) : ''}${r && r.energy ? ` · ${Math.round(r.energy.wPerKm)} W/km` : ''}</span>
        </button>`;
      }).join('') + `<div class="rl-rail-new"><button class="btn-small btn-primary" data-rl="new">+ New design</button></div>`;
    }
    const lib = document.getElementById('rl-lib-list');
    if (lib) {
      const list = this._libList();
      lib.innerHTML = list.length ? list.map(p => `
        <button class="sl-rail-item" data-rl-ph="${p.id}" title="Photometry, rotation and ratings">
          <span class="sl-rail-row"><span class="sl-rail-name rl-ph-name">${escHtml(p.name)}</span><span class="sl-badge">${escHtml(p.format || '')}</span></span>
          <span class="sl-rail-meta">${Math.round(p.lumens)} lm · ${this._fmt(p.watts, 0)} W${p.watts ? ` · ${Math.round(p.lumens / p.watts)} lm/W` : ''}${p.generic ? ' · generic' : ''}</span>
        </button>`).join('')
        : '<div class="sl-empty">No luminaires yet. Import the manufacturer\'s IES or LDT file, or add a generic optic for a first pass.</div>';
    }
  },

  renderMain() {
    const el = document.getElementById('rl-main');
    if (!el) return;
    const des = this.selected;
    if (!des) {
      el.innerHTML = `<div class="sl-empty sl-empty-main">
        <h3>Road lighting design</h3>
        <p>Lay out the road's cross-section, place the luminaires and get the EN 13201 / SANS 10098-1 results: average luminance or illuminance, uniformity, glare (TI) and edge ratio, with W/km and poles/km.</p>
        <p>It can then find the largest spacing that passes, or sweep mounting height, tilt, overhang, luminaire and dimming for the cheapest option.</p>
        <button class="btn-small btn-primary" data-rl="new">+ New design</button></div>`;
      return;
    }
    const opt = (list, sel) => list.map(x => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('');
    const clsOpts = (sel) => `<option value=""${!sel ? ' selected' : ''}>— not lit / not checked</option>` +
      this._classGroups(des).map(g => `<optgroup label="${g.label}">${g.list.map(c => `<option value="${c}"${c === sel ? ' selected' : ''} title="${escHtml(this._clsName(des, c) + ': ' + this._clsReq(des, c, null))}">${c}${this._std(des) === 'SANS' ? ' — ' + escHtml(RL_SANS_NAMES[c]) : ''}</option>`).join('')}</optgroup>`).join('');
    const libOpts = (sel) => (this.library[sel] ? '' : '<option value="" selected>— pick a luminaire —</option>') +
      this._libList().map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${escHtml(this._lumLabel(p))}</option>`).join('');
    const circuits = StreetLight.circuits;
    el.innerHTML = `
      <div class="sl-head">
        <input class="sl-name" data-dz="name" value="${escHtml(des.name)}" aria-label="Design name">
        <div class="sl-head-actions">
          <button class="btn-small" data-rl="dup">Duplicate</button>
          <button class="btn-small" data-rl="del">Delete</button>
        </div>
      </div>
      <div class="rl-xs-wrap"><svg id="rl-xs" class="rl-xs" role="img" aria-label="Road cross-section"></svg></div>
      <div class="rl-card">
        <div class="rl-card-head"><b>Cross-section</b><span class="sl-hint">left to right, looking in the direction of travel on the first carriageway. Each strip's <b>Class</b> is the lighting class it must meet.</span>
          <button class="btn-small rl-info-btn" data-rl="info" title="What the lighting classes and road surfaces mean">ⓘ Classes &amp; surfaces</button>
          <label class="rl-inline" title="The standard each strip's lighting class is checked against">Standard<select data-dz="standard">${RL_STANDARDS.map(x => `<option value="${x.id}"${x.id === this._std(des) ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('')}</select></label>
          <label class="rl-inline">Template<select data-dz="template"><option value="">Apply a template…</option>${RL_TEMPLATES.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')}</select></label>
          <button class="btn-small" data-rl="addsec">+ Strip</button></div>
        <table class="sl-table rl-table"><thead><tr><th>Strip</th><th>Name</th><th>Width m</th><th>Lanes</th><th title="EN 13201-2 / SANS 10098-1 lighting class the strip must meet — M traffic routes, C conflict areas, P pedestrian / residential">Class <button class="rl-icon rl-th-info" data-rl="info" aria-label="About lighting classes">ⓘ</button></th><th title="CIE road-surface reflection class (r-table), used for luminance">Surface <button class="rl-icon rl-th-info" data-rl="info" aria-label="About road surfaces">ⓘ</button></th><th title="Direction of travel the observer looks in">Traffic</th><th></th></tr></thead>
        <tbody id="rl-sec-body">${des.sections.map((s, i) => {
          const cw = s.type === 'carriageway';
          return `<tr>
            <td data-label="Strip"><select data-sec="type" data-i="${i}">${opt(RL_SECTION_TYPES, s.type)}</select></td>
            <td data-label="Name"><input data-sec="name" data-i="${i}" value="${escHtml(s.name || '')}" placeholder="${escHtml(this._secName(s, des))}"></td>
            <td data-label="Width m"><input type="number" step="0.1" min="0" data-sec="width" data-i="${i}" value="${escHtml(s.width)}" class="sl-in-num"></td>
            <td data-label="Lanes"${cw ? '' : ' class="rl-na"'}>${cw ? `<input type="number" step="1" min="1" data-sec="lanes" data-i="${i}" value="${escHtml(s.lanes)}" class="sl-in-num">` : '<span class="sl-k">—</span>'}</td>
            <td data-label="Lighting class" class="rl-cls-cell"><span class="rl-cls-pick"><select data-sec="cls" data-i="${i}" title="${escHtml(s.cls ? `${this._clsName(des, s.cls)}: ${this._clsReq(des, s.cls, s)}` : 'Not checked')}">${clsOpts(s.cls)}</select>${this._std(des) === 'SANS' && s.type !== 'median' ? `<button class="btn-small rl-suggest" data-rl-suggest="${i}" title="Suggest the SANS category from the road class, speed and traffic">Suggest</button>` : ''}</span>
              ${cw && this._std(des) === 'SANS' && RL_SANS_A[s.cls] ? `<select data-sec="volume" data-i="${i}" class="rl-vol" title="Maximum traffic volume during darkness (SANS 10098-1 Table 1)">${RL_SANS_BANDS[this._hasMedian(des) ? 'median' : 'noMedian'].map((b, k) => `<option value="${k}"${this._num(s.volume, 0) === k ? ' selected' : ''}>Night traffic ${b}</option>`).join('')}</select>` : ''}</td>
            <td data-label="Road surface"${cw ? '' : ' class="rl-na"'}>${cw ? `<select data-sec="surface" data-i="${i}" title="${escHtml(`${s.surface}: ${(RL_SURFACE_INFO[s.surface] || {}).desc || ''}`)}">${RL_SURFACES.map(x => `<option value="${x}"${x === s.surface ? ' selected' : ''} title="${escHtml(RL_SURFACE_INFO[x].desc)}">${x} — ${escHtml(RL_SURFACE_INFO[x].short)}</option>`).join('')}</select>` : '<span class="sl-k">—</span>'}</td>
            <td data-label="Traffic"${cw ? '' : ' class="rl-na"'}>${cw ? `<select data-sec="direction" data-i="${i}"><option value="forward"${s.direction !== 'reverse' ? ' selected' : ''}>→ away</option><option value="reverse"${s.direction === 'reverse' ? ' selected' : ''}>← towards</option></select>` : '<span class="sl-k">—</span>'}</td>
            <td class="rl-row-actions"><button class="rl-icon" data-rl-secmv="-1" data-i="${i}" title="Move left" aria-label="Move left">←</button><button class="rl-icon" data-rl-secmv="1" data-i="${i}" title="Move right" aria-label="Move right">→</button><button class="rl-icon" data-rl-secdel="${i}" title="Remove" aria-label="Remove strip">×</button></td>
          </tr>`;
        }).join('')}</tbody></table>
        ${this._secNotes(des)}
      </div>
      <div class="rl-card">
        <div class="rl-card-head"><b>Luminaires</b>
          <label class="rl-inline">Arrangement<select data-dz="arrangement">${opt(RL_ARRANGEMENTS, des.arrangement)}</select></label>
          <label class="rl-inline" title="Distance between consecutive luminaires in the same row">Spacing<span class="sl-unit"><input type="number" step="0.5" min="1" data-dz="spacing" value="${escHtml(des.spacing)}" class="sl-in-num"> m</span></label>
          <label class="rl-inline" title="Maintenance factor — LLMF × LSF × LMF (typically 0.8–0.9 for LED)">MF<input type="number" step="0.01" min="0.05" max="1" data-dz="mf" value="${escHtml(des.mf)}" class="sl-in-num"></label>
          <label class="rl-inline" title="Burning hours per year, for the AECI energy indicator">Hours/yr<input type="number" step="100" min="0" data-dz="hours" value="${escHtml(des.hours)}" class="sl-in-num"></label>
          ${des.arrangement === 'custom' ? '<button class="btn-small" data-rl="addrow">+ Row</button>' : ''}</div>
        <table class="sl-table rl-table"><thead><tr><th>Side</th><th>Luminaire</th><th title="Pole behind the kerb (negative = on the carriageway). Median rows: offset from the median centre">Setback m</th><th title="Mounting height of the luminaire above the road">Height m</th><th title="Arm reach from the pole towards the road">Overhang m</th><th title="Upward tilt towards the road">Tilt °</th><th title="Fraction of the spacing this row is shifted along the road (0.5 = staggered)">Offset ×S</th><th title="Dimming level — flux and power scale together">Flux %</th><th title="Extra rotation about the vertical">Rotate °</th><th></th></tr></thead>
        <tbody id="rl-row-body">${des.rows.map((r, i) => `<tr>
          <td data-label="Side"><select data-row="side" data-i="${i}">${opt(RL_SIDES, r.side)}</select></td>
          <td data-label="Luminaire" class="rl-wide"><select data-row="photometryId" data-i="${i}" class="rl-lum-sel">${libOpts(r.photometryId)}</select></td>
          ${['setback', 'height', 'overhang', 'tilt', 'xOffset', 'fluxPct', 'rotate'].map(k => `<td data-label="${{ setback: 'Setback m', height: 'Height m', overhang: 'Overhang m', tilt: 'Tilt °', xOffset: 'Offset ×S', fluxPct: 'Flux %', rotate: 'Rotate °' }[k]}"><input type="number" step="${k === 'xOffset' ? 0.05 : k === 'fluxPct' ? 5 : k === 'tilt' || k === 'rotate' ? 1 : 0.1}" data-row="${k}" data-i="${i}" value="${escHtml(r[k] ?? '')}" class="sl-in-num"></td>`).join('')}
          <td class="rl-row-actions">${des.arrangement === 'custom' && des.rows.length > 1 ? `<button class="rl-icon" data-rl-rowdel="${i}" title="Remove row" aria-label="Remove row">×</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>
        <div class="sl-hint rl-hint">Changing a row's height, overhang, tilt or luminaire in a preset arrangement applies to every row — pick <i>Custom rows</i> to set rows individually.</div>
      </div>
      <div class="rl-card">
        <div class="rl-card-head"><b>Solve</b></div>
        <div class="rl-solve">
          <div class="rl-solve-block">
            <div class="rl-solve-t">Max spacing</div>
            <div class="rl-inline-row">
              <label class="rl-inline">From<input type="number" step="1" data-sw="min" value="${escHtml(des.sweep.min)}" class="sl-in-num"></label>
              <label class="rl-inline">to<input type="number" step="1" data-sw="max" value="${escHtml(des.sweep.max)}" class="sl-in-num"></label>
              <label class="rl-inline">step<input type="number" step="0.5" data-sw="step" value="${escHtml(des.sweep.step)}" class="sl-in-num"> m</label>
              <button class="btn-small btn-primary" data-rl="sweep">Find max spacing</button>
            </div>
          </div>
          <div class="rl-solve-block">
            <div class="rl-solve-t">Optimise</div>
            <div class="rl-inline-row"><span class="sl-hint">Height × tilt × overhang × luminaire × dimming, each at its largest passing spacing, ranked by W/km, poles/km or PDI.</span>
              <button class="btn-small btn-primary" data-rl="optimise">Optimise…</button></div>
          </div>
          <div class="rl-solve-block">
            <div class="rl-solve-t">Use it</div>
            <div class="rl-inline-row">
              ${circuits.length ? `<button class="btn-small" data-rl="apply" title="Write this spacing (and a matching luminaire wattage) into a street lighting circuit">Apply spacing to circuit…</button>` : '<span class="sl-hint">Circuits on the Circuits view can take this spacing.</span>'}
              <button class="btn-small" data-rl="pdf">PDF report</button>
            </div>
          </div>
        </div>
      </div>`;
    this._paintSection();
    if (typeof GridTable !== 'undefined') {
      GridTable.attach(document.getElementById('rl-sec-body'), { cells: '[data-sec]' });
      GridTable.attach(document.getElementById('rl-row-body'), { cells: '[data-row]' });
    }
  },

  // ─── Cross-section drawing ───────────────────────────────────────────
  SEC_FILL: { carriageway: 'var(--rl-road)', footpath: 'var(--rl-path)', cycle: 'var(--rl-cycle)', verge: 'var(--rl-verge)', median: 'var(--rl-verge)' },

  _sectionSvg(des, opts = {}) {
    const lay = this._layout(des);
    const rows = this._rowsPayload(des, lay);
    const res = this._results[des.id];
    const hMax = Math.max(4, ...rows.map(r => r.height));
    const yMin = Math.min(0, ...rows.map(r => r.y)) - 1, yMax = Math.max(lay.width, ...rows.map(r => r.y)) + 1;
    const W = opts.width || 760, Hpx = opts.height || 220;
    const padL = 44, padR = 16, padT = 16, padB = 46;
    const sx = (W - padL - padR) / (yMax - yMin);
    const sz = Math.min(sx, (Hpx - padT - padB) / (hMax + 1));
    const X = (y) => padL + (y - yMin) * sx;
    const ground = Hpx - padB;
    const Z = (z) => ground - z * sz;
    const out = [];
    const areaRes = (i) => res && res.areas ? res.areas.find(a => a.index === i) : null;
    lay.secs.forEach((s, i) => {
      if (!(s.width > 0)) return;
      const a = areaRes(i);
      out.push(`<rect x="${X(s.y0)}" y="${ground}" width="${Math.max(0, X(s.y1) - X(s.y0))}" height="10" fill="${this.SEC_FILL[s.type] || 'var(--rl-verge)'}" stroke="var(--bg-primary)" stroke-width="1"/>`);
      if (s.type === 'carriageway' && s.lanes > 1) {
        for (let k = 1; k < s.lanes; k++) {
          const yy = X(s.y0 + k * s.width / s.lanes);
          out.push(`<line x1="${yy}" y1="${ground + 1}" x2="${yy}" y2="${ground + 9}" stroke="var(--rl-mark)" stroke-width="1.5" stroke-dasharray="3 3"/>`);
        }
      }
      const cx = (X(s.y0) + X(s.y1)) / 2;
      const name = s.name || this._secName(s, des);
      out.push(`<text x="${cx}" y="${ground + 23}" text-anchor="middle" class="rl-xs-t">${escHtml(name)}</text>`);
      const status = a && a.pass !== null && a.pass !== undefined ? (a.pass ? ' ✓' : ' ✗') : '';
      out.push(`<text x="${cx}" y="${ground + 36}" text-anchor="middle" class="rl-xs-s${a && a.pass === false ? ' bad' : ''}">${this._fmt(s.width, 1)} m${s.cls ? ' · ' + s.cls : ''}${status}</text>`);
    });
    const polesDrawn = new Set();
    rows.forEach((r, i) => {
      const dir = r.facing === 'right' ? 1 : -1;
      const ly = r.y + r.overhang * dir;
      const key = `${r.pole}:${r.y.toFixed(2)}`;
      if (!polesDrawn.has(key)) {
        polesDrawn.add(key);
        out.push(`<line x1="${X(r.y)}" y1="${ground}" x2="${X(r.y)}" y2="${Z(r.height + 0.3)}" stroke="var(--text-secondary)" stroke-width="2.5" stroke-linecap="round"/>`);
      }
      out.push(`<path d="M${X(r.y)} ${Z(r.height + 0.3)} Q${X(r.y)} ${Z(r.height + 0.6)} ${X(ly)} ${Z(r.height)}" fill="none" stroke="var(--text-secondary)" stroke-width="2"/>`);
      const tilt = r.tilt * Math.PI / 180;
      const lx = X(ly), lz = Z(r.height);
      const hw = 9;
      out.push(`<line x1="${lx - hw * Math.cos(tilt) * dir}" y1="${lz + hw * Math.sin(tilt)}" x2="${lx + hw * Math.cos(tilt) * dir}" y2="${lz - hw * Math.sin(tilt)}" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>`);
      out.push(`<text x="${lx + 10 * dir}" y="${lz - 8}" text-anchor="${dir > 0 ? 'start' : 'end'}" class="rl-xs-s">${this._fmt(r.height, 1)} m${r.tilt ? ` · ${r.tilt}°` : ''}${r.xOffset ? ` · +${r.xOffset}S` : ''}</text>`);
    });
    out.push(`<line x1="${padL - 8}" y1="${ground}" x2="${padL - 8}" y2="${Z(hMax)}" stroke="var(--border-color)"/>`);
    out.push(`<text x="${padL - 11}" y="${Z(hMax) + 4}" text-anchor="end" class="rl-xs-s">${Math.round(hMax)} m</text>`);
    out.push(`<text x="${padL - 11}" y="${ground + 4}" text-anchor="end" class="rl-xs-s">0</text>`);
    return { svg: out.join(''), W, H: Hpx };
  },

  _paintSection() {
    const svg = document.getElementById('rl-xs');
    const des = this.selected;
    if (!svg || !des) return;
    const w = Math.max(480, Math.min(1100, svg.parentElement.clientWidth || 760));
    const { svg: body, W, H } = this._sectionSvg(des, { width: w });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.innerHTML = body;
  },

  // ─── Results ─────────────────────────────────────────────────────────
  renderResults() {
    const el = document.getElementById('rl-results');
    if (!el) return;
    const des = this.selected;
    if (!des) { el.innerHTML = ''; return; }
    const pr = this._problems(des);
    if (pr.length) { el.innerHTML = `<div class="sl-empty">${pr.map(escHtml).join('<br>')}</div>`; return; }
    const r = this._results[des.id];
    if (!r) { el.innerHTML = '<div class="sl-empty">Calculating…</div>'; return; }
    if (r.error) { el.innerHTML = `<div class="sl-empty rl-err">${escHtml(r.error)}</div>`; return; }
    el.innerHTML = `
      <div class="rl-verdict ${r.pass ? 'ok' : 'bad'}">${r.pass ? '✓ Meets every class' : '✗ Does not meet every class'}<span>S = ${this._fmt(r.spacing, 1)} m · MF ${this._fmt(des.mf, 2)}</span></div>
      ${r.areas.map(a => this._areaHtml(a)).join('')}
      ${this._energyHtml(r.energy)}
      <div class="rl-block"><div class="rl-block-h">Illuminance over one field <span class="sl-hint">plan view, lux</span></div>
        <div id="rl-isolux" class="rl-isolux"></div></div>
      ${this._sweepHtml(des)}
      ${this._optHtml(des)}
      <details class="rl-block rl-grid-details"><summary>Grid values (EN 13201-3 points)</summary>${this._gridTables(r)}</details>`;
    this._paintIsolux(r);
  },

  _areaHtml(a) {
    const title = `${escHtml(a.name)}${a.cls ? ` <span class="rl-cls">${a.cls}</span>` : ''}${a.surface ? ` <span class="sl-hint">${a.surface}</span>` : ''}`;
    const badge = a.pass === null || a.pass === undefined ? '<span class="sl-badge">info</span>' : a.pass ? '<span class="sl-badge ok">✓ Pass</span>' : '<span class="sl-badge bad">✗ Fail</span>';
    let body;
    if (a.checks && a.checks.length) {
      body = `<table class="rl-chk"><thead><tr><th></th><th>Required</th><th>Calculated</th><th></th></tr></thead><tbody>${a.checks.map(c => `
        <tr class="${c.pass ? '' : 'bad'}"><td>${escHtml(c.label)}${c.unit ? ` <span class="sl-hint">${escHtml(c.unit)}</span>` : ''}</td>
        <td>${c.op === '>=' ? '≥' : '≤'} ${c.req}</td><td class="sl-mono">${this._fmt(c.value, c.key === 'Eav' || c.key === 'Emin' ? 2 : c.key === 'TI' ? 1 : 2)}</td>
        <td>${c.pass ? '<span class="rl-ok">✓</span>' : '<span class="rl-bad">✗</span>'}</td></tr>`).join('')}</tbody></table>`;
    } else {
      body = `<div class="rl-kv"><span>Ē</span><b class="sl-mono">${this._fmt(a.Eav, 2)} lx</b><span>Emin</span><b class="sl-mono">${this._fmt(a.Emin, 2)} lx</b><span>Uo</span><b class="sl-mono">${this._fmt(a.UoE, 2)}</b></div>`;
    }
    let extra = '';
    if (a.family === 'M') {
      extra = `<div class="sl-hint">Ē ${this._fmt(a.Eav, 1)} lx on the carriageway${a.REIsides && a.REIsides.length ? ` · REI ${a.REIsides.map(s => `${s.side} ${this._fmt(s.REI, 2)}`).join(', ')}` : ''}${a.observers && a.observers.length > 1 ? ` · worst of ${a.observers.length} observer lanes` : ''}</div>`;
    } else if (a.family === 'A') {
      // SANS 10098-1 group A: the conventional observer, the Table 1 column used, and ES (reported only).
      extra = `<div class="sl-hint">Night traffic ${escHtml(a.volumeBand || '')} per lane, ${escHtml(a.crossSection || '')} · L̄, Uo, TI from the observer at y = ${this._fmt(a.observer && a.observer.y, 2)} m (a quarter of the width from the left) · Ul per lane ${(a.observers || []).map(o => this._fmt(o.Ul, 2)).join(', ')} · Ē ${this._fmt(a.Eav, 1)} lx${a.ESsides && a.ESsides.length ? ` · surround ratio ES ${a.ESsides.map(s => `${s.side} ${this._fmt(s.REI, 2)}`).join(', ')} (no limit tabulated)` : ''}</div>`;
    }
    return `<div class="rl-block"><div class="rl-block-h">${title}${badge}</div>${body}${extra}${a.note ? `<div class="sl-hint rl-note">${escHtml(a.note)}</div>` : ''}</div>`;
  },

  _energyHtml(e) {
    if (!e) return '';
    return `<div class="rl-block"><div class="rl-block-h">Energy &amp; quantities</div>
      <div class="rl-kv">
        <span title="Luminaire system power per km of road">Power</span><b class="sl-mono">${Math.round(e.wPerKm).toLocaleString()} W/km</b>
        <span>Poles</span><b class="sl-mono">${this._fmt(e.polesPerKm, 1)} /km</b>
        <span>Luminaires</span><b class="sl-mono">${this._fmt(e.luminairesPerKm, 1)} /km</b>
        <span title="Power density indicator D_P, EN 13201-5">PDI D<sub>P</sub></span><b class="sl-mono">${e.pdi === null ? '—' : this._fmt(e.pdi * 1000, 1) + ' mW/(lx·m²)'}</b>
        <span title="Annual energy consumption indicator D_E, EN 13201-5">AECI D<sub>E</sub></span><b class="sl-mono">${e.aeci === null ? '—' : this._fmt(e.aeci, 2) + ' kWh/(m²·yr)'}</b>
      </div></div>`;
  },

  _sweepHtml(des) {
    if (this._busy === 'sweep') return '<div class="rl-block"><div class="rl-block-h">Max spacing</div><div class="sl-empty">Sweeping spacings…</div></div>';
    const s = this._sweeps[des.id];
    if (!s) return '';
    if (s.error) return `<div class="rl-block"><div class="rl-block-h">Max spacing</div><div class="rl-err">${escHtml(s.error)}</div></div>`;
    const lo = s.sweep[0], hi = s.sweep[s.sweep.length - 1];
    const cells = s.sweep.map(p => `<span class="rl-sw ${p.pass ? 'ok' : 'bad'}${p.spacing === s.best ? ' best' : ''}" title="${p.spacing} m — ${p.pass ? 'passes' : 'fails: ' + escHtml((p.worst || []).join(', '))}"></span>`).join('');
    return `<div class="rl-block"><div class="rl-block-h">Max spacing</div>
      ${s.best !== null && s.best !== undefined
        ? `<div class="rl-best">Largest passing spacing <b class="sl-mono">${s.best} m</b>${s.result ? ` · ${Math.round(s.result.energy.wPerKm).toLocaleString()} W/km · ${this._fmt(s.result.energy.polesPerKm, 1)} poles/km` : ''}
           <button class="btn-small btn-primary" data-rl-use="${s.best}">Use ${s.best} m</button></div>
           ${hi && s.best === hi.spacing ? '<div class="sl-hint">It still passes at the top of the range — raise <i>to</i> to find the real limit.</div>' : ''}`
        : '<div class="rl-best bad">No spacing in the range passes — raise the flux, mounting height or tilt, or change the luminaire.</div>'}
      <div class="rl-sw-strip" role="img" aria-label="Pass or fail at each spacing">${cells}</div>
      <div class="rl-sw-axis"><span>${lo ? lo.spacing : ''} m</span><span><i class="rl-sw ok"></i> passes <i class="rl-sw bad"></i> fails</span><span>${hi ? hi.spacing : ''} m</span></div></div>`;
  },

  _optHtml(des) {
    const o = this._opt[des.id];
    if (!o || o.error || !o.options || !o.options.length) return '';
    const top = o.options.slice(0, 5);
    return `<div class="rl-block"><div class="rl-block-h">Best options <span class="sl-hint">${o.nPassing} of ${o.nEvaluated} pass</span></div>
      <table class="rl-chk"><thead><tr><th>Luminaire</th><th>H</th><th>Tilt</th><th>S</th><th>W/km</th><th></th></tr></thead><tbody>${top.map((p, i) => `
      <tr><td class="rl-ph-cell">${escHtml((this.library[p.photometryId] || {}).name || '?')}${p.fluxPct !== 100 ? ` · ${p.fluxPct}%` : ''}</td><td>${p.height}</td><td>${p.tilt}°</td><td>${p.spacing}</td><td class="sl-mono">${Math.round(p.energy.wPerKm).toLocaleString()}</td>
      <td><button class="btn-small" data-rl-optuse="${i}">Use</button></td></tr>`).join('')}</tbody></table></div>`;
  },

  _gridTables(r) {
    return r.areas.map(a => {
      const g = a.gridL || a.gridE;
      if (!g) return '';
      const unit = a.gridL ? 'cd/m²' : 'lx';
      const dp = a.gridL ? 3 : 1;
      return `<div class="rl-grid-t"><div class="rl-block-h">${escHtml(a.name)} — ${a.gridL ? `luminance, observer in lane ${g.observerLane}` : 'illuminance'} (${unit})</div>
        <div class="rl-grid-scroll"><table class="rl-grid"><thead><tr><th>y \\ x</th>${g.x.map(x => `<th>${x.toFixed(1)}</th>`).join('')}</tr></thead><tbody>
        ${g.y.map((y, j) => `<tr><th>${y.toFixed(2)}</th>${g.x.map((_, i) => `<td>${(+g.v[i][j]).toFixed(dp)}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div></div>`;
    }).join('');
  },

  // ─── Isolux (plan view heatmap + iso-lines) ──────────────────────────
  _ramp(forceLight = false) {
    const dark = !forceLight && document.body.classList.contains('dark-mode');
    // One-hue sequential blue, low = near the surface (light on light, dark on dark).
    const light = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab'];
    const darkRamp = ['#104281', '#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];
    return dark ? darkRamp : light;
  },
  _levels(max) {
    const nice = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200];
    const out = nice.filter(v => v < max);
    while (out.length > 6) out.splice(out.length % 2 ? 0 : 1, 1);
    return out;
  },

  _isoluxSvg(r, W = 340, print = false) {
    const g = r.isolux;
    if (!g) return '';
    const nx = g.x.length, ny = g.y.length;
    const S = g.x[nx - 1], Y = g.y[ny - 1] - g.y[0];
    const pad = { l: 34, r: 8, t: 8, b: 24 };
    const pw = W - pad.l - pad.r;
    const ph = Math.max(80, Math.min(260, pw * Y / S));
    const H = ph + pad.t + pad.b;
    const X = (x) => pad.l + x / S * pw;
    const Yp = (y) => pad.t + (y - g.y[0]) / Y * ph;       // y down the page = across the road
    let max = 0;
    for (const col of g.v) for (const v of col) if (v > max) max = v;
    const levels = this._levels(max);
    const ramp = this._ramp(print);
    const bandOf = (v) => { let b = 0; for (let k = 0; k < levels.length; k++) if (v >= levels[k]) b = k + 1; return b; };
    const colour = (b) => ramp[Math.min(ramp.length - 1, Math.round(b * (ramp.length - 1) / Math.max(1, levels.length)))];
    const cells = [];
    const dx = S / (nx - 1), dy = Y / (ny - 1);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const v = g.v[i][j];
        const x0 = X(Math.max(0, g.x[i] - dx / 2)), x1 = X(Math.min(S, g.x[i] + dx / 2));
        const y0 = Yp(Math.max(g.y[0], g.y[j] - dy / 2)), y1 = Yp(Math.min(g.y[ny - 1], g.y[j] + dy / 2));
        cells.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0 + 0.3).toFixed(1)}" height="${(y1 - y0 + 0.3).toFixed(1)}" fill="${colour(bandOf(v))}" data-v="${v}" data-x="${g.x[i]}" data-y="${g.y[j]}"/>`);
      }
    }
    const lines = levels.map(lv => this._contour(g, lv, X, Yp)).join('');
    const des = this.selected;
    const lay = des ? this._layout(des) : null;
    const edges = lay ? lay.secs.slice(1).map(s => `<line x1="${pad.l}" x2="${pad.l + pw}" y1="${Yp(s.y0)}" y2="${Yp(s.y0)}" stroke="var(--bg-primary)" stroke-width="1" stroke-dasharray="4 3" opacity=".8"/>`).join('') : '';
    const lums = (r.luminaires || []).map(l => `<circle cx="${X(l.x)}" cy="${Yp(Math.min(g.y[ny - 1], Math.max(g.y[0], l.y)))}" r="4" fill="var(--accent)" stroke="var(--bg-primary)" stroke-width="2"/>`).join('');
    const legend = [0, ...levels].map((lv, k) => `<span class="rl-leg"><i style="background:${colour(k)}"></i>${k === 0 ? '< ' + (levels[0] ?? '') : '≥ ' + lv}</span>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="rl-iso-svg" role="img" aria-label="Isolux plot">
        <g class="rl-iso-cells" shape-rendering="crispEdges">${cells.join('')}</g>${edges}${lines}${lums}
        <text x="${pad.l}" y="${H - 6}" class="rl-xs-s">0</text><text x="${pad.l + pw}" y="${H - 6}" text-anchor="end" class="rl-xs-s">${S} m along the road</text>
        <text x="${pad.l - 4}" y="${pad.t + 9}" text-anchor="end" class="rl-xs-s">${g.y[0]}</text><text x="${pad.l - 4}" y="${pad.t + ph}" text-anchor="end" class="rl-xs-s">${this._fmt(g.y[ny - 1], 1)}</text>
      </svg><div class="rl-legend">${legend} <span class="sl-hint">lx · max ${this._fmt(max, 1)}</span></div>`;
  },

  // Marching squares — one iso-line as SVG segments.
  _contour(g, lv, X, Y) {
    const segs = [];
    const nx = g.x.length, ny = g.y.length;
    const lerp = (a, b, va, vb) => a + (b - a) * ((lv - va) / ((vb - va) || 1e-12));
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < ny - 1; j++) {
        const v = [g.v[i][j], g.v[i + 1][j], g.v[i + 1][j + 1], g.v[i][j + 1]];
        const x0 = g.x[i], x1 = g.x[i + 1], y0 = g.y[j], y1 = g.y[j + 1];
        const pts = [];
        if ((v[0] < lv) !== (v[1] < lv)) pts.push([lerp(x0, x1, v[0], v[1]), y0]);
        if ((v[1] < lv) !== (v[2] < lv)) pts.push([x1, lerp(y0, y1, v[1], v[2])]);
        if ((v[3] < lv) !== (v[2] < lv)) pts.push([lerp(x0, x1, v[3], v[2]), y1]);
        if ((v[0] < lv) !== (v[3] < lv)) pts.push([x0, lerp(y0, y1, v[0], v[3])]);
        for (let k = 0; k + 1 < pts.length; k += 2) {
          segs.push(`M${X(pts[k][0]).toFixed(1)} ${Y(pts[k][1]).toFixed(1)}L${X(pts[k + 1][0]).toFixed(1)} ${Y(pts[k + 1][1]).toFixed(1)}`);
        }
      }
    }
    return segs.length ? `<path d="${segs.join('')}" fill="none" stroke="var(--text-primary)" stroke-width="1" opacity=".55"/>` : '';
  },

  _paintIsolux(r) {
    const el = document.getElementById('rl-isolux');
    if (!el) return;
    el.innerHTML = this._isoluxSvg(r, Math.max(280, el.clientWidth || 340));
    const svg = el.querySelector('svg');
    if (!svg) return;
    let tip = el.querySelector('.rl-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'rl-tip'; el.appendChild(tip); }
    // Hover on a mouse, tap on a touch screen.
    const show = (e) => {
      const c = e.target.closest('rect[data-v]');
      if (!c) { tip.style.display = 'none'; return; }
      tip.textContent = `${(+c.dataset.v).toFixed(1)} lx  ·  x ${(+c.dataset.x).toFixed(1)} m, y ${(+c.dataset.y).toFixed(1)} m`;
      const b = el.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = Math.max(0, Math.min(b.width - 170, e.clientX - b.left + 10)) + 'px';
      tip.style.top = (e.clientY - b.top + 12) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  },

  // ─── Events ──────────────────────────────────────────────────────────
  _onClick(e) {
    const t = e.target.closest('[data-rl], [data-rl-sel], [data-rl-ph], [data-rl-secdel], [data-rl-secmv], [data-rl-rowdel], [data-rl-use], [data-rl-optuse], [data-rl-suggest]');
    if (!t) return;
    const des = this.selected;
    if (t.dataset.rlSel) { this._selId = t.dataset.rlSel; this.render(); if (!this._results[this._selId]) this.recompute(0); return; }
    if (t.dataset.rlPh) { this.openPhotometry(t.dataset.rlPh); return; }
    if (t.dataset.rlSuggest !== undefined) { this.openSuggest(+t.dataset.rlSuggest); return; }
    if (t.dataset.rlUse) { this.useSpacing(+t.dataset.rlUse); return; }
    if (t.dataset.rlOptuse !== undefined && des) { this._useOption(des, this._opt[des.id].options[+t.dataset.rlOptuse]); return; }
    if (t.dataset.rlSecdel !== undefined && des) { des.sections.splice(+t.dataset.rlSecdel, 1); this._afterMutate(); return; }
    if (t.dataset.rlSecmv !== undefined && des) {
      const i = +t.dataset.i, j = i + (+t.dataset.rlSecmv);
      if (j < 0 || j >= des.sections.length) return;
      [des.sections[i], des.sections[j]] = [des.sections[j], des.sections[i]];
      this._afterMutate(); return;
    }
    if (t.dataset.rlRowdel !== undefined && des) { des.rows.splice(+t.dataset.rlRowdel, 1); this._afterMutate(); return; }
    switch (t.dataset.rl) {
      case 'new': this.newDesign(); break;
      case 'dup': if (des) this.duplicateDesign(des.id); break;
      case 'del': if (des) this.deleteDesign(des.id); break;
      case 'import': document.getElementById('rl-file').click(); break;
      case 'generic': this._genericDialog(); break;
      case 'addsec': if (des) { des.sections.push({ id: this._genSecId(des), type: 'footpath', name: '', width: 2, lanes: 2, cls: 'P4', surface: 'R3', direction: 'forward' }); this._afterMutate(); } break;
      case 'addrow': if (des) { des.rows.push(this._row(des, 'right', Object.assign({}, des.rows[0] || {}))); this._afterMutate(); } break;
      case 'sweep': this.runMaxSpacing(); break;
      case 'optimise': this.openOptimise(); break;
      case 'apply': this.applyToCircuit(); break;
      case 'pdf': if (typeof RoadLightReport !== 'undefined') RoadLightReport.export(); break;
      case 'info': this.openInfo(); break;
    }
  },

  _onChange(e) {
    const t = e.target;
    const des = this.selected;
    if (!des) return;
    const d = t.dataset;
    if (d.dz) {
      const k = d.dz;
      if (k === 'name') { des.name = t.value || des.name; this._markDirty(); this.renderRail(); return; }
      if (k === 'template') { if (t.value) { this._applyTemplate(des, t.value); if (des.arrangement === 'twin-central' && !des.sections.some(s => s.type === 'median')) this._applyArrangement(des, 'single-left'); } this._afterMutate(); return; }
      if (k === 'arrangement') { this._applyArrangement(des, t.value); this._afterMutate(); return; }
      if (k === 'standard') { this._setStandard(des, t.value); this._afterMutate(); return; }
      des[k] = this._num(t.value, des[k]);
      this._afterMutate(false);
      this._paintSection();
      return;
    }
    if (d.sw) { des.sweep[d.sw] = this._num(t.value, des.sweep[d.sw]); this._markDirty(); return; }
    if (d.sec) {
      const s = des.sections[+d.i];
      if (!s) return;
      if (d.sec === 'type' || d.sec === 'name' || d.sec === 'cls' || d.sec === 'surface' || d.sec === 'direction') s[d.sec] = t.value;
      else if (d.sec === 'volume') s.volume = Math.round(this._num(t.value, 0));
      else s[d.sec] = Math.max(d.sec === 'lanes' ? 1 : 0, this._num(t.value, s[d.sec]));
      if (d.sec === 'lanes') s.lanes = Math.round(s.lanes);
      const structural = d.sec === 'type' || d.sec === 'cls' || d.sec === 'volume';
      this._afterMutate(structural);
      if (!structural) this._paintSection();
      return;
    }
    if (d.row) {
      const r = des.rows[+d.i];
      if (!r) return;
      const v = d.row === 'side' || d.row === 'photometryId' ? t.value : this._num(t.value, r[d.row]);
      // Preset arrangements keep every row alike: shared fields go to all rows.
      const shared = ['height', 'overhang', 'tilt', 'photometryId', 'fluxPct', 'rotate'];
      if (des.arrangement !== 'custom' && shared.includes(d.row)) des.rows.forEach(x => { x[d.row] = v; });
      else r[d.row] = v;
      if (d.row === 'side' && des.arrangement !== 'custom') des.arrangement = 'custom';
      this._afterMutate(des.arrangement !== 'custom' && shared.includes(d.row) || d.row === 'side');
      this._paintSection();
    }
  },

  // One line per classed strip under the table: its class's requirements and,
  // for a carriageway, what its road surface is — readable on a phone, where
  // hover tooltips never show.
  _secNotes(des) {
    const sans = this._std(des) === 'SANS';
    const lines = des.sections.filter(s => s.cls || s.type === 'carriageway').map(s => {
      const lum = this._isLumClass(des, s.cls);
      const cls = s.cls ? `<b>${escHtml(s.cls)}</b>${sans ? ' ' + escHtml(RL_SANS_NAMES[s.cls] || '') + ' —' : ''} ${escHtml(this._clsReq(des, s.cls, s))}` : '<span class="sl-k">no class — not checked</span>';
      const warn = lum && s.type !== 'carriageway' ? ` <span class="rl-bad">${sans ? 'Group A categories' : 'M classes'} apply to a carriageway</span>` : '';
      const area = sans && /^B[1-3]$/.test(s.cls || '') && s.type === 'carriageway' ? ' <span class="sl-k">(over the carriageway and footways up to 2 m from its edge)</span>' : '';
      const surf = s.type === 'carriageway' && RL_SURFACE_INFO[s.surface]
        ? ` · <b>${escHtml(s.surface)}</b> ${escHtml(RL_SURFACE_INFO[s.surface].short.toLowerCase())}${lum ? '' : ` <span class="sl-k">(used for ${sans ? 'group A' : 'M classes'} only)</span>`}` : '';
      return `<li><span class="rl-note-strip">${escHtml(s.name || this._secName(s, des))}</span> ${cls}${area}${warn}${surf}</li>`;
    });
    return lines.length ? `<ul class="rl-sec-notes">${lines.join('')}</ul>` : '';
  },

  openInfo() {
    const des = this.selected;
    const sans = this._std(des) === 'SANS';
    const tbl = (list, reqOf) => `<table class="rl-chk"><tbody>${list.map(c => `<tr><td><b>${c}</b></td><td>${sans ? `${escHtml(RL_SANS_NAMES[c])}<br><span class="sl-k">${escHtml(reqOf(c))}</span>` : escHtml(reqOf(c))}</td></tr>`).join('')}</tbody></table>`;
    let classes;
    if (sans) {
      const set = des && this._hasMedian(des) ? 'median' : 'noMedian';
      const aTable = `<table class="rl-chk"><thead><tr><th></th>${RL_SANS_BANDS[set].map(b => `<th>${escHtml(b)}</th>`).join('')}</tr></thead><tbody>
        ${Object.keys(RL_SANS_A).map(c => `<tr><td><b>${c}</b></td>${RL_SANS_A[c][set].map(([ln, uo, ul, ti]) => `<td class="sl-mono">L̄ ${ln} · Uo ${uo} · Ul ${ul} · TI ${ti}</td>`).join('')}</tr>`).join('')}</tbody></table>
        <p class="sl-hint">${Object.keys(RL_SANS_A).map(c => `<b>${c}</b> ${escHtml(RL_SANS_NAMES[c])}`).join(' · ')}. Shown ${set === 'median' ? 'with' : 'without'} a median, as this cross-section is. Traffic is the maximum volume during darkness; a volume between two columns takes the heavier one.</p>`;
      classes = `
        <p class="rl-lead">Each strip of the cross-section gets its own <b>category</b> in the <i>Class</i> column, from SANS 10098-1:2007 (tables 1 and 2) and, for junctions and cycle / pedestrian ways, SANS 10098-2:2005. <i>Suggest…</i> picks one from the road's functional class, speed and traffic. Requirements are maintained values: the MF is applied.</p>
        <div class="rl-info-fam"><div class="rl-solve-t">Group A</div><p class="rl-lead">${escHtml(RL_SANS_FAMILY.A)}</p>${aTable}</div>
        <div class="rl-info-fam"><div class="rl-solve-t">Groups B and C</div><p class="rl-lead">${escHtml(RL_SANS_FAMILY.B)} ${escHtml(RL_SANS_FAMILY.C)}</p>${tbl(['B1', 'B2', 'B3', 'C1', 'C2'], c => RL_SANS_CLASS_REQ[c])}</div>
        <div class="rl-info-fam"><div class="rl-solve-t">SANS 10098-2 — roadway complexes</div><p class="rl-lead">${escHtml(RL_SANS_FAMILY.RC)} Table 1 prints 0,4 under E<sub>min</sub>; it is read here as the uniformity ratio E<sub>min</sub>/Ē, as clause 9 uses for traffic circles.</p>${tbl(['RC0', 'RC1', 'RC2', 'RC3', 'RC4', 'RC5'], c => RL_SANS_CLASS_REQ[c])}</div>
        <div class="rl-info-fam"><div class="rl-solve-t">SANS 10098-2 — cycle and pedestrian ways</div><p class="rl-lead">${escHtml(RL_SANS_FAMILY.CP)}</p>${tbl(['CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6'], c => RL_SANS_CLASS_REQ[c])}</div>`;
    } else {
      const fam = (f, list) => `<div class="rl-info-fam"><div class="rl-solve-t">${f} classes</div><p class="rl-lead">${escHtml(RL_CLASS_FAMILY[f])}</p>${tbl(list, c => RL_CLASS_REQ[c])}</div>`;
      classes = `
        <p class="rl-lead">Each strip of the cross-section gets its own <b>lighting class</b> in the <i>Class</i> column, from EN 13201-2:2015 (as CIE 115). For a South African design, switch the design's <i>Standard</i> to SANS 10098-1: its categories and observer rule differ.</p>
        ${fam('M', ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])}${fam('C', ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'])}${fam('P', ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'])}`;
    }
    this._modal('rl-info-modal', 'Lighting classes &amp; road surfaces', `
      ${classes}
      <div class="rl-info-fam"><div class="rl-solve-t">Road surfaces</div>
      <p class="rl-lead">For luminance designs the result depends on how the surface reflects light towards the driver. Each CIE class is a table of reduced luminance coefficients. <b>Q0</b> is how bright the surface is on average. <b>S1</b> is how mirror-like it is: a high S1 makes the bright patches under the far luminaires stand out and lowers uniformity. SANS 10098-1 (4.1) takes R3 as representative of the dense-mix bituminous surfaces generally used in South Africa.</p>
      <table class="rl-chk"><thead><tr><th>Class</th><th>Surface</th><th>Q0</th><th>S1</th></tr></thead><tbody>
      ${RL_SURFACES.map(k => `<tr><td><b>${k}</b></td><td>${escHtml(RL_SURFACE_INFO[k].desc)}</td><td class="sl-mono">${RL_SURFACE_INFO[k].q0.toFixed(2)}</td><td class="sl-mono">${RL_SURFACE_INFO[k].s1.toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div>`,
      `<button class="btn-small btn-primary" data-m="close">Close</button>`, 'rl-modal-wide');
    this._modalResult(document.getElementById('rl-info-modal'));
  },

  // ─── SANS class helper ───────────────────────────────────────────────
  // Functional road class (Definition of road classes, after the Guidelines for
  // the Provision of Engineering Services in Residential Townships) → SANS
  // 10098-1 category; SANS 10098-2 tables 2 and 4 for junctions and cycle /
  // pedestrian ways. Always a suggestion — the designer confirms it.
  ROAD_CLASSES: [
    { id: '1', name: 'Class 1 — Trunk road (freeway, national, provincial, inter-regional)' },
    { id: '2', name: 'Class 2 — Primary distributor (urban freeway, expressway, major arterial)' },
    { id: '3', name: 'Class 3 — District distributor (minor arterial, major collector)' },
    { id: '4', name: 'Class 4 — Local distributor (minor collector, collector street)' },
    { id: '5a', name: 'Class 5a — Residential access collector (up to ~200 dwellings)' },
    { id: '5b', name: 'Class 5b — Residential access loop (up to ~120 dwellings)' },
    { id: '5c', name: 'Class 5c — Access cul-de-sac (6–60 dwellings)' },
    { id: '5d', name: 'Class 5d — Access way (up to 60 dwellings)' },
    { id: '5e', name: 'Class 5e — Access court (up to ~30 dwellings)' },
    { id: '5f', name: 'Class 5f — Access strip / panhandle (up to 4 dwellings)' },
    { id: '5g', name: 'Class 5g — Private road' },
  ],
  // SANS 10098-2 Table 2 (roadway complexes): [security group][navigational task High, Normal]
  // → classes for pedestrians High (brightness H, M, L) then Normal (H, M, L).
  RC_TABLE: [
    [[0, 0, 1, 1, 1, 2], [1, 1, 1, 2, 2, 3]],
    [[1, 2, 2, 2, 3, 3], [1, 2, 2, 2, 3, 4]],
    [[2, 2, 3, 3, 4, 4], [2, 3, 3, 4, 5, 5]],
  ],
  // SANS 10098-2 Table 4 (cycle / pedestrian ways): [crime × recognition] → cyclists High (H, M, L), Normal (H, M, L).
  CP_TABLE: { 'high-nec': [1, 2, 3, 1, 2, 3], 'high-unn': [1, 2, 3, 2, 3, 4], 'normal-nec': [2, 3, 4, 3, 5, 5], 'normal-unn': [3, 4, 5, 4, 5, 6] },

  _suggestRoad(q, median) {
    const why = [], sp = this._num(q.speed, NaN), v = this._num(q.volume, NaN);
    let cls, alts = [];
    switch (q.roadClass) {
      case '1': case '2':
        if (median && sp > 90) { cls = 'A1'; why.push('Freeway / expressway with a median and a speed limit over 90 km/h → A1.'); }
        else { cls = 'A2'; why.push(`A2 (major road). A1 needs a median, no level crossings and over 90 km/h; this road has ${median ? 'a median' : 'no median'} and ${sp > 90 ? 'over' : 'at most'} 90 km/h.`); alts = ['A1']; }
        break;
      case '3':
        if (sp <= 60) { cls = 'A3'; why.push('District distributor at ≤ 60 km/h — an important urban traffic route → A3.'); alts = ['A2']; }
        else { cls = 'A2'; why.push('District distributor above 60 km/h → A2 (major road ≤ 90 km/h).'); alts = ['A3']; }
        break;
      case '4': cls = 'A4'; why.push('Local distributor — connecting / residential major road → A4.'); break;
      case '5a': cls = 'B1'; why.push('Residential access collector, the busiest class-5 road → B1 (medium to high traffic).'); alts = ['B2']; break;
      case '5b': cls = 'B2'; why.push('Residential access loop → B2 (medium traffic).'); alts = ['B1', 'B3']; break;
      default: cls = 'B2'; why.push('The road-class definitions map class 5 roads to B1 / B2. A very lightly trafficked access road may justify B3 (residential street, low traffic) — confirm with the road authority.'); alts = ['B3']; break;
    }
    let volume = 0;
    if (RL_SANS_A[cls]) {
      const [lo, mid] = median ? [200, 600] : [100, 300];
      if (!(v >= 0)) { volume = 0; why.push(`No night-time traffic given — the heaviest column (${RL_SANS_BANDS[median ? 'median' : 'noMedian'][0]}) is used.`); }
      else {
        volume = v <= lo ? 2 : v <= mid ? 1 : 0;
        why.push(`${Math.round(v)} veh/h/lane at night, ${median ? 'with' : 'without'} a median → column ${RL_SANS_BANDS[median ? 'median' : 'noMedian'][volume]} (a volume between two columns takes the heavier).`);
      }
    }
    return { cls, volume, alts, why };
  },

  _suggestJunction(q) {
    const group = q.crime === 'high' && q.face === 'nec' ? 0 : q.crime === 'normal' && q.face === 'unn' ? 2 : 1;
    const col = (q.peds === 'high' ? 0 : 3) + ({ high: 0, medium: 1, low: 2 }[q.bright] || 0);
    const n = this.RC_TABLE[group][q.nav === 'high' ? 0 : 1][col];
    const why = [`SANS 10098-2 Table 2 → class ${n}.`];
    if (group === 1) why.push('Table 2 lists a middle pair of rows without a crime / recognition label; it is used here when only one of "high crime risk" and "facial recognition necessary" applies.');
    why.push('If the feeder roads are lit, use the next higher road class instead where it is higher (SANS 10098-2 4.2.2.3).');
    return { cls: 'RC' + n, volume: 0, alts: [], why };
  },

  _suggestPath(q) {
    const row = this.CP_TABLE[`${q.crime}-${q.face}`];
    const col = (q.cyclists === 'high' ? 0 : 3) + ({ high: 0, medium: 1, low: 2 }[q.bright] || 0);
    const n = row[col];
    return { cls: 'CP' + n, volume: 0, alts: [], why: [`SANS 10098-2 Table 4 → cycle / pedestrian way class ${n}.`, 'A footway beside a group B street is already covered, up to 2 m from the kerb, by the street\'s category — give it a class only if it needs its own.'] };
  },

  async openSuggest(i) {
    const des = this.selected;
    const s = des && des.sections[i];
    if (!s) return;
    const cw = s.type === 'carriageway';
    const median = this._hasMedian(des);
    const q = Object.assign({ mode: cw ? 'road' : 'path', roadClass: '4', speed: 60, volume: '', crime: 'normal', face: 'unn', nav: 'normal', peds: 'normal', bright: 'medium', cyclists: 'normal' }, s._suggest || {});
    const sel = (k, opts) => `<select data-q="${k}">${opts.map(([v, n]) => `<option value="${v}"${String(q[k]) === v ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select>`;
    const body = () => {
      const res = q.mode === 'road' ? this._suggestRoad(q, median) : q.mode === 'junction' ? this._suggestJunction(q) : q.mode === 'ped' ? { cls: q.pedArea || 'C2', volume: 0, alts: [], why: ['SANS 10098-1 Table 2: C1 wholly pedestrian in a city centre, C2 in a local shopping mall.'] } : this._suggestPath(q);
      this._suggestion = res;
      const modes = cw ? [['road', 'Road'], ['junction', 'Junction / roadway complex']] : [['path', 'Cycle / pedestrian way'], ['ped', 'Wholly pedestrian area']];
      let form = '';
      if (q.mode === 'road') form = `
        <label>Functional road class${sel('roadClass', this.ROAD_CLASSES.map(r => [r.id, r.name]))}</label>
        <label>Speed limit<span class="sl-unit"><input type="number" step="10" data-q="speed" value="${escHtml(q.speed)}"> km/h</span></label>
        <label title="Maximum motor vehicles per hour per lane during darkness (SANS 10098-1 Table 1)">Night traffic per lane<span class="sl-unit"><input type="number" step="50" data-q="volume" value="${escHtml(q.volume)}" placeholder="unknown"> veh/h</span></label>
        <div class="sl-hint">Cross-section: ${median ? 'with' : 'without'} a median (from the strips).</div>`;
      else if (q.mode === 'junction') form = `
        <label>Crime risk${sel('crime', [['high', 'High'], ['normal', 'Normal']])}</label>
        <label>Facial recognition${sel('face', [['nec', 'Necessary'], ['unn', 'Unnecessary']])}</label>
        <label>Navigational task${sel('nav', [['high', 'High (complex)'], ['normal', 'Normal']])}</label>
        <label>Pedestrian traffic${sel('peds', [['high', 'High'], ['normal', 'Normal']])}</label>
        <label>Ambient brightness${sel('bright', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}</label>`;
      else if (q.mode === 'ped') form = `<label>Area${sel('pedArea', [['C1', 'C1 — wholly pedestrian, city centre'], ['C2', 'C2 — wholly pedestrian, local shopping mall']])}</label>`;
      else form = `
        <label>Crime risk${sel('crime', [['high', 'High'], ['normal', 'Normal']])}</label>
        <label>Facial recognition${sel('face', [['nec', 'Necessary'], ['unn', 'Unnecessary']])}</label>
        <label>Cyclist traffic${sel('cyclists', [['high', 'High'], ['normal', 'Normal']])}</label>
        <label>Ambient brightness${sel('bright', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}</label>`;
      const req = this._clsReq(des, res.cls, { volume: res.volume });
      return `
        <div class="rl-seg">${modes.map(([v, n]) => `<button type="button" class="${q.mode === v ? 'active' : ''}" data-q-mode="${v}">${n}</button>`).join('')}</div>
        <div class="rl-form">${form}</div>
        <div class="rl-suggest-out">
          <div class="rl-suggest-cls"><span class="rl-cls">${escHtml(res.cls)}</span> <b>${escHtml(RL_SANS_NAMES[res.cls] || '')}</b></div>
          <div class="sl-hint">${escHtml(req)}</div>
          <ul>${res.why.map(w => `<li>${escHtml(w)}</li>`).join('')}</ul>
          ${res.alts.length ? `<div class="sl-hint">Also consider: ${res.alts.map(a => `<button type="button" class="btn-small" data-q-alt="${a}">${a}</button>`).join(' ')}</div>` : ''}
        </div>`;
    };
    const m = this._modal('rl-suggest-modal', `Suggest a category — ${escHtml(s.name || this._secName(s, des))}`, body(),
      `<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Use this category</button>`);
    const bodyEl = m.querySelector('.rl-dialog-body');
    const refresh = () => { bodyEl.innerHTML = body(); };
    bodyEl.addEventListener('change', (e) => { const k = e.target.dataset.q; if (k) { q[k] = e.target.value; refresh(); } });
    bodyEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q-mode], [data-q-alt]');
      if (!b) return;
      if (b.dataset.qMode) { q.mode = b.dataset.qMode; refresh(); }
      else { this._suggestion = Object.assign({}, this._suggestion, { cls: b.dataset.qAlt }); bodyEl.querySelector('.rl-suggest-cls').innerHTML = `<span class="rl-cls">${escHtml(b.dataset.qAlt)}</span> <b>${escHtml(RL_SANS_NAMES[b.dataset.qAlt] || '')}</b>`; }
    });
    if (!(await this._modalResult(m))) return;
    const res = this._suggestion;
    s.cls = res.cls;
    if (RL_SANS_A[res.cls]) s.volume = res.volume;
    s._suggest = Object.assign({}, q);
    this._afterMutate();
  },

  // ─── Photometry detail ───────────────────────────────────────────────
  async openPhotometry(id) {
    const p = this.library[id];
    if (!p) return;
    const usedBy = this.designs.filter(d => d.rows.some(r => r.photometryId === id)).map(d => d.name);
    const m = this._modal('rl-ph-modal', escHtml(p.name), `
      <div class="rl-ph">
        <div class="rl-ph-plot">${this._polarSvg(p)}</div>
        <div class="rl-form">
          <label>Name<input data-p="name" value="${escHtml(p.name)}"></label>
          <label>Manufacturer<input data-p="manufacturer" value="${escHtml(p.manufacturer || '')}"></label>
          <label title="Rated luminaire flux the file's candela values are for. A different value scales the whole distribution (same optic, other lumen package)">Luminaire flux<span class="sl-unit"><input type="number" step="1" data-p="lumens" value="${escHtml(p.lumens)}"> lm</span></label>
          <label>System power<span class="sl-unit"><input type="number" step="0.1" data-p="watts" value="${escHtml(p.watts)}"> W</span></label>
          <label title="If the file's C90 plane does not point across the road to the street side, rotate it here">Rotate C-planes<select data-p="rotate">${[0, 90, 180, 270].map(a => `<option value="${a}"${+p.rotate === a ? ' selected' : ''}>${a}°</option>`).join('')}</select></label>
          <div class="rl-kv">
            <span>Format</span><b>${escHtml(p.format || '')}${p.fileName ? ' · ' + escHtml(p.fileName) : ''}</b>
            <span>Web</span><b>${p.c.length - 1} C-planes × ${p.g.length} γ (${p.g[0]}–${p.g[p.g.length - 1]}°)</b>
            <span>Peak</span><b>${Math.round(p.maxCd)} cd (${Math.round(p.maxCd / p.lumens * 1000)} cd/klm)</b>
            <span>Integrated flux</span><b>${Math.round(p.fluxIntegrated || 0)} lm</b>
            ${p.measurementTilt ? `<span>Measured at tilt</span><b>${p.measurementTilt}°</b>` : ''}
          </div>
          ${p.warning ? `<div class="sl-hint rl-note">${escHtml(p.warning)}</div>` : ''}
          <div class="sl-hint">${usedBy.length ? 'Used by: ' + usedBy.map(escHtml).join(', ') : 'Not used by any design.'}</div>
        </div>
      </div>`, `<button class="btn-small" data-m="delete"${usedBy.length ? ' disabled title="In use by a design"' : ''}>Delete</button><span style="flex:1"></span><button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Save</button>`, 'rl-modal-wide');
    const res = await this._modalResult(m);
    if (res === 'delete') {
      if (await UI.confirm(`Delete luminaire "${p.name}"?`, { danger: true, okText: 'Delete' })) { delete this.library[id]; this._markDirty(); this.render(); }
      return;
    }
    if (!res) return;
    const v = (k) => m.querySelector(`[data-p="${k}"]`).value;
    const newLm = this._num(v('lumens'), p.lumens);
    if (newLm > 0 && Math.abs(newLm - p.lumens) > 1e-6) {
      // Same optic, other lumen package: scale the web so it stays self-consistent.
      const k = newLm / p.lumens;
      p.cd = p.cd.map(row => row.map(x => +(x * k).toFixed(1)));
      p.maxCd = +(p.maxCd * k).toFixed(1);
      p.fluxIntegrated = +((p.fluxIntegrated || 0) * k).toFixed(1);
      p.lumens = newLm;
    }
    p.name = v('name') || p.name;
    p.manufacturer = v('manufacturer');
    p.watts = this._num(v('watts'), p.watts);
    p.rotate = this._num(v('rotate'), 0);
    this._markDirty();
    this.render();
    this.recompute(0);
  },

  // Polar intensity curves in the C0–C180 (along the road) and C90–C270 (across) planes.
  _polarSvg(p, R = 120) {
    const W = 2 * R + 40, cx = W / 2, cy = 20 + R * 0.35, H = Math.round(cy + R + 26);
    const cdk = p.cd.map(row => row.map(v => v / p.lumens * 1000));
    let max = 0;
    for (const row of cdk) for (const v of row) if (v > max) max = v;
    const ringMax = Math.ceil(max / 100) * 100 || 100;
    const plane = (cDeg) => {
      const i = p.c.findIndex(c => Math.abs(c - cDeg) < 1e-6);
      if (i >= 0) return cdk[i];
      let j = p.c.findIndex(c => c > cDeg); if (j <= 0) j = 1;
      const t = (cDeg - p.c[j - 1]) / (p.c[j] - p.c[j - 1]);
      return cdk[j - 1].map((v, k) => v * (1 - t) + cdk[j][k] * t);
    };
    const curve = (cA, cB) => {
      const a = plane(cA), b = plane(cB);
      const pts = [];
      p.g.forEach((g, k) => { if (g <= 90) pts.push([-g, b[k]]); });
      pts.reverse();
      p.g.forEach((g, k) => { if (g <= 90) pts.push([g, a[k]]); });
      return pts.map(([g, v], k) => {
        const r = v / ringMax * R, th = g * Math.PI / 180;
        return `${k ? 'L' : 'M'}${(cx + r * Math.sin(th)).toFixed(1)} ${(cy + r * Math.cos(th)).toFixed(1)}`;
      }).join('');
    };
    const rings = [0.25, 0.5, 0.75, 1].map(f => `<path d="M${cx - f * R} ${cy} A${f * R} ${f * R} 0 0 0 ${cx + f * R} ${cy}" fill="none" stroke="var(--border-color)"/><text x="${cx + 3}" y="${cy + f * R - 3}" class="rl-xs-s">${Math.round(f * ringMax)}</text>`).join('');
    const spokes = [30, 60, 90].map(g => [-g, g]).flat().map(g => { const th = g * Math.PI / 180; return `<line x1="${cx}" y1="${cy}" x2="${cx + R * Math.sin(th)}" y2="${cy + R * Math.cos(th)}" stroke="var(--border-color)" stroke-dasharray="2 3"/><text x="${cx + (R + 10) * Math.sin(th)}" y="${cy + (R + 10) * Math.cos(th) + 4}" text-anchor="middle" class="rl-xs-s">${Math.abs(g)}°</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Polar intensity diagram">
      ${rings}${spokes}
      <path d="${curve(0, 180)}" fill="none" stroke="var(--rl-s1)" stroke-width="2"/>
      <path d="${curve(90, 270)}" fill="none" stroke="var(--rl-s2)" stroke-width="2" stroke-dasharray="6 3"/>
      </svg>
      <div class="rl-legend"><span class="rl-leg"><i style="background:var(--rl-s1)"></i>C0–C180 along the road</span><span class="rl-leg"><i class="dash" style="background:var(--rl-s2)"></i>C90 street side (right) – C270 house side</span><span class="sl-hint">cd/klm</span></div>`;
  },

  // ─── Optimiser ───────────────────────────────────────────────────────
  _list(s) { return String(s || '').split(/[,;\s]+/).map(x => parseFloat(x)).filter(x => isFinite(x)); },

  openOptimise() {
    const des = this.selected;
    if (!des) return;
    const o = des.optimise;
    if (!Array.isArray(o.photometryIds) || !o.photometryIds.length) o.photometryIds = [...new Set(des.rows.map(r => r.photometryId))];
    const m = this._modal('rl-opt-modal', 'Optimise the layout', `
      <p class="rl-lead">Every combination below is tried on <b>every row</b> of this design, each at the largest spacing that still passes all classes (${des.sweep.min}–${des.sweep.max} m in ${des.sweep.step} m steps). Setback, arrangement and cross-section stay as they are.</p>
      <div class="rl-form rl-opt-form">
        <label>Mounting heights<span class="sl-unit"><input data-o="heights" value="${escHtml(o.heights)}"> m</span></label>
        <label>Tilts<span class="sl-unit"><input data-o="tilts" value="${escHtml(o.tilts)}"> °</span></label>
        <label>Overhangs<span class="sl-unit"><input data-o="overhangs" value="${escHtml(o.overhangs)}"> m</span></label>
        <label title="Dimming levels — flux and power scale together">Flux levels<span class="sl-unit"><input data-o="fluxPcts" value="${escHtml(o.fluxPcts)}"> %</span></label>
        <label>Rank by<select data-o="rank">
          <option value="wPerKm"${o.rank === 'wPerKm' ? ' selected' : ''}>Lowest W/km</option>
          <option value="polesPerKm"${o.rank === 'polesPerKm' ? ' selected' : ''}>Fewest poles/km</option>
          <option value="pdi"${o.rank === 'pdi' ? ' selected' : ''}>Lowest PDI</option>
          <option value="spacing"${o.rank === 'spacing' ? ' selected' : ''}>Largest spacing</option></select></label>
      </div>
      <div class="rl-opt-lums"><div class="rl-solve-t">Luminaires</div>${this._libList().map(p => `<label class="rl-check"><input type="checkbox" data-o-ph="${p.id}"${o.photometryIds.includes(p.id) ? ' checked' : ''}> ${escHtml(this._lumLabel(p))}</label>`).join('')}</div>
      <div class="sl-hint" id="rl-opt-count"></div>
      <div id="rl-opt-res" class="rl-opt-res">${this._optTable(des)}</div>`,
      `<button class="btn-small" data-m="close">Close</button><button class="btn-small btn-primary" data-m="run">Run</button>`, 'rl-modal-wide');
    const count = () => {
      const n = [this._list(m.querySelector('[data-o="heights"]').value).length || 1, this._list(m.querySelector('[data-o="tilts"]').value).length || 1,
        this._list(m.querySelector('[data-o="overhangs"]').value).length || 1, this._list(m.querySelector('[data-o="fluxPcts"]').value).length || 1,
        m.querySelectorAll('[data-o-ph]:checked').length || 1].reduce((a, b) => a * b, 1);
      m.querySelector('#rl-opt-count').textContent = `${n} combination${n === 1 ? '' : 's'}${n > 1500 ? ' — only the first 1 500 run' : ''}`;
    };
    m.oninput = count; m.onchange = count; count();
    m.onclick = async (e) => {
      const b = e.target.closest('[data-m], [data-rl-optuse]');
      if (e.target === m || (b && b.dataset.m === 'close')) { m.style.display = 'none'; return; }
      if (!b) return;
      if (b.dataset.rlOptuse !== undefined) { this._useOption(des, this._opt[des.id].options[+b.dataset.rlOptuse]); m.style.display = 'none'; return; }
      if (b.dataset.m !== 'run') return;
      ['heights', 'tilts', 'overhangs', 'fluxPcts', 'rank'].forEach(k => { o[k] = m.querySelector(`[data-o="${k}"]`).value; });
      o.photometryIds = [...m.querySelectorAll('[data-o-ph]:checked')].map(x => x.dataset.oPh);
      this._markDirty();
      const res = m.querySelector('#rl-opt-res');
      res.innerHTML = '<div class="sl-empty">Optimising…</div>';
      b.disabled = true;
      try {
        const cfg = {
          heights: this._list(o.heights), tilts: this._list(o.tilts), overhangs: this._list(o.overhangs), fluxPcts: this._list(o.fluxPcts),
          photometryIds: o.photometryIds, rank: o.rank, spacing: des.sweep, top: 50,
        };
        const r = await API.request('/analysis/road-lighting', 'POST', this._payload(des, { mode: 'optimise', optimise: cfg, extraPhotometry: o.photometryIds }));
        this._opt[des.id] = r;
      } catch (err) {
        this._opt[des.id] = { error: err.message || String(err) };
      }
      b.disabled = false;
      res.innerHTML = this._optTable(des);
      this.renderResults();
    };
  },

  _optTable(des) {
    const o = this._opt[des.id];
    if (!o) return '';
    if (o.error) return `<div class="rl-err">${escHtml(o.error)}</div>`;
    if (!o.options.length) return `<div class="rl-best bad">None of the ${o.nEvaluated} combinations passes at any spacing in ${des.sweep.min}–${des.sweep.max} m.</div>`;
    return `<div class="sl-hint">${o.nPassing} of ${o.nEvaluated} combinations pass · ${o.seconds} s${o.nSkipped ? ` · ${o.nSkipped} not run (cap)` : ''} · top ${o.options.length} shown</div>
      <div class="rl-grid-scroll"><table class="rl-chk rl-opt-table"><thead><tr><th></th><th>#</th><th>Spacing</th><th>W/km</th><th>Height</th><th>Tilt</th><th>Overhang</th><th>Flux</th><th>Luminaire</th><th>Poles/km</th><th>PDI</th></tr></thead>
      <tbody>${o.options.map((p, i) => `<tr><td><button class="btn-small" data-rl-optuse="${i}">Use</button></td><td>${i + 1}</td>
        <td class="sl-mono">${p.spacing} m</td><td class="sl-mono">${Math.round(p.energy.wPerKm).toLocaleString()}</td><td>${p.height} m</td><td>${p.tilt}°</td><td>${p.overhang} m</td><td>${p.fluxPct}%</td>
        <td class="rl-ph-cell">${escHtml((this.library[p.photometryId] || {}).name || '?')}</td><td class="sl-mono">${this._fmt(p.energy.polesPerKm, 1)}</td>
        <td class="sl-mono">${p.energy.pdi === null ? '—' : this._fmt(p.energy.pdi * 1000, 1)}</td></tr>`).join('')}</tbody></table></div>`;
  },

  _useOption(des, p) {
    if (!des || !p) return;
    des.rows.forEach(r => { r.height = p.height; r.tilt = p.tilt; r.overhang = p.overhang; r.photometryId = p.photometryId; r.fluxPct = p.fluxPct; });
    des.spacing = p.spacing;
    this._afterMutate();
  },

  // ─── Apply to a street lighting circuit ──────────────────────────────
  async applyToCircuit() {
    const des = this.selected;
    if (!des) return;
    const circuits = StreetLight.circuits;
    if (!circuits.length) return;
    const ph = this.library[(des.rows[0] || {}).photometryId];
    const watts = ph ? ph.watts * this._num(des.rows[0].fluxPct, 100) / 100 : 0;
    const match = SL_LUMINAIRES.filter(l => l.id.startsWith('led')).reduce((best, l) => (!best || Math.abs(l.watts - watts) < Math.abs(best.watts - watts) ? l : best), null);
    const m = this._modal('rl-apply-modal', 'Apply to a circuit', `
      <div class="rl-form">
        <label>Circuit<select data-a="circuit">${circuits.map(c => `<option value="${c.id}">${escHtml(c.name)} (${c.poles.length} poles, ${c.spacingM} m)</option>`).join('')}</select></label>
        <label class="rl-check"><input type="checkbox" data-a="spacing" checked> Pole spacing → ${this._fmt(des.spacing, 1)} m</label>
        ${match && watts ? `<label class="rl-check"><input type="checkbox" data-a="lum"${Math.abs(match.watts - watts) <= 5 ? ' checked' : ''}> Luminaire → ${escHtml(match.name)} <span class="sl-hint">(design: ${this._fmt(watts, 0)} W)</span></label>` : ''}
      </div>
      <p class="sl-hint">The circuit's volt drop, earth loop and kVA are recalculated with it. A staggered or opposite layout puts poles on both sides: each side's circuit takes the same spacing.</p>`,
      `<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Apply</button>`);
    if (!(await this._modalResult(m))) return;
    const c = StreetLight.circuit(m.querySelector('[data-a="circuit"]').value);
    if (!c) return;
    if (m.querySelector('[data-a="spacing"]').checked) c.spacingM = this._num(des.spacing, c.spacingM);
    const lum = m.querySelector('[data-a="lum"]');
    if (lum && lum.checked && match) c.luminaireId = match.id;
    StreetLight._afterMutate(false);
    this._markDirty();
    await UI.alert(`${c.name} now uses ${c.spacingM} m spacing${lum && lum.checked ? ` and ${match.name}` : ''}.`);
  },

  // ─── Small modal helper ──────────────────────────────────────────────
  _modal(id, title, body, foot, cls = '') {
    let m = document.getElementById(id);
    if (!m) {
      m = document.createElement('div');
      m.id = id;
      m.className = 'modal rl-modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      document.body.appendChild(m);
    }
    m.innerHTML = `<div class="modal-content rl-dialog ${cls}">
      <div class="modal-header"><h3>${title}</h3><button class="modal-close" data-m="close" aria-label="Close">&times;</button></div>
      <div class="rl-dialog-body">${body}</div>
      <div class="rl-dialog-foot">${foot}</div></div>`;
    m.style.display = 'flex';
    m.onclick = null; m.oninput = null; m.onchange = null;
    return m;
  },
  _modalResult(m) {
    return new Promise((resolve) => {
      const done = (v) => { m.style.display = 'none'; m.onclick = null; m.onkeydown = null; resolve(v); };
      m.onclick = (e) => {
        if (e.target === m) return done(false);
        const b = e.target.closest('[data-m]');
        if (!b || b.disabled) return;
        done(b.dataset.m === 'ok' ? true : b.dataset.m === 'close' ? false : b.dataset.m);
      };
      m.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
    });
  },
};
