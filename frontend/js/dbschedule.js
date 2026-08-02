/* ProtectionPro — Distribution Board circuit schedule editor.
 *
 * A distribution board's ways live in comp.props.circuits:
 *   { way, description, poles ('1P'|'3P'), phase ('R'|'W'|'B'|'RWB'),
 *     breaker_a, curve ('B'|'C'|'D'), el_group, load_va, demand_factor,
 *     power_factor, cable_mm2, ecc_mm2, cable_m, leakage_ma }
 *
 * TWO HOSTS, ONE RENDERER. render() writes into whatever `this.body` points
 * at, so the same grid serves both the #db-modal (quick look at one board)
 * and the full-screen Schedules workspace (every board, board rail on the
 * left). _setHost() switches between them; open()/close() drive the modal,
 * openInline()/commit() drive the workspace. Only one host may hold a
 * populated grid at a time — render() emits fixed element ids.
 *
 * The Iz / %VD / ECC result columns are filled from the backend
 * db-circuit-check engine (AppState.dbCheckResults), indexed by stable way id
 * in _resIndex and painted by _paintResults() — a text-only update that never
 * disturbs a focused cell.
 *
 * Each way carries its own power_factor; recompute() rolls them up (diversified
 * P/Q vector sum) into the board-level power_factor prop the analyses read.
 *
 * comp.props.el_ratings maps EL group name → the earth-leakage unit's rated
 * residual current IΔn in mA (default 30). Standing leakage per group
 * (Σ way leakage_ma + cable insulation leakage) is checked against
 * 30% of IΔn per IEC 60364-5-53 §531.3.2 to flag nuisance-trip risk.
 *
 * The board is analysed as a LUMPED load: on every save (and on
 * board_diversity edits) recompute() writes static-load-equivalent props
 * (rated_kva, demand_factor, phase_a/b/c_pct) that the load flow, unbalanced
 * load flow and diversity engines read exactly like a static load's.
 * SA phase convention: R→A, W→B, B→C.
 */

// Way fields stored as numbers. The grid can't infer this from input.type any
// more — cable_mm2/ecc_mm2 are text inputs so they can carry a searchable
// datalist without a number spinner — so the coercion is keyed by field name.
const NUMERIC_KEYS = new Set(['breaker_a', 'leakage_ma', 'cable_mm2', 'ecc_mm2',
  'cable_m', 'load_va', 'demand_factor', 'power_factor']);

