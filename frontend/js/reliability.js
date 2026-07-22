/* ProtectionPro — Reliability Assessment UI (SAIDI / SAIFI / MAIFI).
 *
 * One-click study (no setup modal): Studies → Reliability Assessment runs
 * the analytical FMEA and shows the IEEE 1366 indices, the per-load-point
 * table (λ, unavailability, CAIDI) and the failure-mode table ranked by
 * SAIDI contribution. Rates come from per-component reliability props
 * (Reliability section) with IEEE 493-style defaults when blank.
 *
 * Results are on-demand (not persisted) — re-run after edits.
 */
const Reliability = {
  _result: null,

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  async run() {
    const label = 'Running reliability assessment…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runReliability();
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? `Reliability: SAIFI ${result.indices.saifi} int/cust·yr · SAIDI ${result.indices.saidi_min} min/cust·yr`
        : 'Reliability assessment did not run.';
    } catch (e) {
      console.error('Reliability error:', e);
      document.getElementById('status-info').textContent = 'Reliability assessment failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Reliability — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  show(result) {
    this._result = result;
    const modal = document.getElementById('rel-modal');
    const body = document.getElementById('rel-body');
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
    const i = r.indices || {};
    const chip = (label, val, sub) =>
      `<div style="padding:8px 10px;border:1px solid var(--border-color,#e0e0e0);border-radius:6px">
        <div style="font-size:11px;color:var(--text-muted,#6d6d6d)">${label}</div>
        <div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">${val}</div>
        <div style="font-size:10px;color:var(--text-muted,#6d6d6d)">${sub}</div></div>`;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:14px">'
      + chip('SAIFI', i.saifi, 'interruptions / customer·yr')
      + chip('SAIDI', i.saidi_min, 'minutes / customer·yr')
      + chip('CAIDI', i.caidi_h, 'hours / interruption')
      + chip('ASAI', i.asai_pct + '%', 'service availability')
      + chip('MAIFI', i.maifi, 'momentary / customer·yr')
      + chip('EENS', i.eens_mwh_yr, 'MWh not supplied / yr')
      + '</div>';
    html += `<div style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-bottom:10px">${this._esc(r.method || '')} · ${i.customers_total} customers</div>`;

    if ((r.load_points || []).length) {
      html += `<div style="font-size:13px;margin:4px 0"><strong>Load points</strong></div>
        <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
        <thead><tr><th>Bus</th><th>Customers</th><th>Load (MW)</th><th>λ (/yr)</th><th>U (h/yr)</th><th>CAIDI (h)</th></tr></thead><tbody>`
        + r.load_points.map(p => `<tr><td>${this._esc(p.name)}</td><td>${p.customers}</td><td>${p.load_mw.toFixed(3)}</td><td>${p.lambda_per_yr}</td><td>${p.unavailability_h_yr}</td><td>${p.caidi_h}</td></tr>`).join('')
        + '</tbody></table>';
    }
    if ((r.fmea || []).length) {
      html += `<div style="font-size:13px;margin:12px 0 4px"><strong>Failure modes</strong> <span style="font-size:11px;color:var(--text-muted,#6d6d6d)">— ranked by SAIDI contribution</span></div>
        <div style="max-height:280px;overflow:auto"><table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
        <thead><tr><th>Element</th><th>λ (/yr)</th><th>r (h)</th><th>Customers hit</th><th>MW hit</th><th>SAIFI</th><th>SAIDI (h)</th><th>EENS (MWh/yr)</th></tr></thead><tbody>`
        + r.fmea.map(f => `<tr><td>${this._esc(f.name)}</td><td>${f.lambda_per_yr}</td><td>${f.repair_h}</td><td>${f.customers_affected}</td><td>${f.load_mw_affected.toFixed(3)}</td><td>${f.saifi_contrib}</td><td>${f.saidi_contrib_h}</td><td>${f.eens_mwh_yr}</td></tr>`).join('')
        + '</tbody></table></div>';
    }
    body.innerHTML = html;
  },
};
