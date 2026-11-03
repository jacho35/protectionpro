/* ProtectionPro — Issues: one list of everything that fails or needs attention.
 *
 * Read from what every workspace has already worked out — nothing here runs a
 * study:
 *   · Demand: transformer loading, feeder and service volt drop, motor starting, earth loop
 *     and ECC (AppState.reticResults);
 *   · Street lighting: each circuit's verdict (StreetLight._results);
 *   · Schedules: the circuit check's fails and warnings (dbCheckResults);
 *   · Single line: each study's fails and warnings (the results panel's own
 *     models), out-of-date studies, the pre-run checks (Components.validate);
 *   · Lighting: rooms, areas, fields and roads that miss their targets;
 *   · the sync pass's questions (Sync.issues);
 *   · Quantities: items with no rate.
 *
 * An issue: { key, sev: 'fail' | 'warn' | 'stale', ws, where, text,
 *   go: a Links address ('sld:<id>', 'retic:<id>', …) or null,
 *   run: a function to go there when there is no address, act / actRun: a
 *   button of its own (Re-run, Set rates) }.
 * The list is worked out a moment after an edit or a result (kick) and every
 * few seconds while the page is on screen (results that arrive in the
 * background: ADMD, street lighting, the circuit check, lighting); the
 * results panel's Issues tab, the header button and the Overview read it.
 */

