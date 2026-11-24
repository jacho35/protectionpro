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

  // a new section; `strips` in the road-lighting format, else verge 5 / carriageway 7 / verge 5
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
  function layoutShape(sec) {
    const s = span(sec), items = JSON.parse(JSON.stringify(sec.items || {})), p = pole(sec);
    if (p) items.pole = Object.assign({}, items.pole || {}, { off: p.off, h: p.h, arm: p.arm });
    return PS().normalize({ id: sec.id, name: sec.name, strips: { a: Math.max(0.5, s.a), road: Math.max(2, s.road), b: Math.max(0.5, s.b) }, items }, sec.id);
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
  function summary(sec) { const s = span(sec); return (sec.strips || []).filter(t => num(t.width, 0) > 0).map(t => r2(num(t.width, 0))).join(' + ') + ' m · reserve ' + s.total + ' m'; }

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

  return {
    list, get, defId, def, setDef, make, add, roads, ensure, span, pole, designOf, layoutShape, of, roadsUsing, assign, carriage, mismatches,
    forLayout, stripsOf, designsUsing, options, summary, remove, duplicate, migrate, stripId, strip,
    _use(sl, roadsFn) { _sl = sl || null; _roadsFn = roadsFn || _roads; },                                          // tests
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoadSections;
