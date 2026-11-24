/*
 * RoadSections — the ONE project library of road sections (node-testable, testing/unit/roadsections.test.js).
 *
 * A road section is a road seen end-on, in two layers:
 *   strips   [ { id, type, name, width, lanes, cls, surface, direction } ]   left to right from boundary A (the road-lighting strip format:
 *            carriageway / footpath / cycle / verge / median, lighting class, road surface). The reserve is their sum.
 *   items    the services, every offset from boundary A (PlanSections.SHAPE: svc / lv / fi / mv / kiosk / mh / sleeve); `pole` is kept for the
 *            checks but shown from the lighting design's first row (`pole()`), which owns where the street lights stand.
 * Stored in `reticulation.streetLighting.roadSections` (Collab list `sl.roadSections`); the default is `streetLighting.settings.roadSectionDef`.
 *
 * Who reads it:
 *   - a road on the site plan (a `street` route) picks one with `props.section` (Properties, bulk too); none = the default;
 *   - a Lighting design picks one with `des.section`: its strips ARE the section's (`stripsOf`); a design without one keeps its own strips;
 *   - a Road plan road reads the site plan road it follows, else its own `road.section`, else its design's (`RoadPlan._design`);
 *   - Auto layout reads `forLayout()`: the services offsets per road, in the engine's { strips: {a, road, b}, items } shape (`layoutShape`).
 * The carriageway of a site plan road (`carriage`): its own carriageW where one is set (typed or from the road reserve tool: the road's own
 * kerbs), else the carriageway of its section; a road whose own width differs from its section's is listed by `mismatches`.
 * Older projects are converted once on open (`migrate`): Auto layout's own sections + section lines, and the strips of every lighting design.
 *
 * Road reserve (`reserve`, `setReserve`, `fitStrips`, `fits`): a section may have a picked reserve width (`sec.reserve`, m); the strips then
 * have to fill it. Setting it resizes the verges (the strip next to each boundary; the carriageway never moves) as `sec.reserveFit` says
 * ('both' share it, 'a' = verge A keeps its width, 'b' = verge B keeps its); a strip edited so they no longer add up is flagged (`fits`)
 * with `fitStrips` / `matchReserve`. No reserve picked = the strips' sum, as before. A site plan road's reserve (`reserveOf`) is its own
 * `props.width` where typed, else its section's picked reserve; `widthMismatches` lists roads whose own width is not their section's.
 *
 * The project standard (`std`, `sizes`, `setOwn`, `copyFrom`, `toStd`): the offsets from the erf boundary (service, LV, fibre, MV, kiosk
 * near face, manhole centre), the kiosk size, the fibre manhole size and the width + depth of each trench type (MV, LV/SL, MV/LV/SL, FI)
 * are set ONCE for the project in `streetLighting.settings.roadStd` { off, kiosk, mh, trench }. A section uses each group unless it
 * differs (`sec.own[group]`: its own `items[k].off` offsets, `items.kiosk` / `items.mh` sizes, its own `sec.trench`). A standard made
 * before it held the offsets takes them from the default section; the sections that differ keep theirs (`offInit`).
 * `layoutShape` hands the engine the resolved sizes; `trenchSize(t)` is the size of a plan trench (its own width / depth override, else
 * the section of the road it lies along (`t.roadId`) or the section Auto layout made it on (`t.section`) where that section differs, else
 * the standard) — the plan drawing, the CSV and the trench Properties read it. `migrateStd` sets the standard up once for an older project.
 */
