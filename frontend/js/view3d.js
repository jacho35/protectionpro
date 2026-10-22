/* ProtectionPro — View3D: an orbit-camera 3D view on a 2D canvas.
 *
 * Shared by the Lighting tab's room view (light3d.js) and the Road plan's 3D
 * view (road3d.js). Orthographic projection, yaw about the vertical and pitch
 * down from the horizon; the scene is redrawn from scratch on every frame by
 * the owner's draw callback, which pushes:
 *   face({ pts:[[x,y,z]…], fill, stroke, lw, dash, alpha, pick, layer, cull:n })
 *   line({ pts, stroke, lw, dash, alpha, pick, layer })
 *   glow({ at:[x,y,z], r (m), color })
 *   label({ at:[x,y,z], text, color, size, bold, dy })
 * Faces and lines are painted far to near within a layer (layer 0 first) —
 * the painter's algorithm, enough for boxes in a room or poles on a road. A
 * face with `cull` (its outward normal) is skipped when it looks away.
 *
 * World frame: x east, y north, z up, metres. Input is native Pointer Events:
 * drag empty space to orbit, right-drag / Shift-drag / two fingers to pan,
 * wheel or pinch to zoom; a press on something pickable goes to the owner's
 * onPick(id, e) — return a drag handler { move(e), up(e) } to take the drag.
 */

