/**
 * DxfWriter — a small ASCII DXF (R12) writer shared by the GA and the board
 * single-line exports, plus an SVG → DXF converter for drawings that are built
 * as SVG strings (the single line).
 *
 * R12 is the lowest common denominator every CAD package and viewer reads
 * without handles, block records or an objects section. What it needs care
 * with is text: non-ASCII characters (×, ·, –, Ω, φ, ², °) are written as the
 * \U+XXXX escapes CAD text engines understand, `%` is escaped as %%%, and each
 * TEXT carries a real horizontal alignment (codes 72/11) instead of a width
 * guess, so centred and right-aligned labels land where the SVG puts them.
 * Units are millimetres, y up.
 */
const DxfWriter = {
  // Nominal AutoCAD colour indexes used for nearest-colour matching.
  _ACI: [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255],
    [6, 255, 0, 255], [7, 0, 0, 0], [8, 128, 128, 128], [9, 192, 192, 192]],

  // '#rrggbb' / '#rgb' / rgb(...) / a few names → [r, g, b], or null for none.
  parseColor(c) {
    if (c == null) return undefined;
    c = String(c).trim().toLowerCase();
    if (!c || c === 'none' || c === 'transparent') return null;
    const names = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
      blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 165, 0], yellow: [255, 255, 0] };
    if (names[c]) return names[c];
    let m = /^#([0-9a-f]{3})$/.exec(c);
    if (m) return m[1].split('').map(h => parseInt(h + h, 16));
    m = /^#([0-9a-f]{6})$/.exec(c);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
    if (m) return [+m[1], +m[2], +m[3]];
    return undefined;
  },

  // Nearest ACI. Black and white both become 7 (it shows black on a light
  // background and white on a dark one), so the drawing reads in either.
  aci(rgb) {
    if (!rgb) return 7;
    const [r, g, b] = rgb;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 24) return mx < 64 || mx > 224 ? 7 : mx < 160 ? 8 : 9;
    let best = 7, bd = Infinity;
    for (const [i, cr, cg, cb] of this._ACI) {
      if (i >= 7) continue;
      const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  },

  // Text value safe for a TEXT entity.
  text(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ')) {
      const cp = ch.codePointAt(0);
      if (ch === '%') out += '%%%';
      else if (cp < 32) out += ' ';
      else if (cp < 127) out += ch;
      else if (cp === 127) out += ' ';
      else if (cp > 0xFFFF) out += '?';
      else out += '\\U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
  },

  // ── Document ───────────────────────────────────────────────────────
  // `layers`: { NAME: aciColour }. Coordinates passed to the entity methods
  // are drawing units (y up).
  create(layers) {
    const L = Object.assign({ '0': 7 }, layers || {});
    const ents = [];
    const f = (n) => (Math.round(n * 1000) / 1000).toString();
    const lay = (n) => { if (!(n in L)) L[n] = 7; return n; };
    const col = (c) => (c != null && c !== 7 ? ['62', String(c)] : []);
    return {
      line(x1, y1, x2, y2, layer, color) {
        ents.push('0', 'LINE', '8', lay(layer || '0'), ...col(color),
          '10', f(x1), '20', f(y1), '30', '0', '11', f(x2), '21', f(y2), '31', '0');
      },
      poly(pts, closed, layer, color) {
        if (pts.length < 2) return;
        ents.push('0', 'POLYLINE', '8', lay(layer || '0'), ...col(color), '66', '1', '70', closed ? '1' : '0',
          '10', '0', '20', '0', '30', '0');
        for (const [x, y] of pts) ents.push('0', 'VERTEX', '8', layer || '0', '10', f(x), '20', f(y), '30', '0');
        ents.push('0', 'SEQEND', '8', layer || '0');
      },
      rect(x, y, w, h, layer, color) {
        this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, layer, color);
      },
      circle(cx, cy, r, layer, color) {
        if (!(r > 0)) return;
        ents.push('0', 'CIRCLE', '8', lay(layer || '0'), ...col(color), '10', f(cx), '20', f(cy), '30', '0', '40', f(r));
      },
      // (x, y) is the anchor point on the text baseline; anchor start|middle|end;
      // angle in degrees counter-clockwise.
      text(x, y, height, s, opt) {
        const o = opt || {};
        const str = DxfWriter.text(s);
        if (!str.trim() || !(height > 0)) return;
        const h = o.anchor === 'middle' ? 1 : o.anchor === 'end' ? 2 : 0;
        ents.push('0', 'TEXT', '8', lay(o.layer || 'TEXT'), ...col(o.color),
          '10', f(x), '20', f(y), '30', '0', '40', f(height), '1', str);
        if (o.angle) ents.push('50', f(((o.angle % 360) + 360) % 360));
        ents.push('7', 'STANDARD');
        if (h) ents.push('72', String(h), '11', f(x), '21', f(y), '31', '0');
      },
      toString() {
        const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009',
          '9', '$INSUNITS', '70', '4', '9', '$MEASUREMENT', '70', '1', '0', 'ENDSEC',
          '0', 'SECTION', '2', 'TABLES',
          '0', 'TABLE', '2', 'LTYPE', '70', '1',
          '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0',
          '0', 'ENDTAB',
          '0', 'TABLE', '2', 'LAYER', '70', String(Object.keys(L).length)];
        for (const [n, c] of Object.entries(L)) out.push('0', 'LAYER', '2', n, '70', '0', '62', String(c), '6', 'CONTINUOUS');
        out.push('0', 'ENDTAB',
          '0', 'TABLE', '2', 'STYLE', '70', '1',
          '0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0', '41', '1', '50', '0', '71', '0', '42', '2.5',
          '3', 'arial.ttf', '4', '',
          '0', 'ENDTAB', '0', 'ENDSEC',
          '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF');
        return out.join('\r\n') + '\r\n';
      },
    };
  },

  // ── SVG → DXF ──────────────────────────────────────────────────────
  // Strokes become polylines/circles/lines, text becomes aligned TEXT.
  // Light fills (the page and symbol backgrounds) are dropped; dark fill-only
  // shapes (dots, arrow heads) are kept as outlines. `scale` converts SVG
  // units to mm. Layers: TEXT, plus `geomLayer` (default SYMBOLS).
  fromSvg(svgText, opt) {
    const o = Object.assign({ scale: 0.25, geomLayer: 'SYMBOLS' }, opt || {});
    const docEl = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    if (!docEl || docEl.nodeName === 'parsererror' || docEl.getElementsByTagName('parsererror').length) return null;
    const vb = (docEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const H = vb.length === 4 && vb[3] > 0 ? vb[3] : (parseFloat(docEl.getAttribute('height')) || 0);
    const X0 = vb.length === 4 ? vb[0] : 0, Y0 = vb.length === 4 ? vb[1] : 0;
    const k = o.scale;
    const dxf = this.create({ TEXT: 7, [o.geomLayer]: 7 });
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const parseT = (str) => {
      let m = [1, 0, 0, 1, 0, 0];
      const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
      let t;
      while ((t = re.exec(str || ''))) {
        const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
        let n;
        if (t[1] === 'matrix' && a.length === 6) n = a;
        else if (t[1] === 'translate') n = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
        else if (t[1] === 'scale') n = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];
        else {
          const r = (a[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
          n = [c, s, -s, c, 0, 0];
          if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        }
        m = mul(m, n);
      }
      return m;
    };
    const style = (el, inh) => {
      const s = Object.assign({}, inh);
      const css = {};
      String(el.getAttribute('style') || '').split(';').forEach(p => {
        const i = p.indexOf(':');
        if (i > 0) css[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
      for (const key of ['stroke', 'fill', 'font-size', 'text-anchor', 'display']) {
        const v = css[key] != null ? css[key] : el.getAttribute(key);
        if (v != null && v !== '') s[key] = v;
      }
      return s;
    };
    const P = (m, x, y) => [(m[0] * x + m[2] * y + m[4] - X0) * k, (H - (m[1] * x + m[3] * y + m[5] - Y0)) * k];
    const strokeOf = (s) => {
      const st = this.parseColor(s.stroke);
      if (st) return st;
      // Fill-only: light fills are page/background; dark fills are kept.
      const f = this.parseColor(s.fill);
      return f && Math.min(f[0], f[1], f[2]) < 200 ? f : null;
    };
    const emitPoly = (pts, closed, s, m) => {
      const c = strokeOf(s);
      if (!c || pts.length < 2) return;
      dxf.poly(pts.map(p => P(m, p[0], p[1])), closed, o.geomLayer, this.aci(c));
    };
    const arcPts = (x1, y1, rx, ry, phi, fa, fs, x2, y2) => {
      if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x2, y2]];
      rx = Math.abs(rx); ry = Math.abs(ry);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
      const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
      const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
      if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
      const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
      const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
      const cxp = co * (rx * y1p / ry), cyp = co * (-ry * x1p / rx);
      const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
      let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
      if (!fs && dt > 0) dt -= 2 * Math.PI;
      if (fs && dt < 0) dt += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(dt) / (Math.PI / 18)));
      const pts = [];
      for (let i = 1; i <= n; i++) {
        const t = t1 + dt * i / n;
        pts.push([cp * rx * Math.cos(t) - sp * ry * Math.sin(t) + cx, sp * rx * Math.cos(t) + cp * ry * Math.sin(t) + cy]);
      }
      return pts;
    };
    // Path data → list of { pts, closed }.
    const pathSubs = (d) => {
      const tok = String(d || '').match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
      const subs = [];
      let cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, qx = 0, qy = 0, cx2 = 0, cy2 = 0;
      const num = () => parseFloat(tok[i++]);
      const start = (px, py) => { cur = { pts: [[px, py]], closed: false }; subs.push(cur); };
      while (i < tok.length) {
        if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
        else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
        const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
        if (C === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; } continue; }
        if (C === 'M') { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; sx = x; sy = y; start(x, y); }
        else if (!cur) start(x, y);
        if (C === 'L') { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; cur.pts.push([x, y]); }
        else if (C === 'H') { const a = num(); x = rel ? x + a : a; cur.pts.push([x, y]); }
        else if (C === 'V') { const a = num(); y = rel ? y + a : a; cur.pts.push([x, y]); }
        else if (C === 'C' || C === 'S') {
          let x1, y1;
          if (C === 'C') { const a = num(), b = num(); x1 = rel ? x + a : a; y1 = rel ? y + b : b; }
          else { x1 = 2 * x - cx2; y1 = 2 * y - cy2; }
          const a2 = num(), b2 = num(), a3 = num(), b3 = num();
          const x2 = rel ? x + a2 : a2, y2 = rel ? y + b2 : b2, x3 = rel ? x + a3 : a3, y3 = rel ? y + b3 : b3;
          for (let s = 1; s <= 12; s++) {
            const t = s / 12, u = 1 - t;
            cur.pts.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
              u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
          }
          cx2 = x2; cy2 = y2; x = x3; y = y3;
        } else if (C === 'Q' || C === 'T') {
          let x1, y1;
          if (C === 'Q') { const a = num(), b = num(); x1 = rel ? x + a : a; y1 = rel ? y + b : b; }
          else { x1 = 2 * x - qx; y1 = 2 * y - qy; }
          const a2 = num(), b2 = num();
          const x2 = rel ? x + a2 : a2, y2 = rel ? y + b2 : b2;
          for (let s = 1; s <= 10; s++) {
            const t = s / 10, u = 1 - t;
            cur.pts.push([u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2]);
          }
          qx = x1; qy = y1; x = x2; y = y2;
        } else if (C === 'A') {
          const rx = num(), ry = num(), rot = num(), fa = num(), fs = num(), a = num(), b = num();
          const ex = rel ? x + a : a, ey = rel ? y + b : b;
          for (const p of arcPts(x, y, rx, ry, rot * Math.PI / 180, !!fa, !!fs, ex, ey)) cur.pts.push(p);
          x = ex; y = ey;
        } else if (C !== 'M') break;
        if (C !== 'C' && C !== 'S') { cx2 = x; cy2 = y; }
        if (C !== 'Q' && C !== 'T') { qx = x; qy = y; }
      }
      return subs;
    };
    const num = (el, a) => parseFloat(el.getAttribute(a)) || 0;
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const emitText = (el, s, m, x, y) => {
      const str = textOf(el);
      if (!str) return;
      const c = this.parseColor(s.fill);
      const fs = (parseFloat(s['font-size']) || 10) * Math.hypot(m[2], m[3]);
      const [px, py] = P(m, x, y);
      dxf.text(px, py, fs * 0.72 * k, str, { anchor: s['text-anchor'] || 'start',
        angle: -Math.atan2(m[1], m[0]) * 180 / Math.PI, layer: 'TEXT', color: this.aci(c || [0, 0, 0]) });
    };
    const walk = (el, m0, inh) => {
      for (const el1 of Array.from(el.children)) {
        const tag = el1.localName;
        if (['defs', 'title', 'desc', 'style', 'clipPath', 'marker', 'symbol', 'mask', 'metadata'].includes(tag)) continue;
        const s = style(el1, inh);
        if (s.display === 'none') continue;
        const m = mul(m0, parseT(el1.getAttribute('transform')));
        if (tag === 'g' || tag === 'svg' || tag === 'a') walk(el1, m, s);
        else if (tag === 'line') {
          const c = strokeOf(s);
          if (c) { const a = P(m, num(el1, 'x1'), num(el1, 'y1')), b = P(m, num(el1, 'x2'), num(el1, 'y2'));
            dxf.line(a[0], a[1], b[0], b[1], o.geomLayer, this.aci(c)); }
        } else if (tag === 'rect') {
          const x = num(el1, 'x'), y = num(el1, 'y'), w = num(el1, 'width'), h = num(el1, 'height');
          if (w > 0 && h > 0) emitPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, s, m);
        } else if (tag === 'circle' || tag === 'ellipse') {
          const rx = num(el1, tag === 'circle' ? 'r' : 'rx'), ry = tag === 'circle' ? rx : num(el1, 'ry');
          const cx = num(el1, 'cx'), cy = num(el1, 'cy');
          const c = strokeOf(s);
          if (!c || !(rx > 0) || !(ry > 0)) continue;
          const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
          const uniform = Math.abs(sx - sy) < 1e-6 && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-6 && rx === ry;
          if (uniform) { const [px, py] = P(m, cx, cy); dxf.circle(px, py, rx * sx * k, o.geomLayer, this.aci(c)); }
          else {
            const pts = [];
            for (let i = 0; i < 36; i++) pts.push([cx + rx * Math.cos(i * Math.PI / 18), cy + ry * Math.sin(i * Math.PI / 18)]);
            emitPoly(pts, true, s, m);
          }
        } else if (tag === 'polyline' || tag === 'polygon') {
          const v = String(el1.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
          const pts = [];
          for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
          emitPoly(pts, tag === 'polygon', s, m);
        } else if (tag === 'path') {
          for (const sub of pathSubs(el1.getAttribute('d'))) emitPoly(sub.pts, sub.closed, s, m);
        } else if (tag === 'text') {
          const spans = Array.from(el1.children).filter(c => c.localName === 'tspan');
          const bx = parseFloat(el1.getAttribute('x')) || 0, by = parseFloat(el1.getAttribute('y')) || 0;
          if (spans.length && spans.some(c => c.hasAttribute('x') || c.hasAttribute('y'))) {
            let cx = bx, cy = by;
            for (const sp of spans) {
              if (sp.hasAttribute('x')) cx = parseFloat(sp.getAttribute('x')) || 0;
              if (sp.hasAttribute('y')) cy = parseFloat(sp.getAttribute('y')) || 0;
              else if (sp.hasAttribute('dy')) cy += parseFloat(sp.getAttribute('dy')) || 0;
              emitText(sp, style(sp, s), m, cx, cy);
            }
          } else emitText(el1, s, m, bx, by);
        }
      }
    };
    // The root's own width/height/viewBox are handled above; start unstyled.
    walk(docEl, [1, 0, 0, 1, 0, 0], { stroke: undefined, fill: 'black', 'font-size': '10', 'text-anchor': 'start' });
    return dxf.toString();
  },
};
