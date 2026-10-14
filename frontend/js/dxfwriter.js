/**
 * DxfExport — turns a page's SVG drawing into DXF (via the server's ezdxf
 * writer, R2010, millimetres, y up). Used by every drawing export: the main
 * single line, the Demand topology, the street-light schematic, the DB single
 * line and the DB general arrangement. (The Site/Floor plan export has its own
 * payload: plan-dxf.js.)
 *
 * The SVG is rendered off-screen inside a shadow root so computed styles —
 * CSS classes, inherited strokes, `var()` colours — resolve exactly as drawn,
 * without the page's own stylesheet leaking in. Then:
 *
 *  · strokes become LINE / LWPOLYLINE / CIRCLE, solid coloured fills a HATCH,
 *    light fills (page and symbol backgrounds, label patches) are dropped;
 *  · text becomes TEXT with its real alignment, unicode as is;
 *  · a group marked `data-dxf-block="TYPE"` becomes a BLOCK (one definition per
 *    distinct geometry: PP_TYPE, PP_TYPE_2 …) and an INSERT at the group's
 *    origin (`data-dxf-at="x,y"` moves the base point, in the group's own
 *    coordinates). Its `data-dxf-attrs` JSON {TAG: value} become invisible
 *    attributes; a text marked `data-dxf-attr="TAG"` inside the group — or
 *    anywhere with `data-dxf-owner="<the group's data-dxf-key>"` — becomes a
 *    VISIBLE attribute at the place it is drawn (a multi-line label gives
 *    TAG, TAG_2, …). A block inside a block is flattened into it.
 *  · `data-dxf-layer` names the layer for a subtree; `data-dxf-skip` drops it.
 */
