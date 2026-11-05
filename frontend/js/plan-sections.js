/*
 * PlanSections — the street cross-sections of the Auto layout (pure data + geometry, node-testable: testing/unit/sections.test.js).
 *
 * A section is the street seen end-on, with EVERY item placed from the erf boundary (not from the road):
 *   strips   { a, road, b }   verge A, carriageway, verge B in m (the reserve is their sum; its centre is computed, never typed)
 *   items    svc / lv / fi / mv   { off, depth, w }   cable classes: offset from boundary A (m), depth to the bottom (m), trench width (m)
 *            kiosk  { off, h, depth, len, front, end }  near face offset, height, depth across, length along, clear space at the door / each end
 *            pole   { off, h, arm }                     street light
 *            mh     { off, len, wid, depth, wall, lid, clear }  fibre manhole (centre offset, internal size, depth to invert, ...)
 *            sleeve { depth, w }                        road crossing sleeves
 * Offsets are kept to 10 mm (`snap`). A project holds `{ list, def, lines }`: the sections, the default one, and the section lines —
 * polylines drawn over the street line, each read as, per street, the stretch [s0, s1] it runs along (`linesFromPolyline`). The engine
 * (plan-layout.js) takes the same object as `input.sections`.
 */
const PlanSections = (() => {
  'use strict';

  const snap = v => Math.round(v * 100) / 100;                       // 10 mm
  const num = (v, d, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? snap(Math.max(lo, Math.min(hi, n))) : d; };

  // the shape of a section: [group, key, default, min, max]
  const SHAPE = {
    strips: { a: [5, 0.5, 30], road: [7, 2, 40], b: [5, 0.5, 30] },
    svc: { off: [0.4, 0, 10], depth: [0.6, 0.2, 3], w: [0.3, 0.1, 2] },
    lv: { off: [0.9, 0, 10], depth: [0.7, 0.2, 3], w: [0.4, 0.1, 2] },
    fi: { off: [1.7, 0, 10], depth: [0.6, 0.2, 3], w: [0.3, 0.1, 2] },
    mv: { off: [1.6, 0, 10], depth: [1.1, 0.2, 3], w: [0.5, 0.1, 2] },
    kiosk: { off: [1.5, 0, 10], h: [1.05, 0.3, 4], depth: [0.9, 0.3, 4], len: [1.4, 0.3, 6], front: [1.0, 0, 4], end: [0.3, 0, 3] },
    pole: { off: [3.8, 0, 15], h: [8, 3, 20], arm: [1.5, 0, 5] },
    mh: { off: [2.6, 0, 10], len: [1.2, 0.3, 4], wid: [1.2, 0.3, 4], depth: [1.2, 0.3, 4], wall: [0.15, 0.05, 0.5], lid: [0.6, 0.3, 1.5], clear: [0.5, 0, 3] },
    sleeve: { depth: [0.8, 0.2, 3], w: [0.3, 0.1, 2] },
  };

  function make(id, name, over) {
    const sec = { id, name: String(name || 'Section').slice(0, 60), strips: {}, items: {} };
    for (const [g, keys] of Object.entries(SHAPE)) {
      const tgt = g === 'strips' ? sec.strips : (sec.items[g] = {});
      for (const [k, [d]] of Object.entries(keys)) tgt[k] = d;
    }
    return over ? normalize(merge(sec, over), id) : sec;
  }
  function merge(a, b) {
    const out = JSON.parse(JSON.stringify(a));
    for (const g of Object.keys(b || {})) {
      if (g === 'id' || g === 'name') { out[g] = b[g]; continue; }
      if (g === 'strips') Object.assign(out.strips, b.strips || {});
      else if (g === 'items') for (const k of Object.keys(b.items || {})) Object.assign(out.items[k] || (out.items[k] = {}), b.items[k]);
    }
    return out;
  }
  // fill what a saved section lacks, clamp every value, snap to 10 mm
  function normalize(x, id) {
    x = x && typeof x === 'object' ? x : {};
    const sec = { id: String(x.id || id || 'sec_1').slice(0, 40), name: String(x.name || 'Section').slice(0, 60), strips: {}, items: {} };
    for (const [g, keys] of Object.entries(SHAPE)) {
      const src = g === 'strips' ? (x.strips || {}) : ((x.items || {})[g] || {}), tgt = g === 'strips' ? sec.strips : (sec.items[g] = {});
      for (const [k, [d, lo, hi]] of Object.entries(keys)) tgt[k] = num(src[k], d, lo, hi);
    }
    return sec;
  }
  // the project's sections, always valid: at least one section, a default that exists, lines that point at sections
  function state(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const list = (Array.isArray(r.list) ? r.list : []).map((s, i) => normalize(s, 'sec_' + (i + 1)));
    const seen = new Set(); list.forEach(s => { let id = s.id, n = 1; while (seen.has(id)) id = s.id + '_' + (++n); s.id = id; seen.add(id); });
    if (!list.length) list.push(make('sec_1', 'Local street'));
    const def = list.some(s => s.id === r.def) ? r.def : list[0].id;
    const lines = (Array.isArray(r.lines) ? r.lines : []).filter(l => l && typeof l.streetId === 'string' && seen.has(l.sec) && Number.isFinite(+l.s0) && Number.isFinite(+l.s1))
      .map((l, i) => ({ id: String(l.id || 'sl_' + (i + 1)), streetId: l.streetId, s0: +l.s0, s1: +l.s1, sec: l.sec, group: l.group || null }));
    return { list, def, lines };
  }
  const nextId = list => { let n = list.length + 1; while (list.some(s => s.id === 'sec_' + n)) n++; return 'sec_' + n; };

  // ── a polyline drawn over the street line → one stretch per street it runs along ──
  // pts: the polyline [[x, y]…] in m. streets: [{ id, pts, w }]. A sample counts for a street when it is within `tol` m of its centreline
  // (default: the street's width, so a rough line is fine) and its stretch is the range of stations the samples project to.
  function linesFromPolyline(pts, streets, sec, opt) {
    const o = Object.assign({ tol: 0, step: 1 }, opt || {}), out = [];
    if (!pts || pts.length < 2) return out;
    const samples = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / o.step));
      for (let j = (i === 1 ? 0 : 1); j <= n; j++) samples.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
    }
    for (const st of streets) {
      if (!st.pts || st.pts.length < 2) continue;
      const tol = o.tol || Math.max(6, (st.w || 12));
      let lo = Infinity, hi = -Infinity;
      for (const p of samples) { const pr = projectOn(st.pts, p[0], p[1]); if (pr.d <= tol) { if (pr.s < lo) lo = pr.s; if (pr.s > hi) hi = pr.s; } }
      if (hi - lo >= 2) out.push({ streetId: st.id, s0: snap(lo), s1: snap(hi), sec });
    }
    return out;
  }
  function projectOn(pts, x, y) {
    let best = null, cum = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, L = Math.sqrt(L2);
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)), d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
      if (!best || d < best.d) best = { d, s: cum + t * L };
      cum += L;
    }
    return best;
  }
  // which section applies on a street at a station (the last line drawn over it, else the default)
  function at(st, streetId, s) {
    for (let i = st.lines.length - 1; i >= 0; i--) {
      const l = st.lines[i];
      if (l.streetId === streetId && s >= Math.min(l.s0, l.s1) - 0.01 && s <= Math.max(l.s0, l.s1) + 0.01) { const x = st.list.find(q => q.id === l.sec); if (x) return x; }
    }
    return st.list.find(q => q.id === st.def) || st.list[0];
  }
  // lines that overlap on one street (the later one wins; the overlap is flagged)
  function overlaps(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j]; if (a.streetId !== b.streetId || a.sec === b.sec) continue;
      const lo = Math.max(Math.min(a.s0, a.s1), Math.min(b.s0, b.s1)), hi = Math.min(Math.max(a.s0, a.s1), Math.max(b.s0, b.s1));
      if (hi - lo > 0.5) out.push({ streetId: a.streetId, a: a.id, b: b.id, from: lo, to: hi });
    }
    return out;
  }

  // clearances inside one section (m), all measured along the offsets from the boundary
  function checks(sec) {
    const d = sec.items, out = [], f = v => v.toFixed(2);
    const gap = (a, b) => Math.abs(a.off - b.off) - (a.w + b.w) / 2;
    const g1 = gap(d.lv, d.fi); if (g1 < 0.3) out.push({ sev: 'warn', text: `LV to fibre gap ${f(g1)} m (0.30 m wanted).` });
    const g2 = gap(d.lv, d.svc); if (g2 < 0) out.push({ sev: 'warn', text: `Service and LV trenches overlap by ${f(-g2)} m.` });
    const g3 = d.pole.off - (d.kiosk.off + d.kiosk.depth); if (g3 < 1) out.push({ sev: 'warn', text: `Kiosk to pole ${f(g3)} m (1.00 m wanted).` });
    const reserve = sec.strips.a + sec.strips.road + sec.strips.b;
    if (d.kiosk.off + d.kiosk.depth + d.kiosk.front > sec.strips.a) out.push({ sev: 'warn', text: `Kiosk and the clear space in front of its door (${f(d.kiosk.off + d.kiosk.depth + d.kiosk.front)} m) go past the edge of verge A (${f(sec.strips.a)} m).` });
    if (d.pole.off > sec.strips.a) out.push({ sev: 'info', text: `The pole (${f(d.pole.off)} m) stands outside verge A (${f(sec.strips.a)} m).` });
    const mhEdge = d.mh.off + d.mh.len / 2, kBack = d.kiosk.off;
    if (d.mh.off - d.mh.len / 2 - d.mh.clear < 0) out.push({ sev: 'warn', text: `The manhole and its clear space reach back past the boundary by ${f(d.mh.clear - (d.mh.off - d.mh.len / 2))} m.` });
    if (out.length === 0) out.push({ sev: 'ok', text: `Reserve ${f(reserve)} m; clearances inside the section pass.` });
    return out;
  }

  return { SHAPE, snap, make, normalize, state, nextId, linesFromPolyline, projectOn, at, overlaps, checks };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSections;
