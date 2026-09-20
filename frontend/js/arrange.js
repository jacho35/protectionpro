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
  autoArrange() {
    this._closePreview(true);
    const sel = this._selected();
    const pool = (sel.length >= 2
      ? sel
      : [...AppState.components.values()].filter(c => !c.pageId || c.pageId === AppState.activePageId)
    ).filter(c => !c.pinned);
    if (pool.length < 2) return this._need(2);
    const ids = new Set(pool.map(c => c.id));
    const wires = [];
    for (const w of AppState.wires.values()) {
      if (w.fromComponent !== w.toComponent && (ids.has(w.fromComponent) || ids.has(w.toComponent))) wires.push(w);
    }
    this._session = {
      ids,
      wires,
      orig: pool.map(c => ({ c, x: c.x, y: c.y, rotation: c.rotation, busWidth: c.props?.busWidth })),
      origWires: wires.map(w => ({ w, fromPort: w.fromPort, toPort: w.toPort })),
    };
    this._run();
    this._showPreview();
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
        const links = this._layerLinks(c.id, adj);
        c.props.busWidth = Math.max(120, Math.ceil(links * this.BUS_PER_LINK / 20) * 20);
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
    const dx = snapToGrid(minX0 - lx), dy = snapToGrid(minY0 - ly);
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

  // Number of links a node has to one side of it, whichever side is larger
  // (drives the bus width estimate). Uses the BFS layers of its group.
  _layerLinks(id, adj) {
    const n = adj.get(id).size;
    return Math.max(1, Math.ceil(n / 2) + (n > 3 ? 1 : 0));
  },

  // Lay one connected group out starting at x = startX; returns {maxX}.
  _layoutGroup(grp, adj, startX) {
    const comps = new Map(grp.map(id => [id, AppState.components.get(id)]));
    const ext = new Map(grp.map(id => [id, this._extent(comps.get(id))]));
    const vert = this._opts.direction !== 'right';
    // Lateral = across a layer, flow = along the source-to-load direction.
    const lat = id => (vert ? ext.get(id).hw : ext.get(id).hh);
    const flow = id => (vert ? ext.get(id).hh : ext.get(id).hw);
    const width = id => lat(id) * 2;

    // 1. Layers: BFS distance from the sources (or the top-most part).
    let roots = grp.filter(id => this.SOURCE_TYPES.has(comps.get(id).type));
    if (!roots.length) {
      roots = [[...grp].sort((a, b) => comps.get(a).y - comps.get(b).y || comps.get(a).x - comps.get(b).x)[0]];
    }
    const layerOf = new Map(roots.map(id => [id, 0]));
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift();
      for (const n of adj.get(id)) {
        if (!layerOf.has(n)) { layerOf.set(n, layerOf.get(id) + 1); queue.push(n); }
      }
    }
    const depth = Math.max(...layerOf.values()) + 1;
    const layers = Array.from({ length: depth }, () => []);
    for (const id of grp) layers[layerOf.get(id)].push(id);
    // Start from the order the user drew, left to right.
    for (const l of layers) l.sort((a, b) => comps.get(a).x - comps.get(b).x);

    // 2. Order within layers: barycentre sweeps.
    const posIn = () => {
      const m = new Map();
      layers.forEach(l => l.forEach((id, i) => m.set(id, i)));
      return m;
    };
    const sweep = (i, ref) => {
      const pos = posIn();
      const key = new Map();
      layers[i].forEach((id, idx) => {
        const ns = [...adj.get(id)].filter(n => layerOf.get(n) === ref);
        key.set(id, ns.length ? ns.reduce((s, n) => s + pos.get(n), 0) / ns.length : idx);
      });
      layers[i].sort((a, b) => key.get(a) - key.get(b));
    };
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < depth; i++) sweep(i, i - 1);
      for (let i = depth - 2; i >= 0; i--) sweep(i, i + 1);
    }

    // 3. X placement: pack each layer, then pull parts toward their
    // neighbours while keeping order and minimum spacing.
    const x = new Map();
    for (const l of layers) {
      const total = l.reduce((s, id) => s + width(id), 0) + this._gaps()[0] * (l.length - 1);
      let cur = -total / 2;
      for (const id of l) { x.set(id, cur + width(id) / 2); cur += width(id) + this._gaps()[0]; }
    }
    const spread = l => {
      for (let pass = 0; pass < 30; pass++) {
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
    const pull = (i, refs) => {
      for (const id of layers[i]) {
        const ns = [...adj.get(id)].filter(n => refs.includes(layerOf.get(n)));
        if (ns.length) x.set(id, ns.reduce((s, n) => s + x.get(n), 0) / ns.length);
      }
      spread(layers[i]);
    };
    for (let it = 0; it < 6; it++) {
      for (let i = 1; i < depth; i++) pull(i, [i - 1]);
      for (let i = depth - 2; i >= 0; i--) pull(i, [i + 1]);
    }

    // 4. Y placement and write-back, snapped to the grid.
    let minX = Infinity;
    for (const id of grp) minX = Math.min(minX, x.get(id) - lat(id));
    let y = 0, maxX = startX;
    for (const l of layers) {
      const h = Math.max(...l.map(id => flow(id) * 2));
      for (const id of l) {
        const c = comps.get(id);
        const across = snapToGrid(startX + x.get(id) - minX);
        const along = snapToGrid(y + h / 2);
        c.x = vert ? across : along;
        c.y = vert ? along : across;
        maxX = Math.max(maxX, across + lat(id));
      }
      y += h + this._gaps()[1];
    }
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
