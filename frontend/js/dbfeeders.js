/* ProtectionPro — Sub-board feeders drawn on the single line.
 *
 * A board's 'out' port wired through a breaker / fuse and a cable into another
 * board's 'in' port is a sub-board feeder. The Plan sync has always written
 * such a feeder into the parent's schedule as a "Feeder to Sub-board" way
 * (`type: 'feeder_db'`, `feedsDbId`); a feeder drawn by hand on the SLD never
 * got one, so the parent schedule, its single line, GA, BOQ and circuit check
 * did not know the board fed anything.
 *
 * syncBoard() walks the SLD from the board's 'out' port and keeps one feeder
 * way per sub-board reached, linked to the drawn parts by `way.sld`:
 *   { device: <cb/fuse id> | null, cable: <cable id> | null }
 * The drawn parts are the one record. pull (syncBoard) copies their rating,
 * curve, cable and length onto the way; push (pushBoard, run by the schedule's
 * commit) writes a rating / curve / length typed in the schedule back onto
 * the part, where the part can take it (a library breaker or a cable size is
 * changed on the SLD). A linked way whose feed is no longer drawn is removed;
 * the way number, section, ECC and description typed in the schedule stay.
 */

const DBFeeders = {
  // Parts a feeder passes through between the two boards.
  _PASS: new Set(['cb', 'fuse', 'switch', 'cable', 'ct', 'pt', 'surge_arrester', 'bus_duct']),

  _adj() {
    const adj = new Map();
    const add = (a, b, localPort, farPort) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ id: b, localPort, farPort });
    };
    for (const w of Components.topologyWires()) {
      add(w.fromComponent, w.toComponent, w.fromPort, w.toPort);
      add(w.toComponent, w.fromComponent, w.toPort, w.fromPort);
    }
    return adj;
  },

  // Sub-boards fed from `board`'s out port: [{ target, path: [parts board → target] }].
  // A bus is passed only when it is the board's own outgoing bus (Plan sync).
  feeds(board, adj) {
    if (!board || board.type !== 'distribution_board') return [];
    adj = adj || this._adj();
    const out = [];
    const prev = new Map();
    const seen = new Set([board.id]);
    const queue = [];
    for (const n of adj.get(board.id) || []) {
      if (n.localPort !== 'out' || seen.has(n.id)) continue;
      prev.set(n.id, board.id); queue.push(n);
    }
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const c = AppState.components.get(n.id);
      if (!c) continue;
      if (c.type === 'distribution_board') {
        if (n.farPort !== 'in') continue;          // a board met at its out port is not fed from here
        const path = [];
        for (let id = prev.get(c.id); id && id !== board.id; id = prev.get(id)) path.unshift(AppState.components.get(id));
        out.push({ target: c, path: path.filter(Boolean) });
        continue;
      }
      const ownBus = c.type === 'bus' && c.busOwner === board.id;
      if (!this._PASS.has(c.type) && !ownBus) continue;
      if (Components.isOpenSwitching && Components.isOpenSwitching(c)) continue;
      for (const m of adj.get(c.id) || []) {
        if (seen.has(m.id)) continue;
        if (!prev.has(m.id)) prev.set(m.id, c.id);
        queue.push(m);
      }
    }
    return out;
  },

  // The board (and its feeder way) that feeds `boardId`, or null.
  parentOf(boardId) {
    for (const p of AppState.components.values()) {
      if (p.type !== 'distribution_board' || p.id === boardId) continue;
      const way = (p.props.circuits || []).find(w => w.type === 'feeder_db' && w.feedsDbId === boardId);
      if (way) return { board: p, way };
    }
    return null;
  },

  // The library breaker a drawn CB is, as a schedule device ref ('' = generic).
  _deviceRef(dev) {
    const std = dev && dev.type === 'cb' ? dev.props.standard_type : null;
    if (!std || typeof DbCoord === 'undefined' || !DbCoord.deviceById) return '';
    return DbCoord.deviceById('cb:' + std) ? 'cb:' + std : '';
  },

  // A drawn breaker the schedule may re-rate: a plain one, not a library or
  // trip-unit breaker (those are set in the SLD properties).
  deviceEditable(dev) {
    if (!dev) return true;
    if (dev.type === 'fuse') return !dev.props.standard_type;
    return !dev.props.standard_type && !dev.props.trip_unit;
  },

  _cableEntry(cab) {
    const p = cab.props || {};
    return p.standard_type ? (CableLib.byId(p.standard_type) || CableLib.byName(p.standard_type)) : null;
  },

  // Demand the feeder carries: the sub-board's own diversified demand plus
  // whatever it feeds on in turn (its own feeder ways), cycle-guarded.
  _downstream(sub, seen) {
    seen = seen || new Set();
    seen.add(sub.id);
    let dkva = (Number(sub.props.rated_kva) || 0) * demandFactorOr1(sub.props.demand_factor);
    // A board whose schedule was never committed has stale derived props:
    // read its ways directly (without writing anything).
    if (Array.isArray(sub.props.circuits) && sub.props.circuits.length && typeof DBDrawing !== 'undefined') {
      dkva = DBDrawing._totals(sub).demandKva;
    }
    for (const w of sub.props.circuits || []) {
      if (w.type !== 'feeder_db' || !w.feedsDbId || seen.has(w.feedsDbId)) continue;
      const child = AppState.components.get(w.feedsDbId);
      if (child && child.type === 'distribution_board') dkva += this._downstream(child, seen).kva;
    }
    const v = (Number(sub.props.voltage_kv) || 0.4) * 1000;
    return { kva: +dkva.toFixed(2), a: +((dkva * 1000) / (Math.sqrt(3) * v)).toFixed(1) };
  },

  _set(obj, key, val, changed) {
    if (val === undefined) return;
    if (JSON.stringify(obj[key]) !== JSON.stringify(val)) { obj[key] = val; changed.v = true; }
  },

  // Pull the SLD into one board's schedule. Returns true when a way changed.
  syncBoard(board, adj) {
    if (!board || board.type !== 'distribution_board') return false;
    if (!Array.isArray(board.props.circuits)) board.props.circuits = [];
    const circuits = board.props.circuits;
    const changed = { v: false };
    const found = this.feeds(board, adj);
    const keep = new Set();

    for (const { target, path } of found) {
      const dev = path.find(c => c.type === 'cb' || c.type === 'fuse') || null;
      const cables = path.filter(c => c.type === 'cable');
      let way = circuits.find(w => w.type === 'feeder_db' && w.feedsDbId === target.id);
      if (!way) {
        way = DBSchedule.newWay(circuits.length, {
          type: 'feeder_db', poles: '3P', phase: 'RWB', breaker_a: 63, curve: 'C',
          cable_mm2: 25, ecc_mm2: null, cable_m: 0, feedsDbId: target.id,
        });
        // After the last numbered way.
        const nums = circuits.map(w => parseInt(w.way, 10)).filter(n => !isNaN(n));
        way.way = String(nums.length ? Math.max(...nums) + 1 : circuits.length + 1);
        circuits.push(way);
        changed.v = true;
      }
      keep.add(way.id);
      const name = target.props.name || 'Sub-board';
      if (!String(way.description || '').trim() || /^Feeder to /.test(way.description)) this._set(way, 'description', 'Feeder to ' + name, changed);
      this._set(way, 'sld', { device: dev ? dev.id : null, cable: cables.length ? cables[0].id : null }, changed);
      this._set(way, 'poles', '3P', changed);
      this._set(way, 'phase', 'RWB', changed);
      if (dev) {
        const a = Components._deviceRatingA(dev);
        if (a) this._set(way, 'breaker_a', a, changed);
        if (dev.type === 'cb' && dev.props.cb_type === 'mcb' && dev.props.mcb_curve) this._set(way, 'curve', dev.props.mcb_curve, changed);
        this._set(way, 'device', this._deviceRef(dev), changed);
      }
      if (cables.length) {
        const lib = this._cableEntry(cables[0]);
        const mm2 = lib ? lib.size_mm2 : Number(cables[0].props.size_mm2) || null;
        if (mm2) this._set(way, 'cable_mm2', mm2, changed);
        if (lib) { this._set(way, 'cable', lib.name, changed); this._set(way, 'conductor', lib.conductor || 'Cu', changed); }
        const m = cables.reduce((n, c) => n + (Number(c.props.length_km) || 0) * 1000, 0);
        this._set(way, 'cable_m', +m.toFixed(2), changed);
      }
      const d = this._downstream(target);
      this._set(way, 'downstream_kva', d.kva, changed);
      this._set(way, 'downstream_a', d.a, changed);
    }

    // A linked way whose feed is no longer drawn goes with it.
    const before = circuits.length;
    board.props.circuits = circuits.filter(w => !(w.type === 'feeder_db' && w.sld && !keep.has(w.id)));
    if (board.props.circuits.length !== before) changed.v = true;
    return changed.v;
  },

  // Every board. Marks the project dirty only when something changed.
  syncAll() {
    if (typeof Components === 'undefined' || typeof DBSchedule === 'undefined') return false;
    const adj = this._adj();
    let any = false;
    // Again while anything moved: a board synced before the boards below it
    // reads their feeder demand on the next pass.
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const c of AppState.components.values()) {
        if (c.type === 'distribution_board' && this.syncBoard(c, adj)) moved = true;
      }
      if (!moved) break;
      any = true;
    }
    if (any) AppState.dirty = true;
    return any;
  },

  // Push a board's linked ways back onto their SLD parts. Returns true when a
  // part changed.
  pushBoard(board) {
    let any = false;
    for (const w of (board && board.props.circuits) || []) {
      if (w.type !== 'feeder_db' || !w.sld) continue;
      const dev = w.sld.device ? AppState.components.get(w.sld.device) : null;
      const a = Number(w.breaker_a) || 0;
      if (dev && this.deviceEditable(dev) && a > 0 && Components._deviceRatingA(dev) !== a) {
        dev.props.rated_current_a = a;
        if (dev.type === 'cb') dev.props.trip_rating_a = a;
        any = true;
      }
      if (dev && dev.type === 'cb' && dev.props.cb_type === 'mcb' && this.deviceEditable(dev)
          && ['B', 'C', 'D'].includes(w.curve) && dev.props.mcb_curve !== w.curve) {
        dev.props.mcb_curve = w.curve; any = true;
      }
      const cab = w.sld.cable ? AppState.components.get(w.sld.cable) : null;
      const m = Number(w.cable_m);
      if (cab && m > 0 && Math.abs((Number(cab.props.length_km) || 0) * 1000 - m) > 0.005) {
        cab.props.length_km = m / 1000; any = true;
      }
    }
    return any;
  },

  // Why a linked way's field cannot be typed in the schedule ('' = it can).
  lockReason(way, key) {
    if (!way || way.type !== 'feeder_db' || !way.sld) return '';
    const dev = way.sld.device ? AppState.components.get(way.sld.device) : null;
    const cab = way.sld.cable ? AppState.components.get(way.sld.cable) : null;
    const nm = (c) => c.props.name || c.id;
    if (key === 'poles' || key === 'phase') return 'A sub-board feeder is three-phase.';
    if (dev && (key === 'breaker_a' || key === 'curve' || key === 'device') && (key === 'device' || !this.deviceEditable(dev))) {
      return `Set on the single line — ${nm(dev)}${dev.props.standard_type ? ' is a library breaker' : ''}.`;
    }
    if (cab && key === 'cable_mm2') return `Set on the single line — pick the cable for ${nm(cab)}.`;
    return '';
  },

  // A short "from the SLD" tag for a grid cell, or ''.
  cellTag(way, key) {
    if (!way || way.type !== 'feeder_db' || !way.sld) return '';
    const id = (key === 'cable_mm2' || key === 'cable_m') ? way.sld.cable
      : (key === 'breaker_a' ? way.sld.device : null);
    const c = id ? AppState.components.get(id) : null;
    if (!c) return '';
    return `<span class="db-sld-tag" title="Linked to ${escHtml(c.props.name || c.id)} on the single line">SLD</span>`;
  },
};
