/* ProtectionPro — Generate SLD from Schedule.
 *
 * Synthesizes real SLD components for a distribution board's circuit
 * schedule (comp.props.circuits) onto the main canvas: one shared outgoing
 * bus below the board (reusing PlanSync._ensureOutBus — the same bus a
 * Plan-Markup "Feeder to Sub-board" way already hangs off), then one CB +
 * one feeder cable per way, wired bus -> CB -> cable. A way's cable end is
 * left unterminated (an SLD load per final circuit isn't modelled) — the
 * board's own lumped demand (DBSchedule.recompute()) already carries the
 * aggregate load the load-flow/fault engines read.
 *
 * Idempotent: re-running after schedule edits updates the existing CB/cable
 * for a way in place (matched by the way's stable id) rather than
 * duplicating them, and removes the pair for any way that no longer exists
 * or has become a "Feeder to Sub-board" way (which PlanSync already
 * SLD-izes via its own cable, independent of this generator).
 */

const SLDGen = {
  STEP_X: 70,
  CB_Y_OFFSET: 60,
  CABLE_Y_OFFSET: 70,

  _findGen(type, boardId, wayId) {
    for (const c of AppState.components.values()) {
      if (c.type === type && c.genBoardId === boardId && c.genWayId === wayId) return c;
    }
    return null;
  },

  generateForBoard(boardId) {
    const dbComp = AppState.components.get(boardId);
    if (!dbComp || dbComp.type !== 'distribution_board') {
      if (typeof UI !== 'undefined') UI.alert('Select a distribution board first.');
      return;
    }
    const circuits = Array.isArray(dbComp.props.circuits) ? dbComp.props.circuits : [];
    // "Feeder to Sub-board" ways already get a real cable+board from
    // PlanSync — skip them so the two mechanisms never fight over one way.
    const ways = circuits.filter(w => w.type !== 'feeder_db');

    const bus = PlanSync._ensureOutBus(dbComp);
    bus.props.voltage_kv = 0.4;
    const n = ways.length;
    const needed = n * this.STEP_X + 40;
    if (!bus.props.busWidth || bus.props.busWidth < needed) bus.props.busWidth = needed;

    let created = 0, updated = 0;
    const seenWayIds = new Set(ways.map(w => w.id));
    const startX = bus.x - ((n - 1) * this.STEP_X) / 2;

    ways.forEach((way, i) => {
      const x = startX + i * this.STEP_X;
      const atX = Math.round(x - bus.x);

      let cb = this._findGen('cb', dbComp.id, way.id);
      const wasNew = !cb;
      if (!cb) {
        cb = AppState.addComponent('cb', x, bus.y + this.CB_Y_OFFSET);
        cb.genBoardId = dbComp.id; cb.genWayId = way.id;
        AppState.addWire(bus.id, `at_${atX}`, cb.id, 'top', true);
      }
      cb.x = x; cb.y = bus.y + this.CB_Y_OFFSET;
      cb.props.name = way.description || ('Way ' + way.way);
      cb.props.rated_voltage_kv = 0.4;
      cb.props.cb_type = 'mcb';
      cb.props.mcb_curve = ['B', 'C', 'D'].includes(way.curve) ? way.curve : 'C';
      cb.props.rated_current_a = Number(way.breaker_a) || 20;
      cb.props.trip_rating_a = Number(way.breaker_a) || 20;

      let cable = this._findGen('cable', dbComp.id, way.id);
      if (!cable) {
        cable = AppState.addComponent('cable', x, bus.y + this.CB_Y_OFFSET + this.CABLE_Y_OFFSET);
        cable.genBoardId = dbComp.id; cable.genWayId = way.id;
        AppState.addWire(cb.id, 'bottom', cable.id, 'from', true);
      }
      cable.x = x; cable.y = bus.y + this.CB_Y_OFFSET + this.CABLE_Y_OFFSET;
      cable.props.name = (way.cable_mm2 ? way.cable_mm2 + ' mm² — ' : '') + (way.description || ('Way ' + way.way));
      cable.props.voltage_kv = 0.4;
      cable.props.length_km = (Number(way.cable_m) || 0) / 1000;
      // Building-wiring cables (the DB schedule's own cable_mm2/construction)
      // aren't SLD-eligible library entries (no r0/x0 of their own) — only
      // borrow a standard ampacity figure, and leave r_per_km/x_per_km at
      // the cable component's own default. A precise fault/volt-drop result
      // on this branch needs a proper SLD-eligible cable picked by hand.
      const amp = (typeof DBSchedule !== 'undefined' && DBSchedule._cableAmpacityA)
        ? DBSchedule._cableAmpacityA(way.cable_mm2) : null;
      if (amp) cable.props.rated_amps = amp;

      if (wasNew) created++; else updated++;
    });

    // Drop a generated CB/cable pair whose way no longer exists on this
    // board, or has become a "Feeder to Sub-board" way (PlanSync's own).
    let removed = 0;
    for (const c of [...AppState.components.values()]) {
      if (c.genBoardId !== dbComp.id) continue;
      if ((c.type === 'cb' || c.type === 'cable') && !seenWayIds.has(c.genWayId)) {
        AppState.removeComponent(c.id);
        removed++;
      }
    }

    AppState.dirty = true;
    if (typeof UndoManager !== 'undefined' && UndoManager.snapshot) UndoManager.snapshot();
    if (typeof Canvas !== 'undefined') Canvas.render();
    if (typeof UI !== 'undefined') UI.alert(
      `Generated SLD for ${dbComp.props.name || 'board'}: ${created} new way(s), ${updated} updated, ${removed} removed (no longer on the schedule).`);
  },
};
