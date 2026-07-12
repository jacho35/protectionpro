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
    bd_light: { klass: 'lighting', va: (p) => (Number(p.watts) || 100) },
    bd_socket: { klass: 'socket', va: (p) => 200 * (parseInt(p.gangs, 10) || 1) },
    bd_fcu: { klass: 'other', va: () => 2000 },
  },
  // Per-type "how many on one final circuit" caps (DD convention).
  CAPS: { lighting: 10, socket: 6, other: 1 },

  isLoadDevice(type) { return !!this.LOAD_TYPES[type]; },
  deviceVA(el) {
    const p = (el && el.props) || {};
    if (p.load_va != null && p.load_va !== '') return Number(p.load_va) || 0;
    const lt = this.LOAD_TYPES[el.type];
    return lt ? (Number(lt.va(p)) || 0) : 0;
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
    const agg = new Map();   // dbElId -> Map(way -> {count, va, classes:Set})
    let tagged = 0;
    for (const el of AppState.planAllElements()) {
      const p = el.props || {};
      if (!p.circuitDbId || p.circuitNo == null || p.circuitNo === '') continue;
      if (!this.isLoadDevice(el.type) && !(p.load_va > 0)) continue;
      tagged++;
      const way = String(p.circuitNo);
      if (!agg.has(p.circuitDbId)) agg.set(p.circuitDbId, new Map());
      const ways = agg.get(p.circuitDbId);
      const cur = ways.get(way) || { count: 0, va: 0, classes: new Set() };
      cur.count += 1; cur.va += this.deviceVA(el);
      const lt = this.LOAD_TYPES[el.type]; if (lt) cur.classes.add(lt.klass);
      ways.set(way, cur);
    }

    const sum = { boards: 0, ways: 0, devices: tagged, unsynced: 0 };
    const touchedComps = new Set();
    for (const [dbElId, ways] of agg) {
      const dbEl = this._boardById(dbElId);
      const comp = this._sldComp(dbEl);
      if (!comp) { sum.unsynced++; continue; }   // board not synced to the SLD yet
      if (!Array.isArray(comp.props.circuits)) comp.props.circuits = [];
      sum.boards++;
      for (const [way, a] of ways) {
        let c = comp.props.circuits.find(x => String(x.way) === way);
        if (!c) { c = this._newWay(comp, way); comp.props.circuits.push(c); }
        c.plan_qty = a.count;
        if (!c._manualLoadOverride) {
          c.load_va = Math.round(a.va);
          if (!c._nameOverride) c.description = this._describe(a.classes, a.count);
        }
        sum.ways++;
      }
      touchedComps.add(comp);
    }
    for (const comp of touchedComps) DBSchedule.recompute(comp);
    if (touchedComps.size && typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    return sum;
  },

  // A blank 1P way seeded from the lighting preset (breaker/curve/cable), so a
  // freshly-tagged circuit that has no schedule row yet still gets sensible
  // defaults; the user tunes it in the DB schedule editor.
  _newWay(comp, way) {
    const base = (typeof DB_LOAD_TYPES !== 'undefined' && DB_LOAD_TYPES.find(t => t.key === 'lighting')) || {};
    const idx = comp.props.circuits.length;
    return {
      way: String(way), description: '', poles: '1P', phase: ['R', 'W', 'B'][idx % 3],
      breaker_a: base.breaker_a || 10, curve: base.curve || 'B', el_group: '',
      cable_mm2: base.cable_mm2 || 1.5, cable_m: 0, load_va: 0, demand_factor: base.df || 1,
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
        if (!p.circuitDbId) { e.props = p; p.circuitDbId = dbId; p.circuitNo = way; n++; }
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
    const boards = this.boardEls();
    if (!boards.length) return { tagged: 0, reason: 'no-board' };
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
    return { tagged: loads.length, board: board.name, ways, synced: !!comp };
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
          return { dbId: e.props.circuitDbId, way: String(e.props.circuitNo) };
        }
      }
      return null;
    };
    const lenByWay = new Map();   // `${dbId}|${way}` -> metres
    for (const fl of AppState.planFloors()) {
      const f = (fl.data.scale && fl.data.scale.factor) || 0;
      if (!f) continue;
      for (const r of (fl.data.routes || [])) {
        if (!this.CIRCUIT_ROUTES.includes(r.type)) continue;
        const w = routeWay(r); if (!w) continue;
        let px = 0; for (let i = 1; i < (r.points || []).length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
        const key = `${w.dbId}|${w.way}`;
        lenByWay.set(key, (lenByWay.get(key) || 0) + px * f);
      }
    }
    let updated = 0;
    const touched = new Set();
    for (const [key, m] of lenByWay) {
      const [dbId, way] = key.split('|');
      const comp = this._sldComp(this._boardById(dbId));
      if (!comp || !Array.isArray(comp.props.circuits)) continue;
      const c = comp.props.circuits.find(x => String(x.way) === way);
      if (!c || c._cableManual) continue;
      c.cable_m = +m.toFixed(2); updated++; touched.add(comp);
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
