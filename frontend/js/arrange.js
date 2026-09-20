/* ProtectionPro — Arrange: align & distribute, and layered auto-arrange.
 *
 * Align / distribute are pure geometry on the selection. autoArrange() lays
 * the network out in layers (sources on top, loads below): BFS layering from
 * the sources, barycentre ordering to cut wire crossings, relaxed x placement,
 * buses widened to span their connections. Wires store only port references and
 * are routed at render time, so nothing needs re-routing except the free
 * 'at_<x>' attachment points on buses. Each command is one undo step. Extents respect rotation and a bus's own busWidth, so a 90°
 * bus aligns by its real footprint, not its unrotated box.
 */

const Arrange = {
  _extent(comp) {
    const def = COMPONENT_DEFS[comp.type] || {};
    let w = def.width || 60;
    let h = def.height || 60;
    if (comp.type === 'bus') w = comp.props?.busWidth || w;
    if (((comp.rotation || 0) / 90) % 2 !== 0) [w, h] = [h, w];
    return { hw: w / 2, hh: h / 2 };
  },

  _selected() {
    const list = [];
    for (const id of AppState.selectedIds) {
      const c = AppState.components.get(id);
      if (c) list.push(c);
    }
    return list;
  },

  // mode: left | center | right | top | middle | bottom
  align(mode) {
    const comps = this._selected();
    if (comps.length < 2) return this._need(2);
    const ext = comps.map(c => this._extent(c));
    const horiz = mode === 'left' || mode === 'center' || mode === 'right';
    const lo = c => (horiz ? c.x - ext[comps.indexOf(c)].hw : c.y - ext[comps.indexOf(c)].hh);
    const hi = c => (horiz ? c.x + ext[comps.indexOf(c)].hw : c.y + ext[comps.indexOf(c)].hh);
    const minV = Math.min(...comps.map(lo));
    const maxV = Math.max(...comps.map(hi));
    const mid = snapToGrid((minV + maxV) / 2);
    comps.forEach((c, i) => {
      const half = horiz ? ext[i].hw : ext[i].hh;
      let v;
      if (mode === 'left' || mode === 'top') v = minV + half;
      else if (mode === 'right' || mode === 'bottom') v = maxV - half;
      else v = mid;
      v = snapToGrid(v);
      if (horiz) c.x = v; else c.y = v;
    });
    this._commit();
  },

  // axis: 'h' spreads left→right, 'v' top→bottom; equal gaps between edges.
  distribute(axis) {
    const comps = this._selected();
    if (comps.length < 3) return this._need(3);
    const h = axis === 'h';
    const items = comps.map(c => {
      const e = this._extent(c);
      return { c, half: h ? e.hw : e.hh, pos: h ? c.x : c.y };
    }).sort((a, b) => a.pos - b.pos);
    const first = items[0], last = items[items.length - 1];
    const start = first.pos - first.half;
    const end = last.pos + last.half;
    const total = items.reduce((s, it) => s + it.half * 2, 0);
    const gap = (end - start - total) / (items.length - 1);
    let cursor = start;
    items.forEach((it, i) => {
      if (i > 0 && i < items.length - 1) {
        const v = snapToGrid(cursor + it.half);
        if (h) it.c.x = v; else it.c.y = v;
      }
      cursor += it.half * 2 + gap;
    });
    this._commit();
  },

  // ── Auto-arrange ─────────────────────────────────────────────────
  SOURCE_TYPES: new Set(['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery']),
  SPACING: { compact: [40, 60], normal: [60, 100], wide: [100, 160] }, // [in-layer, between-layers]
  _opts: { direction: 'down', spacing: 'normal' },
  _session: null, // live preview: { pool ids, originals, wires }
  BUS_PER_LINK: 100,

  _gaps() { return this.SPACING[this._opts.spacing] || this.SPACING.normal; },

  // Arrange the selection (2+ components) or, with no selection, every
  // component on the active page. Pinned parts stay where they are. The
  // result is a live preview with Keep / Cancel; nothing is undoable until Keep.
  autoArrange(fromSelection = false) {
    this._closePreview(true);
    const sel = this._selected();
    let rootId = null;
    let candidates;
    if (fromSelection) {
      const bus = sel.length === 1 ? sel[0] : null;
      if (!bus) return UI.toast('Select one bus (or part) to arrange from.', 'warning');
      rootId = bus.id;
      candidates = this._downstream(bus);
    } else {
      candidates = sel.length >= 2
        ? sel
        : [...AppState.components.values()].filter(c => !c.pageId || c.pageId === AppState.activePageId);
    }
    const pool = candidates.filter(c => !c.pinned || c.id === rootId);
    if (pool.length < 2) return this._need(2);
    const ids = new Set(pool.map(c => c.id));
    const wires = [];
    for (const w of AppState.wires.values()) {
      if (w.fromComponent !== w.toComponent && (ids.has(w.fromComponent) || ids.has(w.toComponent))) wires.push(w);
    }
    this._session = {
      root: rootId,
      ids,
      wires,
      orig: pool.map(c => ({ c, x: c.x, y: c.y, rotation: c.rotation, busWidth: c.props?.busWidth })),
      origWires: wires.map(w => ({ w, fromPort: w.fromPort, toPort: w.toPort })),
    };
    this._run();
    this._showPreview();
  },

  // The selected part plus everything it feeds: walk away from the sources
  // (the same distance ordering the layout uses) over this page's wires.
  _downstream(start) {
    const page = [...AppState.components.values()].filter(c => !c.pageId || c.pageId === AppState.activePageId);
    const ids = new Set(page.map(c => c.id));
    const adj = new Map(page.map(c => [c.id, []]));
    for (const w of AppState.wires.values()) {
      if (w.fromComponent === w.toComponent || !ids.has(w.fromComponent) || !ids.has(w.toComponent)) continue;
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }
    const sources = page.filter(c => this.SOURCE_TYPES.has(c.type)).map(c => c.id);
    const dist = new Map(sources.map(id => [id, 0]));
    const queue = [...sources];
    while (queue.length) {
      const id = queue.shift();
      for (const n of adj.get(id)) if (!dist.has(n)) { dist.set(n, dist.get(id) + 1); queue.push(n); }
    }
    const order = new Map(page.map((c, i) => [c.id, i]));
    const rank = id => (dist.has(id) ? dist.get(id) : 1e3) * 1e6 + order.get(id);
    const seen = new Set([start.id]);
    const stack = [start.id];
    while (stack.length) {
      const id = stack.pop();
      for (const n of adj.get(id)) {
        if (!seen.has(n) && rank(n) > rank(id) && !this.SOURCE_TYPES.has(AppState.components.get(n).type)) { seen.add(n); stack.push(n); }
      }
    }
    return [...seen].map(id => AppState.components.get(id));
  },

  _restore() {
    const s = this._session;
    if (!s) return;
    for (const o of s.orig) {
      o.c.x = o.x; o.c.y = o.y; o.c.rotation = o.rotation;
      if (o.busWidth !== undefined) o.c.props.busWidth = o.busWidth;
    }
    for (const o of s.origWires) { o.w.fromPort = o.fromPort; o.w.toPort = o.toPort; }
  },

  _run() {
    const s = this._session;
    const pool = s.orig.map(o => o.c);
    const ids = s.ids;
    const adj = new Map(pool.map(c => [c.id, new Set()]));
    const wires = s.wires;
    for (const w of wires) {
      if (!ids.has(w.fromComponent) || !ids.has(w.toComponent)) continue;
      adj.get(w.fromComponent).add(w.toComponent);
      adj.get(w.toComponent).add(w.fromComponent);
    }

    // Connected components, left-to-right by where they were drawn.
    const seen = new Set();
    const groups = [];
    for (const c of [...pool].sort((a, b) => a.x - b.x || a.y - b.y)) {
      if (seen.has(c.id)) continue;
      const grp = [], stack = [c.id];
      seen.add(c.id);
      while (stack.length) {
        const id = stack.pop();
        grp.push(id);
        for (const n of adj.get(id)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
      groups.push(grp);
    }

    const minX0 = Math.min(...pool.map(c => c.x));
    const minY0 = Math.min(...pool.map(c => c.y));

    // Reset rotation and size buses first: extents depend on both.
    for (const c of pool) {
      c.rotation = this._opts.direction === 'right' ? 270 : 0;
      if (c.type === 'bus') {
        c.props.busWidth = Math.max(120, Math.ceil(adj.get(c.id).size * 60 / 20) * 20);
      }
    }

    let cursor = 0;
    for (const grp of groups) {
      const box = this._layoutGroup(grp, adj, cursor);
      cursor = box.maxX + 120;
    }

    // Shift the whole result back to where the selection started.
    const placed = pool.map(c => ({ c, e: this._extent(c) }));
    const lx = Math.min(...placed.map(p => p.c.x - p.e.hw));
    const ly = Math.min(...placed.map(p => p.c.y - p.e.hh));
    let dx = snapToGrid(minX0 - lx), dy = snapToGrid(minY0 - ly);
    if (s.root) {
      // Keep the chosen part where it is; the rest hangs from it.
      const r = s.orig.find(o => o.c.id === s.root);
      dx = snapToGrid(r.x - r.c.x); dy = snapToGrid(r.y - r.c.y);
    }
    for (const p of placed) { p.c.x += dx; p.c.y += dy; }

    // Buses: re-attach each wire under/over (or beside) the part it feeds.
    const vertical = this._opts.direction !== 'right';
    for (const w of wires) {
      for (const [ck, pk, ok, opk] of [
        ['fromComponent', 'fromPort', 'toComponent', 'toPort'],
        ['toComponent', 'toPort', 'fromComponent', 'fromPort'],
      ]) {
        const bus = AppState.components.get(w[ck]);
        if (!ids.has(bus.id) || bus.type !== 'bus') continue;
        const other = AppState.components.get(w[ok]);
        const o = Symbols.getPortWorldPosition(other, w[opk]);
        const hw = (bus.props.busWidth || 120) / 2;
        // Local bar x: +x along the bar; a 270° bar runs up the screen.
        const off = vertical ? o.x - bus.x : bus.y - o.y;
        w[pk] = `at_${Math.max(-hw, Math.min(hw, snapToGrid(off)))}`;
      }
    }
    AppState.dirty = true;
    AppState.invalidateResults?.();
    Canvas.render();
  },

  _showPreview() {
    let bar = document.getElementById('arrange-preview');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'arrange-preview';
      bar.setAttribute('role', 'dialog');
      bar.setAttribute('aria-label', 'Auto-arrange preview');
      bar.style.cssText = 'position:fixed;left:50%;top:calc(var(--toolbar-height) + 12px);transform:translateX(-50%);z-index:900;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:13px var(--font-family)';
      bar.innerHTML =
        '<strong>Auto-arrange preview</strong>' +
        '<label>Flow <select id="arr-dir"><option value="down">Top to bottom</option><option value="right">Left to right</option></select></label>' +
        '<label>Spacing <select id="arr-space"><option value="compact">Compact</option><option value="normal">Normal</option><option value="wide">Wide</option></select></label>' +
        '<button type="button" id="arr-keep" class="dropdown-item" style="width:auto;background:var(--accent);color:#fff;border-radius:4px;padding:4px 12px">Keep</button>' +
        '<button type="button" id="arr-cancel" class="dropdown-item" style="width:auto;border:1px solid var(--border-color);border-radius:4px;padding:4px 12px">Cancel</button>';
      document.body.appendChild(bar);
      const rerun = () => {
        this._opts.direction = bar.querySelector('#arr-dir').value;
        this._opts.spacing = bar.querySelector('#arr-space').value;
        this._restore();
        this._run();
      };
      bar.querySelector('#arr-dir').addEventListener('change', rerun);
      bar.querySelector('#arr-space').addEventListener('change', rerun);
      bar.querySelector('#arr-keep').addEventListener('click', () => this._closePreview(false));
      bar.querySelector('#arr-cancel').addEventListener('click', () => this._closePreview(true));
    }
    bar.querySelector('#arr-dir').value = this._opts.direction;
    bar.querySelector('#arr-space').value = this._opts.spacing;
  },

  // cancel = true restores the layout from before the preview.
  _closePreview(cancel) {
    document.getElementById('arrange-preview')?.remove();
    const s = this._session;
    if (!s) return;
    if (cancel) {
      this._restore();
      this._session = null;
      Canvas.render();
      return;
    }
    this._session = null;
    UndoManager.snapshot();
    UI.toast(`Arranged ${s.ids.size} components.`, 'success');
  },

  // Pin / unpin the selection: pinned parts are skipped by auto-arrange.
  togglePin() {
    const comps = this._selected();
    if (!comps.length) return this._need(1);
    const pin = !comps.every(c => c.pinned);
    for (const c of comps) { if (pin) c.pinned = true; else delete c.pinned; }
    AppState.dirty = true;
    UndoManager.snapshot();
    UI.toast(`${pin ? 'Pinned' : 'Unpinned'} ${comps.length} component${comps.length > 1 ? 's' : ''}.`, 'success');
  },

  // Two-terminal parts that sit in a feeder run (they get tight vertical spacing).
  LINK_TYPES: new Set(['cb', 'cable', 'fuse', 'switch', 'ct', 'pt', 'relay', 'bus_duct', 'surge_arrester']),

  // Lay one connected group out starting at across = startX; returns {maxX}
  // (the far edge across the layers).
  _layoutGroup(grp, adj, startX) {
    const comps = new Map(grp.map(id => [id, AppState.components.get(id)]));
    const ext = new Map(grp.map(id => [id, this._extent(comps.get(id))]));
    const vert = this._opts.direction !== 'right';
    const isBus = id => comps.get(id).type === 'bus';
    const busW = new Map(grp.filter(isBus).map(id => [id, comps.get(id).props.busWidth || 120]));
    // Lateral = across a layer, flow = along the source-to-load direction.
    const lat = id => (isBus(id) ? busW.get(id) / 2 : vert ? ext.get(id).hw : ext.get(id).hh);
    const flow = id => (isBus(id) ? 4 : vert ? ext.get(id).hh : ext.get(id).hw);
    const isSource = id => this.SOURCE_TYPES.has(comps.get(id).type);

    // 1. Layers. Orient every edge away from the sources (BFS distance, ties
    // broken by id) so the graph is acyclic, then take the LONGEST path from
    // the sources: every wire then runs downhill, however many routes feed a
    // part, and feeders from a second supply stretch rather than fold back.
    const rootId = this._session && this._session.root;
    let roots = rootId && grp.includes(rootId) ? [rootId] : grp.filter(isSource);
    if (!roots.length) {
      roots = [[...grp].sort((a, b) => comps.get(a).y - comps.get(b).y || comps.get(a).x - comps.get(b).x)[0]];
    }
    const dist = new Map(roots.map(id => [id, 0]));
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift();
      for (const n of adj.get(id)) if (!dist.has(n)) { dist.set(n, dist.get(id) + 1); queue.push(n); }
    }
    const down = new Map(grp.map(id => [id, []])); // id -> parts fed from it
    const indeg = new Map(grp.map(id => [id, 0]));
    for (const id of grp) {
      for (const n of adj.get(id)) {
        // Equal distance = the two halves of an interconnector between supplies:
        // both hang from their own side and are joined laterally.
        if (dist.get(id) === dist.get(n)) {
          // A breaker/cable meeting a busbar at equal distance feeds it (from above).
          const idLink = this.LINK_TYPES.has(comps.get(id).type), nLink = this.LINK_TYPES.has(comps.get(n).type);
          if (idLink && !nLink) { down.get(id).push(n); indeg.set(n, indeg.get(n) + 1); }
          continue;
        }
        if (dist.get(id) < dist.get(n) && !(isSource(id) && isSource(n))) { down.get(id).push(n); indeg.set(n, indeg.get(n) + 1); }
      }
    }
    const layerOf = new Map(grp.map(id => [id, 0]));
    const topo = grp.filter(id => indeg.get(id) === 0);
    while (topo.length) {
      const id = topo.shift();
      for (const n of down.get(id)) {
        layerOf.set(n, Math.max(layerOf.get(n), layerOf.get(id) + 1));
        indeg.set(n, indeg.get(n) - 1);
        if (indeg.get(n) === 0) topo.push(n);
      }
    }
    const depth = Math.max(...layerOf.values()) + 1;
    const layers = Array.from({ length: depth }, () => []);
    for (const id of grp) layers[layerOf.get(id)].push(id);
    for (const l of layers) l.sort((a, b) => comps.get(a).x - comps.get(b).x); // keep the drawn left-right order
    const up = new Map(grp.map(id => [id, []]));
    for (const id of grp) for (const n of down.get(id)) up.get(n).push(id);

    // 2. Tree. Every part hangs from ONE parent: the feeder nearest its
    // supply (ties: the one drawn closest). A tree can always be drawn without
    // crossings, and it makes each breaker/cable a straight drop from its
    // parent. Extra supplies into a part are the only non-tree wires.
    const origX = id => comps.get(id).x;
    const parent = new Map();
    for (const id of grp) {
      const ups = up.get(id);
      if (!ups.length) continue;
      // Nearest supply first; on a tie prefer a busbar (it can take the wire
      // anywhere along its length), then the one drawn closest.
      const hub = k => (this.LINK_TYPES.has(comps.get(k).type) ? 1 : 0);
      ups.sort((a, b) => dist.get(a) - dist.get(b) || hub(a) - hub(b) || Math.abs(origX(a) - origX(id)) - Math.abs(origX(b) - origX(id)));
      parent.set(id, ups[0]);
    }
    const kids = new Map(grp.map(id => [id, []]));
    for (const [id, pr] of parent) kids.get(pr).push(id);
    // A part fed by several independent supply chains (e.g. three generators
    // into one busbar): the chains fan in side by side above it, rather than
    // one being its 'parent' and the rest reaching across the diagram.
    const mean0 = id => origX(id);
    const joinChains = new Map(); // join id -> [[chain nodes, part-nearest first]]
    const inChain = new Set();
    for (const J of [...grp].sort((a, b) => layerOf.get(a) - layerOf.get(b))) {
      const ups = up.get(J);
      if (ups.length < 2) continue;
      const chains = [];
      let ok = true;
      for (const p of ups) {
        const path = [];
        let cur = p;
        for (;;) {
          path.push(cur);
          const pr = parent.get(cur);
          if (!pr) break;
          // Each part up the chain must feed only the next one down.
          if (kids.get(pr).length !== 1 || pr === J) { ok = false; break; }
          cur = pr;
        }
        // The chain's last part may feed only J.
        if (ok && kids.get(p).filter(k => k !== J).length) ok = false;
        if (!ok) break;
        chains.push(path);
      }
      if (!ok) continue;
      const pr = parent.get(J);
      if (pr) { kids.set(pr, kids.get(pr).filter(k => k !== J)); parent.delete(J); }
      const tops = chains.map(path => path[path.length - 1]).sort((a, b) => mean0(a) - mean0(b));
      joinChains.set(J, tops);
      for (const t of tops) inChain.add(t);
    }
    // Keep the drawn left-to-right order: sort by where each branch was drawn.
    const meanX = new Map();
    const mean = id => {
      if (meanX.has(id)) return meanX.get(id);
      const ks = kids.get(id);
      const v = ks.length ? (origX(id) + ks.reduce((t, k) => t + mean(k), 0) / ks.length) / 2 : origX(id);
      meanX.set(id, v);
      return v;
    };
    for (const id of grp) kids.get(id).sort((a, b) => mean(a) - mean(b));
    const treeRoots = grp.filter(id => !parent.has(id) && !inChain.has(id)).sort((a, b) => mean(a) - mean(b));

    // Trees joined by a second supply or a lateral link go side by side, so
    // those wires stay short and don't run across other branches.
    const rootOf = new Map();
    const mark = (id, r) => {
      rootOf.set(id, r);
      kids.get(id).forEach(k => mark(k, r));
      for (const t of joinChains.get(id) || []) mark(t, r);
    };
    treeRoots.forEach(r => mark(r, r));
    const links = new Map(treeRoots.map(r => [r, new Set()]));
    for (const id of grp) {
      for (const n of adj.get(id)) {
        const a = rootOf.get(id), b = rootOf.get(n);
        if (a !== b) { links.get(a).add(b); links.get(b).add(a); }
      }
    }
    for (let it = 0; it < 8; it++) {
      const idx = new Map(treeRoots.map((r, i) => [r, i]));
      const key = new Map(treeRoots.map(r => {
        const ns = [...links.get(r)];
        return [r, ns.length ? (idx.get(r) + ns.reduce((t, n) => t + idx.get(n), 0)) / (1 + ns.length) : idx.get(r)];
      }));
      treeRoots.sort((a, b) => key.get(a) - key.get(b) || idx.get(a) - idx.get(b));
    }

    // 3. X placement, bottom-up: each branch owns a block of width; a parent
    // sits centred over its children (a single child sits straight under it).
    const gap = this._gaps()[0];
    const blockW = new Map(), cx = new Map(), rel = new Map(), chainRel = new Map();
    const build = id => {
      const ks = kids.get(id);
      ks.forEach(build);
      const own = isBus(id) ? 120 : lat(id) * 2;
      const chains = joinChains.get(id) || [];
      chains.forEach(build);
      const chainWs = chains.map(t => blockW.get(t));
      const chainsW = chains.length ? chainWs.reduce((t, v) => t + v, 0) + gap * (chains.length - 1) : 0;
      if (!ks.length && !chains.length) { blockW.set(id, own); cx.set(id, own / 2); return; }
      let cur = 0;
      const kx = [];
      for (const k of ks) { rel.set(k, cur); kx.push(cur + cx.get(k)); cur += blockW.get(k) + gap; }
      const childW = ks.length ? cur - gap : 0;
      const w = Math.max(childW, chainsW, own);
      const shift = (w - childW) / 2;
      for (const k of ks) rel.set(k, rel.get(k) + shift);
      blockW.set(id, w);
      if (chains.length) {
        // Chains fan in across the top; the join sits centred under them.
        let c0 = (w - chainsW) / 2;
        chainRel.set(id, chains.map((t, i) => { const r = c0; c0 += chainWs[i] + gap; return r; }));
        cx.set(id, w / 2);
      } else {
        cx.set(id, (kx[0] + kx[kx.length - 1]) / 2 + shift);
      }
    };
    treeRoots.forEach(build);
    const x = new Map();
    const place = (id, left) => {
      x.set(id, left + cx.get(id));
      for (const k of kids.get(id)) place(k, left + rel.get(k));
      (joinChains.get(id) || []).forEach((t, i) => place(t, left + chainRel.get(id)[i]));
    };
    let cursor = 0;
    for (const r of treeRoots) { place(r, cursor); cursor += blockW.get(r) + gap * 2; }
    // Buses span everything wired to them (second supplies included).
    for (const id of busW.keys()) {
      const ns = [...up.get(id), ...down.get(id)].map(n => x.get(n));
      if (!ns.length) continue;
      const lo = Math.min(...ns), hi = Math.max(...ns);
      x.set(id, (lo + hi) / 2);
      busW.set(id, Math.max(120, Math.ceil((hi - lo + 40) / 20) * 20));
      comps.get(id).props.busWidth = busW.get(id);
    }

    // 4. Flow placement. Runs of two-terminal parts (breaker, cable, ...)
    // need far less room than a bus or a load, so layers made only of them
    // sit close to their neighbours.
    const slim = l => l.every(id => this.LINK_TYPES.has(comps.get(id).type));
    let minX = Infinity;
    for (const id of grp) minX = Math.min(minX, x.get(id) - lat(id));
    let y = 0, maxX = startX;
    layers.forEach((l, i) => {
      const h = Math.max(...l.map(id => flow(id) * 2));
      for (const id of l) {
        const c = comps.get(id);
        const across = snapToGrid(startX + x.get(id) - minX);
        const along = snapToGrid(y + h / 2);
        c.x = vert ? across : along;
        c.y = vert ? along : across;
        maxX = Math.max(maxX, across + lat(id));
      }
      const [, vg] = this._gaps();
      const next = layers[i + 1];
      y += h + (next && (slim(l) || slim(next)) ? Math.round(vg * (slim(l) && slim(next) ? 0.4 : 0.6)) : vg);
    });
    return { maxX };
  },

  _need(n) {
    UI.toast(`Select at least ${n} components first.`, 'warning');
  },

  _commit() {
    AppState.dirty = true;
    AppState.invalidateResults?.();
    UndoManager.snapshot();
    Canvas.render();
  },

  init() {
    const map = {
      'btn-arrange-left': () => this.align('left'),
      'btn-arrange-center': () => this.align('center'),
      'btn-arrange-right': () => this.align('right'),
      'btn-arrange-top': () => this.align('top'),
      'btn-arrange-middle': () => this.align('middle'),
      'btn-arrange-bottom': () => this.align('bottom'),
      'btn-arrange-dist-h': () => this.distribute('h'),
      'btn-arrange-dist-v': () => this.distribute('v'),
      'btn-arrange-auto': () => this.autoArrange(),
      'btn-arrange-below': () => this.autoArrange(true),
      'btn-arrange-pin': () => this.togglePin(),
    };
    for (const [id, fn] of Object.entries(map)) {
      document.getElementById(id)?.addEventListener('click', () => {
        window.closeAllToolbarMenus?.();
        fn();
      });
    }
  },
};
