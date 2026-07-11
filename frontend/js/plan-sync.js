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

  _elById() {
    const m = {};
    for (const e of AppState.planMarkup.elements) m[e.id] = e;
    return m;
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

  // Immediate rename propagation from a plan element to its schedule row.
  onElementRenamed(el, oldName, newName) {
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
