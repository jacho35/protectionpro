/*
 * RoadSectionsUI — the Road sections page (the site plan's Roads tab › Edit section…, Ctrl K, also from the Plan's Detect group, a road's Properties, a Lighting design
 * and Auto layout › Rules). The project's sections in a list; the one picked drawn end-on with every service placed from the erf boundary
 * (drag an item sideways — it snaps to 10 mm; Alt-drag is ten times finer; arrow keys nudge 10 mm, Shift 100 mm), its strips (the lighting
 * strips: type, width, lighting class, surface), the services, kiosk and manhole sizes, the checks, and where it is used. The street light
 * is drawn from the lighting design that uses the section (its first row) and is edited there.
 * A section is given to roads by selecting them on the plan: *Apply to the selected roads* here, or the Road section field in their
 * Properties (several roads at once). `drawOverlay` colours every road by its section (Show on plan, and Auto layout with sections on).
 * Project standard (pinned at the top of the list, `sel` = 'std'): the offsets from the erf boundary, the kiosk size, the fibre manhole
 * size and the width + depth of each trench type, set once for the project. A section shows those groups as *From the standard* (fields
 * greyed) until *This section differs* is ticked (dragging a service on the drawing ticks it for the offsets); *Copy from…* takes a group
 * from another section; *Make these the standard* moves a section's own values up. The crossing sleeves stay per section.
 * Strips: only the carriageway, footpaths, cycle lanes and medians are typed; the verges are the rest of the reserve (`RoadSections.fill`),
 * shown greyed; the reserve block sets the reserve and where the carriageway sits (`cwOff`, + toward boundary A).
 * The site plan's **Roads** tab (beside Draw / Underlays / Output; `panelHtml` in the plan's left panel, `onPanelClick`): the sections with
 * their reserve and road count, the roads selected on the plan given the picked section in one click, the picked one's strips, Edit
 * section… (this page) and Project standard…; the roads are coloured by section while it is open (`overlayOn`).
 * Data and rules: roadsections.js + plan-sections.js (pure).
 */
