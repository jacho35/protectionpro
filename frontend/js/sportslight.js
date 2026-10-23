/* ProtectionPro — Lighting › Sports fields (floodlit pitches and courts).
 *
 * A sports field is a Lighting-tab zone of kind 'sports': a rectangle (the
 * principal area, PA) with its own frame — origin at its first corner, x along
 * the first edge (the length), y across (the width). Its masts and their
 * floodlights live on the field (`room.lighting.masts`), in field metres, so
 * moving or turning the field takes the masts and their aiming with it. Each
 * flood is aimed at a point on the pitch; its heading and tilt follow.
 *
 * The answer comes from /api/analysis/sports-lighting (horizontal grid, U₁ /
 * U₂, vertical illuminance towards cameras and players, CIE 112 GR, steepest
 * tilt) and is kept in RoomCalc.results like the other lighting zones. Every
 * field's floods also count as outdoor luminaires for outdoor areas and fences
 * (AreaCalc.luminaires), and every outdoor luminaire lights every field.
 * /api/analysis/sports-lighting/aim moves the aim points until the pitch is even.
 *
 * The class targets below are PROVISIONAL — check them against EN 12193 before
 * issue. Every number is editable on the field.
 */

const SPORTS_FIELDS = {
  football: { name: 'Football', length: 105, width: 68, lines: 'football',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 200, u2: 0.6, gr: 50, ra: 60 }, III: { em: 75, u2: 0.5, gr: 55, ra: 20 } } },
  rugby: { name: 'Rugby', length: 100, width: 70, lines: 'halfway',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 200, u2: 0.6, gr: 50, ra: 60 }, III: { em: 75, u2: 0.5, gr: 55, ra: 20 } } },
  hockey: { name: 'Hockey', length: 91.4, width: 55, lines: 'halfway',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 250, u2: 0.7, gr: 50, ra: 60 }, III: { em: 200, u2: 0.7, gr: 55, ra: 20 } } },
  tennis: { name: 'Tennis (one court with run-off)', length: 36.6, width: 18.3, lines: 'none',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 300, u2: 0.7, gr: 50, ra: 60 }, III: { em: 200, u2: 0.6, gr: 55, ra: 20 } } },
  netball: { name: 'Netball', length: 30.5, width: 15.25, lines: 'thirds',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 200, u2: 0.7, gr: 50, ra: 60 }, III: { em: 75, u2: 0.5, gr: 55, ra: 20 } } },
  custom: { name: 'Other (custom size)', length: 60, width: 40, lines: 'none',
    classes: { I: { em: 500, u2: 0.7, gr: 50, ra: 60 }, II: { em: 200, u2: 0.6, gr: 50, ra: 60 }, III: { em: 75, u2: 0.5, gr: 55, ra: 20 } } },
};

