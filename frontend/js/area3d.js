/* ProtectionPro — Lighting tab › 3D for an outdoor area or a fence (kinds 'outdoor' / 'perimeter').
 *
 * Light3D hands these to this module instead of extruding them like a room:
 *   • an outdoor area is a flat ground polygon on an apron; a fence is its line
 *     with a wall, the measured face and the Ev samples along it;
 *   • every outdoor luminaire on the sheet (AreaCalc.luminaires — poles, area
 *     lights, floodlights, sports floods) stands on a pole at its mounting height,
 *     the head turned to its heading and tilt, with Light cones to the ground;
 *   • Show: Model, False colour (ground Em grid / Ev along the fence) or
 *     Rendered light (the ground as bright as it looks, ρE/π, at night).
 * A pole drags across the ground; the plan follows (the luminaire's own x, y).
 */

const Area3D = {
  SEL: '#0078d7',
  FENCE_H: 2.4,

  is(room) { return !!room && (room.kind === 'outdoor' || room.kind === 'perimeter'); },

  _pts(room, f) { return (room.points || []).map(p => [p.x * f, -p.y * f]); },
  // Every outdoor luminaire drawn — also one with no library luminaire yet (the
  // calculation skips it, the picture shouldn't) — plus the sports-field floods.
  _lums(f) {
    const out = [];
    for (const el of AppState.planMarkup.elements || []) {
      if (!AreaCalc._isOutdoorLight(el)) continue;
      const pr = el.props || {};
      out.push({ id: el.id, x: el.x * f, y: -el.y * f, h: Number(pr.mountH) > 0 ? Number(pr.mountH) : 8, rotate: -(el.rotation || 0),
        tilt: Number(pr.tilt) || 0, fluxPct: pr.fluxPct != null && pr.fluxPct !== '' ? Number(pr.fluxPct) : 100 });
    }
    if (typeof SportsCalc !== 'undefined') out.push(...SportsCalc.allFloods(f).lums);
    return out;
  },
  // Light fittings standing in the area whose kind is not Floodlight / Area light
  // (a ceiling downlight, say): the calculation ignores them, so say so.
  _strays(room) {
    if (!room.points || room.points.length < 3) return [];
    return (AppState.planMarkup.elements || []).filter(el => {
      const def = PLAN_DEFS.element(el.type);
      return def && def.group === 'Lighting' && !AreaCalc._isOutdoorLight(el) && PlanEngine._pointInPoly({ x: el.x, y: el.y }, room.points);
    });
  },
  _result(room) {
    RoomCalc._sync();
    const r = RoomCalc.results[room.id];
    if (!r) return { r: null, fresh: false };
    let fresh = false;
    try { fresh = r.sig === AreaCalc.signature(room); } catch (_) { fresh = false; }
    return { r, fresh };
  },

  bounds(room) {
    const f = PlanEngine.factor();
    if (!f) return null;
    const P = this._pts(room, f);
    if (!P.length) return null;
    let xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), m = 25;
    const near = this._lums(f).filter(l => l.x > x0 - m && l.x < x1 + m && l.y > y0 - m && l.y < y1 + m);
    xs = xs.concat(near.map(l => l.x)); ys = ys.concat(near.map(l => l.y));
    return { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), Math.max(3, ...near.map(l => l.h))] };
  },

  draw(v, room, L3) {
    const f = PlanEngine.factor();
    if (!f) { v.bg = null; return; }
    const perim = room.kind === 'perimeter';
    const P = this._pts(room, f), B = this.bounds(room);
    const { r: rr, fresh } = this._result(room);
    const res = rr ? rr.res : null;
    const mode = L3.mode, expo = L3.expo;
    const night = mode === 'render';
    const colour = mode === 'colour' && !!res, rendered = night && !!res;
    v.bg = night ? '#0a0d12' : null;
    const g = 12;
    v.face({ pts: [[B.min[0] - g, B.min[1] - g, 0], [B.max[0] + g, B.min[1] - g, 0], [B.max[0] + g, B.max[1] + g, 0], [B.min[0] - g, B.max[1] + g, 0]],
      fill: night ? '#0c110d' : '#cfd8c8', layer: 0, bias: -3e6 });

    if (!perim) {
      const L = AreaCalc.readArea(room), grid = res && res.grid;
      v.face({ pts: P.map(p => [p[0], p[1], 0.001]), fill: night ? '#161a1f' : '#9aa1a8', layer: 0, bias: -2e6 });
      if (grid && (colour || rendered)) {
        const top = Math.max((res.workplane && res.workplane.Emax) || 0, 1);
        for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
          const val = grid.values[j * grid.nx + i];
          if (val == null) continue;
          const x = grid.x0 + i * grid.dx, y = grid.y0 + j * grid.dy;
          v.face({ pts: [[x, y, 0.003], [x + grid.dx, y, 0.003], [x + grid.dx, y + grid.dy, 0.003], [x, y + grid.dy, 0.003]], layer: 0, bias: -1e6,
            fill: rendered ? V3D.tone(val, L.groundRho, '#8a9096', expo) : RoomCalc._color(val / top), alpha: colour ? (fresh ? 0.92 : 0.4) : 1 });
        }
      }
      v.line({ pts: P.concat([P[0]]).map(p => [p[0], p[1], 0.02]), stroke: night ? '#4b5563' : '#334155', lw: 1.6, layer: 0.5 });
    } else {
      const L = AreaCalc.readPerim(room), closed = L.closed && P.length >= 3;
      const pts = closed ? P.concat([P[0]]) : P;
      const top = Math.max((res && res.vertical && res.vertical.Evmax) || 0, 1);
      const H = this.FENCE_H;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        v.face({ pts: [[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], H], [a[0], a[1], H]], fill: night ? '#2a3038' : '#9aa6b2', alpha: 0.7, layer: 1, bias: 0 });
      }
      v.line({ pts: pts.map(p => [p[0], p[1], H]), stroke: night ? '#6b7280' : '#475569', lw: 1.6, layer: 1.2 });
      v.line({ pts: pts.map(p => [p[0], p[1], 0.02]), stroke: night ? '#4b5563' : '#334155', lw: 1.2, layer: 0.5 });
      const prof = res && res.profile;
      if (prof && (colour || rendered)) {
        const rad = Math.max(0.18, L.step * 0.3);
        for (const q of prof) {
          const col = rendered ? V3D.tone(q.E, 0.5, '#d9dee4', expo) : RoomCalc._color(q.E / top);
          V3D.box(v, [q.x, q.y], rad * 2, rad * 2, Math.max(0, L.height - rad), rad * 2, 0, { color: col, stroke: 'rgba(26,26,46,.4)', lw: 0.6, layer: 1.4 });
        }
      }
    }

    // fittings of another kind inside the area: shown grey, not counted
    if (!perim) for (const el of this._strays(room)) {
      const x = el.x * f, y = -el.y * f, h = Math.max(1, Number((el.props || {}).mountH) || 8);
      v.line({ pts: [[x, y, 0], [x, y, h]], stroke: night ? '#4b5563' : '#9ca3af', lw: 2, dash: [4, 3], layer: 1.3 });
      V3D.box(v, [x, y], 0.5, 0.5, h - 0.1, 0.15, 0, { color: '#9ca3af', stroke: 'rgba(26,26,46,.4)', lw: 0.8, layer: 1.5 });
    }

    // luminaires on poles
    const lums = this._lums(f).filter(l => l.x > B.min[0] - 1 && l.x < B.max[0] + 1 && l.y > B.min[1] - 1 && l.y < B.max[1] + 1);
    for (const l of lums) {
      const on = L3.sel === 'l:' + l.id, pick = 'l:' + l.id, h = Math.max(1, l.h || 8);
      const th = (l.tilt || 0) * Math.PI / 180, rot = (l.rotate || 0) * Math.PI / 180;
      const fr = [-Math.sin(rot), Math.cos(rot)];
      v.line({ pts: [[l.x, l.y, 0], [l.x, l.y, h]], stroke: on ? this.SEL : (night ? '#6b7280' : '#475569'), lw: on ? 4 : 3, layer: 1.3, pick });
      const hx = l.x + fr[0] * 0.5 * Math.sin(th), hy = l.y + fr[1] * 0.5 * Math.sin(th);
      V3D.box(v, [hx, hy], 0.7, 0.35, h - 0.1, 0.18, (l.rotate || 0), { color: night ? '#e6dfc0' : '#fff2b8', pick, stroke: on ? this.SEL : 'rgba(26,26,46,.55)', lw: on ? 2 : 0.8, layer: 1.5 });
      if (night && (l.fluxPct == null || l.fluxPct > 0)) {
        v.glow({ at: [hx, hy, h - 0.1], r: 2.2, color: 'rgba(255,248,226,.5)' });
        v.glow({ at: [hx, hy, h - 0.1], r: 0.9, color: 'rgba(255,253,240,.95)' });
      }
      if (L3.cones || on) {
        const k = h / Math.max(Math.cos(th), 0.2);
        const to = [hx + fr[0] * Math.sin(th) * k, hy + fr[1] * Math.sin(th) * k, 0.03];
        v.line({ pts: [[hx, hy, h - 0.1], to], stroke: on ? 'rgba(232,89,12,.85)' : (night ? 'rgba(255,214,90,.35)' : 'rgba(214,150,20,.55)'), lw: on ? 1.4 : 1, dash: [5, 4], layer: 2 });
      }
      if (on) v.label({ at: [l.x, l.y, h + 0.7], text: `${h} m · tilt ${(+l.tilt || 0).toFixed(0)}°`, color: '#005fa3', size: 12, bold: true });
    }
  },

  // ─── Selection / drag ──────────────────────────────────────────────────
  _el(id) { return (AppState.planMarkup.elements || []).find(e => e.id === id); },
  _selected(sel) { return sel && sel.slice(0, 2) === 'l:' ? this._el(sel.slice(2)) || null : null; },

  pick(id, e, L3) {
    L3.sel = id;
    L3.renderSide();
    L3.view.redraw();
    const el = this._selected(id), f = PlanEngine.factor();
    if (!el || !f) return null;
    const v = L3.view, [sx, sy] = v._pos(e), start = v.planeAt(sx, sy, 0);
    const x0 = el.x * f, y0 = -el.y * f;
    return {
      move: (ev) => {
        const [x, y] = v._pos(ev), p = v.planeAt(x, y, 0);
        el.x = Math.round((x0 + p[0] - start[0]) * 10) / 10 / f;
        el.y = -Math.round((y0 + p[1] - start[1]) * 10) / 10 / f;
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
    const el = this._selected(L3.sel);
    if (!el) return;
    PlanMarkup.selectedIds.clear(); PlanMarkup.selectedIds.add(el.id);
    PlanMarkup.deleteSelected();
    L3.sel = null;
    this._commit(L3);
  },

  // ─── Panels ────────────────────────────────────────────────────────────
  _strayNote(room) {
    const n = this._strays(room).length;
    return n ? `<p class="l3-muted"><b>${n} light fitting${n === 1 ? '' : 's'} in this area ${n === 1 ? 'is' : 'are'} not Floodlight / Area light</b> (shown grey), so ${n === 1 ? 'it is' : 'they are'} left out of the calculation.</p>
      <div class="l3-btns"><button type="button" class="plan-tb-btn" data-a3="outdoor">Make ${n === 1 ? 'it an' : 'them'} Area light${n === 1 ? '' : 's'}</button></div>` : '';
  },

  title(room) {
    const f = PlanEngine.factor();
    if (!f) return '';
    const perim = room.kind === 'perimeter';
    const n = this._lums(f).length;
    let m = '';
    if (perim) { const L = AreaCalc.readPerim(room); m = `Ev ≥ ${L.evMin} lx at ${L.height} m`; }
    else { const L = AreaCalc.readArea(room); m = `Ēm ≥ ${L.em} lx · U₀ ≥ ${L.uo} · ${(PlanEngine._polyArea(room.points) * f * f).toFixed(0)} m²`; }
    return `<b>${escHtml(room.name || (perim ? 'Fence' : 'Area'))}</b><span>${perim ? 'Perimeter' : 'Outdoor area'} · ${m} · ${n} outdoor luminaire${n === 1 ? '' : 's'}</span>`;
  },

  palette(room, L3) {
    const f = PlanEngine.factor();
    const els = (AppState.planMarkup.elements || []).filter(e => AreaCalc._isOutdoorLight(e));
    const row = (e) => `<button type="button" class="l3-row${L3.sel === 'l:' + e.id ? ' active' : ''}" data-l3-sel="${escHtml('l:' + e.id)}"><i style="background:#fff2b8"></i><span>${escHtml(e.name || 'Luminaire')}</span><small>${Number(e.props.mountH) > 0 ? Number(e.props.mountH) : 8} m</small></button>`;
    return `<div class="l3-pal-head">Outdoor luminaires</div>
      <div class="l3-pal-note">Drag a pole across the ground to move it. Add or lay out poles in the Plan view (Fittings › Floodlight / Area light, or Suggest poles in the area's properties).</div>
      <div class="l3-list">${els.map(row).join('') || '<div class="l3-pal-note">No outdoor luminaires yet.</div>'}</div>${room.kind === 'outdoor' ? this._strayNote(room) : ''}`;
  },

  props(room, L3) {
    const el = this._selected(L3.sel);
    const { r } = this._result(room);
    if (!el) {
      return `<div class="l3-props-body">
        <div class="l3-props-title">${escHtml(room.name || 'Outdoor')}</div>
        <p class="l3-muted">Nothing selected. Click a pole in the view or the list to edit it.</p>
        ${this._strayNote(room)}
        <div class="l3-btns"><button type="button" class="plan-tb-btn" data-a3="calc">${r ? 'Recalculate' : 'Calculate'}</button></div>
        <p class="l3-muted">Targets, task and the calculation grid are in the area's properties on the Plan view.</p>
      </div>`;
    }
    const p = el.props || {};
    const num = (key, label, val, step, extra = '') => `<label class="l3-field"><span>${label}</span><input type="number" data-a3p="${key}" value="${escHtml(val)}" step="${step}" ${extra}></label>`;
    return `<div class="l3-props-head"><i style="background:#fff2b8"></i><div><b>${escHtml(el.name || 'Luminaire')}</b><small>Outdoor luminaire</small></div>
        <button type="button" class="l3-icon l3-del" data-l3="del" aria-label="Delete" title="Delete">✕</button></div>
      <div class="l3-props-body"><div class="l3-grid2">
        ${num('mountH', 'Height, m', Number(p.mountH) > 0 ? Number(p.mountH) : 8, 0.5, 'min="1"')}${num('tilt', 'Tilt, °', Number(p.tilt) || 0, 5, 'min="-45" max="90"')}
        ${num('fluxPct', 'Output, %', p.fluxPct != null && p.fluxPct !== '' ? p.fluxPct : 100, 5, 'min="0" max="100"')}${num('rotation', 'Heading, °', Math.round(el.rotation || 0), 15)}
      </div></div>`;
  },

  resStrip(room) {
    const { r: rr, fresh } = this._result(room);
    const chip = (t, cls) => `<span class="l3-chip${cls ? ' ' + cls : ''}">${t}</span>`;
    const name = room.kind === 'perimeter' ? 'Fence' : 'Area';
    if (!rr) return `<b>${name}</b>${chip('Not calculated — press Calculate')}`;
    const res = rr.res;
    const fmt = (c) => c.unit === 'lx' ? c.value.toFixed(1) + ' lx' : c.value.toFixed(2);
    const chips = (res.checks || []).map(c => chip(`${escHtml(c.label)} ${fmt(c)} <small>${c.op === '>=' ? '≥' : '≤'} ${c.req}</small>`, c.pass === true ? '' : c.pass === false ? 'bad' : '')).join('');
    const verdict = res.pass === true ? chip('Pass', 'ok') : res.pass === false ? chip('Fail', 'bad') : chip('No luminaires');
    return `<b>${name}</b>${chips}${verdict}<span class="l3-spacer"></span>
      ${fresh ? chip('Up to date', 'ok') : chip('Out of date — the area or the luminaires changed since the last calculation', 'warn')}`;
  },

  legend(room, L3) {
    if (L3.mode === 'model') return null;
    const { r: rr, fresh } = this._result(room);
    const perim = room.kind === 'perimeter';
    if (!rr || !(rr.res.grid || rr.res.profile)) return `<b>${L3.mode === 'render' ? 'Rendered light' : 'False colour'}</b><span>Calculate to see it.</span>`;
    if (L3.mode === 'colour') {
      const top = Math.max(perim ? ((rr.res.vertical || {}).Evmax || 0) : ((rr.res.workplane || {}).Emax || 0), 1);
      const fm = (x) => x >= 100 ? Math.round(x) : x.toFixed(1);
      return `<b>${perim ? 'Vertical illuminance, lx' : 'Illuminance, lx'}</b><div class="plan-legend-bar" aria-hidden="true"></div>
        <div class="plan-legend-scale"><span>0</span><span>${fm(top / 2)}</span><span>${fm(top)}</span></div>
        <span>${perim ? 'Ev on the measured face of the fence' : 'Horizontal on the ground'}.${fresh ? '' : ' Out of date.'}</span>`;
    }
    return `<b>Rendered light</b><span>The ${perim ? 'fence samples' : 'ground'} as bright as they look at night.${fresh ? '' : ' <b>Out of date</b> — showing the last calculation.'}</span>
      <label class="l3-expo">Exposure <input type="range" min="0.2" max="4" step="0.1" value="${L3.expo}" data-l3="expo"></label>`;
  },

  // ─── Events ────────────────────────────────────────────────────────────
  onClick(e, L3, room) {
    const a = e.target.closest('[data-a3], [data-l3="del"]');
    if (!a || a.tagName === 'INPUT') return false;
    if (a.dataset.a3 === 'calc') L3.calc();
    else if (a.dataset.a3 === 'outdoor') {
      for (const el of this._strays(room)) el.props = Object.assign({}, el.props, { kind: 'area' });
      this._commit(L3);
      UI.toast('Now Area lights. Pick a library luminaire for each (Luminaires step) so they can be calculated.', 'info', 7000);
    }
    else if (a.dataset.l3 === 'del') this.remove(L3, room);
    else return false;
    return true;
  },

  onChange(e, L3, room) {
    const t = e.target, k = t.dataset.a3p;
    const el = this._selected(L3.sel);
    if (!k || !el) return;
    const val = parseFloat(t.value);
    if (!Number.isFinite(val)) return;
    if (k === 'rotation') el.rotation = val;
    else el.props = Object.assign({}, el.props, { [k]: k === 'mountH' ? Math.max(1, val) : k === 'fluxPct' ? Math.max(0, Math.min(100, val)) : val });
    this._commit(L3);
  },
};

// Which module draws a room in the 3D view: a sports field, an outdoor area / fence, or none (a room).
const Alt3D = {
  is(room) { return Sports3D.is(room) || Area3D.is(room); },
  m(room) { return Sports3D.is(room) ? Sports3D : Area3D; },
};
