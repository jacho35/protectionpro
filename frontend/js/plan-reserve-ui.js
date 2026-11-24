/**
 * PlanReserveUI — Auto layout › Streets › *Streets from road reserve*.
 *
 * Click inside a road reserve (the space between the erf boundaries, or one outline per street); the picked road space becomes
 * streets: one per stretch between intersections, each with the reserve width (measured, as `width`) and a carriageway of its
 * own (width + offset), with the kerb return at every corner of a junction (drag the handle to change it). The geometry is
 * PlanReserve (plan-reserve.js, node-testable); this file is the review on the plan, the panel and Create.
 *
 *   Add (click)       the road space under the pointer joins the pick (seams between adjacent reserves close)
 *   Subtract          the connected picked piece under the pointer leaves it (Alt-click does it for one click)
 *   Alt-click a street  drops that street (it stays dropped when the pick changes)
 *   Draw              click the corners of a reserve the detection misses; Enter or the first corner closes it
 *   Cut               click across a reserve: the line is a wall (closes an entrance, separates a part to drop)
 *   Backspace         takes the last pick back; Enter creates; Esc leaves
 *
 * A street written by Create is a route `street` with props { name, width (reserve), reserveProfile, carriageW, cwOffset, auto: 'reserve' };
 * the edited kerb returns are in settings.layout.streetReturns { [junction]: { [corner]: radius } }. Streets drawn with a carriageW
 * show their two kerb lines and returns on the plan (`planGeometry`, called by the plan engine).
 */