const DxfExport = {
  // '#rgb' / '#rrggbb' / rgb() / rgba() / a few names → [r, g, b], or null for
  // none / fully transparent.
  parseColor(c) {
    if (c == null) return null;
    c = String(c).trim().toLowerCase();
    if (!c || c === 'none' || c === 'transparent') return null;
    const names = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
      blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 165, 0], yellow: [255, 255, 0] };
    if (names[c]) return names[c];
    let m = /^#([0-9a-f]{3})$/.exec(c);
    if (m) return m[1].split('').map(h => parseInt(h + h, 16));
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
    if (m) return m[2] === '00' ? null : [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c);
    if (m) {
      if (m[4] != null && parseFloat(m[4]) === 0) return null;
      return [+m[1], +m[2], +m[3]].map(v => Math.round(v));
    }
    return null;
  },

  _hex(rgb) { return rgb ? '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('') : null; },

  // A fill that is paper, not ink: white-ish or very pale.
  _light(rgb) {
    const [r, g, b] = rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 225;
  },

  // ── SVG → payload ────────────────────────────────────────────────────
  // opt: { scale (mm per SVG unit, default 0.25), fileName, layers {NAME: '#hex'},
  //        geomLayer (default 'DRAWING'), textLayer (default 'TEXT') }
  fromSvg(src, opt) {
    const o = Object.assign({ scale: 0.25, geomLayer: 'DRAWING', textLayer: 'TEXT' }, opt || {});
    let svg = src;
    if (typeof src === 'string') {
      const d = new DOMParser().parseFromString(src, 'image/svg+xml');
      if (!d.documentElement || d.getElementsByTagName('parsererror').length) return null;
      svg = d.documentElement;
    }
    // Off-screen, style-isolated mount (computed style needs a live node).
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const node = document.importNode(svg, true);
    root.appendChild(node);
    document.body.appendChild(host);
    try {
      return this._convert(node, o);
    } finally {
      host.remove();
    }
  },

  _convert(svgEl, o) {
    const k = o.scale;
    const vbA = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVb = vbA.length === 4 && vbA.every(isFinite) && vbA[3] > 0;
    const X0 = hasVb ? vbA[0] : 0, Y0 = hasVb ? vbA[1] : 0;
    const H = hasVb ? vbA[3] : (parseFloat(svgEl.getAttribute('height')) || 0);
    const layers = Object.assign({}, o.layers || {});
    const lay = (n) => { if (!(n in layers)) layers[n] = null; return n; };
    lay(o.geomLayer); lay(o.textLayer);

    const entities = [];
    const blockDefs = new Map();       // signature → name
    const blocks = [];
    const nameCount = {};
    const inserts = new Map();         // data-dxf-key → insert (for owner-linked labels)
    const pendingOwned = [];           // [{key, attribs}] labels met before their owner

    const I = [1, 0, 0, 1, 0, 0];
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const own = (el) => {
      const tl = el.transform && el.transform.baseVal;
      const t = tl && tl.numberOfItems ? tl.consolidate() : null;
      let m = t ? [t.matrix.a, t.matrix.b, t.matrix.c, t.matrix.d, t.matrix.e, t.matrix.f] : I;
      if (el.localName === 'svg' && el !== svgEl) {
        m = mul(m, [1, 0, 0, 1, parseFloat(el.getAttribute('x')) || 0, parseFloat(el.getAttribute('y')) || 0]);
      }
      return m;
    };
    const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    // Page → mm, y up.
    const W = (p) => [(p[0] - X0) * k, (H - (p[1] - Y0)) * k];
    const r3 = (v) => Math.round(v * 1000) / 1000;

    // Output target: the page (world mm) or the open block. Block geometry is
    // in real millimetres too (inserted at scale 1), so a linetype inside a
    // block reads the same in every CAD package — viewers disagree on whether
    // an insert's scale also scales its linetype patterns.
    let blk = null;   // { ents, lm (matrix from element space → block-local SVG units), key, attribs }
    const emitPt = (m, lm, x, y) => blk ? (() => { const q = ap(lm, x, y); return [r3(q[0] * k), r3(-q[1] * k)]; })() : W(ap(m, x, y)).map(r3);
    // Dash patterns → named linetypes (lengths in mm at the drawing's scale);
    // an element drawn larger or smaller than 1:1 carries it as its ltscale.
    const linetypes = {};
    const linetypeOf = (str) => {
      const v = String(str || 'none') === 'none' ? [] : String(str).split(/[\s,]+/).map(x => parseFloat(x)).filter(x => isFinite(x) && x >= 0);
      if (!v.length || v.every(x => x === 0)) return null;
      const pat = v.length % 2 ? v.concat(v) : v;        // SVG repeats an odd list
      const tag = pat.map(x => String(Math.round(x * 100) / 100).replace('.', 'P')).join('_');
      const name = ('PP_DASH_' + tag).slice(0, 60);
      if (!linetypes[name]) linetypes[name] = pat.map(x => r3(x * k));
      return name;
    };
    const out = (e) => { if (blk) blk.ents.push(e); else entities.push(e); };

    const cs = (el) => getComputedStyle(el);
    const num = (el, a) => parseFloat(el.getAttribute(a)) || 0;
    const effOpacity = (el) => {
      let v = 1;
      for (let n = el; n && n !== svgEl.parentNode; n = n.parentNode) {
        if (n.nodeType !== 1) break;
        const op = parseFloat(getComputedStyle(n).opacity);
        if (isFinite(op)) v *= op;
      }
      return v;
    };

    const paint = (el, m, lm) => {
      const st = cs(el);
      const op = effOpacity(el);
      const so = (parseFloat(st.strokeOpacity) || (st.strokeOpacity === '0' ? 0 : 1)) * op;
      const fo = (parseFloat(st.fillOpacity) || (st.fillOpacity === '0' ? 0 : 1)) * op;
      const stroke = so >= 0.15 ? this.parseColor(st.stroke) : null;
      let fill = fo >= 0.15 ? this.parseColor(st.fill) : null;
      if (fill && this._light(fill)) fill = null;
      const s = scaleOf(blk ? lm : m);
      const worldS = scaleOf(m) * k;
      const sw = (parseFloat(st.strokeWidth) || 1) * worldS;
      const lt = linetypeOf(st.strokeDasharray);
      return {
        stroke, fill: fill && fo >= 0.5 ? fill : null, fillLine: fill,
        lw: sw >= 0.35 ? r3(sw) : null,
        linetype: lt, ltscale: lt ? r3(blk ? scaleOf(lm) : scaleOf(m)) : null, s,
      };
    };
    const layerOf = (el, inh) => el.getAttribute && el.getAttribute('data-dxf-layer') ? lay(el.getAttribute('data-dxf-layer')) : inh;

    const emitShape = (pts, closed, pt, layer) => {
      const col = pt.stroke || pt.fillLine;
      if (!col || pts.length < 2) return;
      const e = { t: 'poly', pts, closed: !!closed, layer, color: this._hex(col) };
      if (pt.lw) e.lw = pt.lw;
      if (pt.linetype) { e.linetype = pt.linetype; if (pt.ltscale !== 1) e.ltscale = pt.ltscale; }
      if (closed && pt.fill) e.fill = this._hex(pt.fill);
      out(e);
    };

    // Path data → [{pts, closed}] in element space.
    const pathSubs = (d) => {
      const tok = String(d || '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
      const subs = [];
      let cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, qx = 0, qy = 0, cx2 = 0, cy2 = 0;
      const n = () => parseFloat(tok[i++]);
      const start = (px, py) => { cur = { pts: [[px, py]], closed: false }; subs.push(cur); };
      const arcPts = (x1, y1, rx, ry, phi, fa, fs, x2, y2) => {
        if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x2, y2]];
        rx = Math.abs(rx); ry = Math.abs(ry);
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
        const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
        const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
        const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
        const cxp = co * (rx * y1p / ry), cyp = co * (-ry * x1p / rx);
        const ccx = cp * cxp - sp * cyp + (x1 + x2) / 2, ccy = sp * cxp + cp * cyp + (y1 + y2) / 2;
        const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!fs && dt > 0) dt -= 2 * Math.PI;
        if (fs && dt < 0) dt += 2 * Math.PI;
        const steps = Math.max(2, Math.ceil(Math.abs(dt) / (Math.PI / 18)));
        const pts = [];
        for (let j = 1; j <= steps; j++) {
          const t = t1 + dt * j / steps;
          pts.push([cp * rx * Math.cos(t) - sp * ry * Math.sin(t) + ccx, sp * rx * Math.cos(t) + cp * ry * Math.sin(t) + ccy]);
        }
        return pts;
      };
      while (i < tok.length) {
        if (/^[a-zA-Z]$/.test(tok[i])) cmd = tok[i++];
        else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
        if (!cmd) { i++; continue; }
        const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
        if (C === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; cur = null; } continue; }
        if (C === 'M') { const a = n(), b = n(); x = rel ? x + a : a; y = rel ? y + b : b; sx = x; sy = y; start(x, y); }
        else if (!cur) start(x, y);
        if (C === 'L') { const a = n(), b = n(); x = rel ? x + a : a; y = rel ? y + b : b; cur.pts.push([x, y]); }
        else if (C === 'H') { const a = n(); x = rel ? x + a : a; cur.pts.push([x, y]); }
        else if (C === 'V') { const a = n(); y = rel ? y + a : a; cur.pts.push([x, y]); }
        else if (C === 'C' || C === 'S') {
          let x1, y1;
          if (C === 'C') { const a = n(), b = n(); x1 = rel ? x + a : a; y1 = rel ? y + b : b; } else { x1 = 2 * x - cx2; y1 = 2 * y - cy2; }
          const a2 = n(), b2 = n(), a3 = n(), b3 = n();
          const x2 = rel ? x + a2 : a2, y2 = rel ? y + b2 : b2, x3 = rel ? x + a3 : a3, y3 = rel ? y + b3 : b3;
          for (let s = 1; s <= 12; s++) {
            const t = s / 12, u = 1 - t;
            cur.pts.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
              u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
          }
          cx2 = x2; cy2 = y2; x = x3; y = y3;
        } else if (C === 'Q' || C === 'T') {
          let x1, y1;
          if (C === 'Q') { const a = n(), b = n(); x1 = rel ? x + a : a; y1 = rel ? y + b : b; } else { x1 = 2 * x - qx; y1 = 2 * y - qy; }
          const a2 = n(), b2 = n();
          const x2 = rel ? x + a2 : a2, y2 = rel ? y + b2 : b2;
          for (let s = 1; s <= 10; s++) {
            const t = s / 10, u = 1 - t;
            cur.pts.push([u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2]);
          }
          qx = x1; qy = y1; x = x2; y = y2;
        } else if (C === 'A') {
          const rx = n(), ry = n(), rot = n(), fa = n(), fs = n(), a = n(), b = n();
          const ex = rel ? x + a : a, ey = rel ? y + b : b;
          for (const p of arcPts(x, y, rx, ry, rot * Math.PI / 180, !!fa, !!fs, ex, ey)) cur.pts.push(p);
          x = ex; y = ey;
        } else if (C !== 'M') break;
        if (C !== 'C' && C !== 'S') { cx2 = x; cy2 = y; }
        if (C !== 'Q' && C !== 'T') { qx = x; qy = y; }
      }
      return subs;
    };

    // One text run (a <text> or positioned <tspan>) → a TEXT, or an attribute
    // record when `attrTag` is given.
    const textRun = (el, styleEl, m, lm, x, y, layer, attrTag) => {
      const str = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!str) return null;
      const st = cs(styleEl);
      if (parseFloat(st.fillOpacity) === 0 || st.visibility === 'hidden') return null;
      const fs = parseFloat(st.fontSize) || 10;
      const db = st.dominantBaseline || styleEl.getAttribute('dominant-baseline') || '';
      let valign = 'baseline';
      if (/middle|central/.test(db)) valign = 'middle';
      else if (/hanging|text-before-edge/.test(db)) y += fs * 0.8;
      const anchor = st.textAnchor || 'start';
      const align = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
      const col = this.parseColor(st.fill);
      const mm = blk && !attrTag ? lm : m;
      const at = blk && !attrTag ? emitPt(m, lm, x, y) : W(ap(m, x, y)).map(r3);
      const sc = blk && !attrTag ? scaleOf(lm) * k : scaleOf(m) * k;
      const rot = r3(-Math.atan2(mm[1], mm[0]) * 180 / Math.PI);
      const rec = { at, h: r3(fs * 0.72 * sc), s: str, align, valign, rot, layer, color: this._hex(col) };
      if (attrTag) return { tag: attrTag, value: str, at: rec.at, h: rec.h, align, valign, rot: rec.rot, color: rec.color, layer };
      out(Object.assign({ t: 'text' }, rec));
      return null;
    };

    const emitText = (el, m, lm, layer) => {
      const tag = el.getAttribute('data-dxf-attr');
      const ownerKey = el.getAttribute('data-dxf-owner');
      const asAttr = tag && (blk || ownerKey);
      const spans = Array.from(el.children).filter(c => c.localName === 'tspan');
      const bx = parseFloat(el.getAttribute('x')) || 0, by = parseFloat(el.getAttribute('y')) || 0;
      const runs = [];
      if (spans.length && spans.some(c => c.hasAttribute('x') || c.hasAttribute('y') || c.hasAttribute('dy'))) {
        let cx = bx, cy = by;
        for (const sp of spans) {
          if (sp.hasAttribute('x')) cx = parseFloat(sp.getAttribute('x')) || 0;
          if (sp.hasAttribute('y')) cy = parseFloat(sp.getAttribute('y')) || 0;
          if (sp.hasAttribute('dy')) cy += parseFloat(sp.getAttribute('dy')) || 0;
          runs.push([sp, cx, cy]);
        }
      } else runs.push([el, bx, by]);
      const attribs = [];
      runs.forEach(([node, x, y], i) => {
        const t = asAttr ? (i ? `${tag}_${i + 1}` : tag) : null;
        const r = textRun(node, node === el ? el : node, m, lm, x, y, layer, t);
        if (r) attribs.push(r);
      });
      if (!attribs.length) return;
      if (blk && !ownerKey) blk.attribs.push(...attribs);
      else if (ownerKey) {
        const ins = inserts.get(ownerKey);
        if (ins) ins.attribs.unshift(...attribs); else pendingOwned.push({ key: ownerKey, attribs });
      }
    };

    const SKIP = new Set(['defs', 'title', 'desc', 'style', 'clipPath', 'marker', 'symbol', 'mask',
      'metadata', 'foreignObject', 'image', 'script', 'pattern', 'linearGradient', 'radialGradient', 'filter']);

    const walk = (el, m0, lm0, layer0) => {
      for (const c of Array.from(el.children)) {
        const tag = c.localName;
        if (SKIP.has(tag) || c.hasAttribute('data-dxf-skip')) continue;
        const st = cs(c);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const t = own(c);
        let m = mul(m0, t), lm = blk ? mul(lm0, t) : lm0;
        const layer = layerOf(c, layer0);

        if (tag === 'g' || tag === 'svg' || tag === 'a') {
          const bt = c.getAttribute('data-dxf-block');
          if (bt && !blk) {
            const atS = String(c.getAttribute('data-dxf-at') || '').split(/[\s,]+/).map(Number);
            const atL = atS.length === 2 && atS.every(isFinite) ? atS : [0, 0];
            const F = mul(m, [1, 0, 0, 1, atL[0], atL[1]]);
            let data = {};
            try { data = JSON.parse(c.getAttribute('data-dxf-attrs') || '{}') || {}; } catch (_) { data = {}; }
            // The group's own scale is baked into the block geometry, so every
            // insert is at scale 1 (−1 in y when mirrored): dash patterns and
            // text then read the same in every CAD package.
            const gsx = Math.hypot(F[0], F[1]) || 1;
            const gdet = F[0] * F[3] - F[1] * F[2];
            const gsy = Math.abs(gdet) / gsx || 1;
            blk = { ents: [], attribs: [], key: c.getAttribute('data-dxf-key') };
            walk(c, m, [gsx, 0, 0, gsy, -gsx * atL[0], -gsy * atL[1]], lay(c.getAttribute('data-dxf-layer') || 'SYMBOLS'));
            const b = blk; blk = null;
            if (!b.ents.length) {
              // Nothing drawn: keep its labels as plain text.
              for (const a of b.attribs) entities.push({ t: 'text', at: a.at, h: a.h, s: a.value, align: a.align, valign: a.valign, rot: a.rot, layer: a.layer, color: a.color });
              continue;
            }
            const sig = JSON.stringify(b.ents);
            const base = 'PP_' + String(bt).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
            let name = blockDefs.get(sig);
            if (!name) {
              nameCount[base] = (nameCount[base] || 0) + 1;
              name = nameCount[base] === 1 ? base : `${base}_${nameCount[base]}`;
              blockDefs.set(sig, name);
              blocks.push({ name, entities: b.ents });
            }
            const O = W(ap(F, 0, 0));
            const ins = { t: 'insert', name, at: O.map(r3), sx: 1, sy: gdet < 0 ? -1 : 1,
              rot: r3(-Math.atan2(F[1], F[0]) * 180 / Math.PI), layer: lay(c.getAttribute('data-dxf-layer') || 'SYMBOLS'),
              attribs: b.attribs.slice() };
            const have = new Set(ins.attribs.map(a => a.tag));
            for (const [tg, v] of Object.entries(data)) {
              const T = String(tg).toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
              if (!T || have.has(T) || v == null || v === '') continue;
              have.add(T);
              ins.attribs.push({ tag: T, value: String(v), invisible: true, at: O.map(r3), h: 2 });
            }
            entities.push(ins);
            if (b.key) inserts.set(b.key, ins);
            continue;
          }
          walk(c, m, lm, layer);
          continue;
        }
        // Loose text goes on the text layer unless a subtree names its own.
        if (tag === 'text') { emitText(c, m, lm, blk || layer !== o.geomLayer ? layer : lay(o.textLayer)); continue; }
        const pt = paint(c, m, lm);
        if (!pt.stroke && !pt.fillLine) continue;
        const P = (x, y) => emitPt(m, lm, x, y);
        if (tag === 'line') {
          const col = pt.stroke;
          if (!col) continue;
          const e = { t: 'line', a: P(num(c, 'x1'), num(c, 'y1')), b: P(num(c, 'x2'), num(c, 'y2')), layer, color: this._hex(col) };
          if (pt.lw) e.lw = pt.lw;
          if (pt.linetype) { e.linetype = pt.linetype; if (pt.ltscale !== 1) e.ltscale = pt.ltscale; }
          out(e);
        } else if (tag === 'rect') {
          const x = num(c, 'x'), y = num(c, 'y'), w = num(c, 'width'), h = num(c, 'height');
          if (w > 0 && h > 0) emitShape([P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)], true, pt, layer);
        } else if (tag === 'circle' || tag === 'ellipse') {
          const rx = num(c, tag === 'circle' ? 'r' : 'rx'), ry = tag === 'circle' ? rx : num(c, 'ry');
          const cx = num(c, 'cx'), cy = num(c, 'cy');
          if (!(rx > 0) || !(ry > 0)) continue;
          const mm = blk ? lm : m;
          const s1 = Math.hypot(mm[0], mm[1]), s2 = Math.hypot(mm[2], mm[3]);
          const uniform = rx === ry && Math.abs(s1 - s2) < 1e-6 && Math.abs(mm[0] * mm[2] + mm[1] * mm[3]) < 1e-6;
          if (uniform) {
            const e = { t: 'circle', c: P(cx, cy), r: r3(rx * s1 * k), layer, color: this._hex(pt.stroke || pt.fillLine) };
            if (pt.lw) e.lw = pt.lw;
            if (pt.linetype) { e.linetype = pt.linetype; if (pt.ltscale !== 1) e.ltscale = pt.ltscale; }
            if (pt.fill) e.fill = this._hex(pt.fill);
            out(e);
          } else {
            const pts = [];
            for (let j = 0; j < 36; j++) pts.push(P(cx + rx * Math.cos(j * Math.PI / 18), cy + ry * Math.sin(j * Math.PI / 18)));
            emitShape(pts, true, pt, layer);
          }
        } else if (tag === 'polyline' || tag === 'polygon') {
          const v = String(c.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
          const pts = [];
          for (let j = 0; j + 1 < v.length; j += 2) pts.push(P(v[j], v[j + 1]));
          emitShape(pts, tag === 'polygon', pt, layer);
        } else if (tag === 'path') {
          for (const sub of pathSubs(c.getAttribute('d'))) emitShape(sub.pts.map(p => P(p[0], p[1])), sub.closed, pt, layer);
        }
      }
    };

    walk(svgEl, I, I, lay(o.geomLayer));
    for (const p of pendingOwned) {
      const ins = inserts.get(p.key);
      if (ins) ins.attribs.unshift(...p.attribs);
      else for (const a of p.attribs) entities.push({ t: 'text', at: a.at, h: a.h, s: a.value, align: a.align, valign: a.valign, rot: a.rot, layer: a.layer, color: a.color });
    }
    return { fileName: o.fileName || 'drawing', title: o.title || '', layers, linetypes, blocks, entities };
  },

  // ── Server round trip + download ─────────────────────────────────────
  async download(payload) {
    if (!payload) { UI.alert('Nothing to export.'); return false; }
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, 'Exporting DXF…');
    try {
      const resp = await fetch(`${API_BASE}/drawing/dxf-export`, {
        method: 'POST', headers: API.authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = String(payload.fileName || 'drawing').replace(/[\\/:*?"<>|]+/g, '_') + '.dxf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      UI.alert('DXF export failed: ' + (e && e.message ? e.message : e));
      return false;
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // SVG (string or element) → DXF file download.
  exportSvg(src, opt) {
    const payload = this.fromSvg(src, opt);
    if (!payload) { UI.alert('Could not read the drawing for DXF export.'); return Promise.resolve(false); }
    return this.download(payload);
  },
};
