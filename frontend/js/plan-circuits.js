/* ProtectionPro — Plan Markup building auto-circuiting.
 *
 * Ports Distribution Designer Pro's floor-plan → final-circuit automation, the
 * half the original Plan Markup port left out. Devices placed on the plan
 * (lights, sockets, fused spurs…) are TAGGED to a distribution-board circuit
 * (`el.props.circuitDbId` = a bd_db element id, `el.props.circuitNo` = the way
 * number). From those tags this module:
 *   • syncLoads()   — counts tagged devices per way and writes the way's
 *                     load_va / plan_qty into the linked SLD distribution_board
 *                     schedule (DD's fpCircuitLoads + _fpSyncLoadsQuiet),
 *                     skipping ways a user has pinned (_manualLoadOverride).
 *   • propagateFrom — floods a device's circuit tag to untagged devices joined
 *                     by final-circuit routes (DD's fpPropagateCircuit).
 *   • bulkAssign    — distributes a board's connected untagged devices across
 *                     ways with per-type caps (DD's fpBulkAssignCircuits).
 *   • syncRoutedLengths — routed circuit length → way.cable_m (auto/manual).
 *
 * A device's circuit tag lives in props so it rides the floor JSON untouched;
 * the electrical schedule stays on the SLD component (comp.props.circuits).
 */

