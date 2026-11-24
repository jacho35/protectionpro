/* ProtectionPro — Road plan › roads from the site plan (RoadSitePlan).
 *
 * When the site plan (Plan workspace) already has streets — `street` routes,
 * drawn as centrelines, picked from a layer, from kerbs or from the road
 * reserve — the Road plan uses them: one road per street, kept in step with
 * the plan, and the plan's own DXF underlays as the background with the
 * plan's layer on / off state.
 *
 *   • A linked road carries `plan: { ids, sig, name, rev }`: the street route
 *     ids it was made from (a street the plan's road-reserve tool split at a
 *     junction is joined back through it — the Road plan finds a junction only
 *     where a road ends on another or two cross), the geometry signature and
 *     the name it was given. Its shape comes from the plan: a street with a
 *     carriageway (`carriageW`, `cwOffset`) becomes a `kerbs` road on the
 *     carriageway; a centreline only becomes a `poly` road (the Lighting
 *     design's own carriageway width). Its design, poles and junction classes
 *     are the Road plan's own and are kept when the geometry changes.
 *   • `plan.unlinked` = the user took it off the plan (kept as it is; Link
 *     again puts it back). Deleting a linked road records its streets in
 *     `roadPlan.planSkip` so it does not come back on the next sync.
 *   • `roadPlan.sitePlan = { auto }`: true = follow the plan (set on first
 *     open when the Road plan has no roads of its own; a project that already
 *     has hand-made roads is asked first), false = the user said Not now.
 *   • Kerb returns of the plan's streets (`settings.layout.streetReturns`)
 *     become `roadPlan.junctionReturns` entries marked `plan: true`.
 *   • Background: `roadPlan.bg.fromPlan` — entities in Road plan metres
 *     (x east, y north = plan px × the floor's scale, y flipped), each layer
 *     `{ name, color, d (descriptor id), ln (DXF layer) }`; `layerMode`
 *     'plan' (default: hidden = what the plan hides, read live) or 'own'.
 *
 * The sync runs when the Road plan opens (RoadPlan.activate) and is one
 * undo step. Pure helpers (`runs`, `flipPts`) are node-testable.
 */

