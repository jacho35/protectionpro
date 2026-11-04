/* ProtectionPro — Plan Markup → Reticulation schedule sync.
 *
 * One-way, idempotent "Push to Schedules": drawn geometry populates the
 * existing Reticulation workspace (AppState.reticulation) — minisubs, kiosks,
 * erven, feeder fedFrom/lengths and per-kiosk street-light kVA. Matching is
 * reticId-first (then case-insensitive name, then append) so a rename-then-
 * repush never duplicates or clobbers user-entered load data. Entities with no
 * reticulation home (MV routes, trenches, crossings, fibre, RMUs) are carried
 * by the CSV/DXF exports instead.
 *
 * Reticulation remains independently editable. Cable types are the exception
 * and stay in step both ways (see pushRouteCable / pullCablesFromDemand): a
 * service route's cable ↔ its erf's service cable, a kiosk's feeder route's
 * cable ↔ the kiosk's feeder cable.
 */

const PlanSync = {
  PHASES: ['Red', 'White', 'Blue'],

  _factor() {
    const s = AppState.planMarkup.scale;
    return (s && s.factor) ? s.factor : null;
  },

  _routeLenM(r, factor) {
    return factor ? +(AppState.planRoutePx(r) * factor).toFixed(2) : 0;
  },

  // Building sync spans every floor; reticulation is a single implicit floor,
  // so this stays equivalent there.
  _elById() {
    const m = {};
    for (const e of AppState.planAllElements()) m[e.id] = e;
    return m;
  },

  // The calibration factor of a specific floor (routes on other floors measure
  // with their own scale). Falls back to the active-floor factor.
  _floorFactorFor(fl) {
    const s = fl && fl.data && fl.data.scale;
    return (s && s.factor) ? s.factor : this._factor();
  },

  // Endpoint-smart route classification (mirrors the source app's effectiveType).
  _effectiveType(r, elById) {
    const a = r.fromId && elById[r.fromId];
    const b = r.toId && elById[r.toId];
    const t = [a && a.type, b && b.type];
    if (t.includes('kiosk') && t.includes('erf')) return 'service';
    if (t.includes('manhole') && t.includes('erf')) return 'fibreErf';
    if (t.includes('pole')) return 'sl';
    return r.type;
  },

  // Resolve a plan element to an existing reticulation row: reticId, then name.
  // `taken` (optional): row ids other drawn elements are linked to — a name
  // match never takes a row another element already stands for.
  _resolve(rows, el, taken) {
    if (el.reticId) { const byId = rows.find(r => r.id === el.reticId); if (byId) return byId; }
    const nm = (el.name || '').trim().toLowerCase();
    if (!nm) return null;
    return rows.find(r => (r.name || '').trim().toLowerCase() === nm && !(taken && taken.has(r.id))) || null;
  },

  // Row ids drawn elements of `type` are linked to, except `el`'s own.
  _takenIds(els, type) {
    const s = new Set();
    for (const e of els) if (e.type === type && e.reticId) s.add(e.reticId);
    return s;
  },

  // A new Demand row for a drawn element keeps the id the element already
  // points to (an undo in Demand took the row away; the pass puts it back
  // under the same id, so links and overrides stay valid).
  _rowId(el, exists, gen) {
    return el.reticId && !exists(el.reticId) ? el.reticId : gen();
  },

  // A length the site plan measures (m). With "Keep workspaces in sync" a
  // value typed in Demand is kept as an override (Sync.value); the measured
  // figure is remembered for Demand's "plan" / "typed · plan 38 m" note.
  _len(key, src, cur) {
    this._reticSrc[key] = src;
    return this._value ? this._value(key, src, cur) : src;
  },

  // ─── Cable type, kept in step both ways ───
  // The Demand row a drawn route's cable belongs to: a service route (kiosk↔erf)
  // → the erf's cableType; an LV route between a kiosk and the element feeding
  // it → the kiosk's feederCable. {row, key} or null (unlinked / not a feeder).
  _cableLink(route, elById) {
    const R = AppState.reticulation;
    if (!R || !route) return null;
    const a = elById[route.fromId], b = elById[route.toId];
    if (!a || !b) return null;
    if (route.type === 'service') {
      const eEl = a.type === 'erf' ? a : b.type === 'erf' ? b : null;
      if (!eEl || !eEl.reticId || (a.type !== 'kiosk' && b.type !== 'kiosk')) return null;
      for (const k of R.kiosks) {
        const e = k.erfs.find(x => x.id === eEl.reticId);
        if (e) return { row: e, key: 'cableType' };
      }
      return null;
    }
    if (route.type === 'lv') {
      for (const [c, p] of [[a, b], [b, a]]) {
        if (c.type !== 'kiosk' || !c.reticId || !p.reticId) continue;
        const k = R.kiosks.find(x => x.id === c.reticId);
        if (k && k.fedFrom === p.reticId) return { row: k, key: 'feederCable' };
      }
    }
    if (route.type === 'mv') return this._mvCableLink(route, elById);
    return null;
  },

  // An MV route's Demand row: the minisub fed through it holds the cable
  // (Demand › minisub › MV fed from). RMUs / joints between minisubs are walked
  // through, so every route of A – RMU – B maps to B's cable; a route from an
  // RMU to the top minisub (no upstream minisub) maps to that minisub's
  // supply cable.
  _mvCableLink(route, elById) {
    const R = AppState.reticulation, pm = AppState.planMarkup;
    if (!R || !pm || !route.fromId || !route.toId) return null;
    const adj = {};
    for (const r of pm.routes) {
      if (r.type !== 'mv' || r === route || !r.fromId || !r.toId) continue;
      (adj[r.fromId] = adj[r.fromId] || []).push(r.toId);
      (adj[r.toId] = adj[r.toId] || []).push(r.fromId);
    }
    // Minisub rows reachable from `start` without crossing another minisub.
    const side = (start, other) => {
      const rows = new Set(), seen = new Set([other, start]), stack = [start];
      while (stack.length) {
        const id = stack.pop(), el = elById[id];
        if (el && el.type === 'minisub') {
          const row = el.reticId && R.minisubs.find(m => m.id === el.reticId);
          if (row) rows.add(row);
          continue;
        }
        for (const n of adj[id] || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
      return rows;
    };
    const A = side(route.fromId, route.toId), B = side(route.toId, route.fromId);
    for (const [from, to] of [[A, B], [B, A]]) {
      for (const row of to) {
        if (row.mvFedFrom && [...from].some(m => m.id === row.mvFedFrom)) return { row, key: 'mvCable' };
      }
    }
    // Supply side: an RMU end with no minisub beyond it.
    for (const [from, to] of [[A, B], [B, A]]) {
      if (from.size) continue;
      for (const row of to) if (!row.mvFedFrom) return { row, key: 'mvCable' };
    }
    return null;
  },

  // The Demand setting a route type's default cable lives in (null = none).
  _defaultKeyFor(type) {
    return { service: 'quickServiceCable', lv: 'quickFeederCable', mv: 'quickMvCable' }[type] || null;
  },

  // Make the selected route's cable the default for every new route of its type
  // (and fill the drawn routes of that type that still have none).
  setDefaultCable(route) {
    const R = AppState.reticulation, key = route && this._defaultKeyFor(route.type);
    if (!R || !key || !route.cableType) return false;
    R.settings[key] = route.cableType;
    AppState.dirty = true;
    this.fillEmptyCables();
    if (typeof Retic !== 'undefined' && Retic.renderKiosks) { Retic.renderKiosks(); Retic.recompute(); }
    return true;
  },

  // The cable Demand would give a new retic route: the Quick Build service /
  // feeder cable (the same one Push to Schedules falls back to). '' elsewhere.
  defaultCableFor(type) {
    const R = AppState.reticulation, pm = AppState.planMarkup;
    if (!R || !pm || pm.settings.domain !== 'retic') return '';
    if (type === 'service') return R.settings.quickServiceCable || '';
    if (type === 'lv') return R.settings.quickFeederCable || '';
    if (type === 'mv') return R.settings.quickMvCable || '';
    return '';
  },

  // A route with no cable shows the one Demand already holds for it (or the
  // default), so the picker never reads blank when Demand has an answer.
  // Fills blanks only — never overwrites a chosen cable. Returns how many.
  fillEmptyCables() {
    const pm = AppState.planMarkup;
    if (!pm || !AppState.reticulation || pm.settings.domain !== 'retic') return 0;
    const elById = this._elById();
    let n = 0;
    for (const r of pm.routes) {
      if (r.cableType) continue;
      const link = this._cableLink(r, elById);
      const c = (link && link.row[link.key]) || this.defaultCableFor(r.type);
      if (c) { r.cableType = c; n++; }
    }
    if (n && typeof PlanMarkup !== 'undefined') PlanMarkup.markDirty();
    return n;
  },

  // Plan → Demand: a route's cable was changed on the plan.
  pushRouteCable(route) {
    if (!route || !route.cableType) return false;
    const link = this._cableLink(route, this._elById());
    if (!link || link.row[link.key] === route.cableType) return false;
    link.row[link.key] = route.cableType;
    if (typeof Retic !== 'undefined') {
      if (Retic._markDirty) Retic._markDirty();
      Retic.recompute();            // no-op until the Demand tab is open; it redraws then
    }
    return true;
  },

  // Demand → Plan: a cable was changed in Demand; update the drawn routes.
  pullCablesFromDemand() {
    const pm = AppState.planMarkup;
    if (!pm || !AppState.reticulation) return 0;
    const elById = this._elById();
    let n = 0;
    for (const r of pm.routes) {
      const link = this._cableLink(r, elById);
      const want = link && link.row[link.key];
      if (want && r.cableType !== want) { r.cableType = want; n++; }
    }
    if (n && typeof PlanMarkup !== 'undefined') {
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      if (PlanMarkup.refreshProps) PlanMarkup.refreshProps();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    }
    return n;
  },

  // ─── Names and links, Demand ↔ plan ───
  // The Demand row a drawn minisub / kiosk / erf is linked to (by reticId only).
  _demandRow(el) {
    const R = AppState.reticulation;
    if (!R || !el || !el.reticId) return null;
    if (el.type === 'minisub') return R.minisubs.find(m => m.id === el.reticId) || null;
    if (el.type === 'kiosk') return R.kiosks.find(k => k.id === el.reticId) || null;
    if (el.type === 'erf') {
      for (const k of R.kiosks) { const e = k.erfs.find(x => x.id === el.reticId); if (e) return e; }
    }
    if (el.type === 'load') { const f = this._reticRow(el.reticId); return f && f.kind === 'load' ? f.row : null; }
    return null;
  },
  _demandRowName(el, row) { return el.type === 'erf' ? row.erfNumber : row.name; },

  // Demand → Plan: a linked element's label follows its Demand row.
  pullNamesFromDemand() {
    const pm = AppState.planMarkup;
    if (!pm || !AppState.reticulation) return 0;
    let n = 0;
    const editing = (typeof PlanUI !== 'undefined' && PlanUI._nameBefore) ? PlanUI._nameBefore.id : null;
    for (const el of AppState.planAllElements()) {
      if (el.id === editing) continue;     // don't overwrite a label while it is being typed
      const row = this._demandRow(el);
      const want = row && this._demandRowName(el, row);
      if (want && el.name !== want) { el.name = want; n++; }
    }
    if (n && typeof PlanMarkup !== 'undefined') {
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      if (PlanMarkup.refreshProps) PlanMarkup.refreshProps();
      if (typeof PlanUI !== 'undefined' && PlanUI.renderPalette) PlanUI.renderPalette();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
    }
    return n;
  },

  // Demand → Plan: a drawn custom load takes its row's values at once (Demand
  // edits are not left waiting for the next sync pass).
  pullLoadsFromDemand() {
    const pm = AppState.planMarkup;
    if (!pm || !AppState.reticulation) return 0;
    let n = 0;
    for (const el of AppState.planAllElements()) {
      if (el.type !== 'load' || !el.reticId) continue;
      const f = this._reticRow(el.reticId);
      if (!f || f.kind !== 'load') continue;
      const p = el.props || (el.props = {});
      const want = { loadType: f.row.loadType, kw: f.row.kw == null ? '' : f.row.kw, cableType: f.row.cableType || '', motor: f.row.motor || '' };
      let ch = false;
      for (const k of Object.keys(want)) if (p[k] !== want[k]) { p[k] = want[k]; ch = true; }
      if (f.row.name && el.name !== f.row.name) { el.name = f.row.name; ch = true; }
      if (ch) n++;
    }
    if (n && typeof PlanMarkup !== 'undefined') {
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      if (PlanMarkup.refreshProps) PlanMarkup.refreshProps();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
    }
    return n;
  },

  // Demand rows a drawn element could be linked to: same kind, not already
  // taken by another drawn element (the current link is always listed).
  demandLinkCandidates(el) {
    const R = AppState.reticulation;
    if (!R || !['minisub', 'kiosk', 'erf'].includes(el.type)) return [];
    const taken = new Set(AppState.planAllElements().filter(e => e !== el && e.reticId).map(e => e.reticId));
    const out = [];
    if (el.type === 'minisub') R.minisubs.forEach(m => out.push({ id: m.id, label: m.name || m.id }));
    else if (el.type === 'kiosk') R.kiosks.forEach(k => out.push({ id: k.id, label: k.name || k.id }));
    else R.kiosks.forEach(k => k.erfs.forEach(e => out.push({ id: e.id, label: `${e.erfNumber || e.id} (${k.name})` })));
    return out.filter(c => c.id === el.reticId || !taken.has(c.id));
  },

  // Link a drawn element to a Demand row (it takes the row's name) or detach it.
  linkElementToDemand(el, rowId) {
    el.reticId = rowId || null;
    if (rowId) {
      const row = this._demandRow(el);
      const nm = row && this._demandRowName(el, row);
      if (nm) el.name = nm;
    }
  },

  // Site plan → Demand, the Output button (with "Keep workspaces in sync"
  // off): asks and reports in dialogs and takes an undo snapshot. The sync
  // pass calls _pushCore with interactive: false instead — no dialog, no
  // snapshot, and what it used to ask goes to opts.issue(key, text).
  pushToSchedules(opts = {}) { return (typeof ProjectHistory !== 'undefined' ? ProjectHistory.group.bind(ProjectHistory) : (l, f) => f())('Push to Demand schedules', () => this._pushToSchedules(opts)); },
  async _pushToSchedules(opts = {}) {
    const interactive = opts.interactive !== false;
    if (interactive && !this._factor()) {
      const ok = await UI.confirm('Plan is not calibrated — push topology without measured lengths?', { danger: false });
      if (!ok) return null;
    }
    return this._pushCore(opts);
  },

  // The push itself, synchronous. Returns the summary.
  _pushCore(opts = {}) {
    const interactive = opts.interactive !== false;
    const issue = opts.issue || (() => {});
    const pm = AppState.planMarkup;
    const factor = this._factor();
    if (!factor && !interactive) {
      issue('plan-uncalibrated', 'Site plan not calibrated — lengths are not measured, so Demand keeps its own lengths. Calibrate the plan to fill them in.');
    }
    const R = AppState.reticulation;
    const elById = this._elById();
    const summary = { minisubs: 0, kiosks: 0, erfs: 0, loads: 0, feeders: 0, sl: 0, created: [] };
    this._value = interactive ? null : (opts.value || null);
    this._reticSrc = {};
    this._reticFed = {};
    try {

    // 1) Minisubs
    const msEls = pm.elements.filter(e => e.type === 'minisub');
    // Adopt the default lone 'source' minisub if it's still untouched.
    const defaultSourceOnly = R.minisubs.length === 1 && R.minisubs[0].id === 'source' &&
      !R.kiosks.some(k => k.fedFrom && k.fedFrom !== 'source');
    let adopted = false;
    const msTaken = this._takenIds(msEls, 'minisub');
    for (const el of msEls) {
      let row = this._resolve(R.minisubs, el, msTaken);
      if (!row && defaultSourceOnly && !adopted && !msTaken.has(R.minisubs[0].id)) {
        row = R.minisubs[0]; row.name = el.name || row.name; adopted = true;
      } else if (!row) {
        row = { id: this._rowId(el, id => R.minisubs.some(m => m.id === id), () => AppState.reticGenMinisubId()), name: el.name || 'Minisub' };
        R.minisubs.push(row); summary.minisubs++; summary.created.push(row.id);
      } else if (el.reticId === row.id) {
        el.name = row.name || el.name;      // already linked: Demand's name wins
      } else {
        row.name = el.name || row.name;
      }
      el.reticId = row.id;
      if (el.props && el.props.txTypeId && !row.txTypeId) row.txTypeId = el.props.txTypeId;   // the transformer the Auto layout was checked against
    }

    // 2) Kiosks
    const kioskEls = pm.elements.filter(e => e.type === 'kiosk');
    const kTaken = this._takenIds(kioskEls, 'kiosk');
    for (const el of kioskEls) {
      let row = this._resolve(R.kiosks, el, kTaken);
      if (!row) {
        row = Retic._newKiosk(R.minisubs[0] ? R.minisubs[0].id : 'source');
        row.id = this._rowId(el, id => R.kiosks.some(k => k.id === id), () => row.id);
        row.name = el.name || row.name;
        R.kiosks.push(row); summary.kiosks++; summary.created.push(row.id);
      } else if (el.reticId === row.id) {
        el.name = row.name || el.name;      // already linked: Demand's name wins
      } else {
        row.name = el.name || row.name;
      }
      el.reticId = row.id;
      if (el.props && el.props.protection && !row.protection) row.protection = el.props.protection;   // the string breaker the Auto layout checked
      if (el.props && el.props.outgoingProtection && !row.outgoingProtection) row.outgoingProtection = el.props.outgoingProtection;   // the way to every erf (80 A): a value you set is never overwritten
    }

    // 3) fedFrom walk over LV routes (BFS from each minisub element)
    this._walkFeeders(pm, elById, factor, R, summary);
    this._walkMvFeeds(pm, elById, factor, R, summary);

    // 4) Service routes → erven under their kiosk
    const erfTaken = this._takenIds(pm.elements, 'erf');
    const erfSeen = new Set();
    for (const r of pm.routes) {
      if (this._effectiveType(r, elById) !== 'service') continue;
      const a = elById[r.fromId], b = elById[r.toId];
      if (!a || !b) continue;
      const kioskEl = a.type === 'kiosk' ? a : b.type === 'kiosk' ? b : null;
      const erfEl = a.type === 'erf' ? a : b.type === 'erf' ? b : null;
      if (!kioskEl || !erfEl || !kioskEl.reticId) continue;
      if (erfSeen.has(erfEl.id)) continue;     // one service cable per erf counts
      erfSeen.add(erfEl.id);
      const krow = R.kiosks.find(k => k.id === kioskEl.reticId);
      if (!krow) continue;
      const erfName = (erfEl.name || '').trim();
      let erf = erfEl.reticId && krow.erfs.find(e => e.id === erfEl.reticId);
      if (!erf && erfEl.reticId) {
        // Linked to an erf under another kiosk: its service cable now runs
        // from this kiosk, so the erf (and everything typed on it) moves here.
        for (const other of R.kiosks) {
          if (other === krow) continue;
          const i = other.erfs.findIndex(e => e.id === erfEl.reticId);
          if (i >= 0) { erf = other.erfs.splice(i, 1)[0]; krow.erfs.push(erf); break; }
        }
      }
      if (!erf) erf = krow.erfs.find(e => (e.erfNumber || '').trim().toLowerCase() === erfName.toLowerCase() && !erfTaken.has(e.id));
      const len = this._routeLenM(r, factor);
      if (!erf) {
        erf = {
          id: this._rowId(erfEl, id => R.kiosks.some(k => k.erfs.some(e => e.id === id)), () => AppState.reticGenErfId()),
          erfNumber: erfName || String(krow.erfs.length + 1),
          length: len || (Retic.settings.quickServiceLen || 30),
          phase: this.PHASES[krow.erfs.length % 3],
          cableType: r.cableType || Retic.settings.quickServiceCable || '',
          ampsOverride: 0,
        };
        krow.erfs.push(erf); summary.erfs++; summary.created.push(erf.id);
        if (len) this._reticSrc['len:service:' + erf.id] = len;
      } else {
        if (erfEl.reticId === erf.id && erf.erfNumber) erfEl.name = erf.erfNumber;
        if (len) erf.length = this._len('len:service:' + erf.id, len, erf.length);
        if (r.cableType) erf.cableType = r.cableType;
      }
      erfEl.reticId = erf.id;
    }

    // 5) Street-light circuits → per-kiosk streetLightKVA (assign, idempotent)
    const circuits = this.buildSLCircuits(factor);
    const kva = {};
    for (const c of circuits) {
      if (!c.sourceReticId) continue;
      kva[c.sourceReticId] = (kva[c.sourceReticId] || 0) + c.poles.length * (pm.settings.slPoleKVA || 0.15);
    }
    for (const [kid, v] of Object.entries(kva)) {
      const krow = R.kiosks.find(k => k.id === kid);
      // A kiosk with circuits in the Street lighting workspace gets its load
      // from those (per luminaire), not this flat per-pole estimate.
      if (krow && !krow.streetLightFromCircuits) { krow.streetLightKVA = +v.toFixed(3); summary.sl++; }
    }

    // 6) Custom loads → rows on the kiosk / mini-sub that feeds them. Demand's
    //    values win once linked (a plan edit writes to the row when it is made,
    //    PlanLoads.pushToRow); the supply and the measured supply run are the plan's.
    const seenLoad = new Set();
    for (const el of pm.elements) {
      if (el.type !== 'load') continue;
      // A cable drawn to the load from a mini-sub / kiosk is its supply.
      const drawn = (typeof PlanLoads !== 'undefined') ? PlanLoads.drawnFeed(el) : null;
      if (drawn) { el.props = el.props || {}; el.props.fedFrom = drawn.supply.id; }
      const sup = el.props && el.props.fedFrom ? elById[el.props.fedFrom] : null;
      const owner = sup && sup.reticId ? (R.kiosks.find(k => k.id === sup.reticId) || R.minisubs.find(m => m.id === sup.reticId)) : null;
      let f = el.reticId && !seenLoad.has(el.reticId) ? this._reticRow(el.reticId) : null;
      if (f && f.kind !== 'load') f = null;
      if (!f) {
        if (!owner || !(el.props && el.props.loadType)) continue;     // not fed yet: no row until it is
        const row = {
          id: this._rowId(el, id => !!this._reticRow(id) || seenLoad.has(id), () => AppState.reticGenLoadId()),
          name: el.name || '', loadType: el.props.loadType, kw: el.props.kw === 0 ? '' : (el.props.kw == null ? '' : el.props.kw),
          cableType: el.props.cableType || '', motor: el.props.motor || '', length: 0,
        };
        (owner.loads || (owner.loads = [])).push(row);
        summary.loads++; summary.created.push(row.id);
        f = { kind: 'load', row, owner };
      } else if (owner && f.owner !== owner) {                         // fed from another supply now: the row follows
        f.list.splice(f.index, 1);
        (owner.loads || (owner.loads = [])).push(f.row);
        f.owner = owner;
      }
      const row = f.row;
      if (drawn && drawn.route.cableType) row.cableType = drawn.route.cableType;
      seenLoad.add(row.id);
      el.reticId = row.id;
      if (row.name) el.name = row.name;
      el.props = el.props || {};
      el.props.loadType = row.loadType;
      el.props.kw = row.kw == null ? '' : row.kw;
      el.props.cableType = row.cableType || '';
      el.props.motor = row.motor || '';
      if (owner) {
        const m = (typeof PlanLoads !== 'undefined') ? PlanLoads.feedLengthM(el) : null;
        if (m) row.length = this._len('len:load:' + row.id, +m.toFixed(1), row.length);
      }
    }
    } finally {
      this._value = null;
    }

    // The sync pass marks the project changed and redraws Demand itself.
    if (!interactive) return summary;
    AppState.dirty = true;
    if (typeof Retic !== 'undefined') {
      if (Retic._snapshot) Retic._snapshot();
      if (Retic._active) { Retic.render && Retic.render(); Retic.recompute && Retic.recompute(); }
    }
    const extra = [];
    const mv = pm.routes.filter(r => r.type === 'mv').length - (summary.mvFeeds || 0);
    if (mv > 0) extra.push(`${mv} other MV route(s)`);
    if (pm.trenches.length) extra.push(`${pm.trenches.length} trench(es)`);
    if (pm.crossings.length) extra.push(`${pm.crossings.length} crossing(s)`);
    UI.alert(
      `Pushed to Reticulation:\n` +
      `• ${summary.minisubs} new minisub(s), ${summary.kiosks} new kiosk(s), ${summary.erfs} new erf(s)\n` +
      `• ${summary.feeders} feeder link(s), ${summary.sl} kiosk SL load(s)` +
      (summary.mvFeeds ? `\n• ${summary.mvFeeds} MV link(s) between minisubs` : '') +
      (extra.length ? `\n\n${extra.join(', ')} → included in the CSV/DXF exports only.` : ''));
    return summary;
  },

  // BFS over LV routes from minisub elements; first arrival sets a kiosk's
  // fedFrom (upstream minisub or kiosk reticId), feederLength and feederCable.
  _walkFeeders(pm, elById, factor, R, summary) {
    // adjacency: element id -> [{other, route}]
    const adj = {};
    const addEdge = (u, v, r) => { (adj[u] = adj[u] || []).push({ other: v, route: r }); };
    for (const r of pm.routes) {
      if (r.type !== 'lv') continue;
      if (!r.fromId || !r.toId) continue;
      addEdge(r.fromId, r.toId, r);
      addEdge(r.toId, r.fromId, r);
    }
    const visited = new Set();
    const queue = [];
    for (const el of pm.elements) {
      if (el.type === 'minisub') { visited.add(el.id); queue.push(el.id); }
    }
    while (queue.length) {
      const cur = queue.shift();
      const curEl = elById[cur];
      for (const edge of (adj[cur] || [])) {
        if (visited.has(edge.other)) continue;
        visited.add(edge.other);
        const child = elById[edge.other];
        if (child && child.type === 'kiosk' && child.reticId && curEl && curEl.reticId) {
          const krow = R.kiosks.find(k => k.id === child.reticId);
          if (krow) {
            krow.fedFrom = curEl.reticId;
            this._reticFed[krow.id] = edge.route.id;
            const len = this._routeLenM(edge.route, factor);
            if (len) krow.feederLength = this._len('len:feeder:' + krow.id, len, krow.feederLength);
            if (edge.route.cableType) krow.feederCable = edge.route.cableType;
            summary.feeders++;
          }
        }
        if (child && child.type === 'load') continue;   // a load ends its cable (step 6), it feeds nothing
        queue.push(edge.other);
      }
    }
  },

  // MV routes → each minisub's `mvFedFrom` (upstream minisub), mvLength and
  // mvCable. Within a connected MV group the upstream end is the minisub no
  // other one feeds already (an existing Demand choice is kept), else the
  // first in Demand's list. Non-minisub elements (RMUs, joints) are walked
  // through; the nearest minisub back along the path is the parent.
  _walkMvFeeds(pm, elById, factor, R, summary) {
    const adj = {};
    const addEdge = (u, v, r) => { (adj[u] = adj[u] || []).push({ other: v, route: r }); };
    for (const r of pm.routes) {
      if (r.type !== 'mv' || !r.fromId || !r.toId) continue;
      addEdge(r.fromId, r.toId, r); addEdge(r.toId, r.fromId, r);
    }
    const rowOf = (id) => { const el = elById[id]; return el && el.type === 'minisub' && el.reticId
      ? R.minisubs.find(m => m.id === el.reticId) || null : null; };
    const order = (row) => R.minisubs.indexOf(row);
    const seen = new Set();
    for (const startId of Object.keys(adj)) {
      if (seen.has(startId)) continue;
      const comp = []; const stack = [startId]; seen.add(startId);
      while (stack.length) {
        const id = stack.pop(); comp.push(id);
        for (const e of adj[id]) if (!seen.has(e.other)) { seen.add(e.other); stack.push(e.other); }
      }
      const rows = comp.map(rowOf).filter(Boolean);
      if (!rows.length) continue;
      const inComp = new Set(rows.map(r => r.id));
      const roots = rows.filter(r => !inComp.has(r.mvFedFrom));
      const rootRow = (roots.length ? roots : rows).sort((a, b) => order(a) - order(b))[0];
      const rootId = comp.find(id => rowOf(id) === rootRow);
      rootRow.mvFedFrom = '';
      if (adj[rootId] && adj[rootId][0]) this._reticFed['ms:' + rootRow.id] = adj[rootId][0].route.id;
      this._mvSupplyCable(adj, elById, rootId, rootRow, factor);
      if (rows.length < 2) continue;
      const visited = new Set([rootId]);
      const q = [{ id: rootId, parent: rootRow, len: 0, cable: '' }];
      while (q.length) {
        const cur = q.shift();
        for (const e of adj[cur.id] || []) {
          if (visited.has(e.other)) continue;
          visited.add(e.other);
          const len = +(cur.len + (this._routeLenM(e.route, factor) || 0)).toFixed(2);
          const cable = cur.cable || e.route.cableType || '';
          const row = rowOf(e.other);
          if (row && row !== cur.parent) {
            row.mvFedFrom = cur.parent.id;
            this._reticFed['ms:' + row.id] = e.route.id;
            if (len) row.mvLength = this._len('len:mv:' + row.id, len, row.mvLength);
            if (cable) row.mvCable = cable;
            summary.mvFeeds = (summary.mvFeeds || 0) + 1;
            q.push({ id: e.other, parent: row, len: 0, cable: '' });
          } else {
            q.push({ id: e.other, parent: cur.parent, len, cable });
          }
        }
      }
    }
  },

  // The feeding end of the MV network: the top minisub of a group reached from
  // an RMU (through joints) carries that supply cable's length and cable.
  _mvSupplyCable(adj, elById, rootId, rootRow, factor) {
    const visited = new Set([rootId]);
    const q = [{ id: rootId, len: 0, cable: '' }];
    while (q.length) {
      const cur = q.shift();
      for (const e of adj[cur.id] || []) {
        if (visited.has(e.other)) continue;
        visited.add(e.other);
        const el = elById[e.other];
        if (!el || el.type === 'minisub') continue;
        const len = +(cur.len + (this._routeLenM(e.route, factor) || 0)).toFixed(2);
        const cable = cur.cable || e.route.cableType || '';
        if (el.type === 'rmu') {
          if (len) rootRow.mvLength = this._len('len:mv:' + rootRow.id, len, rootRow.mvLength);
          if (cable) rootRow.mvCable = cable;
          return;
        }
        q.push({ id: e.other, len, cable });
      }
    }
  },

  // ─── Reticulation kept in sync (Settings › Keep workspaces in sync) ───
  // The sync pass runs syncRetic a moment after each edit: what is drawn on
  // the site plan goes to Demand (pushToSchedules, non-interactive), and a
  // deletion on either side is carried to the other. As with Building, what
  // the pass removes is kept in a record: when the deleted item comes back
  // (undo) the pass puts the removed side back, and when it goes again
  // (redo) the pass removes it again.
  RETIC_TYPES: ['minisub', 'kiosk', 'erf', 'load'],
  _reticSrc: {},           // override key → plan-measured length (m), last pass
  _reticFed: {},           // kiosk id / 'ms:'+minisub id → the drawn route setting its Fed from
  _reticLinks: new Map(),  // plan element id → { type, rowId } as of the last pass
  _reticAuto: new Set(),   // Demand rows the pass created (this session)
  _reticPairs: [],

  reticInUse() {
    const pm = AppState.planMarkup, R = AppState.reticulation;
    if (!pm || !R || !pm.settings || pm.settings.domain !== 'retic') return false;
    return this._reticLinks.size > 0 || this._reticPairs.length > 0
      || pm.elements.some(e => this.RETIC_TYPES.includes(e.type));
  },

  // Everything the Reticulation sync reads and writes, to tell whether a pass
  // changed anything.
  reticFingerprint() {
    const R = AppState.reticulation, pm = AppState.planMarkup;
    const els = pm.elements.filter(e => this.RETIC_TYPES.includes(e.type)).map(e => [e.id, e.reticId || null, e.name]);
    const keys = new Set(pm.routes.map(r => r.id));
    return AppState._hashText(JSON.stringify([R.minisubs, R.kiosks, els, keys.size, AppState.syncOverrides || null]));
  },

  // A Demand row by id: { kind, row, list, index, kiosk? } or null.
  _reticRow(id) {
    const R = AppState.reticulation;
    if (!R || !id) return null;
    let i = R.minisubs.findIndex(m => m.id === id);
    if (i >= 0) return { kind: 'minisub', row: R.minisubs[i], list: R.minisubs, index: i };
    i = R.kiosks.findIndex(k => k.id === id);
    if (i >= 0) return { kind: 'kiosk', row: R.kiosks[i], list: R.kiosks, index: i };
    for (const k of R.kiosks) {
      i = k.erfs.findIndex(e => e.id === id);
      if (i >= 0) return { kind: 'erf', row: k.erfs[i], list: k.erfs, index: i, kiosk: k };
    }
    for (const o of [...R.minisubs, ...R.kiosks]) {       // custom loads
      i = (o.loads || []).findIndex(l => l.id === id);
      if (i >= 0) return { kind: 'load', row: o.loads[i], list: o.loads, index: i, owner: o };
    }
    return null;
  },
  _reticRowName(f) {
    if (f.kind === 'load') return f.row.name || 'Custom load';
    return f.kind === 'erf' ? `Erf ${f.row.erfNumber || ''}`.trim() : (f.row.name || (f.kind === 'kiosk' ? 'Kiosk' : 'Minisub'));
  },

  // Take Demand rows away, keeping copies to put back. Kiosks fed from a
  // removed kiosk or minisub close up the chain, as Demand's own delete does.
  _reticRemoveRows(ids) {
    const R = AppState.reticulation;
    const saved = [];
    for (const id of ids) {
      const f = this._reticRow(id);
      if (!f) continue;
      if (f.kind === 'minisub' && R.minisubs.length <= 1) continue;   // Demand keeps one
      const rec = { kind: f.kind, row: JSON.parse(JSON.stringify(f.row)), index: f.index, kioskId: f.kiosk ? f.kiosk.id : null, ownerId: f.owner ? f.owner.id : null, moved: [] };
      f.list.splice(f.index, 1);
      if (f.kind !== 'erf' && f.kind !== 'load') {
        const to = f.kind === 'kiosk' ? (f.row.fedFrom || (R.minisubs[0] && R.minisubs[0].id)) : (R.minisubs[0] && R.minisubs[0].id);
        for (const k of R.kiosks) if (k.fedFrom === id) { rec.moved.push(k.id); k.fedFrom = to; }
        if (f.kind === 'minisub') for (const m of R.minisubs) if (m.mvFedFrom === id) m.mvFedFrom = '';
      }
      saved.push(rec);
    }
    return saved;
  },

  _reticRestoreRows(saved) {
    const R = AppState.reticulation;
    for (const rec of saved || []) {
      if (this._reticRow(rec.row.id)) continue;
      const row = JSON.parse(JSON.stringify(rec.row));
      let list;
      if (rec.kind === 'load') {
        const o = [...R.minisubs, ...R.kiosks].find(x => x.id === rec.ownerId);
        if (!o) continue;
        list = o.loads || (o.loads = []);
      } else if (rec.kind === 'erf') {
        const k = R.kiosks.find(x => x.id === rec.kioskId);
        if (!k) continue;
        list = k.erfs;
      } else list = rec.kind === 'kiosk' ? R.kiosks : R.minisubs;
      list.splice(Math.min(rec.index, list.length), 0, row);
      for (const kid of rec.moved || []) { const k = R.kiosks.find(x => x.id === kid); if (k) k.fedFrom = row.id; }
    }
  },

  // Drawn elements (and the routes ending on them) taken off the site plan,
  // in place (pm.elements / pm.routes are the active floor's own arrays).
  _reticRemovePlan(elIds) {
    const pm = AppState.planMarkup;
    const ids = new Set(elIds);
    const saved = { els: [], routes: [] };
    for (let i = pm.elements.length - 1; i >= 0; i--) {
      if (ids.has(pm.elements[i].id)) saved.els.unshift(JSON.parse(JSON.stringify(pm.elements.splice(i, 1)[0])));
    }
    for (let i = pm.routes.length - 1; i >= 0; i--) {
      const r = pm.routes[i];
      if (ids.has(r.fromId) || ids.has(r.toId)) saved.routes.unshift(JSON.parse(JSON.stringify(pm.routes.splice(i, 1)[0])));
    }
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds) for (const id of ids) PlanMarkup.selectedIds.delete(id);
    return saved;
  },

  _reticRestorePlan(saved) {
    const pm = AppState.planMarkup;
    if (!saved) return;
    for (const e of saved.els) if (!pm.elements.some(x => x.id === e.id)) pm.elements.push(JSON.parse(JSON.stringify(e)));
    for (const r of saved.routes) if (!pm.routes.some(x => x.id === r.id)) pm.routes.push(JSON.parse(JSON.stringify(r)));
  },

  _reticDeletions(notice) {
    const pm = AppState.planMarkup;
    const inPlan = () => new Set(pm.elements.map(e => e.id));
    const links = this._reticLinks;
    const delPlan = typeof Sync !== 'undefined' ? Sync.takeDeleted('plan', id => links.has(id)) : new Set();
    const delRetic = typeof Sync !== 'undefined' ? Sync.takeDeleted('retic') : new Set();

    // 1. Earlier deletions: undo brought the deleted item back → put back what
    //    the pass removed; redo took it away again → remove it again.
    let here = inPlan();
    for (const p of this._reticPairs) {
      const back = p.origin === 'plan' ? p.originIds.some(id => here.has(id)) : p.originIds.some(id => this._reticRow(id));
      if (p.state === 'removed' && back) {
        if (p.origin === 'plan') this._reticRestoreRows(p.saved); else this._reticRestorePlan(p.saved);
        p.state = 'restored'; here = inPlan();
      } else if (p.state === 'restored' && !back) {
        if (p.origin === 'plan') p.saved = this._reticRemoveRows(p.saved.map(r => r.row.id));
        else p.saved = this._reticRemovePlan(p.saved.els.map(e => e.id));
        p.state = 'removed'; here = inPlan();
      }
    }

    // 2. Drawn elements deleted on the plan → their Demand rows. An element an
    //    undo took away (not a delete) takes its row only if the pass had
    //    created it; a row that was there before stays, as "not placed yet".
    const gonePlan = [], rowIds = [], names = [];
    for (const [elId, link] of links) {
      if (here.has(elId)) continue;
      const f = this._reticRow(link.rowId);
      const marked = delPlan.has(elId);
      if (f && f.kind === link.type && (marked || this._reticAuto.has(link.rowId))) {
        gonePlan.push(elId); rowIds.push(link.rowId);
        if (marked) names.push(this._reticRowName(f));
      }
    }
    if (rowIds.length) {
      const saved = this._reticRemoveRows(rowIds);
      if (saved.length) this._reticAddPair({ origin: 'plan', originIds: gonePlan, saved, state: 'removed' });
      if (names.length) notice(`${this._names(names)} removed from Demand too · Undo on the plan puts ${names.length === 1 ? 'it' : 'them'} back`);
    }

    // 3. Demand rows deleted in Demand → their drawn elements (and the cables
    //    ending on them). Stands drawn for the erven of a deleted kiosk stay.
    if (delRetic.size) {
      const els = pm.elements.filter(e => this.RETIC_TYPES.includes(e.type) && e.reticId && delRetic.has(e.reticId) && !this._reticRow(e.reticId));
      if (els.length) {
        const saved = this._reticRemovePlan(els.map(e => e.id));
        this._reticAddPair({ origin: 'retic', originIds: [...new Set(els.map(e => e.reticId))], saved, state: 'removed' });
        notice(`${this._names(els.map(e => e.name || e.type))} removed from the site plan too · Undo in Demand puts ${els.length === 1 ? 'it' : 'them'} back`);
      }
    }
  },

  _names(list) {
    return `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
  },

  // A newer deletion of the same items replaces older records about them.
  _reticAddPair(p) {
    const ids = (q) => new Set([...q.originIds, ...(q.origin === 'plan' ? q.saved.map(r => r.row.id) : q.saved.els.map(e => e.id))]);
    const mine = ids(p);
    this._reticPairs = this._reticPairs.filter(q => ![...ids(q)].some(id => mine.has(id)));
    this._reticPairs.push(p);
    if (this._reticPairs.length > this.PAIRS_KEPT) this._reticPairs.splice(0, this._reticPairs.length - this.PAIRS_KEPT);
  },

  // The sync pass's Reticulation routine. Returns whether anything changed.
  syncRetic(opts = {}) {
    const notice = opts.notice || (() => {});
    const before = this.reticFingerprint();
    this._reticDeletions(notice);
    const summary = this._pushCore({ interactive: false, issue: opts.issue, value: opts.value });
    if (summary) for (const id of summary.created) this._reticAuto.add(id);
    // Remember what each drawn element stands for, to tell a deletion later.
    const links = new Map();
    for (const e of AppState.planMarkup.elements) {
      if (!this.RETIC_TYPES.includes(e.type) || !e.reticId) continue;
      const f = this._reticRow(e.reticId);
      if (f && f.kind === e.type) links.set(e.id, { type: e.type, rowId: e.reticId });
    }
    this._reticLinks = links;
    this._reticDuplicates(opts.issue || (() => {}));
    return this.reticFingerprint() !== before;
  },

  // Two minisubs or two kiosks with the same name, or two erven with the same
  // number under one kiosk, go on the Issues list: a newly drawn item with
  // that name could be matched to either row. Names compare as the sync
  // matches them (case and outer spaces ignored).
  _reticDuplicates(issue) {
    const R = AppState.reticulation;
    const norm = (v) => String(v || '').trim().toLowerCase();
    const report = (rows, nameOf, what, where) => {
      const by = new Map();
      for (const r of rows) {
        const k = norm(nameOf(r));
        if (!k) continue;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(r);
      }
      for (const [k, list] of by) {
        if (list.length < 2) continue;
        const shown = String(nameOf(list[0])).trim();
        issue(`retic-dup:${what}:${where ? where.id + ':' : ''}${k}`,
          what === 'erf'
            ? `${list.length} erven under ${where.name || 'a kiosk'} are numbered ${shown} in Demand. Renumber one so a newly drawn erf cannot be linked to the wrong row.`
            : `${list.length} ${what}s are called "${shown}" in Demand. Rename one so a newly drawn ${what} cannot be linked to the wrong row.`,
          { kind: 'retic-rows', ids: list.map(r => r.id) });
      }
    };
    report(R.minisubs, m => m.name, 'minisub');
    report(R.kiosks, k => k.name, 'kiosk');
    for (const k of R.kiosks) report(k.erfs, e => e.erfNumber, 'erf', k);
  },

  // ── "Not placed yet": Demand rows no drawn element stands for ──
  reticUnplaced() {
    const R = AppState.reticulation, pm = AppState.planMarkup;
    if (!R || !pm) return { minisubs: [], kiosks: [], erven: [], loads: [] };
    const placed = new Set(pm.elements.filter(e => this.RETIC_TYPES.includes(e.type) && e.reticId).map(e => e.reticId));
    // A new project's untouched default minisub is not listed: the first
    // minisub drawn takes it over.
    const blank = (m) => m.id === 'source' && !R.kiosks.length;
    return {
      minisubs: R.minisubs.filter(m => !placed.has(m.id) && !blank(m)),
      kiosks: R.kiosks.filter(k => !placed.has(k.id)),
      erven: R.kiosks.map(k => ({ kiosk: k, erfs: k.erfs.filter(e => !placed.has(e.id)) })).filter(g => g.erfs.length),
      loads: [...R.minisubs, ...R.kiosks].flatMap(o => (o.loads || []).filter(l => !placed.has(l.id)).map(l => ({ row: l, owner: o }))),
    };
  },

  // Place a Demand row on the site plan as a linked element.
  placeFromDemand(rowId, x, y) {
    const f = this._reticRow(rowId);
    if (!f) return null;
    const pm = AppState.planMarkup;
    if (pm.elements.some(e => e.reticId === rowId)) return null;
    let props = PLAN_DEFS.defaults(f.kind);
    if (f.kind === 'load') {       // a custom load: fed from the drawn supply, when that is on the plan
      const sup = pm.elements.find(e => e.reticId === f.owner.id && (e.type === 'kiosk' || e.type === 'minisub'));
      props = { loadType: f.row.loadType, fedFrom: sup ? sup.id : '', kw: f.row.kw === 0 ? '' : (f.row.kw || ''), cableType: f.row.cableType || '', motor: f.row.motor || '' };
    }
    const el = {
      id: AppState.planGenId('pmel'), type: f.kind, x, y, rotation: 0,
      name: f.kind === 'erf' ? (f.row.erfNumber || '') : (f.row.name || ''),
      reticId: rowId, props,
    };
    pm.elements.push(el);
    return el;
  },

  // Connected components of SL routes → circuits. Each: {sourceReticId, source,
  // poles:[{name, spacing, cumulative, cable}]}. Ordered by BFS from the source
  // element (a kiosk if present), spacing = feeding-route length.
  buildSLCircuits(factor) {
    const pm = AppState.planMarkup;
    if (factor === undefined) factor = this._factor();
    const elById = this._elById();
    const adj = {};
    const addEdge = (u, v, r) => { (adj[u] = adj[u] || []).push({ other: v, route: r }); };
    const slEls = new Set();
    for (const r of pm.routes) {
      if (this._effectiveType(r, elById) !== 'sl') continue;
      if (!r.fromId || !r.toId) continue;
      addEdge(r.fromId, r.toId, r); addEdge(r.toId, r.fromId, r);
      slEls.add(r.fromId); slEls.add(r.toId);
    }
    const circuits = [];
    const seen = new Set();
    for (const startId of slEls) {
      if (seen.has(startId)) continue;
      const startEl = elById[startId];
      // Prefer a kiosk as the circuit source; otherwise start anywhere.
      // Collect the component first.
      const comp = [];
      const stack = [startId];
      const local = new Set([startId]);
      while (stack.length) {
        const id = stack.pop(); comp.push(id);
        for (const e of (adj[id] || [])) if (!local.has(e.other)) { local.add(e.other); stack.push(e.other); }
      }
      comp.forEach(id => seen.add(id));
      const sourceEl = comp.map(id => elById[id]).find(e => e && e.type === 'kiosk')
        || comp.map(id => elById[id]).find(e => e && e.type !== 'pole') || elById[comp[0]];
      // BFS from source to order poles with cumulative distance
      const poles = [];
      const visited = new Set([sourceEl.id]);
      const q = [{ id: sourceEl.id, cum: 0 }];
      let idx = 0;
      while (q.length) {
        const { id, cum } = q.shift();
        for (const e of (adj[id] || [])) {
          if (visited.has(e.other)) continue;
          visited.add(e.other);
          const other = elById[e.other];
          const seg = this._routeLenM(e.route, factor);
          const cumN = +(cum + seg).toFixed(2);
          if (other && other.type === 'pole') {
            poles.push({
              name: other.name || `P${++idx}`,
              phase: this.PHASES[poles.length % 3],
              spacing: seg, cumulative: cumN,
              cable: e.route.cableType || '',
            });
          }
          q.push({ id: e.other, cum: cumN });
        }
      }
      if (poles.length) {
        circuits.push({
          sourceReticId: sourceEl.type === 'kiosk' ? sourceEl.reticId : null,
          source: sourceEl.name || sourceEl.type,
          poles,
        });
      }
    }
    return circuits;
  },

  // ── EE-5: feeder direction from the SLD supply topology ──
  // Which of two linked boards feeds the other, inferred from the SLD (the end
  // with a source path that doesn't pass through the other end is upstream).
  // Returns the upstream plan element, or null when ambiguous (both/neither).
  _inferUpstream(elA, elB) {
    const compA = elA.sldId && AppState.components.get(elA.sldId);
    const compB = elB.sldId && AppState.components.get(elB.sldId);
    if (!compA || !compB) return null;
    const aSup = this._reachesSupply(compA.id, compB.id);
    const bSup = this._reachesSupply(compB.id, compA.id);
    if (aSup && !bSup) return elA;
    if (bSup && !aSup) return elB;
    return null;
  },
  // Does `startId` reach a supply component without passing through `blockId`?
  // `blockId` may be a single id or any iterable of ids (a riser shaft blocks
  // every other board on the shaft at once).
  _reachesSupply(startId, blockId) {
    const SUP = new Set(['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery', 'grid', 'transformer']);
    const wires = [...AppState.wires.values()];
    const neigh = (id) => wires.filter(w => w.fromComponent === id || w.toComponent === id)
      .map(w => (w.fromComponent === id ? w.toComponent : w.fromComponent));
    const blocked = (blockId && typeof blockId !== 'string' && blockId[Symbol.iterator]) ? [...blockId] : [blockId];
    const seen = new Set([startId, ...blocked]);
    const q = [startId];
    while (q.length) {
      const cur = q.shift();
      const c = AppState.components.get(cur);
      if (c && cur !== startId && SUP.has(c.type)) return true;
      for (const n of neigh(cur)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    return false;
  },

  // Reflect SLD cables that join two linked plan elements as plan feeders
  // (any linked building element — boards or adopted supply). Idempotent;
  // returns the number of feeders created. Called on sync and on placement.
  reflectSldFeeders() {
    const pm = AppState.planMarkup;
    const comps = AppState.components;
    const allEls = AppState.planAllElements();
    const floorMap = AppState.planEntityFloorMap();   // elId → floor
    const linkedBySld = {};
    for (const el of allEls) if (el.sldId) linkedBySld[el.sldId] = el;
    // Any bus section of a switchboard resolves to that switchboard element.
    const swBusToEl = {};
    for (const el of allEls) if (el.type === 'bd_switchboard' && Array.isArray(el.sldBuses)) {
      for (const bid of el.sldBuses) swBusToEl[bid] = el;
    }
    const wires = [...AppState.wires.values()];
    const neigh = (id) => wires.filter(w => w.fromComponent === id || w.toComponent === id)
      .map(w => (w.fromComponent === id ? w.toComponent : w.fromComponent));
    const WALK = new Set(['cb', 'fuse', 'switch']);
    // A cable endpoint may be a DB/switchboard directly, an outgoing bus owned
    // by a DB, or reachable through a board breaker (bus → CB → cable).
    const resolve = (compId, from, depth) => {
      if (linkedBySld[compId]) return { el: linkedBySld[compId], viaBus: false };
      if (swBusToEl[compId]) return { el: swBusToEl[compId], viaBus: true };
      const c = comps.get(compId);
      if (!c) return null;
      if (c.type === 'bus' && c.busOwner && linkedBySld[c.busOwner]) return { el: linkedBySld[c.busOwner], viaBus: true };
      if (WALK.has(c.type) && (depth || 0) < 3) {
        for (const n of neigh(compId)) {
          if (n === from) continue;
          const r = resolve(n, compId, (depth || 0) + 1);
          if (r) return r;
        }
      }
      return null;
    };
    let made = 0;
    for (const cable of [...comps.values()].filter(c => c.type === 'cable')) {
      const ends = [];
      for (const w of AppState.wires.values()) {
        const other = w.fromComponent === cable.id ? w.toComponent : (w.toComponent === cable.id ? w.fromComponent : null);
        if (!other) continue;
        const r = resolve(other, cable.id, 0);
        if (r && !ends.some(e => e.el === r.el)) ends.push(r);
      }
      if (ends.length !== 2) continue;
      // Upstream = the end reached via an outgoing bus (that DB is feeding);
      // else infer from the SLD supply path (EE-5); else keep wire order.
      let up = ends.find(e => e.viaBus);
      if (!up) {
        const inf = this._inferUpstream(ends[0].el, ends[1].el);
        up = (inf === ends[1].el) ? ends[1] : ends[0];
      }
      let down = ends.find(e => e !== up) || ends[1];
      const elA = up.el, elB = down.el;
      const exists = AppState.planAllRoutes().some(r => r.type === 'feeder' &&
        ((r.fromId === elA.id && r.toId === elB.id) || (r.fromId === elB.id && r.toId === elA.id)));
      if (exists) continue;
      // A single plan route can only join two elements on the same floor; a
      // cross-floor feeder is represented by the SLD cable alone (its length
      // already carries the vertical riser run). Skip drawing a plan route.
      const flA = floorMap.get(elA.id), flB = floorMap.get(elB.id);
      if (flA && flB && flA.id !== flB.id) continue;
      const route = {
        id: AppState.planGenId('pmrt'), type: 'feeder',
        fromId: elA.id, toId: elB.id,
        points: [{ x: elA.x, y: elA.y, snappedTo: elA.id }, { x: elB.x, y: elB.y, snappedTo: elB.id }],
        cableType: cable.props.name || '', curved: false, props: {}, sldCableId: cable.id,
        _autoReflected: true,   // EE-6: an auto 2-point chord, not a user route
      };
      // Push onto the floor the boards live on (default: active floor).
      const targetFloor = flA || AppState.planActiveFloor();
      if (targetFloor && targetFloor.id !== pm.activeFloorId) targetFloor.data.routes.push(route);
      else pm.routes.push(route);
      cable.planLink = route.id;
      // Keep the upstream DB's schedule consistent for reverse-drawn feeders.
      if (elA.type === 'bd_db' && elB.type === 'bd_db' && elA.sldId && elB.sldId) {
        const ca = comps.get(elA.sldId), cb = comps.get(elB.sldId);
        if (ca && cb) this._ensureFeederCircuit(ca, cb, cable.props.name, 0);
      }
      made++;
    }
    return made;
  },

  // The single outgoing busbar below a feeding DB (created on demand, shared by
  // all of that DB's sub-board feeders). Wired DB(out) → bus(top).
  _ensureOutBus(dbComp) {
    let bus = dbComp.outBusId ? AppState.components.get(dbComp.outBusId) : null;
    if (!bus) bus = [...AppState.components.values()].find(c => c.type === 'bus' && c.busOwner === dbComp.id);
    if (!bus) {
      bus = AppState.addComponent('bus', dbComp.x, dbComp.y + 70);
      bus.props.name = (dbComp.props.name || 'DB') + ' Bus';
      bus.busOwner = dbComp.id;
      AppState.addWire(dbComp.id, 'out', bus.id, 'top', true);
    }
    dbComp.outBusId = bus.id;
    return bus;
  },

  // Where a feeder cable attaches on the SLD for a plan element acting as the
  // upstream (source) end: a DB feeds via its shared outgoing bus; a
  // switchboard feeds straight off its (primary section) bus.
  _feederSourcePoint(el) {
    const comp = AppState.components.get(el.sldId);
    if (!comp) return null;
    if (el.type === 'bd_switchboard') return { compId: el.sldId, port: 'bottom' };
    if (el.type === 'bd_db') return { compId: this._ensureOutBus(comp).id, port: 'bottom' };
    return { compId: el.sldId, port: 'out' };
  },
  // …and for the downstream (fed) end: a DB takes its incomer 'in'; a
  // switchboard takes the feed on its bus.
  _feederSinkPoint(el) {
    if (!AppState.components.get(el.sldId)) return null;
    if (el.type === 'bd_switchboard') return { compId: el.sldId, port: 'top' };
    return { compId: el.sldId, port: 'in' };
  },

  // Resolve a route's cable type (a name in the one cable library) and copy
  // its electrical parameters onto an SLD cable component (EE-4), linking it
  // by `standard_type` so the SLD, BOQ and cable schedule all see the same
  // cable. Returns the library entry (or null).
  _applyCableElectrical(cable, cableType) {
    if (!cableType) return null;
    const c = CableLib.byName(cableType);
    if (!c) return null;
    cable.props.standard_type = c.id;
    cable.props.r_per_km = c.r_per_km;
    cable.props.x_per_km = c.x_per_km;
    cable.props.r0_per_km = c.r0_per_km || 0;
    cable.props.x0_per_km = c.x0_per_km || 0;
    if (c.rated_amps) cable.props.rated_amps = c.rated_amps;
    cable.props.size_mm2 = c.size_mm2;
    // Building feeders are 400 V; an MV library cable keeps its own voltage.
    cable.props.voltage_kv = CableLib.isMV(c) ? c.voltage_kv : 0.4;
    return c;
  },

  // Record/refresh a "Feeder to Sub-board" way in the upstream DB's schedule.
  _ensureFeederCircuit(dbComp, subComp, cableType, lenM) {
    if (!Array.isArray(dbComp.props.circuits)) dbComp.props.circuits = [];
    const circuits = dbComp.props.circuits;
    let c = circuits.find(x => x.type === 'feeder_db' && x.feedsDbId === subComp.id);
    if (!c) {
      // Via DBSchedule.newWay so this stays in step with the editor's own
      // blank way — this literal previously omitted power_factor entirely,
      // which left the board PF rollup reading a feeder as pf 0.
      c = DBSchedule.newWay(circuits.length, {
        type: 'feeder_db', poles: '3P', phase: 'RWB', breaker_a: 63, curve: 'C',
        cable_mm2: 25, ecc_mm2: 16, cable_m: 0, feedsDbId: subComp.id,
      });
      circuits.push(c);
    }
    // A way linked to its drawn breaker / cable (dbfeeders.js) takes its
    // description, cable, length and downstream demand from them: writing the
    // plan's figures here too made the two routines undo each other on every
    // pass.
    if (c.sld && (c.sld.cable || c.sld.device)) return;
    c.description = 'Feeder to ' + (subComp.props.name || 'Sub-board');
    if (typeof BreakerSet !== 'undefined') BreakerSet.fillNew(dbComp, c);
    if (cableType) {
      c.cable = cableType;
      // EE-9: size the feeder conductor from the chosen cable type.
      const lc = CableLib.byName(cableType);
      if (lc) { c.cable = lc.name; c.cable_mm2 = lc.size_mm2; if (lc.rated_amps) c._cableAmps = lc.rated_amps; }
    }
    if (lenM) c.cable_m = +lenM.toFixed(2);
    // EE-9: read-only downstream demand carried by this feeder, plus a warning
    // when the sub-board's diversified demand exceeds the feeder breaker.
    const demandKva = (Number(subComp.props.rated_kva) || 0) * demandFactorOr1(subComp.props.demand_factor);
    c.downstream_kva = +demandKva.toFixed(2);
    c.downstream_a = +((demandKva * 1000) / (Math.sqrt(3) * 400)).toFixed(1);
  },

  // Drop "Feeder to Sub-board" ways whose feeder no longer exists on the SLD
  // (the outgoing bus no longer has a cable to that sub-board).
  _pruneFeederCircuits() {
    for (const db of AppState.components.values()) {
      if (db.type !== 'distribution_board' || !Array.isArray(db.props.circuits)) continue;
      const outBus = db.outBusId ? AppState.components.get(db.outBusId) : null;
      db.props.circuits = db.props.circuits.filter(c => {
        if (c.type !== 'feeder_db') return true;
        if (c.sld) return true;   // drawn on the SLD — DBFeeders keeps it
        if (!outBus) return false;
        // keep only if a cable still links this bus to c.feedsDbId
        return [...AppState.components.values()].some(cab => {
          if (cab.type !== 'cable') return false;
          const wired = (tgt) => [...AppState.wires.values()].some(w =>
            (w.fromComponent === cab.id && w.toComponent === tgt) || (w.toComponent === cab.id && w.fromComponent === tgt));
          return wired(outBus.id) && wired(c.feedsDbId);
        });
      });
    }
  },

  // Remove any outgoing bus that no longer carries a downstream feeder cable
  // (or whose owner DB is gone), and clear the owner's back-ref.
  _pruneEmptyOutBuses() {
    for (const bus of [...AppState.components.values()]) {
      if (bus.type !== 'bus' || !bus.busOwner) continue;
      const owner = AppState.components.get(bus.busOwner);
      const hasCable = [...AppState.wires.values()].some(w => {
        const other = w.fromComponent === bus.id ? w.toComponent : (w.toComponent === bus.id ? w.fromComponent : null);
        const oc = other && AppState.components.get(other);
        return oc && oc.type === 'cable';
      });
      if (!owner || !hasCable) {
        if (owner && owner.outBusId === bus.id) owner.outBusId = null;
        AppState.removeComponent(bus.id);
      }
    }
  },

  // Adopt an existing SLD component into the building plan at (x,y): create a
  // linked plan element rendering as the mapped building symbol, then reflect
  // any existing SLD cables to it as plan feeders (auto-feeder on placement).
  placeFromSld(sldId, x, y) {
    const comp = AppState.components.get(sldId);
    if (!comp) return null;
    if (comp.type === 'bus') return this.placeSwitchboard(sldId, x, y);
    const type = (PLAN_DEFS.sldLinkTypes && PLAN_DEFS.sldLinkTypes[comp.type]) || 'bd_db';
    const el = {
      id: AppState.planGenId('pmel'), type, x, y, rotation: 0,
      name: (comp.props && comp.props.name) || '', reticId: null, sldId: comp.id, props: {},
    };
    AppState.planMarkup.elements.push(el);
    comp.planLink = el.id;
    this.reflectSldFeeders();   // draw feeders for any existing SLD cables now complete
    return el;
  },

  // Bus sections + their CBs/fuses/ducts that form one switchboard. Sections
  // are buses joined by a coupler (CB directly between two buses) or a bus
  // duct; members also include the CBs/fuses/ducts wired to any section bus.
  sldSwitchboardGroup(startBusId) {
    const comps = AppState.components;
    const wires = [...AppState.wires.values()];
    const neigh = (id) => wires.filter(w => w.fromComponent === id || w.toComponent === id)
      .map(w => (w.fromComponent === id ? w.toComponent : w.fromComponent));
    const LINK = new Set(['cb', 'fuse', 'switch', 'bus_duct']);
    const busSet = new Set([startBusId]);
    const q = [startBusId];
    while (q.length) {
      const b = q.shift();
      for (const n of neigh(b)) {
        const c = comps.get(n);
        if (!c || !LINK.has(c.type)) continue;
        // buses on the other side of this link → same switchboard (coupler/duct)
        for (const ob of neigh(n)) {
          const oc = comps.get(ob);
          if (oc && oc.type === 'bus' && !busSet.has(ob)) { busSet.add(ob); q.push(ob); }
        }
      }
    }
    const busIds = [...busSet];
    const members = new Set(busIds);
    for (const b of busIds) for (const n of neigh(b)) {
      const c = comps.get(n);
      if (c && LINK.has(c.type)) members.add(n);   // couplers, ducts + board CBs/fuses
    }
    const primaryBusId = busIds.slice().sort()[0];
    const name = (comps.get(primaryBusId).props.name) || 'Switchboard';
    return { busIds, primaryBusId, members: [...members], name };
  },

  // All switchboard groups on the SLD (one per connected bus set).
  sldSwitchboardGroups() {
    const comps = AppState.components;
    const seen = new Set(), groups = [];
    for (const c of comps.values()) {
      if (c.type !== 'bus' || seen.has(c.id) || c.busOwner) continue;  // skip DB outgoing buses
      const g = this.sldSwitchboardGroup(c.id);
      g.busIds.forEach(id => seen.add(id));
      groups.push(g);
    }
    return groups;
  },

  // Adopt a bus (and its group) as a Switchboard plan element.
  placeSwitchboard(busId, x, y) {
    const g = this.sldSwitchboardGroup(busId);
    const el = {
      id: AppState.planGenId('pmel'), type: 'bd_switchboard', x, y, rotation: 0,
      name: g.name, reticId: null, sldId: g.primaryBusId,
      sldBuses: g.busIds, sldMembers: g.members, sections: g.busIds.length,
      props: { sections: g.busIds.length },
    };
    AppState.planMarkup.elements.push(el);
    for (const mid of g.members) { const c = AppState.components.get(mid); if (c) c.swLink = el.id; }
    this.reflectSldFeeders();
    return el;
  },

  // ─── Manual linking of an already-drawn plan item to an SLD component ───
  // Candidates are SLD components of the matching type that no other (live)
  // plan item already owns. Returns [{ id, label }].
  linkCandidates(item, kind) {
    const comps = AppState.components;
    const out = [];
    if (kind === 'route') {
      if (item.type !== 'feeder') return out;
      const rtIds = new Set(AppState.planAllRoutes().map(r => r.id));
      for (const c of comps.values()) {
        if (c.type !== 'cable') continue;
        if (c.planLink && c.planLink !== item.id && rtIds.has(c.planLink)) continue;
        if (c.riserLink) continue;
        out.push({ id: c.id, label: (c.props && c.props.name) || 'Cable' });
      }
      return out;
    }
    const sldType = Object.keys(PLAN_DEFS.sldLinkTypes || {}).find(k => PLAN_DEFS.sldLinkTypes[k] === item.type);
    if (!sldType) return out;
    const elIds = new Set(AppState.planAllElements().map(e => e.id));
    const owned = (c, link) => link && link !== item.id && elIds.has(link);
    if (sldType === 'bus') {
      for (const g of this.sldSwitchboardGroups()) {
        const prim = comps.get(g.primaryBusId);
        if (prim && owned(prim, prim.swLink)) continue;
        out.push({ id: g.primaryBusId, label: g.name });
      }
      return out;
    }
    for (const c of comps.values()) {
      if (c.type !== sldType || owned(c, c.planLink)) continue;
      out.push({ id: c.id, label: (c.props && c.props.name) || (COMPONENT_DEFS[c.type] && COMPONENT_DEFS[c.type].name) || c.type });
    }
    return out;
  },

  // Link (sldId set) or unlink (falsy) a drawn plan item. The SLD name wins on
  // link so the next sync doesn't overwrite it with the plan's label.
  linkItemToSld(item, kind, sldId) {
    const comps = AppState.components;
    if (kind === 'route') {
      const old = item.sldCableId && comps.get(item.sldCableId);
      if (old && old.planLink === item.id) old.planLink = null;
      item.sldCableId = null;
      if (sldId) {
        const cab = comps.get(sldId);
        if (!cab) return;
        item.sldCableId = cab.id;
        cab.planLink = item.id;
        item._autoReflected = false;   // a user-drawn route, not an auto chord
        if (cab.props && cab.props.name && !item.cableType) item.cableType = cab.props.name;
      }
      return;
    }
    const isSb = item.type === 'bd_switchboard';
    const old = item.sldId && comps.get(item.sldId);
    if (old && old.planLink === item.id) old.planLink = null;
    if (isSb) {
      for (const c of comps.values()) if (c.swLink === item.id) c.swLink = null;
      item.sldBuses = item.sldMembers = null;
    }
    item.sldId = null;
    if (!sldId) return;
    const comp = comps.get(sldId);
    if (!comp) return;
    if (isSb) {
      const g = this.sldSwitchboardGroup(sldId);
      item.sldId = g.primaryBusId; item.sldBuses = g.busIds; item.sldMembers = g.members;
      item.sections = g.busIds.length; item.props = item.props || {}; item.props.sections = g.busIds.length;
      for (const mid of g.members) { const c = comps.get(mid); if (c) c.swLink = item.id; }
      item.name = g.name;
    } else {
      item.sldId = comp.id;
      comp.planLink = item.id;
      if (comp.props && comp.props.name) item.name = comp.props.name;
    }
    this.reflectSldFeeders();
  },

  // Collect entities on each side whose linked partner was deleted in the
  // other view — the set that deletion-propagation would remove. Cascades:
  // removing a board removes its feeders; removing a feeder removes its cable.
  // ── Deletions when the sync pass runs (no dialog) ──
  // A board, switchboard or feeder deleted in one view is removed in the other
  // (decision 2026-11-01: delete everywhere, with Undo). Telling a deletion
  // from an undo: a user's own delete is marked (Sync.markDeleted — by
  // AppState.removeComponent and PlanMarkup.deleteSelected outside a pass);
  // a counterpart missing without a mark was taken away by an undo and is
  // healed as before (SD-1). What the pass removes is kept in a pair record:
  // when the deleted item comes back (undo) the pass puts the removed side
  // back — a board with its schedule — and when it goes again (redo) the pass
  // removes it again.
  _pairs: [],
  PAIRS_KEPT: 50,

  _passDeletions(notice) {
    const comps = AppState.components;
    const delSld = typeof Sync !== 'undefined' ? Sync.takeDeleted('sld') : new Set();
    const delPlan = typeof Sync !== 'undefined' ? Sync.takeDeleted('plan') : new Set();
    const planIds = () => {
      const s = new Set();
      for (const e of AppState.planAllElements()) s.add(e.id);
      for (const r of AppState.planAllRoutes()) s.add(r.id);
      return s;
    };

    // 1. Earlier deletions: undo brought the deleted item back → restore what
    //    the pass removed; redo took it away again → remove it again.
    let inPlan = planIds();
    for (const p of this._pairs) {
      const back = p.origin === 'plan' ? p.originIds.some(id => inPlan.has(id)) : p.originIds.some(id => comps.has(id));
      if (p.state === 'removed' && back) { this._restorePair(p); p.state = 'restored'; inPlan = planIds(); }
      else if (p.state === 'restored' && !back) { this._removePair(p); p.state = 'removed'; inPlan = planIds(); }
    }

    // 2. Heal links an undo left dangling (not a user's delete).
    for (const e of AppState.planAllElements()) {
      if ((e.type === 'bd_db' || e.type === 'bd_switchboard') && e.sldId && !comps.get(e.sldId) && !delSld.has(e.sldId)) e.sldId = null;
    }
    for (const r of AppState.planAllRoutes()) {
      if (r.type === 'feeder' && r.sldCableId && !comps.get(r.sldCableId) && !delSld.has(r.sldCableId)) r.sldCableId = null;
      if (r.sldRiserCableId && !comps.get(r.sldRiserCableId)) r.sldRiserCableId = null;
    }
    // A single-line cable whose plan feeder the sync had drawn itself, and an
    // undo took away: the cable stays, and is drawn on the plan again.
    const auto = this._autoRoutes || new Set();
    for (const c of comps.values()) {
      if (c.type === 'cable' && c.planLink && !inPlan.has(c.planLink) && auto.has(c.planLink) && !delPlan.has(c.planLink)) c.planLink = null;
    }

    // 3. What is left are real deletions: carry them across, keep a record.
    const del = this._collectDeletions(AppState.planMarkup);
    if (!(del.boards + del.feeders)) return;
    const sldIds = [...del.sldComps].filter(id => comps.get(id));
    // An outgoing bus left with no cable would be pruned: take it with the
    // pair, so an undo puts the feeder back on it.
    const gone = new Set(sldIds);
    for (const c of comps.values()) {
      if (c.type !== 'bus' || gone.has(c.id) || !(c.busOwner || [...comps.values()].some(b => b.outBusId === c.id))) continue;
      const cables = [...AppState.wires.values()]
        .filter(w => w.fromComponent === c.id || w.toComponent === c.id)
        .map(w => (w.fromComponent === c.id ? w.toComponent : w.fromComponent))
        .filter(id => { const x = comps.get(id); return x && x.type === 'cable'; });
      if (cables.length && cables.every(id => gone.has(id))) { sldIds.push(c.id); gone.add(c.id); }
    }
    const planElIds = [...del.planEls], planRtIds = [...del.planRoutes];
    // Which deleted items each side's removal follows from.
    const sldOrigin = new Set();
    for (const id of sldIds) {
      const c = comps.get(id);
      for (const k of ['planLink', 'swLink', 'riserLink']) if (c[k] && !inPlan.has(c[k])) sldOrigin.add(c[k]);
    }
    const planOrigin = new Set();
    for (const e of AppState.planAllElements()) if (del.planEls.has(e.id) && e.sldId && !comps.get(e.sldId)) planOrigin.add(e.sldId);
    for (const r of AppState.planAllRoutes()) if (del.planRoutes.has(r.id) && r.sldCableId && !comps.get(r.sldCableId)) planOrigin.add(r.sldCableId);
    const names = [];
    for (const id of sldIds) { const c = comps.get(id); if (c.type === 'distribution_board') names.push(c.props.name || 'Board'); }
    for (const e of AppState.planAllElements()) if (del.planEls.has(e.id) && (e.type === 'bd_db' || e.type === 'bd_switchboard')) names.push(e.name || 'Board');
    if (sldIds.length && sldOrigin.size) {
      const p = { origin: 'plan', originIds: [...sldOrigin], sld: sldIds, plan: null, state: 'removed' };
      this._removePair(p); this._addPair(p);
    } else for (const id of sldIds) AppState.removeComponent(id);
    if (planElIds.length + planRtIds.length) {
      const p = { origin: 'sld', originIds: [...planOrigin], sld: null, plan: { els: planElIds, routes: planRtIds }, state: 'removed' };
      if (p.originIds.length) { this._removePair(p); this._addPair(p); }
      else this._removePlanItems(new Set(planElIds), new Set(planRtIds));
    }
    if (this._pairs.length > this.PAIRS_KEPT) this._pairs.splice(0, this._pairs.length - this.PAIRS_KEPT);
    const what = names.length
      ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
      : `${del.feeders} feeder${del.feeders === 1 ? '' : 's'}`;
    notice(`${what} removed in the other view too · Undo puts it back`);
  },

  // A newer deletion of the same items replaces older records about them
  // (otherwise an older record would read the newer removal as a redo).
  _addPair(p) {
    const ids = (q) => new Set([...q.originIds, ...(q.sld || []), ...(q.plan ? [...q.plan.els, ...q.plan.routes] : [])]);
    const mine = ids(p);
    this._pairs = this._pairs.filter(q => ![...ids(q)].some(id => mine.has(id)));
    this._pairs.push(p);
  },

  // Take one side of a pair away, keeping it (with its wires / floor) to put back.
  _removePair(p) {
    const comps = AppState.components;
    if (p.sld) {
      const ids = new Set(p.sld.filter(id => comps.has(id)));
      p.saved = {
        comps: [...ids].map(id => JSON.parse(JSON.stringify(comps.get(id)))),
        wires: [...AppState.wires.values()].filter(w => ids.has(w.fromComponent) || ids.has(w.toComponent)).map(w => JSON.parse(JSON.stringify(w))),
      };
      for (const id of ids) AppState.removeComponent(id);
    } else {
      const els = new Set(p.plan.els), rts = new Set(p.plan.routes);
      const saved = [];
      for (const fl of AppState.planFloors()) {
        for (const e of (fl.data.elements || [])) if (els.has(e.id)) saved.push({ floor: fl.id, kind: 'elements', item: JSON.parse(JSON.stringify(e)) });
        for (const r of (fl.data.routes || [])) if (rts.has(r.id)) saved.push({ floor: fl.id, kind: 'routes', item: JSON.parse(JSON.stringify(r)) });
      }
      p.saved = saved;
      this._removePlanItems(els, rts);
    }
  },

  _restorePair(p) {
    if (!p.saved) return;
    if (p.sld) {
      for (const c of p.saved.comps) if (!AppState.components.has(c.id)) AppState.components.set(c.id, JSON.parse(JSON.stringify(c)));
      for (const w of p.saved.wires) {
        if (!AppState.wires.has(w.id) && AppState.components.has(w.fromComponent) && AppState.components.has(w.toComponent)) AppState.wires.set(w.id, JSON.parse(JSON.stringify(w)));
      }
    } else {
      const floors = AppState.planFloors();
      for (const s of p.saved) {
        const fl = floors.find(f => f.id === s.floor) || floors[0];
        if (!fl) continue;
        const arr = fl.data[s.kind] || (fl.data[s.kind] = []);
        if (!arr.some(x => x.id === s.item.id)) arr.push(JSON.parse(JSON.stringify(s.item)));
      }
      AppState._hydrateActiveFloor();
    }
  },

  _removePlanItems(els, rts) {
    for (const fl of AppState.planFloors()) {
      fl.data.elements = (fl.data.elements || []).filter(e => !els.has(e.id));
      fl.data.routes = (fl.data.routes || []).filter(r => !rts.has(r.id));
    }
    AppState._hydrateActiveFloor();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds) for (const id of [...els, ...rts]) PlanMarkup.selectedIds.delete(id);
  },

  // Is the Building link in use: any board on a floor plan, or a single-line
  // part linked to one.
  buildingInUse() {
    if (AppState.planAllElements().some(e => e.type === 'bd_db' || e.type === 'bd_switchboard')) return true;
    for (const c of AppState.components.values()) if (c.planLink || c.swLink || c.riserLink) return true;
    return false;
  },

  // A fingerprint of everything the Building sync reads and writes, to tell
  // whether a pass changed anything.
  buildingFingerprint() {
    const comps = [...AppState.components.values()];
    const wires = [...AppState.wires.keys()].sort().join(',');
    const els = AppState.planAllElements().filter(e => e.sldId || e.sldMembers || e.type === 'bd_db' || e.type === 'bd_switchboard' || (e.props && e.props.circuitDbId))
      .map(e => [e.id, e.sldId || null, e.props && e.props.circuitWid, e.props && e.props.circuitNo]);
    const rts = AppState.planAllRoutes().filter(r => r.type === 'feeder').map(r => [r.id, r.sldCableId || null, r.sldRiserCableId || null, r.fromId, r.toId]);
    return AppState._hashText(JSON.stringify([comps, wires, els, rts]));
  },

  _collectDeletions(pm) {
    const comps = AppState.components;
    const planEls = new Set(), planRoutes = new Set(), sldComps = new Set();
    const elById = {}, planElIds = new Set();
    const allEls = AppState.planAllElements();
    for (const e of allEls) { elById[e.id] = e; planElIds.add(e.id); }
    const feeders = AppState.planAllRoutes().filter(r => r.type === 'feeder');
    const feederById = {}; for (const r of feeders) feederById[r.id] = r;

    // A linked plan element whose primary SLD component is gone → SLD side
    // deleted → remove the plan element (DB, switchboard, adopted supply).
    for (const e of allEls) if (e.sldId && !comps.get(e.sldId)) planEls.add(e.id);
    // SLD distribution_board whose plan DB is gone → remove board.
    for (const c of comps.values()) if (c.type === 'distribution_board' && c.planLink && !planElIds.has(c.planLink)) sldComps.add(c.id);
    // Switchboard member (swLink) whose plan switchboard is gone → remove it.
    for (const c of comps.values()) if (c.swLink && !planElIds.has(c.swLink)) sldComps.add(c.id);
    // Broken feeder pairs
    for (const r of feeders) if (r.sldCableId && !comps.get(r.sldCableId)) planRoutes.add(r.id);
    for (const c of comps.values()) if (c.type === 'cable' && c.planLink && !feederById[c.planLink]) sldComps.add(c.id);
    // A riser feeder whose downstream leg was deleted in the Plan has lost the
    // pair that defines it. The reverse (cable deleted on the SLD) is healed,
    // not propagated — the legs are user-drawn horizontal runs in their own
    // right, so re-syncing simply re-derives the cable.
    const routeIds = new Set(AppState.planAllRoutes().map(r => r.id));
    for (const c of comps.values()) if (c.type === 'cable' && c.riserLink && !routeIds.has(c.riserLink)) sldComps.add(c.id);
    // Dangling plan feeders (an endpoint board was removed)
    for (const r of feeders) if (!elById[r.fromId] || !elById[r.toId] || planEls.has(r.fromId) || planEls.has(r.toId)) planRoutes.add(r.id);
    // Cascade: a removed plan board/switchboard takes its SLD members.
    for (const eid of planEls) {
      const e = elById[eid]; if (!e) continue;
      if (Array.isArray(e.sldMembers)) for (const mid of e.sldMembers) if (comps.get(mid)) sldComps.add(mid);
    }
    // Cascade: SLD cable of each removed plan feeder
    for (const rid of planRoutes) { const r = feederById[rid]; if (r && r.sldCableId && comps.get(r.sldCableId)) sldComps.add(r.sldCableId); }
    // Cascade: a removed SLD board takes its outgoing bus + the feeder cables
    // wired to the board or that bus (+ their plan feeders).
    for (const cid of [...sldComps]) {
      const c = comps.get(cid);
      if (!c || c.type !== 'distribution_board') continue;
      const outBus = c.outBusId ? comps.get(c.outBusId) : [...comps.values()].find(x => x.type === 'bus' && x.busOwner === cid);
      const busId = outBus ? outBus.id : null;
      if (busId) sldComps.add(busId);
      const wiredTo = (cabId, tgt) => [...AppState.wires.values()].some(w =>
        (w.fromComponent === cabId && w.toComponent === tgt) || (w.toComponent === cabId && w.fromComponent === tgt));
      for (const cab of comps.values()) {
        if (cab.type !== 'cable') continue;
        if (wiredTo(cab.id, cid) || (busId && wiredTo(cab.id, busId))) {
          sldComps.add(cab.id);
          if (cab.planLink && feederById[cab.planLink]) planRoutes.add(cab.planLink);
        }
      }
    }
    const cableIds = [...sldComps].filter(id => comps.get(id) && comps.get(id).type === 'cable');
    const boards = [...planEls].filter(id => { const e = elById[id]; return e && (e.type === 'bd_db' || e.type === 'bd_switchboard'); }).length
      + [...sldComps].filter(id => comps.get(id) && comps.get(id).type === 'distribution_board').length
      + new Set([...sldComps].map(id => comps.get(id)).filter(c => c && c.swLink && !planElIds.has(c.swLink)).map(c => c.swLink)).size;
    const feedersCount = planRoutes.size + cableIds.filter(id => {
      const c = comps.get(id); return !(c.planLink && planRoutes.has(c.planLink));
    }).length;
    return { planEls, planRoutes, sldComps, boards, feeders: feedersCount };
  },

  // ─── Cross-floor riser feeders ───
  // A board fed from another storey is drawn as two horizontal legs — board →
  // riser on each floor — joined by the vertical shaft (risers sharing a name
  // across floors, `AppState.planRiserShaft`). No single plan route can span
  // floors, so the pair produces no SLD cable on its own. These helpers pair the
  // legs up and emit exactly one SLD feeder cable per riser-leg pair, its length
  // being leg A + the vertical run + leg B.

  // Every board → riser leg on every floor, each measured with its own floor's
  // scale: [{floor, level, riser, shaft, board, route, lenM}].
  _riserLegs() {
    const elById = this._elById();
    const BOARD = new Set(['bd_db', 'bd_switchboard']);
    const out = [];
    for (const fl of AppState.planFloors()) {
      const f = this._floorFactorFor(fl);
      for (const r of (fl.data.routes || [])) {
        if (r.type !== 'feeder' || !r.fromId || !r.toId) continue;
        const a = elById[r.fromId], b = elById[r.toId];
        if (!a || !b) continue;
        let riser = null, board = null;
        if (a.type === 'bd_riser' && BOARD.has(b.type)) { riser = a; board = b; }
        else if (b.type === 'bd_riser' && BOARD.has(a.type)) { riser = b; board = a; }
        if (!riser || !board) continue;
        const shaft = String(riser.name || '').trim().toLowerCase();
        if (!shaft) continue;   // an unnamed riser belongs to no shaft
        out.push({ floor: fl, level: fl.level || 0, riser, shaft, board, route: r, lenM: f ? this._routeLenM(r, f) : 0 });
      }
    }
    return out;
  },

  // Group legs by shaft name, keeping one leg per board (the shortest, so a
  // re-routed duplicate doesn't fabricate a second feeder). Shafts reaching
  // only one storey are dropped — nothing to feed across.
  _riserShafts() {
    const byShaft = new Map();
    for (const leg of this._riserLegs()) {
      if (!byShaft.has(leg.shaft)) byShaft.set(leg.shaft, new Map());
      const perBoard = byShaft.get(leg.shaft);
      const prev = perBoard.get(leg.board.id);
      if (!prev || leg.lenM < prev.lenM) perBoard.set(leg.board.id, leg);
    }
    const out = [];
    for (const [shaft, perBoard] of byShaft) {
      const legs = [...perBoard.values()].sort((a, b) => a.level - b.level);
      if (new Set(legs.map(l => l.level)).size < 2) continue;
      out.push({ shaft, legs });
    }
    return out;
  },

  // Which leg on a shaft is the source: the one board that reaches an SLD supply
  // with every other board on the shaft blocked. If that is ambiguous (none, or
  // several — e.g. nothing energized yet on a first sync), the lowest storey
  // feeds upwards, which is how a building riser is actually built. Never
  // prompts: a shaft can carry many legs and a modal per pair would be a wall.
  _riserSource(legs) {
    const ids = legs.map(l => l.board.sldId).filter(Boolean);
    const sourced = legs.filter(l => l.board.sldId &&
      this._reachesSupply(l.board.sldId, ids.filter(id => id !== l.board.sldId)));
    if (sourced.length === 1) return sourced[0];
    return legs[0];   // already sorted by level ascending
  },

  // Create/refresh the SLD feeder cable for each riser-leg pair. Anchored on the
  // downstream leg route (`sldRiserCableId`) so a re-sync updates rather than
  // duplicates. Returns the number of cables newly created.
  syncRiserFeeders() {
    let made = 0;
    for (const { shaft, legs } of this._riserShafts()) {
      const src = this._riserSource(legs);
      if (!src || !src.board.sldId || !AppState.components.get(src.board.sldId)) continue;
      for (const leg of legs) {
        if (leg === src) continue;
        // Same-storey pairs are left to a directly-drawn feeder — the vertical
        // run is zero, so a riser cable would only duplicate that route.
        if (leg.level === src.level) continue;
        if (!leg.board.sldId || !AppState.components.get(leg.board.sldId)) continue;
        const vertM = AppState.planVerticalRunM(src.level, leg.level);
        const lenM = +(src.lenM + vertM + leg.lenM).toFixed(2);
        const cableType = leg.route.cableType || src.route.cableType || '';

        let cable = leg.route.sldRiserCableId ? AppState.components.get(leg.route.sldRiserCableId) : null;
        if (!cable) {
          const sp = this._feederSourcePoint(src.board);
          const sink = this._feederSinkPoint(leg.board);
          if (!sp || !sink) continue;
          const sc = AppState.components.get(sp.compId);
          const dc = AppState.components.get(leg.board.sldId);
          cable = AppState.addComponent('cable', sc.x, (sc.y + (dc ? dc.y : sc.y)) / 2);
          AppState.addWire(sp.compId, sp.port, cable.id, 'from', true);
          AppState.addWire(cable.id, 'to', sink.compId, sink.port, true);
          leg.route.sldRiserCableId = cable.id;
          made++;
        }
        // Back-refs. `riserLink` is deliberately NOT `planLink`: the generic
        // feeder-pair deletion rules key off planLink and would read a riser
        // cable (whose plan side is two legs, not one route) as orphaned.
        cable.riserLink = leg.route.id;
        cable.riserShaft = shaft;
        if (cableType) {
          this._applyCableElectrical(cable, cableType);
          if (!cable.props.name || cable.props.name === 'Cable') cable.props.name = cableType;
        }
        // The measured length is authoritative here — unlike a reflected 2-point
        // chord, all three segments are real measurements (two drawn legs plus
        // the storey heights), so a shorter result is a genuine re-measure.
        // 5 dp (1 cm), not the 4 dp used for a single drawn feeder: this length
        // is a sum of three measurements and is also written to the DB schedule
        // in metres at 2 dp, so 0.1 m rounding here would show up as the cable
        // and its own schedule way disagreeing.
        if (lenM > 0) {
          const cur = Number(cable.props.length_km) || 0;
          const v = (this._value || ((k, src) => src))('len:' + cable.id, +(lenM / 1000).toFixed(5), cur);
          if (v !== cur) cable.props.length_km = v;
        }
        cable.props.riser_note = `via riser ${src.riser.name || shaft} — ${src.lenM.toFixed(1)} m + ${vertM.toFixed(1)} m vertical + ${leg.lenM.toFixed(1)} m`;
        // The feeding DB records the cross-floor way like any other sub-board
        // feeder (switchboards have no circuit schedule).
        if (src.board.type === 'bd_db') {
          const upComp = AppState.components.get(src.board.sldId);
          const downComp = AppState.components.get(leg.board.sldId);
          if (upComp && downComp) this._ensureFeederCircuit(upComp, downComp, cableType, lenM);
        }
      }
    }
    return made;
  },

  // ─── Building distribution ↔ SLD bridge ───
  // Distribution boards drawn in the Plan become linked `distribution_board`
  // components on the SLD; feeders between boards become a Cable/Feeder
  // component wired MDB(out) → cable → SDB(in). Reconciles BOTH directions,
  // id-linked (idempotent). Deletions propagate across views on sync, behind a
  // confirmation. Building never touches the Reticulation schedule.
  // Floor plans ⇄ single line. opts.interactive (default true, the Sync
  // with SLD button) asks and reports in dialogs and takes paired undo
  // snapshots; the sync pass calls it with interactive: false — deletions made
  // in one view are applied in the other (opts.notice says so), an ambiguous
  // feeder direction keeps the drawing order and goes to opts.issue, no
  // snapshot, no summary. Without an await on that path it runs
  // synchronously. Returns the summary.
  syncBuildingToSLD(opts = {}) { return (typeof ProjectHistory !== 'undefined' ? ProjectHistory.group.bind(ProjectHistory) : (l, f) => f())('Sync plan with the single line', () => this._syncBuildingToSLD(opts)); },
  async _syncBuildingToSLD(opts = {}) {
    const interactive = opts.interactive !== false;
    const issue = opts.issue || (() => {});
    const notice = opts.notice || (() => {});
    // A length the plan measures goes through value(key, measured, current):
    // the sync pass keeps a length typed on the single line as an override.
    this._value = opts.value || ((key, source) => source);
    const pm = AppState.planMarkup;
    const comps = AppState.components;
    if (!interactive) {
      this._passDeletions(notice);
    } else {

    // ── 0. Heal undo-stranded links (SD-1) ──
    // An SLD-side undo/redo that crosses a sync boundary leaves a plan board's
    // sldId (or a feeder's sldCableId) pointing at a component the undo removed.
    // Reading that as a "deleted in the other view" would escalate an ordinary
    // undo into a prompt offering to delete the user's plan boards. Instead,
    // clear the dangling link here (the "Keep both" relink idiom) so the
    // forward pass below simply re-creates / re-links the SLD component by name.
    for (const e of AppState.planAllElements()) {
      if ((e.type === 'bd_db' || e.type === 'bd_switchboard') && e.sldId && !comps.get(e.sldId)) e.sldId = null;
    }
    for (const r of AppState.planAllRoutes()) {
      if (r.type === 'feeder' && r.sldCableId && !comps.get(r.sldCableId)) r.sldCableId = null;
      // A riser leg's cable is re-derivable from the two legs + storey heights,
      // so a stale link is always healed (never escalated to a deletion prompt).
      if (r.sldRiserCableId && !comps.get(r.sldRiserCableId)) r.sldRiserCableId = null;
    }

    // ── 0b. Propagate genuine deletions (with confirmation) ──
    const del = this._collectDeletions(pm);
    if (del.boards + del.feeders > 0) {
      const ok = interactive
        ? await UI.confirm(
          `Sync will remove ${del.boards} board/switchboard(s) and ${del.feeders} feeder(s) that were deleted in the other view. Remove them here too?`,
          { danger: true, okText: 'Remove', cancelText: 'Keep both' })
        : true;
      if (ok && !interactive) {
        notice(`${del.boards ? `${del.boards} board${del.boards === 1 ? '' : 's'}` : ''}${del.boards && del.feeders ? ' and ' : ''}${del.feeders ? `${del.feeders} feeder${del.feeders === 1 ? '' : 's'}` : ''} removed here too · Undo puts ${del.boards + del.feeders === 1 ? 'it' : 'them'} back`);
      }
      if (ok) {
        for (const id of del.sldComps) AppState.removeComponent(id);
        // Filter every floor's collections, then re-point the active mirror.
        for (const fl of AppState.planFloors()) {
          fl.data.elements = fl.data.elements.filter(e => !del.planEls.has(e.id));
          fl.data.routes = fl.data.routes.filter(r => !del.planRoutes.has(r.id));
        }
        AppState._hydrateActiveFloor();
        if (this.selectedIds) this.selectedIds.clear();
        if (typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds) PlanMarkup.selectedIds.clear();
      } else {
        // Keep both — drop dangling links so create/update re-establishes them.
        for (const e of AppState.planAllElements()) if (e.type === 'bd_db' && e.sldId && !comps.get(e.sldId)) e.sldId = null;
        for (const r of AppState.planAllRoutes()) if (r.type === 'feeder' && r.sldCableId && !comps.get(r.sldCableId)) r.sldCableId = null;
        const elIds = new Set(AppState.planAllElements().map(e => e.id));
        const rtIds = new Set(AppState.planAllRoutes().map(r => r.id));
        for (const c of comps.values()) {
          if (c.planLink && c.type === 'distribution_board' && !elIds.has(c.planLink)) c.planLink = null;
          if (c.planLink && c.type === 'cable' && !rtIds.has(c.planLink)) c.planLink = null;
        }
      }
    }
    }   // interactive deletions

    const factor = this._factor();
    const dbEls = AppState.planAllElements().filter(e => e.type === 'bd_db');
    // Feeder routes across all floors, each carrying its own floor's scale.
    const feeders = [];
    for (const fl of AppState.planFloors()) {
      const f = this._floorFactorFor(fl);
      for (const r of (fl.data.routes || [])) if (r.type === 'feeder' && r.fromId && r.toId) feeders.push({ r, factor: f });
    }
    const elById = this._elById();
    const summary = { dbNew: 0, dbLinked: 0, cableNew: 0, riserNew: 0, planNew: 0 };

    // Layout: map plan pixel extents into a tidy SLD region (preserve relative
    // positions), snapped to grid.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of dbEls) { minX = Math.min(minX, el.x); minY = Math.min(minY, el.y); maxX = Math.max(maxX, el.x); maxY = Math.max(maxY, el.y); }
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    const s = Math.min(600 / spanX, 400 / spanY, 1) || 1;
    const sldX = (el) => 400 + (el.x - minX) * s;
    const sldY = (el) => 300 + (el.y - minY) * s;

    // ── Forward: plan DB → SLD distribution_board ──
    const usedSld = new Set();
    for (const el of dbEls) {
      let comp = el.sldId ? AppState.components.get(el.sldId) : null;
      if (comp) summary.dbLinked++;
      if (!comp) {
        comp = [...AppState.components.values()].find(c =>
          c.type === 'distribution_board' && !usedSld.has(c.id) &&
          (c.props.name || '').trim().toLowerCase() === (el.name || '').trim().toLowerCase() && el.name);
      }
      if (!comp) { comp = AppState.addComponent('distribution_board', sldX(el), sldY(el)); summary.dbNew++; }
      if (el.name) comp.props.name = el.name;
      el.sldId = comp.id;
      comp.planLink = el.id;   // back-ref for deletion propagation
      usedSld.add(comp.id);
    }

    // ── Forward: plan feeder → SLD cable. Endpoints may be a DB or a
    //    switchboard. A feeding DB gets a shared outgoing bus below it (and a
    //    "Feeder to Sub-board" way); a switchboard feeds straight off its bus. ──
    const BOARD = new Set(['bd_db', 'bd_switchboard']);
    for (const { r, factor: rf } of feeders) {
      const a = elById[r.fromId], b = elById[r.toId];
      if (!a || !b || !BOARD.has(a.type) || !BOARD.has(b.type) || !a.sldId || !b.sldId) continue;
      if (!AppState.components.get(a.sldId) || !AppState.components.get(b.sldId)) continue;
      const lenM = rf ? this._routeLenM(r, rf) : 0;
      let cable = r.sldCableId ? AppState.components.get(r.sldCableId) : null;
      // Resolved upstream/downstream for this feeder (decided once, at cable
      // creation; an existing cable keeps its wired direction).
      let upEl = a, downEl = b;
      if (!cable) {
        // EE-5: which board feeds is the SLD supply topology's call, not the
        // route's draw order. Fall back to draw order; prompt when both ends
        // are DBs and the topology can't decide.
        const inferred = this._inferUpstream(a, b);
        if (inferred === b) { upEl = b; downEl = a; }
        else if (inferred === a) { /* keep draw order (a feeds b) */ }
        else if (a.type === 'bd_db' && b.type === 'bd_db') {
          // Ambiguous. Only prompt on a genuine conflict — BOTH ends reach a
          // supply — otherwise (neither energized yet, e.g. first sync) keep
          // the draw order rather than nagging for every feeder.
          const bothSourced = this._reachesSupply(a.sldId, b.sldId) && this._reachesSupply(b.sldId, a.sldId);
          if (bothSourced && interactive) {
            const aFeeds = await UI.confirm(
              `Feeder between "${a.name || 'DB A'}" and "${b.name || 'DB B'}": which board feeds the other?`,
              { danger: false, okText: `${a.name || 'A'} feeds`, cancelText: `${b.name || 'B'} feeds` });
            if (!aFeeds) { upEl = b; downEl = a; }
          } else if (bothSourced) {
            issue('feeder-direction:' + r.id,
              `Feeder between ${a.name || 'DB A'} and ${b.name || 'DB B'}: both boards have a supply, so ${a.name || 'the first'} is taken to feed ${b.name || 'the second'} (the order it was drawn in).`,
              { kind: 'swap-feeder', routeId: r.id });
          }
        }
        const src = this._feederSourcePoint(upEl);    // upstream connection {compId, port}
        const sink = this._feederSinkPoint(downEl);    // downstream connection
        if (!src || !sink) continue;
        const sc = AppState.components.get(src.compId);
        const dc = AppState.components.get(downEl.sldId);
        cable = AppState.addComponent('cable', sc.x, (sc.y + (dc ? dc.y : sc.y)) / 2);
        AppState.addWire(src.compId, src.port, cable.id, 'from', true);
        AppState.addWire(cable.id, 'to', sink.compId, sink.port, true);
        r.sldCableId = cable.id;
        cable.planLink = r.id;
        r._reversed = (upEl !== a);   // flag when topology disagreed with draw order
        summary.cableNew++;
      }
      // EE-4: give the SLD cable REAL electrical parameters from the selected
      // building cable type (r/x/ampacity/size, 400 V), not palette defaults.
      // A 2-point route bound to an SLD cable is treated as an auto chord
      // (covers pre-existing reflected feeders that predate the flag).
      const auto2pt = r._autoReflected === true || ((r.points || []).length === 2 && !!r.sldCableId);
      if (r.cableType) {
        this._applyCableElectrical(cable, r.cableType);
        // EE-6: don't clobber a user-renamed cable from an auto chord.
        if (!auto2pt || !cable.props.name || cable.props.name === 'Cable') cable.props.name = r.cableType;
      }
      // EE-6: never shorten a user-entered SLD length from an auto 2-point
      // reflected chord (shortening understates volt drop / fault loop). Write
      // only for a new cable, a user-drawn route, or a longer measurement.
      if (rf && lenM > 0) {
        const km = +(lenM / 1000).toFixed(4);
        const cur = Number(cable.props.length_km) || 0;
        const want = (!cur || !auto2pt || km > cur) ? km : cur;
        const v = this._value('len:' + cable.id, want, cur);
        if (v !== cur) cable.props.length_km = v;
      }
      // A feeding DB records an outgoing "Feeder to Sub-board" way (switchboards
      // have no circuit schedule, so skip).
      if (upEl.type === 'bd_db') {
        const upComp = AppState.components.get(upEl.sldId), downComp = AppState.components.get(downEl.sldId);
        if (upComp && downComp) this._ensureFeederCircuit(upComp, downComp, r.cableType, lenM);
      }
    }
    // ── Forward: riser-leg pairs → one cross-floor SLD feeder cable each ──
    //    (runs after the same-floor pass so every board is linked first).
    summary.riserNew = this.syncRiserFeeders();
    this._pruneEmptyOutBuses();

    // ── Reverse: SLD cables joining two linked plan elements → plan feeders ──
    summary.planNew += this.reflectSldFeeders();

    // Keep outgoing buses + feeder ways consistent with the surviving topology.
    this._pruneEmptyOutBuses();
    this._pruneFeederCircuits();

    // Every board is linked now, so push the tagged devices into their
    // schedules. Without this a board synced for the first time came across
    // with no ways at all, however many devices were tagged to it.
    const circ = (typeof PlanCircuits !== 'undefined' && PlanCircuits.syncAll) ? PlanCircuits.syncAll() : null;
    // Feeder routes the sync drew itself (reflected from a single-line cable):
    // one that disappears was undone, not deleted (_passDeletions).
    this._autoRoutes = new Set(AppState.planAllRoutes().filter(r => r.type === 'feeder' && r._autoReflected).map(r => r.id));
    this._value = null;

    AppState.dirty = true;
    // UX-4: sync mutates BOTH views (SLD components + plan link fields), so
    // push a paired snapshot to each undo stack. This keeps Ctrl+Z coherent —
    // the plan's sldId links and the SLD's boards/cables move together — and
    // the SD-1 healing above defuses the stale-link deletion prompt on redo.
    if (!interactive) return Object.assign(summary, { circuits: circ });
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.snapshot) PlanMarkup.snapshot();
    if (typeof Canvas !== 'undefined') Canvas.render();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    if (typeof UI !== 'undefined') UI.alert(
      `Synced with SLD:\n` +
      `• ${summary.dbNew} new + ${summary.dbLinked} linked distribution board(s)\n` +
      `• ${summary.cableNew} feeder cable(s) created on the SLD\n` +
      `• ${summary.riserNew} cross-floor riser feeder(s) created on the SLD\n` +
      `• ${summary.planNew} SLD cable(s) reflected back as plan feeders` +
      (circ ? `\n• ${circ.ways} circuit way(s) from ${circ.devices} tagged device(s)` : ''));
    return Object.assign(summary, { circuits: circ });
  },

  // Immediate rename propagation from a plan element to its schedule row.
  onElementRenamed(el, oldName, newName) {
    // Linked SLD distribution board follows the plan DB's name.
    if (el && el.sldId && typeof AppState.components !== 'undefined') {
      const comp = AppState.components.get(el.sldId);
      if (comp) {
        comp.props.name = newName;
        if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
      }
    }
    const kinds = { minisub: 'minisub', kiosk: 'kiosk', erf: 'erf' };
    const what = el && kinds[el.type];
    if (!what) return { status: 'skip' };                 // not a Demand item
    const R = AppState.reticulation;
    const fail = (why) => ({ status: 'fail', msg: `"${newName || oldName}" was not sent to Demand — ${why}` });
    if (!R) return fail('this project has no Demand (Reticulation) data.');
    const nameOf = (r) => (what === 'erf' ? r.erfNumber : r.name) || '';
    const newTrim = (newName || '').trim();
    if (!newTrim) {
      // An empty label cannot be a Demand name: put the Demand name back.
      const row0 = this._demandRow(el);
      if (row0) { el.name = nameOf(row0); if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true }); }
      return { status: 'fail', msg: `A ${what} needs a name — kept the Demand name${row0 ? ` "${nameOf(row0)}"` : ''}.` };
    }
    // Drawn but never pushed/linked: adopt the Demand row that carried its old name.
    if (!el.reticId && oldName) {
      const nm = oldName.trim().toLowerCase();
      let hit = null;
      if (what === 'minisub') hit = R.minisubs.find(m => (m.name || '').trim().toLowerCase() === nm);
      else if (what === 'kiosk') hit = R.kiosks.find(k => (k.name || '').trim().toLowerCase() === nm);
      else for (const k of R.kiosks) { hit = k.erfs.find(e => (e.erfNumber || '').trim().toLowerCase() === nm); if (hit) break; }
      if (hit && AppState.planAllElements().some(o => o !== el && o.reticId === hit.id)) {
        return fail(`another drawn ${what} is already linked to the Demand ${what} "${nameOf(hit)}". Use "Linked Demand item" to pick the right one.`);
      }
      if (hit) el.reticId = hit.id;
    }
    if (!el.reticId) return fail(`this ${what} is not linked to a Demand ${what}. Pick one under "Linked Demand item"${AppState.keepInSync !== false ? '' : ', or use Output › Push to Demand schedules'}.`);
    const row = this._demandRow(el);
    if (!row) return fail(`its linked Demand ${what} no longer exists. Pick another under "Linked Demand item".`);
    if (nameOf(row) === newTrim || nameOf(row) === newName) return { status: 'unchanged' };
    const dup = what === 'erf'
      ? R.kiosks.some(k => k.erfs.includes(row) && k.erfs.some(e => e !== row && (e.erfNumber || '').trim().toLowerCase() === newTrim.toLowerCase()))
      : (what === 'kiosk' ? R.kiosks : R.minisubs).some(r => r !== row && (r.name || '').trim().toLowerCase() === newTrim.toLowerCase());
    if (what === 'erf') row.erfNumber = newName; else row.name = newName;
    AppState.dirty = true;
    if (typeof Retic !== 'undefined') {
      if (Retic._snapshot) Retic._snapshot();
      if (Retic._active) { Retic.render && Retic.render(); Retic.recompute && Retic.recompute(); }
    }
    return { status: 'ok', msg: `Demand ${what} renamed to "${newTrim}".`, warn: dup ? `Another Demand ${what} is already called "${newTrim}".` : '' };
  },
};
