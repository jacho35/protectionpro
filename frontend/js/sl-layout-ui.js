/*
 * SLLayoutUI — the site plan's Street lighting layout (Detect group, tool `sllayout`): the cable reticulation of the street lights.
 * Four steps in the Properties panel (`renderOptions`):
 *   1 Poles   — every street-light pole on the plan (drawn, placed here, or sent from the Road plan), each matched to a side of a road;
 *               *Place poles along roads* (`draftPoles` / `placePoles`, SLLayout.polesAlong): the roads clicked on the plan (none = all),
 *               a spacing, one side / both / staggered, a distance from the centre (blank = the road section's lighting-design pole,
 *               else 1 m behind the kerb); poles `auto: 'slp'` with `roadId`, replaced (unless wired) by the next placing on that road;
 *   2 Feeds   — the kiosks / mini-subs that feed them (click one on the plan to tick it), and new kiosks (click empty ground; Alt-click
 *               takes one away). While open the poles take the colour of the feed they would go to;
 *   3 Rules   — `planMarkup.settings.slLayout`: phases (3Φ R-W-B / 1Φ), trench (share the LV trench at the road section's LV line, or
 *               its own SL trench along the pole line), switching (photocell + contactor at the source / photocell per pole), volt drop,
 *               cable sizes, the most poles per circuit, cut-out and earth at each pole, the longest feeder;
 *   4 Review  — the circuits from the street-light engine (`/analysis/street-lighting/split`): each road side its own string, split
 *               where the checks run out, on the smallest cable and breaker that pass; checks; Create.
 * The planning is SLLayout (sl-layout.js, pure). Create writes plan items tagged `auto: 'sl'` (replaced by the next Create): new
 * kiosks, `sl` routes feed → pole → pole (with their cable), LV/SL trenches (shared mode: only where no LV trench runs) and a road
 * crossing duct where a feeder crosses; then Demand gets the new kiosks (PlanSync), the circuits are made from the routes
 * (StreetLight._planCore — the same as Sync from plan) and each takes its cable, breaker, phases, switching and pole items
 * (`slAuto: true`).
 */
