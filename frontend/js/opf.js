/* ProtectionPro — Optimal Power Flow UI.
 *
 * Setup modal (objective, voltage band, control toggles) → backend
 * /analysis/opf → results modal comparing baseline vs optimized cost /
 * losses / violations, the applied control moves (from → to), the final
 * dispatch table with per-source costs, and the recommended settings.
 *
 * Results are on-demand (not persisted) and advisory: the study never
 * changes the diagram — apply the recommended settings by hand (or keep
 * them as a report).
 */
const OPF = {
  _result: null,
  _cfg: { objective: 'cost', v_min: 0.95, v_max: 1.05, loading: 100,
          dispatch: true, caps: true, taps: true, setpoints: true },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ── Setup ──────────────────────────────────────────────────────────
  openConfig() {
    const c = this._cfg;
    const body = document.getElementById('opf-config-body');
    const chk = (id, on, label) =>
      `<label style="display:flex;gap:6px;align-items:center;font-size:13px">
         <input type="checkbox" id="${id}"${on ? ' checked' : ''}>${label}</label>`;
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        <strong>Economic dispatch</strong> re-ranks sources by marginal cost
        (<em>cost_per_mwh</em> on each source) — merit order by ascending cost, with
        your <em>must-run</em> flags honoured. <strong>Volt/VAR optimization</strong> then
        hill-climbs the network's controls (capacitor steps, transformer taps, voltage
        setpoints), scoring every move with a full load-flow solve: violations first,
        then the objective.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="opf-objective">Objective</label>
        <select id="opf-objective">
          <option value="cost"${c.objective === 'cost' ? ' selected' : ''}>Minimum generation cost</option>
          <option value="loss"${c.objective === 'loss' ? ' selected' : ''}>Minimum network losses</option>
        </select>
        <label for="opf-vmin">Voltage band (p.u.)</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="opf-vmin" type="number" min="0.8" max="1" step="0.01" value="${c.v_min}" style="width:80px"> –
          <input id="opf-vmax" type="number" min="1" max="1.2" step="0.01" value="${c.v_max}" style="width:80px">
        </div>
        <label for="opf-loading">Loading limit (%)</label>
        <input id="opf-loading" type="number" min="50" max="150" step="5" value="${c.loading}" style="width:80px">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px">
        ${chk('opf-dispatch', c.dispatch, 'Economic dispatch')}
        ${chk('opf-caps', c.caps, 'Capacitor steps')}
        ${chk('opf-taps', c.taps, 'Transformer taps')}
        ${chk('opf-setpoints', c.setpoints, 'Voltage setpoints')}
      </div>`;
    document.getElementById('opf-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      objective: v('opf-objective').value,
      v_min: parseFloat(v('opf-vmin').value) || 0.95,
      v_max: parseFloat(v('opf-vmax').value) || 1.05,
      loading: parseFloat(v('opf-loading').value) || 100,
      dispatch: v('opf-dispatch').checked,
      caps: v('opf-caps').checked,
      taps: v('opf-taps').checked,
      setpoints: v('opf-setpoints').checked,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('opf-config-modal').style.display = 'none';
    const label = 'Running optimal power flow…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runOPF({
        objective: c.objective, vMin: c.v_min, vMax: c.v_max,
        loadingLimitPct: c.loading, useDispatch: c.dispatch,
        useCapacitors: c.caps, useTaps: c.taps, useSetpoints: c.setpoints,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? (c.objective === 'cost'
           ? `OPF: ${result.savings_per_h >= 0.005 ? result.savings_per_h.toFixed(2) + '/h saved' : 'already optimal'} (${result.moves.length} moves)`
           : `OPF: ${result.loss_reduction_kw >= 0.005 ? result.loss_reduction_kw.toFixed(2) + ' kW losses saved' : 'already optimal'} (${result.moves.length} moves)`)
        : 'OPF did not run.';
    } catch (e) {
      console.error('OPF error:', e);
      document.getElementById('status-info').textContent = 'OPF failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Optimal Power Flow — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('opf-modal');
    const body = document.getElementById('opf-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _propLabel(prop) {
    return { steps_in_service: 'Capacitor steps', tap_percent: 'Tap',
             voltage_setpoint_pu: 'V setpoint', v_setpoint_pu: 'V setpoint' }[prop] || prop;
  },

  _render(body) {
    const r = this._result || {};
    let html = '';
    if ((r.warnings || []).length) {
      html += '<div class="af-warnings">' + r.warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!r.converged) {
      body.innerHTML = html + `<p style="color:#c62828"><strong>OPF did not run.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }

    const b = r.baseline || {}, o = r.optimized || {};
    const improved = r.savings_per_h > 0.005 || r.loss_reduction_kw > 0.005
      || (b.violations || []).length > (o.violations || []).length;
    const col = improved ? '#2e7d32' : '#6d6d6d';
    const headline = r.objective === 'cost'
      ? (r.savings_per_h > 0.005 ? `Savings ${r.savings_per_h.toFixed(2)} /h (${b.cost_per_h.toFixed(2)} → ${o.cost_per_h.toFixed(2)})`
                                 : 'Dispatch already cost-optimal')
      : (r.loss_reduction_kw > 0.005 ? `Losses down ${r.loss_reduction_kw.toFixed(2)} kW (${(b.losses_mw * 1000).toFixed(1)} → ${(o.losses_mw * 1000).toFixed(1)} kW)`
                                     : 'Losses already minimal');
    html += `<div style="margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <span style="font-weight:700;color:${col}">${this._esc(headline)}</span>
      <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${r.moves.length} control move${r.moves.length === 1 ? '' : 's'} · ${r.lf_evaluations} load-flow solves</span>
    </div>`;

    const cell = (label, base, opt) =>
      `<div><strong>${label}</strong><br><span style="color:var(--text-muted,#6d6d6d)">${base} → <strong>${opt}</strong></span></div>`;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px 14px;font-size:12px;margin-bottom:12px">'
      + cell('Generation cost (/h)', b.cost_per_h?.toFixed(2), o.cost_per_h?.toFixed(2))
      + cell('Network losses (kW)', (b.losses_mw * 1000).toFixed(1), (o.losses_mw * 1000).toFixed(1))
      + cell('Violations', (b.violations || []).length, (o.violations || []).length)
      + '</div>';

    if ((o.violations || []).length) {
      html += '<div class="af-warnings">' + o.violations.map(v =>
        `<div class="af-warning-item">✗ Remaining ${this._esc(v.kind)}: ${this._esc(v.name)} (${v.value})</div>`).join('') + '</div>';
    }

    if ((r.moves || []).length) {
      html += `<div style="font-size:13px;margin:8px 0 4px"><strong>Recommended control moves</strong> <span style="font-size:11px;color:var(--text-muted,#6d6d6d)">— advisory; apply on the diagram to adopt</span></div>
        <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
        <thead><tr><th>#</th><th>Element</th><th>Control</th><th>From</th><th>To</th></tr></thead><tbody>`
        + r.moves.map((m, i) => `<tr><td>${i + 1}</td><td>${this._esc(m.name)}</td><td>${this._esc(this._propLabel(m.prop))} (${this._esc(m.unit)})</td><td>${m.from}</td><td><strong>${m.to}</strong></td></tr>`).join('')
        + '</tbody></table>';
    }

    if ((r.dispatch || []).length) {
      html += `<div style="font-size:13px;margin:12px 0 4px"><strong>Optimized dispatch</strong></div>
        <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
        <thead><tr><th>Source</th><th>Role</th><th>MW</th><th>Cost (/MWh)</th><th>Cost (/h)</th></tr></thead><tbody>`
        + r.dispatch.map(d => `<tr><td>${this._esc(d.source_name)}</td><td>${this._esc(d.role)}</td><td>${d.dispatched_mw.toFixed(3)}</td><td>${d.cost_per_mwh.toFixed(0)}</td><td>${d.cost_per_h.toFixed(2)}</td></tr>`).join('')
        + '</tbody></table>';
    }
    body.innerHTML = html;
  },
};
