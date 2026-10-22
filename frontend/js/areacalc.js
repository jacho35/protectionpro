/* ProtectionPro — Plan › Lighting for outdoor areas and perimeters.
 *
 * A room of kind 'outdoor' is a car park / yard / walkway polygon judged on
 * ground illuminance (Ēm, U₀) and glare rating GR; a room of kind 'perimeter'
 * is a fence line judged on the vertical illuminance on its face. Both are lit
 * by outdoor luminaires — Light Fittings of kind Floodlight or Area / pole
 * light, anywhere on the sheet — each with a mounting height and a tilt. The
 * answer comes from /api/analysis/area-lighting and is kept in RoomCalc.results
 * so the indoor and outdoor results share one store, stale marker and drawing.
 *
 * The task table is EN 12464-2:2024 (Table 7 traffic zones, Table 8 parking areas,
 * Table 18 storage areas): required Ēm, Uo, glare limit RGL (the `gr` field; the
 * engine's CIE 112 glare rating is compared with it) and Ra. SANS has no outdoor
 * workplace standard, so these apply whichever indoor standard the project uses.
 * Every number is editable.
 */

const OUTDOOR_TASKS = {
  car_light:    { group: 'Car parks', name: 'Light traffic (shops, apartments, cycle parks)', em: 5, uo: 0.25, gr: 55, ra: 70 },
  car_medium:   { group: 'Car parks', name: 'Medium traffic (department stores, offices, plants, sports)', em: 10, uo: 0.25, gr: 50, ra: 70 },
  car_heavy:    { group: 'Car parks', name: 'Heavy traffic (major shopping centres and sports complexes)', em: 20, uo: 0.25, gr: 50, ra: 70 },
  walk_ped:     { group: 'Walkways', name: 'Pedestrians only', em: 5, uo: 0.20, gr: 50, ra: 70 },
  yard_storage: { group: 'Yards', name: 'Storage areas with occasional traffic', em: 20, uo: 0.25, gr: 55, ra: 70 },
  yard_loading: { group: 'Yards', name: 'Mixed traffic, loading and unloading points', em: 50, uo: 0.40, gr: 50, ra: 70 },
};

