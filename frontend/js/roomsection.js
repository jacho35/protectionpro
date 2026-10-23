/**
 * RoomSection — a room's ceiling as a cross-section (`room.section`): flat,
 * pitched, mono-pitch, barrel or a drawn polyline, cut across the room and
 * extruded along it. The ridge (the extrusion direction) runs along one of the
 * room's walls, or at a typed angle. Sent to /api/analysis/room-lighting as
 * `ceiling: { angle, s0, points:[[s, z]…] }` in the engine's frame (plan metres,
 * y up): s runs across the room from s0, the far side of the room at s = W.
 *
 *   room.section = { type: 'flat'|'gable'|'mono'|'barrel'|'poly', wall, angle,
 *     eaves, apex, apexAt, low, high, crown, points:[[s, z]…], width }
 *
 * `wall` = index of the wall the ridge runs along (-1 = `angle`, degrees on the
 * plan, counter-clockwise from east). A drawn section keeps the width it was
 * drawn at and is stretched if the room changes size. The room's flat ceiling
 * height (`lighting.ceilH`) follows the section's lowest point, so the parts
 * that only know one height (emergency lighting) stay on the safe side.
 *
 * Pure parts (`profile`, `axis`, `request`) run in node: testing/unit/roomsection.test.js.
 */
const RoomSection = {
  TYPES: {
    flat: 'Flat',
    gable: 'Pitched (gable)',
    mono: 'Mono-pitch (lean-to)',
    barrel: 'Barrel vault',
    poly: 'Drawn section',
  },

  get(room) {
    const s = room && room.section;
    return s && typeof s === 'object' && this.TYPES[s.type] ? s : { type: 'flat' };
  },

  // Starting values for a type, from the room's flat height.
  defaults(type, h) {
    const H = Number.isFinite(+h) && +h > 0 ? +h : 2.7;
    if (type === 'gable') return { eaves: H, apex: +(H + 1.5).toFixed(2), apexAt: 0.5 };
    if (type === 'mono') return { low: H, high: +(H + 1.5).toFixed(2) };
    if (type === 'barrel') return { eaves: H, crown: +(H + 1.5).toFixed(2) };
    return {};
  },

  _num(v, d) { const x = Number(v); return Number.isFinite(x) ? x : d; },

  // The section as [[s, z]…], s from 0 to W (metres).
  profile(sec, W) {
    const n = (k, d) => this._num(sec[k], d);
    if (!(W > 0)) return [];
    if (sec.type === 'gable') {
      const a = Math.min(Math.max(n('apexAt', 0.5), 0), 1);
      return [[0, n('eaves', 2.7)], [a * W, n('apex', 4)], [W, n('eaves', 2.7)]];
    }
    if (sec.type === 'mono') {
      const p = [[0, n('low', 2.7)], [W, n('high', 4)]];
      return sec.flip ? [[0, p[1][1]], [W, p[0][1]]] : p;
    }
    if (sec.type === 'barrel') {
      // circular segment through both eaves and the crown
      const e = n('eaves', 2.7), r = Math.max(n('crown', 4) - e, 0);
      if (r < 1e-6) return [[0, e], [W, e]];
      const R = (W * W / 4 + r * r) / (2 * r), N = 24, out = [];
      for (let i = 0; i <= N; i++) {
        const s = W * i / N, dx = s - W / 2;
        out.push([s, e + Math.sqrt(Math.max(R * R - dx * dx, 0)) - (R - r)]);
      }
      return out;
    }
    if (sec.type === 'poly' && Array.isArray(sec.points) && sec.points.length >= 2) {
      const w0 = this._num(sec.width, 0) > 0 ? +sec.width : W, k = W / w0;
      return sec.points.map(p => [this._num(p[0], 0) * k, this._num(p[1], 2.7)]);
    }
    return [];
  },

  // Across-direction u (unit, engine frame) and the room's extent along it.
  // `poly` is the outline in engine coordinates [[x, y]…] (plan metres, y up).
  axis(sec, poly) {
    let ux, uy;
    const w = Number.isInteger(sec.wall) ? sec.wall : this.longestWall(poly);
    if (w >= 0 && w < poly.length) {
      const a = poly[w], b = poly[(w + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      ux = -(b[1] - a[1]) / L; uy = (b[0] - a[0]) / L;            // square to the ridge
    } else {
      const t = this._num(sec.angle, 0) * Math.PI / 180;            // ridge direction
      ux = -Math.sin(t); uy = Math.cos(t);
    }
    const ss = poly.map(p => p[0] * ux + p[1] * uy);
    const s0 = Math.min(...ss);
    return { ux, uy, s0, W: Math.max(...ss) - s0 };
  },

  longestWall(poly) {
    let best = -1, idx = 0;
    poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > best) { best = L; idx = i; } });
    return idx;
  },

  // The `ceiling` part of the room request, or undefined for a flat ceiling.
  request(room, poly) {
    const sec = this.get(room);
    if (sec.type === 'flat' || !poly || poly.length < 3) return undefined;
    const ax = this.axis(sec, poly);
    const pts = this.profile(sec, ax.W);
    if (pts.length < 2) return undefined;
    return { angle: +(Math.atan2(ax.uy, ax.ux) * 180 / Math.PI).toFixed(6), s0: +ax.s0.toFixed(6),
      points: pts.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]) };
  },

  heights(room, poly) {
    const sec = this.get(room);
    if (sec.type === 'flat') return null;
    const pts = this.profile(sec, this.axis(sec, poly).W);
    return pts.length ? { min: Math.min(...pts.map(p => p[1])), max: Math.max(...pts.map(p => p[1])) } : null;
  },

  // Why the section can't be used, or ''.
  problem(sec, W) {
    if (sec.type === 'flat') return '';
    const p = this.profile(sec, W);
    if (p.length < 2) return 'The section needs at least two points.';
    for (let i = 1; i < p.length; i++) if (p[i][0] < p[i - 1][0] - 1e-9) return 'The section must run one way across the room (no overhangs).';
    if (p.some(q => q[1] < 1)) return 'Ceiling heights must be at least 1 m.';
    return '';
  },

  // ─── Browser parts ───

  _poly(room) {
    const f = PlanEngine.factor();
    return f ? room.points.map(p => [p.x * f, -p.y * f]) : null;
  },

  // After a change: the flat height follows the lowest point of the section.
  _commit(room) {
    const poly = this._poly(room), h = poly && this.heights(room, poly);
    if (h) RoomLighting.set(room, 'ceilH', +h.min.toFixed(2));
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
  },

  _wallOptions(room, sec) {
    const poly = this._poly(room) || room.points.map(p => [p.x, -p.y]);
    const cur = Number.isInteger(sec.wall) ? sec.wall : this.longestWall(poly);
    return poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length];
      return `<option value="${i}"${i === cur ? ' selected' : ''}>Wall ${i + 1} — ${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(2)} m</option>`;
    }).join('') + `<option value="-1"${cur === -1 ? ' selected' : ''}>At an angle…</option>`;
  },

  panel(room) {
    const sec = this.get(room), poly = this._poly(room);
    const h = poly && this.heights(room, poly);
    const W = poly ? this.axis(sec, poly).W : 0;
    const why = poly ? this.problem(sec, W) : '';
    const num = (k, label, v, extra) => `<label class="plan-field"><span>${label}</span><input type="number" data-rsec="${k}" value="${numAttr(v)}" ${extra || 'step="0.1" min="1"'} style="width:100%"><small>m</small></label>`;
    let fields = '';
    if (sec.type === 'gable') fields = num('eaves', 'Eaves', sec.eaves) + num('apex', 'Apex', sec.apex)
      + `<label class="plan-field"><span>Apex at</span><input type="number" data-rsec="apexAt" value="${numAttr(Math.round(this._num(sec.apexAt, 0.5) * 100))}" step="5" min="0" max="100" style="width:100%"><small>% across</small></label>`;
    else if (sec.type === 'mono') fields = num('low', 'Low side', sec.low) + num('high', 'High side', sec.high)
      + `<label class="plan-field-check" style="align-self:end"><input type="checkbox" data-rsec="flip"${sec.flip ? ' checked' : ''}> Other way round</label>`;
    else if (sec.type === 'barrel') fields = num('eaves', 'Springing', sec.eaves) + num('crown', 'Crown', sec.crown);
    else if (sec.type === 'poly') fields = `<div class="sf-note" style="grid-column:1/-1">${(sec.points || []).length} points, drawn ${numAttr(sec.width)} m across.</div>`;
    return `<div class="rsec" data-rsec-room="${escHtml(room.id)}" style="margin:6px 0">
      <label class="plan-field"><span>Ceiling</span><select data-rsec="type" style="width:100%">${Object.entries(this.TYPES).map(([k, n]) => `<option value="${k}"${k === sec.type ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select></label>
      ${sec.type === 'flat' ? '' : `
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">${fields}</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        <label class="plan-field"><span>Ridge runs along</span><select data-rsec="wall" style="width:100%">${this._wallOptions(room, sec)}</select></label>
        ${sec.wall === -1 ? `<label class="plan-field"><span>Ridge angle</span><input type="number" data-rsec="angle" value="${numAttr(this._num(sec.angle, 0))}" step="5" style="width:100%"><small>° from east</small></label>` : '<span></span>'}
      </div>
      ${why ? `<div class="sf-note rs-why">${escHtml(why)}</div>` : h ? `<div class="sf-note">${W.toFixed(2)} m across · ceiling ${h.min.toFixed(2)}–${h.max.toFixed(2)} m. The flat-ceiling height follows the lowest point (used by emergency lighting).</div>` : '<div class="sf-note">Calibrate the plan to see the section.</div>'}
      ${poly ? `<div class="rsec-mini">${this.svg(sec, W, { mini: true })}</div>` : ''}`}
      <button type="button" class="plan-circuit-btn" data-rsec-edit style="margin-top:4px"${poly ? '' : ' disabled'}>${sec.type === 'poly' ? 'Edit section…' : 'Draw the section…'}</button>
    </div>`;
  },

  bind(propsEl) {
    if (this._bound || !propsEl) return;
    this._bound = true;
    const roomOf = () => {
      const w = propsEl.querySelector('[data-rsec-room]');
      return w && (AppState.planMarkup.rooms || []).find(r => r.id === w.dataset.rsecRoom);
    };
    propsEl.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.rsec;
      if (!k) return;
      const room = roomOf();
      if (!room) return;
      const sec = Object.assign({}, this.get(room));
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (k === 'type') {
        if (v === 'flat') { delete room.section; this._commit(room); return; }
        const H = RoomLighting.read(room).ceilH;
        const keep = { wall: sec.wall, angle: sec.angle };
        Object.keys(sec).forEach(key => delete sec[key]);
        Object.assign(sec, keep, this.defaults(v, H), { type: v });
        if (v === 'poly') {
          const poly = this._poly(room), W = poly ? this.axis(sec, poly).W : 6;
          Object.assign(sec, { points: [[0, H], [W, H]], width: W });
        }
      } else if (k === 'wall') sec.wall = parseInt(v, 10);
      else if (k === 'flip') sec.flip = !!v;
      else if (k === 'apexAt') sec.apexAt = Math.min(Math.max(this._num(v, 50) / 100, 0), 1);
      else sec[k] = this._num(v, sec[k]);
      room.section = sec;
      this._commit(room);
    });
    propsEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-rsec-edit]')) return;
      const room = roomOf();
      if (room) this.editor(room);
    });
  },

  // Section drawing: floor, ceiling profile, work plane; vertices as handles when editing.
  svg(sec, W, o = {}) {
    const pts = this.profile(sec, W);
    if (!pts.length) return '';
    const Hm = Math.max(...pts.map(p => p[1]), o.hView || 0, 1);
    const vw = o.mini ? 240 : 640, vh = o.mini ? 90 : 300, pad = o.mini ? 8 : 40;
    const k = Math.min((vw - 2 * pad) / W, (vh - 2 * pad) / Hm);
    const X = s => pad + s * k, Y = z => vh - pad - z * k;
    const shape = `M${X(0)},${Y(0)} ` + pts.map(p => `L${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ') + ` L${X(W)},${Y(0)} Z`;
    let extra = '';
    if (!o.mini) {
      const wp = o.workH;
      if (wp > 0) extra += `<line x1="${X(0)}" y1="${Y(wp)}" x2="${X(W)}" y2="${Y(wp)}" class="rsec-wp"/><text x="${X(W) + 4}" y="${Y(wp) + 4}" class="rs-dim">work plane</text>`;
      extra += `<text x="${(X(0) + X(W)) / 2}" y="${vh - 12}" text-anchor="middle" class="rs-dim">${W.toFixed(2)} m across</text>`;
      if (o.handles) extra += pts.map((p, i) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="7" class="rsec-h${o.sel === i ? ' on' : ''}" data-i="${i}"/>`).join('');
    }
    return `<svg viewBox="0 0 ${vw} ${vh}" class="${o.mini ? 'rsec-svg-mini' : 'rsec-svg'}" role="img" aria-label="Ceiling section">
      <path d="${shape}" class="rs-poly"/><line x1="${X(0)}" y1="${Y(0)}" x2="${X(W)}" y2="${Y(0)}" class="rsec-floor"/>${extra}</svg>`;
  },

  // Small plan of the room with the direction the section is cut in.
  _planThumb(room, sec) {
    const poly = this._poly(room);
    if (!poly) return '';
    const ax = this.axis(sec, poly);
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const x0 = Math.min(...xs), y1 = Math.max(...ys), sp = Math.max(Math.max(...xs) - x0, y1 - Math.min(...ys), 1e-6);
    const k = 120 / sp, P = (x, y) => [(10 + (x - x0) * k).toFixed(1), (10 + (y1 - y) * k).toFixed(1)];
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    const L = sp * 0.35, a = P(cx - ax.ux * L, cy - ax.uy * L), b = P(cx + ax.ux * L, cy + ax.uy * L);
    return `<svg viewBox="0 0 140 140" class="rsec-thumb" aria-label="Plan: the section is cut along the arrow, 0 m at its tail">
      <polygon points="${poly.map(p => P(p[0], p[1]).join(',')).join(' ')}" class="rs-poly"/>
      <line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="rsec-arrow" marker-end="url(#rsec-ah)"/>
      <defs><marker id="rsec-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="rsec-ahead"/></marker></defs></svg>`;
  },

  // Draw / edit the section: drag points, double-click the ceiling to add one,
  // Delete removes the selected one, or type the coordinates in the table.
  editor(room) {
    const poly = this._poly(room);
    if (!poly) { UI.alert('Calibrate the plan first.'); return; }
    const base = this.get(room);
    const ax = this.axis(base, poly), W = ax.W;
    const L = RoomLighting.read(room);
    const st = { pts: (base.type === 'flat' ? [[0, L.ceilH], [W, L.ceilH]] : this.profile(base, W)).map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]), sel: -1 };
    if (base.type === 'barrel') st.pts = st.pts.filter((p, i) => i % 3 === 0 || i === st.pts.length - 1);   // fewer handles
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'rsec-title');
    const sec = () => ({ type: 'poly', points: st.pts, width: W });
    const why = () => this.problem(sec(), W);
    const table = () => st.pts.map((p, i) => `<tr${i === st.sel ? ' class="on"' : ''}><td>${i + 1}</td>
      <td><input type="number" data-rsec-pt="${i}:0" value="${numAttr(p[0])}" step="0.05" min="0" max="${numAttr(W)}"${i === 0 || i === st.pts.length - 1 ? ' disabled' : ''} aria-label="Point ${i + 1} across"></td>
      <td><input type="number" data-rsec-pt="${i}:1" value="${numAttr(p[1])}" step="0.05" min="1" aria-label="Point ${i + 1} height"></td>
      <td>${i === 0 || i === st.pts.length - 1 ? '' : `<button type="button" class="btn-small" data-rsec-del="${i}" aria-label="Remove point ${i + 1}">✕</button>`}</td></tr>`).join('');
    // The drawing's height scale: set when it is drawn, held while a point is dragged
    // (so the point stays under the pointer), with room above the highest point.
    st.hView = 0;
    const paint = () => {
      ov.querySelector('.rsec-draw').innerHTML = this.svg(sec(), W, { handles: true, sel: st.sel, workH: L.workH, hView: st.hView });
      const w = why();
      ov.querySelector('.rsec-why-line').textContent = w;
      ov.querySelector('[data-rsec-act="ok"]').disabled = !!w;
    };
    const render = () => {
      st.hView = Math.max(...st.pts.map(p => p[1]), 1) * 1.3;
      ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:880px">
        <div class="modal-header"><h3 id="rsec-title">Ceiling section — ${escHtml(room.name || 'room')}</h3></div>
        <div class="modal-body">
          <div class="rsec-ed">
            <div><div class="rsec-draw"></div>
              <div class="sf-note">Drag a point to move it. Double-click the ceiling line to add a point; select one and press Delete to remove it. Two points at the same distance across make a vertical step (a clerestory). The ends stay on the walls.</div></div>
            <div class="rsec-side">${this._planThumb(room, base)}
              <div class="sf-note">Cut along the arrow; 0 m is at its tail.</div>
              <table class="rsec-tab"><thead><tr><th>#</th><th>Across (m)</th><th>Height (m)</th><th></th></tr></thead><tbody>${table()}</tbody></table></div>
          </div>
          <div class="sf-note rs-why rsec-why-line" aria-live="polite"></div>
          <div class="ui-dialog-actions"><button class="btn-small" data-rsec-act="cancel">Cancel</button><button class="btn-primary" data-rsec-act="ok">Use this section</button></div>
        </div></div>`;
      paint();
    };
    const svgPt = (ev) => {
      const svg = ov.querySelector('.rsec-svg');
      const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      const Hm = Math.max(...st.pts.map(p => p[1]), st.hView, 1), pad = 40;
      const k = Math.min((vb.width - 2 * pad) / W, (vb.height - 2 * pad) / Hm);
      const vx = (ev.clientX - r.left) / r.width * vb.width, vy = (ev.clientY - r.top) / r.height * vb.height;
      return [(vx - pad) / k, (vb.height - pad - vy) / k];
    };
    const snap = v => Math.round(v * 20) / 20;
    const setPt = (i, s, z) => {
      const n = st.pts.length;
      if (i === 0) s = 0; else if (i === n - 1) s = W;
      else s = Math.min(Math.max(s, st.pts[i - 1][0]), st.pts[i + 1][0]);
      st.pts[i] = [snap(s), Math.max(snap(z), 1)];
    };
    render();
    let drag = -1, frozen = null;
    ov.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.rsec-h');
      if (!h) return;
      drag = st.sel = +h.dataset.i;
      frozen = st.hView;
      h.setPointerCapture && h.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ov.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const [s, z] = svgPt(e);
      setPt(drag, s, Math.min(z, frozen));
      paint();
    });
    const end = () => { if (drag >= 0) { drag = -1; frozen = null; render(); } };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);
    ov.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.rsec-svg') || e.target.closest('.rsec-h')) return;
      const [s] = svgPt(e);
      if (!(s > 0 && s < W)) return;
      const i = st.pts.findIndex(p => p[0] > s);
      if (i <= 0) return;
      const [s0, z0] = st.pts[i - 1], [s1, z1] = st.pts[i];
      const z = s1 > s0 ? z0 + (z1 - z0) * (s - s0) / (s1 - s0) : z0;
      st.pts.splice(i, 0, [snap(s), snap(z)]);
      st.sel = i;
      render();
    });
    ov.addEventListener('change', (e) => {
      const t = e.target.dataset && e.target.dataset.rsecPt;
      if (!t) return;
      const [i, c] = t.split(':').map(Number);
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      const p = st.pts[i].slice();
      p[c] = v;
      setPt(i, p[0], p[1]);
      st.sel = i;
      render();
    });
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel > 0 && st.sel < st.pts.length - 1 && !(e.target && e.target.tagName === 'INPUT')) {
        e.preventDefault(); st.pts.splice(st.sel, 1); st.sel = -1; render();
      }
    };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => {
      const del = e.target.closest('[data-rsec-del]');
      if (del) { st.pts.splice(+del.dataset.rsecDel, 1); st.sel = -1; render(); return; }
      const act = e.target.closest('[data-rsec-act]');
      if (e.target === ov || (act && act.dataset.rsecAct === 'cancel')) { close(); return; }
      if (!act || act.dataset.rsecAct !== 'ok' || why()) return;
      room.section = { type: 'poly', wall: base.wall, angle: base.angle, points: st.pts.map(p => p.slice()), width: W };
      close();
      this._commit(room);
    });
    document.body.appendChild(ov);
  },
};

if (typeof module !== 'undefined') module.exports = RoomSection;
