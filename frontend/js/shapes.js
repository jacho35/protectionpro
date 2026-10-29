/* ProtectionPro — SldShapes: information-only annotation shapes on the single line
 *
 * Rectangles, ellipses and text notes (with an optional leader line) drawn on the
 * diagram to mark a part as existing / new / future / to be removed, or to say where
 * it is. They sit behind the components, never take part in any analysis, and are
 * saved with the project (AppState.sldShapes, Collab-synced as `sld.shapes`).
 *
 * A shape: {id, pageId, kind:'rect'|'ellipse'|'note', x, y, w, h, label, note, preset,
 *           color, fill (0–0.4), dash:'solid'|'dashed'|'dotted', labelPos:'tl'|'tr'|'c',
 *           print, locked, leader:{x,y}|null}
 *
 * Input is native Pointer Events, taken in the capture phase before Canvas so a shape
 * under the pointer never starts a marquee; a click anywhere else only drops the
 * shape selection and falls through to Canvas.
 */

const SHAPE_PRESETS = {
  existing: { name: 'Existing', label: 'EXISTING', color: '#6b7280', dash: 'dashed', kind: 'rect' },
  new: { name: 'New', label: 'NEW', color: '#1d4ed8', dash: 'dashed', kind: 'rect' },
  future: { name: 'Future', label: 'FUTURE', color: '#7c3aed', dash: 'dashed', kind: 'rect' },
  remove: { name: 'Remove', label: 'REMOVE', color: '#b91c1c', dash: 'dotted', kind: 'rect' },
  location: { name: 'Location', label: 'LOCATION', color: '#92400e', dash: 'solid', kind: 'note' },
  custom: { name: 'Custom', label: '', color: '#1f2937', dash: 'dashed', kind: 'rect' },
};

