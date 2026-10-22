/* ProtectionPro — Plan › Lighting: emergency lighting (EN 1838 / SANS 10114-2).
 *
 * An escape route is a drawn line with a width (room kind 'escape'); a room can
 * be checked as an open (anti-panic) area or a high-risk task area from its
 * panel. The luminaires that count are the Light Fittings in emergency mode: kind
 * Emergency (full output unless set) or any fitting with an Emergency output %.
 * Only direct light on the floor counts, and a luminaire lights only the room it
 * is in. Results sit in RoomCalc.results under 'em:<id>'.
 *
 * The limits follow the project's lighting standard (RoomLighting.standard()):
 * EN 1838:1999 (1 lx centre line, 0.5 lx central band, 0.5 lx open area with a
 * 0.5 m border left out, 40:1, 10 % but ≥ 15 lx for high risk) or SANS 10114-2:2020
 * (1 lx centre line, no band, 1 lx open area to the perimeter, 40:1, 10 % or
 * 20 lx whichever is greater). The engine holds the numbers (emergency_lighting.py).
 */

const EmergCalc = {
  note() {
    const S = LIGHTING_STANDARDS[RoomLighting.standard()];
    return `Limits: ${S.emerg}.`;
  },

  _pct(el) {
    const pr = el.props || {};
    const p = Number(pr.emergPct);
    if (p > 0) return p;
    return pr.kind === 'emergency' ? 100 : 0;
  },
  _isEm(el) {
    const def = PLAN_DEFS.element(el.type);
    return !!def && def.group === 'Lighting' && this._pct(el) > 0;
  },
  _lum(el, f, h) {
    const pr = el.props || {};
    return { id: el.id, x: +(el.x * f).toFixed(4), y: +(-el.y * f).toFixed(4), h, photometryId: pr.photoId, emergPct: this._pct(el),
      lumens: Number(pr.lumens) > 0 ? Number(pr.lumens) : undefined };
  },

  _roomAt(pt) {
    const rooms = (AppState.planMarkup.rooms || []).filter(r => (!r.kind || r.kind === 'room') && r.points.length >= 3);
    for (let i = rooms.length - 1; i >= 0; i--) if (PlanEngine._pointInPoly(pt, rooms[i].points)) return rooms[i];
    return null;
  },

  // Request item for a room (open / highrisk) or an escape route.
  item(room, f) {
    const pm = AppState.planMarkup;
    const missing = [];
    const pick = (els, h) => els.filter(el => {
      if (!el.props || !el.props.photoId || !PhotoLib.get(el.props.photoId)) { missing.push(el.name || el.id); return false; }
      return true;
    }).map(el => this._lum(el, f, h));
    if (room.kind === 'escape') {
      const L = this.readRoute(room);
      const mid = room.points[Math.floor(room.points.length / 2)];
      const host = this._roomAt({ x: (room.points[0].x + mid.x) / 2, y: (room.points[0].y + mid.y) / 2 }) || this._roomAt(mid);
      let els, h = 2.7, bounds;
      if (host) {
        h = RoomLighting.read(host).ceilH;
        els = pm.elements.filter(el => this._isEm(el) && PlanEngine._pointInPoly({ x: el.x, y: el.y }, host.points));
        bounds = host.points.map(p => [p.x * f, -p.y * f]);
      } else {
        const reach = 8 / f;
        els = pm.elements.filter(el => this._isEm(el) && room.points.some(p => Math.hypot(p.x - el.x, p.y - el.y) <= reach));
      }
      return { req: { id: room.id, name: room.name, type: 'route', standard: RoomLighting.standard(), line: room.points.map(p => [p.x * f, -p.y * f]), width: L.width, mf: L.mf,
        luminaires: pick(els, h), bounds }, missing };
    }
    const R = RoomLighting.read(room);
    const els = pm.elements.filter(el => this._isEm(el) && PlanEngine._pointInPoly({ x: el.x, y: el.y }, room.points));
    return { req: { id: room.id, name: room.name, standard: RoomLighting.standard(), type: R.emerg === 'highrisk' ? 'highrisk' : 'open', polygon: room.points.map(p => [p.x * f, -p.y * f]),
      taskE: R.em, mf: R.mf, luminaires: pick(els, R.ceilH), bounds: room.points.map(p => [p.x * f, -p.y * f]) }, missing };
  },

  readRoute(room) {
    const L = (room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const n = (v, d, lo, hi) => { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
    return { width: n(L.width, 1.2, 0.3, 20), mf: n(L.mf, 0.8, 0.3, 1) };
  },
  setRoute(room, field, value) {
    const cur = this.readRoute(room);
    if (!(field in cur)) return;
    room.lighting = Object.assign({}, room.lighting || {}, cur, { [field]: value });
    room.lighting = Object.assign({}, room.lighting, this.readRoute(room));
  },

  signature(room) {
    const f = PlanEngine.factor();
    if (!f) return '';
    const { req } = this.item(room, f);
    const web = {};
    for (const l of req.luminaires) { const p = PhotoLib.get(l.photometryId); if (p) web[l.photometryId] = [p.lumens, p.name]; }
    return JSON.stringify([req, web]);
  },

  async run(rooms) {
    RoomCalc._sync();
    const f = PlanEngine.factor();
    if (!f) { UI.alert('Calibrate the plan first.'); return; }
    const all = AppState.planMarkup.rooms || [];
    const list = (rooms || all).filter(r => r.points && ((r.kind === 'escape' && r.points.length >= 2) ||
      ((!r.kind || r.kind === 'room') && r.points.length >= 3 && RoomLighting.read(r).emerg !== 'none')));
    if (!list.length) return;
    const built = list.map(r => ({ room: r, ...this.item(r, f) }));
    const photometry = {};
    for (const b of built) for (const l of b.req.luminaires) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    if (UI.setBusy) UI.setBusy(true, 'Checking emergency lighting…');
    let out;
    try {
      out = await API.request('/analysis/emergency-lighting', 'POST', { items: built.map(b => b.req), photometry });
    } catch (e) {
      UI.alert('Emergency lighting check failed: ' + (e && e.message ? e.message : e));
      return;
    } finally { if (UI.setBusy) UI.setBusy(false); }
    let pass = 0, fail = 0;
    for (const r of out.items) {
      if (r.error) { UI.toast(`${r.name}: ${r.error}`, 'warn', 6000); continue; }
      const b = built.find(x => x.room.id === r.id);
      RoomCalc.results['em:' + r.id] = { res: r, sig: b ? this.signature(b.room) : '' };
      if (r.pass) pass++; else fail++;
    }
    if (!RoomCalc.quiet) UI.toast(`Emergency lighting: ${pass} pass, ${fail} fail.`, fail ? 'warn' : 'success', 5000);
    PlanEngine.requestDraw({ fg: true });
    PlanMarkup.refreshProps();
  },

  _fmt(c) {
    if (c.value == null) return '—';
    return c.unit === ':1' ? (c.value >= 1e8 ? '∞' : c.value.toFixed(0)) : c.value.toFixed(2);
  },

  resultHtml(room, label) {
    const r = RoomCalc.results['em:' + room.id];
    const btn = `<button type="button" class="plan-circuit-btn" data-em-run>${r ? '↻ Recheck emergency' : label || '▶ Check emergency lighting'}</button>`;
    if (!r) return `<div style="margin-top:6px">${btn}</div>`;
    const res = r.res, cur = r.sig === this.signature(room);
    const rows = (res.checks || []).map(c => {
      const col = c.pass === true ? '#1d6b3a' : c.pass === false ? '#a61b1b' : '#616e7c';
      return `<tr><td>${escHtml(c.label)}</td><td style="text-align:right;font-family:monospace">${this._fmt(c)}</td>
        <td style="text-align:right;color:var(--text-muted);font-family:monospace">${c.op === '>=' ? '≥' : '≤'} ${c.req}${c.unit === ':1' ? ':1' : ''}</td>
        <td style="color:${col};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    }).join('');
    return `<div style="margin-top:6px">${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:4px 0">${res.luminaires} emergency luminaire${res.luminaires === 1 ? '' : 's'}${res.required ? ` · needs ${res.required} lx` : ''}</div>
      ${(res.notes || []).map(w => `<div style="font-size:11px;color:#8a5a00">${escHtml(w)}</div>`).join('')}${btn}</div>`;
  },

  // Section inside an indoor room's panel.
  roomSection(room) {
    const R = RoomLighting.read(room);
    return `<div style="margin-top:10px;border-top:1px solid var(--border,#d9dee4);padding-top:8px">
      <div class="plan-props-title" style="font-size:13px">Emergency lighting</div>
      <label class="plan-field"><span>Treat this room as</span><select data-rl="emerg" style="width:100%">
        <option value="none"${R.emerg === 'none' ? ' selected' : ''}>Not checked</option>
        <option value="open"${R.emerg === 'open' ? ' selected' : ''}>Open area (anti-panic)</option>
        <option value="highrisk"${R.emerg === 'highrisk' ? ' selected' : ''}>High-risk task area</option></select></label>
      ${R.emerg !== 'none' ? this.resultHtml(room) : ''}
      <div style="font-size:11px;color:var(--text-muted)">${this.note()} Fittings count with an Emergency output % or kind Emergency.</div></div>`;
  },

  // Panel for an escape route (room kind 'escape').
  routePanel(room) {
    const L = this.readRoute(room);
    const f = PlanEngine.factor();
    return `<div class="rl-room" data-em-room="${escHtml(room.id)}" style="margin-top:12px;border-top:1px solid var(--border,#d9dee4);padding-top:10px">
      <div class="plan-props-title" style="font-size:13px">Escape route${f ? ` — ${(PlanEngine._polyLen(room.points) * f).toFixed(0)} m` : ''}</div>
      ${RoomLighting.typeSelect(room)}
      ${RoomLighting.standardSelect()}
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        <label class="plan-field"><span>Width (m)</span><input type="number" data-em="width" value="${L.width}" min="0.3" max="20" step="0.1"></label>
        <label class="plan-field"><span>Maintenance factor</span><input type="number" data-em="mf" value="${L.mf}" min="0.3" max="1" step="0.01"></label></div>
      ${this.resultHtml(room)}
      <div style="font-size:11px;color:var(--text-muted)">${this.note()}</div></div>`;
  },

  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    const roomOf = () => {
      const w = propsEl.querySelector('[data-em-room], [data-rl-room]');
      return w && (AppState.planMarkup.rooms || []).find(r => r.id === (w.dataset.emRoom || w.dataset.rlRoom));
    };
    propsEl.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.dataset || !('em' in t.dataset)) return;
      const room = roomOf();
      if (!room) return;
      this.setRoute(room, t.dataset.em, t.value);
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    });
    propsEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-em-run]')) return;
      const room = roomOf();
      if (room) this.run([room]);
    });
  },

  draw(ctx, zoom) {
    const f = PlanEngine.factor();
    if (!f) return;
    for (const room of (AppState.planMarkup.rooms || [])) {
      if (room.kind !== 'escape') continue;
      const r = RoomCalc.results['em:' + room.id];
      if (!r || !r.res.profile) continue;
      ctx.save();
      const rad = Math.max(2.5 / zoom, 0.1 / f);
      for (const q of r.res.profile) {
        ctx.fillStyle = q.E >= 1 ? '#16a34a' : q.E >= 0.5 ? '#f59e0b' : '#dc2626';
        ctx.beginPath(); ctx.arc(q.x / f, -q.y / f, rad, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  },
};
