/* ProtectionPro — Reticulation Topology Diagram (single-line view)
 *
 * A read-only SLD of the minisub → kiosk tree built from `kiosk.fedFrom`.
 * Each leg is annotated with its own volt drop; each kiosk node carries the
 * cumulative volt drop from its minisub, the connection count per phase, and
 * the downstream connection total (that kiosk plus everything fed from it).
 *
 * Everything here is derived — no new state. Geometry comes from
 * AppState.reticulation, numbers from AppState.reticResults (the latest
 * /api/analysis/admd response) and Retic's own volt-drop helpers.
 *
 * Colours are literal hex from _palette(), not CSS custom properties:
 * Project._rasterizeSVG only resolves `var(--x, fallback)` forms, so bare
 * var() references would rasterize colourless into the PNG/PDF exports.
 */

const ReticDiagram = {
  _bound: false,
  _zoom: 1,
  _size: { w: 0, h: 0 },

  // Geometry (SVG user units, which are CSS px at zoom 1)
  NODE_W: 196,
  NODE_H: 62,
  COL_W: 296,   // node pitch — leaves a 100 px gutter for the leg labels
  ROW_H: 88,
  GROUP_GAP: 34, // extra vertical space between minisub groups
  PAD: 22,

  // ─── Modal plumbing ───
  open() {
    const modal = document.getElementById('retic-diagram-modal');
    if (!modal) return;
    this._bind();
    modal.style.display = '';
    this._zoom = 1;
    this.render();
    this.autoZoom();
  },

  close() {
    const modal = document.getElementById('retic-diagram-modal');
    if (modal) modal.style.display = 'none';
  },

  isOpen() {
    const modal = document.getElementById('retic-diagram-modal');
    return !!modal && modal.style.display !== 'none';
  },

  // Listeners are attached on first open so the module stays self-contained
  // (no entry needed in the app.js init sequence).
  _bind() {
    if (this._bound) return;
    const modal = document.getElementById('retic-diagram-modal');
    if (!modal) return;
    this._bound = true;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { this.close(); return; }   // backdrop
      const btn = e.target.closest('[data-rdg]');
      if (!btn) return;
      const a = btn.dataset.rdg;
      if (a === 'close') this.close();
      else if (a === 'zoom-in') this.zoom(1.25);
      else if (a === 'zoom-out') this.zoom(1 / 1.25);
      else if (a === 'fit') this.fit();
      else if (a === 'png') this.exportPNG();
      else if (a === 'svg') this.exportSVG();
      else if (a === 'dxf') this.exportDXF();
    });
  },

  // ─── Topology ───
  // Resolve each kiosk's drawing parent. A fedFrom pointing at a known minisub
  // or at another kiosk that reaches a minisub without looping back is used as
  // is; anything else (legacy 'source', a deleted parent, a cycle) falls back
  // to the minisub Retic._rootOf resolves it to, so every kiosk still renders.
  _resolveParent(k, byId, msIds) {
    const p = k.fedFrom || '';
    if (msIds.has(p)) return p;
    if (byId[p] && p !== k.id) {
      const seen = new Set([k.id]);
      let cur = p;
      while (byId[cur]) {
        if (seen.has(cur)) return Retic._rootOf(k.id);   // cycle
        seen.add(cur);
        cur = byId[cur].fedFrom || '';
      }
      if (msIds.has(cur)) return p;
    }
    return Retic._rootOf(k.id);
  },

  // Ring ties touching one minisub, for the Demand side bar:
  // [{other, cable, len}] (other = the RMU / minisub at the far end).
  ringTiesFor(msId) {
    // The side bar asks once per minisub row; build the tree once per render.
    let tree = this._ringTree;
    if (!tree) {
      try { tree = this._tree(); } catch (e) { return []; }
      this._ringTree = tree;
      Promise.resolve().then(() => { this._ringTree = null; });
    }
    const name = (id) => tree.rmuById[id] ? (tree.rmuById[id].name || 'RMU') : ((tree.msById[id] || {}).name || '');
    const out = [];
    for (const t of tree.ring || []) {
      if (t.from !== msId && t.to !== msId) continue;
      out.push({ other: name(t.from === msId ? t.to : t.from), cable: this._cableShort(t.info.cable), len: t.info.len });
    }
    return out;
  },

  // The plan's MV network as an undirected graph (retic domain only), with
  // helpers that walk it through joints and RMUs. null when nothing is drawn.
  _planMv() {
    const pm = AppState.planMarkup;
    if (!pm || !pm.routes || typeof PlanSync === 'undefined' || !AppState.planAllElements) return null;
    if (pm.settings && pm.settings.domain && pm.settings.domain !== 'retic') return null;
    const el = {};
    for (const e of AppState.planAllElements()) el[e.id] = e;
    const adj = {};
    for (const r of pm.routes) {
      if (r.type !== 'mv' || !r.fromId || !r.toId || !el[r.fromId] || !el[r.toId]) continue;
      (adj[r.fromId] = adj[r.fromId] || []).push({ other: r.toId, route: r });
      (adj[r.toId] = adj[r.toId] || []).push({ other: r.fromId, route: r });
    }
    if (!Object.keys(adj).length) return null;
    const factor = PlanSync._factor();
    const elOf = (rowId) => Object.values(el).find(e => e.type === 'minisub' && e.reticId === rowId);
    // Breadth-first from `startId`; never passes through a minisub other than
    // the target. Returns the element-id path as [{id, route}] (route = leg into id).
    const bfs = (startId, goal) => {
      const prev = { [startId]: null }, q = [startId];
      while (q.length) {
        const id = q.shift();
        if (goal(id, startId)) {
          const out = [];
          for (let c = id; c !== startId; c = prev[c].from) out.unshift({ id: c, route: prev[c].route });
          return out;
        }
        if (id !== startId && el[id].type === 'minisub') continue;
        for (const e of adj[id] || []) if (!(e.other in prev)) { prev[e.other] = { from: id, route: e.route }; q.push(e.other); }
      }
      return null;
    };
    // Fold the hops between drawn nodes into {cable, len}.
    const fold = (hops) => {
      let len = 0, cable = '';
      for (const h of hops) {
        len += PlanSync._routeLenM(h.route, factor) || 0;
        cable = cable || h.route.cableType || '';
      }
      return { cable, len: +len.toFixed(2) };
    };
    const split = (hops) => {
      const stops = [];
      let acc = [];
      for (const h of hops) {
        acc.push(h);
        if (el[h.id].type === 'rmu') { stops.push({ id: h.id, info: fold(acc) }); acc = []; }
      }
      return { stops, last: fold(acc.length ? acc : hops.slice(-1)), routes: hops.map(h => h.route) };
    };
    return {
      el,
      // Route from parent minisub row to child minisub row (or, with `up`,
      // nothing — supply uses supply()). RMUs on the way → stops.
      path(fromRow, toRow, up) {
        if (up) return null;
        const a = elOf(fromRow), b = elOf(toRow);
        if (!a || !b) return null;
        const hops = bfs(a.id, (id) => id === b.id);
        return hops ? split(hops) : null;
      },
      // Nearest RMU reachable from a top minisub through joints only.
      supply(row) {
        const b = elOf(row);
        if (!b) return null;
        const hops = bfs(b.id, (id, st) => id !== st && el[id].type === 'rmu');
        if (!hops) return null;
        const rmuId = hops[hops.length - 1].id;
        return { rmuId, info: fold(hops), routes: hops.map(h => h.route) };
      },
      // MV routes the tree did not use — the ring ties. Each chain of unused
      // routes (through joints) between two drawn nodes is one leg:
      // [{from, to, info}], ids as nodeFor() names them.
      ringLegs(used, nodeFor) {
        const all = [];
        for (const id of Object.keys(adj)) for (const e of adj[id]) {
          if (used.has(e.route) || all.includes(e.route)) continue;
          all.push(e.route);
        }
        const nbr = {};
        for (const r of all) {
          (nbr[r.fromId] = nbr[r.fromId] || []).push({ other: r.toId, route: r });
          (nbr[r.toId] = nbr[r.toId] || []).push({ other: r.fromId, route: r });
        }
        const legs = [], done = new Set();
        for (const r0 of all) {
          if (done.has(r0)) continue;
          // extend both ways from r0 through undrawn elements
          const walk = (fromId, viaRoute) => {
            const hops = []; let cur = fromId, via = viaRoute;
            for (;;) {
              if (nodeFor(cur)) return { end: cur, hops };
              const nx = (nbr[cur] || []).find(e => e.route !== via && !done.has(e.route));
              if (!nx) return { end: cur, hops };
              hops.push({ id: nx.other, route: nx.route }); done.add(nx.route);
              via = nx.route; cur = nx.other;
            }
          };
          done.add(r0);
          const A = walk(r0.fromId, r0), B = walk(r0.toId, r0);
          const from = nodeFor(A.end), to = nodeFor(B.end);
          if (!from || !to || from === to) continue;
          legs.push({ from, to, info: fold([...A.hops, { route: r0 }, ...B.hops]) });
        }
        return legs;
      },
    };
  },

  _tree() {
    const minisubs = Retic.minisubs || [];
    const kiosks = Retic.kiosks || [];
    const msIds = new Set(minisubs.map(m => m.id));
    const byId = {};
    for (const k of kiosks) byId[k.id] = k;

    // MV topology: a minisub with `mvFedFrom` hangs under that minisub (an
    // unknown, self or cyclic parent makes it a root, like "MV supply").
    const msById = {};
    for (const m of minisubs) msById[m.id] = m;
    const msParent = (m) => {
      const seen = new Set([m.id]);
      let cur = m.mvFedFrom || '';
      const first = cur;
      while (cur) {
        if (!msById[cur] || seen.has(cur)) return '';
        seen.add(cur);
        cur = msById[cur].mvFedFrom || '';
      }
      return first;
    };

    const children = {};
    for (const m of minisubs) children[m.id] = [];
    for (const k of kiosks) children[k.id] = [];
    for (const k of kiosks) {
      const p = this._resolveParent(k, byId, msIds);
      (children[p] = children[p] || []).push(k.id);
    }

    // RMUs come from the drawn MV routes on the plan: the ones a minisub's feed
    // passes through (its parent → … → it), and the supply RMU above a top
    // minisub. Each is drawn once, shared by every minisub fed through it.
    const mvInfo = {};            // child node id → {cable, len} of the leg into it
    const rmuById = {};           // 'rmu:<element id>' → plan element
    const placed = new Set();
    const roots = [];
    const addRoot = (id) => { if (!roots.includes(id)) roots.push(id); };
    const plan = this._planMv();
    const used = new Set();
    // Top minisubs first, so a supply RMU is placed as a root before any
    // fed-from path through it is walked — in list order the child could come
    // first, hang the RMU under its parent and leave the group with no root.
    const ordered = minisubs.filter(m => !msParent(m)).concat(minisubs.filter(m => msParent(m)));
    for (const m of ordered) {
      const p = msParent(m);
      const path = plan ? plan.path(p || m.id, m.id, !p) : null;
      if (p) {
        let cur = p;
        if (path) {
          path.routes.forEach(r => used.add(r));
          for (const hop of path.stops) {
            const node = 'rmu:' + hop.id;
            if (!placed.has(node)) {
              placed.add(node); rmuById[node] = plan.el[hop.id]; children[node] = [];
              children[cur].push(node);
              mvInfo[node] = hop.info;
            }
            cur = node;
          }
          mvInfo[m.id] = path.last;
        }
        children[cur].push(m.id);
        if (!mvInfo[m.id]) mvInfo[m.id] = { cable: m.mvCable || '', len: m.mvLength || 0 };
      } else {
        // top minisub: a supply RMU above it, if one is drawn
        const sup = plan ? plan.supply(m.id) : null;
        if (sup) {
          sup.routes.forEach(r => used.add(r));
          const node = 'rmu:' + sup.rmuId;
          if (!placed.has(node)) {
            placed.add(node); rmuById[node] = plan.el[sup.rmuId]; children[node] = [];
            addRoot(node);
          }
          children[node].push(m.id);
          mvInfo[m.id] = sup.info;
        } else {
          addRoot(m.id);
        }
      }
    }
    // Ring ties: drawn MV routes the tree above did not need (the last minisub
    // looping back to an RMU, or to the first minisub).
    let ring = [];
    if (plan) {
      const nodeFor = (elId) => {
        const e = plan.el[elId];
        if (!e) return null;
        if (e.type === 'minisub') return e.reticId && msIds.has(e.reticId) ? e.reticId : null;
        return e.type === 'rmu' && placed.has('rmu:' + elId) ? 'rmu:' + elId : null;
      };
      ring = plan.ringLegs(used, nodeFor);
    }
    return { minisubs, kiosks, byId, msById, msIds, rmuById, mvInfo, ring, roots, children };
  },

  // ─── Counting (must match backend/analysis/admd.py conventions) ───
  // The demand engine only counts erven with length > 0 (`_is_active`), so the
  // diagram applies the same filter — otherwise its figures would silently
  // disagree with the kiosk badges and the PDF schedule.
  _isActive(e) { return Number(e && e.length) > 0; },

  // Connections per phase at one kiosk. A 3-phase erf is reported in its own
  // 3Ø bucket rather than folded one-per-colour (the engine's `_bucket_by_phase`
  // spreads it across R/W/B for demand, but for balancing you want it separate).
  _phaseCounts(k) {
    const out = { Red: 0, White: 0, Blue: 0, '3 Phase': 0, other: 0 };
    for (const e of (k.erfs || [])) {
      if (!this._isActive(e)) continue;
      if (e.phase === 'Red' || e.phase === 'White' || e.phase === 'Blue' || e.phase === '3 Phase') out[e.phase]++;
      else out.other++;
    }
    return out;
  },

  // Active erf count over a kiosk's subtree, including the kiosk itself.
  // A 3-phase erf counts once here; the weighted figure (3Ø = 3) comes from
  // the backend as `subtreeConns`, so the two are shown side by side.
  _subtreeErfCount(kioskId, children, byId, seen) {
    seen = seen || new Set();
    if (seen.has(kioskId)) return 0;
    seen.add(kioskId);
    const k = byId[kioskId];
    let n = k ? (k.erfs || []).filter(e => this._isActive(e)).length : 0;
    for (const c of (children[kioskId] || [])) n += this._subtreeErfCount(c, children, byId, seen);
    return n;
  },

  // ─── Layout: left-to-right layered tree, post-order leaf packing ───
  _layout(tree) {
    const { roots, children, msIds } = tree;   // roots: minisubs, or the RMU above them
    const nodes = [];
    let row = 0, maxDepth = 0;

    const seen = new Set();
    const place = (id, depth) => {
      // Each node once: a malformed tree (a cycle) must not recurse forever.
      if (seen.has(id)) return null;
      seen.add(id);
      maxDepth = Math.max(maxDepth, depth);
      const kids = children[id] || [];
      let y;
      if (!kids.length) {
        y = row * this.ROW_H;
        row++;
      } else {
        const ys = kids.map(c => place(c, depth + 1)).filter(v => v != null);
        if (ys.length) y = (ys[0] + ys[ys.length - 1]) / 2;
        else { y = row * this.ROW_H; row++; }
      }
      nodes.push({ id, depth, y, isMs: msIds.has(id), isRmu: id.startsWith('rmu:'), x: this.PAD + depth * this.COL_W });
      return y;
    };

    roots.forEach((id, i) => {
      if (i > 0) row += this.GROUP_GAP / this.ROW_H;   // breathing room between groups
      place(id, 0);
    });

    const pos = {};
    for (const n of nodes) { n.y += this.PAD; pos[n.id] = n; }

    const edges = [];
    for (const parentId of Object.keys(children)) {
      for (const childId of children[parentId]) {
        if (pos[parentId] && pos[childId]) edges.push({ from: parentId, to: childId });
      }
    }

    const maxY = nodes.reduce((a, n) => Math.max(a, n.y), 0);
    const ringN = (tree.ring || []).filter(r => pos[r.from] && pos[r.to]).length;
    return {
      nodes, edges, pos,
      w: this.PAD * 2 + maxDepth * this.COL_W + this.NODE_W,
      baseH: maxY + this.NODE_H + this.PAD,
      // maxY already includes the top pad; ring ties run in a lane below
      h: maxY + this.NODE_H + this.PAD + (ringN ? 14 + ringN * 22 : 0),
    };
  },

  // ─── Palette ───
  _palette(dark) {
    return dark ? {
      surface: '#1e1e2e', node: '#252536', nodeHead: '#2f2f44', msHead: '#1d3a5c', msBody: '#22293a',
      border: '#3a3a50', ink: '#e0e0e8', inkSec: '#a0a0b0', muted: '#7c7c96',
      edge: '#55556e', rmu: '#f87171', accent: '#4a9eff', pass: '#69db7c', fail: '#ff6b6b',
      phase: { Red: '#f87171', White: '#cbd5e1', Blue: '#60a5fa', '3 Phase': '#c084fc', other: '#7c7c96' },
    } : {
      surface: '#ffffff', node: '#ffffff', nodeHead: '#eef1f5', msHead: '#dbeafe', msBody: '#f5f8ff',
      border: '#c9ced6', ink: '#1a1a2e', inkSec: '#555555', muted: '#7a7a88',
      edge: '#9aa0aa', rmu: '#dc2626', accent: '#0078d7', pass: '#2e7d32', fail: '#d32f2f',
      phase: { Red: '#dc2626', White: '#6b7280', Blue: '#2563eb', '3 Phase': '#7c3aed', other: '#9ca3af' },
    };
  },

  // ─── Small helpers ───
  _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

  _trunc(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  },

  // Compact cable caption for the leg label, e.g. "95mm² Al".
  _cableShort(name) {
    if (!name) return '';
    const c = (typeof CableLib !== 'undefined') ? CableLib.byName(name) : null;
    if (c && c.size_mm2) return `${c.size_mm2}mm² ${c.conductor || ''}`.trim();
    return this._trunc(name, 16);
  },

  _fmtPct(v) { return v == null ? '—' : v.toFixed(2) + '%'; },

  // ─── SVG ───
  // Returns the diagram as an SVG string, or '' when there is nothing to draw.
  buildSVG(opts) {
    opts = opts || {};
    const tree = this._tree();
    if (!tree.kiosks.length && !tree.minisubs.length) return '';
    const P = this._palette(!!opts.dark);
    const L = this._layout(tree);
    this._size = { w: L.w, h: L.h };

    const res = AppState.reticResults;
    const resById = {};
    if (res && res.kiosks) for (const kr of res.kiosks) resById[kr.kioskId] = kr;
    const msById = {};
    if (res && res.minisubs) for (const m of res.minisubs) msById[m.minisubId] = m;

    const limit = Number(Retic.settings.maxFeederVD) || 0;

    // Edges first so the node boxes paint over the line ends.
    let edgeSvg = '';
    for (const e of L.edges) {
      const a = L.pos[e.from], b = L.pos[e.to];
      const k = tree.byId[e.to];
      if (tree.mvInfo[e.to]) {
        const nm = tree.rmuById[e.to] ? (tree.rmuById[e.to].name || 'RMU') : (tree.msById[e.to] || {}).name;
        edgeSvg += this._mvEdge(a, b, tree.mvInfo[e.to], nm, P);
        continue;
      }
      const px = a.x + this.NODE_W, py = a.y + this.NODE_H / 2;
      const cx = b.x, cy = b.y + this.NODE_H / 2;
      const mx = (px + cx) / 2;
      const kr = resById[e.to];
      const legVD = Retic._legFeederVD(e.to, resById);
      const amps = kr ? (kr.feederA != null ? kr.feederA : kr.currentA) : null;
      const cable = this._cableShort(k && k.feederCable);
      const len = k && k.feederLength ? `${k.feederLength} m` : '';
      const sub = [cable, len].filter(Boolean).join(' · ');
      const tip = `${k ? k.name : ''} feeder: ${cable || 'no cable'}`
        + `${len ? ', ' + len : ''}${amps != null ? ', carrying ' + amps + ' A' : ''}`
        + `, leg volt drop ${this._fmtPct(legVD)}`;

      edgeSvg += `<g><title>${this._esc(tip)}</title>`
        + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.edge}" stroke-width="1.4"/>`
        + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.edge}"/>`
        + `<text x="${mx}" y="${cy - 14}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.ink}">${this._esc(this._fmtPct(legVD))}</text>`
        + (sub ? `<text x="${mx}" y="${cy - 4}" text-anchor="middle" font-size="8.5" fill="${P.muted}">${this._esc(sub)}</text>` : '')
        + `</g>`;
    }

    // Ring ties: dashed, routed down the column gutters and along a lane
    // beneath the diagram so they never cross a node.
    let ringSvg = '';
    let ri = 0;
    for (const t of (tree.ring || [])) {
      const a = L.pos[t.from], b = L.pos[t.to];
      if (!a || !b) continue;
      const nameOf = (id) => tree.rmuById[id] ? (tree.rmuById[id].name || 'RMU') : ((tree.msById[id] || {}).name || '');
      const sx = a.x + this.NODE_W, sy = a.y + this.NODE_H * 0.8;
      const ex = b.x, ey = b.y + this.NODE_H * 0.8;
      const xr = sx + 10 + 5 * ri, xl = ex - 14 - 5 * ri;
      const yb = L.baseH + 8 + ri * 22;
      const cable = this._cableShort(t.info.cable);
      const len = t.info.len ? `${t.info.len} m` : '';
      const sub = ['Ring tie', cable, len].filter(Boolean).join(' · ');
      const lx = (Math.min(xr, xl) + Math.max(xr, xl)) / 2;
      ringSvg += `<g><title>${this._esc(`Ring tie ${nameOf(t.from)} ↔ ${nameOf(t.to)}: ${cable || 'no cable'}${len ? ', ' + len : ''}`)}</title>`
        + `<path d="M ${sx} ${sy} H ${xr} V ${yb} H ${xl} V ${ey} H ${ex}" fill="none" stroke="${P.accent}" stroke-width="1.8" stroke-dasharray="6 4"/>`
        + `<text x="${lx}" y="${yb - 4}" text-anchor="middle" font-size="9" font-weight="700" fill="${P.accent}">${this._esc(sub)}</text></g>`;
      ri++;
    }

    let nodeSvg = '';
    for (const n of L.nodes) {
      nodeSvg += n.isRmu ? this._rmuNode(n, tree, P)
        : n.isMs ? this._minisubNode(n, msById[n.id], tree, P)
        : this._kioskNode(n, tree, resById, P, limit);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}"
        role="img" aria-label="Reticulation topology: ${tree.minisubs.length} minisub(s) feeding ${tree.kiosks.length} kiosk(s), annotated with per-leg and cumulative volt drop and connection counts"
        font-family="Helvetica, Arial, sans-serif">
      <rect x="0" y="0" width="${L.w}" height="${L.h}" fill="${P.surface}"/>
      ${edgeSvg}
      ${ringSvg}
      ${nodeSvg}
    </svg>`;
  },

  // MV leg between two minisubs (Demand › MV fed from): cable and length.
  _mvEdge(a, b, info, name, P) {
    const px = a.x + this.NODE_W, py = a.y + this.NODE_H / 2;
    const cx = b.x, cy = b.y + this.NODE_H / 2;
    const mx = (px + cx) / 2;
    const cable = this._cableShort(info && info.cable);
    const len = info && info.len ? `${info.len} m` : '';
    const sub = [cable, len].filter(Boolean).join(' · ');
    return `<g><title>${this._esc(`${name || ''} MV feed: ${cable || 'no cable'}${len ? ', ' + len : ''}`)}</title>`
      + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.accent}" stroke-width="2"/>`
      + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.accent}"/>`
      + `<text x="${mx}" y="${cy - 14}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.accent}">MV</text>`
      + (sub ? `<text x="${mx}" y="${cy - 4}" text-anchor="middle" font-size="8.5" fill="${P.muted}">${this._esc(sub)}</text>` : '')
      + `</g>`;
  },

  // An RMU drawn on the plan between (or above) minisubs.
  _rmuNode(n, tree, P) {
    const el = tree.rmuById[n.id] || {};
    const W = this.NODE_W, H = this.NODE_H;
    const name = this._trunc(el.name || 'RMU', 24);
    const nOut = (tree.children[n.id] || []).length;
    const dxf = { NAME: el.name || 'RMU', ID: n.id.replace(/^rmu:/, ''), TYPE: 'Ring main unit', MV_FEEDS_OUT: nOut };
    return `<g><title>${this._esc(`${name} — ring main unit, ${nOut} outgoing MV feed${nOut === 1 ? '' : 's'}`)}</title>
      <g data-dxf-block="RMU" data-dxf-at="${n.x},${n.y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${P.rmu}" stroke-width="1.6"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.rmu}" opacity="0.18"/>
      <text x="${n.x + 10}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      <text x="${n.x + 10}" y="${n.y + 38}" font-size="10.5" font-weight="600" fill="${P.rmu}">Ring main unit</text>
      <text x="${n.x + 10}" y="${n.y + 53}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="FEEDS_LABEL">${nOut} MV feed${nOut === 1 ? '' : 's'} out</text>
    </g></g>`;
  },

  _minisubNode(n, mr, tree, P) {
    const ms = tree.minisubs.find(m => m.id === n.id);
    const W = this.NODE_W, H = this.NODE_H;
    const name = this._trunc((ms && ms.name) || 'Minisub', 24);
    const l1 = mr ? `${mr.totalKVA} kVA · ${mr.currentA} A` : '—';
    const l2 = mr ? `${mr.conns} conns · ${mr.numKiosks} kiosk${mr.numKiosks === 1 ? '' : 's'}` : '—';
    const supply = ms && !ms.mvFedFrom && !tree.mvInfo[n.id] && ms.mvLength
      ? [this._cableShort(ms.mvCable), `${ms.mvLength} m`].filter(Boolean).join(' · ') : '';
    const dxf = { NAME: (ms && ms.name) || 'Minisub', ID: n.id, KVA: mr ? mr.totalKVA : '', CURRENT_A: mr ? mr.currentA : '',
      CONNS: mr ? mr.conns : '', KIOSKS: mr ? mr.numKiosks : '', EARTHING: (ms && ms.earthing) || 'TN-S',
      MV_FED_FROM: this._nodeName(tree, ms && ms.mvFedFrom) || 'MV supply', MV_CABLE: (ms && ms.mvCable) || '',
      MV_LENGTH_M: (ms && ms.mvLength) || '' };
    return `<g><title>${this._esc(`${name} — diversified demand ${l1}; ${l2}`)}</title>
      <g data-dxf-block="MINISUB" data-dxf-at="${n.x},${n.y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.msBody}" stroke="${P.border}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.msHead}"/>
      <text x="${n.x + 10}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      <text x="${n.x + 10}" y="${n.y + 38}" font-size="10.5" font-weight="600" fill="${P.accent}" data-dxf-attr="DEMAND_LABEL">${this._esc(l1)}</text>
      <text x="${n.x + 10}" y="${n.y + 53}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="CONNS_LABEL">${this._esc(l2)}</text>
      ${supply ? `<text x="${n.x + W - 8}" y="${n.y + 15}" text-anchor="end" font-size="8.5" fill="${P.muted}" data-dxf-attr="MV_SUPPLY_LABEL">${this._esc('MV supply · ' + supply)}</text>` : ''}
    </g></g>`;
  },

  _kioskNode(n, tree, resById, P, limit) {
    const k = tree.byId[n.id];
    const kr = resById[n.id];
    const W = this.NODE_W, H = this.NODE_H;
    const cum = Retic._cumulativeFeederVD(n.id, resById);
    const fail = cum != null && limit > 0 && cum > limit;
    const stripe = cum == null ? P.border : (fail ? P.fail : P.pass);
    const name = this._trunc((k && k.name) || 'Kiosk', 20);

    // Cumulative volt-drop pill, top-right of the header band.
    const pillW = 46, pillX = n.x + W - 8 - pillW;
    const pillTxt = this._fmtPct(cum);
    const pillFill = cum == null ? P.muted : (fail ? P.fail : P.pass);

    // Phase strip — active erven only, 3Ø kept separate from R/W/B.
    const pc = this._phaseCounts(k);
    const chips = [
      ['R', pc.Red, P.phase.Red], ['W', pc.White, P.phase.White],
      ['B', pc.Blue, P.phase.Blue], ['3Ø', pc['3 Phase'], P.phase['3 Phase']],
    ];
    if (pc.other > 0) chips.push(['?', pc.other, P.phase.other]);
    const step = pc.other > 0 ? 36 : 44;
    let chipSvg = '';
    chips.forEach((c, i) => {
      const cx = n.x + 12 + i * step;
      chipSvg += `<circle cx="${cx}" cy="${n.y + 33}" r="3.2" fill="${c[2]}"/>`
        + `<text x="${cx + 6}" y="${n.y + 36.5}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="ERVEN_${['R', 'W', 'B', '3P', 'UNASSIGNED'][i]}">${c[0]} ${c[1]}</text>`;
    });

    // Downstream totals, this kiosk included. The erf count is unweighted; the
    // connection count is the backend's weighted figure (a 3Ø erf = 3 conns).
    const erven = this._subtreeErfCount(n.id, tree.children, tree.byId);
    const conns = kr && kr.subtreeConns != null ? kr.subtreeConns : null;
    const nk = kr && kr.subtreeKiosks != null ? kr.subtreeKiosks : null;
    const foot = `↓ ${erven} erven` + (conns != null ? ` · ${conns} conns` : '')
      + (nk != null ? ` · ${nk} kiosk${nk === 1 ? '' : 's'}` : '');

    const tip = `${name} — cumulative volt drop from minisub ${pillTxt}`
      + (limit > 0 ? ` (limit ${limit}%)` : '')
      + `\nAt this kiosk: R ${pc.Red}, W ${pc.White}, B ${pc.Blue}, 3-phase ${pc['3 Phase']}`
      + (pc.other ? `, unassigned ${pc.other}` : '')
      + `\nDownstream incl. this kiosk: ${erven} erven`
      + (conns != null ? `, ${conns} connections (3-phase counted as 3)` : '')
      + (nk != null ? `, ${nk} kiosks` : '')
      + (kr ? `\nDemand at this kiosk: ${kr.totalKVA} kVA; feeder carries ${kr.feederKVA != null ? kr.feederKVA : kr.totalKVA} kVA` : '');

    const dxf = { NAME: (k && k.name) || 'Kiosk', ID: n.id, FED_FROM: this._nodeName(tree, k && k.fedFrom),
      FEEDER_CABLE: (k && k.feederCable) || '', FEEDER_LENGTH_M: (k && k.feederLength) || '',
      CUM_VD_PCT: cum != null ? cum.toFixed(2) : '', VD_LIMIT_PCT: limit || '', STATUS: cum == null ? 'not computed' : (fail ? 'fail' : 'pass'),
      KVA: kr ? kr.totalKVA : '', FEEDER_KVA: kr ? (kr.feederKVA != null ? kr.feederKVA : kr.totalKVA) : '',
      ERVEN_DOWNSTREAM: erven, CONNS_DOWNSTREAM: conns != null ? conns : '', KIOSKS_DOWNSTREAM: nk != null ? nk : '' };
    return `<g><title>${this._esc(tip)}</title><g data-dxf-block="KIOSK" data-dxf-at="${n.x},${n.y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${P.border}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.nodeHead}"/>
      <rect x="${n.x}" y="${n.y + 3}" width="3.5" height="${H - 6}" fill="${stripe}"/>
      <text x="${n.x + 12}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      <rect x="${pillX}" y="${n.y + 4}" width="${pillW}" height="14" rx="7" fill="${pillFill}" opacity="0.16"/>
      <text x="${pillX + pillW / 2}" y="${n.y + 14.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${pillFill}" data-dxf-attr="VD_LABEL">${this._esc(pillTxt)}</text>
      ${chipSvg}
      <text x="${n.x + 12}" y="${n.y + 52}" font-size="9.5" fill="${P.muted}" data-dxf-attr="DOWNSTREAM_LABEL">${this._esc(foot)}</text>
    </g></g>`;
  },

  // ─── Render into the modal ───
  render() {
    const host = document.getElementById('retic-diagram-canvas');
    if (!host) return;
    const dark = document.body.classList.contains('dark-mode');
    const svg = this.buildSVG({ dark });
    if (!svg) {
      host.innerHTML = '<div class="retic-empty">Nothing to draw yet — add minisubs or kiosks (or use ⚡ Quick Build) and the topology will appear here.</div>';
      return;
    }
    host.innerHTML = svg;
    this._applyZoom();
  },

  _applyZoom() {
    const el = document.querySelector('#retic-diagram-canvas svg');
    if (!el) return;
    el.setAttribute('width', Math.round(this._size.w * this._zoom));
    el.setAttribute('height', Math.round(this._size.h * this._zoom));
    const lbl = document.getElementById('rdg-zoom-label');
    if (lbl) lbl.textContent = Math.round(this._zoom * 100) + '%';
  },

  zoom(factor) {
    this._zoom = Math.min(3, Math.max(0.25, this._zoom * factor));
    this._applyZoom();
  },

  // Scale that fits the diagram to the scroll surface's width, never past 1:1.
  _fitZoom() {
    const host = document.getElementById('retic-diagram-canvas');
    if (!host || !this._size.w) return 1;
    const avail = host.clientWidth - 24;
    return avail > 0 ? Math.min(1, Math.max(0.25, avail / this._size.w)) : 1;
  },

  fit() {
    this._zoom = this._fitZoom();
    this._applyZoom();
  },

  // Opening zoom. Fitting a wide estate into a phone gives a legible-at-nothing
  // 27 % thumbnail, so the initial view keeps the labels readable and lets the
  // user pan instead; the Fit button is still an honest fit-to-width.
  autoZoom() {
    this._zoom = Math.max(0.75, this._fitZoom());
    this._applyZoom();
  },

  // Display name of a minisub / kiosk / RMU node id ('' when none).
  _nodeName(tree, id) {
    if (!id) return '';
    if (tree.rmuById && tree.rmuById[id]) return tree.rmuById[id].name || 'RMU';
    const m = tree.msById && tree.msById[id];
    if (m) return m.name || '';
    const k = tree.byId && tree.byId[id];
    return k ? (k.name || '') : '';
  },

  // DXF: minisubs, kiosks and RMUs are blocks with their figures as attributes.
  exportDXF() {
    const svg = this.buildSVG({ dark: false });
    if (!svg) { UI.alert('Nothing to export yet — add minisubs or kiosks first.'); return; }
    return DxfExport.exportSvg(svg, { scale: 0.25, geomLayer: 'NETWORK', fileName: `${this._fileBase()}_reticulation_diagram`,
      title: AppState.projectName || '', layers: { NETWORK: null, SYMBOLS: null, TEXT: null } });
  },

  // ─── Export ───
  // Exports always use the light palette so the figure stays legible on paper.
  _exportNode() {
    const svg = this.buildSVG({ dark: false });
    if (!svg) return null;
    const wrap = document.createElement('div');
    wrap.innerHTML = svg;
    return { node: wrap.firstElementChild, w: this._size.w, h: this._size.h };
  },

  _fileBase() {
    return String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_');
  },

  exportSVG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export yet — add minisubs or kiosks first.'); return; }
    const str = new XMLSerializer().serializeToString(ex.node);
    const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this._fileBase()}_reticulation_diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  },

  exportPNG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export yet — add minisubs or kiosks first.'); return; }
    Project._rasterizeSVG(ex.node, ex.w, ex.h, 2, (canvas) => {
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${ReticDiagram._fileBase()}_reticulation_diagram.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
    });
  },

  // PNG data URL for the PDF report. Resolves null when there is nothing to draw.
  rasterize(scale) {
    return new Promise((resolve) => {
      const ex = this._exportNode();
      if (!ex) { resolve(null); return; }
      Project._rasterizeSVG(ex.node, ex.w, ex.h, scale || 2, (canvas) => {
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: ex.w, h: ex.h });
      });
    });
  },
};
