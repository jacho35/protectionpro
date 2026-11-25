/* Geom3D — pure helpers shared by the 3D views (View3D, its WebGL backend, Roof3D, Light3D, Road3D). No DOM.
 *
 *   fitCamera     zoom and pan that put a bounding box inside the viewport for the current yaw / pitch / aspect
 *   faceNormal    unit normal of a planar polygon (Newell)
 *   lightFactor   how bright a face looks: ambient + hemisphere + one directional light
 *   shadeColor    a CSS colour scaled by a factor (hex, rgb() and rgba())
 *   triangulate   ear clipping of a planar polygon, concave allowed -> index triples
 *   layoutLabels  greedy label placement without overlap; returns where each label goes and whether it needs a leader line
 *
 * World frame: x east, y north, z up, metres. Camera maths mirror View3D._cam / project (orthographic).
 */
const Geom3D = {
  // Screen box of the 8 corners at scale 1, relative to the box centre: u to the right, a downwards.
  _extent(min, max, yaw, pitch) {
    const y = yaw * Math.PI / 180, p = pitch * Math.PI / 180;
    const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let u0 = Infinity, u1 = -Infinity, a0 = Infinity, a1 = -Infinity;
    for (const x of [min[0], max[0]]) for (const yy of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const dx = x - c[0], dy = yy - c[1], dz = z - c[2];
      const u = dx * cy - dy * sy, v = dx * sy + dy * cy, a = -(dz * cp + v * sp);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); a0 = Math.min(a0, a); a1 = Math.max(a1, a);
    }
    return { u0, u1, a0, a1 };
  },
  // The zoom (relative to View3D's S = min(W, H) / (2.2 R) * zoom) and pan (px) that centre the box with `margin` (fraction of the
  // viewport) on every side. R is the radius View3D uses for the box.
  fitCamera(min, max, W, H, yaw, pitch, margin = 0.06) {
    const R = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const e = this._extent(min, max, yaw, pitch);
    const wU = Math.max(1e-6, e.u1 - e.u0), wA = Math.max(1e-6, e.a1 - e.a0);
    const S = Math.min(W * (1 - 2 * margin) / wU, H * (1 - 2 * margin) / wA);
    return { zoom: S / (Math.min(W, H) / (2.2 * R)), pan: [-(e.u0 + e.u1) / 2 * S, -(e.a0 + e.a1) / 2 * S], S, radius: R };
  },

  faceNormal(pts) {
    let n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const m = Math.hypot(n[0], n[1], n[2]);
    return m < 1e-12 ? [0, 0, 1] : [n[0] / m, n[1] / m, n[2] / m];
  },

  // Light: a direction TOWARD the light (unit), sun strength, hemisphere sky and ground terms. A face seen from either side is lit
  // as its front (two-sided), so a roof seen from underneath does not go black.
  LIGHT: { dir: [-0.45, -0.55, 0.70], ambient: 0.46, sun: 0.55, sky: 0.10 },
  lightFactor(n, light) {
    const L = light || this.LIGHT, d = L.dir, m = Math.hypot(d[0], d[1], d[2]) || 1;
    const dot = (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / m;
    return Math.max(0.18, L.ambient + L.sun * Math.max(0, dot) + L.sky * (0.5 + 0.5 * n[2]));
  },
  // "#rrggbb", "rgb(r,g,b)" or "rgba(r,g,b,a)" scaled by k (alpha kept). Anything else is returned unchanged.
  shadeColor(c, k) {
    if (typeof c !== 'string') return c;
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    let r, g, b, a = null;
    if (m) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c))) { r = +m[1]; g = +m[2]; b = +m[3]; if (m[4] != null) a = +m[4]; }
    else return c;
    const f = (v) => Math.round(Math.max(0, Math.min(255, v * k)));
    return a == null ? `rgb(${f(r)},${f(g)},${f(b)})` : `rgba(${f(r)},${f(g)},${f(b)},${a})`;
  },
  // Parsed colour as [r, g, b, a] in 0..1 (for the GL backend); unknown strings give mid grey.
  parseColor(c) {
    let m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (m) return [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255, 1];
    if ((m = /^#([0-9a-f]{3})$/i.exec(c || ''))) return [parseInt(m[1][0] + m[1][0], 16) / 255, parseInt(m[1][1] + m[1][1], 16) / 255, parseInt(m[1][2] + m[1][2], 16) / 255, 1];
    if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c || ''))) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] != null ? +m[4] : 1];
    return [0.5, 0.5, 0.5, 1];
  },

  // Ear clipping of a planar polygon given as [x, y, z] points. Returns index triples into `pts`. Convex polygons fan out;
  // a polygon that cannot be clipped (self-touching) falls back to a fan so it still draws.
  triangulate(pts) {
    const n = pts.length;
    if (n < 3) return [];
    if (n === 3) return [[0, 1, 2]];
    const nm = this.faceNormal(pts);
    const ax = Math.abs(nm[0]) > Math.abs(nm[1]) ? (Math.abs(nm[0]) > Math.abs(nm[2]) ? 0 : 2) : (Math.abs(nm[1]) > Math.abs(nm[2]) ? 1 : 2);
    const iu = ax === 0 ? 1 : 0, iv = ax === 2 ? 1 : 2;
    const P = pts.map(p => [p[iu], p[iv]]);
    let area = 0;
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const sg = area >= 0 ? 1 : -1;
    const cross = (a, b, c) => sg * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const inTri = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
    const idx = pts.map((_, i) => i), out = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < n * n) {
      let clipped = false;
      for (let k = 0; k < idx.length; k++) {
        const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
        const a = P[i0], b = P[i1], c = P[i2];
        if (cross(a, b, c) <= 1e-12) continue;                              // reflex or flat corner
        let ear = true;
        for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; const q = P[j]; if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1]) || (q[0] === c[0] && q[1] === c[1])) continue; if (inTri(q, a, b, c)) { ear = false; break; } }
        if (!ear) continue;
        out.push([i0, i1, i2]); idx.splice(k, 1); clipped = true; break;
      }
      if (!clipped) break;
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    else for (let k = 1; k + 1 < idx.length; k++) out.push([idx[0], idx[k], idx[k + 1]]);   // could not be clipped: fan
    return out;
  },

  // Label placement. `labels` = [{x, y (anchor, px), w, h (box, px), prio}] ; the box is centred on x and sits above y (as View3D draws).
  // Higher prio is placed first. A label that overlaps one already placed is tried at nearby offsets (up, down, sideways, further);
  // if none is free it is dropped (shown: false). Returns [{shown, x, y (box centre bottom), leader: bool}] in input order.
  layoutLabels(labels, W, H) {
    const order = labels.map((l, i) => i).sort((a, b) => (labels[b].prio || 0) - (labels[a].prio || 0) || a - b);
    const placed = [], out = labels.map(() => ({ shown: false, x: 0, y: 0, leader: false }));
    const box = (l, x, y) => ({ x0: x - l.w / 2, x1: x + l.w / 2, y0: y - l.h, y1: y });
    const hit = (a, b) => a.x0 < b.x1 + 2 && a.x1 > b.x0 - 2 && a.y0 < b.y1 + 1 && a.y1 > b.y0 - 1;
    for (const i of order) {
      const l = labels[i];
      if (l.x < -50 || l.x > W + 50 || l.y < -50 || l.y > H + 50) continue;
      const tries = [[0, 0], [0, -l.h - 2], [0, l.h + 6], [l.w * 0.6, 0], [-l.w * 0.6, 0], [l.w * 0.6, -l.h - 2], [-l.w * 0.6, -l.h - 2], [0, -2 * l.h - 6], [0, 2 * l.h + 10]];
      for (const [dx, dy] of tries) {
        let x = l.x + dx, y = l.y + dy;
        x = Math.max(l.w / 2 + 2, Math.min(W - l.w / 2 - 2, x)); y = Math.max(l.h + 2, Math.min(H - 2, y));
        const b = box(l, x, y);
        if (placed.some(p => hit(b, p))) continue;
        placed.push(b); out[i] = { shown: true, x, y, leader: Math.abs(dx) + Math.abs(dy) > 1 };
        break;
      }
    }
    return out;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Geom3D;
