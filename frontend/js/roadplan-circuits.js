/* ProtectionPro — Road plan › Street-lighting circuits and cables.
 *
 * Turns the poles of the Road plan into street-lighting circuits with their
 * cable runs. The pure planner (RoadCircuits.plan, node-testable —
 * testing/unit/roadcircuits.test.js) works on plain data:
 *
 *   road { id, name, poles [{ id, x, y, ph }] in chainage order,
 *          feed { x, y, route [[x, y]] } | null, parents [{ main, end }] }
 *
 * - A road with a feed point (a kiosk / minisub placed on the plan, plus the
 *   drawn feeder route to a pole of the road: the one chosen, else the nearer
 *   end) roots a circuit; the string runs both ways from that pole. The first
 *   pole's span is the feeder: the drawn route length + an allowance, or the
 *   straight line + a larger one when no route is drawn.
 * - A side road (a T junction onto a road of the same circuit) is a spur only
 *   by pole-to-pole connection: its first pole (the end at the junction) is
 *   fed from the NEAREST POLE of the parent road, within `linkMaxM`. There is
 *   never a tee in a cable run; the span is the real distance between the
 *   two poles. No pole in reach → the road is skipped, with the reason.
 * - Every other span is the distance between consecutive poles of the road.
 *
 * The browser half (RoadPlan.openCircuitImport / applyCircuits / the Feed
 * point tool) writes the plan into StreetLight circuits. A circuit carries
 * `roadKey` (its root road) and each pole `roadPoleId`, so importing again
 * updates in place and keeps luminaire, phase and name edits and poles added
 * by hand.
 */

