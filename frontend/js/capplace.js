/* ProtectionPro — Optimal Capacitor Placement UI.
 *
 * Setup modal (unit size, per-bus / total budget, voltage band) → backend
 * /analysis/capacitor-placement → results modal with the recommended per-bus
 * placements (kvar + voltage before/after), the greedy move log, and the
 * loss/violation improvement with an annualized value.
 *
 * Results are on-demand (not persisted) and advisory — apply a placement as
 * an ordinary capacitor bank on the diagram.
 */
const CapPlacement = {
  _result: null,
  _cfg: { unit_kvar: 100, max_bus: 2000, max_total: 5000, v_min: 0.95, v_max: 1.05 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  openConfig() {
    const c = this._cfg;
    const body = document.getElementById('cpl-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Greedy <strong>loss-sensitivity placement</strong>: one standard bank unit per
        round at the bus with the largest improvement, every trial a full load-flow
        solve. Voltage violations rank above losses, so compensation clears
        undervoltage first; a unit that would breach the upper band is never chosen.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="cpl-unit">Standard unit (kvar)</label>
        <input id="cpl-unit" type="number" min="10" step="10" value="${c.unit_kvar}">
        <label for="cpl-maxbus">Max per bus (kvar)</label>
        <input id="cpl-maxbus" type="number" min="50" step="50" value="${c.max_bus}">
        <label for="cpl-maxtotal">Total budget (kvar)</label>
        <input id="cpl-maxtotal" type="number" min="50" step="50" value="${c.max_total}">
        <label for="cpl-vmin">Voltage band (p.u.)</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="cpl-vmin" type="number" min="0.8" max="1" step="0.01" value="${c.v_min}" style="width:80px"> –
          <input id="cpl-vmax" type="number" min="1" max="1.2" step="0.01" value="${c.v_max}" style="width:80px">
        </div>
      </div>`;
    document.getElementById('cpl-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      unit_kvar: parseFloat(v('cpl-unit').value) || 100,
      max_bus: parseFloat(v('cpl-maxbus').value) || 2000,
      max_total: parseFloat(v('cpl-maxtotal').value) || 5000,
      v_min: parseFloat(v('cpl-vmin').value) || 0.95,
      v_max: parseFloat(v('cpl-vmax').value) || 1.05,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('cpl-config-modal').style.display = 'none';
    const label = 'Running capacitor placement…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runCapacitorPlacement({
        unitKvar: c.unit_kvar, maxKvarPerBus: c.max_bus,
        maxTotalKvar: c.max_total, vMin: c.v_min, vMax: c.v_max,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? (result.total_kvar > 0
           ? `Capacitor placement: ${result.total_kvar} kvar recommended, ${result.loss_reduction_kw} kW loss reduction`
           : 'Capacitor placement: no beneficial placement found.')
        : 'Capacitor placement did not run.';
    } catch (e) {
      console.error('Capacitor placement error:', e);
      document.getElementById('status-info').textContent = 'Capacitor placement failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Capacitor Placement — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  show(result) {
    this._result = result;
    const modal = document.getElementById('cpl-modal');
    const body = document.getElementById('cpl-body');
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
      body.innerHTML = html + `<p style="color:#c62828"><strong>Study did not run.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }
    const placed = r.total_kvar > 0;
    const col = placed ? '#2e7d32' : '#6d6d6d';
    const b = r.baseline || {}, o = r.optimized || {};
    const headline = placed
      ? `${r.total_kvar} kvar recommended — losses ${(b.losses_mw * 1000).toFixed(1)} → ${(o.losses_mw * 1000).toFixed(1)} kW (−${r.loss_reduction_kw} kW)`
      : 'Network already optimal for the modelled load';
    html += `<div style="margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <span style="font-weight:700;color:${col}">${this._esc(headline)}</span>
      <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${r.lf_evaluations} load-flow solves</span>
    </div>`;

    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px 14px;font-size:12px;margin-bottom:12px">'
      + `<div><strong>Violations</strong><br><span style="color:var(--text-muted,#6d6d6d)">${(b.violations || []).length} → ${(o.violations || []).length}</span></div>`
      + `<div><strong>Energy saved</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.energy_savings_mwh_yr} MWh/yr</span></div>`
      + `<div><strong>Value</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.savings_per_yr} /yr @ ${r.cost_per_mwh}/MWh</span></div>`
      + '</div>';

    if ((r.placements || []).length) {
      html += `<div style="font-size:13px;margin:4px 0"><strong>Recommended placements</strong> <span style="font-size:11px;color:var(--text-muted,#6d6d6d)">— ${this._esc(r.note || '')}</span></div>
        <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
        <thead><tr><th>Bus</th><th>kvar</th><th>V before (pu)</th><th>V after (pu)</th></tr></thead><tbody>`
        + r.placements.map(p => `<tr><td>${this._esc(p.name)}</td><td><strong>${p.kvar}</strong></td><td>${p.v_before ?? '—'}</td><td>${p.v_after ?? '—'}</td></tr>`).join('')
        + '</tbody></table>';
    }
    if ((r.moves || []).length) {
      html += `<details style="font-size:11px;margin-top:8px"><summary style="cursor:pointer">Greedy placement log (${r.moves.length} units)</summary>
        <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
        <thead><tr><th>#</th><th>Bus</th><th>+kvar</th><th>Bus total</th><th>Δloss (kW)</th></tr></thead><tbody>`
        + r.moves.map((m, i) => `<tr><td>${i + 1}</td><td>${this._esc(m.name)}</td><td>${m.kvar_added}</td><td>${m.total_kvar}</td><td>${m.loss_reduction_kw}</td></tr>`).join('')
        + '</tbody></table></div></details>';
    }
    body.innerHTML = html;
  },
};
