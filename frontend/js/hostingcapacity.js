/* ProtectionPro — Nodal Hosting Capacity UI.
 *
 * Setup modal (DER pf, voltage/thermal limits, sweep resolution + search cap)
 * → backend /analysis/hosting-capacity → results modal listing, per bus, the
 * maximum unity-pf PV that can be interconnected before a voltage-rise or
 * thermal-overload limit is hit.
 *
 * A deterministic NODAL screening (incremental DER injection, sweep-then-
 * bisect against a full load-flow solve at each trial) — not a stochastic
 * (Monte Carlo) study, and it does not check fault-level/protection impact;
 * run Fault Analysis / Duty Check with the recommended DER applied to
 * confirm those separately.
 *
 * Results are on-demand (not persisted) — re-run after edits.
 */
const HostingCapacity = {
  _result: null,
  _cfg: { power_factor: 1.0, v_min: 0.95, v_max: 1.05, loading_limit_pct: 100,
          step_mw: 0.5, max_mw_per_bus: 10 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  openConfig() {
    const c = this._cfg;
    const body = document.getElementById('hc-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        For each bus, incrementally injects unity-pf PV (sweep-then-bisect, each
        step a full load-flow solve) until a <strong>voltage-rise</strong> or
        <strong>thermal-overload</strong> limit is crossed — the two dominant screens in
        utility hosting-capacity studies. This is a <strong>deterministic nodal</strong>
        screening, not a stochastic (Monte Carlo) study, and does not check
        fault-level/protection impact — verify the recommended capacity with Fault
        Analysis / Duty Check before interconnection.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="hc-pf">DER power factor</label>
        <input id="hc-pf" type="number" min="0" max="1" step="0.01" value="${c.power_factor}">
        <label for="hc-vband">Voltage band (p.u.)</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="hc-vmin" type="number" min="0.8" max="1" step="0.01" value="${c.v_min}" style="width:80px"> –
          <input id="hc-vmax" type="number" min="1" max="1.2" step="0.01" value="${c.v_max}" style="width:80px">
        </div>
        <label for="hc-loading">Thermal loading limit (%)</label>
        <input id="hc-loading" type="number" min="50" max="150" step="5" value="${c.loading_limit_pct}">
        <label for="hc-step">Sweep step (MW)</label>
        <input id="hc-step" type="number" min="0.01" step="0.1" value="${c.step_mw}">
        <label for="hc-cap">Search cap per bus (MW)</label>
        <input id="hc-cap" type="number" min="0.1" step="0.5" value="${c.max_mw_per_bus}">
      </div>`;
    document.getElementById('hc-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      power_factor: parseFloat(v('hc-pf').value),
      v_min: parseFloat(v('hc-vmin').value) || 0.95,
      v_max: parseFloat(v('hc-vmax').value) || 1.05,
      loading_limit_pct: parseFloat(v('hc-loading').value) || 100,
      step_mw: parseFloat(v('hc-step').value) || 0.5,
      max_mw_per_bus: parseFloat(v('hc-cap').value) || 10,
    };
    if (!(this._cfg.power_factor >= 0 && this._cfg.power_factor <= 1)) this._cfg.power_factor = 1.0;
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('hc-config-modal').style.display = 'none';
    const label = 'Running hosting capacity screening…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runHostingCapacity({
        hcPowerFactor: c.power_factor, vMin: c.v_min, vMax: c.v_max,
        loadingLimitPct: c.loading_limit_pct, stepMw: c.step_mw,
        maxMwPerBus: c.max_mw_per_bus,
      });
      this._result = result;
      this.show(result);
      if (result.converged && result.buses.length) {
        const worst = result.buses[0];
        document.getElementById('status-info').textContent =
          `Hosting capacity: lowest ${worst.bus_name} at ${worst.hosting_capacity_mw} MW (${worst.limiting_factor})`;
      } else {
        document.getElementById('status-info').textContent = 'Hosting capacity screening did not run.';
      }
    } catch (e) {
      console.error('Hosting capacity error:', e);
      document.getElementById('status-info').textContent = 'Hosting capacity screening failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Hosting Capacity — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  show(result) {
    this._result = result;
    const modal = document.getElementById('hc-modal');
    const body = document.getElementById('hc-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _factorLabel(kind) {
    return {
      overvoltage: 'Voltage rise', undervoltage: 'Under-voltage',
      overload: 'Thermal overload', none_within_cap: 'None (capped)',
      baseline_violation: 'Pre-existing violation',
    }[kind] || kind;
  },

  _render(body) {
    const r = this._result || {};
    let html = '';
    if ((r.warnings || []).length) {
      html += '<div class="af-warnings">' + r.warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!r.converged) {
      body.innerHTML = html + `<p style="color:#c62828"><strong>Study did not run.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }
    html += `<div style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-bottom:12px">${this._esc(r.method || '')}</div>`;

    const rows = (r.buses || []).map(b => {
      const col = b.hosting_capacity_mw <= 0 ? '#c62828' : (b.capped ? '#c98500' : '#2e7d32');
      return `<tr>
        <td>${this._esc(b.bus_name)}</td>
        <td style="color:${col};font-weight:700">${b.hosting_capacity_mw}${b.capped ? '+' : ''}</td>
        <td>${this._esc(this._factorLabel(b.limiting_factor))}</td>
        <td>${this._esc(b.limiting_element || '—')}</td>
        <td>${this._esc(b.note || '')}</td>
      </tr>`;
    }).join('');
    html += `<table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Bus</th><th>Hosting Capacity (MW)</th><th>Limiting Factor</th><th>Limiting Element</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    body.innerHTML = html;
  },
};