const DBSchedule = {
  modal: null,
  body: null,             // the ACTIVE host container (modal body or workspace grid)
  _modalBody: null,       // #db-modal-body, cached at init
  mode: 'modal',          // 'modal' | 'workspace'
  currentId: null,
  _openCommitted: null,   // JSON of the committed fields at open time
  _openDerived: null,     // derived lumped-load props at open time (pre-render)
  _selected: new Set(),   // way ids checked for bulk editing (stable across sort/render)
  _resIndex: null,        // Map(way id → backend check row), or null before any run

  // Lumped-load props recompute() derives from the committed fields
  _DERIVED_KEYS: ['rated_kva', 'demand_factor', 'power_factor', 'phase_a_pct',
    'phase_b_pct', 'phase_c_pct', 'phase_connection'],

  // Fields offered in the bulk-edit bar (applied to every selected way).
  _BULK_FIELDS: [
    { k: 'poles', label: 'Poles', type: 'select', opts: ['1P', '3P'], def: '1P' },
    { k: 'phase', label: 'Phase', type: 'select', opts: ['R', 'W', 'B'], def: 'R' },
    { k: 'curve', label: 'Curve', type: 'select', opts: ['B', 'C', 'D'], def: 'C' },
    { k: 'breaker_a', label: 'Breaker (A)', type: 'number' },
    { k: 'el_group', label: 'EL Group', type: 'text' },
    { k: 'cable_mm2', label: 'Cable mm²', type: 'number' },
    { k: 'ecc_mm2', label: 'ECC mm²', type: 'number' },
    { k: 'cable_m', label: 'Length (m)', type: 'number' },
    { k: 'load_va', label: 'Load (VA)', type: 'number' },
    { k: 'demand_factor', label: 'DF', type: 'number' },
    { k: 'power_factor', label: 'PF', type: 'number' },
    { k: 'description', label: 'Description', type: 'text' },
  ],

  // Stable way id (EE-7). Mint from the shared plan sequence so plan-created
  // and schedule-created ways never collide; device circuit tags reference
  // this id, not the mutable way number.
  _wayId() {
    if (typeof PlanCircuits !== 'undefined' && PlanCircuits._genWayId) return PlanCircuits._genWayId();
    return 'w' + (AppState.planMarkup._seq++);
  },
  _ensureWayIds(comp) {
    if (!comp || !Array.isArray(comp.props.circuits)) return;
    for (const c of comp.props.circuits) if (!c.id) c.id = this._wayId();
  },
  // [P4] `Number(v) || fallback` treats a legitimately-stored 0 as absent —
  // unreachable via the UI (the PF input's min="0.05" prevents entering
  // exactly 0) but a project loaded from JSON/the API client can carry one.
  // Only lagging (positive) pf is modelled here — a way/board has no leading
  // mode to select, unlike an inverter's var_mode — so this only fixes the
  // absent-vs-zero ambiguity, it doesn't add signed-pf support.
  _pfOr(value, fallback) {
    const n = Number(value);
    return (value !== undefined && value !== null && value !== '' && !Number.isNaN(n)) ? n : fallback;
  },

  // Lazy per-circuit power-factor migration for projects predating the PF
  // column: seed each way's pf from the board's existing power_factor so the
  // rollup reproduces the old board value byte-for-byte. Runs before the
  // open-time snapshot, so it never marks the project dirty on its own.
  _ensurePf(comp) {
    if (!comp || !Array.isArray(comp.props.circuits)) return;
    const fallback = this._pfOr(comp.props.power_factor, 0.85);
    for (const c of comp.props.circuits) {
      if (c.power_factor === undefined || c.power_factor === null || c.power_factor === '') {
        c.power_factor = fallback;
      }
    }
  },

  init() {
    this.modal = document.getElementById('db-modal');
    this._modalBody = document.getElementById('db-modal-body');
    this.body = this._modalBody;
    document.getElementById('db-modal-close').addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    // Escape must work while focus is in a schedule cell: the global app.js
    // handler returns early for INPUT/SELECT targets, so the editor needs its
    // own scoped listener. Same close (diff-aware commit) as every other
    // close path; stopPropagation keeps the global handler from double-acting.
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  },

  // What commit() diffs against the open-time copy so a read-only look at the
  // schedule doesn't clear results or push an undo snapshot. `circuits` covers
  // every per-way field (including ecc_mm2); the board-level install
  // conditions and Ze are edited in the Schedules workspace rail and must be
  // listed explicitly or those edits would never mark the project dirty.
  _committedFields(comp) {
    return {
      circuits: comp.props.circuits || [],
      board_diversity: comp.props.board_diversity ?? 1.0,
      el_ratings: comp.props.el_ratings || {},
      way_install: comp.props.way_install || null,
      ze_ohm: comp.props.ze_ohm ?? null,
    };
  },

  // Point the renderer at a container. Exactly one host may hold a populated
  // grid — render() emits fixed ids (#db-rows, #db-select-all, …), so the
  // outgoing host is cleared first.
  _setHost(el, mode) {
    if (this.body && this.body !== el) this.body.innerHTML = '';
    this.body = el;
    this.mode = mode || 'modal';
  },

  // Status-line messages. #status-info lives inside #app-container, which
  // switchWorkspace() hides — so in a workspace the message must go to that
  // workspace's own chip or it is written to an invisible element.
  _status(msg) {
    if (this.mode === 'workspace' && typeof Schedules !== 'undefined' && Schedules._status) {
      Schedules._status(msg);
      return;
    }
    const el = document.getElementById('status-info');
    if (el) el.textContent = msg;
  },

  // Begin an edit session on a board: lazy migrations + the diff baseline.
  // Shared by the modal (open) and the workspace (openInline).
  _beginEdit(compId) {
    const comp = AppState.components.get(compId);
    if (!comp || comp.type !== 'distribution_board') return null;
    this.currentId = compId;
    this._selected = new Set();
    if (!Array.isArray(comp.props.circuits)) comp.props.circuits = [];
    this._ensureWayIds(comp);   // lazy EE-7 migration for existing projects
    this._ensurePf(comp);       // lazy per-circuit PF migration for old projects
    // Snapshot BEFORE render() (whose recompute() writes the derived props)
    this._rebaseline(comp);
    return comp;
  },

  // (Re)take the diff baseline. Called at the start of an edit session and
  // again after every commit, so the next diff is against the last commit
  // rather than against the session start.
  _rebaseline(comp) {
    this._openCommitted = JSON.stringify(this._committedFields(comp));
    this._openDerived = {};
    for (const k of this._DERIVED_KEYS) {
      this._openDerived[k] = comp.props[k] !== undefined
        ? JSON.parse(JSON.stringify(comp.props[k])) : undefined;
    }
  },

  open(compId) {
    const comp = this._beginEdit(compId);
    if (!comp) return;
    this._setHost(this._modalBody, 'modal');
    document.getElementById('db-modal-title').textContent =
      `Circuit Schedule — ${comp.props.name || compId}`;
    this.render();
    this.modal.style.display = '';
  },

  // Render the same grid into an arbitrary container (the Schedules
  // workspace). No modal chrome, no title write — the host owns those.
  openInline(compId, hostEl) {
    if (!hostEl) return;
    const comp = this._beginEdit(compId);
    if (!comp) { hostEl.innerHTML = ''; return; }
    this._setHost(hostEl, 'workspace');
    this.render();
  },

  // Write the current board's edits back into the model. Diff-aware and
  // idempotent — an unchanged board costs nothing, so a workspace may call
  // this as often as it likes (board switch, deactivate, idle, save).
  commit() {
    if (!this.currentId) return false;
    const comp = AppState.components.get(this.currentId);
    if (!comp) return false;
    const unchanged = this._openCommitted != null &&
      JSON.stringify(this._committedFields(comp)) === this._openCommitted;
    if (unchanged) {
      // Read-only visit: undo the derived-prop writes render()'s recompute()
      // made and skip the commit ritual entirely (no results cleared, no
      // dirty flag, no undo snapshot).
      if (this._openDerived) {
        for (const k of this._DERIVED_KEYS) {
          if (this._openDerived[k] === undefined) delete comp.props[k];
          else comp.props[k] = this._openDerived[k];
        }
      }
      return false;
    }
    this.recompute(comp);
    this._normalizeElRatings(comp);
    AppState.dirty = true;
    if (typeof Properties !== 'undefined') {
      Properties._notifyResultsCleared();
    }
    AppState.clearResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    Canvas.render();
    if (typeof Properties !== 'undefined' && Properties.currentId === comp.id) {
      Properties.show(comp.id);
    }
    this._rebaseline(comp);
    return true;
  },

  close(commit = true) {
    if (this.modal) this.modal.style.display = 'none';
    if (commit) this.commit();
    this.currentId = null;
    this._openCommitted = null;
    this._openDerived = null;
    this._selected = new Set();
    // When the editor was opened from the Plan workspace, refresh its board
    // panel so the way count reflects any edits. Deliberately in close() and
    // not commit() — the workspace commits often and must not poke the plan
    // panel on every idle tick.
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && PlanMarkup.refreshProps) PlanMarkup.refreshProps();
  },

  // ── Derived lumped-load equivalents ────────────────────────────────
  // rated_kva  = total connected load
  // demand_factor = (Σ way VA × way DF × board diversity) / connected
  // power_factor = board-level PF, the diversified P/Q vector sum of each
  //   way's own power_factor (board_diversity scales P and Q alike, so it
  //   cancels out of the ratio)
  // phase_a/b/c_pct = share of DIVERSIFIED demand per phase (3P ways split /3)
  recompute(comp) {
    const circuits = comp.props.circuits || [];
    const boardDf = comp.props.board_diversity || 1.0;
    let connectedVa = 0;
    const phaseVa = { R: 0, W: 0, B: 0 };
    let demandVa = 0;
    let sumP = 0, sumQ = 0;   // diversified real / reactive VA for the PF rollup
    // A way with no pf yet (legacy project not opened in the editor) inherits
    // the board's current pf, so recompute reproduces the old board value.
    const pfFallback = this._pfOr(comp.props.power_factor, 0.85);
    for (const c of circuits) {
      const va = Number(c.load_va) || 0;
      const df = Number(c.demand_factor) || 1;
      connectedVa += va;
      const d = va * df;
      demandVa += d;
      const pf = Math.min(1, Math.max(0.05, this._pfOr(c.power_factor, pfFallback)));
      sumP += d * pf;
      sumQ += d * Math.sqrt(Math.max(0, 1 - pf * pf));
      if (c.poles === '3P' || c.phase === 'RWB') {
        phaseVa.R += d / 3; phaseVa.W += d / 3; phaseVa.B += d / 3;
      } else {
        phaseVa[c.phase || 'R'] = (phaseVa[c.phase || 'R'] || 0) + d;
      }
    }
    demandVa *= boardDf;

    comp.props.rated_kva = Math.round(connectedVa / 10) / 100;   // kVA, 2dp
    comp.props.demand_factor = connectedVa > 0
      ? Math.round((demandVa / connectedVa) * 10000) / 10000 : 1.0;
    // Board PF = ΣP / |ΣS|; leave the fallback prop untouched for a board with
    // no load so an empty/legacy board keeps its 0.85 default.
    const sMag = Math.hypot(sumP, sumQ);
    const boardPf = sMag > 0 ? Math.round((sumP / sMag) * 1000) / 1000 : null;
    if (boardPf !== null) comp.props.power_factor = boardPf;
    const phTotal = phaseVa.R + phaseVa.W + phaseVa.B;
    if (phTotal > 0) {
      comp.props.phase_a_pct = Math.round(phaseVa.R / phTotal * 10000) / 100;
      comp.props.phase_b_pct = Math.round(phaseVa.W / phTotal * 10000) / 100;
      comp.props.phase_c_pct = Math.round(phaseVa.B / phTotal * 10000) / 100;
    } else {
      comp.props.phase_a_pct = 33.33;
      comp.props.phase_b_pct = 33.33;
      comp.props.phase_c_pct = 33.34;
    }
    comp.props.phase_connection = '3P';
    // Exact figures for display (props round for the analyses)
    return {
      connectedKva: connectedVa / 1000, demandKva: demandVa / 1000, phaseVa,
      pf: boardPf !== null ? boardPf : this._pfOr(comp.props.power_factor, 0.85),
    };
  },

  // ── Standing earth leakage per EL group ────────────────────────────
  // Pure: sums each group's device leakage (way leakage_ma) plus the cable's
  // own insulation leakage, and resolves each group's effective IΔn without
  // touching props (so read-only schedule visits stay diff-clean).
  _leakageGroups(comp) {
    const stored = (comp.props.el_ratings && typeof comp.props.el_ratings === 'object')
      ? comp.props.el_ratings : {};
    const groups = new Map();
    let ungrouped = 0;
    for (const c of comp.props.circuits || []) {
      const ma = (Number(c.leakage_ma) || 0) +
        (Number(c.cable_m) || 0) * DB_CABLE_LEAK_MA_PER_M;
      const g = String(c.el_group || '').trim();
      if (!g) { ungrouped += ma; continue; }
      groups.set(g, (groups.get(g) || 0) + ma);
    }
    const ratings = {};
    for (const g of groups.keys()) {
      ratings[g] = Number(stored[g]) > 0 ? Number(stored[g]) : 30;
    }
    return { groups, ungrouped, ratings };
  },

  // Commit-time tidy-up: drop ratings for groups that no longer exist and
  // materialize the 30 mA default for groups that never had one set.
  _normalizeElRatings(comp) {
    const { ratings } = this._leakageGroups(comp);
    comp.props.el_ratings = ratings;
  },

  // ── ECC (earth continuity conductor) ────────────────────────────────
  // IEC 60364-5-54 Table 54.7 / SANS 10142-1 selection rule, rounded up to a
  // preferred size. Mirrors ecc_required_mm2() in db_circuit_check.py — the
  // frontend copy exists so the "Fill ECC" button and the blank-cell
  // placeholder work without a round trip.
  eccRequiredMm2(phaseMm2) {
    const s = Number(phaseMm2);
    if (!(s > 0)) return null;
    const required = s <= 16 ? s : (s <= 35 ? 16 : s / 2);
    const sizes = (typeof IEC_STANDARD_SIZES !== 'undefined')
      ? IEC_STANDARD_SIZES : [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400];
    for (const size of sizes) if (size >= required - 1e-9) return size;
    return null;
  },

  // Set the table minimum on every way that has no ECC yet. Deliberately a
  // BUTTON, not an on-load migration: writing props on open would break the
  // read-only-visit guarantee that keeps a browse from dirtying the project.
  fillEcc(comp) {
    let n = 0;
    for (const c of (comp.props.circuits || [])) {
      if (c.ecc_mm2 != null && c.ecc_mm2 !== '' && Number(c.ecc_mm2) > 0) continue;
      const req = this.eccRequiredMm2(c.cable_mm2);
      if (req != null) { c.ecc_mm2 = req; n++; }
    }
    return n;
  },

  // ── Backend circuit check ───────────────────────────────────────────
  // One call covers every board in the project, so the workspace's board rail
  // and the current grid are populated together.
  async runCheck() {
    if (this._checkInFlight) { this._checkQueued = true; return; }
    this._checkInFlight = true;
    this._status('Checking circuits…');
    try {
      const res = await API.runDbCircuitCheck();
      AppState.dbCheckResults = res;
      this.syncResults();
      this._paintResults();
      if (typeof Schedules !== 'undefined' && Schedules._active) Schedules.render();
      const s = res.summary || {};
      this._status(`Circuit check: ${s.pass || 0} pass · ${s.warn || 0} warn · `
        + `${s.fail || 0} fail · ${s.info || 0} not evaluated (${s.ways || 0} ways).`);
    } catch (err) {
      this._status(`Circuit check failed: ${err.message}`);
      if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Circuit check failed: ${err.message}`, 'error');
    } finally {
      this._checkInFlight = false;
      if (this._checkQueued) { this._checkQueued = false; this.runCheck(); }
    }
  },

  // Reassign 1P ways across R/W/B for best balance (largest-first greedy).
  // 3P ways are inherently balanced and left untouched.
  autoBalance(comp) {
    const circuits = comp.props.circuits || [];
    const singles = circuits
      .filter(c => (c.poles || '1P') !== '3P')
      .map(c => ({ c, va: (Number(c.load_va) || 0) * (Number(c.demand_factor) || 1) }))
      .sort((a, b) => b.va - a.va);
    const totals = { R: 0, W: 0, B: 0 };
    for (const s of singles) {
      const phase = Object.keys(totals).reduce((min, p) => totals[p] < totals[min] ? p : min, 'R');
      s.c.phase = phase;
      totals[phase] += s.va;
    }
    return singles.length;
  },

  // ── Blank way factory ───────────────────────────────────────────────
  // The single definition of "a new empty way". This literal used to be
  // duplicated at five sites (add-row, Enter-on-last-row, paste-append,
  // PlanCircuits._newWay, PlanSync._ensureFeederCircuit) and had already
  // drifted apart — the plan-sync copy omitted power_factor entirely. Every
  // site now calls this so a new field only has to be added once.
  // ecc_mm2 is intentionally left null: "as required by Table 54.7", which
  // the check engine resolves. Writing a concrete default here would be an
  // unrequested opinion about the installation.
  newWay(index, overrides) {
    const i = Number(index) || 0;
    return Object.assign({
      id: this._wayId(),
      way: String(i + 1),
      description: '',
      poles: '1P',
      phase: ['R', 'W', 'B'][i % 3],
      breaker_a: 20,
      curve: 'C',
      el_group: '',
      cable_mm2: 2.5,
      ecc_mm2: null,
      cable_m: 10,
      load_va: 0,
      demand_factor: 1,
      power_factor: 0.9,
      leakage_ma: 0,
    }, overrides || {});
  },

  // ── Default load presets ────────────────────────────────────────────
  // Look up a preset from the DB_LOAD_TYPES library (constants.js).
  _loadType(key) {
    return (typeof DB_LOAD_TYPES !== 'undefined')
      ? DB_LOAD_TYPES.find(t => t.key === key) : null;
  },

  // Human description for a preset way, e.g. "Lighting — 10 points".
  _describeLoad(t, count) {
    if (!t.va) return t.label;                       // Spare / zero-load way
    if (count > 1) return `${t.label} — ${count} ${t.unit}s`;
    return t.label;
  },

  // Build a circuit (way) object from a preset and a unit count. `idx` is the
  // position it will occupy — used for the way number and R/W/B round-robin.
  _makeCircuit(t, count, idx) {
    const n = Math.max(1, Math.round(count) || 1);
    const is3P = t.poles === '3P';
    return this.newWay(idx, {
      description: this._describeLoad(t, n),
      poles: t.poles,
      phase: is3P ? 'RWB' : ['R', 'W', 'B'][idx % 3],
      breaker_a: t.breaker_a,
      curve: t.curve,
      cable_mm2: t.cable_mm2,
      ecc_mm2: t.ecc_mm2 ?? null,
      load_va: t.va * n,
      demand_factor: t.df,
      power_factor: t.pf ?? 0.9,
      leakage_ma: Math.round((t.leak_ma || 0) * n * 100) / 100,
    });
  },

  // Append `repeat` circuits of `key`, each carrying `count` units, then
  // re-render and report what was added.
  addLoad(key, count, repeat = 1) {
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;
    const t = this._loadType(key);
    if (!t) return;
    const circuits = comp.props.circuits;
    const n = Math.max(1, Math.round(repeat) || 1);
    for (let i = 0; i < n; i++) {
      circuits.push(this._makeCircuit(t, count, circuits.length));
    }
    this.render();
    const units = Math.max(1, Math.round(count) || 1);
    this._status(n > 1
      ? `Added ${n} ${t.label.toLowerCase()} circuit(s).`
      : `Added ${t.label.toLowerCase()} way (${units} ${t.unit}${units === 1 ? '' : 's'}).`);
  },

  // ── Board incomer current (EE-16) ──
  // A board whose every way is single-phase draws its heaviest-phase load at
  // 230 V, not the √3·400 V three-phase figure; a mixed/3-phase board reports
  // the 3φ current plus the worst-phase current so imbalance is visible.
  _allSinglePhase(comp) {
    const cc = comp.props.circuits || [];
    return cc.length > 0 && cc.every(c => (c.poles || '1P') !== '3P' && c.phase !== 'RWB');
  },
  _ampsLabel(comp, totals) {
    const ph = totals.phaseVa;
    const worstA = (Math.max(ph.R, ph.W, ph.B)) / 230;   // VA / 230 V
    if (this._allSinglePhase(comp)) return `${worstA.toFixed(1)} A @ 230 V`;
    const vkv = comp.props.voltage_kv || 0.4;
    const a3 = vkv > 0 ? totals.demandKva / (Math.sqrt(3) * vkv) : 0;
    return `${a3.toFixed(1)} A 3φ · worst phase ${worstA.toFixed(1)} A`;
  },

  // ── Per-way status: pin/auto indicator + rating warnings ────────────
  // Diversified way current at 230 V (1P) or √3·400 V (3P).
  _wayCurrentA(c) {
    const va = (Number(c.load_va) || 0) * (Number(c.demand_factor) || 1);
    if (!va) return 0;
    const is3P = c.poles === '3P' || c.phase === 'RWB';
    return is3P ? va / (Math.sqrt(3) * 400) : va / 230;
  },

  // Base (undegraded) ampacity for a bare cable_mm2 size, looked up against
  // the Cu/PVC LV general-wiring table (the standard already referenced by
  // the socket-circuit minimum-size rule below) — no grouping/ambient/burial
  // derating, that's the job of the dedicated cable_sizing engine for an
  // explicit cable component. Exact size match, else the next size up;
  // never credit a smaller table entry.
  _cableAmpacityA(mm2) {
    const sz = Number(mm2);
    if (!sz || typeof STANDARD_CABLES === 'undefined') return null;
    const lv = STANDARD_CABLES.filter(c => c.conductor === 'Cu' && c.insulation === 'PVC' && !(c.voltage_kv > 1));
    const exact = lv.find(c => c.size_mm2 === sz);
    if (exact) return exact.rated_amps;
    const larger = lv.filter(c => c.size_mm2 > sz).sort((a, b) => a.size_mm2 - b.size_mm2)[0];
    return larger ? larger.rated_amps : null;
  },

  // Overload / undersize warnings (EE-8, EE-9): way current vs breaker,
  // socket-way conductor vs SANS 10142-1 minimum, feeder demand vs breaker,
  // cable ampacity vs breaker (Iz ≥ In per SANS 10142-1 / IEC 60364-433).
  //
  // These are the INSTANT, client-side checks — they keep working while the
  // backend result is pending or stale. `hasBackendRow` suppresses the two
  // that the db-circuit-check engine states more accurately (it derates the
  // ampacity; this lookup does not), so the tooltip doesn't say the same
  // thing twice with two different numbers.
  _wayWarnings(c, hasBackendRow = false) {
    const w = [];
    const br = Number(c.breaker_a) || 0;
    const I = this._wayCurrentA(c);
    if (!hasBackendRow && br && I > br + 1e-6) {
      w.push(`Load current ${I.toFixed(1)} A exceeds the ${br} A breaker`);
    }
    const isSocket = /socket/i.test(c.description || '');
    if (isSocket && Number(c.cable_mm2) > 0 && Number(c.cable_mm2) < 2.5) {
      w.push('Socket circuit cable < 2.5 mm² (SANS 10142-1)');
    }
    if (!hasBackendRow) {
      const ampacity = this._cableAmpacityA(c.cable_mm2);
      if (ampacity != null && br > ampacity + 1e-6) {
        w.push(`${c.cable_mm2} mm² cable (Iz ≈ ${ampacity} A, undegraded) undersized for the ${br} A breaker — SANS 10142-1 Iz ≥ In`);
      }
    }
    if (c.type === 'feeder_db' && Number(c.downstream_a) > 0 && br && c.downstream_a > br + 1e-6) {
      w.push(`Downstream demand ${Number(c.downstream_a).toFixed(1)} A exceeds the ${br} A feeder breaker`);
    }
    return w;
  },

  _wayPins(c) {
    const p = [];
    if (c._manualLoadOverride) p.push('load');
    if (c._cableManual) p.push('length');
    if (c._nameOverride) p.push('description');
    if (c._polesManual) p.push('poles/phase');
    return p;
  },

  // ── Backend check results ───────────────────────────────────────────
  // AppState.dbCheckResults is the authority; _resIndex is a way-id lookup
  // rebuilt from it. Keyed on the stable id, never the row index, because
  // sorting by way number reorders the array under us.
  syncResults() {
    const res = (typeof AppState !== 'undefined') ? AppState.dbCheckResults : null;
    this._resIndex = (res && Array.isArray(res.ways))
      ? new Map(res.ways.filter(w => w.way_id).map(w => [w.way_id, w]))
      : null;
    return this._resIndex;
  },

  _resultFor(c) {
    return (this._resIndex && c && c.id) ? this._resIndex.get(c.id) : null;
  },

  // Fill (or blank) the three result cells. Text-only, so this can run while
  // a cell is focused without stealing the caret — same discipline as
  // refreshTotals().
  _paintResults() {
    if (!this.body) return;
    const comp = AppState.components.get(this.currentId);
    const byId = new Map((comp ? (comp.props.circuits || []) : []).map(c => [c.id, c]));
    this.body.querySelectorAll('td.db-res').forEach(td => {
      const row = this._resIndex ? this._resIndex.get(td.dataset.id) : null;
      const kind = td.dataset.res;
      let text = '—', status = 'none', title = 'Run "Check circuits" to compute';
      if (row) {
        if (kind === 'iz') {
          text = row.iz_derated_a != null ? `${row.iz_derated_a.toFixed(1)}` : '—';
          status = this._worstStatus(row.ampacity_status, row.coordination_status);
          title = [row.derating_detail, row.coordination_message].filter(Boolean).join(' · ');
        } else if (kind === 'vd') {
          const pct = row.vd_total_pct != null ? row.vd_total_pct : row.vd_pct;
          text = pct != null ? `${pct.toFixed(2)}` : '—';
          status = row.vd_status || 'none';
          title = row.vd_message || '';
        } else if (kind === 'ecc') {
          const way = byId.get(td.dataset.id);
          const declared = way && way.ecc_mm2 != null && way.ecc_mm2 !== '' && Number(way.ecc_mm2) > 0;
          text = declared ? `${Number(way.ecc_mm2)}`
            : (row.ecc_required_mm2 != null ? `${row.ecc_required_mm2} min` : '—');
          status = row.ecc_status || 'none';
          title = row.ecc_message || '';
        }
        // The earth-loop verdict has no column of its own — surface it on the
        // Iz cell's tooltip so it is never invisible.
        if (kind === 'iz' && row.zs_message) title += ` · ${row.zs_message}`;
      }
      td.textContent = text;
      td.className = `db-res st-${status}`;
      td.title = title;
    });
    // Refresh the ⚠ glyphs, whose tooltips fold in the backend messages.
    this._repaintWarnings();
  },

  _repaintWarnings() {
    const comp = AppState.components.get(this.currentId);
    if (!comp || !this.body) return;
    const circuits = comp.props.circuits || [];
    this.body.querySelectorAll('#db-rows tr[data-idx]').forEach(tr => {
      const cell = tr.querySelector('.db-row-actions');
      if (!cell) return;
      const c = circuits[parseInt(tr.dataset.idx)];
      if (!c) return;
      const old = cell.querySelector('.db-warn');
      const html = this._wayWarnHtml(c);
      if (old) old.remove();
      if (html) cell.insertAdjacentHTML('afterbegin', html);
    });
  },

  _worstStatus(...list) {
    const rank = { pass: 0, none: 0, info: 1, warn: 2, fail: 3 };
    let best = 'pass';
    for (const s of list) if (s && (rank[s] ?? 0) > rank[best]) best = s;
    return best;
  },

  // The ⚠ glyph's markup: local (instant) warnings plus the backend's own
  // messages for the same way, so the tooltip stays the single place detail
  // lives. Colour follows the backend verdict once one exists.
  _wayWarnHtml(c) {
    const row = this._resultFor(c);
    const all = [...this._wayWarnings(c, !!row), ...((row && row.messages) || [])];
    if (!all.length) return '';
    const colour = (row && row.status === 'warn') ? '#b26a00'
      : (row && row.status === 'info' && all.every(m => (row.messages || []).includes(m))) ? '#888'
      : '#d32f2f';
    return `<span class="db-warn" title="${escHtml(all.join(' · '))}" style="color:${colour};margin-right:4px;cursor:help;">⚠</span>`;
  },

  _wayStatusHtml(c, i) {
    let html = this._wayWarnHtml(c);
    const pins = this._wayPins(c);
    if (pins.length) {
      html += `<button class="btn-small db-unpin" data-idx="${i}" title="Pinned (${escHtml(pins.join(', '))}) — your edit is protected from the plan sync. Click to unpin and let the plan drive it again." style="margin-right:2px;">📌</button>`;
    } else if (Number(c.plan_qty) > 0) {
      html += `<span class="db-auto" title="Auto from plan — load/description/length follow the tagged devices." style="opacity:0.5;margin-right:4px;">🔄</span>`;
    }
    return html;
  },

  // Clear a way's pin flags and re-pull its auto values from the plan.
  _unpinWay(comp, c) {
    delete c._manualLoadOverride; delete c._cableManual;
    delete c._nameOverride; delete c._polesManual;
    if (typeof PlanCircuits !== 'undefined') {
      if (PlanCircuits.syncLoads) PlanCircuits.syncLoads();
      if (PlanCircuits.syncRoutedLengths) PlanCircuits.syncRoutedLengths();
    }
    this.render();
  },

  // ── Rendering ───────────────────────────────────────────────────────
  render() {
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;
    const circuits = comp.props.circuits;
    this.syncResults();

    // Drop selection entries for ways that no longer exist.
    const validIds = new Set(circuits.map(c => c.id));
    for (const id of [...this._selected]) if (!validIds.has(id)) this._selected.delete(id);

    const opt = (v, cur, label) =>
      `<option value="${v}"${v === cur ? ' selected' : ''}>${label ?? v}</option>`;

    // data-label on each cell drives the stacked-card layout on phones (see
    // the #db-modal card rules in mobile.css) — on desktop the labels are
    // unused and the table renders normally.
    const rows = circuits.map((c, i) => `
      <tr data-idx="${i}">
        <td data-label="" class="db-sel-cell" style="text-align:center;"><input type="checkbox" class="db-row-sel" data-id="${escHtml(c.id)}"${this._selected.has(c.id) ? ' checked' : ''} title="Select for bulk edit"></td>
        <td data-label="Way"><input type="text" data-k="way" value="${escHtml(c.way ?? String(i + 1))}" style="width:44px"></td>
        <td data-label="Description"><input type="text" data-k="description" list="db-load-datalist" value="${escHtml(c.description || '')}" style="width:100%;min-width:220px"></td>
        <td data-label="Poles"><select data-k="poles">${opt('1P', c.poles || '1P')}${opt('3P', c.poles || '1P')}</select></td>
        <td data-label="Phase"><select data-k="phase" ${((c.poles || '1P') === '3P') ? 'disabled' : ''}>
          ${opt('R', c.phase || 'R')}${opt('W', c.phase || 'R')}${opt('B', c.phase || 'R')}</select></td>
        <td data-label="Breaker (A)"><input type="number" data-k="breaker_a" value="${escHtml(c.breaker_a ?? 20)}" min="1" step="1" style="width:68px"></td>
        <td data-label="Curve"><select data-k="curve">${opt('B', c.curve || 'C')}${opt('C', c.curve || 'C')}${opt('D', c.curve || 'C')}</select></td>
        <td data-label="EL Grp"><input type="text" data-k="el_group" value="${escHtml(c.el_group || '')}" style="width:70px" placeholder="—"></td>
        <td data-label="Leak (mA)"><input type="number" data-k="leakage_ma" value="${escHtml(c.leakage_ma ?? 0)}" min="0" step="0.1" style="width:64px"></td>
        <td data-label="Cable mm²"><input type="text" inputmode="decimal" list="db-mm2-datalist" data-k="cable_mm2" value="${escHtml(c.cable_mm2 ?? 2.5)}" style="width:76px" title="Live conductor size. Type to filter the IEC preferred sizes, or enter any value."></td>
        <td data-label="ECC mm²"><input type="text" inputmode="decimal" list="db-mm2-datalist" data-k="ecc_mm2" value="${c.ecc_mm2 == null ? '' : escHtml(c.ecc_mm2)}" style="width:76px" placeholder="auto" title="Earth continuity conductor. Type to filter the IEC preferred sizes. Leave blank to take the IEC 60364-5-54 Table 54.7 minimum for the live conductor."></td>
        <td data-label="Len (m)"><input type="number" data-k="cable_m" value="${escHtml(c.cable_m ?? 10)}" min="0" step="1" style="width:68px"></td>
        <td data-label="Load (VA)"><input type="number" data-k="load_va" value="${escHtml(c.load_va ?? 0)}" min="0" step="50" style="width:88px"></td>
        <td data-label="DF"><input type="number" data-k="demand_factor" value="${escHtml(c.demand_factor ?? 1)}" min="0" max="1" step="0.05" style="width:64px"></td>
        <td data-label="PF"><input type="number" data-k="power_factor" value="${escHtml(c.power_factor ?? 0.9)}" min="0.05" max="1" step="0.01" style="width:64px"></td>
        <td data-label="Iz (A)" class="db-res st-none" data-res="iz" data-id="${escHtml(c.id)}">—</td>
        <td data-label="%VD" class="db-res st-none" data-res="vd" data-id="${escHtml(c.id)}">—</td>
        <td data-label="ECC ✓" class="db-res st-none" data-res="ecc" data-id="${escHtml(c.id)}">—</td>
        <td data-label="" class="db-row-actions" style="white-space:nowrap;">${this._wayStatusHtml(c, i)}<button class="btn-small db-del-row" data-idx="${i}" title="Remove way">&times;</button></td>
      </tr>`).join('');

    // Live totals (exact, not via the rounded aggregate demand factor)
    const totals = this.recompute(comp);
    const connected = totals.connectedKva;
    const demand = totals.demandKva;
    const ampsLabel = this._ampsLabel(comp, totals);

    // Phase balance bars (SA colours: Red / White / Blue), widths relative
    // to the heaviest phase so imbalance reads at a glance
    const ph = totals.phaseVa;
    const phTotal = ph.R + ph.W + ph.B;
    const phMax = Math.max(ph.R, ph.W, ph.B, 1);
    const PHASE_STYLES = {
      R: { color: '#d32f2f', text: '#fff' },
      W: { color: '#b0b0b8', text: '#222' },
      B: { color: '#1976d2', text: '#fff' },
    };
    const barsHtml = ['R', 'W', 'B'].map(p => {
      const kva = ph[p] / 1000;
      const pct = phTotal > 0 ? (ph[p] / phTotal * 100) : 0;
      const width = phTotal > 0 ? Math.max(2, ph[p] / phMax * 100) : 2;
      const st = PHASE_STYLES[p];
      return `
        <div class="db-phase-row">
          <span class="db-phase-tag" style="background:${st.color};color:${st.text}">${p}</span>
          <div class="db-phase-track">
            <div class="db-phase-fill" style="width:${width}%;background:${st.color}"></div>
          </div>
          <span class="db-phase-val">${kva.toFixed(2)} kVA (${pct.toFixed(0)}%)</span>
        </div>`;
    }).join('');

    // Default-load presets — a dropdown of common circuits (with their
    // default wattage + demand factor) plus one-click quick-add chips.
    const loadTypes = (typeof DB_LOAD_TYPES !== 'undefined') ? DB_LOAD_TYPES : [];
    const typeOptions = loadTypes.map(t =>
      `<option value="${t.key}">${escHtml(t.label)}${t.va ? ` — ${t.va} VA/${t.unit}, DF ${t.df}` : ''}</option>`).join('');
    const datalistOptions = loadTypes.filter(t => t.va)
      .map(t => `<option value="${escHtml(t.label)}"></option>`).join('');

    // Preferred conductor sizes back the cable/ECC cells as a searchable
    // combobox — typing filters the list, but any value can still be entered
    // (a non-preferred size is legal, just unusual).
    const mm2Sizes = (typeof IEC_STANDARD_SIZES !== 'undefined')
      ? IEC_STANDARD_SIZES : [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400];
    const mm2Options = mm2Sizes.map(s => `<option value="${s}">${s} mm²</option>`).join('');

    this.body.innerHTML = `
      <datalist id="db-load-datalist">${datalistOptions}</datalist>
      <datalist id="db-mm2-datalist">${mm2Options}</datalist>
      <div class="db-phase-bars">${barsHtml}</div>
      <div id="db-bulk-bar"></div>
      <div class="library-table-wrap db-schedule-grid">
        <table class="library-table" style="width:100%;font-size:13px;">
          <thead><tr>
            <th style="width:24px;text-align:center;"><input type="checkbox" id="db-select-all" title="Select / deselect all ways"></th>
            <th>Way</th><th>Description</th><th>Poles</th><th>Ph</th>
            <th>Breaker (A)</th><th>Curve</th><th>EL Grp</th>
            <th title="Standing earth leakage of the way's devices (mA). Cable insulation leakage is added automatically from the length.">Leak (mA)</th>
            <th>Cable mm²</th>
            <th title="Earth continuity conductor size. Blank = the IEC 60364-5-54 Table 54.7 minimum for the live conductor.">ECC mm²</th>
            <th>Len (m)</th><th>Load (VA)</th><th>DF</th>
            <th title="Per-circuit power factor. The board-level PF is the diversified P/Q vector rollup of these.">PF</th>
            <th class="db-res-h" data-res="iz" title="Derated current-carrying capacity Iz (IEC 60364-5-52) — compared against the breaker rating In, since SANS 10142-1 / IEC 60364-433 requires Ib ≤ In ≤ Iz. Tooltip also carries the earth-loop (Zs) verdict.">Iz (A)</th>
            <th class="db-res-h" data-res="vd" title="Voltage drop over this way's own length, plus upstream drop when Load Flow has been run. SANS 10142-1 Cl. 6.6: 5 % total, 3 % for lighting.">%VD</th>
            <th class="db-res-h" data-res="ecc" title="Earth continuity conductor verdict against IEC 60364-5-54 Table 54.7. '&lt;n&gt; min' means no ECC is specified and the table minimum is assumed.">ECC ✓</th>
            <th></th>
          </tr></thead>
          <tbody id="db-rows">${rows ||
            '<tr><td colspan="19" style="text-align:center;opacity:0.6;padding:16px;">No ways yet — add the first circuit below.</td></tr>'}</tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <span style="font-size:12px;opacity:0.8;">Add load:</span>
        <select id="db-load-type" title="Common load types with default wattage and demand factor">${typeOptions}</select>
        <input type="number" id="db-load-count" value="1" min="1" step="1" style="width:56px" title="Number of units (points / sockets / …)">
        <span style="font-size:12px;opacity:0.8;">×</span>
        <button class="btn-small" id="db-add-load" title="Add one way pre-filled from the selected load type">+ Add circuit</button>
        <span style="width:1px;height:20px;background:var(--border-color,#ccc);margin:0 4px;"></span>
        <button class="btn-small" id="db-quick-lights" title="Add one lighting way with 10 points">+ 10 Lights</button>
        <button class="btn-small" id="db-quick-sockets" title="Add one socket way with 5 sockets">+ 5 Sockets</button>
        <button class="btn-small" id="db-multi-lights" title="Add 4 lighting circuits (10 points each)">+ 4 Light circuits</button>
        <button class="btn-small" id="db-multi-sockets" title="Add 6 socket circuits (6 sockets each)">+ 6 Socket circuits</button>
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn-small" id="db-add-row">+ Add Way</button>
        <button class="btn-small" id="db-auto-balance" title="Reassign single-phase ways across R/W/B for best balance (3-phase ways untouched)">Auto Balance</button>
        <button class="btn-small" id="db-fill-ecc" title="Set every blank ECC to the IEC 60364-5-54 Table 54.7 minimum for its live conductor">Fill ECC</button>
        <button class="btn-small" id="db-check-circuits" title="Run the per-way cable check on every board — derated ampacity, Ib ≤ In ≤ Iz, voltage drop, ECC and earth-fault loop Zs">Check circuits</button>
        <button class="btn-small" id="db-export-xlsx" title="Export the schedule as an Excel workbook">Export Excel</button>
        <button class="btn-small" id="db-import-xlsx" title="Import ways from an Excel/CSV file (replaces the current schedule)">Import Excel</button>
        <input type="file" id="db-import-file" accept=".xlsx,.xls,.csv" style="display:none">
        <span id="db-totals-strip" style="font-size:12px;">Connected: <strong>${connected.toFixed(2)} kVA</strong>
          &nbsp; Demand (× diversity ${comp.props.board_diversity || 1}): <strong>${demand.toFixed(2)} kVA</strong> (${ampsLabel})
          &nbsp; Board PF: <strong>${totals.pf.toFixed(3)}</strong>
          &nbsp; Phase R/W/B: <strong>${comp.props.phase_a_pct.toFixed(0)}/${comp.props.phase_b_pct.toFixed(0)}/${comp.props.phase_c_pct.toFixed(0)} %</strong></span>
        ${this.mode === 'modal' ? '<button class="btn-primary" id="db-done" style="margin-left:auto;">Done</button>' : ''}
      </div>
      <div id="db-el-panel"></div>`;

    this._refreshElPanel(comp);
    this._refreshBulkBar();
    this._paintResults();

    // ── Bulk-selection checkboxes ──
    this.body.querySelectorAll('.db-row-sel').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this._selected.add(cb.dataset.id);
        else this._selected.delete(cb.dataset.id);
        this._syncSelectAll();
        this._refreshBulkBar();
      });
    });
    const selAll = this.body.querySelector('#db-select-all');
    if (selAll) {
      selAll.addEventListener('change', () => {
        if (selAll.checked) circuits.forEach(c => this._selected.add(c.id));
        else this._selected.clear();
        this.body.querySelectorAll('.db-row-sel').forEach(cb => { cb.checked = selAll.checked; });
        this._syncSelectAll();
        this._refreshBulkBar();
      });
      this._syncSelectAll();
    }

    // Bind — default-load presets & quick-add chips
    this.body.querySelector('#db-add-load').addEventListener('click', () => {
      const key = this.body.querySelector('#db-load-type').value;
      const count = parseInt(this.body.querySelector('#db-load-count').value, 10) || 1;
      this.addLoad(key, count, 1);
    });
    this.body.querySelector('#db-quick-lights').addEventListener('click', () => this.addLoad('lighting', 10, 1));
    this.body.querySelector('#db-quick-sockets').addEventListener('click', () => this.addLoad('socket', 5, 1));
    this.body.querySelector('#db-multi-lights').addEventListener('click', () => {
      const t = this._loadType('lighting');
      this.addLoad('lighting', t ? t.per_circuit : 10, 4);
    });
    this.body.querySelector('#db-multi-sockets').addEventListener('click', () => {
      const t = this._loadType('socket');
      this.addLoad('socket', t ? t.per_circuit : 6, 6);
    });

    // Bind
    this.body.querySelector('#db-auto-balance').addEventListener('click', () => {
      const n = this.autoBalance(comp);
      this.render();
      this._status(n > 0 ? `Auto-balanced ${n} single-phase way(s) across R/W/B.`
                         : 'No single-phase ways to balance.');
    });
    this.body.querySelector('#db-fill-ecc').addEventListener('click', () => {
      const n = this.fillEcc(comp);
      this.render();
      this._status(n > 0
        ? `Set the Table 54.7 minimum ECC on ${n} way(s).`
        : 'Every way already has an ECC size.');
    });
    this.body.querySelector('#db-check-circuits').addEventListener('click', () => this.runCheck());
    this.body.querySelector('#db-export-xlsx').addEventListener('click', () => this.exportXlsx(comp));
    const fileInput = this.body.querySelector('#db-import-file');
    this.body.querySelector('#db-import-xlsx').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.importXlsx(comp, file);
      e.target.value = '';
    });
    this.body.querySelector('#db-add-row').addEventListener('click', () => {
      circuits.push(this.newWay(circuits.length));
      this.render();
    });
    const doneBtn = this.body.querySelector('#db-done');
    if (doneBtn) doneBtn.addEventListener('click', () => this.close());
    this.body.querySelectorAll('.db-del-row').forEach(btn => {
      btn.addEventListener('click', () => {
        circuits.splice(parseInt(btn.dataset.idx), 1);
        this.render();
      });
    });
    this.body.querySelectorAll('.db-unpin').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = circuits[parseInt(btn.dataset.idx)];
        if (c) this._unpinWay(comp, c);
      });
    });
    // ── Spreadsheet-style editing ──
    // change: write through to the model. Full re-render ONLY when poles
    // changes (it toggles the phase select); otherwise refresh just the
    // bars/totals so focus and cursor position survive rapid entry.
    this.body.querySelectorAll('#db-rows input, #db-rows select').forEach(inp => {
      inp.addEventListener('change', (e) => {
        const tr = e.target.closest('tr');
        const c = circuits[parseInt(tr.dataset.idx)];
        if (!c) return;
        const k = e.target.dataset.k;
        const v = e.target.value;
        // Coerce by FIELD, not by input type: the cable/ECC cells are text
        // inputs (so they can carry a searchable datalist without a spinner)
        // but still hold numbers. A blank ECC means "Table 54.7 minimum", so
        // it stays null rather than collapsing to 0.
        if (k === 'ecc_mm2') {
          c[k] = String(v).trim() === '' ? null : (parseFloat(v) || 0);
        } else if (NUMERIC_KEYS.has(k)) {
          c[k] = parseFloat(v) || 0;
        } else {
          c[k] = v;
        }
        // F-PIN (+ EE-14): a hand edit to a plan-derived way pins that field so
        // the next PlanCircuits.syncLoads()/syncRoutedLengths() (fired on any
        // device attribute commit) can't silently overwrite it. Only ways the
        // plan drives (plan_qty > 0) can be pinned — manual ways are never
        // touched by sync anyway.
        if (Number(c.plan_qty) > 0) {
          if (k === 'load_va') c._manualLoadOverride = true;
          else if (k === 'cable_m') c._cableManual = true;
          else if (k === 'description') c._nameOverride = true;
          else if (k === 'poles' || k === 'phase') c._polesManual = true;
        }
        if (k === 'way') {
          // Editing a way number re-sorts the schedule by circuit number so
          // rows always read in order (numeric-aware: 1,2,10 not 1,10,2).
          this._sortByWay(comp);
          this.render();
        } else if (k === 'poles') {
          if (c.poles === '3P') c.phase = 'RWB';
          else if (c.phase === 'RWB') c.phase = 'R';
          this.render();
        } else if (k === 'description' && !(Number(c.load_va) > 0)) {
          // Picked a known load type into an empty way → fill its defaults
          // (wattage, demand factor, breaker, curve, cable) for one unit.
          const t = (typeof DB_LOAD_TYPES !== 'undefined')
            ? DB_LOAD_TYPES.find(x => x.va && x.label.toLowerCase() === String(v).trim().toLowerCase())
            : null;
          if (t) {
            c.load_va = t.va;
            c.demand_factor = t.df;
            c.breaker_a = t.breaker_a;
            c.curve = t.curve;
            c.cable_mm2 = t.cable_mm2;
            c.ecc_mm2 = t.ecc_mm2 ?? null;
            c.leakage_ma = t.leak_ma || 0;
            c.poles = t.poles;
            if (t.poles === '3P') c.phase = 'RWB';
            else if (c.phase === 'RWB') c.phase = 'R';
            this.render();
          } else {
            this.refreshTotals(comp);
          }
        } else {
          this.refreshTotals(comp);
        }
      });
      // select all on focus — typing immediately replaces, like a spreadsheet
      if (inp.tagName === 'INPUT') {
        inp.addEventListener('focus', () => inp.select());
      }
    });

    // Keyboard navigation: Enter/↓ = same column next row (Enter on the last
    // row adds a way), ↑ = previous row, Tab keeps its native left/right.
    // Must match the VISUAL column order — paste maps clipboard columns onto
    // this list by position.
    const NAV_COLS = ['way', 'description', 'poles', 'phase', 'breaker_a', 'curve',
      'el_group', 'leakage_ma', 'cable_mm2', 'ecc_mm2', 'cable_m', 'load_va',
      'demand_factor', 'power_factor'];
    this._focusCell = (row, k) => {
      const el = this.body.querySelector(`#db-rows tr[data-idx="${row}"] [data-k="${k}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    };
    this.body.querySelector('#db-rows').addEventListener('keydown', (e) => {
      const cell = e.target.closest('[data-k]');
      if (!cell) return;
      const tr = cell.closest('tr');
      const row = parseInt(tr.dataset.idx);
      const k = cell.dataset.k;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        cell.dispatchEvent(new Event('change', { bubbles: true }));
        if (row + 1 >= circuits.length && e.key === 'Enter') {
          // Enter on the last row: append a new way and land in it
          circuits.push(this.newWay(circuits.length));
          this.render();
          this._focusCell(circuits.length - 1, k);
        } else if (row + 1 < circuits.length) {
          this._focusCell(row + 1, k);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cell.dispatchEvent(new Event('change', { bubbles: true }));
        if (row > 0) this._focusCell(row - 1, k);
      }
    });

    // Multi-cell paste from Excel/Sheets: TSV starting at the focused cell.
    // Extra rows are appended automatically.
    this.body.querySelector('#db-rows').addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // single value → default paste
      const cell = e.target.closest('[data-k]');
      if (!cell) return;
      e.preventDefault();
      const startRow = parseInt(cell.closest('tr').dataset.idx);
      const startCol = NAV_COLS.indexOf(cell.dataset.k);
      const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
      for (let li = 0; li < lines.length; li++) {
        const rowIdx = startRow + li;
        while (rowIdx >= circuits.length) {
          circuits.push(this.newWay(circuits.length, { phase: 'R' }));
        }
        const c = circuits[rowIdx];
        const vals = lines[li].split('\t');
        for (let vi = 0; vi < vals.length && startCol + vi < NAV_COLS.length; vi++) {
          const key = NAV_COLS[startCol + vi];
          const raw = String(vals[vi]).trim();
          if (raw === '') continue;
          if (['breaker_a', 'leakage_ma', 'cable_mm2', 'ecc_mm2', 'cable_m', 'load_va', 'demand_factor', 'power_factor'].includes(key)) {
            const n = parseFloat(raw);
            if (!isNaN(n)) {
              if (key === 'demand_factor') c[key] = Math.min(1, Math.max(0, n));
              else if (key === 'power_factor') c[key] = Math.min(1, Math.max(0.05, n));
              else c[key] = n;
            }
          } else if (key === 'poles') {
            c.poles = raw.toUpperCase().includes('3') ? '3P' : '1P';
            if (c.poles === '3P') c.phase = 'RWB';
          } else if (key === 'phase') {
            const p = raw.toUpperCase();
            if (p === 'RWB') { c.poles = '3P'; c.phase = 'RWB'; }
            else if (['R', 'W', 'B'].includes(p[0])) c.phase = p[0];
          } else if (key === 'curve') {
            if (['B', 'C', 'D'].includes(raw.toUpperCase())) c.curve = raw.toUpperCase();
          } else {
            c[key] = raw;
          }
        }
      }
      this.render();
      this._status(`Pasted ${lines.length} row(s) into the schedule.`);
    });
  },

  // Refresh the phase bars, EL leakage panel and totals strip in place (no
  // table re-render, so the focused cell keeps focus during rapid entry)
  refreshTotals(comp) {
    this._refreshElPanel(comp);
    const totals = this.recompute(comp);
    const ph = totals.phaseVa;
    const phTotal = ph.R + ph.W + ph.B;
    const phMax = Math.max(ph.R, ph.W, ph.B, 1);
    this.body.querySelectorAll('.db-phase-row').forEach((row, i) => {
      const p = ['R', 'W', 'B'][i];
      const pct = phTotal > 0 ? (ph[p] / phTotal * 100) : 0;
      row.querySelector('.db-phase-fill').style.width =
        `${phTotal > 0 ? Math.max(2, ph[p] / phMax * 100) : 2}%`;
      row.querySelector('.db-phase-val').textContent =
        `${(ph[p] / 1000).toFixed(2)} kVA (${pct.toFixed(0)}%)`;
    });
    const ampsLabel = this._ampsLabel(comp, totals);
    const strip = this.body.querySelector('#db-totals-strip');
    if (strip) {
      strip.innerHTML = `Connected: <strong>${totals.connectedKva.toFixed(2)} kVA</strong>
        &nbsp; Demand (× diversity ${comp.props.board_diversity || 1}):
        <strong>${totals.demandKva.toFixed(2)} kVA</strong> (${ampsLabel})
        &nbsp; Board PF: <strong>${totals.pf.toFixed(3)}</strong>
        &nbsp; Phase R/W/B: <strong>${comp.props.phase_a_pct.toFixed(0)}/${comp.props.phase_b_pct.toFixed(0)}/${comp.props.phase_c_pct.toFixed(0)} %</strong>`;
    }
  },

  // ── Sort by way number ─────────────────────────────────────────────
  // Numeric-aware in-place sort (keeps the array reference the render-time
  // closures capture) so "1, 2, 10" order rather than "1, 10, 2".
  _sortByWay(comp) {
    (comp.props.circuits || []).sort((a, b) =>
      String(a.way ?? '').localeCompare(String(b.way ?? ''),
        undefined, { numeric: true, sensitivity: 'base' }));
  },

  // ── Bulk selection + edit ───────────────────────────────────────────
  // Reflect the header "select all" tri-state from the current selection.
  _syncSelectAll() {
    const selAll = this.body && this.body.querySelector('#db-select-all');
    if (!selAll) return;
    const comp = AppState.components.get(this.currentId);
    const total = comp ? (comp.props.circuits || []).length : 0;
    const sel = this._selected.size;
    selAll.checked = total > 0 && sel === total;
    selAll.indeterminate = sel > 0 && sel < total;
  },

  // The bulk-edit bar appears only while ≥1 way is selected: pick a field,
  // enter a value, apply it to every selected way (or delete them).
  _refreshBulkBar() {
    const wrap = this.body && this.body.querySelector('#db-bulk-bar');
    if (!wrap) return;
    const n = this._selected.size;
    if (n === 0) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const fieldOpts = this._BULK_FIELDS
      .map(f => `<option value="${f.k}">${escHtml(f.label)}</option>`).join('');
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:8px 10px;border:1px solid var(--accent-color,#1976d2);border-radius:6px;background:var(--hover-bg,rgba(25,118,210,0.08));">
        <strong style="font-size:12px;"><span id="db-bulk-count">${n}</span> selected</strong>
        <span style="font-size:12px;opacity:0.8;">Set</span>
        <select id="db-bulk-field" title="Field to change on every selected way">${fieldOpts}</select>
        <span id="db-bulk-value-wrap"></span>
        <button class="btn-small" id="db-bulk-apply" title="Apply the value to all selected ways">Apply to selected</button>
        <span style="width:1px;height:20px;background:var(--border-color,#ccc);"></span>
        <button class="btn-small" id="db-bulk-delete" title="Remove all selected ways">Delete selected</button>
        <button class="btn-small" id="db-bulk-clear" title="Clear the selection">Clear</button>
      </div>`;
    const valWrap = wrap.querySelector('#db-bulk-value-wrap');
    const fieldSel = wrap.querySelector('#db-bulk-field');
    const buildVal = () => {
      valWrap.innerHTML = this._bulkValueControl(
        this._BULK_FIELDS.find(f => f.k === fieldSel.value));
    };
    buildVal();
    fieldSel.addEventListener('change', buildVal);
    wrap.querySelector('#db-bulk-apply').addEventListener('click',
      () => this._applyBulk(fieldSel.value, valWrap));
    wrap.querySelector('#db-bulk-delete').addEventListener('click', () => this._bulkDelete());
    wrap.querySelector('#db-bulk-clear').addEventListener('click',
      () => { this._selected.clear(); this.render(); });
  },

  _bulkValueControl(f) {
    if (!f) return '';
    if (f.type === 'select') {
      return `<select id="db-bulk-value">${f.opts.map(o =>
        `<option value="${o}"${o === f.def ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
    }
    if (f.type === 'number') {
      // Conductor sizes get the same searchable preferred-size list as the grid
      // cells; _applyBulk still parses the value, so free entry keeps working.
      if (f.k === 'cable_mm2' || f.k === 'ecc_mm2') {
        return `<input type="text" inputmode="decimal" list="db-mm2-datalist" id="db-bulk-value" style="width:88px" placeholder="mm²">`;
      }
      const step = f.k === 'demand_factor' ? '0.05' : '1';
      return `<input type="number" id="db-bulk-value" step="${step}" style="width:88px" placeholder="value">`;
    }
    return `<input type="text" id="db-bulk-value" style="width:150px" placeholder="value">`;
  },

  _applyBulk(fieldKey, valWrap) {
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;
    const f = this._BULK_FIELDS.find(x => x.k === fieldKey);
    const input = valWrap.querySelector('#db-bulk-value');
    if (!f || !input) return;
    let val = input.value;
    if (f.type === 'number') {
      val = parseFloat(val);
      if (isNaN(val)) { this._status('Enter a value to apply.'); return; }
      if (f.k === 'demand_factor') val = Math.min(1, Math.max(0, val));
    }
    let count = 0;
    for (const c of comp.props.circuits || []) {
      if (!this._selected.has(c.id)) continue;
      c[fieldKey] = val;
      // Keep poles/phase consistent, matching the per-cell edit rules.
      if (fieldKey === 'poles') {
        if (val === '3P') c.phase = 'RWB';
        else if (c.phase === 'RWB') c.phase = 'R';
      } else if (fieldKey === 'phase' && c.poles === '3P') {
        c.phase = 'RWB';   // 3-phase ways stay RWB regardless of the picked phase
      }
      // Mirror the per-cell pin behaviour so a plan sync can't overwrite the
      // bulk edit on a plan-driven way.
      if (Number(c.plan_qty) > 0) {
        if (fieldKey === 'load_va') c._manualLoadOverride = true;
        else if (fieldKey === 'cable_m') c._cableManual = true;
        else if (fieldKey === 'description') c._nameOverride = true;
        else if (fieldKey === 'poles' || fieldKey === 'phase') c._polesManual = true;
      }
      count++;
    }
    this.render();
    this._status(`Set ${f.label} on ${count} way(s).`);
  },

  _bulkDelete() {
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;
    const keep = (comp.props.circuits || []).filter(c => !this._selected.has(c.id));
    const removed = comp.props.circuits.length - keep.length;
    // Mutate in place so the render-time closures keep their array reference.
    comp.props.circuits.length = 0;
    comp.props.circuits.push(...keep);
    this._selected.clear();
    this.render();
    this._status(`Removed ${removed} selected way(s).`);
  },

  // ── EL group leakage panel ──────────────────────────────────────────
  // One row per EL group: an IΔn selector, the group's standing leakage vs
  // its 30%-of-IΔn limit, and a nuisance-trip flag when exceeded.
  // Collapsed by default and parked below the grid — the schedule itself is
  // what the user works in, so the panel only claims height when opened. The
  // summary line still carries the verdict, so an over-limit group is visible
  // without expanding.
  _elOpen: false,

  _elPanelHtml(comp) {
    const { groups, ungrouped, ratings } = this._leakageGroups(comp);
    if (groups.size === 0 && ungrouped < 0.05) return '';
    const ratingList = (typeof DB_EL_RATINGS_MA !== 'undefined')
      ? DB_EL_RATINGS_MA : [10, 30, 100, 300, 500];
    let overCount = 0;
    const rows = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([g, ma]) => {
        const idn = ratings[g];
        const limit = idn * DB_EL_STANDING_LIMIT;
        const over = ma > limit;
        if (over) overCount++;
        const opts = ratingList.map(r =>
          `<option value="${r}"${r === idn ? ' selected' : ''}>${r} mA</option>`).join('');
        return `
          <div style="display:flex;align-items:center;gap:10px;font-size:12px;">
            <span style="min-width:56px;"><strong>EL ${escHtml(g)}</strong></span>
            <select data-elg="${escHtml(g)}" title="Rated residual current (IΔn) of this group's earth-leakage unit">${opts}</select>
            <span style="min-width:170px;${over ? 'color:#d32f2f;font-weight:600;' : ''}">${ma.toFixed(1)} mA standing / ${limit.toFixed(1)} mA limit</span>
            <span style="${over ? 'color:#d32f2f;' : 'opacity:0.65;'}">${over
              ? '⚠ nuisance-trip risk — move ways to another EL group'
              : '✓ within 30% of IΔn'}</span>
          </div>`;
      }).join('');
    const ung = ungrouped >= 0.05
      ? `<div style="font-size:12px;opacity:0.65;">No EL group: ${ungrouped.toFixed(1)} mA standing (ways without earth-leakage protection)</div>`
      : '';
    const nGroups = groups.size;
    const verdict = overCount > 0
      ? `<span class="db-el-badge st-fail">⚠ ${overCount} over limit</span>`
      : `<span class="db-el-badge st-pass">✓ all within 30% of IΔn</span>`;
    return `
      <details class="db-el-details"${this._elOpen ? ' open' : ''}>
        <summary>Standing earth leakage
          <span class="db-el-count">${nGroups} EL group${nGroups === 1 ? '' : 's'}</span>
          ${nGroups > 0 ? verdict : ''}
          <span class="db-el-ref">IEC 60364-5-53 §531.3.2 — limit 30% of IΔn</span>
        </summary>
        <div class="db-el-body">${rows}${ung}</div>
      </details>`;
  },

  _refreshElPanel(comp) {
    const wrap = this.body.querySelector('#db-el-panel');
    if (!wrap) return;
    wrap.innerHTML = this._elPanelHtml(comp);
    const det = wrap.querySelector('details.db-el-details');
    // Remember the open/closed state so an in-place refresh (every keystroke
    // in the grid re-renders this panel) never collapses it under the user.
    if (det) det.addEventListener('toggle', () => { this._elOpen = det.open; });
    wrap.querySelectorAll('select[data-elg]').forEach(sel => {
      sel.addEventListener('change', () => {
        if (!comp.props.el_ratings || typeof comp.props.el_ratings !== 'object') {
          comp.props.el_ratings = {};
        }
        comp.props.el_ratings[sel.dataset.elg] = parseFloat(sel.value) || 30;
        this._refreshElPanel(comp);
      });
    });
  },

  // ── Excel export / import ───────────────────────────────────────────

  XLSX_HEADERS: ['Way', 'Description', 'Poles', 'Phase', 'Breaker (A)', 'Curve',
    'EL Group', 'Leak (mA)', 'Cable (mm2)', 'ECC (mm2)', 'Length (m)', 'Load (VA)',
    'Demand Factor', 'Power Factor'],

  exportXlsx(comp) {
    if (typeof XLSX === 'undefined') return;
    const rows = (comp.props.circuits || []).map(c => [
      c.way ?? '', c.description ?? '', c.poles ?? '1P',
      (c.poles === '3P') ? 'RWB' : (c.phase ?? 'R'),
      c.breaker_a ?? '', c.curve ?? 'C', c.el_group ?? '', c.leakage_ma ?? 0,
      c.cable_mm2 ?? '', c.ecc_mm2 ?? '', c.cable_m ?? '', c.load_va ?? '',
      c.demand_factor ?? 1, c.power_factor ?? 0.9,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([this.XLSX_HEADERS, ...rows]);
    ws['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 6 }, { wch: 6 }, { wch: 11 },
      { wch: 6 }, { wch: 9 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 13 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Circuit Schedule');
    const name = (comp.props.name || 'DB').replace(/[^\w-]+/g, '_');
    XLSX.writeFile(wb, `${name}_circuit_schedule.xlsx`);
  },

  importXlsx(comp, file) {
    if (typeof XLSX === 'undefined') return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      let rows;
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      } catch (err) {
        UI.toast(`Could not read the file: ${err.message}`, 'error');
        return;
      }
      if (!rows || rows.length < 2) {
        UI.toast('No data rows found — expected a header row followed by circuit rows.', 'error');
        return;
      }
      // Fuzzy header mapping: find each column by keyword
      const heads = rows[0].map(h => String(h).toLowerCase());
      const col = (...keys) => heads.findIndex(h => keys.some(k => h.includes(k)));
      const idx = {
        way: col('way', 'no'), description: col('desc'), poles: col('pole'),
        phase: col('phase', 'ph'), breaker_a: col('breaker', 'mcb', 'rating'),
        curve: col('curve'), el_group: col('el grp', 'el group', 'rcd'),
        leakage_ma: col('leak'),
        // 'mm' is deliberately NOT a cable_mm2 probe — it also matches the
        // "ECC (mm2)" header. Match on the distinctive word instead.
        cable_mm2: col('cable'), ecc_mm2: col('ecc', 'earth', 'cpc'),
        cable_m: col('length', 'len'),
        load_va: col('load', 'va'), demand_factor: col('demand', 'df'),
        power_factor: col('power', 'pf'),
      };
      if (idx.load_va === -1 && idx.description === -1) {
        UI.toast('Could not recognise the columns — export a schedule first to get the expected template.', 'error');
        return;
      }
      const circuits = [];
      for (const r of rows.slice(1)) {
        if (r.every(v => String(v).trim() === '')) continue;   // skip blanks
        const get = (k) => idx[k] >= 0 ? r[idx[k]] : '';
        const num = (k, d) => { const v = parseFloat(get(k)); return isNaN(v) ? d : v; };
        const polesRaw = String(get('poles')).toUpperCase();
        const phaseRaw = String(get('phase')).trim().toUpperCase();
        const poles = polesRaw.includes('3') || phaseRaw === 'RWB' ? '3P' : '1P';
        circuits.push({
          way: String(get('way') || circuits.length + 1),
          description: String(get('description') || ''),
          poles,
          phase: poles === '3P' ? 'RWB' : (['R', 'W', 'B'].includes(phaseRaw[0]) ? phaseRaw[0] : 'R'),
          breaker_a: num('breaker_a', 20),
          curve: ['B', 'C', 'D'].includes(String(get('curve')).toUpperCase()) ? String(get('curve')).toUpperCase() : 'C',
          el_group: String(get('el_group') || ''),
          leakage_ma: Math.max(0, num('leakage_ma', 0)),
          cable_mm2: num('cable_mm2', 2.5),
          ecc_mm2: (String(get('ecc_mm2')).trim() === '' ? null : num('ecc_mm2', null)),
          cable_m: num('cable_m', 10),
          load_va: num('load_va', 0),
          demand_factor: Math.min(1, Math.max(0, num('demand_factor', 1))),
          power_factor: Math.min(1, Math.max(0.05, num('power_factor', 0.9))),
        });
      }
      if (circuits.length === 0) {
        UI.toast('No circuit rows could be read from the file.', 'error');
        return;
      }
      const existing = comp.props.circuits || [];
      const planLinked = !!comp.planLink;
      if (existing.length > 0) {
        const msg = planLinked
          ? `Merge ${circuits.length} imported way(s) into this plan-linked board? Rows are matched by way number; plan-integration fields (feeder links, plan quantities, pinned edits) are preserved.`
          : `Merge ${circuits.length} imported way(s) into the current ${existing.length} way(s) (matched by way number)?`;
        if (!await UI.confirm(msg)) return;
      }
      // SD-2: merge by way number instead of a wholesale replace, so a
      // plan-linked board keeps its stable way ids, "Feeder to Sub-board" ways
      // (type/feedsDbId), plan_qty and pin flags — otherwise the next sync
      // re-mints duplicates and collides way numbers (compounding EE-7).
      const byWay = new Map();
      for (const c of existing) byWay.set(String(c.way), c);
      const merged = [];
      for (const row of circuits) {
        const ex = byWay.get(String(row.way));
        if (ex && ex.type !== 'feeder_db') {
          ex.description = row.description; ex.poles = row.poles; ex.phase = row.phase;
          ex.breaker_a = row.breaker_a; ex.curve = row.curve; ex.el_group = row.el_group;
          ex.leakage_ma = row.leakage_ma; ex.cable_mm2 = row.cable_mm2;
          ex.ecc_mm2 = row.ecc_mm2; ex.cable_m = row.cable_m;
          ex.load_va = row.load_va; ex.demand_factor = row.demand_factor;
          ex.power_factor = row.power_factor;
          merged.push(ex);
          byWay.delete(String(row.way));
        } else {
          row.id = this._wayId();
          merged.push(row);
        }
      }
      // Keep surviving integration ways (feeders + plan-driven ways) that no
      // imported row matched, so the plan↔SLD link stays intact.
      for (const c of existing) {
        if (merged.indexOf(c) !== -1) continue;
        if (c.type === 'feeder_db' || Number(c.plan_qty) > 0) merged.push(c);
      }
      comp.props.circuits = merged;
      this.render();
      this._status(`Imported ${circuits.length} circuit(s) from ${file.name} (merged by way number).`);
    };
    reader.readAsArrayBuffer(file);
  },
};
