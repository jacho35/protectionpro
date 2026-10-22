/* ProtectionPro — Lighting tab › 3D for a sports field (kind 'sports').
 *
 * Light3D hands a field to this module instead of extruding it like a room:
 *   • the pitch with its markings, on a ground apron;
 *   • masts with their floods on a headframe, each flood turned to its aim
 *     point (rows of up to four square to the pitch centre — drawing only, the
 *     calculation puts every flood at the mast top), aim lines with Light cones;
 *   • stands as raked blocks, front row to back row; TV cameras.
 * Show: Model, False colour (the pitch grid, the seats and, ticked, the aerial
 * layers at their heights — one scale) or Rendered light (pitch and seats as
 * bright as they look, ρE/π, the floods glowing on a night sky).
 * A mast or camera drags across the ground; masts, stands and cameras are
 * edited in the side panel. Everything stays in the field's own metres
 * (SportsCalc), so the plan follows.
 */

const Sports3D = {
  aerial: false,          // false colour: the aerial layers over the pitch
  SEL: '#0078d7',

  is(room) { return !!room && room.kind === 'sports'; },

  // The field frame and a field-metres → world [x, y] map (the 3D view's frame, y up).
  _ctx(room) {
    const f = PlanEngine.factor(), fr = f ? SportsCalc.frame(room, f) : null;
    if (!fr) return null;
    const W = (x, y) => { const p = SportsCalc.toWorld(fr, x, y); return [p.x, p.y]; };
    return { f, fr, L: SportsCalc.read(room), W };
  },
  _toField(fr, wx, wy) {
    const dx = wx - fr.O.x, dy = wy - fr.O.y;
    return [dx * fr.u.x + dy * fr.u.y, dx * fr.v.x + dy * fr.v.y];
  },
  _result(room) {
    const r = RoomCalc.results[room.id];
    if (!r) return { r: null, fresh: false };
    let fresh = false;
    try { fresh = r.sig === SportsCalc.signature(room); } catch (_) { fresh = false; }
    return { r, fresh };
  },

  bounds(room) {
    const C = this._ctx(room);
    if (!C) return null;
    const { fr, L, W } = C;
    const pts = [[0, 0], [fr.L, 0], [fr.L, fr.W], [0, fr.W]];
    for (const m of L.masts) pts.push([+m.x || 0, +m.y || 0]);
    for (const st of L.stands) pts.push(...SportsCalc.standCorners(st, fr));
    if (L.tv) for (const c of L.cameras) pts.push([+c.x || 0, +c.y || 0]);
    const w = pts.map(p => W(p[0], p[1])), xs = w.map(p => p[0]), ys = w.map(p => p[1]);
    const top = Math.max(2, ...L.masts.map(m => +m.h || 0), ...L.stands.map(s => +s.zBack || 0));
    return { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), top] };
  },

  // Where each flood is drawn on its mast.
  _heads(C, m) {
    const { fr, W } = C;
    const M = W(+m.x || 0, +m.y || 0), h = Math.max(+m.h || 20, 0.5);
    const c = W(fr.L / 2, fr.W / 2);
    const dl = Math.hypot(c[0] - M[0], c[1] - M[1]) || 1;
    const d = [(c[0] - M[0]) / dl, (c[1] - M[1]) / dl], p = [-d[1], d[0]];
    const fl = m.floods || [], cols = Math.min(4, Math.max(1, fl.length)), sp = 0.8;
    const at = fl.map((x, i) => {
      const o = (i % cols - (cols - 1) / 2) * sp, z = h - Math.floor(i / cols) * sp;
      return [M[0] + p[0] * o + d[0] * 0.45, M[1] + p[1] * o + d[1] * 0.45, z];
    });
    return { M, h, d, p, cols, rows: Math.ceil(fl.length / cols), sp, at };
  },

  // The pitch markings as polylines in field metres.
  _markings(fr, sport) {
    const out = [[[0, 0], [fr.L, 0], [fr.L, fr.W], [0, fr.W], [0, 0]]];
    const lines = (SPORTS_FIELDS[sport] || {}).lines;
    if (lines === 'football' || lines === 'halfway') out.push([[fr.L / 2, 0], [fr.L / 2, fr.W]]);
    if (lines === 'thirds') for (const t of [1 / 3, 2 / 3]) out.push([[fr.L * t, 0], [fr.L * t, fr.W]]);
    if (lines === 'football') {
      const ring = [];
      for (let a = 0; a <= 36; a++) ring.push([fr.L / 2 + 9.15 * Math.cos(a * Math.PI / 18), fr.W / 2 + 9.15 * Math.sin(a * Math.PI / 18)]);
      out.push(ring);
      const pw = Math.min(40.32, fr.W * 0.6), pd = Math.min(16.5, fr.L * 0.16), y0 = fr.W / 2 - pw / 2, y1 = fr.W / 2 + pw / 2;
      out.push([[0, y0], [pd, y0], [pd, y1], [0, y1]], [[fr.L, y0], [fr.L - pd, y0], [fr.L - pd, y1], [fr.L, y1]]);
    }
    return out;
  },

  // ─── Drawing ───────────────────────────────────────────────────────────
  draw(v, room, L3) {
    const C = this._ctx(room);
    if (!C) { v.bg = null; return; }
    const { fr, L, W } = C;
    const { r: rr, fresh } = this._result(room);
    const res = rr ? rr.res : null, hz = res && res.horizontal;
    const mode = L3.mode, expo = L3.expo;
    const rendered = mode === 'render' && !!hz, colour = mode === 'colour' && !!hz;
    const night = mode === 'render';
    v.bg = night ? '#0a0d12' : null;
    const top = hz ? Math.max(hz.Emax || 0, 1) : 1;
    const cell = (x0, y0, x1, y1, z) => [W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1)].map(p => [p[0], p[1], z]);

    // ground apron and pitch
    const B = this.bounds(room), g = 12;
    v.face({ pts: [[B.min[0] - g, B.min[1] - g, 0], [B.max[0] + g, B.min[1] - g, 0], [B.max[0] + g, B.max[1] + g, 0], [B.min[0] - g, B.max[1] + g, 0]],
      fill: night ? '#0c110d' : '#cfd8c8', layer: 0, bias: -3e6 });
    v.face({ pts: cell(0, 0, fr.L, fr.W, 0.001), fill: night ? '#132015' : '#6ea85a', layer: 0, bias: -2e6 });
    if (hz && (colour || rendered)) {
      for (let j = 0; j < hz.ny; j++) for (let i = 0; i < hz.nx; i++) {
        const val = hz.values[j * hz.nx + i];
        if (val == null) continue;
        v.face({ pts: cell(i * hz.dx, j * hz.dy, (i + 1) * hz.dx, (j + 1) * hz.dy, 0.003), layer: 0, bias: -1e6,
          fill: rendered ? V3D.tone(val, L.groundRho, '#5f9a48', expo) : RoomCalc._color(val / top), alpha: colour ? (fresh ? 0.92 : 0.4) : 1 });
      }
    }
    const lineCol = rendered ? V3D.tone(hz.Eav || 0, 0.7, '#ffffff', expo) : night ? '#2b3a2e' : 'rgba(255,255,255,.95)';
    for (const pl of this._markings(fr, L.sport)) v.line({ pts: pl.map(p => [...W(p[0], p[1]), 0.02]), stroke: lineCol, lw: 1.5, layer: 0.5 });

    // stands
    const stRes = (id) => (res && res.stands || []).find(x => x.id === id);
    for (const st of L.stands) this._stand(v, C, st, stRes(st.id), { colour, rendered, night, top, fresh, expo, on: L3.sel === 't:' + st.id });

    // aerial layers
    if (colour && this.aerial && res.aerial) {
      const A = res.aerial;
      let last = -Infinity;
      for (const lay of A.layers) {
        for (let j = 0; j < A.ny; j++) for (let i = 0; i < A.nx; i++) {
          const val = lay.values[j * A.nx + i];
          if (val == null) continue;
          v.face({ pts: cell(i * hz.dx, j * hz.dy, (i + 1) * hz.dx, (j + 1) * hz.dy, lay.height), fill: RoomCalc._color(val / top), alpha: fresh ? 0.34 : 0.16, layer: 1.6 });
        }
        if (lay.height - last < 4) continue;     // the legend lists every layer
        last = lay.height;
        v.label({ at: [...W(0, fr.W), lay.height], text: `${lay.height} m`, color: '#1a1a2e', size: 11, bold: true });
      }
    }

    // masts and floods
    for (const m of L.masts) {
      const H = this._heads(C, m), on = L3.sel === 'm:' + m.id, pick = 'm:' + m.id;
      V3D.box(v, H.M, 0.45, 0.45, 0, H.h - 0.1, 0, { color: night ? '#3a414c' : '#8b929c', pick, stroke: on ? this.SEL : 'rgba(26,26,46,.35)', lw: on ? 2 : 0.8 });
      for (let r = 0; r < H.rows; r++) {
        const z = H.h - r * H.sp, o = (H.cols - 1) / 2 * H.sp + 0.3;
        const a = [H.M[0] - H.p[0] * o + H.d[0] * 0.2, H.M[1] - H.p[1] * o + H.d[1] * 0.2, z], b = [H.M[0] + H.p[0] * o + H.d[0] * 0.2, H.M[1] + H.p[1] * o + H.d[1] * 0.2, z];
        v.line({ pts: [a, b], stroke: on ? this.SEL : (night ? '#4b5563' : '#4b5563'), lw: 3, layer: 1.4, pick });
      }
      (m.floods || []).forEach((fl, i) => {
        const F = H.at[i], A = W(+fl.ax || 0, +fl.ay || 0);
        const off = SportsCalc._pct(fl.fluxPct) <= 0 || !PhotoLib.get(fl.photoId);
        this._flood(v, F, A, { pick, front: night ? (off ? '#30353d' : '#fffdf4') : (off ? '#9ca3af' : '#fff6cf'), back: night ? '#262b33' : '#6b7280',
          stroke: on ? this.SEL : 'rgba(26,26,46,.55)', lw: on ? 1.6 : 0.8 });
        if (night && !off) {
          v.glow({ at: F, r: 2.2, color: 'rgba(255,248,226,.5)' });
          v.glow({ at: F, r: 0.9, color: 'rgba(255,253,240,.95)' });
        }
        if (L3.cones || on) {
          v.line({ pts: [F, [A[0], A[1], 0.03]], stroke: on ? 'rgba(232,89,12,.85)' : (night ? 'rgba(255,214,90,.35)' : 'rgba(214,150,20,.55)'), lw: on ? 1.4 : 1, dash: [5, 4], layer: 2 });
          const k = 0.5;
          v.face({ pts: [[A[0] - k, A[1], 0.03], [A[0], A[1] - k, 0.03], [A[0] + k, A[1], 0.03], [A[0], A[1] + k, 0.03]], fill: on ? '#e8590c' : 'rgba(214,150,20,.8)', layer: 0.6 });
        }
      });
      if (!night || on) v.label({ at: [H.M[0], H.M[1], H.h + 0.6], text: on ? `${m.name || 'Mast'} · ${(+m.h || 0)} m · ${(m.floods || []).length} floods` : (m.name || ''),
        color: on ? '#005fa3' : '#1a1a2e', size: on ? 12 : 11, bold: true, halo: night ? 'rgba(10,13,18,.85)' : undefined });
    }

    // cameras
    if (L.tv) for (const c of L.cameras) {
      const P = W(+c.x || 0, +c.y || 0), z = Math.max(0.5, +c.z || 0), on = L3.sel === 'c:' + c.id;
      v.line({ pts: [[P[0], P[1], 0], [P[0], P[1], z - 0.25]], stroke: '#64748b', lw: 2, layer: 1 });
      V3D.box(v, P, 0.8, 0.5, z - 0.25, 0.5, SportsCalc.angleOf(fr) + 90, { color: '#2563eb', pick: 'c:' + c.id, stroke: on ? this.SEL : 'rgba(26,26,46,.45)', lw: on ? 2 : 0.8 });
      if (on || !night) v.label({ at: [P[0], P[1], z + 0.5], text: c.name || 'Camera', color: on ? '#005fa3' : '#1d4ed8', size: 11, bold: on });
    }
  },

  _flood(v, F, A, o) {
    let a = [A[0] - F[0], A[1] - F[1], -F[2]];
    const al = Math.hypot(a[0], a[1], a[2]) || 1;
    a = a.map(x => x / al);
    let e1 = [a[1], -a[0], 0];
    const l1 = Math.hypot(e1[0], e1[1]);
    e1 = l1 > 1e-6 ? [e1[0] / l1, e1[1] / l1, 0] : [1, 0, 0];
    const e2 = [e1[1] * a[2] - e1[2] * a[1], e1[2] * a[0] - e1[0] * a[2], e1[0] * a[1] - e1[1] * a[0]];
    const hw = 0.32, hh = 0.24;
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [0, 1, 2].map(k => F[k] + e1[k] * s * hw + e2[k] * t * hh));
    v.face({ pts: q, fill: o.front, stroke: o.stroke, lw: o.lw, cull: a, pick: o.pick, layer: 1.5 });
    v.face({ pts: q.slice().reverse(), fill: o.back, stroke: o.stroke, lw: o.lw, cull: a.map(x => -x), pick: o.pick, layer: 1.5 });
  },

  // A stand: the raked top (seats) from the front row to the back row, front, back and side walls.
  _stand(v, C, st, sr, o) {
    const { fr, W } = C;
    const K = SportsCalc.standCorners(st, fr);
    const zf = Math.max(0, +st.zFront || 0), zb = Math.max(0, +st.zBack || 0);
    const P = K.map(p => W(p[0], p[1]));
    const al = [P[1][0] - P[0][0], P[1][1] - P[0][1]], bk = [P[3][0] - P[0][0], P[3][1] - P[0][1]];
    const nl = Math.hypot(al[0], al[1]) || 1, nb = Math.hypot(bk[0], bk[1]) || 1;
    const ua = [al[0] / nl, al[1] / nl, 0], ub = [bk[0] / nb, bk[1] / nb, 0];
    const pick = 't:' + st.id, stroke = o.on ? this.SEL : (o.night ? 'rgba(80,90,104,.6)' : 'rgba(26,26,46,.35)'), lw = o.on ? 2 : 0.8;
    const wall = o.night ? '#1a1d22' : '#9aa3ad';
    const at = (ti, tj) => [P[0][0] + al[0] * ti + bk[0] * tj, P[0][1] + al[1] * ti + bk[1] * tj, zf + (zb - zf) * tj];
    v.face({ pts: [[...P[0], 0], [...P[1], 0], [...P[1], zf], [...P[0], zf]], fill: V3D.shade(wall, 0.8), stroke, lw, cull: ub.map(x => -x), pick });
    v.face({ pts: [[...P[3], 0], [...P[2], 0], [...P[2], zb], [...P[3], zb]], fill: V3D.shade(wall, 0.7), stroke, lw, cull: ub, pick });
    v.face({ pts: [[...P[0], 0], [...P[3], 0], [...P[3], zb], [...P[0], zf]], fill: V3D.shade(wall, 0.9), stroke, lw, cull: ua.map(x => -x), pick });
    v.face({ pts: [[...P[1], 0], [...P[2], 0], [...P[2], zb], [...P[1], zf]], fill: V3D.shade(wall, 0.9), stroke, lw, cull: ua, pick });
    const grid = sr && sr.values && sr.nx && sr.ny && (o.colour || o.rendered);
    if (grid) {
      for (let j = 0; j < sr.ny; j++) for (let i = 0; i < sr.nx; i++) {
        const val = sr.values[j * sr.nx + i];
        v.face({ pts: [at(i / sr.nx, j / sr.ny), at((i + 1) / sr.nx, j / sr.ny), at((i + 1) / sr.nx, (j + 1) / sr.ny), at(i / sr.nx, (j + 1) / sr.ny)],
          fill: o.rendered ? V3D.tone(val, 0.3, '#c4cad2', o.expo) : RoomCalc._color(val / o.top), alpha: o.colour ? (o.fresh ? 0.92 : 0.4) : 1, pick });
      }
      v.line({ pts: [at(0, 0), at(1, 0), at(1, 1), at(0, 1), at(0, 0)], stroke, lw, layer: 1.2, pick });
    } else {
      v.face({ pts: [at(0, 0), at(1, 0), at(1, 1), at(0, 1)], fill: o.night ? '#1f242b' : '#b9c0ca', stroke, lw, pick });
      const rows = Math.max(2, Math.round(nb / 1.5));
      if (!o.night) for (let k = 1; k < rows; k++) v.line({ pts: [at(0, k / rows), at(1, k / rows)], stroke: 'rgba(26,26,46,.22)', lw: 0.8, layer: 1.2 });
    }
    if (o.on || !o.night) {
      const c = at(0.5, 0.5);
      v.label({ at: [c[0], c[1], Math.max(zf, zb) + 1], text: st.name || 'Stand', color: o.on ? '#005fa3' : '#334155', size: 11, bold: o.on });
    }
  },

  // ─── Selection ─────────────────────────────────────────────────────────
  _selected(room, sel) {
    if (!sel) return null;
    const t = sel.slice(0, 1), id = sel.slice(2), L = SportsCalc.read(room);
    const item = t === 'm' ? L.masts.find(x => x.id === id) : t === 't' ? L.stands.find(x => x.id === id) : t === 'c' && L.tv ? L.cameras.find(x => x.id === id) : null;
    return item ? { type: t, item } : null;
  },

  pick(id, e, L3) {
    const room = L3.room();
    L3.sel = id;
    L3.renderSide();
    L3.view.redraw();
    const s = this._selected(room, id), C = this._ctx(room);
    if (!s || !C || s.type === 't') return null;
    const v = L3.view, [sx, sy] = v._pos(e);
    const z = s.type === 'c' ? Math.max(0.5, +s.item.z || 0) : 0;
    const start = v.planeAt(sx, sy, z), w0 = C.W(+s.item.x || 0, +s.item.y || 0);
    const snap = (x) => Math.round(x * 10) / 10;
    return {
      move: (ev) => {
        const [x, y] = v._pos(ev), p = v.planeAt(x, y, z);
        const q = this._toField(C.fr, w0[0] + p[0] - start[0], w0[1] + p[1] - start[1]);
        s.item.x = snap(q[0]); s.item.y = snap(q[1]);
        PlanEngine.requestDraw({ fg: true });
        v.redraw();
      },
      up: (ev, moved) => { if (moved) this._commit(L3); },
    };
  },

  _commit(L3) {
    PlanMarkup.markDirty();
    PlanMarkup.snapshot();
    PlanEngine.requestDraw({ all: true });
    L3.renderSide();
    L3.view.redraw();
  },

  async remove(L3, room) {
    const s = this._selected(room, L3.sel), Lr = SportsCalc._L(room);
    if (!s) return;
    if (s.type === 'm') {
      const n = (s.item.floods || []).length;
      if (n && !(await UI.confirm(`Remove ${s.item.name || 'this mast'} and its ${n} floods?`, { okText: 'Remove', cancelText: 'Cancel' }))) return;
      Lr.masts = SportsCalc.read(room).masts.filter(x => x !== s.item);
    } else if (s.type === 't') Lr.stands = SportsCalc.read(room).stands.filter(x => x !== s.item);
    else if (s.type === 'c') Lr.cameras = SportsCalc.read(room).cameras.filter(x => x !== s.item);
    L3.sel = null;
    this._commit(L3);
  },

  add(kind, L3, room) {
    const C = this._ctx(room);
    if (!C) return;
    const Lr = SportsCalc._L(room), L = C.L;
    if (kind === 'layout') { SportsCalc.setup({ room }); return; }
    if (kind === 'stand') {
      const sides = ['near', 'far', 'left', 'right'], used = new Set(L.stands.map(x => x.side || 'near'));
      const st = { id: SportsCalc._seq(room, 's'), name: 'Stand ' + (L.stands.length + 1), side: sides.find(x => !used.has(x)) || 'near',
        offset: 3, depth: 15, zFront: 0.5, zBack: 8, from: null, to: null, em: 0, gr: 0 };
      Lr.stands = L.stands.concat([st]);
      L3.sel = 't:' + st.id;
    } else if (kind === 'camera') {
      const c = { id: SportsCalc._seq(room, 'c'), name: L.cameras.length ? 'Camera ' + (L.cameras.length + 1) : 'Main camera', x: +(C.fr.L / 2).toFixed(1), y: -25, z: 12 };
      Lr.tv = true;
      Lr.cameras = L.cameras.concat([c]);
      L3.sel = 'c:' + c.id;
    }
    this._commit(L3);
  },

  // ─── Panels ────────────────────────────────────────────────────────────
  title(room) {
    const C = this._ctx(room);
    if (!C) return '';
    const { fr, L } = C, { r } = this._result(room);
    const n = SportsCalc.floodCount(room);
    return `<b>${escHtml(room.name || 'Field')}</b><span>${escHtml(SPORTS_FIELDS[L.sport].name)} · Class ${L.cls} · ${fr.L.toFixed(1)} × ${fr.W.toFixed(1)} m · ${L.masts.length} masts, ${n} floods${r && r.res.power ? ` · ${(r.res.power.watts / 1000).toFixed(1)} kW` : ''}</span>`;
  },

  palette(room, L3) {
    const L = SportsCalc.read(room);
    const btn = (k, label, icon) => `<button type="button" class="l3-pal-btn" data-s3-add="${k}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${icon}"/></svg><span>${label}</span></button>`;
    const row = (id, name, kind, dot) => `<button type="button" class="l3-row${L3.sel === id ? ' active' : ''}" data-l3-sel="${escHtml(id)}"><i style="background:${dot}"></i><span>${escHtml(name || '')}</span><small>${kind}</small></button>`;
    const list = L.masts.map(m => row('m:' + m.id, m.name || 'Mast', `${+m.h || 0} m · ${(m.floods || []).length} floods`, '#8b929c')).join('')
      + L.stands.map(s => row('t:' + s.id, s.name || 'Stand', 'Stand', '#b9c0ca')).join('')
      + (L.tv ? L.cameras.map(c => row('c:' + c.id, c.name || 'Camera', 'Camera', '#2563eb')).join('') : '');
    return `<div class="l3-pal-head">Add to the field</div>
      <div class="l3-pal-note">Drag a mast or camera to move it; its floods stay aimed at the same points.</div>
      <div class="l3-pal-grid">
        ${btn('layout', L.masts.length ? 'New masts…' : 'Masts…', 'M12 2v20M8 22h8M7 3h10v3H7z')}
        ${btn('stand', 'Stand', 'M3 20h18M5 20v-4h4v-4h4V8h4v12')}
        ${btn('camera', 'Camera', 'M3 7h12v10H3zM15 10l6-3v10l-6-3')}
      </div>
      <div class="l3-pal-head l3-pal-list-head">On this field</div>
      <div class="l3-list">${list || '<div class="l3-pal-note">No masts yet — press Masts… to lay them out.</div>'}</div>`;
  },

  props(room, L3) {
    const C = this._ctx(room);
    if (!C) return '';
    const { fr, L } = C, s = this._selected(room, L3.sel);
    const fx = (v) => (+v || 0).toFixed(2);
    const num = (attr, key, label, val, step, extra = '') => `<label class="l3-field"><span>${label}</span><input type="number" data-${attr}="${key}" value="${val}" step="${step}" ${extra}></label>`;
    const head = (name, kind, dot) => `<div class="l3-props-head"><i style="background:${dot}"></i><div><b>${escHtml(name || '')}</b><small>${kind}</small></div>
      <button type="button" class="l3-icon l3-del" data-l3="del" aria-label="Delete" title="Delete">✕</button></div>`;
    const foot = `<div class="l3-props-foot"><span>On this field</span><b>${L.masts.length} masts · ${SportsCalc.floodCount(room)} floods · ${L.stands.length} stands</b></div>`;
    const { r: rr } = this._result(room);
    if (!s) {
      return `<div class="l3-props-body">
        <div class="l3-props-title">${escHtml(room.name || 'Field')}</div>
        <p class="l3-muted">Nothing selected. Click a mast, stand or camera in the view or the list to edit it.</p>
        <p class="l3-muted">${escHtml(SPORTS_FIELDS[L.sport].name)} · Class ${L.cls} · Ēh ${L.em} lx · U₂ ≥ ${L.u2.toFixed(2)} · GR ≤ ${L.gr} · tilt ≤ ${L.maxTilt}°</p>
        <div class="l3-btns">
          <button type="button" class="plan-tb-btn" data-s3="layout">${L.masts.length ? 'New mast layout…' : 'Add masts…'}</button>
          ${L.masts.length ? '<button type="button" class="plan-tb-btn" data-s3="optimise">Optimise aiming</button>' : ''}
          ${rr ? '<button type="button" class="plan-tb-btn" data-s3="results">Results…</button>' : ''}
        </div>
        <p class="l3-muted">Sport, class, targets, the aerial zone and TV are in the field's properties on the Plan view.</p>
      </div>${foot}`;
    }
    const it = s.item;
    if (s.type === 'm') {
      const H = Math.max(+it.h || 20, 0.5), M = SportsCalc.toWorld(fr, +it.x || 0, +it.y || 0);
      const pcts = [...new Set((it.floods || []).map(x => SportsCalc._pct(x.fluxPct)))];
      const rows = (it.floods || []).map((fl, i) => {
        const a = SportsCalc.angles(M, H, SportsCalc.toWorld(fr, +fl.ax || 0, +fl.ay || 0));
        const bad = a.tilt > L.maxTilt;
        return `<tr><td>${i + 1}</td><td>${(+fl.ax || 0).toFixed(1)}, ${(+fl.ay || 0).toFixed(1)}</td><td class="${bad ? 'l3-bad' : ''}">${a.tilt.toFixed(1)}°</td><td>${SportsCalc._pct(fl.fluxPct)} %</td></tr>`;
      }).join('');
      return head(it.name || 'Mast', 'Mast', '#8b929c') + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Name</span><input type="text" data-s3m="name" value="${escHtml(it.name || '')}"></label>
        <div class="l3-grid2">
          ${num('s3m', 'x', 'Along, m', fx(it.x), 0.5)}${num('s3m', 'y', 'Across, m', fx(it.y), 0.5)}
          ${num('s3m', 'h', 'Height, m', +H.toFixed(2), 0.5, 'min="0.5" max="100"')}
          ${num('s3m', 'pct', 'Output, % (all)', pcts.length === 1 ? pcts[0] : '', 5, `min="0" max="100"${pcts.length > 1 ? ' placeholder="mixed"' : ''}`)}
        </div>
        <button type="button" class="plan-tb-btn" data-s3="aim">Aim floods…</button>
        ${rows ? `<table class="l3-table"><thead><tr><th>#</th><th>Aim x, y (m)</th><th>Tilt</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="l3-muted">No floods on this mast.</p>'}
        <p class="l3-muted">Along / across: field metres from its first corner. Tilt over ${L.maxTilt}° is red. The floods are drawn in rows on a headframe; the calculation puts them all at the mast top.</p>
      </div>${foot}`;
    }
    if (s.type === 't') {
      const sr = rr && (rr.res.stands || []).find(x => x.id === it.id);
      const v2 = (k) => it[k] == null || it[k] === '' ? '' : +it[k];
      return head(it.name || 'Stand', 'Stand', '#b9c0ca') + `<div class="l3-props-body">
        <label class="l3-field l3-wide"><span>Name</span><input type="text" data-s3t="name" value="${escHtml(it.name || '')}"></label>
        <label class="l3-field l3-wide"><span>Where</span><select data-s3t="side">${Object.entries(SportsCalc.STAND_SIDES).map(([k, n]) => `<option value="${k}"${k === (it.side || 'near') ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="l3-grid2">
          ${num('s3t', 'offset', 'Gap to line, m', v2('offset'), 0.5, 'min="0"')}${num('s3t', 'depth', 'Depth, m', v2('depth'), 0.5, 'min="0.5"')}
          ${num('s3t', 'zFront', 'Front row, m high', v2('zFront'), 0.5, 'min="0"')}${num('s3t', 'zBack', 'Back row, m high', v2('zBack'), 0.5, 'min="0"')}
          ${num('s3t', 'from', 'From, m', v2('from'), 1, 'placeholder="start"')}${num('s3t', 'to', 'To, m', v2('to'), 1, 'placeholder="end"')}
          ${num('s3t', 'em', 'Ēh min, lx', v2('em') || 0, 10, 'min="0"')}${num('s3t', 'gr', 'GR max', v2('gr') || 0, 1, 'min="0" max="100"')}
        </div>
        ${sr && sr.seats ? `<div class="l3-chips"><span>Seats Ē ${Math.round(sr.seats.Eav)} lx</span><span>Faces Ē ${Math.round(sr.faces.Eav)} lx</span>${sr.gr ? `<span>GR ${(+sr.gr.max).toFixed(1)}</span>` : ''}</div>` : '<p class="l3-muted">Calculate the field to get its result.</p>'}
        <p class="l3-muted">From / to run along its side of the field (blank = the whole side). 0 = no target.</p>
      </div>${foot}`;
    }
    return head(it.name || 'Camera', 'TV camera', '#2563eb') + `<div class="l3-props-body">
      <label class="l3-field l3-wide"><span>Name</span><input type="text" data-s3c="name" value="${escHtml(it.name || '')}"></label>
      <div class="l3-grid2">${num('s3c', 'x', 'Along, m', fx(it.x), 1)}${num('s3c', 'y', 'Across, m', fx(it.y), 1)}${num('s3c', 'z', 'Height, m', fx(it.z), 0.5, 'min="0"')}</div>
      <p class="l3-muted">Vertical illuminance towards this camera is checked when the field's Ēv-to-camera target is set.</p>
    </div>${foot}`;
  },

  resStrip(room) {
    const { r: rr, fresh } = this._result(room);
    const chip = (t, cls) => `<span class="l3-chip${cls ? ' ' + cls : ''}">${t}</span>`;
    if (!rr) return `<b>Field</b>${chip('Not calculated — press Calculate field')}`;
    const res = rr.res;
    const fmt = (c) => c.unit === 'lx' ? Math.round(c.value) + ' lx' : c.unit === '°' ? c.value.toFixed(1) + '°' : c.value.toFixed(2);
    const chips = (res.checks || []).map(c => chip(`${escHtml(c.label)} ${fmt(c)} <small>${c.op === '>=' ? '≥' : '≤'} ${c.req}</small>`, c.pass === true ? '' : c.pass === false ? 'bad' : '')).join('');
    const verdict = res.pass === true ? chip('Pass', 'ok') : res.pass === false ? chip('Fail', 'bad') : chip('No floods');
    return `<b>Field</b>${chips}${verdict}<span class="l3-spacer"></span>
      ${fresh ? chip('Up to date', 'ok') : chip('Out of date — the field, its masts or the luminaires changed since the last calculation', 'warn')}`;
  },

  legend(room, L3) {
    const { r: rr, fresh } = this._result(room);
    if (L3.mode === 'model') return null;
    if (!rr || !rr.res.horizontal) return `<b>${L3.mode === 'render' ? 'Rendered light' : 'False colour'}</b><span>Calculate the field to see it.</span>`;
    if (L3.mode === 'colour') {
      const top = Math.max(rr.res.horizontal.Emax || 0, 1);
      const f = (v) => v >= 100 ? Math.round(v) : v.toFixed(1);
      return `<b>Illuminance, lx</b><div class="plan-legend-bar" aria-hidden="true"></div>
        <div class="plan-legend-scale"><span>0</span><span>${f(top / 2)}</span><span>${f(top)}</span></div>
        <span>Horizontal on the pitch and the seats${rr.res.aerial ? '; the aerial layers show the mean vertical illuminance (a ball seen from any side)' : ''} — one scale.${fresh ? '' : ' Out of date.'}</span>
        ${rr.res.aerial ? `<label class="l3-cam-check"><input type="checkbox" data-s3="aerial"${this.aerial ? ' checked' : ''}> Aerial layers</label>
          ${this.aerial ? `<span>${rr.res.aerial.layers.map(l => `${l.height} m: Ēv ${Math.round(l.Evavg)} lx, U₂ ${(+l.U2).toFixed(2)}`).join(' · ')}</span>` : ''}` : ''}`;
    }
    return `<b>Rendered light</b><span>The pitch and the seats as bright as they look — illuminance × reflectance (ground ρ from the field, seats 0.3) — at night.${fresh ? '' : ' <b>Out of date</b> — showing the last calculation.'}</span>
      <label class="l3-expo">Exposure <input type="range" min="0.2" max="4" step="0.1" value="${L3.expo}" data-l3="expo"></label>`;
  },

  // ─── Events ────────────────────────────────────────────────────────────
  onClick(e, L3, room) {
    const add = e.target.closest('[data-s3-add]');
    if (add) { this.add(add.dataset.s3Add, L3, room); return true; }
    const a = e.target.closest('[data-s3], [data-l3="del"]');
    if (!a || a.tagName === 'INPUT') return false;
    const act = a.dataset.s3 || 'del';
    const s = this._selected(room, L3.sel);
    if (act === 'del') this.remove(L3, room);
    else if (act === 'layout') SportsCalc.setup({ room });
    else if (act === 'optimise') SportsCalc.optimise(room).then(o => { if (o) SportsCalc.run([room]); });
    else if (act === 'results') SportsCalc.openResults(room);
    else if (act === 'aim' && s && s.type === 'm') SportsCalc.openAim(room, s.item.id);
    else return false;
    return true;
  },

  onChange(e, L3, room) {
    const t = e.target, d = t.dataset;
    if (d.s3 === 'aerial') { this.aerial = t.checked; L3.render(); return; }
    const s = this._selected(room, L3.sel);
    if (!s) return;
    const it = s.item, val = parseFloat(t.value), ok = Number.isFinite(val);
    if (d.s3m && s.type === 'm') {
      const k = d.s3m;
      if (k === 'name') it.name = t.value;
      else if (k === 'pct') { if (ok) for (const fl of (it.floods || [])) fl.fluxPct = Math.max(0, Math.min(100, val)); }
      else if (k === 'h') { if (ok) it.h = Math.max(0.5, Math.min(100, val)); }
      else if (ok) it[k] = val;
    } else if (d.s3t && s.type === 't') {
      const k = d.s3t;
      if (k === 'name' || k === 'side') it[k] = t.value;
      else if ((k === 'from' || k === 'to') && t.value === '') it[k] = null;
      else it[k] = ok ? Math.max(k === 'depth' ? 0.5 : (k === 'from' || k === 'to' ? -1e4 : 0), val) : 0;
    } else if (d.s3c && s.type === 'c') {
      it[d.s3c] = d.s3c === 'name' ? t.value : (ok ? (d.s3c === 'z' ? Math.max(0, val) : val) : 0);
    } else return;
    this._commit(L3);
  },
};
