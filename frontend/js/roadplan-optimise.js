/* ProtectionPro — Road plan › Poles › *Lay out for the checks* (RoadPlanOpt).
 *
 * The rule-based layout (RoadPlan.layoutRoad) puts a pole at every junction mouth and spaces the rest evenly; it never
 * looks at the results. This lays the poles out against the checks:
 *
 *   1. Junctions first. Candidate poles on each leg's pole line — at the mouth edges, opposite a side road (SANS 10098-1
 *      fig. 6), a few metres either side; never inside a carriageway. The server gives what each candidate adds to each
 *      conflict area's grid (POST /analysis/road-plan/contributions); illuminance adds up, so every set of up to `maxN`
 *      candidates is scored here by summing (`bestSet`). Each junction takes the fewest poles that pass its class
 *      (C / RC: Ē and Uo; P / CP / B: Ē and Emin), the best margin among equals.
 *   2. Streets second. Those poles (and any pole you moved) are fixed; each road is filled at the widest spacing whose
 *      segments still pass, searched per road with the real calculation (`fillStations`, a bisection on the spacing).
 *   3. The junctions are checked again with the street poles in place; one that fails is chosen again with them as its
 *      base (up to three rounds).
 *   4. Heights are never changed. The same junction search runs at greater heights (the design's rows + 1 m steps up to
 *      12 m); when the design's height cannot pass a junction, the lowest height that can is suggested.
 *
 * Apply = one undo step; every pole it lays is marked moved (kept by Lay out again), a junction pole noted as one.
 * Pure parts (`score`, `bestSet`, `fillStations`) are node-testable: testing/unit/roadplan-optimise.test.js.
 */

