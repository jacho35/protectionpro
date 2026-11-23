/* ProtectionPro — Fibre network diagram (the Network overview's Fibre tab).
 *
 * A read-only tree of the fibre drawn on the site plan: the fibre entry →
 * manholes along the backbone (route type fibreBB between two manholes), as
 * spurs with T-offs or a ring. Each manhole box carries its erf ducts (route
 * type fibreErf from that manhole: count and total length) and the road
 * crossings on them and on the trunk into it (a crossing = the duct crossing
 * a drawn street centreline). Trunk lengths sit on the lines; a totals panel
 * gives trunk, erf ducts, crossings and the erven served of all serviced
 * erven.
 *
 * The entry is the manhole nearest the Auto layout's fibre entry point
 * (settings.layout.entry), else the first manhole with a trunk — the same
 * fallback the layout engine uses. A trunk longer than the Auto layout's
 * "Max distance between manholes" (params.maxmh) is flagged — only on a plan
 * the Auto layout has been used on, since a hand-drawn network has no such
 * rule. Manholes no trunk reaches from the entry are drawn as their own
 * group and flagged.
 *
 * `model()` is pure (node-testable: testing/unit/fibrediagram.test.js); the
 * drawing reuses ReticDiagram's layout, palette and dialog. Derived only —
 * nothing here is saved.
 */

