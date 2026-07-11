/* ProtectionPro — Plan Markup device symbols.
 *
 * Glyph shapes replicated from the source apps so the markup canvas reads the
 * same as the originals: reticulation symbols from Retic Builder Pro's site-
 * plan renderer (kiosk = labelled filled box, minisub = diagonally-split
 * transformer box, erf = ✕, pole/rmu/manhole = lettered discs), and building
 * symbols from Distribution Designer Pro's `_seDefaultElements` (socket = disc
 * with a stub, switch = disc + angled throw, DB = rectangle, isolator, light =
 * disc with a cross, etc.).
 *
 * Each recipe is a list of primitives in a 40×40 art box centred at (20,20)
 * (the same space the source uses). `size` is the glyph's full extent in world
 * pixels — constant world size, so glyphs scale with zoom exactly as the
 * originals do. Colours resolve 'col' → element colour, 'bg' → canvas
 * background, 'faint' → col at ~20% alpha.
 */

const PlanSymbols = {
  // c=circle, l=line, r=rect, p=polygon, t=text. f=fill, s=stroke, w=strokeWidth.
  RECIPES: {
    // ── Reticulation (Retic Builder Pro) ──
    kiosk: { size: 34, prims: [
      { k: 'r', x: 4, y: 8, w: 32, h: 24, f: 'col', s: 'faintLine', w: 1 },
      { k: 't', x: 20, y: 20, str: 'K', size: 13, f: 'white', bold: 1 },
    ] },
    minisub: { size: 40, prims: [
      { k: 'p', pts: [[38, 6], [38, 34], [2, 34]], f: 'col' },
      { k: 'p', pts: [[2, 6], [38, 6], [2, 34]], f: 'bg' },
      { k: 'r', x: 2, y: 6, w: 36, h: 28, s: 'col', w: 1.5 },
      { k: 'l', x1: 38, y1: 6, x2: 2, y2: 34, s: 'col', w: 1.5 },
      { k: 't', x: 20, y: 20, str: 'TX', size: 9, f: 'col', bold: 1 },
    ] },
    rmu: { size: 26, prims: [
      { k: 'c', cx: 20, cy: 20, r: 13, f: 'col' },
      { k: 't', x: 20, y: 20, str: 'RMU', size: 8, f: 'white', bold: 1 },
    ] },
    manhole: { size: 26, prims: [
      { k: 'c', cx: 20, cy: 20, r: 13, f: 'col' },
      { k: 't', x: 20, y: 20, str: 'MH', size: 9, f: 'white', bold: 1 },
    ] },
    pole: { size: 16, prims: [
      { k: 'c', cx: 20, cy: 20, r: 8, f: 'col' },
      { k: 't', x: 20, y: 20, str: 'P', size: 9, f: 'white', bold: 1 },
    ] },
    erf: { size: 18, prims: [
      { k: 'l', x1: 12, y1: 12, x2: 28, y2: 28, s: 'col', w: 2.5, cap: 'round' },
      { k: 'l', x1: 28, y1: 12, x2: 12, y2: 28, s: 'col', w: 2.5, cap: 'round' },
    ] },

    // ── Building distribution (Distribution Designer Pro) ──
    bd_db: { size: 34, prims: [{ k: 'r', x: 4, y: 8, w: 32, h: 24, f: 'faint', s: 'col', w: 1.8 }, { k: 't', x: 20, y: 20, str: 'DB', size: 9, f: 'col', bold: 1 }] },
    bd_transformer: { size: 30, prims: [
      { k: 'c', cx: 15, cy: 20, r: 8, s: 'col', w: 1.5 },
      { k: 'c', cx: 25, cy: 20, r: 8, s: 'col', w: 1.5 },
    ] },
    bd_generator: { size: 26, prims: [{ k: 'c', cx: 20, cy: 20, r: 12, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'G', size: 11, f: 'col', bold: 1 }] },
    bd_utility: { size: 26, prims: [{ k: 'c', cx: 20, cy: 20, r: 12, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'U', size: 11, f: 'col', bold: 1 }] },
    bd_riser: { size: 30, prims: [
      { k: 'r', x: 12, y: 8, w: 16, h: 24, s: 'col', w: 1.5 },
      { k: 'l', x1: 20, y1: 8, x2: 20, y2: 32, s: 'col', w: 1 },
    ] },
    bd_jb: { size: 16, prims: [{ k: 'c', cx: 20, cy: 20, r: 6, f: 'faint', s: 'col', w: 1.5 }] },
    // bd_light / bd_socket / bd_switch are parametric "dynamic-block" families —
    // their glyph is computed from props by _light/_socket/_switch (below).
    bd_isolator: { size: 24, prims: '__isolator__' },
    bd_fcu: { size: 24, prims: [
      { k: 'r', x: 9, y: 14, w: 22, h: 12, s: 'col', w: 1.5 },
      { k: 't', x: 20, y: 20, str: 'FU', size: 7, f: 'col', bold: 1 },
    ] },
    bd_smoke: { size: 24, prims: [{ k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'S', size: 9, f: 'col', bold: 1 }] },
    bd_heat: { size: 24, prims: [{ k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'H', size: 9, f: 'col', bold: 1 }] },
    bd_call: { size: 24, prims: [{ k: 'r', x: 8, y: 8, w: 24, h: 24, f: 'faint', s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'MCP', size: 6, f: 'col', bold: 1 }] },
    bd_cctv: { size: 24, prims: [
      { k: 'c', cx: 15, cy: 20, r: 5, f: 'col' },
      { k: 'p', pts: [[20, 20], [36, 12], [36, 28]], f: 'faint', s: 'col', w: 1 },
    ] },
    bd_datapoint: { size: 26, prims: [{ k: 'p', pts: [[20, 6], [34, 20], [20, 34], [6, 20]], s: 'col', w: 1.5, close: 1 }] },
    bd_wap: { size: 22, prims: [{ k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'AP', size: 7, f: 'col', bold: 1 }] },
    bd_sensor: { size: 24, prims: [{ k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'PIR', size: 6, f: 'col', bold: 1 }] },
    bd_dali: { size: 30, prims: [{ k: 'r', x: 6, y: 10, w: 28, h: 20, s: 'col', w: 1.5 }, { k: 't', x: 20, y: 20, str: 'DALI', size: 7, f: 'col', bold: 1 }] },
  },

  // Glyph extent (world px). Parametric families size by their variant.
  size(type, props) {
    props = props || {};
    if (type === 'bd_light') return { downlight: 20, batten: 34, floodlight: 26, exit: 30, highbay: 24, wall: 24, emergency: 24, ceiling: 24 }[props.kind] || 24;
    if (type === 'bd_socket') return props.gangs === '3' ? 26 : props.gangs === '2' ? 24 : 22;
    if (type === 'bd_switch') return 22;
    const r = this.RECIPES[type];
    return r ? r.size : 24;
  },

  // ─── Parametric "dynamic-block" families (permutations from props) ───
  _socket(props) {
    const c = 20, sw = 1.5, gangs = parseInt(props.gangs || '1', 10) || 1;
    const out = [{ k: 'c', cx: c, cy: c, r: 9, s: 'col', w: sw }, { k: 'l', x1: c, y1: c - 5, x2: c, y2: c + 5, s: 'col', w: sw }];
    if (gangs >= 2) out.push({ k: 'l', x1: c + 9, y1: c - 6, x2: c + 9, y2: c + 6, s: 'col', w: sw });
    if (gangs >= 3) out.push({ k: 'l', x1: c + 12, y1: c - 4, x2: c + 12, y2: c + 4, s: 'col', w: sw });
    if (props.weatherproof) out.push({ k: 't', x: c, y: 33, str: 'WP', size: 6, f: 'col' });
    return out;
  },
  _switch(props) {
    const c = 20, sw = 1.5, bR = 5, lineLen = 12, tipR = 4;
    const kind = props.kind || 'standard';
    const gangs = parseInt(props.gangs || '1', 10) || 1;
    const tw = kind === '2way', ii = kind === 'intermediate';
    const isPIR = kind === 'pir', isTimer = kind === 'timer', isKey = kind === 'key', isDim = kind === 'dimmer', isPhoto = kind === 'photocell';
    const out = [];
    if (tw || ii) {
      out.push({ k: 'c', cx: c, cy: c, r: bR, f: 'col', s: 'col', w: sw * 0.8 });
      out.push({ k: 't', x: c, y: c, str: ii ? 'X' : '2', size: 6, f: 'bg', bold: 1 });
    } else {
      out.push({ k: 'c', cx: c, cy: c, r: bR, s: 'col', w: sw });
    }
    if (isPIR || isTimer || isKey || isDim || isPhoto) {
      const a = -60 * Math.PI / 180;
      const sx = c + Math.cos(a) * bR, sy = c + Math.sin(a) * bR;
      const tx = c + Math.cos(a) * (bR + lineLen), ty = c + Math.sin(a) * (bR + lineLen);
      out.push({ k: 'l', x1: sx, y1: sy, x2: tx, y2: ty, s: 'col', w: sw });
      if (isDim) {
        const dimR = 5, lcX = tx + Math.cos(a) * dimR, lcY = ty + Math.sin(a) * dimR;
        out.push({ k: 'c', cx: lcX, cy: lcY, r: dimR, s: 'col', w: sw });
        out.push({ k: 't', x: lcX, y: lcY, str: 'D', size: 7, f: 'col' });
      } else {
        const lbl = isPIR ? 'P' : isTimer ? 'T' : isKey ? 'K' : '☀';
        const lcX = tx + Math.cos(a) * tipR, lcY = ty + Math.sin(a) * tipR;
        out.push({ k: 'c', cx: lcX, cy: lcY, r: tipR, s: 'col', w: sw });
        out.push({ k: 't', x: lcX, y: lcY, str: lbl, size: isPhoto ? 5 : 6, f: 'col' });
      }
    } else if (!tw && !ii) {
      const spread = gangs === 1 ? 0 : gangs === 2 ? 20 : 15, baseAngle = -60;
      for (let g = 0; g < gangs; g++) {
        const a = (baseAngle - (gangs - 1) * spread / 2 + g * spread) * Math.PI / 180;
        out.push({ k: 'l', x1: c + Math.cos(a) * bR, y1: c + Math.sin(a) * bR, x2: c + Math.cos(a) * (bR + lineLen), y2: c + Math.sin(a) * (bR + lineLen), s: 'col', w: sw });
      }
    }
    return out;
  },
  _light(props) {
    const c = 20, sw = 1.5, kind = props.kind || 'ceiling';
    if (kind === 'downlight') return [{ k: 'c', cx: c, cy: c, r: 8, f: 'col' }];
    if (kind === 'batten') return [{ k: 'r', x: 2, y: 16, w: 36, h: 8, f: 'col', s: 'col', w: 0.7 }];
    if (kind === 'floodlight') return [{ k: 'p', pts: [[20, 8], [30, 28], [10, 28]], s: 'col', w: sw, close: 1 }];
    if (kind === 'emergency') return [{ k: 'c', cx: c, cy: c, r: 10, s: 'col', w: sw }, { k: 'c', cx: c, cy: c, r: 3, f: 'col' }];
    if (kind === 'exit') return [{ k: 'r', x: 8, y: 12, w: 24, h: 16, s: 'col', w: sw }, { k: 't', x: c, y: 20, str: 'EXIT', size: 6, f: 'col', bold: 1 }];
    if (kind === 'wall') return [{ k: 'a', cx: c, cy: c, r: 12, a0: Math.PI, a1: 0, ccw: true, s: 'col', w: sw }, { k: 'l', x1: 8, y1: 20, x2: 32, y2: 20, s: 'col', w: sw }];
    if (kind === 'highbay') return [{ k: 'c', cx: c, cy: c, r: 10, s: 'col', w: sw * 1.5 }, { k: 't', x: c, y: c, str: 'H', size: 10, f: 'col', bold: 1 }];
    // ceiling / surface (default)
    return [{ k: 'c', cx: c, cy: c, r: 10, s: 'col', w: sw }, { k: 'l', x1: 13, y1: 13, x2: 27, y2: 27, s: 'col', w: sw }, { k: 'l', x1: 27, y1: 13, x2: 13, y2: 27, s: 'col', w: sw }];
  },

  // Procedural recipes ported verbatim from Distribution Designer's
  // _seDefaultElements (switch throws / isolator disconnect).
  _procedural(name) {
    const c = 20, sw = 1.5;
    if (name === '__isolator__') {
      const r2 = 9, ri = 4, sp2 = 3, ll2 = 5, sq2 = Math.SQRT2;
      const rot = (x, y) => [c + (x - y) / sq2, c + (x + y) / sq2];
      const out = [{ k: 'c', cx: c, cy: c, r: r2, s: 'col', w: sw }, { k: 'c', cx: c, cy: c, r: ri, f: 'col' }];
      for (const dy of [-sp2, 0, sp2]) {
        let a = rot(-r2 - ll2, dy), b = rot(-r2, dy), d = rot(r2, dy), e = rot(r2 + ll2, dy);
        out.push({ k: 'l', x1: a[0], y1: a[1], x2: b[0], y2: b[1], s: 'col', w: sw });
        out.push({ k: 'l', x1: d[0], y1: d[1], x2: e[0], y2: e[1], s: 'col', w: sw });
      }
      return out;
    }
    // switch: circle base + one/two angled throws at -60°
    const bR = 5, lineLen = 12;
    const throwAt = (angleDeg) => {
      const a = angleDeg * Math.PI / 180;
      return { k: 'l', x1: c + Math.cos(a) * bR, y1: c + Math.sin(a) * bR, x2: c + Math.cos(a) * (bR + lineLen), y2: c + Math.sin(a) * (bR + lineLen), s: 'col', w: sw };
    };
    if (name === '__sw1__') return [{ k: 'c', cx: c, cy: c, r: bR, s: 'col', w: sw }, throwAt(-60)];
    if (name === '__sw2__') return [{ k: 'c', cx: c, cy: c, r: bR, s: 'col', w: sw }, throwAt(-70), throwAt(-50)];
    if (name === '__dim__') {
      const a = -60 * Math.PI / 180;
      const tipX = c + Math.cos(a) * (bR + lineLen), tipY = c + Math.sin(a) * (bR + lineLen);
      const lc = 5, lcX = tipX + Math.cos(a) * lc, lcY = tipY + Math.sin(a) * lc;
      return [{ k: 'c', cx: c, cy: c, r: bR, s: 'col', w: sw }, throwAt(-60),
        { k: 'c', cx: lcX, cy: lcY, r: lc, s: 'col', w: sw }, { k: 't', x: lcX, y: lcY, str: 'D', size: 7, f: 'col' }];
    }
    return [{ k: 'c', cx: c, cy: c, r: 10, s: 'col', w: sw }];
  },

  prims(type, props) {
    props = props || {};
    if (type === 'bd_light') return this._light(props);
    if (type === 'bd_socket') return this._socket(props);
    if (type === 'bd_switch') return this._switch(props);
    const r = this.RECIPES[type];
    if (!r) return null;
    return (typeof r.prims === 'string') ? this._procedural(r.prims) : r.prims;
  },

  // Family types have no static RECIPE entry — report them as drawable.
  has(type) { return type === 'bd_light' || type === 'bd_socket' || type === 'bd_switch' || !!this.RECIPES[type]; },

  _resolve(v, ctxCol, bg) {
    if (v === 'col') return ctxCol;
    if (v === 'bg') return bg;
    if (v === 'faint') return ctxCol + '2e';
    if (v === 'faintLine') return '#00000020';
    if (v === 'white') return '#ffffff';
    return v || 'none';
  },

  // Draw a glyph centred at the current context origin (already translated/
  // rotated to the element). `sizeWorld` is the full extent in world px.
  draw(ctx, type, opts) {
    const prims = this.prims(type, opts.props);
    if (!prims) return false;
    const col = opts.color || '#6b7280';
    const bg = opts.bg || '#ffffff';
    const sizeWorld = opts.sizeWorld || this.size(type, opts.props);
    const s = sizeWorld / 40;
    ctx.save();
    ctx.scale(s, s);
    ctx.translate(-20, -20);      // art box (0..40) centred on origin
    for (const p of prims) {
      const fill = p.f ? this._resolve(p.f, col, bg) : null;
      const stroke = p.s ? this._resolve(p.s, col, bg) : null;
      ctx.lineWidth = (p.w || 1.2);
      ctx.lineCap = p.cap || 'butt';
      if (p.k === 'c') {
        ctx.beginPath(); ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
        if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke && stroke !== 'none') { ctx.strokeStyle = stroke; ctx.stroke(); }
      } else if (p.k === 'a') {
        ctx.beginPath(); ctx.arc(p.cx, p.cy, p.r, p.a0, p.a1, !!p.ccw);
        if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke && stroke !== 'none') { ctx.strokeStyle = stroke; ctx.stroke(); }
      } else if (p.k === 'r') {
        if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fillRect(p.x, p.y, p.w, p.h); }
        if (stroke && stroke !== 'none') { ctx.strokeStyle = stroke; ctx.strokeRect(p.x, p.y, p.w, p.h); }
      } else if (p.k === 'l') {
        ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2);
        ctx.strokeStyle = stroke || col; ctx.stroke();
      } else if (p.k === 'p') {
        ctx.beginPath();
        p.pts.forEach((pt, i) => i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]));
        if (p.close) ctx.closePath();
        if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke && stroke !== 'none') { ctx.strokeStyle = stroke; ctx.stroke(); }
      } else if (p.k === 't') {
        ctx.fillStyle = fill || col;
        ctx.font = `${p.bold ? 'bold ' : ''}${p.size || 8}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.str, p.x, p.y);
      }
    }
    ctx.restore();
    return true;
  },
};
