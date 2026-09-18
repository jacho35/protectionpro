/* ProtectionPro — Bill of quantities.
 *
 * A quantity take-off across every source the project has, priced from the
 * project's rate library (rates.js):
 *
 *   demand  Demand (reticulation): kiosk feeders and erf services (cable type
 *           × length), minisubs, kiosks
 *   plan    site / floor plans: routes by cable type, trenches, crossings,
 *           poles and devices, riser runs, junction-box joints
 *   sld     single-line diagram: cables, transformers, switchgear, CT/VT,
 *           relays, capacitor banks, surge arresters
 *   db      DB circuit schedules: board enclosures, final-circuit cable per
 *           way, breakers by poles / rating / curve, earth-leakage units,
 *           board accessories
 *
 * One cable is counted once. When two sources describe the same run, the
 * schedule wins over the drawing:
 *   • Demand feeders/services  over plan LV feeder / service routes
 *   • SLD cables made from the plan (planLink / riserLink) over those routes
 *   • DB way lengths           over final-circuit routes tagged to that way
 * A feeder-to-sub-board way contributes its breaker only; its cable is the
 * sub-main cable on the SLD.
 *
 * Terminations are itemized per cable size and type (TRM-<cable key>, one
 * cable end each): 2 ends per counted run × parallel runs, for Demand
 * feeders/services, SLD cables and typed plan routes. A run skipped by the
 * counted-once rule skips its terminations too. Final-circuit (DB way)
 * terminations are opt-in (opts.fcTerms), as those are usually priced per point.
 *
 * Every line is priced as material + labour (rates.js). Waste is material
 * that is bought but not installed, so it applies to material only:
 *   material = measured × (1 + waste %) × material rate   (bought qty rounded)
 *   labour   = measured × labour rate
 * The Qty column is the measured (net) quantity. opts.price picks what is
 * priced: 'both' (supply & install, default), 'supply' or 'install'.
 *
 * Items with neither rate are listed, left out of the total and flagged —
 * never priced at 0. An item with only one of the two rates is priced.
 */

