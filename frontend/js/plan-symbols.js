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
    bd_mdb: { size: 34, prims: [{ k: 'r', x: 4, y: 8, w: 32, h: 24, f: 'faint', s: 'col', w: 1.8 }, { k: 't', x: 20, y: 20, str: 'MDB', size: 8, f: 'col', bold: 1 }] },
    bd_db: { size: 32, prims: [{ k: 'r', x: 4, y: 8, w: 32, h: 24, f: 'faint', s: 'col', w: 1.8 }, { k: 't', x: 20, y: 20, str: 'DB', size: 9, f: 'col', bold: 1 }] },
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
    bd_light: { size: 24, prims: [
      { k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 },
      { k: 'l', x1: 13, y1: 13, x2: 27, y2: 27, s: 'col', w: 1.5 },
      { k: 'l', x1: 27, y1: 13, x2: 13, y2: 27, s: 'col', w: 1.5 },
    ] },
    bd_downlight: { size: 20, prims: [{ k: 'c', cx: 20, cy: 20, r: 8, f: 'col' }] },
    bd_batten: { size: 34, prims: [{ k: 'r', x: 2, y: 16, w: 36, h: 8, f: 'col', s: 'col', w: 0.7 }] },
    bd_floodlight: { size: 26, prims: [{ k: 'p', pts: [[20, 8], [30, 28], [10, 28]], s: 'col', w: 1.5, close: 1 }] },
    bd_emergency: { size: 24, prims: [
      { k: 'c', cx: 20, cy: 20, r: 10, s: 'col', w: 1.5 },
      { k: 'c', cx: 20, cy: 20, r: 3, f: 'col' },
    ] },
    bd_exit: { size: 30, prims: [
      { k: 'r', x: 8, y: 12, w: 24, h: 16, s: 'col', w: 1.5 },
      { k: 't', x: 20, y: 20, str: 'EXIT', size: 6, f: 'col', bold: 1 },
    ] },
    bd_socket: { size: 22, prims: [
      { k: 'c', cx: 20, cy: 20, r: 9, s: 'col', w: 1.5 },
      { k: 'l', x1: 20, y1: 15, x2: 20, y2: 25, s: 'col', w: 1.5 },
    ] },
    bd_socket2: { size: 24, prims: [
      { k: 'c', cx: 20, cy: 20, r: 9, s: 'col', w: 1.5 },
      { k: 'l', x1: 20, y1: 15, x2: 20, y2: 25, s: 'col', w: 1.5 },
      { k: 'l', x1: 29, y1: 14, x2: 29, y2: 26, s: 'col', w: 1.5 },
    ] },
    bd_socket_ip: { size: 24, prims: [
      { k: 'c', cx: 20, cy: 20, r: 9, s: 'col', w: 1.5 },
      { k: 'l', x1: 20, y1: 15, x2: 20, y2: 25, s: 'col', w: 1.5 },
      { k: 't', x: 20, y: 33, str: 'WP', size: 6, f: 'col' },
    ] },
    bd_isolator: { size: 24, prims: '__isolator__' },
    bd_fcu: { size: 24, prims: [
      { k: 'r', x: 9, y: 14, w: 22, h: 12, s: 'col', w: 1.5 },
      { k: 't', x: 20, y: 20, str: 'FU', size: 7, f: 'col', bold: 1 },
    ] },
    bd_switch: { size: 20, prims: '__sw1__' },
    bd_switch2: { size: 22, prims: '__sw2__' },
    bd_dimmer: { size: 24, prims: '__dim__' },
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

  size(type) { const r = this.RECIPES[type]; return r ? r.size : 24; },

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

  prims(type) {
    const r = this.RECIPES[type];
    if (!r) return null;
    return (typeof r.prims === 'string') ? this._procedural(r.prims) : r.prims;
  },

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
    const prims = this.prims(type);
    if (!prims) return false;
    const col = opts.color || '#6b7280';
    const bg = opts.bg || '#ffffff';
    const sizeWorld = opts.sizeWorld || this.size(type);
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
