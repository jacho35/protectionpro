/* ProtectionPro — Lightning risk assessment dialog (IEC 62305-2).
 *
 * A guided four-step dialog (structure & site → people & fire → service lines
 * → existing protection) with a live estimate of the strike frequency, and a
 * verdict-first results page. Every input keeps its original element id, so the
 * request built by app.js (collectLightningParams / restoreLightningParams) and
 * the inputs saved with the project are unchanged: option cards and segmented
 * buttons write into a hidden input carrying that id.
 *
 * Two editions of IEC 62305-2, picked per assessment (#lr-edition): 2024
 * (Ed. 3, the default for a new assessment — risk R = R_L1 + R_L2 per zone and
 * the frequency of damage F) and 2010 (Ed. 2 — R1 only; an assessment saved
 * before editions existed restores as 2010 so it reproduces). Fields that
 * belong to one edition carry data-lr-ed and are hidden for the other.
 *
 * A project holds any number of named assessments (one per structure) in
 * AppState.lightningAssessments: {id, name, inputs, result, resultKey,
 * resultAt, updatedAt}. Inputs save to the active one as they are typed; a
 * result is kept with the inputs it was calculated from (resultKey), so a later
 * edit shows the result as out of date. LightningReport builds the PDF.
 */

const LightningUI = {
  step: 1,
  STEP_SUBS: {
    1: 'Step 1 of 4 — tell us about the structure',
    2: 'Step 2 of 4 — occupancy and fire',
    3: 'Step 3 of 4 — lines entering the building',
    4: 'Step 4 of 4 — protection already installed',
    5: 'Results',
  },
  // The dialog's original defaults (an unprotected 20 × 15 × 8 m building).
  DEFAULTS: {
    'lr-length': 20, 'lr-width': 15, 'lr-height': 8, 'lr-ng': 4,
    'lr-location': 'surrounded_same_height', 'lr-use': 'other', 'lr-hazard': 'none',
    'lr-floor': 'agricultural_concrete', 'lr-fire-risk': 'ordinary', 'lr-fire-prot': 'none',
    'lr-lps': 'none', 'lr-spd': 'none', 'lr-persons': 10, 'lr-hours': 8760, 'lr-uw': '2.5',
    'lr-line1-len': 1000, 'lr-line1-inst': 'buried', 'lr-line1-env': 'suburban',
    'lr-line2-len': 1000, 'lr-line2-inst': 'aerial', 'lr-line2-env': 'suburban',
    'lr-line1-screen': 'unshielded', 'lr-line2-screen': 'unshielded',
    'lr-edition': '2024', 'lr-rt': 1e-5,
    'lr24-dens': 'ng', 'lr24-k': 2, 'lr24-constr': 'masonry', 'lr24-loss': 'normal', 'lr24-expl': 'none',
    'lr24-touch': 'none', 'lr24-exp-hours': 50, 'lr24-exp-floor': 'agricultural_concrete', 'lr24-exp-touch': 'none',
    'lr24-l1-hvlen': 1000, 'lr24-l2-kind': 'copper', 'lr24-uwp': '2.5', 'lr24-ks3p': 'different_routing',
    'lr24-uwt': '1.5', 'lr24-ks3t': 'different_routing', 'lr24-eb': 'none', 'lr24-ft': '0.1',
  },
  DEFAULT_CHECKS: { 'lr-explosion': false, 'lr-line1-en': true, 'lr-line1-tx': true, 'lr-line2-en': false,
    'lr24-life': false, 'lr24-liion': false, 'lr24-exp-en': false, 'lr24-exp-direct': false, 'lr24-l1-hv': true },
  // Table A.1 location factor, for the live estimate.
  CD: { surrounded_by_taller: 0.25, surrounded_same_height: 0.5, isolated: 1, isolated_hilltop: 2 },

  _el(id) { return document.getElementById(id); },

  applyDefaults() {
    for (const [id, v] of Object.entries(this.DEFAULTS)) { const el = this._el(id); if (el) el.value = v; }
    for (const [id, v] of Object.entries(this.DEFAULT_CHECKS)) { const el = this._el(id); if (el) el.checked = v; }
  },

  // Option cards / segmented buttons ↔ their hidden input.
  syncChoices() {
    document.querySelectorAll('#lightning-modal [data-lr-target]').forEach(group => {
      const val = (this._el(group.dataset.lrTarget) || {}).value;
      group.querySelectorAll('[data-value]').forEach(b => {
        const on = b.dataset.value === val;
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('on', on);
        b.tabIndex = on ? 0 : -1;
      });
    });
    this.syncLines();
    this.syncEdition();
  },
  edition() { return ((this._el('lr-edition') || {}).value === '2010') ? '2010' : '2024'; },
  // Show the fields of the chosen edition only.
  syncEdition() {
    const ed = this.edition();
    document.querySelectorAll('#lightning-modal [data-lr-ed]').forEach(el => { el.hidden = el.dataset.lrEd !== ed; });
    // "better than LPL I" is a 2024 option only
    const spd = this._el('lr-spd');
    if (ed === '2010' && spd && spd.value === 'better') { spd.value = 'I'; this.syncChoices(); return; }
    const tag = this._el('lr-tag-ed'), scope = this._el('lr-tag-scope');
    if (tag) tag.textContent = `IEC 62305-2:${ed}`;
    if (scope) scope.innerHTML = ed === '2024' ? 'Risk R and frequency of damage F' : 'Risk to life, R<sub>1</sub>';
    const nsg = ed === '2024' && (this._el('lr24-dens') || {}).value === 'nsg';
    const lab = this._el('lr-ng-label'), sym = this._el('lr-ng-sym'), unit = this._el('lr-ng-unit');
    if (lab) lab.textContent = nsg ? 'Lightning ground strike-point density' : 'Lightning ground flash density';
    if (sym) sym.innerHTML = nsg ? 'N<sub>SG</sub>' : 'N<sub>G</sub>';
    if (unit) unit.textContent = nsg ? 'strike points / km² / yr' : 'flashes / km² / yr';
  },
  // A service line's own fields only matter when the line is ticked.
  syncLines() {
    for (const n of [1, 2]) {
      const en = this._el(`lr-line${n}-en`);
      const box = en && en.closest('.lr-line');
      if (box) box.classList.toggle('off', !en.checked);
    }
  },

  // Collection area A_D and strike frequencies N_D / N_M (IEC 62305-2 Annex A),
  // exactly as the engine computes them, so the numbers read before running.
  // 2010: N_D = N_G·A_D·C_D, N_M over a 500 m band. 2024: N_SG = k·N_G,
  // N_M = N_SG·A_M/k with r_M = 350/U_W of the weakest internal system (A.7/A.8).
  updateLive() {
    const n = (id) => parseFloat((this._el(id) || {}).value) || 0;
    const L = n('lr-length'), W = n('lr-width'), H = n('lr-height'), NG = n('lr-ng');
    const cd = this.CD[(this._el('lr-location') || {}).value] || 1;
    const ad = L * W + 2 * (3 * H) * (L + W) + Math.PI * (3 * H) ** 2;
    let am, nd, nm, rm = 500;
    if (this.edition() === '2024') {
      const k = n('lr24-k') > 0 ? n('lr24-k') : 2;
      const nsg = (this._el('lr24-dens') || {}).value === 'nsg' ? NG : k * NG;
      const uws = [];
      if ((this._el('lr-line1-en') || {}).checked) uws.push(n('lr24-uwp') || 2.5);
      if ((this._el('lr-line2-en') || {}).checked && (this._el('lr24-l2-kind') || {}).value !== 'fibre') uws.push(n('lr24-uwt') || 1.5);
      rm = uws.length ? 350 / Math.min(...uws) : 0;
      am = rm ? 2 * rm * (L + W) + Math.PI * rm ** 2 : 0;
      nd = nsg * ad * cd * 1e-6;
      nm = (1 / k) * nsg * am * 1e-6;
    } else {
      am = 2 * 500 * (L + W) + Math.PI * 500 ** 2;
      nd = NG * ad * cd * 1e-6;
      nm = NG * am * 1e-6;
    }
    const nmk = this._el('lr-live-nm-k');
    if (nmk) nmk.innerHTML = rm ? `Strikes within ${Math.round(rm)} m <i>N</i><sub>M</sub>` : 'Strikes nearby <i>N</i><sub>M</sub>';
    const rt = n('lr-rt') > 0 ? n('lr-rt') : 1e-5;
    const rtEl = this._el('lr-live-rt');
    if (rtEl) rtEl.innerHTML = `${this._sci(rt)} <small>/ yr</small>`;
    const rtE = this._el('lr-live-rt-e');
    if (rtE) rtE.textContent = this.edition() === '2024' ? 'IEC 62305-2:2024 7.3 (representative value)' : 'IEC 62305-2:2010 Table 4';
    const set = (id, html) => { const el = this._el(id); if (el) el.innerHTML = html; };
    set('lr-live-ad', `${Math.round(ad).toLocaleString()} <small>m²</small>`);
    set('lr-live-nd', `${nd >= 0.01 ? nd.toFixed(3) : nd >= 1e-4 ? nd.toPrecision(2) : nd.toExponential(1)} <small>/ yr</small>`);
    set('lr-live-nd-e', nd > 0 ? `About one direct strike every ${this._years(1 / nd)}` : 'Enter the dimensions and N<sub>G</sub>');
    set('lr-live-nm', `${nm.toFixed(1)} <small>/ yr</small>`);
  },
  _years(y) {
    if (!isFinite(y)) return '—';
    if (y < 1) return `${Math.max(1, Math.round(y * 12))} months`;
    if (y < 10) return `${y.toFixed(1)} years`;
    return `${Math.round(y).toLocaleString()} years`;
  },

  go(step) {
    // Results only once there are results to show.
    if (step === 5 && !this._el('lightning-results').innerHTML.trim()) step = 4;
    this.step = step;
    document.querySelectorAll('#lightning-modal [data-lr-panel]').forEach(p => { p.hidden = +p.dataset.lrPanel !== step; });
    const hasResults = !!this._el('lightning-results').innerHTML.trim();
    document.querySelectorAll('#lightning-modal [data-lr-go]').forEach(b => {
      const s = +b.dataset.lrGo;
      b.classList.toggle('on', s === step);
      b.classList.toggle('done', s < step || (hasResults && s < 5 && step === 5));
      b.setAttribute('aria-current', s === step ? 'step' : 'false');
      b.disabled = s === 5 && !hasResults;
    });
    const a = this.current();
    this._el('lr-head-sub').textContent = (a ? a.name + ' · ' : '') + this.STEP_SUBS[step];
    this._el('lr-export').hidden = !(step === 5 && a && a.result);
    this._el('lr-foot-pg').textContent = step === 5 ? 'Inputs are saved with the project' : `Step ${step} of 4 · inputs are saved with the project`;
    this._el('lr-back').hidden = step === 1;
    this._el('lr-back').textContent = step === 5 ? '‹ Edit inputs' : '‹ Back';
    this._el('lr-next').hidden = step >= 4;
    this._el('btn-run-lightning').hidden = step !== 4;
    const main = document.querySelector('#lightning-modal .lr-main');
    if (main) main.scrollTop = 0;
  },

  open() { this.openModal(); },

  // ── Named assessments (saved with the project) ─────────────────────
  list() {
    if (!Array.isArray(AppState.lightningAssessments)) AppState.lightningAssessments = [];
    return AppState.lightningAssessments;
  },
  current() {
    const l = this.list();
    return l.find(a => a.id === AppState.lightningActiveId) || l[0] || null;
  },
  _genId() {
    const used = new Set(this.list().map(a => a.id));
    let n = this.list().length + 1;
    while (used.has('lra_' + n)) n++;
    return 'lra_' + n;
  },
  _nextName() {
    const names = new Set(this.list().map(a => a.name));
    let n = this.list().length + 1;
    while (names.has('Assessment ' + n)) n++;
    return 'Assessment ' + n;
  },
  _create(name, inputs) {
    const a = { id: this._genId(), name, inputs: inputs || null, result: null, resultKey: null, resultAt: null, updatedAt: Date.now() };
    this.list().push(a);
    AppState.lightningActiveId = a.id;
    AppState.dirty = true;
    return a;
  },

  openModal() {
    if (!this.current()) this._create('Assessment 1', null);
    this.loadActive();
    this._el('lightning-modal').style.display = '';
  },

  // Show the active assessment: defaults first (so nothing leaks between
  // assessments or projects), then its saved inputs, then its saved result.
  loadActive() {
    const a = this.current();
    AppState.lightningActiveId = a.id;
    this.applyDefaults();
    if (a.inputs && this.restore) this.restore(a.inputs);
    this.syncChoices();
    this.updateLive();
    if (!a.inputs && this.collect) a.inputs = this.collect();   // a fresh one saves its defaults
    this._el('lightning-results').innerHTML = a.result ? this._resultsHtml(a.result) : '';
    this.renderPicker();
    this.updateStale();
    this.go(a.result ? 5 : 1);
  },

  renderPicker() {
    const sel = this._el('lr-assess-select');
    if (!sel) return;
    const cur = this.current();
    sel.innerHTML = this.list().map(a =>
      `<option value="${escHtml(a.id)}"${a === cur ? ' selected' : ''}>${escHtml(a.name)}${a.result ? (a.result.compliant ? ' ✓' : ' ✗') : ''}</option>`).join('');
    this._el('lr-assess-del').disabled = false;
  },

  // Save what is on screen into the active assessment (called as you type).
  saveInputs() {
    const a = this.current();
    if (!a || !this.collect) return;
    a.inputs = this.collect();
    a.updatedAt = Date.now();
    AppState.dirty = true;
    this.updateStale();
  },
  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveInputs(), 250);
  },
  storeResult(params, res) {
    const a = this.current();
    if (!a) return;
    a.inputs = params;
    a.result = res;
    a.resultKey = JSON.stringify(params);
    a.resultAt = Date.now();
    AppState.dirty = true;
    this.renderPicker();
  },
  isStale(a) {
    a = a || this.current();
    return !!(a && a.result && this.collect && JSON.stringify(this.collect()) !== a.resultKey);
  },
  updateStale() {
    const b = this._el('lr-stale');
    if (b) b.hidden = !this.isStale();
  },

  async _newAssessment(copy) {
    this.saveInputs();
    const src = this.current();
    const name = await UI.prompt(copy ? 'Name for the copy:' : 'Name for the new assessment (e.g. the building):',
      copy ? `${src.name} (copy)` : this._nextName());
    if (name == null || !name.trim()) return;
    this._create(name.trim(), copy && src.inputs ? JSON.parse(JSON.stringify(src.inputs)) : null);
    this.loadActive();
  },
  async _rename() {
    const a = this.current();
    const name = await UI.prompt('Rename assessment:', a.name);
    if (name == null || !name.trim()) return;
    a.name = name.trim();
    AppState.dirty = true;
    this.renderPicker();
    this.go(this.step);
  },
  async _delete() {
    const a = this.current();
    if (!(await UI.confirm(`Delete the assessment “${a.name}”? Its inputs and result are removed from the project.`, { danger: true, okText: 'Delete' }))) return;
    AppState.lightningAssessments = this.list().filter(x => x !== a);
    AppState.lightningActiveId = (this.list()[0] || {}).id || null;
    AppState.dirty = true;
    if (!this.current()) this._create('Assessment 1', null);
    this.loadActive();
  },

  // ── Results ────────────────────────────────────────────────────────
  FRIENDLY: {
    RA: 'Shock from touch / step voltage, strike <b>on the building</b>',
    RAT: 'Shock from touch / step voltage, strike <b>on the building</b>',
    RAD: 'Direct strike to people <b>on the roof</b>',
    FC: 'Equipment damaged, strike on the building',
    FM: 'Equipment damaged, strike <b>near the building</b>',
    FW: 'Equipment damaged, strike on a line',
    FZ: 'Equipment damaged, strike <b>near a line</b>',
    RB: 'Fire, strike <b>on the building</b>',
    RC: 'Surge damages internal systems, strike on the building',
    RM: 'Surge damages internal systems, strike <b>near the building</b>',
    RU: 'Shock from touch voltage, strike <b>on a line</b>',
    RV: 'Fire, strike <b>on a line</b>',
    RW: 'Surge damages internal systems, strike on a line',
    RZ: 'Surge damages internal systems, strike <b>near a line</b>',
  },
  INTERNAL: ['RC', 'RM', 'RW', 'RZ'],
  // R_A, R_AT → "R<sub>AT</sub>"; F_C → "F<sub>C</sub>"
  _codeAny(c) { c = String(c); return `${c[0]}<sub>${escHtml(c.slice(1))}</sub>`; },

  // 7.3e-4 → "7.3 × 10⁻⁴"
  _sci(v) {
    if (!v) return '0';
    const e = Math.floor(Math.log10(Math.abs(v)));
    const m = v / 10 ** e;
    const sup = String(e).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    return `${m.toFixed(m < 9.95 ? 1 : 0)} × 10${sup}`;
  },
  _code(c) { return `R<sub>${escHtml(String(c).replace(/^R/, ''))}</sub>`; },

  _resultsHtml(res) {
    const a = this.current();
    const at = a && a.resultAt ? new Date(a.resultAt).toLocaleString() : '';
    return `<div class="lr-stale" id="lr-stale" hidden>⚠ The inputs have changed since this result was calculated.
        <button type="button" class="btn btn-primary" data-lr-rerun>Re-assess</button></div>` +
      this.renderResults(res) +
      (at ? `<div class="lr-saved-at">Calculated ${escHtml(at)} · saved with the project as “${escHtml(a.name)}”.</div>` : '');
  },
  showResults(res) {
    this._el('lightning-results').innerHTML = this._resultsHtml(res);
    this.updateStale();
    this.go(5);
  },
  showError(msg) {
    this._el('lightning-results').innerHTML = `<div class="af-warning-item">⚠ ${escHtml(msg)}</div>`;
    this.go(5);
  },

  renderResults(res) {
    if (res.edition === '2024') return this.renderResults2024(res);
    const RT = res.tolerable_r1 || 1e-5;
    const times = res.r1 / RT;
    const opts = res.options || [];
    const rec = opts.find(o => o.compliant) || null;
    const comps = (res.components || [])
      .filter(c => !(c.value === 0 && !res.systems_life_risk && this.INTERNAL.includes(c.code)))
      .sort((a, b) => b.value - a.value);
    const f2 = (v) => (v * 1e5).toFixed(2);
    let h = '';
    for (const w of res.warnings || []) h += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;

    // Verdict + recommendation
    const verdict = res.compliant
      ? `<div class="lr-v lr-v-ok" role="status"><span class="lr-v-k">Within the tolerable risk</span>
          <span class="lr-v-big">R<sub>1</sub> = ${this._sci(res.r1)} <small>per year</small></span>
          <span class="lr-v-t">That is ${times < 0.1 ? 'well below' : (times * 100).toFixed(0) + '% of'} the tolerable limit R<sub>T</sub> = ${this._sci(RT)} per year. No further protection is needed for risk to life.</span></div>`
      : `<div class="lr-v lr-v-bad" role="status"><span class="lr-v-k">Exceeds the tolerable risk</span>
          <span class="lr-v-big">R<sub>1</sub> = ${this._sci(res.r1)} <small>per year</small></span>
          <span class="lr-v-t">That is <b>${times >= 10 ? Math.round(times) : times.toFixed(1)} times</b> the tolerable limit R<sub>T</sub> = ${this._sci(RT)} per year. Lightning protection is required for this structure.</span></div>`;
    let recCard = '';
    if (!res.compliant) {
      recCard = rec
        ? `<div class="lr-v lr-v-rec"><span class="lr-v-k">Minimum protection that meets R<sub>T</sub></span>
            <span class="lr-v-name">${escHtml(this._cap(rec.label))}</span>
            <span class="lr-v-t">Brings R<sub>1</sub> down to <b>${this._sci(rec.r1)} per year</b> (${(rec.r1 / RT).toFixed(2)} × R<sub>T</sub>). Nothing lighter on the list below is enough.</span></div>`
        : `<div class="lr-v lr-v-bad"><span class="lr-v-k">No listed combination is enough</span>
            <span class="lr-v-t">${escHtml(res.recommendation || '')} Even the heaviest protection on the list below does not reach R<sub>T</sub>: review the inputs or add further measures.</span></div>`;
    }
    h += `<div class="lr-verdict${recCard ? '' : ' single'}">${verdict}${recCard}</div>`;

    // Why: what drives it
    const internal = comps.filter(c => this.INTERNAL.includes(c.code)).reduce((s, c) => s + c.share_pct, 0);
    const top = comps[0];
    let why = '';
    if (!res.compliant && res.systems_life_risk && internal >= 50) {
      const spdOnly = opts.find(o => o.lps_class === 'none' && o.spd_level && o.spd_level !== 'none');
      const cut = spdOnly ? Math.round((1 - spdOnly.r1 / res.r1) * 100) : null;
      why = `<b>Why so high?</b> ${Math.round(internal)}% of the risk is <b>surges damaging internal systems</b> (${this.INTERNAL.filter(c => comps.some(x => x.code === c && x.value > 0)).map(c => this._code(c)).join(', ')}). ` +
        `For this structure these count as a risk to life, so coordinated SPDs matter more than the LPS itself` +
        (cut != null ? `: SPDs at LPL III–IV alone cut R<sub>1</sub> by ${cut}%.` : '.');
    } else if (top && top.value > 0) {
      why = `<b>Largest contributor:</b> ${this._code(top.code)}, ${this.FRIENDLY[top.code] || escHtml(top.description)} (${Math.round(top.share_pct)}% of R<sub>1</sub>).`;
    }
    if (why) h += `<div class="lr-why">${why}</div>`;

    // Components
    h += `<div class="lr-sec-h"><span>What makes up R<sub>1</sub></span> <span class="lr-hp lr-inline">Each risk component, largest first, in units of 10⁻⁵ per year.</span></div>
      <table class="lr-tbl"><thead><tr><th style="width:52px">Part</th><th>Cause</th><th class="num" style="width:80px">×10⁻⁵/yr</th><th style="width:160px">Share</th><th class="num" style="width:52px"></th></tr></thead><tbody>`;
    for (const c of comps) {
      h += `<tr><td class="lr-code">${this._code(c.code)}</td><td>${this.FRIENDLY[c.code] || escHtml(c.description)}</td>
        <td class="num">${f2(c.value)}</td><td><div class="lr-bar"><span style="width:${Math.max(0.8, c.share_pct).toFixed(1)}%"></span></div></td>
        <td class="num lr-muted">${c.share_pct.toFixed(1)}%</td></tr>`;
    }
    h += '</tbody></table>';

    // Protection options
    if (opts.length) {
      h += `<div class="lr-sec-h"><span>Protection options, lightest first</span> <span class="lr-hp lr-inline">R<sub>1</sub> with each combination installed.</span></div>
        <table class="lr-tbl"><thead><tr><th>Protection measures</th><th class="num" style="width:110px">R<sub>1</sub> ×10⁻⁵/yr</th><th class="num" style="width:90px">vs R<sub>T</sub></th><th style="width:74px">Result</th></tr></thead><tbody>`;
      for (const o of opts) {
        const isRec = rec && o === rec;
        h += `<tr class="${o.compliant ? 'ok' : ''}${isRec ? ' rec' : ''}"><td>${escHtml(this._cap(o.label))}${isRec ? ' <span class="lr-min">Minimum that meets R<sub>T</sub></span>' : ''}</td>
          <td class="num">${f2(o.r1)}</td><td class="num">${(o.r1 / RT).toFixed(o.r1 / RT < 10 ? 2 : 1)} ×</td>
          <td class="lr-res">${o.compliant ? 'Meets' : 'Exceeds'}</td></tr>`;
      }
      h += '</tbody></table>';
    }

    // Strike frequency recap + basis
    h += `<div class="lr-facts"><span>A<sub>D</sub> ${Math.round(res.collection_area_m2).toLocaleString()} m²</span>
      <span>N<sub>D</sub> ${res.flashes_to_structure_per_year.toExponential(2)} /yr</span>
      <span>A<sub>M</sub> ${Math.round(res.collection_area_near_m2).toLocaleString()} m²</span>
      <span>N<sub>M</sub> ${res.flashes_near_structure_per_year.toFixed(2)} /yr</span></div>
      <details class="lr-basis" open><summary>Basis and simplifications</summary><ul>
        <li>IEC 62305-2:2010 (Ed. 2), risk R<sub>1</sub> (loss of human life), tolerable risk R<sub>T</sub> = ${this._sci(RT)} per year (Table 4). Loss values from the typical means in Annex C. The current edition is IEC 62305-2:2024.</li>
        <li>One structure assessed as a single zone. Strikes on adjacent structures are not included (N<sub>DJ</sub> = 0).</li>
        <li>No spatial-shielding credit (K<sub>S1</sub> = K<sub>S2</sub> = 1) and unshielded internal wiring (K<sub>S3</sub> = 1): conservative.</li>
        <li>R<sub>C</sub>, R<sub>M</sub>, R<sub>W</sub> and R<sub>Z</sub> are included only where failure of internal systems endangers life (hospitals, or a risk of explosion)${res.systems_life_risk ? ': included here' : ': not included here'}.</li>
        <li>R<sub>2</sub> (public service), R<sub>3</sub> (cultural heritage) and R<sub>4</sub> (economic) are not assessed.</li>
      </ul></details>`;
    return h;
  },
  // IEC 62305-2:2024: R per zone against R_T, F per zone against F_T.
  renderResults2024(res) {
    const RT = res.tolerable_r1 || 1e-5;
    const zones = res.zones || [];
    const gov = zones.find(z => z.name === res.governing_zone) || zones[0] || { components: [] };
    const opts = res.options || [];
    const rec = opts.find(o => o.compliant) || null;
    const recF = opts.find(o => o.compliant && o.frequency_compliant) || null;
    const f2 = (v) => (v * 1e5).toFixed(3);
    const fz = zones.filter(z => z.has_systems);
    const fWorst = fz.reduce((m, z) => (!m || z.frequency / z.tolerable_frequency > m.frequency / m.tolerable_frequency ? z : m), null);
    let h = '';
    for (const w of res.warnings || []) h += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
    const times = res.r1 / RT;
    const verdict = res.compliant
      ? `<div class="lr-v lr-v-ok" role="status"><span class="lr-v-k">Risk within the tolerable value</span>
          <span class="lr-v-big">R = ${this._sci(res.r1)} <small>per year</small></span>
          <span class="lr-v-t">Highest zone (${escHtml(gov.name)}) is ${times < 0.1 ? 'well below' : (times * 100).toFixed(0) + '% of'} R<sub>T</sub> = ${this._sci(RT)} per year.</span></div>`
      : `<div class="lr-v lr-v-bad" role="status"><span class="lr-v-k">Risk exceeds the tolerable value</span>
          <span class="lr-v-big">R = ${this._sci(res.r1)} <small>per year</small></span>
          <span class="lr-v-t">In ${escHtml(gov.name)}: <b>${times >= 10 ? Math.round(times) : times.toFixed(1)} times</b> R<sub>T</sub> = ${this._sci(RT)} per year. Lightning protection is required.</span></div>`;
    let recCard = '';
    if (!res.compliant) {
      recCard = rec
        ? `<div class="lr-v lr-v-rec"><span class="lr-v-k">Lightest protection that meets R<sub>T</sub></span>
            <span class="lr-v-name">${escHtml(this._cap(rec.label))}</span>
            <span class="lr-v-t">Brings R down to <b>${this._sci(rec.r1)} per year</b> in the highest zone (${(rec.r1 / RT).toFixed(2)} × R<sub>T</sub>).</span></div>`
        : `<div class="lr-v lr-v-bad"><span class="lr-v-k">No listed combination is enough</span>
            <span class="lr-v-t">${escHtml(res.recommendation || '')}</span></div>`;
    }
    h += `<div class="lr-verdict${recCard ? '' : ' single'}">${verdict}${recCard}</div>`;
    if (fz.length) {
      const ok = res.frequency_compliant;
      h += `<div class="lr-why"><b>Frequency of damage to internal systems:</b> ` +
        (fWorst ? `F = ${fWorst.frequency.toFixed(fWorst.frequency < 0.01 ? 4 : 3)} per year in ${escHtml(fWorst.name)} against F<sub>T</sub> = ${fWorst.tolerable_frequency} per year — ` : '') +
        (ok ? 'within the tolerable value.' : `<b>too high</b>. ${escHtml(res.frequency_recommendation || '')}`) + `</div>`;
    }
    // zones
    h += `<div class="lr-sec-h"><span>Risk zones</span> <span class="lr-hp lr-inline">R is compared with R<sub>T</sub> in each zone (7.3). Units of 10⁻⁵ per year for R.</span></div>
      <table class="lr-tbl"><thead><tr><th>Zone</th><th class="num" style="width:90px">R ×10⁻⁵</th><th class="num" style="width:110px">of which life</th><th class="num" style="width:90px">F / yr</th><th style="width:90px">Result</th></tr></thead><tbody>`;
    for (const z of zones) {
      const bad = !z.compliant || !z.frequency_compliant;
      h += `<tr class="${bad ? 'lr-zone-bad' : 'ok'}"><td>${escHtml(z.name)}</td><td class="num">${f2(z.risk)}</td>
        <td class="num lr-muted">${f2(z.risk_life)}</td>
        <td class="num">${z.has_systems ? z.frequency.toFixed(z.frequency < 0.01 ? 4 : 3) + ' <span class="lr-muted">/ ' + z.tolerable_frequency + '</span>' : '—'}</td>
        <td class="lr-res">${z.compliant ? (z.frequency_compliant ? 'Meets' : 'F too high') : 'R too high'}</td></tr>`;
    }
    h += '</tbody></table>';
    // components of the governing zone
    const comps = (gov.components || []).filter(c => c.value > 0).sort((a, b) => b.value - a.value);
    h += `<div class="lr-sec-h"><span>What makes up R in ${escHtml(gov.name)}</span> <span class="lr-hp lr-inline">Largest first. Loss of life (L1) and physical damage (L2) are summed (eq. 6).</span></div>
      <table class="lr-tbl"><thead><tr><th style="width:52px">Part</th><th>Cause</th><th class="num" style="width:80px">×10⁻⁵/yr</th><th style="width:160px">Share</th><th class="num" style="width:52px"></th></tr></thead><tbody>`;
    for (const c of comps) {
      h += `<tr><td class="lr-code">${this._codeAny(c.code)}</td><td>${this.FRIENDLY[c.code] || escHtml(c.description)}</td>
        <td class="num">${f2(c.value)}</td><td><div class="lr-bar"><span style="width:${Math.max(0.8, c.share_pct).toFixed(1)}%"></span></div></td>
        <td class="num lr-muted">${c.share_pct.toFixed(1)}%</td></tr>`;
    }
    h += '</tbody></table>';
    if (opts.length) {
      h += `<div class="lr-sec-h"><span>Protection options, lightest first</span> <span class="lr-hp lr-inline">For each LPS class, the lightest SPDs that meet R<sub>T</sub>. An LPS includes its bonding SPDs at the entrance.</span></div>
        <table class="lr-tbl"><thead><tr><th>Protection measures</th><th class="num" style="width:100px">R ×10⁻⁵/yr</th><th class="num" style="width:70px">vs R<sub>T</sub></th><th class="num" style="width:80px">F / yr</th><th style="width:74px">Result</th></tr></thead><tbody>`;
      for (const o of opts) {
        const isRec = rec && o === rec, isRecF = recF && o === recF && recF !== rec;
        h += `<tr class="${o.compliant ? 'ok' : ''}${isRec ? ' rec' : ''}"><td>${escHtml(this._cap(o.label))}${isRec ? ' <span class="lr-min">Lightest that meets R<sub>T</sub></span>' : ''}${isRecF ? ' <span class="lr-min">Lightest that also meets F<sub>T</sub></span>' : ''}</td>
          <td class="num">${f2(o.r1)}</td><td class="num">${(o.r1 / RT).toFixed(o.r1 / RT < 10 ? 2 : 1)} ×</td>
          <td class="num">${fz.length ? o.frequency.toFixed(o.frequency < 0.01 ? 4 : 3) : '—'}</td>
          <td class="lr-res">${o.compliant ? (o.frequency_compliant ? 'Meets' : 'R only') : 'Exceeds'}</td></tr>`;
      }
      h += '</tbody></table>';
    }
    const ev = (res.lines_events || []).map(l => `<span>N<sub>L</sub> ${escHtml(l.name)} ${l.nl.toExponential(2)} /yr</span>`).join('');
    h += `<div class="lr-facts"><span>A<sub>D</sub> ${Math.round(res.collection_area_m2).toLocaleString()} m²</span>
      <span>N<sub>D</sub> ${res.flashes_to_structure_per_year.toExponential(2)} /yr</span>
      <span>A<sub>M</sub> ${Math.round(res.collection_area_near_m2).toLocaleString()} m²</span>
      <span>N<sub>M</sub> ${res.flashes_near_structure_per_year.toFixed(3)} /yr</span>${ev}</div>
      <details class="lr-basis" open><summary>Basis and simplifications</summary><ul>
        ${this.BASIS_2024.map(b => `<li>${b}</li>`).join('')}
      </ul></details>`;
    return h;
  },
  BASIS_2024: [
    'IEC 62305-2:2024 (Ed. 3): risk R = R<sub>L1</sub> + R<sub>L2</sub> (loss of human life plus physical damage, eq. 6–8) per risk zone against R<sub>T</sub>; frequency of damage F = F<sub>C</sub> + F<sub>M</sub> + F<sub>W</sub> + F<sub>Z</sub> (eq. 12) against F<sub>T</sub>.',
    'Loss values: the highest of each range in Table C.2 for the chosen loss class, as the standard recommends.',
    'Protection measures for strikes to the building (touch protection, fire provisions, coordinated SPDs on P<sub>C</sub>) count only with an LPS or a natural-LPS frame (Table 2 note h); an installed LPS sets P<sub>S</sub> = 1 (Table B.4 Note 1).',
    'Not assessed: thunderstorm warning systems (P<sub>TWS</sub> = 1), adjacent structures (N<sub>DJ</sub> = 0), environmental loss L<sub>E</sub> (Annex E). Each line is taken as separately routed (8.2), which is conservative.',
    'Engine verified against the standard’s Annex F examples: house, office building and hospital, unprotected and protected.',
  ],
  _cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); },

  close() {
    this.saveInputs();
    this._el('lightning-modal').style.display = 'none';
  },

  init() {
    const modal = this._el('lightning-modal');
    if (!modal) return;
    modal.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-lr-target] [data-value]');
      if (opt) {
        const group = opt.closest('[data-lr-target]');
        this._el(group.dataset.lrTarget).value = opt.dataset.value;
        this.syncChoices();
        this.updateLive();
        this._scheduleSave();
        return;
      }
      const go = e.target.closest('[data-lr-go]');
      if (go && !go.disabled) { this.go(+go.dataset.lrGo); return; }
    });
    // Arrow keys move within a radio group of cards / segments.
    modal.addEventListener('keydown', (e) => {
      const opt = e.target.closest('[data-lr-target] [data-value]');
      if (!opt || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const items = [...opt.closest('[data-lr-target]').querySelectorAll('[data-value]')];
      const i = items.indexOf(opt) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
      const next = items[(i + items.length) % items.length];
      next.click(); next.focus();
    });
    modal.addEventListener('input', (e) => {
      if (e.target.id === 'lr-assess-select') return;
      this.updateLive(); this._scheduleSave();
    });
    modal.addEventListener('change', (e) => {
      if (e.target.id === 'lr-assess-select') {
        this.saveInputs();
        AppState.lightningActiveId = e.target.value;
        this.loadActive();
        return;
      }
      if (/lr-line\d-en/.test(e.target.id)) this.syncLines();
      this.updateLive();
      this._scheduleSave();
    });
    this._el('lr-assess-new').addEventListener('click', () => this._newAssessment(false));
    this._el('lr-assess-dup').addEventListener('click', () => this._newAssessment(true));
    this._el('lr-assess-rename').addEventListener('click', () => this._rename());
    this._el('lr-assess-del').addEventListener('click', () => this._delete());
    this._el('lr-export').addEventListener('click', () => LightningReport.export());
    this._el('lightning-results').addEventListener('click', (e) => {
      if (e.target.closest('[data-lr-rerun]')) this._el('btn-run-lightning').click();
    });
    this._el('lr-next').addEventListener('click', () => this.go(Math.min(4, this.step + 1)));
    this._el('lr-back').addEventListener('click', () => this.go(this.step === 5 ? 1 : Math.max(1, this.step - 1)));
    this._el('lr-cancel').addEventListener('click', () => this.close());
  },
};

