// PlanSides — the sides of each street in the Auto layout, set on the plan itself.
// Three layers per street, each a side (±1 = the engine's side sign: +1 is offset (dy, −dx) from the street's drawn direction):
//   k  kiosks and the LV / service runs        f  fibre manholes and ducts        c  civil services (water, sewer, stormwater)
// Stored in planMarkup.settings.layout.sides[streetId] = { k, f, c } ('*' = the kiosk / fibre side for every street with none of its own).
// A kiosk or fibre side left on Auto goes to the side away from the street's civil services; with none, the layout picks (as before).
// The engine gets them in `gather` (`inputs`): ks / fs / ksOwn / fsOwn as before, plus `civ` (the civil side per street) and the
// strictness `params.civMode` ('avoid' | 'keep'): see plan-layout.js `civMark`, `sideStrips`.
// On the plan (Auto layout, Streets and Review steps): the Street sides mode of the floating bar — pick a layer (1 2 3), click a verge to
// put that layer on that side of the whole street, click it again or Alt-click for Auto, click a chip (K F C) to flip that layer, X flips
// the street under the pointer, Esc leaves. The panel lists every street with the same three choices named by compass direction.
// "Civil side from drawing…" reads the pipe layers of a DXF: each street takes the side most of its pipe length runs along.
const PlanSides = {
  brush: 'k', hover: null, chips: [], onlySet: false, civDraw: null,
  LAY: {
    k: { label: 'Kiosks & LV', short: 'K', color: '#1d4ed8', soft: 'rgba(29,78,216,0.28)' },
    f: { label: 'Fibre', short: 'F', color: '#7e22ce', soft: 'rgba(126,34,206,0.28)' },
    c: { label: 'Civil services', short: 'C', color: '#92400e', soft: 'rgba(146,64,14,0.30)' },
  },
  UI() { return PlanLayoutUI; },
  L() { return PlanLayoutUI.cfg(); },
  streets() { return PlanLayoutUI.streetsOnPlan(); },
  _pk(v) { return v === 1 || v === -1 ? v : null; },
  _w(s) { return PlanLayoutUI._num(PlanLayoutUI._resOf(s), 6, 40, 12); },               // reserve width, m
  name(s, i) { return (s.props && s.props.name) || ('Street ' + ((i != null ? i : this.streets().indexOf(s)) + 1)); },

  // ── what the engine gets (PlanLayoutUI.gather) ──
  inputs(streets) {
    const L = this.L(), ga = L.sides['*'] || {}, pk = v => this._pk(v);
    const ks = {}, fs = {}, ksOwn = {}, fsOwn = {}, civ = {};
    streets.forEach(s => {
      const sd = L.sides[s.id] || {}, c = pk(sd.c);
      if (c) civ[s.id] = c;
      ks[s.id] = pk(sd.k) || (c ? -c : pk(ga.k)) || 0;                                    // own side > away from the civil services > All streets > the layout's choice
      fs[s.id] = pk(sd.f) || (c ? -c : pk(ga.f));
      if (pk(sd.k)) ksOwn[s.id] = true; if (pk(sd.f) || pk(sd.k)) fsOwn[s.id] = true;
    });
    return { ks, fs, ksOwn, fsOwn, civ };
  },
  // the side each layer is on now: { v, auto } (v null = not known yet: the layout has not run; for c, null = none set)
  resolved(id, key) {
    const L = this.L(), sd = L.sides[id] || {}, ga = L.sides['*'] || {}, c = this._pk(sd.c), r = PlanLayoutUI.result;
    if (key === 'c') return { v: c, auto: false };
    const own = this._pk(sd[key]); if (own) return { v: own, auto: false };
    if (c) return { v: -c, auto: true };
    const g = this._pk(ga[key]); if (g) return { v: g, auto: true };
    const kr = r && r.ks ? this._pk(r.ks[id]) : null;
    if (key === 'k') return { v: kr, auto: true };
    const kk = this._pk(sd.k) || kr; if (!kk) return { v: null, auto: true };
    return { v: (PlanLayoutUI.cfg().params || {}).fibre === 'opp' ? -kk : kk, auto: true };
  },
  clash(id) { const sd = this.L().sides[id] || {}, c = this._pk(sd.c); if (!c) return []; return ['k', 'f'].filter(k => this._pk(sd[k]) === c); },

  // ── geometry (plan px) ──
  _dir(s) { const p = PlanLayoutUI._flat(s), a = p[0], b = p[p.length - 1]; return { x: b.x - a.x, y: b.y - a.y }; },
  // the compass word of side v of a street (screen up = north), from the street's overall direction
  word(s, v) {
    const d = this._dir(s), o = { x: v * d.y, y: -v * d.x };
    return Math.abs(o.x) > Math.abs(o.y) ? (o.x > 0 ? 'east' : 'west') : (o.y < 0 ? 'north' : 'south');
  },
  // the nearest street under a point (within its reserve + `extraM`), the side of it, the station; never past a street's ends
  hit(pt, extraM) {
    const f = PlanEngine.factor(); if (!f) return null;
    let best = null;
    for (const s of this.streets()) {
      const P = PlanLayoutUI._flat(s), lim = (this._w(s) / 2 + (extraM == null ? 4 : extraM)) / f;
      let acc = 0;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9, t0 = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2;
        const t = Math.max(0, Math.min(1, t0)), px = a.x + dx * t, py = a.y + dy * t, d = Math.hypot(pt.x - px, pt.y - py), seg = Math.sqrt(L2);
        if (d <= lim && (!best || d < best.d) && !((i === 1 && t0 < 0) || (i === P.length - 1 && t0 > 1))) best = { s, d, v: ((pt.x - px) * dy - (pt.y - py) * dx) >= 0 ? 1 : -1, st: acc + t * seg };
        acc += seg;
      }
    }
    return best;
  },
  // a street's line offset to one side (plan px), each vertex moved along the mean of its two segment normals
  _offset(P, off) {
    return P.map((p, i) => {
      let nx = 0, ny = 0;
      for (const [a, b] of [[P[i - 1], p], [p, P[i + 1]]]) { if (!a || !b) continue; const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; nx += dy / l; ny += -dx / l; }
      const l = Math.hypot(nx, ny) || 1; return { x: p.x + nx / l * off, y: p.y + ny / l * off };
    });
  },
  _at(P, st) { let acc = 0; for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i], l = Math.hypot(b.x - a.x, b.y - a.y); if (acc + l >= st || i === P.length - 1) { const t = l ? Math.max(0, Math.min(1, (st - acc) / l)) : 0, dx = (b.x - a.x) / (l || 1), dy = (b.y - a.y) / (l || 1); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: dy, ny: -dx }; } acc += l; } return { x: P[0].x, y: P[0].y, nx: 0, ny: 0 }; },

  // ── changes ──
  set(id, key, v) {
    const L = this.L(), o = L.sides[id] = L.sides[id] || {};
    if (v == null) delete o[key]; else o[key] = v;
    if (!Object.keys(o).length) delete L.sides[id];
    PlanLayoutUI.touched();
    PlanMarkup.refreshProps(); PlanLayoutUI._syncBar(); PlanEngine.requestDraw({ fg: true });
  },
  allAuto() {
    const L = this.L(); let n = 0;
    for (const id of Object.keys(L.sides)) { const o = L.sides[id]; if (o.k != null || o.f != null) n++; delete o.k; delete o.f; if (!Object.keys(o).length) delete L.sides[id]; }
    PlanLayoutUI.touched(); PlanMarkup.refreshProps(); PlanLayoutUI._syncBar(); PlanEngine.requestDraw({ fg: true });
    UI.toast(n ? `Kiosk and fibre sides back to Auto on ${n === 1 ? 'one street' : n + ' streets'}. Civil sides are kept.` : 'Every kiosk and fibre side is already on Auto.', 'info', 4000);
  },
  flipStreet(s) {
    const sd = this.L().sides[s.id] || {}; let n = 0;
    for (const key of ['k', 'f', 'c']) { const v = this._pk(sd[key]); if (v) { this.L().sides[s.id] = Object.assign(this.L().sides[s.id] || {}, { [key]: -v }); n++; } }
    if (!n) for (const key of ['k', 'f']) { const r = this.resolved(s.id, key); if (r.v) { this.L().sides[s.id] = Object.assign(this.L().sides[s.id] || {}, { [key]: -r.v }); n++; } }
    if (!n) { UI.toast('Nothing to flip yet: run the layout, or set a side first.', 'info', 3500); return; }
    PlanLayoutUI.touched(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`Flipped ${this.name(s)}.`, 'info', 2500);
  },

  // ── the plan: clicks, pointer, keys ──
  click(pt, ev) {
    const z = PlanEngine.view.zoom, chip = this.chips.find(c => Math.abs(pt.x - c.x) <= c.w / 2 / z && Math.abs(pt.y - c.y) <= c.h / 2 / z);
    if (chip) {                                                                    // a chip: that layer to the other side
      const s = this.streets().find(q => q.id === chip.id); if (!s) return;
      this.set(chip.id, chip.key, ev && ev.altKey ? null : -chip.v);
      UI.toast(ev && ev.altKey ? `${this.LAY[chip.key].label}: Auto on ${this.name(s)}.` : `${this.LAY[chip.key].label}: ${this.word(s, -chip.v)} side of ${this.name(s)}.`, 'info', 2500);
      return;
    }
    const h = this.hit(pt);
    if (!h) { UI.toast('Click beside a road, on the side you want (the verge).', 'info', 3000); return; }
    const key = this.brush, cur = this._pk((this.L().sides[h.s.id] || {})[key]);
    const off = (ev && ev.altKey) || cur === h.v;
    this.set(h.s.id, key, off ? null : h.v);
    const what = this.LAY[key].label;
    UI.toast(off ? (key === 'c' ? `No civil side on ${this.name(h.s)}.` : `${what}: Auto on ${this.name(h.s)}.`) : `${what}: ${this.word(h.s, h.v)} side of ${this.name(h.s)}.`, 'info', 2500);
  },
  move(pt) {
    const h = this.hit(pt), k = h ? h.s.id + ':' + h.v : '';
    if (k !== (this.hover ? this.hover.s.id + ':' + this.hover.v : '')) { this.hover = h; PlanEngine.requestDraw({ fg: true }); }
  },
  key(e) {
    if (e.ctrlKey || e.metaKey) return false;
    const m = { '1': 'k', '2': 'f', '3': 'c' }[e.key];
    if (m) { this.brush = m; PlanLayoutUI._syncBar(); PlanLayoutUI.syncHint(); PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'x' || e.key === 'X') { if (this.hover) this.flipStreet(this.hover.s); else UI.toast('Point at a road, then press X.', 'info', 2500); return true; }
    if (e.key === 'Escape') { this.leave(); return true; }
    return false;
  },
  enter() { const U = PlanLayoutUI; U.mode = 'sides'; U.markFor = null; U.addKind = null; PlanMarkup.refreshProps(); U._syncBar(); U.syncHint(); PlanEngine.requestDraw({ fg: true }); },
  leave() { const U = PlanLayoutUI; this.hover = null; U.mode = 'front'; PlanMarkup.refreshProps(); U._syncBar(); U.syncHint(); PlanEngine.requestDraw({ fg: true }); },
  hint() { return `Street sides · ${this.LAY[this.brush].label}: click the verge of a road to put it on that side · click it again or Alt-click: Auto · click a chip (K F C): flip it · 1 2 3 picks the layer · X flips the road under the pointer · Esc: done`; },
  barHtml() {
    const btn = (k) => { const on = this.brush === k, L = this.LAY[k]; return `<button type="button" data-bm="ps-brush" data-k="${k}" aria-pressed="${on}" style="min-height:36px;padding:0 10px;border:1px solid ${on ? L.color : 'transparent'};border-radius:7px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:${on ? L.soft : 'transparent'};color:#0f172a;font-weight:${on ? 600 : 500}"><span aria-hidden="true" style="width:11px;height:11px;border-radius:3px;background:${L.color};display:inline-block"></span>${L.label} <span style="font-size:11px;color:#475569;border:1px solid #cbd5e1;border-radius:4px;padding:0 4px">${k === 'k' ? 1 : k === 'f' ? 2 : 3}</span></button>`; };
    const plain = (bm, t) => `<button type="button" data-bm="${bm}" style="min-height:36px;padding:0 10px;border:0;border-radius:7px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:#334155;font-weight:500">${t}</button>`;
    return `<div style="pointer-events:auto;display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 4px 14px rgba(15,23,42,.18)">${btn('k')}${btn('f')}${btn('c')}<span style="width:1px;height:24px;background:#cbd5e1;margin:0 4px"></span>${plain('ps-auto', 'All to Auto')}${plain('ps-done', 'Done')}</div>`;
  },
  barClick(b) {
    const bm = b.dataset.bm; if (!bm || !bm.startsWith('ps-')) return false;
    if (bm === 'ps-brush') { this.brush = b.dataset.k; PlanLayoutUI._syncBar(); PlanLayoutUI.syncHint(); PlanEngine.requestDraw({ fg: true }); }
    else if (bm === 'ps-auto') this.allAuto();
    else if (bm === 'ps-done') this.leave();
    else if (bm === 'ps-on') { if (PlanLayoutUI.mode === 'sides') this.leave(); else this.enter(); }
    return true;
  },

  // ── drawing (plan px; the tool's overlay) ──
  draw(ctx, zoom) {
    const f = PlanEngine.factor(); if (!f || !PlanLayoutUI._active) return;
    const u = 1 / zoom, on = PlanLayoutUI.mode === 'sides', L = this.L();
    this.chips = [];
    ctx.save(); ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    for (const s of this.streets()) {
      const P = PlanLayoutUI._flat(s); if (P.length < 2) continue;
      const half = this._w(s) / 2 / f, line = (pts) => { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke(); };
      const c = this._pk((L.sides[s.id] || {}).c);
      if (c) {                                                                     // the civil side: a brown hatched band along that verge
        ctx.strokeStyle = 'rgba(146,64,14,0.55)'; ctx.lineWidth = Math.max(1.4 / f, 5 * u); ctx.setLineDash([2.5 * u, 2.5 * u]);
        line(this._offset(P, c * Math.max(half - 1 / f, half * 0.7))); ctx.setLineDash([]);
      }
      if (!on) continue;
      if (this.hover && this.hover.s.id === s.id) {                               // the verge a click would set
        ctx.strokeStyle = this.LAY[this.brush].soft; ctx.lineWidth = Math.max(2.5 / f, 10 * u); line(this._offset(P, this.hover.v * Math.max(half - 1.2 / f, half * 0.65)));
        ctx.strokeStyle = this.LAY[this.brush].color; ctx.lineWidth = 1.5 * u; line(this._offset(P, this.hover.v * half));
      }
      // chips: one per layer on the side it is on, near the start of the street (and the middle of a long one)
      let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      const at = [Math.min(len * 0.15, 25 / f)]; if (len * f > 160) at.push(len / 2);
      for (const st of at) {
        const q = this._at(P, st), cnt = { 1: 0, '-1': 0 };
        for (const key of ['k', 'f', 'c']) {
          const r = this.resolved(s.id, key); if (!r.v) continue;
          const i = cnt[r.v]++, off = r.v * (half + 4 / f), along = (i - 0.5) * 22 * u;
          const dx = q.ny * -1, dy = q.nx;                                         // along the street
          const x = q.x + q.nx * off - dx * along, y = q.y + q.ny * off - dy * along, w = 20, h = 16;
          const clash = key !== 'c' && this.clash(s.id).includes(key);
          ctx.globalAlpha = r.auto ? 0.6 : 1;
          ctx.fillStyle = this.LAY[key].color; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - w / 2 * u, y - h / 2 * u, w * u, h * u, 5 * u); else ctx.rect(x - w / 2 * u, y - h / 2 * u, w * u, h * u); ctx.fill();
          if (r.auto) { ctx.setLineDash([2 * u, 2 * u]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * u; ctx.stroke(); ctx.setLineDash([]); }
          if (clash) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2.5 * u; ctx.stroke(); }
          ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.font = `700 ${10 * u}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(this.LAY[key].short, x, y + 0.5 * u);
          this.chips.push({ id: s.id, key, v: r.v, x, y, w, h });
        }
      }
    }
    ctx.restore();
  },

  // ── Checks (PlanLayoutUI.checks) ──
  checks(r) {
    const out = [], L = this.L(), sts = this.streets(), keep = (L.params || {}).civMode === 'keep';
    for (const s of sts) {
      const cl = this.clash(s.id); if (!cl.length) continue;
      const c = this._pk(L.sides[s.id].c), other = this.word(s, -c);
      out.push({ sev: 'warn', text: `${cl.map(k => this.LAY[k].label).join(' and ')} set on the civil side of ${this.name(s)}. The layout keeps your choice, but those runs share the verge with the water and sewer.`, ids: [],
        acts: [{ label: `Move to the ${other} side`, act: 'ps-move', val: { id: s.id, keys: cl, v: -c } }] });
    }
    const runs = (r && r.civRuns) || [];
    if (runs.length) {
      const by = {}; runs.forEach(x => { by[x.kind] = (by[x.kind] || 0) + 1; });
      const nm = { service: 'service', duct: 'erf fibre duct', lv: 'LV run', trunk: 'fibre trunk run' }, m = Math.round(runs.reduce((t, x) => t + x.len, 0));
      out.push({ sev: keep ? 'fail' : 'warn', text: `${runs.length} run${runs.length === 1 ? '' : 's'} along the civil side of a road (${Object.entries(by).map(([k, n]) => n + ' ' + nm[k] + (n === 1 ? '' : 's')).join(', ')}; ${m} m). ${keep ? 'Keep off allows the civil side only to reach an erf there: move a kiosk or manhole, or set the street\'s side by hand.' : 'There was no better way on the other side (no corridor, or the length limit). Show marks them.'}`,
        ids: [], runs: runs.map(x => ({ kind: x.kind, bad: [x.pts] })) });
    }
    return out;
  },
  checkAct(a) {
    if (a.act !== 'ps-move') return false;
    const o = this.L().sides[a.val.id] = this.L().sides[a.val.id] || {}; a.val.keys.forEach(k => { o[k] = a.val.v; });
    PlanLayoutUI.touched(true); return true;
  },

  // ── the panel: a list of streets, the same three choices named by compass direction ──
  panelHtml(esc) {
    const L = this.L(), sts = this.streets(), P = L.params || {}, keep = P.civMode === 'keep', on = PlanLayoutUI.mode === 'sides';
    const nSet = sts.filter(s => { const o = L.sides[s.id]; return o && (o.k != null || o.f != null || o.c != null); }).length;
    const seg = (s, key) => {
      const cur = this._pk((L.sides[s.id] || {})[key]), r = this.resolved(s.id, key), col = this.LAY[key].color;
      const b = (v, t, title) => { const pressed = v === 0 ? cur == null : cur === v; return `<button type="button" class="plan-btn" data-ps-set="${esc(s.id)}" data-k="${key}" data-v="${v}" aria-pressed="${pressed}" title="${esc(title)}" style="padding:2px 6px;font-size:12px;min-width:44px${pressed ? `;font-weight:600;outline:2px solid ${col}` : ''}">${t}</button>`; };
      const autoT = key === 'c' ? 'None' : 'Auto' + (cur == null && r.v ? ` · ${this.word(s, r.v).slice(0, 1).toUpperCase()}` : '');
      return `<span style="display:inline-flex;gap:2px">${b(1, this.word(s, 1), `${this.LAY[key].label} on the ${this.word(s, 1)} side`)}${b(0, autoT, key === 'c' ? 'No civil side set' : 'The layout picks (away from the civil side when one is set)')}${b(-1, this.word(s, -1), `${this.LAY[key].label} on the ${this.word(s, -1)} side`)}</span>`;
    };
    const row = (s, i) => {
      const o = L.sides[s.id]; if (this.onlySet && !(o && (o.k != null || o.f != null || o.c != null))) return '';
      const cl = this.clash(s.id);
      return `<div style="border-bottom:1px solid var(--border,#ddd);padding:5px 0;display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><button type="button" class="plan-btn" data-ps-zoom="${esc(s.id)}" style="padding:1px 6px;font-weight:600" title="Zoom to it on the plan">${esc(this.name(s, i))}</button>${cl.length ? `<span style="color:#b91c1c;font-size:12px;font-weight:600" title="Set on the civil side">! on the civil side</span>` : ''}</div>
        ${['k', 'f', 'c'].map(k => `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px"><span style="color:${this.LAY[k].color};font-weight:600">${this.LAY[k].label}</span>${seg(s, k)}</div>`).join('')}</div>`;
    };
    const GA = L.sides['*'] || {}, gseg = key => [[0, 'Auto'], [1, 'Left'], [-1, 'Right']].map(([v, t]) => { const pressed = v === 0 ? GA[key] == null : GA[key] === v; return `<button type="button" class="plan-btn" data-ps-set="*" data-k="${key}" data-v="${v}" aria-pressed="${pressed}" style="padding:2px 6px;font-size:12px${pressed ? ';font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`; }).join('');
    const lyr = PlanLayoutUI.dxfLayers();
    return `<details${this._open ? ' open' : ''} data-ps-details><summary style="cursor:pointer;font-weight:600">Road sides <span style="font-weight:400;font-size:12px;color:var(--text-muted)">kiosks, fibre, civil services · ${nSet} of ${sts.length} set</span></summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="plan-btn" data-ps-act="plan" aria-pressed="${on}" style="font-weight:600${on ? ';outline:2px solid var(--accent,#2563eb)' : ''}">${on ? 'Setting on the plan · Done' : 'Set on the plan'}</button><button type="button" class="plan-btn" data-ps-act="auto">All to Auto</button>${lyr.length ? '<button type="button" class="plan-btn" data-ps-act="civdraw">Civil side from drawing…</button>' : ''}</div>
        <div style="font-size:12px;color:var(--text-muted)">Click beside a road on the plan to set a side; or use the list. Auto keeps kiosks, LV and fibre away from the civil services.</div>
        ${this.civDraw ? this.civDrawHtml(esc) : ''}
        <div role="radiogroup" aria-label="On the civil side" style="display:flex;flex-direction:column;gap:3px;font-size:12px;border:1px solid var(--border,#ddd);border-radius:6px;padding:5px 7px"><b>On the civil side</b>
          <label style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="ps-civmode" data-ps-mode="avoid"${keep ? '' : ' checked'}> <span><b>Avoid</b>: used only where the other side has no room or no corridor (listed in Checks)</span></label>
          <label style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="ps-civmode" data-ps-mode="keep"${keep ? ' checked' : ''}> <span><b>Keep off</b>: only to cross into an erf there; every other run is a Fix</span></label></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px" title="The side for every road that has none of its own and no civil side"><span><b>All roads</b> kiosks</span><span style="display:inline-flex;gap:2px">${gseg('k')}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px"><span><b>All roads</b> fibre</span><span style="display:inline-flex;gap:2px">${gseg('f')}</span></div>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" data-ps-only${this.onlySet ? ' checked' : ''}> Only roads with a side set</label>
        <div style="max-height:360px;overflow:auto">${sts.map(row).join('') || '<div style="font-size:12px;color:var(--text-muted)">No roads yet.</div>'}</div>
      </div></details>`;
  },
  // delegated from the panel's click / change handlers; true when handled
  panelClick(t) {
    const b = t.closest('[data-ps-set],[data-ps-zoom],[data-ps-act],[data-ps-use]'); if (!b) return false;
    if (b.dataset.psSet) { const v = +b.dataset.v; this.set(b.dataset.psSet, b.dataset.k, v === 0 ? null : v); return true; }
    if (b.dataset.psZoom) { const s = this.streets().find(q => q.id === b.dataset.psZoom); if (s) { PlanEngine.zoomToPoints(PlanLayoutUI._flat(s)); this.hover = { s, v: 1, d: 0 }; PlanEngine.requestDraw({ fg: true }); setTimeout(() => { if (this.hover && this.hover.s === s && PlanLayoutUI.mode !== 'sides') { this.hover = null; PlanEngine.requestDraw({ fg: true }); } }, 1500); } return true; }
    if (b.dataset.psAct === 'plan') { if (PlanLayoutUI.mode === 'sides') this.leave(); else this.enter(); return true; }
    if (b.dataset.psAct === 'auto') { this.allAuto(); return true; }
    if (b.dataset.psAct === 'civdraw') { this.civStart(); return true; }
    if (b.dataset.psAct === 'civfind') { this.civFind(); return true; }
    if (b.dataset.psAct === 'civuse') { this.civUse(); return true; }
    if (b.dataset.psAct === 'civcancel') { this.civDraw = null; PlanMarkup.refreshProps(); return true; }
    return false;
  },
  panelChange(t) {
    if (t.dataset.psMode) { const P = this.L().params = this.L().params || {}; P.civMode = t.dataset.psMode; PlanLayoutUI.touched(); PlanMarkup.refreshProps(); return true; }
    if (t.dataset.psOnly != null) { this.onlySet = t.checked; PlanMarkup.refreshProps(); return true; }
    if (t.dataset.psLayer != null) { const C = this.civDraw; if (C) { if (t.checked) C.layers.add(t.dataset.psLayer); else C.layers.delete(t.dataset.psLayer); C.res = null; PlanMarkup.refreshProps(); } return true; }
    if (t.dataset.psUse != null) { const C = this.civDraw; if (C && C.res) { const x = C.res.find(q => q.id === t.dataset.psUse); if (x) x.use = t.checked; PlanMarkup.refreshProps(); } return true; }
    return false;
  },

  // ── Civil side from drawing: the pipe layers of a DXF ──
  PIPE_RE: /water|sewer|sewage|storm|swr|wat\b|civil|pipe|drain|sanit|bulk/i,
  civStart() {
    const lyr = PlanLayoutUI.dxfLayers(); if (!lyr.length) { UI.toast('Import the civil drawing as a DXF first.', 'info', 4000); return; }
    this.civDraw = { layers: new Set(lyr.filter(x => this.PIPE_RE.test(x.layer)).map(x => x.layer)), res: null };
    this._open = true; PlanMarkup.refreshProps();
  },
  civDrawHtml(esc) {
    const C = this.civDraw, lyr = PlanLayoutUI.dxfLayers(), seen = new Set();
    const list = lyr.filter(x => { if (seen.has(x.layer)) return false; seen.add(x.layer); return true; }).sort((a, b) => (this.PIPE_RE.test(b.layer) - this.PIPE_RE.test(a.layer)) || a.layer.localeCompare(b.layer));
    const res = C.res ? `<div style="display:flex;flex-direction:column;gap:2px;font-size:12px;max-height:200px;overflow:auto">${C.res.length ? C.res.map(x => `<label style="display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--border,#ddd);padding:2px 0"><input type="checkbox" data-ps-use="${esc(x.id)}"${x.use ? ' checked' : ''}${x.side ? '' : ' disabled'}> <span style="flex:1">${esc(x.name)}</span><span style="${x.side ? '' : 'color:#b45309;font-weight:600'}">${x.side ? x.word + ' · ' + Math.round(x.share * 100) + ' %' : x.little ? 'only ' + Math.round(x.m) + ' m of pipe' : 'both · ' + Math.round(x.share * 100) + ' / ' + Math.round((1 - x.share) * 100) + ' %'}</span></label>`).join('') : '<div style="color:var(--text-muted)">No pipe on those layers runs along a road.</div>'}</div>
        <div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-ps-act="civuse" style="font-weight:600"${C.res.some(x => x.use) ? '' : ' disabled'}>Use ${C.res.filter(x => x.use).length}</button><button type="button" class="plan-btn" data-ps-act="civcancel">Cancel</button></div>` : `<div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-ps-act="civfind" style="font-weight:600"${C.layers.size ? '' : ' disabled'}>Find the sides</button><button type="button" class="plan-btn" data-ps-act="civcancel">Cancel</button></div>`;
    return `<div style="border:2px solid #92400e;border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px"><b>Civil side from drawing</b>
      <div style="font-size:12px;color:var(--text-muted)">Tick the layers the water, sewer and stormwater are drawn on. Each road takes the side most of its pipe length runs along; one with pipes on both sides is left for you.</div>
      <div style="max-height:130px;overflow:auto;font-size:12px">${list.map(x => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-ps-layer="${esc(x.layer)}"${C.layers.has(x.layer) ? ' checked' : ''}> ${esc(x.layer)} <span style="color:var(--text-muted)">(${x.n})</span>${this.PIPE_RE.test(x.layer) ? ' ★' : ''}</label>`).join('')}</div>${res}</div>`;
  },
  // every line / polyline of the chosen layers, sampled every ~2 m: the length on each side of the street it runs beside (within the
  // reserve + 8 m, not past a street's ends); a street takes the side with ≥ 65 % of it
  civFind() {
    const C = this.civDraw, f = PlanEngine.factor(); if (!C || !f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return; }
    const tally = new Map(), step = 2 / f;
    for (const d of PlanDxfImport.list()) {
      const data = d.hidden ? null : PlanDxfImport.dataOf(d); if (!data) continue;
      const keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
      for (const r of (data.entities || [])) {
        if (!C.layers.has(r.l) || (keep && !keep(r)) || !(r.t === 'l' || (r.t === 'p' && r.g !== 'HATCH'))) continue;
        const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push(PlanDxfImport.worldOf(d, r.p[i], r.p[i + 1]));
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.round(l / step));
          for (let j = 0; j < n; j++) { const t = (j + 0.5) / n, h = this.hit({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, 8); if (!h) continue; const o = tally.get(h.s.id) || { 1: 0, '-1': 0 }; o[h.v] += l / n * f; tally.set(h.s.id, o); }
        }
      }
    }
    // a street needs pipe along at least a quarter of its length (and 15 m): a pipe that only crosses it, or runs on past a junction, is not its side
    C.res = this.streets().filter(s => tally.has(s.id)).map(s => { const o = tally.get(s.id), tot = o[1] + o[-1], v = o[1] >= o[-1] ? 1 : -1, share = Math.max(o[1], o[-1]) / (tot || 1);
      const P = PlanLayoutUI._flat(s); let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      const little = tot < Math.max(15, 0.25 * len * f), ok = share >= 0.65 && !little;
      return { id: s.id, name: this.name(s), side: ok ? v : null, word: this.word(s, v), share, use: ok, m: tot, little }; })
      .filter(x => !x.little || x.m >= 5);
    PlanMarkup.refreshProps();
  },
  civUse() {
    const C = this.civDraw; if (!C || !C.res) return;
    const use = C.res.filter(x => x.use && x.side); use.forEach(x => { const o = this.L().sides[x.id] = this.L().sides[x.id] || {}; o.c = x.side; });
    this.civDraw = null; PlanLayoutUI.touched(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`Civil side set on ${use.length} street${use.length === 1 ? '' : 's'} from the drawing.`, 'success', 4000);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlanSides;
