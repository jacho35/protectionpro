/* ProtectionPro — SheetPrint: the single line diagram as a set of drawing sheets.
 *
 * A big diagram printed on one page ends up with unreadable text. SheetPrint
 * prints it as sheets instead. Each sheet shows a group of buses (a bus brings
 * its loads, and its feeders from the breaker down) or a saved view (selected
 * parts, or a window on the diagram). Every sheet is drawn at one scale, inside a
 * frame with grid zones (columns 1…, rows A…) and a title block (standard, or
 * formal with drawing number, revisions and sign-off). A wire that leaves a sheet
 * ends in an off-page connector: an outlined flag (OP-01 …) pointing the way
 * power flows, with a caption beside it naming the other sheet, its grid zone and
 * the far bus, breaker and cable. The key plan lists every sheet and connector.
 *
 * `SheetPrint.plan(model, opts)` is pure (node-testable, testing/unit/sheetprint.test.js):
 * it takes plain comps + wires and returns pages with their members, clip, region,
 * scale and connector tags. With `opts.sheets` it lays out a drawing set the user
 * arranged (drawingset.js); without, it proposes one (buses packed while the text
 * stays above the minimum). `pageSVG` / `keyPageSVG` draw a page as an SVG in
 * millimetres — the same SVG is the editor preview and, through VectorPDF, the PDF.
 */

