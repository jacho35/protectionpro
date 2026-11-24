/* ProtectionPro — the area of a DXF to import (DXF import dialog › Area to import).
 *
 * A drawing often holds far more than is needed: other sites, title blocks, a key plan, a few stray items kilometres
 * away. Before import the user picks the part they want — the whole drawing, a rectangle, an outline (any polygon) or
 * the main drawing (the extents without the far-off strays, which the backend already finds: `data.bbox`).
 *
 * The area is kept on the DXF descriptor as `desc.clip = { pts: [[x, y]…], edge: 'cut' | 'whole', dropped }` in the
 * DXF's own (origin-relative) drawing units. By default the left-out parts are kept in the stored drawing, only hidden:
 * `PlanDxfImport.dataOf` hands every tool a clipped view (`clipData`), so drawing, snapping, detection, conversion and
 * export see only the area, and the area can be changed later (Underlays › Area to import…). With `dropped` the stored
 * drawing itself is the clipped copy: a smaller project, but the area can then only shrink.
 *
 * `edge`: 'cut' — lines and polylines are cut at the edge (circles, arcs, blocks and hatches that reach inside are kept
 * and drawn clipped); 'whole' — anything that touches the area is kept complete.
 *
 * Pure geometry (`clipPolyline`, `clipData`, `stats`, `fullBounds`, `strays`) is node-testable (testing/unit/dxfarea.test.js).
 */
