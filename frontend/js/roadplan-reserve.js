/**
 * RoadReserve — Road plan › *Roads from road reserve*: click inside the road reserves of the DXF background; the picked road space
 * becomes roads (one per stretch between intersections), each in `kerbs` mode on the carriageway.
 *
 * The same pipeline and review as Auto layout's Streets from road reserve (PlanReserveUI, plan-reserve-ui.js — this object is
 * derived from it): PlanReserve turns the picked space into streets with a reserve width, a carriageway (width + offset) and a
 * kerb return at each corner of a junction. Here the background is `RoadPlan.rp.bg` (already metres, no working area: close an
 * entrance with a Cut line). Create writes roads with
 *   kerbs: { a, b }       the carriageway kerb lines (the lighting calculation sees the carriageway, not the reserve)
 *   reserve: { a, b }     the reserve lines (display only), carriageW, cwOffset, fromReserve: true
 * and the kerb returns in `rp.junctionReturns { [junction key]: [{ k, P, u, v, theta, rmax, R }] }` (the junction keys are the Road
 * plan's own, matched to the reserve's junctions within 5 m). A return is a fillet: the area between the two kerb lines and the arc
 * joins the junction's conflict area, so the junction is lit and checked to its real kerb line. Roads that do not come from here
 * have no entry and behave as before.
 *
 * Drag the handle at the middle of a return (select tool, or while reviewing) to change its radius; Alt-click puts it back.
 */
