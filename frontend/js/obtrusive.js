/* ProtectionPro — Lighting › Obtrusive light (EN 12464-2:2024 §5.5).
 *
 * A check line drawn on the Lighting tab (zone kind 'obtrusive'): a property
 * boundary, a row of windows or a facade — vertical illuminance Ev on the face
 * turned towards the installation, the luminous intensity of each luminaire
 * towards it, the facade luminance — or a road, where drivers' threshold
 * increment TI is checked. Limits come from the environmental zone E0–E4,
 * pre- or post-curfew (Table 4 / Table 5); the installation's upward light
 * ratio RUL is checked with each property line. Every outdoor luminaire on the
 * floor counts: poles, floodlights and sports-field floods (AreaCalc.luminaires).
 *
 * Calculated on the initial flux (no maintenance factor). Results live in
 * RoomCalc.results like the other lighting zones.
 */

const OBTRUSIVE_ZONES = {
  E0: { name: 'E0 — intrinsically dark (dark-sky parks, observatories)', ev: [0, 0], i: [0, 0], rul: 0, lb: 0.1 },
  E1: { name: 'E1 — dark (national parks, protected sites)', ev: [2, 0], i: [2500, 0], rul: 0, lb: 0.1 },
  E2: { name: 'E2 — low district brightness (rural)', ev: [5, 1], i: [7500, 500], rul: 2.5, lb: 5 },
  E3: { name: 'E3 — medium district brightness (suburbs)', ev: [10, 2], i: [10000, 1000], rul: 5, lb: 10 },
  E4: { name: 'E4 — high district brightness (town centres)', ev: [25, 5], i: [25000, 2500], rul: 15, lb: 25 },
};