const RoadSectionsUI = {
  sel: null,                                      // the section being edited
  K: 40,                                          // px per m in the drawing
  showOn: false,                                  // colour the roads on the plan by their section
  panelSel: null,                                 // the section picked in the plan's Roads tab
  // the roads are drawn in their section's colour: asked for, or the plan's Roads tab is open
  overlayOn() { return this.showOn || (typeof PlanMarkup !== 'undefined' && PlanMarkup.context === 'plan' && PlanMarkup.mode === 'roads'); },
  PAL: ['#2563eb', '#0b6e6e', '#b4501c', '#7c3aed', '#8a6a00', '#be185d', '#15803d', '#475569'],
  _m: null,

  RS() { return RoadSections; },
  cur() { const RS = this.RS(); return RS.get(this.sel) || RS.def(); },
  isStd() { return this.sel === 'std'; },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  f2(v) { return (+v).toFixed(2); },
  colour(id) { const i = Math.max(0, this.RS().list().findIndex(s => s.id === id)); return this.PAL[i % this.PAL.length]; },
  changed() {
    AppState.dirty = true;
    if (typeof PlanLayoutUI !== 'undefined' && PlanLayoutUI._active) PlanLayoutUI.touched();
    if (typeof RoadLight !== 'undefined' && RoadLight._built) { try { RoadLight.render(); RoadLight.recompute(); } catch (_) { /* not open */ } }
    if (typeof RoadPlan !== 'undefined' && RoadPlan._geo && RoadPlan._geo.clear) RoadPlan._geo.clear();
    if (typeof PlanEngine !== 'undefined' && PlanEngine.requestDraw) PlanEngine.requestDraw({ all: true });
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.mode === 'roads' && typeof PlanUI !== 'undefined') PlanUI.renderPalette();
  },

  // the section as the drawing and checks see it: verge A / road / verge B from its strips, the services as they are (the same objects, so a
  // drag edits the section), the pole from its lighting design (null without one)
  // the sizes are the ones it works with (the standard's, or its own where it differs): each cable drawn in its trench type's width and depth
  view(sec) {
    const RS = this.RS(), sp = RS.span(sec), pole = RS.pole(sec), T = RS.sizes(sec, 'trench');
    const O = RS.sizes(sec, 'off'), cab = (k, t) => Object.assign({}, sec.items[k], { off: O[k], w: T[t].w, depth: T[t].d });
    const items = Object.assign({}, sec.items, {
      svc: cab('svc', 'LV/SL'), lv: cab('lv', 'LV/SL'), fi: cab('fi', 'FI'), mv: cab('mv', 'MV'),
      kiosk: Object.assign({}, sec.items.kiosk, RS.sizes(sec, 'kiosk'), { off: O.kiosk }), mh: Object.assign({}, sec.items.mh, RS.sizes(sec, 'mh'), { off: O.mh }),
      pole: pole ? Object.assign({}, sec.items.pole, { off: pole.off, h: pole.h, arm: pole.arm }) : sec.items.pole });
    return { id: sec.id, name: sec.name, strips: { a: sp.a, road: sp.road, b: sp.b }, list: sec.strips, items, trench: T, pole };
  },

  // ───────── the page ─────────
  open(id) {
    if (typeof RoadSections === 'undefined') return;
    if (this._m) { if (id) { this.sel = id === 'std' || this.RS().get(id) ? id : this.sel; this.render(); } return; }
    const RS = this.RS(); RS.ensure();
    this.sel = id === 'std' ? 'std' : RS.get(id) ? id : RS.defId();
    const m = document.createElement('div');
    m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'rsx-title');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    m.innerHTML = `<div class="modal-content modal-wide" style="max-height:94vh;display:flex;flex-direction:column;width:min(1240px,97vw)">
      <div class="modal-header"><h3 id="rsx-title">Road sections</h3><button class="modal-close" data-rsx="close" aria-label="Close">&times;</button></div>
      <style>#rsx-body input[type=number]{min-width:0}.rsx-grid{display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;min-height:0}@media (max-width:760px){.rsx-grid{grid-template-columns:minmax(0,1fr)}}</style>
      <div id="rsx-body" style="overflow:auto;padding:12px 16px"></div>
      <div class="modal-footer" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1;color:var(--text-muted);font-size:12px">One section per kind of road: the strips are what the lighting is designed on, the services are where Auto layout puts the cables. Changes apply as you make them.</span><button class="btn-small btn-primary" data-rsx="close">Done</button></div></div>`;
    document.body.appendChild(m); this._m = m;
    m.addEventListener('click', e => this._click(e));
    m.addEventListener('change', e => this._change(e));
    m.addEventListener('pointerdown', e => this._down(e));
    m.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.target.closest('input,select')) { this.close(); return; } this._key(e); });
    this.render();
  },
  close() { if (this._m) { this._m.remove(); this._m = null; } if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); if (typeof PlanMarkup !== 'undefined' && PlanMarkup.mode === 'roads' && typeof PlanUI !== 'undefined') PlanUI.renderPalette(); },

  _planRoads() { return typeof PlanMarkup !== 'undefined' ? [...PlanMarkup.selectedIds].map(id => (AppState.planMarkup.routes || []).find(r => r.id === id)).filter(r => r && r.type === 'street') : []; },

  render() {
    if (!this._m) return;
    const RS = this.RS(), std = this.isStd(), sec = this.cur(), esc = this.esc, d = RS.defId();
    const nOwn = RS.list().filter(x => RS.GROUPS.some(g => RS.own(x, g))).length;
    const stdBtn = `<button type="button" class="plan-btn" data-rsx="pick" data-id="std" aria-pressed="${std}" style="text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border-style:dashed;${std ? 'outline:2px solid var(--accent,#2563eb)' : ''}">
        <b>Project standard</b><span style="font-size:12px;color:var(--text-muted)">Offsets, kiosk, manhole and trenches for the whole project${nOwn ? ` · ${nOwn} section${nOwn === 1 ? ' has' : 's have'} own` : ''}</span></button>`;
    const rail = stdBtn + RS.list().map(x => { const n = RS.roadsUsing(x.id).length, nd = RS.designsUsing(x.id).length, on = !std && x.id === sec.id;
      return `<button type="button" class="plan-btn" data-rsx="pick" data-id="${esc(x.id)}" aria-pressed="${on}" style="text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;${on ? 'outline:2px solid var(--accent,#2563eb)' : ''}">
        <span style="display:flex;gap:6px;align-items:center"><span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;background:${this.colour(x.id)}"></span><b>${esc(x.name)}</b>${x.id === d ? ' <small>(default)</small>' : ''}</span>
        <span style="font-size:12px;color:var(--text-muted)">${esc(RS.summary(x))}</span>
        <span style="font-size:12px;color:var(--text-muted)">${n} road${n === 1 ? '' : 's'}${nd ? ` · ${nd} lighting design${nd === 1 ? '' : 's'}` : ''}</span></button>`; }).join('');
    const tpl = typeof RL_TEMPLATES !== 'undefined' ? `<select data-rsx-tpl aria-label="New section from a road-lighting template"><option value="">From a template…</option>${RL_TEMPLATES.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>` : '';
    const sel = this._planRoads();
    this._m.querySelector('#rsx-body').innerHTML = `<div class="rsx-grid">
      <div style="display:flex;flex-direction:column;gap:6px">${rail}
        <div style="display:flex;gap:4px;flex-wrap:wrap"><button type="button" class="plan-btn" data-rsx="new">+ New</button><button type="button" class="plan-btn" data-rsx="dup"${std ? ' disabled' : ''}>Duplicate</button><button type="button" class="plan-btn" data-rsx="del"${std || RS.list().length < 2 ? ' disabled' : ''}>Delete</button></div>
        ${tpl}
        <div style="margin-top:8px;font-weight:600">Roads</div>
        <div style="font-size:12px;color:var(--text-muted)">A road with no section of its own uses the default. Select roads on the plan (Shift-click adds), then apply a section to them, or pick it in their Properties.</div>
        ${std ? '' : sel.length ? `<button type="button" class="plan-btn" data-rsx="apply" style="font-weight:600">Apply "${esc(sec.name)}" to the ${sel.length} selected road${sel.length === 1 ? '' : 's'}</button>` : '<div style="font-size:12px;color:var(--text-muted)">No roads selected on the plan.</div>'}
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rsx-show${this.showOn ? ' checked' : ''}> Colour the roads on the plan by section</label>
      </div>
      ${std ? this.stdHtml() : `<div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="display:flex;gap:8px;align-items:center">Name <input type="text" data-rsx-name value="${esc(sec.name)}" maxlength="60" style="max-width:280px"></label>
          <button type="button" class="plan-btn" data-rsx="def"${sec.id === d ? ' disabled' : ''}>${sec.id === d ? 'Default section' : 'Make default'}</button></div>
        ${this.reserveHtml(sec)}
        <div id="rsx-svg" style="overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg-panel,#fbfaf7)">${this.svg(sec)}</div>
        <div style="font-size:12px;color:var(--text-muted)"><b>Drag</b> a service sideways to place it: it snaps to 10 mm, hold Alt for ten times finer. Focus one and use the arrow keys (10 mm, Shift 100 mm). The offsets and sizes are below: the project standard's, or this section's own; moving a service here gives this section offsets of its own.</div>
        <div style="min-width:0;overflow-x:auto">${this.stripsHtml(sec)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;align-items:start">${this.poleHtml(sec)}${this.checksHtml(sec)}${this.usedHtml(sec)}${this.onPlanHtml(sec)}</div>
        <div style="min-width:0;overflow-x:auto">${this.itemsHtml(sec)}</div>
        <div style="display:flex;flex-direction:column;gap:12px">${this.kioskHtml(sec)}${this.mhHtml(sec)}${this.trenchHtml(sec)}</div>
      </div>`}</div>`;
  },

  // ───────── the drawing ─────────
  geom(v) {
    const K = this.K, pad = 2 * K, A = 40 + pad, road0 = A + v.strips.a * K, road1 = road0 + v.strips.road * K, B = road1 + v.strips.b * K;
    return { K, A, road0, road1, B, W: B + pad + 40, G: 190 };
  },
  svgParts(sec) {
    const v = this.view(sec), g = this.geom(v), { K, A, road0, road1, B, W, G } = g, d = v.items, esc = this.esc, H = 410;
    const X = off => A + off * K, o = [];
    const rect = (x, y, w, h, st) => `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" ${st}/>`;
    const tx = (x, y, t, st) => `<text x="${x}" y="${y}" ${st || 'font-size="11"'}>${esc(t)}</text>`;
    o.push(rect(40, G - 90, A - 40, 90, 'fill="#fff" stroke="#d6d2c4"'), rect(B, G - 90, W - B - 40, 90, 'fill="#fff" stroke="#d6d2c4"'));
    o.push(tx(46, G - 70, 'Erf', 'font-size="11" fill="#5b6068"'), tx(B + 6, G - 70, 'Erf', 'font-size="11" fill="#5b6068"'));
    o.push(rect(40, G, W - 80, 80, 'fill="#e7e2d3"'));
    // the strips at ground level, each in its colour (carriageway dark, median and verges green, footways and cycle tracks grey)
    const fillOf = t => ({ carriageway: '#55595f', median: '#9fc28f', verge: '#cfe3c1', footpath: '#c9c6bd', cycle: '#b7c3d6' })[t] || '#cfe3c1';
    let y = 0; for (const s of v.list) { const w = Math.max(0, +s.width || 0); if (w > 0) o.push(rect(A + y * K, G, w * K, 5, `fill="${fillOf(s.type)}"`)); y += w; }
    o.push(rect(road0, G - 12, 7, 12, 'fill="#8d9097"'), rect(road1 - 7, G - 12, 7, 12, 'fill="#8d9097"'));
    o.push(rect(road0, G + d.sleeve.depth * K - 5, road1 - road0, 10, 'fill="none" stroke="#8a6a00" stroke-width="2" stroke-dasharray="5 4"'), tx(road0 + 8, G + d.sleeve.depth * K + 20, 'crossing sleeves', 'font-size="11" fill="#8a6a00"'));
    for (const [x, l] of [[A, 'Boundary A = 0.00'], [B, 'Boundary B']]) o.push(`<line x1="${x}" y1="60" x2="${x}" y2="${H - 56}" stroke="#1b1f24" stroke-width="1.5" stroke-dasharray="5 4"/>`, tx(x, 52, l, 'font-size="12" font-weight="600" text-anchor="middle"'));
    const items = [];
    const trench = (k, L, col, row) => { const t = d[k], cx = X(t.off); o.push(`<g data-drag="${k}" tabindex="0" role="slider" aria-label="${L} offset from boundary A" aria-valuenow="${escHtml(t.off)}" style="cursor:ew-resize">${rect(cx - t.w * K / 2, G, t.w * K, t.depth * K, `fill="${col}"`)}${rect(cx - 12, G, 24, t.depth * K + 4, 'fill="transparent"')}</g>`, tx(cx - 4, G + t.depth * K + 15, L[0], `font-size="11" font-weight="700" fill="${col}"`)); items.push([cx, G + t.depth * K + 18, row, t.off]); };
    trench('svc', 'Service', '#8a6a00', 1); trench('lv', 'LV', '#b4501c', 2); trench('fi', 'Fibre', '#2b5fa8', 1); trench('mv', 'MV', '#6b3fa0', 2);
    const mh = d.mh, mx = X(mh.off);
    o.push(`<g data-drag="mh" tabindex="0" role="slider" aria-label="Fibre manhole offset from boundary A" aria-valuenow="${escHtml(mh.off)}" style="cursor:ew-resize">${rect(mx - mh.len * K / 2, G + 2, mh.len * K, mh.depth * K, 'fill="#dce6f4" stroke="#2b5fa8" stroke-width="2" stroke-dasharray="5 4"')}${tx(mx, G + 22, 'FMH', 'font-size="11" font-weight="700" fill="#2b5fa8" text-anchor="middle"')}</g>`);
    items.push([mx, G + mh.depth * K + 4, 3, mh.off]);
    const k = d.kiosk, kx = X(k.off);
    o.push(`<g data-drag="kiosk" tabindex="0" role="slider" aria-label="Kiosk near face offset from boundary A" aria-valuenow="${escHtml(k.off)}" style="cursor:ew-resize">${rect(kx, G - k.h * K - 6, k.depth * K, k.h * K + 6, 'fill="#2f3a45" stroke="#0b6e6e" stroke-width="2"')}${tx(kx + k.depth * K / 2, G - k.h * K / 2, 'Kiosk', 'font-size="11" fill="#fff" text-anchor="middle"')}</g>`);
    items.push([kx, G, 3, k.off]);
    if (v.pole) {                                                                // from the lighting design: drawn, not dragged
      const px = X(d.pole.off), ph = 150, dir = v.pole.side === 'right' || v.pole.side === 'medianL' ? -1 : 1, arm = dir * d.pole.arm * K;
      o.push(`<g opacity="0.75"><rect x="${px - 2}" y="${G - ph}" width="4" height="${ph}" fill="#1b1f24"/><rect x="${Math.min(px, px + arm) - (dir < 0 ? 0 : 2)}" y="${G - ph}" width="${Math.abs(arm) + 2}" height="4" fill="#1b1f24"/><rect x="${px + arm - 8}" y="${G - ph}" width="16" height="7" fill="#1b1f24"/></g>`, tx(px + 8, G - ph - 6, `Street light ${this.f2(d.pole.h)} m · from ${v.pole.design}`, 'font-size="11"'));
      items.push([px, G, 1, d.pole.off]);
    }
    items.forEach(([cx, y0, row, off]) => { const ty = G + 96 + row * 18; o.push(`<line x1="${cx}" y1="${y0}" x2="${cx}" y2="${ty}" stroke="#9c978a"/>`, `<rect x="${cx - 21}" y="${ty}" width="42" height="15" fill="#fbfaf7" stroke="#d6d2c4"/>`, tx(cx, ty + 11, '+' + this.f2(off), 'font-size="10.5" text-anchor="middle"')); });
    // the strips band under the ground, one box per strip
    const sb = G + 150, sh = 44, label = s => (s.name || (typeof RL_SECTION_TYPES !== 'undefined' ? (RL_SECTION_TYPES.find(t => t.id === s.type) || {}).name : '') || s.type);
    o.push(rect(40, sb, A - 40, sh, 'fill="#fff" stroke="#9c978a"'), tx((40 + A) / 2, sb + 18, 'Erf', 'font-size="12" font-weight="600" text-anchor="middle"'));
    o.push(rect(B, sb, W - 40 - B, sh, 'fill="#fff" stroke="#9c978a"'), tx((B + W - 40) / 2, sb + 18, 'Erf', 'font-size="12" font-weight="600" text-anchor="middle"'));
    y = 0; for (const s of v.list) { const w = Math.max(0, +s.width || 0); if (!(w > 0)) continue; const x0 = A + y * K, x1 = x0 + w * K; y += w;
      o.push(rect(x0, sb, x1 - x0, sh, `fill="${s.type === 'carriageway' ? '#dcdad3' : '#f1eee3'}" stroke="#9c978a"`), tx((x0 + x1) / 2, sb + 18, label(s) + (s.cls ? ' · ' + s.cls : ''), 'font-size="11" font-weight="600" text-anchor="middle"'), tx((x0 + x1) / 2, sb + 34, this.f2(w) + ' m', 'font-size="11" text-anchor="middle"')); }
    if (this._drag) { const dr = this._drag, val = d[dr.key].off; o.push(`<rect x="${A + val * K - 60}" y="${G - 150}" width="120" height="32" rx="5" fill="#1b1f24"/>`, tx(A + val * K, G - 138, dr.label + ' +' + this.f2(val) + ' m', 'font-size="12" font-weight="600" fill="#fff" text-anchor="middle"'), tx(A + val * K, G - 124, 'snaps to 10 mm' + (dr.fine ? ' · fine' : ''), 'font-size="10.5" fill="#fff" text-anchor="middle"')); }
    return { W, H, inner: o.join('') };
  },
  svg(sec) { const x = this.svgParts(sec); return `<svg id="rsx-draw" width="${escHtml(x.W)}" height="${escHtml(x.H)}" viewBox="0 0 ${escHtml(x.W)} ${escHtml(x.H)}" role="img" aria-label="Road section seen end-on, the services measured from the erf boundary" style="display:block;touch-action:none;font-family:inherit">${x.inner}</svg>`; },

  // ───────── the tables ─────────
  inp(path, val, unit, label, off) {
    return `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap"><input type="number" step="0.01" data-rsx-f="${escHtml(path)}" value="${this.f2(val)}" aria-label="${this.esc(label)}"${off ? ' disabled' : ''} style="width:76px;text-align:right">${unit ? `<span style="color:var(--text-muted)">${unit}</span>` : ''}</span>`;
  },
  _clsGroups(sec) {
    const des = this.RS().designOf(sec), sans = !des || des.standard === 'SANS';
    if (typeof RL_SANS_GROUPS === 'undefined' || typeof RL_CLASS_GROUPS === 'undefined') return [];
    return sans ? RL_SANS_GROUPS : RL_CLASS_GROUPS;
  },
  stripsHtml(sec) {
    const esc = this.esc, types = typeof RL_SECTION_TYPES !== 'undefined' ? RL_SECTION_TYPES : [{ id: 'verge', name: 'Verge' }, { id: 'carriageway', name: 'Carriageway' }];
    const surf = typeof RL_SURFACES !== 'undefined' ? RL_SURFACES : ['R3'], groups = this._clsGroups(sec), sp = this.RS().span(sec);
    const cls = (s, i) => `<select data-rsx-st="cls" data-i="${i}" aria-label="Lighting class of strip ${i + 1}"><option value=""${!s.cls ? ' selected' : ''}>—</option>${groups.map(g => `<optgroup label="${esc(g.label)}">${g.list.map(c => `<option value="${esc(c)}"${c === s.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>`).join('')}${s.cls && !groups.some(g => g.list.includes(s.cls)) ? `<option value="${esc(s.cls)}" selected>${esc(s.cls)}</option>` : ''}</select>`;
    const typed = types.filter(t => t.id !== 'verge'), n = sec.strips.length;
    const rows = sec.strips.map((s, i) => s.type === 'verge' ? `<tr style="color:var(--text-muted)">
      <td>Verge <small>(the rest)</small></td><td style="text-align:right;padding-right:10px">${this.f2(s.width)}</td><td>${cls(s, i)}</td><td>—</td><td style="font-size:12px">${i === 0 ? 'boundary A to the first strip' : 'last strip to boundary B'}</td></tr>` : `<tr>
      <td><select data-rsx-st="type" data-i="${i}" aria-label="Strip ${i + 1} type">${typed.map(t => `<option value="${esc(t.id)}"${t.id === s.type ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>
      <td><input type="number" step="0.1" min="0" data-rsx-st="width" data-i="${i}" value="${esc(s.width)}" aria-label="Strip ${i + 1} width" style="width:64px"></td>
      <td>${cls(s, i)}</td>
      <td>${s.type === 'carriageway' ? `<select data-rsx-st="surface" data-i="${i}" aria-label="Strip ${i + 1} road surface">${surf.map(x => `<option${x === s.surface ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="white-space:nowrap"><button type="button" class="plan-btn" data-rsx="up" data-i="${i}" aria-label="Move strip ${i + 1} left"${i && sec.strips[i - 1].type !== 'verge' ? '' : ' disabled'} style="padding:0 6px">←</button><button type="button" class="plan-btn" data-rsx="down" data-i="${i}" aria-label="Move strip ${i + 1} right"${i < n - 1 && sec.strips[i + 1].type !== 'verge' ? '' : ' disabled'} style="padding:0 6px">→</button><button type="button" class="plan-btn" data-rsx="rmst" data-i="${i}" aria-label="Remove strip ${i + 1}" style="padding:0 6px"${sec.strips.filter(x => x.type !== 'verge').length < 2 ? ' disabled' : ''}>&times;</button></td></tr>`).join('');
    return `<div style="font-weight:600;margin-bottom:4px">Strips <span style="font-weight:400;font-size:12px;color:var(--text-muted)">from boundary A, left to right · type the carriageway, footpaths, cycle lanes and medians; the rest of the reserve is verge</span></div>
      <table class="sl-table" style="width:100%"><thead><tr><th>Strip</th><th>Width m</th><th title="The lighting class the strip must meet (Lighting design)">Class</th><th title="Road surface (r-table), for luminance">Surface</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <button type="button" class="plan-btn" data-rsx="addst" style="margin-top:4px">+ Strip</button>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Reserve <b>${this.f2(this.RS().reserve(sec))} m</b>: ${this.f2(sp.a)} m from boundary A to the carriageway, carriageway ${this.f2(sp.road)} m, ${this.f2(sp.b)} m to boundary B. A road with no carriageway width of its own takes this one; the lighting designs on this section use these strips and classes.</div>`;
  },
  // ───────── the road reserve: picked, the strips fill it ─────────
  RESERVES: [13, 16, 20, 25, 30],                // the quick picks, m (any width can be typed)
  reserveHtml(sec) {
    const RS = this.RS(), esc = this.esc, p = RS.reserve(sec), g = RS.verges(sec);
    const on = w => p === w && !sec.resAuto, chip = w => `<button type="button" class="plan-btn" data-rsx="res" data-w="${w}" aria-pressed="${on(w)}" style="min-width:58px;min-height:36px;${on(w) ? 'outline:2px solid var(--accent,#2563eb);font-weight:600' : ''}">${w} m</button>`;
    return `<div style="display:flex;flex-direction:column;gap:6px">
      <div style="font-weight:600">Road reserve <span style="font-weight:400;font-size:12px;color:var(--text-muted)">${this.f2(p)} m${sec.resAuto ? ' (what the strips added up to: pick one to give it to the roads too)' : ''} · verge A ${this.f2(g.a)} m, verge B ${this.f2(g.b)} m</span></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${this.RESERVES.map(chip).join('')}
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text-muted)">Other <input type="number" step="0.5" min="3" max="80" data-rsx-res value="${this.f2(p)}" aria-label="Road reserve width, m" style="width:76px;text-align:right"> m</label></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px">
        <label style="display:flex;gap:6px;align-items:center">Carriageway <input type="number" step="0.1" data-rsx-cwoff value="${this.f2(g.want)}" aria-label="Carriageway offset from the middle of the reserve, m (+ toward boundary A)" style="width:68px;text-align:right"> m off the middle</label>
        <span style="font-size:12px;color:var(--text-muted)">0 = centred; + toward boundary A, − toward B${g.hi > g.lo ? ` (${this.f2(g.lo)} to ${this.f2(g.hi)} m)` : ''}</span>
        ${Math.abs(g.want) > 0.005 ? `<button type="button" class="plan-btn" data-rsx="cwmid" style="padding:1px 8px">Centre it</button>` : ''}</div>
      ${g.over > 0.005 ? `<div style="font-size:13px;color:#9a5b00">The typed strips are ${this.f2(g.filled)} m, ${this.f2(g.over)} m wider than the reserve: no verge is left. <button type="button" class="plan-btn" data-rsx="matchres" style="padding:1px 8px">Make the reserve ${this.f2(Math.max(3, g.filled))} m</button></div>` : g.shifted ? `<div style="font-size:12px;color:#9a5b00">The carriageway is ${this.f2(g.off)} m off the middle: as far as the verges let it go.</div>` : ''}</div>`;
  },
  // roads on this section with a reserve width of their own that is not the section's
  onPlanHtml(sec) {
    const RS = this.RS(), esc = this.esc, p = +sec.reserve > 0 && !sec.resAuto ? +sec.reserve : null; if (p == null) return '';
    const roads = RS.roadsUsing(sec.id), own = roads.map(r => +((r.props || {}).width)).filter(w => w > 0), mm = RS.widthMismatches(sec.id);
    const rng = own.length ? `${this.f2(Math.min(...own))} – ${this.f2(Math.max(...own))} m` : '';
    const nearBy = {}; mm.forEach(m => { if (m.near) (nearBy[m.near.id] = nearBy[m.near.id] || { sec: m.near, n: 0 }).n++; });
    return `<div><div style="font-weight:600;margin-bottom:4px">On the plan</div>
      <div style="font-size:13px">${roads.length} road${roads.length === 1 ? '' : 's'} use${roads.length === 1 ? 's' : ''} this section${own.length ? `; their own reserve widths are ${rng}` : ''}. A road with no width of its own takes the section's ${this.f2(p)} m.</div>
      ${mm.length ? `<div style="display:flex;gap:8px;font-size:13px;margin:4px 0"><b style="color:#9a5b00;min-width:46px">Check</b><span>${mm.length} road${mm.length === 1 ? ' has' : 's have'} a reserve width of ${mm.length === 1 ? 'its' : 'their'} own (${[...new Set(mm.map(m => this.f2(m.own)))].join(', ')} m), not ${this.f2(p)} m.</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="plan-btn" data-rsx="selmis" style="padding:1px 8px">Show on plan</button><button type="button" class="plan-btn" data-rsx="usew" style="padding:1px 8px">Use ${this.f2(p)} m on them</button>${Object.values(nearBy).map(x => `<button type="button" class="plan-btn" data-rsx="givenear" data-id="${esc(x.sec.id)}" style="padding:1px 8px">Give ${x.n === 1 ? 'it' : 'the ' + x.n} ${esc(x.sec.name)} (${this.f2(x.sec.reserve)} m)</button>`).join('')}</div>` : ''}</div>`;
  },
  poleHtml(sec) {
    const p = this.RS().pole(sec), esc = this.esc;
    return `<div><div style="font-weight:600;margin-bottom:4px">Street light</div>${p
      ? `<div style="font-size:13px">${this.f2(p.off)} m from boundary A, ${this.f2(p.h)} m high, ${this.f2(p.arm)} m arm: the first row of <b>${esc(p.design)}</b>. <button type="button" class="plan-btn" data-rsx="opendes" data-id="${esc(p.designId)}" style="padding:1px 8px">Edit in Lighting design</button></div>`
      : '<div style="font-size:12px;color:var(--text-muted)">No lighting design uses this section, so no street light is drawn. Pick this section in a Lighting design to place one.</div>'}</div>`;
  },
  // the services: where each sits (offset from boundary A: the standard's, or this section's own); a cable's trench is its trench type's size
  itemsHtml(sec) {
    const RS = this.RS(), d = sec.items, own = RS.own(sec, 'off'), O = RS.sizes(sec, 'off'), T = RS.sizes(sec, 'trench'), K = RS.sizes(sec, 'kiosk'), M = RS.sizes(sec, 'mh'), nm = t => (typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.trenchTypes[t] || {}).name || t;
    const tr = t => `${this.esc(nm(t))} ${this.f2(T[t].w)} × ${this.f2(T[t].d)} m`;
    const row = (k, size, note) => `<tr><td style="white-space:nowrap"><span style="color:${this.OFF_COL[k]}">&#9632;</span> ${this.LABELS.off[k]}</td><td>${this.inp(own ? 'items.' + k + '.off' : 'std.off.' + k, O[k], '', this.LABELS.off[k] + ' offset', !own)}</td><td style="white-space:nowrap">${size}</td><td style="font-size:12px;color:var(--text-muted);min-width:150px">${note}</td></tr>`;
    const table = `<table class="sl-table" style="width:100%"><thead><tr><th>Service</th><th title="From the erf boundary (A)">Offset from A, m</th><th>Trench / size</th><th>What it sets</th></tr></thead><tbody>
      ${row('svc', tr('LV/SL'), 'runs in the LV corridor')}
      ${row('lv', tr('LV/SL'), 'the corridor services and LV run on')}
      ${row('fi', tr('FI'), 'on the fibre (civil) side')}
      ${row('mv', tr('MV'), 'own trench beside the LV')}
      ${row('kiosk', `${this.f2(K.len)} × ${this.f2(K.depth)} m`, 'where the stand is: this + half its depth')}
      ${row('mh', `${this.f2(M.len)} × ${this.f2(M.wid)} m`, 'on the fibre side')}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Every offset is measured from the erf boundary on the side the service runs.${own ? '' : ' Dragging a service on the drawing gives this section offsets of its own.'}</div>`;
    return `${this.groupHtml(sec, 'off', table)}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;margin-top:8px"><span><span style="color:#8a6a00">&#9632;</span> Crossing sleeves (this section's)</span> depth ${this.inp('items.sleeve.depth', d.sleeve.depth, 'm', 'Crossing sleeves depth')} width ${this.inp('items.sleeve.w', d.sleeve.w, 'm', 'Crossing sleeves width')} <span style="font-size:12px;color:var(--text-muted)">across the carriageway</span></div>`;
  },
  // ───────── sizes: kiosk, manhole, trenches (the standard, or a section's own) ─────────
  LABELS: {
    off: { svc: 'Service cable', lv: 'LV feeder', fi: 'Fibre duct', mv: 'MV cable', kiosk: 'Kiosk (near face)', mh: 'Fibre manhole (centre)' },
    kiosk: { len: 'Length along the road', depth: 'Depth across, from the near face', h: 'Height', front: 'Clear space in front of the door', end: 'Clear space at either end' },
    mh: { len: 'Internal length', wid: 'Internal width', depth: 'Depth to invert', wall: 'Wall thickness', lid: 'Lid size', clear: 'Clear space around' },
  },
  OFF_COL: { svc: '#8a6a00', lv: '#b4501c', fi: '#2b5fa8', mv: '#6b3fa0', kiosk: '#2f3a45', mh: '#2b5fa8' },
  TITLES: { off: 'Offsets from the erf boundary', kiosk: 'Kiosk size', mh: 'Fibre manhole size', trench: 'Trench sizes' },
  TRENCH_USE: { 'MV': 'MV cable on its own', 'LV/SL': 'LV feeder, service cable, street light', 'MV/LV/SL': 'MV laid with the LV (Auto layout › Trenches)', 'FI': 'fibre ducts' },
  // the fields of a group; `pre` = the path prefix ('std.' or the section's), `v` = the values shown, `off` = greyed (following the standard)
  _fields(g, pre, v, off) {
    if (g === 'trench') {
      const nm = t => (typeof PLAN_DEFS !== 'undefined' && PLAN_DEFS.trenchTypes[t] || {}).name || t;
      return `<table class="sl-table" style="width:100%"><thead><tr><th>Trench</th><th>Width</th><th>Depth</th><th>Used for</th></tr></thead><tbody>${Object.keys(v).map(t => `<tr><td style="white-space:nowrap">${this.esc(nm(t))}</td><td>${this.inp(pre + 'trench.' + t + '.w', v[t].w, 'm', nm(t) + ' width', off)}</td><td>${this.inp(pre + 'trench.' + t + '.d', v[t].d, 'm', nm(t) + ' depth', off)}</td><td style="font-size:12px;color:var(--text-muted)">${this.esc(this.TRENCH_USE[t] || '')}</td></tr>`).join('')}</tbody></table>`;
    }
    const L = this.LABELS[g];
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${Object.keys(L).map(k => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${L[k]}${this.inp(pre + g + '.' + k, v[k], 'm', L[k], off)}</label>`).join('')}</div>`;
  },
  // a group on a section: From the standard / This section differs, Copy from…, Make these the standard
  groupHtml(sec, g, body) {
    const RS = this.RS(), esc = this.esc, own = RS.own(sec, g), v = RS.sizes(sec, g), others = RS.list().filter(x => x.id !== sec.id);
    const copy = others.length ? `<select data-rsx-copy="${g}" aria-label="Copy the ${this.TITLES[g].toLowerCase()} from another section"><option value="">Copy from section…</option>${others.map(x => `<option value="${esc(x.id)}">${esc(x.name)}${RS.own(x, g) ? '' : ' (standard)'}</option>`).join('')}</select>` : '';
    return `<div style="border:1px solid var(--border,#ddd);border-radius:8px;padding:8px 10px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b>${this.TITLES[g]}</b>
        <span style="font-size:12px;padding:1px 8px;border-radius:10px;background:${own ? '#fdf0dc' : 'var(--bg-panel,#f1eee3)'};color:${own ? '#8a4b00' : 'var(--text-muted)'}">${own ? 'This section’s own' : 'From the standard'}</span>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rsx-own="${g}"${own ? ' checked' : ''}> This section differs</label>
        ${copy}
        ${own ? `<button type="button" class="plan-btn" data-rsx="tostd" data-g="${g}" style="padding:1px 8px">Make these the standard</button>` : `<button type="button" class="plan-btn" data-rsx="pick" data-id="std" style="padding:1px 8px">Edit the standard</button>`}</div>
      ${body || this._fields(g, own ? '' : 'std.', v, !own)}</div>`;
  },
  kioskHtml(sec) { return this.groupHtml(sec, 'kiosk'); },
  mhHtml(sec) { return this.groupHtml(sec, 'mh'); },
  trenchHtml(sec) { return this.groupHtml(sec, 'trench'); },
  // the Project standard page
  stdHtml() {
    const RS = this.RS(), esc = this.esc, S = RS.std();
    const box = g => { const diff = RS.differing(g);
      return `<div style="border:1px solid var(--border,#ddd);border-radius:8px;padding:8px 10px"><div style="font-weight:600;margin-bottom:6px">${this.TITLES[g]}</div>${this._fields(g, 'std.', S[g], false)}
        <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${diff.length ? `Own ${g === 'off' ? 'offsets' : 'sizes'} in ${diff.map(x => `<button type="button" class="plan-btn" data-rsx="pick" data-id="${esc(x.id)}" style="padding:0 6px">${esc(x.name)}</button>`).join(' ')}: they do not follow this.` : 'Every road section uses these.'}</div></div>`; };
    return `<div style="display:flex;flex-direction:column;gap:12px;min-width:0">
      <div><h4 style="margin:0 0 4px">Project standard</h4><div style="font-size:13px;color:var(--text-muted)">Set once for the project. Every road section uses these unless it has its own (tick <i>This section differs</i> on the section, or <i>Copy from section…</i>). The offsets are measured from the erf boundary on the side each service runs. Trench sizes are also what a trench drawn on the plan takes when no width or depth is typed on it, and what Auto layout and the quantities use.</div></div>
      ${box('off')}${box('kiosk')}${box('mh')}${box('trench')}</div>`;
  },
  checksHtml(sec) {
    const col = { ok: '#0b6e3a', warn: '#9a5b00', info: '#5b6068' }, v = this.view(sec);
    let rows = PlanSections.checks(PlanSections.normalize({ id: v.id, name: v.name, strips: { a: Math.max(0.5, v.strips.a), road: Math.max(2, v.strips.road), b: Math.max(0.5, v.strips.b) }, items: v.items, trench: v.trench }, v.id));
    if (!v.pole) rows = rows.filter(c => !/pole/i.test(c.text));
    if (!rows.length) rows = [{ sev: 'ok', text: 'Clearances inside the section pass.' }];
    const mm = this.RS().mismatches().filter(x => x.sec.id === sec.id);
    const extra = mm.length ? [{ sev: 'warn', text: `${mm.length} road${mm.length === 1 ? ' has its own carriageway width' : 's have their own carriageway widths'} (${[...new Set(mm.map(x => this.f2(x.own)))].join(', ')} m), not this section's ${this.f2(mm[0].want)} m. Their own width is used.` }] : [];
    if (!this.RS().fits(sec)) { const g = this.RS().verges(sec);
      extra.unshift({ sev: 'warn', text: `The typed strips are ${this.f2(g.filled)} m, ${this.f2(g.over)} m wider than the ${this.f2(this.RS().reserve(sec))} m reserve: no verge is left.`, fit: true }); }
    const r = typeof PlanLayoutUI !== 'undefined' ? PlanLayoutUI.result : null, lay = r && r.secChecks && r.sections ? r.secChecks.filter(c => !c.sec || c.sec === sec.id) : [];
    return `<div><div style="font-weight:600;margin-bottom:4px">Checks</div>${rows.concat(extra, lay).map(c => `<div style="display:flex;gap:8px;font-size:13px;margin:2px 0"><b style="color:${col[c.sev] || '#5b6068'};min-width:46px">${c.sev === 'ok' ? 'Pass' : c.sev === 'warn' ? 'Check' : 'Note'}</b><span>${this.esc(c.text)}</span></div>`).join('')}${mm.length ? `<button type="button" class="plan-btn" data-rsx="usecw" style="margin-top:4px">Use the section's width on those roads</button>` : ''}${extra.some(c => c.fit) ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px"><button type="button" class="plan-btn" data-rsx="matchres">Make the reserve ${this.f2(Math.max(3, this.RS().verges(sec).filled))} m</button></div>` : ''}</div>`;
  },
  usedHtml(sec) {
    const RS = this.RS(), esc = this.esc, des = RS.designsUsing(sec.id), roads = RS.roadsUsing(sec.id), sl = RS.list && AppState.reticulation && AppState.reticulation.streetLighting;
    const rp = (sl && sl.roadPlan && sl.roadPlan.roads || []).filter(r => typeof RoadPlan !== 'undefined' && RoadPlan.sectionId && (RoadPlan.sectionId(r) || (RoadLight.design(r.designId) || {}).section) === sec.id);
    return `<div><div style="font-weight:600;margin-bottom:4px">Used by</div>
      ${des.map(x => `<div style="display:flex;justify-content:space-between;gap:6px;font-size:13px"><span>Lighting design · ${esc(x.name)}</span><button type="button" class="plan-btn" data-rsx="opendes" data-id="${esc(x.id)}" style="padding:1px 8px">Open</button></div>`).join('')}
      <div style="display:flex;justify-content:space-between;gap:6px;font-size:13px"><span>${roads.length} road${roads.length === 1 ? '' : 's'} on the plan${sec.id === RS.defId() ? ' (with the roads that have none of their own)' : ''}</span>${roads.length ? `<button type="button" class="plan-btn" data-rsx="selroads" style="padding:1px 8px">Select on plan</button>` : ''}</div>
      ${rp.length ? `<div style="font-size:13px">Road plan · ${rp.length} road${rp.length === 1 ? '' : 's'}</div>` : ''}
      ${!des.length && !roads.length ? '<div style="font-size:12px;color:var(--text-muted)">Nothing uses it yet.</div>' : ''}</div>`;
  },

  // ───────── the site plan's Roads tab ─────────
  _stripBar(sec) {
    const fill = t => ({ carriageway: '#55595f', median: '#9fc28f', verge: '#cfe3c1', footpath: '#c9c6bd', cycle: '#b7c3d6' })[t] || '#cfe3c1';
    return `<div aria-hidden="true" style="display:flex;height:18px;border-radius:4px;overflow:hidden;margin:2px 0">${(sec.strips || []).filter(t => +t.width > 0).map(t => `<span style="flex:${+t.width};background:${fill(t.type)}"></span>`).join('')}</div>`;
  },
  panelHtml() {
    if (typeof RoadSections === 'undefined' || !(AppState.reticulation && AppState.reticulation.streetLighting)) return '<div class="plan-card"><small>Road sections belong to a reticulation project.</small></div>';
    const RS = this.RS(), esc = this.esc; RS.ensure();
    const cur = RS.get(this.panelSel) || RS.def(), d = RS.defId(), sel = this._planRoads();
    const card = x => { const n = RS.roadsUsing(x.id).length, on = x.id === cur.id;
      return `<button type="button" class="plan-pal-item" data-rsp="pick" data-id="${esc(x.id)}" aria-pressed="${on}" style="flex-direction:column;align-items:flex-start;gap:2px;height:auto;padding:8px 10px;${on ? 'outline:2px solid var(--accent,#2563eb)' : ''}">
        <span style="display:flex;gap:6px;align-items:center;font-weight:600"><span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;background:${this.colour(x.id)}"></span>${esc(x.name)} · ${this.f2(RS.reserve(x)).replace(/\.00$/, '')} m</span>
        <small>${n} road${n === 1 ? '' : 's'}${x.id === d ? ' · default' : ''}${RS.fits(x) ? '' : ' · <b style="color:#9a5b00">strips wider than it</b>'}</small></button>`; };
    const onSecs = [...new Set(sel.map(r => (RS.of(r) || {}).name))].filter(Boolean);
    const mm = RS.widthMismatches(cur.id).length;
    return `<div class="plan-roads">
      <div class="plan-sec-head"><span>Road sections</span><button type="button" class="plan-btn" data-rsp="new" style="padding:1px 8px">+ New</button></div>
      ${RS.list().map(card).join('')}
      <div class="plan-card" style="display:flex;flex-direction:column;gap:6px">${sel.length
        ? `<span>${sel.length} road${sel.length === 1 ? '' : 's'} selected${onSecs.length ? ` (on ${esc(onSecs.join(', '))})` : ''}</span>
           <button type="button" class="plan-btn" data-rsp="apply" style="font-weight:600;min-height:36px">Give ${sel.length === 1 ? 'it' : 'them'} ${esc(cur.name)}</button>`
        : `<small>Click a road on the plan (Shift-click adds, or drag a box) to give it a section.</small>`}</div>
      <div style="border-top:1px solid var(--border,#e5e7eb);padding-top:8px;display:flex;flex-direction:column;gap:6px">
        <b>${esc(cur.name)}</b>${this._stripBar(cur)}
        <small>${esc(RS.summary(cur))}</small>
        ${RS.fits(cur) ? '' : `<small style="color:#9a5b00">The typed strips are ${this.f2(RS.verges(cur).filled)} m, wider than the ${this.f2(RS.reserve(cur))} m reserve.</small>`}
        ${mm ? `<small style="color:#9a5b00">${mm} road${mm === 1 ? ' has' : 's have'} a reserve width of ${mm === 1 ? 'its' : 'their'} own.</small>` : ''}
        <button type="button" class="plan-btn" data-rsp="edit" style="min-height:34px">Edit section…</button>
        <button type="button" class="plan-btn" data-rsp="selroads" style="min-height:34px"${RS.roadsUsing(cur.id).length ? '' : ' disabled'}>Select its roads</button>
        <button type="button" class="plan-btn" data-rsp="std" style="min-height:34px">Project standard…</button>
      </div>
      <small style="color:var(--text-muted)">While Roads is open the roads are coloured by section; dashed = on the default.</small></div>`;
  },
  // the site plan's Roads tab where the project has a site plan, else the dialog
  goRoads() {
    const tab = document.getElementById('btn-workspace-plan');
    if (tab && !tab.hidden && typeof window.switchWorkspace === 'function' && typeof PlanMarkup !== 'undefined' && AppState.reticulation && AppState.reticulation.streetLighting) {
      window.switchWorkspace('plan'); PlanMarkup.setMode('roads'); if (PlanMarkup.mode === 'roads') return;
    }
    this.open();
  },
  onPanelClick(b) {
    const RS = this.RS(), act = b.dataset.rsp, cur = RS.get(this.panelSel) || RS.def();
    const again = () => { if (typeof PlanUI !== 'undefined') PlanUI.renderPalette(); if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true }); };
    if (act === 'pick') { this.panelSel = b.dataset.id; again(); return; }
    if (act === 'new') { const s = RS.add('Road section ' + (RS.list().length + 1)); this.panelSel = s.id; this.changed(); this.open(s.id); again(); return; }
    if (act === 'edit') { this.open(cur.id); return; }
    if (act === 'std') { this.open('std'); return; }
    if (act === 'selroads') { this._toPlan(RS.roadsUsing(cur.id).map(r => r.id)); return; }
    if (act === 'apply') {
      const rs = this._planRoads(); if (!rs.length) return;
      RS.assign(rs, cur.id); PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.changed(); again();
      UI.toast(`"${cur.name}" given to ${rs.length} road${rs.length === 1 ? '' : 's'}.`, 'success');
    }
  },

  // ───────── a road's Properties: what its section gives it ─────────
  roadNote(route) {
    if (typeof RoadSections === 'undefined') return '';
    const RS = this.RS(), esc = this.esc, own = RS.of(route, true), sec = own || RS.def(), c = RS.carriage(route.props);
    if (!sec) return `<div class="plan-field"><button type="button" class="plan-btn" data-rs-act="open">Road sections…</button></div>`;
    const sp = RS.span(sec), mis = own && +((route.props || {}).carriageW) > 0 && Math.abs(sp.road - +route.props.carriageW) > 0.1;
    return `<div class="plan-field" style="font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:4px">
      <span><span aria-hidden="true" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${this.colour(sec.id)}"></span> ${esc(sec.name)}${own ? '' : ' (default)'}: ${esc(RS.summary(sec))}. Carriageway ${c.cw > 0 ? this.f2(c.cw) + ' m ' + (c.src === 'own' ? 'of its own' : 'from the section') : 'not set (Auto layout assumes its default)'}.</span>
      ${mis ? `<span style="color:#9a5b00">Its own carriageway (${this.f2(route.props.carriageW)} m) is not the section's ${this.f2(sp.road)} m. <button type="button" class="plan-btn" data-rs-act="usecw" style="padding:1px 8px">Use the section's</button></span>` : ''}
      <button type="button" class="plan-btn" data-rs-act="open" data-id="${esc(sec.id)}" style="align-self:flex-start">Edit road section…</button></div>`;
  },
  onPropsClick(b) {
    const act = b.dataset.rsAct;
    if (act === 'open') { this.open(b.dataset.id); return; }
    if (act === 'usecw') {
      for (const r of this._planRoads()) if (r.props) { delete r.props.carriageW; delete r.props.cwOffset; }
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.changed(); PlanMarkup.refreshProps();
    }
  },

  // ───────── roads on the plan in their section's colour ─────────
  drawOverlay(ctx, zoom, alpha) {
    if (typeof RoadSections === 'undefined' || !RoadSections.list().length) return;
    const u = 1 / zoom, routes = (AppState.planMarkup.routes || []).filter(r => r.type === 'street' && r.points && r.points.length >= 2);
    if (!routes.length) return;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.globalAlpha = alpha == null ? 0.6 : alpha; ctx.lineWidth = 7 * u;
    for (const r of routes) {
      const sec = RoadSections.of(r); if (!sec) continue;
      const pts = typeof PlanLayoutUI !== 'undefined' && PlanLayoutUI._flat ? PlanLayoutUI._flat(r) : r.points;
      ctx.strokeStyle = this.colour(sec.id); ctx.setLineDash(RoadSections.of(r, true) ? [] : [10 * u, 6 * u]);
      ctx.beginPath(); pts.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke();
    }
    ctx.restore();
  },

  // ───────── editing ─────────
  setPath(sec, path, v) {
    const parts = path.split('.'), RS = this.RS();
    if (parts[0] === 'std') { RS.setStd(parts[1], parts.slice(2).join('.'), v); return; }          // std.kiosk.len · std.trench.MV.w
    if (parts[0] === 'trench') { if (RS.own(sec, 'trench')) RS.setSize(sec, 'trench', parts.slice(1).join('.'), v); return; }
    if (parts[0] !== 'items') return;
    if ((parts[1] === 'kiosk' || parts[1] === 'mh') && parts[2] !== 'off' && !RS.own(sec, parts[1])) return;   // a size it takes from the standard
    if (parts[2] === 'off' && PlanSections.OFFS.includes(parts[1]) && !RS.own(sec, 'off')) return;               // an offset it takes from the standard
    const tgt = sec.items[parts[1]], key = parts[2], rng = PlanSections.SHAPE[parts[1]] && PlanSections.SHAPE[parts[1]][key];
    if (!tgt || !rng) return;
    const n = parseFloat(v); if (!Number.isFinite(n)) return;
    tgt[key] = PlanSections.snap(Math.max(rng[1], Math.min(rng[2], n)));
  },
  _change(e) {
    const t = e.target, RS = this.RS(), sec = this.cur();
    if (t.matches('[data-rsx-name]')) { sec.name = t.value.trim().slice(0, 60) || 'Road section'; this.changed(); this.render(); return; }
    if (t.matches('[data-rsx-f]')) { this.setPath(sec, t.dataset.rsxF, t.value); this.changed(); this.render(); return; }
    if (t.matches('[data-rsx-res]')) { if (t.value !== '') this._setRes(sec, t.value); else this.render(); return; }
    if (t.matches('[data-rsx-cwoff]')) { if (!RS.setCwOff(sec, t.value || 0)) UI.toast('The carriageway went as far as the verges let it.', 'info'); this.changed(); this.render(); return; }
    if (t.matches('[data-rsx-own]')) { RS.setOwn(sec, t.dataset.rsxOwn, t.checked); this.changed(); this.render(); return; }
    if (t.matches('[data-rsx-copy]')) { const from = RS.get(t.value); if (from && RS.copyFrom(sec, from, t.dataset.rsxCopy)) { UI.toast(`${this.TITLES[t.dataset.rsxCopy]} copied from "${from.name}".`, 'success'); this.changed(); } this.render(); return; }
    if (t.matches('[data-rsx-show]')) { this.showOn = t.checked; this.changed(); return; }
    if (t.matches('[data-rsx-tpl]')) {
      const tp = (typeof RL_TEMPLATES !== 'undefined' ? RL_TEMPLATES : []).find(x => x.id === t.value); if (!tp) return;
      const s = RS.add(tp.name, tp.sections.map(x => Object.assign({}, x, { cls: x.sans || '' }))); this.sel = s.id; this.changed(); this.render(); return;
    }
    if (t.matches('[data-rsx-st]')) {
      const s = sec.strips[+t.dataset.i], k = t.dataset.rsxSt; if (!s) return;
      if (k === 'width') { const n = parseFloat(t.value); if (!(Number.isFinite(n) && n >= 0 && n <= 60)) return; s.width = Math.round(n * 100) / 100; }
      else s[k] = t.value;
      this.changed(); this.render();
    }
  },
  _click(e) {
    const b = e.target.closest('[data-rsx]'); if (!b) return;
    const RS = this.RS(), sec = this.cur(), act = b.dataset.rsx, i = +b.dataset.i;
    if (act === 'close') { this.close(); return; }
    if (act === 'pick') { this.sel = b.dataset.id; this.render(); return; }
    if (act === 'new') { const s = RS.add('Road section ' + (RS.list().length + 1)); this.sel = s.id; this.changed(); this.render(); return; }
    if (act === 'dup') { const s = RS.duplicate(sec.id); if (s) this.sel = s.id; this.changed(); this.render(); return; }
    if (act === 'def') { RS.setDef(sec.id); this.changed(); this.render(); return; }
    if (act === 'res') { this._setRes(sec, b.dataset.w); return; }
    if (act === 'cwmid') { RS.setCwOff(sec, 0); this.changed(); this.render(); return; }
    if (act === 'matchres') { RS.matchReserve(sec); this.changed(); this.render(); return; }
    if (act === 'selmis' || act === 'usew' || act === 'givenear') {
      const mm = RS.widthMismatches(sec.id).filter(m => act !== 'givenear' || (m.near && m.near.id === b.dataset.id));
      if (act === 'selmis') { const ids = mm.map(m => m.route.id); this.close(); this._toPlan(ids); return; }
      if (act === 'usew') mm.forEach(m => { delete m.route.props.width; });
      else RS.assign(mm.map(m => m.route), b.dataset.id);
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.changed(); this.render(); return;
    }
    if (act === 'tostd') {
      const g = b.dataset.g, n = RS.list().filter(x => x !== sec && !RS.own(x, g)).length;
      UI.confirm(`Make the ${this.TITLES[g].toLowerCase()} of "${sec.name}" the project standard? ${n} other section${n === 1 ? '' : 's'} that follow${n === 1 ? 's' : ''} the standard change${n === 1 ? 's' : ''} with it.`, { okText: 'Make standard' }).then(ok => { if (ok && RS.toStd(sec, g)) { this.changed(); this.render(); } });
      return;
    }
    if (act === 'del') {
      const n = RS.roadsUsing(sec.id).filter(r => r.props && r.props.section === sec.id).length, nd = RS.designsUsing(sec.id).length;
      const go = () => { if (RS.remove(sec.id)) { this.sel = RS.defId(); this.changed(); this.render(); } };
      if (n || nd) UI.confirm(`"${sec.name}" is used by ${[n ? n + ' road' + (n === 1 ? '' : 's') : '', nd ? nd + ' lighting design' + (nd === 1 ? '' : 's') : ''].filter(Boolean).join(' and ')}. The roads go back to the default section; the designs keep these strips as their own. Delete it?`, { danger: true, okText: 'Delete' }).then(ok => { if (ok) go(); });
      else go();
      return;
    }
    if (act === 'addst') { sec.strips.push(RS.strip(sec, { type: 'footpath', width: 2 })); this.changed(); this.render(); return; }
    if (act === 'rmst') { if (sec.strips[i] && sec.strips[i].type !== 'verge' && sec.strips.filter(x => x.type !== 'verge').length > 1) { sec.strips.splice(i, 1); this.changed(); this.render(); } return; }
    if (act === 'up' || act === 'down') { const j = act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= sec.strips.length) return; [sec.strips[i], sec.strips[j]] = [sec.strips[j], sec.strips[i]]; this.changed(); this.render(); return; }
    if (act === 'apply') {
      const rs = this._planRoads(); if (!rs.length) return;
      RS.assign(rs, sec.id); PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.changed(); this.render();
      UI.toast(`"${sec.name}" applied to ${rs.length} road${rs.length === 1 ? '' : 's'}.`, 'success'); return;
    }
    if (act === 'selroads') {
      const ids = RS.roadsUsing(sec.id).map(r => r.id); this.close();
      if (typeof window !== 'undefined' && typeof window.switchWorkspace === 'function' && typeof PlanMarkup !== 'undefined' && PlanMarkup.context !== 'plan') window.switchWorkspace('plan');
      PlanMarkup.setSelection(ids); if (PlanMarkup.zoomToSelection) PlanMarkup.zoomToSelection(); return;
    }
    if (act === 'usecw') {
      for (const x of RS.mismatches().filter(m => m.sec.id === sec.id)) { delete x.route.props.carriageW; delete x.route.props.cwOffset; }
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); this.changed(); this.render(); return;
    }
    if (act === 'opendes') {
      const id = b.dataset.id; this.close();
      if (typeof window !== 'undefined' && typeof window.switchWorkspace === 'function') window.switchWorkspace('streetlight');
      if (typeof StreetLight !== 'undefined' && StreetLight.setView) StreetLight.setView('design');
      if (typeof RoadLight !== 'undefined') { RoadLight._selId = id; if (RoadLight._built) RoadLight.render(); }
    }
  },

  _setRes(sec, w) {
    const RS = this.RS();
    if (!RS.setReserve(sec, w)) UI.toast(`A ${w} m reserve is narrower than the typed strips: no verge is left.`, 'warn');
    this.changed(); this.render();
  },
  // to the site plan, with these roads selected
  _toPlan(ids) {
    if (typeof window !== 'undefined' && typeof window.switchWorkspace === 'function' && typeof PlanMarkup !== 'undefined' && PlanMarkup.context !== 'plan') window.switchWorkspace('plan');
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.setSelection(ids); if (PlanMarkup.zoomToSelection) PlanMarkup.zoomToSelection(); }
  },

  // ───────── dragging a service on the drawing ─────────
  _items: { svc: 'Service', lv: 'LV', fi: 'Fibre', mv: 'MV', kiosk: 'Kiosk', mh: 'Manhole' },
  _down(e) {
    const g = e.target.closest('[data-drag]'); if (!g || e.button > 0) return;
    const svg = this._m.querySelector('#rsx-draw'), sec = this.cur(), key = g.dataset.drag;
    if (!this._items[key]) return;
    e.preventDefault(); svg.setPointerCapture(e.pointerId); g.focus && g.focus({ preventScroll: true });
    this.RS().setOwn(sec, 'off', true);                                                       // moving one gives the section offsets of its own
    const x0 = e.clientX, o0 = sec.items[key].off, K = this.K;
    this._drag = { key, label: this._items[key], fine: false };
    const move = ev => {
      const fine = ev.altKey, dx = (ev.clientX - x0) / K * (fine ? 0.1 : 1);
      this._drag.fine = fine; sec.items[key].off = PlanSections.snap(Math.max(0, Math.min(PlanSections.SHAPE[key].off[2], o0 + dx)));
      this._m.querySelector('#rsx-draw').innerHTML = this.svgParts(sec).inner;                // the svg itself stays, so the pointer stays captured
      const fld = this._m.querySelector(`[data-rsx-f="items.${key}.off"]`); if (fld) fld.value = this.f2(sec.items[key].off);
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); this._drag = null; this.changed(); this.render(); };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  },
  _key(e) {
    const g = e.target.closest && e.target.closest('[data-drag]'); if (!g || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const sec = this.cur(), key = g.dataset.drag; if (!this._items[key]) return;
    e.preventDefault(); this.RS().setOwn(sec, 'off', true);
    const step = e.shiftKey ? 0.1 : 0.01;
    sec.items[key].off = PlanSections.snap(Math.max(0, Math.min(PlanSections.SHAPE[key].off[2], sec.items[key].off + (e.key === 'ArrowRight' ? step : -step))));
    this.changed(); this.render();
    const again = this._m.querySelector(`[data-drag="${key}"]`); if (again) again.focus({ preventScroll: true });
  },
};
if (typeof document !== 'undefined') {
  // Road sections live on the site plan's Roads tab; this hidden button only keeps them in Ctrl K (header.js lists it)
  const bind = () => {
    if (document.getElementById('btn-road-sections')) return;
    const tb = document.getElementById('toolbar'); if (!tb) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'btn-road-sections'; b.style.display = 'none'; b.textContent = 'Road sections';
    b.title = 'The road sections: what each road is made of (strips, reserve, services, sizes), on the site plan’s Roads tab';
    b.addEventListener('click', () => RoadSectionsUI.goRoads()); tb.appendChild(b);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
}
// the old name (the Auto layout's sections dialog)
const PlanSectionsUI = { open() { RoadSectionsUI.open(); } };
if (typeof module !== 'undefined' && module.exports) module.exports = RoadSectionsUI;