const RoadReserve = Object.assign(Object.create(PlanReserveUI), {
  on: false,
  bendCorners: false,                                                 // no bend corners / outer radii here: the roads keep the reserve's centre line (see _kerbOpts)
  stage: null,
  opt: { layers: '', carriageW: 6, ret: 8, wmax: 40, step: 0.5, gapM: 0.6 },
  _hdrag: null,

  // ── the drawing ──
  _segments() {
    const bg = RoadPlan.rp.bg, segs = [], names = new Set(); let rx = null;
    try { rx = this.opt.layers ? new RegExp(this.opt.layers, 'i') : null; } catch (e) { rx = null; }
    for (const e of (bg ? bg.ents : [])) {
      if (e.p.length < 4 || (rx && !rx.test(e.l))) continue;
      for (let i = 0; i + 3 < e.p.length; i += 2) segs.push([e.p[i], e.p[i + 1], e.p[i + 2], e.p[i + 3]]);
      if (e.c && e.p.length > 5) segs.push([e.p[e.p.length - 2], e.p[e.p.length - 1], e.p[0], e.p[1]]);
      names.add(e.l);
    }
    return { segs, wa: null, layers: [...names], usedAll: false };
  },
  _tol(S) { return 10 / RoadPlan._view.z; },
  _sync() { RoadPlan.renderPanel(); RoadPlan.renderScreen(); RoadPlan._hint(); },

  // ── open / close ──
  open() {
    const g = this._segments(); if (!g.segs.length) { UI.toast('The background drawing has no lines to work from.', 'warn', 4000); return; }
    this.on = true;
    this.stage = { T: PlanReserve.stage(g.segs, null, { step: this.opt.step, gapM: this.opt.gapM }), f: 1, mode: 'add', draft: [], cutDraft: [], dropped: new Set(), edits: {}, returns: {}, res: null, hover: null, drag: null, layers: g.layers, usedAll: false, hasWa: true };
    RoadPlan.setTool('reserveauto'); RoadPlan.renderPanel();
    UI.toast('Click inside a road reserve to add it. If the road space runs out of the drawing, draw a Cut line across the entrance. Alt-click a street drops it, Backspace undoes, Enter creates.', 'info', 8000);
  },
  start() { this.open(); },
  close() { this.on = false; this.stage = null; },
  cancel() { RoadPlan.setTool('select'); },
  restart() { const S = this.stage; if (!S) return; const ops = S.T.ops.slice(), g = this._segments(); S.T = PlanReserve.stage(g.segs, null, { step: this.opt.step, gapM: this.opt.gapM }); for (const op of ops) { if (op.k === 'cut') S.T.cut(op.pts); else if (op.k === 'poly') S.T.polygon(op.pts, op.sub); else S.T.click(op.pt, op.sub ? 'sub' : 'add'); } S.res = null; this.compute(); this._sync(); },

  // ── the canvas ──
  downAt(wx, wy, e) { this.down({ x: wx, y: wy }, e); },
  moveAt(wx, wy, e) { if (this.stage) this.move({ x: wx, y: wy }, e); },
  keyAt(e) {
    if (!this.stage) return false;
    if (e.key === 'Escape' && !(this.stage.draft.length || this.stage.cutDraft.length)) { RoadPlan.setTool('select'); return true; }
    return this.key(e);
  },
  overlay(S, out) {
    const T = this.stage; if (!T) return; const R = T.res || this.compute();
    const path = (pts, attrs, close) => pts.length > 1 ? `<path d="M${pts.map(q => S(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join('L')}${close ? 'Z' : ''}" ${attrs}/>` : '';
    if (R.rings.length) out.push(`<path fill-rule="evenodd" d="${R.rings.map(r => 'M' + r.map(q => S(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join('L') + 'Z').join('')}" fill="rgba(245,158,11,.18)" stroke="rgba(180,83,9,.5)"/>`);
    for (const c of T.T.cuts) out.push(path(c, 'fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 4"'));
    for (const s of R.streets) {
      out.push(path(s.pts, 'fill="none" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"'));
      const m = s.pts[s.pts.length >> 1], [x, y] = S(m[0], m[1]);
      out.push(`<text x="${(x + 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="11" fill="#92400e">${Math.abs(s.wMax - s.wMin) < 0.6 ? s.w.toFixed(1) : s.wMin.toFixed(1) + '–' + s.wMax.toFixed(1)} m</text>`);
    }
    for (const k of R.kerbs || []) out.push(path(k, 'fill="none" stroke="#475569" stroke-width="1.2"'));      // kerb lines, cut back to the returns
    for (const c of R.corners) {
      const a = PlanReserve.returnArc(c, this._R(c)), [hx, hy] = S(a.mid[0], a.mid[1]), hot = T.drag && T.drag.key === c.key && T.drag.jkey === c.jkey;
      out.push(path(a.pts, 'fill="none" stroke="#334155" stroke-width="2"')); if (a.outer) out.push(path(a.outer.pts, 'fill="none" stroke="#334155" stroke-width="2"'));
      out.push(`<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="5" fill="${hot ? '#2563eb' : '#fff'}" stroke="#2563eb" stroke-width="1.5"/>${hot ? `<text x="${(hx + 8).toFixed(1)}" y="${(hy - 6).toFixed(1)}" font-size="11" fill="#1e3a8a">R ${a.R.toFixed(1)} m</text>` : ''}`);
    }
    for (const j of R.junctions) { const [x, y] = S(j.x, j.y); out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#f59e0b"/>`); }
    const dr = (pts, col, close) => { if (!pts.length) return; const q = T.hover ? pts.concat([T.hover]) : pts; out.push(path(close && pts.length > 2 ? q.concat([pts[0]]) : q, `fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="5 4"`)); for (const p of pts) { const [x, y] = S(p[0], p[1]); out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${col}"/>`); } };
    dr(T.draft, '#2563eb', true); dr(T.cutDraft, '#dc2626', false);
  },

  act(t) { return PlanReserveUI.act.call(this, { dataset: Object.assign({}, t.dataset, { act: t.dataset.rp }) }); },

  // ── the panel (the shared HTML, in the Road plan's controls) ──
  panelHtml() {
    if (!this.stage) return '';
    return '<div class="rk-panel"><h3>Roads from road reserve</h3>' + PlanReserveUI.panelHtml.call(this).replace(/data-act="rs-/g, 'data-rp="rs-').replace(/class="plan-btn"/g, 'class="btn-small"').replace('<b>Streets from road reserve</b>', '').replace(/Create (\d+) street/g, 'Create $1 road').replace(/street(s?)\b/g, 'road$1') + '</div>';
  },

  // ── Create ──
  async create() {
    const S = this.stage; if (!S) return; if (!S.res || S.res.rev !== S.T.rev) this.compute();
    const R = S.res; if (!R.streets.length) { UI.toast('No roads to create.', 'warn', 3000); return; }
    const designId = await RoadPlan._designForNewRoad(); if (!designId) return;
    const old = RoadPlan.roads.filter(r => r.fromReserve); let choice = 'add';
    if (old.length) { choice = await this._ask(old.length); if (choice === 'cancel') return; }
    if (choice === 'replace') { const ids = new Set(old.map(r => r.id)); RoadPlan.rp.roads = RoadPlan.roads.filter(r => !ids.has(r.id)); }
    const made = [], bgTexts = (RoadPlan.rp.bg && RoadPlan.rp.bg.texts) || [], used = new Set();
    const nameOf = st => { let best = null, bd = 25; for (const t of bgTexts) { if (used.has(t)) continue; let d = Infinity; for (let i = 0; i + 1 < st.pts.length; i++) d = Math.min(d, PlanKerbsSeg([t.x, t.y], st.pts[i], st.pts[i + 1])); if (d < bd) { bd = d; best = t; } } if (best) used.add(best); return best ? best.s : null; };
    // The Road plan finds a junction where a road ends on another or two cross, so the roads are the *through* streets: the stretches
    // between junctions are joined again (the pieces of one street, in order; a dropped piece breaks the run).
    const byParent = new Map(); for (const s of R.streets) { if (!byParent.has(s.parent)) byParent.set(s.parent, []); byParent.get(s.parent).push(s); }
    const runs = [];
    for (const list of byParent.values()) {
      let run = null;
      for (const s of list) {
        const e = run && run.pts[run.pts.length - 1];
        if (run && Math.hypot(e[0] - s.pts[0][0], e[1] - s.pts[0][1]) < 0.6) { run.pts = run.pts.concat(s.pts.slice(1)); run.pieces.push(s); }
        else { if (run) runs.push(run); run = { pts: s.pts.map(q => q.slice()), pieces: [s] }; }
      }
      if (run) runs.push(run);
    }
    for (const run of runs) {
      const L = x => { let t = 0; for (let i = 1; i < x.length; i++) t += Math.hypot(x[i][0] - x[i - 1][0], x[i][1] - x[i - 1][1]); return t; };
      const tot = run.pieces.reduce((a, q) => a + L(q.pts), 0) || 1, w = run.pieces.reduce((a, q) => a + q.w * L(q.pts), 0) / tot, main = run.pieces.slice().sort((a, c) => L(c.pts) - L(a.pts))[0];
      const st = { pts: run.pts, carriageW: main.carriageW, cwOffset: main.cwOffset }, k = PlanReserve.kerbLines(st), half = w / 2;
      const road = { id: RoadPlan._genId('rpr'), name: nameOf(st) || `Road ${RoadPlan.roads.length + 1}`, designId, radius: 50, poles: [], layout: {}, mode: 'kerbs', kerbs: { a: k.left, b: k.right }, reserve: { a: PlanReserve.offsetLine(run.pts, half), b: PlanReserve.offsetLine(run.pts, -half) }, carriageW: main.carriageW, cwOffset: main.cwOffset, fromReserve: true };
      RoadPlan.roads.push(road); made.push(road);
    }
    if (!made.length) { UI.toast('No road could be made from that road space.', 'warn', 3500); return; }
    RoadPlan._selRoad = made[0].id;
    // kerb returns: the reserve's junctions matched to the Road plan's own within 5 m
    RoadPlan._geo.clear();
    const jr = RoadPlan.rp.junctionReturns = choice === 'replace' ? {} : (RoadPlan.rp.junctionReturns || {}), rjs = RoadPlan.junctions();
    for (const c of R.corners) {
      const j = R.junctions.find(x => x.key === c.jkey); if (!j) continue;
      const rj = rjs.filter(q => Math.hypot(q.x - j.x, q.y - j.y) < 5).sort((a, b) => Math.hypot(a.x - j.x, a.y - j.y) - Math.hypot(b.x - j.x, b.y - j.y))[0]; if (!rj) continue;
      (jr[rj.key] = jr[rj.key] || []).push({ k: c.key, P: c.P, u: c.u, v: c.v, theta: c.theta, rmax: c.rmax, def: c.def, R: +this._R(c).toFixed(2) });
    }
    for (const r of RoadPlan.roads) if (!r.poles.some(p => p.moved)) RoadPlan.layoutRoad(r);
    RoadPlan._commit(); this.stage = null; RoadPlan.setTool('select'); RoadPlan.render();
    UI.toast(`${made.length} road${made.length === 1 ? '' : 's'} made from the road reserve, each on its carriageway (width and offset in the road's data).`, 'success', 7000);
  },

  // ── kerb returns of the roads on the plan: handles + drag (select tool) ──
  returns() { const o = (RoadPlan.rp.junctionReturns) || {}; return Object.entries(o).flatMap(([jk, list]) => (list || []).map(c => ({ jk, c }))); },
  arcOf(c) { return PlanReserve.returnArc(c, c.R); },
  // the fillet between the two kerb lines and the arc (a polygon for the conflict area)
  fillet(c) { const a = this.arcOf(c); return [c.P.map(v => +v.toFixed(2))].concat(a.pts); },
  overlayReturns(S, out) {
    for (const { c } of this.returns()) {
      const a = this.arcOf(c), [hx, hy] = S(a.mid[0], a.mid[1]), hot = this._hdrag && this._hdrag.c === c;
      for (const pts of a.outer ? [a.pts, a.outer.pts] : [a.pts]) out.push(`<path d="M${pts.map(q => S(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join('L')}" fill="none" class="rp-return" stroke="#334155" stroke-width="2"/>`);
      if (RoadPlan._tool === 'select') out.push(`<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="5" fill="${hot ? '#2563eb' : '#fff'}" stroke="#2563eb" stroke-width="1.5"/>${hot ? `<text x="${(hx + 8).toFixed(1)}" y="${(hy - 6).toFixed(1)}" font-size="11" fill="#1e3a8a">R ${a.R.toFixed(1)} m</text>` : ''}`);
    }
  },
  downSelect(wx, wy, e) {
    const tol = 8 / RoadPlan._view.z;
    for (const { jk, c } of this.returns()) {
      const a = this.arcOf(c); if (Math.hypot(a.mid[0] - wx, a.mid[1] - wy) > tol) continue;
      if (e.altKey) { c.R = Math.min(c.rmax, c.def != null ? c.def : 8); RoadPlan._commit(); RoadPlan.render(); return true; }
      this._hdrag = { jk, c, moved: false }; RoadPlan._drag = { kind: 'return', id: e.pointerId }; document.getElementById('rp-svg').setPointerCapture(e.pointerId); return true;
    }
    return false;
  },
  moveDrag(wx, wy) { const d = this._hdrag; if (!d) return false; d.c.R = +PlanReserve.radiusFromDrag(d.c, [wx, wy]).toFixed(2); d.moved = true; RoadPlan._resStale = true; RoadPlan.renderScreen(); return true; },
  upDrag() { const d = this._hdrag; this._hdrag = null; if (d && d.moved) { RoadPlan._commit(); RoadPlan.render(); } },
});
