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
  quiet: false,         // the Lighting workspace's Calculate all silences the per-run toasts
  layouts: {},          // room id → { lumId, cands, sel, seed }

  // Results belong to the project in memory; a different project object means a new project.
  _sync() { if (this._pmRef !== AppState.planMarkup) { this._pmRef = AppState.planMarkup; this.results = {}; this.layouts = {}; if (typeof AreaCalc !== 'undefined') AreaCalc.layouts = {}; } },

  _isCalcLight(el) {
    const def = PLAN_DEFS.element(el.type);
    if (!def || def.group !== 'Lighting') return false;
    const k = el.props && el.props.kind;
    return k !== 'emergency' && k !== 'exit' && k !== 'floodlight' && k !== 'area';
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
        mountH: Number(pr.hangH) > 0 ? Number(pr.hangH) : undefined, tilt: pr.mount === 'wall' ? (Number(pr.wallAim) || 0) : undefined,
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
        gridStep: L.grid > 0 ? L.grid : undefined,
        ceiling: typeof RoomSection !== 'undefined' ? RoomSection.request(room, poly, L.ceilH) : undefined,
        luminaires: lums,
        // objects, windows / doors and calculation surfaces from the 3D view
        ...((typeof Light3D !== 'undefined' && Light3D.requestParts(room, f)) || {}),
      },
      skipped,
    };
  },

  signature(room) {
    if ((room.kind === 'outdoor' || room.kind === 'perimeter') && typeof AreaCalc !== 'undefined') return AreaCalc.signature(room);
    if (room.kind === 'sports' && typeof SportsCalc !== 'undefined') return SportsCalc.signature(room);
    if (room.kind === 'obtrusive' && typeof ObtrusiveCalc !== 'undefined') return ObtrusiveCalc.signature(room);
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
    const list = (rooms || pm.rooms || []).filter(r => r.points && r.points.length >= 3 && r.kind !== 'outdoor' && r.kind !== 'perimeter' && r.kind !== 'escape' && r.kind !== 'sports' && r.kind !== 'obtrusive');
    if (!list.length) {
      if (!(pm.rooms || []).some(r => r.kind === 'outdoor' || r.kind === 'perimeter' || r.kind === 'sports' || r.kind === 'obtrusive')) UI.toast('Draw or detect a room first.', 'info');
      return;
    }
    if (this._busy) return;
    const built = list.map(r => ({ room: r, ...this.buildRoom(r, f) })).filter(b => b.req.luminaires.length || true);
    const photometry = {};
    for (const b of built) for (const l of b.req.luminaires) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    this._busy = true;
    if (UI.setBusy) UI.setBusy(true, 'Calculating lighting…');
    let out;
    try {
      // the 3D view's rendered light needs every surface patch of the room it shows
      const patches = (r) => typeof Light3D !== 'undefined' && (Light3D._wantPatches || Light3D._active) && r.id === Light3D.roomId;
      out = await API.request('/analysis/room-lighting', 'POST', { rooms: built.map(b => (patches(b.req) ? Object.assign({}, b.req, { patches: true }) : b.req)), photometry, detail: 'full' });
    } catch (e) {
      UI.alert('Lighting calculation failed: ' + (e && e.message ? e.message : e));
      return;
    } finally {
      this._busy = false;
      if (UI.setBusy) UI.setBusy(false);
    }
    const sigs = new Map(built.map(b => [b.room.id, this.signature(b.room)]));
    const obsIds = new Map(built.map(b => [b.room.id, (b.req.obstacles || []).map(o => o.id)]));
    let pass = 0, fail = 0, none = 0;
    for (const r of out.rooms) {
      if (r.error) { UI.toast(`${r.name}: ${r.error}`, 'warn', 6000); continue; }
      this.results[r.id] = { res: r, sig: sigs.get(r.id), obsIds: obsIds.get(r.id) };
      if (r.pass === true) pass++; else if (r.pass === false) fail++; else none++;
    }
    const skipped = built.reduce((n, b) => n + b.skipped.length, 0);
    if (!RoomCalc.quiet) UI.toast(`Lighting: ${pass} pass, ${fail} fail${none ? `, ${none} without fittings` : ''}${skipped ? ` · ${skipped} fitting${skipped === 1 ? ' has' : 's have'} no library luminaire (pick one in its properties)` : ''}.`,
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
        <td style="color:${escHtml(cls)};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    };
    const wp = res.workplane || {};
    return `<div class="rc-res" style="margin-top:8px">
      ${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date — the room or its fittings changed.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${(res.checks || []).map(fmt).join('')}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0">${res.luminaires} fitting${res.luminaires === 1 ? '' : 's'} · grid ${wp.step} m, ${wp.n} points · Emin ${Math.round(wp.Emin || 0)} / Emax ${Math.round(wp.Emax || 0)} lx · ${res.power.wm2} W/m²${res.power.wm2per100lx != null ? ` · ${res.power.wm2per100lx} W/m²/100 lx` : ''}${res.cylindrical ? ` · Ēz ${Math.round(res.cylindrical.Ez)} lx` : ''}</div>
      ${(() => { const en = RoomLighting.energy(room, res); return en ? `<div style="font-size:12px;margin:2px 0">LENI <b>${en.leni.toFixed(1)}</b> kWh/m²·yr · ${en.kwh.toFixed(0)} kWh/yr${en.lpdPass == null ? '' : ` · <span style="color:${en.lpdPass ? '#1d6b3a' : '#a61b1b'};font-weight:600">${en.wm2.toFixed(1)} W/m² ${en.lpdPass ? '≤' : '>'} ${en.lpd} limit</span>`}</div>` : ''; })()}
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
    propsEl.addEventListener('click', (e) => {
      const wrap = propsEl.querySelector('[data-rl-room]');
      const room = wrap && (AppState.planMarkup.rooms || []).find(r => r.id === wrap.dataset.rlRoom);
      if (!room) return;
      const lay = this.layouts[room.id];
      if (e.target.closest('[data-rc-suggest]')) {
        const sel = propsEl.querySelector('[data-rc-lum]');
        this.suggest(room, sel && sel.value);
      } else if (e.target.closest('[data-rc-pick]') && lay) {
        lay.sel = +e.target.closest('[data-rc-pick]').dataset.rcPick;
        PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
      } else if (e.target.closest('[data-rc-place]')) this.place(room);
      else if (e.target.closest('[data-rc-discard]')) { delete this.layouts[room.id]; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
    });
  },

  // ─── Auto layout ───
  async suggest(room, lumId) {
    this._sync();
    const f = PlanEngine.factor();
    if (!f) { UI.alert('Calibrate the plan first — the layout needs real distances.'); return; }
    const ph = PhotoLib.get(lumId);
    if (!ph) { UI.toast('Pick a luminaire from the library first (Luminaire library on the Lighting tab).', 'info'); return; }
    const { req } = this.buildRoom(room, f);
    req.luminaires = [];
    if (UI.setBusy) UI.setBusy(true, 'Finding layouts…');
    try {
      const out = await API.request('/analysis/room-lighting/layout', 'POST', {
        room: req, photometry: { [lumId]: ph }, photometryId: lumId, mount: 'recessed', fluxPct: 100,
      });
      this.layouts[room.id] = { lumId, cands: out.candidates, sel: 0, seed: out.seed };
    } catch (e) {
      UI.alert('Could not suggest a layout: ' + (e && e.message ? e.message : e));
      delete this.layouts[room.id];
    } finally {
      if (UI.setBusy) UI.setBusy(false);
    }
    PlanMarkup.refreshProps();
    PlanEngine.requestDraw({ fg: true });
  },

  _fittingsIn(room) {
    const P = room.points;
    return AppState.planMarkup.elements.filter(el => this._isCalcLight(el) && PlanEngine._pointInPoly({ x: el.x, y: el.y }, P));
  },

  async place(room) {
    const lay = this.layouts[room.id];
    const f = PlanEngine.factor();
    if (!lay || !f) return;
    const cand = lay.cands[lay.sel];
    const ph = PhotoLib.get(lay.lumId);
    if (!cand || !ph) return;
    const old = this._fittingsIn(room);
    if (old.length) {
      const ok = await UI.confirm(`Replace the ${old.length} fitting${old.length === 1 ? '' : 's'} already in ${room.name || 'this room'} with this layout?`, { okText: 'Replace', cancelText: 'Cancel' });
      if (!ok) return;
      PlanMarkup.selectedIds.clear();
      old.forEach(e => PlanMarkup.selectedIds.add(e.id));
      PlanMarkup.deleteSelected();
    }
    const pm = AppState.planMarkup;
    const base = PLAN_DEFS.defaults('bd_light');
    for (const [x, y] of cand.positions) {
      pm.elements.push({
        id: AppState.planGenId('pmel'), type: 'bd_light', x: x / f, y: -y / f,
        rotation: -(cand.rotate || 0), name: PlanMarkup.nextName('bd_light'), reticId: null,
        props: Object.assign({}, base, { photoId: lay.lumId, watts: Math.round(ph.watts || base.watts || 0), lumens: '', mount: 'recessed', fluxPct: 100 }),
      });
    }
    delete this.layouts[room.id];
    PlanMarkup.selectOnly(room.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ all: true });
    await this.run([room]);
  },

  layoutHtml(room) {
    this._sync();
    const lay = this.layouts[room.id];
    const libs = PhotoLib.list();
    const cur = (lay && lay.lumId) || (libs[0] && libs[0].id) || '';
    const sel = `<select data-rc-lum style="width:100%">${libs.length ? libs.map(p => `<option value="${escHtml(p.id)}"${p.id === cur ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`).join('') : '<option value="">Add a luminaire in the Luminaire library first</option>'}</select>`;
    let cards = '';
    if (lay) {
      cards = lay.cands.map((c, i) => {
        const r = c.result, ok = r.pass === true;
        return `<button type="button" data-rc-pick="${i}" style="display:block;width:100%;text-align:left;margin-top:6px;padding:8px;border-radius:8px;cursor:pointer;
            border:${i === lay.sel ? '2px solid #1d4ed8' : '1px solid var(--border,#d9dee4)'};background:${i === lay.sel ? 'rgba(29,78,216,.08)' : 'transparent'};color:inherit">
          <b style="color:${ok ? '#1d6b3a' : '#a61b1b'}">${String.fromCharCode(65 + i)} · ${c.cols} × ${c.rows} = ${c.count}${ok ? ' · passes' : ' · short'}</b><br>
          <span style="font-family:monospace;font-size:11px">${Math.round(r.Em)} lx · U₀ ${r.U0.toFixed(2)}${r.ugr != null ? ` · UGR ${r.ugr.toFixed(1)}` : ''} · ${r.wm2} W/m²</span><br>
          <span style="font-size:11px;color:var(--text-muted)">spacing ${c.spacingX} × ${c.spacingY} m</span></button>`;
      }).join('');
      cards += `<div style="display:flex;gap:6px;margin-top:8px">
        <button type="button" class="plan-circuit-btn" data-rc-place style="flex:1">Place layout ${String.fromCharCode(65 + lay.sel)}</button>
        <button type="button" class="plan-circuit-btn" data-rc-discard>Discard</button></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Layouts are checked with a coarse mesh; placing runs the full calculation.</div>`;
    }
    return `<div class="rc-layout" style="margin-top:10px;border-top:1px solid var(--border,#d9dee4);padding-top:8px">
      <div class="plan-props-title" style="font-size:13px">Auto layout</div>${sel}
      <button type="button" class="plan-circuit-btn" data-rc-suggest style="margin-top:6px">${lay ? '↻ Suggest again' : 'Suggest layouts'}</button>${cards}</div>`;
  },

  // ─── Drawing ───
  _color(v) {
    const hue = 240 - 240 * Math.max(0, Math.min(1, v));
    return `hsl(${hue}, 80%, 50%)`;
  },

  draw(ctx, zoom) {
    this._sync();
    if (typeof Light3D !== 'undefined') Light3D.drawPlan(ctx, zoom);   // objects, windows, doors from the 3D view
    if (typeof SportsCalc !== 'undefined') SportsCalc.draw(ctx, zoom, this.enabled);   // masts always; the pitch grid with the results
    if (typeof ObtrusiveCalc !== 'undefined') ObtrusiveCalc.draw(ctx, zoom);
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
      const L = room.kind === 'outdoor' && typeof AreaCalc !== 'undefined' ? AreaCalc.readArea(room) : RoomLighting.read(room);
      this._contour(ctx, g, f, L.em, zoom, false);
      this._contour(ctx, g, f, L.em * L.uo, zoom, true);
      ctx.restore();
    }
    if (typeof AreaCalc !== 'undefined') AreaCalc.draw(ctx, zoom);
    if (typeof EmergCalc !== 'undefined') EmergCalc.draw(ctx, zoom);
    this.updateLegend();
    for (const room of (pm.rooms || [])) {
      const lay = this.layouts[room.id];
      if (!lay || !lay.cands[lay.sel]) continue;
      ctx.save();
      ctx.strokeStyle = '#1d4ed8'; ctx.fillStyle = 'rgba(29,78,216,0.18)'; ctx.lineWidth = 1.5 / zoom;
      const r = Math.max(0.15 / f, 5 / zoom);
      for (const [x, y] of lay.cands[lay.sel].positions) {
        ctx.beginPath(); ctx.arc(x / f, -y / f, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  },

  // ─── Legend (over the canvas, Lighting tab only) ───
  // Each zone is coloured from 0 lx (blue) to its own maximum (red), so the
  // legend reads the selected zone — or, with none selected, the first one
  // with a result on this floor.
  _legendZone() {
    const pm = AppState.planMarkup;
    const has = (r) => {
      const a = this.results[r.id], e = this.results['em:' + r.id];
      return (a && (a.res.grid || a.res.profile || a.res.horizontal)) || (r.kind === 'escape' && e && e.res.profile);
    };
    const rooms = (pm.rooms || []).filter(has);
    const sel = rooms.find(r => PlanMarkup.selectedIds.has(r.id));
    return { zone: sel || rooms[0] || null, picked: !!sel, many: rooms.length > 1 };
  },

  updateLegend() {
    const stage = document.getElementById('plan-stage');
    if (!stage) return;
    let el = document.getElementById('plan-legend');
    const { zone, picked, many } = this.enabled ? this._legendZone() : { zone: null };
    if (!zone) { if (el) el.hidden = true; this._legendKey = ''; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'plan-legend'; el.className = 'plan-legend';
      el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Lighting legend');
      stage.appendChild(el);
    }
    const r = this.results[zone.id], e = this.results['em:' + zone.id];
    const fmt = (v) => v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
    const dot = (c, t) => `<span class="plan-legend-dot" style="background:${c}"></span>${t}`;
    let body, title;
    const name = escHtml(zone.name || 'Zone');
    if (zone.kind === 'escape') {
      title = `Escape route — ${name}`;
      body = `<div class="plan-legend-rows">${dot('#16a34a', '≥ 1 lx on the centre line')}${dot('#f59e0b', '0.5 – 1 lx')}${dot('#dc2626', 'below 0.5 lx')}</div>`;
    } else if (zone.kind === 'perimeter') {
      const L = AreaCalc.readPerim(zone);
      title = `Fence — ${name}`;
      body = `<div class="plan-legend-rows">${dot('#16a34a', `Ev ≥ ${L.evMin} lx`)}${dot('#dc2626', `below ${L.evMin} lx`)}</div>`;
    } else if (zone.kind === 'obtrusive') {
      const lim = ObtrusiveCalc.limit(zone);
      title = `Obtrusive light — ${name}`;
      body = `<div class="plan-legend-rows">${dot('#16a34a', `${lim.label} ≤ ${lim.v} ${lim.unit}`)}${dot('#dc2626', `above ${lim.v} ${lim.unit}`)}</div>`;
    } else if (zone.kind === 'sports') {
      const hz = r.res.horizontal, L = SportsCalc.read(zone);
      const top = Math.max(hz.Emax || 0, 1);
      const tick = (v, label) => v > 0 && v <= top ? `<span class="plan-legend-mark" style="left:${(v / top * 100).toFixed(1)}%" title="${escHtml(label)}"></span>` : '';
      title = `Pitch illuminance Ēh — ${name}`;
      body = `<div class="plan-legend-bar" aria-hidden="true">${tick(L.em, 'Target Ēh')}${tick(L.em * L.u2, 'Required Emin')}</div>
        <div class="plan-legend-scale"><span>0</span><span>${fmt(top / 2)}</span><span>${fmt(top)} lx</span></div>
        <small>Ēh ${fmt(hz.Eav)} lx · U₂ ${hz.U2.toFixed(2)} · target ${fmt(L.em)} lx, U₂ ${L.u2}${r.sig === this.signature(zone) ? '' : ' · out of date'}</small>`;
    } else {
      const res = r.res, wp = res.workplane || {};
      const top = Math.max(wp.Emax || 0, 1);
      const L = zone.kind === 'outdoor' ? AreaCalc.readArea(zone) : RoomLighting.read(zone);
      const tick = (v, label) => v > 0 && v <= top ? `<span class="plan-legend-mark" style="left:${(v / top * 100).toFixed(1)}%" title="${escHtml(label)}"></span>` : '';
      title = `${zone.kind === 'outdoor' ? 'Ground' : 'Work plane'} illuminance — ${name}`;
      body = `<div class="plan-legend-bar" aria-hidden="true">${tick(L.em, 'Target Ēm')}${tick(L.em * L.uo, 'Required Emin')}</div>
        <div class="plan-legend-scale"><span>0</span><span>${fmt(top / 2)}</span><span>${fmt(top)} lx</span></div>
        <div class="plan-legend-rows"><span><span class="plan-legend-line"></span>Target Ēm ${fmt(L.em)} lx</span>
          <span><span class="plan-legend-line dashed"></span>Required Emin ${fmt(L.em * L.uo)} lx</span></div>
        <small>Grid ${wp.step} m · Ēm ${fmt(wp.Em || 0)} lx · Emin ${fmt(wp.Emin || 0)} lx${r.sig === this.signature(zone) ? '' : ' · out of date'}</small>`;
    }
    const foot = many && !picked ? '<small>Each zone has its own scale — select one to read it.</small>' : '';
    const html = `<div class="plan-legend-title">${title}</div>${body}${foot}`;
    if (html !== this._legendKey) { el.innerHTML = html; this._legendKey = html; }
    el.hidden = false;
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