const BOQ = {
  SOURCES: [
    { id: 'demand', label: 'Demand (reticulation)', hint: 'Kiosk feeders, erf services, minisubs, kiosks' },
    { id: 'plan', label: 'Site / floor plans', hint: 'Routes, trenches, crossings, devices, risers, JB joints' },
    { id: 'sld', label: 'Single-line diagram', hint: 'Cables, transformers, switchgear on the SLD' },
    { id: 'db', label: 'DB circuit schedules', hint: 'Boards, final-circuit cable, breakers, EL units' },
    { id: 'rule', label: 'Rules (not drawn)', hint: 'Items counted from project totals: meter boxes, warning tape, testing…' },
  ],
  SECTION: {
    cable: 'Cables — by type',
    term: 'Terminations — by cable size and type',
    equip: 'Equipment',
    prot: 'Protective devices',
    civil: 'Civils, containment & labour',
    allow: 'Preliminaries & allowances',
  },
  PRICE: [
    { id: 'both', label: 'Supply & install' },
    { id: 'supply', label: 'Supply only' },
    { id: 'install', label: 'Install only' },
  ],
  opts: null,        // { sources: {demand, plan, sld, db}, waste, merge, zero, price }

  // "Quantity from" vocabulary for rate-item rules (rates.js). Ids are fixed —
  // rules store the id, so relabelling never breaks one. Counted in collect()
  // with the same source ticks and counted-once logic as the bill itself, as
  // the measured quantity before waste.
  get BASES() {
    const out = [
      { id: 'erven', label: 'Erven', unit: 'ea', group: 'Reticulation' },
      { id: 'erven_1ph', label: 'Erven, single-phase', unit: 'ea', group: 'Reticulation' },
      { id: 'erven_3ph', label: 'Erven, three-phase', unit: 'ea', group: 'Reticulation' },
      { id: 'kiosks', label: 'Kiosks', unit: 'ea', group: 'Reticulation' },
      { id: 'minisubs', label: 'Minisubs', unit: 'ea', group: 'Reticulation' },
      { id: 'lv_feeders', label: 'LV feeder runs', unit: 'ea', group: 'Reticulation' },
      { id: 'services', label: 'Service connections', unit: 'ea', group: 'Reticulation' },
      { id: 'cable_lv_m', label: 'LV cable, m', unit: 'm', group: 'Cable' },
      { id: 'cable_mv_m', label: 'MV cable, m', unit: 'm', group: 'Cable' },
      { id: 'service_m', label: 'Service cable, m', unit: 'm', group: 'Cable' },
      { id: 'trench_m', label: 'Trench, m (all types)', unit: 'm', group: 'Civils' },
    ];
    for (const [t, d] of Object.entries((typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.trenchTypes) || {})) {
      out.push({ id: 'trench_m:' + t, label: `Trench, m: ${d.name}`, unit: 'm', group: 'Civils' });
    }
    out.push(
      { id: 'crossings', label: 'Road crossings', unit: 'ea', group: 'Civils' },
      { id: 'boards', label: 'Distribution boards', unit: 'ea', group: 'Building' },
      { id: 'ways', label: 'DB circuits (ways)', unit: 'ea', group: 'Building' },
      { id: 'lights', label: 'Light points', unit: 'ea', group: 'Building' },
      { id: 'sockets', label: 'Socket outlets', unit: 'ea', group: 'Building' },
      { id: 'switches', label: 'Light switches', unit: 'ea', group: 'Building' },
      { id: 'floors', label: 'Floors', unit: 'ea', group: 'Building' },
      { id: 'fixed', label: 'Fixed quantity (lump sum)', unit: '', group: 'Other' },
    );
    return out;
  },
  basis(id) { return this.BASES.find(b => b.id === id) || null; },

  // ── Take-off ────────────────────────────────────────────────────────
  _hasDemand() {
    const R = AppState.reticulation;
    return !!(R && Array.isArray(R.kiosks) && R.kiosks.length);
  },
  _hasPlan() {
    try {
      return (AppState.planFloors() || []).some(fl => ['routes', 'elements', 'trenches', 'crossings']
        .some(k => (fl.data[k] || []).length));
    } catch (e) { return false; }
  },
  _hasSLD() {
    for (const c of AppState.components.values()) if (['cable', 'transformer', 'cb', 'fuse', 'switch', 'distribution_board'].includes(c.type)) return true;
    return false;
  },
  _hasDB() {
    for (const c of AppState.components.values()) if (c.type === 'distribution_board' && (c.props.circuits || []).length) return true;
    return false;
  },
  // Rules count from what the other sources measure, so an empty project has
  // nothing for them to count either (and no lump sums appear in it).
  available() {
    const av = { demand: this._hasDemand(), plan: this._hasPlan(), sld: this._hasSLD(), db: this._hasDB() };
    av.rule = av.demand || av.plan || av.sld || av.db;
    return av;
  },
  defaultSources() {
    const av = this.available();
    const t = AppState.projectType;
    if (t === 'retic') return { demand: av.demand, plan: av.plan, sld: false, db: false, rule: av.rule };
    if (t === 'building') return { demand: false, plan: av.plan, sld: av.sld, db: av.db, rule: av.rule };
    return av;
  },

  // Cable name → rate item. Library names give library keys; anything else
  // still gets a stable key from its name.
  _fmtFactor(f) { return String(+Number(f).toFixed(6)); },
  _cable(name) { return { key: Rates.cableKey(name), desc: Rates.cableDesc(name), unit: 'm', cat: 'cable' }; },

  collect(opts) {
    opts = opts || this.opts || {};
    const inc = Object.assign({ demand: true, plan: true, sld: true, db: true, rule: true }, opts.sources || {});
    const cat = new Map(Rates.catalogue().map(c => [c.key, c]));
    const lines = new Map();
    const warnings = [], notes = [];
    const add = (item, qty, src, label, runs) => {
      if (!item || !(qty > 0) && !opts.zero) return;
      const known = cat.get(item.key) || {};
      const id = opts.merge === false ? `${item.key}|${src}` : item.key;
      let l = lines.get(id);
      if (!l) {
        l = { key: item.key, desc: known.desc || item.desc, unit: item.unit || known.unit || 'ea', cat: item.cat || known.cat || Rates.guessCat(item.key), qty: 0, from: [], srcs: new Set() };
        lines.set(id, l);
      }
      l.qty += Number(qty) || 0;
      l.srcs.add(src);
      if (label && !l.from.includes(label)) l.from.push(label);
      if (label && runs) { l.runs = l.runs || {}; l.runs[label] = (l.runs[label] || 0) + runs; }
    };
    // Two ends per run × parallel runs, itemized per cable size and type.
    const term = (cableItem, runs, src, label) => {
      if (opts.terms === false || !cableItem || !(runs > 0)) return;
      add(Rates.termItem(cableItem), 2 * runs, src, label, runs);
    };
    const hasDemand = this._hasDemand();
    // Bases for quantity rules; the line-derived ones are filled in at the end.
    const bases = { erven: 0, erven_1ph: 0, erven_3ph: 0, lv_feeders: 0, services: 0, service_m: 0, trench_m: 0, crossings: 0, ways: 0, lights: 0, sockets: 0, switches: 0, floors: 0, fixed: 1 };
    for (const t of Object.keys((typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.trenchTypes) || {})) bases['trench_m:' + t] = 0;

    // ── Demand ──
    if (inc.demand && hasDemand) {
      const R = AppState.reticulation;
      let noFeederType = 0, noSvcType = 0;
      for (const k of R.kiosks) {
        const len = Number(k.feederLength) || 0;
        if (len > 0) {
          if (k.feederCable) {
            bases.lv_feeders++;
            add(this._cable(k.feederCable), len, 'demand', 'Demand feeders');
            term(this._cable(k.feederCable), 1, 'demand', 'Demand feeders');
          } else noFeederType++;
        }
        for (const e of (k.erfs || [])) {
          bases.erven++;
          // Same 3-phase rule as the Demand engine: the erf's own phase, or a 3Φ load class.
          const three = typeof Retic !== 'undefined' && Retic._erfIs3ph ? Retic._erfIs3ph(k, e) : e.phase === '3 Phase';
          bases[three ? 'erven_3ph' : 'erven_1ph']++;
          const l = Number(e.length) || 0;
          if (!(l > 0)) continue;
          if (e.cableType) {
            bases.services++;
            bases.service_m += l;
            add(this._cable(e.cableType), l, 'demand', 'Demand services');
            term(this._cable(e.cableType), 1, 'demand', 'Demand services');
          } else noSvcType++;
        }
      }
      add({ key: 'EQ-MINISUB' }, (R.minisubs || []).length, 'demand', 'Demand minisubs');
      add({ key: 'EQ-KIOSK' }, R.kiosks.length, 'demand', 'Demand kiosks');
      if (noFeederType) warnings.push(`${noFeederType} kiosk feeder${noFeederType > 1 ? 's have' : ' has'} a length but no cable type, so ${noFeederType > 1 ? 'they are' : 'it is'} not counted.`);
      if (noSvcType) warnings.push(`${noSvcType} erf service${noSvcType > 1 ? 's have' : ' has'} a length but no cable type, so ${noSvcType > 1 ? 'they are' : 'it is'} not counted.`);
    }

    // SLD cables made from plan routes: route id → SLD cable.
    const sldByRoute = new Map(), riserSld = new Set();
    for (const c of AppState.components.values()) {
      if (c.type !== 'cable') continue;
      if (c.planLink) sldByRoute.set(c.planLink, c);
      if (c.riserLink) { sldByRoute.set(c.riserLink, c); riserSld.add(c.riserShaft || c.riserLink); }
    }
    // DB ways by id / number, for final-circuit routes tagged to a way.
    const wayOf = (dbElId, wid, no) => {
      if (typeof PlanCircuits === 'undefined') return null;
      const comp = PlanCircuits._sldComp && PlanCircuits._sldComp(PlanCircuits._boardById(dbElId));
      if (!comp || !Array.isArray(comp.props.circuits)) return null;
      return (wid && comp.props.circuits.find(x => x.id === wid)) || comp.props.circuits.find(x => String(x.way) === String(no) && x.type !== 'feeder_db') || null;
    };

    // ── Plans ──
    if (inc.plan && typeof PlanCSV !== 'undefined') {
      let floors = [];
      try { floors = AppState.planFloors() || []; } catch (e) { floors = []; }
      const elById = PlanCSV._elById();
      const CIRCUIT_ROUTES = (typeof PlanCircuits !== 'undefined' && PlanCircuits.CIRCUIT_ROUTES) || ['circuit', 'lighting_ckt'];
      // Route ids that belong to a riser shaft the SLD already carries.
      const riserRoutes = new Set();
      if (inc.sld && riserSld.size && typeof PlanSync !== 'undefined' && PlanSync._riserShafts) {
        try {
          for (const { shaft, legs } of PlanSync._riserShafts()) {
            if (!legs.some(l => sldByRoute.has(l.route && l.route.id)) && !riserSld.has(shaft)) continue;
            for (const l of legs) if (l.route) riserRoutes.add(l.route.id);
          }
        } catch (e) { /* plan helpers unavailable — count the routes */ }
      }
      let skipDemand = 0, skipSld = 0, skipWay = 0, unscaled = 0;
      for (const fl of floors) {
        const f = PlanCSV._floorFactor(fl);
        const d = fl.data || {};
        for (const r of (d.routes || [])) {
          const et = PlanCSV._effectiveType(r, elById);
          if (inc.demand && hasDemand && (et === 'lv' || et === 'service')) { skipDemand++; continue; }
          if (inc.sld && (sldByRoute.has(r.id) || riserRoutes.has(r.id))) { skipSld++; continue; }
          if (inc.db && CIRCUIT_ROUTES.includes(r.type)) {
            const ids = [r.fromId, r.toId, ...(r.points || []).map(p => p.snappedTo)].filter(Boolean);
            const tagged = ids.map(id => elById[id]).find(e => e && e.props && e.props.circuitDbId && e.props.circuitNo != null);
            if (tagged && wayOf(tagged.props.circuitDbId, tagged.props.circuitWid, tagged.props.circuitNo)) { skipWay++; continue; }
          }
          if (!f) { unscaled++; continue; }
          const len = PlanCSV._routeLenM(r, f);
          const def = PLAN_DEFS.route(et) || PLAN_DEFS.route(r.type) || {};
          const item = r.cableType ? this._cable(r.cableType) : { key: Rates.routeKey(et), desc: def.name || et, unit: 'm' };
          add(item, len, 'plan', `Plan ${(def.name || et)} routes`);
          if (r.cableType && len > 0) term(item, 1, 'plan', `Plan ${(def.name || et)} routes`);
        }
        for (const el of (d.elements || [])) {
          if (el.type === 'erf') { if (!(inc.demand && hasDemand)) bases.erven++; continue; }
          if (el.type === 'bd_light') bases.lights++;
          else if (el.type === 'bd_socket') bases.sockets++;
          else if (el.type === 'bd_switch') bases.switches++;
          if (el.type === 'minisub' || el.type === 'kiosk') {
            if (!(inc.demand && hasDemand)) add({ key: el.type === 'minisub' ? 'EQ-MINISUB' : 'EQ-KIOSK' }, 1, 'plan', el.type === 'minisub' ? 'Plan minisubs' : 'Plan kiosks');
            continue;
          }
          if (el.type === 'bd_db' || el.type === 'bd_switchboard') {
            const onSld = el.sldId && AppState.components.get(el.sldId);
            if (!((inc.sld || inc.db) && onSld)) add({ key: el.type === 'bd_db' ? 'EQ-DB' : 'EQ-SWITCHBOARD' }, 1, 'plan', 'Plan boards');
            continue;
          }
          const it = Rates.planElementItem(el);
          if (it) add(it, 1, 'plan', 'Plan ' + ((PLAN_DEFS.element(el.type) || {}).name || el.type).toLowerCase() + 's');
        }
        if ((d.trenches || []).length && !f) unscaled += d.trenches.length;
        for (const t of (d.trenches || [])) {
          if (!f) continue;
          let px = 0;
          for (let i = 1; i < (t.points || []).length; i++) px += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y);
          const tt = (PLAN_DEFS.trenchTypes || {})[t.excType] || {};
          bases.trench_m += px * f;
          bases['trench_m:' + t.excType] = (bases['trench_m:' + t.excType] || 0) + px * f;
          add({ key: Rates.trenchKey(t.excType), desc: tt.name || `${t.excType} trench`, unit: 'm' }, px * f, 'plan', 'Plan trenches');
        }
        bases.crossings += (d.crossings || []).length;
        for (const c of (d.crossings || [])) add({ key: Rates.crossingKey(c.size), desc: `Road crossing, ${c.size || ''} mm sleeve`, unit: 'ea' }, 1, 'plan', 'Plan crossings');
      }
      if (!(inc.sld && riserSld.size)) {
        const v = PlanCSV._verticalRuns ? PlanCSV._verticalRuns() : [];
        const vtot = v.reduce((s, x) => s + (Number(x.length) || 0), 0);
        if (vtot) add({ key: 'CBL-ROUTE-RISER' }, vtot, 'plan', 'Plan riser runs');
      }
      if (AppState.planMarkup && AppState.planMarkup.settings && AppState.planMarkup.settings.domain === 'building') bases.floors = floors.length;
      if (typeof PlanCircuits !== 'undefined' && PlanCircuits.jbJointTotals) {
        try {
          const j = PlanCircuits.jbJointTotals();
          add({ key: 'LAB-JB-SPLICE' }, j.splices, 'plan', 'Plan junction boxes');
          add({ key: 'LAB-JB-TERM' }, j.terminations, 'plan', 'Plan junction boxes');
        } catch (e) { /* no building plan */ }
      }
      if (skipDemand) notes.push(`${skipDemand} plan LV feeder / service route${skipDemand > 1 ? 's are' : ' is'} not counted: Demand holds ${skipDemand > 1 ? 'their' : 'its'} length.`);
      if (skipSld) notes.push(`${skipSld} plan route${skipSld > 1 ? 's are' : ' is'} counted from ${skipSld > 1 ? 'their' : 'its'} single-line cable.`);
      if (skipWay) notes.push(`${skipWay} final-circuit route${skipWay > 1 ? 's are' : ' is'} counted from the DB schedule way ${skipWay > 1 ? 'they are' : 'it is'} tagged to.`);
      if (unscaled) warnings.push(`${unscaled} plan route${unscaled > 1 ? 's / trenches are' : ' / trench is'} on a floor with no scale, so ${unscaled > 1 ? 'they are' : 'it is'} not measured. Calibrate the plan.`);
    }

    // ── Single-line diagram ──
    if (inc.sld) {
      const untyped = [];
      const routeById = {};
      try { for (const r of AppState.planAllRoutes()) routeById[r.id] = r; } catch (e) { /* no plan */ }
      for (const c of AppState.components.values()) {
        const p = c.props || {};
        if (c.type === 'cable') {
          const len = (Number(p.length_km) || 0) * 1000 * (Math.max(1, Number(p.num_parallel) || 1));
          let item = null;
          if (p.construction === 'overhead' || p.overhead_type) {
            const oh = (typeof STANDARD_OVERHEAD_LINES !== 'undefined') && STANDARD_OVERHEAD_LINES.find(o => o.id === p.overhead_type);
            item = oh ? { key: 'OHL-' + Rates.slug(oh.name), desc: oh.name + ' overhead conductor', unit: 'm' } : null;
          } else {
            const std = CableLib.byId(p.standard_type);
            const linked = routeById[c.planLink] || routeById[c.riserLink];
            const named = CableLib.byName(p.name);
            const nm = std ? std.name : (linked && linked.cableType) || (named && named.name) || null;
            if (nm) item = this._cable(nm);
          }
          const typed = !!item && !String(item.key).startsWith('OHL-');
          if (!item) { item = { key: 'CBL-UNTYPED', unit: 'm' }; if (len > 0) untyped.push(p.name || c.id); }
          add(item, len, 'sld', 'SLD cables');
          if (typed && len > 0) term(item, Math.max(1, Number(p.num_parallel) || 1), 'sld', 'SLD cables');
        } else if (c.type === 'transformer') add(Object.assign(Rates.txItem(p), { unit: 'ea', cat: 'equip' }), 1, 'sld', 'SLD transformers');
        else if (c.type === 'cb') add(Object.assign(Rates.cbItem(p), { unit: 'ea', cat: 'prot' }), 1, 'sld', 'SLD breakers');
        else if (c.type === 'fuse') add(Object.assign(Rates.fuseItem(p), { unit: 'ea', cat: 'prot' }), 1, 'sld', 'SLD fuses');
        else if (c.type === 'switch') {
          const a = Number(p.rated_current_a) || 0;
          add({ key: `SW-ISOLATOR-${a}A`, desc: `Isolator / switch ${a} A`, unit: 'ea', cat: 'prot' }, 1, 'sld', 'SLD switches');
        } else if (c.type === 'ct') add({ key: 'EQ-CT' }, 1, 'sld', 'SLD CTs');
        else if (c.type === 'pt') add({ key: 'EQ-VT' }, 1, 'sld', 'SLD VTs');
        else if (c.type === 'relay') add({ key: 'EQ-RELAY' }, 1, 'sld', 'SLD relays');
        else if (c.type === 'capacitor_bank') add({ key: 'EQ-CAPACITOR-BANK' }, 1, 'sld', 'SLD capacitor banks');
        else if (c.type === 'surge_arrester') add({ key: 'EQ-SURGE-ARRESTER' }, 1, 'sld', 'SLD surge arresters');
        else if (c.type === 'distribution_board' && !(inc.db && (p.circuits || []).length)) add({ key: 'EQ-DB' }, 1, 'sld', 'SLD boards');
      }
      if (untyped.length) warnings.push(`${untyped.length} single-line cable${untyped.length > 1 ? 's have' : ' has'} no library type and ${untyped.length > 1 ? 'are' : 'is'} counted as "untyped": ${untyped.slice(0, 6).join(', ')}${untyped.length > 6 ? '…' : ''}.`);
    }

    // ── DB circuit schedules ──
    if (inc.db) {
      const POLES = { '1P': 1, '2P': 2, '3P': 3, '4P': 4 };
      for (const comp of AppState.components.values()) {
        if (comp.type !== 'distribution_board') continue;
        const ways = comp.props.circuits || [];
        if (!ways.length) continue;
        const modules = ways.reduce((s, w) => s + (POLES[w.poles] || 1), 0);
        add({ key: Rates.dbKey(modules), unit: 'ea' }, 1, 'db', 'DB schedules');
        for (const w of ways) {
          const a = Number(w.breaker_a) || 0;
          const poles = POLES[w.poles] ? w.poles : '1P';
          if (a > 0) {
            if (a <= 125) add({ key: Rates.mcbKey(poles, a, w.curve || 'C'), desc: `MCB ${poles} ${a} A curve ${w.curve || 'C'}`, unit: 'ea', cat: 'prot' }, 1, 'db', w.type === 'feeder_db' ? 'DB feeders' : 'DB circuits');
            else add({ key: `CB-MCCB-${poles}-${a}A`, desc: `MCCB ${poles} ${a} A`, unit: 'ea', cat: 'prot' }, 1, 'db', w.type === 'feeder_db' ? 'DB feeders' : 'DB circuits');
          }
          const spare = !(Number(w.load_va) > 0) && /spare/i.test(w.description || '');
          if (!spare) bases.ways++;
          if (w.type === 'feeder_db') continue;               // sub-main cable is on the SLD
          const m = Number(w.cable_m) || 0;
          if (spare || !(m > 0)) continue;
          const fc = w.cable ? this._cable(w.cable)
            : Number(w.cable_mm2) > 0 ? Object.assign(Rates.fcCable(w.cable_mm2, poles), { unit: 'm', cat: 'cable' }) : null;
          if (fc) {
            add(fc, m, 'db', 'DB circuits');
            if (opts.fcTerms) term(fc, 1, 'db', 'DB circuits');
          }
        }
        if (typeof DBSchedule !== 'undefined' && DBSchedule._leakageGroups) {
          const { ratings } = DBSchedule._leakageGroups(comp);
          for (const [g, ma] of Object.entries(ratings)) {
            const four = ways.some(w => String(w.el_group || '').trim() === g && /^[34]P$/.test(w.poles));
            add({ key: Rates.elKey(four ? '4P' : '2P', ma), desc: `Earth leakage unit ${four ? '4P' : '2P'}, ${ma} mA`, unit: 'ea', cat: 'prot' }, 1, 'db', 'DB EL groups');
          }
        }
        for (const acc of (comp.props.accessories || [])) {
          const k = (typeof DB_ACCESSORY_KINDS !== 'undefined') && DB_ACCESSORY_KINDS.find(x => x.key === acc.kind);
          add({ key: Rates.accKey(acc.kind), desc: k ? k.label : acc.kind, unit: 'ea', cat: 'prot' }, 1, 'db', 'DB accessories');
        }
      }
    }

    // Bases taken from the bill's own lines, so they can never disagree with it.
    const out = [...lines.values()];
    const sum = (pred) => out.filter(pred).reduce((s, l) => s + l.qty, 0);
    const libByKey = new Map((typeof CableLib !== 'undefined' ? CableLib.all() : []).map(c => [Rates.cableKeyOf(c), c]));
    bases.kiosks = sum(l => l.key === 'EQ-KIOSK');
    bases.minisubs = sum(l => l.key === 'EQ-MINISUB');
    bases.boards = sum(l => /^EQ-DB(-|$)/.test(l.key) || l.key === 'EQ-SWITCHBOARD');
    const cableM = (mv) => sum(l => {
      if (l.cat !== 'cable' || l.unit !== 'm') return false;
      const c = libByKey.get(l.key);
      if (c) return !!CableLib.isMV(c) === mv;
      return !mv && /^CBL-FC-/.test(l.key);                 // generic final-circuit cable is LV
    });
    bases.cable_lv_m = cableM(false);
    bases.cable_mv_m = cableM(true);

    // ── Rules: items nobody draws, counted from the bases ──
    if (inc.rule) {
      const L = AppState.rateLibrary || {};
      const items = [...cat.values()];
      for (const [k, c] of Object.entries(L.custom || {})) if (!cat.has(k)) items.push({ key: k, desc: c.desc || k, unit: c.unit || 'ea', cat: c.cat || Rates.guessCat(k) });
      const measured = new Set(out.filter(l => l.qty > 0).map(l => l.key));
      for (const it of items) {
        const rule = Rates.getRule(it.key);
        if (!rule || rule.basis === 'pct' || !(rule.factor > 0)) continue;
        const b = this.basis(rule.basis);
        if (!b) { warnings.push(`${it.desc}: its rule counts from "${rule.basis}", which is not a quantity this app knows. Not counted.`); continue; }
        if (measured.has(it.key)) { warnings.push(`${it.desc}: has a rule and is also measured; the measured quantity is used.`); continue; }
        const f = this._fmtFactor(rule.factor);
        if (rule.basis === 'fixed') { add(it, rule.factor, 'rule', `Rule: fixed ${f}`); continue; }
        const v = bases[rule.basis] || 0;
        const shown = b.unit === 'm' ? Rates._group(v.toFixed(1)) : Rates._group(String(Math.round(v)));
        if (!(v > 0)) {
          if (Rates.priced(Rates.get(it.key, it.cat))) {
            notes.push(/^erven_[13]ph$/.test(rule.basis) && !(inc.demand && hasDemand)
              ? `${it.desc}: rule ${f} × ${b.label.toLowerCase()}. The phase split needs Demand data, and this bill has none.`
              : `${it.desc}: rule ${f} × ${b.label.toLowerCase()}, but this project has no ${b.label.toLowerCase().replace(/, m\b.*$/, '')}.`);
          }
          if (opts.zero) add(it, 0, 'rule', `Rule: ${f} × ${b.label} (0)`);
          continue;
        }
        add(it, rule.factor * v, 'rule', `Rule: ${f} × ${b.label} (${shown})`);
      }
    }
    return { lines: [...lines.values()], warnings, notes, bases };
  },

  // Take-off + rates → priced, sectioned bill.
  compute(opts) {
    opts = opts || this.opts || this._defaultOpts();
    const { lines, warnings, notes, bases } = this.collect(opts);
    const order = Rates.CATS.map(c => c.id);
    const price = opts.price || 'both';
    const doMat = price !== 'install', doLab = price !== 'supply';
    const out = { sections: [], total: 0, mat: 0, lab: 0, allow: 0, totalBefore: 0, nItems: 0, nPriced: 0, cableM: 0, missing: [], warnings, notes, price, bases };
    const round = (q, unit) => unit === 'm' ? Math.round(q * 10) / 10 : Math.ceil(q - 1e-9);
    const r2 = v => Math.round(v * 100) / 100;
    for (const c of order) {
      if (c === 'allow') continue;                               // percentage lines: below
      const ls = lines.filter(l => l.cat === c).map(l => {
        const r = Rates.get(l.key, l.cat);
        const w = opts.waste === false ? 0 : r.waste;
        const qty = round(l.qty, l.unit);                       // measured (net)
        const bought = round(l.qty * (1 + w / 100), l.unit);    // material bought, incl. waste
        // Priced = either rate entered, whatever the Price option shows.
        const priced = Rates.priced(r);
        const matAmount = doMat && r.rate != null ? r2(bought * r.rate) : null;
        const labAmount = doLab && r.labour != null ? r2(qty * r.labour) : null;
        const amount = priced ? r2((matAmount || 0) + (labAmount || 0)) : null;
        const from = l.from.map(f => l.runs && l.runs[f] ? `${f} · ${l.runs[f]} run${l.runs[f] > 1 ? 's' : ''}` : f);
        return Object.assign({}, l, { from, measured: l.qty, qty, bought, waste: w, rate: r.rate, labour: r.labour, priced, matAmount, labAmount, amount, supplier: r.supplier });
      }).filter(l => opts.zero || l.qty > 0);
      if (!ls.length) continue;
      ls.sort((a, b) => a.desc.localeCompare(b.desc, undefined, { numeric: true }));
      const mat = ls.reduce((s, l) => s + (l.matAmount || 0), 0);
      const lab = ls.reduce((s, l) => s + (l.labAmount || 0), 0);
      const subtotal = mat + lab;
      out.sections.push({ cat: c, label: this.SECTION[c], lines: ls, mat, lab, subtotal });
      out.total += subtotal;
      out.mat += mat;
      out.lab += lab;
      out.nItems += ls.length;
      out.nPriced += ls.filter(l => l.priced).length;
      out.cableM += ls.filter(l => l.unit === 'm' && l.cat === 'cable').reduce((s, l) => s + l.bought, 0);
      out.missing.push(...ls.filter(l => !l.priced));
    }
    out.totalBefore = out.total;
    // ── Preliminaries & allowances: a percent of the priced sections ──
    // Only ever of the sections above, never of another allowance, so they
    // don't compound. Dropped with the Rules source.
    if (!(opts.sources && opts.sources.rule === false) && out.sections.length) {
      const ls = [];
      const keys = new Set(Rates.catalogue().filter(c => c.cat === 'allow').map(c => c.key));
      const L = AppState.rateLibrary || {};
      for (const k of Object.keys(L.custom || {})) keys.add(k);
      for (const k of Object.keys(L.items || {})) keys.add(k);
      for (const key of keys) {
        const rule = Rates.getRule(key);
        if (!rule || rule.basis !== 'pct' || !(rule.factor > 0)) continue;   // no percent entered = off
        const of = (rule.of || []).filter(id => id !== 'allow');
        const secs = !of.length || of.includes('total') ? out.sections : out.sections.filter(s => of.includes(s.cat));
        const part = rule.part === 'material' ? 'mat' : rule.part === 'labour' ? 'lab' : 'subtotal';
        const base = secs.reduce((s, x) => s + x[part], 0);
        const known = Rates.catalogue().find(c => c.key === key) || (L.custom || {})[key] || {};
        const desc = known.desc || key;
        if (!(base > 0)) { notes.push(`${desc}: ${Rates.pctOfText(rule)}, but that comes to nothing in this bill.`); continue; }
        const amount = r2(base * rule.factor / 100);
        ls.push({ key, desc, unit: '%', cat: 'allow', pct: true, qty: rule.factor, measured: rule.factor, bought: rule.factor, waste: 0,
          base, rate: null, labour: null, priced: true, matAmount: null, labAmount: null, amount, supplier: '', srcs: new Set(['rule']), from: [Rates.pctOfText(rule)] });
      }
      if (ls.length) {
        ls.sort((a, b) => a.desc.localeCompare(b.desc, undefined, { numeric: true }));
        const subtotal = ls.reduce((s, l) => s + l.amount, 0);
        out.sections.push({ cat: 'allow', label: this.SECTION.allow, lines: ls, mat: 0, lab: 0, subtotal, pct: true });
        out.allow = subtotal;
        out.total += subtotal;
        out.nItems += ls.length;
        out.nPriced += ls.length;
      }
    }
    return out;
  },

  _defaultOpts() { return { sources: this.defaultSources(), waste: true, merge: true, terms: true, fcTerms: false, zero: false, price: 'both' }; },

  // Header › Quantities: counts shown beside each entry when the menu opens.
  refreshMenuBadges() {
    const set = (id, n, cls, word) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.hidden = !n;
      b.className = 'q-badge ' + cls;
      b.textContent = n ? `${n} ${word}` : '';
    };
    try {
      const av = this.available();
      const any = Object.values(av).some(Boolean);
      const res = any ? this.compute(this._defaultOpts()) : null;
      set('q-badge-boq', res ? res.missing.length : 0, 'amb', 'no rate');
    } catch (e) { set('q-badge-boq', 0, 'amb', ''); }
    try {
      const rows = [...((CableSchedules.reticRows() || {}).rows || []), ...((CableSchedules.buildingRows() || {}).rows || [])];
      const n = rows.filter(r => r.status && r.status.kind === 'bad').length;
      set('q-badge-cables', n, 'bad', n === 1 ? 'problem' : 'problems');
    } catch (e) { set('q-badge-cables', 0, 'bad', ''); }
  },

  // ── Dialog ─────────────────────────────────────────────────────────
  open() {
    this.opts = this._defaultOpts();
    this._ensureDom();
    this.render();
    document.getElementById('boq-modal').style.display = 'flex';
  },
  close() { const m = document.getElementById('boq-modal'); if (m) m.style.display = 'none'; },

  _ensureDom() {
    if (document.getElementById('boq-modal')) return;
    const I = (p, s = 16) => Rates._icon(p, s);
    const I_BOQ = I('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>', 18);
    const I_RATE = I('<path d="M8 2v12M11 4.5c0-1.2-1.3-2-3-2s-3 .8-3 2 1.3 1.8 3 2.2 3 1 3 2.3-1.3 2-3 2-3-.8-3-2"/>', 14);
    const I_DOWN = I('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"/>', 14);
    const m = document.createElement('div');
    m.id = 'boq-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'boq-title');
    m.style.display = 'none';
    m.innerHTML = `
    <div class="modal-content rt-dialog bq-dialog">
      <header class="rt-head">
        <span class="rt-mark bq-mark">${I_BOQ}</span>
        <div class="rt-head-text"><h3 id="boq-title">Bill of quantities</h3><div class="rt-head-sub" id="bq-sub"></div></div>
        <span class="rt-tag" id="bq-tag"></span>
        <button class="modal-close" data-bq="close" aria-label="Close">&times;</button>
      </header>
      <div class="bq-body">
        <aside class="bq-side" aria-label="What to include" id="bq-side"></aside>
        <main class="rt-main bq-main" id="bq-main"></main>
      </div>
      <footer class="rt-foot">
        <button type="button" class="rt-btn" data-bq="rates">${I_RATE}Rates…</button>
        <span class="rt-note-i">Quantities update from the project each time this opens</span>
        <span class="rt-grow"></span>
        <button type="button" class="rt-btn" data-bq="csv">${I_DOWN}CSV</button>
        <button type="button" class="rt-btn" data-bq="xlsx">${I_DOWN}Excel</button>
        <button type="button" class="rt-btn primary" data-bq="pdf">${I_DOWN}PDF report</button>
      </footer>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bq]');
      if (!b) { if (e.target === m) this.close(); return; }
      const a = b.dataset.bq;
      if (a === 'close') this.close();
      else if (a === 'rates') Rates.open({ onDone: () => this.render() });
      else if (a === 'set-rates') {
        const first = (this._last && this._last.missing[0]) || null;
        Rates.open({ tab: first ? first.cat : undefined, filter: 'norate', onDone: () => this.render() });
      }
      else if (a === 'csv') this.exportFile('csv');
      else if (a === 'xlsx') this.exportFile('xlsx');
      else if (a === 'pdf') this.exportPDF();
    });
    m.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.src) this.opts.sources[t.dataset.src] = t.checked;
      else if (t.dataset.price) this.opts.price = t.value;
      else if (t.dataset.opt) this.opts[t.dataset.opt] = t.checked;
      else return;
      this.render();
    });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
  },

  render() {
    const m = document.getElementById('boq-modal');
    if (!m) return;
    const av = this.available();
    const o = this.opts;
    const res = this._last = this.compute(o);
    const typeLabel = { retic: 'Reticulation project', building: 'Building project' }[AppState.projectType] || 'Project';
    m.querySelector('#bq-sub').textContent = `${typeLabel} · ${AppState.projectName || 'Untitled'}`;
    const L = AppState.rateLibrary;
    const d = L && L.updatedAt ? new Date(L.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    m.querySelector('#bq-tag').textContent = d ? `Rates: project library, ${d}` : 'Rates: none entered yet';

    const chk = (attr, id, on, title, hint, dis) => `<label class="rt-chk bq-chk${dis ? ' dis' : ''}"><input type="checkbox" ${attr}="${id}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><span>${title}<small>${hint}</small></span></label>`;
    m.querySelector('#bq-side').innerHTML = `
      <div class="bq-sh">Include quantities from</div>
      ${this.SOURCES.map(s => chk('data-src', s.id, o.sources[s.id] && av[s.id], escHtml(s.label), av[s.id] ? escHtml(s.hint) : 'Nothing in this project yet', !av[s.id])).join('')}
      <div class="bq-sh" style="margin-top:6px">Price</div>
      <div class="bq-price" role="radiogroup" aria-label="Price">${this.PRICE.map(p => `<label class="bq-pr${(o.price || 'both') === p.id ? ' on' : ''}"><input type="radio" name="bq-price" data-price="1" value="${p.id}" ${(o.price || 'both') === p.id ? 'checked' : ''}><span>${p.label}</span></label>`).join('')}</div>
      <div class="bq-sh" style="margin-top:6px">Options</div>
      ${chk('data-opt', 'waste', o.waste !== false, 'Add waste to material', 'Material bought = qty × (1 + waste). Labour is on the measured qty', o.price === 'install')}
      ${chk('data-opt', 'merge', o.merge !== false, 'Merge the same item from different sources', 'One line per item; its sources listed on it', false)}
      ${chk('data-opt', 'terms', o.terms !== false, 'Count terminations per cable size and type', 'Two ends per run, times parallel runs', false)}
      ${chk('data-opt', 'fcTerms', !!o.fcTerms, 'Include final-circuit terminations', 'DB ways are usually priced per point', o.terms === false)}
      ${chk('data-opt', 'zero', !!o.zero, 'Show items with zero quantity', 'e.g. cables with no length yet', false)}
      <div class="rt-note bq-rule">One cable is counted once. Where a run is in a schedule <b>and</b> drawn on a plan, the Demand, DB schedule or single-line length is used and the drawn route is not counted again. Its terminations follow the same rule.</div>`;

    const money = v => Rates.money(v);
    const num = v => Rates._group(v.toFixed(1).replace(/\.0$/, ''));
    const qtyTxt = l => l.unit === 'm' ? Rates._group(l.qty.toFixed(1)) : Rates._group(String(l.qty));
    const cols = this._cols(res.price);
    const miss = res.missing;
    const warnHtml = miss.length ? `<div class="rt-banner warn" role="status"><span><b>${miss.length} item${miss.length > 1 ? 's have' : ' has'} no rate</b> and ${miss.length > 1 ? 'are' : 'is'} left out of the total: ${miss.slice(0, 4).map(l => escHtml(l.desc)).join(', ')}${miss.length > 4 ? ` and ${miss.length - 4} more` : ''}.</span><span class="rt-grow"></span><button type="button" class="rt-lk" data-bq="set-rates">Set rates →</button></div>` : '';
    const issues = [...res.warnings.map(w => ({ w, t: 'warn' })), ...res.notes.map(w => ({ w, t: 'note' }))];
    const issuesHtml = issues.length ? `<details class="bq-issues"${res.warnings.length ? ' open' : ''}><summary>${res.warnings.length ? `${res.warnings.length} data issue${res.warnings.length > 1 ? 's' : ''}` : ''}${res.warnings.length && res.notes.length ? ' · ' : ''}${res.notes.length ? `${res.notes.length} note${res.notes.length > 1 ? 's' : ''} on how runs were counted` : ''}</summary><ul>${issues.map(i => `<li class="${i.t}">${escHtml(i.w)}</li>`).join('')}</ul></details>` : '';
    // Money cells for one line / one subtotal row, in the columns the Price option shows.
    const lineCells = (l) => {
      const out = [];
      // A percentage line: its base across the rate columns, one amount.
      if (l.pct) return `<td class="rt-num bq-base" colspan="${cols.length - 1}">of ${money(l.base)}</td><td class="rt-num">${money(l.amount)}</td>`;
      if (!l.priced) {
        for (const c of cols) out.push(c === 'mr' ? '<td class="rt-num"><span class="bq-norate">No rate</span></td>' : '<td class="rt-num">—</td>');
        return out.join('');
      }
      const wasteTip = l.waste && l.rate != null ? ` title="incl. ${l.waste} % waste (${num(l.bought)} ${escHtml(l.unit)} bought)"` : '';
      for (const c of cols) {
        if (c === 'mr') out.push(`<td class="rt-num">${l.rate == null ? '—' : money(l.rate)}</td>`);
        else if (c === 'lr') out.push(`<td class="rt-num">${l.labour == null ? '—' : money(l.labour)}</td>`);
        else if (c === 'ma') out.push(`<td class="rt-num"${wasteTip}>${l.matAmount == null ? '—' : money(l.matAmount)}</td>`);
        else if (c === 'la') out.push(`<td class="rt-num">${l.labAmount == null ? '—' : money(l.labAmount)}</td>`);
        else out.push(`<td class="rt-num">${money(l.amount)}</td>`);
      }
      return out.join('');
    };
    const onlyAmount = (v) => cols.map((c, i) => i === cols.length - 1 ? `<td class="rt-num">${money(v)}</td>` : '<td></td>').join('');
    const subCells = (x) => x.pct ? onlyAmount(x.subtotal) : cols.map(c => c === 'ma' ? `<td class="rt-num">${money(x.mat)}</td>` : c === 'la' ? `<td class="rt-num">${money(x.lab)}</td>`
      : c === 'am' ? `<td class="rt-num">${money(x.subtotal ?? x.total)}</td>` : '<td></td>').join('');
    const span = 4 + cols.length;          // code · description · from · qty · unit · money columns
    let body = '';
    const letters = 'ABCDEFG';
    res.sections.forEach((s, i) => {
      if (s.pct) body += `<tr class="bq-sub"><td></td><td colspan="4">Total before allowances</td>${subCells({ mat: res.mat, lab: res.lab, total: res.totalBefore })}</tr>`;
      body += `<tr class="bq-grp"><td colspan="${span + 1}">${letters[i]} · ${escHtml(s.label)}${s.pct ? ' <span class="rt-note-i">(each a percentage of the priced sections above, never of another allowance)</span>' : ''}</td></tr>`;
      for (const l of s.lines) {
        body += `<tr${l.priced ? '' : ' class="bq-miss"'}><td class="rt-code" title="${escHtml(l.key)}">${escHtml(l.key)}</td><td title="${escHtml(l.desc)}">${escHtml(l.desc)}</td><td>${l.from.map(f => `<span class="bq-src">${escHtml(f)}</span>`).join('')}</td>
          <td class="rt-num">${l.pct ? Rates._group(String(l.qty)) : qtyTxt(l)}</td><td>${escHtml(l.unit)}</td>${lineCells(l)}</tr>`;
      }
      body += `<tr class="bq-sub"><td></td><td colspan="4">${escHtml(s.label)} subtotal</td>${subCells(s)}</tr>`;
    });
    if (res.sections.length) body += `<tr class="bq-sub bq-total"><td></td><td colspan="4">Total excl. VAT</td>${subCells({ mat: res.mat, lab: res.lab, total: res.total })}</tr>`;
    const anySrc = Object.keys(o.sources).some(k => o.sources[k] && av[k]);
    const cur = Rates.currency();
    const head = { mr: 'Material rate', lr: 'Labour rate', ma: 'Material', la: 'Labour', am: 'Amount' };
    const share = res.total > 0 ? Math.round(res.lab / res.total * 100) : 0;
    const stat = (k, v) => `<div class="bq-stat"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    m.querySelector('#bq-main').innerHTML = `
      <div class="bq-sum">
        ${stat('Total excl. VAT', money(res.total))}
        ${res.price !== 'install' ? stat('Material', money(res.mat)) : ''}
        ${res.price !== 'supply' ? stat('Labour', `${money(res.lab)}${res.price === 'both' ? ` <small>${share} % of total</small>` : ''}`) : ''}
        ${stat('Cable, all types', `${Rates._group(Math.round(res.cableM).toString())} <small>m${o.waste !== false ? ' incl. waste' : ''}</small>`)}
        ${stat('Priced', `${res.nPriced} / ${res.nItems} <small>lines</small>`)}
      </div>
      ${warnHtml}${issuesHtml}
      <div class="rt-tablewrap">${res.sections.length ? `<table class="rt-tbl rt-ro-tbl bq-tbl"><thead><tr><th style="width:150px">Item code</th><th>Description</th><th style="width:${cols.length > 2 ? 130 : 200}px">From</th><th class="rt-num" style="width:64px">Qty</th><th style="width:38px">Unit</th>${cols.map(c => `<th class="rt-num" style="width:${c === 'am' ? 112 : c.endsWith('r') ? 100 : 104}px" title="${escHtml(cur)}">${head[c]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
        : `<div class="rt-empty">${anySrc ? 'Nothing to count yet in the selected sources.' : 'Tick at least one source on the left.'}</div>`}</div>`;
  },

  // Money columns the Price option shows: material rate, labour rate,
  // material amount, labour amount, amount.
  _cols(price) {
    if (price === 'supply') return ['mr', 'ma'];
    if (price === 'install') return ['lr', 'la'];
    return ['mr', 'lr', 'ma', 'la', 'am'];
  },

  // ── Export ─────────────────────────────────────────────────────────
  _aoa(res) {
    const cur = Rates.currency();
    const cols = this._cols(res.price);
    const mat = res.price !== 'install';
    const H = { mr: `Material rate (${cur})`, lr: `Labour rate (${cur})`, ma: `Material (${cur})`, la: `Labour (${cur})`, am: `Amount (${cur})` };
    // Material qty = what is bought (measured + waste); material = material qty × material rate.
    const rows = [['Item code', 'Section', 'Description', 'From', 'Qty', 'Unit', ...(mat ? ['Waste %', 'Material qty'] : []), ...cols.map(c => H[c]), 'Supplier code']];
    const pad = mat ? 8 : 6;
    const money = (l, c) => {
      if (!l.priced) return c === 'mr' ? 'No rate' : '';
      const v = { mr: l.rate, lr: l.labour, ma: l.matAmount, la: l.labAmount, am: l.amount }[c];
      return v == null ? '' : v;
    };
    const tot = (x, c) => c === 'ma' ? +x.mat.toFixed(2) : c === 'la' ? +x.lab.toFixed(2) : c === 'am' ? +x.total.toFixed(2) : '';
    // Percentage line: the base in the first money column, the result in the last.
    const pctRow = (l) => cols.map((c, i) => i === 0 ? +l.base.toFixed(2) : i === cols.length - 1 ? l.amount : '');
    const last = (v) => cols.map((c, i) => i === cols.length - 1 ? +v.toFixed(2) : '');
    for (const s of res.sections) {
      if (s.pct) rows.push(['', 'Total before allowances', ...Array(pad - 2).fill(''), ...cols.map(c => tot({ mat: res.mat, lab: res.lab, total: res.totalBefore }, c)), '']);
      for (const l of s.lines) {
        if (l.pct) rows.push([l.key, s.label, l.desc, l.from.join('; '), l.qty, '%', ...(mat ? ['', ''] : []), ...pctRow(l), '']);
        else rows.push([l.key, s.label, l.desc, l.from.join('; '), l.qty, l.unit, ...(mat ? [l.waste, l.bought] : []), ...cols.map(c => money(l, c)), l.supplier || '']);
      }
      rows.push(['', s.label + ' subtotal', ...Array(pad - 2).fill(''), ...(s.pct ? last(s.subtotal) : cols.map(c => tot({ mat: s.mat, lab: s.lab, total: s.subtotal }, c))), '']);
    }
    rows.push([], ['', 'Total excl. VAT', ...Array(pad - 2).fill(''), ...cols.map(c => tot(res, c)), '']);
    if (res.missing.length) rows.push(['', `${res.missing.length} item(s) have no rate and are not in the total`]);
    return rows;
  },
  _fname(ext) {
    const base = (AppState.projectName || 'project').replace(/[^\w-]+/g, '_');
    return `${base}_bill_of_quantities.${ext}`;
  },
  exportFile(kind) {
    const res = this._last || this.compute();
    const rows = this._aoa(res);
    if (kind === 'csv') {
      const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url; a.download = this._fname('csv');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      if (typeof XLSX === 'undefined') { UI.toast('The Excel library did not load. Export CSV instead.', 'error'); return; }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = rows[0].map((h, i) => ({ wch: [22, 26, 44, 34, 10, 6][i] || (/^Supplier/.test(h) ? 16 : 14) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Bill of quantities');
      XLSX.writeFile(wb, this._fname('xlsx'));
    }
  },
  async exportPDF() {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const res = this._last || this.compute();
    const { jsPDF } = window.jspdf;
    // Landscape: two rates and two amounts need the width.
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), Hp = doc.internal.pageSize.getHeight();
    const margin = 14, tw = W - 2 * margin;
    const cur = Rates.currency();
    const cols = this._cols(res.price);
    const priceLbl = (this.PRICE.find(p => p.id === res.price) || this.PRICE[0]).label;
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('Bill of quantities', margin, margin + 4);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${AppState.projectName || 'Untitled Project'}    Date: ${new Date().toLocaleDateString()}    Priced: ${priceLbl}`, margin, margin + 11);
    const srcs = this.SOURCES.filter(s => this.opts && this.opts.sources[s.id]).map(s => s.label).join(', ');
    const wasteTxt = res.price === 'install' ? '' : this.opts && this.opts.waste === false ? 'No waste allowance.' : 'Quantities are measured; material includes each item’s waste allowance, labour does not.';
    doc.text(doc.splitTextToSize(`Quantities from: ${srcs || '—'}.  ${wasteTxt}`, tw), margin, margin + 16);
    doc.setFont('helvetica', 'bold');
    const split = [res.price !== 'install' ? `Material ${Rates.money(res.mat)}` : '', res.price !== 'supply' ? `Labour ${Rates.money(res.lab)}` : ''].filter(Boolean).join('    ');
    doc.text(`Total excl. VAT: ${Rates.money(res.total)}    ${res.price === 'both' ? split + '    ' : ''}${res.allow ? `Allowances ${Rates.money(res.allow)}    ` : ''}${res.nPriced} of ${res.nItems} lines priced`, margin, margin + 26);
    doc.setFont('helvetica', 'normal');
    const H = { mr: `Material rate (${cur})`, lr: `Labour rate (${cur})`, ma: `Material (${cur})`, la: `Labour (${cur})`, am: `Amount (${cur})` };
    const cell = (l, c) => {
      if (!l.priced) return c === 'mr' ? 'No rate' : '—';
      const v = { mr: l.rate, lr: l.labour, ma: l.matAmount, la: l.labAmount, am: l.amount }[c];
      return v == null ? '—' : Rates.num2(v);
    };
    const tot = (x, c) => ({ content: c === 'ma' ? Rates.num2(x.mat) : c === 'la' ? Rates.num2(x.lab) : c === 'am' ? Rates.num2(x.total) : '', styles: { fontStyle: 'bold' } });
    const n = 4 + cols.length;
    const body = [];
    const lastOnly = (v) => cols.map((c, i) => ({ content: i === cols.length - 1 ? Rates.num2(v) : '', styles: { fontStyle: 'bold' } }));
    const subRow = (label, cells) => body.push([{ content: label, colSpan: 4, styles: { fontStyle: 'bold', halign: 'right' } }, ...cells]);
    res.sections.forEach((s, i) => {
      if (s.pct) subRow('Total before allowances', cols.map(c => tot({ mat: res.mat, lab: res.lab, total: res.totalBefore }, c)));
      body.push([{ content: `${'ABCDEFG'[i]} · ${s.label}${s.pct ? ' (percentages of the priced sections above)' : ''}`, colSpan: n, styles: { fontStyle: 'bold', fillColor: [232, 238, 246] } }]);
      for (const l of s.lines) {
        if (l.pct) body.push([l.key, `${l.desc} — ${l.from[0]}`, String(l.qty), '%', ...(cols.length > 1 ? [{ content: `of ${Rates.num2(l.base)}`, colSpan: cols.length - 1, styles: { halign: 'right' } }] : []), Rates.num2(l.amount)]);
        else body.push([l.key, l.desc, l.unit === 'm' ? l.qty.toFixed(1) : String(l.qty), l.unit, ...cols.map(c => cell(l, c))]);
      }
      subRow(`${s.label} subtotal`, s.pct ? lastOnly(s.subtotal) : cols.map(c => tot({ mat: s.mat, lab: s.lab, total: s.subtotal }, c)));
    });
    body.push([{ content: 'Total excl. VAT', colSpan: 4, styles: { fontStyle: 'bold', halign: 'right' } }, ...cols.map(c => tot(res, c))]);
    const columnStyles = { 0: { cellWidth: 40 }, 2: { halign: 'right', cellWidth: 18 }, 3: { cellWidth: 10 } };
    cols.forEach((c, i) => { columnStyles[4 + i] = { halign: 'right', cellWidth: c.endsWith('r') ? 24 : 28 }; });
    const mrIdx = 4 + cols.indexOf('mr');
    doc.autoTable({
      startY: margin + 31,
      margin: { left: margin, right: margin, bottom: 14 },
      head: [['Item code', 'Description', 'Qty', 'Unit', ...cols.map(c => H[c])]],
      body,
      styles: { fontSize: 7.5, cellPadding: 1.4 },
      headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
      columnStyles,
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === mrIdx && d.cell.raw === 'No rate') d.cell.styles.textColor = [200, 100, 0]; },
    });
    let y = doc.lastAutoTable.finalY + 6;
    const notes = [];
    if (res.missing.length) notes.push(`${res.missing.length} item(s) have no rate and are not included in the total: ${res.missing.map(l => l.desc).join(', ')}.`);
    notes.push(...res.warnings, ...res.notes);
    if (notes.length) {
      doc.setFontSize(8.5);
      for (const t of notes) {
        const lines = doc.splitTextToSize('• ' + t, tw);
        if (y + lines.length * 4 > Hp - 12) { doc.addPage(); y = margin; }
        doc.text(lines, margin, y);
        y += lines.length * 4 + 1;
      }
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`ProtectionPro · Bill of quantities · page ${i} of ${pages}`, margin, Hp - 5);
      doc.setTextColor(0);
    }
    const safe = (AppState.projectName || 'project').replace(/[^\w-]+/g, '_');
    doc.save(`${safe}_bill_of_quantities.pdf`);
  },
};
