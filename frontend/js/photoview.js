/* ProtectionPro — pictures of one luminaire's photometry.
 *
 * Everything here reads one Type C web (a PhotoLib / road library entry:
 * { c:[C planes], g:[γ from nadir], cd:[c][g] in candela, lumens }) and
 * returns numbers or an SVG string — no state, no DOM:
 *   - the polar curve in the C0–C180 and C90–C270 planes (cd/klm), with the
 *     beam (50 % of peak) and field (10 %) angles,
 *   - the floor isolux of one fitting at a mounting height,
 *   - the cone diagram of a rotationally symmetric downlight,
 *   - the top view of the photometric solid in any mounting frame (the plan
 *     draws it at each fitting) and the curve in any vertical plane (the
 *     room section draws it at each fitting it cuts).
 * The intensity lookup is the engine's (road_lighting._Web.intensity):
 * bilinear in C and γ, 0 beyond the last γ.
 */

const PhotoView = {
  D: Math.PI / 180,

  // I(C, γ) in cd. A web without a full circle of C planes is symmetric about C0.
  cd(p, C, g) {
    const cA = p.c, gA = p.g, n = cA.length, m = gA.length;
    if (!n || !m || g > gA[m - 1] + 1e-9 || g < gA[0] - 1e-9) return 0;
    let Cm = ((C % 360) + 360) % 360;
    if (cA[n - 1] < 360 - 1e-6 && Cm > cA[n - 1]) Cm = Math.min(360 - Cm, cA[n - 1]);
    let j = 0;
    while (j < n - 2 && cA[j + 1] <= Cm) j++;
    const j2 = Math.min(j + 1, n - 1);
    const tc = j2 > j && cA[j2] > cA[j] ? Math.min(1, Math.max(0, (Cm - cA[j]) / (cA[j2] - cA[j]))) : 0;
    let i = 0;
    while (i < m - 2 && gA[i + 1] <= g) i++;
    const i2 = Math.min(i + 1, m - 1);
    const tg = i2 > i && gA[i2] > gA[i] ? Math.min(1, Math.max(0, (g - gA[i]) / (gA[i2] - gA[i]))) : 0;
    const at = (k) => p.cd[k][i] * (1 - tg) + p.cd[k][i2] * tg;
    return at(j) * (1 - tc) + at(j2) * tc;
  },
  cdklm(p, C, g) { return this.cd(p, C, g) * 1000 / (Number(p.lumens) || 1); },

  // The web sampled every 5° in C and 2° in γ (cached until its candela table changes).
  _tabs: new WeakMap(),
  table(p) {
    let t = this._tabs.get(p);
    if (t && t.cd === p.cd) return t;
    t = { cd: p.cd, I: [], max: 0 };
    for (let k = 0; k < 72; k++) {
      const row = [];
      for (let q = 0; q <= 90; q++) { const v = this.cd(p, k * 5, q * 2); row.push(v); if (v > t.max) t.max = v; }
      t.I.push(row);
    }
    // share of the flux below the horizontal
    let dn = 0, all = 0;
    for (let k = 0; k < 72; k++) for (let q = 0; q < 90; q++) {
      const w = (t.I[k][q] + t.I[k][q + 1]) / 2 * Math.sin((q * 2 + 1) * this.D);
      all += w; if (q < 45) dn += w;
    }
    t.down = all > 0 ? dn / all : 1;
    this._tabs.set(p, t);
    return t;
  },

  // ─── Angles ───
  // Intensity round the vertical plane C = cp (θ ≥ 0) / cn (θ < 0), θ from nadir in −180…180.
  _planeFn(p, cp, cn) { return (th) => (th >= 0 ? this.cd(p, cp, th) : this.cd(p, cn, -th)); },

  // The beam in one plane pair: edges a…b (θ, may run past ±180 for an uplight) where
  // I ≥ frac × that plane's peak, around the peak.
  beam(p, cp, cn, frac) {
    const I = this._planeFn(p, cp, cn), N = 720, v = [];
    let pk = 0, mx = 0;
    for (let k = 0; k < N; k++) { const x = I(-180 + k * 0.5); v.push(x); if (x > mx + 1e-9) { mx = x; pk = k; } }
    if (!(mx > 0)) return null;
    const lim = frac * mx;
    let a = 0, b = 0;
    while (a < N / 2 && v[(pk - a - 1 + N) % N] >= lim) a++;
    while (b < N / 2 && v[(pk + b + 1) % N] >= lim) b++;
    const peak = -180 + pk * 0.5;
    return { a: peak - a * 0.5, b: peak + b * 0.5, angle: (a + b) * 0.5, peak };
  },

  // Same distribution in every C plane (within 5 % of the peak), and pointing down.
  symmetric(p) {
    const t = this.table(p);
    if (!(t.max > 0)) return false;
    for (let q = 0; q <= 45; q++) {
      const ref = t.I[0][q];
      for (let k = 0; k < 72; k += 3) if (Math.abs(t.I[k][q] - ref) > 0.05 * t.max) return false;
    }
    return t.down > 0.6;
  },

  // ─── Polar curve ───
  _nice(x) {
    if (!(x > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(x))), m = x / e;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
  },
  _f(v) { return (+v).toFixed(1); },

  // The polar diagram (cd/klm): C0–C180 solid, C90–C270 dashed, beam and field angles in
  // C0–C180. Only the lower half is drawn when the fitting sends no light upwards.
  // o: { R (px), fixed (draw at R px instead of filling the width), beams }
  // A small C0–C180 / C90–C270 outline for a list, no scale or labels.
  thumbSvg(p, size = 36) {
    const k = Number(p.lumens) > 0 ? 1000 / p.lumens : 1;
    let mx = 0;
    for (const C of [0, 90, 180, 270]) for (let g = 0; g <= 180; g += 5) mx = Math.max(mx, this.cd(p, C, g) * k);
    if (!(mx > 0)) return `<svg width="${size}" height="${size}" aria-hidden="true"></svg>`;
    const r = size / 2 - 2, cx = size / 2, cy = size / 2;
    const outlineHtml = (Ca, Cb) => {
      const pts = [];
      for (let g = 180; g >= 0; g -= 5) pts.push([-Math.sin(g * Math.PI / 180), Math.cos(g * Math.PI / 180), this.cd(p, Cb, g) * k]);
      for (let g = 5; g <= 180; g += 5) pts.push([Math.sin(g * Math.PI / 180), Math.cos(g * Math.PI / 180), this.cd(p, Ca, g) * k]);
      return pts.map(([sx, cy0, v], i) => `${i ? 'L' : 'M'}${(cx + sx * v / mx * r).toFixed(1)} ${(cy + cy0 * v / mx * r).toFixed(1)}`).join('') + 'Z';
    };
    return `<svg class="pv-thumb" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.2"/>
      <path d="${outlineHtml(90, 270)}" fill="none" stroke="#c2410c" stroke-width="1" stroke-dasharray="2 2"/>
      <path d="${outlineHtml(0, 180)}" fill="rgba(0,120,215,0.14)" stroke="#0078d7" stroke-width="1.3"/></svg>`;
  },

  polarSvg(p, o = {}) {
    const R = o.R || 150, D = this.D, f = this._f;
    const k1 = 1000 / (Number(p.lumens) || 1);
    let mx = 0, upMx = 0;
    for (const C of [0, 90, 180, 270]) for (let g = 0; g <= 180; g += 1) {
      const v = this.cd(p, C, g) * k1;
      if (v > mx) mx = v;
      if (g > 92 && v > upMx) upMx = v;
    }
    if (!(mx > 0)) return '<p class="pv-none">This luminaire has no intensity data.</p>';
    const up = upMx > 0.02 * mx;
    const step = this._nice(mx / 4), top = Math.ceil(mx / step - 1e-9) * step, s = R / top;
    const W = 2 * R + 64, cx = W / 2, cy = up ? R + 30 : 30, H = up ? 2 * R + 60 : R + 58;
    const gMax = up ? 180 : 90;
    const curveHtml = (cp, cn) => {
      const pts = [];
      for (let g = gMax; g >= 0; g -= 1) pts.push([-g, this.cd(p, cn, g) * k1]);
      for (let g = 1; g <= gMax; g += 1) pts.push([g, this.cd(p, cp, g) * k1]);
      return pts.map(([th, v], i) => { const r = v * s; return `${i ? 'L' : 'M'}${f(cx + r * Math.sin(th * D))} ${f(cy + r * Math.cos(th * D))}`; }).join('') + (up ? 'Z' : '');
    };
    let grid = '';
    for (let v = step; v <= top + 1e-9; v += step) {
      const r = v * s;
      grid += up ? `<circle class="pv-ring" cx="${cx}" cy="${cy}" r="${f(r)}"/>` : `<path class="pv-ring" d="M${f(cx - r)} ${cy}A${f(r)} ${f(r)} 0 0 0 ${f(cx + r)} ${cy}"/>`;
      grid += `<text class="pv-txt" x="${cx + 4}" y="${f(cy + r - 3)}">${Math.round(v)}</text>`;
    }
    for (let a = -gMax; a <= gMax; a += 30) {
      const x = cx + R * Math.sin(a * D), y = cy + R * Math.cos(a * D);
      grid += `<line class="pv-spoke" x1="${cx}" y1="${cy}" x2="${f(x)}" y2="${f(y)}"/>`;
      if (Math.abs(a) !== 180 || a === 180) grid += `<text class="pv-txt" text-anchor="middle" x="${f(cx + (R + 16) * Math.sin(a * D))}" y="${f(cy + (R + 16) * Math.cos(a * D) + 4)}">${Math.abs(a)}°</text>`;
    }
    if (!up) grid += `<line class="pv-spoke" x1="${cx - R}" y1="${cy}" x2="${cx + R}" y2="${cy}"/>`;
    let rays = '';
    if (o.beams !== false) {
      const ray = (th, cls) => `<line class="${escHtml(cls)}" x1="${cx}" y1="${cy}" x2="${f(cx + R * Math.sin(th * D))}" y2="${f(cy + R * Math.cos(th * D))}"/>`;
      const b = this.beam(p, 0, 180, 0.5), fl = this.beam(p, 0, 180, 0.1);
      const show = (th) => up || Math.abs(th) <= 90;
      if (fl) [fl.a, fl.b].filter(show).forEach(th => { rays += ray(th, 'pv-field'); });
      if (b) [b.a, b.b].filter(show).forEach(th => { rays += ray(th, 'pv-beam'); });
    }
    const sizeHtml = o.fixed ? ` width="${W}" height="${H}"` : '';
    return `<svg class="pv-svg" viewBox="0 0 ${W} ${H}"${sizeHtml} role="img" aria-label="Polar curve of ${escHtml(p.name || 'the luminaire')}, cd/klm: C0–C180 solid, C90–C270 dashed">
      ${grid}${rays}
      <path class="pv-c90" d="${curveHtml(90, 270)}"/>
      <path class="pv-c0" d="${curveHtml(0, 180)}"/></svg>`;
  },

  // Key for the polar curve. `names` overrides the plane labels (road: along / across).
  polarLegend(names) {
    const n = names || ['C0–C180', 'C90–C270'];
    return `<div class="pv-legend">
      <span><svg width="22" height="6" aria-hidden="true"><line class="pv-c0" x1="0" y1="3" x2="22" y2="3"/></svg>${escHtml(n[0])}</span>
      <span><svg width="22" height="6" aria-hidden="true"><line class="pv-c90" x1="0" y1="3" x2="22" y2="3"/></svg>${escHtml(n[1])}</span>
      <span><svg width="22" height="6" aria-hidden="true"><line class="pv-beam" x1="0" y1="3" x2="22" y2="3"/></svg>Beam 50 %</span>
      <span><svg width="22" height="6" aria-hidden="true"><line class="pv-field" x1="0" y1="3" x2="22" y2="3"/></svg>Field 10 %</span>
      <span class="pv-unit">cd/klm</span></div>`;
  },

  // ─── One fitting on the floor ───
  // E (lx) at plan offset (x, y) m from a fitting h m above the floor, aimed straight down
  // with C0 along +x; `k` scales the web (lumens / fluxPct).
  floorE(p, x, y, h, k = 1) {
    const r = Math.hypot(x, y), g = Math.atan2(r, h) / this.D;
    const C = Math.atan2(y, x) / this.D;
    const cg = Math.cos(g * this.D);
    return this.cd(p, C, g) * k * cg * cg * cg / (h * h);
  },

  // Floor isolux of one fitting at mounting height h (m): lines on a 1-2-5 ladder from the
  // peak down to 1 % of it, over a square that holds the 1 % line.
  isoluxSvg(p, h, k = 1) {
    const f = this._f, D = this.D;
    const t = this.table(p);
    if (!(t.max > 0) || t.down < 0.02) return { svg: '<p class="pv-none">This fitting sends almost no light downwards, so there is nothing to draw on the floor.</p>', none: true };
    let Emax = 0;
    for (let q = 0; q < 45; q++) for (let c = 0; c < 72; c += 2) {
      const g = q * 2, r = h * Math.tan(g * D);
      Emax = Math.max(Emax, this.floorE(p, r * Math.cos(c * 5 * D), r * Math.sin(c * 5 * D), h, k));
    }
    const low = Emax / 100;
    let reach = 0;
    for (let c = 0; c < 360; c += 10) for (let r = 0.05; r <= 60; r += Math.max(0.05, r * 0.03)) if (this.floorE(p, r * Math.cos(c * D), r * Math.sin(c * D), h, k) >= low) reach = Math.max(reach, r);
    const ext = Math.min(Math.max(Math.ceil(reach * 1.1), 2), 60);       // half-width, m
    const n = 100, d = 2 * ext / n, V = new Float64Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) V[j * (n + 1) + i] = this.floorE(p, -ext + i * d, ext - j * d, h, k);
    const S = 360, px = S / (2 * ext), M = 20;
    const X = (u) => f(M + u * d * px), Y = (v) => f(M + v * d * px);
    const ladder = [];
    for (let e = Math.floor(Math.log10(low)) - 1; e <= Math.ceil(Math.log10(Emax)); e++) for (const m of [1, 2, 5]) ladder.push(m * Math.pow(10, e));
    const levels = ladder.filter(L => L >= low * 0.999 && L < Emax);
    let lines = '', labels = '';
    levels.forEach((L, li) => {
      for (const s of this.contour(V, n + 1, n + 1, L)) lines += `M${X(s[0])} ${Y(s[1])}L${X(s[2])} ${Y(s[3])}`;
      // label where the line crosses a ray (alternating 30° / 50° below C0)
      const th = (li % 2 ? 50 : 30) * D;
      let last = -1;
      for (let r = 0; r <= ext; r += d / 2) if (this.floorE(p, r * Math.cos(th), -r * Math.sin(th), h, k) >= L) last = r;
      if (last > d) {
        const lx = M + (ext + last * Math.cos(th)) * px, ly = M + (ext + last * Math.sin(th)) * px;
        labels += `<text class="pv-lbl" x="${f(lx)}" y="${f(ly + 4)}" text-anchor="middle">${this._num(L)}</text>`;
      }
    });
    const gs = this._nice(ext / 4);
    let grid = '';
    for (let v = -Math.floor(ext / gs) * gs; v <= ext + 1e-9; v += gs) {
      const q = f(M + (ext + v) * px);
      grid += `<line class="${Math.abs(v) < 1e-9 ? 'pv-axis' : 'pv-grid'}" x1="${q}" y1="${M}" x2="${q}" y2="${M + S}"/><line class="${Math.abs(v) < 1e-9 ? 'pv-axis' : 'pv-grid'}" x1="${M}" y1="${q}" x2="${M + S}" y2="${q}"/>`;
    }
    const c = M + S / 2;
    return {
      svg: `<svg class="pv-svg" viewBox="0 0 ${S + 2 * M} ${S + 2 * M}" role="img" aria-label="Floor illuminance under one fitting at ${h} m: isolux lines">
        ${grid}<path class="pv-iso" d="${lines}"/>
        <circle class="pv-lum" cx="${c}" cy="${c}" r="4"/>
        <path class="pv-arrow" d="M${c} ${c}H${c + 34}M${c + 34} ${c}l-6 -4M${c + 34} ${c}l-6 4"/>
        <text class="pv-txt" x="${c + 38}" y="${c - 4}">C0</text>
        ${labels}</svg>`,
      grid: gs, Emax, ext,
    };
  },

  _num(v) { return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(v % 1 ? 1 : 0) : v.toPrecision(1); },

  // Marching squares on node values V[j * nx + i] at one level → segments [i0, j0, i1, j1] (node units).
  contour(V, nx, ny, L) {
    const out = [];
    const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] };
    for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
      const v0 = V[j * nx + i], v1 = V[j * nx + i + 1], v2 = V[(j + 1) * nx + i + 1], v3 = V[(j + 1) * nx + i];
      if (!(Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(v2) && Number.isFinite(v3))) continue;
      const tab = T[(v0 >= L ? 1 : 0) | (v1 >= L ? 2 : 0) | (v2 >= L ? 4 : 0) | (v3 >= L ? 8 : 0)];
      if (!tab) continue;
      const ep = (e) => e === 0 ? [i + (L - v0) / (v1 - v0), j] : e === 1 ? [i + 1, j + (L - v1) / (v2 - v1)]
        : e === 2 ? [i + (L - v3) / (v2 - v3), j + 1] : [i, j + (L - v0) / (v3 - v0)];
      for (const [a, b] of tab) { const A = ep(a), B = ep(b); out.push([A[0], A[1], B[0], B[1]]); }
    }
    return out;
  },

  // ─── Cone diagram (rotationally symmetric downlights) ───
  cone(p, k = 1, heights = [1, 2, 3, 4]) {
    const b = this.beam(p, 0, 180, 0.5);
    if (!b) return null;
    const half = b.angle / 2, tn = Math.tan(half * this.D), I0 = this.cd(p, 0, 0) * k;
    return { angle: b.angle, rows: heights.map(h => ({ h, d: 2 * h * tn, e: I0 / (h * h) })) };
  },

  coneSvg(cone) {
    const f = this._f, D = 4, S = Math.min(55, 190 / (D * Math.tan(Math.min(cone.angle, 160) / 2 * this.D) || 1)), cx = 230, top = 16;
    const w = (h) => h * Math.tan(cone.angle / 2 * this.D) * S;
    const chords = cone.rows.map(r => `<line class="pv-chord" x1="${f(cx - w(r.h))}" y1="${f(top + r.h * S)}" x2="${f(cx + w(r.h))}" y2="${f(top + r.h * S)}"/>
      <text class="pv-txt" x="4" y="${f(top + r.h * S + 4)}">${r.h} m</text>`).join('');
    const b = top + D * S;
    return `<svg class="pv-svg" viewBox="0 0 460 ${Math.ceil(b + 12)}" role="img" aria-label="Cone diagram: spot diameter at each height">
      <path class="pv-cone" d="M${cx} ${top}L${f(cx - w(D))} ${f(b)}H${f(cx + w(D))}Z"/>
      <path class="pv-c0" d="M${cx} ${top}L${f(cx - w(D))} ${f(b)}M${cx} ${top}L${f(cx + w(D))} ${f(b)}"/>
      ${chords}<circle class="pv-lum" cx="${cx}" cy="${top}" r="4"/></svg>`;
  },

  // ─── Fittings in a room ───
  // Top view of the photometric solid in frame F (rows: the fitting's C0, C90 and up axes in
  // plan metres, z up): per C plane, the horizontal offset of the point that reaches furthest,
  // in candela-metres (× a scale → metres).
  outline(p, F) {
    const t = this.table(p), D = this.D, out = [];
    for (let k = 0; k < 72; k++) {
      const cc = Math.cos(k * 5 * D), sc = Math.sin(k * 5 * D);
      let best = 0, bx = 0, by = 0;
      for (let q = 0; q <= 90; q++) {
        const I = t.I[k][q];
        if (!(I > 0)) continue;
        const sg = Math.sin(q * 2 * D), cg = Math.cos(q * 2 * D);
        const l0 = sg * cc, l1 = sg * sc, l2 = -cg;
        const wx = l0 * F[0][0] + l1 * F[1][0] + l2 * F[2][0], wy = l0 * F[0][1] + l1 * F[1][1] + l2 * F[2][1];
        const hz = I * Math.hypot(wx, wy);
        if (hz > best) { best = hz; bx = I * wx; by = I * wy; }
      }
      out.push([bx, by]);
    }
    return out;
  },

  // The curve in the vertical plane through the fitting along plan direction (ux, uy):
  // [[s, z]] in candela-metres, s along u, z up, θ = −180…180 from nadir.
  sectionCurve(p, F, ux, uy) {
    const D = this.D, out = [];
    for (let th = -180; th <= 180; th += 2) {
      const w = [Math.sin(th * D) * ux, Math.sin(th * D) * uy, -Math.cos(th * D)];
      const l0 = w[0] * F[0][0] + w[1] * F[0][1] + w[2] * F[0][2];
      const l1 = w[0] * F[1][0] + w[1] * F[1][1] + w[2] * F[1][2];
      const l2 = w[0] * F[2][0] + w[1] * F[2][1] + w[2] * F[2][2];
      const g = Math.acos(Math.max(-1, Math.min(1, -l2))) / D, C = Math.atan2(l1, l0) / D;
      const I = this.cd(p, C, g);
      out.push([I * Math.sin(th * D), -I * Math.cos(th * D)]);
    }
    return out;
  },

  // Key figures for the library.
  facts(p) {
    const t = this.table(p), k1 = 1000 / (Number(p.lumens) || 1);
    const b0 = this.beam(p, 0, 180, 0.5), b9 = this.beam(p, 90, 270, 0.5), f0 = this.beam(p, 0, 180, 0.1);
    const deg = (b) => b ? `${Math.round(b.angle)}°` : '—';
    const lm = Number(p.lumens) || 0, w = Number(p.watts) || 0;
    return [
      ['Luminous flux', `${Math.round(lm)} lm`],
      ['System power', w ? `${Math.round(w * 10) / 10} W` : '—'],
      ['Efficacy', w ? `${Math.round(lm / w)} lm/W` : '—'],
      ['Peak intensity', `${Math.round(t.max * k1)} cd/klm`],
      ['Beam angle C0–C180', deg(b0)],
      ['Beam angle C90–C270', deg(b9)],
      ['Field angle C0–C180', deg(f0)],
      ['Light downwards / upwards', `${Math.round(t.down * 100)} % / ${Math.round((1 - t.down) * 100)} %`],
    ];
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PhotoView;
