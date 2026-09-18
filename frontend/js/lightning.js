/* ProtectionPro — Lightning risk assessment dialog (IEC 62305-2).
 *
 * A guided four-step dialog (structure & site → people & fire → service lines
 * → existing protection) with a live estimate of the strike frequency, and a
 * verdict-first results page. Every input keeps its original element id, so the
 * request built by app.js (collectLightningParams / restoreLightningParams) and
 * the inputs saved with the project are unchanged: option cards and segmented
 * buttons write into a hidden input carrying that id.
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
  },
  DEFAULT_CHECKS: { 'lr-explosion': false, 'lr-line1-en': true, 'lr-line1-tx': true, 'lr-line2-en': false, 'lr-line2-shield': false },
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
  updateLive() {
    const n = (id) => parseFloat((this._el(id) || {}).value) || 0;
    const L = n('lr-length'), W = n('lr-width'), H = n('lr-height'), NG = n('lr-ng');
    const cd = this.CD[(this._el('lr-location') || {}).value] || 1;
    const ad = L * W + 2 * (3 * H) * (L + W) + Math.PI * (3 * H) ** 2;
    const am = 2 * 500 * (L + W) + Math.PI * 500 ** 2;
    const nd = NG * ad * cd * 1e-6;
    const nm = NG * am * 1e-6;
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
    this._el('lr-head-sub').textContent = this.STEP_SUBS[step];
    this._el('lr-foot-pg').textContent = step === 5 ? 'Inputs are saved with the project' : `Step ${step} of 4 · inputs are saved with the project`;
    this._el('lr-back').hidden = step === 1;
    this._el('lr-back').textContent = step === 5 ? '‹ Edit inputs' : '‹ Back';
    this._el('lr-next').hidden = step >= 4;
    this._el('btn-run-lightning').hidden = step !== 4;
    const main = document.querySelector('#lightning-modal .lr-main');
    if (main) main.scrollTop = 0;
  },

  open() {
    this.syncChoices();
    this.updateLive();
    this.go(1);
  },

  // ── Results ────────────────────────────────────────────────────────
  FRIENDLY: {
    RA: 'Shock from touch / step voltage, strike <b>on the building</b>',
    RB: 'Fire, strike <b>on the building</b>',
    RC: 'Surge damages internal systems, strike on the building',
    RM: 'Surge damages internal systems, strike <b>near the building</b>',
    RU: 'Shock from touch voltage, strike <b>on a line</b>',
    RV: 'Fire, strike <b>on a line</b>',
    RW: 'Surge damages internal systems, strike on a line',
    RZ: 'Surge damages internal systems, strike <b>near a line</b>',
  },
  INTERNAL: ['RC', 'RM', 'RW', 'RZ'],

  // 7.3e-4 → "7.3 × 10⁻⁴"
  _sci(v) {
    if (!v) return '0';
    const e = Math.floor(Math.log10(Math.abs(v)));
    const m = v / 10 ** e;
    const sup = String(e).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    return `${m.toFixed(m < 9.95 ? 1 : 0)} × 10${sup}`;
  },
  _code(c) { return `R<sub>${escHtml(String(c).replace(/^R/, ''))}</sub>`; },

  showResults(res) {
    this._el('lightning-results').innerHTML = this.renderResults(res);
    this.go(5);
  },
  showError(msg) {
    this._el('lightning-results').innerHTML = `<div class="af-warning-item">⚠ ${escHtml(msg)}</div>`;
    this.go(5);
  },

  renderResults(res) {
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
          <span class="lr-v-t">That is ${times < 0.1 ? 'well below' : (times * 100).toFixed(0) + '% of'} the tolerable limit R<sub>T</sub> = 1 × 10⁻⁵ per year. No further protection is needed for risk to life.</span></div>`
      : `<div class="lr-v lr-v-bad" role="status"><span class="lr-v-k">Exceeds the tolerable risk</span>
          <span class="lr-v-big">R<sub>1</sub> = ${this._sci(res.r1)} <small>per year</small></span>
          <span class="lr-v-t">That is <b>${times >= 10 ? Math.round(times) : times.toFixed(1)} times</b> the tolerable limit R<sub>T</sub> = 1 × 10⁻⁵ per year. Lightning protection is required for this structure.</span></div>`;
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
        <li>IEC 62305-2:2010, risk R<sub>1</sub> (loss of human life), tolerable risk R<sub>T</sub> = 10⁻⁵ per year (Table 7). Loss values from the typical means in Annex C.</li>
        <li>One structure assessed as a single zone. Strikes on adjacent structures are not included (N<sub>DJ</sub> = 0).</li>
        <li>No spatial-shielding credit (K<sub>S1</sub> = K<sub>S2</sub> = 1) and unshielded internal wiring (K<sub>S3</sub> = 1): conservative.</li>
        <li>R<sub>C</sub>, R<sub>M</sub>, R<sub>W</sub> and R<sub>Z</sub> are included only where failure of internal systems endangers life (hospital / hotel / school, or a risk of explosion)${res.systems_life_risk ? ': included here' : ': not included here'}.</li>
        <li>R<sub>2</sub> (public service), R<sub>3</sub> (cultural heritage) and R<sub>4</sub> (economic) are not assessed.</li>
      </ul></details>`;
    return h;
  },
  _cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); },

  close() { this._el('lightning-modal').style.display = 'none'; },

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
    modal.addEventListener('input', () => this.updateLive());
    modal.addEventListener('change', (e) => { if (/lr-line\d-en/.test(e.target.id)) this.syncLines(); });
    this._el('lr-next').addEventListener('click', () => this.go(Math.min(4, this.step + 1)));
    this._el('lr-back').addEventListener('click', () => this.go(this.step === 5 ? 1 : Math.max(1, this.step - 1)));
    this._el('lr-cancel').addEventListener('click', () => this.close());
  },
};
