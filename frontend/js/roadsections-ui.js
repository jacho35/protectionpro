/*
 * RoadSectionsUI — the Road sections page (Project › Road sections…, also from the Plan's Detect group, a road's Properties, a Lighting design
 * and Auto layout › Rules). The project's sections in a list; the one picked drawn end-on with every service placed from the erf boundary
 * (drag an item sideways — it snaps to 10 mm; Alt-drag is ten times finer; arrow keys nudge 10 mm, Shift 100 mm), its strips (the lighting
 * strips: type, width, lighting class, surface), the services, kiosk and manhole sizes, the checks, and where it is used. The street light
 * is drawn from the lighting design that uses the section (its first row) and is edited there.
 * A section is given to roads by selecting them on the plan: *Apply to the selected roads* here, or the Road section field in their
 * Properties (several roads at once). `drawOverlay` colours every road by its section (Show on plan, and Auto layout with sections on).
 * Data and rules: roadsections.js + plan-sections.js (pure).
 */
const RoadSectionsUI = {
  sel: null,                                      // the section being edited
  K: 40,                                          // px per m in the drawing
  showOn: false,                                  // colour the roads on the plan by their section
  PAL: ['#2563eb', '#0b6e6e', '#b4501c', '#7c3aed', '#8a6a00', '#be185d', '#15803d', '#475569'],
  _m: null,

  RS() { return RoadSections; },
  cur() { const RS = this.RS(); return RS.get(this.sel) || RS.def(); },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  f2(v) { return (+v).toFixed(2); },
  colour(id) { const i = Math.max(0, this.RS().list().findIndex(s => s.id === id)); return this.PAL[i % this.PAL.length]; },
  changed() {
    AppState.dirty = true;
    if (typeof PlanLayoutUI !== 'undefined' && PlanLayoutUI._active) PlanLayoutUI.touched();
    if (typeof RoadLight !== 'undefined' && RoadLight._built) { try { RoadLight.render(); RoadLight.recompute(); } catch (_) { /* not open */ } }
    if (typeof RoadPlan !== 'undefined' && RoadPlan._geo && RoadPlan._geo.clear) RoadPlan._geo.clear();
    if (typeof PlanEngine !== 'undefined' && PlanEngine.requestDraw) PlanEngine.requestDraw({ all: true });
  },

  // the section as the drawing and checks see it: verge A / road / verge B from its strips, the services as they are (the same objects, so a
  // drag edits the section), the pole from its lighting design (null without one)
  view(sec) {
    const sp = this.RS().span(sec), pole = this.RS().pole(sec);
    const items = Object.assign({}, sec.items, { pole: pole ? Object.assign({}, sec.items.pole, { off: pole.off, h: pole.h, arm: pole.arm }) : sec.items.pole });
    return { id: sec.id, name: sec.name, strips: { a: sp.a, road: sp.road, b: sp.b }, list: sec.strips, items, pole };
  },

  // ───────── the page ─────────
  open(id) {
    if (typeof RoadSections === 'undefined') return;
    if (this._m) { if (id) { this.sel = id; this.render(); } return; }
    const RS = this.RS(); RS.ensure();
    this.sel = RS.get(id) ? id : RS.defId();
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
  close() { if (this._m) { this._m.remove(); this._m = null; } if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); },

  _planRoads() { return typeof PlanMarkup !== 'undefined' ? [...PlanMarkup.selectedIds].map(id => (AppState.planMarkup.routes || []).find(r => r.id === id)).filter(r => r && r.type === 'street') : []; },

  render() {
    if (!this._m) return;
    const RS = this.RS(), sec = this.cur(), esc = this.esc, d = RS.defId();
    const rail = RS.list().map(x => { const n = RS.roadsUsing(x.id).length, nd = RS.designsUsing(x.id).length;
      return `<button type="button" class="plan-btn" data-rsx="pick" data-id="${esc(x.id)}" aria-pressed="${x.id === sec.id}" style="text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;${x.id === sec.id ? 'outline:2px solid var(--accent,#2563eb)' : ''}">
        <span style="display:flex;gap:6px;align-items:center"><span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;background:${this.colour(x.id)}"></span><b>${esc(x.name)}</b>${x.id === d ? ' <small>(default)</small>' : ''}</span>
        <span style="font-size:12px;color:var(--text-muted)">${esc(RS.summary(x))}</span>
        <span style="font-size:12px;color:var(--text-muted)">${n} road${n === 1 ? '' : 's'}${nd ? ` · ${nd} lighting design${nd === 1 ? '' : 's'}` : ''}</span></button>`; }).join('');
    const tpl = typeof RL_TEMPLATES !== 'undefined' ? `<select data-rsx-tpl aria-label="New section from a road-lighting template"><option value="">From a template…</option>${RL_TEMPLATES.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>` : '';
    const sel = this._planRoads();
    this._m.querySelector('#rsx-body').innerHTML = `<div class="rsx-grid">
      <div style="display:flex;flex-direction:column;gap:6px">${rail}
        <div style="display:flex;gap:4px;flex-wrap:wrap"><button type="button" class="plan-btn" data-rsx="new">+ New</button><button type="button" class="plan-btn" data-rsx="dup">Duplicate</button><button type="button" class="plan-btn" data-rsx="del"${RS.list().length < 2 ? ' disabled' : ''}>Delete</button></div>
        ${tpl}
        <div style="margin-top:8px;font-weight:600">Roads</div>
        <div style="font-size:12px;color:var(--text-muted)">A road with no section of its own uses the default. Select roads on the plan (Shift-click adds), then apply a section to them, or pick it in their Properties.</div>
        ${sel.length ? `<button type="button" class="plan-btn" data-rsx="apply" style="font-weight:600">Apply "${esc(sec.name)}" to the ${sel.length} selected road${sel.length === 1 ? '' : 's'}</button>` : '<div style="font-size:12px;color:var(--text-muted)">No roads selected on the plan.</div>'}
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rsx-show${this.showOn ? ' checked' : ''}> Colour the roads on the plan by section</label>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="display:flex;gap:8px;align-items:center">Name <input type="text" data-rsx-name value="${esc(sec.name)}" maxlength="60" style="max-width:280px"></label>
          <button type="button" class="plan-btn" data-rsx="def"${sec.id === d ? ' disabled' : ''}>${sec.id === d ? 'Default section' : 'Make default'}</button></div>
        <div id="rsx-svg" style="overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg-panel,#fbfaf7)">${this.svg(sec)}</div>
        <div style="font-size:12px;color:var(--text-muted)"><b>Drag</b> a service sideways to place it: it snaps to 10 mm, hold Alt for ten times finer. Focus one and use the arrow keys (10 mm, Shift 100 mm). Depth and size are the fields below.</div>
        <div style="min-width:0;overflow-x:auto">${this.stripsHtml(sec)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;align-items:start">${this.poleHtml(sec)}${this.checksHtml(sec)}${this.usedHtml(sec)}</div>
        <div style="min-width:0;overflow-x:auto">${this.itemsHtml(sec)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;align-items:start">${this.kioskHtml(sec)}${this.mhHtml(sec)}</div>
      </div></div>`;
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
  inp(path, val, unit, label) {
    return `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap"><input type="number" step="0.01" data-rsx-f="${escHtml(path)}" value="${this.f2(val)}" aria-label="${this.esc(label)}" style="width:76px;text-align:right">${unit ? `<span style="color:var(--text-muted)">${unit}</span>` : ''}</span>`;
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
    const rows = sec.strips.map((s, i) => `<tr>
      <td><select data-rsx-st="type" data-i="${i}" aria-label="Strip ${i + 1} type">${types.map(t => `<option value="${esc(t.id)}"${t.id === s.type ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>
      <td><input type="number" step="0.1" min="0" data-rsx-st="width" data-i="${i}" value="${esc(s.width)}" aria-label="Strip ${i + 1} width" style="width:64px"></td>
      <td>${cls(s, i)}</td>
      <td>${s.type === 'carriageway' ? `<select data-rsx-st="surface" data-i="${i}" aria-label="Strip ${i + 1} road surface">${surf.map(x => `<option${x === s.surface ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="white-space:nowrap"><button type="button" class="plan-btn" data-rsx="up" data-i="${i}" aria-label="Move strip ${i + 1} left"${i ? '' : ' disabled'} style="padding:0 6px">←</button><button type="button" class="plan-btn" data-rsx="down" data-i="${i}" aria-label="Move strip ${i + 1} right"${i < sec.strips.length - 1 ? '' : ' disabled'} style="padding:0 6px">→</button><button type="button" class="plan-btn" data-rsx="rmst" data-i="${i}" aria-label="Remove strip ${i + 1}" style="padding:0 6px"${sec.strips.length < 2 ? ' disabled' : ''}>&times;</button></td></tr>`).join('');
    return `<div style="font-weight:600;margin-bottom:4px">Strips <span style="font-weight:400;font-size:12px;color:var(--text-muted)">from boundary A, left to right</span></div>
      <table class="sl-table" style="width:100%"><thead><tr><th>Strip</th><th>Width m</th><th title="The lighting class the strip must meet (Lighting design)">Class</th><th title="Road surface (r-table), for luminance">Surface</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <button type="button" class="plan-btn" data-rsx="addst" style="margin-top:4px">+ Strip</button>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Reserve <b>${this.f2(sp.total)} m</b>: verge A ${this.f2(sp.a)} m, carriageway ${this.f2(sp.road)} m, verge B ${this.f2(sp.b)} m. A road with no carriageway width of its own takes this one; the lighting designs on this section use these strips and classes.</div>`;
  },
  poleHtml(sec) {
    const p = this.RS().pole(sec), esc = this.esc;
    return `<div><div style="font-weight:600;margin-bottom:4px">Street light</div>${p
      ? `<div style="font-size:13px">${this.f2(p.off)} m from boundary A, ${this.f2(p.h)} m high, ${this.f2(p.arm)} m arm: the first row of <b>${esc(p.design)}</b>. <button type="button" class="plan-btn" data-rsx="opendes" data-id="${esc(p.designId)}" style="padding:1px 8px">Edit in Lighting design</button></div>`
      : '<div style="font-size:12px;color:var(--text-muted)">No lighting design uses this section, so no street light is drawn. Pick this section in a Lighting design to place one.</div>'}</div>`;
  },
  itemsHtml(sec) {
    const d = sec.items, row = (k, name, col, off, dep, w, note) => `<tr><td style="white-space:nowrap"><span style="color:${col}">&#9632;</span> ${name}</td><td>${off == null ? '<span style="color:var(--text-muted)">—</span>' : this.inp('items.' + k + '.off', off, '', name + ' offset')}</td><td>${this.inp('items.' + k + '.' + dep[0], dep[1], '', name + ' ' + dep[2])}</td><td>${w == null ? '' : this.inp('items.' + k + '.w', w, '', name + ' width')}</td><td style="font-size:12px;color:var(--text-muted);min-width:150px">${note}</td></tr>`;
    return `<div style="font-weight:600;margin-bottom:4px">Services</div><table class="sl-table" style="width:100%"><thead><tr><th>Service</th><th title="From the erf boundary (A)">Offset from A, m</th><th>Depth / height, m</th><th>Width, m</th><th>What it sets</th></tr></thead><tbody>
      ${row('svc', 'Service cable', '#8a6a00', d.svc.off, ['depth', d.svc.depth, 'depth'], d.svc.w, 'service trench depth')}
      ${row('lv', 'LV feeder', '#b4501c', d.lv.off, ['depth', d.lv.depth, 'depth'], d.lv.w, 'the corridor services and LV run on')}
      ${row('fi', 'Fibre duct', '#2b5fa8', d.fi.off, ['depth', d.fi.depth, 'depth'], d.fi.w, 'on the fibre (civil) side')}
      ${row('mv', 'MV cable', '#6b3fa0', d.mv.off, ['depth', d.mv.depth, 'depth'], d.mv.w, 'own trench beside the LV')}
      ${row('kiosk', 'Kiosk (near face)', '#2f3a45', d.kiosk.off, ['h', d.kiosk.h, 'height'], null, 'where the stand is: this + half its depth')}
      ${row('sleeve', 'Crossing sleeves', '#8a6a00', null, ['depth', d.sleeve.depth, 'depth'], d.sleeve.w, 'across the carriageway')}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Every offset is measured from the erf boundary on the side the service runs. The service cable runs in the LV corridor.</div>`;
  },
  kioskHtml(sec) {
    const k = sec.items.kiosk, c = (key, label) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}${this.inp('items.kiosk.' + key, k[key], 'm', label)}</label>`;
    return `<div><div style="font-weight:600;margin-bottom:6px">Kiosk dimensions</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${c('len', 'Length along the road')}${c('depth', 'Depth across, from the near face')}${c('h', 'Height')}${c('front', 'Clear space in front of the door')}${c('end', 'Clear space at either end')}</div></div>`;
  },
  mhHtml(sec) {
    const k = sec.items.mh, c = (key, label) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}${this.inp('items.mh.' + key, k[key], 'm', label)}</label>`;
    return `<div><div style="font-weight:600;margin-bottom:6px">Fibre manhole dimensions</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${c('off', 'Offset from boundary A, centre')}${c('len', 'Internal length')}${c('wid', 'Internal width')}${c('depth', 'Depth to invert')}${c('wall', 'Wall thickness')}${c('lid', 'Lid size')}${c('clear', 'Clear space around')}</div></div>`;
  },
  checksHtml(sec) {
    const col = { ok: '#0b6e3a', warn: '#9a5b00', info: '#5b6068' }, v = this.view(sec);
    let rows = PlanSections.checks(PlanSections.normalize({ id: v.id, name: v.name, strips: { a: Math.max(0.5, v.strips.a), road: Math.max(2, v.strips.road), b: Math.max(0.5, v.strips.b) }, items: v.items }, v.id));
    if (!v.pole) rows = rows.filter(c => !/pole/i.test(c.text));
    if (!rows.length) rows = [{ sev: 'ok', text: 'Clearances inside the section pass.' }];
    const mm = this.RS().mismatches().filter(x => x.sec.id === sec.id);
    const extra = mm.length ? [{ sev: 'warn', text: `${mm.length} road${mm.length === 1 ? ' has its own carriageway width' : 's have their own carriageway widths'} (${[...new Set(mm.map(x => this.f2(x.own)))].join(', ')} m), not this section's ${this.f2(mm[0].want)} m. Their own width is used.` }] : [];
    const r = typeof PlanLayoutUI !== 'undefined' ? PlanLayoutUI.result : null, lay = r && r.secChecks && r.sections ? r.secChecks.filter(c => !c.sec || c.sec === sec.id) : [];
    return `<div><div style="font-weight:600;margin-bottom:4px">Checks</div>${rows.concat(extra, lay).map(c => `<div style="display:flex;gap:8px;font-size:13px;margin:2px 0"><b style="color:${col[c.sev] || '#5b6068'};min-width:46px">${c.sev === 'ok' ? 'Pass' : c.sev === 'warn' ? 'Check' : 'Note'}</b><span>${this.esc(c.text)}</span></div>`).join('')}${mm.length ? `<button type="button" class="plan-btn" data-rsx="usecw" style="margin-top:4px">Use the section's width on those roads</button>` : ''}</div>`;
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
    const parts = path.split('.'); if (parts[0] !== 'items') return;
    const tgt = sec.items[parts[1]], key = parts[2], rng = PlanSections.SHAPE[parts[1]] && PlanSections.SHAPE[parts[1]][key];
    if (!tgt || !rng) return;
    const n = parseFloat(v); if (!Number.isFinite(n)) return;
    tgt[key] = PlanSections.snap(Math.max(rng[1], Math.min(rng[2], n)));
  },
  _change(e) {
    const t = e.target, RS = this.RS(), sec = this.cur();
    if (t.matches('[data-rsx-name]')) { sec.name = t.value.trim().slice(0, 60) || 'Road section'; this.changed(); this.render(); return; }
    if (t.matches('[data-rsx-f]')) { this.setPath(sec, t.dataset.rsxF, t.value); this.changed(); this.render(); return; }
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
    if (act === 'del') {
      const n = RS.roadsUsing(sec.id).filter(r => r.props && r.props.section === sec.id).length, nd = RS.designsUsing(sec.id).length;
      const go = () => { if (RS.remove(sec.id)) { this.sel = RS.defId(); this.changed(); this.render(); } };
      if (n || nd) UI.confirm(`"${sec.name}" is used by ${[n ? n + ' road' + (n === 1 ? '' : 's') : '', nd ? nd + ' lighting design' + (nd === 1 ? '' : 's') : ''].filter(Boolean).join(' and ')}. The roads go back to the default section; the designs keep these strips as their own. Delete it?`, { danger: true, okText: 'Delete' }).then(ok => { if (ok) go(); });
      else go();
      return;
    }
    if (act === 'addst') { sec.strips.push(RS.strip(sec, { type: 'footpath', width: 2 })); this.changed(); this.render(); return; }
    if (act === 'rmst') { if (sec.strips.length > 1) { sec.strips.splice(i, 1); this.changed(); this.render(); } return; }
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

  // ───────── dragging a service on the drawing ─────────
  _items: { svc: 'Service', lv: 'LV', fi: 'Fibre', mv: 'MV', kiosk: 'Kiosk', mh: 'Manhole' },
  _down(e) {
    const g = e.target.closest('[data-drag]'); if (!g || e.button > 0) return;
    const svg = this._m.querySelector('#rsx-draw'), sec = this.cur(), key = g.dataset.drag;
    if (!this._items[key]) return;
    e.preventDefault(); svg.setPointerCapture(e.pointerId); g.focus && g.focus({ preventScroll: true });
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
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.01;
    sec.items[key].off = PlanSections.snap(Math.max(0, Math.min(PlanSections.SHAPE[key].off[2], sec.items[key].off + (e.key === 'ArrowRight' ? step : -step))));
    this.changed(); this.render();
    const again = this._m.querySelector(`[data-drag="${key}"]`); if (again) again.focus({ preventScroll: true });
  },
};
if (typeof document !== 'undefined') {
  const bind = () => { const b = document.getElementById('btn-road-sections'); if (b && !b._rs) { b._rs = true; b.addEventListener('click', () => RoadSectionsUI.open()); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
}
// the old name (the Auto layout's sections dialog)
const PlanSectionsUI = { open() { RoadSectionsUI.open(); } };
if (typeof module !== 'undefined' && module.exports) module.exports = RoadSectionsUI;