const PlanDxfArea = {
  // ─── pure geometry; poly = [[x, y]…] ───
  bbox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  },
  inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  },
  rectPts(b) { return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]; },

  // Parameters 0 < t < 1 where segment A→B crosses the outline.
  _segT(ax, ay, bx, by, poly) {
    const out = [], dx = bx - ax, dy = by - ay;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const cx = poly[j][0], cy = poly[j][1], ex = poly[i][0] - cx, ey = poly[i][1] - cy;
      const den = dx * ey - dy * ex;
      if (!den) continue;
      const t = ((cx - ax) * ey - (cy - ay) * ex) / den, u = ((cx - ax) * dy - (cy - ay) * dx) / den;
      if (t > 1e-12 && t < 1 - 1e-12 && u >= 0 && u <= 1) out.push(t);
    }
    return out.sort((a, b) => a - b);
  },
  _segHits(ax, ay, bx, by, poly, bb) {
    if (Math.max(ax, bx) < bb[0] || Math.min(ax, bx) > bb[2] || Math.max(ay, by) < bb[1] || Math.min(ay, by) > bb[3]) return false;
    if (this.inPoly(ax, ay, poly) || this.inPoly(bx, by, poly)) return true;
    return this._segT(ax, ay, bx, by, poly).length > 0;
  },

  // A polyline (flat [x, y, x, y…]) cut by the outline: null when it lies wholly inside (keep it as it is), else the
  // pieces inside ([] = none). A closed one is walked round its closing segment and a piece across the start is joined.
  clipPolyline(p, closed, poly, bb) {
    const n = Math.floor(p.length / 2);
    if (n < 2) return this.inPoly(p[0], p[1], poly) ? null : [];
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([p[2 * i], p[2 * i + 1]]);
    if (closed) pts.push(pts[0]);
    const out = [];
    let cur = null, whole = true, startsAt0 = false;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
      const ivs = [];
      if (!(Math.max(ax, bx) < bb[0] || Math.min(ax, bx) > bb[2] || Math.max(ay, by) < bb[1] || Math.min(ay, by) > bb[3])) {
        const ts = [0, ...this._segT(ax, ay, bx, by, poly), 1];
        for (let k = 0; k + 1 < ts.length; k++) {
          const t0 = ts[k], t1 = ts[k + 1];
          if (t1 - t0 < 1e-12) continue;
          const tm = (t0 + t1) / 2;
          if (!this.inPoly(ax + (bx - ax) * tm, ay + (by - ay) * tm, poly)) continue;
          const last = ivs[ivs.length - 1];
          if (last && Math.abs(last[1] - t0) < 1e-12) last[1] = t1; else ivs.push([t0, t1]);
        }
      }
      if (!(ivs.length === 1 && ivs[0][0] === 0 && ivs[0][1] === 1)) whole = false;
      if (i === 0) startsAt0 = !!(ivs.length && ivs[0][0] === 0);
      for (const [t0, t1] of ivs) {
        const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        if (cur && t0 === 0) cur.push(x1, y1);
        else { cur = [x0, y0, x1, y1]; out.push(cur); }
        if (t1 !== 1) cur = null;
      }
      if (!ivs.length) cur = null;
    }
    if (whole) return null;
    if (closed && startsAt0 && cur && out.length > 1) {   // the piece that runs over the start: one piece
      const last = out.pop();
      out[0] = last.concat(out[0].slice(2));
    }
    return out;
  },

  // Does a record touch the area (any part inside)?
  keepRec(r, poly, bb) {
    const p = r.p || [];
    if (r.t === 'l') return p.length >= 4 && this._segHits(p[0], p[1], p[2], p[3], poly, bb);
    if (r.t === 'p') {
      if (p.length < 2) return false;
      if (p.length < 4) return this.inPoly(p[0], p[1], poly);
      for (let i = 0; i + 3 < p.length; i += 2) if (this._segHits(p[i], p[i + 1], p[i + 2], p[i + 3], poly, bb)) return true;
      return !!(r.c || r.g === 'HATCH') && this._segHits(p[p.length - 2], p[p.length - 1], p[0], p[1], poly, bb);
    }
    if (r.t === 'c' || r.t === 'a') {
      const R = p[2] || 0;
      if (p[0] + R < bb[0] || p[0] - R > bb[2] || p[1] + R < bb[1] || p[1] - R > bb[3]) return false;
      if (this.inPoly(p[0], p[1], poly)) return true;
      for (const [dx, dy] of [[R, 0], [-R, 0], [0, R], [0, -R]]) if (this.inPoly(p[0] + dx, p[1] + dy, poly)) return true;
      return poly.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < R);
    }
    return p.length >= 2 && this.inPoly(p[0], p[1], poly);
  },

  _recPts(r) {
    const p = r.p || [];
    if (r.t === 'c' || r.t === 'a') return [[p[0] - p[2], p[1] - p[2]], [p[0] + p[2], p[1] + p[2]]];
    if (r.t === 'x' || r.t === 'o') return [[p[0], p[1]]];
    const out = [];
    for (let i = 0; i + 1 < p.length; i += 2) out.push([p[i], p[i + 1]]);
    return out;
  },

  // The drawing as the area shows it: the records inside (cut or whole), the block references whose insertion point
  // is inside, and the extents of what is left. Everything else on `data` (layers, blocks, units, origin) is shared.
  clipData(data, clip) {
    const poly = clip && clip.pts;
    if (!poly || poly.length < 3) return data;
    const bb = this.bbox(poly), cut = clip.edge !== 'whole';
    const ents = [];
    for (const r of data.entities || []) {
      if (cut && (r.t === 'l' || (r.t === 'p' && r.g !== 'HATCH' && r.g !== 'SOLID'))) {
        const pieces = this.clipPolyline(r.p || [], r.t === 'p' && !!r.c, poly, bb);
        if (pieces === null) ents.push(r);
        else for (const q of pieces) ents.push(r.t === 'l' ? Object.assign({}, r, { p: q }) : Object.assign({}, r, { p: q, c: false }));
      } else if (this.keepRec(r, poly, bb)) ents.push(r);
    }
    const inserts = (data.inserts || []).filter(i => i.p && this.inPoly(i.p[0], i.p[1], poly));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const acc = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const r of ents) for (const [x, y] of this._recPts(r)) acc(x, y);
    for (const i of inserts) acc(i.p[0], i.p[1]);
    let box;
    if (x0 === Infinity) box = bb.slice();
    else if (cut) box = [Math.max(x0, bb[0]), Math.max(y0, bb[1]), Math.min(x1, bb[2]), Math.min(y1, bb[3])];
    else box = [x0, y0, x1, y1];
    if (!(box[2] > box[0]) || !(box[3] > box[1])) box = bb.slice();
    return Object.assign({}, data, { entities: ents, inserts, bbox: box, count: ents.length + inserts.length });
  },

  // How much an area keeps (records that touch it + block references inside), without building the copy.
  stats(data, poly) {
    const total = (data.entities || []).length + (data.inserts || []).length;
    if (!poly || poly.length < 3) return { kept: total, total };
    const bb = this.bbox(poly);
    let kept = 0;
    for (const r of data.entities || []) if (this.keepRec(r, poly, bb)) kept++;
    for (const i of data.inserts || []) if (i.p && this.inPoly(i.p[0], i.p[1], poly)) kept++;
    return { kept, total };
  },

  // Extents of everything in the drawing (the backend's `bbox` leaves out isolated far-off items).
  fullBounds(data) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const acc = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const r of data.entities || []) for (const [x, y] of this._recPts(r)) acc(x, y);
    for (const i of data.inserts || []) if (i.p) acc(i.p[0], i.p[1]);
    return x0 === Infinity ? (data.bbox || [0, 0, 1, 1]).slice() : [x0, y0, x1, y1];
  },

  // min/max of sorted-able values without an isolated tail at either end (the backend's _robust_bounds rule).
  _robust(values) {
    const v = values.slice().sort((a, b) => a - b), n = v.length;
    if (n < 20) return [v[0], v[n - 1]];
    const nz = [];
    for (let i = 1; i < n; i++) if (v[i] > v[i - 1]) nz.push(v[i] - v[i - 1]);
    if (!nz.length) return [v[0], v[n - 1]];
    nz.sort((a, b) => a - b);
    const typical = nz[Math.floor(nz.length / 2)], outer = Math.max(3, Math.min(40, Math.floor(n * 0.02)));
    let lo = 0, hi = n - 1, bi = -1, bg = 0;
    for (let i = Math.max(0, n - 1 - outer); i < n - 1; i++) if (v[i + 1] - v[i] > bg) { bg = v[i + 1] - v[i]; bi = i; }
    if (bi >= 0 && bg > 10 * typical) hi = bi;
    bi = -1; bg = 0;
    for (let i = 0; i < Math.min(n - 1, outer); i++) if (v[i + 1] - v[i] > bg) { bg = v[i + 1] - v[i]; bi = i; }
    if (bi >= 0 && bg > 10 * typical) lo = bi + 1;
    return lo >= hi ? [v[0], v[n - 1]] : [v[lo], v[hi]];
  },

  // The extents of the main drawing: isolated far-off items trimmed off, again and again until nothing more goes
  // (the backend's `bbox` trims one tail per side, so a second stray further in can remain).
  mainBounds(data) {
    let pts = [];
    for (const r of data.entities || []) for (const q of this._recPts(r)) if (isFinite(q[0]) && isFinite(q[1])) pts.push(q);
    for (const i of data.inserts || []) if (i.p) pts.push([i.p[0], i.p[1]]);
    if (!pts.length) return (data.bbox || [0, 0, 1, 1]).slice();
    for (let it = 0; it < 6; it++) {
      const [x0, x1] = this._robust(pts.map(q => q[0])), [y0, y1] = this._robust(pts.map(q => q[1]));
      const keep = pts.filter(q => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1);
      if (keep.length === pts.length || keep.length < 2) return [x0, y0, x1, y1];
      pts = keep;
    }
    return this.bbox(pts);
  },

  // Items far outside the main drawing: { n, full, main } — n = records with no point near the main extents.
  strays(data) {
    const main = this.mainBounds(data), full = this.fullBounds(data);
    const mw = Math.max(main[2] - main[0], 1e-9), mh = Math.max(main[3] - main[1], 1e-9);
    const big = (full[2] - full[0]) > 1.3 * mw + 1e-9 || (full[3] - full[1]) > 1.3 * mh + 1e-9;
    if (!big) return { n: 0, full, main };
    const m = 0.05 * Math.max(mw, mh), lo = [main[0] - m, main[1] - m], hi = [main[2] + m, main[3] + m];
    const near = (x, y) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1];
    let n = 0;
    for (const r of data.entities || []) if (!this._recPts(r).some(([x, y]) => near(x, y))) n++;
    for (const i of data.inserts || []) if (i.p && !near(i.p[0], i.p[1])) n++;
    return { n, full, main };
  },

  // ─── The picker (a canvas with the drawing and the area on it) ───
  // mount(host, data, { clip, unitM(): metres per drawing unit, fmt(m), onChange() }) → picker
  // picker.get() → { mode, pts|null, ok }; picker.key(e) → true when it used the key; picker.destroy().
  mount(host, data, o) {
    o = o || {};
    const A = this;
    const st = A.strays(data);
    const S = {
      mode: 'whole', pts: null, closed: true, draft: [], hover: null, drag: null, space: false,
      view: { s: 1, ox: 0, oy: 0 }, w: 0, h: 0, base: null, baseKey: '', raf: 0, statT: 0, stat: null,
    };
    if (o.clip && o.clip.pts && o.clip.pts.length >= 3) {
      S.pts = o.clip.pts.map(q => [q[0], q[1]]);
      S.mode = o.clip.mode || (S.pts.length === 4 && A._isRect(S.pts) ? 'rect' : 'poly');
    } else if (st.n > 0 && o.autoMain !== false) {
      S.mode = 'auto'; S.pts = A.rectPts(A._pad(st.main, 0.01));
    }
    const fmt = o.fmt || ((m) => m.toFixed(1) + ' m');
    const modeBtn = (m, label) => `<button type="button" class="dxfa-mode" data-am="${m}" aria-pressed="false">${label}</button>`;
    host.innerHTML = `
      <div class="dxfa-head"><span class="dxfa-title" id="dxfa-title">Area to import</span>
        <div class="dxfa-modes" role="group" aria-labelledby="dxfa-title">${modeBtn('whole', 'Whole drawing')}${modeBtn('rect', 'Rectangle')}${modeBtn('poly', 'Outline')}${modeBtn('auto', 'Main drawing')}</div></div>
      ${st.n ? `<div class="dxfa-strays" role="note"><span>The file reaches <b>${fmt(Math.max(st.full[2] - st.full[0], st.full[3] - st.full[1]) * (o.unitM ? o.unitM() : 1))}</b> across because of <b>${st.n.toLocaleString()} item${st.n > 1 ? 's' : ''}</b> far from the rest. <i>Main drawing</i> leaves ${st.n > 1 ? 'them' : 'it'} out.</span>
        <button type="button" class="dxfa-link" data-am-act="far">Show the far items</button></div>` : ''}
      <div class="dxfa-stage"><canvas class="dxfa-canvas" role="img" aria-label="The drawing, with the area to import"></canvas>
        <div class="dxfa-zoom"><button type="button" data-am-act="zin" aria-label="Zoom in">+</button><button type="button" data-am-act="zout" aria-label="Zoom out">−</button>
          <button type="button" data-am-act="fit" aria-label="Fit the area" title="Fit the area"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button></div></div>
      <div class="dxfa-hint" data-am-role="hint"></div>
      <div class="dxfa-keep" aria-live="polite"><b data-am-role="kept"></b><div class="dxfa-bar"><i data-am-role="bar"></i></div><small data-am-role="left"></small></div>`;
    const cv = host.querySelector('canvas'), ctx = cv.getContext('2d');
    const hintEl = host.querySelector('[data-am-role="hint"]');
    const css = (n, d) => { try { return getComputedStyle(document.body).getPropertyValue(n).trim() || d; } catch (_) { return d; } };
    const scr = (x, y) => [S.view.ox + x * S.view.s, S.view.oy - y * S.view.s];
    const loc = (px, py) => [(px - S.view.ox) / S.view.s, (S.view.oy - py) / S.view.s];
    const fit = (b, pad) => {
      const w = Math.max(b[2] - b[0], 1e-9), h = Math.max(b[3] - b[1], 1e-9), m = pad == null ? 18 : pad;
      S.view.s = Math.min((S.w - 2 * m) / w, (S.h - 2 * m) / h);
      S.view.ox = (S.w - w * S.view.s) / 2 - b[0] * S.view.s;
      S.view.oy = (S.h + h * S.view.s) / 2 + b[1] * S.view.s;
    };
    const areaB = () => (S.pts && S.pts.length >= 3 ? A.bbox(S.pts) : null);
    const fitArea = () => { const b = areaB(); fit(b ? A._pad(b, 0.08) : (S.mode === 'whole' ? st.full : data.bbox)); };

    // the drawing, rendered once per view into an offscreen canvas
    const renderBase = () => {
      const key = [S.w, S.h, S.view.s, S.view.ox, S.view.oy].join(',');
      if (S.base && S.baseKey === key) return;
      const dpr = window.devicePixelRatio || 1;
      const b = S.base || document.createElement('canvas');
      b.width = Math.round(S.w * dpr); b.height = Math.round(S.h * dpr);
      const g = b.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = css('--bg-primary', '#ffffff'); g.fillRect(0, 0, S.w, S.h);
      g.strokeStyle = css('--text-secondary', '#555555'); g.lineWidth = 0.7;
      const ents = data.entities || [], step = Math.max(1, Math.ceil(ents.length / 80000));
      const vx0 = -S.view.ox / S.view.s, vx1 = (S.w - S.view.ox) / S.view.s, vy0 = (S.view.oy - S.h) / S.view.s, vy1 = S.view.oy / S.view.s;
      g.beginPath();
      for (let n = 0; n < ents.length; n += step) {
        const e = ents[n], p = e.p || [];
        if (e.t === 'l') {
          if (Math.max(p[0], p[2]) < vx0 || Math.min(p[0], p[2]) > vx1 || Math.max(p[1], p[3]) < vy0 || Math.min(p[1], p[3]) > vy1) continue;
          const a = scr(p[0], p[1]), c = scr(p[2], p[3]); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]);
        } else if (e.t === 'p' && p.length >= 4) {
          let a = scr(p[0], p[1]); g.moveTo(a[0], a[1]);
          for (let i = 2; i + 1 < p.length; i += 2) { a = scr(p[i], p[i + 1]); g.lineTo(a[0], a[1]); }
          if (e.c) { a = scr(p[0], p[1]); g.lineTo(a[0], a[1]); }
        } else if (e.t === 'c' || e.t === 'a') {
          const r = p[2] * S.view.s; if (r < 0.6) continue;
          const a = scr(p[0], p[1]); g.moveTo(a[0] + r, a[1]); g.arc(a[0], a[1], r, 0, Math.PI * 2);
        } else if (e.t === 'o' || e.t === 'x') {
          const a = scr(p[0], p[1]); g.moveTo(a[0], a[1]); g.lineTo(a[0] + 0.8, a[1]);
        }
      }
      for (const i of data.inserts || []) { if (!i.p) continue; const a = scr(i.p[0], i.p[1]); g.moveTo(a[0] - 1.2, a[1]); g.lineTo(a[0] + 1.2, a[1]); }
      g.stroke();
      if (st.n) {   // the far items, marked so they can be found
        g.fillStyle = '#d97706';
        for (const e of data.entities || []) {
          const q = A._recPts(e)[0]; if (!q) continue;
          if (q[0] >= st.main[0] && q[0] <= st.main[2] && q[1] >= st.main[1] && q[1] <= st.main[3]) continue;
          const a = scr(q[0], q[1]);
          if (a[0] < -4 || a[1] < -4 || a[0] > S.w + 4 || a[1] > S.h + 4) continue;
          g.beginPath(); g.arc(a[0], a[1], 3, 0, Math.PI * 2); g.fill();
        }
      }
      S.base = b; S.baseKey = key;
    };
    const accent = () => css('--accent', '#1d4ed8');
    const draw = () => {
      S.raf = 0;
      if (!S.w) return;
      renderBase();
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(S.base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ac = accent();
      const path = (pts, close) => { ctx.beginPath(); pts.forEach((q, i) => { const a = scr(q[0], q[1]); if (i) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); }); if (close) ctx.closePath(); };
      if (S.pts && S.pts.length >= 3 && S.mode !== 'whole') {
        ctx.fillStyle = 'rgba(17,24,39,0.38)';
        ctx.beginPath(); ctx.rect(0, 0, S.w, S.h);
        S.pts.forEach((q, i) => { const a = scr(q[0], q[1]); if (i) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); });
        ctx.closePath(); ctx.fill('evenodd');
        ctx.strokeStyle = ac; ctx.lineWidth = 2; path(S.pts, true); ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.lineWidth = 1.6;
        for (const h of handles()) {
          const a = scr(h.x, h.y);
          ctx.beginPath();
          if (S.mode === 'poly') ctx.arc(a[0], a[1], 5, 0, Math.PI * 2); else ctx.rect(a[0] - 5, a[1] - 5, 10, 10);
          ctx.fill(); ctx.stroke();
        }
        const b = areaB(), um = o.unitM ? o.unitM() : 0;
        if (um) {
          const t = `${fmt((b[2] - b[0]) * um)} × ${fmt((b[3] - b[1]) * um)}`;
          const a = scr((b[0] + b[2]) / 2, b[1]);
          ctx.font = '600 11px system-ui, sans-serif';
          const tw = ctx.measureText(t).width + 14, x = Math.max(4, Math.min(S.w - tw - 4, a[0] - tw / 2)), y = Math.max(4, Math.min(S.h - 24, a[1] + 8));
          ctx.fillStyle = ac; ctx.beginPath(); ctx.rect(x, y, tw, 20); ctx.fill();
          ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 7, y + 10);
        }
      }
      if (S.mode === 'poly' && !S.closed && S.draft.length) {
        const pts = S.hover ? S.draft.concat([S.hover]) : S.draft;
        ctx.strokeStyle = ac; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); path(pts, false); ctx.stroke(); ctx.setLineDash([]);
        S.draft.forEach((q, i) => {
          const a = scr(q[0], q[1]);
          ctx.beginPath(); ctx.arc(a[0], a[1], i === 0 ? 7 : 5, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? ac : '#ffffff'; ctx.fill(); ctx.strokeStyle = ac; ctx.lineWidth = 1.6; ctx.stroke();
        });
      }
      if (S.drag && S.drag.kind === 'new') {
        const a = scr(S.drag.a[0], S.drag.a[1]), b = scr(S.drag.b[0], S.drag.b[1]);
        ctx.strokeStyle = ac; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); ctx.setLineDash([]);
      }
    };
    const redraw = () => { if (!S.raf) S.raf = requestAnimationFrame(draw); };

    // handles: rect = 4 corners + 4 midpoints ({x, y, hx, hy}: which bound each moves); outline = its corners
    const handles = () => {
      if (!S.pts) return [];
      if (S.mode === 'poly') return S.pts.map((q, i) => ({ x: q[0], y: q[1], i }));
      const [x0, y0, x1, y1] = A.bbox(S.pts), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      return [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1], [mx, y0, 0, -1], [x1, my, 1, 0], [mx, y1, 0, 1], [x0, my, -1, 0]]
        .map(([x, y, hx, hy]) => ({ x, y, hx, hy }));
    };
    const handleAt = (px, py) => {
      let best = null, bd = 9;
      for (const h of handles()) { const a = scr(h.x, h.y), d = Math.hypot(a[0] - px, a[1] - py); if (d < bd) { bd = d; best = h; } }
      return best;
    };
    const edgeAt = (px, py) => {
      if (!S.pts) return null;
      let best = null, bd = 7;
      for (let i = 0; i < S.pts.length; i++) {
        const a = scr(...S.pts[i]), b = scr(...S.pts[(i + 1) % S.pts.length]);
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
        const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
        if (d < bd) { bd = d; best = { i, pt: loc(a[0] + t * dx, a[1] + t * dy) }; }
      }
      return best;
    };

    // keep figures + text
    const setText = () => {
      hintEl.textContent = S.mode === 'whole' ? 'The whole drawing is imported. Pick Rectangle or Outline to import only part of it. The wheel zooms; drag to pan.'
        : S.mode === 'auto' ? 'The part of the drawing where nearly everything is. Drag a handle to adjust it.'
        : S.mode === 'rect' ? 'Drag on the drawing to draw the area · drag a handle to resize it, inside it to move it · the wheel zooms, middle button or Space-drag pans.'
        : !S.closed ? 'Click the corners · click the first corner again or press Enter to close · Backspace takes the last corner back · Esc drops it.'
        : 'Drag a corner to move it · Shift-click an edge adds a corner · Alt-click a corner removes it · click Outline again to start over.';
      host.querySelectorAll('[data-am]').forEach(b => { const on = b.dataset.am === S.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      const auto = host.querySelector('[data-am="auto"]'); if (auto) auto.hidden = !st.n && S.mode !== 'auto';
      cv.style.cursor = S.mode === 'whole' ? 'grab' : 'crosshair';
    };
    const kept = host.querySelector('[data-am-role="kept"]'), bar = host.querySelector('[data-am-role="bar"]'), left = host.querySelector('[data-am-role="left"]');
    const showStats = () => {
      const g = pub.get();
      if (!g.pts) {
        const total = (data.entities || []).length + (data.inserts || []).length;
        kept.textContent = g.ok || S.mode === 'whole' ? `The whole drawing · ${total.toLocaleString()} items` : 'Close the outline to see what it keeps';
        bar.style.width = g.ok || S.mode === 'whole' ? '100%' : '0';
        left.textContent = S.mode === 'whole' && st.n ? `Includes ${st.n.toLocaleString()} item${st.n > 1 ? 's' : ''} far from the rest.` : '';
        return;
      }
      const s = A.stats(data, g.pts), pct = s.total ? Math.round(s.kept / s.total * 100) : 0;
      kept.textContent = `Keeps ${s.kept.toLocaleString()} of ${s.total.toLocaleString()} items (${pct} %)`;
      bar.style.width = pct + '%';
      left.textContent = s.total - s.kept ? `${(s.total - s.kept).toLocaleString()} item${s.total - s.kept > 1 ? 's' : ''} outside the area are left out.` : 'Nothing is outside the area.';
    };
    const changed = (quiet) => {
      setText(); redraw();
      clearTimeout(S.statT); S.statT = setTimeout(showStats, 120);
      if (!quiet && o.onChange) o.onChange();
    };

    const setMode = (m) => {
      if (m === 'poly') { S.mode = 'poly'; S.pts = null; S.closed = false; S.draft = []; }
      else if (m === 'rect') { S.mode = 'rect'; S.closed = true; if (!S.pts || !A._isRect(S.pts)) S.pts = S.pts ? A.rectPts(A.bbox(S.pts)) : null; }
      else if (m === 'auto') { S.mode = 'auto'; S.closed = true; S.pts = A.rectPts(A._pad(st.main, 0.01)); fitArea(); }
      else { S.mode = 'whole'; S.closed = true; fit(st.full); }
      changed();
    };

    // ─── pointer ───
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      const [px, py] = pos(e);
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && (S.space || S.mode === 'whole'))) {
        e.preventDefault();
        S.drag = { kind: 'pan', x: e.clientX, y: e.clientY };
        cv.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      const p = loc(px, py);
      if (S.mode === 'poly') {
        if (!S.closed) {
          if (S.draft.length >= 3) { const a = scr(...S.draft[0]); if (Math.hypot(a[0] - px, a[1] - py) < 9) { closeDraft(); return; } }
          S.draft.push(p); changed(true); return;
        }
        const h = handleAt(px, py);
        if (h && e.altKey) { if (S.pts.length > 3) { S.pts.splice(h.i, 1); changed(); } return; }
        if (!h && e.shiftKey) { const ed = edgeAt(px, py); if (ed) { S.pts.splice(ed.i + 1, 0, ed.pt); S.drag = { kind: 'vtx', i: ed.i + 1 }; changed(true); } return; }
        if (h) S.drag = { kind: 'vtx', i: h.i };
        return;
      }
      // rect / auto
      const h = S.pts ? handleAt(px, py) : null;
      if (h) { S.drag = { kind: 'side', h, b: A.bbox(S.pts) }; return; }
      if (S.pts && A.inPoly(p[0], p[1], S.pts)) { S.drag = { kind: 'move', from: p, pts: S.pts.map(q => q.slice()) }; return; }
      S.drag = { kind: 'new', a: p, b: p };
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = pos(e), p = loc(px, py), d = S.drag;
      if (d && e.buttons === 0 && e.pointerType !== 'touch') { end(); return; }
      if (!d) {
        if (S.mode === 'poly' && !S.closed) { S.hover = p; redraw(); }
        else if (S.mode !== 'whole') {
          const h = handleAt(px, py);
          cv.style.cursor = S.space ? 'grab' : h ? (S.mode === 'poly' ? 'move' : (h.hx && h.hy ? (h.hx * h.hy > 0 ? 'nesw-resize' : 'nwse-resize') : h.hx ? 'ew-resize' : 'ns-resize'))
            : (S.pts && S.mode !== 'poly' && A.inPoly(p[0], p[1], S.pts)) ? 'move' : 'crosshair';
        }
        return;
      }
      if (d.kind === 'pan') { S.view.ox += e.clientX - d.x; S.view.oy += e.clientY - d.y; d.x = e.clientX; d.y = e.clientY; redraw(); return; }
      if (d.kind === 'vtx') { S.pts[d.i] = p; redraw(); return; }
      if (d.kind === 'new') { d.b = p; redraw(); return; }
      if (d.kind === 'move') { const dx = p[0] - d.from[0], dy = p[1] - d.from[1]; S.pts = d.pts.map(q => [q[0] + dx, q[1] + dy]); toRect(); redraw(); return; }
      if (d.kind === 'side') {
        const b = d.b.slice();
        if (d.h.hx < 0) b[0] = p[0]; else if (d.h.hx > 0) b[2] = p[0];
        if (d.h.hy < 0) b[1] = p[1]; else if (d.h.hy > 0) b[3] = p[1];
        S.pts = A.rectPts([Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]);
        toRect(); redraw();
      }
    });
    const toRect = () => { if (S.mode === 'auto') { S.mode = 'rect'; setText(); } };
    const end = () => {
      const d = S.drag; S.drag = null;
      if (!d) return;
      if (d.kind === 'pan') { setText(); redraw(); return; }
      if (d.kind === 'new') {
        const a = scr(...d.a), b = scr(...d.b);
        if (Math.abs(a[0] - b[0]) > 4 && Math.abs(a[1] - b[1]) > 4) {
          S.pts = A.rectPts([Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]), Math.max(d.a[0], d.b[0]), Math.max(d.a[1], d.b[1])]);
          toRect();
        }
      }
      changed();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener('pointerenter', () => { S.over = true; });
    cv.addEventListener('pointerleave', () => { S.over = false; if (S.hover) { S.hover = null; redraw(); } });
    cv.addEventListener('dblclick', (e) => {
      if (S.mode !== 'poly' || !S.closed) return;
      const [px, py] = pos(e), h = handleAt(px, py);
      if (h) { if (S.pts.length > 3) { S.pts.splice(h.i, 1); changed(); } return; }
      const ed = edgeAt(px, py); if (ed) { S.pts.splice(ed.i + 1, 0, ed.pt); changed(); }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = pos(e);
      zoomAt(px, py, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });
    const zoomAt = (px, py, f) => {
      const s2 = Math.max(1e-12, S.view.s * f);
      S.view.ox = px - (px - S.view.ox) * s2 / S.view.s;
      S.view.oy = py - (py - S.view.oy) * s2 / S.view.s;
      S.view.s = s2; redraw();
    };
    const closeDraft = () => {
      if (S.draft.length < 3) return false;
      S.pts = S.draft; S.draft = []; S.closed = true; S.hover = null;
      changed(); return true;
    };
    host.addEventListener('click', (e) => {
      const m = e.target.closest('[data-am]'); if (m) { setMode(m.dataset.am); return; }
      const a = e.target.closest('[data-am-act]'); if (!a) return;
      const act = a.dataset.amAct;
      if (act === 'zin') zoomAt(S.w / 2, S.h / 2, 1.5);
      else if (act === 'zout') zoomAt(S.w / 2, S.h / 2, 1 / 1.5);
      else if (act === 'fit') { fitArea(); redraw(); }
      else if (act === 'far') { fit(st.full); redraw(); }
    });
    const onKeyUp = (e) => { if (e.key === ' ') { S.space = false; setText(); } };
    window.addEventListener('keyup', onKeyUp, true);

    // size the canvas to its box
    const size = () => {
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width || !r.height) return;
      const first = !S.w;
      if (!first && Math.abs(r.width - S.w) < 1 && Math.abs(r.height - S.h) < 1) return;
      S.w = r.width; S.h = r.height;
      cv.width = Math.round(S.w * dpr); cv.height = Math.round(S.h * dpr);
      if (first) fitArea();
      S.baseKey = ''; redraw();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
    if (ro) ro.observe(cv);
    requestAnimationFrame(size);

    const pub = {
      get() {
        if (S.mode === 'whole') return { mode: 'whole', pts: null, ok: true };
        if (S.mode === 'poly' && !S.closed) return { mode: 'poly', pts: null, ok: false };
        const ok = !!(S.pts && S.pts.length >= 3);
        return { mode: S.mode === 'auto' ? 'rect' : S.mode, pts: ok ? S.pts.map(q => [q[0], q[1]]) : null, ok: ok || S.mode !== 'poly' };
      },
      bounds() { const g = pub.get(); return g.pts ? A.bbox(g.pts) : (S.mode === 'whole' ? st.full : data.bbox); },
      // a key from the dialog; true when the picker used it
      key(e) {
        if (e.key === ' ' && S.over) { S.space = true; cv.style.cursor = 'grab'; e.preventDefault(); return true; }
        if (S.mode !== 'poly' || S.closed) return false;
        if (e.key === 'Enter') { closeDraft(); return true; }
        if (e.key === 'Backspace') { S.draft.pop(); redraw(); return true; }
        if (e.key === 'Escape' && S.draft.length) { S.draft = []; S.hover = null; redraw(); return true; }
        return false;
      },
      destroy() { window.removeEventListener('keyup', onKeyUp, true); if (ro) ro.disconnect(); clearTimeout(S.statT); if (S.raf) cancelAnimationFrame(S.raf); },
    };
    setText(); showStats();
    return pub;
  },

  _pad(b, f) { const m = Math.max(b[2] - b[0], b[3] - b[1]) * f; return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]; },
  _isRect(pts) {
    if (pts.length !== 4) return false;
    const b = this.bbox(pts), on = (v, a, c) => Math.abs(v - a) < 1e-9 || Math.abs(v - c) < 1e-9;
    return pts.every(([x, y]) => on(x, b[0], b[2]) && on(y, b[1], b[3]));
  },
};
if (typeof module !== 'undefined') module.exports = PlanDxfArea;
