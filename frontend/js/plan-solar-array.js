/* ProtectionPro — PlanSolarArray: place a solar array straight from the site plan.
 *
 * The **Place array** tool (Plan › Solar): click a roof (made with the Roof tool, `PlanSolar`) and its panels are laid
 * out on it at once and drawn on the plan. The tool's Properties list the roofs, with the settings that shape the
 * layout (the roof's own fields: shape, pitch / tilt, azimuth, setback — `PlanSolar.update`), the panel count and
 * kWp, how the panels are shown, and the single-line status.
 *
 * No layout or sizing maths lives here: the panels are `Roof3D.layoutModules` (gable) / `layoutRacks` (flat, row
 * pitch from `/analysis/solar-row-spacing`), the same rectangles the 3D view draws, and the single line is the
 * Solar PV Design modal's own `Solar.runSize` + `Solar.placePv` on the roofs in use. A roof with an array has
 * `roof.array = true` (and `use = true`); the project's panel, inverter and location are Solar PV Design's.
 */
const PlanSolarArray = {
  sel: null,            // roof id the Properties show
  hover: null,          // roof id under the pointer with the tool armed
  _rp: {},              // row pitch (m) by lat|tilt|module length|hour
  _asked: {},           // row pitch requests in flight / done
  _timer: null, _busy: false, _again: false,
  sld: '',              // last single-line message
  _layouts: new Map(),  // roof id → { key, lay }

  style() { const s = PlanSolar._store(); return (s && s.arrayStyle) || 'modules'; },
  setStyle(v) { const s = PlanSolar._store(); if (s) s.arrayStyle = v === 'block' ? 'block' : 'modules'; if (typeof PlanMarkup !== 'undefined') PlanMarkup.markDirty(); this._redraw(); },

  roofAt(pt) {
    const roofs = PlanSolar.roofs().filter(r => r.points && r.points.length >= 3);
    for (let i = roofs.length - 1; i >= 0; i--) if (PlanEngine._pointInPoly(pt, roofs[i].points)) return roofs[i];
    return null;
  },

  // The panels placed on the plan: {n, kwp, roofs}.
  totals() {
    const p = Solar.panel(Solar.cfg()); let n = 0, roofs = 0;
    for (const r of PlanSolar.roofs()) if (r.array && r.use !== false) { const l = this.layout(r); if (!l.pending) { n += l.n; roofs++; } }
    return { n, kwp: n * p.w / 1000, roofs };
  },
  // The laid-out array's gaps (cached with the layout): see Roof3D.boundaries.
  _bd(roof, lay) { return lay._bd || (lay._bd = Roof3D.boundaries(lay.mods, PlanSolar.planAz(roof))); },
  // Can aisles go on this roof? (a placed array on a gable or flat roof). Else why not, as text.
  aisleBlock(roof) {
    if (!roof.array) return 'Place an array on the roof first (Array › Place array).';
    if (PlanSolar.usesPlanes(roof)) return 'Maintenance aisles work on gable and flat roofs.';
    const lay = this.layout(roof);
    return lay.pending || !lay.mods.length ? 'The array has no panels yet.' : '';
  },
  // The gap between panels under a point (world px), or null: {roof, axis, after, at, clear, has, bd}. `mode` is the aisle tool:
  // 'row' / 'col' only look at that kind of gap, 'remove' only at gaps that already have an aisle.
  gapAt(pt, zoom, mode) {
    const f = PlanEngine.factor(), r = this.roofAt(pt);
    if (!f || !r || this.aisleBlock(r)) return null;
    const lay = this.layout(r), bd = this._bd(r, lay);
    const ok = mode === 'row' ? (a) => a === 'row' : mode === 'col' ? (a) => a === 'col' : mode === 'remove' ? (a, i) => !!PlanSolar.aisleAt(r, a, i) : null;
    const hit = Roof3D.boundaryAt(bd, [pt.x * f, -pt.y * f], (8 / (zoom || 1)) * f, ok);
    return hit ? Object.assign(hit, { roof: r, bd, has: !!PlanSolar.aisleAt(r, hit.axis, hit.after) }) : null;
  },
  // Insert the aisle at a gap, or (off) take it out.
  setAisle(r, axis, after, on) {
    PlanSolar.setAisle(r, axis, after, on); this._layouts.delete(r.id);
    this._after(on ? 'Maintenance aisle added to ' + r.name + '.' : 'Maintenance aisle removed.');
  },

  // The row pitch a flat roof's racks need, from the engine (cached); null until it has answered.
  rowPitch(roof, p) {
    if (!Solar._locs) {      // the irradiance locations (latitude) load once, as Solar PV Design does
      if (!this._asked.locs) { this._asked.locs = true; Solar._locations().then(() => { this._layouts.clear(); this._redraw(); if (this.sel) PlanMarkup.refreshProps(); }).catch(() => { this._asked.locs = false; }); }
      return null;
    }
    const c = Solar.cfg(), lat = Solar._loc(c).lat, key = [lat, +roof.tilt, p.len, +c.hour].join('|');
    if (this._rp[key] != null) return this._rp[key];
    if (!this._asked[key]) {
      this._asked[key] = true;
      API.request('/analysis/solar-row-spacing', 'POST', { lat, tilt_deg: +roof.tilt, module_length_m: p.len, hour_angle_deg: +c.hour })
        .then(r => { this._rp[key] = r.pitch_m; this._layouts.clear(); this._redraw(); if (this.sel) PlanMarkup.refreshProps(); })
        .catch(() => { delete this._asked[key]; });
    }
    return null;
  },

  // The panels on a roof: { mods: [four [x, y] corners, metres], n, kwp, pending }. Whole panels inside the setback.
  // The panels each placed roof may take under the design's kWp target (Solar PV Design › Target array size): roofs fill in plan order until
  // the target is reached. "Fill the roof" has no limit. {roofId: panels}
  _limits() {
    const c = Solar.cfg();
    if (c.mode !== 'kwp' || !(+c.targetKwp > 0)) return {};
    let left = Math.max(1, Math.round(+c.targetKwp * 1000 / Solar.panel(c).w));
    const out = {};
    for (const r of PlanSolar.roofs()) {
      if (!r.array || r.use === false || PlanSolar.usesPlanes(r)) continue;
      out[r.id] = Math.min(this._lay(r, null).n, left); left -= out[r.id];
    }
    return out;
  },
  layout(roof) { const lim = this._limits()[roof.id]; return this._lay(roof, lim == null ? null : lim); },
  _lay(roof, limit) {
    const f = PlanEngine.factor(), c = Solar.cfg(), p = Solar.panel(c);
    if (!f || !roof.points || roof.points.length < 3) return { mods: [], n: 0, kwp: 0, pending: false };
    const key = [roof.points.map(q => q.x + ',' + q.y).join(';'), roof.shape, roof.pitch, roof.tilt, roof.azimuth, PlanSolar.northAngle(), roof.eave, JSON.stringify(roof.planeUse || null), roof.setback, roof.panelGap, JSON.stringify(roof.aisles || null), limit, roof.modAlign, roof.maxModules, JSON.stringify(roof.keepouts || []), p.id, p.len, p.wid, f, c.hour, c.location].join('|');
    const hit = this._layouts.get(roof.id);
    if (hit && hit.key === key) return hit.lay;
    const poly = Roof3D.toMetres(roof.points, f), az = PlanSolar.planAz(roof), setback = Math.max(0, +roof.setback || 0);
    let mods = [], pending = false;
    const mp = PlanSolar.modFor(roof, p);                                      // the panel with this roof's gap
    const ex = PlanSolar.keepoutsM(roof), cap = Math.min(1e9, PlanSolar.maxModules(roof), limit == null ? 1e9 : limit);                 // the roof's own maximum panels
    if (PlanSolar.usesPlanes(roof)) {                                       // a layout on every plane in use
      const g = PlanSolar.planesOf(roof), use = g.use;
      g.planes.forEach((pl, i) => { if (use[i] && mods.length < cap) mods.push(...RoofPlanes.layoutPlane(pl, g.poly, setback, mp, cap - mods.length, roof.modAlign, ex).map(m => { m.pl = pl.name; return m; })); });   // each panel keeps its plane, so the size run can take the count per plane
    } else if (roof.shape === 'gable') {
      const g = Roof3D.gablePlanes(poly, az, +roof.pitch, Roof3D.EAVE_M);
      mods = Roof3D.layoutModules(poly, az, +roof.pitch, setback, mp, cap, g, roof.modAlign, ex);
    } else {
      const rp = this.rowPitch(roof, p);
      if (rp == null) pending = true;
      else mods = Roof3D.layoutRacks(poly, az, +roof.tilt, setback, mp, cap, rp, 0, roof.modAlign, ex);
    }
    const byPlane = {};                                                      // placed panels per plane name (plane roofs only)
    for (const m of mods) if (m.pl != null) byPlane[m.pl] = (byPlane[m.pl] || 0) + 1;
    const lay = { mods: mods.map(m => { const a = m.map(q => [q[0], q[1]]); a.ri = m.ri; a.ci = m.ci; a.pl = m.pl; return a; }), n: mods.length, fit: mods.length, kwp: mods.length * p.w / 1000, byPlane, pending };
    if (!pending) this._layouts.set(roof.id, { key, lay });
    return lay;
  },

  // ── Actions ──
  place(roof) {
    roof.array = true; roof.use = true; this.sel = roof.id;
    this._after('Array placed on ' + roof.name + '.');
  },
  remove(roof) {
    roof.array = false; this._layouts.delete(roof.id);
    this._after(null, true);
  },
  edit(roof, patch) {
    Object.assign(roof, patch); this._layouts.delete(roof.id);
    PlanMarkup.markDirty(); this._redraw(); this._queue();
    if (typeof RoofEditor !== 'undefined' && RoofEditor.on && typeof Roof3D !== 'undefined') Roof3D.refresh();
  },
  _after(msg, noSld) {
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); this._redraw(); PlanMarkup.refreshProps();
    if (msg && typeof UI !== 'undefined' && UI.toast) UI.toast(msg, 'success', 2500);
    if (!noSld || PlanSolar.roofs().some(r => r.array)) this._queue();
  },
  _redraw() { if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true }); },

  // The single line follows the arrays: Solar PV Design's own size run on the roofs in use, then its own placePv.
  _queue() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.toSld(), 500);
  },
  async toSld() {
    if (this._busy) { this._again = true; return; }
    const roofs = PlanSolar.roofs().filter(r => r.array && r.use !== false);
    if (!roofs.length) return;
    this._busy = true;
    try {
      if (!PlanEngine.factor()) throw new Error('Calibrate the plan scale first so the roofs have a size.');
      // The array on the plan IS the design: Solar PV Design's size run keeps each placed roof's laid-out count (the layout is already
      // limited to the kWp target) and sizes any other roof by the mode, so the modal, the 3D view and the single line agree.
      await Solar._locations();
      for (let k = 0; k < 20 && roofs.some(r => this.layout(r).pending); k++) await new Promise(res => setTimeout(res, 150));   // a flat roof waits for its row pitch
      Solar.set('roofShape', 'plan');
      await Solar._locations(); await Solar.runSize();
      const res = Solar._res, total = res.modules;
      const pv = Solar.placePv(true);
      this.sld = `On the single line as ${pv.props.name || 'PV array'}: ${total} panels, ${res.kwp} kWp, as laid out.`;
    } catch (e) {
      this.sld = 'Single line not updated: ' + (e.message || e);
    } finally {
      this._busy = false;
      if (this._again) { this._again = false; this._queue(); }
      if (typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'solararray') PlanMarkup.refreshProps();
      if (typeof Solar !== 'undefined' && Solar._renderDock) Solar._renderDock();                    // Design parameters: the placed count
    }
  },

  // ── Canvas ──
  draw(ctx, zoom) {
    const f = PlanEngine.factor(); if (!f) return;
    const u = 1 / zoom, mode = this.style(), c = Solar.cfg(), p = Solar.panel(c);
    const armed = typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'solararray';
    const wx = (m) => m[0] / f, wy = (m) => -m[1] / f;
    for (const r of PlanSolar.roofs()) {
      if (!r.points || r.points.length < 3) continue;
      const showHover = armed && this.hover === r.id && !r.array;
      const selected = armed && this.sel === r.id;
      if (selected || showHover) {
        ctx.save(); ctx.beginPath(); r.points.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath();
        ctx.strokeStyle = '#d9822b'; ctx.lineWidth = 3 * u; ctx.stroke(); ctx.restore();
      }
      if (!r.array && !showHover) continue;
      const lay = this.layout(r);
      if (showHover) {
        const ctr = r.points.reduce((a, q) => ({ x: a.x + q.x / r.points.length, y: a.y + q.y / r.points.length }), { x: 0, y: 0 });
        ctx.save(); ctx.font = `600 ${13 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#b45309';
        ctx.fillText(lay.pending ? 'Click to place an array' : `Click to place about ${lay.n} panels`, ctr.x, ctr.y + 18 * u); ctx.restore();
        continue;
      }
      if (!lay.mods.length) continue;
      ctx.save();
      if (mode === 'block') {
        const { u: au, w: aw } = Roof3D.axes(PlanSolar.planAz(r));
        let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
        for (const m of lay.mods) for (const q of m) { const s = q[0] * au[0] + q[1] * au[1], v = q[0] * aw[0] + q[1] * aw[1]; a0 = Math.min(a0, s); a1 = Math.max(a1, s); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
        const at = (v, s) => [aw[0] * v + au[0] * s, aw[1] * v + au[1] * s];
        const box = [at(b0, a0), at(b1, a0), at(b1, a1), at(b0, a1)];
        ctx.beginPath(); box.forEach((q, i) => i ? ctx.lineTo(wx(q), wy(q)) : ctx.moveTo(wx(q), wy(q))); ctx.closePath();
        ctx.fillStyle = 'rgba(31,78,121,0.55)'; ctx.fill(); ctx.strokeStyle = '#1f4e79'; ctx.lineWidth = 1.5 * u; ctx.stroke();
        const mx = box.reduce((s, q) => s + q[0] / 4, 0), my = box.reduce((s, q) => s + q[1] / 4, 0);
        ctx.font = `600 ${13 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#0b2540';
        ctx.fillText(`${lay.n} × ${p.w} W`, wx([mx, my]), wy([mx, my]) + 4 * u);
      } else {
        ctx.fillStyle = '#1f4e79'; ctx.strokeStyle = '#9ec1e3'; ctx.lineWidth = 0.6 * u;
        for (const m of lay.mods) {
          ctx.beginPath(); m.forEach((q, i) => i ? ctx.lineTo(wx(q), wy(q)) : ctx.moveTo(wx(q), wy(q))); ctx.closePath(); ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
      const am = PlanTools.active && PlanTools.active.id === 'solaraisle' ? (PlanTools.opts && PlanTools.opts.mode) || 'row' : null;
      if (am && mode !== 'block' && !this.aisleBlock(r)) {
        const bd = this._bd(r, lay);
        for (const g of [...(am === 'col' ? [] : bd.rows.map(x => Object.assign({ axis: 'row' }, x))), ...(am === 'row' ? [] : bd.cols.map(x => Object.assign({ axis: 'col' }, x)))]) {
          const has = !!PlanSolar.aisleAt(r, g.axis, g.after);
          if (am === 'remove' ? has : !has) this._gapLine(ctx, u, f, bd, g, has ? '#b91c1c' : '#6d93ea', true);
        }
        const gh = this.hoverGap && this.hoverGap.roof.id === r.id ? this.hoverGap : null;
        if (gh) this._drawGapMark(ctx, u, f, gh);
      }
    }
  },
  // A line across a gap, along the array.
  _gapLine(ctx, u, f, bd, g, col, dashed) {
    const ext = g.axis === 'col' ? bd.s : bd.v, ax = g.axis === 'col' ? bd.w : bd.u, al = g.axis === 'col' ? bd.u : bd.w;
    const at = (x) => [ax[0] * g.at + al[0] * x, ax[1] * g.at + al[1] * x], a = at(ext[0]), b = at(ext[1]);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = (dashed ? 1.5 : 3) * u; ctx.lineCap = 'round'; if (dashed) ctx.setLineDash([5 * u, 4 * u]);
    ctx.beginPath(); ctx.moveTo(a[0] / f, -a[1] / f); ctx.lineTo(b[0] / f, -b[1] / f); ctx.stroke(); ctx.restore();
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  },
  // The solid blue insert line (red over an existing aisle) across the gap under the pointer, with a chip: "+ Aisle 0.8 m" / "× Remove".
  _drawGapMark(ctx, u, f, g) {
    const col = g.has ? '#b91c1c' : '#1d4ed8', mid = this._gapLine(ctx, u, f, g.bd, g, col, false);
    const text = g.has ? '× Remove' : '+ Aisle ' + PlanSolar.aisleWidth(g.roof).toFixed(1) + ' m', cx = mid[0] / f, cy = -mid[1] / f;
    ctx.save(); ctx.font = `700 ${12 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 16 * u, h = 20 * u;
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2) : ctx.rect(cx - w / 2, cy - h / 2, w, h); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(text, cx, cy + 0.5 * u); ctx.restore();
  },

  // ── Properties of the tool ──
  _aisleList(r) {
    if (PlanSolar.usesPlanes(r)) return '<div style="color:var(--text-muted)">Maintenance aisles are for gable and flat roofs.</div>';
    const list = PlanSolar.aislesOf(r).slice().sort((a, b) => a.axis === b.axis ? a.after - b.after : (a.axis === 'row' ? -1 : 1));
    const rows = list.map(a => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${a.axis === 'row' ? 'Between rows' : 'Between columns'} ${a.after} and ${a.after + 1}</span><button type="button" class="plan-btn" data-sa-aisle-rm="${a.axis}:${a.after}" aria-label="Remove the aisle ${a.axis === 'row' ? 'between rows' : 'between columns'} ${a.after} and ${a.after + 1}">Remove</button></div>`).join('');
    return `<div class="plan-props-sec">Maintenance aisles</div>${rows || '<div style="color:var(--text-muted)">None. Click the gap between two rows or columns of panels, Alt-click an aisle to remove it.</div>'}`;
  },
  hint() { return 'Place array: click a roof and its panels are laid out on it. Aisles have their own tools in the Maintenance aisles group of the Solar toolbar. Esc to stop.'; },
  renderOptions(el) {
    const roofs = PlanSolar.roofs(), f = PlanEngine.factor(), c = Solar.cfg(), p = Solar.panel(c);
    const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const r = roofs.find(x => x.id === this.sel) || null;
    let body;
    if (!roofs.length) {
      body = `<p style="margin:0;color:var(--text-muted)">No roofs yet. Pick <b>Roof</b> in the Solar toolbar (click inside a building, or Draw its outline), then come back to <b>Place array</b>.</p>`;
    } else {
      const list = roofs.map(x => {
        const l = x.array ? this.layout(x) : null;
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid var(--border,#ddd);padding:4px 0">
          <button type="button" class="plan-btn" data-sa-pick="${esc(x.id)}" style="${x.id === this.sel ? 'font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${esc(x.name)}</button>
          ${x.array ? `<span style="color:var(--text-muted)">${l.pending ? 'laying out…' : l.n + ' panels'}</span>` : `<button type="button" class="plan-btn" data-sa-place="${esc(x.id)}" style="font-weight:600">Place array</button>`}</div>`;
      }).join('');
      body = `<p style="margin:0;color:var(--text-muted)">Click a roof on the plan, or place one from the list.</p>${list}`;
    }
    let detail = '';
    if (r && r.array) {
      const l = this.layout(r);
      const sl = (k, label, min, max, step, unit) => `<label style="display:grid;gap:2px"><span style="display:flex;justify-content:space-between"><span>${label}</span><output data-sa-o="${k}">${+r[k]}${unit}</output></span>
        <input type="range" data-sa-k="${k}" data-sa-u="${unit}" min="${min}" max="${max}" step="${step}" value="${+r[k]}"></label>`;
      detail = `<div class="plan-props-sec">${esc(r.name)} · solar array</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><div><small>Panels</small><br><b data-sa-n style="font-size:16px">${l.pending ? '…' : l.n}</b></div><div><small>Power</small><br><b data-sa-kwp style="font-size:16px">${l.pending ? '…' : l.kwp.toFixed(1) + ' kWp'}</b></div></div>
        <div style="color:var(--text-muted)">${esc(p.name || p.id)} (${p.w} W). ${c.mode === 'kwp' ? 'Design target ' + (+c.targetKwp || 0) + ' kWp, shared over the roofs in order. ' : 'Fill the roof. '}Change the panel, size, inverter and location in Open design.</div>
        <label style="display:flex;gap:8px;align-items:center"><span>Roof</span><select data-sa-shape>${RoofPlanes.SHAPES.map(k => `<option value="${k}"${r.shape === k ? ' selected' : ''}>${RoofPlanes.LABELS[k]}</option>`).join('')}</select></label>
        ${r.shape !== 'flat' ? sl('pitch', 'Roof pitch', 0, 45, 1, '°') : sl('tilt', 'Rack tilt', 0, 40, 1, '°')}${sl('eave', 'Eave height', 2, 12, 0.1, ' m')}
        ${sl('azimuth', 'Azimuth (0 = north)', 0, 359, 1, '°')}${sl('setback', 'Edge setback', 0, 2, 0.1, ' m')}${sl('panelGap', 'Gap between panels', 0, 100, 5, ' mm')}${sl('aisleWidth', 'Maintenance aisle width', 0.3, 3, 0.1, ' m')}
        ${this._aisleList(r)}
        <label style="display:flex;gap:8px;align-items:center"><span>Show as</span><select data-sa-style><option value="modules"${this.style() === 'modules' ? ' selected' : ''}>Individual panels</option><option value="block"${this.style() === 'block' ? ' selected' : ''}>One block with a count</option></select></label>
        <div data-sa-sld style="color:${/not updated/.test(this.sld) ? '#b45309' : 'var(--text-muted)'}">${esc(this.sld || (f ? 'The single line follows this array.' : 'Calibrate the plan scale to size the array.'))}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="plan-btn" data-sa-design style="font-weight:600">Open design</button><button type="button" class="plan-btn" data-sa-remove>Remove array</button></div>`;
    }
    el.innerHTML = `<div class="plan-props-title">Place solar array</div><div class="plan-props-body" style="display:flex;flex-direction:column;gap:10px;font-size:13px">${body}${detail}
      ${!f ? '<p style="margin:0;color:#b45309">The plan is not calibrated, so roofs have no size yet.</p>' : ''}</div>`;
    const roofOf = (id) => PlanSolar.roofs().find(x => x.id === id);
    el.onclick = (e) => {
      const pick = e.target.closest('[data-sa-pick]'); if (pick) { this.sel = pick.dataset.saPick; PlanMarkup.refreshProps(); this._redraw(); return; }
      const pl = e.target.closest('[data-sa-place]'); if (pl) { const x = roofOf(pl.dataset.saPlace); if (x) this.place(x); return; }
      const rm = e.target.closest('[data-sa-aisle-rm]'); if (rm && r) { const [ax, af] = rm.dataset.saAisleRm.split(':'); this.setAisle(r, ax, +af, false); return; }
      if (e.target.closest('[data-sa-design]')) { Solar.open(); return; }
      if (e.target.closest('[data-sa-remove]') && r) { this.remove(r); }
    };
    el.oninput = (e) => {
      const k = e.target.dataset.saK; if (!k || !r) return;
      this.edit(r, { [k]: +e.target.value });
      const o = el.querySelector(`[data-sa-o="${k}"]`); if (o) o.textContent = r[k] + (e.target.dataset.saU || '');
      const l = this.layout(r), n = el.querySelector('[data-sa-n]'), kw = el.querySelector('[data-sa-kwp]');
      if (n) n.textContent = l.pending ? '…' : l.n; if (kw) kw.textContent = l.pending ? '…' : l.kwp.toFixed(1) + ' kWp';
    };
    el.onchange = (e) => {
      if (e.target.matches('[data-sa-style]')) this.setStyle(e.target.value);
      else if (e.target.matches('[data-sa-shape]') && r) { this.edit(r, { shape: e.target.value }); PlanMarkup.refreshProps(); }
    };
  },
};

if (typeof PlanTools !== 'undefined') PlanTools.register({
  id: 'solararray', cursor: 'crosshair',
  onActivate() { PlanSolarArray.hover = null; },
  cancel() { PlanSolarArray.hover = null; PlanEngine.requestDraw({ fg: true }); },
  onMove(pt) {
    const r = PlanSolarArray.roofAt(pt), id = r ? r.id : null;
    if (id !== PlanSolarArray.hover) { PlanSolarArray.hover = id; PlanEngine.requestDraw({ fg: true }); }
  },
  onDown(pt) {
    const r = PlanSolarArray.roofAt(pt);
    if (!r) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Click inside a roof. Draw one first with Roof in the Solar toolbar.', 'info', 3000); return; }
    if (r.array) { PlanSolarArray.sel = r.id; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
    PlanSolarArray.place(r);
  },
  onKey(e) { if (e.key === 'Escape') { PlanTools.set('select'); return true; } return false; },
});

// The Row aisle / Column aisle / Remove aisle tools (Solar toolbar): `PlanTools.opts.mode` = 'row' | 'col' | 'remove'. The gaps the tool can act on show
// as dashed lines; the one under the pointer goes solid with a chip; a click inserts (or removes) the aisle there.
if (typeof PlanTools !== 'undefined') PlanTools.register({
  id: 'solaraisle', cursor: 'copy',
  mode() { return (PlanTools.opts && PlanTools.opts.mode) || 'row'; },
  onActivate() { PlanSolarArray.hoverGap = null; PlanEngine.requestDraw({ fg: true }); },
  cancel() { PlanSolarArray.hoverGap = null; PlanEngine.requestDraw({ fg: true }); },
  onMove(pt) {
    const g = PlanSolarArray.gapAt(pt, PlanEngine.view.zoom, this.mode()), h = PlanSolarArray.hoverGap;
    if ((g ? g.roof.id + g.axis + g.after : null) !== (h ? h.roof.id + h.axis + h.after : null)) { PlanSolarArray.hoverGap = g; PlanEngine.requestDraw({ fg: true }); }
  },
  onDown(pt, e) {
    const toast = (m) => { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m, 'info', 3500); };
    const g = PlanSolarArray.gapAt(pt, PlanEngine.view.zoom, this.mode());
    if (g) {
      if (!g.has) PlanSolarArray.setAisle(g.roof, g.axis, g.after, true);
      else if (this.mode() === 'remove' || (e && e.altKey)) PlanSolarArray.setAisle(g.roof, g.axis, g.after, false);
      else toast('That gap already has an aisle. Use Remove aisle, or Alt-click it.');
      PlanSolarArray.hoverGap = null; PlanSolarArray.sel = g.roof.id; PlanMarkup.refreshProps(); return;
    }
    const r = PlanSolarArray.roofAt(pt);
    if (!r) return;
    const why = PlanSolarArray.aisleBlock(r);
    toast(why || (this.mode() === 'remove' ? 'No aisle there. Click an aisle (the hatched strip) to remove it.' : 'Click on the dashed line between two ' + (this.mode() === 'row' ? 'rows' : 'columns') + ' of panels.'));
  },
  onKey(e) { if (e.key === 'Escape') { if (typeof SolarBar !== 'undefined') SolarBar.pick('select'); else PlanTools.set('select'); return true; } return false; },
});

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSolarArray;
