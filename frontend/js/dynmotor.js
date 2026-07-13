/* ProtectionPro — Dynamic Motor Starting results (modal + SVG time-series charts).
 *
 * Chart conventions: single y-axis per chart (never dual-axis — quantities
 * with different units get their own panel), 2px line marks, hairline solid
 * gridlines, recessive muted axis text, legend for ≥2 series plus selective
 * direct end-labels (text in ink tokens, identity via a colored line-key),
 * crosshair + tooltip listing every series at the pointer's time, and a
 * table view so no value is gated behind hover. Series palette validated
 * for CVD separation and contrast on both app surfaces.
 */

const DynMotor = {
  _result: null,
  _activeIdx: 0,

  // Categorical palette (validated against #ffffff / #1e1e2e surfaces)
  _palette(dark) {
    return dark ? {
      speed: '#3987e5', vbus: '#199e70', vmotor: '#c98500',
      current: '#9085e9', torque: '#d95926',
      grid: '#34344a', axis: '#3a3a50', tickText: '#a0a0b0',
      ink: '#e0e0e8', inkSec: '#a0a0b0', surface: '#1e1e2e',
      refLine: '#898781',
    } : {
      speed: '#2a78d6', vbus: '#1baf7a', vmotor: '#eda100',
      current: '#4a3aa7', torque: '#eb6834',
      grid: '#e4e4ea', axis: '#d0d0d0', tickText: '#6d6d6d',
      ink: '#1a1a2e', inkSec: '#555', surface: '#ffffff',
      refLine: '#898781',
    };
  },

  show(result) {
    this._result = result;
    this._activeIdx = 0;
    const modal = document.getElementById('dynamic-motor-modal');
    const body = document.getElementById('dynamic-motor-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _render(body) {
    const motors = (this._result && this._result.motors) || [];
    const warnings = (this._result && this._result.warnings) || [];
    let html = '';

    if (warnings.length) {
      html += '<div class="af-warnings">' + warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!motors.length) {
      body.innerHTML = html + '<p>No motors found in the project.</p>';
      return;
    }

    // Shared-timeline overview: start schedule + bus voltages vs global time.
    // Shown whenever the run is a genuine sequence (staggered / running loads
    // or more than one simulated motor sharing the network).
    const seq = this._result && this._result.sequence;
    const nSim = motors.filter(m => m.status !== 'not_simulated').length;
    if (seq && seq.buses && seq.buses.length && (seq.staggered || nSim > 1)) {
      html += this._renderSequenceHeader(seq);
    }

    // Motor selector tabs (only when more than one motor)
    if (motors.length > 1) {
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">';
      motors.forEach((m, i) => {
        const active = i === this._activeIdx;
        const col = m.status === 'fail' ? '#d32f2f' : m.status === 'warning' ? '#f57c00'
          : m.status === 'not_simulated' ? '#888' : '#4caf50';
        html += `<button class="dynms-tab" data-idx="${i}" style="padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;border:1px solid ${active ? col : 'var(--border-color,#d0d0d0)'};background:${active ? col + '22' : 'transparent'};color:inherit">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:5px"></span>${this._esc(m.motor_name)}</button>`;
      });
      html += '</div>';
    }

    html += `<div id="dynms-motor-panel">${this._renderMotor(motors[this._activeIdx])}</div>`;
    body.innerHTML = html;

    body.querySelectorAll('.dynms-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeIdx = parseInt(btn.dataset.idx, 10);
        this._render(body);
      });
    });
    this._hydrateCharts(body, motors[this._activeIdx]);
    const seqEl = body.querySelector('[data-chart-seq]');
    if (seqEl && seq) this._hydrateOverview(seqEl, seq);
  },

  _renderSequenceHeader(seq) {
    const rows = (seq.schedule || []).slice()
      .sort((a, b) => (a.role === 'running' ? -1 : a.start_time_s)
        - (b.role === 'running' ? -1 : b.start_time_s))
      .map(s => {
        const label = s.role === 'running' ? 'running'
          : `@ ${(+s.start_time_s).toFixed(s.start_time_s % 1 ? 1 : 0)} s`;
        const col = s.role === 'running' ? '#888' : 'var(--accent-color,#2a78d6)';
        return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid ${col};border-radius:12px;font-size:11px">
          <strong>${this._esc(s.motor)}</strong><span style="color:var(--text-muted,#6d6d6d)">${this._esc(label)}</span></span>`;
      }).join('');
    return `<div style="margin-bottom:14px;padding:10px 12px;border:1px solid var(--border-color,#d0d0d0);border-radius:6px">
      <div style="font-size:12px;font-weight:600;margin-bottom:7px">Start sequence — shared timeline</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${rows}</div>
      <p style="font-size:10px;color:var(--text-muted,#6d6d6d);margin:0 0 6px">
        Every motor is simulated on one timeline against a multi-port network equivalent, so each start sags the bus voltage the other energised motors see.</p>
      <div data-chart-seq></div>
    </div>`;
  },

  _hydrateOverview(el, seq) {
    const dark = document.body.classList.contains('dark-mode');
    const P = this._palette(dark);
    // Distinct-ish colours per bus, cycling the categorical palette.
    const pool = [P.vbus, P.vmotor, P.speed, P.current, P.torque];
    const series = (seq.buses || []).map((b, i) => ({
      name: b.bus, values: b.v_pu.map(v => v * 100), color: pool[i % pool.length],
      fmt: v => (v / 100).toFixed(3) + ' p.u.',
    }));
    const markers = (seq.schedule || [])
      .filter(s => s.role !== 'running')
      .map(s => ({ t: s.start_time_s, label: s.motor, color: P.inkSec, dashed: true }));
    this._buildChart(el, {
      title: 'Bus voltage vs time (shared start sequence)',
      xLabel: 'Time (s)', yLabel: 'p.u. ×100', xs: seq.t, yMax: 112,
      markers, series,
    }, P);
  },

  _statusBadge(m) {
    if (m.status === 'not_simulated') return '<span style="color:#888;font-weight:600">NOT SIMULATED</span>';
    const map = { pass: ['#4caf50', 'PASS'], warning: ['#f57c00', 'WARN'], fail: ['#d32f2f', 'FAIL'] };
    const [col, label] = map[m.status] || map.warning;
    return `<span style="color:${col};font-weight:600">${label}</span>`;
  },

  _renderMotor(m) {
    const stage = m.role === 'running' ? 'already running'
      : (m.start_time_s ? `starts @ ${(+m.start_time_s).toFixed(m.start_time_s % 1 ? 1 : 0)} s` : 'starts @ 0 s');
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong style="font-size:14px">${this._esc(m.motor_name)}</strong>
      <span style="font-size:12px">${this._esc(m.starting_method)} · ${this._esc(m.motor_type)} · bus ${this._esc(m.terminal_bus)} · ${this._esc(stage)} &nbsp; ${this._statusBadge(m)}</span>
    </div>`;

    if (m.status === 'not_simulated') {
      return html + `<p style="font-size:12px">${this._esc(m.note || '')}</p>`;
    }

    const simLabel = { started: 'Accelerated to full speed', stalled: 'STALLED',
                       not_started: 'Did not reach full speed in the window' }[m.sim_status] || m.sim_status;
    const cells = [
      ['Result', simLabel],
      ['Acceleration time', m.accel_time_s != null ? m.accel_time_s.toFixed(2) + ' s' : '—'],
      ['Final speed', m.final_speed_pct.toFixed(1) + ' %'],
      ['Peak current', `${m.peak_current_a.toFixed(0)} A (${m.peak_current_xflc.toFixed(2)}×FLC)`],
      ['Pre-start bus V', m.v_prestart_pu.toFixed(3) + ' p.u.'],
      ['Min bus V', `${m.min_v_bus_pu.toFixed(3)} p.u. (dip ${m.max_bus_dip_pct.toFixed(1)}%)`],
      ['Min motor terminal V', m.min_v_motor_pu.toFixed(3) + ' p.u.'],
      ['Rotor thermal used', `${m.thermal_used_pct.toFixed(0)}% of ${m.stall_time_hot_s.toFixed(0)} s hot-stall I²t`],
    ];
    if (m.transition) {
      cells.push(['Starter changeover', `${m.transition.t_s.toFixed(2)} s @ ${m.transition.speed_pct.toFixed(0)}% speed`]);
    }
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 14px;font-size:12px;margin-bottom:10px">'
      + cells.map(([k, v]) => `<div>${this._esc(k)}: <strong>${this._esc(v)}</strong></div>`).join('')
      + '</div>';

    if (m.issues && m.issues.length) {
      html += '<div style="color:#b71c1c;font-size:11px;margin-bottom:8px">'
        + m.issues.map(i => '⚠ ' + this._esc(i)).join('<br>') + '</div>';
    }
    if (m.warnings && m.warnings.length) {
      html += '<div class="af-warnings" style="margin-bottom:8px">'
        + m.warnings.map(w => `<div class="af-warning-item">ⓘ ${this._esc(w)}</div>`).join('') + '</div>';
    }

    // Charts (hydrated after insertion)
    html += `<div class="dynms-chart" data-chart="speedv"></div>`;
    html += `<div class="dynms-chart" data-chart="current"></div>`;
    html += `<div class="dynms-chart" data-chart="torque"></div>`;

    // Fitted model disclosure + table view (accessibility: values without hover)
    const mo = m.model || {};
    html += `<details style="font-size:11px;margin-top:6px"><summary style="cursor:pointer">Fitted model &amp; network equivalent</summary>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px;margin-top:6px">
        <div>R₁ = ${mo.r1_pu} p.u.</div><div>R₂(start) = ${mo.r2_start_pu} p.u.</div>
        <div>R₂(run) = ${mo.r2_run_pu} p.u.</div><div>X = ${mo.x_pu} p.u.</div>
        <div>X_m = ${mo.xm_pu} p.u.</div><div>s_rated = ${mo.s_rated}</div>
        <div>n_sync = ${mo.sync_speed_rpm} rpm</div><div>T_FL = ${mo.t_fl_nm} N·m</div>
        <div>LRT = ${mo.lrt_x_flt}×FLT</div><div>Breakdown (model) = ${mo.bdt_derived_x_flt}×FLT @ s=${mo.bdt_slip}</div>
        <div>J_total = ${mo.j_total_kgm2} kg·m²</div><div>H = ${mo.h_total_s} s</div>
        <div>Z_th = ${mo.thevenin_r_pu} + j${mo.thevenin_x_pu} p.u. (motor base)</div>
        <div>SC level at bus ≈ ${mo.sc_mva_at_bus != null ? mo.sc_mva_at_bus + ' MVA' : 'n/a'}</div>
      </div>
      <p style="margin-top:6px;color:var(--text-muted,#6d6d6d)">Single-cage equivalent circuit with linear deep-bar R₂(s), fitted to the nameplate locked-rotor and rated points; torque between the anchors (e.g. breakdown) is a model prediction. Network as a Thevenin superposition on the pre-start load flow (other loads held at their pre-start flows).</p>
    </details>`;
    html += this._tableView(m);
    return html;
  },

  _tableView(m) {
    const c = m.curves || {};
    const t = c.t || [];
    if (!t.length) return '';
    const step = Math.max(1, Math.floor(t.length / 25));
    let rows = '';
    for (let i = 0; i < t.length; i += step) {
      rows += `<tr><td>${t[i].toFixed(2)}</td><td>${c.speed_pct[i].toFixed(1)}</td>
        <td>${c.current_a[i].toFixed(0)} (${c.current_xflc[i].toFixed(2)}×)</td>
        <td>${c.v_bus_pu[i].toFixed(3)}</td><td>${c.v_motor_pu[i].toFixed(3)}</td>
        <td>${c.te_pu[i].toFixed(3)}</td><td>${c.tl_pu[i].toFixed(3)}</td></tr>`;
    }
    return `<details style="font-size:11px;margin-top:6px"><summary style="cursor:pointer">Data table</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px">
      <table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums"><thead><tr>
        <th>t (s)</th><th>Speed (%)</th><th>Current A (×FLC)</th><th>V bus (p.u.)</th><th>V motor (p.u.)</th><th>T_e (p.u.)</th><th>T_L (p.u.)</th>
      </tr></thead><tbody>${rows}</tbody></table></div></details>`;
  },

  _hydrateCharts(root, m) {
    if (!m || m.status === 'not_simulated' || !m.curves) return;
    const dark = document.body.classList.contains('dark-mode');
    const P = this._palette(dark);
    const c = m.curves;
    const tFl = (m.model && m.model.t_fl_pu) || null;
    const torqueScale = tFl ? 1 / tFl : 1;

    // Event markers on the shared (global) timeline: this motor's energise
    // time, and the starter changeover (transition.t_s is relative to energise).
    const st = m.start_time_s || 0;
    const markers = [];
    if (st > 0) markers.push({ t: st, label: 'energise', color: P.speed, dashed: true });
    if (m.transition) markers.push({ t: st + m.transition.t_s, label: 'changeover' });

    const charts = {
      speedv: {
        title: 'Speed & voltage vs time', xLabel: 'Time (s)', yLabel: '%',
        xs: c.t, yMax: 112,
        markers,
        series: [
          { name: 'Speed', values: c.speed_pct, color: P.speed, fmt: v => v.toFixed(1) + ' %' },
          { name: 'Bus V', values: c.v_bus_pu.map(v => v * 100), color: P.vbus, fmt: v => (v / 100).toFixed(3) + ' p.u.' },
          { name: 'Motor V', values: c.v_motor_pu.map(v => v * 100), color: P.vmotor, fmt: v => (v / 100).toFixed(3) + ' p.u.' },
        ],
      },
      current: {
        title: 'Line current vs time', xLabel: 'Time (s)', yLabel: '×FLC',
        xs: c.t,
        markers,
        series: [
          { name: 'Line current', values: c.current_xflc, color: P.current,
            fmt: (v, i) => v.toFixed(2) + '×FLC (' + c.current_a[i].toFixed(0) + ' A)' },
        ],
      },
      torque: {
        title: 'Torque vs speed (at actual voltage during start)', xLabel: 'Speed (%)', yLabel: '×FLT',
        xs: c.speed_pct,
        series: [
          { name: 'Motor T', values: c.te_pu.map(v => v * torqueScale), color: P.torque, fmt: v => v.toFixed(2) + '×FLT' },
          { name: 'Load T', values: c.tl_pu.map(v => v * torqueScale), color: P.refLine, fmt: v => v.toFixed(2) + '×FLT' },
        ],
      },
    };

    root.querySelectorAll('.dynms-chart').forEach(el => {
      const spec = charts[el.dataset.chart];
      if (spec) this._buildChart(el, spec, P);
    });
  },

  _niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    for (const mult of [1, 2, 2.5, 5, 10]) {
      if (raw <= mult * mag) return mult * mag;
    }
    return 10 * mag;
  },

  _buildChart(container, spec, P) {
    const W = 640, H = 210, padL = 44, padR = 110, padT = 26, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xs = spec.xs;
    const n = xs.length;
    if (!n) return;

    const xMin = 0, xMax = Math.max(xs[n - 1], 1e-9);
    let yMax = spec.yMax || 0;
    for (const s of spec.series) for (const v of s.values) if (v > yMax) yMax = v;
    yMax = yMax * 1.05 || 1;
    const X = v => padL + (v - xMin) / (xMax - xMin) * plotW;
    const Y = v => padT + plotH - Math.max(0, Math.min(v, yMax)) / yMax * plotH;

    const svgNS = 'http://www.w3.org/2000/svg';
    let g = '';

    // Gridlines + y ticks (hairline, solid, recessive)
    const yStep = this._niceStep(yMax, 4);
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const y = Y(v);
      g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${P.grid}" stroke-width="1"/>`;
      g += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    // X ticks
    const xStep = this._niceStep(xMax - xMin, 6);
    for (let v = 0; v <= xMax + 1e-9; v += xStep) {
      const x = X(v);
      g += `<text x="${x}" y="${H - padB + 14}" text-anchor="middle" font-size="9" fill="${P.tickText}" style="font-variant-numeric:tabular-nums">${+v.toFixed(2)}</text>`;
    }
    // Baseline axis
    g += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${P.axis}" stroke-width="1"/>`;

    // Event markers (subtle vertical hairlines + captions): motor energise
    // times, starter changeover, etc. Alternating caption heights avoid overlap.
    (spec.markers || []).forEach((mk, mi) => {
      if (mk.t == null || mk.t < xMin || mk.t > xMax) return;
      const x = X(mk.t);
      const dashed = mk.dashed ? ' stroke-dasharray="3 2"' : '';
      g += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${mk.color || P.tickText}" stroke-width="1" opacity="0.6"${dashed}/>`;
      g += `<text x="${x + 3}" y="${padT + 9 + (mi % 2) * 10}" font-size="8" fill="${mk.color || P.tickText}">${this._esc(mk.label)}</text>`;
    });

    // Series lines (2px, round joins)
    for (const s of spec.series) {
      const pts = s.values.map((v, i) => `${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      g += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    // Direct end-labels in ink with colored line-keys; nudged apart with leaders
    const ends = spec.series.map((s, i) => ({ i, y: Y(s.values[s.values.length - 1]), name: s.name, color: s.color }))
      .sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const e of ends) {
      e.ly = Math.max(e.y, prev + 12);
      prev = e.ly;
    }
    for (const e of ends) {
      const x0 = W - padR;
      if (Math.abs(e.ly - e.y) > 2) {
        g += `<line x1="${x0 + 2}" y1="${e.y}" x2="${x0 + 12}" y2="${e.ly}" stroke="${e.color}" stroke-width="1" opacity="0.7"/>`;
      }
      g += `<line x1="${x0 + 13}" y1="${e.ly}" x2="${x0 + 25}" y2="${e.ly}" stroke="${e.color}" stroke-width="2"/>`;
      g += `<text x="${x0 + 29}" y="${e.ly + 3}" font-size="9" fill="${P.inkSec}">${this._esc(e.name)}</text>`;
    }

    // Crosshair (hidden until hover)
    g += `<line class="dynms-xhair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="${P.tickText}" stroke-width="1" visibility="hidden"/>`;

    const title = `<text x="${padL}" y="14" font-size="11" font-weight="600" fill="${P.ink}">${this._esc(spec.title)}</text>`;
    const yLab = `<text x="${padL}" y="${padT - 6}" font-size="9" fill="${P.tickText}">${this._esc(spec.yLabel)}</text>`;
    const xLab = `<text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="9" fill="${P.tickText}">${this._esc(spec.xLabel)}</text>`;

    container.style.position = 'relative';
    container.style.margin = '0 0 10px';
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="${this._esc(spec.title)}">${title}${yLab}${xLab}${g}</svg>
      <div class="dynms-tip" style="display:none;position:absolute;pointer-events:none;background:var(--bg-primary,#fff);border:1px solid var(--border-color,#d0d0d0);border-radius:4px;padding:5px 8px;font-size:10px;box-shadow:0 2px 8px rgba(0,0,0,0.25);z-index:5;white-space:nowrap"></div>`;

    // Hover layer: crosshair snaps to the nearest sample; tooltip lists every series
    const svg = container.querySelector('svg');
    const tip = container.querySelector('.dynms-tip');
    const xhair = container.querySelector('.dynms-xhair');
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width * W;
      if (fx < padL || fx > W - padR) { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); return; }
      const xVal = xMin + (fx - padL) / plotW * (xMax - xMin);
      // nearest index (xs is monotinic per chart construction)
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; (xs[mid] < xVal) ? lo = mid : hi = mid; }
      const idx = (Math.abs(xs[lo] - xVal) <= Math.abs(xs[hi] - xVal)) ? lo : hi;
      const sx = X(xs[idx]);
      xhair.setAttribute('x1', sx); xhair.setAttribute('x2', sx);
      xhair.setAttribute('visibility', 'visible');

      // Rebuild tooltip content with textContent (labels are untrusted)
      tip.textContent = '';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:3px';
      head.textContent = `${spec.xLabel.replace(/\s*\(.*\)/, '')} ${xs[idx].toFixed(2)} ${spec.xLabel.includes('(s)') ? 's' : '%'}`;
      tip.appendChild(head);
      for (const s of spec.series) {
        const row = document.createElement('div');
        const key = document.createElement('span');
        key.style.cssText = `display:inline-block;width:12px;height:2px;background:${s.color};vertical-align:middle;margin-right:5px`;
        const val = document.createElement('strong');
        val.textContent = s.fmt ? s.fmt(s.values[idx], idx) : String(s.values[idx]);
        const lab = document.createElement('span');
        lab.style.cssText = 'color:var(--text-muted,#6d6d6d);margin-left:5px';
        lab.textContent = s.name;
        row.appendChild(key); row.appendChild(val); row.appendChild(lab);
        tip.appendChild(row);
      }
      tip.style.display = '';
      const cw = container.clientWidth;
      const px = sx / W * cw;
      tip.style.left = (px + 12 + tip.offsetWidth > cw ? px - tip.offsetWidth - 10 : px + 12) + 'px';
      tip.style.top = '30px';
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); });
  },
};
