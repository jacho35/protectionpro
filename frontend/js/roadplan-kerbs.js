/**
 * RoadKerbs — Road plan › Roads from kerbs: every road of a kerb layer of the DXF background, paired automatically.
 *
 * The pairing is PlanKerbs (plan-kerbs.js, shared with Auto layout's Streets from kerb layer). Here it runs on the
 * background drawing (`RoadPlan.rp.bg`, already in metres), is reviewed on the road plan, and each street becomes a
 * road in `kerbs` mode: the two kerb lines are read back from the drawn kerbs (`PlanKerbs.sides`), so the carriageway
 * width follows the kerbs exactly as for two hand-picked kerbs and the lighting calculation sees the real width.
 *
 * Review: amber = a road, orange = cut off from the main network, red dashed = a kerb chain with no partner.
 * Alt-click removes a road; Shift-click two kerbs adds one; Ctrl-click a lone kerb, then click the road's side;
 * Enter creates; Esc leaves. Session-only until Create.
 */
const RoadKerbs = {
  on: false,                 // the Roads-from-kerbs panel is open
  layer: '',
  stage: null,               // PlanKerbs.stage once Find roads has run
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

  // ── open / find / close ──
  open() {
    this.on = true; this.stage = null;
    const L = this.layers(); if (!this.layer || !L.some(x => x.layer === this.layer)) this.layer = (L[0] || {}).layer || '';
    RoadPlan.setTool('kerbauto'); RoadPlan.renderPanel();
  },
  close() { this.on = false; this.stage = null; },
  find() {
    if (!this.layer) return;
    const chains = this.chainsOf(this.layer);
    if (!chains.length) { UI.toast(`Layer "${this.layer}" has no lines.`, 'warn', 3500); return; }
    this.stage = PlanKerbs.stage(chains, this.opt).solve();
    this._names();
    const S = this.stage, u = S.unpaired.length, nets = S.networks().length;
    UI.toast(`${S.streets.length} road${S.streets.length === 1 ? '' : 's'} found from ${chains.length} kerb chains${u ? `; ${u} without a partner` : ''}${nets > 1 ? `; ${nets} separate networks` : ''}. Alt-click removes one, Shift-click two kerbs adds one, Enter creates them.`, u || nets > 1 ? 'warn' : 'success', 8000);
    this._refresh();
  },
  resolve() { if (this.stage) { this.stage.o = Object.assign({}, this.stage.o, this.opt); this.stage.solve(); this._names(); this._refresh(); } },
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
    if (!this.stage) return 'Pick the layer that holds the kerb lines, then Find roads.';
    return 'Alt-click a road removes it · Shift-click a kerb, then the kerb across the road, adds one · Ctrl-click a kerb with no partner, then click the road\'s side · Enter creates the roads, Esc leaves.';
  },

  // ── the canvas ──
  down(wx, wy, e) {
    const S = this.stage; if (!S) return;
    const tol = 12 / RoadPlan._view.z, pt = [wx, wy];
    if (S.one != null && !(e.altKey || e.shiftKey || e.ctrlKey || e.metaKey)) { S.place(pt); this._refresh(); return; }
    if (e.ctrlKey || e.metaKey) {
      const i = S.chainAt(pt, tol); if (i < 0) { UI.toast('Click on a kerb line.', 'info', 2500); return; }
      S.arm(i); UI.toast(`Click on the road's side of that kerb: the road goes ${this.opt.oneW} m wide beside it.`, 'info', 4000); this._refresh(); return;
    }
    if (e.altKey) { if (!S.remove(pt, tol)) UI.toast('No road there.', 'info', 2000); this._refresh(); return; }
    if (e.shiftKey) {
      const r = S.pair(pt, tol);
      if (r === 'nokerb') UI.toast('Click on a kerb line.', 'info', 2500);
      else if (r === 'first') UI.toast('Now Shift-click the kerb on the other side of that road.', 'info', 3000);
      else if (r === 'noroad') UI.toast('Those two kerbs do not run beside each other.', 'warn', 3500);
      this._refresh(); return;
    }
    UI.toast('Alt-click removes a road; Shift-click two kerbs adds one; Ctrl-click a lone kerb; Enter creates the roads.', 'info', 3500);
  },
  key(e) {
    if (e.key === 'Enter' && this.stage) { this.create(); return true; }
    if (e.key === 'Escape') { RoadPlan.setTool('select'); return true; }
    return false;
  },
  overlay(S, out) {
    const T = this.stage; if (!T) return;
    const poly = (pts, attrs) => pts.length > 1 ? `<path d="M${pts.map(q => S(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join('L')}" fill="none" ${attrs}/>` : '';
    const un = new Set(T.unpaired);
    T.chains.forEach((c, i) => {
      if (T.pickA === i || T.one === i) out.push(poly(c.pts, 'stroke="#2563eb" stroke-width="3"'));
      else if (un.has(i)) out.push(poly(c.pts, 'stroke="#dc2626" stroke-width="2" stroke-dasharray="6 4"'));
      else out.push(poly(c.pts, 'stroke="#64748b" stroke-width="1" opacity=".55"'));
    });
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
    const num = (k, label, min, max, step) => `<label class="rk-num">${label}<input type="number" class="sl-in-num" data-rpk="${k}" min="${min}" max="${max}" step="${step}" value="${o[k]}"></label>`;
    const pick = `<label class="rl-field">Layer with the kerb lines<select data-rpk="layer">${L.map(x => `<option value="${escHtml(x.layer)}"${x.layer === this.layer ? ' selected' : ''}>${escHtml(x.layer)} (${x.n})${x.kerbs ? ' · kerbs (pair them)' : ''}</option>`).join('')}</select></label>`;
    let body = '';
    if (!T) {
      body = `<p class="sl-hint">Each road of the layer is found from its two kerbs: the centreline midway between them, the carriageway width taken from the drawing. You review the result on the plan before any road is made.</p>
        <div class="rk-opts">${num('wmin', 'Road width at least', 1, 30, 0.5)}${num('wmax', 'at most', 5, 60, 0.5)}${num('gap', 'Bridge gaps up to (m)', 0, 60, 1)}</div>
        <button class="btn-small btn-primary" data-rp="rk-find"${L.length ? '' : ' disabled'}>Find roads</button> <button class="btn-small" data-rp="rk-close">Cancel</button>`;
    } else {
      const nets = T.networks(), info = T.unpaired.map(i => T.info(i));
      body = `<div><b>${T.streets.length}</b> road${T.streets.length === 1 ? '' : 's'} (amber, width on each) from ${T.chains.length} kerb chains.</div>
        ${nets.length > 1 ? `<div class="rk-warn"><b>${nets.length} separate networks</b> (${nets.map(c => c.length).join(' + ')} roads; the ones cut off are orange): the circuits and junction lighting do not link across a gap.<div class="rk-row"><button class="btn-small" data-rp="rk-join">Join networks up to</button><input type="number" class="sl-in-num" data-rpk="join" min="1" max="200" step="5" value="${o.join}"> m</div></div>` : T.streets.length ? '<div class="rk-ok">The roads form one connected network.</div>' : ''}
        <div class="rk-opts">${num('wmin', 'Road width at least', 1, 30, 0.5)}${num('wmax', 'at most', 5, 60, 0.5)}${num('gap', 'Bridge gaps up to (m)', 0, 60, 1)}</div>
        <div class="sl-hint">Ctrl-click a kerb with no partner, then click the road's side: a road <input type="number" class="sl-in-num" data-rpk="oneW" min="3" max="40" step="0.5" value="${o.oneW}"> m wide beside it.</div>
        ${info.length ? `<div class="rk-bad"><b>${info.length} kerb chain${info.length === 1 ? ' has' : 's have'} no partner</b> (red dashed):<div class="rk-list">${info.map(k => `<div class="rk-item"><span>near ${Math.round(k.at[0])}, ${Math.round(k.at[1])} m · ${Math.round(k.len)} m</span><span><button class="btn-small" data-rp="rk-show" data-i="${k.i}">show</button><button class="btn-small${T.one === k.i ? ' active' : ''}" data-rp="rk-one" data-i="${k.i}" title="A road with a kerb on this side only">road from this kerb</button></span></div>`).join('')}</div></div>` : '<div class="rk-ok">Every kerb chain was paired.</div>'}
        <div class="rk-row"><button class="btn-small btn-primary" data-rp="rk-create"${T.streets.length ? '' : ' disabled'}>Create ${T.streets.length} road${T.streets.length === 1 ? '' : 's'}</button><button class="btn-small" data-rp="rk-back">Change layer</button><button class="btn-small" data-rp="rk-close">Cancel</button></div>`;
    }
    return `<div class="rk-panel"><h3>Roads from kerbs</h3>${T ? `<div class="sl-hint">Layer "${escHtml(this.layer)}"</div>` : pick}${body}</div>`;
  },
  act(t) {
    const a = t.dataset.rp; if (!a.startsWith('rk-')) return false;
    const T = this.stage;
    if (a === 'rk-find') this.find();
    else if (a === 'rk-close') RoadPlan.setTool('select');
    else if (a === 'rk-back') { this.stage = null; this._refresh(); }
    else if (a === 'rk-create') this.create();
    else if (a === 'rk-join' && T) {
      const n = T.join(this.opt.join), c = T.networks().length;
      UI.toast(n ? `${n} join${n === 1 ? '' : 's'} made; ${c === 1 ? 'one connected network now' : c + ' networks remain (the gaps are wider than ' + this.opt.join + ' m)'}.` : `Nothing within ${this.opt.join} m to join.`, c === 1 ? 'success' : 'warn', 5000);
      this._refresh();
    } else if (a === 'rk-show' && T) {
      const c = T.chains[+t.dataset.i], xs = c.pts.map(p => p[0]), ys = c.pts.map(p => p[1]);
      const { W, H } = RoadPlan._size(), x0 = Math.min(...xs) - 15, x1 = Math.max(...xs) + 15, y0 = Math.min(...ys) - 15, y1 = Math.max(...ys) + 15;
      RoadPlan._view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z: Math.max(0.02, Math.min(40, Math.min(W / (x1 - x0), H / (y1 - y0)))) };
      RoadPlan.applyView();
    } else if (a === 'rk-one' && T) { T.arm(+t.dataset.i); UI.toast(`Click on the road's side of that kerb: the road goes ${this.opt.oneW} m wide beside it.`, 'info', 4000); this._refresh(); }
    return true;
  },
  change(t) {
    const k = t.dataset.rpk;
    if (k === 'layer') { this.layer = t.value; return; }
    const v = parseFloat(t.value); if (!isFinite(v)) return;
    this.opt[k] = v;
    if (this.stage && k !== 'join' && k !== 'oneW') this.resolve();
  },

  // ── Create ──
  async create() {
    const T = this.stage; if (!T || !T.streets.length) { UI.toast('No roads to create.', 'warn', 3000); return; }
    const designId = await RoadPlan._designForNewRoad(); if (!designId) return;
    const nets = T.networks().length, made = [];
    for (const st of T.streets) {
      const sd = PlanKerbs.sides(st, T.chains, T.o); if (sd.a.length < 2 || sd.b.length < 2) continue;
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
