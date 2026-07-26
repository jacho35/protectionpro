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

  _tree() {
    const minisubs = Retic.minisubs || [];
    const kiosks = Retic.kiosks || [];
    const msIds = new Set(minisubs.map(m => m.id));
    const byId = {};
    for (const k of kiosks) byId[k.id] = k;

    const children = {};
    for (const m of minisubs) children[m.id] = [];
    for (const k of kiosks) children[k.id] = [];
    for (const k of kiosks) {
      const p = this._resolveParent(k, byId, msIds);
      (children[p] = children[p] || []).push(k.id);
    }
    return { minisubs, kiosks, byId, children };
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
    const { minisubs, children } = tree;
    const nodes = [];
    let row = 0, maxDepth = 0;

    const place = (id, depth, isMs) => {
      maxDepth = Math.max(maxDepth, depth);
      const kids = children[id] || [];
      let y;
      if (!kids.length) {
        y = row * this.ROW_H;
        row++;
      } else {
        const ys = kids.map(c => place(c, depth + 1, false));
        y = (ys[0] + ys[ys.length - 1]) / 2;
      }
      nodes.push({ id, depth, y, isMs, x: this.PAD + depth * this.COL_W });
      return y;
    };

    minisubs.forEach((m, i) => {
      if (i > 0) row += this.GROUP_GAP / this.ROW_H;   // breathing room between groups
      place(m.id, 0, true);
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
    return {
      nodes, edges, pos,
      w: this.PAD * 2 + maxDepth * this.COL_W + this.NODE_W,
      h: maxY + this.NODE_H + this.PAD,   // maxY already includes the top pad
    };
  },

  // ─── Palette ───
  _palette(dark) {
    return dark ? {
      surface: '#1e1e2e', node: '#252536', nodeHead: '#2f2f44', msHead: '#1d3a5c', msBody: '#22293a',
      border: '#3a3a50', ink: '#e0e0e8', inkSec: '#a0a0b0', muted: '#7c7c96',
      edge: '#55556e', accent: '#4a9eff', pass: '#69db7c', fail: '#ff6b6b',
      phase: { Red: '#f87171', White: '#cbd5e1', Blue: '#60a5fa', '3 Phase': '#c084fc', other: '#7c7c96' },
    } : {
      surface: '#ffffff', node: '#ffffff', nodeHead: '#eef1f5', msHead: '#dbeafe', msBody: '#f5f8ff',
      border: '#c9ced6', ink: '#1a1a2e', inkSec: '#555555', muted: '#7a7a88',
      edge: '#9aa0aa', accent: '#0078d7', pass: '#2e7d32', fail: '#d32f2f',
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
    const c = (typeof STANDARD_CABLES !== 'undefined')
      ? STANDARD_CABLES.find(x => x.name === name) : null;
    if (c && c.size_mm2) return `${c.size_mm2}mm² ${c.conductor || ''}`.trim();
    return this._trunc(name, 16);
  },

  _fmtPct(v) { return v == null ? '—' : v.toFixed(2) + '%'; },

  // ─── SVG ───
  // Returns the diagram as an SVG string, or '' when there is nothing to draw.
  buildSVG(opts) {
    opts = opts || {};
    const tree = this._tree();
    if (!tree.kiosks.length) return '';
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

    let nodeSvg = '';
    for (const n of L.nodes) {
      nodeSvg += n.isMs
        ? this._minisubNode(n, msById[n.id], tree, P)
        : this._kioskNode(n, tree, resById, P, limit);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}"
        role="img" aria-label="Reticulation topology: ${tree.minisubs.length} minisub(s) feeding ${tree.kiosks.length} kiosk(s), annotated with per-leg and cumulative volt drop and connection counts"
        font-family="Helvetica, Arial, sans-serif">
      <rect x="0" y="0" width="${L.w}" height="${L.h}" fill="${P.surface}"/>
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;
  },

  _minisubNode(n, mr, tree, P) {
    const ms = tree.minisubs.find(m => m.id === n.id);
    const W = this.NODE_W, H = this.NODE_H;
    const name = this._trunc((ms && ms.name) || 'Minisub', 24);
    const l1 = mr ? `${mr.totalKVA} kVA · ${mr.currentA} A` : '—';
    const l2 = mr ? `${mr.conns} conns · ${mr.numKiosks} kiosk${mr.numKiosks === 1 ? '' : 's'}` : '—';
    return `<g><title>${this._esc(`${name} — diversified demand ${l1}; ${l2}`)}</title>
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.msBody}" stroke="${P.border}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.msHead}"/>
      <text x="${n.x + 10}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}">${this._esc(name)}</text>
      <text x="${n.x + 10}" y="${n.y + 38}" font-size="10.5" font-weight="600" fill="${P.accent}">${this._esc(l1)}</text>
      <text x="${n.x + 10}" y="${n.y + 53}" font-size="9.5" fill="${P.inkSec}">${this._esc(l2)}</text>
    </g>`;
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
        + `<text x="${cx + 6}" y="${n.y + 36.5}" font-size="9.5" fill="${P.inkSec}">${c[0]} ${c[1]}</text>`;
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

    return `<g><title>${this._esc(tip)}</title>
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${P.border}"/>
      <path d="M ${n.x} ${n.y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 15 h -${W} z" fill="${P.nodeHead}"/>
      <rect x="${n.x}" y="${n.y + 3}" width="3.5" height="${H - 6}" fill="${stripe}"/>
      <text x="${n.x + 12}" y="${n.y + 15}" font-size="11" font-weight="700" fill="${P.ink}">${this._esc(name)}</text>
      <rect x="${pillX}" y="${n.y + 4}" width="${pillW}" height="14" rx="7" fill="${pillFill}" opacity="0.16"/>
      <text x="${pillX + pillW / 2}" y="${n.y + 14.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${pillFill}">${this._esc(pillTxt)}</text>
      ${chipSvg}
      <text x="${n.x + 12}" y="${n.y + 52}" font-size="9.5" fill="${P.muted}">${this._esc(foot)}</text>
    </g>`;
  },

  // ─── Render into the modal ───
  render() {
    const host = document.getElementById('retic-diagram-canvas');
    if (!host) return;
    const dark = document.body.classList.contains('dark-mode');
    const svg = this.buildSVG({ dark });
    if (!svg) {
      host.innerHTML = '<div class="retic-empty">No kiosks yet — add kiosks (or use ⚡ Quick Build) and the topology will appear here.</div>';
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
    if (!ex) { UI.alert('Nothing to export yet — add kiosks first.'); return; }
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
    if (!ex) { UI.alert('Nothing to export yet — add kiosks first.'); return; }
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
