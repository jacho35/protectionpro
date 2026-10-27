/* ProtectionPro — export part of the single line diagram.
 *
 * ExportSelection: a panel docked on the right of the canvas (Output ▸ Export
 * selection…, or the right-click menu). The area is the selected parts or a print
 * window; the output a PDF sheet (paper, the drawing set's scale or fitted, title
 * block none / standard / formal) or a PNG / SVG / DXF crop. Wires leaving the
 * area end in grey tags naming the next part, or stop at the edge. "Save as a
 * view" keeps it in the project (AppState.sldViews), optionally as a sheet of a
 * drawing set.
 *
 * PrintWindow: a canvas tool (Output ▸ Draw print window…). Drag an area — it
 * keeps the paper's shape unless Shift is held — resize it with the handles, move
 * it by dragging inside. Everything outside is dimmed and orange marks show where
 * wires cross the frame. The overlay follows pan / zoom; the canvas stays live.
 */

const ExportSelection = {
  _el: null,
  st: null,
  _esc(s) { return DrawingSet._esc(s); },

  open(opts) {
    opts = opts || {};
    const model = SheetPrint.buildModel();
    const ids = new Set(model.comps.map(c => c.id));
    const parts = (opts.parts || [...AppState.selectedIds]).filter(id => ids.has(id));
    const set = DrawingSet.setsHere()[0] || null;
    const prev = this.st || {};
    this.st = {
      model, comps: new Map(model.comps.map(c => [c.id, c])),
      area: opts.area || (parts.length ? 'parts' : 'window'),
      parts, window: opts.window || prev.window || null,
      format: prev.format || 'pdf', paperKey: prev.paperKey || (set ? `${set.opts.paper}-${set.opts.landscape ? 'l' : 'p'}` : 'a3-l'),
      scale: set ? (prev.scale || 'set') : 'fit', tb: prev.tb || 'standard', cut: prev.cut || 'tags',
      save: false, addToSet: !!set, setId: set ? set.id : null,
      name: opts.name || DrawingSet._selectionName.call({ _comps: new Map(model.comps.map(c => [c.id, c])) }, parts),
    };
    if (set) {
      DrawingSet._model = model; DrawingSet._comps = this.st.comps;
      try { this.st.setK = DrawingSet.planFor(set).k; } catch (e) { this.st.setK = null; }
      if (!DrawingSet._el) { DrawingSet._model = null; }
    }
    this.st.base = SheetPrint.prepareBase();
    if (!this._el) {
      const el = document.createElement('aside');
      el.id = 'xs-panel';
      el.className = 'xs-panel';
      el.setAttribute('aria-label', 'Export selection');
      document.body.appendChild(el);
      el.addEventListener('click', (e) => this._onClick(e));
      el.addEventListener('change', (e) => this._onChange(e));
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
      this._el = el;
    }
    this.render();
  },

  close() {
    if (this._el) { this._el.remove(); this._el = null; }
    if (this.st) this.st.base = null;
  },

  _view() {
    const s = this.st;
    return s.area === 'window' ? { kind: 'window', window: s.window } : { kind: 'parts', parts: s.parts };
  },

  _plan() {
    const s = this.st;
    if (s.area === 'window' ? !s.window : !s.parts.length) return null;
    const [paper, l] = s.paperKey.split('-');
    const pdf = s.format === 'pdf';
    return SheetPrint.plan(s.model, {
      paper, landscape: l === 'l', keyPlan: false, scale: 'fit', cut: s.cut,
      titleBlock: pdf ? s.tb : 'none', fixedK: pdf && s.scale === 'set' && s.setK ? s.setK : undefined,
      sheets: [{ id: 'xs', kind: 'view', title: s.name, view: this._view() }],
    });
  },

  _info(plan) {
    const d = AppState.projectDetails || {};
    return {
      base: this.st.base, project: AppState.projectName || 'Untitled Project', details: d,
      date: d.date || new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
      rev: d.revisionNumber || '', revisions: [], status: '', total: 1,
      cellOf: (pg) => ({ title: 'Single line diagram — ' + (this.st.name || 'Selection'), sub: this.st.area === 'window' ? 'Window on the diagram' : `${this.st.parts.length} selected parts`, no: 1, dwgNo: '' }),
    };
  },

  render() {
    const s = this.st, e = this._esc;
    const seg = (act, items, val) => `<div class="ds-seg" role="group">${items.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${v === val}">${l}</button>`).join('')}</div>`;
    const plan = this._plan();
    const pg = plan && plan.pages[0];
    const sets = DrawingSet.setsHere();
    const set = sets.find(x => x.id === s.setId) || sets[0];
    const pdf = s.format === 'pdf';
    const leaving = pg ? pg.tags.length : 0;
    const scaleOpts = (set && s.setK ? `<option value="set" ${s.scale === 'set' ? 'selected' : ''}>As ${e(set.name)} · ${(s.setK * SheetPrint.BASE_PX * SheetPrint.PT_PER_MM).toFixed(1)} pt</option>` : '')
      + `<option value="fit" ${s.scale !== 'set' || !s.setK ? 'selected' : ''}>Fit to paper${plan && s.scale !== 'set' && pg ? ` · ${pg.pt.toFixed(1)} pt` : ''}</option>`;
    this._el.innerHTML = `<div class="xs-head"><b>Export selection</b><button type="button" class="ds-ibtn" data-act="close" aria-label="Close">×</button></div>
      <div class="xs-body">
        ${seg('area', [['parts', `Selected parts (${s.parts.length})`], ['window', 'Window']], s.area)}
        ${s.area === 'parts' ? `<button type="button" class="ds-link" data-act="reselect">Use the current selection (${[...AppState.selectedIds].filter(id => s.comps.has(id)).length})</button>` : `<button type="button" class="btn-small" data-act="draw">${s.window ? 'Draw the window again…' : 'Draw a window on the diagram…'}</button>`}
        <div class="xs-preview" id="xs-preview">${plan ? '' : `<p>${s.area === 'window' ? 'Draw a window first.' : 'Select parts on the diagram first.'}</p>`}</div>
        <div class="ds-field">Format${seg('format', [['pdf', 'PDF sheet'], ['png', 'PNG'], ['svg', 'SVG'], ['dxf', 'DXF']], s.format)}</div>
        ${pdf ? `<div class="ds-two">
          <label class="ds-field">Paper<select data-ch="paper">${DrawingSet.PAPER_CHOICES.map(([p, l, t]) => [`${p}-${l ? 'l' : 'p'}`, t]).map(([k, t]) => `<option value="${e(k)}" ${k === s.paperKey ? 'selected' : ''}>${e(t)}</option>`).join('')}</select></label>
          <label class="ds-field">Scale<select data-ch="scale">${scaleOpts}</select></label></div>
          <div class="ds-field">Title block${seg('tb', [['none', 'None'], ['standard', 'Standard'], ['formal', 'Formal']], s.tb)}</div>` : ''}
        <fieldset class="ds-field xs-fs"><legend>Wires that leave the ${s.area === 'window' ? 'window' : 'selection'}</legend>
          <label class="ds-chkrow"><input type="radio" name="xs-cut" value="tags" ${s.cut !== 'edge' ? 'checked' : ''}> <span><b>End in a tag</b> naming the next part${s.cut !== 'edge' && pg ? ` (${leaving} here)` : ''}</span></label>
          <label class="ds-chkrow"><input type="radio" name="xs-cut" value="edge" ${s.cut === 'edge' ? 'checked' : ''}> <span>${s.area === 'window' ? 'Cut cleanly at the frame' : 'Stop at the edge'}</span></label></fieldset>
        <div class="xs-save">
          <label class="ds-chkrow"><input type="checkbox" data-ch="save" ${s.save ? 'checked' : ''}> <b>Save as a view</b></label>
          ${s.save ? `<input type="text" data-ch="name" aria-label="View name" value="${e(s.name)}">
          ${sets.length ? `<label class="ds-chkrow"><input type="checkbox" data-ch="addToSet" ${s.addToSet ? 'checked' : ''}> Add to <select data-ch="setId" aria-label="Drawing set">${sets.map(x => `<option value="${e(x.id)}" ${x.id === (set && set.id) ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</select> as a sheet</label>` : ''}
          <small>A ${s.area === 'window' ? 'window keeps its area' : 'view keeps these parts, not a picture'}. ${s.area === 'window' ? 'Parts moved out of it no longer print.' : 'Parts added later stay out until you edit the view.'}</small>` : ''}
        </div>
      </div>
      <div class="xs-foot"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn btn-primary" data-act="export" ${plan ? '' : 'disabled'}>Export ${s.format === 'pdf' ? 'PDF' : s.format.toUpperCase()}</button></div>`;
    if (plan) {
      const box = this._el.querySelector('#xs-preview');
      let svg;
      if (pdf) svg = SheetPrint.pageSVG(plan, pg, s.base, this._info(plan), 'xs');
      else {
        const NS = 'http://www.w3.org/2000/svg';
        svg = document.createElementNS(NS, 'svg');
        const b = pg.window && pg.clip ? { x0: pg.window.x0, y0: pg.window.y0, x1: pg.window.x1, y1: pg.window.y1 } : pg.bbox;
        svg.setAttribute('viewBox', `${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`);
        const inner = SheetPrint._drawingSVG(s.base, pg, { draw: { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } }, 'xsc');
        inner.setAttribute('viewBox', `${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`);
        if (s.base.defs) svg.appendChild(s.base.defs.cloneNode(true));
        svg.appendChild(inner);
      }
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Preview of the export');
      box.appendChild(svg);
    }
  },

  _onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = this.st, act = b.getAttribute('data-act');
    switch (act) {
      case 'close': this.close(); return;
      case 'area': s.area = b.getAttribute('data-v'); if (s.area === 'window' && !s.window) { this._draw(); return; } break;
      case 'format': s.format = b.getAttribute('data-v'); break;
      case 'tb': s.tb = b.getAttribute('data-v'); break;
      case 'reselect': s.parts = [...AppState.selectedIds].filter(id => s.comps.has(id)); break;
      case 'draw': this._draw(); return;
      case 'export': this._export(b); return;
      default: return;
    }
    this.render();
  },

  _draw() {
    const keep = this.st;
    this.close();
    PrintWindow.start({
      paperKey: keep.paperKey, window: keep.window,
      onExport: (win, paperKey) => { this.st = keep; this.open({ area: 'window', window: win, parts: keep.parts, name: keep.name }); if (paperKey) { this.st.paperKey = paperKey; this.render(); } },
    });
  },

  _onChange(e) {
    const s = this.st, t = e.target;
    if (t.name === 'xs-cut') s.cut = t.value;
    switch (t.getAttribute('data-ch')) {
      case 'paper': s.paperKey = t.value; break;
      case 'scale': s.scale = t.value; break;
      case 'save': s.save = t.checked; break;
      case 'name': s.name = t.value; return;
      case 'addToSet': s.addToSet = t.checked; return;
      case 'setId': s.setId = t.value; return;
      default: if (t.name !== 'xs-cut') return;
    }
    this.render();
  },

  async _export(btn) {
    const s = this.st;
    const plan = this._plan();
    if (!plan) return;
    btn.disabled = true;
    const safe = (x) => String(x || 'selection').replace(/[^\w-]+/g, '_');
    const fileBase = `${safe(AppState.projectName || 'diagram')}_${safe(s.name)}`;
    try {
      if (s.save) this._saveView();
      const pg = plan.pages[0];
      if (s.format === 'pdf') {
        await SheetPrint.exportPDF(plan, this._info(plan), fileBase + '.pdf');
      } else {
        const r = SheetPrint.cropClone(Project._prepareExportSVG(20), pg);
        if (s.format === 'svg') {
          r.clone.setAttribute('width', r.svgW); r.clone.setAttribute('height', r.svgH);
          const blob = new Blob([new XMLSerializer().serializeToString(r.clone)], { type: 'image/svg+xml' });
          this._download(blob, fileBase + '.svg');
          Project._statusMsg('Exported the selection as SVG.');
        } else if (s.format === 'png') {
          await new Promise(res => Project._rasterizeSVG(r.clone, r.svgW, r.svgH, 2, (canvas) => canvas.toBlob((blob) => { this._download(blob, fileBase + '.png'); res(); }, 'image/png')));
          Project._statusMsg('Exported the selection as PNG.');
        } else {
          const payload = Project.dxfPayload({ clone: r.clone, suffix: safe(s.name) });
          if (payload && await DxfExport.download(payload)) Project._statusMsg('Exported the selection as DXF.');
        }
      }
      this.close();
    } catch (err) {
      console.error(err);
      Project._statusMsg('Export failed: ' + err.message);
      btn.disabled = false;
    }
  },

  _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  _saveView() {
    const s = this.st;
    const [paper, l] = s.paperKey.split('-');
    const v = { id: DrawingSet.uid('view'), name: (s.name || '').trim() || 'View', pageId: AppState.activePageId || 'page_1', kind: s.area === 'window' ? 'window' : 'parts', paper, landscape: l === 'l' };
    if (v.kind === 'window') v.window = Object.assign({}, s.window); else v.parts = s.parts.slice();
    AppState.sldViews.push(v);
    if (s.addToSet) {
      const set = AppState.drawingSets.find(x => x.id === s.setId);
      if (set) set.sheets.push({ id: DrawingSet.uid('sh'), kind: 'view', viewId: v.id, title: '', dwgNo: '' });
    }
    AppState.dirty = true;
    return v;
  },
};