const PlanReserveUI = {
  stage: null,
  opt: { layers: 'road|reserve|street|straat|erf|erven|stand|cadastr|parcel|boundary|property|lot', carriageW: 6, ret: 8, wmax: 40, step: 0.5, gapM: 0.6 },

  // ── start / segments ──
  _segments() {
    const f = PlanEngine.factor(), segs = [], names = new Set(); let rx = null;
    try { rx = this.opt.layers ? new RegExp(this.opt.layers, 'i') : null; } catch (e) { rx = null; }
    const take = (all) => {
      segs.length = 0; names.clear();
      for (const d of PlanDxfImport.list()) {
        const data = d.hidden ? null : PlanDxfImport.dataOf(d); if (!data) continue;
        const M = (x, y) => { const w = PlanDxfImport.worldOf(d, x, y); return [w.x * f, w.y * f]; };
        const keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
        for (const r of (data.entities || [])) {
          if (PlanDxfImport.layerHidden(d, r.l) || (keep && !keep(r)) || (!all && rx && !rx.test(r.l))) continue;
          if (r.t === 'l') { const a = M(r.p[0], r.p[1]), b = M(r.p[2], r.p[3]); segs.push([a[0], a[1], b[0], b[1]]); names.add(r.l); }
          else if (r.t === 'p' && r.g !== 'HATCH') {
            const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push(M(r.p[i], r.p[i + 1]));
            for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
            if (r.c && pts.length > 2) segs.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]]);
            names.add(r.l);
          }
        }
      }
    };
    take(false); let usedAll = false;
    if (!segs.length) { take(true); usedAll = true; }
    const wp = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.worldPoly() : null;
    return { segs: segs.slice(), wa: wp ? wp.map(p => [p[0] * f, p[1] * f]) : null, layers: [...names], usedAll };
  },
  start() {
    if (typeof PlanReserve === 'undefined') return;
    const f = PlanEngine.factor(); if (!f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return; }
    const g = this._segments(); if (!g.segs.length) { UI.toast('The drawings have no visible lines or polylines.', 'warn', 4000); return; }
    PlanLayoutUI.kerbStage = null; PlanLayoutUI.centreStage = null;
    this.stage = { T: PlanReserve.stage(g.segs, g.wa, { step: this.opt.step, gapM: this.opt.gapM }), f, mode: 'add', draft: [], cutDraft: [], dropped: new Set(), edits: {}, returns: {}, res: null, hover: null, drag: null, layers: g.layers, usedAll: g.usedAll, hasWa: !!g.wa };
    UI.toast(g.wa ? 'Click inside a road reserve to add it. Alt-click a road drops it, Backspace undoes, Enter creates.' : 'Click inside a road reserve. No working area is set: draw one round the development first if the road space runs out of the drawing, or draw a Cut line across the entrance.', 'info', 8000);
    this._sync();
  },
  cancel() { this.stage = null; this._sync(); },
  _sync() { PlanLayoutUI.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  restart() {                                                          // an option that changes the raster / the layers: rebuild, replay the picks
    const S = this.stage; if (!S) return; const ops = S.T.ops.slice(), g = this._segments();
    S.T = PlanReserve.stage(g.segs, g.wa, { step: this.opt.step, gapM: this.opt.gapM }); S.layers = g.layers; S.usedAll = g.usedAll;
    for (const op of ops) { if (op.k === 'cut') S.T.cut(op.pts); else if (op.k === 'poly') S.T.polygon(op.pts, op.sub); else S.T.click(op.pt, op.sub ? 'sub' : 'add'); }
    S.res = null; this.compute(); this._sync();
  },

  // ── the streets of the picked space ──
  compute() {
    const S = this.stage; if (!S) return null; const T = S.T, o = this.opt;
    if (T.empty()) { S.res = { rings: [], streets: [], junctions: [], corners: [], rev: T.rev }; return S.res; }
    const rings = T.contours();
    const r = PlanReserve.streets(rings, Object.assign({}, T.o, { inside: T.inside, step: T.g.step, wmax: o.wmax }));
    const sp = PlanReserve.split(r.streets), streets = sp.streets.filter(s => !S.dropped.has(s.key)), byId = {};
    streets.forEach(s => {
      const ws = (s.ws || []).map(q => q[1]); s.wMin = ws.length ? Math.min(...ws) : s.w; s.wMax = ws.length ? Math.max(...ws) : s.w;
      const e = S.edits[s.key] || {};
      s.carriageW = e.cw != null ? e.cw : Math.min(o.carriageW, Math.max(3, s.w - 2)); s.cwOffset = e.off != null ? e.off : 0;
      byId[s.id] = s;
    });
    // the kerb drawing is worked out on the streets as they will be created (the plan redraws them the same way, so the corner keys match):
    // returns at every junction, a bend of 30° or more is a corner too, and a corner of two streets has its outer radius
    const kd = PlanReserve.kerbDrawing(streets, this._kerbOpts(), c => { const m = S.returns[c.jkey]; return m && m[c.key] != null ? m[c.key] : null; });
    S.res = { rings, streets, junctions: kd.junctions, corners: kd.corners, kerbs: kd.kerbs, rev: T.rev, unpaired: r.unpaired.length };
    return S.res;
  },
  _R(c) { const m = this.stage.returns[c.jkey]; return m && m[c.key] != null ? m[c.key] : c.def; },
  // a radius changed: the kerb lines are cut back to the new tangent points
  // corner options of the kerb drawing; the Road plan (RoadReserve) turns bends and outer radii off: its roads keep the reserve's own centre line
  _kerbOpts() { const o = this.opt; return this.bendCorners === false ? { ret: o.ret, retWide: o.ret + 2, bend: 0, outer: false } : { ret: o.ret, retWide: o.ret + 2 }; },
  _rekerb() { const S = this.stage; if (!S || !S.res || !S.res.streets.length) return; S.res.kerbs = PlanReserve.kerbDrawing(S.res.streets, this._kerbOpts(), c => { const m = S.returns[c.jkey]; return m && m[c.key] != null ? m[c.key] : null; }).kerbs; },

  // ── clicks ──
  _tol(S) { return 10 * S.f / PlanEngine.view.zoom; },                // ten screen pixels, in metres
  down(pt, e) {
    const S = this.stage; if (!S) return; const f = S.f, m = [pt.x * f, pt.y * f], tol = this._tol(S), ev = e || {};
    if (!S.res || S.res.rev !== S.T.rev) this.compute();
    const h = this._handleAt(m, tol);
    if (h) {                                                           // a kerb return handle: drag it (Alt-click puts it back to the default)
      if (ev.altKey) { const mm = S.returns[h.jkey]; if (mm) { delete mm[h.key]; if (!Object.keys(mm).length) delete S.returns[h.jkey]; } this._rekerb(); this._sync(); return; }
      S.drag = h; return;
    }
    if (S.mode === 'draw') {
      const d = S.draft; if (d.length >= 3 && Math.hypot(m[0] - d[0][0], m[1] - d[0][1]) <= tol) { this._closeDraft(ev.altKey); return; }
      d.push(m); this._sync(); return;
    }
    if (S.mode === 'cut') {
      const d = S.cutDraft; if (d.length && Math.hypot(m[0] - d[d.length - 1][0], m[1] - d[d.length - 1][1]) <= tol) { this._finishCut(); return; }
      d.push(m); this._sync(); return;
    }
    if (ev.altKey || ev.shiftKey) {                                    // Alt-click a street: drop it
      const si = this._streetAt(m, tol * 1.4);
      if (si >= 0) { S.dropped.add(S.res.streets[si].key); UI.toast('Street dropped.', 'info', 1800); this.compute(); this._sync(); return; }
    }
    const op = ev.altKey || S.mode === 'sub' ? 'sub' : 'add', r = S.T.click(m, op);
    if (!r.ok) {
      const why = { 'not-enclosed': 'The road space runs out of the drawing here. Set a working area round the development, or draw a cut line across the road.', 'on-wall': 'That is on a line: click in the open space of the road.', outside: 'That is outside the drawing.', 'not-picked': 'Nothing picked there.' }[r.reason] || 'Nothing to pick there.';
      UI.toast(why, 'warn', 5000); return;
    }
    this.compute(); this._sync();
    const n = S.res.streets.length; UI.toast(op === 'add' ? `${n} street${n === 1 ? '' : 's'} so far.` : `Removed. ${n} street${n === 1 ? '' : 's'} left.`, 'info', 1800);
  },
  move(pt, e) {
    const S = this.stage; if (!S) return; const f = S.f, m = [pt.x * f, pt.y * f];
    if (S.drag) {
      const R = PlanReserve.radiusFromDrag(S.drag, m), c = S.drag; (S.returns[c.jkey] = S.returns[c.jkey] || {})[c.key] = +R.toFixed(1); this._rekerb(); PlanEngine.requestDraw({ fg: true }); return;
    }
    if (S.mode === 'draw' || S.mode === 'cut') { S.hover = m; PlanEngine.requestDraw({ fg: true }); return; }
    const h = S.res ? this._handleAt(m, this._tol(S)) : null, k = h ? h.jkey + h.key : '';
    if (k !== S._hk) { S._hk = k; S.hoverH = h; PlanEngine.requestDraw({ fg: true }); }
  },
  up() { const S = this.stage; if (S && S.drag) { S.drag = null; this._sync(); } },
  _handleAt(m, tol) {
    const S = this.stage; if (!S || !S.res) return null;
    for (const c of S.res.corners) { const a = PlanReserve.returnArc(c, this._R(c)); if (Math.hypot(a.mid[0] - m[0], a.mid[1] - m[1]) <= tol) return c; }
    return null;
  },
  _streetAt(m, tol) {
    const S = this.stage; if (!S.res) return -1; let bi = -1, bd = tol;
    S.res.streets.forEach((s, i) => { for (let k = 0; k + 1 < s.pts.length; k++) { const a = s.pts[k], b = s.pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2)) : 0, d = Math.hypot(m[0] - a[0] - dx * t, m[1] - a[1] - dy * t); if (d < bd) { bd = d; bi = i; } } });
    return bi;
  },
  _closeDraft(alt) {
    const S = this.stage; if (S.draft.length < 3) { S.draft = []; this._sync(); return; }
    S.T.polygon(S.draft, !!alt || false); S.draft = []; this.compute(); this._sync();
  },
  _finishCut() {
    const S = this.stage; if (S.cutDraft.length >= 2) { S.T.cut(S.cutDraft); S.res = null; this.compute(); UI.toast('Cut made. Alt-click (or Subtract) the part you want to drop.', 'info', 3500); }
    S.cutDraft = []; this._sync();
  },
  mode(m) { const S = this.stage; if (!S) return; S.mode = m; S.draft = []; S.cutDraft = []; this._sync(); },
  // Backspace: a corner back while drawing, else the last pick
  key(e) {
    const S = this.stage; if (!S) return false;
    if (e.key === 'Backspace') {
      if (S.mode === 'draw' && S.draft.length) { S.draft.pop(); this._sync(); return true; }
      if (S.mode === 'cut' && S.cutDraft.length) { S.cutDraft.pop(); this._sync(); return true; }
      if (S.T.undo()) { S.res = null; this.compute(); UI.toast('Last pick taken back.', 'info', 1500); this._sync(); } return true;
    }
    if (e.key === 'Enter') {
      if (S.mode === 'draw' && S.draft.length >= 3) { this._closeDraft(e.altKey); return true; }
      if (S.mode === 'cut' && S.cutDraft.length >= 2) { this._finishCut(); return true; }
      this.create(); return true;
    }
    if (e.key === 'Escape') {
      if (S.draft.length || S.cutDraft.length) { S.draft = []; S.cutDraft = []; this._sync(); return true; }
      this.cancel(); return true;
    }
    return false;
  },
  hint() {
    const S = this.stage; if (!S) return '';
    if (S.mode === 'draw') return 'Click the corners of the reserve · click the first corner or Enter to close · Backspace: last corner · Esc: stop drawing';
    if (S.mode === 'cut') return 'Click across the road to cut it · Enter or the last point again: finish · then Alt-click the part to drop';
    if (S.mode === 'sub') return 'Click a picked reserve to remove it · Alt-click a road: drop it · drag a corner handle: kerb return · Enter: create · Backspace: undo · Esc: leave';
    return 'Click inside a road reserve to add it · Alt-click: subtract · Alt-click a road: drop it · drag a corner handle: kerb return · Enter: create · Backspace: undo · Esc: leave';
  },

  // ── drawing on the plan ──
  draw(ctx, zoom) {
    const S = this.stage; if (!S) return; const f = S.f, u = 1 / zoom, R = S.res;
    const line = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] / f, p[1] / f) : ctx.moveTo(p[0] / f, p[1] / f)); ctx.stroke(); };
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (R && R.rings.length) {                                            // the picked road space
      ctx.beginPath(); for (const ring of R.rings) { ring.forEach((p, i) => i ? ctx.lineTo(p[0] / f, p[1] / f) : ctx.moveTo(p[0] / f, p[1] / f)); ctx.closePath(); }
      ctx.fillStyle = 'rgba(245,158,11,.18)'; ctx.fill('evenodd'); ctx.strokeStyle = 'rgba(180,83,9,.5)'; ctx.lineWidth = 1 * u; ctx.stroke();
    }
    ctx.setLineDash([6 * u, 4 * u]); ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2 * u;
    for (const c of S.T.cuts) line(c);
    ctx.setLineDash([]);
    if (R) {
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3 * u;
      R.streets.forEach(s => { line(s.pts); });
      ctx.lineWidth = 1.2 * u; ctx.strokeStyle = 'rgba(71,85,105,.9)';
      (R.kerbs || []).forEach(line);                                        // kerb lines, cut back to the returns
      for (const c of R.corners) {                                          // kerb returns (and the outer radius of a corner), with a handle at the middle of each inner arc
        const a = PlanReserve.returnArc(c, this._R(c)); ctx.strokeStyle = '#334155'; ctx.lineWidth = 2 * u; line(a.pts); if (a.outer) line(a.outer.pts);
        const hot = (S.drag && S.drag.key === c.key && S.drag.jkey === c.jkey) || (S.hoverH && S.hoverH.key === c.key && S.hoverH.jkey === c.jkey);
        ctx.fillStyle = hot ? '#2563eb' : '#fff'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5 * u;
        ctx.beginPath(); ctx.arc(a.mid[0] / f, a.mid[1] / f, 4 * u, 0, 6.2832); ctx.fill(); ctx.stroke();
        if (hot) { ctx.fillStyle = '#1e3a8a'; ctx.font = `${11 * u}px sans-serif`; ctx.fillText('R ' + a.R.toFixed(1) + ' m', a.mid[0] / f + 7 * u, a.mid[1] / f - 6 * u); }
      }
      ctx.fillStyle = '#92400e'; ctx.font = `${11 * u}px sans-serif`;
      R.streets.forEach(s => { const m = s.pts[s.pts.length >> 1]; ctx.fillText(s.wMin === s.wMax || Math.abs(s.wMax - s.wMin) < 0.6 ? s.w.toFixed(1) + ' m' : s.wMin.toFixed(1) + '–' + s.wMax.toFixed(1) + ' m', m[0] / f + 4 * u, m[1] / f - 4 * u); });
      ctx.fillStyle = '#f59e0b'; for (const j of R.junctions) { ctx.beginPath(); ctx.arc(j.x / f, j.y / f, 3 * u, 0, 6.2832); ctx.fill(); }
    }
    const dr = (pts, col, close) => {
      if (!pts.length) return; ctx.strokeStyle = col; ctx.lineWidth = 2 * u; ctx.setLineDash([5 * u, 4 * u]);
      const q = S.hover && pts.length ? pts.concat([S.hover]) : pts; line(close && pts.length > 2 ? q.concat([pts[0]]) : q); ctx.setLineDash([]);
      ctx.fillStyle = col; for (const p of pts) { ctx.beginPath(); ctx.arc(p[0] / f, p[1] / f, 3 * u, 0, 6.2832); ctx.fill(); }
    };
    dr(S.draft, '#2563eb', true); dr(S.cutDraft, '#dc2626', false);
    ctx.restore();
  },

  // ── the panel ──
  panelHtml(esc) {
    const S = this.stage; if (!S) return '';
    const R = S.res || this.compute(), o = this.opt, T = S.T, E = x => escHtml(x);
    const btn = (m, label) => `<button type="button" class="plan-btn" data-act="rs-mode" data-m="${m}" aria-pressed="${S.mode === m}" style="${S.mode === m ? 'font-weight:600;outline:2px solid #f59e0b' : ''}">${label}</button>`;
    const num = (k, label, min, max, step) => `<label style="font-size:12px;display:inline-flex;gap:4px;align-items:center">${label} <input type="number" data-ropt="${k}" min="${min}" max="${max}" step="${step}" value="${E(o[k])}" style="width:54px"></label>`;
    const ws = R.streets.map(s => s.w), wr = ws.length ? `${Math.min(...ws).toFixed(0)}–${Math.max(...ws).toFixed(0)} m` : '';
    const list = R.streets.slice(0, 120).map((s, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;border-bottom:1px solid var(--border,#ddd);padding:2px 0;font-size:12px"><span>${i + 1} · ${Math.round(PlanReserveUI._len(s.pts))} m · reserve ${s.w.toFixed(1)} m</span><span style="display:flex;gap:3px;align-items:center">c/w <input type="number" data-rsedit="cw" data-k="${E(s.key)}" min="2" max="40" step="0.5" value="${s.carriageW}" style="width:46px" title="Carriageway width (m)"> off <input type="number" data-rsedit="off" data-k="${E(s.key)}" min="-20" max="20" step="0.5" value="${s.cwOffset}" style="width:46px" title="Carriageway offset from the reserve centre (m, + = to the left looking along the road)"><button type="button" class="plan-btn" data-act="rs-drop" data-k="${E(s.key)}" style="padding:0 6px" title="Drop this street">×</button></span></div>`).join('');
    const dropped = S.dropped.size ? `<div style="font-size:12px">${S.dropped.size} street${S.dropped.size === 1 ? '' : 's'} dropped <button type="button" class="plan-btn" data-act="rs-restore" style="padding:0 6px">restore</button></div>` : '';
    return `<div style="border:2px solid #f59e0b;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;flex-direction:column;gap:5px">
      <b>Roads from road reserve</b>
      <div style="display:flex;gap:4px;flex-wrap:wrap">${btn('add', 'Add')}${btn('sub', 'Subtract')}${btn('draw', 'Draw')}${btn('cut', 'Cut')}<button type="button" class="plan-btn" data-act="rs-undo"${T.ops.length ? '' : ' disabled'} title="Backspace">Undo</button></div>
      <div style="font-size:12px;color:var(--text-muted)">Click inside a road reserve to add it. Alt-click a road drops it; Alt-click elsewhere subtracts. <b>Draw</b> a reserve the detection misses; <b>Cut</b> across a road to close an entrance or to separate a part to drop. Drag the handle on a kerb return to change its radius (Alt-click: back to the default).${S.hasWa ? '' : ' <b>No working area:</b> set one round the development so the road space is closed at its edge.'}${S.usedAll ? ' No line matched the layer filter, so every visible layer is used.' : ''}</div>
      <div><b>${R.streets.length}</b> street${R.streets.length === 1 ? '' : 's'}${wr ? ` (reserve ${wr})` : ''}, ${R.junctions.length} junction${R.junctions.length === 1 ? '' : 's'}${T.empty() ? '' : `, ${Math.round(T.areaM2()).toLocaleString('en')} m² of road space`}.</div>
      ${dropped}
      <details><summary style="font-size:12px;cursor:pointer">Settings</summary><div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
        <label style="font-size:12px;display:block">Layers (words in the layer name; blank = all)<input type="text" data-ropt="layers" value="${E(o.layers)}" style="width:100%"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${num('carriageW', 'Carriageway (m)', 2, 30, 0.5)}${num('ret', 'Kerb return (m)', 1, 30, 0.5)}${num('wmax', 'Widest reserve (m)', 10, 80, 1)}${num('step', 'Raster step (m)', 0.1, 2, 0.1)}${num('gapM', 'Close gaps up to (m)', 0, 5, 0.1)}</div>
        <div style="font-size:12px;color:var(--text-muted)">Changing the layers, step or gap rebuilds the picked space from the same clicks.</div></div></details>
      ${R.streets.length ? `<details><summary style="font-size:12px;cursor:pointer">Roads (${R.streets.length}): carriageway width and offset</summary><div style="max-height:200px;overflow:auto">${list}${R.streets.length > 120 ? '<div style="font-size:12px">… the first 120 are listed.</div>' : ''}</div></details>` : ''}
      <div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-act="rs-create" style="font-weight:600"${R.streets.length ? '' : ' disabled'}>Create ${R.streets.length} street${R.streets.length === 1 ? '' : 's'}</button><button type="button" class="plan-btn" data-act="rs-cancel">Cancel</button></div></div>`;
  },
  _len(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; },
  act(b) {
    const a = b.dataset.act, S = this.stage; if (!a.startsWith('rs-')) return false;
    if (a === 'rs-start') this.start();
    else if (!S) return true;
    else if (a === 'rs-mode') this.mode(b.dataset.m);
    else if (a === 'rs-undo') { if (S.T.undo()) { S.res = null; this.compute(); } this._sync(); }
    else if (a === 'rs-cancel') this.cancel();
    else if (a === 'rs-create') this.create();
    else if (a === 'rs-drop') { S.dropped.add(b.dataset.k); this.compute(); this._sync(); }
    else if (a === 'rs-restore') { S.dropped.clear(); this.compute(); this._sync(); }
    return true;
  },
  change(t) {                                                         // the panel's inputs
    const S = this.stage; if (!S) return false;
    if (t.dataset.ropt) {
      const k = t.dataset.ropt; if (k === 'layers') this.opt.layers = t.value; else { const v = parseFloat(t.value); if (!isFinite(v)) return true; this.opt[k] = v; }
      if (k === 'layers' || k === 'step' || k === 'gapM') this.restart(); else { this.compute(); this._sync(); }
      return true;
    }
    if (t.dataset.rsedit) {
      const v = parseFloat(t.value); if (!isFinite(v)) return true; const e = S.edits[t.dataset.k] = S.edits[t.dataset.k] || {};
      if (t.dataset.rsedit === 'cw') e.cw = Math.max(2, v); else e.off = v;
      this.compute(); this._sync(); return true;
    }
    return false;
  },

  // ── Create ──
  _ask(n) {                                                           // replace / add / cancel
    return new Promise(res => {
      const ov = document.createElement('div'); ov.className = 'modal ui-dialog'; ov.style.zIndex = '3000';
      ov.innerHTML = `<div class="modal-content ui-dialog-content" role="dialog" aria-modal="true"><div class="modal-header"><h3>Roads already on this floor</h3></div><div class="modal-body"><p>This floor already has ${n} street${n === 1 ? '' : 's'}. Replace all of them with the new roads, or add the new ones (their ends join the existing roads)?</p></div><div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:8px 12px"><button type="button" class="btn" data-v="cancel">Cancel</button><button type="button" class="btn" data-v="add">Add to them</button><button type="button" class="btn btn-primary" data-v="replace">Replace all</button></div></div>`;
      ov.classList.add('visible'); document.body.appendChild(ov);
      ov.addEventListener('click', ev => { const v = ev.target.closest && ev.target.closest('[data-v]'); if (v) { ov.remove(); res(v.dataset.v); } });
    });
  },
  async create() {
    const S = this.stage; if (!S) return 0; if (!S.res || S.res.rev !== S.T.rev) this.compute();
    const R = S.res, pm = AppState.planMarkup, f = S.f;
    if (!R.streets.length) { UI.toast('No roads to create.', 'warn', 3000); return 0; }
    const existing = pm.routes.filter(r => r.type === 'street'); let choice = 'replace';
    if (existing.length) { choice = await this._ask(existing.length); if (choice === 'cancel') return 0; }
    const d = PlanDxfImport.list().find(x => !x.hidden), data = d && PlanDxfImport.dataOf(d), namer = data ? PlanLayoutUI._namer(data, d, f) : (() => null);
    PlanMarkup.snapshot();
    if (choice === 'replace') for (let i = pm.routes.length - 1; i >= 0; i--) if (pm.routes[i].type === 'street') pm.routes.splice(i, 1);
    const made = [], base = pm.routes.filter(r => r.type === 'street').length; let named = 0;
    R.streets.forEach((s, i) => {
      const wp = s.pts.map(q => ({ x: q[0] / f, y: q[1] / f })), nm = namer(wp); if (nm) named++;
      const r = { id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: wp, cableType: '', curved: false,
        props: { name: nm || 'Street ' + (base + i + 1), width: s.w, reserveProfile: s.ws, carriageW: s.carriageW, cwOffset: s.cwOffset, auto: 'reserve' } };
      pm.routes.push(r); made.push(r);
    });
    if (choice === 'add' && existing.length && typeof PlanKerbs !== 'undefined') {                    // the new ends run on to the streets that are already there
      const all = pm.routes.filter(r => r.type === 'street' && r.points.length >= 2), arr = all.map(r => ({ pts: r.points.map(p => [p.x * f, p.y * f]), w: +(typeof RoadSections !== 'undefined' ? RoadSections.reserveOf(r.props).w : +(r.props && r.props.width)) || 12, chains: [] }));
      all.forEach((r, k) => { if (made.includes(r)) PlanKerbs.attach(arr, k, { gap: 15 }); });
      all.forEach((r, k) => { if (arr[k].pts.length !== r.points.length || made.includes(r)) r.points = arr[k].pts.map(p => ({ x: p[0] / f, y: p[1] / f })); });
    }
    const L = PlanLayoutUI.cfg(), ret = Object.assign({}, choice === 'replace' ? {} : (L.streetReturns || {}));
    for (const [j, m] of Object.entries(S.returns)) ret[j] = Object.assign({}, ret[j] || {}, m);
    if (Object.keys(ret).length) L.streetReturns = ret; else delete L.streetReturns;
    this.stage = null;
    PlanMarkup.markDirty(); PlanLayoutUI.touched(); PlanLayoutUI.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`${made.length} street${made.length === 1 ? '' : 's'} made from the road reserve${named < made.length ? ` (${made.length - named} without a name nearby: check them)` : ''}, each with its reserve width and a carriageway.`, named < made.length ? 'warn' : 'success', 8000);
    return made.length;
  },

  // ── streets on the plan: kerb lines and returns of every street that has a carriageway ──
  _geo: { sig: '', g: null },
  planGeometry() {
    const pm = AppState.planMarkup, f = PlanEngine.factor(); if (!f || typeof PlanReserve === 'undefined') return null;
    const RS = typeof RoadSections !== 'undefined' ? RoadSections : null;
    const cwOf = props => RS ? RS.carriage(props) : { cw: +props.carriageW || 0, off: +props.cwOffset || 0 };
    // each road as its pieces: a stretch with another section is drawn like a road of its own meeting the rest end to end (the kerbs taper)
    const parts = [];
    for (const r of pm.routes) {
      if (r.type !== 'street' || !r.props || !r.points || r.points.length < 2) continue;
      const ps = RS ? RS.pieces(r, f) : [{ pts: r.points, props: r.props }];
      for (const q of ps) { const c = cwOf(q.props); if (c.cw > 0 && q.pts.length >= 2) parts.push({ r, pts: q.pts, cw: c.cw, off: c.off }); }
    }
    if (!parts.length) return null;
    const rets = ((pm.settings || {}).layout || {}).streetReturns || {};
    const sig = parts.map(({ r, pts, cw, off }) => r.id + ':' + pts.length + ':' + pts.map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(';') + ':' + cw + ':' + off + ':' + (RS ? RS.reserveOf(r.props).w : +(r.props && r.props.width))).join('|') + '#' + f + JSON.stringify(rets);
    if (this._geo.sig === sig) return this._geo.g;
    const list = parts.map(({ r, pts, cw, off }) => ({ rid: r.id, pts: pts.map(p => [p.x * f, p.y * f]), w: +(RS ? RS.reserveOf(r.props).w : +(r.props && r.props.width)) || 12, carriageW: cw, cwOffset: off }));
    // kerb lines cut back to the returns; a corner of two streets (or a bend of one) also gets its outer radius
    const d = PlanReserve.kerbDrawing(list, { ret: 8, retWide: 10 }, c => { const m = rets[c.jkey]; return m && m[c.key] != null ? m[c.key] : null; });
    // the inner returns as geometry (metres) for Auto layout: the square kerb corner P, the arc's centre and radius and its tangent points; the
    // rounded-off corner between the arc and P is road
    const fills = d.arcs.filter(a => !a.outer).map(a => { const x = PlanReserve.returnArc(a.c, a.R); return { P: a.c.P.slice(), c: x.centre.slice(), R: x.R, t1: x.t1.slice(), t2: x.t2.slice() }; });
    const g = { f, kerbs: d.kerbs, arcs: d.arcs.map(a => a.pts), rets: fills }; this._geo = { sig, g }; return g;
  },
  drawPlanStreets(ctx, zoom) {
    const g = this.planGeometry(); if (!g) return; const f = g.f;
    ctx.save(); ctx.strokeStyle = 'rgba(71,85,105,.75)'; ctx.lineWidth = 1 / zoom; ctx.lineJoin = 'round';
    const line = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] / f, p[1] / f) : ctx.moveTo(p[0] / f, p[1] / f)); ctx.stroke(); };
    for (const k of g.kerbs) line(k);
    for (const a of g.arcs) line(a);
    ctx.restore();
  },
};