const Issues = {
  PER_SOURCE: 25,        // a source lists at most this many, then "N more"
  POLL_MS: 3000,
  _list: null,
  _sig: '',
  _timer: null,
  _edits: 0,             // bumped on every edit: the BOQ is re-priced only after one
  _boq: null,            // { edits, n }

  init() {
    if (typeof document === 'undefined' || this._init) return;
    this._init = true;
    const btn = document.getElementById('btn-issues');
    if (btn) btn.addEventListener('click', () => this.open());
    setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh();
    }, this.POLL_MS);
    this.kick();
  },

  // Something changed: work the list out again once things settle.
  kick() {
    if (typeof setTimeout === 'undefined') return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.refresh(); }, 400);
  },
  onEdit() { this._edits++; this.kick(); },

  list() {
    if (!this._list) this._list = this.collect();
    return this._list;
  },
  counts(list = this.list()) {
    const n = { fail: 0, warn: 0, stale: 0 };
    for (const i of list) n[i.sev] = (n[i.sev] || 0) + 1;
    return n;
  },
  get(key) { return this.list().find(i => i.key === key) || null; },

  // Work the list out; redraw what shows it only when it changed.
  refresh() {
    let list;
    try { list = this.collect(); } catch (e) { console.error('Issues: could not collect', e); return; }
    this._list = list;
    const sig = list.map(i => `${i.sev}|${i.key}|${i.text}`).join('\n');
    if (sig === this._sig) return;
    this._sig = sig;
    this.renderBadge();
    if (typeof ResultsPanel !== 'undefined' && ResultsPanel.render) ResultsPanel.render(true);
    if (typeof Overview !== 'undefined' && Overview._active) Overview.render();
    if (typeof MobileUI !== 'undefined' && MobileUI.onIssues) MobileUI.onIssues();
  },

  renderBadge() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('btn-issues');
    if (!btn) return;
    const n = this.counts();
    const total = n.fail + n.warn;
    btn.hidden = !total;
    btn.classList.toggle('issues-fail', n.fail > 0);
    const c = btn.querySelector('.issues-n');
    if (c) c.textContent = String(total);
    const w = btn.querySelector('.issues-w');
    if (w) w.textContent = total === 1 ? 'issue' : 'issues';
    btn.title = `${n.fail} fail · ${n.warn} warning${n.warn === 1 ? '' : 's'}${n.stale ? ` · ${n.stale} out of date` : ''} — open the Issues list`;
  },

  // The header button: the results panel on its Issues tab, from any workspace.
  open() {
    if (typeof ResultsPanel !== 'undefined') ResultsPanel.openIssues();
  },

  // Go to an issue's item (with ← Back to where the user was).
  go(key) {
    const i = this.get(key);
    if (!i) return false;
    const here = typeof window !== 'undefined' && window.activeWorkspace;
    const back = here && here !== 'sld' ? 'tab:' + here : null;
    if (i.go && typeof Links !== 'undefined') return Links.go(i.go, back);
    if (i.run) {
      i.run();
      if (back && typeof Links !== 'undefined' && Links._showBack) Links._showBack(back);
      return true;
    }
    if (typeof window !== 'undefined' && window.switchWorkspace && i.ws) window.switchWorkspace(i.ws);
    return true;
  },
  act(key) {
    const i = this.get(key);
    if (i && i.actRun) i.actRun();
  },

  // ── The list ──────────────────────────────────────────────────────────
  _vis(ws) { return typeof Workspaces !== 'undefined' && Workspaces.isVisible(ws); },
  label(ws) {
    if (ws === 'sld') return 'Single line';
    return typeof Workspaces !== 'undefined' ? Workspaces.label(ws) : ws;
  },
  // Workspaces in the order the project shows them.
  order() {
    const vis = typeof Workspaces !== 'undefined' ? Workspaces.visible() : [];
    const all = ['plan', 'retic', 'streetlight', 'sld', 'schedules', 'lighting', 'sports', 'quantities'];
    return vis.filter(w => all.includes(w)).concat(all.filter(w => !vis.includes(w)));
  },

  collect() {
    const out = [];
    const add = (src) => { try { src.call(this, out); } catch (e) { console.error('Issues source failed', e); } };
    add(this._demand);
    add(this._streetlight);
    add(this._schedules);
    add(this._studies);
    add(this._validation);
    add(this._lighting);
    add(this._sync);
    add(this._quantities);
    const rank = { fail: 0, warn: 1, stale: 2 };
    const ord = this.order();
    return out
      .map((x, n) => ({ ...x, n }))
      .sort((a, b) => (ord.indexOf(a.ws) - ord.indexOf(b.ws)) || (rank[a.sev] - rank[b.sev]) || (a.n - b.n))
      .map(({ n, ...x }) => x);
  },

  // A source's items, cut to PER_SOURCE with a "N more" entry that opens its list.
  _capped(out, items, more) {
    out.push(...items.slice(0, this.PER_SOURCE));
    const extra = items.length - this.PER_SOURCE;
    if (extra > 0 && more) out.push(more(extra, items.slice(this.PER_SOURCE)));
  },

  // ── Demand ──
  _demand(out) {
    if (typeof Retic === 'undefined' || !AppState.reticulation || !this._vis('retic')) return;
    const res = AppState.reticResults;
    if (!res) return;
    const byMs = new Map((res.minisubs || []).map(m => [m.minisubId, m]));
    for (const ms of Retic.minisubs || []) {
      const m = byMs.get(ms.id);
      if (!m || !(m.totalKVA > 0)) continue;
      const tx = Retic._minisubTx(ms, m.totalKVA);
      if (tx && tx.util > 100) {
        out.push({ key: 'retic-tx:' + ms.id, sev: 'fail', ws: 'retic', where: ms.name || 'Minisub', go: 'retic:' + ms.id,
          text: `${ms.name || 'Minisub'}: transformer at ${tx.util} % (${Math.round(m.totalKVA)} kVA on ${tx.kva} kVA)` });
      }
    }
    const byK = {};
    for (const kr of res.kiosks || []) byK[kr.kioskId] = kr;
    const lim = Retic.settings.maxFeederVD;
    const feeders = [];
    for (const kr of res.kiosks || []) {
      const cum = Retic._cumulativeFeederVD(kr.kioskId, byK);
      if (cum != null && cum > lim) {
        feeders.push({ key: 'retic-vd:' + kr.kioskId, sev: 'fail', ws: 'retic', where: kr.name || 'Kiosk', go: 'retic:' + kr.kioskId,
          text: `${kr.name || 'Kiosk'}: feeder volt drop ${cum.toFixed(2)} % (limit ${lim} %)` });
      }
    }
    this._capped(out, feeders, (n) => ({ key: 'retic-vd:more', sev: 'fail', ws: 'retic', where: 'Demand', run: () => switchWorkspace('retic'),
      text: `${n} more feeders over the volt-drop limit` }));
    const runLim = Retic.settings.maxRunVD;
    const services = [];
    for (const k of Retic.kiosks || []) {
      for (const e of k.erfs || []) {
        let vc = null;
        try { vc = Retic._vdCalc(e.cableType, Retic._erfDesignCalc(k, e).amps, e.length, Retic._erfIs3ph(k, e)); } catch (_) { vc = null; }
        if (vc && vc.vd > runLim) {
          services.push({ key: 'retic-svd:' + e.id, sev: 'warn', ws: 'retic', where: `${k.name || 'Kiosk'} › erf ${e.erfNumber || ''}`.trim(), go: 'retic:' + e.id,
            text: `Erf ${e.erfNumber || ''} on ${k.name || 'kiosk'}: service volt drop ${vc.vd.toFixed(2)} % (limit ${runLim} %)` });
        }
      }
    }
    this._capped(out, services, (n) => ({ key: 'retic-svd:more', sev: 'warn', ws: 'retic', where: 'Demand', run: () => switchWorkspace('retic'),
      text: `${n} more service cables over the volt-drop limit` }));
    const earth = res.earth;
    if (earth && Array.isArray(earth.kiosks)) {
      const fails = [];
      const why = (item) => {
        const l = item.loop || {}, c = item.ecc || {};
        const bits = [];
        if (l.status === 'fail') bits.push('earth loop too high');
        if (c.status === 'fail') bits.push('earth conductor too small');
        return bits.join(', ') || 'earth check fails';
      };
      for (const k of earth.kiosks) {
        if (Retic._earthStatus(k) === 'fail') fails.push({ key: 'retic-earth:' + k.kioskId, sev: 'fail', ws: 'retic', where: k.name || 'Kiosk', go: 'retic:' + k.kioskId,
          text: `${k.name || 'Kiosk'} feeder: ${why(k)}` });
        for (const e of k.erfs || []) {
          if (Retic._earthStatus(e) === 'fail') fails.push({ key: 'retic-earth:' + e.erfId, sev: 'fail', ws: 'retic', where: `${k.name || 'Kiosk'} › erf ${e.erfNumber || ''}`.trim(), go: 'retic:' + e.erfId,
            text: `Erf ${e.erfNumber || ''} on ${k.name || 'kiosk'}: ${why(e)}` });
        }
      }
      this._capped(out, fails, (n) => ({ key: 'retic-earth:more', sev: 'fail', ws: 'retic', where: 'Demand', run: () => switchWorkspace('retic'),
        text: `${n} more earth-fault checks fail` }));
    }
    // Custom motor loads: the starting check (a fail, or a warning on the dip).
    const motors = res.motorStart && Array.isArray(res.motorStart.motors) ? res.motorStart.motors : [];
    const starts = [];
    for (const m of motors) {
      if (m.status !== 'fail' && m.status !== 'warning') continue;
      starts.push({ key: 'retic-motor:' + m.id, sev: m.status === 'fail' ? 'fail' : 'warn', ws: 'retic',
        where: `${m.supplyName || 'Supply'} › ${m.name}`, go: 'retic:' + m.id,
        text: `${m.name}: ${(m.issues && m.issues[0]) || (m.status === 'fail' ? 'may not start' : 'starting dip too high')}` });
    }
    this._capped(out, starts, (n) => ({ key: 'retic-motor:more', sev: 'warn', ws: 'retic', where: 'Demand', run: () => switchWorkspace('retic'),
      text: `${n} more motors fail or are marginal at starting` }));
  },

  // ── Street lighting ──
  _streetlight(out) {
    if (typeof StreetLight === 'undefined' || !AppState.reticulation || !this._vis('streetlight')) return;
    if (typeof Workspaces !== 'undefined' && !Workspaces.roadCircuitsOn()) return;
    for (const c of StreetLight.circuits || []) {
      const r = StreetLight._results[c.id];
      if (!r || r.pass || !c.poles.length) continue;
      const why = (r.fails || []).map(f => StreetLight.LIMIT_TEXT[f] || f).join(', ');
      out.push({ key: 'sl:' + c.id, sev: 'fail', ws: 'streetlight', where: c.name, go: 'sl:' + c.id,
        text: `${c.name}: fails on ${why || 'its checks'}` });
    }
  },

  // ── Schedules (the circuit check) ──
  _schedules(out) {
    const res = AppState.dbCheckResults;
    if (!res || !Array.isArray(res.ways)) return;
    const items = res.ways.filter(w => w.status === 'fail' || w.status === 'warn')
      .sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1))
      .map(w => ({ key: `way:${w.board_id}/${w.way_id}`, sev: w.status, ws: 'schedules',
        where: `${w.board_name || 'Board'} › way ${w.way}`, go: `way:${w.board_id}/${w.way_id}`,
        text: `${w.board_name || 'Board'} way ${w.way}${w.description ? ` (${w.description})` : ''}: ${(w.messages && w.messages[0]) || (w.status === 'fail' ? 'fails the circuit check' : 'warning')}` }));
    this._capped(out, items, (n, rest) => ({ key: 'way:more', sev: rest.some(x => x.sev === 'fail') ? 'fail' : 'warn', ws: 'schedules', where: 'Schedules',
      run: () => switchWorkspace('schedules'), text: `${n} more ways with a fail or warning` }));
  },

  // The single line with a study's tab open (and its row's part selected).
  _openStudy(k, part) {
    return () => {
      if (typeof window !== 'undefined' && window.switchWorkspace && window.activeWorkspace !== 'sld') window.switchWorkspace('sld');
      ResultsPanel.open(k);
      if (part && AppState.components.has(part)) { ResultsPanel.selectPart(part); ResultsPanel.syncSelection(); }
    };
  },

  // ── Single line: each study's fails, out-of-date studies ──
  _studyCache: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
  _studies(out) {
    if (typeof ResultsPanel === 'undefined' || !AppState.components || !AppState.components.size) return;
    for (const k of ResultsPanel.TABS) {
      if (k === 'issues' || !ResultsPanel.has(k)) continue;
      const label = ResultsPanel.LABELS[k] || k;
      if (ResultsPanel.isStale(k)) {
        const slots = ResultsPanel.SLOTS[k] || [];
        const auto = slots.length && typeof StaleResults !== 'undefined' && slots.every(s => AppState[s] == null || StaleResults.RUNNERS[s]);
        out.push({ key: 'stale:' + k, sev: 'stale', ws: 'sld', where: label, run: this._openStudy(k),
          text: `${label} is out of date after an edit`,
          act: auto ? 'Re-run' : ResultsPanel.SETUP[k] ? 'Run again…' : null,
          actRun: auto ? () => StaleResults.rerun() : ResultsPanel.SETUP[k] ? () => ResultsPanel.SETUP[k]() : null });
        continue;
      }
      const r = ResultsPanel.result(k);
      let rows = r && typeof r === 'object' && this._studyCache ? this._studyCache.get(r) : null;
      if (!rows) {
        const m = ResultsPanel.model(k);
        rows = [];
        const seen = new Set();
        for (const s of (m && m.sections) || []) {
          for (const x of s.rows || []) {
            if (x.status !== 'fail' && x.status !== 'warn') continue;
            const id = `${k}:${s.id}:${x.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({ id, part: x.id, status: x.status, name: x.name, why: (x.reasons && x.reasons[0]) || '' });
          }
        }
        if (r && typeof r === 'object' && this._studyCache) this._studyCache.set(r, rows);
      }
      const items = rows.map(x => ({ key: 'study:' + x.id, sev: x.status, ws: 'sld', where: label,
        run: this._openStudy(k, x.part),
        text: `${x.name}: ${x.why || (x.status === 'fail' ? `fails in ${label.toLowerCase()}` : `warning in ${label.toLowerCase()}`)}` }))
        .sort((a, b) => (a.sev === 'fail' ? 0 : 1) - (b.sev === 'fail' ? 0 : 1));
      this._capped(out, items, (n, rest) => ({ key: `study:${k}:more`, sev: rest.some(x => x.sev === 'fail') ? 'fail' : 'warn', ws: 'sld', where: label,
        run: this._openStudy(k), text: `${n} more in ${label}` }));
    }
  },

  // ── Single line: the pre-run checks ──
  _validation(out) {
    if (typeof Components === 'undefined' || !Components.validate || !AppState.components || !AppState.components.size) return;
    if (!this._vis('sld')) return;
    // A single line that is only boards (a building's schedules) runs no
    // single-line study: its pre-run checks would only say "no buses".
    if (Components.getBuses && !Components.getBuses().length) return;
    const v = Components.validate();
    const items = [];
    const seen = new Set();
    const push = (x, sev) => {
      const key = `check:${sev}:${x.compId || ''}:${x.msg}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ key, sev, ws: 'sld', where: 'Pre-run checks', go: x.compId && AppState.components.has(x.compId) ? 'sld:' + x.compId : null,
        run: () => switchWorkspace('sld'), text: x.msg });
    };
    for (const e of v.errors || []) push(e, 'fail');
    for (const w of v.warnings || []) push(w, 'warn');
    this._capped(out, items, (n) => ({ key: 'check:more', sev: 'warn', ws: 'sld', where: 'Pre-run checks', run: () => switchWorkspace('sld'),
      text: `${n} more pre-run check warnings` }));
  },

  // ── Lighting ──
  lightRows() {
    if (typeof LightingWS === 'undefined' || !AppState.planMarkup) return [];
    const keep = LightingWS.scope;
    LightingWS.scope = 'all';
    try { return LightingWS._items(); } catch (_) { return []; } finally { LightingWS.scope = keep; }
  },
  _lighting(out) {
    const lightingType = typeof Workspaces !== 'undefined' && Workspaces.type() === 'lighting';
    if (this._vis('lighting') || this._vis('sports')) {
      for (const r of this.lightRows()) {
        if (r.verdict !== 'Fail') continue;
        const ws = r.kind === 'sports' && lightingType ? 'sports' : 'lighting';
        out.push({ key: 'light:' + r.id, sev: 'fail', ws, where: `${r.floor ? r.floor + ' › ' : ''}${r.name}`,
          run: () => { switchWorkspace(ws); LightingWS.view = 'plan'; LightingWS.locate(r.id, r.floorId); },
          text: `${r.name}: ${(r.failing && r.failing[0]) || 'misses its targets'}` });
      }
    }
    if (typeof LightOverview !== 'undefined' && typeof RoadLight !== 'undefined' && this._vis('streetlight')) {
      let roads = [];
      try { roads = LightOverview._roadRows(); } catch (_) { roads = []; }
      for (const r of roads) {
        if (r.verdict !== 'Fail') continue;
        out.push({ key: 'road:' + r.id, sev: 'fail', ws: 'streetlight', where: r.name,
          run: r.kind === 'road' ? () => { RoadPlan._selRoad = r.id; StreetLight._view = 'plan'; switchWorkspace('streetlight'); }
            : () => { RoadLight._selId = r.id; StreetLight._view = 'design'; switchWorkspace('streetlight'); },
          text: `${r.name}: misses its lighting class` });
      }
    }
  },

  // ── The sync pass's questions ──
  SYNC_WS: { retic: 'plan', streetlight: 'streetlight', building: 'plan', 'demand-sld': 'retic', 'sld-feeder-ways': 'schedules' },
  _sync(out) {
    if (typeof Sync === 'undefined') return;
    for (const s of Sync.issues || []) {
      let ws = this.SYNC_WS[s.routine] || 'plan';
      let go = null;
      if (/^sl-plan/.test(s.key)) ws = 'plan';
      if (s.key === 'demand-tx-unwired') ws = 'sld';
      const m = /^demand-tx-max:(.+)$/.exec(s.key);
      if (m) go = 'retic:' + m[1];
      out.push({ key: 'sync:' + s.key, sev: 'warn', ws, where: this.label(ws), go, run: () => switchWorkspace(ws),
        text: s.text, act: s.action && s.action.label ? s.action.label : null, actRun: s.action && s.action.run ? s.action.run : null });
    }
  },

  // ── Quantities ──
  _quantities(out) {
    if (typeof BOQ === 'undefined' || !this._vis('quantities')) return;
    const L = AppState.rateLibrary;
    if (!L || !((L.items && Object.keys(L.items).length) || (L.custom && Object.keys(L.custom).length))) return;
    if (!this._boq || this._boq.edits !== this._edits) {
      let n = 0;
      try {
        const av = BOQ.available();
        if (Object.values(av).some(Boolean)) n = BOQ.compute(BOQ._defaultOpts()).missing.length;
      } catch (_) { n = 0; }
      this._boq = { edits: this._edits, n };
    }
    const n = this._boq.n;
    if (!n) return;
    const open = (v) => () => { if (typeof Quantities !== 'undefined') Quantities.open(v); else switchWorkspace('quantities'); };
    out.push({ key: 'boq-norate', sev: 'warn', ws: 'quantities', where: 'Bill of quantities', run: open('boq'),
      text: `${n} BOQ item${n === 1 ? ' has' : 's have'} no rate and ${n === 1 ? 'is' : 'are'} left out of the total`,
      act: 'Set rates', actRun: open('rates') });
  },
};

if (typeof window !== 'undefined') window.Issues = Issues;
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded', () => Issues.init());
if (typeof module !== 'undefined' && module.exports) module.exports = Issues;
