/* ProtectionPro — Contingency Analysis (N-1 / N-2) UI.
 *
 * Setup modal (N-2 toggle, voltage band, loading limit) → backend
 * /analysis/contingency → results modal with an N-1-secure verdict, a ranked
 * contingency table (worst-first) and expandable per-outage violation detail.
 *
 * Results are on-demand (not persisted with the project) — re-run after edits.
 */
const Contingency = {
  _result: null,
  _cfg: { include_n2: false, v_min: 0.95, v_max: 1.05, loading_limit_pct: 100 },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _statusStyle(status) {
    return {
      secure: { c: '#2e7d32', label: 'Secure' },
      violations: { c: '#b26a00', label: 'Violations' },
      islanded: { c: '#c62828', label: 'Loss of supply' },
      non_converged: { c: '#7b1fa2', label: 'No solution' },
    }[status] || { c: '#666', label: status };
  },

  // ── Setup ──────────────────────────────────────────────────────────
  openConfig() {
    const c = this._cfg;
    const branches = [...AppState.components.values()]
      .filter(x => ['cable', 'transformer', 'utility', 'generator', 'solar_pv', 'wind_turbine', 'battery'].includes(x.type)).length;
    const body = document.getElementById('contingency-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Removes each branch/source in turn (<strong>N-1</strong>) — optionally each
        pair (<strong>N-2</strong>) — re-solves the load flow, and flags thermal
        overloads, voltage-band excursions and loss of supply.
        <strong>${branches}</strong> outageable element(s) detected.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="cont-n2">Analysis depth</label>
        <select id="cont-n2">
          <option value="0"${c.include_n2 ? '' : ' selected'}>N-1 (single outages)</option>
          <option value="1"${c.include_n2 ? ' selected' : ''}>N-1 + N-2 (pairs — slower)</option>
        </select>
        <label for="cont-vmin">Min voltage (p.u.)</label>
        <input id="cont-vmin" type="number" min="0.5" max="1" step="0.01" value="${c.v_min}">
        <label for="cont-vmax">Max voltage (p.u.)</label>
        <input id="cont-vmax" type="number" min="1" max="1.5" step="0.01" value="${c.v_max}">
        <label for="cont-load">Loading limit (%)</label>
        <input id="cont-load" type="number" min="50" max="200" step="5" value="${c.loading_limit_pct}">
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:12px 0 0">
        N-2 pairs grow quadratically; the run is capped and any skipped pairs are
        reported. Losing the sole source of a radial network is correctly flagged
        as loss of supply.</p>`;
    document.getElementById('contingency-config-modal').style.display = '';
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._cfg = {
      include_n2: v('cont-n2').value === '1',
      v_min: parseFloat(v('cont-vmin').value) || 0.95,
      v_max: parseFloat(v('cont-vmax').value) || 1.05,
      loading_limit_pct: parseFloat(v('cont-load').value) || 100,
    };
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('contingency-config-modal').style.display = 'none';
    const label = c.include_n2 ? 'Running N-1 + N-2 contingency screening…' : 'Running N-1 contingency screening…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const result = await API.runContingency({
        includeN2: c.include_n2, vMin: c.v_min, vMax: c.v_max, loadingLimitPct: c.loading_limit_pct,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.n_minus_1_secure
        ? 'Contingency: N-1 secure.'
        : `Contingency: ${result.worst_case_label || 'violations found'}.`;
    } catch (e) {
      console.error('Contingency error:', e);
      document.getElementById('status-info').textContent = 'Contingency analysis failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Contingency Analysis — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('contingency-modal');
    const body = document.getElementById('contingency-body');
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

    // Verdict banner
    const secure = r.n_minus_1_secure;
    const col = secure ? '#2e7d32' : '#c62828';
    const verdict = secure ? 'N-1 SECURE' : 'N-1 INSECURE';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <div><span style="font-weight:700;color:${col}">${verdict}</span>
        <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${this._esc(r.mode || '')} screening · ${r.analyzed || 0} contingencies</span></div>
      ${r.worst_case_label ? `<div style="font-size:12px">Worst: <strong>${this._esc(r.worst_case_label)}</strong></div>` : ''}
    </div>`;

    if (r.base_violation_count > 0) {
      html += `<div style="margin-bottom:10px;padding:8px 11px;border:1px solid #b26a00;border-radius:6px;background:#fff3e0;font-size:12px;color:#6d4c00">
        ⚠ Base case already has <strong>${r.base_violation_count}</strong> violation(s) before any outage.</div>`;
    }
    if (r.skipped > 0) {
      html += `<div style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-bottom:8px">${r.skipped} N-2 pair(s) skipped (cap reached).</div>`;
    }

    const rows = (r.contingencies || []).map((c, i) => {
      const st = this._statusStyle(c.status);
      const detailId = `cont-det-${i}`;
      const hasDetail = (c.violations || []).length > 0;
      let detail = '';
      if (hasDetail) {
        detail = `<tr id="${detailId}" style="display:none"><td colspan="7" style="background:var(--bg-secondary,#f7f7fa);padding:6px 10px">
          <ul style="margin:4px 0;padding-left:18px;font-size:11px">${
            c.violations.map(v => `<li>${this._esc(v.detail)}</li>`).join('')}</ul></td></tr>`;
      }
      return `<tr${hasDetail ? ` data-toggle="${detailId}" style="cursor:pointer"` : ''}>
        <td>${c.order === 2 ? 'N-2' : 'N-1'}</td>
        <td>${this._esc(c.label)}${hasDetail ? ' <span style="color:var(--text-muted,#6d6d6d)">▸</span>' : ''}</td>
        <td><span style="color:${st.c};font-weight:600">${this._esc(st.label)}</span></td>
        <td style="text-align:right">${c.violation_count || ''}</td>
        <td style="text-align:right">${c.converged ? c.max_loading_pct.toFixed(0) + '%' : '—'}</td>
        <td style="text-align:right">${c.converged && c.min_v_pu ? c.min_v_pu.toFixed(3) : '—'}</td>
        <td style="text-align:right">${c.lost_load_mw ? c.lost_load_mw.toFixed(2) : ''}</td>
      </tr>${detail}`;
    }).join('');

    html += `<table class="af-table" style="font-size:12px;font-variant-numeric:tabular-nums">
      <thead><tr><th>Level</th><th>Contingency</th><th>Status</th><th style="text-align:right">Viol.</th>
        <th style="text-align:right">Max load</th><th style="text-align:right">Min V</th><th style="text-align:right">Lost MW</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No outageable elements found.</td></tr>'}</tbody></table>`;
    html += `<p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin-top:8px">
      Click a row with violations to expand its detail. Limits: V ${r.limits?.v_min ?? 0.95}–${r.limits?.v_max ?? 1.05} p.u., loading ${r.limits?.loading_limit_pct ?? 100}%.</p>`;

    body.innerHTML = html;
    body.querySelectorAll('tr[data-toggle]').forEach(tr => {
      tr.addEventListener('click', () => {
        const d = document.getElementById(tr.dataset.toggle);
        if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
      });
    });
  },
};
