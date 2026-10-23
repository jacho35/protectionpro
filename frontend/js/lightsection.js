/* ProtectionPro — Lighting › room section: polar curves where they act.
 *
 * A vertical cut through a room, along or across its longest wall at a chosen
 * position: floor, walls and ceiling (flat, or the room's ceiling section),
 * the work plane, and each fitting within a band of the cut with its polar
 * curve in the plane of the cut — turned by the fitting's own mounting frame
 * (rotation; a wall fitting faces into the room, tilted by its aim), all to
 * one candela scale so a stronger fitting reads bigger. Under it, the
 * work-plane illuminance along the cut from the room's last result. The cut
 * is drawn on the plan while the dialog is open. Session-only: nothing is
 * stored in the project.
 */

const LightSection = {
  roomId: null,
  dir: 'along',         // the cut runs along the longest wall, or across it
  pos: 0.5,             // where it crosses the room, 0…1 across
  band: 0.75,           // fittings within this distance (m) of the cut are drawn
  cut: null,            // { floorId, a: {x, y}, b: {x, y} } plan px, while the dialog is open

  _room() { return (AppState.planMarkup.rooms || []).find(r => r.id === this.roomId) || null; },

  // Ceiling height (m) at plan point (x, y) m, y up.
  _ceilAt(room, P, x, y) {
    const L = RoomLighting.read(room);
    const c = typeof RoomSection !== 'undefined' ? RoomSection.request(room, P) : undefined;
    if (!c) return L.ceilH;
    const a = c.angle * Math.PI / 180, s = x * Math.cos(a) + y * Math.sin(a) - c.s0, pts = c.points;
    if (s <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (s <= pts[i][0]) {
      const t = (s - pts[i - 1][0]) / Math.max(pts[i][0] - pts[i - 1][0], 1e-9);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    }
    return pts[pts.length - 1][1];
  },

  // The cut: direction u, offset t along v, the room's inside intervals along u.
  geometry(room) {
    const f = PlanEngine.factor();
    if (!f || !room || !room.points || room.points.length < 3) return null;
    const P = room.points.map(p => [p.x * f, -p.y * f]);
    const w = RoomSection.longestWall(P), a = P[w], b = P[(w + 1) % P.length];
    const Lw = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let u = [(b[0] - a[0]) / Lw, (b[1] - a[1]) / Lw];
    if (this.dir === 'across') u = [-u[1], u[0]];
    if (u[0] < -1e-9 || (Math.abs(u[0]) < 1e-9 && u[1] < 0)) u = [-u[0], -u[1]];   // read left → right / bottom → top
    const v = [-u[1], u[0]];
    const vs = P.map(p => p[0] * v[0] + p[1] * v[1]), vmin = Math.min(...vs), vmax = Math.max(...vs);
    const t = vmin + (vmax - vmin) * Math.min(Math.max(this.pos, 0.005), 0.995);
    const ss = [];
    P.forEach((p, i) => {
      const q = P[(i + 1) % P.length], da = vs[i] - t, db = vs[(i + 1) % P.length] - t;
      if ((da < 0) !== (db < 0)) {
        const fr = da / (da - db), x = p[0] + (q[0] - p[0]) * fr, y = p[1] + (q[1] - p[1]) * fr;
        ss.push(x * u[0] + y * u[1]);
      }
    });
    ss.sort((x, y) => x - y);
    const spans = [];
    for (let i = 0; i + 1 < ss.length; i += 2) if (ss[i + 1] - ss[i] > 1e-6) spans.push([ss[i], ss[i + 1]]);
    if (!spans.length) return null;
    return { f, P, u, v, t, spans, s0: spans[0][0], s1: spans[spans.length - 1][1], pt: (s) => [t * v[0] + s * u[0], t * v[1] + s * u[1]] };
  },

  // Fittings near the cut, with their height and curve (cd·m, before the common scale).
  fittings(room, G) {
    const L = RoomLighting.read(room), out = [];
    const sectioned = typeof RoomSection !== 'undefined' && RoomSection.get(room).type !== 'flat';
    for (const el of RoomCalc._distFittings()) {
      if (!PlanEngine._pointInPoly({ x: el.x, y: el.y }, room.points)) continue;
      const x = el.x * G.f, y = -el.y * G.f;
      const off = x * G.v[0] + y * G.v[1] - G.t;
      if (Math.abs(off) > this.band) continue;
      const pr = el.props || {}, ph = PhotoLib.get(pr.photoId);
      const hc = this._ceilAt(room, G.P, x, y);
      const z = pr.mount === 'pendant' ? Math.min(Math.max(Number(pr.hangH) > 0 ? +pr.hangH : hc - 0.5, 0.3), hc - 0.02)
        : pr.mount === 'wall' ? Math.min(Math.max(Number(pr.hangH) > 0 ? +pr.hangH : 2.0, 0.1), hc - 0.05)
          : pr.mount === 'suspended' ? Math.max(hc - (Number(pr.drop) || 0), 0.3)
            : sectioned ? hc - 0.05 : hc;
      const k = RoomCalc._fluxScale(el, ph), F = RoomCalc._planFrame(el, G.f);
      const curve = PhotoView.sectionCurve(ph, F, G.u[0], G.u[1]).map(([a, b]) => [a * k, b * k]);
      out.push({ el, ph, s: x * G.u[0] + y * G.u[1], z, off, curve, ceil: hc, mount: pr.mount || 'recessed' });
    }
    return out.sort((a, b) => a.s - b.s);
  },

  open(room) {
    if (!room || !PlanEngine.factor()) { UI.alert('Calibrate the plan first — the section needs real distances.'); return; }
    this.roomId = room.id;
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Room section');
    ov.innerHTML = `<div class="modal-content plan-floor-content ls-content">
      <div class="modal-header"><h3>Section — ${escHtml(room.name || 'Room')}</h3></div>
      <div class="modal-body">
        <div class="ls-ctl">
          <label>Cut <select data-ls="dir"><option value="along"${this.dir === 'along' ? ' selected' : ''}>Along the longest wall</option><option value="across"${this.dir === 'across' ? ' selected' : ''}>Across it</option></select></label>
          <label class="ls-pos">Position <input type="range" data-ls="pos" min="0" max="100" step="1" value="${Math.round(this.pos * 100)}"></label>
          <label>Fittings within <input type="number" data-ls="band" min="0.1" max="20" step="0.25" value="${this.band}"> m</label>
        </div>
        <div data-ls-body></div>
        <div class="ui-dialog-actions"><button class="btn-primary" data-ls-close>Done</button></div>
      </div></div>`;
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); this.cut = null; PlanEngine.requestDraw({ fg: true }); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target.closest('[data-ls-close]') || e.target === ov) close(); });
    const upd = (e) => {
      const k = e.target.dataset && e.target.dataset.ls;
      if (!k) return;
      if (k === 'dir') this.dir = e.target.value === 'across' ? 'across' : 'along';
      else if (k === 'pos') this.pos = (+e.target.value || 0) / 100;
      else if (k === 'band') { const b = +e.target.value; if (b > 0) this.band = Math.min(b, 20); }
      this.render(ov);
    };
    ov.addEventListener('input', upd);
    ov.addEventListener('change', upd);
    document.body.appendChild(ov);
    this.render(ov);
  },

  render(ov) {
    const host = ov.querySelector('[data-ls-body]'), room = this._room();
    const G = this.geometry(room);
    if (!G) { host.innerHTML = '<p class="pv-none">The cut misses the room — move it.</p>'; this.cut = null; PlanEngine.requestDraw({ fg: true }); return; }
    const pm = AppState.planMarkup, f = G.f;
    const ext = 0.4, A = G.pt(G.s0 - ext), B = G.pt(G.s1 + ext);
    this.cut = { floorId: pm.activeFloorId, a: { x: A[0] / f, y: -A[1] / f }, b: { x: B[0] / f, y: -B[1] / f } };
    PlanEngine.requestDraw({ fg: true });
    host.innerHTML = this.svg(room, G);
  },

  svg(room, G) {
    const L = RoomLighting.read(room), fits = this.fittings(room, G);
    const n = (v) => (+v).toFixed(1);
    // ceiling along each span
    const ceil = G.spans.map(([a, b]) => {
      const out = [];
      for (let i = 0; i <= 40; i++) { const s = a + (b - a) * i / 40, p = G.pt(s); out.push([s, this._ceilAt(room, G.P, p[0], p[1])]); }
      return out;
    });
    const Hmax = Math.max(...ceil.flat().map(q => q[1]), ...fits.map(x => x.z + 0.2));
    const W = 860, padL = 46, padR = 20, top = 22;
    const sc = Math.min((W - padL - padR) / Math.max(G.s1 - G.s0, 0.5), 320 / Hmax);
    const X = (s) => padL + (s - G.s0) * sc, Z = (z) => top + (Hmax - z) * sc;
    const Hs = Math.ceil(top + Hmax * sc + 26);
    // one candela scale for every curve: the strongest reaches 55 % of the tallest ceiling
    let maxI = 0;
    for (const x of fits) for (const [a, b] of x.curve) maxI = Math.max(maxI, Math.hypot(a, b));
    const kS = maxI > 0 ? 0.55 * Hmax / maxI : 0;
    let room$ = '', walls = '', wp = '';
    G.spans.forEach(([a, b], i) => {
      const c = ceil[i];
      room$ += `M${n(X(a))} ${n(Z(0))}` + c.map(([s, z]) => `L${n(X(s))} ${n(Z(z))}`).join('') + `L${n(X(b))} ${n(Z(0))}Z`;
      walls += `M${n(X(a))} ${n(Z(0))}L${n(X(a))} ${n(Z(c[0][1]))}M${n(X(b))} ${n(Z(0))}L${n(X(b))} ${n(Z(c[c.length - 1][1]))}`
        + `M${n(X(a) - 4)} ${n(Z(0))}H${n(X(b) + 4)}` + `M${n(X(c[0][0]))} ${n(Z(c[0][1]))}` + c.map(([s, z]) => `L${n(X(s))} ${n(Z(z))}`).join('');
      wp += `M${n(X(a))} ${n(Z(L.workH))}H${n(X(b))}`;
    });
    let curves = '', bodies = '', names = '';
    for (const x of fits) {
      const cx = X(x.s), cz = Z(x.z);
      curves += `<path class="ls-curve" d="${x.curve.map(([a, b], i) => `${i ? 'L' : 'M'}${n(cx + a * kS * sc)} ${n(cz - b * kS * sc)}`).join('')}Z"/>`;
      bodies += x.mount === 'wall' ? `<rect class="ls-lum" x="${n(cx - 3)}" y="${n(cz - 6)}" width="6" height="12"/>` : `<rect class="ls-lum" x="${n(cx - 9)}" y="${n(cz - 2)}" width="18" height="5"/>`;
      if (x.mount === 'pendant' || x.mount === 'suspended') bodies += `<line class="ls-cord" x1="${n(cx)}" y1="${n(Z(x.ceil))}" x2="${n(cx)}" y2="${n(cz - 2)}"/>`;
      names += `<text class="pv-txt" text-anchor="middle" x="${n(cx)}" y="${n(Math.min(cz, Z(x.ceil)) - 6)}">${escHtml(x.el.name || '')}</text>`;
    }
    const cdPerM = kS > 0 ? Math.round(1 / kS) : 0;
    const head = `<p class="ls-note">${fits.length ? `${fits.length} fitting${fits.length === 1 ? '' : 's'} within ${this.band} m of the cut · curves to one scale: 1 m = ${cdPerM} cd` : `No fittings with a library luminaire within ${this.band} m of the cut — widen the band or move the cut.`}</p>`;
    const sec = `<svg class="ls-svg" viewBox="0 0 ${W} ${Hs}" role="img" aria-label="Room section with each fitting's polar curve in the plane of the cut">
      <path class="ls-room" d="${room$}"/>
      <path class="ls-wp" d="${wp}"/>
      <text class="pv-txt" x="${n(X(G.s0) + 6)}" y="${n(Z(L.workH) - 5)}">Work plane ${L.workH.toFixed(2)} m</text>
      ${curves}<path class="ls-wall" d="${walls}"/>${bodies}${names}
      <text class="pv-txt" text-anchor="middle" x="${n(X(G.s0))}" y="${Hs - 6}">A</text><text class="pv-txt" text-anchor="middle" x="${n(X(G.s1))}" y="${Hs - 6}">A′</text>
      <text class="pv-txt" text-anchor="middle" x="${n((X(G.s0) + X(G.s1)) / 2)}" y="${Hs - 6}">${(G.s1 - G.s0).toFixed(2)} m</text></svg>`;
    return head + sec + this._profile(room, G, X, W, L);
  },

  // Work-plane illuminance along the cut from the room's last result.
  _profile(room, G, X, W, L) {
    const r = RoomCalc.results[room.id];
    const g = r && r.res && r.res.grid;
    if (!g) return '<p class="pv-none">Calculate the room to see the work-plane illuminance along the cut.</p>';
    const n = (v) => (+v).toFixed(1), pts = [];
    let mx = 0;
    const ds = Math.min(g.dx, g.dy) / 2;
    for (const [a, b] of G.spans) {
      const run = [];
      for (let s = a; s <= b + 1e-9; s += ds) {
        const p = G.pt(s), i = Math.floor((p[0] - g.x0) / g.dx), j = Math.floor((p[1] - g.y0) / g.dy);
        const v = i >= 0 && j >= 0 && i < g.nx && j < g.ny ? g.values[j * g.nx + i] : null;
        if (v == null) { if (run.length) pts.push(run.splice(0)); continue; }
        run.push([s, v]); mx = Math.max(mx, v);
      }
      if (run.length) pts.push(run);
    }
    if (!pts.length) return '<p class="pv-none">The cut runs outside the calculated grid.</p>';
    const top = Math.max(mx, L.em) * 1.1, H = 150, y0 = 12, y1 = H - 22;
    const Y = (v) => y1 - (v / top) * (y1 - y0);
    const step = PhotoView._nice(top / 4);
    let grid = '';
    for (let v = 0; v <= top + 1e-9; v += step) grid += `<line class="pv-grid" x1="${n(X(G.s0))}" y1="${n(Y(v))}" x2="${n(X(G.s1))}" y2="${n(Y(v))}"/><text class="pv-txt" text-anchor="end" x="${n(X(G.s0) - 6)}" y="${n(Y(v) + 4)}">${Math.round(v)}</text>`;
    const line = pts.map(run => run.map(([s, v], i) => `${i ? 'L' : 'M'}${n(X(s))} ${n(Y(v))}`).join('')).join('');
    const cur = r.sig === RoomCalc.signature(room);
    return `<p class="ls-note">Work-plane illuminance along the cut, lx${cur ? '' : ' · <b>out of date</b> — the room or its fittings changed'}</p>
      <svg class="ls-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Work-plane illuminance along the cut">
      ${grid}<line class="ls-target" x1="${n(X(G.s0))}" y1="${n(Y(L.em))}" x2="${n(X(G.s1))}" y2="${n(Y(L.em))}"/>
      <text class="ls-target-t" text-anchor="end" x="${n(X(G.s1))}" y="${n(Y(L.em) - 4)}">Target ${Math.round(L.em)} lx</text>
      <path class="ls-prof" d="${line}"/></svg>`;
  },

  // The cut on the plan while the dialog is open.
  drawPlan(ctx, zoom) {
    const c = this.cut;
    if (!c || c.floorId !== AppState.planMarkup.activeFloorId) return;
    ctx.save();
    ctx.strokeStyle = '#0b63b6'; ctx.lineWidth = 1.6 / zoom;
    ctx.setLineDash([10 / zoom, 4 / zoom, 2 / zoom, 4 / zoom]);
    ctx.beginPath(); ctx.moveTo(c.a.x, c.a.y); ctx.lineTo(c.b.x, c.b.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${12 / zoom}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y, l = Math.hypot(dx, dy) || 1, o = 12 / zoom;
    RoomCalc._halo(ctx, 'A', c.a.x - dx / l * o, c.a.y - dy / l * o, zoom, '#0b63b6');
    RoomCalc._halo(ctx, 'A′', c.b.x + dx / l * o, c.b.y + dy / l * o, zoom, '#0b63b6');
    ctx.restore();
  },
};
