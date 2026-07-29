/* ProtectionPro — Time-Series / Quasi-Dynamic Load Flow UI.
 *
 * Setup modal (horizon, step size, per-type default profile, per-component
 * profile overrides) → backend /analysis/timeseries-loadflow → results modal
 * with the voltage-envelope and branch-loading charts over the horizon, a
 * BESS state-of-charge trajectory chart (when the network has storage), and
 * per-bus / per-branch peak tables.
 *
 * Results are on-demand (not persisted with the project) — re-run after edits.
 */
const TimeSeries = {
  _result: null,
  _cfg: {
    horizon_hours: 24, step_minutes: 60, default_profile: '',
    v_min: 0.95, v_max: 1.05, loading_limit_pct: 100, overrides: {},
  },
  _defaultStepApplied: false,

  _PROFILE_TYPES: ['static_load', 'motor_induction', 'motor_synchronous',
    'distribution_board', 'solar_pv', 'wind_turbine', 'generator'],
  _PROFILES: [
    { v: '', label: 'Use default' },
    { v: 'flat', label: 'Flat (unchanged)' },
    { v: 'residential', label: 'Residential (evening peak)' },
    { v: 'commercial', label: 'Commercial (daytime peak)' },
    { v: 'industrial', label: 'Industrial (broad plateau)' },
    { v: 'pv_clear_sky', label: 'Clear-sky PV' },
  ],

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _profileComponents() {
    return [...AppState.components.values()]
      .filter(c => this._PROFILE_TYPES.includes(c.type))
      .map(c => ({ id: c.id, name: c.props?.name || c.id, type: c.type }));
  },

  _batteries() {
    return [...AppState.components.values()]
      .filter(c => c.type === 'battery'
        || (c.type === 'solar_pv' && c.props?.inverter_type === 'hybrid')).length;
  },

  // ── Setup ──────────────────────────────────────────────────────────
  openConfig() {
    const comps = this._profileComponents();
    const c = this._cfg;
    const hasBatteries = this._batteries() > 0;
    // Battery SoC clamps at a step boundary rather than re-solving it exactly
    // (see timeseries_loadflow.py's BESS caveat) — default to a finer step
    // the first time the modal opens on a network with storage; never
    // overrides a step size the user has since chosen.
    if (!this._defaultStepApplied) {
      this._defaultStepApplied = true;
      if (hasBatteries) c.step_minutes = 15;
    }
    const body = document.getElementById('tsl-config-body');
    const profOpt = (sel) => this._PROFILES.map(p =>
      `<option value="${p.v}"${p.v === sel ? ' selected' : ''}>${this._esc(p.label)}</option>`).join('');
    const rows = comps.map(o => `
      <tr data-comp="${this._esc(o.id)}">
        <td style="padding:2px 6px">${this._esc(o.name)}</td>
        <td style="padding:2px 6px;color:var(--text-muted,#6d6d6d)">${this._esc(o.type)}</td>
        <td style="padding:2px 6px"><select data-override style="font-size:11px">${profOpt(c.overrides[o.id] || '')}</select></td>
      </tr>`).join('');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Re-runs the existing load flow at each time step over a load/generation
        <strong>profile</strong> — the quasi-dynamic time-series study (PowerFactory
        QDS / PSS&reg;E Time-Series PF workhorse). BESS state of charge and OLTC tap
        position are carried forward between steps, not independently re-solved.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="tsl-horizon">Horizon</label>
        <select id="tsl-horizon">
          <option value="24"${c.horizon_hours === 24 ? ' selected' : ''}>24 hours</option>
          <option value="168"${c.horizon_hours === 168 ? ' selected' : ''}>1 week (168 h)</option>
          <option value="8760"${c.horizon_hours === 8760 ? ' selected' : ''}>1 year (8760 h)</option>
        </select>
        <label for="tsl-step">Step size</label>
        <select id="tsl-step">
          <option value="15"${c.step_minutes === 15 ? ' selected' : ''}>15 minutes</option>
          <option value="60"${c.step_minutes === 60 ? ' selected' : ''}>1 hour</option>
        </select>
        <label for="tsl-default-profile">Default profile</label>
        <select id="tsl-default-profile">${profOpt(c.default_profile).replace('Use default', 'Per-type built-in')}</select>
        <label for="tsl-vmin">Min voltage (p.u.)</label>
        <input id="tsl-vmin" type="number" min="0.5" max="1" step="0.01" value="${c.v_min}">
        <label for="tsl-vmax">Max voltage (p.u.)</label>
        <input id="tsl-vmax" type="number" min="1" max="1.5" step="0.01" value="${c.v_max}">
        <label for="tsl-load">Loading limit (%)</label>
        <input id="tsl-load" type="number" min="50" max="200" step="5" value="${c.loading_limit_pct}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:14px 0 4px">
        A 15-minute / 8760 h combination is 35,040 solves — consider 1-hour steps
        for a full-year run. Voltage/loading limits above only count violation
        steps; they do not change the solve.${hasBatteries ? ' This network has'
        + ' battery storage: a 15-minute step is preselected because SoC only'
        + ' clamps at 0%/100% rather than re-solving the exact depletion/full-charge'
        + ' instant within a step — a coarser step reports less precise timing.' : ''}</p>
      ${comps.length ? `
      <div style="margin-top:8px;font-size:13px"><strong>Profile assignment</strong>
        <span style="font-size:11px;color:var(--text-muted,#6d6d6d)"> — leave "Use default" for the built-in per-type shape</span></div>
      <div style="max-height:220px;overflow:auto;margin-top:6px;border:1px solid var(--border-color,#ddd);border-radius:4px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="position:sticky;top:0;background:var(--bg-secondary,#f7f7fa)">
            <th style="text-align:left;padding:4px 6px">Component</th>
            <th style="text-align:left;padding:4px 6px">Type</th>
            <th style="text-align:left;padding:4px 6px">Profile</th></tr></thead>
          <tbody>${rows}</tbody></table>
      </div>` : '<p style="font-size:12px;color:var(--text-muted,#6d6d6d)">No profile-eligible loads/sources found — every step will run at the network\'s present values.</p>'}`;
    document.getElementById('tsl-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    const overrides = {};
    document.querySelectorAll('#tsl-config-body tr[data-comp]').forEach(tr => {
      const sel = tr.querySelector('[data-override]');
      if (sel && sel.value) overrides[tr.dataset.comp] = sel.value;
    });
    this._cfg = {
      horizon_hours: parseFloat(v('tsl-horizon').value) || 24,
      step_minutes: parseFloat(v('tsl-step').value) || 60,
      default_profile: v('tsl-default-profile').value || '',
      v_min: parseFloat(v('tsl-vmin').value) || 0.95,
      v_max: parseFloat(v('tsl-vmax').value) || 1.05,
      loading_limit_pct: parseFloat(v('tsl-load').value) || 100,
      overrides,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('tsl-config-modal').style.display = 'none';
    const nSteps = Math.round(c.horizon_hours * 60 / c.step_minutes);
    const label = `Running time-series load flow (${nSteps} steps)…`;
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runTimeSeriesLoadFlow({
        horizonHours: c.horizon_hours, stepMinutes: c.step_minutes,
        defaultProfile: c.default_profile || undefined, profileOverrides: c.overrides,
        vMin: c.v_min, vMax: c.v_max, loadingLimitPct: c.loading_limit_pct,
      });
      this._result = result;
      this.show(result);
      const nc = (result.non_converged_steps || []).length;
      document.getElementById('status-info').textContent =
        `Time-series load flow: ${result.steps} steps, ${result.violation_step_count} with violations`
        + (nc ? `, ${nc} non-converged` : '') + `, ${result.total_losses_mwh.toFixed(3)} MWh losses.`;
    } catch (e) {
      console.error('Time-series load flow error:', e);
      document.getElementById('status-info').textContent = 'Time-series load flow failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Time-Series Load Flow — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('tsl-modal');
    const body = document.getElementById('tsl-body');
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
      body.innerHTML = html + `<p style="color:#c62828"><strong>No step converged.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }

    const nc = (r.non_converged_steps || []).length;
    const col = r.violation_step_count > 0 ? '#b26a00' : '#2e7d32';
    const verdict = r.violation_step_count > 0
      ? `${r.violation_step_count} of ${r.steps} step(s) with a limit violation`
      : `No limit violations over ${r.steps} steps`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <div><span style="font-weight:700;color:${col}">${this._esc(verdict)}</span>
        <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${r.horizon_hours}h horizon @ ${r.step_minutes} min · ${(r.solve_time_s || 0).toFixed(2)}s solve</span></div>
      ${nc ? `<div style="font-size:12px;color:#c62828">${nc} step(s) did not converge</div>` : ''}
    </div>`;

    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px 14px;font-size:12px;margin-bottom:12px">'
      + `<div><strong>Total losses</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.total_losses_mwh.toFixed(4)} MWh over the horizon</span></div>`
      + `<div><strong>Voltage envelope</strong><br><span style="color:var(--text-muted,#6d6d6d)">${this._envRange(r)}</span></div>`
      + `<div><strong>Peak branch loading</strong><br><span style="color:var(--text-muted,#6d6d6d)">${this._peakLoading(r)}</span></div>`
      + '</div>';

    html += `<div class="tsl-chart" data-chart="voltage"></div>`;
    html += `<div class="tsl-chart" data-chart="loading"></div>`;
    if ((r.battery_trajectories || []).length) html += `<div class="tsl-chart" data-chart="soc"></div>`;
    html += this._tables(r);
    body.innerHTML = html;
    this._hydrate(body, r);
  },

  _envRange(r) {
    const mins = (r.bus_envelopes || []).map(e => e.min_v_pu);
    const maxs = (r.bus_envelopes || []).map(e => e.max_v_pu);
    if (!mins.length) return '—';
    return `${Math.min(...mins).toFixed(3)} – ${Math.max(...maxs).toFixed(3)} p.u.`;
  },

  _peakLoading(r) {
    const peaks = r.branch_peaks || [];
    if (!peaks.length) return '—';
    const worst = peaks.reduce((a, b) => (b.peak_loading_pct > a.peak_loading_pct ? b : a));
    return `${worst.peak_loading_pct.toFixed(0)}% — ${this._esc(worst.element_name)}`;
  },

  _tables(r) {
    const busRows = (r.bus_envelopes || []).slice().sort((a, b) => a.min_v_pu - b.min_v_pu).map(e => `
      <tr><td>${this._esc(e.bus_name)}</td>
        <td style="text-align:right">${e.min_v_pu.toFixed(4)}</td><td style="text-align:right">${(r.t_hours[e.min_v_step] ?? 0).toFixed(2)}h</td>
        <td style="text-align:right">${e.max_v_pu.toFixed(4)}</td><td style="text-align:right">${(r.t_hours[e.max_v_step] ?? 0).toFixed(2)}h</td></tr>`).join('');
    const branchRows = (r.branch_peaks || []).slice().sort((a, b) => b.peak_loading_pct - a.peak_loading_pct).map(e => `
      <tr><td>${this._esc(e.element_name)}</td><td style="text-align:right">${e.peak_loading_pct.toFixed(1)}%</td>
        <td style="text-align:right">${(r.t_hours[e.peak_step] ?? 0).toFixed(2)}h</td><td style="text-align:right">${e.peak_p_mw.toFixed(3)}</td></tr>`).join('');
    let out = `<details style="font-size:11px;margin-top:8px" open><summary style="cursor:pointer">Bus voltage envelope</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Bus</th><th>Min V (p.u.)</th><th>at t</th><th>Max V (p.u.)</th><th>at t</th></tr></thead>
      <tbody>${busRows || '<tr><td colspan="5">No energized buses.</td></tr>'}</tbody></table></div></details>`;
    out += `<details style="font-size:11px;margin-top:6px"><summary style="cursor:pointer">Branch peak loading</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Branch</th><th>Peak loading</th><th>at t</th><th>P (MW)</th></tr></thead>
      <tbody>${branchRows || '<tr><td colspan="4">No branches.</td></tr>'}</tbody></table></div></details>`;
    return out;
  },

  _hydrate(root, r) {
    const dark = document.body.classList.contains('dark-mode');
    const P = (typeof VoltageStability !== 'undefined' && VoltageStability._palette)
      ? VoltageStability._palette(dark)
      : { pool: ['#2a78d6', '#1baf7a'], grid: '#e4e4ea', axis: '#d0d0d0',
          tickText: '#6d6d6d', ink: '#1a1a2e', inkSec: '#555' };
    const xs = r.t_hours || [];
    const constSeries = (val) => xs.map(() => val);
    const charts = {
      voltage: {
        title: 'Network voltage envelope over the horizon',
        xLabel: 't (hours)', yLabel: 'p.u.', xs,
        series: [
          { name: 'Min V', values: r.min_v_pu_series, color: P.pool[0], width: 2 },
          { name: 'Max V', values: r.max_v_pu_series, color: P.pool[1], width: 2 },
          { name: `Limit ${r.limits?.v_min ?? 0.95}`, values: constSeries(r.limits?.v_min ?? 0.95), color: dark ? '#ff5b5b' : '#c62828', width: 1, fmt: v => v.toFixed(3) },
          { name: `Limit ${r.limits?.v_max ?? 1.05}`, values: constSeries(r.limits?.v_max ?? 1.05), color: dark ? '#ff5b5b' : '#c62828', width: 1, fmt: v => v.toFixed(3) },
        ],
        markers: [],
      },
      loading: {
        title: 'Peak branch loading over the horizon',
        xLabel: 't (hours)', yLabel: '%', xs,
        series: [
          { name: 'Max loading', values: r.max_loading_pct_series, color: P.pool[2] || P.pool[0], width: 2,
            fmt: v => v.toFixed(1) + '%' },
          { name: `Limit ${r.limits?.loading_limit_pct ?? 100}%`, values: constSeries(r.limits?.loading_limit_pct ?? 100),
            color: dark ? '#ff5b5b' : '#c62828', width: 1 },
        ],
        markers: [],
      },
    };
    if ((r.battery_trajectories || []).length) {
      charts.soc = {
        title: 'BESS state of charge over the horizon',
        xLabel: 't (hours)', yLabel: 'SoC (%)', xs,
        series: r.battery_trajectories.map((bt, i) => ({
          name: bt.battery_name, values: bt.soc_pct,
          color: P.pool[i % P.pool.length], width: 2, fmt: v => v.toFixed(1) + '%',
        })),
        markers: [],
      };
    }
    root.querySelectorAll('.tsl-chart').forEach(el => {
      const spec = charts[el.dataset.chart];
      if (spec && spec.series.length && typeof VoltageStability !== 'undefined' && VoltageStability._chart) {
        VoltageStability._chart.call(VoltageStability, el, spec, P);
      }
    });
  },
};
