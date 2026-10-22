/* ProtectionPro — Plan › Lighting: run the room calculation and show it.
 *
 * Collects each room's outline and the fittings inside it (bd_light elements
 * bound to a library luminaire), sends them to /api/analysis/room-lighting,
 * keeps the answer for the session and draws it: a false-colour work-plane
 * grid with isolux lines at the target and at the minimum point value. The
 * result is stamped with a signature of its inputs, so a room whose fittings
 * or settings have changed since reads "out of date" instead of lying.
 */

const RoomCalc = {
  results: {},          // room id → { res, sig }
  enabled: true,        // draw the grid for rooms that have a result
  _busy: false,
  _pmRef: null,

  // Results belong to the project in memory; a different project object means a new project.
  _sync() { if (this._pmRef !== AppState.planMarkup) { this._pmRef = AppState.planMarkup; this.results = {}; } },

  _isCalcLight(el) {
    const def = PLAN_DEFS.element(el.type);
    if (!def || def.group !== 'Lighting') return false;
    const k = el.props && el.props.kind;
    return k !== 'emergency' && k !== 'exit';
  },

  // Request for one room (metres, y up) + the photometry it needs.
  buildRoom(room, f) {
    const pm = AppState.planMarkup;
    const L = RoomLighting.read(room);
    const poly = room.points.map(p => [p.x * f, -p.y * f]);
    const P = room.points;
    const lums = [], skipped = [];
    for (const el of pm.elements) {
      if (!this._isCalcLight(el)) continue;
      if (!PlanEngine._pointInPoly({ x: el.x, y: el.y }, P)) continue;
      const pr = el.props || {};
      if (!pr.photoId || !PhotoLib.get(pr.photoId)) { skipped.push(el.name || el.id); continue; }
      lums.push({
        id: el.id, x: +(el.x * f).toFixed(4), y: +(-el.y * f).toFixed(4), photometryId: pr.photoId,
        mount: pr.mount || 'recessed', drop: Number(pr.drop) || 0, rotate: -(el.rotation || 0),
        fluxPct: pr.fluxPct != null && pr.fluxPct !== '' ? Number(pr.fluxPct) : 100,
        lumens: Number(pr.lumens) > 0 ? Number(pr.lumens) : undefined,
        watts: Number(pr.watts) > 0 ? Number(pr.watts) : undefined,
      });
    }
    return {
      req: {
        id: room.id, name: room.name, polygon: poly, ceilH: L.ceilH, workH: L.workH, wallZone: L.wallZone,
        rhoC: L.rhoC, rhoW: L.rhoW, rhoF: L.rhoF, mf: L.mf,
        targets: { em: L.em, uo: L.uo, ugr: L.ugr, wallE: L.wallE, ceilE: L.ceilE, ez: L.ez || undefined },
        luminaires: lums,
      },
      skipped,
    };
  },

  signature(room) {
    const f = PlanEngine.factor();
    if (!f) return '';
    const b = this.buildRoom(room, f).req;
    const web = {};
    for (const l of b.luminaires) { const p = PhotoLib.get(l.photometryId); if (p) web[l.photometryId] = [p.lumens, p.watts, p.name]; }
    return JSON.stringify([b, web]);
  },

  isCurrent(room) {
    this._sync();
    const r = this.results[room.id];
    return !!r && r.sig === this.signature(room);
  },

  async run(rooms) {
    this._sync();
    const f = PlanEngine.factor();
    if (!f) { UI.alert('Calibrate the plan first — the calculation needs real distances.'); return; }
    const pm = AppState.planMarkup;
    const list = (rooms || pm.rooms || []).filter(r => r.points && r.points.length >= 3 && r.kind !== 'outdoor');
    if (!list.length) { UI.toast('Draw or detect a room first.', 'info'); return; }
    if (this._busy) return;
    const built = list.map(r => ({ room: r, ...this.buildRoom(r, f) })).filter(b => b.req.luminaires.length || true);
    const photometry = {};
    for (const b of built) for (const l of b.req.luminaires) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    this._busy = true;
    if (UI.setBusy) UI.setBusy(true, 'Calculating lighting…');
    let out;
    try {
      out = await API.request('/analysis/room-lighting', 'POST', { rooms: built.map(b => b.req), photometry, detail: 'full' });
    } catch (e) {
      UI.alert('Lighting calculation failed: ' + (e && e.message ? e.message : e));
      return;
    } finally {
      this._busy = false;
      if (UI.setBusy) UI.setBusy(false);
    }
    const sigs = new Map(built.map(b => [b.room.id, this.signature(b.room)]));
    let pass = 0, fail = 0, none = 0;
    for (const r of out.rooms) {
      if (r.error) { UI.toast(`${r.name}: ${r.error}`, 'warn', 6000); continue; }
      this.results[r.id] = { res: r, sig: sigs.get(r.id) };
      if (r.pass === true) pass++; else if (r.pass === false) fail++; else none++;
    }
    const skipped = built.reduce((n, b) => n + b.skipped.length, 0);
    UI.toast(`Lighting: ${pass} pass, ${fail} fail${none ? `, ${none} without fittings` : ''}${skipped ? ` · ${skipped} fitting${skipped === 1 ? ' has' : 's have'} no library luminaire (pick one in its properties)` : ''}.`,
      fail ? 'warn' : 'success', 6000);
    PlanEngine.requestDraw({ fg: true });
    PlanMarkup.refreshProps();
  },

  // ─── Results block for the room panel ───
  resultHtml(room) {
    this._sync();
    const r = this.results[room.id];
    const btn = `<button type="button" class="plan-circuit-btn" data-rc-run>${r ? '↻ Recalculate' : '▶ Calculate lighting'}</button>`;
    if (!r) return `<div class="rc-res" style="margin-top:8px">${btn}</div>`;
    const res = r.res, cur = r.sig === this.signature(room);
    const fmt = (c) => {
      const v = c.value;
      const val = (c.unit === 'lx') ? Math.round(v) : (c.key === 'uo' ? v.toFixed(2) : v.toFixed(1));
      const cls = c.pass === true ? '#1d6b3a' : c.pass === false ? '#a61b1b' : '#616e7c';
      return `<tr><td>${escHtml(c.label)}</td><td style="text-align:right;font-family:monospace">${val}</td>
        <td style="text-align:right;color:var(--text-muted);font-family:monospace">${c.op === '>=' ? '≥' : '≤'} ${c.req}</td>
        <td style="color:${cls};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    };
    const wp = res.workplane || {};
    return `<div class="rc-res" style="margin-top:8px">
      ${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date — the room or its fittings changed.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${(res.checks || []).map(fmt).join('')}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0">${res.luminaires} fitting${res.luminaires === 1 ? '' : 's'} · Emin ${Math.round(wp.Emin || 0)} / Emax ${Math.round(wp.Emax || 0)} lx · ${res.power.wm2} W/m²${res.power.wm2per100lx != null ? ` · ${res.power.wm2per100lx} W/m²/100 lx` : ''}${res.cylindrical ? ` · Ēz ${Math.round(res.cylindrical.Ez)} lx` : ''}</div>
      ${(res.warnings || []).concat(res.notes || []).map(w => `<div style="font-size:11px;color:#8a5a00">${escHtml(w)}</div>`).join('')}
      ${btn}</div>`;
  },

  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    propsEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-rc-run]')) return;
      const wrap = propsEl.querySelector('[data-rl-room]');
      const room = wrap && (AppState.planMarkup.rooms || []).find(r => r.id === wrap.dataset.rlRoom);
      if (room) this.run([room]);
    });
  },

  // ─── Drawing ───
  _color(v) {
    const hue = 240 - 240 * Math.max(0, Math.min(1, v));
    return `hsl(${hue}, 80%, 50%)`;
  },

  draw(ctx, zoom) {
    this._sync();
    if (!this.enabled) return;
    const f = PlanEngine.factor();
    if (!f) return;
    const pm = AppState.planMarkup;
    for (const room of (pm.rooms || [])) {
      const r = this.results[room.id];
      if (!r || !r.res.grid) continue;
      const g = r.res.grid, wp = r.res.workplane || {};
      const top = Math.max(wp.Emax || 0, 1);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(room.points[0].x, room.points[0].y);
      for (let i = 1; i < room.points.length; i++) ctx.lineTo(room.points[i].x, room.points[i].y);
      ctx.closePath(); ctx.clip();
      ctx.globalAlpha = r.sig === this.signature(room) ? 0.5 : 0.22;
      const dxp = g.dx / f, dyp = g.dy / f;
      for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
        const v = g.values[j * g.nx + i];
        if (v == null) continue;
        ctx.fillStyle = this._color(v / top);
        const gx = g.x0 + i * g.dx, gy = g.y0 + j * g.dy;           // metres, y up (cell lower-left)
        ctx.fillRect(gx / f, -(gy + g.dy) / f, dxp + 0.5, dyp + 0.5);
      }
      ctx.globalAlpha = 1;
      const L = RoomLighting.read(room);
      this._contour(ctx, g, f, L.em, zoom, false);
      this._contour(ctx, g, f, L.em * L.uo, zoom, true);
      ctx.restore();
    }
  },

  // Marching squares on cell centres at one level.
  _contour(ctx, g, f, level, zoom, dashed) {
    if (!(level > 0)) return;
    const at = (i, j) => { const v = g.values[j * g.nx + i]; return v == null ? NaN : v; };
    const X = (i) => (g.x0 + (i + 0.5) * g.dx) / f, Y = (j) => -(g.y0 + (j + 0.5) * g.dy) / f;
    ctx.save();
    ctx.strokeStyle = dashed ? 'rgba(17,24,39,0.7)' : '#111827';
    ctx.lineWidth = 1.2 / zoom;
    if (dashed) ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.beginPath();
    const lerp = (a, b, va, vb) => a + (b - a) * ((level - va) / (vb - va));
    for (let j = 0; j + 1 < g.ny; j++) for (let i = 0; i + 1 < g.nx; i++) {
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (v.some(Number.isNaN)) continue;
      const pts = [];
      const edge = (a, b, ax, ay, bx, by) => {
        if ((v[a] < level) !== (v[b] < level)) pts.push([lerp(ax, bx, v[a], v[b]), lerp(ay, by, v[a], v[b])]);
      };
      const x0 = X(i), x1 = X(i + 1), y0 = Y(j), y1 = Y(j + 1);
      edge(0, 1, x0, y0, x1, y0); edge(1, 2, x1, y0, x1, y1); edge(2, 3, x1, y1, x0, y1); edge(3, 0, x0, y1, x0, y0);
      if (pts.length === 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
      else if (pts.length === 4) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]); }
    }
    ctx.stroke();
    ctx.restore();
  },
};
