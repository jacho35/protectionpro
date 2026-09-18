/* ProtectionPro — Cable schedules.
 *
 * One row per cable, with the design current, rating, loading and volt drop
 * taken from the results the project already has:
 *
 *   Reticulation  kiosk feeders and erf services from Demand. Ib is the
 *                 diversified subtree current (feeders) or the erf's design
 *                 current (services); VD uses the Demand workspace's own
 *                 functions, so these numbers match its badges exactly.
 *   Building      sub-mains = cables on the single-line diagram (Ib, loading
 *                 and VD from the latest load flow) and final circuits = every
 *                 board's ways from the per-way circuit check (Ib ≤ In ≤ Iz,
 *                 volt drop, ECC, earth-loop Zs).
 *
 * Statuses use the limits set in each workspace. Nothing here is recomputed
 * with different maths — a missing result shows as "—" with a way to run it.
 */

const CableSchedules = {
  tab: null,
  filter: 'all',
  query: '',

  // ── Rows ────────────────────────────────────────────────────────────
  _status(kind, text, why) { return { kind, text, why: why || '' }; },
  _judge(loading, vd, limit) {
    if (loading != null && loading > 100) return this._status('bad', 'Overloaded', `Loading ${loading.toFixed(0)}% of the cable rating`);
    if (vd != null && limit != null && vd > limit) return this._status('bad', `VD over ${limit}%`, `Volt drop ${vd.toFixed(2)}% exceeds the ${limit}% limit`);
    if ((loading != null && loading > 85) || (vd != null && limit != null && vd > 0.85 * limit)) return this._status('amb', 'Near limit', 'Within 15% of a limit');
    return this._status('ok', 'OK');
  },

  reticRows() {
    const R = AppState.reticulation;
    if (!R || !Array.isArray(R.kiosks) || !R.kiosks.length || typeof Retic === 'undefined') return null;
    const res = AppState.reticResults;
    const byId = {};
    if (res && Array.isArray(res.kiosks)) for (const kr of res.kiosks) byId[kr.kioskId] = kr;
    const s = R.settings || {};
    const fLimit = Number(s.maxFeederVD) || null, sLimit = Number(s.maxRunVD) || null;
    const nameOf = (id) => {
      const k = R.kiosks.find(x => x.id === id);
      if (k) return k.name || 'Kiosk';
      const m = (R.minisubs || []).find(x => x.id === id);
      return m ? m.name : (R.minisubs && R.minisubs[0] ? R.minisubs[0].name : 'Source');
    };
    const feeders = [], services = [];
    for (const k of R.kiosks) {
      const kr = byId[k.id];
      const rx = Retic._cableRX(k.feederCable);
      const ib = kr ? (kr.feederA != null ? kr.feederA : kr.currentA) : null;
      const rating = rx ? rx.rating : null;
      const loading = ib != null && rating ? ib / rating * 100 : null;
      const leg = kr ? Retic._legFeederVD(k.id, byId) : null;
      const cum = kr ? Retic._cumulativeFeederVD(k.id, byId) : null;
      let st;
      if (!k.feederCable) st = this._status('gry', 'No cable', 'Choose a feeder cable in Demand');
      else if (!(Number(k.feederLength) > 0)) st = this._status('gry', 'No length', 'Enter the feeder length in Demand');
      else if (!kr) st = this._status('gry', 'No result', 'Demand has not been calculated');
      else st = this._judge(loading, cum, fLimit);
      feeders.push({
        group: 'feeder', ref: `F-${k.name || k.id}`, from: nameOf(k.fedFrom), to: k.name || 'Kiosk', cable: k.feederCable || '',
        length: Number(k.feederLength) || 0, ib, rating, loading, vdLeg: leg, vdCum: cum, status: st,
      });
      for (const e of (k.erfs || [])) {
        const rxs = Retic._cableRX(e.cableType);
        let eib = null, vleg = null;
        try {
          eib = Retic._erfDesignAmps(k, e);
          const vc = Retic._vdCalc(e.cableType, eib, e.length, Retic._erfIs3ph(k, e));
          vleg = vc ? vc.vd : null;
        } catch (err) { /* incomplete erf */ }
        const er = rxs ? rxs.rating : null;
        const el = eib != null && er ? eib / er * 100 : null;
        let es;
        if (!e.cableType) es = this._status('gry', 'No cable', 'Choose a service cable in Demand');
        else if (!(Number(e.length) > 0)) es = this._status('gry', 'No length', 'Enter the service length in Demand');
        else {
          es = this._judge(el, vleg, sLimit);
          // The service itself may be fine while the kiosk feeding it is not.
          if (es.kind === 'ok' && cum != null && fLimit != null && cum > fLimit) {
            es = this._status('amb', 'Feeder over limit', `This service is within ${sLimit}%, but ${k.name || 'its kiosk'} is fed at ${cum.toFixed(2)}% cumulative, over the ${fLimit}% feeder limit`);
          }
        }
        services.push({
          group: 'service', ref: `S-${k.name || k.id}-${e.erfNumber || e.id}`, from: k.name || 'Kiosk', to: `Erf ${e.erfNumber || ''}`.trim(),
          cable: e.cableType || '', length: Number(e.length) || 0, ib: eib, rating: er, loading: el,
          vdLeg: vleg, vdCum: vleg != null && cum != null ? vleg + cum : null, status: es,
        });
      }
    }
    return {
      kind: 'retic', rows: [...feeders, ...services],
      groups: [{ id: 'feeder', label: 'Kiosk feeders', n: feeders.length }, { id: 'service', label: 'Erf services', n: services.length }],
      limits: `Limits: feeder VD ${fLimit}% cumulative · service VD ${sLimit}% (set in Demand)`,
      stale: !res,
    };
  },

  _endName(compId, port) {
    const w = [...AppState.wires.values()].find(x => (x.fromComponent === compId && x.fromPort === port) || (x.toComponent === compId && x.toPort === port));
    if (!w) return '—';
    const other = w.fromComponent === compId ? w.toComponent : w.fromComponent;
    const c = AppState.components.get(other);
    if (!c) return '—';
    if (c.type === 'bus' && c.busOwner) { const o = AppState.components.get(c.busOwner); if (o) return o.props.name || o.id; }
    return c.props.name || c.id;
  },
  _endComp(compId, port) {
    const w = [...AppState.wires.values()].find(x => (x.fromComponent === compId && x.fromPort === port) || (x.toComponent === compId && x.toPort === port));
    if (!w) return null;
    return AppState.components.get(w.fromComponent === compId ? w.toComponent : w.fromComponent) || null;
  },

  buildingRows() {
    const cables = [...AppState.components.values()].filter(c => c.type === 'cable');
    const boards = [...AppState.components.values()].filter(c => c.type === 'distribution_board' && (c.props.circuits || []).length);
    if (!cables.length && !boards.length) return null;
    const lf = AppState.loadFlowResults;
    const br = {};
    if (lf && Array.isArray(lf.branches)) for (const b of lf.branches) br[b.elementId] = b;
    const busV = (id) => lf && lf.buses && lf.buses[id] ? lf.buses[id].voltage_pu : null;
    const routeById = {};
    try { for (const r of AppState.planAllRoutes()) routeById[r.id] = r; } catch (e) { /* no plan */ }
    const subs = cables.map(c => {
      const p = c.props || {};
      const std = p.standard_type && STANDARD_CABLES.find(s => s.id === p.standard_type);
      const linked = routeById[c.planLink] || routeById[c.riserLink];
      const type = std ? std.name : (linked && linked.cableType) || '';
      const par = Math.max(1, Number(p.num_parallel) || 1);
      const b = br[c.id];
      const iz = (Number(p.rated_amps) || 0) * par || null;
      const ib = b ? b.i_amps : null;
      const loading = b ? b.loading_pct : null;
      let vd = null;
      if (b) {
        const vf = busV(b.from_bus), vt = busV(b.to_bus);
        if (vf != null && vt != null) vd = Math.abs(vf - vt) * 100;
      }
      // Protection: the feeder way in the upstream board that feeds this cable's far end.
      const down = this._endComp(c.id, 'to');
      let prot = '';
      if (down) {
        for (const bd of boards) {
          const w = (bd.props.circuits || []).find(x => x.type === 'feeder_db' && x.feedsDbId === down.id);
          if (w) { prot = `${w.breaker_a} A ${w.curve || ''}`.trim(); break; }
        }
      }
      const st = !b ? this._status('gry', 'No result', 'Run a load flow for Ib, loading and VD') : this._judge(loading, vd, 5);
      return {
        group: 'submain', ref: p.name || c.id, from: this._endName(c.id, 'from'), to: this._endName(c.id, 'to'),
        cable: type || (p.name && p.name !== 'Cable' ? p.name : '') || 'No library type', length: (Number(p.length_km) || 0) * 1000 * par,
        par, protection: prot, ib, rating: iz, loading, vdLeg: vd, vdCum: null, status: st,
      };
    });
    const chk = AppState.dbCheckResults;
    const byWay = new Map();
    if (chk && Array.isArray(chk.ways)) for (const w of chk.ways) if (w.way_id) byWay.set(w.way_id, w);
    const finals = [];
    const ST = { pass: ['ok', 'OK'], warn: ['amb', 'Check'], fail: ['bad', 'Fail'], info: ['gry', 'Info'] };
    for (const bd of boards) {
      for (const w of bd.props.circuits) {
        if (w.type === 'feeder_db') continue;
        const r = byWay.get(w.id);
        const s = r ? ST[r.status] || ['gry', r.status] : ['gry', 'Not checked'];
        const why = r ? (r.messages || []).join(' ') : 'Run the circuit check';
        const failOn = r && r.status !== 'pass' ? [r.ampacity_status !== 'pass' && r.ampacity_status !== 'info' ? 'Iz' : '', r.coordination_status !== 'pass' && r.coordination_status !== 'info' ? 'Ib≤In≤Iz' : '', r.vd_status !== 'pass' && r.vd_status !== 'info' ? 'VD' : '', r.ecc_status !== 'pass' && r.ecc_status !== 'info' ? 'ECC' : '', r.zs_status !== 'pass' && r.zs_status !== 'info' ? 'Zs' : ''].filter(Boolean).join(', ') : '';
        finals.push({
          group: 'final', board: bd.props.name || bd.id, way: String(w.way || ''), ref: `${bd.props.name || bd.id} / ${w.way}`,
          desc: w.description || '', breaker: `${w.breaker_a} A ${w.curve || ''}`.trim(), poles: w.poles,
          cable: Rates.fcCable(w.cable_mm2, w.poles).desc, mm2: w.cable_mm2, ecc: w.ecc_mm2, length: Number(w.cable_m) || 0,
          ib: r ? r.ib_a : null, rating: r ? r.iz_derated_a : null, loading: r && r.iz_derated_a ? r.ib_a / r.iz_derated_a * 100 : null,
          vdLeg: r ? r.vd_pct : null, vdCum: r ? (r.vd_total_pct != null ? r.vd_total_pct : null) : null, zs: r ? r.zs_ohm : null,
          status: this._status(s[0], failOn ? `${s[1]}: ${failOn}` : s[1], why),
        });
      }
    }
    return {
      kind: 'building', rows: [...subs, ...finals],
      groups: [{ id: 'submain', label: 'Sub-mains', n: subs.length }, { id: 'final', label: 'Final circuits', n: finals.length }],
      limits: 'Checks: Ib ≤ In ≤ Iz, volt drop and earth-loop Zs from the per-way circuit check; sub-mains from the load flow',
      noLf: cables.length && !lf, noChk: finals.length && !chk,
    };
  },

  // ── Dialog ─────────────────────────────────────────────────────────
  async open() {
    this._ensureDom();
    const m = document.getElementById('cables-modal');
    m.style.display = 'flex';
    const rs = this.reticRows(), bs = this.buildingRows();
    this.tab = AppState.projectType === 'building' ? (bs ? 'building' : 'retic') : (rs ? 'retic' : 'building');
    this.filter = 'all';
    this.render();
    // Demand results are cheap and server-side: refresh them so the schedule
    // matches the current inputs.
    if (rs && typeof Retic !== 'undefined' && Retic._doCompute) {
      try { await Retic._doCompute(); } catch (e) { /* offline — show what we have */ }
      this.render();
    }
  },
  close() { const m = document.getElementById('cables-modal'); if (m) m.style.display = 'none'; },

  _ensureDom() {
    if (document.getElementById('cables-modal')) return;
    const I = (p, s = 16) => Rates._icon(p, s);
    const I_CAB = I('<path d="M2 5h5a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h3"/><circle cx="2.5" cy="5" r="1"/><circle cx="13.5" cy="11" r="1"/>', 18);
    const I_DOWN = I('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"/>', 14);
    const I_SEARCH = I('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>', 14);
    const m = document.createElement('div');
    m.id = 'cables-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'cs-title');
    m.style.display = 'none';
    m.innerHTML = `
    <div class="modal-content rt-dialog cs-dialog">
      <header class="rt-head">
        <span class="rt-mark cs-mark">${I_CAB}</span>
        <div class="rt-head-text"><h3 id="cs-title">Cable schedules</h3><div class="rt-head-sub" id="cs-sub"></div></div>
        <span class="rt-tag">Design current and volt drop from the latest results</span>
        <button class="modal-close" data-cs="close" aria-label="Close">&times;</button>
      </header>
      <main class="rt-main">
        <div class="rt-bar"><div class="rt-tabs" role="tablist" aria-label="Schedule" id="cs-tabs"></div></div>
        <div class="rt-bar">
          <div class="rt-seg" role="group" aria-label="Show" id="cs-seg"></div>
          <label class="rt-search">${I_SEARCH}<input type="text" id="cs-q" placeholder="Filter by name, board or cable…" aria-label="Filter cables"></label>
          <span class="rt-grow"></span><span class="rt-note-i" id="cs-limits"></span>
        </div>
        <div id="cs-banner"></div>
        <div class="cs-body" id="cs-body"></div>
      </main>
      <footer class="rt-foot">
        <span class="rt-note-i">Rows update from the project each time this opens · statuses use the limits set in each workspace</span>
        <span class="rt-grow"></span>
        <button type="button" class="rt-btn" data-cs="csv">${I_DOWN}CSV</button>
        <button type="button" class="rt-btn" data-cs="xlsx">${I_DOWN}Excel</button>
        <button type="button" class="rt-btn primary" data-cs="pdf">${I_DOWN}PDF</button>
      </footer>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cs]');
      if (!b) { if (e.target === m) this.close(); return; }
      const a = b.dataset.cs;
      if (a === 'close') this.close();
      else if (a === 'tab') { this.tab = b.dataset.v; this.filter = 'all'; this.render(); }
      else if (a === 'filter') { this.filter = b.dataset.v; this.render(); }
      else if (a === 'csv' || a === 'xlsx') this.exportFile(a);
      else if (a === 'pdf') this.exportPDF();
      else if (a === 'run-check') {
        b.disabled = true; b.textContent = 'Checking…';
        try { await DBSchedule.runCheck(); } catch (err) { UI.toast('The circuit check failed: ' + err.message, 'error'); }
        this.render();
      }
    });
    m.querySelector('#cs-q').addEventListener('input', (e) => { this.query = e.target.value; this.renderBody(); });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
  },

  _data() { return this.tab === 'retic' ? this.reticRows() : this.buildingRows(); },

  render() {
    const m = document.getElementById('cables-modal');
    if (!m) return;
    const rs = this.reticRows(), bs = this.buildingRows();
    const tabs = [['retic', 'Reticulation', rs], ['building', 'Building', bs]].filter(t => t[2]);
    m.querySelector('#cs-sub').textContent = AppState.projectName || 'Untitled project';
    m.querySelector('#cs-tabs').innerHTML = tabs.length ? tabs.map(([id, label, d]) =>
      `<button type="button" class="rt-tab${this.tab === id ? ' on' : ''}" role="tab" aria-selected="${this.tab === id}" data-cs="tab" data-v="${id}">${label} <span class="rt-n">${d.rows.length}</span></button>`).join('') : '';
    this._cur = this.tab === 'retic' ? rs : bs;
    this.renderBody();
  },

  _problem(r) { return r.status && (r.status.kind === 'bad' || r.status.kind === 'amb'); },

  renderBody() {
    const m = document.getElementById('cables-modal');
    const d = this._cur;
    const body = m.querySelector('#cs-body');
    if (!d) {
      m.querySelector('#cs-seg').innerHTML = '';
      m.querySelector('#cs-limits').textContent = '';
      m.querySelector('#cs-banner').innerHTML = '';
      body.innerHTML = '<div class="rt-empty">No cables yet. Add kiosk feeders and erf services in Demand, cables on the single-line diagram, or ways in a DB schedule.</div>';
      return;
    }
    const probs = d.rows.filter(r => this._problem(r)).length;
    const segs = [['all', `All (${d.rows.length})`], ...d.groups.map(g => [g.id, `${g.label} (${g.n})`]), ['problems', `Problems (${probs})`]];
    m.querySelector('#cs-seg').innerHTML = segs.map(([v, l]) => `<button type="button" class="rt-sg${this.filter === v ? ' on' : ''}" aria-pressed="${this.filter === v}" data-cs="filter" data-v="${v}">${l}</button>`).join('');
    m.querySelector('#cs-limits').textContent = d.limits;
    const banners = [];
    if (d.stale) banners.push('Demand has not been calculated yet, so design currents and volt drops are blank. Open the Demand workspace to calculate.');
    if (d.noLf) banners.push('No load flow result yet: sub-main current, loading and volt drop are blank. Run a load flow from Analyse.');
    if (d.noChk) banners.push('The circuit check has not been run: final-circuit Ib, Iz and volt drop are blank. <button type="button" class="rt-lk" data-cs="run-check">Run the circuit check</button>');
    m.querySelector('#cs-banner').innerHTML = banners.map(b => `<div class="rt-banner warn">${b}</div>`).join('');

    const q = this.query.trim().toLowerCase();
    const vis = d.rows.filter(r => this.filter === 'all' || (this.filter === 'problems' ? this._problem(r) : r.group === this.filter))
      .filter(r => !q || [r.ref, r.from, r.to, r.cable, r.board, r.desc].some(x => x && String(x).toLowerCase().includes(q)));
    const f = (v, n = 1) => v == null || isNaN(v) ? '—' : Number(v).toFixed(n);
    const pill = s => `<span class="rt-pill ${s.kind}" title="${escHtml(s.why)}">${escHtml(s.text)}</span>`;
    const bar = (p) => {
      if (p == null) return '—';
      const col = p > 100 ? 'var(--danger)' : p > 85 ? 'var(--warning)' : 'var(--success)';
      return `<span class="cs-lbar"><i style="width:${Math.min(p, 100)}%;background:${col}"></i></span>${p.toFixed(0)}%`;
    };
    let html = '';
    if (d.kind === 'retic') {
      const rows = (g) => vis.filter(r => r.group === g).map(r => `<tr><td class="rt-code">${escHtml(r.ref)}</td><td>${escHtml(r.from)}</td><td>${escHtml(r.to)}</td><td title="${escHtml(r.cable || '')}">${escHtml(r.cable || '—')}</td>
        <td class="rt-num">${f(r.length, 0)}</td><td class="rt-num">${f(r.ib)}</td><td class="rt-num">${f(r.rating, 0)}</td><td>${bar(r.loading)}</td>
        <td class="rt-num">${r.vdLeg == null ? '—' : f(r.vdLeg, 2) + '%'}</td><td class="rt-num"><b>${r.vdCum == null ? '—' : f(r.vdCum, 2) + '%'}</b></td><td>${pill(r.status)}</td></tr>`).join('');
      const head = '<thead><tr><th style="width:120px">Ref</th><th>From</th><th>To</th><th style="width:170px">Cable</th><th class="rt-num" style="width:78px">Length (m)</th><th class="rt-num" style="width:84px">Design I (A)</th><th class="rt-num" style="width:78px">Rating (A)</th><th style="width:120px">Loading</th><th class="rt-num" style="width:70px">VD leg</th><th class="rt-num" style="width:78px">VD cum.</th><th style="width:110px">Status</th></tr></thead>';
      const fr = rows('feeder'), sr = rows('service');
      html = `<table class="rt-tbl rt-ro-tbl bq-tbl cs-tbl">${head}<tbody>${fr ? `<tr class="bq-grp"><td colspan="11">Kiosk feeders</td></tr>${fr}` : ''}${sr ? `<tr class="bq-grp"><td colspan="11">Erf services</td></tr>${sr}` : ''}${!fr && !sr ? '<tr><td colspan="11" class="rt-empty-row">Nothing matches the filter.</td></tr>' : ''}</tbody></table>`;
    } else {
      const sm = vis.filter(r => r.group === 'submain').map(r => `<tr><td class="rt-code">${escHtml(r.ref)}</td><td>${escHtml(r.from)}</td><td>${escHtml(r.to)}</td><td title="${escHtml(r.cable)}">${escHtml(r.cable)}${r.par > 1 ? ` <span class="rt-note-i">×${r.par}</span>` : ''}</td>
        <td class="rt-num">${f(r.length, 0)}</td><td>${escHtml(r.protection || '—')}</td><td class="rt-num">${f(r.ib)}</td><td class="rt-num">${f(r.rating, 0)}</td><td>${bar(r.loading)}</td><td class="rt-num">${r.vdLeg == null ? '—' : f(r.vdLeg, 2) + '%'}</td><td>${pill(r.status)}</td></tr>`).join('');
      const fc = vis.filter(r => r.group === 'final').map(r => `<tr><td>${escHtml(r.board)}</td><td class="rt-num">${escHtml(r.way)}</td><td title="${escHtml(r.desc)}">${escHtml(r.desc || '—')}</td><td>${escHtml(r.breaker)}</td>
        <td class="rt-num">${f(r.mm2, r.mm2 % 1 ? 1 : 0)}</td><td class="rt-num">${r.ecc == null ? '—' : f(r.ecc, r.ecc % 1 ? 1 : 0)}</td><td class="rt-num">${f(r.length, 0)}</td><td class="rt-num">${f(r.ib)}</td><td class="rt-num">${f(r.rating)}</td>
        <td class="rt-num">${r.vdCum != null ? f(r.vdCum, 2) + '%' : r.vdLeg != null ? f(r.vdLeg, 2) + '%' : '—'}</td><td>${pill(r.status)}</td></tr>`).join('');
      if (sm) html += `<div class="bq-sh cs-sh">Sub-mains — from the single-line diagram</div><table class="rt-tbl rt-ro-tbl bq-tbl cs-tbl"><thead><tr><th style="width:110px">Ref</th><th>From</th><th>To</th><th style="width:170px">Cable</th><th class="rt-num" style="width:78px">Length (m)</th><th style="width:90px">Protection</th><th class="rt-num" style="width:70px">Ib (A)</th><th class="rt-num" style="width:70px">Iz (A)</th><th style="width:120px">Loading</th><th class="rt-num" style="width:70px">VD</th><th style="width:110px">Status</th></tr></thead><tbody>${sm}</tbody></table>`;
      if (fc) html += `<div class="bq-sh cs-sh">Final circuits — every board’s schedule</div><table class="rt-tbl rt-ro-tbl bq-tbl cs-tbl"><thead><tr><th style="width:110px">Board</th><th class="rt-num" style="width:48px">Way</th><th>Description</th><th style="width:80px">Breaker</th><th class="rt-num" style="width:70px">Live mm²</th><th class="rt-num" style="width:70px">ECC mm²</th><th class="rt-num" style="width:78px">Length (m)</th><th class="rt-num" style="width:64px">Ib (A)</th><th class="rt-num" style="width:64px">Iz (A)</th><th class="rt-num" style="width:70px">VD</th><th style="width:180px">Status</th></tr></thead><tbody>${fc}</tbody></table>`;
      if (!sm && !fc) html = '<div class="rt-empty">Nothing matches the filter.</div>';
    }
    // Side: worst VD + measured length by cable type.
    const tot = new Map();
    for (const r of d.rows) if (r.cable && r.length) tot.set(r.cable, (tot.get(r.cable) || 0) + r.length);
    const worst = d.rows.filter(r => (r.vdCum ?? r.vdLeg) != null).sort((a, b) => (b.vdCum ?? b.vdLeg) - (a.vdCum ?? a.vdLeg))[0];
    const side = `<aside class="cs-side">
      ${worst ? `<div class="bq-stat"><span class="k">Worst ${worst.vdCum != null ? 'cumulative ' : ''}VD</span><span class="v ${worst.status.kind === 'bad' ? 'rt-bad' : worst.status.kind === 'amb' ? 'rt-amb' : ''}">${f(worst.vdCum ?? worst.vdLeg, 2)}%</span><span class="rt-note-i">${escHtml(worst.to || worst.ref)}${worst.from ? ' via ' + escHtml(worst.from) : ''}</span></div>` : ''}
      <table class="rt-tbl rt-ro-tbl"><thead><tr><th>Totals by cable</th><th class="rt-num" style="width:80px">Length</th></tr></thead><tbody>
      ${[...tot.entries()].sort((a, b) => b[1] - a[1]).map(([c, l]) => `<tr><td title="${escHtml(c)}">${escHtml(c)}</td><td class="rt-num">${Rates._group(Math.round(l).toString())} m</td></tr>`).join('') || '<tr><td colspan="2" class="rt-empty-row">—</td></tr>'}</tbody></table>
      <div class="rt-note">Totals here are measured lengths. The Bill of quantities adds each item’s waste %.</div></aside>`;
    body.innerHTML = `<div class="rt-tablewrap cs-wrap">${html}</div>${side}`;
  },

  // ── Export ─────────────────────────────────────────────────────────
  _aoa() {
    const d = this._cur;
    if (!d) return [];
    const n = (v, k = 2) => v == null || isNaN(v) ? '' : +Number(v).toFixed(k);
    if (d.kind === 'retic') {
      const rows = [['Type', 'Ref', 'From', 'To', 'Cable', 'Length (m)', 'Design I (A)', 'Rating (A)', 'Loading %', 'VD leg %', 'VD cumulative %', 'Status']];
      for (const r of d.rows) rows.push([r.group === 'feeder' ? 'Feeder' : 'Service', r.ref, r.from, r.to, r.cable, n(r.length, 1), n(r.ib), n(r.rating, 0), n(r.loading, 1), n(r.vdLeg), n(r.vdCum), r.status.text]);
      return rows;
    }
    const rows = [['Type', 'Ref / Board', 'Way', 'From / Description', 'To', 'Cable', 'Live mm²', 'ECC mm²', 'Length (m)', 'Protection', 'Ib (A)', 'Iz (A)', 'Loading %', 'VD %', 'Status', 'Notes']];
    for (const r of d.rows) {
      if (r.group === 'submain') rows.push(['Sub-main', r.ref, '', r.from, r.to, r.cable + (r.par > 1 ? ` ×${r.par}` : ''), '', '', n(r.length, 1), r.protection, n(r.ib), n(r.rating, 0), n(r.loading, 1), n(r.vdLeg), r.status.text, r.status.why]);
      else rows.push(['Final circuit', r.board, r.way, r.desc, '', r.cable, n(r.mm2), n(r.ecc), n(r.length, 1), r.breaker, n(r.ib), n(r.rating), n(r.loading, 1), n(r.vdCum ?? r.vdLeg), r.status.text, r.status.why]);
    }
    return rows;
  },
  _fname(ext) {
    const base = (AppState.projectName || 'project').replace(/[^\w-]+/g, '_');
    return `${base}_cable_schedule_${this.tab}.${ext}`;
  },
  exportFile(kind) {
    const rows = this._aoa();
    if (!rows.length) { UI.toast('No cables to export.', 'info'); return; }
    if (kind === 'csv') {
      const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url; a.download = this._fname('csv');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      if (typeof XLSX === 'undefined') { UI.toast('The Excel library did not load. Export CSV instead.', 'error'); return; }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = rows[0].map((h, i) => ({ wch: i === 3 || i === 5 ? 30 : Math.max(9, String(h).length + 2) }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Cable schedule');
      XLSX.writeFile(wb, this._fname('xlsx'));
    }
  },
  async exportPDF() {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const rows = this._aoa();
    if (!rows.length) { UI.toast('No cables to export.', 'info'); return; }
    const d = this._cur;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const margin = 12;
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text(`Cable schedule — ${d.kind === 'retic' ? 'reticulation' : 'building'}`, margin, margin + 4);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${AppState.projectName || 'Untitled Project'}    Date: ${new Date().toLocaleDateString()}`, margin, margin + 11);
    doc.text(d.limits, margin, margin + 16);
    const statusCol = rows[0].indexOf('Status');
    const body = d.kind === 'building' ? rows.slice(1).map(r => r.slice(0, -1)) : rows.slice(1);
    const head = d.kind === 'building' ? rows[0].slice(0, -1) : rows[0];
    doc.autoTable({
      startY: margin + 21,
      margin: { left: margin, right: margin },
      head: [head], body,
      styles: { fontSize: 7, cellPadding: 1.2 },
      headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      didParseCell: (c) => {
        if (c.section !== 'body' || c.column.index !== statusCol) return;
        const t = String(c.cell.raw || '');
        if (/^(Fail|Overloaded|VD over)/.test(t)) c.cell.styles.textColor = [200, 30, 30];
        else if (/^(Check|Near)/.test(t)) c.cell.styles.textColor = [200, 110, 0];
      },
    });
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`ProtectionPro · Cable schedule · page ${i} of ${pages}`, margin, 204);
      doc.setTextColor(0);
    }
    doc.save(this._fname('pdf'));
  },
};
