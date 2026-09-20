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
    const rank = id => dist.get(id) * 1e6 + grp.indexOf(id);
    const down = new Map(grp.map(id => [id, []])); // id -> parts fed from it
    const indeg = new Map(grp.map(id => [id, 0]));
    for (const id of grp) {
      for (const n of adj.get(id)) {
        if (rank(id) < rank(n) && !(isSource(id) && isSource(n))) { down.get(id).push(n); indeg.set(n, indeg.get(n) + 1); }
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
    // Edges to the layer above / below only (long edges are still pulled toward).
    const up = new Map(grp.map(id => [id, []]));
    for (const id of grp) for (const n of down.get(id)) up.get(n).push(id);

    // 2. Order within layers: barycentre sweeps.
    const sweep = (i, nbrs) => {
      const pos = new Map();
      layers.forEach(l => l.forEach((id, k) => pos.set(id, k / Math.max(1, l.length - 1))));
      const key = new Map();
      layers[i].forEach((id, k) => {
        const ns = nbrs.get(id);
        key.set(id, ns.length ? ns.reduce((sum, n) => sum + pos.get(n), 0) / ns.length : pos.get(id));
      });
      layers[i].sort((a, b) => key.get(a) - key.get(b));
    };
    for (let it = 0; it < 6; it++) {
      for (let i = 1; i < depth; i++) sweep(i, up);
      for (let i = depth - 2; i >= 0; i--) sweep(i, down);
    }

    // 3. X placement: pack, then pull each part toward its neighbours,
    // sizing every bus to span the parts it feeds, keeping order + spacing.
    const x = new Map();
    for (const l of layers) {
      const total = l.reduce((sum, id) => sum + lat(id) * 2, 0) + this._gaps()[0] * (l.length - 1);
      let cur = -total / 2;
      for (const id of l) { x.set(id, cur + lat(id)); cur += lat(id) * 2 + this._gaps()[0]; }
    }
    const spread = l => {
      for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (let i = 1; i < l.length; i++) {
          const need = lat(l[i - 1]) + lat(l[i]) + this._gaps()[0];
          const gap = x.get(l[i]) - x.get(l[i - 1]);
          if (gap < need - 0.01) {
            const d = (need - gap) / 2;
            x.set(l[i - 1], x.get(l[i - 1]) - d);
            x.set(l[i], x.get(l[i]) + d);
            moved = true;
          }
        }
        if (!moved) break;
      }
    };
    const fitBus = id => {
      const ns = [...up.get(id), ...down.get(id)];
      if (!ns.length) return;
      const reach = Math.max(...ns.map(n => Math.abs(x.get(n) - x.get(id))));
      // Capped by the link count so spreading a crowded layer can't feed back into ever-wider buses.
      const cap = 120 + 160 * ns.length;
      busW.set(id, Math.min(cap, Math.max(120, Math.ceil((reach * 2 + 40) / 20) * 20)));
    };
    const pull = (i, nbrs) => {
      for (const id of layers[i]) {
        const ns = nbrs.get(id);
        if (!ns.length) continue;
        // A bus centres on the extremes of what it feeds; other parts on the mean.
        x.set(id, isBus(id)
          ? (Math.min(...ns.map(n => x.get(n))) + Math.max(...ns.map(n => x.get(n)))) / 2
          : ns.reduce((sum, n) => sum + x.get(n), 0) / ns.length);
      }
      for (const id of layers[i]) if (isBus(id)) fitBus(id);
      spread(layers[i]);
    };
    // Sweep against everything the part connects to, up and down.
    const both = new Map(grp.map(id => [id, [...up.get(id), ...down.get(id)]]));
    for (let it = 0; it < 8; it++) {
      for (let i = 1; i < depth; i++) pull(i, it % 2 ? both : up);
      for (let i = depth - 2; i >= 0; i--) pull(i, it % 2 ? both : down);
    }
    for (const id of busW.keys()) comps.get(id).props.busWidth = busW.get(id);

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