const FibreDiagram = {
  _size: { w: 0, h: 0 },
  PANEL_W: 230,

  // ─── Model ───
  // input: { elements, routes, factor (m per plan px, or null), entry ({x, y}
  // plan px or null), maxmh (m or 0 = no check), lenOf (route → m, optional) }
  model(input) {
    const els = input.elements || [], routes = input.routes || [];
    const factor = input.factor || 0;
    const plen = (r) => {
      const p = (r && r.points) || [];
      let s = 0;
      for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      return s * factor;
    };
    const lenOf = input.lenOf || plen;
    const mhList = els.filter(e => e.type === 'manhole');
    if (!mhList.length) return null;
    const mh = {};
    for (const e of mhList) mh[e.id] = { id: e.id, name: e.name || 'Manhole', x: e.x, y: e.y, ducts: 0, ductM: 0, xings: 0, erven: [], trunkIn: null, over: false, unreached: false };
    const erfIds = new Set(els.filter(e => e.type === 'erf').map(e => e.id));
    const serviced = els.filter(e => e.type === 'erf' && !(e.props && e.props.unserviced)).length;

    const streets = routes.filter(r => r.type === 'street' && (r.points || []).length > 1);
    const crossings = (r) => {
      const p = r.points || [];
      let n = 0;
      for (const st of streets) {
        const q = st.points;
        for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) if (this._segX(p[i - 1], p[i], q[j - 1], q[j])) n++;
      }
      return n;
    };

    // Erf ducts: a fibreErf route with a manhole at one end.
    const served = new Set();
    let ductM = 0, ducts = 0, xTotal = 0;
    for (const r of routes) {
      if (r.type !== 'fibreErf') continue;
      const m = mh[r.fromId] ? mh[r.fromId] : mh[r.toId];
      const other = mh[r.fromId] ? r.toId : r.fromId;
      const L = lenOf(r) || 0, x = crossings(r);
      ductM += L; ducts++; xTotal += x;
      if (other && erfIds.has(other)) served.add(other);
      if (!m) continue;
      m.ducts++; m.ductM += L; m.xings += x;
      if (other && erfIds.has(other)) m.erven.push(other);
    }

    // Trunks: a fibreBB route between two manholes (others count in the total only).
    const adj = {};
    let trunkM = 0;
    const trunks = [];
    for (const r of routes) {
      if (r.type !== 'fibreBB') continue;
      const L = lenOf(r) || 0, x = crossings(r);
      trunkM += L; xTotal += x;
      if (!mh[r.fromId] || !mh[r.toId] || r.fromId === r.toId) continue;
      const t = { id: r.id, a: r.fromId, b: r.toId, len: L, xings: x };
      trunks.push(t);
      (adj[t.a] = adj[t.a] || []).push(t);
      (adj[t.b] = adj[t.b] || []).push(t);
    }

    // The entry: nearest manhole to the entry point among those on a trunk,
    // else the first manhole (element order) on a trunk, else the first one.
    const onTrunk = mhList.filter(e => adj[e.id]);
    const pool = onTrunk.length ? onTrunk : mhList;
    let entry = pool[0];
    if (input.entry && isFinite(input.entry.x)) {
      entry = pool.slice().sort((p, q) => Math.hypot(p.x - input.entry.x, p.y - input.entry.y) - Math.hypot(q.x - input.entry.x, q.y - input.entry.y))[0];
    }

    // Breadth-first from the entry (then from each manhole left over, so a
    // part not joined to the entry still draws): tree edges + ring ties.
    const children = {}, edges = [], ring = [], roots = [], usedT = new Set(), seen = new Set();
    for (const e of mhList) children[e.id] = [];
    const grow = (rootId) => {
      roots.push(rootId); seen.add(rootId);
      const q = [rootId];
      while (q.length) {
        const id = q.shift();
        for (const t of adj[id] || []) {
          if (usedT.has(t)) continue;
          usedT.add(t);
          const o = t.a === id ? t.b : t.a;
          if (seen.has(o)) { ring.push({ from: id, to: o, len: t.len, xings: t.xings, id: t.id }); continue; }
          seen.add(o); children[id].push(o); q.push(o);
          edges.push({ from: id, to: o, len: t.len, xings: t.xings, id: t.id });
          mh[o].trunkIn = t.len; mh[o].xings += t.xings;
        }
      }
    };
    grow(entry.id);
    const maxmh = Number(input.maxmh) || 0;
    for (const e of mhList) if (!seen.has(e.id)) { grow(e.id); }
    const reach = new Set();
    const mark = (id) => { reach.add(id); for (const c of children[id]) mark(c); };
    mark(entry.id);
    for (const id of Object.keys(mh)) if (!reach.has(id) && (onTrunk.length || id !== entry.id)) mh[id].unreached = onTrunk.length > 0;
    for (const e of edges.concat(ring)) e.over = maxmh > 0 && e.len > maxmh;
    for (const e of edges) if (e.over) mh[e.to].over = true;

    return {
      mh, entryId: entry.id, roots, children, edges, ring, maxmh,
      totals: { manholes: mhList.length, trunkM, ductM, ducts, crossings: xTotal, served: served.size, erven: serviced,
        tOffs: Object.keys(children).filter(id => children[id].length + (id === entry.id ? 0 : 1) >= 3).length,
        unreached: Object.values(mh).filter(m => m.unreached).length, over: edges.concat(ring).filter(e => e.over).length },
    };
  },

  // Do segments ab and cd cross (properly or touching)?
  _segX(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
  },

  // The plan's fibre (the reticulation plan; null when it has no manholes).
  _input() {
    const pm = AppState.planMarkup;
    if (!pm || !pm.elements) return null;
    if (pm.settings && pm.settings.domain && pm.settings.domain !== 'retic') return null;
    const factor = typeof PlanSync !== 'undefined' ? PlanSync._factor() : null;
    const lay = pm.settings && pm.settings.layout;
    const usedLayout = !!(lay && lay.params && Object.keys(lay.params).length) || (pm.elements || []).some(e => e.type === 'manhole' && e.auto === 'layout');
    const D = typeof PlanLayout !== 'undefined' && PlanLayout.DEFAULTS ? PlanLayout.DEFAULTS.maxmh : 120;
    const maxmh = usedLayout ? (Number(lay && lay.params && lay.params.maxmh) || D) : 0;
    return {
      elements: pm.elements, routes: pm.routes || [], factor,
      entry: lay && lay.entry ? lay.entry : null, maxmh,
      lenOf: factor && AppState.planRoutePx ? (r) => AppState.planRoutePx(r) * factor : null,
    };
  },

  _fmtM(m) { return !m ? '—' : m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; },

  // ─── SVG ───
  buildSVG(opts) {
    opts = opts || {};
    const inp = this._input();
    const M = inp && this.model(inp);
    if (!M) return '';
    const R = ReticDiagram, E = (s) => R._esc(s);
    const P = R._palette(!!opts.dark);
    const L = R._layout({ roots: M.roots, children: M.children, msIds: new Set(), ring: M.ring });
    const W = R.NODE_W, H = R.NODE_H;

    let edgeSvg = '';
    for (const e of M.edges) {
      const a = L.pos[e.from], b = L.pos[e.to];
      if (!a || !b) continue;
      const px = a.x + W, py = a.y + H / 2, cx = b.x, cy = b.y + H / 2, mx = (px + cx) / 2;
      const c = e.over ? P.warn : P.fibre;
      edgeSvg += `<g><title>${E(`Trunk ${M.mh[e.from].name} → ${M.mh[e.to].name}: ${this._fmtM(e.len)}${e.xings ? `, ${e.xings} road crossing${e.xings === 1 ? '' : 's'}` : ''}${e.over ? ` — longer than the ${M.maxmh} m between manholes` : ''}`)}</title>`
        + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.fibre}" stroke-width="1.8" stroke-dasharray="7 4"/>`
        + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.fibre}"/>`
        + `<text x="${mx}" y="${cy - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="${c}">${E(this._fmtM(e.len))}</text>`
        + `</g>`;
    }
    let ringSvg = '';
    M.ring.forEach((t, ri) => {
      const a = L.pos[t.from], b = L.pos[t.to];
      if (!a || !b) return;
      const [s, f] = a.x <= b.x ? [a, b] : [b, a];
      const sx = s.x + W, sy = s.y + H * 0.8, ex = f.x + W, ey = f.y + H * 0.8;
      const xr = Math.max(sx, ex) + 12 + 5 * ri, yb = L.baseH + 8 + ri * 22;
      ringSvg += `<g><title>${E(`Ring: ${M.mh[t.from].name} ↔ ${M.mh[t.to].name}, ${this._fmtM(t.len)}`)}</title>`
        + `<path d="M ${sx} ${sy} H ${xr} V ${yb} H ${ex + 6} V ${ey} H ${ex}" fill="none" stroke="${P.fibre}" stroke-width="1.6" stroke-dasharray="3 4"/>`
        + `<text x="${(sx + xr) / 2}" y="${yb - 4}" text-anchor="middle" font-size="9" font-weight="700" fill="${t.over ? P.warn : P.fibre}">${E('Ring · ' + this._fmtM(t.len))}</text></g>`;
    });

    let nodeSvg = '';
    for (const n of L.nodes) nodeSvg += this._node(n, M, P);

    // Totals panel, right of the tree.
    const T = M.totals, tx = L.w + 8, ty = R.PAD, tw = this.PANEL_W - 24;
    const rows = [['Manholes', String(T.manholes)], ['Trunk duct', this._fmtM(T.trunkM)],
      ['Erf ducts', `${T.ducts} · ${this._fmtM(T.ductM)}`], ['Road crossings', String(T.crossings)],
      ['Erven served', `${T.served} of ${T.erven}`]];
    if (T.tOffs) rows.push(['T-offs', String(T.tOffs)]);
    if (M.ring.length) rows.push(['Ring closures', String(M.ring.length)]);
    const notes = [];
    if (T.erven > T.served) notes.push(`${T.erven - T.served} serviced erf${T.erven - T.served === 1 ? '' : 'ven'} without a duct`);
    if (T.over) notes.push(`${T.over} trunk${T.over === 1 ? '' : 's'} over ${M.maxmh} m`);
    if (T.unreached) notes.push(`${T.unreached} manhole${T.unreached === 1 ? '' : 's'} not on the entry's trunk`);
    const ph = 34 + rows.length * 18 + (notes.length ? 8 + notes.length * 15 : 0);
    let panel = `<g data-dxf-block="FIBRE_TOTALS" data-dxf-at="${tx},${ty}" data-dxf-attrs="${E(JSON.stringify({ MANHOLES: T.manholes, TRUNK_M: Math.round(T.trunkM), ERF_DUCTS: T.ducts, ERF_DUCT_M: Math.round(T.ductM), CROSSINGS: T.crossings, ERVEN_SERVED: T.served, ERVEN: T.erven }))}">`
      + `<rect x="${tx}" y="${ty}" width="${tw}" height="${ph}" rx="6" fill="${P.node}" stroke="${P.border}"/>`
      + `<text x="${tx + 12}" y="${ty + 20}" font-size="9.5" font-weight="700" letter-spacing="0.6" fill="${P.inkSec}">TOTALS</text>`;
    rows.forEach(([k, v], i) => {
      const y = ty + 40 + i * 18;
      panel += `<text x="${tx + 12}" y="${y}" font-size="10" fill="${P.inkSec}">${E(k)}</text><text x="${tx + tw - 12}" y="${y}" text-anchor="end" font-size="10" font-weight="700" fill="${P.ink}">${E(v)}</text>`;
    });
    notes.forEach((t, i) => {
      panel += `<text x="${tx + 12}" y="${ty + 40 + rows.length * 18 + 4 + i * 15}" font-size="9.5" font-weight="700" fill="${P.warn}">${E(t)}</text>`;
    });
    panel += '</g>';

    const w = L.w + this.PANEL_W, h = Math.max(L.h, ty + ph + R.PAD);
    this._size = { w, h };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"
        role="img" aria-label="Fibre network: ${T.manholes} manhole(s) from the entry, ${T.ducts} erf duct(s), ${T.crossings} road crossing(s), ${T.served} of ${T.erven} erven served"
        font-family="Helvetica, Arial, sans-serif">
      <rect x="0" y="0" width="${w}" height="${h}" fill="${P.surface}"/>
      ${edgeSvg}${ringSvg}${nodeSvg}${panel}
    </svg>`;
  },

  _node(n, M, P) {
    const R = ReticDiagram, E = (s) => R._esc(s);
    const m = M.mh[n.id];
    if (!m) return '';
    const W = R.NODE_W, H = R.NODE_H, x = n.x, y = n.y;
    const isEntry = n.id === M.entryId;
    const v = m.unreached || m.over ? 'warn' : 'ok';
    const o = R._outline(v === 'warn' ? 'warn' : null, P);
    const l1 = `${m.ducts} erf duct${m.ducts === 1 ? '' : 's'}${m.ductM ? ' · ' + this._fmtM(m.ductM) : ''}`;
    const l2 = `${m.xings} road crossing${m.xings === 1 ? '' : 's'}`;
    const l3 = m.unreached ? 'Not on the entry’s trunk' : m.over ? `Trunk in ${this._fmtM(m.trunkIn)} > ${M.maxmh} m`
      : isEntry ? `Feeds ${M.totals.manholes - 1 - M.totals.unreached} manhole${M.totals.manholes - 1 - M.totals.unreached === 1 ? '' : 's'}` : (m.ducts ? 'OK' : 'Junction');
    const l3c = v === 'warn' ? P.warn : isEntry ? P.fibre : P.pass;
    const tip = `${m.name}${isEntry ? ' — fibre entry' : ''}\n${l1}\n${l2} (on its erf ducts and the trunk into it)${m.trunkIn != null ? `\nTrunk in ${this._fmtM(m.trunkIn)}` : ''}${m.over ? `, longer than the ${M.maxmh} m allowed between manholes` : ''}${m.unreached ? '\nNo backbone route joins it to the entry.' : ''}`;
    const dxf = { NAME: m.name, ID: m.id, TYPE: isEntry ? 'Fibre entry' : 'Manhole', ERF_DUCTS: m.ducts, ERF_DUCT_M: Math.round(m.ductM),
      CROSSINGS: m.xings, TRUNK_IN_M: m.trunkIn != null ? Math.round(m.trunkIn) : '', STATUS: m.unreached ? 'not connected' : m.over ? 'over spacing' : 'ok' };
    return `<g data-go="plan:${E(m.id)}" tabindex="0" style="cursor:pointer"><title>${E(tip)}</title>
      <g data-dxf-block="${isEntry ? 'FIBRE_ENTRY' : 'MANHOLE'}" data-dxf-at="${x},${y}" data-dxf-attrs="${E(JSON.stringify(dxf))}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${o.stroke}" stroke-width="${o.w}"/>
      <path d="M ${x + 1} ${y + 7} a 6 6 0 0 1 6 -6 h ${W - 14} a 6 6 0 0 1 6 6 v 14 h -${W - 2} z" fill="${P.fibreHead}"/>
      <text x="${x + 10}" y="${y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${E(R._trunc(m.name, 20))}</text>
      <text x="${x + W - 8}" y="${y + 15}" text-anchor="end" font-size="8" font-weight="700" fill="${P.fibre}">${isEntry ? 'FIBRE ENTRY' : 'MANHOLE'}</text>
      <text x="${x + 10}" y="${y + 37}" font-size="10" fill="${P.inkSec}" data-dxf-attr="DUCTS_LABEL">${E(l1)}</text>
      <text x="${x + 10}" y="${y + 52}" font-size="10" fill="${P.inkSec}" data-dxf-attr="CROSSINGS_LABEL">${E(l2)}</text>
      <text x="${x + 10}" y="${y + 68}" font-size="9.5" font-weight="700" fill="${l3c}" data-dxf-attr="STATUS_LABEL">${E(R._trunc(l3, 34))}</text>
    </g></g>`;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = FibreDiagram;
