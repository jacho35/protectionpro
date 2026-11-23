/* ProtectionPro — Re-route from a kiosk or manhole (Plan, after Auto layout's Create).
 *
 * Select a kiosk or manhole the Auto layout created → Properties (or right-click) → Re-route from here…
 * Only that node's own cables are laid again: a kiosk's services to the erven it already serves and the LV
 * cables in / out of it; a manhole's erf ducts and the trunk ducts in / out of it. Which erven it serves
 * never changes, no kiosk or manhole moves, nothing else on the plan changes.
 *
 * How: PlanLayout.solve runs with every kiosk / manhole on the plan as the only stands (`fixedKiosks`,
 * `fixedMhs`), each erf kept on the kiosk / manhole its drawn service / duct comes from (`fixAssign`,
 * `mhAssign`), its marker where the erf point is now and its fibre point where its duct ends — the same
 * rules as the layout (corridors, street sides, shared crossings). From that result only the selected
 * node's runs are taken. A run edited by hand after Create (its points no longer match the signature
 * Create / Apply wrote, `lsig`) or drawn by hand is listed and kept unless you choose Replace.
 * The crossing ducts near the changed runs are brought into line (auto ones only); trenches are left.
 * Preview first (now = grey, after = dashed blue, kept by hand = orange); Apply is one undo step.
 */

