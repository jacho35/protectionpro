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
      .replace(/Ē/g, 'E').replace(/ρ/g, 'rho').replace(/₀/g, '0').replace(/γ/g, 'gamma').replace(/θ/g, 'theta')
      .replace(/–/g, '-').replace(/—/g, '-').replace(/✓/g, 'ok');
  },

  _ramp(v) { return `hsl(${240 - 240 * Math.max(0, Math.min(1, v))}, 80%, 50%)`; },

  // False-colour plot of one item on its floor → PNG data URL (null if nothing to draw).
  _plot(it, fl) {
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
      if (kind !== 'perimeter' && kind !== 'escape') ctx.closePath();
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
    path(); ctx.lineWidth = 2.5 / sc; ctx.strokeStyle = kind === 'escape' ? '#dc2626' : kind === 'perimeter' ? '#7c3aed' : '#1f2933'; ctx.stroke();
    const dot = Math.max(3 / sc, 0.1 / f);
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
      else if (kind === 'outdoor' || kind === 'perimeter') draw = outdoorLum;
      else if (kind === 'escape') draw = em;
      if (!draw) continue;
      ctx.beginPath(); ctx.arc(el.x, el.y, dot * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.6 / sc; ctx.strokeStyle = em && kind !== 'room' ? '#dc2626' : '#8a5a00'; ctx.stroke();
    }
    ctx.restore();
    return { png: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
  },

  _lumSchedule(it, fl) {
    const P = it.room.points, groups = {};
    for (const el of ((fl.data && fl.data.elements) || [])) {
      const def = PLAN_DEFS.element(el.type);
      if (!def || def.group !== 'Lighting') continue;
      const outdoorLum = AreaCalc._isOutdoorLight(el), em = EmergCalc._isEm(el);
      const mine = it.kind === 'room' ? (PlanEngine._pointInPoly({ x: el.x, y: el.y }, P) && !outdoorLum && (el.props || {}).kind !== 'emergency' && (el.props || {}).kind !== 'exit')
        : (it.kind === 'outdoor' || it.kind === 'perimeter') ? outdoorLum : em;
      if (!mine) continue;
      const pr = el.props || {}, ph = PhotoLib.get(pr.photoId);
      const key = pr.photoId || 'none';
      const g = groups[key] || (groups[key] = { name: ph ? ph.name : '(no library luminaire)', n: 0, lm: ph ? ph.lumens : 0, w: Number(pr.watts) || (ph ? ph.watts : 0), extra: [] });
      g.n++;
      if (it.kind === 'outdoor' || it.kind === 'perimeter') g.extra = [`${pr.mountH || 8} m high, tilt ${pr.tilt || 0} deg`];
      if (it.kind === 'escape' || (em && it.kind !== 'room')) g.extra = [`emergency output ${EmergCalc._pct(el)} %`];
    }
    return Object.values(groups);
  },

  // What the dialog remembers between reports (this session).
  _last: null,

  // The export dialog: which zones, which sections, what each zone's page holds.
  // Resolves the options, or null when cancelled.
  askOptions(all) {
    const L = this._last || { summary: true, energy: true, detail: true, plot: true, checks: true, lums: true, assump: true, method: true };
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
        return `<label class="lrp-zone${ok ? '' : ' off'}"><input type="checkbox" data-zone="${escHtml(r.id)}"${ok ? '' : ' disabled'}${sel.has(r.id) ? ' checked' : ''}>
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
          </div>
        </div>
        <div class="lrp-foot"><span class="lrp-count" data-role="count" aria-live="polite"></span>
          <button type="button" class="btn-small" data-role="cancel">Cancel</button>
          <button type="button" class="btn-primary" data-role="ok">Create PDF</button></div>
      </div>`;
      const zones = () => [...ov.querySelectorAll('[data-zone]:not(:disabled)')];
      const opts = () => { const o = {}; ov.querySelectorAll('[data-opt]').forEach(c => { o[c.dataset.opt] = c.checked; }); o.ids = zones().filter(c => c.checked).map(c => c.dataset.zone); return o; };
      const refresh = () => {
        const o = opts();
        ov.querySelector('[data-sub]').classList.toggle('dim', !o.detail);
        ov.querySelectorAll('[data-sub] input').forEach(c => { c.disabled = !o.detail; });
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
        r.em ? `${f1(r.em.v, r.em.v < 10 ? 1 : 0)} (${r.em.t})${r.em.ev ? ' min' : ''}` : '-', f1(r.uo, 2),
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
          doc.text(t(it.kind === 'room' || it.kind === 'outdoor'
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
        a.push(['Ceiling / work plane / wall zone', `${L.ceilH} m / ${L.workH} m / ${L.wallZone} m`],
          ['Reflectances (ceiling / walls / floor)', `${L.rhoC} / ${L.rhoW} / ${L.rhoF}`], ['Maintenance factor', L.mf],
          ['Calculation', `Direct light from the photometric data plus diffuse interreflection (radiosity); grid ${res && res.workplane ? res.workplane.step + ' m, ' + res.workplane.n + ' points' : ''}; furniture, windows and doors not modelled`],
          ['UGR', 'CIE 117 at the middle of each wall, eye 1.2 m, initial luminaire flux']);
        if (L.emerg !== 'none') a.push(['Emergency', L.emerg === 'open' ? 'Checked as an open (anti-panic) area' : 'Checked as a high-risk task area']);
      } else if (it.kind === 'outdoor') {
        const L = AreaCalc.readArea(it.room);
        a.push(['Maintenance factor', L.mf], ['Ground reflectance (GR)', L.groundRho], ['Calculation', `Direct light on the ground, grid ${res && res.workplane ? res.workplane.step + ' m' : ''}; GR to CIE 112 at the worst of ${res && res.gr ? res.gr.observers : '-'} observers (eye 1.5 m, eight directions)`]);
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
      'Furniture, partitions, windows and daylight are not modelled; a wall stops light only in the emergency and non-convex-room calculations.',
      'Generic optics are representative distributions for feasibility, not products. Use the manufacturer\'s IES / LDT for a compliance design.',
      'Targets and emergency limits are those of the project\'s lighting standard: indoor EN 12464-1:2021 or SANS 10114-1:2020 (SANS gives only Em, UGR and Ra; Uo, Ez, wall and ceiling targets follow EN 12464-1), emergency EN 1838:1999 or SANS 10114-2:2020, outdoor EN 12464-2:2024. Confirm they are the edition your project requires.',
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