const RoadPlanOpt = {
  opts: { maxSpacing: 80, minSpacing: 8, maxN: 4, keepMoved: true, marginPct: 0 },
  _res: null,

  // ─── Pure ──────────────────────────────────────────────────────────────
  // Checks of one conflict area on an illuminance array: { pass, margin (worst value / requirement), v }
  score(E, checks) {
    const n = E.length;
    if (!n) return { pass: false, margin: 0, v: {} };
    let sum = 0, min = Infinity;
    for (let i = 0; i < n; i++) { sum += E[i]; if (E[i] < min) min = E[i]; }
    const eav = sum / n, v = { Eav: eav, Emin: min, Uo: eav > 0 ? min / eav : 0 };
    let margin = Infinity;
    for (const c of checks) margin = Math.min(margin, c.req > 0 ? (v[c.key] || 0) / c.req : Infinity);
    if (!checks.length) margin = 1;
    return { pass: margin >= 1 - 1e-9, margin, v };
  },
  // The fewest of `ids` (candidate indices with a column in `area.cand`) that pass, best margin among equals; when no set
  // of up to maxN passes, the set with the best margin (pass false). `base` = illuminance already there (array).
  bestSet(area, ids, maxN, base) {
    const n = area.base.length, b = base || area.base;
    const cols = ids.map(i => area.cand[String(i)] || null);
    const E = new Float64Array(n);
    let best = null, bestFail = null;
    const sc0 = this.score(b, area.checks);
    if (sc0.pass) return { set: [], ...sc0 };
    const rec = (start, chosen, k) => {
      if (chosen.length === k) {
        for (let p = 0; p < n; p++) { let s = b[p]; for (const c of chosen) if (cols[c]) s += cols[c][p]; E[p] = s; }
        const sc = this.score(E, area.checks);
        if (sc.pass && (!best || sc.margin > best.margin)) best = { set: chosen.map(c => ids[c]), ...sc };
        if (!bestFail || sc.margin > bestFail.margin) bestFail = { set: chosen.map(c => ids[c]), ...sc };
        return;
      }
      for (let c = start; c < ids.length; c++) { chosen.push(c); rec(c + 1, chosen, k); chosen.pop(); }
    };
    for (let k = 1; k <= Math.min(maxN, ids.length) && !best; k++) rec(0, [], k);
    return best || bestFail || { set: [], ...sc0 };
  },
  // Pole stations along one pole line of length L at spacing ≤ S: `fixed` = stations that must have a pole (junction
  // poles, moved poles); `open0` / `open1` = that end is in a junction (no pole needed there: the last pole at most S/2
  // from it), else a free road end with a pole `start` m in. `frac` (0–1) = a staggered row: its poles sit at that
  // fraction of each gap, never on a fixed point. An open end may be 'lit' (its junction has poles of its own): it then
  // counts as a pole for the spacing, but none is put there.
  fillStations(fixed, L, S, open0, open1, start = 3, frac = 0) {
    const pts = fixed.filter(s => s >= 0 && s <= L).map(s => ({ s, pole: true, out: true }));
    const end = (open, s0, sIn) => open === 'lit' ? { s: s0, pole: true, out: false } : open ? { s: s0, pole: false } : { s: sIn, pole: true, out: true };
    pts.push(end(open0, 0, Math.min(start, L / 2)));
    pts.push(end(open1, L, Math.max(L - start, L / 2)));
    pts.sort((a, b) => a.s - b.s);
    const out = frac ? [] : pts.filter(p => p.out).map(p => p.s);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], len = b.s - a.s;
      if (len <= 1e-6) continue;
      if (frac) { const n = Math.max(1, Math.ceil(len / S)); for (let k = 0; k < n; k++) out.push(a.s + len * (k + frac) / n); continue; }
      if (a.pole && b.pole) { const n = Math.ceil(len / S - 1e-9); for (let k = 1; k < n; k++) out.push(a.s + len * k / n); continue; }
      if (!a.pole && !b.pole) { const n = Math.max(1, Math.ceil(len / S - 1e-9)); for (let k = 0; k < n; k++) out.push(a.s + len * (k + 0.5) / n); continue; }
      // one end open: n poles from the pole end, evenly, the last at most S/2 from the open end
      const n = Math.ceil(Math.max(0, len - S / 2) / S - 1e-9);
      const from = a.pole ? a.s : b.s, sign = a.pole ? 1 : -1, step = len / (n + 0.5);
      for (let k = 1; k <= n; k++) out.push(from + sign * step * k);
    }
    const uniq = [];
    for (const s of out.sort((x, y) => x - y)) if (!uniq.length || s - uniq[uniq.length - 1] > 0.5) uniq.push(s);
    return uniq;
  },

  // ─── Plan geometry (browser) ───────────────────────────────────────────
  _inPoly(x, y, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; },
  _ctx() {
    const RP = RoadPlan;
    const roads = RP.roads.filter(r => RP.geom(r).al.ok && RP._design(r));
    const carr = roads.map(r => RP._kerbPolygon(r, 0, RP.geom(r).al.length));
    return { RP, roads, carr, juncs: RP.junctions() };
  },
  // a pole base outside every carriageway (0.4 m clear)
  _valid(X, road, rowId, s) {
    const g = X.RP.poleGeom(road, { s, rowId }); if (!g) return false;
    for (const [dx, dy] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) if (X.carr.some(P => this._inPoly(g.bx + dx, g.by + dy, P))) return false;
    return true;
  },
  _nudge(X, road, rowId, s) {
    const L = X.RP.geom(road).al.length;
    if (this._valid(X, road, rowId, s)) return s;
    for (let d = 0.5; d <= 15; d += 0.5) for (const t of [s + d, s - d]) if (t > 0.2 && t < L - 0.2 && this._valid(X, road, rowId, t)) return t;
    return null;
  },
  // the luminaire record of a pole (as RoadPlan.payload sends it), at the row's height + dh
  _lum(X, road, rowId, s, dh = 0, id) {
    const row = X.RP._design(road).rows.find(r => r.id === rowId);
    const p = { s, rowId, over: dh ? { height: X.RP._num(row.height, 10) + dh } : undefined };
    const pg = X.RP.poleGeom(road, p);
    if (!pg || !RoadLight.library[pg.photometryId]) return null;
    return { id: id || `${road.id}@${s.toFixed(2)}`, roadId: road.id, x: +pg.hx.toFixed(3), y: +pg.hy.toFixed(3), h: pg.height, aim: +pg.aim.toFixed(3), tilt: pg.tilt, rotate: pg.rotate, photometryId: pg.photometryId, fluxPct: pg.fluxPct };
  },
  // candidate junction poles: [{ j (junction index), road, rowId, s }]
  candidates(X) {
    const { RP } = X, out = [];
    X.juncs.forEach((j, ji) => {
      const A = RP.road(j.main), B = RP.road(j.side); if (!A || !B) return;
      const hA = RP._halfKerb(A, RP.geom(A), j.sMain), hB = RP._halfKerb(B, RP.geom(B), j.sSide);
      const add = (road, s) => {
        const L = RP.geom(road).al.length; s = Math.max(0.5, Math.min(L - 0.5, s));
        for (const row of RP._design(road).rows) {
          if (!this._valid(X, road, row.id, s)) continue;
          if (out.some(c => c.j === ji && c.road === road.id && c.rowId === row.id && Math.abs(c.s - s) < 2)) continue;
          out.push({ j: ji, road: road.id, rowId: row.id, s: +s.toFixed(2) });
        }
      };
      for (const d of [0, hB + 1.5, -(hB + 1.5), 8, -8, 14, -14]) add(A, j.sMain + d);
      if (j.kind === 'T') { const dir = j.sSide === 0 ? 1 : -1; for (const d of [hA + 1.5, hA + 6, hA + 12]) add(B, j.sSide + dir * d); }
      else for (const d of [hA + 1.5, -(hA + 1.5), 8, -8, 14, -14]) add(B, j.sSide + d);
    });
    return out;
  },
  // a road's end inside a junction's range: 'lit' when that junction has poles of its own, else true (no pole needed at
  // it, the last street pole within S/2); false = a free end
  _openEnd(X, road, atEnd, chosen) {
    const L = X.RP.geom(road).al.length;
    const ji = X.juncs.findIndex(j => X.RP._junctionRanges(j).some(r => r.road === road.id && (atEnd ? r.s1 >= L - 0.5 : r.s0 <= 0.5)));
    if (ji < 0) return false;
    return chosen.some(c => c.j === ji) ? 'lit' : true;
  },
  // every road's poles for a junction choice + spacings: { [roadId]: [{ s, rowId, junction?: name, moved?: true }] }
  _place(X, chosen, spacing, kept) {
    const out = {};
    for (const road of X.roads) {
      const L = X.RP.geom(road).al.length, list = [];
      for (const row of X.RP._design(road).rows) {
        const jp = chosen.filter(c => c.road === road.id && c.rowId === row.id);
        const mv = (kept[road.id] || []).filter(p => p.rowId === row.id);
        const fixed = jp.map(c => c.s).concat(mv.map(p => p.s));
        const frac = ((X.RP._num(row.xOffset, 0) % 1) + 1) % 1;
        const S = spacing[road.id];
        const st = this.fillStations(fixed, L, S, this._openEnd(X, road, false, chosen), this._openEnd(X, road, true, chosen), X.RP._layoutCfg(road).start, frac);
        for (const c of jp) list.push({ s: c.s, rowId: row.id, junction: X.juncs[c.j].name });
        for (const p of mv) list.push({ s: p.s, rowId: row.id, kept: true, note: p.note });
        for (const s of st) {
          if (fixed.some(f => Math.abs(f - s) < 0.5)) continue;
          const t = this._nudge(X, road, row.id, s);
          if (t != null && !list.some(q => q.rowId === row.id && Math.abs(q.s - t) < 1)) list.push({ s: +t.toFixed(2), rowId: row.id });
        }
      }
      out[road.id] = list.sort((a, b) => a.s - b.s);
    }
    return out;
  },
  // the road-plan request for a placement (the real one, without the display grids)
  _payload(X, placed) {
    const RP = X.RP, saved = RP.roads.map(r => r.poles);
    try {
      for (const r of RP.roads) if (placed[r.id]) r.poles = placed[r.id].map((p, k) => ({ id: `opt_${r.id}_${k}`, s: p.s, rowId: p.rowId, moved: true }));
      const pl = RP.payload(); pl.display = false; pl.luminanceDisplay = false; return pl;
    } finally { RP.roads.forEach((r, k) => { r.poles = saved[k]; }); }
  },

  // ─── The run ───────────────────────────────────────────────────────────
  async run(progress = () => {}) {
    const o = this.opts, X = this._ctx(), RP = X.RP;
    if (!X.roads.length) throw new Error('No roads with a lighting design on the plan.');
    if (!X.juncs.length) throw new Error('The plan has no junctions: Lay out again is all it needs.');
    const kept = {};
    if (o.keepMoved) for (const r of X.roads) kept[r.id] = (r.poles || []).filter(p => p.moved && !/^Lay out for the checks/.test(p.note || '')).map(p => ({ s: p.s, rowId: p.rowId, note: p.note }));
    const cands = this.candidates(X).filter(c => this._lum(X, RP.road(c.road), c.rowId, c.s));
    if (!cands.length) throw new Error('No junction pole positions found: does the design have a luminaire with photometry?');
    const heights0 = X.roads.map(r => RP._design(r).rows.map(w => RP._num(w.height, 10))).flat(), h0 = Math.max(...heights0);
    const dhs = [0]; for (let h = Math.floor(h0) + 1; h <= 12; h++) dhs.push(h - h0);
    // candidates at every height (index = height step × candidates + candidate)
    const lums = dhs.flatMap((dh, hi) => cands.map((c, ci) => this._lum(X, RP.road(c.road), c.rowId, c.s, dh, `c${hi}_${ci}`)));
    const keptLums = X.roads.flatMap(r => (kept[r.id] || []).map((p, k) => this._lum(X, r, p.rowId, p.s, 0, `k_${r.id}_${k}`))).filter(Boolean);
    progress('Working out what each candidate pole gives the junctions…');
    const base = RP.payload(); base.display = false;
    const contrib = await API.request('/analysis/road-plan/contributions', 'POST', { ...base, luminaires: keptLums, candidates: lums });
    // a design margin: the junctions are chosen against the class requirements raised by marginPct
    const k = 1 + Math.max(0, +o.marginPct || 0) / 100;
    const withMargin = a => a && ({ ...a, checks: a.checks.map(c => ({ ...c, req: c.req * k })) });
    const plainOf = X.juncs.map(j => contrib.areas.find(a => a.id === j.key)), areaOf = plainOf.map(withMargin);
    // the junction's set against the margin; one that cannot reach it is chosen against the class itself
    const choose = (am, ap, ids, baseArr) => { const b = this.bestSet(am, ids, o.maxN, baseArr); return b.pass || k === 1 ? b : this.bestSet(ap, ids, o.maxN, baseArr); };
    const idsAt = (hi, ji) => cands.map((c, ci) => c.j === ji ? hi * cands.length + ci : -1).filter(i => i >= 0);
    // heights: can each junction pass, and with how many poles?
    const heights = dhs.map((dh, hi) => {
      const per = X.juncs.map((j, ji) => { const a = areaOf[ji]; if (!a) return null; const b = this.bestSet(a, idsAt(hi, ji), o.maxN); return { name: j.name, pass: b.pass, n: b.set.length, v: b.v }; });
      return { h: +(h0 + dh).toFixed(2), dh, per, pass: per.every(p => !p || p.pass), poles: per.reduce((t, p) => t + (p ? p.n : 0), 0) };
    });
    // the design's height: each junction's set
    const pick = (ji) => { const a = areaOf[ji]; if (!a) return []; return choose(a, plainOf[ji], idsAt(0, ji)).set.map(i => cands[i]); };
    let chosen = X.juncs.flatMap((j, ji) => pick(ji));
    // streets: the widest spacing per road that passes, by bisection with the real calculation
    const spacing = {}, lo = {}, hi = {};
    for (const r of X.roads) { lo[r.id] = o.minSpacing; hi[r.id] = o.maxSpacing; spacing[r.id] = o.maxSpacing; }
    const roadPass = (res) => { const m = {}; for (const r of res.roads || []) m[r.id] = r.pass !== false; return m; };
    // 1. streets: every road from the widest spacing down, by bisection with the real calculation
    progress('Spacing the road poles…');
    let res = await API.request('/analysis/road-plan', 'POST', this._payload(X, this._place(X, chosen, spacing, kept)));
    let ok = roadPass(res);
    const open = X.roads.filter(r => !ok[r.id]).map(r => r.id);
    for (let it = 0; it < 7 && open.length; it++) {
      for (const id of open) spacing[id] = (lo[id] + hi[id]) / 2;
      res = await API.request('/analysis/road-plan', 'POST', this._payload(X, this._place(X, chosen, spacing, kept)));
      ok = roadPass(res);
      for (const id of open) { if (ok[id]) lo[id] = spacing[id]; else hi[id] = spacing[id]; }
    }
    for (const id of open) spacing[id] = Math.floor(lo[id] * 2) / 2;
    let placed = this._place(X, chosen, spacing, kept);
    res = await API.request('/analysis/road-plan', 'POST', this._payload(X, placed));
    // 2. a junction that fails its class with the street poles in place is chosen again, with every other placed pole as
    //    its base; only its own poles change (and a street pole within 2 m of a new one goes), so that base holds. The
    //    best layout the calculation has checked is kept.
    const fails = r => (r.conflictAreas || []).filter(c => c.pass === false).length + (r.roads || []).filter(x => x.pass === false).length;
    let best = { placed, res, chosen, n: fails(res) };
    for (let round = 0; round < 3 && best.n; round++) {
      const failing = (res.conflictAreas || []).filter(c => c.pass === false).map(c => X.juncs.findIndex(j => j.key === c.id)).filter(i => i >= 0);
      if (!failing.length) break;
      progress('Choosing the junction poles again with the road poles in place…');
      const next = {}; for (const id in placed) next[id] = placed[id].slice();
      for (const ji of failing) {
        const name = X.juncs[ji].name;
        const others = X.roads.flatMap(r => next[r.id].filter(p => p.junction !== name).map((p, n) => this._lum(X, r, p.rowId, p.s, 0, `o_${r.id}_${n}`))).filter(Boolean);
        const c2 = await API.request('/analysis/road-plan/contributions', 'POST', { ...base, conflictAreas: base.conflictAreas.filter(a => a.id === X.juncs[ji].key), luminaires: others, candidates: lums.slice(0, cands.length) });
        const ap = c2.areas[0]; if (!ap) continue;
        const set = choose(withMargin(ap), ap, idsAt(0, ji)).set.map(i => cands[i]);
        chosen = chosen.filter(c => c.j !== ji).concat(set);
        for (const id in next) next[id] = next[id].filter(p => p.junction !== name);
        for (const c of set) {
          next[c.road] = next[c.road].filter(p => p.junction || p.kept || p.rowId !== c.rowId || Math.abs(p.s - c.s) >= 2);
          next[c.road].push({ s: c.s, rowId: c.rowId, junction: name });
        }
      }
      for (const id in next) next[id].sort((x, y) => x.s - y.s);
      placed = next;
      res = await API.request('/analysis/road-plan', 'POST', this._payload(X, placed));
      const n = fails(res);
      if (n < best.n) best = { placed, res, chosen, n };
    }
    ({ placed, res, chosen } = best);
    const now = X.roads.reduce((t, r) => t + (r.poles || []).length, 0);
    const sugg = heights[0].pass ? null : heights.find(h => h.pass) || null;
    this._res = { placed, spacing, chosen, heights, sugg, res, now, h0, X,
      total: Object.values(placed).reduce((t, l) => t + l.length, 0), juncPoles: chosen.length,
      pass: res && res.pass !== false && (res.conflictAreas || []).every(c => c.pass !== false) };
    return this._res;
  },

  apply() {
    const R = this._res; if (!R) return;
    const RP = RoadPlan;
    for (const r of RP.roads) {
      const list = R.placed[r.id]; if (!list) continue;
      r.poles = list.map(p => ({ id: RP._genId('rpp'), s: p.s, rowId: p.rowId, moved: true,
        note: p.kept ? (p.note || '') : p.junction ? `Lay out for the checks: junction ${p.junction}` : 'Lay out for the checks' }));
      r.layout = Object.assign({}, r.layout || {}, { spacing: R.spacing[r.id] });
    }
    RP._resStale = true;
    RP._commit('Lay out for the checks');
    RP.render();
    UI.toast(`${R.total} poles laid out for the checks (${R.juncPoles} at junctions).`, 'success', 5000);
  },

  // ─── Dialog ────────────────────────────────────────────────────────────
  _optsHtml() {
    const o = this.opts;
    return `<p class="rl-lead">Lays every road's poles out against the checks: the fewest poles that make each junction pass its class, then each road at the widest spacing that still passes. Pole heights are not changed; when a junction cannot pass at the design's height, the lowest height that can is suggested.</p>
      <div class="rl-form rp-opt-form">
        <label>Widest spacing to try<span class="sl-unit"><input type="number" min="10" max="200" step="5" data-ro="maxSpacing" value="${o.maxSpacing}"> m</span></label>
        <label>At most, poles per junction<input type="number" min="1" max="6" step="1" data-ro="maxN" value="${o.maxN}"></label>
        <label title="Choose the junction poles to pass by this much (Ē and Uo / Emin above the class by this percentage)">Junction margin<span class="sl-unit"><input type="number" min="0" max="50" step="1" data-ro="marginPct" value="${o.marginPct}"> %</span></label>
        <label class="rl-inline"><input type="checkbox" data-ro="keepMoved"${o.keepMoved ? ' checked' : ''}> Keep poles I moved (they count as placed)</label>
      </div>`;
  },
  _resultHtml(R) {
    const f = (v, d = 1) => v == null || !isFinite(v) ? '—' : (+v).toFixed(d);
    const m = +this.opts.marginPct || 0;
    const byJ = new Map(); for (const c of R.chosen) byJ.set(c.j, (byJ.get(c.j) || 0) + 1);
    const jrows = R.X.juncs.map((j, ji) => { const c = (R.res.conflictAreas || []).find(x => x.id === j.key); return `<tr class="${c && c.pass === false ? 'bad' : ''}"><td><b>${escHtml(j.name)}</b> ${escHtml(RoadPlan.road(j.main).name)} × ${escHtml(RoadPlan.road(j.side).name)}</td><td>${escHtml(c ? c.cls : '')}</td><td class="sl-mono">${byJ.get(ji) || 0}</td><td class="sl-mono">${f(c && c.Eav)}</td><td class="sl-mono">${f(c && c.UoE, 2)}</td><td>${c ? (c.pass ? '<span class="rl-ok">✓</span>' : '<span class="rl-bad">✗</span>') : ''}</td></tr>`; }).join('');
    const rrows = R.X.roads.map(r => { const rr = (R.res.roads || []).find(x => x.id === r.id); return `<tr class="${rr && rr.pass === false ? 'bad' : ''}"><td>${escHtml(r.name)}</td><td class="sl-mono">${(R.placed[r.id] || []).length}</td><td class="sl-mono">${f(R.spacing[r.id], 1)}</td><td>${rr ? (rr.pass === false ? '<span class="rl-bad">✗</span>' : '<span class="rl-ok">✓</span>') : ''}</td></tr>`; }).join('');
    const hs = R.heights;
    const hrow = hs.map(h => `<tr class="${h.pass ? '' : 'bad'}${h.dh === 0 ? ' rp-opt-cur' : ''}"><td class="sl-mono">${f(h.h, 1)} m${h.dh === 0 ? ' (design)' : ''}</td><td>${h.pass ? `all pass${m ? ` with the ${m} % margin` : ''} · ${h.poles} junction poles` : `${m ? `short of the ${m} % margin` : 'fails'} at ${h.per.filter(p => p && !p.pass).map(p => escHtml(p.name)).join(', ')}`}</td></tr>`).join('');
    const short = hs[0].per.filter(p => p && !p.pass).map(p => escHtml(p.name)).join(', ');
    const marginNote = R.pass && R.sugg ? `<div class="sl-hint">The ${m} % junction margin is not reached at ${short} at ${f(R.h0, 1)} m (they pass the class itself); at ${f(R.sugg.h, 1)} m every junction reaches it.</div>` : '';
    const head = R.pass ? `<div class="rp-opt-verdict ok"><b>Every road and junction passes</b> with ${R.total} poles (${R.juncPoles} of them at junctions); the plan has ${R.now} now.${marginNote}</div>`
      : `<div class="rp-opt-verdict bad"><b>Not everything passes</b> at the design's mounting height (${f(R.h0, 1)} m)${R.sugg ? `. At <b>${f(R.sugg.h, 1)} m</b> every junction can pass: change the height in the Lighting design's row and run this again.` : '. No height up to 12 m makes every junction pass with this luminaire and ' + this.opts.maxN + ' poles per junction.'}</div>`;
    return `${head}
      <h4 class="rp-opt-h">Junctions</h4><table class="rl-table"><thead><tr><th>Junction</th><th>Class</th><th>Poles</th><th>Ē lx</th><th>Uo</th><th></th></tr></thead><tbody>${jrows}</tbody></table>
      <h4 class="rp-opt-h">Roads</h4><table class="rl-table"><thead><tr><th>Road</th><th>Poles</th><th>Spacing m</th><th></th></tr></thead><tbody>${rrows}</tbody></table>
      <details class="rp-opt-heights"${R.sugg ? ' open' : ''}><summary>Mounting heights (a suggestion only — the design is not changed)</summary><table class="rl-table"><tbody>${hrow}</tbody></table></details>
      <div class="sl-hint">Apply replaces the poles of every road (one undo step); they are kept by Lay out again. Junction poles are noted as such in the pole schedule.</div>`;
  },
  async open() {
    const foot = '<button class="btn-small" data-m="close">Cancel</button><button class="btn-small btn-primary" data-m="run">Lay out</button>';
    const m = RoadLight._modal('rp-opt-modal', 'Lay out for the checks', this._optsHtml(), foot, 'rp-opt-dialog');
    m.onchange = (e) => { const t = e.target.closest('[data-ro]'); if (!t) return; const k = t.dataset.ro; this.opts[k] = t.type === 'checkbox' ? t.checked : k === 'marginPct' ? Math.max(0, +t.value || 0) : Math.max(1, +t.value || this.opts[k]); };
    for (;;) {
      const v = await RoadLight._modalResult(m);
      if (v === 'run') {
        m.style.display = 'flex';
        const body = m.querySelector('.rl-dialog-body'), ft = m.querySelector('.rl-dialog-foot');
        ft.innerHTML = '<button class="btn-small" data-m="close">Cancel</button>';
        body.innerHTML = '<div class="rp-opt-busy">Starting…</div>';
        let R = null;
        try { R = await this.run(t => { const el = body.querySelector('.rp-opt-busy'); if (el) el.textContent = t; }); body.innerHTML = this._resultHtml(R); }
        catch (e) { body.innerHTML = `<div class="rp-opt-verdict bad">${escHtml(e && e.message ? e.message : String(e))}</div>`; ft.innerHTML = '<button class="btn-small" data-m="close">Close</button>'; continue; }
        if (m.style.display === 'none') return;                  // cancelled while running
        ft.innerHTML = '<button class="btn-small" data-m="close">Cancel</button><button class="btn-small" data-m="again">Options…</button><button class="btn-small btn-primary" data-m="ok">Apply</button>';
        continue;
      }
      if (v === 'again') { m.style.display = 'flex'; m.querySelector('.rl-dialog-body').innerHTML = this._optsHtml(); m.querySelector('.rl-dialog-foot').innerHTML = foot; continue; }
      if (v === true) this.apply();
      return;
    }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { RoadPlanOpt };
