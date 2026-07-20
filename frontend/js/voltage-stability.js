/* ProtectionPro — Voltage Stability (P-V / Q-V) UI.
 *
 * Setup modal (Q-V bus, λ step / cap, collapse floor) → backend
 * /analysis/voltage-stability → results modal with a P-V nose-curve chart
 * (bus voltage vs total demand), a Q-V reactive-margin chart at the critical
 * bus, the loadability-margin / collapse verdict, and data tables.
 *
 * Results are on-demand (not persisted with the project) — re-run after edits.
 */
const VoltageStability = {
  _result: null,
  _cfg: { qv_bus_id: '', step: 0.1, lambda_max: 4.0, v_floor: 0.4 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _palette(dark) {
    if (typeof Transient !== 'undefined' && Transient._palette) return Transient._palette(dark);
    return {
      pool: dark ? ['#3987e5', '#199e70', '#c98500', '#9085e9', '#d95926', '#4bb3c4', '#c65b9a']
                 : ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#eb6834', '#2f97a8', '#b83f86'],
      grid: dark ? '#34344a' : '#e4e4ea', axis: dark ? '#3a3a50' : '#d0d0d0',
      tickText: dark ? '#a0a0b0' : '#6d6d6d', ink: dark ? '#e0e0e8' : '#1a1a2e',
      inkSec: dark ? '#a0a0b0' : '#555',
    };
  },

  _buses() {
    return [...AppState.components.values()]
      .filter(c => c.type === 'bus' || c.type === 'distribution_board')
      .map(c => ({ id: c.id, name: c.props?.name || c.id }));
  },

  // ── Setup ──────────────────────────────────────────────────────────
  openConfig() {
    const buses = this._buses();
    if (!buses.length) {
      document.getElementById('status-info').textContent =
        'Add buses and a source before running voltage stability.';
      return;
    }
    const c = this._cfg;
    const opt = arr => arr.map(o =>
      `<option value="${this._esc(o.id)}"${o.id === c.qv_bus_id ? ' selected' : ''}>${this._esc(o.name)}</option>`).join('');
    const body = document.getElementById('vstab-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Scales all loads uniformly (constant power factor) and re-solves the load
        flow to trace the <strong>P-V nose curve</strong> and find the voltage-collapse
        point. A <strong>Q-V curve</strong> at the weakest (or chosen) bus gives the
        reactive-power margin.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="vstab-qvbus">Q-V bus</label>
        <select id="vstab-qvbus"><option value="">Auto — weakest bus</option>${opt(buses)}</select>
        <label for="vstab-step">λ step</label>
        <input id="vstab-step" type="number" min="0.02" max="1" step="0.05" value="${c.step}">
        <label for="vstab-lmax">λ max (cap)</label>
        <input id="vstab-lmax" type="number" min="1.5" max="20" step="0.5" value="${c.lambda_max}">
        <label for="vstab-floor">Collapse floor (p.u.)</label>
        <input id="vstab-floor" type="number" min="0.1" max="0.9" step="0.05" value="${c.v_floor}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:12px 0 0">
        λ = 1 is the present demand. The sweep steps λ up to the cap; the collapse
        point is refined by bisection. If no collapse is reached by the cap, the
        margin is reported as a lower bound — raise λ max.</p>`;
    document.getElementById('vstab-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      qv_bus_id: v('vstab-qvbus').value || '',
      step: parseFloat(v('vstab-step').value) || 0.1,
      lambda_max: parseFloat(v('vstab-lmax').value) || 4.0,
      v_floor: parseFloat(v('vstab-floor').value) || 0.4,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('vstab-config-modal').style.display = 'none';
    const label = 'Running voltage stability (P-V continuation)…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runVoltageStability({
        qvBusId: c.qv_bus_id, step: c.step, lambdaMax: c.lambda_max, vFloor: c.v_floor,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.collapsed
        ? `Voltage stability: collapse at +${result.loading_margin_pct.toFixed(0)}% load`
        : 'Voltage stability complete (no collapse within λ cap).';
    } catch (e) {
      console.error('Voltage stability error:', e);
      document.getElementById('status-info').textContent = 'Voltage stability failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Voltage Stability — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('vstab-modal');
    const body = document.getElementById('vstab-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _render(body) {
    const r = this._result || {};
    let html = '';
    if ((r.warnings || []).length) {
      html += '<div class="af-warnings">' + r.warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!r.converged) {
      body.innerHTML = html + `<p style="color:#c62828"><strong>Base case does not solve.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }

    // Verdict banner
    const col = r.collapsed ? '#c62828' : '#2e7d32';
    const verdict = r.collapsed
      ? `Voltage collapse at λ = ${r.lambda_critical.toFixed(3)}`
      : `No collapse up to λ = ${(r.lam[r.lam.length - 1] || 0).toFixed(2)}`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <div><span style="font-weight:700;color:${col}">${this._esc(verdict)}</span>
        <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${this._esc(r.note || '')}</span></div>
      <div style="font-size:12px;text-align:right">
        Loadability margin: <strong>${r.collapsed ? '' : '≥ '}+${r.loading_margin_pct.toFixed(0)}%</strong><br>
        <span style="color:var(--text-muted,#6d6d6d)">${r.base_load_mw.toFixed(2)} → ${r.critical_load_mw.toFixed(2)} MW</span>
      </div>
    </div>`;

    // Summary chips
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px 14px;font-size:12px;margin-bottom:12px">'
      + `<div><strong>Critical bus</strong><br><span style="color:var(--text-muted,#6d6d6d)">${this._esc(r.critical_bus_name || '—')} @ ${r.nose_v_pu.toFixed(3)} p.u.</span></div>`
      + `<div><strong>λ critical</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.lambda_critical.toFixed(3)}${r.collapsed ? '' : ' (≥, capped)'}</span></div>`
      + (r.qv_bus_name ? `<div><strong>Q-V margin (${this._esc(r.qv_bus_name)})</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.qv_margin_mvar != null ? r.qv_margin_mvar.toFixed(2) + ' MVAr' : (r.qv_min_mvar != null ? r.qv_min_mvar.toFixed(2) + ' MVAr (net-injection min)' : '—')}</span></div>` : '')
      + '</div>';

    html += `<div class="vs-chart" data-chart="pv"></div>`;
    if (r.qv_curve && r.qv_curve.length) html += `<div class="vs-chart" data-chart="qv"></div>`;
    html += this._tables(r);
    body.innerHTML = html;
    this._hydrate(body, r);
  },

  _tables(r) {
    // P-V table (weakest-bus voltage vs total demand)
    let pv = '';
    for (let i = 0; i < r.lam.length; i++) {
      pv += `<tr><td>${r.lam[i].toFixed(3)}</td><td>${r.load_mw[i].toFixed(2)}</td><td>${r.min_v_pu[i].toFixed(3)}</td></tr>`;
    }
    let out = `<details style="font-size:11px;margin-top:8px"><summary style="cursor:pointer">P-V data (weakest bus)</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
      <thead><tr><th>λ</th><th>Load (MW)</th><th>Min V (p.u.)</th></tr></thead><tbody>${pv}</tbody></table></div></details>`;
    if (r.qv_curve && r.qv_curve.length) {
      const qv = r.qv_curve.map(p => `<tr><td>${p.v_pu.toFixed(3)}</td><td>${p.q_mvar.toFixed(2)}</td></tr>`).join('');
      out += `<details style="font-size:11px;margin-top:6px"><summary style="cursor:pointer">Q-V data (${this._esc(r.qv_bus_name)})</summary>
        <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
        <thead><tr><th>V (p.u.)</th><th>Q required (MVAr)</th></tr></thead><tbody>${qv}</tbody></table></div></details>`;
    }
    return out;
  },

  _hydrate(root, r) {
    const dark = document.body.classList.contains('dark-mode');
    const P = this._palette(dark);

    // P-V: bus voltage vs total demand (MW). Cap the series count; always keep
    // the critical bus.
    const MAX = 9;
    let curves = r.bus_curves || [];
    if (curves.length > MAX) {
      const crit = curves.filter(c => c.is_critical);
      const rest = curves.filter(c => !c.is_critical).slice(0, MAX - crit.length);
      curves = crit.concat(rest);
    }
    const pvSeries = curves.map((bc, i) => ({
      name: bc.bus_name + (bc.is_critical ? ' ◆' : ''),
      values: bc.v_pu,
      color: bc.is_critical ? (dark ? '#ff5b5b' : '#c62828') : P.pool[i % P.pool.length],
      width: bc.is_critical ? 2.6 : 1.6,
      fmt: v => (v == null ? '—' : v.toFixed(3) + ' p.u.'),
    }));

    const charts = {
      pv: {
        title: 'P-V nose curve — bus voltage vs total demand',
        xLabel: 'Total load (MW)', yLabel: 'p.u.', xs: r.load_mw, series: pvSeries,
        markers: r.collapsed ? [{ x: r.critical_load_mw, label: 'collapse', color: dark ? '#ff5b5b' : '#c62828', dashed: true }] : [],
      },
    };
    if (r.qv_curve && r.qv_curve.length) {
      const xs = r.qv_curve.map(p => p.v_pu);
      charts.qv = {
        title: `Q-V reactive-margin curve — ${this._esc(r.qv_bus_name)}`,
        xLabel: 'Bus voltage (p.u.)', yLabel: 'MVAr', xs,
        series: [{ name: 'Q required', values: r.qv_curve.map(p => p.q_mvar),
                   color: P.pool[0], width: 2.2, fmt: v => v.toFixed(2) + ' MVAr' }],
        markers: [{ x: 0, label: '', y0: true }],  // emphasise Q=0 axis via chart
        qvMarkV: r.qv_operating_v_pu,
      };
    }
    root.querySelectorAll('.vs-chart').forEach(el => {
      const spec = charts[el.dataset.chart];
      if (spec && spec.series.length) this._chart(el, spec, P);
    });
  },

  _niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    for (const mult of [1, 2, 2.5, 5, 10]) if (raw <= mult * mag) return mult * mag;
    return 10 * mag;
  },

  // Generic multi-series line chart over an arbitrary x-array; tolerates null
  // gaps in a series (a de-energized bus at that λ).
  _chart(container, spec, P) {
    const W = 660, H = 240, padL = 52, padR = 116, padT = 26, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xs = spec.xs, n = xs.length;
    if (!n) return;
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const xLo = xMin, xHi = xMax > xLo ? xMax : xLo + 1e-9;
    let yMin = Infinity, yMax = -Infinity;
    for (const s of spec.series) for (const v of s.values) {
      if (v == null) continue;
      if (v < yMin) yMin = v; if (v > yMax) yMax = v;
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
    const X = v => padL + (v - xLo) / (xHi - xLo) * plotW;
    const Y = v => padT + plotH - (v - yMin) / (yMax - yMin) * plotH;

    let g = '';
    const yStep = this._niceStep(yMax - yMin, 4);
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
      const y = Y(v);
      g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${P.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    const xStep = this._niceStep(xHi - xLo, 6);
    for (let v = Math.ceil(xLo / xStep) * xStep; v <= xHi + 1e-9; v += xStep) {
      g += `<text x="${X(v)}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    if (yMin < 0 && yMax > 0) {
      g += `<line x1="${padL}" y1="${Y(0)}" x2="${W - padR}" y2="${Y(0)}" stroke="${P.axis}" stroke-width="1.2"/>`;
    }
    (spec.markers || []).forEach((mk) => {
      if (mk.y0) return;
      if (mk.x == null || mk.x < xLo || mk.x > xHi) return;
      const x = X(mk.x);
      g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${mk.color || P.tickText}" stroke-width="1.2" opacity="0.7"${mk.dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
      if (mk.label) g += `<text x="${x - 3}" y="${padT + 10}" text-anchor="end" font-size="8" fill="${mk.color || P.tickText}">${this._esc(mk.label)}</text>`;
    });
    if (spec.qvMarkV != null && spec.qvMarkV >= xLo && spec.qvMarkV <= xHi) {
      const x = X(spec.qvMarkV);
      g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${P.inkSec}" stroke-width="1" opacity="0.6" stroke-dasharray="3 2"/>`;
      g += `<text x="${x + 3}" y="${padT + 10}" font-size="8" fill="${P.inkSec}">operating V</text>`;
    }
    // Series polylines (split on null gaps)
    for (const s of spec.series) {
      let seg = [];
      const flush = () => { if (seg.length > 1) g += `<polyline points="${seg.join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" stroke-linejoin="round" stroke-linecap="round"/>`; seg = []; };
      s.values.forEach((v, i) => {
        if (v == null) { flush(); return; }
        seg.push(`${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`);
      });
      flush();
    }
    // End labels
    const ends = spec.series.map(s => {
      let li = s.values.length - 1; while (li >= 0 && s.values[li] == null) li--;
      return li >= 0 ? { y: Y(s.values[li]), name: s.name, color: s.color } : null;
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const e of ends) { e.ly = Math.max(e.y, prev + 12); prev = e.ly; }
    for (const e of ends) {
      const x0 = W - padR;
      g += `<line x1="${x0 + 2}" y1="${e.ly}" x2="${x0 + 14}" y2="${e.ly}" stroke="${e.color}" stroke-width="2"/>`;
      g += `<text x="${x0 + 18}" y="${e.ly + 3}" font-size="9" fill="${P.inkSec}">${this._esc(e.name)}</text>`;
    }
    const title = `<text x="${padL}" y="14" font-size="11" font-weight="600" fill="${P.ink}">${this._esc(spec.title)}</text>`;
    const yLab = `<text x="${padL}" y="${padT - 6}" font-size="9" fill="${P.tickText}">${this._esc(spec.yLabel)}</text>`;
    const xLab = `<text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="9" fill="${P.tickText}">${this._esc(spec.xLabel)}</text>`;
    container.style.margin = '0 0 12px';
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="${this._esc(spec.title)}">${title}${yLab}${xLab}${g}</svg>`;
  },
};
