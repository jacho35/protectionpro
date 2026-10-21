/**
 * Cascading — back-up protection (IEC 60947-2 Annex A, IEC 60364-5-53 §536.4.2).
 *
 * A breaker whose own breaking capacity is below the fault current where it is
 * installed is still acceptable when a breaker upstream of it, tested in
 * combination with it, gives a reinforced breaking capacity that covers the
 * fault. The figure comes only from the manufacturer's table (CASCADE_TABLES,
 * vendor-cascading.js, generated) — never computed. Mirrors
 * backend/analysis/cascading.py, which the duty check uses; this one serves the
 * DB schedule coordination check (DbCoord) and the compliance checks.
 *
 * The rule, as the guide states it for three breakers A > B > C in series: C is
 * covered when A + C reaches the fault at C, or when B + C does and B is itself
 * adequate (its own capacity, or covered by A).
 */
const Cascading = {
  SOURCE_TYPES: new Set(['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery']),
  // the supply-path walk passes through these (same voltage); a transformer ends it
  PASS_THROUGH: new Set(['bus', 'distribution_board', 'cable', 'switch', 'fuse', 'ct', 'pt',
    'surge_arrester', 'bus_duct', 'offpage_connector']),

  // The project setting: absent / true = allowed, false = own capacity only.
  enabled() { return typeof AppState === 'undefined' || AppState.cascading !== false; },

  // The tables' Ue: 380-415 V three-phase, or its 220-240 V Ph/N circuits.
  appliesAt(kv) {
    kv = Number(kv) || 0;
    return (kv >= 0.38 - 1e-9 && kv <= 0.415 + 1e-9) || (kv >= 0.22 - 1e-9 && kv <= 0.24 + 1e-9);
  },

  // {maker, model, rating_a} of a library breaker entry, else null.
  refOfEntry(e) {
    if (!e || !e.manufacturer || !e.model) return null;
    return { maker: e.manufacturer, model: e.model, rating_a: Number(e.trip_rating_a) || 0 };
  },
  // … of a diagram breaker (its `standard_type` library id).
  refOfProps(p) {
    if (!p || !p.standard_type || typeof STANDARD_CBS === 'undefined') return null;
    return this.refOfEntry(STANDARD_CBS.find(c => c.id === p.standard_type));
  },

  _in(r, band) { return !band || (r >= band[0] - 1e-9 && r <= band[1] + 1e-9); },

  // Reinforced breaking capacity (kA) of `down` behind `up`, or null when the
  // pair is not a tested combination.
  reinforcedKa(up, down) {
    if (!up || !down || up.maker !== down.maker || typeof CASCADE_TABLES === 'undefined') return null;
    for (const doc of CASCADE_TABLES) {
      if (doc.manufacturer !== up.maker) continue;
      for (const t of doc.tables) {
        const cols = t.upstream.map((u, k) => (u.model === up.model && this._in(up.rating_a, u.rating_a)) ? k : -1)
          .filter(k => k >= 0);
        if (!cols.length) continue;
        for (const r of t.rows) {
          if (r.model !== down.model || !this._in(down.rating_a, r.rating_a)) continue;
          const vals = cols.map(k => r.values[k]).filter(v => v);
          if (vals.length) return Math.max(...vals);
        }
      }
    }
    return null;
  },

  sourceNote() {
    const d = typeof CASCADE_TABLES !== 'undefined' ? CASCADE_TABLES[0] : null;
    return d ? `${d.manufacturer} cascading table, ${d.standard}` : 'manufacturer cascading table';
  },

  // chain: nearest first, [{ref, capacityKa, dutyKa}] — chain[0] is the breaker
  // checked. → {by: index, reinforcedKa} for the nearest breaker that covers
  // it, or null.
  cover(chain) {
    const memo = new Map();
    const adequate = (i) => {
      if (memo.has(i)) return memo.get(i);
      memo.set(i, false);
      const c = chain[i];
      const ok = (c.capacityKa || 0) >= (c.dutyKa || 0) - 1e-9 || covered(i) != null;
      memo.set(i, ok);
      return ok;
    };
    const covered = (i) => {
      const duty = chain[i].dutyKa || 0;
      for (let j = i + 1; j < chain.length; j++) {
        const ka = this.reinforcedKa(chain[j].ref, chain[i].ref);
        if (ka != null && ka >= duty - 1e-9 && adequate(j)) return { by: j, reinforcedKa: ka };
      }
      return null;
    };
    return covered(0);
  },

  // ─── Diagram: series breakers above a breaker, nearest first ───
  // adj: Map id → [neighbour ids]; comp(id) → component. Stops at a
  // transformer or source, and — without the breaker it reached — where the
  // fault is fed from more than one side (cascading.py supply_chain).
  _isOpen(c) {
    return (c.type === 'cb' || c.type === 'switch') && String((c.props || {}).state || 'closed').toLowerCase() === 'open';
  },
  _reachesSource(start, blocked, adj, comp) {
    const seen = new Set([...blocked, start]);
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      const c = comp(id);
      if (!c) continue;
      if (this.SOURCE_TYPES.has(c.type)) return true;
      if (this._isOpen(c)) continue;
      for (const nb of adj.get(id) || []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    return false;
  },
  supplyChain(deviceId, adj, comp) {
    const chain = [];
    let cur = deviceId;
    const seen = new Set([deviceId]);
    for (;;) {
      const sides = (adj.get(cur) || []).filter(nb => !seen.has(nb)
        && this._reachesSource(nb, new Set([...seen, cur]), adj, comp));
      if (sides.length !== 1) break;
      const region = new Set(), found = [], edge = [], stack = [sides[0]];
      while (stack.length) {
        const id = stack.pop();
        if (region.has(id) || seen.has(id) || found.includes(id) || edge.includes(id)) continue;
        const c = comp(id);
        if (!c) continue;
        if (c.type === 'cb') { if (!this._isOpen(c)) found.push(id); continue; }
        if (!this.PASS_THROUGH.has(c.type)) { edge.push(id); continue; }
        region.add(id);
        if (this._isOpen(c)) continue;
        for (const nb of adj.get(id) || []) stack.push(nb);
      }
      const blocked = new Set([...seen, ...region, cur]);
      const ups = found.filter(b => this._reachesSource(b, blocked, adj, comp));
      const direct = edge.some(e => this.SOURCE_TYPES.has(comp(e).type) || this._reachesSource(e, blocked, adj, comp));
      if (ups.length + (direct ? 1 : 0) > 1 || !ups.length) break;
      chain.push(ups[0]);
      for (const x of region) seen.add(x);
      seen.add(cur);
      cur = ups[0];
    }
    return chain;
  },
};