const SheetPrint = {
  PAPERS: { a4: [297, 210], a3: [420, 297], a2: [594, 420], a1: [841, 594] },
  PAPER_ORDER: ['a4', 'a3', 'a2', 'a1'],
  SOURCE_TYPES: new Set(['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery']),
  BASE_PX: 11,            // size of the diagram's name labels, SVG units
  PT_PER_MM: 72 / 25.4,
  MAX_PT: 16,             // never blow the diagram up past this label size
  MARGIN: 10,             // mm, paper edge to the frame
  ZONE: 5,                // mm, the grid-zone band inside the frame
  GAP: 3,                 // mm, inner frame to the drawing
  TB_H: { none: 0, standard: 20, formal: 38 },   // mm, title block height
  EDGE: 20,               // world units kept free around a drawing
  // connector tag, world units (scales with the drawing)
  STUB: 18, FLAG_W: 80, FLAG_H: 30, FLAG_TIP: 12, CAP_GAP: 8, CAP_LINE: 14, CAP_CHAR: 6.4, CAP_WRAP: 28,
  SCREEN_MM_PER_PX: 25.4 / 96,

  defaults() {
    return { paper: 'a3', landscape: true, minPt: 8, maxBuses: 6, keyPlan: true, titleBlock: 'standard', oversize: 'split', scale: 'uniform', cut: 'tags' };
  },

  _opts(options) {
    const o = Object.assign(this.defaults(), options || {});
    if (o.titleBlock === true) o.titleBlock = 'standard';
    if (o.titleBlock === false || !this.TB_H.hasOwnProperty(o.titleBlock)) o.titleBlock = o.titleBlock === false ? 'none' : 'standard';
    if (!this.PAPERS[o.paper]) o.paper = 'a3';
    return o;
  },

  // Paper geometry in mm: frame, drawing area, title block, grid zones
  layout(options) {
    const o = this._opts(options);
    let [pw, ph] = this.PAPERS[o.paper];
    if (!o.landscape) [pw, ph] = [ph, pw];
    const M = this.MARGIN, Z = this.ZONE, G = this.GAP;
    const outer = { x: M, y: M, w: pw - 2 * M, h: ph - 2 * M };
    const inner = { x: M + Z, y: M + Z, w: pw - 2 * (M + Z), h: ph - 2 * (M + Z) };
    const tbH = this.TB_H[o.titleBlock];
    const tb = { x: inner.x, y: inner.y + inner.h - tbH, w: inner.w, h: tbH };
    const draw = { x: inner.x + G, y: inner.y + G, w: inner.w - 2 * G, h: inner.h - tbH - 2 * G };
    const cols = Math.max(4, Math.round(inner.w / 50)), rows = Math.max(3, Math.round(inner.h / 50));
    return { pw, ph, outer, inner, tb, draw, cols, rows };
  },

  zoneAt(L, xmm, ymm) {
    const c = Math.min(L.cols - 1, Math.max(0, Math.floor((xmm - L.inner.x) / (L.inner.w / L.cols))));
    const r = Math.min(L.rows - 1, Math.max(0, Math.floor((ymm - L.inner.y) / (L.inner.h / L.rows))));
    return String.fromCharCode(65 + r) + (c + 1);
  },

  sheetNo(n) { return String(n).padStart(2, '0'); },

  // Caption lines, wrapped at ' · ' so nothing is cut off
  wrap(text) {
    const parts = String(text || '').split(' · ').filter(Boolean);
    const out = [];
    let cur = '';
    for (const p of parts) {
      if (!cur) cur = p;
      else if ((cur + ' · ' + p).length <= this.CAP_WRAP) cur += ' · ' + p;
      else { out.push(cur); cur = p; }
    }
    if (cur) out.push(cur);
    return out.flatMap(l => (l.length <= this.CAP_WRAP + 8 ? [l] : l.match(new RegExp(`.{1,${this.CAP_WRAP}}(\\s|$)|\\S+`, 'g')).map(s => s.trim())));
  },

  // A connector's geometry: stub from the port P along d, the flag (pointing
  // `flow`), and the caption beside it ('r' / 'l' for vertical flags, below for
  // horizontal ones). World units.
  tagGeom(P, d, flow, lines, side, fw) {
    const S = this;
    const FW = fw || S.FLAG_W;
    const L = S.FLAG_H + S.FLAG_TIP;
    const sx = P.x + d.x * S.STUB, sy = P.y + d.y * S.STUB;
    const vertical = d.x === 0;
    let poly, rect, cx, cy;
    if (vertical) {
      const a0 = Math.min(sy, sy + d.y * L), a1 = Math.max(sy, sy + d.y * L);
      const x0 = P.x - FW / 2, x1 = P.x + FW / 2;
      if (flow.y > 0) { poly = [[x0, a0], [x1, a0], [x1, a0 + S.FLAG_H], [P.x, a1], [x0, a0 + S.FLAG_H]]; rect = { x0, y0: a0, x1, y1: a0 + S.FLAG_H }; }
      else { poly = [[P.x, a0], [x1, a0 + S.FLAG_TIP], [x1, a1], [x0, a1], [x0, a0 + S.FLAG_TIP]]; rect = { x0, y0: a0 + S.FLAG_TIP, x1, y1: a1 }; }
    } else {
      const a0 = Math.min(sx, sx + d.x * L), a1 = Math.max(sx, sx + d.x * L);
      const y0 = P.y - S.FLAG_H / 2, y1 = P.y + S.FLAG_H / 2;
      const W = L - S.FLAG_TIP;
      if (flow.x > 0) { poly = [[a0, y0], [a0 + W, y0], [a1, P.y], [a0 + W, y1], [a0, y1]]; rect = { x0: a0, y0, x1: a0 + W, y1 }; }
      else { poly = [[a0, P.y], [a0 + S.FLAG_TIP, y0], [a1, y0], [a1, y1], [a0 + S.FLAG_TIP, y1]]; rect = { x0: a0 + S.FLAG_TIP, y0, x1: a1, y1 }; }
    }
    cx = (rect.x0 + rect.x1) / 2; cy = (rect.y0 + rect.y1) / 2;
    const n = lines.length;
    const capW = Math.max(0, ...lines.map(l => l.length)) * S.CAP_CHAR;
    let cap, text;
    if (vertical && side === 'e') {
      // beyond the flag's end, along the wire
      const top = d.y > 0 ? Math.max(rect.y1, P.y + d.y * (S.STUB + L)) + 4 : Math.min(rect.y0, P.y + d.y * (S.STUB + L)) - 4 - n * S.CAP_LINE;
      cap = { x0: rect.x0, y0: top, x1: rect.x0 + capW, y1: top + n * S.CAP_LINE };
      text = { x: rect.x0, y: top + S.CAP_LINE - 3, anchor: 'start' };
    } else if (vertical) {
      const top = cy - (n * S.CAP_LINE) / 2;
      if (side === 'l') { const x = rect.x0 - S.CAP_GAP; cap = { x0: x - capW, y0: top, x1: x, y1: top + n * S.CAP_LINE }; text = { x, y: top + S.CAP_LINE - 3, anchor: 'end' }; }
      else { const x = rect.x1 + S.CAP_GAP; cap = { x0: x, y0: top, x1: x + capW, y1: top + n * S.CAP_LINE }; text = { x, y: top + S.CAP_LINE - 3, anchor: 'start' }; }
    } else {
      const top = rect.y1 + 4;
      cap = { x0: rect.x0, y0: top, x1: rect.x0 + capW, y1: top + n * S.CAP_LINE };
      text = { x: rect.x0, y: top + S.CAP_LINE - 3, anchor: 'start' };
    }
    const bbox = { x0: Math.min(rect.x0, cap.x0, P.x), y0: Math.min(rect.y0, cap.y0, P.y), x1: Math.max(rect.x1, cap.x1, P.x), y1: Math.max(rect.y1, cap.y1, P.y) };
    return { poly, rect, cx, cy, cap, text, bbox, stub: { x1: P.x, y1: P.y, x2: sx, y2: sy } };
  },

  _overlap(a, b) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
  },

  // ── Pure planning ─────────────────────────────────────────────

  // model = { comps:[{id,type,name,x,y,bbox:{x0,y0,x1,y1},switching,cable}],
  //           wires:[{id,a,b,pa,pb,pts?}] }
  // opts.sheets (a drawing set, in order): [{id, kind:'buses', buses:[…], title?}
  //   | {id, kind:'view', title?, view:{kind:'parts', parts:[…]} | {kind:'window', window:{x,y,w,h}}}]
  // opts.fixed (proposal only): bus groups kept as they are; the rest is packed
  plan(model, options) {
    const S = this;
    const o = S._opts(options);
    const L = S.layout(o);
    const availW = L.draw.w, availH = L.draw.h;
    const kMax = S.MAX_PT / (S.BASE_PX * S.PT_PER_MM);
    const empty = (error) => ({ error, pages: [], connectors: [], oversized: [], unassigned: [], keyPages: 0, paper: o.paper, landscape: o.landscape, opts: o, layout: L, pageMM: [L.pw, L.ph], availMM: [availW, availH], minPt: 0 });

    const comps = new Map(model.comps.map(c => [c.id, c]));
    const wires = model.wires.filter(w => comps.has(w.a) && comps.has(w.b) && w.a !== w.b);
    const adj = new Map(model.comps.map(c => [c.id, []]));
    wires.forEach(w => { adj.get(w.a).push(w.b); adj.get(w.b).push(w.a); });
    const buses = model.comps.filter(c => c.type === 'bus');
    const hasViews = (o.sheets || []).some(s => s.kind === 'view');
    if (!buses.length && !hasViews) return empty('no-buses');

    // depth from the sources: which side of a link is upstream
    const depth = new Map();
    const q = [];
    for (const c of model.comps) if (S.SOURCE_TYPES.has(c.type)) { depth.set(c.id, 0); q.push(c.id); }
    while (q.length) {
      const id = q.shift();
      for (const n of adj.get(id)) if (!depth.has(n)) { depth.set(n, depth.get(id) + 1); q.push(n); }
    }
    const dp = (id) => (depth.has(id) ? depth.get(id) : 1e6);

    // which buses each non-bus component hangs from (flooding through non-bus parts)
    const reach = new Map();
    for (const b of buses) {
      const seen = new Set([b.id]);
      const st = [b.id];
      while (st.length) {
        const id = st.pop();
        for (const n of adj.get(id)) {
          if (comps.get(n).type === 'bus' || seen.has(n)) continue;
          seen.add(n);
          if (!reach.has(n)) reach.set(n, new Set());
          reach.get(n).add(b.id);
          st.push(n);
        }
      }
    }
    const unitOf = new Map();
    const linkIds = new Set();
    for (const [id, set] of reach) { if (set.size === 1) unitOf.set(id, [...set][0]); else linkIds.add(id); }
    buses.forEach(b => unitOf.set(b.id, b.id));
    if (buses.length) {
      for (const c of model.comps) {   // not wired to any bus: with the nearest one
        if (unitOf.has(c.id) || linkIds.has(c.id)) continue;
        let best = buses[0], bd = Infinity;
        for (const b of buses) { const d = (b.x - c.x) ** 2 + (b.y - c.y) ** 2; if (d < bd) { bd = d; best = b; } }
        unitOf.set(c.id, best.id);
      }
    }

    // chains: the parts between two buses, cut just after the first switching device
    const chains = [];
    const ties = [];
    const busSendFirst = (x, y) => (dp(x) < dp(y) || (dp(x) === dp(y) && x < y) ? [x, y] : [y, x]);
    const seenL = new Set();
    for (const start of linkIds) {
      if (seenL.has(start)) continue;
      const group = [];
      const st = [start];
      seenL.add(start);
      while (st.length) {
        const id = st.pop();
        group.push(id);
        for (const n of adj.get(id)) if (linkIds.has(n) && !seenL.has(n)) { seenL.add(n); st.push(n); }
      }
      const bs = new Set();
      group.forEach(g => reach.get(g).forEach(x => bs.add(x)));
      let ordered = null;
      if (bs.size === 2) {
        const [Sb, Rb] = busSendFirst(...bs);
        const gs = new Set(group);
        const first = group.filter(g => adj.get(g).includes(Sb));
        if (first.length === 1) {
          const list = [first[0]];
          let ok = true;
          for (;;) {
            const cur = list[list.length - 1];
            const nx = adj.get(cur).filter(n => gs.has(n) && !list.includes(n));
            if (!nx.length) break;
            if (nx.length > 1) { ok = false; break; }
            list.push(nx[0]);
          }
          if (ok && list.length === group.length && adj.get(list[list.length - 1]).includes(Rb)) ordered = { S: Sb, R: Rb, comps: list.map(id => comps.get(id)) };
        }
      }
      if (ordered) chains.push(ordered);
      else ties.push({ buses: [...bs], comps: group });
    }
    for (const w of wires) {   // a wire straight from bus to bus
      if (comps.get(w.a).type === 'bus' && comps.get(w.b).type === 'bus') {
        const [Sb, Rb] = busSendFirst(w.a, w.b);
        chains.push({ S: Sb, R: Rb, comps: [] });
      }
    }
    for (const ch of chains) ch.cut = ch.comps.length && ch.comps[0].switching ? 1 : 0;

    // buses that must share a sheet (tie groups)
    const parent = new Map(buses.map(b => [b.id, b.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    ties.forEach(t => t.buses.forEach(b => parent.set(find(b), find(t.buses[0]))));
    const tieOf = (b) => buses.filter(x => find(x.id) === find(b)).map(x => x.id);

    const membersOf = (bs) => {
      const ids = new Set();
      for (const [id, b] of unitOf) if (bs.has(b)) ids.add(id);
      for (const ch of chains) {
        const hasS = bs.has(ch.S), hasR = bs.has(ch.R);
        if (hasS && hasR) ch.comps.forEach(c => ids.add(c.id));
        else if (hasS) ch.comps.slice(0, ch.cut).forEach(c => ids.add(c.id));
        else if (hasR) ch.comps.slice(ch.cut).forEach(c => ids.add(c.id));
      }
      for (const t of ties) if (t.buses.some(b => bs.has(b))) t.comps.forEach(id => ids.add(id));
      return ids;
    };
    const inClip = (clip, p) => !clip || (p.x >= clip.x0 - 0.5 && p.x <= clip.x1 + 0.5 && p.y >= clip.y0 - 0.5 && p.y <= clip.y1 + 0.5);
    const bboxOf = (ids, clip) => {
      const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      ids.forEach(id => {
        let { x0, y0, x1, y1 } = comps.get(id).bbox;
        if (clip) { x0 = Math.max(x0, clip.x0); x1 = Math.min(x1, clip.x1); y0 = Math.max(y0, clip.y0); y1 = Math.min(y1, clip.y1); if (x1 < x0 || y1 < y0) return; }
        bb.x0 = Math.min(bb.x0, x0); bb.y0 = Math.min(bb.y0, y0); bb.x1 = Math.max(bb.x1, x1); bb.y1 = Math.max(bb.y1, y1);
      });
      return bb;
    };
    const dirFrom = (w, endIsA) => {
      const pts = (w.pts && w.pts.length > 1 ? w.pts : [w.pa, w.pb]);
      const seq = endIsA ? pts : pts.slice().reverse();
      let dx = 0, dy = 0;
      for (let i = 1; i < seq.length && !dx && !dy; i++) { dx = seq[i].x - seq[0].x; dy = seq[i].y - seq[0].y; }
      return Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
    };
    const dirOf = (inc, oth) => (dp(oth) < dp(inc) ? 'FROM' : dp(oth) > dp(inc) ? 'TO' : (oth < inc ? 'FROM' : 'TO'));
    // what a page's drawing covers, connectors included (the same allowance the
    // final layout uses, so a sheet judged to fit really does)
    const extentOf = (ids, clip, cont, tagsOn) => {
      const bb = bboxOf(ids, clip);
      if (tagsOn) {
        for (const w of wires) {
          const A = ids.has(w.a) && inClip(clip, w.pa), B = ids.has(w.b) && inClip(clip, w.pb);
          if (A === B) continue;
          const P = A ? w.pa : w.pb;
          const d = dirFrom(w, A);
          const g = S.tagGeom(P, d, d, ['TO SHEET 00 · A1', (comps.get(A ? w.b : w.a).name || '').slice(0, S.CAP_WRAP)], 'r');
          bb.x0 = Math.min(bb.x0, g.bbox.x0); bb.y0 = Math.min(bb.y0, g.bbox.y0); bb.x1 = Math.max(bb.x1, g.bbox.x1); bb.y1 = Math.max(bb.y1, g.bbox.y1);
        }
      }
      for (const c of cont || []) {
        const bus = comps.get(c.bus);
        const P = c.axis === 'x' ? { x: c.at, y: bus.y } : { x: bus.x, y: c.at };
        const sgn = c.edge === 'hi' ? 1 : -1;
        const d = c.axis === 'x' ? { x: sgn, y: 0 } : { x: 0, y: sgn };
        const g = S.tagGeom({ x: P.x - d.x * S.STUB, y: P.y - d.y * S.STUB }, d, d, ['CONTINUES ON SHEET 00 · A1', bus.name || ''], 'r');
        bb.x0 = Math.min(bb.x0, g.bbox.x0); bb.y0 = Math.min(bb.y0, g.bbox.y0); bb.x1 = Math.max(bb.x1, g.bbox.x1); bb.y1 = Math.max(bb.y1, g.bbox.y1);
      }
      if (!isFinite(bb.x0)) return { x0: 0, y0: 0, x1: 100, y1: 100 };
      return { x0: bb.x0 - S.EDGE, y0: bb.y0 - S.EDGE, x1: bb.x1 + S.EDGE, y1: bb.y1 + S.EDGE };
    };
    const fitOf = (bb) => {
      const k = Math.min(availW / (bb.x1 - bb.x0), availH / (bb.y1 - bb.y0), kMax);
      return { k, pt: S.BASE_PX * k * S.PT_PER_MM };
    };
    const connected = (bsA, bsB) => chains.some(ch => (bsA.has(ch.S) && bsB.has(ch.R)) || (bsA.has(ch.R) && bsB.has(ch.S)));
    const parentOf = (gs) => {
      let best = null;
      for (const ch of chains) if (gs.has(ch.R) && !gs.has(ch.S) && (!best || dp(ch.S) < dp(best))) best = ch.S;
      return best;
    };
    const fitsBuses = (bs) => fitOf(extentOf(membersOf(bs), null, null, true)).pt >= o.minPt;

    // ── which buses go on which sheet ──
    let sheetSpecs;            // [{id, kind, buses:Set} | {id, kind:'view', view, title}]
    const unassigned = [];
    if (o.sheets) {
      sheetSpecs = [];
      const taken = new Map();
      for (const sh of o.sheets) {
        if (sh.kind === 'view') { sheetSpecs.push({ id: sh.id, kind: 'view', view: sh.view || {}, title: sh.title || '' }); continue; }
        const bs = new Set();
        for (const b of sh.buses || []) {
          if (!comps.has(b) || comps.get(b).type !== 'bus' || taken.has(b)) continue;
          for (const t of tieOf(b)) if (!taken.has(t)) { bs.add(t); taken.set(t, sh.id); }
        }
        sheetSpecs.push({ id: sh.id, kind: 'buses', buses: bs, title: sh.title || '' });
      }
      buses.forEach(b => { if (!taken.has(b.id)) unassigned.push(b.id); });
    } else {
      const fixedOf = new Map();
      (o.fixed || []).forEach((g, i) => (g.buses || g).forEach(b => { if (comps.has(b)) tieOf(b).forEach(t => fixedOf.set(t, i)); }));
      const groupsMap = new Map();
      buses.forEach(b => {
        const r = fixedOf.has(b.id) ? 'fixed:' + fixedOf.get(b.id) : find(b.id);
        if (!groupsMap.has(r)) groupsMap.set(r, []);
        groupsMap.get(r).push(b.id);
      });
      const groups = [...groupsMap.entries()].map(([key, ids]) => ({
        key, buses: ids, fixed: key.startsWith('fixed:'),
        id: key.startsWith('fixed:') ? ((o.fixed[+key.slice(6)] || {}).id || null) : null,
        depth: Math.min(...ids.map(dp)),
        x: Math.min(...ids.map(i => comps.get(i).x)),
      })).sort((a, b) => a.depth - b.depth || a.x - b.x);
      const sheets = [];
      for (const g of groups) {
        const gs = new Set(g.buses);
        let placed = false;
        if (!g.fixed) {
          const par = parentOf(gs);
          const cands = sheets.filter(sh => !sh.fixed && (connected(sh.buses, gs) || (par && sh.parents.has(par))));
          for (const sh of cands) {
            if (sh.buses.size + gs.size > o.maxBuses) continue;
            const bs = new Set([...sh.buses, ...gs]);
            if (fitsBuses(bs)) { gs.forEach(b => sh.buses.add(b)); if (par) sh.parents.add(par); placed = true; break; }
          }
          if (!placed) sheets.push({ buses: gs, parents: new Set(par ? [par] : []), fixed: false });
        } else sheets.push({ id: g.id, buses: gs, parents: new Set(), fixed: true });
      }
      sheetSpecs = sheets.map((sh, i) => ({ id: sh.id || 'auto_' + (i + 1), kind: 'buses', buses: sh.buses, title: '', fixed: sh.fixed }));
    }

    // ── pages: one per sheet; an oversized bus sheet splits (or is reported) ──
    const oversized = [];
    const pages = [];
    const mkPage = (spec, ids, clip, extra) => Object.assign({ id: spec.id, kind: spec.kind, buses: spec.buses ? [...spec.buses] : [], ids, clip: clip || null, cont: [], tagsOn: true, title: spec.title || '' }, extra || {});
    const wireCount = (cIds, side) => {
      let n = 0;
      for (const w of wires) if (cIds.has(w.a) && cIds.has(w.b) && side(w.a) !== side(w.b)) n++;
      return n;
    };
    const finalFit = (pg) => fitOf(extentOf(pg.ids, pg.clip, pg.cont, pg.tagsOn));
    // cut across the longest bus, so a busbar never loses its feeders
    const splitAxisOf = (pg) => {
      const bb = bboxOf(pg.ids, pg.clip);
      let axis = (bb.x1 - bb.x0) >= (bb.y1 - bb.y0) ? 'x' : 'y';
      let longest = 0;
      pg.ids.forEach(id => {
        const c = comps.get(id);
        if (c.type !== 'bus') return;
        const w = c.bbox.x1 - c.bbox.x0, h = c.bbox.y1 - c.bbox.y0;
        if (Math.max(w, h) > longest) { longest = Math.max(w, h); axis = w >= h ? 'x' : 'y'; }
      });
      return axis;
    };
    const splitPage = (pg, level) => {
      const bb = bboxOf(pg.ids, pg.clip);
      const axis = splitAxisOf(pg);
      const lo0 = axis === 'x' ? bb.x0 : bb.y0, hi0 = axis === 'x' ? bb.x1 : bb.y1;
      const cen = (id) => (axis === 'x' ? comps.get(id).x : comps.get(id).y);
      const span = (id) => { const b = comps.get(id).bbox; return axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1]; };
      let best = null;
      for (let i = 6; i <= 14; i++) {
        const c = lo0 + (hi0 - lo0) * i / 20;
        const side = (id) => (cen(id) < c ? 0 : 1);
        let straddle = 0;
        pg.ids.forEach(id => { const [l, h] = span(id); if (comps.get(id).type !== 'bus' && l < c && h > c) straddle++; });
        const score = wireCount(pg.ids, side) * 10 + straddle * 40 + Math.abs(i - 10) * 2;
        if (!best || score < best.score) best = { c, score };
      }
      const c = best.c;
      const base = pg.clip || { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
      const mk = (hiSide) => {
        const ids = new Set();
        const inSide = (id) => (hiSide ? cen(id) >= c : cen(id) < c);
        pg.ids.forEach(id => {
          const [l, h] = span(id);
          if (inSide(id) || (comps.get(id).type === 'bus' && l < c && h > c)) ids.add(id);
        });
        const clip = Object.assign({}, base);
        if (axis === 'x') { if (hiSide) clip.x0 = c; else clip.x1 = c; } else if (hiSide) clip.y0 = c; else clip.y1 = c;
        return mkPage(pg, ids, clip, { splitAt: c, splitAxis: axis, buses: pg.buses, kind: pg.kind, title: pg.title });
      };
      const A = mk(false), B = mk(true);
      for (const id of A.ids) {
        const cm = comps.get(id);
        const [l, h] = span(id);
        if (cm.type === 'bus' && l < c && h > c && B.ids.has(id)) {
          const key = `${id}@${level}:${Math.round(c)}`;
          A.cont.push({ bus: id, edge: 'hi', at: c, axis, key });
          B.cont.push({ bus: id, edge: 'lo', at: c, axis, key });
        }
      }
      // connectors of an earlier cut stay with the piece that still touches that edge
      for (const e of pg.cont) {
        for (const [X, hiSide] of [[A, false], [B, true]]) {
          if (!X.ids.has(e.bus)) continue;
          if (e.axis !== axis || (e.edge === 'hi') === hiSide) X.cont.push(e);
        }
      }
      return [A, B];
    };
    const settle = (pg, level) => {
      const f = finalFit(pg);
      const label = () => (pg.title || pg.buses.map(b => comps.get(b).name || b).join(', '));
      if (f.pt >= o.minPt || o.oversize !== 'split' || level >= 3 || pg.kind === 'view') {
        if (f.pt < o.minPt - 1e-9) oversized.push({ id: pg.id, buses: pg.buses.map(b => comps.get(b).name || b), title: label(), pt: f.pt });
        return [pg];
      }
      // a split only helps along a bus: cut across a busbar that is too long.
      // A sheet too TALL for the paper stays whole (portrait or larger paper).
      const ext = extentOf(pg.ids, pg.clip, pg.cont, pg.tagsOn);
      const binding = availW / (ext.x1 - ext.x0) < availH / (ext.y1 - ext.y0) ? 'x' : 'y';
      if (splitAxisOf(pg) !== binding) { oversized.push({ id: pg.id, buses: pg.buses.map(b => comps.get(b).name || b), title: label(), pt: f.pt, tall: binding === 'y' }); return [pg]; }
      const [A, B] = splitPage(pg, level);
      if (!A.ids.size || !B.ids.size) { oversized.push({ id: pg.id, buses: pg.buses.map(b => comps.get(b).name || b), title: label(), pt: f.pt }); return [pg]; }
      return [...settle(A, level + 1), ...settle(B, level + 1)];
    };
    for (const spec of sheetSpecs) {
      if (spec.kind === 'view') {
        const v = spec.view;
        let ids, clip = null;
        let win = null;
        if (v.kind === 'window' && v.window) {
          const r = v.window;
          win = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
          if (o.cut === 'edge') {
            // a CAD-style viewport: everything it overlaps, cut at the frame
            clip = win;
            ids = new Set(model.comps.filter(c => c.bbox.x1 > win.x0 && c.bbox.x0 < win.x1 && c.bbox.y1 > win.y0 && c.bbox.y0 < win.y1).map(c => c.id));
          } else {
            // the parts whose centre is inside, drawn whole; wires out end in tags
            ids = new Set(model.comps.filter(c => c.x >= win.x0 && c.x <= win.x1 && c.y >= win.y0 && c.y <= win.y1).map(c => c.id));
          }
        } else ids = new Set((v.parts || []).filter(id => comps.has(id)));
        const pg = mkPage(spec, ids, clip, { viewKind: v.kind === 'window' ? 'window' : 'parts', tagsOn: o.cut !== 'edge' });
        if (win) pg.window = win;
        pages.push(...settle(pg, 0));
        continue;
      }
      if (!spec.buses.size) continue;
      pages.push(...settle(mkPage(spec, membersOf(spec.buses), null), 0));
    }

    // ── numbering (provisional: the key plan's length settles it below) ──
    pages.forEach((pg, i) => { pg.index = i; pg.no = 2 + i; });
    const busPages = pages.filter(p => p.kind === 'buses');
    const present = (pg, id, p) => pg.ids.has(id) && inClip(pg.clip, p);
    const chainOf = new Map();
    chains.forEach(ch => ch.comps.forEach(c => chainOf.set(c.id, ch)));
    const nameOf = (id) => (comps.get(id).name || id);
    const pageOfBusSheets = (id, P, except) => busPages.find(p => p !== except && present(p, id, P)) || busPages.find(p => p !== except && p.ids.has(id));
    const farBus = (otherId, dir) => {
      const oc = comps.get(otherId);
      if (oc.type === 'bus') return otherId;
      const ch = chainOf.get(otherId);
      if (ch) return dir === 'FROM' ? ch.S : ch.R;
      return unitOf.get(otherId) || otherId;
    };
    const devicesOf = (w) => {
      const ch = chainOf.get(w.a) || chainOf.get(w.b);
      const list = ch ? ch.comps : [comps.get(w.a), comps.get(w.b)];
      const cb = list.find(c => c.type === 'cb' || c.type === 'fuse');
      const cab = list.find(c => c.cable);
      return { breaker: cb ? cb.name : '', cable: cab ? cab.name : '' };
    };
    const opIds = new Map();
    const opId = (key) => { if (!opIds.has(key)) opIds.set(key, 'OP-' + String(opIds.size + 1).padStart(2, '0')); return opIds.get(key); };
    const connectors = new Map();

    // ── tags (world units), placed beside free space ──
    for (const pg of pages) {
      pg.wires = new Set(); pg.tags = [];
      const obstacles = [...pg.ids].map(id => [id, comps.get(id).bbox]);
      // the wires drawn whole on this page count as obstacles too
      const segBoxes = (pts) => {
        const out = [];
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          out.push({ x0: Math.min(a.x, b.x) - 3, y0: Math.min(a.y, b.y) - 3, x1: Math.max(a.x, b.x) + 3, y1: Math.max(a.y, b.y) + 3 });
        }
        return out;
      };
      const segs = [];
      for (const w of wires) if (present(pg, w.a, w.pa) && present(pg, w.b, w.pb)) segs.push(...segBoxes(w.pts && w.pts.length > 1 ? w.pts : [w.pa, w.pb]));
      // Try each anchor along the wire (its port, then each bend towards the far
      // end) and each side; the first spot clear of parts and other tags wins.
      const place = (cands, flowOf, lines, extra, incId) => {
        let best = null;
        const cost = (g) => {
          let c = 0;
          for (const [id, b] of obstacles) { c += S._overlap(g.cap, b); if (id !== incId || g.atBend) c += S._overlap(g.rect, b); }
          for (const x of pg.tags) {
            c += 2 * (S._overlap(g.cap, x.rect) + S._overlap(g.rect, x.rect) + S._overlap(g.cap, x.cap) + S._overlap(g.rect, x.cap));
            for (const b of x.segs || []) c += S._overlap(g.cap, b) + S._overlap(g.rect, b);
          }
          for (const b of segs) c += S._overlap(g.cap, b) + S._overlap(g.rect, b);
          return c;
        };
        for (let ci = 0; ci < cands.length && !(best && best.cost === 0); ci++) {
          const c = cands[ci];
          for (const side of (c.d.x === 0 ? ['r', 'l', 'e'] : ['r'])) {
            const g = S.tagGeom(c.P, c.d, flowOf(c.d), lines, side, extra.fw);
            g.atBend = !!c.path;
            let k = cost(g) + ci * 0.01 + (side === 'e' ? 0.02 : 0);
            if (c.path) for (const b of segBoxes(c.path)) for (const x of pg.tags) k += S._overlap(b, x.rect) + S._overlap(b, x.cap);
            if (!best || k < best.cost) best = { g, cost: k < 0.5 ? 0 : k, c };
            if (best.cost === 0 && best.g === g) break;
          }
        }
        const tag = Object.assign({}, best.g, extra, { lines, path: best.c.path, segs: best.c.path ? segBoxes(best.c.path) : [] });
        if (tag.path) tag.path.forEach(p => { tag.bbox = { x0: Math.min(tag.bbox.x0, p.x), y0: Math.min(tag.bbox.y0, p.y), x1: Math.max(tag.bbox.x1, p.x), y1: Math.max(tag.bbox.y1, p.y) }; });
        pg.tags.push(tag);
        return tag;
      };
      const anchorsOf = (w, A) => {
        const pts = (w.pts && w.pts.length > 1 ? w.pts : [w.pa, w.pb]);
        const seq = A ? pts : pts.slice().reverse();
        const dirAt = (i) => {
          const a = seq[i], b = seq[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          return Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
        };
        const out = [{ P: A ? w.pa : w.pb, d: dirFrom(w, A), path: null }];
        for (let i = 1; i < seq.length - 1; i++) {
          if (Math.hypot(seq[i].x - seq[i - 1].x, seq[i].y - seq[i - 1].y) < 1) continue;
          if (!inClip(pg.clip, seq[i])) break;
          out.push({ P: seq[i], d: dirAt(i), path: seq.slice(0, i + 1) });
        }
        // several leaving wires from one point (a bus junction): start at the
        // bend nearest the far end, where each wire is on its own
        const key = `${Math.round(out[0].P.x)},${Math.round(out[0].P.y)}`;
        if (out.length > 1 && (startCount.get(key) || 0) > 1) return out.slice(1).reverse().concat([out[0]]);
        return out;
      };
      const startCount = new Map();
      for (const w of wires) {
        const A = present(pg, w.a, w.pa), B = present(pg, w.b, w.pb);
        if (A === B) continue;
        const P = A ? w.pa : w.pb;
        const key = `${Math.round(P.x)},${Math.round(P.y)}`;
        startCount.set(key, (startCount.get(key) || 0) + 1);
      }
      for (const w of wires) {
        const A = present(pg, w.a, w.pa), B = present(pg, w.b, w.pb);
        if (A && B) { pg.wires.add(w.id); continue; }
        if (!A && !B) continue;
        if (!pg.tagsOn) { if (pg.viewKind === 'window') pg.wires.add(w.id); continue; }
        const inc = A ? w.a : w.b, oth = A ? w.b : w.a;
        const cands = anchorsOf(w, A);
        const dir = dirOf(inc, oth);
        const flowOf = (d) => (dir === 'TO' ? d : { x: -d.x, y: -d.y });
        const fb = farBus(oth, dir);
        const dev = devicesOf(w);
        if (pg.kind === 'view') {
          // grey continuation: names the next part, and its sheet when the set has one
          const far = pageOfBusSheets(oth, A ? w.pb : w.pa, null);
          const nm = nameOf(oth);
          const flagText = nm.length <= 10 ? nm : nm.slice(0, 9) + '…';
          const lines = [(dir === 'TO' ? 'to ' : 'from ') + (comps.get(fb) ? nameOf(fb) : nm)];
          if (nm.length > 10) lines.unshift(nm);
          if (far) lines.push(`sheet ${S.sheetNo(far.no)}`);
          else if (o.sheets && busPages.length) lines.push('not on a sheet');
          const fw = Math.max(44, flagText.length * 8.2 + 16);
          place(cands, (d) => d, lines.flatMap(l => S.wrap(l)), { kind: 'grey', flagText, dir, wire: w.id, farPage: far || null, fw }, inc);
          continue;
        }
        const id = opId('w:' + w.id);
        const far = pageOfBusSheets(oth, A ? w.pb : w.pa, pg);
        const ref = [nameOf(fb), dev.breaker, dev.cable].filter((x, i, arr) => x && arr.indexOf(x) === i).join(' · ');
        const lines = [(far ? `${dir} SHEET ${S.sheetNo(far.no)} · A1` : `${dir} — not on a sheet`), ...S.wrap(ref)];
        place(cands, flowOf, lines, { fw: 0, kind: 'op', id, flagText: id, dir, wire: w.id, farPage: far || null, sheet: far ? far.no : null, bus: nameOf(fb), ref }, inc);
        if (!connectors.has(id)) connectors.set(id, { id, breaker: dev.breaker, cable: dev.cable, from: null, to: null });
        const cn = connectors.get(id);
        const ownBus = comps.get(inc).type === 'bus' ? inc : (chainOf.get(inc) ? (dir === 'TO' ? chainOf.get(inc).S : chainOf.get(inc).R) : unitOf.get(inc));
        const end = { bus: nameOf(ownBus || inc), page: pg, tag: pg.tags[pg.tags.length - 1] };
        if (dir === 'TO') cn.from = end; else cn.to = end;
      }
      // the busbar of a split bus continues through a connector
      for (const c of pg.cont) {
        const bus = comps.get(c.bus);
        const id = opId('c:' + c.key);
        const dir = c.edge === 'hi' ? 'TO' : 'FROM';
        const at = c.axis === 'x' ? { x: c.at, y: bus.y } : { x: bus.x, y: c.at };
        const sgn = c.edge === 'hi' ? 1 : -1;
        const d = c.axis === 'x' ? { x: sgn, y: 0 } : { x: 0, y: sgn };
        const P = { x: at.x - d.x * S.STUB, y: at.y - d.y * S.STUB };
        const other = pages.find(p => p !== pg && p.cont.some(x => x.key === c.key));
        const flow = c.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 };
        const lines = [`${dir === 'TO' ? 'CONTINUES ON' : 'CONTINUED FROM'} SHEET ${other ? S.sheetNo(other.no) : '–'} · A1`, ...S.wrap(nameOf(c.bus))];
        place([{ P, d, path: null }], () => flow, lines, { kind: 'bus', cont: true, id, flagText: id, dir, farPage: other || null, sheet: other ? other.no : null, bus: nameOf(c.bus), noStub: true }, c.bus);
        if (!connectors.has(id)) connectors.set(id, { id, breaker: '', cable: '', from: null, to: null, busbar: true });
        const cn = connectors.get(id);
        const end = { bus: nameOf(c.bus), page: pg, tag: pg.tags[pg.tags.length - 1] };
        if (dir === 'TO') cn.from = end; else cn.to = end;
      }
    }

    // ── scale: one for the whole set (the tightest sheet decides) or each sheet fitted ──
    for (const pg of pages) {
      const bb = bboxOf(pg.ids, pg.clip);
      if (!isFinite(bb.x0)) Object.assign(bb, { x0: 0, y0: 0, x1: 100, y1: 100 });
      pg.tags.forEach(t => { bb.x0 = Math.min(bb.x0, t.bbox.x0); bb.x1 = Math.max(bb.x1, t.bbox.x1); bb.y0 = Math.min(bb.y0, t.bbox.y0); bb.y1 = Math.max(bb.y1, t.bbox.y1); });
      pg.bbox = { x0: bb.x0 - S.EDGE, y0: bb.y0 - S.EDGE, x1: bb.x1 + S.EDGE, y1: bb.y1 + S.EDGE };
      pg.kFit = fitOf(pg.bbox).k;
    }
    // a sheet too big for the minimum text gets its own (smaller) scale, so it
    // does not shrink the whole set below the minimum
    let kSet = null;
    const kMin = o.minPt / (S.BASE_PX * S.PT_PER_MM);
    if (o.scale === 'uniform' && pages.length) kSet = Math.max(kMin, Math.min(...pages.map(p => p.kFit)));
    if (o.fixedK) kSet = o.fixedK;
    for (const pg of pages) {
      const k = kSet ? Math.min(kSet, pg.kFit) : pg.kFit;
      const rw = availW / k, rh = availH / k;
      const cx = (pg.bbox.x0 + pg.bbox.x1) / 2, cy = (pg.bbox.y0 + pg.bbox.y1) / 2;
      pg.k = k;
      pg.pt = S.BASE_PX * k * S.PT_PER_MM;
      pg.region = { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh };
      pg.scalePct = Math.round(k / S.SCREEN_MM_PER_PX * 100);
      const toMM = (x, y) => [L.draw.x + (x - pg.region.x) * k, L.draw.y + (y - pg.region.y) * k];
      pg.tags.forEach(t => { t.zone = S.zoneAt(L, ...toMM(t.cx, t.cy)); });
    }

    // the index's real length is known now: number the sheets after the key plan pages
    const keyPagesFinal = o.keyPlan ? S.keyPageCount(L, pages.length, connectors.size) : 0;
    pages.forEach((pg, i) => { pg.no = keyPagesFinal + 1 + i; });

    // ── captions name the far sheet and its tag's zone ──
    const farTag = (t, pg) => {
      if (!t.farPage) return null;
      if (t.kind === 'grey') {
        return t.farPage.tags.find(x => x.wire === t.wire) || null;
      }
      return t.farPage.tags.find(x => x.id === t.id && x !== t) || null;
    };
    for (const pg of pages) {
      for (const t of pg.tags) {
        if (t.kind !== 'grey') t.sheet = t.farPage ? t.farPage.no : null;
        const ft = farTag(t, pg);
        const z = ft ? ft.zone : null;
        if (t.kind === 'op' && t.farPage) t.lines[0] = `${t.dir} SHEET ${S.sheetNo(t.farPage.no)}${z ? ' · ' + z : ''}`;
        if (t.kind === 'bus') t.lines[0] = `${t.dir === 'TO' ? 'CONTINUES ON' : 'CONTINUED FROM'} SHEET ${t.farPage ? S.sheetNo(t.farPage.no) : '–'}${z ? ' · ' + z : ''}`;
        if (t.kind === 'grey' && t.farPage) {
          const zz = ft ? ft.zone : S.zoneAt(L, L.draw.x + L.draw.w / 2, L.draw.y + L.draw.h / 2);
          t.lines[t.lines.length - 1] = `sheet ${S.sheetNo(t.farPage.no)}${ft ? ' · ' + zz : ''}`;
        }
      }
    }
    const conList = [...connectors.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => {
      const out = { id: c.id, breaker: c.breaker, cable: c.cable, busbar: !!c.busbar, from: null, to: null };
      if (c.from) out.from = { sheet: c.from.page.no, bus: c.from.bus, zone: c.from.tag.zone };
      if (c.to) out.to = { sheet: c.to.page.no, bus: c.to.bus, zone: c.to.tag.zone };
      return out;
    });

    // titles
    for (const pg of pages) {
      if (!pg.title) {
        const names = pg.buses.map(nameOf);
        pg.title = names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') : 'View';
      }
      if (pg.splitAt !== undefined) pg.part = true;
    }
    return {
      pages, oversized, unassigned, paper: o.paper, landscape: o.landscape, opts: o, layout: L,
      pageMM: [L.pw, L.ph], availMM: [availW, availH], keyPages: keyPagesFinal,
      connectors: conList,
      minPt: pages.length ? Math.min(...pages.map(p => p.pt)) : 0,
      k: kSet,
      ties: ties.map(t => t.buses),
      parentOf: (b) => parentOf(new Set([b])),
    };
  },

  // Key plan + index: how many pages the tables need (pure). The first page has
  // one column beside the plan; later pages two. A heading takes ~2 rows.
  KEY_ROW: 4.6, KEY_HEAD: 10.5,
  _keyCaps(L) {
    const usable = L.draw.h - 6 - 2 * this.KEY_HEAD;
    return { first: Math.floor(usable / this.KEY_ROW) + 2, cont: Math.floor(usable / this.KEY_ROW) };
  },
  keyPageCount(L, nSheets, nConn) {
    const rows = 2 + nSheets + (nConn ? 1 + nConn : 0);
    const cap = this._keyCaps(L);
    if (rows <= cap.first) return 1;
    return 1 + Math.ceil((rows - cap.first) / (2 * cap.cont));
  },

  // Smallest paper size (from `from` up) at which no sheet needs splitting
  fitPaper(model, opts) {
    const order = this.PAPER_ORDER;
    for (let i = Math.max(0, order.indexOf(opts.paper)); i < order.length; i++) {
      const p = this.plan(model, Object.assign({}, opts, { paper: order[i], oversize: 'keep' }));
      if (!p.oversized.length) return order[i];
    }
    return order[order.length - 1];
  },

  // ── Browser: the model from the live diagram ───────────────────
  buildModel() {
    const pageComps = AppState.getActivePageComponents();
    const live = Components.topologyWires ? Components.topologyWires() : [...AppState.wires.values()];
    const wireEls = document.getElementById('wires-layer');
    const nums = (d) => { const n = (d || '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []; const p = []; for (let i = 0; i + 1 < n.length; i += 2) p.push({ x: +n[i], y: +n[i + 1] }); return p; };
    const comps = [];
    for (const c of pageComps.values()) {
      const def = COMPONENT_DEFS[c.type];
      if (!def) continue;
      let w = c.type === 'bus' ? ((c.props && c.props.busWidth) || def.width) : def.width, h = def.height;
      if (Math.round(((c.rotation || 0) % 180) / 90) % 2 === 1) [w, h] = [h, w];
      const isBus = c.type === 'bus';
      comps.push({
        id: c.id, type: c.type, name: (c.props && c.props.name) || c.id, x: c.x, y: c.y,
        switching: c.type === 'cb' || c.type === 'switch' || c.type === 'fuse',
        cable: c.type === 'cable',
        bbox: { x0: c.x - w / 2 - 12, x1: c.x + w / 2 + (isBus ? 12 : 70), y0: c.y - h / 2 - 12, y1: c.y + h / 2 + 34 },
      });
    }
    const ids = new Set(comps.map(c => c.id));
    const wires = [];
    for (const w of live) {
      if (!ids.has(w.fromComponent) || !ids.has(w.toComponent)) continue;
      const fc = AppState.components.get(w.fromComponent), tc = AppState.components.get(w.toComponent);
      const pa = Symbols.getPortWorldPosition(fc, w.fromPort), pb = Symbols.getPortWorldPosition(tc, w.toPort);
      const el = wireEls && wireEls.querySelector(`.sld-wire[data-id="${CSS.escape(w.id)}"]`);
      wires.push({ id: w.id, a: w.fromComponent, b: w.toComponent, pa, pb, pts: el ? nums(el.getAttribute('d')) : null });
    }
    return { comps, wires };
  },

  // ── Browser: drawing ───────────────────────────────────────────
  _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

  // The export clone with every computed style written onto the elements, so
  // the copies need no stylesheet (preview, svg2pdf and rasteriser alike).
  prepareBase() {
    const r = Project._prepareExportSVG(20);
    // what is selected on the canvas prints like everything else
    r.clone.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    VectorPDF.inlineStyles(r.clone);
    r.layer = r.clone.querySelector('#diagram-layer');
    r.defs = r.clone.querySelector('defs');
    return r;
  },

  _tagSVG(t) {
    const S = this, e = S._esc;
    const grey = t.kind === 'grey';
    const ink = grey ? '#3b4250' : '#8a3205';
    let s = '';
    if (t.path && t.path.length > 1) s += `<polyline points="${e(t.path.map(p => `${p.x},${p.y}`).join(' '))}" fill="none" stroke="#333333" stroke-width="2"/>`;
    if (!t.noStub) s += `<line x1="${Number(t.stub.x1)}" y1="${Number(t.stub.y1)}" x2="${Number(t.stub.x2)}" y2="${Number(t.stub.y2)}" stroke="#1b1f24" stroke-width="1.6"/>`;
    s += `<polygon points="${e(t.poly.map(p => p.join(',')).join(' '))}" fill="#ffffff" stroke="${grey ? '#5c6672' : '#b84a0b'}" stroke-width="1.8"/>`;
    s += `<text x="${t.rect.x0 + (t.rect.x1 - t.rect.x0) / 2}" y="${t.rect.y0 + (t.rect.y1 - t.rect.y0) / 2 + 4.5}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12.5" font-weight="bold" fill="${ink}">${e(t.flagText)}</text>`;
    t.lines.forEach((ln, i) => {
      const first = i === 0 && !grey;
      s += `<text x="${Number(t.text.x)}" y="${t.text.y + i * S.CAP_LINE}" text-anchor="${t.text.anchor === 'end' ? 'end' : 'start'}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="${first ? 'bold' : 'normal'}" fill="${e(first ? '#8a3205' : (grey ? '#555555' : '#333333'))}">${e(ln)}</text>`;
    });
    return s;
  },

  // The diagram cut down to one page, as an <svg> placed at the drawing area
  _drawingSVG(base, pg, L, uid) {
    const NS = 'http://www.w3.org/2000/svg';
    const keep = new Set(pg.ids);
    const inner = document.createElementNS(NS, 'svg');
    const r = pg.region;
    inner.setAttribute('x', L.draw.x); inner.setAttribute('y', L.draw.y);
    inner.setAttribute('width', L.draw.w); inner.setAttribute('height', L.draw.h);
    inner.setAttribute('viewBox', `${r.x} ${r.y} ${r.w} ${r.h}`);
    inner.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    inner.setAttribute('overflow', 'hidden');
    const layer = base.layer.cloneNode(true);
    layer.removeAttribute('id');
    layer.removeAttribute('transform');
    layer.querySelectorAll('.sld-component[data-id]').forEach(g => { if (!keep.has(g.getAttribute('data-id'))) g.remove(); });
    layer.querySelectorAll('[data-comp-id]').forEach(el => { if (!keep.has(el.getAttribute('data-comp-id'))) el.remove(); });
    layer.querySelectorAll('.sld-wire[data-id]').forEach(p => { if (!pg.wires.has(p.getAttribute('data-id'))) p.remove(); });
    layer.querySelectorAll('[data-wire-id]').forEach(el => { if (!pg.wires.has(el.getAttribute('data-wire-id'))) el.remove(); });
    layer.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    if (pg.clip) {
      const c = pg.clip, B = 1e6;
      const x0 = isFinite(c.x0) ? c.x0 : -B, y0 = isFinite(c.y0) ? c.y0 : -B, x1 = isFinite(c.x1) ? c.x1 : B, y1 = isFinite(c.y1) ? c.y1 : B;
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML = `<clipPath id="spc-${uid}"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/></clipPath>`;
      inner.appendChild(defs);
      layer.setAttribute('clip-path', `url(#spc-${uid})`);
    }
    inner.appendChild(layer);
    const tags = document.createElementNS(NS, 'g');
    tags.innerHTML = pg.tags.map(t => this._tagSVG(t)).join('');
    inner.appendChild(tags);
    return inner;
  },

  _frameSVG(L) {
    const f = (n) => +n.toFixed(2);
    let s = `<rect x="0" y="0" width="${L.pw}" height="${L.ph}" fill="#ffffff"/>`;
    s += `<rect x="${L.outer.x}" y="${L.outer.y}" width="${L.outer.w}" height="${L.outer.h}" fill="none" stroke="#1b1f24" stroke-width="0.5"/>`;
    s += `<rect x="${L.inner.x}" y="${L.inner.y}" width="${L.inner.w}" height="${L.inner.h}" fill="none" stroke="#1b1f24" stroke-width="0.25"/>`;
    const cw = L.inner.w / L.cols, rh = L.inner.h / L.rows;
    const lab = (x, y, t) => `<text x="${f(x)}" y="${f(y)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="2.6" fill="#444444">${t}</text>`;
    let d = '';
    for (let i = 0; i < L.cols; i++) {
      const x = L.inner.x + i * cw;
      if (i) d += `M${f(x)} ${L.outer.y}V${L.inner.y}M${f(x)} ${L.inner.y + L.inner.h}V${L.outer.y + L.outer.h}`;
      s += lab(x + cw / 2, L.outer.y + 3.6, i + 1) + lab(x + cw / 2, L.outer.y + L.outer.h - 1.4, i + 1);
    }
    for (let j = 0; j < L.rows; j++) {
      const y = L.inner.y + j * rh;
      if (j) d += `M${L.outer.x} ${f(y)}H${L.inner.x}M${L.inner.x + L.inner.w} ${f(y)}H${L.outer.x + L.outer.w}`;
      const ch = String.fromCharCode(65 + j);
      s += lab(L.outer.x + 2.5, y + rh / 2 + 0.9, ch) + lab(L.outer.x + L.outer.w - 2.5, y + rh / 2 + 0.9, ch);
    }
    s += `<path d="${this._esc(d)}" stroke="#1b1f24" stroke-width="0.25" fill="none"/>`;
    return s;
  },

  // info: {project, details, set, total, date}
  _titleBlockSVG(L, o, cell, info) {
    if (o.titleBlock === 'none') return '';
    const e = this._esc, tb = L.tb, f = (n) => +n.toFixed(2);
    const ink = '#1b1f24';
    const fit = (t, w, size) => { t = String(t || ''); const max = Math.floor(w / (size * 0.52)); return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t; };
    const box = (x, y, w, h, label, value, sub, vSize) => {
      vSize = vSize || 3.4;
      let s = `<text x="${f(x + 2)}" y="${f(y + 3.6)}" font-family="Arial, Helvetica, sans-serif" font-size="1.9" fill="#555555">${e(label)}</text>`;
      if (value) s += `<text x="${f(x + 2)}" y="${f(y + 3.8 + vSize * 1.1)}" font-family="Arial, Helvetica, sans-serif" font-size="${vSize}" font-weight="bold" fill="${ink}">${e(fit(value, w - 4, vSize))}</text>`;
      if (sub) s += `<text x="${f(x + 2)}" y="${f(y + h - 2.4)}" font-family="Arial, Helvetica, sans-serif" font-size="2.3" fill="#555555">${e(fit(sub, w - 4, 2.3))}</text>`;
      return s;
    };
    const line = (x1, y1, x2, y2, w) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${ink}" stroke-width="${Number(w || 0.25)}"/>`;
    const d = info.details || {};
    const projSub = [d.projectNumber, d.client].filter(Boolean).join(' · ');
    let s = line(tb.x, tb.y, tb.x + tb.w, tb.y, 0.4);
    if (o.titleBlock === 'standard') {
      const fr = [0.42, 0.24, 0.09, 0.10, 0.15];
      let x = tb.x;
      const vals = [
        ['DRAWING', cell.title, cell.sub],
        ['PROJECT', info.project, projSub],
        ['SCALE', 'NTS', `${o.paper.toUpperCase()} ${o.landscape ? 'landscape' : 'portrait'}`],
        ['SHEET', `${this.sheetNo(cell.no)} of ${this.sheetNo(info.total)}`, cell.dwgNo || ''],
        ['DATE · REVISION', info.date, info.rev ? `Rev ${info.rev}` : ''],
      ];
      fr.forEach((w, i) => {
        const cw = tb.w * w;
        if (i) s += line(x, tb.y, x, tb.y + tb.h);
        s += box(x, tb.y, cw, tb.h, ...vals[i], i === 0 ? 3.8 : 3.2);
        x += cw;
      });
      return s;
    }
    // formal: logo | client / project | title / drawing no. + rev | revisions / sign-off + sheet
    const h2 = tb.h / 2, W = tb.w;
    const cx = [0, 0.13, 0.35, 0.59, 0.66, 1].map(v => tb.x + W * v);
    s += line(cx[1], tb.y, cx[1], tb.y + tb.h) + line(cx[2], tb.y, cx[2], tb.y + tb.h) + line(cx[4], tb.y, cx[4], tb.y + tb.h);
    s += line(cx[3], tb.y + h2, cx[3], tb.y + tb.h);
    s += line(cx[1], tb.y + h2, cx[3], tb.y + h2) + line(cx[3], tb.y + h2, cx[4], tb.y + h2) + line(cx[4], tb.y + h2, cx[5], tb.y + h2);
    if (d.companyLogo) s += `<image x="${f(cx[0] + 2)}" y="${f(tb.y + 2)}" width="${f(cx[1] - cx[0] - 4)}" height="${f(tb.h - 9)}" preserveAspectRatio="xMidYMid meet" href="${e(d.companyLogo)}"/>`;
    s += `<text x="${f(cx[0] + 2)}" y="${f(tb.y + tb.h - 2.6)}" font-family="Arial, Helvetica, sans-serif" font-size="2.6" font-weight="bold" fill="${ink}">${e(fit(d.company || '', cx[1] - cx[0] - 4, 2.6))}</text>`;
    s += box(cx[1], tb.y, cx[2] - cx[1], h2, 'CLIENT', d.client || '–', '');
    s += box(cx[1], tb.y + h2, cx[2] - cx[1], h2, 'PROJECT', info.project, d.projectNumber ? `Project no. ${d.projectNumber}` : '');
    s += box(cx[2], tb.y, cx[4] - cx[2], h2, 'DRAWING TITLE', cell.title, cell.sub);
    s += box(cx[2], tb.y + h2, cx[3] - cx[2], h2, 'DRAWING NO.', cell.dwgNo || '–', '', 3.8);
    s += box(cx[3], tb.y + h2, cx[4] - cx[3], h2, 'REV', info.rev || '–', '', 5);
    // revisions: newest at the top, as many as fit
    const rx = cx[4], rw = cx[5] - cx[4];
    const rc = [0, 0.08, 0.27, 0.80, 0.90, 1].map(v => rx + rw * v);
    const rowH = 3.6;
    const hdr = ['REV', 'DATE', 'DESCRIPTION', 'BY', 'CHK'];
    hdr.forEach((t, i) => { s += `<text x="${f(rc[i] + 1.2)}" y="${f(tb.y + 3)}" font-family="Arial, Helvetica, sans-serif" font-size="1.9" fill="#555555">${t}</text>`; });
    s += `<line x1="${f(rx)}" y1="${f(tb.y + 4.2)}" x2="${f(rx + rw)}" y2="${f(tb.y + 4.2)}" stroke="#8a929c" stroke-width="0.2"/>`;
    const revs = (info.revisions || []).slice().reverse().slice(0, Math.floor((h2 - 4.5) / rowH));
    revs.forEach((r, j) => {
      const y = tb.y + 4.2 + rowH * (j + 1) - 0.9;
      [r.rev, r.date, r.desc, r.by, r.chk].forEach((t, i) => { s += `<text x="${f(rc[i] + 1.2)}" y="${f(y)}" font-family="Arial, Helvetica, sans-serif" font-size="2.3" font-weight="${i === 0 ? 'bold' : 'normal'}" fill="${ink}">${e(fit(t, rc[i + 1] - rc[i] - 2, 2.3))}</text>`; });
    });
    const sc = [0, 0.25, 0.5, 0.75, 1].map(v => rx + rw * v);
    const sign = [['DRAWN', d.engineerName], ['CHECKED', d.checkedBy], ['APPROVED', d.approvedBy]];
    sign.forEach(([lab, v], i) => { if (i) s += line(sc[i], tb.y + h2, sc[i], tb.y + tb.h); s += box(sc[i], tb.y + h2, sc[i + 1] - sc[i], h2, lab, v || '–', '', 2.8); });
    s += line(sc[3], tb.y + h2, sc[3], tb.y + tb.h);
    s += box(sc[3], tb.y + h2, sc[4] - sc[3], h2, 'SHEET', `${this.sheetNo(cell.no)} / ${this.sheetNo(info.total)}`, `NTS · ${o.paper.toUpperCase()}`, 3.4);
    return s;
  },

  _stampSVG(L, status) {
    if (!status) return '';
    const w = Math.max(30, status.length * 2.6 + 8), x = L.draw.x + L.draw.w - w, y = L.draw.y + 1;
    return `<rect x="${x}" y="${y}" width="${w}" height="8" fill="#ffffff" stroke="#1b1f24" stroke-width="0.5"/><text x="${x + w / 2}" y="${y + 5.6}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="3.4" font-weight="bold" fill="#1b1f24">${this._esc(status.toUpperCase())}</text>`;
  },

  _svgRoot(L) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('viewBox', `0 0 ${L.pw} ${L.ph}`);
    svg.setAttribute('width', L.pw);
    svg.setAttribute('height', L.ph);
    return svg;
  },

  // A sheet as an SVG in millimetres. cell: {title, sub, no, dwgNo}
  pageSVG(plan, pg, base, info, uid) {
    const L = plan.layout, o = plan.opts;
    const svg = this._svgRoot(L);
    svg.innerHTML = this._frameSVG(L);
    if (base.defs) svg.appendChild(base.defs.cloneNode(true));
    svg.appendChild(this._drawingSVG(base, pg, L, uid || pg.index));
    const cell = info.cellOf ? info.cellOf(pg) : { title: pg.title, sub: '', no: pg.no, dwgNo: '' };
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = this._titleBlockSVG(L, o, cell, info) + (o.titleBlock === 'formal' ? this._stampSVG(L, info.status) : '');
    svg.appendChild(g);
    return svg;
  },

  // Key plan page(s): the whole diagram with each sheet outlined, then the sheet
  // index and the connector index (continued on further pages when long).
  keyPageSVG(plan, base, info, part) {
    const L = plan.layout, o = plan.opts, e = this._esc, f = (n) => +n.toFixed(2);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = this._svgRoot(L);
    svg.innerHTML = this._frameSVG(L);
    const D = L.draw;
    const rows = [];
    rows.push({ head: 'SHEET INDEX', cols: ['SHEET', 'TITLE', 'SHOWS'], w: [0.14, 0.46, 0.40] });
    rows.push({ cells: [this.sheetNo(1), 'Key plan & index', 'Whole diagram'] });
    plan.pages.forEach(pg => rows.push({ cells: [this.sheetNo(pg.no), info.cellOf ? (info.cellOf(pg).short || info.cellOf(pg).title) : pg.title, pg.kind === 'view' ? (pg.viewKind === 'window' ? 'Window' : 'Selected parts') : (pg.buses.map(b => (info.busName ? info.busName(b) : b)).join(', ') + (pg.part ? ' (part)' : ''))] }));
    if (plan.connectors.length) {
      rows.push({ head: 'OFF-PAGE CONNECTORS', cols: ['NO.', 'FROM', 'TO', 'BREAKER', 'CABLE'], w: [0.14, 0.17, 0.33, 0.18, 0.18] });
      plan.connectors.forEach(c => rows.push({ cells: [c.id, c.from ? `${this.sheetNo(c.from.sheet)} · ${c.from.zone}` : '–', c.to ? `${this.sheetNo(c.to.sheet)} · ${c.to.zone} · ${c.to.bus}` : '–', c.breaker || '–', c.busbar ? 'busbar' : (c.cable || '–')] }));
    }
    // split the rows over the pages: first page beside the plan, the rest in two columns
    const R = this.KEY_ROW;
    const caps = this._keyCaps(L);
    const firstCap = caps.first, contCap = caps.cont;
    const chunks = [];
    let i = 0;
    chunks.push([{ x: D.x + D.w * 0.6, w: D.w * 0.4, rows: rows.slice(0, firstCap) }]); i = firstCap;
    while (i < rows.length) {
      const a = rows.slice(i, i + contCap); i += contCap;
      const b = rows.slice(i, i + contCap); i += contCap;
      chunks.push([{ x: D.x, w: D.w * 0.48, rows: a }, { x: D.x + D.w * 0.52, w: D.w * 0.48, rows: b }]);
    }
    const mine = chunks[part] || [];
    let s = '';
    let lastHead = null;
    // a continued table repeats its heading
    const headBefore = (idx) => { for (let j = idx; j >= 0; j--) if (rows[j].head) return rows[j]; return null; };
    let rowIndex = chunks.slice(0, part).reduce((n, c) => n + c.reduce((m, col) => m + col.rows.length, 0), 0);
    for (const col of mine) {
      let y = D.y + 6;
      let head = headBefore(rowIndex);
      for (const [ri, r] of col.rows.entries()) {
        if (r.head || ri === 0) {
          const h = r.head ? r : head;
          if (h) {
            if (ri && r.head) y += 4;
            s += `<text x="${f(col.x)}" y="${f(y)}" font-family="Arial, Helvetica, sans-serif" font-size="3.4" font-weight="bold" fill="#1b1f24">${e(h.head)}${r.head ? '' : ' (continued)'}</text>`;
            y += 4.4;
            let x = col.x;
            h.cols.forEach((c, k) => { s += `<text x="${f(x + 1)}" y="${f(y)}" font-family="Arial, Helvetica, sans-serif" font-size="2.2" fill="#444444">${c}</text>`; x += col.w * h.w[k]; });
            y += 1.4;
            s += `<line x1="${f(col.x)}" y1="${f(y)}" x2="${f(col.x + col.w)}" y2="${f(y)}" stroke="#1b1f24" stroke-width="0.35"/>`;
            head = h; lastHead = h;
          }
          if (r.head) { rowIndex++; continue; }
        }
        y += R;
        let x = col.x;
        r.cells.forEach((c, k) => {
          const cw = col.w * head.w[k];
          const max = Math.floor((cw - 2) / (2.6 * 0.52));
          const t = String(c); const tt = t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t;
          s += `<text x="${f(x + 1)}" y="${f(y - 1.3)}" font-family="Arial, Helvetica, sans-serif" font-size="2.6" font-weight="${k === 0 ? 'bold' : 'normal'}" fill="${k === 0 && head.head === 'OFF-PAGE CONNECTORS' ? '#8a3205' : '#1b1f24'}">${e(tt)}</text>`;
          x += cw;
        });
        s += `<line x1="${f(col.x)}" y1="${f(y)}" x2="${f(col.x + col.w)}" y2="${f(y)}" stroke="#b8bec6" stroke-width="0.15"/>`;
        rowIndex++;
      }
    }
    void lastHead;
    const g = document.createElementNS(NS, 'g');
    g.innerHTML = s;
    svg.appendChild(g);

    if (part === 0) {
      // the whole diagram, each sheet's area outlined
      const area = { x: D.x, y: D.y + 9, w: D.w * 0.57, h: D.h - 9 };
      const head = document.createElementNS(NS, 'g');
      head.innerHTML = `<text x="${D.x}" y="${D.y + 4}" font-family="Arial, Helvetica, sans-serif" font-size="3.6" font-weight="bold" fill="#1b1f24">KEY PLAN</text><text x="${D.x}" y="${D.y + 7.6}" font-family="Arial, Helvetica, sans-serif" font-size="2.3" fill="#444444">The whole single line diagram. Each outline is what one sheet shows.</text><line x1="${f(D.x + D.w * 0.585)}" y1="${D.y}" x2="${f(D.x + D.w * 0.585)}" y2="${D.y + D.h}" stroke="#1b1f24" stroke-width="0.2"/>`;
      svg.appendChild(head);
      const inner = document.createElementNS(NS, 'svg');
      inner.setAttribute('x', area.x); inner.setAttribute('y', area.y); inner.setAttribute('width', area.w); inner.setAttribute('height', area.h);
      inner.setAttribute('viewBox', `${base.minX} ${base.minY} ${base.svgW} ${base.svgH}`);
      inner.setAttribute('preserveAspectRatio', 'xMidYMin meet');
      const layer = base.layer.cloneNode(true);
      layer.removeAttribute('id'); layer.removeAttribute('transform');
      layer.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      layer.setAttribute('opacity', '0.75');
      inner.appendChild(layer);
      const kk = Math.min(area.w / base.svgW, area.h / base.svgH);   // mm per world unit
      const u = (mm) => mm / kk;
      let ov = '';
      plan.pages.forEach(pg => {
        const c = pg.clip || {};
        let b = pg.window ? { x0: pg.window.x0, y0: pg.window.y0, x1: pg.window.x1, y1: pg.window.y1 } : null;
        if (!b) {
          b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          pg.ids.forEach(id => { const bb = info.bboxOf(id); if (!bb) return; b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0); b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1); });
          if (isFinite(c.x0)) b.x0 = Math.max(b.x0, c.x0); if (isFinite(c.x1)) b.x1 = Math.min(b.x1, c.x1);
          if (isFinite(c.y0)) b.y0 = Math.max(b.y0, c.y0); if (isFinite(c.y1)) b.y1 = Math.min(b.y1, c.y1);
        }
        if (!isFinite(b.x0)) return;
        const view = pg.kind === 'view';
        const col = view ? '#6f42c1' : '#b84a0b';
        ov += `<rect x="${Number(b.x0)}" y="${Number(b.y0)}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="${u(1).toFixed(3)}" fill="${view ? 'none' : 'rgba(184,74,11,0.05)'}" stroke="${col}" stroke-width="${u(0.35).toFixed(3)}" stroke-dasharray="${e(view ? `${u(0.6)} ${u(0.9)}` : `${u(1.8)} ${u(1.2)}`)}"/>`;
        ov += `<rect x="${Number(b.x0)}" y="${Number(b.y0)}" width="${u(6).toFixed(3)}" height="${u(4).toFixed(3)}" rx="${u(0.6).toFixed(3)}" fill="${view ? '#ffffff' : col}" stroke="${col}" stroke-width="${u(0.3).toFixed(3)}"/>`;
        ov += `<text x="${(b.x0 + u(3)).toFixed(3)}" y="${(b.y0 + u(3)).toFixed(3)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${u(2.6).toFixed(3)}" font-weight="bold" fill="${view ? col : '#ffffff'}">${this.sheetNo(pg.no)}</text>`;
      });
      const og = document.createElementNS(NS, 'g');
      og.innerHTML = ov;
      inner.appendChild(og);
      svg.appendChild(inner);
    }
    const tbg = document.createElementNS(NS, 'g');
    const cell = { title: part ? 'Key plan & index (continued)' : 'Key plan & index', sub: `${info.setName || ''}${info.setName ? ' · ' : ''}${plan.pages.length} sheets · ${plan.connectors.length} connectors`, no: part + 1, dwgNo: info.keyDwgNo ? info.keyDwgNo(part) : '' };
    tbg.innerHTML = this._titleBlockSVG(L, o, cell, info) + (o.titleBlock === 'formal' ? this._stampSVG(L, info.status) : '');
    svg.appendChild(tbg);
    return svg;
  },

  // A plain crop of one page for PNG / SVG / DXF: a fresh export clone (`r` from
  // Project._prepareExportSVG) cut to the page's parts, its tags added, framed on
  // what is drawn. Keeps the clone's layers, classes and stylesheet.
  cropClone(r, pg) {
    const NS = 'http://www.w3.org/2000/svg';
    const clone = r.clone;
    const layer = clone.querySelector('#diagram-layer');
    const keep = new Set(pg.ids);
    layer.querySelectorAll('.sld-component[data-id]').forEach(g => { if (!keep.has(g.getAttribute('data-id'))) g.remove(); });
    layer.querySelectorAll('[data-comp-id]').forEach(el => { if (!keep.has(el.getAttribute('data-comp-id'))) el.remove(); });
    layer.querySelectorAll('.sld-wire[data-id]').forEach(p => { if (!pg.wires.has(p.getAttribute('data-id'))) p.remove(); });
    layer.querySelectorAll('[data-wire-id]').forEach(el => { if (!pg.wires.has(el.getAttribute('data-wire-id'))) el.remove(); });
    clone.querySelectorAll('.export-schedule').forEach(g => g.remove());
    if (pg.clip) {
      const c = pg.clip, B = 1e6;
      const x0 = isFinite(c.x0) ? c.x0 : -B, y0 = isFinite(c.y0) ? c.y0 : -B, x1 = isFinite(c.x1) ? c.x1 : B, y1 = isFinite(c.y1) ? c.y1 : B;
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML = `<clipPath id="spc-crop"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/></clipPath>`;
      clone.insertBefore(defs, clone.firstChild);
      ['#wires-layer', '#components-layer', '#annotations-layer'].forEach(sel => { const g = layer.querySelector(sel); if (g) g.setAttribute('clip-path', 'url(#spc-crop)'); });
    }
    const tags = document.createElementNS(NS, 'g');
    tags.setAttribute('data-dxf-layer', 'CONNECTORS');
    tags.innerHTML = pg.tags.map(t => this._tagSVG(t)).join('');
    layer.appendChild(tags);
    const b = pg.window && pg.clip ? { x0: pg.window.x0, y0: pg.window.y0, x1: pg.window.x1, y1: pg.window.y1 } : pg.bbox;
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    clone.setAttribute('viewBox', `${b.x0} ${b.y0} ${w} ${h}`);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', b.x0); bg.setAttribute('y', b.y0); bg.setAttribute('width', w); bg.setAttribute('height', h); bg.setAttribute('fill', '#ffffff');
    bg.setAttribute('data-dxf-skip', '1');
    clone.insertBefore(bg, layer);
    return { clone, svgW: w, svgH: h };
  },

  // Every page of a plan, key plan first, as SVG elements
  allPageSVGs(plan, base, info) {
    const out = [];
    for (let p = 0; p < plan.keyPages; p++) out.push(this.keyPageSVG(plan, base, info, p));
    plan.pages.forEach((pg, i) => out.push(this.pageSVG(plan, pg, base, info, 'p' + i)));
    return out;
  },

  async exportPDF(plan, info, fileName) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { Project._statusMsg('PDF library not loaded.'); return; }
    await VectorPDF.ensure();
    const L = plan.layout;
    const doc = new jsPDF({ orientation: plan.landscape ? 'landscape' : 'portrait', unit: 'mm', format: plan.paper });
    VectorPDF.registerFonts(doc);
    const base = info.base || this.prepareBase();
    const svgs = this.allPageSVGs(plan, base, info);
    let raster = 0;
    for (let i = 0; i < svgs.length; i++) {
      if (i) doc.addPage(plan.paper, plan.landscape ? 'landscape' : 'portrait');
      if (!(await VectorPDF.draw(doc, svgs[i], L.pw, L.ph))) raster++;
    }
    const name = (AppState.projectName || 'Untitled Project').replace(/[^\w-]+/g, '_');
    doc.save(fileName || `${name}_sheets.pdf`);
    Project._statusMsg(`Exported ${svgs.length} page${svgs.length > 1 ? 's' : ''} as PDF${raster ? ` (${raster} as pictures)` : ''}.`);
  },

  open() { return DrawingSet.open(); },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SheetPrint;