// ── PDF report of one assessment (jsPDF + autoTable, as the other reports) ──
const LightningReport = {
  // jsPDF's built-in Helvetica is WinAnsi: no sub/superscripts, no ⁻ or Greek.
  // Keep ² ³ (they exist) and write other exponents as ^-5.
  _t(s) {
    const map = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };
    return String(s == null ? '' : s)
      .replace(/<sub>(.*?)<\/sub>/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, run => (/^[²³]$/.test(run) ? run : '^' + [...run].map(c => map[c]).join('')))
      .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/Ω/g, 'ohm').replace(/[‹›]/g, '');
  },
  _sci(v) {
    if (!v) return '0';
    const e = Math.floor(Math.log10(Math.abs(v)));
    const m = v / 10 ** e;
    return `${m.toFixed(m < 9.95 ? 1 : 0)} × 10^${e}`;
  },
  // Human label for a stored value, read from the dialog's own cards/options
  // so the report always says exactly what the form says.
  _choice(target, value) {
    const card = document.querySelector(`#lightning-modal [data-lr-target="${target}"] [data-value="${CSS.escape(String(value))}"]`);
    if (card) {
      const t = card.querySelector('.lr-card-t'), f = card.querySelector('.lr-card-f');
      return (t ? t.textContent : card.textContent).trim() + (f ? ` (${f.textContent.trim()})` : '');
    }
    const opt = document.querySelector(`#${target} option[value="${CSS.escape(String(value))}"]`);
    return opt ? opt.textContent.trim() : String(value);
  },

  async export() {
    const a = LightningUI.current();
    if (!a || !a.result) { await UI.alert('Run the assessment first: the report needs a result.'); return; }
    if (LightningUI.isStale(a)) {
      const ok = await UI.confirm('The inputs have changed since this result was calculated. The report would show the old result with the new inputs.\n\nRe-assess first, or export the last result anyway?',
        { okText: 'Export anyway', cancelText: 'Cancel' });
      if (!ok) return;
    }
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    LightningUI.saveInputs();
    const p = a.inputs, res = a.result, RT = res.tolerable_r1 || 1e-5;
    const ed24 = res.edition === '2024';
    const u = p.ui24 || {};
    const t = (s) => this._t(s);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const M = 14, W = 210 - 2 * M;
    const proj = AppState.projectName || 'Untitled Project';
    const d = AppState.projectDetails || {};
    const blue = [0, 120, 215];
    const tbl = (opts) => doc.autoTable(Object.assign({
      margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' },
      headStyles: { fillColor: blue, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 247, 249] },
    }, opts));
    const next = (gap = 6) => (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + gap;
    const heading = (txt, at) => {
      let yy = at;
      if (yy > 270) { doc.addPage(); yy = M + 4; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(26, 26, 46);
      doc.text(t(txt), M, yy);
      return yy + 2;
    };

    // ── Title ──
    let y = M + 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 26, 46);
    doc.text('Lightning Risk Assessment', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90, 97, 112);
    const sub = doc.splitTextToSize(ed24
      ? `IEC 62305-2:2024 · risk R (loss of life + physical damage) per zone against RT = ${this._sci(RT)} per year, and frequency of damage F`
      : `IEC 62305-2:2010 · risk of loss of human life (R1) against the tolerable risk RT = ${this._sci(RT)} per year`, W);
    doc.text(sub, M, y + 6);
    y += (sub.length - 1) * 4.2;
    const info = [['Project', proj], ['Assessment', a.name]];
    if (d.projectNumber) info.push(['Project number', d.projectNumber]);
    if (d.client) info.push(['Client', d.client]);
    if (d.engineerName) info.push(['Engineer', d.engineerName]);
    if (d.checkedBy) info.push(['Checked by', d.checkedBy]);
    info.push(['Calculated', a.resultAt ? new Date(a.resultAt).toLocaleString() : '—'], ['Report date', new Date().toLocaleDateString()]);
    tbl({ startY: y + 10, body: info.map(r => r.map(t)), theme: 'plain', styles: { fontSize: 9, cellPadding: 1.2 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38, textColor: [90, 97, 112] } } });

    // ── Verdict ──
    y = next(6);
    const times = res.r1 / RT;
    const rec = (res.options || []).find(o => o.compliant);
    const R = ed24 ? 'R' : 'R1';
    const verdictLines = [
      `${res.compliant ? 'WITHIN' : 'EXCEEDS'} THE TOLERABLE RISK`,
      `${R} = ${this._sci(res.r1)} per year${ed24 ? ` (highest zone: ${res.governing_zone})` : ''}: ${times >= 10 ? Math.round(times) : times.toFixed(2)} × the tolerable risk RT = ${this._sci(RT)} per year.`,
      res.compliant ? (ed24 ? 'No further protection is needed for the risk.' : 'No further protection is needed for risk to life.')
        : rec ? `Lightest protection that meets RT: ${LightningUI._cap(rec.label)}, giving ${R} = ${this._sci(rec.r1)} per year (${(rec.r1 / RT).toFixed(2)} × RT).`
          : `No combination on the protection ladder reaches RT. ${res.recommendation || ''}`,
      ...(ed24 && (res.zones || []).some(z => z.has_systems) ? [`Frequency of damage: ${res.frequency_recommendation || ''}`] : []),
    ];
    const body = doc.splitTextToSize(verdictLines.slice(1).join(' '), W - 8);
    const boxH = 10 + body.length * 4.4;
    doc.setDrawColor(...(res.compliant ? [46, 125, 50] : [198, 40, 40]));
    doc.setFillColor(...(res.compliant ? [237, 247, 238] : [253, 237, 237]));
    doc.roundedRect(M, y, W, boxH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.setTextColor(...(res.compliant ? [30, 107, 36] : [179, 38, 30]));
    doc.text(verdictLines[0], M + 4, y + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(26, 26, 46);
    doc.text(body, M + 4, y + 11.5);
    y += boxH + 7;
    doc.lastAutoTable.finalY = y - 6;

    // ── Inputs ──
    y = heading('Inputs', next(6));
    const line = (l) => l ? [
      `${t(l.name)}: length ${l.length_m} m, ${l.installation}, ${t(this._choice(l.type === 'power' ? 'lr-line1-env' : 'lr-line2-env', l.environment))}` +
      (l.type === 'power' ? (l.has_transformer ? ', HV/LV transformer at the building end (CT = 0.2)' : ', no transformer')
        : `, ${this._choice('lr-line2-screen', l.screen || (l.shielded ? 'bonded_rs_le1' : 'unshielded'))}`),
    ] : null;
    const power = (p.lines || []).find(l => l.type === 'power');
    const tel = (p.lines || []).find(l => l.type === 'telecom');
    const sect = (name) => [{ content: name, colSpan: 3, styles: { fontStyle: 'bold', fillColor: [232, 240, 250], textColor: [18, 69, 122] } }];
    const rows = ed24 ? [
      sect('1 · Structure & site'),
      ['Edition', '', 'IEC 62305-2:2024 (Ed. 3)'],
      ['Length × width × height', 'L, W, H', `${p.length_m} × ${p.width_m} × ${p.height_m} m`],
      [u.dens === 'nsg' ? 'Strike-point density' : 'Flash density (NSG = k × NG)', u.dens === 'nsg' ? 'NSG' : 'NG, k',
        `${p.ground_flash_density} / km² / yr, k = ${u.k || 2}`],
      ['Surroundings', 'CD', t(this._choice('lr-location', p.location))],
      ['Construction', 'PS', t(this._choice('lr24-constr', u.constr || 'masonry'))],
      sect('2 · People & fire'),
      ['Loss class', 'LF, LO', t(this._choice('lr24-loss', u.loss || 'normal'))],
      ['Failure of internal systems endangers life', '', u.life ? 'Yes' : 'No'],
      ['Hours occupied per year', 'tz', `${p.hours_per_year} h`],
      ['Fire risk', 'rf', t(u.expl && u.expl !== 'none' ? this._choice('lr24-expl', u.expl) : this._choice('lr-fire-risk', p.fire_risk))],
      ['Fire protection', 'rp', t(this._choice('lr-fire-prot', p.fire_protection)) + (u.liion ? ' — lithium-ion storage, no credit' : '')],
      ['Floor surface', 'rt', t(this._choice('lr-floor', p.floor_type))],
      ['Touch and step protection', 'Pam', t(this._choice('lr24-touch', u.touch || 'none'))],
      ['Exposed zone (roof / outside)', 'tz, PO', u.expEn ? `${u.expHours || 0} h / yr${u.expDirect ? ', exposed to direct strikes' : ''}` : 'None'],
      sect('3 · Service lines and internal systems'),
      ['Power supply line', 'LL, CI, CE, CT', power ? t(`${power.length_m} m LV, ${power.installation}, ${this._choice('lr-line1-env', power.environment)}` +
        (u.l1Hv ? ` + ${u.l1HvLen || 1000} m HV via an HV/LV transformer` : '') + `, ${this._choice('lr-line1-screen', power.screen || 'unshielded')}`) : 'Not connected'],
      ['Telecom line', 'LL, CI, CE', tel ? t(`${this._choice('lr24-l2-kind', u.l2Kind || 'copper')}` + (u.l2Kind === 'copper' || !u.l2Kind ? `, ${tel.length_m} m, ${tel.installation}, ${this._choice('lr-line2-screen', tel.screen || 'unshielded')}` : '')) : 'Not connected'],
      ['Power equipment', 'UW, KS3', power ? t(`${u.uwp || 2.5} kV, ${this._choice('lr24-ks3p', u.ks3p || 'different_routing')}`) : '—'],
      ['Telecom equipment', 'UW, KS3', tel && u.l2Kind !== 'fibre' ? t(`${u.uwt || 1.5} kV, ${this._choice('lr24-ks3t', u.ks3t || 'different_routing')}`) : '—'],
      sect('4 · Existing protection'),
      ['Lightning protection system', 'PLPS', t(this._choice('lr-lps', p.lps_class))],
      ['Entrance SPDs (bonding)', 'PEB', t(this._choice('lr24-eb', u.eb || 'none'))],
      ['Coordinated surge protection', 'PSPD', t(this._choice('lr-spd', p.spd_level))],
      ['Tolerable values', 'RT, FT', `RT = ${this._sci(RT)} / yr, FT = ${u.ft || 0.1} / yr`],
    ] : [
      sect('1 · Structure & site'),
      ['Length × width × height', 'L, W, H', `${p.length_m} × ${p.width_m} × ${p.height_m} m`],
      ['Lightning ground flash density', 'NG', `${p.ground_flash_density} flashes / km² / yr`],
      ['Surroundings', 'CD', t(this._choice('lr-location', p.location))],
      sect('2 · People & fire'),
      ['Type of structure', 'LF', t(this._choice('lr-use', p.structure_use))],
      ['People in the structure', 'nz', String(p.persons_in_zone)],
      ['Hours occupied per year', 'tz', `${p.hours_per_year} h`],
      ['Panic / evacuation', 'hz', t(this._choice('lr-hazard', p.hazard_level))],
      ['Fire risk', 'rf', t(this._choice('lr-fire-risk', p.fire_risk))],
      ['Fire protection', 'rp', t(this._choice('lr-fire-prot', p.fire_protection))],
      ['Floor surface', 'rt', t(this._choice('lr-floor', p.floor_type))],
      ['Risk of explosion', '', p.explosion_risk ? 'Yes' : 'No'],
      sect('3 · Service lines'),
      ['Power supply line', 'LL, CI, CE, CT', power ? t(line(power)[0]) : 'Not connected'],
      ['Telecom line', 'LL, CI, CE', tel ? t(line(tel)[0]) : 'Not connected'],
      ['Impulse withstand of equipment inside', 'UW', t(this._choice('lr-uw', String(p.equipment_withstand_kv)))],
      sect('4 · Existing protection'),
      ['Lightning protection system', 'PB', t(this._choice('lr-lps', p.lps_class))],
      ['Coordinated surge protection', 'PSPD', t(this._choice('lr-spd', p.spd_level))],
    ];
    tbl({ startY: y + 1, head: [['Input', 'Symbol', 'Value']], body: rows,
      columnStyles: { 0: { cellWidth: 62 }, 1: { cellWidth: 24, textColor: [90, 97, 112], fontStyle: 'italic' } } });

    // ── Strike frequency ──
    y = heading('Strike frequency', next(8));
    const nd = res.flashes_to_structure_per_year;
    tbl({ startY: y + 1, head: [['Quantity', 'Value', 'Meaning']], body: [
      ['Collection area AD', `${Math.round(res.collection_area_m2).toLocaleString()} m²`, 'The building plus a band of 3H around it'],
      ['Direct strikes ND', `${nd.toExponential(2)} / yr`, nd > 0 ? `About one direct strike every ${t(LightningUI._years(1 / nd))}` : ''],
      ['Area for nearby strikes AM', `${Math.round(res.collection_area_near_m2).toLocaleString()} m²`, ed24 ? 'Band r_M = 350/U_W around the building' : 'Within 500 m of the building'],
      ['Nearby strikes NM', `${res.flashes_near_structure_per_year.toFixed(2)} / yr`, 'Induce surges in internal wiring'],
    ], columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 36, halign: 'right' } } });

    // ── Risk zones (2024) ──
    if (ed24) {
      y = heading('Risk zones (R in units of 10^-5 per year)', next(8));
      tbl({ startY: y + 1, head: [['Zone', 'R', 'of which life (L1)', 'F / yr', 'FT', 'Result']],
        body: (res.zones || []).map(z => [t(z.name), (z.risk * 1e5).toFixed(3), (z.risk_life * 1e5).toFixed(3),
          z.has_systems ? z.frequency.toFixed(4) : '—', z.has_systems ? String(z.tolerable_frequency) : '—',
          z.compliant ? (z.frequency_compliant ? 'Meets' : 'F too high') : 'R too high']),
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } } });
    }

    // ── Risk components ──
    y = heading(ed24 ? `What makes up R in ${res.governing_zone} (units of 10^-5 per year)` : 'What makes up R1 (units of 10^-5 per year)', next(8));
    const comps = (res.components || [])
      .filter(c => !(c.value === 0 && !res.systems_life_risk && LightningUI.INTERNAL.includes(c.code)))
      .sort((x, z) => z.value - x.value);
    tbl({ startY: y + 1, head: [['Part', 'Cause', '×10^-5/yr', 'Share']],
      body: comps.filter(c => !ed24 || c.value > 0).map(c => [c.code, t(LightningUI.FRIENDLY[c.code] || c.description), (c.value * 1e5).toFixed(ed24 ? 3 : 2), `${c.share_pct.toFixed(1)}%`]),
      columnStyles: { 0: { cellWidth: 14, fontStyle: 'bold' }, 2: { cellWidth: 24, halign: 'right' }, 3: { cellWidth: 18, halign: 'right' } } });

    // ── Protection options ──
    y = heading('Protection options, lightest first', next(8));
    tbl({ startY: y + 1, head: [[ 'Protection measures', `${R} ×10^-5/yr`, 'vs RT', ed24 ? 'F / yr' : 'Result', ...(ed24 ? ['Result'] : [])]],
      body: (res.options || []).map(o => [
        t(LightningUI._cap(o.label)) + (o === rec ? '  (lightest that meets RT)' : ''),
        (o.r1 * 1e5).toFixed(ed24 ? 3 : 2), `${(o.r1 / RT).toFixed(2)} ×`,
        ...(ed24 ? [o.frequency.toFixed(4), o.compliant ? (o.frequency_compliant ? 'Meets' : 'R only') : 'Exceeds']
          : [o.compliant ? 'Meets' : 'Exceeds'])]),
      columnStyles: { 1: { cellWidth: 26, halign: 'right' }, 2: { cellWidth: 20, halign: 'right' }, 3: { cellWidth: 18 } },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const o = (res.options || [])[data.row.index];
        if (o && o.compliant) { data.cell.styles.fillColor = [237, 247, 238]; if (o === rec) data.cell.styles.fontStyle = 'bold'; }
        if (data.column.index === (ed24 ? 4 : 3)) data.cell.styles.textColor = o && o.compliant ? [30, 107, 36] : [179, 38, 30];
      } });

    // ── Basis ──
    y = heading('Basis and simplifications', next(8));
    const basis = [
      ...(ed24 ? LightningUI.BASIS_2024.map(t) : [
        `IEC 62305-2:2010 (Ed. 2), risk R1 (loss of human life), tolerable risk RT = ${this._sci(RT)} per year (Table 4). Loss values from the typical means in Annex C. The current edition is IEC 62305-2:2024.`,
        'One structure assessed as a single zone. Strikes on adjacent structures are not included (NDJ = 0).',
        'No spatial-shielding credit (KS1 = KS2 = 1) and unshielded internal wiring (KS3 = 1): conservative.',
        `RC, RM, RW and RZ are included only where failure of internal systems endangers life (hospitals, or a risk of explosion): ${res.systems_life_risk ? 'included here' : 'not included here'}.`,
        'R2 (public service), R3 (cultural heritage) and R4 (economic) are not assessed.',
      ]),
      ...((res.warnings || []).map(w => 'Note: ' + t(w))),
    ];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(59, 65, 80);
    y += 3;
    for (const b of basis) {
      const lines = doc.splitTextToSize('•  ' + b, W);
      if (y + lines.length * 3.8 > 285) { doc.addPage(); y = M + 4; }
      doc.text(lines, M, y); y += lines.length * 3.8 + 1;
    }

    // ── Footer on every page ──
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFontSize(7.5); doc.setTextColor(120, 126, 138);
      doc.text(t(`ProtectionPro · Lightning risk assessment · ${proj} · ${a.name}`), M, 292);
      doc.text(`Page ${i} of ${n}`, 210 - M, 292, { align: 'right' });
    }
    const safe = (s) => String(s).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
    doc.save(`${safe(proj)}_${safe(a.name)}_lightning_risk.pdf`);
    const st = document.getElementById('status-info');
    if (st) st.textContent = `Lightning risk report exported: ${a.name}.`;
  },
};