const RoadCircuits = {
  LINK_MAX_M: 60,
  ROUTE_ALLOW_PCT: 5,
  STRAIGHT_ALLOW_PCT: 15,

  _d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); },
  _r2(v) { return Math.round(v * 100) / 100; },

  // Feeder from the source to a road's first pole.
  feeder(feed, first, o) {
    const pts = [{ x: feed.x, y: feed.y }].concat((feed.route || []).map(q => ({ x: q[0], y: q[1] })), [{ x: first.x, y: first.y }]);
    let routeM = 0;
    for (let i = 1; i < pts.length; i++) routeM += this._d(pts[i - 1], pts[i]);
    const drawn = (feed.route || []).length > 0;
    const pct = drawn ? o.routeAllowPct : o.straightAllowPct;
    const allowM = routeM * pct / 100;
    return { mode: drawn ? 'route' : 'straight', routeM: this._r2(routeM), allowPct: pct, allowM: this._r2(allowM), lenM: this._r2(routeM + allowM) };
  },

  // roads → { circuits: [{ rootId, roadIds, poles, feeder }], skipped: [{ roadId, reason }] }
  // poles: { rid, roadId, x, y, ph, parent (rid | null), spanM, link (true on a spur's first pole) }
  plan(roads, opts) {
    const o = Object.assign({ linkMaxM: this.LINK_MAX_M, routeAllowPct: this.ROUTE_ALLOW_PCT, straightAllowPct: this.STRAIGHT_ALLOW_PCT }, opts);
    const usable = roads.filter(r => r.poles && r.poles.length);
    const placed = new Set(), why = new Map(), circuits = [];
    for (const root of usable) {
      if (!root.feed) continue;
      const entry = this._entry(root);
      const c = { rootId: root.id, roadIds: [root.id], poles: [], feeder: this.feeder(root.feed, root.poles[entry], o) };
      const rp = root.poles[entry];
      c.poles.push({ rid: rp.id, roadId: root.id, x: rp.x, y: rp.y, ph: rp.ph, parent: null, spanM: c.feeder.lenM, link: false });
      // Both ways from the pole the feeder reaches (a road end: one way only).
      for (const dir of [1, -1]) {
        let prev = rp;
        for (let i = entry + dir; i >= 0 && i < root.poles.length; i += dir) {
          const p = root.poles[i];
          c.poles.push({ rid: p.id, roadId: root.id, x: p.x, y: p.y, ph: p.ph, parent: prev.id, spanM: this._r2(this._d(prev, p)), link: false });
          prev = p;
        }
      }
      placed.add(root.id);
      const members = new Set([root.id]);
      for (let moved = true; moved;) {
        moved = false;
        for (const r of usable) {
          if (placed.has(r.id) || r.feed) continue;
          for (const pr of r.parents || []) {
            if (!members.has(pr.main)) continue;
            const seq = pr.end === 'start' ? r.poles.slice() : r.poles.slice().reverse();
            let best = null, bd = Infinity;
            for (const q of c.poles) if (q.roadId === pr.main) { const d = this._d(q, seq[0]); if (d < bd) { bd = d; best = q; } }
            const mainName = (roads.find(x => x.id === pr.main) || {}).name || 'the road';
            if (!best || bd > o.linkMaxM) { why.set(r.id, `no pole of ${mainName} within ${o.linkMaxM} m of its first pole${best ? ` (nearest ${bd.toFixed(0)} m)` : ''}: add one near the junction`); continue; }
            let prev = null;
            seq.forEach((p, i) => {
              c.poles.push({ rid: p.id, roadId: r.id, x: p.x, y: p.y, ph: p.ph, parent: i === 0 ? best.rid : prev.id, spanM: this._r2(i === 0 ? bd : this._d(prev, p)), link: i === 0 });
              prev = p;
            });
            placed.add(r.id); members.add(r.id); c.roadIds.push(r.id); why.delete(r.id);
            moved = true;
            break;
          }
        }
      }
      circuits.push(c);
    }
    const skipped = [];
    for (const r of roads) {
      if (placed.has(r.id)) continue;
      skipped.push({ roadId: r.id, reason: !r.poles || !r.poles.length ? 'no poles yet' : why.get(r.id)
        || ((r.parents || []).length ? 'the road it joins has no feed point' : 'no feed point, and it does not join a road that has one') });
    }
    return { circuits, skipped };
  },
  // Index of the pole the feeder reaches: the chosen pole, else the nearer end.
  _entry(road) {
    const i = road.feed.poleId ? road.poles.findIndex(p => p.id === road.feed.poleId) : -1;
    if (i >= 0) return i;
    return this._nearEnd(road.poles, road.feed).reverse ? road.poles.length - 1 : 0;
  },
  // Which end of a road's pole list is nearer a point.
  _nearEnd(poles, pt) {
    const a = this._d(poles[0], pt), b = this._d(poles[poles.length - 1], pt);
    return { reverse: poles.length > 1 && b < a };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = RoadCircuits;

// ─── Browser half ───────────────────────────────────────────────────────
if (typeof RoadPlan !== 'undefined') Object.assign(RoadPlan, {
  // Plain-data roads for the planner, from the plan geometry.
  _circuitInput() {
    const juncs = this.junctions();
    return this.roads.map(r => {
      const names = this._poleNames(r);
      const poles = (r.poles || []).slice().sort((a, b) => a.s - b.s).map(p => {
        const g = this.poleGeom(r, p);
        if (!g) return null;
        const ph = RoadLight.library[g.photometryId];
        return { id: p.id, name: names.get(p.id), x: g.bx, y: g.by, ph: ph && Number(ph.watts) > 0 ? g.photometryId : null };
      }).filter(Boolean);
      const f = r.feed;
      const feed = f && this._feedSourceOk(f.source) ? { x: f.x, y: f.y, route: f.route || [], poleId: f.poleId || null } : null;
      const parents = juncs.filter(j => j.side === r.id && j.kind === 'T').map(j => ({ main: j.main, end: j.key.split(':')[2] }));
      return { id: r.id, name: r.name, poles, feed, parents };
    });
  },
  _feedSourceOk(src) { return !!src && StreetLight._sources().some(s => s.kind === src.kind && s.id === src.id); },
  _circuitPlan(ids, opts) {
    const all = this._circuitInput();
    const sel = ids ? all.filter(r => ids.has(r.id)) : all;
    return RoadCircuits.plan(sel, opts);
  },
  _circuitOpts() {
    const s = this.rp.settings;
    return { routeAllowPct: this._num(s.feederRoutePct, RoadCircuits.ROUTE_ALLOW_PCT), straightAllowPct: this._num(s.feederStraightPct, RoadCircuits.STRAIGHT_ALLOW_PCT), linkMaxM: this._num(s.linkMaxM, RoadCircuits.LINK_MAX_M) };
  },
  _circuitFor(rootId) { return StreetLight.circuits.find(c => c.roadKey === rootId) || null; },

  // ─── Feed point tool ─────────────────────────────────────────────────
  _feedSrcPick(r) {
    if (r && r.feed && this._feedSourceOk(r.feed.source)) return r.feed.source;
    if (this._feedSrc && this._feedSourceOk(this._feedSrc)) return this._feedSrc;
    const s = StreetLight._sources()[0];
    return s ? { kind: s.kind, id: s.id } : null;
  },
  _feedDown(wx, wy) {
    const r = this.selRoad;
    if (!r) { UI.toast('Select a road first.', 'info', 2500); return; }
    const p = this._snapPt(wx, wy);
    // A click on a pole of this road ends the feeder there: the string is fed at that pole.
    const hit = this._feedDraft ? this._hitPole(wx, wy) : null;
    if (hit && hit.road.id === r.id) { this._feedDraft.poleId = hit.pole.id; this._feedFinish(); return; }
    if (!this._feedDraft) {
      if (!this._feedSrcPick(r)) { UI.alert('There is no kiosk or minisub yet. Add one in Demand, then place its feed point here.'); return; }
      this._feedDraft = { x: p[0], y: p[1], route: [] };
    } else {
      const last = this._feedDraft.route[this._feedDraft.route.length - 1] || [this._feedDraft.x, this._feedDraft.y];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) this._feedDraft.route.push([+p[0].toFixed(3), +p[1].toFixed(3)]);
    }
    this._hint(); this.renderScreen();
  },
  _feedFinish() {
    const r = this.selRoad, d = this._feedDraft;
    this._feedDraft = null;
    if (!r || !d) { this.renderScreen(); return; }
    const src = this._feedSrcPick(r);
    r.feed = { source: src, x: +d.x.toFixed(3), y: +d.y.toFixed(3), route: d.route };
    if (d.poleId) r.feed.poleId = d.poleId;
    this._feedSrc = src;
    this.setTool('select');
    this._commit(); this.render();
  },
  _feedClear() {
    const r = this.selRoad;
    if (!r || !r.feed) return;
    delete r.feed;
    this._commit(); this.render();
  },
  _sourceLabel(src) { return src ? StreetLight._sourceName(src) : '—'; },

  // Panel block (poles step): where the supply enters.
  _panelFeed(r) {
    const srcs = StreetLight._sources();
    const cur = this._feedSrcPick(r);
    const sel = srcs.length
      ? `<label class="rp-field rp-span2">Fed from<select data-rp-feed="source">${srcs.map(s => `<option value="${escHtml(s.kind)}:${escHtml(s.id)}"${cur && cur.kind === s.kind && cur.id === s.id ? ' selected' : ''}>${escHtml(s.name)} (${s.kind})</option>`).join('')}</select></label>`
      : '<div class="sl-hint">No kiosk or minisub yet — add one in Demand.</div>';
    let line = '<div class="sl-hint">No feed point. Place the source and draw the feeder route to this road: a road with one starts a circuit; a side road joins the circuit of the road it leaves.</div>';
    if (r.feed) {
      const poles = this._circuitInput().find(x => x.id === r.id).poles;
      const f = poles.length ? RoadCircuits.feeder(r.feed, poles[RoadCircuits._entry({ poles, feed: r.feed })], this._circuitOpts()) : null;
      const names = this._poleNames(r);
      const sel2 = poles.length ? `<label class="rp-field rp-span2" title="The pole the feeder cable ends at. The string runs both ways from it.">Feeder connects to<select data-rp-feed="pole"><option value="">Nearest end of the road</option>${poles.map(p => `<option value="${escHtml(p.id)}"${r.feed.poleId === p.id ? ' selected' : ''}>${escHtml(names.get(p.id) || p.name)}</option>`).join('')}</select></label>` : '';
      line = sel2 + `<div class="rp-feedline"><b>${escHtml(this._sourceLabel(r.feed.source))}</b>${f ? ` · feeder ${f.mode === 'route' ? 'drawn' : 'straight line'} ${this._fmt(f.routeM, 1)} m + ${f.allowPct} % = <b>${this._fmt(f.lenM, 1)} m</b>` : ''}</div>`;
    }
    return `<div class="rp-block"><div class="rp-block-h"><b>Supply</b></div>${sel}${line}
      <div class="rp-actions"><button class="btn-small${this._tool === 'feed' ? ' active' : ''}" data-rp-tool="feed" title="Click the source's position, then click bends of the feeder cable; Enter or double-click to finish">${r.feed ? 'Move feed point' : 'Place feed point'}</button>${r.feed ? '<button class="btn-small" data-rp="feed-clear">Remove</button>' : ''}</div></div>`;
  },

  // Cable runs of the current plan on the plan (poles step).
  _drawCircuitCables(S, out) {
    if (this._cpKey !== this._last || !this._cp) {
      this._cp = this._circuitPlan(null, this._circuitOpts());
      this._cpKey = this._last;
    }
    const pt = (q) => S(q.x, q.y).map(t => t.toFixed(1));
    for (const c of this._cp.circuits) {
      const byRid = new Map(c.poles.map(p => [p.rid, p]));
      const root = this.road(c.rootId);
      for (const p of c.poles) {
        const par = p.parent ? byRid.get(p.parent) : null;
        if (!par) continue;
        const [x1, y1] = pt(par), [x2, y2] = pt(p);
        out.push(`<path d="M${x1} ${y1}L${x2} ${y2}" class="rp-cable${p.link ? ' link' : ''}"/>`);
        if (p.link) out.push(`<text x="${((+x1 + +x2) / 2 + 6).toFixed(1)}" y="${((+y1 + +y2) / 2).toFixed(1)}" class="rp-cable-t">link ${this._fmt(p.spanM, 1)} m</text>`);
      }
      if (root && root.feed) {
        const first = c.poles[0];
        const pts = [[root.feed.x, root.feed.y]].concat(root.feed.route || [], [[first.x, first.y]]);
        out.push(`<path d="M${pts.map(q => S(q[0], q[1]).map(t => t.toFixed(1)).join(' ')).join('L')}" class="rp-feeder"/>`);
        const [kx, ky] = S(root.feed.x, root.feed.y);
        out.push(`<rect x="${(kx - 7).toFixed(1)}" y="${(ky - 7).toFixed(1)}" width="14" height="14" class="rp-kiosk"/><text x="${(kx + 11).toFixed(1)}" y="${(ky + 4).toFixed(1)}" class="rp-cable-t">${escHtml(this._sourceLabel(root.feed.source))} · feeder ${this._fmt(c.feeder.lenM, 1)} m</text>`);
      }
    }
    const d = this._feedDraft;
    if (d) {
      const pts = [[d.x, d.y]].concat(d.route);
      if (this._hover) pts.push(this._snapPt(this._hover.wx, this._hover.wy));
      out.push(`<path d="M${pts.map(q => S(q[0], q[1]).map(t => t.toFixed(1)).join(' ')).join('L')}" class="rp-feeder draft"/>`);
      const [kx, ky] = S(d.x, d.y);
      out.push(`<rect x="${(kx - 7).toFixed(1)}" y="${(ky - 7).toFixed(1)}" width="14" height="14" class="rp-kiosk"/>`);
    }
  },

  // ─── Import dialog ───────────────────────────────────────────────────
  async openCircuitImport() {
    const input = this._circuitInput().filter(r => r.poles.length);
    if (!input.length) { UI.alert('The road plan has no poles yet.'); return; }
    if (!StreetLight._sources().length) { UI.alert('There is no kiosk or minisub yet. Add one in Demand, then place its feed point on the road.'); return; }
    const st = { sel: new Set(input.map(r => r.id)), system: StreetLight.defaults.system || '3ph', cable: null };
    st.cable = StreetLight._defaultCable(st.system);
    const m = RoadLight._modal('rp-circuits-modal', 'Import circuits from the road plan', '', '', 'rp-circ-dialog');
    const body = () => {
      const res = this._circuitPlan(st.sel, this._circuitOpts());
      const placed = new Map();
      for (const c of res.circuits) for (const id of c.roadIds) placed.set(id, c);
      const skip = new Map(res.skipped.map(s => [s.roadId, s.reason]));
      const sums = new Map();
      for (const c of res.circuits) for (const p of c.poles) { const s = sums.get(p.roadId) || { n: 0, m: 0 }; s.n++; s.m += p.link || p.parent ? p.spanM : 0; sums.set(p.roadId, s); }
      const rows = input.map(r => {
        const on = st.sel.has(r.id), c = placed.get(r.id), s = sums.get(r.id);
        let status = '<span class="rp-cs muted">not imported</span>';
        if (on && c) {
          const ex = this._circuitFor(c.rootId);
          status = r.id === c.rootId ? `<span class="rp-cs ok">${ex ? 'Update ' + escHtml(ex.name) : 'New circuit'}</span>`
            : `<span class="rp-cs ok">Spur: first pole links to ${escHtml(this._linkText(c, r.id))}</span>`;
        } else if (on) status = `<span class="rp-cs warn">${escHtml(skip.get(r.id) || '')}</span>`;
        return `<tr><td><input type="checkbox" data-ci="${escHtml(r.id)}"${on ? ' checked' : ''} aria-label="Import ${escHtml(r.name)}"></td><td><b>${escHtml(r.name)}</b></td><td>${r.poles.length}</td><td>${on && s ? this._fmt(s.m, 0) + ' m' : '—'}</td><td>${status}</td></tr>`;
      }).join('');
      const nCirc = res.circuits.length, nSpur = res.circuits.reduce((a, c) => a + c.roadIds.length - 1, 0);
      const nPoles = res.circuits.reduce((a, c) => a + c.poles.length, 0);
      const cableM = res.circuits.reduce((a, c) => a + c.poles.reduce((b, p) => b + p.spanM, 0), 0);
      const feedM = res.circuits.reduce((a, c) => a + c.feeder.lenM, 0);
      const opt = this._circuitOpts();
      const cableOpts = CableLib.options(st.cable, {
        filter: (x) => CableLib.isDistribution(x) && !CableLib.isMV(x) && (st.system === '1ph' || Number(x.cores) >= 4),
        groups: CableLib.reticGroups(), prefer: CableLib.reticPrefer('lv'), showAll: true,
      });
      return { res, nCirc, nSpur, nPoles, cableM, feedM, html: `<div class="rp-circ">
        <div class="rp-circ-roads"><table class="rl-table"><thead><tr><th></th><th>Road</th><th>Poles</th><th>Cable</th><th>Becomes</th></tr></thead><tbody>${rows}</tbody></table>
          <div class="sl-hint">A cable never taps mid-span. A side road is a spur only by its first pole connecting to the nearest pole of the road it leaves (within ${opt.linkMaxM} m); the span is the distance between the two poles. A road with its own feed point starts its own circuit.</div></div>
        <div class="rp-circ-set">
          <label class="rp-field">Cable for new circuits<select data-cs="cable">${cableOpts}</select></label>
          <label class="rp-field">System<select data-cs="system"><option value="3ph"${st.system !== '1ph' ? ' selected' : ''}>3Φ alternating R-W-B</option><option value="1ph"${st.system === '1ph' ? ' selected' : ''}>1Φ string</option></select></label>
          <div class="rp-grid2"><label class="rp-field" title="Added to a drawn feeder route for sag, dressing and terminations">Feeder allowance, drawn %<input type="number" step="1" min="0" data-cs="routePct" value="${escHtml(opt.routeAllowPct)}"></label>
          <label class="rp-field" title="Used when no feeder route is drawn: the straight line is longer in practice">Straight line %<input type="number" step="1" min="0" data-cs="straightPct" value="${escHtml(opt.straightAllowPct)}"></label></div>
          <label class="rp-field">Connect a spur within m<input type="number" step="5" min="5" data-cs="linkMax" value="${escHtml(opt.linkMaxM)}"></label>
          <div class="sl-hint">Existing circuits keep their cable and system. Luminaire, phase and name edits and poles added by hand are kept.</div></div></div>` };
    };
    const draw = () => {
      const b = body();
      m.querySelector('.rl-dialog-body').innerHTML = b.html;
      m.querySelector('.rl-dialog-foot').innerHTML = `<span class="rp-circ-sum">${b.nCirc ? `<b>${b.nCirc} circuit${b.nCirc === 1 ? '' : 's'}${b.nSpur ? ` with ${b.nSpur} spur${b.nSpur === 1 ? '' : 's'}` : ''}</b> · ${b.nPoles} poles · ${Math.round(b.cableM)} m of cable (feeders ${Math.round(b.feedM)} m)` : 'Nothing to import: place a feed point on a road.'}</span>
        <button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok"${b.nCirc ? '' : ' disabled'}>Import ${b.nCirc || ''} circuit${b.nCirc === 1 ? '' : 's'}</button>`;
      m._plan = b.res;
    };
    m.onchange = (e) => {
      const t = e.target, d = t.dataset, s = this.rp.settings;
      if (d.ci) { t.checked ? st.sel.add(d.ci) : st.sel.delete(d.ci); }
      else if (d.cs === 'cable') st.cable = t.value;
      else if (d.cs === 'system') { st.system = t.value; st.cable = StreetLight._defaultCable(t.value); }
      else if (d.cs === 'routePct') s.feederRoutePct = Math.max(0, this._num(t.value, 5));
      else if (d.cs === 'straightPct') s.feederStraightPct = Math.max(0, this._num(t.value, 15));
      else if (d.cs === 'linkMax') s.linkMaxM = Math.max(5, this._num(t.value, 60));
      else return;
      AppState.dirty = true; this._cp = null;
      draw();
    };
    draw();
    if (!(await RoadLight._modalResult(m))) return;
    await this.applyCircuits(m._plan, st);
  },
  _linkText(c, roadId) {
    const p = c.poles.find(x => x.roadId === roadId && x.link);
    const par = p && c.poles.find(x => x.rid === p.parent);
    if (!par) return '?';
    const names = this._poleNames(this.road(par.roadId));
    return `${(this.road(par.roadId) || {}).name || ''} ${names.get(par.rid) || ''} (${this._fmt(p.spanM, 0)} m)`;
  },

  // ─── Write the plan into the circuits ────────────────────────────────
  async applyCircuits(plan, st) {
    if (!plan || !plan.circuits.length) return;
    // Differences against circuits made earlier from the same road.
    const lines = [];
    for (const c of plan.circuits) {
      const ex = this._circuitFor(c.rootId);
      if (!ex) continue;
      const old = new Map(ex.poles.filter(p => p.roadPoleId).map(p => [p.roadPoleId, p]));
      const now = new Set(c.poles.map(p => p.rid));
      const added = c.poles.filter(p => !old.has(p.rid)).length;
      const removed = [...old.keys()].filter(k => !now.has(k)).length;
      const changed = c.poles.filter(p => old.has(p.rid) && Math.abs((+old.get(p.rid).spacingM || 0) - p.spanM) > 0.05).length;
      if (added || removed || changed) lines.push(`${ex.name}: ${added} pole${added === 1 ? '' : 's'} added, ${removed} removed, ${changed} span${changed === 1 ? '' : 's'} changed.`);
    }
    if (lines.length && !(await UI.confirm(`Update the circuits from the road plan?\n\n${lines.join('\n')}\n\nLuminaire, phase and name edits and poles added by hand are kept.`))) return;
    let made = 0, updated = 0, firstId = null;
    for (const pc of plan.circuits) {
      const root = this.road(pc.rootId);
      const src = root.feed.source;
      let c = this._circuitFor(pc.rootId);
      if (!c) {
        c = StreetLight._newCircuit(src, { roadKey: pc.rootId, system: st.system, cable: st.cable });
        c.name = `${c.name} (${root.name})`;
        StreetLight.circuits.push(c); made++;
      } else { c.source = src; updated++; }
      const old = new Map(c.poles.filter(p => p.roadPoleId).map(p => [p.roadPoleId, p]));
      const manual = c.poles.filter(p => !p.roadPoleId);
      const idOf = new Map(), next = [];
      for (const sp of pc.poles) {
        const prev = old.get(sp.rid);
        const p = prev || { id: StreetLight._genPoleId(), name: null, luminaireId: sp.ph ? 'ph:' + sp.ph : null, phase: null };
        p.roadPoleId = sp.rid;
        if (!p.name) p.name = StreetLight._nextPoleName({ poles: next.concat(manual) });
        p.spacingM = sp.spanM;
        idOf.set(sp.rid, p.id);
        p.parent = sp.parent ? idOf.get(sp.parent) : null;
        next.push(p);
      }
      c.poles = next.concat(manual);
      for (const id of pc.roadIds) { const r = this.road(id); if (r) r.circuitId = c.id; }
      if (!firstId) firstId = c.id;
    }
    StreetLight._selId = firstId;
    this._commit();
    StreetLight._afterMutate(true);
    UI.toast(`Street lighting: ${made} new, ${updated} updated circuit${made + updated === 1 ? '' : 's'} from the road plan.`, 'success', 5000);
    this.renderPanel();
  },
});
