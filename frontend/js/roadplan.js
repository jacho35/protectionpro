/* ProtectionPro — Road plan (Street lighting › Road plan).
 *
 * Road lighting on roads of any shape, on a plan in metres. Three steps:
 *   1 Road shape — draw a centreline (click intersection points; each corner
 *     is rounded with a tangent arc at the bend radius), trace both kerbs (the
 *     carriageway width then follows the drawing), or pick a centreline / two
 *     kerbs from a DXF background (connected LINE / ARC / polyline pieces on
 *     the same layer are chained). A Lighting design (js/roadlight.js) gives
 *     the cross-section, swept along the road, and its luminaire rows.
 *   2 Poles — every row of the design laid out along its own pole line at the
 *     design spacing (closer on bends tighter than a set radius, optionally a
 *     single outside row there), junction mouths kept clear; drag to move,
 *     add, delete, override a pole's luminaire / height / tilt.
 *   3 Light on the plan — /api/analysis/road-plan (analysis/road_plan.py):
 *     illuminance / luminance heatmap with iso-lines on every road, per-segment
 *     EN 13201-2 / SANS 10098-1 checks (segments split at tangent points and
 *     junctions) and C / RC class checks on the junction conflict areas.
 *
 * Plan frame: x east, y north, metres. A road's cross-section runs left to
 * right looking up its chainage (the first strip is on the left), the same
 * reading as the Lighting design. Junctions are found where a road's end
 * lies on another road, or where two centrelines cross.
 *
 * A Plan | 3D switch shows the same roads in 3D (js/road3d.js), with trees,
 * buildings, shelters and gantries that shade the road, facade checks and
 * measurement points.
 *
 * State (saved with the project), inside AppState.reticulation.streetLighting:
 *   roadPlan { roads[], junctionCls {key → class}, bg (DXF background in
 *              metres), settings { standard, mf, shadows }, scene { objects[],
 *              surfaces[], points[] } (road3d.js), _seq }
 * Results are on demand (this._res, never saved).
 */

const RP_RAMP = ['#30123b', '#4145ab', '#2f7ff0', '#1bcfd4', '#61fc6c', '#d2e935', '#fe9b2d', '#db3a07'];   // turbo-like, low → high
const RP_COMPARABLE_C = { M1: 'C0', M2: 'C1', M3: 'C2', M4: 'C3', M5: 'C4', M6: 'C5', P1: 'P1', P2: 'P1', P3: 'P2', P4: 'P3', P5: 'P4', P6: 'P5' };
const RP_SANS_RC = { A1: 'RC1', A2: 'RC2', A3: 'RC3', A4: 'RC4', B1: 'RC5', B2: 'RC5', B3: 'RC5', C1: 'RC4', C2: 'RC5' };
const RP_CONFLICT_EN = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const RP_CONFLICT_SANS = ['RC0', 'RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6'];

// ─── Alignment: a polyline in metres with chainage ─────────────────────
class RPAlign {
  constructor(pts) {
    const p = [];
    for (const q of pts || []) {
      if (!p.length || Math.hypot(q[0] - p[p.length - 1][0], q[1] - p[p.length - 1][1]) > 1e-6) p.push([+q[0], +q[1]]);
    }
    this.pts = p;
    this.cum = [0];
    for (let i = 1; i < p.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    this.length = this.cum[this.cum.length - 1] || 0;
  }
  get ok() { return this.pts.length >= 2 && this.length > 0.5; }
  _idx(s) {
    let lo = 0, hi = this.cum.length - 2;
    if (s <= 0) return 0;
    if (s >= this.length) return hi;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cum[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }
  // Point at chainage s, offset d to the RIGHT (looking up the chainage); past
  // either end it runs on along the end tangent.
  at(s, d = 0) {
    const i = this._idx(s);
    const a = this.pts[i], b = this.pts[i + 1];
    const L = this.cum[i + 1] - this.cum[i] || 1e-9;
    let tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    // a vertex of a flattened curve: average the two directions over ±0.5 m
    if (s - this.cum[i] < 0.5 && i > 0) { const c = this.pts[i - 1], l2 = this.cum[i] - this.cum[i - 1] || 1e-9; tx += (a[0] - c[0]) / l2; ty += (a[1] - c[1]) / l2; }
    else if (this.cum[i + 1] - s < 0.5 && i + 2 < this.pts.length) { const c = this.pts[i + 2], l2 = this.cum[i + 2] - this.cum[i + 1] || 1e-9; tx += (c[0] - b[0]) / l2; ty += (c[1] - b[1]) / l2; }
    const n = Math.hypot(tx, ty) || 1; tx /= n; ty /= n;
    const t = (s - this.cum[i]) / L;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    const nx = ty, ny = -tx;
    return { x: x + d * nx, y: y + d * ny, tx, ty, nx, ny };
  }
  // Nearest centreline point: chainage, signed offset (+ right), distance.
  project(x, y) {
    let best = { s: 0, d: 0, dist: Infinity };
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
      const cx = a[0] + dx * t, cy = a[1] + dy * t;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < best.dist) {
        const L = Math.sqrt(L2);
        best = { s: this.cum[i] + t * L, d: ((x - cx) * dy - (y - cy) * dx) / L, dist };
      }
    }
    return best;
  }
  // Signed curvature (1/m, + = turning left) from the direction change over ±w.
  curvature(s, w = 4) {
    const s0 = Math.max(0, s - w), s1 = Math.min(this.length, s + w);
    if (s1 - s0 < 1) return 0;
    const a = this.at(s0), b = this.at(s1);
    return Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty) / (s1 - s0);
  }
}