const ObtrusiveCalc = {
  ROAD_CLASSES: [['none', 'No road lighting (La 0.1 cd/m²)'], ['M5', 'M5 (La 1 cd/m²)'], ['M4', 'M4 (La 2 cd/m²)'], ['M3', 'M3 (La 2 cd/m²)'], ['M2', 'M2 (La 5 cd/m²)'], ['M1', 'M1 (La 5 cd/m²)']],

  _num(v, d, lo, hi) { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; },

  read(room) {
    const L = (room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const closed = !!L.closed;
    let side = ['in', 'out', 'left', 'right'].includes(L.side) ? L.side : 'in';
    side = closed ? ({ left: 'in', right: 'out' }[side] || side) : ({ in: 'left', out: 'right' }[side] || side);
    const heights = String(L.heights != null ? L.heights : '1.5').split(/[,;\s]+/).map(Number).filter(h => Number.isFinite(h) && h >= 0 && h <= 200);
    return {
      check: L.check === 'road' ? 'road' : 'property', zone: OBTRUSIVE_ZONES[L.zone] ? L.zone : 'E3', curfew: L.curfew === 'post' ? 'post' : 'pre',
      postPct: this._num(L.postPct, 100, 0, 100), heights: heights.length ? heights : [1.5], step: this._num(L.step, 2, 0.25, 50),
      side, closed, facadeRho: this._num(L.facadeRho, 0, 0, 1), roadClass: this.ROAD_CLASSES.some(([k]) => k === L.roadClass) ? L.roadClass : 'none',
    };
  },
  set(room, field, value) {
    if (!room.lighting || typeof room.lighting !== 'object') room.lighting = {};
    const L = room.lighting;
    if (field === 'heights') L.heights = String(value);
    else if (field === 'closed') L.closed = !!value;
    else L[field] = value;
    const n = this.read(room);
    Object.assign(L, { check: n.check, zone: n.zone, curfew: n.curfew, postPct: n.postPct, step: n.step, side: n.side, closed: n.closed, facadeRho: n.facadeRho, roadClass: n.roadClass, heights: n.heights.join(', ') });
  },
  // The limit the plan's dots and the table compare against.
  limit(room) {
    const L = this.read(room), Z = OBTRUSIVE_ZONES[L.zone];
    return L.check === 'road' ? { v: 15, unit: '%', label: 'TI' } : { v: Z.ev[L.curfew === 'post' ? 1 : 0], unit: 'lx', label: 'Ev' };
  },

  _req(room, f) {
    const L = this.read(room);
    return {
      id: room.id, name: room.name || 'Check', kind: L.check, line: room.points.map(p => [+(p.x * f).toFixed(4), +(-p.y * f).toFixed(4)]),
      closed: L.closed && room.points.length >= 3, side: L.side, heights: L.heights, step: L.step, zone: L.zone, curfew: L.curfew,
      postPct: L.postPct, facadeRho: L.facadeRho, roadClass: L.roadClass,
    };
  },
  signature(room) {
    const f = PlanEngine.factor();
    if (!f) return '';
    const { lums } = AreaCalc.luminaires(f);
    const web = {};
    for (const l of lums) { const p = PhotoLib.get(l.photometryId); if (p) web[l.photometryId] = [p.lumens, p.watts, p.name]; }
    return JSON.stringify([this._req(room, f), lums, web]);
  },

  async run(rooms) {
    RoomCalc._sync();
    const f = PlanEngine.factor();
    if (!f) { if (rooms) UI.alert('Calibrate the plan first — the calculation needs real distances.'); return; }
    const list = (rooms || AppState.planMarkup.rooms || []).filter(r => r.kind === 'obtrusive' && r.points && r.points.length >= 2);
    if (!list.length) return;
    const { lums } = AreaCalc.luminaires(f);
    const photometry = {};
    for (const l of lums) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    RoomCalc.busy(true, 'Calculating obtrusive light…');
    let out;
    try {
      out = await API.request('/analysis/obtrusive-light', 'POST', { luminaires: lums, photometry, checks: list.map(r => this._req(r, f)) });
    } catch (e) {
      RoomCalc.fail('Obtrusive light calculation failed: ' + (e && e.message ? e.message : e));
      return;
    } finally { RoomCalc.busy(false); }
    let pass = 0, fail = 0;
    for (const r of out.checks) {
      if (r.error) { UI.toast(r.error, 'warn', 6000); continue; }
      const room = list.find(x => x.id === r.id);
      RoomCalc.results[r.id] = { res: r, sig: room ? this.signature(room) : '' };
      if (r.pass === true) pass++; else if (r.pass === false) fail++;
    }
    if (!RoomCalc.quiet) UI.toast(`Obtrusive light: ${pass} pass, ${fail} fail · installation RUL ${out.rul.rul.toFixed(2)} %${!lums.length ? ' · no outdoor luminaires placed' : ''}.`, fail ? 'warn' : 'success', 6000);
    PlanEngine.requestDraw({ fg: true });
    PlanMarkup.refreshProps();
  },

  // ─── Properties panel ───
  panel(room) {
    const L = this.read(room), Z = OBTRUSIVE_ZONES[L.zone], road = L.check === 'road';
    const sel = (k, opts, cur) => `<select data-ob="${k}" style="width:100%">${opts.map(([v, n]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select>`;
    const num = (k, label, unit, step, extra) => `<label class="plan-field"><span>${label}</span><input type="number" data-ob="${k}" value="${escHtml(L[k])}" step="${step}" ${extra || ''} style="width:100%"><small>${unit}</small></label>`;
    const j = L.curfew === 'post' ? 1 : 0;
    const body = road ? `
        <label class="plan-field"><span>Road lighting class</span>${sel('roadClass', this.ROAD_CLASSES, L.roadClass)}</label>
        ${num('step', 'Observer spacing', 'm', 1, 'min="0.5"')}
        <div class="sf-note">Drivers on the line, eye 1.5 m, looking along it both ways (1° down, 20° car-roof screen). TI ≤ 15 % at the road class's adaptation luminance (EN 12464-2 Table 5).</div>`
      : `
        <label class="plan-field-check"><input type="checkbox" data-ob="closed" ${L.closed ? 'checked' : ''}> Closed ring (site boundary all round)</label>
        <label class="plan-field"><span>Face measured</span>${sel('side', L.closed ? [['in', 'Facing in (towards the site)'], ['out', 'Facing out']] : [['left', 'Left of the line as drawn'], ['right', 'Right of the line as drawn']], L.side)}</label>
        <div class="sf-note" style="margin-top:-4px">Turn the face towards the lighting. Ticks on the plan point the way it faces.</div>
        <label class="plan-field"><span>Heights</span><input type="text" data-ob="heights" value="${escHtml(L.heights.join(', '))}" style="width:100%"><small>m — e.g. window sills of each floor: 1.5, 4.5, 7.5</small></label>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
          ${num('step', 'Spacing', 'm', 0.5, 'min="0.25"')}${num('facadeRho', 'Facade ρ', '0 = not a facade', 0.05, 'min="0" max="1"')}
        </div>`;
    return `<div class="rl-room" data-ob-room="${escHtml(room.id)}" style="margin-top:12px;border-top:1px solid var(--border,#d9dee4);padding-top:10px">
      <div class="plan-props-title" style="font-size:13px">Obtrusive light</div>
      ${RoomLighting.typeSelect(room)}
      <label class="plan-field"><span>Check</span>${sel('check', [['property', 'Property — boundary, windows or facade'], ['road', 'Road — glare to drivers (TI)']], L.check)}</label>
      <label class="plan-field"><span>Environmental zone</span>${sel('zone', Object.entries(OBTRUSIVE_ZONES).map(([k, z]) => [k, z.name]), L.zone)}</label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        <label class="plan-field"><span>Assess</span>${sel('curfew', [['pre', 'Pre-curfew'], ['post', 'Post-curfew']], L.curfew)}</label>
        ${L.curfew === 'post' ? num('postPct', 'Output after curfew', '% of full (0 = off)', 5, 'min="0" max="100"') : '<span></span>'}
      </div>
      ${road ? '' : `<div class="sf-note">${escHtml(L.zone)} ${L.curfew}-curfew limits: Ev ≤ ${Z.ev[j]} lx · I ≤ ${Z.i[j].toLocaleString()} cd · RUL ≤ ${Z.rul} % · facade Lb ≤ ${Z.lb} cd/m² (EN 12464-2:2024 Table 4). Initial flux, no maintenance factor.</div>`}
      ${body}
      ${this.resultHtml(room)}
    </div>`;
  },

  resultHtml(room) {
    const r = RoomCalc.results[room.id];
    const btn = `<button type="button" class="plan-circuit-btn" data-ob-run>${r ? '↻ Recalculate' : '▶ Calculate'}</button>`;
    if (!r) return `<div class="sf-sec">${btn}</div>`;
    const res = r.res, cur = r.sig === this.signature(room);
    const rows = (res.checks || []).map(c => {
      const val = c.unit === 'cd' ? Math.round(c.value).toLocaleString() : c.value.toFixed(c.unit === 'lx' || c.unit === 'cd/m²' ? 2 : c.unit === '%' ? 2 : 1);
      const col = c.pass === true ? '#1d6b3a' : c.pass === false ? '#a61b1b' : '#616e7c';
      return `<tr><td>${escHtml(c.label)}</td><td style="text-align:right;font-family:monospace">${val}</td>
        <td style="text-align:right;color:var(--text-muted);font-family:monospace">≤ ${c.unit === 'cd' ? c.req.toLocaleString() : c.req} ${escHtml(c.unit)}</td>
        <td style="color:${col};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    }).join('');
    const extra = res.kind === 'road'
      ? `Worst TI at ${res.TIat ? res.TIat.x.toFixed(0) + ', ' + res.TIat.y.toFixed(0) : '—'} m · La ${res.La} cd/m² · ${res.length} m`
      : `Ev max at ${res.Evat.x.toFixed(0)}, ${res.Evat.y.toFixed(0)} m, ${res.Evat.z} m high · I max ${Math.round(res.Imax).toLocaleString()} cd${res.Ifrom ? ` from ${escHtml(String(res.Ifrom).split('/').slice(-2).join(' '))}` : ''} · RUL worst luminaire ${res.rul.worst.toFixed(1)} %`;
    return `<div class="sf-sec">
      ${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date — the line or the outdoor luminaires changed.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0">${extra}</div>
      ${(res.warnings || []).concat(res.notes || []).map(w => `<div style="font-size:11px;color:#8a5a00">${escHtml(w)}</div>`).join('')}${btn}</div>`;
  },

  _bound: false,
  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    const roomOf = () => {
      const w = propsEl.querySelector('[data-ob-room]');
      return w && (AppState.planMarkup.rooms || []).find(r => r.id === w.dataset.obRoom);
    };
    propsEl.addEventListener('change', (e) => {
      const t = e.target, room = roomOf();
      if (!room || !t.dataset || !t.dataset.ob) return;
      this.set(room, t.dataset.ob, t.type === 'checkbox' ? t.checked : t.value);
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    });
    propsEl.addEventListener('click', (e) => {
      const room = roomOf();
      if (room && e.target.closest('[data-ob-run]')) this.run([room]);
    });
  },

  // ─── On the plan: ticks on the measured face, the result along the line ───
  draw(ctx, zoom) {
    const f = PlanEngine.factor();
    if (!f) return;
    for (const room of (AppState.planMarkup.rooms || [])) {
      if (room.kind !== 'obtrusive' || !room.points || room.points.length < 2) continue;
      const L = this.read(room), r = RoomCalc.results[room.id];
      if (L.check === 'property') {
        let P = room.points.map(p => ({ x: p.x * f, y: -p.y * f }));
        const closed = L.closed && P.length >= 3;
        if (closed) {
          let a = 0;
          for (let i = 0; i < P.length; i++) { const q = P[i], s = P[(i + 1) % P.length]; a += q.x * s.y - s.x * q.y; }
          if (a < 0) P = P.slice().reverse();
        }
        const left = L.side === 'left' || L.side === 'in';
        ctx.save(); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.5 / zoom;
        const n = P.length, segs = closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const a = P[i], b = P[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len < 1e-6) continue;
          let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
          if (!left) { nx = -nx; ny = -ny; }
          const k = Math.max(1, Math.round(len / 5));
          for (let j = 0; j < k; j++) {
            const u = (j + 0.5) / k, x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u;
            ctx.beginPath(); ctx.moveTo(x / f, -y / f); ctx.lineTo((x + nx * 1.2) / f, -(y + ny * 1.2) / f); ctx.stroke();
          }
        }
        ctx.restore();
      }
      if (r && r.res.profile) {
        const lim = this.limit(room).v;
        ctx.save();
        const rad = Math.max(2.5 / zoom, 0.12 / f);
        for (const q of r.res.profile) {
          ctx.fillStyle = q.E <= lim + 1e-9 ? '#16a34a' : '#dc2626';
          ctx.beginPath(); ctx.arc(q.x / f, -q.y / f, rad, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }
  },
};
