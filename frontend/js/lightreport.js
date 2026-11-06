/* ProtectionPro — Lighting report (client-side PDF, jsPDF + autoTable).
 *
 * One document for the project: a summary of every room, outdoor area, fence
 * and escape route with its verdict, an energy table, then one section per item
 * — a false-colour plot with the luminaires and isolux lines, the results
 * against the targets, the luminaire schedule and the assumptions the numbers
 * rest on — and a closing page on method. It reports what was last calculated;
 * an item that has no result says so.
 */

const LightReport = {
  _t(s) {
    return String(s == null ? '' : s)
      .replace(/<sub>(.*?)<\/sub>/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/→/g, '->').replace(/←/g, '<-')
      .replace(/Ē/g, 'E').replace(/ρ/g, 'rho').replace(/₀/g, '0').replace(/₁/g, '1').replace(/₂/g, '2').replace(/γ/g, 'gamma').replace(/θ/g, 'theta')
      .replace(/–/g, '-').replace(/—/g, '-').replace(/✓/g, 'ok');
  },

  _ramp(v) { return `hsl(${240 - 240 * Math.max(0, Math.min(1, v))}, 80%, 50%)`; },

  // False-colour plot of one item on its floor → PNG data URL (null if nothing to draw).
  _plot(it, fl) {
    if (it.kind === 'sports') return typeof SportsCalc !== 'undefined' && it.res ? SportsCalc.plotPng(it.room, it.res, it.factor) : null;
    const room = it.room, f = it.factor;
    if (!f || !room.points || room.points.length < 2) return null;
    const xs = room.points.map(p => p.x), ys = room.points.map(p => p.y);
    const res = it.res || it.eres;
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const padX = Math.max((x1 - x0) * 0.06, 1 / f), padY = Math.max((y1 - y0) * 0.06, 1 / f);
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    const W = 1100, s = W / (x1 - x0), H = Math.min(Math.max((y1 - y0) * s, 200), 1400);
    const sc = Math.min(s, H / (y1 - y0));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Math.ceil(H);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
    const kind = it.kind;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(room.points[0].x, room.points[0].y);
      for (let i = 1; i < room.points.length; i++) ctx.lineTo(room.points[i].x, room.points[i].y);
      if (kind !== 'perimeter' && kind !== 'escape' && kind !== 'obtrusive') ctx.closePath();
    };
    const grid = (it.res && it.res.grid) || (it.eres && it.eres.grid);
    if (grid && (kind === 'room' || kind === 'outdoor')) {
      const top = Math.max((it.res && it.res.workplane && it.res.workplane.Emax) || 0, 1e-6);
      const dx = grid.dx / f, dy = grid.dy / f;
      ctx.save(); path(); ctx.clip();
      ctx.globalAlpha = 0.55;
      for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
        const v = grid.values[j * grid.nx + i];
        if (v == null) continue;
        ctx.fillStyle = this._ramp(v / top);
        ctx.fillRect((grid.x0 + i * grid.dx) / f, -(grid.y0 + j * grid.dy + grid.dy) / f, dx + 0.6, dy + 0.6);
      }
      ctx.globalAlpha = 1;
      const L = kind === 'outdoor' ? AreaCalc.readArea(room) : RoomLighting.read(room);
      RoomCalc._contour(ctx, grid, f, L.em, sc, false);
      RoomCalc._contour(ctx, grid, f, L.em * L.uo, sc, true);
      ctx.restore();
    }
    path(); ctx.lineWidth = 2.5 / sc; ctx.strokeStyle = kind === 'escape' ? '#dc2626' : kind === 'perimeter' ? '#7c3aed' : kind === 'obtrusive' ? '#b45309' : '#1f2933'; ctx.stroke();
    const dot = Math.max(3 / sc, 0.1 / f);
    if (kind === 'obtrusive') {
      const lim = ObtrusiveCalc.limit(room).v;
      for (const q of (res && res.profile) || []) {
        ctx.fillStyle = q.E <= lim + 1e-9 ? '#16a34a' : '#dc2626';
        ctx.beginPath(); ctx.arc(q.x / f, -q.y / f, dot * 1.1, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (kind === 'perimeter' || kind === 'escape') {
      const lim = kind === 'perimeter' ? AreaCalc.readPerim(room).evMin : 1;
      for (const q of (res && res.profile) || []) {
        ctx.fillStyle = q.E >= lim ? '#16a34a' : (kind === 'escape' && q.E >= 0.5 ? '#f59e0b' : '#dc2626');
        ctx.beginPath(); ctx.arc(q.x / f, -q.y / f, dot * 1.1, 0, Math.PI * 2); ctx.fill();
      }
    }
    // luminaires
    const P = room.points;
    for (const el of ((fl.data && fl.data.elements) || [])) {
      const def = PLAN_DEFS.element(el.type);
      if (!def || def.group !== 'Lighting') continue;
      const outdoorLum = AreaCalc._isOutdoorLight(el), em = EmergCalc._isEm(el);
      let draw = false;
      if (kind === 'room') draw = PlanEngine._pointInPoly({ x: el.x, y: el.y }, P) && !outdoorLum;
      else if (kind === 'outdoor' || kind === 'perimeter' || kind === 'obtrusive') draw = outdoorLum;
      else if (kind === 'escape') draw = em;
      if (!draw) continue;
      ctx.beginPath(); ctx.arc(el.x, el.y, dot * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.6 / sc; ctx.strokeStyle = em && kind !== 'room' ? '#dc2626' : '#8a5a00'; ctx.stroke();
    }
    ctx.restore();
    return { png: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
  },

  _lumSchedule(it, fl) {
    if (it.kind === 'sports') {
      const groups = {};
      for (const m of SportsCalc.read(it.room).masts) for (const x of (m.floods || [])) {
        const ph = PhotoLib.get(x.photoId), key = (x.photoId || 'none') + '|' + (+m.h || 0);
        const g = groups[key] || (groups[key] = { name: ph ? ph.name : '(no library luminaire)', n: 0, lm: ph ? ph.lumens : 0, w: ph ? ph.watts : 0, masts: new Set(), extra: [] });
        g.n++; g.masts.add(m.name || m.id);
        g.extra = [`on ${g.masts.size} mast${g.masts.size === 1 ? '' : 's'}, ${+m.h || 0} m high, aimed`];
      }
      return Object.values(groups);
    }
    const P = it.room.points, groups = {};
    for (const el of ((fl.data && fl.data.elements) || [])) {
      const def = PLAN_DEFS.element(el.type);
      if (!def || def.group !== 'Lighting') continue;
      const outdoorLum = AreaCalc._isOutdoorLight(el), em = EmergCalc._isEm(el);
      const mine = it.kind === 'room' ? (PlanEngine._pointInPoly({ x: el.x, y: el.y }, P) && !outdoorLum && (el.props || {}).kind !== 'emergency' && (el.props || {}).kind !== 'exit')
        : (it.kind === 'outdoor' || it.kind === 'perimeter' || it.kind === 'obtrusive') ? outdoorLum : em;
      if (!mine) continue;
      const pr = el.props || {}, ph = PhotoLib.get(pr.photoId);
      const key = pr.photoId || 'none';
      const g = groups[key] || (groups[key] = { name: ph ? ph.name : '(no library luminaire)', n: 0, lm: ph ? ph.lumens : 0, w: Number(pr.watts) || (ph ? ph.watts : 0), extra: [] });
      g.n++;
      if (it.kind === 'outdoor' || it.kind === 'perimeter' || it.kind === 'obtrusive') g.extra = [`${pr.mountH || 8} m high, tilt ${pr.tilt || 0} deg`];
      if (it.kind === 'escape' || (em && it.kind !== 'room')) g.extra = [`emergency output ${EmergCalc._pct(el)} %`];
    }
    return Object.values(groups);
  },

  // ─── Sports field: aiming + 3D pages ───
  MAST_COLOURS: ['#1d4ed8', '#c2410c', '#0f766e', '#7e22ce', '#b91c1c', '#4d7c0f', '#0e7490', '#a16207'],
  MAST_DASH: [[], [16, 6], [3, 6], [20, 6, 3, 6], [], [16, 6], [3, 6], [20, 6, 3, 6]],

  // One row per flood on every mast: throw / tilt / direction as in the aiming dialog.
  _aimRows(room) {
    const L = SportsCalc.read(room), rows = [], masts = [];
    for (const m of L.masts) {
      const h = Math.max(+m.h || 20, 0.5), mx = +m.x || 0, my = +m.y || 0;
      let worst = 0;
      (m.floods || []).forEach((fl, i) => {
        const ax = +fl.ax || 0, ay = +fl.ay || 0, d = Math.hypot(ax - mx, ay - my);
        const tilt = Math.atan2(d, h) * 180 / Math.PI, dir = ((Math.atan2(ay - my, ax - mx) * 180 / Math.PI) + 360) % 360;
        const ph = PhotoLib.get(fl.photoId);
        worst = Math.max(worst, tilt);
        rows.push({ mast: m.name || m.id, first: i === 0, n: i + 1, lamp: [mx, my], aim: [ax, ay], lum: ph ? ph.name : '(no library luminaire)',
          pct: SportsCalc._pct(fl.fluxPct), thr: Math.hypot(d, h), tilt, dir, over: tilt > L.maxTilt + 1e-9 });
      });
      masts.push({ name: m.name || m.id, n: (m.floods || []).length, h, tilt: worst });
    }
    return { rows, masts, maxTilt: L.maxTilt };
  },

  // The field with every mast, an aim line per flood and the aim points → { png, w, h } (null if no frame).
  _aimPlanPng(it) {
    try {
      const fr = SportsCalc.frame(it.room, it.factor);
      if (!fr) return null;
      const L = SportsCalc.read(it.room);
      const xs = [0, fr.L], ys = [0, fr.W];
      for (const m of L.masts) { xs.push(+m.x || 0); ys.push(+m.y || 0); for (const fl of (m.floods || [])) { xs.push(+fl.ax || 0); ys.push(+fl.ay || 0); } }
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const pad = Math.max(x1 - x0, y1 - y0) * 0.06; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
      const CW = 1100, s = CW / (x1 - x0), PH = Math.ceil((y1 - y0) * s), LEG = 56;
      const cv = document.createElement('canvas'); cv.width = CW; cv.height = PH + LEG;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.save();
      ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
      ctx.fillStyle = '#e8f1e4'; ctx.fillRect(0, 0, fr.L, fr.W);
      ctx.lineWidth = 2 / s; ctx.strokeStyle = '#475569'; ctx.strokeRect(0, 0, fr.L, fr.W);
      ctx.lineWidth = 1.5 / s; ctx.beginPath(); ctx.moveTo(fr.L / 2, 0); ctx.lineTo(fr.L / 2, fr.W); ctx.stroke();
      const col = (i) => this.MAST_COLOURS[i % this.MAST_COLOURS.length], dash = (i) => this.MAST_DASH[i % this.MAST_DASH.length];
      L.masts.forEach((m, mi) => {
        const mx = +m.x || 0, my = +m.y || 0;
        (m.floods || []).forEach((fl, i) => {
          const ax = +fl.ax || 0, ay = +fl.ay || 0, r = 7 / s;
          ctx.strokeStyle = col(mi); ctx.lineWidth = 2 / s; ctx.setLineDash(dash(mi).map(d => d / s));
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ax, ay); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(ax, ay - r); ctx.lineTo(ax + r, ay); ctx.lineTo(ax, ay + r); ctx.lineTo(ax - r, ay); ctx.closePath();
          ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2 / s; ctx.stroke();
          ctx.fillStyle = '#1a1a2e'; ctx.font = `${15 / s}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(`${m.name || m.id}-F${i + 1}`, ax + 10 / s, ay - 8 / s);
        });
      });
      L.masts.forEach((m, mi) => {
        const mx = +m.x || 0, my = +m.y || 0;
        ctx.beginPath(); ctx.arc(mx, my, 9 / s, 0, Math.PI * 2); ctx.fillStyle = col(mi); ctx.fill(); ctx.lineWidth = 2 / s; ctx.strokeStyle = '#1a1a2e'; ctx.stroke();
        ctx.fillStyle = '#1a1a2e'; ctx.font = `bold ${20 / s}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(m.name || m.id, mx, my + (my < fr.W / 2 ? -16 : 32) / s);
      });
      ctx.restore();
      // key
      ctx.font = '22px Helvetica, Arial, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      let kx = 10;
      L.masts.forEach((m, mi) => {
        const lab = `${m.name || m.id} (${(m.floods || []).length})`, w = ctx.measureText(lab).width;
        if (kx + 60 + w > CW) return;
        ctx.strokeStyle = col(mi); ctx.lineWidth = 4; ctx.setLineDash(dash(mi)); ctx.beginPath(); ctx.moveTo(kx, PH + LEG / 2); ctx.lineTo(kx + 46, PH + LEG / 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#1a1a2e'; ctx.fillText(lab, kx + 54, PH + LEG / 2);
        kx += 54 + w + 28;
      });
      return { png: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
    } catch (_) { return null; }
  },

  // The field in 3D — 'model' (masts, floods, aim lines) or 'render' (lit at night) — drawn off screen with
  // the Lighting tab's own 3D drawing. cam: 'saved' (the 3D tab's angle) | 'corner' (from the first mast) | 'above'.
  _view3dPng(it, mode, cam) {
    let host = null, v = null;
    try {
      if (typeof View3D === 'undefined' || typeof Sports3D === 'undefined') return null;
      const room = it.room, B = Sports3D.bounds(room), C = Sports3D._ctx(room);
      if (!B || !C) return null;
      const CW = 1100, CH = 680;
      host = document.createElement('div');
      host.style.cssText = `position:fixed;left:-12000px;top:0;width:${CW}px;height:${CH}px;visibility:hidden`;
      document.body.appendChild(host);
      v = new View3D(host, {});
      v.canvas.style.cssText = 'width:100%;height:100%;display:block';
      const lit = typeof Light3D !== 'undefined';
      const L3 = { mode, expo: lit ? Light3D.expo : 1.5, sel: null, cones: mode === 'model', walls: 'none' };
      v.onDraw = (vv) => Sports3D.draw(vv, room, L3);
      v.fit(B.min, B.max);
      if (cam === 'above') v.setView(0, 89.5);
      else if (cam === 'corner' && C.L.masts.length) {
        const m = C.L.masts[0], M = C.W(+m.x || 0, +m.y || 0), c = C.W(C.fr.L / 2, C.fr.W / 2);
        const dx = M[0] - c[0], dy = M[1] - c[1], d = Math.hypot(dx, dy) || 1;
        v.setView(Math.atan2(-dx / d, -dy / d) * 180 / Math.PI, 28);
      } else if (lit && Light3D.view && Number.isFinite(Light3D.view.yaw)) v.setView(Light3D.view.yaw, Light3D.view.pitch);
      else v.setView(-32, 36);
      if (v._raf) { cancelAnimationFrame(v._raf); v._raf = 0; }
      v.zoom = 1;
      v.draw();
      const out = document.createElement('canvas'); out.width = CW; out.height = CH;
      const g = out.getContext('2d');
      g.fillStyle = mode === 'render' ? '#0a0d12' : '#ffffff'; g.fillRect(0, 0, CW, CH);
      g.drawImage(v.canvas, 0, 0, CW, CH);
      return { png: out.toDataURL('image/jpeg', 0.92), w: CW, h: CH };
    } catch (_) { return null; }
    finally {
      try { if (v && v._ro) v._ro.disconnect(); if (v && v._raf) cancelAnimationFrame(v._raf); } catch (_) { /* gone */ }
      if (host) host.remove();
    }
  },

  // What the dialog remembers between reports (this session).
  _last: null,

  // The export dialog: which zones, which sections, what each zone's page holds.
  // Resolves the options, or null when cancelled.
  askOptions(all) {
    const L = Object.assign({ summary: true, energy: true, detail: true, plot: true, checks: true, lums: true, assump: true, method: true, aimTable: true, aimPlan: true, v3dModel: true, v3dRender: true, cam: 'saved' }, this._last || {});
    const ready = (r) => !!(r.res || r.eres);
    const sel = new Set(this._last && this._last.ids ? this._last.ids.filter(id => all.some(r => r.id === id && ready(r))) : all.filter(ready).map(r => r.id));
    const floors = [...new Set(all.map(r => r.floor))];
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal plan-floor-modal';
      ov.style.display = 'flex'; ov.style.zIndex = '3000';
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'lrp-title');
      const chk = (k, label, sub) => `<label class="lrp-check"><input type="checkbox" data-opt="${k}"${L[k] ? ' checked' : ''}><span>${label}${sub ? `<small>${sub}</small>` : ''}</span></label>`;
      const zoneRows = floors.map(fl => `<div class="lrp-floor">${escHtml(fl || 'Floor')}</div>` + all.filter(r => r.floor === fl).map(r => {
        const ok = ready(r), vc = r.verdict === 'Pass' ? 'ok' : r.verdict === 'Fail' ? 'bad' : '';
        return `<label class="lrp-zone${ok ? '' : ' off'}"><input type="checkbox" data-zone="${escHtml(r.id)}" data-kind="${escHtml(r.kind)}"${ok ? '' : ' disabled'}${sel.has(r.id) ? ' checked' : ''}>
          <span><b>${escHtml(r.name)}</b><small>${LightingWS.KIND[r.kind]}${ok ? '' : ' · not calculated'}</small></span>
          <span class="lrp-v ${vc}">${ok ? escHtml(r.verdict) + (r.stale ? ' (out of date)' : '') : ''}</span></label>`;
      }).join('')).join('');
      ov.innerHTML = `<div class="modal-content lrp-content">
        <div class="modal-header"><h3 id="lrp-title">Lighting report</h3>
          <button type="button" class="modal-close" data-role="cancel" aria-label="Close">&times;</button></div>
        <div class="lrp-body">
          <div class="lrp-col">
            <div class="lrp-head"><b>Zones to include</b>
              <span><button type="button" class="lw-link" data-role="all">All</button> · <button type="button" class="lw-link" data-role="none">None</button> · <button type="button" class="lw-link" data-role="failing">Failing only</button></span></div>
            <div class="lrp-zones">${zoneRows}</div>
            <small class="lrp-note">A zone with no result can't be reported: press Calculate all first.</small>
          </div>
          <div class="lrp-col">
            <div class="lrp-head"><b>Sections</b></div>
            ${chk('summary', 'Summary table', 'Every selected zone with its verdict')}
            ${chk('energy', 'Energy table', 'Installed power, W/m², LENI (rooms)')}
            ${chk('detail', 'A page for each zone')}
            <div class="lrp-sub" data-sub>
              ${chk('plot', 'False-colour plot', 'With luminaires and isolux lines')}
              ${chk('checks', 'Results against the requirement', 'Checks and extra figures')}
              ${chk('lums', 'Luminaire schedule')}
              ${chk('assump', 'Assumptions and notes')}
            </div>
            ${chk('method', 'Method and limits', 'Closing page')}
            <div class="lrp-sports" data-sports>
              <div class="lrp-head"><b>Sports field pages</b><small data-role="sportsnote"></small></div>
              <div class="lrp-subhead">Aiming of every flood</div>
              ${chk('aimTable', 'Aiming table', 'Every flood on every mast: aim point, luminaire, output %, throw, tilt, direction')}
              ${chk('aimPlan', 'Aiming on the plan', 'Masts, aim lines and aim points drawn on the field')}
              <div class="lrp-subhead">3D views</div>
              ${chk('v3dModel', '3D model view', 'Masts, floods and aim lines as modelled')}
              ${chk('v3dRender', '3D rendered light view', 'The field lit at night from the calculated result')}
              <label class="lrp-cam">Camera for the 3D views
                <select data-cam>${[['saved', 'As in the 3D tab'], ['corner', 'From a corner mast'], ['above', 'From above']].map(([k, n]) => `<option value="${k}"${L.cam === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
            </div>
          </div>
        </div>
        <div class="lrp-foot"><span class="lrp-count" data-role="count" aria-live="polite"></span>
          <button type="button" class="btn-small" data-role="cancel">Cancel</button>
          <button type="button" class="btn-primary" data-role="ok">Create PDF</button></div>
      </div>`;
      const zones = () => [...ov.querySelectorAll('[data-zone]:not(:disabled)')];
      const opts = () => { const o = {}; ov.querySelectorAll('[data-opt]').forEach(c => { o[c.dataset.opt] = c.checked; }); o.ids = zones().filter(c => c.checked).map(c => c.dataset.zone); o.cam = ov.querySelector('[data-cam]').value; return o; };
      const refresh = () => {
        const o = opts();
        ov.querySelector('[data-sub]').classList.toggle('dim', !o.detail);
        ov.querySelectorAll('[data-sub] input').forEach(c => { c.disabled = !o.detail; });
        const nSports = zones().filter(c => c.checked && c.dataset.kind === 'sports').length, spOff = !o.detail || !nSports;
        ov.querySelector('[data-sports]').classList.toggle('dim', spOff);
        ov.querySelectorAll('[data-sports] input, [data-sports] select').forEach(c => { c.disabled = spOff || (c.matches('[data-cam]') && !(o.v3dModel || o.v3dRender)); });
        ov.querySelector('[data-role="sportsnote"]').textContent = nSports ? `${nSports} sports field${nSports === 1 ? '' : 's'} selected` : 'select a sports field to use these';
        const bad = !o.ids.length || !(o.summary || o.energy || o.detail || o.method);
        ov.querySelector('[data-role="ok"]').disabled = bad;
        ov.querySelector('[data-role="count"]').textContent = o.ids.length ? `${o.ids.length} zone${o.ids.length === 1 ? '' : 's'} selected` : 'Select at least one zone';
      };
      refresh();
      const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('change', refresh);
      ov.addEventListener('click', (e) => {
        const r = e.target.closest('[data-role]'); const role = r && r.dataset.role;
        if (role === 'all' || role === 'none' || role === 'failing') {
          zones().forEach(c => { const it = all.find(x => x.id === c.dataset.zone); c.checked = role === 'all' || (role === 'failing' && it.verdict === 'Fail'); });
          refresh();
        } else if (role === 'ok') { const o = opts(); this._last = o; done(o); }
        else if (role === 'cancel' || e.target === ov) done(null);
      });
      document.body.appendChild(ov);
      requestAnimationFrame(() => { try { ov.querySelector('[data-role="ok"]').focus(); } catch (_) { /* gone */ } });
    });
  },

  async export(opts) {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const all = LightingWS._items();
    if (!all.some(r => r.res || r.eres)) { await UI.alert('Calculate first: the report needs at least one result. Open Lighting and press Calculate all.'); return; }
    if (!opts) opts = await this.askOptions(all);
    if (!opts) return;
    const ids = new Set(opts.ids);
    const items = all.filter(r => ids.has(r.id));
    const done = items.filter(r => r.res || r.eres);
    if (!done.length) return;
    const t = (s) => this._t(s);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const M = 14, W = 210 - 2 * M, PH = 297;
    const blue = [0, 120, 215];
    const tbl = (opts) => doc.autoTable(Object.assign({
      margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' },
      headStyles: { fillColor: blue, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [246, 247, 249] },
    }, opts));
    let y = M + 4;
    const next = (gap = 7) => (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + gap;
    const heading = (txt, at, need = 40, size = 11) => {
      let yy = at;
      if (yy > PH - M - need) { doc.addPage(); yy = M + 4; doc.lastAutoTable = null; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(26, 26, 46);
      doc.text(t(txt), M, yy);
      return yy + 2;
    };
    const f1 = (v, dp = 1) => v == null ? '-' : Number(v).toFixed(dp);
    const verdictColor = (v) => v === 'Pass' ? [46, 125, 50] : v === 'Fail' ? [179, 38, 30] : [120, 120, 120];

    // ── Title and summary ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 26, 46);
    doc.text('Lighting Design Report', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    y += 6;
    doc.text(t(`${AppState.projectName || 'Untitled Project'}  |  ${new Date().toLocaleDateString()}`), M, y);
    y += 4.5;
    const pass = items.filter(r => r.verdict === 'Pass').length, fail = items.filter(r => r.verdict === 'Fail').length;
    const pend = items.length - pass - fail;
    doc.text(t(`${items.length} item${items.length === 1 ? '' : 's'}: ${pass} pass, ${fail} fail${pend ? `, ${pend} not calculated` : ''}. Illuminance values are maintained values.`), M, y);
    y += 3;
    let sec = 0;
    if (opts.summary) {
    y = heading(`${++sec}. Summary`, y + 7, 30);
    tbl({
      startY: y + 1,
      head: [['Room / area', 'Floor', 'Type', 'Em lx (target)', 'U0', 'UGR / GR', 'W/m2', 'Emergency', 'Verdict']],
      body: items.map(r => [t(r.name), t(r.floor), LightingWS.KIND[r.kind],
        r.em ? `${f1(r.em.v, r.em.v < 10 ? 1 : 0)} (${r.em.t})${r.em.ev ? (r.em.max ? ' max' : ' min') : ''}` : '-', f1(r.uo, 2),
        r.glare ? `${r.glare.label} ${f1(r.glare.v)} (${r.glare.t})` : '-', f1(r.wm2), t(r.emText), r.verdict + (r.stale ? ' *' : '')]),
      styles: { fontSize: 8, cellPadding: 1.4 },
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === 8) d.cell.styles.textColor = verdictColor(String(d.cell.raw).replace(' *', '')); },
    });
    if (items.some(r => r.stale)) { doc.setFontSize(8); doc.setTextColor(120); doc.text('* The room or its fittings changed after this result was calculated.', M, next(4)); doc.setTextColor(26, 26, 46); }
    }

    // ── Energy ──
    const rooms = items.filter(r => r.kind === 'room' && r.res);
    if (opts.energy && rooms.length) {
      y = heading(`${++sec}. Energy`, opts.summary ? next(9) : y + 7, 40);
      let tw = 0, ta = 0, tk = 0;
      const body = rooms.map(r => {
        const L = RoomLighting.read(r.room);
        tw += r.watts; ta += r.area; tk += r.kwh || 0;
        return [t(r.name), t(r.floor), f1(r.area, 1), f1(r.watts, 0), f1(r.wm2, 2), r.res.power && r.res.power.wm2per100lx != null ? f1(r.res.power.wm2per100lx, 2) : '-',
          `${L.tD} / ${L.tN}`, f1(r.leni, 1), L.lpd > 0 ? `${f1(r.wm2, 1)} vs ${L.lpd}` : '-'];
      });
      body.push([{ content: 'Total', styles: { fontStyle: 'bold' } }, '', f1(ta, 1), f1(tw, 0), f1(ta ? tw / ta : 0, 2), '', '', ta ? f1(tk / ta, 1) : '-', '']);
      tbl({
        startY: y + 1, head: [['Room', 'Floor', 'Area m2', 'Installed W', 'W/m2', 'W/m2/100 lx', 'Day / night h', 'LENI kWh/m2.yr', 'Limit W/m2']], body,
        styles: { fontSize: 8, cellPadding: 1.4 },
      });
      doc.setFontSize(8); doc.setTextColor(110);
      doc.text('LENI by the EN 15193-1 quick method: installed power x constant-illuminance, occupancy and daylight factors x operating hours. Parasitic and emergency standby energy are not included.', M, next(4), { maxWidth: W });
      doc.setTextColor(26, 26, 46);
    }

    // ── One section per item ──
    let n = 0;
    const floorById = {}; for (const fl of AppState.planFloors()) floorById[fl.id] = fl;
    const detailSec = opts.detail ? ++sec : 0;
    let fresh = !(opts.summary || (opts.energy && rooms.length));   // nothing but the title on page 1 yet
    for (const it of (opts.detail ? done : [])) {
      const fl = floorById[it.floorId];
      if (!fl) continue;
      n++;
      if (fresh) { fresh = false; y += 10; } else { doc.addPage(); y = M + 4; }
      doc.lastAutoTable = null;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(26, 26, 46);
      doc.text(t(`${detailSec}.${n}  ${it.name}`), M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
      y += 5;
      doc.text(t(`${LightingWS.KIND[it.kind]}  |  ${it.floor}${it.task ? '  |  ' + it.task : ''}`), M, y);
      y += 4;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...verdictColor(it.verdict));
      doc.text(it.verdict + (it.stale ? ' (out of date)' : ''), M, y + 2);
      doc.setTextColor(26, 26, 46);
      y += 5;
      try {
        const p = opts.plot ? this._plot(it, fl) : null;
        if (p) {
          const h = Math.min(W * p.h / p.w, 80);
          doc.addImage(p.png, 'PNG', M, y, h === 80 ? 80 * p.w / p.h : W, h);
          y += h + 2;
          doc.setFontSize(7.5); doc.setTextColor(110);
          doc.text(t(it.kind === 'sports'
            ? 'False colour = horizontal illuminance on the playing area (blue low, red high), values in lux at each grid point. Circles = masts; numbered diamonds = glare observers.'
            : it.kind === 'obtrusive'
            ? 'Dots along the check line: green within the zone limit (Ev on a property, TI on a road), red above it. Circles = outdoor luminaires.'
            : it.kind === 'room' || it.kind === 'outdoor'
            ? 'False colour = illuminance on the work plane / ground (blue low, red high). Solid line = target Em, dashed = minimum point value (Em x U0). Circles = luminaires.'
            : 'Dots: green meets the requirement, red does not (amber on a route = between 0.5 and 1 lx). Circles = luminaires.'), M, y + 1, { maxWidth: W });
          doc.setTextColor(26, 26, 46);
          y += 11;
        }
      } catch (_) { /* the tables carry the data */ }

      // results
      const checks = opts.checks ? [].concat((it.res && it.res.checks) || [], (it.eres && it.eres.checks) || []) : [];
      if (checks.length) {
        y = heading('Results against the requirement', y, 40, 10);
        tbl({
          startY: y + 1, head: [['Quantity', 'Result', 'Requirement', 'Verdict']],
          body: checks.map(c => [t(c.label), c.value == null ? '-' : (c.unit === ':1' ? (c.value >= 1e8 ? 'inf' : c.value.toFixed(0)) : c.value.toFixed(c.unit === 'lx' ? 1 : 2)) + (c.unit && c.unit !== ':1' ? ' ' + c.unit : c.unit === ':1' ? ':1' : ''),
            `${c.op === '>=' ? '>=' : '<='} ${c.req}${c.unit === ':1' ? ':1' : c.unit ? ' ' + c.unit : ''}`, c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : '-']),
          didParseCell: (d) => { if (d.section === 'body' && d.column.index === 3) d.cell.styles.textColor = verdictColor(d.cell.raw); },
        });
      }
      // extra figures
      const res = it.res, rows = [];
      if (res && res.workplane) rows.push(['Illuminance min / max', `${f1(res.workplane.Emin, 1)} / ${f1(res.workplane.Emax, 1)} lx`]);
      if (res && res.walls) rows.push(['Walls / ceiling / floor mean', `${f1(res.walls.Em, 0)} / ${f1(res.ceiling.Em, 0)} / ${f1(res.floor.Em, 0)} lx`]);
      if (res && res.cylindrical) rows.push(['Cylindrical Ez (mean / min)', `${f1(res.cylindrical.Ez, 0)} / ${f1(res.cylindrical.Ezmin, 0)} lx`]);
      if (res && res.vertical) rows.push(['Vertical Ev min / avg / max', `${res.vertical.Evmin} / ${res.vertical.Evavg} / ${res.vertical.Evmax} lx over ${res.length} m`]);
      if (res && res.kind === 'property' && it.kind === 'obtrusive') {
        rows.push(['Ev max / average', `${f1(res.Evmax, 2)} / ${f1(res.Evavg, 2)} lx at ${res.heights.join(', ')} m`], ['I max towards the property', `${Math.round(res.Imax)} cd`],
          ['Upward light ratio (installation / worst luminaire)', `${f1(res.rul.rul, 2)} / ${f1(res.rul.worst, 1)} %`]);
        if (res.Lb != null) rows.push(['Facade luminance Lb', `${f1(res.Lb, 2)} cd/m2`]);
      }
      if (res && res.kind === 'road' && it.kind === 'obtrusive') rows.push(['TI max', `${f1(res.TImax, 1)} % at La ${res.La} cd/m2`]);
      if (res && res.horizontal) {
        const hz = res.horizontal;
        rows.push(['Horizontal Eh avg / min / max', `${f1(hz.Eav, 0)} / ${f1(hz.Emin, 0)} / ${f1(hz.Emax, 0)} lx`], ['U1 / U2', `${f1(hz.U1, 2)} / ${f1(hz.U2, 2)}`],
          ['Grid', `${hz.nx} x ${hz.ny} points, ${f1(hz.dx, 2)} x ${f1(hz.dy, 2)} m`]);
        if (res.gr) rows.push(['GR max', `${f1(res.gr.max, 1)} at ${f1(res.gr.at.x, 1)}, ${f1(res.gr.at.y, 1)} m`]);
        for (const c of (res.cameras || [])) rows.push([`Ev towards ${c.name}`, `${f1(c.Eav, 0)} lx avg, min/avg ${f1(c.U2, 2)}`]);
        const pl = (res.players && res.players.directions) || [];
        if (pl.length) rows.push([`Ev players (${res.players.height} m), lowest of 4 directions`, `${f1(Math.min(...pl.map(p => p.Eav)), 0)} lx avg`]);
        if (res.aiming && res.aiming.maxTilt != null) rows.push(['Steepest flood tilt', `${f1(res.aiming.maxTilt, 1)} deg from vertical`]);
        for (const st of (res.stands || [])) if (!st.error) rows.push([`Stand ${st.name}: seats Eh / faces Ev / GR`, `${f1(st.seats.Eav, 0)} lx / ${f1(st.faces.Eav, 0)} lx / ${st.gr ? f1(st.gr.max, 1) : '-'}`]);
        for (const l of ((res.aerial && res.aerial.layers) || [])) rows.push([`Aerial ${l.height} m: Eh / Ev (4 planes) / U2`, `${f1(l.Ehavg, 0)} lx / ${f1(l.Evavg, 0)} lx / ${f1(l.U2, 2)}`]);
      }
      if (res && res.power && it.kind !== 'perimeter') rows.push(['Installed power', `${f1(res.power.watts, 0)} W  (${f1(res.power.wm2, 2)} W/m2)`]);
      if (it.eres && it.eres.floor) rows.push(['Emergency floor Emin / Emax', `${f1(it.eres.floor.Emin, 2)} / ${f1(it.eres.floor.Emax, 2)} lx`]);
      if (it.eres && it.eres.centre) rows.push(['Emergency centre line min / max', `${f1(it.eres.centre.Emin, 2)} / ${f1(it.eres.centre.Emax, 2)} lx`]);
      if (opts.checks && rows.length) tbl({ startY: next(3), head: [['Quantity', 'Value']], body: rows, columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } } });

      // luminaires
      const lums = opts.lums ? this._lumSchedule(it, fl) : [];
      if (opts.lums) y = heading('Luminaires', next(7), 35, 10);
      if (opts.lums && lums.length) {
        tbl({ startY: y + 1, head: [['Luminaire', 'Qty', 'Flux each', 'Power each', 'Notes']],
          body: lums.map(g => [t(g.name), g.n, g.lm ? `${Math.round(g.lm)} lm` : '-', g.w ? `${Math.round(g.w)} W` : '-', t(g.extra.join('; '))]) });
      } else if (opts.lums) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('None placed.', M, y + 5); }

      // assumptions
      const a = [];
      if (it.kind === 'room') {
        const L = RoomLighting.read(it.room);
        const sec = typeof RoomSection !== 'undefined' ? RoomSection.get(it.room) : { type: 'flat' };
        const ch = sec.type !== 'flat' && res && res.ceilingHeight;
        a.push(['Ceiling / work plane / wall zone', `${ch ? `${RoomSection.TYPES[sec.type]}, ${ch.min.toFixed(2)}–${ch.max.toFixed(2)} m` : L.ceilH + ' m'} / ${L.workH} m / ${L.wallZone} m`],
          ['Reflectances (ceiling / walls / floor)', `${L.rhoC} / ${L.rhoW} / ${L.rhoF}`], ['Maintenance factor', L.mf],
          ['Calculation', `Direct light from the photometric data plus diffuse interreflection (radiosity); grid ${res && res.workplane ? res.workplane.step + ' m, ' + res.workplane.n + ' points' : ''}; ${(() => {
            const sc = it.room.scene || {};
            const nb = (sc.objects || []).filter(o => o.blocks !== false).length, no = (sc.openings || []).length;
            return nb || no ? `${nb} object${nb === 1 ? '' : 's'} casting shadows, ${no} window${no === 1 ? '' : 's'} / door${no === 1 ? '' : 's'} (no daylight)` : 'no furniture, windows or doors entered';
          })()}`],
          ['UGR', 'CIE 117 at the middle of each wall, eye 1.2 m, initial luminaire flux']);
        if (L.emerg !== 'none') a.push(['Emergency', L.emerg === 'open' ? 'Checked as an open (anti-panic) area' : 'Checked as a high-risk task area']);
      } else if (it.kind === 'outdoor') {
        const L = AreaCalc.readArea(it.room);
        a.push(['Maintenance factor', L.mf], ['Ground reflectance (GR)', L.groundRho], ['Calculation', `Direct light on the ground, grid ${res && res.workplane ? res.workplane.step + ' m' : ''}; GR to CIE 112 at the worst of ${res && res.gr ? res.gr.observers : '-'} observers (eye 1.5 m, eight directions)`]);
      } else if (it.kind === 'obtrusive') {
        const L = ObtrusiveCalc.read(it.room);
        a.push(['Check', L.check === 'road' ? `Road (${L.roadClass === 'none' ? 'no road lighting' : L.roadClass})` : `Property, face ${L.side}, heights ${L.heights.join(', ')} m`],
          ['Environmental zone', `${OBTRUSIVE_ZONES[L.zone].name}, ${L.curfew}-curfew${L.curfew === 'post' ? `, output ${L.postPct} %` : ''}`],
          ['Calculation', 'Initial flux (no maintenance factor), direct light from every outdoor luminaire on the floor; limits EN 12464-2:2024 Table 4 / Table 5']);
      } else if (it.kind === 'sports') {
        const L = SportsCalc.read(it.room);
        a.push(['Sport and class', `${SPORTS_FIELDS[L.sport].name}, Class ${L.cls} (provisional EN 12193 targets, edited: ${L.edited ? 'yes' : 'no'})`],
          ['Playing area', res ? `${f1(res.length, 1)} x ${f1(res.width, 1)} m` : '-'], ['Maintenance factor', L.mf], ['Ground reflectance (GR)', L.groundRho],
          ['Calculation', 'Direct light from aimed floodlights on the playing area; vertical planes at ' + L.evHeight + ' m; GR to CIE 112 at 15 observers (eye 1.5 m, every 45 deg)'],
          ['Ra', `>= ${L.ra} required - check the floodlight data sheet`]);
      } else if (it.kind === 'perimeter') {
        const L = AreaCalc.readPerim(it.room);
        a.push(['Face measured', L.closed ? (L.side === 'in' ? 'inward' : 'outward') : (L.side === 'left' ? 'left of the line as drawn' : 'right of the line as drawn')],
          ['Height / spacing', `${L.height} m / ${L.step} m`], ['Maintenance factor', L.mf], ['Calculation', 'Vertical illuminance, direct light only']);
      } else {
        const L = EmergCalc.readRoute(it.room);
        a.push(['Width', `${L.width} m`], ['Calculation', 'Floor illuminance, direct light only, luminaires at their emergency output, a wall stops the light']);
      }
      if (opts.assump) {
      y = heading('Assumptions', next(7), 35, 10);
      tbl({ startY: y + 1, head: [['Item', 'Value']], body: a.map(r => [t(r[0]), t(r[1])]), columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } } });
      }
      const warns = !opts.assump ? [] : [].concat((res && res.warnings) || [], (res && res.notes) || [], (it.eres && it.eres.notes) || []);
      if (warns.length) {
        doc.setFontSize(8); doc.setTextColor(138, 90, 0);
        doc.text(warns.map(w => t('Note: ' + w)), M, next(5), { maxWidth: W });
        doc.setTextColor(26, 26, 46);
      }

      // sports field: aiming of every flood, and the 3D views
      if (it.kind === 'sports' && (opts.aimTable || opts.aimPlan || opts.v3dModel || opts.v3dRender)) {
        let sub = 0;
        const page = (title) => {
          doc.addPage(); doc.lastAutoTable = null; y = M + 4;
          doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(26, 26, 46);
          doc.text(t(`${detailSec}.${n}  ${it.name}`), M, y);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
          doc.text(t(`${LightingWS.KIND[it.kind]}  |  ${it.floor}`), M, y + 5);
          y += 11;
          y = heading(`${detailSec}.${n}.${++sub}  ${title}`, y, 20, 11) + 3;
        };
        const aim = (opts.aimTable || opts.aimPlan) ? this._aimRows(it.room) : null;
        const para = (txt) => { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60); const ln = doc.splitTextToSize(t(txt), W); doc.text(ln, M, y); y += ln.length * 4.2 + 2; doc.setTextColor(26, 26, 46); };
        if (opts.aimTable) {
          page('Aiming of every flood');
          para(`Aim points are in field metres: x along the length from the first corner, y across. Throw is the distance from the luminaire to its aim point; tilt is measured from straight down (limit ${aim.maxTilt} deg, rows over it in red); direction from the length axis.`);
          if (aim.rows.length) {
            tbl({ startY: y, head: [['Mast', 'Flood', 'Mast x, y (m)', 'Aim x, y (m)', 'Luminaire', 'Output', 'Throw (m)', 'Tilt (deg)', 'Dir (deg)']],
              body: aim.rows.map(r => [r.first ? t(r.mast) : '', 'F' + r.n, r.first ? `${f1(r.lamp[0])}, ${f1(r.lamp[1])}` : '', `${f1(r.aim[0])}, ${f1(r.aim[1])}`, t(r.lum), `${Math.round(r.pct)} %`, f1(r.thr), f1(r.tilt), Math.round(r.dir)]),
              styles: { fontSize: 8, cellPadding: 1.3 },
              columnStyles: { 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
              didParseCell: (d) => { if (d.section === 'body' && aim.rows[d.row.index] && aim.rows[d.row.index].over && d.column.index === 7) { d.cell.styles.textColor = [179, 38, 30]; d.cell.styles.fontStyle = 'bold'; } if (d.section === 'body' && d.column.index === 0) d.cell.styles.fontStyle = 'bold'; } });
            y = next(6);
            y = heading('Per mast', y, 30, 10) + 1;
            tbl({ startY: y, head: [['Mast', 'Floods', 'Height (m)', 'Steepest tilt (deg)']], tableWidth: 110,
              body: aim.masts.map(m => [t(m.name), m.n, f1(m.h), f1(m.tilt)]), columnStyles: { 0: { fontStyle: 'bold' } } });
          } else para('No floods on any mast.');
        }
        if (opts.aimPlan) {
          const pl = this._aimPlanPng(it);
          page('Aiming on the plan');
          if (pl) {
            para('Each line runs from a mast to the point one of its floods is aimed at. Diamonds are the aim points, labelled mast and flood; the aiming table lists the same figures.');
            const h = Math.min(W * pl.h / pl.w, PH - M - y - 12), w = h * pl.w / pl.h;
            doc.addImage(pl.png, 'PNG', M, y, w, h);
          } else para('The plan could not be drawn: calibrate the plan scale and draw the field first.');
        }
        if (opts.v3dModel || opts.v3dRender) {
          const views = [];
          if (opts.v3dModel) views.push(['Model', this._view3dPng(it, 'model', opts.cam)]);
          if (opts.v3dRender) views.push(['Rendered light, at night', this._view3dPng(it, 'render', opts.cam)]);
          page(views.length > 1 ? '3D views' : '3D view');
          const camName = { saved: 'camera as in the 3D tab', corner: 'camera at the first mast', above: 'camera from above' }[opts.cam] || '';
          const room = Math.floor((PH - M - y - 8 * views.length) / views.length);
          for (const [name, im] of views) {
            doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.text(t(`${name}  (${camName})`), M, y);
            y += 2;
            if (im) {
              const h = Math.min(W * im.h / im.w, room - 4), w = h * im.w / im.h;
              doc.addImage(im.png, 'JPEG', M, y, w, h);
              y += h + 8;
            } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('This view could not be drawn.', M, y + 5); y += 12; }
          }
        }
      }
    }

    // ── Method ──
    if (opts.method) {
    if (!(opts.summary || (opts.energy && rooms.length) || (opts.detail && n))) { y += 10; } else { doc.addPage(); y = M + 4; }
    doc.lastAutoTable = null;
    y = heading('Method and limits of this report', y, 30, 13);
    const bullets = [
      'Illuminance is calculated from each luminaire\'s photometric data (IES / LDT or a generic optic) as E = I x cos(theta) / d2, multiplied by the maintenance factor.',
      'Indoors, light reflected between the floor, walls and ceiling is included by diffuse (Lambertian) radiosity; the solution conserves the emitted flux. Outdoors and for emergency lighting only direct light counts.',
      'UGR follows CIE 117 with the Guth position index, evaluated at the standard observer positions with the initial luminaire flux. GR follows CIE 112.',
      'Furniture, partitions and columns entered in the 3D view cast shadows and reflect light with their own reflectance; work-plane points inside them are left out. Windows and doors take their own reflectance in the interreflection. Daylight is not modelled; a wall stops light in the emergency and non-convex-room calculations.',
      'Generic optics are representative distributions for feasibility, not products. Use the manufacturer\'s IES / LDT for a compliance design.',
      'Targets and emergency limits are those of the project\'s lighting standard: indoor EN 12464-1:2021 or SANS 10114-1:2020 (SANS gives only Em, UGR and Ra; Uo, Ez, wall and ceiling targets follow EN 12464-1), emergency EN 1838:1999 or SANS 10114-2:2020, outdoor EN 12464-2:2024; sports fields use provisional EN 12193 class targets. Confirm they are the edition your project requires.',
    ];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    let by = y + 5;
    for (const b of bullets) { const lines = doc.splitTextToSize('- ' + t(b), W); doc.text(lines, M, by); by += lines.length * 4.6 + 2; }
    }

    // page numbers
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(130);
      doc.text(`${t(AppState.projectName || 'Lighting report')}  |  page ${p} of ${pages}`, M, PH - 7);
    }
    const name = (AppState.projectName || 'project').replace(/[^\w-]+/g, '_');
    doc.save(`${name}_lighting_report.pdf`);
  },
};
