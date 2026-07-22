/* ProtectionPro — Passive Filter Sizing UI.
 *
 * Setup modal (filter bus, total kvar, quality factor, branch cap) → backend
 * /analysis/filter-sizing → results modal with the designed single-tuned
 * branches (kvar / tuning / C / L / R), the before→after THD table and the
 * IEEE 519 verdict. Apply a branch on the diagram as a capacitor bank with
 * the listed kvar + Tuned Order + Quality Factor.
 *
 * Results are on-demand (not persisted) — re-run after edits.
 */
const FilterSizing = {
  _result: null,
  _cfg: { bus_id: '', total_kvar: 0, quality_factor: 30, max_branches: 3 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _buses() {
    return [...AppState.components.values()]
      .filter(c => c.type === 'bus' || c.type === 'distribution_board')
      .map(c => ({ id: c.id, name: c.props?.name || c.id }));
  },

  openConfig() {
    const buses = this._buses();
    if (!buses.length) {
      document.getElementById('status-info').textContent =
        'Add buses and a VFD (harmonic source) before running filter sizing.';
      return;
    }
    const c = this._cfg;
    const opt = buses.map(o =>
      `<option value="${this._esc(o.id)}"${o.id === c.bus_id ? ' selected' : ''}>${this._esc(o.name)}</option>`).join('');
    const body = document.getElementById('flt-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Designs <strong>single-tuned LC(R) filter branches</strong> at a bus — one per
        dominant VFD harmonic, detuned to 94% of the order — and verifies the design by
        re-running the IEEE 519 harmonics study with the branches in place. The branch
        kvar doubles as power-factor correction.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="flt-bus">Filter bus</label>
        <select id="flt-bus"><option value="">Auto — worst THD bus</option>${opt}</select>
        <label for="flt-kvar">Total filter size (kvar)</label>
        <input id="flt-kvar" type="number" min="0" step="50" value="${c.total_kvar || ''}" placeholder="auto — network reactive demand">
        <label for="flt-q">Quality factor Q</label>
        <input id="flt-q" type="number" min="5" max="150" step="5" value="${c.quality_factor}">
        <label for="flt-branches">Max branches</label>
        <input id="flt-branches" type="number" min="1" max="4" step="1" value="${c.max_branches}">
      </div>`;
    document.getElementById('flt-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      bus_id: v('flt-bus').value || '',
      total_kvar: parseFloat(v('flt-kvar').value) || 0,
      quality_factor: parseFloat(v('flt-q').value) || 30,
      max_branches: parseInt(v('flt-branches').value, 10) || 3,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('flt-config-modal').style.display = 'none';
    const label = 'Running passive filter sizing…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runFilterSizing({
        filterBusId: c.bus_id || null,
        totalKvar: c.total_kvar > 0 ? c.total_kvar : null,
        qualityFactor: c.quality_factor, maxBranches: c.max_branches,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? (result.meets_ieee519
           ? `Filter sizing: ${result.design.length}-branch design meets IEEE 519 (THD ${result.baseline.worst_thd_pct}% → ${result.with_filter.worst_thd_pct}%)`
           : `Filter sizing: best design improves THD ${result.baseline.worst_thd_pct}% → ${result.with_filter.worst_thd_pct}% (still non-compliant)`)
        : 'Filter sizing did not run.';
    } catch (e) {
      console.error('Filter sizing error:', e);
      document.getElementById('status-info').textContent = 'Filter sizing failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Filter Sizing — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  show(result) {
    this._result = result;
    const modal = document.getElementById('flt-modal');
    const body = document.getElementById('flt-body');
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
    const col = r.meets_ieee519 ? '#2e7d32' : '#c98500';
    const verdict = r.meets_ieee519
      ? `Design meets IEEE 519 — worst THD ${r.baseline.worst_thd_pct}% → ${r.with_filter.worst_thd_pct}%`
      : `Best attempt — worst THD ${r.baseline.worst_thd_pct}% → ${r.with_filter.worst_thd_pct}% (limits still exceeded)`;
    html += `<div style="margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <span style="font-weight:700;color:${col}">${this._esc(verdict)}</span>
      <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${this._esc(r.bus_name)} @ ${r.voltage_kv} kV · ${r.total_kvar} kvar total</span>
    </div>`;

    html += `<div style="font-size:13px;margin:4px 0"><strong>Designed branches</strong> <span style="font-size:11px;color:var(--text-muted,#6d6d6d)">— ${this._esc(r.note || '')}</span></div>
      <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Target h</th><th>Tuned at</th><th>kvar</th><th>Q</th><th>C (µF)</th><th>L (mH)</th><th>R (Ω)</th></tr></thead><tbody>`
      + (r.design || []).map(d => `<tr><td>${d.harmonic_order}</td><td>${d.tuned_order}</td><td>${d.kvar}</td><td>${d.quality_factor}</td><td>${d.c_uf}</td><td>${d.l_mh}</td><td>${d.r_ohm}</td></tr>`).join('')
      + '</tbody></table>';

    const rows = (r.baseline.buses || []).map(b => {
      const after = (r.with_filter.buses || []).find(x => x.id === b.id) || {};
      const ok = after.compliant;
      return `<tr><td>${this._esc(b.name)}</td><td>${b.thd_v_pct}</td><td>${after.thd_v_pct ?? '—'}</td><td>${b.thd_limit_pct}</td>
        <td style="color:${ok ? '#2e7d32' : '#c62828'};font-weight:600">${ok ? 'PASS' : 'FAIL'}</td></tr>`;
    }).join('');
    html += `<div style="font-size:13px;margin:12px 0 4px"><strong>Voltage THD — before → after</strong></div>
      <table class="af-table" style="font-size:11px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Bus</th><th>THD before (%)</th><th>THD after (%)</th><th>Limit (%)</th><th>IEEE 519</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    body.innerHTML = html;
  },
};