const RoadSitePlan = {
  _last: null,             // summary of the last sync that changed something (shown in the rail)

  // ─── Reading the plan ────────────────────────────────────────────────
  _floors() {
    const fl = (typeof AppState !== 'undefined' && AppState.planFloors) ? AppState.planFloors() : [];
    return fl.filter(f => f && f.data && f.data.scale && +f.data.scale.factor > 0);
  },
  // Every street route of the plan in plan metres (x east, y DOWN — the plan's own frame).
  streets() {
    const out = [];
    for (const fl of this._floors()) {
      const f = +fl.data.scale.factor;
      for (const r of fl.data.routes || []) {
        if (r.type !== 'street' || !Array.isArray(r.points) || r.points.length < 2) continue;
        const p = r.props || {};
        out.push({ id: r.id, floorId: fl.id, name: p.name || '', f,
          pts: r.points.map(q => [q.x * f, q.y * f]),
          ...(() => { const c = typeof RoadSections !== 'undefined' ? RoadSections.carriage(p) : { cw: +p.carriageW > 0 ? +p.carriageW : 0, off: +p.cwOffset || 0 }; return { carriageW: c.cw > 0 ? c.cw : 0, cwOffset: c.cw > 0 ? c.off : 0 }; })(), width: +p.width || 0 });
      }
    }
    return out;
  },
  flipPts(pts) { return pts.map(q => [+q[0].toFixed(3), +(-q[1]).toFixed(3)]); },

  // Streets → runs (one road each). A street is one run; where the plan cut a
  // street at a junction (its pieces end on the same point), the piece that
  // runs on straightest (< 35°) is joined to it. Two streets with a carriageway
  // that meet only each other, end to end, are one street turning a corner (as
  // the plan draws them: one inner and one outer kerb radius) and are joined
  // whatever the turn, short of doubling back (165°). Carriageways of another
  // width or offset are joined too: the run then carries `prof` (each piece's
  // width / offset, oriented along the run) and the kerbs taper evenly across
  // each joint (`profile`).
  runs(streets) {
    const TOL = 0.6, MAXTURN = 35 * Math.PI / 180, MAXCORNER = 165 * Math.PI / 180;
    const ends = [];                    // { s, end: 0|1, x, y, dir (unit, pointing away from the node) }
    for (const s of streets) {
      const P = s.pts, n = P.length;
      const dirAt = (i, j) => { const dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
      ends.push({ s, end: 0, x: P[0][0], y: P[0][1], dir: dirAt(0, 1) });
      ends.push({ s, end: 1, x: P[n - 1][0], y: P[n - 1][1], dir: dirAt(n - 1, n - 2) });
    }
    // nodes = clusters of ends
    const nodes = [];
    for (const e of ends) {
      let nd = nodes.find(q => Math.hypot(q.x - e.x, q.y - e.y) < TOL);
      if (!nd) { nd = { x: e.x, y: e.y, ends: [] }; nodes.push(nd); }
      nd.ends.push(e);
    }
    // pair the ends at each node: straightest first
    const mate = new Map();             // end → its partner end
    // a carriageway joins a carriageway (any width: the kerbs taper), a centreline a centreline
    const same = (a, b) => (a.carriageW > 0) === (b.carriageW > 0);
    for (const nd of nodes) {
      const c = [];
      for (let i = 0; i < nd.ends.length; i++) for (let j = i + 1; j < nd.ends.length; j++) {
        const a = nd.ends[i], b = nd.ends[j];
        if (a.s === b.s || !same(a.s, b.s)) continue;
        const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1])));
        const corner = nd.ends.length === 2 && a.s.carriageW > 0;
        if (turn < (corner ? MAXCORNER : MAXTURN)) c.push({ a, b, turn });
      }
      c.sort((p, q) => p.turn - q.turn);
      for (const x of c) if (!mate.has(x.a) && !mate.has(x.b)) { mate.set(x.a, x.b); mate.set(x.b, x.a); }
    }
    const endOf = new Map(); for (const e of ends) endOf.set(e.s.id + ':' + e.end, e);
    const used = new Set(), out = [];
    const walk = (start) => {
      // go back to the free end of the chain (or round a ring once)
      let s = start, enter = 0, guard = 0;
      while (guard++ < streets.length) {
        const m = mate.get(endOf.get(s.id + ':' + enter));
        if (!m || m.s === start) break;
        s = m.s; enter = 1 - m.end;
      }
      const pieces = []; let cur = s, from = enter; guard = 0;
      while (cur && !used.has(cur.id) && guard++ <= streets.length) {
        used.add(cur.id); pieces.push({ s: cur, rev: from === 1 });
        const m = mate.get(endOf.get(cur.id + ':' + (1 - from)));
        if (!m) break;
        cur = m.s; from = m.end;
      }
      return pieces;
    };
    for (const s of streets) {
      if (used.has(s.id)) continue;
      const pieces = walk(s);
      let pts = [];
      for (const p of pieces) {
        const q = p.rev ? p.s.pts.slice().reverse() : p.s.pts;
        pts = pts.length ? pts.concat(q.slice(1)) : q.map(v => v.slice());
      }
      const len = x => { let t = 0; for (let i = 1; i < x.length; i++) t += Math.hypot(x[i][0] - x[i - 1][0], x[i][1] - x[i - 1][1]); return t; };
      const mp = pieces.slice().sort((a, b) => len(b.s.pts) - len(a.s.pts))[0], main = mp.s;
      const named = pieces.map(p => p.s.name).filter(Boolean);
      const name = (main.name || named[0] || '').trim();
      // the offset is to the left of the piece's own direction: a piece turned round has it on the other side
      const eff = p => ({ w: p.s.carriageW, o: (p.rev ? -1 : 1) * (p.s.cwOffset || 0) });
      const e0 = eff(mp), uniform = pieces.every(p => { const e = eff(p); return Math.abs(e.w - e0.w) < 0.05 && Math.abs(e.o - e0.o) < 0.05; });
      const run = { ids: pieces.map(p => p.s.id), pts, carriageW: main.carriageW, cwOffset: e0.o, name };
      const sig = [pts.map(q => [Math.round(q[0] * 100), Math.round(q[1] * 100)]), main.carriageW, e0.o];
      if (!uniform) {
        // each piece's width / offset and the joint it ends at (the joint = the last point of that piece in the run)
        run.prof = pieces.map((p, i) => { const e = eff(p), q = p.rev ? p.s.pts[0] : p.s.pts[p.s.pts.length - 1]; return { w: e.w, o: e.o, at: i < pieces.length - 1 ? q.slice() : null }; });
        sig.push(run.prof.map(x => [x.w, x.o]));
      }
      run.sig = JSON.stringify(sig);
      out.push(run);
    }
    return out;
  },

  // The taper and the rounding are PlanReserve's (the plan's kerb drawing uses the same); TAPER / MINTAPER = its defaults.
  TAPER: 20, MINTAPER: 10,
  profile(run, pts) { return PlanReserve.widthProfile(run, pts, { taper: this.TAPER, taperMin: this.MINTAPER }); },
  taperKerbs(run, pts) { return PlanReserve.taperKerbs(run, pts, { taper: this.TAPER, taperMin: this.MINTAPER }); },

  // The corners the plan draws with an inner and an outer kerb radius (two-leg corners of its kerb drawing): plan frame, inner radius.
  _corners(streets) {
    const list = streets.filter(s => s.carriageW > 0).map(s => ({ rid: s.id, pts: s.pts, w: s.width || 12, carriageW: s.carriageW, cwOffset: s.cwOffset }));
    if (!list.length || typeof PlanReserve === 'undefined') return [];
    const fl = this._floors().find(x => (x.data.routes || []).some(r => list.some(l => l.rid === r.id)));
    const rets = (((fl && fl.data.settings) || {}).layout || {}).streetReturns || {};
    let d = null;
    try { d = PlanReserve.kerbDrawing(list, { ret: 8, retWide: 10 }, c => { const m = rets[c.jkey]; return m && m[c.key] != null ? m[c.key] : null; }); } catch (_) { d = null; }
    if (!d) return [];
    const out = [];
    for (const a of d.arcs) {
      if (a.outer || !a.c.outer) continue;
      const j = d.junctions.find(x => x.key === a.c.jkey); if (j) out.push({ x: j.x, y: j.y, R: +a.R });
    }
    return out;
  },
  // A street line with its sharp turns (≥ 30°) rounded so that the inner kerb has the plan's radius there (`corners`, nearest
  // within 3 m; else 8 m): both kerbs then follow the plan's inner and outer arcs. Pure (PlanReserve.rounded).
  rounded(run, corners) {
    if (!(run.carriageW > 0) || typeof PlanReserve === 'undefined') return null;
    return PlanReserve.rounded(run, V => {
      const c = corners.filter(q => Math.hypot(q.x - V[0], q.y - V[1]) < 3).sort((p, q) => Math.hypot(p.x - V[0], p.y - V[1]) - Math.hypot(q.x - V[0], q.y - V[1]))[0];
      return c ? c.R : 8;
    }, { taper: this.TAPER, taperMin: this.MINTAPER });
  },
  // Runs with their corners rounded (`run.shapePts`); the signature then carries the radii, so a radius changed on the plan comes through.
  _runs() {
    const streets = this.streets(), runs = this.runs(streets);
    if (!runs.some(r => r.carriageW > 0)) return runs;
    const corners = this._corners(streets);
    for (const run of runs) {
      const r = this.rounded(run, corners); if (!r) continue;
      run.shapePts = r.pts; run.sig = JSON.stringify([JSON.parse(run.sig), r.radii]);
    }
    return runs;
  },

  // The Road plan shape of a run (Road plan frame: y north).
  _shape(run, rev) {
    if (run.carriageW > 0 && typeof PlanReserve !== 'undefined') {
      const k = run.prof ? this.taperKerbs(run, run.shapePts || run.pts) : PlanReserve.kerbLines({ pts: run.shapePts || run.pts, carriageW: run.carriageW, cwOffset: run.cwOffset });
      // flipping y turns left into right: the Road plan's kerb a is the plan's right kerb
      let a = this.flipPts(k.right), b = this.flipPts(k.left);
      if (rev) { a = a.reverse(); b = b.reverse(); }
      return { mode: 'kerbs', kerbs: { a, b }, carriageW: run.carriageW, cwOffset: run.cwOffset, poly: undefined };
    }
    let poly = this.flipPts(run.pts); if (rev) poly = poly.reverse();
    return { mode: 'poly', poly, kerbs: undefined, carriageW: undefined, cwOffset: undefined };
  },
  _apply(road, run) {
    const sh = this._shape(run, road.plan && road.plan.rev);
    for (const k of Object.keys(sh)) { if (sh[k] === undefined) delete road[k]; else road[k] = sh[k]; }
    delete road.ip;
  },

  linked(road) { return !!(road && road.plan && !road.plan.unlinked); },
  count() { return this.runs(this.streets()).length; },
  // Streets the plan has that no road here uses (new ones, or deleted here: `planSkip`).
  _pending(runs) {
    const have = new Set();
    for (const r of RoadPlan.roads) if (r.plan) for (const id of r.plan.ids || []) have.add(id);
    return runs.filter(u => !u.ids.some(id => have.has(id)));
  },

  // ─── The sync ────────────────────────────────────────────────────────
  // On opening the Road plan. Returns true when something changed.
  async onOpen() {
    const RP = RoadPlan.rp;
    const streets = this.streets();
    this._bgFromPlan();
    if (!streets.length) return false;
    if (!RP.sitePlan) RP.sitePlan = {};
    if (RP.sitePlan.auto === undefined) {
      const own = RoadPlan.roads.some(r => !r.plan);
      if (own) { RoadPlan.render(); return false; }          // asked in the rail (offerHtml)
      RP.sitePlan.auto = true;
    }
    if (RP.sitePlan.auto !== true) return false;
    return this.sync();
  },

  async sync({ quiet = false } = {}) {
    const RP = RoadPlan.rp, runs = this._runs();
    const roads = RoadPlan.roads, matched = new Set(), skip = new Set(RP.planSkip || []);
    let added = 0, changed = 0, removed = 0, designId = null;
    for (const run of runs) {
      // the road that shares most of its streets
      let best = null, bn = 0;
      for (const r of roads) {
        if (!r.plan || matched.has(r)) continue;
        const n = run.ids.filter(id => (r.plan.ids || []).includes(id)).length;
        if (n > bn) { bn = n; best = r; }
      }
      if (best) {
        matched.add(best);
        if (best.plan.unlinked) continue;
        const nameFollows = !best.plan.name || best.name === best.plan.name;
        if (best.plan.sig !== run.sig || (best.plan.ids || []).join() !== run.ids.join()) {
          this._apply(best, run);
          best.plan.ids = run.ids; best.plan.sig = run.sig;
          RoadPlan._geo.delete(best.id);
          RoadPlan.layoutRoad(best, true);
          changed++;
        }
        if (run.name && nameFollows && best.name !== run.name) { best.name = run.name; if (!changed) changed++; }
        best.plan.name = run.name || best.plan.name;
        continue;
      }
      if (run.ids.every(id => skip.has(id))) continue;
      if (!designId) designId = await RoadPlan._designForNewRoad();
      if (!designId) break;
      const road = { id: RoadPlan._genId('rpr'), name: run.name || `Road ${roads.length + 1}`, designId, radius: 50, poles: [], layout: {},
        plan: { ids: run.ids, sig: run.sig, name: run.name || '' } };
      this._apply(road, run);
      roads.push(road); matched.add(road);
      added++;
    }
    // linked roads whose street is gone from the plan
    const gone = roads.filter(r => r.plan && !r.plan.unlinked && !matched.has(r));
    if (gone.length) { const ids = new Set(gone.map(r => r.id)); RP.roads = roads.filter(r => !ids.has(r.id)); removed = gone.length; }
    RP.planSkip = (RP.planSkip || []).filter(id => runs.some(u => u.ids.includes(id)));
    if (!added && !changed && !removed) { this._returns(); return false; }
    RoadPlan._geo.clear();
    this._returns();
    for (const r of RoadPlan.roads) if (!(r.poles || []).some(p => p.moved)) RoadPlan.layoutRoad(r);
    if (!RoadPlan.selRoad) RoadPlan._selRoad = RoadPlan.roads.length ? RoadPlan.roads[0].id : null;
    const parts = [added && `${added} new`, changed && `${changed} changed`, removed && `${removed} removed`].filter(Boolean).join(', ');
    this._last = { text: parts, at: Date.now() };
    RoadPlan._commit(`Roads from the site plan (${parts})`);
    RoadPlan.render();
    if (!quiet) UI.toast(`Roads follow the site plan's roads: ${parts}.`, 'success', 5000);
    return true;
  },

  // Kerb returns of the plan's streets → the Road plan's junctions (within 5 m).
  _returns() {
    const RP = RoadPlan.rp;
    const jr = RP.junctionReturns || {};
    for (const k of Object.keys(jr)) { jr[k] = (jr[k] || []).filter(c => !c.plan); if (!jr[k].length) delete jr[k]; }
    if (typeof PlanReserve === 'undefined') { if (Object.keys(jr).length) RP.junctionReturns = jr; else delete RP.junctionReturns; return; }
    const ids = new Set(); for (const r of RoadPlan.roads) if (this.linked(r) && r.mode === 'kerbs') for (const id of r.plan.ids) ids.add(id);
    const list = this.streets().filter(s => ids.has(s.id) && s.carriageW > 0).map(s => ({ rid: s.id, pts: s.pts, w: s.width || 12, carriageW: s.carriageW, cwOffset: s.cwOffset }));
    if (list.length) {
      const fl = this._floors().find(x => (x.data.routes || []).some(r => ids.has(r.id)));
      const rets = (((fl && fl.data.settings) || {}).layout || {}).streetReturns || {};
      let d = null;
      try { d = PlanReserve.kerbDrawing(list, { ret: 8, retWide: 10 }, c => { const m = rets[c.jkey]; return m && m[c.key] != null ? m[c.key] : null; }); } catch (_) { d = null; }
      if (d) {
        const rjs = RoadPlan.junctions(), fl2 = v => [v[0], -v[1]];
        for (const a of d.arcs) {
          if (a.outer) continue;
          const c = a.c, j = d.junctions.find(x => x.key === c.jkey); if (!j) continue;
          const jx = j.x, jy = -j.y;
          const rj = rjs.filter(q => Math.hypot(q.x - jx, q.y - jy) < 5).sort((p, q) => Math.hypot(p.x - jx, p.y - jy) - Math.hypot(q.x - jx, q.y - jy))[0];
          if (!rj) continue;
          (jr[rj.key] = jr[rj.key] || []).push({ k: c.key, P: fl2(c.P), u: fl2(c.u), v: fl2(c.v), theta: c.theta, rmax: c.rmax, def: c.def, R: +(+a.R).toFixed(2), plan: true });
        }
      }
    }
    if (Object.keys(jr).length) RP.junctionReturns = jr; else delete RP.junctionReturns;
  },

  // ─── Actions from the Road plan ──────────────────────────────────────
  async useStreets() {
    const RP = RoadPlan.rp; RP.sitePlan = Object.assign(RP.sitePlan || {}, { auto: true }); RP.planSkip = [];
    if (!(await this.sync())) RoadPlan.render();
  },
  notNow() { const RP = RoadPlan.rp; RP.sitePlan = Object.assign(RP.sitePlan || {}, { auto: false }); AppState.dirty = true; RoadPlan.render(); },
  unlink(road) { if (!this.linked(road)) return; road.plan.unlinked = true; RoadPlan._commit(`Unlink ${road.name} from the site plan`); RoadPlan.render(); },
  async relink(road) {
    if (!road || !road.plan) return;
    delete road.plan.unlinked; road.plan.sig = '';                  // forces the plan's geometry back on
    const RP = RoadPlan.rp; RP.sitePlan = Object.assign(RP.sitePlan || {}, { auto: true });
    if (!(await this.sync({ quiet: true }))) RoadPlan.render();
  },
  // A linked road deleted here stays off: its streets are skipped by later syncs.
  forget(road) {
    if (!road || !road.plan) return;
    const RP = RoadPlan.rp; RP.planSkip = Array.from(new Set((RP.planSkip || []).concat(road.plan.ids || [])));
  },
  goToStreet(road) {
    const id = road && road.plan && road.plan.ids && road.plan.ids[0];
    if (!id) return;
    if (typeof Links !== 'undefined' && Links.go) Links.go('plan:' + id, 'sl:roadplan');
  },

  // ─── Rail / panel HTML ───────────────────────────────────────────────
  railHtml() {
    const RP = RoadPlan.rp, runs = this.runs(this.streets());
    if (!runs.length) return '';
    const sp = RP.sitePlan || {};
    if (sp.auto !== true) {
      const own = RoadPlan.roads.filter(r => !r.plan).length;
      return `<div class="rp-siteplan offer"><b>The site plan has ${runs.length} street${runs.length === 1 ? '' : 's'}.</b>
        <span>${own ? `Use them as roads here? Your ${own} road${own === 1 ? '' : 's'} drawn here stay as they are.` : 'Use them as roads here.'}</span>
        <span class="rp-siteplan-acts"><button class="btn-small btn-primary" data-rp="sp-use">Use the site plan's roads</button>${sp.auto === false ? '' : '<button class="btn-small" data-rp="sp-no">Not now</button>'}</span></div>`;
    }
    const linked = RoadPlan.roads.filter(r => this.linked(r));
    const km = linked.reduce((t, r) => t + RoadPlan.geom(r).al.length, 0) / 1000;
    const pend = this._pending(runs).length;
    return `<div class="rp-siteplan"><b>From the site plan</b>
      <span>${linked.length} road${linked.length === 1 ? '' : 's'} follow${linked.length === 1 ? 's' : ''} the plan · ${km.toFixed(2)} km${this._last && linked.length ? ` · last update: ${escHtml(this._last.text)}` : ''}</span>
      <span class="sl-hint">Each road follows its road on the Plan; its design and poles are set here.</span>
      ${pend ? `<span class="rp-siteplan-acts"><button class="btn-small" data-rp="sp-use">Add ${pend} street${pend === 1 ? '' : 's'} not used here</button></span>` : ''}</div>`;
  },
  panelHtml(road) {
    if (!road || !road.plan) return '';
    if (road.plan.unlinked) return `<div class="rp-block rp-sp-link"><div class="rp-block-h"><b>Site plan</b><span class="sl-hint">unlinked</span></div>
      <div class="sl-hint">Made from a site plan road, now kept as it is here.</div>
      <div class="rp-actions"><button class="btn-small" data-rp="sp-relink">Link again</button></div></div>`;
    return `<div class="rp-block rp-sp-link"><div class="rp-block-h"><b>Site plan</b><span class="rp-sp-chip">Linked to the site plan road</span></div>
      <div class="sl-hint">${road.mode === 'kerbs' ? `Carriageway ${RoadPlan._fmt(road.carriageW, 1)} m from the plan${road.cwOffset ? `, ${RoadPlan._fmt(Math.abs(road.cwOffset), 1)} m off the road line` : ''}.` : 'The plan has the centreline only: the carriageway width is the Lighting design\'s.'} The shape follows the Plan; edit the road there, or unlink it to keep it as it is here.</div>
      <div class="rp-actions"><button class="btn-small" data-rp="sp-go">Edit on the Plan</button><button class="btn-small" data-rp="sp-unlink">Unlink</button></div></div>`;
  },

  // ─── Background: the plan's DXF underlays, same layers ───────────────
  _bgSig(fl) {
    return (fl.data.dxfs || []).filter(d => !d.hidden).map(d => [d.id, d.imageId, d.offX, d.offY, d.rotation, d.scaleAdj, d.k, typeof PlanDxfImport !== 'undefined' && d.clip ? PlanDxfImport._clipSig(d) : ''].join(',')).join('|') + '#' + fl.data.scale.factor;
  },
  _bgFloor() {
    const fls = this._floors().filter(f => (f.data.dxfs || []).some(d => !d.hidden));
    return fls.find(f => (f.data.routes || []).some(r => r.type === 'street')) || fls[0] || null;
  },
  // Build or refresh the background from the plan when the Road plan has none, or has the plan's and it changed.
  async _bgFromPlan(force = false) {
    if (typeof PlanDxfImport === 'undefined') return false;
    const RP = RoadPlan.rp, bg = RP.bg;
    if (bg && !bg.fromPlan && !force) return false;
    const fl = this._bgFloor(); if (!fl) return false;
    const sig = this._bgSig(fl);
    if (bg && bg.fromPlan && bg.sig === sig && !force) return false;
    const f = +fl.data.scale.factor, descs = (fl.data.dxfs || []).filter(d => !d.hidden);
    const ents = [], texts = [], layers = [], seen = new Map();
    let npts = 0, truncated = false;
    for (const desc of descs) {
      let data = PlanDxfImport.dataOf(desc);
      if (!data && desc.imageId != null) {
        try {
          const resp = await fetch(`${API_BASE}/plan-images/${desc.imageId}`, { headers: API.authHeaders() });
          if (resp.ok) { const raw = PlanDxfImport._normalise(await resp.json()); PlanDxfImport._data.set(PlanDxfImport._key(desc), raw); data = PlanDxfImport.dataOf(desc); }
        } catch (_) { data = null; }
      }
      if (!data || !Array.isArray(data.entities)) continue;
      const xf = (X, Y) => { const w = PlanDxfImport.worldOf(desc, X, Y); return [+(w.x * f).toFixed(3), +(-w.y * f).toFixed(3)]; };
      const lkey = (ln) => descs.length > 1 ? `${desc.name || 'DXF'}: ${ln}` : ln;
      const lmeta = new Map((data.layers || []).map(l => [l.name, l]));
      const push = (ln, flat, closed) => {
        if (npts + flat.length / 2 > 120000) { truncated = true; return; }
        const p = [];
        for (let i = 0; i + 1 < flat.length; i += 2) { const q = xf(flat[i], flat[i + 1]); p.push(q[0], q[1]); }
        npts += p.length / 2;
        const l = lkey(ln);
        if (!seen.has(l)) {
          const lm = lmeta.get(ln) || {};
          const color = PlanDxfImport.layerColor(desc, data, ln) || lm.color || '#8a8f98';
          seen.set(l, true); layers.push({ name: l, color, hidden: !!PlanDxfImport.layerHidden(desc, ln), d: desc.id, ln });
        }
        ents.push({ l, p, c: closed ? 1 : 0 });
      };
      for (const e of data.entities) {
        if (e.t === 'x' && texts.length < 500 && /[A-Za-z]{3,}/.test(String(e.s || '')) && e.p) { const q = xf(e.p[0], e.p[1]); texts.push({ s: String(e.s).replace(/\s+/g, ' ').trim(), x: q[0], y: q[1] }); continue; }
        if (e.t === 'l') push(e.l, e.p, false);
        else if (e.t === 'p' && e.p && e.p.length >= 4) push(e.l, e.p, !!e.c);
        else if (e.t === 'a' || e.t === 'c') {
          const [cx, cy, r] = e.p;
          let a0 = e.t === 'a' ? e.p[3] : 0, a1 = e.t === 'a' ? e.p[4] : 360;
          if (a1 <= a0) a1 += 360;
          const n = Math.max(4, Math.ceil((a1 - a0) / 5)), flat = [];
          for (let k = 0; k <= n; k++) { const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180; flat.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
          push(e.l, flat, e.t === 'c');
        }
      }
    }
    if (!ents.length) return false;
    RP.bg = { name: 'Site plan', fromPlan: true, floorId: fl.id, sig, layerMode: (bg && bg.fromPlan && bg.layerMode) || 'plan', unitM: 1, origin: [0, 0], layers, ents, texts, truncated };
    AppState.dirty = true;
    if (!bg) RoadPlan._fitted = false;
    if (RoadPlan._active) { if (!RoadPlan._fitted) { RoadPlan._fitted = true; RoadPlan.fit(); } RoadPlan.render(); }
    return true;
  },
  // Is a background layer hidden? Plan mode reads the plan's own state live.
  layerHidden(bg, l) {
    if (!bg.fromPlan || bg.layerMode === 'own') return !!l.hidden;
    const fl = this._floors().find(x => x.id === bg.floorId);
    const desc = fl && (fl.data.dxfs || []).find(d => d.id === l.d);
    if (!desc) return !!l.hidden;
    return !!desc.hidden || !!PlanDxfImport.layerHidden(desc, l.ln);
  },
  setLayerMode(mode) {
    const bg = RoadPlan.rp.bg; if (!bg || !bg.fromPlan) return;
    if (mode === 'own' && bg.layerMode !== 'own') for (const l of bg.layers) l.hidden = this.layerHidden(bg, l);   // start from what shows now
    bg.layerMode = mode; AppState.dirty = true; RoadPlan.render();
  },
  bgHtml(bg) {
    const own = bg.layerMode === 'own';
    return `<div class="rp-bg-name">Site plan <span class="sl-hint">${bg.ents.length} lines${bg.truncated ? ' (first part only)' : ''}</span></div>
      <div class="rp-seg" role="group" aria-label="Background layers"><button class="btn-small${own ? '' : ' active'}" data-rp="sp-lay-plan" aria-pressed="${!own}">Same as site plan</button><button class="btn-small${own ? ' active' : ''}" data-rp="sp-lay-own" aria-pressed="${own}">Own layers</button></div>
      <details class="rp-layers"><summary>Layers (${bg.layers.length})</summary>${bg.layers.map((l, i) => { const h = this.layerHidden(bg, l); return `<label class="rp-layer"><input type="checkbox" data-rp-layer="${i}"${h ? '' : ' checked'}${own ? '' : ' disabled'}><i style="background:${escHtml(l.color)}"></i>${escHtml(l.name)}${own ? '' : `<span class="sl-hint">${h ? 'off' : 'on'} in Plan</span>`}</label>`; }).join('')}</details>
      <div class="sl-hint">${own ? 'Changes here affect this view only; the Plan keeps its own.' : 'Follows Plan › Underlays: turn a layer on there and it shows here.'}</div>
      <div class="rp-bg-actions"><button class="btn-small" data-rp="sp-bg-refresh" title="Read the site plan's drawings again">Refresh</button><button class="btn-small" data-rp="bg">Use another DXF…</button><button class="btn-small" data-rp="bg-remove">Remove</button></div>`;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { RoadSitePlan };
