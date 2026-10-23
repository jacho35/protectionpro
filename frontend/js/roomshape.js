/**
 * RoomShape — a room from a standard shape (rectangle, L, T, U) typed in metres,
 * for a quick lighting calculation with no plan underneath. Lighting tab › Draw ›
 * Room from a shape (or Overview › + Room from a shape): pick the shape (or Any shape:
 * a polygon drawn on a grid or typed corner by corner), give the sizes, task and ceiling height; the room is placed on the current floor. A floor
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
    poly: { name: 'Any shape', fields: [], dims: { pts: [[0, 0], [7, 0], [9, 3], [9, 6], [0, 6]] } },
  },
  TURNS: [0, 90, 180, 270],
  CEILINGS: { flat: 'Flat', gable: 'Pitched (gable)', mono: 'Mono-pitch', barrel: 'Barrel vault' },

  // Why the sizes don't make a shape, or '' when they do.
  problem(shape, d) {
    const S = this.SHAPES[shape];
    if (!S) return 'Unknown shape.';
    if (shape === 'poly') return this.polyProblem(d.pts);
    for (const [k, label] of S.fields) if (!(d[k] > 0)) return `${label} must be more than 0.`;
    if (shape === 'rect') return '';
    if (d.a >= d.w) return `${S.fields[2][1]} must be less than the width.`;
    if (d.b >= d.d) return `${S.fields[3][1]} must be less than the depth.`;
    return '';
  },

  // Why a drawn outline can't be a room, or ''.
  polyProblem(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 'A room needs at least 3 corners.';
    if (pts.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return 'Every corner needs an X and a Y.';
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) return `Corners ${i + 1} and ${(i + 1) % pts.length + 1} are on top of each other.`;
    }
    // walls that are not neighbours must not touch
    const n = pts.length, cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return `Walls ${i + 1} and ${j + 1} cross — move a corner.`;
    }
    if (this.area(pts) < 0.5) return 'The outline has almost no area.';
    return '';
  },

  // Wall i (corner i → i + 1) set to `len` metres: the corners after it move along
  // the wall, so the walls keep their directions; the last wall closes the room.
  setWallLength(pts, i, len) {
    const n = pts.length;
    if (i < 0 || i >= n - 1 || !(len > 0)) return pts;
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) return pts;
    const dx = (b[0] - a[0]) / L * (len - L), dy = (b[1] - a[1]) / L * (len - L);
    return pts.map((p, k) => (k > i ? [+(p[0] + dx).toFixed(4), +(p[1] + dy).toFixed(4)] : p));
  },

  // Corner points in metres (top-left origin, y down), turned clockwise by `turn` degrees
  // about the shape and shifted back so the bounding box starts at (0, 0).
  outline(shape, d, turn = 0) {
    const { w, d: D, a, b } = d;
    let p;
    if (shape === 'poly') p = (d.pts || []).map(q => [q[0], q[1]]);
    else if (shape === 'L') p = [[0, 0], [w - a, 0], [w - a, b], [w, b], [w, D], [0, D]];                  // cut-out top right
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

  // The view of the corner editor: the outline with a 1 m margin, kept while a corner is dragged.
  _polyView(pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1, y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
    if (x1 - x0 < 6) { const c = (x0 + x1) / 2; x0 = c - 3; x1 = c + 3; }
    if (y1 - y0 < 4) { const c = (y0 + y1) / 2; y0 = c - 2; y1 = c + 2; }
    const vw = 460, vh = 320, k = Math.min(vw / (x1 - x0), vh / (y1 - y0));
    return { x0, y0, x1, y1, k, vw, vh };
  },

  _polySvg(pts, V, sel) {
    const X = x => ((x - V.x0) * V.k).toFixed(1), Y = y => ((y - V.y0) * V.k).toFixed(1);
    const step = (V.x1 - V.x0) > 40 ? 5 : 1;
    let grid = '';
    for (let x = Math.ceil(V.x0 / step) * step; x <= V.x1; x += step) grid += `<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${V.vh}" class="${x % (step * 5) === 0 ? 'rs-g5' : 'rs-g'}"/>`;
    for (let y = Math.ceil(V.y0 / step) * step; y <= V.y1; y += step) grid += `<line x1="0" y1="${Y(y)}" x2="${V.vw}" y2="${Y(y)}" class="${y % (step * 5) === 0 ? 'rs-g5' : 'rs-g'}"/>`;
    const n = pts.length;
    const lens = pts.map((a, i) => {
      const b = pts[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return L > 0.3 ? `<text x="${X((a[0] + b[0]) / 2)}" y="${Y((a[1] + b[1]) / 2)}" class="rs-dim rs-len" text-anchor="middle" dy="-4">${+L.toFixed(2)}</text>` : '';
    }).join('');
    return `<svg viewBox="0 0 ${V.vw} ${V.vh}" class="rs-polysvg" role="img" aria-label="Room outline, ${n} corners">${grid}
      <polygon points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" class="rs-poly"/>${lens}
      ${pts.map((p, i) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="7" class="rsec-h${i === sel ? ' on' : ''}" data-ci="${i}"/><text x="${X(p[0])}" y="${Y(p[1])}" dx="9" dy="-8" class="rs-dim">${i + 1}</text>`).join('')}
      <text x="6" y="${V.vh - 6}" class="rs-dim">grid ${step} m</text></svg>`;
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
    const st = { shape: 'rect', turn: 0, name: PlanMarkup.nextCounter('_room', 'Room '), task: RoomLighting.DEFAULTS.task, ceilH: RoomLighting.DEFAULTS.ceilH, dims: {},
      ceil: 'flat', top: +(RoomLighting.DEFAULTS.ceilH + 1.5).toFixed(2), ridge: 'w' };
    for (const [k, S] of Object.entries(this.SHAPES)) st.dims[k] = JSON.parse(JSON.stringify(S.dims));
    st.sel = -1;
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
    const P = () => st.dims.poly.pts;
    const polyWalls = () => {
      const pts = P(), n = pts.length, cur = Number.isInteger(st.ridgeWall) ? st.ridgeWall : RoomSection.longestWall(pts);
      return pts.map((a, i) => { const b = pts[(i + 1) % n]; return `<option value="${i}"${i === cur ? ' selected' : ''}>wall ${i + 1} (${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(2)} m)</option>`; }).join('');
    };
    // The corner editor: drawing, table and verdict; `full` also rebuilds the table.
    const paintPoly = (full) => {
      if (st.shape !== 'poly') return;
      const pts = P(), n = pts.length;
      if (!st.view || drag < 0) st.view = this._polyView(pts);
      ov.querySelector('.rs-draw').innerHTML = this._polySvg(pts, st.view, st.sel);
      if (full) ov.querySelector('.rs-tbody').innerHTML = pts.map((p, i) => {
        const b = pts[(i + 1) % n], L = Math.hypot(b[0] - p[0], b[1] - p[1]);
        return `<tr${i === st.sel ? ' class="on"' : ''}><td>${i + 1}</td>
          <td><input type="number" data-rs-c="${i}:0" value="${numAttr(+p[0].toFixed(3))}" step="0.1" aria-label="Corner ${i + 1} X"></td>
          <td><input type="number" data-rs-c="${i}:1" value="${numAttr(+p[1].toFixed(3))}" step="0.1" aria-label="Corner ${i + 1} Y"></td>
          <td><input type="number" data-rs-len="${i}" value="${numAttr(+L.toFixed(3))}" step="0.1" min="0.1"${i === n - 1 ? ' disabled title="The last wall closes the room"' : ''} aria-label="Wall ${i + 1} length"></td>
          <td>${n > 3 ? `<button type="button" class="btn-small" data-rs-delc="${i}" aria-label="Remove corner ${i + 1}">✕</button>` : ''}</td></tr>`;
      }).join('');
      const why = this.polyProblem(pts);
      ov.querySelector('.rs-pv-poly').innerHTML = why ? `<div class="sf-note rs-why">${escHtml(why)}</div>` : `<div class="sf-note">${n} corners · ${this.area(pts).toFixed(1)} m²</div>`;
      ov.querySelector('[data-rs-act="ok"]').disabled = !!why;
    };
    let drag = -1;
    // Sizes and turn only redraw the preview, so the field being typed in stays put.
    const refresh = () => {
      const pv = ov.querySelector('.rs-pv'), okBtn = ov.querySelector('[data-rs-act="ok"]');
      if (pv) pv.innerHTML = preview();
      if (okBtn) okBtn.disabled = !!this.problem(st.shape, st.dims[st.shape]);
    };
    const render = () => {
      const S = this.SHAPES[st.shape], d = st.dims[st.shape], why = this.problem(st.shape, d);
      ov.innerHTML = `<div class="modal-content plan-floor-content sf-dialog" style="max-width:${st.shape === 'poly' ? 880 : 640}px">
        <div class="modal-header"><h3 id="rs-title">Room from a shape</h3></div>
        <div class="modal-body">
          <div class="sf-layouts" role="radiogroup" aria-label="Shape" style="grid-template-columns:repeat(5,minmax(0,1fr))">${Object.entries(this.SHAPES).map(([k, s]) => `<label class="sf-layout${k === st.shape ? ' on' : ''}">
            <input type="radio" name="rs-shape" data-rs="shape" value="${k}"${k === st.shape ? ' checked' : ''}>${this.thumb(k, st.dims[k], 0, false)}<b>${s.name}</b></label>`).join('')}</div>
          ${st.shape === 'poly' ? `<div class="rs-polyed">
            <div><div class="rs-draw"></div>
              <div class="sf-note">Drag a corner (it snaps to 0.1 m). Double-click a wall to add a corner; select one and press Delete to remove it. Or type the corners, or a wall's length — the corners after it move along that wall, so square corners stay square.</div></div>
            <div class="rs-side"><table class="rsec-tab"><thead><tr><th>#</th><th>X (m)</th><th>Y (m)</th><th>Wall to next (m)</th><th></th></tr></thead><tbody class="rs-tbody"></tbody></table>
              <button type="button" class="btn-small" data-rs-addc style="margin-top:6px">+ Corner</button>
              <div class="rs-pv rs-pv-poly" aria-live="polite"></div></div>
          </div>` : `<div class="rs-body">
            <div class="rs-fields">
              <div class="sf-grid2">${S.fields.map(([k, label]) => num(k, label, d[k], 'min="0.1" step="0.1"')).join('')}</div>
              <label class="plan-field"><span>Turn</span><select data-rs="turn" style="width:100%">${this.TURNS.map(t => `<option value="${t}"${t === st.turn ? ' selected' : ''}>${t}°</option>`).join('')}</select></label>
            </div>
            <div class="rs-pv" aria-live="polite">${preview()}</div>
          </div>`}
          <div class="sf-grid3">
            <label class="plan-field"><span>Name</span><input type="text" data-rs="name" value="${escHtml(st.name)}" style="width:100%"></label>
            <label class="plan-field" style="grid-column:span 2"><span>Task</span><select data-rs="task" style="width:100%">${Object.entries(groups).map(([g, items]) =>
              `<optgroup label="${escHtml(g)}">${items.map(([k, n]) => `<option value="${k}"${k === st.task ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</optgroup>`).join('')}</select></label>
          </div>
          <div class="sf-grid3">
            <label class="plan-field"><span>Ceiling</span><select data-rs="ceil" style="width:100%">${Object.entries(this.CEILINGS).map(([k, n]) => `<option value="${k}"${k === st.ceil ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
            ${num('ceilH', st.ceil === 'flat' ? 'Ceiling height' : st.ceil === 'mono' ? 'Low side' : 'Eaves height', st.ceilH, 'min="1" max="30" step="0.1"')}
            ${st.ceil === 'flat' ? '' : num('top', st.ceil === 'mono' ? 'High side' : st.ceil === 'barrel' ? 'Crown' : 'Apex', st.top, 'min="1" max="40" step="0.1"')}
          </div>
          ${st.ceil === 'flat' ? '' : `<div class="sf-grid3"><label class="plan-field"><span>Ridge runs along</span><select data-rs="ridge" style="width:100%">
            ${st.shape === 'poly' ? polyWalls() : `<option value="w"${st.ridge === 'w' ? ' selected' : ''}>the width</option><option value="d"${st.ridge === 'd' ? ' selected' : ''}>the depth</option>`}</select></label>
            <div class="sf-note" style="grid-column:span 2;align-self:end">Any other section — steps, a flat centre, a clerestory — can be drawn in the room's panel afterwards (<b>Draw the section…</b>).</div></div>`}
          <div class="sf-note">The room goes on the current floor${PlanEngine.factor() ? '' : ', which is given a scale because nothing is drawn on it'}. Then place fittings, or use <b>Suggest layouts</b> in the room's panel, and calculate.</div>
          <div class="ui-dialog-actions"><button class="btn-small" data-rs-act="cancel">Cancel</button><button class="btn-primary" data-rs-act="ok"${why ? ' disabled' : ''}>Create room</button></div>
        </div></div>`;
    };
    const renderAll = () => { render(); st.view = null; paintPoly(true); };
    renderAll();
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (st.shape === 'poly' && (e.key === 'Delete' || e.key === 'Backspace') && st.sel >= 0 && P().length > 3 && !(e.target && /INPUT|SELECT/.test(e.target.tagName))) {
        e.preventDefault(); P().splice(st.sel, 1); st.sel = -1; st.view = null; paintPoly(true);
      }
    };
    const toM = (ev) => {
      const svg = ov.querySelector('.rs-polysvg'), r = svg.getBoundingClientRect(), V = st.view;
      return [V.x0 + (ev.clientX - r.left) / r.width * V.vw / V.k, V.y0 + (ev.clientY - r.top) / r.height * V.vh / V.k];
    };
    const snap = v => Math.round(v * 10) / 10;
    ov.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.rs-polysvg .rsec-h');
      if (!h) return;
      drag = st.sel = +h.dataset.ci;
      h.setPointerCapture && h.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ov.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const [x, y] = toM(e);
      P()[drag] = [snap(x), snap(y)];
      paintPoly(false);
    });
    const endDrag = () => { if (drag >= 0) { drag = -1; st.view = null; paintPoly(true); } };
    ov.addEventListener('pointerup', endDrag);
    ov.addEventListener('pointercancel', endDrag);
    ov.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.rs-polysvg') || e.target.closest('.rsec-h')) return;
      const [x, y] = toM(e), pts = P(), n = pts.length;
      let best = -1, bd = Infinity;          // the wall nearest the click
      pts.forEach((a, i) => {
        const b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) return;
      pts.splice(best + 1, 0, [snap(x), snap(y)]);
      st.sel = best + 1; st.view = null; paintPoly(true);
    });
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('change', (e) => {
      const c = e.target.dataset && (e.target.dataset.rsC || e.target.dataset.rsLen);
      if (c != null && st.shape === 'poly') {
        const x = parseFloat(e.target.value);
        if (!Number.isFinite(x)) return;
        if (e.target.dataset.rsLen != null) st.dims.poly.pts = this.setWallLength(P(), +e.target.dataset.rsLen, x);
        else { const [i, j] = e.target.dataset.rsC.split(':').map(Number); P()[i][j] = x; st.sel = i; }
        st.view = null; paintPoly(true);
        return;
      }
      const k = e.target.dataset && e.target.dataset.rs;
      if (!k) return;
      const v = e.target.value;
      if (k === 'shape') st.shape = v;
      else if (k === 'turn') st.turn = parseInt(v, 10) || 0;
      else if (k === 'name') st.name = v;
      else if (k === 'task') st.task = v;
      else if (k === 'ceilH' || k === 'top') { const x = parseFloat(v); if (Number.isFinite(x)) st[k] = x; }
      else if (k === 'ridge') { if (st.shape === 'poly') st.ridgeWall = parseInt(v, 10); else st.ridge = v; }
      else if (k === 'ceil') { st.ceil = v; renderAll(); return; }
      else { const x = parseFloat(v); st.dims[st.shape][k] = Number.isFinite(x) ? x : 0; }
      if (k === 'shape') renderAll(); else if (st.shape !== 'poly') refresh();
    });
    ov.addEventListener('click', (e) => {
      const del = e.target.closest('[data-rs-delc]');
      if (del && P().length > 3) { P().splice(+del.dataset.rsDelc, 1); st.sel = -1; st.view = null; paintPoly(true); return; }
      if (e.target.closest('[data-rs-addc]')) {           // a corner halfway along the last wall
        const pts = P(), a = pts[pts.length - 1], b = pts[0];
        pts.push([snap((a[0] + b[0]) / 2), snap((a[1] + b[1]) / 2)]);
        st.sel = pts.length - 1; st.view = null; paintPoly(true); return;
      }
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
    const m = this.outline(st.shape, st.dims[st.shape], st.shape === 'poly' ? 0 : st.turn);
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
    if (st.ceil && st.ceil !== 'flat' && typeof RoomSection !== 'undefined') {
      // edge 0 of every shape runs along its width, edge 1 along its depth (turned with it)
      const lo = st.ceilH, hi = Math.max(st.top, lo);
      const wall = st.shape === 'poly' ? (Number.isInteger(st.ridgeWall) ? st.ridgeWall : RoomSection.longestWall(m)) : (st.ridge === 'd' ? 1 : 0);
      room.section = Object.assign({ type: st.ceil, wall },
        st.ceil === 'gable' ? { eaves: lo, apex: hi, apexAt: 0.5 } : st.ceil === 'mono' ? { low: lo, high: hi } : { eaves: lo, crown: hi });
    }
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