const AreaCalc = {
  DEFAULT_TASK: 'car_medium',
  PERIM_DEFAULTS: { evMin: 2, evRatio: 0.25, height: 1.5, side: 'out', step: 1, mf: 0.8, closed: false },
  NOTE: 'Targets: EN 12464-2:2024, the required (not the modified) Ēm; glare limit RGL.',

  _num(v, d, lo, hi) { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; },

  readArea(room) {
    const L = (room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const task = (L.task === 'custom' || OUTDOOR_TASKS[L.task]) ? L.task : this.DEFAULT_TASK;
    const T = OUTDOOR_TASKS[task] || OUTDOOR_TASKS[this.DEFAULT_TASK];
    return {
      task, em: this._num(L.em, T.em, 0.1, 5000), uo: this._num(L.uo, T.uo, 0, 1),
      gr: this._num(L.gr, T.gr, 0, 100), ra: this._num(L.ra, T.ra, 0, 100),
      mf: this._num(L.mf, 0.8, 0.3, 1), groundRho: this._num(L.groundRho, 0.07, 0.01, 0.9),
      grid: this._num(L.grid, 0, 0, 10), edited: !!L.edited,   // grid: calculation grid (m), 0 = automatic
    };
  },
  readPerim(room) {
    const L = (room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const D = this.PERIM_DEFAULTS;
    const closed = !!L.closed;
    // A ring has an outside; an open line only has a left and a right of its travel
    // (outside = right of travel, as the engine reads it).
    let side = ['out', 'in', 'left', 'right'].includes(L.side) ? L.side : D.side;
    side = closed ? ({ right: 'out', left: 'in' }[side] || side) : ({ out: 'right', in: 'left' }[side] || side);
    return {
      evMin: this._num(L.evMin, D.evMin, 0, 1000), evRatio: this._num(L.evRatio, D.evRatio, 0, 1),
      height: this._num(L.height, D.height, 0, 10), step: this._num(L.step, D.step, 0.25, 10),
      side, mf: this._num(L.mf, D.mf, 0.3, 1), closed,
    };
  },
  read(room) { return room.kind === 'perimeter' ? this.readPerim(room) : this.readArea(room); },

  set(room, field, value) {
    const isP = room.kind === 'perimeter';
    if (!isP && field === 'task') {
      const T = OUTDOOR_TASKS[value];
      const cur = this.readArea(room);
      room.lighting = Object.assign({}, room.lighting || {}, cur, { task: value, edited: false });
      if (T) Object.assign(room.lighting, { em: T.em, uo: T.uo, gr: T.gr, ra: T.ra });
      return;
    }
    const cur = isP ? this.readPerim(room) : this.readArea(room);
    if (!(field in cur) || field === 'edited' || field === 'task') return;
    const v = (field === 'side') ? value : (field === 'closed') ? !!value : value;
    const L = Object.assign({}, room.lighting || {}, cur, { [field]: v });
    if (!isP && ['em', 'uo', 'gr', 'ra'].includes(field)) L.edited = true;
    room.lighting = L;
    const norm = isP ? this.readPerim({ lighting: L }) : this.readArea({ lighting: L });
    room.lighting = Object.assign({}, L, norm);
  },

  // ─── Luminaires ───
  _isOutdoorLight(el) {
    const def = PLAN_DEFS.element(el.type);
    if (!def || def.group !== 'Lighting') return false;
    const k = el.props && el.props.kind;
    return k === 'floodlight' || k === 'area';
  },
  luminaires(f) {
    const out = [], skipped = [];
    for (const el of AppState.planMarkup.elements) {
      if (!this._isOutdoorLight(el)) continue;
      const pr = el.props || {};
      if (!pr.photoId || !PhotoLib.get(pr.photoId)) { skipped.push(el.name || el.id); continue; }
      out.push({
        id: el.id, x: +(el.x * f).toFixed(4), y: +(-el.y * f).toFixed(4), h: Number(pr.mountH) > 0 ? Number(pr.mountH) : 8,
        rotate: -(el.rotation || 0), tilt: Number(pr.tilt) || 0, photometryId: pr.photoId,
        fluxPct: pr.fluxPct != null && pr.fluxPct !== '' ? Number(pr.fluxPct) : 100,
        lumens: Number(pr.lumens) > 0 ? Number(pr.lumens) : undefined, watts: Number(pr.watts) > 0 ? Number(pr.watts) : undefined,
      });
    }
    // sports-field floodlights light the areas and fences round them too
    if (typeof SportsCalc !== 'undefined') { const s = SportsCalc.allFloods(f); out.push(...s.lums); skipped.push(...s.skipped); }
    return { lums: out, skipped };
  },

  _areaReq(room, f) {
    const L = this.readArea(room);
    return { id: room.id, name: room.name, polygon: room.points.map(p => [p.x * f, -p.y * f]), mf: L.mf, groundRho: L.groundRho,
      gridStep: L.grid > 0 ? L.grid : undefined, targets: { em: L.em, uo: L.uo, gr: L.gr } };
  },
  _perimReq(room, f) {
    const L = this.readPerim(room);
    return { id: room.id, name: room.name, line: room.points.map(p => [p.x * f, -p.y * f]), closed: L.closed && room.points.length >= 3,
      side: L.side, height: L.height, step: L.step, mf: L.mf, targets: { evMin: L.evMin, evRatio: L.evRatio } };
  },

  signature(room) {
    const f = PlanEngine.factor();
    if (!f) return '';
    const { lums } = this.luminaires(f);
    const web = {};
    for (const l of lums) { const p = PhotoLib.get(l.photometryId); if (p) web[l.photometryId] = [p.lumens, p.watts, p.name]; }
    return JSON.stringify([room.kind === 'perimeter' ? this._perimReq(room, f) : this._areaReq(room, f), lums, web]);
  },

  async run(rooms) {
    RoomCalc._sync();
    const f = PlanEngine.factor();
    if (!f) return;
    const list = (rooms || AppState.planMarkup.rooms || []).filter(r => r.points && (r.kind === 'outdoor' || r.kind === 'perimeter'));
    if (!list.length) return;
    const { lums, skipped } = this.luminaires(f);
    const photometry = {};
    for (const l of lums) photometry[l.photometryId] = PhotoLib.get(l.photometryId);
    const areas = list.filter(r => r.kind === 'outdoor' && r.points.length >= 3);
    const perims = list.filter(r => r.kind === 'perimeter' && r.points.length >= 2);
    if (UI.setBusy) UI.setBusy(true, 'Calculating outdoor lighting…');
    let out;
    try {
      out = await API.request('/analysis/area-lighting', 'POST', {
        luminaires: lums, photometry,
        areas: areas.map(r => this._areaReq(r, f)), perimeters: perims.map(r => this._perimReq(r, f)),
      });
    } catch (e) {
      UI.alert('Outdoor lighting calculation failed: ' + (e && e.message ? e.message : e));
      return;
    } finally { if (UI.setBusy) UI.setBusy(false); }
    let pass = 0, fail = 0;
    for (const r of out.areas.concat(out.perimeters)) {
      if (r.error) { UI.toast(`${r.name}: ${r.error}`, 'warn', 6000); continue; }
      const room = list.find(x => x.id === r.id);
      RoomCalc.results[r.id] = { res: r, sig: room ? this.signature(room) : '' };
      if (r.pass === true) pass++; else if (r.pass === false) fail++;
    }
    if (!RoomCalc.quiet) UI.toast(`Outdoor lighting: ${pass} pass, ${fail} fail${skipped.length ? ` · ${skipped.length} outdoor fitting${skipped.length === 1 ? ' has' : 's have'} no library luminaire` : ''}${!lums.length ? ' · no outdoor luminaires placed (Light Fitting → Floodlight / Area light)' : ''}.`,
      fail ? 'warn' : 'success', 6000);
    PlanEngine.requestDraw({ fg: true });
    PlanMarkup.refreshProps();
  },

  // ─── Panels ───
  _num_(room, key, label, unit, step, extra, L) {
    return `<label class="plan-field"><span>${label}</span><input type="number" data-ac="${key}" value="${L[key]}" step="${step}" ${extra || ''} style="width:100%"><small>${unit}</small></label>`;
  },

  panel(room) {
    const perim = room.kind === 'perimeter';
    const L = this.read(room);
    const type = RoomLighting.typeSelect(room);
    let body;
    if (perim) {
      body = `${type}
        <label class="plan-field-check"><input type="checkbox" data-ac="closed" ${L.closed ? 'checked' : ''}> Closed ring (fence all round)</label>
        <label class="plan-field"><span>Face measured</span><select data-ac="side" style="width:100%">
          ${(L.closed ? [['out', 'Outward (away from the site)'], ['in', 'Inward (towards the site)']] : [['right', 'Right of the line as drawn'], ['left', 'Left of the line as drawn']]).map(([v, n]) => `<option value="${v}"${L.side === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <div style="font-size:11px;color:var(--text-muted);margin-top:-4px">Ticks on the plan point at the face that is measured.</div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
          ${this._num_(room, 'evMin', 'Ev min', 'lx', 0.5, 'min="0"', L)}${this._num_(room, 'evRatio', 'Min / avg', '', 0.05, 'min="0" max="1"', L)}
          ${this._num_(room, 'height', 'Height', 'm', 0.1, 'min="0"', L)}${this._num_(room, 'step', 'Spacing', 'm', 0.25, 'min="0.25"', L)}
        </div>
        ${this._num_(room, 'mf', 'Maintenance factor', '', 0.01, 'min="0.3" max="1"', L)}
        <div style="font-size:11px;color:var(--text-muted)">Site-security targets are yours to set — they are not from a table.</div>`;
    } else {
      const groups = {};
      for (const [k, t] of Object.entries(OUTDOOR_TASKS)) (groups[t.group] = groups[t.group] || []).push([k, t.name]);
      const opts = Object.entries(groups).map(([g, items]) => `<optgroup label="${escHtml(g)}">${items.map(([k, n]) => `<option value="${k}"${k === L.task ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</optgroup>`).join('')
        + `<option value="custom"${L.task === 'custom' ? ' selected' : ''}>Custom targets</option>`;
      const f = PlanEngine.factor();
      const area = f ? PlanEngine._polyArea(room.points) * f * f : null;
      body = `${type}
        <label class="plan-field"><span>Task${area != null ? ` — ${area.toFixed(0)} m²` : ''}</span><select data-ac="task" style="width:100%">${opts}</select></label>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
          ${this._num_(room, 'em', 'Ēm', 'lx', 1, 'min="0.1"', L)}${this._num_(room, 'uo', 'U₀', '', 0.05, 'min="0" max="1"', L)}
          ${this._num_(room, 'gr', 'GR limit', '', 1, 'min="0" max="100"', L)}${this._num_(room, 'groundRho', 'Ground ρ', '', 0.01, 'min="0.01" max="0.9"', L)}
        </div>
        ${this._num_(room, 'mf', 'Maintenance factor', '', 0.01, 'min="0.3" max="1"', L)}
      <label class="plan-field" style="margin-top:6px"><span>Calculation grid</span>
        <input type="number" data-ac="grid" value="${L.grid > 0 ? L.grid : ''}" step="0.1" min="0.1" max="10" placeholder="automatic" style="width:100%"><small>m — blank = automatic</small></label>
        <div style="font-size:11px;color:var(--text-muted);margin:2px 0 6px">${L.edited ? 'Edited. ' : ''}${this.NOTE} Automatic grid: the EN 12464-2 maximum for the area's size, 0.5–2 m.</div>`;
    }
    return `<div class="rl-room" data-ac-room="${escHtml(room.id)}" style="margin-top:12px;border-top:1px solid var(--border,#d9dee4);padding-top:10px">
      <div class="plan-props-title" style="font-size:13px">${perim ? 'Perimeter lighting' : 'Outdoor lighting'}</div>
      ${body}${perim ? '' : this.layoutHtml(room)}${this.resultHtml(room)}</div>`;
  },

  resultHtml(room) {
    const r = RoomCalc.results[room.id];
    const btn = `<button type="button" class="plan-circuit-btn" data-ac-run>${r ? '↻ Recalculate' : '▶ Calculate lighting'}</button>`;
    if (!r) return `<div style="margin-top:8px">${btn}</div>`;
    const res = r.res, cur = r.sig === this.signature(room);
    const rows = (res.checks || []).map(c => {
      const val = c.unit === 'lx' ? c.value.toFixed(1) : c.value.toFixed(2).replace(/\.?0+$/, '') || '0';
      const col = c.pass === true ? '#1d6b3a' : c.pass === false ? '#a61b1b' : '#616e7c';
      return `<tr><td>${escHtml(c.label)}</td><td style="text-align:right;font-family:monospace">${val}</td>
        <td style="text-align:right;color:var(--text-muted);font-family:monospace">${c.op === '>=' ? '≥' : '≤'} ${c.req}</td>
        <td style="color:${col};font-weight:600">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '—'}</td></tr>`;
    }).join('');
    const extra = res.vertical
      ? `Ev ${res.vertical.Evmin} / ${res.vertical.Evavg} / ${res.vertical.Evmax} lx (min / avg / max) · ${res.length} m`
      : `Emin ${res.workplane.Emin} / Emax ${res.workplane.Emax} lx · ${res.power.watts} W · grid ${res.workplane.step} m, ${res.workplane.n} points${res.gr ? ` · GR worst at ${res.gr.at.x.toFixed(0)}, ${res.gr.at.y.toFixed(0)} m` : ''}`;
    return `<div style="margin-top:8px">
      ${cur ? '' : '<div style="color:#8a5a00;font-size:12px;margin-bottom:4px">Out of date — the area or the outdoor luminaires changed.</div>'}
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0">${extra}</div>
      ${(res.warnings || []).concat(res.notes || []).map(w => `<div style="font-size:11px;color:#8a5a00">${escHtml(w)}</div>`).join('')}${btn}</div>`;
  },

  // ─── Pole layout ───
  layouts: {},
  layoutHtml(room) {
    if (RoomCalc._pmRef !== AppState.planMarkup) this.layouts = {};
    const lay = this.layouts[room.id];
    const libs = PhotoLib.list();
    const cur = (lay && lay.lumId) || (libs.find(p => p.group === 'outdoor' || /area|flood/i.test(p.name)) || libs[0] || {}).id || '';
    const h = lay ? lay.h : 8, tilt = lay ? lay.tilt : 0;
    const cards = lay ? lay.cands.map((c, i) => {
      const r = c.result, ok = r.pass === true;
      return `<button type="button" data-ac-pick="${i}" style="display:block;width:100%;text-align:left;margin-top:6px;padding:8px;border-radius:8px;cursor:pointer;color:inherit;
          border:${i === lay.sel ? '2px solid #1d4ed8' : '1px solid var(--border,#d9dee4)'};background:${i === lay.sel ? 'rgba(29,78,216,.08)' : 'transparent'}">
        <b style="color:${ok ? '#1d6b3a' : '#a61b1b'}">${String.fromCharCode(65 + i)} · ${c.cols} × ${c.rows} = ${c.count} poles${ok ? ' · passes' : ' · short'}</b><br>
        <span style="font-family:monospace;font-size:11px">${r.Em.toFixed(1)} lx · U₀ ${r.U0.toFixed(2)}${r.gr != null ? ` · GR ${r.gr.toFixed(0)}` : ''} · ${r.wm2} W/m²</span><br>
        <span style="font-size:11px;color:var(--text-muted)">spacing ${c.spacingX} × ${c.spacingY} m</span></button>`;
    }).join('') + `<div style="display:flex;gap:6px;margin-top:8px"><button type="button" class="plan-circuit-btn" data-ac-place style="flex:1">Place layout ${String.fromCharCode(65 + lay.sel)}</button>
      <button type="button" class="plan-circuit-btn" data-ac-discard>Discard</button></div>` : '';
    return `<div style="margin-top:10px;border-top:1px solid var(--border,#d9dee4);padding-top:8px">
      <div class="plan-props-title" style="font-size:13px">Pole layout</div>
      <select data-ac-lum style="width:100%">${libs.length ? libs.map(p => `<option value="${escHtml(p.id)}"${p.id === cur ? ' selected' : ''}>${escHtml(PhotoLib.label(p))}</option>`).join('') : '<option value="">Add a luminaire in the Luminaire library first</option>'}</select>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:4px">
        <label class="plan-field"><span>Pole height (m)</span><input type="number" data-ac-h value="${h}" min="3" step="0.5"></label>
        <label class="plan-field"><span>Tilt (°)</span><input type="number" data-ac-tilt value="${tilt}" min="-45" max="90" step="5"></label></div>
      <button type="button" class="plan-circuit-btn" data-ac-suggest style="margin-top:6px">${lay ? '↻ Suggest again' : 'Suggest poles'}</button>${cards}</div>`;
  },

  async suggest(room, lumId, h, tilt) {
    const f = PlanEngine.factor();
    const ph = PhotoLib.get(lumId);
    if (!f) { UI.alert('Calibrate the plan first.'); return; }
    if (!ph) { UI.toast('Pick a luminaire from the library first (Luminaire library on the Lighting tab).', 'info'); return; }
    if (UI.setBusy) UI.setBusy(true, 'Finding pole layouts…');
    try {
      const out = await API.request('/analysis/area-lighting/layout', 'POST', {
        area: this._areaReq(room, f), photometry: { [lumId]: ph }, photometryId: lumId, h, tilt, fluxPct: 100,
      });
      this.layouts[room.id] = { lumId, cands: out.candidates, sel: 0, h, tilt };
    } catch (e) {
      UI.alert('Could not suggest poles: ' + (e && e.message ? e.message : e));
      delete this.layouts[room.id];
    } finally { if (UI.setBusy) UI.setBusy(false); }
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },

  async place(room) {
    const lay = this.layouts[room.id], f = PlanEngine.factor();
    if (!lay || !f) return;
    const cand = lay.cands[lay.sel], ph = PhotoLib.get(lay.lumId);
    if (!cand || !ph) return;
    const old = AppState.planMarkup.elements.filter(el => this._isOutdoorLight(el) && PlanEngine._pointInPoly({ x: el.x, y: el.y }, room.points));
    if (old.length) {
      const ok = await UI.confirm(`Replace the ${old.length} outdoor luminaire${old.length === 1 ? '' : 's'} already inside ${room.name || 'this area'}?`, { okText: 'Replace', cancelText: 'Cancel' });
      if (!ok) return;
      PlanMarkup.selectedIds.clear(); old.forEach(e => PlanMarkup.selectedIds.add(e.id));
      PlanMarkup.deleteSelected();
    }
    const pm = AppState.planMarkup, base = PLAN_DEFS.defaults('bd_light');
    for (const l of cand.luminaires) {
      pm.elements.push({
        id: AppState.planGenId('pmel'), type: 'bd_light', x: l.x / f, y: -l.y / f, rotation: -l.rotate,
        name: PlanMarkup.nextName('bd_light'), reticId: null,
        props: Object.assign({}, base, { kind: 'area', photoId: lay.lumId, watts: Math.round(ph.watts || 0), lumens: '', mountH: cand.mountH, tilt: cand.tilt, fluxPct: 100 }),
      });
    }
    delete this.layouts[room.id];
    PlanMarkup.selectOnly(room.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ all: true });
    await this.run([room]);
  },

  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    const roomOf = () => {
      const w = propsEl.querySelector('[data-ac-room]');
      return w && (AppState.planMarkup.rooms || []).find(r => r.id === w.dataset.acRoom);
    };
    propsEl.addEventListener('change', (e) => {
      const t = e.target, room = roomOf();
      if (!room || !t.dataset) return;
      if (t.dataset.ac) {
        this.set(room, t.dataset.ac, t.type === 'checkbox' ? t.checked : t.value);
        PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
      } else if ('acH' in t.dataset || 'acTilt' in t.dataset) {
        const lay = this.layouts[room.id];
        if (lay) { if ('acH' in t.dataset) lay.h = parseFloat(t.value) || lay.h; else lay.tilt = parseFloat(t.value) || 0; }
      }
    });
    propsEl.addEventListener('click', (e) => {
      const room = roomOf();
      if (!room) return;
      const lay = this.layouts[room.id];
      if (e.target.closest('[data-ac-run]')) this.run([room]);
      else if (e.target.closest('[data-ac-suggest]')) {
        const v = (sel) => propsEl.querySelector(sel);
        this.suggest(room, v('[data-ac-lum]').value, Math.max(3, parseFloat(v('[data-ac-h]').value) || 8), parseFloat(v('[data-ac-tilt]').value) || 0);
      } else if (e.target.closest('[data-ac-pick]') && lay) {
        lay.sel = +e.target.closest('[data-ac-pick]').dataset.acPick; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
      } else if (e.target.closest('[data-ac-place]')) this.place(room);
      else if (e.target.closest('[data-ac-discard]')) { delete this.layouts[room.id]; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
    });
  },

  // Ticks every ~5 m on the face of the fence that the calculation measures.
  _drawFace(ctx, room, zoom, f) {
    if (!room.points || room.points.length < 2 || !(this._selected(room) || RoomCalc.results[room.id])) return;
    const L = this.readPerim(room);
    let P = room.points.map(p => ({ x: p.x * f, y: -p.y * f }));         // metres, y up (the engine's frame)
    const closed = L.closed && P.length >= 3;
    if (closed) {
      let a = 0;
      for (let i = 0; i < P.length; i++) { const q = P[i], r = P[(i + 1) % P.length]; a += q.x * r.y - r.x * q.y; }
      if (a < 0) P = P.slice().reverse();
    }
    const left = (L.side === 'left' || L.side === 'in');
    ctx.save();
    ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5 / zoom;
    const n = P.length, segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
      let nx = -ty, ny = tx;                       // left of travel (y up)
      if (!left) { nx = -nx; ny = -ny; }
      const k = Math.max(1, Math.round(len / 5));
      for (let j = 0; j < k; j++) {
        const u = (j + 0.5) / k;
        const x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u, tick = 1.2;
        ctx.beginPath();
        ctx.moveTo(x / f, -y / f); ctx.lineTo((x + nx * tick) / f, -(y + ny * tick) / f);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
  _selected(room) { return typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds && PlanMarkup.selectedIds.has(room.id); },

  // ─── Drawing (perimeter samples + pole ghosts); area grids are drawn by RoomCalc ───
  draw(ctx, zoom) {
    const f = PlanEngine.factor();
    if (!f) return;
    for (const room of (AppState.planMarkup.rooms || [])) {
      const r = RoomCalc.results[room.id];
      if (room.kind === 'perimeter') this._drawFace(ctx, room, zoom, f);
      if (room.kind === 'perimeter' && r && r.res.profile) {
        const L = this.readPerim(room);
        ctx.save();
        const rad = Math.max(2.5 / zoom, 0.12 / f);
        for (const q of r.res.profile) {
          ctx.fillStyle = q.E >= L.evMin ? '#16a34a' : '#dc2626';
          ctx.beginPath(); ctx.arc(q.x / f, -q.y / f, rad, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      const lay = this.layouts[room.id];
      if (lay && lay.cands[lay.sel]) {
        ctx.save();
        ctx.strokeStyle = '#1d4ed8'; ctx.fillStyle = 'rgba(29,78,216,0.2)'; ctx.lineWidth = 1.5 / zoom;
        const rr = Math.max(0.3 / f, 5 / zoom);
        for (const l of lay.cands[lay.sel].luminaires) { ctx.beginPath(); ctx.arc(l.x / f, -l.y / f, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        ctx.restore();
      }
    }
  },
};
