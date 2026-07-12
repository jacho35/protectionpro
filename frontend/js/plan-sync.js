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
 * Reticulation remains independently editable; this is a push, never a pull.
 */

const PlanSync = {
  PHASES: ['Red', 'White', 'Blue'],

  _factor() {
    const s = AppState.planMarkup.scale;
    return (s && s.factor) ? s.factor : null;
  },

  _routeLenM(r, factor) {
    let px = 0;
    for (let i = 1; i < r.points.length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
    return factor ? +(px * factor).toFixed(2) : 0;
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
  _resolve(rows, el) {
    if (el.reticId) { const byId = rows.find(r => r.id === el.reticId); if (byId) return byId; }
    const nm = (el.name || '').trim().toLowerCase();
    if (!nm) return null;
    return rows.find(r => (r.name || '').trim().toLowerCase() === nm) || null;
  },

  async pushToSchedules() {
    const pm = AppState.planMarkup;
    const factor = this._factor();
    if (!factor) {
      const ok = await UI.confirm('Plan is not calibrated — push topology without measured lengths?', { danger: false });
      if (!ok) return;
    }
    const R = AppState.reticulation;
    const elById = this._elById();
    const summary = { minisubs: 0, kiosks: 0, erfs: 0, feeders: 0, sl: 0 };

    // 1) Minisubs
    const msEls = pm.elements.filter(e => e.type === 'minisub');
    // Adopt the default lone 'source' minisub if it's still untouched.
    const defaultSourceOnly = R.minisubs.length === 1 && R.minisubs[0].id === 'source' &&
      !R.kiosks.some(k => k.fedFrom && k.fedFrom !== 'source');
    let adopted = false;
    for (const el of msEls) {
      let row = this._resolve(R.minisubs, el);
      if (!row && defaultSourceOnly && !adopted) {
        row = R.minisubs[0]; row.name = el.name || row.name; adopted = true;
      } else if (!row) {
        row = { id: AppState.reticGenMinisubId(), name: el.name || 'Minisub' };
        R.minisubs.push(row); summary.minisubs++;
      } else {
        row.name = el.name || row.name;
      }
      el.reticId = row.id;
    }

    // 2) Kiosks
    const kioskEls = pm.elements.filter(e => e.type === 'kiosk');
    for (const el of kioskEls) {
      let row = this._resolve(R.kiosks, el);
      if (!row) {
        row = Retic._newKiosk(R.minisubs[0] ? R.minisubs[0].id : 'source');
        row.name = el.name || row.name;
        R.kiosks.push(row); summary.kiosks++;
      } else {
        row.name = el.name || row.name;
      }
      el.reticId = row.id;
    }

    // 3) fedFrom walk over LV routes (BFS from each minisub element)
    this._walkFeeders(pm, elById, factor, R, summary);

    // 4) Service routes → erven under their kiosk
    for (const r of pm.routes) {
      if (this._effectiveType(r, elById) !== 'service') continue;
      const a = elById[r.fromId], b = elById[r.toId];
      if (!a || !b) continue;
      const kioskEl = a.type === 'kiosk' ? a : b.type === 'kiosk' ? b : null;
      const erfEl = a.type === 'erf' ? a : b.type === 'erf' ? b : null;
      if (!kioskEl || !erfEl || !kioskEl.reticId) continue;
      const krow = R.kiosks.find(k => k.id === kioskEl.reticId);
      if (!krow) continue;
      const erfName = (erfEl.name || '').trim();
      let erf = erfEl.reticId && krow.erfs.find(e => e.id === erfEl.reticId);
      if (!erf) erf = krow.erfs.find(e => (e.erfNumber || '').trim().toLowerCase() === erfName.toLowerCase());
      const len = this._routeLenM(r, factor);
      if (!erf) {
        erf = {
          id: AppState.reticGenErfId(),
          erfNumber: erfName || String(krow.erfs.length + 1),
          length: len || (Retic.settings.quickServiceLen || 30),
          phase: this.PHASES[krow.erfs.length % 3],
          cableType: r.cableType || Retic.settings.quickServiceCable || '',
          ampsOverride: 0,
        };
        krow.erfs.push(erf); summary.erfs++;
      } else {
        if (len) erf.length = len;
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
      if (krow) { krow.streetLightKVA = +v.toFixed(3); summary.sl++; }
    }

    AppState.dirty = true;
    if (typeof Retic !== 'undefined') {
      if (Retic._snapshot) Retic._snapshot();
      if (Retic._active) { Retic.render && Retic.render(); Retic.recompute && Retic.recompute(); }
    }
    const extra = [];
    const mv = pm.routes.filter(r => r.type === 'mv').length;
    if (mv) extra.push(`${mv} MV route(s)`);
    if (pm.trenches.length) extra.push(`${pm.trenches.length} trench(es)`);
    if (pm.crossings.length) extra.push(`${pm.crossings.length} crossing(s)`);
    UI.alert(
      `Pushed to Reticulation:\n` +
      `• ${summary.minisubs} new minisub(s), ${summary.kiosks} new kiosk(s), ${summary.erfs} new erf(s)\n` +
      `• ${summary.feeders} feeder link(s), ${summary.sl} kiosk SL load(s)` +
      (extra.length ? `\n\n${extra.join(', ')} → included in the CSV/DXF exports only.` : ''));
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
            const len = this._routeLenM(edge.route, factor);
            if (len) krow.feederLength = len;
            if (edge.route.cableType) krow.feederCable = edge.route.cableType;
            summary.feeders++;
          }
        }
        queue.push(edge.other);
      }
    }
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
      // Upstream = the end reached via an outgoing bus; else keep order.
      let up = ends.find(e => e.viaBus) || ends[0];
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

  // Record/refresh a "Feeder to Sub-board" way in the upstream DB's schedule.
  _ensureFeederCircuit(dbComp, subComp, cableType, lenM) {
    if (!Array.isArray(dbComp.props.circuits)) dbComp.props.circuits = [];
    const circuits = dbComp.props.circuits;
    let c = circuits.find(x => x.type === 'feeder_db' && x.feedsDbId === subComp.id);
    if (!c) {
      c = {
        type: 'feeder_db', way: String(circuits.length + 1),
        description: '', poles: '3P', phase: 'RWB', breaker_a: 63, curve: 'C',
        el_group: '', cable_mm2: 25, cable_m: 0, load_va: 0, demand_factor: 1,
        leakage_ma: 0, feedsDbId: subComp.id,
      };
      circuits.push(c);
    }
    c.description = 'Feeder to ' + (subComp.props.name || 'Sub-board');
    if (cableType) c.cable = cableType;
    if (lenM) c.cable_m = +lenM.toFixed(2);
  },

  // Drop "Feeder to Sub-board" ways whose feeder no longer exists on the SLD
  // (the outgoing bus no longer has a cable to that sub-board).
  _pruneFeederCircuits() {
    for (const db of AppState.components.values()) {
      if (db.type !== 'distribution_board' || !Array.isArray(db.props.circuits)) continue;
      const outBus = db.outBusId ? AppState.components.get(db.outBusId) : null;
      db.props.circuits = db.props.circuits.filter(c => {
        if (c.type !== 'feeder_db') return true;
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

  // Collect entities on each side whose linked partner was deleted in the
  // other view — the set that deletion-propagation would remove. Cascades:
  // removing a board removes its feeders; removing a feeder removes its cable.
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

  // ─── Building distribution ↔ SLD bridge ───
  // Distribution boards drawn in the Plan become linked `distribution_board`
  // components on the SLD; feeders between boards become a Cable/Feeder
  // component wired MDB(out) → cable → SDB(in). Reconciles BOTH directions,
  // id-linked (idempotent). Deletions propagate across views on sync, behind a
  // confirmation. Building never touches the Reticulation schedule.
  async syncBuildingToSLD() {
    const pm = AppState.planMarkup;
    const comps = AppState.components;

    // ── 0. Propagate deletions (with confirmation) ──
    const del = this._collectDeletions(pm);
    if (del.boards + del.feeders > 0) {
      const ok = await UI.confirm(
        `Sync will remove ${del.boards} board/switchboard(s) and ${del.feeders} feeder(s) that were deleted in the other view. Remove them here too?`,
        { danger: true, okText: 'Remove', cancelText: 'Keep both' });
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

    const factor = this._factor();
    const dbEls = AppState.planAllElements().filter(e => e.type === 'bd_db');
    // Feeder routes across all floors, each carrying its own floor's scale.
    const feeders = [];
    for (const fl of AppState.planFloors()) {
      const f = this._floorFactorFor(fl);
      for (const r of (fl.data.routes || [])) if (r.type === 'feeder' && r.fromId && r.toId) feeders.push({ r, factor: f });
    }
    const elById = this._elById();
    const summary = { dbNew: 0, dbLinked: 0, cableNew: 0, planNew: 0 };

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
      const ca = AppState.components.get(a.sldId), cb = AppState.components.get(b.sldId);
      if (!ca || !cb) continue;
      const lenM = rf ? this._routeLenM(r, rf) : 0;
      let cable = r.sldCableId ? AppState.components.get(r.sldCableId) : null;
      if (!cable) {
        const src = this._feederSourcePoint(a);   // upstream connection {compId, port}
        const sink = this._feederSinkPoint(b);     // downstream connection
        if (!src || !sink) continue;
        const sc = AppState.components.get(src.compId);
        cable = AppState.addComponent('cable', sc.x, (sc.y + cb.y) / 2);
        AppState.addWire(src.compId, src.port, cable.id, 'from', true);
        AppState.addWire(cable.id, 'to', sink.compId, sink.port, true);
        r.sldCableId = cable.id;
        cable.planLink = r.id;
        summary.cableNew++;
      }
      if (r.cableType) cable.props.name = r.cableType;
      if (rf) cable.props.length_km = +(lenM / 1000).toFixed(4);
      const std = (typeof STANDARD_CABLES !== 'undefined') && STANDARD_CABLES.find(c => c.name === r.cableType);
      if (std) cable.props.standard_type = std.id;
      // A feeding DB records an outgoing "Feeder to Sub-board" way (switchboards
      // have no circuit schedule, so skip).
      if (a.type === 'bd_db') this._ensureFeederCircuit(ca, cb, r.cableType, lenM);
    }
    this._pruneEmptyOutBuses();

    // ── Reverse: SLD cables joining two linked plan elements → plan feeders ──
    summary.planNew += this.reflectSldFeeders();

    // Keep outgoing buses + feeder ways consistent with the surviving topology.
    this._pruneEmptyOutBuses();
    this._pruneFeederCircuits();

    AppState.dirty = true;
    if (typeof Canvas !== 'undefined') Canvas.render();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    if (typeof UI !== 'undefined') UI.alert(
      `Synced with SLD:\n` +
      `• ${summary.dbNew} new + ${summary.dbLinked} linked distribution board(s)\n` +
      `• ${summary.cableNew} feeder cable(s) created on the SLD\n` +
      `• ${summary.planNew} SLD cable(s) reflected back as plan feeders`);
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
    if (!el || !el.reticId || typeof AppState.reticulation === 'undefined') return;
    const R = AppState.reticulation;
    let row = R.minisubs.find(m => m.id === el.reticId) || R.kiosks.find(k => k.id === el.reticId);
    if (row) { row.name = newName; }
    else {
      // erf: find in whichever kiosk holds it
      for (const k of R.kiosks) {
        const erf = k.erfs.find(e => e.id === el.reticId);
        if (erf) { erf.erfNumber = newName; break; }
      }
    }
    if (typeof Retic !== 'undefined') {
      if (Retic._snapshot) Retic._snapshot();
      if (Retic._active && Retic.render) Retic.render();
    }
  },
};