const PlanCircuits = {
  // Final-circuit route types that wire devices to a board.
  CIRCUIT_ROUTES: ['circuit', 'lighting_ckt'],

  // Load model: plan device → connected VA. An explicit props.load_va overrides;
  // else lights use their watts (≈VA at unity PF), sockets 200 VA per gang, a
  // fused spur a nominal fixed load. Anything else contributes nothing.
  LOAD_TYPES: {
    // Default watts matches the placed-device default in plan-defs.js (SD-3).
    bd_light: { klass: 'lighting', va: (p) => (Number(p.watts) || 20) },
    bd_socket: { klass: 'socket', va: (p) => ({ single: 200, double: 400, double_usb: 500 }[p.outlets] || (p.gangs ? 200 * (parseInt(p.gangs, 10) || 1) : 200)) },
    bd_fcu: { klass: 'other', va: () => 2000 },
  },
  // Per-type "how many on one final circuit" caps (DD convention).
  CAPS: { lighting: 10, socket: 6, other: 1 },

  // Supply / infrastructure — these are boards & sources, not things that sit
  // ON a final circuit, so they don't get the circuit-attribute editor.
  INFRA: new Set(['bd_utility', 'bd_transformer', 'bd_generator', 'bd_db', 'bd_switchboard', 'bd_riser', 'bd_jb']),

  isLoadDevice(type) { return !!this.LOAD_TYPES[type]; },
  // Any building device that can be assigned to a distribution-board circuit
  // (loads plus switches/isolators/ELV points — everything but infrastructure).
  isCircuitDevice(type) { return typeof type === 'string' && type.startsWith('bd_') && !this.INFRA.has(type); },
  deviceVA(el) {
    const p = (el && el.props) || {};
    if (p.load_va != null && p.load_va !== '') return Number(p.load_va) || 0;
    const lt = this.LOAD_TYPES[el.type];
    return lt ? (Number(lt.va(p)) || 0) : 0;
  },
  // '1P' | '3P' — the device's declared circuit type (default single-phase).
  devicePoles(el) { return ((el && el.props && el.props.poles) === '3P') ? '3P' : '1P'; },

  // ── Stable way ids (EE-7) ──
  // A schedule way's identity is a stable internal id, NOT the mutable way
  // NUMBER. Device tags reference the id (props.circuitWid) so renumbering a
  // way, or minting a feeder way that reuses a freed number, can never remap a
  // device's load onto the wrong physical circuit. Ids are minted from the
  // plan sequence so they are globally unique and collision-free.
  _genWayId() { return 'w' + (AppState.planMarkup._seq++); },
  // Lazy migration: assign an id to any way that lacks one (old projects).
  _ensureWayIds(comp) {
    if (!comp || !Array.isArray(comp.props.circuits)) return;
    for (const c of comp.props.circuits) if (!c.id) c.id = this._genWayId();
  },

  // Every bd_db plan element across all floors, as [{id, name, el, floor}].
  boardEls() {
    const out = [];
    for (const fl of AppState.planFloors()) {
      for (const e of (fl.data.elements || [])) {
        if (e.type === 'bd_db') out.push({ id: e.id, name: e.name || 'DB', el: e, floor: fl });
      }
    }
    return out;
  },
  _boardById(id) { return AppState.planAllElements().find(e => e.id === id && e.type === 'bd_db') || null; },
  // The SLD distribution_board a plan DB links to (or null when unsynced).
  _sldComp(dbEl) { return (dbEl && dbEl.sldId) ? AppState.components.get(dbEl.sldId) : null; },

  // ── Phase A: auto-load ──
  // Count tagged devices per (board, way), write each way's load_va + plan_qty
  // into the linked SLD board schedule (unless the way is a manual override),
  // auto-name from the device mix, then recompute the board's lumped load.
  // Returns a summary {boards, ways, devices, unsynced}.
  syncLoads() {
    // Resolve each board's SLD component once, migrating its way ids up front
    // (EE-7), so aggregation can key by the STABLE way id — a device with a
    // circuitWid and a freshly-typed device sharing the same physical way both
    // land in one group instead of clobbering each other.
    const compByDb = new Map();
    const compFor = (dbElId) => {
      if (compByDb.has(dbElId)) return compByDb.get(dbElId);
      const comp = this._sldComp(this._boardById(dbElId));
      if (comp) { if (!Array.isArray(comp.props.circuits)) comp.props.circuits = []; this._ensureWayIds(comp); }
      compByDb.set(dbElId, comp || null);
      return comp || null;
    };
    // dbElId -> Map(key -> {count, va, classes, threePhase, num, wayId, devices})
    const agg = new Map();
    let tagged = 0;
    for (const el of AppState.planAllElements()) {
      const p = el.props || {};
      if (!p.circuitDbId || p.circuitNo == null || p.circuitNo === '') continue;
      if (!this.isCircuitDevice(el.type)) continue;
      tagged++;
      const num = String(p.circuitNo);
      // Resolve to an existing way id now: by stable id, else by number
      // (never a feeder_db way — those share the number space, EE-7).
      let wayId = null;
      const comp = compFor(p.circuitDbId);
      if (comp) {
        let c = p.circuitWid ? comp.props.circuits.find(x => x.id === p.circuitWid) : null;
        if (!c) c = comp.props.circuits.find(x => String(x.way) === num && x.type !== 'feeder_db');
        if (c) wayId = c.id;
      }
      const key = wayId ? ('#' + wayId) : ('n:' + num);
      if (!agg.has(p.circuitDbId)) agg.set(p.circuitDbId, new Map());
      const ways = agg.get(p.circuitDbId);
      const cur = ways.get(key) || { count: 0, va: 0, classes: new Set(), threePhase: false, num, wayId, devices: [] };
      cur.count += 1; cur.va += this.deviceVA(el);
      if (this.devicePoles(el) === '3P') cur.threePhase = true;
      const lt = this.LOAD_TYPES[el.type]; if (lt) cur.classes.add(lt.klass);
      cur.devices.push(el);
      ways.set(key, cur);
    }

    const sum = { boards: 0, ways: 0, devices: tagged, unsynced: 0, orphaned: 0 };
    const touchedComps = new Set();
    const writtenByComp = new Map();   // comp -> Set(way id) written this pass
    for (const [dbElId, ways] of agg) {
      const comp = compFor(dbElId);
      if (!comp) { sum.unsynced++; continue; }   // board not synced to the SLD yet
      sum.boards++;
      const written = writtenByComp.get(comp) || new Set(); writtenByComp.set(comp, written);
      for (const [, a] of ways) {
        // The way id was resolved during aggregation; a group with no id is a
        // number that has no schedule row yet → mint one.
        let c = a.wayId ? comp.props.circuits.find(x => x.id === a.wayId) : null;
        if (!c) c = comp.props.circuits.find(x => String(x.way) === a.num && x.type !== 'feeder_db');
        if (!c) { c = this._newWay(comp, a.num, a.classes); comp.props.circuits.push(c); }
        if (!c.id) c.id = this._genWayId();
        // Backfill device tags with the resolved id so future renumbering can
        // never redirect their load; keep circuitNo in sync for display.
        for (const d of a.devices) { d.props.circuitWid = c.id; d.props.circuitNo = c.way; }
        written.add(c.id);
        delete c._orphaned;
        c.plan_qty = a.count;
        // Poles: escalate 1P→3P only; never silently demote a 3P way to
        // 1P-on-R (EE-14), and never touch a way whose poles the user pinned.
        if (!c._polesManual) {
          if (a.threePhase) { c.poles = '3P'; c.phase = 'RWB'; }
          else if (c.poles !== '3P') { c.poles = '1P'; if (c.phase === 'RWB') c.phase = 'R'; }
        }
        if (!c._manualLoadOverride) {
          c.load_va = Math.round(a.va);
          if (!c._nameOverride) c.description = this._describe(a.classes, a.count);
        }
        sum.ways++;
      }
      touchedComps.add(comp);
    }

    // EE-3: a way that was plan-derived (plan_qty>0) but received no devices
    // this pass is now a ghost — its devices were deleted or re-tagged. Zero
    // it (unless the user pinned the value) so the board no longer overstates.
    for (const b of this.boardEls()) {
      const comp = compFor(b.id);
      if (!comp || !Array.isArray(comp.props.circuits)) continue;
      const written = writtenByComp.get(comp);
      for (const c of comp.props.circuits) {
        if (c.type === 'feeder_db') continue;
        if (!(Number(c.plan_qty) > 0)) continue;
        if (written && written.has(c.id)) continue;
        c.plan_qty = 0;
        if (!c._manualLoadOverride) c.load_va = 0;
        if (!c._cableManual) c.cable_m = 0;
        c._orphaned = true;
        sum.orphaned++;
        touchedComps.add(comp);
      }
    }

    for (const comp of touchedComps) DBSchedule.recompute(comp);
    if (touchedComps.size && typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    return sum;
  },

  // Map an aggregate's device classes to the dominant load preset key.
  // Sockets outrank lighting (heavier conductor / lower DF must not be lost);
  // anything else falls back to a generic spare-way preset (EE-8).
  _presetKeyFor(classes) {
    if (classes && classes.has) {
      if (classes.has('socket')) return 'socket';
      if (classes.has('lighting')) return 'lighting';
      if (classes.has('other')) return 'spare';
    }
    return 'lighting';
  },

  // A blank way seeded from the aggregate's DOMINANT class preset
  // (breaker/curve/cable/DF/poles), so a freshly-tagged socket circuit is no
  // longer minted with lighting defaults (1.5 mm² / DF 1.0). The user tunes it
  // in the DB schedule editor.
  _newWay(comp, way, classes) {
    const key = this._presetKeyFor(classes);
    const base = (typeof DB_LOAD_TYPES !== 'undefined' && DB_LOAD_TYPES.find(t => t.key === key)) || {};
    const idx = comp.props.circuits.length;
    const is3P = base.poles === '3P';
    return {
      id: this._genWayId(),
      way: String(way), description: '', poles: base.poles || '1P',
      phase: is3P ? 'RWB' : ['R', 'W', 'B'][idx % 3],
      breaker_a: base.breaker_a || 10, curve: base.curve || 'B', el_group: '',
      cable_mm2: base.cable_mm2 || 1.5, cable_m: 0, load_va: 0,
      demand_factor: base.df != null ? base.df : 1,
      leakage_ma: 0,
    };
  },

  _describe(classes, count) {
    const has = (k) => classes.has(k);
    if (has('lighting') && has('socket')) return `Lights + Sockets — ${count} points`;
    if (has('lighting')) return `Lighting — ${count} points`;
    if (has('socket')) return `Socket Outlets — ${count} points`;
    return `Circuit — ${count} points`;
  },

  // ── Route adjacency (final-circuit routes only) ──
  // element id -> Set(connected element ids), across all floors. A route joins
  // every element it references (endpoints + snapped vertices) into a clique.
  _adjacency() {
    const adj = new Map();
    const link = (a, b) => {
      if (!a || !b || a === b) return;
      (adj.get(a) || adj.set(a, new Set()).get(a)).add(b);
      (adj.get(b) || adj.set(b, new Set()).get(b)).add(a);
    };
    for (const fl of AppState.planFloors()) {
      for (const r of (fl.data.routes || [])) {
        if (!this.CIRCUIT_ROUTES.includes(r.type)) continue;
        const ids = new Set();
        if (r.fromId) ids.add(r.fromId);
        if (r.toId) ids.add(r.toId);
        for (const p of (r.points || [])) if (p.snappedTo) ids.add(p.snappedTo);
        const arr = [...ids];
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) link(arr[i], arr[j]);
      }
    }
    return adj;
  },

  // ── Phase B: propagate a device's tag along its circuit run ──
  // Flood from `srcId` across final-circuit edges, tagging untagged load
  // devices with the source's (circuitDbId, circuitNo). Stops at boards and at
  // devices already tagged to a different circuit. Returns count tagged.
  propagateFrom(srcId) {
    const elById = {}; for (const e of AppState.planAllElements()) elById[e.id] = e;
    const src = elById[srcId];
    if (!src || !src.props || !src.props.circuitDbId || src.props.circuitNo == null) return 0;
    const dbId = src.props.circuitDbId, way = String(src.props.circuitNo);
    const srcWid = src.props.circuitWid || null;
    const adj = this._adjacency();
    const seen = new Set([srcId]);
    const q = [srcId];
    let n = 0;
    while (q.length) {
      const cur = q.shift();
      for (const nb of (adj.get(cur) || [])) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        const e = elById[nb];
        if (!e || e.type === 'bd_db') continue;         // don't cross a board
        if (!this.isLoadDevice(e.type)) { q.push(nb); continue; }  // pass-through (JB, switch…)
        const p = e.props || {};
        if (p.circuitDbId && (p.circuitDbId !== dbId || String(p.circuitNo) !== way)) continue; // owned elsewhere
        if (!p.circuitDbId) { e.props = p; p.circuitDbId = dbId; p.circuitNo = way; if (srcWid) p.circuitWid = srcWid; n++; }
        q.push(nb);
      }
    }
    return n;
  },

  // ── Phase B: bulk auto-distribute a board's connected untagged devices ──
  // From board `dbElId`, walk final-circuit routes to gather connected untagged
  // load devices, group by class, and lay them into ways with per-class caps
  // (lights 10/way, sockets 6/way, other 1/way — DD's caps), minting new way
  // numbers after the board's existing ones. Returns {ways, devices}.
  bulkAssign(dbElId) {
    const dbEl = this._boardById(dbElId);
    if (!dbEl) return { ways: 0, devices: 0 };
    const elById = {}; for (const e of AppState.planAllElements()) elById[e.id] = e;
    const adj = this._adjacency();
    // Reachable load devices (walk through non-board elements from the board).
    const seen = new Set([dbElId]); const q = [dbElId]; const found = [];
    while (q.length) {
      const cur = q.shift();
      for (const nb of (adj.get(cur) || [])) {
        if (seen.has(nb)) continue; seen.add(nb);
        const e = elById[nb]; if (!e) continue;
        if (e.type === 'bd_db') continue;                 // stop at another board
        if (this.isLoadDevice(e.type)) found.push(e);
        q.push(nb);
      }
    }
    const untagged = found.filter(e => !(e.props && e.props.circuitDbId));
    if (!untagged.length) return { ways: 0, devices: 0 };

    const CAPS = this.CAPS;
    const groups = { lighting: [], socket: [], other: [] };
    for (const e of untagged) groups[this.LOAD_TYPES[e.type].klass].push(e);

    // Next free way number after the board's existing schedule.
    const comp = this._sldComp(dbEl);
    let nextWay = 1;
    if (comp && Array.isArray(comp.props.circuits)) {
      for (const c of comp.props.circuits) { const w = parseInt(c.way, 10); if (w >= nextWay) nextWay = w + 1; }
    }
    let ways = 0, devices = 0;
    for (const klass of ['lighting', 'socket', 'other']) {
      const list = groups[klass]; const cap = CAPS[klass];
      for (let i = 0; i < list.length; i += cap) {
        const chunk = list.slice(i, i + cap);
        const way = String(nextWay++);
        for (const e of chunk) { e.props = e.props || {}; e.props.circuitDbId = dbElId; e.props.circuitNo = way; devices++; }
        ways++;
      }
    }
    // Materialise the loads into the schedule.
    this.syncLoads();
    return { ways, devices };
  },

  // Tag a batch of freshly-placed load devices (from the array / path tools)
  // onto new circuit ways of the nearest distribution board, chunked by the
  // per-type cap, then materialise the loads. Returns a summary or null.
  autoTagDevices(els) {
    const loads = (els || []).filter(e => this.isLoadDevice(e.type));
    if (!loads.length) return null;
    let boards = this.boardEls();
    if (!boards.length) return { tagged: 0, reason: 'no-board' };
    // EE-10: restrict candidates to the active floor so a riser-aligned board
    // one floor down can't silently steal the tag. Fall back cross-floor only
    // when the active floor has no board (flagged so the caller can warn).
    let crossFloor = false;
    const activeFloor = AppState.planActiveFloor();
    if (activeFloor) {
      const onFloor = boards.filter(b => b.floor && b.floor.id === activeFloor.id);
      if (onFloor.length) boards = onFloor;
      else crossFloor = true;
    }
    // Nearest board to the batch centroid.
    const cx = loads.reduce((s, e) => s + e.x, 0) / loads.length;
    const cy = loads.reduce((s, e) => s + e.y, 0) / loads.length;
    let board = boards[0], best = Infinity;
    for (const b of boards) {
      const d = (b.el.x - cx) ** 2 + (b.el.y - cy) ** 2;
      if (d < best) { best = d; board = b; }
    }
    const comp = this._sldComp(board.el);
    let next = 1;
    if (comp && Array.isArray(comp.props.circuits)) {
      for (const c of comp.props.circuits) { const w = parseInt(c.way, 10); if (w >= next) next = w + 1; }
    }
    const cap = this.CAPS[this.LOAD_TYPES[loads[0].type].klass] || 1;
    let ways = 0;
    for (let i = 0; i < loads.length; i += cap) {
      const way = String(next++);
      for (const e of loads.slice(i, i + cap)) { e.props = e.props || {}; e.props.circuitDbId = board.el.id; e.props.circuitNo = way; }
      ways++;
    }
    if (comp) this.syncLoads();
    return { tagged: loads.length, board: board.name, ways, synced: !!comp,
      crossFloor, floor: (board.floor && board.floor.name) || '' };
  },

  // ── Phase C: routed final-circuit length → way.cable_m ──
  // For each (board, way), sum the length of final-circuit routes whose devices
  // are tagged to that way (measured with the route's floor scale), and write
  // it to the way's cable_m unless the user pinned it (_cableManual). Returns
  // the number of ways updated.
  syncRoutedLengths() {
    const elById = {}; for (const e of AppState.planAllElements()) elById[e.id] = e;
    const routeWay = (r) => {
      // A route belongs to the circuit its tagged endpoints share.
      const ids = new Set();
      if (r.fromId) ids.add(r.fromId); if (r.toId) ids.add(r.toId);
      for (const p of (r.points || [])) if (p.snappedTo) ids.add(p.snappedTo);
      for (const id of ids) {
        const e = elById[id];
        if (e && e.props && e.props.circuitDbId && e.props.circuitNo != null) {
          return { dbId: e.props.circuitDbId, way: String(e.props.circuitNo), wid: e.props.circuitWid || null };
        }
      }
      return null;
    };
    const lenByWay = new Map();   // `${dbId}|${wid||('n:'+way)}` -> {dbId, way, wid, m}
    for (const fl of AppState.planFloors()) {
      const f = (fl.data.scale && fl.data.scale.factor) || 0;
      if (!f) continue;
      for (const r of (fl.data.routes || [])) {
        if (!this.CIRCUIT_ROUTES.includes(r.type)) continue;
        const w = routeWay(r); if (!w) continue;
        let px = 0; for (let i = 1; i < (r.points || []).length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
        const key = `${w.dbId}|${w.wid || ('n:' + w.way)}`;
        const rec = lenByWay.get(key) || { dbId: w.dbId, way: w.way, wid: w.wid, m: 0 };
        rec.m += px * f;
        lenByWay.set(key, rec);
      }
    }
    let updated = 0;
    const touched = new Set();
    for (const rec of lenByWay.values()) {
      const comp = this._sldComp(this._boardById(rec.dbId));
      if (!comp || !Array.isArray(comp.props.circuits)) continue;
      let c = rec.wid ? comp.props.circuits.find(x => x.id === rec.wid) : null;
      if (!c) c = comp.props.circuits.find(x => String(x.way) === rec.way && x.type !== 'feeder_db');
      if (!c || c._cableManual) continue;
      c.cable_m = +rec.m.toFixed(2); updated++; touched.add(comp);
    }
    for (const comp of touched) DBSchedule.recompute(comp);
    return updated;
  },

  // Full "Sync circuits from plan": loads first, then routed lengths.
  syncAll() {
    const s = this.syncLoads();
    s.lengths = this.syncRoutedLengths();
    return s;
  },
};
