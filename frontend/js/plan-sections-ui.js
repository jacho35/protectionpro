/*
 * PlanSectionsUI — the cross-section builder of the Auto layout (Rules › Cross-sections › Edit sections…).
 * One dialog: the section tabs, the cross-section drawn with every item placed from the erf boundary (drag an item sideways — it snaps to
 * 10 mm; Alt-drag is ten times finer; arrow keys nudge 10 mm, Shift 100 mm), the strip / item / kiosk / manhole tables with their fields,
 * the checks, and the section lines (which section applies to which stretch of street). Data and rules: plan-sections.js (pure); the
 * engine reads the same object (`input.sections`). Lines are drawn on the plan with the Section line tool (PlanLayoutUI.secDrawOn).
 */
const PlanSectionsUI = {
  sel: null,                                      // the section being edited
  K: 40,                                          // px per m in the drawing
  _m: null,

  S() { return PlanLayoutUI.cfg().sections; },
  cur() { const S = this.S(); return S.list.find(x => x.id === this.sel) || S.list.find(x => x.id === S.def) || S.list[0]; },
  changed() { PlanLayoutUI.touched(); },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  f2(v) { return (+v).toFixed(2); },

  // ───────── the dialog ─────────
  open() {
    if (this._m) return;
    const S = this.S(); this.sel = S.def;
    const m = document.createElement('div');
    m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'psx-title');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    m.innerHTML = `<div class="modal-content modal-wide" style="max-height:92vh;display:flex;flex-direction:column;width:min(1100px,96vw)">
      <div class="modal-header"><h3 id="psx-title">Street cross-sections</h3><button class="modal-close" data-psx="close" aria-label="Close">&times;</button></div>
      <style>#psx-body>*{flex-shrink:0}#psx-body input[type=number]{min-width:0}</style>
      <div id="psx-body" style="overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:14px"></div>
      <div class="modal-footer" style="display:flex;align-items:center;gap:10px"><span style="flex:1;color:var(--text-muted);font-size:12px">Every offset is measured from the erf boundary. Changes apply as you make them.</span><button class="btn-small btn-primary" data-psx="close">Done</button></div></div>`;
    document.body.appendChild(m); this._m = m;
    m.addEventListener('click', e => this._click(e));
    m.addEventListener('change', e => this._change(e));
    m.addEventListener('pointerdown', e => this._down(e));
    m.addEventListener('keydown', e => this._key(e));
    this.render();
  },
  close() { if (this._m) { this._m.remove(); this._m = null; } if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps(); },

  render() {
    if (!this._m) return;
    const S = this.S(), sec = this.cur(), esc = this.esc;
    const tabs = S.list.map(x => `<button type="button" class="plan-btn" data-psx="tab" data-id="${esc(x.id)}" aria-pressed="${x.id === sec.id}" style="padding:6px 12px;min-height:34px;${x.id === sec.id ? 'font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${esc(x.name)}${x.id === S.def ? ' <small>(default)</small>' : ''}</button>`).join('');
    const body = this._m.querySelector('#psx-body');
    body.innerHTML = `
      <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-psx-on${S.on ? ' checked' : ''}><span><b>Use these sections in the layout.</b> <span style="color:var(--text-muted)">Off: every cable runs ${PlanLayoutUI.cfg().params.kd} m inside the boundary (the Corridor rule), as before.${PlanLayoutUI.cfg().params.kgeo === 'street' ? ' <b>The layout is set to place from the street line, which ignores offsets: change Corridor in Rules.</b>' : ''}</span></span></label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${tabs}<button type="button" class="plan-btn" data-psx="new" style="padding:6px 12px;min-height:34px">+ New section</button>
        <button type="button" class="plan-btn" data-psx="dup" style="padding:6px 12px;min-height:34px">Duplicate</button>
        <button type="button" class="plan-btn" data-psx="del" style="padding:6px 12px;min-height:34px"${S.list.length < 2 ? ' disabled' : ''}>Delete</button>
        <button type="button" class="plan-btn" data-psx="def" style="padding:6px 12px;min-height:34px"${sec.id === S.def ? ' disabled' : ''}>Make default</button></div>
      <label style="display:flex;gap:8px;align-items:center">Name <input type="text" data-psx-name value="${esc(sec.name)}" maxlength="60" style="flex:1;max-width:320px"></label>
      <div id="psx-svg" style="overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg-panel,#fbfaf7)">${this.svg(sec)}</div>
      <div style="font-size:12px;color:var(--text-muted)"><b>Drag</b> an item sideways to place it: it snaps to 10 mm, hold Alt for ten times finer. Focus an item and use the arrow keys (10 mm, Shift 100 mm). Depth and size are the fields below.</div>
      <div style="display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);gap:14px;align-items:start">
        <div style="min-width:0;overflow-x:auto">${this.itemsHtml(sec)}</div>
        <div style="display:flex;flex-direction:column;gap:14px;min-width:0">${this.stripsHtml(sec)}${this.checksHtml(sec)}</div></div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start">${this.kioskHtml(sec)}${this.mhHtml(sec)}</div>
      ${this.linesHtml()}`;
  },

  // ───────── the cross-section drawing ─────────
  // x runs left to right: erf, verge A, carriageway, verge B, erf. Boundary A is the datum (0.00). Heights are not to scale.
  geom(sec) {
    const K = this.K, pad = 2 * K, A = 40 + pad, road0 = A + sec.strips.a * K, road1 = road0 + sec.strips.road * K, B = road1 + sec.strips.b * K;
    return { K, A, road0, road1, B, W: B + pad + 40, G: 190 };
  },
  svgParts(sec) {
    const g = this.geom(sec), { K, A, road0, road1, B, W, G } = g, d = sec.items, esc = this.esc, H = 410;
    const X = off => A + off * K, o = [];
    const rect = (x, y, w, h, st) => `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" ${st}/>`;
    const tx = (x, y, t, st) => `<text x="${x}" y="${y}" ${st || 'font-size="11"'}>${esc(t)}</text>`;
    o.push(rect(40, G - 90, A - 40, 90, 'fill="#fff" stroke="#d6d2c4"'), rect(B, G - 90, W - B - 40 + 0, 90, 'fill="#fff" stroke="#d6d2c4"'));
    o.push(tx(46, G - 70, 'Erf', 'font-size="11" fill="#5b6068"'), tx(B + 6, G - 70, 'Erf', 'font-size="11" fill="#5b6068"'));
    o.push(rect(40, G, W - 80, 80, 'fill="#e7e2d3"'), rect(road0, G, road1 - road0, 5, 'fill="#55595f"'), rect(road0, G - 12, 7, 12, 'fill="#8d9097"'), rect(road1 - 7, G - 12, 7, 12, 'fill="#8d9097"'));
    o.push(rect(road0, G + d.sleeve.depth * K - 5, road1 - road0, 10, 'fill="none" stroke="#8a6a00" stroke-width="2" stroke-dasharray="5 4"'), tx(road0 + 8, G + d.sleeve.depth * K + 20, 'crossing sleeves', 'font-size="11" fill="#8a6a00"'));
    for (const [x, l] of [[A, 'Boundary A = 0.00'], [B, 'Boundary B']]) o.push(`<line x1="${x}" y1="60" x2="${x}" y2="${H - 56}" stroke="#1b1f24" stroke-width="1.5" stroke-dasharray="5 4"/>`, tx(x, 52, l, 'font-size="12" font-weight="600" text-anchor="middle"'));
    const items = [];                                                         // [key, label, colour, x centre, bottom y (for the stem), tag row]
    const trench = (k, L, col, row) => { const t = d[k], cx = X(t.off); o.push(`<g data-drag="${k}" tabindex="0" role="slider" aria-label="${L} offset from boundary A" aria-valuenow="${t.off}" style="cursor:ew-resize">${rect(cx - t.w * K / 2, G, t.w * K, t.depth * K, `fill="${col}"`)}${rect(cx - 12, G, 24, t.depth * K + 4, 'fill="transparent"')}</g>`, tx(cx - 4, G + t.depth * K + 15, L[0], `font-size="11" font-weight="700" fill="${col}"`)); items.push([k, cx, G + t.depth * K + 18, row, t.off, L]); };
    trench('svc', 'Service', '#8a6a00', 1); trench('lv', 'LV', '#b4501c', 2); trench('fi', 'Fibre', '#2b5fa8', 1); trench('mv', 'MV', '#6b3fa0', 2);
    const mh = d.mh, mx = X(mh.off);
    o.push(`<g data-drag="mh" tabindex="0" role="slider" aria-label="Fibre manhole offset from boundary A" aria-valuenow="${mh.off}" style="cursor:ew-resize">${rect(mx - mh.len * K / 2, G + 2, mh.len * K, mh.depth * K, 'fill="#dce6f4" stroke="#2b5fa8" stroke-width="2" stroke-dasharray="5 4"')}${tx(mx, G + 22, 'FMH', 'font-size="11" font-weight="700" fill="#2b5fa8" text-anchor="middle"')}</g>`);
    items.push(['mh', mx, G + mh.depth * K + 4, 3, mh.off, 'Manhole']);
    const k = d.kiosk, kx = X(k.off);
    o.push(`<g data-drag="kiosk" tabindex="0" role="slider" aria-label="Kiosk near face offset from boundary A" aria-valuenow="${k.off}" style="cursor:ew-resize">${rect(kx, G - k.h * K - 6, k.depth * K, k.h * K + 6, 'fill="#2f3a45" stroke="#0b6e6e" stroke-width="2"')}${tx(kx + k.depth * K / 2, G - k.h * K / 2, 'Kiosk', 'font-size="11" fill="#fff" text-anchor="middle"')}</g>`);
    items.push(['kiosk', kx, G, 3, k.off, 'Kiosk']);
    const px = X(d.pole.off), ph = 150;
    o.push(`<g data-drag="pole" tabindex="0" role="slider" aria-label="Street light offset from boundary A" aria-valuenow="${d.pole.off}" style="cursor:ew-resize"><rect x="${px - 2}" y="${G - ph}" width="4" height="${ph}" fill="#1b1f24"/><rect x="${px - 2}" y="${G - ph}" width="${d.pole.arm * K}" height="4" fill="#1b1f24"/><rect x="${px + d.pole.arm * K - 8}" y="${G - ph}" width="16" height="7" fill="#1b1f24"/><rect x="${px - 10}" y="${G - ph}" width="20" height="${ph}" fill="transparent"/></g>`, tx(px + 8, G - ph - 6, `Street light ${this.f2(d.pole.h)} m`, 'font-size="11"'));
    items.push(['pole', px, G, 1, d.pole.off, 'Street light']);
    items.forEach(([key, cx, y0, row, off, L]) => { const ty = G + 96 + row * 18; o.push(`<line x1="${cx}" y1="${y0}" x2="${cx}" y2="${ty}" stroke="#9c978a"/>`, `<rect x="${cx - 21}" y="${ty}" width="42" height="15" fill="#fbfaf7" stroke="#d6d2c4"/>`, tx(cx, ty + 11, '+' + this.f2(off), 'font-size="10.5" text-anchor="middle"')); });
    const sb = G + 150, sh = 44;
    [['Erf', 40, A, '#fff', ''], ['Verge A', A, road0, '#f1eee3', sec.strips.a], ['Carriageway', road0, road1, '#dcdad3', sec.strips.road], ['Verge B', road1, B, '#f1eee3', sec.strips.b], ['Erf', B, W - 40, '#fff', '']].forEach(([n, x0, x1, fill, w]) => {
      o.push(rect(x0, sb, x1 - x0, sh, `fill="${fill}" stroke="#9c978a"`), tx((x0 + x1) / 2, sb + 18, n, 'font-size="12" font-weight="600" text-anchor="middle"'), tx((x0 + x1) / 2, sb + 34, w === '' ? '' : this.f2(w) + ' m', 'font-size="11" text-anchor="middle"'));
    });
    if (this._drag) { const dr = this._drag, v = d[dr.key].off; o.push(`<rect x="${A + v * K - 60}" y="${G - 150}" width="120" height="32" rx="5" fill="#1b1f24"/>`, tx(A + v * K, G - 138, dr.label + ' +' + this.f2(v) + ' m', 'font-size="12" font-weight="600" fill="#fff" text-anchor="middle"'), tx(A + v * K, G - 124, 'snaps to 10 mm' + (dr.fine ? ' · fine' : ''), 'font-size="10.5" fill="#fff" text-anchor="middle"')); }
    return { W, H, inner: o.join('') };
  },
  svg(sec) { const x = this.svgParts(sec); return `<svg id="psx-draw" width="${x.W}" height="${x.H}" viewBox="0 0 ${x.W} ${x.H}" role="img" aria-label="Street cross-section, everything measured from the erf boundary" style="display:block;touch-action:none;font-family:inherit">${x.inner}</svg>`; },

  // ───────── the tables ─────────
  inp(path, val, unit, label) {
    return `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap"><input type="number" step="0.01" data-psx-f="${path}" value="${this.f2(val)}" aria-label="${this.esc(label)}" style="width:76px;text-align:right">${unit ? `<span style="color:var(--text-muted)">${unit}</span>` : ''}</span>`;
  },
  itemsHtml(sec) {
    const d = sec.items, row = (k, name, col, off, dep, w, note) => `<tr><td style="white-space:nowrap"><span style="color:${col}">&#9632;</span> ${name}</td><td>${off == null ? '<span style="color:var(--text-muted)">with LV</span>' : this.inp('items.' + k + '.off', off, '', name + ' offset')}</td><td>${this.inp('items.' + k + '.' + dep[0], dep[1], '', name + ' ' + dep[2])}</td><td>${w == null ? '' : this.inp('items.' + k + '.w', w, '', name + ' width')}</td><td style="font-size:12px;color:var(--text-muted);min-width:150px">${note}</td></tr>`;
    return `<div style="font-weight:600;margin-bottom:4px">Items</div><table class="sl-table" style="width:100%"><thead><tr><th>Item</th><th title="From the erf boundary (A)">Offset from A, m</th><th>Depth / height, m</th><th>Width, m</th><th>What it sets</th></tr></thead><tbody>
      ${row('svc', 'Service cable', '#8a6a00', d.svc.off, ['depth', d.svc.depth, 'depth'], d.svc.w, 'service trench depth')}
      ${row('lv', 'LV feeder', '#b4501c', d.lv.off, ['depth', d.lv.depth, 'depth'], d.lv.w, 'the corridor services and LV run on')}
      ${row('fi', 'Fibre duct', '#2b5fa8', d.fi.off, ['depth', d.fi.depth, 'depth'], d.fi.w, 'on the fibre (civil) side')}
      ${row('mv', 'MV cable', '#6b3fa0', d.mv.off, ['depth', d.mv.depth, 'depth'], d.mv.w, 'own trench beside the LV')}
      ${row('kiosk', 'Kiosk (near face)', '#2f3a45', d.kiosk.off, ['h', d.kiosk.h, 'height'], null, 'where the stand is: this + half its depth')}
      ${row('pole', 'Street light', '#1b1f24', d.pole.off, ['h', d.pole.h, 'height'], null, 'not placed by the layout; checked')}
      ${row('sleeve', 'Crossing sleeves', '#8a6a00', null, ['depth', d.sleeve.depth, 'depth'], d.sleeve.w, 'across the carriageway')}</tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">The service cable runs in the LV corridor, so its offset follows the LV feeder.</div>`;
  },
  stripsHtml(sec) {
    const t = sec.strips, reserve = t.a + t.road + t.b;
    return `<div><div style="font-weight:600;margin-bottom:4px">Strips</div><table class="sl-table" style="width:100%"><tbody>
      <tr><td>Verge A</td><td>${this.inp('strips.a', t.a, 'm', 'Verge A width')}</td></tr><tr><td>Carriageway</td><td>${this.inp('strips.road', t.road, 'm', 'Carriageway width')}</td></tr><tr><td>Verge B</td><td>${this.inp('strips.b', t.b, 'm', 'Verge B width')}</td></tr></tbody></table>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Reserve <b>${this.f2(reserve)} m</b>. Its centre is computed, never typed. The layout compares it with how far apart the erf boundaries really are.</div></div>`;
  },
  kioskHtml(sec) {
    const k = sec.items.kiosk, c = (key, label) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}${this.inp('items.kiosk.' + key, k[key], 'm', label)}</label>`;
    return `<div><div style="font-weight:600;margin-bottom:6px">Kiosk dimensions</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${c('len', 'Length along the street')}${c('depth', 'Depth across, from the near face')}${c('h', 'Height')}${c('front', 'Clear space in front of the door')}${c('end', 'Clear space at either end')}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Depth sets the box in the drawing; length and clear space set how close two kiosks may stand.</div></div>`;
  },
  mhHtml(sec) {
    const k = sec.items.mh, c = (key, label) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--text-muted)">${label}${this.inp('items.mh.' + key, k[key], 'm', label)}</label>`;
    return `<div><div style="font-weight:600;margin-bottom:6px">Fibre manhole dimensions</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${c('off', 'Offset from boundary A, centre')}${c('len', 'Internal length')}${c('wid', 'Internal width')}${c('depth', 'Depth to invert')}${c('wall', 'Wall thickness')}${c('lid', 'Lid size')}${c('clear', 'Clear space around')}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">The fibre network decides where manholes go; the section decides how far across the verge and how big.</div></div>`;
  },
  checksHtml(sec) {
    const col = { ok: '#0b6e3a', warn: '#9a5b00', info: '#5b6068' }, rows = PlanSections.checks(sec);
    const r = PlanLayoutUI.result, lay = r && r.secChecks && r.sections ? r.secChecks : [];
    return `<div><div style="font-weight:600;margin-bottom:4px">Checks</div>${rows.concat(lay).map(c => `<div style="display:flex;gap:8px;font-size:13px;margin:2px 0"><b style="color:${col[c.sev] || '#5b6068'};min-width:46px">${c.sev === 'ok' ? 'Pass' : c.sev === 'warn' ? 'Check' : 'Note'}</b><span>${this.esc(c.text)}</span></div>`).join('')}${lay.length ? '' : '<div style="font-size:12px;color:var(--text-muted)">Run the layout for the checks against the real erf boundaries.</div>'}</div>`;
  },
  linesHtml() {
    const S = this.S(), esc = this.esc, routes = AppState.planMarkup.routes, nm = id => { const r = routes.find(x => x.id === id); return r ? ((r.props && r.props.name) || id) : id + ' (removed)'; };
    const opts = cur => S.list.map(x => `<option value="${esc(x.id)}"${x.id === cur ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const ov = PlanSections.overlaps(S.lines);
    return `<div><div style="font-weight:600;margin-bottom:4px">Where each section applies</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><label>Streets with no line use <select data-psx-def>${opts(S.def)}</select></label>
        <button type="button" class="plan-btn" data-psx="draw" style="padding:6px 12px;min-height:34px;font-weight:600">Draw section line on the plan</button></div>
      ${S.lines.length ? `<table class="sl-table" style="width:100%"><thead><tr><th>Street</th><th>From m</th><th>To m</th><th>Section</th><th></th></tr></thead><tbody>${S.lines.map(l => `<tr><td>${esc(nm(l.streetId))}</td><td>${this.f2(Math.min(l.s0, l.s1))}</td><td>${this.f2(Math.max(l.s0, l.s1))}</td><td><select data-psx-line="${esc(l.id)}">${opts(l.sec)}</select></td><td><button type="button" class="plan-btn" data-psx="lineshow" data-id="${esc(l.id)}" style="padding:2px 8px">Show</button> <button type="button" class="plan-btn" data-psx="linedel" data-id="${esc(l.id)}" aria-label="Delete section line" style="padding:2px 8px">&times;</button></td></tr>`).join('')}</tbody></table>` : '<div style="font-size:13px;color:var(--text-muted)">No section line drawn: every street uses the default section.</div>'}
      ${ov.length ? `<div style="color:#9a5b00;font-size:13px;margin-top:4px"><b>${ov.length} overlap${ov.length === 1 ? '' : 's'}:</b> where two lines cover the same stretch, the one drawn last applies.</div>` : ''}
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">A line is read along the street: only where it starts and ends on the street counts, and nothing is placed sideways from it. A stretch is kept as metres along the street line: redraw it if you redraw the street.</div></div>`;
  },

  // ───────── editing ─────────
  setPath(sec, path, v) {
    const parts = path.split('.'), tgt = parts[0] === 'strips' ? sec.strips : sec.items[parts[1]], key = parts[parts.length - 1];
    const grp = parts[0] === 'strips' ? 'strips' : parts[1], rng = PlanSections.SHAPE[grp] && PlanSections.SHAPE[grp][key];
    if (!tgt || !rng) return;
    const n = parseFloat(v); if (!Number.isFinite(n)) return;
    tgt[key] = PlanSections.snap(Math.max(rng[1], Math.min(rng[2], n)));
  },
  _change(e) {
    const t = e.target, S = this.S(), sec = this.cur();
    if (t.matches('[data-psx-on]')) { S.on = t.checked; this.changed(); this.render(); return; }
    if (t.matches('[data-psx-name]')) { sec.name = t.value.trim().slice(0, 60) || 'Section'; this.changed(); this.render(); return; }
    if (t.matches('[data-psx-f]')) { this.setPath(sec, t.dataset.psxF, t.value); this.changed(); this.render(); return; }
    if (t.matches('[data-psx-def]')) { S.def = t.value; this.changed(); this.render(); return; }
    if (t.matches('[data-psx-line]')) { const l = S.lines.find(x => x.id === t.dataset.psxLine); if (l) { l.sec = t.value; this.changed(); this.render(); } }
  },
  _click(e) {
    const b = e.target.closest('[data-psx]'); if (!b) return;
    const S = this.S(), sec = this.cur(), act = b.dataset.psx;
    if (act === 'close') { this.close(); return; }
    if (act === 'tab') { this.sel = b.dataset.id; this.render(); return; }
    if (act === 'new') { const id = PlanSections.nextId(S.list); S.list.push(PlanSections.make(id, 'Section ' + (S.list.length + 1))); this.sel = id; this.changed(); this.render(); return; }
    if (act === 'dup') { const id = PlanSections.nextId(S.list), c = PlanSections.normalize(JSON.parse(JSON.stringify(sec)), id); c.id = id; c.name = (sec.name + ' copy').slice(0, 60); S.list.push(c); this.sel = id; this.changed(); this.render(); return; }
    if (act === 'del') {
      if (S.list.length < 2) return;
      const used = S.lines.filter(l => l.sec === sec.id).length;
      if (used && !window.confirm(`"${sec.name}" is used by ${used} section line${used === 1 ? '' : 's'}. Delete both?`)) return;
      S.list = S.list.filter(x => x.id !== sec.id); S.lines = S.lines.filter(l => l.sec !== sec.id); if (S.def === sec.id) S.def = S.list[0].id; this.sel = S.def;
      PlanLayoutUI.cfg().sections = S; this.changed(); this.render(); return;
    }
    if (act === 'def') { S.def = sec.id; this.changed(); this.render(); return; }
    if (act === 'draw') { const id = sec.id; this.close(); PlanLayoutUI.secDrawOn(true, id); return; }
    if (act === 'linedel') { S.lines = S.lines.filter(l => l.id !== b.dataset.id); this.changed(); this.render(); return; }
    if (act === 'lineshow') { const l = S.lines.find(x => x.id === b.dataset.id); if (l) { this.close(); PlanLayoutUI.secShow(l); } }
  },

  // ───────── dragging an item on the drawing ─────────
  _items: { svc: 'Service', lv: 'LV', fi: 'Fibre', mv: 'MV', kiosk: 'Kiosk', pole: 'Street light', mh: 'Manhole' },
  _down(e) {
    const g = e.target.closest('[data-drag]'); if (!g || e.button > 0) return;
    const svg = this._m.querySelector('#psx-draw'), sec = this.cur(), key = g.dataset.drag;
    e.preventDefault(); svg.setPointerCapture(e.pointerId); g.focus && g.focus({ preventScroll: true });
    const x0 = e.clientX, o0 = sec.items[key].off, geo = this.geom(sec);
    this._drag = { key, label: this._items[key], fine: false };
    const move = ev => {
      const fine = ev.altKey, dx = (ev.clientX - x0) / geo.K * (fine ? 0.1 : 1);
      this._drag.fine = fine; sec.items[key].off = PlanSections.snap(Math.max(0, Math.min(PlanSections.SHAPE[key].off[2], o0 + dx)));
      this._m.querySelector('#psx-draw').innerHTML = this.svgParts(sec).inner;                // the svg itself stays, so the pointer stays captured
      const fld = this._m.querySelector(`[data-psx-f="items.${key}.off"]`); if (fld) fld.value = this.f2(sec.items[key].off);
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); this._drag = null; this.changed(); this.render(); };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  },
  _key(e) {
    const g = e.target.closest && e.target.closest('[data-drag]'); if (!g || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const sec = this.cur(), key = g.dataset.drag, step = e.shiftKey ? 0.1 : 0.01;
    sec.items[key].off = PlanSections.snap(Math.max(0, Math.min(PlanSections.SHAPE[key].off[2], sec.items[key].off + (e.key === 'ArrowRight' ? step : -step))));
    this.changed(); this.render();
    const again = this._m.querySelector(`[data-drag="${key}"]`); if (again) again.focus({ preventScroll: true });
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = PlanSectionsUI;
