/* ProtectionPro — out-of-date study results on the single line.
 *
 * An edit no longer clears study results (AppState.invalidateResults): each
 * result carries the network signature it was computed on, and once the
 * network differs it is out of date. This module shows that on the single
 * line:
 *   · result boxes, flow arrows, overload flags and result lines of an
 *     out-of-date study are dimmed (class `res-stale`, set by the renderers
 *     through StaleResults.cls / slotFor);
 *   · a chip over the diagram — "Out of date · Re-run N studies" — re-runs
 *     every out-of-date study that was run, with the same scope and options
 *     as its last run, without opening the result dialogs.
 * Reports and arc-flash labels already leave out-of-date results out
 * (AppState.freshResult); checks that take a result as an input read it the
 * same way.
 */

const StaleResults = {
  // Result-box key prefix (Annotations) → the study's result slot.
  KEY_SLOT: {
    fault: 'faultResults', vdep: 'faultResults',
    lf: 'loadFlowResults', warn: 'loadFlowResults',
    ulf: 'unbalancedLoadFlowResults', 'ulf-warn': 'unbalancedLoadFlowResults',
    dclf: 'dcLoadFlowResults', dcsc: 'dcShortCircuitResults', dcaf: 'dcArcFlashResults',
    af: 'arcFlashResults', cs: 'cableSizingResults', ms: 'motorStartingResults',
    dynms: 'dynamicMotorResults', dc: 'dutyCheckResults', ld: 'loadDiversityResults',
    gr: 'groundingResults',
  },

  // Each study's last run options (scope, method), noted by the run paths in
  // app.js so a re-run repeats them.
  _args: {},
  noteArgs(slot, args) { this._args[slot] = args || {}; },

  // Studies the chip re-runs, in this order (fault first: others use its
  // levels). Each runner stores its result the way the menu's run does.
  RUNNERS: {
    faultResults: async (a) => {
      const bus = a.busId !== undefined ? a.busId : (AppState.faultedBusId || null);
      const type = a.type !== undefined ? a.type : (document.getElementById('fault-type')?.value || null);
      AppState.faultResults = await API.runFaultAnalysis(bus, type);
      AppState.faultedBusId = bus;
      try { AppState.faultResultsMin = await API.runFaultAnalysisMin(bus, type); }
      catch (e) { AppState.faultResultsMin = null; }
    },
    loadFlowResults: async (a) => {
      AppState.loadFlowResults = await API.runLoadFlow(a.method || document.getElementById('loadflow-method')?.value);
    },
    unbalancedLoadFlowResults: async (a) => {
      AppState.unbalancedLoadFlowResults = await API.runUnbalancedLoadFlow(a.method || document.getElementById('loadflow-method')?.value);
    },
    dcLoadFlowResults: async () => { AppState.dcLoadFlowResults = await API.runDCLoadFlow(); },
    dcShortCircuitResults: async (a) => { AppState.dcShortCircuitResults = await API.runDCShortCircuit(a.busId || null); },
    arcFlashResults: async () => { AppState.arcFlashResults = await API.runArcFlash(); },
    dcArcFlashResults: async () => { AppState.dcArcFlashResults = await API.runDCArcFlash(); },
    cableSizingResults: async () => { AppState.cableSizingResults = await API.runCableSizing(); },
    motorStartingResults: async () => { AppState.motorStartingResults = await API.runMotorStarting(); },
    dutyCheckResults: async () => { AppState.dutyCheckResults = await API.runDutyCheck(); },
    ansiFaultResults: async () => { AppState.ansiFaultResults = await API.runAnsiFaultAnalysis(); },
    loadDiversityResults: async () => { AppState.loadDiversityResults = await API.runLoadDiversity(); },
    groundingResults: async (a) => { AppState.groundingResults = await API.runGroundingAnalysis(a.busIds || null); },
  },
  // Out of date but re-run from their own screen (they need their setup).
  // faultResultsMin rides with faultResults; the Study Manager summary is a
  // record of that batch run.
  MANUAL: ['dynamicMotorResults', 'stabilityResults'],

  slotFor(key) { return this.KEY_SLOT[String(key).split(':')[0]] || null; },
  isStale(slot) { return !!slot && AppState.isResultStale(slot); },
  // ' res-stale' when the slot's result is out of date — for a class list.
  cls(slot) { return this.isStale(slot) ? ' res-stale' : ''; },

  // Out-of-date studies, split into what the chip re-runs and the rest.
  pending() {
    const auto = Object.keys(this.RUNNERS).filter(s => this.isStale(s));
    const manual = this.MANUAL.filter(s => this.isStale(s));
    return { auto, manual };
  },

  _label(slot) { return (typeof RESULT_SLOT_LABELS !== 'undefined' && RESULT_SLOT_LABELS[slot]) || slot; },

  _timer: null,
  // Redraw the chip once the current edit has finished (never mid-edit: the
  // signature must be of the finished network).
  refresh() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.render(); }, 0);
  },

  _busy: false,
  render() {
    const host = document.getElementById('canvas-container');
    if (!host) return;
    let chip = document.getElementById('stale-chip');
    const { auto, manual } = this.pending();
    const n = auto.length + manual.length;
    if (!n) { if (chip) chip.hidden = true; return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'stale-chip';
      chip.className = 'stale-chip';
      chip.setAttribute('role', 'status');
      host.appendChild(chip);
      chip.addEventListener('click', (e) => { if (e.target.closest('[data-stale-rerun]')) this.rerun(); });
    }
    chip.hidden = false;
    const names = auto.concat(manual).map(s => this._label(s));
    const tip = `Out of date after an edit: ${names.join(', ')}.`
      + (manual.length ? ` Re-run ${manual.map(s => this._label(s)).join(' and ')} from its own screen.` : '')
      + ' Out-of-date results are dimmed and left out of reports.';
    chip.title = tip;
    if (this._busy) {
      chip.innerHTML = '<span class="stale-chip-dot" aria-hidden="true"></span><span>Re-running…</span>';
      return;
    }
    chip.innerHTML = '<span class="stale-chip-dot" aria-hidden="true"></span>'
      + '<span class="stale-chip-t">Out of date</span>'
      + (auto.length
        ? `<button type="button" class="stale-chip-btn" data-stale-rerun>Re-run ${auto.length} stud${auto.length === 1 ? 'y' : 'ies'}</button>`
        : `<span class="stale-chip-sub">${escHtml(manual.map(s => this._label(s)).join(', '))} — re-run from Analyse</span>`);
  },

  // Re-run every out-of-date study the chip can run, one after another.
  async rerun() {
    if (this._busy) return;
    const { auto } = this.pending();
    if (!auto.length) return;
    this._busy = true;
    this.render();
    const status = document.getElementById('status-info');
    const failed = [];
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, `Re-running ${auto.length} stud${auto.length === 1 ? 'y' : 'ies'}…`);
    try {
      for (const slot of auto) {
        if (status) status.textContent = `Re-running ${this._label(slot)}…`;
        try { await this.RUNNERS[slot](this._args[slot] || {}); }
        catch (e) { console.error('Re-run failed:', slot, e); failed.push(this._label(slot)); }
      }
    } finally {
      this._busy = false;
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
      if (typeof Canvas !== 'undefined') Canvas.render();
      this.render();
    }
    if (status) {
      status.textContent = failed.length
        ? `Re-run finished — ${failed.join(', ')} failed; run ${failed.length === 1 ? 'it' : 'them'} from Analyse to see why.`
        : `Re-ran ${auto.length} stud${auto.length === 1 ? 'y' : 'ies'}.`;
    }
  },
};

if (typeof window !== 'undefined') window.StaleResults = StaleResults;