const RoadSections = (() => {
  'use strict';

  const PS = () => (typeof PlanSections !== 'undefined' ? PlanSections : (typeof require === 'function' ? require('./plan-sections.js') : null));
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const r2 = v => Math.round(v * 100) / 100;

  let _sl = null;                                                              // tests hand in their own store
  const SL = () => _sl || (typeof AppState !== 'undefined' && AppState.reticulation ? AppState.reticulation.streetLighting : null);

  function list() { const sl = SL(); if (!sl) return []; if (!Array.isArray(sl.roadSections)) sl.roadSections = []; return sl.roadSections; }
  function get(id) { return id ? list().find(s => s.id === id) || null : null; }
  function defId() { const sl = SL(), L = list(), d = sl && sl.settings && sl.settings.roadSectionDef; return L.some(s => s.id === d) ? d : (L[0] ? L[0].id : null); }
  function def() { return get(defId()); }
  function setDef(id) { const sl = SL(); if (sl && get(id)) { sl.settings = sl.settings || {}; sl.settings.roadSectionDef = id; } }

  function nextId() { const L = list(); let n = L.length + 1; while (L.some(s => s.id === 'rs_' + n)) n++; return 'rs_' + n; }
  function stripId(sec) { let n = (sec.strips || []).length + 1; while ((sec.strips || []).some(s => s.id === 'st_' + n)) n++; return 'st_' + n; }
  const strip = (sec, o) => Object.assign({ id: stripId(sec), type: 'verge', name: '', width: 2, lanes: 2, cls: '', surface: 'R3', direction: 'forward' }, o);

  // ── sizes: the project standard and what a section has of its own ──
  const GROUPS = ['off', 'kiosk', 'mh', 'trench'];
  const clone = o => JSON.parse(JSON.stringify(o));
  function sizeGroup(g, src) {
    const P = PS(), out = {}, x = src && typeof src === 'object' ? src : {};
    for (const k of P.SIZES[g]) { const [d, lo, hi] = P.SHAPE[g][k], n = parseFloat(x[k]); out[k] = Number.isFinite(n) ? P.snap(Math.max(lo, Math.min(hi, n))) : d; }
    return out;
  }
  // the offsets from the erf boundary { svc, lv, fi, mv, kiosk, mh }: from a standard's `off` (flat) or a section's items (`items[k].off`)
  function offGroup(src, fromItems) {
    const P = PS(), out = {}, x = src && typeof src === 'object' ? src : {};
    for (const k of P.OFFS) { const [d, lo, hi] = P.SHAPE[k].off, n = parseFloat(fromItems ? (x[k] || {}).off : x[k]); out[k] = Number.isFinite(n) ? P.snap(Math.max(lo, Math.min(hi, n))) : d; }
    return out;
  }
  const normStd = raw => ({ off: offGroup(raw && raw.off), kiosk: sizeGroup('kiosk', raw && raw.kiosk), mh: sizeGroup('mh', raw && raw.mh), trench: PS().trench(raw && raw.trench) });
  // a standard made before it held the offsets: they come from the default section, and every other section whose offsets differ keeps
  // them as its own (so nothing moves)
  function offInit(S) {
    const d0 = def(); S.off = offGroup(d0 && d0.items, true);
    for (const sec of list()) if (sec.items && !own(sec, 'off') && JSON.stringify(offGroup(sec.items, true)) !== JSON.stringify(S.off)) sec.own = Object.assign({}, sec.own || {}, { off: true });
  }
  // the project standard (stored, edited in place); made from the defaults the first time it is asked for
  function std() {
    const sl = SL(), raw = sl && sl.settings && sl.settings.roadStd;
    if (raw && raw.kiosk && raw.mh && raw.trench) { if (!raw.off) offInit(raw); return raw; }
    const s = normStd(raw); if (!(raw && raw.off)) offInit(s); if (sl) { sl.settings = sl.settings || {}; sl.settings.roadStd = s; } return s;
  }
  // set one value of the standard (`group`, `key`; trench keys are '<type>.w' / '<type>.d', offset keys the item: 'off', 'lv'), clamped and snapped
  function setStd(g, key, v) { return setSize(std(), g, key, v); }
  function setSize(holder, g, key, v) {
    const P = PS(), n = parseFloat(v); if (!Number.isFinite(n)) return false;
    if (g === 'trench') {
      const [t, k] = key.split('.'), T = holder.trench || (holder.trench = P.trench()); if (!P.TRENCH[t] || !['w', 'd'].includes(k)) return false;
      const R = k === 'w' ? P.TRENCH_W : P.TRENCH_D; T[t] = T[t] || {}; T[t][k] = P.snap(Math.max(R[0], Math.min(R[1], n))); return true;
    }
    if (g === 'off') {
      if (!P.OFFS.includes(key)) return false;
      const [, lo, hi] = P.SHAPE[key].off, x = P.snap(Math.max(lo, Math.min(hi, n)));
      if (holder === std()) holder.off[key] = x; else (holder.items[key] || (holder.items[key] = {})).off = x;
      return true;
    }
    if (!P.SIZES[g] || !P.SIZES[g].includes(key)) return false;
    const tgt = holder === std() ? holder[g] : holder.items[g], [, lo, hi] = P.SHAPE[g][key];
    tgt[key] = P.snap(Math.max(lo, Math.min(hi, n))); return true;
  }
  const own = (sec, g) => !!(sec && sec.own && sec.own[g]);
  // what a section works with for a group: its own where it differs, else the standard's
  function sizes(sec, g) {
    if (g === 'trench') return own(sec, g) ? PS().trench(sec.trench) : PS().trench(std().trench);
    if (g === 'off') return own(sec, g) ? offGroup(sec.items, true) : offGroup(std().off);
    return own(sec, g) ? sizeGroup(g, sec.items && sec.items[g]) : sizeGroup(g, std()[g]);
  }
  // write a group's values into a section (its own from now on)
  function put(sec, g, v) {
    if (g === 'trench') sec.trench = clone(v);
    else if (g === 'off') for (const k of Object.keys(v)) (sec.items[k] || (sec.items[k] = {})).off = v[k];
    else Object.assign(sec.items[g] || (sec.items[g] = {}), v);
  }
  // this section differs from the standard (`on`: it starts from the standard's values) or follows it again
  function setOwn(sec, g, on) {
    if (!sec || !GROUPS.includes(g)) return;
    sec.own = Object.assign({}, sec.own || {});
    if (on) { if (!sec.own[g]) { const v = sizes(sec, g); sec.own[g] = true; put(sec, g, v); } }
    else { delete sec.own[g]; if (g === 'trench') delete sec.trench; }
    if (!Object.keys(sec.own).length) delete sec.own;
  }
  // copy a group from another section (what that one works with); this one then has it as its own
  function copyFrom(sec, from, g) {
    if (!sec || !from || sec === from || !GROUPS.includes(g)) return false;
    const v = sizes(from, g); setOwn(sec, g, true); put(sec, g, v);
    return true;
  }
  // make a section's own values the standard; the section then follows it
  function toStd(sec, g) {
    if (!own(sec, g)) return false;
    const v = sizes(sec, g), S = std(); S[g] = clone(v); setOwn(sec, g, false); return true;
  }
  // the sections that differ from the standard in a group
  function differing(g) { return list().filter(s => own(s, g)); }

  // the size of a plan trench { w, d, from }: its own override, else its section's where that differs, else the standard (`from` names it)
  function trenchSize(t) {
    const type = t && t.excType, P = PS();
    let sec = null;
    if (t && t.roadId) { const r = roads().find(x => x.id === t.roadId); if (r) sec = of(r); }
    else if (t && t.section) sec = get(t.section);
    const useSec = own(sec, 'trench'), T = useSec ? P.trench(sec.trench) : std().trench;
    const pd = typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.trenchTypes ? PLAN_DEFS.trenchTypes[type] : null;
    const base = T[type] || (pd ? { w: pd.width, d: pd.depth } : { w: 0.5, d: 0.7 });
    const from = T[type] ? (useSec ? sec.name : 'project standard') : 'trench type';
    return { w: +t.widthOverride > 0 ? +t.widthOverride : base.w, d: +t.depthOverride > 0 ? +t.depthOverride : base.d, base, from, sec: useSec ? sec : null };
  }
  // the site plan road a hand-drawn trench lies along: the nearest street centreline to its middle, within 25 m (points in plan px, f = m per px)
  function roadNear(points, f, routes) {
    if (!points || points.length < 2 || !(f > 0)) return null;
    let L = 0; for (let i = 1; i < points.length; i++) L += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    let acc = 0, m = points[0];
    for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], l = Math.hypot(b.x - a.x, b.y - a.y); if (acc + l >= L / 2) { const t = l ? (L / 2 - acc) / l : 0; m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; break; } acc += l; }
    let best = null;
    for (const r of routes || []) {
      if (!r || r.type !== 'street' || !r.points || r.points.length < 2) continue;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1], b = r.points[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / L2)), d = Math.hypot(m.x - (a.x + dx * t), m.y - (a.y + dy * t)) * f;
        if (d <= 25 && (!best || d < best.d)) best = { d, id: r.id };
      }
    }
    return best ? best.id : null;
  }

  // a new section; `strips` in the road-lighting format, else verge 5 / carriageway 7 / verge 5. It follows the standard sizes.
  function make(name, strips, items) {
    const P = PS(), base = P.make('x', 'x');
    const sec = { id: nextId(), name: String(name || 'Road section').slice(0, 60), strips: [], items: items ? P.normalize({ items }).items : base.items };
    for (const s of (strips && strips.length ? strips : [{ type: 'verge', width: 5 }, { type: 'carriageway', width: 7, cls: '' }, { type: 'verge', width: 5 }])) {
      const o = Object.assign({}, s); delete o.id; delete o.sans; sec.strips.push(strip(sec, o));
    }
    return sec;
  }
  function add(name, strips, items) { const s = make(name, strips, items); list().push(s); if (!SL().settings || !get(SL().settings.roadSectionDef)) setDef(s.id); return s; }
  function ensure() { return def() || add('Local road'); }

  // verge A / carriageway / verge B of a section: everything from the first carriageway to the last (a median between them included) is the
  // road; what is before it is A, after it B. A section with no carriageway is all verge: the middle is a road of 0 m.
  function span(sec) {
    let y = 0; const xs = (sec && sec.strips || []).map(s => { const w = Math.max(0, num(s.width, 0)), o = { type: s.type, y0: y, y1: y + w }; y += w; return o; });
    const cw = xs.filter(s => s.type === 'carriageway' && s.y1 > s.y0);
    if (!cw.length) return { a: r2(y / 2), road: 0, b: r2(y / 2), total: r2(y) };
    const k0 = cw[0].y0, k1 = cw[cw.length - 1].y1;
    return { a: r2(k0), road: r2(k1 - k0), b: r2(y - k1), total: r2(y) };
  }

  // ── the road reserve ──
  const total = sec => r2((sec && sec.strips || []).reduce((a, t) => a + Math.max(0, num(t.width, 0)), 0));
  const picked = sec => (sec && +sec.reserve > 0 ? r2(+sec.reserve) : null);
  // the reserve width of a section: the one picked, else what its strips add up to
  function reserve(sec) { return picked(sec) != null ? picked(sec) : total(sec); }
  // the strips fill the picked reserve (always true with none picked)
  function fits(sec) { const p = picked(sec); return p == null || Math.abs(total(sec) - p) < 0.005; }
  // spread a change of `d` m over the verges: `fit` 'both' (shared), 'a' (verge A keeps its width: all on B), 'b' (all on A). On each side the
  // verge strip next to the boundary takes it first, then the other strips outside the carriageway from the boundary in; a side with no strip
  // gets a new verge when it has to grow. Never touches a carriageway or what lies between carriageways. false = it cannot (nothing restored lost)
  function spread(sec, d, fit) {
    const S = sec.strips || (sec.strips = []);
    const cw = S.map((t, i) => (t.type === 'carriageway' && num(t.width, 0) > 0 ? i : -1)).filter(i => i >= 0);
    const first = cw.length ? cw[0] : S.length, last = cw.length ? cw[cw.length - 1] : S.length - 1;
    const side = k => { const idx = k === 'a' ? S.map((_, i) => i).filter(i => i < first) : S.map((_, i) => i).filter(i => i > last).reverse();   // boundary first
      return idx.filter(i => S[i].type === 'verge').concat(idx.filter(i => S[i].type !== 'verge')); };
    const before = JSON.stringify(S);
    const apply = (k, amt) => {
      if (Math.abs(amt) < 0.005) return 0;
      const c = side(k);
      if (amt > 0) {
        if (c.length) { S[c[0]].width = r2(num(S[c[0]].width, 0) + amt); return 0; }
        const v = strip(sec, { type: 'verge', width: r2(amt) }); if (k === 'a') S.unshift(v); else S.push(v); return 0;
      }
      let left = -amt;
      for (const i of c) { const w = num(S[i].width, 0), take = Math.min(w, left); S[i].width = r2(w - take); left = r2(left - take); if (left < 0.005) return 0; }
      return -left;
    };
    let dA = fit === 'a' ? 0 : fit === 'b' ? d : r2(d / 2), dB = r2(d - dA);
    // the cw index can move when a verge is added on side A: work out side B first
    let restB = apply('b', dB), restA = apply('a', dA + restB);
    if (Math.abs(restA) >= 0.005) restA = apply('b', restA);
    if (Math.abs(restA) >= 0.005) { sec.strips.splice(0, sec.strips.length, ...JSON.parse(before)); return false; }
    return true;
  }
  // pick the reserve width (3–80 m): the verges take up the difference. false = the strips that cannot move are already wider
  function setReserve(sec, w, fit) {
    const n = parseFloat(w); if (!sec || !Number.isFinite(n)) return false;
    const v = r2(Math.max(3, Math.min(80, n)));
    if (fit) sec.reserveFit = ['both', 'a', 'b'].includes(fit) ? fit : 'both';
    if (!spread(sec, r2(v - total(sec)), sec.reserveFit || 'both')) return false;
    sec.reserve = v; return true;
  }
  function clearReserve(sec) { if (sec) delete sec.reserve; }
  // strips that no longer add up: the verges take the difference, or the reserve becomes what they add up to
  function fitStrips(sec) { const p = picked(sec); return p != null && spread(sec, r2(p - total(sec)), sec.reserveFit || 'both'); }
  function matchReserve(sec) { if (sec) sec.reserve = total(sec); }
  // a site plan road's reserve width: its own where typed, else its section's picked one (null = neither: the layout assumes its default)
  function reserveOf(props) {
    const p = props || {}; if (+p.width > 0) return { w: +p.width, src: 'own' };
    const sec = get(p.section) || def(), v = picked(sec); return v != null ? { w: v, src: 'section', sec } : { w: null, src: null };
  }
  // roads with a reserve width of their own that is not their section's picked one (by more than 0.25 m); `near` = the section whose reserve is
  // closest to the road's own (within 0.5 m), if another one
  function widthMismatches(secId) {
    const out = [];
    for (const r of roads()) {
      const sec = of(r), p = picked(sec), own = +((r.props || {}).width); if (!sec || p == null || !(own > 0) || Math.abs(own - p) <= 0.25) continue;
      if (secId && sec.id !== secId) continue;
      let near = null; for (const x of list()) { const q = picked(x); if (x !== sec && q != null && Math.abs(q - own) <= 0.5 && (!near || Math.abs(q - own) < Math.abs(picked(near) - own))) near = x; }
      out.push({ route: r, sec, own, want: p, near });
    }
    return out;
  }

  // the lighting design whose rows set the poles of this section: the first design that uses it
  function designOf(sec) {
    const sl = SL(); if (!sec || !sl) return null;
    return (sl.roadDesigns || []).find(d => d && d.section === sec.id) || null;
  }
  // the street light of a section, from its design's first row (pole offset from boundary A, height, arm), or null
  function pole(sec) {
    const des = designOf(sec), row = des && (des.rows || [])[0]; if (!row) return null;
    const s = span(sec), sb = num(row.setback, 0);
    let y = 0, med = null; for (const t of sec.strips || []) { const w = Math.max(0, num(t.width, 0)); if (t.type === 'median' && w > 0 && med == null) med = y + w / 2; y += w; }
    const off = row.side === 'right' ? s.a + s.road + sb : (row.side === 'medianL' || row.side === 'medianR') ? (med != null ? med : s.a + s.road / 2) + sb : s.a - sb;
    return { off: r2(Math.max(0, off)), h: num(row.height, 8), arm: Math.max(0, num(row.overhang, 0)), side: row.side, design: des.name || des.id, designId: des.id };
  }

  // the engine's shape (plan-sections.js): { id, name, strips: { a, road, b }, items }; the pole from the lighting design where one uses it
  // with the sizes it works with (the standard's, or its own where it differs)
  function layoutShape(sec) {
    const s = span(sec), items = JSON.parse(JSON.stringify(sec.items || {})), p = pole(sec);
    if (p) items.pole = Object.assign({}, items.pole || {}, { off: p.off, h: p.h, arm: p.arm });
    items.kiosk = Object.assign({}, items.kiosk || {}, sizes(sec, 'kiosk')); items.mh = Object.assign({}, items.mh || {}, sizes(sec, 'mh'));
    const O = sizes(sec, 'off'); for (const k of Object.keys(O)) items[k] = Object.assign({}, items[k] || {}, { off: O[k] });
    return PS().normalize({ id: sec.id, name: sec.name, strips: { a: Math.max(0.5, s.a), road: Math.max(2, s.road), b: Math.max(0.5, s.b) }, items, trench: sizes(sec, 'trench') }, sec.id);
  }

  // ── roads ──
  function _roads() {
    const out = [], fl = (typeof AppState !== 'undefined' && AppState.planFloors) ? AppState.planFloors() : null;
    if (fl && fl.length) { for (const f of fl) for (const r of ((f.data && f.data.routes) || [])) if (r && r.type === 'street') out.push(r); }
    else if (typeof AppState !== 'undefined' && AppState.planMarkup) for (const r of AppState.planMarkup.routes || []) if (r && r.type === 'street') out.push(r);
    return out;
  }
  let _roadsFn = _roads;
  const roads = () => _roadsFn();
  // the section a site plan road uses: its own pick, else the default (`own` = only its own pick)
  function of(route, own) { const id = route && route.props && route.props.section; const s = get(id); return s || (own ? null : def()); }
  function roadsUsing(id) { const d = defId(); return roads().filter(r => { const p = r.props && r.props.section; return get(p) ? p === id : id === d; }); }
  function assign(routes, id) { for (const r of routes || []) { if (!r) continue; r.props = r.props || {}; if (id && get(id)) r.props.section = id; else delete r.props.section; } }

  // the carriageway of a site plan road: its own (kerbs it was drawn with) where set, else its own section's (a road with no pick and no own
  // width stays without one — the layout assumes its default for it, as before)
  function carriage(props) {
    const p = props || {};
    if (+p.carriageW > 0) return { cw: +p.carriageW, off: +p.cwOffset || 0, src: 'own' };
    const sec = get(p.section); if (!sec) return { cw: 0, off: 0, src: null };
    const s = span(sec); if (!(s.road > 0)) return { cw: 0, off: 0, src: null };
    return { cw: s.road, off: r2((s.b - s.a) / 2), src: 'section', sec };            // + = to the left looking along the road (A is on the left)
  }
  // site plan roads whose own carriageway differs from their section's by more than 0.1 m
  function mismatches() {
    const out = [];
    for (const r of roads()) {
      const p = r.props || {}, sec = get(p.section); if (!sec || !(+p.carriageW > 0)) continue;
      const s = span(sec); if (Math.abs(s.road - +p.carriageW) > 0.1) out.push({ route: r, sec, own: +p.carriageW, want: s.road });
    }
    return out;
  }

  // Auto layout's input.sections: every section in the engine's shape; a road with its own pick is a line over the whole of it
  function forLayout(on) {
    const L = list(); if (!L.length) return null;
    const lines = [];
    for (const r of roads()) { const id = r.props && r.props.section; if (get(id)) lines.push({ id: 'ra_' + r.id, streetId: r.id, s0: 0, s1: 1e9, sec: id }); }
    return { on: on !== false, list: L.map(layoutShape), def: defId(), lines };
  }

  // ── lighting designs ──
  // the strips a design works with: its section's (the same array: editing them edits the section) or its own
  function stripsOf(des) { if (!des) return []; const s = get(des.section); if (s) return s.strips; if (!Array.isArray(des.sections)) des.sections = []; return des.sections; }
  function designsUsing(id) { const sl = SL(); return ((sl && sl.roadDesigns) || []).filter(d => d && d.section === id); }

  function options(withDefault) {
    const d = defId();
    return (withDefault ? [{ value: '', label: 'Default' + (def() ? ' (' + def().name + ')' : '') }] : []).concat(list().map(s => ({ value: s.id, label: s.name + (s.id === d && !withDefault ? ' (default)' : '') })));
  }
  function summary(sec) { return (sec.strips || []).filter(t => num(t.width, 0) > 0).map(t => r2(num(t.width, 0))).join(' + ') + ' m · reserve ' + reserve(sec) + ' m'; }

  function remove(id) {
    const L = list(), i = L.findIndex(s => s.id === id); if (i < 0 || L.length < 2) return false;
    const sec = L[i];
    // a design that used it keeps the strips as its own; roads go back to the default
    for (const d of designsUsing(id)) { d.sections = JSON.parse(JSON.stringify(sec.strips)); delete d.section; }
    for (const r of roads()) if (r.props && r.props.section === id) delete r.props.section;
    const sl = SL(); if (sl && sl.roadPlan) for (const rd of sl.roadPlan.roads || []) if (rd.section === id) delete rd.section;
    L.splice(i, 1);
    if (defId() === id || !get(SL().settings && SL().settings.roadSectionDef)) setDef(L[0].id);
    return true;
  }
  function duplicate(id) { const s = get(id); if (!s) return null; const c = JSON.parse(JSON.stringify(s)); c.id = nextId(); c.name = (s.name + ' copy').slice(0, 60); list().push(c); return c; }

  // ── one-time conversion of an older project ──
  // (1) Auto layout's sections { list, def, lines } in planMarkup.settings.layout.sections → road sections; each road takes the section of the
  //     line that covers most of it; only `on` stays there. (2) every lighting design with strips of its own → a road section (designs with
  //     the same strips share one), the design points at it.
  function migrate(lay, designs, routesById) {
    let changed = false;
    const sl = SL(); if (!sl) return false;
    const old = lay && lay.sections;
    if (old && Array.isArray(old.list) && old.list.length) {
      const map = {};
      for (const o of old.list) {
        const P = PS(), n = P.normalize(o, o.id), t = n.strips;
        const sec = make(n.name, [{ type: 'verge', width: t.a }, { type: 'carriageway', width: t.road }, { type: 'verge', width: t.b }], n.items);
        list().push(sec); map[n.id] = sec.id;
      }
      if (map[old.def]) setDef(map[old.def]); else if (!get((sl.settings || {}).roadSectionDef)) setDef(list()[0].id);
      const best = {};
      for (const l of old.lines || []) {
        if (!l || !map[l.sec]) continue;
        const len = Math.abs(+l.s1 - +l.s0); if (!(len > 0)) continue;
        if (!best[l.streetId] || len > best[l.streetId].len) best[l.streetId] = { len, sec: map[l.sec] };
      }
      for (const [rid, b] of Object.entries(best)) { const r = routesById ? routesById(rid) : roads().find(x => x.id === rid); if (r) assign([r], b.sec); }
      lay.sections = { on: !!old.on };
      changed = true;
    }
    const seen = {};
    for (const d of designs || []) {
      if (!d || get(d.section) || !Array.isArray(d.sections) || !d.sections.length) continue;
      const key = JSON.stringify(d.sections.map(s => [s.type, num(s.width, 0), s.cls || '', s.surface || '', num(s.lanes, 2), s.direction || '']));
      let sec = seen[key] && get(seen[key]);
      if (!sec) { sec = make(d.name || 'Road section', d.sections); list().push(sec); seen[key] = sec.id; if (!get((sl.settings || {}).roadSectionDef)) setDef(sec.id); }
      d.section = sec.id; d.sections = [];
      changed = true;
    }
    return changed;
  }

  // ── once for an older project (no standard yet): the standard from what the project already used, so nothing it made changes ──
  // kiosk / manhole: the default section's. Trench depths: the default section's per-cable depths where Auto layout used sections, else
  // Auto layout's own Trenches depths where it has them, else the plan's old trench-type sizes (hand-drawn trenches keep their size); the
  // widths are the plan's trench-type widths. Every other section whose sizes differ keeps them as its own. The old per-cable depth / width
  // fields are dropped. `hasTrenches`: the project has trenches drawn (else a new project just takes the defaults).
  function migrateStd(lay, hasTrenches) {
    const sl = SL(); if (!sl) return false;
    sl.settings = sl.settings || {};
    if (sl.settings.roadStd && typeof sl.settings.roadStd === 'object') { const had = !!sl.settings.roadStd.off; if (!had) offInit(sl.settings.roadStd); sl.settings.roadStd = normStd(sl.settings.roadStd); return !had; }
    const P = PS(), L = list(), d0 = def(), onSec = !!(lay && lay.sections && lay.sections.on), td = lay && lay.trench && lay.trench.depth;
    const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
    const fromCables = sec => { const it = (sec && sec.items) || {}, mv = n((it.mv || {}).depth), lv = Math.max(n((it.lv || {}).depth) || 0, n((it.svc || {}).depth) || 0) || null, fi = n((it.fi || {}).depth);
      return mv == null || lv == null || fi == null ? null : { 'MV': mv, 'LV/SL': lv, 'FI': fi, 'MV/LV/SL': Math.max(mv, lv) }; };
    let depths = null;
    if (onSec && d0) depths = fromCables(d0);
    if (!depths && td && typeof td === 'object' && n(td.mv) != null) depths = { 'MV': n(td.mv), 'LV/SL': n(td.lv), 'FI': n(td.fi), 'MV/LV/SL': n(td.comb) != null ? n(td.comb) : Math.max(n(td.mv), n(td.lv)) };
    if (!depths && hasTrenches) depths = { 'MV': 1.0, 'LV/SL': 0.8, 'MV/LV/SL': 1.0, 'FI': 0.6 };             // the plan's trench types before the standard
    const tr = P.trench(); if (depths) for (const t of Object.keys(tr)) if (depths[t] != null) tr[t].d = P.trench({ [t]: { d: depths[t] } })[t].d;
    const S = { kiosk: sizeGroup('kiosk', d0 && d0.items && d0.items.kiosk), mh: sizeGroup('mh', d0 && d0.items && d0.items.mh), trench: tr };
    offInit(S); sl.settings.roadStd = S;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const sec of L) {
      if (!sec.items) continue;
      for (const g of ['kiosk', 'mh']) if (!same(sizeGroup(g, sec.items[g]), S[g])) { sec.own = Object.assign({}, sec.own || {}, { [g]: true }); }
      const c = onSec ? fromCables(sec) : null;
      if (c && sec !== d0) { const t2 = clone(tr); for (const t of Object.keys(t2)) t2[t].d = P.trench({ [t]: { d: c[t] } })[t].d; if (!same(t2, tr)) { sec.own = Object.assign({}, sec.own || {}, { trench: true }); sec.trench = t2; } }
      for (const k of ['svc', 'lv', 'fi', 'mv']) if (sec.items[k]) { delete sec.items[k].depth; delete sec.items[k].w; }
    }
    return true;
  }

  return {
    reserve, fits, setReserve, clearReserve, fitStrips, matchReserve, reserveOf, widthMismatches, total,
    std, setStd, setSize, sizes, own, setOwn, copyFrom, toStd, differing, trenchSize, roadNear, migrateStd, GROUPS,
    list, get, defId, def, setDef, make, add, roads, ensure, span, pole, designOf, layoutShape, of, roadsUsing, assign, carriage, mismatches,
    forLayout, stripsOf, designsUsing, options, summary, remove, duplicate, migrate, stripId, strip,
    _use(sl, roadsFn) { _sl = sl || null; _roadsFn = roadsFn || _roads; },                                          // tests
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoadSections;