const PrintWindow = {
  active: false,
  rect: null,       // world {x, y, w, h}
  opts: null,
  _el: null, _raf: 0, _last: '',

  start(opts) {
    this.stop();
    this.opts = opts || {};
    const v = this.opts.view;
    this.paperKey = this.opts.paperKey || (v && v.paper ? `${v.paper}-${v.landscape === false ? 'p' : 'l'}` : null) || (() => { const s = DrawingSet.setsHere()[0]; return s ? `${s.opts.paper}-${s.opts.landscape ? 'l' : 'p'}` : 'a3-l'; })();
    this.rect = v && v.window ? Object.assign({}, v.window) : (this.opts.window ? Object.assign({}, this.opts.window) : null);
    this.active = true;
    this._model = SheetPrint.buildModel();
    const svg = document.getElementById('sld-canvas');
    const host = svg.parentElement;
    const el = document.createElement('div');
    el.className = 'pw-layer';
    el.innerHTML = `<svg class="pw-svg" aria-hidden="true"></svg><div class="pw-hint" role="status"><b>Print window</b><span>Drag an area · drag the handles to resize, inside to move · keeps the paper's shape, hold Shift for free · Esc to finish</span>
        <select class="pw-paper" aria-label="Paper">${DrawingSet.PAPER_CHOICES.map(([p, l, t]) => [`${p}-${l ? 'l' : 'p'}`, t]).map(([k, t]) => `<option value="${DrawingSet._esc(k)}" ${k === this.paperKey ? 'selected' : ''}>${DrawingSet._esc(t)}</option>`).join('')}</select>
        <button type="button" class="ds-ibtn" data-pw="close" aria-label="Close the print window tool">×</button></div>
      <div class="pw-box" hidden></div>
      <div class="pw-bar" hidden><span class="pw-read"></span><button type="button" class="btn btn-primary" data-pw="export">Export window…</button><button type="button" class="btn" data-pw="save">${v ? 'Save the view' : 'Save as view'}</button></div>`;
    host.appendChild(el);
    this._el = el;
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => { const d = document.createElement('div'); d.className = 'pw-h pw-h-' + h; d.setAttribute('data-h', h); el.appendChild(d); });
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('click', (e) => this._click(e));
    el.querySelector('.pw-paper').addEventListener('change', (e) => { this.paperKey = e.target.value; if (this.rect) this._shape(this.rect, 'se'); this._last = ''; });
    this._key = (e) => { if (e.key === 'Escape' && this.active) { e.stopPropagation(); e.preventDefault(); this.stop(); } };
    document.addEventListener('keydown', this._key, true);
    const tick = () => { if (!this.active) return; this._draw(); this._raf = requestAnimationFrame(tick); };
    tick();
    if (typeof Project !== 'undefined') Project._statusMsg('Print window: drag an area on the diagram.');
  },

  stop() {
    this.active = false;
    cancelAnimationFrame(this._raf);
    if (this._key) document.removeEventListener('keydown', this._key, true);
    if (this._el) this._el.remove();
    this._el = null;
    this._last = '';
  },

  _aspect() {
    const [p, l] = this.paperKey.split('-');
    const L = SheetPrint.layout({ paper: p, landscape: l === 'l', titleBlock: 'standard' });
    return L.draw.w / L.draw.h;
  },

  // keep the paper's shape, growing from the corner opposite the handle
  _shape(r, handle) {
    const a = this._aspect();
    if (Math.abs(r.w / r.h - a) < 1e-6) return;
    if (handle === 'n' || handle === 's') r.w = r.h * a;
    else if (handle === 'e' || handle === 'w') r.h = r.w / a;
    else if (r.w / r.h > a) r.h = r.w / a; else r.w = r.h * a;
  },

  _world(e) { return Canvas.screenToWorld(e.clientX, e.clientY); },

  _down(e) {
    if (e.button !== 0 || e.target.closest('.pw-hint, .pw-bar')) return;
    const handle = e.target.getAttribute && e.target.getAttribute('data-h');
    const inBox = e.target.classList && e.target.classList.contains('pw-box');
    if (this.rect && !handle && !inBox) return;   // the canvas underneath stays live
    e.preventDefault();
    e.stopPropagation();
    const a = this._world(e);
    const start = this.rect ? Object.assign({}, this.rect) : null;
    const el = this._el;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const b = this._world(ev);
      let r;
      if (!start) {
        r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        if (!ev.shiftKey && r.w > 2 && r.h > 2) {
          const sx = b.x >= a.x ? 1 : -1, sy = b.y >= a.y ? 1 : -1;
          this._shape(r, 'se');
          r.x = sx > 0 ? a.x : a.x - r.w; r.y = sy > 0 ? a.y : a.y - r.h;
        }
      } else if (inBox) {
        r = Object.assign({}, start, { x: start.x + b.x - a.x, y: start.y + b.y - a.y });
      } else {
        let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
        if (handle.includes('w')) x0 = Math.min(b.x, x1 - 20);
        if (handle.includes('e')) x1 = Math.max(b.x, x0 + 20);
        if (handle.includes('n')) y0 = Math.min(b.y, y1 - 20);
        if (handle.includes('s')) y1 = Math.max(b.y, y0 + 20);
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (!ev.shiftKey) {
          this._shape(r, handle);
          if (handle.includes('w')) r.x = x1 - r.w;
          if (handle.includes('n')) r.y = y1 - r.h;
          if (handle === 'n' || handle === 's') r.x = start.x + (start.w - r.w) / 2;
          if (handle === 'e' || handle === 'w') r.y = start.y + (start.h - r.h) / 2;
        }
      }
      this.rect = r;
      this._last = '';
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (this.rect && (this.rect.w < 20 || this.rect.h < 20)) this.rect = start;
      this._last = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  },

  async _click(e) {
    const b = e.target.closest('[data-pw]');
    if (!b) return;
    const act = b.getAttribute('data-pw');
    if (act === 'close') { this.stop(); return; }
    if (!this.rect) return;
    const r = { x: Math.round(this.rect.x), y: Math.round(this.rect.y), w: Math.round(this.rect.w), h: Math.round(this.rect.h) };
    const opts = this.opts, paperKey = this.paperKey;
    if (act === 'export') {
      this.stop();
      if (opts.onExport) opts.onExport(r, paperKey);
      else ExportSelection.open({ area: 'window', window: r });
      if (!opts.onExport && ExportSelection.st) { ExportSelection.st.paperKey = paperKey; ExportSelection.render(); }
      return;
    }
    if (act === 'save') {
      const [paper, l] = paperKey.split('-');
      let v = opts.view;
      if (v) Object.assign(v, { window: r, paper, landscape: l === 'l' });
      else {
        const name = await UI.prompt('Name for this view', 'Window');
        if (name === null) return;
        v = { id: DrawingSet.uid('view'), name: name || 'Window', pageId: AppState.activePageId || 'page_1', kind: 'window', window: r, paper, landscape: l === 'l' };
        AppState.sldViews.push(v);
      }
      AppState.dirty = true;
      this.stop();
      Project._statusMsg(`Saved the view “${v.name}”.`);
      if (opts.onSave) opts.onSave(v);
    }
  },

  // overlay in screen space, redrawn when the rect or the pan / zoom changes
  _draw() {
    const el = this._el;
    if (!el) return;
    const svg = document.getElementById('sld-canvas');
    const host = el.parentElement;
    const sr = svg.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const key = [AppState.panX, AppState.panY, AppState.zoom, sr.left, sr.top, sr.width, sr.height, JSON.stringify(this.rect)].join('|');
    if (key === this._last) return;
    this._last = key;
    Object.assign(el.style, { left: `${sr.left - hr.left}px`, top: `${sr.top - hr.top}px`, width: `${sr.width}px`, height: `${sr.height}px` });
    el.classList.toggle('pw-armed', !this.rect);
    const z = AppState.zoom, px = AppState.panX, py = AppState.panY;
    const S = (x, y) => [x * z + px, y * z + py];
    const ov = el.querySelector('.pw-svg');
    let s = '';
    // saved windows on this tab
    for (const v of AppState.sldViews) {
      if (v.kind !== 'window' || !v.window || (v.pageId || 'page_1') !== (AppState.activePageId || 'page_1') || (this.opts.view && this.opts.view.id === v.id)) continue;
      const [x, y] = S(v.window.x, v.window.y);
      s += `<rect x="${x}" y="${y}" width="${v.window.w * z}" height="${v.window.h * z}" fill="none" stroke="#6f42c1" stroke-width="1.4" stroke-dasharray="2 3"/><text x="${x + 4}" y="${y + v.window.h * z + 13}" font-size="11" font-weight="600" font-family="Inter, Arial, sans-serif" fill="#5a2ea6">${DrawingSet._esc(v.name)}</text>`;
    }
    const box = el.querySelector('.pw-box'), bar = el.querySelector('.pw-bar');
    if (this.rect) {
      const r = this.rect;
      const [x, y] = S(r.x, r.y), w = r.w * z, h = r.h * z;
      s += `<path d="M-9999 -9999H99999V99999H-9999ZM${x} ${y}V${y + h}H${x + w}V${y}Z" fill="rgba(26,26,46,0.28)" fill-rule="evenodd"/>`;
      s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#0078d7" stroke-width="2"/>`;
      // where wires cross the frame
      const inR = (p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
      let cuts = 0;
      for (const wr of this._model.wires) {
        const pts = wr.pts && wr.pts.length > 1 ? wr.pts : [wr.pa, wr.pb];
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1], q = pts[i];
          if (inR(p) === inR(q)) continue;
          // the crossing on an orthogonal segment
          let cx, cy;
          if (Math.abs(p.x - q.x) < 1e-6) { cx = p.x; cy = (inR(p) ? q.y : p.y) < r.y ? r.y : r.y + r.h; }
          else { cy = p.y; cx = (inR(p) ? q.x : p.x) < r.x ? r.x : r.x + r.w; }
          const [mx, my] = S(cx, cy);
          const vert = Math.abs(p.x - q.x) < 1e-6;
          s += vert ? `<line x1="${mx - 8}" y1="${my}" x2="${mx + 8}" y2="${my}" stroke="#c2570c" stroke-width="3"/>` : `<line x1="${mx}" y1="${my - 8}" x2="${mx}" y2="${my + 8}" stroke="#c2570c" stroke-width="3"/>`;
          cuts++;
        }
      }
      box.hidden = false;
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      const pos = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
      el.querySelectorAll('.pw-h').forEach(d => { const [hx, hy] = pos[d.getAttribute('data-h')]; d.style.display = ''; d.style.left = `${hx - 6}px`; d.style.top = `${hy - 6}px`; });
      const [p, l] = this.paperKey.split('-');
      const L = SheetPrint.layout({ paper: p, landscape: l === 'l', titleBlock: 'standard' });
      const k = Math.min(L.draw.w / r.w, L.draw.h / r.h, SheetPrint.MAX_PT / (SheetPrint.BASE_PX * SheetPrint.PT_PER_MM));
      const pt = SheetPrint.BASE_PX * k * SheetPrint.PT_PER_MM;
      const n = this._model.comps.filter(c => c.bbox.x1 > r.x && c.bbox.x0 < r.x + r.w && c.bbox.y1 > r.y && c.bbox.y0 < r.y + r.h).length;
      bar.hidden = false;
      bar.querySelector('.pw-read').textContent = `${p.toUpperCase()} ${l === 'l' ? 'landscape' : 'portrait'} · text ${pt.toFixed(1)} pt · ${n} part${n === 1 ? '' : 's'} · ${cuts} wire${cuts === 1 ? '' : 's'} cut`;
    } else {
      box.hidden = true; bar.hidden = true;
      el.querySelectorAll('.pw-h').forEach(d => { d.style.display = 'none'; });
    }
    ov.innerHTML = s;
  },
};