const SldShapes = {
  tool: null,        // null | 'rect' | 'ellipse' | 'note' — one shape, then back to select
  selId: null,
  _drag: null,       // {mode:'move'|'resize'|'lead'|'draw', ...}
  _draft: null,      // the shape being drawn
  _lastPreset: 'existing',

  init() {
    document.addEventListener('pointerdown', (e) => this._down(e), true);
    document.addEventListener('pointermove', (e) => this._move(e));
    document.addEventListener('pointerup', (e) => this._up(e));
    document.addEventListener('pointercancel', (e) => this._up(e));
    for (const [id, tool] of [['btn-shape-rect', 'rect'], ['btn-shape-ellipse', 'ellipse'], ['btn-shape-note', 'note']]) {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => this.setTool(tool));
    }
    // phone: Annotate beside Select / Wire opens a small shape picker
    const fab = document.getElementById('fab-mode-annotate'), pop = document.getElementById('mobile-annot-pop');
    if (fab && pop) {
      fab.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
      pop.addEventListener('click', (e) => {
        const b = e.target.closest('[data-shape-tool]');
        if (!b) return;
        pop.hidden = true;
        this.setTool(b.dataset.shapeTool);
      });
      document.addEventListener('click', () => { pop.hidden = true; });
    }
    this.render();
  },

  // ── Data ──

  list() { return AppState.sldShapes; },
  get(id) { return AppState.sldShapes.find(s => s.id === id) || null; },
  onPage() {
    const pid = AppState.activePageId;
    return AppState.sldShapes.filter(s => (s.pageId || 'page_1') === pid);
  },

  // Whatever was loaded (project file, remote op) is clamped to the shape's own fields:
  // geometry and colours go into SVG markup.
  sanitize(s) {
    if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) return null;
    const n = (x, d) => (Number.isFinite(+x) ? +x : d);
    const kind = ['rect', 'ellipse', 'note'].includes(s.kind) ? s.kind : 'rect';
    const out = {
      id: s.id,
      pageId: typeof s.pageId === 'string' ? s.pageId : 'page_1',
      kind,
      x: n(s.x, 0), y: n(s.y, 0),
      w: Math.max(20, n(s.w, 160)), h: Math.max(20, n(s.h, 100)),
      label: String(s.label || '').slice(0, 120),
      note: String(s.note || '').slice(0, 1000),
      preset: SHAPE_PRESETS[s.preset] ? s.preset : 'custom',
      color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#1f2937',
      fill: Math.min(0.4, Math.max(0, n(s.fill, 0.08))),
      dash: ['solid', 'dashed', 'dotted'].includes(s.dash) ? s.dash : 'dashed',
      labelPos: ['tl', 'tr', 'c'].includes(s.labelPos) ? s.labelPos : 'tl',
      print: s.print !== false,
      locked: !!s.locked,
      leader: s.leader && Number.isFinite(+s.leader.x) && Number.isFinite(+s.leader.y) ? { x: +s.leader.x, y: +s.leader.y } : null,
    };
    return out;
  },

  _create(kind, x, y, w, h) {
    const pr = SHAPE_PRESETS[kind === 'note' ? 'location' : (this._lastPreset === 'location' ? 'existing' : this._lastPreset)];
    const key = Object.keys(SHAPE_PRESETS).find(k => SHAPE_PRESETS[k] === pr);
    return {
      id: AppState.genId('shape'),
      pageId: AppState.activePageId,
      kind, x, y, w, h,
      label: pr.label, note: '', preset: key,
      color: pr.color, fill: kind === 'note' ? 0 : 0.08, dash: pr.dash,
      labelPos: 'tl', print: true, locked: false, leader: null,
    };
  },

  // ── Tool ──

  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    if (this.tool) AppState.mode = MODE.SELECT;
    Canvas.svg.classList.toggle('shape-drawing', !!this.tool);
    this._syncFab();
    const info = document.getElementById('status-info');
    if (info) info.textContent = this.tool
      ? (this.tool === 'note' ? 'Click where the note goes.' : 'Drag on the diagram to draw the shape. Esc cancels.')
      : '';
    window.closeAllToolbarMenus?.();
  },

  _syncFab() {
    const fab = document.getElementById('fab-mode-annotate');
    if (!fab) return;
    fab.classList.toggle('fab-active', !!this.tool);
    fab.setAttribute('aria-pressed', String(!!this.tool));
    const sel = document.getElementById('fab-mode-select');
    if (sel && this.tool) { sel.classList.remove('fab-active'); sel.setAttribute('aria-pressed', 'false'); }
  },

  escape() {
    const had = !!this.tool || !!this.selId;
    this.tool = null;
    Canvas.svg.classList.remove('shape-drawing');
    this._syncFab();
    this._drag = null; this._draft = null;
    if (this.selId) { this.selId = null; this.render(); }
    return had;
  },

  // ── Pointer ──

  _touch() { return typeof MobileUI !== 'undefined' && MobileUI.isMobile; },
  _worldPt(e) { return Canvas.screenToWorld(e.clientX, e.clientY); },
  _snap(v) { return typeof snapToGrid === 'function' ? snapToGrid(v) : Math.round(v / 20) * 20; },

  _down(e) {
    if (e.button !== 0 || e.altKey || Canvas.spaceDown) return;
    if (!Canvas.svg.contains(e.target)) return;
    if (AppState.mode === MODE.WIRE || AppState.wireStart) return;
    const p = this._worldPt(e);
    const grab = () => { if (e.pointerType === 'touch') { try { Canvas.svg.setPointerCapture(e.pointerId); } catch (_) {} } };

    if (this.tool) {
      e.preventDefault(); e.stopImmediatePropagation(); grab();
      const sx = this._snap(p.x), sy = this._snap(p.y);
      this._drag = { mode: 'draw', kind: this.tool, sx, sy };
      this._draft = this._create(this.tool, sx, sy, 0, 0);
      return;
    }

    const handleEl = e.target.closest('[data-shape-handle]');
    const shapeEl = e.target.closest('[data-shape-id]');
    if (!handleEl && !shapeEl) {
      // any other click: the shape selection goes, Canvas does the rest
      if (this.selId) { this.selId = null; this.render(); }
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation(); grab();
    const id = (handleEl || shapeEl).dataset.shapeId;
    const s = this.get(id);
    if (!s) return;
    if (this.selId !== id) this.select(id);
    if (s.locked) return;
    const orig = { x: s.x, y: s.y, w: s.w, h: s.h, leader: s.leader ? { ...s.leader } : null };
    if (handleEl) {
      const h = handleEl.dataset.shapeHandle;
      this._drag = { mode: h === 'lead' ? 'lead' : 'resize', id, handle: h, sx: p.x, sy: p.y, orig, moved: false };
    } else {
      this._drag = { mode: 'move', id, sx: p.x, sy: p.y, orig, moved: false };
    }
  },

  _move(e) {
    const d = this._drag;
    if (!d) return;
    if (e.buttons === 0) { this._up(e); return; }
    const p = this._worldPt(e);
    if (d.mode === 'draw') {
      const x1 = this._snap(p.x), y1 = this._snap(p.y);
      Object.assign(this._draft, {
        x: Math.min(d.sx, x1), y: Math.min(d.sy, y1), w: Math.abs(x1 - d.sx), h: Math.abs(y1 - d.sy),
      });
      this.render();
      return;
    }
    const s = this.get(d.id);
    if (!s) return;
    const dx = p.x - d.sx, dy = p.y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) * AppState.zoom < 3) return;
    d.moved = true;
    const o = d.orig;
    if (d.mode === 'move') {
      s.x = this._snap(o.x + dx); s.y = this._snap(o.y + dy);
      if (o.leader) s.leader = { x: o.leader.x + (s.x - o.x), y: o.leader.y + (s.y - o.y) };
    } else if (d.mode === 'lead') {
      s.leader = { x: this._snap(p.x), y: this._snap(p.y) };
    } else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      const h = d.handle;
      if (h.includes('w')) x0 = Math.min(this._snap(o.x + dx), x1 - 20);
      if (h.includes('e')) x1 = Math.max(this._snap(o.x + o.w + dx), x0 + 20);
      if (h.includes('n')) y0 = Math.min(this._snap(o.y + dy), y1 - 20);
      if (h.includes('s')) y1 = Math.max(this._snap(o.y + o.h + dy), y0 + 20);
      Object.assign(s, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    this.render();
  },

  _up(e) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (d.mode === 'draw') {
      const s = this._draft;
      this._draft = null;
      this.tool = null;
      Canvas.svg.classList.remove('shape-drawing');
      this._syncFab();
      const info = document.getElementById('status-info');
      if (info) info.textContent = '';
      // a click without a drag drops the shape at its default size
      const click = s.w < 20 || s.h < 20;
      if (d.kind === 'note') { s.w = click ? 200 : Math.max(120, s.w); s.h = 40; }
      else if (click) { s.w = 160; s.h = 100; }
      AppState.sldShapes.push(s);
      AppState.clearSelection();
      this.selId = s.id;
      this._commit();
      Canvas.render();
      this.showPanel();
      return;
    }
    if (d.moved) this._commit();
  },

  _commit() {
    AppState.dirty = true;
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
  },

  // ── Selection / editing ──

  select(id) {
    this.selId = id;
    AppState.clearSelection();
    Canvas.render();
    this.showPanel();
  },

  deleteSelected() {
    if (!this.selId) return false;
    AppState.sldShapes = AppState.sldShapes.filter(s => s.id !== this.selId);
    this.selId = null;
    this._commit();
    this.render();
    if (typeof Properties !== 'undefined') Properties.clear();
    return true;
  },

  duplicate() {
    const s = this.get(this.selId);
    if (!s) return;
    const c = this.sanitize(Object.assign({}, s, { id: AppState.genId('shape'), x: s.x + 20, y: s.y + 20, leader: s.leader ? { x: s.leader.x + 20, y: s.leader.y + 20 } : null }));
    AppState.sldShapes.push(c);
    this.selId = c.id;
    this._commit();
    this.render();
    this.showPanel();
  },

  reorder(front) {
    const s = this.get(this.selId);
    if (!s) return;
    AppState.sldShapes = AppState.sldShapes.filter(x => x !== s);
    if (front) AppState.sldShapes.push(s); else AppState.sldShapes.unshift(s);
    this._commit();
    this.render();
  },

  // ── Panel (the Properties pane) ──

  showPanel() {
    const s = this.get(this.selId);
    const mobile = typeof MobileUI !== 'undefined' && MobileUI.isMobile;
    const host = document.getElementById(mobile ? 'mobile-properties-content' : 'properties-content');
    if (!s || !host) return;
    const title = document.getElementById(mobile ? 'mobile-prop-title' : 'properties-title');
    if (title) title.textContent = s.kind === 'note' ? 'Annotation — text note' : (s.kind === 'ellipse' ? 'Annotation — ellipse' : 'Annotation — rectangle');
    const seg = (field, opts) => `<div class="shape-seg">${opts.map(([v, t]) =>
      `<button type="button" class="shape-seg-btn${s[field] === v ? ' active' : ''}" data-shape-set="${field}" data-v="${v}">${t}</button>`).join('')}</div>`;
    const chk = (field, text, on) => `<label class="shape-chk"><input type="checkbox" data-shape-chk="${field}"${on ? ' checked' : ''}> ${text}</label>`;
    host.innerHTML = `
      <div class="shape-panel">
        <div class="prop-section">
          <div class="prop-row"><label for="shape-label">Label</label><input id="shape-label" type="text" maxlength="120" value="${escHtml(s.label)}"></div>
          <div class="prop-row"><label for="shape-note">Note</label><textarea id="shape-note" rows="3" maxlength="1000">${escHtml(s.note)}</textarea></div>
        </div>
        <div class="prop-section">
          <div class="prop-section-title">Status</div>
          <div class="shape-chips">${Object.entries(SHAPE_PRESETS).map(([k, p]) =>
            `<button type="button" class="shape-chip${s.preset === k ? ' active' : ''}" data-shape-preset="${k}">${p.name}</button>`).join('')}</div>
        </div>
        <div class="prop-section">
          <div class="prop-section-title">Appearance</div>
          <div class="prop-row"><label>Outline</label>${seg('dash', [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']])}</div>
          <div class="prop-row"><label for="shape-color">Colour</label><input id="shape-color" type="color" value="${s.color}"></div>
          ${s.kind === 'note' ? '' : `<div class="prop-row"><label for="shape-fill">Fill</label><input id="shape-fill" type="range" min="0" max="40" value="${Math.round(s.fill * 100)}"> <span id="shape-fill-val">${Math.round(s.fill * 100)}%</span></div>
          <div class="prop-row"><label>Label position</label>${seg('labelPos', [['tl', 'Top left'], ['tr', 'Top right'], ['c', 'Centre']])}</div>`}
        </div>
        <div class="prop-section">
          ${s.kind === 'note' ? chk('leader', 'Leader line to a point', !!s.leader) : ''}
          ${chk('print', 'Show in print and PDF', s.print)}
          ${chk('locked', 'Lock position', s.locked)}
          <div class="shape-hint">Annotations are for information only. They sit behind the components and are ignored by every study.</div>
        </div>
        <div class="shape-actions">
          <button type="button" class="shape-act" data-shape-act="back">Send to back</button>
          <button type="button" class="shape-act" data-shape-act="front">Bring to front</button>
          <button type="button" class="shape-act" data-shape-act="dup">Duplicate</button>
          <button type="button" class="shape-act danger" data-shape-act="del">Delete</button>
        </div>
      </div>`;
    this._bindPanel(host.querySelector('.shape-panel'));
    if (mobile) {
      const sub = document.getElementById('mobile-prop-sub'); if (sub) sub.textContent = 'Annotation';
      for (const id of ['mobile-prop-prev', 'mobile-prop-next']) { const b = document.getElementById(id); if (b) b.disabled = true; }
      if (this._panelFor !== this.selId) MobileUI.openSheet('mobile-sheet-properties');
    }
    this._panelFor = this.selId;
  },

  _bindPanel(host) {
    const text = (id, field) => {
      const el = host.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('input', () => { const s = this.get(this.selId); if (s) { s[field] = el.value; this.render(); AppState.dirty = true; } });
      el.addEventListener('change', () => this._commit());
    };
    text('shape-label', 'label');
    text('shape-note', 'note');
    const color = host.querySelector('#shape-color');
    if (color) {
      color.addEventListener('input', () => { const s = this.get(this.selId); if (s) { s.color = color.value; s.preset = 'custom'; this.render(); AppState.dirty = true; } });
      color.addEventListener('change', () => { this.showPanel(); this._commit(); });
    }
    const fill = host.querySelector('#shape-fill');
    if (fill) {
      fill.addEventListener('input', () => {
        const s = this.get(this.selId); if (!s) return;
        s.fill = fill.value / 100; host.querySelector('#shape-fill-val').textContent = fill.value + '%';
        this.render(); AppState.dirty = true;
      });
      fill.addEventListener('change', () => this._commit());
    }
    host.addEventListener('click', (e) => {
      const s = this.get(this.selId);
      if (!s) return;
      const preset = e.target.closest('[data-shape-preset]');
      const set = e.target.closest('[data-shape-set]');
      const act = e.target.closest('[data-shape-act]');
      if (preset) {
        const k = preset.dataset.shapePreset, pr = SHAPE_PRESETS[k];
        const prev = SHAPE_PRESETS[s.preset];
        if (!s.label || (prev && s.label === prev.label)) s.label = pr.label;
        s.preset = k; s.color = pr.color; s.dash = pr.dash;
        if (k !== 'custom') this._lastPreset = k;
        this.render(); this.showPanel(); this._commit();
      } else if (set) {
        s[set.dataset.shapeSet] = set.dataset.v;
        this.render(); this.showPanel(); this._commit();
      } else if (act) {
        const a = act.dataset.shapeAct;
        if (a === 'del') this.deleteSelected();
        else if (a === 'dup') this.duplicate();
        else this.reorder(a === 'front');
      }
    });
    host.addEventListener('change', (e) => {
      const c = e.target.closest('[data-shape-chk]');
      const s = this.get(this.selId);
      if (!c || !s) return;
      const f = c.dataset.shapeChk;
      if (f === 'leader') s.leader = c.checked ? { x: this._snap(s.x - 60), y: this._snap(s.y + s.h + 40) } : null;
      else s[f] = c.checked;
      this.render(); this._commit();
    });
  },

  // ── Rendering ──

  _dashArray(d) { return d === 'dashed' ? '8 5' : (d === 'dotted' ? '2 5' : ''); },
  _wrap(text, maxChars) {
    const out = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && (line + ' ' + word).length > maxChars) { out.push(line); line = word; }
        else line = line ? line + ' ' + word : word;
      }
      out.push(line);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  },

  _svg(s, selected) {
    const e = escHtml, ink = 'var(--text-primary, #1a1a2e)';
    const dash = this._dashArray(s.dash);
    const da = dash ? ` stroke-dasharray="${dash}"` : '';
    const cls = `sld-shape${s.print === false ? ' sld-shape-noprint' : ''}${selected ? ' selected' : ''}`;
    let g = `<g class="${cls}" data-shape-id="${e(s.id)}">`;

    if (s.kind === 'note') {
      const lines = this._wrap(s.note, Math.max(8, Math.floor((s.w - 24) / 6.4)));
      s.h = Math.max(36, 12 + (s.label ? 16 : 0) + lines.length * 15 + 8);
      if (s.leader) {
        const ax = Math.min(s.x + s.w, Math.max(s.x, s.leader.x)), ay = Math.min(s.y + s.h, Math.max(s.y, s.leader.y));
        g += `<line x1="${ax}" y1="${ay}" x2="${s.leader.x}" y2="${s.leader.y}" stroke="${s.color}" stroke-width="2"/>`
          + `<circle cx="${s.leader.x}" cy="${s.leader.y}" r="4" fill="${s.color}"/>`;
      }
      g += `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="3" fill="#fef3c7" stroke="${s.color}" stroke-width="1.5"${da}/>`;
      let ty = s.y + 16;
      if (s.label) { g += `<text x="${s.x + 12}" y="${ty}" font-size="11" font-weight="700" letter-spacing="0.6" fill="#78350f" font-family="Arial, Helvetica, sans-serif">${e(s.label)}</text>`; ty += 16; }
      lines.forEach((ln, i) => { g += `<text x="${s.x + 12}" y="${ty + i * 15}" font-size="12" fill="#1f2937" font-family="Arial, Helvetica, sans-serif">${e(ln)}</text>`; });
      return g + '</g>';
    }

    const rx = s.x + s.w / 2, ry = s.y + s.h / 2;
    const body = s.kind === 'ellipse'
      ? (extra) => `<ellipse cx="${rx}" cy="${ry}" rx="${s.w / 2}" ry="${s.h / 2}" ${extra}/>`
      : (extra) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${extra}/>`;
    g += body(`fill="${s.color}" fill-opacity="${s.fill}" stroke="${s.color}" stroke-width="2"${da} pointer-events="none"`);
    // only the outline (and label) are grabbable, so the interior still box-selects what is under it
    g += body('fill="none" stroke="transparent" stroke-width="${this._touch() ? 30 : 14}" pointer-events="stroke" style="cursor:move"');

    if (s.label) {
      const tw = Math.ceil(s.label.length * 7.4 + 16);
      if (s.labelPos === 'c') {
        g += `<text x="${rx}" y="${ry + 5}" text-anchor="middle" font-size="14" font-weight="700" letter-spacing="0.6" fill="${s.color}" stroke="var(--bg-primary, #ffffff)" stroke-width="3" paint-order="stroke" font-family="Arial, Helvetica, sans-serif" style="cursor:move">${e(s.label)}</text>`;
      } else {
        const tx = s.labelPos === 'tr' ? s.x + s.w - tw + 1 : s.x - 1;
        g += `<rect x="${tx}" y="${s.y - 23}" width="${tw}" height="22" fill="${s.color}" style="cursor:move"/>`
          + `<text x="${tx + 8}" y="${s.y - 8}" font-size="11" font-weight="700" letter-spacing="0.6" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" pointer-events="none">${e(s.label)}</text>`;
      }
    }
    if (s.note) {
      const lines = this._wrap(s.note, Math.max(8, Math.floor((s.w - 24) / 6.4)));
      const y0 = s.y + s.h - 10 - (lines.length - 1) * 15;
      const x0 = s.kind === 'ellipse' ? rx : s.x + 12;
      const anchor = s.kind === 'ellipse' ? ' text-anchor="middle"' : '';
      lines.forEach((ln, i) => { g += `<text x="${x0}" y="${y0 + i * 15}"${anchor} font-size="12" fill="${ink}" font-family="Arial, Helvetica, sans-serif" pointer-events="none">${e(ln)}</text>`; });
    }
    return g + '</g>';
  },

  _handles(s) {
    const hs = (this._touch() ? 18 : 8) / (AppState.zoom || 1), half = hs / 2, sw = 1.5 / (AppState.zoom || 1);
    const box = (id, x, y, name, cur) =>
      `<rect class="shape-handle" data-shape-id="${escHtml(id)}" data-shape-handle="${name}" x="${x - half}" y="${y - half}" width="${hs}" height="${hs}" fill="#ffffff" stroke="#1d4ed8" stroke-width="${sw}" style="cursor:${cur}"/>`;
    const x1 = s.x + s.w, y1 = s.y + s.h, mx = s.x + s.w / 2, my = s.y + s.h / 2;
    const pad = 4 / (AppState.zoom || 1);
    let h = `<rect class="shape-handle" x="${s.x - pad}" y="${s.y - pad}" width="${s.w + 2 * pad}" height="${s.h + 2 * pad}" fill="none" stroke="#1d4ed8" stroke-width="${sw}" pointer-events="none"/>`;
    if (s.locked) return h;
    if (s.kind === 'note') {
      h += box(s.id, x1, my, 'e', 'ew-resize');
      if (s.leader) h += `<circle class="shape-handle" data-shape-id="${escHtml(s.id)}" data-shape-handle="lead" cx="${s.leader.x}" cy="${s.leader.y}" r="${hs * 0.9}" fill="#ffffff" stroke="#1d4ed8" stroke-width="${sw}" style="cursor:move"/>`;
      return h;
    }
    return h
      + box(s.id, s.x, s.y, 'nw', 'nwse-resize') + box(s.id, mx, s.y, 'n', 'ns-resize') + box(s.id, x1, s.y, 'ne', 'nesw-resize')
      + box(s.id, s.x, my, 'w', 'ew-resize') + box(s.id, x1, my, 'e', 'ew-resize')
      + box(s.id, s.x, y1, 'sw', 'nesw-resize') + box(s.id, mx, y1, 's', 'ns-resize') + box(s.id, x1, y1, 'se', 'nwse-resize');
  },

  render() {
    const layer = document.getElementById('shapes-layer');
    if (!layer) return;
    const list = this.onPage();
    // remote ops and loaded files bypass sanitize(): clamp what goes into the markup
    for (const s of list) { const c = this.sanitize(s); if (c) Object.assign(s, c); }
    if (this.selId && !list.some(s => s.id === this.selId)) this.selId = null;
    if (!this.selId) this._panelFor = null;
    let html = list.map(s => this._svg(s, s.id === this.selId)).join('');
    if (this._draft) html += this._svg(this._draft, false);
    const sel = this.selId && this.get(this.selId);
    if (sel) html += this._handles(sel);
    layer.innerHTML = html;
  },

  // Collab applied remote ops (or a project loaded): redraw, drop a selection that vanished
  refresh() {
    if (this.selId && !this.get(this.selId)) { this.selId = null; if (typeof Properties !== 'undefined') Properties.clear(); }
    this.render();
  },
};