const PlanReroute = {
  session: null,
  CAP: { service: 4, fibre: 4, LV: 2 },                     // runs one 110 mm crossing duct takes (as Auto layout lays them)
  USE: { service: 'service', fibreErf: 'fibre', fibreBB: 'fibre', lv: 'LV' },

  sig(points) { return (points || []).map(p => (+p.x).toFixed(2) + ',' + (+p.y).toFixed(2)).join(';'); },
  handEdited(rt) { return !rt || rt.auto !== 'layout' || (!!rt.lsig && rt.lsig !== this.sig(rt.points)); },
  can(item) {
    return !!(item && item.auto === 'layout' && (item.type === 'kiosk' || item.type === 'manhole') && typeof PlanLayout !== 'undefined' && typeof PlanLayoutUI !== 'undefined' && PlanEngine.factor());
  },
  _pm() { return AppState.planMarkup; },
  _el(id) { return this._pm().elements.find(e => e.id === id); },
  _between(type, a, b) { return this._pm().routes.filter(r => r.type === type && ((r.fromId === a && r.toId === b) || (r.fromId === b && r.toId === a))); },
  _len(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; },

  // ── the Properties panel block of a created kiosk / manhole ──
  propsHtml(item) {
    if (!this.can(item)) return '';
    const f = PlanEngine.factor(), k = item.type === 'kiosk', type = k ? 'service' : 'fibreErf';
    const runs = this._pm().routes.filter(r => r.type === type && (r.fromId === item.id || r.toId === item.id));
    const m = Math.round(runs.reduce((s, r) => s + this._len(r.points), 0) * f);
    return `<div style="margin:10px 0;padding:10px;border:1px solid var(--border);border-radius:6px">
      <div style="font-weight:600;margin-bottom:4px">Auto layout</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${runs.length} ${k ? 'service' : 'erf duct'}${runs.length === 1 ? '' : 's'} · ${m} m. Lay this ${k ? 'kiosk' : 'manhole'}'s cables again with the layout's own rules: the erven it serves stay the same and nothing else on the plan moves.</div>
      <button type="button" class="plan-btn" data-rr="start" data-id="${escHtml(item.id)}" style="width:100%">Re-route from here…</button>
      <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Want it somewhere else? Drag it first, then re-route.</div></div>`;
  },

  // ── build the proposal ──
  start(id) {
    const el = this._el(id); if (!this.can(el)) return;
    const pm = this._pm(), f = PlanEngine.factor();
    const g = PlanLayoutUI.gather(true); if (g.err) { UI.toast(g.err, 'warn', 6000); return; }
    const input = g.input, params = Object.assign({}, g.params, { kmode: 'opt', knet: true });
    input.crossings = PlanLayoutUI.planCrossings(null);                                 // every crossing on the plan is used first
    const { kiosks, mhEls, mIdx, erf } = PlanLayoutUI.fixFromPlan(input, { kiosks: true, mhs: true });
    let res;
    try { res = PlanLayout.solve(input, params); PlanLayout.keepOut(res); PlanLayout.smooth(res, params); }
    catch (err) { console.error(err); UI.toast('The re-route could not be worked out: ' + (err.message || err), 'error', 6000); return; }
    const W = q => ({ x: q[0] / f, y: q[1] / f }), at = (o, list) => { let b = null, d = 3; for (const x of list) { const dd = Math.hypot(o.x - x.x * f, o.y - x.y * f); if (dd < d) { d = dd; b = x; } } return b; };
    const items = [];
    const add = (group, type, aId, bId, pts, label) => {
      const olds = this._between(type, aId, bId), old = olds[0] || null;
      let P = pts.map(W);
      // the run is drawn from its route's `fromId` end: turn it round when the layout lays it the other way
      const from = this._el(old ? old.fromId : aId);
      if (from && P.length > 1 && Math.hypot(P[P.length - 1].x - from.x, P[P.length - 1].y - from.y) < Math.hypot(P[0].x - from.x, P[0].y - from.y)) P = P.reverse();
      items.push({ group, type, aId, bId, label, old, pts: P, hand: !!old && this.handEdited(old), keep: true });
    };
    if (el.type === 'kiosk') {
      const K = res.kiosks.find(k => Math.hypot(k.x - el.x * f, k.y - el.y * f) < 3);
      if (!K) { UI.toast('This kiosk could not be found again on the street layout. Is it still on a street the layout uses?', 'warn', 6000); return; }
      res.erven.forEach(e => { if (e.kiosk === K && e.route && erf.has(e.id)) { const pts = e.route.slice(); add('svc', 'service', el.id, e.id, pts, 'Erf ' + (erf.get(e.id).name || e.id)); } });
      const nodeEl = o => {                                                              // a kiosk or a mini-sub of the result → its part on the plan
        if (res.kiosks.includes(o)) return at(o, kiosks);
        return at(o, pm.elements.filter(e => e.type === 'minisub'));
      };
      ((res.net && res.net.lvLinks) || []).forEach(l => {
        if (l.from !== K && l.to !== K) return;
        const other = l.from === K ? l.to : l.from, oe = nodeEl(other); if (!oe) return;
        const Sb = (res.net.subs || []).find(x => x.k === l.from), pts = Sb ? [[oe.x * f, oe.y * f], ...l.pts.slice(1)] : l.pts;
        if (!this._between('lv', el.id, oe.id).length) return;                          // the layout would link it differently: left as it is
        add(l.to === K ? 'lvIn' : 'lvOut', 'lv', el.id, oe.id, pts, (l.to === K ? 'LV in from ' : 'LV out to ') + (oe.name || oe.type));
      });
    } else {
      // a manhole of the result carries the index of the plan manhole it was pinned from (`pidx`); a junction node is found by where it is
      const mres = [...(res.fibre.inter || []), ...(res.fibre.mhs || [])], me = mIdx.get(el.id);
      const Mh = (res.fibre.mhs || []).find(m => m.pidx === me) || mres.find(m => m.pidx == null && Math.hypot(m.x - el.x * f, m.y - el.y * f) < 3);
      const mhEl = o => o.pidx != null ? mhEls[o.pidx] : at(o, mhEls);
      if (!Mh) { UI.toast('This manhole could not be found again on the fibre layout.', 'warn', 6000); return; }
      res.erven.forEach(e => { if (e.mh === Mh && e.duct && erf.has(e.id)) add('duct', 'fibreErf', el.id, e.id, e.duct.slice(), 'Erf ' + (erf.get(e.id).name || e.id)); });
      (res.fibre.trunks || []).forEach(t => {
        if (t.a !== Mh && t.b !== Mh) return;
        const other = t.a === Mh ? t.b : t.a, oe = mhEl(other); if (!oe || !this._between('fibreBB', el.id, oe.id).length) return;
        add('trunk', 'fibreBB', el.id, oe.id, t.pts.slice(), 'Trunk to ' + (oe.name || 'manhole'));
      });
    }
    if (!items.length) { UI.toast('Nothing to lay again from here: none of its runs could be matched.', 'warn', 5000); return; }
    const on = {}; items.forEach(i => { on[i.group] = true; });
    this.session = { id, name: el.name || el.type, kind: el.type, items, on, maxc: +params.maxc || 0 };
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  cancel() { this.session = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  _live(i) { const S = this.session; return S.on[i.group] && !(i.hand && i.keep); },

  // ── figures: before / after over the runs offered ──
  _streets() { return this._pm().routes.filter(r => r.type === 'street' && r.points && r.points.length >= 2).map(r => PlanLayoutUI._flat(r)); },
  _xpts(pts, streets) {
    const out = [], X = (a, b, c, d) => { const r = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x); if (Math.abs(r) < 1e-12) return null; const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / r, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / r; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), a, b } : null; };
    for (let i = 1; i < pts.length; i++) for (const s of streets) for (let j = 1; j < s.length; j++) { const p = X(pts[i - 1], pts[i], s[j - 1], s[j]); if (p) out.push(p); }
    return out;
  },
  _clusters(points, tol) { const cl = []; for (const p of points) { const c = cl.find(q => Math.hypot(q.x - p.x, q.y - p.y) <= tol); if (c) c.n++; else cl.push({ x: p.x, y: p.y, n: 1, a: p.a, b: p.b }); } return cl; },
  figures() {
    const S = this.session, f = PlanEngine.factor(), st = this._streets(), tol = 3 / f, out = {};
    const runs = (after, grp) => S.items.filter(i => grp.includes(i.group) && S.on[i.group]).map(i => after && this._live(i) ? i.pts : (i.old ? i.old.points : null)).filter(Boolean);
    const sum = (after, grp) => { const R = runs(after, grp); return { len: R.reduce((s, p) => s + this._len(p), 0) * f, max: R.reduce((m, p) => Math.max(m, this._len(p)), 0) * f, xs: this._clusters(R.flatMap(p => this._xpts(p, st)), tol).length }; };
    const main = S.kind === 'kiosk' ? ['svc'] : ['duct'], link = S.kind === 'kiosk' ? ['lvIn', 'lvOut'] : ['trunk'];
    out.main = [sum(false, main), sum(true, main)]; out.link = [sum(false, link), sum(true, link)];
    out.xs = [sum(false, [...main, ...link]).xs, sum(true, [...main, ...link]).xs];
    return out;
  },

  // ── the panel while a re-route is previewed ──
  renderPanel(el) {
    const S = this.session, k = S.kind === 'kiosk', F = this.figures(), m = v => Math.round(v) + ' m';
    const groups = k ? [['svc', 'Services to its'], ['lvIn', 'LV cable in'], ['lvOut', 'LV cable out']] : [['duct', 'Erf ducts to its'], ['trunk', 'Trunk ducts in / out']];
    const cnt = g => S.items.filter(i => i.group === g).length;
    const box = groups.filter(([g]) => cnt(g)).map(([g, t]) => `<label style="display:flex;gap:8px;align-items:center;min-height:30px"><input type="checkbox" data-rr-on="${g}" ${S.on[g] ? 'checked' : ''}> ${t}${g === 'svc' || g === 'duct' ? ` ${cnt(g)} erven` : g === 'trunk' ? ` (${cnt(g)})` : ' · ' + escHtml(S.items.find(i => i.group === g).label.replace(/^LV (in from|out to) /, ''))}</label>`).join('');
    const hand = S.items.map((i, n) => [i, n]).filter(([i]) => i.hand && S.on[i.group]);
    const handHtml = hand.length ? `<div style="margin:10px 0;padding:10px;border:1px solid #f5c9a8;background:#fff8f2;border-radius:6px;color:#1b1f24">
        <div style="font-weight:600;margin-bottom:6px">Edited by hand (${hand.length})</div>
        ${hand.map(([i, n]) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0"><span>${escHtml(i.label)}${i.old && i.old.auto !== 'layout' ? ' · drawn by hand' : ''}</span>
          <span role="radiogroup" aria-label="${escHtml(i.label)}" style="display:flex;gap:6px"><label><input type="radio" name="rr${n}" data-rr-keep="${n}" value="1" ${i.keep ? 'checked' : ''}> Keep</label><label><input type="radio" name="rr${n}" data-rr-keep="${n}" value="0" ${i.keep ? '' : 'checked'}> Replace</label></span></div>`).join('')}
        <div style="font-size:12px;color:#6b3a16;margin-top:4px">A kept run stays exactly as it is and still counts in the figures.</div></div>` : '';
    const over = S.maxc && F.main[1].max > S.maxc + 0.5 && k;
    const row = (t, a, b) => `<tr><td style="padding:4px 0;color:var(--text-muted)">${t}</td><td style="padding:4px 0;text-align:right">${a} → <b>${b}</b></td></tr>`;
    const nm = k ? 'Service cable' : 'Erf duct', ln = k ? 'LV in + out' : 'Trunk in + out';
    el.innerHTML = `<div class="plan-props-title">Re-route from ${escHtml(S.name)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Preview: nothing has changed yet. Now = grey, after = dashed blue, kept by hand = orange. Esc cancels.</div>
      <div style="font-weight:600;margin:6px 0 2px">Lay again</div>${box}
      <div style="font-size:12px;color:var(--text-muted);margin:8px 0">Stays as it is: which erven ${escHtml(S.name)} serves, its position${k ? '' : ', the fibre point on each erf'}, and every other part of the plan. Same rules as Auto layout: corridors, street sides, shared crossings.</div>
      ${handHtml}
      <div style="font-weight:600;margin:10px 0 2px">Before → after</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>
        ${row(nm, m(F.main[0].len), m(F.main[1].len))}
        ${k ? row('Longest service', m(F.main[0].max), m(F.main[1].max)) : ''}
        ${row('Road crossings', F.xs[0], F.xs[1])}
        ${F.link[0].len || F.link[1].len ? row(ln, m(F.link[0].len), m(F.link[1].len)) : ''}
      </tbody></table>
      ${over ? `<div style="margin-top:8px;padding:8px;border-radius:6px;background:#fffbeb;color:#78350f;font-size:12px">The longest service is over the ${Math.round(S.maxc)} m limit. A re-route does not move the kiosk: drag it closer, then re-route again.</div>` : ''}
      <div style="font-size:12px;color:var(--text-muted);margin-top:8px">Crossing ducts near the changed runs follow them; trenches are not redrawn, so check the trench along an old run.</div>
      <div style="display:flex;gap:8px;margin-top:12px"><button type="button" class="plan-btn" data-rr="cancel" style="flex:1">Cancel</button><button type="button" class="plan-btn" data-rr="apply" style="flex:2;background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-weight:600">Apply · one undo step</button></div>`;
  },

  // ── preview on the plan ──
  draw(ctx, zoom) {
    const S = this.session; if (!S) return;
    const u = 1 / zoom, line = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); };
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const i of S.items) { if (!S.on[i.group] || !i.old || !this._live(i)) continue; ctx.strokeStyle = 'rgba(148,153,163,.55)'; ctx.lineWidth = 6 * u; line(i.old.points); }
    for (const i of S.items) { if (!S.on[i.group] || !(i.hand && i.keep) || !i.old) continue; ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 3 * u; line(i.old.points); }
    ctx.setLineDash([7 * u, 5 * u]);
    for (const i of S.items) { if (!this._live(i)) continue; ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 2.4 * u; line(i.pts); }
    ctx.setLineDash([]);
    const el = this._el(S.id); if (el) { ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 2.5 * u; ctx.beginPath(); ctx.arc(el.x, el.y, 18 * u, 0, 6.2832); ctx.stroke(); }
    ctx.restore();
  },

  // ── apply: the runs, then the crossing ducts near them ──
  apply() {
    const S = this.session; if (!S) return;
    const pm = this._pm(), f = PlanEngine.factor(), live = S.items.filter(i => this._live(i));
    if (!live.length) { this.cancel(); return; }
    const touched = [];
    for (const i of live) {
      if (i.old) touched.push(...this._xpts(i.old.points, this._streets()).map(p => Object.assign(p, { use: this.USE[i.type] })));
      if (i.old) { i.old.points = i.pts.map(p => ({ x: p.x, y: p.y })); i.old.curved = false; i.old.lsig = this.sig(i.old.points); }
      else {
        const rt = { id: AppState.planGenId('pmrt'), type: i.type, fromId: i.aId, toId: i.bId, points: i.pts.map(p => ({ x: p.x, y: p.y })), cableType: PLAN_DEFS.defaults(i.type).cableType || '', curved: false, props: {}, auto: 'layout' };
        rt.lsig = this.sig(rt.points); pm.routes.push(rt);
      }
      touched.push(...this._xpts(i.pts, this._streets()).map(p => Object.assign(p, { use: this.USE[i.type] })));
    }
    const xc = this._syncCrossings(touched, f);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    const n = live.length, nm = S.name;
    this.session = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`Re-routed ${nm}: ${n} run${n === 1 ? '' : 's'} laid again${xc.added || xc.removed ? `; crossing ducts +${xc.added} / −${xc.removed}` : ''}. Ctrl+Z undoes it.`, 'success', 7000);
  },

  // At each crossing place the changed runs went over (before or after): as many 110 mm ducts per use as the runs crossing there need
  // (CAP per duct); an auto-layout duct no run uses any more goes, a missing one is added beside the others. Hand-drawn ducts are never touched.
  _segD(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); },
  _syncCrossings(touched, f) {
    const pm = this._pm(), st = this._streets(), tol = 3 / f, res = { added: 0, removed: 0 };
    for (const use of new Set(touched.map(t => t.use))) {
      const types = Object.keys(this.USE).filter(k => this.USE[k] === use);
      const all = pm.routes.filter(r => types.includes(r.type)).flatMap(r => this._xpts(r.points, st));
      for (const P of this._clusters(touched.filter(t => t.use === use), tol)) {
        const n = all.filter(q => Math.hypot(q.x - P.x, q.y - P.y) <= tol).length, need = Math.ceil(n / (this.CAP[use] || 4));
        const here = pm.crossings.filter(c => c.use === use && this._segD(P, c.p1, c.p2) <= 4 / f);
        for (let k = here.length - 1; k >= 0 && here.length > need; k--) {
          if (here[k].auto !== 'layout') continue; pm.crossings.splice(pm.crossings.indexOf(here[k]), 1); here.splice(k, 1); res.removed++;
        }
        if (here.length >= need) continue;
        const near = pm.crossings.filter(c => this._segD(P, c.p1, c.p2) <= 4 / f), grp = near[0] && near[0].trench;
        const run = all.find(q => Math.hypot(q.x - P.x, q.y - P.y) <= tol) || P, dx = run.b.x - run.a.x, dy = run.b.y - run.a.y, L = Math.hypot(dx, dy) || 1;
        const half = 6 / f, nx = -dy / L, ny = dx / L;
        for (let k = here.length; k < need; k++) {
          const off = (near.length + k - here.length) * 0.6 / f, c = { x: P.x + nx * off, y: P.y + ny * off };
          pm.crossings.push({ id: AppState.planGenId('pmcr'), name: PlanMarkup.nextCounter('_crossing', 'RC'), size: '110', use, trench: grp || ('R' + Date.now().toString(36)), p1: { x: c.x - dx / L * half, y: c.y - dy / L * half }, p2: { x: c.x + dx / L * half, y: c.y + dy / L * half }, auto: 'layout' });
          res.added++;
        }
      }
    }
    return res;
  },

  init() {
    if (this._bound) return; this._bound = true;
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-rr]'); if (!b) return;
      if (b.dataset.rr === 'start') this.start(b.dataset.id);
      else if (b.dataset.rr === 'cancel') this.cancel();
      else if (b.dataset.rr === 'apply') this.apply();
    });
    document.addEventListener('change', e => {
      const S = this.session; if (!S) return;
      const t = e.target;
      if (t.dataset.rrOn) { S.on[t.dataset.rrOn] = t.checked; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
      else if (t.dataset.rrKeep != null) { S.items[+t.dataset.rrKeep].keep = t.value === '1'; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
    });
  },
};
PlanReroute.init();
