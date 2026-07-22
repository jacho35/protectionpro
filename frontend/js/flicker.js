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
  _cfg: { pst_limit: 1.0, plt_limit: 0.65, d_anchor_pct: 3.0, exponent: 0.31 },

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
        <strong>planning-level estimate</strong> from the IEC 61000-3-3-style simplified
        curve, not a certified IEC 61000-4-15 flickermeter measurement — verify a
        borderline/failing result against the standard's own curve or by field measurement.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="flk-pst">Pst limit</label>
        <input id="flk-pst" type="number" min="0.1" step="0.05" value="${c.pst_limit}">
        <label for="flk-plt">Plt limit</label>
        <input id="flk-plt" type="number" min="0.1" step="0.05" value="${c.plt_limit}">
        <label for="flk-anchor">Curve anchor d (%) @ 1/min</label>
        <input id="flk-anchor" type="number" min="0.1" step="0.1" value="${c.d_anchor_pct}">
        <label for="flk-exp">Curve exponent</label>
        <input id="flk-exp" type="number" min="0.05" max="1" step="0.01" value="${c.exponent}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:12px 0 0">
        Defaults: Pst ≤ 1.0 / Plt ≤ 0.65 are the IEC 61000-3-3 LV connection limits — an
        MV/HV connection typically uses a utility-allocated IEC 61000-3-7 planning level
        instead. The curve anchor/exponent default to the standard's own most-cited
        reference point (≈3% step at 1 change/min ⇒ Pst≈1) and 0.31 roll-off exponent;
        adjust if you have the standard's exact curve to hand.</p>`;
    document.getElementById('flk-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      pst_limit: parseFloat(v('flk-pst').value) || 1.0,
      plt_limit: parseFloat(v('flk-plt').value) || 0.65,
      d_anchor_pct: parseFloat(v('flk-anchor').value) || 3.0,
      exponent: parseFloat(v('flk-exp').value) || 0.31,
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
        dAnchorPct: c.d_anchor_pct, exponent: c.exponent,
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
      : `${r.sources.filter(s => !s.compliant).length} of ${r.sources.length} source(s) exceed the Pst/Plt limit`;
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
        <td>${s.relative_voltage_change_pct}</td>
        <td>${s.pst}${s.pst_compliant ? '' : ' ✗'}</td>
        <td>${s.plt}${s.plt_compliant ? '' : ' ✗'}</td>
        <td style="color:${okCol};font-weight:600">${s.compliant ? 'PASS' : 'FAIL'}</td>
      </tr>`;
    }).join('');
    html += `<table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Motor</th><th>Bus</th><th>Starting</th><th>Starts/h</th><th>d (%)</th><th>Pst</th><th>Plt</th><th>Verdict</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    body.innerHTML = html;
  },
};
