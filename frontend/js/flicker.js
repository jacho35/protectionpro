/* ProtectionPro — Voltage Flicker (IEC 61000-3-3 / IEC 61000-4-15) UI.
 *
 * Setup modal (Pst/Plt limits, curve calibration) → backend /analysis/flicker
 * → results modal listing each repetitively-starting motor's relative
 * voltage change, Pst/Plt estimate and IEC 61000-3-3 compliance verdict.
 *
 * Screens motors flagged with a nonzero "Starts per Hour" (Voltage Flicker
 * property section) — a once-off start does not cause flicker. This is a
 * PLANNING-LEVEL SCREENING ESTIMATE (not a certified IEC 61000-4-15
 * flickermeter measurement) — see the results-modal method note.
 *
 * Results are on-demand (not persisted) — re-run after edits.
 */
const Flicker = {
  _result: null,
  // Limits blank = by connection voltage (backend _limits_for).
  _cfg: { pst_limit: null, plt_limit: null, shape_factor: 1.0 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  openConfig() {
    const c = this._cfg;
    const body = document.getElementById('flk-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Screens every motor with a non-zero <strong>Starts per Hour</strong> (Voltage
        Flicker property section — a once-off start is excluded) for repetitive-switching
        voltage flicker. Relative voltage change is computed by the same Thevenin
        superposition as the Motor Starting study; Pst/Plt are a
        <strong>planning-level estimate</strong> by the IEC 61000-3-3 analytical method,
        not a certified IEC 61000-4-15 flickermeter measurement — confirm a borderline
        result by measurement.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="flk-pst">Pst limit</label>
        <input id="flk-pst" type="number" min="0.1" step="0.05" placeholder="by voltage" value="${c.pst_limit ?? ''}">
        <label for="flk-plt">Plt limit</label>
        <input id="flk-plt" type="number" min="0.1" step="0.05" placeholder="by voltage" value="${c.plt_limit ?? ''}">
        <label for="flk-shape">Shape factor F</label>
        <input id="flk-shape" type="number" min="0.05" max="1" step="0.05" value="${c.shape_factor}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:12px 0 0">
        Limits left blank follow the connection voltage: LV Pst ≤ 1.0, Plt ≤ 0.65 with
        d<sub>max</sub> ≤ 4 % and d<sub>c</sub> ≤ 3.3 % (IEC 61000-3-3); MV Pst 0.9 / Plt 0.7 and HV
        0.8 / 0.6 (IEC/TR 61000-3-7 indicative planning levels — use the network operator's
        allocation where you have one). F = 1 treats each start as a rectangular step, which
        is conservative; a smaller F suits a start whose voltage recovers quickly.</p>`;
    document.getElementById('flk-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      pst_limit: parseFloat(v('flk-pst').value) || null,
      plt_limit: parseFloat(v('flk-plt').value) || null,
      shape_factor: parseFloat(v('flk-shape').value) || 1.0,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('flk-config-modal').style.display = 'none';
    const label = 'Running voltage flicker screening…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runFlickerAnalysis({
        pstLimit: c.pst_limit, pltLimit: c.plt_limit,
        shapeFactor: c.shape_factor,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? (result.compliant
           ? `Voltage flicker: ${result.sources.length} source(s) screened, all compliant`
           : `Voltage flicker: ${result.sources.filter(s => !s.compliant).length} of ${result.sources.length} source(s) exceed the limit`)
        : 'Voltage flicker screening did not run.';
    } catch (e) {
      console.error('Flicker analysis error:', e);
      document.getElementById('status-info').textContent = 'Voltage flicker screening failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Voltage Flicker — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  show(result) {
    this._result = result;
    const modal = document.getElementById('flk-modal');
    const body = document.getElementById('flk-body');
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
    const col = r.compliant ? '#2e7d32' : '#c62828';
    const verdict = r.compliant
      ? `All ${r.sources.length} screened source(s) within limit`
      : `${r.sources.filter(s => !s.compliant).length} of ${r.sources.length} source(s) exceed a flicker limit`;
    html += `<div style="margin-bottom:10px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <span style="font-weight:700;color:${col}">${this._esc(verdict)}</span>
    </div>`;
    html += `<div style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-bottom:12px">${this._esc(r.method || '')}</div>`;

    const rows = (r.sources || []).map(s => {
      const okCol = s.compliant ? '#2e7d32' : '#c62828';
      return `<tr>
        <td>${this._esc(s.motor_name)}</td>
        <td>${this._esc(s.terminal_bus)}</td>
        <td>${this._esc(s.starting_method)}</td>
        <td>${s.starts_per_hour}</td>
        <td>${s.relative_voltage_change_pct}${s.d_max_compliant === false ? ' ✗' : ''}</td>
        <td>${s.steady_voltage_change_pct ?? '—'}${s.d_c_compliant === false ? ' ✗' : ''}</td>
        <td>${s.pst}${s.pst_compliant ? '' : ' ✗'}</td>
        <td>${s.plt}${s.plt_compliant ? '' : ' ✗'}</td>
        <td title="${this._esc(s.limit_basis || '')}">${s.pst_limit} / ${s.plt_limit}${s.d_max_limit_pct != null ? ` · d ${s.d_max_limit_pct} / ${s.d_c_limit_pct} %` : ''}</td>
        <td style="color:${okCol};font-weight:600">${s.compliant ? 'PASS' : 'FAIL'}</td>
      </tr>`;
    }).join('');
    html += `<table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Motor</th><th>Bus</th><th>Starting</th><th>Starts/h</th><th>d<sub>max</sub> (%)</th><th>d<sub>c</sub> (%)</th><th>Pst</th><th>Plt</th><th>Limits</th><th>Verdict</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    body.innerHTML = html;
  },
};
