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
 * "Show: Fault current" swaps the boxes' contents for the earth-fault check's
 * figures (AppState.reticResults.earth, /api/analysis/retic-earth-check): the
 * maximum three-phase Ik3 at each busbar, the minimum earth-fault current
 * (L–PE on TN-S, L–PEN on TN-C / TN-C-S) with its clearing time, and the
 * lowest erf current per kiosk. On a phone that view also offers a list.
 *
 * Colours are literal hex from _palette(), not CSS custom properties:
 * Project._rasterizeSVG only resolves `var(--x, fallback)` forms, so bare
 * var() references would rasterize colourless into the PNG/PDF exports.
 *
 * The dialog is the Network overview: an Electrical tab (this diagram) and a
 * Fibre tab (FibreDiagram, fibre-diagram.js). On the Electrical tab, Detail
 * picks Kiosks (every kiosk, each LV string — a kiosk fed straight from the
 * minisub and everything below it — on a band with its breaker, kiosk and
 * erf count) or Strings (one box per string). Street-light circuits hang off
 * the kiosk or minisub that feeds them. A box is outlined red when it fails a
 * check (volt drop over Max Feeder VD, an earth fault that does not clear)
 * and amber when its volt drop is within 10 % of the limit; click a box to go
 * to it.
 */

const ReticDiagram = {
  _bound: false,
  _zoom: 1,
  // View options, kept for the session: what the boxes show, and on a phone
  // whether the fault view is a list or the diagram; the tab of the Network
  // overview and the Electrical tab's detail (kiosks / strings).
  view: { mode: 'vd', show3: true, showE: true, list: true, tab: 'electrical', detail: 'kiosks' },
  _size: { w: 0, h: 0 },
  BAND_HEAD: 26,    // room above each LV string's first kiosk for its band header
  NEAR: 0.9,        // "near the limit" = at or over 90 % of it

  // Geometry (SVG user units, which are CSS px at zoom 1)
  NODE_W: 196,
  NODE_H: 76,
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
    this._syncControls();
    this.render();
    this.autoZoom();
  },

  // Open on a given tab ('electrical' / 'fibre').
  openTab(tab) {
    if (tab === 'fibre' || tab === 'electrical') this.view.tab = tab;
    this.open();
  },

  close() {
    const modal = document.getElementById('retic-diagram-modal');
    if (modal) modal.style.display = 'none';
  },

  _isFibre() { return this.view.tab === 'fibre'; },

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
      const go = e.target.closest('#retic-diagram-canvas [data-go]');
      if (go) { this._go(go.getAttribute('data-go')); return; }
      const btn = e.target.closest('[data-rdg]');
      if (!btn) return;
      const a = btn.dataset.rdg;
      if (a === 'close') this.close();
      else if (a === 'tab-electrical' || a === 'tab-fibre') { this.view.tab = a.slice(4); this._rerender(); this.autoZoom(); }
      else if (a === 'detail-kiosks' || a === 'detail-strings') { this.view.detail = a.slice(7); this._rerender(); }
      else if (a === 'pdf') this.exportPDF();
      else if (a === 'zoom-in') this.zoom(1.25);
      else if (a === 'zoom-out') this.zoom(1 / 1.25);
      else if (a === 'fit') this.fit();
      else if (a === 'png') this.exportPNG();
      else if (a === 'svg') this.exportSVG();
      else if (a === 'dxf') this.exportDXF();
      else if (a === 'mode-vd' || a === 'mode-fault') { this.view.mode = a.slice(5); this._rerender(); }
      else if (a === 'show3' || a === 'showE') {
        const other = a === 'show3' ? 'showE' : 'show3';
        if (this.view[a] && !this.view[other]) return;          // one always stays on
        this.view[a] = !this.view[a];
        this._rerender();
      }
      else if (a === 'view-list' || a === 'view-diagram') { this.view.list = a === 'view-list'; this._rerender(); }
    });
    // Keyboard: a box is focusable; Enter / Space goes to it.
    modal.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const go = e.target.closest && e.target.closest('#retic-diagram-canvas [data-go]');
      if (go) { e.preventDefault(); this._go(go.getAttribute('data-go')); }
    });
  },

  // Go to a box's item (Demand row, street-light circuit, plan element), with
  // a ← Back chip to the workspace the dialog was opened from.
  _go(addr) {
    if (!addr || typeof Links === 'undefined') return;
    const ws = (typeof window !== 'undefined' && window.activeWorkspace) || 'retic';
    this.close();
    Links.go(addr, 'tab:' + ws);
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
    // The MV point of supply above every top minisub that has no supply RMU
    // drawn: one 'mv:supply' root, each minisub's own MV cable on its leg.
    const topMs = roots.filter(id => msIds.has(id));
    if (topMs.length) {
      children['mv:supply'] = topMs;
      for (const id of topMs) {
        const m = msById[id];
        if (!mvInfo[id] && (m.mvCable || m.mvLength)) mvInfo[id] = { cable: m.mvCable || '', len: m.mvLength || 0 };
      }
      roots.splice(0, roots.length, 'mv:supply', ...roots.filter(id => !msIds.has(id)));
    }
    // Street-light circuits hang off the kiosk / minisub that feeds them
    // ('sl:<circuit id>' leaves, after that node's own kiosks).
    const slById = {};
    for (const c of this._slCircuits()) {
      const s = c && c.source && c.source.id;
      if (!s || !(byId[s] || msById[s])) continue;
      const id = 'sl:' + c.id;
      slById[id] = c;
      children[id] = [];
      children[s].push(id);
    }
    return { minisubs, kiosks, byId, msById, msIds, rmuById, mvInfo, ring, roots, children, slById };
  },

  _slCircuits() {
    const sl = AppState.reticulation && AppState.reticulation.streetLighting;
    return sl && Array.isArray(sl.circuits) ? sl.circuits : [];
  },

  // ─── LV strings ───
  // A string = a kiosk fed straight from a minisub and every kiosk below it,
  // with the street-light circuits those kiosks feed. Pure over the tree
  // (cableMm2 = name → mm², for the taper check). Numbered per minisub.
  strings(tree, cableMm2) {
    const mm2 = cableMm2 || ((n) => this._cableMm2(n));
    const out = [];
    for (const ms of tree.minisubs) {
      let n = 0;
      for (const h of tree.children[ms.id] || []) {
        if (!tree.byId[h]) continue;
        const ids = [], seen = new Set();
        const walk = (id) => {
          if (seen.has(id)) return;
          seen.add(id); ids.push(id);
          for (const c of tree.children[id] || []) if (tree.byId[c]) walk(c);
        };
        walk(h);
        const sl = [];
        let erven = 0, tapered = false;
        for (const id of ids) {
          const k = tree.byId[id];
          erven += (k.erfs || []).filter(e => this._isActive(e)).length;
          for (const c of tree.children[id] || []) {
            if (c.startsWith('sl:')) sl.push(c);
            else if (tree.byId[c]) {
              const a = mm2(k.feederCable), b = mm2(tree.byId[c].feederCable);
              if (a && b && b < a) tapered = true;
            }
          }
        }
        out.push({ id: 'str:' + h, ms: ms.id, head: h, n: ++n, kiosks: ids, sl, erven, tapered });
      }
    }
    return out;
  },

  _cableMm2(name) {
    if (!name || typeof CableLib === 'undefined') return 0;
    const c = CableLib.byName(name);
    return c && c.size_mm2 ? Number(c.size_mm2) : 0;
  },

  // The tree with each string folded into one 'str:<head>' node: the
  // minisub's head kiosk is replaced by it, and the street-light circuits of
  // its kiosks hang off it. Kiosks are no longer reachable, so not laid out.
  _stringTree(tree, strings) {
    const ch = {};
    for (const k of Object.keys(tree.children)) ch[k] = tree.children[k].slice();
    const strById = {};
    for (const s of strings) {
      const list = ch[s.ms];
      const i = list.indexOf(s.head);
      if (i >= 0) list[i] = s.id;
      ch[s.id] = s.sl.slice();
      strById[s.id] = s;
    }
    return Object.assign({}, tree, { children: ch, kioskChildren: tree.children, strById, heads: null });
  },

  // 'fail' | 'warn' | 'ok' | null (nothing calculated) for one kiosk: its
  // cumulative feeder volt drop against Max Feeder VD, and the earth-fault
  // check at the kiosk and its erven.
  _kioskVerdict(id, resById, limit, FD) {
    const cum = Retic._cumulativeFeederVD(id, resById);
    const d = FD && FD.k[id];
    if ((cum != null && limit > 0 && cum > limit) || (d && (d.status === 'fail' || d.nErfFail))) return 'fail';
    if (cum != null && limit > 0 && cum >= this.NEAR * limit) return 'warn';
    return cum == null && !d ? null : 'ok';
  },

  _worst(list) {
    if (list.includes('fail')) return 'fail';
    if (list.includes('warn')) return 'warn';
    return list.includes('ok') ? 'ok' : null;
  },

  // A street-light circuit's verdict from Street lighting's own results
  // (calculated when that workspace runs; not saved).
  _slResult(c) {
    const R = typeof StreetLight !== 'undefined' && StreetLight._results;
    return (R && c && R[c.id]) || null;
  },
  _slVerdict(c) {
    const r = this._slResult(c);
    if (!r) return null;
    if (!r.pass) return 'fail';
    const near = (v, lim) => v != null && lim > 0 && v >= this.NEAR * lim;
    return near(r.worstCumVdPct, r.cumVdLimitPct) || near(r.worstVdPct, r.vdLimitPct) ? 'warn' : 'ok';
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
  // Active erven per phase over every kiosk fed (transitively) from a minisub.
  // A child that is not a kiosk (another minisub on the MV side) is not ours.
  _subtreePhaseCounts(rootId, children, byId) {
    const out = { Red: 0, White: 0, Blue: 0, '3 Phase': 0, other: 0 };
    const seen = new Set();
    const walk = (id) => {
      for (const c of (children[id] || [])) {
        if (seen.has(c) || !byId[c]) continue;
        seen.add(c);
        const pc = this._phaseCounts(byId[c]);
        for (const key of Object.keys(out)) out[key] += pc[key];
        walk(c);
      }
    };
    walk(rootId);
    return out;
  },

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
      // An LV string's band header needs a strip above its first kiosk.
      if (tree.heads && tree.heads.has(id)) row += this.BAND_HEAD / this.ROW_H;
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
      edge: '#55556e', rmu: '#f87171', accent: '#4a9eff', pass: '#69db7c', fail: '#ff6b6b', tag3: '#475569', tagE: '#0f766e',
      warn: '#fbbf24', sl: '#f59e0b', slHead: '#3d2e12', band: '#232b40', bandInk: '#93b4ff',
      fibre: '#c084fc', fibreHead: '#33264a',
      phase: { Red: '#f87171', White: '#cbd5e1', Blue: '#60a5fa', '3 Phase': '#c084fc', other: '#7c7c96' },
    } : {
      surface: '#ffffff', node: '#ffffff', nodeHead: '#eef1f5', msHead: '#dbeafe', msBody: '#f5f8ff',
      border: '#c9ced6', ink: '#1a1a2e', inkSec: '#555555', muted: '#7a7a88',
      edge: '#9aa0aa', rmu: '#dc2626', accent: '#0078d7', pass: '#2e7d32', fail: '#d32f2f', tag3: '#334155', tagE: '#0f766e',
      warn: '#b45309', sl: '#b45309', slHead: '#fef3c7', band: '#eaf0fb', bandInk: '#1e3a8a',
      fibre: '#6d28d9', fibreHead: '#ede9fe',
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
  // opts.mode / opts.detail override the dialog's view for this one drawing
  // (the PDF report always prints the volt-drop view with every kiosk).
  buildSVG(opts) {
    opts = opts || {};
    const saved = { mode: this.view.mode, detail: this.view.detail };
    if (opts.mode) this.view.mode = opts.mode;
    if (opts.detail) this.view.detail = opts.detail;
    try { return this._buildSVG(opts); } finally { Object.assign(this.view, saved); }
  },

  _buildSVG(opts) {
    let tree = this._tree();
    if (!tree.kiosks.length && !tree.minisubs.length) return '';
    const P = this._palette(!!opts.dark);
    const strings = this.strings(tree);
    const byString = this.view.detail === 'strings';
    if (byString) tree = this._stringTree(tree, strings);
    else tree.heads = new Set(strings.map(s => s.head));
    const L = this._layout(tree);

    const res = AppState.reticResults;
    const resById = {};
    if (res && res.kiosks) for (const kr of res.kiosks) resById[kr.kioskId] = kr;
    const msById = {};
    if (res && res.minisubs) for (const m of res.minisubs) msById[m.minisubId] = m;

    const limit = Number(Retic.settings.maxFeederVD) || 0;
    const FD = this._faultData();
    const ctx = { tree, resById, limit, FD, P };

    // String bands (Kiosks view): behind everything, one per LV string,
    // around its kiosks and the street-light circuits they feed.
    let bandSvg = '';
    if (!byString) {
      for (const s of strings) {
        const ps = s.kiosks.concat(s.sl).map(id => L.pos[id]).filter(Boolean);
        if (!ps.length) continue;
        const x0 = Math.min(...ps.map(p => p.x)) - 10, x1 = Math.max(...ps.map(p => p.x)) + this.NODE_W + 10;
        const y0 = Math.min(...ps.map(p => p.y)) - this.BAND_HEAD + 2, y1 = Math.max(...ps.map(p => p.y)) + this.NODE_H + 6;
        bandSvg += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="8" fill="${P.band}"/>`
          + `<text x="${x0 + 10}" y="${y0 + 15}" font-size="9.5" font-weight="700" letter-spacing="0.3" fill="${P.bandInk}">${this._esc(this._trunc(this._stringHeader(s, tree).toUpperCase(), Math.max(20, Math.floor((x1 - x0 - 20) / 6.2))))}</text>`;
      }
    }

    // Edges first so the node boxes paint over the line ends.
    let edgeSvg = '';
    for (const e of L.edges) {
      const a = L.pos[e.from], b = L.pos[e.to];
      if (e.to.startsWith('sl:')) { edgeSvg += this._slEdge(a, b, e, tree, P); continue; }
      const kid = e.to.startsWith('str:') ? e.to.slice(4) : e.to;   // a string box: its head kiosk's feeder
      const k = tree.byId[kid];
      if (tree.mvInfo[e.to] || e.from === 'mv:supply') {
        const nm = tree.rmuById[e.to] ? (tree.rmuById[e.to].name || 'RMU') : (tree.msById[e.to] || {}).name;
        edgeSvg += this._mvEdge(a, b, tree.mvInfo[e.to], nm, P);
        continue;
      }
      const px = a.x + this.NODE_W, py = a.y + this.NODE_H / 2;
      const cx = b.x, cy = b.y + this.NODE_H / 2;
      const mx = (px + cx) / 2;
      const kr = resById[kid];
      const legVD = Retic._legFeederVD(kid, resById);
      const amps = kr ? (kr.feederA != null ? kr.feederA : kr.currentA) : null;
      const cable = this._cableShort(k && k.feederCable);
      const len = k && k.feederLength ? `${k.feederLength} m` : '';
      const sub = [cable, len].filter(Boolean).join(' · ');
      const tip = `${k ? k.name : ''} feeder: ${cable || 'no cable'}`
        + `${len ? ', ' + len : ''}${amps != null ? ', carrying ' + amps + ' A' : ''}`
        + `, leg volt drop ${this._fmtPct(legVD)}`;

      if (this._isFault()) {
        edgeSvg += `<g><title>${this._esc(`${k ? k.name : ''} feeder: ${cable || 'no cable'}${len ? ', ' + len : ''}`)}</title>`
          + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.edge}" stroke-width="1.4"/>`
          + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.edge}"/>`
          + (cable ? `<text x="${mx}" y="${cy - 14}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.inkSec}">${this._esc(cable)}</text>` : '')
          + (len ? `<text x="${mx}" y="${cy - 4}" text-anchor="middle" font-size="8.5" fill="${P.muted}">${this._esc(len)}</text>` : '')
          + `</g>`;
        continue;
      }
      edgeSvg += `<g><title>${this._esc(tip)}</title>`
        + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.edge}" stroke-width="1.4"/>`
        + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.edge}"/>`
        + `<text x="${mx}" y="${cy - 24}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.ink}">${this._esc(this._fmtPct(legVD))}</text>`
        + (amps != null ? `<rect x="${mx - 27}" y="${cy - 8}" width="54" height="16" rx="8" fill="${P.surface}" stroke="${P.accent}" stroke-width="1.2"/>`
          + `<text x="${mx}" y="${cy + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${P.accent}" data-dxf-attr="FEEDER_A">${this._esc(Math.round(amps * 10) / 10 + ' A')}</text>` : '')
        + (sub ? `<text x="${mx}" y="${cy - 12}" text-anchor="middle" font-size="8.5" fill="${P.muted}">${this._esc(sub)}</text>` : '')
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
    const F = this._isFault() ? FD : null;
    for (const n of L.nodes) {
      const body = n.id === 'mv:supply' ? this._supplyNode(n, tree, msById, P)
        : n.id.startsWith('sl:') ? this._slNode(n, tree, P)
        : n.id.startsWith('str:') ? this._stringNode(n, tree.strById[n.id], ctx)
        : n.isRmu ? this._rmuNode(n, tree, P)
        : F ? this._faultNode(n, tree, F, P, this._kioskVerdict(n.id, resById, limit, FD))
        : n.isMs ? this._minisubNode(n, msById[n.id], tree, P)
        : this._kioskNode(n, tree, resById, P, limit, this._kioskVerdict(n.id, resById, limit, FD));
      nodeSvg += this._clickable(n, tree, body);
    }

    this._size = { w: L.w, h: L.h };
    const nSl = Object.keys(tree.slById || {}).length;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}"
        role="img" aria-label="Network overview: ${tree.minisubs.length} minisub(s) feeding ${tree.kiosks.length} kiosk(s) in ${strings.length} LV string(s)${nSl ? ` and ${nSl} street-light circuit(s)` : ''}, ${byString ? 'one box per string' : 'every kiosk'}, annotated with ${F ? 'the three-phase and earth-fault current at each minisub and kiosk' : 'per-leg and cumulative volt drop and connection counts'}"
        font-family="Helvetica, Arial, sans-serif">
      <rect x="0" y="0" width="${L.w}" height="${L.h}" fill="${P.surface}"/>
      ${bandSvg}
      ${edgeSvg}
      ${ringSvg}
      ${nodeSvg}
    </svg>`;
  },

  // Where a box goes when clicked (a Links address), and the wrapper that
  // makes it a focusable link in the dialog.
  _goOf(id, tree) {
    if (id.startsWith('sl:')) return id;
    if (id.startsWith('str:')) return 'retic:' + id.slice(4);
    if (id.startsWith('rmu:')) return 'plan:' + id.slice(4);
    return (tree.byId[id] || tree.msById[id]) ? 'retic:' + id : '';
  },
  _clickable(n, tree, body) {
    const go = this._goOf(n.id, tree);
    return go ? `<g data-go="${this._esc(go)}" tabindex="0" style="cursor:pointer">${body}</g>` : body;
  },

  // The MV point of supply: the minisubs it feeds and their diversified demand.
  _supplyNode(n, tree, msRes, P) {
    const W = this.NODE_W, H = this.NODE_H, x = n.x, y = n.y;
    const all = tree.minisubs.length;
    const kva = tree.minisubs.reduce((s, m) => s + (msRes[m.id] && Number(msRes[m.id].totalKVA) || 0), 0);
    const direct = (tree.children['mv:supply'] || []).length;
    const l1 = `${all} minisub${all === 1 ? '' : 's'}${direct < all ? ` (${direct} fed direct)` : ''}`;
    const l2 = kva ? `Demand ${Math.round(kva)} kVA` : 'Demand not calculated';
    const dxf = { NAME: 'MV supply', TYPE: 'MV point of supply', MINISUBS: all, DEMAND_KVA: kva ? Math.round(kva) : '' };
    return `<g><title>${this._esc(`MV point of supply — ${l1}; ${l2} (diversified, sum of the minisubs)`)}</title>
      <g data-dxf-block="MV_SUPPLY" data-dxf-at="${x},${y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${P.msBody}" stroke="${P.border}"/>
      <path d="M ${x} ${y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.msHead}"/>
      <text x="${x + 10}" y="${y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">MV supply</text>
      <text x="${x + W - 8}" y="${y + 15}" text-anchor="end" font-size="8" font-weight="700" fill="${P.accent}">POINT OF SUPPLY</text>
      <text x="${x + 10}" y="${y + 40}" font-size="10.5" font-weight="600" fill="${P.accent}" data-dxf-attr="MINISUBS_LABEL">${this._esc(l1)}</text>
      <text x="${x + 10}" y="${y + 58}" font-size="10" fill="${P.inkSec}" data-dxf-attr="DEMAND_LABEL">${this._esc(l2)}</text>
    </g></g>`;
  },

  // Header of a string's band / box: "String 2 · 160 A MCCB · 3 kiosks · 28 erven · tapered".
  _stringHeader(s, tree) {
    const dev = typeof Retic !== 'undefined' && Retic._protectionDevice ? Retic._protectionDevice(tree.byId[s.head]) : null;
    const ms = tree.msById[s.ms];
    return [`${tree.minisubs.length > 1 && ms ? (ms.name || 'Minisub') + ' · ' : ''}String ${s.n}`,
      dev ? dev.name : 'no string breaker',
      `${s.kiosks.length} kiosk${s.kiosks.length === 1 ? '' : 's'}`, `${s.erven} erven`,
      s.tapered ? 'tapered' : ''].filter(Boolean).join(' · ');
  },

  // Outline of a box for its verdict.
  _outline(v, P) {
    return v === 'fail' ? { stroke: P.fail, w: 2.2 } : v === 'warn' ? { stroke: P.warn, w: 2.2 } : { stroke: P.border, w: 1 };
  },

  // Street-light circuit leg: amber, from the kiosk / minisub (or the string
  // box, then labelled with the kiosk that feeds it).
  _slEdge(a, b, e, tree, P) {
    const px = a.x + this.NODE_W, py = a.y + this.NODE_H / 2;
    const cx = b.x, cy = b.y + this.NODE_H / 2;
    const mx = (px + cx) / 2;
    const c = tree.slById[e.to];
    const src = c && c.source ? this._nodeName(tree, c.source.id) : '';
    const lbl = e.from.startsWith('str:') && src ? 'from ' + src : '';
    return `<g><title>${this._esc(`${c ? c.name : ''} street lighting, fed from ${src || '—'}`)}</title>`
      + `<path d="M ${px} ${py} H ${mx} V ${cy} H ${cx}" fill="none" stroke="${P.sl}" stroke-width="1.6"/>`
      + `<polygon points="${cx - 7},${cy - 4} ${cx - 7},${cy + 4} ${cx},${cy}" fill="${P.sl}"/>`
      + (lbl ? `<text x="${mx}" y="${cy - 6}" text-anchor="middle" font-size="9" fill="${P.inkSec}">${this._esc(this._trunc(lbl, 18))}</text>` : '')
      + `</g>`;
  },

  // A street-light circuit box: poles, system, kVA, cable, worst volt drop
  // and Zs from Street lighting's last calculation.
  _slNode(n, tree, P) {
    const c = tree.slById[n.id] || { poles: [] };
    const W = this.NODE_W, H = this.NODE_H, x = n.x, y = n.y;
    const r = this._slResult(c);
    const v = this._slVerdict(c);
    const o = this._outline(v, P);
    const kva = typeof StreetLight !== 'undefined' && StreetLight.circuitKVA ? StreetLight.circuitKVA(c) : null;
    const sys = c.system === '1ph' ? '1Φ' : '3Φ';
    const poles = (c.poles || []).length;
    const vd = r ? (r.worstCumVdPct != null ? r.worstCumVdPct : r.worstVdPct) : null;
    const l1 = `${poles} pole${poles === 1 ? '' : 's'} · ${sys}${kva != null ? ` · ${kva.toFixed(2)} kVA` : ''}`;
    const l2 = [this._cableShort(c.cable), vd != null ? `VD ${vd.toFixed(2)}%` : ''].filter(Boolean).join(' · ');
    const l3 = r ? (r.pass ? (v === 'warn' ? 'Near a limit' : 'Pass') + (r.zsPass ? ' · Zs ok' : '') : 'Fails: ' + (r.fails || []).join(', ')) : 'Open Street lighting to calculate';
    const l3c = v === 'fail' ? P.fail : v === 'warn' ? P.warn : v === 'ok' ? P.pass : P.muted;
    const tip = `${c.name || 'Street-light circuit'} — ${l1}${c.cable ? '\nCable ' + c.cable : ''}`
      + (r ? `\nWorst volt drop ${r.worstVdPct.toFixed(2)} % (limit ${r.vdLimitPct} %), cumulative ${r.worstCumVdPct != null ? r.worstCumVdPct.toFixed(2) : '—'} % (limit ${r.cumVdLimitPct} %)\nZs ${r.zsPass ? 'clears' : 'does not clear'} the protective device` : '\nNot calculated yet — open Street lighting.');
    const dxf = { NAME: c.name || '', ID: c.id || '', TYPE: 'Street-light circuit', SOURCE: c.source ? this._nodeName(tree, c.source.id) : '',
      POLES: poles, SYSTEM: sys, KVA: kva != null ? kva.toFixed(2) : '', CABLE: c.cable || '',
      WORST_VD_PCT: r ? r.worstVdPct : '', CUM_VD_PCT: r && r.worstCumVdPct != null ? r.worstCumVdPct : '', ZS_OK: r ? (r.zsPass ? 'yes' : 'no') : '',
      STATUS: v || 'not computed' };
    return `<g><title>${this._esc(tip)}</title>
      <g data-dxf-block="SL_CIRCUIT" data-dxf-at="${x},${y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${o.stroke}" stroke-width="${o.w}"/>
      <path d="M ${x + 1} ${y + 7} a 6 6 0 0 1 6 -6 h ${W - 14} a 6 6 0 0 1 6 6 v 14 h -${W - 2} z" fill="${P.slHead}"/>
      <text x="${x + 10}" y="${y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(this._trunc(c.name || 'Street lights', 20))}</text>
      <text x="${x + W - 8}" y="${y + 15}" text-anchor="end" font-size="8" font-weight="700" fill="${P.sl}">STREET LIGHT</text>
      <text x="${x + 10}" y="${y + 37}" font-size="10" fill="${P.inkSec}" data-dxf-attr="POLES_LABEL">${this._esc(l1)}</text>
      <text x="${x + 10}" y="${y + 52}" font-size="10" fill="${P.inkSec}" data-dxf-attr="CABLE_LABEL">${this._esc(l2 || '—')}</text>
      <text x="${x + 10}" y="${y + 68}" font-size="9.5" font-weight="700" fill="${l3c}" data-dxf-attr="STATUS_LABEL">${this._esc(this._trunc(l3, 34))}</text>
    </g></g>`;
  },

  // One box per LV string (Strings view): kiosk range, kiosks, erven, head
  // cable, worst cumulative volt drop (or the lowest earth-fault current),
  // head breaker; outlined by the worst of its kiosks.
  _stringNode(n, s, ctx) {
    const { tree, resById, limit, FD, P } = ctx;
    const W = this.NODE_W, H = this.NODE_H, x = n.x, y = n.y;
    if (!s) return '';
    const v = this._worst(s.kiosks.map(id => this._kioskVerdict(id, resById, limit, FD)));
    const o = this._outline(v, P);
    const head = tree.byId[s.head] || {};
    const last = tree.byId[s.kiosks[s.kiosks.length - 1]] || {};
    const range = s.kiosks.length > 1 ? `${head.name || ''}–${last.name || ''}` : (head.name || '');
    const cums = s.kiosks.map(id => Retic._cumulativeFeederVD(id, resById)).filter(x => x != null);
    const worst = cums.length ? Math.max(...cums) : null;
    const dev = Retic._protectionDevice ? Retic._protectionDevice(head) : null;
    const l1 = `${s.kiosks.length} kiosk${s.kiosks.length === 1 ? '' : 's'} · ${s.erven} erven · ${this._cableShort(head.feederCable) || 'no cable'}`;
    let l2;
    if (this._isFault()) {
      const ds = s.kiosks.map(id => FD.k[id]).filter(Boolean);
      const lo = ds.filter(d => d.ik1 != null).sort((a, b) => a.ik1 - b.ik1)[0];
      l2 = lo ? `Earth fault min ${this._fmtA(lo.ik1)}${lo.tS != null ? ' · ' + this._fmtS(lo.tS) : ''}` : 'Earth fault: run Demand';
    } else {
      l2 = `VD ${this._fmtPct(worst)}${s.tapered ? ' · tapered' : ''}`;
    }
    const l3 = dev ? dev.name : 'No string breaker';
    const vc = v === 'fail' ? P.fail : v === 'warn' ? P.warn : v === 'ok' ? P.pass : P.muted;
    const tip = `${this._stringHeader(s, tree)}\nKiosks ${s.kiosks.map(id => (tree.byId[id] || {}).name || id).join(', ')}`
      + (worst != null ? `\nWorst cumulative volt drop ${worst.toFixed(2)} %${limit ? ` (limit ${limit} %)` : ''}` : '')
      + (s.sl.length ? `\nFeeds ${s.sl.length} street-light circuit${s.sl.length === 1 ? '' : 's'}` : '');
    const dxf = { NAME: `String ${s.n}`, ID: s.head, MINISUB: this._nodeName(tree, s.ms), HEAD_KIOSK: head.name || '', KIOSKS: s.kiosks.length,
      ERVEN: s.erven, HEAD_CABLE: head.feederCable || '', BREAKER: dev ? dev.name : '', WORST_CUM_VD_PCT: worst != null ? worst.toFixed(2) : '',
      TAPERED: s.tapered ? 'yes' : 'no', STATUS: v || 'not computed' };
    return `<g><title>${this._esc(tip)}</title>
      <g data-dxf-block="LV_STRING" data-dxf-at="${x},${y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${o.stroke}" stroke-width="${o.w}"/>
      <path d="M ${x + 1} ${y + 7} a 6 6 0 0 1 6 -6 h ${W - 14} a 6 6 0 0 1 6 6 v 14 h -${W - 2} z" fill="${P.band}"/>
      <text x="${x + 10}" y="${y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(this._trunc(`String ${s.n} · ${range}`, 26))}</text>
      <text x="${x + 10}" y="${y + 37}" font-size="10" fill="${P.inkSec}" data-dxf-attr="KIOSKS_LABEL">${this._esc(this._trunc(l1, 34))}</text>
      <text x="${x + 10}" y="${y + 52}" font-size="10" font-weight="700" fill="${vc}" data-dxf-attr="VD_LABEL">${this._esc(this._trunc(l2, 34))}</text>
      <text x="${x + 10}" y="${y + 68}" font-size="9.5" fill="${P.muted}" data-dxf-attr="BREAKER_LABEL">${this._esc(this._trunc(l3, 34))}</text>
    </g></g>`;
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
      <text x="${n.x + 10}" y="${n.y + 36}" font-size="10.5" font-weight="600" fill="${P.rmu}">Ring main unit</text>
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
    // Erven per phase, same chips as a kiosk ("?" only when some have no phase set).
    const pc = this._subtreePhaseCounts(n.id, tree.kioskChildren || tree.children, tree.byId);
    const chips = [
      ['R', pc.Red, P.phase.Red], ['W', pc.White, P.phase.White],
      ['B', pc.Blue, P.phase.Blue], ['3Ø', pc['3 Phase'], P.phase['3 Phase']],
    ];
    if (pc.other > 0) chips.push(['?', pc.other, P.phase.other]);
    const step = pc.other > 0 ? 36 : 44;
    let chipSvg = '';
    chips.forEach((c, i) => {
      const cx = n.x + 12 + i * step;
      chipSvg += `<circle cx="${cx}" cy="${n.y + 52.5}" r="3.2" fill="${escHtml(c[2])}"/>`
        + `<text x="${cx + 6}" y="${n.y + 56}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="ERVEN_${['R', 'W', 'B', '3P', 'UNASSIGNED'][i]}">${c[0]} ${c[1]}</text>`;
    });
    const dxf = { NAME: (ms && ms.name) || 'Minisub', ID: n.id, KVA: mr ? mr.totalKVA : '', CURRENT_A: mr ? mr.currentA : '',
      ERVEN_R: pc.Red, ERVEN_W: pc.White, ERVEN_B: pc.Blue, ERVEN_3P: pc['3 Phase'], ERVEN_UNASSIGNED: pc.other,
      CONNS: mr ? mr.conns : '', KIOSKS: mr ? mr.numKiosks : '', EARTHING: (ms && ms.earthing) || 'TN-S',
      MV_FED_FROM: this._nodeName(tree, ms && ms.mvFedFrom) || 'MV supply', MV_CABLE: (ms && ms.mvCable) || '',
      MV_LENGTH_M: (ms && ms.mvLength) || '' };
    return `<g><title>${this._esc(`${name} — diversified demand ${l1}; ${l2}\nErven: R ${pc.Red}, W ${pc.White}, B ${pc.Blue}, 3-phase ${pc['3 Phase']}${pc.other ? `, unassigned ${pc.other}` : ''}`)}</title>
      <g data-dxf-block="MINISUB" data-dxf-at="${n.x},${n.y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.msBody}" stroke="${P.border}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.msHead}"/>
      <text x="${n.x + 10}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      <text x="${n.x + 10}" y="${n.y + 38}" font-size="10.5" font-weight="600" fill="${P.accent}" data-dxf-attr="DEMAND_LABEL">${this._esc(l1)}</text>
      <text x="${n.x + 10}" y="${n.y + 70}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="CONNS_LABEL">${this._esc(l2)}</text>
      ${chipSvg}
      ${supply ? `<text x="${n.x + W - 8}" y="${n.y + 15}" text-anchor="end" font-size="8.5" fill="${P.muted}" data-dxf-attr="MV_SUPPLY_LABEL">${this._esc('MV supply · ' + supply)}</text>` : ''}
    </g></g>`;
  },

  _kioskNode(n, tree, resById, P, limit, verdict) {
    const o = this._outline(verdict, P);
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
      chipSvg += `<circle cx="${cx}" cy="${n.y + 33}" r="3.2" fill="${escHtml(c[2])}"/>`
        + `<text x="${cx + 6}" y="${n.y + 36.5}" font-size="9.5" fill="${P.inkSec}" data-dxf-attr="ERVEN_${['R', 'W', 'B', '3P', 'UNASSIGNED'][i]}">${c[0]} ${c[1]}</text>`;
    });

    // Downstream totals, this kiosk included. The erf count is unweighted; the
    // connection count is the backend's weighted figure (a 3Ø erf = 3 conns).
    const erven = this._subtreeErfCount(n.id, tree.children, tree.byId);
    const conns = kr && kr.subtreeConns != null ? kr.subtreeConns : null;
    const nk = kr && kr.subtreeKiosks != null ? kr.subtreeKiosks : null;
    const load = kr ? `Load ${kr.totalKVA} kVA · ${kr.worstPhaseA != null ? kr.worstPhaseA : kr.currentA} A${kr.worstPhaseA != null ? ' worst ph' : ''}` : '';
    const foot = `↓ ${erven} erven` + (conns != null ? ` · ${conns} conns` : '')
      + (nk != null ? ` · ${nk} kiosk${nk === 1 ? '' : 's'}` : '');

    const tip = `${name} — cumulative volt drop from minisub ${pillTxt}`
      + (limit > 0 ? ` (limit ${limit}%)` : '')
      + `\nAt this kiosk: R ${pc.Red}, W ${pc.White}, B ${pc.Blue}, 3-phase ${pc['3 Phase']}`
      + (pc.other ? `, unassigned ${pc.other}` : '')
      + `\nDownstream incl. this kiosk: ${erven} erven`
      + (conns != null ? `, ${conns} connections (3-phase counted as 3)` : '')
      + (nk != null ? `, ${nk} kiosks` : '')
      + (kr ? `\nDemand at this kiosk: ${kr.totalKVA} kVA, ${kr.currentA} A average, ${kr.worstPhaseA != null ? kr.worstPhaseA : kr.currentA} A on the worst phase; feeder carries ${kr.feederKVA != null ? kr.feederKVA : kr.totalKVA} kVA` : '');

    const dxf = { NAME: (k && k.name) || 'Kiosk', ID: n.id, FED_FROM: this._nodeName(tree, k && k.fedFrom),
      FEEDER_CABLE: (k && k.feederCable) || '', FEEDER_LENGTH_M: (k && k.feederLength) || '',
      CUM_VD_PCT: cum != null ? cum.toFixed(2) : '', VD_LIMIT_PCT: limit || '', STATUS: cum == null ? 'not computed' : (fail ? 'fail' : 'pass'),
      KVA: kr ? kr.totalKVA : '', WORST_PHASE_A: kr && kr.worstPhaseA != null ? kr.worstPhaseA : '', FEEDER_KVA: kr ? (kr.feederKVA != null ? kr.feederKVA : kr.totalKVA) : '',
      ERVEN_DOWNSTREAM: erven, CONNS_DOWNSTREAM: conns != null ? conns : '', KIOSKS_DOWNSTREAM: nk != null ? nk : '' };
    return `<g><title>${this._esc(tip)}</title><g data-dxf-block="KIOSK" data-dxf-at="${n.x},${n.y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${o.stroke}" stroke-width="${o.w}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.nodeHead}"/>
      <rect x="${n.x}" y="${n.y + 3}" width="3.5" height="${H - 6}" fill="${stripe}"/>
      <text x="${n.x + 12}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      <rect x="${pillX}" y="${n.y + 4}" width="${pillW}" height="14" rx="7" fill="${pillFill}" opacity="0.16"/>
      <text x="${pillX + pillW / 2}" y="${n.y + 14.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${pillFill}" data-dxf-attr="VD_LABEL">${this._esc(pillTxt)}</text>
      ${chipSvg}
      ${load ? `<text x="${n.x + 12}" y="${n.y + 50}" font-size="10" font-weight="700" fill="${P.ink}" data-dxf-attr="LOAD_LABEL">${this._esc(load)}</text>` : ''}
      <text x="${n.x + 12}" y="${n.y + 66}" font-size="9.5" fill="${P.muted}" data-dxf-attr="DOWNSTREAM_LABEL">${this._esc(foot)}</text>
    </g></g>`;
  },

  // ─── Fault current view ───
  _fmtA(a) { return a == null ? '—' : a >= 1000 ? (a / 1000).toFixed(2) + ' kA' : Math.round(a) + ' A'; },
  _fmtS(t) { return t == null ? '' : t < 1 ? t.toFixed(2) + ' s' : t.toFixed(1) + ' s'; },

  // Per minisub / kiosk figures from the earth-fault check, or null for a
  // node it did not reach. {ik3, ik1, earthing, tS, status, tAllow, erf}
  _faultData() {
    const earth = AppState.reticResults && AppState.reticResults.earth;
    const out = { ms: {}, k: {}, any: !!earth };
    if (!earth) return out;
    for (const m of earth.minisubs || []) {
      out.ms[m.minisubId] = { ik3: m.ik3A, ik1: m.ik1A, earthing: m.earthing || 'TN-S', zeOhm: m.zeOhm };
    }
    for (const k of earth.kiosks || []) {
      const l = k.loop || {};
      // Lowest erf current, a failing erf first.
      const erfs = (k.erfs || []).filter(e => e.loop && e.loop.ifA != null);
      const failing = erfs.filter(e => e.loop.status === 'fail');
      const pick = (failing.length ? failing : erfs).slice().sort((a, b) => a.loop.ifA - b.loop.ifA)[0] || null;
      out.k[k.kioskId] = {
        ik3: k.ik3A, ik1: l.ifA, earthing: k.earthing || 'TN-S', tS: l.tS, status: l.status, tAllow: l.tAllowS,
        erf: pick ? { name: pick.erfNumber || pick.erfId, ifA: pick.loop.ifA, ok: pick.loop.status !== 'fail' } : null,
        nErfFail: failing.length,
      };
    }
    return out;
  },

  _faultVerdict(isMs, d) {
    if (!d || isMs) return null;
    if (d.status === 'fail' || d.nErfFail) return false;
    return d.status === 'pass' ? true : null;
  },

  _faultTip(name, isMs, d) {
    if (!d) return `${name} — run the Demand calculation to see its fault currents.`;
    const pen = d.earthing !== 'TN-S';
    let t = `${name} (${d.earthing})\nThree-phase Ik3 max ${this._fmtA(d.ik3)} (c 1.10, conductors at 20 °C)`
      + `\nEarth fault ${pen ? 'L–PEN' : 'L–PE'} Ik1 min ${this._fmtA(d.ik1)} (c 0.95, conductors hot)`;
    if (isMs) return t + (d.zeOhm != null ? `\nAt the LV busbar, Ze ${(d.zeOhm * 1000).toFixed(1)} mΩ` : '');
    t += d.tS != null ? `, clears in ${this._fmtS(d.tS)}${d.tAllow ? (d.status === 'pass' ? ` — within ${d.tAllow} s` : ` — over ${d.tAllow} s`) : ''}`
      : (d.status === 'fail' ? ', does not clear' : '');
    if (d.erf) t += `\nLowest erf: Erf ${d.erf.name}, ${this._fmtA(d.erf.ifA)}${d.erf.ok ? '' : ' — does not clear in time'}`;
    if (d.nErfFail > 1) t += ` (${d.nErfFail} erven fail)`;
    return t;
  },

  // A minisub or kiosk box in the fault view.
  _faultNode(n, tree, F, P, verdict) {
    const o = this._outline(n.isMs ? null : verdict, P);
    const isMs = n.isMs;
    const el = isMs ? tree.msById[n.id] : tree.byId[n.id];
    const d = isMs ? F.ms[n.id] : F.k[n.id];
    const W = this.NODE_W, H = this.NODE_H, x = n.x, y = n.y;
    const nameFull = (el && el.name) || (isMs ? 'Minisub' : 'Kiosk');
    const name = this._trunc(nameFull, 18);
    const ok = this._faultVerdict(isMs, d);
    const stripe = ok == null ? P.border : ok ? P.pass : P.fail;
    const earthing = d ? d.earthing : ((isMs ? el && el.earthing : '') || '');
    const pen = earthing && earthing !== 'TN-S';
    const rows = [];
    if (this.view.show3) rows.push('3');
    if (this.view.showE) rows.push('E');
    const rowY = (k) => y + (rows.length === 2 ? 26 : 32) + rows.indexOf(k) * 18;
    const badgeW = earthing ? earthing.length * 6 + 10 : 0;
    const tag = (ty, fill, label) => `<rect x="${x + 12}" y="${ty}" width="54" height="14" rx="3" fill="${escHtml(fill)}"/>`
      + `<text x="${x + 39}" y="${ty + 10.5}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#ffffff">${label}</text>`;
    let body = '';
    if (!d) {
      body = `<text x="${x + 12}" y="${y + 46}" font-size="9.5" fill="${P.muted}">Run the Demand calculation</text>`;
    } else {
      if (this.view.show3) {
        const ty = rowY('3');
        body += tag(ty, P.tag3, '3Φ max')
          + `<text x="${x + 74}" y="${ty + 11.5}" font-size="12" font-weight="700" fill="${P.ink}" data-dxf-attr="IK3_LABEL">${this._esc(this._fmtA(d.ik3))}</text>`;
      }
      if (this.view.showE) {
        const ty = rowY('E');
        body += tag(ty, P.tagE, pen ? 'L–PEN min' : 'L–PE min')
          + `<text x="${x + 74}" y="${ty + 11.5}" font-size="12" font-weight="700" fill="${P.ink}" data-dxf-attr="IK1_LABEL">${this._esc(this._fmtA(d.ik1))}</text>`;
        if (!isMs && (d.tS != null || d.status === 'fail')) {
          const good = d.status === 'pass';
          const c = good ? P.pass : P.fail;
          body += `<rect x="${x + W - 58}" y="${ty}" width="50" height="14" rx="7" fill="${c}" opacity="0.16"/>`
            + `<text x="${x + W - 33}" y="${ty + 10.5}" text-anchor="middle" font-size="9" font-weight="700" fill="${c}" data-dxf-attr="CLEAR_LABEL">${this._esc(d.tS != null ? this._fmtS(d.tS) : 'no trip')}</text>`;
        }
      }
      let foot = '', footC = P.muted;
      if (isMs) foot = d.zeOhm != null ? `LV busbar · Ze ${(d.zeOhm * 1000).toFixed(1)} mΩ` : 'LV busbar';
      else if (this.view.showE && d.erf) {
        foot = `Erven min ${this._fmtA(d.erf.ifA)} · Erf ${d.erf.name}${d.erf.ok ? ' ✓' : ' ✕'}`;
        if (!d.erf.ok) footC = P.fail;
      } else if (!this.view.showE) foot = '';
      if (foot) body += `<text x="${x + 12}" y="${y + (rows.length === 2 ? 70 : 64)}" font-size="9.5" fill="${footC}" data-dxf-attr="FAULT_FOOT">${this._esc(this._trunc(foot, 34))}</text>`;
    }
    const dxf = { NAME: nameFull, ID: n.id, TYPE: isMs ? 'Minisub' : 'Kiosk', EARTHING: earthing,
      IK3_MAX_A: d && d.ik3 != null ? d.ik3 : '', IK1_MIN_A: d && d.ik1 != null ? d.ik1 : '',
      CLEARING_S: d && d.tS != null ? d.tS : '', STATUS: ok == null ? '' : ok ? 'pass' : 'fail',
      LOWEST_ERF: d && d.erf ? d.erf.name : '', LOWEST_ERF_A: d && d.erf ? d.erf.ifA : '' };
    return `<g><title>${this._esc(this._faultTip(nameFull, isMs, d))}</title>
      <g data-dxf-block="${isMs ? 'MINISUB_FAULT' : 'KIOSK_FAULT'}" data-dxf-at="${x},${y}" data-dxf-attrs="${this._esc(JSON.stringify(dxf))}">
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${isMs ? P.msBody : P.node}" stroke="${o.stroke}" stroke-width="${o.w}"/>
      <path d="M ${x} ${y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${isMs ? P.msHead : P.nodeHead}"/>
      ${isMs ? '' : `<rect x="${x}" y="${y + 3}" width="3.5" height="${H - 6}" fill="${stripe}"/>`}
      <text x="${x + 12}" y="${y + 15}" font-size="11" font-weight="700" fill="${P.ink}" data-dxf-attr="NAME">${this._esc(name)}</text>
      ${earthing ? `<rect x="${x + W - 8 - badgeW}" y="${y + 4}" width="${badgeW}" height="14" rx="3" fill="${P.surface}" stroke="${P.border}"/>
      <text x="${x + W - 8 - badgeW / 2}" y="${y + 14.5}" text-anchor="middle" font-size="9" font-weight="700" fill="${P.inkSec}" data-dxf-attr="EARTHING">${this._esc(earthing)}</text>` : ''}
      ${body}
    </g></g>`;
  },

  // Phone: the fault view as cards in tree order (depth-first from each root).
  _faultList() {
    const tree = this._tree();
    if (!tree.kiosks.length && !tree.minisubs.length) {
      return '<div class="retic-empty">Nothing to draw yet — add minisubs or kiosks (or use ⚡ Quick Build) and the topology will appear here.</div>';
    }
    const F = this._faultData();
    const items = [], seen = new Set();
    const walk = (id, depth, fromName) => {
      if (seen.has(id)) return;
      seen.add(id);
      const isMs = !!tree.msById[id], isK = !!tree.byId[id];
      if (isMs || isK) items.push({ id, depth, isMs, fromName });
      const nm = this._nodeName(tree, id);
      for (const c of tree.children[id] || []) walk(c, depth + (isMs || isK ? 1 : 0), nm);
    };
    tree.roots.forEach(r => walk(r, 0, ''));
    const cards = items.map(it => {
      const el = it.isMs ? tree.msById[it.id] : tree.byId[it.id];
      const d = it.isMs ? F.ms[it.id] : F.k[it.id];
      const ok = this._faultVerdict(it.isMs, d);
      const name = (el && el.name) || (it.isMs ? 'Minisub' : 'Kiosk');
      const from = it.isMs ? '' : `← ${it.fromName || ''}${el && el.feederLength ? ' · ' + el.feederLength + ' m' : ''}`;
      let rows = '';
      if (!d) rows = '<div class="rdg-card-foot">Run the Demand calculation to see its fault currents.</div>';
      else {
        const pen = d.earthing !== 'TN-S';
        if (this.view.show3) rows += `<div class="rdg-card-row"><b class="rdg-tag rdg-tag-3">3Φ max</b><strong>${this._fmtA(d.ik3)}</strong></div>`;
        if (this.view.showE) {
          const pill = !it.isMs && (d.tS != null || d.status === 'fail')
            ? `<b class="rdg-pill ${d.status === 'pass' ? 'rdg-pill-ok' : 'rdg-pill-bad'}">${d.tS != null ? 'clears ' + this._fmtS(d.tS) : 'no trip'}</b>` : '';
          rows += `<div class="rdg-card-row"><b class="rdg-tag rdg-tag-e">${pen ? 'L–PEN min' : 'L–PE min'}</b><strong>${this._fmtA(d.ik1)}</strong>${pill}</div>`;
          if (!it.isMs && d.erf) rows += `<div class="rdg-card-foot${d.erf.ok ? '' : ' rdg-bad'}">Erven min ${this._fmtA(d.erf.ifA)} · Erf ${this._esc(d.erf.name)}${d.erf.ok ? ' ✓' : ' ✕ too slow'}</div>`;
        }
        if (it.isMs && d.zeOhm != null) rows += `<div class="rdg-card-foot">LV busbar · Ze ${(d.zeOhm * 1000).toFixed(1)} mΩ</div>`;
      }
      return `<div class="rdg-card${it.isMs ? ' rdg-card-ms' : ''}${ok === false ? ' rdg-card-bad' : ok ? ' rdg-card-ok' : ''}" style="margin-left:${Math.min(it.depth, 3) * 10}px" title="${this._esc(this._faultTip(name, it.isMs, d))}">
        <div class="rdg-card-head"><b>${this._esc(name)}</b><span>${this._esc(from)}</span>${d ? `<em>${this._esc(d.earthing)}</em>` : ''}</div>${rows}</div>`;
    }).join('');
    return `<div class="rdg-list">${F.any ? '' : '<div class="rdg-card-foot">No earth-fault results yet — run the Demand calculation.</div>'}${cards}</div>`;
  },

  // ─── Render into the modal ───
  _isFault() { return this.view.mode === 'fault'; },
  _isPhone() { return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches); },

  _rerender() {
    this._syncControls();
    this.render();
  },

  // Toolbar state, title and legend for the current view.
  _syncControls() {
    const modal = document.getElementById('retic-diagram-modal');
    if (!modal) return;
    const fault = this._isFault();
    const press = (sel, on) => { const b = modal.querySelector(sel); if (b) b.setAttribute('aria-pressed', String(!!on)); };
    press('[data-rdg="mode-vd"]', !fault);
    press('[data-rdg="mode-fault"]', fault);
    press('[data-rdg="show3"]', this.view.show3);
    press('[data-rdg="showE"]', this.view.showE);
    press('[data-rdg="view-list"]', this.view.list);
    press('[data-rdg="view-diagram"]', !this.view.list);
    const fibre = this._isFibre();
    press('[data-rdg="tab-electrical"]', !fibre);
    press('[data-rdg="tab-fibre"]', fibre);
    press('[data-rdg="detail-kiosks"]', this.view.detail !== 'strings');
    press('[data-rdg="detail-strings"]', this.view.detail === 'strings');
    const show = (sel, on) => { const el = modal.querySelector(sel); if (el) el.hidden = !on; };
    show('.rdg-seg', !fibre);
    show('.rdg-detail', !fibre);
    show('.rdg-kinds', fault && !fibre);
    show('.rdg-views', fault && !fibre);
    show('.rdg-legend-fault', fault && !fibre);
    show('.rdg-legend-vd', !fault && !fibre);
    show('.rdg-legend-net', !fibre);
    show('.rdg-legend-fibre', fibre);
    const t = document.getElementById('rdg-title');
    if (t) t.textContent = fibre ? 'Network overview — Fibre'
      : fault ? 'Network overview — Fault current' : 'Network overview — Volt drop & connections';
  },

  // The drawing of the open tab: {svg, w, h} ('' svg when there is nothing).
  _current(opts) {
    if (this._isFibre()) {
      const svg = typeof FibreDiagram !== 'undefined' ? FibreDiagram.buildSVG(opts) : '';
      return { svg, w: svg ? FibreDiagram._size.w : 0, h: svg ? FibreDiagram._size.h : 0 };
    }
    const svg = this.buildSVG(opts);
    return { svg, w: this._size.w, h: this._size.h };
  },

  _emptyText() {
    return this._isFibre()
      ? 'Nothing to draw yet — draw manholes and fibre backbone routes on the plan (or create them with Auto layout) and the fibre network will appear here.'
      : 'Nothing to draw yet — add minisubs or kiosks (or use ⚡ Quick Build) and the topology will appear here.';
  },

  render() {
    const host = document.getElementById('retic-diagram-canvas');
    if (!host) return;
    const dark = document.body.classList.contains('dark-mode');
    if (this._isFibre()) {
      host.classList.remove('rdg-list-mode');
      const cur = this._current({ dark });
      if (!cur.svg) { host.innerHTML = `<div class="retic-empty">${this._emptyText()}</div>`; return; }
      this._size = { w: cur.w, h: cur.h };
      host.innerHTML = cur.svg;
      this._applyZoom();
      return;
    }
    if (this._isFault() && this.view.list && this._isPhone()) {
      host.innerHTML = this._faultList();
      host.classList.add('rdg-list-mode');
      return;
    }
    host.classList.remove('rdg-list-mode');
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

  // ─── Export (the open tab) ───
  // Exports always use the light palette so the figure stays legible on paper.
  _nothing() {
    UI.alert(this._isFibre() ? 'Nothing to export yet — draw manholes and fibre backbone routes on the plan first.'
      : 'Nothing to export yet — add minisubs or kiosks first.');
  },
  _fileTag() {
    return this._isFibre() ? 'fibre_network' : (this.view.detail === 'strings' ? 'network_overview_strings' : 'network_overview');
  },

  // DXF: minisubs, kiosks, strings, street-light circuits, RMUs and manholes
  // are blocks with their figures as attributes.
  exportDXF() {
    const cur = this._current({ dark: false });
    if (!cur.svg) { this._nothing(); return; }
    return DxfExport.exportSvg(cur.svg, { scale: 0.25, geomLayer: 'NETWORK', fileName: `${this._fileBase()}_${this._fileTag()}`,
      title: AppState.projectName || '', layers: { NETWORK: null, SYMBOLS: null, TEXT: null } });
  },

  _exportNode(opts) {
    const cur = opts && opts.electrical ? (() => { const svg = this.buildSVG(opts); return { svg, w: this._size.w, h: this._size.h }; })()
      : this._current(Object.assign({ dark: false }, opts || {}));
    if (!cur.svg) return null;
    const wrap = document.createElement('div');
    wrap.innerHTML = cur.svg;
    return { node: wrap.firstElementChild, w: cur.w, h: cur.h };
  },

  _fileBase() {
    return String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_');
  },

  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },

  exportSVG() {
    const ex = this._exportNode();
    if (!ex) { this._nothing(); return; }
    const str = new XMLSerializer().serializeToString(ex.node);
    this._download(new Blob([str], { type: 'image/svg+xml' }), `${this._fileBase()}_${this._fileTag()}.svg`);
  },

  exportPNG() {
    const ex = this._exportNode();
    if (!ex) { this._nothing(); return; }
    const name = `${this._fileBase()}_${this._fileTag()}.png`;
    Project._rasterizeSVG(ex.node, ex.w, ex.h, 2, (canvas) => {
      canvas.toBlob((blob) => this._download(blob, name), 'image/png');
    });
  },

  // One landscape page (A3 when the drawing is large), the drawing fitted
  // under a title line.
  async exportPDF() {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const ex = this._exportNode();
    if (!ex) { this._nothing(); return; }
    const title = document.getElementById('rdg-title');
    const heading = title ? title.textContent : 'Network overview';
    const dg = await new Promise((resolve) => Project._rasterizeSVG(ex.node, ex.w, ex.h, 2, (c) => resolve({ dataUrl: c.toDataURL('image/png'), w: ex.w, h: ex.h })));
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: ex.w > 1600 || ex.h > 1100 ? 'a3' : 'a4' });
    this.addPage(doc, dg, heading, AppState.projectName || '', true);
    doc.save(`${this._fileBase()}_${this._fileTag()}.pdf`);
  },

  // A diagram raster on its own page of a jsPDF document (shared with the
  // Demand report). `first` = draw on the current page instead of adding one.
  addPage(doc, dg, heading, sub, first) {
    if (!first) doc.addPage();
    const margin = 12;
    doc.setFontSize(12); doc.setFont('helvetica', 'bold');
    doc.text(heading, margin, margin + 4);
    if (sub) { doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.text(String(sub), margin, margin + 10, { maxWidth: doc.internal.pageSize.getWidth() - margin * 2 }); }
    const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    const top = margin + 15;
    const fit = Math.min((pageW - margin * 2) / dg.w, (pageH - top - margin) / dg.h);
    const imgW = dg.w * fit, imgH = dg.h * fit;
    doc.setDrawColor(200);
    doc.rect(margin, top, imgW, imgH);
    // 'FAST' = Flate; a flat-colour schematic compresses hard.
    doc.addImage(dg.dataUrl, 'PNG', margin, top, imgW, imgH, undefined, 'FAST');
  },

  // PNG data URL for the PDF report: the Electrical tab, volt-drop view, every
  // kiosk (whatever the dialog shows). `which` = 'fibre' for the Fibre tab.
  // Resolves null when there is nothing to draw.
  rasterize(scale, which) {
    return new Promise((resolve) => {
      let ex;
      if (which === 'fibre') {
        const svg = typeof FibreDiagram !== 'undefined' ? FibreDiagram.buildSVG({ dark: false }) : '';
        if (svg) { const wrap = document.createElement('div'); wrap.innerHTML = svg; ex = { node: wrap.firstElementChild, w: FibreDiagram._size.w, h: FibreDiagram._size.h }; }
      } else ex = this._exportNode({ electrical: true, dark: false, mode: 'vd', detail: 'kiosks' });
      if (!ex) { resolve(null); return; }
      Project._rasterizeSVG(ex.node, ex.w, ex.h, scale || 2, (canvas) => {
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: ex.w, h: ex.h });
      });
    });
  },
};

// Output › Network overview… (shown on a project with Demand; Ctrl K lists it).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('btn-network-overview');
    if (b) b.addEventListener('click', () => ReticDiagram.open());
  });
}