const SportsCalc = {
  CLASSES: {
    I: 'Class I — top-level competition (national, international)',
    II: 'Class II — mid-level competition, high-level training',
    III: 'Class III — local competition, training, school and recreation',
  },
  LAYOUTS: {
    corner4: { name: '4 corner masts', note: 'Fewest masts; tall, long throws.' },
    side4: { name: '4 side masts', note: 'Small pitches and courts.' },
    side6: { name: '6 side masts', note: 'Club pitches, Class I–II.' },
    side8: { name: '8 side masts', note: 'Lower masts, shorter throws.' },
  },
  // Generic floods are sized for the field: lumens per flood from the target (see sizing()).
  GENERIC: {
    __medium: { kind: 'generic_sports_medium', name: 'Generic sports floodlight — medium beam (≈ 30°), sized for the target' },
    __narrow: { kind: 'generic_sports_narrow', name: 'Generic sports floodlight — narrow beam (≈ 16°, long throws), sized for the target' },
  },
  LM_PER_W: 125,
  NOTE: 'Provisional targets — check them against EN 12193 before issue. Every number is editable.',

  // The Lighting tab's 3D view, when it shows a field, follows every change made here.
  _show3D() { if (typeof Light3D !== 'undefined' && Light3D._active) Light3D.render(); },

  // A flood's output % as a number (project data may carry anything).
  _pct(v) { return v == null || v === '' ? 100 : this._num(v, 100, 0, 100); },
  _num(v, d, lo, hi) { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; },

  // ─── Settings ───
  read(room) {
    const L = (room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const sport = SPORTS_FIELDS[L.sport] ? L.sport : 'football';
    const cls = ['I', 'II', 'III'].includes(L.cls) ? L.cls : 'II';
    const T = SPORTS_FIELDS[sport].classes[cls];
    const n = (k, d, lo, hi) => this._num(L[k], d, lo, hi);
    return {
      sport, cls, em: n('em', T.em, 0.1, 10000), u2: n('u2', T.u2, 0, 1), u1: n('u1', 0, 0, 1), gr: n('gr', T.gr, 0, 100), ra: n('ra', T.ra, 0, 100),
      maxTilt: n('maxTilt', 70, 10, 89), mf: n('mf', 0.8, 0.3, 1), groundRho: n('groundRho', 0.2, 0.01, 0.9), grid: n('grid', 0, 0, 20),
      evHeight: n('evHeight', 1.5, 0, 10), tv: !!L.tv, evCam: n('evCam', 0, 0, 10000), evCamU2: n('evCamU2', 0, 0, 1), edited: !!L.edited,
      masts: Array.isArray(L.masts) ? L.masts : [], cameras: Array.isArray(L.cameras) ? L.cameras : [],
      stands: Array.isArray(L.stands) ? L.stands : [], aerial: !!L.aerial, aerialEv: n('aerialEv', 0, 0, 10000),
      aerialHeights: this.parseHeights(L.aerialHeights != null ? L.aerialHeights : '2, 5, 10, 15'),
    };
  },
  parseHeights(v) {
    return [...new Set(String(v).split(/[,;\s]+/).map(Number).filter(h => Number.isFinite(h) && h > 0 && h <= 100))].sort((a, b) => a - b);
  },
  _L(room) {
    if (!room.lighting || typeof room.lighting !== 'object') room.lighting = {};
    return room.lighting;
  },
  _seq(room, p) { const L = this._L(room); L.seq = (L.seq || 0) + 1; return p + L.seq; },
  applyClass(room) {
    const L = this._L(room), R = this.read(room);
    const T = SPORTS_FIELDS[R.sport].classes[R.cls];
    Object.assign(L, { sport: R.sport, cls: R.cls, em: T.em, u2: T.u2, gr: T.gr, ra: T.ra, edited: false });
  },
  set(room, field, value) {
    const L = this._L(room);
    if (field === 'sport' || field === 'cls') { L[field] = value; this.applyClass(room); return; }
    if (field === 'tv' || field === 'aerial') { L[field] = !!value; return; }
    if (field === 'aerialHeights') { L.aerialHeights = this.parseHeights(value).join(', '); return; }
    const R = this.read(room);
    if (!(field in R) || ['masts', 'cameras', 'stands', 'edited', 'sport', 'cls'].includes(field)) return;
    L[field] = value;
    if (['em', 'u2', 'gr', 'ra'].includes(field)) L.edited = true;
    const N = this.read(room);
    L[field] = N[field];
  },

  // ─── The field frame (plan metres, y up) ───
  frame(room, f) {
    if (!f || !room.points || room.points.length < 3) return null;
    const P = room.points.map(p => ({ x: p.x * f, y: -p.y * f }));
    const O = P[0], a = P[1], c = P[P.length - 1];
    let ux = a.x - O.x, uy = a.y - O.y;
    const Lm = Math.hypot(ux, uy);
    if (Lm < 1e-6) return null;
    ux /= Lm; uy /= Lm;
    let vx = -uy, vy = ux;
    const dc = (c.x - O.x) * vx + (c.y - O.y) * vy;
    if (dc < 0) { vx = -vx; vy = -vy; }
    if (Math.abs(dc) < 1e-6) return null;
    return { O, u: { x: ux, y: uy }, v: { x: vx, y: vy }, L: Lm, W: Math.abs(dc), f };
  },
  toWorld(fr, x, y) { return { x: fr.O.x + x * fr.u.x + y * fr.v.x, y: fr.O.y + x * fr.u.y + y * fr.v.y }; },
  toPlan(fr, x, y) { const w = this.toWorld(fr, x, y); return { x: w.x / fr.f, y: -w.y / fr.f }; },
  // The four corners (plan px) of a field `Lm` × `Wm` centred on world (cx, cy), axes u / v.
  _rect(cx, cy, Lm, Wm, u, v, f) {
    const O = { x: cx - u.x * Lm / 2 - v.x * Wm / 2, y: cy - u.y * Lm / 2 - v.y * Wm / 2 };
    return [[0, 0], [Lm, 0], [Lm, Wm], [0, Wm]].map(([x, y]) => ({ x: (O.x + x * u.x + y * v.x) / f, y: -(O.y + x * u.y + y * v.y) / f }));
  },
  angleOf(fr) { return Math.atan2(fr.u.y, fr.u.x) * 180 / Math.PI; },

  // ─── Stands: a sloped rectangle beside one side or end, in field metres ───
  STAND_SIDES: { near: 'Near side (y < 0)', far: 'Far side (y > W)', left: 'End at x = 0', right: 'End at x = L' },
  // Corners in field metres, the front edge (nearest the pitch) first.
  standCorners(st, fr) {
    const off = Math.max(0, +st.offset || 0), d = Math.max(0.5, +st.depth || 10);
    const end = st.side === 'left' || st.side === 'right';
    const span = end ? fr.W : fr.L;
    const a = st.from != null && st.from !== '' ? +st.from : 0, b = st.to != null && st.to !== '' ? +st.to : span;
    if (st.side === 'far') return [[a, fr.W + off], [b, fr.W + off], [b, fr.W + off + d], [a, fr.W + off + d]];
    if (st.side === 'left') return [[-off, a], [-off, b], [-off - d, b], [-off - d, a]];
    if (st.side === 'right') return [[fr.L + off, a], [fr.L + off, b], [fr.L + off + d, b], [fr.L + off + d, a]];
    return [[a, -off], [b, -off], [b, -off - d], [a, -off - d]];
  },

  // New size or turn, about the field's centre. Masts and aim points scale with
  // the pitch; a mast behind a touchline or goal line keeps its setback.
  reshape(room, Lm, Wm, angleDeg) {
    const f = PlanEngine.factor(), fr = this.frame(room, f);
    if (!fr || !(Lm > 0.5) || !(Wm > 0.5)) return;
    const c = this.toWorld(fr, fr.L / 2, fr.W / 2);
    let u = fr.u, v = fr.v;
    if (angleDeg != null && Number.isFinite(angleDeg)) {
      const d = (angleDeg - this.angleOf(fr)) * Math.PI / 180, cs = Math.cos(d), sn = Math.sin(d);
      const rot = (p) => ({ x: p.x * cs - p.y * sn, y: p.x * sn + p.y * cs });
      u = rot(u); v = rot(v);
    }
    const sx = (x, a, b) => x < 0 ? x : x > a ? b + (x - a) : x * b / a;
    for (const m of this.read(room).masts) {
      m.x = +sx(+m.x || 0, fr.L, Lm).toFixed(2); m.y = +sx(+m.y || 0, fr.W, Wm).toFixed(2);
      for (const fl of (m.floods || [])) { fl.ax = +((+fl.ax || 0) * Lm / fr.L).toFixed(2); fl.ay = +((+fl.ay || 0) * Wm / fr.W).toFixed(2); }
    }
    for (const st of this.read(room).stands) {
      const k = (st.side === 'left' || st.side === 'right') ? Wm / fr.W : Lm / fr.L;
      if (st.from != null && st.from !== '') st.from = +((+st.from) * k).toFixed(2);
      if (st.to != null && st.to !== '') st.to = +((+st.to) * k).toFixed(2);
    }
    for (const cam of this.read(room).cameras) { cam.x = +sx(+cam.x || 0, fr.L, Lm).toFixed(2); cam.y = +sx(+cam.y || 0, fr.W, Wm).toFixed(2); }
    room.points = this._rect(c.x, c.y, Lm, Wm, u, v, f);
  },

  // ─── Floods → luminaires ───
  angles(M, h, A) {
    const dx = A.x - M.x, dy = A.y - M.y;
    return { rotate: Math.atan2(-dx, dy) * 180 / Math.PI, tilt: Math.atan2(Math.hypot(dx, dy), Math.max(h, 0.5)) * 180 / Math.PI };
  },
  floodLums(room, f) {
    const out = [], skipped = [];
    const fr = this.frame(room, f);
    if (!fr) return { lums: out, skipped };
    for (const m of this.read(room).masts) {
      const M = this.toWorld(fr, +m.x || 0, +m.y || 0), h = Math.max(+m.h || 20, 0.5);
      for (const fl of (m.floods || [])) {
        if (!fl.photoId || !PhotoLib.get(fl.photoId)) { skipped.push(`${room.name || 'Field'} ${m.name || ''}`); continue; }
        const a = this.angles(M, h, this.toWorld(fr, +fl.ax || 0, +fl.ay || 0));
        out.push({
          id: `${room.id}/${m.id}/${fl.id}`, x: +M.x.toFixed(4), y: +M.y.toFixed(4), h, rotate: +a.rotate.toFixed(4), tilt: +a.tilt.toFixed(4),
          photometryId: fl.photoId, fluxPct: this._pct(fl.fluxPct), fieldId: room.id,
        });
      }
    }
    return { lums: out, skipped };
  },
  // Every field's floods on the floor in view (AreaCalc.luminaires adds them to the outdoor lights).
  allFloods(f) {
    const lums = [], skipped = [];
    for (const r of (AppState.planMarkup.rooms || [])) {
      if (r.kind !== 'sports') continue;
      const o = this.floodLums(r, f);
      lums.push(...o.lums); skipped.push(...o.skipped);
    }
    return { lums, skipped };
  },
  floodCount(room) { return this.read(room).masts.reduce((s, m) => s + ((m.floods || []).length), 0); },

  fieldReq(room, f) {
    const fr = this.frame(room, f), L = this.read(room);
    const r4 = (x) => +(+x).toFixed(4);
    const cams = L.tv ? L.cameras.map(c => { const w = this.toWorld(fr, +c.x || 0, +c.y || 0); return { id: c.id, name: c.name || 'Camera', x: r4(w.x), y: r4(w.y), z: +c.z || 0 }; }) : [];
    const targets = { em: L.em, u2: L.u2, gr: L.gr, maxTilt: L.maxTilt };
    if (L.u1 > 0) targets.u1 = L.u1;
    if (L.tv && L.evCam > 0) targets.evCam = L.evCam;
    if (L.tv && L.evCamU2 > 0) targets.evCamU2 = L.evCamU2;
    if (L.aerial && L.aerialEv > 0) targets.aerialEv = L.aerialEv;
    const stands = L.stands.map(st => ({
      id: st.id, name: st.name || 'Stand', zFront: +st.zFront || 0, zBack: +st.zBack || 0,
      corners: this.standCorners(st, fr).map(([x, y]) => { const w = this.toWorld(fr, x, y); return [r4(w.x), r4(w.y)]; }),
      targets: { em: +st.em > 0 ? +st.em : undefined, gr: +st.gr > 0 ? +st.gr : undefined },
    }));
    return {
      stands, aerial: L.aerial ? { heights: L.aerialHeights } : null,
      id: room.id, name: room.name || 'Field', origin: [r4(fr.O.x), r4(fr.O.y)], axis: [r4(fr.u.x), r4(fr.u.y)], side: [r4(fr.v.x), r4(fr.v.y)],
      length: r4(fr.L), width: r4(fr.W), gridStep: L.grid > 0 ? L.grid : 0, mf: L.mf, groundRho: L.groundRho, evHeight: L.evHeight, cameras: cams, targets,
    };
  },

  signature(room) {
    const f = PlanEngine.factor();
    if (!f || !this.frame(room, f)) return '';
    const { lums } = AreaCalc.luminaires(f);
    const web = {};
    for (const l of lums) { const p = PhotoLib.get(l.photometryId); if (p) web[l.photometryId] = [p.lumens, p.watts, p.name]; }
    return JSON.stringify([this.fieldReq(room, f), lums, web]);
  },

  async run(rooms) {
    RoomCalc._sync();
    const f = PlanEngine.factor();
    if (!f) { if (rooms) UI.alert('Calibrate the plan first — the calculation needs real distances.'); return; }
    const list = (rooms || AppState.planMarkup.rooms || []).filter(r => r.kind === 'sports' && this.frame(r, f));
    if (!list.length) return;
    const { lums, skipped } = AreaCalc.luminaires(f);
    const photometry = {};
    for (const l of lums) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    if (UI.setBusy) UI.setBusy(true, 'Calculating sports lighting…');
    let out;
    try {
      out = await API.request('/analysis/sports-lighting', 'POST', { luminaires: lums, photometry, fields: list.map(r => this.fieldReq(r, f)) });
    } catch (e) {
      UI.alert('Sports lighting calculation failed: ' + (e && e.message ? e.message : e));
      return;
    } finally { if (UI.setBusy) UI.setBusy(false); }
    let pass = 0, fail = 0;
    for (const r of out.fields) {
      if (r.error) { UI.toast(`${r.name}: ${r.error}`, 'warn', 6000); continue; }
      const room = list.find(x => x.id === r.id);
      RoomCalc.results[r.id] = { res: r, sig: room ? this.signature(room) : '' };
      if (r.pass === true) pass++; else if (r.pass === false) fail++;
    }
    if (!RoomCalc.quiet) UI.toast(`Sports lighting: ${pass} pass, ${fail} fail${skipped.length ? ` · ${skipped.length} flood${skipped.length === 1 ? ' has' : 's have'} no library luminaire` : ''}.`, fail ? 'warn' : 'success', 6000);
    PlanEngine.requestDraw({ fg: true });
    PlanMarkup.refreshProps();
    if (this._resultsRoom && list.some(r => r.id === this._resultsRoom)) this._renderResults();
    this._show3D();
  },

  // ─── Masts: layouts, first aiming, the optimiser ───
  mastPositions(layout, Lm, Wm, s) {
    const side = (fx) => fx.map(x => [x * Lm, -s]).concat(fx.map(x => [x * Lm, Wm + s]));
    if (layout === 'corner4') return [[-s, -s], [Lm + s, -s], [-s, Wm + s], [Lm + s, Wm + s]];
    if (layout === 'side4') return side([0.2, 0.8]);
    if (layout === 'side8') return side([0.1, 0.3667, 0.6333, 0.9]);
    return side([0.1, 0.5, 0.9]);
  },
  // Lowest mast that sees the pitch at 25° or more: from the centre line (side masts)
  // or the centre spot (corner masts) — the usual rule of thumb for glare.
  suggestHeight(layout, Lm, Wm, s) {
    const d = layout === 'corner4' ? Math.hypot(Lm / 2 + s, Wm / 2 + s) : s + Wm / 2;
    return Math.max(8, Math.ceil(Math.tan(25 * Math.PI / 180) * d));
  },
  // Floods per mast and lumens per flood. Enough floods to cover the pitch
  // (one per 150 m², at least 2 a mast) and enough flux for the target:
  // Φ = Ē·A / (UF·MF), UF 0.75 for floods aimed inside the playing area. A
  // generic flood is sized to that flux (rounded up to 5 000 lm, 125 lm/W); a
  // library luminaire keeps its own lumens and sets the count instead.
  sizing(em, Lm, Wm, mf, nMasts, lumens) {
    const A = Lm * Wm, flux = em * A / (0.75 * mf);
    const cover = Math.max(2, Math.ceil(A / 150 / Math.max(nMasts, 1)));
    if (!(lumens > 0)) {
      const each = Math.max(10000, Math.ceil(flux / (cover * nMasts) / 5000) * 5000);
      return { perMast: cover, lumens: each, watts: Math.round(each / this.LM_PER_W) };
    }
    return { perMast: Math.max(cover, Math.ceil(flux / lumens / nMasts)), lumens, watts: null };
  },
  // An even spread of aim points over the pitch (rows of nearly equal length),
  // each mast taking its nearest k. The optimiser then evens the light out.
  initialAims(masts, k, Lm, Wm) {
    const N = masts.length * k;
    const rows = Math.max(1, Math.round(Math.sqrt(N * Wm / Lm)));
    const base = Math.floor(N / rows), extra = N - base * rows;
    const pts = [];
    for (let j = 0; j < rows; j++) {
      const n = base + (j < extra ? 1 : 0);
      for (let i = 0; i < n; i++) pts.push([(i + 0.5) / n * Lm, (j + 0.5) / rows * Wm]);
    }
    const pairs = [];
    masts.forEach((m, a) => pts.forEach((p, b) => pairs.push([Math.hypot(p[0] - m[0], p[1] - m[1]), a, b])));
    pairs.sort((x, y) => x[0] - y[0]);
    const cnt = masts.map(() => 0), took = new Set(), out = masts.map(() => []);
    for (const [, a, b] of pairs) {
      if (cnt[a] < k && !took.has(b)) { cnt[a]++; took.add(b); out[a].push(pts[b]); }
    }
    return out;
  },
  createMasts(room, o) {
    const f = PlanEngine.factor(), fr = this.frame(room, f);
    if (!fr) return;
    const L = this._L(room);
    const pos = this.mastPositions(o.layout, fr.L, fr.W, o.setback);
    const aims = this.initialAims(pos, o.perMast, fr.L, fr.W);
    L.seq = 0;
    L.masts = pos.map(([x, y], i) => ({
      id: this._seq(room, 'm'), name: 'M' + (i + 1), x: +x.toFixed(2), y: +y.toFixed(2), h: o.h,
      floods: aims[i].map(([ax, ay]) => ({ id: this._seq(room, 'f'), ax: +ax.toFixed(2), ay: +ay.toFixed(2), photoId: o.photoId, fluxPct: 100 })),
    }));
  },
  async optimise(room, quiet) {
    const f = PlanEngine.factor(), fr = this.frame(room, f), L = this.read(room);
    if (!fr) return null;
    const photometry = {};
    const masts = L.masts.map(m => ({
      id: m.id, x: +m.x || 0, y: +m.y || 0, h: +m.h || 20,
      floods: (m.floods || []).filter(fl => PhotoLib.get(fl.photoId)).map(fl => {
        photometry[fl.photoId] = PhotoLib.get(fl.photoId);
        return { id: fl.id, ax: +fl.ax || 0, ay: +fl.ay || 0, photometryId: fl.photoId, fluxPct: this._pct(fl.fluxPct) };
      }),
    }));
    if (!masts.some(m => m.floods.length)) { UI.toast('Add floodlights with a library luminaire first.', 'info'); return null; }
    if (UI.setBusy) UI.setBusy(true, 'Aiming the floodlights…');
    let out;
    try {
      out = await API.request('/analysis/sports-lighting/aim', 'POST', {
        field: { length: fr.L, width: fr.W, gridStep: L.grid > 0 ? L.grid : 0, mf: L.mf, maxTilt: L.maxTilt }, masts, photometry,
      });
    } catch (e) {
      UI.alert('Could not optimise the aiming: ' + (e && e.message ? e.message : e));
      return null;
    } finally { if (UI.setBusy) UI.setBusy(false); }
    const byId = new Map(L.masts.map(m => [m.id, m]));
    for (const om of out.masts) {
      const m = byId.get(om.id);
      if (!m) continue;
      const fl = new Map((m.floods || []).map(x => [x.id, x]));
      for (const a of om.floods) { const t = fl.get(a.id); if (t) { t.ax = a.ax; t.ay = a.ay; } }
    }
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    this._show3D();
    if (!quiet) UI.toast(`Aiming: U₂ ${out.before.U2.toFixed(2)} → ${out.after.U2.toFixed(2)}, Ēh ${Math.round(out.after.Eav)} lx (this field's own floods only).`, 'success', 6000);
    return out;
  },

  // ─── The new-field / mast-layout dialog ───
  _photoOptions(cur) {
    const libs = PhotoLib.list().filter(p => p.group !== 'indoor');
    const gen = Object.entries(this.GENERIC).map(([k, g]) => `<option value="${k}"${cur === k ? ' selected' : ''}>Add: ${escHtml(g.name)}</option>`).join('');
    return libs.map(p => `<option value="${escHtml(p.id)}"${p.id === cur ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`).join('') + gen;
  },
  _lumens(photo) {
    const p = !this.GENERIC[photo] && PhotoLib.get(photo);
    return p ? p.lumens : 0;
  },
  // A generic flood's lumens for the count actually chosen.
  _genLumens(a, per) {
    const flux = a.lumens * a.perMast * a.n;           // what the suggested count needed in all
    return Math.max(10000, Math.ceil(flux / (per * a.n) / 5000) * 5000);
  },

  // A floor with no drawing under it has nothing to calibrate against: give
  // it a scale (about 180 m across the view, so a full pitch and its masts
  // fit) and say so. A floor with an image or DXF still needs calibrating.
  _autoScale() {
    const pm = AppState.planMarkup;
    if ((pm.plans || []).length || (pm.dxfs || []).length) return null;
    const visW = (PlanEngine.cssW || 1000) / ((PlanEngine.view && PlanEngine.view.zoom) || 1);
    const raw = 180 / visW;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const factor = Math.round(raw / p * 10) / 10 * p;   // two significant figures
    pm.scale = { factor, source: 'auto' };
    PlanMarkup.markDirty();
    if (PlanMarkup.updateScaleReadout) PlanMarkup.updateScaleReadout();
    UI.toast('Blank plan: set to scale automatically. Calibrate if you add a drawing under the field.', 'info', 6000);
    return factor;
  },

  // opts: { centre: plan point } for a new field, or { room } to replace a field's masts.
  setup(opts) {
    const f = PlanEngine.factor() || this._autoScale();
    if (!f) { UI.alert('Calibrate the plan first: a sports field is drawn to scale, and this floor has a drawing whose scale is not known.'); return; }
    const room = opts.room || null;
    const R = room ? this.read(room) : null;
    const fr = room ? this.frame(room, f) : null;
    const libs = PhotoLib.list().filter(p => p.group !== 'indoor');
    const firstFlood = R && R.masts[0] && R.masts[0].floods && R.masts[0].floods[0];
    const st = {
      name: PlanMarkup.nextCounter('_sports', 'Field '), sport: R ? R.sport : 'football', cls: R ? R.cls : 'II',
      length: fr ? +fr.L.toFixed(2) : SPORTS_FIELDS.football.length, width: fr ? +fr.W.toFixed(2) : SPORTS_FIELDS.football.width, angle: fr ? +this.angleOf(fr).toFixed(1) : 0,
      layout: 'side6', setback: 5, h: null, perMast: null,
      photo: (firstFlood && firstFlood.photoId) || '__medium', optimise: true,
    };
    const auto = () => {
      const T = SPORTS_FIELDS[st.sport].classes[st.cls];
      const em = R ? R.em : T.em, mf = R ? R.mf : 0.8;
      const n = this.mastPositions(st.layout, st.length, st.width, st.setback).length;
      const z = this.sizing(em, st.length, st.width, mf, n, this._lumens(st.photo));
      return { h: this.suggestHeight(st.layout, st.length, st.width, st.setback), perMast: z.perMast, lumens: z.lumens, watts: z.watts, n, em };
    };
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'sf-setup-title');
    const field = (k, label, val, extra) => `<label class="plan-field"><span>${label}</span><input type="number" data-s="${k}" value="${escHtml(val)}" ${extra || ''} style="width:100%"></label>`;
    const render = () => {
      const a = auto(), h = st.h != null ? st.h : a.h, per = st.perMast != null ? st.perMast : a.perMast;
      const T = SPORTS_FIELDS[st.sport].classes[st.cls];
      ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:720px">
        <div class="modal-header"><h3 id="sf-setup-title">${room ? `Masts for ${escHtml(room.name || 'the field')}` : 'New sports field'}</h3></div>
        <div class="modal-body">
          ${room ? '' : `<div class="sf-grid3">
            <label class="plan-field"><span>Name</span><input type="text" data-s="name" value="${escHtml(st.name)}" style="width:100%"></label>
            <label class="plan-field"><span>Sport</span><select data-s="sport" style="width:100%">${Object.entries(SPORTS_FIELDS).map(([k, s]) => `<option value="${k}"${k === st.sport ? ' selected' : ''}>${escHtml(s.name)}</option>`).join('')}</select></label>
            <label class="plan-field"><span>Lighting class</span><select data-s="cls" style="width:100%">${Object.entries(this.CLASSES).map(([k, n]) => `<option value="${k}"${k === st.cls ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select></label>
          </div>
          <div class="sf-note">Targets: Ēh ≥ ${T.em} lx · U₂ ≥ ${T.u2} · GR ≤ ${T.gr} · Ra ≥ ${T.ra}. ${escHtml(this.NOTE)}</div>
          <div class="sf-grid3">${field('length', 'Length (m)', st.length, 'min="5" step="0.1"')}${field('width', 'Width (m)', st.width, 'min="5" step="0.1"')}${field('angle', 'Turn (°)', st.angle, 'step="5"')}</div>`}
          <div class="sf-layouts" role="radiogroup" aria-label="Mast layout">${Object.entries(this.LAYOUTS).map(([k, l]) => `<label class="sf-layout${k === st.layout ? ' on' : ''}">
            <input type="radio" name="sf-layout" data-s="layout" value="${k}"${k === st.layout ? ' checked' : ''}>${this._layoutThumb(k)}<b>${l.name}</b><small>${l.note}</small></label>`).join('')}</div>
          <div class="sf-grid3">
            ${field('setback', 'Setback behind the line (m)', st.setback, 'min="0" step="0.5"')}
            ${field('h', `Mast height (m) — suggested ${a.h}`, h, 'min="4" step="1"')}
            ${field('perMast', `Floods per mast — suggested ${a.perMast}`, per, 'min="1" max="60" step="1"')}
          </div>
          <label class="plan-field"><span>Floodlight</span><select data-s="photo" style="width:100%">${this._photoOptions(st.photo)}</select></label>
          <label class="plan-field-check"><input type="checkbox" data-s="optimise"${st.optimise ? ' checked' : ''}> Optimise the aiming and calculate</label>
          <div class="sf-note">${a.n} masts × ${per} floods = ${a.n * per} floodlights${this.GENERIC[st.photo] ? ` of ${this._genLumens(a, per).toLocaleString()} lm / ${Math.round(this._genLumens(a, per) / this.LM_PER_W)} W each (for Ēh ${a.em} lx)` : ''}. The suggested height sees the pitch at 25° or more from the ${st.layout === 'corner4' ? 'centre spot' : 'centre line'}; the counts assume 75 % of the light lands on the pitch and one flood per 150 m² for an even spread.${room && R.masts.length ? ' <b>Replaces the field\'s ' + R.masts.length + ' masts.</b>' : ''}</div>
          <div class="ui-dialog-actions"><button class="btn-small" data-s-act="cancel">Cancel</button><button class="btn-primary" data-s-act="ok">${room ? 'Replace masts' : 'Create field'}</button></div>
        </div></div>`;
    };
    render();
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.s;
      if (!k) return;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (k === 'sport') { st.sport = v; st.length = SPORTS_FIELDS[v].length; st.width = SPORTS_FIELDS[v].width; st.h = null; st.perMast = null; }
      else if (k === 'name' || k === 'cls' || k === 'layout' || k === 'photo') { st[k] = v; if (k !== 'name') { st.h = k === 'layout' ? null : st.h; st.perMast = null; } }
      else if (k === 'optimise') st.optimise = v;
      else { const x = parseFloat(v); if (Number.isFinite(x)) st[k] = x; if (k === 'length' || k === 'width' || k === 'setback') { st.h = null; st.perMast = null; } }
      render();
    });
    ov.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-s-act]');
      if (e.target === ov || (act && act.dataset.sAct === 'cancel')) { close(); return; }
      if (!act || act.dataset.sAct !== 'ok') return;
      const a = auto();
      const h = Math.max(4, st.h != null ? st.h : a.h), per = Math.max(1, Math.round(st.perMast != null ? st.perMast : a.perMast));
      if (!(st.length > 0.5 && st.width > 0.5)) { UI.toast('Give the field a length and a width.', 'warn'); return; }
      let photoId = st.photo;
      if (this.GENERIC[photoId]) {
        const g = this.GENERIC[photoId], lm = this._genLumens(a, per);
        try { photoId = await PhotoLib.addGeneric(g.kind, lm, Math.round(lm / this.LM_PER_W)); } catch (err) { UI.alert('Could not add the floodlight: ' + (err.message || err)); return; }
      }
      close();
      let target = room;
      if (!target) {
        const c = { x: opts.centre.x * f, y: -opts.centre.y * f };
        const t = st.angle * Math.PI / 180;
        const u = { x: Math.cos(t), y: Math.sin(t) }, v = { x: -Math.sin(t), y: Math.cos(t) };
        target = { id: AppState.planGenId('pmrm'), name: st.name || 'Field', kind: 'sports', color: null, points: this._rect(c.x, c.y, st.length, st.width, u, v, f), lighting: { sport: st.sport, cls: st.cls } };
        this.applyClass(target);
        AppState.planMarkup.rooms.push(target);
      }
      this.createMasts(target, { layout: st.layout, setback: st.setback, h, perMast: per, photoId });
      PlanMarkup.selectOnly(target.id);
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
      if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
      PlanEngine.requestDraw({ all: true });
      this._show3D();
      if (st.optimise) {
        const o = await this.optimise(target, true);
        await this.run([target]);
        if (o) UI.toast(`Aimed: U₂ ${o.before.U2.toFixed(2)} → ${o.after.U2.toFixed(2)}.`, 'success', 5000);
        PlanEngine.requestDraw({ all: true });
      }
    });
    document.body.appendChild(ov);
  },

  _layoutThumb(k) {
    const pos = this.mastPositions(k, 100, 64, 9);
    const dots = pos.map(([x, y]) => `<circle cx="${(x + 14).toFixed(1)}" cy="${(64 - y + 12).toFixed(1)}" r="4"></circle>`).join('');
    return `<svg viewBox="0 0 128 88" width="128" height="88" aria-hidden="true"><rect x="14" y="12" width="100" height="64" class="sf-thumb-pitch"></rect><line x1="64" y1="12" x2="64" y2="76" class="sf-thumb-line"></line><g class="sf-thumb-mast">${dots}</g></svg>`;
  },

  // ─── Properties panel (Lighting tab) ───
  panel(room) {
    const L = this.read(room), f = PlanEngine.factor(), fr = this.frame(room, f);
    const num = (k, label, unit, step, extra) => `<label class="plan-field"><span>${label}</span><input type="number" data-sf="${k}" value="${escHtml(L[k])}" step="${step}" ${extra || ''} style="width:100%"><small>${unit}</small></label>`;
    const masts = L.masts.map(m => `<div class="sf-mast-row"><span><b>${escHtml(m.name || 'Mast')}</b> · ${+m.h || 0} m · ${(m.floods || []).length} floods</span>
      <button type="button" class="btn-small" data-sf-aim="${escHtml(m.id)}">Aim…</button></div>`).join('');
    const cams = L.tv ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        ${num('evCam', 'Ēv to camera', 'lx, 0 = none', 10, 'min="0"')}${num('evCamU2', 'Ev min / Ēv', '0 = none', 0.05, 'min="0" max="1"')}</div>
      ${L.cameras.map(c => `<div class="sf-cam-row" data-sf-cam="${escHtml(c.id)}">
        <input type="text" data-sf-c="name" value="${escHtml(c.name || 'Camera')}" aria-label="Camera name">
        <input type="number" data-sf-c="x" value="${+c.x || 0}" step="1" aria-label="Camera x (m along the field)" title="x along the field, m">
        <input type="number" data-sf-c="y" value="${+c.y || 0}" step="1" aria-label="Camera y (m across the field)" title="y across the field, m">
        <input type="number" data-sf-c="z" value="${+c.z || 0}" step="1" aria-label="Camera height (m)" title="height, m">
        <button type="button" class="btn-small" data-sf-cam-rm aria-label="Remove camera">×</button></div>`).join('')}
      <button type="button" class="btn-small" data-sf-cam-add>+ Camera</button>
      <div class="sf-note">Camera x along the field, y across it (negative = behind the near touchline), height — metres. TV targets come from the broadcaster or league.</div>` : '';
    return `<div class="rl-room" data-sf-room="${escHtml(room.id)}" style="margin-top:12px;border-top:1px solid var(--border,#d9dee4);padding-top:10px">
      <div class="plan-props-title" style="font-size:13px">Sports lighting${fr ? ` — ${fr.L.toFixed(1)} × ${fr.W.toFixed(1)} m` : ''}</div>
      ${RoomLighting.typeSelect(room)}
      ${typeof Light3D !== 'undefined' ? '<button type="button" class="plan-circuit-btn" data-sf-3d style="margin:2px 0 6px">View in 3D — masts, aiming, stands, rendered light</button>' : ''}
      <label class="plan-field"><span>Sport</span><select data-sf="sport" style="width:100%">${Object.entries(SPORTS_FIELDS).map(([k, s]) => `<option value="${k}"${k === L.sport ? ' selected' : ''}>${escHtml(s.name)}</option>`).join('')}</select></label>
      <label class="plan-field"><span>Lighting class</span><select data-sf="cls" style="width:100%">${Object.entries(this.CLASSES).map(([k, n]) => `<option value="${k}"${k === L.cls ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select></label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        ${num('em', 'Ēh', 'lx', 10, 'min="1"')}${num('u2', 'U₂ = Emin / Ēh', '', 0.05, 'min="0" max="1"')}
        ${num('u1', 'U₁ = Emin / Emax', '0 = none', 0.05, 'min="0" max="1"')}${num('gr', 'GR limit', '', 1, 'min="0" max="100"')}
        ${num('ra', 'Ra min', 'luminaire data sheet', 5, 'min="0" max="100"')}${num('maxTilt', 'Max flood tilt', '°', 1, 'min="10" max="89"')}
      </div>
      <div class="sf-note">${L.edited ? 'Edited. <button type="button" class="btn-small" data-sf-reset>Reset to class</button> ' : ''}${escHtml(this.NOTE)}</div>
      ${fr ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
        <label class="plan-field"><span>Length</span><input type="number" data-sf-dim="L" value="${fr.L.toFixed(2)}" step="0.1" min="1" style="width:100%"><small>m</small></label>
        <label class="plan-field"><span>Width</span><input type="number" data-sf-dim="W" value="${fr.W.toFixed(2)}" step="0.1" min="1" style="width:100%"><small>m</small></label>
        <label class="plan-field"><span>Turn</span><input type="number" data-sf-dim="A" value="${this.angleOf(fr).toFixed(1)}" step="5" style="width:100%"><small>°</small></label></div>
        <button type="button" class="btn-small" data-sf-fit>Size for ${escHtml(SPORTS_FIELDS[L.sport].name)} (${SPORTS_FIELDS[L.sport].length} × ${SPORTS_FIELDS[L.sport].width} m)</button>` : '<div class="sf-note">Draw the field as a rectangle — the first edge is its length.</div>'}
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:6px">
        ${num('mf', 'Maint. factor', '', 0.01, 'min="0.3" max="1"')}${num('groundRho', 'Ground ρ', 'grass 0.2', 0.01, 'min="0.01" max="0.9"')}
        <label class="plan-field"><span>Grid</span><input type="number" data-sf="grid" value="${L.grid > 0 ? L.grid : ''}" step="0.5" min="0.5" max="20" placeholder="auto" style="width:100%"><small>m</small></label>
      </div>
      <div class="sf-sec"><div class="plan-props-title" style="font-size:13px">Masts — ${L.masts.length} masts, ${this.floodCount(room)} floods</div>
        ${masts || '<div class="sf-note">No masts yet.</div>'}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
          <button type="button" class="plan-circuit-btn" data-sf-layout>${L.masts.length ? 'New mast layout…' : 'Add masts…'}</button>
          ${L.masts.length ? '<button type="button" class="plan-circuit-btn" data-sf-opt>Optimise aiming</button>' : ''}
        </div></div>
      <div class="sf-sec"><div class="plan-props-title" style="font-size:13px">Stands — spill light and spectator glare</div>
        ${L.stands.map(st => `<div class="sf-stand" data-sf-st="${escHtml(st.id)}">
          <div class="sf-stand-head"><input type="text" data-st="name" value="${escHtml(st.name || 'Stand')}" aria-label="Stand name">
            <select data-st="side" aria-label="Where the stand is">${Object.entries(this.STAND_SIDES).map(([k, n]) => `<option value="${k}"${k === (st.side || 'near') ? ' selected' : ''}>${n}</option>`).join('')}</select>
            <button type="button" class="btn-small" data-sf-st-rm aria-label="Remove stand">×</button></div>
          <div class="sf-stand-grid">
            ${[['offset', 'Gap to line', 'm'], ['depth', 'Depth', 'm'], ['zFront', 'Front row', 'm high'], ['zBack', 'Back row', 'm high'],
               ['from', 'From', 'm, blank = whole'], ['to', 'To', 'm'], ['em', 'Ēh min', 'lx, 0 = none'], ['gr', 'GR max', '0 = none']].map(([k, lab, unit]) =>
              `<label class="plan-field"><span>${lab}</span><input type="number" data-st="${k}" value="${st[k] == null || st[k] === '' ? '' : +st[k]}" step="0.5"><small>${unit}</small></label>`).join('')}
          </div></div>`).join('')}
        <button type="button" class="btn-small" data-sf-st-add>+ Stand</button>
        <div class="sf-note">Seat illuminance, Ev on spectators' faces turned to the pitch, and GR for a spectator looking down at the pitch (eye 1.2 m above the row).</div></div>
      <div class="sf-sec"><label class="plan-field-check"><input type="checkbox" data-sf="aerial"${L.aerial ? ' checked' : ''}> Aerial zone — light on a ball in flight</label>
        ${L.aerial ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
          <label class="plan-field"><span>Heights</span><input type="text" data-sf="aerialHeights" value="${escHtml(L.aerialHeights.join(', '))}" style="width:100%"><small>m above the pitch</small></label>
          ${num('aerialEv', 'Ēv min at each height', 'lx, 0 = none', 10, 'min="0"')}</div>
          <div class="sf-note">The pitch grid repeated at each height: horizontal illuminance and the mean of four vertical planes (a ball seen from any side).</div>` : ''}</div>
      <div class="sf-sec"><label class="plan-field-check"><input type="checkbox" data-sf="tv"${L.tv ? ' checked' : ''}> Televised — vertical illuminance to cameras</label>${cams}</div>
      ${this.resultHtml(room)}
    </div>`;
  },

  resultHtml(room) {
    const r = RoomCalc.results[room.id];
    const btn = `<button type="button" class="plan-circuit-btn" data-sf-run>${r ? '↻ Recalculate' : '▶ Calculate lighting'}</button>`;
    if (!r) return `<div class="sf-sec">${btn}</div>`;
    const res = r.res, cur = r.sig === this.signature(room), hz = res.horizontal || {};
    const rows = (res.checks || []).map(c => {
      const val = c.unit === 'lx' ? c.value.toFixed(0) : c.unit === '°' ? c.value.toFixed(1) : c.value.toFixed(2);
      const col = c.pass === true ? '#1d6b3a' : c.pass === false ? '#a61b1b' : '#616e7c';
      return `<tr><td>${escHtml(c.label)}</td><td style="text-align:right;font-family:monospace">${val}</td>
        <td style="text-align:right;color:var(--text-muted);font-family:monospace">${c.op === '>=' ? '≥' : '≤'} ${c.req}</td>
        <td style="color:${col};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    }).join('');
    return `<div class="sf-sec">
      ${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date — the field, its masts or the luminaires changed.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0">Emin ${Math.round(hz.Emin || 0)} / Emax ${Math.round(hz.Emax || 0)} lx · U₁ ${(hz.U1 || 0).toFixed(2)} · grid ${hz.nx} × ${hz.ny} · ${res.power.count} floods, ${(res.power.watts / 1000).toFixed(1)} kW, ${res.power.wm2.toFixed(1)} W/m²</div>
      ${(res.warnings || []).concat(res.notes || []).map(w => `<div style="font-size:11px;color:#8a5a00">${escHtml(w)}</div>`).join('')}
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="plan-circuit-btn" data-sf-results>Results…</button>${btn}</div></div>`;
  },

  _bound: false,
  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    const roomOf = () => {
      const w = propsEl.querySelector('[data-sf-room]');
      return w && (AppState.planMarkup.rooms || []).find(r => r.id === w.dataset.sfRoom);
    };
    const done = () => { PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ all: true }); };
    propsEl.addEventListener('change', (e) => {
      const t = e.target, room = roomOf();
      if (!room || !t.dataset) return;
      if (t.dataset.sf) { this.set(room, t.dataset.sf, t.type === 'checkbox' ? t.checked : t.value); done(); }
      else if (t.dataset.sfDim) {
        const fr = this.frame(room, PlanEngine.factor());
        if (!fr) return;
        const x = parseFloat(t.value);
        if (!Number.isFinite(x)) return;
        if (t.dataset.sfDim === 'L') this.reshape(room, Math.max(1, x), fr.W, null);
        else if (t.dataset.sfDim === 'W') this.reshape(room, fr.L, Math.max(1, x), null);
        else this.reshape(room, fr.L, fr.W, x);
        done();
      } else if (t.dataset.st) {
        const row = t.closest('[data-sf-st]');
        const st = row && this.read(room).stands.find(x => x.id === row.dataset.sfSt);
        if (!st) return;
        const k = t.dataset.st;
        if (k === 'name' || k === 'side') st[k] = t.value;
        else if ((k === 'from' || k === 'to') && t.value === '') st[k] = null;
        else st[k] = parseFloat(t.value) || 0;
        done();
      } else if (t.dataset.sfC) {
        const row = t.closest('[data-sf-cam]');
        const cam = row && this.read(room).cameras.find(c => c.id === row.dataset.sfCam);
        if (!cam) return;
        cam[t.dataset.sfC] = t.dataset.sfC === 'name' ? t.value : (parseFloat(t.value) || 0);
        done();
      }
    });
    propsEl.addEventListener('click', (e) => {
      const room = roomOf();
      if (!room) return;
      const hit = (s) => e.target.closest(s);
      if (hit('[data-sf-3d]') && typeof LightingWS !== 'undefined') LightingWS.open3D(room.id);
      else if (hit('[data-sf-run]')) this.run([room]);
      else if (hit('[data-sf-results]')) this.openResults(room);
      else if (hit('[data-sf-layout]')) this.setup({ room });
      else if (hit('[data-sf-opt]')) this.optimise(room).then(o => { if (o) this.run([room]); });
      else if (hit('[data-sf-aim]')) this.openAim(room, hit('[data-sf-aim]').dataset.sfAim);
      else if (hit('[data-sf-reset]')) { this.applyClass(room); done(); }
      else if (hit('[data-sf-fit]')) { const S = SPORTS_FIELDS[this.read(room).sport]; this.reshape(room, S.length, S.width, null); done(); }
      else if (hit('[data-sf-cam-add]')) {
        const fr = this.frame(room, PlanEngine.factor()), L = this._L(room);
        L.cameras = (Array.isArray(L.cameras) ? L.cameras : []).concat([{ id: this._seq(room, 'c'), name: L.cameras && L.cameras.length ? 'Camera ' + (L.cameras.length + 1) : 'Main camera', x: fr ? +(fr.L / 2).toFixed(1) : 0, y: -25, z: 12 }]);
        done();
      } else if (hit('[data-sf-st-add]')) {
        const L = this._L(room), cur = this.read(room).stands;
        L.stands = cur.concat([{ id: this._seq(room, 's'), name: 'Stand ' + (cur.length + 1), side: cur.some(x => (x.side || 'near') === 'near') ? 'far' : 'near',
          offset: 3, depth: 15, zFront: 0.5, zBack: 8, from: null, to: null, em: 0, gr: 0 }]);
        done();
      } else if (hit('[data-sf-st-rm]')) {
        const row = hit('[data-sf-st-rm]').closest('[data-sf-st]'), L = this._L(room);
        L.stands = this.read(room).stands.filter(x => x.id !== row.dataset.sfSt);
        done();
      } else if (hit('[data-sf-cam-rm]')) {
        const row = hit('[data-sf-cam-rm]').closest('[data-sf-cam]'), L = this._L(room);
        L.cameras = (L.cameras || []).filter(c => c.id !== row.dataset.sfCam);
        done();
      }
    });
  },

  // ─── Aiming dialog ───
  _aim: null,         // { roomId, mastId } while the dialog is open (the plan draws its aim lines)
  openAim(room, mastId) {
    const f = PlanEngine.factor();
    if (!this.frame(room, f)) { UI.alert('Calibrate the plan and draw the field first.'); return; }
    this._aim = { roomId: room.id, mastId: mastId || (this.read(room).masts[0] || {}).id };
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'sf-aim-title');
    const mast = () => this.read(room).masts.find(m => m.id === this._aim.mastId);
    const render = () => {
      const fr = this.frame(room, PlanEngine.factor()), L = this.read(room), m = mast();
      const libs = PhotoLib.list().filter(p => p.group !== 'indoor');
      const opts = (cur) => libs.map(p => `<option value="${escHtml(p.id)}"${p.id === cur ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`).join('') + (PhotoLib.get(cur) ? '' : '<option value="" selected>(none)</option>');
      let body = '<p class="sf-note">This field has no masts yet — use “Add masts…” in its panel.</p>';
      if (m) {
        const M = { x: +m.x || 0, y: +m.y || 0 }, h = Math.max(+m.h || 20, 0.5);
        const rows = (m.floods || []).map((fl, i) => {
          const d = Math.hypot((+fl.ax || 0) - M.x, (+fl.ay || 0) - M.y);
          const tilt = Math.atan2(d, h) * 180 / Math.PI, dir = ((Math.atan2((+fl.ay || 0) - M.y, (+fl.ax || 0) - M.x) * 180 / Math.PI) + 360) % 360;
          const over = tilt > L.maxTilt + 1e-9;
          return `<tr data-sf-fl="${escHtml(fl.id)}"${over ? ' class="sf-over"' : ''}><td>F${i + 1}</td>
            <td><input type="number" data-fl="ax" value="${+fl.ax || 0}" step="0.5" aria-label="F${i + 1} aim x"></td>
            <td><input type="number" data-fl="ay" value="${+fl.ay || 0}" step="0.5" aria-label="F${i + 1} aim y"></td>
            <td><select data-fl="photoId" aria-label="F${i + 1} luminaire">${opts(fl.photoId)}</select></td>
            <td><input type="number" data-fl="fluxPct" value="${this._pct(fl.fluxPct)}" min="0" max="100" step="5" aria-label="F${i + 1} output %"></td>
            <td class="num">${Math.hypot(d, h).toFixed(1)}</td><td class="num"><b>${tilt.toFixed(1)}</b></td><td class="num">${dir.toFixed(0)}</td>
            <td><button type="button" class="btn-small" data-sf-flrm aria-label="Remove F${i + 1}">×</button></td></tr>`;
        }).join('');
        body = `<div class="sf-grid4">
            <label class="plan-field"><span>Name</span><input type="text" data-m="name" value="${escHtml(m.name || '')}"></label>
            <label class="plan-field"><span>x along (m)</span><input type="number" data-m="x" value="${+m.x || 0}" step="0.5"></label>
            <label class="plan-field"><span>y across (m)</span><input type="number" data-m="y" value="${+m.y || 0}" step="0.5"></label>
            <label class="plan-field"><span>Height (m)</span><input type="number" data-m="h" value="${h}" step="0.5" min="1"></label></div>
          ${this._sectionSvg(m, fr, L)}
          <div class="sf-tablewrap"><table class="sf-table"><thead><tr><th>Flood</th><th>Aim x (m)</th><th>Aim y (m)</th><th>Luminaire</th><th>Output %</th><th class="num">Throw (m)</th><th class="num">Tilt (°)</th><th class="num">Direction (°)</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="9" class="sf-note">No floods on this mast.</td></tr>'}</tbody></table></div>
          <div class="sf-note">Aim points in field metres: x along the length from the first corner, y across. Tilt from straight down (limit ${L.maxTilt}°, rows over it are marked); direction measured from the length axis.</div>`;
      }
      ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:920px">
        <div class="modal-header"><h3 id="sf-aim-title">Aiming — ${escHtml(room.name || 'Field')}${fr ? ` <small>${fr.L.toFixed(1)} × ${fr.W.toFixed(1)} m</small>` : ''}</h3></div>
        <div class="modal-body">
          <div class="sf-toolbar">
            <label class="plan-field" style="margin:0"><span>Mast</span><select data-sf-pick>${L.masts.map(x => `<option value="${escHtml(x.id)}"${m && x.id === m.id ? ' selected' : ''}>${escHtml(x.name || x.id)} — ${(x.floods || []).length} floods</option>`).join('')}</select></label>
            <button type="button" class="btn-small" data-a="flood-add"${m ? '' : ' disabled'}>+ Flood</button>
            <button type="button" class="btn-small" data-a="mirror"${m ? '' : ' disabled'} title="Copy this mast's aiming to the mast opposite, mirrored about the centre line">Mirror to opposite mast</button>
            <button type="button" class="btn-small" data-a="mast-add">+ Mast</button>
            <button type="button" class="btn-small" data-a="mast-rm"${m ? '' : ' disabled'}>Remove mast</button>
            <span style="flex:1"></span>
            <button type="button" class="btn-small" data-a="optimise">Optimise aiming (all masts)</button>
          </div>
          ${body}
          <div class="ui-dialog-actions"><button class="btn-primary" data-a="done">Done — calculate</button></div>
        </div></div>`;
    };
    render();
    const changed = () => { PlanMarkup.markDirty(); PlanEngine.requestDraw({ fg: true }); this._show3D(); };
    const close = (calc) => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      this._aim = null;
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ all: true });
      if (calc) this.run([room]);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('change', (e) => {
      const t = e.target, m = mast();
      if (t.matches('[data-sf-pick]')) { this._aim.mastId = t.value; render(); PlanEngine.requestDraw({ fg: true }); return; }
      if (!m) return;
      if (t.dataset.m) { m[t.dataset.m] = t.dataset.m === 'name' ? t.value : (parseFloat(t.value) || 0); if (t.dataset.m === 'h') m.h = Math.max(1, m.h); }
      else if (t.dataset.fl) {
        const fl = (m.floods || []).find(x => x.id === t.closest('[data-sf-fl]').dataset.sfFl);
        if (!fl) return;
        fl[t.dataset.fl] = t.dataset.fl === 'photoId' ? t.value : Math.max(t.dataset.fl === 'fluxPct' ? 0 : -1e6, Math.min(t.dataset.fl === 'fluxPct' ? 100 : 1e6, parseFloat(t.value) || 0));
      }
      render(); changed();
    });
    ov.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]'), m = mast();
      if (e.target.closest('[data-sf-flrm]') && m) {
        const id = e.target.closest('[data-sf-fl]').dataset.sfFl;
        m.floods = (m.floods || []).filter(x => x.id !== id);
        render(); changed(); return;
      }
      if (!b) return;
      const a = b.dataset.a, fr = this.frame(room, PlanEngine.factor()), L = this._L(room);
      if (a === 'done') { close(true); return; }
      if (a === 'flood-add' && m) {
        const last = (m.floods || [])[(m.floods || []).length - 1];
        (m.floods = m.floods || []).push({ id: this._seq(room, 'f'), ax: +(fr.L / 2).toFixed(1), ay: +(fr.W / 2).toFixed(1), photoId: last ? last.photoId : ((PhotoLib.list().find(p => p.group !== 'indoor') || {}).id || ''), fluxPct: 100 });
      } else if (a === 'mirror' && m) {
        const tx = +m.x || 0, ty = fr.W - (+m.y || 0);
        const opp = this.read(room).masts.filter(x => x !== m).sort((p, q) => Math.hypot(p.x - tx, p.y - ty) - Math.hypot(q.x - tx, q.y - ty))[0];
        if (!opp || Math.hypot(opp.x - tx, opp.y - ty) > Math.max(3, fr.W * 0.1)) { UI.toast('No mast opposite this one (mirrored about the centre line).', 'info'); return; }
        opp.floods = (m.floods || []).map(fl => ({ id: this._seq(room, 'f'), ax: fl.ax, ay: +(fr.W - (+fl.ay || 0)).toFixed(2), photoId: fl.photoId, fluxPct: fl.fluxPct }));
        UI.toast(`${opp.name || 'The opposite mast'} now has ${opp.floods.length} floods mirrored from ${m.name || 'this mast'}.`, 'success');
      } else if (a === 'mast-add') {
        const nm = 'M' + (this.read(room).masts.length + 1), s = 5;
        L.masts = this.read(room).masts.concat([{ id: this._seq(room, 'm'), name: nm, x: +(fr.L / 2).toFixed(1), y: -s, h: m ? +m.h : 20, floods: [] }]);
        this._aim.mastId = L.masts[L.masts.length - 1].id;
      } else if (a === 'mast-rm' && m) {
        if (!(await UI.confirm(`Remove ${m.name || 'this mast'} and its ${(m.floods || []).length} floods?`, { okText: 'Remove', cancelText: 'Cancel' }))) return;
        L.masts = this.read(room).masts.filter(x => x !== m);
        this._aim.mastId = (L.masts[0] || {}).id;
      } else if (a === 'optimise') {
        await this.optimise(room);
      }
      render(); changed();
    });
    document.body.appendChild(ov);
    PlanEngine.requestDraw({ fg: true });
  },

  // Section through the mast along each beam: height against distance from the mast.
  _sectionSvg(m, fr, L) {
    const h = Math.max(+m.h || 20, 0.5), M = { x: +m.x || 0, y: +m.y || 0 };
    const ds = (m.floods || []).map(fl => Math.hypot((+fl.ax || 0) - M.x, (+fl.ay || 0) - M.y));
    const reach = h * Math.tan(L.maxTilt * Math.PI / 180);
    const span = Math.max(10, ...ds, Math.min(reach, Math.hypot(fr.L, fr.W) + 10)) * 1.05;
    const W = 720, H = 200, pl = 40, pb = 26, pt = 14;
    const sx = (W - pl - 16) / span;
    const X = (d) => pl + d * sx, Y = (z) => H - pb - z * (H - pb - pt) / h;
    const beams = ds.map((d) => `<line x1="${X(0)}" y1="${Y(h)}" x2="${X(d).toFixed(1)}" y2="${Y(0)}" class="sf-sec-beam"></line><circle cx="${X(d).toFixed(1)}" cy="${Y(0)}" r="3" class="sf-sec-aim"></circle>`).join('');
    const lim = reach < span ? `<line x1="${X(reach).toFixed(1)}" y1="${Y(0) - 6}" x2="${X(reach).toFixed(1)}" y2="${Y(0) + 6}" class="sf-sec-lim"></line><text x="${X(reach).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="sf-sec-txt">${L.maxTilt}° limit</text>` : '';
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => `<text x="${X(t * span).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="sf-sec-txt">${(t * span).toFixed(0)} m</text>`).join('');
    return `<svg class="sf-section" viewBox="0 0 ${W} ${H}" role="img" aria-label="Section: mast ${escHtml(m.name || '')}, ${h} m high, beams reaching ${ds.map(d => d.toFixed(0)).join(', ')} m">
      <line x1="${pl - 10}" y1="${Y(0)}" x2="${W - 6}" y2="${Y(0)}" class="sf-sec-ground"></line>
      <line x1="${X(0)}" y1="${Y(0)}" x2="${X(0)}" y2="${Y(h)}" class="sf-sec-mast"></line>
      <text x="${X(0) + 6}" y="${Y(h) + 4}" class="sf-sec-txt">${escHtml(m.name || '')} ${h} m</text>
      ${beams}${lim}${ticks}</svg>`;
  },

  // ─── Results dialog ───
  _resultsRoom: null,
  _resultsEl: null,
  openResults(room) {
    if (!RoomCalc.results[room.id]) { UI.toast('Calculate the field first.', 'info'); return; }
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'sf-res-title');
    this._resultsRoom = room.id; this._resultsEl = ov;
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); this._resultsRoom = null; this._resultsEl = null; };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.closest('[data-r="close"]')) close();
      else if (e.target.closest('[data-r="calc"]')) this.run([room]);
      else if (e.target.closest('[data-r="values"]')) { this._showValues = !this._showValues; this._renderResults(); }
    });
    document.body.appendChild(ov);
    this._renderResults();
  },
  _showValues: true,
  _renderResults() {
    const ov = this._resultsEl, room = (AppState.planMarkup.rooms || []).find(r => r.id === this._resultsRoom);
    if (!ov || !room) return;
    const r = RoomCalc.results[room.id];
    if (!r) return;
    const res = r.res, hz = res.horizontal, L = this.read(room), cur = r.sig === this.signature(room);
    const fmt = (v, d) => v == null ? '—' : Number(v).toFixed(d);
    const verdict = res.pass === true ? '<span class="sf-pill ok">Passes</span>' : res.pass === false ? '<span class="sf-pill bad">Fails</span>' : '<span class="sf-pill">No verdict</span>';
    const checks = (res.checks || []).map(c => `<tr><td>${escHtml(c.label)}</td><td class="num">${c.op === '>=' ? '≥' : '≤'} ${c.req}${c.unit && c.unit !== '' ? ' ' + c.unit : ''}</td>
      <td class="num"><b>${c.unit === 'lx' ? c.value.toFixed(0) : c.unit === '°' ? c.value.toFixed(1) : c.value.toFixed(2)}</b></td><td class="${c.pass ? 'ok' : c.pass === false ? 'bad' : ''}">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`).join('');
    const obs = res.gr ? res.gr.observers.map((o, i) => `<tr><td>${i + 1}</td><td class="num">${o.x.toFixed(1)}, ${o.y.toFixed(1)}</td><td class="num"><b>${o.gr == null ? '—' : o.gr.toFixed(1)}</b></td><td class="num">${o.dir == null ? '—' : o.dir.toFixed(0) + '°'}</td></tr>`).join('') : '';
    const vrow = (name, s) => `<tr><td>${escHtml(name)}</td><td class="num">${fmt(s.Eav, 0)}</td><td class="num">${fmt(s.Emin, 0)}</td><td class="num">${fmt(s.U1, 2)}</td><td class="num">${fmt(s.U2, 2)}</td></tr>`;
    const cams = (res.cameras || []).map(c => vrow(c.name, c)).join('');
    const players = ((res.players && res.players.directions) || []).map(p => vrow(p.label.replace('x = L', 'far end').replace('x = 0', 'near end').replace('y = W', 'far side').replace('y = 0', 'near side'), p)).join('');
    ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:1100px">
      <div class="modal-header"><h3 id="sf-res-title">${escHtml(room.name || 'Field')} — ${escHtml(SPORTS_FIELDS[L.sport].name)}, Class ${L.cls} ${verdict}</h3></div>
      <div class="modal-body">
        ${cur ? '' : '<div class="sf-stale">Out of date — the field, its masts or the luminaires changed since this was calculated. <button class="btn-small" data-r="calc">Recalculate</button></div>'}
        <div class="sf-res">
          <div class="sf-res-plot">
            <div class="sf-toolbar"><b>Ēh on the pitch (lx)</b><span style="flex:1"></span><button class="btn-small" data-r="values" aria-pressed="${escHtml(this._showValues)}">${this._showValues ? 'Hide' : 'Show'} values</button></div>
            <div class="sf-canvas-wrap"></div>
            <div class="sf-legend"><span>0</span><span class="sf-legend-bar" aria-hidden="true"></span><span>${Math.round(hz.Emax)} lx</span><small>Grid ${hz.nx} × ${hz.ny} (${hz.dx.toFixed(2)} × ${hz.dy.toFixed(2)} m). Circles: masts; numbered diamonds: glare observers.</small></div>
          </div>
          <div class="sf-res-side">
            <table class="sf-table"><thead><tr><th>Criterion</th><th class="num">Required</th><th class="num">Result</th><th></th></tr></thead><tbody>${checks}
              <tr><td>Ēh / Emin / Emax</td><td></td><td class="num" colspan="2">${hz.Eav.toFixed(0)} / ${hz.Emin.toFixed(0)} / ${hz.Emax.toFixed(0)} lx</td></tr>
              <tr><td>U₁ / U₂</td><td></td><td class="num" colspan="2">${hz.U1.toFixed(2)} / ${hz.U2.toFixed(2)}</td></tr>
              <tr><td>Ra</td><td class="num">≥ ${L.ra}</td><td class="num" colspan="2">luminaire data sheet</td></tr></tbody></table>
            <table class="sf-table"><thead><tr><th colspan="2">Installation</th></tr></thead><tbody>
              <tr><td>Masts</td><td>${L.masts.length} (${[...new Set(L.masts.map(m => +m.h))].join(' / ')} m)</td></tr>
              <tr><td>Floodlights</td><td>${res.power.count}</td></tr>
              <tr><td>Connected load</td><td>${(res.power.watts / 1000).toFixed(1)} kW · ${res.power.wm2.toFixed(1)} W/m²</td></tr>
              <tr><td>Steepest tilt</td><td>${fmt(res.aiming.maxTilt, 1)}° (limit ${L.maxTilt}°)</td></tr>
              <tr><td>Maintenance factor</td><td>${L.mf}</td></tr></tbody></table>
          </div>
        </div>
        <div class="sf-res">
          <div class="sf-res-side"><h4>Glare rating GR (CIE 112)</h4>
            ${res.gr ? `<table class="sf-table"><thead><tr><th>Obs.</th><th class="num">x, y (m)</th><th class="num">GR max</th><th class="num">Looking</th></tr></thead><tbody>${obs}</tbody></table>
            <div class="sf-note">${escHtml(res.gr.note)}. Direction from the length axis.</div>` : '<div class="sf-note">No GR — no light on the pitch.</div>'}</div>
          <div class="sf-res-side"><h4>Vertical illuminance at ${res.players ? res.players.height : L.evHeight} m</h4>
            <table class="sf-table"><thead><tr><th>Plane facing</th><th class="num">Ēv</th><th class="num">Emin</th><th class="num">U₁</th><th class="num">U₂</th></tr></thead>
              <tbody>${cams}${players}</tbody></table>
            <div class="sf-note">${L.tv ? 'Cameras: planes turned towards each camera.' : 'Not televised — tick Televised in the field\'s panel to add cameras.'} Players: planes facing each end and side.</div></div>
        </div>
        ${(res.stands || []).length || res.aerial ? `<div class="sf-res">
          ${(res.stands || []).length ? `<div class="sf-res-side"><h4>Stands</h4>
            <table class="sf-table"><thead><tr><th>Stand</th><th class="num">Seats Ēh</th><th class="num">Emin</th><th class="num">Faces Ēv</th><th class="num">GR max</th></tr></thead>
            <tbody>${res.stands.map(st => st.error ? `<tr><td>${escHtml(st.name)}</td><td colspan="4">${escHtml(st.error)}</td></tr>`
              : `<tr><td>${escHtml(st.name)} <small>${st.length} × ${st.depth} m</small></td><td class="num">${fmt(st.seats.Eav, 0)}</td><td class="num">${fmt(st.seats.Emin, 0)}</td><td class="num">${fmt(st.faces.Eav, 0)}</td><td class="num">${st.gr ? fmt(st.gr.max, 1) : '—'}</td></tr>`).join('')}</tbody></table>
            <div class="sf-note">Seats: horizontal on the rows. Faces: vertical at eye height, turned to the pitch centre. GR: spectators looking at the pitch centre and 30° either side.</div></div>` : ''}
          ${res.aerial ? `<div class="sf-res-side"><h4>Aerial zone</h4>
            <table class="sf-table"><thead><tr><th class="num">Height</th><th class="num">Ēh</th><th class="num">Ēv (4 planes)</th><th class="num">Ev min</th><th class="num">U₂</th><th class="num">Weakest plane Ē</th></tr></thead>
            <tbody>${res.aerial.layers.map(l => `<tr><td class="num">${l.height} m${l.aboveMasts ? ' <small>(above the masts)</small>' : ''}</td><td class="num">${fmt(l.Ehavg, 0)}</td><td class="num"><b>${fmt(l.Evavg, 0)}</b></td><td class="num">${fmt(l.Evmin, 0)}</td><td class="num">${fmt(l.U2, 2)}</td><td class="num">${fmt(l.dirMin, 0)}</td></tr>`).join('')}</tbody></table>
            <div class="sf-note">${escHtml(res.aerial.note)}.</div></div>` : ''}
        </div>` : ''}
        ${(res.warnings || []).concat(res.notes || []).map(w => `<div class="sf-note" style="color:#8a5a00">${escHtml(w)}</div>`).join('')}
        <div class="ui-dialog-actions"><button class="btn-primary" data-r="close">Close</button></div>
      </div></div>`;
    const cv = this.fieldCanvas(room, res, { values: this._showValues, width: 720 });
    if (cv) { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', `Horizontal illuminance on ${room.name || 'the field'}: average ${Math.round(hz.Eav)} lx, minimum ${Math.round(hz.Emin)} lx`); ov.querySelector('.sf-canvas-wrap').appendChild(cv); }
  },

  // The field in its own frame (x right along the length, y up): false-colour
  // grid, markings, masts, aim lines, observers. Also the PDF's plot.
  fieldCanvas(room, res, o) {
    const fr = this.frame(room, o.f || PlanEngine.factor());
    if (!fr || !res || !res.horizontal) return null;
    const L = this.read(room), hz = res.horizontal;
    const stands = L.stands.map(st => this.standCorners(st, fr));
    const pts = [[0, 0], [fr.L, fr.W]].concat(L.masts.map(m => [+m.x || 0, +m.y || 0]), ...stands);
    const x0 = Math.min(...pts.map(p => p[0])) - 4, x1 = Math.max(...pts.map(p => p[0])) + 4;
    const y0 = Math.min(...pts.map(p => p[1])) - 4, y1 = Math.max(...pts.map(p => p[1])) + 4;
    const dpr = o.dpr || Math.min(window.devicePixelRatio || 1, 2);
    const Wc = o.width || 720, s = Wc / (x1 - x0), Hc = Math.ceil((y1 - y0) * s);
    const cv = document.createElement('canvas');
    cv.width = Math.round(Wc * dpr); cv.height = Math.round(Hc * dpr);
    cv.style.width = '100%'; cv.style.maxWidth = Wc + 'px'; cv.style.height = 'auto';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const X = (x) => (x - x0) * s, Y = (y) => (y1 - y) * s;
    ctx.fillStyle = '#eef2ee'; ctx.fillRect(0, 0, Wc, Hc);
    const top = Math.max(hz.Emax, 1);
    for (let j = 0; j < hz.ny; j++) for (let i = 0; i < hz.nx; i++) {
      const v = hz.values[j * hz.nx + i];
      ctx.fillStyle = RoomCalc._color(v / top);
      ctx.fillRect(X(i * hz.dx), Y((j + 1) * hz.dy), hz.dx * s + 0.6, hz.dy * s + 0.6);
    }
    // markings
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2;
    ctx.strokeRect(X(0), Y(fr.W), fr.L * s, fr.W * s);
    const lines = SPORTS_FIELDS[L.sport].lines;
    ctx.beginPath();
    if (lines === 'football' || lines === 'halfway') { ctx.moveTo(X(fr.L / 2), Y(0)); ctx.lineTo(X(fr.L / 2), Y(fr.W)); }
    if (lines === 'thirds') { for (const t of [1 / 3, 2 / 3]) { ctx.moveTo(X(fr.L * t), Y(0)); ctx.lineTo(X(fr.L * t), Y(fr.W)); } }
    ctx.stroke();
    if (lines === 'football') {
      ctx.beginPath(); ctx.arc(X(fr.L / 2), Y(fr.W / 2), 9.15 * s, 0, Math.PI * 2); ctx.stroke();
      const pw = Math.min(40.32, fr.W * 0.6), pd = Math.min(16.5, fr.L * 0.16);
      ctx.strokeRect(X(0), Y(fr.W / 2 + pw / 2), pd * s, pw * s);
      ctx.strokeRect(X(fr.L - pd), Y(fr.W / 2 + pw / 2), pd * s, pw * s);
    }
    // stands
    for (const C of stands) {
      ctx.fillStyle = 'rgba(100,116,139,0.28)'; ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.5;
      ctx.beginPath(); C.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X(C[0][0]), Y(C[0][1])); ctx.lineTo(X(C[1][0]), Y(C[1][1])); ctx.stroke();
    }
    // values
    if (o.values && hz.dx * s >= 24 && hz.dy * s >= 13) {
      ctx.font = `${Math.min(11, hz.dy * s * 0.45).toFixed(0)}px ui-monospace, Consolas, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let j = 0; j < hz.ny; j++) for (let i = 0; i < hz.nx; i++) {
        const v = hz.values[j * hz.nx + i], t = v / top;
        ctx.fillStyle = t > 0.25 && t < 0.75 ? '#111' : '#fff';
        ctx.fillText(String(Math.round(v)), X((i + 0.5) * hz.dx), Y((j + 0.5) * hz.dy));
      }
    }
    // aim lines for the selected mast (dialog) — and the masts
    ctx.lineWidth = 1;
    for (const m of L.masts) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(+m.x || 0), Y(+m.y || 0), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#111827'; ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = (+m.y || 0) < fr.W / 2 ? 'top' : 'bottom';
      ctx.fillText(m.name || '', X(+m.x || 0), Y(+m.y || 0) + ((+m.y || 0) < fr.W / 2 ? 9 : -9));
    }
    if (res.gr) {
      ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textBaseline = 'middle';
      res.gr.observers.forEach((ob, i) => {
        const x = X(ob.x), y = Y(ob.y);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#111827'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 0.5);
      });
    }
    return cv;
  },
  plotPng(room, res, f) {
    try {
      const cv = this.fieldCanvas(room, res, { values: true, width: 1100, dpr: 1, f });
      return cv ? { png: cv.toDataURL('image/png'), w: cv.width, h: cv.height } : null;
    } catch (_) { return null; }
  },

  // ─── On the plan (Lighting tab) ───
  draw(ctx, zoom, withResults) {
    const f = PlanEngine.factor();
    if (!f) return;
    for (const room of (AppState.planMarkup.rooms || [])) {
      if (room.kind !== 'sports') continue;
      const fr = this.frame(room, f);
      if (!fr) continue;
      const L = this.read(room), r = RoomCalc.results[room.id];
      const P = (x, y) => this.toPlan(fr, x, y);
      if (withResults && r && r.res.horizontal) {
        const hz = r.res.horizontal, top = Math.max(hz.Emax, 1);
        ctx.save();
        ctx.globalAlpha = r.sig === this.signature(room) ? 0.55 : 0.22;
        for (let j = 0; j < hz.ny; j++) for (let i = 0; i < hz.nx; i++) {
          const v = hz.values[j * hz.nx + i];
          const a = P(i * hz.dx, j * hz.dy), b = P((i + 1) * hz.dx, j * hz.dy), c = P((i + 1) * hz.dx, (j + 1) * hz.dy), d = P(i * hz.dx, (j + 1) * hz.dy);
          ctx.fillStyle = RoomCalc._color(v / top);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;
        // the values, once a cell is big enough on screen to read them
        if (hz.dy / f * zoom >= 16 && hz.dx / f * zoom >= 26) {
          ctx.fillStyle = '#111827'; ctx.font = `${11 / zoom}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          for (let j = 0; j < hz.ny; j++) for (let i = 0; i < hz.nx; i++) {
            const q = P((i + 0.5) * hz.dx, (j + 0.5) * hz.dy);
            ctx.fillText(String(Math.round(hz.values[j * hz.nx + i])), q.x, q.y);
          }
        }
        ctx.restore();
      }
      const sel = (typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds && PlanMarkup.selectedIds.has(room.id)) || (this._aim && this._aim.roomId === room.id);
      ctx.save();
      const rad = Math.max(0.9 / f, 5 / zoom);
      for (const m of L.masts) {
        const M = P(+m.x || 0, +m.y || 0);
        const focus = this._aim && this._aim.roomId === room.id ? this._aim.mastId === m.id : sel;
        if (focus) {
          ctx.strokeStyle = 'rgba(232,89,12,0.85)'; ctx.lineWidth = 1.2 / zoom; ctx.setLineDash([5 / zoom, 4 / zoom]);
          ctx.beginPath();
          for (const fl of (m.floods || [])) { const A = P(+fl.ax || 0, +fl.ay || 0); ctx.moveTo(M.x, M.y); ctx.lineTo(A.x, A.y); }
          ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#e8590c';
          for (const fl of (m.floods || [])) { const A = P(+fl.ax || 0, +fl.ay || 0); ctx.beginPath(); ctx.arc(A.x, A.y, rad * 0.45, 0, Math.PI * 2); ctx.fill(); }
        }
        ctx.fillStyle = this._aim && this._aim.mastId === m.id ? '#e8590c' : '#ffffff'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 2 / zoom;
        ctx.beginPath(); ctx.arc(M.x, M.y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#111827'; ctx.font = `bold ${11 / zoom}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${m.name || ''}`, M.x + rad * 1.4, M.y);
      }
      for (const st of L.stands) {
        const C = this.standCorners(st, fr).map(([x, y]) => P(x, y));
        ctx.fillStyle = 'rgba(100,116,139,0.22)'; ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.5 / zoom;
        ctx.beginPath(); C.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.lineWidth = 3 / zoom; ctx.beginPath(); ctx.moveTo(C[0].x, C[0].y); ctx.lineTo(C[1].x, C[1].y); ctx.stroke();
        const c = { x: (C[0].x + C[2].x) / 2, y: (C[0].y + C[2].y) / 2 };
        ctx.fillStyle = '#334155'; ctx.font = `${11 / zoom}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.name || 'Stand', c.x, c.y);
      }
      if (L.tv) {
        ctx.fillStyle = '#1d4ed8';
        for (const c of L.cameras) {
          const q = P(+c.x || 0, +c.y || 0), k = rad * 0.9;
          ctx.fillRect(q.x - k, q.y - k * 0.7, k * 2, k * 1.4);
          ctx.font = `${10 / zoom}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText(c.name || 'Camera', q.x + k * 1.6, q.y);
        }
      }
      ctx.restore();
    }
  },
};

// Lighting tab › Sports field: click the centre spot, then set the field up.
if (typeof PlanTools !== 'undefined') {
  PlanTools.register({
    id: 'sportsfield', cursor: 'crosshair', _hover: null,
    onActivate() { this._hover = null; },
    cancel() { this._hover = null; },
    onMove(pt) { this._hover = PlanTools.snap(pt); PlanEngine.requestDraw({ fg: true }); },
    onDown(pt) {
      const s = PlanTools.snap(pt);
      PlanTools.set('select');
      SportsCalc.setup({ centre: { x: s.x, y: s.y } });
    },
    onKey(e) { if (e.key === 'Escape') { PlanTools.set('select'); return true; } return false; },
    drawOverlay(ctx, zoom) { if (this._hover) PlanTools._drawSnapRing(ctx, this._hover.x, this._hover.y, this._hover.snapped, zoom); },
  });
}
