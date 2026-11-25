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
    // WebGL2 backend (opts.gl): a second canvas under this one takes the polygons; this canvas stays for input, labels and glows.
    // Off with localStorage 'pp-3d-renderer' = '2d' (support / tests), and it falls back to the 2D painter if the context is lost.
    this.gl = null; this.glCanvas = null;
    let force2d = false; try { force2d = localStorage.getItem('pp-3d-renderer') === '2d'; } catch (_) { /* no storage */ }
    if (opts.gl && !force2d && typeof V3DGL !== 'undefined') {
      const gc = document.createElement('canvas');
      gc.className = 'v3d-canvas v3d-gl'; gc.style.pointerEvents = 'none'; gc.setAttribute('aria-hidden', 'true');
      host.insertBefore(gc, this.canvas);
      this.gl = V3DGL.create(gc);
      if (this.gl) { this.glCanvas = gc; this.gl.onLost = () => this._glFallback(); } else gc.remove();
    }
    this.sun = null;          // { dir: [x, y, z] toward the sun } -> real shadows (WebGL only)
    this.light = null;        // overrides Geom3D.LIGHT for lit faces
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
    c.addEventListener('pointerleave', () => { if (this._cubeHover) { this._cubeHover = null; this.redraw(); } if (this.hoverId != null) { this.hoverId = null; c.style.cursor = ''; if (this.onHover) this.onHover(null); } });
    c.addEventListener('dblclick', (e) => { const [x, y] = this._pos(e); if (this.onDblClick) this.onDblClick(this.pickAt(x, y), e); });
    this.hoverId = null; this._hoverRaf = 0; this._anim = 0; this._ready = false;
    this.onHover = null; this.onDblClick = null;
    this.cubeLabels = { '+y': 'N', '+x': 'E', '-y': 'S', '-x': 'W', top: 'Top' }; this.cubeNorth = 0; this._cube = null; this._cubeHover = null;
    if (opts.sky) host.style.background = `linear-gradient(${opts.sky[0]}, ${opts.sky[1]})`;       // sky behind a transparent WebGL canvas
    this._ro = new ResizeObserver(() => { this._refit(); this.redraw(); });
    this._ro.observe(host);
  }

  // ─── Camera ────────────────────────────────────────────────────────────
  // Frame a box: the whole of it inside the viewport at the current yaw / pitch and aspect (Geom3D.fitCamera). It is refitted when the
  // view is resized or given a named view while the camera is still where the fit put it; once the user orbit-zooms / pans it stays.
  fit(min, max) {
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    this.radius = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    this.pan = [0, 0];
    this.zoom = 1;
    this._fitBox = [min.slice(), max.slice()];
    this._refit(true);
    this.redraw();
  }
  _refit(force) {
    const b = this._fitBox, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!b || !W || !H || typeof Geom3D === 'undefined') return;
    const l = this._fitState;
    if (!force && l && (l.zoom !== this.zoom || l.pan[0] !== this.pan[0] || l.pan[1] !== this.pan[1])) return;   // the user has moved the camera since
    const f = Geom3D.fitCamera(b[0], b[1], W, H, this.yaw, this.pitch, this.opts.fitMargin != null ? this.opts.fitMargin : 0.06);
    this.zoom = Math.max(0.2, Math.min(40, f.zoom)); this.pan = f.pan;
    this._fitState = { zoom: this.zoom, pan: this.pan.slice() };
  }
  // Named views and focus moves glide (opts.animate) once the view has drawn; a press, wheel or pinch stops the glide.
  setView(yaw, pitch) {
    if (this.opts.animate && this._ready) { this.animateView(yaw, pitch); return; }
    this._stopAnim(); this.yaw = yaw; this.pitch = pitch; this._refit(); this.redraw();
  }
  _stopAnim() { if (this._anim) { cancelAnimationFrame(this._anim); this._anim = 0; } }
  _glide(ms, apply) {
    this._stopAnim();
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      apply(Geom3D.ease(t));
      this.draw();
      this._anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this._anim = requestAnimationFrame(step);
  }
  animateView(yaw, pitch, ms = 340) {
    const y0 = this.yaw, p0 = this.pitch;
    this._glide(ms, (k) => { this.yaw = k >= 1 ? yaw : Geom3D.lerpAngle(y0, yaw, k); this.pitch = p0 + (pitch - p0) * k; this._refit(); });   // lands on the exact angle asked for, not its 360° twin
  }
  // Frame another box (e.g. the picked roof), gliding there when opts.animate; it becomes the box a later resize refits.
  focusBox(min, max) {
    if (!(this.opts.animate && this._ready)) { this.fit(min, max); return; }
    const k0 = this._cam(), S0 = k0.S, t0 = this.target.slice(), pan0 = this.pan.slice();
    const t1 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], R1 = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const f = Geom3D.fitCamera(min, max, W, H, this.yaw, this.pitch, this.opts.fitMargin != null ? this.opts.fitMargin : 0.06);
    const base = Math.min(W, H) / (2.2 * R1), z0 = S0 / base;
    this.radius = R1; this._fitBox = [min.slice(), max.slice()];
    this._glide(380, (k) => {
      this.target = [t0[0] + (t1[0] - t0[0]) * k, t0[1] + (t1[1] - t0[1]) * k, t0[2] + (t1[2] - t0[2]) * k];
      this.zoom = Math.max(0.2, Math.min(40, z0 + (f.zoom - z0) * k));
      this.pan = [pan0[0] + (f.pan[0] - pan0[0]) * k, pan0[1] + (f.pan[1] - pan0[1]) * k];
      this._fitState = { zoom: this.zoom, pan: this.pan.slice() };
    });
  }
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
    this._ready = true;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const useGL = !!(this.gl && this.gl.ok);
    if (!useGL) {
      if (this.opts.sky) { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, this.opts.sky[0]); gr.addColorStop(1, this.opts.sky[1]); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
      else if (this.bg) { g.fillStyle = this.bg; g.fillRect(0, 0, W, H); }
    }
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
      if (it.t === 'f' && it.lit && it.fill && typeof Geom3D !== 'undefined') {     // `lit`: shade the face by how it faces the light
        const n = it.n || Geom3D.faceNormal(it.pts), flip = n[0] * w[0] + n[1] * w[1] + n[2] * w[2] < 0;
        it.fillLit = Geom3D.shadeColor(it.fill, Geom3D.lightFactor(flip ? [-n[0], -n[1], -n[2]] : n, this.light));
      } else it.fillLit = it.fill;
      list.push(it);
    }
    if (useGL && this._renderGL(list, k, W, H, dpr, w)) {
      g.globalAlpha = 1;
      for (const it of list) if (it.t === 'g') this._glow(g, it, k);
      this._drawLabels(g, k, W, H);
      this._drawCube(g, k, W, H);
      return;
    }
    if (this.glCanvas && !useGL) this.glCanvas.style.display = 'none';
    list.sort((a, b) => (a.layer - b.layer) || (a.d - b.d));
    this._picks = [];
    for (const it of list) {
      g.globalAlpha = it.alpha != null ? it.alpha : 1;
      if (it.t === 'g') { this._glow(g, it, k); continue; }
      g.beginPath();
      it.sp.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      if (it.t === 'f') {
        g.closePath();
        if (it.fillLit) { g.fillStyle = it.fillLit; g.fill(); }
      }
      if (it.stroke) {
        g.strokeStyle = it.stroke; g.lineWidth = it.lw || 1;
        g.setLineDash(it.dash || []);
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.stroke();
        g.setLineDash([]);
      } else if (it.t === 'f' && it.fill) {
        // seal hairline gaps between neighbouring patches
        g.strokeStyle = it.fillLit; g.lineWidth = 0.6; g.stroke();
      }
      if (it.pick) this._picks.push(it);
    }
    g.globalAlpha = 1;
    this._drawLabels(g, k, W, H);
    this._drawCube(g, k, W, H);
  }

  _glow(g, it, k) {
    g.globalAlpha = it.alpha != null ? it.alpha : 1;
    const r = Math.max(2, it.r * k.S);
    const gr = g.createRadialGradient(it.sp[0], it.sp[1], 0, it.sp[0], it.sp[1], r);
    gr.addColorStop(0, it.color || 'rgba(255,246,214,.75)');
    gr.addColorStop(1, 'rgba(255,246,214,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(it.sp[0], it.sp[1], r, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }

  // Hand the frame to the WebGL backend. Vertices are projected here (the same maths the painter and the labels use) and sent with
  // a normalised depth; `layer` < 3 is depth tested, >= 3 is drawn on top. Returns false when the backend cannot draw (then the painter runs).
  _renderGL(list, k, W, H, dpr, w) {
    if (this.glCanvas) this.glCanvas.style.display = '';
    let dmin = Infinity, dmax = -Infinity;
    for (const it of list) if (it.t !== 'g') for (const p of it.sp) { if (p[2] < dmin) dmin = p[2]; if (p[2] > dmax) dmax = p[2]; }
    if (!isFinite(dmin)) { dmin = 0; dmax = 1; }
    const range = Math.max(1e-6, dmax - dmin), nd = (d) => 0.98 - 1.96 * (d - dmin) / range;
    const faces = [], lines = [];
    const G = typeof Geom3D !== 'undefined' ? Geom3D : null;
    for (const it of list) {
      if (it.t === 'g') continue;
      const pts = it.sp.map(p => { const q = [p[0], p[1], p[2]]; q.z = nd(p[2]); return q; });
      const alpha = it.alpha != null ? it.alpha : 1;
      if (it.t === 'f') {
        if (it.fill) {
          const c = G.parseColor(it.fill); c[3] *= alpha;
          const n = it.n || G.faceNormal(it.pts);
          faces.push({ sp: pts, pts: it.pts, tris: this._tris(it.pts), rgba: c, lit: !!it.lit, n, layer: it.layer, pick: it.pick, d: it.d, noShadow: !!it.noShadow });
        }
        if (it.stroke) { const c = G.parseColor(it.stroke); c[3] *= alpha; lines.push({ sp: pts.concat([pts[0]]), rgba: c, lw: it.lw || 1, dash: it.dash, layer: it.layer, pick: it.pick, d: it.d }); }
      } else if (it.stroke) {
        const c = G.parseColor(it.stroke); c[3] *= alpha;
        lines.push({ sp: pts, rgba: c, lw: it.lw || 1, dash: it.dash, layer: it.layer, pick: it.pick, d: it.d });
      }
    }
    const L = this.light || G.LIGHT, sun = this.sun && this.sun.dir ? this.sun : null;
    const bg = this.bg && !this.opts.sky ? G.parseColor(this.bg) : [0, 0, 0, 0];
    const fr = { W, H, dpr, bg, faces, lines, light: sun ? { dir: sun.dir, ambient: 0.56, sun: 0.5, sky: 0.08 } : L, sunOn: !!sun && this.shadows !== false, viewDir: this.viewDir(k) };
    this._glFrame = fr;
    try { return this.gl.render(fr); } catch (e) { this.gl.ok = false; this._glFallback(); return false; }
  }
  _tris(pts) {
    const n = pts.length;
    if (n === 3) return [[0, 1, 2]];
    if (n === 4) {                                    // a convex quad is two triangles; check the turn at each corner
      const nm = Geom3D.faceNormal(pts); let ok = true;
      for (let i = 0; i < 4 && ok; i++) {
        const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
        if ((uy * vz - uz * vy) * nm[0] + (uz * vx - ux * vz) * nm[1] + (ux * vy - uy * vx) * nm[2] < -1e-9) ok = false;
      }
      if (ok) return [[0, 1, 2], [0, 2, 3]];
    }
    return Geom3D.triangulate(pts);
  }
  _glFallback() {
    if (this.glCanvas) this.glCanvas.style.display = 'none';
    if (this.gl) this.gl.ok = false;
    this.redraw();
  }
  get usesGL() { return !!(this.gl && this.gl.ok); }
  // The picture as one canvas (WebGL + labels), for export; renders now so the GL buffer is still valid.
  toCanvas() {
    this.draw();
    const c = document.createElement('canvas'); c.width = this.canvas.width; c.height = this.canvas.height;
    const g = c.getContext('2d');
    if (this.opts.sky) { const gr = g.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, this.opts.sky[0]); gr.addColorStop(1, this.opts.sky[1]); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height); }
    else if (this.bg) { g.fillStyle = this.bg; g.fillRect(0, 0, c.width, c.height); }
    if (this.usesGL) g.drawImage(this.glCanvas, 0, 0);
    g.drawImage(this.canvas, 0, 0);
    return c;
  }

  // ─── View cube (opts.cube) ─────────────────────────────────────────────
  // A small cube in the corner turned like the scene: the faces are the four sides and the top (labels in `cubeLabels`, turned by the
  // plan's north angle through `cubeNorth`). Hover lights a face, a click glides to the view from that side (as the Top / From north /
  // … buttons do); "Iso" under it returns to the corner view. Drawn on the overlay canvas, so it works on both renderers.
  _cubeLayout(W, H) {
    const s = 20, cx = 14 + s + 10, cy = this.opts.cubePos === 'bl' ? H - 14 - 28 - s - 8 : 14 + s + 14;     // top-left, or bottom-left where the top-left holds an info card
    return { s, cx, cy };
  }
  _drawCube(g, k, W, H) {
    if (!this.opts.cube) { this._cube = null; return; }
    const { s, cx, cy } = this._cubeLayout(W, H), w = this.viewDir(k);
    const P = (x, y, z) => { const u = x * k.cy - y * k.sy, v = x * k.sy + y * k.cy; return [cx + u * s, cy - (z * k.cp + v * k.sp) * s]; };
    const F = [
      { key: 'top', n: [0, 0, 1], q: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], c: '#f4f6f8' },
      { key: '+y', n: [0, 1, 0], q: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], c: '#dfe5ec' },
      { key: '-y', n: [0, -1, 0], q: [[1, -1, -1], [-1, -1, -1], [-1, -1, 1], [1, -1, 1]], c: '#e9edf2' },
      { key: '+x', n: [1, 0, 0], q: [[1, 1, -1], [1, -1, -1], [1, -1, 1], [1, 1, 1]], c: '#d5dce5' },
      { key: '-x', n: [-1, 0, 0], q: [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]], c: '#e3e8ee' },
    ];
    this._cube = { faces: [], home: { x0: cx - 17, x1: cx + 17, y0: cy + s + 8, y1: cy + s + 24 } };
    g.save(); g.globalAlpha = 1; g.lineJoin = 'round';
    for (const f of F) {
      if (f.n[0] * w[0] + f.n[1] * w[1] + f.n[2] * w[2] <= 0.02) continue;
      const poly = f.q.map(p => P(p[0], p[1], p[2])), hov = this._cubeHover === f.key;
      this._cube.faces.push({ key: f.key, poly });
      g.beginPath(); poly.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
      g.fillStyle = hov ? '#93c5fd' : f.c; g.fill(); g.lineWidth = 1; g.strokeStyle = hov ? '#1d4ed8' : '#8a94a1'; g.stroke();
      const lab = this.cubeLabels[f.key];
      if (lab) {
        const mx = poly.reduce((a, p) => a + p[0] / 4, 0), my = poly.reduce((a, p) => a + p[1] / 4, 0);
        g.font = '700 10px system-ui, -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = hov ? '#0b2a63' : '#3b4452'; g.fillText(lab, mx, my + 0.5);
      }
    }
    const h = this._cube.home, hov = this._cubeHover === 'home';
    g.fillStyle = hov ? '#93c5fd' : 'rgba(255,255,255,.9)'; g.strokeStyle = hov ? '#1d4ed8' : '#8a94a1';
    g.beginPath(); g.roundRect ? g.roundRect(h.x0, h.y0, h.x1 - h.x0, h.y1 - h.y0, 4) : g.rect(h.x0, h.y0, h.x1 - h.x0, h.y1 - h.y0); g.fill(); g.stroke();
    g.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = hov ? '#0b2a63' : '#3b4452';
    g.fillText('Iso', (h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2 + 0.5);
    g.restore();
  }
  _cubeAt(x, y) {
    const c = this._cube; if (!c) return null;
    if (x >= c.home.x0 && x <= c.home.x1 && y >= c.home.y0 && y <= c.home.y1) return 'home';
    for (const f of c.faces) if (this._inPoly(x, y, f.poly)) return f.key;
    return null;
  }
  // The view from a cube face: the side faces look from that side at a modest pitch, the top looks down, Iso is the corner view.
  cubeGo(key) {
    if (this.onCubeView && this.onCubeView(key)) return;
    const n = this.cubeNorth || 0, H = this.opts.cubeHome || [150, 32];
    if (key === 'home') this.setView(H[0] + n, H[1]);
    else if (key === 'top') this.setView(0, 89);                                 // plan up, as the Top button
    else this.setView({ '+y': 180, '-y': 0, '+x': -90, '-x': 90 }[key] + n, this.opts.cubeSidePitch || 25);
  }

  // Labels: with opts.labelLayout they are placed so none overlaps (higher `prio` first, a moved one gets a leader line, one that
  // cannot fit is dropped); otherwise each sits on its anchor.
  _drawLabels(g, k, W, H) {
    const font = (l) => `${l.bold ? 700 : 600} ${l.size || 12}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const pr = this._labels.map(l => { const p = this.project(l.at[0], l.at[1], l.at[2], k); g.font = font(l); return { l, x: p[0], y: p[1] + (l.dy || 0), w: g.measureText(l.text).width + 6, h: (l.size || 12) + 4, prio: l.prio || 0 }; });
    const place = (this.opts.labelLayout && typeof Geom3D !== 'undefined') ? Geom3D.layoutLabels(pr, W, H) : pr.map(q => ({ shown: true, x: q.x, y: q.y, leader: false }));
    pr.forEach((q, i) => {
      const o = place[i]; if (!o.shown) return;
      const l = q.l;
      g.font = font(l); g.textAlign = 'center'; g.textBaseline = 'bottom';
      if (o.leader) { g.strokeStyle = 'rgba(31,41,55,.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(o.x, o.y + 1); g.stroke(); }
      g.lineWidth = 4; g.strokeStyle = l.halo || 'rgba(255,255,255,.92)'; g.lineJoin = 'round';
      g.strokeText(l.text, o.x, o.y);
      g.fillStyle = l.color || '#1a1a2e';
      g.fillText(l.text, o.x, o.y);
    });
  }

  // Front-most pickable item under a screen point.
  pickAt(sx, sy) {
    if (this.usesGL && this._glFrame) { try { return this.gl.pick(this._glFrame, sx, sy); } catch (_) { return null; } }
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
    this._stopAnim();
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
    const cube = e.button === 0 ? this._cubeAt(x, y) : null;
    if (cube) { this._drag = { mode: 'cube', key: cube, x, y, yaw: this.yaw, pitch: this.pitch, moved: false }; return; }
    const panMode = e.button === 2 || e.button === 1 || e.shiftKey;
    const id = panMode ? null : this.pickAt(x, y);
    const h = id != null && this.onPick ? this.onPick(id, e) : null;
    if (h) { this._drag = { mode: 'obj', handler: h, x, y, moved: false }; return; }
    this._drag = { mode: panMode ? 'pan' : 'orbit', x, y, yaw: this.yaw, pitch: this.pitch, pan: this.pan.slice(), moved: false, id };
  }

  _hoverPick(e) {
    if (this._cube && e.pointerType !== 'touch') {                                 // the view cube takes the hover first (cheap, no pick pass)
      const [x, y] = this._pos(e), c = this._cubeAt(x, y);
      if (c !== this._cubeHover) { this._cubeHover = c; this.canvas.style.cursor = c ? 'pointer' : ''; this.redraw(); }
      if (c) { if (this.hoverId != null) { this.hoverId = null; if (this.onHover) this.onHover(null); } return; }
    }
    if (!this.onHover || e.pointerType === 'touch' || this._hoverRaf) return;
    const [x, y] = this._pos(e);
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      if (this._drag) return;
      const id = this.pickAt(x, y);
      if (id !== this.hoverId) { this.hoverId = id; this.canvas.style.cursor = id != null ? 'pointer' : ''; this.onHover(id); }
    });
  }

  _move(e) {
    if (!this._ptrs.has(e.pointerId)) { this._hoverPick(e); return; }
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
    if (d.mode === 'cube') {                                                      // dragging the cube orbits the scene (a click on a face is a jump)
      this.yaw = d.yaw + dx * 0.5; this.pitch = Math.max(5, Math.min(89.5, d.pitch + dy * 0.4));
      if (this._cubeHover) this._cubeHover = null;
      this.redraw(); return;
    }
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
    if (d.mode === 'cube') { if (!d.moved) this.cubeGo(d.key); return; }
    if (d.mode === 'obj') { if (d.handler.up) d.handler.up(e, d.moved); return; }
    if (!d.moved && this.onClick) this.onClick(d.id, e);
  }

  _wheel(e) {
    e.preventDefault();
    this._stopAnim();
    const [x, y] = this._pos(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    const z0 = this.zoom;
    this.zoom = Math.max(0.2, Math.min(40, this.zoom * k));
    // zoom about the cursor
    const r = this.zoom / z0, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    this.pan = [(this.pan[0] + W / 2 - x) * r - W / 2 + x, (this.pan[1] + H / 2 - y) * r - H / 2 + y];
    this.redraw();
  }

  destroy() { this._stopAnim(); if (this._hoverRaf) cancelAnimationFrame(this._hoverRaf); this._ro.disconnect(); if (this.gl) { this.gl.destroy(); this.gl = null; } if (this.glCanvas) this.glCanvas.remove(); this.canvas.remove(); }
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
      const fill = o.lit ? o.color : fc.under && o.under ? o.under : this.shade(o.color, fc.f);       // `lit`: the view shades each face by the light instead of the fixed factors
      v.face({ lit: !!o.lit, n: fc.n, pts: fc.q, fill, stroke: o.stroke, lw: o.lw, dash: o.dash, alpha: o.alpha, pick: o.pick, cull: o.noCull && fc.under ? null : fc.n, layer: o.layer != null ? o.layer : 1 });
    }
  },
  // A surface as bright as it looks: luminance ρE/π through a soft exposure curve.
  tone(E, rho, base, expo) {
    const v = 1 - Math.exp(-(E * rho / Math.PI) * (expo || 1) / 45);
    const k = 0.04 + 0.96 * v;
    return 'rgb(' + this.rgb(base).map(x => Math.round(Math.min(255, x * k * 1.08))).join(',') + ')';
  },
};
