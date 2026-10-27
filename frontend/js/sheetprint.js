/* ProtectionPro — SheetPrint: the diagram PDF split by bus.
 *
 * A big diagram printed on one page ends up with unreadable text. SheetPrint
 * prints it as sheets instead: one sheet per bus (several buses share a sheet
 * while the text stays above a minimum size), every sheet centred on the page.
 * A wire that leaves a sheet ends in a tagged off-page connector — the same tag
 * (OP-01 …) on both sheets, with the breaker and cable IDs — and the key plan
 * lists every connector. A bus too big for one sheet splits into two pages (the
 * busbar continues through a tagged connector) or the paper size goes up.
 *
 * `SheetPrint.plan(model, opts)` is pure (node-testable, testing/unit/sheetprint.test.js):
 * it takes plain comps + wires and returns pages with their members, region,
 * scale and connector tags. The rest (model from AppState, dialog, rendering,
 * jsPDF) is browser-only.
 */

const SheetPrint = {
  PAPERS: { a4: [297, 210], a3: [420, 297], a2: [594, 420], a1: [841, 594] },
  PAPER_ORDER: ['a4', 'a3', 'a2', 'a1'],
  SOURCE_TYPES: new Set(['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery']),
  BASE_PX: 11,            // size of the diagram's name labels, SVG units
  PT_PER_MM: 72 / 25.4,
  MAX_PT: 16,             // never blow the diagram up past this label size
  MARGIN: 8,              // mm, page frame
  TITLE_H: 18,            // mm, title block
  PAD: 95,                // world units kept free around a sheet while packing: a tag reaches STUB + TAG_H past a part, plus the 20 left around the drawing
  TAG_W: 96, TAG_H: 52, STUB: 22,
  SCREEN_MM_PER_PX: 25.4 / 96,

  defaults() {
    return { paper: 'a4', landscape: true, minPt: 8, maxBuses: 4, keyPlan: true, titleBlock: true, oversize: 'split' };
  },

  // ── Pure planning ─────────────────────────────────────────────

  // model = { comps:[{id,type,name,x,y,bbox:{x0,y0,x1,y1},switching,cable}],
  //           wires:[{id,a,b,pa,pb,pts?}] }
  plan(model, options) {
    const S = this;
    const o = Object.assign(S.defaults(), options || {});
    let [pw, ph] = S.PAPERS[o.paper] || S.PAPERS.a4;
    if (!o.landscape) [pw, ph] = [ph, pw];
    const availW = pw - 2 * S.MARGIN, availH = ph - 2 * S.MARGIN - S.TITLE_H;
    const kMax = S.MAX_PT / (S.BASE_PX * S.PT_PER_MM);

    const comps = new Map(model.comps.map(c => [c.id, c]));
    const wires = model.wires.filter(w => comps.has(w.a) && comps.has(w.b) && w.a !== w.b);
    const adj = new Map(model.comps.map(c => [c.id, []]));
    wires.forEach(w => { adj.get(w.a).push(w.b); adj.get(w.b).push(w.a); });
    const buses = model.comps.filter(c => c.type === 'bus');
    if (!buses.length) return { error: 'no-buses', pages: [], connectors: [], oversized: [], paper: o.paper, landscape: o.landscape, opts: o };

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
    for (const c of model.comps) {   // not wired to any bus: with the nearest one
      if (unitOf.has(c.id) || linkIds.has(c.id)) continue;
      let best = buses[0], bd = Infinity;
      for (const b of buses) { const d = (b.x - c.x) ** 2 + (b.y - c.y) ** 2; if (d < bd) { bd = d; best = b; } }
      unitOf.set(c.id, best.id);
    }

    // chains: the parts between two buses, cut after the first switching device
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
      if (comps.get(w.a).type === 'bus' && comps.get(w.b).type === 'bus' && w.a !== w.b) {
        const [Sb, Rb] = busSendFirst(w.a, w.b);
        chains.push({ S: Sb, R: Rb, comps: [] });
      }
    }
    for (const ch of chains) {
      ch.cut = ch.comps.length && ch.comps[0].switching ? 1 : 0;
      const g = ch.comps[ch.cut];
      ch.ghost = g && !g.switching ? g.id : null;
      ch.compOf = new Set(ch.comps.map(c => c.id));
    }

    // buses that must share a sheet (tie groups)
    const parent = new Map(buses.map(b => [b.id, b.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    ties.forEach(t => t.buses.forEach(b => parent.set(find(b), find(t.buses[0]))));
    const groupsMap = new Map();
    buses.forEach(b => { const r = find(b.id); if (!groupsMap.has(r)) groupsMap.set(r, []); groupsMap.get(r).push(b.id); });
    const groups = [...groupsMap.values()].map(ids => ({
      buses: ids,
      depth: Math.min(...ids.map(dp)),
      x: Math.min(...ids.map(i => comps.get(i).x)),
    })).sort((a, b) => a.depth - b.depth || a.x - b.x);

    const membersOf = (bs) => {
      const ids = new Set(), ghosts = new Set();
      for (const [id, b] of unitOf) if (bs.has(b)) ids.add(id);
      for (const ch of chains) {
        const hasS = bs.has(ch.S), hasR = bs.has(ch.R);
        if (hasS && hasR) ch.comps.forEach(c => ids.add(c.id));
        else if (hasS) { ch.comps.slice(0, ch.cut).forEach(c => ids.add(c.id)); if (ch.ghost) ghosts.add(ch.ghost); }
        else if (hasR) ch.comps.slice(ch.cut).forEach(c => ids.add(c.id));
      }
      for (const t of ties) if (t.buses.some(b => bs.has(b))) t.comps.forEach(id => ids.add(id));
      return { ids, ghosts };
    };
    const bboxOf = (ids, ghosts, clip) => {
      const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const add = (id) => {
        const b = comps.get(id).bbox;
        let { x0, y0, x1, y1 } = b;
        if (clip) {
          if (clip.axis === 'x') { x0 = Math.max(x0, clip.lo); x1 = Math.min(x1, clip.hi); } else { y0 = Math.max(y0, clip.lo); y1 = Math.min(y1, clip.hi); }
          if (x1 < x0 || y1 < y0) return;
        }
        bb.x0 = Math.min(bb.x0, x0); bb.y0 = Math.min(bb.y0, y0); bb.x1 = Math.max(bb.x1, x1); bb.y1 = Math.max(bb.y1, y1);
      };
      ids.forEach(add); ghosts.forEach(add);
      return bb;
    };
    const fitOf = (bb, pad) => {
      const w = bb.x1 - bb.x0 + 2 * pad, h = bb.y1 - bb.y0 + 2 * pad;
      const k = Math.min(availW / w, availH / h, kMax);
      return { k, pt: S.BASE_PX * k * S.PT_PER_MM };
    };
    const connected = (bsA, bsB) => chains.some(ch => (bsA.has(ch.S) && bsB.has(ch.R)) || (bsA.has(ch.R) && bsB.has(ch.S)));

    // pack the bus groups into sheets
    const sheets = [];
    for (const g of groups) {
      const gs = new Set(g.buses);
      let placed = false;
      const cands = sheets.filter(sh => connected(sh.buses, gs));
      for (const sh of cands) {
        if (sh.buses.size + gs.size > o.maxBuses) continue;
        const bs = new Set([...sh.buses, ...gs]);
        const m = membersOf(bs);
        if (fitOf(bboxOf(m.ids, m.ghosts), S.PAD).pt >= o.minPt) { gs.forEach(b => sh.buses.add(b)); placed = true; break; }
      }
      if (!placed) sheets.push({ buses: gs });
    }

    // pages: one per sheet, an oversized sheet splits (or is reported)
    const oversized = [];
    let pages = [];
    const mkPage = (bs, ids, ghosts, clip, extra) => Object.assign({ buses: [...bs], ids, ghosts, clip: clip || null, cont: [] }, extra || {});
    const wireCount = (cIds, side) => {
      let n = 0;
      for (const w of wires) if (cIds.has(w.a) && cIds.has(w.b) && side(w.a) !== side(w.b)) n++;
      return n;
    };
    const splitPage = (pg, level) => {
      const bb = bboxOf(pg.ids, pg.ghosts, pg.clip);
      const axis = (bb.x1 - bb.x0) >= (bb.y1 - bb.y0) ? 'x' : 'y';
      const lo0 = axis === 'x' ? bb.x0 : bb.y0, hi0 = axis === 'x' ? bb.x1 : bb.y1;
      const cen = (id) => (axis === 'x' ? comps.get(id).x : comps.get(id).y);
      let best = null;
      for (let i = 6; i <= 14; i++) {
        const c = lo0 + (hi0 - lo0) * i / 20;
        const side = (id) => (cen(id) < c ? 0 : 1);
        let straddle = 0;
        pg.ids.forEach(id => { const b = comps.get(id).bbox; const l = axis === 'x' ? b.x0 : b.y0, h = axis === 'x' ? b.x1 : b.y1; if (comps.get(id).type !== 'bus' && l < c && h > c) straddle++; });
        const score = wireCount(pg.ids, side) * 10 + straddle * 40 + Math.abs(i - 10) * 2;
        if (!best || score < best.score) best = { c, score };
      }
      const c = best.c;
      const mk = (hiSide) => {
        const ids = new Set(), ghosts = new Set();
        const inSide = (id) => (hiSide ? cen(id) >= c : cen(id) < c);
        pg.ids.forEach(id => {
          const cm = comps.get(id);
          const b = cm.bbox;
          const l = axis === 'x' ? b.x0 : b.y0, h = axis === 'x' ? b.x1 : b.y1;
          if (inSide(id) || (cm.type === 'bus' && l < c && h > c)) ids.add(id);
        });
        pg.ghosts.forEach(id => { if (inSide(id)) ghosts.add(id); });
        const lo = hiSide ? c : (pg.clip ? pg.clip.lo : -Infinity), hi = hiSide ? (pg.clip ? pg.clip.hi : Infinity) : c;
        return mkPage(pg.buses, ids, ghosts, { axis, lo, hi }, { splitAt: c, splitAxis: axis, parent: pg });
      };
      const A = mk(false), B = mk(true);
      for (const id of A.ids) {
        const cm = comps.get(id);
        const b = cm.bbox;
        const l = axis === 'x' ? b.x0 : b.y0, h = axis === 'x' ? b.x1 : b.y1;
        if (cm.type === 'bus' && l < c && h > c && B.ids.has(id)) { A.cont.push({ bus: id, edge: 'hi', at: c, axis, key: `${id}@${level}:${Math.round(c)}` }); B.cont.push({ bus: id, edge: 'lo', at: c, axis, key: `${id}@${level}:${Math.round(c)}` }); }
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
    const finalFit = (pg) => {
      // fit including the tag allowance, on the clipped bounding box
      const bb = bboxOf(pg.ids, pg.ghosts, pg.clip);
      return fitOf(bb, S.PAD);
    };
    const settle = (pg, level) => {
      if (finalFit(pg).pt >= o.minPt || o.oversize !== 'split' || level >= 2) {
        if (finalFit(pg).pt < o.minPt) oversized.push({ buses: pg.buses.map(b => comps.get(b).name || b), pt: finalFit(pg).pt });
        return [pg];
      }
      const [A, B] = splitPage(pg, level);
      if (!A.ids.size || !B.ids.size) { oversized.push({ buses: pg.buses.map(b => comps.get(b).name || b), pt: finalFit(pg).pt }); return [pg]; }
      return [...settle(A, level + 1), ...settle(B, level + 1)];
    };
    for (const sh of sheets) {
      const m = membersOf(sh.buses);
      const pg = mkPage(sh.buses, m.ids, m.ghosts, null);
      pages.push(...settle(pg, 0));
    }

    // numbering, crossings and tags
    const first = o.keyPlan ? 2 : 1;
    pages.forEach((pg, i) => { pg.index = i; pg.no = first + i; });
    const inClip = (clip, p) => !clip || ((clip.axis === 'x' ? p.x : p.y) >= clip.lo - 0.5 && (clip.axis === 'x' ? p.x : p.y) <= clip.hi + 0.5);
    const present = (pg, id, p) => pg.ids.has(id) && inClip(pg.clip, p);
    const chainOf = new Map();
    chains.forEach(ch => ch.comps.forEach(c => chainOf.set(c.id, ch)));
    const pageOf = (id, except) => pages.find(p => p !== except && p.ids.has(id)) || pages.find(p => p.ids.has(id));
    const nameOf = (id) => (comps.get(id).name || id);
    const farBus = (otherId, dir) => {
      const oc = comps.get(otherId);
      if (oc.type === 'bus') return otherId;
      const ch = chainOf.get(otherId);
      if (ch) return dir === 'FROM' ? ch.S : ch.R;
      return unitOf.get(otherId);
    };
    const idsLine = (w) => {
      const ch = chainOf.get(w.a) || chainOf.get(w.b);
      const list = ch ? ch.comps : [comps.get(w.a), comps.get(w.b)];
      const cb = list.find(c => c.type === 'cb' || c.type === 'fuse');
      const cab = list.find(c => c.cable);
      return [cb && cb.name, cab && cab.name].filter(Boolean).join(' · ');
    };
    const opIds = new Map();
    const opId = (key) => { if (!opIds.has(key)) opIds.set(key, 'OP-' + String(opIds.size + 1).padStart(2, '0')); return opIds.get(key); };
    const dirOf = (inc, oth) => (dp(oth) < dp(inc) ? 'FROM' : dp(oth) > dp(inc) ? 'TO' : (oth < inc ? 'FROM' : 'TO'));
    const connectors = new Map();
    for (const pg of pages) {
      pg.wires = new Set(); pg.tags = []; pg.ghostLines = []; pg.ghostNotes = [];
      for (const w of wires) {
        const A = present(pg, w.a, w.pa), B = present(pg, w.b, w.pb);
        if (A && B) { pg.wires.add(w.id); continue; }
        if (!A && !B) continue;
        const endIsA = A;
        const inc = endIsA ? w.a : w.b, oth = endIsA ? w.b : w.a;
        const P = endIsA ? w.pa : w.pb;
        const pts = (w.pts && w.pts.length > 1 ? w.pts : [w.pa, w.pb]);
        const seq = endIsA ? pts : pts.slice().reverse();
        let dx = 0, dy = 0;
        for (let i = 1; i < seq.length && !dx && !dy; i++) { dx = seq[i].x - seq[0].x; dy = seq[i].y - seq[0].y; }
        if (Math.abs(dx) > Math.abs(dy)) { dy = 0; dx = Math.sign(dx); } else { dx = 0; dy = Math.sign(dy) || 1; }
        const dir = dirOf(inc, oth);
        const id = opId('w:' + w.id);
        const fb = farBus(oth, dir);
        const far = pageOf(oth, pg) || pageOf(fb, pg);
        const half = dx ? S.TAG_W / 2 : S.TAG_H / 2;
        const cx = P.x + dx * (S.STUB + half), cy = P.y + dy * (S.STUB + half);
        const ref = idsLine(w);
        const tag = { id, dir, bus: nameOf(fb), ref, sheet: far ? far.no : null, cx, cy, w: S.TAG_W, h: S.TAG_H, stub: { x1: P.x, y1: P.y, x2: P.x + dx * S.STUB, y2: P.y + dy * S.STUB }, wire: w.id };
        pg.tags.push(tag);
        if (pg.ghosts.has(oth)) {
          const gp = endIsA ? w.pb : w.pa;
          pg.ghostLines.push({ x1: tag.cx, y1: tag.cy, x2: gp.x, y2: gp.y });
          pg.ghostNotes.push({ id: oth, name: nameOf(oth), sheet: far ? far.no : null });
        }
        if (!connectors.has(id)) connectors.set(id, { id, breaker: '', cable: '', from: null, to: null });
        const cn = connectors.get(id);
        const cb = (chainOf.get(w.a) || chainOf.get(w.b) ? (chainOf.get(w.a) || chainOf.get(w.b)).comps : [comps.get(w.a), comps.get(w.b)]);
        cn.breaker = (cb.find(c => c.type === 'cb' || c.type === 'fuse') || {}).name || cn.breaker;
        cn.cable = (cb.find(c => c.cable) || {}).name || cn.cable;
        // TO tag sits on the sending sheet, FROM on the receiving one
        const ownBus = comps.get(inc).type === 'bus' ? inc : (chainOf.get(inc) ? (dir === 'TO' ? chainOf.get(inc).S : chainOf.get(inc).R) : unitOf.get(inc));
        if (dir === 'TO') cn.from = { sheet: pg.no, bus: nameOf(ownBus) };
        else cn.to = { sheet: pg.no, bus: nameOf(ownBus) };
      }
      // the busbar of a split bus continues through a connector
      for (const c of pg.cont) {
        const bus = comps.get(c.bus);
        const id = opId('c:' + c.key);
        const dir = c.edge === 'hi' ? 'TO' : 'FROM';
        const half = (c.axis === 'x' ? S.TAG_W : S.TAG_H) / 2;
        const off = c.edge === 'hi' ? half : -half;
        const cx = c.axis === 'x' ? c.at + off : bus.x, cy = c.axis === 'x' ? bus.y : c.at + off;
        const other = pages.find(p => p !== pg && p.cont.some(x => x.key === c.key));
        pg.tags.push({ id, dir, bus: nameOf(c.bus), ref: '', sheet: other ? other.no : null, cx, cy, w: S.TAG_W, h: S.TAG_H, cont: true });
        if (!connectors.has(id)) connectors.set(id, { id, breaker: '', cable: '', from: null, to: null, busbar: true });
        const cn = connectors.get(id);
        if (dir === 'TO') cn.from = { sheet: pg.no, bus: nameOf(c.bus) }; else cn.to = { sheet: pg.no, bus: nameOf(c.bus) };
      }
    }

    // region: centred on what is drawn, in the page's aspect, and its scale
    for (const pg of pages) {
      const bb = bboxOf(pg.ids, pg.ghosts, pg.clip);
      pg.tags.forEach(t => { bb.x0 = Math.min(bb.x0, t.cx - t.w / 2); bb.x1 = Math.max(bb.x1, t.cx + t.w / 2); bb.y0 = Math.min(bb.y0, t.cy - t.h / 2); bb.y1 = Math.max(bb.y1, t.cy + t.h / 2); });
      const w0 = bb.x1 - bb.x0 + 40, h0 = bb.y1 - bb.y0 + 40;
      const k = Math.min(availW / w0, availH / h0, kMax);
      const rw = availW / k, rh = availH / k;
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      pg.bbox = bb;
      pg.k = k;
      pg.pt = S.BASE_PX * k * S.PT_PER_MM;
      pg.region = { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh };
      pg.scalePct = Math.round(k / S.SCREEN_MM_PER_PX * 100);
    }
    const names = pages.map(pg => pg.buses.map(nameOf));
    pages.forEach((pg, i) => { pg.title = names[i].slice(0, 3).join(', ') + (names[i].length > 3 ? ` +${names[i].length - 3}` : ''); });
    return {
      pages, oversized, paper: o.paper, landscape: o.landscape, opts: o, pageMM: [pw, ph], availMM: [availW, availH],
      connectors: [...connectors.values()].sort((a, b) => a.id < b.id ? -1 : 1),
      minPt: pages.length ? Math.min(...pages.map(p => p.pt)) : 0,
    };
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

  // ── Browser: rendering ─────────────────────────────────────────
  _tagSVG(t) {
    const OR = '#B84A0B', filled = t.dir === 'FROM';
    const lines = [`${t.dir} ${t.id} ${t.cont ? '▸' : '▾'}`, t.bus.length > 15 ? t.bus.slice(0, 14) + '…' : t.bus];
    if (t.ref) lines.push(t.ref.length > 17 ? t.ref.slice(0, 16) + '…' : t.ref);
    lines.push(t.sheet ? `SHEET ${t.sheet}` : '');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const lh = 11, y0 = t.cy - (lines.length * lh) / 2 + 8.5;
    let s = '';
    if (t.stub) s += `<line x1="${t.stub.x1}" y1="${t.stub.y1}" x2="${t.stub.x2}" y2="${t.stub.y2}" stroke="#18212B" stroke-width="2"/>`;
    s += `<rect x="${t.cx - t.w / 2}" y="${t.cy - t.h / 2}" width="${t.w}" height="${t.h}" fill="${filled ? OR : '#fff'}" stroke="${OR}" stroke-width="1.5"/>`;
    lines.forEach((ln, i) => {
      s += `<text x="${t.cx}" y="${y0 + i * lh}" text-anchor="middle" font-family="Courier New, monospace" font-size="8.5" font-weight="${i === 0 ? 700 : 600}" fill="${filled ? '#fff' : '#8A3205'}">${esc(ln)}</text>`;
    });
    return s;
  },

  // The export clone cut down to one page
  pageSVG(baseClone, pg) {
    const NS = 'http://www.w3.org/2000/svg';
    const clone = baseClone.cloneNode(true);
    const keep = new Set([...pg.ids, ...pg.ghosts]);
    clone.querySelectorAll('.sld-component[data-id]').forEach(g => {
      const id = g.getAttribute('data-id');
      if (!keep.has(id)) g.remove();
      else if (pg.ghosts.has(id) && !pg.ids.has(id)) g.setAttribute('opacity', '0.35');
    });
    clone.querySelectorAll('[data-comp-id]').forEach(e => { if (!keep.has(e.getAttribute('data-comp-id'))) e.remove(); });
    clone.querySelectorAll('.sld-wire[data-id]').forEach(p => { if (!pg.wires.has(p.getAttribute('data-id'))) p.remove(); });
    clone.querySelectorAll('[data-wire-id]').forEach(e => { if (!pg.wires.has(e.getAttribute('data-wire-id'))) e.remove(); });
    const r = pg.region;
    clone.setAttribute('viewBox', `${r.x} ${r.y} ${r.w} ${r.h}`);
    if (pg.clip) {
      const lo = pg.clip.lo === -Infinity ? -1e6 : pg.clip.lo, hi = pg.clip.hi === Infinity ? 1e6 : pg.clip.hi;
      const rect = pg.clip.axis === 'x' ? `x="${lo}" y="-1e6" width="${hi - lo}" height="2e6"` : `x="-1e6" y="${lo}" width="2e6" height="${hi - lo}"`;
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML = `<clipPath id="sp-clip"><rect ${rect}/></clipPath>`;
      clone.insertBefore(defs, clone.firstChild);
      const layer = clone.querySelector('#diagram-layer');
      if (layer) layer.setAttribute('clip-path', 'url(#sp-clip)');
    }
    const ov = document.createElementNS(NS, 'g');
    let html = '';
    pg.ghostLines.forEach(l => { html += `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="#8793A3" stroke-width="1.6" stroke-dasharray="5 4"/>`; });
    pg.ghostNotes.forEach(n => {
      const c = this._lastModelComps && this._lastModelComps.get(n.id);
      if (c) html += `<text x="${c.x}" y="${c.y - 22}" text-anchor="middle" font-family="Courier New, monospace" font-size="9" fill="#566272">${String(n.name).replace(/&/g, '&amp;').replace(/</g, '&lt;')} · see sheet ${n.sheet || ''}</text>`;
    });
    pg.tags.forEach(t => { html += this._tagSVG(t); });
    ov.innerHTML = html;
    clone.appendChild(ov);
    return clone;
  },

  _raster(clone, w, h, scale) {
    return new Promise(res => Project._rasterizeSVG(clone, w, h, scale, (canvas) => res(canvas)));
  },

  async exportPDF(plan) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { Project._statusMsg('PDF library not loaded.'); return; }
    const S = this;
    const [pw, ph] = plan.pageMM;
    const doc = new jsPDF({ orientation: plan.landscape ? 'landscape' : 'portrait', unit: 'mm', format: plan.paper });
    const { clone: base, svgW, svgH, minX, minY } = Project._prepareExportSVG(20);
    const total = plan.pages.length + (plan.opts.keyPlan ? 1 : 0);
    const name = AppState.projectName || 'Untitled Project';
    const date = new Date().toLocaleDateString();
    const M = S.MARGIN, TH = S.TITLE_H;
    const frame = (title, scaleText, no, sub) => {
      doc.setDrawColor(24, 33, 43); doc.setLineWidth(0.5);
      doc.rect(M, M, pw - 2 * M, ph - 2 * M);
      if (!plan.opts.titleBlock) return;
      const y = ph - M - TH;
      doc.line(M, y, pw - M, y);
      const w = pw - 2 * M, cells = [0.46, 0.14, 0.2, 0.2];
      let x = M;
      const labels = ['DRAWING', 'SCALE', 'SHEET', 'PROJECT · DATE'];
      const vals = [[title, name], [scaleText, plan.paper.toUpperCase() + (plan.landscape ? ' landscape' : ' portrait')], [`${no} of ${total}`, sub || ''], [name, date]];
      cells.forEach((f, i) => {
        if (i) doc.line(x, y, x, ph - M);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(90);
        doc.text(labels[i], x + 2, y + 4);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0);
        doc.text(String(vals[i][0]), x + 2, y + 9.5, { maxWidth: w * f - 4 });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90);
        doc.text(String(vals[i][1]), x + 2, y + 14.5, { maxWidth: w * f - 4 });
        x += w * f;
      });
      doc.setTextColor(0);
    };
    let first = true;
    if (plan.opts.keyPlan) {
      first = false;
      frame('Single line diagram · Key plan', 'NTS', 1, `${plan.pages.length} sheets`);
      const rowsMax = Math.max(plan.pages.length, plan.connectors.length);
      const topH = (ph - 2 * M - TH) * (rowsMax <= 6 ? 0.55 : rowsMax <= 14 ? 0.38 : 0.25);
      const sc = Math.min((pw - 2 * M - 8) / svgW, topH / svgH);
      const canvas = await this._raster(base.cloneNode(true), svgW, svgH, Math.min(1, 1800 / svgW));
      const ix = M + 4 + ((pw - 2 * M - 8) - svgW * sc) / 2, iy = M + 8;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('KEY PLAN', M + 4, M + 5);
      doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', ix, iy, svgW * sc, svgH * sc);
      plan.pages.forEach(pg => {
        const b = pg.bbox;
        const x0 = pg.clip && pg.clip.axis === 'x' ? Math.max(b.x0, pg.clip.lo) : b.x0, x1 = pg.clip && pg.clip.axis === 'x' ? Math.min(b.x1, pg.clip.hi) : b.x1;
        const y0 = pg.clip && pg.clip.axis === 'y' ? Math.max(b.y0, pg.clip.lo) : b.y0, y1 = pg.clip && pg.clip.axis === 'y' ? Math.min(b.y1, pg.clip.hi) : b.y1;
        const rx = ix + (x0 - minX) * sc, ry = iy + (y0 - minY) * sc;
        doc.setDrawColor(184, 74, 11); doc.setLineWidth(0.4); doc.setLineDash([1.5, 1]);
        doc.rect(rx, ry, (x1 - x0) * sc, (y1 - y0) * sc);
        doc.setLineDash([]);
        doc.setFillColor(184, 74, 11); doc.rect(rx, ry, 6, 4.2, 'F');
        doc.setTextColor(255); doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.text(String(pg.no), rx + 3, ry + 3, { align: 'center' });
        doc.setTextColor(0);
      });
      const ty = iy + svgH * sc + 6;
      doc.autoTable({
        startY: ty, margin: { left: M + 4, right: pw / 2 + 2 }, theme: 'grid', styles: { fontSize: rowsMax > 6 ? 6 : 7, cellPadding: rowsMax > 6 ? 0.7 : 1 }, headStyles: { fillColor: [24, 33, 43] },
        head: [['Sheet', 'Buses', 'Text']], body: plan.pages.map(p => [p.no, p.title + (p.splitAt !== undefined ? ' (part)' : ''), p.pt.toFixed(1) + ' pt']),
      });
      if (plan.connectors.length) {
        doc.autoTable({
          startY: ty, margin: { left: pw / 2 + 2, right: M + 4 }, theme: 'grid', styles: { fontSize: rowsMax > 6 ? 6 : 7, cellPadding: rowsMax > 6 ? 0.7 : 1 }, headStyles: { fillColor: [184, 74, 11] },
          head: [['Connector', 'From', 'To', 'Breaker', 'Cable']],
          body: plan.connectors.map(c => [c.id, c.from ? `sh ${c.from.sheet} · ${c.from.bus}` : '', c.to ? `sh ${c.to.sheet} · ${c.to.bus}` : '', c.breaker, c.busbar ? 'busbar' : c.cable]),
        });
      }
    }
    const dpi = Math.min(200, 5000 / ((pw - 2 * M) / 25.4));
    for (const pg of plan.pages) {
      if (!first) doc.addPage(); first = false;
      const clone = this.pageSVG(base, pg);
      const aw = pw - 2 * M, ah = ph - 2 * M - TH;
      const scale = (aw / 25.4 * dpi) / pg.region.w;
      const canvas = await this._raster(clone, pg.region.w, pg.region.h, scale);
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', M, M, aw, ah);
      frame(`Single line diagram · ${pg.title}`, `${pg.scalePct} %`, pg.no, pg.splitAt !== undefined ? 'part of a split bus' : `${pg.buses.length} bus${pg.buses.length > 1 ? 'es' : ''}`);
    }
    doc.save(`${name.replace(/[^\w-]+/g, '_')}_sheets.pdf`);
    Project._statusMsg(`Exported ${total} pages as PDF.`);
  },

  // ── Browser: the dialog ────────────────────────────────────────
  _settings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('protectionpro-sheet-print') || 'null'); } catch (e) { /* private mode */ }
    return Object.assign(this.defaults(), s || {});
  },

  open() {
    const model = this.buildModel();
    this._lastModelComps = new Map(model.comps.map(c => [c.id, c]));
    if (!model.comps.some(c => c.type === 'bus')) { UI.alert('This sheet has no buses to split by.'); return; }
    const old = document.getElementById('sheetprint-modal');
    if (old) old.remove();
    const st = this._settings();
    const wrap = document.createElement('div');
    wrap.id = 'sheetprint-modal';
    wrap.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10000;display:flex;align-items:center;justify-content:center');
    const seg = (name, items) => items.map(([v, l]) => `<label class="sp-seg"><input type="radio" name="${name}" value="${v}"><span>${l}</span></label>`).join('');
    wrap.innerHTML = `<style>
      #sheetprint-modal .sp-seg{flex:1;position:relative;cursor:pointer}
      #sheetprint-modal .sp-seg input{position:absolute;opacity:0}
      #sheetprint-modal .sp-seg span{display:flex;align-items:center;justify-content:center;min-height:40px;border:1px solid var(--border-color,#c4cbd5);border-radius:8px;font-weight:500}
      #sheetprint-modal .sp-seg input:checked+span{border:2px solid #1d4ed8;background:#e8effd;color:#123a9a;font-weight:600}
      #sheetprint-modal .sp-seg input:focus-visible+span{outline:2px solid #1d4ed8;outline-offset:2px}
      #sheetprint-modal h3{margin:0 0 6px;font-size:12px;letter-spacing:.07em;opacity:.7}
      #sheetprint-modal table{border-collapse:collapse;width:100%;font-size:12px}
      #sheetprint-modal td,#sheetprint-modal th{padding:3px 6px;border-bottom:1px solid var(--border-color,#ddd);text-align:left}
    </style>
    <div role="dialog" aria-label="Diagram sheets" style="background:var(--bg-primary,#fff);color:var(--text-primary,#222);border-radius:10px;padding:22px;width:640px;max-width:94vw;max-height:92vh;overflow:auto;display:flex;flex-direction:column;gap:14px;font-size:14px">
      <div><div style="font-size:18px;font-weight:700">Diagram as sheets (PDF)</div><div style="font-size:12px;opacity:.75">One sheet per bus. Wires that leave a sheet end in a tagged off-page connector.</div></div>
      <div><h3>PAPER · ONE SIZE FOR EVERY SHEET</h3><div style="display:flex;gap:8px">${seg('sp-paper', [['a4', 'A4'], ['a3', 'A3'], ['a2', 'A2'], ['a1', 'A1']])}</div>
        <div style="display:flex;gap:8px;margin-top:8px">${seg('sp-orient', [['l', 'Landscape'], ['p', 'Portrait']])}</div></div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">Minimum text<span><input id="sp-min" type="number" min="4" max="14" step="0.5" style="width:70px;min-height:36px"> pt</span></label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">Max buses per sheet<span><input id="sp-max" type="number" min="1" max="20" style="width:70px;min-height:36px"></span></label>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px">
        <label style="display:flex;gap:10px;align-items:center;min-height:30px"><input id="sp-key" type="checkbox"><span>Key plan as the first page, with the connector index</span></label>
        <label style="display:flex;gap:10px;align-items:center;min-height:30px"><input id="sp-title" type="checkbox"><span>Title block with sheet N of M</span></label>
      </div>
      <div id="sp-warn"></div>
      <div id="sp-summary"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" id="sp-cancel" class="btn">Cancel</button><button type="button" id="sp-ok" class="btn btn-primary">Export PDF</button></div></div>`;
    document.body.appendChild(wrap);
    const q = (s) => wrap.querySelector(s);
    const radio = (n, v) => { const r = wrap.querySelector(`input[name="${n}"][value="${v}"]`); if (r) r.checked = true; };
    radio('sp-paper', st.paper); radio('sp-orient', st.landscape ? 'l' : 'p');
    q('#sp-min').value = st.minPt; q('#sp-max').value = st.maxBuses; q('#sp-key').checked = !!st.keyPlan; q('#sp-title').checked = !!st.titleBlock;
    let current = null;
    const read = () => {
      const p = wrap.querySelector('input[name="sp-paper"]:checked');
      const o = wrap.querySelector('input[name="sp-orient"]:checked');
      const ov = wrap.querySelector('input[name="sp-over"]:checked');
      return Object.assign(st, {
        paper: p ? p.value : 'a4', landscape: !o || o.value === 'l', minPt: Math.max(4, +q('#sp-min').value || 8), maxBuses: Math.max(1, +q('#sp-max').value || 4),
        keyPlan: q('#sp-key').checked, titleBlock: q('#sp-title').checked, oversize: ov ? ov.value : st.oversize,
      });
    };
    const refresh = () => {
      const o = read();
      try { localStorage.setItem('protectionpro-sheet-print', JSON.stringify(o)); } catch (e) { /* private mode */ }
      const probe = this.plan(model, Object.assign({}, o, { oversize: 'keep' }));
      let eff = Object.assign({}, o);
      let warn = '';
      if (probe.oversized.length) {
        const names = probe.oversized.map(x => `<b>${x.buses.map(escHtml).join(', ')}</b> (${x.pt.toFixed(1)} pt)`).join('; ');
        const bigger = this.fitPaper(model, o);
        warn = `<div style="border:1px solid #e0a800;background:rgba(224,168,0,.12);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
          <div><b>Too wide for one ${o.paper.toUpperCase()} sheet:</b> ${names}. Minimum is ${o.minPt} pt.</div>
          <label><input type="radio" name="sp-over" value="split"> Split across pages — the busbar continues through a tagged connector</label>
          <label><input type="radio" name="sp-over" value="larger"> Use ${bigger.toUpperCase()} for every sheet</label>
          <label><input type="radio" name="sp-over" value="keep"> Keep one page anyway (text below the minimum)</label></div>`;
        if (o.oversize === 'larger') eff.paper = bigger;
      }
      q('#sp-warn').innerHTML = warn;
      if (warn) radio('sp-over', o.oversize);
      wrap.querySelectorAll('input[name="sp-over"]').forEach(r => r.addEventListener('change', refresh));
      current = this.plan(model, Object.assign({}, eff, { oversize: eff.oversize === 'split' ? 'split' : 'keep' }));
      const rows = current.pages.map(p => `<tr><td>${p.no}</td><td>${escHtml(p.title)}${p.splitAt !== undefined ? ' <i>(part)</i>' : ''}</td><td>${p.pt.toFixed(1)} pt</td></tr>`).join('');
      const cons = current.connectors.length ? `<div style="margin-top:6px;opacity:.8">${current.connectors.length} off-page connector${current.connectors.length > 1 ? 's' : ''}: ${current.connectors.map(c => escHtml(c.id)).join(', ')}</div>` : '';
      const still = current.oversized.length ? `<div style="margin-top:6px;color:#b42318">Still below ${o.minPt} pt: ${current.oversized.map(x => escHtml(x.buses.join(', ')) + ' (' + x.pt.toFixed(1) + ' pt)').join('; ')}. Choose a larger paper size.</div>` : '';
      q('#sp-summary').innerHTML = `<h3>${current.pages.length} SHEET${current.pages.length > 1 ? 'S' : ''} · ${current.paper.toUpperCase()}${current.paper !== o.paper ? ' (enlarged)' : ''}</h3><table><tr><th>Sheet</th><th>Buses</th><th>Smallest text</th></tr>${rows}</table>${cons}${still}`;
    };
    wrap.addEventListener('change', (e) => { if (!e.target.name || e.target.name !== 'sp-over') refresh(); });
    wrap.addEventListener('input', (e) => { if (e.target.type === 'number') refresh(); });
    const close = () => wrap.remove();
    q('#sp-cancel').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    q('#sp-ok').addEventListener('click', async () => {
      if (!current || !current.pages.length) return;
      q('#sp-ok').disabled = true; q('#sp-ok').textContent = 'Exporting…';
      try { await this.exportPDF(current); } catch (e) { console.error(e); Project._statusMsg('Sheet export failed: ' + e.message); }
      close();
    });
    refresh();
    q('#sp-ok').focus();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SheetPrint;
