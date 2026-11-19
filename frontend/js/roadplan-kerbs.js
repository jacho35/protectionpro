/**
 * RoadKerbs — Road plan › Roads from kerbs: pick the kerb lines of the DXF background by clicking; the roads between them are made.
 *
 * The pairing is PlanKerbs (plan-kerbs.js, shared with Auto layout's Pick kerbs). Here it runs on the background drawing
 * (`RoadPlan.rp.bg`, already in metres), is reviewed on the road plan, and each street becomes a road in `kerbs` mode: the two
 * kerb lines are read back from the drawn kerbs (`PlanKerbs.sides`), so the carriageway width follows the kerbs exactly as for two
 * hand-picked kerbs and the lighting calculation sees the real width.
 *
 * Nothing is chosen at first. Click = a whole joined kerb line and every road it touches; Shift-click = one drawn piece; Alt-click
 * (or the Subtract button) takes roads out; Ctrl-click a lone kerb, then the road's side; Backspace takes the last pick back;
 * Enter creates; Esc leaves. Amber = a road, orange = cut off from the main network, red dashed = a kerb with no partner.
 * Session-only until Create.
 */
const RoadKerbs = {
  on: false,                 // the Roads-from-kerbs panel is open
  layer: '',                 // the layer Pair all works on
  stage: null,               // PlanKerbs.stage while the panel is open
  opt: { wmin: 4, wmax: 20, gap: 15, oneW: 6, join: 40 },
  _share: new Map(),

  // ── the drawing's layers ──
  _ents(layer) { const bg = RoadPlan.rp.bg; return bg ? bg.ents.filter(e => e.l === layer && e.p.length >= 4) : []; },
  chainsOf(layer) {
    const pieces = this._ents(layer).map(e => { const pts = []; for (let i = 0; i + 1 < e.p.length; i += 2) pts.push([e.p[i], e.p[i + 1]]); if (e.c && pts.length > 2) pts.push(pts[0].slice()); return pts; });
    return PlanKerbs.joinPieces(pieces);
  },
  layers() {
    const bg = RoadPlan.rp.bg; if (!bg) return [];
    const n = new Map(); for (const e of bg.ents) n.set(e.l, (n.get(e.l) || 0) + 1);
    return [...n].map(([layer, c]) => ({ layer, n: c, kerbs: /kerb|curb/i.test(layer) || this.kerbLike(layer, c) }))
      .sort((a, b) => (b.kerbs - a.kerbs) || (b.n - a.n));
  },
  kerbLike(layer, count) {                                       // lines in close parallel pairs: kerbs, not centrelines
    if (count < 2 || count > 4000) return false;
    const key = [RoadPlan.rp.bg.name, layer, count].join('|');
    if (!this._share.has(key)) this._share.set(key, PlanKerbs.pairedShare(this.chainsOf(layer)) >= 0.5);
    return this._share.get(key);
  },
  _pool() {                                                      // every layer of the drawing as kerb chains
    const layers = {}; for (const { layer } of this.layers()) { const c = this.chainsOf(layer); if (c.length) layers[layer] = c; }
    return layers;
  },

  // ── open / close ──
  open() {
    this.on = true;
    const L = this.layers(); if (!this.layer || !L.some(x => x.layer === this.layer)) this.layer = (L[0] || {}).layer || '';
    const pool = this._pool();
    this.stage = Object.assign(PlanKerbs.stage(pool, this.opt), { hover: null });
    this._names();
    RoadPlan.setTool('kerbauto'); RoadPlan.renderPanel();
    UI.toast('Click a kerb line to add it and the roads it touches. Shift-click takes one piece, Alt-click takes roads out, Backspace undoes the last pick, Enter creates.', 'info', 7000);
  },
  close() { this.on = false; this.stage = null; },
  _refresh() { RoadPlan.renderPanel(); RoadPlan.renderScreen(); RoadPlan._hint(); },

  // the nearest road-name text of the drawing (kept in `bg.texts` when the drawing was loaded), each used once
  _names() {
    const bg = RoadPlan.rp.bg, texts = (bg && bg.texts) || [], used = new Set();
    const dist = (t, pl) => { let b = Infinity; for (let i = 0; i + 1 < pl.length; i++) b = Math.min(b, PlanKerbsSeg(t, pl[i], pl[i + 1])); return b; };
    this._nameOf = (st, consume) => {
      let best = null, bd = 25;
      for (const t of texts) { if (consume && used.has(t)) continue; const d = dist([t.x, t.y], st.pts); if (d < bd) { bd = d; best = t; } }
      if (best && consume) used.add(best);
      return best ? best.s : null;
    };
  },
  hint() {
    const S = this.stage;
    if (S && S.one) return 'Click on the road\'s side of that kerb · Esc leaves.';
    if (S && S.pairFrom) return 'Click the kerb on the other side of that road.';
    if (S && S.mode === 'sub') return 'Click: remove the roads of a kerb line · Shift-click: just this road · Enter: create · Backspace: undo pick · Esc: leave';
    return 'Click: add a kerb line and its roads · Shift-click: just this piece · Alt-click: subtract · Ctrl-click: lone kerb · Enter: create · Backspace: undo pick · Esc: leave';
  },

  // ── the canvas ──
  down(wx, wy, e) {
    const S = this.stage; if (!S) return;
    const tol = 12 / RoadPlan._view.z, pt = [wx, wy], mod = e.altKey || e.shiftKey || e.ctrlKey || e.metaKey;
    if (S.one && !mod) { S.place(pt); this._refresh(); return; }
    if (S.pairFrom && !mod) {
      const h = S.hitAt(pt, tol);
      if (!h) { S.pairFrom = null; UI.toast('Pairing cancelled: no kerb there.', 'info', 2500); }
      else { const r = S.pairWith(h.layer, h.chain); if (r === 'noroad') UI.toast('Those two kerbs do not run beside each other.', 'warn', 3500); else if (r === 'layer') UI.toast('That kerb is on another layer: tick "Look for partners on any layer".', 'warn', 4000); }
      this._refresh(); return;
    }
    if (e.ctrlKey || e.metaKey) {
      const h = S.hitAt(pt, tol); if (!h) { UI.toast('Click on a kerb line.', 'info', 2500); return; }
      S.arm(h.layer, h.chain); UI.toast(`Click on the road's side of that kerb: the road goes ${this.opt.oneW} m wide beside it.`, 'info', 4000); this._refresh(); return;
    }
    const h = S.hitAt(pt, tol), op = e.altKey ? 'sub' : S.mode;
    if (!h) {
      if (op === 'sub') { const i = S.streetAt(pt, tol); if (i >= 0) { const r = S.subStreet(i); UI.toast(r && !r.noop ? 'Road removed.' : 'Nothing to remove there.', 'info', 2000); this._refresh(); return; } }
      UI.toast('Click on a kerb line.', 'info', 2500); return;
    }
    if (op === 'add' && !e.shiftKey && S.lonely.some(l => l.layer === h.layer && l.chain === h.chain)) { S.armPair(h.layer, h.chain); UI.toast('Now click the kerb across the road.', 'info', 3500); this._refresh(); return; }
    const r = S.addChain(h.layer, h.chain, e.shiftKey ? h.part : null, op), n = k => `${k} road${k === 1 ? '' : 's'}`;
    if (r.noop) UI.toast(op === 'add' ? 'Already in.' : 'Nothing to remove there.', 'info', 1800);
    else if (op === 'add') UI.toast(r.added ? `Added ${n(r.added)}.` : r.lonely > 0 ? 'No partner found: shown red. Click it again, then the kerb across the road.' : 'Added.', r.added ? 'success' : 'warn', 3000);
    else UI.toast(`Removed ${n(r.removed)}.`, 'info', 2000);
    this._refresh();
  },
  move(wx, wy, e) {
    const S = this.stage; if (!S) return;
    const h = S.hitAt([wx, wy], 12 / RoadPlan._view.z), part = h && e && e.shiftKey ? h.part : null, key = h ? h.layer + '\u0000' + h.chain + (part ? part.join(',') : '') : '';
    if (key !== S._hk) { S._hk = key; S.hover = h ? { ...h, part } : null; RoadPlan.renderScreen(); }
  },
  key(e) {
    const S = this.stage; if (!S) return false;
    if (e.key === 'Backspace') { if (S.undo()) { UI.toast('Last pick taken back.', 'info', 1500); this._refresh(); } return true; }
    if (e.key === 'Enter') { this.create(); return true; }
    if (e.key === 'Escape') { RoadPlan.setTool('select'); return true; }
    return false;
  },
  overlay(S, out) {
    const T = this.stage; if (!T) return;
    const poly = (pts, attrs) => pts.length > 1 ? `<path d="M${pts.map(q => S(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join('L')}" fill="none" ${attrs}/>` : '';
    const lonely = new Set(T.lonely.map(l => l.layer + '\u0000' + l.chain)), armed = T.pairFrom || T.one;
    for (const k of T.keys()) T.layers[k].forEach((c, i) => {
      const id = k + '\u0000' + i;
      if (armed && armed.layer === k && armed.chain === i) out.push(poly(c.pts, 'stroke="#2563eb" stroke-width="3"'));
      else if (lonely.has(id)) out.push(poly(c.pts, 'stroke="#dc2626" stroke-width="2" stroke-dasharray="6 4"'));
      else if (T.used.has(id)) out.push(poly(c.pts, 'stroke="#1e40af" stroke-width="1.6" opacity=".75"'));
      else out.push(poly(c.pts, 'stroke="#64748b" stroke-width="1" opacity=".4"'));
    });
    if (T.hover) { const c = T.layers[T.hover.layer] && T.layers[T.hover.layer][T.hover.chain]; if (c) out.push(poly(c.pts, `stroke="${T.mode === 'add' ? '#16a34a' : '#dc2626'}" stroke-width="4" opacity=".9"`)); }
    const main = new Set((T.networks()[0]) || []);
    T.streets.forEach((st, k) => {
      out.push(poly(st.pts, `stroke="${main.has(k) ? '#f59e0b' : '#ea580c'}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"`));
      for (const q of [st.pts[0], st.pts[st.pts.length - 1]]) { const [x, y] = S(q[0], q[1]); out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#f59e0b"/>`); }
      const m = st.pts[Math.floor(st.pts.length / 2)], [x, y] = S(m[0], m[1]);
      out.push(`<text x="${(x + 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="11" fill="#92400e">${st.w.toFixed(1)} m</text>`);
    });
  },

  // ── the panel ──
  panelHtml() {
    const o = this.opt, T = this.stage, L = this.layers();
    if (!T) return '';
    const num = (k, label, min, max, step) => `<label class="rk-num">${label}<input type="number" class="sl-in-num" data-rpk="${k}" min="${min}" max="${max}" step="${step}" value="${escHtml(o[k])}"></label>`;
    const nets = T.networks(), info = T.lonely.map(l => T.info(l.layer, l.chain));
    const pickName = p => p.op === 'all' ? 'Paired every kerb of a layer' : p.op === 'pair' ? 'Paired two kerbs by hand' : p.op === 'one' ? 'Road beside a lone kerb' : `${p.op === 'add' ? 'Added' : 'Removed'} ${p.items.length > 1 ? p.items.length + ' kerb lines' : 'a kerb line'}${p.items[0] && p.items[0].span ? ' (one piece)' : ''}`;
    const body = `<div class="rk-row"><button class="btn-small${T.mode === 'add' ? ' active' : ''}" data-rp="rk-mode" data-m="add" aria-pressed="${T.mode === 'add'}">Add</button><button class="btn-small${T.mode === 'sub' ? ' active' : ''}" data-rp="rk-mode" data-m="sub" aria-pressed="${T.mode === 'sub'}">Subtract</button><button class="btn-small" data-rp="rk-undo"${T.picks.length ? '' : ' disabled'} title="Backspace">Undo last pick</button></div>
      <div class="sl-hint">Click a kerb line (any layer) to add it and every road it touches. Shift-click takes just the one drawn piece. Alt-click subtracts for one click; click a road in Subtract to remove it.</div>
      <div><b>${T.streets.length}</b> road${T.streets.length === 1 ? '' : 's'} (amber, width on each).</div>
      <div class="rk-row"><label class="rl-field">Pair all on layer<select data-rpk="layer">${L.map(x => `<option value="${escHtml(x.layer)}"${x.layer === this.layer ? ' selected' : ''}>${escHtml(x.layer)} (${x.n})${x.kerbs ? ' · kerbs (pair them)' : ''}</option>`).join('')}</select></label><button class="btn-small" data-rp="rk-pairall"${L.length ? '' : ' disabled'}>Pair all</button></div>
      <label class="sl-hint"><input type="checkbox" data-rpk="anylayer"${T.anyLayer ? ' checked' : ''}> Look for partners on any layer</label>
      ${nets.length > 1 ? `<div class="rk-warn"><b>${nets.length} separate networks</b> (${nets.map(c => c.length).join(' + ')} roads; the ones cut off are orange): the circuits and junction lighting do not link across a gap.<div class="rk-row"><button class="btn-small" data-rp="rk-join">Join networks up to</button><input type="number" class="sl-in-num" data-rpk="join" min="1" max="200" step="5" value="${escHtml(o.join)}"> m</div></div>` : T.streets.length ? '<div class="rk-ok">The roads form one connected network.</div>' : ''}
      <div class="rk-opts">${num('wmin', 'Road width at least', 1, 30, 0.5)}${num('wmax', 'at most', 5, 60, 0.5)}${num('gap', 'Bridge gaps up to (m)', 0, 60, 1)}</div>
      <div class="sl-hint">Ctrl-click a kerb with no partner, then click the road's side: a road <input type="number" class="sl-in-num" data-rpk="oneW" min="3" max="40" step="0.5" value="${escHtml(o.oneW)}"> m wide beside it.</div>
      ${info.length ? `<div class="rk-bad"><b>Clicked, no partner</b> (${info.length}, red dashed):<div class="rk-list">${info.map(k => `<div class="rk-item"><span>near ${Math.round(k.at[0])}, ${Math.round(k.at[1])} m · ${Math.round(k.len)} m</span><span><button class="btn-small" data-rp="rk-show" data-l="${escHtml(k.layer)}" data-i="${k.i}">show</button><button class="btn-small" data-rp="rk-pair" data-l="${escHtml(k.layer)}" data-i="${k.i}" title="Then click the kerb across the road">pair…</button><button class="btn-small${T.one && T.one.layer === k.layer && T.one.chain === k.i ? ' active' : ''}" data-rp="rk-one" data-l="${escHtml(k.layer)}" data-i="${k.i}" title="A road with a kerb on this side only">one side…</button></span></div>`).join('')}</div></div>` : ''}
      ${T.picks.length ? `<details><summary class="sl-hint">Picks (${T.picks.length})</summary><div class="rk-list">${T.picks.map((p, i) => `<div class="rk-item"><span>${pickName(p)}</span><button class="btn-small" data-rp="rk-rmpick" data-i="${i}" title="Take this pick out">×</button></div>`).reverse().join('')}</div></details>` : ''}
      <div class="rk-row"><button class="btn-small btn-primary" data-rp="rk-create"${T.streets.length ? '' : ' disabled'}>Create ${T.streets.length} road${T.streets.length === 1 ? '' : 's'}</button><button class="btn-small" data-rp="rk-close">Cancel</button></div>`;
    return `<div class="rk-panel"><h3>Roads from kerbs: pick</h3>${body}</div>`;
  },
  act(t) {
    const a = t.dataset.rp; if (!a.startsWith('rk-')) return false;
    const T = this.stage;
    if (a === 'rk-close') RoadPlan.setTool('select');
    else if (a === 'rk-create') this.create();
    else if (!T) return true;
    else if (a === 'rk-mode') { T.mode = t.dataset.m; T.one = T.pairFrom = null; this._refresh(); }
    else if (a === 'rk-undo') { T.undo(); this._refresh(); }
    else if (a === 'rk-rmpick') { T.removePick(+t.dataset.i); this._refresh(); }
    else if (a === 'rk-pairall') {
      if (!this.layer || !T.layers[this.layer]) { UI.toast(`Layer "${this.layer}" has no lines.`, 'warn', 3500); return true; }
      const r = T.pairAll(this.layer); UI.toast(r.noop ? 'That layer is already paired.' : `${r.added} road${r.added === 1 ? '' : 's'} found${T.lonely.length ? `; ${T.lonely.length} kerb chain${T.lonely.length === 1 ? '' : 's'} without a partner (red)` : ''}.`, r.noop ? 'info' : 'success', 5000);
      this._refresh();
    } else if (a === 'rk-join') {
      const n = T.join(this.opt.join), c = T.networks().length;
      UI.toast(n ? `${n} join${n === 1 ? '' : 's'} made; ${c === 1 ? 'one connected network now' : c + ' networks remain (the gaps are wider than ' + this.opt.join + ' m)'}.` : `Nothing within ${this.opt.join} m to join.`, c === 1 ? 'success' : 'warn', 5000);
      this._refresh();
    } else if (a === 'rk-show') {
      const c = T.layers[t.dataset.l][+t.dataset.i], xs = c.pts.map(p => p[0]), ys = c.pts.map(p => p[1]);
      const { W, H } = RoadPlan._size(), x0 = Math.min(...xs) - 15, x1 = Math.max(...xs) + 15, y0 = Math.min(...ys) - 15, y1 = Math.max(...ys) + 15;
      RoadPlan._view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z: Math.max(0.02, Math.min(40, Math.min(W / (x1 - x0), H / (y1 - y0)))) };
      RoadPlan.applyView();
    } else if (a === 'rk-pair') { T.armPair(t.dataset.l, +t.dataset.i); UI.toast('Now click the kerb on the other side of that road.', 'info', 3500); this._refresh(); }
    else if (a === 'rk-one') { T.arm(t.dataset.l, +t.dataset.i); UI.toast(`Click on the road's side of that kerb: the road goes ${this.opt.oneW} m wide beside it.`, 'info', 4000); this._refresh(); }
    return true;
  },
  change(t) {
    const k = t.dataset.rpk;
    if (k === 'layer') { this.layer = t.value; return; }
    if (k === 'anylayer') { if (this.stage) { this.stage.setAnyLayer(t.checked); this._refresh(); } return; }
    const v = parseFloat(t.value); if (!isFinite(v)) return;
    this.opt[k] = v;
    if (this.stage) { if (k === 'join' || k === 'oneW') this.stage.o = Object.assign({}, this.stage.o, this.opt); else { this.stage.setOpt(this.opt); this._refresh(); } }
  },

  // ── Create ──
  async create() {
    const T = this.stage; if (!T || !T.streets.length) { UI.toast('No roads to create.', 'warn', 3000); return; }
    const designId = await RoadPlan._designForNewRoad(); if (!designId) return;
    const nets = T.networks().length, made = [];
    for (const st of T.streets) {
      const sd = PlanKerbs.sides(st, T.chainsOf(st), T.o); if (sd.a.length < 2 || sd.b.length < 2) continue;
      const nm = this._nameOf ? this._nameOf(st, true) : null;
      const road = { id: RoadPlan._genId('rpr'), name: nm || `Road ${RoadPlan.roads.length + 1}`, designId, radius: 50, poles: [], layout: {}, mode: 'kerbs', kerbs: { a: sd.a, b: sd.b } };
      RoadPlan.roads.push(road); made.push(road);
    }
    if (!made.length) { UI.toast('No road could be made from those kerbs.', 'warn', 3500); return; }
    RoadPlan._selRoad = made[0].id;
    for (const r of RoadPlan.roads) if (!r.poles.some(p => p.moved)) RoadPlan.layoutRoad(r);       // new junctions re-lay the roads they touch
    RoadPlan._commit();
    RoadPlan.setTool('select');
    RoadPlan.render();
    UI.toast(`${made.length} road${made.length === 1 ? '' : 's'} made from the kerbs, each with its measured width.${nets > 1 ? ` They form ${nets} separate networks.` : ''}`, nets > 1 ? 'warn' : 'success', 7000);
  },
};
// distance from point t to the segment a-b
function PlanKerbsSeg(t, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, k = L2 ? Math.max(0, Math.min(1, ((t[0] - a[0]) * dx + (t[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(t[0] - a[0] - dx * k, t[1] - a[1] - dy * k);
}
