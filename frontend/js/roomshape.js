/**
 * RoomShape — a room from a standard shape (rectangle, L, T, U) typed in metres,
 * for a quick lighting calculation with no plan underneath. Lighting tab › Draw ›
 * Room from a shape (or Overview › + Room from a shape): pick the shape, give the
 * sizes, task and ceiling height; the room is placed on the current floor. A floor
 * with no drawing and no scale is given a scale automatically (as a sports field
 * does); a floor with an uncalibrated drawing asks for a calibration first.
 *
 * `outline(shape, dims, turn)` is pure (node-testable): corner points in metres,
 * origin at the top-left of the bounding box, y down (plan convention).
 */
const RoomShape = {
  SHAPES: {
    rect: { name: 'Rectangle', fields: [['w', 'Width'], ['d', 'Depth']], dims: { w: 6, d: 4 } },
    L: { name: 'L shape', fields: [['w', 'Width'], ['d', 'Depth'], ['a', 'Cut-out width'], ['b', 'Cut-out depth']], dims: { w: 8, d: 6, a: 4, b: 3 } },
    T: { name: 'T shape', fields: [['w', 'Width (top)'], ['d', 'Depth'], ['a', 'Stem width'], ['b', 'Top depth']], dims: { w: 10, d: 8, a: 4, b: 3 } },
    U: { name: 'U shape', fields: [['w', 'Width'], ['d', 'Depth'], ['a', 'Opening width'], ['b', 'Opening depth']], dims: { w: 10, d: 8, a: 4, b: 4 } },
  },
  TURNS: [0, 90, 180, 270],

  // Why the sizes don't make a shape, or '' when they do.
  problem(shape, d) {
    const S = this.SHAPES[shape];
    if (!S) return 'Unknown shape.';
    for (const [k, label] of S.fields) if (!(d[k] > 0)) return `${label} must be more than 0.`;
    if (shape === 'rect') return '';
    if (d.a >= d.w) return `${S.fields[2][1]} must be less than the width.`;
    if (d.b >= d.d) return `${S.fields[3][1]} must be less than the depth.`;
    return '';
  },

  // Corner points in metres (top-left origin, y down), turned clockwise by `turn` degrees
  // about the shape and shifted back so the bounding box starts at (0, 0).
  outline(shape, d, turn = 0) {
    const { w, d: D, a, b } = d;
    let p;
    if (shape === 'L') p = [[0, 0], [w - a, 0], [w - a, b], [w, b], [w, D], [0, D]];                  // cut-out top right
    else if (shape === 'T') { const x0 = (w - a) / 2; p = [[0, 0], [w, 0], [w, b], [x0 + a, b], [x0 + a, D], [x0, D], [x0, b], [0, b]]; }
    else if (shape === 'U') { const x0 = (w - a) / 2; p = [[0, 0], [x0, 0], [x0, b], [x0 + a, b], [x0 + a, 0], [w, 0], [w, D], [0, D]]; }   // opening at the top
    else p = [[0, 0], [w, 0], [w, D], [0, D]];
    const t = ((Math.round(turn / 90) % 4) + 4) % 4;
    for (let i = 0; i < t; i++) p = p.map(([x, y]) => [-y, x]);          // 90° clockwise with y down
    const mx = Math.min(...p.map(q => q[0])), my = Math.min(...p.map(q => q[1]));
    return p.map(([x, y]) => [+(x - mx).toFixed(6) + 0, +(y - my).toFixed(6) + 0]);
  },

  area(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; }
    return Math.abs(s) / 2;
  },

  // Small drawing of the outline, dimensioned when `labels` is set.
  thumb(shape, d, turn, labels) {
    const pts = this.outline(shape, d, turn);
    const W = Math.max(...pts.map(p => p[0])), H = Math.max(...pts.map(p => p[1]));
    const box = labels ? 220 : 64, pad = labels ? 26 : 6;
    const s = (box - 2 * pad) / Math.max(W, H, 1e-9);
    const vw = W * s + 2 * pad, vh = H * s + 2 * pad;
    const P = pts.map(([x, y]) => `${(pad + x * s).toFixed(1)},${(pad + y * s).toFixed(1)}`).join(' ');
    let lab = '';
    if (labels) {
      const fmt = v => `${+v.toFixed(2)} m`;
      lab = `<text x="${(vw / 2).toFixed(1)}" y="${(pad - 8).toFixed(1)}" text-anchor="middle" class="rs-dim">${fmt(W)}</text>`
        + `<text x="${(pad - 8).toFixed(1)}" y="${(vh / 2).toFixed(1)}" text-anchor="middle" class="rs-dim" transform="rotate(-90 ${(pad - 8).toFixed(1)} ${(vh / 2).toFixed(1)})">${fmt(H)}</text>`;
    }
    return `<svg viewBox="0 0 ${vw.toFixed(1)} ${vh.toFixed(1)}" ${labels ? 'class="rs-preview" role="img" aria-label="Room outline"' : 'aria-hidden="true"'}><polygon points="${P}" class="rs-poly"/>${lab}</svg>`;
  },

  // Scale for a floor with nothing drawn on it: the room takes about half the view.
  _autoScale(spanM) {
    const pm = AppState.planMarkup;
    if ((pm.plans || []).length || (pm.dxfs || []).length) return null;
    const visW = (PlanEngine.cssW || 1000) / ((PlanEngine.view && PlanEngine.view.zoom) || 1);
    const raw = Math.max(spanM * 2, 10) / visW;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const factor = Math.round(raw / p * 10) / 10 * p;
    pm.scale = { factor, source: 'auto' };
    if (PlanMarkup.updateScaleReadout) PlanMarkup.updateScaleReadout();
    UI.toast('Blank plan: set to scale automatically. Calibrate if you add a drawing under the room.', 'info', 6000);
    return factor;
  },

  open() {
    const pm = AppState.planMarkup;
    if (!PlanEngine.factor() && ((pm.plans || []).length || (pm.dxfs || []).length)) {
      UI.alert('Calibrate the plan first: the room is drawn to scale, and this floor has a drawing whose scale is not known.');
      return;
    }
    const st = { shape: 'rect', turn: 0, name: PlanMarkup.nextCounter('_room', 'Room '), task: RoomLighting.DEFAULTS.task, ceilH: RoomLighting.DEFAULTS.ceilH, dims: {} };
    for (const [k, S] of Object.entries(this.SHAPES)) st.dims[k] = Object.assign({}, S.dims);
    const groups = {};
    for (const [k, t] of Object.entries(ROOM_TASKS)) (groups[t.group] = groups[t.group] || []).push([k, t.name]);
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'rs-title');
    const num = (k, label, v, extra) => `<label class="plan-field"><span>${label}</span><input type="number" data-rs="${k}" value="${numAttr(v)}" ${extra || ''} style="width:100%"><small>m</small></label>`;
    const preview = () => {
      const d = st.dims[st.shape], why = this.problem(st.shape, d);
      if (why) return `<div class="sf-note rs-why">${escHtml(why)}</div>`;
      return this.thumb(st.shape, d, st.turn, true) + `<div class="sf-note" style="text-align:center">${this.area(this.outline(st.shape, d, st.turn)).toFixed(1)} m²</div>`;
    };
    // Sizes and turn only redraw the preview, so the field being typed in stays put.
    const refresh = () => {
      const pv = ov.querySelector('.rs-pv'), okBtn = ov.querySelector('[data-rs-act="ok"]');
      if (pv) pv.innerHTML = preview();
      if (okBtn) okBtn.disabled = !!this.problem(st.shape, st.dims[st.shape]);
    };
    const render = () => {
      const S = this.SHAPES[st.shape], d = st.dims[st.shape], why = this.problem(st.shape, d);
      ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:640px">
        <div class="modal-header"><h3 id="rs-title">Room from a shape</h3></div>
        <div class="modal-body">
          <div class="sf-layouts" role="radiogroup" aria-label="Shape">${Object.entries(this.SHAPES).map(([k, s]) => `<label class="sf-layout${k === st.shape ? ' on' : ''}">
            <input type="radio" name="rs-shape" data-rs="shape" value="${k}"${k === st.shape ? ' checked' : ''}>${this.thumb(k, st.dims[k], 0, false)}<b>${s.name}</b></label>`).join('')}</div>
          <div class="rs-body">
            <div class="rs-fields">
              <div class="sf-grid2">${S.fields.map(([k, label]) => num(k, label, d[k], 'min="0.1" step="0.1"')).join('')}</div>
              <label class="plan-field"><span>Turn</span><select data-rs="turn" style="width:100%">${this.TURNS.map(t => `<option value="${t}"${t === st.turn ? ' selected' : ''}>${t}°</option>`).join('')}</select></label>
            </div>
            <div class="rs-pv" aria-live="polite">${preview()}</div>
          </div>
          <div class="sf-grid3">
            <label class="plan-field"><span>Name</span><input type="text" data-rs="name" value="${escHtml(st.name)}" style="width:100%"></label>
            <label class="plan-field" style="grid-column:span 2"><span>Task</span><select data-rs="task" style="width:100%">${Object.entries(groups).map(([g, items]) =>
              `<optgroup label="${escHtml(g)}">${items.map(([k, n]) => `<option value="${k}"${k === st.task ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</optgroup>`).join('')}</select></label>
          </div>
          <div class="sf-grid3">${num('ceilH', 'Ceiling height', st.ceilH, 'min="1.5" max="30" step="0.1"')}</div>
          <div class="sf-note">The room goes on the current floor${PlanEngine.factor() ? '' : ', which is given a scale because nothing is drawn on it'}. Then place fittings, or use <b>Suggest layouts</b> in the room's panel, and calculate.</div>
          <div class="ui-dialog-actions"><button class="btn-small" data-rs-act="cancel">Cancel</button><button class="btn-primary" data-rs-act="ok"${why ? ' disabled' : ''}>Create room</button></div>
        </div></div>`;
    };
    render();
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.rs;
      if (!k) return;
      const v = e.target.value;
      if (k === 'shape') st.shape = v;
      else if (k === 'turn') st.turn = parseInt(v, 10) || 0;
      else if (k === 'name') st.name = v;
      else if (k === 'task') st.task = v;
      else if (k === 'ceilH') { const x = parseFloat(v); if (Number.isFinite(x)) st.ceilH = x; }
      else { const x = parseFloat(v); st.dims[st.shape][k] = Number.isFinite(x) ? x : 0; }
      if (k === 'shape') render(); else refresh();
    });
    ov.addEventListener('click', (e) => {
      const act = e.target.closest('[data-rs-act]');
      if (e.target === ov || (act && act.dataset.rsAct === 'cancel')) { close(); return; }
      if (!act || act.dataset.rsAct !== 'ok') return;
      if (this.problem(st.shape, st.dims[st.shape])) return;
      close();
      this.create(st);
    });
    document.body.appendChild(ov);
    const first = ov.querySelector('[data-rs="w"]');
    if (first) first.focus();
  },

  // Place the room: at the centre of the view, or beside the rooms already on the floor.
  create(st) {
    const pm = AppState.planMarkup;
    const m = this.outline(st.shape, st.dims[st.shape], st.turn);
    const Wm = Math.max(...m.map(p => p[0])), Hm = Math.max(...m.map(p => p[1]));
    const f = PlanEngine.factor() || this._autoScale(Math.max(Wm, Hm));
    if (!f) { UI.alert('Calibrate the plan first.'); return null; }
    const v = PlanEngine.view || { zoom: 1, panX: 0, panY: 0 };
    let x0 = -v.panX / v.zoom - Wm / f / 2, y0 = -v.panY / v.zoom - Hm / f / 2;
    const others = (pm.rooms || []).filter(r => r.points && r.points.length >= 3);
    if (others.length) {
      const xs = others.flatMap(r => r.points.map(p => p.x)), ys = others.flatMap(r => r.points.map(p => p.y));
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const overlaps = x0 < maxX && x0 + Wm / f > minX && y0 < maxY && y0 + Hm / f > minY;
      if (overlaps) { x0 = maxX + 2 / f; y0 = minY; }        // 2 m to the right of what is there
    }
    const room = {
      id: AppState.planGenId('pmrm'), name: (st.name || '').trim() || PlanMarkup.nextCounter('_room', 'Room '),
      points: m.map(([x, y]) => ({ x: x0 + x / f, y: y0 + y / f })), color: null, source: 'shape',
    };
    RoomLighting.applyTask(room, st.task);
    RoomLighting.set(room, 'ceilH', st.ceilH);
    pm.rooms.push(room);
    PlanMarkup.selectOnly(room.id);
    PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    if (PlanEngine.zoomToPoints) PlanEngine.zoomToPoints(room.points);
    PlanEngine.requestDraw({ bg: true, fg: true });
    if (typeof PlanUI !== 'undefined' && PlanUI.renderPalette) PlanUI.renderPalette();
    return room;
  },
};

if (typeof PlanTools !== 'undefined') {
  // Picking it opens the dialog; nothing is clicked on the plan.
  PlanTools.register({
    id: 'roomshape', cursor: 'default',
    onActivate() { setTimeout(() => { PlanTools.set('select'); RoomShape.open(); }, 0); },
  });
}
if (typeof module !== 'undefined') module.exports = RoomShape;
