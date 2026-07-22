/* ProtectionPro — Frequency Scan (impedance vs frequency) UI.
 *
 * Setup modal (scan buses, top harmonic order, resolution) → backend
 * /analysis/frequency-scan → results modal with a log-|Z| vs frequency chart
 * (driving-point impedance per bus), the parallel/series resonance table, and
 * a data table. Parallel resonances (|Z| peaks) amplify harmonic currents near
 * that order; series resonances (dips) sink them.
 *
 * Results are on-demand (not persisted with the project) — re-run after edits.
 */
const FrequencyScan = {
  _result: null,
  _cfg: { bus_id: '', h_max: 25, h_step: 0.05 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _palette(dark) {
    if (typeof VoltageStability !== 'undefined' && VoltageStability._palette) {
      return VoltageStability._palette(dark);
    }
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
        'Add buses and a source before running a frequency scan.';
      return;
    }
    const c = this._cfg;
    const opt = arr => arr.map(o =>
      `<option value="${this._esc(o.id)}"${o.id === c.bus_id ? ' selected' : ''}>${this._esc(o.name)}</option>`).join('');
    const body = document.getElementById('fscan-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Sweeps the network's <strong>driving-point impedance |Z(f)|</strong> at each bus
        from the fundamental up to a top harmonic order, on the same network model as the
        IEEE 519 harmonics study. An |Z| <strong>peak</strong> is a parallel resonance —
        harmonic currents near that order are amplified into voltage distortion; a
        <strong>dip</strong> is a series resonance (a natural harmonic sink).</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="fscan-bus">Scan bus</label>
        <select id="fscan-bus"><option value="">All buses</option>${opt(buses)}</select>
        <label for="fscan-hmax">Top harmonic order</label>
        <input id="fscan-hmax" type="number" min="2" max="100" step="1" value="${c.h_max}">
        <label for="fscan-hstep">Resolution (Δh)</label>
        <input id="fscan-hstep" type="number" min="0.01" max="1" step="0.01" value="${c.h_step}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:12px 0 0">
        Rule of thumb: a capacitor bank Q<sub>c</sub> on a bus with fault level S<sub>sc</sub>
        resonates near order h = √(S<sub>sc</sub>/Q<sub>c</sub>). Order 25 covers the
        characteristic VFD harmonics; raise it to chase higher-order resonances.</p>`;
    document.getElementById('fscan-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      bus_id: v('fscan-bus').value || '',
      h_max: parseFloat(v('fscan-hmax').value) || 25,
      h_step: parseFloat(v('fscan-hstep').value) || 0.05,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('fscan-config-modal').style.display = 'none';
    const label = 'Running frequency scan…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runFrequencyScan({
        busIds: c.bus_id ? [c.bus_id] : null, hMax: c.h_max, hStep: c.h_step,
      });
      this._result = result;
      this.show(result);
      const peaks = (result.resonances || []).filter(r => r.kind === 'parallel');
      document.getElementById('status-info').textContent = peaks.length
        ? `Frequency scan: parallel resonance at ${result.worst_f_hz.toFixed(0)} Hz (h≈${result.worst_h.toFixed(1)}) on ${result.worst_bus_name}`
        : 'Frequency scan complete — no parallel resonance found.';
    } catch (e) {
      console.error('Frequency scan error:', e);
      document.getElementById('status-info').textContent = 'Frequency scan failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Frequency Scan — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('fscan-modal');
    const body = document.getElementById('fscan-body');
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
      body.innerHTML = html + `<p style="color:#c62828"><strong>Scan did not run.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }

    const peaks = (r.resonances || []).filter(x => x.kind === 'parallel');
    const col = peaks.length ? '#c98500' : '#2e7d32';
    const verdict = peaks.length
      ? `Parallel resonance at ${r.worst_f_hz.toFixed(0)} Hz (order ${r.worst_h.toFixed(2)}) — ${this._esc(r.worst_bus_name)}, ${r.worst_z_ohm.toFixed(2)} Ω`
      : 'No parallel resonance within the scanned range';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <div><span style="font-weight:700;color:${col}">${verdict}</span></div>
      <div style="font-size:12px;color:var(--text-muted,#6d6d6d)">f₀ = ${r.f0_hz} Hz · h = 1…${r.h_max} · Δh = ${r.h_step}</div>
    </div>`;

    html += `<div class="fs-chart"></div>`;
    html += this._resonanceTable(r);
    html += this._dataTable(r);
    body.innerHTML = html;
    this._hydrate(body, r);
  },

  _resonanceTable(r) {
    if (!(r.resonances || []).length) return '';
    const rows = r.resonances.map(x => `<tr>
      <td>${this._esc(x.bus_name)}</td>
      <td>${x.kind === 'parallel' ? 'Parallel (peak — amplifies)' : 'Series (dip — sinks)'}</td>
      <td>${x.h.toFixed(2)}</td><td>${x.f_hz.toFixed(0)}</td>
      <td>${x.z_ohm.toFixed(3)}</td><td>${x.prominence.toFixed(1)}×</td></tr>`).join('');
    return `<table class="af-table" style="font-size:11px;margin-top:4px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Bus</th><th>Resonance</th><th>Order h</th><th>f (Hz)</th><th>|Z| (Ω)</th><th>Prominence</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  },

  _dataTable(r) {
    const buses = r.buses || [];
    if (!buses.length || !(r.h || []).length) return '';
    // Decimate the table to ~60 rows — the chart carries the detail.
    const stride = Math.max(1, Math.round(r.h.length / 60));
    let rows = '';
    for (let i = 0; i < r.h.length; i += stride) {
      rows += `<tr><td>${r.h[i].toFixed(2)}</td><td>${(r.h[i] * r.f0_hz).toFixed(0)}</td>`
        + buses.map(b => `<td>${(b.z_ohm[i] ?? 0).toFixed(3)}</td>`).join('') + '</tr>';
    }
    return `<details style="font-size:11px;margin-top:8px"><summary style="cursor:pointer">Impedance data (Ω)</summary>
      <div style="max-height:240px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
      <thead><tr><th>h</th><th>f (Hz)</th>${buses.map(b => `<th>${this._esc(b.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div></details>`;
  },

  _hydrate(root, r) {
    const el = root.querySelector('.fs-chart');
    if (!el || !(r.buses || []).length) return;
    const dark = document.body.classList.contains('dark-mode');
    const P = this._palette(dark);

    const MAX = 9;
    let buses = r.buses;
    if (buses.length > MAX) {
      const keep = new Set([r.worst_bus_id]);
      buses = buses.filter(b => keep.has(b.id))
        .concat(buses.filter(b => !keep.has(b.id)).slice(0, MAX - keep.size));
    }
    const xs = r.h.map(h => h * r.f0_hz);
    const series = buses.map((b, i) => ({
      name: b.name + (b.id === r.worst_bus_id ? ' ◆' : ''),
      values: b.z_ohm.map(z => (z > 0 ? Math.log10(z) : null)),
      color: b.id === r.worst_bus_id ? (dark ? '#ff5b5b' : '#c62828') : P.pool[i % P.pool.length],
      width: b.id === r.worst_bus_id ? 2.4 : 1.6,
    }));
    const markers = (r.resonances || [])
      .filter(x => x.kind === 'parallel').slice(0, 3)
      .map(x => ({ x: x.f_hz, label: `h=${x.h.toFixed(1)}`, dashed: true,
                   color: dark ? '#ff5b5b' : '#c62828' }));
    this._logChart(el, {
      title: 'Driving-point impedance vs frequency',
      xLabel: 'Frequency (Hz)', yLabel: '|Z| (Ω, log)', xs, series, markers,
    }, P);
  },

  // Multi-series line chart with a log10 y-axis (decade gridlines).
  _logChart(container, spec, P) {
    const W = 660, H = 260, padL = 56, padR = 116, padT = 26, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xs = spec.xs, n = xs.length;
    if (!n) return;
    const xLo = xs[0], xHi = xs[n - 1] > xLo ? xs[n - 1] : xLo + 1e-9;
    let yMin = Infinity, yMax = -Infinity;
    for (const s of spec.series) for (const v of s.values) {
      if (v == null) continue;
      if (v < yMin) yMin = v; if (v > yMax) yMax = v;
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    if (yMax - yMin < 0.5) { yMin -= 0.25; yMax += 0.25; }
    yMin = Math.floor(yMin * 2) / 2; yMax = Math.ceil(yMax * 2) / 2;
    const X = v => padL + (v - xLo) / (xHi - xLo) * plotW;
    const Y = v => padT + plotH - (v - yMin) / (yMax - yMin) * plotH;
    const ohm = e => {
      const v = Math.pow(10, e);
      return v >= 100 ? v.toFixed(0) : v >= 1 ? (+v.toFixed(1)).toString() : v.toFixed(v >= 0.1 ? 1 : 2);
    };

    let g = '';
    // Decade (and half-decade when few decades) gridlines
    const decades = Math.ceil(yMax) - Math.floor(yMin);
    const yTicks = [];
    for (let d = Math.floor(yMin); d <= Math.ceil(yMax); d++) {
      yTicks.push(d);
      if (decades <= 3 && d + Math.log10(3) <= yMax) yTicks.push(d + Math.log10(3));
    }
    for (const t of yTicks) {
      if (t < yMin - 1e-9 || t > yMax + 1e-9) continue;
      const y = Y(t);
      const major = Math.abs(t - Math.round(t)) < 1e-9;
      g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${P.grid}" stroke-width="1"${major ? '' : ' stroke-dasharray="2 3"'}/>`;
      g += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${ohm(t)}</text>`;
    }
    const xStep = (typeof VoltageStability !== 'undefined' && VoltageStability._niceStep)
      ? VoltageStability._niceStep(xHi - xLo, 6) : (xHi - xLo) / 6;
    for (let v = Math.ceil(xLo / xStep) * xStep; v <= xHi + 1e-9; v += xStep) {
      g += `<text x="${X(v)}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(0)}</text>`;
    }
    (spec.markers || []).forEach(mk => {
      if (mk.x == null || mk.x < xLo || mk.x > xHi) return;
      const x = X(mk.x);
      g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${mk.color || P.tickText}" stroke-width="1.2" opacity="0.7"${mk.dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
      if (mk.label) g += `<text x="${x + 3}" y="${padT + 10}" font-size="8" fill="${mk.color || P.tickText}">${this._esc(mk.label)}</text>`;
    });
    for (const s of spec.series) {
      let seg = [];
      const flush = () => { if (seg.length > 1) g += `<polyline points="${seg.join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" stroke-linejoin="round" stroke-linecap="round"/>`; seg = []; };
      s.values.forEach((v, i) => {
        if (v == null) { flush(); return; }
        seg.push(`${X(xs[i]).toFixed(1)},${Y(Math.min(yMax, Math.max(yMin, v))).toFixed(1)}`);
      });
      flush();
    }
    // Direct end labels, collision-nudged
    const ends = spec.series.map(s => {
      let li = s.values.length - 1; while (li >= 0 && s.values[li] == null) li--;
      return li >= 0 ? { y: Y(Math.min(yMax, Math.max(yMin, s.values[li]))), name: s.name, color: s.color } : null;
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