const SLLayoutUI = {
  _active: false,
  step: 1,
  pend: [],            // new kiosks placed in Feeds (plan px), until Create
  roadPick: new Set(), // roads picked in Poles for *Place poles along roads* (none = every road)
  pp: { spacing: null, arr: 'A', off: null }, // that placement's spacing, arrangement, distance from the centre (null = from the road)
  result: null,        // the last Run: { plan, circuits, unassigned, at }
  busy: false,
  COLORS: ['#2563eb', '#0b6e6e', '#7c3aed', '#b4501c', '#be185d', '#15803d', '#a16207', '#0369a1', '#9333ea', '#c2410c'],

  pm() { return AppState.planMarkup; },
  f() { return PlanEngine.factor(); },
  cfg() {
    const st = this.pm().settings || (this.pm().settings = {});
    const d = typeof StreetLight !== 'undefined' && StreetLight.data ? StreetLight.defaults : {};
    st.slLayout = Object.assign({ system: d.system === '1ph' ? '1ph' : '3ph', trench: 'share', switching: 'contactor', vdLimit: null, minSize: 10, maxSize: 0, cond: 'Cu',
      maxPoles: 0, cutout: true, earth: true, maxFeedM: 500, feeds: null, relay: false }, st.slLayout || {});
    return st.slLayout;
  },
  esc(v) { return escHtml(v == null ? '' : String(v)); },
  f2(v) { return (Math.round(v * 100) / 100).toFixed(2); },

  // ───────── what is on the plan ─────────
  allPoles() { return this.pm().elements.filter(e => e.type === 'pole'); },
  // poles on a street-light route drawn by hand: left alone unless *Re-lay hand-drawn cables too* (`relay`)
  handRoutes() { return this.pm().routes.filter(r => r.type === 'sl' && r.auto !== 'sl'); },
  handPoles() { const ids = new Set(); for (const r of this.handRoutes()) { if (r.fromId) ids.add(r.fromId); if (r.toId) ids.add(r.toId); } return new Set(this.allPoles().filter(e => ids.has(e.id)).map(e => e.id)); },
  poleEls() { if (this.cfg().relay) return this.allPoles(); const h = this.handPoles(); return this.allPoles().filter(e => !h.has(e.id)); },
  sourceEls() { return this.pm().elements.filter(e => e.type === 'kiosk' || e.type === 'minisub'); },
  ticked() { const c = this.cfg(), all = this.sourceEls(); return c.feeds ? all.filter(e => c.feeds.includes(e.id)) : all; },
  streetRoutes() { return this.pm().routes.filter(r => r.type === 'street' && r.points && r.points.length >= 2); },
  _streets() {
    const f = this.f(), share = this.cfg().trench === 'share', RS = typeof RoadSections !== 'undefined' ? RoadSections : null;
    return this.streetRoutes().map(r => {
      let corr = null;
      if (share && RS) { const w = RS.reserveOf(r.props).w, sec = RS.of(r), lv = sec ? RS.sizes(sec, 'off').lv : null; if (w > 0 && lv != null && w / 2 - lv > 0.3) corr = w / 2 - lv; }
      return { id: r.id, name: (r.props && r.props.name) || 'Road', pts: r.points.map(p => [p.x * f, p.y * f]), corr };
    });
  },
  _feeds() {
    const f = this.f();
    return this.ticked().map(e => ({ id: e.id, x: e.x * f, y: e.y * f, name: e.name || e.type, el: e }))
      .concat(this.pend.map((p, i) => ({ id: 'new:' + i, x: p.x * f, y: p.y * f, name: `New kiosk ${i + 1}`, el: null, pend: i })));
  },
  // the planner's answer for what is on the plan now (cached on its inputs)
  preview() {
    const f = this.f(); if (!f) return null;
    const poles = this.poleEls().map(e => ({ id: e.id, x: e.x * f, y: e.y * f })), streets = this._streets(), feeds = this._feeds();
    const key = JSON.stringify([poles, streets.map(s => [s.pts, s.corr]), feeds.map(x => [x.id, x.x, x.y]), this.cfg().maxFeedM]);
    if (this._pv && this._pv.key === key) return this._pv.plan;
    const plan = SLLayout.plan({ poles, streets, feeds: feeds.map(x => ({ id: x.id, x: x.x, y: x.y, name: x.name })), o: { maxFeedM: +this.cfg().maxFeedM || 500 } });
    this._pv = { key, plan };
    return plan;
  },
  feedColor(id) { const ids = this._feeds().map(x => x.id), i = ids.indexOf(id); return this.COLORS[(i < 0 ? 0 : i) % this.COLORS.length]; },

  // ───────── open / close ─────────
  open() { this._active = true; this.step = this.poleEls().length ? 2 : 1; this.result = null; this._pv = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  close() { this._active = false; PlanEngine.requestDraw({ fg: true }); },
  touched() { this._pv = null; if (this.result) this.result.stale = true; PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  hint() {
    if (!this.f()) return 'Street lighting layout: calibrate the plan first (lengths are in metres).';
    return this.step === 1 ? 'Click a road to pick it for Place poles (again or Alt-click drops it; none picked = every road)'
      : this.step === 2 ? 'Click a kiosk or mini-sub to tick it as a feed · click empty ground to place a new kiosk · Alt-click takes one away'
      : this.step === 4 ? 'Each circuit in its colour; dashed = a feeder. Create writes them to the plan and the Circuits tab.'
      : 'Street lighting layout: the poles, the feeds, the rules, then Run and Create.';
  },

  // ───────── the plan: clicks and drawing ─────────
  click(pt, e) {
    if (this.step === 1 && this.f()) { this._pickRoad(pt, e); return; }
    if (this.step !== 2 || !this.f()) return;
    const z = PlanEngine.view.zoom, R = 14 / z;
    const src = this.sourceEls().map(s => ({ s, d: Math.hypot(s.x - pt.x, s.y - pt.y) })).filter(o => o.d <= R).sort((a, b) => a.d - b.d)[0];
    const pi = this.pend.findIndex(p => Math.hypot(p.x - pt.x, p.y - pt.y) <= R);
    const c = this.cfg();
    if (src) {
      const ids = new Set((c.feeds || this.sourceEls().map(x => x.id)));
      if (e && e.altKey) ids.delete(src.s.id); else if (ids.has(src.s.id)) ids.delete(src.s.id); else ids.add(src.s.id);
      c.feeds = [...ids];
    } else if (pi >= 0) { if (e && e.altKey) this.pend.splice(pi, 1); }
    else if (!(e && e.altKey)) this.pend.push({ x: pt.x, y: pt.y });
    else return;
    this.touched();
  },
  draw(ctx, zoom) {
    if (!this._active || !this.f()) return;
    const u = 1 / zoom, f = this.f(), P = this.preview(); if (!P) return;
    const px = p => [p[0] / f, p[1] / f];
    const line = (pts, col, w, dash) => { ctx.strokeStyle = col; ctx.lineWidth = w * u; ctx.setLineDash(dash ? [7 * u, 5 * u] : []); ctx.beginPath(); pts.forEach((p, i) => { const q = px(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke(); };
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const R = this.result && !this.result.stale ? this.result : null, colOf = new Map();
    if (R) {
      for (const c of R.circuits) {
        for (let k = c.from; k < c.to; k++) colOf.set(c.st.poles[k].id, c.color);
        line(SLLayout.pathTo(c.g, c.st, c.from), c.color, 2.4, true);
        for (let k = c.from + 1; k < c.to; k++) line(c.st.spanPts[k], c.color, 2.6, false);
        if (!c.pass) { const p = c.st.poles[c.from]; ctx.strokeStyle = '#b91c1c'; ctx.lineWidth = 2 * u; ctx.setLineDash([]); ctx.beginPath(); ctx.arc(p.x / f, p.y / f, 11 * u, 0, 6.2832); ctx.stroke(); }
      }
    } else for (const g of P.groups) { const col = this.feedColor(g.feed.id); for (const st of g.strings) for (const p of st.poles) colOf.set(p.id, col); if (g.strings[0]) line(SLLayout.pathTo(g, g.strings[0], 0), col, 1.5, true); }
    ctx.setLineDash([]);
    if (this.step === 1) {
      ctx.strokeStyle = 'rgba(245,158,11,.45)'; ctx.lineWidth = 8 * u;
      for (const r of this.streetRoutes()) if (this.roadPick.has(r.id)) { ctx.beginPath(); r.points.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke(); }
      ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.8 * u;
      for (const d of this.draftPoles()) { ctx.beginPath(); ctx.arc(d.x, d.y, 6 * u, 0, 6.2832); ctx.stroke(); }
    }
    for (const e of this.poleEls()) {
      const col = colOf.get(e.id); ctx.fillStyle = col || '#9aa0a8'; ctx.beginPath(); ctx.arc(e.x, e.y, 5 * u, 0, 6.2832); ctx.fill();
      if (!col) { ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.6 * u; ctx.beginPath(); ctx.moveTo(e.x - 6 * u, e.y - 6 * u); ctx.lineTo(e.x + 6 * u, e.y + 6 * u); ctx.moveTo(e.x + 6 * u, e.y - 6 * u); ctx.lineTo(e.x - 6 * u, e.y + 6 * u); ctx.stroke(); }
    }
    const tick = new Set(this.ticked().map(e => e.id));
    for (const s of this.sourceEls()) {
      const on = tick.has(s.id); ctx.strokeStyle = on ? this.feedColor(s.id) : '#9aa0a8'; ctx.lineWidth = (on ? 3 : 1.5) * u; ctx.setLineDash(on ? [] : [4 * u, 3 * u]);
      ctx.beginPath(); ctx.arc(s.x, s.y, 16 * u, 0, 6.2832); ctx.stroke();
    }
    this.pend.forEach((p, i) => {
      const col = this.feedColor('new:' + i); ctx.setLineDash([4 * u, 3 * u]); ctx.strokeStyle = col; ctx.lineWidth = 2 * u; ctx.fillStyle = 'rgba(253,244,238,.9)';
      ctx.fillRect(p.x - 9 * u, p.y - 6 * u, 18 * u, 12 * u); ctx.strokeRect(p.x - 9 * u, p.y - 6 * u, 18 * u, 12 * u);
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(p.x, p.y, 16 * u, 0, 6.2832); ctx.stroke();
    });
    ctx.restore();
  },

  // ───────── Poles along roads (step 1) ─────────
  _pickRoad(pt, e) {
    const z = PlanEngine.view.zoom, f = this.f();
    let best = null;
    for (const r of this.streetRoutes()) { const pr = SLLayout.project([pt.x, pt.y], r.points.map(q => [q.x, q.y])); if (pr && pr.d * z <= 12 && (!best || pr.d < best.d)) best = { r, d: pr.d }; }
    if (!best) return;
    if (e && e.altKey) this.roadPick.delete(best.r.id); else if (this.roadPick.has(best.r.id)) this.roadPick.delete(best.r.id); else this.roadPick.add(best.r.id);
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  pickedRoads() { const all = this.streetRoutes(); return this.roadPick.size ? all.filter(r => this.roadPick.has(r.id)) : all; },
  // a road's distance from its centre line to the pole line (m): the lighting design's pole on its road section, else 1 m behind
  // the kerb, else 1.5 m inside the reserve, else 6 m
  autoOff(r) {
    const RS = typeof RoadSections !== 'undefined' ? RoadSections : null; if (!RS) return 6;
    const sec = RS.of(r), w = (RS.reserveOf(r.props) || {}).w || (sec ? RS.reserve(sec) : 0), p = sec ? RS.pole(sec) : null;
    if (p && w > 0) return Math.max(0.5, Math.abs(w / 2 - p.off));
    const c = RS.carriage(r.props); if (c && c.cw > 0) return c.cw / 2 + 1;
    return w > 0 ? Math.max(0.5, w / 2 - 1.5) : 6;
  },
  spacing() { return +this.pp.spacing > 0 ? +this.pp.spacing : StreetLight._num(StreetLight.defaults.spacingM, 35); },
  // the poles *Place* would put down (plan px), with the road each is on
  draftPoles() {
    const f = this.f(); if (!f) return [];
    const all = this.streetRoutes().map(r => ({ id: r.id, r, pts: r.points.map(q => [q.x * f, q.y * f]) }));
    const picked = new Set(this.pickedRoads().map(r => r.id)), wired = this._wired();
    const keep = this.allPoles().filter(e => !(e.auto === 'slp' && picked.has(e.roadId) && !wired.has(e.id))).map(e => [e.x * f, e.y * f]);   // what Place replaces is not in the way
    const out = [];
    for (const r of this.pickedRoads()) {
      const st = all.find(x => x.id === r.id), off = +this.pp.off > 0 ? +this.pp.off : this.autoOff(r);
      for (const q of SLLayout.polesAlong(st, { spacing: this.spacing(), off, arr: this.pp.arr }, all.map(x => ({ id: x.id, pts: x.pts })).filter(x => x.id !== r.id), keep.concat(out.map(o => [o.x * f, o.y * f]))))
        out.push({ x: q.x / f, y: q.y / f, roadId: r.id });
    }
    return out;
  },
  _wired() { const w = new Set(); for (const r of this.pm().routes) { if (r.fromId) w.add(r.fromId); if (r.toId) w.add(r.toId); } return w; },
  placePoles() {
    const pm = this.pm(), roads = new Set(this.pickedRoads().map(r => r.id)), drafts = this.draftPoles();
    if (!drafts.length) { UI.toast('No pole fits: the roads are too short for the spacing, or poles are already there.', 'warn', 5000); return; }
    const wired = this._wired();
    let gone = 0;
    for (let i = pm.elements.length - 1; i >= 0; i--) { const e = pm.elements[i]; if (e.type === 'pole' && e.auto === 'slp' && roads.has(e.roadId) && !wired.has(e.id)) { pm.elements.splice(i, 1); gone++; } }
    for (const d of drafts) pm.elements.push({ id: AppState.planGenId('pmel'), type: 'pole', x: d.x, y: d.y, rotation: 0, name: PlanMarkup.nextName('pole'), reticId: null, props: PLAN_DEFS.defaults('pole'), roadId: d.roadId, auto: 'slp' });
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.touched();
    UI.toast(`Placed ${drafts.length} pole${drafts.length === 1 ? '' : 's'}${gone ? ` (replacing ${gone} placed here before)` : ''}. Next: Feeds.`, 'success', 5000);
  },

  // ───────── Run: the engine splits each string into circuits ─────────
  async run() {
    if (this.busy) return;
    const P = this.preview(); if (!P) { UI.toast('Calibrate the plan first.', 'warn'); return; }
    const strings = [], meta = new Map(), c = this.cfg(), d = StreetLight.defaults, feeds = this._feeds();
    const lum = StreetLight._lum(d.luminaireId), phases = ['R', 'W', 'B'], perFeed = new Map();
    for (const g of P.groups) {
      const fd = feeds.find(x => x.id === g.feed.id), src = this._srcOf(fd);
      const ze = this._zeFor(fd, src), svd = src && src.kind === 'kiosk' ? StreetLight._supplyVd({ source: src, supplyVdPct: null }).value : 0;
      for (const st of g.strings) {
        const n = perFeed.get(g.feed.id) || 0; perFeed.set(g.feed.id, n + 1);
        strings.push({ id: st.id, poles: st.poles.map((p, k) => ({ id: p.id, spanM: st.spanM[k] })), feederToM: st.feederToM, zeOhm: ze, supplyVdPct: svd, singlePhase: phases[n % 3] });
        meta.set(st.id, { g, st });
      }
    }
    if (!strings.length) { UI.toast(P.groups.length ? 'Nothing to run.' : 'No pole is near a road with a feed: tick or place a kiosk (Feeds).', 'warn', 5000); return; }
    const cables = this._cables(), breakers = SL_PROTECTION.filter(p => /^[BC]\d+$/.test(p.id)).map(p => ({ id: p.id, inA: +p.id.slice(1), iaA: p.ia }));
    if (!cables.length) { UI.toast('No cable in the size range for a ' + (c.system === '1ph' ? '1Φ (2-core)' : '3Φ (4-core)') + ' circuit: widen it in Rules.', 'warn', 6000); return; }
    const base = { system: c.system, phaseStart: 'R', singlePhase: 'R', luminaire: { name: lum.name, watts: lum.watts, pf: lum.pf },
      snakingPct: StreetLight._num(d.snakingPct, 0), loopInM: StreetLight._num(d.loopInM, 0),
      vdLimitPct: +c.vdLimit > 0 ? +c.vdLimit : StreetLight._num(d.vdLimitPct, 5), cumVdLimitPct: StreetLight._num(d.cumVdLimitPct, 10) };
    this.busy = true; PlanMarkup.refreshProps();
    try {
      const res = await API.splitStreetLighting({ base, cables, breakers, maxPoles: +c.maxPoles || 0, strings });
      const circuits = [], count = new Map();
      for (const s of res.strings || []) {
        const m = meta.get(s.id); if (!m) continue;
        for (const x of s.circuits || []) {
          const k = (count.get(m.g.feed.id) || 0) + 1; count.set(m.g.feed.id, k);
          const fd = feeds.find(q => q.id === m.g.feed.id);
          circuits.push(Object.assign({}, x, { g: m.g, st: m.st, singlePhase: strings.find(q => q.id === s.id).singlePhase, name: `${fd ? fd.name : 'Feed'} / ${k}`, color: this.COLORS[circuits.length % this.COLORS.length] }));
        }
      }
      this.result = { plan: P, circuits, unassigned: P.unassigned, base };
      this.step = 4;
    } catch (err) { UI.toast('Street lighting layout: ' + (err.message || err), 'error', 6000); }
    finally { this.busy = false; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
  },
  _srcOf(fd) {
    const e = fd && fd.el, R = AppState.reticulation; if (!e || !e.reticId || !R) return null;
    if (e.type === 'kiosk' && R.kiosks.some(k => k.id === e.reticId)) return { kind: 'kiosk', id: e.reticId };
    if (e.type === 'minisub' && R.minisubs.some(m => m.id === e.reticId)) return { kind: 'minisub', id: e.reticId };
    return null;
  },
  // Ze at a feed: its own estimate; a new kiosk (or one not in Demand yet) that of the nearest mini-sub, to be checked after Create
  _zeFor(fd, src) {
    const est = src ? StreetLight._zeEstimate(src) : null; if (est) return est.value;
    const ms = this.sourceEls().filter(e => e.type === 'minisub' && e.reticId).map(e => ({ e, d: Math.hypot(e.x - fd.x / this.f(), e.y - fd.y / this.f()) })).sort((a, b) => a.d - b.d)[0];
    const m = ms ? StreetLight._zeEstimate({ kind: 'minisub', id: ms.e.reticId }) : null;
    return m ? m.value : 0;
  },
  // the cables the engine may pick: LV distribution, cores to suit, within the size range
  _cables() {
    const c = this.cfg();
    return StreetLight._candidateCables().filter(k => {
      const cab = CableLib.byName(k.name), mm = cab ? +cab.size_mm2 : 0;
      if (c.system === '1ph' ? k.cores !== 2 : k.cores < 4) return false;
      if (c.cond && cab && cab.conductor !== c.cond) return false;
      if (+c.minSize > 0 && mm < +c.minSize) return false;
      if (+c.maxSize > 0 && mm > +c.maxSize) return false;
      return true;
    });
  },
  _sizes() {
    const c = this.cfg(), set = new Set();
    for (const k of StreetLight._candidateCables()) { if (c.system === '1ph' ? k.cores !== 2 : k.cores < 4) continue; const cab = CableLib.byName(k.name); if (cab && +cab.size_mm2 > 0 && (!c.cond || cab.conductor === c.cond)) set.add(+cab.size_mm2); }
    return [...set].sort((a, b) => a - b);
  },

  checks() {
    const R = this.result; if (!R) return [];
    const out = [], lim = R.base.vdLimitPct;
    for (const c of R.circuits) {
      if (!c.pass) out.push({ sev: 'fail', text: `${c.name}: ${c.to - c.from} pole${c.to - c.from === 1 ? '' : 's'} cannot pass (${(c.fails || []).map(x => StreetLight.FAIL_TEXT[x] || x).join(', ')}) on the largest cable allowed. Place a kiosk nearer, or allow larger cables.` });
      else if (c.worstVdPct >= 0.9 * lim) out.push({ sev: 'near', text: `${c.name} is at ${(+c.worstVdPct).toFixed(1)} % of ${lim} % volt drop.` });
    }
    const why = new Map(); for (const u of R.unassigned) why.set(u.reason, (why.get(u.reason) || 0) + 1);
    for (const [t, n] of why) out.push({ sev: 'warn', text: `${n} pole${n === 1 ? '' : 's'}: ${t}.` });
    const x = R.plan.groups.filter(g => g.crosses).length; if (x) out.push({ sev: 'note', text: `${x} feeder${x === 1 ? ' crosses' : 's cross'} a road: a crossing duct each.` });
    const rpc = typeof StreetLight !== 'undefined' ? StreetLight.circuits.filter(x => x.roadKey).length : 0;
    if (rpc && this.poleEls().some(e => e.auto === 'rp')) out.push({ sev: 'warn', text: `${rpc} circuit${rpc === 1 ? '' : 's'} in the Circuits tab ${rpc === 1 ? 'was' : 'were'} made by the Road plan (Send to circuits) from the same poles: delete ${rpc === 1 ? 'it' : 'them'} after Create, or the poles are counted twice.` });
    if (this.pend.length) out.push({ sev: 'note', text: `${this.pend.length} new kiosk${this.pend.length === 1 ? '' : 's'}: Ze is taken from the nearest mini-sub until Demand has ${this.pend.length === 1 ? 'it' : 'them'}; the Circuits tab works it out after Create.` });
    return out;
  },

  // ───────── the panel ─────────
  STEPS: ['Poles', 'Feeds', 'Rules', 'Review'],
  renderOptions(el) {
    const f = this.f(), P = f ? this.preview() : null;
    const head = `<div style="display:flex;flex-direction:column;gap:8px;padding:2px 0 8px;border-bottom:1px solid var(--border,#e5e7eb)">
      <b style="font-size:14px">Street lighting layout</b>
      <div role="tablist" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px">${this.STEPS.map((s, i) => `<button type="button" class="plan-btn" role="tab" aria-selected="${this.step === i + 1}" data-sll="step" data-n="${i + 1}" style="padding:4px 2px;font-size:12px;${this.step === i + 1 ? 'background:var(--accent,#2563eb);color:#fff;font-weight:600' : ''}">${i + 1} ${s}</button>`).join('')}</div></div>`;
    let body = '';
    if (!f) body = '<p style="font-size:13px">Calibrate the plan first: the cable lengths are measured in metres.</p>';
    else if (this.step === 1) body = this._polesHtml(P);
    else if (this.step === 2) body = this._feedsHtml(P);
    else if (this.step === 3) body = this._rulesHtml();
    else body = this._reviewHtml();
    const next = !f ? '' : this.step === 1 ? `<button type="button" class="plan-btn" data-sll="step" data-n="2" style="width:100%;min-height:40px;font-weight:600">Next: Feeds</button>`
      : this.step === 2 ? `<button type="button" class="plan-btn" data-sll="step" data-n="3" style="width:100%;min-height:40px;font-weight:600">Next: Rules</button>`
      : this.step === 3 || !this.result || this.result.stale ? `<button type="button" class="plan-btn" data-sll="run" style="width:100%;min-height:40px;font-weight:600;background:var(--accent,#2563eb);color:#fff"${this.busy ? ' disabled' : ''}>${this.busy ? 'Running…' : this.result ? 'Run again' : 'Run layout'}</button>`
      : `<button type="button" class="plan-btn" data-sll="create" style="width:100%;min-height:40px;font-weight:600;background:var(--accent,#2563eb);color:#fff">Create on plan</button>`;
    el.innerHTML = `<div class="sll" style="display:flex;flex-direction:column;gap:10px;font-size:13px">${head}${body}<div style="position:sticky;bottom:0;background:var(--bg-panel,#fff);padding-top:6px">${next}</div></div>`;
    el.onclick = ev => this._click(ev); el.onchange = ev => this._change(ev);
  },
  _placeHtml() {
    const roads = this.streetRoutes().length; if (!roads) return '';
    const picked = this.roadPick.size, n = this.draftPoles().length, pp = this.pp;
    const offs = [...new Set(this.pickedRoads().map(r => this.f2(this.autoOff(r))))];
    const arr = [['A', 'One side: A (left of the road\'s direction)'], ['B', 'One side: B'], ['both', 'Both sides, opposite'], ['stagger', 'Both sides, staggered']];
    return `<div style="display:flex;flex-direction:column;gap:6px;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px">
      <b>Place poles along roads</b>
      <span>${picked ? `${picked} road${picked === 1 ? '' : 's'} picked` : `All ${roads} road${roads === 1 ? '' : 's'}`} · click a road on the plan to pick it (again or Alt-click drops it).</span>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
        <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">Spacing, m<input type="number" min="5" step="1" data-sll-pp="spacing" value="${pp.spacing ? this.esc(pp.spacing) : ''}" placeholder="${this.esc(this.spacing())}"></label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">From the road centre, m<input type="number" min="0.5" step="0.1" data-sll-pp="off" value="${pp.off ? this.esc(pp.off) : ''}" placeholder="${this.esc(offs.length === 1 ? offs[0] : 'per road')}"></label></div>
      <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">Arrangement<select data-sll-pp="arr">${arr.map(([v, t]) => `<option value="${v}"${pp.arr === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <small style="color:var(--text-muted)">Blank distance = the pole of the road section's lighting design, else 1 m behind the kerb. No pole in a junction mouth or on top of another. The hollow circles on the plan are where they go.</small>
      <button type="button" class="plan-btn" data-sll="place" style="font-weight:600;min-height:36px"${n ? '' : ' disabled'}>Place ${n} pole${n === 1 ? '' : 's'}</button></div>`;
  },
  _polesHtml(P) {
    return this._polesInfo(P) + this._placeHtml();
  },
  _polesInfo(P) {
    const n = this.poleEls().length, roads = this.streetRoutes().length;
    if (!n && this.allPoles().length) return `<p>All ${this.allPoles().length} poles are already wired by street-light cables drawn by hand. To lay them out again, tick <i>Re-lay hand-drawn cables too</i> in Feeds.</p>`;
    if (!n) return '<p>No street-light poles on the plan yet. Place them along the roads below, one by one with the Streetlight Pole tool (Street Lighting group), or send the poles of Street lighting › Road plan here with its <i>Send poles to the site plan</i> (Poles step).</p>';
    const sides = P.groups.length, onRoad = n - P.unassigned.filter(u => /road/.test(u.reason)).length;
    return `<p>${n} pole${n === 1 ? '' : 's'} on the plan, ${onRoad} beside ${roads} road${roads === 1 ? '' : 's'}${sides ? `: ${sides} road side${sides === 1 ? '' : 's'} with a feed` : ''}.</p>
      <p style="color:var(--text-muted)">Each side of a road is its own string, so a circuit never crosses the road; only a feeder does. A pole more than 40 m from every road line is left out (draw the road, or move the pole).</p>
      ${!roads ? '<p style="color:#9a5b00">There are no roads on the plan: draw their centrelines (Auto layout › Streets, or the Street route).</p>' : ''}`;
  },
  _feedsHtml(P) {
    const tick = new Set(this.ticked().map(e => e.id)), cnt = new Map();
    for (const g of P.groups) cnt.set(g.feed.id, (cnt.get(g.feed.id) || 0) + g.poles.length);
    const row = (e) => `<label style="display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--border,#e5e7eb);border-radius:6px">
      <input type="checkbox" data-sll-feed="${this.esc(e.id)}"${tick.has(e.id) ? ' checked' : ''}><span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;background:${tick.has(e.id) ? this.feedColor(e.id) : '#cbd5e1'}"></span>
      <span style="flex:1"><b>${this.esc(e.name || e.type)}</b> ${e.type === 'minisub' ? 'mini-sub' : 'kiosk'}${e.reticId ? '' : ' <small style="color:#9a5b00">(not in Demand yet)</small>'}</span><span style="color:var(--text-muted)">${cnt.get(e.id) ? cnt.get(e.id) + ' poles' : tick.has(e.id) ? 'not used' : ''}</span></label>`;
    const far = P.unassigned.filter(u => !/road/.test(u.reason)).length, hand = this.handPoles().size;
    return `${hand ? `<div style="display:flex;flex-direction:column;gap:4px;background:var(--bg-panel,#f6f7f9);border-radius:6px;padding:8px"><span>${hand} pole${hand === 1 ? ' is' : 's are'} already wired by street-light cables drawn by hand${this.cfg().relay ? '; Create replaces those cables' : ' and left as ' + (hand === 1 ? 'it is' : 'they are')}.</span><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-sll-set="relay"${this.cfg().relay ? ' checked' : ''}> Re-lay hand-drawn cables too</label></div>` : ''}<div style="display:flex;flex-direction:column;gap:6px"><b style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">On the plan</b>
        ${this.sourceEls().map(row).join('') || '<p style="color:var(--text-muted)">No kiosks or mini-subs on the plan: place new kiosks below.</p>'}
        ${this.sourceEls().length ? `<div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-sll="all">Tick all</button><button type="button" class="plan-btn" data-sll="none">Untick all</button></div>` : ''}</div>
      <div style="display:flex;flex-direction:column;gap:6px"><b style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">New kiosks</b>
        ${this.pend.map((p, i) => `<div style="display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px dashed #b4501c;border-radius:6px"><span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;background:${this.feedColor('new:' + i)}"></span><span style="flex:1"><b>New kiosk ${i + 1}</b></span><span style="color:var(--text-muted)">${cnt.get('new:' + i) || 0} poles</span><button type="button" class="plan-btn" data-sll="unpend" data-i="${i}" aria-label="Remove new kiosk ${i + 1}" style="padding:0 8px">×</button></div>`).join('')}
        <small style="color:var(--text-muted)">Click empty ground on the plan to place one (Alt-click takes one away). Create adds it to Demand, fed from the nearest mini-sub.</small></div>
      ${far ? `<div style="background:#fdf0dc;border-radius:6px;padding:8px;color:#6b3a00">${far} pole${far === 1 ? ' has' : 's have'} no feed within ${this.cfg().maxFeedM} m of cable (crossed out on the plan): tick or place a kiosk nearer.</div>` : ''}`;
  },
  _rulesHtml() {
    const c = this.cfg(), sizes = this._sizes();
    const radio = (k, v, label) => `<label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="sll-${k}" data-sll-set="${k}" value="${v}"${c[k] === v ? ' checked' : ''}> <span>${label}</span></label>`;
    const num = (k, label, ph, step) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}<input type="number" step="${step || 1}" min="0" data-sll-set="${k}" value="${c[k] ? this.esc(c[k]) : ''}" placeholder="${this.esc(ph)}"></label>`;
    const sel = (k, label, ph) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}<select data-sll-set="${k}"><option value="0">${ph}</option>${sizes.map(s => `<option value="${s}"${+c[k] === s ? ' selected' : ''}>${s} mm²</option>`).join('')}</select></label>`;
    const d = StreetLight.defaults;
    return `<div style="display:flex;flex-direction:column;gap:6px"><b>Phases</b>${radio('system', '3ph', '3Φ, poles on R-W-B in turn (4-core)')}${radio('system', '1ph', '1Φ strings (2-core), the strings of a feed spread over R, W, B')}</div>
      <div style="display:flex;flex-direction:column;gap:6px"><b>Trench</b>${radio('trench', 'share', 'Share the LV trench: the cable runs on the road section\'s LV line; an SL trench only where no LV trench runs')}${radio('trench', 'own', 'Its own SL trench, along the pole line')}</div>
      <div style="display:flex;flex-direction:column;gap:6px"><b>Switching</b>${radio('switching', 'contactor', 'Photocell + contactor in the kiosk, a breaker per circuit')}${radio('switching', 'photocell', 'Photocell on each pole, a breaker feeding the string')}</div>
      <div style="display:flex;flex-direction:column;gap:6px"><b>Limits</b>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${num('vdLimit', 'Volt drop, %', d.vdLimitPct || 5, 0.5)}${num('maxPoles', 'Most poles a circuit', 'no limit')}<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">Conductor<select data-sll-set="cond"><option value="Cu"${c.cond === 'Cu' ? ' selected' : ''}>Copper</option><option value="Al"${c.cond === 'Al' ? ' selected' : ''}>Aluminium</option><option value=""${!c.cond ? ' selected' : ''}>Either</option></select></label>${sel('minSize', 'Smallest cable', 'any')}${sel('maxSize', 'Largest cable', 'any')}${num('maxFeedM', 'Longest feeder reach, m', 500, 10)}</div>
        <small style="color:var(--text-muted)">The checks are the Circuits tab's: volt drop from the source and with the supply's, Zs against the breaker, the cable rating. Luminaire, snaking and loop-in are the Circuits tab's defaults.</small></div>
      <div style="display:flex;flex-direction:column;gap:6px"><b>At each pole</b>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-sll-set="cutout"${c.cutout ? ' checked' : ''}> Cut-out with fuse</label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-sll-set="earth"${c.earth ? ' checked' : ''}> Earth electrode</label></div>`;
  },
  _reviewHtml() {
    const R = this.result;
    if (!R) return '<p>Press Run layout.</p>';
    const ok = R.circuits.filter(c => c.pass).length, n = R.circuits.length, poles = R.circuits.reduce((s, c) => s + c.to - c.from, 0);
    const kms = R.circuits.reduce((s, c) => s + (+c.cableLengthM || 0), 0) / 1000, feeds = new Set(R.circuits.map(c => c.g.feed.id)).size;
    const verdict = ok === n ? `<div style="background:#e7f4ec;border-radius:6px;padding:8px"><b style="color:#0b5d2a">${n} circuit${n === 1 ? ' passes' : 's pass'}</b><br>${poles} poles · ${feeds} feed${feeds === 1 ? '' : 's'} · ${kms.toFixed(2)} km of cable</div>`
      : `<div style="background:#fde8e8;border-radius:6px;padding:8px"><b style="color:#9b1c1c">${n - ok} of ${n} circuits fail</b><br>${poles} poles · ${kms.toFixed(2)} km of cable</div>`;
    const rows = R.circuits.map(c => `<tr><td><span style="color:${c.color}">■</span> ${this.esc(c.name)}</td><td>${c.to - c.from}</td><td>${this.esc((c.cable || '—').replace(/ LV$/, '').replace('mm² ', ' '))}</td><td>${this.esc(c.breaker || '—')}</td><td style="${c.pass ? '' : 'color:#9b1c1c;font-weight:600'}">${c.worstVdPct != null ? (+c.worstVdPct).toFixed(1) + ' %' : '—'}</td></tr>`).join('');
    const col = { fail: '#9b1c1c', warn: '#9a5b00', near: '#9a5b00', note: '#5b6068' }, lab = { fail: 'Fix', warn: 'Check', near: 'Near', note: 'Note' };
    const ch = this.checks();
    return `${R.stale ? '<div style="background:#fdf0dc;border-radius:6px;padding:8px;color:#6b3a00">Something changed since this run: Run again.</div>' : ''}${verdict}
      <div style="overflow-x:auto"><table class="sl-table" style="width:100%;font-size:12px"><thead><tr><th>Circuit</th><th>Poles</th><th>Cable</th><th>Breaker</th><th>VD</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${ch.length ? `<div style="display:flex;flex-direction:column;gap:4px"><b>Checks</b>${ch.map(c => `<div style="display:flex;gap:8px"><b style="color:${col[c.sev]};min-width:40px">${lab[c.sev]}</b><span>${this.esc(c.text)}</span></div>`).join('')}</div>` : ''}
      <div style="display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--border,#e5e7eb);padding-top:8px"><b>Create makes</b>
        <span>${n} circuit${n === 1 ? '' : 's'} in Street lighting › Circuits</span><span>Street-light cable routes on the plan</span>
        <span>${this.cfg().trench === 'share' ? 'SL trenches where no LV trench runs' : 'SL trenches along the pole lines'}${R.plan.groups.some(g => g.crosses) ? ' and the road crossings' : ''}</span>
        ${this.pend.length ? `<span>${this.pend.length} new kiosk${this.pend.length === 1 ? '' : 's'}, added to Demand</span>` : ''}
        <small style="color:var(--text-muted)">A Create replaces what the last one made; circuits and routes drawn by hand stay.</small></div>`;
  },
  _click(ev) {
    const b = ev.target.closest('[data-sll]'); if (!b) return;
    const a = b.dataset.sll, c = this.cfg();
    if (a === 'step') { this.step = +b.dataset.n; PlanMarkup.refreshProps(); PlanMarkup._toolMsg = this.hint(); PlanEngine.requestDraw({ fg: true }); return; }
    if (a === 'run') { this.run(); return; }
    if (a === 'place') { this.placePoles(); return; }
    if (a === 'create') { this.commit(); return; }
    if (a === 'all') { c.feeds = null; this.touched(); return; }
    if (a === 'none') { c.feeds = []; this.touched(); return; }
    if (a === 'unpend') { this.pend.splice(+b.dataset.i, 1); this.touched(); return; }
  },
  _change(ev) {
    const t = ev.target, c = this.cfg();
    if (t.matches('[data-sll-pp]')) { const k = t.dataset.sllPp; this.pp[k] = k === 'arr' ? t.value : (t.value === '' ? null : Math.max(0, +t.value || 0) || null); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
    if (t.matches('[data-sll-feed]')) { const ids = new Set(this.ticked().map(e => e.id)); if (t.checked) ids.add(t.dataset.sllFeed); else ids.delete(t.dataset.sllFeed); c.feeds = [...ids]; this.touched(); return; }
    if (t.matches('[data-sll-set]')) {
      const k = t.dataset.sllSet;
      if (t.type === 'checkbox') c[k] = t.checked;
      else if (t.type === 'radio') c[k] = t.value;
      else if (k === 'cond') c[k] = t.value;
      else c[k] = t.value === '' ? (k === 'vdLimit' ? null : 0) : Math.max(0, +t.value || 0);
      if (k === 'maxFeedM' && !(+c.maxFeedM > 0)) c.maxFeedM = 500;
      this.touched();
    }
  },

  // ───────── Create ─────────
  async commit() {
    const R = this.result; if (!R || R.stale) return;
    const bad = R.circuits.filter(c => !c.pass).length;
    if (bad && !(await UI.confirm(`${bad} circuit${bad === 1 ? ' fails' : 's fail'} its checks. Create anyway? ${bad === 1 ? 'It shows' : 'They show'} as failing in the Circuits tab.`))) return;
    const pm = this.pm(), f = this.f(), c = this.cfg();
    const px = pts => pts.map(p => ({ x: p[0] / f, y: p[1] / f }));
    const removeIf = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) arr.splice(i, 1); };
    removeIf(pm.routes, x => x.auto === 'sl' || (c.relay && x.type === 'sl')); removeIf(pm.trenches, x => x.auto === 'sl'); removeIf(pm.crossings, x => x.auto === 'sl');
    // the new kiosks
    const elOf = new Map(), made = { kiosks: 0, routes: 0, trenches: 0, crossings: 0 };
    for (const fd of this._feeds()) {
      if (fd.el) { elOf.set(fd.id, fd.el); continue; }
      const p = this.pend[fd.pend];
      const e = { id: AppState.planGenId('pmel'), type: 'kiosk', x: p.x, y: p.y, rotation: 0, name: PlanMarkup.nextName('kiosk'), reticId: null, props: PLAN_DEFS.defaults('kiosk'), auto: 'sl' };
      pm.elements.push(e); elOf.set(fd.id, e); made.kiosks++;
      if (c.feeds) c.feeds.push(e.id);
    }
    // the routes: feed → first pole of each circuit, then pole to pole
    const route = (fromId, toId, pts, cable) => { pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'sl', fromId, toId, points: px(pts), cableType: cable || '', curved: false, props: {}, auto: 'sl' }); made.routes++; };
    const used = new Set();
    for (const cc of R.circuits) {
      const fe = elOf.get(cc.g.feed.id); if (!fe) continue;
      used.add(cc.g);
      route(fe.id, cc.st.poles[cc.from].id, SLLayout.pathTo(cc.g, cc.st, cc.from), cc.cable);
      for (let k = cc.from + 1; k < cc.to; k++) route(cc.st.poles[k - 1].id, cc.st.poles[k].id, cc.st.spanPts[k], cc.cable);
    }
    // the trenches (shared: only where no LV trench runs) and a crossing where a feeder crosses a road
    const lvT = c.trench === 'share' ? pm.trenches.filter(t => t.auto !== 'sl' && (t.excType === 'LV/SL' || t.excType === 'MV/LV/SL') && t.points && t.points.length > 1).map(t => t.points.map(p => [p.x * f, p.y * f])) : [];
    for (const g of used) {
      const runs = [g.trench].concat(g.crosses ? [] : [g.leg]).filter(r => r && SLLayout.len(r) >= 1);
      const pieces = c.trench === 'share' ? runs.flatMap(r => SLLayout.uncovered(r, lvT)) : runs;
      for (const pc of pieces) { pm.trenches.push({ id: AppState.planGenId('pmtr'), name: PlanMarkup.nextCounter('_trench', 'T'), excType: 'LV/SL', points: px(pc), widthOverride: null, depthOverride: null, roadId: g.street.id, auto: 'sl' }); made.trenches++; }
      if (g.crosses) { const [a, b] = g.leg; pm.crossings.push({ id: AppState.planGenId('pmcr'), name: PlanMarkup.nextCounter('_crossing', 'RC'), size: '110', use: 'SL', trench: 'sl:' + g.key, p1: { x: a[0] / f, y: a[1] / f }, p2: { x: b[0] / f, y: b[1] / f }, auto: 'sl' }); made.crossings++; }
    }
    // Demand: new kiosks (and feeds not in it yet) get their rows; a new kiosk is fed from the nearest mini-sub
    if (typeof PlanSync !== 'undefined' && [...elOf.values()].some(e => !e.reticId)) {
      PlanSync._pushCore({ interactive: false });
      const Rt = AppState.reticulation, subs = this.sourceEls().filter(e => e.type === 'minisub' && e.reticId);
      for (const e of elOf.values()) {
        if (e.auto !== 'sl' || !e.reticId || !subs.length) continue;
        const row = Rt.kiosks.find(k => k.id === e.reticId), near = subs.slice().sort((a, b) => Math.hypot(a.x - e.x, a.y - e.y) - Math.hypot(b.x - e.x, b.y - e.y))[0];
        if (row && near && (!row.fedFrom || row.fedFrom === 'source' || row.fedFrom === (Rt.minisubs[0] || {}).id)) row.fedFrom = near.reticId;
      }
    }
    // the circuits, from the routes (as Sync from plan), then what the layout chose
    let set = 0;
    if (typeof StreetLight !== 'undefined') {
      StreetLight._planCore({ prune: true });
      for (const cc of R.circuits) {
        const fe = elOf.get(cc.g.feed.id); if (!fe) continue;
        const sc = StreetLight.circuits.find(x => x.planKey === `${fe.id}>${cc.st.poles[cc.from].id}`); if (!sc) continue;
        Object.assign(sc, { system: c.system, cable: cc.cable || sc.cable, switching: c.switching, poleCutout: !!c.cutout, poleEarth: !!c.earth, slAuto: true });
        if (cc.breaker) sc.protection = cc.breaker;
        // a circuit reused from an earlier one (same first pole) keeps its name: give it its source's if that changed
        const base = 'SL-' + StreetLight._sourceName(sc.source).replace(/\s+/g, '') + '-';
        if (/^SL-/.test(sc.name || '') && !sc.name.startsWith(base)) { let k = 1; while (StreetLight.circuits.some(x => x !== sc && x.name === base + String(k).padStart(2, '0'))) k++; sc.name = base + String(k).padStart(2, '0'); }
        if (c.system === '1ph') sc.singlePhase = cc.singlePhase; else sc.phaseStart = 'R';
        set++;
      }
      StreetLight._syncSourceLoads();
    }
    this.pend = [];
    AppState.dirty = true;
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`Street lighting: ${set} circuit${set === 1 ? '' : 's'} in the Circuits tab, ${made.routes} route${made.routes === 1 ? '' : 's'}, ${made.trenches} trench${made.trenches === 1 ? '' : 'es'}, ${made.crossings} crossing${made.crossings === 1 ? '' : 's'}${made.kiosks ? `, ${made.kiosks} new kiosk${made.kiosks === 1 ? '' : 's'}` : ''}.`, 'success', 8000);
    this.result = null; this._pv = null; this.step = 2;
    PlanMarkup.refreshProps();
  },
};

if (typeof PlanTools !== 'undefined') {
  PlanTools.register({
    id: 'sllayout', cursor: 'crosshair',
    onActivate() { SLLayoutUI.open(); },
    onDeactivate() { SLLayoutUI.close(); },
    cancel() { PlanTools.set('select'); },
    onDown(pt, e) { SLLayoutUI.click(pt, e); },
    onMove() {}, onUp() {},
    drawOverlay(ctx, zoom) { SLLayoutUI.draw(ctx, zoom); },
    onKey(e) { if (e.key === 'Escape') { this.cancel(); return true; } return false; },
  });
}
