/* ProtectionPro — Plan Markup lighting (lux) heatmap.
 *
 * Point-by-point horizontal illuminance over the plan: E = I(θ,φ)·cosθ / d²
 * (cosine + inverse-square law) summed over every fitting, rendered as a
 * translucent heatmap. Requires calibration (metres).
 *
 * The intensity I comes from one of two models, per fitting:
 *   • measured — the fitting references an imported IES photometric file
 *     (`props.iesId`, see plan-ies.js), so I is read from the manufacturer's
 *     candela web at the real (vertical, azimuth) angle, rotated into the
 *     fitting's own frame. This is the accurate path.
 *   • cone — no IES file: the fallback treats the fitting as a point source
 *     radiating uniformly inside a beam cone β, I0 = lumens / (2π·(1−cos(β/2))).
 *     Fine for a first pass, but it ignores the optic entirely.
 *
 * Even on the measured path this is a direct-illuminance model — no
 * interreflection, no obstruction — so it is design guidance, not a substitute
 * for a photometric tool.
 */

const PlanLux = {
  enabled: false,
  _grid: null,       // {minX,minY,step,cols,rows,vals,max}
  settings: { resM: 0.5, mountH: 2.5, efficacy: 100, beamDeg: 120 },

  toggle() {
    const f = PlanEngine.factor();
    if (!this.enabled && !f) { UI.alert('Calibrate the plan first — lux needs real distances.'); return; }
    this.enabled = !this.enabled;
    this._grid = null;
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
    const btn = document.querySelector('[data-action="lux"]');
    if (btn) btn.classList.toggle('active', this.enabled);
    if (this.enabled) {
      const peak = this._grid ? this._grid.max : this._computeAndPeak();
      // Say which model produced the numbers — a cone approximation and a
      // measured web can differ several-fold under a narrow optic.
      const measured = this.usesPhotometry();
      if (peak != null) UI.toast(
        `Lux heatmap on — peak ≈ ${Math.round(peak)} lx (${measured ? 'IES photometry' : 'cone approximation — import an IES file for measured optics'})`,
        'info');
    }
  },

  invalidate() { this._grid = null; },

  _computeAndPeak() { this._compute(); return this._grid ? this._grid.max : null; },

  // Lighting fittings: any element in a Lighting group or carrying watts.
  // A fitting with `props.iesId` resolves to its photometric profile; `ratio`
  // rescales the file's candela web when the fitting's rated output differs
  // from the tested luminaire's (same optic, different lamp/driver).
  _fittings() {
    const out = [];
    const ies = (typeof PlanIES !== 'undefined') ? PlanIES : null;
    for (const el of AppState.planMarkup.elements) {
      const def = PLAN_DEFS.element(el.type);
      if (!def) continue;
      const isLight = def.group === 'Lighting' || (el.props && el.props.watts != null);
      if (!isLight) continue;
      const p = el.props || {};
      const prof = (ies && p.iesId) ? ies.byId(p.iesId) : null;
      const watts = (p.watts != null) ? p.watts : (def.defaults && def.defaults.watts) || 0;
      // With a profile and no explicit override, the file's own flux is the
      // best figure — it is the luminaire's measured output, not an efficacy
      // guess off nameplate watts.
      const lumens = p.lumens ? Number(p.lumens)
        : (prof ? prof.lumens : watts * this.settings.efficacy);
      if (!(lumens > 0)) continue;
      out.push({
        x: el.x, y: el.y, lumens, prof,
        ratio: (prof && prof.lumens > 0) ? lumens / prof.lumens : 1,
        rot: el.rotation || 0,
      });
    }
    return out;
  },

  // True when at least one fitting is driven by measured photometry.
  usesPhotometry() { return this._fittings().some(f => f.prof); },

  _bbox(fittings) {
    const pm = AppState.planMarkup;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; any = true; };
    // Prefer room extents (lux matters inside rooms); else fittings + margin.
    if (pm.rooms && pm.rooms.length) {
      for (const rm of pm.rooms) for (const p of rm.points) acc(p.x, p.y);
    } else {
      for (const f of fittings) acc(f.x, f.y);
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY };
  },

  _compute() {
    const factor = PlanEngine.factor();
    const fittings = this._fittings();
    if (!factor || !fittings.length) { this._grid = null; return; }
    const box = this._bbox(fittings);
    if (!box) { this._grid = null; return; }
    const step = this.settings.resM / factor;           // grid pitch in world px
    const marginPx = 1 / factor;                          // 1 m margin
    const minX = box.minX - marginPx, minY = box.minY - marginPx;
    const cols = Math.min(400, Math.max(1, Math.ceil((box.maxX - box.minX + 2 * marginPx) / step)));
    const rows = Math.min(400, Math.max(1, Math.ceil((box.maxY - box.minY + 2 * marginPx) / step)));
    const h = this.settings.mountH;
    const halfBeam = (this.settings.beamDeg * Math.PI / 180) / 2;
    const cosHalf = Math.cos(halfBeam);
    const vals = new Float32Array(cols * rows);
    let max = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const wx = minX + (i + 0.5) * step, wy = minY + (j + 0.5) * step;
        let E = 0;
        for (const f of fittings) {
          const dx = wx - f.x, dy = wy - f.y;
          const rM = Math.hypot(dx, dy) * factor;                // horizontal dist (m)
          const d2 = rM * rM + h * h;
          const d = Math.sqrt(d2);
          const cosT = h / d;                                    // nadir cosine
          let I;
          if (f.prof) {
            // Measured web: the angle off nadir, and the azimuth taken into the
            // fitting's own frame so a rotated asymmetric optic points where it
            // is drawn. Canvas y grows downward, hence the negated dy.
            const vDeg = Math.acos(Math.max(-1, Math.min(1, cosT))) * 180 / Math.PI;
            const azim = Math.atan2(-dy, dx) * 180 / Math.PI - f.rot;
            I = PlanIES.intensity(f.prof, vDeg, azim) * f.ratio;
          } else {
            if (cosT < cosHalf) continue;                        // outside beam cone
            I = f.lumens / (2 * Math.PI * (1 - cosHalf) || 1e-6);
          }
          if (I > 0) E += I * cosT / d2;
        }
        vals[j * cols + i] = E;
        if (E > max) max = E;
      }
    }
    this._grid = { minX, minY, step, cols, rows, vals, max };
  },

  // Blue→cyan→green→yellow→red ramp for normalized v∈[0,1].
  _color(v) {
    const hue = 240 - 240 * Math.max(0, Math.min(1, v)); // 240=blue → 0=red
    return `hsl(${hue}, 85%, 50%)`;
  },

  draw(ctx, zoom) {
    if (!this.enabled) return;
    if (!this._grid) this._compute();
    const g = this._grid;
    if (!g || g.max <= 0) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        const v = g.vals[j * g.cols + i] / g.max;
        if (v < 0.02) continue;
        ctx.fillStyle = this._color(v);
        ctx.fillRect(g.minX + i * g.step, g.minY + j * g.step, g.step + 0.5, g.step + 0.5);
      }
    }
    ctx.restore();
  },
};