class View3D {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'v3d-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    if (opts.label) this.canvas.setAttribute('aria-label', opts.label);
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.yaw = opts.yaw != null ? opts.yaw : -32;
    this.pitch = opts.pitch != null ? opts.pitch : 36;
    this.zoom = 1;
    this.pan = [0, 0];
    this.target = [0, 0, 0];
    this.radius = 5;
    this.bg = opts.bg || null;
    this.onDraw = null;
    this.onPick = null;
    this.onClick = null;
    this._items = [];
    this._picks = [];
    this._ptrs = new Map();
    this._raf = 0;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this._ro = new ResizeObserver(() => this.redraw());
    this._ro.observe(host);
  }

  // ─── Camera ────────────────────────────────────────────────────────────
  fit(min, max) {
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    this.radius = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    this.pan = [0, 0];
    this.zoom = 1;
    this.redraw();
  }
  setView(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this.redraw(); }
  rotate(d) { this.yaw += d; this.redraw(); }
  zoomBy(k) { this.zoom = Math.max(0.2, Math.min(40, this.zoom * k)); this.redraw(); }

  _cam() {
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    const y = this.yaw * Math.PI / 180, p = this.pitch * Math.PI / 180;
    return { W, H, cy: Math.cos(y), sy: Math.sin(y), cp: Math.cos(p), sp: Math.sin(p),
      S: Math.min(W, H) / (2.2 * this.radius) * this.zoom };
  }

  // World → [screen x, screen y, depth towards the viewer].
  project(x, y, z, cam) {
    const k = cam || this._c || this._cam();
    const dx = x - this.target[0], dy = y - this.target[1], dz = z - this.target[2];
    const u = dx * k.cy - dy * k.sy, v = dx * k.sy + dy * k.cy;
    return [k.W / 2 + this.pan[0] + u * k.S, k.H / 2 + this.pan[1] - (dz * k.cp + v * k.sp) * k.S, dz * k.sp - v * k.cp];
  }
  // Towards the viewer, in world axes.
  viewDir(cam) { const k = cam || this._c || this._cam(); return [-k.sy * k.cp, -k.cy * k.cp, k.sp]; }
  facing(n, cam) { const w = this.viewDir(cam); return n[0] * w[0] + n[1] * w[1] + n[2] * w[2] > 1e-6; }
  // Screen point → world point on the horizontal plane at height z.
  planeAt(sx, sy, z) {
    const k = this._cam();
    const u = (sx - k.W / 2 - this.pan[0]) / k.S;
    const up = (k.H / 2 + this.pan[1] - sy) / k.S;
    const v = (up - (z - this.target[2]) * k.cp) / Math.max(0.08, k.sp);
    return [this.target[0] + u * k.cy + v * k.sy, this.target[1] - u * k.sy + v * k.cy];
  }
  // Screen offset → world offset along a horizontal unit direction (for sliding
  // a window along its wall): the screen drag projected onto that direction.
  slideAlong(dsx, dsy, dir) {
    const a = this.project(0, 0, 0), b = this.project(dir[0], dir[1], 0);
    const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
    return L2 > 1e-9 ? (dsx * ex + dsy * ey) / L2 : 0;
  }
  // Metres → screen pixels at the current zoom.
  scale() { return this._cam().S; }

  // ─── Scene ─────────────────────────────────────────────────────────────
  face(f) { this._items.push(Object.assign({ t: 'f', layer: 1 }, f)); }
  line(l) { this._items.push(Object.assign({ t: 'l', layer: 2 }, l)); }
  glow(g) { this._items.push(Object.assign({ t: 'g', layer: 3 }, g)); }
  label(l) { this._labels.push(l); }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (this.bg) { g.fillStyle = this.bg; g.fillRect(0, 0, W, H); }
    this._items = []; this._labels = [];
    this._c = this._cam();
    if (this.onDraw) this.onDraw(this);
    const k = this._c;
    const w = this.viewDir(k);
    const list = [];
    for (const it of this._items) {
      if (it.cull && it.cull[0] * w[0] + it.cull[1] * w[1] + it.cull[2] * w[2] <= 1e-6) continue;
      if (it.t === 'g') { const p = this.project(it.at[0], it.at[1], it.at[2], k); it.sp = p; it.d = p[2]; list.push(it); continue; }
      const sp = it.pts.map(q => this.project(q[0], q[1], q[2], k));
      let d = 0; for (const p of sp) d += p[2];
      it.sp = sp; it.d = d / sp.length + (it.bias || 0);
      list.push(it);
    }
    list.sort((a, b) => (a.layer - b.layer) || (a.d - b.d));
    this._picks = [];
    for (const it of list) {
      g.globalAlpha = it.alpha != null ? it.alpha : 1;
      if (it.t === 'g') {
        const r = Math.max(2, it.r * k.S);
        const gr = g.createRadialGradient(it.sp[0], it.sp[1], 0, it.sp[0], it.sp[1], r);
        gr.addColorStop(0, it.color || 'rgba(255,246,214,.75)');
        gr.addColorStop(1, 'rgba(255,246,214,0)');
        g.fillStyle = gr;
        g.beginPath(); g.arc(it.sp[0], it.sp[1], r, 0, Math.PI * 2); g.fill();
        continue;
      }
      g.beginPath();
      it.sp.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      if (it.t === 'f') {
        g.closePath();
        if (it.fill) { g.fillStyle = it.fill; g.fill(); }
      }
      if (it.stroke) {
        g.strokeStyle = it.stroke; g.lineWidth = it.lw || 1;
        g.setLineDash(it.dash || []);
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.stroke();
        g.setLineDash([]);
      } else if (it.t === 'f' && it.fill) {
        // seal hairline gaps between neighbouring patches
        g.strokeStyle = it.fill; g.lineWidth = 0.6; g.stroke();
      }
      if (it.pick) this._picks.push(it);
    }
    g.globalAlpha = 1;
    for (const l of this._labels) {
      const p = this.project(l.at[0], l.at[1], l.at[2], k);
      g.font = `${l.bold ? 700 : 600} ${l.size || 12}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.lineWidth = 4; g.strokeStyle = l.halo || 'rgba(255,255,255,.92)'; g.lineJoin = 'round';
      g.strokeText(l.text, p[0], p[1] + (l.dy || 0));
      g.fillStyle = l.color || '#1a1a2e';
      g.fillText(l.text, p[0], p[1] + (l.dy || 0));
    }
  }

  // Front-most pickable item under a screen point.
  pickAt(sx, sy) {
    for (let i = this._picks.length - 1; i >= 0; i--) {
      const it = this._picks[i];
      if (it.t === 'f' ? this._inPoly(sx, sy, it.sp) : this._nearLine(sx, sy, it.sp, 7)) return it.pick;
    }
    return null;
  }
  _inPoly(x, y, P) {
    let ins = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if (((P[i][1] > y) !== (P[j][1] > y)) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) ins = !ins;
    }
    return ins;
  }
  _nearLine(x, y, P, tol) {
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
      if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= tol) return true;
    }
    return false;
  }

  // ─── Input ─────────────────────────────────────────────────────────────
  _pos(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  _down(e) {
    this.canvas.focus({ preventScroll: true });
    const [x, y] = this._pos(e);
    this._ptrs.set(e.pointerId, [x, y]);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    if (this._ptrs.size === 2) {                      // second finger: pinch / pan
      if (this._drag && this._drag.handler && this._drag.handler.cancel) this._drag.handler.cancel();
      const [a, b] = [...this._ptrs.values()];
      this._drag = { mode: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], zoom: this.zoom, pan: this.pan.slice() };
      return;
    }
    if (this._ptrs.size > 2) return;
    const panMode = e.button === 2 || e.button === 1 || e.shiftKey;
    const id = panMode ? null : this.pickAt(x, y);
    const h = id != null && this.onPick ? this.onPick(id, e) : null;
    if (h) { this._drag = { mode: 'obj', handler: h, x, y, moved: false }; return; }
    this._drag = { mode: panMode ? 'pan' : 'orbit', x, y, yaw: this.yaw, pitch: this.pitch, pan: this.pan.slice(), moved: false, id };
  }

  _move(e) {
    if (!this._ptrs.has(e.pointerId)) return;
    const [x, y] = this._pos(e);
    this._ptrs.set(e.pointerId, [x, y]);
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'pinch') {
      if (this._ptrs.size < 2) return;
      const [a, b] = [...this._ptrs.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.zoom = Math.max(0.2, Math.min(40, d.zoom * dist / Math.max(1, d.d)));
      this.pan = [d.pan[0] + m[0] - d.m[0], d.pan[1] + m[1] - d.m[1]];
      this.redraw();
      return;
    }
    const dx = x - d.x, dy = y - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    if (d.mode === 'obj') { d.handler.move(e, x, y, dx, dy); return; }
    if (d.mode === 'pan') this.pan = [d.pan[0] + dx, d.pan[1] + dy];
    else { this.yaw = d.yaw + dx * 0.4; this.pitch = Math.max(5, Math.min(89.5, d.pitch + dy * 0.3)); }
    this.redraw();
  }

  _up(e) {
    this._ptrs.delete(e.pointerId);
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'pinch') { if (!this._ptrs.size) this._drag = null; return; }
    this._drag = null;
    if (d.mode === 'obj') { if (d.handler.up) d.handler.up(e, d.moved); return; }
    if (!d.moved && this.onClick) this.onClick(d.id, e);
  }

  _wheel(e) {
    e.preventDefault();
    const [x, y] = this._pos(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    const z0 = this.zoom;
    this.zoom = Math.max(0.2, Math.min(40, this.zoom * k));
    // zoom about the cursor
    const r = this.zoom / z0, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    this.pan = [(this.pan[0] + W / 2 - x) * r - W / 2 + x, (this.pan[1] + H / 2 - y) * r - H / 2 + y];
    this.redraw();
  }

  destroy() { this._ro.disconnect(); this.canvas.remove(); }
}

// Colour helpers shared by the 3D views.
const V3D = {
  rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; },
  shade(h, f) { return 'rgb(' + this.rgb(h).map(v => Math.round(Math.min(255, v * f))).join(',') + ')'; },
  // A box standing on the plan: centre c, w along its own x turned rot°, d across,
  // from z0 up h. o: { color, under, stroke, lw, dash, alpha, pick, outline, noCull, layer }.
  box(v, c, w, d, z0, h, rot, o) {
    const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const P = (u, w2) => [c[0] + u * ca - w2 * sa, c[1] + u * sa + w2 * ca];
    const hw = w / 2, hd = d / 2, z1 = z0 + h;
    const cs = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)];
    const ux = [ca, sa, 0], uy = [-sa, ca, 0];
    const faces = [
      { n: [0, 0, 1], q: cs.map(p => [p[0], p[1], z1]), f: 1.0 },
      { n: [0, 0, -1], q: cs.slice().reverse().map(p => [p[0], p[1], z0]), f: 0.62, under: true },
      { n: ux, q: [[...cs[1], z0], [...cs[2], z0], [...cs[2], z1], [...cs[1], z1]], f: 0.84 },
      { n: [-ux[0], -ux[1], 0], q: [[...cs[3], z0], [...cs[0], z0], [...cs[0], z1], [...cs[3], z1]], f: 0.72 },
      { n: uy, q: [[...cs[2], z0], [...cs[3], z0], [...cs[3], z1], [...cs[2], z1]], f: 0.78 },
      { n: [-uy[0], -uy[1], 0], q: [[...cs[0], z0], [...cs[1], z0], [...cs[1], z1], [...cs[0], z1]], f: 0.9 },
    ];
    for (const fc of faces) {
      if (o.outline) { v.line({ pts: fc.q.concat([fc.q[0]]), stroke: o.stroke, lw: o.lw, layer: 2, pick: o.pick }); continue; }
      if (!o.alpha && o.alpha !== undefined) continue;
      const fill = fc.under && o.under ? o.under : this.shade(o.color, fc.f);
      v.face({ pts: fc.q, fill, stroke: o.stroke, lw: o.lw, dash: o.dash, alpha: o.alpha, pick: o.pick, cull: o.noCull && fc.under ? null : fc.n, layer: o.layer != null ? o.layer : 1 });
    }
  },
  // A surface as bright as it looks: luminance ρE/π through a soft exposure curve.
  tone(E, rho, base, expo) {
    const v = 1 - Math.exp(-(E * rho / Math.PI) * (expo || 1) / 45);
    const k = 0.04 + 0.96 * v;
    return 'rgb(' + this.rgb(base).map(x => Math.round(Math.min(255, x * k * 1.08))).join(',') + ')';
  },
};