const RoadPlan = {
  _active: false,
  _built: false,
  _step: 1,
  _selRoad: null,
  _selPole: null,
  _tool: 'select',
  _draft: null,          // points being drawn [[x,y]]
  _kerbDraft: null,      // { first: [[x,y]] } while tracing / picking kerbs
  _view: { cx: 0, cy: 0, z: 3 },
  _geo: new Map(),       // road id → { key, g }
  _res: null,            // engine result (not saved)
  _resStale: true,
  _qty: 'E',
  _showIso: true,
  _showSeg: true,
  _req: 0,
  _timer: null,
  _undo: [], _redo: [],
  _drag: null,
  _hover: null,
  _snap: true,
  _view3d: false,        // the 3D view (js/road3d.js) instead of the plan

  // ─── Data ────────────────────────────────────────────────────────────
  get rp() {
    const d = StreetLight.data;
    if (!d.roadPlan || typeof d.roadPlan !== 'object') d.roadPlan = AppState._defaultRoadPlan();
    const p = d.roadPlan;
    if (!Array.isArray(p.roads)) p.roads = [];
    if (!p.junctionCls || typeof p.junctionCls !== 'object') p.junctionCls = {};
    if (!p.settings) p.settings = {};
    if (!p._seq) p._seq = 1;
    return p;
  },
  get roads() { return this.rp.roads; },
  road(id) { return this.roads.find(r => r.id === id) || null; },
  get selRoad() { return this.road(this._selRoad); },
  _genId(prefix) { return prefix + '_' + (this.rp._seq++); },
  _num(v, d) { const x = parseFloat(v); return isFinite(x) ? x : d; },
  _fmt(v, dp = 2) { return v === null || v === undefined || !isFinite(v) ? '—' : (+v).toFixed(dp); },
  _design(road) { return road && typeof RoadLight !== 'undefined' ? RoadLight.design(road.designId) : null; },

  // ─── Undo (road data only; the background is not snapshotted) ────────
  _snapshot() { return JSON.stringify({ roads: this.roads, junctionCls: this.rp.junctionCls, settings: this.rp.settings, scene: this.rp.scene || null }); },
  _commit() {
    this._undo.push(this._last || this._snapshot());
    if (this._undo.length > 50) this._undo.shift();
    this._redo = [];
    this._last = this._snapshot();
    AppState.dirty = true;
    this._resStale = true;
    this._geo.clear();
    if (this._step === 3 || (this._view3d && this._res)) this.recompute();
  },
  _restore(snap) {
    const o = JSON.parse(snap);
    this.rp.roads = o.roads; this.rp.junctionCls = o.junctionCls || {}; this.rp.settings = o.settings || {};
    if (o.scene) this.rp.scene = o.scene; else delete this.rp.scene;
    this._last = snap; this._geo.clear(); this._resStale = true; AppState.dirty = true;
    if (!this.selRoad) this._selRoad = this.roads.length ? this.roads[0].id : null;
    this._selPole = null;
    this.render();
    if (this._step === 3 || (this._view3d && this._res)) this.recompute();
  },
  undo() { if (!this._undo.length) return; this._redo.push(this._snapshot()); this._restore(this._undo.pop()); },
  redo() { if (!this._redo.length) return; this._undo.push(this._snapshot()); this._restore(this._redo.pop()); },

  // ─── Lifecycle (StreetLight's view switch) ───────────────────────────
  mount(host) {
    if (this._built || !host) return;
    this._built = true;
    host.innerHTML = `
      <aside class="sl-rail rp-rail">
        <div class="sl-rail-head">Roads</div>
        <div id="rp-roads" class="sl-rail-list"></div>
        <div class="sl-rail-head rp-rail-sub">Background</div>
        <div id="rp-bg" class="rp-bg-panel"></div>
        <div class="sl-rail-head rp-rail-sub">Junctions</div>
        <div id="rp-junctions" class="rp-bg-panel"></div>
        <input type="file" id="rp-file" accept=".dxf,.DXF" hidden>
      </aside>
      <section class="rp-main">
        <div class="rp-steps" role="tablist" aria-label="Road plan steps">
          <button role="tab" data-rp-step="1"><b>1</b> Road shape</button>
          <button role="tab" data-rp-step="2"><b>2</b> Poles</button>
          <button role="tab" data-rp-step="3"><b>3</b> Light on the plan</button>
        </div>
        <div class="rp-toolbar" id="rp-toolbar" role="toolbar" aria-label="Road plan tools"></div>
        <div class="rp-canvas-wrap" id="rp-wrap">
          <svg id="rp-svg" class="rp-svg" tabindex="0" aria-label="Road plan">
            <g id="rp-world"><g id="rp-w-bg"></g><g id="rp-w-roads"></g><image id="rp-w-heat" preserveAspectRatio="none" style="image-rendering:auto"></image><g id="rp-w-iso"></g><g id="rp-w-lines"></g></g>
            <g id="rp-screen"></g>
          </svg>
          <div class="rp-legend" id="rp-legend"></div>
          <div class="rp-readout" id="rp-readout"></div>
          <div class="rp-hint" id="rp-hint"></div>
          <div class="rp-pick" id="rp-pick" style="display:none"></div>
        </div>
        <div class="rp-3d" id="rp-3d" hidden></div>
      </section>
      <aside class="sl-results rp-panel" id="rp-panel"></aside>`;
    host.addEventListener('click', (e) => this._onClick(e));
    host.addEventListener('change', (e) => this._onChange(e));
    host.querySelector('#rp-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importDxf(f); });
    const svg = host.querySelector('#rp-svg');
    svg.addEventListener('pointerdown', (e) => this._down(e));
    svg.addEventListener('pointermove', (e) => this._move(e));
    svg.addEventListener('pointerup', (e) => this._up(e));
    svg.addEventListener('pointercancel', (e) => this._up(e));
    svg.addEventListener('pointerleave', () => { this._hover = null; this._readout(); });
    svg.addEventListener('dblclick', (e) => this._dbl(e));
    svg.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this._ro = new ResizeObserver(() => this.applyView());
    this._ro.observe(host.querySelector('#rp-wrap'));
  },

  activate(host) {
    this.mount(host);
    this._active = true;
    if (!this.selRoad) this._selRoad = this.roads.length ? this.roads[0].id : null;
    this._last = this._snapshot();
    if (!this._fitted) { this._fitted = true; this.fit(); }
    this.render();
    if (this._step === 3 && this._resStale) this.recompute(0);
  },
  deactivate() { this._active = false; clearTimeout(this._timer); this._draft = null; this._kerbDraft = null; },
  onProjectChanged() {
    this._res = null; this._resStale = true; this._geo.clear(); this._undo = []; this._redo = [];
    this._selRoad = this.roads.length ? this.roads[0].id : null; this._selPole = null; this._fitted = false;
    if (this._active) { this._fitted = true; this.fit(); this.render(); this._last = this._snapshot(); }
  },

  // ─── Geometry ────────────────────────────────────────────────────────
  // Tangent-arc fillets at each intersection point (IP) of a drawn centreline.
  // Tangent lengths that overrun a leg are scaled back (the radius shrinks).
  _fillet(ip, defR) {
    const P = ip.map(v => [v.x, v.y]);
    const n = P.length;
    const pts = [P[0]], els = [];
    if (n < 2) return { pts, els };
    const u = [], L = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], l = Math.hypot(dx, dy) || 1e-9;
      u.push([dx / l, dy / l]); L.push(l);
    }
    const T = new Array(n).fill(0), D = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const a = u[i - 1], b = u[i];
      D[i] = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
      const r = ip[i].r === undefined || ip[i].r === null || ip[i].r === '' ? defR : +ip[i].r;
      T[i] = Math.abs(D[i]) > 1e-3 && r > 0 ? r * Math.tan(Math.abs(D[i]) / 2) : 0;
    }
    for (let i = 0; i < n - 1; i++) {
      const sum = T[i] + T[i + 1];
      if (sum > L[i] * 0.999) { const k = L[i] * 0.999 / sum; T[i] *= k; T[i + 1] *= k; }
    }
    let s = 0;
    const lineTo = (q, vtx) => {
      const last = pts[pts.length - 1];
      const l = Math.hypot(q[0] - last[0], q[1] - last[1]);
      if (l > 1e-6) { els.push({ type: 'line', s0: s, s1: s + l, vertex: vtx }); s += l; pts.push(q); }
    };
    for (let i = 1; i < n - 1; i++) {
      if (T[i] <= 1e-6) { lineTo(P[i], i); continue; }
      const a = u[i - 1], b = u[i];
      const tp1 = [P[i][0] - a[0] * T[i], P[i][1] - a[1] * T[i]];
      const tp2 = [P[i][0] + b[0] * T[i], P[i][1] + b[1] * T[i]];
      lineTo(tp1, i);
      const R = T[i] / Math.tan(Math.abs(D[i]) / 2);
      const sg = D[i] > 0 ? 1 : -1;                       // + = turning left
      const c = [tp1[0] - a[1] * R * sg, tp1[1] + a[0] * R * sg];
      const a0 = Math.atan2(tp1[1] - c[1], tp1[0] - c[0]);
      const m = Math.max(2, Math.ceil(Math.abs(D[i]) * R / 0.5), Math.ceil(Math.abs(D[i]) * 180 / Math.PI / 2));
      const s0 = s;
      for (let k = 1; k <= m; k++) {
        const ang = a0 + D[i] * k / m;
        const q = k === m ? tp2 : [c[0] + R * Math.cos(ang), c[1] + R * Math.sin(ang)];
        const last = pts[pts.length - 1];
        s += Math.hypot(q[0] - last[0], q[1] - last[1]);
        pts.push(q);
      }
      els.push({ type: 'arc', s0, s1: s, R, turn: Math.abs(D[i]) * 180 / Math.PI, dir: sg > 0 ? 'L' : 'R', vertex: i, centre: c });
    }
    lineTo(P[n - 1], n - 1);
    return { pts, els };
  },

  // Centreline + width profile from two traced kerbs: kerb 1 sampled every
  // metre, each sample paired with the nearest point of kerb 2.
  _kerbMid(k1, k2) {
    const a = new RPAlign(k1), b = new RPAlign(k2);
    if (!a.ok || !b.ok) return null;
    const mids = [], widths = [];
    const n = Math.max(2, Math.ceil(a.length));
    for (let k = 0; k <= n; k++) {
      const p = a.at(a.length * k / n);
      const q = b.project(p.x, p.y);
      if ((q.s < 0.01 || q.s > b.length - 0.01) && k > 0 && k < n) continue;
      const qp = b.at(q.s);
      mids.push([(p.x + qp.x) / 2, (p.y + qp.y) / 2]);
      widths.push(Math.hypot(p.x - qp.x, p.y - qp.y));
    }
    const al = new RPAlign(mids);
    if (!al.ok) return null;
    return { pts: al.pts, kerbWidth: al.cum.map((s, i) => [+s.toFixed(2), +widths[Math.min(i, widths.length - 1)].toFixed(3)]) };
  },

  // Everything derived from a road's shape + design, cached on a signature.
  geom(road) {
    const des = this._design(road);
    const key = JSON.stringify([road.mode, road.ip, road.poly, road.kerbs, road.radius, des && des.sections, des && des.rows]);
    const c = this._geo.get(road.id);
    if (c && c.key === key) return c.g;
    let pts = [], els = null, kerbWidth = null;
    if (road.mode === 'ip') { const f = this._fillet(road.ip || [], this._num(road.radius, 50)); pts = f.pts; els = f.els; }
    else if (road.mode === 'kerbs' && road.kerbs) { const m = this._kerbMid(road.kerbs.a, road.kerbs.b); if (m) { pts = m.pts; kerbWidth = m.kerbWidth; } }
    else pts = road.poly || [];
    const al = new RPAlign(pts);
    const xs = this._xs(des, kerbWidth);
    const g = { al, els, kerbWidth, xs, des };
    this._geo.set(road.id, { key, g });
    return g;
  },

  // Cross-section layout (section y) and the offset of y from the centreline.
  _xs(des, kerbWidth) {
    const lay = des ? RoadLight._layout(des) : { secs: [{ type: 'carriageway', y0: 0, y1: 7, width: 7, lanes: 2 }], width: 7, leftKerb: 0, rightKerb: 7, medY: 3.5 };
    const kl = lay.leftKerb, kr = lay.rightKerb, yc = (kl + kr) / 2, nominal = kr - kl;
    const kwS = kerbWidth ? kerbWidth.map(p => p[0]) : null, kwK = kerbWidth ? kerbWidth.map(p => Math.max(0.05, p[1] / (nominal || 1))) : null;
    const scale = (s) => {
      if (!kwS || !kwS.length) return 1;
      if (s <= kwS[0]) return kwK[0];
      if (s >= kwS[kwS.length - 1]) return kwK[kwK.length - 1];
      let i = 0; while (i < kwS.length - 2 && kwS[i + 1] < s) i++;
      const t = (s - kwS[i]) / ((kwS[i + 1] - kwS[i]) || 1e-9);
      return kwK[i] + (kwK[i + 1] - kwK[i]) * t;
    };
    const off = (s, y) => {
      const k = scale(s);
      if (y < kl) return (kl - yc) * k + (y - kl);
      if (y > kr) return (kr - yc) * k + (y - kr);
      return (y - yc) * k;
    };
    return { lay, kl, kr, yc, width: lay.width, off, scale };
  },

  // Straights and bends: drawn arcs exactly, else from the curvature.
  _shapeRuns(road, g) {
    const runs = [];
    const L = g.al.length;
    const bendR = this._num(this.rp.settings.bendMaxR, 500);
    if (g.els) {
      for (const e of g.els) runs.push(e.type === 'arc' && e.R < bendR
        ? { kind: 'bend', s0: e.s0, s1: e.s1, radius: e.R, dir: e.dir } : { kind: 'straight', s0: e.s0, s1: e.s1 });
    } else {
      const n = Math.max(1, Math.ceil(L));
      let cur = null;
      for (let k = 0; k < n; k++) {
        const s = L * (k + 0.5) / n;
        const kap = g.al.curvature(s);
        const bend = Math.abs(kap) > 1 / bendR;
        const kind = bend ? 'bend' : 'straight';
        if (!cur || cur.kind !== kind || (bend && Math.sign(kap) !== cur.sign)) {
          if (cur) runs.push(cur);
          cur = { kind, s0: L * k / n, s1: L * (k + 1) / n, sign: Math.sign(kap), ks: [] };
        }
        cur.s1 = L * (k + 1) / n; cur.ks.push(Math.abs(kap));
      }
      if (cur) runs.push(cur);
      // radius from the middle half of the run (its ends are blurred by the ±4 m window)
      for (const r of runs) {
        if (r.kind === 'bend') {
          const mid = r.ks.slice(Math.floor(r.ks.length / 4), Math.max(Math.floor(r.ks.length / 4) + 1, Math.ceil(r.ks.length * 3 / 4)));
          const k = mid.reduce((a, b) => a + b, 0) / mid.length;
          r.radius = k > 0 ? 1 / k : null; r.dir = r.sign > 0 ? 'L' : 'R';
        }
        delete r.ks;
      }
    }
    // merge consecutive straights, then fold pieces under 8 m into a neighbour
    const merged = [];
    for (const r of runs) {
      const p = merged[merged.length - 1];
      if (p && p.kind === r.kind && r.kind === 'straight') p.s1 = r.s1; else merged.push({ ...r });
    }
    for (let i = 0; i < merged.length && merged.length > 1; i++) {
      if (merged[i].s1 - merged[i].s0 >= 8) continue;
      const j = i > 0 ? i - 1 : i + 1;
      merged[j].s0 = Math.min(merged[j].s0, merged[i].s0); merged[j].s1 = Math.max(merged[j].s1, merged[i].s1);
      merged.splice(i, 1); i = -1;
    }
    return merged;
  },

  // ─── Junctions ───────────────────────────────────────────────────────
  _halfKerb(road, g, s) { return Math.max(Math.abs(g.xs.off(s, g.xs.kl)), Math.abs(g.xs.off(s, g.xs.kr))); },
  junctions() {
    const list = [];
    const roads = this.roads.map(r => ({ r, g: this.geom(r) })).filter(x => x.g.al.ok);
    for (const A of roads) {
      for (const B of roads) {
        if (A === B) continue;
        for (const end of ['start', 'end']) {
          const sA = end === 'start' ? 0 : A.g.al.length;
          const p = A.g.al.at(sA);
          const pr = B.g.al.project(p.x, p.y);
          const hb = this._halfKerb(B.r, B.g, pr.s);
          if (pr.dist > hb + 3 || pr.s < 2 || pr.s > B.g.al.length - 2) continue;
          const inward = A.g.al.at(end === 'start' ? Math.min(A.g.al.length, 10) : Math.max(0, A.g.al.length - 10));
          const side = Math.sign(B.g.al.project(inward.x, inward.y).d) || 1;
          list.push({ key: `${B.r.id}:${A.r.id}:${end}`, kind: 'T', main: B.r.id, side: A.r.id, sMain: pr.s, sSide: sA, sideSign: side, x: p.x, y: p.y });
        }
      }
    }
    // crossings: centrelines intersecting away from the ends
    for (let i = 0; i < roads.length; i++) {
      for (let j = i + 1; j < roads.length; j++) {
        const A = roads[i], B = roads[j];
        const pa = A.g.al.pts, pb = B.g.al.pts;
        for (let a = 0; a < pa.length - 1; a++) {
          for (let b = 0; b < pb.length - 1; b++) {
            const hit = this._segX(pa[a], pa[a + 1], pb[b], pb[b + 1]);
            if (!hit) continue;
            const sA = A.g.al.cum[a] + hit.t * (A.g.al.cum[a + 1] - A.g.al.cum[a]);
            const sB = B.g.al.cum[b] + hit.u * (B.g.al.cum[b + 1] - B.g.al.cum[b]);
            if (sA < 3 || sA > A.g.al.length - 3 || sB < 3 || sB > B.g.al.length - 3) continue;
            list.push({ key: `${A.r.id}x${B.r.id}:${Math.round(sA)}`, kind: 'X', main: A.r.id, side: B.r.id, sMain: sA, sSide: sB, x: hit.x, y: hit.y });
          }
        }
      }
    }
    // a T found from both sides or twice: keep the first within 5 m
    const out = [];
    for (const j of list) if (!out.some(o => Math.hypot(o.x - j.x, o.y - j.y) < 5)) out.push(j);
    out.forEach((j, k) => { j.name = 'J' + (k + 1); });
    return out;
  },
  _segX(p, q, r, s) {
    const d1x = q[0] - p[0], d1y = q[1] - p[1], d2x = s[0] - r[0], d2y = s[1] - r[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((r[0] - p[0]) * d2y - (r[1] - p[1]) * d2x) / den;
    const u = ((r[0] - p[0]) * d1y - (r[1] - p[1]) * d1x) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, u, x: p[0] + d1x * t, y: p[1] + d1y * t };
  },
  // Chainage ranges each junction takes out of the roads it joins.
  _junctionRanges(j) {
    const A = this.road(j.main), B = this.road(j.side);
    const gA = this.geom(A), gB = this.geom(B);
    const ext = 6;    // kerb-return allowance
    const hA = this._halfKerb(A, gA, j.sMain), hB = this._halfKerb(B, gB, j.sSide);
    const out = [{ road: A.id, s0: Math.max(0, j.sMain - hB - ext), s1: Math.min(gA.al.length, j.sMain + hB + ext) }];
    if (j.kind === 'T') {
      out.push(j.sSide === 0 ? { road: B.id, s0: 0, s1: Math.min(gB.al.length, hA + ext) } : { road: B.id, s0: Math.max(0, gB.al.length - hA - ext), s1: gB.al.length });
    } else {
      out.push({ road: B.id, s0: Math.max(0, j.sSide - hA - ext), s1: Math.min(gB.al.length, j.sSide + hA + ext) });
    }
    return out;
  },
  _junctionCls(j) {
    const set = this.rp.junctionCls[j.key];
    if (set) return set;
    const des = this._design(this.road(j.main));
    const cw = des && des.sections.find(s => s.type === 'carriageway' && s.cls);
    if (!cw) return this._standard() === 'SANS' ? 'RC4' : 'C3';
    return (this._standard() === 'SANS' ? RP_SANS_RC : RP_COMPARABLE_C)[cw.cls] || (this._standard() === 'SANS' ? 'RC4' : 'C3');
  },
  _kerbPolygon(road, s0, s1) {
    const g = this.geom(road);
    const n = Math.max(2, Math.ceil((s1 - s0) / 1));
    const left = [], right = [];
    for (let k = 0; k <= n; k++) {
      const s = s0 + (s1 - s0) * k / n;
      const a = g.al.at(s, g.xs.off(s, g.xs.kl)), b = g.al.at(s, g.xs.off(s, g.xs.kr));
      left.push([+a.x.toFixed(2), +a.y.toFixed(2)]); right.push([+b.x.toFixed(2), +b.y.toFixed(2)]);
    }
    return left.concat(right.reverse());
  },

  // Segments of one road: straights / bends with junction ranges cut out.
  segments(road, juncs) {
    const g = this.geom(road);
    if (!g.al.ok) return [];
    const cut = [];
    for (const j of juncs || this.junctions()) for (const r of this._junctionRanges(j)) if (r.road === road.id) cut.push(r);
    const out = [];
    for (const run of this._shapeRuns(road, g)) {
      let pieces = [[run.s0, run.s1]];
      for (const c of cut) {
        const next = [];
        for (const [a, b] of pieces) {
          if (c.s1 <= a || c.s0 >= b) { next.push([a, b]); continue; }
          if (c.s0 > a) next.push([a, c.s0]);
          if (c.s1 < b) next.push([c.s1, b]);
        }
        pieces = next;
      }
      for (const [a, b] of pieces) if (b - a >= 3) out.push({ ...run, s0: a, s1: b });
    }
    out.sort((a, b) => a.s0 - b.s0);
    out.forEach((s, k) => { s.id = `${road.id}:S${k + 1}`; s.name = 'S' + (k + 1); });
    return out;
  },

  // ─── Poles ───────────────────────────────────────────────────────────
  _row(road, p) {
    const des = this._design(road);
    if (!des || !des.rows.length) return null;
    return des.rows.find(r => r.id === p.rowId) || des.rows[0];
  },
  // Plan geometry of one pole: base, luminaire head, aim, mounting values.
  poleGeom(road, p) {
    const g = this.geom(road);
    const row = this._row(road, p);
    if (!row || !g.al.ok) return null;
    const rg = RoadLight._rowGeom(row, g.xs.lay);
    const o = p.over || {};
    const pick = (k, d) => (o[k] !== undefined && o[k] !== null && o[k] !== '' ? this._num(o[k], d) : this._num(row[k], d));
    const d = p.d !== undefined && p.d !== null ? p.d : g.xs.off(p.s, rg.poleY);
    const base = g.al.at(p.s, d);
    const sgn = rg.facing === 'right' ? 1 : -1;           // + = towards the right-hand normal
    const ax = base.nx * sgn, ay = base.ny * sgn;
    const overhang = pick('overhang', 0);
    const phId = o.photometryId || row.photometryId;
    const ph = RoadLight.library[phId];
    return {
      bx: base.x, by: base.y, hx: base.x + ax * overhang, hy: base.y + ay * overhang, ax, ay,
      aim: Math.atan2(ay, ax) * 180 / Math.PI, d, side: d < 0 ? 'L' : 'R',
      height: pick('height', 10), tilt: pick('tilt', 0), fluxPct: pick('fluxPct', 100), overhang,
      rotate: this._num(row.rotate, 0) + (ph ? this._num(ph.rotate, 0) : 0), photometryId: phId,
    };
  },
  _layoutCfg(road) {
    const des = this._design(road);
    return Object.assign({ spacing: des ? this._num(des.spacing, 35) : 35, start: 3, bendR: 80, bendFactor: 0.75, outsideOnly: false, keepClear: 3 }, road.layout || {});
  },
  // Lay every design row out along its own pole line.
  layoutRoad(road, keepMoved = true) {
    const des = this._design(road);
    const g = this.geom(road);
    if (!des || !des.rows.length || !g.al.ok) return;
    const cfg = this._layoutCfg(road);
    const S = Math.max(2, this._num(cfg.spacing, 35));
    const juncs = this.junctions();
    const mouth = [];
    for (const j of juncs) {
      for (const r of this._junctionRanges(j)) {
        if (r.road !== road.id) continue;
        const other = this.road(j.main === road.id ? j.side : j.main);
        const hb = other ? this._halfKerb(other, this.geom(other), j.main === road.id ? j.sSide : j.sMain) : 4;
        if (j.main === road.id) mouth.push({ s0: j.sMain - hb - cfg.keepClear, s1: j.sMain + hb + cfg.keepClear, sign: j.kind === 'T' ? j.sideSign : 0 });
        else mouth.push({ s0: r.s0 - cfg.keepClear, s1: r.s1 + cfg.keepClear, sign: 0, endRange: true });
      }
    }
    const moved = keepMoved ? (road.poles || []).filter(p => p.moved) : [];
    const auto = [];
    const L = g.al.length;
    const twoSided = new Set(des.rows.map(r => RoadLight._rowGeom(r, g.xs.lay).facing)).size > 1;
    for (const row of des.rows) {
      const rg = RoadLight._rowGeom(row, g.xs.lay);
      const ds = 0.25;
      let prev = g.al.at(0, g.xs.off(0, rg.poleY)), along = 0;
      let next = this._num(cfg.start, 3) + this._num(row.xOffset, 0) * S;
      for (let s = 0; s <= L + 1e-9; s += ds) {
        const p = g.al.at(s, g.xs.off(s, rg.poleY));
        along += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p;
        if (along + 1e-9 < next) continue;
        const kap = g.al.curvature(s);
        const tight = Math.abs(kap) > 1 / Math.max(1, cfg.bendR);
        const d = g.xs.off(s, rg.poleY);
        const inside = tight && kap * -d > 0;              // pole on the centre side of the bend
        next += S * (tight ? this._num(cfg.bendFactor, 0.75) : 1);
        if (cfg.outsideOnly && twoSided && inside) continue;
        if (mouth.some(m => (m.endRange ? (s >= Math.min(m.s0, m.s1) && s <= Math.max(m.s0, m.s1)) : (s > m.s0 && s < m.s1 && (!m.sign || Math.sign(d) === m.sign))))) continue;
        auto.push({ id: this._genId('rpp'), s: +s.toFixed(2), rowId: row.id, moved: false, note: tight ? `bend R${Math.round(1 / Math.abs(kap))}` : '' });
      }
    }
    const kept = auto.filter(a => !moved.some(m => m.rowId === a.rowId && Math.abs(m.s - a.s) < S / 3));
    road.poles = moved.concat(kept).sort((a, b) => a.s - b.s);
  },
  _poleNames(road) {
    const m = new Map();
    (road.poles || []).slice().sort((a, b) => a.s - b.s).forEach((p, k) => m.set(p.id, 'P' + (k + 1)));
    return m;
  },

  // ─── Roads (create / edit) ───────────────────────────────────────────
  async _designForNewRoad() {
    const sel = this.selRoad;
    if (sel && RoadLight.design(sel.designId)) return sel.designId;
    if (RoadLight.designs.length) return RoadLight.designs[0].id;
    await RoadLight.newDesign();
    return RoadLight.designs.length ? RoadLight.designs[RoadLight.designs.length - 1].id : null;
  },
  async _newRoad(init) {
    const designId = await this._designForNewRoad();
    if (!designId) return null;
    const road = Object.assign({ id: this._genId('rpr'), name: `Road ${this.roads.length + 1}`, designId, radius: 50, poles: [], layout: {} }, init);
    this.roads.push(road);
    this._selRoad = road.id;
    this.layoutRoad(road);
    // a new road may close a junction on an existing one: re-lay those
    for (const r of this.roads) if (r !== road && !r.poles.some(p => p.moved)) this.layoutRoad(r);
    this._commit();
    this.render();
    return road;
  },
  async deleteRoad(id) {
    const r = this.road(id);
    if (!r || !(await UI.confirm(`Delete road "${r.name}" and its poles?`, { danger: true, okText: 'Delete' }))) return;
    this.rp.roads = this.roads.filter(x => x.id !== id);
    this._selRoad = this.roads.length ? this.roads[0].id : null;
    this._selPole = null;
    this._commit(); this.render();
  },
  async reverseRoad(id) {
    const r = this.road(id);
    if (!r) return;
    if (r.poles.some(p => p.moved) && !(await UI.confirm('Reversing the road swaps its cross-section end for end and lays the poles out again — moved poles are reset. Continue?'))) return;
    if (r.mode === 'ip') r.ip.reverse();
    else if (r.mode === 'kerbs') { r.kerbs.a.reverse(); r.kerbs.b.reverse(); }
    else if (r.poly) r.poly.reverse();
    this._geo.delete(r.id);
    this.layoutRoad(r, false);
    this._commit(); this.render();
  },

  // ─── Engine ──────────────────────────────────────────────────────────
  _standard() {
    if (this.rp.settings.standard) return this.rp.settings.standard;
    const d = this.roads.map(r => this._design(r)).find(Boolean);
    return d ? RoadLight._std(d) : 'SANS';
  },
  _mf() {
    if (this.rp.settings.mf) return this._num(this.rp.settings.mf, 0.8);
    const d = this.roads.map(r => this._design(r)).find(Boolean);
    return d ? this._num(d.mf, 0.8) : 0.8;
  },
  _problems() {
    const p = [];
    const live = this.roads.filter(r => this.geom(r).al.ok);
    if (!live.length) p.push('Draw a road first (step 1).');
    for (const r of live) if (!this._design(r)) { p.push(`${r.name}: pick a lighting design for its cross-section.`); }
    if (!live.some(r => (r.poles || []).length)) p.push('Place poles (step 2).');
    const stds = new Set(live.map(r => this._design(r)).filter(Boolean).map(d => RoadLight._std(d)));
    if (stds.size > 1 && !this.rp.settings.standard) p.push('The roads use lighting designs to different standards — pick one standard for the plan in step 3.');
    return p;
  },
  payload() {
    const juncs = this.junctions();
    const photometry = {}, luminaires = [], roads = [];
    for (const road of this.roads) {
      const g = this.geom(road);
      const des = this._design(road);
      if (!g.al.ok || !des) continue;
      const lay = RoadLight._layout(des);
      roads.push({
        id: road.id, name: road.name,
        centreline: g.al.pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]),
        sections: lay.secs.map(s => ({ type: s.type, name: s.name || RoadLight._secName(s, des), width: s.width, lanes: s.lanes, cls: s.cls, surface: s.surface, direction: s.direction, volume: this._num(s.volume, 0) })),
        kerbWidth: g.kerbWidth,
        segments: this.segments(road, juncs).map(s => ({ id: s.id, name: s.name, s0: +s.s0.toFixed(2), s1: +s.s1.toFixed(2), kind: s.kind, radius: s.radius ? +s.radius.toFixed(1) : null })),
      });
      for (const p of road.poles || []) {
        const pg = this.poleGeom(road, p);
        if (!pg || !RoadLight.library[pg.photometryId]) continue;
        photometry[pg.photometryId] = RoadLight.library[pg.photometryId];
        luminaires.push({ id: p.id, roadId: road.id, x: +pg.hx.toFixed(3), y: +pg.hy.toFixed(3), h: pg.height, aim: +pg.aim.toFixed(3), tilt: pg.tilt, rotate: pg.rotate, photometryId: pg.photometryId, fluxPct: pg.fluxPct });
      }
    }
    const conflictAreas = juncs.map(j => ({
      id: j.key, name: j.name, cls: this._junctionCls(j),
      polygons: this._junctionRanges(j).map(r => this._kerbPolygon(this.road(r.road), r.s0, r.s1)),
    }));
    const scene = typeof Road3D !== 'undefined' ? Road3D.requestParts() : {};
    return { standard: this._standard(), mf: this._mf(), photometry, roads, luminaires, conflictAreas, hoursPerYear: 4100, ...scene };
  },
  recompute(delay = 400) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._compute(), delay);
  },
  async _compute() {
    if (!this._active) return;
    const pr = this._problems();
    if (pr.length) {
      this._res = { problems: pr }; this._resStale = false; this.renderPanel(); this.renderWorld();
      if (this._view3d && typeof Road3D !== 'undefined') Road3D.render();
      return;
    }
    const req = ++this._req;
    this._busy = true; this.renderPanel();
    try {
      const r = await API.request('/analysis/road-plan', 'POST', this.payload());
      if (req !== this._req) return;
      this._res = r;
    } catch (e) {
      if (req !== this._req) return;
      this._res = { error: e.message || String(e) };
    }
    this._busy = false; this._resStale = false;
    this._heatKey = null;
    this.renderPanel(); this.renderWorld(); this.renderRail();
    if (this._view3d && typeof Road3D !== 'undefined') Road3D.render();
  },

  // ─── DXF background ──────────────────────────────────────────────────
  async importDxf(file) {
    UI.setBusy && UI.setBusy(true, 'Reading DXF…');
    let data;
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'plan.dxf');
      const resp = await fetch(`${API_BASE}/plan/dxf-import`, { method: 'POST', body: fd, headers: API.authHeaders() });
      if (!resp.ok) { let d = `HTTP ${resp.status}`; try { const j = await resp.json(); if (j.detail) d = j.detail; } catch (_) {} throw new Error(d); }
      data = await resp.json();
    } catch (e) {
      UI.alert('DXF import failed: ' + (e && e.message ? e.message : e)); return;
    } finally { UI.setBusy && UI.setBusy(false); }
    if (data.mode === 'roundtrip' || !Array.isArray(data.entities)) { UI.alert('That DXF is a ProtectionPro plan export — import the original drawing instead.'); return; }
    await this._setBackground(data, (file.name || 'DXF').replace(/\.dxf$/i, ''));
  },
  // Site plan drawings already in the project (Plan › DXF backgrounds) — pick one
  // instead of importing the file again.
  _sitePlanDxfs() {
    const list = (typeof PlanDxfImport !== 'undefined' && AppState.planMarkup && Array.isArray(AppState.planMarkup.dxfs)) ? AppState.planMarkup.dxfs : [];
    return list.filter(d => d.imageId != null || PlanDxfImport.dataOf(d));
  },
  async useSitePlan() {
    const list = this._sitePlanDxfs();
    if (!list.length) { UI.toast('The site plan has no DXF drawing to use — import one there, or load a DXF here.', 'info', 4000); return; }
    let desc = list[0];
    if (list.length > 1) {
      const m = RoadLight._modal('rp-siteplan-modal', 'Use a site plan drawing', `<p class="rl-lead">Pick the drawing to pick road lines from:</p>
        <div class="rl-form"><label>Drawing<select data-d>${list.map((d, i) => `<option value="${i}">${escHtml(d.name || 'DXF')}</option>`).join('')}</select></label></div>`,
        '<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Use</button>');
      if (!(await RoadLight._modalResult(m))) return;
      desc = list[+m.querySelector('[data-d]').value];
    }
    UI.setBusy && UI.setBusy(true, 'Reading the site plan drawing…');
    let data = PlanDxfImport.dataOf(desc);
    try {
      if (!data) {
        const resp = await fetch(`${API_BASE}/plan-images/${desc.imageId}`, { headers: API.authHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = PlanDxfImport._normalise(await resp.json());
      }
    } catch (e) {
      UI.alert('Could not read the site plan drawing: ' + (e && e.message ? e.message : e)); return;
    } finally { UI.setBusy && UI.setBusy(false); }
    await this._setBackground(data, desc.name || 'Site plan', desc.unitM);
  },
  async _setBackground(data, name, knownUnitM) {
    let unitM = knownUnitM || (data.units && data.units.m);
    if (!unitM) {
      const m = RoadLight._modal('rp-units-modal', 'Drawing units', `<p class="rl-lead">The DXF does not say what its units are. One drawing unit is:</p>
        <div class="rl-form"><label>Unit<select data-u="m"><option value="1">1 metre</option><option value="0.001">1 millimetre</option><option value="0.01">1 centimetre</option><option value="0.3048">1 foot</option></select></label></div>`,
        '<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="ok">Use</button>');
      const ok = await RoadLight._modalResult(m);
      if (!ok) return;
      unitM = +m.querySelector('[data-u="m"]').value;
    }
    const ents = [];
    let npts = 0, truncated = false;
    const push = (l, flat, closed) => {
      if (npts + flat.length / 2 > 120000) { truncated = true; return; }
      npts += flat.length / 2;
      ents.push({ l, p: flat.map(v => +(v * unitM).toFixed(3)), c: closed ? 1 : 0 });
    };
    for (const e of data.entities) {
      if (e.t === 'l') push(e.l, e.p, false);
      else if (e.t === 'p' && e.p && e.p.length >= 4) push(e.l, e.p, !!e.c);
      else if (e.t === 'a' || e.t === 'c') {
        const [cx, cy, r] = e.p;
        let a0 = e.t === 'a' ? e.p[3] : 0, a1 = e.t === 'a' ? e.p[4] : 360;
        if (a1 <= a0) a1 += 360;
        const n = Math.max(4, Math.ceil((a1 - a0) / 5));
        const flat = [];
        for (let k = 0; k <= n; k++) { const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180; flat.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        push(e.l, flat, e.t === 'c');
      }
    }
    const layers = (data.layers || []).map(l => ({ name: l.name, color: l.color || '#8a8f98', hidden: !l.on || !!l.frozen }))
      .filter(l => ents.some(e => e.l === l.name));
    this.rp.bg = { name, unitM, origin: data.origin || [0, 0], layers, ents };
    AppState.dirty = true;
    this.fit();
    this.render();
    UI.toast(`Background "${this.rp.bg.name}": ${ents.length} lines on ${layers.length} layers${truncated ? ' (very large — only the first part was kept)' : ''}. Use "From DXF" to pick a centreline or two kerbs.`, truncated ? 'warning' : 'success', 6000);
  },
  _bgVisible() {
    const bg = this.rp.bg;
    if (!bg) return [];
    const hidden = new Set(bg.layers.filter(l => l.hidden).map(l => l.name));
    return bg.ents.filter(e => !hidden.has(e.l));
  },
  // Chain the picked entity with connected pieces on its layer (endpoints ≤ 5 cm).
  // Where the line breaks, the nearest piece end within `gapTol` metres that
  // continues roughly the same way is bridged by a straight segment; each
  // bridge is returned in `gaps` so it can be shown and checked.
  _chain(ent, gapTol = 0) {
    const tol = 0.05;
    const pts = (e) => { const o = []; for (let i = 0; i < e.p.length; i += 2) o.push([e.p[i], e.p[i + 1]]); return o; };
    const pool = this._bgVisible().filter(e => e.l === ent.l && e !== ent && !e.c);
    let chain = pts(ent);
    const gaps = [];
    const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
    // direction leaving an end (away from the chain), unit vector
    const outDir = (atTail) => {
      const n = chain.length, e = atTail ? chain[n - 1] : chain[0];
      for (let k = 2; k <= n; k++) {
        const o = atTail ? chain[n - k] : chain[k - 1];
        const L = dist(e, o);
        if (L > 1e-6) return [(e[0] - o[0]) / L, (e[1] - o[1]) / L];
      }
      return null;
    };
    for (let guard = 0; guard < 5000; guard++) {
      let grew = false;
      for (let k = 0; k < pool.length; k++) {
        const q = pts(pool[k]);
        const h = chain[0], t = chain[chain.length - 1], a = q[0], b = q[q.length - 1];
        const near = (u, v) => dist(u, v) <= tol;
        if (near(t, a)) chain = chain.concat(q.slice(1));
        else if (near(t, b)) chain = chain.concat(q.reverse().slice(1));
        else if (near(h, b)) chain = q.slice(0, -1).concat(chain);
        else if (near(h, a)) chain = q.reverse().slice(0, -1).concat(chain);
        else continue;
        pool.splice(k, 1); grew = true; break;
      }
      if (grew) continue;
      if (!(gapTol > 0)) break;
      // no touching piece left: bridge the shortest forward gap at either end
      let best = null;
      for (const atTail of [true, false]) {
        const e = atTail ? chain[chain.length - 1] : chain[0];
        const dir = outDir(atTail);
        for (let k = 0; k < pool.length; k++) {
          const q = pts(pool[k]);
          for (const first of [true, false]) {
            const p = first ? q[0] : q[q.length - 1];
            const d = dist(e, p);
            if (d > gapTol) continue;
            if (dir && d > tol) { const c = ((p[0] - e[0]) * dir[0] + (p[1] - e[1]) * dir[1]) / d; if (c < 0.3) continue; }
            if (!best || d < best.d) best = { d, atTail, k, first, e, p };
          }
        }
      }
      if (!best) break;
      let q = pts(pool[best.k]);
      if (best.atTail) { if (!best.first) q.reverse(); chain = chain.concat(q); }
      else { if (best.first) q.reverse(); chain = q.concat(chain); }
      gaps.push([best.e, best.p]);
      pool.splice(best.k, 1);
    }
    return { pts: chain, gaps };
  },
  // Where a world point falls along a polyline: distance along it, the foot point, offset.
  _alongChain(pts, wx, wy) {
    let acc = 0, best = { s: 0, pt: pts[0], d: Infinity };
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy), L2 = L * L || 1e-12;
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / L2));
      const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(wx - px, wy - py);
      if (d < best.d) best = { s: acc + L * t, pt: [px, py], d };
      acc += L;
    }
    return best;
  },
  // The part of a polyline between distances s0 ≤ s1.
  _subChain(pts, s0, s1) {
    const out = [];
    let acc = 0;
    const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const e0 = acc, e1 = acc + L;
      if (e1 >= s0 && e0 <= s1 && L > 0) {
        const t0 = Math.max(0, (s0 - e0) / L), t1 = Math.min(1, (s1 - e0) / L);
        if (!out.length) out.push(at(a, b, t0));
        out.push(at(a, b, t1));
      }
      acc = e1;
    }
    return out.length > 1 ? out : pts.slice();
  },
  _pickEnt(wx, wy) {
    const tol = 8 / this._view.z;
    let best = null, bd = tol;
    for (const e of this._bgVisible()) {
      for (let i = 0; i + 3 < e.p.length; i += 2) {
        const ax = e.p[i], ay = e.p[i + 1], bx = e.p[i + 2], by = e.p[i + 3];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / L2));
        const d = Math.hypot(wx - ax - dx * t, wy - ay - dy * t);
        if (d < bd) { bd = d; best = e; }
      }
    }
    return best;
  },
  _snapPt(wx, wy) {
    if (!this._snap) return [wx, wy];
    const tol = 10 / this._view.z;
    let best = null, bd = tol;
    for (const e of this._bgVisible()) {
      for (let i = 0; i + 1 < e.p.length; i += 2) {
        const d = Math.hypot(wx - e.p[i], wy - e.p[i + 1]);
        if (d < bd) { bd = d; best = [e.p[i], e.p[i + 1]]; }
      }
    }
    for (const r of this.roads) {
      const al = this.geom(r).al;
      if (!al.ok) continue;
      for (const s of [0, al.length]) { const p = al.at(s); const d = Math.hypot(wx - p.x, wy - p.y); if (d < bd) { bd = d; best = [p.x, p.y]; } }
      const pr = al.project(wx, wy);
      if (!best && pr.dist < tol) { const p = al.at(pr.s); best = [p.x, p.y]; }
    }
    return best || [wx, wy];
  },

  // ─── View ────────────────────────────────────────────────────────────
  _size() { const w = document.getElementById('rp-wrap'); return w ? { W: w.clientWidth || 800, H: w.clientHeight || 500 } : { W: 800, H: 500 }; },
  toScreen(x, y) { const { W, H } = this._size(); const v = this._view; return [(x - v.cx) * v.z + W / 2, -(y - v.cy) * v.z + H / 2]; },
  toWorld(sx, sy) { const { W, H } = this._size(); const v = this._view; return [(sx - W / 2) / v.z + v.cx, -(sy - H / 2) / v.z + v.cy]; },
  _evWorld(e) { const r = document.getElementById('rp-svg').getBoundingClientRect(); return this.toWorld(e.clientX - r.left, e.clientY - r.top); },
  fit() {
    const xs = [], ys = [];
    for (const r of this.roads) for (const p of this.geom(r).al.pts) { xs.push(p[0]); ys.push(p[1]); }
    if (!xs.length && this.rp.bg) for (const e of this._bgVisible()) for (let i = 0; i < e.p.length; i += 2) { xs.push(e.p[i]); ys.push(e.p[i + 1]); }
    const { W, H } = this._size();
    if (!xs.length) { this._view = { cx: 50, cy: 30, z: Math.min(W, H) / 120 }; this.applyView(); return; }
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 20;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    this._view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z: Math.max(0.02, Math.min(40, Math.min(W / (x1 - x0), H / (y1 - y0)))) };
    this.applyView();
  },
  applyView() {
    const g = document.getElementById('rp-world');
    if (!g) return;
    const { W, H } = this._size();
    const v = this._view;
    g.setAttribute('transform', `matrix(${v.z},0,0,${-v.z},${W / 2 - v.cx * v.z},${H / 2 + v.cy * v.z})`);
    this.renderScreen();
  },
  _wheel(e) {
    e.preventDefault();
    const [wx, wy] = this._evWorld(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    const v = this._view;
    const z = Math.max(0.02, Math.min(80, v.z * f));
    v.cx = wx - (wx - v.cx) * v.z / z; v.cy = wy - (wy - v.cy) * v.z / z; v.z = z;
    this.applyView();
  },

  // ─── Pointer ─────────────────────────────────────────────────────────
  _hitPole(wx, wy) {
    const road = this.selRoad;
    const tol = 9 / this._view.z;
    let best = null, bd = tol;
    for (const r of this.roads) {
      for (const p of r.poles || []) {
        const g = this.poleGeom(r, p);
        if (!g) continue;
        const d = Math.min(Math.hypot(wx - g.bx, wy - g.by), Math.hypot(wx - g.hx, wy - g.hy));
        if (d < bd || (d === bd && r === road)) { bd = d; best = { road: r, pole: p }; }
      }
    }
    return best;
  },
  _hitVertex(wx, wy) {
    const r = this.selRoad;
    if (!r || r.mode !== 'ip') return -1;
    const tol = 8 / this._view.z;
    let best = -1, bd = tol;
    (r.ip || []).forEach((v, i) => { const d = Math.hypot(wx - v.x, wy - v.y); if (d < bd) { bd = d; best = i; } });
    return best;
  },
  _hitRoad(wx, wy) {
    let best = null, bd = Infinity;
    for (const r of this.roads) {
      const g = this.geom(r);
      if (!g.al.ok) continue;
      const pr = g.al.project(wx, wy);
      const half = Math.max(Math.abs(g.xs.off(pr.s, 0)), Math.abs(g.xs.off(pr.s, g.xs.width))) + 4 / this._view.z;
      if (pr.dist <= half && pr.dist < bd) { bd = pr.dist; best = r; }
    }
    return best;
  },
  _down(e) {
    const svg = document.getElementById('rp-svg');
    svg.focus({ preventScroll: true });
    const [wx, wy] = this._evWorld(e);
    if (e.button === 1 || e.button === 2 || (this._tool === 'select' && e.shiftKey)) { this._startPan(e); return; }
    if (e.button !== 0) return;
    if (this._tool === 'draw' || this._tool === 'kerbs') {
      const p = this._snapPt(wx, wy);
      if (!this._draft) this._draft = [];
      const last = this._draft[this._draft.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) this._draft.push(p);
      this.renderScreen(); return;
    }
    if (this._tool === 'pick') { this._pickAt(wx, wy, e); return; }
    if (this._tool === 'addpole') { this._addPoleAt(wx, wy); return; }
    if (this._tool === 'feed') { this._feedDown(wx, wy); return; }
    // select
    if (this._step === 1) {
      const vi = this._hitVertex(wx, wy);
      if (vi >= 0) {
        if (e.altKey) { this._deleteVertex(vi); return; }
        this._drag = { kind: 'vertex', i: vi, id: e.pointerId }; svg.setPointerCapture(e.pointerId); return;
      }
    }
    if (this._step === 2) {
      const h = this._hitPole(wx, wy);
      if (h) {
        this._selRoad = h.road.id; this._selPole = h.pole.id;
        this._drag = { kind: 'pole', road: h.road, pole: h.pole, id: e.pointerId, moved: false, free: e.altKey };
        svg.setPointerCapture(e.pointerId);
        this.render(); return;
      }
    }
    const r = this._hitRoad(wx, wy);
    if (r) { if (r.id !== this._selRoad) { this._selRoad = r.id; this._selPole = null; this.render(); } this._startPan(e, true); return; }
    this._selPole = null;
    this._startPan(e, true);
    this.renderScreen(); this.renderPanel();
  },
  _startPan(e, soft = false) {
    this._drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: this._view.cx, cy: this._view.cy, soft, id: e.pointerId };
    document.getElementById('rp-svg').setPointerCapture(e.pointerId);
  },
  _move(e) {
    const [wx, wy] = this._evWorld(e);
    const d = this._drag;
    if (d && d.kind === 'pan') {
      this._view.cx = d.cx - (e.clientX - d.x) / this._view.z;
      this._view.cy = d.cy + (e.clientY - d.y) / this._view.z;
      this.applyView(); return;
    }
    if (d && d.kind === 'vertex') {
      const r = this.selRoad; const p = this._snapPt(wx, wy);
      r.ip[d.i].x = p[0]; r.ip[d.i].y = p[1]; d.moved = true;
      this._geo.delete(r.id); this.renderWorld(); this.renderScreen(); return;
    }
    if (d && d.kind === 'pole') {
      const g = this.geom(d.road);
      const pr = g.al.project(wx, wy);
      d.pole.s = +Math.max(0, Math.min(g.al.length, pr.s)).toFixed(2);
      if (d.free || e.altKey) d.pole.d = +pr.d.toFixed(2);
      d.pole.moved = true; d.moved = true;
      this.renderScreen(); return;
    }
    this._hover = { wx, wy, sx: e.offsetX, sy: e.offsetY };
    if (this._draft || this._tool === 'pick') this.renderScreen();
    this._readout();
  },
  _up(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    try { document.getElementById('rp-svg').releasePointerCapture(d.id); } catch (_) {}
    if (d.kind === 'vertex' && d.moved) { this._relayoutUnmoved(this.selRoad); this._commit(); this.render(); }
    if (d.kind === 'pole' && d.moved) { this._commit(); this.render(); }
  },
  _dbl(e) {
    if (this._tool === 'feed') { if (this._feedDraft && this._feedDraft.route.length) this._feedDraft.route.pop(); this._feedFinish(); return; }
    if (this._tool === 'draw' || this._tool === 'kerbs') { if (this._draft && this._draft.length > 1) this._draft.pop(); this.finishDraft(); return; }
    if (this._step === 1 && this._tool === 'select') {
      const r = this.selRoad;
      if (!r || r.mode !== 'ip') return;
      const [wx, wy] = this._evWorld(e);
      // insert an IP on the leg nearest the click
      let best = -1, bd = 12 / this._view.z;
      for (let i = 0; i < r.ip.length - 1; i++) {
        const a = r.ip[i], b = r.ip[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((wx - a.x) * dx + (wy - a.y) * dy) / L2));
        const dd = Math.hypot(wx - a.x - dx * t, wy - a.y - dy * t);
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best >= 0) { r.ip.splice(best + 1, 0, { x: wx, y: wy }); this._relayoutUnmoved(r); this._commit(); this.render(); }
    }
  },
  _deleteVertex(i) {
    const r = this.selRoad;
    if (!r || r.ip.length <= 2) return;
    r.ip.splice(i, 1);
    this._relayoutUnmoved(r); this._commit(); this.render();
  },
  _relayoutUnmoved(r) { if (r) { this._geo.delete(r.id); this.layoutRoad(r, true); } },
  onKeydown(e) {
    if (!this._active || this._view3d) return false;   // the 3D view takes its keys on its canvas
    const k = e.key;
    if ((this._tool === 'draw' || this._tool === 'kerbs') && this._draft) {
      if (k === 'Enter') { this.finishDraft(); return true; }
      if (k === 'Escape') { this._draft = null; this.renderScreen(); return true; }
      if (k === 'Backspace') { this._draft.pop(); if (!this._draft.length) this._draft = null; this.renderScreen(); return true; }
    }
    if (this._tool === 'feed' && this._feedDraft) {
      if (k === 'Enter') { this._feedFinish(); return true; }
      if (k === 'Backspace') { if (this._feedDraft.route.length) this._feedDraft.route.pop(); else this._feedDraft = null; this.renderScreen(); return true; }
    }
    if (k === 'Escape') { this._kerbDraft = null; this._closePick(); this.setTool('select'); return true; }
    if ((k === 'Delete' || k === 'Backspace') && this._step === 2 && this._selPole) { this.deletePole(); return true; }
    if (k === 'f' || k === 'F') { this.fit(); return true; }
    return false;
  },

  // ─── Tools ───────────────────────────────────────────────────────────
  setTool(t) {
    this._tool = t; this._draft = null; this._feedDraft = null; this._closePick();
    if (t !== 'kerbs' && t !== 'pick') this._kerbDraft = null;
    this.renderToolbar(); this.renderScreen(); this._hint();
  },
  async finishDraft() {
    const pts = this._draft;
    this._draft = null;
    if (!pts || pts.length < 2) { this.renderScreen(); return; }
    if (this._tool === 'draw') {
      const r = this.selRoad;
      const defR = r ? this._num(r.radius, 50) : 50;
      await this._newRoad({ mode: 'ip', ip: pts.map(p => ({ x: +p[0].toFixed(3), y: +p[1].toFixed(3) })), radius: defR });
      this.setTool('select');
    } else if (this._tool === 'kerbs') {
      await this._kerbStep(pts);
    }
  },
  async _kerbStep(pts) {
    if (!this._kerbDraft) { this._kerbDraft = { a: pts }; this._hint(); this.renderScreen(); return; }
    const a = this._kerbDraft.a;
    this._kerbDraft = null;
    const mid = this._kerbMid(a, pts);
    if (!mid) { UI.alert('Those two kerbs do not run beside each other — trace them along the same stretch of road.'); this.renderScreen(); return; }
    await this._newRoad({ mode: 'kerbs', kerbs: { a: a.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]), b: pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]) } });
    this.setTool('select');
  },
  _pickAt(wx, wy, e) {
    if (this._trim && this._picked) { this._trimAt(wx, wy); return; }
    const ent = this._pickEnt(wx, wy);
    if (!ent) { UI.toast('No background line there — zoom in or click closer to a line.', 'info', 2500); return; }
    this._pickSrc = ent;
    this._trim = null;
    this._rechain();
    const box = document.getElementById('rp-pick');
    box.style.display = 'flex';
    const w = document.getElementById('rp-wrap').getBoundingClientRect();
    box.style.left = Math.min(w.width - 240, Math.max(8, e.clientX - w.left + 12)) + 'px';
    box.style.top = Math.min(w.height - 140, Math.max(8, e.clientY - w.top + 12)) + 'px';
  },
  _gapTol: 3,
  _rechain() {
    const c = this._chain(this._pickSrc, this._gapTol);
    this._picked = c.pts; this._pickGaps = c.gaps;
    this._trim = null;
    this._pickBox();
    this.renderScreen();
  },
  _pickBox() {
    const box = document.getElementById('rp-pick');
    if (!box || !this._picked) return;
    const ent = this._pickSrc, chain = this._picked;
    const len = new RPAlign(chain).length;
    const gaps = this._pickGaps || [];
    const gapRow = `<label class="rp-gapin">Bridge gaps up to <input type="number" min="0" step="0.5" value="${numAttr(this._gapTol)}" data-rp-gap> m</label>`
      + (gaps.length ? `<span class="rp-gapnote">${gaps.length} gap${gaps.length === 1 ? '' : 's'} bridged (dashed): ${gaps.map(g => this._fmt(Math.hypot(g[0][0] - g[1][0], g[0][1] - g[1][1]), 2) + ' m').join(', ')}</span>` : '');
    if (this._trim) {
      const m = this._trim;
      box.innerHTML = `<b>Trim the line</b><span class="sl-hint">${m.length ? 'Click the line to move the cut.' : 'Click the line where the cut goes.'} ${this._fmt(len, 1)} m</span>`
        + (m.length === 1 ? `<button class="btn-small" data-rp="trim-before">Delete the start → cut</button><button class="btn-small" data-rp="trim-after">Delete the cut → end</button>` : '')
        + (m.length === 2 ? `<button class="btn-small btn-primary" data-rp="trim-between">Keep only between the cuts</button><button class="btn-small" data-rp="trim-outside">Delete between the cuts</button>` : '')
        + `<button class="btn-small" data-rp="trim-done">${m.length ? 'Cancel trim' : 'Done'}</button>`;
      return;
    }
    const head = this._kerbDraft
      ? `<b>Second kerb</b><span class="sl-hint">${escHtml(ent.l)} · ${this._fmt(len, 1)} m</span>`
      : `<b>Use this line as</b><span class="sl-hint">${escHtml(ent.l)} · ${this._fmt(len, 1)} m (connected pieces joined)</span>`;
    const acts = this._kerbDraft
      ? `<button class="btn-small btn-primary" data-rp="pick-k2">Use as the other kerb</button>`
      : `<button class="btn-small btn-primary" data-rp="pick-cl">Centreline</button><button class="btn-small" data-rp="pick-k1">First kerb</button>`;
    box.innerHTML = head + gapRow + `<span class="rp-pickacts">${acts}<button class="btn-small" data-rp="pick-trim" title="Cut off the start, the end, or keep only a stretch">Trim…</button><button class="btn-small" data-rp="pick-cancel">Cancel</button></span>`;
  },
  _trimAt(wx, wy) {
    const pr = this._alongChain(this._picked, wx, wy);
    if (pr.d > 12 / this._view.z) { UI.toast('Click on the highlighted line.', 'info', 2000); return; }
    const m = this._trim;
    if (m.length >= 2) m.length = 0;
    m.push(pr);
    m.sort((a, b) => a.s - b.s);
    this._pickBox(); this.renderScreen();
  },
  _applyTrim(kind) {
    const m = this._trim || [], L = new RPAlign(this._picked).length;
    let s0 = 0, s1 = L;
    if (kind === 'before') s0 = m[0].s;
    else if (kind === 'after') s1 = m[0].s;
    else if (kind === 'between') { s0 = m[0].s; s1 = m[1].s; }
    else if (kind === 'outside') {
      // delete the stretch between the cuts: keep the longer remaining piece
      const a = m[0].s, b = m[1].s;
      if (a >= L - b) s1 = a; else s0 = b;
      UI.toast('Kept the longer remaining piece — use Trim again to shorten it further.', 'info', 3500);
    }
    if (s1 - s0 < 0.1) { UI.toast('Nothing would be left of the line.', 'warning', 2500); return; }
    const pts = this._subChain(this._picked, s0, s1);
    const has = (p) => pts.some(q => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6);
    this._pickGaps = (this._pickGaps || []).filter(g => has(g[0]) && has(g[1]));
    this._picked = pts;
    this._trim = null;
    this._pickBox(); this.renderScreen();
  },
  _closePick() { const b = document.getElementById('rp-pick'); if (b) b.style.display = 'none'; this._picked = null; this._pickGaps = null; this._pickSrc = null; this._trim = null; },
  async _usePicked(as) {
    const pts = this._picked;
    this._closePick();
    if (!pts || pts.length < 2) return;
    if (as === 'cl') { await this._newRoad({ mode: 'poly', poly: pts.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]) }); this.setTool('select'); }
    else if (as === 'k1') { this._kerbDraft = { a: pts }; this._hint(); this.renderScreen(); }
    else if (as === 'k2') await this._kerbStep(pts);
  },
  _addPoleAt(wx, wy) {
    const road = this._hitRoad(wx, wy) || this.selRoad;
    if (!road) return;
    const des = this._design(road), g = this.geom(road);
    if (!des || !des.rows.length) { UI.alert('Pick a lighting design for this road first.'); return; }
    const pr = g.al.project(wx, wy);
    // the row whose pole line is nearest the click
    let row = des.rows[0], bd = Infinity;
    for (const r of des.rows) { const d = Math.abs(g.xs.off(pr.s, RoadLight._rowGeom(r, g.xs.lay).poleY) - pr.d); if (d < bd) { bd = d; row = r; } }
    const p = { id: this._genId('rpp'), s: +pr.s.toFixed(2), rowId: row.id, moved: true, note: 'added' };
    road.poles.push(p); road.poles.sort((a, b) => a.s - b.s);
    this._selRoad = road.id; this._selPole = p.id;
    this._commit(); this.render();
  },
  deletePole() {
    const road = this.selRoad;
    if (!road || !this._selPole) return;
    road.poles = road.poles.filter(p => p.id !== this._selPole);
    this._selPole = null;
    this._commit(); this.render();
  },

  // ─── Render ──────────────────────────────────────────────────────────
  render() {
    if (!this._built) return;
    const wrap = document.getElementById('rp-wrap'), v3 = document.getElementById('rp-3d'), steps = document.querySelector('.rp-steps');
    if (wrap) wrap.hidden = this._view3d;
    if (v3) v3.hidden = !this._view3d;
    if (steps) steps.hidden = this._view3d;
    if (this._view3d && typeof Road3D !== 'undefined') {
      Road3D.mount(v3);
      this.renderRail(); this.renderToolbar(); this.renderPanel(); Road3D.render();
      return;
    }
    document.querySelectorAll('[data-rp-step]').forEach(b => {
      const on = +b.dataset.rpStep === this._step;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.renderRail(); this.renderToolbar(); this.renderPanel(); this.renderWorld(); this.applyView(); this._hint();
  },
  // Plan | 3D
  setView3d(on) {
    this._view3d = !!on && typeof Road3D !== 'undefined';
    this._draft = null; this._kerbDraft = null; this._closePick();
    this.render();
    if (!this._view3d) this.applyView();
  },
  setStep(n) {
    this._step = n;
    if (n !== 1 && (this._tool === 'draw' || this._tool === 'kerbs' || this._tool === 'pick')) this._tool = 'select';
    if (n !== 2 && (this._tool === 'addpole' || this._tool === 'feed')) this._tool = 'select';
    this._feedDraft = null;
    this._draft = null; this._kerbDraft = null; this._closePick();
    this.render();
    if (n === 3 && (this._resStale || !this._res)) this.recompute(0);
  },
  _hint() {
    const el = document.getElementById('rp-hint');
    if (!el) return;
    let t = '';
    if (!this.roads.length && this._tool === 'select' && this._step === 1) t = 'Draw a centreline, trace two kerbs, or load a DXF background and pick lines from it.';
    else if (this._tool === 'draw') t = 'Click each intersection point; corners get a tangent arc at the bend radius. Double-click or Enter to finish, Backspace removes the last point, Esc cancels.';
    else if (this._tool === 'kerbs') t = this._kerbDraft ? 'Now trace the other kerb (Enter / double-click to finish).' : 'Trace the first kerb (Enter / double-click to finish), then the other one.';
    else if (this._tool === 'pick') t = this._kerbDraft ? 'Click the other kerb line.' : 'Click a DXF line: connected pieces on its layer are joined.';
    else if (this._tool === 'addpole') t = 'Click beside the road: the pole goes on the nearest pole line.';
    else if (this._tool === 'feed') t = this._feedDraft ? 'Click each bend of the feeder cable, then click the pole it feeds (or Enter to feed the nearest end). Backspace removes the last bend, Esc cancels.' : 'Click where the kiosk or minisub stands, then the bends of its feeder cable to the road.';
    else if (this._step === 1 && this.selRoad && this.selRoad.mode === 'ip') t = 'Drag a square to move an intersection point · double-click a leg to add one · Alt-click to delete · scroll to zoom, Shift-drag or right-drag to pan, F fits.';
    else if (this._step === 2) t = 'Drag a pole along its kerb · Alt-drag moves it off the pole line · Delete removes the selected pole.';
    el.textContent = t;
    el.style.display = t ? '' : 'none';
  },

  renderRail() {
    const el = document.getElementById('rp-roads');
    if (!el) return;
    const res = this._res && this._res.roads ? this._res.roads : [];
    el.innerHTML = this.roads.map(r => {
      const g = this.geom(r), des = this._design(r), rr = res.find(x => x.id === r.id);
      const badge = rr && !this._resStale ? (rr.pass === null ? '' : rr.pass ? '<span class="sl-badge ok">✓</span>' : '<span class="sl-badge bad">✗</span>') : '';
      return `<button class="sl-rail-item${r.id === this._selRoad ? ' active' : ''}" data-rp-road="${escHtml(r.id)}">
        <span class="sl-rail-row"><span class="sl-rail-name">${escHtml(r.name)}</span>${badge}</span>
        <span class="sl-rail-meta">${this._fmt(g.al.length, 1)} m · ${des ? escHtml(des.name) : '<i>no design</i>'} · ${(r.poles || []).length} poles</span></button>`;
    }).join('') || '<div class="sl-empty">No roads yet.</div>';
    const bgEl = document.getElementById('rp-bg');
    const bg = this.rp.bg;
    bgEl.innerHTML = bg ? `<div class="rp-bg-name">${escHtml(bg.name)} <span class="sl-hint">${bg.ents.length} lines</span></div>
      <details class="rp-layers"><summary>Layers (${bg.layers.length})</summary>${bg.layers.map((l, i) => `<label class="rp-layer"><input type="checkbox" data-rp-layer="${i}"${l.hidden ? '' : ' checked'}><i style="background:${escHtml(l.color)}"></i>${escHtml(l.name)}</label>`).join('')}</details>
      <div class="rp-bg-actions"><button class="btn-small" data-rp="bg">Replace…</button>${this._sitePlanDxfs().length ? '<button class="btn-small" data-rp="bg-site" title="Use a drawing already on the site plan">From site plan…</button>' : ''}<button class="btn-small" data-rp="bg-remove">Remove</button></div>`
      : `${this._sitePlanDxfs().length ? '<button class="btn-small btn-primary" data-rp="bg-site" title="Use a drawing already on the site plan">Use the site plan…</button> ' : ''}<button class="btn-small" data-rp="bg">Load a DXF…</button><div class="sl-hint">A site plan or survey in the background; pick road lines from it.</div>`;
    const jEl = document.getElementById('rp-junctions');
    const juncs = this.junctions();
    const opts = this._standard() === 'SANS' ? RP_CONFLICT_SANS : RP_CONFLICT_EN;
    jEl.innerHTML = juncs.length ? juncs.map(j => {
      const cls = this._junctionCls(j);
      const ca = this._res && this._res.conflictAreas ? this._res.conflictAreas.find(c => c.id === j.key) : null;
      return `<div class="rp-junc"><span><b>${j.name}</b> ${escHtml((this.road(j.main) || {}).name || '')} × ${escHtml((this.road(j.side) || {}).name || '')}</span>
        <span class="rp-junc-row"><select data-rp-jcls="${escHtml(j.key)}" aria-label="Lighting class of ${j.name}">${opts.map(c => `<option${c === cls ? ' selected' : ''}>${c}</option>`).join('')}</select>
        ${ca && !this._resStale ? (ca.pass ? '<span class="sl-badge ok">✓</span>' : ca.pass === false ? '<span class="sl-badge bad">✗</span>' : '') : ''}</span></div>`;
    }).join('') : '<div class="sl-hint">None. A road whose end lies on another road, or two crossing centrelines, make a junction — lit as a conflict area.</div>';
  },

  renderToolbar() {
    const el = document.getElementById('rp-toolbar');
    if (!el) return;
    const b = (tool, label, title) => `<button class="btn-small${this._tool === tool ? ' active' : ''}" data-rp-tool="${tool}" title="${escHtml(title)}">${label}</button>`;
    const r = this.selRoad;
    let html = '';
    if (this._view3d) {
      html = Road3D.toolbarHtml();
    } else if (this._step === 1) {
      html = `${b('select', 'Select', 'Select a road, drag its intersection points')}${b('draw', 'Draw centreline', 'Click intersection points; corners are rounded with tangent arcs')}${b('kerbs', 'Trace kerbs', 'Trace both kerbs: the carriageway width follows them')}
        ${this.rp.bg ? b('pick', 'From DXF', 'Pick a centreline or two kerbs from the background drawing') : ''}
        <span class="sl-sep"></span>
        <label class="rl-inline" title="Radius of the tangent arc at each corner of a drawn centreline (a corner can override it)">Bend radius<span class="sl-unit"><input type="number" min="0" step="5" class="sl-in-num" data-rp-road-f="radius" value="${escHtml(r ? (r.radius ?? 50) : 50)}"${r && r.mode === 'ip' ? '' : (r ? ' disabled' : '')}> m</span></label>
        <label class="rl-inline"><input type="checkbox" data-rp="snap"${this._snap ? ' checked' : ''}> Snap</label>`;
    } else if (this._step === 2) {
      html = `${b('select', 'Select / drag', 'Select and drag poles')}${b('addpole', 'Add pole', 'Click beside a road to add a pole on the nearest pole line')}${b('feed', 'Feed point', 'Place the kiosk / minisub and draw its feeder cable to the selected road')}
        <button class="btn-small" data-rp="delpole"${this._selPole ? '' : ' disabled'}>Delete pole</button>
        <span class="sl-sep"></span>
        <button class="btn-small" data-rp="relayout" title="Lay the selected road's poles out again from the rules">Lay out again</button>
        <button class="btn-small" data-rp="relayout-all" title="Every road">All roads</button>`;
    } else {
      const std = this._standard();
      html = `<span class="sl-view-toggle" role="group" aria-label="Quantity"><button class="${this._qty === 'E' ? 'active' : ''}" data-rp-qty="E">Illuminance</button><button class="${this._qty === 'L' ? 'active' : ''}" data-rp-qty="L">Luminance</button></span>
        <label class="rl-inline"><input type="checkbox" data-rp="iso"${this._showIso ? ' checked' : ''}> Iso-lines</label>
        <label class="rl-inline"><input type="checkbox" data-rp="seg"${this._showSeg ? ' checked' : ''}> Segments</label>
        <span class="sl-sep"></span>
        <label class="rl-inline" title="Standard the plan is checked against">Standard<select data-rp-set="standard"><option value="SANS"${std === 'SANS' ? ' selected' : ''}>SANS 10098</option><option value="EN"${std === 'EN' ? ' selected' : ''}>EN 13201</option></select></label>
        <label class="rl-inline" title="Maintenance factor">MF<input type="number" step="0.01" min="0.05" max="1" class="sl-in-num" data-rp-set="mf" value="${this._mf()}"></label>
        <button class="btn-small btn-primary" data-rp="calc">${this._busy ? 'Calculating…' : 'Recalculate'}</button>`;
    }
    const v3 = this._view3d;
    html += `<span class="rp-tb-right"><button class="btn-small" data-rp="undo" title="Undo (Ctrl+Z)"${this._undo.length ? '' : ' disabled'}>Undo</button><button class="btn-small" data-rp="redo" title="Redo (Ctrl+Y)"${this._redo.length ? '' : ' disabled'}>Redo</button>${v3 ? '' : '<button class="btn-small" data-rp="fit" title="Fit the plan (F)">Fit</button>'}
      ${typeof Road3D !== 'undefined' ? `<span class="sl-view-toggle" role="group" aria-label="View"><button class="${v3 ? '' : 'active'}" data-rp-view="plan" aria-pressed="${!v3}">Plan</button><button class="${v3 ? 'active' : ''}" data-rp-view="3d" aria-pressed="${v3}">3D</button></span>` : ''}</span>`;
    el.innerHTML = html;
  },

  // Roads, background, heatmap and iso-lines in world coordinates.
  renderWorld() {
    if (!this._built) return;
    const ns = 'non-scaling-stroke';
    // background
    const bg = this.rp.bg;
    const bgEl = document.getElementById('rp-w-bg');
    if (bg) {
      const byLayer = new Map();
      for (const e of this._bgVisible()) {
        let d = `M${+e.p[0]} ${+e.p[1]}`;
        for (let i = 2; i < e.p.length; i += 2) d += `L${+e.p[i]} ${+e.p[i + 1]}`;
        if (e.c) d += 'Z';
        if (!byLayer.has(e.l)) byLayer.set(e.l, []);
        byLayer.get(e.l).push(d);
      }
      const col = new Map(bg.layers.map(l => [l.name, l.color]));
      bgEl.innerHTML = [...byLayer].map(([l, ds]) => `<path d="${ds.join('')}" fill="none" stroke="${escHtml(col.get(l) || '#8a8f98')}" stroke-width="1" vector-effect="${ns}" class="rp-bgline"/>`).join('');
    } else bgEl.innerHTML = '';
    // road strips
    const out = [], lines = [];
    for (const r of this.roads) {
      const g = this.geom(r);
      if (!g.al.ok) continue;
      const L = g.al.length;
      const n = Math.max(2, Math.ceil(L / 1));
      const ss = []; for (let k = 0; k <= n; k++) ss.push(L * k / n);
      for (const sec of g.xs.lay.secs) {
        if (!(sec.width > 0)) continue;
        const a = ss.map(s => g.al.at(s, g.xs.off(s, sec.y0))), b = ss.map(s => g.al.at(s, g.xs.off(s, sec.y1)));
        const d = 'M' + a.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + 'L' + b.reverse().map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + 'Z';
        out.push(`<path d="${d}" fill="${RoadLight.SEC_FILL[sec.type] || 'var(--rl-verge)'}" class="rp-strip${r.id === this._selRoad ? ' sel' : ''}"/>`);
      }
      for (const y of [g.xs.kl, g.xs.kr]) {
        const pts = ss.map(s => g.al.at(s, g.xs.off(s, y)));
        lines.push(`<path d="M${pts.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L')}" class="rp-kerb" vector-effect="${ns}"/>`);
      }
      lines.push(`<path d="M${g.al.pts.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('L')}" class="rp-cl${r.id === this._selRoad ? ' sel' : ''}" vector-effect="${ns}"/>`);
    }
    // junction conflict areas
    for (const j of this.junctions()) {
      for (const rg of this._junctionRanges(j)) {
        const poly = this._kerbPolygon(this.road(rg.road), rg.s0, rg.s1);
        lines.push(`<path d="M${poly.map(p => p.join(' ')).join('L')}Z" class="rp-conflict" vector-effect="${ns}"/>`);
      }
    }
    document.getElementById('rp-w-roads').innerHTML = out.join('');
    document.getElementById('rp-w-lines').innerHTML = lines.join('');
    this._renderHeat();
  },

  _grids() {
    if (this._step !== 3 || !this._res || !this._res.roads || this._resStale) return [];
    return this._res.roads.map(r => r.display).filter(Boolean);
  },
  _vmax() {
    let m = 0;
    for (const g of this._grids()) for (const row of g[this._qty]) for (const v of row || []) if (v !== null && v > m) m = v;
    return m || 1;
  },
  _colour(t) {
    const c = RP_RAMP, x = Math.max(0, Math.min(1, t)) * (c.length - 1), i = Math.min(c.length - 2, Math.floor(x)), f = x - i;
    const h = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const a = h(c[i]), b = h(c[i + 1]);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  },
  _renderHeat() {
    const img = document.getElementById('rp-w-heat');
    const iso = document.getElementById('rp-w-iso');
    const leg = document.getElementById('rp-legend');
    const grids = this._grids();
    if (!grids.length) { img.setAttribute('href', ''); img.style.display = 'none'; iso.innerHTML = ''; leg.innerHTML = ''; leg.style.display = 'none'; return; }
    const q = this._qty;
    const vmax = this._vmax();
    const key = `${q}:${grids.length}:${vmax}`;
    if (this._heatKey !== key) {
      this._heatKey = key;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const g of grids) for (const row of g.x) for (const v of row) { x0 = Math.min(x0, v); x1 = Math.max(x1, v); }
      for (const g of grids) for (const row of g.y) for (const v of row) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
      const span = Math.max(x1 - x0, y1 - y0, 1);
      const res = Math.max(0.5, Math.min(8, 2400 / span));      // px per metre
      const cv = document.createElement('canvas');
      cv.width = Math.ceil((x1 - x0) * res) + 2; cv.height = Math.ceil((y1 - y0) * res) + 2;
      const ctx = cv.getContext('2d');
      ctx.setTransform(res, 0, 0, res, -x0 * res + 1, -y0 * res + 1);
      for (const g of grids) {
        const V = g[q];
        if (!V) continue;
        for (let i = 0; i < g.x.length - 1; i++) {
          for (let j = 0; j < g.x[i].length - 1; j++) {
            const v = [V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1]];
            if (v.some(x => x === null)) continue;
            ctx.fillStyle = this._colour((v[0] + v[1] + v[2] + v[3]) / 4 / vmax);
            ctx.beginPath();
            ctx.moveTo(g.x[i][j], g.y[i][j]); ctx.lineTo(g.x[i + 1][j], g.y[i + 1][j]);
            ctx.lineTo(g.x[i + 1][j + 1], g.y[i + 1][j + 1]); ctx.lineTo(g.x[i][j + 1], g.y[i][j + 1]);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6 / res; ctx.stroke();   // no hairline gaps
          }
        }
      }
      img.setAttribute('href', cv.toDataURL('image/png'));
      img.setAttribute('x', x0 - 1 / res); img.setAttribute('y', y0 - 1 / res);
      img.setAttribute('width', cv.width / res); img.setAttribute('height', cv.height / res);
      // canvas row 0 is the lowest y — in the y-up world group that is already the right way up
    }
    img.style.display = '';
    const levels = q === 'E' ? RoadLight._levels(vmax) : [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3].filter(v => v < vmax).slice(-5);
    iso.innerHTML = this._showIso ? levels.map(lv => this._isoPath(grids, q, lv)).join('') : '';
    const unit = q === 'E' ? 'lx' : 'cd/m²';
    leg.style.display = '';
    leg.innerHTML = `<b>${q === 'E' ? 'Illuminance, maintained' : 'Luminance (each point seen from 60 m back in its lane)'}</b>
      <div class="rp-ramp" style="background:linear-gradient(90deg,${RP_RAMP.join(',')})" role="img" aria-label="Colour scale 0 to ${this._fmt(vmax, 1)} ${unit}"></div>
      <div class="rp-ramp-ax"><span>0</span><span>${this._fmt(vmax / 2, q === 'E' ? 1 : 2)}</span><span>${this._fmt(vmax, q === 'E' ? 1 : 2)} ${unit}</span></div>
      ${this._showIso ? `<div class="sl-hint">Lines at ${levels.map(v => +v.toFixed(2)).join(', ')} ${unit}</div>` : ''}`;
  },
  // Marching squares on each road's (chainage × across) grid, mapped to the plan.
  _isoPath(grids, q, lv) {
    const segs = [];
    for (const g of grids) {
      const V = g[q];
      if (!V) continue;
      const P = (i, j) => [g.x[i][j], g.y[i][j]];
      const lerp = (a, b, va, vb) => { const t = (lv - va) / ((vb - va) || 1e-12); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
      for (let i = 0; i < g.x.length - 1; i++) {
        for (let j = 0; j < g.x[i].length - 1; j++) {
          const v = [V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1]];
          if (v.some(x => x === null)) continue;
          const c = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
          const pts = [];
          for (let k = 0; k < 4; k++) { const m = (k + 1) % 4; if ((v[k] < lv) !== (v[m] < lv)) pts.push(lerp(c[k], c[m], v[k], v[m])); }
          for (let k = 0; k + 1 < pts.length; k += 2) segs.push(`M${pts[k][0].toFixed(2)} ${pts[k][1].toFixed(2)}L${pts[k + 1][0].toFixed(2)} ${pts[k + 1][1].toFixed(2)}`);
        }
      }
    }
    return segs.length ? `<path d="${segs.join('')}" class="rp-iso" vector-effect="non-scaling-stroke"/>` : '';
  },

  // Poles, handles, labels, the draft line, grid and scale bar (screen px).
  renderScreen() {
    const el = document.getElementById('rp-screen');
    if (!el) return;
    const { W, H } = this._size();
    const S = (x, y) => this.toScreen(x, y);
    const out = [];
    // light reference grid
    const v = this._view;
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const step = steps.find(s => s * v.z >= 60) || 5000;
    const [wx0, wy1] = this.toWorld(0, 0), [wx1, wy0] = this.toWorld(W, H);
    const gl = [];
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const sx = S(x, 0)[0]; gl.push(`M${sx.toFixed(1)} 0V${H}`); }
    for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) { const sy = S(0, y)[1]; gl.push(`M0 ${sy.toFixed(1)}H${W}`); }
    out.push(`<path d="${gl.join('')}" class="rp-grid"/>`);
    // segment ticks + labels
    if (this._showSeg || this._step !== 3) {
      const juncs = this.junctions();
      for (const r of this.roads) {
        const g = this.geom(r);
        if (!g.al.ok) continue;
        const segs = this.segments(r, juncs);
        const res = this._res && this._res.roads && !this._resStale ? (this._res.roads.find(x => x.id === r.id) || {}).segments || [] : [];
        for (const sg of segs) {
          for (const s of [sg.s0, sg.s1]) {
            const a = g.al.at(s, g.xs.off(s, 0) - 0.5), b = g.al.at(s, g.xs.off(s, g.xs.width) + 0.5);
            const [ax, ay] = S(a.x, a.y), [bx, by] = S(b.x, b.y);
            out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="rp-tick"/>`);
          }
          const sm = (sg.s0 + sg.s1) / 2;
          const p = g.al.at(sm, g.xs.off(sm, 0) - 3 / v.z * 8 - 2);
          const [px, py] = S(p.x, p.y);
          const rs = res.find(x => x.id === sg.id);
          const cls = rs ? (rs.pass ? ' ok' : ' bad') : '';
          if (v.z > 0.6) out.push(`<g class="rp-seglab${cls}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)})"><rect x="-14" y="-9" width="28" height="18" rx="4"/><text text-anchor="middle" y="4">${sg.name}</text></g>`);
        }
        // direction of chainage
        const m = g.al.at(g.al.length * 0.5);
        const [mx, my] = S(m.x, m.y), ang = Math.atan2(-m.ty, m.tx) * 180 / Math.PI;
        out.push(`<path d="M-6 -5L6 0L-6 5" class="rp-dir" transform="translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`);
      }
      for (const j of juncs) {
        const [jx, jy] = S(j.x, j.y);
        const ca = this._res && this._res.conflictAreas && !this._resStale ? this._res.conflictAreas.find(c => c.id === j.key) : null;
        if (v.z > 0.4) out.push(`<g class="rp-seglab junc${ca ? (ca.pass ? ' ok' : ' bad') : ''}" transform="translate(${jx.toFixed(1)} ${(jy - 22).toFixed(1)})"><rect x="-14" y="-9" width="28" height="18" rx="4"/><text text-anchor="middle" y="4">${j.name}</text></g>`);
      }
    }
    // IP handles of the selected road
    const sr = this.selRoad;
    if (this._step === 1 && sr && sr.mode === 'ip' && this._tool === 'select') {
      const ip = sr.ip || [];
      out.push(`<path d="M${ip.map(q => S(q.x, q.y).map(t => t.toFixed(1)).join(' ')).join('L')}" class="rp-ipline"/>`);
      ip.forEach(q => { const [x, y] = S(q.x, q.y); out.push(`<rect x="${x - 5}" y="${y - 5}" width="10" height="10" class="rp-ip"/>`); });
    }
    // poles
    if (v.z > 0.25) {
      for (const r of this.roads) {
        const names = this._poleNames(r);
        for (const p of r.poles || []) {
          const g = this.poleGeom(r, p);
          if (!g) continue;
          const [bx, by] = S(g.bx, g.by), [hx, hy] = S(g.hx, g.hy);
          const sel = p.id === this._selPole;
          const ang = Math.atan2(-g.ay, g.ax) * 180 / Math.PI;
          out.push(`<g class="rp-pole${sel ? ' sel' : ''}${p.moved ? ' moved' : ''}${p.note && p.note.startsWith('bend') ? ' bend' : ''}">
            <line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}"/>
            <circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${sel ? 5 : 3.6}"/>
            <rect x="-2" y="-5" width="6" height="10" transform="translate(${hx.toFixed(1)} ${hy.toFixed(1)}) rotate(${ang.toFixed(1)})" class="rp-head"/>
            ${v.z > 1.5 && this._step === 2 ? `<text x="${(bx - (hx - bx) * 1.6).toFixed(1)}" y="${(by - (hy - by) * 1.6 + 3).toFixed(1)}" text-anchor="middle" class="rp-plab">${names.get(p.id)}</text>` : ''}</g>`);
        }
      }
    }
    // kerb picked so far / picked DXF chain
    const poly = (pts, cls) => pts && pts.length > 1 ? `<path d="M${pts.map(q => S(q[0], q[1]).map(t => t.toFixed(1)).join(' ')).join('L')}" class="${cls}"/>` : '';
    if (this._kerbDraft) out.push(poly(this._kerbDraft.a, 'rp-draft done'));
    if (this._picked) {
      out.push(poly(this._picked, 'rp-picked'));
      for (const g of (this._pickGaps || [])) out.push(poly(g, 'rp-gap'));
      for (const mk of (this._trim || [])) { const [mx, my] = S(mk.pt[0], mk.pt[1]); out.push(`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="5" class="rp-mark"/>`); }
    }
    // draft
    if (this._draft && this._draft.length) {
      const pts = this._draft.slice();
      if (this._hover) pts.push(this._snapPt(this._hover.wx, this._hover.wy));
      if (this._tool === 'draw' && pts.length > 2) {
        const f = this._fillet(pts.map(q => ({ x: q[0], y: q[1] })), this.selRoad ? this._num(this.selRoad.radius, 50) : 50);
        out.push(poly(f.pts, 'rp-draft arc'));
      }
      out.push(poly(pts, 'rp-draft'));
      this._draft.forEach(q => { const [x, y] = S(q[0], q[1]); out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" class="rp-ip"/>`); });
    }
    if (this._step === 2) this._drawCircuitCables(S, out);
    // scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const len = nice.find(n => n * v.z >= 70) || 5000;
    out.push(`<g class="rp-scale" transform="translate(${W - len * v.z - 16} ${H - 18})"><path d="M0 -6V0H${(len * v.z).toFixed(1)}V-6"/><text x="${(len * v.z / 2).toFixed(1)}" y="-9" text-anchor="middle">${len} m</text></g>`);
    el.innerHTML = out.join('');
  },

  _readout() {
    const el = document.getElementById('rp-readout');
    if (!el) return;
    const h = this._hover;
    const grids = this._grids();
    if (!h || !grids.length) { el.style.display = 'none'; return; }
    let best = null, bd = 1.0;
    for (const g of grids) {
      const V = g[this._qty];
      for (let i = 0; i < g.x.length; i++) {
        for (let j = 0; j < g.x[i].length; j++) {
          const d = Math.hypot(g.x[i][j] - h.wx, g.y[i][j] - h.wy);
          if (d < bd && V[i][j] !== null) { bd = d; best = { v: V[i][j], s: g.s[i], road: g.roadId }; }
        }
      }
    }
    if (!best) { el.style.display = 'none'; return; }
    const r = this.road(best.road);
    el.style.display = '';
    el.innerHTML = `<b class="sl-mono">${this._fmt(best.v, this._qty === 'E' ? 1 : 2)} ${this._qty === 'E' ? 'lx' : 'cd/m²'}</b><span>${escHtml(r ? r.name : '')} · ch ${this._fmt(best.s, 1)} m</span>`;
  },

  // ─── Right panel per step ────────────────────────────────────────────
  renderPanel() {
    const el = document.getElementById('rp-panel');
    if (!el) return;
    if (this._view3d) el.innerHTML = Road3D.panelHtml();
    else if (this._step === 1) el.innerHTML = this._panelShape();
    else if (this._step === 2) el.innerHTML = this._panelPoles();
    else el.innerHTML = this._panelResults();
    this.renderToolbar();
  },
  _xsBar(des) {
    const lay = RoadLight._layout(des);
    return `<div class="rp-xs" role="img" aria-label="Cross-section, left to right looking up the chainage">${lay.secs.filter(s => s.width > 0).map(s =>
      `<div style="flex:${s.width};background:${RoadLight.SEC_FILL[s.type] || 'var(--rl-verge)'}" class="rp-xs-s ${s.type}" title="${escHtml((s.name || RoadLight._secName(s, des)) + ' ' + s.width + ' m' + (s.cls ? ' · ' + s.cls : ''))}"><span>${this._fmt(s.width, 1)}${s.cls ? ' · ' + escHtml(s.cls) : ''}</span></div>`).join('')}</div>`;
  },
  _panelShape() {
    const r = this.selRoad;
    if (!r) return `<div class="sl-empty"><h3>Road plan</h3><p>Draw the road's centreline on the plan — straights joined by tangent arcs — or trace both kerbs, or load a DXF site plan and pick its centreline. The cross-section of a Lighting design is swept along it.</p><p><button class="btn-small btn-primary" data-rp-tool="draw">Draw centreline</button></p></div>`;
    const g = this.geom(r), des = this._design(r);
    const opts = RoadLight.designs.map(d => `<option value="${escHtml(d.id)}"${d.id === r.designId ? ' selected' : ''}>${escHtml(d.name)}</option>`).join('');
    let align = '';
    if (r.mode === 'ip' && g.els) {
      let k = 0;
      align = `<table class="rl-table"><thead><tr><th>#</th><th>Element</th><th>Length m</th><th>Radius m</th><th>Turn</th></tr></thead><tbody>${g.els.map(e => {
        k++;
        if (e.type === 'line') return `<tr><td>${k}</td><td>Straight</td><td class="sl-mono">${this._fmt(e.s1 - e.s0, 1)}</td><td>—</td><td>—</td></tr>`;
        const v = r.ip[e.vertex];
        return `<tr><td>${k}</td><td>Arc</td><td class="sl-mono">${this._fmt(e.s1 - e.s0, 1)}</td><td><input type="number" min="0" step="5" class="sl-in-num" data-rp-ipr="${e.vertex}" value="${escHtml(v.r ?? '')}" placeholder="${Math.round(e.R)}" aria-label="Radius at corner ${e.vertex}"></td><td>${this._fmt(e.turn, 0)}° ${e.dir}</td></tr>`;
      }).join('')}</tbody><tfoot><tr><td></td><td><b>Total</b></td><td class="sl-mono"><b>${this._fmt(g.al.length, 1)}</b></td><td></td><td></td></tr></tfoot></table>
      <div class="sl-hint">A blank radius takes the road's bend radius; a radius that does not fit between two corners is reduced.</div>`;
    } else {
      const runs = g.al.ok ? this._shapeRuns(r, g) : [];
      align = `<div class="sl-hint">${r.mode === 'kerbs' ? 'Centreline midway between the traced kerbs; the carriageway width follows them' + (g.kerbWidth ? ` (${this._fmt(Math.min(...g.kerbWidth.map(w => w[1])), 1)}–${this._fmt(Math.max(...g.kerbWidth.map(w => w[1])), 1)} m)` : '') : 'Centreline from the DXF'} · ${this._fmt(g.al.length, 1)} m</div>
        <table class="rl-table"><thead><tr><th>Shape</th><th>Chainage m</th><th>Radius m</th></tr></thead><tbody>${runs.map(x => `<tr><td>${x.kind === 'bend' ? 'Bend ' + x.dir : 'Straight'}</td><td class="sl-mono">${this._fmt(x.s0, 1)} – ${this._fmt(x.s1, 1)}</td><td class="sl-mono">${x.radius ? Math.round(x.radius) : '—'}</td></tr>`).join('')}</tbody></table>`;
    }
    const juncs = this.junctions().filter(j => j.main === r.id || j.side === r.id);
    return `<div class="rp-pane">
      <label class="rp-field">Name<input data-rp-road-f="name" value="${escHtml(r.name)}"></label>
      <div class="rp-block"><div class="rp-block-h"><b>Cross-section</b><button class="btn-small" data-rp="edit-design"${des ? '' : ' disabled'}>Edit in Lighting design</button></div>
        <label class="rp-field">From design<select data-rp-road-f="designId">${des ? '' : '<option value="" selected>— pick a design —</option>'}${opts}</select></label>
        ${des ? this._xsBar(des) : '<div class="sl-hint">Lighting design holds the strips, classes and luminaire rows.</div>'}
        <div class="sl-hint">Left to right looking up the chainage (the arrow on the road). Swept at right angles to the centreline.</div></div>
      <div class="rp-block"><div class="rp-block-h"><b>Alignment</b><span class="sl-hint">${r.mode === 'ip' ? 'drawn' : r.mode === 'kerbs' ? 'traced kerbs' : 'DXF'}</span></div>${align}</div>
      <div class="rp-block"><div class="rp-block-h"><b>Junctions on this road</b></div>${juncs.length ? juncs.map(j => `<div class="rp-junc-line"><b>${j.name}</b> · ch ${this._fmt(j.main === r.id ? j.sMain : j.sSide, 1)} · ${escHtml((this.road(j.main === r.id ? j.side : j.main) || {}).name || '')} <span class="rl-cls">${escHtml(this._junctionCls(j))}</span></div>`).join('') : '<div class="sl-hint">None.</div>'}</div>
      <div class="rp-actions"><button class="btn-small" data-rp="reverse" title="Run the chainage the other way (the cross-section turns round)">Reverse direction</button><button class="btn-small" data-rp="delroad">Delete road</button>
        <button class="btn-small btn-primary" data-rp-step="2">Next: poles →</button></div></div>`;
  },
  _panelPoles() {
    const r = this.selRoad;
    if (!r) return '<div class="sl-empty">Draw a road first.</div>';
    const des = this._design(r);
    if (!des) return '<div class="sl-empty">Pick a lighting design for this road (step 1).</div>';
    const cfg = this._layoutCfg(r);
    const names = this._poleNames(r);
    const poles = (r.poles || []).slice().sort((a, b) => a.s - b.s);
    const lastBy = new Map();
    const rows = poles.map(p => {
      const g = this.poleGeom(r, p);
      const key = g ? g.side : '?';
      const prev = lastBy.get(key);
      lastBy.set(key, g);
      const gap = prev && g ? Math.hypot(g.bx - prev.bx, g.by - prev.by) : null;
      return `<tr class="${p.id === this._selPole ? 'sel' : ''}" data-rp-pole="${escHtml(p.id)}"><td>${names.get(p.id)}</td><td class="sl-mono">${this._fmt(p.s, 1)}</td><td>${g ? g.side : '—'}</td><td class="sl-mono">${gap ? this._fmt(gap, 1) : '—'}</td><td>${p.moved ? '<span class="rp-tag edit">moved</span>' : ''}${p.note && p.note.startsWith('bend') ? `<span class="rp-tag bend">${escHtml(p.note)}</span>` : ''}${p.over && Object.keys(p.over).length ? '<span class="rp-tag edit">own settings</span>' : ''}</td></tr>`;
    }).join('');
    const sel = poles.find(p => p.id === this._selPole);
    let selHtml = '';
    if (sel) {
      const g = this.poleGeom(r, sel), o = sel.over || {};
      const row = this._row(r, sel);
      const lib = RoadLight._libList().map(p => `<option value="${escHtml(p.id)}"${p.id === (o.photometryId || '') ? ' selected' : ''}>${escHtml(RoadLight._lumLabel(p))}</option>`).join('');
      const f = (k, label, step) => `<label class="rp-field">${label}<input type="number" step="${step}" data-rp-pf="${k}" value="${escHtml(o[k] ?? '')}" placeholder="${escHtml(row[k] ?? '')}"></label>`;
      selHtml = `<div class="rp-block rp-selpole"><div class="rp-block-h"><b>${names.get(sel.id)}</b><span class="sl-hint">${g ? g.side === 'L' ? 'left' : 'right' : ''} · offset ${g ? this._fmt(g.d, 2) : '—'} m</span></div>
        <div class="rp-grid2"><label class="rp-field">Chainage m<input type="number" step="0.5" data-rp-pf="s" value="${this._fmt(sel.s, 2)}"></label>
        ${f('height', 'Height m', 0.5)}${f('overhang', 'Overhang m', 0.1)}${f('tilt', 'Tilt °', 1)}${f('fluxPct', 'Flux %', 5)}
        <label class="rp-field rp-span2">Luminaire<select data-rp-pf="photometryId"><option value="">Row default</option>${lib}</select></label></div>
        <div class="sl-hint">Blank fields follow the design's row. Height, tilt and luminaire here apply to this pole only.</div>
        <div class="rp-actions"><button class="btn-small" data-rp="pole-reset">Reset to the row</button><button class="btn-small" data-rp="delpole">Delete</button></div></div>`;
    }
    return `<div class="rp-pane">
      <div class="rp-block"><div class="rp-block-h"><b>Layout rules</b><span class="sl-hint">${escHtml(des.name)} · ${des.rows.length} row${des.rows.length === 1 ? '' : 's'}</span></div>
        <div class="rp-grid2">
          <label class="rp-field" title="Distance between consecutive poles of one row, measured along its pole line">Spacing m<input type="number" step="0.5" min="2" data-rp-lay="spacing" value="${escHtml(cfg.spacing)}"></label>
          <label class="rp-field" title="Where the first pole of each row stands (plus the row's offset × spacing)">First pole at m<input type="number" step="0.5" min="0" data-rp-lay="start" value="${escHtml(cfg.start)}"></label>
          <label class="rp-field" title="Bends tighter than this radius take a closer spacing">Bend tighter than R m<input type="number" step="5" min="1" data-rp-lay="bendR" value="${escHtml(cfg.bendR)}"></label>
          <label class="rp-field" title="Spacing on those bends as a fraction of the straight spacing">Spacing there ×<input type="number" step="0.05" min="0.3" max="1" data-rp-lay="bendFactor" value="${escHtml(cfg.bendFactor)}"></label>
          <label class="rp-field" title="Extra clearance either side of a junction mouth">Junction clearance m<input type="number" step="0.5" min="0" data-rp-lay="keepClear" value="${escHtml(cfg.keepClear)}"></label>
        </div>
        <label class="rp-check"><input type="checkbox" data-rp-lay="outsideOnly"${cfg.outsideOnly ? ' checked' : ''}> On those bends, only the row on the outside of the bend</label>
        <div class="sl-hint">Mounting height, overhang, tilt and luminaire come from the design's rows (${escHtml(des.name)}: max passing spacing on a straight is found there with <i>Find max spacing</i>).</div>
        <div class="rp-actions"><button class="btn-small btn-primary" data-rp="relayout">Lay out again</button><label class="rl-inline"><input type="checkbox" data-rp="keepmoved"${this._keepMoved === false ? '' : ' checked'}> Keep poles I moved</label></div></div>
      ${selHtml}
      ${this._panelFeed(r)}
      <div class="rp-block"><div class="rp-block-h"><b>Pole schedule · ${poles.length}</b><button class="btn-small" data-rp="circuit" title="Create or update street-lighting circuits and their cables from the road plan">Circuits and cables…</button></div>
        <div class="rp-sched"><table class="rl-table"><thead><tr><th>Pole</th><th>Ch m</th><th>Side</th><th title="To the previous pole on the same side">Gap m</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="rp-actions"><button class="btn-small" data-rp-step="1">← Road shape</button><button class="btn-small btn-primary" data-rp-step="3">Calculate the light →</button></div></div>`;
  },
  _chips(checks) {
    return (checks || []).map(c => `<span class="rp-chip ${c.pass ? 'ok' : 'bad'}" title="Required ${c.op === '>=' ? '≥' : '≤'} ${c.req} ${escHtml(c.unit || '')}">${escHtml(c.label)} ${this._fmt(c.value, c.key === 'TI' ? 1 : 2)}</span>`).join('');
  },
  _panelResults() {
    const res = this._res;
    if (this._busy && !res) return '<div class="sl-empty">Calculating…</div>';
    if (!res) return '<div class="sl-empty">Press Recalculate.</div>';
    if (res.problems) return `<div class="sl-empty">${res.problems.map(escHtml).join('<br>')}</div>`;
    if (res.error) return `<div class="sl-empty rl-err">${escHtml(res.error)}</div>`;
    const stale = this._resStale ? '<div class="sl-hint rp-stale">The plan changed since this was calculated.</div>' : '';
    const nFail = res.roads.reduce((n, r) => n + r.segments.filter(s => !s.pass).length, 0) + res.conflictAreas.filter(c => c.pass === false).length;
    const roadsHtml = res.roads.map(r => `<div class="rp-block"><div class="rp-block-h"><b>${escHtml(r.name)}</b><span class="sl-hint">${this._fmt(r.length, 1)} m · ${r.energy.luminaires} luminaires · ${r.energy.wPerKm === null ? '—' : Math.round(r.energy.wPerKm).toLocaleString()} W/km</span></div>
      <table class="rl-table rp-res"><thead><tr><th>Seg</th><th>Chainage m</th><th>Shape</th><th>Strip · class · results</th></tr></thead><tbody>${r.segments.map(s => `
        <tr class="${s.pass ? '' : 'bad'}"><td><b>${escHtml(s.name)}</b> ${s.pass ? '<span class="rl-ok">✓</span>' : '<span class="rl-bad">✗</span>'}</td><td class="sl-mono">${this._fmt(s.s0, 1)}–${this._fmt(s.s1, 1)}</td><td>${s.kind === 'bend' ? `Bend R${s.radius ? Math.round(s.radius) : '?'}` : 'Straight'}${s.fields > 1 ? ` <span class="sl-hint">${s.fields} fields</span>` : ''}</td>
          <td>${s.strips.filter(x => x.checks.length).map(x => `<div class="rp-strip-res"><span class="rp-strip-n">${escHtml(x.name)} <span class="rl-cls">${escHtml(x.cls)}</span></span>${this._chips(x.checks)}</div>`).join('') || '<span class="sl-hint">no classes set</span>'}</td></tr>`).join('')}</tbody></table>
      ${r.segments.some(s => s.bend && s.strips.some(x => x.Lav !== undefined)) ? '<div class="sl-hint">On a bend the luminance criteria (L̄, Uo, Ul, TI) are indicative: EN 13201-3 / CIE 140 define them for a straight road. Tight bends are often designed to a C class on illuminance instead.</div>' : ''}</div>`).join('');
    const ca = res.conflictAreas.length ? `<div class="rp-block"><div class="rp-block-h"><b>Junctions (conflict areas)</b></div>
      <table class="rl-table rp-res"><thead><tr><th></th><th>Class</th><th>Results</th></tr></thead><tbody>${res.conflictAreas.map(c => `<tr class="${c.pass === false ? 'bad' : ''}"><td><b>${escHtml(c.name)}</b></td><td><span class="rl-cls">${escHtml(c.cls)}</span></td><td>${c.checks.length ? this._chips(c.checks) : `<span class="sl-hint">Ē ${this._fmt(c.Eav, 1)} lx (class not checked)</span>`} <span class="sl-hint">${this._fmt(c.area, 0)} m²</span></td></tr>`).join('')}</tbody></table>
      <div class="sl-hint">The carriageway inside the dashed outline, on a 1 m grid, by horizontal illuminance. Change the class in the Junctions list.</div></div>` : '';
    return `<div class="rp-pane">
      <div class="rl-verdict ${res.pass === false ? 'bad' : 'ok'}">${res.pass === false ? `✗ ${nFail} segment${nFail === 1 ? '' : 's'} or junction${nFail === 1 ? '' : 's'} fail` : res.pass ? '✓ Every segment and junction meets its class' : 'No classes to check'}<span>${res.standard === 'SANS' ? 'SANS 10098-1 / -2' : 'EN 13201-2'} · MF ${this._fmt(res.mf, 2)} · fields ≤ ${res.fieldMaxM} m</span></div>
      ${stale}${roadsHtml}${ca}
      <div class="sl-hint">Each segment is split into calculation fields of at most ${res.fieldMaxM} m and reports its worst field. Light from every road counts on every road.</div></div>`;
  },

  // ─── Events ──────────────────────────────────────────────────────────
  _onClick(e) {
    const vb = e.target.closest('[data-rp-view]');
    if (vb) { this.setView3d(vb.dataset.rpView === '3d'); return; }
    if (this._view3d && Road3D.onClick(e)) return;
    const t = e.target.closest('[data-rp], [data-rp-step], [data-rp-tool], [data-rp-road], [data-rp-qty], [data-rp-pole]');
    if (!t) return;
    if (t.tagName === 'INPUT' && t.type !== 'checkbox') return;
    if (t.dataset.rpStep) { this.setStep(+t.dataset.rpStep); return; }
    if (t.dataset.rpTool) { this.setTool(t.dataset.rpTool); return; }
    if (t.dataset.rpRoad) { this._selRoad = t.dataset.rpRoad; this._selPole = null; this.render(); return; }
    if (t.dataset.rpQty) { this._qty = t.dataset.rpQty; this._heatKey = null; this.renderToolbar(); if (this._view3d) Road3D.render(); else this._renderHeat(); return; }
    if (t.dataset.rpPole) { this._selPole = t.dataset.rpPole; this.renderPanel(); this.renderScreen(); return; }
    const r = this.selRoad;
    switch (t.dataset.rp) {
      case 'bg': document.getElementById('rp-file').click(); break;
      case 'bg-site': this.useSitePlan(); break;
      case 'bg-remove': this.rp.bg = null; AppState.dirty = true; this.setTool('select'); this.render(); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'fit': this.fit(); break;
      case 'delroad': if (r) this.deleteRoad(r.id); break;
      case 'reverse': if (r) this.reverseRoad(r.id); break;
      case 'edit-design': if (r) { RoadLight._selId = r.designId; StreetLight.setView('design'); } break;
      case 'relayout': if (r) { this.layoutRoad(r, this._keepMoved !== false); this._commit(); this.render(); } break;
      case 'relayout-all': for (const x of this.roads) this.layoutRoad(x, this._keepMoved !== false); this._commit(); this.render(); break;
      case 'delpole': this.deletePole(); break;
      case 'pole-reset': if (r) { const p = r.poles.find(x => x.id === this._selPole); if (p) { delete p.over; delete p.d; this._commit(); this.render(); } } break;
      case 'circuit': this.openCircuitImport(); break;
      case 'feed-clear': this._feedClear(); break;
      case 'calc': this.recompute(0); break;
      case 'pick-cl': this._usePicked('cl'); break;
      case 'pick-k1': this._usePicked('k1'); break;
      case 'pick-k2': this._usePicked('k2'); break;
      case 'pick-trim': this._trim = []; this._pickBox(); this.renderScreen(); break;
      case 'trim-before': this._applyTrim('before'); break;
      case 'trim-after': this._applyTrim('after'); break;
      case 'trim-between': this._applyTrim('between'); break;
      case 'trim-outside': this._applyTrim('outside'); break;
      case 'trim-done': this._trim = null; this._pickBox(); this.renderScreen(); break;
      case 'pick-cancel': this._closePick(); this.renderScreen(); break;
    }
  },
  _onChange(e) {
    if (this._view3d && Road3D.onChange(e)) return;
    const t = e.target, d = t.dataset;
    const r = this.selRoad;
    if (d.rpFeed === 'pole') { if (r && r.feed) { if (t.value) r.feed.poleId = t.value; else delete r.feed.poleId; this._commit(); this.render(); } return; }
    if (d.rpFeed === 'source') { const [k, ...id] = t.value.split(':'); this._feedSrc = { kind: k, id: id.join(':') }; if (r && r.feed) { r.feed.source = this._feedSrc; this._commit(); } this.render(); return; }
    if (d.rpGap !== undefined) { this._gapTol = Math.max(0, +t.value || 0); if (this._pickSrc) this._rechain(); return; }
    if (d.rp === 'snap') { this._snap = t.checked; return; }
    if (d.rp === 'iso') { this._showIso = t.checked; this._renderHeat(); return; }
    if (d.rp === 'seg') { this._showSeg = t.checked; this.renderScreen(); return; }
    if (d.rp === 'keepmoved') { this._keepMoved = t.checked; return; }
    if (d.rpLayer !== undefined && this.rp.bg) { this.rp.bg.layers[+d.rpLayer].hidden = !t.checked; AppState.dirty = true; this.renderWorld(); return; }
    if (d.rpJcls) { this.rp.junctionCls[d.rpJcls] = t.value; this._commit(); this.renderRail(); this.renderPanel(); return; }
    if (d.rpSet) { this.rp.settings[d.rpSet] = d.rpSet === 'mf' ? this._num(t.value, 0.8) : t.value; this._commit(); this.render(); return; }
    if (!r) return;
    if (d.rpRoadF) {
      const k = d.rpRoadF;
      if (k === 'name') { r.name = t.value || r.name; this._commit(); this.renderRail(); return; }
      if (k === 'designId') { r.designId = t.value; this._geo.delete(r.id); this.layoutRoad(r, true); this._commit(); this.render(); return; }
      if (k === 'radius') { r.radius = Math.max(0, this._num(t.value, 50)); this._relayoutUnmoved(r); this._commit(); this.render(); return; }
    }
    if (d.rpIpr !== undefined) {
      const v = r.ip[+d.rpIpr];
      if (t.value === '') delete v.r; else v.r = Math.max(0, this._num(t.value, 0));
      this._relayoutUnmoved(r); this._commit(); this.render(); return;
    }
    if (d.rpLay) {
      r.layout = r.layout || {};
      const v = t.type === 'checkbox' ? t.checked : this._num(t.value, NaN);
      if (typeof v === 'number' && !isFinite(v)) delete r.layout[d.rpLay]; else r.layout[d.rpLay] = v;
      this.layoutRoad(r, this._keepMoved !== false); this._commit(); this.render(); return;
    }
    if (d.rpPf) {
      const p = r.poles.find(x => x.id === this._selPole);
      if (!p) return;
      if (d.rpPf === 's') { p.s = Math.max(0, Math.min(this.geom(r).al.length, this._num(t.value, p.s))); p.moved = true; r.poles.sort((a, b) => a.s - b.s); }
      else {
        p.over = p.over || {};
        if (t.value === '') delete p.over[d.rpPf]; else p.over[d.rpPf] = d.rpPf === 'photometryId' ? t.value : this._num(t.value, 0);
        if (!Object.keys(p.over).length) delete p.over;
      }
      this._commit(); this.render();
    }
  },
};
