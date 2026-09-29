/* ProtectionPro — Street lighting circuit diagram (read-only schematic).
 *
 * One circuit at a time: the source (kiosk / minisub) on the left, the main
 * run of poles left to right, and every spur dropping to its own row below its
 * tee pole and running right from there. Each pole shows its phase, luminaire,
 * volt drop and Zs (red when a check fails); each span its length, current and
 * — where the phases don't cancel — the neutral current.
 *
 * Everything is derived: geometry from AppState.reticulation.streetLighting,
 * numbers from StreetLight._results (the latest /api/analysis/street-lighting
 * response). Same modal chrome, zoom and export as ReticDiagram; colours are
 * literal hex so Project._rasterizeSVG exports them.
 */

const SLDiagram = {
  _bound: false,
  _zoom: 1,
  _size: { w: 0, h: 0 },
  _circuitId: null,

  NODE_W: 104,
  NODE_H: 70,
  SRC_W: 176,
  COL_W: 150,       // pole pitch — leaves a 46 px gutter for the span label
  ROW_H: 118,
  PAD: 22,
  HEAD_H: 86,

  // ─── Modal plumbing ───
  _modal() {
    let m = document.getElementById('sl-diagram-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'sl-diagram-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'Street lighting circuit diagram');
    m.style.display = 'none';
    m.innerHTML = `
      <div class="modal-content modal-wide">
        <div class="modal-header">
          <h3>Street lighting circuit diagram</h3>
          <button class="modal-close" data-sldg="close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="rdg-toolbar">
            <select id="sldg-circuit" aria-label="Circuit"></select>
            <button class="retic-btn" data-sldg="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
            <span id="sldg-zoom-label" class="rdg-zoom">100%</span>
            <button class="retic-btn" data-sldg="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
            <button class="retic-btn" data-sldg="fit" title="Scale to fit the width">Fit</button>
            <span class="rdg-spacer"></span>
            <button class="retic-btn" data-sldg="png" title="Download the diagram as a PNG image">PNG</button>
            <button class="retic-btn" data-sldg="svg" title="Download the diagram as a vector SVG">SVG</button>
          </div>
          <div id="sldg-canvas" class="rdg-scroll"></div>
          <div class="rdg-legend">
            <span><i class="rdg-sw" style="background:#dc2626"></i>R</span>
            <span><i class="rdg-sw" style="background:#6b7280"></i>W</span>
            <span><i class="rdg-sw" style="background:#2563eb"></i>B</span>
            <span class="rdg-note">Each pole: phase, luminaire, volt drop from the source and earth loop Zs — red when a check fails (VD, cumulative VD, Zs or cable rating). Span labels: length, the current on the busiest phase and, where the phases don't cancel, the neutral current. Spurs drop below their tee pole and carry on the phase rotation.</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(m);
    return m;
  },

  open(circuitId) {
    const m = this._modal();
    this._bind();
    this._circuitId = circuitId || (StreetLight.selected && StreetLight.selected.id) || (StreetLight.circuits[0] && StreetLight.circuits[0].id);
    m.style.display = '';
    this._fillSelect();
    this._zoom = 1;
    this.render();
    this.autoZoom();
  },

  close() {
    const m = document.getElementById('sl-diagram-modal');
    if (m) m.style.display = 'none';
  },

  isOpen() {
    const m = document.getElementById('sl-diagram-modal');
    return !!m && m.style.display !== 'none';
  },

  _bind() {
    if (this._bound) return;
    const m = this._modal();
    this._bound = true;
    m.addEventListener('click', (e) => {
      if (e.target === m) { this.close(); return; }
      const b = e.target.closest('[data-sldg]');
      if (!b) return;
      const a = b.dataset.sldg;
      if (a === 'close') this.close();
      else if (a === 'zoom-in') this.zoom(1.25);
      else if (a === 'zoom-out') this.zoom(1 / 1.25);
      else if (a === 'fit') this.fit();
      else if (a === 'png') this.exportPNG();
      else if (a === 'svg') this.exportSVG();
    });
    m.addEventListener('change', (e) => {
      if (e.target.id === 'sldg-circuit') { this._circuitId = e.target.value; this.render(); this.autoZoom(); }
    });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  },

  _fillSelect() {
    const sel = document.getElementById('sldg-circuit');
    if (!sel) return;
    sel.innerHTML = StreetLight.circuits.map(c =>
      `<option value="${this._esc(c.id)}"${c.id === this._circuitId ? ' selected' : ''}>${this._esc(c.name)} — ${this._esc(StreetLight._sourceName(c.source))}</option>`).join('');
  },

  // Called by StreetLight after each calculation so an open diagram stays live.
  refresh() {
    if (!this.isOpen()) return;
    this._fillSelect();
    this.render();
  },

  // ─── Layout ───
  // Main run along row 0; at every tee the child with the biggest subtree
  // carries straight on and each other child starts a new row below.
  _layout(c, rowsById) {
    const kids = {};
    const ids = new Set(c.poles.map(p => p.id));
    const roots = [];
    for (const p of c.poles) {
      if (p.parent && ids.has(p.parent) && p.parent !== p.id) (kids[p.parent] = kids[p.parent] || []).push(p.id);
      else roots.push(p.id);
    }
    const size = {};
    const sz = (id, seen) => {
      if (seen.has(id)) return 0;
      seen.add(id);
      let n = 1;
      for (const k of kids[id] || []) n += sz(k, seen);
      return (size[id] = n);
    };
    for (const r of roots) sz(r, new Set());
    const pos = {};
    let nextRow = 0;
    const place = (id, col, row, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      pos[id] = { col, row };
      const ch = (kids[id] || []).slice().sort((a, b) => (size[b] || 0) - (size[a] || 0));
      ch.forEach((k, i) => {
        const r = i === 0 ? row : ++nextRow;
        place(k, col + 1, r, seen);
      });
    };
    const seen = new Set();
    roots.forEach((r, i) => place(r, 1, i === 0 ? 0 : ++nextRow, seen));
    let maxCol = 1, maxRow = 0;
    for (const v of Object.values(pos)) { maxCol = Math.max(maxCol, v.col); maxRow = Math.max(maxRow, v.row); }
    const X = (col) => this.PAD + (col === 0 ? 0 : this.SRC_W + 46 + (col - 1) * this.COL_W);
    const Y = (row) => this.PAD + this.HEAD_H + row * this.ROW_H;
    return {
      pos, X, Y, roots,
      w: X(maxCol) + this.NODE_W + this.PAD,
      h: Y(maxRow) + this.NODE_H + this.PAD + 8,
    };
  },

  _palette(dark) {
    return dark ? {
      surface: '#1e1e2e', node: '#252536', nodeHead: '#2f2f44', srcHead: '#1d3a5c', srcBody: '#22293a',
      border: '#3a3a50', ink: '#e0e0e8', inkSec: '#a0a0b0', muted: '#7c7c96',
      edge: '#6a6a86', accent: '#4a9eff', pass: '#69db7c', fail: '#ff6b6b',
      phase: { R: '#f87171', W: '#cbd5e1', B: '#60a5fa' }, onPhase: { R: '#1e1e2e', W: '#1e1e2e', B: '#1e1e2e' },
    } : {
      surface: '#ffffff', node: '#ffffff', nodeHead: '#eef1f5', srcHead: '#dbeafe', srcBody: '#f5f8ff',
      border: '#c9ced6', ink: '#1a1a2e', inkSec: '#555555', muted: '#6d6d7a',
      edge: '#8a909a', accent: '#0078d7', pass: '#2e7d32', fail: '#d32f2f',
      phase: { R: '#dc2626', W: '#6b7280', B: '#2563eb' }, onPhase: { R: '#ffffff', W: '#ffffff', B: '#ffffff' },
    };
  },

  _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  _trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; },
  _f(x, d = 2) { return x == null || !isFinite(x) ? '—' : Number(x).toFixed(d); },
  _cableShort(name) {
    const c = (typeof CableLib !== 'undefined') ? CableLib.byName(name) : null;
    if (c && c.size_mm2) return `${c.size_mm2}mm² ${Number(CableLib.normalize(c).cores) || ''}c ${c.conductor || ''}`.replace(/\s+/g, ' ').trim();
    return name ? this._trunc(name, 18) : 'no cable';
  },

  // ─── SVG ───
  buildSVG(opts) {
    opts = opts || {};
    const c = StreetLight.circuit(this._circuitId);
    if (!c || !c.poles.length) return '';
    const r = StreetLight._results[c.id];
    const P = this._palette(!!opts.dark);
    const L = this._layout(c);
    this._size = { w: L.w, h: L.h };
    const byId = {};
    if (r) for (const p of r.poles) byId[p.id] = p;
    const pole = {};
    for (const p of c.poles) pole[p.id] = p;
    const lum = (p) => StreetLight._lum(p.luminaireId || c.luminaireId);

    // Header strip: circuit, verdict, build-up, headline numbers.
    const verdict = !r ? 'calculating…' : (r.pass ? 'PASS' : 'FAIL');
    const vCol = !r ? P.muted : (r.pass ? P.pass : P.fail);
    const sys = c.system === '1ph' ? `1Φ string (${c.singlePhase})` : `3Φ R-W-B from ${c.phaseStart}`;
    const prot = StreetLight._prot(c.protection);
    const l2 = `${sys} · ${this._cableShort(c.cable)} · ${lum({}).name} · ${prot.id === 'custom' ? 'Ia ' + StreetLight._ia(c) + ' A' : prot.name} · ${c.poles.length} poles`;
    const l3 = r
      ? `Worst VD ${this._f(r.worstVdPct)} % (limit ${r.vdLimitPct}) · cumulative ${this._f(r.worstCumVdPct)} % (limit ${r.cumVdLimitPct}) · Zs ${this._f(r.maxZsOhm)} Ω${r.zsMaxAllowedOhm ? ` (max ${this._f(r.zsMaxAllowedOhm)})` : ''}`
      : '';
    const l4 = r ? `At source: R ${this._f(r.phaseA.R)} A · W ${this._f(r.phaseA.W)} A · B ${this._f(r.phaseA.B)} A · N ${this._f(r.neutralA)} A · ${this._f(StreetLight.circuitKVA(c))} kVA · ${this._f(r.cableLengthM, 0)} m of cable` : '';
    const vw = 58;
    let head = `<text x="${this.PAD}" y="${this.PAD + 14}" font-size="14" font-weight="700" fill="${P.ink}">${this._esc(c.name)}</text>
      <rect x="${this.PAD + Math.min(360, 9 * c.name.length + 16)}" y="${this.PAD + 1}" width="${vw}" height="18" rx="9" fill="${vCol}" opacity="0.16"/>
      <text x="${this.PAD + Math.min(360, 9 * c.name.length + 16) + vw / 2}" y="${this.PAD + 14}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${vCol}">${verdict}</text>
      <text x="${this.PAD}" y="${this.PAD + 34}" font-size="10.5" fill="${P.inkSec}">${this._esc(l2)}</text>
      <text x="${this.PAD}" y="${this.PAD + 50}" font-size="10.5" fill="${P.ink}">${this._esc(l3)}</text>
      <text x="${this.PAD}" y="${this.PAD + 65}" font-size="10.5" fill="${P.inkSec}">${this._esc(l4)}</text>`;
    if (r && r.warnings && r.warnings.length) head += `<text x="${this.PAD}" y="${this.PAD + 79}" font-size="10" fill="${P.fail}">${this._esc(r.warnings[0])}</text>`;

    // Source node (column 0, main row).
    const sx = L.X(0), sy = L.Y(0);
    const srcKind = c.source && c.source.kind === 'minisub' ? 'Minisub' : 'Kiosk';
    const ze = StreetLight._ze(c), svd = StreetLight._supplyVd(c);
    const src = `<g><title>${this._esc(`${StreetLight._sourceName(c.source)} — Ze ${this._f(ze.value, 3)} Ω (${ze.basis}); supply VD ${this._f(svd.value)} % (${svd.basis})`)}</title>
      <rect x="${sx}" y="${sy}" width="${this.SRC_W}" height="${this.NODE_H}" rx="6" fill="${P.srcBody}" stroke="${P.border}"/>
      <path d="M ${sx} ${sy + 6} a 6 6 0 0 1 6 -6 h ${this.SRC_W - 12} a 6 6 0 0 1 6 6 v 15 h -${this.SRC_W} z" fill="${P.srcHead}"/>
      <text x="${sx + 10}" y="${sy + 15}" font-size="11" font-weight="700" fill="${P.ink}">${this._esc(this._trunc(StreetLight._sourceName(c.source), 22))}</text>
      <text x="${sx + this.SRC_W - 10}" y="${sy + 15}" text-anchor="end" font-size="9" fill="${P.inkSec}">${srcKind}</text>
      <text x="${sx + 10}" y="${sy + 36}" font-size="10" font-weight="600" fill="${P.accent}">${this._esc(prot.id === 'custom' ? 'Ia ' + StreetLight._ia(c) + ' A' : prot.name)}</text>
      <text x="${sx + 10}" y="${sy + 50}" font-size="9.5" fill="${P.inkSec}">Ze ${this._f(ze.value, 3)} Ω · supply ${this._f(svd.value)} %</text>
      <text x="${sx + 10}" y="${sy + 63}" font-size="9.5" fill="${P.inkSec}">${this._f(StreetLight.circuitKVA(c))} kVA</text>
    </g>`;

    // Spans (edges) first so the boxes paint over the line ends.
    let edges = '';
    for (const p of c.poles) {
      const q = L.pos[p.id];
      if (!q) continue;
      const par = p.parent && L.pos[p.parent] ? L.pos[p.parent] : null;
      const tx = L.X(q.col), ty = L.Y(q.row) + this.NODE_H / 2;
      let path, lx, ly;
      if (!par) {
        // From the source: straight across on the main row, else down its right edge.
        const ox = sx + this.SRC_W;
        if (q.row === 0) { path = `M ${ox} ${ty} H ${tx}`; lx = (ox + tx) / 2; ly = ty; }
        else { const vx = ox + 20; path = `M ${ox} ${sy + this.NODE_H / 2} H ${vx} V ${ty} H ${tx}`; lx = (vx + tx) / 2; ly = ty; }
      } else {
        const px = L.X(par.col) + this.NODE_W, py = L.Y(par.row) + this.NODE_H / 2;
        if (par.row === q.row) { path = `M ${px} ${py} H ${tx}`; lx = (px + tx) / 2; ly = ty; }
        else {
          // Spur: down from the tee pole's bottom, then across.
          const bx = L.X(par.col) + this.NODE_W / 2, by = L.Y(par.row) + this.NODE_H;
          path = `M ${bx} ${by} V ${ty} H ${tx}`; lx = (bx + tx) / 2 + 6; ly = ty;
        }
      }
      const rp = byId[p.id];
      const len = rp ? `${this._f(rp.spanM, 0)} m` : '';
      const amps = rp ? `${this._f(rp.iSpanA)} A` : '';
      const neut = rp && rp.iNeutralA > 0.05 ? `N ${this._f(rp.iNeutralA)} A` : '';
      const hot = rp && !rp.ampOk;
      edges += `<g><title>${this._esc(`Span to ${p.name || p.id}: ${len}${amps ? ', ' + amps + ' on the busiest phase' : ''}${neut ? ', neutral ' + neut.slice(2) : ''}`)}</title>
        <path d="${path}" fill="none" stroke="${hot ? P.fail : P.edge}" stroke-width="1.6"/>
        <polygon points="${tx - 7},${ty - 4} ${tx - 7},${ty + 4} ${tx},${ty}" fill="${hot ? P.fail : P.edge}"/>
        <text x="${lx}" y="${ly - 16}" text-anchor="middle" font-size="9" font-weight="600" fill="${P.ink}">${this._esc(len)}</text>
        <text x="${lx}" y="${ly - 6}" text-anchor="middle" font-size="8.5" fill="${hot ? P.fail : P.muted}">${this._esc(amps)}</text>
        ${neut ? `<text x="${lx}" y="${ly + 12}" text-anchor="middle" font-size="8.5" fill="${P.muted}">${this._esc(neut)}</text>` : ''}
      </g>`;
    }

    // Pole nodes.
    let nodes = '';
    const W = this.NODE_W, H = this.NODE_H;
    for (const p of c.poles) {
      const q = L.pos[p.id];
      if (!q) continue;
      const x = L.X(q.col), y = L.Y(q.row);
      const rp = byId[p.id];
      const ph = rp ? rp.phase : (p.phase || '?');
      const ok = rp ? rp.ok : true;
      const stripe = !rp ? P.border : (ok ? P.pass : P.fail);
      const phCol = P.phase[ph] || P.muted;
      const why = rp ? [!rp.vdOk && 'VD', !rp.cumOk && 'Cum', !rp.zsOk && 'Zs', !rp.ampOk && 'A'].filter(Boolean).join('+') : '';
      const l = lum(p);
      const tip = `${p.name || p.id} — phase ${ph}, ${l.name}` + (rp
        ? `\nVD ${this._f(rp.vdPct)} % from the source · cumulative ${this._f(rp.cumVdPct)} %\nZs ${this._f(rp.zsOhm)} Ω · Ik1 ${rp.ik1A == null ? '—' : this._f(rp.ik1A, 0)} A · ${this._f(rp.distM, 0)} m from the source${why ? '\nFails: ' + why : ''}`
        : '');
      nodes += `<g><title>${this._esc(tip)}</title>
        <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${P.node}" stroke="${ok ? P.border : P.fail}"/>
        <path d="M ${x} ${y + 6} a 6 6 0 0 1 6 -6 h ${W - 12} a 6 6 0 0 1 6 6 v 13 h -${W} z" fill="${P.nodeHead}"/>
        <rect x="${x}" y="${y + 3}" width="3.5" height="${H - 6}" fill="${stripe}"/>
        <text x="${x + 10}" y="${y + 13.5}" font-size="10.5" font-weight="700" fill="${P.ink}">${this._esc(this._trunc(p.name || p.id, 9))}</text>
        <rect x="${x + W - 24}" y="${y + 3}" width="18" height="13" rx="3" fill="${phCol}"/>
        <text x="${x + W - 15}" y="${y + 13}" text-anchor="middle" font-size="9" font-weight="700" fill="${P.onPhase[ph] || '#fff'}">${this._esc(ph)}</text>
        <text x="${x + 10}" y="${y + 32}" font-size="9" fill="${P.inkSec}">${this._esc(this._trunc(l.name, 16))}</text>
        <text x="${x + 10}" y="${y + 46}" font-size="10" font-weight="700" fill="${rp && (!rp.vdOk || !rp.cumOk) ? P.fail : P.ink}">${rp ? this._f(rp.vdPct) + ' %' : '—'}</text>
        <text x="${x + W - 8}" y="${y + 46}" text-anchor="end" font-size="9" fill="${rp && !rp.zsOk ? P.fail : P.inkSec}">${rp ? this._f(rp.zsOhm) + ' Ω' : ''}</text>
        <text x="${x + 10}" y="${y + 61}" font-size="9" fill="${why ? P.fail : P.muted}">${why ? this._esc(why) : (rp ? this._f(rp.distM, 0) + ' m' : '')}</text>
      </g>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}"
        role="img" aria-label="Street lighting circuit ${this._esc(c.name)}: ${c.poles.length} poles fed from ${this._esc(StreetLight._sourceName(c.source))}, annotated with phase, volt drop and earth loop impedance"
        font-family="Helvetica, Arial, sans-serif">
      <rect x="0" y="0" width="${L.w}" height="${L.h}" fill="${P.surface}"/>
      ${head}${edges}${src}${nodes}
    </svg>`;
  },

  // ─── Render / zoom ───
  render() {
    const host = document.getElementById('sldg-canvas');
    if (!host) return;
    const c = StreetLight.circuit(this._circuitId);
    if (!c) { host.innerHTML = '<div class="retic-empty">No street lighting circuits yet.</div>'; return; }
    if (!c.poles.length) { host.innerHTML = '<div class="retic-empty">This circuit has no poles yet.</div>'; return; }
    host.innerHTML = this.buildSVG({ dark: document.body.classList.contains('dark-mode') });
    this._applyZoom();
  },

  _applyZoom() {
    const el = document.querySelector('#sldg-canvas svg');
    if (!el) return;
    el.setAttribute('width', Math.round(this._size.w * this._zoom));
    el.setAttribute('height', Math.round(this._size.h * this._zoom));
    const lbl = document.getElementById('sldg-zoom-label');
    if (lbl) lbl.textContent = Math.round(this._zoom * 100) + '%';
  },

  zoom(f) { this._zoom = Math.min(3, Math.max(0.2, this._zoom * f)); this._applyZoom(); },

  _fitZoom() {
    const host = document.getElementById('sldg-canvas');
    if (!host || !this._size.w) return 1;
    const avail = host.clientWidth - 24;
    return avail > 0 ? Math.min(1, Math.max(0.2, avail / this._size.w)) : 1;
  },
  fit() { this._zoom = this._fitZoom(); this._applyZoom(); },
  // Long runs don't fit a screen legibly; open readable and let the user pan.
  autoZoom() { this._zoom = Math.max(0.7, this._fitZoom()); this._applyZoom(); },

  // ─── Export (light palette, for paper) ───
  _exportNode() {
    const svg = this.buildSVG({ dark: false });
    if (!svg) return null;
    const wrap = document.createElement('div');
    wrap.innerHTML = svg;
    return { node: wrap.firstElementChild, w: this._size.w, h: this._size.h };
  },
  _fileBase() {
    const c = StreetLight.circuit(this._circuitId);
    return [AppState.projectName || 'project', c ? c.name : 'circuit'].join('_').replace(/[^a-z0-9]+/gi, '_');
  },
  exportSVG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export — the circuit has no poles.'); return; }
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(ex.node)], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${this._fileBase()}_street_lighting.svg`; a.click();
    URL.revokeObjectURL(url);
  },
  exportPNG() {
    const ex = this._exportNode();
    if (!ex) { UI.alert('Nothing to export — the circuit has no poles.'); return; }
    Project._rasterizeSVG(ex.node, ex.w, ex.h, 2, (canvas) => {
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${SLDiagram._fileBase()}_street_lighting.png`; a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
    });
  },
  rasterize(scale) {
    return new Promise((resolve) => {
      const ex = this._exportNode();
      if (!ex) { resolve(null); return; }
      Project._rasterizeSVG(ex.node, ex.w, ex.h, scale || 2, (canvas) => resolve({ dataUrl: canvas.toDataURL('image/png'), w: ex.w, h: ex.h }));
    });
  },
};
