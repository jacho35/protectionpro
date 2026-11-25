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
  layout(roof) {
    const f = PlanEngine.factor(), c = Solar.cfg(), p = Solar.panel(c);
    if (!f || !roof.points || roof.points.length < 3) return { mods: [], n: 0, kwp: 0, pending: false };
    const key = [roof.points.map(q => q.x + ',' + q.y).join(';'), roof.shape, roof.pitch, roof.tilt, roof.azimuth, roof.setback, p.id, p.len, p.wid, f, c.hour, c.location].join('|');
    const hit = this._layouts.get(roof.id);
    if (hit && hit.key === key) return hit.lay;
    const poly = Roof3D.toMetres(roof.points, f), az = +roof.azimuth || 0, setback = Math.max(0, +roof.setback || 0);
    let mods = [], pending = false;
    if (roof.shape === 'gable') {
      const g = Roof3D.gablePlanes(poly, az, +roof.pitch, Roof3D.EAVE_M);
      mods = Roof3D.layoutModules(poly, az, +roof.pitch, setback, p, 1e9, g);
    } else {
      const rp = this.rowPitch(roof, p);
      if (rp == null) pending = true;
      else mods = Roof3D.layoutRacks(poly, az, +roof.tilt, setback, p, 1e9, rp, 0);
    }
    const lay = { mods: mods.map(m => m.map(q => [q[0], q[1]])), n: mods.length, fit: mods.length, kwp: mods.length * p.w / 1000, pending };
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
      // The array on the plan IS the design: size the roofs as they are (not capped by the load target, which would
      // shrink what was placed), then take the panels actually laid out as the count. The sizing mode the modal
      // uses is left as the user set it.
      await Solar._locations();
      for (let k = 0; k < 20 && roofs.some(r => this.layout(r).pending); k++) await new Promise(res => setTimeout(res, 150));   // a flat roof waits for its row pitch
      const keep = Solar.cfg().mode;
      Solar.set('roofShape', 'plan'); Solar.set('mode', 'roof');
      try { await Solar._locations(); await Solar.runSize(); } finally { Solar.set('mode', keep); }
      const res = Solar._res;
      let total = 0;
      for (const a of (res.arrays || [])) {
        const roof = roofs.find(r => r.name === a.name);
        if (roof) { a.modules = this.layout(roof).n; total += a.modules; }
      }
      res.modules = total;
      const pv = Solar.placePv(true);
      this.sld = `On the single line as ${pv.props.name || 'PV array'}: ${total} panels, as laid out.`;
    } catch (e) {
      this.sld = 'Single line not updated: ' + (e.message || e);
    } finally {
      this._busy = false;
      if (this._again) { this._again = false; this._queue(); }
      if (typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'solararray') PlanMarkup.refreshProps();
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
        const { u: au, w: aw } = Roof3D.axes(+r.azimuth || 0);
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
    }
  },

  // ── Properties of the tool ──
  hint() { return 'Place array: click a roof and its panels are laid out on it. Set tilt, azimuth and spacing in Properties. Esc to stop.'; },
  renderOptions(el) {
    const roofs = PlanSolar.roofs(), f = PlanEngine.factor(), c = Solar.cfg(), p = Solar.panel(c);
    const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const r = roofs.find(x => x.id === this.sel) || null;
    let body;
    if (!roofs.length) {
      body = `<p style="margin:0;color:var(--text-muted)">No roofs yet. Pick <b>Roof</b> in the Solar group (click inside a building, or Draw its outline), then come back to <b>Place array</b>.</p>`;
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
        <input type="range" data-sa-k="${k}" min="${min}" max="${max}" step="${step}" value="${+r[k]}"></label>`;
      detail = `<div class="plan-props-sec">${esc(r.name)} · solar array</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><div><small>Panels</small><br><b data-sa-n style="font-size:16px">${l.pending ? '…' : l.n}</b></div><div><small>Power</small><br><b data-sa-kwp style="font-size:16px">${l.pending ? '…' : l.kwp.toFixed(1) + ' kWp'}</b></div></div>
        <div style="color:var(--text-muted)">${esc(p.name || p.id)} (${p.w} W). Change the panel, inverter and location in Open design.</div>
        <label style="display:flex;gap:8px;align-items:center"><span>Roof</span><select data-sa-shape><option value="gable"${r.shape === 'gable' ? ' selected' : ''}>Gable (north plane)</option><option value="flat"${r.shape === 'flat' ? ' selected' : ''}>Flat with racks</option></select></label>
        ${r.shape === 'gable' ? sl('pitch', 'Roof pitch', 0, 45, 1, '°') : sl('tilt', 'Rack tilt', 0, 40, 1, '°')}
        ${sl('azimuth', 'Azimuth (0 = north)', 0, 359, 1, '°')}${sl('setback', 'Edge setback', 0, 2, 0.1, ' m')}
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
      if (e.target.closest('[data-sa-design]')) { Solar.open(); return; }
      if (e.target.closest('[data-sa-remove]') && r) { this.remove(r); }
    };
    el.oninput = (e) => {
      const k = e.target.dataset.saK; if (!k || !r) return;
      this.edit(r, { [k]: +e.target.value });
      const o = el.querySelector(`[data-sa-o="${k}"]`); if (o) o.textContent = r[k] + (k === 'setback' ? ' m' : '°');
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
    if (!r) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Click inside a roof. Draw one first with Solar › Roof.', 'info', 3000); return; }
    if (r.array) { PlanSolarArray.sel = r.id; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
    PlanSolarArray.place(r);
  },
  onKey(e) { if (e.key === 'Escape') { PlanTools.set('select'); return true; } return false; },
});

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSolarArray;
